/*
 * The weapons' relay (src/game/sandbox/tools/weapons.ts). Like everything
 * else in the shared walk this process simulates nothing: a shot is a ray
 * the shooter's own client resolves, and all that is checked here is that
 * it is an honest one. The origin has to be near where the shooter last
 * said they were, the direction a unit vector, the rate what a trigger
 * finger can do, and a hit within the weapon's reach of the shooter.
 * A hit on a player carries the velocity that player's own client applies
 * to itself (as a bump's `world-shove` does), clamped to the same ceiling,
 * and it is dropped for a victim who is seated or flying; the hit itself
 * still goes out, because everybody else draws where it landed.
 *
 * `world-wield` is who is holding which weapon, so a body is drawn with the
 * right gun in its hands. It is kept on the socket's world record so a late
 * arrival (or somebody walking in from another level) is told in one
 * `world-wields` (sent only when somebody is holding one), and it is announced to a level when its holder walks in.
 *
 * Refusals are silent: shots are a stream, and a dropped one is a tracer
 * nobody sees. Garbage (a non-number, a malformed array) is a strike.
 */
const WEAPONS = 3; // pistol, crossbow, rocket: WIRE_WEAPONS in weaponProtocol.ts
// shots a second each weapon may fire: a held pistol is about seven
const SHOTS_PER_S = [10, 3, 3];
const HITS_PER_S = 14;
const WIELDS_PER_S = 6;
// how far the ray's origin (the eye) may be from the last reported feet
const ORIGIN_REACH = 16;
// how far from the shooter a hit may land, per weapon (a bolt drops, a
// rocket flies seven seconds)
const HIT_REACH = [320, 480, 460];
// a struck player must be this close to where the hit landed
const VICTIM_REACH = 14;
// mirrors WORLD_SHOVE_MAX in index.js and SHOVE_MAX in shove.ts
const SHOVE_MAX = 24;
// the biggest push a shot may ask a prop's authority for (kg u/s)
const IMPULSE_MAX = 2000;
const FRAME_LIMIT = 64;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const vec3 = (a, limit) =>
  Array.isArray(a) && a.length === 3 && a.every(finite) && a.every((v) => Math.abs(v) <= limit) ? a : null;

export function createWeapons({ players, send, seated, flying, now = Date.now }) {
  const rates = new WeakMap();
  const allow = (ws, kind, cap) => {
    let r = rates.get(ws);
    if (!r) rates.set(ws, (r = {}));
    const at = now();
    if (!r[kind] || at - r[kind].at >= 1000) r[kind] = { at, n: 0 };
    return ++r[kind].n <= cap;
  };
  const toLevel = (level, msg, except) => {
    for (const peer of players.values()) {
      if (peer !== except && peer.world?.level === level) send(peer, msg);
    }
  };
  const snapshot = (ws) => {
    const level = ws.world.level;
    const wields = [];
    for (const peer of players.values()) {
      const w = peer.world;
      if (peer !== ws && w?.level === level && Number.isInteger(w.wield) && w.wield >= 0) wields.push([w.id, w.wield]);
    }
    // nobody holding anything is the client's default: say nothing
    if (wields.length) send(ws, { type: 'world-wields', level, wields });
  };
  return {
    snapshot,
    /** a player walked from `from` into their current level */
    moved: (ws, from) => {
      const w = ws.world;
      if (!Number.isInteger(w.wield) || w.wield < 0) return;
      toLevel(from, { type: 'world-wield', level: from, id: w.id, w: -1 }, ws);
      toLevel(w.level, { type: 'world-wield', level: w.level, id: w.id, w: w.wield }, ws);
    },
    handle: (ws, m, strike) => {
      const w = ws.world;
      if (!w) return;
      if (m.type === 'world-wield') {
        if (!Number.isInteger(m.w) || m.w < -1 || m.w >= WEAPONS) return strike(ws);
        if (!allow(ws, 'wield', WIELDS_PER_S) || w.wield === m.w) return;
        w.wield = m.w;
        toLevel(w.level, { type: 'world-wield', level: w.level, id: w.id, w: m.w }, ws);
        return;
      }
      if (!Number.isInteger(m.w) || m.w < 0 || m.w >= WEAPONS || !Number.isSafeInteger(m.seq)) return strike(ws);
      if (m.level !== w.level) return;
      if (m.type === 'world-shot') {
        const o = vec3(m.o, 1e7);
        const d = vec3(m.d, 2);
        if (!o || !d) return strike(ws);
        if (!allow(ws, `shot${m.w}`, SHOTS_PER_S[m.w])) return;
        const len = Math.hypot(d[0], d[1], d[2]);
        if (len < 0.5 || len > 2) return;
        if (Math.hypot(o[0] - w.x, o[2] - w.z) > ORIGIN_REACH || Math.abs(o[1] - w.y) > ORIGIN_REACH) return;
        if (seated(w.id)) return;
        const out = {
          type: 'world-shot', level: w.level, id: w.id, w: m.w, seq: m.seq,
          o: o.map(r2), d: d.map((v) => r4(v / len)),
        };
        if (m.w === 0) {
          if (!finite(m.len)) return strike(ws);
          out.len = r2(Math.max(0, Math.min(HIT_REACH[0], m.len)));
        }
        // a new weapon in somebody's hands is news even without a wield
        if (w.wield !== m.w) w.wield = m.w;
        toLevel(w.level, out, ws);
        return;
      }
      if (m.type !== 'world-shot-hit') return;
      const at = vec3(m.at, 1e7);
      if (!at) return strike(ws);
      if (!allow(ws, 'hit', HITS_PER_S)) return;
      if (Math.hypot(at[0] - w.x, at[1] - w.y, at[2] - w.z) > HIT_REACH[m.w]) return;
      const out = { type: 'world-shot-hit', level: w.level, id: w.id, w: m.w, seq: m.seq, at: at.map(r2) };
      if (m.d !== undefined) {
        const d = vec3(m.d, 1e4);
        if (!d) return strike(ws);
        out.d = d.map(r2);
      }
      if (m.prop !== undefined) {
        if (!Number.isSafeInteger(m.prop)) return strike(ws);
        out.prop = m.prop;
        if (m.fr !== undefined) {
          if (!Array.isArray(m.fr) || m.fr.length !== 7 || !m.fr.every(finite) || m.fr.some((v) => Math.abs(v) > FRAME_LIMIT)) return strike(ws);
          out.fr = m.fr.map((v, i) => (i < 3 ? r2(v) : r4(v)));
        }
        if (m.imp !== undefined) {
          const imp = vec3(m.imp, 1e6);
          if (!imp) return strike(ws);
          const k = Math.hypot(imp[0], imp[1], imp[2]);
          out.imp = imp.map((v) => r2(k > IMPULSE_MAX ? (v * IMPULSE_MAX) / k : v));
        }
      }
      if (m.player !== undefined) {
        if (!Number.isInteger(m.player)) return strike(ws);
        const victim = players.get(m.player);
        const v = victim?.world;
        if (!v || victim === ws || v.level !== w.level) return;
        if (Math.hypot(v.x - at[0], v.z - at[2]) > VICTIM_REACH || Math.abs(v.y - at[1]) > VICTIM_REACH) return;
        out.player = m.player;
        const vel = vec3(m.v, 1e4);
        if (!vel) return strike(ws);
        if (!seated(v.id) && !flying(v)) {
          let [vx, vy, vz] = vel;
          const planar = Math.hypot(vx, vz);
          if (planar > SHOVE_MAX) {
            vx *= SHOVE_MAX / planar;
            vz *= SHOVE_MAX / planar;
          }
          vy = Math.max(-SHOVE_MAX, Math.min(SHOVE_MAX, vy));
          out.v = [r2(vx), r2(vy), r2(vz)];
        }
      }
      toLevel(w.level, out, ws);
    },
  };
}
