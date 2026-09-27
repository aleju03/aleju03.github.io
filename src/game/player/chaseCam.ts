import * as THREE from 'three'
import type { CollisionSet } from '../physics/collision'

/*
  The third-person boom, over the right shoulder.

  The walk controller keeps owning the camera as if it were the player's
  head, and this module brackets it: restore() puts the camera back on the
  head before the sim ticks (so integration never feeds off a boom
  position), apply() saves the head transform the sim just wrote and then
  moves the lens out, blended by a smoothed 0..1 factor so first to third is
  a glide, not a cut.

  The shape is the one every third-person shooter settled on, and for the
  same reason. A boom straight back along the view ray puts the body dead
  centre, which is exactly where the crosshair is, so the thing you aim with
  hides the thing you are aiming at; the old boom worked round that by
  projecting the head's gaze through the lens and moving the crosshair to
  wherever it landed, which put it on your own back half the time and made
  the physgun unplayable. So the lens goes out to the right (`SHOULDER`, the
  side flips with a key), a little under the crown, and back (`BOOM`), with
  the orientation kept, so the body stands in the left third of the frame
  and the middle of the screen is clear. The crosshair then stays dead
  centre, and aiming is the scene's half of the deal: it casts from the lens
  through the crosshair to find what is there, and then aims from the *head*
  at that point (`lens()` gives it this frame's lens for any head pose), so
  what you point at is what you grab, and what the character can reach is
  still measured from the character.

  The lens never goes through a wall. The shoulder offset and then the boom
  are each clipped exactly against the level (a segment through every
  CollisionSet box grown by `MARGIN`, the flat floor under the player, the
  ceiling where there is one) rather than sampled, because a sampled clamp
  moves in sample-sized jumps as you slide along a wall, which is the
  jitter. Shrinking snaps, because a wall must never cross the lens even for
  a frame; growing eases, so leaving a doorway is a glide back out. Turning
  is rigid about the head (the same yaw and pitch as the walk, no lag), and
  the anchor's height is smoothed a little so a stair's riser is a slope in
  the lens rather than a step.

  While the body is ragdolling, a focus point (the chest particle) replaces
  the head: the camera orbits it from behind-and-above and looks at it,
  whatever the player's chosen mode, because a first-person flop shows
  nothing at all.
*/

export interface ChaseEnv {
  collision: CollisionSet
  groundY: number
  ceilingY?: number
  yaw: number
  pitch: number
  /** while the body is down: orbit and watch this point instead of the head */
  focus: THREE.Vector3 | null
  /** over-the-shoulder: how far to the lens's right the boom is offset
      (world units, eased; negative is the left shoulder) */
  shoulder?: number
}

export interface ChaseCam {
  /** 0 on the lens .. 1 fully boomed, smoothed */
  readonly k: number
  /** how far the lens actually is from the head after wall clamping: the
      scene reads it to slide the body back behind a lens a wall has crushed
      onto it, and to tell a real third-person view from a crushed one */
  readonly dist: number
  /** the player's chosen mode; the ragdoll focus overrides it while down */
  third: boolean
  restore: (cam: THREE.PerspectiveCamera) => void
  apply: (cam: THREE.PerspectiveCamera, dt: number, env: ChaseEnv) => void
  /** where the lens is for a head at `head` turned to `quat`, from the boom
      as it last stood: the scene's aim casts from here, through the
      crosshair, between two applies (on the head itself in first person) */
  lens: (head: THREE.Vector3, quat: THREE.Quaternion, out: THREE.Vector3) => THREE.Vector3
  /** forget the stored head and smoothing (roam ended, level swapped) */
  drop: () => void
}

/** boom length at full blend: at the default 60° lens this frames the bean
    from the ankles up, about a sixth of the frame wide */
const BOOM = 5.6
/** how far right of the head the boom stands: at BOOM that puts the body's
    middle about a third of the way across the frame, and its near edge well
    clear of the crosshair */
export const SHOULDER = 1.9
/** the anchor, relative to the lens (the crown): a little over it, so the
    lens looks past the head rather than into the back of it */
const LIFT = 0.15
/** a boom crushed shorter than this folds the whole offset back onto the
    head: past that point the scene draws first person (no body, the gun in
    front of the lens), and a lens still standing a shoulder off to the side
    of it would hang the gun in the corner of the frame */
const FOLD_IN = 0.7
const FOLD_OUT = 2.0
const FOCUS_DIST = 4.6
const FOCUS_PITCH = -0.55 // orbit height angle over a ragdoll
const MARGIN = 0.28 // how far the lens keeps off walls, floor, ceiling

/** how far along o + d·t (t in [0, len]) the segment first enters box b grown
    by m; 0 when it starts inside, null when it never enters */
const entry = (o: THREE.Vector3, d: THREE.Vector3, b: THREE.Box3, m: number, len: number) => {
  let t0 = 0
  let t1 = len
  for (let a = 0; a < 3; a++) {
    const oa = a === 0 ? o.x : a === 1 ? o.y : o.z
    const da = a === 0 ? d.x : a === 1 ? d.y : d.z
    const lo = (a === 0 ? b.min.x : a === 1 ? b.min.y : b.min.z) - m
    const hi = (a === 0 ? b.max.x : a === 1 ? b.max.y : b.max.z) + m
    if (Math.abs(da) < 1e-9) {
      if (oa <= lo || oa >= hi) return null
      continue
    }
    let u = (lo - oa) / da
    let v = (hi - oa) / da
    if (u > v) [u, v] = [v, u]
    if (u > t0) t0 = u
    if (v < t1) t1 = v
    if (t0 >= t1) return null
  }
  return t0
}

/** the longest clear run along o + d·t up to `len`, stopping MARGIN short of
    anything solid. A box the origin is already inside the margin of (the
    head hugging a wall) only stops the ray if it heads into the box itself */
const clip = (o: THREE.Vector3, d: THREE.Vector3, len: number, env: ChaseEnv) => {
  let t = len
  if (d.y < -1e-6) t = Math.min(t, Math.max(0, (env.groundY + MARGIN - o.y) / d.y))
  if (env.ceilingY !== undefined && d.y > 1e-6) {
    t = Math.min(t, Math.max(0, (env.ceilingY - MARGIN - o.y) / d.y))
  }
  for (const b of env.collision.boxes) {
    if (b.max.y <= b.min.y) continue // a retired door blocker
    const e = entry(o, d, b, MARGIN, t)
    if (e === null) continue
    if (e > 0) {
      t = e
      continue
    }
    const r = entry(o, d, b, 0, t)
    if (r !== null && r > 0) t = Math.max(0, r - MARGIN * 0.5)
  }
  return t
}

export function createChaseCam(): ChaseCam {
  let third = false
  let k = 0
  let back = 0 // smoothed clamped boom length
  let lat = 0 // smoothed clamped shoulder offset (magnitude)
  let dist = 0 // the lens's distance from the head, as last applied
  let held = false
  let side = 0 // the eased shoulder offset asked for, signed
  let fold = 0 // 0 lens on the head .. 1 the full offset (a crushed boom)
  let anchorY = NaN // the smoothed anchor height
  const headPos = new THREE.Vector3()
  const headQuat = new THREE.Quaternion()
  const invQ = new THREE.Quaternion()
  const fwd = new THREE.Vector3()
  const back3 = new THREE.Vector3()
  const want = new THREE.Vector3()
  const lookM = new THREE.Matrix4()
  const lookQ = new THREE.Quaternion()
  const right = new THREE.Vector3()
  const pivot = new THREE.Vector3()
  /** the lens relative to the head, in the head's own frame */
  const offLocal = new THREE.Vector3()

  const settle = (now: number, free: number, dt: number, rate: number) =>
    free < now ? free : now + (free - now) * (1 - Math.exp(-rate * dt))

  return {
    get k() {
      return k
    },
    get dist() {
      return dist
    },
    get third() {
      return third
    },
    set third(v: boolean) {
      third = v
    },
    restore: (cam) => {
      if (!held) return
      cam.position.copy(headPos)
      cam.quaternion.copy(headQuat)
    },
    lens: (head, quat, out) => out.copy(offLocal).applyQuaternion(quat).add(head),
    drop: () => {
      held = false
      k = 0
      back = 0
      lat = 0
      dist = 0
      side = 0
      fold = 0
      anchorY = NaN
      offLocal.set(0, 0, 0)
    },
    apply: (cam, dt, env) => {
      headPos.copy(cam.position)
      headQuat.copy(cam.quaternion)
      held = true
      const target = env.focus || third ? 1 : 0
      k += (target - k) * (1 - Math.exp(-7 * dt))
      if (Math.abs(target - k) < 0.002) k = target
      if (k <= 0) {
        dist = 0
        back = 0
        lat = 0
        anchorY = NaN
        offLocal.set(0, 0, 0)
        return
      }
      if (env.focus) {
        // orbit the crumpled body from behind-and-above and keep it framed:
        // fwd points camera→focus, so the boom backs out opposite to it
        fwd.setFromSphericalCoords(1, Math.PI / 2 - FOCUS_PITCH, env.yaw + Math.PI)
        back3.copy(fwd).negate()
        let free = clip(env.focus, back3, FOCUS_DIST, env)
        if (free < 1.2) {
          // the body came to rest against a wall: peek straight down at it
          // instead of collapsing the lens into its chest
          fwd.set(0.02, -1, 0.02).normalize()
          back3.copy(fwd).negate()
          free = Math.max(1.1, clip(env.focus, back3, FOCUS_DIST, env))
        }
        back = settle(back, free, dt, 10)
        want.copy(env.focus).addScaledVector(fwd, -back)
        cam.position.lerpVectors(headPos, want, k)
        lookM.lookAt(cam.position, env.focus, cam.up)
        lookQ.setFromRotationMatrix(lookM)
        cam.quaternion.slerpQuaternions(headQuat, lookQ, k)
        dist = cam.position.distanceTo(headPos)
        offLocal.set(0, 0, 0)
        return
      }
      // the ordinary boom: out over the shoulder, then back along the view
      // ray, orientation kept, so the lens still means "what the walker faces"
      cam.getWorldDirection(fwd)
      // right, level, off the walk's own heading (the view ray has no
      // horizontal part to take it from when looking straight down)
      right.set(Math.cos(env.yaw), 0, -Math.sin(env.yaw))
      // a riser is a step for the feet and a slope for the lens; anything
      // bigger than a stair (a teleport, a seat) is taken as it comes
      const y = headPos.y + LIFT * k
      anchorY = Number.isNaN(anchorY) || Math.abs(y - anchorY) > 1.2
        ? y
        : anchorY + (y - anchorY) * (1 - Math.exp(-16 * dt))
      want.set(headPos.x, anchorY, headPos.z)
      side += ((env.shoulder ?? 0) - side) * (1 - Math.exp(-6 * dt))
      const s = side * k
      if (Math.abs(s) > 1e-3) {
        if (s < 0) right.negate()
        lat = settle(lat, clip(want, right, Math.abs(s), env), dt, 8)
        want.addScaledVector(right, lat)
      } else lat = 0
      back3.copy(fwd).negate()
      // how much room there is behind the full offset decides how much of
      // it to keep: backed into a corner, the lens folds onto the head
      // rather than hanging beside it (FOLD_IN). Folding in only ever
      // moves the lens back along a segment the clips above have cleared
      const room = clip(want, back3, BOOM * k, env)
      const f = THREE.MathUtils.smoothstep(room, FOLD_IN * k, FOLD_OUT * k)
      fold += (f - fold) * (1 - Math.exp(-12 * dt))
      pivot.lerpVectors(headPos, want, fold)
      back = settle(back, clip(pivot, back3, BOOM * k, env) * fold, dt, 8)
      cam.position.copy(pivot).addScaledVector(fwd, -back)
      dist = cam.position.distanceTo(headPos)
      invQ.copy(headQuat).invert()
      offLocal.copy(cam.position).sub(headPos).applyQuaternion(invQ)
    },
  }
}
