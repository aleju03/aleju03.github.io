/*
 * The creative props, headless: balloons that lift (and how many it takes),
 * popping, dynamite's five-second fuse and its chain, paint and the sign
 * tile pool, and two clients plus a late joiner agreeing on a tag through the
 * real server registry (the same delivery queue prop-sync.js uses).
 *
 *   npm run measure -- creative
 */
import assert from 'node:assert/strict'
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { createPropNetwork } from '../../src/game/net/remoteProps.ts'
import { createPropRegistry } from '../../server/src/props.js'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { creativeOf } from '../../src/game/sandbox/creative/creative.ts'
import { PALETTE, SIGN_MAX, cleanSign, decodeTag, encodeTag } from '../../src/game/sandbox/creative/tags.ts'
import { acquireTile, releaseTile, POOL } from '../../src/game/sandbox/creative/signs.ts'

const flat = { heightAt: () => 0, lattice: () => 0 }
const make = async () => {
  const sb = createSandbox({ collision: makeCollisionSet({ minX: -500, maxX: 500, minZ: -500, maxZ: 500 }), walker: false, ground: flat })
  await sb.whenReady
  return sb
}
const run = (sb, seconds) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) sb.tick({ dt: 1 / 60, active: true, focus: { x: 0, y: 5, z: 0 } })
}
const y = (sb, id) => sb.get(id)?.body.translation().y ?? NaN

/* ---------------------------------------------------------------- tags -- */
{
  assert.equal(cleanSign('  hello   \t world\n'), 'hello world')
  assert.equal(cleanSign('a\u0007b'), 'ab')
  assert.equal(cleanSign('x'.repeat(80)).length, SIGN_MAX)
  assert.equal(cleanSign('¡Ñandú!'), '¡Ñandú!')
  assert.equal(cleanSign('日本'), '')
  const tag = encodeTag({ paint: 4, off: true, text: 'OPEN 24H' })
  assert.deepEqual(decodeTag(tag), { paint: 4, off: true, text: 'OPEN 24H' })
  assert.equal(encodeTag({ paint: 0, off: false, text: '' }), null)
  assert.equal(PALETTE.length, 12)
  console.log('tags: filter, round trip and defaults ok')
}

/* ------------------------------------------------------- the tile pool -- */
{
  const tiles = []
  for (let i = 0; i < POOL; i++) tiles.push(acquireTile(`sign ${i}`))
  assert.equal(new Set(tiles).size, POOL, 'each different text gets its own tile')
  assert.equal(acquireTile('one too many'), -1, 'a full pool shows the blank board rather than steal a tile')
  assert.equal(acquireTile('sign 3'), tiles[3], 'the same text shares its tile')
  releaseTile(tiles[3])
  releaseTile(tiles[3])
  assert.notEqual(acquireTile('now there is room'), -1, 'a released tile is reusable')
  console.log(`signs: ${POOL} tiles, shared by text, full pool falls back to blank`)
}

/* ------------------------------------------------------------ balloons -- */
{
  const rows = []
  for (const [kind, n] of [['crate_small', 1], ['crate_small', 2], ['crate', 1], ['crate', 2], ['crate', 3], ['crate', 4], ['crate', 6]]) {
    const sb = await make()
    const cr = creativeOf(sb)
    const id = sb.spawn(kind, { x: 0, y: 2, z: 0 })
    run(sb, 1)
    const y0 = y(sb, id)
    for (let i = 0; i < n; i++) {
      const p = sb.get(id).body.translation()
      const made = cr.tie(id, { x: p.x + (i - n / 2) * 0.4, y: p.y + 0.5, z: p.z }, 1 + (i % 12))
      assert.ok(made, 'tie')
    }
    run(sb, 6)
    rows.push({ kind, balloons: n, rose: +(y(sb, id) - y0).toFixed(1) })
    sb.dispose()
  }
  console.log('balloons: height gained in six seconds')
  for (const r of rows) console.log(`  ${r.kind.padEnd(12)} x${r.balloons}: ${r.rose > 1 ? 'lifts' : 'stays'} (${r.rose})`)
  const at = (k, n) => rows.find((r) => r.kind === k && r.balloons === n).rose
  assert.ok(at('crate_small', 1) > 4, 'one balloon lifts a small crate')
  assert.ok(at('crate', 1) < 1, 'one balloon does not lift a big crate')
  assert.ok(at('crate', 2) < 1, 'two do not')
  assert.ok(at('crate', 3) > 4, 'three lift a crate')
  assert.ok(at('crate', 6) > at('crate', 3), 'more balloons are faster')

  // pop: a blow takes the balloon and its rope, and the crate drops
  const sb = await make()
  const cr = creativeOf(sb)
  const id = sb.spawn('crate_small', { x: 0, y: 2, z: 0 })
  run(sb, 0.5)
  const made = cr.tie(id, { x: 0, y: 2.5, z: 0 }, 3)
  run(sb, 2)
  const high = y(sb, id)
  assert.ok(high > 3)
  sb.damage(made.balloon, 50)
  run(sb, 0.2)
  assert.equal(sb.get(made.balloon), undefined, 'a shot pops it')
  run(sb, 2)
  assert.ok(y(sb, id) < high, 'and the crate comes down')
  assert.equal(creativeOf(sb).balloons, 0)
  console.log('balloons: pop releases the crate')
}

/* ------------------------------------------------------------ dynamite -- */
{
  const sb = await make()
  const cr = creativeOf(sb)
  const blasts = []
  sb.onExplosion((e) => blasts.push(e))
  const d = sb.spawn('dynamite', { x: 0, y: 0.5, z: 0 })
  const barrel = sb.spawn('barrel_explosive', { x: 6, y: 1.2, z: 0 })
  run(sb, 1)
  assert.equal(cr.verb(d, 'en'), 'light the fuse')
  assert.equal(cr.use(d), 'fuse')
  assert.equal(cr.verb(d, 'en'), null, 'a lit fuse cannot be lit again')
  run(sb, 4.7)
  assert.ok(sb.get(d), 'still there at 4.7 s')
  assert.equal(blasts.length, 0)
  run(sb, 0.6)
  assert.equal(sb.get(d), undefined, 'gone by 5.3 s')
  assert.equal(blasts.length >= 1, true)
  assert.equal(blasts[0].power, 2)
  const first = blasts[0]
  run(sb, 3)
  assert.equal(sb.get(barrel), undefined, 'the barrel beside it goes too')
  console.log(`dynamite: fuse 5 s, blast power ${first.power} radius ${first.radius}, chain took the barrel (${blasts.length} blasts)`)
}

/* -------------------------------------------------- two clients + late -- */
{
  let time = 0
  const players = new Map()
  const inbound = []
  const outbound = []
  const registry = createPropRegistry({ players, now: () => time, send: (ws, m) => inbound.push([ws, structuredClone(m)]) })
  const client = async (id) => {
    const sb = await make()
    const ws = { world: { id, level: 'test', x: 0, y: 0, z: 0 }, nick: `player${id}` }
    // an unprotected room: the social mirror says yes to everybody
    const net = createPropNetwork((m) => outbound.push([ws, structuredClone(m)]), () => {}, () => time, { may: () => true })
    ws.net = net
    players.set(id, ws)
    net.attach(sb, 'test')
    net.receive({ type: 'world-welcome', you: id, tick: 66, slot: 0, players: [] })
    registry.join(ws)
    return { sb, ws, net }
  }
  const flush = () => {
    let guard = 0
    while (outbound.length || inbound.length) {
      assert.ok(++guard < 10000)
      while (outbound.length) { const [ws, m] = outbound.shift(); registry.handle(ws, m) }
      while (inbound.length) { const [ws, m] = inbound.shift(); ws.net.receive(m) }
    }
  }
  const step = (c, n) => {
    for (let i = 0; i < n; i++) {
      time += 1000 / 60
      for (const k of c) k.sb.tick({ dt: 1 / 60, active: true, focus: { x: 0, y: 5, z: 0 } })
      flush()
      registry.tick()
      flush()
    }
  }
  const a = await client(1)
  const b = await client(2)
  flush()
  const netProps = (c, kind) => { const l = []; c.sb.forEach((p) => { if (p.data.net && p.kind.id === kind) l.push(p) }); return l }
  const crate = a.sb.spawn('crate', { x: 0, y: 3, z: 0 })
  const lamp = a.sb.spawn('lamp', { x: 4, y: 3, z: 0 })
  const sign = a.sb.spawn('sign', { x: -4, y: 3, z: 0 })
  step([a, b], 30)
  assert.equal(netProps(b, 'crate').length, 1)
  // b paints a's crate, switches a's lamp off and writes on a's sign
  const bCrate = netProps(b, 'crate')[0]
  creativeOf(b.sb).paint(bCrate.id, 7)
  const bLamp = netProps(b, 'lamp')[0]
  creativeOf(b.sb).use(bLamp.id)
  const bSign = netProps(b, 'sign')[0]
  creativeOf(b.sb).write(bSign.id, 'Hello  from B')
  step([a, b], 30)
  assert.equal(creativeOf(a.sb).tagOf(crate).paint, 7, 'paint reached the owner')
  {
    // with protection on, the mirror says no: the edit is refused at the source
    const before = creativeOf(b.sb).rawTag(bCrate.id)
    const buzzed = []
    const was = b.sb.network
    b.sb.network = { ...was, may: () => false, denied: (id) => buzzed.push(id) }
    assert.equal(creativeOf(b.sb).paint(bCrate.id, 3), false, 'a protected prop cannot be painted')
    assert.equal(creativeOf(b.sb).use(bLamp.id), null, 'nor a lamp switched')
    assert.equal(creativeOf(b.sb).write(bSign.id, 'no'), null, 'nor a sign written')
    assert.deepEqual(creativeOf(b.sb).rawTag(bCrate.id), before)
    assert.equal(buzzed.length, 3, 'each refusal buzzes')
    b.sb.network = was
  }
  assert.equal(creativeOf(a.sb).tagOf(lamp).off, true, 'the lamp switch reached the owner')
  assert.equal(creativeOf(a.sb).tagOf(sign).text, 'Hello from B', 'the sign text reached the owner')
  assert.equal(a.sb.get(lamp).data.lampOn, false)
  // a late joiner is told all three by the snapshot
  const c = await client(3)
  step([a, b, c], 40)
  const cc = netProps(c, 'crate')[0]
  assert.equal(creativeOf(c.sb).tagOf(cc.id).paint, 7, 'late joiner sees the paint')
  assert.equal(creativeOf(c.sb).tagOf(netProps(c, 'lamp')[0].id).off, true, 'late joiner sees the lamp off')
  assert.equal(creativeOf(c.sb).tagOf(netProps(c, 'sign')[0].id).text, 'Hello from B', 'late joiner sees the sign text')
  // a's own later edit wins over the old echo
  creativeOf(a.sb).paint(crate, 2)
  creativeOf(a.sb).paint(crate, 5)
  step([a, b, c], 40)
  assert.equal(creativeOf(b.sb).tagOf(bCrate.id).paint, 5)
  assert.equal(creativeOf(c.sb).tagOf(cc.id).paint, 5)
  // a balloon spawned with a random colour reaches everyone with it
  const balloon = a.sb.spawn('balloon', { x: 0, y: 3, z: 6 })
  step([a, b, c], 40)
  const mine = creativeOf(a.sb).tagOf(balloon).paint
  assert.ok(mine >= 1 && mine <= 12)
  assert.equal(creativeOf(b.sb).tagOf(netProps(b, 'balloon')[0].id).paint, mine, 'balloon colour is shared')
  console.log('network: paint, lamp switch and sign text reach the second client and a late joiner; a later local edit is not overwritten by an old echo')
}
console.log('creative: all checks passed')
