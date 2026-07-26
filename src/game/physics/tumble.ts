import * as THREE from 'three'
import type { CollisionSet } from './collision'

/*
  A rigid rod, thrown — the physics behind a tree a car has just driven
  through (world/debris.ts).

  It is player/ragdoll.ts with the skeleton taken out: verlet point masses,
  fixed substeps, a distance constraint relaxed a few times per step, and the
  same world underneath — the ground below everything and the level's
  CollisionSet resolved along whichever of its five exposed faces is nearest.
  Two particles and one constraint, because that is all a trunk, a cactus or
  a lamp post is: an axisymmetric stick whose roll nobody can see. The pose it
  hands back is therefore a point and a direction rather than a full frame,
  which is exactly what a mesh with its long axis on +y needs.

  Two things it does that the ragdoll does not, and both are the open world's
  fault. The ground is a *function* rather than a number, because a felled
  pine is ten units long and the world under it is a hillside — one flat
  groundY per body puts one end of it a metre underground. And the two ends
  are launched independently: a car catches a trunk at bumper height, so the
  base is shoved and the crown whips over the top of it, and a rod given one
  velocity for both ends slides through the air like a dropped plank.

  It sleeps. A settled body is the common case — the pool holds a dozen of
  them and eleven are lying still — so `asleep` latches once the ends have
  been slow for long enough and `step` becomes free after that.
*/

export interface TumbleEnv {
  /** the drawn ground anywhere in the world */
  groundAt: (x: number, z: number) => number
  collision: CollisionSet
}

export interface Tumbler {
  /** the anchored end (the stump), world space */
  readonly a: THREE.Vector3
  /** ...and the far end. b - a is the body's long axis, `rest` units of it */
  readonly b: THREE.Vector3
  /** it has stopped moving and no longer costs anything */
  readonly asleep: boolean
  step: (dt: number, env: TumbleEnv) => void
}

export interface TumbleSpec {
  /** the rest pose: base and tip, world space */
  a: THREE.Vector3
  b: THREE.Vector3
  /** how thick each end is — what holds it off the ground it lands on */
  ra: number
  rb: number
  /** and how fast each end leaves */
  va: THREE.Vector3
  vb: THREE.Vector3
}

const SUBSTEP = 1 / 120
const RELAX = 3
const GRAV = 30
/** per-second velocity bleed, air and rolling both */
const DRAG = 0.4
/** fraction of the planar slide a ground touch eats */
const GRIP = 0.5
/** how slow both ends must be, and for how long, before it stops ticking */
const SLEEP_SPEED = 0.3
const SLEEP_TIME = 0.5
/** interior samples that keep a long body from sinking into a crest between
    its own ends. Two is enough for a ten-unit trunk on this terrain's
    lattice; the ends themselves cover the rest */
const MID = [0.33, 0.67]

export const createTumbler = (spec: TumbleSpec): Tumbler => {
  const pts = [spec.a.clone(), spec.b.clone()]
  const prev = [
    spec.a.clone().addScaledVector(spec.va, -SUBSTEP),
    spec.b.clone().addScaledVector(spec.vb, -SUBSTEP),
  ]
  const radii = [spec.ra, spec.rb]
  const rest = spec.a.distanceTo(spec.b)
  const delta = new THREE.Vector3()
  let carry = 0
  let still = 0
  let asleep = false
  /** average end speed, units/s. It has to survive a frame that ran no
      substep at all, or a fast machine puts a body to sleep in mid-air */
  let speed = Infinity

  /**
   * Put an end down on a surface at `y`.
   *
   * The vertical half is why this is a function rather than an assignment.
   * In verlet, position *is* velocity: lifting a particle out of a floor
   * without moving `prev` with it hands the body (lift / SUBSTEP) units per
   * second of upward speed, and the correction on the very first substep is
   * the whole end radius — a quarter of a unit at 120 Hz, which is thirty
   * units a second of free launch. A felled lamp post went ten units into the
   * air off its own stump before this was a function. Ends therefore land
   * dead, which is also what a log does; the planar half keeps the ragdoll's
   * partial grip so a body still rolls a little where it hits.
   */
  const land = (i: number, y: number) => {
    const p = pts[i]
    p.y = y
    prev[i].y = y
    prev[i].x += (p.x - prev[i].x) * GRIP
    prev[i].z += (p.z - prev[i].z) * GRIP
  }

  /** the ragdoll's box resolve, particle by particle: five exposed faces,
      nearest one wins, and no bottom exit — pushing a point out underneath
      posts it through the floor the box is standing on */
  const resolve = (i: number, env: TumbleEnv) => {
    const p = pts[i]
    const r = radii[i]
    const floor = env.groundAt(p.x, p.z) + r
    if (p.y < floor) {
      land(i, floor)
    }
    for (const box of env.collision.boxes) {
      if (
        p.x <= box.min.x - r || p.x >= box.max.x + r ||
        p.z <= box.min.z - r || p.z >= box.max.z + r ||
        p.y <= box.min.y - r || p.y >= box.max.y + r
      ) continue
      const exitL = p.x - (box.min.x - r)
      const exitR = box.max.x + r - p.x
      const exitN = p.z - (box.min.z - r)
      const exitF = box.max.z + r - p.z
      const exitT = box.max.y + r - p.y
      const m = Math.min(exitL, exitR, exitN, exitF, exitT)
      if (m === exitT) land(i, box.max.y + r)
      else if (m === exitL) p.x = box.min.x - r
      else if (m === exitR) p.x = box.max.x + r
      else if (m === exitN) p.z = box.min.z - r
      else p.z = box.max.z + r
    }
  }

  const substep = (env: TumbleEnv) => {
    const keep = 1 - DRAG * SUBSTEP
    let travel = 0
    for (let i = 0; i < 2; i++) {
      delta.subVectors(pts[i], prev[i]).multiplyScalar(keep)
      travel += delta.length()
      prev[i].copy(pts[i])
      pts[i].add(delta)
      pts[i].y -= GRAV * SUBSTEP * SUBSTEP
    }
    for (let pass = 0; pass < RELAX; pass++) {
      delta.subVectors(pts[1], pts[0])
      const d = delta.length()
      if (d > 1e-6) {
        const k = ((d - rest) / d) * 0.5
        pts[0].addScaledVector(delta, k)
        pts[1].addScaledVector(delta, -k)
      }
      resolve(0, env)
      resolve(1, env)
    }
    // ...and the span between them. A ten-unit trunk laid across a rise
    // meets the ground in the middle first, and neither end knows it
    for (const t of MID) {
      const mx = pts[0].x + (pts[1].x - pts[0].x) * t
      const mz = pts[0].z + (pts[1].z - pts[0].z) * t
      const my = pts[0].y + (pts[1].y - pts[0].y) * t
      const under = env.groundAt(mx, mz) + (radii[0] + radii[1]) * 0.5 - my
      if (under <= 0) continue
      // lift each end by its share of the shortfall, which pivots the body
      // about the contact rather than levitating it — and carry `prev` up
      // with it, for the same reason `land` does
      for (let i = 0; i < 2; i++) {
        const share = under * (i === 0 ? 1 - t : t)
        pts[i].y += share
        prev[i].y += share
      }
    }
    return travel / 2 / SUBSTEP
  }

  return {
    get a() {
      return pts[0]
    },
    get b() {
      return pts[1]
    },
    get asleep() {
      return asleep
    },
    step: (dt, env) => {
      if (asleep) return
      carry += Math.min(dt, 0.05)
      while (carry >= SUBSTEP) {
        carry -= SUBSTEP
        speed = substep(env)
      }
      if (speed > SLEEP_SPEED) {
        still = 0
        return
      }
      still += dt
      if (still > SLEEP_TIME) asleep = true
    },
  }
}
