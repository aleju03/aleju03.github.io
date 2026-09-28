// Run: npm run measure -- streaming
// Frozen pre-slicing hashes check actual output, not just two consumers of the
// same new implementation. Interleaving/cancellation cover frame boundaries.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildChunkSteps } from '../../src/game/world/chunk.ts'
const fingerprint = (chunk) => {
 const h = createHash('sha256')
 for (const g of chunk.geos) {
  for (const k of Object.keys(g.attributes).sort()) { const a=g.attributes[k]; h.update(k);h.update(Buffer.from(a.array.buffer,a.array.byteOffset,a.array.byteLength)) }
  const a=g.index?.array;if(a)h.update(Buffer.from(a.buffer,a.byteOffset,a.byteLength))
 }
 h.update(JSON.stringify({boxes:chunk.boxes.map(b=>[b.min.toArray(),b.max.toArray(),b.noStand,b.ramp]),lamps:chunk.lamps,interiors:chunk.interiors,structures:chunk.structures.map(s=>[s.id,s.kind,s.baseY,s.det,s.gl,[...s.marks],[...s.gmarks]]),spinners:chunk.spinners.map(s=>[s.axis.toArray(),s.rate])}))
 return h.digest('hex')
}

const expected = [
  [
    -1,
    -6,
    "full",
    "cfa0f66b684ce06a328cfd4422b99250b71e82a5aa6a6f13b3ce98a1acce35a5"
  ],
  [
    -1,
    -6,
    "flora",
    "cfa0f66b684ce06a328cfd4422b99250b71e82a5aa6a6f13b3ce98a1acce35a5"
  ],
  [
    -1,
    -6,
    "bare",
    "83c253e4a49af8eeafa2e97c378d86592ae64f2bbc67a4c938080eb958bd52a4"
  ],
  [
    0,
    -2,
    "full",
    "7931fb7ed132ef051c1a23892f4570470239148517cc067e31ab64954da56408"
  ],
  [
    0,
    -2,
    "flora",
    "4063d3c0a28585b4501153c1a604ce4e640dbe7a9d060413e33755d095df85ac"
  ],
  [
    0,
    -2,
    "bare",
    "13ecc69653a88402d87afc003b194ba8166f24237c2f017cfcb4fb8116d84109"
  ],
  [
    40,
    40,
    "full",
    "e83e67984993b07d014054e211290010268ccfb21327cad205c4f11eaa4e6933"
  ],
  [
    40,
    40,
    "flora",
    "5abfecc1b9bb6670c5ac708c8a3988111793ef44767a08eea92a141b4962320f"
  ],
  [
    40,
    40,
    "bare",
    "c3c4f7b87e3f932c98c55d5269da09128be1b8c3e8dc93ccb42a65eee758c376"
  ],
  [
    6,
    -30,
    "full",
    "b805cd359aac057bad2366c5b5f05ad261d748a50eeafed161aa4f6314f8d32f"
  ],
  [
    6,
    -30,
    "flora",
    "c79338c38d136ed041db5822b4b7cd220ec70653586ffef37341394bcaee1512"
  ],
  [
    6,
    -30,
    "bare",
    "83550ded3fb62553869dc4542bf5cc4191432b49f26bd08b4d254d711da7469d"
  ],
  [
    0,
    0,
    "full",
    "ce1bacfc6bc50c4b58b77380b1be65effbacccd4dbdc10ec700007af4a17f2c7"
  ],
  [
    0,
    0,
    "flora",
    "153b82768649fef3ad5e153fb851f5f747ef940b4c616b89aedccdc4b7b47efc"
  ],
  [
    0,
    0,
    "bare",
    "d5ca82b86471482e7c86ca4304f5b189ca67410198d7d0db3a6081a352b3a4f1"
  ],
  [
    -22,
    17,
    "full",
    "a1ac90cd2d0e50d57c5bd764f9fdd34455f1758cf10d1f9263892a1e38566f33"
  ],
  [
    -22,
    17,
    "flora",
    "6c16788cd7a3735a0c056f9e80f90b52e2ad2a943190626f33e594763546a47d"
  ],
  [
    -22,
    17,
    "bare",
    "45ffcd2159f4626267cec925fc2eeaa5c037048129d86496d0c3cc16849e892d"
  ]
]

const dispose = c => { for (const g of c.geos) g.dispose() }
for (const [cx, cz, tier, hash] of expected) {
  const c = buildChunk(cx, cz, tier, MATS)
  assert.equal(fingerprint(c), hash, `${cx},${cz} ${tier}: legacy geometry/collision parity`)
  dispose(c)
}
console.log(`${expected.length} frozen chunk geometry/collision fingerprints unchanged`)

const builds = expected.map(([cx, cz, tier, hash]) => ({
  steps: buildChunkSteps(cx, cz, tier, MATS), hash, done: false,
}))
let active = builds.length
while (active) for (const b of builds) {
  if (b.done) continue
  const step = b.steps.next()
  if (!step.done) continue
  assert.equal(fingerprint(step.value), b.hash, 'interleaved builds must stay deterministic')
  dispose(step.value)
  b.done = true
  active--
}
console.log('Interleaved builds preserve all geometry and metadata')

// A structure with a moving rotor exercises ownership while another building
// recorder runs between its construction and mesh merge.
let windmill = null
for (let z = -12; z <= 12 && !windmill; z++) for (let x = -12; x <= 12; x++) {
  const l = landmarkAt((x + 0.5) * LANDMARK_CELL, (z + 0.5) * LANDMARK_CELL)
  if (l?.kind === 'windmill') { windmill = l; break }
}
assert.ok(windmill, 'fixture search must find a windmill')
const wx = chunkX(windmill.x), wz = chunkZ(windmill.z)
const original = buildChunk(wx, wz, 'full', MATS)
assert.ok(original.spinners.length, 'fixture must contain a moving landmark')
const rotorHash = fingerprint(original)
dispose(original)
const rotorBuild = buildChunkSteps(wx, wz, 'full', MATS)
for (;;) {
  const step = rotorBuild.next()
  if (step.done) {
    assert.equal(fingerprint(step.value), rotorHash)
    assert.ok(step.value.structures.some(s => s.rotors?.length), 'rotor remains owned by its structure')
    dispose(step.value)
    break
  }
  dispose(buildChunk(-1, -6, 'bare', MATS))
}
console.log('Landmark rotor ownership survives interleaved structure recording')

const oldSet = THREE.BufferGeometry.prototype.setAttribute
let owned = new Set(), freed = new Set()
THREE.BufferGeometry.prototype.setAttribute = function(name, attribute) {
  if (name === 'aBirth' && !owned.has(this)) {
    owned.add(this)
    this.addEventListener('dispose', () => freed.add(this))
  }
  return oldSet.call(this, name, attribute)
}
try {
  for (const stop of [1, 38, 45, 60, 90, 160]) {
    owned = new Set(); freed = new Set()
    const job = buildChunkSteps(-1, -6, 'full', MATS)
    let complete = null
    for (let i = 0; i < stop; i++) {
      const step = job.next()
      if (step.done) { complete = step.value; break }
    }
    if (complete) dispose(complete)
    else job.return()
    assert.equal(freed.size, owned.size, `cancel after ${stop} slices frees owned geometry`)
  }
} finally { THREE.BufferGeometry.prototype.setAttribute = oldSet }
console.log('Cancellation releases partial geometry at all tested phases')

const whole = [], sliceMax = [], allSlices = []
for (const [cx, cz] of [[-1,-6], [0,-2], [40,40], [6,-30], [wx,wz]]) {
  const times = [], maxima = []
  for (let run = 0; run < 20; run++) {
    const job = buildChunkSteps(cx + run % 3, cz, 'full', MATS)
    let cpu = 0, longest = 0
    for (;;) {
      const t0 = performance.now()
      const step = job.next()
      const ms = performance.now() - t0
      cpu += ms; longest = Math.max(longest, ms); allSlices.push(ms)
      if (step.done) { dispose(step.value); break }
    }
    times.push(cpu); maxima.push(longest)
  }
  const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length / 2)]
  whole.push(...times); sliceMax.push(...maxima)
  console.log(`full ${cx},${cz}: median total ${median(times).toFixed(2)} ms, longest step ${median(maxima).toFixed(2)} ms`)
}
allSlices.sort((a,b)=>a-b)
console.log(`construction slices: p99 ${allSlices[Math.floor(allSlices.length * .99)].toFixed(2)} ms; max ${allSlices.at(-1).toFixed(2)} ms (cold caches/GC can exceed the deadline)`)
