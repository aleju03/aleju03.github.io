/*
 * The rounds' wire (server/src/rounds.js). A round is a goal laid over the
 * shared walk: a lobby, a countdown, play and a results sheet, all decided by
 * the server. Clients ask with one message (`world-round-cmd`) and are told
 * with five, and nothing here is state a client may invent.
 *
 * `world-round` is the whole picture, sent to everyone in the room whenever a
 * screen would change (the server coalesces it to ~2.5 a second while play
 * goes on): phase, mode, the level it runs on, the host, who is ready, the
 * participants' rows and the mode's public objective. Times ride as the
 * server's clock: `end` and every `obj` key ending in `At` are server ms, and
 * `now` is the server's clock when it was sent, so a client counts down with
 * `end - now` and never needs its own clock to agree with the server's.
 *
 * Bounded: at most 16 participants, rows of seven small numbers, an `obj`
 * of a handful of keys, `dg` only for disguised players.
 */

export type RoundPhase = 'lobby' | 'countdown' | 'playing' | 'results'

/** the ids of server/src/roundModes.js's table; src/game/modes/defs.ts has the words */
export const ROUND_MODES = ['deathmatch', 'prophunt', 'hide', 'race', 'build'] as const
export type RoundModeId = (typeof ROUND_MODES)[number]

/** [id, team ('' none, 'a' or 'b'), role ('' none), score, a, b, out]
    a and b mean what the mode says: kills and deaths, tags and seconds
    survived, checkpoints passed and the finish time in ms, votes received */
export type RoundRow = [number, string, string, number, number, number, number]

/** [id, team, score, a, b], best first */
export type RoundResultRow = [number, string, number, number, number]

export interface RoundResult {
  /** the winners' ids (empty: a draw, or nobody) */
  win: number[]
  /** the winning team or side ('a', 'b') when it was a team result */
  team: string
  /** why it ended: limit, time, last, hunted, survived, done, abandoned, stopped */
  why: string
  rows: RoundResultRow[]
  note?: string
}

export interface RoundStateMessage {
  type: 'world-round'
  /** a counter, for a client that wants to drop a stale copy */
  v: number
  ph: RoundPhase
  mode: RoundModeId
  /** the level the mode runs on */
  lv: string
  now: number
  /** the end of the current phase (server ms); 0 in the lobby */
  end: number
  host: number
  /** the ids that have pressed ready */
  rd: number[]
  p: RoundRow[]
  /** the mode's public data (courses, plots, the theme, the hiding time...) */
  obj: Record<string, unknown>
  dbg?: 1
  /** the countdown is waiting for someone to arrive on the map */
  w?: 1
  /** host-tunable settings */
  opt?: Record<string, number | boolean>
  /** [id, prop kind] for the disguised */
  dg?: Array<[number, string]>
  res?: RoundResult
}

export type RoundServerMessage =
  | RoundStateMessage
  /** change map to `level` (the cut runs on the client); `here` when already there */
  | { type: 'world-round-go'; level: string; mode: RoundModeId; here?: 1 }
  /** put yourself here (the level you are on is `level`) */
  | { type: 'world-round-tp'; level: string; x: number; z: number; yaw: number }
  /** a line of announcement, phrased by the client from `code` */
  | { type: 'world-round-ev'; code: string; [k: string]: unknown }
  | { type: 'world-round-dg'; id: number; kind: string }
  | { type: 'world-round-no'; cmd: string; reason: string; need?: number; have?: number }

export type RoundClientMessage =
  | { type: 'world-round-cmd'; cmd: 'mode'; mode: RoundModeId; level?: string }
  | { type: 'world-round-cmd'; cmd: 'opt'; key: string; value: number | boolean }
  | { type: 'world-round-cmd'; cmd: 'ready'; on: boolean }
  | { type: 'world-round-cmd'; cmd: 'debug'; on: boolean }
  | { type: 'world-round-cmd'; cmd: 'start' | 'stop' | 'join' }
  /** prop hunt: become this catalogue kind ('' to be yourself again) */
  | { type: 'world-round-cmd'; cmd: 'disguise'; kind: string }
  /** hide and seek: a punch at arm's length */
  | { type: 'world-round-cmd'; cmd: 'tag'; target: number }
  /** race: I passed checkpoint `i` (the running count) at x, z */
  | { type: 'world-round-cmd'; cmd: 'cp'; i: number; x: number; z: number }
  /** build contest: my mark for the plot on show, 1..5 */
  | { type: 'world-round-cmd'; cmd: 'vote'; n: number }
