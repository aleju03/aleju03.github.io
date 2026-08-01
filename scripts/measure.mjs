#!/usr/bin/env node
/*
  Run the world generator in Node and print numbers about it.

    node scripts/measure.mjs kits          every prop kit: verts, cards, bounds
    node scripts/measure.mjs chunks        build cost and vertex budget
    node scripts/measure.mjs landmarks     site density and the kind mix
    node scripts/measure.mjs smoke         build a few thousand chunks, catch throws
    node scripts/measure.mjs eval <file>   run your own probe with the world imported

  `src/game/` is renderer-free by design, so all of it runs here: fields, chunk
  building, kit geometry, the walk controller given a bare camera. That is
  worth far more than a screenshot for anything with a number in it, and it is
  the only way to catch the class of bug a picture cannot show you. The reeds
  were built upside down for months, hanging from y=0.04 down to y=-3.02 and
  therefore buried whole by every scatter, and no screenshot could ever have
  shown that, because a prop that renders underground looks exactly like a
  prop that was never scattered. `kits` prints the bounding box that found it.

  Pictures, as opposed to numbers, are scripts/shoot.mjs.

  It bundles with esbuild (a vite dependency, so already installed) into the
  scratch dir and runs the bundle. The entry has to sit inside the project or
  esbuild cannot resolve `three`.
*/
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const W = `${ROOT}/src/game/world`

const PRELUDE = `
import * as THREE from 'three'
import { buildChunk, tierFor } from '${W}/chunk.ts'
import { kitsFor, VARIANTS, SNAP } from '${W}/props.ts'
import { BIOMES, classify } from '${W}/biomes.ts'
import { landmarkIn, landmarkAt, LANDMARK_CELL } from '${W}/landmarks.ts'
import { placeAt, roadAt } from '${W}/settlements.ts'
import { terrainY, sampleAt, heightAt, slopeAt, SEA_Y } from '${W}/terrain.ts'
import { elevationAt, continentAt, temperatureAt, moistureAt } from '${W}/land.ts'
import { CHUNK, chunkX, chunkZ, originX, originZ } from '${W}/grid.ts'
const mat = () => new THREE.MeshBasicMaterial()
/** the six a chunk needs; geometry is all we measure, so stand-ins are fine */
const MATS = { ground: mat(), detail: mat(), glass: mat(), water: mat(), leaf: mat(), leafDepth: mat() }
/** total vertices of a built chunk, and dispose it */
const vertsOf = (c) => { let v = 0; for (const g of c.geos) { v += g.getAttribute('position').count; g.dispose() } return v }
const bboxOf = (kit) => { const b = new THREE.Box3(); for (const p of kit.parts) b.expandByObject(new THREE.Mesh(p.geo)); return b }
`

const REPORTS = {
  kits: `
const kinds = Object.keys(BIOMES).flatMap(b => [...BIOMES[b].flora, ...BIOMES[b].cover]).map(s => s.kind)
for (const k of [...new Set(kinds)]) {
  let v = 0, cards = 0
  for (const kit of kitsFor(k)) for (const p of kit.parts) {
    v += p.geo.getAttribute('position').count
    if (p.slot === 'card') cards++
  }
  const b = bboxOf(kitsFor(k)[2])
  // a little below zero is correct and deliberate: wood() sinks a trunk so
  // the root flare is buried. What is never correct is a kit that is mostly
  // or entirely under its own origin, because plant() stamps at ground level
  // minus 0.15 and the thing is then invisible. That is the reed bug, and it
  // survived for months because an unrendered prop and an unscattered one
  // look identical
  const below = Math.max(0, -b.min.y) / Math.max(0.01, b.max.y - b.min.y)
  const under = (b.max.y < 0.15 || below > 0.5) ? '  <-- BURIED: stamps underground' : ''
  console.log(
    k.padEnd(10) + String(Math.round(v / VARIANTS)).padStart(5) + ' verts  ' +
    String(Math.round(cards / VARIANTS)).padStart(2) + ' cards  y ' +
    b.min.y.toFixed(2).padStart(6) + '..' + b.max.y.toFixed(2).padStart(5) +
    '  r ' + Math.max(b.max.x, -b.min.x, b.max.z, -b.min.z).toFixed(2) +
    (SNAP[k] !== undefined ? '  breakable@' + SNAP[k] : '') + under)
}
`,
  chunks: `
const zones = [
  ['downtown', -1, -6], ['suburb', 0, -2], ['countryside', 40, 40], ['forest', 6, -30],
]
for (const [label, cx, cz] of zones) {
  for (const tier of ['full', 'flora', 'bare']) {
    let v = 0, n = 0
    const t0 = performance.now()
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      v += vertsOf(buildChunk(cx + dx, cz + dz, tier, MATS)); n++
    }
    console.log(label.padEnd(12) + tier.padEnd(6) + String(Math.round(v / n)).padStart(6) +
      ' verts  ' + ((performance.now() - t0) / n).toFixed(2).padStart(6) + ' ms/chunk')
  }
}
`,
  landmarks: `
const half = 27
const tally = new Map()
let cells = 0, hit = 0
for (let cz = -half; cz < half; cz++) for (let cx = -half; cx < half; cx++) {
  cells++
  const lm = landmarkAt((cx + 0.5) * LANDMARK_CELL, (cz + 0.5) * LANDMARK_CELL)
  if (!lm) continue
  hit++
  tally.set(lm.kind, (tally.get(lm.kind) ?? 0) + 1)
}
const km = (2 * half * LANDMARK_CELL) / 1000
console.log(cells + ' cells over a ' + km.toFixed(0) + ' km square: ' + hit +
  ' landmarks (' + (100 * hit / cells).toFixed(1) + '%), one every ' +
  Math.round(LANDMARK_CELL / Math.sqrt(hit / cells)) + ' units')
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log('  ' + k.padEnd(12) + String(n).padStart(5) + '  ' + (100 * n / hit).toFixed(1) + '%')
}
`,
  smoke: `
let bad = 0, n = 0
const t0 = performance.now()
// the town, every tier, then a long walk through open country
for (let cz = -14; cz <= 6; cz++) for (let cx = -10; cx <= 10; cx++)
  for (const tier of ['full', 'flora', 'bare']) {
    try { vertsOf(buildChunk(cx, cz, tier, MATS)); n++ }
    catch (e) { bad++; console.log('  town ' + cx + ',' + cz + ' ' + tier + ': ' + e.message) }
  }
let seed = 12345
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
for (let i = 0; i < 900; i++) {
  const cx = Math.floor((rand() - 0.5) * 1200), cz = Math.floor((rand() - 0.5) * 1200)
  try { vertsOf(buildChunk(cx, cz, i % 3 ? 'full' : 'bare', MATS)); n++ }
  catch (e) { bad++; console.log('  wild ' + cx + ',' + cz + ': ' + e.message) }
}
console.log(n + ' chunks in ' + Math.round(performance.now() - t0) + ' ms, ' +
  (bad ? bad + ' FAILURES' : 'no exceptions'))
if (bad) process.exitCode = 1
`,
}

const [what, arg] = process.argv.slice(2)
let body = REPORTS[what]
if (what === 'eval') {
  if (!arg) { console.error('measure.mjs eval <file.js>'); process.exit(1) }
  body = readFileSync(resolve(arg), 'utf8')
}
if (!body) {
  console.error(`usage: node scripts/measure.mjs <${Object.keys(REPORTS).join('|')}|eval <file>>`)
  console.error('\nan `eval` file is plain JS with the whole world already imported:')
  console.error('  buildChunk tierFor kitsFor VARIANTS SNAP BIOMES classify')
  console.error('  landmarkIn landmarkAt LANDMARK_CELL placeAt roadAt')
  console.error('  terrainY sampleAt heightAt slopeAt SEA_Y')
  console.error('  elevationAt continentAt temperatureAt moistureAt')
  console.error('  CHUNK chunkX chunkZ originX originZ MATS vertsOf bboxOf THREE')
  process.exit(1)
}

// esbuild resolves `three` from the entry file's directory upward, so the
// entry has to live inside the project even though the output does not
const stage = join(ROOT, 'node_modules', '.cache', 'world-measure')
mkdirSync(stage, { recursive: true })
const entry = join(stage, 'entry.js')
writeFileSync(entry, PRELUDE + body)
const out = join(mkdtempSync(join(tmpdir(), 'measure-')), 'bundle.mjs')
const build = spawnSync('npx', [
  'esbuild', entry, '--bundle', '--format=esm', '--platform=node',
  `--outfile=${out}`, '--log-level=error',
], { stdio: 'inherit', cwd: ROOT })
if (build.status !== 0) process.exit(build.status ?? 1)
const run = spawnSync(process.execPath, [out], { stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
process.exit(run.status ?? 0)
