/*
  Spatial collision regression and cost: npm run measure -- collision.
  An unsynchronized set deliberately retains the original linear scan, giving
  the grid an oracle through the same narrow phase. Exercise real town/forest
  solids plus adversarial mutations and ordered pushes across grid cells.
*/
import assert from 'node:assert/strict'
import {
  makeCollisionSet, syncCollisionSet, invalidateCollisionBoxes, supportY, surfaceAbove, blockedAt,
  resolveXZ, makeHull, fitHull,
} from '../../src/game/physics/collision.ts'

const bounds = { minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }
const box = (x0, z0, x1, z1, y0 = 0, y1 = 8) =>
  new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1))
let seed = 731923
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
let comparisons = 0
const compare = (indexed, linear, x, z, y = 1, step = 0.3) => {
  assert.equal(supportY(x, z, y + step, indexed, -20), supportY(x, z, y + step, linear, -20))
  assert.equal(surfaceAbove(x, z, y, 5, indexed), surfaceAbove(x, z, y, 5, linear))
  assert.equal(blockedAt(x, z, y, y + 3, indexed, step), blockedAt(x, z, y, y + 3, linear, step))
  const a = new THREE.Vector3(x, y, z)
  const b = a.clone()
  resolveXZ(a, indexed, y, y + 3, step)
  resolveXZ(b, linear, y, y + 3, step)
  assert.deepEqual(a.toArray(), b.toArray(), `push at ${x},${z},${y}`)
  comparisons += 4
}
const pair = (boxes) => {
  const indexed = makeCollisionSet(bounds, boxes)
  const linear = makeCollisionSet(bounds, boxes)
  syncCollisionSet(indexed)
  return [indexed, linear]
}
const fillers = () => Array.from({ length: 120 }, (_, i) => box(1000 + i * 20, 1000, 1004 + i * 20, 1004))

// Measure before adversarial cases introduce intentionally unusual Box3
// shapes (infinite extents, test-only metadata) into V8's hot-loop profiles.
let checksum = 0
const runQueries = (set, points, rounds) => {
  const p = new THREE.Vector3()
  const start = performance.now()
  for (let n = 0; n < rounds; n++) for (const [x, z, y] of points) {
    checksum += supportY(x, z, y + 0.4, set, y)
    checksum += +blockedAt(x, z, y, y + 3.84, set, 0.4)
    p.set(x, y, z)
    resolveXZ(p, set, y, y + 3.84, 0.4)
    checksum += p.x
  }
  return performance.now() - start
}
for (const [label, cx, cz] of [['downtown', -1, -6], ['forest', 6, -30]]) {
  const chunks = []
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) chunks.push(buildChunk(cx + dx, cz + dz, 'full', MATS))
  const solids = chunks.flatMap(c => c.boxes)
  const [fast, slow] = pair(solids)
  const points = Array.from({ length: 500 }, () => {
    const x = originX(cx - 1) + random() * CHUNK * 3
    const z = originZ(cz - 1) + random() * CHUNK * 3
    return [x, z, terrainY(x, z)]
  })
  for (const [x, z, y] of points) compare(fast, slow, x, z, y)
  runQueries(fast, points, 20)
  runQueries(slow, points, 20)
  const gridMs = runQueries(fast, points, 80)
  const linearMs = runQueries(slow, points, 80)
  const t0 = performance.now()
  for (let n = 0; n < 1000; n++) syncCollisionSet(fast)
  const syncMs = (performance.now() - t0) / 1000
  console.log(`${label}: ${solids.length} boxes, 120000 queries: linear ${linearMs.toFixed(1)} ms, grid ${gridMs.toFixed(1)} ms (${(linearMs / gridMs).toFixed(1)}x); sync ${syncMs.toFixed(3)} ms`)
  for (const c of chunks) for (const geo of c.geos) geo.dispose()
}
assert.ok(Number.isFinite(checksum))

// Door starts open when the grid is built, closes without a frame sync, then
// opens/recloses. Vehicle hull moves/rotates and is emptied by its own tick.
const door = box(0, 0, 0, 0, 0, 0)
door.moving = true
const vehicle = box(0, 0, 0, 0)
const hull = makeHull([{ z: -5, hw: 2, top: 2 }, { z: 5, hw: 2, top: 3 }])
fitHull(hull, vehicle, 40, 0, 40, 0, 0.5)
const changing = [...fillers(), door, vehicle]
const [indexed, linear] = pair(changing)
door.copy(box(-1, -2, 1, 2))
compare(indexed, linear, 0, 0)
door.makeEmpty()
compare(indexed, linear, 0, 0)
door.copy(box(-1, -2, 1, 2))
compare(indexed, linear, 0, 0)
fitHull(hull, vehicle, -40, 0, -40, 0.7, 0.5)
for (let n = 0; n < 200; n++) compare(indexed, linear, -40 + random() * 12 - 6, -40 + random() * 12 - 6)
vehicle.makeEmpty()
compare(indexed, linear, -40, -40)
fitHull(hull, vehicle, -80, 0, 20, -0.4, 0.5)
compare(indexed, linear, -80, 20)

// Same-length mutation, entirely replaced array, static translation, a
// box added between syncs, flag/y changes, and removal below the threshold.
changing[0] = box(12, 12, 18, 18)
invalidateCollisionBoxes(changing)
compare(indexed, linear, 15, 15)
changing[0] = box(12, 12, 18, 18, 0, 4)
syncCollisionSet(indexed) // direct same-length replacement without notification
compare(indexed, linear, 15, 15)
changing[0].translate(new THREE.Vector3(-64, 0, -64))
syncCollisionSet(indexed)
compare(indexed, linear, -49, -49)
changing[0].through = true
compare(indexed, linear, -49, -49)
changing[0].through = false
changing[0].min.y = 5
compare(indexed, linear, -49, -49)
changing.push(box(-150, 200, -140, 210))
compare(indexed, linear, -145, 205)
const replacement = [...fillers(), box(-200, -200, -190, -190)]
indexed.boxes = replacement
linear.boxes = replacement
compare(indexed, linear, -195, -195)
replacement.length = 1
compare(indexed, linear, 1002, 1002)

// Push right across a cell boundary into a later obstacle, with a live box
// interleaved in array order; the reverse ordering must also match exactly.
const a = box(-50, -80, 17, 80)
const b = box(16, -100, 100, 100)
b.moving = true
const c = box(-100, -120, 16, 120)
for (const ordered of [[a, b, c], [c, b, a]]) {
  const [fast, slow] = pair([...ordered, ...fillers()])
  compare(fast, slow, 15, 0)
  for (let n = 0; n < 500; n++) compare(fast, slow, random() * 100 - 50, random() * 100 - 50)
}

// Huge/non-finite extents fall back safely, and the dynamic provider still
// runs after the static pass in all query paths.
const huge = box(-10000, -10000, 10000, 10000, -2, 0)
const infinite = box(-Infinity, -Infinity, Infinity, Infinity, -5, -3)
const [special, reference] = pair([...fillers(), huge, infinite])
special.dynamic = reference.dynamic = {
  topAt: () => 2,
  blocks: () => true,
  pushOut: (p) => { p.x += 0.125 },
}
compare(special, reference, 16, -16)

// Dense, overlapping boxes stress all four query contracts: roofs, noStand,
// portals, negative cell coordinates and inclusive support at cell borders.
const randomBoxes = [...fillers()]
for (let n = 0; n < 400; n++) {
  const x = random() * 160 - 80
  const z = random() * 160 - 80
  const y = random() * 15 - 5
  const b = box(x, z, x + random() * 50, z + random() * 50, y, y + random() * 15)
  if (n % 7 === 0) b.noStand = true
  if (n % 11 === 0) b.through = true
  if (n % 13 === 0) b.ramp = { axis: n % 2 ? 'x' : 'z', lo: y, hi: b.max.y }
  randomBoxes.push(b)
}
const [dense, denseLinear] = pair(randomBoxes)
for (let n = 0; n < 5000; n++) compare(dense, denseLinear, random() * 180 - 90, random() * 180 - 90, random() * 25 - 5)
for (let x = -96; x <= 96; x += 16) for (let z = -96; z <= 96; z += 16) compare(dense, denseLinear, x, z)

console.log(`collision: ${comparisons} query comparisons passed; doors, moving/empty hulls, streamed replacements, cell-crossing order, ramps, portals, dynamic provider`)
