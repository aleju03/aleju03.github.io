/*
 * Portal pairs belong to the socket that placed them. They survive a level
 * change so a player can walk through their own Earth/Moon pair, and close
 * on departure. Subscribers receive pairs touching their level, including
 * the exit frame needed to traverse a cross-level pair. Jump clouds are
 * ephemeral, deduplicated events delivered only to peers in the same level.
 */
const LEVELS = new Set(['overworld', 'moon']);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const frame = (f, limit) => {
  if (!Array.isArray(f) || f.length !== 9 || !f.every(finite) || f.slice(0, 3).some(n => Math.abs(n) > limit)) return null;
  const n = f.slice(3, 6), up = f.slice(6, 9);
  const len = Math.hypot(...n);
  if (len < 0.5 || len > 2) return null;
  for (let i = 0; i < 3; i++) n[i] /= len;
  const dot = up.reduce((sum, v, i) => sum + v * n[i], 0);
  for (let i = 0; i < 3; i++) up[i] -= dot * n[i];
  const ul = Math.hypot(...up);
  if (ul < 0.2 || ul > 2) return null;
  return [...f.slice(0, 3).map(round), ...n.map(round), ...up.map(v => round(v / ul))];
};
export function createWorldEffects({ players, send, prop, now = Date.now }) {
  const pairs = new Map();
  const rates = new WeakMap();
  const hops = new WeakMap();
  const anchored = new Map();
  const resolved = (pair) => pair.map((p) => {
    if (!p?.anchor) return p;
    const body = prop(p.level, p.anchor.prop);
    if (!body) return null;
    const row = body.pose, f = p.anchor.frame;
    const q = row.slice(5, 9).map(v => v / 10000);
    const len = Math.hypot(...q);
    for (let i = 0; i < 4; i++) q[i] /= len;
    const rotate = (v) => {
      const [x, y, z] = v, [qx, qy, qz, qw] = q;
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
    };
    return { ...p, frame: [...rotate(f.slice(0, 3)).map((v, i) => round(v + row[i + 2] / 100)),
      ...rotate(f.slice(3, 6)).map(round), ...rotate(f.slice(6, 9)).map(round)] };
  });
  const allow = (ws, kind, cap) => {
    let r = rates.get(ws);
    if (!r) rates.set(ws, r = {});
    const at = now();
    if (!r[kind] || at - r[kind].at >= 1000) r[kind] = { at, n: 0 };
    return ++r[kind].n <= cap;
  };
  const touches = (pair, level) => pair.some(p => p?.level === level);
  const publish = (owner, before, pair) => {
    for (const ws of players.values()) {
      const level = ws.world.level;
      if (!touches(before, level) && !touches(pair, level) && ws.world.id !== owner) continue;
      send(ws, { type: 'world-portal', level, owner, portals: touches(pair, level) ? resolved(pair) : [null, null] });
    }
  };
  const snapshot = (ws) => {
    const level = ws.world.level;
    send(ws, { type: 'world-portals', level, pairs: [...pairs].filter(([, pair]) => touches(pair, level)).map(([owner, portals]) => ({ owner, portals: resolved(portals) })) });
  };
  return {
    snapshot,
    tick: () => {
      for (const [owner, pair] of pairs) {
        if (!pair.some(p => p?.anchor)) continue;
        const projected = resolved(pair);
        const key = JSON.stringify(projected.map(p => p?.frame));
        if (anchored.get(owner) === key) continue;
        anchored.set(owner, key);
        for (const ws of players.values()) {
          const level = ws.world.level;
          // Same-level clients already have this prop's transform stream.
          if (touches(pair, level) && pair.some(p => p?.anchor && p.level !== level)) {
            send(ws, { type: 'world-portal', level, owner, portals: projected });
          }
        }
      }
    },
    leave: (owner) => {
      const pair = pairs.get(owner);
      anchored.delete(owner);
      if (!pair) return;
      pairs.delete(owner);
      publish(owner, pair, [null, null]);
    },
    removeProps: (level, ids) => {
      const gone = new Set(ids);
      for (const [owner, pair] of pairs) {
        const next = pair.map(p => p?.level === level && p.anchor && gone.has(p.anchor.prop) ? null : p);
        if (next.every((p, i) => p === pair[i])) continue;
        if (next.some(Boolean)) pairs.set(owner, next); else { pairs.delete(owner); anchored.delete(owner); }
        publish(owner, pair, next);
      }
    },
    handle: (ws, m) => {
      const w = ws.world;
      if (!w) return;
      if (m.type === 'world-air-hop') {
        if (m.level !== w.level || !Number.isSafeInteger(m.seq) || m.seq <= (hops.get(ws) ?? 0)) return;
        if (![m.x, m.y, m.z].every(finite) || Math.hypot(m.x - w.x, m.y - w.y, m.z - w.z) > 20) return;
        if (!allow(ws, 'hop', 3)) return;
        hops.set(ws, m.seq);
        for (const peer of players.values()) if (peer !== ws && peer.world.level === w.level) {
          send(peer, { type: m.type, level: w.level, id: w.id, seq: m.seq, x: round(m.x), y: round(m.y), z: round(m.z) });
        }
        return;
      }
      if (m.type !== 'world-portal' || (m.color !== 0 && m.color !== 1)) return;
      const reject = () => send(ws, { type: 'world-portal-denied', color: m.color, serial: Number.isSafeInteger(m.portal?.serial) ? m.portal.serial : 0 });
      if (!allow(ws, 'portal', 24)) return reject();
      const before = pairs.get(w.id) ?? [null, null];
      let clean = null;
      if (m.portal !== null) {
        const p = m.portal;
        if (!p || !LEVELS.has(p.level) || !Number.isSafeInteger(p.serial) || p.serial < 1 || p.serial > 1e9) return reject();
        if (p.serial < (before[m.color]?.serial ?? 0)) return reject();
        const f = frame(p.frame, 1e7);
        if (!f || typeof p.ground !== 'boolean' || typeof p.ready !== 'boolean' || !finite(p.inset) || !finite(p.skin)) return reject();
        if (![null, 'moon', 'earth'].includes(p.site)) return reject();
        // The sky shots use fixed sites in the other level. No arbitrary
        // cross-level placement is accepted under that exception.
        if (p.level !== w.level) {
          const moonSite = w.level === 'overworld' && p.level === 'moon' && p.site === 'moon' && Math.hypot(f[0] - 14, f[2] - 60000) < 30;
          const earthSite = w.level === 'moon' && p.level === 'overworld' && p.site === 'earth' && Math.hypot(f[0] - 9.25, f[2] + 1.75) < 10;
          // Existing endpoints may report readiness or moving anchors after
          // the owner crosses; the endpoint itself must already be known.
          const previous = before[m.color];
          const retained = previous && previous.serial === p.serial && previous.level === p.level && (previous.anchor?.prop === p.anchor?.prop && !!p.anchor || Math.hypot(...f.slice(0, 3).map((v, i) => v - previous.frame[i])) < 10);
          if (!moonSite && !earthSite && !retained) return reject();
        } else if (Math.hypot(f[0] - w.x, f[1] - w.y, f[2] - w.z) > 440 && before[m.color]?.serial !== p.serial) return reject();
        let anchor = null;
        if (p.anchor !== null) {
          const id = p.anchor?.prop;
          const local = frame(p.anchor?.frame, 128);
          const body = Number.isSafeInteger(id) ? prop(p.level, id) : null;
          if (!local || !body) return reject();
          anchor = { prop: id, frame: local };
        }
        clean = { serial: p.serial, level: p.level, frame: f, ground: p.ground, ready: p.ready,
          inset: clamp(p.inset, 0, 4), skin: clamp(p.skin, 0, 1), site: p.site, anchor };
      }
      const pair = before.slice(); pair[m.color] = clean;
      if (pair.some(Boolean)) pairs.set(w.id, pair); else pairs.delete(w.id);
      publish(w.id, before, pair);
    },
  };
}
