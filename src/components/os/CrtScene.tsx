import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js'
import {
  BACK_DOOR_X, buildHouse, CEIL_H, FRONT_DOOR_X, GARAGE, GARAGE_DOOR, HOUSE, insideBy, UP,
} from '../../game/levels/houseWorld'
import { buildOutsideWorld, type OutsideState } from '../../game/levels/outsideWorld'
import { buildBackrooms } from '../../game/levels/backrooms'
import { buildDeskRoom } from '../../game/levels/deskRoom'
import { fleetLevelAt, makeHomeLevels } from '../../game/levels/homeLevels'
import { createLevelSystem } from '../../game/levels/levelSystem'
import type { Level, LevelLightRig } from '../../game/levels/types'
import { buildPaperPlane } from '../../game/props/paperPlane'
import type { HouseModels } from '../../game/levels/houseWorld'
import { CABIN_FIT, buildPlayerBody, type PlayerPose } from '../../game/player/playerBody'
import { packLook, sanitizeLook, unpackLook, type PlayerLook } from '../../game/player/look'
import type { RagdollEnv } from '../../game/player/ragdoll'
import { createChaseCam, SHOULDER, type ChaseEnv } from '../../game/player/chaseCam'
import { createImpactWatch, type Impact } from '../../game/player/impacts'
import {
  MAX_POINTS, bodyExtent, createBodyContact, posedPoints, type BodyExtent, type Bumpable, type Bumper,
  type ContactStep,
} from '../../game/player/bodyContact'
import { createRemoteBumps, createShoveTaker } from '../../game/net/shove'
import { createGrabTaker, createRemoteGrabs } from '../../game/net/grab'
import { createWalkController } from '../../game/player/walkController'
import { createSeating, type Seat } from '../../game/player/seating'
import { toolgunLine } from '../../game/sandbox/tools/toolgunText'
import { facingOf } from '../../game/levels/fittings'
import { buildHouseTv, type TvHandles } from './houseTv'
import { resetPcAudio, setPcListenerDistance } from './pcAudio'
import { createRoamInput } from '../../game/core/input'
import { blockedAt, makeCollisionSet, supportY, syncCollisionSet } from '../../game/physics/collision'
import { createCollisionDebug } from '../../game/physics/collisionDebug'
import { createDisposer } from '../../game/core/disposer'
import { footstep, landThump, spawnPop } from '../../game/core/sfx'
// the registry itself is loaded on demand with the rest of the world; only its
// types are needed up front, and those cost nothing at runtime
import type { FleetEnvQueries, VehicleFleet } from '../../game/vehicles/registry'
import { emptyFleet } from '../../game/vehicles/emptyFleet'
import type { Sandbox } from '../../game/sandbox/sandbox'
import type { PortalMoon, PortalWalk, Toolbelt } from '../../game/sandbox/tools/toolbelt'
import type { PortalHooks } from '../../game/sandbox/tools/portalView'
import type { Portal, PortalColor, PortalCrossing } from '../../game/sandbox/tools/portals'
import type { ToolInput } from '../../game/sandbox/tools/types'
import { createEdges, held, keyHint } from '../../game/sandbox/bindings'
import {
  createConsole, msg as bilingual, say as sayIn, type Console, type Msg, type SandboxHost,
} from '../../game/sandbox/commands'
import { historyOf, labelIn, LOCAL, type History } from '../../game/sandbox/history'
import { createWorldRules } from '../../game/sandbox/rules'
import { GRAVITY } from '../../game/sandbox/physics'
import SandboxConsole, { type FeedLine } from './SandboxConsole'
import Crosshair, { type CrosshairAim } from './Crosshair'
import SpawnMenu, { type CatalogueSource, type OrderLine } from './SpawnMenu'
import { useI18n } from '../../i18n'
import type { NetPose, Vehicle, VehicleId } from '../../game/vehicles/types'
import { classifyGpu, gfx, setGfxTier, type GfxTier } from '../../game/world/quality'
import { createPixelLook, type PixelLook } from '../../game/render/pixelLook'
import { texelateTree } from '../../game/render/texel'
import { BIOME_AIR, airForSky, lightsForSky } from '../../game/render/atmosphere'
import { NEAR_OFF } from '../../game/levels/space'
import { createLampFader, WANT_MAX } from '../../game/render/lampFade'
import { createRemoteWorld } from '../../game/net/remotePlayers'
import { createRemoteAvatars, type AvatarEnv } from '../../game/net/avatars'
import {
  packPose,
  SEAT_DRIVER,
  SEAT_PASSENGER,
  WIRE_VEHICLES,
  WORLD_MAX_TEXT_LEN,
} from '../../game/net/protocol'
import { createWorldEffects } from '../../game/net/worldEffects'
import { createPropNetwork } from '../../game/net/remoteProps'
import { createRemoteFleet } from '../../game/net/remoteVehicles'
import { scatterSpawn } from '../../game/net/spawn'
import { createWorldNet, isMintedName, worldConfigured, type WorldStatus } from './worldNet'
import PauseScreen, { type PersonWhere } from './PauseScreen'
import { PIXEL_LINES_K, PREFS_KEY, detailTier, loadPrefs } from './roamPrefs'
import { snapPixelProofs, type PixelProofs } from './pixelProofs'
import { createProximityVoice, type VoiceMode } from './proximityVoice'
import type { Session } from './osContext'
import { track } from '../../analytics'
import { EmoteWheel, PointMark, type EmoteWheelApi } from './EmoteWheel'
import { EMOTES, WHEEL_DEAD, WHEEL_REACH, wheelSlice } from '../../game/player/emotes'
import { OS_SCENE_READY_EVENT } from '../../events'
import { stopMusic, updateMusic } from '../../game/music'

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
  game/physics/collision, and which world is live (house/yard, the
  backrooms, the Moon, and the noclip cut between them) to game/levels.
  Nothing here asks which level is live: each declares what it has (its
  gravity, a props sandbox and its ground, the fleet, the crowd, the house,
  sky and air), and each level with a sandbox gets its own, which the tool
  belt and the undo stack follow across a cut. The walkTick below is just
  the per-frame conductor calling each in order.

  Every frame of it, room and world alike, is drawn through the pixel look
  (game/render/pixelLook.ts): a low internal resolution, outlines, a baked
  grade and a dithered posterize, upscaled nearest-neighbour. That is why the
  renderer here has no antialiasing, no tone mapping and a linear output
  (the look does all three itself), why the adaptive governor sheds the
  look's internal lines rather than the canvas's pixel ratio, and why the
  glass holes still work: the look keeps alpha. The live-DOM screen behind
  the glass is untouched by any of it and stays crisp.

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
/**
 * 'stepping' is the odd one out: the other three are stages of a cold boot,
 * this one is the mid-session load behind the front door. AlejOS renders it
 * with StepOutCover rather than BootCover, because a progress bar slamming up
 * over a door you just opened reads as a fault, not as a transition.
 */
export type LoadStage = 'models' | 'world' | 'shaders' | 'stepping'

/**
 * Standing at a way out, roughly. The room boots without the open world, and
 * this threshold is where somebody stops being a visitor to the desktop and
 * starts being someone who wants the planet, so it is where we go and get it.
 * Generous on purpose: paying a beat early is invisible under the cover, while
 * paying late means stepping out onto placeholder ground.
 *
 * There are three doors out, all on the ground floor, and this used to know
 * about one. Working the back door fetched nothing, so you walked out of it
 * into the yard and stood on the stand-in plane with the planet never asked
 * for. The garage's carriage doors are the third.
 */
function atExteriorDoor(p: THREE.Vector3): boolean {
  if (p.y > UP) return false // the linen closet over the front door is not a way out
  const garageX = (GARAGE_DOOR.u0 + GARAGE_DOOR.u1) / 2
  return (
    (Math.abs(p.x - FRONT_DOOR_X) < 3 && Math.abs(p.z - HOUSE.minZ) < 3.5) ||
    (Math.abs(p.x - BACK_DOOR_X) < 3 && Math.abs(p.z - HOUSE.maxZ) < 3.5) ||
    (Math.abs(p.x - garageX) < 3.5 && Math.abs(p.z - GARAGE.minZ) < 3.5)
  )
}

/** past the house's own footprint (garage included), by a margin, in any
    direction */
function outsideShell(p: THREE.Vector3): boolean {
  return insideBy(p.x, p.z) < -1
}

/** one line of chat on its way to the receipt. `mine` is what tints it, not
    the name, so two visitors sharing a nickname still read their own words
    correctly */
interface ChatLine {
  name: string
  text: Msg
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
/** the receipt keeps this many lines; anything older has been torn off */
const FEED_KEEP = 80

/** a hint line that wraps only between its hints, never inside one, and
    never with a separator starting the next line: each dot is glued to the
    hint before it, so the only break is the space after */
const tapeLine = (line: string) => {
  const hints = line.split(' · ')
  return hints.flatMap((h, i) => [
    i > 0 ? ' ' : '',
    <span key={i} className="whitespace-nowrap">{i < hints.length - 1 ? `${h} ·` : h}</span>,
  ])
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
/*
  The working furniture's prompts, worded here so the HUD stays a dumb button
  and the sim keeps answering in its own terms: a fitting knows it is "the
  freezer" and that it is shut, and nothing below the game runtime should
  have to know how to say that in English.
*/
const tvVerb = (p: 'on' | 'off' | null) => (p ? `turn ${p} the tv` : null)
const fittingVerb = (p: { verb: string; label: string } | null) =>
  p ? `${p.verb} ${p.label}` : null
const sitVerb = (label: string | null) => (label ? `sit on ${label}` : null)
/** how early a frame may arrive and still be counted against the limiter's
    deadline, in ms. See walkTick: without it, a cap set to the panel's own
    rate halves it, because half the frames land a few microseconds short */
const FRAME_SLOP = 2
/** Keep the shared world ticking at twice its 15 Hz pose cadence while the
    menu covers it, without spending the player's full render budget. */
const PAUSED_FPS = 30
/** the four colours the character screen edits. Kept beside the prefs and
    apart from them: prefs are how you *see* the world, a look is how the
    world sees you, and only one of the two travels */
const LOOK_KEY = 'alejos-look'
const loadLook = (): PlayerLook => {
  try {
    const raw = localStorage.getItem(LOOK_KEY)
    if (raw) return sanitizeLook(JSON.parse(raw))
  } catch {
    /* private mode, or something that is not our JSON: the default robot */
  }
  return sanitizeLook(null)
}
/** the eight points the fleet's own bearings are rounded to, in the same
    clockwise order and off the same north: screen north is -z */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const compassAt = (dx: number, dz: number) =>
  COMPASS[(Math.round((Math.atan2(dx, -dz) / (Math.PI * 2)) * 8) + 8) % 8]

/** the control line each machine puts in the HUD, in both languages. Four
    machines, four sets of verbs: what "space" does is a handbrake, a
    throttle blip, the collective or a lift depending on what you climbed
    into, and the ship is steered by the mouse */
const DRIVE_KEYS: Record<VehicleId, { en: string; es: string }> = {
  car: {
    en: 'wasd drive · space handbrake · shift boost · x horn',
    es: 'wasd conducir · espacio freno de mano · shift turbo · x bocina',
  },
  boat: {
    en: 'w/s throttle · a/d rudder · shift boost · x horn',
    es: 'w/s acelerador · a/d timón · shift turbo · x bocina',
  },
  heli: {
    en: 'w/s tilt · a/d turn · space climb · ctrl descend · shift power',
    es: 'w/s inclinar · a/d girar · espacio subir · ctrl bajar · shift potencia',
  },
  ship: {
    en: 'mouse steers · w/s thrust · a/d strafe · space up · ctrl down · shift boost',
    es: 'el ratón dirige · w/s empuje · a/d lateral · espacio subir · ctrl bajar · shift turbo',
  },
}
/** the rest of the driving line, in both languages */
const DRIVE_TAIL = {
  en: (cockpit: boolean) => `v ${cockpit ? 'chase' : 'cockpit'} · e out · esc pauses`,
  es: (cockpit: boolean) => `v ${cockpit ? 'exterior' : 'cabina'} · e salir · esc pausa`,
}
const RIDE_ALONG = { en: 'along for the ride', es: 'de pasajero' }

/** a catalogue id that orders a machine rather than a prop */
const FLEET_PREFIX = 'fleet:'
/** ...and one that hands you a tool (the portal gun) */
const TOOL_PREFIX = 'tool:'
/** the machines' names in Spanish, for the catalogue's plates */
const VEHICLE_ES: Record<VehicleId, string> = { car: 'coche', boat: 'lancha', heli: 'helicóptero', ship: 'nave' }

/** fraction of the viewport height the glass fills once parked */
const FILL = 0.86
const INTRO_S = 2.6
/** the computer room's west window, which the moonlight comes in through.
    The room is upstairs: these are measured off its own floor */
const WINDOW_CENTER_Y = UP + 3.3
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
  /** the working furniture: a cupboard, a seat or the television within reach,
      already worded, because the sim knows what it is and the HUD does not */
  const [propVerb, setPropVerb] = useState<string | null>(null)
  /** sitting on something: what the HUD says you may get off, and whether
      this particular cushion can see the television */
  // `part`: a contraption seat (sandbox/contraption), driven rather than sat on
  const [seated, setSeated] = useState<{ label: string; atTv: boolean; part?: boolean } | null>(null)
  /** the tool gun's readout: its `mode:step` and the keys it is aimed at */
  const [toolLine, setToolLine] = useState<{ state: string; keys: string | null } | null>(null)
  /** what the crosshair is on (Crosshair.tsx) */
  const [aim, setAim] = useState<CrosshairAim>('none')
  /** the channel the set is showing, while you are sitting in front of it */
  const [tvChannel, setTvChannel] = useState<string | null>(null)
  const [locked, setLocked] = useState(false)
  // esc mid-walk frees the mouse and raises the pause menu
  const [paused, setPaused] = useState(false)
  /** the pause screen has been up at least once this session. It carries a
      second WebGL context (the character preview), so once built it is hidden
      rather than unmounted — and it is not built at all until the first pause,
      which keeps it off the stand-up frame */
  const [everPaused, setEverPaused] = useState(false)
  const [prefs, setPrefs] = useState(loadPrefs)
  /** what the GPU sniff decided and what the world was actually built at; they
      differ exactly when the visitor has overruled the sniff. Set once, when
      the renderer is created, which is always long before a pause is possible */
  const [tierInfo, setTierInfo] = useState<{ auto: GfxTier; built: GfxTier } | null>(null)
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
  /** a line of feedback that fades: "nowhere to put it down" */
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 2200)
    return () => clearTimeout(t)
  }, [notice])
  /** and its list of everyone else out there, taken at the same moment */
  const [people, setPeople] = useState<PersonWhere[]>([])
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
  /** the receipt printer's strip: console output and chat, in the order
      they printed (SandboxConsole.tsx) */
  const [feed, setFeed] = useState<FeedLine[]>([])
  /** the console line: null closed, else what it opened with ('' or '/') */
  const [typing, setTyping] = useState<string | null>(null)
  /** the spawn catalogue, held up by q, and what fills it once the world is in */
  const [menuOpen, setMenuOpen] = useState(false)
  const [catalogue, setCatalogue] = useState<CatalogueSource | null>(null)
  const [orders, setOrders] = useState<OrderLine[]>([])
  /** noclip, mirrored for the key hints */
  const [flying, setFlying] = useState(false)
  // the emote wheel is up (b, until something is picked); its arrow is driven through the api, not
  // through state, so a mouse move is a style write rather than a render
  const [wheelOpen, setWheelOpen] = useState(false)
  const wheelApi = useRef<EmoteWheelApi>(null)
  // the point key is held: the crosshair gets its pencilled mitten
  const [pointHud, setPointHud] = useState(false)
  const { t, language } = useI18n()
  // the tool gun's screen is written in the visitor's language
  const langRef = useRef(language)
  useEffect(() => {
    langRef.current = language
  }, [language])
  // named for what it is: a mirror of proximityVoice.ts's state for the HUD,
  // not the voice channel itself (that lives in the scene effect below)
  const [voiceHud, setVoiceHud] = useState<VoiceHud>({
    available: false, enabled: false, mode: 'open', speaking: false, peers: 0, error: null,
  })
  // --- who you are ---------------------------------------------------------
  // The character screen's state. `look` is local first and shared second: it
  // is applied to the body standing in the world the moment a swatch is
  // clicked and only then put on the wire, so the panel never waits on a
  // round trip to show you what you picked. `myName` is the opposite — the
  // server owns it, and this is a mirror of whatever it last told us.
  const [look, setLook] = useState(loadLook)
  const [myName, setMyName] = useState('')
  /** the same, for the scene's closures: the offline console echoes it */
  const myNameRef = useRef('')
  useEffect(() => {
    myNameRef.current = myName
  }, [myName])
  const [rename, setRename] = useState<{ pending: boolean; error: string | null }>({
    pending: false, error: null,
  })
  /** the one-time "you are guest-08c9" nudge, dismissed by opening the panel,
      by picking a name, or by the timer below */
  const [namePrompt, setNamePrompt] = useState(false)
  /** once per mounted scene, not once per reconnect: a dropped wifi must not
      re-open the same suggestion behind somebody who already said no */
  const namePromptSpent = useRef(false)
  const typingRef = useRef(false)
  // set by the effect: give the mouse back to the walk once an overlay closes
  const relockRef = useRef<(() => void) | null>(null)
  const closeChat = () => {
    typingRef.current = false
    setTyping(null)
    relockRef.current?.()
  }
  // set by the effect so the console line can run a command or say
  // something without reaching into the sim
  const sayRef = useRef<((text: string) => void) | null>(null)
  const consoleRef = useRef<Console | null>(null)
  const spawnRef = useRef<((kind: string) => void) | null>(null)
  const pinMenuRef = useRef<((on: boolean) => void) | null>(null)
  const closeMenuRef = useRef<(() => void) | null>(null)
  const sessionRef = useRef(session)
  const outroRef = useRef<(() => void) | null>(null)
  const roamRef = useRef<((on: boolean) => void) | null>(null)
  const doorRef = useRef<(() => void) | null>(null)
  /** the working furniture's button: a cupboard, the television, a cushion */
  const propRef = useRef<(() => void) | null>(null)
  const resumeRef = useRef<(() => void) | null>(null)
  const failRef = useRef(onFail)
  const stageRef = useRef(onStage)
  const interactRef = useRef(onInteract)
  const liveRef = useRef(screenLive)
  const prefsRef = useRef(prefs)
  const paperPlaneRef = useRef(paperPlane)
  // the live roam prop, readable from inside the scene's build closure: a
  // /world entrance has it true before roamRef exists to be called
  const roamPropRef = useRef(roam)
  const lookRef = useRef(look)
  /** set by the scene effect: repaint the body standing in the world and tell
      everyone else. Null while there is no scene, which is why the panel's
      state lives out here rather than inside the closure */
  const applyLookRef = useRef<((look: PlayerLook) => void) | null>(null)
  const setNickRef = useRef<((name: string) => void) | null>(null)
  // the pause sheet's "hear yourself", which has to reach the voice graph
  // living inside the scene effect; null whenever there is no world to share
  const voicePreviewRef = useRef<(() => Promise<void>) | null>(null)
  // the pause sheet's pixel-size proofs, answered by the next drawn frame
  // (see pixelProofs.ts); null whenever nothing 3D is drawing
  const pixelProofsRef = useRef<(() => Promise<PixelProofs | null>) | null>(null)
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
    lookRef.current = look
    applyLookRef.current?.(look)
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(look))
    } catch {
      /* private mode; the session keeps it in lookRef either way */
    }
  }, [look])
  // the nudge only makes sense while somebody could be reading the plate over
  // your head, so it waits for the socket rather than for the stand-up
  useEffect(() => {
    if (mp.status !== 'live' || !isMintedName(myName) || namePromptSpent.current) return
    namePromptSpent.current = true
    setNamePrompt(true)
  }, [mp.status, myName])
  useEffect(() => {
    if (!namePrompt) return
    const t = setTimeout(() => setNamePrompt(false), 14_000)
    return () => clearTimeout(t)
  }, [namePrompt])

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
    let disposeLook: (() => void) | null = null
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
        // no antialiasing: every frame is drawn through the pixel look into
        // its own aliased target, and a multisampled canvas would be memory
        // and a resolve spent on a single upscale triangle
        webgl = new THREE.WebGLRenderer({
          antialias: false,
          alpha: true,
          powerPreference: 'high-performance',
        })
        // The canvas runs at the panel's own ratio (capped at 2) and never
        // moves: it only ever receives the look's nearest-neighbour upscale,
        // and a canvas below the panel's resolution would be stretched again
        // by the compositor, bilinearly, which blurs every pixel the look
        // drew. What the render-scale dial and the governor move instead is
        // the look's internal resolution, as a multiplier on its lines:
        // `prCeil` is the dial, `pr` what the governor has left of it. They
        // are `let`s because the dial moves mid-roam, and the governor sheds
        // *from* it, so the two have to be the same number.
        const PR_BASE = Math.min(window.devicePixelRatio, 2)
        let prScale = prefsRef.current.scale
        let prCeil = prScale
        webgl.setPixelRatio(PR_BASE)
        webgl.setSize(W, H)
        webgl.shadowMap.enabled = true
        // PCF is less prone to the blotchy VSM halos that show up around thin
        // desk legs and chair casters on the dark floor. Not PCFSoft: three
        // deprecated it and swaps in PCF on the first shadow pass, and every
        // program linked before that pass was keyed on the soft type (which
        // it compiles as BASIC), so the whole covered warm-up linked a second
        // time the first time anything was drawn after it. Found as the
        // physgun's first grab linking its rim shells mid-walk
        webgl.shadowMap.type = THREE.PCFShadowMap
        // the scene is static except the player body, so every light's map is
        // baked once (light.shadow.autoUpdate = false) and re-rendered only
        // for the light near the player on frames where a caster moved
        webgl.shadowMap.autoUpdate = true
        // tone mapping and output encoding belong to the look now, which
        // switches the renderer's own off before any material compiles
        // (pixelLook.ts's header says why that ordering is load-bearing)
        const look: PixelLook = createPixelLook(webgl)
        let pixSize = prefsRef.current.pixels
        look.setScale(prCeil)
        look.compile()
        disposeLook = look.dispose
        // Pick the graphics tier BEFORE any level builds: grass density,
        // canopy fullness and the sun's shadow map are baked at construction
        // time (world/quality.ts). The GPU string decides it by default, and
        // the pause sheet's "detail" choice overrules that when it is not on
        // auto — which is the whole reason the setting exists, since a regex
        // over a driver string is wrong in both directions on real hardware.
        // Both numbers are reported to the menu so it can say what the sniff
        // found and whether the choice on the sheet still agrees with the
        // world that got built.
        let autoTier: GfxTier = 'medium'
        try {
          const gl = webgl.getContext()
          const info = gl.getExtension('WEBGL_debug_renderer_info')
          autoTier = classifyGpu(
            info
              ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
              : String(gl.getParameter(gl.RENDERER)),
          )
        } catch {
          /* no way to ask: the conservative answer, as before */
        }
        const builtTier = detailTier(prefsRef.current.detail, autoTier)
        setGfxTier(builtTier)
        look.knobs.lines = gfx.pixelLines * PIXEL_LINES_K[pixSize]
        setTierInfo({ auto: autoTier, built: builtTier })
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
        lamp.scene.position.set(0, UP + CEIL_H, 4.4)
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
        // ...but only once the world they are parked in exists. All three sit
        // outside the property, so a room-only boot builds none of them and
        // holds a null object in the same binding instead (emptyFleet.ts). The
        // call sites below read `fleet` through this `let`, so the swap in
        // attachWorld() reaches every one of them without touching any.
        let fleet: VehicleFleet = emptyFleet()
        // the sandbox (src/game/sandbox/): Rapier and the props, loaded with the
        // world and never before it. One per level that declares one (the
        // Level contract's `sandbox`), and this is the live level's: null
        // until the world is here, and in a level with no props at all
        let sandbox: Sandbox | null = null
        /** every level's sandbox made so far, by level id */
        const sandboxes = new Map<string, { sb: Sandbox; level: Level }>()
        // the tool belt (src/game/sandbox/tools/): hands and the physgun, built
        // with the sandbox. 1 and 2 pick the slot; the belt starts on hands,
        // so a walk that never presses 2 is the walk it always was
        let tools: Toolbelt | null = null
        /** the walker's side of the portals, and their way to the Moon
            (built with the belt) */
        let portalWalk: PortalWalk | null = null
        let portalMoon: PortalMoon | null = null
        /** mouse movement the belt has taken from the view (E turning a prop) */
        const toolLook = { x: 0, y: 0 }
        const toolAim = { eye: new THREE.Vector3(), dir: new THREE.Vector3(), yaw: 0 }
        const toolIn: ToolInput = {
          aim: toolAim, dt: 0, fire: false, alt: false, rotate: false, snap: false,
          reload: false, wheel: 0, lookX: 0, lookY: 0,
        }
        const toolHand = new THREE.Vector3()
        const toolHandL = new THREE.Vector3()
        let toolsLive = false
        /** its undo stack, once it exists (sandbox/history.ts) */
        let history: History | null = null
        disposeFleet = () => {
          fleet.dispose()
          tools?.dispose()
          for (const { sb } of sandboxes.values()) sb.dispose()
        }
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
        // the look redraws the hole at the canvas's own resolution, so the
        // live screen's edge is a line rather than a staircase of pixels
        look.addHole(glass)

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
          dart.position.set(1.6, UP + 0.02, 4.2)
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
        moonPool.position.set(-3.6, UP + 0.028, WINDOW_CENTER_Z + 0.1)
        moonPool.renderOrder = 12
        moonPool.frustumCulled = false
        scene.add(moonPool)
        const windowSpill = new THREE.SpotLight('#9dbfff', 0, 8, 0.6, 0.78, 1.6)
        windowSpill.position.set(HOUSE.minX + 0.06, WINDOW_CENTER_Y + 0.08, WINDOW_CENTER_Z + 0.05)
        windowSpill.target.position.set(HOUSE.minX + 4.6, UP + 0.55, WINDOW_CENTER_Z - 0.22)
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
        roomGlow.position.set(0, UP + 4.75, 4.4)
        scene.add(roomGlow)
        const pendant = new THREE.SpotLight('#ffd9ae', 0, 0, 1.05, 0.85, 1.5)
        pendant.position.set(0, UP + 5.45, 4.4)
        pendant.target.position.set(0, UP, 4.4)
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
        moon.position.set(HOUSE.minX - 4, UP + 4.6, 5.5)
        moon.target.position.set(0, UP + 0.6, 4.5)
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
        key.position.set(-3.2, UP + 5.2, 2.8)
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
        /** the computer room's two casting lights want a re-bake only while
            somebody moves in their reach, which is upstairs at the front */
        const flagDeskShadows = (p: THREE.Vector3) => {
          if (p.y < deskRoom.floorY) return
          if (p.z < 15.5) pendant.shadow.needsUpdate = true
          if (p.z < 7) key.shadow.needsUpdate = true
        }
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
        rim.position.set(2.5, UP + 3, -2)
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
        const camStart = new THREE.Vector3(2.4, UP + 2.9, 4.5)
        const camEndFor = (h: number) =>
          front.clone().add(normal.clone().multiplyScalar((gSize.y * h) / (divH * 2 * tanHalf)))
        let camEnd = camEndFor(H)
        // where the walk stands. Up here with the camera rather than down in
        // the runtime block, because the /world entrance opens the lens on it
        // directly rather than gliding up to it from the chair
        // standing eye height over this desk's scale. deskTop is a world
        // height and the desk is upstairs, so measure it off its own floor
        const EYE = deskTop - deskRoom.floorY + 2.0
        const SPAWN = new THREE.Vector3(1.15, deskRoom.floorY + EYE, 2.55)
        // Warm every static texture now and let the drivers link the shader
        // pile in parallel: the old synchronous compile() blocked the main
        // thread for its whole duration, which froze the warp tunnel's canvas
        // mid-ride. The intro flight lifts off once this resolves (below).
        // the desk models' own textures (keyboard, mouse) magnify as texels
        // like everything else in the look; set before the uploads below
        texelateTree(scene)
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
        // third person (f5) the chase boom in chaseCam.ts stands the lens off
        // over its shoulder, and a flop (x) hands the whole skeleton to the ragdoll
        // same gravity as the walk tune, and whatever colours the character
        // screen last saved: the body is built wearing them, so the third
        // person camera never shows a frame of the default robot
        const rig = buildPlayerBody(EYE, 34, lookRef.current)
        const body = rig.group
        body.visible = false
        scene.add(body)
        const chase = createChaseCam()
        /** the right hand, where the body carries the physgun in third person */
        const handR = rig.limbs.findIndex((l) => l.name === 'handR')
        const handL = rig.limbs.findIndex((l) => l.name === 'handL')
        /** where a shove from another player lands */
        const chestLimb = Math.max(0, rig.limbs.findIndex((l) => l.name === 'chest'))
        /*
          Getting hit. The fleet moves (somebody else's car on foot, your own
          at the wheel) and the watch turns where each machine was last frame
          into how fast it is going, then asks whether it is on top of a body
          and closing. The local walker and the town's pedestrians both ask,
          so a car driven into a queue at a bus stop bowls it over.
        */
        const impacts = createImpactWatch()
        const impact: Impact = { impulse: new THREE.Vector3(), point: new THREE.Vector3() }
        const feetPt = new THREE.Vector3()
        /** a touchdown faster than this (a fall of about ten units) is not a
            landing, it is a heap. The hop lands at ~12 */
        const FALL_FLOP = 26
        /*
          Sitting down on the furniture.

          Deliberately *not* a second tick the way driving is. A sofa does not
          move, so the whole of sitting on one is: freeze the walk, park the
          lens at cushion height, clamp the head to the pose the seat implies
          and hold the body's seated rig. All four are four lines inside the
          ordinary walk frame below, and every other thing that frame does
          (the day cycle, the shadow flags, the crowd, the prompts) carries on
          being true while you sit there.
        */
        const seating = createSeating(EYE)
        const seatEye = new THREE.Vector3()
        /*
          ...and a contraption seat, which is the sofa's arithmetic on a seat
          that moves: the walk frozen, the body folded, the lens at the
          seated eye, but all of it re-read off the seat prop every frame
          (twice: before the props step, and after, off the pose they are
          drawn at), and the head carried round with the seat's heading.
          `partSeatObj` is the Seat-shaped record the ordinary seated frame
          reads, so every "not while sitting" rule applies to it unchanged;
          the machine itself hears WASD through the tool belt (`toolIn.seat`)
        */
        let partSeat: number | null = null
        let partYaw = 0
        const partView = { eye: new THREE.Vector3(), cushion: new THREE.Vector3(), yaw: 0 }
        const partSeatObj: Seat = {
          label: 'the seat', x: 0, z: 0, cushionY: 0, yaw: 0, eyeY: 0, cone: Math.PI, floor: 0,
          stand: { x: 0, y: 0, z: 0 }, atTv: false,
        }
        /** the living-room set, once its model has landed */
        let tv: TvHandles | null = null
        // the eye sits ahead of the spine; keeps the chest out of frame. The
        // round body carries its belly further forward than the robot did, so
        // the trail is longer (checked with `npm run shoot -- body:fp`, which
        // places the body with this same number)
        const BODY_BACK = 0.62
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
        /*
          The seated body, which is `poseBody` with the walk taken out of it.

          `rig.sit()` hangs the fold from the eye rather than the hips, so the
          seat's *eye* height is the body's position, the same height the
          lens goes to, which is what makes a sitter's head land where the
          camera says their head is. The trailing offset still has to survive,
          for the same reason it exists standing up: the camera is the head,
          so a body planted exactly under it puts the inside of your own skull
          across the whole first-person view. The fraction fades with the
          boom, so third person shows the complete seated player and first
          person shows their lap.
        */
        const poseSeated = (seat: { x: number; z: number; eyeY: number; yaw: number }) => {
          const show = Math.min(1, chase.dist / 1.2)
          // ...and the crown comes off in first person, the same way it does
          // walking: `rig.update` would normally decide that, and a seated
          // body is holding a pose instead of being driven
          rig.showHead(show > 0.12)
          const fp = 1 - show
          const down = Math.max(0, -walk.pitch) / 1.35
          const back = (BODY_BACK + 0.55 * down * down) * fp
          body.position.set(
            seat.x + Math.sin(seat.yaw) * back,
            seat.eyeY,
            seat.z + Math.cos(seat.yaw) * back,
          )
          body.rotation.y = seat.yaw + Math.PI
        }
        // reused every tick; the rig and boom read them, never keep them
        const rigPose: PlayerPose = {
          dt: 0, gait: 0, crouchK: 0, grounded: true, run: false,
          yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 0,
        }
        /*
          Emotes and the point key (game/player/emotes.ts; the poses are the
          rig's). `wheel` is the cursor on the emote wheel while it is up (b):
          the mouse drives it instead of the view (see onTurn). `emoteCam`
          swings the chase camera out for an emote and back when it ends,
          decided once as it starts. The point is aimed from the right
          shoulder at whatever the crosshair is on, so the copy on somebody
          else's screen points at the same thing.
        */
        const wheel = { open: false, x: 0, y: 0 }
        let emoteCam = false
        // the click (or right click) that closed the wheel, held down: not a
        // shot until it comes back up
        let wheelSwallow = false
        const digitWas = new Array<boolean>(9).fill(false)
        let pointHudNow = false
        const POINT_REACH = 80
        const POINT_SKIP = 1.2
        const shoulderLimb = Math.max(0, rig.limbs.findIndex((l) => l.name === 'shoulderR'))
        const pointDir = new THREE.Vector3()
        const pointAt = new THREE.Vector3()
        const pointFrom = new THREE.Vector3()
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
        /** ...or, given `from`, whatever is there at that height: the
            computer room is upstairs, and a spawn asked from the ground would
            stand you in the living room under it */
        const spawnY = (level: Level, x: number, z: number, from?: number) => {
          const floor = floorOf(level, x, z)
          return supportY(x, z, (from ?? floor) + EYE * 0.12, level.collision, floor)
        }
        /** the authored spawn, nudged aside so simultaneous arrivals do not
            stand up inside one another. Slot 0 (nobody else here, or the
            first one in) is the authored point untouched, so single player
            is pixel-for-pixel what it always was. */
        const spawnSpotFor = (level: Level, x: number, z: number, from?: number) => {
          if (spawnSlot <= 0) return { x, z }
          return scatterSpawn(x, z, spawnSlot, (cx, cz) => {
            const floor = spawnY(level, cx, cz, from)
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
          fleetEnv.gravity = level.gravity ?? 1
          fleetEnv.air = !!level.air
          fleetEnv.collision = level.collision
          fleetEnv.surfaceAt = level.driveSurface ?? surfaceOf
          fleetEnv.level = level.id
          return fleetEnv
        }
        /** the level the machines start in (the first that has them: their
            home spots are on the street), for spawnAll */
        const fleetLevel = () => homeLevels.find((l) => l.vehicles) ?? levels.current
        /** the level a machine the server placed is in (each is in one) */
        const fleetLevelOf = (x: number, z: number) => {
          const id = fleetLevelAt(x, 0, z)
          return homeLevels.find((l) => l.id === id) ?? fleetLevel()
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
        // who has an empty machine on a physgun (0 nobody, 1 us, 2 somebody
        // else), and the two verbs the fleet needs for it: the claim, and the
        // relay of a machine we hold, the same packet a driver sends
        const netHand: number[] = WIRE_VEHICLES.map(() => 0)
        const fleetNetState = {
          driven: netDriven,
          taken: netTaken,
          hand: netHand,
          claim: (i: number, on: boolean) => net?.hold(i, on),
          send: (i: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number) =>
            net?.vehicle(i, x, y, z, yaw, pitch, roll),
        }

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
            netHand[i] = v.hand === 0 ? 0 : v.hand === me ? 1 : 2
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
          for (const v of fleetNet.vehicles) {
            if (v.known) fleet.placeFromNet(v.id, v.x, v.z, v.yaw, aimFleetEnv(fleetLevelOf(v.x, v.z)))
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

        /** a/d on the sofa is the channel dial, and it is an edge, not a hold */
        let chHeld = false
        /**
         * Seconds left of "something in the house is still swinging".
         *
         * Every shadow map in here is hand-baked and only re-baked while the
         * *player* moves, which is exactly wrong for a cupboard: you press E
         * and then stand perfectly still watching a door swing out from under
         * its own painted-on shadow. The house cannot report this itself, its
         * update running inside a Level's, which returns nothing, so the press
         * starts a clock and the tick treats it like body movement until the
         * leaf has settled.
         */
        let propSwing = 0
        /** F9, read the same way v and x are: edge-detected off the key set,
            and asked in both loops because either can be the live one */
        const debugTick = (level: Level, x: number, footY: number, z: number) => {
          if (edges.pressed('collisionDebug')) collisionDebug.toggle()
          collisionDebug.update(level.collision, {
            x, z, footY, headY: footY + EYE,
          })
        }
        let hereNow = 0
        let aimNow: CrosshairAim = 'none'
        /** which shoulder the third-person lens stands over: 1 right, -1 left */
        let shoulderSide = 1
        // scratch for resolveAim
        const aimLens = new THREE.Vector3()
        const aimAt = new THREE.Vector3()
        const aimQ = new THREE.Quaternion()
        const aimEul = new THREE.Euler(0, 0, 0, 'YXZ')
        /** the prop under the crosshair within arm's reach (a contraption
            seat offers itself off this), and the tool gun's last readout */
        let reachPropNow: number | null = null
        let partSeatRequest: { id: number; until: number } | null = null
        let toolLineNow = ''
        /** props still scaling in from a spawn, and how long that takes */
        const pops: { mesh: THREE.Object3D; t: number }[] = []
        const POP_S = 0.24
        /** how far the crosshair notices a prop: the console's own reach */
        const AIM_REACH = 120

        // prompt bookkeeping mirrored into React state only on change
        let nearNow = false
        let doorVerbNow: 'open' | 'close' | null = null
        /** the working furniture's prompt, already worded */
        let propVerbNow: string | null = null
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
          setNoclip(false)
          walk.resetMotion()
          rig.reset()
          // a machine's seat node says how far its cabin needs a body folded
          rig.sit(seatNode(v, seat).userData.fit ?? CABIN_FIT, seat !== SEAT_DRIVER, seatNode(v, seat).userData.room ?? null)
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

        /*
          Take a seat, and get back out of one.

          The walker is parked *on the cushion* rather than left standing
          where it was, for the same reason `driveTick` parks it on the car:
          it is what the level system, the network and `stopRoam` all read as
          "where you are", and a body on the sofa whose walker is still on the
          rug is a body two people disagree about. Standing up is the reverse
          the walker is put down on the seat's own clear spot, because the
          alternative is being ejected sideways by the sofa's own collision
          box the frame after.
        */
        const takeSeat = () => {
          if (fleet.riding || levels.frozen || rig.down) return false
          const seat = seating.sit(headPos, headDir)
          if (!seat) return false
          setNoclip(false)
          walk.resetMotion()
          walk.teleport(seat.x, seat.z, seat.cushionY)
          const held = seating.hold(walk.yaw, walk.pitch)
          walk.yaw = held.yaw
          walk.pitch = held.pitch
          chase.drop()
          rig.reset()
          rig.sit()
          rig.face(seat.yaw)
          poseSeated(seat)
          body.visible = true
          house.flagShadows(camera.position)
          setSeated({ label: seat.label, atTv: seat.atTv })
          track('house_sit', { seat: seat.label })
          return true
        }

        const leaveSeat = () => {
          // the spot is checked against the room as it is now (seating.ts)
          const lv = levels.current
          const spot = seating.stand({ set: lv.collision, groundAt: (x, z) => floorOf(lv, x, z) })
          if (!spot) return false
          rig.showHead(true) // rig.update owns it again from the next frame
          chase.drop()
          walk.resetMotion()
          walk.teleport(spot.x, spot.z, spot.y)
          rig.reset()
          rig.face(walk.yaw)
          poseBody()
          house.flagShadows(camera.position)
          setSeated(null)
          setTvChannel(null)
          return true
        }

        /** re-read the contraption seat: false when it is gone (undone,
            removed, a level away) */
        const placePartSeat = () => {
          if (partSeat === null) return false
          const con = tools?.contraption
          if (!con || !con.seatView(partSeat, EYE, partView)) return false
          // the head turns with the seat, whatever the seat is doing
          let d = partView.yaw - partYaw
          d = Math.atan2(Math.sin(d), Math.cos(d))
          partYaw = partView.yaw
          walk.yaw += d
          walk.pitch = Math.max(-0.95, Math.min(0.75, walk.pitch))
          // the walker rides the cushion (the network and the seams read it)
          walk.teleport(partView.cushion.x, partView.cushion.z, partView.cushion.y)
          camera.position.copy(partView.eye)
          camera.rotation.set(walk.pitch, walk.yaw, 0)
          partSeatObj.x = partView.cushion.x
          partSeatObj.z = partView.cushion.z
          partSeatObj.cushionY = partView.cushion.y
          partSeatObj.floor = partView.cushion.y - 1
          partSeatObj.eyeY = partView.eye.y
          partSeatObj.yaw = partView.yaw
          return true
        }
        const takePartSeat = () => {
          if (fleet.riding || levels.frozen || rig.down || !tools || reachPropNow === null) return false
          if (!tools.contraption.isSeat(reachPropNow)) return false
          if (sandbox?.network?.online && !sandbox.network.claim(reachPropNow, 'seat')) {
            partSeatRequest = { id: reachPropNow, until: performance.now() + 1500 }
            return false
          }
          partSeat = reachPropNow
          if (!tools.contraption.seatView(partSeat, EYE, partView)) {
            partSeat = null
            return false
          }
          partYaw = partView.yaw
          setNoclip(false)
          walk.resetMotion()
          walk.yaw = partView.yaw
          // level: looking down from a seat is looking at your own lap
          walk.pitch = 0.02
          placePartSeat()
          chase.drop()
          rig.reset()
          rig.sit()
          rig.face(partView.yaw)
          poseSeated(partSeatObj)
          body.visible = true
          tools.holster()
          setSeated({ label: 'the seat', atTv: false, part: true })
          return true
        }
        const leavePartSeat = () => {
          if (partSeat === null) return false
          sandbox?.network?.release(partSeat)
          partSeat = null
          // out to the seat's right, a little above the cushion, and let the
          // walk find what is under that (the machine's deck, or the ground)
          const level = levels.current
          const x = partSeatObj.x + Math.cos(partSeatObj.yaw) * 2.6
          const z = partSeatObj.z - Math.sin(partSeatObj.yaw) * 2.6
          rig.showHead(true)
          chase.drop()
          walk.resetMotion()
          walk.teleport(x, z, Math.max(floorOf(level, x, z), partSeatObj.cushionY - 0.4))
          rig.reset()
          rig.face(walk.yaw)
          poseBody()
          setSeated(null)
          return true
        }

        const leaveVehicle = () => {
          const v = fleet.riding
          if (!v) return
          const spot = fleet.leave(aimFleetEnv(levels.current))
          if (!spot) return
          chase.drop()
          walk.resetMotion()
          walk.spawnAt(spot.x, spot.z, spot.yaw, spot.feetY)
          // out of something in the air (or in space): an ejection, and the
          // walker floats there, noclip, instead of dropping out of the sky
          if (spot.airborne) setNoclip(true)
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
          flagDeskShadows(camera.position)
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
          if (seat === SEAT_DRIVER) return id === 'heli' || id === 'ship' ? 'pilot' : 'driver'
          return id === 'heli' || id === 'ship' ? 'copilot' : 'passenger'
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
        /*
          Bumping into people (game/player/bodyContact.ts). The town's
          pedestrians and the other players are upright cylinders sized off
          their own rigs, and one pass a frame after the walk has moved
          settles the walker against them: a lean pushes apart, a sprint or
          a hop knocks them flat, a landing on a head bounces. The crowd is
          ours to push; the other players are not, so they are walls here and
          anything harder than a lean travels to them as a world-shove their
          own client applies (game/net/shove.ts)
        */
        const contact = createBodyContact()
        const remoteBumps = createRemoteBumps({
          world: remote,
          rigOf: avatars.rigOf,
          seated: (id) => fleetNet.seatOf(id) !== null,
          send: (to, vx, vy, vz) => net?.shove(to, vx, vy, vz),
          now: () => performance.now() / 1000,
        })
        const shoveTaker = createShoveTaker()
        /*
          The physgun on other players (game/net/grab.ts): the same deal as a
          shove. Our beam streams where their limb should be and their client
          pins its own ragdoll to it; their beam does the same to us, and we
          are the judge of whether we can be held (not seated, not in noclip,
          not in god mode) and for how long
        */
        const remoteGrabs = createRemoteGrabs({
          world: remote,
          rigOf: avatars.rigOf,
          claim: avatars.claim,
          seated: (id) => fleetNet.seatOf(id) !== null,
          send: (to, phase, limb, x, y, z, vx, vy, vz) => net?.grab(to, phase, limb, x, y, z, vx, vy, vz),
          now: () => performance.now() / 1000,
        })
        const grabTaker = createGrabTaker(rig)
        const grabAble = () =>
          !fleet.riding && !seating.current && partSeat === null && !walk.noclip && !godMode && !levels.frozen
        /** what the wire says our position is while the body is a heap: its
            chest, so a body carried off on somebody's beam is seen carried */
        const heapPt = new THREE.Vector3()
        /** seconds of hit-stop left, and how slow time runs in it */
        let hitStop = 0
        const HIT_STOP = 0.05
        const HIT_STOP_K = 0.08
        /** the attacker's squash: a landing's worth of fold fed to the body
            rig on the frame after a knock, so the body gives with the blow */
        let hitSquash = 0
        const shoveV = new THREE.Vector3()
        const bumpSets: (Bumpable | null)[] = [null, null]
        const myExtent: BodyExtent = { radius: 1, height: EYE }
        const bumper: Bumper = {
          eye: camera.position, feetY: 0, vx: 0, vz: 0, vy: 0, grounded: true, radius: 1, height: EYE,
          // the body's own limbs, posed last frame: a sprint's lean carries
          // the head and arms out past the trunk and they arrive first
          pts: new Float32Array(MAX_POINTS * 4), npts: 0,
        }
        // one record, refilled each frame (the walk frame allocates nothing)
        const contactIn: ContactStep = {
          me: bumper, push: walk.push, collision: makeCollisionSet({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
          stepUp: 0, sets: bumpSets, now: 0,
        }
        let net: ReturnType<typeof createWorldNet> | null = null
        let voice: ReturnType<typeof createProximityVoice> | null = null
        // the character screen's brush. Local first: the body you are standing
        // in is repainted the instant a swatch is clicked, and the wire hears
        // about it afterwards — a colour must never wait on a round trip, and
        // out of the world there is no round trip to wait on
        applyLookRef.current = (next) => {
          rig.setLook(next)
          tools?.setHandColor(next.shell)
          net?.look(packLook(next))
        }
        let feedKey = 0
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

        const pushFeed = (line: Omit<FeedLine, 'key' | 'at'>) =>
          setFeed((prev) =>
            [...prev, { ...line, key: feedKey++, at: performance.now() }].slice(-FEED_KEEP))
        const pushChat = (line: ChatLine) =>
          pushFeed(
            line.system
              ? { tone: 'system', text: line.text }
              : { tone: 'chat', text: line.text, name: line.name, admin: line.admin, mine: line.mine },
          )

        const propNet = createPropNetwork(
          (m) => net?.prop(m),
          (en, es) => pushFeed({ tone: 'err', text: bilingual(en, es) }),
        )
        const worldEffects = createWorldEffects({
          send: (m) => net?.effect(m),
          level: () => levels.current.id,
          world: (id) => {
            const l = homeLevels.find((l) => l.id === id)
            return l ? { boxes: l.collision.boxes, sb: sandboxes.get(id)?.sb ?? null } : null
          },
          cloud: (id, at) => sandboxes.get(id)?.sb.fx.cloud(at),
        })
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
          // — that is the whole of the /world entrance — so an absent session
          // is a guest, not a reason to stay out of the world. The server
          // mints the guest-xxxx name, exactly as it does for the arcade.
          const who = sessionRef.current ?? { kind: 'guest' as const, name: '' }
          net = createWorldNet({
            session: who,
            level: levels.current.id,
            // read, not captured: a reconnect must carry whatever the player
            // is wearing now, which may not be what they wore at join
            look: () => packLook(lookRef.current),
            onStatus: (status) => {
              if (status !== 'live') { propNet.offline(); worldEffects.offline() }
              setMp((m) => ({ ...m, status }))
            },
            onName: (name) => setMyName(name),
            onNick: (result) =>
              setRename(result.ok ? { pending: false, error: null } : { pending: false, error: result.error }),
            onMessage: (msg) => {
              propNet.receive(msg)
              worldEffects.receive(msg)
              switch (msg.type) {
                case 'world-welcome':
                  remote.welcome(msg.you, msg.tick, msg.players)
                  // what we spawn from here on is ours by the server's name
                  // for us, which is what undo and cleanup filter on
                  for (const { sb } of sandboxes.values()) historyOf(sb).me = msg.you
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
                    name: '', text: bilingual(`${msg.player.name} is here`, `${msg.player.name} llegó`),
                    admin: false, mine: false, system: true,
                  })
                  break
                case 'world-exit': {
                  grabTaker.drop(msg.id)
                  const gone = remote.roster.get(msg.id)
                  remote.exit(msg.id)
                  if (gone) {
                    pushChat({
                      name: '', text: bilingual(`${gone.name} left`, `${gone.name} se fue`),
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
                // somebody bumped into us: our own body, our own call
                case 'world-shove': {
                  shoveV.set(msg.vx, msg.vy, msg.vz)
                  const able =
                    !fleet.riding && !seating.current && partSeat === null && !walk.noclip && !godMode && !rig.down && !levels.frozen
                  const fx = shoveTaker.take(shoveV, performance.now() / 1000, able)
                  if (fx === 'flop') {
                    rig.limbPos(chestLimb, impact.point)
                    impact.impulse.copy(shoveV).multiplyScalar(rig.mass)
                    rig.hit(impact.impulse, impact.point)
                  } else if (fx === 'stumble') {
                    walk.push(shoveV.x, 0, shoveV.z)
                  }
                  break
                }
                // somebody has us on their physgun: our body, our call
                case 'world-grab':
                  grabTaker.take(msg, performance.now() / 1000, grabAble())
                  break
                // somebody renamed or repainted. Both land on the roster
                // first — a body that has not spawned yet reads it there —
                // and only then on the meshes, if there are any
                case 'world-name':
                case 'world-look': {
                  const entry = remote.identify(
                    msg.id,
                    msg.type === 'world-name' ? { name: msg.name } : { look: msg.look },
                  )
                  if (entry) avatars.reskin(msg.id, entry)
                  break
                }
              }
            },
          })
          voice = createProximityVoice({
            self: () => remote.you,
            eye: EYE,
            // the pause sheet's two dials, off the live record rather than a
            // copy: the sheet writes prefs, the voice graph reads them
            levels: () => ({
              mic: prefsRef.current.micVol,
              out: prefsRef.current.voiceVol,
            }),
            filter: () => prefsRef.current.voiceFx,
            // read per peer, not captured: a reconnect brings a fresh TURN
            // credential and the old one may already have expired
            ice: () => net?.ice ?? [],
            send: (to, data) => net?.signal(to, data),
            onChange: syncVoice,
          })
          syncVoice()
          setNickRef.current = (name) => net?.setNick(name)
          voicePreviewRef.current = () => voice?.preview() ?? Promise.resolve()
        }

        const leaveWorld = () => {
          propNet.offline()
          worldEffects.offline()
          voice?.dispose()
          voice = null
          voicePreviewRef.current = null
          net?.close()
          net = null
          setNickRef.current = null
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
          for (const { sb } of sandboxes.values()) historyOf(sb).me = LOCAL
          setTyping(null)
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
          // on whichever storey they are standing on: the chair is upstairs
          const from = walk.feetY
          const spot = spawnSpotFor(level, spawnHome.x, spawnHome.y, from)
          // the boom writes back the head position it saved last frame, so a
          // teleport it has not been told about is undone one frame later
          chase.drop()
          walk.teleport(spot.x, spot.z, spawnY(level, spot.x, spot.z, from))
          rig.reset()
          rig.face(walk.yaw)
          poseBody()
        }

        /*
          The two sandbox overlays, the console line and the spawn catalogue.

          Both free the mouse: the catalogue is clicked, and the console's
          suggestions can be. Losing the pointer lock is normally how the
          pause sheet opens (esc is spent on the unlock before anything else
          sees it), so `onLock` below asks whether one of these is up before
          reading an unlock as esc, and closing either takes the lock back,
          which the browser allows without a click because the page released
          it itself.
        */
        const openChat = (seed = '') => {
          if (typingRef.current || pausedNow) return
          setMenu(false)
          typingRef.current = true
          setTyping(seed)
          input.clearKeys() // nothing stays latched while the line has the keys
          input.releaseLock()
        }
        let menuNow = false
        /** the catalogue's find line has the keyboard (see SpawnMenu.tsx) */
        let menuPinned = false
        const setMenu = (on: boolean) => {
          if (!on) menuPinned = false
          if (menuNow === on) return
          menuNow = on
          setMenuOpen(on)
          if (on) input.releaseLock()
          else relock()
        }
        // Closing either one with esc must not take the lock back while esc
        // is still down: Chrome grants the request and then spends the same
        // key's release on unlocking again, which reads as esc and pauses.
        // So an esc close waits for the key to come up (the keypress is
        // still the user activation the request needs)
        let escHeld = false
        let relockOnEscUp = false
        const onEscKey = (e: KeyboardEvent) => {
          if (e.code !== 'Escape') return
          escHeld = e.type === 'keydown'
          // the catalogue is a toggle, so esc is its other way out (the find
          // line handles its own esc before this sees it). The book holds no
          // pointer lock, so this esc reaches the page: it must stop here, or
          // AlejOS's own esc handler takes it as leaving the room
          if (escHeld && menuNow && !menuPinned) {
            e.stopImmediatePropagation()
            setMenu(false)
          }
          if (!escHeld && relockOnEscUp) {
            relockOnEscUp = false
            setTimeout(relock, 30)
          }
        }
        window.addEventListener('keydown', onEscKey, true)
        window.addEventListener('keyup', onEscKey, true)
        const relock = () => {
          if (escHeld) {
            relockOnEscUp = true
            return
          }
          if (roaming && fps && !pausedNow && !typingRef.current && !menuNow) input.tryLock()
        }
        relockRef.current = relock
        pinMenuRef.current = (on) => {
          if (!menuNow) return
          menuPinned = on
          if (on) input.clearKeys()
        }
        closeMenuRef.current = () => setMenu(false)

        const setPauseNow = (on: boolean) => {
          if (pausedNow === on) return
          pausedNow = on
          // The new cap takes effect on the next rAF, including an immediate
          // resume. Paused intervals must not carry into the live resolution
          // governor and make it mistake an intentional wait for GPU strain.
          nextFrame = 0
          lastT = performance.now()
          emaMs = 16
          prWait = 1.5
          // an engine is the first sound in this project that does not stop by
          // itself, so the menu has to say so — a paused world that is still
          // idling underneath reads as the game having hung
          fleet.setMuted(on)
          if (on) {
            input.clearKeys() // nothing stays latched under the menu
            // esc is spent on the pointer unlock before the composer ever sees
            // it, so the pause is also how a chat line gets abandoned
            typingRef.current = false
            setTyping(null)
            setMenu(false)
            // and the same for the people. The roster knows everyone the
            // server has told us about; `players` is the subset standing in
            // our own level, so anybody in the backrooms is on the list with
            // a name and no bearing, which is the honest answer
            const others: PersonWhere[] = []
            for (const [id, entry] of remote.roster) {
              if (id === remote.you) continue
              const body = remote.players.get(id)
              others.push({
                id,
                name: entry.name,
                admin: entry.admin,
                shell: unpackLook(entry.look).shell,
                ...(body
                  ? {
                      dist: Math.hypot(body.x - camera.position.x, body.z - camera.position.z),
                      bearing: compassAt(
                        body.x - camera.position.x,
                        body.z - camera.position.z,
                      ),
                    }
                  : {}),
              })
            }
            // nearest first, and whoever is off in another level last
            others.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity))
            setPeople(others)
            // and the first pause is what builds the screen at all — see the
            // everPaused declaration
            setEverPaused(true)
          }
          setPaused(on)
        }

        const input = createRoamInput({
          dom: webgl.domElement,
          isActive: () => roaming,
          isLive: () => fps,
          isPaused: () => pausedNow,
          isTyping: () => typingRef.current || menuPinned,
          // at the wheel the mouse belongs to the drive camera. Left wired to
          // walk.turn it would silently spin the suspended walker's heading
          // and stand you down facing somewhere you never looked
          onTurn: (dx, dy, sign) => {
            // the emote wheel up: the mouse swings its arrow, not the view
            if (wheel.open && !fleet.riding) {
              wheel.x += dx
              wheel.y += dy
              const r = Math.hypot(wheel.x, wheel.y)
              if (r > WHEEL_REACH) {
                wheel.x *= WHEEL_REACH / r
                wheel.y *= WHEEL_REACH / r
              }
              wheelApi.current?.aim(wheel.x, wheel.y)
              return
            }
            // E held on a prop in the beam: the mouse turns the prop, and
            // the view holds still while it does
            if (tools?.capturesLook && !fleet.riding) {
              toolLook.x += dx
              toolLook.y += dy
              return
            }
            if (fleet.riding) fleet.turn(dx, dy, sign, prefsRef.current.sens)
            else walk.turn(dx, dy, sign, prefsRef.current.sens)
          },
          // E: get out of whatever you are in, else the machine's prompt, else
          // a door's, else climb into whatever is parked in front of you
          onUse: () => {
            if (loadingWorld) return true
            // while the beam holds something E is its rotate modifier
            if (tools?.capturesUse && !fleet.riding) return true
            if (fleet.riding) {
              leaveVehicle()
              return true
            }
            // sitting: E is the way back out, and nothing else is offered
            if (seating.current) {
              leaveSeat()
              return true
            }
            if (partSeat !== null) {
              leavePartSeat()
              return true
            }
            if (nearNow) {
              interactRef.current()
              return true
            }
            if (doorVerbNow) {
              if (!house.useDoor(headPos, headDir)) outside.useDoor(headPos, headDir)
              // working a door to the outside is the moment the world stops
              // being optional. The cover goes up over the swing, so what the
              // visitor sees is one short load and then an open door onto a
              // real planet
              if (!outside.hasWorld() && atExteriorDoor(headPos)) void loadWorldCovered()
              return true
            }
            // the house's own furniture: a cupboard to open, a television to
            // switch on, a cushion to drop onto. All three are the same key
            // and they never overlap, because you cannot stand in two places
            if (propVerbNow) {
              if (tv?.use(headPos, headDir)) {
                if (tv.on) track('house_tv', { channel: tv.channel.label })
                return true
              }
              if (house.useProp(headPos, headDir)) {
                propSwing = 1.1 // long enough for the ease to settle
                return true
              }
              if (takeSeat()) return true
              if (takePartSeat()) return true
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
            // ...unless it was the console or the catalogue asking for the
            // mouse, which is not esc and must not pause
            else if (roaming && fps && !typingRef.current && !menuNow) setPauseNow(true)
          },
        })

        // --- the sandbox's hands: keys, rules, the console ------------------
        // one edge detector over the key table (sandbox/bindings.ts), updated
        // once a frame at the top of walkTick and read by both loops
        const edges = createEdges()
        // the world's shared knobs (sandbox/rules.ts): offline they apply at
        // once; the network will route them through the server
        const rules = createWorldRules()
        // the console's knob multiplies each level's own gravity (the Moon's
        // is a sixth), for the walker and for every level's props alike
        const gravityOf = (level: Level) => level.gravity ?? 1
        rules.onChange((key, v) => {
          if (key === 'gravity') {
            walk.gravityScale = v * gravityOf(levels.current)
            for (const { sb, level } of sandboxes.values()) sb.gravity = -GRAVITY * v * gravityOf(level)
          } else {
            for (const { sb } of sandboxes.values()) sb.timescale = v
          }
        })
        rules.onDeny((_what, reason) => pushFeed({ tone: 'err', text: reason }))
        /** the console's `time` and `fog`: a pinned clock and a thickness */
        let todPin: number | null = null
        let fogK = 1
        let godMode = false
        const setNoclip = (on: boolean) => {
          if (walk.noclip === on) return
          walk.noclip = on
          setFlying(on)
        }
        const aimDir = new THREE.Vector3()
        /*
          Aim, in either view. In first person it is the lens's own ray and
          `dir` comes back as it went in. Over the shoulder the crosshair is
          dead centre of a lens standing off to the side of the head, so the
          ray through it is cast from the lens to find what is under the
          crosshair, and the aim is then taken from the head at that point:
          what you point at is what the physgun, E and the console get, and
          whether it is in reach is still a question about the character.
          While the physgun holds something the point is where the lens ray
          runs the held distance from the head, so the held prop rides under
          the crosshair rather than chasing its own surface. `quat` is the
          head's turn (the lens offset is stored in the head's frame).
        */
        const resolveAim = (head: THREE.Vector3, quat: THREE.Quaternion, dir: THREE.Vector3) => {
          if (chase.dist <= 1.2 || rig.down) return dir
          chase.lens(head, quat, aimLens)
          // the stretch of the lens ray behind the head is not in play, and
          // neither is the body itself
          const t0 = Math.max(0, aimAt.subVectors(head, aimLens).dot(dir)) + 0.6
          let t = t0 + AIM_REACH
          const pg = tools?.physgun
          if (pg?.holding) {
            // |lens + dir t - head| = the held distance, the far root
            const b = aimAt.subVectors(aimLens, head).dot(dir)
            const disc = b * b - (aimAt.lengthSq() - pg.hold.dist * pg.hold.dist)
            t = disc > 0 ? -b + Math.sqrt(disc) : t0
          } else if (sandbox) {
            aimAt.copy(aimLens).addScaledVector(dir, t0)
            const hit = sandbox.raycast(aimAt, dir, AIM_REACH)
            if (hit) t = t0 + hit.distance
          }
          aimAt.copy(aimLens).addScaledVector(dir, t).sub(head)
          const len = aimAt.length()
          return len > 1e-4 ? dir.copy(aimAt).divideScalar(len) : dir
        }
        const canAct = () => !fleet.riding && !levels.frozen && !seating.current && partSeat === null && !rig.down
        /** Garry's Mod lets you noclip or teleport out of a heap on the
            floor, so the console and the noclip key do too: the body stands
            up on the spot, at once, where the ragdoll came to rest */
        const standNow = () => {
          if (!rig.down) return
          rig.getupSpot(getupPt)
          const level = levels.current
          chase.drop()
          walk.resetMotion()
          walk.teleport(
            getupPt.x, getupPt.z,
            supportY(getupPt.x, getupPt.z, getupPt.y, level.collision, floorOf(level, getupPt.x, getupPt.z)),
          )
          rig.reset()
          rig.face(walk.yaw)
          poseBody()
        }
        const host: SandboxHost = {
          sandbox: () => sandbox,
          history: () => history,
          rules,
          worldLoaded: () => outside.hasWorld(),
          placesHere: () => !!levels.current.house,
          online: () => net !== null,
          // the head and gaze as of the last frame: commands run from DOM
          // events, when the chase boom may be holding the camera
          // (on foot the gaze is read off the walk's own yaw and pitch, which
          // are this instant's, rather than off a camera one frame behind a
          // mouse flick: a spawn lands under the crosshair you see now)
          aim: () => {
            if (fleet.riding || seating.current || partSeat !== null || rig.down) return { origin: headPos, dir: headDir }
            const cp = Math.cos(walk.pitch)
            aimDir.set(-Math.sin(walk.yaw) * cp, Math.sin(walk.pitch), -Math.cos(walk.yaw) * cp)
            // over the shoulder, through the crosshair (resolveAim)
            aimQ.setFromEuler(aimEul.set(walk.pitch, walk.yaw, 0))
            return { origin: headPos, dir: resolveAim(headPos, aimQ, aimDir) }
          },
          here: () => ({ x: headPos.x, y: walk.feetY, z: headPos.z, yaw: walk.yaw }),
          teleport: (x, z, y, yaw) => {
            if (fleet.riding) leaveVehicle()
            if (seating.current) leaveSeat()
            leavePartSeat()
            standNow()
            if (fleet.riding || rig.down) return
            const level = levels.current
            // never outside the level's own square: past it there may be no
            // ground worth the name (the Moon curves away into its horizon)
            const b = level.collision.bounds
            x = Math.min(b.maxX, Math.max(b.minX, x))
            z = Math.min(b.maxZ, Math.max(b.minZ, z))
            const floor = floorOf(level, x, z)
            // a little above whatever is there and let gravity settle it:
            // the chunks under a far teleport are not built yet, and their
            // collision arrives a moment after the feet do
            const feet = y ?? (walk.noclip ? Math.max(floor + 6, walk.feetY) : spawnY(level, x, z) + 1.2)
            chase.drop()
            walk.resetMotion()
            walk.teleport(x, z, feet)
            if (yaw !== undefined) walk.yaw = yaw
            rig.reset()
            rig.face(walk.yaw)
            poseBody()
            headPos.set(x, feet + EYE, z)
          },
          home: () => ({ x: SPAWN.x, z: SPAWN.z, y: spawnY(levels.current, SPAWN.x, SPAWN.z, deskRoom.floorY) }),
          // the escape hatch (`unstuck`): out of whatever you are in, off
          // noclip, and on your feet on the front path at home. From another
          // level it is the ordinary cut home, landing on the same spot
          unstuck: () => {
            if (fleet.riding) leaveVehicle()
            if (seating.current) leaveSeat()
            setNoclip(false)
            standNow()
            const HOME_PATH = { x: 5.5, z: -2.6, yaw: 0 }
            const earth = homeLevels.find((l) => l.house) ?? levels.current
            if (levels.current !== earth) {
              levels.goTo(earth.id, HOME_PATH)
              return
            }
            host.teleport?.(HOME_PATH.x, HOME_PATH.z, undefined, HOME_PATH.yaw)
          },
          noclip: (on) => {
            if (on && !levels.frozen && !fleet.riding && !seating.current && partSeat === null) standNow()
            if (on !== undefined && canAct()) setNoclip(on)
            return walk.noclip
          },
          god: (on) => {
            if (on !== undefined) godMode = on
            return godMode
          },
          thirdPerson: (on) => {
            const now = on ?? prefsRef.current.third
            if (on !== undefined) setPrefs((p) => ({ ...p, third: on }))
            return now
          },
          fling: (vx, vy, vz) => {
            if (!canAct()) return false
            setNoclip(false)
            rig.flop(vx, vy, vz)
            return true
          },
          sit: () => takeSeat(),
          time: (tod) => {
            todPin = tod
          },
          fog: (k) => {
            fogK = k
          },
          players: () =>
            [...remote.players].map(([id, p]) => ({
              id, name: remote.roster.get(id)?.name ?? '?', x: p.x, y: p.y, z: p.z,
            })),
          chat: (text) => {
            if (!net) return false
            net.chat(text)
            return true
          },
          clear: () => setFeed([]),
          // a spawn arrives: every piece scales in with a little overshoot, a
          // ring of dust goes up where it sits down, and one pop plays for the
          // lot (ten crates are one order, not ten)
          spawned: (ids) => {
            if (!sandbox || !ids.length) return
            let mass = 0
            for (const id of ids) {
              const p = sandbox.get(id)
              if (!p) continue
              mass = Math.max(mass, p.mass)
              if (p.mesh) {
                p.mesh.scale.setScalar(0.05)
                pops.push({ mesh: p.mesh, t: 0 })
              }
              const at = p.body.translation()
              fleet.puff(at.x, at.y - p.extents.y, at.z, Math.max(p.extents.x, p.extents.z))
            }
            if (pops.length > 60) pops.splice(0, pops.length - 60)
            spawnPop(mass)
          },
        }
        const sbConsole = createConsole(host)
        consoleRef.current = sbConsole
        sbConsole.onPrint((l) => pushFeed(l))
        // the console line's enter: a slash runs a command, anything else is
        // said out loud, and with nobody out here it is printed back to you
        sayRef.current = (text) => {
          if (!text) return
          if (text.startsWith('/')) {
            void sbConsole.run(text)
          } else if (net) {
            net.chat(text)
          } else {
            pushFeed({ tone: 'chat', text, name: myNameRef.current || 'you', mine: true })
            pushFeed({
              tone: 'system',
              text: bilingual('nobody out here to hear it', 'no hay nadie aquí que lo escuche'),
            })
          }
        }
        // a click in the catalogue is a spawn at the crosshair, the same one
        // `spawn <kind>` does, without the echo
        spawnRef.current = (kind) => {
          if (kind.startsWith(FLEET_PREFIX)) orderVehicle(kind.slice(FLEET_PREFIX.length) as VehicleId)
          else if (kind === `${TOOL_PREFIX}portalgun`) givePortalGun()
          else if (kind === 'portal_panel') void spawnPanel()
          else void sbConsole.run(`spawn ${kind}`, { quiet: true })
        }
        /*
          The catalogue's portal gun is not delivered, it is handed over: the
          belt carries it from then on in slot 4, and it comes out at once.
          Ordering it again just draws it.
        */
        const givePortalGun = () => {
          if (!tools) return
          const fresh = tools.give('portalgun')
          tools.select(3)
          pushFeed(fresh
            ? { tone: 'ok', text: bilingual(
              'portal gun: left click blue, right click orange, r closes both, 4 draws it',
              'pistola de portales: clic izquierdo azul, clic derecho naranja, r cierra los dos, 4 la saca') }
            : { tone: 'ok', text: bilingual('portal gun out', 'pistola de portales en mano') })
        }
        /*
          The drawn meshes near a portal shot, for fitting it to the surface
          you can see rather than to the collision box round it (portals.ts's
          `soupAround`): the house's, the streamed world's and the Moon's, by
          bounding sphere. Instanced and skinned draws (the grass, the herd, the crowd)
          are nothing to open a portal on.
        */
        const nearSphere = new THREE.Sphere()
        const nearMeshes: THREE.Mesh[] = []
        let earthGround: THREE.Object3D | null = null
        const meshesUnder = (roots: THREE.Object3D[], at: THREE.Vector3, r: number): readonly THREE.Mesh[] => {
          nearMeshes.length = 0
          const visit = (obj: THREE.Object3D) => {
            if (!obj.visible) return
            const mesh = obj as THREE.Mesh
            // (not the ovals themselves: a Moon portal rides the Moon's root)
            if (mesh.isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh && !(obj as THREE.SkinnedMesh).isSkinnedMesh &&
              obj.name !== 'portal-blue' && obj.name !== 'portal-orange') {
              const geo = mesh.geometry
              if (!geo.boundingSphere) geo.computeBoundingSphere()
              if (geo.boundingSphere) {
                nearSphere.copy(geo.boundingSphere).applyMatrix4(mesh.matrixWorld)
                if (nearSphere.center.distanceTo(at) < nearSphere.radius + r) nearMeshes.push(mesh)
              }
            }
            for (const c of obj.children) visit(c)
          }
          for (const root of roots) visit(root)
          return nearMeshes
        }
        const portalMeshes = (at: THREE.Vector3, r: number): readonly THREE.Mesh[] => {
          earthGround ??= scene?.getObjectByName('earth-ground') ?? null
          // (a hidden root is skipped: the Moon's ground is only there to
          // shoot at while you stand on it)
          const roots: THREE.Object3D[] = []
          if (levels.current.house) roots.push(house.root)
          if (earthGround && levels.current.outdoors) roots.push(earthGround)
          const moonGround = outside.moonPortal.root()
          if (moonGround && levels.current.outdoors) roots.push(moonGround)
          return meshesUnder(roots, at, r)
        }
        /*
          The furnished house's own meshes along a portal shot (its doors,
          beds and cupboards have no collision face to be found by): the
          first drawn, visible mesh the ray meets, with the face's normal in
          the world. A portal fitted there rides that mesh (portals.ts's
          anchor), so one on a door swings with the door.
        */
        const houseRay = new THREE.Raycaster()
        const houseHits: THREE.Intersection[] = []
        const shownChain = (o: THREE.Object3D) => {
          for (let q: THREE.Object3D | null = o; q; q = q.parent) if (!q.visible) return false
          return true
        }
        const portalHouseHit = (o: THREE.Vector3, d: THREE.Vector3, max: number) =>
          levels.current.house ? houseHitAny(o, d, max) : null
        const houseHitAny = (o: THREE.Vector3, d: THREE.Vector3, max: number) => {
          houseRay.set(o, d)
          houseRay.near = 0
          houseRay.far = max
          houseRay.camera = camera
          houseHits.length = 0
          houseRay.intersectObject(house.root, true, houseHits)
          for (const h of houseHits) {
            const m = h.object as THREE.Mesh
            if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || !h.face || !shownChain(m)) continue
            const n = h.face.normal.clone().transformDirection(m.matrixWorld)
            return { t: h.distance, normal: n, object: m as THREE.Object3D }
          }
          return null
        }
        /*
          The catalogue's portal panel is set down to be used: against the
          wall under the crosshair, facing out, or standing upright on the
          ground turned to face you, and frozen either way (the physgun still
          takes it). It goes through the console's own spawn, so Z undoes it.
        */
        const spawnPanel = async () => {
          const sb = sandbox
          const a = host.aim?.()
          if (!sb || !a) return
          let id = -1
          const off = sb.onSpawn((p) => {
            if (p.kind.id === 'portal_panel') id = p.id
          })
          await sbConsole.run('spawn portal_panel', { quiet: true })
          off()
          if (id < 0) return
          const HY = 2.6
          const HZ = 0.08
          const hit = sb.raycast(a.origin, a.dir, 60, { props: false, world: true })
          const at = new THREE.Vector3()
          let yaw: number
          if (hit && Math.abs(hit.normal.y) < 0.5) {
            // flat against the wall, standing on whatever is under it
            const n = hit.normal.clone().setY(0).normalize()
            at.copy(hit.point).addScaledVector(n, HZ + 0.04)
            yaw = Math.atan2(n.x, n.z)
          } else {
            if (hit) at.copy(hit.point)
            else at.copy(a.origin).addScaledVector(a.dir, 12)
            yaw = Math.atan2(camera.position.x - at.x, camera.position.z - at.z)
          }
          // on the floor at the height you stand at (upstairs is upstairs)
          at.y = spawnY(levels.current, at.x, at.z, walk.feetY) + HY + 0.03
          sb.setTransform(id, at, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
          sb.freeze(id)
        }
        /** a portal shot into the open sky: the Moon, if it is under the ray
            (sandbox/tools/portalMoon.ts) */
        const portalSky = (color: PortalColor, eye: THREE.Vector3, dir: THREE.Vector3): boolean => {
          // from the Moon, the Earth hanging in its sky
          if (portalMoon?.onEarth(dir)) return portalEarthShot(color)
          if (!portalMoon?.sky(color, eye, dir)) return false
          pushFeed({ tone: 'ok', text: bilingual('a portal on the Moon', 'un portal en la Luna') })
          return true
        }
        /*
          A shot at the Earth from the Moon opens on the Earth at a fixed
          spot, the left leaf of the garage door at home, fitted by the gun's
          own fit against the house (which stands in the scene whichever
          level is live), then photographed for the Moon side's view.
        */
        const EARTH_SPOT_EYE = new THREE.Vector3(9.25, 3.84, -9)
        const EARTH_SPOT_AT = new THREE.Vector3(9.25, 2.35, -1.75)
        const portalEarthShot = (color: PortalColor): boolean => {
          const earth = homeLevels.find((l) => l.house)
          if (!tools || !portalMoon || !earth) return false
          const dir = EARTH_SPOT_AT.clone().sub(EARTH_SPOT_EYE).normalize()
          const shot = tools.portals.fire(color, EARTH_SPOT_EYE, dir, {
            level: earth.id, collision: earth.collision, groundAt: earth.groundYAt, groundY: earth.groundY,
            waterY: earth.waterY, sandbox: sandboxes.get(earth.id)?.sb ?? null,
            meshesNear: (at, r) => meshesUnder([house.root], at, r),
            drawnHit: (o, d, max) => houseHitAny(o, d, max),
          })
          const p = tools.portals.list[color]
          if (!shot.ok || !p) return false
          p.site = 'earth'
          // (taken from the Moon, the Earth's side is lit by the Moon's sun:
          // no lift, whatever time it is at home)
          portalMoon.snapshotFrom(p, scene, 1)
          pushFeed({ tone: 'ok', text: bilingual('a portal on the Earth: the garage door at home', 'un portal en la Tierra: la puerta del garaje de casa') })
          return true
        }
        /** a pair spanning two levels: the Earth's side photographed on the
            way out, then the seamless swap, with nobody moved (the portal
            places the walker in the new level's own coordinates) */
        const portalLevel = (to: string, c: PortalCrossing): boolean => {
          if (to === 'moon' && portalMoon) {
            // the snapshot is taken from the Earth portal's own face, which
            // is where the walker is standing: no body, no gun in it
            const vm = tools?.viewmodel
            const fpWas = !!vm?.fp.visible
            const bodyWas = body.visible
            if (vm) vm.fp.visible = false
            body.visible = false
            // (lifted for the Moon's day grade by how dark the night it is
            // taken in is: the night grade shows a street brighter than raw)
            portalMoon.depart(c.from, scene, 1 + 3 * (lastSky?.night ?? 0))
            if (vm) vm.fp.visible = fpWas
            body.visible = bodyWas
          }
          return levels.cross(to)
        }
        /** the view through a pair spanning two levels: the Moon, dressed for
            one pass (the light rig and the air are the scene's own, so they
            are dressed here and the rest by outsideWorld), or the snapshot */
        const portalAir = { near: 0, far: 0, color: new THREE.Color(), bg: new THREE.Color(), sky: new THREE.Color(),
          ground: new THREE.Color(), hemi: 0, moon: 0 }
        const SPACE_HEMI = new THREE.Color('#1c2130')
        const portalCross = (to: Portal, vcam: THREE.PerspectiveCamera): ReturnType<NonNullable<PortalHooks['cross']>> => {
          const got = portalMoon?.view(to, vcam, scene) ?? null
          if (!got || 'snapshot' in got || !scene) return got
          const fog = scene.fog as THREE.Fog
          const bg = scene.background as THREE.Color
          const A = portalAir
          A.near = fog.near
          A.far = fog.far
          A.color.copy(fog.color)
          A.bg.copy(bg)
          A.sky.copy(hemi.color)
          A.ground.copy(hemi.groundColor)
          A.hemi = hemi.intensity
          A.moon = moon.intensity
          // the Moon level's air: none, and a black sky that fills nothing in
          fog.near = 1e6
          fog.far = 2e6
          fog.color.set(0, 0, 0)
          bg.set(0, 0, 0)
          hemi.color.copy(SPACE_HEMI)
          hemi.groundColor.copy(SPACE_HEMI)
          hemi.intensity = HEMI_ROAM * 0.8 * 0.35
          moon.intensity = 0
          return {
            far: got.far,
            restore: () => {
              got.restore()
              fog.near = A.near
              fog.far = A.far
              fog.color.copy(A.color)
              bg.copy(A.bg)
              hemi.color.copy(A.sky)
              hemi.groundColor.copy(A.ground)
              hemi.intensity = A.hemi
              moon.intensity = A.moon
            },
          }
        }
        /*
          The catalogue's Vehicles section. There is one of each machine, shared
          by everyone (the wire has four fleet slots and eight chairs, and a
          second car would need a second of each), so an order is the machine
          *delivered*: moved from wherever it was to the ground under the
          crosshair, or the nearest place it may stand or float, side-on to
          you. With a server it goes through the same claim a physgun does,
          so nobody's car is pulled out from under them. Not undoable: there
          is nothing to take back to, only somewhere else it was.
        */
        const orderVehicle = (id: VehicleId) => {
          const lv = levels.current
          const label = fleet.all.find((v) => v.id === id)?.label ?? id
          if (!lv.vehicles) {
            pushFeed({ tone: 'err', text: bilingual(`no ${label} delivered here`, `aquí no se entrega ${label}`) })
            return
          }
          // the crosshair on the ground, or a stretch ahead of you
          const a = host.aim?.()
          const hit = a && sandbox ? sandbox.raycast(a.origin, a.dir, 90, { props: false, world: true }) : null
          const at = new THREE.Vector3()
          if (hit) at.copy(hit.point)
          else if (a) at.copy(a.origin).addScaledVector(a.dir, 18)
          else at.copy(camera.position)
          const r = fleet.order(id, at, camera.position, aimFleetEnv(lv))
          if (r === 'busy') pushFeed({ tone: 'err', text: bilingual(`the ${label} is in use`, `${label}: ya está en uso`) })
          else if (r === 'nowhere') pushFeed({ tone: 'err', text: bilingual(`no room for the ${label} here`, `no hay sitio para ${label} aquí`) })
          else {
            pushFeed({ tone: 'ok', text: bilingual(`${label} delivered`, `${label} entregado`) })
            spawnPop(800)
          }
        }
        const undoLast = () => {
          if (!history || !sandbox) return
          const e = history.undo()
          pushFeed(e
            ? { tone: 'ok', text: bilingual(`undone: ${labelIn(e.label, 'en')}`, `deshice: ${labelIn(e.label, 'es')}`) }
            : { tone: 'err', text: bilingual('nothing left to undo', 'no queda nada que deshacer') })
        }

        // the two levels and the noclip cut between them; the scene's share
        // of a swap is the blackout card and the shadow-map hygiene
        const homeLevels = makeHomeLevels(house, outside, backrooms, obstacles)
        /*
          Where the props' ground is streamed around when nobody is walking.
          From high up it stays where it was: flying at orbital speed over
          ground nobody can reach, the sandbox built nine heightfields of cold
          terrain lookups a frame, which was the lag in orbit
        */
        const sbFocus = new THREE.Vector3(Number.NaN, 0, 0)
        const sandboxFocus = (at: THREE.Vector3) => {
          if (outside.view.alt < NEAR_OFF || !Number.isFinite(sbFocus.x)) sbFocus.copy(at)
          return sbFocus
        }
        const globeSun = new THREE.Color()
        const globeAmb = new THREE.Color()
        const levels = createLevelSystem({
          /*
            A seamless seam (flying onto the Moon and off it, and the re-base
            of the scene onto space on the way home): the two sides draw the
            same picture, so nothing resets. The walker and whatever it is
            flying are carried by the offset with their motion kept, and only
            what a level change must do is done: the new level's gravity, its
            sandbox, and the roster.
          */
          onSeamless: (level, shift, from) => {
            walk.shift(shift.x, shift.y, shift.z)
            headPos.x += shift.x
            headPos.y += shift.y
            headPos.z += shift.z
            const craft = fleet.riding
            if (craft?.spacecraft) fleet.shiftRiding(shift.x, shift.y, shift.z)
            if (rig.ragdolling) rig.reset()
            if (level === from) return
            propNet.setLevel(level.id)
            worldEffects.setLevel(level.id)
            net?.setLevel(level.id)
            // the server frees a chair at a level change: take it back
            if (craft?.spacecraft) {
              const idx = WIRE_VEHICLES.indexOf(craft.id)
              if (idx >= 0) net?.seat(idx, fleet.seat)
            }
            walk.gravityScale = rules.gravity * gravityOf(level)
            switchSandboxTo(level)
          },
          levels: homeLevels,
          home: 'overworld',
          onCover: (on) => {
            blackout.style.transition = on ? 'opacity 130ms' : 'opacity 650ms'
            blackout.style.opacity = on ? '1' : '0'
          },
          onCutStart: () => {
            walk.haltPlanar()
            backrooms.noclipSound()
            // whatever the house was doing, it is not doing it down there:
            // the seat is in another level and the television is unhearable
            // from one, having no spatialiser to fall silent with
            leaveSeat()
            // a contraption belongs to the level's own sandbox
            leavePartSeat()
            tv?.silence()
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
            propNet.setLevel(level.id)
            worldEffects.setLevel(level.id)
            net?.setLevel(level.id)
            rig.reset() // a ragdoll must not straddle a level swap
            rig.face(spawn.yaw)
            chase.drop()
            // a seam drops everyone on one tile too, so the same offset
            // applies — here it can be baked straight into the arrival
            spawnHome.set(spawn.x, spawn.z)
            scattered = true
            const spot = spawnSpotFor(level, spawn.x, spawn.z)
            // a seam that lands you in the air (from space) says how high,
            // and is lifted onto the floor if the number is under it
            const floorAt = spawnY(level, spot.x, spot.z)
            walk.spawnAt(spot.x, spot.z, spawn.yaw, spawn.y === undefined ? floorAt : Math.max(floorAt, spawn.y))
            // flown through in the ship: it arrives where the seam lands, in
            // the air, with us still in our chair, and the chair is claimed
            // again (the server freed it at the level change)
            const craft = fleet.riding
            if (craft?.spacecraft && fleet.warpRiding(spot.x, Math.max(floorAt + 20, spawn.y ?? floorAt + 60), spot.z, spawn.yaw)) {
              const idx = WIRE_VEHICLES.indexOf(craft.id)
              if (idx >= 0) net?.seat(idx, fleet.seat)
            }
            // the new level's gravity, and its own sandbox (or none)
            walk.gravityScale = rules.gravity * gravityOf(level)
            switchSandboxTo(level)
            if (level.house) house.flagShadows(camera.position)
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
        // the most recent sky the light pass composed. A fleet built mid-session
        // (the world attaching behind the front door) has never seen a day
        // cycle, and handing it this instead of nothing is what stops its paint
        // and headlamps arriving one frame's worth of midday behind the room
        let lastSky: OutsideState | null = null
        const applyLight = (at: THREE.Vector3 = camera.position) => {
          const sky = outside.update(at, todPin ?? undefined)
          // the console's fog: thicker is nearer, never further than the
          // world streams (fogK is at least 1, see commands.ts's `fog`)
          sky.fogNear /= fogK
          sky.fogFar /= fogK
          lastSky = sky
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
          // The fleet's baked sky reflection dims with daylight; headlamps
          // and navigation lights come up with the dusk.
          fleet.setDay(sky.day, sky.night, sky.fogColor, sky.sunEl)
          sceneFog.color.copy(sky.fogColor)
          sceneFog.near = sky.fogNear
          sceneFog.far = sky.fogFar
          sceneBg.copy(sky.fogColor)
          // the grade leans toward its night table as the light goes, but
          // not through the twilight: golden hour is the warmest moment of
          // the day, and the night table's drained chroma would grey it out
          look.setMood(sky.night * (1 - sky.twilight))
          dressAir(sky)
          levels.current.overrideLight?.(lightRig)
          // the globes light themselves the way the ground under them is lit,
          // so the planet from orbit and the far field over it agree
          globeSun.copy(outside.sun.color).multiplyScalar(outside.sun.intensity)
          globeAmb.copy(hemi.color).multiplyScalar(hemi.intensity)
          outside.lightGlobes(globeSun, globeAmb)
        }

        /*
          The look's air and its night lights, dressed from the same sky the
          light pass just composed (render/atmosphere.ts has the numbers).
          The two lookups that walk the world, the biome under the camera
          and the nearest lamps, are re-asked only after real travel or a
          few frames, so neither costs anything per frame; everything else
          is a handful of uniforms.
        */
        const airSun = new THREE.Vector3()
        const airAmb = new THREE.Color()
        const lampBuf = new Float32Array(16 * 3)
        const lampRadii = new Float32Array(16)
        const worldLamps = new Float32Array(16 * 3)
        const houseDist = new Float32Array(16)
        /*
          What the look is actually handed: every lamp still showing, with
          its fade. A lamp joining the nearest few comes up over a fraction
          of a second and one leaving goes down, rather than each popping on
          the frame the set is re-asked (render/lampFade.ts).
        */
        const lampFader = createLampFader()
        const shownXyz = new Float32Array(16 * 3)
        const shownR = new Float32Array(16)
        const shownW = new Float32Array(16)
        let fadeAt = performance.now()
        /*
          The house's own lamps join the streetlamps as pools, the nearest
          few to the lens first, so walking through the house at night finds
          every lit room pooled on its floor. Eight at most: the look shades
          sixteen, four are kept for lamps fading out, and from the front
          door the street's lamps want the rest.
        */
        const HOUSE_POOLS = 8
        const gatherLamps = (p: THREE.Vector3) => {
          let n = 0
          const src = house.lamps
          for (let i = 0; i < house.lampCount; i++) {
            const lx = src[i * 4]
            const ly = src[i * 4 + 1]
            const lz = src[i * 4 + 2]
            // storeys count double, so the floor you are on wins its lamps
            const d = (lx - p.x) ** 2 + (lz - p.z) ** 2 + 4 * (ly - p.y) ** 2
            if (d > 900) continue
            if (n === HOUSE_POOLS && d >= houseDist[n - 1]) continue
            let j = n < HOUSE_POOLS ? n++ : n - 1
            while (j > 0 && houseDist[j - 1] > d) {
              houseDist[j] = houseDist[j - 1]
              lampBuf.copyWithin(j * 3, (j - 1) * 3, j * 3)
              lampRadii[j] = lampRadii[j - 1]
              j--
            }
            houseDist[j] = d
            lampBuf[j * 3] = lx
            lampBuf[j * 3 + 1] = ly
            lampBuf[j * 3 + 2] = lz
            lampRadii[j] = src[i * 4 + 3]
          }
          const m = outside.nearLamps(p.x, p.z, worldLamps, WANT_MAX - n)
          lampBuf.set(worldLamps.subarray(0, m * 3), n * 3)
          lampRadii.fill(8.5, n, n + m)
          return n + m
        }
        /** the house's drawables put away from orbit (see dressAir) */
        let houseHidden: THREE.Object3D[] | null = null
        /** what game/music is told about the ground, refreshed twice a second */
        let musicAsk = 0
        let musicBiome: string | null = null
        let musicShore = 0
        let airBiome = 1
        let airAskX = Number.NaN
        let airAskZ = 0
        let airAskAge = 0
        const dressAir = (sky: OutsideState) => {
          // the look's air and its lamps belong to a level with an atmosphere;
          // the lens's reach to any level under the open sky
          const air = !!levels.current.air
          const open = !!levels.current.outdoors
          const p = camera.position
          airAskAge++
          if (
            !Number.isFinite(airAskX) || airAskAge > 45 ||
            (p.x - airAskX) ** 2 + (p.z - airAskZ) ** 2 > 36
          ) {
            airAskX = p.x
            airAskZ = p.z
            airAskAge = 0
            const b = outside.biomeAt(p.x, p.z)
            airBiome = b ? BIOME_AIR[b] ?? 1 : 1
            lampFader.want(lampBuf, lampRadii, air ? gatherLamps(p) : 0)
          }
          const now = performance.now()
          const shown = lampFader.step((now - fadeAt) / 1000, p.x, p.y, p.z, shownXyz, shownR, shownW)
          fadeAt = now
          airSun.subVectors(outside.sun.position, outside.sun.target.position).normalize()
          const ov = outside.view
          airForSky(
            look.air, sky, airBiome, airSun, outside.sun.color,
            air ? ov.alt : 0, air ? ov.reach : 0, Math.max(-100, outside.waterY),
          )
          // from the air the lens reaches the far field's rim (levels/altitude.ts),
          // and from space the globe and the Moon (levels/space.ts)
          const wantFar = open ? ov.far : 900
          const wantNear = open ? ov.near : 0.1
          // from orbit the house is a speck under a whole planet, and a
          // thousand draw calls: its drawables go with the streamed chunk ring
          // (levels/space.ts's NEAR_OFF). Its drawables, not its root: the
          // root carries the house's PointLights, and a light leaving the
          // scene changes NUM_POINT_LIGHTS and relinks every lit program
          const houseAway = open && ov.alt >= NEAR_OFF
          if (houseAway !== !!houseHidden) {
            if (houseAway) {
              houseHidden = []
              house.root.traverseVisible((o) => {
                if (isDrawable(o)) houseHidden?.push(o)
              })
              for (const o of houseHidden) o.visible = false
            } else {
              for (const o of houseHidden ?? []) o.visible = true
              houseHidden = null
            }
          }
          if (camera.far !== wantFar || camera.near !== wantNear) {
            camera.far = wantFar
            camera.near = wantNear
            camera.updateProjectionMatrix()
          }
          // the backrooms carry their own fog and no sky, and the Moon has
          // a sky and nothing to see it through: no air, no lamps. On the way
          // to orbit the air drains away under you (levels/space.ts)
          if (!air) look.air.max = 0
          else {
            look.air.max *= 1 - ov.space
            // thinner air up high: the haze lengthens with height. And once
            // the globe carries on past the far field's rim the rim is no
            // longer an edge to hide, so the air's rim (which takes a pixel
            // to all air whatever the air's cap says) moves out past the
            // planet's horizon; left where it was, it painted the whole globe
            // the colour of the sky, and from space that colour is black
            look.air.dist *= 1 + Math.max(0, ov.alt - 120) / 700
            look.air.edge *= 1 + 30 * ov.curve * ov.curve
            // ...and the sky under the horizon is the air's colour only while
            // there is air: from space, past the limb, it is space
            const thin = 1 - ov.space
            look.air.liftK *= thin
            look.air.skyHorizon *= thin
            look.air.skyAll *= thin
          }
          airAmb.copy(hemi.color).multiplyScalar(hemi.intensity)
          lightsForSky(look.lights, sky, shownXyz, air ? shown : 0, airAmb, shownR, shownW)
          // the headlamp is yours: on while you are on your feet in the
          // overworld at night, off at the wheel (the car has its own) and
          // at the desk
          const head = look.lights.head
          head.on = head.on && fps && roaming && air && !fleet.driving
          if (head.on) {
            head.pos.copy(camera.position)
            camera.getWorldDirection(head.dir)
          }
          // a blast's flash and a burning fuse's flicker are fake lights too
          // (the live level's sandbox's fx owns them); with no sandbox, nothing
          if (sandbox) sandbox.fx.lightLook(look.lights)
          else look.lights.flash.radius = 0
          // and prop sounds are placed and panned against this lens
          if (sandbox) {
            const m = camera.matrixWorld.elements
            sandbox.ear(camera.position.x, camera.position.y, camera.position.z, m[0], m[2])
          }
        }

        // the settings page's proofs: the frame drawn once per pixel size, the
        // middle cut out after each, then drawn again at the real one, all
        // before the browser presents anything (pixelProofs.ts)
        let proofWaiters: Array<(p: PixelProofs | null) => void> = []
        pixelProofsRef.current = () => new Promise((res) => proofWaiters.push(res))
        /*
          The portals' views (sandbox/tools/portalView.ts), drawn ahead of the
          frame into targets the size of the look's own, so the ovals in the
          scene pass sample the far side pixel for pixel. For the passes the
          first-person gun is put away and the head put back on: through a
          portal you see yourself, whole.
        */
        let vmFpWas = false
        const portalHooks: PortalHooks = {
          begin: () => {
            const vm = tools?.viewmodel
            vmFpWas = !!vm?.fp.visible
            if (vm) vm.fp.visible = false
            rig.showHead(true)
          },
          end: () => {
            const vm = tools?.viewmodel
            if (vm) vm.fp.visible = vmFpWas
            rig.showHead(rigPose.show > 0.12)
          },
          cross: (to, vcam) => portalCross(to, vcam),
        }
        let portalHolesKey = ''
        const renderPortals = () => {
          const pv = tools?.portalView
          if (!pv || !webgl || !scene || !roaming) return
          worldEffects.tick()
          portalMoon?.tick()
          // an open floor portal cuts its oval out of the grass and the
          // wildflowers (world/wind.ts's holes), and they grow back when it closes
          const holesKey = `${tools!.portals.version}:${levels.current.id}:${Math.floor(camera.position.x / 10)}:${Math.floor(camera.position.z / 10)}`
          if (holesKey !== portalHolesKey) {
            portalHolesKey = holesKey
            const holes: { c: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3 }[] = []
            for (const p of tools!.portals.all) {
              if (!p || p.level !== levels.current.id || p.n.y < 0.6) continue
              holes.push({ c: p.pos, a: p.right.clone().multiplyScalar(tools!.portals.hw), b: p.up.clone().multiplyScalar(tools!.portals.hh) })
            }
            holes.sort((a, b) => a.c.distanceToSquared(camera.position) - b.c.distanceToSquared(camera.position))
            outside.groundHoles(holes)
          }
          const it = look.fitNow()
          pv.render(webgl, scene, camera, it.w, it.h, levels.current.id, performance.now() / 1000, portalHooks)
        }
        const render = () => {
          if (!webgl || !scene) return
          applyLight()
          renderPortals()
          look.render(scene, camera)
          if (proofWaiters.length) {
            const sc = scene
            const waiting = proofWaiters
            proofWaiters = []
            const proofs = snapPixelProofs(webgl.domElement, (size) => {
              look.knobs.lines = gfx.pixelLines * PIXEL_LINES_K[size]
              look.render(sc, camera)
            })
            look.knobs.lines = gfx.pixelLines * PIXEL_LINES_K[pixSize]
            look.render(scene, camera)
            for (const w of waiting) w(proofs)
          }
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
            // the lens has stopped; spend the idle it just bought on the room
            // behind it, which nothing has drawn yet
            warmRoomWhenIdle()
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
            const back = Math.min(1, Math.max(0, (t - 0.55) / 0.3))
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
        // each roam and each sit-down restores full crispness, and moving the
        // render-scale dial restores it to the new ceiling on the next frame
        let pr = prCeil
        let emaMs = 16
        let prWait = 1.5
        // the frame limiter's next deadline, kept beside the governor because
        // the two read the same clock and argue about the same number
        let nextFrame = 0

        /*
          The sun's map serves two casters that move at completely different
          rates, and it used to be refreshed at the faster one's cadence for
          both.

          sky.ts already gates it: ten units of travel or seven degrees of solar
          rotation. That is the right cadence for the *world*, whose shadows do
          not change because you walked past them. It is the wrong cadence for
          the player, who is in the same map: at ten units the shadow under
          your own feet is most of a house behind you, so the walk and drive
          ticks asked for a refresh of their own, unconditionally, on every
          frame anything moved. That is a full depth pass over everything
          standing inside the sun's 110-unit box, sixty times a second, all day,
          to move one silhouette.

          Ask on the error instead of on the frame. A quarter of a unit is well
          under the width of the body casting it, so the shadow never visibly
          detaches, and on foot that is one pass in three or four rather than
          one per frame. The time clause covers a caster that moves without
          travelling, such as a ragdoll settling or a suspension unloading. sky.ts's own
          gate still runs on top, which is what keeps a turning sun honest while
          you stand still.

          The remaining waste is structural: the box is re-rendered whole to
          move one caster. Fixing that properly means a second, tight shadow
          camera for dynamic casters only, which is a new light, and a new
          light is a new shader variant for every lit material in the scene, so
          it is not a change to make casually here.
        */
        const SUN_FOLLOW_D2 = 0.25 * 0.25
        const SUN_FOLLOW_MS = 100
        const sunFollowAt = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN)
        let sunFollowT = -Infinity
        const followSunShadow = (at: THREE.Vector3, now: number) => {
          if (outside.sun.shadow.intensity <= 0.001) return
          if (
            Number.isFinite(sunFollowAt.x) &&
            at.distanceToSquared(sunFollowAt) < SUN_FOLLOW_D2 &&
            now - sunFollowT < SUN_FOLLOW_MS
          ) {
            return
          }
          sunFollowAt.copy(at)
          sunFollowT = now
          outside.sun.shadow.needsUpdate = true
        }

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
          // the seated body slumps, lolls and jiggles with the machine
          rig.seatedTick(dt)
          const v = fleet.riding
          if (!v) return
          const driver = fleet.seat === SEAT_DRIVER
          const level = levels.current
          syncCollisionSet(level.collision)
          // the cut state machine still has to run — but no seam may fire at
          // the wheel, except in a spacecraft: the ship is how you get to
          // the Moon, and onSeamless carries it (and us) across the seam
          seamPt.set(v.root.position.x, v.root.position.y, v.root.position.z)
          levels.tick(now, seamPt, !!v.spacecraft)
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
            outdoors: !!level.vehicles,
          })
          // whatever this machine is driven into goes over
          impacts.track(fleet.all, pausedNow ? 0 : dt)
          if (level.crowd) outside.knockPeople(impacts)
          // v swaps the boom for the cockpit. It is not the walk's saved
          // third-person preference — a car has two views and neither is the
          // one the pause menu's toggle means
          if (edges.pressed('vehicleView') && !pausedNow) {
            fleet.toggleView()
            // A cockpit lens sits at the avatar's face. Hide the body in that
            // view so its head cannot occlude the windscreen; chase view shows
            // the complete seated player.
            body.visible = !fleet.cockpit
            setDriving((d) => (d ? { ...d, cockpit: fleet.cockpit } : d))
          }
          if (sandbox) {
            const sbf = sandbox.tick({
              dt,
              active: !pausedNow,
              walker: null,
              focus: sandboxFocus(v.root.position),
            })
            if (sbf.moving && level.outdoors) followSunShadow(v.root.position, now)
          }
          level.update(dt, camera.position)
          syncCollisionSet(level.collision)
          // the machine is now the moving caster, and `step.moved` — which
          // gates the whole hand-baked shadow regime — comes from a walk
          // controller that is not running. The fleet reports its own
          if (fs.moved) {
            if (level.house) {
              flagDeskShadows(camera.position)
              house.flagShadows(camera.position)
            }
            if (level.outdoors) followSunShadow(v.root.position, now)
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
            remoteGrabs.tick(dt)
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
          // The compositor animates the cover. Rendering here would race the
          // shader warm-up, draw its staged tools, and keep the GPU busy with
          // frames nobody can see. Also keep held movement out of the cut.
          if (loadingWorld) {
            lastT = now
            nextFrame = now
            edges.update(input.keys)
            raf = requestAnimationFrame(walkTick)
            return
          }
          /*
            The frame limiter.

            rAF hands out frames at the panel's cadence and there is no way to
            ask for one in between, so a cap is served by *dropping* frames:
            draw on the first frame at or past the deadline, then advance the
            deadline by exactly one interval. Advancing it from itself rather
            than from `now` is what makes the average land on the number the
            dial says instead of on the nearest whole division of the refresh
            rate — 160 on a 240 Hz panel is two frames drawn out of every
            three, not the 120 a naive "has 6.25 ms passed?" test settles on.

            It skips the whole tick, not just the render. The physics, the
            streamer and the network are as much of the machine's evening as
            the draw is, and dt is measured between drawn frames, so the walk
            integrates the same distance either way.

            Two corrections. FRAME_SLOP lets a frame arrive a hair early, since
            without it a cap set to the panel's own rate silently halves it.
            And if the deadline falls behind outright — a hitch, a hidden tab,
            a card that cannot hold the cap anyway — it is resynced to now
            rather than left to bank credit and spend it as a burst.
          */
          const requestedCap = prefsRef.current.cap
          const cap = pausedNow
            ? Math.min(requestedCap || PAUSED_FPS, PAUSED_FPS)
            : requestedCap
          const interval = cap > 0 ? 1000 / cap : 0
          if (interval > 0) {
            if (now < nextFrame - FRAME_SLOP) {
              raf = requestAnimationFrame(walkTick)
              return
            }
            nextFrame += interval
            if (nextFrame < now) nextFrame = now + interval
          }
          const rawMs = now - lastT
          // a hit-stop: the few frames after the player lands a knock run
          // near-frozen, which is what makes a hit read as a hit. Time only,
          // local only: nothing about it travels
          const dtWall = Math.min(0.05, rawMs / 1000)
          const dt = hitStop > 0 ? dtWall * HIT_STOP_K : dtWall
          if (hitStop > 0) hitStop -= dtWall
          lastT = now
          edges.update(input.keys)
          // frame-time governor: a smoothed frame cost over ~22ms means the
          // GPU can't keep up at this resolution, so shed a pixel-ratio step.
          // How big a step is how far over budget it is: a retina panel
          // starting at 2 and stepping down an eighth of a second at a time
          // spent six seconds visibly struggling before it found the ratio it
          // was always going to end at, which is most of a first impression
          emaMs = emaMs * 0.93 + Math.min(100, rawMs) * 0.07
          // The backstop behind the doors' own trigger. A door is the ordinary
          // way out and not the only one: an already-open door, a level cut, a
          // future exit. Stepping outside the shell with no world under you is
          // the one failure this must not have, so the test is the whole
          // footprint. It used to be `z < HOUSE.minZ - 1`, which is the front
          // wall alone, so the back door dropped you into the yard standing on
          // the stand-in plane and the planet was never fetched at all. Cheap:
          // four compares against a flag that is only false until the world
          // exists, and level-gated because the backrooms wander through these
          // same coordinates a hundred units down.
          if (
            !outside.hasWorld() &&
            levels.current.house &&
            outsideShell(camera.position)
          ) {
            void loadWorldCovered()
            raf = requestAnimationFrame(walkTick)
            return
          }
          prWait -= rawMs / 1000
          // The render-scale dial, taken the frame after it moves. It is a
          // new ceiling *and* a fresh governor: the smoothed frame cost was
          // measured at the old resolution, so leaving it would have a step
          // down shed again immediately and a step up refuse to give anything
          // back until the average had crawled out of the last one.
          if (prefsRef.current.scale !== prScale) {
            prScale = prefsRef.current.scale
            prCeil = prScale
            pr = prCeil
            emaMs = 16
            prWait = 1.5
            look.setScale(pr)
          }
          // the pixel size is taste rather than cost, so it leaves the
          // governor alone: a new line target, the same share of it
          if (prefsRef.current.pixels !== pixSize) {
            pixSize = prefsRef.current.pixels
            look.knobs.lines = gfx.pixelLines * PIXEL_LINES_K[pixSize]
          }
          // 22 ms is the budget with nothing capping the loop. Under the
          // limiter the frame time *is* the interval by construction, so the
          // budget has to clear it or a 30 fps cap reads as a card that cannot
          // cope and sheds resolution it had no reason to. A cap of 60 or
          // faster leaves these numbers exactly where they were.
          const budget = Math.max(22, interval * 1.3)
          // the floor is half the lines, or the ceiling itself once the dial
          // is under it: somebody who has already chosen to render at 60% has
          // made this decision by hand, and there is nothing left for the
          // governor to take that they have not taken. Steps are fractions
          // of the lines, so each one is a real fill saving (an eighth of the
          // lines is about a quarter of the pixels)
          const prFloor = Math.min(0.5, prCeil)
          if (prWait <= 0 && emaMs > budget && pr > prFloor) {
            pr = Math.max(prFloor, pr - (emaMs > budget * 2 ? 0.25 : 0.125))
            look.setScale(pr)
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
            if (toolsLive) {
              tools?.holster()
              toolsLive = false
            }
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
          syncCollisionSet(level.collision)
          if (partSeatRequest) {
            const request = partSeatRequest
            if (performance.now() > request.until || !sandbox?.get(request.id)) partSeatRequest = null
            else if (sandbox?.network?.claim(request.id, 'seat')) {
              const aimed = reachPropNow
              reachPropNow = request.id
              takePartSeat()
              reachPropNow = aimed
              partSeatRequest = null
            }
          }
          // a contraption seat that has gone (undone, removed) stands you up
          if (partSeat !== null && !placePartSeat()) leavePartSeat()
          const sitting: Seat | null = seating.current ?? (partSeat !== null ? partSeatObj : null)
          // noclip speeds up with height, so orbit is seconds away (the
          // outside's last update measured it, one frame ago)
          walk.flyScale = outside.view.fly
          // the portals: the walls they are open in step aside for the body
          const portalsOn = !!portalWalk && !sitting && !rig.down && !levels.frozen
          if (portalsOn) portalWalk!.before()
          const step = walk.update({
            dt,
            keys: input.keys,
            // a downed body forfeits movement until it has stood back up, and
            // so does a seated one: the seat owns the lens until E gives it
            // back. Gravity and the crouch ease keep integrating either way
            frozen: levels.frozen || rig.down || !!sitting,
            groundY: level.groundY,
            groundAt: portalsOn ? portalWalk!.ground(level) : level.groundYAt,
            ceilingY: level.ceilingY,
            waterY: level.waterY,
            collision: level.collision,
            fovBase: prefsRef.current.fov,
          })
          // ...and whatever went into one comes out of the other
          if (portalsOn) portalWalk!.after(step.vx, step.vy, step.vz)
          // a fall that is too far to land lands you flat instead, carried on
          // with whatever speed you came in with
          if (step.landing > FALL_FLOP && !rig.down && !sitting && !godMode) {
            rig.flop(step.vx, Math.min(6, step.landing * 0.15), step.vz)
          }
          if (sitting) {
            // the walk wrote the standing eye over the cushion; put it back
            // at the height of somebody sitting on it, and hold the head
            // inside the arc the furniture implies
            if (partSeat !== null) placePartSeat()
            else {
              camera.position.copy(seating.eye(seatEye))
              const held = seating.hold(walk.yaw, walk.pitch)
              walk.yaw = held.yaw
              walk.pitch = held.pitch
              camera.rotation.set(held.pitch, held.yaw, 0)
            }
            poseSeated(sitting)
            rig.seatedTick(dt)
            // a/d works the set from the sofa, the way a remote does: a dark
            // tube wakes rather than skipping a channel it is not showing.
            // Only from a seat that faces it: the keys are free on every
            // cushion in the house, and the bed is not a remote control
            const chNow = (input.keys.has('KeyD') ? 1 : 0) - (input.keys.has('KeyA') ? 1 : 0)
            if (chNow && !chHeld && tv && sitting.atTv && !pausedNow) {
              tv.turn(chNow)
              setTvChannel(`${tv.channel.n} · ${tv.channel.label}`)
            }
            chHeld = chNow !== 0
          } else {
            chHeld = false
          }
          // the tool belt decides what the beam pulls toward before the props
          // step, so this frame's slices already pull. Only on foot, out in
          // the world, standing: a seat, a heap on the floor and the pause
          // sheet all holster it
          // (a body on your own beam is down on purpose: the beam keeps it)
          toolsLive = !!tools && !!sandbox && !sitting && (!rig.down || tools.physgun.holdsSelf) && fps && !rig.acting
          if (tools && !pausedNow) {
            const k = input.keys
            // the number keys pick emotes while the wheel is up, and the click
            // that played one is not also a shot (it is swallowed until the
            // button comes up)
            if (wheelSwallow && !held(k, 'grab') && !held(k, 'freeze')) wheelSwallow = false
            const gunsOff = wheel.open || wheelSwallow
            if (!wheel.open) {
              if (edges.pressed('slot1')) tools.select(0)
              else if (edges.pressed('slot2')) tools.select(1)
              else if (edges.pressed('slot3')) tools.select(2)
              else if (edges.pressed('slot4')) tools.select(3)
            }
            toolAim.eye.copy(camera.position)
            // from the head, at whatever is under the crosshair (resolveAim)
            resolveAim(camera.position, camera.quaternion, camera.getWorldDirection(toolAim.dir))
            toolAim.yaw = walk.yaw
            toolIn.dt = dt
            toolIn.fire = held(k, 'grab') && !gunsOff
            toolIn.alt = held(k, 'freeze') && !gunsOff
            toolIn.rotate = held(k, 'rotate') && !gunsOff
            toolIn.snap = held(k, 'snap')
            toolIn.reload = held(k, 'unfreeze')
            toolIn.wheel = gunsOff ? (input.takeWheel(), 0) : input.takeWheel()
            toolIn.lookX = toolLook.x
            toolIn.lookY = toolLook.y
            toolLook.x = toolLook.y = 0
            // the contraptions' keys, and the seat that drives one
            toolIn.keys = k
            toolIn.seat = partSeat
            tools.lang = langRef.current
            tools.update(toolIn, toolsLive)
            const tl = toolsLive && tools.tool === 'toolgun'
              ? `${tools.toolgun.state}|${tools.toolgun.aimedKeys ?? ''}`
              : ''
            if (tl !== toolLineNow) {
              toolLineNow = tl
              setToolLine(tl ? { state: tools.toolgun.state, keys: tools.toolgun.aimedKeys } : null)
            }
          }
          // the props: one fixed-step physics frame, the walker's shoves and
          // weight in, a ride carried out (it moves camera x/z, so it runs
          // before anything below reads the head)
          if (sandbox) {
            // a flyer goes through props like everything else, so nothing
            // is shoved and nothing is stood on
            const onFoot = !sitting && !walk.noclip
            const sbf = sandbox.tick({
              dt,
              active: !pausedNow,
              walker: onFoot
                ? {
                    eye: camera.position,
                    feetY: walk.feetY,
                    vx: step.vx,
                    vz: step.vz,
                    grounded: step.grounded,
                    step: EYE * 0.12,
                  }
                : null,
              focus: sandboxFocus(camera.position),
            })
            if (sbf.moving && level.outdoors) followSunShadow(camera.position, now)
            // a contraption seat moved in those slices: the lens and the body
            // go where it is drawn now, not where it was a frame ago
            if (partSeat !== null && sitting && placePartSeat()) poseSeated(sitting)
          }
          // other bodies: after the walk and the ride have moved the head and
          // before anything reads it. Not from a seat, a heap on the floor, a
          // level cut or noclip, where the walker is not a body anybody meets
          if (!sitting && !walk.noclip && !rig.down && !levels.frozen) {
            bodyExtent(body, myExtent)
            bumper.feetY = walk.feetY
            bumper.vx = step.vx
            bumper.vz = step.vz
            bumper.vy = step.vy
            bumper.grounded = step.grounded
            bumper.radius = myExtent.radius
            bumper.height = myExtent.height * (1 - 0.25 * walk.crouchK)
            remoteBumps.refresh()
            // the crowd only walks the overworld's streets
            bumpSets[0] = level.crowd ? outside.crowd : null
            bumpSets[1] = net ? remoteBumps : null
            contactIn.collision = level.collision
            contactIn.stepUp = step.grounded ? EYE * 0.12 : 0
            contactIn.now = now / 1000
            const cr = contact.step(contactIn)
            // a knock or a stomp lands with a thump off whoever it hit, a
            // puff of dust where it landed, the attacker's body folding with
            // the blow and a beat of hit-stop
            if (cr.knocks + cr.stomps > 0 && !pausedNow) {
              landThump('grass', cr.stomps ? 0.8 : 0.55)
              if (!Number.isNaN(cr.hitX)) {
                sandbox?.fx.dust({ x: cr.hitX, y: cr.hitY, z: cr.hitZ }, cr.stomps ? 1.3 : 1)
              }
              hitSquash = cr.stomps ? 12 : 9
              hitStop = HIT_STOP
            }
          }
          if (sandbox) {
            // the spawn pop: scale in over POP_S with an ease-out-back, so it
            // lands a hair big and settles, which is what reads as arriving
            for (let i = pops.length - 1; i >= 0; i--) {
              const pp = pops[i]
              pp.t += dt / POP_S
              const u = Math.min(1, pp.t)
              const c = 2.2
              pp.mesh.scale.setScalar(1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2))
              if (u >= 1) {
                pp.mesh.scale.setScalar(1)
                pops.splice(i, 1)
              }
            }
          }
          // the sim reports footfalls and touchdowns; the level says what is
          // underfoot (the backrooms are carpet wall to wall), and crouched
          // steps land softer. Outdoors the answer has two owners: the house
          // speaks for its own property — planks, porch slab, front walk,
          // lawn — and the open world for everything past the fence
          if (step.footfall || step.landing > 3) {
            const px = camera.position.x
            const pz = camera.position.z
            const surface = level.surfaceAt ? level.surfaceAt(px, pz, walk.feetY, step.wet) : 'stone'
            if (step.landing > 3) landThump(surface, Math.min(1, (step.landing - 3) / 14))
            else footstep(surface, step.gait * (1 - walk.crouchK * 0.65), step.run)
          }
          // the mid-air hop kicks a little cloud out from under the feet
          if (step.airHop) {
            worldEffects.airHop(camera.position.x, walk.feetY, camera.position.z)
            sandbox?.fx.cloud({ x: camera.position.x, y: walk.feetY, z: camera.position.z })
            spawnPop(0.4)
          }
          // the view is a saved preference the pause menu also owns, so the
          // boom just follows it and the camera key (bindings.ts) flips it;
          // x flops, and once the ragdoll settles, x or any move key stands
          // back up. Every key here is read through the key table
          chase.third = prefsRef.current.third || emoteCam
          if (edges.pressed('camera') && !levels.frozen) setPrefs((p) => ({ ...p, third: !p.third }))
          // and which shoulder it looks over
          if (edges.pressed('shoulder') && !levels.frozen && chase.third) shoulderSide = -shoulderSide
          // noclip: not from a chair, a heap on the floor or mid-cut
          if (edges.pressed('noclip') && !levels.frozen && !sitting) {
            standNow()
            setNoclip(!walk.noclip)
          }
          const flopNow = edges.pressed('ragdoll')
          const wantsUp =
            rig.ragdolling &&
            rig.settled &&
            (flopNow ||
              held(input.keys, 'forward') || held(input.keys, 'back') ||
              held(input.keys, 'left') || held(input.keys, 'right') || held(input.keys, 'jump'))
          // (not from a chair: the ragdoll would land on the floor while the
          // seat kept the lens on the cushion, watching an empty room; and not
          // in noclip, where there is nothing to fall onto)
          if (flopNow && !rig.down && !levels.frozen && !sitting && !walk.noclip) {
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
          // t or enter opens the console line and / opens it on a command;
          // q opens the catalogue and q again (or esc) closes it, and z takes
          // the last spawn back.
          // The console works alone, so none of these wait for a server
          if (!levels.frozen) {
            if (edges.pressed('chat')) openChat('')
            else if (edges.pressed('command')) openChat('/')
            if (edges.pressed('spawnMenu') && !sitting) setMenu(!menuNow)
            if (edges.pressed('undo')) undoLast()
          }
          // m arms the microphone, n swaps the talk mode, and g is held to
          // push to talk
          if (edges.pressed('mic') && voice?.available) {
            const arming = !voice.enabled
            void voice.toggle().then(() => {
              if (arming && voice?.enabled) track('world_voice')
            })
          }
          if (edges.pressed('talkMode') && voice?.enabled) voice.cycleMode()
          voice?.setPushing(held(input.keys, 'pushToTalk'))
          // b: the emote wheel, which stays up until something is picked.
          // The mouse swings its arrow and a click plays what it points at
          // (the hub plays nothing and stops whatever is playing), 1-9 play a
          // slice straight off, and b again, a right click or esc put it away
          // with nothing played. Not from a seat, a heap or a level cut, and a
          // pause puts it away too
          const actFree = !levels.frozen && !sitting && !rig.down && !pausedNow
          const closeWheel = () => {
            wheel.open = false
            setWheelOpen(false)
          }
          const playSlice = (slice: number) => {
            closeWheel()
            if (slice < 0) {
              rig.act(0)
              return
            }
            rig.act(EMOTES[slice].id)
            // out to third person to watch it, unless it is an upper-body one
            // begun on the move, where a swinging camera would only get in the
            // way of the walk
            emoteCam = EMOTES[slice].full || step.gait < 0.1
          }
          let digit = -1
          for (let i = 0; i < 9; i++) {
            const down = input.keys.has(`Digit${i + 1}`)
            if (down && !digitWas[i]) digit = i
            digitWas[i] = down
          }
          if (!wheel.open) {
            if (edges.pressed('emote') && actFree) {
              wheel.open = true
              wheel.x = wheel.y = 0
              setWheelOpen(true)
            }
          } else if (!actFree || edges.pressed('emote') || edges.pressed('freeze')) {
            closeWheel()
            wheelSwallow = true
          } else if (edges.pressed('grab')) {
            playSlice(wheelSlice(wheel.x, wheel.y, WHEEL_DEAD))
            wheelSwallow = true
          } else if (digit >= 0 && digit < EMOTES.length) {
            playSlice(digit)
          }
          // and back in when it ends, or once an upper-body one is walked on
          if (emoteCam && (!rig.acting || (!rig.actFull && step.gait > 0.15))) emoteCam = false
          // the body plants its feet under the camera and faces the walk
          // (or hangs from it, mid-hop), unless the ragdoll owns it, or a
          // seat does: a sitter's body was placed on the cushion when they
          // sat down and holds `rig.sit()`'s one pose until they get up,
          // which is the same deal the vehicles' chairs get
          if (!rig.ragdolling && !sitting) poseBody()
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
          rigPose.landing = step.landing + hitSquash
          hitSquash = 0
          rigPose.fly = step.flying ? 1 : 0
          // same factor as poseBody's trailing offset: a crushed boom means
          // the lens is back on the head, so the flair fades out with it
          rigPose.show = Math.min(1, chase.dist / 1.2)
          // the physgun out: the right arm comes up and carries it
          rigPose.aim = toolsLive && tools && tools.tool !== 'hands' ? 1 : 0
          rigPose.aimLoad = tools?.physgun.holding ? tools.physgun.view.strain : 0
          // f (or the middle button) held: the right arm points at whatever the
          // crosshair is on. Not with a gun out, whose grip already has that
          // arm, and not from under the wheel
          const pointing = held(input.keys, 'point') && actFree && !wheel.open && !rigPose.aim
          rigPose.point = pointing ? 1 : 0
          if (pointing !== pointHudNow) {
            pointHudNow = pointing
            setPointHud(pointing)
          }
          if (pointing) {
            resolveAim(camera.position, camera.quaternion, camera.getWorldDirection(pointDir))
            // (from a little out along the ray, clear of the walker's own
            // capsule, which a ray from inside the head hits first and which
            // turned the first point into a salute)
            pointAt.copy(camera.position).addScaledVector(pointDir, POINT_SKIP)
            const hit = sandbox?.raycast(pointAt, pointDir, POINT_REACH)
            pointAt.addScaledVector(pointDir, hit ? hit.distance : POINT_REACH)
            pointAt.sub(rig.limbPos(shoulderLimb, pointFrom))
            rigPose.pointYaw = Math.atan2(-pointAt.x, -pointAt.z)
            rigPose.pointPitch = Math.atan2(pointAt.y, Math.hypot(pointAt.x, pointAt.z))
          }
          // the ragdoll and the boom both work in a few units around the
          // body, so one terrain sample under it is the floor for both —
          // they never need the whole heightfield, only the local plane
          const localFloor = floorOf(level, camera.position.x, camera.position.z)
          rigEnv.groundY = localFloor
          // a body tumbling down a hillside needs the hill under each limb,
          // not the plane under where it started
          rigEnv.groundAt = level.groundYAt
          rigEnv.ceilingY = level.ceilingY
          rigEnv.collision = level.collision
          // somebody's beam on us: ease the pinned limb toward their stream
          // and let go of a hold that went quiet, ran out or became impossible
          grabTaker.tick(now / 1000, dt, grabAble())
          if (!sitting) rig.update(rigPose, rigEnv)
          bumper.npts = !sitting && !rig.ragdolling && bumper.pts
            ? posedPoints(rig, camera.position.x, walk.feetY, camera.position.z, bumper.pts)
            : 0
          // --- everyone else ------------------------------------------------
          // Say where we are, play the others back a couple of ticks in the
          // past, and put their voices where their bodies ended up. All of it
          // runs while the camera is still the head: the boom only borrows it
          // further down, and a listener parked on the boom would hear the
          // world from somewhere behind your own back.
          if (net) {
            // a heap on the floor (or on a beam) is where its chest is: the
            // walker stays frozen where the body went down
            const heap = rig.ragdolling ? rig.limbPos(chestLimb, heapPt) : null
            net.move(
              heap ? heap.x : camera.position.x,
              heap ? heap.y : walk.feetY,
              heap ? heap.z : camera.position.z,
              walk.yaw,
              walk.pitch,
              step.gait,
              packPose({
                grounded: step.grounded,
                run: step.run,
                // the wire has no pose for "sitting on the sofa", and crouched
                // is the one it does have that is not a lie about your height
                crouch: step.duck || !!sitting,
                swimming: step.swimming,
                speaking: Boolean(voice?.speaking),
                down: rig.down,
                fly: step.flying,
                held: grabTaker.held && rig.ragdolling,
              }),
              rig.acting,
              rig.actAge,
              pointing ? rigPose.pointYaw : NaN,
              pointing ? rigPose.pointPitch : NaN,
            )
            remote.sample(now, dt)
            avatarEnv.collision = level.collision
            avatarEnv.ceilingY = level.ceilingY
            avatars.update(remote, dt, avatarEnv)
            remoteGrabs.tick(dt)
            voice?.update(remote.players, camera, dt)
            if (remote.players.size !== hereNow) {
              hereNow = remote.players.size
              setMp((m) => ({ ...m, here: hereNow }))
            }
          }
          // doors easing upstairs, chunks streaming below — whichever side
          // the player is on, both worlds keep their pulse
          level.update(dt, camera.position)
          syncCollisionSet(level.collision)
          // the player is the only moving shadow caster: re-bake just the
          // lights that can see them, only on frames where they moved (the
          // rig speaks up for motion the walker can't see: ragdoll, springs)
          if (propSwing > 0) propSwing -= dt
          // a leaf still swinging counts as movement for the baked maps, even
          // when the player who opened it has not shifted a foot
          const bodyMoved = step.moved || rig.unrest() || propSwing > 0
          if (bodyMoved) {
            // generous regions: a map must keep re-baking until the player is
            // fully out of its light's frustum, or their shadow strands there
            if (level.house) {
              flagDeskShadows(camera.position)
              house.flagShadows(camera.position)
            }
            // The sun's program stays invariant now, but its hand-managed map
            // still follows a genuinely moving caster, on the error gate and not
            // on every frame. See followSunShadow.
            if (level.outdoors) followSunShadow(camera.position, now)
          }
          // the television has no spatialiser, being an iframe rather than a
          // buffer on our own context, so its loudness is the listener's distance,
          // taken here while the camera is still the head rather than after
          // the boom has borrowed it
          tv?.update(camera.position)
          // the soundtrack and the world's own sound (game/music), read off
          // facts this frame already has. The two samples of the ground are
          // the expensive part, so they are taken twice a second
          musicAsk -= dtWall
          if (musicAsk <= 0) {
            musicAsk = 0.5
            const p = camera.position
            const earth = levels.current.id === 'overworld' && outside.hasWorld()
            musicBiome = earth ? outside.biomeAt(p.x, p.z) : null
            let wet = 0
            if (earth) {
              for (let k = 0; k < 8; k++) {
                const a = (k / 8) * Math.PI * 2
                if (outside.groundYAt(p.x + Math.cos(a) * 28, p.z + Math.sin(a) * 28) < outside.waterY) wet++
              }
            }
            musicShore = wet / 8
          }
          {
            const sk = lastSky as OutsideState | null
            const indoor = sk?.indoor ?? 1
            updateMusic({
              level: levels.current.id,
              indoor,
              day: sk?.day ?? 1,
              night: sk?.night ?? 0,
              twilight: sk?.twilight ?? 0,
              biome: musicBiome,
              alt: outside.view.alt,
              space: outside.view.space,
              // widened: an early return above narrows the live binding
              vehicle: ((fleet as VehicleFleet).driving ?? (fleet as VehicleFleet).riding)?.id ?? null,
              shore: musicShore,
              underwater: levels.current.id === 'overworld' && outside.hasWorld() && camera.position.y < outside.waterY - 0.3,
              paused: pausedNow,
              musicVol: prefsRef.current.musicVol,
              ambVol: prefsRef.current.ambVol,
              // a television playing in the room gets the room
              duck: tv?.on && indoor > 0.5 ? 1 : 0,
            }, dtWall)
          }
          // close to the tube and facing it: offer the interact prompt
          toScreen.subVectors(gCenter, camera.position)
          const dist = toScreen.length()
          // and the computer is the same kind of speaker as the television:
          // whatever the browser's window is playing has to come from the desk
          // rather than from inside your head once you have walked away from it
          setPcListenerDistance(dist)
          camera.getWorldDirection(gazeVec)
          // over the shoulder, what the crosshair is on rather than what the
          // head faces: every prompt and E below answers to the same aim
          resolveAim(camera.position, camera.quaternion, gazeVec)
          // still the head here — chase.apply() only borrows the camera below
          headPos.copy(camera.position)
          headDir.copy(gazeVec)
          // what the crosshair is on: one props-only ray a frame, mirrored
          // into React only when the answer changes
          {
            const hit = sandbox && !rig.down
              ? sandbox.raycast(headPos, headDir, AIM_REACH, { world: false })
              : null
            reachPropNow = hit?.prop && hit.distance < 7 ? hit.prop.id : null
            // the physgun holding something outranks whatever the ray finds
            const a: CrosshairAim = tools?.physgun.holding
              ? 'held'
              : hit?.prop ? (hit.prop.mode === 'frozen' ? 'frozen' : 'prop') : 'none'
            if (a !== aimNow) {
              aimNow = a
              setAim(a)
            }
          }
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
            isNear || rig.down || !level.house
              ? null
              : house.doorPrompt(camera.position, gazeVec) ??
                outside.doorPrompt(camera.position, gazeVec)
          if (verb !== doorVerbNow) {
            doorVerbNow = verb
            setDoorVerb(verb)
          }
          /*
            ...and under the doors, the house's own furniture. Three things
            answer here and they are asked in the order you would reach for
            them: the television's buttons, then a cupboard's handle, then the
            cushion of whatever you are standing in front of. Sitting down is
            last because a seat is a big target and a drawer beside it is a
            small one; a seat that outranked the drawer would swallow it.
          */
          const propVerb =
            isNear || verb || rig.down || sitting
              ? null
              : (level.house
                  ? tvVerb(tv?.prompt(camera.position, gazeVec) ?? null) ??
                    fittingVerb(house.propPrompt(camera.position, gazeVec)) ??
                    sitVerb(seating.prompt(camera.position, gazeVec))
                  : null) ??
                // a contraption seat in reach, in any level with a sandbox
                (reachPropNow !== null && !walk.noclip && tools?.contraption.isSeat(reachPropNow)
                  ? 'sit in the seat'
                  : null)
          if (propVerb !== propVerbNow) {
            propVerbNow = propVerb
            setPropVerb(propVerb)
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
            outdoors: !!level.vehicles,
          })
          // somebody else's car coming down the street at you: the watch
          // knows how fast it is going, and a seat or a level cut is immune
          impacts.track(fleet.all, pausedNow ? 0 : dt)
          feetPt.set(camera.position.x, walk.feetY, camera.position.z)
          if (
            !sitting && !levels.frozen &&
            impacts.strike(rig, feetPt, EYE * 1.15, rig.mass, impact)
          ) {
            rig.hit(impact.impulse, impact.point)
          }
          if (level.crowd) outside.knockPeople(impacts)
          // ...and its prompt is the lowest-priority one: the machine and a
          // door both win, because both are things you are standing right at
          // (and not to a flyer: a car offered to somebody passing overhead
          // at thirty units a second is noise)
          const atVehicle =
            isNear || verb || propVerb || sitting || rig.down || levels.frozen || walk.noclip
              ? null
              : fs.prompt
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
          // over the shoulder, whichever one: the body stands in the left (or
          // right) third of the frame and the crosshair stays dead centre,
          // clear of it (chaseCam.ts; the aim follows it in resolveAim)
          // an emote is watched square on, the body in the middle of the frame
          chaseEnv.shoulder = emoteCam ? 0 : SHOULDER * shoulderSide
          // the head's own climb or fall, which the boom follows rigidly
          chaseEnv.vy = sitting ? 0 : step.vy
          chase.apply(camera, dt, chaseEnv)
          // the gun and the beam go where the lens ended up: in the hand of
          // the body when the boom is out, in front of the lens when it is not
          if (tools) {
            const third = chase.dist > 1.2
            if (third && handR >= 0) rig.limbPos(handR, toolHand)
            if (third && handL >= 0) rig.limbPos(handL, toolHandL)
            tools.present({
              camera, dt, gait: step.gait, grounded: step.grounded,
              firstPerson: !third, hand: third ? toolHand : null, handL: third ? toolHandL : null,
              active: toolsLive && !pausedNow, lines: look.knobs.lines,
            })
          }
          debugTick(level, camera.position.x, walk.feetY, camera.position.z)
          render()
          raf = requestAnimationFrame(walkTick)
        }

        /*
          The world the walk will eventually be handed, built while there is
          still a cover over the scene's very first frame.

          The visible inner rings are ready before either entrance draws;
          distant terrain streams under the ordinary frame budget.

          It deliberately does *not* sweep every chunk through a first draw.
          That was tried: a one-pixel viewport through four headings pulled
          nearly four seconds of shader setup into one lump. The direct /world
          entrance has one narrower exception below: its opening view faces the
          computer, and its exact reverse view measured a 633 ms first-turn
          stall on the reference GPU. One rear-heading draw pays only that
          known cold view under BootCover after the ordinary bake has given the
          driver time to finish; every other heading still lets the frustum do
          its job.

          The sun's shadow warm-up is different, and worth the paragraph.

          The old sky switched `castShadow` itself at the indoor and daylight
          thresholds. That changed every lit surface's shader configuration;
          the front door or the first sunset could therefore ask the driver to
          link nineteen programs in one frame, measured at 2.8 seconds. The
          flag is now stable and only a uniform strength changes, but the
          depth half of the shader pile still needs one real draw up front.

          So compile the sun-lit surface variants asynchronously, then do one
          render with the sun map flagged into a one-pixel viewport. The depth
          programs only exist when Three performs a real shadow pass, so
          compileAsync alone cannot cover them. The car's headlight count is
          stable through day and night: one layout and one bake cover both.
        */
        const warmCam = new THREE.PerspectiveCamera(110, 1, 0.1, 900)
        const warmSize = new THREE.Vector2()
        /** the fleet is put down once during the covered warm-up and stays
            where the player leaves it for the rest of the session */
        let fleetPlaced = false
        /**
         * Bring in the planet: `src/game/world/*` and the vehicle registry,
         * both behind dynamic imports, then swap the null fleet for the real
         * one. Idempotent — `outside.attachWorld()` dedupes its own promise and
         * the fleet is only built on the transition — so the front door, the
         * /world boot and anything added later can all just await it.
         *
         * Deliberately NOT part of warmForRoam: the warm-up is a rendering
         * concern that also runs on paths where the world already exists, while
         * this is the one place the world comes into being.
         */
        /*
          One props sandbox per level that declares one (types.ts's
          LevelSandbox), made the first time the player is there and kept for
          the session: props left in the street are still in the street after
          a trip to the Moon, and the Moon's crates fall at the Moon's rate.
          `sandbox` is always the live level's, and the belt, the undo stack
          and the dev handle follow it across a cut (switchSandboxTo).
        */
        let sandboxMod: typeof import('../../game/sandbox/sandbox') | null = null
        const sandboxFor = (level: Level): Sandbox | null => {
          if (!level.sandbox || !sandboxMod || !scene) return null
          const have = sandboxes.get(level.id)
          if (have) return have.sb
          const mod = sandboxMod
          const o = level.sandbox
          const sb = mod.createSandbox({
            parent: scene,
            collision: level.collision,
            ground: o.ground,
            waterY: o.waterY,
            waveAt: o.waveAt,
            splash: o.splash,
            chunkSolids: o.chunkSolids,
          })
          sandboxes.set(level.id, { sb, level })
          propNet.attach(sb, level.id)
          sb.gravity = -GRAVITY * rules.gravity * gravityOf(level)
          sb.timescale = rules.timescale
          const h = historyOf(sb)
          h.me = remote.you ?? LOCAL
          h.onChange(() => {
            if (history === h) setOrders(h.entries(h.me).map((e) => ({ seq: e.seq, label: e.label, kind: e.kind })))
          })
          // the buildings come apart: blasts, rubble, the car and the
          // console all reach them through the world's ruins
          const ruins = o.ruins?.()
          if (ruins) mod.attachDestruction(sb, ruins)
          // a blast knocks down whoever it reaches: the walker (not from a
          // seat, not mid-cut) through the same rig.hit a car uses, and the
          // town's pedestrians through the same seam. The maths is the
          // sandbox's (explosion.ts), so the film harness agrees with this
          sb.onExplosion((e) => {
            if (sandbox !== sb) return
            if (!seating.current && partSeat === null && !levels.frozen && !fleet.driving && !godMode && !walk.noclip) {
              feetPt.set(camera.position.x, walk.feetY, camera.position.z)
              if (mod.blastImpact(e, feetPt, EYE * 1.15, rig.mass, impact)) {
                rig.hit(impact.impulse, impact.point)
              }
            }
            if (levels.current.crowd) outside.knockPeople(mod.blastWatch(e))
          })
          return sb
        }
        /** make the live level's sandbox the one everything talks to */
        const switchSandboxTo = (level: Level) => {
          const next = sandboxFor(level)
          if (next === sandbox) return
          sandbox = next
          // a level's props are drawn only while it is live
          for (const { sb } of sandboxes.values()) sb.root.visible = sb === next
          history = next ? historyOf(next) : null
          const h = history
          setOrders(h ? h.entries(h.me).map((e) => ({ seq: e.seq, label: e.label, kind: e.kind })) : [])
          for (const pp of pops) pp.mesh.scale.setScalar(1)
          pops.length = 0
          if (next) tools?.setSandbox(next)
          else tools?.holster()
          // dev only: the harnesses (and a console) reach the live sandbox
          // and the lens it is being watched through from here, and can type
          // into the console: `await __sandbox.run('spawn crate 10')`
          // resolves with the lines it printed, in English
          if (import.meta.env.DEV && next) {
            const run = async (line: string) =>
              (await sbConsole.run(line)).map((l) =>
                l.right === undefined ? sayIn(l.text, 'en') : `${sayIn(l.text, 'en')} ... ${sayIn(l.right, 'en')}`)
            Object.assign(window, { __sandbox: Object.assign(next, { run, console: sbConsole }) })
          }
        }
        const loadWorldModules = () => Promise.all([
          import('../../game/vehicles/registry').then(async (registry) => {
            await registry.preloadVehicleEnvironment()
            return registry
          }),
          import('../../game/sandbox/sandbox'),
          import('../../game/sandbox/tools/toolbelt'),
        ])
        let worldReady: Promise<void> | null = null
        const ensureWorld = () => {
          worldReady ??= (async () => {
            const [, [registry, sbMod, toolsMod]] = await Promise.all([
              outside.attachWorld(),
              loadWorldModules(),
            ])
            if (disposed || !scene) return
            sandboxMod = sbMod
            // the world draws the yard's ground from here on
            house.worldGround()
            // synchronous and cheap: Rapier itself downloads behind it and
            // nothing waits for it. Its material is in the scene now, so the
            // covered compile in warmForRoam links it with everything else.
            // The first sandboxed level's (the overworld's) is made here
            // whatever level is live, because the belt needs one to be built
            // around
            const first = sandboxFor(homeLevels.find((l) => l.sandbox)!)!
            // the belt's gun, beam and halo materials are in the scene from
            // here; warmForRoam stages them in front of its camera so the
            // covered compile and first draw pay for them, and the first grab
            // of a walk links nothing
            tools = toolsMod.createToolbelt({
              sb: first,
              parent: scene,
              // the town's crowd, and the other players through the wire
              rigs: function* () {
                yield* outside.people()
                if (net) yield* remoteGrabs.rigs()
              },
              // the parked machines: read through the binding, so the real
              // fleet, built a few lines down, is the one the beam asks
              vehicles: {
                pick: (eye, dir, within) => fleet.pick(eye, dir, within),
                take: (key, sb) => fleet.take(key, sb),
              },
              // the portals: their ovals and views, what a shot can land on
              // in the live level, and the sky's answer to a shot at nothing
              renderer: webgl,
              portalWorld: () => {
                const lv = levels.current
                if (!lv.sandbox || !sandbox) return null
                return {
                  level: lv.id, collision: lv.collision, groundAt: lv.groundYAt, groundY: lv.groundY,
                  waterY: lv.waterY, sandbox, meshesNear: portalMeshes, drawnHit: portalHouseHit,
                }
              },
              portalElsewhere: (color, eye, dir) => portalSky(color, eye, dir),
              // your own body, which the physgun may take only through a
              // portal (the one place you can see it from)
              self: () => (seating.current || fleet.riding ? null : { key: 'self', rig }),
            })
            tools.setHandColor(lookRef.current.shell)
            worldEffects.attach(tools.portals)
            portalWalk = toolsMod.createPortalWalk({
              portals: tools.portals,
              walk,
              eye: camera.position,
              level: () => levels.current,
              changeLevel: (to, c) => portalLevel(to, c),
              carried: () => {
                // this frame's lens is the carried one, not last step's turn
                camera.rotation.set(walk.pitch, walk.yaw, 0)
                chase.drop()
                rig.reset()
                rig.face(walk.yaw)
                headPos.copy(camera.position)
              },
            })
            portalMoon = toolsMod.createPortalMoon({
              portals: tools.portals,
              link: { ...outside.moonPortal, ground: outside.moon.groundYAt, obstacles: outside.moon.obstacles },
              view: tools.portalView,
              material: toolsMod.portalWorldMaterial('#34373d', 0.9, 0.05),
              renderer: webgl,
              onSolids: () => sandboxes.get('moon')?.sb.solidsChanged(),
            })
            switchSandboxTo(levels.current)
            // the catalogue's data, off the same lazily loaded kind table
            void Promise.all([
              import('../../game/sandbox/spawnlist'),
              import('../../game/sandbox/kinds'),
            ]).then(([list, kinds]) => {
              if (disposed) return
              // the props, and the fleet as a section of its own at the end
              let fleetPics: Promise<Map<string, string>> | null = null
              setCatalogue({
                entries: () => [
                  ...list.spawnlist(),
                  ...fleet.all.map((v) => ({
                    id: `${FLEET_PREFIX}${v.id}`,
                    category: 'vehicles',
                    label: v.label,
                    labelEs: VEHICLE_ES[v.id],
                  })),
                  // the tools the belt does not start with
                  { id: `${TOOL_PREFIX}portalgun`, category: 'tools', label: 'portal gun', labelEs: 'pistola de portales' },
                ],
                categories: (entries) => [
                  ...list.spawnCategories(entries),
                  ...(fleet.all.length ? [{ id: 'vehicles', label: 'vehicles', labelEs: 'vehículos' }] : []),
                  { id: 'tools', label: 'tools', labelEs: 'herramientas' },
                ],
                kind: (id) => kinds.KINDS[id],
                note: list.kindNote,
                thumbs: () => {
                  fleetPics ??= import('../../game/vehicles/thumbs').then((m) => m.renderFleetThumbs(fleet.all))
                  const toolPics = import('../../game/sandbox/tools/portalThumb').then((m) =>
                    new Map([[`${TOOL_PREFIX}portalgun`, m.portalGunThumb(96)]]))
                  return Promise.all([list.spawnThumbs(), fleetPics, toolPics]).then(([a, b, c]) => new Map([...a, ...b, ...c]))
                },
              })
            })
            if (import.meta.env.DEV) {
              Object.assign(window, {
                __sandboxCamera: camera,
                // the walk's yaw and pitch, which a headless drive cannot
                // steer any other way (it is never granted the pointer lock)
                __sandboxWalk: walk,
                __sandboxRig: rig,
                // the emote wheel's cursor, which a headless drive cannot move
                // with a mouse it was never given the lock for
                __emoteAim: (x: number, y: number) => {
                  wheel.x = x
                  wheel.y = y
                  wheelApi.current?.aim(x, y)
                },
                __tools: tools,
                __worldEffects: worldEffects,
                __portalWalk: portalWalk,
                __portalMoon: portalMoon,
                __portalHouseHit: portalHouseHit,
                // scripted contraptions (a car, a rocket, a hovercraft), through
                // the app's own module graph so they share its contraptions
                __contraptionBuild: () => import('../../game/sandbox/contraption/build'),
                // the shared walk, for a two-client drive: the keys (the
                // physgun's trigger is a mouse button only a locked pointer
                // reports), who else is here and what their beams are doing
                __input: input,
                __remote: remote,
                __avatars: avatars,
                __grabTaker: grabTaker,
                // the view from the air: what the fog, the far field and the
                // look's air are doing right now (levels/altitude.ts)
                __outside: outside,
                __look: look,
                __scene: scene,
                __renderer: webgl,
                // which level is live, for a drive that crosses a seam
                __levels: levels,
                // every solid the walk collides with, for a harness sweeping
                // a door leaf through its swing against the furniture
                __obstacles: obstacles,
                // the house's doors and cushions, for a harness sitting on
                // every seat and opening every door from both sides
                __house: house,
                __seat: { seating, take: takeSeat, leave: leaveSeat },
                // the fleet's world, for a harness recalling a machine
                __fleetEnv: () => aimFleetEnv(levels.current.vehicles ? levels.current : fleetLevel()),
              })
              // the fleet through its binding: the real one is built below
              Object.defineProperty(window, '__fleet', { get: () => fleet, configurable: true })
            }
            fleet = registry.buildFleet({
              scene,
              obstacles,
              // the Moon's collision set too: the fleet runs there as well
              alsoIn: [outside.moon.obstacles],
              levelAt: fleetLevelAt,
              trackTexture: disposer.texture,
              trackDisposable: disposer.add,
            })
            // the sky has been running since the first frame; hand the freshly
            // built machines the day it is actually painting, or their paint and
            // headlamps arrive one frame's worth of "midday" behind
            if (lastSky) fleet.setDay(lastSky.day, lastSky.night, lastSky.fogColor, lastSky.sunEl)
            fleet.setNet(fleetNetState)
          })()
          return worldReady
        }
        /**
         * The world arriving mid-session, behind the boot cover.
         *
         * StepOutCover animates on the compositor while shader programs link.
         * The walk sleeps during this cut so it cannot render partially warmed
         * materials or move the player through a world still being built.
         *
         * Idempotent through `worldReady`, so the door, the walk-out backstop
         * and a second press all land on one load.
         */
        let loadingWorld = false
        const loadWorldCovered = async () => {
          if (outside.hasWorld() || loadingWorld) return
          loadingWorld = true
          stageRef.current?.('stepping')
          try {
            await ensureWorld()
            if (disposed) return
            await warmForRoam(camera.position.clone())
          } finally {
            loadingWorld = false
            if (!disposed) stageRef.current?.(null)
          }
        }
        /**
         * Bake the sun's shadow map once, under the cover.
         *
         * The sun is hand-managed (`shadow.autoUpdate = false`) like every other
         * light in here, but it is NOT in bakeShadowsCovered's list — its one
         * guaranteed bake used to be a side effect of warmForRoam, which every
         * 3D boot ran. Once the room stopped loading the world, an ordinary boot
         * stopped baking it, and a sun with no shadow map does not read as "no
         * shadows": sky.ts damps the indoor ambience on the assumption that the
         * house shell is casting, so the interior renders torched to flat
         * daylight — the room reads as an empty blue-grey void.
         *
         * It belongs to the room, not to the world, so it runs on every boot.
         */
        const bakeSunCovered = () => {
          if (!webgl || !scene) return
          outside.sun.shadow.needsUpdate = true
          render()
        }
        /** the fleet's meshes unculled for the warm's sun pass */
        const warmUnculled: THREE.Object3D[] = []
        const warmForRoam = async (at: THREE.Vector3) => {
          await ensureWorld()
          if (disposed) return
          // Build the visible inner rings. Distant chunks keep their normal
          // streaming budget instead of adding 200 ms to every first exit.
          outside.prime(at.x, at.z)
          if (!webgl || !scene) return
          // Constructors leave all three machines at (0,0,0), hidden by the
          // fleet root. Terrain and collision now exist, so place them before
          // compiling or drawing anything the player can later meet outside.
          if (!fleetPlaced) {
            fleetPlaced = true
            fleet.spawnAll(aimFleetEnv(fleetLevel()))
            // the welcome can beat the warm-up: if the server already told us
            // where the machines are, spawnAll has just put them back on the
            // home spots and this puts them where they really are
            placeFleetFromNet()
          }
          // Stand at the actual front door, not at the bedroom spawn's x. The
          // exact live lighting state and caster set at this threshold are the
          // things this warm-up exists to pay for.
          // (on the ground: `at` is the spawn, which is upstairs)
          warmCam.position.set(FRONT_DOOR_X, EYE, HOUSE.minZ - 1.25)
          warmCam.rotation.set(0, 0, 0)
          warmCam.updateMatrixWorld(true)
          // This render bypasses render()'s light pass, so compose the day
          // cycle at the warm camera. That also anchors the hand-managed sun
          // map here, letting the first real doorway frame reuse it.
          applyLight(warmCam.position)
          // the tool belt's gun, beam, glows and rim shells, in front of the
          // warm camera for the compile and the one-pixel draw below
          tools?.stage(warmCam)
          avatars.stage(warmCam)
          // ...and the globes (the planet from orbit and the Moon), so the
          // first climb out of the air links nothing mid-flight
          outside.warmSpace(true)
          try {
            // The initial compile ran before the streamed chunks existed.
            // Compile their live outdoor lighting variant now; the promise
            // lets the driver link in
            // parallel while BootCover continues animating on the compositor.
            await webgl.compileAsync(scene, warmCam).catch(() => {})
            if (disposed || !webgl || !scene) return
            webgl.getSize(warmSize)
            webgl.setScissorTest(true)
            webgl.setScissor(0, 0, 1, 1)
            webgl.setViewport(0, 0, 1, 1)
            outside.sun.shadow.needsUpdate = true
            // Warm every machine's depth variants, including those parked
            // outside this camera's frustum (they can be delivered anywhere).
            fleet.root.traverse((o) => {
              if ((o as THREE.Mesh).isMesh && o.frustumCulled) {
                o.frustumCulled = false
                warmUnculled.push(o)
              }
            })
            webgl.render(scene, warmCam)
          } finally {
            for (const o of warmUnculled) o.frustumCulled = true
            warmUnculled.length = 0
            tools?.unstage()
            avatars.unstage()
            outside.warmSpace(false)
            if (webgl) {
              webgl.setScissorTest(false)
              webgl.setViewport(0, 0, warmSize.x, warmSize.y)
            }
          }
        }

        /**
         * Pay the room's first draw into a one-pixel viewport.
         *
         * Every lens into this scene opens facing the computer. The /world
         * entrance stands there, an ordinary boot flies the intro into the
         * glass and parks, so the furnished house *behind* the camera has
         * never crossed a frustum. compileAsync links a material's programs but
         * does not run WebGLProgram's onFirstUse and does not upload a
         * geometry's buffers; both happen on the first draw that touches them,
         * and the visitor who stands up and turns round pays the whole room in
         * the frames they turn through. Measured on an RTX 4070: one 180-degree
         * turn cost five frames of 123-137 ms carrying 897 bufferData calls and
         * five program links, with every other frame of the session at a locked
         * 16.7 ms.
         *
         * Rather than guess which headings hide that cost, drop frustum culling
         * for the one render. An unculled object is submitted whichever way the
         * camera points, so a single pass touches every mesh in the room exactly
         * once and no heading is left cold, which is what the old rear-only
         * draw could not promise, and what made the even older four-heading
         * sweep expensive. The outside stays hidden throughout: without
         * occlusion culling an unculled world would submit the whole planet
         * through the back wall, which is the trade that sweep lost on. Lights
         * remain live so the house gets its real shader layout, and the player's
         * body joins in, because it is invisible until the stand-up glide ends and
         * would otherwise upload its rig on the frame it appears.
         */
        const isDrawable = (o: THREE.Object3D) =>
          (o as THREE.Mesh).isMesh ||
          (o as THREE.Points).isPoints ||
          (o as THREE.Line).isLine ||
          (o as THREE.Sprite).isSprite
        const warmRoomDraw = (at: THREE.Vector3, aim: { pitch: number; yaw: number }) => {
          if (!webgl || !scene) return
          warmCam.fov = prefsRef.current.fov
          warmCam.aspect = W / H
          warmCam.rotation.order = 'YXZ'
          warmCam.updateProjectionMatrix()
          warmCam.position.copy(at)
          warmCam.rotation.set(aim.pitch, aim.yaw, 0)
          warmCam.updateMatrixWorld(true)
          applyLight(warmCam.position)
          webgl.getSize(warmSize)
          const hiddenOutside: THREE.Object3D[] = []
          outside.root.traverse((object) => {
            if (object.visible && isDrawable(object)) {
              object.visible = false
              hiddenOutside.push(object)
            }
          })
          // after the outside is down, so its meshes are skipped here; a
          // subtree that is hidden for another reason (the sleeping backrooms)
          // is skipped too, and stays somebody else's cold start
          const unculled: THREE.Object3D[] = []
          scene.traverse((object) => {
            if (object.visible && object.frustumCulled && isDrawable(object)) {
              object.frustumCulled = false
              unculled.push(object)
            }
          })
          const bodyWas = body.visible
          body.visible = true
          try {
            webgl.setScissorTest(true)
            webgl.setScissor(0, 0, 1, 1)
            webgl.setViewport(0, 0, 1, 1)
            webgl.render(scene, warmCam)
          } finally {
            body.visible = bodyWas
            for (const object of unculled) object.frustumCulled = true
            for (const object of hiddenOutside) object.visible = true
            webgl.setScissorTest(false)
            webgl.setViewport(0, 0, warmSize.x, warmSize.y)
          }
          // and repaint the picture this just destroyed. The context has no
          // preserveDrawingBuffer (nothing that renders every frame wants to
          // pay for one), so the browser is free to blank the buffer after it
          // composites a frame, and it does. Rendering one scissored pixel
          // into it therefore does not leave the other few million alone: it
          // presents a frame that is transparent everywhere except that pixel.
          // On the ordinary boot that lands while the camera is PARKED, so
          // nothing was ever going to draw again, and the visitor watched the
          // whole computer vanish a second after their boot screen came up,
          // leaving the CSS3D screen floating in the dark on its own. The room
          // survived because the room is not what got cleared; the picture of
          // it was.
          render()
        }
        /**
         * The same warm-up, off the boot's critical path.
         *
         * /world has to pre-pay it under BootCover because it opens standing and
         * the visitor can turn immediately. An ordinary boot cannot afford that:
         * building only the room is what took this route from 11.4 s to 4.1 s,
         * and half a second of scenery nobody has asked for yet would be spent
         * straight back. But that boot ends *parked on the glass*, and while the
         * camera is parked nothing 3D renders at all: the screen is live DOM
         * and the visitor is reading a login form. That idle window is free, and
         * it is always several seconds long, because standing up means logging
         * in first.
         *
         * requestIdleCallback with a timeout is exactly the contract wanted:
         * take a quiet moment if there is one, take it anyway if there isn't.
         * The flag is set on completion, not on scheduling, so a boot torn down
         * mid-wait leaves nothing half-warmed behind.
         */
        let roomWarmed = false
        const warmRoomWhenIdle = () => {
          if (roomWarmed || disposed) return
          const run = () => {
            if (disposed || roaming || leaving || !webgl || !scene) return
            roomWarmed = true
            warmRoomDraw(SPAWN, lookAngles(SPAWN, front))
          }
          if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2500 })
          else setTimeout(run, 900)
        }

        const startRoam = (instant = false, spawnShadowsReady = false) => {
          if (!webgl || roaming) return
          roaming = true
          parked = false
          cancelAnimationFrame(raf)
          setIntro(false) // in case the intro flight was still going
          // Standing up is the first sign somebody might go outside. Fetch the
          // world's modules now — pure I/O, no building, so it costs no frame —
          // and the covered wait at the front door is then only the build and
          // the shader compile rather than the download as well.
          outside.preloadWorld()
          void loadWorldModules().catch(() => {})
          webgl.domElement.style.pointerEvents = 'auto'
          input.setCursor('grab')
          // with the OS still running the tube keeps spilling light
          spill.intensity = liveRef.current ? 1.0 : 0
          // fresh roam, fresh resolution budget and a limiter deadline that
          // is not still holding a timestamp from the last one. The ceiling is
          // recomputed rather than reused: the dial is reachable from the
          // pause sheet, and a pause can end in sitting down as easily as in
          // resuming, so it may well have moved since the last roam
          prScale = prefsRef.current.scale
          prCeil = prScale
          pr = prCeil
          emaMs = 16
          prWait = 1.5
          nextFrame = 0
          look.setScale(pr)
          // announce ourselves while the stand-up glide plays, so the roster
          // and the first snapshots have landed by the time the controls do
          joinWorld()
          // push back from the desk and rise to standing height in one move,
          // straight off the glass: half a second reads as standing up, and
          // it used to be two moves (a retreat, then the rise) that together
          // were a wait between you and the walk. The /world entrance
          // never sat down, so it opens standing instead of gliding up out
          // of a chair nobody watched it push back from
          const s0 = performance.now()
          const from = camera.position.clone()
          const standTick = () => {
            if (disposed || !roaming) return
            const t = instant ? 1 : Math.min(1, (performance.now() - s0) / 500)
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
              // A direct /world boot baked this exact body pose into the local
              // maps under BootCover. Other entrances warmed the shader but
              // not the shadow itself, because an invisible person must not
              // leave a silhouette beside the desk during the intro.
              if (!spawnShadowsReady) {
                flagDeskShadows(camera.position)
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
          // the desktop has its own sounds; the walk's score leaves with the walk
          stopMusic()
          fps = false
          setPauseNow(false)
          // sitting back down leaves the world: the socket closes, the bodies
          // are retired, and the microphone is released rather than left live
          // behind a desktop that gives no sign it is on
          leaveWorld()
          // and so does the television: a set left playing behind a desktop
          // is a voice in an empty room, and nothing 3D renders to explain it
          tv?.silence()
          // the computer is the one speaker that does *not* go quiet here,
          // because you are sitting back down at it: back to full volume
          resetPcAudio()
          leaveSeat()
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
            walk.gravityScale = rules.gravity * gravityOf(homed)
            switchSandboxTo(homed)
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
            pr = prCeil
            look.setScale(pr)
          }
          nearNow = false
          doorVerbNow = null
          propVerbNow = null
          vehicleNow = null
          setWalking(false)
          setNear(false)
          setDoorVerb(null)
          setPropVerb(null)
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
          // a snap, not a glide: sitting down is a verb, and a second of camera
          // flight every time you wanted the computer was time taken from you.
          // The cold tube's flicker still plays, it just no longer holds the lens
          const dur = 0.28
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
            const zoom = Math.min(1, t / dur)
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
              // normally a no-op by now; it catches the visitor who stood up
              // inside the idle window the intro's park had scheduled
              warmRoomWhenIdle()
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
          if (loadingWorld) return
          if (!house.useDoor(headPos, headDir)) outside.useDoor(headPos, headDir)
          if (!outside.hasWorld() && atExteriorDoor(headPos)) void loadWorldCovered()
        }
        // and the furniture's, which is the same chain E walks: get up first
        // if you are sitting, otherwise work whatever is in front of you
        propRef.current = () => {
          if (seating.current) {
            leaveSeat()
            return
          }
          if (partSeat !== null) {
            leavePartSeat()
            return
          }
          if (tv?.use(headPos, headDir)) {
            if (tv.on) track('house_tv', { channel: tv.channel.label })
            return
          }
          if (house.useProp(headPos, headDir)) {
            propSwing = 1.1
            return
          }
          takeSeat()
        }
        enterRef.current = () => {
          if (vehicleNow) enterVehicle(vehicleNow.id)
        }
        leaveRef.current = () => leaveVehicle()
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
          // the set's picture is DOM in the CSS3D layer, which no scene
          // traversal is going to clean up on its way out
          tv?.dispose()
          tv = null
          avatars.dispose()
          input.dispose()
          window.removeEventListener('keydown', onEscKey, true)
          window.removeEventListener('keyup', onEscKey, true)
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
            Arriving already roaming (the /world entrance) means nobody is
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
          // fast /world arrival capable of meeting them for the first time at
          // the doorstep. Finish the small model batch here instead.
          const entries = await housePromise
          if (disposed || !webgl || !scene || roaming || leaving) return
          const models: HouseModels = { plant, mug }
          for (const e of entries) if (e) models[e[0]] = e[1]
          house.furnish(models)
          // crisp texels on the few furniture models that carry a texture,
          // before any of them has been drawn (render/texel.ts)
          texelateTree(house.root)
          /*
            The furniture is in, so its working parts can be wired up.

            The desk is the odd one out: it belongs to `deskRoom`, which built
            it before the house existed, so its four drawers are published
            there and registered here rather than inside furnish. Their facing
            is read off the drawers themselves, which is why all four are
            handed over at once: a desk has a pedestal on each side, and two
            drawers off one of them would point the whole piece sideways.
          */
          const deskFacing = facingOf(deskRoom.deskBox, deskRoom.drawers)
          for (const node of deskRoom.drawers) {
            house.addFitting({
              node,
              label: 'the drawer',
              piece: deskRoom.deskBox,
              motion: 'slide',
              ...deskFacing,
            })
          }
          for (const seat of house.seats) seating.add(seat)
          // and the television, which is the one thing in the house whose
          // picture is DOM: it hangs in the same CSS3D scene as the computer's
          // own screen, behind a hole punched in the canvas
          if (house.screen) {
            tv = buildHouseTv({
              scene,
              cssScene,
              screen: house.screen,
              trackDisposable: (d) => void disposer.add(d),
            })
            // its edge redrawn at full resolution, like the monitor's
            look.addHole(tv.hole)
          }
          disposer.textures.forEach((texture) => webgl?.initTexture(texture))

          // Make the player part of the covered shader warm-up too. Each body
          // mesh opts out of frustum culling, so the outdoor pass compiles its
          // surface and depth variants even though the warm camera faces away.
          // On /world, keep it visible through the local bake: those maps then
          // already contain the exact body pose the first live frame reveals.
          const spawnAim = lookAngles(SPAWN, front)
          walk.spawnAt(
            SPAWN.x, SPAWN.z, spawnAim.yaw,
            spawnY(levels.current, SPAWN.x, SPAWN.z, deskRoom.floorY),
          )
          walk.pitch = spawnAim.pitch
          rig.reset()
          rig.face(spawnAim.yaw)
          poseBody()
          body.visible = true
          // Only the /world entrance pays for the planet here. An ordinary boot
          // is somebody coming to read the screen, and building the world plus
          // compiling its outdoor variants was the single largest thing standing
          // between them and the desktop — several seconds for scenery behind a
          // door most visitors never open. The room is walkable without any of
          // it; opening that door calls ensureWorld() and this same warm-up
          // behind a cover of its own.
          if (straightToRoom) {
            await warmForRoam(SPAWN)
            if (disposed || !webgl || !scene || roaming || leaving) return
          } else {
            // the room still needs the sun's shadow map, which warmForRoam
            // happened to be the only thing baking
            bakeSunCovered()
          }

          if (!straightToRoom) body.visible = false
          await bakeShadowsCovered(() => disposed || roaming || leaving)
          if (disposed || !webgl || !scene || roaming || leaving) return

          if (straightToRoom) {
            // compileAsync tracks one current program per material, while the
            // same material can still have object-specific variants linking in
            // parallel. A short idle after the real shadow passes avoids making
            // the warm draw synchronously wait on work a human turn naturally
            // gives the driver time to finish.
            //
            // It used to be a flat `setTimeout(250)`, which is a quarter second
            // of boot spent whether or not the thread had anything left to do.
            // Idle is the thing actually being waited for, so ask for it: this
            // returns the moment the thread is quiet and still caps out at the
            // same 250 ms on a thread that never is.
            await new Promise<void>((resolve) => {
              if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => resolve(), { timeout: 250 })
              } else {
                setTimeout(resolve, 60)
              }
            })
            if (disposed || !webgl || !scene || roaming || leaving) return
            roomWarmed = true
            warmRoomDraw(SPAWN, spawnAim)
          }
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
      stopMusic()
      clearTimeout(bail)
      cancelAnimationFrame(raf)
      outroRef.current = null
      roamRef.current = null
      doorRef.current = null
      propRef.current = null
      resumeRef.current = null
      pixelProofsRef.current = null
      enterRef.current = null
      leaveRef.current = null
      applyLookRef.current = null
      setNickRef.current = null
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
      disposeLook?.()
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
      {/* the key hints, on a strip of masking tape stuck to the bottom of
          the screen: dark ink on cream reads over grass, asphalt and night
          alike, which the bare grey line it replaced did not. The console and
          the catalogue carry their own hints, so the tape comes off while
          either is up (and never contradicts their "esc closes") */}
      {roam && walking && !paused && typing === null && !menuOpen && (
        <p
          className="pointer-events-none absolute right-4 bottom-3 z-10 max-w-[min(640px,calc(100vw-420px))] px-3 py-[3px] text-right font-mono text-[11px] leading-snug"
          style={{
            color: '#3f3325',
            background: 'linear-gradient(90deg, rgba(246,236,208,0.93), rgba(238,226,194,0.95))',
            boxShadow: '0 1px 3px rgba(40,30,18,0.35)',
            transform: 'rotate(-0.5deg)',
            clipPath: 'polygon(0 12%, 1.2% 0, 98.8% 6%, 100% 0, 99.2% 88%, 100% 100%, 1% 94%, 0 100%)',
          }}
        >
          {!locked
            ? t.sandbox.hud.grab
            : driving
              ? // the controls change with the medium, so the line does too:
                // a helicopter has a collective where a car has a handbrake.
                // A passenger has none of them, and saying so is kinder than
                // letting them press W and conclude the game is broken
                driving.seat !== 0
                ? `${RIDE_ALONG[language]} · ${DRIVE_TAIL[language](driving.cockpit)}`
                : `${DRIVE_KEYS[driving.id][language]} · ${DRIVE_TAIL[language](driving.cockpit)}`
              : seated?.part
                ? // a contraption seat: the machine's keys, whatever it was built from
                  tapeLine(keyHint(`${t.sandbox.hud.seat} · ${t.sandbox.hud.pauses}`, language))
                : toolLine
                  ? // the tool gun out: what its two buttons do in this mode, now
                    tapeLine(keyHint(`${toolgunLine(toolLine.state, language, toolLine.keys)} · ${
                      t.sandbox.hud.toolTail} · ${t.sandbox.hud.pauses}`, language))
                  : tapeLine(keyHint(`${flying ? t.sandbox.hud.fly : t.sandbox.hud.walk}${
                      prefs.third ? ` · ${t.sandbox.hud.shoulder}` : ''
                    }${
                  mp.status === 'live' ? ` · ${t.sandbox.hud.voice}` : ''
                } · ${t.sandbox.hud.pauses}`, language))}
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
            {(driving.id === 'heli' || driving.id === 'ship') && <span>{gauge.altitude} up</span>}
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
      {/* the receipt printer: the console line, its answers and the shared
          walk's chat on one strip, plus who is here and what the microphone is
          doing on the printer's own little display. See SandboxConsole.tsx */}
      {/* (put away while the catalogue is up: the book is held over the
          same corner, and a receipt half under its cover reads as a bug) */}
      {roam && walking && !paused && !menuOpen && (
        <SandboxConsole
          open={typing}
          lines={feed}
          online={mp.status === 'live'}
          status={
            mp.status === 'live' ? (
              <>
                {mp.here === 0
                  ? t.sandbox.console.nobody
                  : `${mp.here} ${t.sandbox.console.nearby}`}
                {voiceHud.enabled &&
                  ` · ${voiceHud.mode === 'ptt' ? keyHint(t.sandbox.console.micHold) : t.sandbox.console.micOpen}${
                    voiceHud.peers > 0 ? ` · ${voiceHud.peers} ${t.sandbox.console.voice}` : ''
                  }`}
                {voiceHud.available && !voiceHud.enabled && ` · ${keyHint(t.sandbox.console.micOffer)}`}
                {voiceHud.error && ` · ${voiceHud.error}`}
              </>
            ) : null
          }
          onSubmit={(text) => {
            sayRef.current?.(text.slice(0, WORLD_MAX_TEXT_LEN))
            closeChat()
          }}
          onClose={closeChat}
          complete={(line) => consoleRef.current?.complete(line) ?? null}
        />
      )}
      {/* the spawn catalogue, held up by q. See SpawnMenu.tsx */}
      {roam && walking && !paused && (
        <SpawnMenu
          open={menuOpen}
          source={catalogue}
          orders={orders}
          onSpawn={(kind) => spawnRef.current?.(kind)}
          onCleanup={() => { void consoleRef.current?.run('cleanup') }}
          onPin={(on) => pinMenuRef.current?.(on)}
          onClose={() => closeMenuRef.current?.()}
        />
      )}
      {/* the crosshair, whenever there is a walk to aim: also with the
          mouse freed for the catalogue, because that is exactly when you
          need to know where the thing you click is going to land */}
      {roam && walking && !paused && !driving && !seated && !wheelOpen && (
        <div className="pointer-events-none absolute inset-0 z-10">
          <Crosshair aim={aim} />
          {pointHud && <PointMark />}
        </div>
      )}
      {/* the emote wheel, from b until something is picked (EmoteWheel.tsx) */}
      {roam && walking && !paused && !driving && !seated && wheelOpen && (
        <EmoteWheel
          ref={wheelApi}
          labels={t.sandbox.emotes.names}
          hub={t.sandbox.emotes.hub}
          hint={keyHint(t.sandbox.emotes.hint, language)}
        />
      )}
      {/* the nudge that exists so nobody walks a whole session as guest-08c9
          without ever learning there was a choice. Not a button: at this
          moment the mouse is usually captured and there is no cursor to click
          one with, so it says where to go instead of being somewhere to go */}
      {roam && walking && !paused && namePrompt && (
        <p className="pointer-events-none absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[11px] text-stone-400 backdrop-blur-sm">
          out here you are <span className="text-stone-200">{myName}</span>
          <span className="ml-2 text-stone-600">esc to change that</span>
        </p>
      )}
      {/* The pause screen, which is a whole screen of its own. See
          `PauseScreen.tsx`. It is mounted from the first pause of the session
          onward and merely hidden in between, never unmounted: the character
          preview inside it owns a second WebGL context, and creating one per
          press of escape would re-link its shaders every time. This way that
          cost is paid once, on a frame where the world is already stopped. */}
      {roam && walking && everPaused && (
        <PauseScreen
          open={paused}
          multiplayer={mp.status === 'live'}
          prefs={prefs}
          onPrefs={setPrefs}
          onVoicePreview={() => voicePreviewRef.current?.() ?? Promise.resolve()}
          onPixelProofs={() => pixelProofsRef.current?.() ?? Promise.resolve(null)}
          tier={tierInfo}
          people={people}
          identity={{
            look,
            onLook: setLook,
            name: myName,
            // a registered account owns its username, and an offline socket
            // has nobody to ask: in both cases the field explains itself
            // rather than accepting a name that would never take
            onRename:
              mp.status === 'live' && session?.kind !== 'user'
                ? (name) => {
                    setNamePrompt(false)
                    setRename({ pending: true, error: null })
                    setNickRef.current?.(name)
                  }
                : null,
            renameNote:
              session?.kind === 'user'
                ? t.look.accountName
                : t.look.offlineName,
            pending: rename.pending,
            error: rename.error,
          }}
          onLeave={onLeave}
          onResume={() => resumeRef.current?.()}
        />
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
      {/* the house's own furniture: already worded by the sim, because only
          the sim knows whether that is a freezer or a drawer */}
      {roam && walking && !paused && !near && !doorVerb && propVerb && (
        <button
          type="button"
          onClick={() => propRef.current?.()}
          className="absolute bottom-14 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[12px] text-stone-300 backdrop-blur-sm transition-colors hover:border-stone-500 hover:text-white"
        >
          <kbd className="mr-2 rounded border border-stone-600 bg-stone-800 px-1.5 py-0.5 text-[10px] text-stone-200">
            E
          </kbd>
          {propVerb}
        </button>
      )}
      {/* ...and once you are in it, the way back out, plus the dial. The
          channel line only appears once you have actually turned the set on */}
      {roam && walking && !paused && seated && (
        <div className="absolute bottom-14 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5">
          {tvChannel && (
            <span className="rounded-md border border-stone-700 bg-stone-950/80 px-2.5 py-1 font-mono text-[11px] text-stone-400 backdrop-blur-sm">
              ch {tvChannel}
            </span>
          )}
          <button
            type="button"
            onClick={() => propRef.current?.()}
            className="cursor-pointer rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[12px] text-stone-300 backdrop-blur-sm transition-colors hover:border-stone-500 hover:text-white"
          >
            <kbd className="mr-2 rounded border border-stone-600 bg-stone-800 px-1.5 py-0.5 text-[10px] text-stone-200">
              E
            </kbd>
            stand up
            {seated.atTv && <span className="ml-2 text-stone-500">· a/d the telly</span>}
          </button>
        </div>
      )}
      {/* the fleet's prompt is last in the stack because it is the one you can
          be standing at while also standing at something else */}
      {roam && walking && !paused && !near && !doorVerb && !propVerb && !seated && vehiclePrompt && (
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
