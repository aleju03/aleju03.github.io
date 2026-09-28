/*
 * Shared world damage, headless: two clients, each with its own copy of a
 * real town neighbourhood (a demolition mutates the chunk it stands in), its
 * own sandbox, destruction, prop and damage networks, wired through the
 * real server modules on a deterministic delivery queue. A console blow, a
 * relayed blast and a felled tree on one client must leave the other with
 * the same buildings missing the same pieces, and a late arrival must end up
 * with the same holes from the snapshot alone, with no bang replayed.
 */
import assert from 'node:assert/strict'
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { SCENARIOS } from '../../src/game/sandbox/scenarios.ts'
import '../../src/game/sandbox/destructionScenarios.ts'
import { attachDestruction } from '../../src/game/sandbox/destruction.ts'
import { buildDebris } from '../../src/game/world/debris.ts'
import { createPropNetwork } from '../../src/game/net/remoteProps.ts'
import { createDamageNetwork } from '../../src/game/net/remoteDamage.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { createPropRegistry } from '../../server/src/props.js'
import { createWorldDamage } from '../../server/src/worldDamage.js'

const LEVEL = 'overworld'
const site = SCENARIOS.find((s) => s.id === 'sandbox:demolish-house').site()
let time = 0
const players = new Map()
const inbound = []
const outbound = []
const registry = createPropRegistry({ players, now: () => time, send: (ws, m) => inbound.push([ws, structuredClone(m)]) })
const damage = createWorldDamage({ players, now: () => time, send: (ws, m) => inbound.push([ws, structuredClone(m)]) })
let booms = 0

const client = async (id) => {
  const cx0 = chunkX(site.x), cz0 = chunkZ(site.z)
  const chunks = new Map()
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const c = buildChunk(cx0 + dx, cz0 + dz, 'full', MATS)
    chunks.set(c.cx + ',' + c.cz, c)
  }
  const sb = createSandbox({
    collision: makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, []), walker: false,
    waterY: () => SEA_Y, chunkSolids: (cx, cz) => chunks.get(cx + ',' + cz)?.boxes ?? null,
  })
  await sb.whenReady
  // the probe's chunk groups hang off a root, as the streamer's do
  const root = new THREE.Group()
  const world = new THREE.Group()
  root.add(world)
  for (const c of chunks.values()) world.add(c.group)
  const debris = buildDebris({ parent: root, obstacles: [], groundAt: terrainY, trackDisposable: () => {} })
  for (const c of chunks.values()) debris.arm(c.smash)
  debris.ruins.onSolids = () => sb.solidsChanged()
  const dmg = attachDestruction(sb, debris.ruins)
  const ws = { world: { id, level: LEVEL, x: site.x, y: site.memo.base, z: site.z }, nick: `p${id}` }
  const send = (m) => outbound.push([ws, structuredClone(m)])
  const props = createPropNetwork(send, () => {}, () => time)
  const net = createDamageNetwork(send, () => time)
  props.attach(sb, LEVEL)
  net.attach(LEVEL, sb, dmg, debris.felling)
  sb.onExplosion(() => booms++)
  ws.recv = (m) => { props.receive(m); net.receive(m) }
  players.set(id, ws)
  ws.recv({ type: 'world-welcome', you: id, tick: 66, slot: 0, players: [] })
  registry.join(ws)
  damage.snapshot(ws)
  return { sb, dmg, debris, chunks, ws }
}

const flush = () => {
  for (let guard = 0; outbound.length || inbound.length; guard++) {
    assert.ok(guard < 100000)
    while (outbound.length) {
      const [ws, m] = outbound.shift()
      if (m.type.startsWith('world-prop-')) registry.handle(ws, m)
      else damage.handle(ws, m)
    }
    while (inbound.length) {
      const [ws, m] = inbound.shift()
      ws.recv(m)
    }
  }
}
const clients = []
const step = (seconds) => {
  for (let i = 0; i < seconds * 60; i++) {
    time += 1000 / 60
    for (const c of clients) c.sb.tick({ dt: 1 / 60, active: true, focus: { x: site.x, y: site.memo.base + 2, z: site.z } })
    flush()
    registry.tick()
    flush()
  }
}
const lost = (c) => {
  const out = new Map()
  for (const [b, keys] of c.debris.ruins.ruined) if (keys.size) out.set(b, [...keys].sort((x, y) => x - y).join(','))
  return out
}
const same = (x, y, label) => {
  const a = lost(x), b = lost(y)
  let pieces = 0
  for (const v of a.values()) pieces += v.split(',').length
  assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort(), `${label}: the same buildings are damaged`)
  for (const [k, v] of a) assert.equal(b.get(k), v, `${label}: ${k} lost the same pieces`)
  console.log(`${label}: ${a.size} buildings, ${pieces} pieces down, identical`)
}

const a = await client(1)
const b = await client(2)
clients.push(a, b)
flush()

// a console blow on A: B watches it replayed, and the union settles any rest
const house = a.dmg.nearest({ x: site.x, y: site.memo.base + 1, z: site.z }, 3)
assert.ok(house, 'a house at the site')
const hb = house.box
const face = { x: hb.max.x + 0.2, y: site.memo.base + 1.5, z: (hb.min.z + hb.max.z) / 2 }
a.dmg.damageAt(face, 70 * 4, 13, 'command', { x: -8, y: 0, z: 0 })
flush()
assert.ok(b.dmg.log.some((r) => r.how === 'command'), 'the blow is replayed on the watcher')
step(8)
same(a, b, 'console blow')

// a blast on B: it travels as an explosion, lands in A's destruction, and is
// not sent back
const before = booms
b.sb.explode({ x: hb.min.x - 1, y: site.memo.base + 1, z: hb.min.z - 1 }, 3, 20)
flush()
assert.equal(booms - before, 2, 'one bang on each client, none echoed')
step(8)
same(a, b, 'relayed blast')

// a tree a car knocks down on A is down on B
let tree = null
for (const c of a.chunks.values()) if (!tree) tree = c.smash.props.find((p) => p.box.breaks)
assert.ok(tree, 'a breakable prop nearby')
tree.box.breaks.hit(tree.x, tree.y, tree.z, 1, 0, 20)
flush()
assert.ok(b.debris.felling.felled.has(tree.id), 'the felled prop is felled on the other client')
assert.ok(b.debris.ruins && [...b.chunks.values()].some((c) => c.smash.props.some((p) => p.id === tree.id && p.box.isEmpty())),
  'and its solid is gone there')

// a late arrival: the end state from the snapshot, quietly
const quiet = booms
const c = await client(3)
clients.push(c)
flush()
step(3)
same(a, c, 'late join')
assert.equal(booms, quiet, 'a late join replays no bangs')
assert.equal(c.dmg.stats.lumps, 0, 'and throws no rubble')
assert.ok(c.debris.felling.felled.has(tree.id), 'the late arrival has the felled prop down')
console.log('damage-sync: console blow, relayed blast, felled prop and late join all agree')
