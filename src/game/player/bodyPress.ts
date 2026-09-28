import * as THREE from 'three'
import type { BodyCloud } from './playerBody'

/*
  Bodies pressing on bodies: the town's people against each other.

  `bodyContact.ts` settles the *walker* against everyone, and the ragdoll
  settles each heap against the world's boxes, but nothing ever looked at two
  of the crowd at once. So two pedestrians walked through each other on a
  narrow pavement, a body held on the physgun could be pushed straight into a
  bystander until one bean stood inside the other, and a body thrown down the
  street sailed through the people it met. This is the pass that sees them in
  pairs, once a frame, after every body has moved.

  A body is one of two shapes, whichever it is being right now:

  - **Standing** is an upright cylinder (the same one the walker bumps,
    measured off the rig by `bodyExtent`), moved as a whole by its owner,
    who may refuse (a wall behind it).
  - **A heap** is the ragdoll's own particles, the thirteen limbs and the
    belly and the pack, as spheres. A heap is pushed *particle by particle*,
    and the ragdoll's constraints carry the rest of it along over the next
    substeps, so a heap shoved at the shoulder turns rather than sliding as
    a block.

  Each pair is pushed apart by mass, and the one thing that decides the split
  is whether a heap is **held**. A limb on a grab beam is a hand, not a
  weight: the beam does not give, so a held body takes none of a contact and
  whatever it is pushed into takes all of it, which is what makes it a thing
  you can shove people with instead of one that folds round them. Everything
  else splits evenly, falling back to the other body when one cannot move.
  Speed matters as well as overlap: the closing speed along the contact is
  shared out as a velocity (a stagger for someone standing, a kick for a
  particle), and past KNOCK_V a heap arriving at somebody standing knocks
  them flat the way a car does, so a swung or thrown body bowls people over.
  Two people walking into each other each veer off, which is what stops a
  pavement turning into a shoving match between two walks that cannot see.

  The ragdoll rule from src/game/CLAUDE.md holds here too: a particle moved
  apart from another body is *displaced* (`BodyCloud.move` takes its previous
  position along), and any change of speed is an explicit kick of bounded
  size. This runs once a frame, outside the 1/120 s substeps, so a bare
  position correction of a quarter unit would be read back by the verlet as
  thirty units a second of launch.

  Cost: the crowd is five to nine bodies, so every pair is tried behind a
  bounds check, and the particle-by-particle work (at most 15 x 15 spheres)
  only runs for two heaps actually lying against each other. Headless: plain
  numbers and a few scratch vectors, nothing allocated per frame.
*/

export type PressKind = 'none' | 'stand' | 'heap'

/** one body, as this frame's pass sees it; filled by the host */
export interface PressBody {
  kind: PressKind
  /** standing: soles, planar centre, cylinder, planar velocity (units/s) */
  x: number
  z: number
  feetY: number
  radius: number
  height: number
  vx: number
  vz: number
  /** a heap: its particles (null while standing) */
  cloud: BodyCloud | null
  /** a heap with a limb on a beam or a pin: it takes none of a contact */
  held: boolean
}

/** what owns the bodies: it answers where they are and moves its own */
export interface PressHost {
  readonly size: number
  /** fill `out` with body i, or false when it is not there to meet */
  body: (i: number, out: PressBody) => boolean
  /** move standing body i as a whole; false when it cannot go there */
  shove: (i: number, dx: number, dz: number) => boolean
  /** standing body i is carried at least this fast this way (units/s) */
  stagger: (i: number, vx: number, vz: number) => void
  /** standing body i is knocked flat, thrown at this velocity (units/s)
      from this point */
  knock: (i: number, vx: number, vy: number, vz: number, px: number, py: number, pz: number) => void
  /** standing body i is walking into somebody along (nx, nz): step round */
  veer: (i: number, nx: number, nz: number) => void
}

export interface BodyPress {
  /** one frame's contacts between the host's bodies; returns how many */
  step: (host: PressHost) => number
}

/* ------------------------------------------------------------- tuning -- */

/** the particles' spheres are the bones', and the bean's skin sits a little
    outside them: padded, two heaps meet at about where they are drawn */
const PAD = 1.1
/** passes over every pair: the second settles what the first pushed into a
    third body. Speed is shared out on the first only */
const ITER = 2
/** a heap arriving at somebody standing faster than this knocks them down.
    A little under the walker's CHARGE: a swung body is a club */
const KNOCK_V = 6
/** ...and throws them this share of the closing speed, and up */
const THROW_K = 0.6
const THROW_UP = 2.2
const THROW_UP_K = 0.15
/** below the knock, somebody leaned on by a heap is carried off at this
    share of the closing speed, capped; a loose heap pushes half as hard as
    a held one. Under STAGGER_MIN it is only the overlap */
const STAGGER_K = 0.7
const STAGGER_MAX = 4
const STAGGER_MIN = 0.8
/** walking into somebody at more than this veers off them */
const VEER_V = 0.5
/** the most particles a heap brings */
const MAX_PARTS = 16

interface Rec {
  b: PressBody
  live: boolean
  /** planar centre and radius of a disc round everything, and the y span */
  cx: number
  cz: number
  reach: number
  lo: number
  hi: number
  /** a heap's particles as (x, y, z, padded radius), kept up to date as the
      pass moves them */
  n: number
  pts: Float32Array
  /** knocked down during this pass: no longer a cylinder */
  knocked: boolean
}

const blank = (): PressBody => ({
  kind: 'none', x: 0, z: 0, feetY: 0, radius: 0, height: 0, vx: 0, vz: 0, cloud: null, held: false,
})

export function createBodyPress(): BodyPress {
  const recs: Rec[] = []
  const v = new THREE.Vector3()
  const w = new THREE.Vector3()
  const d = new THREE.Vector3()

  const gather = (host: PressHost) => {
    while (recs.length < host.size) {
      recs.push({
        b: blank(), live: false, cx: 0, cz: 0, reach: 0, lo: 0, hi: 0,
        n: 0, pts: new Float32Array(MAX_PARTS * 4), knocked: false,
      })
    }
    for (let i = 0; i < host.size; i++) {
      const r = recs[i]
      r.knocked = false
      r.live = host.body(i, r.b) && r.b.kind !== 'none'
      if (!r.live) continue
      const b = r.b
      if (b.kind === 'stand') {
        r.cx = b.x
        r.cz = b.z
        r.reach = b.radius
        r.lo = b.feetY
        r.hi = b.feetY + b.height
        r.n = 0
        continue
      }
      const c = b.cloud
      if (!c) {
        r.live = false
        continue
      }
      r.n = Math.min(MAX_PARTS, c.count)
      bound(r, c)
    }
  }

  /** re-read a heap's particles and the bounds round them */
  const bound = (r: Rec, c: BodyCloud) => {
    let sx = 0
    let sz = 0
    r.lo = Infinity
    r.hi = -Infinity
    for (let k = 0; k < r.n; k++) {
      c.pos(k, v)
      const rad = c.radius(k) * PAD
      r.pts[k * 4] = v.x
      r.pts[k * 4 + 1] = v.y
      r.pts[k * 4 + 2] = v.z
      r.pts[k * 4 + 3] = rad
      sx += v.x
      sz += v.z
      if (v.y - rad < r.lo) r.lo = v.y - rad
      if (v.y + rad > r.hi) r.hi = v.y + rad
    }
    r.cx = sx / r.n
    r.cz = sz / r.n
    let reach = 0
    for (let k = 0; k < r.n; k++) {
      const e = Math.hypot(r.pts[k * 4] - r.cx, r.pts[k * 4 + 2] - r.cz) + r.pts[k * 4 + 3]
      if (e > reach) reach = e
    }
    r.reach = reach
  }

  /** a standing body moved by the host: keep the record with it */
  const shoved = (host: PressHost, i: number, dx: number, dz: number) => {
    if (!host.shove(i, dx, dz)) return false
    const r = recs[i]
    r.b.x += dx
    r.b.z += dz
    r.cx = r.b.x
    r.cz = r.b.z
    return true
  }

  /** move particle k of heap r, record and all */
  const shift = (r: Rec, k: number, dx: number, dy: number, dz: number) => {
    r.b.cloud!.move(k, d.set(dx, dy, dz))
    r.pts[k * 4] += dx
    r.pts[k * 4 + 1] += dy
    r.pts[k * 4 + 2] += dz
  }

  /* ---- two people standing ---------------------------------------------- */
  const standStand = (host: PressHost, ia: number, ib: number, first: boolean) => {
    const A = recs[ia].b
    const B = recs[ib].b
    let dx = B.x - A.x
    let dz = B.z - A.z
    let dist = Math.hypot(dx, dz)
    const depth = A.radius + B.radius - dist
    if (depth <= 0) return false
    if (dist < 1e-4) {
      dx = 1
      dz = 0
      dist = 1
    }
    const nx = dx / dist
    const nz = dz / dist
    if (first) {
      if (A.vx * nx + A.vz * nz > VEER_V) host.veer(ia, nx, nz)
      if (-(B.vx * nx + B.vz * nz) > VEER_V) host.veer(ib, -nx, -nz)
    }
    const half = depth * 0.5
    const a = shoved(host, ia, -nx * half, -nz * half)
    const b = shoved(host, ib, nx * half, nz * half)
    // one against a wall: the other takes the lot
    if (a && !b) shoved(host, ia, -nx * half, -nz * half)
    else if (b && !a) shoved(host, ib, nx * half, nz * half)
    return true
  }

  /* ---- a heap against somebody standing --------------------------------- */
  const standHeap = (host: PressHost, is: number, ih: number, first: boolean) => {
    const S = recs[is]
    const H = recs[ih]
    const s = S.b
    const c = H.b.cloud!
    const held = H.b.held
    // a held heap is the beam's: the one standing takes all of it
    const share = held ? 1 : 0.5
    let hit = false
    for (let k = 0; k < H.n; k++) {
      const px = H.pts[k * 4]
      const py = H.pts[k * 4 + 1]
      const pz = H.pts[k * 4 + 2]
      const r = H.pts[k * 4 + 3]
      if (py + r < s.feetY || py - r > s.feetY + s.height) continue
      let dx = s.x - px
      let dz = s.z - pz
      let dist = Math.hypot(dx, dz)
      const depth = s.radius + r - dist
      if (depth <= 0) continue
      hit = true
      c.velocity(k, v)
      if (dist < 1e-4) {
        const sp = Math.hypot(v.x, v.z)
        dx = sp > 1e-3 ? v.x / sp : 1
        dz = sp > 1e-3 ? v.z / sp : 0
        dist = 1
      }
      // from the particle to the one standing
      const nx = dx / dist
      const nz = dz / dist
      const vn = (v.x - s.vx) * nx + (v.z - s.vz) * nz
      if (first && vn > KNOCK_V) {
        host.knock(
          is, nx * vn * THROW_K, THROW_UP + vn * THROW_UP_K, nz * vn * THROW_K,
          s.x - nx * s.radius, py, s.z - nz * s.radius,
        )
        S.knocked = true
        // and the heap gives up half its speed into them
        if (!held) c.kick(k, w.set(-nx * vn * 0.5, 0, -nz * vn * 0.5))
        return true
      }
      const moved = shoved(host, is, nx * depth * share, nz * depth * share)
      const rest = moved ? depth * (1 - share) : depth
      if (rest > 0) shift(H, k, -nx * rest, 0, -nz * rest)
      if (first && vn > STAGGER_MIN) {
        const st = Math.min(STAGGER_MAX, vn * STAGGER_K * (held ? 1 : 0.6))
        host.stagger(is, nx * st, nz * st)
        if (!held) c.kick(k, w.set(-nx * vn * 0.5, 0, -nz * vn * 0.5))
      }
    }
    return hit
  }

  /* ---- two heaps --------------------------------------------------------- */
  const heapHeap = (A: Rec, B: Rec, first: boolean) => {
    const ca = A.b.cloud!
    const cb = B.b.cloud!
    let wa = A.b.held ? 0 : 1
    let wb = B.b.held ? 0 : 1
    if (wa + wb === 0) wa = wb = 1
    const sum = wa + wb
    let hit = false
    for (let k = 0; k < A.n; k++) {
      for (let l = 0; l < B.n; l++) {
        const ax = A.pts[k * 4]
        const ay = A.pts[k * 4 + 1]
        const az = A.pts[k * 4 + 2]
        const reach = A.pts[k * 4 + 3] + B.pts[l * 4 + 3]
        let dx = B.pts[l * 4] - ax
        let dy = B.pts[l * 4 + 1] - ay
        let dz = B.pts[l * 4 + 2] - az
        if (Math.abs(dx) >= reach || Math.abs(dy) >= reach || Math.abs(dz) >= reach) continue
        let dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const depth = reach - dist
        if (depth <= 0) continue
        hit = true
        if (dist < 1e-4) {
          dx = 0
          dy = 1
          dz = 0
          dist = 1
        }
        const nx = dx / dist
        const ny = dy / dist
        const nz = dz / dist
        const ka = (depth * wa) / sum
        const kb = (depth * wb) / sum
        if (ka > 0) shift(A, k, -nx * ka, -ny * ka, -nz * ka)
        if (kb > 0) shift(B, l, nx * kb, ny * kb, nz * kb)
        if (!first) continue
        // the closing speed along the contact, shared by weight: both leave
        // at the same speed along it (a held one does not slow at all)
        ca.velocity(k, v)
        cb.velocity(l, w)
        const vn = (v.x - w.x) * nx + (v.y - w.y) * ny + (v.z - w.z) * nz
        if (vn <= 0) continue
        if (wa > 0) ca.kick(k, d.set(nx, ny, nz).multiplyScalar((-vn * wa) / sum))
        if (wb > 0) cb.kick(l, d.set(nx, ny, nz).multiplyScalar((vn * wb) / sum))
      }
    }
    return hit
  }

  return {
    step: (host) => {
      gather(host)
      const n = host.size
      let contacts = 0
      for (let it = 0; it < ITER; it++) {
        const first = it === 0
        let any = false
        for (let i = 0; i < n; i++) {
          const A = recs[i]
          if (!A.live || A.knocked) continue
          for (let j = i + 1; j < n; j++) {
            const B = recs[j]
            if (!B.live || B.knocked) continue
            if (A.lo >= B.hi || B.lo >= A.hi) continue
            const reach = A.reach + B.reach
            if (Math.abs(A.cx - B.cx) >= reach || Math.abs(A.cz - B.cz) >= reach) continue
            const sa = A.b.kind === 'stand'
            const sb = B.b.kind === 'stand'
            const hit = sa && sb
              ? standStand(host, i, j, first)
              : sa ? standHeap(host, i, j, first)
                : sb ? standHeap(host, j, i, first)
                  : heapHeap(A, B, first)
            if (!hit) continue
            any = true
            if (first) contacts++
            // a heap's bounds follow its particles for the next pair
            if (!sa) bound(A, A.b.cloud!)
            if (!sb) bound(B, B.b.cloud!)
            if (A.knocked) break
          }
        }
        if (!any) break
      }
      return contacts
    },
  }
}
