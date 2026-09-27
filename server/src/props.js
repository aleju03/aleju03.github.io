/*
 * The level's sandbox registry. Bodies are simulated by one browser, never
 * by this process. Ownership grants editing and cleanup; authority grants
 * physics. A two-phase transfer revokes the old simulator before granting
 * the next one, with epochs rejecting packets left in flight. Connected
 * constraints transfer together, including ropes and no-collides.
 *
 * State is bounded and in memory. Silent bodies cost no periodic traffic;
 * dirty poses are coalesced at the world's tick. Departures retain props
 * and elect a remaining player, or park them with authority zero.
 */
export const PROP_CAP = 150;
const LEVEL_CAP = 2000;
const WORLD_CAP = 8000;
const KINDS = new Set(`crate crate_small pallet plank barrel trashcan sawblade pipe hydrant cone ball bucket milk_crate lawn_chair wheelie_bin chair table couch bathtub mattress door tv melon bottle soda_can block barrier cinder sawhorse girder stop_sign tyre engine barrel_explosive gascan propane dumpster fridge vending streetlamp container plate_s plate_m plate_l beam_s beam_l thruster wheel hoverball seat`.split(' '));
const TYPES = new Set(['weld', 'axis', 'rope', 'nocollide']);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const idOK = (n) => Number.isSafeInteger(n) && n > 0;
const vec = (v, n, cap) => Array.isArray(v) && v.length === n && v.every(finite) ? v.map((x) => clamp(x, -cap, cap)) : null;

export function createPropRegistry({ players, send, now = Date.now }) {
  const levels = new Map();
  const rates = new WeakMap();
  const spawns = new WeakMap();
  let seq = 1;
  let jointSeq = 1;
  const level = (name) => {
    if (!levels.has(name)) levels.set(name, { props: new Map(), joints: new Map(), dirty: new Map() });
    return levels.get(name);
  };
  const peers = (name) => [...players.values()].filter((s) => s.world?.level === name);
  const broadcast = (name, m) => { for (const s of peers(name)) send(s, { ...m, level: name }); };
  const deny = (ws, op, reason, nonce) => send(ws, { type: 'world-prop-denied', level: ws.world.level, op, reason, nonce });
  const allow = (ws, key, max) => {
    let r = rates.get(ws);
    if (!r) rates.set(ws, r = new Map());
    const at = now();
    let b = r.get(key);
    if (!b || at - b.at >= 1000) r.set(key, b = { at, n: 0 });
    return ++b.n <= max;
  };
  const pose = (row, id, epoch) => {
    if (!Array.isArray(row) || (row.length !== 10 && row.length !== 16) || !row.every(finite)) return null;
    const q = row.slice(5, 9);
    const len = Math.hypot(...q);
    if (len < 100 || len > 30000) return null;
    return [id, epoch, ...row.slice(2, 5).map((x) => Math.round(clamp(x, -1e8, 1e8))),
      ...q.map((x) => Math.round(x / len * 10000)), Math.round(row[9]) & 7,
      ...row.slice(10).map((x) => Math.round(clamp(x, -20000, 20000)))];
  };
  const group = (l, id) => {
    const ids = new Set([id]);
    for (const a of ids) for (const j of l.joints.values()) {
      if (j.a === a) ids.add(j.b);
      if (j.b === a) ids.add(j.a);
    }
    return [...ids].map((i) => l.props.get(i)).filter(Boolean);
  };
  const announce = (name, ps) => broadcast(name, { type: 'world-prop-state', props: ps });
  const remove = (name, ids) => {
    const l = level(name);
    for (const id of ids) { l.props.delete(id); l.dirty.delete(id); }
    for (const [id, j] of l.joints) if (ids.includes(j.a) || ids.includes(j.b)) l.joints.delete(id);
    broadcast(name, { type: 'world-prop-remove', ids });
  };
  const grant = (name, ps, who, lock = null) => {
    for (const p of ps) {
      p.authority = who; p.epoch++; p.pose[1] = p.epoch;
      p.lock = lock; delete p.transfer;
    }
    announce(name, ps);
  };
  const settleTransfers = (name) => {
    const l = level(name);
    const done = new Set();
    for (const p of l.props.values()) {
      if (!p.transfer || done.has(p.id)) continue;
      const ps = group(l, p.id);
      ps.forEach((q) => done.add(q.id));
      if (ps.some((q) => q.transfer?.waiting)) continue;
      const t = p.transfer;
      const target = peers(name).some((s) => s.world.id === t.to) ? t.to : (peers(name)[0]?.world.id ?? 0);
      grant(name, ps, target, target === t.to ? t.lock : null);
    }
  };
  const join = (ws) => {
    const name = ws.world.level;
    const l = level(name);
    const parked = [...l.props.values()].filter((p) => p.authority === 0 && !p.transfer);
    if (parked.length) grant(name, parked, ws.world.id);
    send(ws, { type: 'world-prop-snapshot', level: name, props: [...l.props.values()], joints: [...l.joints.values()] });
  };
  const leave = (id, name) => {
    const l = levels.get(name);
    if (!l) return;
    const next = peers(name).find((s) => s.world.id !== id)?.world.id ?? 0;
    const abandoned = [...l.props.values()].filter((p) => p.authority === id && !p.transfer);
    if (abandoned.length) grant(name, abandoned, next);
    for (const p of l.props.values()) if (p.transfer?.waiting === id) p.transfer.waiting = 0;
    settleTransfers(name);
    if (!l.props.size && !peers(name).length) levels.delete(name);
  };
  const handle = (ws, m) => {
    const w = ws.world;
    if (!w || m.level !== w.level) return;
    const l = level(w.level);
    const p = l.props.get(m.id);
    const mutation = m.type !== 'world-prop-move' && m.type !== 'world-prop-ack';
    if (!allow(ws, mutation ? 'edit' : m.type, mutation ? 200 : 30)) {
      if (mutation) deny(ws, m.type, 'rate', m.nonce);
      return;
    }
    if (m.type === 'world-prop-spawn') {
      if (!idOK(m.nonce) || !KINDS.has(m.kind)) return deny(ws, m.type, 'invalid', m.nonce);
      let seen = spawns.get(ws);
      if (!seen) spawns.set(ws, seen = new Map());
      const key = `${w.level}:${m.nonce}`;
      if (seen.has(key)) {
        const existing = l.props.get(seen.get(key));
        if (existing) send(ws, { type: m.type, level: w.level, prop: existing, nonce: m.nonce });
        else deny(ws, m.type, 'invalid', m.nonce);
        return;
      }
      if ([...levels.values()].reduce((n, s) => n + [...s.props.values()].filter((q) => q.owner === w.id).length, 0) >= PROP_CAP || l.props.size >= LEVEL_CAP || [...levels.values()].reduce((n, s) => n + s.props.size, 0) >= WORLD_CAP)
        return deny(ws, m.type, 'limit', m.nonce);
      const row = pose(m.pose, seq, 1);
      if (!row) return deny(ws, m.type, 'invalid', m.nonce);
      const scale = finite(m.scale) ? clamp(m.scale, 0.2, 4) : 1;
      const mass = finite(m.mass) ? clamp(m.mass, 0.05, 20000) : undefined;
      const prop = { id: seq++, owner: w.id, name: ws.user?.username ?? ws.nick, authority: w.id, epoch: 1,
        kind: m.kind, scale, mass, pose: row, lock: null, part: null, life: null };
      l.props.set(prop.id, prop);
      seen.set(key, prop.id);
      if (seen.size > 2048) seen.delete(seen.keys().next().value);
      broadcast(w.level, { type: 'world-prop-spawn', prop, nonce: m.nonce });
    } else if (m.type === 'world-prop-move' || m.type === 'world-prop-ack') {
      if (!Array.isArray(m.rows) || m.rows.length > LEVEL_CAP) return;
      for (const row of m.rows) {
        const q = l.props.get(row?.[0]);
        if (!q || row[1] !== q.epoch) continue;
        const ack = m.type === 'world-prop-ack';
        if (ack ? q.transfer?.waiting !== w.id : (q.authority !== w.id || q.transfer)) continue;
        const clean = pose(row, q.id, q.epoch);
        if (!clean) continue;
        q.pose = clean;
        if (ack) q.transfer.waiting = 0;
        else l.dirty.set(q.id, clean.slice(0, 10));
      }
      if (m.type === 'world-prop-ack') settleTransfers(w.level);
    } else if (m.type === 'world-prop-claim') {
      if (!p || !['hand', 'seat', 'keys', 'collision', 'release'].includes(m.reason)) return;
      const ps = group(l, p.id);
      if (m.reason === 'release') {
        if (p.authority === w.id) { for (const q of ps) q.lock = null; announce(w.level, ps); }
        return;
      }
      if (ps.some((q) => q.transfer || (q.lock && q.authority !== w.id))) return deny(ws, m.type, 'busy');
      if (m.reason === 'collision') {
        const source = l.props.get(m.source);
        if (!source || source.owner !== w.id || source.authority !== w.id || source.pose[9] & 3) return;
        if (Math.hypot(...[2, 3, 4].map((i) => (source.pose[i] - p.pose[i]) / 100)) > 24) return;
      } else {
        if (Math.hypot(p.pose[2] / 100 - w.x, p.pose[3] / 100 - w.y, p.pose[4] / 100 - w.z) > 90) return deny(ws, m.type, 'reach');
        if (m.reason === 'seat' && p.kind !== 'seat') return;
        if (m.reason === 'keys' && (p.owner !== w.id || !['thruster', 'wheel', 'hoverball'].includes(p.kind))) return;
      }
      const lock = m.reason === 'collision' ? null : m.reason;
      if (ps.every((q) => q.authority === w.id)) { for (const q of ps) q.lock = lock; announce(w.level, ps); return; }
      for (const q of ps) {
        q.transfer = { to: w.id, lock, waiting: q.authority };
        q.authority = 0;
        l.dirty.delete(q.id);
      }
      announce(w.level, ps);
      settleTransfers(w.level);
    } else if (m.type === 'world-prop-remove') {
      if (p && p.owner === w.id && !p.transfer) remove(w.level, [p.id]);
    } else if (m.type === 'world-prop-cleanup') {
      let owner = w.id;
      if (m.target === 'all') {
        if (!ws.isAdmin && peers(w.level).length > 1) return deny(ws, m.type, 'admin');
        owner = null;
      } else if (typeof m.target === 'string' && m.target !== 'mine') {
        if (!ws.isAdmin) return deny(ws, m.type, 'admin');
        const found = [...l.props.values()].filter((q) => q.name?.toLowerCase() === m.target.toLowerCase());
        if (!found.length) return deny(ws, m.type, 'name');
        remove(w.level, found.map((q) => q.id)); return;
      }
      remove(w.level, [...l.props.values()].filter((q) => owner === null || q.owner === owner).map((q) => q.id));
    } else if (m.type === 'world-prop-hit') {
      if (!p || p.transfer || !finite(m.amount) || typeof m.ignite !== 'boolean' || !allow(ws, 'hit', 20)) return;
      if (Math.hypot(p.pose[2] / 100 - w.x, p.pose[3] / 100 - w.y, p.pose[4] / 100 - w.z) > 90) return;
      const target = players.get(p.authority);
      if (target?.world?.level === w.level) send(target, { type: m.type, level: w.level, id: p.id, amount: clamp(m.amount, 0, 200), ignite: m.ignite });
    } else if (m.type === 'world-prop-break') {
      // A final break can cross the revoke in flight. The old simulator
      // remains entitled to report it until acknowledging the handoff.
      if (!p || (p.authority !== w.id && p.transfer?.waiting !== w.id) || p.epoch !== m.epoch) return;
      if (!['break', 'explode'].includes(m.how)) return;
      broadcast(w.level, { type: m.type, id: p.id, how: m.how });
      remove(w.level, [p.id]);
      settleTransfers(w.level);
    } else if (m.type === 'world-prop-explosion') {
      const at = vec(m.at, 3, 1e6);
      if (!at || !finite(m.power) || !finite(m.radius) || !allow(ws, 'blast', 20)) return;
      // A source is still registered until its break event. Free blasts are
      // allowed near the caller (the console and weapons use the same seam).
      if (p ? (p.authority !== w.id && p.transfer?.waiting !== w.id) || p.epoch !== m.epoch : Math.hypot(at[0] - w.x, at[1] - w.y, at[2] - w.z) > 90) return;
      broadcast(w.level, { type: m.type, from: w.id, at, power: clamp(m.power, 0.1, 4), radius: clamp(m.radius, 1, 50) });
    } else if (m.type === 'world-prop-meta') {
      if (!p || p.authority !== w.id || p.epoch !== m.epoch || p.transfer) return;
      const part = vec(m.part, 4, 1e6);
      const life = vec(m.life, 4, 60);
      if (part) p.part = [p.owner === w.id ? clamp(Math.round(part[0]), -1, 4) : (p.part?.[0] ?? 0), p.owner === w.id ? (part[1] ? 1 : 0) : (p.part?.[1] ?? 0), part[2], clamp(part[3], -1, 1)];
      if (life) p.life = life;
      announce(w.level, [p]);
    } else if (m.type === 'world-prop-joint') {
      const b = l.props.get(m.b);
      if (!p || !b || p.owner !== w.id || b.owner !== w.id || p.authority !== w.id || b.authority !== w.id || p.transfer || b.transfer) return;
      if (!TYPES.has(m.kind) || p.id === b.id || l.joints.size >= LEVEL_CAP * 4) return;
      // Frames are local, so late arrivals reconstruct the original joint,
      // not a new weld at whatever poses happened to arrive last.
      const frames = vec(m.frames, 17, 1e4);
      if (!frames || Math.hypot(...frames.slice(6, 10)) < 0.1) return;
      for (const [offset, size] of [[6, 4], [10, 3], [13, 3]]) {
        const len = Math.hypot(...frames.slice(offset, offset + size));
        if (len < 0.01) return;
        for (let i = offset; i < offset + size; i++) frames[i] /= len;
      }
      if (m.kind === 'rope') frames[16] = clamp(frames[16], 0.2, 10000);
      if ([...l.joints.values()].some((j) => j.a === p.id && j.b === b.id && j.kind === m.kind && JSON.stringify(j.frames) === JSON.stringify(frames))) return;
      const j = { id: jointSeq++, a: p.id, b: b.id, kind: m.kind, frames };
      l.joints.set(j.id, j);
      broadcast(w.level, { type: 'world-prop-joint', joint: j, nonce: m.nonce });
    } else if (m.type === 'world-prop-unjoint') {
      const j = l.joints.get(m.id);
      if (!j || l.props.get(j.a)?.owner !== w.id || l.props.get(j.b)?.owner !== w.id) return;
      l.joints.delete(j.id);
      broadcast(w.level, { type: m.type, id: j.id });
    }
  };
  return { join, leave, handle, tick: () => {
    for (const [name, l] of levels) {
      if (!l.dirty.size) continue;
      broadcast(name, { type: 'world-prop-move', rows: [...l.dirty.values()] });
      l.dirty.clear();
    }
  } };
}
