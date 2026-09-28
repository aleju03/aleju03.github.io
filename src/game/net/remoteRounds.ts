import type { WorldServerMessage } from './protocol'
import type {
  RoundModeId, RoundPhase, RoundResult, RoundRow, RoundStateMessage, RoundServerMessage,
} from './roundProtocol'

/*
  The client's view of the round (server/src/rounds.js): what phase the room
  is in, the mode and its map, who is ready, the participants and their rows,
  the mode's public objective and the results. React-free and socket-free like
  the rest of src/game/net: the scene feeds it the server's messages, the HUD
  and the menus subscribe, the mode modules (src/game/modes) listen for its
  events, and a headless run can drive it with plain objects.

  It owns no rules. The server decides who is on which team, who won, whether
  a checkpoint counted; this remembers what it was told and turns changes into
  the few events the rest of the client reacts to:

    phase   the phase changed (lobby -> countdown -> playing -> results)
    go      change map: the round is on a level you are not on
    tp      put yourself here (a grid slot, a plot, back to where you hid)
    ev      a line of announcement (caught, found, finish, turn...)
    no      a command of ours was refused
    dg      somebody put on or took off a disguise

  Time. The server sends its clock next to every time it mentions, so this
  keeps one number, the offset between that clock and this machine's
  `performance.now()`, and answers in local milliseconds: `leftMs()` is what
  the timer shows, `localAt(serverMs)` places a moment such as the end of the
  hiding on this machine's clock. A message's latency (tens of ms) is not
  corrected for, which is far below anything a timer displays.
*/

export interface RoundPart {
  id: number
  team: string
  role: string
  score: number
  a: number
  b: number
  out: boolean
}

export type RoundEvent =
  | { type: 'phase'; from: RoundPhase; to: RoundPhase }
  | { type: 'go'; level: string; mode: RoundModeId; here: boolean }
  | { type: 'tp'; x: number; z: number; yaw: number }
  | { type: 'ev'; code: string; data: Record<string, unknown> }
  | { type: 'no'; cmd: string; reason: string; need?: number; have?: number }
  | { type: 'dg'; id: number; kind: string }

export interface RoundState {
  readonly phase: RoundPhase
  readonly mode: RoundModeId
  /** the level the mode runs on */
  readonly level: string
  readonly host: number
  readonly ready: ReadonlySet<number>
  readonly parts: readonly RoundPart[]
  readonly obj: Readonly<Record<string, unknown>>
  readonly debug: boolean
  readonly waiting: boolean
  readonly opt: Readonly<Record<string, number | boolean>>
  readonly result: RoundResult | null
  readonly disguises: ReadonlyMap<number, string>
  /** the server's ordering counter, for tests */
  readonly version: number
  /** our own player id (0 before the welcome) */
  readonly you: number
  /** we are the host */
  readonly isHost: boolean
  /** we have a row in the round */
  readonly mine: RoundPart | null
  /** the round is running and we are in it (countdown or play) */
  readonly inRound: boolean
  /** the round is running and we are not in it */
  readonly watching: boolean
  /** ms until the current phase ends, on this machine (0 in the lobby) */
  leftMs: () => number
  /** a server time (an `obj` key ending in At, or a phase end) as this machine's performance.now() */
  localAt: (serverMs: number) => number
  /** ms from now until a server time (negative once it has passed) */
  untilAt: (serverMs: number) => number
  /** an `obj` number by key (0 when absent) */
  num: (key: string) => number
  partOf: (id: number) => RoundPart | null
  /** how many are on a team */
  teamSize: (team: string) => number
  receive: (m: WorldServerMessage) => void
  subscribe: (fn: () => void) => () => void
  on: (fn: (e: RoundEvent) => void) => () => void
  /** the socket went down: forget the round */
  offline: () => void
}

export function createRoundState(opts: { now?: () => number } = {}): RoundState {
  const now = opts.now ?? (() => performance.now())
  let you = 0
  let phase: RoundPhase = 'lobby'
  let mode: RoundModeId = 'deathmatch'
  let level = 'nuketown'
  let host = 0
  let ready = new Set<number>()
  let parts: RoundPart[] = []
  let obj: Record<string, unknown> = {}
  let debug = false
  let waiting = false
  let opt: Record<string, number | boolean> = {}
  let result: RoundResult | null = null
  let disguises = new Map<number, string>()
  let version = 0
  let skew = 0
  let end = 0
  const subs = new Set<() => void>()
  const fns = new Set<(e: RoundEvent) => void>()
  const emit = (e: RoundEvent) => {
    for (const fn of fns) fn(e)
  }
  const changed = () => {
    for (const fn of subs) fn()
  }
  const partOf = (id: number) => parts.find((p) => p.id === id) ?? null

  const applyState = (m: RoundStateMessage) => {
    version = m.v
    // server clock -> ours: a local time is a server time plus this
    skew = now() - m.now
    const before = phase
    phase = m.ph
    mode = m.mode
    level = m.lv
    host = m.host
    ready = new Set(m.rd)
    parts = m.p.map((r: RoundRow) => ({
      id: r[0], team: r[1], role: r[2], score: r[3], a: r[4], b: r[5], out: r[6] === 1,
    }))
    obj = m.obj ?? {}
    debug = m.dbg === 1
    waiting = m.w === 1
    opt = m.opt ?? {}
    result = m.res ?? null
    disguises = new Map(m.dg ?? [])
    end = m.end
    if (before !== phase) emit({ type: 'phase', from: before, to: phase })
    changed()
  }

  const state: RoundState = {
    get phase() { return phase },
    get mode() { return mode },
    get level() { return level },
    get host() { return host },
    get ready() { return ready },
    get parts() { return parts },
    get obj() { return obj },
    get debug() { return debug },
    get waiting() { return waiting },
    get opt() { return opt },
    get result() { return result },
    get disguises() { return disguises },
    get version() { return version },
    get you() { return you },
    get isHost() { return you !== 0 && you === host },
    get mine() { return partOf(you) },
    get inRound() { return (phase === 'countdown' || phase === 'playing') && partOf(you) !== null },
    get watching() { return (phase === 'countdown' || phase === 'playing') && partOf(you) === null },
    leftMs: () => (end > 0 ? Math.max(0, end + skew - now()) : 0),
    localAt: (serverMs) => serverMs + skew,
    untilAt: (serverMs) => serverMs + skew - now(),
    num: (key) => (typeof obj[key] === 'number' ? (obj[key] as number) : 0),
    partOf,
    teamSize: (team) => parts.filter((p) => p.team === team).length,
    receive(m) {
      switch (m.type) {
        case 'world-welcome':
          you = m.you
          return
        case 'world-round':
          applyState(m as RoundStateMessage)
          return
        case 'world-round-go': {
          const g = m as Extract<RoundServerMessage, { type: 'world-round-go' }>
          emit({ type: 'go', level: g.level, mode: g.mode, here: g.here === 1 })
          return
        }
        case 'world-round-tp': {
          const t = m as Extract<RoundServerMessage, { type: 'world-round-tp' }>
          emit({ type: 'tp', x: t.x, z: t.z, yaw: t.yaw })
          return
        }
        case 'world-round-ev': {
          const { code, type: _t, ...data } = m as Extract<RoundServerMessage, { type: 'world-round-ev' }>
          void _t
          emit({ type: 'ev', code, data })
          return
        }
        case 'world-round-dg': {
          const d = m as Extract<RoundServerMessage, { type: 'world-round-dg' }>
          if (d.kind) disguises.set(d.id, d.kind)
          else disguises.delete(d.id)
          emit({ type: 'dg', id: d.id, kind: d.kind })
          changed()
          return
        }
        case 'world-round-no': {
          const n = m as Extract<RoundServerMessage, { type: 'world-round-no' }>
          emit({ type: 'no', cmd: n.cmd, reason: n.reason, need: n.need, have: n.have })
          return
        }
        case 'world-exit':
          if (disguises.delete(m.id)) changed()
          return
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
    offline() {
      you = 0
      const before = phase
      phase = 'lobby'
      ready = new Set()
      parts = []
      obj = {}
      result = null
      disguises = new Map()
      waiting = false
      end = 0
      version = 0
      if (before !== 'lobby') emit({ type: 'phase', from: before, to: 'lobby' })
      changed()
    },
  }
  return state
}
