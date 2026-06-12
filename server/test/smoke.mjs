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

  for (const c of [guest, alice, alice2, dup, late]) c.ws.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('smoke test passed');
  process.exit(0);
}

main().catch(fail);
