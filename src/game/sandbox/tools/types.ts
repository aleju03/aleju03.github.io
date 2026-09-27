import type * as THREE from 'three'

/*
  The shapes the tool belt talks in, kept apart from any one tool so that the
  scene, the film harness and the network can all speak them without
  importing a physgun.

  A tool never reads the keyboard. Whoever owns the keys (CrtScene today, the
  one binding table in `sandbox/bindings.ts` once it lands) fills a
  `ToolInput` each frame from whatever keys it likes, and the scripted films
  fill the same record from a clock. That is the whole reason the physgun can
  be filmed swinging a crate with no browser input at all: the harness is
  just another thing that writes this record.

  `HoldRecord` is the other half: everything a held thing needs, as plain
  numbers, so the network can send it and a remote client can draw somebody
  else's beam from it (see beam.ts). Nothing in it is a reference to a Rapier
  body, a mesh or a rig.
*/

/** where the holder is looking, this frame */
export interface Aim {
  /** the ray origin: the eye */
  eye: THREE.Vector3
  /** unit look direction */
  dir: THREE.Vector3
  /** heading, the walk's convention (0 faces -Z) */
  yaw: number
}

/** one frame of intent, however it was produced */
export interface ToolInput {
  aim: Aim
  /** seconds since the last frame */
  dt: number
  /** primary (LMB) held */
  fire: boolean
  /** secondary (RMB) held */
  alt: boolean
  /** the rotate modifier (E) held */
  rotate: boolean
  /** the snap modifier (Shift) held */
  snap: boolean
  /** reload (R) held */
  reload: boolean
  /** wheel notches since last frame, positive pushes away */
  wheel: number
  /** mouse movement since last frame in pixels, pointer-lock convention
      (right and down are positive). Only read while a tool captures look */
  lookX: number
  lookY: number
}

export const emptyInput = (aim: Aim): ToolInput => ({
  aim, dt: 0, fire: false, alt: false, rotate: false, snap: false, reload: false,
  wheel: 0, lookX: 0, lookY: 0,
})

/** what a beam is attached to */
export type HoldKind = 'prop' | 'rig' | 'none'

/**
 * Everything a hold is, as plain data. One per holder; the local physgun
 * owns one and rewrites it in place every frame, a remote holder's arrives
 * off the wire. Positions are world units, the quaternion is the held
 * thing's orientation relative to the holder's heading.
 */
export interface HoldRecord {
  /** who is holding: the local player is 'local', a remote one their id */
  holder: string
  kind: HoldKind
  /** the prop id when kind is 'prop', else -1 */
  prop: number
  /** the rig's key and limb when kind is 'rig' */
  rig: string
  limb: number
  /** the grab point in the held thing's own frame (props only) */
  anchor: [number, number, number]
  /** where the beam is pulling the grab point to */
  target: [number, number, number]
  /** where the grab point actually is: the beam's far end */
  end: [number, number, number]
  /** metres of beam, the wheel's distance */
  dist: number
  /** held orientation relative to the heading (props only) */
  rot: [number, number, number, number]
  /** 0..1, how hard the beam is working: the hum's pitch, the beam's wobble */
  strain: number
  /** E held: the prop turns and the view does not */
  rotating: boolean
  /** counts freezes, so a remote copy can replay the flash exactly once */
  freezes: number
}

export const emptyHold = (holder = 'local'): HoldRecord => ({
  holder, kind: 'none', prop: -1, rig: '', limb: -1,
  anchor: [0, 0, 0], target: [0, 0, 0], end: [0, 0, 0], dist: 0,
  rot: [0, 0, 0, 1], strain: 0, rotating: false, freezes: 0,
})

/**
 * A body the beam can take by a limb. This is the character rig's grab hook
 * (`player/playerBody.ts`), declared structurally so the physgun neither
 * imports the rig nor breaks while the rig is being rebuilt: anything with
 * these four members can be picked up by the ankle.
 */
export interface GrabRig {
  readonly limbs: readonly { radius: number }[]
  limbPos: (i: number, out: THREE.Vector3) => THREE.Vector3
  /** hold a limb toward a live point, read by reference; null lets go, and
      a throw hands the beam's velocity at that moment as `v` (a local body
      already carries it in its verlet; another player's needs telling) */
  grab: (i: number, target: THREE.Vector3 | null, k?: number, v?: THREE.Vector3) => void
  /** false once this body can no longer be held (its player left, sat
      down, took off, or the hold ran past its cap): the beam lets go */
  alive?: () => boolean
}

/** a rig, with a stable name the hold record can carry */
export interface RigEntry {
  key: string
  rig: GrabRig
}

/** true when a rig carries the grab hooks (the rig in flight may not yet) */
export const isGrabRig = (r: unknown): r is GrabRig => {
  const o = r as Partial<GrabRig> | null
  return !!o && Array.isArray(o.limbs) && typeof o.limbPos === 'function' && typeof o.grab === 'function'
}

/** something that happened to the beam, for sound, sparks and history */
export type PhysgunEventType = 'grab' | 'release' | 'freeze' | 'unfreeze' | 'miss'
export interface PhysgunEvent {
  type: PhysgunEventType
  kind: HoldKind
  prop: number
  /** release: how fast it left, u/s */
  speed: number
  x: number
  y: number
  z: number
}
