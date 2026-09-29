/*
 * Cubeland's edits, kept across a restart, for the public room only.
 *
 * worldBlocks.js holds the last word on every block somebody has broken or
 * placed, in memory. That is the whole of what differs from the generated
 * world, and it is small and self-contained, so it is the one piece of the
 * shared world worth writing down: a deploy or a crash used to reset the
 * public Cubeland to bare terrain, and now it comes back as it was left.
 *
 * WHAT IS NOT KEPT, on purpose. The public room's *props* are not persisted,
 * and neither is anything else the shared walk holds. A prop is a live
 * simulation owned by one browser at a time (an authority, an epoch, a
 * kinematic hand-off in flight), its bodies are Rapier state that only a
 * client can step, and every one carries an ownership record (the account or
 * socket that made it, the friends who may use it, protection's switch and
 * the 150-per-owner cap) that means nothing once those sockets are gone. A
 * restored crate would be an orphan no client owns and nobody may remove, in
 * a pose frozen mid-air. Blocks have none of that: a cell is an integer, the
 * world is a pure function of coordinates, and the server already stores only
 * the deltas. Private rooms stay ephemeral for the same reason a room does.
 *
 * Shape. One row per level in `world_blocks`: the edits packed into six
 * bytes each (x and z int16, y and id uint8, which the wire's own bounds
 * guarantee fit), zlib-deflated. 250,000 edits (the module's cap) is 1.5 MB
 * before deflate. The persistence wraps a blocks module from the outside and
 * needs nothing from it beyond the three functions it already has, so there
 * is no second copy of the map to keep in step:
 *
 *   - `wrapSend(send)` goes in as the blocks module's `send`. Its only job is
 *     to hand a snapshot destined for the persistence's own stand-in socket
 *     back as data, instead of stringifying a million numbers for nobody.
 *   - `attach(blocks)` returns the same module with `handle` watched (any
 *     `world-blocks` message marks its level dirty) and `left` swallowed:
 *     a persisted level must never be forgotten from memory by the module's
 *     empty-level timeout, because the next edit would then be written over
 *     the stored world with nearly nothing.
 *   - `restore(blocks)` feeds the stored rows back through `handle` in
 *     2,048-edit messages (the module's own limit, one stand-in socket per
 *     message so its per-socket rate never trips), oldest first, so the
 *     module's oldest-forgotten-first cap works exactly as if the edits had
 *     just arrived.
 *
 * Writes are debounced (30 s after the first change, so a busy world costs
 * one write per interval) and batched: the snapshot and pack of a level are
 * synchronous (about 20 ms at the cap, measured in the smoke test), the deflate
 * is off-thread, and a level whose packed bytes equal what is stored is not
 * rewritten. `flushSync` is what the shutdown signal runs. Nothing here can
 * throw into the server: a database error is logged and the next interval
 * tries again.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const CAPTURE = Symbol('worldPersist.capture');
const PER_MESSAGE = 2048;
const RECORD = 6;
const MAX_LEVELS = 16;
const LEVEL_RE = /^[a-z0-9-]{1,24}$/;

export const packEdits = (edits) => {
  const n = edits.length / 4;
  const buf = Buffer.allocUnsafe(n * RECORD);
  for (let i = 0; i < n; i++) {
    const o = i * RECORD;
    buf.writeInt16LE(edits[i * 4], o);
    buf.writeUInt8(edits[i * 4 + 1], o + 2);
    buf.writeInt16LE(edits[i * 4 + 2], o + 3);
    buf.writeUInt8(edits[i * 4 + 3], o + 5);
  }
  return buf;
};

export const unpackEdits = (buf) => {
  if (buf.length % RECORD) return [];
  const n = buf.length / RECORD;
  const edits = new Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * RECORD;
    edits[i * 4] = buf.readInt16LE(o);
    edits[i * 4 + 1] = buf.readUInt8(o + 2);
    edits[i * 4 + 2] = buf.readInt16LE(o + 3);
    edits[i * 4 + 3] = buf.readUInt8(o + 5);
  }
  return edits;
};

export function createWorldPersistence({ db, debounceMs = 30_000, log = console } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_blocks (
      level TEXT PRIMARY KEY,
      edits INTEGER NOT NULL,
      data BLOB NOT NULL,
      at INTEGER NOT NULL
    );
  `);
  const q = {
    all: db.prepare('SELECT level, data FROM world_blocks ORDER BY level'),
    put: db.prepare('INSERT INTO world_blocks (level, edits, data, at) VALUES (?, ?, ?, ?) ON CONFLICT(level) DO UPDATE SET edits = excluded.edits, data = excluded.data, at = excluded.at'),
  };
  const digest = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
  const dirty = new Set();
  const lastPacked = new Map();
  let inner = null;
  let timer = null;
  let flushing = null;
  const stats = { writes: 0, skipped: 0, restored: 0, lastMs: 0, packMs: 0 };

  /** a level's whole map as packed bytes, or null if it cannot be read */
  const pack = (level) => {
    if (!inner) return null;
    const t0 = performance.now();
    let edits = null;
    inner.snapshot({ world: { level, id: 0 }, [CAPTURE]: (m) => { edits = m.edits; } });
    const packed = edits ? packEdits(edits) : null;
    stats.packMs = Math.max(stats.packMs, performance.now() - t0);
    return packed;
  };

  const write = (level, packed, z) => {
    // an empty map is never written: cells are only ever overwritten, not
    // removed, so "empty" means the level was not loaded, and must not
    // erase what is stored
    if (packed.length === 0) return;
    const key = digest(z);
    if (lastPacked.get(level) === key) {
      stats.skipped++;
      return;
    }
    q.put.run(level, packed.length / RECORD, z, Date.now());
    lastPacked.set(level, key);
    stats.writes++;
  };

  const deflate = (buf) => new Promise((resolve, reject) => zlib.deflate(buf, { level: 6 }, (e, z) => (e ? reject(e) : resolve(z))));

  const flush = async () => {
    if (flushing) return flushing;
    timer = null;
    flushing = (async () => {
      const t0 = performance.now();
      for (const level of [...dirty]) {
        dirty.delete(level);
        try {
          const packed = pack(level);
          if (!packed) continue;
          write(level, packed, await deflate(packed));
        } catch (err) {
          dirty.add(level);
          log.error('world persistence: write failed,', err?.message ?? err);
        }
        // yield between levels so a write never holds the loop
        await new Promise((r) => setImmediate(r));
      }
      stats.lastMs = performance.now() - t0;
    })().finally(() => {
      flushing = null;
      if (dirty.size) schedule();
    });
    return flushing;
  };

  function schedule() {
    if (timer || !inner) return;
    timer = setTimeout(() => { void flush(); }, debounceMs);
    timer.unref?.();
  }

  return {
    stats,
    /** goes in as the blocks module's `send` */
    wrapSend: (send) => (ws, m) => (ws?.[CAPTURE] ? ws[CAPTURE](m) : send(ws, m)),

    /** the same module, watched. Call once, on the public room's */
    attach: (blocks) => {
      inner = blocks;
      return {
        snapshot: blocks.snapshot,
        // never let the module forget a persisted level (see the header)
        left: () => {},
        handle: (ws, m) => {
          blocks.handle(ws, m);
          const level = ws?.world?.level;
          if (m?.type === 'world-blocks' && typeof level === 'string' && LEVEL_RE.test(level) && (dirty.has(level) || dirty.size < MAX_LEVELS)) {
            dirty.add(level);
            schedule();
          }
        },
      };
    },

    /** load every stored level back into the module; returns edits restored */
    restore: (blocks = inner) => {
      let total = 0;
      for (const row of q.all.all()) {
        if (!LEVEL_RE.test(row.level)) continue;
        let packed;
        try {
          packed = zlib.inflateSync(row.data, { maxOutputLength: 250_000 * RECORD + 64 });
        } catch (err) {
          log.error('world persistence: could not read', row.level, err?.message ?? err);
          continue;
        }
        const edits = unpackEdits(packed);
        for (let i = 0; i < edits.length; i += PER_MESSAGE * 4) {
          blocks.handle({ world: { level: row.level, id: 0 } }, {
            type: 'world-blocks', level: row.level, edits: edits.slice(i, i + PER_MESSAGE * 4), blast: false,
          });
        }
        lastPacked.set(row.level, digest(row.data));
        total += edits.length / 4;
      }
      stats.restored = total;
      return total;
    },

    /** write everything now, synchronously: the shutdown signal's path */
    flushSync: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const level of [...dirty]) {
        dirty.delete(level);
        try {
          const packed = pack(level);
          if (packed) write(level, packed, zlib.deflateSync(packed, { level: 6 }));
        } catch (err) {
          log.error('world persistence: final write failed,', err?.message ?? err);
        }
      }
    },

    /** for tests: wait for a pending debounced write */
    idle: async () => { if (flushing) await flushing; },
    flushNow: () => flush(),
    get pending() { return dirty.size; },
    stop: () => { if (timer) clearTimeout(timer); timer = null; },
  };
}
