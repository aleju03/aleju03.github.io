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
  flappy: { order: 'desc', max: 9_999 },
  'vsrg-boot': { order: 'desc', max: 2_000_000 },
  'vsrg-dialup': { order: 'desc', max: 2_000_000 },
  'vsrg-overclock': { order: 'desc', max: 2_000_000 },
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
