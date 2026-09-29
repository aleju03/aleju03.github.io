/*
 * Creatures, per room and level: a relay, a referee and nothing more.
 *
 * The animals and monsters are simulated by ONE client per scope, the host,
 * because the world they walk on (Cubeland's blocks, a map's collision) is a
 * pure function this process does not have and should not learn. This module
 * does the three things the clients cannot settle between themselves:
 *
 *  1. **Who the host is.** The longest-present player in the scope (the room's
 *     level), reassigned the moment they leave or change level, announced with
 *     `world-creature-host` (which also carries the scope's switches, so a
 *     joiner learns `/mobs off` and `peaceful` in the same message). Nobody
 *     newer ever displaces a host, so the simulation is not handed about while
 *     it is running.
 *  2. **The relay and a bounded table.** The host's snapshot (`world-creatures`,
 *     about 8 Hz, at most MAX_ROWS rows of eight integers) is validated,
 *     clamped and forwarded to everyone else. The last snapshot is kept, one
 *     table per scope, only so a late joiner has something to look at and a
 *     new host can adopt the herd instead of starting a barren world. Nothing
 *     here steps a creature.
 *  3. **Damage, both ways.** A client that hurt a creature sends
 *     `world-creature-hit`; it is checked (the creature exists, the reporter
 *     was within reach of it, the amount clamped, a rate per socket) and
 *     handed to the host, who applies it. The host's report that a creature
 *     hurt a person (`world-creature-attack`) is checked harder, because it
 *     ends in the health system: the attacker must be a creature of a kind
 *     that can do that, in the table, within reach of the victim's reported
 *     pose, past its cooldown against that victim, under a per-scope rate,
 *     and the amount is this file's number, never the host's. A melee blow,
 *     an arrow and a blast are each a fixed damage (a blast falling off with
 *     the distance the server measured); `health.hurt(..., {by: 0, kind:
 *     'mob'})` is the one call that harms anybody, and the pvp flag is
 *     irrelevant to it by construction.
 *
 * Scope is `ws.world.level` inside the room's own `players` map (rooms
 * compose for free). Everything is bounded: rows per snapshot, table size,
 * cooldown maps, message rates. Kind indices mirror src/game/creatures/kinds.ts
 * (append-only); the test that runs beside the smoke test compares them.
 */
export const KIND_COUNT = 9;
export const MAX_ROWS = 64;
// kinds by wire index that may do each thing (kinds.ts): zombie, creeper, arrow
const K_ZOMBIE = 4;
const K_CREEPER = 5;
const K_ARROW = 7;
const MELEE_HP = 5;
const ARROW_HP = 4;
const BLAST_HP = 45;
const BLAST_RADIUS = 11;
// how far the creature's last reported position may be from the victim's pose
const REACH = { melee: 7.5, arrow: 12, blast: BLAST_RADIUS + 6 };
const MELEE_GAP_MS = 700;
const HIT_REACH = 340;
const SPAWN_REACH = 80;
const HIT_MAX = 60;
const KNOCK_MAX = 24;
const COORD = 100_000;
const ID_MAX = 65_000;
const SEEN_CAP = 512;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const int = (n) => Number.isInteger(n);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function createCreatures({ players, send, health = null, now = Date.now }) {
  // level -> { host, on, peaceful, table: Map(id -> row), seen: Map(key -> ms) }
  const scopes = new Map();
  // ws -> { level, at }: when this socket arrived in its scope
  const present = new WeakMap();
  const rates = new WeakMap();
  const scopeRates = new Map();

  const scope = (name) => {
    let s = scopes.get(name);
    if (!s) scopes.set(name, (s = { host: 0, on: true, peaceful: false, table: new Map(), seen: new Map(), attacks: [] }));
    return s;
  };
  const peers = (name) => [...players.values()].filter((s) => s.world?.level === name);
  const toLevel = (name, msg, skip = null) => {
    const text = JSON.stringify(msg);
    for (const s of peers(name)) if (s !== skip && s.readyState === 1) s.send(text);
  };
  const allow = (ws, key, cap, windowMs = 1000) => {
    let r = rates.get(ws);
    if (!r) rates.set(ws, (r = {}));
    const t = now();
    const b = r[key];
    if (!b || t - b.at >= windowMs) {
      r[key] = { at: t, n: 1 };
      return true;
    }
    return ++b.n <= cap;
  };
  const scopeAllow = (name, key, cap) => {
    const k = `${name}\u0000${key}`;
    const t = now();
    const b = scopeRates.get(k);
    if (!b || t - b.at >= 1000) {
      scopeRates.set(k, { at: t, n: 1 });
      if (scopeRates.size > 256) for (const [kk, v] of scopeRates) if (t - v.at > 5000) scopeRates.delete(kk);
      return true;
    }
    return ++b.n <= cap;
  };

  /** the longest-present peer of a scope, or 0 */
  const designate = (name) => {
    let best = null;
    for (const ws of peers(name)) {
      const p = present.get(ws);
      if (!p || p.level !== name) continue;
      if (!best || p.at < best.at || (p.at === best.at && ws.world.id < best.ws.world.id)) best = { ws, at: p.at };
    }
    return best ? best.ws.world.id : 0;
  };
  const announce = (name, to = null) => {
    const s = scope(name);
    const msg = { type: 'world-creature-host', level: name, host: s.host, on: s.on, peaceful: s.peaceful };
    if (to) send(to, msg);
    else toLevel(name, msg);
  };
  const reassign = (name) => {
    const s = scopes.get(name);
    if (!s) return;
    const host = designate(name);
    if (!host && !peers(name).length) {
      scopes.delete(name);
      return;
    }
    if (host !== s.host) {
      s.host = host;
      announce(name);
    }
  };

  const rowPos = (row) => [row[2] / 10, row[3] / 10, row[4] / 10];
  /** the row of a creature the host reported, if any */
  const rowOf = (s, id) => s.table.get(id) ?? null;

  const validRow = (r) => {
    if (!Array.isArray(r) || r.length !== 8) return null;
    for (const n of r) if (!int(n)) return null;
    const [id, kind, x, y, z, yaw, hp, flags] = r;
    if (id < 1 || id > ID_MAX || kind < 0 || kind >= KIND_COUNT) return null;
    if (Math.abs(x) > COORD * 10 || Math.abs(y) > COORD * 10 || Math.abs(z) > COORD * 10) return null;
    return [id, kind, x, y, z, clamp(yaw, -1000, 1000), clamp(hp, 0, 500), clamp(flags, 0, 31)];
  };

  const remember = (s, key) => {
    s.seen.set(key, now());
    if (s.seen.size > SEEN_CAP) {
      const cutoff = now() - 10_000;
      for (const [k, t] of s.seen) if (t < cutoff) s.seen.delete(k);
      while (s.seen.size > SEEN_CAP) s.seen.delete(s.seen.keys().next().value);
    }
  };

  return {
    /** the socket arrived in (or moved into) its current scope: register when, designate, and tell it everything */
    snapshot: (ws) => {
      const name = ws.world.level;
      present.set(ws, { level: name, at: now() });
      const s = scope(name);
      if (!s.host || !players.get(s.host) || players.get(s.host)?.world?.level !== name) s.host = 0;
      const host = designate(name);
      if (host !== s.host) {
        s.host = host;
        announce(name);
      } else announce(name, ws);
      if (s.table.size) send(ws, { type: 'world-creatures', level: name, rows: [...s.table.values()] });
    },
    /** a socket left the world (its id and the scope it was in) */
    left: (id, name) => {
      const s = scopes.get(name);
      if (!s) return;
      if (s.host === id) s.host = -1;
      reassign(name);
    },
    /** a socket changed level: the scope it left needs a host without it */
    moved: (ws, previous) => {
      reassign(previous);
    },
    /** what a snapshot of a scope holds right now (tests, and the harness) */
    table: (name) => [...(scopes.get(name)?.table.values() ?? [])],
    hostOf: (name) => scopes.get(name)?.host ?? 0,
    tick: () => {},
    /** a round holds a scope peaceful (rounds.js) and lets go afterwards. The
        console cannot un-peace it meanwhile; `release` puts back what was set
        before the hold. Idempotent both ways */
    hold: (name) => {
      const s = scope(name);
      if (s.held) return;
      s.held = { was: s.peaceful };
      if (!s.peaceful) {
        s.peaceful = true;
        announce(name);
      }
    },
    release: (name) => {
      const s = scopes.get(name);
      if (!s?.held) return;
      const was = s.held.was;
      s.held = null;
      if (s.peaceful !== was) {
        s.peaceful = was;
        announce(name);
      }
    },
    isPeaceful: (name) => scopes.get(name)?.peaceful ?? false,
    handle: (ws, m) => {
      const w = ws.world;
      if (!w || typeof m.level !== 'string' || m.level !== w.level) return;
      const name = w.level;
      const s = scope(name);
      const host = s.host === w.id;
      switch (m.type) {
        case 'world-creatures': {
          if (!host || !allow(ws, 'snap', 14) || !Array.isArray(m.rows) || m.rows.length > MAX_ROWS) return;
          const rows = [];
          const ids = new Set();
          for (const r of m.rows) {
            const v = validRow(r);
            if (!v || ids.has(v[0])) return;
            ids.add(v[0]);
            rows.push(v);
          }
          s.table = new Map(rows.map((r) => [r[0], r]));
          toLevel(name, { type: 'world-creatures', level: name, rows }, ws);
          return;
        }
        case 'world-creature-die': {
          if (!host || !allow(ws, 'die', 30)) return;
          if (!int(m.id) || !int(m.kind) || m.kind < 0 || m.kind >= KIND_COUNT || !finite(m.x) || !finite(m.y) || !finite(m.z)) return;
          if (Math.abs(m.x) > COORD || Math.abs(m.y) > COORD || Math.abs(m.z) > COORD) return;
          s.table.delete(m.id);
          toLevel(name, {
            type: 'world-creature-die', level: name, id: m.id, kind: m.kind, x: m.x, y: m.y, z: m.z, by: m.by === 1 ? 1 : 0,
          }, ws);
          return;
        }
        case 'world-creature-hit': {
          if (host || !s.host || !allow(ws, 'hit', 24) || !scopeAllow(name, 'hit', 120)) return;
          if (!int(m.id) || !finite(m.amount) || !finite(m.kx) || !finite(m.kz) || m.amount <= 0) return;
          const row = rowOf(s, m.id);
          if (!row || row[1] === K_ARROW) return;
          const [cx, cy, cz] = rowPos(row);
          if (Math.hypot(cx - w.x, cy - w.y, cz - w.z) > HIT_REACH) return;
          const target = players.get(s.host);
          if (!target || target.world?.level !== name) return;
          send(target, {
            type: 'world-creature-hit', level: name, id: m.id, amount: clamp(m.amount, 0.1, HIT_MAX),
            kx: clamp(m.kx, -40, 40), kz: clamp(m.kz, -40, 40), from: w.id,
          });
          return;
        }
        case 'world-creature-attack': {
          if (!host || !health || !allow(ws, 'atk', 20) || !scopeAllow(name, 'atk', 30)) return;
          if (!int(m.id) || !int(m.victim) || !int(m.atk) || m.atk < 0 || m.atk > 2) return;
          const victim = players.get(m.victim);
          if (!victim?.world || victim.world.level !== name) return;
          const row = rowOf(s, m.id);
          if (!row) return;
          const kind = row[1];
          const atk = m.atk === 0 ? 'melee' : m.atk === 1 ? 'arrow' : 'blast';
          if ((atk === 'melee' && kind !== K_ZOMBIE) || (atk === 'arrow' && kind !== K_ARROW) || (atk === 'blast' && kind !== K_CREEPER)) return;
          const [cx, cy, cz] = rowPos(row);
          const v = victim.world;
          const d = Math.hypot(cx - v.x, cy - v.y, cz - v.z);
          if (d > REACH[atk]) return;
          // one arrow hurts once, one creeper goes off once, a zombie blows are spaced
          const key = `${atk}:${m.id}:${atk === 'melee' ? m.victim : 0}`;
          const last = s.seen.get(key);
          if (last !== undefined && now() - last < (atk === 'melee' ? MELEE_GAP_MS : 30_000)) return;
          remember(s, key);
          let amount = atk === 'melee' ? MELEE_HP : atk === 'arrow' ? ARROW_HP : BLAST_HP * clamp(1 - Math.hypot(cx - v.x, cz - v.z) / BLAST_RADIUS, 0, 1);
          if (amount < 0.5) return;
          amount = clamp(amount, 0, BLAST_HP);
          const taken = health.hurt(victim, amount, { by: 0, kind: 'mob' });
          if (taken > 0) {
            const dx = v.x - cx;
            const dz = v.z - cz;
            const len = Math.hypot(dx, dz) || 1;
            const push = clamp(atk === 'melee' ? 9 : atk === 'arrow' ? 6 : 4 + 16 * (amount / BLAST_HP), 0, KNOCK_MAX);
            send(victim, { type: 'world-creature-knock', level: name, vx: (dx / len) * push, vz: (dz / len) * push });
          }
          return;
        }
        case 'world-creature-spawn': {
          // `/spawnmob` from anyone: bounded (a kind that can be asked for, a
          // spot near the asker, a rate) and only ever placed by the host
          if (host || !s.host || !s.on) return;
          if (!int(m.kind) || m.kind < 0 || m.kind >= KIND_COUNT || m.kind === K_ARROW || !finite(m.x) || !finite(m.z)) return;
          if (Math.hypot(m.x - w.x, m.z - w.z) > SPAWN_REACH) return;
          if (!allow(ws, 'spawn', 3) || !scopeAllow(name, 'spawn', 10)) return;
          const target = players.get(s.host);
          if (!target || target.world?.level !== name) return;
          send(target, { type: 'world-creature-spawn', level: name, kind: m.kind, x: m.x, z: m.z, from: w.id });
          return;
        }
        case 'world-creature-cmd': {
          if (!(ws.isAdmin || host) || !allow(ws, 'cmd', 4)) {
            send(ws, { type: 'world-creature-no', reason: 'not-allowed' });
            return;
          }
          if (m.cmd === 'on' || m.cmd === 'off') s.on = m.cmd === 'on';
          else if (m.cmd === 'peaceful' || m.cmd === 'war') {
            // a round in play keeps the mobs peaceful; the console may not undo that
            if (s.held) {
              if (m.cmd === 'peaceful') s.held.was = true;
              else s.held.was = false;
            } else s.peaceful = m.cmd === 'peaceful';
          }
          else if (m.cmd !== 'clear') return;
          if (m.cmd === 'clear' || m.cmd === 'off') {
            s.table.clear();
            toLevel(name, { type: 'world-creatures', level: name, rows: [] });
          }
          announce(name);
          return;
        }
        default:
      }
    },
  };
}
