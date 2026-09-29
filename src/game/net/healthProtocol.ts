/*
 * The health wire (server/src/health.js). The server owns the numbers: hit
 * points, who is dead, the pvp flag and the scoreboard. A client never says
 * how much anything hurt; it reports what only it can know (the speed it
 * landed at) and asks for the console's own verbs for itself.
 *
 * Server to client is coalesced: a burst of pellets is one `world-hp` per
 * tick with a row per changed player, and a row that says nothing changed is
 * never sent. Bounded everywhere: rows are at most one per player in the
 * level, a killfeed line carries the two scoreboard rows it changed.
 */

/** [id, hp, max, flags]: flags bit 0 is dead, bit 1 is spawn-protected */
export type HpRow = [number, number, number, number]
export const HP_DEAD = 1
export const HP_PROTECTED = 2

/** [id, kills, deaths, score] */
export type ScoreRow = [number, number, number, number]

/** what the killfeed says killed somebody. The server sanitizes any tag to
    /^[a-z][a-z0-9_]{0,15}$/, so a mode may invent its own; these are the
    ones the client knows how to phrase */
export const DEATH_KINDS = [
  'pistol', 'crossbow', 'rocket', 'blast', 'fall', 'lava', 'fire', 'mob', 'crash', 'kill', 'hurt', 'env',
] as const

export type HealthClientMessage =
  /** I landed at this speed (units/s, walker's `landing`). The server clamps
      it to the drop it watched me make and ignores anything under the safe
      landing, so an honest report is all it can be */
  | { type: 'world-fall'; speed: number }
  /** the console's verbs, for myself: `kill`, `hurt n`, `heal`, `god`, and the
      scope's `pvp`. heal and god are refused while pvp is on (admin excepted) */
  | { type: 'world-health-cmd'; cmd: 'kill' | 'heal' }
  | { type: 'world-health-cmd'; cmd: 'hurt'; n: number }
  | { type: 'world-health-cmd'; cmd: 'god' | 'pvp'; on: boolean }

export type HealthServerMessage =
  | { type: 'world-hp'; level: string; rows: HpRow[] }
  /** `by` is the killer (0: the environment or oneself), `sc` the scoreboard
      rows the death changed */
  | { type: 'world-death'; level: string; id: number; by: number; kind: string; sc: ScoreRow[] }
  /** back on your feet. Coordinates only when a mode chose the spot;
      otherwise the client uses its level's own spawn */
  | { type: 'world-respawn'; level: string; id: number; x?: number; z?: number }
  | { type: 'world-pvp'; level: string; on: boolean; by: number }
  /** the whole scoreboard of a level (on arrival, and empty after a reset) */
  | { type: 'world-scores'; level: string; rows: ScoreRow[] }
  /** a verb refused: `god` or `heal` in a fight */
  | { type: 'world-health-no'; cmd: string; reason: string }
