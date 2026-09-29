import type * as THREE from 'three'
import type { RoundClientMessage } from '../net/roundProtocol'
import type { RoundState } from '../net/remoteRounds'
import type { LevelSpawn } from '../levels/types'
import type { Lang } from './defs'

/*
  What a client-side mode module is given and what it gives back.

  The modes (deathmatch.ts, propHunt.ts, hideSeek.ts, race.ts, build.ts) are
  React-free and know nothing of the scene: they read the round store
  (net/remoteRounds.ts), act through a `ModeHost` the scene fills in (walk to
  a place, ask for a car, say the crosshair's prop, draw a ring) and answer a
  handful of questions each frame (`frozen`, `locked`, `respawnSpot`,
  `hitbox`). The director (director.ts) picks the module for the round's
  mode, enters it when the player is in a round and leaves it when the round
  ends, and is the only thing CrtScene talks to.

  Nothing a mode does is authority. Every rule is the server's; a mode only
  makes the client behave (stand still while the seekers count, put a ring
  where the next checkpoint is) and reports what only the client can see
  (which ring the car is inside, which prop the crosshair is on).
*/

export interface WalkerPose {
  x: number
  y: number
  z: number
  yaw: number
}

/** a ring the race asks the scene to draw */
export interface RingSpec {
  x: number
  z: number
  radius: number
  /** the ring to go through next (bright), or a later one (dim) */
  state: 'next' | 'later' | 'done'
}

export interface ModeHost {
  you: () => number
  levelId: () => string
  lang: () => Lang
  nameOf: (id: number) => string
  /** the walker's feet and yaw, as of the last frame */
  here: () => WalkerPose
  /** the walker is riding a machine (its position is the machine's) */
  riding: () => boolean
  /** stand somewhere; y is worked out from the ground when omitted */
  teleport: (x: number, z: number, y?: number, yaw?: number) => void
  /** change map to the one this level belongs to */
  goLevel: (level: string) => 'ok' | 'here' | 'busy' | 'unknown'
  send: (m: RoundClientMessage) => void
  /** everyone else, feet as drawn (for a punch) */
  others: () => Iterable<{ id: number; x: number; y: number; z: number; yaw: number }>
  /** the shared prop under the crosshair, if any */
  aimedProp: () => { kind: string } | null
  /** a one-line message in the chat rail */
  say: (text: string, tone?: 'ok' | 'err' | 'system') => void
  /** the car: delivered to where you stand, and boarded */
  driveCar: () => void
  /** the ground under a point, for rings */
  groundAt: (x: number, z: number) => number
  /** the checkpoint rings, redrawn when the list changes (null: none drawn) */
  rings: (rings: RingSpec[] | null) => void
  /** a small sound cue */
  cue: (kind: 'ring' | 'lap' | 'go' | 'tick' | 'caught' | 'vote') => void
  /** the level's spawn points for a side (Level.teamSpawns), or none */
  teamSpawns: (team: number) => readonly LevelSpawn[]
  /** the scene the mode may hang meshes in (a disguise, a marker) */
  scene: THREE.Object3D | null
}

export interface ModeInput {
  /** key edges this frame, by binding name (bindings.ts) */
  pressed: (action: 'disguise' | 'point' | 'vote1' | 'vote2' | 'vote3' | 'vote4' | 'vote5') => boolean
  dt: number
}

export interface ModeCtx {
  store: RoundState
  host: ModeHost
}

export interface ModeClient {
  /** the player's round has begun (the countdown) */
  enter?: () => void
  /** and it is over, or they left it */
  leave?: () => void
  /** the play phase began */
  playing?: () => void
  /** every frame while in the round */
  tick?: (input: ModeInput) => void
  /** the walker is held still */
  frozen?: () => boolean
  /** every tool is put away (hiders and props are unarmed and empty-handed) */
  locked?: () => boolean
  /** the screen is covered (hunters and seekers while the others hide) */
  blind?: () => boolean
  /** where to stand up after a death, if the mode says */
  respawnSpot?: () => WalkerPose | null
  /** the server sent a tp: mode may want to react (a car to order) */
  teleported?: () => void
  /** a line for the HUD under the timer */
  objective?: () => { en: string; es: string } | null
}
