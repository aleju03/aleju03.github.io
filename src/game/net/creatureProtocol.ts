/*
 * The creature wire (server/src/creatures.js). One client per scope simulates
 * the creatures, the HOST, and everyone else draws what it says. The server
 * simulates nothing: it designates the host (the longest-present player in the
 * room and level, reassigned when they leave), relays the host's snapshots,
 * keeps a bounded copy only so a late joiner or a new host has something to
 * start from, and stands between the two things clients cannot settle between
 * themselves: damage to a creature (any client to the host, checked for range
 * and rate) and damage by a creature to a person (the host's report, checked
 * against the creature's last reported position, a cooldown and a per-scope
 * rate, then applied through the health system).
 *
 * A snapshot row is eight numbers, integers so the JSON stays short:
 *
 *   [id, kind, x*10, y*10, z*10, yaw*100, hp, flags]
 *
 * `kind` is kinds.ts's append-only index, `hp` the rounded hit points, and
 * `flags` packs the state in its low three bits (sim.ts's `S`: 0 idle, 1 walk,
 * 2 flee, 3 chase, 4 act, 5 dead) with `ROW_HURT` and `ROW_BURN` above them.
 * An arrow is a creature of kind 7: its yaw and its motion say the rest.
 * Everything is bounded: at most `MAX_ROWS` rows, coordinates clamped, ids
 * 1..65000.
 */

export const CREATURE_HZ = 8
export const MAX_ROWS = 64
export const ROW_STATE = 7
export const ROW_HURT = 8
export const ROW_BURN = 16

/** [id, kind, x10, y10, z10, yaw100, hp, flags] */
export type CreatureRow = [number, number, number, number, number, number, number, number]

/** how a mob hurt a person, as the host reports it */
export const ATTACK = { melee: 0, arrow: 1, blast: 2 } as const
export type AttackId = (typeof ATTACK)[keyof typeof ATTACK]

/** the console's verbs for the scope's creatures (admin or the host only) */
export type CreatureCmd = 'on' | 'off' | 'clear' | 'peaceful' | 'war'

export type CreatureClientMessage =
  /** the host's snapshot of every creature in the level */
  | { type: 'world-creatures'; level: string; rows: CreatureRow[] }
  /** a creature died (host only): who is told, so all hear it and see the drops */
  | { type: 'world-creature-die'; level: string; id: number; kind: number; x: number; y: number; z: number; by: 0 | 1 }
  /** I hurt this creature: `amount` hit points and a shove (kx, kz in units/s).
      Relayed to the host, which applies it */
  | { type: 'world-creature-hit'; level: string; id: number; amount: number; kx: number; kz: number }
  /** a creature hurt this person (host only). The server decides the amount */
  | { type: 'world-creature-attack'; level: string; id: number; victim: number; atk: AttackId }
  | { type: 'world-creature-cmd'; level: string; cmd: CreatureCmd }
  /** `/spawnmob`: ask the host to place one near me (a kind index, a spot) */
  | { type: 'world-creature-spawn'; level: string; kind: number; x: number; z: number }

export type CreatureServerMessage =
  /** who simulates now (0: nobody), and the scope's switches */
  | { type: 'world-creature-host'; level: string; host: number; on: boolean; peaceful: boolean }
  /** the host's snapshot, relayed; also a late joiner's first look. To the
      host itself it only ever arrives as a handover (a new host adopts the
      rows) or, with no rows, as `/mobs clear` and `/mobs off` */
  | { type: 'world-creatures'; level: string; rows: CreatureRow[] }
  | { type: 'world-creature-die'; level: string; id: number; kind: number; x: number; y: number; z: number; by: 0 | 1 }
  /** to the host only: somebody hurt one of its creatures */
  | { type: 'world-creature-hit'; level: string; id: number; amount: number; kx: number; kz: number; from: number }
  /** to the person a creature hurt: the shove their own body takes */
  | { type: 'world-creature-knock'; level: string; vx: number; vz: number }
  /** to the host only: somebody asked for one of these here */
  | { type: 'world-creature-spawn'; level: string; kind: number; x: number; z: number; from: number }
  | { type: 'world-creature-no'; reason: string }

export const rowOf = (
  id: number, kind: number, x: number, y: number, z: number, yaw: number, hp: number, flags: number,
): CreatureRow => [id, kind, Math.round(x * 10), Math.round(y * 10), Math.round(z * 10), Math.round(yaw * 100), Math.round(hp), flags]

export interface DecodedRow {
  id: number
  kind: number
  x: number
  y: number
  z: number
  yaw: number
  hp: number
  st: number
  hurt: boolean
  burning: boolean
}

export const decodeRow = (r: readonly number[]): DecodedRow => ({
  id: r[0],
  kind: r[1],
  x: r[2] / 10,
  y: r[3] / 10,
  z: r[4] / 10,
  yaw: r[5] / 100,
  hp: r[6],
  st: r[7] & ROW_STATE,
  hurt: (r[7] & ROW_HURT) !== 0,
  burning: (r[7] & ROW_BURN) !== 0,
})
