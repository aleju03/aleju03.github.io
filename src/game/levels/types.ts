import type * as THREE from 'three'
import type { CollisionSet } from '../physics/collision'

/*
  The level contract. A level is a walkable place: it owns its collision
  set, its floor height, where you appear when you arrive, and whatever
  per-frame life it has (chunk streaming, ambience, doors easing). Levels
  connect through seams — seamTo() reports which level the player just
  walked into, and the level system runs the cut (freeze, blackout, swap,
  fade) that moves them there. New areas plug in by implementing this and
  registering with createLevelSystem; nothing else has to change.
*/

/** where entering this level puts the player, in its own coordinates */
export interface LevelSpawn {
  x: number
  z: number
  yaw: number
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
  /** flat floor height under the player's feet */
  groundY: number
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
}
