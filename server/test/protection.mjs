/*
 * Ownership, friends, claims, caps, orphans, votes and mutes. The unit half
 * drives the modules with fake sockets and a fake clock (so five minutes and
 * twenty seconds cost nothing); the socket half runs the same rules over the
 * real server: stranger vs owner vs friend vs admin, a refused block edit
 * answered with a correction, a vote-kick, a mute, a persisted friend.
 */
import assert from 'node:assert/strict';
import { createPropRegistry, ORPHAN_MS } from '../src/props.js';
import { createProtection, VOTE_MS, KICK_MS, MAX_FRIENDS } from '../src/protection.js';
import { createClaims, MAX_CLAIMS } from '../src/claims.js';
import { createWorldBlocks } from '../src/worldBlocks.js';

const POSE = [0, 1, 100, 300, 200, 0, 0, 0, 10000, 1];

function rig({ isPrivate = () => false } = {}) {
  let clock = 1e6;
  const timers = [];
  const players = new Map();
  const log = [];
  const send = (ws, m) => log.push([ws.nick, m]);
  const ejected = [];
  const protection = createProtection({
    players, send, name: (w) => w.nick, isPrivate, now: () => clock,
    eject: (ws) => { ejected.push(ws.nick); players.delete(ws.world.id); ws.world = null; },
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, on: true, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.on = false; },
  });
  const claims = createClaims({ players, send, protection, now: () => clock, name: (w) => w.nick });
  protection.attach(claims);
  const registry = createPropRegistry({ players, send, access: protection, now: () => clock });
  const blocks = createWorldBlocks({ players, send, claims, now: () => clock });
  let id = 0;
  const join = (nick, { level = 'r', admin = false, user = null } = {}) => {
    const ws = { nick, isAdmin: admin, user, world: { id: ++id, level, x: 0, y: 1, z: 0 } };
    players.set(ws.world.id, ws);
    protection.join(ws); claims.join(ws); registry.join(ws);
    return ws;
  };
  const leave = (ws) => {
    const w = ws.world;
    players.delete(w.id); ws.world = null;
    registry.leave(w.id, w.level); claims.left(ws, w.level); protection.leave(ws, w.level, w.id);
  };
  const advance = (ms) => {
    clock += ms;
    for (const t of timers) if (t.on && t.at <= clock) { t.on = false; t.fn(); }
    registry.sweep(); claims.tick();
  };
  const since = (mark) => log.slice(mark);
  const last = (nick, type) => [...log].reverse().find(([n, m]) => n === nick && m.type === type)?.[1];
  const notes = (nick, from = 0) => log.slice(from).filter(([n, m]) => n === nick && m.type === 'world-social-note').map(([, m]) => m.code);
  const tx = (ws, m) => { registry.handle(ws, { level: ws.world.level, ...m }); };
  const social = (ws, m) => { const msg = { type: 'world-social', level: ws.world.level, ...m }; return m.op === 'claim' || m.op === 'unclaim' ? claims.handle(ws, msg) : protection.handle(ws, msg); };
  let nonce = 1;
  const spawn = (ws, kind = 'crate') => {
    const n = nonce++;
    const mark = log.length;
    tx(ws, { type: 'world-prop-spawn', nonce: n, kind, pose: POSE });
    const spawned = since(mark).find(([who, m]) => who === ws.nick && m.type === 'world-prop-spawn')?.[1];
    return spawned?.prop ?? { denied: since(mark).find(([who, m]) => who === ws.nick && m.type === 'world-prop-denied')?.[1] };
  };
  const denials = (ws, mark) => log.slice(mark).filter(([n, m]) => n === ws.nick && m.type === 'world-prop-denied').map(([, m]) => m);
  return { players, log, protection, claims, registry, blocks, join, leave, advance, since, last, notes, tx, social, spawn, denials, ejected, now: () => clock };
}

function unit() {
  // ---- who may touch what: owner, stranger, friend, admin, share, switch
  {
    const r = rig();
    const owner = r.join('owner'), stranger = r.join('stranger'), friend = r.join('friend'), admin = r.join('boss', { admin: true });
    const p = r.spawn(owner);
    assert.equal(p.owner, owner.world.id);
    const grab = (who, prop) => { const mark = r.log.length; r.tx(who, { type: 'world-prop-claim', id: prop.id, reason: 'hand' }); return r.denials(who, mark); };
    let d = grab(stranger, p);
    assert.equal(d.length, 1, 'a stranger cannot grab');
    assert.equal(d[0].reason, 'protected'); assert.equal(d[0].owner, 'owner'); assert.equal(d[0].id, p.id);
    let mark = r.log.length;
    r.tx(stranger, { type: 'world-prop-remove', id: p.id });
    assert.equal(r.denials(stranger, mark)[0].reason, 'protected', 'a stranger cannot remove');
    assert.ok(r.registry.get('r', p.id), 'and it is still there');
    // welding: two of the stranger's own props are fine, one of the owner's is not
    const mine = r.spawn(stranger);
    r.tx(stranger, { type: 'world-prop-claim', id: mine.id, reason: 'hand' });
    mark = r.log.length;
    const frames = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1];
    r.tx(stranger, { type: 'world-prop-joint', id: mine.id, b: p.id, kind: 'weld', frames, nonce: 1 });
    assert.ok(!r.since(mark).some(([, m]) => m.type === 'world-prop-joint'), 'no weld to a stranger\'s prop');
    // a body bump is physics: a collision claim needs the source to be ours, not the target
    r.tx(stranger, { type: 'world-prop-claim', id: p.id, reason: 'collision', source: mine.id });
    assert.equal(r.denials(stranger, mark).length, 0, 'bumping a stranger\'s prop is not refused');
    // friend: a one-way grant
    r.social(owner, { op: 'friend', name: 'friend' });
    assert.ok(r.notes('owner').includes('friend-added') && r.notes('friend').includes('friend-granted'));
    assert.deepEqual(r.last('friend', 'world-social').grantedBy, [owner.world.id], 'the friend is told whose things they may use');
    assert.deepEqual(r.last('owner', 'world-social').friends, ['friend']);
    const q = r.spawn(owner);
    assert.equal(grab(friend, q).length, 0, 'a friend may grab');
    const q2 = r.spawn(friend);
    assert.equal(grab(owner, q2).length, 1, 'the grant is one-way');
    // the friend welds owner's prop to theirs (both authorities are theirs once claimed)
    const r2 = r.spawn(owner);
    // unfriend closes it again
    r.social(owner, { op: 'unfriend', name: 'friend' });
    assert.equal(grab(friend, r2).length, 1, 'unfriended');
    // admin ignores ownership
    assert.equal(grab(admin, r2).length, 0, 'an admin may grab anything');
    // share opens one prop to everybody, unshare closes it
    const s = r.spawn(owner);
    mark = r.log.length;
    r.tx(stranger, { type: 'world-prop-share', ids: [s.id], on: true });
    assert.equal(r.denials(stranger, mark)[0].reason, 'protected', 'only the owner shares');
    r.tx(owner, { type: 'world-prop-share', ids: [s.id], on: true });
    assert.equal(r.registry.get('r', s.id).share, true);
    assert.equal(grab(stranger, s).length, 0, 'a shared prop is public');
    // toys are open from the start
    const ball = r.spawn(owner, 'ball');
    assert.equal(ball.share, true);
    assert.equal(r.spawn(owner, 'barrel').share, false);
    // the switch: only the first player or an admin, and off means free for all
    const t = r.spawn(owner);
    r.social(stranger, { op: 'protect', on: false });
    assert.ok(r.notes('stranger').includes('not-host'), 'a stranger cannot switch protection');
    r.social(owner, { op: 'protect', on: false });
    assert.equal(r.last('stranger', 'world-social').protect, false);
    assert.equal(grab(stranger, t).length, 0, 'protection off: free for all');
    r.social(admin, { op: 'protect', on: true });
    assert.equal(r.last('stranger', 'world-social').protect, true, 'an admin can switch it back');
    // the same account on another socket is the same owner
    const u1 = r.join('acct-a', { user: { id: 0, username: 'Ann' } });
    const u2 = r.join('acct-b', { user: { id: 0, username: 'ann' } });
    const own = r.spawn(u1);
    assert.equal(grab(u2, own).length, 0, 'two sockets of one account are one owner');
    // cleanup only removes the caller's stuff
    const before = [...Array(3)].map(() => r.spawn(stranger));
    r.tx(stranger, { type: 'world-prop-cleanup', target: 'mine' });
    assert.ok(before.every((x) => !r.registry.get('r', x.id)));
    assert.ok(r.registry.get('r', p.id) && r.registry.get('r', q.id), 'cleanup left everyone else\'s');
    mark = r.log.length;
    r.tx(stranger, { type: 'world-prop-cleanup', target: 'all' });
    assert.equal(r.denials(stranger, mark)[0].reason, 'admin', 'cleanup all is an admin\'s while others are here');
    r.tx(admin, { type: 'world-prop-cleanup', target: 'all' });
    assert.ok(!r.registry.get('r', p.id), 'an admin clears everyone\'s');
  }

  // ---- caps and rate: 150 public, 400 private, per owner, and a spawn rate
  {
    const pub = rig(), priv = rig({ isPrivate: (l) => l === 'r' });
    for (const [x, cap] of [[pub, 150], [priv, 400]]) {
      const a = x.join('a'), b = x.join('b');
      let n = 0, denied = null;
      for (; n < cap + 5; n++) {
        x.advance(60); // ~17 a second: inside the rate
        const p = x.spawn(a);
        if (p.denied) { denied = p.denied; break; }
      }
      assert.equal(n, cap, `cap ${cap}`);
      assert.equal(denied.reason, 'limit'); assert.equal(denied.cap, cap, 'the message carries the cap');
      x.advance(60);
      assert.ok(!x.spawn(b).denied, 'the cap is per owner');
    }
    const r = rig();
    const a = r.join('a');
    let ok = 0, rate = null;
    for (let i = 0; i < 140; i++) { const p = r.spawn(a); if (p.denied) { rate = p.denied; break; } ok++; }
    assert.equal(ok, 100, 'a burst of a hundred, then the rate limit'); assert.equal(rate.reason, 'rate');
    r.advance(2000);
    assert.ok(!r.spawn(a).denied, 'and it refills');
  }

  // ---- orphans: five minutes, then gone; an account coming back takes them back
  {
    const r = rig();
    const guest = r.join('guest'), stay = r.join('stay');
    const acct = r.join('acct', { user: { id: 0, username: 'zed' } });
    const g = r.spawn(guest), s = r.spawn(stay), z = r.spawn(acct);
    r.leave(guest); r.leave(acct);
    r.advance(ORPHAN_MS - 1000);
    assert.ok(r.registry.get('r', g.id) && r.registry.get('r', z.id), 'they wait');
    const back = r.join('acct2', { user: { id: 0, username: 'zed' } });
    assert.equal(r.registry.get('r', z.id).owner, back.world.id, 'the account adopts its props back');
    r.advance(2000);
    assert.ok(!r.registry.get('r', g.id), 'a guest\'s props are removed after five minutes');
    assert.ok(r.registry.get('r', z.id) && r.registry.get('r', s.id), 'the adopted and the present stay');
    assert.ok(r.log.some(([, m]) => m.type === 'world-prop-remove' && m.ids.includes(g.id)), 'and everybody is told');
  }

  // ---- friends are bounded, and a guest's go with them
  {
    const r = rig();
    const a = r.join('a');
    for (let i = 0; i < MAX_FRIENDS + 2; i++) { r.join(`f${i}`); r.advance(300); r.social(a, { op: "friend", name: `f${i}` }); }
    assert.ok(r.notes('a').includes('friend-full'));
    assert.equal(r.last('a', 'world-social').friends.length, MAX_FRIENDS);
    r.social(a, { op: 'friend', name: 'nobody-here' });
    assert.ok(r.notes('a').includes('no-such-player'));
    r.social(a, { op: 'friend', name: 'a' });
    assert.ok(r.notes('a').includes('friend-self'));
  }

  // ---- the vote: majority, minimum three voters, twenty seconds, ten-minute ban
  {
    const r = rig();
    const a = r.join('a'), t = r.join('target'), c = r.join('c');
    r.social(a, { op: 'votekick', name: 'target' });
    assert.ok(r.notes('a').includes('vote-few'), 'two others are not a vote');
    const d = r.join('d');
    r.social(a, { op: 'votekick', name: 'target' });
    assert.ok(r.notes('c').includes('vote-start'), 'the room hears it');
    r.social(d, { op: 'votekick', name: 'c' });
    assert.ok(r.notes('d').includes('vote-busy'), 'one vote at a time');
    r.social(t, { op: 'vote', yes: false });
    assert.ok(r.notes('target').includes('vote-target'), 'the accused does not vote');
    r.social(c, { op: 'vote', yes: true });
    assert.deepEqual(r.ejected, [], 'two of three is not yet');
    r.social(d, { op: 'vote', yes: true });
    assert.deepEqual(r.ejected, ['target'], 'three yes votes carry it');
    assert.ok(r.notes('a').includes('vote-pass'));
    assert.equal(r.log.find(([n, m]) => n === 'target' && m.type === 'world-kicked')[1].until, r.now() + KICK_MS);
    const again = { nick: 'x', world: { id: 99, level: 'r' }, user: null };
    assert.equal(r.protection.banned(t, 'r') > r.now(), true, 'banned from the scope for ten minutes');
    assert.equal(r.protection.banned(t, 'other'), 0, 'and only from that scope');
    assert.ok(again);
    r.advance(KICK_MS + 1);
    assert.equal(r.protection.banned(t, 'r'), 0, 'then let back in');
  }
  {
    const r = rig();
    const a = r.join('a'), t = r.join('t'), c = r.join('c'), d = r.join('d');
    r.advance(1); // (the cooldown is per opener, not per room)
    r.social(a, { op: 'votekick', name: 't' });
    r.social(c, { op: 'vote', yes: false });
    assert.ok(r.notes('a').includes('vote-fail'), 'three needed of three: one no ends it at once');
    assert.ok(d);
    assert.deepEqual(r.ejected, []);
    // timeout: undecided after twenty seconds fails
    r.advance(61_000);
    r.social(c, { op: 'votekick', name: 't' });
    r.advance(VOTE_MS + 1);
    assert.equal(r.notes('c').filter((x) => x === 'vote-fail').length, 2, 'twenty seconds and nobody answered: a second failure');
    assert.deepEqual(r.ejected, []);
    // an admin cannot be voted out, and a vote needs a real player
    const boss = r.join('boss', { admin: true });
    r.advance(61_000);
    r.social(a, { op: 'votekick', name: 'boss' });
    assert.ok(r.notes('a').includes('vote-admin'));
    r.social(a, { op: 'votekick', name: 'ghost' });
    assert.ok(r.notes('a').includes('no-such-player'));
    // admin /kick is immediate and only for admins; /mute and /unmute likewise
    r.social(a, { op: 'kick', name: 't' });
    assert.ok(r.notes('a').includes('not-admin'));
    r.social(a, { op: 'mute', name: 't' });
    r.social(boss, { op: 'mute', name: 't', minutes: 2 });
    assert.ok(r.protection.muted(t) > r.now(), 'muted');
    r.advance(2 * 60_000 + 1);
    assert.equal(r.protection.muted(t), 0, 'a mute runs out');
    r.social(boss, { op: 'mute', name: 't' });
    r.social(boss, { op: 'unmute', name: 't' });
    assert.equal(r.protection.muted(t), 0, 'and can be lifted');
    r.social(boss, { op: 'kick', name: 't' });
    assert.deepEqual(r.ejected, ['t']);
    assert.ok(r.protection.banned(t, 'r'));
    // abuse: a flood of ops is dropped
    for (let i = 0; i < 60; i++) r.social(a, { op: 'friend', name: 'c' });
    assert.ok(r.notes('a').includes('slow'));
  }

  // ---- claims: four per owner, owner and friends and admins edit, others are refused
  {
    const r = rig();
    const a = r.join('a'), b = r.join('b'), c = r.join('c'), boss = r.join('boss', { admin: true });
    for (let i = 0; i < MAX_CLAIMS; i++) r.social(a, { op: 'claim', cx: i, cz: 0 });
    r.social(a, { op: 'claim', cx: 9, cz: 9 });
    assert.ok(r.notes('a').includes('claim-full'), 'four claims');
    r.social(b, { op: 'claim', cx: 0, cz: 0 });
    assert.ok(r.notes('b').includes('claim-taken'));
    r.social(b, { op: 'unclaim', cx: 0, cz: 0 });
    assert.ok(r.claims.at('r', 0, 0), 'a stranger cannot unclaim');
    const edit = (ws, x, z, blast = false) => { const mark = r.log.length; r.blocks.handle(ws, { type: 'world-blocks', level: 'r', edits: [x, 40, z, 0], blast }); return r.since(mark); };
    let out = edit(b, 5, 5);
    assert.equal(out.filter(([, m]) => m.type === 'world-blocks').length, 0, 'a stranger\'s edit is not relayed');
    const ref = out.find(([n, m]) => n === 'b' && m.type === 'world-block-refused')[1];
    assert.deepEqual(ref.edits, [5, 40, 5, -1]); assert.equal(ref.owner, 'a');
    assert.equal(edit(b, 5, 5, true).filter(([, m]) => m.type === 'world-block-refused').length, 1, 'blasts included');
    assert.equal(edit(b, 100, 5).filter(([, m]) => m.type === 'world-blocks').length, 3, 'unclaimed terrain is free (relayed to the other three)');
    assert.equal(edit(a, 5, 5).filter(([, m]) => m.type === 'world-blocks').length, 3, 'the owner edits');
    assert.equal(edit(boss, 5, 5).filter(([, m]) => m.type === 'world-blocks').length, 3, 'an admin edits');
    // the correction carries what the server holds, not the generated terrain
    r.blocks.handle(a, { type: 'world-blocks', level: 'r', edits: [6, 41, 6, 9], blast: false });
    assert.deepEqual(edit(b, 6, 6).find(([n, m]) => n === 'b' && m.type === 'world-block-refused')[1].edits, [6, 40, 6, -1]);
    const mark = r.log.length;
    r.blocks.handle(b, { type: 'world-blocks', level: 'r', edits: [6, 41, 6, 0, 100, 41, 6, 4], blast: false });
    const mixed = r.since(mark);
    assert.deepEqual(mixed.find(([n, m]) => n === 'b' && m.type === 'world-block-refused')[1].edits, [6, 41, 6, 9], 'a mixed message keeps the free half and corrects the rest with the server\'s value');
    assert.deepEqual(mixed.find(([n, m]) => n === 'a' && m.type === 'world-blocks')[1].edits, [100, 41, 6, 4]);
    r.social(a, { op: 'friend', name: 'b' });
    assert.equal(edit(b, 5, 5).filter(([, m]) => m.type === 'world-blocks').length, 3, 'a friend edits');
    assert.equal(edit(c, 5, 5).filter(([, m]) => m.type === 'world-blocks').length, 0, 'a stranger still may not');
    // personal claim lists
    const list = r.last('b', 'world-claims').claims.find(([x, z]) => x === 0 && z === 0);
    assert.deepEqual(list, [0, 0, 'a', 1, 0], 'allowed for the friend, not theirs');
    assert.deepEqual(r.last('c', 'world-claims').claims.find(([x, z]) => x === 0 && z === 0), [0, 0, 'a', 0, 0]);
    r.social(a, { op: 'unclaim', cx: 0, cz: 0 });
    assert.equal(edit(c, 5, 5).filter(([, m]) => m.type === 'world-blocks').length, 3, 'unclaimed is free again');
    // an owner who leaves keeps the claim five minutes
    r.leave(a);
    r.advance(ORPHAN_MS - 1000);
    assert.ok(r.claims.at('r', 16, 0));
    r.advance(2000);
    assert.ok(!r.claims.at('r', 16, 0), 'then it is freed');
    // a claim is scoped by level like everything else
    const other = r.join('o', { level: 'elsewhere' });
    assert.equal(edit(other, 20, 0).filter(([n, m]) => n === 'o' && m.type === 'world-block-refused').length, 0);
  }
}

export async function protectionSmoke(url, connect) {
  unit();
  const sockets = [];
  const open = async (level, nick, extra = {}) => {
    const c = connect(url); sockets.push(c);
    await c.opened; c.send({ type: 'hello', nick });
    await c.nextOf('hello-ok', `${nick} hello`);
    if (extra.login) { c.send({ type: 'login', ...extra.login }); await c.nextOf('auth-ok', `${nick} login`); }
    c.send({ type: 'world-join', level });
    c.you = (await c.nextOf('world-welcome', `${nick} welcome`)).you;
    c.level = level;
    return c;
  };
  const tx = (c, m) => c.send({ level: c.level, ...m });
  const note = async (c, code, label) => {
    for (let i = 0; i < 20; i++) { const m = await c.nextOf('world-social-note', label ?? code); if (m.code === code) return m; }
    throw new Error(`never saw note ${code}`);
  };
  try {
    // ---- props over real sockets
    const a = await open('prot-props', 'alpha'), b = await open('prot-props', 'bravo');
    const state = await b.nextOf('world-social', 'social state');
    assert.equal(state.protect, true, 'protection is on by default');
    tx(a, { type: 'world-prop-spawn', nonce: 1, kind: 'crate', scale: 1, pose: POSE });
    let p;
    do { p = (await a.nextOf('world-prop-spawn', 'spawn')).prop; } while (p.owner !== a.you);
    assert.equal(p.share, false);
    tx(b, { type: 'world-prop-claim', id: p.id, reason: 'hand' });
    const denied = await b.nextOf('world-prop-denied', 'stranger grab denied');
    assert.equal(denied.reason, 'protected'); assert.equal(denied.owner, 'alpha'); assert.equal(denied.id, p.id);
    tx(a, { type: 'world-social', op: 'friend', name: 'bravo' });
    assert.equal((await note(a, 'friend-added')).name, 'bravo');
    assert.equal((await note(b, 'friend-granted')).name, 'alpha');
    const granted = (await b.nextOf('world-social', 'friend state'));
    assert.ok(granted.grantedBy.includes(a.you) || (await b.nextOf('world-social', 'friend state 2')).grantedBy.includes(a.you), 'the friend is told');
    tx(b, { type: 'world-prop-claim', id: p.id, reason: 'hand' });
    let moving;
    do { moving = (await a.nextOf('world-prop-state', 'the owner is asked to hand it over')).props.find((q) => q.id === p.id); } while (!moving?.transfer);
    assert.equal(moving.transfer.to, b.you, 'a friend\'s grab goes through');
    tx(b, { type: 'world-social', op: 'protect', on: false });
    await note(b, 'not-host');

    // ---- claims and the correction, over real sockets
    const c1 = await open('prot-cube', 'carol'), c2 = await open('prot-cube', 'dave');
    tx(c1, { type: 'world-social', op: 'claim', cx: 0, cz: 0 });
    assert.equal((await note(c1, 'claimed')).n, 1);
    let list;
    do { list = await c2.nextOf('world-claims', 'claims reach the room'); } while (!list.claims.length);
    assert.deepEqual(list.claims[0], [0, 0, 'carol', 0, 0]);
    tx(c2, { type: 'world-blocks', edits: [5, 40, 5, 0], blast: false });
    const refused = await c2.nextOf('world-block-refused', 'the refused edit is answered');
    assert.deepEqual(refused.edits, [5, 40, 5, -1]); assert.equal(refused.owner, 'carol');
    tx(c2, { type: 'world-blocks', edits: [200, 40, 5, 3], blast: true });
    const seen = await c1.nextOf('world-blocks', 'only the free edit reached the owner');
    assert.deepEqual(seen.edits, [200, 40, 5, 3], 'the refused one was never relayed');
    tx(c1, { type: 'world-blocks', edits: [5, 40, 5, 0], blast: false });
    assert.deepEqual((await c2.nextOf('world-blocks', 'the owner edits her own claim')).edits, [5, 40, 5, 0]);

    // ---- vote-kick and the ban that follows it
    const v = [];
    for (const n of ['v1', 'v2', 'v3', 'v4']) v.push(await open('prot-vote', n));
    tx(v[0], { type: 'world-social', op: 'votekick', name: 'v4' });
    const start = await note(v[1], 'vote-start');
    assert.equal(start.need, 3); assert.equal(start.name, 'v4');
    tx(v[1], { type: 'world-social', op: 'vote', yes: true });
    tx(v[2], { type: 'world-social', op: 'vote', yes: true });
    const kicked = await v[3].nextOf('world-kicked', 'the target is removed');
    assert.ok(kicked.until > Date.now());
    v[3].send({ type: 'world-join', level: 'prot-vote' });
    assert.equal((await v[3].nextOf('world-kicked', 'and cannot come back')).level, 'prot-vote');

    // ---- admin mute, unmute, kick; and the non-admin refusals
    const boss = await open('prot-admin', 'boss', { login: { username: 'aleju', password: 'test-token' } });
    const y = await open('prot-admin', 'yolo');
    tx(y, { type: 'world-social', op: 'mute', name: 'boss' });
    await note(y, 'not-admin');
    tx(boss, { type: 'world-social', op: 'mute', name: 'yolo', minutes: 5 });
    await note(y, 'you-muted');
    y.send({ type: 'world-chat', text: 'hello?' });
    assert.equal((await y.nextOf('error', 'muted chat')).code, 'muted');
    tx(boss, { type: 'world-social', op: 'unmute', name: 'yolo' });
    await note(y, 'you-unmuted');
    y.send({ type: 'world-chat', text: 'hello again' });
    assert.equal((await boss.nextOf('world-chat', 'chat works again')).text, 'hello again');
    tx(boss, { type: 'world-social', op: 'kick', name: 'yolo' });
    await y.nextOf('world-kicked', 'admin kick');

    // ---- an account's friends persist in the database, a guest's do not
    const reg = async (name) => {
      const c = connect(url); sockets.push(c);
      await c.opened; c.send({ type: 'hello' }); await c.nextOf('hello-ok', 'reg hello');
      c.send({ type: 'register', username: name, password: 'hunter22' });
      await c.nextOf('auth-ok', 'registered');
      return c;
    };
    const jn = async (c, level) => { c.send({ type: 'world-join', level }); c.you = (await c.nextOf('world-welcome', 'welcome')).you; c.level = level; };
    const f1 = await reg('friendly-one'), f2 = await reg('friendly-two');
    await jn(f1, 'prot-friends'); await jn(f2, 'prot-friends');
    tx(f1, { type: 'world-social', op: 'friend', name: 'friendly-two' });
    await note(f1, 'friend-added');
    f1.ws.close();
    const back = connect(url); sockets.push(back);
    await back.opened; back.send({ type: 'hello' }); await back.nextOf('hello-ok', 'back hello');
    back.send({ type: 'login', username: 'friendly-one', password: 'hunter22' });
    await back.nextOf('auth-ok', 'relogin');
    await jn(back, 'prot-friends');
    let mine;
    do { mine = await back.nextOf('world-social', 'the stored list'); } while (!mine.friends.length);
    assert.deepEqual(mine.friends, ['friendly-two'], 'an account\'s friends survive a reconnect');
    tx(back, { type: 'world-social', op: 'unfriend', name: 'friendly-two' });
    await note(back, 'friend-removed');

    // ---- protection is per room: the same level in two private rooms and the public one
    const inRoom = async (room, nick) => {
      const c = connect(url); sockets.push(c);
      await c.opened; c.send({ type: 'hello', nick });
      await c.nextOf('hello-ok', `${nick} hello`);
      c.send({ type: 'world-join', level: 'prot-rooms', ...(room ? { room, create: true } : {}) });
      c.you = (await c.nextOf('world-welcome', `${nick} welcome`)).you;
      c.level = 'prot-rooms';
      return c;
    };
    const ra = await inRoom('PROTA1', 'rooma-owner'), rb = await inRoom('PROTA1', 'rooma-stranger');
    const sa = await inRoom('PROTB1', 'roomb-owner'), sb = await inRoom('PROTB1', 'roomb-stranger');
    const pub = await inRoom(undefined, 'roompub-owner'), pubStranger = await inRoom(undefined, 'roompub-stranger');
    const spawnOf = async (c) => {
      tx(c, { type: 'world-prop-spawn', nonce: 1, kind: 'crate', scale: 1, pose: POSE });
      let q;
      do { q = (await c.nextOf('world-prop-spawn', 'room spawn')).prop; } while (q.owner !== c.you);
      return q;
    };
    const grab = async (c, prop) => {
      tx(c, { type: 'world-prop-claim', id: prop.id, reason: 'hand' });
      return c.nextOf('world-prop-denied', 'room grab denied');
    };
    const pa = await spawnOf(ra);
    assert.equal((await grab(rb, pa)).reason, 'protected', 'a stranger cannot take a prop in room A');
    // switching protection off in room B (its host) leaves room A and the public room alone
    const sBefore = await sb.nextOf('world-social', 'room B state');
    assert.equal(sBefore.protect, true);
    tx(sa, { type: 'world-social', op: 'protect', on: false });
    await note(sa, 'protect-off');
    const pb = await spawnOf(sa);
    tx(sb, { type: 'world-prop-claim', id: pb.id, reason: 'hand' });
    let free;
    do { free = (await sa.nextOf('world-prop-state', 'B is free for all')).props.find((q) => q.id === pb.id); } while (!free?.transfer);
    assert.equal(free.transfer.to, sb.you, 'with protection off in room B a stranger may take it');
    assert.equal((await grab(rb, pa)).reason, 'protected', 'and room A is still protected');
    const pp = await spawnOf(pub);
    assert.equal((await grab(pubStranger, pp)).reason, 'protected', 'the public room keeps the default');
    // friends made in room A do not exist in room B or the public room
    tx(ra, { type: 'world-social', op: 'friend', name: 'roomb-stranger' });
    await note(ra, 'no-such-player');
    // claims in room A do not show up or bind in room B on the same level
    tx(ra, { type: 'world-social', op: 'claim', cx: 0, cz: 0 });
    assert.equal((await note(ra, 'claimed')).n, 1);
    tx(sb, { type: 'world-blocks', edits: [5, 40, 5, 0], blast: false });
    const relayed = await sa.nextOf('world-blocks', 'room B edits inside room A\'s claim are not refused');
    assert.deepEqual(relayed.edits, [5, 40, 5, 0]);
    tx(rb, { type: 'world-blocks', edits: [5, 40, 5, 0], blast: false });
    assert.equal((await rb.nextOf('world-block-refused', 'room A still refuses')).owner, 'rooma-owner');
    console.log('protection: owner/stranger/friend/admin, share, switch, caps, rate, orphans, claims with corrections, vote-kick, mute, kick and stored friends passed');
  } finally { for (const c of sockets) c.ws.close(); }
}
