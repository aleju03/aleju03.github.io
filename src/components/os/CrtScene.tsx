import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js'
import { buildHouse, CEIL_H, FRONT_DOOR_X, HOUSE } from '../../game/levels/houseWorld'
import { buildOutsideWorld } from '../../game/levels/outsideWorld'
import { buildBackrooms } from '../../game/levels/backrooms'
import { buildDeskRoom } from '../../game/levels/deskRoom'
import { makeHomeLevels } from '../../game/levels/homeLevels'
import { createLevelSystem } from '../../game/levels/levelSystem'
import type { Level, LevelLightRig } from '../../game/levels/types'
import { buildPaperPlane } from '../../game/props/paperPlane'
import type { HouseModels } from '../../game/levels/houseWorld'
import { buildPlayerBody, type PlayerPose } from '../../game/player/playerBody'
import type { RagdollEnv } from '../../game/player/ragdoll'
import { createChaseCam, type ChaseEnv } from '../../game/player/chaseCam'
import { createWalkController } from '../../game/player/walkController'
import { createRoamInput } from '../../game/core/input'
import { blockedAt, makeCollisionSet, supportY } from '../../game/physics/collision'
import { createCollisionDebug } from '../../game/physics/collisionDebug'
import { createDisposer } from '../../game/core/disposer'
import { footstep, landThump } from '../../game/core/sfx'
import { buildFleet, type FleetEnvQueries } from '../../game/vehicles/registry'
import type { NetPose, Vehicle, VehicleId } from '../../game/vehicles/types'
import { setGfxTier } from '../../game/world/quality'
import { createRemoteWorld } from '../../game/net/remotePlayers'
import { createRemoteAvatars, type AvatarEnv } from '../../game/net/avatars'
import {
  packPose,
  SEAT_DRIVER,
  SEAT_PASSENGER,
  WIRE_VEHICLES,
  WORLD_MAX_TEXT_LEN,
} from '../../game/net/protocol'
import { createRemoteFleet } from '../../game/net/remoteVehicles'
import { scatterSpawn } from '../../game/net/spawn'
import { createWorldNet, worldConfigured, type WorldStatus } from './worldNet'
import { createProximityVoice, type VoiceMode } from './proximityVoice'
import type { Session } from './osContext'
import { track } from '../../analytics'
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
  /** who the shared walk introduces you as. Null while the desktop is still
      on the login screen; the world simply is not joined until there is one */
  session?: Session | null
  /** pressed the interact key at the machine: sit down (and boot if cold) */
  onInteract: () => void
  /** the pause menu's way out of the room entirely (what esc used to do) */
  onLeave?: () => void
  onFail: () => void
  /** how far along the cold boot is, for whatever is covering it. Called with
      null once the first real frame is on screen and the cover can go */
  onStage?: (stage: LoadStage | null) => void
  children: ReactNode
}

/** the three things a cold boot spends real time on, in the order it does.
    They are wall-clock unequal by a lot — shaders is most of it — so anything
    drawing a progress bar off these should weight them, not space them */
export type LoadStage = 'models' | 'world' | 'shaders'

/** one line on the chat rail. `mine` is what tints it, not the name, so two
    visitors sharing a nickname still read their own words correctly */
interface ChatLine {
  key: number
  name: string
  text: string
  admin: boolean
  mine: boolean
  /** an arrival or a departure rather than something somebody said; the whole
      sentence is in `text` and there is no name to attribute it to */
  system?: boolean
}
/** everything the voice indicator needs, mirrored out of proximityVoice.ts
    because the HUD is React and that module is not */
interface VoiceHud {
  available: boolean
  enabled: boolean
  mode: VoiceMode
  speaking: boolean
  peers: number
  error: string | null
}
/** the rail only ever shows the tail; anything older has scrolled off */
const CHAT_KEEP = 6

const EASE = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const MODELS = [
  '/os/models/computer.glb',
  '/os/models/desk.glb',
  '/os/models/mug.glb',
  '/os/models/plant.glb',
  '/os/models/mouse.glb',
  '/os/models/lamp.glb',
]
// the rest of the house downloads beside the first shader compile, then joins
// the scene under BootCover so none of its material variants can land mid-walk
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
const PREFS_DEFAULT = { fov: 60, sens: 1, third: false }
const loadPrefs = () => {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { fov?: number; sens?: number; third?: boolean }
      return {
        fov: Math.min(80, Math.max(30, Number(p.fov) || PREFS_DEFAULT.fov)),
        sens: Math.min(3, Math.max(0.3, Number(p.sens) || PREFS_DEFAULT.sens)),
        third: p.third === true,
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...PREFS_DEFAULT }
}
/** the control line each machine puts in the HUD. Three media, three sets of
    verbs: what "space" does is a handbrake, a throttle blip or the collective
    depending on what you climbed into */
const DRIVE_KEYS: Record<VehicleId, string> = {
  car: 'wasd drive · space handbrake · shift boost · x horn',
  boat: 'w/s throttle · a/d rudder · shift boost · x horn',
  heli: 'w/s tilt · a/d turn · space climb · ctrl descend · shift power',
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
  session,
  onInteract,
  onLeave,
  onFail,
  onStage,
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
  // --- the fleet -----------------------------------------------------------
  // a parked machine in reach, what is being driven, and the instrument
  // readout. All of it is HUD state, mirrored out of the sim on change only —
  // the numbers would otherwise re-render this component sixty times a second
  const [vehiclePrompt, setVehiclePrompt] = useState<{ label: string; verb: string } | null>(null)
  const [driving, setDriving] = useState<{
    id: VehicleId
    label: string
    cockpit: boolean
    /** 0 at the controls, 1 along for the ride */
    seat: number
    /** what to call the person in that chair: driver/passenger, pilot/copilot */
    crew: string
  } | null>(
    null,
  )
  const [gauge, setGauge] = useState({ speed: 0, load: 0, altitude: 0, gear: 0 })
  /** a line of feedback that fades: "land first", "nowhere to put it down" */
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 2200)
    return () => clearTimeout(t)
  }, [notice])
  /** the pause menu's vehicle list, refreshed only while the menu is up */
  const [fleetWhere, setFleetWhere] = useState<
    Array<{ id: VehicleId; label: string; dist: number; bearing: string }>
  >([])
  const fleetRef = useRef<{
    where: () => Array<{ id: VehicleId; label: string; dist: number; bearing: string }>
    recall: (id: VehicleId) => boolean
  } | null>(null)
  // the prompt buttons route here; E does the same through the input service
  const enterRef = useRef<(() => void) | null>(null)
  const leaveRef = useRef<(() => void) | null>(null)
  // --- the shared walk -----------------------------------------------------
  // presence, the chat rail, and what the microphone is doing. All of it is
  // HUD state: the sim side lives in the effect below and never re-renders
  const [mp, setMp] = useState<{ status: WorldStatus; here: number }>({
    status: 'offline',
    here: 0,
  })
  const [chat, setChat] = useState<ChatLine[]>([])
  const [typing, setTyping] = useState(false)
  // named for what it is: a mirror of proximityVoice.ts's state for the HUD,
  // not the voice channel itself (that lives in the scene effect below)
  const [voiceHud, setVoiceHud] = useState<VoiceHud>({
    available: false, enabled: false, mode: 'open', speaking: false, peers: 0, error: null,
  })
  const chatInputRef = useRef<HTMLInputElement>(null)
  const typingRef = useRef(false)
  const closeChat = () => {
    typingRef.current = false
    setTyping(false)
  }
  // set by the effect so the composer can post without reaching into the sim
  const sayRef = useRef<((text: string) => void) | null>(null)
  const sessionRef = useRef(session)
  const outroRef = useRef<(() => void) | null>(null)
  const roamRef = useRef<((on: boolean) => void) | null>(null)
  const doorRef = useRef<(() => void) | null>(null)
  const resumeRef = useRef<(() => void) | null>(null)
  const failRef = useRef(onFail)
  const stageRef = useRef(onStage)
  const interactRef = useRef(onInteract)
  const liveRef = useRef(screenLive)
  const prefsRef = useRef(prefs)
  const paperPlaneRef = useRef(paperPlane)
  // the live roam prop, readable from inside the scene's build closure: a
  // /room entrance has it true before roamRef exists to be called
  const roamPropRef = useRef(roam)
  useEffect(() => {
    failRef.current = onFail
    stageRef.current = onStage
    interactRef.current = onInteract
    liveRef.current = screenLive
    prefsRef.current = prefs
    paperPlaneRef.current = paperPlane
    roamPropRef.current = roam
    sessionRef.current = session
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
    // the fleet is the one subsystem with a live audio graph in it, so it has
    // to be torn down explicitly rather than left to the disposer: an engine
    // that is only garbage-collected keeps idling under an unmounted scene
    let disposeFleet: (() => void) | null = null
    const disposer = createDisposer()

    const bail = setTimeout(() => {
      if (!webgl) failRef.current()
    }, 6000)

    const loader = new GLTFLoader()
    const load = (url: string) =>
      new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) =>
        loader.load(url, resolve, undefined, reject),
      )

    stageRef.current?.('models')
    Promise.all(MODELS.map(load))
      .then(([computer, desk, mug, plant, mouse, lamp]) => {
        clearTimeout(bail)
        if (disposed) return
        stageRef.current?.('world')

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
        // classify the GPU and pick the graphics tier BEFORE any level
        // builds: grass density, canopy fullness and the sun's shadow map
        // are baked at construction time (world/quality.ts). Discrete cards
        // get the dense tier; integrated, mobile and software renderers keep
        // the lean one, with the pixel-ratio governor under both.
        try {
          const gl = webgl.getContext()
          const info = gl.getExtension('WEBGL_debug_renderer_info')
          const gpu = info
            ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
            : String(gl.getParameter(gl.RENDERER))
          setGfxTier(
            /intel|iris|uhd|mali|adreno|powervr|videocore|apple gpu|swiftshader|llvmpipe/i
              .test(gpu) ? 'medium' : 'high',
          )
        } catch {
          setGfxTier('medium')
        }
        // three only reads a program's link status when this is on, and that
        // read (getProgramInfoLog/getShaderInfoLog) blocks the main thread
        // until the driver has finished compiling — the exact stall
        // compileAsync and KHR_parallel_shader_compile exist to avoid, paid
        // on first use, i.e. inside the warp ride's first frame. Nothing here
        // authors a shader, so the diagnostics only cost. Turn this back on
        // if a ShaderMaterial or onBeforeCompile ever lands in the scene:
        // without it a broken shader fails silently instead of logging.
        webgl.debug.checkShaderErrors = false
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
        // the desk strip goes in before the world does, and that ordering is
        // load-bearing twice over: resolveXZ is a sequential pass where the
        // last overlapping box wins (so the desk has to beat the bedroom
        // walls), and the streamer records the length of this list as the
        // authored count it truncates back to on every restream — anything
        // pushed after it would be dropped the first time the player crosses
        // a chunk border
        obstacles.push(...deskObstacles)
        // ...and past the fence: the sky on its day cycle, and an endless
        // chunk-streamed world of terrain, biomes, water, roads and cities.
        // update() runs per rendered frame: it streams the ring around the
        // camera and hands back the fog/hemisphere targets for right now.
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
        // three machines parked in it: a car at the kerb, a helicopter a block
        // north, and a boat two and a half kilometres west on the coast. The
        // fleet owns its own physics, camera, sound and dust; from here it is
        // one tick and two prompts. Its collision boxes join the shared
        // obstacle list, so a parked car is something you walk into — and, in
        // the same breath, something the chunk streamer must not mistake for
        // its own (it filters by identity, and these are never in its WeakSet)
        const fleet = buildFleet({
          scene,
          obstacles,
          trackTexture: disposer.texture,
          trackDisposable: disposer.add,
        })
        disposeFleet = fleet.dispose
        // F9: outline whatever the live level is testing the walk against.
        // Collision in here is a Box3 list with nothing drawn behind it, so a
        // solid that disagrees with the geometry it stands for is invisible by
        // construction — see collisionDebug.ts
        const collisionDebug = disposer.add(createCollisionDebug(scene))

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
        // Every local shadow map is hand-baked while BootCover is still
        // opaque. One light per frame keeps the compositor's loading bar
        // moving between maps; announcing the scene before this loop is done
        // merely moves the cold driver stalls into the first seconds of play.
        const bakeShadowsCovered = async (bailOut: () => boolean) => {
          const lights = [pendant, key, ...house.shadowLights]
          for (let i = 0; i < lights.length; i += 1) {
            if (bailOut()) return
            lights[i].shadow.needsUpdate = true
            render()
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

        /*
          The far plane has to clear the sky dome's radius outright, and by a
          margin — at 400 against a 430 dome it did not, and the way that fails
          is worth remembering. A far plane is a *plane*, perpendicular to the
          view axis; a dome centred on the camera is a *sphere*. A point on the
          dome at angle t off the view axis sits cos(t) * radius deep, so
          everything inside acos(far / radius) of wherever you happen to be
          looking gets clipped away. The symptom is a hard-edged disc of empty
          background about forty degrees across, pinned to the middle of the
          screen, sliding across the stars as you turn your head. It looks like
          a bug in the sky texture and it is a bug in the frustum.
        */
        const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 900)
        camera.rotation.order = 'YXZ' // yaw/pitch compose FPS-style while walking
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(38 / 2))
        const camStart = new THREE.Vector3(2.4, 2.9, 4.5)
        const camEndFor = (h: number) =>
          front.clone().add(normal.clone().multiplyScalar((gSize.y * h) / (divH * 2 * tanHalf)))
        let camEnd = camEndFor(H)
        // where the walk stands. Up here with the camera rather than down in
        // the runtime block, because the /room entrance opens the lens on it
        // directly rather than gliding up to it from the chair
        const EYE = deskTop + 2.0 // standing eye height over this desk's scale
        const SPAWN = new THREE.Vector3(1.15, EYE, 2.55)
        // Warm every static texture now and let the drivers link the shader
        // pile in parallel: the old synchronous compile() blocked the main
        // thread for its whole duration, which froze the warp tunnel's canvas
        // mid-ride. The intro flight lifts off once this resolves (below).
        disposer.textures.forEach((texture) => webgl?.initTexture(texture))
        stageRef.current?.('shaders')
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
        // the seated framing math (camEndFor, tanHalf) is baked around SPAWN;
        // the walk uses the adjustable prefs fov and flyIn eases back here
        const FOV = 38
        const walk = createWalkController(camera, {
          eye: EYE,
          // the whole gait shifted up a notch: the old sprint (5.9) is now the
          // default walk, and the sprint is faster than anything the walk used
          // to reach. The old numbers were a stroll on a planet you cross on
          // foot. Everything downstream is expressed against these two — the
          // gait fraction, the sprint fov ramp, the body's stride length — so
          // they follow on their own; the crouch keeps its half-of-a-walk feel.
          speed: 5.9,
          runSpeed: 9.4,
          crouchSpeed: 2.8,
          crouchDrop: 0.85, // how far the eye sinks at full crouch
          // space hops: heavy-ish gravity so it stays a hop, not a moon walk.
          // The apex (jumpV²/2·grav ≈ 2.08, a bit over half an eye height)
          // is chosen against the furniture: the tallest thing worth landing
          // on is the sofa back at 1.89, with the bed at 1.79 and the desk at
          // 1.84 under it. At the old 10.4 the apex was 1.59 and every one of
          // those was a hair out of reach, which read as the hop being broken.
          jumpV: 11.9,
          grav: 34,
          // a shin's worth of ledge is walked up; anything taller wants the
          // hop (whose apex, jumpV²/2·grav, clears the sofa and the bed)
          step: EYE * 0.12,
        })

        // the player's body: the articulated robot in playerBody.ts. In first
        // person it trails the camera so looking down shows your own legs; in
        // third person (v) the chase boom in chaseCam.ts backs the lens off
        // it, and a flop (x) hands the whole skeleton to the ragdoll
        const rig = buildPlayerBody(EYE, 34) // same gravity as the walk tune
        const body = rig.group
        body.visible = false
        scene.add(body)
        const chase = createChaseCam()
        const BODY_BACK = 0.38 // eye sits ahead of the spine; keeps the chest out of frame
        const poseBody = () => {
          // the trailing offset fades with the real boom length, not the mode:
          // a wall that crushes the boom flat leaves a first-person body.
          // Pitching down slides the body a bit further back (quadratically,
          // so level walking never feels it) — a steep look-down then reads
          // as your chest and legs, not the top slab of your own torso
          const fp = 1 - Math.min(1, chase.dist / 1.2)
          const down = Math.max(0, -walk.pitch) / 1.35
          const back = (BODY_BACK + 0.55 * down * down) * fp
          const ox = Math.sin(walk.yaw) * back
          const oz = Math.cos(walk.yaw) * back
          // the offset is presentation, not travel: the rig shifts its
          // planted feet along with it so the legs never stretch after it
          rig.trackSlide(ox, oz)
          // the soles sit wherever the walker's feet are — the level floor,
          // the sofa cushion, mid-hop over either
          body.position.set(camera.position.x + ox, walk.feetY, camera.position.z + oz)
          // the body faces where the rig says it faces — standing, that
          // lags the camera and the head covers the gap (no statue-spin)
          body.rotation.y = rig.facing + Math.PI
        }
        // reused every tick; the rig and boom read them, never keep them
        const rigPose: PlayerPose = {
          dt: 0, gait: 0, crouchK: 0, grounded: true, run: false,
          yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 0,
        }
        // collision is re-pointed at the live level's set every tick
        const bootSet = makeCollisionSet(
          { minX: -1e3, maxX: 1e3, minZ: -1e3, maxZ: 1e3 },
          obstacles,
        )
        const rigEnv: RagdollEnv = { groundY: 0, ceilingY: undefined, collision: bootSet }
        const chaseEnv: ChaseEnv = {
          collision: bootSet, groundY: 0, ceilingY: undefined, yaw: 0, pitch: 0, focus: null,
        }
        const focusPt = new THREE.Vector3()
        const getupPt = new THREE.Vector3()
        // seams are floor-level doorways, so they get the feet, not the eye
        const seamPt = new THREE.Vector3()
        /** a spawn point names x/z; what it stands on is whatever is there.
            Both authored spawns are open floor today, but furniture streams
            into the overworld and chunks stream into level 0 long after the
            levels were built, so ask rather than assume the floor — and ask
            the level's own terrain where the floor under all of it is. */
        const floorOf = (level: Level, x: number, z: number) =>
          level.groundYAt ? level.groundYAt(x, z) : level.groundY
        const spawnY = (level: Level, x: number, z: number) => {
          const floor = floorOf(level, x, z)
          return supportY(x, z, floor + EYE * 0.12, level.collision, floor)
        }
        /** the authored spawn, nudged aside so simultaneous arrivals do not
            stand up inside one another. Slot 0 (nobody else here, or the
            first one in) is the authored point untouched, so single player
            is pixel-for-pixel what it always was. */
        const spawnSpotFor = (level: Level, x: number, z: number) => {
          if (spawnSlot <= 0) return { x, z }
          return scatterSpawn(x, z, spawnSlot, (cx, cz) => {
            const floor = spawnY(level, cx, cz)
            return !blockedAt(cx, cz, floor, floor + EYE, level.collision, EYE * 0.12)
          })
        }
        /** what a wheel, a hull or a boot is standing on. The property answers
            for its own lawn, porch and paths; the open world for the rest */
        const surfaceOf = (x: number, z: number) =>
          outside.onProperty(x, z) ? house.surfaceAt(x, z) : outside.surfaceAt(x, z)
        // the world, as the vehicles ask about it. One object, re-pointed at
        // the live level each tick — the same shape rigEnv and chaseEnv take
        const fleetEnv: FleetEnvQueries = {
          groundAt: outside.groundYAt,
          waterY: outside.waterY,
          collision: bootSet,
          surfaceAt: surfaceOf,
          waveAt: outside.waveAt,
        }
        // a level with no terrain function still has to answer; the closure is
        // hoisted rather than made per frame, because this runs every tick
        let flatY = 0
        const flatGround = () => flatY
        const aimFleetEnv = (level: Level) => {
          flatY = level.groundY
          fleetEnv.groundAt = level.groundYAt ?? flatGround
          fleetEnv.waterY = level.waterY
          fleetEnv.collision = level.collision
          return fleetEnv
        }
        /*
          The fleet's half of the network, once a frame.

          Two directions, and they are not symmetric. Outbound is one machine:
          the one whose wheel we are holding, reported at the socket's own
          throttle. Inbound is the other two-and-a-bit: every machine somebody
          else is driving, handed to the registry as a pose it must place
          rather than integrate.

          The seat table is folded in here too, as the `taken` flags the
          interact prompt reads — which is what makes a car with a driver in it
          offer its passenger door and a full one offer nothing at all.
        */
        const netDriven: Array<NetPose | null> = WIRE_VEHICLES.map(() => null)
        const netTaken: Array<[boolean, boolean]> = WIRE_VEHICLES.map(() => [false, false])
        const fleetNetState = { driven: netDriven, taken: netTaken }

        const syncFleetNet = (now: number) => {
          if (!net) {
            fleet.setNet(null)
            return
          }
          fleetNet.sample(now)
          const me = remote.you
          for (let i = 0; i < WIRE_VEHICLES.length; i++) {
            const v = fleetNet.vehicles[i]
            netDriven[i] = v.netDriven ? v : null
            netTaken[i] = [
              v.driver !== 0 && v.driver !== me,
              v.passenger !== 0 && v.passenger !== me,
            ]
          }
          fleet.setNet(fleetNetState)
        }

        /** the machines, put where the server last saw them. Only on joining */
        const placeFleetFromNet = () => {
          if (!fleetPlaced) return // spawnAll has not run yet; it calls back
          const q = aimFleetEnv(levels.current)
          for (const v of fleetNet.vehicles) {
            if (v.known) fleet.placeFromNet(v.id, v.x, v.z, v.yaw, q)
          }
        }

        /** the seat node a remote player is sitting in, for their avatar */
        const seatFor = (id: number) => {
          const at = fleetNet.seatOf(id)
          if (!at) return null
          const v = fleet.all.find((m) => m.id === at.vehicle)
          if (!v) return null
          return at.seat === SEAT_DRIVER ? v.driverSeat : v.passengerSeat
        }

        let vHeld = false
        let xHeld = false
        let dbgHeld = false
        /** F9, read the same way v and x are: edge-detected off the key set,
            and asked in both loops because either can be the live one */
        const debugTick = (level: Level, x: number, footY: number, z: number) => {
          const now = input.keys.has('F9')
          if (now && !dbgHeld) collisionDebug.toggle()
          dbgHeld = now
          collisionDebug.update(level.collision, {
            x, z, footY, headY: footY + EYE,
          })
        }
        // the multiplayer keys ride the same edge-detect pattern: t opens the
        // chat line, m arms the microphone, n swaps the talk mode. b is read
        // as a held state instead, since it is the push-to-talk key
        let tHeld = false
        let mHeld = false
        let nHeld = false
        let hereNow = 0

        // prompt bookkeeping mirrored into React state only on change
        let nearNow = false
        let doorVerbNow: 'open' | 'close' | null = null
        let vehicleNow: { id: VehicleId; label: string; verb: string; seat: number } | null = null
        let pausedNow = false
        const gazeVec = new THREE.Vector3()
        const toScreen = new THREE.Vector3()
        // where the player's head was and what it was looking at, snapshotted
        // each tick while the camera still IS the head. Interaction callbacks
        // fire from DOM events, outside walkTick — by then the chase boom has
        // taken the camera, and in third person `camera.position` is metres
        // behind the body, which is why E on a door did nothing there.
        const headPos = new THREE.Vector3()
        const headDir = new THREE.Vector3(0, 0, -1)

        /*
          Climbing in and out.

          Two things make this delicate, and both are about the camera. The
          chase boom (chaseCam.ts) brackets the walk: restore() writes back the
          head transform it saved last frame, apply() saves whatever it finds.
          Leave it holding while the drive camera writes the lens and it will
          treat the boom position as a head and boom off *that*; leave it
          holding across the whole drive and it will snap the camera back to a
          transform from before you got in. So it is dropped on both edges.

          The other is the walker itself. It keeps integrating a body that is
          no longer anywhere, so it is parked at the machine every frame — that
          way the network, the level reset and the stand-down all read a
          position that is true, and a level cut cannot strand a walker under
          the sea while the car drives on.

          And with other people about, a third: the chair has to be *granted*.
          Pressing E sends a claim and nothing else happens until the server's
          seat table comes back with our name in it — one round trip, against a
          mount blend that lasts more than half a second, so it is not
          something you can feel. Sitting down optimistically and standing back
          up on a denial would be: two people reaching for the same door would
          both get in, and one of them would be ejected a moment later. Offline
          (no VITE_CHAT_URL, or a dropped socket) there is nobody to ask, so
          the claim resolves immediately and this is the old single-player
          path exactly.
        */
        /** a claim we have sent and not yet had answered */
        let seatWanted: { id: VehicleId; seat: number } | null = null

        const enterVehicle = (id: VehicleId, seat = SEAT_DRIVER) => {
          if (fleet.riding || levels.frozen || rig.down) return
          const v = fleet.all.find((x) => x.id === id)
          if (!v) return
          if (net) {
            // ask, and wait. `grantSeat` finishes the job when the table lands
            seatWanted = { id, seat }
            net.seat(WIRE_VEHICLES.indexOf(id), seat)
            return
          }
          boardVehicle(id, seat)
        }

        /** actually get in. Either the server said so, or there is no server */
        const boardVehicle = (id: VehicleId, seat: number) => {
          if (fleet.riding || levels.frozen || rig.down) return
          const v = fleet.all.find((x) => x.id === id)
          if (!v) return
          // the grant is a round trip late, and a player can walk out of reach
          // inside one. Being teleported into a car you have turned your back
          // on is worse than not getting in, so give the chair straight back
          if (
            Math.hypot(v.root.position.x - camera.position.x, v.root.position.z - camera.position.z) >
            v.reach + 3
          ) {
            net?.unseat()
            return
          }
          fleet.enter(v, camera, walk.yaw, walk.pitch, seat)
          walk.resetMotion()
          rig.reset()
          rig.sit()
          chase.drop()
          // This is the same articulated avatar used on foot, not a vehicle's
          // approximation of it. The seat owns position and vehicle attitude;
          // the rig owns the one shared seated pose.
          seatNode(v, seat).add(body)
          body.position.set(0, 0, 0)
          body.rotation.set(0, Math.PI, 0)
          body.visible = true
          vehicleNow = null
          setVehiclePrompt(null)
          setDriving({
            id,
            label: v.label,
            cockpit: fleet.cockpit,
            seat,
            crew: crewLabel(id, seat),
          })
          track('vehicle_entered', { kind: id, seat })
        }

        const leaveVehicle = () => {
          const v = fleet.riding
          if (!v) return
          const spot = fleet.leave(aimFleetEnv(levels.current))
          if (!spot) {
            // a helicopter fifty units up is not somewhere you step out of
            setNotice('land first')
            return
          }
          chase.drop()
          walk.resetMotion()
          walk.spawnAt(spot.x, spot.z, spot.yaw, spot.feetY)
          // spawnAt levels the pitch; keep the view the player actually had
          walk.pitch = spot.pitch
          // Leave the vehicle hierarchy before poseBody writes world-space
          // coordinates back into the walking rig.
          scene?.add(body)
          rig.reset()
          rig.face(spot.yaw)
          poseBody()
          body.visible = true
          // the body just reappeared somewhere new, and the machine's own
          // shadow moved with it
          if (camera.position.z < 15.5) pendant.shadow.needsUpdate = true
          if (camera.position.z < 7) key.shadow.needsUpdate = true
          house.flagShadows(camera.position)
          seatWanted = null
          net?.unseat()
          setDriving(null)
        }

        /** the node a given chair hangs off */
        const seatNode = (v: Vehicle, seat: number) =>
          seat === SEAT_DRIVER ? v.driverSeat : v.passengerSeat

        /** what the HUD calls the person in this chair. A helicopter has a
            pilot and a copilot; a boat and a car do not */
        const crewLabel = (id: VehicleId, seat: number) => {
          if (seat === SEAT_DRIVER) return id === 'heli' ? 'pilot' : 'driver'
          return id === 'heli' ? 'copilot' : 'passenger'
        }

        /*
          The seat table landed. Four things can have happened, and all four
          have to be handled from this one message, because it is the only
          statement of fact there is:

          - the chair we asked for is ours: get in
          - we hold a chair we did not ask for and are not in: this is a
            reconnect (a fresh id, an old body) — get in, it is genuinely ours
          - we are in a chair the table does not give us: the server disagrees
            with our own client, so get out. It wins
          - the driver of the machine we are *riding* left: slide across
        */
        const applySeats = () => {
          const held = fleetNet.mine
          const riding = fleet.riding
          if (held && !riding) {
            const wanted = seatWanted
            seatWanted = null
            boardVehicle(held.vehicle, held.seat)
            // boarding can still refuse — a level cut started, the body is a
            // heap on the floor, they walked off during the round trip. Hand
            // the chair straight back rather than holding one we are not in
            if (!fleet.riding) {
              net?.unseat()
              return
            }
            // and if we were asking for the wheel but were handed the other
            // chair, say so rather than letting the HUD imply we are driving
            if (wanted && wanted.seat !== held.seat) setNotice('someone else is driving')
            return
          }
          if (!held && riding) {
            // ejected: the socket dropped and came back, or the server never
            // agreed in the first place
            leaveVehicle()
            return
          }
          if (held && riding) {
            if (held.vehicle !== riding.id) {
              leaveVehicle()
              return
            }
            if (held.seat !== fleet.seat) {
              fleet.takeSeat(held.seat)
              seatNode(riding, held.seat).add(body)
              body.position.set(0, 0, 0)
              body.rotation.set(0, Math.PI, 0)
              setDriving((d) =>
                d
                  ? { ...d, seat: held.seat, crew: crewLabel(riding.id, held.seat), cockpit: fleet.cockpit }
                  : d,
              )
            }
            // the driver got out and left us sitting in a machine nobody is
            // driving. Take the wheel rather than making the passenger climb
            // out and back in through the other door
            const state = fleetNet.vehicles[held.index]
            if (held.seat === SEAT_PASSENGER && state.driver === 0) {
              net?.seat(held.index, SEAT_DRIVER)
            }
          }
        }

        // --- the shared walk --------------------------------------------------
        // Presence, chat and proximity voice, all hanging off the same server
        // the desktop already talks to. Nothing here connects until the player
        // actually stands up, and it is all torn down when they sit back down:
        // a visitor who only ever uses the OS never joins the world at all.
        //
        // The split follows the runtime's rule. The store and the bodies are in
        // src/game/net/ because they are simulation and have to keep working
        // with no browser under them; the socket and the WebRTC mesh are out
        // here because they are neither.
        const remote = createRemoteWorld()
        // ...and the same for the machines. Kept beside the people rather than
        // inside the fleet because it is network state, and the fleet is a
        // renderer-side subsystem that must keep working with no socket at all
        const fleetNet = createRemoteFleet()
        const avatars = createRemoteAvatars(EYE, 34)
        scene.add(avatars.root)
        let net: ReturnType<typeof createWorldNet> | null = null
        let voice: ReturnType<typeof createProximityVoice> | null = null
        let chatKey = 0
        // which spawn offset is ours; the server hands out the lowest free one.
        // -1 is "not told yet", which is not the same as slot 0 (the authored
        // spot): the stand-up can finish before the welcome lands, and treating
        // the two alike latched the scatter off for the whole session
        let spawnSlot = -1
        let scattered = false
        /** the authored spawn we last arrived on, in x/z. Stepping aside is
            only allowed while the player is still standing on it */
        const spawnHome = new THREE.Vector2()
        const avatarEnv: AvatarEnv = {
          // the remote's feet are solved against the ground under *them*
          groundAt: (x, z) => floorOf(levels.current, x, z),
          // re-pointed at the live level every tick, like rigEnv and chaseEnv;
          // the level system is built below this, so it starts out empty
          collision: makeCollisionSet({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
          eyePos: camera.position,
          // anyone sitting in a machine is drawn in it, not at the
          // coordinates their own client is sending
          seatOf: seatFor,
        }

        const pushChat = (line: Omit<ChatLine, 'key'>) =>
          setChat((prev) => [...prev, { ...line, key: chatKey++ }].slice(-CHAT_KEEP))

        const syncVoice = () => {
          if (!voice) return
          setVoiceHud({
            available: voice.available,
            enabled: voice.enabled,
            mode: voice.mode,
            speaking: voice.speaking,
            peers: voice.peerCount,
            error: voice.error,
          })
        }

        const joinWorld = () => {
          if (net || !worldConfigured()) return
          // The room is walkable long before the desktop has been logged into
          // — that is the whole of the /room entrance — so an absent session
          // is a guest, not a reason to stay out of the world. The server
          // mints the guest-xxxx name, exactly as it does for the arcade.
          const who = sessionRef.current ?? { kind: 'guest' as const, name: '' }
          net = createWorldNet({
            session: who,
            level: levels.current.id,
            onStatus: (status) => setMp((m) => ({ ...m, status })),
            onMessage: (msg) => {
              switch (msg.type) {
                case 'world-welcome':
                  remote.welcome(msg.you, msg.tick, msg.players)
                  fleetNet.setSelf(msg.you)
                  fleetNet.setTick(msg.tick)
                  // where the machines actually are. Placed, not interpolated
                  // — there is no history to interpolate from, and the car may
                  // be two kilometres from where our own spawn put it
                  if (msg.vehicles) {
                    fleetNet.place(msg.vehicles)
                    placeFleetFromNet()
                  }
                  if (msg.seats) fleetNet.seats(msg.seats)
                  // a reconnect arrives with a fresh id and an old body: if we
                  // are still sitting in something, ask for the chair back
                  if (fleet.riding) {
                    const idx = WIRE_VEHICLES.indexOf(fleet.riding.id)
                    if (idx >= 0) net?.seat(idx, fleet.seat)
                  } else {
                    applySeats()
                  }
                  spawnSlot = msg.slot ?? 0
                  // the welcome usually lands mid stand-up, in which case the
                  // glide's own handoff does this; if it arrives late we step
                  // aside here instead — but never once the player has walked
                  stepAside()
                  track('world_joined', { players: msg.players.length })
                  break
                case 'world-enter':
                  remote.enter(msg.player)
                  pushChat({
                    name: '', text: `${msg.player.name} is here`,
                    admin: false, mine: false, system: true,
                  })
                  break
                case 'world-exit': {
                  const gone = remote.roster.get(msg.id)
                  remote.exit(msg.id)
                  if (gone) {
                    pushChat({
                      name: '', text: `${gone.name} left`,
                      admin: false, mine: false, system: true,
                    })
                  }
                  break
                }
                case 'world-tick':
                  remote.tick(msg.players, performance.now())
                  if (msg.vehicles) fleetNet.tick(msg.vehicles, performance.now())
                  break
                case 'world-seats':
                  fleetNet.seats(msg.seats)
                  applySeats()
                  break
                case 'world-seat-denied':
                  // somebody was a round trip quicker to the door
                  if (seatWanted) {
                    seatWanted = null
                    setNotice('that seat is taken')
                  }
                  break
                case 'world-chat':
                  pushChat({
                    name: msg.name, text: msg.text,
                    admin: msg.admin, mine: msg.id === remote.you,
                  })
                  // and over the head that said it, if they are in view
                  avatars.say(msg.id, msg.text)
                  break
                case 'world-signal':
                  voice?.accept(msg.from, msg.data)
                  break
              }
            },
          })
          voice = createProximityVoice({
            self: () => remote.you,
            // read per peer, not captured: a reconnect brings a fresh TURN
            // credential and the old one may already have expired
            ice: () => net?.ice ?? [],
            send: (to, data) => net?.signal(to, data),
            onChange: syncVoice,
          })
          syncVoice()
          sayRef.current = (text) => net?.chat(text)
        }

        const leaveWorld = () => {
          voice?.dispose()
          voice = null
          net?.close()
          net = null
          sayRef.current = null
          spawnSlot = -1
          scattered = false
          seatWanted = null
          remote.clear()
          // and hand the fleet back to local physics: with no socket, every
          // machine is parked or ours, which is where this all started
          fleetNet.clear()
          fleet.setNet(null)
          // one last pass over an empty roster retires every body and its
          // sprites; the avatar system itself outlives a sit-down
          avatars.update(remote, 0, avatarEnv)
          hereNow = 0
          setMp({ status: 'offline', here: 0 })
          setChat([])
          setTyping(false)
          typingRef.current = false
        }

        /** move off the shared spawn tile onto our slot. Only ever fires once,
            only while the player is still standing where they arrived, and
            never mid-cut — walking away first means they chose their spot. */
        const stepAside = () => {
          if (scattered || !fps || levels.frozen || rig.down) return
          if (spawnSlot < 0) return // no slot yet; the welcome calls back
          const level = levels.current
          const here = new THREE.Vector2(camera.position.x, camera.position.z)
          if (here.distanceTo(spawnHome) > 1) {
            scattered = true // they already walked; leave them alone
            return
          }
          scattered = true
          if (spawnSlot === 0) return // nobody else here: the authored spot
          const spot = spawnSpotFor(level, spawnHome.x, spawnHome.y)
          // the boom writes back the head position it saved last frame, so a
          // teleport it has not been told about is undone one frame later
          chase.drop()
          walk.teleport(spot.x, spot.z, spawnY(level, spot.x, spot.z))
          rig.reset()
          rig.face(walk.yaw)
          poseBody()
        }

        const openChat = () => {
          if (typingRef.current) return
          typingRef.current = true
          setTyping(true)
          input.clearKeys() // nothing stays latched while the line has the keys
          requestAnimationFrame(() => chatInputRef.current?.focus())
        }

        const setPauseNow = (on: boolean) => {
          if (pausedNow === on) return
          pausedNow = on
          // an engine is the first sound in this project that does not stop by
          // itself, so the menu has to say so — a paused world that is still
          // idling underneath reads as the game having hung
          fleet.setMuted(on)
          if (on) {
            input.clearKeys() // nothing stays latched under the menu
            // esc is spent on the pointer unlock before the composer ever sees
            // it, so the pause is also how a chat line gets abandoned
            typingRef.current = false
            setTyping(false)
            // and while it is up, the menu lists where the machines are — a
            // boat two kilometres away is otherwise something you have to
            // remember rather than something you can look up
            setFleetWhere(
              fleet.all.map((v) => ({
                id: v.id,
                label: v.label,
                ...fleet.where(v.id, camera.position),
              })),
            )
          }
          setPaused(on)
        }

        const input = createRoamInput({
          dom: webgl.domElement,
          isActive: () => roaming,
          isLive: () => fps,
          isPaused: () => pausedNow,
          isTyping: () => typingRef.current,
          // at the wheel the mouse belongs to the drive camera. Left wired to
          // walk.turn it would silently spin the suspended walker's heading
          // and stand you down facing somewhere you never looked
          onTurn: (dx, dy, sign) =>
            fleet.riding
              ? fleet.turn(dx, dy, sign, prefsRef.current.sens)
              : walk.turn(dx, dy, sign, prefsRef.current.sens),
          // E: get out of whatever you are in, else the machine's prompt, else
          // a door's, else climb into whatever is parked in front of you
          onUse: () => {
            if (fleet.riding) {
              leaveVehicle()
              return true
            }
            if (nearNow) {
              interactRef.current()
              return true
            }
            if (doorVerbNow) {
              if (!house.useDoor(headPos, headDir)) outside.useDoor(headPos, headDir)
              return true
            }
            if (vehicleNow) {
              enterVehicle(vehicleNow.id, vehicleNow.seat)
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
          levels: makeHomeLevels(house, outside, backrooms, obstacles),
          home: 'overworld',
          onCover: (on) => {
            blackout.style.transition = on ? 'opacity 130ms' : 'opacity 650ms'
            blackout.style.opacity = on ? '1' : '0'
          },
          onCutStart: () => {
            walk.haltPlanar()
            backrooms.noclipSound()
            // the noclip cut is the one way out of a machine that does not go
            // through leaveVehicle: the fleet lives in the overworld, and the
            // server frees the chair on the level change anyway
            seatWanted = null
            net?.unseat()
          },
          onSwapped: (level, spawn) => {
            walk.resetMotion()
            // everyone else is scoped by level, so the swap has to be
            // announced: until it is, we are still drawing the crowd we just
            // walked away from, and they are still drawing us
            net?.setLevel(level.id)
            rig.reset() // a ragdoll must not straddle a level swap
            rig.face(spawn.yaw)
            chase.drop()
            // a seam drops everyone on one tile too, so the same offset
            // applies — here it can be baked straight into the arrival
            spawnHome.set(spawn.x, spawn.z)
            scattered = true
            const spot = spawnSpotFor(level, spawn.x, spawn.z)
            walk.spawnAt(spot.x, spot.z, spawn.yaw, spawnY(level, spot.x, spot.z))
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
        const applyLight = (at: THREE.Vector3 = camera.position) => {
          const sky = outside.update(at)
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
          // the fleet's paintwork has no lights of its own: what it reflects
          // is a painted equirect sky repainted off these same numbers, and
          // its headlamps and nav lights come up with the dusk
          fleet.setDay(sky.day, sky.night, sky.fogColor, sky.sunEl)
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
        // tell the warp tunnel it can open its exit, and where the glass sits
        // on the viewport so the mouth tears open right on the machine. Must
        // fire on the first real frame whichever way we got here — a room
        // entrance skips the intro, and a tunnel left holding never opens.
        const announce = () => {
          if (announced) return
          announced = true
          // whatever is covering the boot can go: this is the first frame
          stageRef.current?.(null)
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
          announce() // first real frame is up
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

        /*
          The driving frame.

          Deliberately short: the fleet's own tick does the physics (in fixed
          slices, not this frame's dt), places the camera and makes the noise,
          so what is left here is everything that is true whichever way the
          player is getting around — the world's pulse, the shadow flags, the
          crowd, and the HUD.

          The one piece of housekeeping worth naming is the walker. It keeps
          existing while you drive; it is simply parked at the machine every
          frame. That is what makes a dismount land in the right place, what
          keeps the level system's idea of where you are honest, and what stops
          `stopRoam` (which snaps the walker home) from disagreeing with a car
          that drove two kilometres.
        */
        const gaugeNow = { speed: -1, load: 0, altitude: -1, gear: -1 }

        const driveTick = (now: number, dt: number) => {
          const v = fleet.riding
          if (!v) return
          const driver = fleet.seat === SEAT_DRIVER
          const level = levels.current
          // the cut state machine still has to run — but no seam may fire at
          // the wheel, so it is never handed a live flag
          seamPt.set(v.root.position.x, v.root.position.y, v.root.position.z)
          levels.tick(now, seamPt, false)
          // park the walker on the machine (see the header) — and do it *here*,
          // before the fleet tick, because the walk controller's rig is the
          // camera itself. Parked afterwards, the teleport threw the lens back
          // to the machine's own origin at eye height every single frame: you
          // sat on the car's centreline looking over its bonnet, or inside the
          // helicopter's cabin at eighty units up, with the drive camera doing
          // its work and being overwritten a few lines later. The boom writes
          // the camera last and nothing after it may touch the position
          const feet = v.root.position.y
          walk.teleport(v.root.position.x, v.root.position.z, feet)
          walk.yaw = v.yaw
          syncFleetNet(now)
          const fs = fleet.tick({
            dt,
            keys: input.keys,
            frozen: pausedNow || levels.frozen,
            env: aimFleetEnv(level),
            camera,
            fovBase: prefsRef.current.fov,
            playerPos: v.root.position,
            outdoors: level.id === 'overworld',
          })
          // v swaps the boom for the cockpit. It is not the walk's saved
          // third-person preference — a car has two views and neither is the
          // one the pause menu's toggle means
          const vNow = input.keys.has('KeyV')
          if (vNow && !vHeld && !pausedNow) {
            fleet.toggleView()
            // A cockpit lens sits at the avatar's face. Hide the body in that
            // view so its head cannot occlude the windscreen; chase view shows
            // the complete seated player.
            body.visible = !fleet.cockpit
            setDriving((d) => (d ? { ...d, cockpit: fleet.cockpit } : d))
          }
          vHeld = vNow
          xHeld = input.keys.has('KeyX')
          level.update(dt, camera.position)
          // the machine is now the moving caster, and `step.moved` — which
          // gates the whole hand-baked shadow regime — comes from a walk
          // controller that is not running. The fleet reports its own
          if (level.id === 'overworld' && fs.moved) {
            if (camera.position.z < 15.5) pendant.shadow.needsUpdate = true
            if (camera.position.z < 7) key.shadow.needsUpdate = true
            house.flagShadows(camera.position)
            if (outside.sun.shadow.intensity > 0.001) outside.sun.shadow.needsUpdate = true
          }
          // everyone else. Kept in step with the walking branch below by hand:
          // both say where we are and play the others back, they just disagree
          // about what "we" is standing on
          if (net) {
            net.move(
              v.root.position.x, feet, v.root.position.z,
              v.yaw, 0, 0,
              packPose({
                grounded: fs.altitude < 1,
                run: false,
                crouch: false,
                swimming: false,
                speaking: Boolean(voice?.speaking),
                down: false,
              }),
            )
            // ...and the machine, but only if we are the one steering it. A
            // passenger reporting the vehicle's transform would be a second
            // opinion the server is right to ignore, and sending it anyway is
            // a packet a second per passenger for nothing
            if (driver) {
              const idx = WIRE_VEHICLES.indexOf(v.id)
              if (idx >= 0) {
                net.vehicle(
                  idx,
                  v.root.position.x, v.root.position.y, v.root.position.z,
                  v.yaw, v.pitch, v.roll,
                )
              }
            }
            remote.sample(now, dt)
            avatarEnv.collision = level.collision
            avatarEnv.ceilingY = level.ceilingY
            avatars.update(remote, dt, avatarEnv)
            voice?.update(remote.players, camera, dt)
            if (remote.players.size !== hereNow) {
              hereNow = remote.players.size
              setMp((m) => ({ ...m, here: hereNow }))
            }
          }
          // the instrument readout, rounded before it is mirrored: at full
          // precision this re-renders the whole component every frame
          const sp = Math.round(Math.abs(fs.speed) * 1.44) // units/s -> km/h
          const alt = Math.round(fs.altitude)
          if (sp !== gaugeNow.speed || alt !== gaugeNow.altitude || fs.gear !== gaugeNow.gear) {
            gaugeNow.speed = sp
            gaugeNow.altitude = alt
            gaugeNow.gear = fs.gear
            gaugeNow.load = fs.load
            setGauge({ speed: sp, load: fs.load, altitude: alt, gear: fs.gear })
          }
          // at the wheel, the body worth probing is the machine's
          debugTick(level, v.root.position.x, feet, v.root.position.z)
          render()
          raf = requestAnimationFrame(walkTick)
        }

        const walkTick = (now: number) => {
          if (disposed || !roaming) return
          const rawMs = now - lastT
          const dt = Math.min(0.05, rawMs / 1000)
          lastT = now
          // frame-time governor: a smoothed frame cost over ~22ms means the
          // GPU can't keep up at this resolution, so shed a pixel-ratio step.
          // How big a step is how far over budget it is: a retina panel
          // starting at 2 and stepping down an eighth of a second at a time
          // spent six seconds visibly struggling before it found the ratio it
          // was always going to end at, which is most of a first impression
          emaMs = emaMs * 0.93 + Math.min(100, rawMs) * 0.07
          prWait -= rawMs / 1000
          if (prWait <= 0 && emaMs > 22 && pr > 1) {
            pr = Math.max(1, pr - (emaMs > 45 ? 0.5 : 0.25))
            webgl?.setPixelRatio(pr)
            prWait = 1.2
          }
          /*
            At the wheel this loop is a different loop.

            The walk controller, the chase boom, the player's body, the
            footstep voicing and the seam test are all suspended — there is no
            walker to integrate, and every one of them would be reading a
            position that no longer means anything. What is left is the fleet's
            own tick (which owns the lens for the duration), the level's pulse,
            the shadow flags and the network. It returns early rather than
            threading a `driving` flag through two hundred lines of walk code.
          */
          if (fleet.riding) {
            driveTick(now, dt)
            return
          }
          syncFleetNet(now)
          // the boom hands the camera back to the head before anything reads
          // or integrates it; it takes it again just before render below
          chase.restore(camera)
          // seams and the noclip cut: stepping into the doctored wall span
          // freezes the walk and cuts to black; the level system swaps the
          // worlds under the cover (no seams during the stand-up glide)
          // the seam test gets the feet: its predicates are planar today, but
          // walking a furniture top past the doctored wall span shouldn't
          // noclip you into level 0 from head height
          seamPt.set(camera.position.x, walk.feetY, camera.position.z)
          levels.tick(now, seamPt, fps)
          const level = levels.current
          const step = walk.update({
            dt,
            keys: input.keys,
            // a downed body forfeits movement until it has stood back up
            frozen: levels.frozen || rig.down,
            groundY: level.groundY,
            groundAt: level.groundYAt,
            ceilingY: level.ceilingY,
            waterY: level.waterY,
            collision: level.collision,
            fovBase: prefsRef.current.fov,
          })
          // the sim reports footfalls and touchdowns; the level says what is
          // underfoot (the backrooms are carpet wall to wall), and crouched
          // steps land softer. Outdoors the answer has two owners: the house
          // speaks for its own property — planks, porch slab, front walk,
          // lawn — and the open world for everything past the fence
          if (step.footfall || step.landing > 3) {
            const px = camera.position.x
            const pz = camera.position.z
            const surface =
              level.id !== 'overworld'
                ? 'carpet'
                : step.wet > 0.12
                  ? 'water'
                  : outside.onProperty(px, pz)
                    ? house.surfaceAt(px, pz)
                    : outside.surfaceAt(px, pz)
            if (step.landing > 3) landThump(surface, Math.min(1, (step.landing - 3) / 14))
            else footstep(surface, step.gait * (1 - walk.crouchK * 0.65), step.run)
          }
          // the view is a saved preference the pause menu also owns, so the
          // boom just follows it and v flips it; x flops — and once the
          // ragdoll settles, x or any move key stands back up
          chase.third = prefsRef.current.third
          const vNow = input.keys.has('KeyV')
          if (vNow && !vHeld && !levels.frozen) setPrefs((p) => ({ ...p, third: !p.third }))
          vHeld = vNow
          const xNow = input.keys.has('KeyX')
          const wantsUp =
            rig.ragdolling &&
            rig.settled &&
            ((xNow && !xHeld) ||
              ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].some((k) => input.keys.has(k)))
          if (xNow && !xHeld && !rig.down && !levels.frozen) {
            // thrown with the walk's momentum plus a hop so it always tumbles
            rig.flop(step.vx, step.vy + 1.6, step.vz)
          } else if (wantsUp) {
            // stand up where the body came to rest: move the walker there
            // first so the recovery blend is fitted against the new frame
            rig.getupSpot(getupPt)
            // a body that came to rest on the sofa stands up on the sofa:
            // the tallest surface under its pelvis, not the level floor
            walk.teleport(
              getupPt.x,
              getupPt.z,
              supportY(
                getupPt.x, getupPt.z, getupPt.y,
                level.collision, floorOf(level, getupPt.x, getupPt.z),
              ),
            )
            poseBody()
            rig.beginRecover()
          }
          xHeld = xNow
          // t opens the chat line, m arms the microphone, n swaps the talk
          // mode, and b is held to push to talk. Same edge-detect as v and x
          const tNow = input.keys.has('KeyT')
          if (tNow && !tHeld && net && !levels.frozen) openChat()
          tHeld = tNow
          const mNow = input.keys.has('KeyM')
          if (mNow && !mHeld && voice?.available) {
            const arming = !voice.enabled
            void voice.toggle().then(() => {
              if (arming && voice?.enabled) track('world_voice')
            })
          }
          mHeld = mNow
          const nNow = input.keys.has('KeyN')
          if (nNow && !nHeld && voice?.enabled) voice.cycleMode()
          nHeld = nNow
          voice?.setPushing(input.keys.has('KeyB'))
          // the body plants its feet under the camera and faces the walk
          // (or hangs from it, mid-hop) — unless the ragdoll owns it
          if (!rig.ragdolling) poseBody()
          rigPose.dt = dt
          rigPose.gait = step.gait
          rigPose.crouchK = walk.crouchK
          rigPose.grounded = step.grounded
          rigPose.run = step.run
          rigPose.yaw = walk.yaw
          rigPose.pitch = walk.pitch
          rigPose.vx = step.vx
          rigPose.vz = step.vz
          rigPose.vy = step.vy
          rigPose.landing = step.landing
          // same factor as poseBody's trailing offset: a crushed boom means
          // the lens is back on the head, so the flair fades out with it
          rigPose.show = Math.min(1, chase.dist / 1.2)
          // the ragdoll and the boom both work in a few units around the
          // body, so one terrain sample under it is the floor for both —
          // they never need the whole heightfield, only the local plane
          const localFloor = floorOf(level, camera.position.x, camera.position.z)
          rigEnv.groundY = localFloor
          rigEnv.ceilingY = level.ceilingY
          rigEnv.collision = level.collision
          rig.update(rigPose, rigEnv)
          // --- everyone else ------------------------------------------------
          // Say where we are, play the others back a couple of ticks in the
          // past, and put their voices where their bodies ended up. All of it
          // runs while the camera is still the head: the boom only borrows it
          // further down, and a listener parked on the boom would hear the
          // world from somewhere behind your own back.
          if (net) {
            net.move(
              camera.position.x,
              walk.feetY,
              camera.position.z,
              walk.yaw,
              walk.pitch,
              step.gait,
              packPose({
                grounded: step.grounded,
                run: step.run,
                crouch: step.duck,
                swimming: step.swimming,
                speaking: Boolean(voice?.speaking),
                down: rig.down,
              }),
            )
            remote.sample(now, dt)
            avatarEnv.collision = level.collision
            avatarEnv.ceilingY = level.ceilingY
            avatars.update(remote, dt, avatarEnv)
            voice?.update(remote.players, camera, dt)
            if (remote.players.size !== hereNow) {
              hereNow = remote.players.size
              setMp((m) => ({ ...m, here: hereNow }))
            }
          }
          // doors easing upstairs, chunks streaming below — whichever side
          // the player is on, both worlds keep their pulse
          level.update(dt, camera.position)
          // the player is the only moving shadow caster: re-bake just the
          // lights that can see them, only on frames where they moved (the
          // rig speaks up for motion the walker can't see: ragdoll, springs)
          const bodyMoved = step.moved || rig.unrest()
          if (level.id === 'overworld' && bodyMoved) {
            // generous regions: a map must keep re-baking until the player is
            // fully out of its light's frustum, or their shadow strands there
            if (camera.position.z < 15.5) pendant.shadow.needsUpdate = true
            if (camera.position.z < 7) key.shadow.needsUpdate = true
            house.flagShadows(camera.position)
            // The sun's program stays invariant now, but its hand-managed map
            // still follows a genuinely moving caster. This is the ordinary
            // warmed draw, not a shader-mode switch at the front door.
            if (outside.sun.shadow.intensity > 0.001) outside.sun.shadow.needsUpdate = true
          }
          // close to the tube and facing it: offer the interact prompt
          toScreen.subVectors(gCenter, camera.position)
          const dist = toScreen.length()
          camera.getWorldDirection(gazeVec)
          // still the head here — chase.apply() only borrows the camera below
          headPos.copy(camera.position)
          headDir.copy(gazeVec)
          // no prompts while the body is a heap on the floor
          const isNear = !rig.down && dist < 3.4 && gazeVec.dot(toScreen.normalize()) > 0.35
          if (isNear !== nearNow) {
            nearNow = isNear
            setNear(isNear)
          }
          // a door in reach offers its own prompt; the machine's wins (and
          // level 0 has no doors, whatever its x/z coordinates suggest).
          // The house answers first, then the town's shop doors
          const verb =
            isNear || rig.down || level.id !== 'overworld'
              ? null
              : house.doorPrompt(camera.position, gazeVec) ??
                outside.doorPrompt(camera.position, gazeVec)
          if (verb !== doorVerbNow) {
            doorVerbNow = verb
            setDoorVerb(verb)
          }
          // the fleet still ticks while you are on foot: a parked machine has
          // to settle onto the ground it is standing on, keep its collision box
          // under the walker's shoulder, and offer its prompt when you get
          // close. Everything past SIM_RANGE it skips on its own
          const fs = fleet.tick({
            dt,
            keys: input.keys,
            frozen: levels.frozen || pausedNow,
            env: aimFleetEnv(level),
            camera,
            fovBase: prefsRef.current.fov,
            playerPos: camera.position,
            outdoors: level.id === 'overworld',
          })
          // ...and its prompt is the lowest-priority one: the machine and a
          // door both win, because both are things you are standing right at
          const atVehicle =
            isNear || verb || rig.down || levels.frozen ? null : fs.prompt
          // "drive" when the wheel is free, "ride" when it is not: the prompt
          // is the only warning that somebody else is already in there
          const atVerb = atVehicle
            ? fs.promptSeat === SEAT_DRIVER
              ? atVehicle.verb
              : 'ride in'
            : null
          if (
            (atVehicle ? atVehicle.id : null) !== (vehicleNow && vehicleNow.id) ||
            atVerb !== (vehicleNow && vehicleNow.verb)
          ) {
            vehicleNow = atVehicle
              ? {
                  id: atVehicle.id,
                  label: atVehicle.label,
                  verb: atVerb ?? atVehicle.verb,
                  seat: fs.promptSeat,
                }
              : null
            setVehiclePrompt(vehicleNow && { label: vehicleNow.label, verb: vehicleNow.verb })
          }
          // every gameplay read above used the head; only now does the boom
          // borrow the camera (third person, or orbiting a downed body)
          chaseEnv.collision = level.collision
          chaseEnv.groundY = localFloor
          chaseEnv.ceilingY = level.ceilingY
          chaseEnv.yaw = walk.yaw
          chaseEnv.pitch = walk.pitch
          chaseEnv.focus = rig.ragdolling ? rig.focus(focusPt) : null
          chase.apply(camera, dt, chaseEnv)
          debugTick(level, camera.position.x, walk.feetY, camera.position.z)
          render()
          raf = requestAnimationFrame(walkTick)
        }

        /*
          The world the walk will eventually be handed, built while there is
          still a cover over the scene's very first frame.

          Two inner rings is what prime has always guaranteed; the extra
          budget buys as much of the outer ones as it can, because the frame
          budget's alternative is to dribble them out at two milliseconds a
          frame into the face of somebody who already has the controls. This
          covered pass guarantees that first ring before either entrance draws
          its first visible frame.

          It deliberately does *not* try to force the first *draw* of the
          chunks. That was tried: a one-pixel viewport swept through four
          headings so every chunk crossed a frustum once. It works, and it is
          a bad trade — three.js reads a program's uniform structure on first
          use, which blocks on the driver finishing the link, so the sweep
          pulled nearly four seconds of shader setup into one lump to avoid a
          hitch that measures a tenth of a second. Let the frustum do its job.

          The sun's shadow is the exception, and it is worth the paragraph.

          The old sky switched `castShadow` itself at the indoor and daylight
          thresholds. That changed every lit surface's shader configuration;
          the front door or the first sunset could therefore ask the driver to
          link nineteen programs in one frame, measured at 2.8 seconds. The
          flag is now stable and only a uniform strength changes, but the
          depth half of the shader pile still needs one real draw up front.

          So compile the sun-lit surface variants asynchronously, then do one
          render with the sun map flagged into a one-pixel viewport. The depth
          programs only exist when Three performs a real shadow pass, so
          compileAsync alone cannot cover them. The car's two headlight spots
          are the other thresholded program layout: expose them at zero
          intensity for a second compile and the first dusk can reuse that
          cached variant instead of linking the whole lit world in one frame.
          It is the same total cost either way — the only choice is whether it
          is paid behind the boot cover or in someone's face on the doorstep.
        */
        const warmCam = new THREE.PerspectiveCamera(110, 1, 0.1, 900)
        const warmSize = new THREE.Vector2()
        /** the fleet is put down once during the covered warm-up and stays
            where the player leaves it for the rest of the session */
        let fleetPlaced = false
        const warmForRoam = async (at: THREE.Vector3) => {
          outside.prime(at.x, at.z, 200)
          if (!webgl || !scene) return
          // Constructors leave all three machines at (0,0,0), hidden by the
          // fleet root. Terrain and collision now exist, so place them before
          // compiling or drawing anything the player can later meet outside.
          if (!fleetPlaced) {
            fleetPlaced = true
            fleet.spawnAll(aimFleetEnv(levels.current))
            // the welcome can beat the warm-up: if the server already told us
            // where the machines are, spawnAll has just put them back on the
            // home spots and this puts them where they really are
            placeFleetFromNet()
          }
          // Stand at the actual front door, not at the bedroom spawn's x. The
          // exact live lighting state and caster set at this threshold are the
          // things this warm-up exists to pay for.
          warmCam.position.set(FRONT_DOOR_X, at.y, HOUSE.minZ - 1.25)
          warmCam.rotation.set(0, 0, 0)
          warmCam.updateMatrixWorld(true)
          // This render bypasses render()'s light pass, so compose the day
          // cycle at the warm camera. That also anchors the hand-managed sun
          // map here, letting the first real doorway frame reuse it.
          applyLight(warmCam.position)
          try {
            // The initial compile ran before the streamed chunks existed.
            // Compile their live outdoor lighting variant now; the promise
            // lets the driver link in
            // parallel while BootCover continues animating on the compositor.
            await webgl.compileAsync(scene, warmCam).catch(() => {})
            if (disposed || !webgl || !scene) return
            // At dusk the car adds two visible SpotLights. Their count is a
            // shader define, so compile and first-draw that layout now while
            // BootCover still owns the screen. The helper restores the live
            // day-cycle visibility even if compilation or teardown interrupts.
            fleet.setLightWarmup(true)
            try {
              await webgl.compileAsync(scene, warmCam).catch(() => {})
              if (disposed || !webgl || !scene) return
              webgl.getSize(warmSize)
              webgl.setScissorTest(true)
              webgl.setScissor(0, 0, 1, 1)
              webgl.setViewport(0, 0, 1, 1)
              outside.sun.shadow.needsUpdate = true
              webgl.render(scene, warmCam)
            } finally {
              fleet.setLightWarmup(false)
            }
          } finally {
            if (webgl) {
              webgl.setScissorTest(false)
              webgl.setViewport(0, 0, warmSize.x, warmSize.y)
            }
          }
        }

        const startRoam = (instant = false, spawnShadowsReady = false) => {
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
          // announce ourselves while the stand-up glide plays, so the roster
          // and the first snapshots have landed by the time the controls do
          joinWorld()
          // push back from the desk and rise to standing height: kept short,
          // lingering here made standing up feel mushy. The /room entrance
          // never sat down, so it opens standing instead of gliding up out
          // of a chair nobody watched it push back from
          const s0 = performance.now()
          const from = camera.position.clone()
          const standTick = () => {
            if (disposed || !roaming) return
            const t = instant ? 1 : Math.min(1, (performance.now() - s0) / 620)
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
              rig.face(aim.yaw)
              poseBody()
              // the chair is one tile and everyone stands up out of it
              spawnHome.set(SPAWN.x, SPAWN.z)
              scattered = false
              stepAside()
              body.visible = true
              // A direct /room boot baked this exact body pose into the local
              // maps under BootCover. Other entrances warmed the shader but
              // not the shadow itself, because an invisible person must not
              // leave a silhouette beside the desk during the intro.
              if (!spawnShadowsReady) {
                if (camera.position.z < 15.5) pendant.shadow.needsUpdate = true
                if (camera.position.z < 7) key.shadow.needsUpdate = true
                house.flagShadows(camera.position)
              }
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
          // sitting back down leaves the world: the socket closes, the bodies
          // are retired, and the microphone is released rather than left live
          // behind a desktop that gives no sign it is on
          leaveWorld()
          input.clearKeys()
          // out of whatever you were driving first: the engine has to stop,
          // and `levels.reset()` below hauls the walker home whether or not a
          // car came with it
          // sleep() can dismount without going through leaveVehicle(); detach
          // the shared avatar first so the next walk does not inherit a seat's
          // local coordinate system.
          scene?.add(body)
          fleet.sleep()
          walk.resetMotion()
          rig.reset()
          chase.drop() // the sit-down glide starts from wherever the lens is
          // sitting down (or leaving) always hauls you back through the
          // seam first, so the chair never has to fly up from level 0
          const homed = levels.reset()
          if (homed) {
            walk.spawnAt(
              homed.spawn.x, homed.spawn.z, walk.yaw,
              spawnY(homed, homed.spawn.x, homed.spawn.z),
            )
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
          vehicleNow = null
          setWalking(false)
          setNear(false)
          setDoorVerb(null)
          setVehiclePrompt(null)
          setDriving(null)
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
          if (!house.useDoor(headPos, headDir)) outside.useDoor(headPos, headDir)
        }
        enterRef.current = () => {
          if (vehicleNow) enterVehicle(vehicleNow.id)
        }
        leaveRef.current = () => leaveVehicle()
        // the pause menu's vehicle list: where each machine is, and the way
        // out of having stranded one. A recall is not a teleport for the
        // player — it puts the machine on the nearest place it can legally
        // stand (or float), which is why the boat refuses inland
        fleetRef.current = {
          where: () =>
            fleet.all.map((v) => ({
              id: v.id,
              label: v.label,
              ...fleet.where(v.id, camera.position),
            })),
          recall: (id) => {
            const ok = fleet.recall(id, camera.position, aimFleetEnv(levels.current))
            setFleetWhere(fleetRef.current?.where() ?? [])
            return ok
          },
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
          stopRoam() // which also leaves the world and drops the microphone
          avatars.dispose()
          input.dispose()
          prevCleanup?.()
        }

        // Lift-off waits for the complete scene, not merely the desk shell.
        // This is intentionally the one non-progressive part of the room: a
        // late model can introduce another cold shadow-depth variant, and the
        // first place it gets drawn is the front door. The tunnel and
        // BootCover are still holding, so downloads, the outdoor sun pass and
        // the first buffer uploads all finish before a gameplay frame exists.
        void firstCompile.then(async () => {
          if (disposed || roaming || leaving) return
          /*
            Arriving already roaming (the /room entrance) means nobody is
            watching a machine boot, so the intro flight is skipped outright
            rather than flown only to walk away from.

            It used to open parked at the desk and glide up from there, on
            the theory that the glide reads as pushing your chair back. It
            doesn't — on this route the tube is dark and the park is nose to
            glass, so the first thing the visitor sees is a black rectangle
            filling the lens, held for however long the shadow bake and the
            world's first ring take. Standing is the honest opening: the
            camera is at eye height and the outer rings are in before the
            first frame is drawn.
          */
          const straightToRoom = roamPropRef.current
          camera.position.copy(straightToRoom ? SPAWN : camStart)
          camera.lookAt(front)
          if (straightToRoom) {
            roomLight(1) // no chair to rise from, so no ramp to rise with
          }
          // The property models used to attach after the intro. That left
          // their sun-depth variants outside the covered warm-up and made a
          // fast /room arrival capable of meeting them for the first time at
          // the doorstep. Finish the small model batch here instead.
          const entries = await housePromise
          if (disposed || !webgl || !scene || roaming || leaving) return
          const models: HouseModels = { plant, mug }
          for (const e of entries) if (e) models[e[0]] = e[1]
          house.furnish(models)
          disposer.textures.forEach((texture) => webgl?.initTexture(texture))

          // Make the player part of the covered shader warm-up too. Each body
          // mesh opts out of frustum culling, so the outdoor pass compiles its
          // surface and depth variants even though the warm camera faces away.
          // On /room, keep it visible through the local bake: those maps then
          // already contain the exact body pose the first live frame reveals.
          const spawnAim = lookAngles(SPAWN, front)
          walk.spawnAt(
            SPAWN.x, SPAWN.z, spawnAim.yaw,
            spawnY(levels.current, SPAWN.x, SPAWN.z),
          )
          walk.pitch = spawnAim.pitch
          rig.reset()
          rig.face(spawnAim.yaw)
          poseBody()
          body.visible = true
          await warmForRoam(SPAWN)
          if (disposed || !webgl || !scene || roaming || leaving) return

          if (!straightToRoom) body.visible = false
          await bakeShadowsCovered(() => disposed || roaming || leaving)
          if (disposed || !webgl || !scene || roaming || leaving) return
          // startRoam reveals it only after the stand-up frame. Keeping it
          // live for the readiness render would put the still-visible head
          // around the first-person camera while BootCover fades.
          body.visible = false

          // walk.spawnAt above borrowed the live camera while posing the body;
          // put the lens back on the entrance before the first visible frame.
          camera.position.copy(straightToRoom ? SPAWN : camStart)
          camera.lookAt(front)
          render()
          announce()
          if (straightToRoom) {
            startRoam(true, true)
            return
          }
          t0 = performance.now()
          raf = requestAnimationFrame(introTick)
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
      fleetRef.current = null
      enterRef.current = null
      leaveRef.current = null
      disposeFleet?.()
      disposeFleet = null
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
          {!locked
            ? 'wasd to move · click to grab the mouse · esc to leave'
            : driving
              ? // the controls change with the medium, so the line does too:
                // a helicopter has a collective where a car has a handbrake.
                // A passenger has none of them, and saying so is kinder than
                // letting them press W and conclude the game is broken
                driving.seat !== 0
                ? `along for the ride · v ${driving.cockpit ? 'chase' : 'cockpit'} · e out · esc pauses`
                : `${DRIVE_KEYS[driving.id]} · v ${driving.cockpit ? 'chase' : 'cockpit'} · e out · esc pauses`
              : `wasd move · space jump · shift run · ctrl crouch · v camera · x flop${
                  mp.status === 'live' ? ' · t chat · m mic' : ''
                } · esc pauses`}
        </p>
      )}
      {/* the instrument panel. Deliberately the same quiet mono the rest of
          the HUD is in — a chrome speedometer over this world would be a
          different game's furniture */}
      {roam && walking && !paused && driving && (
        <div className="pointer-events-none absolute right-5 bottom-11 z-10 text-right font-mono">
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="text-[26px] leading-none text-stone-200 tabular-nums">
              {gauge.speed}
            </span>
            <span className="text-[11px] text-stone-500">km/h</span>
          </div>
          <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-stone-500">
            {driving.id === 'car' && gauge.gear !== 0 && (
              <span>{gauge.gear < 0 ? 'R' : `gear ${gauge.gear}`}</span>
            )}
            {driving.id === 'heli' && <span>{gauge.altitude} up</span>}
            <span className="text-stone-600">{driving.label}</span>
            {/* which chair, but only when it is not the obvious one: a lone
                driver does not need telling that they are driving */}
            {driving.seat !== 0 && <span className="text-stone-500">{driving.crew}</span>}
          </div>
          {/* a bar rather than a rev counter: it reads at a glance and it is
              the same number the engine note is riding */}
          <div className="mt-1.5 ml-auto h-[3px] w-24 overflow-hidden rounded-full bg-stone-800">
            <div
              className="h-full rounded-full bg-stone-400 transition-[width] duration-100"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, gauge.load)) * 100)}%` }}
            />
          </div>
        </div>
      )}
      {notice && (
        <p className="pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[12px] text-stone-300 backdrop-blur-sm">
          {notice}
        </p>
      )}
      {/* the shared walk's rail: who is here, what they said, and whether the
          microphone is live. Only ever mounted while actually in the world */}
      {roam && walking && mp.status === 'live' && !paused && (
        <div className="pointer-events-none absolute bottom-4 left-5 z-10 max-w-[min(28rem,52vw)] font-mono">
          <div className="flex items-center gap-2 text-[11px] text-stone-500">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-400/80" />
              {mp.here === 0 ? 'nobody else out here' : `${mp.here} nearby`}
            </span>
            {voiceHud.enabled && (
              <span className={voiceHud.speaking ? 'text-emerald-300' : 'text-stone-500'}>
                · mic {voiceHud.mode === 'ptt' ? '(hold b)' : 'open'}
                {voiceHud.peers > 0 && ` · ${voiceHud.peers} voice`}
              </span>
            )}
            {voiceHud.available && !voiceHud.enabled && <span>· m for voice</span>}
            {voiceHud.error && <span className="text-amber-400/80">· {voiceHud.error}</span>}
          </div>
          {chat.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] leading-snug">
              {chat.map((line) => (
                <li
                  key={line.key}
                  className={line.system ? 'text-stone-600 italic' : 'text-stone-300'}
                >
                  {!line.system && (
                    <span
                      className={
                        line.admin
                          ? 'text-[#c0705c]'
                          : line.mine
                            ? 'text-stone-400'
                            : 'text-sky-300/80'
                      }
                    >
                      {line.name}
                    </span>
                  )}
                  {!line.system && <span className="text-stone-600">: </span>}
                  {line.text}
                </li>
              ))}
            </ul>
          )}
          {typing && (
            <form
              className="pointer-events-auto mt-2 flex items-center gap-2 rounded border border-stone-700 bg-stone-950/85 px-2 py-1 backdrop-blur-sm"
              onSubmit={(e) => {
                e.preventDefault()
                const value = chatInputRef.current?.value ?? ''
                sayRef.current?.(value)
                closeChat()
              }}
            >
              <span aria-hidden className="text-[11px] text-stone-600">
                say
              </span>
              <input
                ref={chatInputRef}
                type="text"
                maxLength={WORLD_MAX_TEXT_LEN}
                autoComplete="off"
                className="w-64 bg-transparent text-[12px] text-stone-200 outline-none placeholder:text-stone-700"
                placeholder="enter sends · esc cancels"
                onKeyDown={(e) => {
                  // the composer owns every key while it is up; without this
                  // the OS shell's window-level handlers see them too
                  e.stopPropagation()
                  if (e.key === 'Escape') closeChat()
                }}
                onBlur={closeChat}
              />
            </form>
          )}
        </div>
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
            <div className="mt-4 text-[11px] text-stone-400">
              <span className="flex justify-between">
                <span>camera</span>
                <span className="text-stone-500">v</span>
              </span>
              <div className="mt-1.5 flex gap-1.5">
                {([false, true] as const).map((third) => (
                  <button
                    key={String(third)}
                    type="button"
                    onClick={() => setPrefs((p) => ({ ...p, third }))}
                    aria-pressed={prefs.third === third}
                    className={`flex-1 cursor-pointer rounded-md border px-2 py-1 text-[11px] transition-colors ${
                      prefs.third === third
                        ? 'border-stone-400 bg-stone-800/70 text-stone-100'
                        : 'border-stone-700 text-stone-500 hover:border-stone-500 hover:text-stone-300'
                    }`}
                  >
                    {third ? 'third person' : 'first person'}
                  </button>
                ))}
              </div>
            </div>
            {/* where the machines are. A fixed fleet in an endless world
                needs this: the boat lives on a coast two and a half
                kilometres out, and without a bearing that is not a
                destination, it is a rumour. "call it over" is the way back
                from having stranded one — it puts the machine on the nearest
                place it can legally stand, which is why the boat refuses
                unless there is water within reach */}
            {fleetWhere.length > 0 && (
              <div className="mt-4 text-[11px] text-stone-400">
                <span className="flex justify-between">
                  <span>vehicles</span>
                  <span className="text-stone-600">e to get in</span>
                </span>
                <ul className="mt-1.5 space-y-1">
                  {fleetWhere.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2">
                      <span className="text-stone-500">
                        {v.label}
                        <span className="ml-1.5 text-stone-600 tabular-nums">
                          {v.dist < 1000
                            ? `${Math.round(v.dist * 0.48)} m`
                            : `${(v.dist * 0.00048).toFixed(1)} km`}{' '}
                          {v.bearing}
                        </span>
                      </span>
                      {v.dist > 80 && !driving && (
                        <button
                          type="button"
                          onClick={() => {
                            if (!fleetRef.current?.recall(v.id)) setNotice(`no room for the ${v.label} here`)
                          }}
                          className="shrink-0 cursor-pointer rounded border border-stone-700 px-1.5 py-0.5 text-[10px] text-stone-500 transition-colors hover:border-stone-500 hover:text-stone-300"
                        >
                          call it over
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <label className="mt-3 block text-[11px] text-stone-400">
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
      {/* the fleet's prompt is last in the stack because it is the one you can
          be standing at while also standing at something else */}
      {roam && walking && !paused && !near && !doorVerb && vehiclePrompt && (
        <button
          type="button"
          onClick={() => enterRef.current?.()}
          className="absolute bottom-14 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[12px] text-stone-300 backdrop-blur-sm transition-colors hover:border-stone-500 hover:text-white"
        >
          <kbd className="mr-2 rounded border border-stone-600 bg-stone-800 px-1.5 py-0.5 text-[10px] text-stone-200">
            E
          </kbd>
          {vehiclePrompt.verb} the {vehiclePrompt.label}
        </button>
      )}
      {roam && walking && !paused && driving && (
        <button
          type="button"
          onClick={() => leaveRef.current?.()}
          className="absolute bottom-14 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[12px] text-stone-300 backdrop-blur-sm transition-colors hover:border-stone-500 hover:text-white"
        >
          <kbd className="mr-2 rounded border border-stone-600 bg-stone-800 px-1.5 py-0.5 text-[10px] text-stone-200">
            E
          </kbd>
          get out
        </button>
      )}
    </div>
  )
}
