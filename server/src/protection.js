/*
 * Who may touch whose things, and who may stay. Every shared world is public
 * to strangers, so this is the module the sandbox's props, Cubeland's claims
 * and the chat all ask before they let someone act on someone else.
 *
 * Identity is the smallest thing that survives what a visitor can do to
 * themselves: a registered account is `u:<username>` on any socket, and a
 * guest is `s:<n>` for the life of one socket (so a guest's friends, props and
 * claims are theirs for a session, and an account's are theirs for good).
 * Everything else here keys off that string and off `ws.world.level`, never
 * off a hard-coded level, so rooms compose with it.
 *
 * Four things live here:
 *  - the scope's protection switch (default ON; the room's first player or
 *    an admin turns it off) and the friend grants ("NAME may use my
 *    things"), one-way, bounded, persisted for accounts by `store`;
 *  - the answer props.js and claims.js give when asked `granted(owner, ws)`;
 *  - the muted (admin, timed, server-wide) and the kicked (admin or vote,
 *    ten minutes, per scope);
 *  - the vote: twenty seconds, one per scope, a majority of the others and
 *    never fewer than three of them, answered with /yes and /no.
 *
 * Nothing here is trusted from the client but a name, a number and a
 * boolean, and every op is rate limited and bounded. Notices travel as a
 * code and parameters (`world-social-note`) and the browser words them in
 * both languages.
 */
export const MAX_FRIENDS = 32;
export const VOTE_MS = 20_000;
export const KICK_MS = 10 * 60_000;
const VOTE_COOLDOWN_MS = 60_000;
const MIN_VOTERS = 3;
const MAX_MUTES = 500;
const MAX_BANS = 500;
const MUTE_DEFAULT_MIN = 10;
const MUTE_MAX_MIN = 24 * 60;
const OPS_PER_WINDOW = 24;
const OPS_WINDOW_MS = 5_000;

export function createProtection({ players, send, store = null, name = (ws) => ws.nick, eject = () => {}, isPrivate = () => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pidSeq = 1;
  const scopes = new Map(); // level -> { protect }
  const grants = new Map(); // owner ident -> Map<grantee ident, display name>
  const loaded = new Set(); // account idents whose list came out of the store
  const mutes = new Map(); // ident -> until
  const bans = new Map(); // `${level}\n${ident}` -> until
  const votes = new Map(); // level -> vote
  const cooldown = new Map(); // ident -> until (who may open the next vote)
  const rates = new WeakMap();
  const claimsRef = { current: null };

  const ident = (ws) => {
    if (ws.user?.username) return `u:${ws.user.username.toLowerCase()}`;
    return `s:${ws.pid ??= pidSeq++}`;
  };
  const peers = (level) => [...players.values()].filter((s) => s.world?.level === level);
  const hostOf = (level) => peers(level).reduce((h, s) => (!h || s.world.id < h.world.id ? s : h), null);
  const enabled = (level) => scopes.get(level)?.protect ?? true;
  const cap = (ws) => (isPrivate(ws.world.level) ? 400 : 150);
  const allow = (ws) => {
    const at = now();
    let r = rates.get(ws);
    if (!r || at - r.at >= OPS_WINDOW_MS) rates.set(ws, r = { at, n: 0 });
    return ++r.n <= OPS_PER_WINDOW;
  };
  const note = (ws, level, code, extra = {}) => send(ws, { type: 'world-social-note', level, code, ...extra });
  const tell = (level, code, extra = {}) => { for (const s of peers(level)) note(s, level, code, extra); };

  /** is `ws` one of the people `owner` has granted */
  const granted = (owner, ws) => Boolean(owner) && (grants.get(owner)?.has(ident(ws)) ?? false);
  /** the world ids in `ws`'s level whose owners have granted it */
  const grantedBy = (ws) => {
    const me = ident(ws);
    return peers(ws.world.level).filter((s) => s !== ws && grants.get(ident(s))?.has(me)).map((s) => s.world.id);
  };

  const publish = (ws) => {
    if (!ws.world) return;
    const level = ws.world.level;
    send(ws, {
      type: 'world-social', level, protect: enabled(level), host: hostOf(level)?.world.id ?? 0,
      friends: [...(grants.get(ident(ws))?.values() ?? [])], grantedBy: grantedBy(ws),
    });
  };
  const publishLevel = (level) => { for (const s of peers(level)) publish(s); claimsRef.current?.refresh(level); };
  const publishAll = () => { const seen = new Set(); for (const s of players.values()) if (s.world && !seen.has(s.world.level)) { seen.add(s.world.level); publishLevel(s.world.level); } };

  const find = (level, query) => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q || q.length > 32) return null;
    const all = peers(level);
    return all.find((s) => name(s).toLowerCase() === q) ?? (() => {
      const some = all.filter((s) => name(s).toLowerCase().startsWith(q));
      return some.length === 1 ? some[0] : null;
    })();
  };

  const loadFriends = (ws) => {
    const key = ident(ws);
    if (!ws.user?.id || loaded.has(key)) return;
    loaded.add(key);
    let g = grants.get(key);
    if (!g) grants.set(key, g = new Map());
    for (const f of store?.list(ws.user.id) ?? []) if (g.size < MAX_FRIENDS) g.set(`u:${f.toLowerCase()}`, f);
  };

  const banKey = (level, key) => `${level}\n${key}`;
  const banned = (ws, level) => {
    const k = banKey(level, ident(ws));
    const until = bans.get(k) ?? 0;
    if (until > now()) return until;
    bans.delete(k);
    return 0;
  };
  const ban = (ws, level, ms) => {
    const at = now();
    if (bans.size >= MAX_BANS) for (const [k, u] of bans) if (u <= at) bans.delete(k);
    if (bans.size >= MAX_BANS) bans.delete(bans.keys().next().value);
    bans.set(banKey(level, ident(ws)), at + ms);
  };
  const kick = (target, level, by) => {
    ban(target, level, KICK_MS);
    send(target, { type: 'world-kicked', level, until: now() + KICK_MS, by });
    eject(target);
  };
  const muted = (ws) => {
    const key = ident(ws);
    const until = mutes.get(key) ?? 0;
    if (until > now()) return until;
    mutes.delete(key);
    return 0;
  };

  /* ------------------------------------------------------------ the vote -- */

  const electorate = (v) => peers(v.level).filter((s) => ident(s) !== v.target);
  const need = (voters) => Math.max(MIN_VOTERS, Math.floor(voters / 2) + 1);
  const settle = (v, timeout) => {
    const voters = electorate(v);
    const ids = new Set(voters.map((s) => s.world.id));
    const yes = [...v.yes].filter((i) => ids.has(i)).length;
    const no = [...v.no].filter((i) => ids.has(i)).length;
    const want = need(voters.length);
    const passed = yes >= want;
    const failed = timeout || no > voters.length - want || voters.length < MIN_VOTERS;
    if (!passed && !failed) return;
    clearTimer(v.timer);
    votes.delete(v.level);
    const target = peers(v.level).find((s) => ident(s) === v.target);
    if (passed && target) {
      tell(v.level, 'vote-pass', { name: v.name, yes, n: voters.length });
      kick(target, v.level, 0);
    } else tell(v.level, 'vote-fail', { name: v.name, yes, n: voters.length });
  };

  const startVote = (ws, level, query) => {
    if (votes.has(level)) return note(ws, level, 'vote-busy');
    if ((cooldown.get(ident(ws)) ?? 0) > now()) return note(ws, level, 'vote-cooldown');
    const target = find(level, query);
    if (!target) return note(ws, level, 'no-such-player', { name: String(query ?? '').slice(0, 32) });
    if (target === ws) return note(ws, level, 'vote-self');
    if (target.isAdmin) return note(ws, level, 'vote-admin');
    if (peers(level).length - 1 < MIN_VOTERS) return note(ws, level, 'vote-few', { n: MIN_VOTERS });
    const v = { level, target: ident(target), name: name(target), yes: new Set([ws.world.id]), no: new Set(), timer: 0 };
    v.timer = setTimer(() => settle(v, true), VOTE_MS);
    v.timer?.unref?.();
    votes.set(level, v);
    if (cooldown.size > 500) for (const [k, u] of cooldown) if (u <= now()) cooldown.delete(k);
    cooldown.set(ident(ws), now() + VOTE_COOLDOWN_MS);
    const voters = electorate(v);
    for (const s of peers(level)) note(s, level, 'vote-start', { name: v.name, by: name(ws), secs: VOTE_MS / 1000, need: need(voters.length), n: voters.length });
    settle(v, false);
  };

  const answer = (ws, level, yes) => {
    const v = votes.get(level);
    if (!v) return note(ws, level, 'vote-none');
    if (ident(ws) === v.target) return note(ws, level, 'vote-target');
    v.yes.delete(ws.world.id); v.no.delete(ws.world.id);
    (yes ? v.yes : v.no).add(ws.world.id);
    const voters = electorate(v);
    note(ws, level, 'vote-counted', { yes: v.yes.size, no: v.no.size, need: need(voters.length), n: voters.length, name: v.name });
    settle(v, false);
  };

  /* ---------------------------------------------------------- the client -- */

  const setFriend = (ws, level, query, on) => {
    const key = ident(ws);
    let g = grants.get(key);
    if (on) {
      const who = find(level, query);
      if (!who) return note(ws, level, 'no-such-player', { name: String(query ?? '').slice(0, 32) });
      if (who === ws || ident(who) === key) return note(ws, level, 'friend-self');
      if (!g) grants.set(key, g = new Map());
      if (g.has(ident(who))) return note(ws, level, 'friend-already', { name: name(who) });
      if (g.size >= MAX_FRIENDS) return note(ws, level, 'friend-full', { n: MAX_FRIENDS });
      g.set(ident(who), name(who));
      if (ws.user?.id && who.user?.username) store?.add(ws.user.id, who.user.username.toLowerCase());
      note(ws, level, 'friend-added', { name: name(who) });
      note(who, level, 'friend-granted', { name: name(ws) });
    } else {
      const q = String(query ?? '').trim().toLowerCase();
      const hit = g && [...g].find(([, n]) => n.toLowerCase() === q) ;
      if (!hit) return note(ws, level, 'friend-none', { name: String(query ?? '').slice(0, 32) });
      g.delete(hit[0]);
      if (ws.user?.id && hit[0].startsWith('u:')) store?.remove(ws.user.id, hit[0].slice(2));
      note(ws, level, 'friend-removed', { name: hit[1] });
    }
    publishLevel(level);
  };

  const handle = (ws, m) => {
    const w = ws.world;
    if (!w || m.level !== w.level) return;
    if (!allow(ws)) return note(ws, w.level, 'slow');
    const level = w.level;
    switch (m.op) {
      case 'friend': return setFriend(ws, level, m.name, true);
      case 'unfriend': return setFriend(ws, level, m.name, false);
      case 'protect': {
        if (typeof m.on !== 'boolean') return;
        if (!ws.isAdmin && hostOf(level) !== ws) return note(ws, level, 'not-host');
        scopes.set(level, { protect: m.on });
        tell(level, m.on ? 'protect-on' : 'protect-off', { name: name(ws) });
        return publishLevel(level);
      }
      case 'votekick': return startVote(ws, level, m.name);
      case 'vote': return answer(ws, level, m.yes === true);
      case 'kick': {
        if (!ws.isAdmin) return note(ws, level, 'not-admin');
        const who = find(level, m.name);
        if (!who) return note(ws, level, 'no-such-player', { name: String(m.name ?? '').slice(0, 32) });
        if (who === ws || who.isAdmin) return note(ws, level, 'vote-admin');
        tell(level, 'kicked', { name: name(who) });
        return kick(who, level, w.id);
      }
      case 'mute': {
        if (!ws.isAdmin) return note(ws, level, 'not-admin');
        const who = find(level, m.name);
        if (!who) return note(ws, level, 'no-such-player', { name: String(m.name ?? '').slice(0, 32) });
        if (who.isAdmin) return note(ws, level, 'vote-admin');
        const min = Number.isFinite(m.minutes) ? Math.max(1, Math.min(MUTE_MAX_MIN, Math.round(m.minutes))) : MUTE_DEFAULT_MIN;
        const at = now();
        if (mutes.size >= MAX_MUTES) for (const [k, u] of mutes) if (u <= at) mutes.delete(k);
        if (mutes.size >= MAX_MUTES) mutes.delete(mutes.keys().next().value);
        mutes.set(ident(who), at + min * 60_000);
        note(ws, level, 'muted', { name: name(who), n: min });
        return note(who, level, 'you-muted', { n: min });
      }
      case 'unmute': {
        if (!ws.isAdmin) return note(ws, level, 'not-admin');
        const who = find(level, m.name);
        if (!who) return note(ws, level, 'no-such-player', { name: String(m.name ?? '').slice(0, 32) });
        mutes.delete(ident(who));
        note(ws, level, 'unmuted', { name: name(who) });
        return note(who, level, 'you-unmuted');
      }
    }
  };

  return {
    ident, enabled, cap, granted, muted, banned, handle, kick, publish, hostOf,
    attach: (claims) => { claimsRef.current = claims; },
    join: (ws) => { loadFriends(ws); publishLevel(ws.world.level); },
    /** a socket left `level` (or the world). Guests take their grants with
        them; an account's list stays until the last of its sockets is gone */
    leave: (ws, level, id, moved = false) => {
      const key = ident(ws);
      const still = [...players.values()].some((s) => s !== ws && s.world && ident(s) === key);
      if (!still && !moved) {
        grants.delete(key);
        loaded.delete(key);
        if (key.startsWith('s:')) for (const g of grants.values()) g.delete(key);
      }
      const v = votes.get(level);
      if (v) { v.yes.delete(id); v.no.delete(id); settle(v, false); }
      if (!peers(level).length) {
        scopes.delete(level);
        const open = votes.get(level);
        if (open) { clearTimer(open.timer); votes.delete(level); }
      }
      for (const s of peers(level)) publish(s);
    },
    publishAll,
  };
}
