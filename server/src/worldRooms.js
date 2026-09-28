/*
 * The shared world's rooms. Until this existed there was one world per level;
 * now there is one world per (room, level), and this module owns the "room"
 * half: which rooms exist, who may enter, and when one is forgotten.
 *
 * Shape, and why. A room is a bag of players plus a complete, private set of
 * the relay's modules (props, effects, damage, blocks, weapons, the fleet).
 * index.js builds that set through the `build(room)` callback and hands each
 * module the ROOM's own `players` map instead of the process-wide one. Every
 * module already scopes itself by filtering `players` on `ws.world.level`, so
 * giving it a smaller map is the whole of the isolation: nothing about a
 * module changes, nothing on the wire changes (`level` stays the plain
 * level id, so clients, tests and the other modules' payloads are untouched),
 * and a module cannot leak across rooms because it has never been handed
 * anyone from another one. The alternative, a composite `room|level` string
 * in `ws.world.level`, had to be translated back at every nested `level`
 * field (portal pairs name a level inside the payload) and would have broken
 * the two modules that compare against literal level ids.
 *
 * The public room is built once at boot and never dies, so its behaviour is
 * exactly what the world was before rooms. Private rooms are made on demand
 * by a code, capped in number and in size, and vanish `graceMs` after the
 * last player leaves (long enough for a dropped connection to rejoin its own
 * room, short enough that codes do not pile up).
 *
 * Codes are 4-12 letters/digits, compared upper-case. The client mints them
 * (crypto.getRandomValues over CODE_ALPHABET, six long: ~887M codes) so it can
 * put the invite link on screen before the socket is even open; the server
 * only validates. Guessing is not a strategy: an unknown code is an error the
 * caller is rate-limited on.
 */

/** unambiguous when read aloud or off a screen: no 0/O, 1/I/L */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9]{4,12}$/;
export const PUBLIC_ROOM = 'public';

/** a room name off the wire -> 'public', a normalised code, or null if it is
    not something a room could be called. Absent means public. */
export function normalizeRoom(raw) {
  if (raw === undefined || raw === null) return PUBLIC_ROOM;
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code === '' || code === 'PUBLIC') return PUBLIC_ROOM;
  return CODE_RE.test(code) ? code : null;
}

/** sliding-window limiter over arbitrary keys (a socket, an IP), pruned so a
    scanner cycling addresses cannot grow it without bound */
export function createLimiter(max, windowMs, now = Date.now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    if (hits.size > 5000) {
      for (const [k, list] of hits) if (list.every((h) => t - h >= windowMs)) hits.delete(k);
    }
    const list = (hits.get(key) ?? []).filter((h) => t - h < windowMs);
    hits.set(key, list);
    if (list.length >= max) return false;
    list.push(t);
    return true;
  };
}

export function createWorldRooms({
  build,
  publicCap,
  privateCap = 16,
  maxRooms = 200,
  graceMs = 30_000,
  now = Date.now,
}) {
  const rooms = new Map();
  const make = (code, cap) => {
    const room = { code, isPublic: code === PUBLIC_ROOM, cap, players: new Map(), dirty: false, emptySince: code === PUBLIC_ROOM ? 0 : now(), createdAt: now() };
    build(room);
    rooms.set(code, room);
    return room;
  };
  const publicRoom = make(PUBLIC_ROOM, publicCap);

  function sweep() {
    for (const [code, room] of rooms) {
      if (room.isPublic || room.players.size > 0 || !room.emptySince) continue;
      if (now() - room.emptySince >= graceMs) {
        rooms.delete(code);
        room.dead = true;
      }
    }
  }

  return {
    publicRoom,
    get: (code) => rooms.get(code),
    get size() {
      return rooms.size;
    },
    [Symbol.iterator]: () => rooms.values(),

    /** find (or, with `create`, make) a room for a normalised code. Returns
        the room, or { error } with the wire error code. Fullness is checked
        here so the caller has a single "may I stand in it" answer. */
    open(code, create) {
      sweep();
      let room = rooms.get(code);
      if (!room) {
        if (!create) return { error: 'room_unknown' };
        if (rooms.size >= maxRooms) return { error: 'room_limit' };
        room = make(code, privateCap);
      }
      if (room.players.size >= room.cap) return { error: 'room_full' };
      room.emptySince = 0;
      return { room };
    },

    /** call after a player leaves; a private room that is now empty starts
        its clock, and is swept when it runs out */
    left(room) {
      if (room.isPublic || room.players.size > 0) return;
      room.emptySince = now() || 1;
      if (graceMs <= 0) return sweep();
      setTimeout(sweep, graceMs + 25).unref?.();
    },

    sweep,
  };
}
