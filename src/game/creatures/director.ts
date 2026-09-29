import * as THREE from 'three'
import { KINDS } from '../sandbox/kinds'
import type { Sandbox } from '../sandbox/sandbox'
import type { ExplosionEvent } from '../sandbox/explosion'
import type { ImpactWatch, Impact } from '../player/impacts'
import {
  ATTACK, CREATURE_HZ, MAX_ROWS, decodeRow, rowOf, ROW_BURN, ROW_HURT,
  type CreatureClientMessage, type CreatureServerMessage,
} from '../net/creatureProtocol'
import { createRemoteCreatures, type RemoteEvent } from '../net/remoteCreatures'
import { kindNamed, kindOf, SPAWNABLE, type CreatureKind } from './kinds'
import { arrowShot, creatureThump, creatureVoice } from './sounds'
import { createCreatureSim, S, type Creature, type CreatureEvent, type CreatureSim, type RenderCreature } from './sim'
import { createCreatureView, type CreatureView } from './view'
import type { CreatureEnv, CreatureWorld, MobAttack, PlayerRef } from './world'

/*
  The creatures of one level, on one machine: the seam between the headless
  simulation, the wire, the sounds and the drawing.

  A director always holds three things and uses two: the **simulation**
  (sim.ts), which only steps while this machine is the host; a **remote
  store** (net/remoteCreatures.ts) that interpolates what the host says, used
  while it is not; and the **view** (view.ts), which draws whichever of them
  is live as instances on the sandbox's props batches. Which role this
  machine has is the server's call (`world-creature-host`, the
  longest-present player of the scope); offline it is always the host. A
  machine that becomes the host adopts the herd it was watching, so a handover
  is a change of who thinks, not a change of what is there.

  Everything the rest of the game does to a creature comes through here:
  - `knock(watch)` is the town's crowd seam (player/impacts.ts): the pistol,
    the crossbow, a car and anything else that can knock a person flat asks
    each creature the same question it asks a pedestrian, and the shove it
    answers with is turned into damage (a pistol round is a couple of hits on
    a pig, a bolt kills a zombie, a car at speed kills anything);
  - `explosion()` is `sb.onExplosion`: only the host applies a blast (a
    rocket fired on any client reaches it as the explosion relay's replay),
    with a falloff and a shove;
  - a prop thrown or carried hard into a creature hurts it (`propBlows`), so
    the physgun is a weapon;
  - hits from other clients arrive as `world-creature-hit` and are applied by
    the host; a client that is not the host sends its own.

  Mob damage to a person leaves through `env.hurtPlayer`, which the scene
  turns into the health system's business: online it is a
  `world-creature-attack` for the server to validate and apply (the amount is
  the server's number, not this one), and only offline does it become a bare
  knockback, because there are no hit points to spend.

  The dead leave their `drops` as props flagged as gibs where the level lets
  them (Cubeland), so the sandbox's own breakables sweep them up.
*/

export interface DirectorOpts {
  world: CreatureWorld
  sb: Sandbox
  level: string
  /** the walker first, then everyone else in this level */
  players: () => Iterable<PlayerRef>
  /** 0 night .. 1 day, as drawn */
  daylight: () => number
  send: (m: CreatureClientMessage) => void
  online: () => boolean
  /** our id on the server, if we have one */
  you: () => number | null
  /** the body of ours a mob shoved (offline only; online the server sends it) */
  knockSelf: (vx: number, vz: number) => void
  now?: () => number
  random?: () => number
}

export interface CreatureDirector {
  readonly host: boolean
  readonly view: CreatureView
  /** what was drawn last frame (the harness, and anything aiming) */
  rendered: () => readonly RenderCreature[]
  readonly sim: CreatureSim
  /** one frame: sim or playback, then the view. `active` false holds the world */
  update: (dt: number, active: boolean, looks: readonly PlayerRef[]) => void
  /** a server message for this level */
  receive: (m: CreatureServerMessage) => void
  /** the people seam: weapons, cars and blasts asking each creature */
  knock: (watch: ImpactWatch) => void
  explosion: (e: ExplosionEvent) => void
  /** the console. Resolves to a line for the player */
  command: (op: 'on' | 'off' | 'clear' | 'peaceful' | 'hostile') => void
  spawn: (kind: string, x: number, z: number) => 'ok' | 'unknown' | 'refused' | 'asked'
  count: () => { alive: number; passive: number; hostile: number; arrows: number; host: boolean; on: boolean; peaceful: boolean }
  /** forget everything: the level was left */
  reset: () => void
  dispose: () => void
}

const SNAPSHOT_EVERY = 1 / CREATURE_HZ
const BLOW_SPEED = 9
const BLOW_COOLDOWN = 0.5

export function createCreatureDirector(o: DirectorOpts): CreatureDirector {
  const { world, sb } = o
  const now = o.now ?? (() => performance.now())
  const remote = createRemoteCreatures()
  const view = createCreatureView(sb.root)
  let hostId = 0
  let on = true
  let peaceful = false
  let isHost = !o.online()
  let snapT = 0
  let inCreeperBlast = false
  let propT = 0
  let fireT = 0
  let lastList: readonly RenderCreature[] = []
  const sayAt = new Map<number, number>()
  const blowAt = new Map<number, number>()
  const tmpV = new THREE.Vector3()
  const feet = new THREE.Vector3()
  const impact: Impact = { impulse: new THREE.Vector3(), point: new THREE.Vector3() }
  const fxAt = { x: 0, y: 0, z: 0 }

  /* --------------------------------------------------------- the sim -- */

  const env: CreatureEnv = {
    players: o.players,
    daylight: o.daylight,
    hurtPlayer: (a: MobAttack) => {
      const victim = a.victim || (o.you() ?? 0)
      if (o.online() && victim) {
        o.send({
          type: 'world-creature-attack', level: o.level, id: a.creature, victim,
          atk: a.atk === 'melee' ? ATTACK.melee : a.atk === 'arrow' ? ATTACK.arrow : ATTACK.blast,
        })
      }
      // (online, the server sends the shove to whoever it hurt, this body included)
      if (!o.online() && !a.victim) o.knockSelf(a.dx * a.push, a.dz * a.push)
    },
    explode: (x, y, z, power, radius) => {
      inCreeperBlast = true
      try {
        sb.explode({ x, y, z }, power, radius)
      } finally {
        inCreeperBlast = false
      }
    },
  }
  const sim = createCreatureSim({ world, env, random: o.random })

  /** what one creature leaves behind, as props flagged as gibs */
  const dropFor = (kind: CreatureKind, x: number, y: number, z: number) => {
    if (!world.drops) return
    for (const d of kind.drops) {
      if (!KINDS[d.kind]) continue
      const n = d.n[0] + Math.floor(Math.random() * (d.n[1] - d.n[0] + 1))
      for (let i = 0; i < n; i++) {
        sb.spawn(d.kind, { x: x + (Math.random() - 0.5) * 0.8, y: y + kind.h * 0.6, z: z + (Math.random() - 0.5) * 0.8 }, {
          velocity: { x: (Math.random() - 0.5) * 6, y: 5 + Math.random() * 3, z: (Math.random() - 0.5) * 6 },
          data: { gib: true, mob: true },
          phase: 0.2,
          scale: 0.55,
        })
      }
    }
  }

  const voiceAt = (kind: CreatureKind, mood: 'idle' | 'hurt' | 'death', x: number, y: number, z: number, id: number) => {
    const pitch = 0.88 + (((id * 2654435761) >>> 0) % 1000) / 1000 * 0.3
    creatureVoice(kind.voices[mood], mood, x, y + kind.h * 0.6, z, pitch * (kind.h < 1.5 ? 1.25 : 1))
  }

  sim.on((e: CreatureEvent) => {
    switch (e.t) {
      case 'hurt':
        voiceAt(e.c.kind, 'hurt', e.c.x, e.c.y, e.c.z, e.c.id)
        creatureThump(e.c.x, e.c.y + 1, e.c.z, Math.min(1, e.amount / 20))
        break
      case 'die': {
        const c = e.c
        voiceAt(c.kind, 'death', c.x, c.y, c.z, c.id)
        if (e.byPlayer && !c.kind.revive) dropFor(c.kind, c.x, c.y, c.z)
        if (o.online() && !c.kind.revive) {
          o.send({
            type: 'world-creature-die', level: o.level, id: c.id, kind: c.kind.index,
            x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, z: Math.round(c.z * 10) / 10, by: e.byPlayer ? 1 : 0,
          })
        }
        break
      }
      case 'say':
        voiceAt(e.c.kind, 'idle', e.c.x, e.c.y, e.c.z, e.c.id)
        break
      case 'fuse':
        creatureVoice('hiss', 'idle', e.c.x, e.c.y + 1.5, e.c.z)
        break
      case 'shoot':
        arrowShot(e.c.x, e.c.y + 3, e.c.z)
        break
      case 'remove':
        sayAt.delete(e.c.id)
        blowAt.delete(e.c.id)
        break
      case 'spawn':
      case 'explode':
      case 'revive':
        break
    }
  })

  remote.on((e: RemoteEvent) => {
    switch (e.t) {
      case 'hurt':
        voiceAt(e.r.kind, 'hurt', e.r.x, e.r.y, e.r.z, e.r.id)
        creatureThump(e.r.x, e.r.y + 1, e.r.z, 0.5)
        break
      case 'fuse':
        creatureVoice('hiss', 'idle', e.r.x, e.r.y + 1.5, e.r.z)
        break
      case 'shoot':
        arrowShot(e.r.x, e.r.y, e.r.z)
        break
      case 'gone':
        sayAt.delete(e.id)
        break
      case 'die-row':
        break
    }
  })

  /* ------------------------------------------------------------- roles -- */

  const becomeHost = () => {
    if (isHost) return
    isHost = true
    sim.configure({ enabled: on, peaceful })
    if (!sim.creatures.size && remote.count) sim.adopt(remote.rows())
    remote.clear()
    if (!sim.creatures.size) sim.populate()
  }
  const becomeGuest = () => {
    if (!isHost) return
    isHost = false
    sim.clear()
  }
  const settle = () => {
    const should = !o.online() || (hostId !== 0 && hostId === o.you())
    if (should) becomeHost()
    else becomeGuest()
  }
  if (isHost) sim.populate()

  /* ---------------------------------------------------------- damage -- */

  /** a blow on a creature from this machine: applied here if we are the host,
      sent to the host if not */
  const strike = (id: number, view: RenderCreature | null, amount: number, kx: number, kz: number, by = true) => {
    if (isHost) {
      sim.hit(id, amount, kx, kz, by)
      return
    }
    if (!o.online()) return
    o.send({
      type: 'world-creature-hit', level: o.level, id, amount: Math.round(amount * 10) / 10,
      kx: Math.round(kx * 10) / 10, kz: Math.round(kz * 10) / 10,
    })
    remote.poke(id, now())
    if (view) creatureThump(view.x, view.y + 1, view.z, Math.min(1, amount / 20))
  }

  const alive = (): Iterable<{ id: number; kind: CreatureKind; x: number; y: number; z: number; key: object; dead: boolean; view: RenderCreature | null }> => {
    const out: Array<{ id: number; kind: CreatureKind; x: number; y: number; z: number; key: object; dead: boolean; view: RenderCreature | null }> = []
    if (isHost) {
      for (const c of sim.creatures.values()) {
        if (c.kind.behaviour === 'arrow') continue
        out.push({ id: c.id, kind: c.kind, x: c.x, y: c.y, z: c.z, key: c, dead: c.st === S.DEAD, view: null })
      }
    } else {
      for (const v of remote.views.values()) {
        if (v.kind.behaviour === 'arrow') continue
        out.push({ id: v.id, kind: v.kind, x: v.x, y: v.y, z: v.z, key: v, dead: v.st === S.DEAD, view: v })
      }
    }
    return out
  }

  /** a shove into damage: the closing speed above a stumble, twice over */
  const damageOf = (dv: number) => Math.max(0, (dv - 2) * 2.2)

  const knock: CreatureDirector['knock'] = (watch) => {
    for (const a of alive()) {
      if (a.dead) continue
      feet.set(a.x, a.y, a.z)
      if (!watch.strike(a.key, feet, a.kind.h, a.kind.mass, impact)) continue
      const m = a.kind.mass
      const dvx = impact.impulse.x / m
      const dvy = impact.impulse.y / m
      const dvz = impact.impulse.z / m
      const dv = Math.hypot(dvx, dvy, dvz)
      const amount = damageOf(dv)
      if (amount <= 0) continue
      strike(a.id, a.view, amount, dvx, dvz)
    }
  }

  const explosion: CreatureDirector['explosion'] = (e) => {
    // only the host applies a blast: a rocket fired anywhere reaches it as
    // the relay's replay, and applying it on every client would count it n times
    if (!isHost || inCreeperBlast) return
    sim.blast(e.x, e.y, e.z, e.radius, e.power, true)
  }

  /** props flying into creatures: the physgun (and a thrown crate) as a weapon */
  const propBlows = () => {
    const t = now() / 1000
    const list = [...alive()]
    for (const a of list) {
      if (a.dead) continue
      const cool = blowAt.get(a.id) ?? 0
      if (t < cool) continue
      const best = { speed: 0, mass: 0, vx: 0, vz: 0, found: false }
      sb.queryBall({ x: a.x, y: a.y + a.kind.h * 0.5, z: a.z }, a.kind.r + a.kind.h * 0.5 + 0.6, (p) => {
        if (p.data.gib || p.parked || p.mode !== 'dynamic') return
        if (!sb.getVelocity(p.id, tmpV)) return
        const speed = tmpV.length()
        if (speed > BLOW_SPEED && (!best.found || speed * p.mass > best.speed * best.mass)) {
          best.found = true
          best.speed = speed
          best.mass = p.mass
          best.vx = tmpV.x
          best.vz = tmpV.z
        }
      })
      if (!best.found) continue
      const h = best
      blowAt.set(a.id, t + BLOW_COOLDOWN)
      const amount = Math.min(40, (h.speed - BLOW_SPEED + 4) * Math.min(3, h.mass / 25 + 0.4))
      strike(a.id, a.view, amount, h.vx * 0.5, h.vz * 0.5)
    }
  }

  /* -------------------------------------------------------------- wire -- */

  const rows = () => {
    const out = []
    for (const c of sim.creatures.values()) {
      if (out.length >= MAX_ROWS) break
      const flags = c.st | (c.hurtT < 0.25 ? ROW_HURT : 0) | (c.burning ? ROW_BURN : 0)
      out.push(rowOf(c.id, c.kind.index, c.x, c.y, c.z, c.yaw, Math.ceil(c.hp), flags))
    }
    return out
  }

  const receive: CreatureDirector['receive'] = (m) => {
    if (m.type === 'world-creature-no' || m.type === 'world-creature-knock') return
    if (m.level !== o.level) return
    switch (m.type) {
      case 'world-creature-host':
        hostId = m.host
        on = m.on
        peaceful = m.peaceful
        sim.configure({ enabled: on, peaceful })
        settle()
        break
      case 'world-creatures':
        if (isHost) {
          if (!m.rows.length) sim.clear()
          else if (!sim.creatures.size) {
            sim.adopt(m.rows.map((r) => {
              const d = decodeRow(r)
              return { id: d.id, kind: d.kind, x: d.x, y: d.y, z: d.z, yaw: d.yaw, hp: d.hp, st: d.st }
            }))
          }
        } else {
          remote.receive(m.rows, now())
          if (!m.rows.length) remote.clear()
        }
        break
      case 'world-creature-die': {
        const kind = kindOf(m.kind)
        if (!kind || isHost) break
        voiceAt(kind, 'death', m.x, m.y, m.z, m.id)
        if (m.by === 1 && !kind.revive) dropFor(kind, m.x, m.y, m.z)
        break
      }
      case 'world-creature-hit':
        if (isHost) sim.hit(m.id, m.amount, m.kx, m.kz, true)
        break
      case 'world-creature-spawn':
        if (isHost) sim.spawn(KINDS_BY_INDEX(m.kind), m.x, m.z)
        break
    }
  }
  const KINDS_BY_INDEX = (i: number) => kindOf(i)?.id ?? ''

  /* ------------------------------------------------------------- frame -- */

  const update: CreatureDirector['update'] = (dt, active, looks) => {
    const t = now() / 1000
    let list: readonly RenderCreature[]
    if (isHost) {
      if (active) {
        sim.update(dt)
        snapT += dt
        if (snapT >= SNAPSHOT_EVERY) {
          snapT = 0
          let others = 0
          for (const p of o.players()) if (!p.self) others++
          if (o.online() && others > 0) o.send({ type: 'world-creatures', level: o.level, rows: rows() })
        }
        propT += dt
        if (propT > 0.12) {
          propT = 0
          propBlows()
        }
      }
      list = sim.render()
    } else {
      list = remote.sample(now())
      propT += dt
      if (active && propT > 0.12) {
        propT = 0
        propBlows()
      }
      // idle voices for what the host's rows cannot say
      for (const r of list) {
        if (r.deadT >= 0 || r.kind.voices.idle === 'none') continue
        const at = sayAt.get(r.id)
        if (at === undefined) {
          sayAt.set(r.id, t + r.kind.chatter[0] + Math.random() * (r.kind.chatter[1] - r.kind.chatter[0]))
        } else if (t > at) {
          sayAt.set(r.id, t + r.kind.chatter[0] + Math.random() * (r.kind.chatter[1] - r.kind.chatter[0]))
          voiceAt(r.kind, 'idle', r.x, r.y, r.z, r.id)
        }
      }
    }
    lastList = list
    view.update(list, dt, t, looks)
    // the burning throw fire
    fireT -= dt
    if (fireT <= 0) {
      fireT = 0.12
      for (const r of list) {
        if (!r.burning || r.deadT >= 0) continue
        fxAt.x = r.x
        fxAt.y = r.y + r.kind.h * 0.6
        fxAt.z = r.z
        sb.fx.burn(fxAt, 1)
      }
    }
  }

  return {
    get host() {
      return isHost
    },
    view,
    rendered: () => lastList,
    sim,
    update,
    receive,
    knock,
    explosion,
    command: (op) => {
      if (o.online()) {
        o.send({ type: 'world-creature-cmd', level: o.level, cmd: op === 'hostile' ? 'war' : op })
        return
      }
      if (op === 'on' || op === 'off') {
        on = op === 'on'
        sim.configure({ enabled: on })
      } else if (op === 'peaceful' || op === 'hostile') {
        peaceful = op === 'peaceful'
        sim.configure({ peaceful })
      } else sim.clear()
    },
    spawn: (kind, x, z) => {
      const k = kindNamed(kind)
      if (!k || !SPAWNABLE.includes(k.id)) return 'unknown'
      if (isHost) return sim.spawn(kind, x, z) ? 'ok' : 'refused'
      if (!o.online()) return 'refused'
      o.send({ type: 'world-creature-spawn', level: o.level, kind: k.index, x, z })
      return 'asked'
    },
    count: () => {
      const c = isHost
        ? sim.counts()
        : (() => {
            let passive = 0
            let hostile = 0
            let arrows = 0
            for (const v of remote.views.values()) {
              const b = v.kind.behaviour
              if (b === 'arrow') arrows++
              else if (b === 'passive') passive++
              else hostile++
            }
            return { alive: passive + hostile, passive, hostile, arrows }
          })()
      return { ...c, host: isHost, on, peaceful }
    },
    reset: () => {
      sim.clear()
      remote.clear()
      hostId = 0
      isHost = !o.online()
      if (isHost) sim.populate()
      sayAt.clear()
      blowAt.clear()
      snapT = 0
    },
    dispose: () => {
      view.dispose()
      sim.clear()
      remote.clear()
    },
  }
}

export type { Creature }
