// AlejOS chat server v2: registered users + public chat rooms.
//
// Visitors register a real account (or stay guests) at the AlejOS login
// screen, then talk in shared rooms — #general, #projects, #random — like a
// tiny Discord. Accounts, tokens and room history persist in SQLite. The
// site owner logs in with the reserved username and ADMIN_TOKEN as the
// password, and his messages carry the admin badge.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME ?? 'aleju').toLowerCase();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DB_PATH = process.env.DB_PATH ?? './data/chat.db';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required, refusing to start');
  process.exit(1);
}

export const ROOMS = ['general', 'projects', 'random'];

const MAX_TEXT_LEN = 600;
const HISTORY_LIMIT = 60;
const MAX_MESSAGES_PER_ROOM = 500;
const TRIM_EVERY = 50; // amortize history trimming; rooms may briefly hold cap + this
const TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;
const TOKEN_SWEEP_MS = 60 * 60_000;
const MSG_RATE_MAX = 12; // messages per window per connection
const MSG_RATE_WINDOW_MS = 30_000;
const AUTH_RATE_MAX = 10; // register/login attempts per window per ip
const AUTH_RATE_WINDOW_MS = 10 * 60_000;
const TYPING_FORWARD_MS = 1_000;
const HEARTBEAT_MS = 30_000;
const MAX_STRIKES = 3;
const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;
const NICK_RE = /^[\p{L}\p{N} _.-]{2,24}$/u;
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 100;

// ---------------------------------------------------------------- database

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// NORMAL is safe with WAL: a power cut can lose the last moments of chat,
// never corrupt the file. Cuts fsyncs per write dramatically.
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    from_name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_registered INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_room_messages ON room_messages(room, id);
`);

const stmt = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare(
    'INSERT INTO users (username, hash, salt, created_at) VALUES (?, ?, ?, ?)'
  ),
  insertToken: db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)'),
  userByToken: db.prepare(
    'SELECT u.*, t.created_at AS token_at FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?'
  ),
  deleteExpiredTokens: db.prepare('DELETE FROM tokens WHERE created_at < ?'),
  insertMessage: db.prepare(
    'INSERT INTO room_messages (room, from_name, is_admin, is_registered, text, at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  trimMessages: db.prepare(`
    DELETE FROM room_messages WHERE room = ? AND id NOT IN (
      SELECT id FROM room_messages WHERE room = ? ORDER BY id DESC LIMIT ?
    )
  `),
  history: db.prepare(`
    SELECT id, from_name, is_admin, is_registered, text, at FROM (
      SELECT * FROM room_messages WHERE room = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `),
};

// Startup maintenance: drop expired sessions and any history overflow left
// over from a previous run.
stmt.deleteExpiredTokens.run(Date.now() - TOKEN_TTL_MS);
for (const room of ROOMS) stmt.trimMessages.run(room, room, MAX_MESSAGES_PER_ROOM);

// ---------------------------------------------------------------- auth

// Async scrypt runs on the libuv threadpool instead of blocking the event
// loop for the ~50ms a hash takes, so chat stays smooth during logins.
const scrypt = promisify(crypto.scrypt);

async function hashPassword(password, salt) {
  const buf = await scrypt(password, salt, 64);
  return buf.toString('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function adminTokenMatches(password) {
  if (typeof password !== 'string') return false;
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function createToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  stmt.insertToken.run(token, userId, Date.now());
  return token;
}

// ---------------------------------------------------------------- helpers

function sanitizeText(raw) {
  if (typeof raw !== 'string') return null;
  // Strip control characters except newline, then trim.
  return raw.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim();
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sendError(ws, code, message) {
  send(ws, message ? { type: 'error', code, message } : { type: 'error', code });
}

function strike(ws) {
  sendError(ws, 'bad_request');
  ws.strikes = (ws.strikes ?? 0) + 1;
  if (ws.strikes >= MAX_STRIKES) ws.close(1008, 'too many bad messages');
}

// ---------------------------------------------------------------- live state

// perMessageDeflate stays off: zlib contexts cost ~100KB+ per socket, far
// more than these tiny JSON payloads could ever save.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 8 * 1024,
  perMessageDeflate: false,
});
const roomSockets = new Map(ROOMS.map((r) => [r, new Set()])); // room -> Set<ws>
const msgRateByConn = new WeakMap(); // ws -> [timestamps]
const authRateByIp = new Map(); // ip -> [timestamps]
const typingLast = new WeakMap(); // ws -> last forward timestamp

function recentHits(arr, now, windowMs) {
  return arr.filter((t) => now - t < windowMs);
}

function allowAuth(ip) {
  const now = Date.now();
  const hits = recentHits(authRateByIp.get(ip) ?? [], now, AUTH_RATE_WINDOW_MS);
  authRateByIp.set(ip, hits);
  if (hits.length >= AUTH_RATE_MAX) return false;
  hits.push(now);
  return true;
}

function allowMessage(ws) {
  const now = Date.now();
  const hits = recentHits(msgRateByConn.get(ws) ?? [], now, MSG_RATE_WINDOW_MS);
  msgRateByConn.set(ws, hits);
  if (hits.length >= MSG_RATE_MAX) return false;
  hits.push(now);
  return true;
}

function displayName(ws) {
  return ws.user?.username ?? ws.nick;
}

function userPayload(ws) {
  return {
    name: displayName(ws),
    admin: Boolean(ws.isAdmin),
    registered: Boolean(ws.user),
  };
}

function roomUsers(room) {
  const seen = new Map();
  for (const ws of roomSockets.get(room) ?? []) {
    const u = userPayload(ws);
    seen.set(u.name.toLowerCase(), u);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.admin !== b.admin) return a.admin ? -1 : 1;
    if (a.registered !== b.registered) return a.registered ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function broadcastRoom(room, payload, except = null) {
  for (const ws of roomSockets.get(room) ?? []) {
    if (ws !== except) send(ws, payload);
  }
}

function broadcastRoomUsers(room) {
  broadcastRoom(room, { type: 'users', room, users: roomUsers(room) });
}

function roomList() {
  return ROOMS.map((room) => ({ id: room, users: (roomSockets.get(room) ?? new Set()).size }));
}

function broadcastRoomList() {
  const payload = { type: 'rooms', rooms: roomList() };
  for (const ws of wss.clients) send(ws, payload);
}

function leaveRoom(ws, { silent = false } = {}) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  const set = roomSockets.get(room);
  if (set) set.delete(ws);
  if (!silent) {
    broadcastRoomUsers(room);
    broadcastRoomList();
  }
}

// nicknames may not impersonate registered users or the admin
function nickAvailable(nick) {
  const lower = nick.toLowerCase();
  if (lower === ADMIN_USERNAME) return false;
  if (stmt.userByName.get(lower)) return false;
  return true;
}

function rowToMessage(row) {
  return {
    id: row.id,
    from: row.from_name,
    admin: Boolean(row.is_admin),
    registered: Boolean(row.is_registered),
    text: row.text,
    at: row.at,
  };
}

const insertsSinceTrim = new Map(ROOMS.map((r) => [r, 0]));

function storeMessage(room, ws, text) {
  const at = Date.now();
  const { lastInsertRowid } = stmt.insertMessage.run(
    room,
    displayName(ws),
    ws.isAdmin ? 1 : 0,
    ws.user ? 1 : 0,
    text,
    at
  );
  const inserts = insertsSinceTrim.get(room) + 1;
  if (inserts >= TRIM_EVERY) {
    stmt.trimMessages.run(room, room, MAX_MESSAGES_PER_ROOM);
    insertsSinceTrim.set(room, 0);
  } else {
    insertsSinceTrim.set(room, inserts);
  }
  return {
    id: Number(lastInsertRowid),
    from: displayName(ws),
    admin: Boolean(ws.isAdmin),
    registered: Boolean(ws.user),
    text,
    at,
  };
}

// ---------------------------------------------------------------- handlers

async function handleRegister(ws, msg) {
  if (!allowAuth(ws.ip)) {
    sendError(ws, 'rate');
    return;
  }
  const username = typeof msg.username === 'string' ? msg.username.toLowerCase().trim() : '';
  const password = typeof msg.password === 'string' ? msg.password : '';
  if (!USERNAME_RE.test(username) || username === ADMIN_USERNAME) {
    sendError(ws, 'invalid', 'Username must be 3-20 chars: a-z, 0-9, _ or -.');
    return;
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    sendError(ws, 'invalid', `Password must be at least ${PASSWORD_MIN} characters.`);
    return;
  }
  if (stmt.userByName.get(username)) {
    sendError(ws, 'taken', 'That username is already registered.');
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  let lastInsertRowid;
  try {
    ({ lastInsertRowid } = stmt.insertUser.run(username, hash, salt, Date.now()));
  } catch {
    // unique constraint: someone else registered the name while we hashed
    sendError(ws, 'taken', 'That username is already registered.');
    return;
  }
  const token = createToken(Number(lastInsertRowid));
  ws.user = { id: Number(lastInsertRowid), username };
  ws.isAdmin = false;
  send(ws, { type: 'auth-ok', token, user: userPayload(ws) });
  if (ws.room) broadcastRoomUsers(ws.room);
}

async function handleLogin(ws, msg) {
  if (!allowAuth(ws.ip)) {
    sendError(ws, 'rate');
    return;
  }
  const username = typeof msg.username === 'string' ? msg.username.toLowerCase().trim() : '';
  const password = typeof msg.password === 'string' ? msg.password : '';

  // the reserved admin account authenticates against ADMIN_TOKEN, not the db
  if (username === ADMIN_USERNAME) {
    if (!adminTokenMatches(password)) {
      sendError(ws, 'auth', 'Wrong username or password.');
      return;
    }
    ws.user = { id: 0, username: ADMIN_USERNAME };
    ws.isAdmin = true;
    // admin sessions get a fresh ephemeral token bound to user id 0
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.add(token);
    send(ws, { type: 'auth-ok', token, user: userPayload(ws) });
    if (ws.room) broadcastRoomUsers(ws.room);
    return;
  }

  const row = stmt.userByName.get(username);
  if (!row || !safeEqualHex(await hashPassword(password, row.salt), row.hash)) {
    sendError(ws, 'auth', 'Wrong username or password.');
    return;
  }
  ws.user = { id: row.id, username: row.username };
  ws.isAdmin = false;
  send(ws, { type: 'auth-ok', token: createToken(row.id), user: userPayload(ws) });
  if (ws.room) broadcastRoomUsers(ws.room);
}

// admin tokens live in memory only; a server restart logs the admin out
const adminTokens = new Set();

function resumeToken(ws, token) {
  if (typeof token !== 'string' || token.length > 64) return false;
  if (adminTokens.has(token)) {
    ws.user = { id: 0, username: ADMIN_USERNAME };
    ws.isAdmin = true;
    return true;
  }
  const row = stmt.userByToken.get(token);
  if (!row || Date.now() - row.token_at > TOKEN_TTL_MS) return false;
  ws.user = { id: row.id, username: row.username };
  ws.isAdmin = false;
  return true;
}

function handleHello(ws, msg) {
  ws.helloDone = true;
  ws.nick = `guest-${crypto.randomBytes(2).toString('hex')}`;
  let resumed = false;
  if (msg.token !== undefined && msg.token !== null) {
    resumed = resumeToken(ws, msg.token);
  }
  if (typeof msg.nick === 'string' && !ws.user) {
    const nick = sanitizeText(msg.nick) ?? '';
    if (NICK_RE.test(nick) && nickAvailable(nick)) ws.nick = nick;
  }
  send(ws, {
    type: 'hello-ok',
    user: ws.user ? userPayload(ws) : null,
    badToken: msg.token != null && !resumed,
    rooms: roomList(),
    you: displayName(ws),
  });
}

function handleJoin(ws, msg) {
  if (typeof msg.room !== 'string' || !ROOMS.includes(msg.room)) {
    strike(ws);
    return;
  }
  if (ws.room === msg.room) return;
  const prev = ws.room;
  leaveRoom(ws, { silent: true });
  ws.room = msg.room;
  roomSockets.get(msg.room).add(ws);
  send(ws, {
    type: 'history',
    room: msg.room,
    messages: stmt.history.all(msg.room, HISTORY_LIMIT).map(rowToMessage),
  });
  broadcastRoomUsers(msg.room);
  if (prev) broadcastRoomUsers(prev);
  broadcastRoomList();
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'register':
      handleRegister(ws, msg).catch(() => sendError(ws, 'bad_request'));
      return;
    case 'login':
      handleLogin(ws, msg).catch(() => sendError(ws, 'bad_request'));
      return;
    case 'nick': {
      if (ws.user) {
        sendError(ws, 'bad_request');
        return;
      }
      const nick = sanitizeText(msg.name) ?? '';
      if (!NICK_RE.test(nick)) {
        sendError(ws, 'invalid', 'Nicknames are 2-24 letters, numbers or _ . -');
        return;
      }
      if (!nickAvailable(nick)) {
        sendError(ws, 'taken', 'That name belongs to a registered user.');
        return;
      }
      ws.nick = nick;
      send(ws, { type: 'nick-ok', name: nick });
      if (ws.room) broadcastRoomUsers(ws.room);
      return;
    }
    case 'join':
      handleJoin(ws, msg);
      return;
    case 'msg': {
      const room = ws.room;
      if (!room || msg.room !== room) {
        strike(ws);
        return;
      }
      const text = sanitizeText(msg.text);
      if (text === null || text === '') {
        strike(ws);
        return;
      }
      if (text.length > MAX_TEXT_LEN) {
        sendError(ws, 'too_long');
        return;
      }
      if (!allowMessage(ws)) {
        sendError(ws, 'rate');
        return;
      }
      const message = storeMessage(room, ws, text);
      send(ws, { type: 'ack', tmp: msg.tmp, id: message.id, at: message.at });
      broadcastRoom(room, { type: 'msg', room, message }, ws);
      return;
    }
    case 'typing': {
      if (!ws.room) return;
      const now = Date.now();
      if (now - (typingLast.get(ws) ?? 0) < TYPING_FORWARD_MS) return;
      typingLast.set(ws, now);
      broadcastRoom(ws.room, { type: 'typing', room: ws.room, from: displayName(ws) }, ws);
      return;
    }
    default:
      strike(ws);
  }
}

// ---------------------------------------------------------------- http + ws

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const forwarded = req.headers['x-forwarded-for'];
  ws.ip =
    typeof forwarded === 'string' && forwarded.length > 0
      ? forwarded.split(',')[0].trim()
      : req.socket.remoteAddress ?? 'unknown';
  ws.helloDone = false;
  ws.user = null;
  ws.isAdmin = false;
  ws.nick = `guest-${crypto.randomBytes(2).toString('hex')}`;
  ws.room = null;
  ws.strikes = 0;
  ws.isAlive = true;
  ws.missedPongs = 0;

  ws.on('pong', () => {
    ws.isAlive = true;
    ws.missedPongs = 0;
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      strike(ws);
      return;
    }
    if (msg === null || typeof msg !== 'object') {
      strike(ws);
      return;
    }
    if (!ws.helloDone) {
      if (msg.type !== 'hello') {
        strike(ws);
        return;
      }
      handleHello(ws, msg);
      return;
    }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });

  ws.on('error', () => ws.terminate());
});

// Heartbeat: ping every 30s, terminate sockets that miss 2 pongs.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.missedPongs += 1;
      if (ws.missedPongs >= 2) {
        ws.terminate();
        continue;
      }
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [key, arr] of authRateByIp) {
    if (arr.length === 0 || now - arr[arr.length - 1] >= AUTH_RATE_WINDOW_MS) {
      authRateByIp.delete(key);
    }
  }
}, HEARTBEAT_MS);

// Hourly sweep so the tokens table can't grow without bound.
const tokenSweep = setInterval(() => {
  stmt.deleteExpiredTokens.run(Date.now() - TOKEN_TTL_MS);
}, TOKEN_SWEEP_MS);
tokenSweep.unref();

// ---------------------------------------------------------------- lifecycle

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(tokenSweep);
  for (const ws of wss.clients) ws.terminate();
  wss.close(() => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`chat server listening on port ${server.address().port}`);
});
