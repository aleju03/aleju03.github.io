import * as THREE from 'three'
import { batchable } from './batch'
import { breakSound, igniteSound, impactSound } from './impactSounds'
import { KINDS, registerKind, type PropKind, type Surface } from './kinds'
import { GIBS } from './models'
import type { Fx } from './fx'
import type { ImpactEvent, Prop, PropId, Vec3Like } from './props'
import type { Sandbox } from './sandbox'

/*
  What a hit does to a prop besides moving it: the sound it makes, the damage
  it takes, and what happens when that damage is enough. Garry's Mod's rules,
  more or less. A wooden crate, a pallet, a plank, a kitchen chair, a melon
  and a glass bottle break into gibs; a red barrel, a gas can and a propane
  tank go off, either at once on a hard enough blow or after burning for a
  couple of seconds when the blow was only half that. Explosions deal damage
  too (explosion.ts calls `damage`), which is what makes a row of barrels a
  chain reaction.

  Damage is measured as a change of velocity, the same number the impact
  event already carries, so a kind's `breaks.speed` reads as "a blow that
  would stop it from this many units a second". A prop takes its own change
  of velocity when it hits something, and a prop that was *hit* takes the
  other one's impulse divided by its own mass, which is how a falling
  concrete block crushes a crate that barely moved (its own dv was tiny, the
  block's impulse enormous). A single blow at the threshold breaks it; blows
  over half of it chip away at a health of one, so the third hard knock on a
  crate finishes it.

  Gibs are real props: small boxes spawned where the pieces were, with the
  parent's velocity (and spin, and a kick outward), under kinds registered
  here (`gib_wood`, `gib_glass`...) so they knock and tink like what they
  came from. They carry `data.gib = true` (history and the network should
  skip them), live `GIB_LIFE` seconds, then shrink away over half a second
  and are removed. The oldest go first if more than `MAX_GIBS` are about.

  Every impact also makes its sound here (impactSounds.ts), because the one
  subscription already knows the surface, the blow and the mass.
*/

export interface BreakEvent {
  /** the prop that broke or went off (already removed) */
  id: PropId
  kind: string
  x: number
  y: number
  z: number
  /** 'break' for gibs, 'explode' for a blast */
  how: 'break' | 'explode'
  /** the gibs it left */
  gibs: PropId[]
}

export interface PropLife {
  /** deal a blow of `amount` (u/s of velocity change) to a prop; `blast`
      when it came from an explosion, which is hotter than a knock */
  damage: (id: PropId, amount: number, from?: Vec3Like, blast?: boolean) => void
  /** break a breakable at once (false when it does not break) */
  shatter: (id: PropId, from?: Vec3Like) => boolean
  /** light an explosive's fuse */
  ignite: (id: PropId) => void
  /** set an explosive off after `delay` seconds */
  detonate: (id: PropId, delay?: number) => void
  onBreak: (fn: (e: BreakEvent) => void) => () => void
  /** once per fixed slice */
  step: (h: number) => void
  readonly gibs: number
  readonly burning: number
}

/** seconds a gib lies about before it shrinks away */
export const GIB_LIFE = 8
const GIB_FADE = 0.6
/** gibs about at once; past this the oldest start to go */
export const MAX_GIBS = 180
/** a fuse burns this long (plus up to FUSE_JITTER) before the bang */
const FUSE = 2.2
const FUSE_JITTER = 1.4

const gibKind = (surface: Surface, density: number, friction: number, restitution: number): PropKind =>
  registerKind({
    id: `gib_${surface}`,
    label: `${surface} piece`,
    shape: { type: 'box', hx: 0.1, hy: 0.1, hz: 0.1 },
    mass: 1,
    friction,
    restitution,
    density,
    angularDamping: 0.3,
    linearDamping: 0.1,
    surface,
  })
gibKind('wood', 0.5, 0.6, 0.15)
gibKind('glass', 2.5, 0.4, 0.2)
gibKind('melon', 0.95, 0.7, 0.05)
gibKind('metal', 3, 0.5, 0.1)
gibKind('drum', 3, 0.5, 0.15)
gibKind('sheet', 3, 0.5, 0.15)

const DEBRIS: Partial<Record<Surface, 'wood' | 'glass' | 'melon' | 'plastic' | 'metal'>> = {
  wood: 'wood', glass: 'glass', melon: 'melon', plastic: 'plastic', metal: 'metal', drum: 'metal', sheet: 'metal',
}

interface State {
  hp: number
  /** seconds left on a lit fuse, or -1 */
  fuse: number
  /** seconds until a pending detonation, or -1 */
  boom: number
}

interface Gib {
  id: PropId
  age: number
  mesh: THREE.Object3D | null
  scale: number
}

export const createLife = (
  sb: Sandbox,
  fx: Fx,
  explodeAt: (at: Vec3Like, power: number, radius: number, source: PropId) => void,
): PropLife => {
  const state = new Map<PropId, State>()
  const gibs: Gib[] = []
  const breakFns = new Set<(e: BreakEvent) => void>()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const lin = new THREE.Vector3()
  const ang = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const tq = new THREE.Quaternion()
  const te = new THREE.Euler()

  const stateOf = (id: PropId) => {
    let s = state.get(id)
    if (!s) {
      s = { hp: 1, fuse: -1, boom: -1 }
      state.set(id, s)
    }
    return s
  }
  sb.onRemove((p) => {
    state.delete(p.id)
  })

  /* ------------------------------------------------------------ gibs -- */

  const spawnGibs = (p: Prop, from?: Vec3Like): PropId[] => {
    const specs = GIBS[p.kind.id]?.()
    if (!specs || !sb.getTransform(p.id, pos, quat)) return []
    sb.getVelocity(p.id, lin, ang)
    const surface = p.kind.surface ?? 'wood'
    const kindId = KINDS[`gib_${surface}`] ? `gib_${surface}` : 'gib_wood'
    const ids: PropId[] = []
    for (const g of specs) {
      // where the piece was, in the world, and how fast that point moved
      tmp.set(g.at[0], g.at[1], g.at[2]).applyQuaternion(quat)
      const r = tmp.clone()
      tmp.add(pos)
      const spin = new THREE.Vector3().crossVectors(ang, r)
      // a kick outward from the middle, and away from whatever broke it
      const out = r.lengthSq() > 1e-4 ? r.clone().normalize() : new THREE.Vector3(0, 1, 0)
      const kick = 2.5 + Math.random() * 3
      const v = lin.clone().add(spin).addScaledVector(out, kick)
      v.y += 1.5 + Math.random() * 2
      if (from) v.add(new THREE.Vector3(pos.x - from.x, 0, pos.z - from.z).normalize().multiplyScalar(2))
      tq.copy(quat)
      if (g.rot) tq.multiply(new THREE.Quaternion().setFromEuler(te.set(g.rot[0], g.rot[1], g.rot[2])))
      const mesh = batchable(g.mesh())
      const id = sb.spawn(kindId, tmp, {
        quaternion: { x: tq.x, y: tq.y, z: tq.z, w: tq.w },
        velocity: v,
        angular: { x: ang.x + (Math.random() - 0.5) * 8, y: ang.y + (Math.random() - 0.5) * 8, z: ang.z + (Math.random() - 0.5) * 8 },
        shape: { type: 'box', hx: g.half[0], hy: g.half[1], hz: g.half[2] },
        mass: Math.max(0.1, p.mass * g.share),
        mesh,
        data: { gib: true, of: p.kind.id },
      })
      gibs.push({ id, age: 0, mesh, scale: 1 })
      ids.push(id)
    }
    // too many about: the oldest start to go now
    const over = gibs.length - MAX_GIBS
    for (let i = 0; i < over; i++) gibs[i].age = Math.max(gibs[i].age, GIB_LIFE)
    return ids
  }

  const emitBreak = (e: BreakEvent) => {
    for (const fn of breakFns) fn(e)
  }

  const shatter = (id: PropId, from?: Vec3Like) => {
    const p = sb.get(id)
    if (!p || !p.kind.breaks) return false
    if (!sb.getTransform(id, pos, quat)) return false
    sb.getVelocity(id, lin)
    const at = { x: pos.x, y: pos.y, z: pos.z }
    const surface = p.kind.surface ?? 'wood'
    const ids = spawnGibs(p, from)
    sb.remove(id)
    breakSound(surface, 1, at.x, at.y, at.z)
    fx.debris(DEBRIS[surface] ?? 'wood', at, lin, Math.max(p.extents.x, p.extents.y, p.extents.z))
    emitBreak({ id, kind: p.kind.id, x: at.x, y: at.y, z: at.z, how: 'break', gibs: ids })
    return true
  }

  const goOff = (id: PropId) => {
    const p = sb.get(id)
    if (!p || !p.kind.explodes) return
    if (!sb.getTransform(id, pos, quat)) return
    const at = { x: pos.x, y: pos.y, z: pos.z }
    const { power, radius } = p.kind.explodes
    const ids = spawnGibs(p)
    // the pieces fly with the blast: up and out
    for (const g of ids) {
      const v = new THREE.Vector3()
      sb.getVelocity(g, v)
      v.multiplyScalar(0.3)
      v.x += (Math.random() - 0.5) * 30
      v.z += (Math.random() - 0.5) * 30
      v.y += 18 + Math.random() * 20
      sb.setVelocity(g, v, { x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20, z: (Math.random() - 0.5) * 20 })
    }
    sb.remove(id)
    explodeAt(at, power, radius, id)
    emitBreak({ id, kind: p.kind.id, x: at.x, y: at.y, z: at.z, how: 'explode', gibs: ids })
  }

  const ignite = (id: PropId) => {
    const p = sb.get(id)
    if (!p?.kind.explodes) return
    const s = stateOf(id)
    if (s.fuse >= 0 || s.boom >= 0) return
    s.fuse = FUSE + Math.random() * FUSE_JITTER
    const t = p.body.translation()
    igniteSound(t.x, t.y, t.z)
  }

  const detonate = (id: PropId, delay = 0) => {
    const p = sb.get(id)
    if (!p?.kind.explodes) return
    const s = stateOf(id)
    if (delay <= 0) {
      goOff(id)
      return
    }
    s.boom = s.boom >= 0 ? Math.min(s.boom, delay) : delay
  }

  const damage = (id: PropId, amount: number, from?: Vec3Like, blast = false) => {
    const p = sb.get(id)
    if (!p || amount <= 0) return
    const k = p.kind
    if (k.explodes) {
      const s = stateOf(id)
      if (s.boom >= 0) return
      // a blast is fire as well as a shove: it sets off at half the blow a
      // knock needs, and lights a fuse at a fifth
      const hot = blast ? 2 : 1
      const lights = blast ? 0.2 : 0.5
      if (amount * hot >= k.explodes.speed) {
        // a blast chains with a beat between links, which is what makes a row
        // of barrels read as a chain rather than as one bang
        detonate(id, blast ? 0.1 + Math.random() * 0.16 : 0)
        return
      }
      if (amount >= k.explodes.speed * lights) {
        s.hp -= (amount * hot) / k.explodes.speed
        if (s.hp <= 0) detonate(id, 0.05)
        else ignite(id)
      }
      return
    }
    if (!k.breaks) return
    if (amount >= k.breaks.speed) {
      shatter(id, from)
      return
    }
    if (amount >= k.breaks.speed * 0.5) {
      const s = stateOf(id)
      s.hp -= (amount / k.breaks.speed) * 0.55
      if (s.hp <= 0) shatter(id, from)
    }
  }

  /* --------------------------------------------------------- impacts -- */

  // breaking inside the impact callback would remove a body while Rapier's
  // contact pairs are being read, so blows are collected and dealt after
  const blows: Array<{ id: PropId; amount: number; x: number; y: number; z: number }> = []

  sb.onImpact((e: ImpactEvent) => {
    const k = e.prop.kind
    const s = Math.min(1, Math.max(0, (e.speed - 3) / 24))
    impactSound(k.surface ?? 'wood', s, e.prop.mass, e.x, e.y, e.z)
    // something heavy landing raises a little dust
    if (e.with === 'ground' && e.speed > 12 && e.prop.mass > 60) {
      fx.dust({ x: e.x, y: e.y, z: e.z }, Math.min(3, Math.max(e.prop.extents.x, e.prop.extents.z)))
    }
    if (k.breaks || k.explodes) blows.push({ id: e.id, amount: e.speed, x: e.x, y: e.y, z: e.z })
    const o = e.other
    if (o && (o.kind.breaks || o.kind.explodes)) {
      // the blow dealt to what it hit: this prop's impulse over its mass
      blows.push({ id: o.id, amount: Math.min(e.impulse / Math.max(0.1, o.mass), e.speed * 4), x: e.x, y: e.y, z: e.z })
    }
  })

  const step = (h: number) => {
    if (blows.length) {
      const list = blows.splice(0)
      for (const b of list) damage(b.id, b.amount, b)
    }
    // fuses, pending bangs
    for (const [id, s] of state) {
      if (s.boom >= 0) {
        s.boom -= h
        if (s.boom <= 0) {
          s.boom = -1
          goOff(id)
        }
        continue
      }
      if (s.fuse >= 0) {
        s.fuse -= h
        const p = sb.get(id)
        if (p && sb.getTransform(id, pos, quat)) {
          // flames lick out of the top, wherever the top has rolled to
          tmp.set(0, p.extents.y * 0.9, 0).applyQuaternion(quat).add(pos)
          fx.burn(tmp, 1 - Math.max(0, s.fuse) / FUSE)
        }
        if (s.fuse <= 0) {
          s.fuse = -1
          goOff(id)
        }
      }
    }
    // gibs age, shrink and go
    for (let i = gibs.length - 1; i >= 0; i--) {
      const g = gibs[i]
      g.age += h
      if (g.age < GIB_LIFE) continue
      const k = 1 - (g.age - GIB_LIFE) / GIB_FADE
      if (k <= 0 || !sb.get(g.id)) {
        sb.remove(g.id)
        gibs.splice(i, 1)
        continue
      }
      if (g.mesh) g.mesh.scale.setScalar(k)
    }
  }

  return {
    damage,
    shatter,
    ignite,
    detonate,
    onBreak: (fn) => {
      breakFns.add(fn)
      return () => breakFns.delete(fn)
    },
    step,
    get gibs() {
      return gibs.length
    },
    get burning() {
      let n = 0
      for (const s of state.values()) if (s.fuse >= 0) n++
      return n
    },
  }
}
