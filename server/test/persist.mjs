/*
 * Persisted Cubeland edits (worldPersist.js), in-process: write block edits,
 * "restart" (a new database connection, a new blocks module, a new
 * persistence over the same file), and the edits are back for a late joiner;
 * the debounce coalesces, the shutdown path writes at once, a private room's
 * blocks (never attached) leave nothing behind, a level is never forgotten
 * from memory, and the 250,000-edit cap packs and restores in bounded time.
 *
 * It drives the real worldBlocks.js when the tree has it (the Cubeland
 * branch), else a stand-in that speaks the same three-function contract.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createWorldPersistence, packEdits, unpackEdits } from '../src/worldPersist.js';

const standIn = ({ players, send }) => {
  const levels = new Map();
  return {
    snapshot: (ws) => {
      const l = levels.get(ws.world.level);
      const edits = [];
      if (l) for (const [k, id] of l) { const [x, y, z] = k.split(',').map(Number); edits.push(x, y, z, id); }
      send(ws, { type: 'world-blockmap', level: ws.world.level, edits });
    },
    left: () => {},
    handle: (ws, m) => {
      const w = ws.world;
      if (!w || m.level !== w.level || m.type !== 'world-blocks' || m.edits.length % 4) return;
      let l = levels.get(w.level);
      if (!l) levels.set(w.level, (l = new Map()));
      for (let i = 0; i < m.edits.length; i += 4) {
        const k = `${m.edits[i]},${m.edits[i + 1]},${m.edits[i + 2]}`;
        l.delete(k);
        l.set(k, m.edits[i + 3]);
        if (l.size > 250_000) l.delete(l.keys().next().value);
      }
      for (const s of players.values()) if (s !== ws && s.world?.level === w.level) send(s, { type: 'world-blocks', level: w.level, edits: m.edits });
    },
  };
};
let makeBlocks = standIn;
let real = false;
try {
  const mod = await import('../src/worldBlocks.js');
  makeBlocks = ({ players, send }) => mod.createWorldBlocks({ players, send });
  real = true;
} catch { /* the stand-in */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function persistSmoke() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-'));
  const file = path.join(dir, 'w.db');
  const quiet = { error() {}, log() {} };
  try {
    // packing on its own
    const e = [-800, 95, 800, 255, 0, 0, 0, 1, 12, 3, -7, 200];
    assert.deepEqual(unpackEdits(packEdits(e)), e);

    // ---- boot 1: the public room's blocks, watched
    let db = new Database(file);
    let persist = createWorldPersistence({ db, debounceMs: 40, log: quiet });
    const sent = [];
    const players = new Map();
    let blocks = makeBlocks({ players, send: persist.wrapSend((ws, m) => sent.push([ws, m])) });
    let room = persist.attach(blocks);
    assert.equal(persist.restore(blocks), 0, 'nothing stored yet');
    const ws = { world: { id: 1, level: 'cubeland' } };
    players.set(1, ws);
    room.handle(ws, { type: 'world-blocks', level: 'cubeland', edits: [1, 2, 3, 4, 5, 6, 7, 8] });
    room.handle(ws, { type: 'world-blocks', level: 'cubeland', edits: [1, 2, 3, 9] });
    assert.equal(persist.pending, 1, 'one dirty level, however many messages');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM world_blocks').get().n, 0, 'the write is debounced');
    await sleep(120)
    await persist.idle();
    let row = db.prepare('SELECT * FROM world_blocks WHERE level = ?').get('cubeland');
    assert.equal(row.edits, 2, 'two cells (the first was overwritten)');
    assert.equal(persist.stats.writes, 1)
    // an identical dump is not rewritten
    room.handle(ws, { type: 'world-blocks', level: 'cubeland', edits: [1, 2, 3, 9] });
    await persist.flushNow();
    assert.equal(persist.stats.writes, 1, 'unchanged bytes are skipped');
    assert.equal(persist.stats.skipped, 1);
    // the shutdown path writes at once, synchronously
    room.handle(ws, { type: 'world-blocks', level: 'cubeland', edits: [10, 11, 12, 13] });
    room.handle({ world: { id: 2, level: 'moon-x' } }, { type: 'world-blocks', level: 'moon-x', edits: [0, 1, 0, 2] });
    persist.flushSync();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM world_blocks').get().n, 2, 'both levels written on the signal');
    // a private room's blocks are never attached: nothing of theirs is written
    const priv = makeBlocks({ players, send: () => {} });
    priv.handle(ws, { type: 'world-blocks', level: 'cubeland', edits: [99, 1, 99, 5] });
    await sleep(100);
    persist.flushSync();
    persist.stop();
    db.close();

    // ---- boot 2: a new process's worth of state over the same file
    db = new Database(file);
    persist = createWorldPersistence({ db, debounceMs: 40, log: quiet });
    const out = [];
    const players2 = new Map();
    blocks = makeBlocks({ players: players2, send: persist.wrapSend((w, m) => out.push([w, m])) });
    room = persist.attach(blocks);
    assert.equal(persist.restore(blocks), 4, 'four edits came back (three cubeland cells and one on the other level)');
    assert.equal(persist.pending, 0, 'restoring is not a change to write back');
    const late = { world: { id: 7, level: 'cubeland' } };
    room.snapshot(late);
    const map = out.at(-1)[1];
    assert.equal(map.type, 'world-blockmap');
    assert.deepEqual([...map.edits].sort((a, b) => a - b), [1, 2, 3, 9, 5, 6, 7, 8, 10, 11, 12, 13].sort((a, b) => a - b), 'the late joiner gets the stored world');
    assert.ok(!map.edits.includes(99), "and not the private room's edit");
    room.snapshot({ world: { level: 'moon-x', id: 8 } });
    assert.deepEqual(out.at(-1)[1].edits, [0, 1, 0, 2], 'each level comes back under its own name');
    // left() is swallowed: an empty level is never forgotten from memory
    room.left('cubeland');
    room.snapshot({ world: { level: 'cubeland', id: 9 } });
    assert.equal(out.at(-1)[1].edits.length, 12);
    persist.stop();
    db.close();

    // ---- the cap: 250,000 edits
    const big = [];
    for (let i = 0; i < 250_000; i++) big.push((i % 1600) - 800, i % 96, Math.floor(i / 1600) % 1601 - 800, (i * 7) % 256);
    db = new Database(file);
    persist = createWorldPersistence({ db, debounceMs: 40, log: quiet });
    blocks = makeBlocks({ players: new Map(), send: persist.wrapSend(() => {}) });
    room = persist.attach(blocks);
    persist.restore(blocks);
    const w = { world: { id: 1, level: 'big' } };
    for (let i = 0; i < big.length; i += 2048 * 4) {
      // a socket at a time: the module's own rate would otherwise refuse the burst
      room.handle({ world: { id: 1, level: 'big' } }, { type: 'world-blocks', level: 'big', edits: big.slice(i, i + 2048 * 4) });
    }
    void w;
    const t0 = performance.now();
    await persist.flushNow();
    const wrote = performance.now() - t0;
    const stored = db.prepare('SELECT edits, length(data) AS bytes FROM world_blocks WHERE level = ?').get('big');
    assert.ok(stored.edits > 200_000 && stored.edits <= 250_000, `stored ${stored.edits}`);
    const persistPackMs = persist.stats.packMs;
    persist.stop();
    db.close();
    db = new Database(file);
    persist = createWorldPersistence({ db, log: quiet });
    blocks = makeBlocks({ players: new Map(), send: persist.wrapSend(() => {}) });
    const t1 = performance.now();
    const n = persist.restore(blocks);
    const loaded = performance.now() - t1;
    assert.ok(n >= stored.edits, `restored ${n}`);
    persist.stop();
    db.close();
    console.log(`   persistence (${real ? 'real worldBlocks.js' : 'stand-in'}): ${stored.edits} edits -> ${(stored.bytes / 1024).toFixed(0)} KB, write ${wrote.toFixed(0)} ms (loop blocked ${persistPackMs.toFixed(0)} ms), boot load ${loaded.toFixed(0)} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
