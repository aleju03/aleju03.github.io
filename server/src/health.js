/*
 * Health, damage, death and respawn: the foundation every competitive mode,
 * lava tile and creature stands on. Like the weapons' relay this process
 * simulates nothing physical; what it owns is the one thing two clients can
 * never settle between themselves, which is who has how many hit points.
 *
 * **One entry point.** Everything that hurts a player ends in `damage(ws,
 * amount, {by, kind})`: a validated pistol or crossbow hit (weapons.js calls
 * `hit`), a blast derived from the explosion relay's own validated position
 * and radius (props.js calls `blast`; a client never says how much a blast
 * hurt), a fall the client reports and this file checks against the height
 * it has watched the player drop from, the console's `/hurt` and `/kill`, and
 * whatever other server modules call later (`hurt`: lava, creatures, fire,
 * Cubeland's survival). The rules live in that one function: a dead or
 * spawn-protected or god-mode player takes nothing, damage from another
 * player only lands where the scope's `pvp` flag is on, and reaching zero is
 * a death with a killer to credit.
 *
 * **Scope is `ws.world.level`**, like every module here. Each scope has a pvp
 * flag (off by default: free play knocks players around with weapons exactly
 * as it always did, and hurts nobody) and a scoreboard of kills, deaths and
 * score per player, readable by other modules through `stats(scope)`. A scope
 * that empties is forgotten, unless a mode pinned it with `setPvp(..., {sticky})`.
 *
 * **Time.** Regeneration (after a few quiet seconds), respawn timers and the
 * flush of changed hit points all ride `tick()`, called from the world's own
 * ticker, so a burst of pellets is one `world-hp` row per player per tick
 * rather than one per pellet. A respawn is announced, not placed: the server
 * does not know where a level's spawn is (the client does, from the level),
 * so `world-respawn` only says *when*, plus an x/z when a mode's
 * `onRespawn` hook chose the spot.
 *
 * **What a client may claim** is small: a landing speed (clamped to what the
 * height it fell from allows), a console command for itself (`kill`, `hurt`,
 * `heal`, `god`, `pvp`), never an amount against anyone else. Cheats that
 * would ruin a fight (`heal`, `god`) are refused while pvp is on, unless the
 * caller is the admin. Refusals are silent or a `world-health-no`; garbage
 * is a strike.
 */
export const MAX_HP = 100;
// seconds without damage before hit points start coming back, and how fast
const REGEN_DELAY_MS = 5000;
const REGEN_PER_S = 8;
const RESPAWN_MS = 3000;
const PROTECT_MS = 2000;
// per hit
const PISTOL_HP = 12;
const CROSSBOW_HP = 45;
const HEAD_K = 1.5;
// a struck player's head is this far over their feet (the body is 4.4 tall)
const HEAD_MIN = 3.4;
const BLAST_HP = 90;
// a blast reaches this far at most for damage, whatever radius it asked
const BLAST_REACH = 24;
const BLAST_SELF_K = 0.5;
// falls: the client's landing speed (units/s, gravity 34). Below FALL_SAFE
// it is a landing; a fifteen-unit drop is 32
const FALL_SAFE = 32;
const FALL_HP_PER = 3;
const GRAVITY = 34;
const FALL_SLACK = 1.15;
// how long the highest pose stays the one a fall is measured from
const PEAK_MS = 20000;
// a fall is weighed at the first pose after the claim; this is only for a
// player who never reports another one
const FALL_WEIGH_MS = 1500;
const HIT_MAX = 1000;
const STAT_CAP = 64;
const KIND_RE = /^[a-z][a-z0-9_]{0,15}$/;
const WEAPON_KINDS = ['pistol', 'crossbow', 'rocket'];
const CREDIT_MS = 8000;
const CREDIT_CAP = 12;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function createHealth({ players, send, now = Date.now }) {
  const scopes = new Map(); // level -> { pvp, sticky, stats: Map(id -> {k, d, s}) }
  const rates = new WeakMap();
  const deathFns = new Set();
  const respawnFns = new Set();
  // a mode's veto over who may hurt whom (rounds.js): fn(victim, {by, kind}) -> boolean
  let guard = null;
  let lastTick = now();

  const scope = (name) => {
    let s = scopes.get(name);
    if (!s) scopes.set(name, (s = { pvp: false, sticky: false, stats: new Map() }));
    return s;
  };
  const peers = (name) => [...players.values()].filter((p) => p.world?.level === name);
  const toLevel = (name, m, except) => {
    for (const p of peers(name)) if (p !== except) send(p, m);
  };
  const allow = (ws, kind, cap) => {
    let r = rates.get(ws);
    if (!r) rates.set(ws, (r = {}));
    const at = now();
    if (!r[kind] || at - r[kind].at >= 1000) r[kind] = { at, n: 0 };
    return ++r[kind].n <= cap;
  };
  /** the health record hangs off the world record, so it dies with a session */
  const rec = (ws) => {
    const w = ws.world;
    if (!w.health) {
      w.health = {
        hp: MAX_HP, dead: false, respawnAt: 0, protUntil: 0, lastHurt: 0, god: false,
        sent: MAX_HP, sentFlags: 0, peakY: w.y, peakAt: now(), credits: [[], [], []],
      };
    }
    return w.health;
  };
  const statRow = (name, id) => {
    const s = scope(name);
    let r = s.stats.get(id);
    if (!r) {
      if (s.stats.size >= STAT_CAP) return { k: 0, d: 0, s: 0 };
      s.stats.set(id, (r = { k: 0, d: 0, s: 0 }));
    }
    return r;
  };
  const scoreRow = (name, id) => {
    const r = statRow(name, id);
    return [id, r.k, r.d, r.s];
  };

  /* ---- the wire ---- */
  const dirty = new Set(); // ws whose row must go out on the next tick
  const flagsOf = (h) => (h.dead ? 1 : 0) | (now() < h.protUntil ? 2 : 0);
  const rowOf = (ws) => {
    const h = rec(ws);
    return [ws.world.id, Math.round(h.hp), MAX_HP, flagsOf(h)];
  };
  const flush = () => {
    if (!dirty.size) return;
    const byLevel = new Map();
    for (const ws of dirty) {
      if (!ws.world) continue;
      const h = rec(ws);
      const hp = Math.round(h.hp);
      const flags = flagsOf(h);
      if (hp === h.sent && flags === h.sentFlags) continue;
      h.sent = hp;
      h.sentFlags = flags;
      const list = byLevel.get(ws.world.level) ?? [];
      list.push([ws.world.id, hp, MAX_HP, flags]);
      byLevel.set(ws.world.level, list);
    }
    dirty.clear();
    for (const [level, rows] of byLevel) toLevel(level, { type: 'world-hp', level, rows });
  };

  /* ---- the rules ---- */
  const isGod = (ws) => rec(ws).god;
  const alive = (ws) => !!ws.world && !rec(ws).dead;

  function die(ws, source) {
    const h = rec(ws);
    const w = ws.world;
    const level = w.level;
    h.hp = 0;
    h.dead = true;
    // a mode may name its own delay, or none at all (Infinity: down for the round)
    const wait = scope(level).respawnMs;
    h.respawnAt = wait === undefined ? now() + RESPAWN_MS : now() + wait;
    dirty.add(ws);
    const killer = source.by && source.by !== w.id ? players.get(source.by) : null;
    const k = killer?.world?.level === level ? killer : null;
    const vs = statRow(level, w.id);
    vs.d += 1;
    if (k) {
      const ks = statRow(level, k.world.id);
      ks.k += 1;
      ks.s += 1;
    } else if (source.kind === 'kill' || source.kind === 'hurt') {
      // a suicide costs a point, so the console is not a way to farm nothing
      vs.s -= 1;
    }
    const rows = [scoreRow(level, w.id)];
    if (k) rows.push(scoreRow(level, k.world.id));
    toLevel(level, { type: 'world-death', level, id: w.id, by: k ? k.world.id : 0, kind: source.kind, sc: rows });
    for (const fn of deathFns) {
      try {
        fn({ victim: ws, killer: k, kind: source.kind, scope: level });
      } catch (e) {
        console.error('health onDeath', e);
      }
    }
  }

  /**
   * The one entry point. Returns the hit points actually taken off.
   * `source.by` is a player id (0 for the environment), `source.kind` a short
   * lowercase tag the killfeed prints ('pistol', 'lava', 'fall', ...).
   */
  function damage(ws, amount, source = {}) {
    if (!ws?.world || !finite(amount) || amount <= 0) return 0;
    const h = rec(ws);
    const by = Number.isInteger(source.by) && source.by > 0 ? source.by : 0;
    const kind = typeof source.kind === 'string' && KIND_RE.test(source.kind) ? source.kind : 'env';
    if (h.dead) return 0;
    const forced = kind === 'kill';
    if (!forced) {
      if (h.god || now() < h.protUntil) return 0;
      if (guard && !guard(ws, { by, kind })) return 0;
      // the environment and yourself always hurt; another player only in pvp
      if (by && by !== ws.world.id && !scope(ws.world.level).pvp) return 0;
    }
    const taken = Math.min(h.hp, clamp(amount, 0, HIT_MAX));
    h.hp -= taken;
    h.lastHurt = now();
    dirty.add(ws);
    if (h.hp <= 0.0001) die(ws, { by, kind });
    return taken;
  }

  /** believe a landing only as far as the drop we saw: the peak height in the
      last twenty seconds, minus where the pose that followed the claim is */
  function weighFall(ws, h) {
    const claimed = h.fall.speed;
    h.fall = null;
    const drop = Math.max(0, h.peakY - ws.world.y) + 3;
    const cap = Math.sqrt(2 * GRAVITY * drop) * FALL_SLACK + 3;
    const speed = Math.min(claimed, cap, 200);
    if (speed > FALL_SAFE && !h.dead) damage(ws, (speed - FALL_SAFE) * FALL_HP_PER, { by: 0, kind: 'fall' });
  }

  function respawn(ws) {
    const h = rec(ws);
    h.hp = MAX_HP;
    h.dead = false;
    h.protUntil = now() + PROTECT_MS;
    h.lastHurt = now();
    h.peakY = ws.world.y;
    h.peakAt = now();
    dirty.add(ws);
    const m = { type: 'world-respawn', level: ws.world.level, id: ws.world.id };
    for (const fn of respawnFns) {
      try {
        const spot = fn(ws);
        if (spot && finite(spot.x) && finite(spot.z)) {
          m.x = Math.round(spot.x * 100) / 100;
          m.z = Math.round(spot.z * 100) / 100;
        }
      } catch (e) {
        console.error('health onRespawn', e);
      }
    }
    toLevel(ws.world.level, m);
  }

  const setPvp = (name, on, opts = {}) => {
    const s = scope(name);
    on = !!on;
    if (opts.sticky !== undefined) s.sticky = !!opts.sticky;
    if (s.pvp === on) return;
    s.pvp = on;
    if (on) {
      // the cheats that ruin a fight end with the fight beginning
      for (const p of peers(name)) {
        const h = rec(p);
        if (h.god && !p.isAdmin) {
          h.god = false;
          send(p, { type: 'world-health-no', cmd: 'god', reason: 'pvp' });
        }
      }
    }
    toLevel(name, { type: 'world-pvp', level: name, on, by: opts.by ?? 0 });
    if (!s.pvp && !s.sticky && !peers(name).length) scopes.delete(name);
  };

  /* ---- what other modules call ---- */
  const api = {
    /** hurt a player: lava, creatures, fire, a mode's own rules */
    hurt: (ws, amount, source) => damage(ws, amount, source),
    damage,
    /** hit points back, up to the maximum (a pickup, a medic) */
    heal(ws, amount) {
      if (!alive(ws) || !finite(amount) || amount <= 0) return 0;
      const h = rec(ws);
      const got = Math.min(MAX_HP - h.hp, amount);
      h.hp += got;
      dirty.add(ws);
      return got;
    },
    /** die outright, credited to `by` */
    kill: (ws, source = {}) => damage(ws, HIT_MAX, { ...source, kind: 'kill' }),
    setPvp,
    isPvp: (name) => scopes.get(name)?.pvp ?? false,
    /** [{id, kills, deaths, score, hp, dead}] for everyone standing in the scope */
    stats(name) {
      return peers(name).map((p) => {
        const r = statRow(name, p.world.id);
        const h = rec(p);
        return { id: p.world.id, kills: r.k, deaths: r.d, score: r.s, hp: Math.round(h.hp), dead: h.dead };
      });
    },
    hpOf: (ws) => (ws.world ? Math.round(rec(ws).hp) : 0),
    isDead: (ws) => !!ws.world && rec(ws).dead,
    /** fn({victim, killer, kind, scope}), called after the death is announced */
    onDeath(fn) {
      deathFns.add(fn);
      return () => deathFns.delete(fn);
    },
    /** fn(ws) may return {x, z} to put a respawn somewhere a mode chose */
    onRespawn(fn) {
      respawnFns.add(fn);
      return () => respawnFns.delete(fn);
    },
    /** a mode's veto: fn(victim, {by, kind}) returns false to refuse the damage.
        A forced `kill` skips it, as it skips god and protection */
    setGuard(fn) {
      guard = typeof fn === 'function' ? fn : null;
    },
    /** how long the dead of a scope stay down: ms, Infinity for the round, or
        null for the default (3 s) */
    setRespawn(name, ms) {
      scope(name).respawnMs = ms === null || ms === undefined ? undefined : ms;
    },
    /** bring one player back now (a round resets its dead) */
    revive(ws) {
      if (ws.world && rec(ws).dead) respawn(ws);
    },
    /** new round: counters to zero, everyone alive and whole */
    reset(name) {
      const s = scope(name);
      s.stats.clear();
      for (const p of peers(name)) {
        const h = rec(p);
        h.hp = MAX_HP;
        h.protUntil = now() + PROTECT_MS;
        if (h.dead) respawn(p);
        else dirty.add(p);
      }
      toLevel(name, { type: 'world-scores', level: name, rows: [] });
    },

    /* ---- called by index.js ---- */
    /** a player entered a level: tell them who is hurt and whether pvp is on */
    snapshot(ws) {
      const level = ws.world.level;
      rec(ws);
      const rows = [];
      for (const p of peers(level)) {
        if (p === ws) continue;
        const h = rec(p);
        if (h.hp < MAX_HP || h.dead) rows.push(rowOf(p));
      }
      if (rows.length) send(ws, { type: 'world-hp', level, rows });
      const s = scopes.get(level);
      if (s?.pvp) send(ws, { type: 'world-pvp', level, on: true, by: 0 });
      if (s && s.stats.size) {
        const sc = [...s.stats].map(([id, r]) => [id, r.k, r.d, r.s]);
        send(ws, { type: 'world-scores', level, rows: sc });
      }
    },
    /** they left the world (the record is already gone: id and level) */
    left(id, level) {
      const s = scopes.get(level);
      if (!s) return;
      s.stats.delete(id);
      if (!peers(level).length && !s.sticky) scopes.delete(level);
    },
    /** they walked into another level: a dead body respawns at once */
    moved(ws, from) {
      const id = ws.world.id;
      scopes.get(from)?.stats.delete(id);
      const h = rec(ws);
      if (h.dead) respawn(ws);
      dirty.add(ws);
      if (from !== ws.world.level && scopes.get(from) && !peers(from).length && !scopes.get(from).sticky) scopes.delete(from);
    },
    /** every pose report: what height they fell from, for the sanity check */
    pose(ws) {
      const h = rec(ws);
      const t = now();
      if (h.fall) weighFall(ws, h);
      if (ws.world.y >= h.peakY || t - h.peakAt > PEAK_MS) {
        h.peakY = ws.world.y;
        h.peakAt = t;
      }
    },
    /** a valid shot left this weapon: it earns one hit's worth of credit */
    shot(ws, wIndex) {
      const h = rec(ws);
      h.protUntil = Math.min(h.protUntil, now()); // firing ends spawn protection
      const q = h.credits[wIndex];
      if (!q) return;
      const t = now();
      while (q.length && t - q[0] > CREDIT_MS) q.shift();
      if (q.length < CREDIT_CAP) q.push(t);
    },
    /** a validated hit on a player: pistol and crossbow damage, only in pvp */
    hit(shooter, victim, wIndex, at) {
      if (!shooter.world || !victim.world || wIndex > 1) return 0;
      // the credit is spent whether or not pvp is on, so shots fired in free
      // play cannot be banked for a fight
      const q = rec(shooter).credits[wIndex];
      const t = now();
      while (q.length && t - q[0] > CREDIT_MS) q.shift();
      if (!q.length) return 0;
      q.shift();
      if (!scope(shooter.world.level).pvp || !alive(shooter)) return 0;
      let hp = wIndex === 0 ? PISTOL_HP : CROSSBOW_HP;
      if (finite(at?.[1]) && at[1] - victim.world.y > HEAD_MIN) hp *= HEAD_K;
      return damage(victim, hp, { by: shooter.world.id, kind: WEAPON_KINDS[wIndex] });
    },
    /**
     * An explosion the relay already validated (position within reach of the
     * caller, radius and power clamped). Others take damage in pvp only, and
     * only from a blast that came out of a rocket the caller really fired or
     * a prop that really blew up (`fromProp`); the console's free `explode`
     * throws things but hurts nobody. Damage falls off linearly to the edge.
     */
    blast(ws, { at, power, radius, fromProp }) {
      const w = ws.world;
      if (!w || !allow(ws, 'blast', 4)) return;
      const h = rec(ws);
      const t = now();
      const q = h.credits[2];
      while (q.length && t - q[0] > CREDIT_MS) q.shift();
      let armed = !!fromProp;
      if (!armed && q.length) {
        q.shift();
        armed = true;
      }
      const reach = Math.min(BLAST_REACH, radius);
      const top = BLAST_HP * clamp(Math.sqrt(power), 0.3, 1.2);
      const pvp = scope(w.level).pvp;
      for (const p of peers(w.level)) {
        const v = p.world;
        if (!alive(p)) continue;
        const own = p === ws;
        if (!own && !(pvp && armed)) continue;
        if (own && !pvp) continue;
        // the middle of the body, not the soles
        const d = Math.hypot(v.x - at[0], v.y + 2.2 - at[1], v.z - at[2]);
        if (d >= reach) continue;
        const dmg = top * (1 - d / reach) * (own ? BLAST_SELF_K : 1);
        if (dmg >= 1) damage(p, dmg, { by: w.id, kind: 'blast' });
      }
    },

    tick() {
      const t = now();
      const dt = Math.min(0.5, (t - lastTick) / 1000);
      lastTick = t;
      for (const ws of players.values()) {
        if (!ws.world) continue;
        const h = rec(ws);
        if (h.fall && t - h.fall.at >= FALL_WEIGH_MS) weighFall(ws, h);
        if (h.dead) {
          if (t >= h.respawnAt) respawn(ws);
        } else if (h.hp < MAX_HP && t - h.lastHurt >= REGEN_DELAY_MS) {
          h.hp = Math.min(MAX_HP, h.hp + REGEN_PER_S * dt);
          dirty.add(ws);
        } else if (h.protUntil && t >= h.protUntil) {
          h.protUntil = 0;
          dirty.add(ws); // the protected flag drops off the wire
        }
      }
      flush();
    },

    handle(ws, m, strike) {
      const w = ws.world;
      if (!w) return;
      const h = rec(ws);
      if (m.type === 'world-fall') {
        if (!finite(m.speed) || m.speed < 0) return strike(ws);
        if (!allow(ws, 'fall', 2) || h.dead) return;
        // (weighed a moment later, in tick: the client reports the landing
        // before the pose that shows it, and the drop is measured to that)
        if (w.f & 64) return;
        h.fall = { speed: m.speed, at: now() };
        return;
      }
      if (m.type !== 'world-health-cmd') return;
      if (typeof m.cmd !== 'string') return strike(ws);
      if (!allow(ws, 'cmd', 6)) return;
      const s = scope(w.level);
      const cheat = () => {
        if (s.pvp && !ws.isAdmin) {
          send(ws, { type: 'world-health-no', cmd: m.cmd, reason: 'pvp' });
          return false;
        }
        return true;
      };
      switch (m.cmd) {
        case 'kill':
          if (!h.dead) api.kill(ws, { by: 0 });
          return;
        case 'hurt': {
          if (!finite(m.n)) return strike(ws);
          damage(ws, clamp(m.n, 1, 500), { by: 0, kind: 'hurt' });
          return;
        }
        case 'heal':
          if (cheat()) api.heal(ws, MAX_HP);
          return;
        case 'god':
          if (typeof m.on !== 'boolean') return strike(ws);
          if (m.on && !cheat()) return;
          h.god = m.on;
          return;
        case 'pvp':
          if (typeof m.on !== 'boolean') return strike(ws);
          setPvp(w.level, m.on, { by: w.id });
          return;
        default:
          strike(ws);
      }
    },
  };
  return api;
}
