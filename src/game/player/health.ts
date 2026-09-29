import type { WorldServerMessage } from '../net/protocol'
import { HP_DEAD, HP_PROTECTED, type ScoreRow } from '../net/healthProtocol'

/*
  The client's view of hit points: our own, everyone else's, whether this
  level is a fight (pvp), the killfeed and the scoreboard. React-free and
  socket-free like the rest of src/game/net: the scene feeds it the server's
  messages and reads it back, the HUD and the sounds subscribe to it, and a
  headless run can drive it with plain objects.

  The server owns every number (server/src/health.js). This module never
  computes damage; it remembers what it was told, and turns changes into the
  three things the rest of the client reacts to: a `hurt` (our own hit points
  went down: the red flash, the grunt), `died` (the flop, the death screen,
  the countdown) and `respawn` (stand up, go to the level's spawn). Rows for
  other players only feed their name plates' health pip.

  Everything is scoped to the level the walker is in: a message for another
  level (a late one from before a seam) is dropped. Offline the state is
  simply whole and quiet, which is also what a level with pvp off looks like,
  so the HUD shows nothing until something has happened.
*/

/** mirrors RESPAWN_MS in server/src/health.js: only the countdown's length,
    the respawn itself waits for the server's word */
export const RESPAWN_S = 3
export const FEED_MAX = 5
export const FEED_LIFE_MS = 7000
/** below this share of the maximum the screen breathes red */
export const LOW_SHARE = 0.3

export interface Vitals {
  hp: number
  max: number
  dead: boolean
  protectedNow: boolean
}

export interface KillLine {
  key: number
  victim: number
  by: number
  kind: string
  at: number
  /** we were the victim / the killer */
  mineOut: boolean
  mineIn: boolean
}

export type HealthEvent =
  | { type: 'hurt'; amount: number; hp: number }
  | { type: 'died'; by: number; kind: string }
  | { type: 'respawn'; x?: number; z?: number }
  | { type: 'pvp'; on: boolean; by: number }
  | { type: 'kill'; line: KillLine }
  | { type: 'refused'; cmd: string; reason: string }

export interface HealthState {
  readonly hp: number
  readonly max: number
  readonly dead: boolean
  /** performance.now() ms at which the respawn is expected */
  readonly respawnAt: number
  readonly protectedNow: boolean
  readonly pvp: boolean
  /** 0..1, the red flash of a hit, decaying */
  readonly flash: number
  readonly low: boolean
  /** who killed us, while dead (0: the environment) */
  readonly killer: number
  readonly killedBy: string
  readonly feed: readonly KillLine[]
  readonly scores: ReadonlyMap<number, ScoreRow>
  /** true once anything has made the bar worth drawing: pvp on, or hurt */
  readonly engaged: boolean
  vitalsOf: (id: number) => Vitals | null
  /** whole seconds until the expected respawn, for the countdown */
  respawnIn: () => number
  receive: (m: WorldServerMessage) => void
  /** call every frame */
  tick: (dt: number) => void
  /** any visible change (hp, pvp, feed): the HUD's redraw */
  subscribe: (fn: () => void) => () => void
  on: (fn: (e: HealthEvent) => void) => () => void
  /** we walked into another level: the others' hit points there arrive fresh */
  newLevel: () => void
  /** the socket went down / we left: forget everybody, stand down */
  offline: () => void
}

export function createHealthState(opts: { level: () => string; now?: () => number }): HealthState {
  const now = opts.now ?? (() => performance.now())
  let you = 0
  let hp = 100
  let max = 100
  let dead = false
  let respawnAt = 0
  let prot = false
  let pvp = false
  let flash = 0
  let killer = 0
  let killedBy = ''
  let hurtOnce = false
  let key = 0
  let feed: KillLine[] = []
  const remote = new Map<number, Vitals>()
  const scores = new Map<number, ScoreRow>()
  const subs = new Set<() => void>()
  const fns = new Set<(e: HealthEvent) => void>()
  const emit = (e: HealthEvent) => {
    for (const fn of fns) fn(e)
  }
  const changed = () => {
    for (const fn of subs) fn()
  }

  const setMine = (row: [number, number, number, number]) => {
    const [, nhp, nmax, flags] = row
    const wasDead = dead
    const before = hp
    hp = nhp
    max = nmax || 100
    prot = (flags & HP_PROTECTED) !== 0
    dead = (flags & HP_DEAD) !== 0
    if (!dead && nhp < before && !wasDead) {
      const amount = before - nhp
      flash = Math.min(1, flash + 0.35 + amount / 60)
      hurtOnce = true
      emit({ type: 'hurt', amount, hp: nhp })
    }
  }

  const state: HealthState = {
    get hp() { return hp },
    get max() { return max },
    get dead() { return dead },
    get respawnAt() { return respawnAt },
    get protectedNow() { return prot },
    get pvp() { return pvp },
    get flash() { return flash },
    get low() { return !dead && hp / max < LOW_SHARE },
    get killer() { return killer },
    get killedBy() { return killedBy },
    get feed() { return feed },
    get scores() { return scores },
    get engaged() { return pvp || hurtOnce || dead || hp < max },
    respawnIn: () => Math.max(0, Math.ceil((respawnAt - now()) / 1000)),
    vitalsOf: (id) => (id === you ? { hp, max, dead, protectedNow: prot } : (remote.get(id) ?? null)),
    receive(m) {
      switch (m.type) {
        case 'world-welcome':
          you = m.you
          return
        case 'world-exit':
          remote.delete(m.id)
          scores.delete(m.id)
          return
        case 'world-enter':
          return
        case 'world-hp': {
          if (m.level !== opts.level()) return
          for (const row of m.rows) {
            if (row[0] === you) setMine(row)
            else if (remote.size < 256) {
              remote.set(row[0], {
                hp: row[1], max: row[2] || 100, dead: (row[3] & HP_DEAD) !== 0, protectedNow: (row[3] & HP_PROTECTED) !== 0,
              })
            }
          }
          changed()
          return
        }
        case 'world-death': {
          if (m.level !== opts.level()) return
          for (const r of m.sc) scores.set(r[0], r)
          const line: KillLine = {
            key: key++, victim: m.id, by: m.by, kind: m.kind, at: now(),
            mineOut: m.id === you, mineIn: m.by === you && m.id !== you,
          }
          feed = [...feed, line].slice(-FEED_MAX)
          if (m.id === you) {
            dead = true
            hp = 0
            respawnAt = now() + RESPAWN_S * 1000
            killer = m.by
            killedBy = m.kind
            emit({ type: 'died', by: m.by, kind: m.kind })
          } else {
            const v = remote.get(m.id)
            if (v) v.dead = true
          }
          emit({ type: 'kill', line })
          changed()
          return
        }
        case 'world-respawn': {
          if (m.level !== opts.level()) return
          if (m.id === you) {
            dead = false
            emit({ type: 'respawn', x: m.x, z: m.z })
          } else {
            const v = remote.get(m.id)
            if (v) v.dead = false
          }
          changed()
          return
        }
        case 'world-pvp':
          if (m.level !== opts.level()) return
          pvp = m.on
          emit({ type: 'pvp', on: m.on, by: m.by })
          changed()
          return
        case 'world-scores':
          if (m.level !== opts.level()) return
          scores.clear()
          for (const r of m.rows) scores.set(r[0], r)
          changed()
          return
        case 'world-health-no':
          emit({ type: 'refused', cmd: m.cmd, reason: m.reason })
          return
      }
    },
    tick(dt) {
      // (the HUD flashes off the 'hurt' event with a CSS animation; this
      // number is for anything that wants the envelope itself)
      if (flash > 0) flash = Math.max(0, flash - dt * 1.6)
      const t = now()
      if (feed.length && t - feed[0].at > FEED_LIFE_MS) {
        feed = feed.filter((l) => t - l.at <= FEED_LIFE_MS)
        changed()
      }
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    on(fn) {
      fns.add(fn)
      return () => fns.delete(fn)
    },
    newLevel() {
      remote.clear()
      scores.clear()
      feed = []
      changed()
    },
    offline() {
      you = 0
      hp = max = 100
      dead = false
      prot = false
      pvp = false
      flash = 0
      hurtOnce = false
      feed = []
      remote.clear()
      scores.clear()
      changed()
    },
  }
  return state
}
