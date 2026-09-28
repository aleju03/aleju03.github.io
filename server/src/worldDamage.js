/*
 * What players have broken, per level. The planet is a pure function of
 * coordinates on every client, so none of it is stored here: a building is
 * its position-stable id and what it lost is a set of small integer piece
 * keys; a felled tree, cactus or lamp post is its own id. This process never
 * interprets either beyond its shape.
 *
 * The state is a grow-only union. Every client reports what it has lifted
 * that the union lacks, the union keeps it and passes on only what was new,
 * so the order reports arrive in and how many clients report the same piece
 * do not matter, and every client ends up with the same holes. Blows being
 * watched (`world-damage`) are relayed and never stored: a late arrival
 * gets the end state in one `world-ruins`, not a replay of every bang.
 *
 * Bounded and in memory, like the prop registry: at most MAX_BUILDINGS
 * ruined buildings and MAX_FELLED felled props per level (the oldest
 * forgotten first), MAX_KEYS pieces per building, and a level nobody has
 * stood in for EMPTY_TTL_MS is forgotten entirely. A client still holding
 * a forgotten ruin reports it again when it next receives a snapshot.
 *
 * The one way the union shrinks is the admin's `rebuild` (`world-rebuild`):
 * the level's ruins and felled props are dropped here and everyone else in
 * it is told to put their town back, which also empties what they report.
 */
export const MAX_BUILDINGS = 256;
export const MAX_KEYS = 4096;
export const MAX_FELLED = 4096;
const EMPTY_TTL_MS = 15 * 60 * 1000;
/** how far from the sender's last pose a blow or a felling may be, units:
    the console reaches 150, a car moves between poses */
const REACH = 200;
const ID_RE = /^-?\d{1,7},-?\d{1,7}:[A-Z][-\d,:]{0,24}$/;
const HOWS = new Set(['impact', 'vehicle', 'command', 'collapse']);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round(n * 100) / 100;
const keyOK = (k) => Number.isSafeInteger(k) && k >= 0 && k < 2 ** 31;

export function createWorldDamage({ players, send, now = Date.now }) {
  const levels = new Map();
  const rates = new WeakMap();
  const level = (name) => {
    let l = levels.get(name);
    if (!l) levels.set(name, (l = { ruins: new Map(), felled: new Set(), emptySince: 0 }));
    return l;
  };
  const peers = (name) => [...players.values()].filter((s) => s.world?.level === name);
  const others = (ws, m) => {
    for (const s of peers(ws.world.level)) if (s !== ws) send(s, { ...m, level: ws.world.level });
  };
  const allow = (ws, kind, cap) => {
    let r = rates.get(ws);
    if (!r) rates.set(ws, (r = {}));
    const at = now();
    if (!r[kind] || at - r[kind].at >= 1000) r[kind] = { at, n: 0 };
    return ++r[kind].n <= cap;
  };
  const near = (w, x, z) => Math.hypot(x - w.x, z - w.z) <= REACH;

  return {
    /** the whole union for the level the socket is in: after world-welcome
        and after every world-level */
    snapshot: (ws) => {
      const name = ws.world.level;
      let l = levels.get(name);
      if (l && l.emptySince && now() - l.emptySince > EMPTY_TTL_MS) {
        levels.delete(name);
        l = undefined;
      }
      if (l) l.emptySince = 0;
      send(ws, {
        type: 'world-ruins', level: name,
        ruins: l ? [...l.ruins].map(([b, keys]) => [b, [...keys]]) : [],
        felled: l ? [...l.felled] : [],
      });
    },
    /** somebody left a level (or the world): start its forgetting clock */
    left: (name) => {
      const l = levels.get(name);
      if (l && !peers(name).length) l.emptySince = now();
    },
    handle: (ws, m) => {
      const w = ws.world;
      if (!w || m.level !== w.level) return;
      if (m.type === 'world-ruin') {
        if (!allow(ws, 'ruin', 60) || typeof m.b !== 'string' || !ID_RE.test(m.b)) return;
        if (!Array.isArray(m.keys) || !m.keys.length || m.keys.length > 1024 || !m.keys.every(keyOK)) return;
        const l = level(w.level);
        let keys = l.ruins.get(m.b);
        if (!keys) {
          if (l.ruins.size >= MAX_BUILDINGS) l.ruins.delete(l.ruins.keys().next().value);
          l.ruins.set(m.b, (keys = new Set()));
        }
        const fresh = [];
        for (const k of m.keys) {
          if (keys.has(k) || keys.size >= MAX_KEYS) continue;
          keys.add(k);
          fresh.push(k);
        }
        if (fresh.length) others(ws, { type: 'world-ruin', b: m.b, keys: fresh });
      } else if (m.type === 'world-fell') {
        if (!allow(ws, 'fell', 40) || typeof m.id !== 'string' || !ID_RE.test(m.id)) return;
        if (!Array.isArray(m.dir) || m.dir.length !== 2 || !m.dir.every(finite) || !finite(m.speed)) return;
        const l = level(w.level);
        if (l.felled.has(m.id)) return;
        if (l.felled.size >= MAX_FELLED) l.felled.delete(l.felled.values().next().value);
        l.felled.add(m.id);
        const len = Math.hypot(m.dir[0], m.dir[1]);
        const dir = len > 1e-3 ? [round(m.dir[0] / len), round(m.dir[1] / len)] : [0, 0];
        others(ws, { type: 'world-fell', id: m.id, dir, speed: len > 1e-3 ? round(clamp(m.speed, 0, 60)) : 0 });
      } else if (m.type === 'world-rebuild') {
        // everyone's town, so the admin's call only
        if (!ws.isAdmin || !allow(ws, 'rebuild', 2)) return;
        const l = level(w.level);
        l.ruins.clear();
        l.felled.clear();
        others(ws, { type: 'world-rebuild' });
      } else if (m.type === 'world-damage') {
        if (!allow(ws, 'damage', 60) || typeof m.b !== 'string' || !ID_RE.test(m.b) || !HOWS.has(m.how)) return;
        const at = Array.isArray(m.at) && m.at.length === 3 && m.at.every(finite) ? m.at : null;
        const dir = Array.isArray(m.dir) && m.dir.length === 3 && m.dir.every(finite) ? m.dir : null;
        if (!at || !dir || !finite(m.power) || !finite(m.radius) || !finite(m.k) || typeof m.ram !== 'boolean') return;
        if (!near(w, at[0], at[2])) return;
        others(ws, {
          type: 'world-damage', from: w.id, b: m.b, how: m.how,
          at: at.map((v) => round(clamp(v, -1e7, 1e7))),
          power: round(clamp(m.power, 0, 1500)),
          radius: round(clamp(m.radius, 0, 40)),
          dir: dir.map((v) => round(clamp(v, -200, 200))),
          k: round(clamp(m.k, 0, 60)),
          ram: m.ram,
          seed: Number.isSafeInteger(m.seed) ? m.seed & 0x7fffffff : 0,
        });
      }
    },
  };
}
