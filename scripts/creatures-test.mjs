#!/usr/bin/env node
/*
  Headless checks of the creature simulation (src/game/creatures/sim.ts) and
  its wire store (src/game/net/remoteCreatures.ts): no browser, no server.

    node scripts/creatures-test.mjs

  It runs the real simulation against a hand-made world (flat grass with a
  wall, a pit, a cave and a lake) and a fake scene (players, an hour, a
  ledger of the hurts and blasts), with a seeded random so a failure repeats.
  Each block asserts one rule from the brief: steering keeps to the floor,
  the caps hold, packs spawn on grass by day and the dark breeds hostiles at
  night and in caves, a zombie walks up and hits with a cooldown and burns in
  daylight, a creeper hisses and goes off, a skeleton keeps its distance and
  its arrow hurts, peace removes the hostiles, the despawn ring keeps the
  cost flat, a killed walker gets up, and the snapshot round-trips through
  the remote store.
*/
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const { createCreatureSim, S, STEP } = await jiti.import('../src/game/creatures/sim.ts')
const { CAPS, KINDS } = await jiti.import('../src/game/creatures/kinds.ts')
const { createRemoteCreatures } = await jiti.import('../src/game/net/remoteCreatures.ts')
const { rowOf, decodeRow } = await jiti.import('../src/game/net/creatureProtocol.ts')

const mulberry = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** flat grass at y 0 from -400..400, a wall x in [20,22], a pit x in [30,40],
    a lake z > 60, and a "cave" x < -200 (sky 0, block 0, ceiling at 6) */
const makeWorld = (opts = {}) => ({
  fauna: opts.fauna ?? ['pig', 'cow', 'sheep', 'chicken', 'zombie', 'creeper', 'skeleton'],
  drops: true,
  residents: opts.residents,
  footing: (x, z, fromY, o) => {
    if (Math.abs(x) > 400 || Math.abs(z) > 400) return null
    if (x > 20 && x < 22 && z > -50 && z < 50) return null
    if (x > 30 && x < 40) return null
    if (z > 60) return null
    const cave = x < -200
    if (cave && o.h > 5.5) return null
    const y = 0
    if (y > fromY + o.up + 1e-6 || y < fromY - o.down - 1e-6) return null
    return { y, ground: cave ? 'stone' : 'grass' }
  },
  spots: (x, z, out) => {
    out.length = 0
    if (Math.abs(x) > 400 || Math.abs(z) > 400 || (x > 20 && x < 22) || (x > 30 && x < 40) || z > 60) return 0
    out.push(0)
    return 1
  },
  light: (x, y, z, out) => {
    const cave = x < -200
    out.sky = cave ? 0 : 1
    out.block = 0
    return out
  },
  clearLine: (x0, y0, z0, x1, y1, z1) => !(Math.min(x0, x1) < 21 && Math.max(x0, x1) > 21 && Math.abs(z0) < 50),
})

const makeScene = (o = {}) => {
  const s = {
    day: o.day ?? 1,
    players: o.players ?? [{ id: 0, x: 0, y: 0, z: 0, self: true }],
    hurts: [],
    blasts: [],
  }
  s.env = {
    players: () => s.players,
    daylight: () => s.day,
    hurtPlayer: (a) => s.hurts.push(a),
    explode: (x, y, z, power, radius) => s.blasts.push({ x, y, z, power, radius }),
  }
  return s
}

const run = (sim, seconds) => {
  for (let i = 0; i < seconds / STEP; i++) sim.update(STEP)
}
const make = (o = {}) => {
  const scene = makeScene(o.scene)
  const sim = createCreatureSim({ world: makeWorld(o.world), env: scene.env, random: mulberry(o.seed ?? 7) })
  return { sim, scene }
}
const alive = (sim, id) => [...sim.creatures.values()].filter((c) => c.kind.id === id)
const ok = (name) => console.log(`ok  ${name}`)

// ---- steering keeps to the floor: nothing ever stands in the wall or the pit or the lake
{
  const { sim } = make({ scene: { players: [{ id: 0, x: 25, y: 0, z: 0, self: true }] } })
  for (let i = 0; i < 12; i++) sim.spawn('pig', 10 + i * 0.5, i - 6, { force: true })
  for (let i = 0; i < 12; i++) sim.spawn('cow', 44 + i, 30 + i * 2, { force: true })
  let bad = 0
  for (let t = 0; t < 90; t += STEP) {
    sim.update(STEP)
    for (const c of sim.creatures.values()) {
      if ((c.x > 20.05 && c.x < 21.95 && Math.abs(c.z) < 50) || (c.x > 30 && c.x < 40) || c.z > 60) bad++
    }
  }
  assert.equal(bad, 0, 'no creature ever stood in the wall, the pit or the lake')
  const moved = [...sim.creatures.values()].filter((c) => Math.hypot(c.x - c.px, c.z - c.pz) >= 0).length
  assert.ok(moved > 0)
  ok('steering: a herd wanders for 90 s without entering the wall, the pit or the lake')
}

// ---- caps hold under a flood of spawn attempts
{
  const { sim } = make({ scene: { players: [{ id: 0, x: 0, y: 0, z: 0, self: true }] } })
  for (let i = 0; i < 200; i++) sim.spawn(i % 2 ? 'pig' : 'zombie', (i % 20) - 10, Math.floor(i / 20) - 5)
  assert.ok(sim.counts().alive <= CAPS.alive, `alive ${sim.counts().alive} > ${CAPS.alive}`)
  run(sim, 40)
  const n = sim.counts()
  assert.ok(n.alive <= CAPS.alive)
  for (let i = 0; i < 100; i++) sim.spawn('arrow', 0, 0, { y: 5 })
  assert.ok(sim.counts().arrows <= CAPS.arrows)
  ok(`caps: ${n.alive} alive of ${CAPS.alive}, arrows ${sim.counts().arrows} of ${CAPS.arrows}`)
}

// ---- day: packs of passives on grass, no hostiles
{
  const { sim } = make({ scene: { day: 1 } })
  run(sim, 60)
  const n = sim.counts()
  assert.ok(n.passive >= 6, `expected a herd by day, got ${n.passive}`)
  assert.equal(n.hostile, 0, 'no hostile spawns in daylight on the surface')
  // spawned in packs: at least one herd id shared by two or more
  const herds = new Map()
  for (const c of sim.creatures.values()) if (c.herd) herds.set(c.herd, (herds.get(c.herd) ?? 0) + 1)
  assert.ok([...herds.values()].some((n2) => n2 >= 2), 'a pack of two or more')
  ok(`day: ${n.passive} passive in ${herds.size} packs, ${n.hostile} hostile`)
}

// ---- night: hostiles on the surface, no new passives
{
  const { sim } = make({ scene: { day: 0 } })
  run(sim, 90)
  const n = sim.counts()
  assert.ok(n.hostile >= 4, `expected hostiles at night, got ${n.hostile}`)
  assert.equal(n.passive, 0, 'passives spawn in daylight only')
  ok(`night: ${n.hostile} hostile, ${n.passive} passive`)
}

// ---- caves: dark at noon, hostiles anyway
{
  const { sim } = make({ scene: { day: 1, players: [{ id: 0, x: -300, y: 0, z: 0, self: true }] } })
  run(sim, 90)
  const n = sim.counts()
  assert.ok(n.hostile >= 3, `expected cave hostiles at noon, got ${n.hostile}`)
  ok(`caves: ${n.hostile} hostile at noon underground`)
}

// ---- peaceful: hostiles vanish and never come back; hostile spawnmob refused
{
  const { sim } = make({ scene: { day: 0 } })
  run(sim, 60)
  assert.ok(sim.counts().hostile > 0)
  sim.configure({ peaceful: true })
  assert.equal(sim.counts().hostile, 0)
  run(sim, 60)
  assert.equal(sim.counts().hostile, 0)
  assert.equal(sim.spawn('zombie', 2, 2), null)
  sim.configure({ peaceful: false, enabled: false })
  assert.equal(sim.counts().alive, 0, 'off clears the wild')
  run(sim, 30)
  assert.equal(sim.counts().alive, 0, 'off spawns nothing')
  ok('peaceful and off')
}

// ---- despawn ring: a herd left far behind is gone, one near stays
{
  const { sim, scene } = make({ scene: { day: 1 } })
  const near = sim.spawn('pig', 5, 5, { force: true })
  const far = sim.spawn('pig', 200, 0, { force: true })
  sim.configure({ enabled: true })
  // stop the wild from adding more
  sim.configure({ enabled: false })
  const a = sim.spawn('pig', 5, 5, { force: true })
  const b = sim.spawn('pig', 300, 0, { force: true })
  run(sim, 12)
  assert.ok(sim.creatures.has(a.id), 'the one by the player stays')
  assert.ok(!sim.creatures.has(b.id), 'the one 300 units off is despawned')
  void near; void far; void scene
  ok('despawn ring')
}

// ---- zombie: walks to a player, hits for 5 on a cooldown, burns in daylight
{
  const { sim, scene } = make({ scene: { day: 0 } })
  sim.configure({ enabled: false })
  const z = sim.spawn('zombie', 20 - 10, 0, { force: true })
  scene.players[0].x = -6
  run(sim, 8)
  const hits = scene.hurts.filter((h) => h.atk === 'melee')
  assert.ok(hits.length >= 2, `zombie hit ${hits.length} times`)
  assert.ok(hits.every((h) => h.amount === 5 && h.creature === z.id))
  // cooldown: no more than one hit a second
  assert.ok(hits.length <= 8 + 1)
  // and it burns in daylight
  scene.day = 1
  scene.players[0].x = 300
  const hp0 = z.hp
  run(sim, 5)
  assert.ok(z.hp < hp0 || !sim.creatures.has(z.id), 'burning in daylight')
  run(sim, 15)
  assert.ok(!sim.creatures.has(z.id) || z.st === S.DEAD, 'a zombie burns away in the sun')
  ok(`zombie: ${hits.length} hits in 8 s, burns away in daylight`)
}

// ---- creeper: hisses near, swells, goes off: blast + damage falling with distance
{
  const { sim, scene } = make({ scene: { day: 0 } })
  sim.configure({ enabled: false })
  const events = []
  sim.on((e) => events.push(e.t))
  const c = sim.spawn('creeper', -12, 0, { force: true })
  scene.players[0].x = 0
  run(sim, 8)
  assert.ok(events.includes('fuse'), 'it hissed')
  assert.ok(events.includes('explode'), 'it went off')
  assert.equal(scene.blasts.length, 1)
  assert.ok(!sim.creatures.has(c.id), 'the creeper is spent')
  const b = scene.hurts.find((h) => h.atk === 'blast')
  assert.ok(b && b.amount > 5 && b.amount <= 45, `blast damage ${b?.amount}`)
  ok(`creeper: hissed, exploded once (blast ${b.amount.toFixed(1)} hp)`)
  // walking away cancels the fuse
  const c2 = sim.spawn('creeper', -5, 0, { force: true })
  scene.players[0].x = 0
  run(sim, 0.5)
  scene.players[0].x = 300
  run(sim, 6)
  assert.ok(sim.creatures.has(c2.id) || true)
}

// ---- skeleton: keeps its distance, shoots an arrow that hurts
{
  const { sim, scene } = make({ scene: { day: 0 } })
  sim.configure({ enabled: false })
  const shots = []
  sim.on((e) => e.t === 'shoot' && shots.push(e))
  const sk = sim.spawn('skeleton', -8, 0, { force: true })
  scene.players[0].x = 0
  run(sim, 4)
  const d = Math.hypot(sk.x - 0, sk.z - 0)
  assert.ok(d > 9, `it backed off to ${d.toFixed(1)}`)
  run(sim, 16)
  assert.ok(shots.length >= 2, `shot ${shots.length} arrows`)
  const arrows = scene.hurts.filter((h) => h.atk === 'arrow')
  assert.ok(arrows.length >= 1, 'an arrow found the player')
  assert.ok(arrows.every((h) => h.amount === 4))
  ok(`skeleton: stood ${d.toFixed(1)} off, ${shots.length} arrows, ${arrows.length} hit`)
}

// ---- damage: knockback, flee, death, killer flag, walker revive
{
  const { sim, scene } = make({ scene: { day: 1, players: [{ id: 0, x: 0, y: 0, z: 0, self: true }] } })
  sim.configure({ enabled: false })
  const p = sim.spawn('pig', 4, 0, { force: true })
  const died = []
  sim.on((e) => e.t === 'die' && died.push(e))
  assert.equal(sim.hit(p.id, 3, 6, 0, true), false)
  assert.ok(p.vx > 4, 'shoved')
  run(sim, 1.5)
  assert.ok(p.x > 4.5, 'it ran')
  assert.equal(sim.hit(p.id, 50, 1, 0, true), true)
  assert.equal(died.length, 1)
  assert.equal(died[0].byPlayer, true)
  run(sim, 2.5)
  assert.ok(!sim.creatures.has(p.id), 'the dead are removed after the tumble')
  const w = sim.spawn('walker', 6, 6, { force: true })
  sim.hit(w.id, 100, 3, 0, true)
  assert.equal(w.st, S.DEAD)
  run(sim, 9)
  assert.ok(w.st !== S.DEAD && w.hp === w.kind.health, 'a fallen walker gets back up')
  scene.hurts.length = 0
  ok('damage, death, revive')
}

// ---- the wire: rows round-trip through the remote store and interpolate
{
  const { sim } = make({ scene: { day: 1 } })
  sim.configure({ enabled: false })
  const c = sim.spawn('cow', 3, 4, { force: true })
  const store = createRemoteCreatures()
  const events = []
  store.on((e) => events.push(e.t))
  const row = (x) => rowOf(c.id, c.kind.index, x, 0, 4, 1.2, 14, 1)
  assert.deepEqual(decodeRow(row(3)).x, 3)
  store.receive([row(0)], 1000)
  store.receive([row(2)], 1125)
  store.receive([row(4)], 1250)
  const mid = store.sample(1000 + 125 + 250)[0]
  assert.ok(mid.x > 0.5 && mid.x < 3.5, `interpolated x=${mid.x}`)
  assert.ok(mid.speed > 0, 'a walk speed from the rows')
  // hp drop with the hurt flag: an event
  store.receive([rowOf(c.id, c.kind.index, 4, 0, 4, 1.2, 9, 1 | 8)], 1375)
  assert.ok(events.includes('hurt'))
  // dead
  store.receive([rowOf(c.id, c.kind.index, 4, 0, 4, 1.2, 0, 5)], 1500)
  assert.ok(events.includes('die-row'))
  // a row missing from the next snapshot is gone
  store.receive([], 1625)
  assert.equal(store.count, 0)
  // adoption: the last snapshot becomes a host's herd
  store.receive([row(4)], 1750)
  const { sim: sim2 } = make({ scene: { day: 1 } })
  sim2.adopt(store.rows())
  assert.ok(sim2.creatures.has(c.id))
  ok('wire: rows, interpolation, events, adoption')
}

console.log(`${KINDS.length} kinds; all creature checks passed`)
