/*
 * One round on the real server, in a private room: the wire from a
 * `world-round-cmd` to a `world-round` state, pvp following the round, the
 * host's stop, and a solo game of hide and seek under the debug flag. The
 * server is started with ROUND_COUNTDOWN_MS / ROUND_RESULTS_MS shortened (see
 * smoke.mjs). The state machine itself is exercised without sockets in
 * rounds.mjs / roundsDeathmatch.mjs / roundsModes.mjs.
 */
import assert from 'node:assert/strict';

export async function roundsSmoke(url, connect) {
  const socks = [];
  const open = async (level = 'nuketown') => {
    const c = connect(url);
    socks.push(c);
    c.seen = [];
    c.ws.on('message', (d) => c.seen.push(JSON.parse(d.toString())));
    await c.opened;
    c.send({ type: 'hello' });
    await c.nextOf('hello-ok', 'rounds hello');
    c.send({ type: 'world-join', level, room: 'RNDTS1', create: true });
    c.id = (await c.nextOf('world-welcome', 'rounds welcome')).you;
    return c;
  };
  const untilPhase = async (c, ph, label) => {
    for (let i = 0; i < 200; i++) {
      const m = await c.nextOf('world-round', label);
      if (m.ph === ph) return m;
    }
    throw new Error(`never reached ${ph} (${label})`);
  };
  const cmd = (c, name, extra = {}) => c.send({ type: 'world-round-cmd', cmd: name, ...extra });
  try {
    const a = await open();
    const first = await untilPhase(a, 'lobby', 'the lobby state on joining');
    assert.equal(first.host, a.id);
    assert.equal(first.mode, 'deathmatch');
    const b = await open();
    assert.equal((await untilPhase(b, 'lobby', 'b sees the lobby')).host, a.id);

    // a guest may not start; both ready starts a round by itself
    cmd(b, 'start');
    assert.equal((await b.nextOf('world-round-no', 'b refused')).reason, 'host');
    cmd(a, 'ready', { on: true });
    cmd(b, 'ready', { on: true });
    const cd = await untilPhase(a, 'countdown', 'both ready starts it');
    assert.equal(cd.p.length, 2);
    const playing = await untilPhase(a, 'playing', 'and play begins');
    assert.deepEqual(playing.p.map((r) => r[1]).sort(), ['a', 'b'], 'one to a team');
    assert.ok(playing.end > playing.now, 'a clock');
    assert.ok(a.seen.some((m) => m.type === 'world-pvp' && m.on === true), 'pvp comes on with the round');
    // stopping goes back to the lobby and turns pvp off again
    cmd(a, 'stop');
    const lobby = await untilPhase(a, 'lobby', 'stop returns to the lobby');
    assert.deepEqual(lobby.rd, []);
    assert.equal(a.seen.filter((m) => m.type === 'world-pvp').at(-1).on, false, 'and off with it');

    // alone, in debug, another mode: hide and seek runs with one
    b.ws.close();
    cmd(a, 'debug', { on: true });
    cmd(a, 'mode', { mode: 'hide' });
    cmd(a, 'ready', { on: true });
    const hide = await untilPhase(a, 'playing', 'a solo hide and seek');
    assert.equal(hide.dbg, 1);
    assert.equal(hide.mode, 'hide');
    assert.equal(hide.p[0][2], 'seeker', 'the only player seeks');
    cmd(a, 'stop');
    await untilPhase(a, 'lobby', 'and stops');
    // a malformed command is a strike, not a crash
    a.send({ type: 'world-round-cmd', cmd: 42 });
    cmd(a, 'ready', { on: false });
    await untilPhase(a, 'lobby', 'the server is still answering');
  } finally {
    for (const c of socks) c.ws.close();
  }
}
