import * as THREE from 'three'
import type { CollisionSet } from '../physics/collision'

/*
  The third-person boom. The walk controller keeps owning the camera as if
  it were the player's head — this module brackets it: restore() puts the
  camera back on the head before the sim ticks (so integration never feeds
  off a boom position), apply() saves the head transform the sim just wrote
  and then pulls the camera back along the view ray, blended by a smoothed
  0..1 factor so first↔third is a glide, not a cut. The boom ray is clamped
  against the level the same way the walker is — the CollisionSet boxes,
  the flat floor, the ceiling where one exists — by sampling a few points
  down the ray and stopping short of the first blocked one; shrinking snaps
  (a wall must never clip through the lens) while growing eases. While the
  body is ragdolling, a focus point (the chest particle) replaces the head:
  the camera orbits it from behind-and-above and looks at it, whatever the
  player's chosen mode, because a first-person flop shows nothing at all.
*/

export interface ChaseEnv {
  collision: CollisionSet
  groundY: number
  ceilingY?: number
  yaw: number
  pitch: number
  /** while the body is down: orbit and watch this point instead of the head */
  focus: THREE.Vector3 | null
}

export interface ChaseCam {
  /** 0 on the lens .. 1 fully boomed, smoothed */
  readonly k: number
  /** the boom length actually in use after wall clamping — the scene reads
      it to slide the body back behind a lens a wall has crushed onto it */
  readonly dist: number
  /** the player's chosen mode; the ragdoll focus overrides it while down */
  third: boolean
  restore: (cam: THREE.PerspectiveCamera) => void
  apply: (cam: THREE.PerspectiveCamera, dt: number, env: ChaseEnv) => void
  /** forget the stored head and smoothing (roam ended, level swapped) */
  drop: () => void
}

const BOOM = 5.0 // boom length at full blend; the 38° lens needs ~5 units
// to hold the whole ~3-unit body in frame
const DROP = 0.95 // boom anchor sits at the chest, not the eyes, so the
// body rides centered instead of hanging off the frame bottom
const FOCUS_DIST = 4.2
const FOCUS_PITCH = -0.55 // orbit height angle over a ragdoll
const MARGIN = 0.28 // how far the lens keeps off walls, floor, ceiling
const SAMPLES = 12

export function createChaseCam(): ChaseCam {
  let third = false
  let k = 0
  let dist = 0 // smoothed clamped boom length
  let held = false
  const headPos = new THREE.Vector3()
  const headQuat = new THREE.Quaternion()
  const fwd = new THREE.Vector3()
  const want = new THREE.Vector3()
  const probe = new THREE.Vector3()
  const lookM = new THREE.Matrix4()
  const lookQ = new THREE.Quaternion()

  const blocked = (p: THREE.Vector3, env: ChaseEnv) => {
    if (p.y < env.groundY + MARGIN) return true
    if (env.ceilingY !== undefined && p.y > env.ceilingY - MARGIN) return true
    for (const b of env.collision.boxes) {
      if (
        p.x > b.min.x - MARGIN &&
        p.x < b.max.x + MARGIN &&
        p.z > b.min.z - MARGIN &&
        p.z < b.max.z + MARGIN &&
        p.y > b.min.y - MARGIN &&
        p.y < b.max.y + MARGIN
      )
        return true
    }
    return false
  }

  /** longest free length along anchor→dir, probing outward sample by sample */
  const clampRay = (anchor: THREE.Vector3, reach: number, env: ChaseEnv) => {
    let free = 0
    for (let i = 1; i <= SAMPLES; i++) {
      const t = (i / SAMPLES) * reach
      probe.copy(anchor).addScaledVector(fwd, -t)
      if (blocked(probe, env)) break
      free = t
    }
    return free
  }

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
    drop: () => {
      held = false
      k = 0
      dist = 0
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
        return
      }
      if (env.focus) {
        // orbit the crumpled body from behind-and-above and keep it framed:
        // fwd points camera→focus, so the boom backs out opposite to it
        fwd.setFromSphericalCoords(1, Math.PI / 2 - FOCUS_PITCH, env.yaw + Math.PI)
        let free = clampRay(env.focus, FOCUS_DIST, env)
        if (free < 1.2) {
          // the body came to rest against a wall: peek straight down at it
          // instead of collapsing the lens into its chest
          fwd.set(0.02, -1, 0.02).normalize()
          free = Math.max(1.1, clampRay(env.focus, FOCUS_DIST, env))
        }
        dist = free < dist ? free : dist + (free - dist) * (1 - Math.exp(-10 * dt))
        want.copy(env.focus).addScaledVector(fwd, -dist)
        cam.position.lerpVectors(headPos, want, k)
        lookM.lookAt(cam.position, env.focus, cam.up)
        lookQ.setFromRotationMatrix(lookM)
        cam.quaternion.slerpQuaternions(headQuat, lookQ, k)
        return
      }
      // the ordinary boom: back along the view ray from chest height,
      // orientation kept, so the lens still means "what the walker faces"
      cam.getWorldDirection(fwd)
      want.copy(headPos)
      want.y -= DROP * k
      const free = clampRay(want, BOOM * k, env)
      dist = free < dist ? free : dist + (free - dist) * (1 - Math.exp(-10 * dt))
      cam.position.copy(want).addScaledVector(fwd, -dist)
    },
  }
}
