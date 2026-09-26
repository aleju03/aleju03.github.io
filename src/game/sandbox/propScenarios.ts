import { CATALOGUE } from './catalogue'
import { KINDS, shapeExtents } from './kinds'
import { chunkX, chunkZ, inReserved } from '../world/grid'
import { placeAt, roadAt } from '../world/settlements'
import { slopeAt, terrainY } from '../world/terrain'
import * as THREE from 'three'
import { clearOf, defineScenario, siteFlat, solidsIn, type ScenarioCtx } from './scenarios'
import type { PropId } from './props'

/*
  The catalogue's scenarios: what the props look like, and what they do when
  things go wrong for them. Registered for the film harness (scripts/probe/
  film.ts lists this module in SCENARIO_MODULES) and for `measure physics`.

    sandbox:catalogue  every prop in the catalogue rained onto a suburban
                       street, small things nearest the lens
    sandbox:chain      a row of red barrels through stacks of crates, the
                       first one set off: a chain reaction, with two people
                       standing too close
    sandbox:smash      crates, melons, bottles, a pallet and a chair thrown
                       across a street into a shopfront, coming apart
    sandbox:crowd      three hundred props on one street, for the cost of
                       drawing them (the film prints draw calls and ms)
    sandbox:showroom   an empty lot, which the turntable stands models on

  The sites are pure searches of the world's fields, like scenarios.ts's, so
  every run lands in the same place: a suburban street with both verges
  clear (`siteAvenue`), and a street with a building front across it
  (`siteWall`), found by asking the chunk's own solids where a wall is.
*/

/* -------------------------------------------------------------- sites -- */

const spiral = (ok: (x: number, z: number) => boolean, from: [number, number], step: number) => {
  for (let r = 0; r < 260; r++) {
    const n = Math.max(1, r * 6)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = from[0] + Math.cos(a) * r * step
      const z = from[1] + Math.sin(a) * r * step
      if (ok(x, z)) return true
    }
  }
  return false
}

/** any solid whose footprint reaches within `r` of (x, z) */
export const solidNear = (x: number, z: number, r: number) => {
  for (let cz = chunkZ(z - r); cz <= chunkZ(z + r); cz++)
    for (let cx = chunkX(x - r); cx <= chunkX(x + r); cx++)
      for (const b of solidsIn(cx, cz)) {
        const dx = Math.max(b.min.x - x, 0, x - b.max.x)
        const dz = Math.max(b.min.z - z, 0, z - b.max.z)
        if (dx * dx + dz * dz < r * r) return true
      }
  return false
}

/** is a rectangle laid along (dx, dz) empty of anything bigger than a post?
    Lamp posts line every town kerb; placement steps round those */
export const clearOfBig = (x: number, z: number, dx: number, dz: number, a0: number, a1: number, half: number) => {
  const seen = new Set<unknown>()
  for (let a = a0; a <= a1 + 8; a += 8) {
    const px = x + dx * a
    const pz = z + dz * a
    for (let cz = chunkZ(pz - half); cz <= chunkZ(pz + half); cz++)
      for (let cx = chunkX(px - half); cx <= chunkX(px + half); cx++)
        for (const b of solidsIn(cx, cz)) {
          if (seen.has(b)) continue
          seen.add(b)
          if (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) < 1.5) continue
          // the layout frame is cardinal, so the box's extent along and
          // across it is exact: the projections of its two corners
          const u0 = (b.min.x - x) * dx + (b.min.z - z) * dz
          const u1 = (b.max.x - x) * dx + (b.max.z - z) * dz
          const v0 = -(b.min.x - x) * dz + (b.min.z - z) * dx
          const v1 = -(b.max.x - x) * dz + (b.max.z - z) * dx
          if (Math.max(u0, u1) < a0 || Math.min(u0, u1) > a1) continue
          if (Math.max(v0, v1) < -half || Math.min(v0, v1) > half) continue
          return false
        }
  }
  return true
}

/** a straight, level stretch of town street, snapped to its centreline and
    laid out along it, with nothing bigger than a lamp post within `half`
    either side: downtown's wide pavements, where a whole catalogue fits */
export const siteAvenue = () => {
  let best = { x: 0, z: -340, dx: 1, dz: 0, memo: { half: 7 } as Record<string, number> }
  const search = (half: number) => spiral((x, z) => {
    if (inReserved(x, z, 40)) return false
    const place = placeAt(x, z)
    if (place.district !== 'downtown' && place.district !== 'midrise') return false
    const r = roadAt(x, z, place)
    if (!r.asphalt || r.junction || r.dist > 1) return false
    const [cx, cz] = r.axis === 'x' ? [x, r.line] : [r.line, z]
    const [dx, dz] = r.axis === 'x' ? [1, 0] : [0, 1]
    for (let a = -16; a <= 48; a += 6) {
      const px = cx + dx * a
      const pz = cz + dz * a
      if (slopeAt(px, pz) > 0.05) return false
      if (!roadAt(px, pz, placeAt(px, pz)).asphalt) return false
    }
    if (!clearOfBig(cx, cz, dx, dz, -16, 48, half)) return false
    best = { x: cx, z: cz, dx, dz, memo: { half } }
    return true
  }, [0, -340], 16)
  // the town's streets are canyons about twenty units wall to wall
  if (!search(9)) search(7)
  return best
}

/** a street with a building front across it: the site is on the near kerb,
    laid out toward the wall, `memo.wall` units away */
export const siteWall = () => {
  let best = { x: 0, z: -340, dx: 1, dz: 0, memo: { wall: 12 } as Record<string, number> }
  const inside = (x: number, y: number, z: number) => {
    for (const b of solidsIn(chunkX(x), chunkZ(z))) {
      if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z && y > b.min.y && y < b.max.y) return b
    }
    return null
  }
  spiral((x, z) => {
    if (inReserved(x, z, 40)) return false
    const place = placeAt(x, z)
    if (place.district !== 'midrise' && place.district !== 'downtown') return false
    const r = roadAt(x, z, place)
    if (!r.asphalt || r.junction || r.dist > 1 || slopeAt(x, z) > 0.04) return false
    const [cx, cz] = r.axis === 'x' ? [x, r.line] : [r.line, z]
    const [ax, az] = r.axis === 'x' ? [1, 0] : [0, 1]
    for (const s of [1, -1]) {
      // across the street, toward one side
      const nx = -az * s
      const nz = ax * s
      const sx = cx - nx * 3
      const sz = cz - nz * 3
      const gy = terrainY(sx, sz)
      let d = -1
      for (let k = 2; k <= 22; k += 0.5) {
        const b = inside(sx + nx * k, gy + 3, sz + nz * k)
        if (b) {
          // a facade, not a lamp post: tall, and wide along the street
          if (b.max.y - gy < 7) return false
          d = k
          break
        }
      }
      if (d < 7 || d > 16) continue
      // the face must run on for a way either side, flat
      let flat = true
      for (const o of [-5, -2.5, 2.5, 5]) {
        const px = sx + nx * (d + 0.3) + ax * o
        const pz = sz + nz * (d + 0.3) + az * o
        if (!inside(px, gy + 3, pz)) flat = false
        if (inside(px - nx * 0.8, gy + 3, pz - nz * 0.8)) flat = false
      }
      if (!flat) continue
      // the throw's lane and the lens's line along the street are open
      if (!clearOf(sx, sz, nx, nz, -3, d - 0.6, -4, 4)) continue
      best = { x: sx, z: sz, dx: nx, dz: nz, memo: { wall: d } }
      return true
    }
    return false
  }, [0, -340], 12)
  return best
}

/* ----------------------------------------------------------- helpers -- */

/** a turn about y by `yaw` */
const yawQ = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
/** the yaw that faces a prop's local +z (its front) along (fx, fz) */
const facing = (fx: number, fz: number) => Math.atan2(fx, fz)

let seed = 1
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

/** the layout frame: a along the site's direction, b to its left */
const at = (c: ScenarioCtx, a: number, b: number) => ({
  x: c.x + c.dx * a - c.dz * b,
  z: c.z + c.dz * a + c.dx * b,
})

/* --------------------------------------------------------- catalogue -- */

defineScenario({
  id: 'sandbox:catalogue',
  title: 'every prop in the catalogue, dropped onto a town street',
  site: siteAvenue,
  duration: 3,
  frames: 4,
  tod: 0.4,
  camera: (c) => {
    const f = at(c, -7.5, -2.5)
    const t = at(c, 9, 0.2)
    return { from: [f.x, c.y + 6, f.z], to: [t.x, c.y + 0.4, t.z], fov: 64 }
  },
  setup: (c) => {
    seed = 3
    // rows across the street, smallest nearest the lens, and the shipping
    // container laid across the far end as the backdrop
    const size = (id: string) => {
      const e = shapeExtents(KINDS[id].shape)
      return Math.max(e.x, e.y, e.z) + e.x * e.z * 0.05
    }
    const ids = CATALOGUE.map((e) => e.id).filter((id) => id !== 'container').sort((p, q) => size(p) - size(q))
    const front = facing(-c.dx, -c.dz)
    const PER_ROW = [6, 6, 5, 5, 5, 4, 4, 3]
    const HALF = c.memo.half - 1
    let a = 0
    let i = 0
    let row = 0
    while (i < ids.length) {
      const take = ids.slice(i, i + (PER_ROW[row] ?? 4))
      i += take.length
      let depth = 0
      let width = 0
      for (const id of take) {
        const e = shapeExtents(KINDS[id].shape)
        depth = Math.max(depth, e.z)
        width += 2 * e.x
      }
      a += depth + 0.2
      // spread the row evenly across the street, gaps shared out
      const gap = Math.max(0.3, (2 * HALF - width) / Math.max(1, take.length - 1))
      let b = -HALF
      for (const id of take) {
        const e = shapeExtents(KINDS[id].shape)
        b += e.x
        // step off a lamp post rather than dropping onto it
        let bb = b
        let aa = a
        for (const [oa, ob] of [[0, 0], [0.9, 0], [-0.9, 0], [0, 0.6], [0, -0.6], [1.8, 0]]) {
          const q = at(c, a + oa, b + ob)
          if (!solidNear(q.x, q.z, Math.max(e.x, e.z) * 0.8 + 0.25)) {
            aa = a + oa
            bb = b + ob
            break
          }
        }
        const p = at(c, aa, -bb)
        // low enough that a bottle survives the landing
        const y = c.sb.restY(id, p.x, p.z) + 0.2 + rnd() * 0.5 + (KINDS[id].breaks ? 0 : rnd() * 1.2)
        c.ids.push(c.sb.spawn(id, { x: p.x, y, z: p.z }, {
          quaternion: yawQ(front + (rnd() - 0.5) * 0.45),
          angular: { x: (rnd() - 0.5) * 0.6, y: (rnd() - 0.5) * 0.6, z: (rnd() - 0.5) * 0.6 },
        }))
        b += e.x + gap
      }
      a += depth + 1.5
      row++
    }
    const e = shapeExtents(KINDS.container.shape)
    a += e.z + 0.8
    const p = at(c, a, 0)
    c.ids.push(c.sb.spawn('container', { x: p.x, y: c.sb.restY('container', p.x, p.z) + 0.3, z: p.z }, {
      quaternion: yawQ(front),
    }))
    c.memo.length = a + e.z
  },
  report: (c) => {
    let asleep = 0
    let alive = 0
    for (const id of c.ids) {
      const p = c.sb.get(id)
      if (!p) continue
      alive++
      if (p.body.isSleeping()) asleep++
    }
    const s = c.sb.stats
    return `${alive}/${c.ids.length} props whole (${c.ids.length - alive} broke landing), ${asleep} asleep, ` +
      `${c.memo.length.toFixed(0)} units of street, ${s.batches} batches for ${s.instances} instances`
  },
})

/* ------------------------------------------------------------- chain -- */

defineScenario({
  id: 'sandbox:chain',
  title: 'red barrels chain-detonating through stacks of crates',
  site: siteAvenue,
  duration: 3.4,
  frames: 12,
  tod: 0.4,
  camera: (c) => {
    const f = at(c, -15, 7)
    const t = at(c, 13, -1)
    return { from: [f.x, c.y + 12, f.z], to: [t.x, c.y + 1.5, t.z], fov: 50 }
  },
  bodies: (c) => [
    { ...at(c, 12, 5.5), yaw: facing(c.dz, -c.dx) },
    { ...at(c, 22, -5), yaw: facing(-c.dz, c.dx) },
    { ...at(c, 3, -5.5), yaw: facing(c.dx, c.dz) },
  ],
  setup: (c) => {
    seed = 17
    const put = (kind: string, a: number, b: number, lift = 0, yaw = 0) => {
      const p = at(c, a, b)
      const y = c.sb.restY(kind, p.x, p.z) + lift
      const id = c.sb.spawn(kind, { x: p.x, y, z: p.z }, { quaternion: yawQ(facing(c.dx, c.dz) + yaw) })
      c.ids.push(id)
      return id
    }
    const crate = 2.4
    // six barrels zigzagging down the street, close enough that each is in
    // the next one's killing radius
    const barrels: PropId[] = []
    for (let k = 0; k < 6; k++) barrels.push(put('barrel_explosive', k * 5.2, k % 2 ? 1.8 : -1.8, 0, rnd()))
    c.memo.first = barrels[0]
    // between them, crates stacked two high and a pyramid, a pallet with
    // melons on it, a gas can and a propane tank to finish
    for (let k = 0; k < 5; k++) {
      const a = k * 5.2 + 2.6
      const b = k % 2 ? -2.4 : 2.4
      put('crate', a, b - 1.25, 0.01, (rnd() - 0.5) * 0.2)
      put('crate', a, b + 1.25, 0.01, (rnd() - 0.5) * 0.2)
      put('crate', a, b, crate + 0.02, (rnd() - 0.5) * 0.3)
    }
    put('pallet', 9, -5.2)
    for (const o of [-0.7, 0.7]) put('melon', 9 + o, -5.2, 0.4, rnd())
    put('crate_small', 14, 5, 0)
    put('gascan', 16, 3.2)
    put('propane', 28, 0.5)
    put('cone', 6, 5.5)
    put('cone', 20, 5.5)
    put('trashcan', 24, -6)
  },
  events: [
    [0.4, (c) => c.sb.damage(c.memo.first, 1000)],
  ],
  report: (c) => {
    let barrels = 0
    let crates = 0
    let left = 0
    for (const id of c.ids) {
      const p = c.sb.get(id)
      if (p) {
        left++
        if (p.kind.id === 'barrel_explosive') barrels++
        if (p.kind.id === 'crate') crates++
      }
    }
    const s = c.sb.stats
    return `${6 - barrels}/6 barrels went off, ${15 - crates}/15 crates broke, ${left} of ${c.ids.length} props left, ` +
      `${s.gibs} gibs and ${s.particles} particles live at the end`
  },
})

/* ------------------------------------------------------------- smash -- */

/** the things thrown, in order, a third of a second apart */
const THROWN = [
  'crate', 'melon', 'bottle', 'crate_small', 'melon', 'pallet', 'melon', 'chair',
  'bottle', 'crate', 'melon', 'bottle', 'crate_small', 'melon', 'crate',
]

defineScenario({
  id: 'sandbox:smash',
  title: 'crates, melons and bottles thrown into a shopfront',
  site: siteWall,
  duration: 6.5,
  frames: 12,
  tod: 0.42,
  camera: (c) => {
    const W = c.memo.wall
    // along the street, a little back from the throw, the wall on the right
    const f = at(c, W * 0.18, 13)
    const t = at(c, W * 0.72, -0.5)
    return { from: [f.x, c.y + 5.5, f.z], to: [t.x, c.y + 2.6, t.z], fov: 58 }
  },
  setup: (c) => {
    seed = 29
    c.memo.thrown = 0
  },
  events: THROWN.map((kind, i): [number, (c: ScenarioCtx) => void] => [0.25 + i * 0.36, (c) => {
    const W = c.memo.wall
    const b0 = (rnd() - 0.5) * 3
    const s = at(c, 0.5, b0)
    const sy = c.y + 2.2 + rnd() * 1.2
    const t = at(c, W, b0 * 0.6 + (rnd() - 0.5) * 3)
    const ty = c.y + 1.8 + rnd() * 3
    const d = Math.hypot(t.x - s.x, t.z - s.z)
    const speed = 38 + rnd() * 10
    const T = d / speed
    const g = -c.sb.gravity
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6))
    c.ids.push(c.sb.spawn(kind, { x: s.x, y: sy, z: s.z }, {
      quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
      velocity: { x: (t.x - s.x) / T, y: (ty - sy) / T + 0.5 * g * T, z: (t.z - s.z) / T },
      angular: { x: (rnd() - 0.5) * 10, y: (rnd() - 0.5) * 10, z: (rnd() - 0.5) * 10 },
    }))
    c.memo.thrown++
  }]),
  report: (c) => {
    let whole = 0
    for (const id of c.ids) if (c.sb.get(id)) whole++
    return `${c.memo.thrown - whole}/${c.memo.thrown} broke on the wall (${c.memo.wall.toFixed(1)} units off), ${c.sb.stats.gibs} gibs lying about`
  },
})

/* ------------------------------------------------------------- crowd -- */

const CROWD_MIX = [
  'crate', 'barrel', 'crate_small', 'cone', 'tyre', 'melon', 'bucket', 'milk_crate', 'cinder', 'trashcan',
  'pallet', 'chair', 'soda_can', 'bottle', 'ball', 'gascan', 'wheelie_bin', 'lawn_chair', 'plank', 'sawhorse',
]

defineScenario({
  id: 'sandbox:crowd',
  title: 'three hundred props on one street',
  site: siteAvenue,
  duration: 5,
  frames: 4,
  tod: 0.4,
  camera: (c) => {
    const f = at(c, -10, 5)
    const t = at(c, 16, 0)
    return { from: [f.x, c.y + 13, f.z], to: [t.x, c.y, t.z], fov: 60 }
  },
  setup: (c) => {
    seed = 41
    for (let i = 0; i < 300; i++) {
      const kind = CROWD_MIX[i % CROWD_MIX.length]
      const p = at(c, rnd() * 40, (rnd() - 0.5) * 18)
      c.ids.push(c.sb.spawn(kind, { x: p.x, y: c.y + 3 + (i % 25) * 1.4, z: p.z }, {
        quaternion: yawQ(rnd() * 6.28),
        angular: { x: rnd() - 0.5, y: rnd() - 0.5, z: rnd() - 0.5 },
      }))
    }
  },
  report: (c) => {
    let n = 0
    for (const id of c.ids) if (c.sb.get(id)) n++
    const s = c.sb.stats
    return `${n}/300 props, ${s.awake} awake, ${s.batches} instanced batches drawing ${s.instances} instances`
  },
})

/* ---------------------------------------------------------- showroom -- */

defineScenario({
  id: 'sandbox:showroom',
  title: 'an empty lot (the turntable stands models here)',
  site: siteFlat,
  duration: 0.5,
  frames: 1,
  tod: 0.4,
  camera: (c) => ({ from: [c.x - 8, c.y + 4, c.z + 8], to: [c.x, c.y + 1, c.z], fov: 40 }),
  setup: () => {},
})
