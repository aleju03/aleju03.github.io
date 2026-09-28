/*
 * Real-socket checks for creatures.js: the server designates the host (the
 * longest-present player of the scope) and hands the role over when they
 * leave; the host's snapshots are relayed to everyone else, validated and
 * bounded, and a late joiner is given the table; a hit on a creature reaches
 * only the host, clamped, rate limited and range checked against the
 * reporter's pose; a creature's attack on a person is applied through the
 * health system at the server's number, once per cooldown, only for a creature
 * of the right kind within reach of the victim, and only on the host's word;
 * the console's switches are for the host or an admin; another level hears
 * none of it. Every "nothing happened" is followed by a message that does
 * something on the same path, which proves the earlier one was not merely
 * slow.
 */
import assert from 'node:assert/strict';
import { KIND_COUNT, MAX_ROWS } from '../src/creatures.js';

const ZOMBIE = 4;
const CREEPER = 5;
const ARROW = 7;

export async function creaturesSmoke(url, connect) {
  const peers = [];
  const join = async (level) => {
    const c = connect(url); peers.push(c); c.seen = [];
    c.ws.on('message', (data) => c.seen.push(JSON.parse(data.toString())));
    await c.opened; c.send({ type: 'hello' }); await c.nextOf('hello-ok', 'creatures hello');
    c.send({ type: 'world-join', level });
    c.id = (await c.nextOf('world-welcome', 'creatures welcome')).you;
    c.level = level;
    return c;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** wait until a message satisfying `pred` has been seen (after `from`) */
  const until = async (c, pred, label, from = 0) => {
    for (let i = 0; i < 200; i++) {
      const m = c.seen.slice(from).find(pred);
      if (m) return m;
      await sleep(15);
    }
    throw new Error(`never saw: ${label}`);
  };
  const mark = (c) => c.seen.length;
  const pose = async (c, x, y = 0, z = 0) => {
    c.send({ type: 'world-move', x, y, z, yaw: 0, pitch: 0, gait: 0, f: 1 });
    await sleep(40);
  };
  const row = (id, kind, x = 0, y = 0, z = 0, hp = 10, flags = 1) => [id, kind, x * 10, y * 10, z * 10, 0, hp, flags];
  const snap = (c, rows) => c.send({ type: 'world-creatures', level: c.level, rows });
  const hpRows = (c, id) => c.seen.filter((m) => m.type === 'world-hp').flatMap((m) => m.rows).filter((r) => r[0] === id);
  const hostMsgs = (c) => c.seen.filter((m) => m.type === 'world-creature-host');
  const relayed = (c) => c.seen.filter((m) => m.type === 'world-creatures');
  const hits = (c) => c.seen.filter((m) => m.type === 'world-creature-hit');
  try {
    assert.equal(KIND_COUNT, 9, 'kind count mirrors src/game/creatures/kinds.ts');

    // ---- host designation: the first in is the host, and nobody newer displaces them
    const a = await join('creatures-a');
    const ha = await until(a, (m) => m.type === 'world-creature-host', 'a is told who hosts');
    assert.deepEqual([ha.host, ha.on, ha.peaceful, ha.level], [a.id, true, false, 'creatures-a']);
    const b = await join('creatures-a');
    const hb = await until(b, (m) => m.type === 'world-creature-host', 'b is told who hosts');
    assert.equal(hb.host, a.id, 'a joiner never displaces the host');
    const other = await join('creatures-b');
    assert.equal((await until(other, (m) => m.type === 'world-creature-host', 'other level has its own host')).host, other.id);
    await pose(a, 0); await pose(b, 5); await pose(other, 0);

    // ---- the relay: the host's snapshot reaches b (not the level next door), and a late joiner gets the table
    snap(a, [row(1, 0, 3, 0, 3), row(2, ZOMBIE, 4, 0, 0), row(3, CREEPER, 2, 0, 0), row(4, ARROW, 5, 1, 0)]);
    const got = await until(b, (m) => m.type === 'world-creatures' && m.rows.length === 4, 'b sees the snapshot');
    assert.deepEqual(got.rows[1], row(2, ZOMBIE, 4, 0, 0), 'rows arrive as sent');
    assert.equal(relayed(other).length, 0, 'the other level hears nothing');
    assert.equal(relayed(a).length, 0, 'the host does not hear itself');
    const late = await join('creatures-a');
    await until(late, (m) => m.type === 'world-creatures' && m.rows.length === 4, 'a late joiner is given the table');
    await pose(late, 60);

    // ---- bounds: too many rows, a non-integer, a bad kind, a duplicate id, a non-host: none is relayed
    const bads = [
      Array.from({ length: MAX_ROWS + 1 }, (_, i) => row(100 + i, 0)),
      [row(1, 0), [2, 0, 1.5, 0, 0, 0, 10, 1]],
      [row(1, 0), row(2, KIND_COUNT)],
      [row(1, 0), row(1, 0)],
      [row(0, 0)],
      [row(1, 0, 1e9)],
    ];
    for (const rows of bads) snap(a, rows);
    b.send({ type: 'world-creatures', level: 'creatures-a', rows: [row(77, 0)] }); // b is not the host
    snap(a, [row(9, 0, 1, 0, 1)]);
    const good = await until(b, (m) => m.type === 'world-creatures' && m.rows.length === 1, 'the good snapshot after the bad ones');
    assert.equal(good.rows[0][0], 9);
    assert.ok(!relayed(b).some((m) => m.rows.some((r) => r[0] === 77 || r[0] >= 100)), 'no bad snapshot was relayed');
    snap(a, [row(1, 0, 3, 0, 3), row(2, ZOMBIE, 4, 0, 0), row(3, CREEPER, 2, 0, 0), row(4, ARROW, 5, 1, 0)]);
    await until(late, (m) => m.type === 'world-creatures' && m.rows.length === 4 && m.rows[0][0] === 1, 'table back to four');

    // ---- damage to a creature: only the host hears it, clamped, and only from within reach
    const m0 = mark(a);
    b.send({ type: 'world-creature-hit', level: 'creatures-a', id: 1, amount: 9999, kx: 1e6, kz: -1e6 });
    const h1 = await until(a, (m) => m.type === 'world-creature-hit', 'the host hears the hit', m0);
    assert.deepEqual([h1.id, h1.amount, h1.kx, h1.kz, h1.from], [1, 60, 40, -40, b.id], 'amount and shove are clamped');
    assert.equal(hits(b).length, 0);
    const m1 = mark(a);
    await pose(b, 5000);
    b.send({ type: 'world-creature-hit', level: 'creatures-a', id: 1, amount: 5, kx: 0, kz: 0 }); // 5 km away
    await pose(b, 5);
    b.send({ type: 'world-creature-hit', level: 'creatures-a', id: 999, amount: 5, kx: 0, kz: 0 }); // no such creature
    b.send({ type: 'world-creature-hit', level: 'creatures-a', id: 1, amount: -3, kx: 0, kz: 0 });
    b.send({ type: 'world-creature-hit', level: 'creatures-a', id: 4, amount: 3, kx: 0, kz: 0 }); // an arrow is not hurt
    a.send({ type: 'world-creature-hit', level: 'creatures-a', id: 1, amount: 5, kx: 0, kz: 0 }); // the host applies its own
    b.send({ type: 'world-creature-hit', level: 'creatures-a', id: 2, amount: 7, kx: 1, kz: 2 });
    const h2 = await until(a, (m) => m.type === 'world-creature-hit', 'the next valid hit', m1);
    assert.deepEqual([h2.id, h2.amount], [2, 7], 'the far, unknown, negative, arrow and own hits were dropped');
    // a burst is rate limited per socket
    const m2 = mark(a);
    for (let i = 0; i < 80; i++) b.send({ type: 'world-creature-hit', level: 'creatures-a', id: 1, amount: 1, kx: 0, kz: 0 });
    await sleep(300);
    const burst = a.seen.slice(m2).filter((m) => m.type === 'world-creature-hit').length;
    assert.ok(burst > 0 && burst <= 24, `a burst of 80 delivered ${burst}`);

    // ---- /spawnmob by request: a kind that can be asked for, near the asker, for the host to place
    const s0 = mark(a);
    const ask = (c, kind, x, z) => c.send({ type: 'world-creature-spawn', level: 'creatures-a', kind, x, z });
    ask(b, ARROW, 6, 0); // an arrow is not spawnable
    ask(b, KIND_COUNT, 6, 0); // no such kind
    ask(b, 0, 900, 0); // 900 units from b
    ask(a, 0, 3, 0); // the host places its own
    ask(b, 0, 6, 1);
    const sp = await until(a, (m) => m.type === 'world-creature-spawn', 'the host is asked to place a pig', s0);
    assert.deepEqual([sp.kind, sp.x, sp.z, sp.from], [0, 6, 1, b.id], 'only the valid request arrived');
    assert.equal(a.seen.slice(s0).filter((m) => m.type === 'world-creature-spawn').length, 1);

    // ---- a creature hurts a person: the server's number, through health, once per cooldown
    await pose(b, 5, 0, 0);
    const atk = (c, id, victim, kind) => c.send({ type: 'world-creature-attack', level: 'creatures-a', id, victim, atk: kind });
    const k0 = mark(b);
    atk(b, 2, b.id, 0); // b is not the host
    atk(a, 3, b.id, 0); // a creeper cannot melee
    atk(a, 2, b.id, 1); // a zombie is not an arrow
    atk(a, 1, b.id, 0); // a pig is not a zombie
    atk(a, 2, late.id, 0); // late is 55 units from the zombie
    atk(a, 999, b.id, 0);
    atk(a, 2, b.id, 0); // valid: the zombie is 1 unit from b
    const knock = await until(b, (m) => m.type === 'world-creature-knock', 'the victim is knocked', k0);
    assert.ok(Math.hypot(knock.vx, knock.vz) > 1 && Math.hypot(knock.vx, knock.vz) <= 24 + 1e-6);
    await until(b, (m) => m.type === 'world-hp' && m.rows.some((r) => r[0] === b.id && r[1] === 95), 'b took exactly 5 (the server\'s number)', k0);
    atk(a, 2, b.id, 0); // inside the cooldown
    await sleep(120);
    assert.equal(hpRows(b, b.id).filter((r) => r[1] === 95).length, 1, 'no second blow inside the cooldown');
    assert.equal(hpRows(b, b.id).filter((r) => r[1] < 95).length, 0);
    assert.equal(hpRows(late, late.id).length, 0, 'the far player was not hurt');
    // an arrow hurts once for four; the same arrow again does not
    atk(a, 4, b.id, 1);
    await until(b, (m) => m.type === 'world-hp' && m.rows.some((r) => r[0] === b.id && r[1] === 91), 'an arrow is four');
    atk(a, 4, b.id, 1);
    // a creeper's blast falls off with the distance the server measured (1 unit off: nearly the whole 45)
    atk(a, 3, b.id, 2);
    const blast = await until(b, (m) => m.type === 'world-hp' && m.rows.some((r) => r[0] === b.id && r[1] < 91 && r[1] > 40), 'a blast');
    const after = blast.rows.find((r) => r[0] === b.id)[1];
    assert.ok(after >= 91 - 45 && after <= 91 - 25, `blast left ${after}`);
    atk(a, 3, b.id, 2);
    await sleep(120);
    assert.equal(hpRows(b, b.id).filter((r) => r[1] < after).length, 0, 'a creeper goes off once');

    // ---- the console: only the host or an admin flips the switches
    const c0 = mark(b);
    b.send({ type: 'world-creature-cmd', level: 'creatures-a', cmd: 'off' });
    await until(b, (m) => m.type === 'world-creature-no', 'a plain player is refused', c0);
    a.send({ type: 'world-creature-cmd', level: 'creatures-a', cmd: 'peaceful' });
    const sw = await until(b, (m) => m.type === 'world-creature-host' && m.peaceful === true, 'peaceful is announced', c0);
    assert.equal(sw.on, true);
    const c1 = mark(b);
    a.send({ type: 'world-creature-cmd', level: 'creatures-a', cmd: 'clear' });
    const cleared = await until(b, (m) => m.type === 'world-creatures' && m.rows.length === 0, 'clear empties the table', c1);
    assert.equal(cleared.rows.length, 0);
    a.send({ type: 'world-creature-cmd', level: 'creatures-a', cmd: 'war' });
    await until(b, (m) => m.type === 'world-creature-host' && m.peaceful === false, 'war is announced', c1);
    snap(a, [row(1, 0, 3, 0, 3), row(2, ZOMBIE, 4, 0, 0)]);
    await until(late, (m) => m.type === 'world-creatures' && m.rows.length === 2, 'the table again before the handover');

    // ---- handoff: the host leaves and the longest-present of the rest takes over, with the table
    const before = mark(b);
    a.ws.close();
    const next = await until(b, (m) => m.type === 'world-creature-host' && m.host === b.id, 'b becomes the host', before);
    assert.equal(next.host, b.id);
    await until(late, (m) => m.type === 'world-creature-host' && m.host === b.id, 'late is told too');
    // a latecomer now is told the new host and given the table the old host left
    const newest = await join('creatures-a');
    assert.equal((await until(newest, (m) => m.type === 'world-creature-host', 'newest')).host, b.id);
    await until(newest, (m) => m.type === 'world-creatures' && m.rows.length === 2, 'the old host\'s table survives it');
    // the new host is really the host: its snapshot is relayed and the old id's is not
    snap(b, [row(5, 1, 1, 0, 1)]);
    await until(late, (m) => m.type === 'world-creatures' && m.rows.length === 1 && m.rows[0][0] === 5, 'the new host\'s snapshot is relayed');

    // ---- leaving the level counts as leaving: moving b away hands the role to late
    const before2 = mark(late);
    b.send({ type: 'world-level', level: 'creatures-b' });
    await until(late, (m) => m.type === 'world-creature-host' && m.host === late.id, 'late becomes host when b changes level', before2);
    await until(b, (m) => m.type === 'world-creature-host' && m.level === 'creatures-b', 'b hears creatures-b\'s host');
  } finally {
    for (const c of peers) try { c.ws.close(); } catch { /* already closed */ }
  }
}
