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

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: '0',
        ADMIN_TOKEN,
        DB_PATH: path.join(tmpDir, 'chat.db'),
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

  for (const c of [guest, alice, alice2, dup, late, p1, p2]) c.ws.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('smoke test passed');
  process.exit(0);
}

main().catch(fail);
