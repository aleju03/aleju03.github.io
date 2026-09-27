/* Real sockets exercise sandbox ownership, handoff epochs and level state. */
import assert from 'node:assert/strict';
import { createPropRegistry } from '../src/props.js';
function limits() {
  const owner = { world: { id: 1, level: 'limits', x: 0, y: 0, z: 0 }, nick: 'owner' };
  const players = new Map([[1, owner]]), messages = [];
  const registry = createPropRegistry({ players, send: (_, m) => messages.push(m) });
  registry.join(owner);
  for (let nonce = 1; nonce <= 151; nonce++) registry.handle(owner, {
    type: 'world-prop-spawn', level: 'limits', nonce, kind: 'crate', pose: [0,1,0,300,0,0,0,0,10000,1],
  });
  assert.equal(messages.filter(m => m.type === 'world-prop-spawn').length, 150);
  assert.equal(messages.at(-1).reason, 'limit');
  registry.handle(owner, { type: 'world-prop-cleanup', level: 'limits', target: 'all' });
  assert.equal(messages.at(-1).ids.length, 150, 'alone guests may clean all');
  for (let i = 0; i < 210; i++) registry.handle(owner, { type: 'world-prop-cleanup', level: 'limits', target: 'mine' });
  assert.equal(messages.at(-1).reason, 'rate');
}

export async function propSmoke(url, connect) {
  limits();
  const a = connect(url), b = connect(url), sockets = [a, b];
  try {
    for (const c of sockets) {
      await c.opened; c.send({ type: 'hello' }); await c.nextOf('hello-ok', 'hello');
      c.send({ type: 'world-join', level: 'prop-test' });
      c.you = (await c.nextOf('world-welcome', 'welcome')).you;
      await c.nextOf('world-prop-snapshot', 'snapshot');
    }
    const tx = (c, m) => c.send({ level: 'prop-test', ...m });
    const spawn = async (c, nonce, kind = 'crate') => {
      tx(c, { type: 'world-prop-spawn', nonce, kind, scale: 1.2, pose: [0, 1, 100, 300, 200, 0, 0, 0, 10000, 1] });
      let m;
      do { m = await c.nextOf('world-prop-spawn', 'spawn'); } while (m.nonce !== nonce || m.prop.owner !== c.you);
      return m.prop;
    };
    const p = await spawn(a, 1);
    assert.equal(p.owner, a.you);
    assert.equal((await spawn(a, 1)).id, p.id, 'spawn nonce is idempotent');
    assert.equal((await b.nextOf('world-prop-spawn', 'remote spawn')).prop.id, p.id);
    const r = [p.id, p.epoch, 200, 310, 200, 0, 0, 0, 10000, 0];
    tx(a, { type: 'world-prop-move', rows: [r] });
    assert.deepEqual((await b.nextOf('world-prop-move', 'move')).rows, [r]);
    tx(b, { type: 'world-prop-claim', id: p.id, reason: 'hand' });
    const revoke = (await a.nextOf('world-prop-state', 'revoke')).props[0];
    assert.equal(revoke.authority, 0); assert.equal(revoke.transfer.waiting, a.you);
    tx(b, { type: 'world-prop-move', rows: [[...r.slice(0, 2), 9999, ...r.slice(3)]] });
    tx(a, { type: 'world-prop-ack', rows: [[...r, 200, 0, 0, 0, 0, 0]] });
    let granted;
    do { granted = (await b.nextOf('world-prop-state', 'grant')).props[0]; } while (!granted.authority);
    assert.equal(granted.authority, b.you); assert.equal(granted.pose[2], 200); assert.equal(granted.epoch, 2);
    tx(b, { type: 'world-prop-cleanup', target: 'all' });
    assert.equal((await b.nextOf('world-prop-denied', 'cleanup denied')).reason, 'admin');
    tx(b, { type: 'world-prop-remove', id: p.id });
    const own = await spawn(b, 2, 'barrel');
    const late = connect(url); sockets.push(late);
    await late.opened; late.send({ type: 'hello' }); await late.nextOf('hello-ok', 'late hello');
    late.send({ type: 'world-join', level: 'prop-test' }); await late.nextOf('world-welcome', 'late welcome');
    const snapshot = await late.nextOf('world-prop-snapshot', 'late snapshot');
    assert.equal(snapshot.props.length, 2);
    assert.equal(snapshot.props.find((q) => q.id === p.id).authority, b.you);
    tx(a, { type: 'world-prop-hit', id: p.id, amount: 999, ignite: false });
    assert.equal((await b.nextOf('world-prop-hit', 'damage goes to authority')).amount, 200);
    tx(a, { type: 'world-prop-break', id: p.id, epoch: 1, how: 'break' });
    tx(b, { type: 'world-prop-break', id: p.id, epoch: 2, how: 'break' });
    assert.equal((await late.nextOf('world-prop-break', 'break')).id, p.id);
    const p2 = await spawn(a, 3), p3 = await spawn(a, 4);
    const frames = [0,0,0,0,0,0,0,0,0,1,1,0,0,1,0,0,1];
    tx(a, { type: 'world-prop-joint', id: p2.id, b: p3.id, kind: 'weld', frames, nonce: 7 });
    const joint = (await a.nextOf('world-prop-joint', 'joint accepted')).joint;
    assert.equal((await b.nextOf('world-prop-joint', 'joint replicated')).joint.id, joint.id);
    tx(a, { type: 'world-prop-meta', id: p2.id, epoch: 1, part: null, life: [0.7,-1,-1,1] });
    let health;
    do { health = (await a.nextOf('world-prop-state', 'health')).props.find(q => q.id === p2.id); } while (!health);
    assert.equal(health.life[0], 0.7);
    tx(a, { type: 'world-prop-explosion', at: [0,2,0], power: 99, radius: 999 });
    const blast = await b.nextOf('world-prop-explosion', 'blast replicated');
    assert.equal(blast.power, 4); assert.equal(blast.radius, 50);
    tx(a, { type: 'world-prop-unjoint', id: joint.id });
    assert.equal((await a.nextOf('world-prop-unjoint', 'joint removed')).id, joint.id);
    tx(a, { type: 'world-prop-cleanup', target: 'mine' });
    let gone;
    do { gone = await b.nextOf('world-prop-remove', 'own cleanup'); } while (!gone.ids.includes(p2.id));
    assert.ok(!gone.ids.includes(own.id));
    b.ws.close();
    let elected;
    do { elected = (await late.nextOf('world-prop-state', 'new simulator')).props.find(q => q.id === own.id); } while (!elected);
    assert.equal(elected.authority, a.you);
    // A level change snapshots its destination and leaves the old props behind.
    a.send({ type: 'world-level', level: 'prop-other' });
    assert.equal((await a.nextOf('world-prop-snapshot', 'other level')).props.length, 0);
    a.send({ type: 'world-level', level: 'prop-test' });
    assert.ok((await a.nextOf('world-prop-snapshot', 'return level')).props.some(q => q.id === own.id));
    // The admin can target an offline spawner by their stored name.
    a.send({ type: 'login', username: 'aleju', password: 'test-token' });
    await a.nextOf('auth-ok', 'admin');
    tx(a, { type: 'world-prop-cleanup', target: own.name });
    let adminGone;
    do { adminGone = await a.nextOf('world-prop-remove', 'admin cleanup'); } while (!adminGone.ids.includes(own.id));
    // Invalid kinds and degenerate rotations are rejected, not stored.
    tx(a, { type: 'world-prop-spawn', nonce: 99, kind: '__proto__', pose: r });
    assert.equal((await a.nextOf('world-prop-denied', 'kind validation')).reason, 'invalid');
    tx(a, { type: 'world-prop-spawn', nonce: 100, kind: 'crate', pose: [0,1,0,0,0,0,0,0,0,0] });
    assert.equal((await a.nextOf('world-prop-denied', 'rotation validation')).reason, 'invalid');
    console.log('props: spawn, move, claims, epochs, joints, metadata, hits, break, blast, cleanup, limits, admin, levels and late join passed');
  } finally { for (const c of sockets) c.ws.close(); }
}
