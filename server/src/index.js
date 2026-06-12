// Chat server for the AlejOS Messenger app.
// Visitors chat 1:1 with the admin over WebSocket; messages persist in SQLite.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DB_PATH = process.env.DB_PATH ?? './data/messages.db';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required, refusing to start');
  process.exit(1);
}

const MAX_TEXT_LEN = 600;
const MAX_NAME_LEN = 40;
const VISITOR_HISTORY = 100;
const ADMIN_HISTORY = 200;
const MAX_MESSAGES_PER_CONVO = 2000;
const MAX_CONVOS_LISTED = 50;
const RATE_MAX = 10; // messages per window
const RATE_WINDOW_MS = 30_000;
const TYPING_FORWARD_MS = 1_000;
const HEARTBEAT_MS = 30_000;
const MAX_STRIKES = 3;
const VISITOR_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

// ---------------------------------------------------------------- database

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS convos (
    id TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    created_at INTEGER,
    last_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    convo_id TEXT,
    sender TEXT CHECK(sender IN ('visitor','admin')),
    text TEXT,
    at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_convo_at ON messages(convo_id, at);
`);

const stmt = {
  insertConvo: db.prepare(
    'INSERT OR IGNORE INTO convos (id, name, created_at, last_at) VALUES (?, ?, ?, ?)'
  ),
  touchConvo: db.prepare('UPDATE convos SET last_at = ? WHERE id = ?'),
  setConvoName: db.prepare('UPDATE convos SET name = ? WHERE id = ?'),
  getConvoName: db.prepare('SELECT name FROM convos WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (convo_id, sender, text, at) VALUES (?, ?, ?, ?)'
  ),
  trimMessages: db.prepare(`
    DELETE FROM messages WHERE convo_id = ? AND id NOT IN (
      SELECT id FROM messages WHERE convo_id = ? ORDER BY id DESC LIMIT ?
    )
  `),
  history: db.prepare(`
    SELECT id, sender, text, at FROM (
      SELECT id, sender, text, at FROM messages
      WHERE convo_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `),
  listConvos: db.prepare(`
    SELECT c.id, c.name, c.last_at AS lastAt,
      (SELECT text FROM messages m WHERE m.convo_id = c.id ORDER BY m.id DESC LIMIT 1) AS lastText,
      (SELECT COUNT(*) FROM messages m WHERE m.convo_id = c.id) AS count
    FROM convos c ORDER BY c.last_at DESC LIMIT ?
  `),
};

function ensureConvo(id, name = '') {
  const now = Date.now();
  stmt.insertConvo.run(id, name, now, now);
}

function storeMessage(convoId, sender, text) {
  const at = Date.now();
  ensureConvo(convoId);
  const { lastInsertRowid } = stmt.insertMessage.run(convoId, sender, text, at);
  stmt.touchConvo.run(at, convoId);
  stmt.trimMessages.run(convoId, convoId, MAX_MESSAGES_PER_CONVO);
  return { id: Number(lastInsertRowid), sender, text, at };
}

// ---------------------------------------------------------------- helpers

function sanitizeText(raw) {
  if (typeof raw !== 'string') return null;
  // Strip control characters except newline, then trim.
  return raw.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim();
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_NAME_LEN);
}

function tokenMatches(token) {
  if (typeof token !== 'string') return false;
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sendError(ws, code, message) {
  send(ws, message ? { type: 'error', code, message } : { type: 'error', code });
}

// ---------------------------------------------------------------- live state

const visitorSockets = new Map(); // convoId -> Set<ws>
const adminSockets = new Set();
const rateByConvo = new Map(); // convoId -> [timestamps]
const rateByIp = new Map(); // ip -> [timestamps]
const typingLastByConvo = new Map(); // convoId -> last forward timestamp

function recentHits(map, key, now) {
  const arr = (map.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  map.set(key, arr);
  return arr;
}

function allowMessage(convoId, ip) {
  const now = Date.now();
  const byConvo = recentHits(rateByConvo, convoId, now);
  const byIp = recentHits(rateByIp, ip, now);
  if (byConvo.length >= RATE_MAX || byIp.length >= RATE_MAX) return false;
  byConvo.push(now);
  byIp.push(now);
  return true;
}

function broadcastToVisitors(payload) {
  for (const set of visitorSockets.values()) {
    for (const ws of set) send(ws, payload);
  }
}

function broadcastToAdmins(payload) {
  for (const ws of adminSockets) send(ws, payload);
}

function sendToConvo(convoId, payload) {
  const set = visitorSockets.get(convoId);
  if (set) for (const ws of set) send(ws, payload);
}

function adminOnline() {
  return adminSockets.size > 0;
}

function strike(ws) {
  sendError(ws, 'bad_request');
  ws.strikes = (ws.strikes ?? 0) + 1;
  if (ws.strikes >= MAX_STRIKES) ws.close(1008, 'too many bad messages');
}

// ---------------------------------------------------------------- handlers

function handleVisitorHello(ws, msg) {
  if (typeof msg.id !== 'string' || !VISITOR_ID_RE.test(msg.id)) {
    strike(ws);
    return;
  }
  ws.role = 'visitor';
  ws.convoId = msg.id;
  let set = visitorSockets.get(msg.id);
  if (!set) {
    set = new Set();
    visitorSockets.set(msg.id, set);
  }
  set.add(ws);

  const name = sanitizeName(msg.name);
  if (name && stmt.getConvoName.get(msg.id)) stmt.setConvoName.run(name, msg.id);
  ws.pendingName = name; // used if the convo row is created later

  send(ws, { type: 'hello-ok', presence: { online: adminOnline() } });
  send(ws, { type: 'history', messages: stmt.history.all(msg.id, VISITOR_HISTORY) });
}

function handleAdminHello(ws, msg) {
  if (!tokenMatches(msg.token)) {
    sendError(ws, 'auth');
    ws.close(1008, 'bad token');
    return;
  }
  ws.role = 'admin';
  const wasOffline = adminSockets.size === 0;
  adminSockets.add(ws);
  if (wasOffline) broadcastToVisitors({ type: 'presence', online: true });
  send(ws, { type: 'hello-ok' });
  send(ws, { type: 'convos', convos: stmt.listConvos.all(MAX_CONVOS_LISTED) });
}

function handleVisitorMessage(ws, msg) {
  switch (msg.type) {
    case 'msg': {
      const text = sanitizeText(msg.text);
      if (text === null || text === '') {
        strike(ws);
        return;
      }
      if (text.length > MAX_TEXT_LEN) {
        sendError(ws, 'too_long');
        return;
      }
      if (!allowMessage(ws.convoId, ws.ip)) {
        sendError(ws, 'rate');
        return;
      }
      if (ws.pendingName) ensureConvo(ws.convoId, ws.pendingName);
      const message = storeMessage(ws.convoId, 'visitor', text);
      send(ws, { type: 'ack', tmp: msg.tmp, id: message.id, at: message.at });
      const name = stmt.getConvoName.get(ws.convoId)?.name ?? '';
      broadcastToAdmins({ type: 'msg', convo: ws.convoId, name, message });
      return;
    }
    case 'typing': {
      const now = Date.now();
      const last = typingLastByConvo.get(ws.convoId) ?? 0;
      if (now - last < TYPING_FORWARD_MS) return;
      typingLastByConvo.set(ws.convoId, now);
      broadcastToAdmins({ type: 'typing', convo: ws.convoId });
      return;
    }
    case 'name': {
      const name = sanitizeName(msg.name);
      ensureConvo(ws.convoId, name);
      stmt.setConvoName.run(name, ws.convoId);
      ws.pendingName = '';
      return;
    }
    default:
      strike(ws);
  }
}

function handleAdminMessage(ws, msg) {
  switch (msg.type) {
    case 'open': {
      if (typeof msg.id !== 'string' || !VISITOR_ID_RE.test(msg.id)) {
        strike(ws);
        return;
      }
      send(ws, {
        type: 'history',
        convo: msg.id,
        messages: stmt.history.all(msg.id, ADMIN_HISTORY),
      });
      return;
    }
    case 'reply': {
      if (typeof msg.to !== 'string' || !VISITOR_ID_RE.test(msg.to)) {
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
      const message = storeMessage(msg.to, 'admin', text);
      sendToConvo(msg.to, { type: 'msg', message });
      broadcastToAdmins({ type: 'msg', convo: msg.to, message });
      return;
    }
    case 'typing': {
      if (typeof msg.to !== 'string' || !VISITOR_ID_RE.test(msg.to)) {
        strike(ws);
        return;
      }
      sendToConvo(msg.to, { type: 'typing' });
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

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

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
  ws.ip = typeof forwarded === 'string' && forwarded.length > 0
    ? forwarded.split(',')[0].trim()
    : req.socket.remoteAddress ?? 'unknown';
  ws.role = null;
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

    if (!ws.role) {
      if (msg.type !== 'hello') {
        strike(ws);
        return;
      }
      if (msg.role === 'visitor') handleVisitorHello(ws, msg);
      else if (msg.role === 'admin') handleAdminHello(ws, msg);
      else strike(ws);
      return;
    }

    if (ws.role === 'visitor') handleVisitorMessage(ws, msg);
    else handleAdminMessage(ws, msg);
  });

  ws.on('close', () => {
    if (ws.role === 'visitor') {
      const set = visitorSockets.get(ws.convoId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) visitorSockets.delete(ws.convoId);
      }
    } else if (ws.role === 'admin') {
      adminSockets.delete(ws);
      if (adminSockets.size === 0) broadcastToVisitors({ type: 'presence', online: false });
    }
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
  // Drop stale rate-limit entries.
  const now = Date.now();
  for (const map of [rateByConvo, rateByIp]) {
    for (const [key, arr] of map) {
      if (arr.length === 0 || now - arr[arr.length - 1] >= RATE_WINDOW_MS) map.delete(key);
    }
  }
}, HEARTBEAT_MS);

// ---------------------------------------------------------------- lifecycle

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.terminate();
  wss.close(() => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
  // Hard exit if something hangs.
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`chat server listening on port ${server.address().port}`);
});
