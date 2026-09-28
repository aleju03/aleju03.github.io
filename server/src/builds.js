/*
 * The public gallery of published builds: blueprints (src/game/sandbox/
 * blueprint/) that registered accounts have put up for anybody to browse,
 * preview and pull into their own slots or spawn directly.
 *
 * REST, not the socket, on purpose. Browsing must work for a guest who never
 * opened the world's socket, and the client that reads the gallery (the
 * builds book in the spawn catalogue) is not the code that owns the world's
 * WebSocket; so this is one more public route beside the video search and
 * the analytics capture, built the same way: origin-checked, rate-limited
 * per IP, JSON in and out, mounted in the server's route list. Publishing
 * and deleting carry the session token as `Authorization: Bearer`, which the
 * server resolves exactly as the socket's `hello` does (`authenticate`,
 * supplied by index.js so this file stays free of the auth tables).
 *
 *   GET    /builds?sort=new|top&page=N   a page of ten, newest or most spawned
 *                                        (metadata and the small thumbnail)
 *   GET    /builds/:id                   one build with its code; counts as a
 *                                        spawn (once per IP and build per ten
 *                                        minutes, so a reload is not a vote)
 *   POST   /builds                       {name, code, thumb?} publish (account)
 *   DELETE /builds/:id                   its author, or an admin
 *
 * Everything a client says is checked and bounded. A code is inflated here
 * (zlib, capped at 1 MB out), parsed and walked with the same rules the
 * client's importer applies (code.ts `fromJson`), except that the server
 * refuses rather than clamps, and kinds are checked against `PROP_KINDS`, so
 * a published build can only ever name props the world relays. The name goes
 * through the chat's sanitiser (control characters out, one line) and is
 * held to 40 characters; the thumbnail must be a PNG data URL of at most
 * 20 KB whose bytes really begin with the PNG signature. An account holds at
 * most 20 builds (re-publishing a name replaces that build and costs no
 * slot), publishes at most 5 per ten minutes, and the table as a whole is
 * bounded by the accounts times twenty. Nothing is executed or fetched: the
 * code is data, and the client re-validates it on the way in anyway.
 */
import zlib from 'node:zlib';
import { PROP_KINDS } from './props.js';

export const MAX_CODE = 64 * 1024;
export const MAX_THUMB = 20 * 1024;
export const MAX_NAME = 40;
export const PER_ACCOUNT = 20;
export const PAGE_SIZE = 10;
const MAX_PROPS = 300;
const MAX_JOINTS = 1200;
const MAX_INFLATED = 1024 * 1024;
const MAX_BODY = MAX_CODE + MAX_THUMB + 4096;
const KEY_PAIRS = 6;
const READ_RATE = { max: 90, window: 60_000 };
const ATTEMPT_RATE = { max: 30, window: 10 * 60_000 };
const PUBLISH_WINDOW = 10 * 60_000;
const DELETE_RATE = { max: 20, window: 60_000 };
const PULL_DEDUPE_MS = 10 * 60_000;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const within = (n, lo, hi) => finite(n) && n >= lo && n <= hi;
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** a share code the server is willing to keep: the count of props, or null */
export function checkCode(code) {
  if (typeof code !== 'string' || code.length > MAX_CODE || !code.startsWith('BP1.')) return null;
  const body = code.slice(4);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  let json;
  try {
    const raw = zlib.inflateSync(Buffer.from(body, 'base64url'), { maxOutputLength: MAX_INFLATED });
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || json.v !== 1 || !Array.isArray(json.p) || !Array.isArray(json.j)) return null;
  if (json.p.length < 1 || json.p.length > MAX_PROPS || json.j.length > MAX_JOINTS) return null;
  for (const r of json.p) {
    if (!Array.isArray(r) || r.length !== 13) return null;
    if (typeof r[0] !== 'string' || !PROP_KINDS.has(r[0])) return null;
    if (!within(r[1], 0.2, 4) || !within(r[2], 0, 20000)) return null;
    if (r[3] !== 0 && r[3] !== 1) return null;
    for (let i = 4; i < 7; i++) if (!within(r[i], -400, 400)) return null;
    let len = 0;
    for (let i = 7; i < 11; i++) {
      if (!within(r[i], -1, 1)) return null;
      len += r[i] * r[i];
    }
    if (len < 0.25) return null;
    if (r[11] !== -1 && !isInt(r[11], 0, KEY_PAIRS - 1)) return null;
    if (r[12] !== 0 && r[12] !== 1) return null;
  }
  for (const r of json.j) {
    if (!Array.isArray(r) || r.length !== 20) return null;
    if (!isInt(r[0], 0, 3) || !isInt(r[1], 0, json.p.length - 1) || !isInt(r[2], 0, json.p.length - 1) || r[1] === r[2]) return null;
    for (let i = 3; i < 19; i++) if (!within(r[i], -1000, 1000)) return null;
    if (!within(r[19], 0, 1e6)) return null;
  }
  return json.p.length;
}

/** a thumbnail we will store: a small PNG data URL, else null */
export function checkThumb(thumb) {
  if (thumb === undefined || thumb === null || thumb === '') return '';
  if (typeof thumb !== 'string' || thumb.length > MAX_THUMB) return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(thumb);
  if (!m) return null;
  const head = Buffer.from(m[1].slice(0, 16), 'base64');
  if (head.length < 8 || head.readUInt32BE(0) !== 0x89504e47 || head.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return thumb;
}

export function createBuildGallery({ db, allowedOrigins = [], authenticate, now = Date.now, publishMax = 5 }) {
  const PUBLISH_RATE = { max: publishMax, window: PUBLISH_WINDOW };
  db.exec(`
    CREATE TABLE IF NOT EXISTS builds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      thumb TEXT NOT NULL DEFAULT '',
      props INTEGER NOT NULL,
      spawns INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL,
      UNIQUE(author, name)
    );
    CREATE INDEX IF NOT EXISTS idx_builds_at ON builds(at);
    CREATE INDEX IF NOT EXISTS idx_builds_spawns ON builds(spawns, at);
  `);
  const q = {
    page: {
      new: db.prepare('SELECT id, author, name, thumb, props, spawns, at FROM builds ORDER BY at DESC, id DESC LIMIT ? OFFSET ?'),
      top: db.prepare('SELECT id, author, name, thumb, props, spawns, at FROM builds ORDER BY spawns DESC, at DESC, id DESC LIMIT ? OFFSET ?'),
    },
    total: db.prepare('SELECT COUNT(*) AS n FROM builds'),
    one: db.prepare('SELECT id, author, name, code, thumb, props, spawns, at FROM builds WHERE id = ?'),
    byAuthor: db.prepare('SELECT COUNT(*) AS n FROM builds WHERE author = ?'),
    existing: db.prepare('SELECT id FROM builds WHERE author = ? AND name = ?'),
    insert: db.prepare('INSERT INTO builds (author, name, code, thumb, props, at) VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE builds SET code = ?, thumb = ?, props = ?, at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM builds WHERE id = ?'),
    pull: db.prepare('UPDATE builds SET spawns = spawns + 1 WHERE id = ?'),
  };

  const hits = { read: new Map(), attempt: new Map(), publish: new Map(), remove: new Map() };
  const allow = (kind, key, rate) => {
    const t = now();
    const map = hits[kind];
    const list = (map.get(key) ?? []).filter((x) => t - x < rate.window);
    if (list.length >= rate.max) {
      map.set(key, list);
      return false;
    }
    list.push(t);
    map.set(key, list);
    return true;
  };
  const pulled = new Map();
  const sweep = setInterval(() => {
    const t = now();
    for (const map of Object.values(hits)) {
      for (const [k, list] of map) if (!list.length || t - list[list.length - 1] > 10 * 60_000) map.delete(k);
    }
    for (const [k, at] of pulled) if (t - at > PULL_DEDUPE_MS) pulled.delete(k);
  }, 60_000);
  sweep.unref();

  const originOK = (origin) => allowedOrigins.length === 0 || !origin || allowedOrigins.includes(origin);
  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(body));
  };
  const summary = (r) => ({ id: r.id, name: r.name, author: r.author, props: r.props, spawns: r.spawns, at: r.at, thumb: r.thumb });
  // a body over the limit is drained (not buffered) and answered with a 413,
  // rather than the socket being torn down under a client that is still
  // sending; a truly huge one is cut off outright
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > 4 * MAX_BODY) return req.destroy();
        if (n <= MAX_BODY) chunks.push(c);
      });
      req.on('end', () => (n > MAX_BODY ? reject(new Error('too_large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  const userOf = (req) => {
    const h = req.headers.authorization;
    if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
    const token = h.slice(7).trim();
    if (!token || token.length > 64) return null;
    return authenticate(token);
  };

  async function handleHttp(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    const m = /^\/builds(?:\/(\d{1,12}))?$/.exec(url.pathname);
    if (!m) return false;
    const origin = req.headers.origin;
    if (!originOK(origin)) {
      json(res, 403, { error: 'forbidden_origin' });
      return true;
    }
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '86400',
      });
      res.end();
      return true;
    }
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const id = m[1] ? Number(m[1]) : null;
    const reply = (status, body) => json(res, status, body, cors);

    if (req.method === 'GET') {
      if (!allow('read', ip, READ_RATE)) return reply(429, { error: 'rate' }), true;
      if (id === null) {
        const sort = url.searchParams.get('sort') === 'top' ? 'top' : 'new';
        const page = Math.max(0, Math.min(10_000, Math.floor(Number(url.searchParams.get('page')) || 0)));
        const rows = q.page[sort].all(PAGE_SIZE, page * PAGE_SIZE);
        reply(200, { builds: rows.map(summary), total: q.total.get().n, page, size: PAGE_SIZE, sort });
        return true;
      }
      const row = q.one.get(id);
      if (!row) return reply(404, { error: 'not_found' }), true;
      const key = `${ip}:${id}`;
      const last = pulled.get(key);
      if (last === undefined || now() - last > PULL_DEDUPE_MS) {
        pulled.set(key, now());
        q.pull.run(id);
        row.spawns += 1;
      }
      reply(200, { ...summary(row), code: row.code });
      return true;
    }

    if (req.method === 'POST' && id === null) {
      const user = userOf(req);
      if (!user) return reply(401, { error: 'login' }), true;
      // every attempt costs an inflate, so attempts are bounded loosely; only
      // a publish that will be kept spends the strict allowance below
      if (!allow('attempt', user.username, ATTEMPT_RATE) || !allow('attempt', `ip:${ip}`, ATTEMPT_RATE)) {
        return reply(429, { error: 'rate' }), true;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return reply(err?.message === 'too_large' ? 413 : 400, { error: err?.message === 'too_large' ? 'too_large' : 'bad_request' }), true;
      }
      if (!body || typeof body !== 'object') return reply(400, { error: 'bad_request' }), true;
      const name = cleanName(body.name);
      if (!name) return reply(400, { error: 'name' }), true;
      const props = checkCode(body.code);
      if (props === null) return reply(400, { error: 'code' }), true;
      const thumb = checkThumb(body.thumb);
      if (thumb === null) return reply(400, { error: 'thumb' }), true;
      if (!allow('publish', user.username, PUBLISH_RATE) || !allow('publish', `ip:${ip}`, { max: publishMax * 3, window: PUBLISH_WINDOW })) {
        return reply(429, { error: 'rate' }), true;
      }
      const author = user.username;
      const existing = q.existing.get(author, name);
      if (existing) {
        q.update.run(body.code, thumb, props, now(), existing.id);
        return reply(200, { id: existing.id, replaced: true }), true;
      }
      if (q.byAuthor.get(author).n >= PER_ACCOUNT) return reply(409, { error: 'limit', limit: PER_ACCOUNT }), true;
      const info = q.insert.run(author, name, body.code, thumb, props, now());
      reply(201, { id: Number(info.lastInsertRowid), replaced: false });
      return true;
    }

    if (req.method === 'DELETE' && id !== null) {
      const user = userOf(req);
      if (!user) return reply(401, { error: 'login' }), true;
      if (!allow('remove', user.username, DELETE_RATE)) return reply(429, { error: 'rate' }), true;
      const row = q.one.get(id);
      if (!row) return reply(404, { error: 'not_found' }), true;
      if (row.author !== user.username && !user.admin) return reply(403, { error: 'forbidden' }), true;
      q.remove.run(id);
      reply(200, { ok: true });
      return true;
    }

    reply(405, { error: 'method' });
    return true;
  }

  return { handleHttp, stop: () => clearInterval(sweep) };
}
