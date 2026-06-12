// Smoke test: spawns the server as a child process and runs the core
// visitor/admin flows against it over real WebSockets.

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
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return { ws, next, opened, send: (obj) => ws.send(JSON.stringify(obj)) };
}

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: '0',
        ADMIN_TOKEN,
        DB_PATH: path.join(tmpDir, 'messages.db'),
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
  const visitorId = 'smoke-visitor-1';

  // 1. Visitor hello: presence offline, empty history.
  const visitor = connect(url);
  await visitor.opened;
  visitor.send({ type: 'hello', role: 'visitor', id: visitorId, name: 'Smokey' });
  const helloOk = await visitor.next('visitor hello-ok');
  assert.equal(helloOk.type, 'hello-ok');
  assert.equal(helloOk.presence.online, false);
  const history = await visitor.next('visitor history');
  assert.equal(history.type, 'history');
  assert.deepEqual(history.messages, []);
  console.log('1. visitor hello-ok, presence offline, empty history');

  // 2. Visitor sends a message, expects ack.
  visitor.send({ type: 'msg', text: 'hello from the smoke test', tmp: 'tmp-1' });
  const ack = await visitor.next('visitor ack');
  assert.equal(ack.type, 'ack');
  assert.equal(ack.tmp, 'tmp-1');
  assert.ok(Number.isInteger(ack.id));
  assert.ok(typeof ack.at === 'number');
  console.log('2. visitor message acked');

  // 3. Admin hello with bad token gets auth error.
  const badAdmin = connect(url);
  await badAdmin.opened;
  badAdmin.send({ type: 'hello', role: 'admin', token: 'wrong-token' });
  const authErr = await badAdmin.next('auth error');
  assert.equal(authErr.type, 'error');
  assert.equal(authErr.code, 'auth');
  console.log('3. bad admin token rejected with auth error');

  // 4. Admin hello with good token: hello-ok + convos; visitor sees presence.
  const admin = connect(url);
  await admin.opened;
  admin.send({ type: 'hello', role: 'admin', token: ADMIN_TOKEN });
  const adminHello = await admin.next('admin hello-ok');
  assert.equal(adminHello.type, 'hello-ok');
  const convos = await admin.next('admin convos');
  assert.equal(convos.type, 'convos');
  const convo = convos.convos.find((c) => c.id === visitorId);
  assert.ok(convo, 'visitor convo listed');
  assert.equal(convo.lastText, 'hello from the smoke test');
  assert.equal(convo.count, 1);
  assert.equal(convo.name, 'Smokey');
  const presence = await visitor.next('presence online');
  assert.equal(presence.type, 'presence');
  assert.equal(presence.online, true);
  console.log('4. admin authed, convos listed, visitor got presence online');

  // 5. Admin reply reaches the visitor (and echoes to admin).
  admin.send({ type: 'reply', to: visitorId, text: 'hi back' });
  const visitorMsg = await visitor.next('admin reply to visitor');
  assert.equal(visitorMsg.type, 'msg');
  assert.equal(visitorMsg.message.sender, 'admin');
  assert.equal(visitorMsg.message.text, 'hi back');
  const adminEcho = await admin.next('admin echo');
  assert.equal(adminEcho.type, 'msg');
  assert.equal(adminEcho.convo, visitorId);
  assert.equal(adminEcho.message.text, 'hi back');
  console.log('5. admin reply delivered to visitor and echoed to admin');

  // 6. Admin open returns both messages, oldest first.
  admin.send({ type: 'open', id: visitorId });
  const adminHistory = await admin.next('admin history');
  assert.equal(adminHistory.type, 'history');
  assert.equal(adminHistory.convo, visitorId);
  assert.equal(adminHistory.messages.length, 2);
  assert.equal(adminHistory.messages[0].sender, 'visitor');
  assert.equal(adminHistory.messages[1].sender, 'admin');
  console.log('6. admin open returned full history, oldest first');

  visitor.ws.close();
  admin.ws.close();
  badAdmin.ws.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('smoke test passed');
  process.exit(0);
}

main().catch(fail);
