/*
 * The deathmatch through the round engine (test/rounds.mjs's rig): teams,
 * arrival, friendly fire, respawn, spectators and mid-round joins, the kill
 * limit, results and the way back to the lobby, leavers, free for all, the
 * clock, the host's stop.
 */
import assert from 'node:assert/strict';
import { rig, kill } from './rounds.mjs';

export async function deathmatchTests() {
  const R = rig();
  const p = [R.add(), R.add(), R.add(), R.add(), R.add()];
  const late = p[4];
  R.goto(late, 'overworld'); // not on the map yet: it has to travel there
  for (const ws of p) R.cmd(ws, 'ready', { on: true });
  R.advance(300);
  assert.equal(R.state().ph, 'countdown', 'everyone ready starts it by itself');
  assert.equal(R.state().p.length, 5);
  assert.equal(R.last(late, 'world-round-go').level, 'nuketown', 'the far one is told to change map');
  assert.equal(R.last(p[0], 'world-round-go').here, 1, 'the near one is told it is already there');
  R.advance(2000);
  assert.equal(R.state().ph, 'countdown', 'the round waits for the traveller');
  assert.equal(R.state().w, 1, 'and says it is waiting');
  R.goto(late, 'nuketown');
  R.advance(1500);
  assert.equal(R.state().ph, 'playing');
  const teams = R.state().p.map((r) => r[1]);
  const na = teams.filter((x) => x === 'a').length;
  const nb = teams.filter((x) => x === 'b').length;
  assert.deepEqual([na + nb, Math.abs(na - nb)], [5, 1], 'teams are balanced');
  assert.ok(R.health.isPvp('nuketown'), 'pvp is on for the map');
  assert.equal(R.health.isPvp('overworld'), false);

  // teammates cannot hurt each other; enemies kill
  const team = (t) => p.filter((ws) => R.part(ws)?.[1] === t);
  const [x, y] = team('a');
  const z = team('b')[0];
  R.advance(2500); // spawn protection ends
  assert.equal(R.health.hurt(y, 50, { by: x.world.id, kind: 'pistol' }), 0, 'no friendly fire');
  kill(R, z, x);
  R.advance(500); // scores ride the next push
  assert.equal(R.part(x)[4], 1, 'the killer counts a kill');
  assert.equal(R.part(z)[5], 1, 'the victim a death');
  assert.equal(R.health.isDead(z), true);
  R.advance(3300);
  assert.equal(R.health.isDead(z), false, 'respawn in three seconds');
  // a spectator who arrives now cannot be hurt, cannot shoot
  const watcher = R.add();
  assert.equal(R.rounds.mayShoot(watcher, 0), false);
  assert.equal(R.health.hurt(watcher, 20, { by: x.world.id, kind: 'pistol' }), 0, 'spectators are immune');
  // mid-round joining is open for this mode
  R.cmd(watcher, 'join');
  assert.equal(R.state().p.length, 6);
  assert.ok(['a', 'b'].includes(R.part(watcher)[1]), 'a joiner is dealt a team');
  assert.equal(R.rounds.mayShoot(watcher, 0), true);
  p.push(watcher);

  // the kill limit ends it: forty for a team
  let guard = 0;
  while (R.state().ph === 'playing' && guard++ < 200) {
    const enemy = team(R.part(x)[1] === 'a' ? 'b' : 'a')[0] ?? z;
    R.advance(3300);
    if (R.health.isDead(enemy)) continue;
    kill(R, enemy, x);
  }
  assert.equal(R.state().ph, 'results');
  assert.equal(R.state().res.why, 'limit');
  assert.equal(R.state().res.team, R.part(x)[1], 'the killing team wins');
  assert.ok(R.state().res.win.includes(x.world.id));
  assert.equal(R.health.isPvp('nuketown'), false, 'pvp goes back off with the round');
  assert.equal(R.rounds.mayShoot(x, 0), true, 'between rounds nothing is restricted');
  R.advance(2500);
  assert.equal(R.state().ph, 'lobby', 'and the sheet gives way to the lobby');
  assert.equal(R.state().p.length, 0);
  assert.deepEqual(R.state().rd, [], 'nobody is ready any more');

  // leave during a round: the last team's players walking out ends it
  {
    const S = rig();
    const [a, b, c] = [S.add(), S.add(), S.add()];
    await S.play([a, b, c]);
    const all = [a, b, c];
    const solo = all.find((ws) => all.filter((o) => S.part(o)[1] === S.part(ws)[1]).length === 1);
    const other = [solo];
    const mine = all.filter((ws) => ws !== solo);
    assert.ok(solo, 'three make two and one');
    S.remove(other[0]);
    assert.equal(S.state().ph, 'results', 'a team with nobody left loses at once');
    assert.equal(S.state().res.why, 'last');
    assert.deepEqual([...S.state().res.win].sort(), mine.map((w) => w.world.id).sort());
  }
  // leaving under the minimum without debug abandons
  {
    const S = rig();
    const [a, b] = [S.add(), S.add()];
    await S.play([a, b]);
    S.remove(b);
    assert.equal(S.state().ph, 'results');
    assert.equal(S.state().res.why, 'abandoned');
  }
  // walking off the map is leaving the round
  {
    const S = rig();
    const [a, b, c] = [S.add(), S.add(), S.add()];
    await S.play([a, b, c]);
    S.goto(c, 'overworld');
    S.advance(500);
    assert.equal(S.state().p.length, 2, 'a participant who leaves the level is out');
  }
  // free for all: a single winner by kills
  {
    const S = rig();
    const [a, b] = [S.add(), S.add()];
    S.cmd(a, 'opt', { key: 'teams', value: false });
    await S.play([a, b]);
    assert.ok(S.state().p.every((r) => r[1] === ''), 'no teams');
    S.advance(2500);
    for (let i = 0; i < 80 && S.state().ph === 'playing'; i++) { kill(S, b, a); if (S.state().ph !== 'playing') break; S.advance(3300); }
    assert.equal(S.state().ph, 'results');
    assert.deepEqual(S.state().res.win, [a.world.id]);
    assert.equal(S.state().res.rows[0][0], a.world.id, 'rows are sorted, best first');
  }
  // the time limit, by the clock; a draw when nobody scored
  {
    const S = rig();
    const [a, b] = [S.add(), S.add()];
    await S.play([a, b]);
    S.advance(301_000);
    assert.equal(S.state().ph, 'results');
    assert.equal(S.state().res.why, 'time');
    assert.deepEqual(S.state().res.win, []);
  }
  // the host stops a round in progress: back to the lobby, no results sheet
  {
    const S = rig();
    const [a, b] = [S.add(), S.add()];
    await S.play([a, b]);
    S.cmd(b, 'stop');
    assert.equal(S.last(b, 'world-round-no').reason, 'host');
    S.cmd(a, 'stop');
    assert.equal(S.state().ph, 'lobby');
    assert.equal(S.health.isPvp('nuketown'), false);
  }
  // a room that empties forgets its round completely
  {
    const S = rig();
    const [a, b] = [S.add(), S.add()];
    await S.play([a, b]);
    S.remove(a);
    S.remove(b);
    assert.equal(S.rounds.state().phase, 'lobby');
    assert.equal(S.health.isPvp('nuketown'), false);
  }
}
