/*
  The two seams the creature simulation stands on, so that it knows nothing
  about any level, any renderer or any socket.

  **`CreatureWorld` is the level's half**: what the ground is. A level
  declares `creatures?: CreatureWorld` (levels/types.ts) and the scene reads
  it; there is no `level.id ===` anywhere in the runtime. Cubeland answers
  from its block store, Nuketown from its collision boxes
  (creatures/collisionWorld.ts), and a future map answers however it likes.
  Every query is a pure function of where you ask, so the host can ask about
  a column three chunks from anyone's ring without the level having to have
  drawn it.

  **`CreatureEnv` is the scene's half**: who is out here, what hour it is, and
  the two things a creature does to the outside of the simulation (hurting a
  person, blowing a hole in the ground). The scene wires them to the health
  system, the sandbox and the socket; a headless test wires them to arrays.

  Heights are the soles' height in world units. A "footing" is a place a body
  of a given radius and height may stand: it has headroom, it is not liquid,
  and it is reachable from where the body is (a step up of at most `up`, a
  drop of at most `down`), which is the whole of terrain awareness the
  steering needs.
*/

export type Ground = 'grass' | 'sand' | 'snow' | 'stone' | 'street' | 'other'

export interface Footing {
  /** the height of the soles standing there */
  y: number
  ground: Ground
}

export interface FootingOpts {
  /** the highest ledge climbed in one step */
  up: number
  /** the furthest drop taken in one step */
  down: number
  /** headroom needed */
  h: number
  /** body radius */
  r: number
}

/** how lit a place is, each 0..1: the sky it sees (before the hour is
    applied) and the light of nearby torches, lanterns and lava */
export interface LightAt {
  sky: number
  block: number
}

/** somebody standing in the level who a creature can notice, chase and hurt */
export interface Resident {
  kind: string
  x: number
  z: number
  /** a closed loop of waypoints to stroll (x, z pairs) */
  loop?: ReadonlyArray<readonly [number, number]>
}

export interface CreatureWorld {
  /** kind ids that appear in the wild here, at the level's own rules (grass
      by day for the passive, the dark for the hostile). Empty: nothing
      spawns unasked */
  readonly fauna: readonly string[]
  /** the dead leave their drops as props here */
  readonly drops?: boolean
  /** creatures placed at the start and put back when they are gone */
  readonly residents?: readonly Resident[]
  /** the nearest footing to (x, z) for a body at feet `fromY`, or null when
      it is a wall, a liquid, a void or too low a ceiling */
  footing: (x: number, z: number, fromY: number, o: FootingOpts) => Footing | null
  /** every footing in a column, highest first, into `out` (cleared): the
      spawner's way of finding the surface and the caves under it. Returns
      how many */
  spots: (x: number, z: number, out: number[], h: number) => number
  /** the light at a point, into `out` */
  light: (x: number, y: number, z: number, out: LightAt) => LightAt
  /** does the open sky see this point (before the hour): the cheap half of
      `light`, for the ones that only ask whether the sun can reach them */
  exposed?: (x: number, y: number, z: number) => boolean
  /** is there nothing solid between two points */
  clearLine?: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => boolean
}

/** a player as the simulation sees one */
export interface PlayerRef {
  /** the server's id, 0 offline */
  id: number
  x: number
  /** soles */
  y: number
  z: number
  self: boolean
  dead?: boolean
}

/** what a creature does to a person, for the scene to carry out */
export interface MobAttack {
  /** the creature that did it (the server checks its last reported position) */
  creature: number
  /** the victim's id (0: ourselves, offline) */
  victim: number
  atk: 'melee' | 'arrow' | 'blast'
  amount: number
  /** the shove: a direction on the ground and a strength, units/s */
  dx: number
  dz: number
  push: number
}

export interface CreatureEnv {
  players: () => Iterable<PlayerRef>
  /** 0 night .. 1 day, as the sky being drawn has it (the console's pinned
      hour included) */
  daylight: () => number
  hurtPlayer: (a: MobAttack) => void
  /** a creeper going off: carve, throw and show */
  explode: (x: number, y: number, z: number, power: number, radius: number) => void
}

/** could a body of this size stand at (x, y, z), as it is now */
export const canStand = (
  w: CreatureWorld, x: number, y: number, z: number, r: number, h: number,
): boolean => {
  const f = w.footing(x, z, y, { up: 0.3, down: 0.3, h, r })
  return !!f && Math.abs(f.y - y) <= 0.3
}
