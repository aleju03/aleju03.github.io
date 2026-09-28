/*
 * Blueprints, headless: the share code's round trip and its refusals, a
 * welded car copied, wiped and pasted back that still moves as one, one undo
 * taking the paste away, the prop cap refusing gracefully, and a second
 * client seeing the pasted build through the real server registry.
 *
 *   npm run measure -- blueprints
 */
import assert from 'node:assert/strict'
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { createPropNetwork } from '../../src/game/net/remoteProps.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { historyOf } from '../../src/game/sandbox/history.ts'
import { contraptionOf } from '../../src/game/sandbox/contraption/contraption.ts'
import { buildCar } from '../../src/game/sandbox/contraption/build.ts'
import { capture, connectedTo, place, setPropCap, MAX_PROPS } from '../../src/game/sandbox/blueprint/blueprint.ts'
import { encodeBlueprint, decodeBlueprint, toJson, BlueprintError } from '../../src/game/sandbox/blueprint/code.ts'
import { creativeOf } from '../../src/game/sandbox/creative/creative.ts'
import { createPropRegistry } from '../../server/src/props.js'

const mk = async () => {
  const sb = createSandbox({
    collision: makeCollisionSet({ minX: -300, maxX: 300, minZ: -300, maxZ: 300 }, []),
    walker: false,
    ground: { heightAt: () => 0, lattice: () => 0 },
  })
  await sb.whenReady
  return sb
}
const step = (sbs, n) => {
  for (let i = 0; i < n; i++) for (const sb of sbs) sb.tick({ dt: 1 / 60, active: true, focus: { x: 0, y: 5, z: 0 } })
}

/* -------------------------------------------------- the car, captured -- */
const sb = await mk()
const car = buildCar(sb, { x: 0, y: 0, z: 0 }, 0)
step([sb], 30)
const con = contraptionOf(sb)
assert.equal(connectedTo(sb, car.wheels[0]).length, 8, 'the whole car hangs off one wheel')
const got = capture(sb, connectedTo(sb, car.wheels[0]), 'test car')
assert.ok(got.ok)
const bp = got.bp
assert.equal(bp.props.length, 8)
assert.equal(bp.joints.length, 7)
assert.ok(Math.min(...bp.props.map((p) => p.pos[1])) >= -0.01, 'anchor y is the floor')
assert.equal(bp.props.filter((p) => p.kind === 'wheel').length, 4)
console.log('captured', bp.props.length, 'props', bp.joints.length, 'joints')

/* ------------------------------------------------------ the share code -- */
const code = await encodeBlueprint(bp)
assert.ok(code.startsWith('BP1.') && /^[A-Za-z0-9_.-]+$/.test(code))
const back = await decodeBlueprint(code)
assert.equal(back.name, 'test car')
assert.equal(back.props.length, 8)
assert.equal(back.joints.length, 7)
for (let i = 0; i < 8; i++) {
  assert.equal(back.props[i].kind, bp.props[i].kind)
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(back.props[i].pos[k] - bp.props[i].pos[k]) < 1e-3)
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(back.props[i].quat[k] - bp.props[i].quat[k]) < 2e-4)
}
for (let i = 0; i < 7; i++) {
  assert.equal(back.joints[i].type, bp.joints[i].type)
  assert.equal(back.joints[i].frames.length, 17)
  for (let k = 0; k < 17; k++) assert.ok(Math.abs(back.joints[i].frames[k] - bp.joints[i].frames[k]) < 2e-3, `frame ${i}.${k}`)
}
console.log('share code', code.length, 'chars for 8 props')

const expectErr = async (label, fn, want) => {
  try {
    await fn()
  } catch (e) {
    assert.ok(e instanceof BlueprintError, `${label}: a BlueprintError, got ${e}`)
    if (want) assert.equal(e.code, want, `${label}: ${e.code}`)
    return
  }
  assert.fail(`${label}: accepted`)
}
const deflate = async (text) => {
  const cs = new CompressionStream('deflate')
  const w = cs.writable.getWriter()
  void w.write(new TextEncoder().encode(text)).then(() => w.close())
  const out = []
  const r = cs.readable.getReader()
  for (;;) { const { done, value } = await r.read(); if (done) break; out.push(...value) }
  return 'BP1.' + Buffer.from(out).toString('base64url')
}
const forge = (mut) => { const j = structuredClone(toJson(bp)); mut(j); return deflate(JSON.stringify(j)) }
await expectErr('empty', () => decodeBlueprint('  '), 'empty')
await expectErr('prefix', () => decodeBlueprint('BP9.abc'), 'prefix')
await expectErr('base64', () => decodeBlueprint('BP1.@@@@'), 'base64')
await expectErr('garbage', () => decodeBlueprint('BP1.AAAA'), 'inflate')
await expectErr('toolong', () => decodeBlueprint('BP1.' + 'A'.repeat(200000)), 'toolong')
await expectErr('bomb', async () => decodeBlueprint(await deflate(' '.repeat(6 * 1024 * 1024))), 'toobig')
await expectErr('json', async () => decodeBlueprint(await deflate('{nope')), 'json')
await expectErr('version', async () => decodeBlueprint(await forge((j) => { j.v = 2 })), 'version')
await expectErr('unknown kind', async () => decodeBlueprint(await forge((j) => { j.p[0][0] = 'nuke' })), 'kind')
await expectErr('kind not a string', async () => decodeBlueprint(await forge((j) => { j.p[0][0] = 5 })), 'kind')
await expectErr('301 props', async () => decodeBlueprint(await forge((j) => { j.p = Array.from({ length: MAX_PROPS + 1 }, () => j.p[0]); j.j = [] })), 'props')
await expectErr('no props', async () => decodeBlueprint(await forge((j) => { j.p = []; j.j = [] })), 'props')
await expectErr('nan', async () => decodeBlueprint(await forge((j) => { j.p[0][4] = 'x' })), 'number')
await expectErr('zero quat', async () => decodeBlueprint(await forge((j) => { j.p[0].splice(7, 4, 0, 0, 0, 0) })), 'number')
await expectErr('joint to itself', async () => decodeBlueprint(await forge((j) => { j.j[0][2] = j.j[0][1] })), 'joints')
await expectErr('joint out of range', async () => decodeBlueprint(await forge((j) => { j.j[0][1] = 99 })), 'number')
await expectErr('short joint', async () => decodeBlueprint(await forge((j) => { j.j[0].pop() })), 'shape')
const clamped = await decodeBlueprint(await forge((j) => { j.p[0][1] = 99; j.p[0][2] = 1e9; j.p[0][4] = 1e9; j.n = 'a\u0007b'.repeat(30) }))
assert.equal(clamped.props[0].scale, 4)
assert.equal(clamped.props[0].mass, 20000)
assert.equal(clamped.props[0].pos[0], 400)
assert.ok(clamped.name.length <= 40 && !/[\u0000-\u001f]/.test(clamped.name))
console.log('validation refuses 15 malformed codes and clamps numbers')

/* ------------------------------------ wipe, paste, hold together, undo -- */
historyOf(sb).cleanup('all')
step([sb], 5)
let count = 0
sb.forEach(() => count++)
assert.equal(count, 0, 'everything deleted')
assert.equal(con.stats.constraints, 0)
const at = { x: 40, y: 0, z: 0 }
const placed = place(sb, back, { at, yaw: Math.PI / 2 })
assert.ok(placed.ok)
assert.equal(placed.ids.length, 8)
assert.equal(placed.joints, 7)
assert.equal(con.stats.constraints, 7)
step([sb], 90)
const wheel = placed.ids.find((id) => sb.get(id).kind.id === 'wheel')
const chassis = placed.ids.find((id) => sb.get(id).kind.id === 'plate_l')
const dist = () => {
  const a = new THREE.Vector3()
  const b = a.clone()
  sb.getTransform(chassis, a)
  sb.getTransform(wheel, b)
  return a.distanceTo(b)
}
const d0 = dist()
const start = new THREE.Vector3()
sb.getTransform(chassis, start)
// push the chassis sideways; the axled wheels are dragged along with it
sb.applyImpulse(chassis, { x: 0, y: 0, z: 4000 })
step([sb], 120)
const end = start.clone()
sb.getTransform(chassis, end)
const moved = end.distanceTo(start)
assert.ok(moved > 1.5, `the pasted car was pushed (${moved.toFixed(2)} u)`)
const d1 = dist()
assert.ok(Math.abs(d1 - d0) < 0.6, `the wheel stayed on its axle (${d0.toFixed(2)} -> ${d1.toFixed(2)})`)
const wpos = start.clone()
sb.getTransform(wheel, wpos)
assert.ok(wpos.distanceTo(start) > 1.5, 'the wheel travelled with the chassis')
console.log('pasted car pushed', moved.toFixed(2), 'u; wheel-to-chassis distance', d0.toFixed(2), '->', d1.toFixed(2))
const undone = historyOf(sb).undo()
assert.ok(undone)
count = 0
sb.forEach(() => count++)
assert.equal(count, 0, 'one undo took the whole paste away')
assert.equal(con.stats.constraints, 0, 'and its joints')
assert.equal(historyOf(sb).undo(), null, 'nothing else on the stack')

/* --------------------------------------------------------- the cap ---- */
{
  const capped = await mk()
  capped.network = { online: true, authority: () => true, owns: () => true, claim: () => true, release() {}, cleanup() {}, hit() {}, frame() {}, remove: () => false }
  setPropCap(5)
  const r = place(capped, bp, { at })
  assert.ok(!r.ok && r.reason === 'limit' && r.room === 5, 'over the cap refuses whole')
  let n = 0
  capped.forEach(() => n++)
  assert.equal(n, 0, 'nothing was half-spawned')
  setPropCap(150)
  const big = place(capped, { name: '', props: Array.from({ length: MAX_PROPS + 1 }, () => bp.props[0]), joints: [] }, { at })
  assert.ok(!big.ok && big.reason === 'toobig')
  const missing = place(capped, { name: '', props: [{ ...bp.props[0], kind: 'nuke' }], joints: [] }, { at })
  assert.ok(!missing.ok && missing.reason === 'kind')
  console.log('cap: refused with room', r.room, '; toobig and unknown kind refused')
}

/* ------------------ paint, a lamp's switch and a sign's words ride along -- */
{
  const s = await mk()
  const cr = creativeOf(s)
  const crate = s.spawn('crate', { x: 0, y: 1, z: 0 })
  const lamp = s.spawn('lamp', { x: 3, y: 1, z: 0 })
  const sign = s.spawn('sign', { x: -3, y: 1, z: 0 })
  const plain = s.spawn('crate_small', { x: 0, y: 1, z: 3 })
  step([s], 5)
  cr.paint(crate, 7)
  cr.use(lamp)
  cr.write(sign, 'Hello  world')
  const got2 = capture(s, [crate, lamp, sign, plain], 'creative')
  assert.ok(got2.ok)
  const tagged = got2.bp.props.filter((q) => q.tag)
  assert.equal(tagged.length, 3, 'three props carry a tag, the plain one none')
  const round = await decodeBlueprint(await encodeBlueprint(got2.bp))
  assert.deepEqual(round.props.map((q) => q.tag ?? null), got2.bp.props.map((q) => q.tag ?? null), 'the code keeps the tags')
  // a forged tag is cleaned, not trusted
  const forged = await decodeBlueprint(await deflate(JSON.stringify({ ...toJson(round), p: toJson(round).p.map((r, i) => (i === 0 ? [...r.slice(0, 13), [99, 0, 10, 65]] : r)) })))
  assert.deepEqual(forged.props[0].tag, [0, 0, 65], 'a forged tag is cleaned to what the record allows')
  const t2 = await mk()
  const put = place(t2, round, { at: { x: 0, y: 0, z: 0 } })
  assert.ok(put.ok)
  const back2 = put.ids.map((id) => ({ kind: t2.get(id).kind.id, tag: creativeOf(t2).tagOf(id) }))
  assert.equal(back2.find((q) => q.kind === 'crate').tag.paint, 7, 'paint pasted')
  assert.equal(back2.find((q) => q.kind === 'lamp').tag.off, true, 'the lamp is still switched off')
  assert.equal(back2.find((q) => q.kind === 'sign').tag.text, 'Hello world', 'the sign keeps its words')
  assert.equal(back2.find((q) => q.kind === 'crate_small').tag.paint, 0)
  console.log('creative tags: paint, lamp switch and sign text survive capture, code and paste')
}

/* ------------------------------------------- a second client sees it ---- */
{
  let time = 0
  const players = new Map()
  const inbound = []
  const outbound = []
  const registry = createPropRegistry({ players, now: () => time, send: (ws, m) => inbound.push([ws, structuredClone(m)]) })
  const client = async (id) => {
    const s = await mk()
    const ws = { world: { id, level: 'test', x: 0, y: 0, z: 0 }, nick: `player${id}` }
    const net = createPropNetwork((m) => outbound.push([ws, structuredClone(m)]), () => {}, () => time)
    ws.net = net
    players.set(id, ws)
    net.attach(s, 'test')
    net.receive({ type: 'world-welcome', you: id, tick: 66, slot: 0, players: [] })
    registry.join(ws)
    return { sb: s, ws }
  }
  const A = await client(1)
  const B = await client(2)
  const flush = () => {
    for (let guard = 0; outbound.length || inbound.length; guard++) {
      assert.ok(guard < 10000)
      while (outbound.length) { const [ws, m] = outbound.shift(); registry.handle(ws, m) }
      while (inbound.length) { const [ws, m] = inbound.shift(); ws.net.receive(m) }
    }
  }
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      time += 1000 / 60
      A.sb.tick({ dt: 1 / 60, active: true, focus: { x: 0, y: 5, z: 0 } })
      B.sb.tick({ dt: 1 / 60, active: true, focus: { x: 0, y: 5, z: 0 } })
      flush(); registry.tick(); flush()
    }
  }
  flush()
  const r = place(A.sb, bp, { at: { x: 10, y: 0, z: 0 }, yaw: 0.3 })
  assert.ok(r.ok)
  flush(); run(240)
  const theirs = []
  B.sb.forEach((p) => { if (p.data.net) theirs.push(p) })
  assert.equal(theirs.length, 8, 'the second client has all eight props')
  assert.equal(contraptionOf(B.sb).stats.constraints, 7, 'and all seven joints')
  // undo on A removes it for B too
  historyOf(A.sb).undo()
  flush(); run(30)
  let left = 0
  B.sb.forEach((p) => { if (p.data.net) left++ })
  assert.equal(left, 0, 'one undo removes it for the second client as well')
  console.log('two clients: 8 props and 7 joints arrive, and one undo clears both')
}
console.log('blueprints: ok')
