/*
 * Real-socket checks for persistent portal pairs and ephemeral hop clouds.
 * Snapshot barriers make filtering and deduplication assertions independent
 * of timing; the game-side probe separately exercises crossing and drawing.
 */
import assert from 'node:assert/strict';
export async function effectsSmoke(url, connect) {
  const peers = [];
  const join = async (level) => {
    const c = connect(url); peers.push(c); c.seen = [];
    c.ws.on('message', data => c.seen.push(JSON.parse(data.toString())));
    await c.opened; c.send({ type: 'hello' }); await c.nextOf('hello-ok', 'effects hello');
    c.send({ type: 'world-join', level });
    c.id = (await c.nextOf('world-welcome', 'effects welcome')).you;
    c.snapshot = await c.nextOf('world-portals', 'initial portals');
    return c;
  };
  const portal = (serial, x = 0) => ({ serial, level: 'overworld', frame: [x,2,5,0,0,1,0,1,0], ground: false, inset: 0, skin: 0, ready: true, site: null, anchor: null });
  try {
    const a = await join('overworld'), b = await join('overworld');
    a.send({ type: 'world-portal', color: 0, portal: portal(1) });
    assert.equal((await b.nextOf('world-portal', 'blue')).owner, a.id);
    a.send({ type: 'world-portal', color: 1, portal: portal(2, 8) });
    const pair = await b.nextOf('world-portal', 'orange');
    assert.ok(pair.portals.every(Boolean));
    b.send({ type: 'world-portal', color: 0, portal: portal(1, 16), owner: a.id });
    const own = await b.nextOf('world-portal', 'independent pair');
    assert.equal(own.owner, b.id, 'owner is derived from the socket');
    a.send({ type: 'world-portal', color: 0, portal: { ...portal(3), frame: [0,0,0,0,0,0,0,1,0] } });
    assert.equal((await a.nextOf('world-portal-denied', 'bad basis')).serial, 3);
    const late = await join('overworld');
    assert.equal(late.snapshot.pairs.length, 2);
    assert.equal(late.snapshot.pairs.find(p => p.owner === a.id).portals[0].serial, 1);
    b.send({ type: 'world-level', level: 'moon' });
    assert.equal((await b.nextOf('world-portals', 'moon snapshot')).pairs.length, 0);
    const hop = { type: 'world-air-hop', level: 'overworld', seq: 1, x: 0, y: 2, z: 0 };
    a.send(hop); a.send(hop);
    assert.equal((await late.nextOf('world-air-hop', 'hop')).id, a.id);
    // A later portal message is an ordered barrier on the same relay path.
    a.send({ type: 'world-portal', color: 0, portal: portal(4) });
    await late.nextOf('world-portal', 'hop barrier');
    assert.equal(late.seen.filter(m => m.type === 'world-air-hop').length, 1);
    assert.equal(a.seen.filter(m => m.type === 'world-air-hop').length, 0);
    assert.equal(b.seen.filter(m => m.type === 'world-air-hop').length, 0);
    a.send({ ...hop, seq: 2, x: 5000 });
    a.send({ type: 'world-portal', color: 1, portal: { ...portal(5), level: 'moon', frame: [13.37,7,60000,-1,0,0,0,1,0], site: 'moon' } });
    const cross = await b.nextOf('world-portal', 'cross-level pair');
    assert.deepEqual(cross.portals.map(p => p.level), ['overworld','moon']);
    assert.equal(late.seen.filter(m => m.type === 'world-air-hop').length, 1);
    a.send({ type: 'world-prop-spawn', level: 'overworld', nonce: 88, kind: 'portal_panel', scale: 1, pose: [0,1,0,400,0,0,0,0,10000,1] });
    const prop = (await a.nextOf('world-prop-spawn', 'panel')).prop;
    a.send({ type: 'world-portal', color: 0, portal: { ...portal(6), frame: [0,4,0.2,0,0,1,0,1,0], anchor: { prop: prop.id, frame: [0,0,0.2,0,0,1,0,1,0] } } });
    const anchored = await b.nextOf('world-portal', 'prop anchor');
    assert.equal(anchored.portals[0].anchor.prop, prop.id);
    a.send({ type: 'world-prop-move', level: 'overworld', rows: [[prop.id,1,1000,400,0,0,0,0,10000,1]] });
    let moved;
    do { moved = await b.nextOf('world-portal', 'moving cross-level anchor'); } while (moved.portals[0]?.frame[0] !== 10);
    a.send({ type: 'world-prop-remove', level: 'overworld', id: prop.id });
    let removed;
    do { removed = await b.nextOf('world-portal', 'removed anchor'); } while (removed.portals[0]);
    assert.ok(removed.portals[1]);
    late.send({ type: 'world-level', level: 'overworld' });
    const catchup = await late.nextOf('world-portals', 'no stale hop replay');
    assert.ok(catchup.pairs.every(p => p.owner !== a.id));
    a.ws.close();
    const gone = await b.nextOf('world-portal', 'departed owner');
    assert.equal(gone.owner, a.id); assert.deepEqual(gone.portals, [null, null]);
    console.log('effects: independent portal pairs, snapshots, validation, level filtering, moving prop anchors, departure and deduplicated hop clouds passed');
  } finally { for (const c of peers) c.ws.close(); }
}
