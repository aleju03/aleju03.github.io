/*
 * Rounds: the goal-shaped layer over the shared walk. A room (worldRooms.js)
 * has at most one round, and this file is its state machine:
 *
 *     lobby -> countdown -> playing -> results -> lobby
 *
 * Everything that makes a round *this* game and not that one lives in a mode
 * (roundModes.js: a small object in one table); this file owns only what all
 * of them share and what no client may be trusted with: who is in the round,
 * the clock, the teams, the scoreboard, the wire, and the settings a round
 * borrows from the rest of the server (the room's pvp flag and respawn delay
 * from health.js, a veto over who may hurt whom, the props a mode spawned).
 *
 * **Server authoritative.** Clients ask (`world-round-cmd`: pick a mode, ready,
 * start, and the few verbs a mode defines) and are told (`world-round`, one
 * compact state message to the whole room whenever anything a screen shows
 * has changed; `world-round-go` to change map; `world-round-tp` to put a body
 * somewhere; `world-round-ev` for a line of announcement). The state carries
 * time as "ms left" next to the server's `now`, so a client with a wrong
 * clock still counts down correctly.
 *
 * **A round is per room and per level.** `st.level` is the level the mode
 * runs on and every server module keys by `ws.world.level`, so a participant
 * is only *in* the round while they stand on that level. Walking off it (a
 * seam, the pause sheet's map ticket) is leaving the round. Everyone else in
 * the room, on that level or not, is a spectator: immune to damage, unable to
 * fire, and shown the round's HUD in the "watching" form.
 *
 * **Who plays.** Anyone in the room may press ready in the lobby; the host
 * (the longest-standing player of the room, so the creator of a private one)
 * picks the mode and may start when enough are ready, and it starts by itself
 * once everyone present is. Only the ready play (plus the host). A player
 * arriving during a round watches until the next, unless the mode says
 * `midJoin`. A `debug` flag (admin, or the host of a private room) lowers
 * every minimum to one so a mode can be tried alone.
 *
 * **Bounded.** One round per room; at most MAX_PARTS participants; a cmd rate
 * per socket; the state message is a handful of rows; anything a mode keeps
 * is dropped at the end of the round (`cleanup`). Nothing here is persisted.
 *
 * Testing: everything is injected (players, send, health, props, clock, rng),
 * so server/test/rounds.mjs drives it with fake sockets and a fake clock.
 */
import { MODES, modeList } from './roundModes.js';

export const COUNTDOWN_MS = 6000;
export const ARRIVE_MS = 30000;
export const RESULTS_MS = 12000;
export const MAX_PARTS = 16;
const TICK_MS = 200;
const PUSH_MS = 400;
const CMD_PER_S = 10;
const MODE_ID_RE = /^[a-z][a-z0-9_]{0,15}$/;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const r2 = (n) => Math.round(n * 100) / 100;

export function createRounds({
  players, send, health, props = null, claims = null, isPublic = () => false, now = Date.now, rand = Math.random,
  countdownMs = COUNTDOWN_MS, arriveMs = ARRIVE_MS, resultsMs = RESULTS_MS,
}) {
  const rates = new WeakMap();
  const st = {
    seq: 0,
    phase: 'lobby',
    mode: 'deathmatch',
    level: MODES.deathmatch.levels[0],
    opt: {},
    debug: false,
    ready: new Set(),
    parts: new Map(), // id -> participant row
    t0: 0,
    end: 0,
    waiting: false,
    cdMin: 0,
    hard: 0,
    resultsAt: 0,
    result: null,
    data: {}, // whatever the running mode keeps
    obj: {}, // and what it shows everybody (rides the state message)
    dg: new Map(), // id -> disguise kind
    lastPush: 0,
    lastTick: 0,
    dirty: false,
  };

  const list = () => [...players.values()].filter((w) => w.world);
  const byId = (id) => players.get(id) ?? null;
  const hostId = () => {
    let best = 0;
    for (const id of players.keys()) if (!best || id < best) best = id;
    return best;
  };
  const isHost = (ws) => !!ws.world && ws.world.id === hostId();
  const def = () => MODES[st.mode];
  const inRound = (ws) => !!ws.world && st.phase !== 'lobby' && st.parts.has(ws.world.id) && ws.world.level === st.level;
  const active = () => st.phase === 'countdown' || st.phase === 'playing';
  const minPlayers = () => (st.debug ? 1 : def().minPlayers);
  const elapsed = () => (st.phase === 'playing' ? now() - st.t0 : 0);

  /* ------------------------------------------------------------ wire */

  const toRoom = (m) => {
    for (const ws of players.values()) send(ws, m);
  };
  const toParts = (m) => {
    for (const id of st.parts.keys()) {
      const ws = byId(id);
      if (ws) send(ws, m);
    }
  };
  const tell = (code, args = {}, only = null) => {
    const m = { type: 'world-round-ev', code, ...args };
    if (only) {
      const ws = typeof only === 'object' ? only : byId(only);
      if (ws) send(ws, m);
    } else toRoom(m);
  };
  const tp = (id, x, z, yaw = 0) => {
    const ws = byId(id);
    if (ws) send(ws, { type: 'world-round-tp', level: st.level, x: r2(x), z: r2(z), yaw: r2(yaw) });
  };
  const no = (ws, cmd, reason, extra = {}) => send(ws, { type: 'world-round-no', cmd, reason, ...extra });

  const stateMsg = () => {
    const t = now();
    const m = {
      type: 'world-round',
      v: st.seq,
      ph: st.phase,
      mode: st.mode,
      lv: st.level,
      now: t,
      end: st.end,
      host: hostId(),
      rd: [...st.ready],
      p: [...st.parts.values()].map((p) => [p.id, p.team ?? '', p.role ?? '', p.score, p.a, p.b, p.out ? 1 : 0]),
      obj: st.obj,
    };
    if (st.debug) m.dbg = 1;
    if (st.waiting) m.w = 1;
    if (Object.keys(st.opt).length) m.opt = st.opt;
    if (st.dg.size) m.dg = [...st.dg];
    if (st.result) m.res = st.result;
    return m;
  };
  /** the whole state, to the room (or one socket) */
  const push = (only = null) => {
    st.seq++;
    st.lastPush = now();
    st.dirty = false;
    const m = stateMsg();
    if (only) send(only, m);
    else toRoom(m);
  };
  const dirty = () => {
    st.dirty = true;
  };

  /* --------------------------------------------------- the mode's kit */

  const partOf = (id) => st.parts.get(id) ?? null;
  const E = {
    st,
    get level() { return st.level; },
    now,
    rand,
    health,
    props,
    claims,
    tell,
    tp,
    dirty,
    push,
    byId,
    partOf,
    parts: () => [...st.parts.values()],
    elapsed,
    /** live participants' sockets on the round's level */
    sockets: () => [...st.parts.keys()].map(byId).filter((w) => w?.world && w.world.level === st.level),
    /** everyone in the room who is not playing */
    watchers: () => list().filter((w) => !st.parts.has(w.world.id)),
    score(id, n = 1) {
      const p = partOf(id);
      if (p) {
        p.score += n;
        dirty();
      }
    },
    shuffle(a) {
      const out = [...a];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    opt: (k, fallback) => (st.opt[k] === undefined ? fallback : st.opt[k]),
    finish: (why, result = null) => finish(why, result),
    disguise(id, kind) {
      if (kind) st.dg.set(id, kind);
      else st.dg.delete(id);
      toRoom({ type: 'world-round-dg', id, kind: kind || '' });
      dirty();
    },
  };

  /* ------------------------------------------------------- the cycle */

  function applyHealth() {
    const d = def();
    health.setPvp(st.level, !!d.pvp, { sticky: true, by: 0 });
    health.setRespawn(st.level, d.respawnMs ?? null);
  }
  function releaseHealth() {
    health.setPvp(st.level, false, { sticky: false, by: 0 });
    health.setRespawn(st.level, null);
    health.reset(st.level);
  }

  function start(ws) {
    const d = def();
    const ids = [];
    const host = hostId();
    for (const w of list()) {
      const id = w.world.id;
      if (st.ready.has(id) || id === host) ids.push(id);
    }
    const cap = Math.min(MAX_PARTS, d.maxPlayers ?? MAX_PARTS);
    // the host first, then by who has been here longest
    ids.sort((a, b) => (a === host ? -1 : b === host ? 1 : a - b));
    const chosen = ids.slice(0, cap);
    if (chosen.length < minPlayers()) {
      if (ws) no(ws, 'start', 'few', { need: minPlayers(), have: chosen.length });
      return false;
    }
    st.parts = new Map();
    for (const id of chosen) {
      st.parts.set(id, { id, team: null, role: null, score: 0, a: 0, b: 0, out: false, arrived: false });
    }
    st.data = {};
    st.obj = {};
    st.dg = new Map();
    st.result = null;
    st.opt = { ...st.opt };
    const fail = d.prepare?.(E);
    if (fail) {
      st.parts = new Map();
      if (ws) no(ws, 'start', String(fail));
      return false;
    }
    st.phase = 'countdown';
    st.cdMin = now() + countdownMs;
    st.hard = now() + arriveMs;
    st.end = st.cdMin;
    st.waiting = true;
    for (const p of st.parts.values()) p.arrived = byId(p.id)?.world?.level === st.level;
    // the ones not on the round's level are moved there by their own client
    for (const id of st.parts.keys()) {
      const w = byId(id);
      if (w && w.world.level !== st.level) send(w, { type: 'world-round-go', level: st.level, mode: st.mode });
      else if (w) send(w, { type: 'world-round-go', level: st.level, mode: st.mode, here: 1 });
    }
    tell('countdown', { mode: st.mode });
    push();
    return true;
  }

  function begin() {
    const d = def();
    st.phase = 'playing';
    st.waiting = false;
    st.t0 = now();
    st.end = st.t0 + d.duration * 1000;
    applyHealth();
    health.reset(st.level);
    d.start?.(E);
    tell('start', { mode: st.mode });
    push();
  }

  function finish(why, forced = null) {
    if (st.phase !== 'playing' && st.phase !== 'countdown') return;
    const d = def();
    let res = forced;
    if (!res && st.phase === 'playing') res = d.result?.(E, why) ?? null;
    if (!res) res = { win: [], team: '' };
    const rows = [...st.parts.values()]
      .map((p) => [p.id, p.team ?? '', p.score, p.a, p.b])
      .sort((x, y) => y[2] - x[2] || y[3] - x[3]);
    st.result = { win: res.win ?? [], team: res.team ?? '', why, rows, ...(res.note ? { note: res.note } : {}) };
    try {
      d.end?.(E);
    } catch (e) {
      console.error('round end', e);
    }
    st.phase = 'results';
    st.waiting = false;
    st.resultsAt = now() + resultsMs;
    st.end = st.resultsAt;
    releaseHealth();
    tell('results', { why });
    push();
  }

  /** back to the lobby: the mode's leftovers are removed and the room's
      settings put back, so free play is exactly what it was */
  function toLobby() {
    try {
      def().cleanup?.(E);
    } catch (e) {
      console.error('round cleanup', e);
    }
    if (active()) releaseHealth();
    st.phase = 'lobby';
    st.parts = new Map();
    st.ready = new Set();
    st.result = null;
    st.data = {};
    st.obj = {};
    st.dg = new Map();
    st.waiting = false;
    st.end = 0;
    push();
  }

  function abort(ws, reason = 'stopped') {
    if (st.phase === 'lobby') return;
    if (st.phase === 'playing') {
      finish(reason);
      // "stop" is the host cancelling, not a result worth a sheet
      toLobby();
    } else {
      toLobby();
    }
    tell('aborted', { by: ws?.world?.id ?? 0 });
  }

  /** take somebody out of the round: left the room, walked off the level */
  function drop(id, reason) {
    const p = partOf(id);
    if (!p) return;
    try {
      def().left?.(E, p, reason);
    } catch (e) {
      console.error('round left', e);
    }
    st.parts.delete(id);
    st.dg.delete(id);
    dirty();
    if (!active()) return;
    if (st.parts.size < minPlayers() || st.parts.size === 0) {
      if (st.phase === 'countdown') {
        toLobby();
        tell('aborted', { by: 0, why: 'few' });
      } else finish('abandoned');
    } else if (st.phase === 'playing') {
      def().check?.(E);
    }
  }

  /* ------------------------------------------------------- the ticker */

  function tick() {
    const t = now();
    if (t - st.lastTick < TICK_MS) return;
    const dt = Math.min(1, (t - (st.lastTick || t - TICK_MS)) / 1000);
    st.lastTick = t;
    if (st.phase === 'lobby') {
      // everyone present is ready: go
      const all = list();
      if (all.length && all.length >= minPlayers() && all.every((w) => st.ready.has(w.world.id))) start(null);
    } else if (st.phase === 'countdown') {
      for (const p of st.parts.values()) {
        const w = byId(p.id);
        const here = !!w && w.world.level === st.level;
        if (here && !p.arrived) dirty();
        p.arrived = here;
      }
      const all = [...st.parts.values()].every((p) => p.arrived);
      if (all && t >= st.cdMin) begin();
      else if (!all && t >= st.hard) {
        for (const p of [...st.parts.values()]) if (!p.arrived) drop(p.id, 'late');
        if (st.phase === 'countdown') {
          st.cdMin = Math.max(st.cdMin, t);
          if (st.parts.size >= minPlayers()) begin();
        }
      } else if (all && st.waiting) {
        st.waiting = false;
        st.end = st.cdMin;
        dirty();
      } else if (!all && !st.waiting) {
        st.waiting = true;
        dirty();
      }
    } else if (st.phase === 'playing') {
      applyHealth();
      def().tick?.(E, dt);
      if (st.phase === 'playing' && t >= st.end) finish('time');
    } else if (st.phase === 'results') {
      if (t >= st.resultsAt) toLobby();
    }
    if (st.dirty && t - st.lastPush >= PUSH_MS) push();
  }

  /* ------------------------------------------------ hooks for index.js */

  const api = {
    tick,
    state: () => ({ phase: st.phase, mode: st.mode, level: st.level, parts: [...st.parts.keys()] }),
    /** the joiner is told the state at once */
    snapshot(ws) {
      push(ws);
    },
    /** they left the room */
    left(ws, id) {
      st.ready.delete(id);
      if (st.parts.has(id)) drop(id, 'left');
      // the host may have changed hands
      dirty();
      if (players.size === 0) {
        // an emptied room forgets its round entirely (the public room lives on)
        if (st.phase !== 'lobby') {
          try { def().cleanup?.(E); } catch (e) { console.error('round cleanup', e); }
          releaseHealth();
        }
        st.phase = 'lobby';
        st.parts = new Map();
        st.ready = new Set();
        st.dg = new Map();
        st.data = {};
        st.obj = {};
        st.result = null;
        st.debug = false;
        st.opt = {};
        st.mode = 'deathmatch';
        st.level = MODES.deathmatch.levels[0];
      }
    },
    /** they walked into another level */
    moved(ws, from) {
      const id = ws.world.id;
      if (st.parts.has(id) && active() && ws.world.level !== st.level && from === st.level) drop(id, 'level');
      dirty();
    },
    /** every pose report: the mode may gate movement or read the position */
    pose(ws) {
      if (st.phase !== 'playing' && st.phase !== 'countdown') return;
      if (!inRound(ws)) return;
      def().pose?.(E, partOf(ws.world.id), ws);
    },
    /** weapons.js asks before letting a shot out */
    mayShoot(ws, w) {
      if (!active()) return true;
      const id = ws.world.id;
      if (ws.world.level !== st.level) return true;
      const p = partOf(id);
      if (!p) return false; // a spectator holds no gun
      if (st.phase === 'countdown' || p.out) return false;
      return def().mayShoot ? def().mayShoot(E, p, w) : true;
    },
    /** a validated hit on a player; true when the mode took it for itself */
    playerHit(shooter, victim, w, at) {
      if (st.phase !== 'playing' || !inRound(shooter) || !inRound(victim)) return false;
      const d = def();
      return d.playerHit ? !!d.playerHit(E, partOf(shooter.world.id), partOf(victim.world.id), w, at, shooter, victim) : false;
    },
    /** a validated hit on a shared prop */
    propHit(shooter, propId, w) {
      if (st.phase !== 'playing' || !inRound(shooter)) return;
      def().propHit?.(E, partOf(shooter.world.id), propId, w, shooter);
    },
    /** health.js veto: may this damage land */
    guard(victim, source) {
      if (!active() && st.phase !== 'results') return true;
      if (victim.world.level !== st.level) return true;
      const id = victim.world.id;
      // the sheet between rounds hurts nobody
      if (st.phase === 'results' || st.phase === 'countdown') return false;
      const p = partOf(id);
      if (!p) return false;
      const d = def();
      return d.guard ? !!d.guard(E, p, source, victim) : true;
    },
    /** health.js onDeath */
    died({ victim, killer, kind, scope }) {
      if (st.phase !== 'playing' || scope !== st.level) return;
      const p = partOf(victim.world.id);
      if (!p) return;
      def().died?.(E, p, killer ? partOf(killer.world.id) : null, kind, victim, killer);
      dirty();
    },
    /** the round's ruling on a hit-point kill of a spectator or a stray */
    handle(ws, m, strike) {
      const w = ws.world;
      if (!w) return;
      if (m.type !== 'world-round-cmd' || typeof m.cmd !== 'string' || m.cmd.length > 12) return strike(ws);
      let r = rates.get(ws);
      const t = now();
      if (!r || t - r.at >= 1000) rates.set(ws, (r = { at: t, n: 0 }));
      if (++r.n > CMD_PER_S) return;
      const id = w.id;
      switch (m.cmd) {
        case 'mode': {
          if (typeof m.mode !== 'string' || !MODE_ID_RE.test(m.mode)) return strike(ws);
          if (!MODES[m.mode]) return no(ws, 'mode', 'unknown');
          if (st.phase !== 'lobby') return no(ws, 'mode', 'busy');
          if (!isHost(ws)) return no(ws, 'mode', 'host');
          const d = MODES[m.mode];
          const level = typeof m.level === 'string' && d.levels.includes(m.level) ? m.level : d.levels[0];
          if (st.mode === m.mode && st.level === level) return;
          st.mode = m.mode;
          st.level = level;
          st.opt = {};
          for (const [k, v] of Object.entries(d.options ?? {})) st.opt[k] = v;
          push();
          return;
        }
        case 'opt': {
          if (st.phase !== 'lobby') return no(ws, 'opt', 'busy');
          if (!isHost(ws)) return no(ws, 'opt', 'host');
          const spec = def().options ?? {};
          if (typeof m.key !== 'string' || !(m.key in spec) || typeof m.value !== typeof spec[m.key]) return strike(ws);
          st.opt[m.key] = m.value;
          push();
          return;
        }
        case 'ready': {
          if (typeof m.on !== 'boolean') return strike(ws);
          if (st.phase !== 'lobby') return no(ws, 'ready', 'busy');
          if (m.on) st.ready.add(id);
          else st.ready.delete(id);
          dirty();
          push();
          return;
        }
        case 'start': {
          if (st.phase !== 'lobby') return no(ws, 'start', 'busy');
          if (!isHost(ws)) return no(ws, 'start', 'host');
          start(ws);
          return;
        }
        case 'stop': {
          if (!isHost(ws) && !ws.isAdmin) return no(ws, 'stop', 'host');
          abort(ws);
          return;
        }
        case 'debug': {
          if (typeof m.on !== 'boolean') return strike(ws);
          // solo testing is for the admin, or whoever made a private room
          if (!ws.isAdmin && !(isHost(ws) && !isPublic())) return no(ws, 'debug', 'admin');
          if (st.phase !== 'lobby') return no(ws, 'debug', 'busy');
          st.debug = m.on;
          push();
          return;
        }
        case 'join': {
          const d = def();
          if (st.phase !== 'playing' || !d.midJoin || st.parts.has(id)) return no(ws, 'join', 'closed');
          if (st.parts.size >= Math.min(MAX_PARTS, d.maxPlayers ?? MAX_PARTS)) return no(ws, 'join', 'full');
          const p = { id, team: null, role: null, score: 0, a: 0, b: 0, out: false, arrived: w.level === st.level };
          st.parts.set(id, p);
          d.joined?.(E, p);
          send(ws, { type: 'world-round-go', level: st.level, mode: st.mode, here: w.level === st.level ? 1 : 0 });
          push();
          return;
        }
        default: {
          if (!MODE_ID_RE.test(m.cmd)) return strike(ws);
          if (st.phase !== 'playing' || !inRound(ws)) return;
          def().cmd?.(E, partOf(id), m, ws);
          return;
        }
      }
    },
  };
  return api;
}

export { modeList };
