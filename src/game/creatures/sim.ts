import { CAPS, kindNamed, kindOf, type CreatureKind } from './kinds'
import {
  canStand, type CreatureEnv, type CreatureWorld, type LightAt, type MobAttack, type PlayerRef,
} from './world'

/*
  The creature simulation: who is alive, where they are and what they want.

  Headless, renderer-free and socket-free, like everything under
  src/game/: it is given a `CreatureWorld` (the level's ground) and a
  `CreatureEnv` (the scene's people, hour and hands) and steps a fixed
  1/30 s. Exactly one machine per scope runs it (the host, see
  net/creatureProtocol.ts); everyone else only draws what the host says.

  **Steering** is deliberately small. A creature has a heading it eases
  toward, a speed its behaviour asks for, and a feeler: every 0.15 s it asks
  the world for a footing a little ahead along the goal direction and, when
  there is none (a wall, a liquid, a drop too deep), tries headings fanned
  either side of it. That is wander, flee, chase and keep-your-distance,
  all the same machinery with a different goal point. Terrain awareness is
  the world's `footing` alone: a step up of at most `kind.step`, a drop of at
  most a few units when strolling and more when running for it, and the body
  follows the floor (rises fast, falls under gravity).

  **Who spawns and where.** Passive animals appear in packs on grass by day in
  a ring around a player (24 to 56 units out, never in view of the walker's
  nose), hostile ones wherever it is dark at that spot: at night on the
  surface, and always in a cave, judged from the world's sky and block light
  and the hour, never from which level this is. Everything is capped
  (`CAPS`): forty alive per scope, twenty-two near any one player, arrows
  apart. Anything beyond the despawn ring for a few seconds is removed, so
  the cost stays flat however far anybody roams, and a scope with nobody in
  it simulates nothing.

  **Damage** comes in through `hit()` from the outside (weapons, blasts,
  vehicles, props, the console) and goes out through the env's `hurtPlayer`
  (melee, arrows, blasts), which the scene carries to the server's health
  system. Fire is the hour: a zombie or skeleton under open sky in daylight
  burns. The creeper hisses within a few blocks of a player, swells for a
  second and a half and goes off through `env.explode`, which is the level's
  own blast path (Cubeland carves its blocks with it).

  Nothing here rolls Math.random when a `random` is injected, so the tests
  drive the same world twice and get the same herd.
*/

export const STEP = 1 / 30
const G = 34
/** creatures fall a little lighter than the walker; the blocks are big */
const ARROW_G = 9
const ARROW_SPEED = 34
const ARROW_LIFE = 4
const DEAD_LINGER = 1.6
/** how far from every player a creature may live, and for how long past it */
const DESPAWN_PASSIVE = 130
const DESPAWN_HOSTILE = 100
const DESPAWN_AFTER = 6
const SPAWN_EVERY = 0.5
/** ring around a player the wild spawns in */
const SPAWN_NEAR = 26
const SPAWN_FAR = 58
/** the light below which the dark breeds hostiles (0..1, of a torch's 15) */
const DARK = 0.3
/** daylight that sets a zombie alight (sky * day) */
const BURN_LIGHT = 0.6
const MELEE_DAMAGE = 5
const ARROW_DAMAGE = 4
const CREEPER_FUSE = 1.5
const CREEPER_POWER = 1.6
/** the blast the world is asked for: sized so Cubeland carves a crater about three blocks across */
const CREEPER_BLAST = 14
/** how far it hurts a person, mirrored by server/src/creatures.js */
export const CREEPER_RADIUS = 11
export const CREEPER_MAX_DAMAGE = 45

export const S = { IDLE: 0, WALK: 1, FLEE: 2, CHASE: 3, ACT: 4, DEAD: 5 } as const

export interface Creature {
  id: number
  kind: CreatureKind
  x: number
  y: number
  z: number
  px: number
  py: number
  pz: number
  yaw: number
  pyaw: number
  vx: number
  vy: number
  vz: number
  /** the height of the floor under it: the body chases this */
  gy: number
  hp: number
  st: number
  /** seconds in this state */
  stT: number
  /** seconds since it was last hurt */
  hurtT: number
  /** seconds since it died, or -1 */
  deadT: number
  burning: boolean
  /** heading it wants and the speed */
  heading: number
  want: number
  navT: number
  goalX: number
  goalZ: number
  cool: number
  fuse: number
  threatX: number
  threatZ: number
  threatT: number
  sayT: number
  herd: number
  wp: number
  loop: ReadonlyArray<readonly [number, number]> | null
  outside: number
  stuck: number
  age: number
  grounded: boolean
  /** a walker's or a resident's: put back when it is gone */
  resident: boolean
  /** an arrow's shooter */
  by: number
  /** 1: the last blow was a player's */
  killer: number
  burnBeat: number
  /** how long an idle spell lasts */
  wait: number
  /** the resident slot this one fills (-1: a wild one) */
  home: number
}

export type CreatureEvent =
  | { t: 'spawn'; c: Creature }
  | { t: 'remove'; c: Creature }
  | { t: 'hurt'; c: Creature; amount: number }
  | { t: 'die'; c: Creature; byPlayer: boolean }
  | { t: 'revive'; c: Creature }
  | { t: 'say'; c: Creature; hurt: boolean }
  | { t: 'fuse'; c: Creature }
  | { t: 'explode'; x: number; y: number; z: number }
  | { t: 'shoot'; c: Creature; arrow: Creature }

/** a creature as the view draws it: interpolated, whoever simulated it */
export interface RenderCreature {
  id: number
  kind: CreatureKind
  x: number
  y: number
  z: number
  yaw: number
  /** planar speed, units/s, for the walk cycle */
  speed: number
  st: number
  /** seconds in the state (the fuse, the fall) */
  stT: number
  /** seconds since hurt */
  hurtT: number
  /** seconds since death, -1 alive */
  deadT: number
  burning: boolean
  /** planar motion direction, for an arrow's pitch */
  vy: number
}

export interface SimSettings {
  /** wild spawning and the population at all */
  enabled: boolean
  /** hostiles despawn and never spawn */
  peaceful: boolean
}

export interface SimOpts {
  world: CreatureWorld
  env: CreatureEnv
  random?: () => number
}

const TAU = Math.PI * 2
const wrap = (a: number) => {
  a %= TAU
  if (a > Math.PI) a -= TAU
  else if (a < -Math.PI) a += TAU
  return a
}
const turnToward = (from: number, to: number, max: number) => {
  const d = wrap(to - from)
  return from + Math.max(-max, Math.min(max, d))
}

export interface CreatureSim {
  readonly creatures: ReadonlyMap<number, Creature>
  readonly settings: SimSettings
  /** advance real time; steps the fixed clock as many times as it buys */
  update: (dt: number) => void
  /** the interpolated draw list */
  render: () => readonly RenderCreature[]
  on: (fn: (e: CreatureEvent) => void) => () => void
  /** a blow from outside. `kx`,`kz` is the shove, units/s. Returns true if it killed */
  hit: (id: number, amount: number, kx: number, kz: number, byPlayer: boolean) => boolean
  /** a blast: damage and shove everything in the ball, falling off with distance */
  blast: (x: number, y: number, z: number, radius: number, power: number, byPlayer: boolean) => void
  /** place one (console, tests, a residents table). Null when refused */
  spawn: (kind: string, x: number, z: number, o?: { y?: number; loop?: ReadonlyArray<readonly [number, number]>; resident?: boolean; force?: boolean }) => Creature | null
  /** take over a set of creatures as they were (handing the host over) */
  adopt: (rows: ReadonlyArray<AdoptRow>) => void
  remove: (id: number) => void
  clear: () => void
  /** counts alive by class, arrows apart */
  counts: () => { alive: number; passive: number; hostile: number; arrows: number }
  /** apply a settings change (may remove creatures) */
  configure: (s: Partial<SimSettings>) => void
  /** are any of the fixed steps' work pending; the wire's dirty flag */
  readonly stepsRun: number
  /** stand a resident set up (the world's, once) */
  populate: () => void
}

export interface AdoptRow {
  id: number
  kind: number
  x: number
  y: number
  z: number
  yaw: number
  hp: number
  st: number
}

export function createCreatureSim(o: SimOpts): CreatureSim {
  const { world, env } = o
  const rnd = o.random ?? Math.random
  const between = (a: number, b: number) => a + (b - a) * rnd()
  const creatures = new Map<number, Creature>()
  const settings: SimSettings = { enabled: true, peaceful: false }
  const listeners = new Set<(e: CreatureEvent) => void>()
  const emit = (e: CreatureEvent) => {
    for (const fn of listeners) fn(e)
  }
  let seq = 1
  let herdSeq = 1
  let clock = 0
  let acc = 0
  let alpha = 0
  let spawnT = 1
  let stepsRun = 0
  const lightOut: LightAt = { sky: 0, block: 0 }
  let players: PlayerRef[] = []
  const herds = new Map<number, { x: number; z: number; n: number }>()
  let herdT = 0
  const spotBuf: number[] = []
  let restock = false
  let restockT = 5

  const nextId = () => {
    for (let i = 0; i < 70000; i++) {
      seq = seq >= 65000 ? 1 : seq + 1
      if (!creatures.has(seq)) return seq
    }
    return 0
  }

  /* ------------------------------------------------------------ helpers -- */

  const footOpts = { up: 2.1, down: 3, h: 2, r: 0.8 }
  const feel = (c: Creature, x: number, z: number, fromY: number, down: number, climb = c.kind.step) => {
    footOpts.up = climb
    footOpts.down = down
    footOpts.h = c.kind.h
    footOpts.r = c.kind.r
    return world.footing(x, z, fromY, footOpts)
  }

  const daylight = () => Math.max(0, Math.min(1, env.daylight()))
  /** how lit it is at a point, 0..1, with the hour applied to the sky */
  const lightAt = (x: number, y: number, z: number) => {
    world.light(x, y, z, lightOut)
    return Math.max(lightOut.block, lightOut.sky * daylight())
  }

  const isHostile = (k: CreatureKind) => k.behaviour === 'hostile' || k.behaviour === 'creeper' || k.behaviour === 'skeleton'
  const counts = () => {
    let passive = 0
    let hostile = 0
    let arrows = 0
    let other = 0
    for (const c of creatures.values()) {
      const b = c.kind.behaviour
      if (b === 'arrow') arrows++
      else if (b === 'passive') passive++
      else if (isHostile(c.kind)) hostile++
      else other++
    }
    return { alive: passive + hostile + other, passive, hostile, arrows }
  }

  const make = (kind: CreatureKind, x: number, y: number, z: number): Creature => {
    const yaw = rnd() * TAU
    return {
      id: nextId(), kind, x, y, z, px: x, py: y, pz: z, yaw, pyaw: yaw, vx: 0, vy: 0, vz: 0, gy: y,
      hp: kind.health, st: S.IDLE, stT: 0, hurtT: 99, deadT: -1, burning: false, heading: yaw, want: 0, navT: rnd() * 0.15,
      goalX: x, goalZ: z, cool: between(0.5, 2), fuse: 0, threatX: 0, threatZ: 0, threatT: 0,
      sayT: between(kind.chatter[0], kind.chatter[1]), herd: 0, wp: 0, loop: null, outside: 0, stuck: 0, age: 0,
      grounded: true, resident: false, by: 0, killer: 0, burnBeat: 0, wait: between(1.5, 5), home: -1,
    }
  }

  const add = (c: Creature) => {
    creatures.set(c.id, c)
    emit({ t: 'spawn', c })
    return c
  }

  const drop = (c: Creature) => {
    if (creatures.delete(c.id)) emit({ t: 'remove', c })
  }

  const nearestPlayer = (x: number, z: number, maxD: number, alive = true) => {
    let best: PlayerRef | null = null
    let bd = maxD * maxD
    for (const p of players) {
      if (alive && p.dead) continue
      const d = (p.x - x) ** 2 + (p.z - z) ** 2
      if (d < bd) {
        bd = d
        best = p
      }
    }
    return best
  }

  const setState = (c: Creature, st: number) => {
    if (c.st === st) return
    c.st = st
    c.stT = 0
    if (st === S.IDLE) c.wait = between(1.5, 5)
  }

  /* ---------------------------------------------------------- spawning -- */

  const spawn: CreatureSim['spawn'] = (kindId, x, z, opt = {}) => {
    const kind = kindNamed(kindId)
    if (!kind) return null
    if (!opt.force) {
      const n = counts()
      if (kind.behaviour === 'arrow' ? n.arrows >= CAPS.arrows : n.alive >= CAPS.alive) return null
      if (isHostile(kind) && settings.peaceful) return null
    }
    let y = opt.y
    if (y === undefined) {
      const n = world.spots(x, z, spotBuf, kind.h)
      if (!n) return null
      y = spotBuf[0]
    }
    const f = feel(makeProbe(kind, y), x, z, y + 0.4, 1, 0.5)
    if (!f) return null
    const c = make(kind, x, f.y, z)
    if (opt.loop) {
      c.loop = opt.loop
      c.resident = !!opt.resident
    }
    return add(c)
  }
  // a stand-in body for a footing question before the creature exists
  const probeBody = {} as Creature
  const makeProbe = (kind: CreatureKind, y: number) => {
    probeBody.kind = kind
    probeBody.y = y
    return probeBody
  }

  /** stand the level's residents up: the ones not already standing */
  const populate = () => {
    restock = true
    const have = new Set<number>()
    for (const c of creatures.values()) if (c.home >= 0) have.add(c.home)
    const rs = world.residents ?? []
    for (let i = 0; i < rs.length; i++) {
      if (have.has(i)) continue
      const r = rs[i]
      let c = spawn(r.kind, r.x, r.z, { loop: r.loop, resident: true, force: true })
      // (a start that turned out to be inside something: any waypoint will do)
      for (let k = 0; !c && r.loop && k < r.loop.length; k++) {
        c = spawn(r.kind, r.loop[k][0], r.loop[k][1], { loop: r.loop, resident: true, force: true })
      }
      if (c) {
        c.home = i
        if (r.loop) c.wp = Math.floor(rnd() * r.loop.length)
      }
    }
  }

  const tooClose = (x: number, z: number, d: number) => {
    for (const p of players) if ((p.x - x) ** 2 + (p.z - z) ** 2 < d * d) return true
    return false
  }

  const wildSpawn = () => {
    if (!settings.enabled || !players.length) return
    const n = counts()
    if (n.alive >= CAPS.alive) return
    const p = players[Math.floor(rnd() * players.length)]
    if (p.dead) return
    // how crowded this player already is
    let near = 0
    for (const c of creatures.values()) if ((c.x - p.x) ** 2 + (c.z - p.z) ** 2 < 64 * 64 && c.kind.behaviour !== 'arrow') near++
    if (near >= CAPS.perPlayer) return
    const day = daylight()
    const a = rnd() * TAU
    const d = between(SPAWN_NEAR, SPAWN_FAR)
    const x = p.x + Math.cos(a) * d
    const z = p.z + Math.sin(a) * d
    const got = world.spots(x, z, spotBuf, 4)
    if (!got) return
    // a passive pack takes the surface by day; a hostile takes any spot in the dark
    const passive = world.fauna.filter((id) => kindNamed(id)?.behaviour === 'passive')
    const hostile = settings.peaceful ? [] : world.fauna.filter((id) => isHostile(kindNamed(id)!))
    const surface = spotBuf[0]
    const spot = spotBuf[Math.floor(rnd() * got)]
    lightAt(x, surface + 0.5, z)
    const skyOpen = lightOut.sky > 0.5
    if (day > 0.35 && skyOpen && passive.length && n.passive < CAPS.passive && rnd() < 0.7) {
      const id = passive[Math.floor(rnd() * passive.length)]
      const kind = kindNamed(id)!
      const f = feel(makeProbe(kind, surface), x, z, surface + 0.5, 2, 0.6)
      if (!f || f.ground !== 'grass') return
      const size = Math.round(between(kind.pack[0], kind.pack[1]))
      const herd = herdSeq++
      for (let i = 0; i < size; i++) {
        const c = spawn(id, x + between(-3, 3), z + between(-3, 3), { y: surface })
        if (c) c.herd = herd
      }
      return
    }
    if (hostile.length && n.hostile < CAPS.hostile && !tooClose(x, z, 24)) {
      if (lightAt(x, spot + 1, z) > DARK) return
      const id = pickHostile(hostile)
      spawn(id, x, z, { y: spot })
    }
  }

  const pickHostile = (ids: readonly string[]) => {
    // zombies are the common dark; the rest are rarer
    const w = (id: string) => (id === 'zombie' ? 6 : id === 'skeleton' ? 3 : 2)
    let total = 0
    for (const id of ids) total += w(id)
    let r = rnd() * total
    for (const id of ids) {
      r -= w(id)
      if (r <= 0) return id
    }
    return ids[0]
  }

  /* ------------------------------------------------------------ damage -- */

  const kill = (c: Creature, byPlayer: boolean) => {
    if (c.st === S.DEAD) return
    c.hp = 0
    c.killer = byPlayer ? 1 : 0
    setState(c, S.DEAD)
    c.deadT = 0
    c.burning = false
    emit({ t: 'die', c, byPlayer })
  }

  const hit: CreatureSim['hit'] = (id, amount, kx, kz, byPlayer) => {
    const c = creatures.get(id)
    if (!c || c.st === S.DEAD || c.kind.behaviour === 'arrow' || !(amount > 0)) return false
    c.hp -= amount
    c.hurtT = 0
    const k = Math.hypot(kx, kz)
    c.vx += kx
    c.vz += kz
    c.vy = Math.max(c.vy, 3.5 + k * 0.12)
    c.grounded = false
    if (k > 0.5) c.threatX = c.x - kx / k * 6
    else c.threatX = c.x
    c.threatZ = k > 0.5 ? c.z - kz / k * 6 : c.z
    if (c.kind.behaviour === 'passive') c.threatT = 5
    if (byPlayer) c.killer = 1
    emit({ t: 'hurt', c, amount })
    if (c.hp <= 0) {
      kill(c, byPlayer)
      return true
    }
    return false
  }

  const blast: CreatureSim['blast'] = (x, y, z, radius, power, byPlayer) => {
    for (const c of [...creatures.values()]) {
      if (c.st === S.DEAD || c.kind.behaviour === 'arrow') continue
      const dx = c.x - x
      const dz = c.z - z
      const dy = c.y + c.kind.h * 0.5 - y
      const d = Math.hypot(dx, dy, dz)
      if (d > radius) continue
      const k = 1 - d / radius
      const push = 26 * power * k * Math.sqrt(90 / Math.max(20, c.kind.mass))
      const pl = Math.hypot(dx, dz) || 1
      hit(c.id, 40 * power * k * k + 4 * k, (dx / pl) * push, (dz / pl) * push, byPlayer)
    }
  }

  /* ------------------------------------------------------------- brains -- */

  /** fan headings either side of `want` until one has a footing ahead */
  const navigate = (c: Creature, want: number, speed: number, run: boolean) => {
    c.want = speed
    const look = c.kind.r + 1.3 + speed * 0.25
    const down = run ? 6 : 3
    const fan = [0, 0.55, -0.55, 1.1, -1.1, 1.7, -1.7]
    for (const off of fan) {
      const a = want + off
      const f = feel(c, c.x + Math.cos(a) * look, c.z + Math.sin(a) * look, c.gy, down)
      if (f) {
        c.heading = a
        return true
      }
    }
    c.want = 0
    return false
  }

  const wander = (c: Creature, dt: number, speedK: number) => {
    // cycle idle and walk; a herd leans toward its middle
    if (c.st !== S.IDLE && c.st !== S.WALK) setState(c, S.IDLE)
    if (c.st === S.IDLE) {
      c.want = 0
      if (c.stT > c.wait) {
        const h = c.herd ? herds.get(c.herd) : null
        let a = rnd() * TAU
        let dist = between(4, 10)
        if (h && h.n > 1 && (h.x - c.x) ** 2 + (h.z - c.z) ** 2 > 9 * 9) {
          a = Math.atan2(h.z - c.z, h.x - c.x) + between(-0.6, 0.6)
          dist = 8
        }
        c.goalX = c.x + Math.cos(a) * dist
        c.goalZ = c.z + Math.sin(a) * dist
        setState(c, S.WALK)
      }
      return
    }
    const d = Math.hypot(c.goalX - c.x, c.goalZ - c.z)
    if (d < 1 || c.stT > 7) {
      setState(c, S.IDLE)
      return
    }
    if (c.navT <= 0) {
      c.navT = 0.15
      if (!navigate(c, Math.atan2(c.goalZ - c.z, c.goalX - c.x), c.kind.speed * speedK, false)) setState(c, S.IDLE)
    }
    void dt
  }

  const chaseTo = (c: Creature, tx: number, tz: number, speed: number) => {
    if (c.navT <= 0) {
      c.navT = 0.15
      navigate(c, Math.atan2(tz - c.z, tx - c.x), speed, true)
    }
  }

  const brainPassive = (c: Creature, dt: number) => {
    if (c.threatT > 0) {
      c.threatT -= dt
      setState(c, S.FLEE)
      if (c.navT <= 0) {
        c.navT = 0.15
        const away = Math.atan2(c.z - c.threatZ, c.x - c.threatX)
        navigate(c, away + Math.sin(clock * 1.7 + c.id) * 0.4, c.kind.run, true)
      }
      return
    }
    if (c.st === S.FLEE) setState(c, S.IDLE)
    wander(c, dt, 1)
  }

  const burnCheck = (c: Creature, dt: number) => {
    c.burnBeat -= dt
    if (c.burnBeat > 0) return
    c.burnBeat = 0.25
    const sky = world.exposed ? (world.exposed(c.x, c.y + c.kind.h, c.z) ? 1 : 0) : (world.light(c.x, c.y + c.kind.h, c.z, lightOut), lightOut.sky)
    c.burning = sky * daylight() > BURN_LIGHT
    if (c.burning) {
      c.hp -= 0.25 * 3
      if (c.hp <= 0) kill(c, false)
    }
  }

  const brainHostile = (c: Creature, dt: number) => {
    if (c.kind.burns) burnCheck(c, dt)
    if (c.st === S.DEAD) return
    const tgt = settings.peaceful ? null : nearestPlayer(c.x, c.z, c.kind.sight)
    if (!tgt) {
      if (c.st === S.CHASE || c.st === S.ACT) setState(c, S.IDLE)
      wander(c, dt, 0.7)
      return
    }
    const dx = tgt.x - c.x
    const dz = tgt.z - c.z
    const d = Math.hypot(dx, dz)
    c.yaw = turnToward(c.yaw, Math.atan2(dz, dx), 6 * dt)
    if (d < c.kind.r + 1.9 && Math.abs(tgt.y - c.y) < 3.2) {
      c.want = 0
      if (c.cool <= 0) {
        setState(c, S.ACT)
        c.cool = 1
        env.hurtPlayer({
          creature: c.id, victim: tgt.self ? 0 : tgt.id, atk: 'melee', amount: MELEE_DAMAGE,
          dx: dx / (d || 1), dz: dz / (d || 1), push: 9,
        })
      } else if (c.st === S.ACT && c.stT > 0.3) setState(c, S.CHASE)
      return
    }
    if (c.st === S.ACT && c.stT < 0.3) return
    setState(c, S.CHASE)
    chaseTo(c, tgt.x, tgt.z, c.kind.run)
  }

  const explodeCreeper = (c: Creature) => {
    const { x, z } = c
    const y = c.y + 1.2
    drop(c)
    emit({ t: 'explode', x, y, z })
    env.explode(x, y, z, CREEPER_POWER, CREEPER_BLAST)
    for (const p of players) {
      if (p.dead) continue
      const d = Math.hypot(p.x - x, p.y + 2 - y, p.z - z)
      if (d > CREEPER_RADIUS) continue
      const k = 1 - d / CREEPER_RADIUS
      const pl = Math.hypot(p.x - x, p.z - z) || 1
      env.hurtPlayer({
        creature: c.id, victim: p.self ? 0 : p.id, atk: 'blast', amount: CREEPER_MAX_DAMAGE * k,
        dx: (p.x - x) / pl, dz: (p.z - z) / pl, push: 16 * k + 4,
      })
    }
    // ...and the animals nearby feel it too
    blast(x, y, z, CREEPER_RADIUS, CREEPER_POWER, false)
  }

  const brainCreeper = (c: Creature, dt: number) => {
    const tgt = settings.peaceful ? null : nearestPlayer(c.x, c.z, c.kind.sight)
    if (!tgt) {
      c.fuse = Math.max(0, c.fuse - dt * 2)
      if (c.st === S.CHASE || c.st === S.ACT) setState(c, S.IDLE)
      wander(c, dt, 0.7)
      return
    }
    const dx = tgt.x - c.x
    const dz = tgt.z - c.z
    const d = Math.hypot(dx, dz)
    c.yaw = turnToward(c.yaw, Math.atan2(dz, dx), 7 * dt)
    const near = d < 6.5 && Math.abs(tgt.y - c.y) < 4
    if (near && c.st !== S.ACT) {
      setState(c, S.ACT)
      emit({ t: 'fuse', c })
    }
    if (c.st === S.ACT) {
      c.want = 0
      if (d > 10 || Math.abs(tgt.y - c.y) > 6) {
        // out of reach: the fuse gives up
        c.fuse = Math.max(0, c.fuse - dt * 1.5)
        if (c.fuse <= 0) setState(c, S.CHASE)
      } else {
        c.fuse += dt
        if (c.fuse >= CREEPER_FUSE) explodeCreeper(c)
      }
      return
    }
    c.fuse = Math.max(0, c.fuse - dt)
    setState(c, S.CHASE)
    chaseTo(c, tgt.x, tgt.z, c.kind.run)
  }

  const loose = (c: Creature, tgt: PlayerRef) => {
    const ox = c.x
    const oy = c.y + c.kind.h * 0.8
    const oz = c.z
    const tx = tgt.x
    const ty = tgt.y + 3
    const tz = tgt.z
    const d = Math.hypot(tx - ox, tz - oz)
    const t = d / ARROW_SPEED
    const a = makeArrow(c, ox, oy, oz)
    if (!a) return
    a.vx = ((tx - ox) / t) * 1
    a.vz = ((tz - oz) / t) * 1
    a.vy = (ty - oy) / t + 0.5 * ARROW_G * t
    a.yaw = Math.atan2(a.vz, a.vx)
    emit({ t: 'shoot', c, arrow: a })
  }

  const makeArrow = (from: Creature, x: number, y: number, z: number) => {
    const n = counts()
    if (n.arrows >= CAPS.arrows) return null
    const kind = kindNamed('arrow')!
    const a = make(kind, x, y, z)
    a.by = from.id
    a.st = S.WALK
    a.grounded = false
    return add(a)
  }

  const brainSkeleton = (c: Creature, dt: number) => {
    burnCheck(c, dt)
    if (c.st === S.DEAD) return
    const tgt = settings.peaceful ? null : nearestPlayer(c.x, c.z, c.kind.sight)
    if (!tgt) {
      if (c.st === S.CHASE || c.st === S.ACT) setState(c, S.IDLE)
      wander(c, dt, 0.7)
      return
    }
    const dx = tgt.x - c.x
    const dz = tgt.z - c.z
    const d = Math.hypot(dx, dz)
    const toward = Math.atan2(dz, dx)
    c.yaw = turnToward(c.yaw, toward, 7 * dt)
    const see = world.clearLine ? world.clearLine(c.x, c.y + c.kind.h * 0.8, c.z, tgt.x, tgt.y + 3, tgt.z) : true
    if (c.st === S.ACT) {
      c.want = 0
      if (c.stT > 0.55) {
        if (see && !tgt.dead) loose(c, tgt)
        c.cool = between(1.8, 3)
        setState(c, S.CHASE)
      }
      return
    }
    // keep its distance: back away from the near, close in from the far, strafe between
    if (d < 11) {
      setState(c, S.FLEE)
      if (c.navT <= 0) {
        c.navT = 0.15
        navigate(c, toward + Math.PI + Math.sin(clock + c.id) * 0.5, c.kind.speed, false)
      }
    } else if (d > 26 || !see) {
      setState(c, S.CHASE)
      chaseTo(c, tgt.x, tgt.z, c.kind.speed)
    } else {
      setState(c, S.CHASE)
      if (c.navT <= 0) {
        c.navT = 0.15
        navigate(c, toward + (c.id % 2 ? 1.4 : -1.4), c.kind.speed * 0.6, false)
      }
    }
    if (see && c.cool <= 0 && d < c.kind.sight - 4 && d > 6) setState(c, S.ACT)
  }

  const brainWalker = (c: Creature, dt: number) => {
    if (c.st === S.DEAD) return
    if (c.threatT > 0) c.threatT -= dt
    const loop = c.loop
    if (!loop || !loop.length) {
      wander(c, dt, 1)
      return
    }
    if (c.st === S.IDLE) {
      c.want = 0
      if (c.stT > 2.5 + (c.id % 4)) setState(c, S.WALK)
      return
    }
    setState(c, S.WALK)
    const [wx, wz] = loop[c.wp % loop.length]
    if (Math.hypot(wx - c.x, wz - c.z) < 1.4) {
      c.wp = (c.wp + 1) % loop.length
      // a stroller pauses now and then to look at the neighbourhood
      if (rnd() < 0.08) setState(c, S.IDLE)
      return
    }
    if (c.navT <= 0) {
      c.navT = 0.15
      if (!navigate(c, Math.atan2(wz - c.z, wx - c.x), c.kind.speed, false)) c.wp = (c.wp + 1) % loop.length
    }
  }

  /* --------------------------------------------------------- arrows -- */

  const stepArrow = (a: Creature, dt: number) => {
    a.age += dt
    if (a.age > ARROW_LIFE) return drop(a)
    if (a.st === S.IDLE) {
      // stuck in something: it lingers a moment, then goes
      if (a.stT > 1.2) drop(a)
      return
    }
    const nx = a.x + a.vx * dt
    const ny = a.y + a.vy * dt
    const nz = a.z + a.vz * dt
    a.vy -= ARROW_G * dt
    if (world.clearLine && !world.clearLine(a.x, a.y, a.z, nx, ny, nz)) {
      a.vx = a.vy = a.vz = 0
      setState(a, S.IDLE)
      return
    }
    for (const p of players) {
      if (p.dead) continue
      if (Math.hypot(nx - p.x, nz - p.z) < 1.3 && ny > p.y - 0.2 && ny < p.y + 4.6) {
        const sp = Math.hypot(a.vx, a.vz) || 1
        env.hurtPlayer({
          creature: a.id, victim: p.self ? 0 : p.id, atk: 'arrow', amount: ARROW_DAMAGE,
          dx: a.vx / sp, dz: a.vz / sp, push: 6,
        })
        return drop(a)
      }
    }
    a.x = nx
    a.y = ny
    a.z = nz
    a.yaw = Math.atan2(a.vz, a.vx)
    if (ny < -20) drop(a)
  }

  /* ------------------------------------------------------ integration -- */

  const integrate = (c: Creature, dt: number) => {
    const k = c.kind
    const stunned = c.hurtT < 0.4
    // heading and planar velocity
    if (c.want > 0 && !stunned && c.st !== S.DEAD) {
      c.yaw = turnToward(c.yaw, c.heading, (c.st === S.FLEE || c.st === S.CHASE ? 9 : 5) * dt)
      const aligned = Math.max(0, Math.cos(wrap(c.heading - c.yaw)))
      const tx = Math.cos(c.yaw) * c.want * aligned
      const tz = Math.sin(c.yaw) * c.want * aligned
      const a = Math.min(1, 9 * dt)
      c.vx += (tx - c.vx) * a
      c.vz += (tz - c.vz) * a
    } else if (c.grounded) {
      const f = Math.max(0, 1 - 9 * dt)
      c.vx *= f
      c.vz *= f
    } else {
      const f = Math.max(0, 1 - 0.6 * dt)
      c.vx *= f
      c.vz *= f
    }
    let nx = c.x + c.vx * dt
    let nz = c.z + c.vz * dt
    const air = !c.grounded || c.y > c.gy + 0.05
    const base = air ? Math.max(c.gy, c.y) : c.gy
    const fall = air ? 60 : c.st === S.FLEE ? 6 : 3
    let f = feel(c, nx, nz, base, fall, air ? 0.4 : k.step)
    if (!f && (c.vx !== 0 || c.vz !== 0)) {
      // slide along whichever axis is open
      const fx = feel(c, nx, c.z, base, fall, air ? 0.4 : k.step)
      const fz = feel(c, c.x, nz, base, fall, air ? 0.4 : k.step)
      if (fx) {
        f = fx
        nz = c.z
        c.vz = 0
      } else if (fz) {
        f = fz
        nx = c.x
        c.vx = 0
      } else {
        nx = c.x
        nz = c.z
        c.vx = c.vz = 0
        // a wandering body that walks into a wall picks another way
        if (c.st === S.WALK) setState(c, S.IDLE)
      }
    }
    c.x = nx
    c.z = nz
    if (f) {
      c.gy = f.y
      c.stuck = 0
    } else {
      // nothing under it and nothing reachable: buried, or in a liquid
      const r = feel(c, c.x, c.z, c.y + 4, 8, 4)
      if (r) {
        c.gy = r.y
        c.y = Math.max(c.y, r.y)
        c.stuck = 0
      } else {
        c.stuck += dt
      }
    }
    // the body chases the floor: up quickly, down under gravity
    if (c.y < c.gy - 0.02 && c.vy <= 0) {
      c.y = Math.min(c.gy, c.y + 16 * dt)
      c.grounded = c.y >= c.gy - 0.02
      c.vy = 0
    } else if (c.vy > 0 || c.y > c.gy + 0.02) {
      c.vy -= G * dt
      c.y += c.vy * dt
      c.grounded = false
      if (c.y <= c.gy) {
        if (c.vy < -26) c.hp -= (-c.vy - 26) * 0.5
        c.y = c.gy
        c.vy = 0
        c.grounded = true
        if (c.hp <= 0 && c.st !== S.DEAD) kill(c, false)
      }
    } else {
      c.y = c.gy
      c.grounded = true
    }
    if (c.stuck > 5 || c.y < -30) drop(c)
  }

  /* -------------------------------------------------------------- step -- */

  const stepAll = (dt: number) => {
    stepsRun++
    clock += dt
    players = [...env.players()]
    herdT -= dt
    if (herdT <= 0) {
      herdT = 0.5
      herds.clear()
      for (const c of creatures.values()) {
        if (!c.herd) continue
        const h = herds.get(c.herd) ?? { x: 0, z: 0, n: 0 }
        h.x += c.x
        h.z += c.z
        h.n++
        herds.set(c.herd, h)
      }
      for (const h of herds.values()) {
        h.x /= h.n
        h.z /= h.n
      }
    }
    for (const c of [...creatures.values()]) {
      c.px = c.x
      c.py = c.y
      c.pz = c.z
      c.pyaw = c.yaw
      c.stT += dt
      c.hurtT += dt
      c.age += dt
      c.navT -= dt
      c.cool -= dt
      if (c.kind.behaviour === 'arrow') {
        stepArrow(c, dt)
        continue
      }
      if (c.st === S.DEAD) {
        c.deadT += dt
        c.want = 0
        integrate(c, dt)
        if (c.kind.revive && c.deadT > c.kind.revive) {
          c.hp = c.kind.health
          c.deadT = -1
          c.hurtT = 99
          setState(c, S.IDLE)
          emit({ t: 'revive', c })
        } else if (!c.kind.revive && c.deadT > DEAD_LINGER) drop(c)
        continue
      }
      switch (c.kind.behaviour) {
        case 'passive': brainPassive(c, dt); break
        case 'hostile': brainHostile(c, dt); break
        case 'creeper': brainCreeper(c, dt); break
        case 'skeleton': brainSkeleton(c, dt); break
        case 'walker': brainWalker(c, dt); break
      }
      if (!creatures.has(c.id)) continue
      // idle voices, only where somebody could hear them
      c.sayT -= dt
      if (c.sayT <= 0) {
        c.sayT = between(c.kind.chatter[0], c.kind.chatter[1])
        if (c.kind.voices.idle !== 'none' && nearestPlayer(c.x, c.z, 40)) emit({ t: 'say', c, hurt: false })
      }
      integrate(c, dt)
      if (!creatures.has(c.id)) continue
      if (c.st !== S.DEAD) {
        // beyond every player's ring for a while: gone, so the cost stays flat
        if (!c.resident) {
          const lim = isHostile(c.kind) ? DESPAWN_HOSTILE : DESPAWN_PASSIVE
          if (players.length && !nearestPlayer(c.x, c.z, lim, false)) {
            c.outside += dt
            if (c.outside > DESPAWN_AFTER) drop(c)
          } else c.outside = 0
        }
      }
    }
    restockT -= dt
    if (restockT <= 0) {
      restockT = 5
      if (restock && world.residents?.length) populate()
    }
    spawnT -= dt
    if (spawnT <= 0) {
      const n = counts()
      // the first minute fills quickly, then it ticks along
      spawnT = n.alive < CAPS.alive * 0.35 ? SPAWN_EVERY * 0.35 : SPAWN_EVERY
      wildSpawn()
    }
  }

  // hostiles vanish when peace is declared; a level's residents come back
  const configure: CreatureSim['configure'] = (s) => {
    if (s.enabled !== undefined) settings.enabled = s.enabled
    if (s.peaceful !== undefined) settings.peaceful = s.peaceful
    if (!settings.enabled) {
      for (const c of [...creatures.values()]) if (!c.resident) drop(c)
    } else if (settings.peaceful) {
      for (const c of [...creatures.values()]) if (isHostile(c.kind) || c.kind.behaviour === 'arrow') drop(c)
    }
  }

  const rendered = new Map<number, RenderCreature>()
  const renderList: RenderCreature[] = []

  return {
    creatures,
    settings,
    get stepsRun() {
      return stepsRun
    },
    update: (dt) => {
      acc += Math.min(dt, 0.25)
      let n = 0
      while (acc >= STEP && n < 5) {
        acc -= STEP
        stepAll(STEP)
        n++
      }
      if (n === 5) acc = 0
      alpha = acc / STEP
    },
    render: () => {
      renderList.length = 0
      for (const id of [...rendered.keys()]) if (!creatures.has(id)) rendered.delete(id)
      for (const c of creatures.values()) {
        let r = rendered.get(c.id)
        if (!r) {
          r = {
            id: c.id, kind: c.kind, x: 0, y: 0, z: 0, yaw: 0, speed: 0, st: 0, stT: 0, hurtT: 0, deadT: -1, burning: false, vy: 0,
          }
          rendered.set(c.id, r)
        }
        r.x = c.px + (c.x - c.px) * alpha
        r.y = c.py + (c.y - c.py) * alpha
        r.z = c.pz + (c.z - c.pz) * alpha
        r.yaw = c.pyaw + wrap(c.yaw - c.pyaw) * alpha
        r.speed = Math.hypot(c.vx, c.vz)
        r.st = c.st
        r.stT = c.kind.behaviour === 'creeper' ? c.fuse : c.stT
        r.hurtT = c.hurtT
        r.deadT = c.deadT
        r.burning = c.burning
        r.vy = c.vy
        renderList.push(r)
      }
      return renderList
    },
    on: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    hit,
    blast,
    spawn,
    adopt: (rows) => {
      for (const r of rows) {
        const kind = kindOf(r.kind)
        if (!kind || creatures.has(r.id)) continue
        const c = make(kind, r.x, r.y, r.z)
        c.id = r.id
        c.yaw = c.pyaw = r.yaw
        c.hp = Math.max(1, r.hp)
        if (r.st === S.DEAD) {
          c.st = S.DEAD
          c.deadT = 0.2
        }
        if (kind.behaviour === 'arrow') continue
        creatures.set(c.id, c)
      }
    },
    remove: (id) => {
      const c = creatures.get(id)
      if (c) drop(c)
    },
    clear: () => {
      restock = false
      for (const c of [...creatures.values()]) drop(c)
    },
    counts,
    configure,
    populate,
  }
}

/** can a body stand here: re-exported so callers need not reach for world.ts */
export { canStand }
export type { MobAttack }
