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
  title: 'every prop in the catalogue, set out down a town street',
  site: siteAvenue,
  duration: 5,
  frames: 8,
  tod: 0.4,
  camera: (c) => {
    const f = at(c, -9, 0)
    const t = at(c, c.memo.length * 0.45, 0)
    return { from: [f.x, c.y + 16, f.z], to: [t.x, c.y, t.z], fov: 58 }
  },
  // the first still is the whole lot from above; the rest walk down the
  // street over it at head height and a little more, so each row fills the
  // frame in turn: the can and the bottle are a can and a bottle, not two
  // pixels in a wall of colour
  lens: (c, t) => {
    if (t < 0.9) {
      const f = at(c, -9, 0)
      const q = at(c, c.memo.length * 0.45, 0)
      return { from: [f.x, c.y + 16, f.z], to: [q.x, c.y, q.z], fov: 58 }
    }
    const k = Math.min(1, (t - 0.9) / 3.9)
    const a = -5 + k * (c.memo.length - 22)
    const f = at(c, a, 0)
    const q = at(c, a + 9, 0)
    return { from: [f.x, c.y + 5.5, f.z], to: [q.x, c.y + 0.6, q.z], fov: 60 }
  },
  setup: (c) => {
    seed = 3
    // rows across the street, smallest nearest, each prop with a clear
    // margin all round (the first layout packed them edge to edge and it
    // read as one wall), and the container laid across the far end
    const size = (id: string) => {
      const e = shapeExtents(KINDS[id].shape)
      return Math.max(e.x, e.y, e.z) + e.x * e.z * 0.05
    }
    const ids = CATALOGUE.map((e) => e.id).filter((id) => id !== 'container').sort((p, q) => size(p) - size(q))
    const front = facing(-c.dx, -c.dz)
    const HALF = c.memo.half - 1
    const GAP = 2.2
    let a = 0
    let i = 0
    while (i < ids.length) {
      // as many as fit across with a gap each side
      const take: string[] = []
      let width = 0
      while (i < ids.length) {
        const e = shapeExtents(KINDS[ids[i]].shape)
        const w = 2 * Math.max(e.x, e.z) + GAP
        if (take.length && width + w > 2 * HALF + GAP) break
        take.push(ids[i++])
        width += w
      }
      let depth = 0
      for (const id of take) {
        const e = shapeExtents(KINDS[id].shape)
        depth = Math.max(depth, Math.max(e.x, e.z))
      }
      a += depth + 0.2
      const slot = (2 * HALF) / take.length
      take.forEach((id, k) => {
        const e = shapeExtents(KINDS[id].shape)
        const b = -HALF + slot * (k + 0.5)
        // step off a lamp post rather than dropping onto it
        let aa = a
        let bb = b
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
        const y = c.sb.restY(id, p.x, p.z) + 0.2 + rnd() * 0.4
        c.ids.push(c.sb.spawn(id, { x: p.x, y, z: p.z }, {
          quaternion: yawQ(front + 0.5 + (rnd() - 0.5) * 0.4),
        }))
      })
      a += depth + 3
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

/** how many pallets, cinder blocks, tyres and crates are resting on
    something rather than on the street: well off the ground and still */
const standing = (c: ScenarioCtx) => {
  let n = 0
  for (const id of c.ids) {
    const p = c.sb.get(id)
    if (!p || !['pallet', 'cinder', 'tyre', 'crate', 'block'].includes(p.kind.id)) continue
    const t = p.body.translation()
    const v = p.body.linvel()
    if (t.y - c.sb.groundY(t.x, t.z) > p.extents.y * 1.5 + 0.1 && Math.hypot(v.x, v.y, v.z) < 1) n++
  }
  return n
}

/** what the chain heard: each bang's moment and height over the street */
/** a crate's half-size, for setting one on a stack */
const DIMS_CRATE = shapeExtents(KINDS.crate.shape).y

const bangs = new WeakMap<ScenarioCtx, { t: number; list: Array<{ t: number; up: number }> }>()

defineScenario({
  id: 'sandbox:chain',
  title: 'red barrels chain-detonating through stacks of crates',
  site: siteAvenue,
  duration: 5,
  frames: 12,
  tod: 0.4,
  // high and three-quarters on from the barrels' side, so the row reads
  // in front of the crate stacks (README's film list has the eye-level shot)
  camera: (c) => {
    const f = at(c, -15, 9)
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
    const log = { t: 0, list: [] as Array<{ t: number; up: number }> }
    bangs.set(c, log)
    c.sb.onAfterSlice((h) => {
      log.t += h
    })
    c.sb.onExplosion((e) => log.list.push({ t: log.t, up: e.y - terrainY(e.x, e.z) }))
    const put = (kind: string, a: number, b: number, lift = 0, yaw = 0) => {
      const p = at(c, a, b)
      const y = c.sb.restY(kind, p.x, p.z) + lift
      const id = c.sb.spawn(kind, { x: p.x, y, z: p.z }, { quaternion: yawQ(facing(c.dx, c.dz) + yaw) })
      c.ids.push(id)
      return id
    }
    const crate = 2.4
    // six barrels down the near side of the street, close enough that each
    // is in the next one's killing radius, and nothing between them and the
    // lens: they are the stars, and behind a crate stack a barrel is seen
    // only once it has gone off. The crates stand in stacks along the far
    // side, where the blasts throw them across the street
    const barrels: PropId[] = []
    for (let k = 0; k < 6; k++) barrels.push(put('barrel_explosive', k * 5.2, 1.6 + (k % 2) * 0.8, 0, rnd()))
    c.memo.first = barrels[0]
    for (let k = 0; k < 5; k++) {
      const a = k * 5.2 + 2.6
      const b = -2.8
      put('crate', a - 1.25, b, 0.01, (rnd() - 0.5) * 0.2)
      put('crate', a + 1.25, b, 0.01, (rnd() - 0.5) * 0.2)
      put('crate', a, b, crate + 0.02, (rnd() - 0.5) * 0.3)
    }
    put('pallet', 9, -6.2)
    for (const o of [-0.7, 0.7]) put('melon', 9 + o, -6.2, 0.4, rnd())
    put('crate_small', 14, 5, 0)
    put('gascan', 16, 4.2)
    put('propane', 28, 0.5)
    put('cone', 6, 5.5)
    put('cone', 20, 5.5)
    put('trashcan', 24, -6)
    // and stacks far enough off the row to rock and stand, so the street
    // after the bangs is not all one flat heap: three pallets with a crate
    // on them across from the last barrel, and a staggered wall of cinder
    // blocks with a tyre stack beside it at the far end, for thrown things
    // to land on
    const stack = (kind: string, a: number, b: number, n: number, yaw = 0) => {
      const e = shapeExtents(KINDS[kind].shape)
      const p = at(c, a, b)
      let y = c.sb.restY(kind, p.x, p.z)
      for (let i = 0; i < n; i++) {
        c.ids.push(c.sb.spawn(kind, { x: p.x, y: y + 0.01, z: p.z }, { quaternion: yawQ(facing(c.dx, c.dz) + yaw) }))
        y += 2 * e.y + 0.02
      }
      return y
    }
    const top = stack('pallet', 24, -8.4, 3)
    { const p = at(c, 24, -8.4); c.ids.push(c.sb.spawn('crate', { x: p.x, y: top + DIMS_CRATE + 0.02, z: p.z }, { quaternion: yawQ(facing(c.dx, c.dz)) })) }
    // and in frame from both lenses, near the first barrel: concrete
    // blocks a blast barely rocks, two and one on top, with a crate on the
    // top one for a blast to knock about
    {
      const e = shapeExtents(KINDS.block.shape)
      const q = yawQ(facing(c.dx, c.dz))
      for (const o of [-1, 1]) {
        // side by side along their length, the top one across the seam
        const p = at(c, 3, -7.4 + o * (e.x + 0.03))
        c.ids.push(c.sb.spawn('block', { x: p.x, y: c.sb.restY('block', p.x, p.z) + 0.01, z: p.z }, { quaternion: q }))
      }
      const p = at(c, 3, -7.4)
      const y = c.sb.restY('block', p.x, p.z) + 2 * e.y + 0.03
      c.ids.push(c.sb.spawn('block', { x: p.x, y, z: p.z }, { quaternion: q }))
      c.ids.push(c.sb.spawn('crate', { x: p.x, y: y + e.y + DIMS_CRATE + 0.03, z: p.z }, { quaternion: q }))
    }
    for (let row = 0; row < 3; row++) for (let k = 0; k < 3 - row; k++) {
      const e = shapeExtents(KINDS.cinder.shape)
      const p = at(c, 46, -2 + (k - (2 - row) / 2) * (2 * e.x + 0.05))
      c.ids.push(c.sb.spawn('cinder', { x: p.x, y: c.sb.restY('cinder', p.x, p.z) + row * (2 * e.y + 0.01) + 0.01, z: p.z },
        { quaternion: yawQ(facing(-c.dz, c.dx)) }))
    }
    stack('tyre', 46, 2.5, 4)
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
    const heard = (bangs.get(c)?.list ?? []).map((b) => `${b.t.toFixed(2)}s@${b.up.toFixed(0)}u`).join(' ')
    // (the stacks' two crates are the sixteenth and seventeenth)
    return `${6 - barrels}/6 barrels went off, ${17 - crates}/17 crates broke, ${left} of ${c.ids.length} props left, ` +
      `${standing(c)} props resting on others, ` +
      `bangs ${heard}; ` +
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
    const lane = c.memo.lane ?? 0
    // along the street from whichever side has no lamp post in the sightline
    const t = at(c, W * 0.62, lane)
    let f = at(c, W * 0.2, lane - 14)
    let fewest = Infinity
    for (const side of [-1, 1]) {
      const q = at(c, W * 0.2, lane + side * 14)
      let n = 0
      for (let k = 0.05; k < 0.9; k += 0.05) {
        if (solidNear(q.x + (t.x - q.x) * k, q.z + (t.z - q.z) * k, 1.2)) n++
      }
      if (n < fewest) {
        fewest = n
        f = q
      }
    }
    return { from: [f.x, c.y + 5.5, f.z], to: [t.x, c.y + 2.2, t.z], fov: 54 }
  },
  setup: (c) => {
    seed = 29
    c.memo.thrown = 0
    // a lane across the street with no lamp post in it
    c.memo.lane = 0
    // (wide: a post a few units off the lane still stands in front of the
    // impacts from a lens looking along the street)
    for (const b of [0, 2, -2, 4, -4, 6, -6, 8, -8, 10, -10]) {
      let open = true
      for (let a = 1; a < c.memo.wall - 0.5 && open; a += 1) {
        for (const o of [-6, -4, -2, 0, 2, 4, 6]) {
          const q = at(c, a, b + o)
          if (solidNear(q.x, q.z, 0.9)) open = false
        }
      }
      if (open) {
        c.memo.lane = b
        break
      }
    }
  },
  events: THROWN.map((kind, i): [number, (c: ScenarioCtx) => void] => [0.25 + i * 0.36, (c) => {
    const W = c.memo.wall
    const b0 = c.memo.lane + (rnd() - 0.5) * 3
    const s = at(c, 0.5, b0)
    const sy = c.y + 2.2 + rnd() * 1.2
    const t = at(c, W, c.memo.lane + (b0 - c.memo.lane) * 0.6 + (rnd() - 0.5) * 3)
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
    const whole: string[] = []
    for (const id of c.ids) {
      const p = c.sb.get(id)
      if (p) whole.push(p.kind.id)
    }
    return `${c.memo.thrown - whole.length}/${c.memo.thrown} broke on the wall (${c.memo.wall.toFixed(1)} units off)` +
      `${whole.length ? ' (whole: ' + whole.join(', ') + ')' : ''}, ${c.sb.stats.gibs} gibs lying about`
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
    // three loose layers, dropped from low enough that the bottles and
    // melons land whole: the point is three hundred props, not the gibs
    for (let i = 0; i < 300; i++) {
      const kind = CROWD_MIX[i % CROWD_MIX.length]
      const layer = Math.floor(i / 100)
      const k = i % 100
      const p = at(c, (k % 10) * 4 + (rnd() - 0.5) * 1.2, ((Math.floor(k / 10) - 4.5) * 1.75) + (rnd() - 0.5) * 0.6)
      c.ids.push(c.sb.spawn(kind, { x: p.x, y: c.sb.restY(kind, p.x, p.z) + 0.3 + layer * 2.6, z: p.z }, {
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
