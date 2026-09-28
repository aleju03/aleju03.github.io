#!/usr/bin/env node
/*
  Run the world generator in Node and print numbers about it.

    node scripts/measure.mjs kits          every prop kit: verts, cards, bounds
    node scripts/measure.mjs chunks        build cost and vertex budget
    node scripts/measure.mjs streaming     sliced chunk parity, cancellation and build cost
    node scripts/measure.mjs collision     collision grid parity and query cost
    node scripts/measure.mjs pedestrians   crowd animation cadence and CPU cost
    node scripts/measure.mjs landmarks     site density and the kind mix
    node scripts/measure.mjs smoke         build a few thousand chunks, catch throws
    node scripts/measure.mjs far           the far field: build cost per slice
                                           and in total, what it holds, and the
                                           chunk ring it replaces from the air
    node scripts/measure.mjs physics       the sandbox: ground, cost, stacks,
                                           tunnelling, the walker, scenarios,
                                           destruction
    node scripts/measure.mjs world-effects shared portals, crossings and jump clouds
    node scripts/measure.mjs prop-sync     shared props, handoffs, joints, cleanup and idle traffic
    node scripts/measure.mjs damage-sync   shared world damage: replayed blows, the ruins
                                           union, felled props and a late join
    node scripts/measure.mjs console       every console command run headless
                                           against a real sandbox, and noclip
    node scripts/measure.mjs fracture      every building in a few town blocks
                                           taken apart: pieces, cost, support
    node scripts/measure.mjs body          the player character: every variant's
                                           cost and closure, folds across every
                                           filmstrip, the run lean, the hooks
    node scripts/measure.mjs bodies        bumping into people: the film's street run
                                           headless, a sweep of approaches for the
                                           closest two bodies ever get, the pass's
                                           cost, and a shove between two players
    node scripts/measure.mjs seats         who fits in the fleet: riders in the
                                           tallest headgear seated in every chair,
                                           vertices through the hull or canopy
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
  // the far field (world/farfield.ts): what it costs to build, in slices
  // and in total, what it holds, and what it replaces from the air
  far: `
const { buildFarField } = await import('${W}/farfield.ts')
const { setGfxTier, gfx } = await import('${W}/quality.ts')
const spots = [['home', 0, 30], ['downtown', 0, -340], ['forest', -147, -845], ['coast', -1725, -1300]]
for (const tier of ['medium', 'high']) {
  setGfxTier(tier)
  for (const [label, x, z] of spots) {
    const far = buildFarField({ parent: new THREE.Group(), water: new THREE.Color(), trackDisposable: () => {} })
    far.update(x, z, 200, () => false, 0)
    let total = 0, slices = 0, worst = 0
    while (far.pending) {
      const ms = far.work(0.001)
      total += ms; slices++; worst = Math.max(worst, ms)
      far.update(x, z, 200, () => false, 0)
    }
    const st = far.stats()
    console.log(tier.padEnd(7) + label.padEnd(10) + String(st.tiles).padStart(4) + ' tiles ' +
      String(st.verts).padStart(7) + ' verts ' + String(st.tris).padStart(7) + ' tris  ' +
      total.toFixed(0).padStart(5) + ' ms total, ' + (total / st.tiles).toFixed(1) + ' ms/tile, ' +
      slices + ' slices, worst ' + worst.toFixed(2) + ' ms, reach ' + Math.round(far.reach(x, z)))
    far.dispose()
  }
}
// what the ring costs from the air: the old wide ring against the one the
// far field lets it shrink to (streamer.ts's RADIUS_HIGH and RADIUS_FAR)
setGfxTier('medium')
for (const [label, x, z] of spots.slice(1)) {
  const cx = chunkX(x), cz = chunkZ(z)
  for (const r of [6, 3]) {
    let v = 0, n = 0
    const t0 = performance.now()
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      v += vertsOf(buildChunk(cx + dx, cz + dz, tierFor(Math.max(Math.abs(dx), Math.abs(dz))), MATS)); n++
    }
    console.log('ring ' + r + '  ' + label.padEnd(10) + String(n).padStart(4) + ' chunks ' +
      String(v).padStart(8) + ' verts  ' + (performance.now() - t0).toFixed(0).padStart(5) + ' ms to build')
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

const FILE_REPORTS = [
  'physics', 'console', 'fracture', 'bodies', 'body', 'seats', 'prop-sync',
  'world-effects', 'streaming', 'pedestrians', 'collision', 'damage-sync', 'weapons',
]
const [what, arg] = process.argv.slice(2)
let body = REPORTS[what]
// the sandbox's report lives in its own file (it is long, and it imports the
// sandbox, which nothing else here needs); `physics <section>` runs one part
if (FILE_REPORTS.includes(what)) {
  body = readFileSync(join(ROOT, 'scripts', 'measure', `${what}.js`), 'utf8')
    .replace(/'\.\.\/\.\.\/src\//g, `'${ROOT}/src/`)
    .replace(/'\.\.\/\.\.\/server\//g, `'${ROOT}/server/`)
}
if (what === 'eval') {
  if (!arg) { console.error('measure.mjs eval <file.js>'); process.exit(1) }
  body = readFileSync(resolve(arg), 'utf8')
}
if (!body) {
  console.error(`usage: node scripts/measure.mjs <${[...Object.keys(REPORTS), ...FILE_REPORTS].join('|')} [section]|eval <file>>`)
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
// one stage per run: node_modules may be shared between worktrees, and two
// runs writing the same entry.js (and deleting it on exit) race each other
const stage = join(ROOT, 'node_modules', '.cache', `world-measure-${process.pid}`)
mkdirSync(stage, { recursive: true })
const entry = join(stage, 'entry.js')
writeFileSync(entry, PRELUDE + body)
const out = join(mkdtempSync(join(tmpdir(), 'measure-')), 'bundle.mjs')
const build = spawnSync('npx', [
  'esbuild', entry, '--bundle', '--format=esm', '--platform=node',
  `--outfile=${out}`, '--log-level=error',
], { stdio: 'inherit', cwd: ROOT })
if (build.status !== 0) process.exit(build.status ?? 1)
const run = spawnSync(process.execPath, [...(process.env.PROF ? ['--cpu-prof', `--cpu-prof-dir=${process.env.PROF}`] : []), out, ...((FILE_REPORTS.includes(what)) && arg ? [arg] : [])], { stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
process.exit(run.status ?? 0)
