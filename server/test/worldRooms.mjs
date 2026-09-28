/*
 * Rooms (worldRooms.js): two players in different rooms are strangers, two in
 * one room are not. Everything is asserted over real sockets, with later
 * messages on the same socket as ordering barriers so "nothing arrived" never
 * depends on timing. The server is started with WORLD_ROOM_GRACE_MS=300 and
 * WORLD_ROOM_MAX_PLAYERS=3 (see smoke.mjs) so death and fullness are cheap.
 */
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function roomsSmoke(url, connect) {
  const socks = [];
  const open = async () => {
    const c = connect(url);
    socks.push(c);
    c.seen = [];
    c.ws.on('message', (d) => c.seen.push(JSON.parse(d.toString())));
    await c.opened;
    c.send({ type: 'hello' });
    await c.nextOf('hello-ok', 'rooms hello');
    return c;
  };
  const join = async (room, { create = false, level = 'overworld' } = {}) => {
    const c = await open();
    c.send({ type: 'world-join', level, ...(room ? { room, create } : {}) });
    c.welcome = await c.nextOf('world-welcome', `welcome ${room}`);
    c.id = c.welcome.you;
    return c;
  };
  const errorOf = async (room, opts = {}) => {
    const c = await open();
    c.send({ type: 'world-join', level: 'overworld', room, ...opts });
    const e = await c.nextOf('error', `error ${room}`);
    return { c, e };
  };
  // a round trip through a socket that has seen everything sent before it
  const barrier = async (c) => {
    c.send({ type: 'world-chat', text: `barrier-${Math.random()}` });
    let m;
    do m = await c.nextOf('world-chat', 'barrier'); while (!String(m.text).startsWith('barrier-') || m.id !== c.id);
    return m;
  };
  const count = (c, type) => c.seen.filter((m) => m.type === type).length;
  try {
    const a = await join('AMBER7', { create: true });
    assert.equal(a.welcome.room, 'AMBER7');
    assert.deepEqual(a.welcome.players, [], 'a fresh private room is empty');
    const pub = await join(undefined);
    assert.equal(pub.welcome.room, 'public');
    assert.ok(!pub.welcome.players.some((p) => p.id === a.id), 'public does not list the private player');
    const c = await join('amber7'); // codes are case-insensitive, and joining needs no create flag
    assert.equal(c.welcome.room, 'AMBER7');
    assert.deepEqual(c.welcome.players.map((p) => p.id), [a.id], 'same room sees each other');
    assert.equal((await a.nextOf('world-enter', 'a sees c')).player.id, c.id);

    // ticks: only room members appear in a room's snapshots
    a.send({ type: 'world-move', x: 5, y: 1, z: 6, yaw: 0, pitch: 0, gait: 0, f: 1 });
    let tick;
    do tick = await c.nextOf('world-tick', 'c tick'); while (!tick.players.some((r) => r[0] === a.id));
    await sleep(200);
    assert.ok(pub.seen.filter((m) => m.type === 'world-tick').every((t) => t.players.every((r) => r[0] === pub.id)), 'public ticks carry only public players');

    // chat
    a.send({ type: 'world-chat', text: 'secret hello' });
    assert.equal((await c.nextOf('world-chat', 'c chat')).text, 'secret hello');
    await barrier(pub);
    assert.ok(!pub.seen.some((m) => m.type === 'world-chat' && m.text === 'secret hello'), 'chat stays in the room');

    // signalling to a player in another room is dropped
    a.send({ type: 'world-signal', to: pub.id, data: { kind: 'offer' } });
    c.send({ type: 'world-signal', to: a.id, data: { kind: 'offer' } });
    assert.equal((await a.nextOf('world-signal', 'in-room signal')).from, c.id);
    await barrier(pub);
    assert.equal(count(pub, 'world-signal'), 0, 'signals do not cross rooms');

    // props: spawned in the room, invisible outside, in the snapshot for a late joiner
    a.send({ type: 'world-prop-spawn', level: 'overworld', nonce: 1, kind: 'crate', scale: 1, pose: [0, 1, 100, 300, 200, 0, 0, 0, 10000, 1] });
    const spawned = await c.nextOf('world-prop-spawn', 'c sees prop');
    await barrier(pub);
    assert.equal(count(pub, 'world-prop-spawn'), 0, 'props do not cross rooms');

    // damage
    a.send({ type: 'world-ruin', level: 'overworld', b: '1,-2:B30,-44', keys: [1, 2] });
    assert.deepEqual((await c.nextOf('world-ruin', 'c ruin')).keys, [1, 2]);
    await barrier(pub);
    assert.equal(count(pub, 'world-ruin'), 0, 'damage does not cross rooms');

    // seats are per room: the car is taken here and free there
    a.send({ type: 'world-seat', v: 0, seat: 0 });
    assert.deepEqual((await c.nextOf('world-seats', 'c seats')).seats[0], [0, a.id, 0, 0]);
    pub.send({ type: 'world-seat', v: 0, seat: 0 });
    assert.deepEqual((await pub.nextOf('world-seats', 'pub seats')).seats[0], [0, pub.id, 0, 0], 'the public car is a different car');

    // a late joiner gets the room's state, not the public one
    const d = await join('AMBER7');
    assert.deepEqual(d.welcome.players.map((p) => p.id).sort(), [a.id, c.id].sort());
    assert.deepEqual(d.welcome.seats[0], [0, a.id, 0, 0], 'late joiner sees the room seat table');
    const snap = await d.nextOf('world-prop-snapshot', 'd props');
    assert.equal(snap.props.length, 1);
    assert.equal(snap.props[0].id, spawned.prop.id);
    const ruins = await d.nextOf('world-ruins', 'd ruins');
    assert.equal(ruins.ruins.length, 1);
    assert.equal(count(pub, 'world-enter'), 0, 'public never hears a private arrival');

    // the public snapshot is untouched by any of it
    const late = await join(undefined);
    const lateSnap = await late.nextOf('world-prop-snapshot', 'public props');
    assert.equal(lateSnap.props.length, 0);
    assert.equal((await late.nextOf('world-ruins', 'public ruins')).ruins.length, 0);

    // errors: unknown code, malformed code, full room
    const unknown = await errorOf('NOSUCH', {});
    assert.equal(unknown.e.code, 'room_unknown');
    const bad = await errorOf('no way!', {});
    assert.equal(bad.e.code, 'bad_request');
    const full = await join('FULLRM', { create: true });
    await join('FULLRM');
    await join('FULLRM');
    const over = await errorOf('FULLRM', {});
    assert.equal(over.e.code, 'room_full');
    // a socket that failed a join is still free to try again elsewhere
    over.c.send({ type: 'world-join', level: 'overworld', room: 'public' });
    assert.equal((await over.c.nextOf('world-welcome', 'retry')).room, 'public');

    // leaving and rejoining inside the grace keeps the room and its props
    const solo = await join('KEEPME', { create: true });
    solo.send({ type: 'world-prop-spawn', level: 'overworld', nonce: 7, kind: 'crate', scale: 1, pose: [0, 1, 100, 300, 200, 0, 0, 0, 10000, 1] });
    await solo.nextOf('world-prop-spawn', 'solo prop');
    solo.send({ type: 'world-leave' });
    await sleep(60);
    solo.send({ type: 'world-join', level: 'overworld', room: 'KEEPME' });
    assert.equal((await solo.nextOf('world-welcome', 'rejoin')).room, 'KEEPME');
    assert.equal((await solo.nextOf('world-prop-snapshot', 'rejoin props')).props.length, 1, 'rejoin inside the grace finds the room as it was');

    // an empty room dies after the grace, with everything in it
    solo.send({ type: 'world-leave' });
    await sleep(600);
    const gone = await errorOf('KEEPME', {});
    assert.equal(gone.e.code, 'room_unknown', 'an empty room is forgotten');
    const reborn = await join('KEEPME', { create: true });
    assert.equal((await reborn.nextOf('world-prop-snapshot', 'reborn')).props.length, 0, 'a reborn room starts clean');

    // creating rooms is rate limited per socket
    const maker = await open();
    let refused = null;
    for (let i = 0; i < 5 && !refused; i++) {
      maker.send({ type: 'world-join', level: 'overworld', room: `MAKE${i}X`, create: true });
      let m;
      do m = await maker.next('make'); while (m.type !== 'world-welcome' && m.type !== 'error');
      if (m.type === 'error') refused = m;
      else maker.send({ type: 'world-leave' });
    }
    assert.equal(refused?.code, 'rate', 'a socket cannot mint rooms without limit');
  } finally {
    for (const s of socks) s.ws.close();
  }
}
