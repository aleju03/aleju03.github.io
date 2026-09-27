/*
  The emotes: what the wheel offers, what each one looks like on the bean, and
  how one travels.

  Every emote is a *pose layer*, not an animation clip. `emoteFrame(id, t)`
  answers, for a moment `t` seconds into the emote, where the hips go, how the
  trunk and head turn on top of whatever the walk had them doing, where each
  mitten should be, and whether the legs keep stepping or are posed outright.
  `playerBody.ts` blends that over its own procedural pose at the weight the
  frame names, so an emote has the same springs, jiggle and blink as
  everything else the body does, fades in and out instead of cutting, and a
  wave can ride on top of a walk. Nothing here knows a bone; it is numbers in
  the body's design units (feet at y = 0, facing +Z) and plain arithmetic, so
  it runs headless like the rest of the runtime.

  Arms are given as **mitten targets in the torso's frame**, not joint angles,
  and the body solves them with the same two-bone IK the physgun grip uses.
  That is what makes a clap meet in the middle and a facepalm land on the face
  whatever the trunk is doing underneath, where authored angles only ever
  land where they were tuned. The torso frame has +X on the body's left, the
  shoulders at (+-SHOULDER_X, SHOULDER_OFF, 0), and a reach of about 0.85
  from shoulder to mitten; a target further than that is simply reached for.
  A target inside the body is not an error either: the rig moves it out onto
  the surface (`selfContact.ts`), so a clap aimed at a bean's middle meets
  in front of whatever belly the build has. Aim a pose where it reads and
  keep it clear of the head's sides, where headgear lives.

  Two kinds. An **upper-body** emote (wave, thumbs up, clap, laugh, facepalm,
  flex) leaves the legs to the stepper, so it plays while walking. A
  **whole-body** one (dance, jump for joy, sit) owns the hips and legs, holds
  the body's facing still so the camera can swing round it, and is cancelled
  by moving, the way every game with an emote wheel does it.

  On the wire an emote is one integer, `packEmote(id, age)`: the id in the low
  four bits and how long it has been playing, in tenths of a second, above
  them. The age is what lets somebody who walks up halfway through a dance see
  the same beat the dancer does, without anybody sharing a clock.
*/

export type EmoteName =
  | 'wave' | 'thumbs' | 'clap' | 'laugh' | 'dance' | 'joy' | 'flex' | 'facepalm' | 'sit'

export interface EmoteDef {
  /** wire id, 1..15. Never renumber one: it is what other clients decode */
  id: number
  name: EmoteName
  /** seconds; 0 loops until cancelled */
  len: number
  /** owns the hips and legs (and the facing), and moving cancels it */
  full: boolean
}

/** in the wheel's order, clockwise from the top */
export const EMOTES: readonly EmoteDef[] = [
  { id: 1, name: 'wave', len: 2.4, full: false },
  { id: 9, name: 'thumbs', len: 2.0, full: false },
  { id: 4, name: 'clap', len: 2.6, full: false },
  { id: 3, name: 'laugh', len: 2.8, full: false },
  { id: 2, name: 'dance', len: 0, full: true },
  { id: 8, name: 'joy', len: 2.0, full: true },
  { id: 6, name: 'flex', len: 2.8, full: false },
  { id: 5, name: 'facepalm', len: 2.6, full: false },
  { id: 7, name: 'sit', len: 0, full: true },
]

const BY_ID: Array<EmoteDef | undefined> = []
for (const e of EMOTES) BY_ID[e.id] = e
export const emoteDef = (id: number): EmoteDef | null => BY_ID[id] ?? null

/** seconds a new emote takes to come in, and a finished one to let go */
export const EMOTE_IN = 0.25
export const EMOTE_OUT = 0.3

// ------------------------------------------------------------------ the wire

const AGE_MAX = 4095 // tenths of a second, twelve bits: a shade under 7 minutes

/** 0 is "no emote" */
export const packEmote = (id: number, age: number): number =>
  id > 0 ? (id & 15) | (Math.min(AGE_MAX, Math.max(0, Math.round(age * 10))) << 4) : 0

export const unpackEmote = (e: number): { id: number; age: number } => ({
  id: e & 15,
  age: (e >>> 4) / 10,
})

// ----------------------------------------------------------------- the wheel

/** mouse travel, in pixels, under which the wheel's arrow rests on its hub
    (nothing), and the most it keeps: short, so coming back is a flick */
export const WHEEL_DEAD = 26
export const WHEEL_REACH = 90

/**
  Which slice of the wheel a cursor offset lands in, or -1 for the hub (the
  offset is shorter than `dead`). Screen space, +y down, the first slice
  centred straight up, clockwise from there.
*/
export function wheelSlice(dx: number, dy: number, dead: number, n = EMOTES.length): number {
  if (dx * dx + dy * dy < dead * dead) return -1
  // clockwise from straight up
  let a = Math.atan2(dx, -dy)
  if (a < 0) a += Math.PI * 2
  const step = (Math.PI * 2) / n
  return Math.floor((a + step / 2) / step) % n
}

// ---------------------------------------------------------------- the poses

/** one moment of an emote, in design units and radians, all zero at rest */
export interface EmoteFrame {
  /** 0..1, the emote's own envelope at this moment: in, hold, out */
  k: number
  /** hips lowered (knees fold under it) */
  drop: number
  /** hips raised off the ground, feet and all: a hop */
  lift: number
  /** an absolute hip height, NaN to leave it to the walk (sitting) */
  hipY: number
  hipX: number
  hipPitch: number
  hipYaw: number
  hipRoll: number
  /** added to the trunk and the head */
  torsoX: number
  torsoY: number
  torsoZ: number
  headX: number
  headY: number
  headZ: number
  /** added to the trunk's squash (+ stretches) */
  squash: number
  /** each foot raised, design units, on top of `lift` */
  liftL: number
  liftR: number
  /** posed legs instead of the stepper: thigh swing (- forward), splay out,
      knee fold */
  legs: boolean
  thighX: number
  thighZ: number
  shin: number
  /** mitten targets in the torso frame; `armL`/`armR` false leaves that arm
      to the walk */
  armL: boolean
  lx: number
  ly: number
  lz: number
  armR: boolean
  rx: number
  ry: number
  rz: number
  /** how far the elbows are pushed out and up from the default hang */
  elbowOut: number
  /** eyes: 1 open .. 0 squeezed shut */
  lid: number
  /** how much the head stops following the camera, 0..1 */
  mute: number
}

export const makeEmoteFrame = (): EmoteFrame => ({
  k: 0, drop: 0, lift: 0, hipY: NaN, hipX: 0, hipPitch: 0, hipYaw: 0, hipRoll: 0,
  torsoX: 0, torsoY: 0, torsoZ: 0, headX: 0, headY: 0, headZ: 0, squash: 0,
  liftL: 0, liftR: 0, legs: false, thighX: 0, thighZ: 0, shin: 0,
  armL: false, lx: 0, ly: 0, lz: 0, armR: false, rx: 0, ry: 0, rz: 0,
  elbowOut: 0, lid: 1, mute: 0,
})

const clear = (f: EmoteFrame) => {
  f.k = 0
  f.drop = f.lift = f.hipX = f.hipPitch = f.hipYaw = f.hipRoll = 0
  f.hipY = NaN
  f.torsoX = f.torsoY = f.torsoZ = f.headX = f.headY = f.headZ = f.squash = 0
  f.liftL = f.liftR = 0
  f.legs = false
  f.thighX = f.thighZ = f.shin = 0
  f.armL = f.armR = false
  f.lx = f.ly = f.lz = f.rx = f.ry = f.rz = 0
  f.elbowOut = 0
  f.lid = 1
  f.mute = 0
}

const ramp = (a: number, b: number, x: number) => Math.min(1, Math.max(0, (x - a) / (b - a)))
const smooth = (x: number) => x * x * (3 - 2 * x)
const mix = (a: number, b: number, k: number) => a + (b - a) * k

const setL = (f: EmoteFrame, x: number, y: number, z: number) => {
  f.armL = true
  f.lx = x
  f.ly = y
  f.lz = z
}
const setR = (f: EmoteFrame, x: number, y: number, z: number) => {
  f.armR = true
  f.rx = x
  f.ry = y
  f.rz = z
}

/**
  The pose of emote `id` at `t` seconds in, written into `out` (which is
  cleared first). An unknown id leaves it cleared, i.e. weight 0.
*/
export function emoteFrame(id: number, t: number, out: EmoteFrame): EmoteFrame {
  clear(out)
  const def = emoteDef(id)
  if (!def) return out
  const L = def.len
  out.k = smooth(ramp(0, EMOTE_IN, t)) * (L > 0 ? 1 - smooth(ramp(L - EMOTE_OUT, L, t)) : 1)
  const f = out
  switch (def.name) {
    case 'wave': {
      // the right mitten up and out beside the head, wagging side to side
      // from the elbow, with the head cocked toward whoever it is for
      const wag = Math.sin(t * 10.5) * 0.16
      setR(f, -0.92 + wag, 1.22 + Math.abs(wag) * 0.25, 0.28)
      f.elbowOut = 0.7
      f.headZ = 0.14
      f.torsoZ = -0.06
      f.torsoY = 0.08
      break
    }
    case 'thumbs': {
      // arm out in front, the mitten's thumb (on its front edge) turned to
      // the sky, and one firm nod
      const pump = Math.sin(ramp(0.25, 0.7, t) * Math.PI) * 0.06
      setR(f, -0.3, 0.52 + pump, 0.8)
      f.elbowOut = 0.2
      f.headX = Math.sin(ramp(0.5, 1.1, t) * Math.PI) * 0.22
      f.headZ = -0.1
      f.torsoY = 0.12
      break
    }
    case 'clap': {
      // both mittens in front of the chest, meeting in the middle two and a
      // half times a second, the body bouncing a little on each one
      const beat = t * 2.6
      const open = Math.pow(Math.abs(Math.sin(Math.PI * beat)), 0.7)
      const gap = 0.07 + 0.2 * open
      setL(f, gap, 0.6, 0.62)
      setR(f, -gap, 0.6, 0.62)
      f.elbowOut = 0.15
      f.torsoX = 0.08
      f.headX = 0.06 + (1 - open) * 0.05
      f.squash = (1 - open) * 0.025
      f.drop = (1 - open) * 0.02
      break
    }
    case 'laugh': {
      // hands on the belly, thrown back and then folded over it, shaking
      // with it the whole way, eyes squeezed shut
      const shake = Math.sin(t * 17)
      const lean = -0.28 * Math.cos((Math.PI * t) / L)
      setL(f, 0.4, 0.02, 0.5)
      setR(f, -0.4, 0.02, 0.5)
      f.torsoX = lean + shake * 0.05
      f.headX = lean * 0.9 - 0.08 + Math.sin(t * 17 + 1) * 0.06
      f.squash = shake * 0.025
      f.drop = 0.04 + Math.abs(shake) * 0.02
      f.lid = 0.12
      f.mute = 0.8
      break
    }
    case 'facepalm': {
      // the right mitten up against the side of the face, the head tipping
      // into it and bowing, then shaking slowly. The side, because a bean's
      // arms are too short to cross the front of its own face: aimed at the
      // middle, the forearm went through the chest to get there
      const lift = smooth(ramp(0.1, 0.55, t))
      setR(f, mix(-0.62, -0.7, lift), mix(0.25, 1.2, lift), mix(0.3, 0.3, lift))
      f.elbowOut = 0.6
      const shake = Math.sin(t * 5.5) * 0.14 * ramp(0.7, 1.0, t)
      f.headX = 0.26 * lift
      f.headY = shake
      f.headZ = 0.22 * lift
      f.torsoX = 0.1 * lift
      f.torsoZ = 0.06 * lift
      f.lid = 1 - 0.8 * lift
      f.mute = 1
      break
    }
    case 'flex': {
      // double biceps: upper arms out level, forearms up, mittens beside the
      // head, the chest puffed; and every beat it flexes harder
      const pulse = Math.max(0, Math.sin(t * 5.2))
      setL(f, 0.96, 1.0 + pulse * 0.05, 0.2)
      setR(f, -0.96, 1.0 + pulse * 0.05, 0.2)
      f.elbowOut = 1.6
      f.torsoX = -0.04
      f.squash = 0.05 + pulse * 0.03
      f.headX = -0.12
      f.headZ = Math.sin(t * 2.1) * 0.1
      f.drop = 0.05
      break
    }
    case 'dance': {
      // a goofy two-step on a 120 bpm beat: knees bouncing on every beat,
      // hips swaying across two, a stamp of each foot, and the arms pumping
      // up and down in turn, the raise-the-roof a bean can reach
      const b = t / 0.5
      const s = Math.sin(Math.PI * b)
      const bounce = Math.abs(Math.cos(Math.PI * b))
      f.drop = 0.1 + 0.08 * (1 - bounce)
      f.hipX = 0.09 * s
      f.hipRoll = 0.12 * s
      f.hipYaw = 0.22 * Math.sin((Math.PI * b) / 2)
      f.torsoZ = -0.16 * s
      f.torsoX = 0.06 * bounce
      f.headZ = 0.16 * Math.sin(Math.PI * b + 0.6)
      f.headX = 0.12 * bounce - 0.04
      f.liftL = 0.1 * Math.max(0, s)
      f.liftR = 0.1 * Math.max(0, -s)
      const u = 0.5 + 0.5 * s
      // (the low hand out at the hip rather than on the belly, and the high
      // one clear of the head: a wide bean's belly and a headset's cups are
      // where the first version's forearms went)
      setL(f, mix(0.86, 0.8, u), mix(0.3, 1.25, u), mix(0.42, 0.28, u))
      setR(f, mix(-0.8, -0.86, u), mix(1.25, 0.3, u), mix(0.28, 0.42, u))
      f.elbowOut = 1.0
      f.squash = 0.04 * bounce
      f.mute = 0.8
      break
    }
    case 'joy': {
      // two hops with the arms flung up in a V: a squat, a spring, the legs
      // tucked under, a squash on landing
      const hop = (t0: number) => {
        const u = (t - t0) / 0.62
        return u > 0 && u < 1 ? u : -1
      }
      const u1 = hop(0.2)
      const u2 = hop(1.0)
      const u = u1 >= 0 ? u1 : u2
      const air = u >= 0 ? 4 * u * (1 - u) : 0
      // the crouch before each hop and the landing after it
      const crouch =
        Math.max(0, 1 - Math.abs(t - 0.14) / 0.12) + Math.max(0, 1 - Math.abs(t - 0.94) / 0.12) +
        Math.max(0, 1 - Math.abs(t - 0.84) / 0.1) + Math.max(0, 1 - Math.abs(t - 1.64) / 0.12)
      f.lift = air * 0.62
      f.drop = crouch * 0.14
      const tuck = u >= 0 ? Math.sin(Math.PI * u) * 0.22 : 0
      f.liftL = tuck
      f.liftR = tuck
      const up = 0.75 + 0.25 * air
      setL(f, 0.86, mix(0.9, 1.34, up), 0.2)
      setR(f, -0.86, mix(0.9, 1.34, up), 0.2)
      f.elbowOut = 0.6
      f.squash = air * 0.08 - crouch * 0.06
      f.headX = -0.22 * up
      f.lid = u >= 0 ? 0.3 : 1
      f.mute = 0.9
      break
    }
    case 'sit': {
      // down onto the ground, legs out in front, leaning back on both
      // mittens and looking about
      const down = smooth(ramp(0, 0.55, t))
      f.hipY = mix(0.62, 0.46, down)
      f.hipPitch = -0.16 * down
      f.legs = true
      f.thighX = -1.25 * down - 0.2 * (1 - down)
      f.thighZ = 0.14
      f.shin = 0.1 + 0.5 * (1 - down)
      f.torsoX = -0.26 * down + Math.sin(t * 1.7) * 0.02
      setL(f, 0.76, 0.02, -0.36)
      setR(f, -0.76, 0.02, -0.36)
      f.elbowOut = 0.2
      f.headX = 0.08
      f.headY = Math.sin(t * 0.45) * 0.35 * ramp(1.2, 2.2, t)
      f.squash = Math.sin(t * 1.7) * 0.015
      f.mute = 1
      break
    }
  }
  return out
}
