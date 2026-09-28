/*
 * World damage: the union of lost building pieces and felled props per
 * level, the snapshot a late arrival gets instead of a replay of every bang,
 * and the relayed blows. Later messages on the same socket are the ordering
 * barriers, so "nothing arrived" assertions do not depend on timing.
 */
import assert from 'node:assert/strict';
import { createWorldDamage, MAX_BUILDINGS, MAX_KEYS } from '../src/worldDamage.js';

const B = '1,-2:B30,-44';

function bounds() {
  let t = 0;
  const ws = { world: { id: 1, level: 'caps', x: 0, y: 0, z: 0 } };
  const players = new Map([[1, ws]]), out = [];
  const d = createWorldDamage({ players, send: (_, m) => out.push(m), now: () => t });
  for (let i = 0; i < MAX_BUILDINGS + 10; i++) {
    t += 1000; // one a second, clear of the rate limit
    d.handle(ws, { type: 'world-ruin', level: 'caps', b: `0,${i}:B1,1`, keys: [1] });
  }
  d.snapshot(ws);
  let snap = out.at(-1);
  assert.equal(snap.ruins.length, MAX_BUILDINGS, 'buildings are capped per level');
  assert.equal(snap.ruins[0][0], '0,10:B1,1', 'the oldest ruins are forgotten first');
  const keys = Array.from({ length: 1024 }, (_, i) => i);
  for (let n = 0; n < 5; n++) {
    t += 1000;
    d.handle(ws, { type: 'world-ruin', level: 'caps', b: B, keys: keys.map((k) => k + n * 1024) });
  }
  d.snapshot(ws);
  snap = out.at(-1);
  assert.equal(snap.ruins.find(([b]) => b === B)[1].length, MAX_KEYS, 'pieces are capped per building');
  // a level nobody stands in is forgotten after the empty clock runs out
  players.clear();
  d.left('caps');
  t += 16 * 60 * 1000;
  players.set(1, ws);
  d.snapshot(ws);
  assert.equal(out.at(-1).ruins.length, 0, 'an empty level expires');
}

export async function damageSmoke(url, connect) {
  bounds();
  const peers = [];
  const join = async (level) => {
    const c = connect(url); peers.push(c); c.seen = [];
    c.ws.on('message', (data) => c.seen.push(JSON.parse(data.toString())));
    await c.opened; c.send({ type: 'hello' }); await c.nextOf('hello-ok', 'damage hello');
    c.send({ type: 'world-join', level });
    c.id = (await c.nextOf('world-welcome', 'damage welcome')).you;
    c.snapshot = await c.nextOf('world-ruins', 'initial ruins');
    return c;
  };
  const tx = (c, m) => c.send({ level: 'dmg-test', ...m });
  const seen = (c, type) => c.seen.filter((m) => m.type === type);
  try {
    const a = await join('dmg-test'), b = await join('dmg-test');
    assert.deepEqual(a.snapshot.ruins, []);
    assert.deepEqual(a.snapshot.felled, []);

    // the union: only what is new is passed on, never back to the sender
    tx(a, { type: 'world-ruin', b: B, keys: [5, 6] });
    assert.deepEqual((await b.nextOf('world-ruin', 'first pieces')).keys, [5, 6]);
    tx(a, { type: 'world-ruin', b: B, keys: [6, 7] });
    assert.deepEqual((await b.nextOf('world-ruin', 'new pieces only')).keys, [7]);
    tx(b, { type: 'world-ruin', b: B, keys: [5, 7] });
    tx(a, { type: 'world-ruin', b: 'nope', keys: [1] });
    tx(a, { type: 'world-ruin', b: B, keys: [-1] });
    tx(a, { type: 'world-ruin', b: B, keys: [1.5] });
    tx(a, { type: 'world-ruin', level: 'moon', b: B, keys: [9] });
    tx(b, { type: 'world-ruin', b: B, keys: [8] });
    assert.deepEqual((await a.nextOf('world-ruin', 'barrier')).keys, [8], 'duplicates, bad ids and keys and other levels are dropped');
    assert.equal(seen(a, 'world-ruin').length, 1);
    assert.equal(seen(b, 'world-ruin').length, 2, 'the sender never hears its own report');

    // felled props: stored once, direction normalised
    tx(a, { type: 'world-fell', id: '3,4:L63:11', dir: [3, 4], speed: 99 });
    const fell = await b.nextOf('world-fell', 'felled');
    assert.deepEqual(fell.dir, [0.6, 0.8]);
    assert.equal(fell.speed, 60);
    tx(b, { type: 'world-fell', id: '3,4:L63:11', dir: [1, 0], speed: 10 });
    tx(b, { type: 'world-fell', id: '3,4:S7', dir: [0, 0], speed: 12 });
    const quiet = await a.nextOf('world-fell', 'second felled');
    assert.equal(quiet.id, '3,4:S7', 'a prop is felled once');
    assert.equal(quiet.speed, 0, 'no direction, no throw');

    // relayed blows: clamped, from the sender, and only near it
    const blow = { type: 'world-damage', b: B, how: 'vehicle', at: [10, 2, 10], power: 9999, radius: 99, dir: [1, 0, 0], k: 5, ram: false, seed: 42 };
    tx(a, blow);
    const got = await b.nextOf('world-damage', 'blow');
    assert.equal(got.from, a.id);
    assert.equal(got.power, 1500);
    assert.equal(got.radius, 40);
    tx(a, { ...blow, at: [5000, 2, 0], seed: 1 });
    tx(a, { ...blow, how: 'blast', seed: 2 });
    tx(a, { ...blow, seed: 3 });
    assert.equal((await b.nextOf('world-damage', 'blow barrier')).seed, 3, 'far blows and blasts are not relayed');
    for (let i = 0; i < 70; i++) tx(a, { ...blow, seed: 100 + i });
    tx(a, { type: 'world-ruin', b: B, keys: [99] });
    while ((await b.next('rate barrier')).type !== 'world-ruin');
    const burst = seen(b, 'world-damage').filter((m) => m.seed >= 100).length;
    assert.ok(burst > 0 && burst <= 60, 'blows are rate limited');

    // a late arrival gets the end state, not the bangs
    const late = await join('dmg-test');
    const ruin = late.snapshot.ruins.find(([id]) => id === B);
    assert.deepEqual(ruin[1].sort((x, y) => x - y), [5, 6, 7, 8, 99]);
    assert.deepEqual(late.snapshot.felled.sort(), ['3,4:L63:11', '3,4:S7']);
    assert.equal(seen(late, 'world-damage').length, 0);
    // ...and a level change is a fresh snapshot of that level
    late.send({ type: 'world-level', level: 'moon' });
    assert.equal((await late.nextOf('world-ruins', 'moon ruins')).ruins.length, 0);
    late.send({ type: 'world-level', level: 'dmg-test' });
    assert.equal((await late.nextOf('world-ruins', 'back again')).ruins.length, 1);
    console.log('damage: union of lost pieces and felled props, validation, relayed blows, rate limits, caps, expiry and late-join snapshots passed');
  } finally {
    for (const c of peers) c.ws.close();
  }
}
