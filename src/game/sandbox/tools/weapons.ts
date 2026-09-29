import * as THREE from 'three'
import type { Prop, PropId, Sandbox } from '../sandbox'
import type { ImpactWatch } from '../../player/impacts'
import type { WorldServerMessage } from '../../net/protocol'
import { WIRE_WEAPONS, type WeaponClientMessage, type WireWeapon } from '../../net/weaponProtocol'
import type { ToolInput } from './types'

/*
  The weapons: a pistol, a crossbow and a rocket launcher, as plain numbers.
  What a gun does when the trigger goes, what its shot does to whatever it
  meets, and what everybody else is shown of it. Nothing here draws or
  plays anything: weaponView.ts turns `projectiles`, `stuck` and `tracers`
  into meshes, weaponSfx.ts turns the events into sound, and headless (the
  measure harness, a future authoritative server) the whole thing runs on a
  bare sandbox.

  **The three guns.** The pistol is hitscan: the ray from the eye down the
  crosshair, the first thing on it takes a small push and a knock in the
  breakables' currency (a crate goes in three, a red barrel catches on the
  first and goes on the second), a player a stumble, and a tracer runs from
  the muzzle to the hit. It never runs dry: held down it fires about seven
  a second for as long as you hold it (the magazine and reload are still
  here, behind `clip: 0`, if a clip is ever wanted back). The crossbow looses a
  bolt that flies an arc under a third of the level's gravity and sticks
  where it lands, in the ground, a wall or a prop (and rides the prop from
  then on); a prop takes a hard shove and a blow that breaks a crate
  outright, and a player is knocked flat. Stuck bolts are cleaned up after
  a while and past a cap. The rocket launcher fires a rocket that flies
  straight, slower than a bullet, trailing the fleet's thruster flame and
  smoke (fx.ts's `thrust`, so no new particle), and goes off on the first
  thing it touches, or at the end of its range, through `sb.explode`: the
  very call the `explode` console command makes. So a rocket throws props,
  breaks breakables and brings buildings and trees down exactly as that
  command does, knocks over whoever is standing in it (the scene's own
  `onExplosion` handler, which is also what makes rocket jumping work), and
  reaches other players' props and bodies through the explosion relay the
  prop network already runs (`world-prop-explosion`): every client replays
  the blast, each authority pushes its own props, and each player's own
  client knocks itself over.

  **Rockets and bolts go through portals.** A projectile whose step meets an
  open oval (or the collision box pad that stands proud of it) comes out of
  the partner carried by the pair, speed kept, the way a prop does; a pair
  that leads into another level is a wall to it. The pistol's ray does not.

  **A shot starts at the eye and is drawn from the gun.** A projectile flies
  the crosshair's own ray, so it lands where the crosshair said; what is
  drawn starts at the muzzle and eases onto that ray over a few frames
  (`off`, decaying), the old trick that keeps a rocket from leaving your
  face while still hitting what you aimed at.

  **Everybody sees every shot, and the shooter decides what it hit.** A
  shot is one `world-shot` (weapon, eye, direction, and for the pistol how
  far the ray went); every other client flies a cosmetic copy of it from
  the shooter's hands. The shooter's own client resolves the impact against
  its own world and relays it as a `world-shot-hit` (where, which shared
  prop and where on it a bolt stuck, the impulse for whoever simulates that
  prop, the player struck and the velocity their own client applies to
  itself through the shove taker, as a bump does). A remote copy that meets
  something first simply waits there for that verdict. A rocket's hit only
  ends its copy: the bang travels as the explosion relay's own message.

  Targets are asked for, never owned: the sandbox's ray for props, the
  ground and every solid; `vehicles` for the fleet; `players` for the other
  players' bodies (a vertical cylinder at their feet); `people` for the
  town's crowd, through the same `ImpactWatch` seam a car knocks them over
  with; `waterY` for the sea.
*/

export type WeaponId = WireWeapon
export const WEAPON_IDS: readonly WeaponId[] = WIRE_WEAPONS

interface Spec {
  /** seconds between shots */
  interval: number
  /** rounds before a reload (0: a reload is the interval) */
  clip: number
  /** a magazine's reload, seconds */
  reload: number
  /** held down it keeps firing */
  auto: boolean
}
export const SPECS: Record<WeaponId, Spec> = {
  // the pistol never runs dry: the owner wanted it to just keep shooting
  pistol: { interval: 0.14, clip: 0, reload: 0, auto: true },
  crossbow: { interval: 1.15, clip: 0, reload: 0, auto: false },
  rocket: { interval: 1.25, clip: 0, reload: 0, auto: false },
}

/* the pistol */
const PISTOL_RANGE = 300
/** in breakables' currency (a change of velocity): a crate's threshold is
    30, so this chips one three times; a red barrel's is 56, so it lights */
const PISTOL_DAMAGE = 29
/** the push, kg u/s, and the most it may change a light prop's speed */
const PISTOL_IMPULSE = 70
const PISTOL_DV = 14
/** a player hit: a stumble, well under the flop line (shove.ts's 6) */
const PISTOL_SHOVE = 3.5

/* the crossbow */
const BOLT_SPEED = 95
/** of the level's gravity */
const BOLT_DROP = 0.3
const BOLT_LIFE = 4
const BOLT_DAMAGE = 60
const BOLT_IMPULSE = 900
const BOLT_DV = 24
/** a player hit: over the flop line, and a little up */
const BOLT_SHOVE = 11
const BOLT_LIFT = 4
/** how deep a bolt buries its head */
const BURY = 0.35
/** stuck bolts: how many stay, and for how long */
const STUCK_MAX = 24
const STUCK_LIFE = 40

/* the rocket */
const ROCKET_SPEED = 62
const ROCKET_RANGE = 420
/** as `explode 1` with a slightly tighter ball: a red barrel's bang */
export const ROCKET_POWER = 1
export const ROCKET_RADIUS = 14

/** how far past a frame's step a projectile looks for a portal's pad */
const PORTAL_LOOK = 2
/** a remote copy that met something waits this long for the verdict */
const PARK_WAIT = 1.5
/** a player's body, for a ray: radius and height over the feet */
const BODY_R = 0.85
const BODY_H = 4.4

export interface WeaponTarget {
  id: number
  /** feet */
  x: number
  y: number
  z: number
  /** the cylinder to test, when it is not a body's (a prop-hunt disguise is
      the prop's shape) */
  r?: number
  h?: number
}

export interface WeaponWorld {
  /** the live level's sandbox */
  sb: () => Sandbox
  /** the fleet, as the beam sees it */
  vehicles?: { pick: (eye: THREE.Vector3, dir: THREE.Vector3, within: number) => { key: string; t: number } | null }
  /** the other players, feet positions as drawn */
  players?: () => Iterable<WeaponTarget>
  /** the town's crowd */
  people?: (watch: ImpactWatch) => void
  /** the sea's surface, if the level has one */
  waterY?: () => number | undefined
  /** the live level's id, for the wire */
  level?: () => string
  /** put a message on the wire (online only; offline, leave it unset or
      return nothing) */
  send?: (m: WeaponClientMessage) => void
  /** a shot of somebody else's struck us: our own body, our own call */
  shoved?: (vx: number, vy: number, vz: number) => void
  /** the first open portal a ray goes into within `reach`, leading out
      somewhere in this same level (portals.ts's `rayEnters`) */
  portal?: (eye: THREE.Vector3, dir: THREE.Vector3, reach: number) => PortalEntry | null
}

/** what `portal` answers: how far along the ray, where it goes in, the two
    ovals, and the map from one side to the other */
export interface PortalEntry {
  t: number
  at: THREE.Vector3
  from: { n: THREE.Vector3; inset: number }
  to: { n: THREE.Vector3; inset: number }
  M: THREE.Matrix4
}

export interface Projectile {
  w: 'crossbow' | 'rocket'
  pos: THREE.Vector3
  vel: THREE.Vector3
  /** drawn at pos + off; off eases to zero */
  off: THREE.Vector3
  age: number
  life: number
  /** ours (decides its impact) or a copy of somebody's */
  mine: boolean
  shooter: number
  seq: number
  /** a copy that met something and is waiting for the shooter's verdict */
  parked: number
}

export interface Stuck {
  pos: THREE.Vector3
  quat: THREE.Quaternion
  /** the prop it is in (local id), or -1 */
  prop: PropId
  /** its frame in that prop's space */
  local: THREE.Matrix4 | null
  age: number
}

export interface Tracer {
  from: THREE.Vector3
  to: THREE.Vector3
  age: number
  life: number
}

export type WeaponHitKind = 'world' | 'prop' | 'player' | 'vehicle' | 'water' | 'person' | 'air'

export type WeaponEvent =
  | { type: 'fire'; w: WeaponId; mine: boolean; x: number; y: number; z: number }
  | { type: 'hit'; w: WeaponId; mine: boolean; what: WeaponHitKind; surface: string; x: number; y: number; z: number }
  | { type: 'reload'; w: WeaponId }
  | { type: 'empty'; w: WeaponId }

export interface Weapons {
  readonly projectiles: readonly Projectile[]
  readonly stuck: readonly Stuck[]
  readonly tracers: readonly Tracer[]
  /** who else is holding which weapon (player id to weapon) */
  readonly wields: ReadonlyMap<number, WeaponId>
  /** 0 just fired (or mid-reload) to 1 ready */
  loaded: (w: WeaponId) => number
  /** rounds left in the pistol's magazine */
  ammo: (w: WeaponId) => number
  /** one frame of intent for the weapon in hand (null: none is out).
      `muzzle` is where the drawn shot starts (last frame's, fine) */
  update: (input: ToolInput, w: WeaponId | null, muzzle: THREE.Vector3 | null) => void
  /** fly everything; call once a frame */
  step: (dt: number) => void
  /** the network's side: shots, hits, wields; `muzzleOf` finds where a
      remote shooter's gun is drawn, for the copy to start from */
  receive: (m: WorldServerMessage, muzzleOf?: (id: number, out: THREE.Vector3) => boolean) => void
  /** what is in the local hands, for everybody else to see (sent on change) */
  wield: (w: WeaponId | null) => void
  /** the live sandbox changed (a level cut): the bolts in the old one go */
  retarget: () => void
  /** the socket went down: forget everybody else's */
  offline: () => void
  on: (fn: (e: WeaponEvent) => void) => () => void
}

/* ------------------------------------------------------------ geometry -- */

/** first t in [0, len] where the ray meets a vertical cylinder, or -1 */
export const rayCylinder = (
  o: THREE.Vector3, d: THREE.Vector3, len: number, cx: number, cz: number, r: number, y0: number, y1: number,
): number => {
  const ox = o.x - cx
  const oz = o.z - cz
  const a = d.x * d.x + d.z * d.z
  const b = 2 * (ox * d.x + oz * d.z)
  const c = ox * ox + oz * oz - r * r
  let t0: number
  let t1: number
  if (a < 1e-9) {
    if (c > 0) return -1
    t0 = -Infinity
    t1 = Infinity
  } else {
    const disc = b * b - 4 * a * c
    if (disc < 0) return -1
    const s = Math.sqrt(disc)
    t0 = (-b - s) / (2 * a)
    t1 = (-b + s) / (2 * a)
  }
  if (Math.abs(d.y) < 1e-9) {
    if (o.y < y0 || o.y > y1) return -1
  } else {
    let ta = (y0 - o.y) / d.y
    let tb = (y1 - o.y) / d.y
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
  }
  t0 = Math.max(t0, 0)
  t1 = Math.min(t1, len)
  return t0 <= t1 ? t0 : -1
}

/** how far apart the ground is sampled along a long ray */
const GROUND_STEP = 2

/** first t in [0, len] where the ray goes under the drawn ground, or -1 */
const groundAlong = (sb: Sandbox, o: THREE.Vector3, d: THREE.Vector3, len: number): number => {
  const under = (t: number) => o.y + d.y * t < sb.groundY(o.x + d.x * t, o.z + d.z * t)
  if (under(0)) return -1
  let lo = 0
  for (let t = Math.min(GROUND_STEP, len); ; t = Math.min(t + GROUND_STEP, len)) {
    if (under(t)) {
      let hi = t
      for (let i = 0; i < 8; i++) {
        const m = (lo + hi) / 2
        if (under(m)) hi = m
        else lo = m
      }
      return hi
    }
    lo = t
    if (t >= len) return -1
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 10000) / 10000
const v3 = (v: { x: number; y: number; z: number }) => [r2(v.x), r2(v.y), r2(v.z)]

const debrisOf = (surface: string): 'wood' | 'glass' | 'melon' | 'plastic' | 'metal' =>
  surface === 'wood' || surface === 'glass' || surface === 'melon' ? surface
    : surface === 'metal' || surface === 'drum' || surface === 'sheet' ? 'metal' : 'plastic'

interface Hit {
  t: number
  what: WeaponHitKind
  point: THREE.Vector3
  normal: THREE.Vector3
  prop: Prop | null
  player: number
  surface: string
}

export function createWeapons(o: WeaponWorld): Weapons {
  const fns = new Set<(e: WeaponEvent) => void>()
  const emit = (e: WeaponEvent) => {
    for (const fn of fns) fn(e)
  }
  const projectiles: Projectile[] = []
  const stuck: Stuck[] = []
  const tracers: Tracer[] = []
  const wields = new Map<number, WeaponId>()
  let you = 0
  let seq = 0
  let wieldSent: number | null = null

  /* per-gun state: cooldown, rounds, reload */
  const cool: Record<WeaponId, number> = { pistol: 0, crossbow: 0, rocket: 0 }
  const rounds: Record<WeaponId, number> = { pistol: SPECS.pistol.clip, crossbow: 1, rocket: 1 }
  let reloading = 0
  let fireWas = false
  let reloadWas = false

  const tmp = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  const dirN = new THREE.Vector3()
  const hitOut: Hit = { t: 0, what: 'air', point: new THREE.Vector3(), normal: new THREE.Vector3(), prop: null, player: 0, surface: '' }
  const propPos = new THREE.Vector3()
  const propQuat = new THREE.Quaternion()
  const m4 = new THREE.Matrix4()
  const m4b = new THREE.Matrix4()
  const one = new THREE.Vector3(1, 1, 1)
  const zAxis = new THREE.Vector3(0, 0, -1)

  /**
   * The first thing along a ray, or null. `people` is how a person on the
   * ray is treated: 'probe' only notes the nearest, 'knock' strikes them.
   */
  const trace = (
    from: THREE.Vector3, d: THREE.Vector3, len: number, people: 'probe' | 'knock' | 'none', shove = 0, skip = 0,
  ): Hit | null => {
    const sb = o.sb()
    let best = len
    let hit: Hit | null = null
    const r = sb.raycast(from, d, len, { props: true, world: true })
    if (r && r.distance <= best) {
      best = r.distance
      hit = hitOut
      hit.t = r.distance
      hit.point.copy(r.point)
      hit.normal.copy(r.normal)
      hit.prop = r.prop
      hit.player = 0
      hit.what = r.prop ? 'prop' : 'world'
      hit.surface = r.prop ? (r.prop.kind.surface ?? 'wood') : r.ground ? 'soft' : 'concrete'
    }
    // the drawn ground, marched: Rapier only mirrors the ground and the
    // solids in the chunks round the walker and under props, and a shot
    // goes further than that
    const gt = groundAlong(sb, from, d, best)
    if (gt >= 0 && gt < best) {
      best = gt
      hit = hitOut
      hit.t = gt
      hit.point.copy(from).addScaledVector(d, gt)
      hit.normal.set(0, 1, 0)
      hit.prop = null
      hit.player = 0
      hit.what = 'world'
      hit.surface = 'soft'
    }
    const v = o.vehicles?.pick(from as THREE.Vector3, d as THREE.Vector3, best)
    if (v && v.t < best) {
      best = v.t
      hit = hitOut
      hit.t = v.t
      hit.point.copy(from).addScaledVector(d, v.t)
      hit.normal.copy(d).negate()
      hit.prop = null
      hit.player = 0
      hit.what = 'vehicle'
      hit.surface = 'metal'
    }
    if (o.players) {
      for (const p of o.players()) {
        // (a copy of somebody's shot starts inside their own body)
        if (p.id === skip) continue
        const t = rayCylinder(from, d, best, p.x, p.z, p.r ?? BODY_R, p.y, p.y + (p.h ?? BODY_H))
        if (t >= 0 && t < best) {
          best = t
          hit = hitOut
          hit.t = t
          hit.point.copy(from).addScaledVector(d, t)
          hit.normal.copy(d).negate()
          hit.prop = null
          hit.player = p.id
          hit.what = 'player'
          hit.surface = 'soft'
        }
      }
    }
    const wy = o.waterY?.()
    if (wy !== undefined && Number.isFinite(wy) && from.y > wy && d.y < -1e-4) {
      const t = (wy - from.y) / d.y
      if (t >= 0 && t < best) {
        best = t
        hit = hitOut
        hit.t = t
        hit.point.copy(from).addScaledVector(d, t)
        hit.normal.set(0, 1, 0)
        hit.prop = null
        hit.player = 0
        hit.what = 'water'
        hit.surface = 'water'
      }
    }
    if (people !== 'none' && o.people) {
      let near = best
      o.people({
        track: () => {},
        strike: (_key, feet, height, mass, out) => {
          const t = rayCylinder(from, d, near, feet.x, feet.z, 0.8, feet.y, feet.y + height)
          if (t < 0) return false
          near = t
          if (people !== 'knock') return false
          out.impulse.copy(d).multiplyScalar(shove * mass)
          out.impulse.y += BOLT_LIFT * mass
          out.point.copy(from).addScaledVector(d, t)
          return true
        },
      })
      if (near < best) {
        hit = hitOut
        hit.t = near
        hit.point.copy(from).addScaledVector(d, near)
        hit.normal.copy(d).negate()
        hit.prop = null
        hit.player = 0
        hit.what = 'person'
        hit.surface = 'soft'
      }
    }
    return hit
  }

  const netId = (p: Prop | null | undefined): number | undefined => {
    const n = p?.data.net
    return typeof n === 'number' ? n : undefined
  }
  const localOf = (net: number): PropId | null => {
    let id: PropId | null = null
    o.sb().forEach((p) => {
      if (p.data.net === net) id = p.id
    })
    return id
  }
  const online = () => !!you && !!o.send
  const send = (m: WeaponClientMessage) => {
    if (online()) o.send!(m)
  }
  const level = () => o.level?.() ?? ''

  /** push a prop: here if we simulate it, else through the hit message */
  const pushProp = (p: Prop, d: THREE.Vector3, imp: number, dv: number, at: THREE.Vector3): number[] | undefined => {
    const sb = o.sb()
    const j = Math.min(imp, p.mass * dv)
    tmp2.copy(d).multiplyScalar(j)
    if (sb.isAuthority(p.id)) {
      if (p.mode === 'dynamic') {
        sb.wake(p.id)
        sb.applyImpulse(p.id, tmp2, at)
      }
      return undefined
    }
    return v3(tmp2)
  }

  const addStuck = (at: THREE.Vector3, heading: THREE.Vector3, prop: PropId, local: THREE.Matrix4 | null) => {
    if (stuck.length >= STUCK_MAX) stuck.shift()
    const s: Stuck = {
      pos: at.clone(),
      quat: new THREE.Quaternion().setFromUnitVectors(zAxis, tmp.copy(heading).normalize()),
      prop, local, age: 0,
    }
    stuck.push(s)
    return s
  }

  /** the bolt's frame inside a prop, for it to ride along */
  const frameIn = (p: Prop, at: THREE.Vector3, q: THREE.Quaternion) => {
    if (!o.sb().getTransform(p.id, propPos, propQuat)) return null
    m4.compose(propPos, propQuat, one).invert()
    m4b.compose(at, q, one)
    return new THREE.Matrix4().multiplyMatrices(m4, m4b)
  }

  /** our own shot met `h`, heading `d` */
  const land = (w: WeaponId, s: number, h: Hit | null, from: THREE.Vector3, d: THREE.Vector3) => {
    const sb = o.sb()
    const msg: Extract<WeaponClientMessage, { type: 'world-shot-hit' }> = {
      type: 'world-shot-hit', level: level(), w: WEAPON_IDS.indexOf(w), seq: s, at: [0, 0, 0],
    }
    let relay = false
    if (!h) {
      // the end of a rocket's range: it goes off in the air
      if (w === 'rocket') {
        msg.at = v3(from)
        send(msg)
        sb.explode(from, ROCKET_POWER, ROCKET_RADIUS)
        emit({ type: 'hit', w, mine: true, what: 'air', surface: '', x: from.x, y: from.y, z: from.z })
      }
      return
    }
    const at = h.point
    msg.at = v3(at)
    if (w === 'rocket') {
      // the explosion is the command's own: it relays itself
      tmp.copy(at).addScaledVector(d, -0.4)
      send(msg)
      sb.explode(tmp, ROCKET_POWER, ROCKET_RADIUS)
      emit({ type: 'hit', w, mine: true, what: h.what, surface: h.surface, x: at.x, y: at.y, z: at.z })
      return
    }
    const bolt = w === 'crossbow'
    if (h.what === 'prop' && h.prop) {
      const p = h.prop
      const imp = pushProp(p, d, bolt ? BOLT_IMPULSE : PISTOL_IMPULSE, bolt ? BOLT_DV : PISTOL_DV, at)
      const id = netId(p)
      if (id !== undefined) {
        msg.prop = id
        if (imp) msg.imp = imp
        relay = true
      }
      if (bolt) {
        tmp.copy(at).addScaledVector(d, BURY)
        const q = new THREE.Quaternion().setFromUnitVectors(zAxis, dirN.copy(d).normalize())
        const local = frameIn(p, tmp, q)
        if (local) {
          addStuck(tmp, d, p.id, local)
          if (id !== undefined) {
            const lp = new THREE.Vector3()
            const lq = new THREE.Quaternion()
            local.decompose(lp, lq, tmp2)
            msg.fr = [r2(lp.x), r2(lp.y), r2(lp.z), r4(lq.x), r4(lq.y), r4(lq.z), r4(lq.w)]
          }
        }
        msg.d = v3(d)
      }
      // after the push, so what it breaks hands its pieces the shove
      sb.damage(p.id, bolt ? BOLT_DAMAGE : PISTOL_DAMAGE, at)
      if (!bolt) sb.fx.debris(debrisOf(h.surface), at, tmp.copy(h.normal).multiplyScalar(3), 0.25)
    } else if (h.what === 'player') {
      const k = bolt ? BOLT_SHOVE : PISTOL_SHOVE
      const hz = Math.hypot(d.x, d.z) || 1
      msg.player = h.player
      msg.v = [r2((d.x / hz) * k), bolt ? BOLT_LIFT : 0, r2((d.z / hz) * k)]
      relay = true
    } else if (bolt && (h.what === 'world')) {
      tmp.copy(at).addScaledVector(d, BURY)
      addStuck(tmp, d, -1, null)
      msg.d = v3(d)
      relay = true
    }
    if (h.what !== 'prop') puff(w, h)
    // the pistol's shot already said where it went; a bolt always says
    if (relay || bolt) send(msg)
    emit({ type: 'hit', w, mine: true, what: h.what, surface: h.surface, x: at.x, y: at.y, z: at.z })
  }

  /** the look of a hit that is not a prop's (a prop's is its own debris) */
  const puff = (w: WeaponId, h: { what: WeaponHitKind; point: THREE.Vector3; normal: THREE.Vector3 }) => {
    const fx = o.sb().fx
    if (h.what === 'water') fx.dust(h.point, w === 'pistol' ? 0.5 : 0.9)
    else if (h.what === 'vehicle') fx.zap(h.point, h.normal)
    else if (h.what === 'world' || h.what === 'air') fx.dust(h.point, w === 'pistol' ? 0.35 : 0.6)
  }

  /* --------------------------------------------------------- firing -- */

  const fire = (w: WeaponId, input: ToolInput, muzzle: THREE.Vector3 | null) => {
    const eye = input.aim.eye
    const d = dirN.copy(input.aim.dir).normalize()
    const s = ++seq
    const wi = WEAPON_IDS.indexOf(w)
    if (w === 'pistol') {
      const h = trace(eye, d, PISTOL_RANGE, 'none')
      const len = h ? h.t : PISTOL_RANGE
      tmp.copy(eye).addScaledVector(d, len)
      addTracer(muzzle ?? eye, tmp)
      send({ type: 'world-shot', level: level(), w: wi, seq: s, o: v3(eye), d: [r4(d.x), r4(d.y), r4(d.z)], len: r2(len) })
      emit({ type: 'fire', w, mine: true, x: eye.x, y: eye.y, z: eye.z })
      land(w, s, h, eye, d)
      return
    }
    const p: Projectile = {
      w, pos: eye.clone(), vel: d.clone().multiplyScalar(w === 'rocket' ? ROCKET_SPEED : BOLT_SPEED),
      off: muzzle ? muzzle.clone().sub(eye) : new THREE.Vector3(),
      age: 0, life: w === 'rocket' ? ROCKET_RANGE / ROCKET_SPEED : BOLT_LIFE, mine: true, shooter: you, seq: s, parked: 0,
    }
    projectiles.push(p)
    send({ type: 'world-shot', level: level(), w: wi, seq: s, o: v3(eye), d: [r4(d.x), r4(d.y), r4(d.z)] })
    emit({ type: 'fire', w, mine: true, x: eye.x, y: eye.y, z: eye.z })
  }

  const addTracer = (from: THREE.Vector3, to: THREE.Vector3) => {
    if (tracers.length >= 24) tracers.shift()
    tracers.push({ from: from.clone(), to: to.clone(), age: 0, life: Math.min(0.5, Math.max(0.05, from.distanceTo(to) / 420)) })
  }

  const update: Weapons['update'] = (input, w, muzzle) => {
    const dt = Math.max(0, Math.min(0.1, input.dt))
    for (const k of WEAPON_IDS) cool[k] = Math.max(0, cool[k] - dt)
    if (reloading > 0) {
      reloading = Math.max(0, reloading - dt)
      if (reloading === 0) rounds.pistol = SPECS.pistol.clip
    }
    if (!w) {
      fireWas = reloadWas = false
      return
    }
    const spec = SPECS[w]
    // R reloads a magazine that is not full
    if (w === 'pistol' && spec.clip > 0 && input.reload && !reloadWas && reloading === 0 && rounds.pistol < spec.clip) {
      reloading = spec.reload
      emit({ type: 'reload', w })
    }
    reloadWas = input.reload
    const pull = input.fire && (spec.auto || !fireWas)
    fireWas = input.fire
    if (!pull || cool[w] > 0) return
    if (w === 'pistol' && spec.clip > 0) {
      if (reloading > 0) return
      if (rounds.pistol <= 0) {
        reloading = spec.reload
        emit({ type: 'empty', w })
        emit({ type: 'reload', w })
        return
      }
      rounds.pistol--
    }
    cool[w] = spec.interval
    fire(w, input, muzzle)
    // the last round out starts the reload by itself
    if (w === 'pistol' && spec.clip > 0 && rounds.pistol === 0) {
      reloading = spec.reload
      emit({ type: 'reload', w })
    }
  }

  /* --------------------------------------------------------- flight -- */

  const seg = new THREE.Vector3()
  const next = new THREE.Vector3()
  const step = (dt: number) => {
    const sb = o.sb()
    const k = Math.max(0, dt) * (sb.timescale || 1)
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i]
      p.age += k
      p.off.multiplyScalar(Math.exp(-k * 9))
      if (p.parked > 0) {
        // a copy waiting for the verdict: it stays where it met something,
        // and a bolt that hears nothing sticks there on its own say-so
        p.parked -= k
        if (p.parked <= 0) {
          if (p.w === 'crossbow') addStuck(p.pos, p.vel, -1, null)
          projectiles.splice(i, 1)
        }
        continue
      }
      if (p.w === 'crossbow') p.vel.y += sb.gravity * BOLT_DROP * k
      next.copy(p.pos).addScaledVector(p.vel, k)
      seg.copy(next).sub(p.pos)
      const len = seg.length()
      if (len > 1e-6) {
        seg.multiplyScalar(1 / len)
        const h = trace(p.pos, seg, len, p.mine ? (p.w === 'rocket' ? 'probe' : 'knock') : 'none', BOLT_SHOVE, p.mine ? 0 : p.shooter)
        // an open portal ahead: its wall's collision box stands a pad proud
        // of the oval, so a hit on that pad is going in, not a hit
        const e = o.portal?.(p.pos, seg, len + PORTAL_LOOK)
        const pad = e ? (e.from.inset + 0.06) / Math.max(0.2, -seg.dot(e.from.n)) : 0
        if (e && e.t - pad <= len && !(h && h.t < e.t - pad)) {
          // out of the partner, carried by the pair, and past its own pad
          const speed = p.vel.length()
          p.vel.transformDirection(e.M)
          tmp.copy(p.vel)
          p.vel.multiplyScalar(speed)
          p.pos.copy(e.at).applyMatrix4(e.M)
            .addScaledVector(tmp, (e.to.inset + 0.06) / Math.max(0.2, tmp.dot(e.to.n)))
          p.off.set(0, 0, 0)
          continue
        }
        if (h) {
          if (p.mine) {
            projectiles.splice(i, 1)
            land(p.w, p.seq, h, h.point, seg)
          } else {
            p.pos.copy(h.point)
            p.parked = PARK_WAIT
          }
          continue
        }
      }
      p.pos.copy(next)
      if (p.w === 'rocket') {
        // its flame and smoke, from the tail, backward
        tmp.copy(p.vel).normalize()
        tmp2.copy(p.pos).add(p.off).addScaledVector(tmp, -0.55)
        tmp.negate()
        sb.fx.thrust(tmp2, tmp, p.vel, 1, k)
      }
      if (p.age >= p.life) {
        projectiles.splice(i, 1)
        if (p.mine) land(p.w, p.seq, null, p.pos, seg)
      }
    }
    for (let i = tracers.length - 1; i >= 0; i--) {
      tracers[i].age += dt
      if (tracers[i].age >= tracers[i].life) tracers.splice(i, 1)
    }
    for (let i = stuck.length - 1; i >= 0; i--) {
      const s = stuck[i]
      s.age += dt
      let gone = s.age > STUCK_LIFE
      if (!gone && s.prop >= 0 && s.local) {
        // riding a prop: gone with it
        if (!sb.get(s.prop) || !sb.getTransform(s.prop, propPos, propQuat)) gone = true
        else {
          m4.compose(propPos, propQuat, one).multiply(s.local)
          m4.decompose(s.pos, s.quat, tmp)
        }
      }
      if (gone) stuck.splice(i, 1)
    }
  }

  /* ---------------------------------------------------- the network -- */

  const vec = (a: number[] | undefined, out: THREE.Vector3) =>
    Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? out.set(a[0], a[1], a[2]) : null
  const from = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const at = new THREE.Vector3()
  const gun = new THREE.Vector3()

  const receive: Weapons['receive'] = (m, muzzleOf) => {
    switch (m.type) {
      case 'world-welcome':
        you = m.you
        wieldSent = null
        return
      case 'world-exit':
        wields.delete(m.id)
        return
      case 'world-wields':
        if (m.level !== level()) return
        wields.clear()
        for (const [id, w] of m.wields) if (WEAPON_IDS[w] && id !== you) wields.set(id, WEAPON_IDS[w])
        return
      case 'world-wield':
        if (m.id === you) return
        if (m.level !== level() || !WEAPON_IDS[m.w]) wields.delete(m.id)
        else wields.set(m.id, WEAPON_IDS[m.w])
        return
      case 'world-shot': {
        if (m.id === you || m.level !== level()) return
        const w = WEAPON_IDS[m.w]
        if (!w || !vec(m.o, from) || !vec(m.d, dir)) return
        dir.normalize()
        wields.set(m.id, w)
        const drawnFrom = muzzleOf?.(m.id, gun) ? gun : from
        emit({ type: 'fire', w, mine: false, x: from.x, y: from.y, z: from.z })
        if (w === 'pistol') {
          const len = Math.max(0, Math.min(PISTOL_RANGE, Number(m.len) || 0))
          at.copy(from).addScaledVector(dir, len)
          addTracer(drawnFrom, at)
          if (len < PISTOL_RANGE - 0.5) {
            // where it went: the same puff the shooter saw, give or take
            // what was under it here
            const r = o.sb().raycast(from, dir, len + 0.5, { props: true, world: true })
            const what: WeaponHitKind = r?.prop ? 'prop' : 'world'
            if (r?.prop) o.sb().fx.debris(debrisOf(r.prop.kind.surface ?? 'wood'), at, dir.clone().multiplyScalar(-3), 0.25)
            else puff('pistol', { what, point: at, normal: dir })
            emit({ type: 'hit', w, mine: false, what, surface: r?.prop?.kind.surface ?? 'concrete', x: at.x, y: at.y, z: at.z })
          }
          return
        }
        projectiles.push({
          w, pos: from.clone(), vel: dir.clone().multiplyScalar(w === 'rocket' ? ROCKET_SPEED : BOLT_SPEED),
          off: drawnFrom === gun ? gun.clone().sub(from) : new THREE.Vector3(),
          age: 0, life: w === 'rocket' ? ROCKET_RANGE / ROCKET_SPEED : BOLT_LIFE, mine: false, shooter: m.id, seq: m.seq, parked: 0,
        })
        if (projectiles.length > 64) projectiles.shift()
        return
      }
      case 'world-shot-hit': {
        if (m.level !== level() || !vec(m.at, at)) return
        const w = WEAPON_IDS[m.w]
        if (!w) return
        const mine = m.id === you
        // a shot of ours that struck somebody comes back only for them
        if (m.player === you && !mine) {
          const v = vec(m.v, tmp)
          if (v) o.shoved?.(v.x, v.y, v.z)
        }
        if (mine) return
        // the copy ends where the shooter says; a bolt that says which way
        // it was heading stuck there (one that hit a machine, the sea or
        // somebody does not)
        const i = projectiles.findIndex((p) => p.shooter === m.id && p.seq === m.seq)
        if (i >= 0) projectiles.splice(i, 1)
        const heading: THREE.Vector3 | null = vec(m.d, dir)
        const sb = o.sb()
        const local = typeof m.prop === 'number' ? localOf(m.prop) : null
        // the push, if we are the one simulating that prop
        if (local !== null && sb.isAuthority(local)) {
          const imp = vec(m.imp, tmp2)
          const p = sb.get(local)
          if (imp && p && p.mode === 'dynamic') {
            sb.wake(local)
            sb.applyImpulse(local, imp, at)
          }
        }
        if (w === 'crossbow' && heading) {
          const fr = m.fr
          if (local !== null && Array.isArray(fr) && fr.length === 7 && fr.every(Number.isFinite)) {
            const lm = new THREE.Matrix4().compose(
              new THREE.Vector3(fr[0], fr[1], fr[2]), new THREE.Quaternion(fr[3], fr[4], fr[5], fr[6]).normalize(), one)
            const s = addStuck(at, heading, local, lm)
            s.pos.copy(at)
          } else if (m.player === undefined) {
            addStuck(at, heading, -1, null)
          }
        }
        // (a pistol round's puff and sound came with its shot)
        if (w === 'crossbow') {
          const what: WeaponHitKind = m.player !== undefined ? 'player' : local !== null ? 'prop' : 'world'
          puff(w, { what, point: at, normal: tmp.set(0, 1, 0) })
          emit({ type: 'hit', w, mine: false, what, surface: what === 'world' ? 'concrete' : 'soft', x: at.x, y: at.y, z: at.z })
        }
        return
      }
    }
  }

  return {
    projectiles,
    stuck,
    tracers,
    wields,
    loaded: (w) => {
      if (w === 'pistol') return reloading > 0 ? 1 - reloading / SPECS.pistol.reload : 1
      return 1 - cool[w] / SPECS[w].interval
    },
    ammo: (w) => (w === 'pistol' ? rounds.pistol : cool[w] > 0 ? 0 : 1),
    update,
    step,
    receive,
    wield: (w) => {
      const i = w ? WEAPON_IDS.indexOf(w) : -1
      if (!online() || i === wieldSent) return
      wieldSent = i
      o.send!({ type: 'world-wield', w: i })
    },
    retarget: () => {
      stuck.length = 0
      projectiles.length = 0
      tracers.length = 0
      wields.clear()
    },
    offline: () => {
      you = 0
      wieldSent = null
      wields.clear()
      for (let i = projectiles.length - 1; i >= 0; i--) if (!projectiles[i].mine) projectiles.splice(i, 1)
    },
    on: (fn) => {
      fns.add(fn)
      return () => fns.delete(fn)
    },
  }
}
