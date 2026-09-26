#!/usr/bin/env node
/*
  Run the world generator in Node and print numbers about it.

    node scripts/measure.mjs kits          every prop kit: verts, cards, bounds
    node scripts/measure.mjs chunks        build cost and vertex budget
    node scripts/measure.mjs landmarks     site density and the kind mix
    node scripts/measure.mjs smoke         build a few thousand chunks, catch throws
    node scripts/measure.mjs physics       the sandbox: ground, cost, stacks,
                                           tunnelling, the walker, scenarios
    node scripts/measure.mjs console       every console command run headless
                                           against a real sandbox, and noclip
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
  // what one body costs, because a town wears several: build time, draw calls,
  // vertices, and one frame of a walking pose including the matrix update the
  // renderer would otherwise pay for it
  body: `
const { buildPlayerBody } = await import('${ROOT}/src/game/player/playerBody.ts')
const { makeCollisionSet } = await import('${ROOT}/src/game/physics/collision.ts')
const { bodyGeometry, HAT_COUNT } = await import('${ROOT}/src/game/player/bodyShape.ts')
// every headgear variant: its vertex count, and anything non-finite in it
for (let h = 0; h < HAT_COUNT; h++) {
  const g = bodyGeometry(h)
  const P = g.getAttribute('position'), Nn = g.getAttribute('normal'), R = g.getAttribute('aRole')
  let badP = 0, badN = 0
  const roles = new Set()
  for (let i = 0; i < P.count; i++) {
    if (!Number.isFinite(P.getX(i) + P.getY(i) + P.getZ(i))) { badP++; roles.add(R.getX(i)) }
    if (!Number.isFinite(Nn.getX(i) + Nn.getY(i) + Nn.getZ(i))) { badN++; roles.add(R.getX(i)) }
  }
  console.log('hat ' + h + ': ' + P.count + ' verts' + (badP + badN ? '  NON-FINITE pos ' + badP + ' nrm ' + badN + ' roles ' + [...roles] : ''))
}
const env = { groundY: 0, collision: makeCollisionSet({ minX: -1e3, maxX: 1e3, minZ: -1e3, maxZ: 1e3 }) }
let t0 = performance.now()
const rigs = []
for (let i = 0; i < 20; i++) rigs.push(buildPlayerBody(3.84, 34))
const build = (performance.now() - t0) / 20
let meshes = 0, verts = 0, bones = 0
const mats = new Set()
rigs[1].group.traverse((o) => {
  if (o.isBone) bones++
  if (o.isMesh) { meshes++; verts += o.geometry.getAttribute('position').count; mats.add(o.material) }
})
const pose = { dt: 1 / 60, gait: 0.6, crouchK: 0, grounded: true, run: false, yaw: 0, pitch: 0,
  vx: 0, vz: -3, vy: 0, landing: 0, show: 1 }
for (const r of rigs) r.update(pose, env)
const N = 600
const tick = (label, mutate) => {
  const t = performance.now()
  for (let f = 0; f < N; f++) for (const r of rigs) {
    mutate(r, f)
    r.update(pose, env)
    r.group.updateMatrixWorld(true)
    r.group.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.update() })
  }
  const us = ((performance.now() - t) / N / rigs.length) * 1000
  console.log('  ' + label.padEnd(10) + us.toFixed(1).padStart(7) + ' us/rig/frame')
}
// every triangle should face the way its own vertex normals say, or it is
// culled from the side it is meant to be seen from
rigs[1].group.traverse((o) => {
  if (!o.isSkinnedMesh) return
  const g = o.geometry, P = g.getAttribute('position'), Nn = g.getAttribute('normal')
  const R = g.getAttribute('aRole'), I = g.getIndex()
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3()
  const bad = {}
  for (let t = 0; t < I.count; t += 3) {
    const [i0, i1, i2] = [I.getX(t), I.getX(t + 1), I.getX(t + 2)]
    a.fromBufferAttribute(P, i0); b.fromBufferAttribute(P, i1).sub(a); c.fromBufferAttribute(P, i2).sub(a)
    const g0 = new THREE.Vector3().crossVectors(b, c)
    if (g0.lengthSq() < 1e-12) continue
    n.fromBufferAttribute(Nn, i0).add(a.fromBufferAttribute(Nn, i1)).add(a.fromBufferAttribute(Nn, i2))
    if (g0.dot(n) < 0) { const r = R.getX(i0); bad[r] = (bad[r] ?? 0) + 1 }
  }
  console.log('triangles facing against their normals, by role code: ' + JSON.stringify(bad))
})
console.log('build ' + build.toFixed(2) + ' ms/rig, ' + meshes + ' meshes (draw calls, x2 with a shadow), ' +
  mats.size + ' materials, ' + verts + ' verts' + (bones ? ', ' + bones + ' bones' : ''))
tick('walk', (r) => { r.group.position.z -= 3 / 60 })
pose.vz = 0; pose.gait = 0
tick('idle', () => {})
for (const r of rigs) r.flop(4, 3, -2)
tick('ragdoll', () => {})

// the sandbox hooks, end to end on one body: knocked flat by an impulse at
// the hip, picked up by the left hand and dragged, dropped, left to settle,
// and stood back up. Every limb must stay finite and the body must end up
const r = buildPlayerBody(3.84, 34)
const p = new THREE.Vector3()
const step = (n) => { for (let i = 0; i < n; i++) { r.update(pose, env); r.group.updateMatrixWorld(true) } }
const finite = () => r.limbs.every((l) => { r.limbPos(l.index, p); return Number.isFinite(p.x + p.y + p.z) })
step(30)
r.limbPos(0, p)
r.hit(new THREE.Vector3(0, 5, 12).multiplyScalar(r.mass), p)
step(60)
const hand = r.limbs.find((l) => l.name === 'handL').index
const target = r.limbPos(hand, new THREE.Vector3()).clone().add(new THREE.Vector3(0, 6, 0))
r.grab(hand, target)
for (let i = 0; i < 90; i++) { target.x += 0.05; step(1) }
const held = r.limbPos(hand, new THREE.Vector3()).distanceTo(target)
const heldSettled = r.settled
r.grab(hand, null)
let t = 0
const trace = []
const prevP = r.limbs.map((l) => r.limbPos(l.index, new THREE.Vector3()).clone())
while (!r.settled && t < 600) {
  step(1); t++
  if (t % 60 === 0) {
    let worst = 0, who = ''
    r.limbs.forEach((l, i) => { const q = r.limbPos(l.index, new THREE.Vector3()); const v = q.distanceTo(prevP[i]) * 60; if (v > worst) { worst = v; who = l.name }; prevP[i].copy(q) })
    trace.push(who + ':' + worst.toFixed(1))
  } else r.limbs.forEach((l, i) => r.limbPos(l.index, prevP[i]))
}
if (t >= 600) console.log('never settled; fastest limb per second: ' + trace.join(' '))
const settleS = t / 60
r.getupSpot(p)
r.group.position.set(p.x, 0, p.z)
r.group.updateMatrixWorld(true)
r.beginRecover()
t = 0
while (r.down && t < 300) { step(1); t++ }
console.log('hooks: hit ok, held ' + held.toFixed(2) + ' units off the grab point' +
  (heldSettled ? ' (WRONG: a held body reported settled)' : '') +
  ', settled ' + settleS.toFixed(2) + ' s after release, stood up in ' + (t / 60).toFixed(2) +
  ' s, limbs ' + (finite() ? 'finite' : 'NaN') + ', ' + (r.down ? 'STILL DOWN' : 'standing'))
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
// the sandbox's report lives in its own file (it is long, and it imports the
// sandbox, which nothing else here needs); `physics <section>` runs one part
if (what === 'physics' || what === 'console') {
  body = readFileSync(join(ROOT, 'scripts', 'measure', `${what}.js`), 'utf8')
    .replace(/'\.\.\/\.\.\/src\//g, `'${ROOT}/src/`)
}
if (what === 'eval') {
  if (!arg) { console.error('measure.mjs eval <file.js>'); process.exit(1) }
  body = readFileSync(resolve(arg), 'utf8')
}
if (!body) {
  console.error(`usage: node scripts/measure.mjs <${Object.keys(REPORTS).join('|')}|physics [section]|console|eval <file>>`)
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
const run = spawnSync(process.execPath, [out, ...(what === 'physics' && arg ? [arg] : [])], { stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
process.exit(run.status ?? 0)
