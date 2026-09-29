/*
 * Cubeland's blocks, per level: the last word on every block somebody has
 * broken or placed. The world itself is a pure function of block
 * coordinates on every client, so this is the whole of what differs from
 * it, as a map from "x,y,z" to a block id. Edits are relayed to everyone
 * else in the level as they come; a socket arriving (or changing level)
 * gets the whole map in one `world-blockmap`.
 *
 * Bounded and in memory like the ruins: at most MAX_EDITS blocks per level
 * (the oldest forgotten first), EDITS_PER_MESSAGE a message, a rate per
 * socket, and a level nobody has stood in for EMPTY_TTL_MS is forgotten.
 * Coordinates are held to the world's own box (WORLD blocks either side,
 * HEIGHT tall), and anything else is dropped whole.
 *
 * Claims (claims.js): an edit inside somebody else's claimed chunk column is
 * refused cell by cell, blasts included, and never stored or relayed. The
 * sender is told with a `world-block-refused` carrying, per refused cell, the
 * value the server holds (or -1 when the cell is still the generated
 * terrain), so its optimistic edit is put back rather than left as a ghost
 * only they can see.
 */
export const MAX_EDITS = 250_000;
const EDITS_PER_MESSAGE = 2048;
const EMPTY_TTL_MS = 30 * 60 * 1000;
const WORLD = 800;
const HEIGHT = 96;
const MAX_ID = 255;

const int = (n) => Number.isInteger(n);

export function createWorldBlocks({ players, send, now = Date.now, claims = null }) {
  const levels = new Map();
  const rates = new WeakMap();
  const level = (name) => {
    let l = levels.get(name);
    if (!l) levels.set(name, (l = { blocks: new Map(), emptySince: 0 }));
    return l;
  };
  const peers = (name) => [...players.values()].filter((s) => s.world?.level === name);
  const allow = (ws, cap) => {
    let r = rates.get(ws);
    const at = now();
    if (!r || at - r.at >= 1000) rates.set(ws, (r = { at, n: 0 }));
    return ++r.n <= cap;
  };

  return {
    /** the whole map for the level the socket is in, empty or not: a
        client hands back what it changed that the map lacks only once it
        has heard it, so it never writes over a newer block with its own */
    snapshot: (ws) => {
      const name = ws.world.level;
      let l = levels.get(name);
      if (l && l.emptySince && now() - l.emptySince > EMPTY_TTL_MS) {
        levels.delete(name);
        l = undefined;
      }
      if (l) l.emptySince = 0;
      const edits = [];
      if (l) for (const [k, id] of l.blocks) {
        const [x, y, z] = k.split(',').map(Number);
        edits.push(x, y, z, id);
      }
      send(ws, { type: 'world-blockmap', level: name, edits });
    },
    left: (name) => {
      const l = levels.get(name);
      if (l && !peers(name).length) l.emptySince = now();
    },
    handle: (ws, m) => {
      const w = ws.world;
      if (!w || m.level !== w.level || m.type !== 'world-blocks') return;
      if (!allow(ws, 30) || !Array.isArray(m.edits) || !m.edits.length) return;
      if (m.edits.length % 4 || m.edits.length > EDITS_PER_MESSAGE * 4) return;
      for (let i = 0; i < m.edits.length; i += 4) {
        const [x, y, z, id] = m.edits.slice(i, i + 4);
        if (!int(x) || !int(y) || !int(z) || !int(id)) return;
        if (Math.abs(x) > WORLD || Math.abs(z) > WORLD || y < 0 || y >= HEIGHT || id < 0 || id > MAX_ID) return;
      }
      const l = level(w.level);
      let edits = m.edits;
      if (claims) {
        const kept = [];
        const refused = [];
        let owner = '';
        for (let i = 0; i < edits.length; i += 4) {
          const c = claims.check(ws, edits[i], edits[i + 2]);
          if (!c) { kept.push(edits[i], edits[i + 1], edits[i + 2], edits[i + 3]); continue; }
          owner = c.name;
          refused.push(edits[i], edits[i + 1], edits[i + 2], l.blocks.get(`${edits[i]},${edits[i + 1]},${edits[i + 2]}`) ?? -1);
        }
        if (refused.length) send(ws, { type: 'world-block-refused', level: w.level, edits: refused, owner });
        if (!kept.length) return;
        edits = kept;
      }
      for (let i = 0; i < edits.length; i += 4) {
        const k = `${edits[i]},${edits[i + 1]},${edits[i + 2]}`;
        l.blocks.delete(k);
        l.blocks.set(k, edits[i + 3]);
        if (l.blocks.size > MAX_EDITS) l.blocks.delete(l.blocks.keys().next().value);
      }
      const out = { type: 'world-blocks', level: w.level, from: w.id, edits, blast: m.blast === true };
      for (const s of peers(w.level)) if (s !== ws) send(s, out);
    },
  };
}
