import * as THREE from 'three'
import { blockedAt, supportY, type CollisionSet } from '../physics/collision'
import { DESIGN_LENS, DESIGN_SEAT_BOTTOM } from './playerBody'

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

  Standing up is the one place it asks the level anything, and it has to.
  A seat's stand-up spot used to be a number written beside the furniture,
  and the house was redesigned round those numbers twice: a dining chair's
  "a step back out of the seat" came to land inside the wall of the half
  bath beside it, and the walk's push-out resolved the overlap by putting
  the player on the far side of that wall, in the bathroom. So a spot is a
  *preference* now, and `stand()` takes the live collision set and checks
  it: the body has to fit there, on the floor the seat stands on (not over
  the stairwell, not on the storey below), and the straight line from the
  cushion to it must not cross anything taller than the furniture, which is
  what a wall is. The first spot that passes wins, trying the declared one,
  then a ring round the seat that starts behind it (a chair is pushed back
  to stand up) and works round to its front.

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
  /** the floor the seat stands on: where a sitter's feet go back down */
  floor?: number
  /** where the walker would rather be put back down on standing; checked
      against the room at the time (see the header), and defaults to a step
      back out of the seat */
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
  floor: number
  stand: { x: number; z: number; y: number }
  atTv: boolean
}

/** the room a sitter stands back up into: what `stand()` checks a spot
    against. `groundAt` is the level's own floor under a point, the answer
    when no box is */
export interface StandRoom {
  set: CollisionSet
  groundAt: (x: number, z: number) => number
}

export interface SeatingHandles {
  add: (spec: SeatSpec) => void
  /** the seat in reach the player is looking at, if they are not in one */
  prompt: (p: THREE.Vector3, gaze: THREE.Vector3) => string | null
  /** take it. Returns the seat, or null when nothing was in reach */
  sit: (p: THREE.Vector3, gaze: THREE.Vector3) => Seat | null
  /** get up. Returns where to put the walker back down: the first spot
      round the seat the room has space for, when it is given one */
  stand: (room?: StandRoom) => { x: number; z: number; y: number; yaw: number } | null
  readonly current: Seat | null
  /** clamp a head that is sitting in `current` to the pose the seat implies */
  hold: (yaw: number, pitch: number) => { yaw: number; pitch: number }
  /** where the lens goes this frame */
  eye: (out: THREE.Vector3) => THREE.Vector3
}

/** Seated eye height, as a fraction of the standing one, over the cushion.
    It places the body as well as the lens now, since `playerBody.sit()` hangs
    the fold from its eye, so it is also what lands a sitter's hips on the
    cushion instead of through it. So it is measured off the body rather than
    picked: the folded body's eye over the seat of its pants, less a little
    for the cushion to give. A soft body with a big trunk sits tall, which is
    why this is higher than the 0.46 the long-legged robot sat at. */
const SEATED = (DESIGN_SEAT_BOTTOM - 0.05) / DESIGN_LENS
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
/** the standing body a spot must hold, over its floor: the lens and a hair */
const BODY_H = 3.9
/** a rug, a threshold: what the walk steps onto rather than into */
const STEP = 0.45
/** the height the cushion-to-spot line is tested at: over every table,
    counter and cushion in the house, under every wall's top */
const OVER_FURNITURE = 2.4
/** the ring searched round a seat: distances, and headings measured from
    straight behind it, alternating sides as they open out to its front */
const RING_D = [2.1, 1.7, 2.6, 1.35]
const RING_A = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 3, -3, 4].map((a) => (a * Math.PI) / 4)

/** does the flat segment a→b pass through a box standing across height y */
const crosses = (set: CollisionSet, ax: number, az: number, bx: number, bz: number, y: number) => {
  const dx = bx - ax
  const dz = bz - az
  for (const b of set.boxes) {
    if (b.min.y > y || b.max.y < y || b.max.y <= b.min.y) continue
    let t0 = 0
    let t1 = 1
    // slab clip on x, then z: the segment is inside the box for t in [t0, t1]
    if (Math.abs(dx) < 1e-9) {
      if (ax <= b.min.x || ax >= b.max.x) continue
    } else {
      let u = (b.min.x - ax) / dx
      let v = (b.max.x - ax) / dx
      if (u > v) [u, v] = [v, u]
      t0 = Math.max(t0, u)
      t1 = Math.min(t1, v)
      if (t0 >= t1) continue
    }
    if (Math.abs(dz) < 1e-9) {
      if (az <= b.min.z || az >= b.max.z) continue
    } else {
      let u = (b.min.z - az) / dz
      let v = (b.max.z - az) / dz
      if (u > v) [u, v] = [v, u]
      t0 = Math.max(t0, u)
      t1 = Math.min(t1, v)
      if (t0 >= t1) continue
    }
    return true
  }
  return false
}

export function createSeating(eyeHeight: number): SeatingHandles {
  const seats: Seat[] = []
  let current: Seat | null = null

  const add = (spec: SeatSpec) => {
    // a step back out of the seat (a seat faces (-sin yaw, -cos yaw), so
    // +sin/+cos is behind it), at the height the seat stands on: a sofa's
    // own cushion is not somewhere to be put down on standing up
    const floor = spec.floor ?? spec.stand?.y ?? spec.cushionY - 1.0
    const stand = spec.stand ?? {
      x: spec.x + Math.sin(spec.yaw) * 2.1,
      z: spec.z + Math.cos(spec.yaw) * 2.1,
      y: floor,
    }
    seats.push({
      ...spec,
      eyeY: spec.cushionY + eyeHeight * SEATED,
      cone: spec.cone ?? CONE,
      atTv: spec.atTv ?? false,
      floor,
      stand,
    })
  }

  /** the floor a body standing at (x, z) would be on, if it is this seat's:
      null when the body does not fit, the floor is another storey's (the
      stairwell, the room below), or a wall stands between it and the seat */
  const fits = (seat: Seat, room: StandRoom, x: number, z: number) => {
    const { set } = room
    const y = supportY(x, z, seat.floor + STEP, set, room.groundAt(x, z))
    if (Math.abs(y - seat.floor) > STEP) return null
    if (blockedAt(x, z, y, y + BODY_H, set, STEP)) return null
    if (crosses(set, seat.x, seat.z, x, z, seat.floor + OVER_FURNITURE)) return null
    return y
  }

  const standSpot = (seat: Seat, room: StandRoom) => {
    const pref = seat.stand
    const y = fits(seat, room, pref.x, pref.z)
    if (y !== null) return { x: pref.x, z: pref.z, y }
    for (const d of RING_D) {
      for (const a of RING_A) {
        const h = seat.yaw + a
        const x = seat.x + Math.sin(h) * d
        const z = seat.z + Math.cos(h) * d
        const fy = fits(seat, room, x, z)
        if (fy !== null) return { x, z, y: fy }
      }
    }
    // a seat walled in on every side: the declared spot is still the best
    // guess, and the walk's own push-out gets the last word
    return { ...pref }
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

  const stand = (room?: StandRoom) => {
    if (!current) return null
    const seat = current
    current = null
    const spot = room ? standSpot(seat, room) : { ...seat.stand }
    return { ...spot, yaw: seat.yaw }
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
