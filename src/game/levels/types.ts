import type * as THREE from 'three'
import type { CollisionSet, Solid } from '../physics/collision'
import type { StepSurface } from '../core/sfx'
import type { SandboxGround } from '../sandbox/ground'
import type { Felling, Ruins } from '../world/debris'
import type { Prop, Sandbox } from '../sandbox/sandbox'

/*
  The level contract. A level is a walkable place: it owns its collision
  set, its floor height, where you appear when you arrive, and whatever
  per-frame life it has (chunk streaming, ambience, doors easing). Levels
  connect through seams — seamTo() reports which level the player just
  walked into, and the level system runs the cut (freeze, blackout, swap,
  fade) that moves them there. New areas plug in by implementing this and
  registering with createLevelSystem; nothing else has to change.

  A level also says what it *has*, and the scene reads those answers instead
  of asking which level this is. That is the whole of the multi-map seam:
  gravity (the walker's and the props' both), whether a props sandbox runs
  here and what its ground is made of, whether the fleet, the town's crowd
  and the house's furniture exist, whether there is air to see through, and
  what a footstep lands on. Every one of them defaults to "no" (gravity to
  1), so a new level states what it offers and inherits nothing by accident.
*/

/** where entering this level puts the player, in its own coordinates */
export interface LevelSpawn {
  x: number
  z: number
  yaw: number
  /** absolute height of the feet on arrival, for a seam that lands you in
      the air (arriving from space). Never under the floor there: the scene
      lifts it onto whatever is standable, so a bad number cannot bury you */
  y?: number
}

/**
 * A seamless seam: no cut, no card, no stop. The two levels draw the same
 * picture across it (flying onto the Moon, the Moon's own ground has been in
 * view the whole way down), and crossing is carrying the player, and whatever
 * they are flying, by this offset into the new level's coordinates.
 */
export interface LevelShift {
  x: number
  y: number
  z: number
}

/**
 * What a props sandbox needs from the level it runs in. One sandbox per level
 * that declares one, created the first time the player arrives, so props
 * dropped on the Moon stay on the Moon and the street's stay in the street.
 */
export interface LevelSandbox {
  /** what the props land on; absent, the overworld's terrain */
  ground?: SandboxGround
  /** the waterline and the swell on it, read live */
  waterY?: () => number
  waveAt?: (x: number, z: number) => number
  /** drop the world's own ripple rings where a prop went in hard */
  splash?: (x: number, z: number) => void
  /** the solids of a chunk past the walker's own ring */
  chunkSolids?: (cx: number, cz: number) => readonly Solid[] | null
  /** the buildings that come apart (sandbox/destruction.ts), if any */
  ruins?: () => Ruins | null
  /** the trees and posts a car knocks down, for the shared world */
  felling?: () => Felling | null
  /** the level's own hold on its sandbox, handed over the moment the
      sandbox is made: Cubeland listens to its blasts and throws blocks
      into it */
  attach?: (sb: Sandbox) => void
}

/** one walk frame of bare hands, for a level that does something with them */
export interface HandsFrame {
  camera: THREE.PerspectiveCamera
  /** the soles, so a block is never placed inside the body placing it */
  feetY: number
  fire: boolean
  alt: boolean
  /** wheel notches this frame (the hands take it while they are out) */
  wheel: number
  dt: number
  /** the hands are out and usable (on foot, not sitting, not paused) */
  active: boolean
  firstPerson: boolean
}

/** what a hotbar shows: the kinds in it and which one is in hand */
export interface HandsHud {
  kinds: readonly string[]
  sel: number
}

/**
 * A level where your bare hands do something (Cubeland: left click breaks
 * the block you are looking at, right click places the one in your hand).
 * The scene hands it every walk frame while slot 0 is out and knows nothing
 * else about blocks.
 */
export interface LevelHands {
  update: (f: HandsFrame) => void
  /** the catalogue picked this kind: true when the hands took it (a block
      put in hand) instead of it being spawned */
  choose: (kind: string) => boolean
  /** the hotbar, whenever it changes (and once on subscribing) */
  subscribe: (fn: (hud: HandsHud) => void) => () => void
}

/**
 * Something in the level the physgun can take hold of that is not yet a
 * prop (types.ts's VehicleGrab has the same shape): Cubeland's blocks, torn
 * out of the ground as a loose one when the beam catches them.
 */
export interface LevelGrab {
  pick: (eye: THREE.Vector3, dir: THREE.Vector3, within: number) => { key: string; t: number } | null
  take: (key: string, sb: Sandbox) => Prop | null
}

/** the shared lights a level may commandeer while the player is inside */
export interface LevelLightRig {
  hemi: THREE.HemisphereLight
  moon: THREE.DirectionalLight
  windowSpill: THREE.SpotLight
  /** the sky's sun, as the sky pass left it (a level with a sun of its own
      turns it up or tints it; it keeps casting either way) */
  sun: THREE.DirectionalLight
  /** the moonlight pool on the bedroom floor */
  setMoonPool: (opacity: number) => void
  fog: THREE.Fog
  bg: THREE.Color
  /** how much day there is in the sky being drawn, 0 night .. 1 day (the
      console's pinned hour included) */
  day: number
}

export interface Level {
  id: string
  /** the level's base floor: what holds the player up wherever no solid's
      top does. Height is per-position now (collision.ts's supportY walks the
      CollisionSet for the tallest surface under an x/z), so this is the
      fallback underneath all of it rather than the one floor there is */
  groundY: number
  /** ...and where even that fallback varies, the function that answers for
      it. The open world's terrain lives here: everything that samples the
      floor (the walk, the ragdoll, the chase boom, a spawn) asks this instead
      of reading `groundY`, which stays the answer for levels built on one
      plane. It must report the height of the *drawn* surface — a player
      hovering a hand's width over a hillside is the visible cost of a
      groundYAt that disagrees with the mesh by an interpolation error. */
  groundYAt?: (x: number, z: number) => number
  /** the waterline, for levels that have one. Ground below it is a sea, lake
      or river bed, and a body far enough under it swims. */
  waterY?: number
  /** flat ceiling over it, for levels that are indoors everywhere; a jump
      bonks off it rather than carrying the camera through. Levels that are
      partly open sky (the overworld) simply leave it out — which is why
      anything tall enough to put the eye through a real ceiling registers
      its collision box with `noStand` instead of relying on this. */
  ceilingY?: number
  collision: CollisionSet
  /** default arrival point, used when a seam doesn't carry its own */
  spawn: LevelSpawn
  /** where each side of a round starts, side 0 then side 1 (modes/deathmatch.ts).
      Absent, a round has only the random `spawn` */
  teamSpawns?: readonly (readonly LevelSpawn[])[]
  /** the player just arrived through a seam (start ambience, stream chunks) */
  enter: () => void
  /** the player just left through a seam */
  leave: () => void
  /** every roam frame while this level is current */
  update: (dt: number, p: THREE.Vector3) => void
  /** which level the player's position just crossed into, if any. The
      arrival point belongs to the seam, not the level: a seam that lands
      somewhere other than the level's default spawn carries its own. */
  seamTo: (p: THREE.Vector3) => { to: string; spawn?: LevelSpawn; shift?: LevelShift } | null
  /** impose the level's own light mood after the shared sky pass */
  overrideLight?: (rig: LevelLightRig) => void
  /** the sky's clock pinned while you are here (0..1, 0.5 noon), for a map
      that is always the same hour; absent, the planet's own day. The
      console's `time` still wins */
  timeOfDay?: number

  /* ---- what this level has (see the header): all default to none ---- */

  /** gravity as a share of the overworld's, for the walker and for the
      props alike; the console's `gravity` multiplies on top. Default 1 */
  gravity?: number
  /** a props sandbox runs here (the Q catalogue, the physgun, the console's
      spawns), standing on this */
  sandbox?: LevelSandbox
  /** the fleet runs here: its machines are ordered from the catalogue,
      prompt, are boarded and taken on the physgun, all four of them. Each
      stands in one level at a time (vehicles/registry.ts), so a car left on
      the Moon is not on the street, and ordering it pulls it to you */
  vehicles?: boolean
  /** the town's pedestrians walk here: bumps, blasts and a car reach them */
  crowd?: boolean
  /** the house stands here: its doors, fittings, seats and television answer
      the interact key, and its baked shadow maps follow the walker */
  house?: boolean
  /** under the open sky: the sun's moving shadow map follows the walker */
  outdoors?: boolean
  /** there is air: the look's aerial perspective, the lamp pools and the
      headlamp. The Moon is outdoors and has none */
  air?: boolean
  /** what a footstep lands on at a point, at a sole height */
  surfaceAt?: (x: number, z: number, feetY: number, wet: number) => StepSurface
  /** what a wheel or a hull is on, where that is not what a boot is: the
      Moon's regolith is sand underfoot and firm going under a tyre. Default
      the overworld's own answer (the property, then the open world) */
  driveSurface?: (x: number, z: number) => StepSurface
  /** the jump's height as a share of the overworld's: Cubeland's blocks are
      two units and a hop has to clear one with time to spare. Default 1 */
  jump?: number
  /** the lowest thing overhead at (x, z) for a body whose soles are at
      `feetY`, where that is not one flat `ceilingY`: a hop under a block
      stops at it instead of pushing the body out sideways. Infinity for
      open sky */
  ceilingAt?: (x: number, z: number, feetY: number) => number
  /** bare hands do something here */
  hands?: LevelHands
  /** the physgun can tear things out of the level itself */
  grab?: LevelGrab
}
