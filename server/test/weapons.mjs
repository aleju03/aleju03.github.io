/*
 * Real-socket checks for the weapons' relay (src/weapons.js): what is held
 * reaches the level and a late arrival, a shot reaches the level and not the
 * Moon, a shot from somewhere the shooter is not is dropped, the trigger is
 * rate-limited, a hit on a player carries a clamped velocity (and none for a
 * flyer), a push on a prop is clamped, and a hit out of reach is dropped.
 * Each refusal is followed by a valid message on the same path, which is
 * the barrier that proves nothing got through before it.
 */
import assert from 'node:assert/strict';

export async function weaponsSmoke(url, connect) {
  const peers = [];
  const join = async (level) => {
    const c = connect(url); peers.push(c); c.seen = [];
    c.ws.on('message', (data) => c.seen.push(JSON.parse(data.toString())));
    await c.opened; c.send({ type: 'hello' }); await c.nextOf('hello-ok', 'weapons hello');
    c.send({ type: 'world-join', level });
    c.id = (await c.nextOf('world-welcome', 'weapons welcome')).you;
    return c;
  };
  const move = (c, x, f = 1) => c.send({ type: 'world-move', x, y: 0, z: 0, yaw: 0, pitch: 0, gait: 0, f });
  // ticks until one shows player `id` at x with flags f (poses are recorded
  // by then, whatever the ticker's phase was when they were sent)
  const posed = async (c, id, x, f = 1) => {
    for (let i = 0; i < 30; i++) {
      const t = await c.nextOf('world-tick', 'a pose lands');
      if (t.players.some((r) => r[0] === id && r[1] === x && r[7] === f)) return;
    }
    throw new Error('the pose never landed');
  };
  const count = (c, type) => c.seen.filter((m) => m.type === type).length;
  try {
    const a = await join('overworld');
    const b = await join('overworld');
    const moon = await join('moon');
    move(a, 0); move(b, 5); move(moon, 0);
    await posed(a, b.id, 5);

    // what is held reaches the level, and a late arrival's snapshot
    a.send({ type: 'world-wield', w: 2 });
    const held = await b.nextOf('world-wield', 'a wield reaches the level');
    assert.deepEqual([held.id, held.w], [a.id, 2]);
    const late = await join('overworld');
    assert.deepEqual((await late.nextOf('world-wields', 'the snapshot')).wields, [[a.id, 2]], 'a late arrival is told who holds what');

    // a pistol shot: relayed with the shooter, normalized and rounded
    a.send({ type: 'world-shot', level: 'overworld', w: 0, seq: 1, o: [0, 4, 0], d: [2, 0, 0], len: 20.004 });
    const shot = await b.nextOf('world-shot', 'a pistol shot');
    assert.equal(shot.id, a.id);
    assert.deepEqual(shot.d, [1, 0, 0], 'the direction arrives unit length');
    assert.equal(shot.len, 20, 'rounded like everything else');
    // from somewhere the shooter is not: dropped (the next one is the barrier)
    a.send({ type: 'world-shot', level: 'overworld', w: 0, seq: 2, o: [300, 4, 0], d: [1, 0, 0], len: 5 });
    a.send({ type: 'world-shot', level: 'overworld', w: 0, seq: 3, o: [1, 4, 0], d: [1, 0, 0], len: 5 });
    assert.equal((await b.nextOf('world-shot', 'barrier')).seq, 3, 'a shot from 300 units off is dropped');
    // the crossbow is three a second
    for (let i = 0; i < 5; i++) a.send({ type: 'world-shot', level: 'overworld', w: 1, seq: 10 + i, o: [0, 4, 0], d: [0, 0, -1] });

    // a hit on a player: the velocity is clamped for their own client
    a.send({ type: 'world-shot-hit', level: 'overworld', w: 1, seq: 10, at: [5, 2, 0], d: [1, 0, 0], player: b.id, v: [40, 4, 0] });
    const hit = await b.nextOf('world-shot-hit', 'a bolt in a player');
    assert.equal(hit.player, b.id);
    assert.deepEqual(hit.v, [24, 4, 0], 'clamped to the shove ceiling');
    assert.equal(b.seen.filter((m) => m.type === 'world-shot' && m.w === 1).length, 3, 'three crossbow shots a second');
    // a prop's push is clamped, a bolt's frame is kept
    a.send({ type: 'world-shot-hit', level: 'overworld', w: 1, seq: 11, at: [3, 1, 0], prop: 7, fr: [0, 0.5, 0.2, 0, 0, 0, 1], imp: [3000, 0, 0] });
    const pushed = await b.nextOf('world-shot-hit', 'a bolt in a prop');
    assert.deepEqual(pushed.imp, [2000, 0, 0]);
    assert.deepEqual(pushed.fr, [0, 0.5, 0.2, 0, 0, 0, 1]);
    // out of reach: dropped
    a.send({ type: 'world-shot-hit', level: 'overworld', w: 0, seq: 3, at: [900, 0, 0] });
    a.send({ type: 'world-shot-hit', level: 'overworld', w: 0, seq: 3, at: [6, 0, 0] });
    assert.deepEqual((await b.nextOf('world-shot-hit', 'barrier')).at, [6, 0, 0], 'a hit 900 units off is dropped');
    // a flyer is not shoved, but everybody still sees where it landed
    move(b, 5, 64);
    await posed(a, b.id, 5, 64);
    a.send({ type: 'world-shot-hit', level: 'overworld', w: 0, seq: 4, at: [5, 2, 0], player: b.id, v: [3, 0, 0] });
    const flyer = await b.nextOf('world-shot-hit', 'a round at a flyer');
    assert.equal(flyer.player, b.id);
    assert.equal(flyer.v, undefined, 'no velocity for somebody flying');

    // nothing of it reached the Moon, and nothing came back to the shooter
    assert.equal(count(moon, 'world-shot') + count(moon, 'world-shot-hit') + count(moon, 'world-wield'), 0);
    assert.equal(count(a, 'world-shot') + count(a, 'world-shot-hit'), 0);
    // walking to the Moon takes the gun there
    a.send({ type: 'world-level', level: 'moon' });
    const arrived = await moon.nextOf('world-wield', 'a gun walks in');
    assert.deepEqual([arrived.id, arrived.w], [a.id, 1], 'the last weapon fired is the one in hand');
    const left = await b.nextOf('world-wield', 'and out');
    assert.deepEqual([left.id, left.w], [a.id, -1]);
    console.log('weapons: wields and snapshots, shots relayed and filtered by level, origin and rate checks, clamped hits, flyers not shoved');
  } finally { for (const c of peers) c.ws.close(); }
}
