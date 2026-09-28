/*
  The creature kind table: what each living thing is, as data.

  A kind is size, speed, hit points, a behaviour name the simulation
  (sim.ts) switches on, the voices it makes and what it leaves behind. It has
  no geometry (models.ts draws it) and no idea what world it stands in
  (world.ts is that seam), so a new animal is one row here plus one entry in
  the model table.

  **The wire index is append-only.** `index` is the kind's number in a
  snapshot row (net/creatureProtocol.ts) and in the server's bounded table, so
  a kind is never reordered or removed once shipped; a new one goes at the end.
  The server accepts anything below `KIND_COUNT` and never looks further.

  Sizes are world units: a block is two, the walker's body is 0.85 wide and
  4.4 tall, so the zombie and the skeleton are a person, the creeper a bit
  under, and the farm animals about knee to waist.

  `drops` is metadata for a later survival mode: catalogue kind ids (blocks
  are `block_<key>`) with a count range. Nothing here builds an inventory.
  Where a level lets the dead drop things (Cubeland), each becomes a prop
  flagged as a gib, so the sandbox's own breakables clean it up.
*/

export type Behaviour = 'passive' | 'hostile' | 'creeper' | 'skeleton' | 'walker' | 'arrow'

/** the voices a kind has; creatures/sounds.ts knows how to make each */
export type Voice = 'oink' | 'moo' | 'baa' | 'cluck' | 'groan' | 'hiss' | 'rattle' | 'none'

export interface Drop {
  kind: string
  /** inclusive count range */
  n: readonly [number, number]
}

export interface CreatureKind {
  id: string
  /** wire index, append-only */
  index: number
  behaviour: Behaviour
  /** collision radius and standing height, world units */
  r: number
  h: number
  /** walking and running speed, units/s */
  speed: number
  run: number
  health: number
  /** kilograms, for the knockback the impact seam asks about */
  mass: number
  /** the highest ledge it climbs unaided */
  step: number
  /** how far a hostile notices a player, units (0 for the rest) */
  sight: number
  /** a pack's size range when spawned in the wild */
  pack: readonly [number, number]
  voices: { idle: Voice; hurt: Voice; death: Voice }
  /** seconds between idle sounds, range */
  chatter: readonly [number, number]
  drops: readonly Drop[]
  /** burns in daylight (zombie, skeleton) */
  burns?: boolean
  /** a fallen walker gets up again after this long instead of dying */
  revive?: number
  /** in the wild: passive kinds spawn on grass by day, hostile ones in the dark */
  wild: boolean
}

type Row = Omit<CreatureKind, 'voices' | 'chatter' | 'drops' | 'pack' | 'sight' | 'step' | 'wild'> &
  Partial<Pick<CreatureKind, 'voices' | 'chatter' | 'drops' | 'pack' | 'sight' | 'step' | 'wild'>>

const K = (k: Row): CreatureKind => ({
  voices: { idle: 'none', hurt: 'none', death: 'none' },
  chatter: [6, 14],
  drops: [],
  pack: [1, 1],
  sight: 0,
  step: 2.1,
  wild: true,
  ...k,
})

export const KINDS: readonly CreatureKind[] = [
  K({
    id: 'pig', index: 0, behaviour: 'passive', r: 0.8, h: 1.9, speed: 2.1, run: 5.4, health: 10, mass: 60,
    pack: [2, 4], voices: { idle: 'oink', hurt: 'oink', death: 'oink' },
    drops: [{ kind: 'block_terracotta_red', n: [1, 2] }],
  }),
  K({
    id: 'cow', index: 1, behaviour: 'passive', r: 0.95, h: 2.7, speed: 1.9, run: 4.6, health: 14, mass: 200,
    pack: [2, 4], voices: { idle: 'moo', hurt: 'moo', death: 'moo' }, chatter: [8, 18],
    drops: [{ kind: 'block_terracotta_brown', n: [1, 2] }],
  }),
  K({
    id: 'sheep', index: 2, behaviour: 'passive', r: 0.85, h: 2.5, speed: 2.0, run: 5.0, health: 10, mass: 80,
    pack: [2, 5], voices: { idle: 'baa', hurt: 'baa', death: 'baa' },
    drops: [{ kind: 'block_wool_white', n: [1, 2] }],
  }),
  K({
    id: 'chicken', index: 3, behaviour: 'passive', r: 0.45, h: 1.3, speed: 2.4, run: 5.8, health: 4, mass: 6,
    pack: [2, 4], voices: { idle: 'cluck', hurt: 'cluck', death: 'cluck' }, chatter: [4, 10], step: 1.2,
    drops: [{ kind: 'block_snow', n: [1, 1] }],
  }),
  K({
    id: 'zombie', index: 4, behaviour: 'hostile', r: 0.8, h: 4.2, speed: 2.6, run: 4.4, health: 20, mass: 75,
    sight: 48, voices: { idle: 'groan', hurt: 'groan', death: 'groan' }, chatter: [5, 11], burns: true,
    drops: [{ kind: 'block_brown_mushroom_block', n: [0, 2] }],
  }),
  K({
    id: 'creeper', index: 5, behaviour: 'creeper', r: 0.75, h: 3.5, speed: 2.5, run: 4.2, health: 20, mass: 70,
    sight: 40, voices: { idle: 'none', hurt: 'hiss', death: 'none' },
  }),
  K({
    id: 'skeleton', index: 6, behaviour: 'skeleton', r: 0.75, h: 4.3, speed: 2.6, run: 4.0, health: 20, mass: 40,
    sight: 44, voices: { idle: 'rattle', hurt: 'rattle', death: 'rattle' }, chatter: [6, 14], burns: true,
    drops: [{ kind: 'block_sandstone', n: [0, 2] }],
  }),
  // the projectile a skeleton looses: a creature only so that it rides the
  // same snapshot and the same render path as everything else
  K({
    id: 'arrow', index: 7, behaviour: 'arrow', r: 0.2, h: 0.4, speed: 0, run: 0, health: 1, mass: 1, wild: false,
  }),
  // Nuketown's strollers: mannequins that fall over when shot or blasted and
  // get up again after a while
  K({
    id: 'walker', index: 8, behaviour: 'walker', r: 0.6, h: 3.9, speed: 2.6, run: 2.6, health: 16, mass: 70,
    revive: 8, wild: false,
  }),
]

export const KIND_COUNT = KINDS.length
export const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]))
export const kindOf = (index: number): CreatureKind | null => KINDS[index] ?? null
export const kindNamed = (id: string): CreatureKind | null => KIND_BY_ID.get(id) ?? null
/** the kinds a player may `/spawnmob` */
export const SPAWNABLE = KINDS.filter((k) => k.behaviour !== 'arrow').map((k) => k.id)

/** hard caps per scope: what the simulation will ever keep alive at once */
export const CAPS = {
  /** creatures alive (arrows apart) */
  alive: 40,
  passive: 22,
  hostile: 14,
  arrows: 24,
  /** within 64 units of any one player */
  perPlayer: 22,
} as const
