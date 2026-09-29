/*
 * The other four modes through the round engine (test/rounds.mjs's rig):
 * hide and seek (frozen seekers, a tag by pistol or by punch, infection, last
 * hider standing), the prop hunt (sixty decoys, disguises, hitbox damage rules,
 * the wrong-shot penalty, clean-up), the race (ring order, the speed check,
 * finish times; cars taking turns on the streets) and the build contest
 * (plots claimed and released, votes, the tally).
 */
import assert from 'node:assert/strict';
import { rig, kill } from './rounds.mjs';
import { STREET_LOOP, PLOT_FIELDS } from '../src/roundData.js';

const mode = (R, host, id, level, opt = {}) => {
  R.cmd(host, 'mode', { mode: id, ...(level ? { level } : {}) });
  for (const [key, value] of Object.entries(opt)) R.cmd(host, 'opt', { key, value });
};
const roleOf = (R, ws) => R.part(ws)[2];

export async function hideTests() {
  const R = rig();
  const a = R.add();
  const list = [a, R.add(), R.add(), R.add()];
  mode(R, a, 'hide');
  await R.play(list);
  const seekers = list.filter((ws) => roleOf(R, ws) === 'seeker');
  const hiders = list.filter((ws) => roleOf(R, ws) === 'hider');
  assert.equal(seekers.length, 1, 'one seeker under eight players');
  assert.equal(hiders.length, 3);
  assert.equal(R.health.isPvp('nuketown'), false, 'no fighting in this one');
  assert.ok(R.state().obj.seekAt > R.state().now, 'the seeking starts later');
  const [s] = seekers;
  const [h1, h2, h3] = hiders;

  // the seeker is held where it stood while the others hide: walk off, get walked back
  R.pose(s, 10, 10);
  R.clear();
  R.pose(s, 40, 10);
  R.advance(1200);
  R.pose(s, 45, 10);
  const back = R.last(s, 'world-round-tp');
  assert.ok(back && Math.hypot(back.x - 10, back.z - 10) < 0.1, 'sent back to the spot');
  // and nobody can shoot or tag yet
  assert.equal(R.rounds.mayShoot(s, 0), false, 'no shooting during the hiding');
  assert.equal(R.rounds.mayShoot(h1, 0), false, 'hiders are unarmed');
  R.pose(h1, 12, 10);
  R.cmd(s, 'tag', { target: h1.world.id });
  R.advance(300);
  assert.equal(roleOf(R, h1), 'hider', 'no tags before the seeking');

  R.advance(30_000);
  assert.equal(R.rounds.mayShoot(s, 0), true);
  assert.equal(R.rounds.mayShoot(s, 1), false, 'the pistol only');
  // out of reach: a punch is arm's length
  R.pose(h1, 30, 10);
  R.cmd(s, 'tag', { target: h1.world.id });
  R.advance(700);
  assert.equal(roleOf(R, h1), 'hider', 'too far to punch');
  R.pose(s, 30, 12);
  R.cmd(s, 'tag', { target: h1.world.id });
  R.advance(500);
  assert.equal(roleOf(R, h1), 'seeker', 'a hider punched is caught and infected');
  assert.equal(R.part(s)[4], 1, 'the tagger counts it');
  assert.ok(R.all(s, 'world-round-ev').some((m) => m.code === 'caught' && m.id === h1.world.id));
  // a pistol hit takes no hit points and tags
  R.pose(h2, 50, 50);
  assert.equal(R.rounds.playerHit(s, h2, 0, [50, 2, 50]), true, 'the mode takes the hit');
  R.advance(500);
  assert.equal(roleOf(R, h2), 'seeker');
  assert.equal(R.health.hpOf(h2), 100, 'a tag is not damage');
  assert.equal(R.health.hurt(h3, 30, { by: s.world.id, kind: 'pistol' }), 0, 'and nothing else hurts either');
  // the last hider caught wins the round
  R.advance(700);
  R.rounds.playerHit(h1, h3, 0, [0, 2, 0]);
  R.advance(300);
  assert.equal(R.state().ph, 'results');
  assert.equal(R.state().res.why, 'last');
  assert.deepEqual(R.state().res.win, [h3.world.id], 'the last one found wins');

  // time runs out with hiders alive: the hiders win
  {
    const S = rig();
    const [x, y, z] = [S.add(), S.add(), S.add()];
    mode(S, x, 'hide');
    await S.play([x, y, z]);
    S.advance(271_000);
    assert.equal(S.state().ph, 'results');
    assert.equal(S.state().res.why, 'time');
    const seeker = [x, y, z].find((ws) => S.part(ws)[2] === 'seeker');
    assert.ok(!S.state().res.win.includes(seeker.world.id));
    assert.equal(S.state().res.win.length, 2);
  }
  // the only seeker leaves: a hider takes the job, the round goes on
  {
    const S = rig();
    const [x, y, z] = [S.add(), S.add(), S.add()];
    mode(S, x, 'hide');
    await S.play([x, y, z]);
    const seeker = [x, y, z].find((ws) => S.part(ws)[2] === 'seeker');
    S.remove(seeker);
    S.advance(500);
    assert.equal(S.state().ph, 'playing');
    assert.equal(S.state().p.filter((r) => r[2] === 'seeker').length, 1);
  }
  // it also runs on other maps
  {
    const S = rig();
    const [x, y] = [S.add('overworld'), S.add('overworld')];
    mode(S, x, 'hide', 'overworld');
    assert.equal(S.state().lv, 'overworld');
    await S.play([x, y]);
    assert.equal(S.state().lv, 'overworld');
  }
}

export async function propHuntTests() {
  const R = rig();
  const a = R.add();
  const list = [a, R.add(), R.add(), R.add()];
  mode(R, a, 'prophunt');
  for (const ws of list) R.cmd(ws, 'ready', { on: true });
  R.advance(300);
  assert.equal(R.state().ph, 'countdown');
  // sixty decoys exist from the countdown, owned by the system
  const made = [];
  for (let id = 1; id < 400; id++) {
    const pr = R.props.get('nuketown', id);
    if (pr) made.push(pr);
  }
  assert.equal(made.length, 60, 'sixty decoys');
  assert.ok(made.every((p) => p.owner === 0 && p.share === true && p.authority === list[0].world.id));
  assert.ok(new Set(made.map((p) => p.kind)).size >= 10, 'a mixed lot');
  assert.ok(made.every((p) => p.pose[3] > 0 && p.pose[3] < 400), 'dropped from a little above the ground');
  R.advance(1500);
  assert.equal(R.state().ph, 'playing');
  const hunters = list.filter((ws) => roleOf(R, ws) === 'hunter');
  const props = list.filter((ws) => roleOf(R, ws) === 'prop');
  assert.deepEqual([hunters.length, props.length], [1, 3]);
  const [hunter] = hunters;
  const [p1, p2, p3] = props;
  assert.ok(R.health.isPvp('nuketown'));

  // disguises: any catalogue kind, nothing else
  R.cmd(p1, 'disguise', { kind: 'barrel' });
  assert.equal(R.feed.filter((m) => m.type === 'world-round-dg').at(-1).kind, 'barrel');
  R.advance(500);
  assert.deepEqual(R.state().dg, [[p1.world.id, 'barrel']]);
  R.clear();
  R.cmd(p1, 'disguise', { kind: 'not_a_prop' });
  R.cmd(hunter, 'disguise', { kind: 'crate' });
  R.advance(500);
  assert.equal(R.feed.filter((m) => m.type === 'world-round-dg').length, 0, 'a bad kind, or a hunter, changes nothing');
  R.cmd(p2, 'disguise', { kind: 'crate' });

  // the hunters are held still while the props hide, and cannot shoot
  R.pose(hunter, 5, 5);
  R.pose(hunter, 60, 5);
  R.advance(1200);
  R.pose(hunter, 61, 5);
  assert.ok(R.last(hunter, 'world-round-tp'), 'walked back');
  assert.equal(R.rounds.mayShoot(hunter, 0), false);
  assert.equal(R.rounds.mayShoot(p1, 0), false, 'props hold no gun');
  R.advance(30_000);
  assert.equal(R.rounds.mayShoot(hunter, 0), true);
  assert.equal(R.rounds.mayShoot(hunter, 1), true);
  assert.equal(R.rounds.mayShoot(hunter, 2), false, 'no rockets');
  assert.equal(R.rounds.mayShoot(p1, 0), false);

  // damage: a prop only takes real shots from a hunter
  assert.equal(R.health.hurt(p1, 30, { by: 0, kind: 'fall' }), 0, 'not the world');
  assert.equal(R.health.hurt(p1, 30, { by: p2.world.id, kind: 'pistol' }), 0, 'not another prop');
  assert.equal(R.health.hurt(p1, 30, { by: hunter.world.id, kind: 'blast' }), 0, 'not a blast');
  assert.equal(R.health.hurt(p1, 12, { by: hunter.world.id, kind: 'pistol' }), 12, 'a hunter\'s pistol lands');
  assert.equal(R.health.hpOf(p1), 88);
  // a hunter takes nothing from props, but pays for a wrong shot: 5 hit points
  assert.equal(R.health.hurt(hunter, 12, { by: p1.world.id, kind: 'pistol' }), 0);
  R.rounds.propHit(hunter, 12345, 0);
  assert.equal(R.health.hpOf(hunter), 95, 'shooting a real prop costs 5');
  R.rounds.propHit(hunter, 12345, 0);
  assert.equal(R.health.hpOf(hunter), 95, 'but not twice in a quarter second');
  R.advance(300);
  R.rounds.propHit(hunter, 12345, 0);
  assert.equal(R.health.hpOf(hunter), 90);
  R.rounds.propHit(p1, 12345, 0);
  assert.equal(R.health.hpOf(p1), 88, 'only hunters pay');

  // finding the props one by one
  kill(R, p1, hunter);
  R.advance(500);
  assert.equal(R.part(hunter)[3], 3, 'three points a prop');
  assert.equal(R.state().dg.length, 1, 'a found prop drops its disguise (p2 keeps its own)');
  assert.equal(R.health.isDead(p1), true);
  R.advance(10_000);
  assert.equal(R.health.isDead(p1), true, 'and stays down for the round');
  kill(R, p2, hunter);
  assert.equal(R.state().ph, 'playing');
  kill(R, p3, hunter);
  assert.equal(R.state().ph, 'results');
  assert.equal(R.state().res.why, 'hunted');
  assert.equal(R.state().res.team, 'b');
  assert.deepEqual(R.state().res.win, [hunter.world.id]);
  // clean-up: the decoys and the disguises go with the round
  R.advance(2500);
  assert.equal(R.state().ph, 'lobby');
  assert.equal(R.props.get('nuketown', made[0].id), undefined, 'the decoys are removed');
  assert.deepEqual(R.state().dg, undefined);
  assert.equal(R.health.isDead(p1), false, 'everyone is whole again');

  // survival: the clock runs out with a prop alive
  {
    const S = rig();
    const [x, y] = [S.add(), S.add()];
    mode(S, x, 'prophunt');
    for (const ws of [x, y]) S.cmd(ws, 'ready', { on: true });
    S.advance(1500);
    for (let i = 0; i < 280 && S.state().ph !== "results"; i++) S.advance(1000);
    assert.equal(S.state().ph, 'results');
    assert.equal(S.state().res.why, 'time');
    assert.equal(S.state().res.team, 'a', 'the props win by surviving');
  }
  // all hunters down: the props win
  {
    const S = rig();
    const [x, y, z] = [S.add(), S.add(), S.add()];
    mode(S, x, 'prophunt');
    for (const ws of [x, y, z]) S.cmd(ws, 'ready', { on: true });
    S.advance(2500);
    const hunter2 = [x, y, z].find((ws) => S.part(ws)[2] === 'hunter');
    S.advance(31_000);
    for (let i = 0; i < 30 && S.state().ph === 'playing'; i++) { S.rounds.propHit(hunter2, 1, 0); S.advance(300); }
    assert.equal(S.state().ph, 'results', 'twenty wrong shots kill a hunter');
    assert.equal(S.state().res.why, 'survived');
    assert.equal(S.state().res.team, 'a');
  }
}

export async function raceTests() {
  // on foot in Cubeland: rings in order, checked against the server's own sight of the runner
  const R = rig();
  const [a, b] = [R.add('cubeland'), R.add('cubeland')];
  mode(R, a, 'race', 'cubeland', { laps: 1 });
  assert.equal(R.state().lv, 'cubeland');
  await R.play([a, b]);
  const obj = R.state().obj;
  assert.equal(obj.foot, 1);
  assert.equal(obj.cps.length, 8);
  assert.ok(R.state().obj.goAt > R.state().now, 'a short wait before the gun');
  const cps = obj.cps;
  const run = (ws, i, ms = 0) => {
    const [x, z] = cps[i % cps.length];
    R.pose(ws, x, z);
    R.advance(ms);
    R.cmd(ws, 'cp', { i, x, z });
    R.advance(250);
  };
  R.advance(3500);
  R.pose(a, cps[3][0], cps[3][1]);
  R.cmd(a, 'cp', { i: 3, x: cps[3][0], z: cps[3][1] });
  R.advance(300);
  assert.equal(R.part(a)[4], 0, 'out of order does not count');
  R.pose(a, 0, 0);
  R.cmd(a, 'cp', { i: 0, x: cps[0][0], z: cps[0][1] });
  R.advance(300);
  assert.equal(R.part(a)[4], 0, 'claiming a ring the server did not see you at does not count');
  R.pose(a, cps[0][0], cps[0][1]);
  R.cmd(a, 'cp', { i: 0, x: cps[0][0], z: cps[0][1] });
  R.advance(300);
  assert.equal(R.part(a)[4], 1, 'but the right ring in time does');
  // a teleporting runner: the second ring is 48 units on, in no time at all
  run(a, 1, 0);
  assert.equal(R.part(a)[4], 1, 'faster than a runner can run is refused');
  assert.ok(R.all(a, 'world-round-ev').some((m) => m.code === 'slow'));
  run(a, 1, 3000);
  assert.equal(R.part(a)[4], 2);
  for (let i = 2; i < 8; i++) run(a, i, 4000);
  assert.ok(R.part(a)[5] > 0, 'a finish time');
  for (let i = 0; i < 8; i++) run(b, i, 6000);
  assert.equal(R.state().ph, 'results');
  assert.deepEqual(R.state().res.win, [a.world.id], 'the faster runner wins');
  assert.ok(R.state().res.rows[0][2] > R.state().res.rows[1][2], 'points by place');

  // cars on the street loop take the one machine in turns
  {
    const S = rig();
    const [x, y] = [S.add('overworld'), S.add('overworld')];
    mode(S, x, 'race', 'overworld', { laps: 1 });
    await S.play([x, y]);
    const o = S.state().obj;
    assert.equal(o.foot, 0);
    assert.equal(o.cps.length, STREET_LOOP.cps.length);
    const first = o.turn;
    const driver = first === x.world.id ? x : y;
    const waiter = driver === x ? y : x;
    assert.ok(S.last(driver, 'world-round-tp'), 'the driver is put on the grid');
    S.advance(9000);
    // a waiter's rings do not count
    S.pose(waiter, o.cps[0][0], o.cps[0][1]);
    S.cmd(waiter, 'cp', { i: 0, x: o.cps[0][0], z: o.cps[0][1] });
    S.advance(300);
    assert.equal(S.part(waiter)[4], 0);
    for (let i = 0; i < o.cps.length; i++) {
      const [cx, cz] = o.cps[i];
      S.pose(driver, cx, cz);
      S.advance(5000);
      S.cmd(driver, 'cp', { i, x: cx, z: cz });
      S.advance(250);
    }
    S.advance(500);
    assert.ok(S.part(driver)[5] > 0, 'the driver has a time');
    assert.equal(S.state().obj.turn, waiter.world.id, 'and the turn passes on');
    // the second driver never finishes: their turn times out and the round ends
    for (let i = 0; i < 200 && S.state().ph !== "results"; i++) S.advance(1000);
    assert.equal(S.state().ph, 'results');
    assert.deepEqual(S.state().res.win, [driver.world.id], 'a finish beats a dnf');
  }
}

export async function buildTests() {
  const R = rig();
  const list = [R.add('cubeland'), R.add('cubeland'), R.add('cubeland')];
  const [a, b, c] = list;
  mode(R, a, 'build');
  assert.equal(R.state().lv, 'cubeland');
  await R.play(list);
  assert.equal(R.state().obj.stage, 'build');
  assert.equal(R.state().obj.plots.length, 3);
  assert.equal(R.claimed.size, 12, 'four chunk columns for each: a 32x32-block plot');
  assert.ok([...R.claimed.values()].filter((id) => id === a.world.id).length === 4);
  assert.ok(R.last(a, 'world-round-tp'), 'everyone is put on their plot');
  const theme = R.state().obj.theme;
  assert.ok(theme >= 0 && theme < 10);
  assert.equal(R.rounds.mayShoot(a, 0), false, 'no shooting while building');
  // no voting while building
  R.cmd(a, 'vote', { n: 5 });
  // build for five minutes, then the gallery walks everyone round in turn
  R.advance(300_000);
  assert.equal(R.state().obj.stage, 'gallery');
  const gal1 = R.state().obj.gal;
  assert.equal(gal1.i, 0);
  const owner1 = gal1.plot;
  const ownerWs = list.find((ws) => ws.world.id === owner1);
  assert.ok(R.last(b, 'world-round-tp'), 'all are sent to the plot');
  // votes: 1..5, not your own, one per person per plot (the last stands)
  R.cmd(ownerWs, 'vote', { n: 5 });
  const voters = list.filter((ws) => ws !== ownerWs);
  R.cmd(voters[0], 'vote', { n: 9 });
  R.cmd(voters[0], 'vote', { n: 2 });
  R.advance(1200); // (past the per-second command budget)
  R.cmd(voters[0], 'vote', { n: 4 });
  R.cmd(voters[1], 'vote', { n: 3 });
  R.advance(20_000);
  const gal2 = R.state().obj.gal;
  assert.equal(gal2.i, 1);
  assert.notEqual(gal2.plot, owner1);
  const owner2 = list.find((ws) => ws.world.id === gal2.plot);
  for (const v of list.filter((ws) => ws !== owner2)) { R.cmd(v, 'vote', { n: 5 }); R.advance(1100); }
  R.advance(20_000);
  const owner3 = list.find((ws) => ![owner1, gal2.plot].includes(ws.world.id));
  for (const v of list.filter((ws) => ws !== owner3)) { R.cmd(v, 'vote', { n: 1 }); R.advance(1100); }
  for (let i = 0; i < 40 && R.state().ph !== "results"; i++) R.advance(1000);
  assert.equal(R.state().ph, 'results');
  const rows = Object.fromEntries(R.state().res.rows.map((r) => [r[0], r]));
  assert.equal(rows[owner1][2], 7, 'four and three');
  assert.equal(rows[owner2.world.id][2], 10, 'two fives');
  assert.equal(rows[owner3.world.id][2], 2, 'two ones');
  assert.deepEqual(R.state().res.win, [owner2.world.id]);
  R.advance(2500);
  assert.equal(R.claimed.size, 0, 'the plots are open again afterwards');
  assert.equal(R.state().ph, 'lobby');

  // a builder who leaves gives the plot back
  {
    const S = rig();
    const [x, y, z] = [S.add('cubeland'), S.add('cubeland'), S.add('cubeland')];
    mode(S, x, 'build');
    await S.play([x, y, z]);
    S.remove(z);
    assert.equal(S.claimed.size, 8);
  }
  // a big party gets the big field
  assert.ok(PLOT_FIELDS.at(-1).plots === 8);
}
