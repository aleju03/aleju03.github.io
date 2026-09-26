import * as THREE from 'three'
import { buildChunk, type ChunkMats } from '../world/chunk'
import { CHUNK, chunkX, chunkZ, inReserved, originX, originZ } from '../world/grid'
import type { StructureRec } from '../world/fracture'
import type { ShopDoorSpec } from '../world/shopDoors'
import type { Solid } from '../physics/collision'
import { destructionOf } from './destruction'
import { defineScenario, type ScenarioCtx } from './scenarios'
import type { Sandbox } from './sandbox'

/*
  Destruction, filmed: three scripted demolitions for the film harness and
  `measure physics destruction`, the way scenarios.ts scripts the props.

  - `sandbox:demolish-house`: a ring of red barrels against one side of a
    suburban house goes off in a chain, the ground floor on that side goes,
    and the house folds over into its own garden.
  - `sandbox:tower`: demolition charges along one side of a downtown tower's
    ground floor. The storey fails from that side outward, and the tower
    leans into the hole and comes down across the street like a felled tree,
    breaking up storey by storey when it lands.
  - `sandbox:wall`: a concrete Jersey barrier thrown broadside into a
    shopfront at the speed a physgun throw leaves the hand: through the wall
    and into the shop, with the storefront bay coming away round it.

  The sites are real buildings found by walking a spiral of chunks and
  reading the structures chunk.ts records, so each film always lands on the
  same building. A site also needs somewhere to stand and look, so each
  candidate is tried from sixteen bearings and the one with the clearest
  corridor of ground between the lens and the wall wins (the world's own
  solids are the test, which is what `clearOf` does for the props' sites).
*/

let standIn: ChunkMats | null = null
const cache = new Map<string, {
  recs: StructureRec[]; boxes: Solid[]; trees: Array<[number, number]>; doors: ShopDoorSpec[]
}>()

/** what chunk.ts records in one chunk, built with throwaway materials */
const recordsIn = (cx: number, cz: number) => {
  const k = `${cx},${cz}`
  let hit = cache.get(k)
  if (!hit) {
    const m = () => new THREE.MeshBasicMaterial()
    standIn ??= { ground: m(), detail: m(), glass: m(), water: m(), leaf: m(), leafDepth: m() }
    const ch = buildChunk(cx, cz, 'full', standIn)
    for (const g of ch.geos) g.dispose()
    // a tree's solid is its trunk, and its crown is what blocks a lens
    const trees = ch.smash.props.filter((p) => p.rTop > 0.5).map((p) => [p.x, p.z] as [number, number])
    hit = { recs: ch.structures, boxes: ch.boxes, trees, doors: ch.doors }
    cache.set(k, hit)
  }
  return hit
}

const boundsOf = (r: StructureRec) => {
  const b = new THREE.Box3()
  for (const s of r.boxes) if (!s.isEmpty()) b.union(s)
  return b
}

/** how much of a corridor from (x, z) along (dx, dz), from r0 to r1 out and
    `half` either side, is free of any solid taller than a fence */
const openness = (
  x: number, z: number, dx: number, dz: number, r0: number, r1: number, half: number, skip: Set<Solid>,
  /** boxes whose tops are under this height are looked over, not into */
  over = -Infinity,
) => {
  let free = 0
  let n = 0
  const sx = -dz
  const sz = dx
  for (let r = r0; r <= r1; r += 2) {
    for (const k of [-1, 0, 1]) {
      const px = x + dx * r + sx * half * k
      const pz = z + dz * r + sz * half * k
      n++
      let blocked = false
      const here = recordsIn(chunkX(px), chunkZ(pz))
      for (const [tx, tz] of here.trees) {
        if ((tx - px) ** 2 + (tz - pz) ** 2 < 36) {
          blocked = true
          break
        }
      }
      const boxes = blocked ? [] : here.boxes
      for (const b of boxes) {
        if (skip.has(b) || b.max.y - b.min.y < 2.4 || b.max.y < over) continue
        if (px > b.min.x - 0.5 && px < b.max.x + 0.5 && pz > b.min.z - 0.5 && pz < b.max.z + 0.5) {
          blocked = true
          break
        }
      }
      if (!blocked) free++
    }
  }
  return n ? free / n : 0
}

interface Found {
  x: number
  z: number
  dx: number
  dz: number
  memo: Record<string, number>
}

/**
 * The first building of one of `kinds` on a spiral of chunks out from
 * `from`, with a clear view from some bearing at `dist(size)` units out
 * (and, if `side`, clear ground to one side of it too, for something to fall
 * into). Reports the building's centre, the bearing toward the lens, and in
 * `memo` its size, height, the distance and which side is open.
 */
const siteBuilding = (
  kinds: string[], from: [number, number], dist: (w: number, h: number) => number,
  opts: { minH?: number; maxH?: number; side?: boolean; minOpen?: number; fall?: boolean } = {},
): Found => {
  const c0 = chunkX(from[0])
  const d0 = chunkZ(from[1])
  for (let ring = 0; ring < 40; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
        const cx = c0 + dx
        const cz = d0 + dz
        if (inReserved(originX(cx) + CHUNK / 2, originZ(cz) + CHUNK / 2, 80)) continue
        for (const r of recordsIn(cx, cz).recs) {
          if (!kinds.includes(r.kind)) continue
          const b = boundsOf(r)
          if (b.isEmpty()) continue
          const h = b.max.y - r.baseY
          if (h < (opts.minH ?? 0) || h > (opts.maxH ?? 1e9)) continue
          const x = (b.min.x + b.max.x) / 2
          const z = (b.min.z + b.max.z) / 2
          const w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z)
          const skip = new Set<Solid>(r.boxes)
          const far = dist(w, h)
          if (opts.fall) {
            // the ground it falls across first (the most open run out to its
            // own height), and the lens square to that, on whichever flank
            // is clearer
            let bf = -1
            let fk = 0
            for (let k = 0; k < 16; k++) {
              const a = (k / 16) * Math.PI * 2
              const o = openness(x, z, Math.cos(a), Math.sin(a), w * 0.5 + 2, w * 0.5 + h * 0.9, w * 0.35, skip)
              if (o > bf) {
                bf = o
                fk = k
              }
            }
            if (bf < (opts.minOpen ?? 0.6)) continue
            // and it stands over its neighbours: nothing more than half its
            // height within a fall's length on most sides, or the film is a
            // photograph of the block in front of it
            let tall = 0
            for (let k = 0; k < 8; k++) {
              const a = (k / 8) * Math.PI * 2
              tall += openness(x, z, Math.cos(a), Math.sin(a), w * 0.5 + 2, w * 0.5 + h, w * 0.4, skip, r.baseY + h * 0.5)
            }
            if (tall / 8 < 0.6) continue
            const fa = (fk / 16) * Math.PI * 2
            const fdx = Math.cos(fa)
            const fdz = Math.sin(fa)
            const mx = x + fdx * h * 0.4
            const mz = z + fdz * h * 0.4
            // the lens stands at 0.8 of its height, so anything under half
            // its height is looked over
            const over = r.baseY + h * 0.5
            const l = openness(mx, mz, -fdz, fdx, h * 0.3, far, 6, skip, over)
            const rr = openness(mx, mz, fdz, -fdx, h * 0.3, far, 6, skip, over)
            if (Math.max(l, rr) < 0.9) continue
            const side = l >= rr ? 1 : -1
            return {
              x, z, dx: -fdz * side, dz: fdx * side,
              memo: { w, h, far, side: 0, base: r.baseY, open: bf, fdx, fdz },
            }
          }
          let best = -1
          let bestK = -1
          let bestSide = 0
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2 + 0.2
            const ux = Math.cos(a)
            const uz = Math.sin(a)
            let o = openness(x, z, ux, uz, w * 0.5 + 2, far, Math.max(3, w * 0.25), skip)
            let side = 0
            if (opts.side) {
              // the ground a falling building lands on: to one side of the
              // line of sight, out to its own height
              const l = openness(x, z, -uz, ux, w * 0.5 + 2, w * 0.5 + h * 0.8, w * 0.3, skip)
              const rr = openness(x, z, uz, -ux, w * 0.5 + 2, w * 0.5 + h * 0.8, w * 0.3, skip)
              side = l >= rr ? 1 : -1
              o = o * 0.5 + Math.max(l, rr) * 0.5
            }
            if (o > best) {
              best = o
              bestK = k
              bestSide = side
            }
          }
          if (best < (opts.minOpen ?? 0.7)) continue
          {
            const a = (bestK / 16) * Math.PI * 2 + 0.2
            // the lens itself, with room round it
            if (openness(x, z, Math.cos(a), Math.sin(a), far - 2, far + 2, 4, skip) < 1) continue
          }
          const a = (bestK / 16) * Math.PI * 2 + 0.2
          return {
            x, z, dx: Math.cos(a), dz: Math.sin(a),
            memo: { w, h, far, side: bestSide, base: r.baseY, open: best },
          }
        }
      }
    }
  }
  return { x: from[0], z: from[1], dx: 1, dz: 0, memo: { w: 10, h: 10, far: 30, side: 1, base: 0, open: 0 } }
}

const cache1 = new Map<string, Found>()
const once = (key: string, f: () => Found) => () => {
  let hit = cache1.get(key)
  if (!hit) cache1.set(key, (hit = f()))
  return hit
}

/** the building the site found, in the running sandbox's ruins */
const building = (c: ScenarioCtx) => {
  const d = destructionOf(c.sb)
  return d ? d.nearest({ x: c.x, y: c.memo.base + 1, z: c.z }, 3) : null
}

const report = (sb: Sandbox, c: ScenarioCtx) => {
  const d = destructionOf(sb)
  if (!d) return 'no destruction attached'
  const s = d.stats
  const b = building(c)
  let alive = 0
  let total = 0
  if (b?.open) {
    total = b.open.alive.length
    for (let i = 0; i < total; i++) alive += b.open.alive[i]
  }
  return `[w ${c.memo.w.toFixed(0)} h ${c.memo.h.toFixed(0)} open ${c.memo.open.toFixed(2)}] ${total - alive}/${total} pieces down, ${s.lumps} rubble (${s.awake} moving, ${s.frozen} welded, ${s.lost} lost), ` +
    `worst opening slice ${s.openMs.toFixed(1)} ms, clusters leaned to ${s.lean.toFixed(0)} deg`
}

/* ------------------------------------------------------------ the house -- */

const house = defineScenario({
  id: 'sandbox:demolish-house',
  title: 'red barrels along one side of a house go off, and the house folds over',
  site: once('house', () => siteBuilding(['house'], [0, -300], (w) => w * 1.6 + 14, { minH: 6, side: true })),
  duration: 7,
  frames: 12,
  camera: (c) => {
    const w = c.memo.w
    const h = c.memo.h
    const d = c.memo.far
    // straight down the open bearing, a storey over the eaves
    const a = Math.atan2(c.dz, c.dx)
    // high over the garden, looking down past the trees round it, and a
    // little toward the side it folds over into
    const dd = Math.min(d, w * 1.2 + 10)
    const side = c.memo.side || 1
    const sx = -c.dz * side
    const sz = c.dx * side
    return {
      from: [c.x + Math.cos(a) * dd - sx * w * 0.3, c.memo.base + h + 13, c.z + Math.sin(a) * dd - sz * w * 0.3],
      to: [c.x + sx * w * 0.25, c.memo.base + h * 0.2, c.z + sz * w * 0.25],
      fov: 60,
      clear: true,
    }
  },
  setup: (c) => {
    const s = building(c)
    if (!s) return
    const b = s.box
    // the charges go along the wall facing the fall side (across the view)
    const side = c.memo.side || 1
    const sx = -c.dz * side
    const sz = c.dx * side
    const hx = (b.max.x - b.min.x) / 2
    const hz = (b.max.z - b.min.z) / 2
    const cx = (b.min.x + b.max.x) / 2
    const cz = (b.min.z + b.max.z) / 2
    // the face nearest that direction, a stride out from it
    const reach = Math.abs(sx) * hx + Math.abs(sz) * hz + 1.1
    const tx = -sz
    const tz = sx
    const along = Math.abs(tx) * hx + Math.abs(tz) * hz
    for (let k = -1; k <= 1; k++) {
      const px = cx + sx * reach + tx * k * along * 0.6
      const pz = cz + sz * reach + tz * k * along * 0.6
      c.ids.push(c.sb.spawn('barrel_explosive', { x: px, y: c.sb.restY('barrel_explosive', px, pz), z: pz }))
    }
    c.memo.fx = cx + sx * reach
    c.memo.fz = cz + sz * reach
  },
  events: [
    [0.5, (c) => {
      // the first one goes and takes the others with it
      const id = c.ids[1]
      if (c.sb.get(id)) c.sb.damage(id, 999)
    }],
  ],
  report: (c) => report(c.sb, c),
})

/* ------------------------------------------------------------- the ruin -- */

/*
  The same demolition, run on until it has settled and looked at from where
  a player would stand: a walker's eye (3.84 up) out past the charges, just
  clear of the rubble, looking into the footprint. The report counts what
  is still standing as solids over the footprint (what the walk collides
  with) and the rubble lying in it (what it climbs over).
*/
defineScenario({
  ...house,
  id: 'sandbox:ruin',
  title: 'the house after it came down, from a walker\'s eye',
  duration: 11,
  frames: 1,
  camera: (c) => {
    const fx = c.memo.fx
    const fz = c.memo.fz
    // back from the charges, away from the house
    let ox = fx - c.x
    let oz = fz - c.z
    const l = Math.hypot(ox, oz) || 1
    ox /= l
    oz /= l
    const ex = fx + ox * 7 + -oz * 3
    const ez = fz + oz * 7 + ox * 3
    return {
      from: [ex, c.sb.groundY(ex, ez) + 3.84, ez],
      to: [c.x, c.memo.base + 1.8, c.z],
      fov: 70,
    }
  },
  report: (c) => {
    const d = destructionOf(c.sb)
    const b = building(c)
    if (!d || !b?.open) return 'nothing came down'
    let standing = 0
    for (const sol of b.open.solids) if (sol && !sol.isEmpty()) standing++
    let lying = 0
    const box = b.box
    c.sb.forEach((p) => {
      if (!p.data.rubble) return
      const t = p.body.translation()
      if (t.x > box.min.x - 4 && t.x < box.max.x + 4 && t.z > box.min.z - 4 && t.z < box.max.z + 4) lying++
    })
    return `${standing} of the house's solids still standing, ${lying} pieces of rubble in and round the footprint`
  },
})

/* ------------------------------------------------------------ the tower -- */

defineScenario({
  id: 'sandbox:tower',
  title: 'charges along one side of a tower\'s ground floor: it leans into the hole and comes down',
  site: once('tower', () => siteBuilding(['tower', 'slab'], [0, -340], (_w, h) => h * 1.3 + 10, {
    minH: 30, maxH: 90, fall: true, minOpen: 0.85,
  })),
  duration: 8,
  frames: 12,
  camera: (c) => {
    const h = c.memo.h
    const fx = c.memo.fdx
    const fz = c.memo.fdz
    // square on to the fall, over the rooftops, looking at the arc it
    // sweeps: the stump on one side of the frame, the landing on the other
    const mx = c.x + fx * h * 0.55
    const mz = c.z + fz * h * 0.55
    const d = h * 1.0 + 10
    return {
      from: [mx + c.dx * d, c.memo.base + h * 0.72, mz + c.dz * d],
      to: [mx, c.memo.base + h * 0.28, mz],
      fov: 60,
      clear: true,
    }
  },
  setup: () => {},
  events: [
    [0.6, (c) => {
      const s = building(c)
      if (!s) return
      const b = s.box
      const sx = c.memo.fdx
      const sz = c.memo.fdz
      const hx = (b.max.x - b.min.x) / 2
      const hz = (b.max.z - b.min.z) / 2
      const cx = (b.min.x + b.max.x) / 2
      const cz = (b.min.z + b.max.z) / 2
      const reach = Math.abs(sx) * hx + Math.abs(sz) * hz
      const tx = -sz
      const tz = sx
      const along = Math.abs(tx) * hx + Math.abs(tz) * hz
      // a row of charges just inside the wall on the fall side, and a
      // second row a third of the way in: the notch a feller cuts
      for (const [inset, n] of [[1.5, 5], [reach * 0.55, 3]] as const) {
        for (let k = 0; k < n; k++) {
          const t = (k / (n - 1) - 0.5) * 1.7
          const px = cx + sx * (reach - inset) + tx * t * along
          const pz = cz + sz * (reach - inset) + tz * t * along
          c.sb.explode({ x: px, y: c.memo.base + 1.5, z: pz }, 1.8, 14)
        }
      }
    }],
  ],
  report: (c) => report(c.sb, c),
})

/* ------------------------------------------------------------- the wall -- */

/** nothing standing (over knee height) in a rectangle `a0..a1` out along
    (dx, dz) from a point and `half` either side of that line */
const runClear = (x: number, z: number, dx: number, dz: number, a0: number, a1: number, half: number, skip: Set<Solid>) => {
  const sx = -dz
  const sz = dx
  const cs = [[a0, -half], [a0, half], [a1, -half], [a1, half]].map(([a, b]) => [x + dx * a + sx * b, z + dz * a + sz * b])
  const x0 = Math.min(...cs.map((c) => c[0]))
  const x1 = Math.max(...cs.map((c) => c[0]))
  const z0 = Math.min(...cs.map((c) => c[1]))
  const z1 = Math.max(...cs.map((c) => c[1]))
  for (let cz = chunkZ(z0); cz <= chunkZ(z1); cz++) {
    for (let cx = chunkX(x0); cx <= chunkX(x1); cx++) {
      for (const b of recordsIn(cx, cz).boxes) {
        if (skip.has(b) || b.isEmpty() || b.max.y - b.min.y < 0.8) continue
        if (b.max.x > x0 && b.min.x < x1 && b.max.z > z0 && b.min.z < z1) return false
      }
    }
  }
  return true
}

/** a shop with its front door on an open street: the front's outward
    normal is the site's direction, and memo carries where the ram lands */
const siteShop = (from: [number, number]): Found => {
  const c0 = chunkX(from[0])
  const d0 = chunkZ(from[1])
  for (let ring = 0; ring < 30; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
        const here = recordsIn(c0 + dx, d0 + dz)
        for (const r of here.recs) {
          if (r.kind !== 'shop') continue
          const b = boundsOf(r)
          if (b.isEmpty()) continue
          const door = here.doors.find((d) => d.x > b.min.x - 1 && d.x < b.max.x + 1 && d.z > b.min.z - 1 && d.z < b.max.z + 1)
          if (!door) continue
          const skip = new Set<Solid>(r.boxes)
          const x = (b.min.x + b.max.x) / 2
          const z = (b.min.z + b.max.z) / 2
          const hx = (b.max.x - b.min.x) / 2
          const hz = (b.max.z - b.min.z) / 2
          const face = Math.abs(door.fx) * hx + Math.abs(door.fz) * hz
          // the ram's run: straight out of the front, clear for twenty units
          const tx = -door.fz
          const tz = door.fx
          const along = Math.abs(tx) * hx + Math.abs(tz) * hz
          // a bay beside the door, away from it, whose run out into the
          // street is clear of every post and bench as wide as the ram
          const dside = (door.x - x) * tx + (door.z - z) * tz > 0 ? -1 : 1
          let hitX = 0
          let hitZ = 0
          let ok = false
          for (const k of [0.45, 0.3, 0.6, 0.15]) {
            hitX = x + door.fx * face + tx * dside * along * k
            hitZ = z + door.fz * face + tz * dside * along * k
            if (runClear(hitX, hitZ, door.fx, door.fz, 0.5, 30, 3.6, skip)) {
              ok = true
              break
            }
          }
          if (!ok) continue
          return {
            x, z, dx: door.fx, dz: door.fz,
            memo: { w: Math.max(hx, hz) * 2, h: b.max.y - r.baseY, far: 24, side: dside, base: r.baseY, open: 1,
              hitX, hitZ, tx, tz },
          }
        }
      }
    }
  }
  return { x: from[0], z: from[1], dx: 1, dz: 0, memo: { w: 10, h: 6, far: 24, side: 1, base: 0, open: 0, hitX: from[0], hitZ: from[1], tx: 0, tz: 1 } }
}

defineScenario({
  id: 'sandbox:wall',
  title: 'a concrete barrier thrown through a shopfront',
  site: once('shop', () => siteShop([0, -340])),
  duration: 5,
  frames: 12,
  camera: (c) => {
    // out in the street, three-quarters on to the bay it hits, from the
    // side the door is not on so the hole opens toward the lens
    const hx = c.memo.hitX
    const hz = c.memo.hitZ
    const sx = c.memo.tx * c.memo.side
    const sz = c.memo.tz * c.memo.side
    return {
      from: [hx + c.dx * 13 + sx * 10, c.memo.base + 6.5, hz + c.dz * 13 + sz * 10],
      to: [hx - c.dx * 2, c.memo.base + 2.8, hz - c.dz * 2],
      fov: 56,
      clear: true,
    }
  },
  setup: (c) => {
    // a Jersey barrier (1.1 tonnes of concrete) carried broadside at the
    // speed of a physgun throw, the way sandbox:stack punts its plank, and
    // let go a stride short of the wall so what hits it is a free body with
    // all of that speed in it
    const start = 24
    const half = 1.2
    const yaw = Math.atan2(c.dx, c.dz)
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
    const y = Math.max(c.memo.base, c.sb.groundY(c.memo.hitX, c.memo.hitZ)) + 1.6
    const at = (d: number) => ({ x: c.memo.hitX + c.dx * d, y, z: c.memo.hitZ + c.dz * d })
    const id = c.sb.spawn('barrier', at(start), { quaternion: q })
    c.sb.setMode(id, 'kinematic')
    c.ids.push(id)
    let t = 0
    const off = c.sb.onBeforeSlice((h) => {
      t += h
      if (!c.sb.get(id)) return off()
      const d = start - Math.max(0, t - 0.4) * 34
      if (d > half + 1.2) {
        c.sb.moveKinematic(id, at(d), q)
        return
      }
      c.sb.setMode(id, 'dynamic')
      c.sb.setVelocity(id, { x: -c.dx * 34, y: 1, z: -c.dz * 34 })
      off()
    })
  },
  report: (c) => {
    const p = new THREE.Vector3()
    const inside = c.sb.getTransform(c.ids[0], p)
      ? ((p.x - c.memo.hitX) * -c.dx + (p.z - c.memo.hitZ) * -c.dz).toFixed(1) : 'gone'
    return `${report(c.sb, c)}; the barrier ended ${inside} units past the wall line`
  },
})
