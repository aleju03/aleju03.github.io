import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js'
import { buildHouse, CEIL_H, HOUSE } from '../../game/levels/houseWorld'
import { buildOutsideWorld } from '../../game/levels/outsideWorld'
import { buildBackrooms } from '../../game/levels/backrooms'
import { buildDeskRoom } from '../../game/levels/deskRoom'
import { makeHomeLevels } from '../../game/levels/homeLevels'
import { createLevelSystem } from '../../game/levels/levelSystem'
import type { LevelLightRig } from '../../game/levels/types'
import { buildPaperPlane } from '../../game/props/paperPlane'
import type { HouseModels } from '../../game/levels/houseWorld'
import { buildPlayerBody } from '../../game/player/playerBody'
import { createWalkController } from '../../game/player/walkController'
import { createRoamInput } from '../../game/core/input'
import { createDisposer } from '../../game/core/disposer'
import { OS_SCENE_READY_EVENT } from '../../events'

/*
  The physical machine, for real this time: a WebGL night-desk scene and a
  CSS3D layer sharing one camera, so the live AlejOS DOM is mapped onto the
  monitor glass and stays fully interactive there. The glass mesh is drawn
  with a no-blending near-transparent material that punches a window through
  the WebGL canvas to the DOM behind it (the Henry Heffernan / ryOS-style
  trick). The camera pushes in on power-on, pulls back on shutdown, and while
  you use the OS nothing 3D renders at all: the loop is suspended and the
  screen is plain DOM.

  This component is the presentation shell over the game runtime in
  src/game/: it owns the renderer, the screen glass, the camera cinematics
  (intro flight, outro, stand-up, sit-down), the desk-room light rig and
  the HUD. The simulation is delegated — input events to game/core/input,
  FPS movement and collision to game/player/walkController +
  game/physics/collision, and which world is live (house/yard vs the
  backrooms, including the noclip cut between them) to game/levels. The
  walkTick below is just the per-frame conductor calling each in order.

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
  /** this boot came from the wreck swallowing the hero's paper plane, so
      the dart lies landed on the bedroom rug */
  paperPlane?: boolean
  /** pressed the interact key at the machine: sit down (and boot if cold) */
  onInteract: () => void
  /** the pause menu's way out of the room entirely (what esc used to do) */
  onLeave?: () => void
  onFail: () => void
  children: ReactNode
}

const EASE = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const MODELS = [
  '/os/models/computer.glb',
  '/os/models/desk.glb',
  '/os/models/mug.glb',
  '/os/models/plant.glb',
  '/os/models/mouse.glb',
  '/os/models/lamp.glb',
]
// the rest of the house streams in behind the intro; the walls never wait
const HOUSE_MODEL_KEYS = [
  'bed', 'nightstand', 'dresser', 'closet', 'curtains', 'alarmclock',
  'officechair', 'bathtub', 'toilet', 'bathsink', 'towelrack',
  'toiletpaper', 'rug', 'tvcabinet', 'tv', 'sofa', 'loveseat', 'coffeetable',
  'roundrug', 'bookcase', 'floorlamp', 'diningtable', 'chair', 'kfridge',
  'kstove', 'ksink', 'kdrawer', 'kupper', 'kupperl', 'toaster', 'washer',
  'microwave', 'ceilinglight', 'fence', 'tree', 'bush', 'bushflower',
  'hedge', 'bench', 'lantern',
] as const
/** walk-mode preferences the pause menu edits; the seated view stays fixed */
const PREFS_KEY = 'alejos-roam-prefs'
const PREFS_DEFAULT = { fov: 60, sens: 1 }
const loadPrefs = () => {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { fov?: number; sens?: number }
      return {
        fov: Math.min(80, Math.max(30, Number(p.fov) || PREFS_DEFAULT.fov)),
        sens: Math.min(3, Math.max(0.3, Number(p.sens) || PREFS_DEFAULT.sens)),
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...PREFS_DEFAULT }
}
/** fraction of the viewport height the glass fills once parked */
const FILL = 0.86
const INTRO_S = 2.6
const WINDOW_CENTER_Y = 3.3
const WINDOW_CENTER_Z = 5.75

const makeMoonSpillTexture = () => {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.filter = 'blur(14px)'
    const wash = ctx.createRadialGradient(102, 58, 8, 108, 58, 112)
    wash.addColorStop(0, 'rgba(130,180,255,0.52)')
    wash.addColorStop(0.34, 'rgba(100,155,235,0.24)')
    wash.addColorStop(1, 'rgba(100,155,235,0)')
    ctx.fillStyle = wash
    ctx.fillRect(-24, -18, 300, 170)
    ctx.globalCompositeOperation = 'screen'
    ctx.fillStyle = 'rgba(150,198,255,0.18)'
    ctx.beginPath()
    ctx.moveTo(18, 34)
    ctx.lineTo(210, 8)
    ctx.lineTo(244, 30)
    ctx.lineTo(48, 76)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(4, 94)
    ctx.lineTo(192, 44)
    ctx.lineTo(236, 66)
    ctx.lineTo(42, 126)
    ctx.closePath()
    ctx.fill()
    ctx.filter = 'none'
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

export default function CrtScene({
  off,
  roam,
  screenLive,
  paperPlane,
  onInteract,
  onLeave,
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
  // a house door in reach while walking; which verb its prompt should show
  const [doorVerb, setDoorVerb] = useState<'open' | 'close' | null>(null)
  const [locked, setLocked] = useState(false)
  // esc mid-walk frees the mouse and raises the pause menu
  const [paused, setPaused] = useState(false)
  const [prefs, setPrefs] = useState(loadPrefs)
  const outroRef = useRef<(() => void) | null>(null)
  const roamRef = useRef<((on: boolean) => void) | null>(null)
  const doorRef = useRef<(() => void) | null>(null)
  const resumeRef = useRef<(() => void) | null>(null)
  const failRef = useRef(onFail)
  const interactRef = useRef(onInteract)
  const liveRef = useRef(screenLive)
  const prefsRef = useRef(prefs)
  const paperPlaneRef = useRef(paperPlane)
  useEffect(() => {
    failRef.current = onFail
    interactRef.current = onInteract
    liveRef.current = screenLive
    prefsRef.current = prefs
    paperPlaneRef.current = paperPlane
  })
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* private mode; the session still gets the values via prefsRef */
    }
  }, [prefs])

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
    const disposer = createDisposer()

    const bail = setTimeout(() => {
      if (!webgl) failRef.current()
    }, 6000)

    const loader = new GLTFLoader()
    const load = (url: string) =>
      new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) =>
        loader.load(url, resolve, undefined, reject),
      )

    Promise.all(MODELS.map(load))
      .then(([computer, desk, mug, plant, mouse, lamp]) => {
        clearTimeout(bail)
        if (disposed) return

        const W = mount.clientWidth
        const H = mount.clientHeight
        webgl = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance',
        })
        const PR_CAP = Math.min(window.devicePixelRatio, 2)
        webgl.setPixelRatio(PR_CAP)
        webgl.setSize(W, H)
        webgl.shadowMap.enabled = true
        // PCFSoft is less prone to the blotchy VSM halos that show up around
        // thin desk legs and chair casters on the dark floor.
        webgl.shadowMap.type = THREE.PCFSoftShadowMap
        // the scene is static except the player body, so every light's map is
        // baked once (light.shadow.autoUpdate = false) and re-rendered only
        // for the light near the player on frames where a caster moved
        webgl.shadowMap.autoUpdate = true
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
        // dead-black card over everything, for the backrooms noclip cut
        const blackout = document.createElement('div')
        blackout.style.cssText =
          'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none'
        mount.appendChild(blackout)
        cleanupDom = () => {
          if (blackout.parentElement === mount) mount.removeChild(blackout)
          if (css3d.domElement.parentElement === mount) mount.removeChild(css3d.domElement)
          if (webgl && webgl.domElement.parentElement === mount) mount.removeChild(webgl.domElement)
        }

        scene = new THREE.Scene()
        scene.background = new THREE.Color('#0a0908')
        // gentle: deep enough to swallow the yard's far corners at night
        // without murdering the living room seen from the bedroom door
        scene.fog = new THREE.Fog('#0a0908', 14, 75)

        // high-level mode flags, shared by the cinematics and the walk loop
        let roaming = false
        let fps = false // controls live, i.e. the stand-up glide has finished
        let parked = false
        let leaving = false

        // the pendant lamp the room light actually comes from; its bulb
        // material glows once the roam fill ramps in
        lamp.scene.scale.setScalar(1.6)
        lamp.scene.position.set(0, CEIL_H, 4.4)
        let bulbMat: THREE.MeshStandardMaterial | null = null
        lamp.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats) {
            const std = m as THREE.MeshStandardMaterial
            if (std.name === 'Light') {
              std.emissive = new THREE.Color('#ffe0b0')
              std.emissiveIntensity = 0
              bulbMat = std
            }
          }
        })
        scene.add(lamp.scene)

        // solids that should block the first-person walk register an AABB
        // here; the overworld level claims this list as its collision set
        const obstacles: THREE.Box3[] = []

        // the desk and everything dressed around it (rug, shelf, cork board,
        // code-built keyboard); also the shared materials the house reuses.
        // Its solids go in a side list appended after the walls: resolveXZ
        // is a single sequential pass where the last overlapping box wins,
        // and the desk strip overlaps the bedroom wall boxes
        const deskObstacles: THREE.Box3[] = []
        const deskRoom = buildDeskRoom({ scene, obstacles: deskObstacles, desk, mug, plant })
        const { deskTop, darkWoodMat, windowGlassMat } = deskRoom

        // the whole house around this room — walls, doors, windows, yard,
        // sky — is procedural and stands immediately; furniture streams in
        const house = buildHouse({
          scene,
          obstacles,
          darkWoodMat,
          windowGlassMat,
          lamp,
          trackTexture: disposer.texture,
          trackDisposable: disposer.add,
        })
        // ...and past the fence: sky, sun and moon on the day cycle, the
        // street, the neighbors, the city rings. update() runs per rendered
        // frame and hands back the fog/hemisphere targets for right now.
        const outside = buildOutsideWorld({
          scene,
          obstacles,
          trackTexture: disposer.texture,
          trackDisposable: disposer.add,
        })
        // ...and the easter egg far beneath both: level 0 waits behind a
        // doctored span of the living room's east wall (houseWorld cuts the
        // hole; backrooms.ts owns the level, the hum and the way back)
        const backrooms = buildBackrooms({
          scene,
          trackTexture: disposer.texture,
          trackDisposable: disposer.add,
        })
        obstacles.push(...deskObstacles)

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

        // the keyboard and mouse baked into the computer model are
        // featureless slabs; the desk room seats proper ones in their place
        deskRoom.swapPeripherals(oldKeyboard, oldMouse, mouse)

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
        cssScene.updateMatrixWorld(true)
        cssObj.matrixAutoUpdate = false // the glass never moves, only the camera
        setScreenEl(el)

        // if this boot was the wreck swallowing the hero's paper plane, the
        // dart made the trip too: it lies landed on the rug behind the
        // chair, nose pointed into the room like it glided out of the screen
        if (paperPlaneRef.current) {
          const dart = buildPaperPlane()
          dart.position.set(1.6, 0.02, 4.2)
          dart.rotation.y = -1.05
          scene.add(dart)
        }

        const moonSpillTexture = disposer.texture(makeMoonSpillTexture())
        const moonSpillMat = new THREE.MeshBasicMaterial({
          map: moonSpillTexture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          fog: false,
        })
        // scooted east so the bed along that wall doesn't swallow the patch
        const moonPool = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.05), moonSpillMat)
        moonPool.rotation.x = -Math.PI / 2
        moonPool.rotation.z = -0.13
        moonPool.position.set(-3.6, 0.028, WINDOW_CENTER_Z + 0.1)
        moonPool.renderOrder = 12
        moonPool.frustumCulled = false
        scene.add(moonPool)
        const windowSpill = new THREE.SpotLight('#9dbfff', 0, 8, 0.6, 0.78, 1.6)
        windowSpill.position.set(HOUSE.minX + 0.06, WINDOW_CENTER_Y + 0.08, WINDOW_CENTER_Z + 0.05)
        windowSpill.target.position.set(HOUSE.minX + 4.6, 0.55, WINDOW_CENTER_Z - 0.22)
        scene.add(windowSpill, windowSpill.target)

        // seated, the desk spot is the whole show; walking wakes a real light
        // rig instead of the old flat hemisphere flood: a shadow-casting
        // pendant downlight pools on the floor, a small omni at the bulb
        // catches the ceiling, cool moonlight leans in from the window wall,
        // and just enough ambient keeps the corners legible
        const hemi = new THREE.HemisphereLight('#5a6678', '#241d16', 0.55)
        scene.add(hemi)
        const roomGlow = new THREE.PointLight('#8a7a64', 0, 0, 1.2)
        // parked just under the pendant's bulb so the light has a source
        roomGlow.position.set(0, 4.75, 4.4)
        scene.add(roomGlow)
        const pendant = new THREE.SpotLight('#ffd9ae', 0, 0, 1.05, 0.85, 1.5)
        pendant.position.set(0, 5.45, 4.4)
        pendant.target.position.set(0, 0, 4.4)
        pendant.castShadow = true
        pendant.shadow.mapSize.set(1024, 1024)
        pendant.shadow.bias = -0.00005
        pendant.shadow.normalBias = 0.025
        pendant.shadow.radius = 2
        pendant.shadow.blurSamples = 4
        pendant.shadow.camera.near = 0.5
        pendant.shadow.autoUpdate = false // baked; re-flagged only when dirty
        scene.add(pendant, pendant.target)
        const moon = new THREE.DirectionalLight('#8fa6d4', 0)
        moon.position.set(HOUSE.minX - 4, 4.6, 5.5)
        moon.target.position.set(0, 0.6, 4.5)
        scene.add(moon, moon.target)
        const HEMI_SEATED = 0.55
        const HEMI_ROAM = 1.5
        const GLOW_ROAM = 7
        const PEND_ROAM = 75
        const MOON_ROAM = 0.8
        const WINDOW_SPILL_ROAM = 8
        // the roam ramp is one input to the lighting now; the day cycle is
        // the other. roomLight() stores the ramp and applyLight() composes
        // both every rendered frame (render() calls it), so the sky, fog and
        // fills all track the clock even mid-stand-up or mid-walk.
        let roamK = 0
        const roomLight = (k: number) => {
          roamK = k
        }
        const key = new THREE.SpotLight('#ffd9a0', 60, 0, 0.55, 0.6, 1.6)
        key.position.set(-3.2, 5.2, 2.8)
        key.target.position.set(0.3, deskTop, 0)
        key.castShadow = true
        key.shadow.mapSize.set(2048, 2048)
        key.shadow.bias = -0.00005
        key.shadow.normalBias = 0.025
        key.shadow.radius = 2
        key.shadow.blurSamples = 4
        key.shadow.camera.near = 2
        key.shadow.autoUpdate = false
        scene.add(key, key.target)
        // every shadow map is hand-baked, and the bake is paid in
        // installments: flag one light per frame, each consumed by its own
        // render, so no single frame carries every map — the all-at-once
        // bake was the warp ride's one visible hitch, worst on cold iGPUs
        // where the shadow-depth programs also link inside that frame
        const bakeShadowsStaggered = async (bailOut: () => boolean) => {
          const lights = [pendant, key, ...house.shadowLights]
          for (let i = 0; i < lights.length; i += 1) {
            if (bailOut()) {
              // interrupted: flag the rest in one go — whoever took over
              // (walk, outro) renders every frame and pays it on the next
              for (; i < lights.length; i += 1) lights[i].shadow.needsUpdate = true
              return
            }
            lights[i].shadow.needsUpdate = true
            if (!roaming) render() // the walk loop already renders per frame
            await new Promise((r) => requestAnimationFrame(r))
          }
        }
        const rim = new THREE.DirectionalLight('#7e8ea8', 0.5)
        rim.position.set(2.5, 3, -2)
        scene.add(rim)
        // the tube's own spill onto keyboard and desk once it is awake
        const spill = new THREE.PointLight('#9db4e8', 0, 2.0, 1.8)
        spill.position.copy(front).add(new THREE.Vector3(0, -0.12, 0.75))
        scene.add(spill)

        // everything placed so far is furniture: bake world matrices once and
        // stop re-walking the whole static graph every frame (the player body
        // joins the scene later and keeps its auto-update; the house flags
        // its door pivots dynamic so they keep easing open)
        scene.updateMatrixWorld(true)
        scene.traverse((o) => {
          if (!o.userData.dynamic) o.matrixAutoUpdate = false
        })

        // far plane reaches the star dome and the skyline ring now
        const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 400)
        camera.rotation.order = 'YXZ' // yaw/pitch compose FPS-style while walking
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(38 / 2))
        const camStart = new THREE.Vector3(2.4, 2.9, 4.5)
        const camEndFor = (h: number) =>
          front.clone().add(normal.clone().multiplyScalar((gSize.y * h) / (divH * 2 * tanHalf)))
        let camEnd = camEndFor(H)
        // Warm every static texture now and let the drivers link the shader
        // pile in parallel: the old synchronous compile() blocked the main
        // thread for its whole duration, which froze the warp tunnel's canvas
        // mid-ride. The intro flight lifts off once this resolves (below).
        disposer.textures.forEach((texture) => webgl?.initTexture(texture))
        const firstCompile = webgl.compileAsync(scene, camera).catch(() => {})

        // start the furniture and yard downloads now; the attach itself waits
        // (at the bottom of this block) for a quiet moment in the intro
        const housePromise = Promise.all(
          HOUSE_MODEL_KEYS.map((k) =>
            load(`/os/models/${k}.glb`).then(
              (gltf) => [k, gltf] as const,
              () => null,
            ),
          ),
        )

        // --- the game runtime: walker, input, levels ------------------------
        const EYE = deskTop + 2.0 // standing eye height over this desk's scale
        const SPAWN = new THREE.Vector3(1.15, EYE, 2.55)
        // the seated framing math (camEndFor, tanHalf) is baked around this;
        // the walk uses the adjustable prefs fov and flyIn eases back here
        const FOV = 38
        const walk = createWalkController(camera, {
          eye: EYE,
          speed: 3.4,
          runSpeed: 5.9,
          crouchSpeed: 1.7,
          crouchDrop: 0.85, // how far the eye sinks at full crouch
          // space hops: heavy-ish gravity so it stays a hop, not a moon walk
          jumpV: 10.4,
          grav: 34,
        })

        // the first-person body: a little robot built in code (playerBody.ts)
        // trailing the camera, so looking down shows your own stubby legs
        const rig = buildPlayerBody(EYE)
        const body = rig.group
        body.visible = false
        scene.add(body)
        const BODY_BACK = 0.38 // eye sits ahead of the spine; keeps the chest out of frame
        const poseBody = () => {
          body.position.set(
            camera.position.x + Math.sin(walk.yaw) * BODY_BACK,
            levels.current.groundY + walk.airY,
            camera.position.z + Math.cos(walk.yaw) * BODY_BACK,
          )
          body.rotation.y = walk.yaw + Math.PI
        }

        // prompt bookkeeping mirrored into React state only on change
        let nearNow = false
        let doorVerbNow: 'open' | 'close' | null = null
        let pausedNow = false
        const gazeVec = new THREE.Vector3()
        const toScreen = new THREE.Vector3()

        const setPauseNow = (on: boolean) => {
          if (pausedNow === on) return
          pausedNow = on
          if (on) input.clearKeys() // nothing stays latched under the menu
          setPaused(on)
        }

        const input = createRoamInput({
          dom: webgl.domElement,
          isActive: () => roaming,
          isLive: () => fps,
          isPaused: () => pausedNow,
          onTurn: (dx, dy, sign) => walk.turn(dx, dy, sign, prefsRef.current.sens),
          // E: the machine's prompt wins over a door's
          onUse: () => {
            if (nearNow) {
              interactRef.current()
              return true
            }
            if (doorVerbNow) {
              camera.getWorldDirection(gazeVec)
              house.useDoor(camera.position, gazeVec)
              return true
            }
            return false
          },
          onEscResume: () => {
            setPauseNow(false)
            input.tryLock()
          },
          onLock: (isLocked) => {
            setLocked(isLocked)
            // losing the lock mid-walk is esc: pause. (sitting down drops the
            // lock too, but stopRoam clears `roaming` before that lands here)
            if (isLocked) setPauseNow(false)
            else if (roaming && fps) setPauseNow(true)
          },
        })

        // the two levels and the noclip cut between them; the scene's share
        // of a swap is the blackout card and the shadow-map hygiene
        const levels = createLevelSystem({
          levels: makeHomeLevels(house, backrooms, obstacles),
          home: 'overworld',
          onCover: (on) => {
            blackout.style.transition = on ? 'opacity 130ms' : 'opacity 650ms'
            blackout.style.opacity = on ? '1' : '0'
          },
          onCutStart: () => {
            walk.haltPlanar()
            backrooms.noclipSound()
          },
          onSwapped: (level, spawn) => {
            walk.resetMotion()
            walk.spawnAt(spawn.x, spawn.z, spawn.yaw, level.groundY)
            if (level.id === 'overworld') house.flagShadows(camera.position)
            // either side of the cut, the body's old shadow may still be
            // baked into the desk-area maps: re-render them without it
            pendant.shadow.needsUpdate = true
            key.shadow.needsUpdate = true
          },
        })

        // compose the roam ramp with the day cycle: every rendered frame
        // re-reads the clock, so dawn keeps breaking mid-walk (and while
        // parked nothing renders, so nothing is spent). The current level
        // gets the last word (the backrooms kill the sky entirely).
        const spillNight = new THREE.Color('#9dbfff')
        const spillDay = new THREE.Color('#ffe9c4')
        const sceneFog = scene.fog as THREE.Fog
        const sceneBg = scene.background as THREE.Color
        const lightRig: LevelLightRig = {
          hemi,
          moon,
          windowSpill,
          setMoonPool: (o) => {
            moonSpillMat.opacity = o
          },
          fog: sceneFog,
          bg: sceneBg,
        }
        const applyLight = () => {
          const sky = outside.update(camera.position)
          const k = roamK
          hemi.color.copy(sky.hemiSky)
          hemi.groundColor.copy(sky.hemiGround)
          hemi.intensity = (HEMI_SEATED + (HEMI_ROAM - HEMI_SEATED) * k) * sky.dayBoost
          roomGlow.intensity = GLOW_ROAM * k
          pendant.intensity = PEND_ROAM * k
          // the cool window lean-in is moonlight; it sets with the moon
          moon.intensity = MOON_ROAM * k * sky.moonUp * sky.night
          windowSpill.intensity = WINDOW_SPILL_ROAM * (0.25 + k * 0.75) * (1 - 0.55 * sky.day)
          windowSpill.color.lerpColors(spillNight, spillDay, sky.day)
          moonSpillMat.opacity = 0.13 * (0.45 + k * 0.7) * sky.moonUp * sky.night
          if (bulbMat) bulbMat.emissiveIntensity = 3.5 * k
          house.setRoamLight(k)
          house.setDay(sky.day)
          sceneFog.color.copy(sky.fogColor)
          sceneFog.near = sky.fogNear
          sceneFog.far = sky.fogFar
          sceneBg.copy(sky.fogColor)
          levels.current.overrideLight?.(lightRig)
        }

        const render = () => {
          if (!webgl || !scene) return
          applyLight()
          webgl.render(scene, camera)
          css3d.render(cssScene, camera)
        }

        // intro: drift, then push into the glass; afterwards the loop stops
        let announced = false
        let t0 = performance.now()
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
          if (!announced) {
            // first real frame is up: tell the warp tunnel it can open its
            // exit, and where the glass sits on the viewport so the mouth
            // tears open right on the machine
            announced = true
            const c = front.clone().project(camera)
            const top = front.clone().setY(front.y + gSize.y / 2).project(camera)
            const cx = ((c.x + 1) / 2) * W
            const cy = ((1 - c.y) / 2) * H
            window.dispatchEvent(
              new CustomEvent(OS_SCENE_READY_EVENT, {
                detail: { x: cx, y: cy, r: Math.max(40, Math.abs(((1 - top.y) / 2) * H - cy)) },
              }),
            )
          }
          if (zoom >= 1) {
            parked = true
            setIntro(false)
            return // parked: stop rendering, the screen is live DOM now
          }
          raf = requestAnimationFrame(introTick)
        }
        // lift-off happens at the bottom of this block, once the shaders
        // have linked — the warp tunnel holds for the first frame's announce

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

        // --- roam: stand up from the desk and walk the world first-person ---
        // the conductor: input and physics live in src/game, levels decide
        // where you are; this loop just calls each in order and renders
        let lastT = 0
        // adaptive resolution: if the walk can't hold frame rate, step the
        // pixel ratio down (never back up mid-roam, so it can't oscillate);
        // each roam and each sit-down restores full crispness
        let pr = PR_CAP
        let emaMs = 16
        let prWait = 1.5

        const lookAngles = (from: THREE.Vector3, target: THREE.Vector3) => {
          const dir = target.clone().sub(from).normalize()
          return {
            pitch: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)),
            yaw: Math.atan2(-dir.x, -dir.z),
          }
        }

        const walkTick = (now: number) => {
          if (disposed || !roaming) return
          const rawMs = now - lastT
          const dt = Math.min(0.05, rawMs / 1000)
          lastT = now
          // frame-time governor: a smoothed frame cost over ~22ms means the
          // GPU can't keep up at this resolution, so shed a pixel-ratio step
          emaMs = emaMs * 0.93 + Math.min(100, rawMs) * 0.07
          prWait -= rawMs / 1000
          if (prWait <= 0 && emaMs > 22 && pr > 1) {
            pr = Math.max(1, pr - 0.25)
            webgl?.setPixelRatio(pr)
            prWait = 1.2
          }
          // seams and the noclip cut: stepping into the doctored wall span
          // freezes the walk and cuts to black; the level system swaps the
          // worlds under the cover (no seams during the stand-up glide)
          levels.tick(now, camera.position, fps)
          const level = levels.current
          const step = walk.update({
            dt,
            keys: input.keys,
            frozen: levels.frozen,
            groundY: level.groundY,
            collision: level.collision,
            fovBase: prefsRef.current.fov,
          })
          // the body plants its feet under the camera and faces the walk
          // (or hangs from it, mid-hop); legs scissor in step with the bob
          poseBody()
          rig.update(dt, walk.bobT, step.gait, walk.crouchK)
          // doors easing upstairs, chunks streaming below — whichever side
          // the player is on, both worlds keep their pulse
          level.update(dt, camera.position)
          // the player is the only moving shadow caster: re-bake just the
          // lights that can see them, only on frames where they moved
          if (level.id === 'overworld' && step.moved) {
            // generous regions: a map must keep re-baking until the player is
            // fully out of its light's frustum, or their shadow strands there
            if (camera.position.z < 15.5) pendant.shadow.needsUpdate = true
            if (camera.position.z < 7) key.shadow.needsUpdate = true
            house.flagShadows(camera.position)
          }
          // close to the tube and facing it: offer the interact prompt
          toScreen.subVectors(gCenter, camera.position)
          const dist = toScreen.length()
          camera.getWorldDirection(gazeVec)
          const isNear = dist < 3.4 && gazeVec.dot(toScreen.normalize()) > 0.35
          if (isNear !== nearNow) {
            nearNow = isNear
            setNear(isNear)
          }
          // a door in reach offers its own prompt; the machine's wins (and
          // level 0 has no doors, whatever its x/z coordinates suggest)
          const verb =
            isNear || level.id !== 'overworld' ? null : house.doorPrompt(camera.position, gazeVec)
          if (verb !== doorVerbNow) {
            doorVerbNow = verb
            setDoorVerb(verb)
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
          input.setCursor('grab')
          // with the OS still running the tube keeps spilling light
          spill.intensity = liveRef.current ? 1.0 : 0
          // fresh roam, fresh resolution budget
          pr = PR_CAP
          emaMs = 16
          prWait = 1.5
          webgl.setPixelRatio(pr)
          // push back from the desk and rise to standing height: kept short,
          // lingering here made standing up feel mushy
          const s0 = performance.now()
          const from = camera.position.clone()
          const standTick = () => {
            if (disposed || !roaming) return
            const t = Math.min(1, (performance.now() - s0) / 620)
            camera.position.lerpVectors(from, SPAWN, EASE(t))
            const aim = lookAngles(camera.position, front)
            camera.rotation.set(aim.pitch, aim.yaw, 0)
            roomLight(EASE(t))
            render()
            if (t >= 1) {
              // hand the camera to the FPS controls with the exact same yaw
              // and pitch used by the stand-up glide; no second-frame snap
              walk.yaw = aim.yaw
              walk.pitch = aim.pitch
              fps = true
              // the body materializes behind the lens, feet on the floor
              poseBody()
              body.visible = true
              // the body just appeared: refresh only the maps that can see
              // it (same regions walkTick uses) — a full bakeShadows() here
              // re-rendered every map in one frame and stalled the handoff
              if (camera.position.z < 15.5) pendant.shadow.needsUpdate = true
              if (camera.position.z < 7) key.shadow.needsUpdate = true
              house.flagShadows(camera.position)
              input.tryLock()
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
          setPauseNow(false)
          input.clearKeys()
          walk.resetMotion()
          // sitting down (or leaving) always hauls you back through the
          // seam first, so the chair never has to fly up from level 0
          const homed = levels.reset()
          if (homed) {
            walk.spawnAt(homed.spawn.x, homed.spawn.z, walk.yaw, homed.groundY)
          }
          blackout.style.transition = ''
          blackout.style.opacity = '0'
          backrooms.sleep()
          body.visible = false
          if (webgl) {
            // bake the body's shadow away; sitting down only happens at the
            // machine, so only the desk-area maps can still be holding it
            pendant.shadow.needsUpdate = true
            key.shadow.needsUpdate = true
            // sit back down at full resolution; the governor only runs walking
            pr = PR_CAP
            webgl.setPixelRatio(pr)
          }
          nearNow = false
          doorVerbNow = null
          setWalking(false)
          setNear(false)
          setDoorVerb(null)
          input.releaseLock()
          if (webgl) {
            webgl.domElement.style.pointerEvents = 'none'
            input.setCursor('')
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
          const fovFrom = camera.fov // a sprint into the chair leaves the lens wide
          // quick: a slow sink into the chair felt wrong every single time
          const delay = live ? 0.05 : 0.3
          const dur = live ? 0.8 : 1.35
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
            if (fovFrom !== FOV) {
              camera.fov = fovFrom + (FOV - fovFrom) * EASE(zoom)
              camera.updateProjectionMatrix()
            }
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
        // the door prompt button routes here (E does the same via input)
        doorRef.current = () => {
          camera.getWorldDirection(gazeVec)
          house.useDoor(camera.position, gazeVec)
        }
        // the pause menu's resume button (esc does the same via input)
        resumeRef.current = () => {
          setPauseNow(false)
          input.tryLock()
        }

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
          input.dispose()
          prevCleanup?.()
        }

        // lift-off: the flight starts once every program has linked, so its
        // first frame renders without a compile stall; the tunnel is still
        // holding for that frame's announce. The heavy first frame is paid
        // in installments under the cover: one plain render (first-draw
        // buffer and texture costs), then one shadow map per frame
        void firstCompile.then(async () => {
          if (disposed || roaming || leaving) return
          camera.position.copy(camStart)
          camera.lookAt(front)
          render()
          await new Promise((r) => requestAnimationFrame(r))
          await bakeShadowsStaggered(() => disposed || roaming || leaving)
          if (disposed || roaming || leaving) return
          t0 = performance.now()
          raf = requestAnimationFrame(introTick)
        })

        // stream the furniture and yard models in behind the intro; the
        // house is fully walkable before any of them land, and a prop that
        // fails to download is just a gap, never a failure
        void housePromise.then(async (entries) => {
          if (disposed || !webgl || !scene) return
          const models: HouseModels = { plant, mug }
          for (const e of entries) if (e) models[e[0]] = e[1]
          // hold the attach until the camera parks (or the walk begins):
          // the clone + compile burst used to land mid-flight and hitch the
          // intro and the warp exit right on top of each other
          while (!disposed && !parked && !roaming && !leaving) {
            await new Promise((r) => setTimeout(r, 120))
          }
          if (disposed || !webgl || !scene) return
          house.furnish(models)
          outside.furnish(models) // borrows the tree/bush GLBs for the block
          disposer.textures.forEach((texture) => webgl?.initTexture(texture))
          // pay the new shaders/textures now, not on the first look around
          await webgl.compileAsync(scene, camera).catch(() => {})
          if (disposed || !webgl) return
          // re-bake in installments; parked, each step draws its own frame,
          // so the furniture joins the standing image without one big hitch
          await bakeShadowsStaggered(() => disposed || !webgl)
        })
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
      doorRef.current = null
      resumeRef.current = null
      if (scene) {
        scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh && !(o as unknown as THREE.Line).isLine) return
          mesh.geometry.dispose()
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          mats.forEach((m) => m.dispose())
        })
      }
      webgl?.dispose()
      disposer.disposeAll()
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
      {roam && walking && !paused && (
        <p className="pointer-events-none absolute right-5 bottom-4 z-10 font-mono text-[11px] text-stone-500">
          {locked
            ? 'wasd move · space jump · shift run · ctrl crouch · esc pauses'
            : 'wasd to move · click to grab the mouse · esc to leave'}
        </p>
      )}
      {roam && walking && locked && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 z-10 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-400/70"
        />
      )}
      {roam && walking && paused && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div aria-hidden className="absolute inset-0 bg-stone-950/40" />
          <div className="pointer-events-auto relative w-72 rounded-lg border border-stone-700 bg-stone-950/85 p-4 font-mono backdrop-blur-sm">
            <div className="flex items-baseline justify-between">
              <p className="text-[13px] text-stone-200">paused</p>
              <p className="text-[10px] text-stone-600">esc resumes</p>
            </div>
            <label className="mt-4 block text-[11px] text-stone-400">
              <span className="flex justify-between">
                <span>field of view</span>
                <span className="text-stone-500">{prefs.fov}°</span>
              </span>
              <input
                type="range"
                min={30}
                max={80}
                step={1}
                value={prefs.fov}
                onChange={(e) => setPrefs((p) => ({ ...p, fov: Number(e.target.value) }))}
                className="mt-1.5 w-full cursor-pointer accent-stone-400"
              />
            </label>
            <label className="mt-3 block text-[11px] text-stone-400">
              <span className="flex justify-between">
                <span>mouse sensitivity</span>
                <span className="text-stone-500">{prefs.sens.toFixed(2)}x</span>
              </span>
              <input
                type="range"
                min={0.3}
                max={3}
                step={0.05}
                value={prefs.sens}
                onChange={(e) => setPrefs((p) => ({ ...p, sens: Number(e.target.value) }))}
                className="mt-1.5 w-full cursor-pointer accent-stone-400"
              />
            </label>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => resumeRef.current?.()}
                className="flex-1 cursor-pointer rounded-md border border-stone-600 bg-stone-800/70 px-3 py-1.5 text-[12px] text-stone-200 transition-colors hover:border-stone-400 hover:text-white"
              >
                resume
              </button>
              {onLeave && (
                <button
                  type="button"
                  onClick={onLeave}
                  className="flex-1 cursor-pointer rounded-md border border-stone-800 px-3 py-1.5 text-[12px] text-stone-500 transition-colors hover:border-stone-600 hover:text-stone-300"
                >
                  leave the room
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {roam && walking && !paused && near && (
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
      {roam && walking && !paused && !near && doorVerb && (
        <button
          type="button"
          onClick={() => doorRef.current?.()}
          className="absolute bottom-14 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[12px] text-stone-300 backdrop-blur-sm transition-colors hover:border-stone-500 hover:text-white"
        >
          <kbd className="mr-2 rounded border border-stone-600 bg-stone-800 px-1.5 py-0.5 text-[10px] text-stone-200">
            E
          </kbd>
          {doorVerb === 'open' ? 'open the door' : 'close the door'}
        </button>
      )}
    </div>
  )
}
