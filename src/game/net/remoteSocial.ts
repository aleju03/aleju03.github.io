/*
 * The browser's copy of "who may touch whose things", without sockets or
 * React. The server decides (server/src/protection.js and claims.js); this
 * mirrors its last word for the level you are standing in so the game can
 * refuse an action before making it (the physgun's denied buzz, Cubeland
 * declining to dig in somebody's claim) instead of doing it and being
 * corrected a round trip later. A mirror can be stale, which is why the
 * server checks everything again and why nothing here is ever a security
 * boundary.
 *
 * It also owns the words. A server notice is a code and some numbers
 * (socialProtocol.ts); `describe` turns it into a line in both languages,
 * and the scene decides where the line goes: a system line in the chat rail
 * for a vote, a quiet toast for a refusal.
 */
import type { SocialAsk, SocialClientMessage, SocialServerMessage, SocialNoteCode } from './socialProtocol'
import type { WorldServerMessage } from './protocol'

export interface ClaimRow {
  cx: number
  cz: number
  owner: string
  /** may I edit here (mine, a friend's, or I am the admin) */
  allowed: boolean
  mine: boolean
}
export interface Line { en: string; es: string }

export interface SocialNetwork {
  receive: (m: WorldServerMessage) => void
  setLevel: (name: string) => void
  offline: () => void
  /** protection is on in this scope */
  readonly protect: boolean
  /** the names I have granted */
  readonly friends: readonly string[]
  /** the scope's first player, who may flip the switch (a world id) */
  readonly host: number
  /** may I use a prop of this owner; the server's answer wins in the end */
  may: (owner: number, share?: boolean) => boolean
  /** the claim on a block column, if any */
  claimAt: (bx: number, bz: number) => ClaimRow | null
  readonly claims: readonly ClaimRow[]
  /** would an edit at this block column be refused */
  blocked: (bx: number, bz: number) => ClaimRow | null
  send: (m: SocialAsk) => void
  onChange: (fn: () => void) => () => void
}

interface Scope {
  protect: boolean
  host: number
  friends: string[]
  grantedBy: Set<number>
  claims: Map<string, ClaimRow>
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)

/** a server notice as a line, or null for the ones that only change state */
export function describe(m: Extract<SocialServerMessage, { type: 'world-social-note' }>): Line | null {
  const name = m.name ?? '?'
  const n = m.n ?? 0
  const table: Partial<Record<SocialNoteCode, Line>> = {
    'friend-added': { en: `${name} may now use your things`, es: `${name} ya puede usar tus cosas` },
    'friend-granted': { en: `${name} lets you use their things`, es: `${name} te deja usar sus cosas` },
    'friend-removed': { en: `${name} can no longer use your things`, es: `${name} ya no puede usar tus cosas` },
    'friend-none': { en: `${name} is not on your list`, es: `${name} no está en tu lista` },
    'friend-self': { en: 'that is you', es: 'ese eres tú' },
    'friend-already': { en: `${name} is already on your list`, es: `${name} ya está en tu lista` },
    'friend-full': { en: `friend list full (${n})`, es: `lista de amigos llena (${n})` },
    'protect-on': { en: `${name} turned protection on: things belong to whoever made them`, es: `${name} activó la protección: cada cosa es de quien la hizo` },
    'protect-off': { en: `${name} turned protection off: free for all`, es: `${name} desactivó la protección: todo es de todos` },
    'not-host': { en: 'only the first player here or an admin can do that', es: 'solo el primer jugador de aquí o un administrador puede hacerlo' },
    'not-admin': { en: 'admins only', es: 'solo administradores' },
    'no-such-player': { en: `nobody called "${name}" here`, es: `nadie llamado "${name}" aquí` },
    slow: { en: 'slow down', es: 'más despacio' },
    'vote-start': {
      en: `${m.by} started a vote to kick ${name}. /yes or /no in ${m.secs}s (${m.need} of ${m.n} needed)`,
      es: `${m.by} propone expulsar a ${name}. /yes o /no en ${m.secs}s (hacen falta ${m.need} de ${m.n})`,
    },
    'vote-pass': { en: `vote passed: ${name} is out for 10 minutes (${m.yes}/${m.n})`, es: `votación aprobada: ${name} queda fuera 10 minutos (${m.yes}/${m.n})` },
    'vote-fail': { en: `vote failed: ${name} stays (${m.yes}/${m.n})`, es: `votación rechazada: ${name} se queda (${m.yes}/${m.n})` },
    'vote-busy': { en: 'a vote is already open', es: 'ya hay una votación abierta' },
    'vote-cooldown': { en: 'wait a minute before opening another vote', es: 'espera un minuto antes de abrir otra votación' },
    'vote-self': { en: 'you cannot vote yourself out', es: 'no puedes votar contra ti' },
    'vote-admin': { en: 'that player cannot be voted out', es: 'a ese jugador no se le puede votar' },
    'vote-few': { en: `a vote needs at least ${n} other players here`, es: `una votación necesita al menos ${n} jugadores más aquí` },
    'vote-none': { en: 'no vote is open', es: 'no hay ninguna votación abierta' },
    'vote-target': { en: 'the vote is about you: you do not get one', es: 'la votación es sobre ti: no votas' },
    'vote-counted': { en: `counted: ${m.yes} yes, ${m.no} no (${m.need} yes needed)`, es: `contado: ${m.yes} sí, ${m.no} no (hacen falta ${m.need} síes)` },
    kicked: { en: `${name} was removed by an admin`, es: `${name} fue expulsado por un administrador` },
    muted: { en: `${name} muted for ${n} ${plural(n, 'minute')}`, es: `${name} silenciado ${n} ${plural(n, 'minuto')}` },
    'you-muted': { en: `you are muted for ${n} ${plural(n, 'minute')}`, es: `estás silenciado ${n} ${plural(n, 'minuto')}` },
    unmuted: { en: `${name} can talk again`, es: `${name} puede hablar otra vez` },
    'you-unmuted': { en: 'you can talk again', es: 'puedes hablar otra vez' },
    claimed: { en: `claimed this chunk (${n} of ${m.max})`, es: `reclamaste este chunk (${n} de ${m.max})` },
    unclaimed: { en: 'released this chunk', es: 'soltaste este chunk' },
    'claim-none': { en: 'this chunk is not claimed', es: 'este chunk no está reclamado' },
    'claim-yours': { en: 'this chunk is already yours', es: 'este chunk ya es tuyo' },
    'claim-taken': { en: `this chunk belongs to ${name}`, es: `este chunk es de ${name}` },
    'claim-full': { en: `you can hold ${n} chunks: /unclaim one first`, es: `puedes tener ${n} chunks: suelta uno con /unclaim` },
  }
  return table[m.code] ?? null
}

export function createSocialNetwork(
  send: (m: SocialClientMessage) => void,
  opts: { admin?: () => boolean } = {},
): SocialNetwork {
  const scopes = new Map<string, Scope>()
  const listeners = new Set<() => void>()
  let active = ''
  let you = 0
  const scope = (name: string): Scope => {
    let s = scopes.get(name)
    if (!s) scopes.set(name, (s = { protect: true, host: 0, friends: [], grantedBy: new Set(), claims: new Map() }))
    return s
  }
  const here = () => scope(active)
  const changed = () => { for (const fn of listeners) fn() }
  const chunk = (n: number) => Math.floor(n / 16)
  const key = (cx: number, cz: number) => `${cx},${cz}`

  const claimAt = (bx: number, bz: number) => here().claims.get(key(chunk(bx), chunk(bz))) ?? null

  return {
    receive: (m) => {
      if (m.type === 'world-welcome') { you = m.you; return }
      const t = m.type
      if (t !== 'world-social' && t !== 'world-claims') return
      const msg = m as Extract<SocialServerMessage, { type: 'world-social' | 'world-claims' }>
      // (the first join names the level; after that the scene's seams do)
      if (!active) active = msg.level
      const s = scope(msg.level)
      if (msg.type === 'world-social') {
        s.protect = msg.protect
        s.host = msg.host
        s.friends = msg.friends
        s.grantedBy = new Set(msg.grantedBy)
      } else {
        s.claims = new Map(msg.claims.map(([cx, cz, owner, allowed, mine]) => [key(cx, cz), { cx, cz, owner, allowed: allowed === 1, mine: mine === 1 }]))
      }
      changed()
    },
    setLevel: (name) => { active = name; changed() },
    offline: () => { scopes.clear(); you = 0; changed() },
    get protect() { return here().protect },
    get friends() { return here().friends },
    get host() { return here().host },
    may: (owner, share = false) => {
      const s = here()
      return !s.protect || share || owner === you || s.grantedBy.has(owner) || (opts.admin?.() ?? false)
    },
    claimAt,
    get claims() { return [...here().claims.values()] },
    blocked: (bx, bz) => {
      const c = claimAt(bx, bz)
      return c && !c.allowed ? c : null
    },
    send: (m) => send({ type: 'world-social', level: active, ...m } as SocialClientMessage),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
}
