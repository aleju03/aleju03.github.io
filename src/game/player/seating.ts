import * as THREE from 'three'

/*
  Sitting down on the furniture.

  A seat is not a vehicle and must not be built like one. `vehicles/registry`
  owns a machine that moves, so riding one takes the camera away from the walk
  controller entirely and CrtScene runs a second tick for it. A sofa moves
  nowhere: the whole of sitting on it is that the walker stops, the lens drops
  to cushion height, and the head is only allowed to turn so far. So this
  module owns the *arithmetic* of that and nothing else (where the eye goes,
  which way it may look, and where you stand back up), and the scene keeps
  running its one ordinary walk tick with the controller frozen. That is what
  makes a seat cost four lines at the call site instead of a second loop.

  Two numbers are worth naming. The seated eye is a fraction of the standing
  one measured off the body, not a guess: a person's eye drops to a bit under
  half its standing height when they sit, which at this scale is the
  difference between looking at the television and looking over it. And the
  look cone exists because a first-person sitter with a free head can spin
  round and stare through the back of the sofa; clamping the yaw against the
  seat's own facing keeps you in the pose the furniture implies, and the pitch
  clamp keeps the lens off your own knees.

  Headless-safe and renderer-free like the rest of `src/game`: it takes and
  returns numbers and Vector3s, and never touches a camera itself.
*/

export interface SeatSpec {
  /** what the prompt calls it: "the sofa", "the armchair" */
  label: string
  /** the cushion this sitter lands on, world */
  x: number
  z: number
  /** the top of that cushion */
  cushionY: number
  /** which way the seat points its occupant */
  yaw: number
  /** where the walker is put back down on standing; defaults to a step out
      in front of the seat, on the floor the seat is standing on */
  stand?: { x: number; z: number; y: number }
  /** how far the head may turn either side of `yaw`, radians */
  cone?: number
  /** this seat is pointed at the television, so its occupant may work the
      channels. A bed two rooms away must not: the dial is bound to the
      movement keys, which are free while you sit, and a seat that answered
      them from anywhere would have the walls changing channel */
  atTv?: boolean
}

export interface Seat extends SeatSpec {
  /** where the eye ends up: the cushion plus a seated body */
  eyeY: number
  cone: number
  stand: { x: number; z: number; y: number }
  atTv: boolean
}

export interface SeatingHandles {
  add: (spec: SeatSpec) => void
  /** the seat in reach the player is looking at, if they are not in one */
  prompt: (p: THREE.Vector3, gaze: THREE.Vector3) => string | null
  /** take it. Returns the seat, or null when nothing was in reach */
  sit: (p: THREE.Vector3, gaze: THREE.Vector3) => Seat | null
  /** get up. Returns where to put the walker back down */
  stand: () => { x: number; z: number; y: number; yaw: number } | null
  readonly current: Seat | null
  /** clamp a head that is sitting in `current` to the pose the seat implies */
  hold: (yaw: number, pitch: number) => { yaw: number; pitch: number }
  /** where the lens goes this frame */
  eye: (out: THREE.Vector3) => THREE.Vector3
}

/** Seated eye height, as a fraction of the standing one, over the cushion.
    It places the body as well as the lens now, since `playerBody.sit()` hangs
    the fold from its eye, so it is also what lands a sitter's hips on the
    cushion instead of through it: at this fraction the pelvis settles about a
    finger's width into one, which is what a cushion is for. */
const SEATED = 0.46
/** how far the head turns either side of the seat's own facing, by default */
const CONE = Math.PI * 0.62
/** and how far it may look down: enough to see your own lap, not your chest */
const PITCH_DOWN = -0.95
const PITCH_UP = 0.75
/** how far the player may stand from a cushion and still drop onto it */
const REACH2 = 3.4 * 3.4
/**
 * How far off the middle of the view it may sit, measured *flat*, the way
 * the room doors measure theirs, and deliberately not in three dimensions
 * the way the working furniture does.
 *
 * The cupboards need the full gaze because a kitchen run stacks three
 * openable things in one column a metre wide. A seat has no such neighbour,
 * and the 3D test is actively wrong for one: a cushion is a metre off the
 * floor and your eye is nearly four, so standing *right beside* the sofa,
 * exactly where somebody about to sit on it stands, puts it forty-five
 * degrees below the gaze and out of the cone. It got stricter the closer you
 * came, which is the opposite of a reach.
 */
const AIM = 0.35
/** how far above or below the eye a cushion may be and still be sat on */
const RISE = 3.4

export function createSeating(eyeHeight: number): SeatingHandles {
  const seats: Seat[] = []
  let current: Seat | null = null

  const add = (spec: SeatSpec) => {
    // a step out in front of the seat, at the height the seat stands on: a
    // sofa's own cushion is not somewhere to be put down on standing up
    const stand = spec.stand ?? {
      x: spec.x + Math.sin(spec.yaw) * 2.1,
      z: spec.z + Math.cos(spec.yaw) * 2.1,
      y: spec.cushionY - 1.0,
    }
    seats.push({
      ...spec,
      eyeY: spec.cushionY + eyeHeight * SEATED,
      cone: spec.cone ?? CONE,
      atTv: spec.atTv ?? false,
      stand,
    })
  }

  const find = (p: THREE.Vector3, gaze: THREE.Vector3): Seat | null => {
    let best: Seat | null = null
    let bestScore = REACH2
    const planarGaze = Math.hypot(gaze.x, gaze.z)
    for (const seat of seats) {
      const dx = seat.x - p.x
      const dz = seat.z - p.z
      const dd = dx * dx + dz * dz
      if (dd >= bestScore || Math.abs(seat.cushionY - p.y) > RISE) continue
      // standing on top of it, any heading will do; past that, face it
      if (dd > 1.0 && planarGaze > 0.001) {
        const facing = (gaze.x * dx + gaze.z * dz) / (Math.sqrt(dd) * planarGaze)
        if (facing < AIM) continue
      }
      bestScore = dd
      best = seat
    }
    return best
  }

  const prompt = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    if (current) return null
    return find(p, gaze)?.label ?? null
  }

  const sit = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    if (current) return null
    const seat = find(p, gaze)
    if (!seat) return null
    current = seat
    return seat
  }

  const stand = () => {
    if (!current) return null
    const { stand: spot, yaw } = current
    current = null
    return { ...spot, yaw }
  }

  /*
    The look clamp. Yaw is wrapped into (-π, π] *relative to the seat* before
    it is clamped, or the wrap point itself becomes a wall: a seat facing a
    hair under π would pin a head that crossed it to the far side of its own
    cone and hold it there.
  */
  const hold = (yaw: number, pitch: number) => {
    if (!current) return { yaw, pitch }
    let rel = (yaw - current.yaw) % (Math.PI * 2)
    if (rel > Math.PI) rel -= Math.PI * 2
    if (rel < -Math.PI) rel += Math.PI * 2
    const cone = current.cone
    return {
      yaw: current.yaw + Math.max(-cone, Math.min(cone, rel)),
      pitch: Math.max(PITCH_DOWN, Math.min(PITCH_UP, pitch)),
    }
  }

  const eye = (out: THREE.Vector3) =>
    current ? out.set(current.x, current.eyeY, current.z) : out

  return {
    add,
    prompt,
    sit,
    stand,
    get current() {
      return current
    },
    hold,
    eye,
  }
}
