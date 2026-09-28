import { useSyncExternalStore } from 'react'
import { WORLD_PATH } from '../../version'

/*
  Which room the shared walk is in: a tiny subscribable store, in the same
  family as roamPrefs / osYear / sounds.

  A room is either the public world (the default, `code === null`) or a
  private one named by a short code that only people who were given it can
  enter (server/src/worldRooms.js is the other half). This module owns four
  things and nothing else:

  - **The decision**, before any socket exists. The code arrives from a
    `?room=CODE` link (read once, lazily, so the module costs nothing on the
    desktop-only routes), or from the map sheet's room strip, or from the
    pause sheet's "leave". `wanted()` is what worldNet reads on *every* join,
    including reconnects, which is what makes a dropped connection land you
    back in your own room rather than in public.
  - **Whether to create.** A code from a link or one this player minted may
    open a room that does not exist yet (an invite stays good after the room
    emptied and was forgotten); a code someone typed by hand may not, so a
    typo is an error rather than a fresh empty room. Once the server has
    welcomed us into a room it is ours, and reconnects may recreate it.
  - **When it changes.** CrtScene joins the moment the walk begins, which is
    before the map sheet is answered (harnesses and the stand-up glide both
    depend on the roster landing early), so a link's room is joined
    directly and a room chosen on the sheet is a clean leave-and-join.
  - **What the server said**: the room we are actually in (`live`) and the
    last refusal (`error`), so the chip, the sheet and the strip all read the
    same truth.

  The codes are minted here, not by the server, so the invite link can be on
  screen the instant "create" is pressed. They are six characters of an
  alphabet with no lookalikes, from crypto.getRandomValues.
*/

/** mirrors server/src/worldRooms.js's CODE_ALPHABET: no 0/O, 1/I/L */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LEN = 6
/** the server accepts 4-12 letters and digits; the strip accepts the same */
const CODE_RE = /^[A-Z0-9]{4,12}$/

export type RoomError = 'unknown' | 'full' | 'limit' | 'rate'

export interface RoomState {
  /** the room we want to be in: null is the public world */
  code: string | null
  /** may joining this code open a room that does not exist yet */
  create: boolean
  /** the room the server put us in: 'public', a code, or null while offline */
  live: string | null
  /** the server's last refusal, until dismissed or the next join succeeds */
  error: RoomError | null
}

let state: RoomState = { code: null, create: false, live: null, error: null }
let read = false
const listeners = new Set<() => void>()

/** a raw string (a link parameter, a text field) as a code, or null */
export function parseRoomCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const code = raw.trim().toUpperCase().replace(/[\s-]+/g, '')
  return CODE_RE.test(code) ? code : null
}

export function mintRoomCode(): string {
  const bytes = new Uint8Array(CODE_LEN)
  crypto.getRandomValues(bytes)
  let code = ''
  // 256 % 31 is not zero, so a plain modulo would favour the first few
  // letters by a hair; a rejection loop is not worth six characters, and the
  // bias costs a fraction of a bit
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length]
  return code
}

/** the link that puts whoever opens it in this room, straight to the map sheet */
export function inviteUrl(code: string): string {
  return `${location.origin}${WORLD_PATH}?room=${encodeURIComponent(code)}`
}

function emit() {
  for (const l of listeners) l()
}

function set(next: Partial<RoomState>) {
  state = { ...state, ...next }
  emit()
}

/** the first read looks at the address bar, once */
function ensureRead() {
  if (read) return
  read = true
  try {
    const code = parseRoomCode(new URLSearchParams(location.search).get('room'))
    if (code) state = { ...state, code, create: true }
  } catch {
    /* no location (tests, SSR): public */
  }
}

export function getRoomState(): RoomState {
  ensureRead()
  return state
}

export function subscribeRoom(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useWorldRoom(): RoomState {
  return useSyncExternalStore(subscribeRoom, getRoomState, getRoomState)
}

/** what worldNet sends with `world-join`, read on every (re)join */
export function roomWanted(): { room?: string; create?: boolean } {
  const s = getRoomState()
  return s.code ? { room: s.code, create: s.create } : {}
}

/** make a private room of our own. Returns its code */
export function createPrivateRoom(): string {
  const code = mintRoomCode()
  set({ code, create: true, error: null })
  return code
}

/** enter a code somebody gave us. False when it is not shaped like one; a
    well-formed code that names nothing is the server's `room_unknown` */
export function joinRoomCode(raw: string): boolean {
  const code = parseRoomCode(raw)
  if (!code) return false
  set({ code, create: false, error: null })
  return true
}

export function leaveToPublic() {
  set({ code: null, create: false, error: null })
}

export function dismissRoomError() {
  if (state.error) set({ error: null })
}

/** worldNet: the server welcomed us into `name` */
export function confirmRoom(name: string) {
  const code = name === 'public' ? null : name
  // a room we have stood in is ours to reopen after a dropped connection
  set({ live: name, error: null, ...(code && code === state.code ? { create: true } : {}) })
}

/** worldNet: the socket is gone, so we are in no room */
export function roomOffline() {
  if (state.live !== null) set({ live: null })
}

/** worldNet: the server refused the join. The walk falls back to public and
    says why */
export function failRoom(error: RoomError) {
  set({ code: null, create: false, error })
}
