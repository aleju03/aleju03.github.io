import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js'

/*
  The physical machine, for real this time: a WebGL night-desk scene and a
  CSS3D layer sharing one camera, so the live AlejOS DOM is mapped onto the
  monitor glass and stays fully interactive there. The glass mesh is drawn
  with a no-blending near-transparent material that punches a window through
  the WebGL canvas to the DOM behind it (the Henry Heffernan / ryOS-style
  trick). The camera pushes in on power-on, pulls back on shutdown, and while
  you use the OS nothing 3D renders at all: the loop is suspended and the
  screen is plain DOM. After a shutdown the room stays up in roam mode: an
  orbit around the desk, and a click on the machine boots it again.

  Models are CC assets, see public/os/models/LICENSE.md (computer by Charlie
  CC BY 3.0, desk/mug/plant by Quaternius and Kenney CC0). If WebGL or the
  GLBs fail, onFail lets AlejOS fall back to the flat bezel mode.
*/

interface CrtSceneProps {
  /** true once the OS is shutting down: plays the camera pull-back */
  off: boolean
  /** the machine is off and the room is free to orbit */
  roam: boolean
  /** the machine was clicked while roaming: power it back on */
  onWake: () => void
  onFail: () => void
  children: ReactNode
}

const EASE = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const MODELS = [
  '/os/models/computer.glb',
  '/os/models/desk.glb',
  '/os/models/mug.glb',
  '/os/models/plant.glb',
  '/os/models/keyboard.glb',
  '/os/models/mouse.glb',
]
/** fraction of the viewport height the glass fills once parked */
const FILL = 0.86
const INTRO_S = 2.6

export default function CrtScene({ off, roam, onWake, onFail, children }: CrtSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [screenEl, setScreenEl] = useState<HTMLDivElement | null>(null)
  const [intro, setIntro] = useState(true)
  const outroRef = useRef<(() => void) | null>(null)
  const roamRef = useRef<((on: boolean) => void) | null>(null)
  const failRef = useRef(onFail)
  const wakeRef = useRef(onWake)
  useEffect(() => {
    failRef.current = onFail
    wakeRef.current = onWake
  })

  useEffect(() => {
    if (off) outroRef.current?.()
  }, [off])

  useEffect(() => {
    roamRef.current?.(roam)
  }, [roam])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false
    let raf = 0
    let webgl: THREE.WebGLRenderer | null = null
    let scene: THREE.Scene | null = null
    let cleanupDom: (() => void) | null = null

    const bail = setTimeout(() => {
      if (!webgl) failRef.current()
    }, 6000)

    const loader = new GLTFLoader()
    const load = (url: string) =>
      new Promise<{ scene: THREE.Group }>((resolve, reject) =>
        loader.load(url, resolve, undefined, reject),
      )

    Promise.all(MODELS.map(load))
      .then(([computer, desk, mug, plant, keyboard, mouse]) => {
        clearTimeout(bail)
        if (disposed) return

        const W = mount.clientWidth
        const H = mount.clientHeight
        webgl = new THREE.WebGLRenderer({ antialias: true, alpha: true })
        webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        webgl.setSize(W, H)
        webgl.shadowMap.enabled = true
        // VSM + blur: plain PCF stair-steps badly on the wall this close up
        webgl.shadowMap.type = THREE.VSMShadowMap
        webgl.toneMapping = THREE.ACESFilmicToneMapping
        webgl.toneMappingExposure = 1.1
        webgl.domElement.style.position = 'absolute'
        webgl.domElement.style.inset = '0'
        webgl.domElement.style.pointerEvents = 'none'

        const css3d = new CSS3DRenderer()
        css3d.setSize(W, H)
        css3d.domElement.style.position = 'absolute'
        css3d.domElement.style.inset = '0'
        css3d.domElement.style.pointerEvents = 'none'

        // DOM order: CSS3D below, WebGL canvas above with a hole in the glass
        mount.appendChild(css3d.domElement)
        mount.appendChild(webgl.domElement)
        cleanupDom = () => {
          if (css3d.domElement.parentElement === mount) mount.removeChild(css3d.domElement)
          if (webgl && webgl.domElement.parentElement === mount) mount.removeChild(webgl.domElement)
        }

        scene = new THREE.Scene()
        scene.background = new THREE.Color('#0a0908')
        scene.fog = new THREE.Fog('#0a0908', 8, 16)

        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(30, 30),
          new THREE.MeshStandardMaterial({ color: '#2a2018', roughness: 0.95 }),
        )
        floor.rotation.x = -Math.PI / 2
        floor.receiveShadow = true
        scene.add(floor)
        const wall = new THREE.Mesh(
          new THREE.PlaneGeometry(30, 12),
          new THREE.MeshStandardMaterial({ color: '#3d3328', roughness: 1 }),
        )
        wall.position.set(0, 6, -1.75)
        wall.receiveShadow = true
        scene.add(wall)

        desk.scene.scale.setScalar(2.0)
        desk.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true
            o.receiveShadow = true
          }
        })
        scene.add(desk.scene)
        const deskTop = new THREE.Box3().setFromObject(desk.scene).max.y

        computer.scene.scale.setScalar(16)
        computer.scene.position.set(0, deskTop, 0.05)
        let screenText: THREE.Mesh | null = null
        let screenGlass: THREE.Mesh | null = null
        let oldKeyboard: THREE.Mesh | null = null
        let oldMouse: THREE.Mesh | null = null
        computer.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.castShadow = true
          // cast only: receiving its own VSM shadow paints wavy acne over
          // the curved bezel, and nothing meaningful shadows the machine
          mesh.receiveShadow = false
          if (mesh.name === 'screen_text') screenText = mesh
          if (mesh.name === 'monitor_2') screenGlass = mesh
          if (mesh.name === 'keyboard') oldKeyboard = mesh
          if (mesh.name === 'mouse') oldMouse = mesh
        })
        scene.add(computer.scene)
        computer.scene.updateMatrixWorld(true)
        if (screenText) (screenText as THREE.Mesh).visible = false
        if (!screenGlass) throw new Error('screen mesh missing')
        const glass: THREE.Mesh = screenGlass

        // the keyboard and mouse baked into the computer model are featureless
        // slabs; swap each for a proper standalone model on the same footprint
        const swapIn = (group: THREE.Group, old: THREE.Mesh | null, rotY: number, grow: number) => {
          if (!old || !scene) return
          const oldBox = new THREE.Box3().setFromObject(old)
          const oldSize = oldBox.getSize(new THREE.Vector3())
          old.visible = false
          const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3())
          group.scale.setScalar(
            (grow * Math.max(oldSize.x, oldSize.z)) / Math.max(size.x, size.z),
          )
          group.rotation.y = rotY
          group.updateMatrixWorld(true)
          const box = new THREE.Box3().setFromObject(group)
          const c = oldBox.getCenter(new THREE.Vector3())
          const nc = box.getCenter(new THREE.Vector3())
          group.position.set(c.x - nc.x, deskTop - box.min.y, c.z - nc.z)
          group.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) o.castShadow = true
          })
          scene.add(group)
        }
        swapIn(keyboard.scene, oldKeyboard, 0, 1.0)
        // The standalone mouse's button end is +Z; on the desk it should face
        // the monitor, which sits behind the keyboard on -Z.
        swapIn(mouse.scene, oldMouse, Math.PI, 1.0)

        // the punch-through: NoBlending writes a near-zero alpha straight into
        // the canvas, opening a tinted window onto the CSS3D layer behind
        glass.material = new THREE.MeshBasicMaterial({
          color: 0x000000,
          opacity: 0.07,
          blending: THREE.NoBlending,
          side: THREE.DoubleSide,
        })
        glass.castShadow = false

        // glass front center + facing direction, measured off the actual mesh
        // (the tube face is tilted slightly upward on its stand)
        const gBox = new THREE.Box3().setFromObject(glass)
        const gCenter = gBox.getCenter(new THREE.Vector3())
        const gSize = gBox.getSize(new THREE.Vector3())
        const ray = new THREE.Raycaster(
          gCenter.clone().add(new THREE.Vector3(0, 0, 2)),
          new THREE.Vector3(0, 0, -1),
        )
        const hit = ray.intersectObject(glass, false)[0]
        const normal = hit?.face
          ? hit.face.normal.clone().transformDirection(glass.matrixWorld).normalize()
          : new THREE.Vector3(0, 0, 1)
        const front = hit ? hit.point.clone() : gCenter.clone()

        // the screen DOM, sized so a parked camera shows it at ~1:1 device px
        const divH = Math.round(H * FILL)
        const divW = Math.round((divH * gSize.x) / gSize.y)
        const el = document.createElement('div')
        el.style.width = `${divW}px`
        el.style.height = `${divH}px`
        el.style.pointerEvents = 'auto'
        el.style.overflow = 'hidden'
        el.style.borderRadius = '10px'
        el.style.backgroundColor = '#0c0a09'
        const cssScene = new THREE.Scene()
        const cssObj = new CSS3DObject(el)
        cssObj.scale.setScalar(gSize.y / divH)
        cssObj.position.copy(front).add(normal.clone().multiplyScalar(0.002))
        cssObj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
        cssScene.add(cssObj)
        setScreenEl(el)

        mug.scene.scale.setScalar(0.85)
        mug.scene.position.set(-1.25, deskTop, 0.45)
        mug.scene.rotation.y = 2.4
        mug.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = true
        })
        scene.add(mug.scene)
        plant.scene.scale.setScalar(0.5)
        plant.scene.position.set(1.05, deskTop, 0.62)
        plant.scene.rotation.y = -0.6
        plant.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = true
        })
        scene.add(plant.scene)

        scene.add(new THREE.HemisphereLight('#5a6678', '#241d16', 0.55))
        const key = new THREE.SpotLight('#ffd9a0', 60, 0, 0.55, 0.6, 1.6)
        key.position.set(-3.2, 5.2, 2.8)
        key.target.position.set(0.3, deskTop, 0)
        key.castShadow = true
        key.shadow.mapSize.set(2048, 2048)
        key.shadow.bias = -0.0001
        key.shadow.radius = 8
        key.shadow.blurSamples = 16
        key.shadow.camera.near = 2
        scene.add(key, key.target)
        const rim = new THREE.DirectionalLight('#7e8ea8', 0.5)
        rim.position.set(2.5, 3, -2)
        scene.add(rim)
        // the tube's own spill onto keyboard and desk once it is awake
        const spill = new THREE.PointLight('#9db4e8', 0, 2.0, 1.8)
        spill.position.copy(front).add(new THREE.Vector3(0, -0.12, 0.75))
        scene.add(spill)

        const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 40)
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(38 / 2))
        const camStart = new THREE.Vector3(2.4, 2.9, 4.5)
        const camEndFor = (h: number) =>
          front.clone().add(normal.clone().multiplyScalar((gSize.y * h) / (divH * 2 * tanHalf)))
        let camEnd = camEndFor(H)

        const render = () => {
          if (!webgl || !scene) return
          webgl.render(scene, camera)
          css3d.render(cssScene, camera)
        }

        // intro: drift, then push into the glass; afterwards the loop stops
        let parked = false
        let leaving = false
        const t0 = performance.now()
        const drifted = new THREE.Vector3()
        const introTick = () => {
          if (disposed) return
          const t = (performance.now() - t0) / 1000
          // tube wakes ~in sync with the BIOS flicker on the DOM screen
          spill.intensity = t < 0.45 ? 0 : t < 0.85 ? (Math.sin(t * 50) > -0.3 ? 0.9 : 0.2) : 1.0
          const zoom = Math.min(1, Math.max(0, (t - 0.9) / (INTRO_S - 0.9)))
          drifted.copy(camStart)
          drifted.x += Math.sin(t * 0.7) * 0.05
          drifted.y += Math.sin(t * 0.5) * 0.03
          camera.position.lerpVectors(drifted, camEnd, EASE(zoom))
          camera.lookAt(front)
          render()
          if (zoom >= 1) {
            parked = true
            setIntro(false)
            return // parked: stop rendering, the screen is live DOM now
          }
          raf = requestAnimationFrame(introTick)
        }
        raf = requestAnimationFrame(introTick)

        outroRef.current = () => {
          leaving = true
          cancelAnimationFrame(raf)
          const o0 = performance.now()
          const from = camera.position.clone()
          const outroTick = () => {
            if (disposed) return
            const t = (performance.now() - o0) / 1000
            // hold on the dark glass briefly, then retreat into the room
            const back = Math.min(1, Math.max(0, (t - 0.8) / 1.3))
            spill.intensity = Math.max(0, 1 - back * 2)
            camera.position.lerpVectors(from, camStart, EASE(back))
            camera.lookAt(front)
            render()
            if (back < 1) raf = requestAnimationFrame(outroTick)
          }
          raf = requestAnimationFrame(outroTick)
        }

        // --- roam: with the machine off, the room itself is the scene -------
        // orbit around the desk; clicking the computer (or its keyboard or
        // mouse) powers it back on and the camera flies back into the glass
        let controls: OrbitControls | null = null
        let roaming = false
        const roamTarget = new THREE.Vector3(0, deskTop + 0.35, 0)
        const wakeTargets = [computer.scene, keyboard.scene, mouse.scene]
        const caster = new THREE.Raycaster()
        const ndc = new THREE.Vector2()
        const setCursor = (c: string) => {
          if (webgl) webgl.domElement.style.cursor = c
        }
        const machineHit = (e: PointerEvent) => {
          if (!webgl) return false
          const r = webgl.domElement.getBoundingClientRect()
          ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
          caster.setFromCamera(ndc, camera)
          return caster.intersectObjects(wakeTargets, true).length > 0
        }

        const startRoam = () => {
          if (!webgl || roaming) return
          roaming = true
          parked = false
          cancelAnimationFrame(raf)
          webgl.domElement.style.pointerEvents = 'auto'
          setCursor('grab')
          controls = new OrbitControls(camera, webgl.domElement)
          controls.target.copy(roamTarget)
          controls.enableDamping = true
          controls.dampingFactor = 0.08
          controls.enablePan = false
          controls.minDistance = 1.6
          controls.maxDistance = 7.5
          controls.minPolarAngle = 0.2
          controls.maxPolarAngle = Math.PI / 2 - 0.06
          // the wall and floor are one-sided planes: keep the orbit in front
          controls.minAzimuthAngle = -1.2
          controls.maxAzimuthAngle = 1.2
          const roamTick = () => {
            if (disposed || !roaming) return
            controls?.update()
            render()
            raf = requestAnimationFrame(roamTick)
          }
          raf = requestAnimationFrame(roamTick)
        }

        const stopRoam = () => {
          roaming = false
          controls?.dispose()
          controls = null
          if (webgl) {
            webgl.domElement.style.pointerEvents = 'none'
            setCursor('')
          }
        }

        // power back on from wherever the orbit left the camera
        const flyIn = () => {
          cancelAnimationFrame(raf)
          leaving = false
          const f0 = performance.now()
          const from = camera.position.clone()
          const look = new THREE.Vector3()
          const flyTick = () => {
            if (disposed) return
            const t = (performance.now() - f0) / 1000
            // same flicker as the intro, in sync with the POST screen waking
            spill.intensity = t < 0.45 ? 0 : t < 0.85 ? (Math.sin(t * 50) > -0.3 ? 0.9 : 0.2) : 1.0
            const zoom = Math.min(1, Math.max(0, (t - 0.35) / 1.9))
            camera.position.lerpVectors(from, camEnd, EASE(zoom))
            camera.lookAt(look.lerpVectors(roamTarget, front, EASE(zoom)))
            render()
            if (zoom >= 1) {
              parked = true
              return // parked again: the screen is live DOM from here
            }
            raf = requestAnimationFrame(flyTick)
          }
          raf = requestAnimationFrame(flyTick)
        }

        roamRef.current = (on) => {
          if (on) startRoam()
          else if (roaming) {
            stopRoam()
            flyIn()
          }
        }

        // a still click on the machine wakes it; a drag is just the orbit
        let downPt: { x: number; y: number } | null = null
        const onPtrDown = (e: PointerEvent) => {
          if (!roaming) return
          downPt = { x: e.clientX, y: e.clientY }
          setCursor('grabbing')
        }
        const onPtrMove = (e: PointerEvent) => {
          if (!roaming || downPt) return
          setCursor(machineHit(e) ? 'pointer' : 'grab')
        }
        const onPtrUp = (e: PointerEvent) => {
          if (!roaming || !downPt) return
          const moved = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y)
          downPt = null
          setCursor('grab')
          if (moved < 6 && machineHit(e)) wakeRef.current()
        }
        webgl.domElement.addEventListener('pointerdown', onPtrDown)
        webgl.domElement.addEventListener('pointermove', onPtrMove)
        webgl.domElement.addEventListener('pointerup', onPtrUp)

        const onResize = () => {
          if (!webgl) return
          const w = mount.clientWidth
          const h = mount.clientHeight
          webgl.setSize(w, h)
          css3d.setSize(w, h)
          camera.aspect = w / h
          camera.updateProjectionMatrix()
          camEnd = camEndFor(h)
          if (parked && !leaving) {
            camera.position.copy(camEnd)
            camera.lookAt(front)
          }
          render()
        }
        window.addEventListener('resize', onResize)
        const removeResize = () => window.removeEventListener('resize', onResize)
        const prevCleanup = cleanupDom
        cleanupDom = () => {
          removeResize()
          stopRoam()
          webgl?.domElement.removeEventListener('pointerdown', onPtrDown)
          webgl?.domElement.removeEventListener('pointermove', onPtrMove)
          webgl?.domElement.removeEventListener('pointerup', onPtrUp)
          prevCleanup?.()
        }
      })
      .catch(() => {
        clearTimeout(bail)
        if (!disposed) failRef.current()
      })

    return () => {
      disposed = true
      clearTimeout(bail)
      cancelAnimationFrame(raf)
      outroRef.current = null
      roamRef.current = null
      if (scene) {
        scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.geometry.dispose()
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          mats.forEach((m) => m.dispose())
        })
      }
      webgl?.dispose()
      cleanupDom?.()
      setScreenEl(null)
    }
  }, [])

  return (
    <div ref={mountRef} className="absolute inset-0 overflow-hidden">
      {screenEl && createPortal(<>{children}</>, screenEl)}
      {/* photo-style falloff over the room */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.45))',
        }}
      />
      {intro && (
        <p className="pointer-events-none absolute right-5 bottom-4 font-mono text-[11px] text-stone-600">
          esc to skip
        </p>
      )}
      {roam && (
        <p className="pointer-events-none absolute right-5 bottom-4 z-10 font-mono text-[11px] text-stone-500">
          drag to look around · click the machine to power it on · esc to leave
        </p>
      )}
    </div>
  )
}
