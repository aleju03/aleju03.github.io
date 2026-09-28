import * as THREE from 'three'
import { topAt, type CollisionSet } from '../physics/collision'
import { seeded } from '../core/rand'

/*
  A small verlet ragdoll: point masses at the skeleton's joints, distance
  constraints along the bones plus a few braces that keep the trunk a stiff
  wedge and the neck from folding flat, and one-sided separations that stop
  limbs passing through each other (a distance link would tether them; a
  separation only ever pushes apart). No physics library: thirteen particles
  and thirty-odd constraints relaxed a few times per substep is nothing next
  to a draw call, which is the whole point on a cold iGPU. The world it
  collides with is the same one the walker uses: the ground under each
  particle, and the level's CollisionSet boxes resolved along whichever of
  their five exposed faces is nearest, so a body thrown at the sofa drapes
  over the cushion instead of being squeezed out sideways onto the rug.

  Particles have mass. The head is heavy and the hands are light, and every
  correction is shared by inverse mass, so a body tumbles head-first and its
  mittens flap after it rather than the whole thing moving as a lattice.

  Four ways in from outside, all of them what a sandbox wants:

  - `kick(i, dv)` adds velocity to one particle. `hit` in playerBody.ts spreads
    an impulse over the particles near a point with it.
  - `pin(i, target, k)` pulls a particle toward a live target point every
    substep (k = 1 is a hard hold). It is the grab: a physgun, a hand, a hook.
    The target is read by reference, so the caller moves it and the body
    follows. `pin(i, null)` lets go.
  - `drive(targets, k)` is muscle: every particle pulled toward its own
    target with its own strength. The get-up is built on it (the body hauls
    itself toward the standing pose under gravity, so it wobbles up rather
    than blending), and nothing stops a caller using it for anything else.
  - `shift(d)` moves the whole cloud rigidly, velocities untouched.

  Contacts obey the rule in src/game/CLAUDE.md: a correction that moves a
  particle moves its previous position with it, or the lift becomes free
  velocity (the lamp post that climbed ten units off its own stump). Here a
  floor contact keeps a sliver of the incoming speed as bounce, and eats the
  rest. Rest lengths are measured from the pose handed to start(), so the sim
  always agrees with however the rig was standing. The launch jitter draws
  from a seeded() stream, never Math.random(), so a given flop replays
  identically.
*/

export interface RagdollEnv {
  /** the floor under the body where no better answer exists */
  groundY: number
  /** the floor under any point, when the level has terrain. Sampled once per
      particle per frame, not per substep */
  groundAt?: (x: number, z: number) => number
  ceilingY?: number
  collision: CollisionSet
}

export interface RagdollLink {
  a: number
  b: number
  /** 0..1 per relaxation pass; soft braces use less than bone edges */
  stiff?: number
}

/** a one-sided constraint: pushes the pair apart when they close inside
    `min`, never pulls them together. This is what keeps a crumpled body from
    folding an arm through its own chest */
export interface RagdollSep {
  a: number
  b: number
  /** world units, like the radii */
  min: number
  stiff?: number
}

export interface Ragdoll {
  /** particle positions, world space; read for bone fitting and the camera */
  readonly pts: THREE.Vector3[]
  /** snapshot the pose, hurl it, and measure every rest length from it */
  start: (joints: THREE.Vector3[], vel: THREE.Vector3, seed: number) => void
  step: (dt: number, env: RagdollEnv) => void
  /** average particle speed, units/s: the settle detector */
  motion: () => number
  /** add velocity to one particle, units/s */
  kick: (i: number, dv: THREE.Vector3) => void
  /** this particle's velocity, units/s */
  velocity: (i: number, out: THREE.Vector3) => THREE.Vector3
  /** hold a particle toward a live point (read by reference), or let go */
  pin: (i: number, target: THREE.Vector3 | null, k?: number) => void
  /** is anything holding this particle */
  pinned: (i: number) => boolean
  /** pull every particle toward its own target, strength per particle
      (0..1 per substep). `null` switches the muscles off */
  drive: (targets: THREE.Vector3[] | null, k?: Float32Array) => void
  /** move the whole cloud rigidly */
  shift: (d: THREE.Vector3) => void
}

const SUBSTEP = 1 / 120
const RELAX = 4
const DRAG = 0.45 // per-second velocity bleed, air and rolling both
const FLOOR_GRIP = 0.3 // fraction of planar slide a floor touch eats, per pass
/** a floor touch keeps this much of the speed it arrived with, as long as it
    arrived fast enough for a bounce to be a bounce rather than a buzz */
const BOUNCE = 0.28
const BOUNCE_MIN = 2.5

export function createRagdoll(
  radii: number[],
  links: RagdollLink[],
  seps: RagdollSep[] = [],
  grav = 34,
  masses?: number[],
): Ragdoll {
  const n = radii.length
  const pts = Array.from({ length: n }, () => new THREE.Vector3())
  const prev = Array.from({ length: n }, () => new THREE.Vector3())
  const inv = new Float32Array(n).map((_, i) => 1 / (masses?.[i] ?? 1))
  const rest = new Float32Array(links.length)
  const floors = new Float32Array(n)
  const pinTo: Array<THREE.Vector3 | null> = new Array(n).fill(null)
  const pinK = new Float32Array(n)
  let driveTo: THREE.Vector3[] | null = null
  let driveK: Float32Array | null = null
  const delta = new THREE.Vector3()
  let carry = 0 // leftover frame time under one substep
  let speed = 0

  const start = (joints: THREE.Vector3[], vel: THREE.Vector3, seed: number) => {
    const rnd = seeded(seed)
    for (let i = 0; i < n; i++) {
      pts[i].copy(joints[i])
      // prev encodes velocity: the throw itself plus a per-joint scatter so
      // the body tumbles instead of gliding off in formation
      prev[i]
        .copy(joints[i])
        .addScaledVector(vel, -SUBSTEP)
        .add(
          delta.set((rnd() - 0.5) * 1.6, (rnd() - 0.5) * 1.2, (rnd() - 0.5) * 1.6).multiplyScalar(
            SUBSTEP,
          ),
        )
    }
    links.forEach((l, i) => {
      rest[i] = joints[l.a].distanceTo(joints[l.b])
    })
    carry = 0
    speed = 3 // never born settled
  }

  /** move a pair apart or together by inverse mass */
  const solve = (a: number, b: number, d: number, target: number, stiff: number) => {
    const wa = inv[a]
    const wb = inv[b]
    const w = wa + wb
    if (w <= 0) return
    const k = ((d - target) / d) * stiff
    pts[a].addScaledVector(delta, k * (wa / w))
    pts[b].addScaledVector(delta, -k * (wb / w))
  }

  const substep = (env: RagdollEnv) => {
    const { ceilingY, collision } = env
    const keep = 1 - DRAG * SUBSTEP
    let travel = 0
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      delta.subVectors(p, prev[i]).multiplyScalar(keep)
      travel += delta.length()
      prev[i].copy(p)
      p.add(delta)
      p.y -= grav * SUBSTEP * SUBSTEP
      // muscles and grabs act like springs on position, and move prev along
      // by only part of the pull so the motion they cause carries momentum
      // (a thrown grab keeps flying) without the pull itself becoming speed
      const tgt = pinTo[i]
      if (tgt) {
        delta.subVectors(tgt, p).multiplyScalar(pinK[i])
        p.add(delta)
        prev[i].addScaledVector(delta, 0.6)
      }
      if (driveTo && driveK && driveK[i] > 0) {
        delta.subVectors(driveTo[i], p).multiplyScalar(driveK[i])
        p.add(delta)
        prev[i].addScaledVector(delta, 0.75)
      }
    }
    speed = travel / n / SUBSTEP
    for (let pass = 0; pass < RELAX; pass++) {
      for (let i = 0; i < links.length; i++) {
        const { a, b, stiff = 1 } = links[i]
        delta.subVectors(pts[b], pts[a])
        const d = delta.length()
        if (d < 1e-6) continue
        solve(a, b, d, rest[i], stiff)
      }
      // one-sided: limbs may spread freely, they just can't pass through
      for (let i = 0; i < seps.length; i++) {
        const { a, b, min, stiff = 1 } = seps[i]
        delta.subVectors(pts[b], pts[a])
        const d = delta.length()
        if (d >= min || d < 1e-6) continue
        solve(a, b, d, min, stiff)
      }
      for (let i = 0; i < n; i++) {
        const p = pts[i]
        const q = prev[i]
        const r = radii[i]
        const floor = floors[i] + r
        if (p.y < floor) {
          // the speed it came down with, before the floor corrects it
          // (a particle already rising, shoved under by a constraint, only
          // gets its lift carried: it has no fall to bounce)
          const vy = (p.y - q.y) / SUBSTEP
          const lift = floor - p.y
          p.y = floor
          if (vy < 0) q.y = vy < -BOUNCE_MIN ? floor + vy * BOUNCE * SUBSTEP : floor
          else q.y += lift
          // ground friction: eat most of the slide, keep a little roll
          q.x += (p.x - q.x) * FLOOR_GRIP
          q.z += (p.z - q.z) * FLOOR_GRIP
        }
        if (ceilingY !== undefined && p.y > ceilingY - r) {
          p.y = ceilingY - r
          if (q.y > p.y) q.y = p.y
        }
        p.x = THREE.MathUtils.clamp(p.x, collision.bounds.minX, collision.bounds.maxX)
        p.z = THREE.MathUtils.clamp(p.z, collision.bounds.minZ, collision.bounds.maxZ)
        for (const box of collision.boxes) {
          if (
            p.x > box.min.x - r &&
            p.x < box.max.x + r &&
            p.z > box.min.z - r &&
            p.z < box.max.z + r &&
            p.y > box.min.y - r &&
            p.y < topAt(box, p.x, p.z) + r
          ) {
            // five exposed faces, nearest one wins, the top included, so a
            // body that lands on the sofa settles on it. There is no bottom
            // exit on purpose: pushing a particle out underneath would post
            // it through the floor the box is standing on. Whatever is moved
            // takes its previous position along (see the header)
            const exitL = p.x - (box.min.x - r)
            const exitR = box.max.x + r - p.x
            const exitN = p.z - (box.min.z - r)
            const exitF = box.max.z + r - p.z
            // (a roof slope's top is its height here, not its ridge)
            const top = topAt(box, p.x, p.z)
            const exitT = top + r - p.y
            const m = Math.min(exitL, exitR, exitN, exitF, exitT)
            if (m === exitT) {
              p.y = top + r
              if (q.y < p.y) q.y = p.y
              q.x += (p.x - q.x) * FLOOR_GRIP
              q.z += (p.z - q.z) * FLOOR_GRIP
            } else if (m === exitL || m === exitR) {
              const x = m === exitL ? box.min.x - r : box.max.x + r
              q.x += x - p.x
              p.x = x
            } else {
              const z = m === exitN ? box.min.z - r : box.max.z + r
              q.z += z - p.z
              p.z = z
            }
          }
        }
      }
    }
  }

  return {
    pts,
    start,
    step: (dt, env) => {
      for (let i = 0; i < n; i++) {
        floors[i] = env.groundAt ? env.groundAt(pts[i].x, pts[i].z) : env.groundY
      }
      // fixed substeps: verlet stiffness must not depend on the frame rate
      carry += Math.min(dt, 0.05)
      while (carry >= SUBSTEP) {
        carry -= SUBSTEP
        substep(env)
      }
    },
    motion: () => speed,
    kick: (i, dv) => {
      prev[i].addScaledVector(dv, -SUBSTEP)
    },
    velocity: (i, out) => out.subVectors(pts[i], prev[i]).divideScalar(SUBSTEP),
    pin: (i, target, k = 0.35) => {
      pinTo[i] = target
      pinK[i] = k
    },
    pinned: (i) => pinTo[i] !== null,
    drive: (targets, k) => {
      driveTo = targets
      driveK = k ?? null
    },
    shift: (d) => {
      for (let i = 0; i < n; i++) {
        pts[i].add(d)
        prev[i].add(d)
      }
    },
  }
}
