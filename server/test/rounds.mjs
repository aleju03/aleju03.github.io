/*
 * Rounds (server/src/rounds.js, roundModes.js), two ways.
 *
 * The unit half builds the engine over fake sockets and a fake clock, with the
 * real health.js and the real prop registry underneath, so the state machine
 * (lobby, countdown, playing, results), the host's powers, team balance,
 * leavers, late arrivals and mode switching are asserted exactly and without
 * waiting for anything. Each mode's rules get a short scripted round: the
 * deathmatch's kill limit and friendly fire, the hide and seek tag and
 * infection, the prop hunt's decoys, disguises, wrong-shot penalty and
 * hitboxes, the race's ring order and speed check, the build contest's plots,
 * votes and tally.
 *
 * The socket half (`roundsSmoke`) is one round on the real server, in a
 * private room: the wire from `world-round-cmd` to `world-round`.
 */
import assert from 'node:assert/strict';
import { createRounds, MAX_PARTS } from '../src/rounds.js';
import { createHealth } from '../src/health.js';
import { createPropRegistry } from '../src/props.js';
import { createCreatures } from '../src/creatures.js';
import { MODES } from '../src/roundModes.js';
import { STREET_LOOP, CUBE_LOOP_BLOCKS, CUBE_ORIGIN, CUBE_B, PLOT_FIELDS } from '../src/roundData.js';

export function rig({ countdownMs = 1000, resultsMs = 2000, isPublic = false } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const players = new Map();
  const log = new Map(); // ws -> messages
  const feed = []; // everything sent, in order
  const send = (ws, m) => { feed.push(m); (log.get(ws) ?? log.set(ws, []).get(ws)).push(m); };
  const health = createHealth({ players, send, now });
  const props = createPropRegistry({ players, send, now });
  const creatures = createCreatures({ players, send, health, now });
  const claimed = new Map();
  const claims = {
    assign: (lv, cx, cz, ws) => claimed.set(`${lv}:${cx},${cz}`, ws.world.id),
    free: (lv, cx, cz) => claimed.delete(`${lv}:${cx},${cz}`),
  };
  const rounds = createRounds({ players, send, health, props, claims, creatures, isPublic: () => isPublic, now, countdownMs, arriveMs: 5000, resultsMs });
  health.setGuard((v, s) => rounds.guard(v, s));
  health.onDeath((e) => rounds.died(e));
  let seq = 1;
  const strikes = [];
  const strike = (ws) => strikes.push(ws.world?.id);
  const R = {
    t: () => t, players, log, health, props, rounds, creatures, claimed, strikes,
    add(level = 'nuketown', admin = false) {
      const ws = { nick: `p${seq}`, isAdmin: admin, world: { id: seq++, level, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, f: 1 } };
      players.set(ws.world.id, ws);
      health.snapshot(ws);
      creatures.snapshot(ws);
      rounds.snapshot(ws);
      return ws;
    },
    remove(ws) {
      const w = ws.world;
      players.delete(w.id);
      ws.world = null;
      health.left(w.id, w.level);
      rounds.left(ws, w.id);
    },
    /** move a socket to another level, as handleWorldLevel does */
    goto(ws, level) {
      const from = ws.world.level;
      ws.world.level = level;
      health.moved(ws, from);
      rounds.moved(ws, from);
    },
    cmd: (ws, cmd, extra = {}) => rounds.handle(ws, { type: 'world-round-cmd', cmd, ...extra }, strike),
    advance(ms) {
      // in steps, as the world ticker would
      for (let left = ms; left > 0; left -= 250) { t += Math.min(250, left); rounds.tick(); health.tick(); }
    },
    state() {
      return [...feed].reverse().find((m) => m.type === 'world-round');
    },
    last: (ws, type) => [...(log.get(ws) ?? [])].reverse().find((m) => m.type === type),
    all: (ws, type) => (log.get(ws) ?? []).filter((m) => m.type === type),
    clear() {
      const keep = R.state();
      log.clear();
      feed.length = 0;
      if (keep) feed.push(keep);
    },
    feed,
    pose(ws, x, z, y = 0) { Object.assign(ws.world, { x, z, y }); rounds.pose(ws); },
    /** everyone ready, wait for the countdown and the start */
    async play(list) {
      for (const ws of list) R.cmd(ws, 'ready', { on: true });
      R.advance(countdownMs + 1000);
      assert.equal(R.state().ph, 'playing', 'the round started');
    },
    rows: () => R.state().p,
    part: (ws) => R.state().p.find((r) => r[0] === ws.world.id),
  };
  return R;
}

export const kill = (R, victim, by, kind = 'pistol') => {
  // a real fatal blow through health.js, credited to `by`
  R.health.hurt(victim, 500, { by: by.world.id, kind });
};

/** every unit test of the rounds, in order */
export async function roundsUnit() {
  await lobbyTests();
  await peacefulTests();
  await (await import('./roundsDefs.mjs')).defsAgree();
  const { deathmatchTests } = await import('./roundsDeathmatch.mjs');
  await deathmatchTests();
  const modes = await import('./roundsModes.mjs');
  await modes.hideTests();
  await modes.propHuntTests();
  await modes.raceTests();
  await modes.buildTests();
}

async function lobbyTests() {
  /* ---- the lobby: host, modes, readiness, the wire ---- */
  {
    const R = rig();
    const a = R.add();
    const b = R.add();
    const first = R.last(a, 'world-round');
    assert.equal(first.ph, 'lobby');
    assert.equal(first.host, a.world.id, 'the first player is the host');
    R.cmd(b, 'mode', { mode: 'hide' });
    assert.equal(R.last(b, 'world-round-no').reason, 'host', 'only the host picks a mode');
    R.cmd(a, 'mode', { mode: 'nonsense' });
    assert.equal(R.last(a, 'world-round-no').reason, 'unknown');
    R.cmd(a, 'mode', { mode: 'Bad Id!' });
    assert.equal(R.strikes.length, 1, 'a malformed id is a strike');
    R.cmd(a, 'mode', { mode: 'hide' });
    assert.equal(R.state().mode, 'hide');
    assert.equal(R.state().lv, 'nuketown');
    R.cmd(a, 'mode', { mode: 'hide', level: 'cubeland' });
    assert.equal(R.state().lv, 'cubeland', 'a mode that allows the level runs there');
    R.cmd(a, 'mode', { mode: 'hide', level: 'moon' });
    assert.equal(R.state().lv, 'nuketown', 'a level the mode does not allow falls back to its own');
    // the host may not start alone, or with one ready; a stranger may not start
    R.cmd(b, 'start');
    assert.equal(R.last(b, 'world-round-no').reason, 'host');
    R.cmd(a, 'start');
    assert.deepEqual([R.last(a, 'world-round-no').reason, R.last(a, 'world-round-no').need], ['few', 2]);
    R.cmd(a, 'ready', { on: 'yes' });
    assert.equal(R.strikes.length, 2, 'a non-boolean ready is a strike');
    // rate: the eleventh command in a second is dropped silently
    for (let i = 0; i < 20; i++) R.cmd(b, 'ready', { on: i % 2 === 0 });
    R.advance(1200);
    R.cmd(b, 'ready', { on: false });
    assert.ok(!R.state().rd.includes(b.world.id));
    // mode switching resets the mode's options
    R.cmd(a, 'mode', { mode: 'deathmatch' });
    assert.deepEqual(R.state().opt, { teams: true, limit: 0 });
    R.cmd(a, 'opt', { key: 'teams', value: false });
    assert.deepEqual(R.state().opt, { teams: false, limit: 0 });
    R.cmd(a, 'opt', { key: 'nope', value: 1 });
    assert.equal(R.strikes.length, 3, 'an unknown option is a strike');
    R.cmd(a, 'mode', { mode: 'prophunt' });
    assert.equal(R.state().opt, undefined, 'options belong to the mode');
  }

  /* ---- debug: solo testing ---- */
  {
    const R = rig();
    const a = R.add();
    const b = R.add();
    R.cmd(b, 'debug', { on: true });
    assert.equal(R.last(b, 'world-round-no').reason, 'admin', 'not the host of a private room, not an admin');
    R.cmd(a, 'debug', { on: true });
    assert.equal(R.state().dbg, 1, 'the host of a private room may');
    R.remove(b);
    R.cmd(a, 'ready', { on: true });
    R.advance(2000);
    assert.equal(R.state().ph, 'playing', 'alone, in debug, a round starts');
    const pub = rig({ isPublic: true });
    const h = pub.add();
    pub.cmd(h, 'debug', { on: true });
    assert.equal(pub.last(h, 'world-round-no').reason, 'admin', 'the public room needs an admin');
    const adm = pub.add('nuketown', true);
    pub.cmd(adm, 'debug', { on: true });
    assert.equal(pub.state().dbg, 1, 'an admin may, host or not');
  }
}

/** creatures are peaceful while a round plays, and put back afterwards */
async function peacefulTests() {
  for (const before of [false, true]) {
    const R = rig();
    const a = R.add();
    const b = R.add();
    if (before) R.creatures.handle(a, { type: 'world-creature-cmd', level: 'nuketown', cmd: 'peaceful' });
    assert.equal(R.creatures.isPeaceful('nuketown'), before);
    R.cmd(a, 'mode', { mode: 'deathmatch' });
    await R.play([a, b]);
    assert.equal(R.creatures.isPeaceful('nuketown'), true, 'mobs are peaceful while a round plays');
    // the console cannot make war mid-round
    if (!before) R.creatures.handle(a, { type: 'world-creature-cmd', level: 'nuketown', cmd: 'war' });
    assert.equal(R.creatures.isPeaceful('nuketown'), true);
    R.cmd(a, 'stop');
    R.advance(3000);
    assert.equal(R.creatures.isPeaceful('nuketown'), before, 'and back to what they were (a war asked for mid-round takes effect afterwards)');
  }
}
