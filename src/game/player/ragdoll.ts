import * as THREE from 'three'
import type { CollisionSet } from '../physics/collision'
import { seeded } from '../core/rand'

/*
  A tiny verlet ragdoll: point masses at the skeleton's joints, distance
  constraints along the bones plus a few braces that keep the torso a stiff
  triangle and the neck from folding flat. No physics library — thirteen-odd
  particles and twenty-odd constraints relaxed a few times per substep is
  nothing next to a draw call, which is the whole point on a cold iGPU. The
  world it collides with is the same one the walker uses: the level's flat
  groundY underfoot and its CollisionSet boxes pushed out on x/z (a particle
  only argues with a box while inside the box's y-span, so a body can still
  drape over low furniture). Rest lengths are measured from the pose handed
  to start(), so the sim always agrees with however the rig was standing.
  The launch jitter draws from a seeded() stream — never Math.random() — so
  a given flop replays identically.
*/

export interface RagdollEnv {
  groundY: number
  ceilingY?: number
  collision: CollisionSet
}

export interface RagdollLink {
  a: number
  b: number
  /** 0..1 per relaxation pass; soft braces use less than bone edges */
  stiff?: number
}

export interface Ragdoll {
  /** particle positions, world space; read for bone fitting and the camera */
  readonly pts: THREE.Vector3[]
  /** snapshot the pose, hurl it, and measure every rest length from it */
  start: (joints: THREE.Vector3[], vel: THREE.Vector3, seed: number) => void
  step: (dt: number, env: RagdollEnv) => void
  /** average particle speed, units/s — the settle detector */
  motion: () => number
}

const SUBSTEP = 1 / 120
const RELAX = 4
const DRAG = 0.5 // per-second velocity bleed, air and rolling both
const FLOOR_GRIP = 0.55 // fraction of planar slide a floor touch eats

export function createRagdoll(radii: number[], links: RagdollLink[], grav = 34): Ragdoll {
  const n = radii.length
  const pts = Array.from({ length: n }, () => new THREE.Vector3())
  const prev = Array.from({ length: n }, () => new THREE.Vector3())
  const rest = new Float32Array(links.length)
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

  const substep = (env: RagdollEnv) => {
    const { groundY, ceilingY, collision } = env
    const keep = 1 - DRAG * SUBSTEP
    let travel = 0
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      delta.subVectors(p, prev[i]).multiplyScalar(keep)
      travel += delta.length()
      prev[i].copy(p)
      p.add(delta)
      p.y -= grav * SUBSTEP * SUBSTEP
    }
    speed = travel / n / SUBSTEP
    for (let pass = 0; pass < RELAX; pass++) {
      for (let i = 0; i < links.length; i++) {
        const { a, b, stiff = 1 } = links[i]
        delta.subVectors(pts[b], pts[a])
        const d = delta.length()
        if (d < 1e-6) continue
        const k = ((d - rest[i]) / d) * 0.5 * stiff
        pts[a].addScaledVector(delta, k)
        pts[b].addScaledVector(delta, -k)
      }
      for (let i = 0; i < n; i++) {
        const p = pts[i]
        const r = radii[i]
        const floor = groundY + r
        if (p.y < floor) {
          p.y = floor
          // ground friction: eat most of the slide, keep a little roll
          prev[i].x += (p.x - prev[i].x) * FLOOR_GRIP
          prev[i].z += (p.z - prev[i].z) * FLOOR_GRIP
        }
        if (ceilingY !== undefined && p.y > ceilingY - r) p.y = ceilingY - r
        p.x = THREE.MathUtils.clamp(p.x, collision.bounds.minX, collision.bounds.maxX)
        p.z = THREE.MathUtils.clamp(p.z, collision.bounds.minZ, collision.bounds.maxZ)
        for (const box of collision.boxes) {
          if (
            p.x > box.min.x - r &&
            p.x < box.max.x + r &&
            p.z > box.min.z - r &&
            p.z < box.max.z + r &&
            p.y > box.min.y - r &&
            p.y < box.max.y + r
          ) {
            const exitL = p.x - (box.min.x - r)
            const exitR = box.max.x + r - p.x
            const exitN = p.z - (box.min.z - r)
            const exitF = box.max.z + r - p.z
            const m = Math.min(exitL, exitR, exitN, exitF)
            if (m === exitL) p.x = box.min.x - r
            else if (m === exitR) p.x = box.max.x + r
            else if (m === exitN) p.z = box.min.z - r
            else p.z = box.max.z + r
          }
        }
      }
    }
  }

  return {
    pts,
    start,
    step: (dt, env) => {
      // fixed substeps: verlet stiffness must not depend on the frame rate
      carry += Math.min(dt, 0.05)
      while (carry >= SUBSTEP) {
        carry -= SUBSTEP
        substep(env)
      }
    },
    motion: () => speed,
  }
}
