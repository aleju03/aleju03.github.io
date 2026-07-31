// AlejOS chat server v2: registered users + public chat rooms.
//
// Visitors register a real account (or stay guests) at the AlejOS login
// screen, then talk in shared rooms — #general, #projects, #random — like a
// tiny Discord. Accounts, tokens and room history persist in SQLite. The
// site owner logs in with the reserved username and ADMIN_TOKEN as the
// password, and his messages carry the admin badge.
//
// The same socket also carries the arcade (leaderboards + the Mine Duel match
// engine), the admin-only analytics reads, and presence for the 3D world's
// shared walk — see the "open world" section, which is a relay rather than a
// simulator because every client can already recompute the planet itself.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { createAnalytics } from './analytics.js';

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME ?? 'aleju').toLowerCase();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DB_PATH = process.env.DB_PATH ?? './data/chat.db';

// Proximity voice is peer-to-peer, so normally no audio touches this box. A
// pair of visitors behind strict (symmetric) NATs cannot open a direct path
// to each other, though, and for them the only fix is a relay both sides can
// reach. Leave TURN_URLS unset and nothing changes: peers use STUN alone and
// the strict-NAT pair simply stays silent to each other, which is what shipped
// first. Point it at a coturn (or any TURN provider) and those calls connect,
// at the cost of that server carrying their audio.
//
// Credentials are minted here, per join, and expire. The alternative — a
// static username/password compiled into the frontend bundle — is a public
// password for your relay's bandwidth. This is coturn's `use-auth-secret`
// scheme: the username is an expiry timestamp and the password is an HMAC of
// it, so a stolen credential is worthless within the hour.
const TURN_URLS = (process.env.TURN_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET;
const TURN_TTL_S = Number(process.env.TURN_TTL_S ?? 3600);
const STUN_URLS = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Analytics lives in its own libsql/Turso database, never in chat.db. Leave
// ANALYTICS_URL unset and the whole feature stays off.
const ANALYTICS_URL = process.env.ANALYTICS_URL;
const ANALYTICS_AUTH_TOKEN = process.env.ANALYTICS_AUTH_TOKEN;
const ANALYTICS_RETENTION_DAYS = Number(process.env.ANALYTICS_RETENTION_DAYS ?? 180);
const ANALYTICS_SITE_HOSTS = (process.env.ANALYTICS_SITE_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ANALYTICS_TIME_ZONE = process.env.ANALYTICS_TIME_ZONE ?? 'UTC';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required, refusing to start');
  process.exit(1);
}

export const ROOMS = ['general', 'projects', 'random'];

// Arcade leaderboards: every game in the AlejOS Games folder posts scores
// here so visitors compete on shared boards. One best row per (game, name);
// 'asc' games are times (lower is better). Caps keep obviously-forged
// values out of the boards — real anticheat is not worth it for a portfolio.
export const GAMES = {
  pong: { order: 'desc', max: 999 },
  snake: { order: 'desc', max: 500 },
  memory: { order: 'asc', min: 3_000, max: 3_600_000 }, // ms to clear the board
  2048: { order: 'desc', max: 4_000_000 },
  whack: { order: 'desc', max: 999 },
  // Standard scoring only, and the timed bonus is 700000/seconds, so a very
  // fast win lands in the low tens of thousands
  solitaire: { order: 'desc', max: 30_000 },
  flappy: { order: 'desc', max: 9_999 },
  'vsrg-badapple': { order: 'desc', max: 2_000_000 },
  'vsrg-madeoffire': { order: 'desc', max: 2_000_000 },
  'vsrg-freedomdive': { order: 'desc', max: 2_000_000 },
  'mine-beginner': { order: 'asc', min: 1_000, max: 3_599_000 }, // ms
  'mine-intermediate': { order: 'asc', min: 3_000, max: 3_599_000 },
  'mine-expert': { order: 'asc', min: 8_000, max: 3_599_000 },
  // duel is server-scored: wins are recorded by the match engine only
  duel: { order: 'desc', managed: true },
};
const SCORE_TOP_LIMIT = 25;
const SCORE_RATE_MAX = 10; // submissions per window per connection
const SCORE_RATE_WINDOW_MS = 60_000;

// Mine Duel: 1v1 minesweeper where both players secretly plant mines on one
// shared board, then take turns digging it. Inspired by the Squidcraft Games
// duel: numbers count BOTH players' mines around a tile, and digging any
// mine — including your own — costs the digger a life.
const DUEL_SIZE = 10;
const DUEL_CELLS = DUEL_SIZE * DUEL_SIZE;
const DUEL_MINES = 5;
const DUEL_LIVES = 2;
const DUEL_PLANT_MS = 45_000;
const DUEL_TURN_MS = 20_000;
const DUEL_REMATCH_MS = 60_000;

// The open world: the 3D room's walkable planet, shared. The server is a
// relay here, not a simulator — the world is a pure function of coordinates
// on every client, so all that has to travel is who is where. Positions are
// client-authoritative for the same reason the score caps are loose: real
// anticheat is not worth it for a portfolio. Voice never touches this
// process; peers talk WebRTC directly and only their offer/answer/ICE
// handshake is relayed (world-signal).
const WORLD_TICK_MS = 66; // ~15 snapshots a second
const WORLD_MAX_PLAYERS = 32;
const WORLD_MOVE_RATE_MAX = 40; // move packets per window per connection
const WORLD_MOVE_RATE_WINDOW_MS = 1_000;
const WORLD_CHAT_RATE_MAX = 8;
const WORLD_CHAT_RATE_WINDOW_MS = 20_000;
const WORLD_SIGNAL_RATE_MAX = 150; // an ICE burst is chatty and short-lived
const WORLD_SIGNAL_RATE_WINDOW_MS = 10_000;
const WORLD_MAX_TEXT_LEN = 200;
const WORLD_MAX_SIGNAL_LEN = 6_000; // one SDP blob; maxPayload is 8 KiB
const WORLD_LEVEL_RE = /^[a-z0-9-]{1,24}$/;
// A player's colours: four packed hex triplets from src/game/player/look.ts.
// This process has no opinion about which of them is the visor and which is
// the antenna — it is a fixed-length opaque string that gets relayed, exactly
// like the SDP blobs beside it.
const WORLD_LOOK_RE = /^[0-9a-f]{24}$/;
const WORLD_LOOK_RATE_MAX = 30; // a swatch grid clicked through, per window
const WORLD_LOOK_RATE_WINDOW_MS = 10_000;
const WORLD_COORD_LIMIT = 1e7; // the planet is endless, the wire is not
// The fleet: three machines, two chairs each, mirrored by WIRE_VEHICLES and
// SEAT_* in src/game/net/protocol.ts. This process does not know what a
// helicopter is and does not need to — a vehicle here is an index, a
// transform and two seat holders.
const WORLD_FLEET = 3;
const WORLD_SEATS = 2;
const WORLD_SEAT_RATE_MAX = 20; // door-handle spam, per window
const WORLD_SEAT_RATE_WINDOW_MS = 10_000;

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
  -- The admin has no users row (it authenticates against ADMIN_TOKEN, not the
  -- database), so its sessions need their own table. They used to live only in
  -- memory, which meant every deploy silently downgraded a still-logged-in
  -- admin to a guest: the browser kept a session localStorage said was valid,
  -- the server no longer recognised the token, and everything that socket did
  -- afterwards — arcade scores especially — was recorded under a guest name.
  CREATE TABLE IF NOT EXISTS admin_tokens (
    token TEXT PRIMARY KEY,
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
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    is_registered INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL,
    at INTEGER NOT NULL,
    UNIQUE(game, name_key)
  );
  CREATE INDEX IF NOT EXISTS idx_scores_board ON scores(game, score);
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
  insertAdminToken: db.prepare('INSERT INTO admin_tokens (token, created_at) VALUES (?, ?)'),
  adminToken: db.prepare('SELECT created_at FROM admin_tokens WHERE token = ?'),
  deleteExpiredAdminTokens: db.prepare('DELETE FROM admin_tokens WHERE created_at < ?'),
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
  scoreGet: db.prepare('SELECT score FROM scores WHERE game = ? AND name_key = ?'),
  scoreUpsert: db.prepare(`
    INSERT INTO scores (game, name, name_key, is_registered, is_admin, score, at)
    VALUES (@game, @name, @nameKey, @registered, @admin, @score, @at)
    ON CONFLICT(game, name_key) DO UPDATE SET
      name = excluded.name, is_registered = excluded.is_registered,
      is_admin = excluded.is_admin, score = excluded.score, at = excluded.at
  `),
  scoreAddWin: db.prepare(`
    INSERT INTO scores (game, name, name_key, is_registered, is_admin, score, at)
    VALUES ('duel', @name, @nameKey, @registered, @admin, 1, @at)
    ON CONFLICT(game, name_key) DO UPDATE SET
      name = excluded.name, is_registered = excluded.is_registered,
      is_admin = excluded.is_admin, score = scores.score + 1, at = excluded.at
  `),
  scoreTopDesc: db.prepare(
    'SELECT name, is_registered, is_admin, score, at FROM scores WHERE game = ? ORDER BY score DESC, at ASC LIMIT ?'
  ),
  scoreTopAsc: db.prepare(
    'SELECT name, is_registered, is_admin, score, at FROM scores WHERE game = ? ORDER BY score ASC, at ASC LIMIT ?'
  ),
  scoreRankDesc: db.prepare('SELECT COUNT(*) AS n FROM scores WHERE game = ? AND score > ?'),
  scoreRankAsc: db.prepare('SELECT COUNT(*) AS n FROM scores WHERE game = ? AND score < ?'),
};

// Startup maintenance: drop expired sessions and any history overflow left
// over from a previous run.
stmt.deleteExpiredTokens.run(Date.now() - TOKEN_TTL_MS);
stmt.deleteExpiredAdminTokens.run(Date.now() - TOKEN_TTL_MS);
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

// ---------------------------------------------------------------- scores

const scoreRateByConn = new WeakMap(); // ws -> [timestamps]

function allowScore(ws) {
  const now = Date.now();
  const hits = recentHits(scoreRateByConn.get(ws) ?? [], now, SCORE_RATE_WINDOW_MS);
  scoreRateByConn.set(ws, hits);
  if (hits.length >= SCORE_RATE_MAX) return false;
  hits.push(now);
  return true;
}

function scoreRow(row) {
  return {
    name: row.name,
    registered: Boolean(row.is_registered),
    admin: Boolean(row.is_admin),
    score: row.score,
    at: row.at,
  };
}

function rankFor(game, score) {
  const rank = GAMES[game].order === 'asc' ? stmt.scoreRankAsc : stmt.scoreRankDesc;
  return rank.get(game, score).n + 1;
}

function handleScoreSubmit(ws, msg) {
  const game = typeof msg.game === 'string' ? msg.game : '';
  const cfg = GAMES[game];
  if (!cfg || cfg.managed) {
    strike(ws);
    return;
  }
  const score = msg.score;
  if (!Number.isInteger(score) || score < (cfg.min ?? 1) || score > cfg.max) {
    strike(ws);
    return;
  }
  if (!allowScore(ws)) {
    sendError(ws, 'rate');
    return;
  }
  const name = displayName(ws);
  const nameKey = name.toLowerCase();
  const prev = stmt.scoreGet.get(game, nameKey);
  const improved = !prev || (cfg.order === 'asc' ? score < prev.score : score > prev.score);
  if (improved) {
    stmt.scoreUpsert.run({
      game,
      name,
      nameKey,
      registered: ws.user ? 1 : 0,
      admin: ws.isAdmin ? 1 : 0,
      score,
      at: Date.now(),
    });
  }
  const best = improved ? score : prev.score;
  send(ws, { type: 'score-ok', game, best, improved, rank: rankFor(game, best) });
}

function handleScoreTop(ws, msg) {
  const game = typeof msg.game === 'string' ? msg.game : '';
  const cfg = GAMES[game];
  if (!cfg) {
    strike(ws);
    return;
  }
  const top = (cfg.order === 'asc' ? stmt.scoreTopAsc : stmt.scoreTopDesc)
    .all(game, SCORE_TOP_LIMIT)
    .map(scoreRow);
  const mine = stmt.scoreGet.get(game, displayName(ws).toLowerCase());
  send(ws, {
    type: 'score-top',
    game,
    top,
    you: mine ? { score: mine.score, rank: rankFor(game, mine.score) } : null,
  });
}

// ---------------------------------------------------------------- mine duel

let duelSeq = 1;
const duelQueue = new Set(); // sockets waiting for an opponent

function duelNeighbors(i) {
  const row = Math.floor(i / DUEL_SIZE);
  const col = i % DUEL_SIZE;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < DUEL_SIZE && c >= 0 && c < DUEL_SIZE) out.push(r * DUEL_SIZE + c);
    }
  }
  return out;
}

function randomCells(count) {
  const pool = Array.from({ length: DUEL_CELLS }, (_, i) => i);
  const out = [];
  for (let k = 0; k < count; k++) {
    const j = k + Math.floor(Math.random() * (pool.length - k));
    [pool[k], pool[j]] = [pool[j], pool[k]];
    out.push(pool[k]);
  }
  return out;
}

function duelSend(match, payload) {
  for (const ws of match.players) send(ws, payload);
}

function otherSeat(seat) {
  return seat === 0 ? 1 : 0;
}

function startDuel(a, b) {
  const match = {
    id: duelSeq++,
    players: [a, b],
    names: [userPayload(a), userPayload(b)],
    mines: [new Set(), new Set()],
    planted: [false, false],
    revealed: new Map(), // cell -> adjacent mine count (both players, duplicates count)
    exploded: new Set(),
    lives: [DUEL_LIVES, DUEL_LIVES],
    turn: Math.random() < 0.5 ? 0 : 1,
    phase: 'plant',
    deadline: Date.now() + DUEL_PLANT_MS,
    timer: null,
    rematch: [false, false],
  };
  a.duel = { match, seat: 0 };
  b.duel = { match, seat: 1 };
  match.players.forEach((ws, seat) =>
    send(ws, {
      type: 'duel-start',
      seat,
      players: match.names,
      size: DUEL_SIZE,
      mines: DUEL_MINES,
      lives: DUEL_LIVES,
      phase: 'plant',
      deadline: match.deadline,
    })
  );
  match.timer = setTimeout(() => autoPlant(match), DUEL_PLANT_MS);
}

function beginDig(match) {
  clearTimeout(match.timer);
  match.phase = 'dig';
  match.deadline = Date.now() + DUEL_TURN_MS;
  duelSend(match, { type: 'duel-phase', phase: 'dig', turn: match.turn, deadline: match.deadline });
  match.timer = setTimeout(() => autoDig(match), DUEL_TURN_MS);
}

// the placement deadline passed: anyone who never committed gets a random
// minefield (and is told which cells, since they have to memorize them)
function autoPlant(match) {
  if (match.phase !== 'plant') return;
  for (const seat of [0, 1]) {
    if (match.planted[seat]) continue;
    match.mines[seat] = new Set(randomCells(DUEL_MINES));
    match.planted[seat] = true;
    send(match.players[seat], {
      type: 'duel-planted',
      seat,
      auto: true,
      cells: [...match.mines[seat]],
    });
    send(match.players[otherSeat(seat)], { type: 'duel-planted', seat, auto: true });
  }
  beginDig(match);
}

function minedCellCount(match) {
  return new Set([...match.mines[0], ...match.mines[1]]).size;
}

function digCell(match, seat, cell, auto = false) {
  clearTimeout(match.timer);
  const hits = (match.mines[0].has(cell) ? 1 : 0) + (match.mines[1].has(cell) ? 1 : 0);
  let count = null;
  if (hits > 0) {
    // any mine detonates on the digger, including their own
    match.exploded.add(cell);
    match.lives[seat] -= 1;
  } else {
    count = 0;
    for (const n of duelNeighbors(cell)) {
      if (match.mines[0].has(n)) count += 1;
      if (match.mines[1].has(n)) count += 1;
    }
    match.revealed.set(cell, count);
  }
  match.turn = otherSeat(seat);
  match.deadline = Date.now() + DUEL_TURN_MS;
  duelSend(match, {
    type: 'duel-dug',
    cell,
    by: seat,
    auto,
    mine: hits > 0,
    count,
    lives: match.lives,
    turn: match.turn,
    deadline: match.deadline,
  });
  if (match.lives[seat] <= 0) {
    finishDuel(match, otherSeat(seat), 'lives');
    return;
  }
  if (match.revealed.size >= DUEL_CELLS - minedCellCount(match)) {
    const [la, lb] = match.lives;
    finishDuel(match, la === lb ? -1 : la > lb ? 0 : 1, 'board');
    return;
  }
  match.timer = setTimeout(() => autoDig(match), DUEL_TURN_MS);
}

// the turn clock ran out: the server digs a random hidden tile for the
// staller — mines included, so stalling is never the safe play
function autoDig(match) {
  if (match.phase !== 'dig') return;
  const hidden = [];
  for (let i = 0; i < DUEL_CELLS; i++) {
    if (!match.revealed.has(i) && !match.exploded.has(i)) hidden.push(i);
  }
  if (hidden.length === 0) return;
  digCell(match, match.turn, hidden[Math.floor(Math.random() * hidden.length)], true);
}

function finishDuel(match, winner, reason) {
  clearTimeout(match.timer);
  match.phase = 'over';
  if (winner >= 0) {
    const name = match.names[winner];
    stmt.scoreAddWin.run({
      name: name.name,
      nameKey: name.name.toLowerCase(),
      registered: name.registered ? 1 : 0,
      admin: name.admin ? 1 : 0,
      at: Date.now(),
    });
  }
  duelSend(match, {
    type: 'duel-over',
    winner,
    reason,
    lives: match.lives,
    mines: [[...match.mines[0]], [...match.mines[1]]],
  });
  // seats stay warm for a rematch window, then the match is forgotten
  match.timer = setTimeout(() => {
    for (const ws of match.players) {
      if (ws.duel?.match === match) ws.duel = null;
    }
  }, DUEL_REMATCH_MS);
}

function leaveDuel(ws, reason) {
  duelQueue.delete(ws);
  const d = ws.duel;
  if (!d) return;
  ws.duel = null;
  const match = d.match;
  if (match.phase === 'over') {
    // no rematch coming; tell the other side if they are still around
    const other = match.players[otherSeat(d.seat)];
    if (other.duel?.match === match) send(other, { type: 'duel-opponent-left' });
    return;
  }
  finishDuel(match, otherSeat(d.seat), reason);
}

function handleDuelQueue(ws) {
  if (duelQueue.has(ws)) return;
  if (ws.duel && ws.duel.match.phase !== 'over') {
    sendError(ws, 'bad_request');
    return;
  }
  if (ws.duel) leaveDuel(ws, 'left');
  for (const other of duelQueue) {
    duelQueue.delete(other);
    startDuel(other, ws);
    return;
  }
  duelQueue.add(ws);
  send(ws, { type: 'duel-queued' });
}

function handleDuelPlant(ws, msg) {
  const d = ws.duel;
  if (!d || d.match.phase !== 'plant' || d.match.planted[d.seat]) {
    sendError(ws, 'bad_request');
    return;
  }
  const cells = Array.isArray(msg.cells) ? msg.cells : null;
  if (!cells || cells.length !== DUEL_MINES) {
    strike(ws);
    return;
  }
  const set = new Set();
  for (const c of cells) {
    if (!Number.isInteger(c) || c < 0 || c >= DUEL_CELLS) {
      strike(ws);
      return;
    }
    set.add(c);
  }
  if (set.size !== DUEL_MINES) {
    strike(ws);
    return;
  }
  const match = d.match;
  match.mines[d.seat] = set;
  match.planted[d.seat] = true;
  duelSend(match, { type: 'duel-planted', seat: d.seat });
  if (match.planted[0] && match.planted[1]) beginDig(match);
}

function handleDuelDig(ws, msg) {
  const d = ws.duel;
  if (!d || d.match.phase !== 'dig' || d.match.turn !== d.seat) {
    sendError(ws, 'bad_request');
    return;
  }
  const cell = msg.cell;
  if (!Number.isInteger(cell) || cell < 0 || cell >= DUEL_CELLS) {
    strike(ws);
    return;
  }
  if (d.match.revealed.has(cell) || d.match.exploded.has(cell)) {
    sendError(ws, 'bad_request');
    return;
  }
  digCell(d.match, d.seat, cell);
}

function handleDuelRematch(ws) {
  const d = ws.duel;
  if (!d || d.match.phase !== 'over') {
    sendError(ws, 'bad_request');
    return;
  }
  const match = d.match;
  if (match.rematch[d.seat]) return;
  match.rematch[d.seat] = true;
  send(match.players[otherSeat(d.seat)], { type: 'duel-rematch', seat: d.seat });
  if (match.rematch[0] && match.rematch[1]) {
    clearTimeout(match.timer);
    const [a, b] = match.players;
    if (a.readyState === WebSocket.OPEN && b.readyState === WebSocket.OPEN) startDuel(a, b);
  }
}

// ---------------------------------------------------------------- open world

// Presence for the 3D room's walkable planet. Unlike Mine Duel this owns no
// rules and no board: the world is a pure function of coordinates on every
// client (src/game/world/), so the only thing that cannot be recomputed is
// where the other people are. Three jobs, in order of traffic:
//
//   1. a roster — who is here, under what name, painted which way
//      (world-enter/world-exit, and world-name/world-look when either
//      changes mid-session). The look is a fixed-length opaque string this
//      process relays without parsing; the name is the same `nick` every
//      other socket on this server uses, because it is the same identity
//   2. a snapshot loop — everyone's transform, ~15Hz, grouped by level so a
//      visitor in the backrooms is not paying for the overworld's crowd
//   3. a signalling relay — WebRTC offer/answer/ICE between two peers, so
//      proximity voice is browser-to-browser and no audio touches this box
//   4. the fleet — the one piece of world state that exists, and the one
//      question clients cannot settle between themselves: who has the wheel
//
// Sockets stay in the world independently of chat: `ws.world` is set by
// world-join and is the whole of a player's server-side state.

let worldSeq = 1;
const worldPlayers = new Map(); // id -> ws
const worldMoveRate = new WeakMap(); // ws -> [timestamps]
const worldChatRate = new WeakMap();
const worldSignalRate = new WeakMap();
const worldSeatRate = new WeakMap();
const worldLookRate = new WeakMap();
let worldTicker = null;
let worldDirty = false;

// The fleet. `seats[0]` is the driver, `seats[1]` the passenger, 0 for empty;
// `set` says whether anyone has ever moved this machine, and until they have
// the server has no opinion about where it is — every client's own spawn puts
// it on the same probed home spot, so silence is the correct answer.
const worldFleet = Array.from({ length: WORLD_FLEET }, () => ({
  seats: new Array(WORLD_SEATS).fill(0),
  set: false,
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
}));

// pose bits, mirrored by src/game/net/protocol.ts's POSE flags
const W_GROUNDED = 1;
const W_RUN = 2;
const W_CROUCH = 4;
const W_SWIM = 8;
const W_SPEAKING = 16;
const W_DOWN = 32;
const W_FLAGS = W_GROUNDED | W_RUN | W_CROUCH | W_SWIM | W_SPEAKING | W_DOWN;

function allowWorld(map, ws, max, windowMs) {
  const now = Date.now();
  const hits = recentHits(map.get(ws) ?? [], now, windowMs);
  map.set(ws, hits);
  if (hits.length >= max) return false;
  hits.push(now);
  return true;
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function clampCoord(n) {
  return n > WORLD_COORD_LIMIT ? WORLD_COORD_LIMIT : n < -WORLD_COORD_LIMIT ? -WORLD_COORD_LIMIT : n;
}

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

function worldRosterEntry(ws) {
  // `look` is left off entirely rather than sent as null: an absent look is
  // the default robot on the client, and the roster is resent to every late
  // arrival often enough to be worth the four bytes
  return { id: ws.world.id, ...userPayload(ws), ...(ws.look ? { look: ws.look } : {}) };
}

/** The ICE servers a joining client should use. STUN is enough for most
    people; the TURN entry only appears when one is configured, and carries a
    credential that dies after TURN_TTL_S. */
function iceServers() {
  const list = [{ urls: STUN_URLS }];
  if (TURN_URLS.length > 0 && TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}`;
    list.push({
      urls: TURN_URLS,
      username,
      credential: crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64'),
    });
  }
  return list;
}

function worldBroadcast(payload, except = null) {
  for (const ws of worldPlayers.values()) {
    if (ws !== except) send(ws, payload);
  }
}

/* -------------------------------------------------------------- the fleet */

function worldSeatTable() {
  return worldFleet.map((v, i) => [i, v.seats[0], v.seats[1]]);
}

/** the machines anyone has actually moved. An untouched fleet sends nothing */
function worldVehicleRows() {
  const rows = [];
  for (let i = 0; i < worldFleet.length; i++) {
    const v = worldFleet[i];
    if (!v.set) continue;
    rows.push([i, r2(v.x), r2(v.y), r2(v.z), r3(v.yaw), r3(v.pitch), r3(v.roll)]);
  }
  return rows;
}

function announceSeats() {
  worldBroadcast({ type: 'world-seats', seats: worldSeatTable() });
}

/** take this player out of whatever they were sitting in. Returns whether
    anything actually changed, so a routine leave does not broadcast a table
    nobody's name appears in. */
function clearSeatsOf(id) {
  let changed = false;
  for (const v of worldFleet) {
    for (let s = 0; s < v.seats.length; s++) {
      if (v.seats[s] === id) {
        v.seats[s] = 0;
        changed = true;
      }
    }
  }
  return changed;
}

function handleWorldSeat(ws, msg) {
  const w = ws.world;
  if (!w) return;
  if (!allowWorld(worldSeatRate, ws, WORLD_SEAT_RATE_MAX, WORLD_SEAT_RATE_WINDOW_MS)) return;
  if (!Number.isInteger(msg.v) || !Number.isInteger(msg.seat)) {
    strike(ws);
    return;
  }
  if (msg.v < 0 || msg.v >= WORLD_FLEET || msg.seat < 0 || msg.seat >= WORLD_SEATS) {
    strike(ws);
    return;
  }
  const v = worldFleet[msg.v];
  const holder = v.seats[msg.seat];
  if (holder !== 0 && holder !== w.id) {
    // somebody beat them to the door by a round trip
    send(ws, { type: 'world-seat-denied', v: msg.v, seat: msg.seat });
    return;
  }
  // one body, one chair: taking a seat gives up the last one, which is also
  // how sliding across from the passenger side to the wheel works
  clearSeatsOf(w.id);
  v.seats[msg.seat] = w.id;
  announceSeats();
}

function handleWorldUnseat(ws) {
  const w = ws.world;
  if (!w) return;
  if (clearSeatsOf(w.id)) announceSeats();
}

function handleWorldVehicle(ws, msg) {
  const w = ws.world;
  if (!w) return;
  // shares the move budget: a driver is not also sending walk poses that
  // matter, and one client should not get two firehoses for changing seat
  if (!allowWorld(worldMoveRate, ws, WORLD_MOVE_RATE_MAX, WORLD_MOVE_RATE_WINDOW_MS)) return;
  if (!Number.isInteger(msg.v) || msg.v < 0 || msg.v >= WORLD_FLEET) {
    strike(ws);
    return;
  }
  const v = worldFleet[msg.v];
  // the entirety of the server's opinion about physics: you may move the
  // machine you are holding the wheel of, and no other
  if (v.seats[0] !== w.id) return;
  if (!finite(msg.x) || !finite(msg.y) || !finite(msg.z)) {
    strike(ws);
    return;
  }
  if (!finite(msg.yaw) || !finite(msg.pitch) || !finite(msg.roll)) {
    strike(ws);
    return;
  }
  v.set = true;
  v.x = clampCoord(msg.x);
  v.y = clampCoord(msg.y);
  v.z = clampCoord(msg.z);
  v.yaw = msg.yaw;
  v.pitch = msg.pitch;
  v.roll = msg.roll;
  worldDirty = true;
}

// One snapshot per level, stringified once and pushed to everyone standing in
// it — including its own subject, so the payload stays identical per level and
// the client can reconcile against what the server thinks it said.
function worldTick() {
  if (!worldDirty || worldPlayers.size === 0) return;
  worldDirty = false;
  const byLevel = new Map();
  for (const ws of worldPlayers.values()) {
    const p = ws.world;
    let list = byLevel.get(p.level);
    if (!list) byLevel.set(p.level, (list = []));
    list.push(ws);
  }
  const t = Date.now();
  // The fleet is not grouped by level. It is three rows, it only exists once
  // anyone has moved a machine, and a client that is somewhere else simply
  // ignores it — which is cheaper than the bookkeeping that would work out
  // which level a parked car counts as being in.
  const vehicles = worldVehicleRows();
  for (const [, list] of byLevel) {
    const players = list.map((ws) => {
      const p = ws.world;
      return [p.id, r2(p.x), r2(p.y), r2(p.z), r3(p.yaw), r3(p.pitch), r2(p.gait), p.f];
    });
    const text = JSON.stringify(
      vehicles.length > 0
        ? { type: 'world-tick', t, players, vehicles }
        : { type: 'world-tick', t, players },
    );
    for (const ws of list) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }
}

// The loop only exists while somebody is out there; an empty planet must not
// wake the event loop 15 times a second forever.
function startWorldTicker() {
  if (worldTicker) return;
  worldTicker = setInterval(worldTick, WORLD_TICK_MS);
}

function stopWorldTicker() {
  if (!worldTicker || worldPlayers.size > 0) return;
  clearInterval(worldTicker);
  worldTicker = null;
}

function handleWorldJoin(ws, msg) {
  if (ws.world) {
    sendError(ws, 'bad_request');
    return;
  }
  if (worldPlayers.size >= WORLD_MAX_PLAYERS) {
    sendError(ws, 'unavailable', 'The world is full right now.');
    return;
  }
  const level = typeof msg.level === 'string' && WORLD_LEVEL_RE.test(msg.level) ? msg.level : null;
  if (!level) {
    strike(ws);
    return;
  }
  const id = worldSeq++;
  // Every spawn in the game is one authored point, so arrivals stack inside
  // each other. The lowest free slot is handed out here — the client turns it
  // into an offset — and freed the moment they leave, so a quiet world always
  // puts the next person on the exact original spot.
  const taken = new Set();
  for (const other of worldPlayers.values()) taken.add(other.world.slot);
  let slot = 0;
  while (taken.has(slot)) slot++;
  // the join may carry a look, so nobody ever sees the wrong colours — not
  // even for the one tick between the world-enter and a world-look
  if (typeof msg.look === 'string' && WORLD_LOOK_RE.test(msg.look)) ws.look = msg.look;
  ws.world = { id, slot, level, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, gait: 0, f: W_GROUNDED };
  worldPlayers.set(id, ws);
  const vehicles = worldVehicleRows();
  send(ws, {
    type: 'world-welcome',
    you: id,
    slot,
    tick: WORLD_TICK_MS,
    ice: iceServers(),
    players: [...worldPlayers.values()].filter((o) => o !== ws).map(worldRosterEntry),
    // where the machines were left, so an arrival does not spend the first
    // seconds looking at a car that is really two kilometres up the coast.
    // The seat table travels on its own condition: somebody can be sitting in
    // a machine that has never been driven anywhere, and their body still has
    // to be drawn in it
    ...(vehicles.length > 0 ? { vehicles } : {}),
    ...(worldFleet.some((v) => v.seats.some(Boolean)) ? { seats: worldSeatTable() } : {}),
  });
  worldBroadcast({ type: 'world-enter', player: worldRosterEntry(ws) }, ws);
  worldDirty = true;
  startWorldTicker();
}

function leaveWorld(ws) {
  const w = ws.world;
  if (!w) return;
  ws.world = null;
  worldPlayers.delete(w.id);
  // a dropped connection must not leave the car locked forever. The machine
  // stays exactly where it was abandoned; only the chair is freed
  const freed = clearSeatsOf(w.id);
  worldBroadcast({ type: 'world-exit', id: w.id });
  if (freed) announceSeats();
  worldDirty = true;
  stopWorldTicker();
}

function handleWorldMove(ws, msg) {
  const w = ws.world;
  if (!w) return; // a packet in flight when the player left; not worth a strike
  // The firehose is dropped, never punished: a client that ramps its send rate
  // on a fast machine is not misbehaving, it is just early.
  if (!allowWorld(worldMoveRate, ws, WORLD_MOVE_RATE_MAX, WORLD_MOVE_RATE_WINDOW_MS)) return;
  if (!finite(msg.x) || !finite(msg.y) || !finite(msg.z)) {
    strike(ws);
    return;
  }
  if (!finite(msg.yaw) || !finite(msg.pitch)) {
    strike(ws);
    return;
  }
  w.x = clampCoord(msg.x);
  w.y = clampCoord(msg.y);
  w.z = clampCoord(msg.z);
  w.yaw = msg.yaw;
  w.pitch = msg.pitch;
  w.gait = finite(msg.gait) ? Math.max(0, Math.min(1, msg.gait)) : 0;
  w.f = Number.isInteger(msg.f) ? msg.f & W_FLAGS : 0;
  worldDirty = true;
}

function handleWorldLevel(ws, msg) {
  const w = ws.world;
  if (!w) return;
  if (typeof msg.level !== 'string' || !WORLD_LEVEL_RE.test(msg.level)) {
    strike(ws);
    return;
  }
  w.level = msg.level;
  // the fleet lives in one level; walking a seam out of it is getting out
  if (clearSeatsOf(w.id)) announceSeats();
  worldDirty = true;
}

// A repaint. The server stores the string and forwards it; it never parses
// it, and the sender is left out of the broadcast because their own body is
// already wearing it. `ws.look` outlives the world session on purpose — walk
// out of the room and back in and you are still the robot you painted.
function handleWorldLook(ws, msg) {
  const w = ws.world;
  if (!w) return;
  if (typeof msg.look !== 'string' || !WORLD_LOOK_RE.test(msg.look)) {
    strike(ws);
    return;
  }
  if (!allowWorld(worldLookRate, ws, WORLD_LOOK_RATE_MAX, WORLD_LOOK_RATE_WINDOW_MS)) return;
  if (ws.look === msg.look) return;
  ws.look = msg.look;
  worldBroadcast({ type: 'world-look', id: w.id, look: msg.look }, ws);
}

function handleWorldChat(ws, msg) {
  const w = ws.world;
  if (!w) {
    sendError(ws, 'bad_request');
    return;
  }
  const text = sanitizeText(msg.text);
  if (text === null || text === '') {
    strike(ws);
    return;
  }
  if (text.length > WORLD_MAX_TEXT_LEN) {
    sendError(ws, 'too_long');
    return;
  }
  if (!allowWorld(worldChatRate, ws, WORLD_CHAT_RATE_MAX, WORLD_CHAT_RATE_WINDOW_MS)) {
    sendError(ws, 'rate');
    return;
  }
  // Not stored: world chat is shouted across a field, not a room with history.
  worldBroadcast({
    type: 'world-chat',
    id: w.id,
    ...userPayload(ws),
    text,
    at: Date.now(),
  });
}

function handleWorldSignal(ws, msg) {
  const w = ws.world;
  if (!w) return;
  if (!allowWorld(worldSignalRate, ws, WORLD_SIGNAL_RATE_MAX, WORLD_SIGNAL_RATE_WINDOW_MS)) return;
  if (!Number.isInteger(msg.to) || msg.data === null || typeof msg.data !== 'object') {
    strike(ws);
    return;
  }
  if (JSON.stringify(msg.data).length > WORLD_MAX_SIGNAL_LEN) {
    sendError(ws, 'too_long');
    return;
  }
  const peer = worldPlayers.get(msg.to);
  // Dropped in silence on purpose: a peer that just left, or stepped through a
  // level seam mid-handshake, is a race the caller already recovers from.
  if (!peer || peer === ws || peer.world.level !== w.level) return;
  send(peer, { type: 'world-signal', from: w.id, data: msg.data });
}

// ---------------------------------------------------------------- analytics

// A failure here must never take the chat down with it: a bad Turso token or
// an unreachable database costs the dashboard, nothing else.
let analytics = null;
try {
  analytics = await createAnalytics({
    url: ANALYTICS_URL,
    authToken: ANALYTICS_AUTH_TOKEN,
    retentionDays: ANALYTICS_RETENTION_DAYS,
    siteHosts: ANALYTICS_SITE_HOSTS,
    excludeViewer: ADMIN_USERNAME,
    allowedOrigins: ALLOWED_ORIGINS,
    timeZone: ANALYTICS_TIME_ZONE,
  });
  if (analytics) console.log('analytics: peeko store ready');
} catch (err) {
  console.error('analytics: disabled,', err?.message ?? err);
  analytics = null;
}

// Admin sockets watching the live event feed -> their unsubscribe function.
const analyticsWatchers = new Map();

// Every analytics read is admin-only. The socket already proved who it is at
// login, so the dashboard needs no token of its own.
function analyticsGuard(ws) {
  if (!ws.isAdmin) {
    sendError(ws, 'forbidden');
    return false;
  }
  if (!analytics) {
    sendError(ws, 'unavailable', 'Analytics is not configured on this server.');
    return false;
  }
  return true;
}

function handlePeekoMonitor(ws, msg) {
  if (!analyticsGuard(ws)) return;
  analytics
    .monitor(Number(msg.rangeHours))
    .then((data) => send(ws, { type: 'peeko-monitor', ...data }))
    .catch((err) => sendError(ws, 'server', String(err?.message ?? 'query failed')));
}

function handlePeekoBreakdown(ws, msg) {
  if (!analyticsGuard(ws)) return;
  const prop = typeof msg.prop === 'string' ? msg.prop : '';
  if (!prop) {
    strike(ws);
    return;
  }
  analytics
    .breakdown({
      event: typeof msg.event === 'string' ? msg.event : null,
      prop,
      rangeHours: Number(msg.rangeHours),
      distinct: msg.distinct === true,
    })
    .then((rows) =>
      send(ws, { type: 'peeko-breakdown', event: msg.event ?? null, prop, rows })
    )
    .catch((err) => sendError(ws, 'server', String(err?.message ?? 'query failed')));
}

function handlePeekoLive(ws, msg) {
  if (!analyticsGuard(ws)) return;
  const on = msg.on !== false;
  const existing = analyticsWatchers.get(ws);
  if (!on) {
    if (existing) {
      existing();
      analyticsWatchers.delete(ws);
    }
    return;
  }
  if (existing) return;
  analyticsWatchers.set(
    ws,
    analytics.subscribe((event) => send(ws, { type: 'peeko-event', event }))
  );
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
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.add(token);
    stmt.insertAdminToken.run(token, Date.now());
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

// Admin sessions persist like everyone else's: same 90-day TTL, same hourly
// sweep. The in-memory Set is just a read cache in front of admin_tokens.
const adminTokens = new Set();

function isAdminToken(token) {
  if (adminTokens.has(token)) return true;
  const row = stmt.adminToken.get(token);
  if (!row || Date.now() - row.created_at > TOKEN_TTL_MS) return false;
  adminTokens.add(token);
  return true;
}

function resumeToken(ws, token) {
  if (typeof token !== 'string' || token.length > 64) return false;
  if (isAdminToken(token)) {
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
      // one socket, one identity: a guest who renames themselves from the 3D
      // world's own panel has to change on the plate over their head too, and
      // the roster the other clients hold is the only copy of that name they
      // have. Sent to everyone but us, who already got the nick-ok
      if (ws.world) worldBroadcast({ type: 'world-name', id: ws.world.id, name: nick }, ws);
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
    case 'score-submit':
      handleScoreSubmit(ws, msg);
      return;
    case 'score-top':
      handleScoreTop(ws, msg);
      return;
    case 'duel-queue':
      handleDuelQueue(ws);
      return;
    case 'duel-leave':
      leaveDuel(ws, 'forfeit');
      return;
    case 'duel-plant':
      handleDuelPlant(ws, msg);
      return;
    case 'duel-dig':
      handleDuelDig(ws, msg);
      return;
    case 'duel-rematch':
      handleDuelRematch(ws);
      return;
    case 'world-join':
      handleWorldJoin(ws, msg);
      return;
    case 'world-leave':
      leaveWorld(ws);
      return;
    case 'world-move':
      handleWorldMove(ws, msg);
      return;
    case 'world-level':
      handleWorldLevel(ws, msg);
      return;
    case 'world-chat':
      handleWorldChat(ws, msg);
      return;
    case 'world-signal':
      handleWorldSignal(ws, msg);
      return;
    case 'world-seat':
      handleWorldSeat(ws, msg);
      return;
    case 'world-unseat':
      handleWorldUnseat(ws);
      return;
    case 'world-vehicle':
      handleWorldVehicle(ws, msg);
      return;
    case 'world-look':
      handleWorldLook(ws, msg);
      return;
    case 'peeko-monitor':
      handlePeekoMonitor(ws, msg);
      return;
    case 'peeko-breakdown':
      handlePeekoBreakdown(ws, msg);
      return;
    case 'peeko-live':
      handlePeekoLive(ws, msg);
      return;
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
  // The only public analytics route: browsers appending events. Reads happen
  // over the authenticated WebSocket, never here.
  if (analytics) {
    analytics
      .handleHttp(req, res)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      })
      .catch(() => {
        if (res.headersSent) return res.end();
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('error');
      });
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
  ws.duel = null;
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
    leaveDuel(ws, 'left');
    leaveWorld(ws);
    const unwatch = analyticsWatchers.get(ws);
    if (unwatch) {
      unwatch();
      analyticsWatchers.delete(ws);
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
  const now = Date.now();
  for (const [key, arr] of authRateByIp) {
    if (arr.length === 0 || now - arr[arr.length - 1] >= AUTH_RATE_WINDOW_MS) {
      authRateByIp.delete(key);
    }
  }
}, HEARTBEAT_MS);

// Hourly sweep so the tokens table can't grow without bound.
const tokenSweep = setInterval(() => {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  stmt.deleteExpiredTokens.run(cutoff);
  stmt.deleteExpiredAdminTokens.run(cutoff);
  // drop the read cache too, so a swept token cannot resume from memory
  adminTokens.clear();
}, TOKEN_SWEEP_MS);
tokenSweep.unref();

// ---------------------------------------------------------------- lifecycle

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(tokenSweep);
  if (worldTicker) clearInterval(worldTicker);
  for (const ws of wss.clients) ws.terminate();
  wss.close(() => {
    server.close(async () => {
      db.close();
      // flushes the last second of buffered events before the process goes
      await analytics?.stop().catch(() => {});
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
