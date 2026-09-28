/*
 * Real-socket checks for health.js: pvp is off by default and a shot at
 * somebody hurts nobody, turning it on makes the pistol worth twelve (a
 * headshot eighteen), a hit no shot paid for is worth nothing, the last hit
 * is a death with a killer, counters and a respawn (protected, whole), a
 * fall is believed only as far as the height it was seen from, a blast is
 * derived from the validated explosion and needs a rocket to have been
 * fired, the cheats refuse to work in a fight, and none of it leaks to
 * another level. Every "nothing happened" is followed by a message that does
 * something on the same path, which proves the earlier one was not merely
 * slow.
 */
import assert from 'node:assert/strict';

export async function healthSmoke(url, connect) {
  const peers = [];
  const join = async (level) => {
    const c = connect(url); peers.push(c); c.seen = [];
    c.ws.on('message', (data) => c.seen.push(JSON.parse(data.toString())));
    await c.opened; c.send({ type: 'hello' }); await c.nextOf('hello-ok', 'health hello');
    c.send({ type: 'world-join', level });
    c.id = (await c.nextOf('world-welcome', 'health welcome')).you;
    return c;
  };
  const move = (c, x, y = 0, f = 1) => c.send({ type: 'world-move', x, y, z: 0, yaw: 0, pitch: 0, gait: 0, f });
  const posed = async (c, id, x, y = 0) => {
    for (let i = 0; i < 30; i++) {
      const t = await c.nextOf('world-tick', 'a pose lands');
      if (t.players.some((r) => r[0] === id && r[1] === x && r[2] === y)) return;
    }
    throw new Error('the pose never landed');
  };
  /** the next hp row for `id`, from whichever hp message comes */
  const hpOf = async (c, id, label, want = () => true) => {
    for (let i = 0; i < 60; i++) {
      const m = await c.nextOf('world-hp', label);
      const row = m.rows.find((r) => r[0] === id && want(r));
      if (row) return row;
    }
    throw new Error(`no hp row for ${id} (${label})`);
  };
  const rowsFor = (c, id) => c.seen.filter((m) => m.type === 'world-hp').flatMap((m) => m.rows).filter((r) => r[0] === id);
  const shoot = (c, w, seq) => c.send({ type: 'world-shot', level: 'overworld', w, seq, o: [0, 4, 0], d: [1, 0, 0], ...(w === 0 ? { len: 5 } : {}) });
  const hit = (c, w, seq, victim, y = 2) => c.send({ type: 'world-shot-hit', level: 'overworld', w, seq, at: [5, y, 0], player: victim.id, v: [1, 0, 0] });
  try {
    const a = await join('overworld');
    const b = await join('overworld');
    const moon = await join('moon');
    move(a, 0); move(b, 5); move(moon, 0);
    await posed(a, b.id, 5);

    // pvp is off: a real, honest shot at b hurts nobody. The barrier is a's
    // own /hurt, whose row proves the tick that would have carried b's had run
    shoot(a, 0, 1); hit(a, 0, 1, b);
    a.send({ type: 'world-health-cmd', cmd: 'hurt', n: 5 });
    assert.deepEqual((await hpOf(b, a.id, 'a self-hurt is seen')).slice(1, 3), [95, 100]);
    assert.equal(rowsFor(b, b.id).length, 0, 'no damage between players while pvp is off');

    // turning it on tells the level, and the Moon hears nothing
    b.send({ type: 'world-health-cmd', cmd: 'pvp', on: true });
    const on = await a.nextOf('world-pvp', 'pvp announced');
    assert.deepEqual([on.on, on.by], [true, b.id]);

    // a pistol round is 12, a headshot 18, and a hit no shot paid for is 0
    shoot(a, 0, 2); hit(a, 0, 2, b);
    assert.equal((await hpOf(b, b.id, 'a body shot'))[1], 88);
    hit(a, 0, 3, b); // unbacked: the shot's credit is spent
    shoot(a, 0, 4); hit(a, 0, 4, b, 3.6);
    assert.equal((await hpOf(b, b.id, 'a headshot, after an unbacked hit that did nothing'))[1], 70);

    // the last hits are a death with a killer and counters
    for (let i = 0; i < 6; i++) { shoot(a, 0, 10 + i); hit(a, 0, 10 + i, b); }
    const death = await a.nextOf('world-death', 'b dies');
    assert.deepEqual([death.id, death.by, death.kind], [b.id, a.id, 'pistol']);
    assert.deepEqual(death.sc.map((r) => r.slice(0, 4)), [[b.id, 0, 1, 0], [a.id, 1, 0, 1]], 'a death for b, a kill and a point for a');
    // and comes back whole after the timer, protected for a moment
    const back = await b.nextOf('world-respawn', 'b respawns');
    assert.equal(back.id, b.id);
    const whole = await hpOf(b, b.id, 'whole again');
    assert.deepEqual([whole[1], whole[3] & 2], [100, 2], 'full hit points and the protected flag');

    // the cheats refuse in a fight
    b.send({ type: 'world-health-cmd', cmd: 'god', on: true });
    const no = await b.nextOf('world-health-no', 'god refused in pvp');
    assert.deepEqual([no.cmd, no.reason], ['god', 'pvp']);

    // a blast: derived from the validated position and falling off with
    // distance, and only from a rocket really fired. First the protection
    // wears off; then a free explosion (the console's) throws things and
    // hurts nobody, and a rocket's takes most of b's hit points
    await new Promise((r) => setTimeout(r, 2100));
    b.seen.length = 0;
    a.send({ type: 'world-prop-explosion', level: 'overworld', at: [2, 2, 0], power: 1, radius: 14 });
    a.send({ type: 'world-health-cmd', cmd: 'hurt', n: 1 });
    await hpOf(b, a.id, 'barrier after a free blast');
    assert.equal(rowsFor(b, b.id).filter((r) => r[1] < 100).length, 0, 'a free explosion hurts nobody');
    shoot(a, 2, 30);
    a.send({ type: 'world-prop-explosion', level: 'overworld', at: [2, 2, 0], power: 1, radius: 14 });
    const blasted = await hpOf(b, b.id, 'a rocket blast', (r) => r[1] < 100);
    assert.ok(blasted[1] >= 27 && blasted[1] <= 31, `about 90 * (1 - 3/14) off: ${blasted[1]}`);

    // pvp off again: the environment still hurts. A fall is believed only as
    // far as the drop we watched: 60 units/s from no height is a landing
    a.send({ type: 'world-health-cmd', cmd: 'pvp', on: false });
    await b.nextOf('world-pvp', 'pvp off');
    b.send({ type: 'world-fall', speed: 60 });
    b.send({ type: 'world-health-cmd', cmd: 'heal' });
    const healed = await hpOf(b, b.id, 'healed');
    assert.equal(healed[1], 100, 'an unbelievable fall did nothing, and heal works with pvp off');
    move(b, 5, 60, 0);
    await posed(a, b.id, 5, 60);
    move(b, 5, 0, 0);
    await posed(a, b.id, 5, 0);
    b.send({ type: 'world-fall', speed: 60 });
    assert.ok((await hpOf(b, b.id, 'a real fall'))[1] <= 20, 'a sixty-unit drop at speed 60 leaves a sliver');

    // /kill works anywhere and is a death with no killer
    b.send({ type: 'world-health-cmd', cmd: 'kill' });
    const dead = await a.nextOf('world-death', 'kill');
    assert.deepEqual([dead.id, dead.by, dead.kind], [b.id, 0, 'kill']);

    // none of it reached the Moon
    assert.equal(moon.seen.filter((m) => m.type === 'world-hp' || m.type === 'world-death' || m.type === 'world-pvp').length, 0);
    console.log('health: pvp gate, pistol and headshot damage, unbacked hits, death and credit, respawn and protection, blast falloff, fall sanity, cheats, level isolation');
  } finally { for (const c of peers) c.ws.close(); }
}

/*
 * Health is built per room (buildRoom's `room.health`): pvp switched on in a
 * private room does not hurt anybody in the public room on the very same
 * level, a kill there does not appear on the public scoreboard, and the
 * counters of the two rooms are separate.
 */
export async function healthRoomsSmoke(url, connect) {
  const peers = [];
  const join = async (room) => {
    const c = connect(url); peers.push(c); c.seen = [];
    c.ws.on('message', (data) => c.seen.push(JSON.parse(data.toString())));
    await c.opened; c.send({ type: 'hello' }); await c.nextOf('hello-ok', 'health-rooms hello');
    c.send({ type: 'world-join', level: 'overworld', ...(room ? { room, create: true } : {}) });
    c.id = (await c.nextOf('world-welcome', 'health-rooms welcome')).you;
    return c;
  };
  const move = (c, x) => c.send({ type: 'world-move', x, y: 0, z: 0, yaw: 0, pitch: 0, gait: 0, f: 1 });
  const posed = async (c, id, x) => {
    for (let i = 0; i < 30; i++) {
      const t = await c.nextOf('world-tick', 'a pose lands');
      if (t.players.some((r) => r[0] === id && r[1] === x)) return;
    }
    throw new Error('the pose never landed');
  };
  const hpMsgs = (c) => c.seen.filter((m) => m.type === 'world-hp');
  const shoot = (c, seq) => c.send({ type: 'world-shot', level: 'overworld', w: 0, seq, o: [0, 4, 0], d: [1, 0, 0], len: 5 });
  const hit = (c, seq, victim) => c.send({ type: 'world-shot-hit', level: 'overworld', w: 0, seq, at: [5, 2, 0], player: victim.id, v: [1, 0, 0] });
  try {
    const a = await join('HPROOM');
    const b = await join('HPROOM');
    const p1 = await join(undefined);
    const p2 = await join(undefined);
    move(a, 0); move(b, 5); move(p1, 0); move(p2, 5);
    await posed(a, b.id, 5);
    await posed(p1, p2.id, 5);

    // pvp on in the room only: announced there, silent in the public room
    a.send({ type: 'world-health-cmd', cmd: 'pvp', on: true });
    assert.equal((await b.nextOf('world-pvp', 'room pvp on')).on, true);

    // the public pair fire and hit with pvp off: nothing lands. The barrier
    // is p1's own /hurt, whose row proves the tick that would carry p2's ran
    shoot(p1, 1); hit(p1, 1, p2);
    p1.send({ type: 'world-health-cmd', cmd: 'hurt', n: 5 });
    for (let i = 0; i < 60; i++) {
      const m = await p2.nextOf('world-hp', 'public barrier');
      if (m.rows.some((r) => r[0] === p1.id)) break;
    }
    assert.equal(hpMsgs(p2).flatMap((m) => m.rows).filter((r) => r[0] === p2.id && r[1] < 100).length, 0, 'pvp in another room hurts nobody here');
    assert.equal(p1.seen.filter((m) => m.type === 'world-pvp').length, 0, 'the public room never hears the room pvp');

    // and in the room the same shots do land, all the way to a death
    for (let i = 0; i < 9; i++) { shoot(a, 10 + i); hit(a, 10 + i, b); }
    const death = await a.nextOf('world-death', 'room death');
    assert.deepEqual([death.id, death.by, death.kind], [b.id, a.id, 'pistol']);
    assert.deepEqual(death.sc.map((r) => r.slice(0, 4)).sort((x, y) => x[0] - y[0]), [[b.id, 0, 1, 0], [a.id, 1, 0, 1]].sort((x, y) => x[0] - y[0]), 'the room counts its own kill');
    assert.equal(p1.seen.filter((m) => m.type === 'world-death').length, 0, 'the public room saw no death');

    // a public death has its own scoreboard: one death, and none of the room's rows
    p2.send({ type: 'world-health-cmd', cmd: 'kill' });
    const pubDeath = await p1.nextOf('world-death', 'public death');
    assert.deepEqual(pubDeath.sc.map((r) => r[0]).sort(), [p2.id].sort(), 'only the public victim is on the public board');
    assert.deepEqual(pubDeath.sc[0].slice(1, 3), [0, 1]);
    assert.equal(a.seen.filter((m) => m.type === 'world-death' && m.id === p2.id).length, 0, 'the room never sees the public death');
    console.log('health per room: pvp, damage, deaths and counters stay inside their own room');
  } finally { for (const c of peers) c.ws.close(); }
}
