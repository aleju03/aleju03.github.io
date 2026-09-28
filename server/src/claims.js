/*
 * Chunk claims for the block worlds. A claim is one 16x16 column of blocks,
 * full height, that only its owner, the owner's friends and admins may
 * break, place or blast. Unclaimed terrain stays fully editable, which is
 * the whole point of the defaults: nobody has to do anything for the world to
 * be fun, and the ones who build something they care about can fence it with
 * a command.
 *
 * Bounded three ways: MAX_CLAIMS chunks per owner per scope (an owner being
 * an account or a guest's socket, protection.js's `ident`), chunk coordinates
 * held inside the world's own box, and a rate limit on the ops. A claim whose
 * owner has left waits ORPHAN_MS for them (an account's next socket picks it
 * back up) and is then freed, the same grace props get.
 *
 * Every claim is keyed under `ws.world.level` like everything else. What
 * clients hold is personal: each gets the list with a per-claim `allowed`
 * bit computed for them, so the browser can refuse an edit before it makes
 * it, and the server still refuses the ones that arrive anyway
 * (worldBlocks.js asks `check`).
 */
export const MAX_CLAIMS = 4;
export const ORPHAN_MS = 5 * 60_000;
const CHUNKS = 52; // the block world reaches 800 blocks either side: 50 chunks, with margin
const RATE = 12;
const int = (n) => Number.isInteger(n);

export function createClaims({ players, send, protection, now = Date.now, name = (ws) => ws.nick }) {
  const levels = new Map(); // level -> Map<"cx,cz", { key, name, orphanAt }>
  const rates = new WeakMap();
  const level = (n) => {
    let l = levels.get(n);
    if (!l) levels.set(n, l = new Map());
    return l;
  };
  const peers = (n) => [...players.values()].filter((s) => s.world?.level === n);
  const allow = (ws) => {
    const at = now();
    let r = rates.get(ws);
    if (!r || at - r.at >= 5000) rates.set(ws, r = { at, n: 0 });
    return ++r.n <= RATE;
  };
  const note = (ws, code, extra = {}) => send(ws, { type: 'world-social-note', level: ws.world.level, code, ...extra });
  const permits = (ws, c) => ws.isAdmin || c.key === protection.ident(ws) || protection.granted(c.key, ws);

  /** the claim standing on this block column, and whether `ws` may edit it */
  const at = (n, bx, bz) => levels.get(n)?.get(`${Math.floor(bx / 16)},${Math.floor(bz / 16)}`);

  const publish = (ws) => {
    const n = ws.world.level;
    const rows = [];
    for (const [k, c] of levels.get(n) ?? []) {
      const [cx, cz] = k.split(',').map(Number);
      rows.push([cx, cz, c.name, permits(ws, c) ? 1 : 0, c.key === protection.ident(ws) ? 1 : 0]);
    }
    send(ws, { type: 'world-claims', level: n, claims: rows });
  };
  const refresh = (n) => { for (const s of peers(n)) publish(s); };

  const claim = (ws, m) => {
    const n = ws.world.level;
    if (!int(m.cx) || !int(m.cz) || Math.abs(m.cx) > CHUNKS || Math.abs(m.cz) > CHUNKS) return;
    const l = level(n);
    const k = `${m.cx},${m.cz}`;
    const key = protection.ident(ws);
    if (m.op === 'unclaim') {
      const c = l.get(k);
      if (!c) return note(ws, 'claim-none');
      if (c.key !== key && !ws.isAdmin) return note(ws, 'claim-taken', { name: c.name });
      l.delete(k);
      note(ws, 'unclaimed', { cx: m.cx, cz: m.cz });
      return refresh(n);
    }
    const held = l.get(k);
    if (held) return note(ws, held.key === key ? 'claim-yours' : 'claim-taken', { name: held.name });
    let mine = 0;
    for (const c of l.values()) if (c.key === key) mine++;
    if (mine >= MAX_CLAIMS) return note(ws, 'claim-full', { n: MAX_CLAIMS });
    l.set(k, { key, name: name(ws), orphanAt: 0 });
    note(ws, 'claimed', { cx: m.cx, cz: m.cz, n: mine + 1, max: MAX_CLAIMS });
    refresh(n);
  };

  return {
    at, refresh, publish,
    /** null when `ws` may edit the block column, else the claim that says no */
    check: (ws, bx, bz) => {
      const c = at(ws.world.level, bx, bz);
      return c && !permits(ws, c) ? c : null;
    },
    handle: (ws, m) => {
      const w = ws.world;
      if (!w || m.level !== w.level || (m.op !== 'claim' && m.op !== 'unclaim')) return;
      if (!allow(ws)) return note(ws, 'slow');
      claim(ws, m);
    },
    /** a socket arrived in (or changed to) a level: it gets the claims, and an
        owner coming back takes theirs off the orphan clock */
    join: (ws) => {
      const l = levels.get(ws.world.level);
      const key = protection.ident(ws);
      if (l) for (const c of l.values()) if (c.key === key) { c.orphanAt = 0; c.name = name(ws); }
      publish(ws);
    },
    /** the owner left the level: their claims go on a clock unless another
        socket of theirs is still here */
    left: (ws, n) => {
      const l = levels.get(n);
      if (!l) return;
      const key = protection.ident(ws);
      if (peers(n).some((s) => protection.ident(s) === key)) return;
      for (const c of l.values()) if (c.key === key) c.orphanAt = now() + ORPHAN_MS;
    },
    tick: () => {
      const t = now();
      for (const [n, l] of levels) {
        let changed = false;
        for (const [k, c] of l) if (c.orphanAt && c.orphanAt <= t) { l.delete(k); changed = true; }
        if (!l.size) levels.delete(n);
        else if (changed) refresh(n);
      }
    },
  };
}
