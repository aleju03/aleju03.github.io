import * as THREE from 'three'
import { buildChunk, type ChunkMats } from '../world/chunk'
import { CHUNK, chunkX, chunkZ, inReserved, originX, originZ } from '../world/grid'
import type { StructureRec } from '../world/fracture'
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
  - `sandbox:wall`: a shipping container rammed into a shopfront at the
    speed a physgun throw leaves the hand: through the wall and into the
    shop, with the storefront bay coming away round it.

  The sites are real buildings found by walking a spiral of chunks and
  reading the structures chunk.ts records, so each film always lands on the
  same building. A site also needs somewhere to stand and look, so each
  candidate is tried from sixteen bearings and the one with the clearest
  corridor of ground between the lens and the wall wins (the world's own
  solids are the test, which is what `clearOf` does for the props' sites).
*/

let standIn: ChunkMats | null = null
const cache = new Map<string, { recs: StructureRec[]; boxes: Solid[]; trees: Array<[number, number]> }>()

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
    hit = { recs: ch.structures, boxes: ch.boxes, trees }
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
const openness = (x: number, z: number, dx: number, dz: number, r0: number, r1: number, half: number, skip: Set<Solid>) => {
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
        if (skip.has(b) || b.max.y - b.min.y < 2.4) continue
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
            const fa = (fk / 16) * Math.PI * 2
            const fdx = Math.cos(fa)
            const fdz = Math.sin(fa)
            const mx = x + fdx * h * 0.4
            const mz = z + fdz * h * 0.4
            const l = openness(mx, mz, -fdz, fdx, h * 0.3, far, 5, skip)
            const rr = openness(mx, mz, fdz, -fdx, h * 0.3, far, 5, skip)
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
    `open ${s.openMs.toFixed(1)} ms, last slice ${s.sliceMs.toFixed(2)} ms`
}

/* ------------------------------------------------------------ the house -- */

defineScenario({
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
    const dd = Math.min(d, w * 1.3 + 9)
    return {
      from: [c.x + Math.cos(a) * dd, c.memo.base + h + 5, c.z + Math.sin(a) * dd],
      to: [c.x, c.memo.base + h * 0.3, c.z],
      fov: 58,
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

/* ------------------------------------------------------------ the tower -- */

defineScenario({
  id: 'sandbox:tower',
  title: 'charges along one side of a tower\'s ground floor: it leans into the hole and comes down',
  site: once('tower', () => siteBuilding(['tower', 'slab'], [0, -340], (_w, h) => h * 1.3 + 10, {
    minH: 30, maxH: 90, fall: true, minOpen: 0.85,
  })),
  duration: 9,
  frames: 12,
  camera: (c) => {
    const h = c.memo.h
    const fx = c.memo.fdx
    const fz = c.memo.fdz
    // square on to the fall, over the rooftops, looking at the arc it
    // sweeps: the stump on one side of the frame, the landing on the other
    const mx = c.x + fx * h * 0.42
    const mz = c.z + fz * h * 0.42
    const d = h * 1.25 + 12
    return {
      from: [mx + c.dx * d, c.memo.base + h * 0.8, mz + c.dz * d],
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

defineScenario({
  id: 'sandbox:wall',
  title: 'a shipping container rammed through a shopfront',
  site: once('shop', () => siteBuilding(['shop'], [0, -340], (w) => w * 1.2 + 16, { minOpen: 0.8 })),
  duration: 5,
  frames: 12,
  camera: (c) => {
    const d = c.memo.far
    // from the street, off to one side of the container's run
    const sx = -c.dz
    const sz = c.dx
    return {
      from: [c.x + c.dx * d * 0.85 + sx * d * 0.55, c.memo.base + 7, c.z + c.dz * d * 0.85 + sz * d * 0.55],
      to: [c.x + c.dx * c.memo.w * 0.3, c.memo.base + 2.5, c.z + c.dz * c.memo.w * 0.3],
      fov: 55,
      clear: true,
    }
  },
  setup: (c) => {
    const s = building(c)
    if (!s) return
    const b = s.box
    // the face toward the street, where the container starts
    const hx = (b.max.x - b.min.x) / 2
    const hz = (b.max.z - b.min.z) / 2
    const face = Math.abs(c.dx) * hx + Math.abs(c.dz) * hz
    const start = face + 14
    const px = c.x + c.dx * start
    const pz = c.z + c.dz * start
    const yaw = Math.atan2(c.dx, c.dz)
    const y = c.sb.restY('container', px, pz) + 0.6
    const id = c.sb.spawn('container', { x: px, y, z: pz }, { yaw: yaw + Math.PI / 2 })
    c.ids.push(id)
    c.memo.start = start
  },
  events: [
    [0.4, (c) => {
      const id = c.ids[0]
      if (!c.sb.get(id)) return
      // thrown: flat and fast at the wall, with a little lift
      c.sb.setVelocity(id, { x: -c.dx * 30, y: 2.5, z: -c.dz * 30 })
      c.sb.wake(id)
    }],
  ],
  report: (c) => report(c.sb, c),
})
