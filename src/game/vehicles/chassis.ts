import * as THREE from 'three'
import { hullExit, supportY, type CollisionSet, type Solid } from '../physics/collision'
import type { StepSurface } from '../core/sfx'
import type { DriveEnv } from './types'

/*
  The physics every vehicle shares: what holds it up, what stops it, and how
  hard it is to push around on whatever it is standing on.

  Three things live here rather than in the three vehicle modules.

  The *support probe*. A wheel, a skid or a keel all ask the same question —
  how high is the world at this exact point — and the answer is the same one
  the walk controller uses: the level's terrain function, unless a collision
  box top stands between. That shared answer is what makes a car able to drive
  up onto a kerb, over a road deck and onto the porch, without any of those
  surfaces knowing a car exists.

  The *hull sweep*. A vehicle is not a point, so it cannot use resolveXZ. It
  sweeps a handful of sample points around its own footprint through the same
  Box3 list, takes the deepest penetration, and hands back the push and where
  on the body it happened — which is what lets the caller turn a glancing
  contact into a scrape and a square one into a stop, and give either a bit of
  yaw. Deliberately the same linear scan the walk does: the world already
  keeps only the nine chunks around the player live (streamer.ts's
  SOLID_RADIUS), which is a few hundred boxes, and at six probes a frame that
  is cheaper than any structure that would replace it.

  The *surface table*. Asphalt grips, grass slides a little and drags a lot,
  sand and snow drag hard, and water is not a driving surface at all. One
  table, read by the car for cornering and by the effects for what colour the
  dust is.
*/

/* --------------------------------------------------------------- support -- */

/** how far above a probe a box top may be and still count as the thing under
    it. Generous enough that a wheel rolling onto a 0.15 kerb finds it */
const CLIMB = 0.55

/**
 * The height of whatever holds a vehicle up at (x, z): the drawn ground, or
 * the tallest collision box top standing over it and under `reach`.
 *
 * `reach` is the ceiling on what counts — pass the wheel's current height plus
 * a step allowance, exactly as the walk passes its feet plus tune.step, or a
 * car parked beside a tower block finds the tower's roof and levitates.
 */
export const groundUnder = (x: number, z: number, reach: number, env: DriveEnv) => {
  const floor = env.groundAt(x, z)
  return supportY(x, z, reach, env.collision, floor)
}

/** the same probe with a sensible default reach for a body resting at `y` */
export const surfaceUnder = (x: number, z: number, y: number, env: DriveEnv) =>
  groundUnder(x, z, y + CLIMB, env)

/**
 * The up vector of the drawn ground, from four samples a metre or so apart.
 * Used to settle a parked vehicle onto a slope and to keep a boat's wake flat
 * against the water rather than against the world.
 */
export const groundNormal = (
  x: number,
  z: number,
  env: DriveEnv,
  out: THREE.Vector3,
  d = 1.6,
) => {
  const gx = env.groundAt(x + d, z) - env.groundAt(x - d, z)
  const gz = env.groundAt(x, z + d) - env.groundAt(x, z - d)
  return out.set(-gx, 2 * d, -gz).normalize()
}

/* ----------------------------------------------------------- hull sweep -- */

export interface SweepHit {
  /** how far the body had to move to get out, world units */
  push: THREE.Vector3
  /** the offset from the body's centre where the deepest contact happened */
  at: THREE.Vector3
  /** the deepest penetration found, 0 for a clean frame */
  depth: number
  /** and which solid it was, so a caller can ask whether the thing it just
      met is something that gives way (collision.ts's Breakable) */
  solid: Solid | null
}

const hit: SweepHit = {
  push: new THREE.Vector3(), at: new THREE.Vector3(), depth: 0, solid: null,
}
/** scratch for the hull branch of sweepBody, kept out of the loop */
const exit = { px: 0, pz: 0, depth: 0 }

/**
 * Where a *wall* is probed, as fractions of (halfX, halfZ): the four corners
 * and the middle of each flank. A long body scraping a wall touches at the
 * flank and the corners never see it, which is what the middle pair is for.
 *
 * Six points is enough for a wall and hopeless for a post, which is why they
 * are no longer the only test — see `sweepBody`.
 */
const PROBE: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [1, -1], [1, 1], [-1, 1],
  [-1, 0], [1, 0],
]

/**
 * Push an oriented footprint out of the world.
 *
 * `half` is the body's half-length (z) and half-width (x) in its own frame.
 * Every solid argues with the body only where the body's own y-span overlaps
 * it — the same height rule collision.ts applies to the player, so a low kerb
 * is something to drive over and not something to stop against. The returned
 * push is the single deepest one rather than a sum: adding several pushes
 * together in a corner ejects a car across the street.
 *
 * There are two tests, chosen per solid by how big it is, and the split is the
 * whole point of this function.
 *
 * A solid **bigger than the body** is sampled at `PROBE`. Sampling can only
 * ever find a solid that reaches one of those points, and that is fine for a
 * wall or a building: they are longer than the gaps.
 *
 * A solid **smaller than the body** is tested exactly, as an oriented
 * rectangle against a box, because sampling a nine-unit car with six points
 * leaves the entire middle of it blind — measured, 255 of 273 positions inside
 * the footprint. Anything that got in there (a yaw that swept the flank over
 * it, one fast substep, a machine recalled onto it) was invisible from then
 * on, and you drove away with a lamp post through the roof. There is no probe
 * count that fixes that; the body has an interior and points do not cover
 * areas. The box's own extent is folded onto the body's axes and the box
 * centre tested against the grown rectangle, which is a Minkowski sum with two
 * of the four separating axes — the two omitted ones can only over-report, and
 * only within the solid's own width at forty-five degrees.
 */
export const sweepBody = (
  centre: THREE.Vector3,
  yaw: number,
  halfX: number,
  halfZ: number,
  bottom: number,
  top: number,
  set: CollisionSet,
  skip?: Solid,
): SweepHit => {
  hit.depth = 0
  hit.push.set(0, 0, 0)
  hit.at.set(0, 0, 0)
  hit.solid = null
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const ac = Math.abs(c)
  const as = Math.abs(s)
  for (const b of set.boxes) {
    if (b === skip) continue
    if (b.max.y <= bottom || b.min.y >= top) continue
    if (b.hull) {
      /*
        A machine is not the box that bounds it.

        The AABB round a 9.4-unit car parked at forty-five degrees is half as
        wide again as the car is long, and registry.ts's own header calls what
        that leaves "an invisible wall parked next to the car". The walker has
        read the oriented profile since hulls were added; this sweep did not,
        so vehicle met vehicle, and a driver met a parked machine, through
        two bounding boxes, at a couple of units off the paint.

        Probe the same six points as a wall, against the profile instead of the
        box. The box still fronts it as the broad phase (it is the hull's own
        extent, so nothing that misses it can hit the hull), and the y-span
        test above still uses the box's roofline, which can only over-report.
      */
      for (const [fx, fz] of PROBE) {
        const lx = fx * halfX
        const lz = fz * halfZ
        const wx = centre.x + lx * c + lz * s
        const wz = centre.z - lx * s + lz * c
        if (!hullExit(b.hull, wx, wz, exit)) continue
        if (exit.depth <= hit.depth) continue
        hit.depth = exit.depth
        hit.solid = b
        hit.push.set(exit.px, 0, exit.pz)
        hit.at.set(wx - centre.x, 0, wz - centre.z)
      }
      continue
    }

    const bw = (b.max.x - b.min.x) * 0.5
    const bd = (b.max.z - b.min.z) * 0.5

    if (bw < halfX && bd < halfZ) {
      // small enough to sit inside the footprint: test it exactly, in the
      // body's own frame, where the four ways out are the flanks and the ends
      const dx = (b.min.x + b.max.x) * 0.5 - centre.x
      const dz = (b.min.z + b.max.z) * 0.5 - centre.z
      const lx = dx * c - dz * s
      const lz = dx * s + dz * c
      const ex = halfX + ac * bw + as * bd
      const ez = halfZ + as * bw + ac * bd
      if (lx <= -ex || lx >= ex || lz <= -ez || lz >= ez) continue
      // ...and these are the distances the *solid* would travel to leave, so
      // the body moves the other way: something dead ahead (local -z) exits
      // forward and pushes the body back
      const exitL = lx + ex
      const exitR = ex - lx
      const exitN = lz + ez
      const exitF = ez - lz
      const m = Math.min(exitL, exitR, exitN, exitF)
      if (m <= hit.depth) continue
      hit.depth = m
      hit.solid = b
      const px = m === exitL ? m : m === exitR ? -m : 0
      const pz = m === exitN ? m : m === exitF ? -m : 0
      hit.push.set(px * c + pz * s, 0, -px * s + pz * c)
      hit.at.set(dx, 0, dz)
      continue
    }

    for (const [fx, fz] of PROBE) {
      const lx = fx * halfX
      const lz = fz * halfZ
      // yaw 0 faces -z, so this is the standard y-rotation
      const wx = centre.x + lx * c + lz * s
      const wz = centre.z - lx * s + lz * c
      if (wx <= b.min.x || wx >= b.max.x || wz <= b.min.z || wz >= b.max.z) continue
      const exitL = wx - b.min.x
      const exitR = b.max.x - wx
      const exitN = wz - b.min.z
      const exitF = b.max.z - wz
      const m = Math.min(exitL, exitR, exitN, exitF)
      if (m <= hit.depth) continue
      hit.depth = m
      hit.solid = b
      if (m === exitL) hit.push.set(-m, 0, 0)
      else if (m === exitR) hit.push.set(m, 0, 0)
      else if (m === exitN) hit.push.set(0, 0, -m)
      else hit.push.set(0, 0, m)
      hit.at.set(wx - centre.x, 0, wz - centre.z)
    }
  }
  return hit
}

/**
 * Is there room for a body of this footprint here? Used to stand a driver
 * down somewhere they will not be inside a wall, and to check a landing spot.
 */
export const clearAt = (
  x: number,
  z: number,
  radius: number,
  bottom: number,
  top: number,
  set: CollisionSet,
  skip?: Solid,
) => {
  for (const b of set.boxes) {
    if (b === skip) continue
    if (b.max.y <= bottom || b.min.y >= top) continue
    if (
      x > b.min.x - radius && x < b.max.x + radius &&
      z > b.min.z - radius && z < b.max.z + radius
    )
      return false
  }
  return true
}

/* -------------------------------------------------------------- surfaces -- */

export interface SurfaceFeel {
  /** lateral tyre grip multiplier: 1 is dry asphalt */
  grip: number
  /** rolling resistance, units/s² at speed */
  drag: number
  /** how much the wheels throw up, 0 none .. 1 a rooster tail */
  spray: number
  /** and what colour it is */
  dust: number
}

export const SURFACE_FEEL: Record<StepSurface, SurfaceFeel> = {
  asphalt: { grip: 1, drag: 1.4, spray: 0, dust: 0xb9b4ab },
  stone: { grip: 0.94, drag: 1.8, spray: 0.1, dust: 0xc2bcb2 },
  wood: { grip: 0.9, drag: 2.0, spray: 0, dust: 0xa78a63 },
  carpet: { grip: 0.85, drag: 4.5, spray: 0, dust: 0x6d5f52 },
  grass: { grip: 0.66, drag: 4.6, spray: 0.5, dust: 0x6e7a45 },
  sand: { grip: 0.5, drag: 8.5, spray: 0.9, dust: 0xd9c79a },
  snow: { grip: 0.34, drag: 6.5, spray: 0.85, dust: 0xe8eef2 },
  water: { grip: 0.28, drag: 12, spray: 1, dust: 0xa9c4cc },
}

/* ------------------------------------------------------------------ math -- */

/** frame-rate independent easing toward a target: the exponential the whole
    codebase uses, wrapped so the vehicles read the same as the walk */
export const damp = (cur: number, want: number, rate: number, dt: number) =>
  cur + (want - cur) * (1 - Math.exp(-rate * dt))

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** shortest signed angle from a to b, in (-pi, pi] */
export const angleDelta = (a: number, b: number) => {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

/* ------------------------------------------------------------ net driving -- */

/**
 * The motion implied by a network pose, in the machine's own frame.
 *
 * All three vehicles animate the same handful of cosmetics off it — wheels
 * roll at the forward speed, a hull throws its wake at the planar one, a
 * steering wheel and a rotor disc lean on the yaw rate — and none of them
 * should be deriving it themselves. `yawRate` is measured against the yaw the
 * machine had *last* frame rather than sent, for the same reason velocity is:
 * what is animated then matches what is drawn, exactly.
 */
export interface NetMotion {
  /** speed along the heading, signed. Reverse is genuinely negative here:
      the wire carries the transform, and backing up is a direction */
  f: number
  /** speed regardless of direction */
  planar: number
  /** radians per second, from the yaw delta this frame */
  yawRate: number
}

export const netMotion = (
  p: { vx: number; vz: number; yaw: number },
  prevYaw: number,
  dt: number,
  out: NetMotion,
): NetMotion => {
  const fx = -Math.sin(p.yaw)
  const fz = -Math.cos(p.yaw)
  out.f = p.vx * fx + p.vz * fz
  out.planar = Math.hypot(p.vx, p.vz)
  out.yawRate = dt > 0 ? angleDelta(prevYaw, p.yaw) / dt : 0
  return out
}

/** the standard four-key axis pair, honouring both wasd and the arrows —
    read exactly as walkController reads them so the two never disagree */
export const axes = (keys: ReadonlySet<string>, frozen: boolean) => ({
  fwd: frozen
    ? 0
    : (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
      (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0),
  side: frozen
    ? 0
    : (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
      (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0),
  up: frozen ? 0 : keys.has('Space') ? 1 : 0,
  down: frozen
    ? 0
    : keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC')
      ? 1
      : 0,
  boost: frozen ? 0 : keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0,
})
