// Smoke test for chat server v2: spawns the server as a child process and
// runs the register/login/guest + rooms flows against it over real WebSockets.

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-smoke-'));
const ADMIN_TOKEN = 'test-token';
const STEP_TIMEOUT_MS = 5000;

let child;

function fail(err) {
  console.error('FAIL:', err);
  if (child) child.kill('SIGKILL');
  process.exit(1);
}

// Wrap a ws connection in a message queue with awaitable reads.
function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (waiters.length > 0) waiters.shift()(msg);
    else queue.push(msg);
  });
  const next = (label) =>
    new Promise((resolve, reject) => {
      if (queue.length > 0) return resolve(queue.shift());
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for: ${label}`)),
        STEP_TIMEOUT_MS
      );
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  // Skip broadcast chatter (rooms/users/typing) until a given type arrives.
  const nextOf = async (type, label) => {
    for (let i = 0; i < 20; i++) {
      const msg = await next(label);
      if (msg.type === type) return msg;
    }
    throw new Error(`never saw a ${type} message (${label})`);
  };
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return { ws, next, nextOf, opened, send: (obj) => ws.send(JSON.stringify(obj)) };
}

function startServer(port = '0') {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_TOKEN,
        DB_PATH: path.join(tmpDir, 'chat.db'),
        // analytics against a throwaway local libsql file — the same code path
        // a Turso URL takes, without needing the network
        ANALYTICS_URL: `file:${path.join(tmpDir, 'analytics.db')}`,
        ANALYTICS_SITE_HOSTS: 'aleju.dev',
        ALLOWED_ORIGINS: 'https://aleju.dev',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = out.match(/listening on port (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code})`)));
    setTimeout(() => reject(new Error('server did not start in time')), STEP_TIMEOUT_MS);
  });
}

async function main() {
  const port = await startServer();
  const url = `ws://127.0.0.1:${port}/ws`;

  // 1. Guest hello: gets a guest name and the room list.
  const guest = connect(url);
  await guest.opened;
  guest.send({ type: 'hello' });
  const guestHello = await guest.nextOf('hello-ok', 'guest hello-ok');
  assert.equal(guestHello.user, null);
  assert.match(guestHello.you, /^guest-/);
  assert.ok(guestHello.rooms.some((r) => r.id === 'general'));
  console.log('1. guest hello-ok with guest name and room list');

  // 2. Register a user, get a token back.
  const alice = connect(url);
  await alice.opened;
  alice.send({ type: 'hello' });
  await alice.nextOf('hello-ok', 'alice hello-ok');
  alice.send({ type: 'register', username: 'alice', password: 'hunter2' });
  const reg = await alice.nextOf('auth-ok', 'alice auth-ok');
  assert.equal(reg.user.name, 'alice');
  assert.equal(reg.user.admin, false);
  assert.ok(typeof reg.token === 'string' && reg.token.length > 20);
  console.log('2. registration returns token and user');

  // 3. Duplicate username is rejected.
  const dup = connect(url);
  await dup.opened;
  dup.send({ type: 'hello' });
  await dup.nextOf('hello-ok', 'dup hello-ok');
  dup.send({ type: 'register', username: 'alice', password: 'whatever' });
  const dupErr = await dup.nextOf('error', 'dup error');
  assert.equal(dupErr.code, 'taken');
  console.log('3. duplicate username rejected');

  // 4. Token resume: a fresh socket with the token is alice again.
  const alice2 = connect(url);
  await alice2.opened;
  alice2.send({ type: 'hello', token: reg.token });
  const resumed = await alice2.nextOf('hello-ok', 'alice resume');
  assert.equal(resumed.user.name, 'alice');
  assert.equal(resumed.badToken, false);
  console.log('4. token resume works');

  // 5. Wrong password and admin login.
  dup.send({ type: 'login', username: 'alice', password: 'wrong' });
  const loginErr = await dup.nextOf('error', 'bad login');
  assert.equal(loginErr.code, 'auth');
  dup.send({ type: 'login', username: 'aleju', password: ADMIN_TOKEN });
  const adminOk = await dup.nextOf('auth-ok', 'admin login');
  assert.equal(adminOk.user.admin, true);
  console.log('5. wrong password rejected, admin login flagged admin');

  // 6. Join a room, send a message, others receive it with identity flags.
  alice2.send({ type: 'join', room: 'general' });
  const aliceHistory = await alice2.nextOf('history', 'alice history');
  assert.equal(aliceHistory.room, 'general');
  assert.deepEqual(aliceHistory.messages, []);
  guest.send({ type: 'join', room: 'general' });
  await guest.nextOf('history', 'guest history');

  alice2.send({ type: 'msg', room: 'general', text: 'hello rooms', tmp: 'tmp-1' });
  const ack = await alice2.nextOf('ack', 'alice ack');
  assert.equal(ack.tmp, 'tmp-1');
  assert.ok(Number.isInteger(ack.id));
  const received = await guest.nextOf('msg', 'guest receives');
  assert.equal(received.room, 'general');
  assert.equal(received.message.from, 'alice');
  assert.equal(received.message.registered, true);
  assert.equal(received.message.admin, false);
  console.log('6. room message delivered with identity flags');

  // 7. History persists: a new joiner sees the message.
  const late = connect(url);
  await late.opened;
  late.send({ type: 'hello' });
  await late.nextOf('hello-ok', 'late hello-ok');
  late.send({ type: 'join', room: 'general' });
  const lateHistory = await late.nextOf('history', 'late history');
  assert.equal(lateHistory.messages.length, 1);
  assert.equal(lateHistory.messages[0].text, 'hello rooms');
  console.log('7. room history persists for late joiners');

  // 8. Guests cannot take a registered name as a nick.
  guest.send({ type: 'nick', name: 'alice' });
  const nickErr = await guest.nextOf('error', 'nick taken');
  assert.equal(nickErr.code, 'taken');
  guest.send({ type: 'nick', name: 'wanderer' });
  const nickOk = await guest.nextOf('nick-ok', 'nick ok');
  assert.equal(nickOk.name, 'wanderer');
  console.log('8. nick protection works, free nicks accepted');

  // 9. Leaderboards: best-only upserts, ranks, asc games treat lower as better.
  alice2.send({ type: 'score-submit', game: 'snake', score: 12 });
  const s1 = await alice2.nextOf('score-ok', 'first snake score');
  assert.equal(s1.best, 12);
  assert.equal(s1.improved, true);
  assert.equal(s1.rank, 1);
  alice2.send({ type: 'score-submit', game: 'snake', score: 8 });
  const s2 = await alice2.nextOf('score-ok', 'worse snake score');
  assert.equal(s2.best, 12);
  assert.equal(s2.improved, false);
  guest.send({ type: 'score-submit', game: 'snake', score: 20 });
  await guest.nextOf('score-ok', 'guest snake score');
  alice2.send({ type: 'score-top', game: 'snake' });
  const top = await alice2.nextOf('score-top', 'snake top');
  assert.equal(top.top.length, 2);
  assert.equal(top.top[0].score, 20);
  assert.equal(top.you.score, 12);
  assert.equal(top.you.rank, 2);
  alice2.send({ type: 'score-submit', game: 'mine-beginner', score: 45000 });
  await alice2.nextOf('score-ok', 'first time');
  alice2.send({ type: 'score-submit', game: 'mine-beginner', score: 30000 });
  const t2 = await alice2.nextOf('score-ok', 'better time');
  assert.equal(t2.best, 30000);
  assert.equal(t2.improved, true);
  console.log('9. leaderboards keep bests and rank both directions');

  // 10. Mine Duel: queue two players and play a whole match.
  const p1 = connect(url);
  const p2 = connect(url);
  await p1.opened;
  await p2.opened;
  p1.send({ type: 'hello' });
  await p1.nextOf('hello-ok', 'p1 hello');
  p2.send({ type: 'hello' });
  await p2.nextOf('hello-ok', 'p2 hello');
  p1.send({ type: 'duel-queue' });
  await p1.nextOf('duel-queued', 'p1 queued');
  p2.send({ type: 'duel-queue' });
  const start1 = await p1.nextOf('duel-start', 'p1 start');
  const start2 = await p2.nextOf('duel-start', 'p2 start');
  assert.equal(start1.phase, 'plant');
  assert.notEqual(start1.seat, start2.seat);
  const bySeat = (seat) => (start1.seat === seat ? p1 : p2);

  p1.send({ type: 'duel-plant', cells: [0, 1, 2, 3, 4] });
  p2.send({ type: 'duel-plant', cells: [5, 6, 7, 8, 9] });
  const phase1 = await p1.nextOf('duel-phase', 'dig phase');
  assert.equal(phase1.phase, 'dig');

  // cell 99 sits far from every mine: safe, and its count must be zero
  bySeat(phase1.turn).send({ type: 'duel-dig', cell: 99 });
  const dug1 = await p1.nextOf('duel-dug', 'dig 99');
  assert.equal(dug1.mine, false);
  assert.equal(dug1.count, 0);

  // digging out of turn is rejected
  bySeat(phase1.turn).send({ type: 'duel-dig', cell: 98 });
  const offTurn = await bySeat(phase1.turn).nextOf('error', 'off-turn dig');
  assert.equal(offTurn.code, 'bad_request');

  // three mine hits drain the duel: 2-1, then 1-1, then 1-0 ends it
  bySeat(dug1.turn).send({ type: 'duel-dig', cell: 0 });
  const dug2 = await p1.nextOf('duel-dug', 'dig mine 0');
  assert.equal(dug2.mine, true);
  assert.equal(dug2.lives[dug1.turn], 1);
  bySeat(dug2.turn).send({ type: 'duel-dig', cell: 1 });
  const dug3 = await p1.nextOf('duel-dug', 'dig mine 1');
  assert.equal(dug3.mine, true);
  bySeat(dug3.turn).send({ type: 'duel-dig', cell: 2 });
  await p1.nextOf('duel-dug', 'dig mine 2');
  // hits landed on the 2nd, 1st, 2nd digger: the opening digger survives
  const over = await p1.nextOf('duel-over', 'duel over');
  assert.equal(over.reason, 'lives');
  assert.equal(over.winner, phase1.turn);
  assert.equal(over.mines[start1.seat].length, 5);
  await p2.nextOf('duel-over', 'p2 sees over');
  console.log('10. duel plays out: plant, turn order, lives, board reveal');

  // 11. The win landed on the duel board.
  p1.send({ type: 'score-top', game: 'duel' });
  const duelTop = await p1.nextOf('score-top', 'duel top');
  assert.equal(duelTop.top.length, 1);
  assert.equal(duelTop.top[0].score, 1);
  console.log('11. duel win recorded on the shared board');

  // 12. Analytics reads are admin-only, over the socket that already proved
  //     who it is. alice2 is a registered non-admin.
  const origin = 'https://aleju.dev';
  const httpBase = `http://127.0.0.1:${port}`;
  alice2.send({ type: 'peeko-monitor', rangeHours: 24 });
  const forbidden = await alice2.nextOf('error', 'non-admin monitor');
  assert.equal(forbidden.code, 'forbidden');
  console.log('12. analytics reads refused to a non-admin socket');

  // 13. Capture is public (browsers post to it cross-origin) but origin-checked.
  const capture = (body, headers = {}) =>
    fetch(`${httpBase}/peeko/capture`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'user-agent': 'Mozilla/5.0 (smoke test)',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  const preflight = await fetch(`${httpBase}/peeko/capture`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);

  const badOrigin = await capture({ event: '$pageview' }, { origin: 'https://evil.example' });
  assert.equal(badOrigin.status, 403);

  // the dashboard's own read routes must not be reachable over HTTP at all
  for (const route of ['/peeko/monitor?rangeHours=24', '/peeko/live-ticket']) {
    const res = await fetch(httpBase + route, { headers: { origin } });
    assert.equal(res.status, 404, `${route} must not be served`);
  }
  console.log('13. capture is origin-checked; monitor/live-ticket unreachable over http');

  // 14. Admin subscribes to the live feed, then a capture arrives on it.
  dup.send({ type: 'peeko-live', on: true });
  const pageview = (distinctId, pathname) => ({
    event: '$pageview',
    distinct_id: distinctId,
    timestamp: new Date().toISOString(),
    properties: {
      $host: 'aleju.dev',
      $pathname: pathname,
      $screen_width: 1920,
      $referring_domain: 'google.com',
    },
  });
  const accepted = await capture({ batch: [pageview('visitor-a', '/'), pageview('visitor-b', '/projects/aula')] });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).accepted, 2);
  const liveEvent = await dup.nextOf('peeko-event', 'live analytics event');
  assert.equal(liveEvent.event.event, '$pageview');
  assert.equal(liveEvent.event.deviceKind, 'desktop');
  console.log('14. live feed pushes captured events to the admin socket');

  // 15. The rollup sees them once the 1s write buffer flushes.
  let monitor = null;
  for (let i = 0; i < 20 && !(monitor?.overview.pageviews >= 2); i++) {
    await new Promise((r) => setTimeout(r, 250));
    dup.send({ type: 'peeko-monitor', rangeHours: 24 });
    monitor = await dup.nextOf('peeko-monitor', 'admin monitor');
  }
  assert.ok(monitor.overview.pageviews >= 2, 'pageviews landed in the store');
  assert.ok(monitor.overview.uniqueVisitors >= 2, 'unique visitors counted');
  // "/" must survive: peeko drops bare root pageviews by default and the
  // portfolio's front page is exactly that
  assert.ok(monitor.topPaths.some((p) => p.path === '/'), 'root pageview kept');
  assert.ok(monitor.topReferrers.some((r) => r.domain === 'google.com'));
  assert.equal(monitor.rangeHours, 24);
  console.log('15. admin rollup counts pageviews, uniques, paths and referrers');

  // 16. Breakdown reaches into custom event properties.
  await capture({
    batch: [
      { event: 'project_view', distinct_id: 'visitor-a', properties: { $host: 'aleju.dev', slug: 'aula' } },
      { event: 'project_view', distinct_id: 'visitor-b', properties: { $host: 'aleju.dev', slug: 'aula' } },
    ],
  });
  let rows = [];
  for (let i = 0; i < 20 && rows.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
    dup.send({ type: 'peeko-breakdown', event: 'project_view', prop: 'slug', rangeHours: 24 });
    rows = (await dup.nextOf('peeko-breakdown', 'admin breakdown')).rows;
  }
  assert.equal(rows[0].value, 'aula');
  assert.equal(rows[0].count, 2);
  console.log('16. breakdown aggregates a custom event property');

  // 16b. Geo: with no edge header, the browser's timezone resolves the country.
  await capture({
    event: '$pageview',
    distinct_id: 'tz-visitor',
    properties: { $host: 'aleju.dev', $pathname: '/from-tz' },
  });
  const tzCapture = await fetch(`${httpBase}/peeko/capture?tz=${encodeURIComponent('America/Costa_Rica')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'user-agent': 'Mozilla/5.0 (smoke test)' },
    body: JSON.stringify({
      event: '$pageview',
      distinct_id: 'tz-visitor-cr',
      properties: { $host: 'aleju.dev', $pathname: '/from-tz' },
    }),
  });
  assert.equal(tzCapture.status, 200);
  let countries = [];
  for (let i = 0; i < 20 && countries.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
    dup.send({ type: 'peeko-monitor', rangeHours: 24 });
    countries = (await dup.nextOf('peeko-monitor', 'monitor for countries')).topCountries;
  }
  assert.ok(
    countries.some((c) => c.country === 'CR'),
    'America/Costa_Rica must resolve to CR'
  );
  console.log('16b. timezone resolves a country when no geo header is present');

  // 17. The open world: roster, level-scoped snapshots, chat and the WebRTC
  //     signalling relay. The scoping assertion is the load-bearing one — a
  //     visitor in the backrooms must not be shipped the overworld's crowd.
  const w1 = connect(url);
  const w2 = connect(url);
  await Promise.all([w1.opened, w2.opened]);
  w1.send({ type: 'hello', nick: 'walker-one' });
  w2.send({ type: 'hello', nick: 'walker-two' });
  await w1.nextOf('hello-ok', 'w1 hello');
  await w2.nextOf('hello-ok', 'w2 hello');

  w1.send({ type: 'world-join', level: 'overworld' });
  const welcome1 = await w1.nextOf('world-welcome', 'first walker welcome');
  assert.equal(welcome1.players.length, 0, 'first in is alone');
  assert.ok(Number.isInteger(welcome1.you));
  // voice needs somewhere to look for a path to its peers. STUN always; a TURN
  // relay only where the deployment configured one, and never a static password
  assert.ok(Array.isArray(welcome1.ice) && welcome1.ice.length > 0, 'ICE servers offered at join');
  assert.ok(
    welcome1.ice.every((s) => !s.credential),
    'no TURN credential is minted when TURN_URLS is unset'
  );

  w2.send({ type: 'world-join', level: 'overworld' });
  const welcome2 = await w2.nextOf('world-welcome', 'second walker welcome');
  assert.deepEqual(
    welcome2.players.map((p) => p.name),
    ['walker-one'],
    'the welcome carries who is already out there'
  );
  const entered = await w1.nextOf('world-enter', 'w1 sees w2 arrive');
  assert.equal(entered.player.id, welcome2.you);
  assert.equal(entered.player.name, 'walker-two');
  assert.equal(entered.player.registered, false);

  // a move reaches the other walker as a compact tuple, rounded on the wire
  w2.send({ type: 'world-move', x: 12.3456, y: 1.5, z: -8, yaw: 1.5708, pitch: 0, gait: 0.5, f: 3 });
  const tick = await w1.nextOf('world-tick', 'snapshot after a move');
  const seen = tick.players.find((p) => p[0] === welcome2.you);
  assert.ok(seen, 'the snapshot carries the walker that moved');
  assert.equal(seen[1], 12.35, 'positions are rounded to centimetres');
  assert.equal(seen[7], 3, 'pose flags survive the trip');

  // stepping through a level seam takes you out of everyone else's snapshot
  w2.send({ type: 'world-level', level: 'backrooms' });
  const scoped = await w1.nextOf('world-tick', 'snapshot after the seam');
  assert.deepEqual(
    scoped.players.map((p) => p[0]),
    [welcome1.you],
    'a walker in another level is not in this one\'s snapshot'
  );
  w2.send({ type: 'world-level', level: 'overworld' });
  await w1.nextOf('world-tick', 'snapshot after coming back');

  w1.send({ type: 'world-chat', text: '  hello out there  ' });
  const shout = await w2.nextOf('world-chat', 'world chat delivered');
  assert.equal(shout.text, 'hello out there', 'chat is trimmed like room chat');
  assert.equal(shout.id, welcome1.you);
  assert.equal(shout.name, 'walker-one');

  // voice signalling is relayed verbatim between two named peers
  w1.send({ type: 'world-signal', to: welcome2.you, data: { sdp: 'v=0', kind: 'offer' } });
  const signal = await w2.nextOf('world-signal', 'webrtc offer relayed');
  assert.equal(signal.from, welcome1.you);
  assert.deepEqual(signal.data, { sdp: 'v=0', kind: 'offer' });

  // a signal aimed at nobody is dropped in silence, not punished: the sender
  // must still be connected and usable afterwards
  w1.send({ type: 'world-signal', to: 999_999, data: { sdp: 'v=0' } });
  w1.send({ type: 'world-chat', text: 'still here' });
  assert.equal((await w2.nextOf('world-chat', 'sender survived a stray signal')).text, 'still here');

  // identity: a look is an opaque 24-hex string this process relays without
  // parsing, and a rename goes through the chat server's own nick because one
  // socket carries one identity. Both have to reach the people standing next
  // to you, and a look also has to survive into a late arrival's roster —
  // otherwise somebody who joins after you painted yourself sees the default
  // robot until you happen to repaint.
  const LOOK_A = 'a8bfa6' + '2b3a44' + 'b8913f' + '8fe6b4';
  w2.send({ type: 'world-look', look: LOOK_A });
  const painted = await w1.nextOf('world-look', 'a repaint reaches the other walker');
  assert.equal(painted.id, welcome2.you);
  assert.equal(painted.look, LOOK_A, 'the pack is relayed byte for byte');

  w2.send({ type: 'nick', name: 'painted-two' });
  assert.equal((await w2.nextOf('nick-ok', 'the rename is accepted')).name, 'painted-two');
  const renamed = await w1.nextOf('world-name', 'a rename reaches the other walker');
  assert.equal(renamed.id, welcome2.you);
  assert.equal(renamed.name, 'painted-two');

  const w3 = connect(url);
  await w3.opened;
  w3.send({ type: 'hello', nick: 'walker-three' });
  await w3.nextOf('hello-ok', 'w3 hello');
  w3.send({ type: 'world-join', level: 'overworld' });
  const welcome3 = await w3.nextOf('world-welcome', 'late arrival welcome');
  const already = welcome3.players.find((p) => p.id === welcome2.you);
  assert.equal(already.look, LOOK_A, 'a late arrival is told how everyone is painted');
  assert.equal(already.name, 'painted-two', 'and under the name they renamed to');
  assert.equal(
    welcome3.players.find((p) => p.id === welcome1.you).look,
    undefined,
    'somebody who never repainted carries no look at all'
  );
  await w1.nextOf('world-enter', 'w1 sees w3 arrive');
  await w2.nextOf('world-enter', 'w2 sees w3 arrive');
  w3.ws.close();
  await w1.nextOf('world-exit', 'w3 departure announced');
  await w2.nextOf('world-exit', 'w2 hears it too');

  console.log('17. open world: roster, level-scoped snapshots, chat, voice signalling, identity');

  // 17b. The fleet. This is the only world state the process holds and the
  //      only question it actually arbitrates, so the assertions that matter
  //      are the refusals: a taken chair is refused, and a transform from
  //      anyone but the driver is ignored outright.
  // the table is broadcast whole, to everyone, including the claimant — so
  // both sockets consume every announcement below
  w1.send({ type: 'world-seat', v: 0, seat: 0 });
  const seats1 = await w2.nextOf('world-seats', 'the seat table is broadcast');
  await w1.nextOf('world-seats', 'the claimant hears it too');
  assert.deepEqual(seats1.seats[0], [0, welcome1.you, 0], 'w1 has the wheel of the car');

  // the same chair, a round trip later
  w2.send({ type: 'world-seat', v: 0, seat: 0 });
  const denied = await w2.nextOf('world-seat-denied', 'a taken chair is refused');
  assert.equal(denied.v, 0);
  assert.equal(denied.seat, 0);

  // ...but the other one is free
  w2.send({ type: 'world-seat', v: 0, seat: 1 });
  const seats2 = await w1.nextOf('world-seats', 'the passenger seat is granted');
  await w2.nextOf('world-seats', 'and the passenger hears it too');
  assert.deepEqual(seats2.seats[0], [0, welcome1.you, welcome2.you], 'two up in the car');

  // only the driver may say where the machine is
  w2.send({ type: 'world-vehicle', v: 0, x: 999, y: 999, z: 999, yaw: 0, pitch: 0, roll: 0 });
  w1.send({ type: 'world-vehicle', v: 0, x: 40.005, y: 2, z: -8, yaw: 0.5, pitch: 0.1, roll: -0.2 });
  let vtick = await w2.nextOf('world-tick', 'a driven machine rides the snapshot');
  while (!vtick.vehicles) vtick = await w2.nextOf('world-tick', 'waiting for the vehicle row');
  assert.deepEqual(
    vtick.vehicles[0],
    [0, 40.01, 2, -8, 0.5, 0.1, -0.2],
    'the driver\'s transform is relayed, rounded, and the passenger\'s is not'
  );

  // one body, one chair: claiming another gives up the last
  w2.send({ type: 'world-seat', v: 2, seat: 0 });
  const seats3 = await w1.nextOf('world-seats', 'moving between machines');
  await w2.nextOf('world-seats', 'the mover hears it too');
  assert.deepEqual(seats3.seats[0], [0, welcome1.you, 0], 'the car seat was given up');
  assert.deepEqual(seats3.seats[2], [2, welcome2.you, 0], 'and the helicopter taken');

  // a level seam is getting out
  w2.send({ type: 'world-level', level: 'backrooms' });
  const seats4 = await w1.nextOf('world-seats', 'a level change frees the chair');
  await w2.nextOf('world-seats', 'the leaver hears it too');
  assert.deepEqual(seats4.seats[2], [2, 0, 0], 'nobody flies into the backrooms');
  w2.send({ type: 'world-level', level: 'overworld' });

  w1.ws.close();
  const exited = await w2.nextOf('world-exit', 'walker departure announced');
  assert.equal(exited.id, welcome1.you);
  // a dropped driver must not leave the car locked forever
  const seats5 = await w2.nextOf('world-seats', 'a dropped socket frees its seat');
  assert.deepEqual(seats5.seats[0], [0, 0, 0], 'the abandoned car is claimable again');
  w2.ws.close();
  console.log('17b. open world: seat arbitration, driver-only transforms, seats freed on exit');

  // 18. An admin session survives a restart. It used to live only in memory,
  //     so every deploy silently turned a still-logged-in admin into a guest:
  //     the browser kept a session it believed in, and everything that socket
  //     did afterwards — arcade scores especially — was filed under a guest
  //     name while the desktop still said "administrator".
  for (const c of [guest, alice, alice2, dup, late, p1, p2]) c.ws.close();
  const adminToken = adminOk.token;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  await startServer(port);

  const reborn = connect(url);
  await reborn.opened;
  reborn.send({ type: 'hello', token: adminToken });
  const rebornHello = await reborn.nextOf('hello-ok', 'admin resume after restart');
  assert.equal(rebornHello.badToken, false, 'admin token must outlive the process');
  assert.equal(rebornHello.user.admin, true);
  assert.equal(rebornHello.you, 'aleju');

  // the visible symptom: the score has to carry the real name
  reborn.send({ type: 'score-submit', game: 'pong', score: 42 });
  await reborn.nextOf('score-ok', 'post-restart score');
  reborn.send({ type: 'score-top', game: 'pong' });
  const board = await reborn.nextOf('score-top', 'post-restart board');
  assert.equal(board.top[0].name, 'aleju');
  assert.equal(board.top[0].admin, true);

  // and analytics still recognises it as the admin
  reborn.send({ type: 'peeko-monitor', rangeHours: 24 });
  await reborn.nextOf('peeko-monitor', 'admin monitor after restart');
  console.log('18. admin session survives a restart: score keeps the real name');

  reborn.ws.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('smoke test passed');
  process.exit(0);
}

main().catch(fail);
