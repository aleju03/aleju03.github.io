import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js'

/*
  The physical machine, for real this time: a WebGL night-desk scene and a
  CSS3D layer sharing one camera, so the live AlejOS DOM is mapped onto the
  monitor glass and stays fully interactive there. The glass mesh is drawn
  with a no-blending near-transparent material that punches a window through
  the WebGL canvas to the DOM behind it (the Henry Heffernan / ryOS-style
  trick). The camera pushes in on power-on, pulls back on shutdown, and while
  you use the OS nothing 3D renders at all: the loop is suspended and the
  screen is plain DOM. The desk lives in a small enclosed room: in roam mode
  you stand up from the chair and walk it first-person, WASD to move, mouse
  to look (pointer lock on click, drag works too), and an interact prompt at
  the machine sits you back down, booting it first if the tube is cold.

  Models are CC assets, see public/os/models/LICENSE.md (computer by Charlie
  CC BY 3.0, desk/mug/plant by Quaternius and Kenney CC0). If WebGL or the
  GLBs fail, onFail lets AlejOS fall back to the flat bezel mode.
*/

interface CrtSceneProps {
  /** true once the OS is shutting down: plays the camera pull-back */
  off: boolean
  /** standing up: the room is walkable first-person */
  roam: boolean
  /** roaming with the OS still running, so the tube stays lit and glowing */
  screenLive: boolean
  /** pressed the interact key at the machine: sit down (and boot if cold) */
  onInteract: () => void
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

export default function CrtScene({
  off,
  roam,
  screenLive,
  onInteract,
  onFail,
  children,
}: CrtSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [screenEl, setScreenEl] = useState<HTMLDivElement | null>(null)
  const [intro, setIntro] = useState(true)
  // walking = first-person controls are live (the stand-up glide is done),
  // near = close enough to the machine for the interact prompt
  const [walking, setWalking] = useState(false)
  const [near, setNear] = useState(false)
  const [locked, setLocked] = useState(false)
  const outroRef = useRef<(() => void) | null>(null)
  const roamRef = useRef<((on: boolean) => void) | null>(null)
  const failRef = useRef(onFail)
  const interactRef = useRef(onInteract)
  const liveRef = useRef(screenLive)
  useEffect(() => {
    failRef.current = onFail
    interactRef.current = onInteract
    liveRef.current = screenLive
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
        // gentle enough that the far corners of the room survive a walk-around
        scene.fog = new THREE.Fog('#0a0908', 9, 22)

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

        // the rest of the shell, so standing up reveals a room and not a void
        const ROOM = { minX: -6, maxX: 6, minZ: -1.75, maxZ: 7.5, h: 6 }
        const shell = (
          w: number,
          h: number,
          pos: [number, number, number],
          rot: [number, number],
          color: string,
        ) => {
          const m = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            new THREE.MeshStandardMaterial({ color, roughness: 1 }),
          )
          m.position.set(...pos)
          m.rotation.set(rot[0], rot[1], 0)
          m.receiveShadow = true
          scene?.add(m)
        }
        const depth = ROOM.maxZ - ROOM.minZ
        const midZ = (ROOM.minZ + ROOM.maxZ) / 2
        shell(depth, ROOM.h, [ROOM.minX, ROOM.h / 2, midZ], [0, Math.PI / 2], '#4a3d30')
        shell(depth, ROOM.h, [ROOM.maxX, ROOM.h / 2, midZ], [0, -Math.PI / 2], '#4a3d30')
        shell(ROOM.maxX - ROOM.minX, ROOM.h, [0, ROOM.h / 2, ROOM.maxZ], [0, Math.PI], '#50412f')
        shell(ROOM.maxX - ROOM.minX, depth, [0, ROOM.h, midZ], [Math.PI / 2, 0], '#3a3129')

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

        // seated, the desk spot is the whole show; walking needs the rest of
        // the room readable, so these two swell while roaming and ebb back
        const hemi = new THREE.HemisphereLight('#5a6678', '#241d16', 0.55)
        scene.add(hemi)
        const roomGlow = new THREE.PointLight('#8a7a64', 0, 0, 1.2)
        roomGlow.position.set(0, 5.6, 2.9)
        scene.add(roomGlow)
        const HEMI_SEATED = 0.55
        const HEMI_ROAM = 4.2
        const GLOW_ROAM = 18
        const roomLight = (k: number) => {
          hemi.intensity = HEMI_SEATED + (HEMI_ROAM - HEMI_SEATED) * k
          roomGlow.intensity = GLOW_ROAM * k
        }
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
        camera.rotation.order = 'YXZ' // yaw/pitch compose FPS-style while walking
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

        // --- roam: stand up from the desk and walk the room first-person ----
        // WASD moves, the mouse looks (pointer lock on click, drag works too),
        // and an interact prompt at the machine sits you back down
        let roaming = false
        let fps = false // controls live, i.e. the stand-up glide has finished
        let nearNow = false
        let isLocked = false
        let yaw = 0
        let pitch = 0
        let lastT = 0
        let bobT = 0
        const keys = new Set<string>()
        const vel = new THREE.Vector3()
        const want = new THREE.Vector3()
        const gaze = new THREE.Vector3()
        const toScreen = new THREE.Vector3()
        const EYE = deskTop + 2.0 // standing eye height over this desk's scale
        const SPAWN = new THREE.Vector3(1.3, EYE, 4.2)
        const SPEED = 3.4
        // walkable area sits inside the shell with some shoulder room; the
        // desk blocks a strip that runs all the way back to the wall
        const deskBlock = new THREE.Box3().setFromObject(desk.scene).expandByScalar(0.35)
        deskBlock.min.z = -10
        const collide = (p: THREE.Vector3) => {
          p.x = THREE.MathUtils.clamp(p.x, -5.5, 5.5)
          p.z = THREE.MathUtils.clamp(p.z, -0.8, 7.0)
          if (p.x > deskBlock.min.x && p.x < deskBlock.max.x && p.z < deskBlock.max.z) {
            const left = p.x - deskBlock.min.x
            const right = deskBlock.max.x - p.x
            const out = deskBlock.max.z - p.z
            if (left <= right && left <= out) p.x = deskBlock.min.x
            else if (right <= out) p.x = deskBlock.max.x
            else p.z = deskBlock.max.z
          }
        }

        const wakeTargets = [computer.scene, keyboard.scene, mouse.scene]
        const caster = new THREE.Raycaster()
        const ndc = new THREE.Vector2()
        const setCursor = (c: string) => {
          if (webgl) webgl.domElement.style.cursor = c
        }
        /** ray through the pointer, or through the crosshair when locked */
        const machineHit = (e?: PointerEvent) => {
          if (!webgl) return false
          if (e) {
            const r = webgl.domElement.getBoundingClientRect()
            ndc.set(
              ((e.clientX - r.left) / r.width) * 2 - 1,
              -((e.clientY - r.top) / r.height) * 2 + 1,
            )
          } else ndc.set(0, 0)
          caster.setFromCamera(ndc, camera)
          return caster.intersectObjects(wakeTargets, true).length > 0
        }

        const walkTick = (now: number) => {
          if (disposed || !roaming) return
          const dt = Math.min(0.05, (now - lastT) / 1000)
          lastT = now
          const fwd =
            (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
            (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
          const side =
            (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
            (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
          want.set(0, 0, 0)
          if (fwd || side) {
            want
              .set(
                -Math.sin(yaw) * fwd + Math.cos(yaw) * side,
                0,
                -Math.cos(yaw) * fwd - Math.sin(yaw) * side,
              )
              .normalize()
              .multiplyScalar(SPEED)
          }
          // ease the velocity so steps start and stop with a little weight
          vel.lerp(want, 1 - Math.exp(-10 * dt))
          camera.position.addScaledVector(vel, dt)
          collide(camera.position)
          // a faint footstep bob, scaled by how fast you actually move
          const planar = Math.hypot(vel.x, vel.z)
          bobT += planar * dt * 0.55
          camera.position.y = EYE + Math.sin(bobT * Math.PI * 2) * 0.028 * Math.min(1, planar / SPEED)
          camera.rotation.x = pitch
          camera.rotation.y = yaw
          camera.rotation.z = 0
          // close to the tube and facing it: offer the interact prompt
          toScreen.subVectors(gCenter, camera.position)
          const dist = toScreen.length()
          camera.getWorldDirection(gaze)
          const isNear = dist < 3.4 && gaze.dot(toScreen.normalize()) > 0.35
          if (isNear !== nearNow) {
            nearNow = isNear
            setNear(isNear)
          }
          render()
          raf = requestAnimationFrame(walkTick)
        }

        const startRoam = () => {
          if (!webgl || roaming) return
          roaming = true
          parked = false
          cancelAnimationFrame(raf)
          setIntro(false) // in case the intro flight was still going
          webgl.domElement.style.pointerEvents = 'auto'
          setCursor('grab')
          // with the OS still running the tube keeps spilling light
          spill.intensity = liveRef.current ? 1.0 : 0
          // push back from the desk and rise to standing height
          const s0 = performance.now()
          const from = camera.position.clone()
          const standTick = () => {
            if (disposed || !roaming) return
            const t = Math.min(1, (performance.now() - s0) / 1250)
            camera.position.lerpVectors(from, SPAWN, EASE(t))
            camera.lookAt(front)
            roomLight(EASE(t))
            render()
            if (t >= 1) {
              // hand the camera to the FPS controls, keeping the current gaze
              const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
              yaw = e.y
              pitch = e.x
              fps = true
              setWalking(true)
              lastT = performance.now()
              raf = requestAnimationFrame(walkTick)
              return
            }
            raf = requestAnimationFrame(standTick)
          }
          raf = requestAnimationFrame(standTick)
        }

        const stopRoam = () => {
          roaming = false
          fps = false
          keys.clear()
          vel.set(0, 0, 0)
          nearNow = false
          setWalking(false)
          setNear(false)
          if (document.pointerLockElement) document.exitPointerLock()
          if (webgl) {
            webgl.domElement.style.pointerEvents = 'none'
            setCursor('')
          }
        }

        // sit back down from wherever the walk left the camera; a live tube
        // skips the power-on flicker and just glides in
        const flyIn = (live: boolean) => {
          cancelAnimationFrame(raf)
          leaving = false
          const f0 = performance.now()
          const from = camera.position.clone()
          const lookFrom = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(3).add(from)
          const look = new THREE.Vector3()
          const delay = live ? 0.1 : 0.35
          const dur = live ? 1.4 : 1.9
          const flyTick = () => {
            if (disposed) return
            const t = (performance.now() - f0) / 1000
            // same flicker as the intro, in sync with the POST screen waking
            spill.intensity = live
              ? 1.0
              : t < 0.45
                ? 0
                : t < 0.85
                  ? Math.sin(t * 50) > -0.3
                    ? 0.9
                    : 0.2
                  : 1.0
            const zoom = Math.min(1, Math.max(0, (t - delay) / dur))
            camera.position.lerpVectors(from, camEnd, EASE(zoom))
            camera.lookAt(look.lerpVectors(lookFrom, front, EASE(zoom)))
            roomLight(1 - EASE(zoom))
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
            const live = liveRef.current
            stopRoam()
            flyIn(live)
          }
        }

        // mouse-look: pointer lock steers directly, an unlocked drag grabs
        // the world instead; a still click locks, or interacts on the machine
        const MOVE_KEYS = new Set([
          'KeyW',
          'KeyA',
          'KeyS',
          'KeyD',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
        ])
        const turn = (dx: number, dy: number, sign: number) => {
          yaw += sign * dx * 0.0023
          pitch = THREE.MathUtils.clamp(pitch + sign * dy * 0.0023, -1.35, 1.35)
        }
        const onKeyDown = (e: KeyboardEvent) => {
          if (!roaming || !fps) return
          if (MOVE_KEYS.has(e.code)) {
            keys.add(e.code)
            e.preventDefault()
          } else if (e.code === 'KeyE' && nearNow) {
            e.preventDefault()
            interactRef.current()
          }
        }
        const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)
        const onLockChange = () => {
          isLocked = document.pointerLockElement === webgl?.domElement
          setLocked(isLocked)
          setCursor(isLocked ? 'none' : 'grab')
        }
        let downPt: { moved: number } | null = null
        const onPtrDown = () => {
          if (!roaming || !fps) return
          downPt = { moved: 0 }
          if (!isLocked) setCursor('grabbing')
        }
        const onPtrMove = (e: PointerEvent) => {
          if (!roaming || !fps) return
          if (isLocked) {
            turn(e.movementX, e.movementY, -1)
          } else if (downPt) {
            turn(e.movementX, e.movementY, 1)
            downPt.moved += Math.hypot(e.movementX, e.movementY)
          } else {
            setCursor(machineHit(e) ? 'pointer' : 'grab')
          }
        }
        const onPtrUp = (e: PointerEvent) => {
          if (!roaming || !fps || !downPt) return
          const clicked = downPt.moved < 6
          downPt = null
          if (!isLocked) setCursor('grab')
          if (!clicked) return
          if (machineHit(isLocked ? undefined : e)) interactRef.current()
          else if (!isLocked) webgl?.domElement.requestPointerLock()
        }
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        document.addEventListener('pointerlockchange', onLockChange)
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
          window.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('keyup', onKeyUp)
          document.removeEventListener('pointerlockchange', onLockChange)
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
      {roam && walking && (
        <p className="pointer-events-none absolute right-5 bottom-4 z-10 font-mono text-[11px] text-stone-500">
          {locked
            ? 'wasd to move · esc to free the mouse'
            : 'wasd to move · click to look around · esc to leave'}
        </p>
      )}
      {roam && walking && locked && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 z-10 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-400/70"
        />
      )}
      {roam && walking && near && (
        <button
          type="button"
          onClick={() => onInteract()}
          className="absolute bottom-14 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[12px] text-stone-300 backdrop-blur-sm transition-colors hover:border-stone-500 hover:text-white"
        >
          <kbd className="mr-2 rounded border border-stone-600 bg-stone-800 px-1.5 py-0.5 text-[10px] text-stone-200">
            E
          </kbd>
          {screenLive ? 'sit back down' : 'power it on'}
        </button>
      )}
    </div>
  )
}
