import type * as THREE from 'three'
import type { CollisionSet, Solid } from '../physics/collision'
import type { StepSurface } from '../core/sfx'
import type { SandboxGround } from '../sandbox/ground'
import type { Ruins } from '../world/debris'

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
}

/** the shared lights a level may commandeer while the player is inside */
export interface LevelLightRig {
  hemi: THREE.HemisphereLight
  moon: THREE.DirectionalLight
  windowSpill: THREE.SpotLight
  /** the moonlight pool on the bedroom floor */
  setMoonPool: (opacity: number) => void
  fog: THREE.Fog
  bg: THREE.Color
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
  /** the player just arrived through a seam (start ambience, stream chunks) */
  enter: () => void
  /** the player just left through a seam */
  leave: () => void
  /** every roam frame while this level is current */
  update: (dt: number, p: THREE.Vector3) => void
  /** which level the player's position just crossed into, if any. The
      arrival point belongs to the seam, not the level: a seam that lands
      somewhere other than the level's default spawn carries its own. */
  seamTo: (p: THREE.Vector3) => { to: string; spawn?: LevelSpawn } | null
  /** impose the level's own light mood after the shared sky pass */
  overrideLight?: (rig: LevelLightRig) => void

  /* ---- what this level has (see the header): all default to none ---- */

  /** gravity as a share of the overworld's, for the walker and for the
      props alike; the console's `gravity` multiplies on top. Default 1 */
  gravity?: number
  /** a props sandbox runs here (the Q catalogue, the physgun, the console's
      spawns), standing on this */
  sandbox?: LevelSandbox
  /** the fleet lives here: its machines prompt, can be boarded and recalled */
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
}
