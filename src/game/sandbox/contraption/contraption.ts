import * as THREE from 'three'
import type RAPIER_NS from '@dimforge/rapier3d-compat'
import { model, propMaterial } from '../art'
import { axis as keyAxis, held as keyHeld } from '../bindings'
import { historyOf, type HistoryEntry } from '../history'
import type { Prop, PropId, Sandbox, Vec3Like } from '../sandbox'
import { DESIGN_LENS, DESIGN_SEAT_BOTTOM } from '../../player/playerBody'
import { HOVER_R, KEY_PAIRS, partOf, SEAT_FLOOR, SEAT_TOP, THRUSTER, WHEEL, type PartType } from './parts'

/*
  Contraptions: what the tool gun joins, and what makes the joined thing go.

  One of these per sandbox (`contraptionOf(sb)`, created the first time
  anybody asks, like `historyOf`), because joints live in a Rapier world and
  every level has its own. It owns two things.

  **The constraints.** Four kinds, Garry's Mod's own: a *weld* (Rapier's
  fixed joint at the pose the two props are in), an *axis* (a revolute joint:
  a wheel on its axle, or anything turning about the face it was put on), a
  *rope* (Rapier's rope joint: a maximum distance between two points) and a
  *no-collide* (a joint that constrains nothing, only there to switch the
  pair's contacts off). Welds and axes switch contacts off between their two
  props too, because a wheel rubbing the chassis it is hinged to is a brake
  and two welded plates pressed together are a joint fighting a contact.
  Removing a prop removes its constraints (the sandbox's `onRemove` fires
  before the body goes, so the joint is taken out first and never dangles),
  and a constraint recorded in the undo history leaves it with the prop.

  **The controller**, one `onBeforeSlice` hook, which is where parts.ts's
  parts do what they are for, from the keys `input()` was last handed:
    - a thruster pushes along its axis while its key is held, and the force
      is laid on the heaviest body of the welded piece it belongs to, at the
      thruster's own position. Laid on a six-kilogram can, a force big
      enough to fly a car would have to reach the car through a weld, and a
      weld asked to carry fifty times its lighter body's weight every slice
      is exactly how a joint starts to shake;
    - a wheel on an axis is driven by the joint's own motor (implicit in the
      solver, so stable at any stiffness), capped in torque; a loose wheel
      with nothing to push against spins itself with a capped torque impulse;
    - a hoverball holds a height, which its keys raise and lower, with a
      critically damped spring that pays its share of the machine's weight:
      the machine's mass split between the hoverballs in it;
    - and a seat drives the machine it is part of: while somebody sits in it
      WASD drives every wheel in the machine (each one's direction worked out
      from which way its axle points relative to the seat, and A and D
      slowing one side against the other, like a tank), space fires every
      thruster and lifts every hoverball, and shift fires them backwards and
      sinks them. A car built from parts drives like a car because of that
      rule, and no wheel has to be set up by hand.

  **Groups** are read off the constraint graph: the *welded* piece (welds
  only: what a thruster's force is laid on), the *machine* (welds and axes:
  what a seat drives and what a hoverball carries) and the *linked* set
  (everything but no-collides: what the physgun's reload thaws together and
  what its hold weighs). They are cached and rebuilt only when a constraint
  or a part comes or goes, in insertion order, so the simulation stays a
  pure function of what was done to it (the keys are inputs like any other).

  **Physics sanity.** A joint between two bodies of very different mass is
  where an iterative solver shakes, so the lighter one of any constrained
  pair is given extra mass up to a thirtieth of the heavier (only on a kind
  with no ballast, whose extra mass slot is free); every constrained body and
  every part is held under `MAX_SPEED` and `MAX_SPIN`; and a hoverball at its
  height and asleep is left asleep. Everything is scaled by the sandbox's own
  gravity, so a machine that flies at home floats on the Moon.

  Headless-safe: with no parent there are no rope meshes, and the sandbox's
  fx is a no-op, so the same machine is measured in Node and filmed in
  Chrome. Local-only for now, like every prop: nothing here travels.
*/

export type ConstraintType = 'weld' | 'axis' | 'rope' | 'nocollide'

export interface Constraint {
  readonly id: number
  readonly type: ConstraintType
  /** the first prop (for an axis: the one that turns) */
  readonly a: PropId
  readonly b: PropId
  /** anchors in each prop's own frame */
  readonly anchorA: THREE.Vector3
  readonly anchorB: THREE.Vector3
  /** a rope's length */
  readonly length: number
  /** the undo entry that takes it back, if one was recorded */
  entry: HistoryEntry | null
}

export interface PartState {
  readonly id: PropId
  readonly type: PartType
  /** KEY_PAIRS index, -1 for none */
  keys: number
  /** reverse: the forward key pushes the other way */
  flip: boolean
  /** a hoverball's height */
  target: number
  /** the last slice's command, -1..1 (the fx read it) */
  fire: number
}

export interface AddOpts {
  /** the anchor, world (weld, axis: where the axle is; default A's centre) */
  at?: Vec3Like
  /** a rope's anchor on B, world */
  atB?: Vec3Like
  /** an axis's direction, world (default: a wheel's own axle) */
  axis?: Vec3Like
  /** which way "forward" was for whoever made an axis: a wheel's forward
      key then rolls it that way */
  forward?: Vec3Like
}

export interface SeatView {
  /** the eye, world */
  eye: THREE.Vector3
  /** the cushion top, world */
  cushion: THREE.Vector3
  /** the walk-convention heading the seat faces (0 faces -Z) */
  yaw: number
}

export interface Contraption {
  /** join two props; null when it cannot (same prop, missing, not ready) */
  add: (type: ConstraintType, a: PropId, b: PropId, o?: AddOpts) => Constraint | null
  remove: (id: number) => boolean
  /** every constraint on a prop (of a type), removed; how many went */
  strip: (prop: PropId, type?: ConstraintType) => number
  constraints: (prop?: PropId) => Constraint[]
  /** everything joined to a prop by welds, axes or ropes, itself included */
  linked: (id: PropId) => PropId[]
  /** the machine: welds and axes */
  machine: (id: PropId) => PropId[]
  /** what the physgun is lifting when it holds this: the machine's mass */
  massOf: (id: PropId) => number
  part: (id: PropId) => PartState | null
  readonly parts: ReadonlyMap<PropId, PartState>
  /** a part's key pair (KEY_PAIRS index), and cycling through them */
  setKeys: (id: PropId, pair: number) => void
  cycleKeys: (id: PropId, dir?: number) => number
  flip: (id: PropId) => boolean
  /** set a part down on a face the way it mounts (see parts.ts), before it
      is welded or hinged there: false for a prop that is not a part */
  snapOnto: (a: PropId, point: Vec3Like, normal: Vec3Like, view?: Vec3Like) => boolean
  /** this frame's keys and who is sitting where. The keys hold for `ttl`
      slices (a frame's worth by default), so a loop that stops calling
      (a pause, a car) stops the machine rather than holding the throttle */
  input: (keys: ReadonlySet<string>, seat?: PropId | null, ttl?: number) => void
  /** the prop the physgun holds: a hoverball carried moves its height */
  held: PropId | null
  /** the seat is a seat, and where somebody in it sits and looks: a walker
      whose standing eye is `eyeHeight` sits with it at the fraction of that
      the furniture uses (player/seating.ts), over the cushion */
  isSeat: (id: PropId) => boolean
  seatView: (id: PropId, eyeHeight: number, out: SeatView) => boolean
  /** once a frame after the draw: ropes and thruster flames */
  present: (dt: number) => void
  readonly stats: { constraints: number; parts: number; firing: number }
  dispose: () => void
}

/* ------------------------------------------------------------ tuning -- */

/** a thruster's push, units*kg/s² (two lift a long beam at ~2 g, and push a
    150 kg car at ~13 u/s²) */
export const THRUST = 1000
/** a wheel's top spin, rad/s (31 u/s at the tread, ~45 km/h) and the torque
    its motor has to get there, per wheel */
export const WHEEL_SPIN = 26
export const WHEEL_TORQUE = 1600
/** what an idle wheel's bearing holds against: parked on a slope, a car
    under somebody sits; nobody in it, it rolls a little */
const BRAKE_SEATED = 900
const BRAKE_FREE = 30
/** a hoverball's spring: ω and damping ratio, its climb rate and its limit */
const HOVER_W = 3.2
const HOVER_Z = 1.0
const HOVER_RATE = 9
const HOVER_ACC = 45
/** the air a hoverball leans on sideways, per second */
const HOVER_AIR = 0.6
/** nothing constrained goes faster than this, u/s (~180 km/h), or spins
    faster than this, rad/s */
export const MAX_SPEED = 120
export const MAX_SPIN = 45
/** the lighter of any pair is weighed up to this share of the heavier */
const MAX_RATIO = 30

/** the seated eye over the cushion, as a share of the standing one: the
    same number player/seating.ts measures off the body for the sofa */
const SEATED = (DESIGN_SEAT_BOTTOM - 0.05) / DESIGN_LENS

const contraptions = new WeakMap<Sandbox, Contraption>()

/** the contraption state of one sandbox, created the first time anybody asks */
export const contraptionOf = (sb: Sandbox): Contraption => {
  let c = contraptions.get(sb)
  if (!c) {
    c = createContraption(sb)
    contraptions.set(sb, c)
  }
  return c
}

const X = new THREE.Vector3(1, 0, 0)
const Y = new THREE.Vector3(0, 1, 0)
const NEG_Z = new THREE.Vector3(0, 0, -1)
const EMPTY: ReadonlySet<string> = new Set()

type RJoint = RAPIER_NS.ImpulseJoint
type Rev = RAPIER_NS.RevoluteImpulseJoint

interface Rec extends Constraint {
  joint: RJoint | null
  /** the rope's drawn line */
  mesh: THREE.Mesh | null
  /** the motor's last setting, so a joint is only reconfigured on change */
  motor: number
}

export function createContraption(sb: Sandbox): Contraption {
  const recs = new Map<number, Rec>()
  const byProp = new Map<PropId, Rec[]>()
  const parts = new Map<PropId, PartState>()
  const boosted = new Map<PropId, number>()
  let nextId = 1
  let version = 0
  let keys: ReadonlySet<string> = EMPTY
  let keysTtl = 0
  let seat: PropId | null = null
  let removing = false

  /* ------------------------------------------------------ the parts -- */

  const adopt = (p: Prop) => {
    const spec = partOf(p.kind.id)
    if (!spec || parts.has(p.id)) return
    const t = p.body.translation()
    const st: PartState = { id: p.id, type: spec.type, keys: spec.keys, flip: false, target: t.y, fire: 0 }
    // a part that arrives with its settings (a duplicate, a scenario) keeps them
    const d = p.data.part as Partial<PartState> | undefined
    if (d) {
      if (typeof d.keys === 'number') st.keys = d.keys
      if (typeof d.flip === 'boolean') st.flip = d.flip
    }
    p.data.part = st
    parts.set(p.id, st)
    version++
  }
  sb.forEach(adopt)
  const offSpawn = sb.onSpawn(adopt)

  /* ------------------------------------------------ the constraints -- */

  const link = (r: Rec, id: PropId) => {
    let l = byProp.get(id)
    if (!l) byProp.set(id, (l = []))
    l.push(r)
  }
  const unlink = (r: Rec, id: PropId) => {
    const l = byProp.get(id)
    if (!l) return
    const i = l.indexOf(r)
    if (i >= 0) l.splice(i, 1)
    if (!l.length) byProp.delete(id)
  }

  const world = () => sb.physics?.world ?? null
  const R = () => sb.rapier

  /** weigh the lighter end of every pair up to 1/MAX_RATIO of the heavier */
  const rebalance = (id: PropId) => {
    const p = sb.get(id)
    if (!p || p.kind.ballast) return
    let need = 0
    for (const r of byProp.get(id) ?? []) {
      if (r.type === 'nocollide') continue
      const o = sb.get(r.a === id ? r.b : r.a)
      if (o) need = Math.max(need, o.mass / MAX_RATIO - p.mass)
    }
    const had = boosted.get(id) ?? 0
    if (Math.abs(need - had) < 1e-6) return
    if (need > 0) boosted.set(id, need)
    else boosted.delete(id)
    p.body.setAdditionalMass(Math.max(0, need), true)
  }

  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion()
  const pa = new THREE.Vector3()
  const pb = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  const poseOf = (p: Prop, pos: THREE.Vector3, q: THREE.Quaternion) => {
    const t = p.body.translation()
    const r = p.body.rotation()
    pos.set(t.x, t.y, t.z)
    q.set(r.x, r.y, r.z, r.w)
  }
  /** world point into a prop's own frame */
  const toLocal = (pos: THREE.Vector3, q: THREE.Quaternion, w: Vec3Like, out: THREE.Vector3) =>
    out.set(w.x - pos.x, w.y - pos.y, w.z - pos.z).applyQuaternion(tmpQ.copy(q).invert())
  const tmpQ = new THREE.Quaternion()

  const add = (type: ConstraintType, a: PropId, b: PropId, o: AddOpts = {}): Constraint | null => {
    const w = world()
    const Rp = R()
    const A = sb.get(a)
    const B = sb.get(b)
    if (!w || !Rp || !A || !B || a === b) return null
    // one of each kind per pair is plenty; a second weld is the first one
    for (const r of byProp.get(a) ?? []) {
      if (r.type === type && ((r.a === a && r.b === b) || (r.a === b && r.b === a)) && type !== 'rope') return r
    }
    poseOf(A, pa, qa)
    poseOf(B, pb, qb)
    const anchorA = new THREE.Vector3()
    const anchorB = new THREE.Vector3()
    let length = 0
    let data: RAPIER_NS.JointData
    const v = (x: THREE.Vector3) => ({ x: x.x, y: x.y, z: x.z })
    if (type === 'weld') {
      // anchored halfway between the two, at the pose they are in now
      const mid = o.at ? tmp.set(o.at.x, o.at.y, o.at.z) : tmp.copy(pa).add(pb).multiplyScalar(0.5)
      toLocal(pa, qa, mid, anchorA)
      toLocal(pb, qb, mid, anchorB)
      // frames: the identity on A, and A's orientation seen from B
      const fb = tmpQ.copy(qb).invert().multiply(qa)
      data = Rp.JointData.fixed(v(anchorA), { x: 0, y: 0, z: 0, w: 1 }, v(anchorB), { x: fb.x, y: fb.y, z: fb.z, w: fb.w })
    } else if (type === 'axis') {
      const at = o.at ? tmp.set(o.at.x, o.at.y, o.at.z) : tmp.copy(pa)
      toLocal(pa, qa, at, anchorA)
      toLocal(pb, qb, at, anchorB)
      const isWheel = parts.get(a)?.type === 'wheel'
      // the axle: a wheel's own x unless told otherwise, in each frame
      const axW = o.axis && !isWheel ? tmp2.set(o.axis.x, o.axis.y, o.axis.z).normalize() : tmp2.copy(X).applyQuaternion(qa)
      const axA = axW.clone().applyQuaternion(tmpQ.copy(qa).invert())
      const axB = axW.clone().applyQuaternion(tmpQ.copy(qb).invert())
      data = Rp.JointData.revoluteWithAxes(v(anchorA), v(anchorB), v(axA), v(axB))
      // a wheel's forward key rolls it the way its maker was facing
      const st = parts.get(a)
      if (st && isWheel && o.forward) {
        const f = new THREE.Vector3(o.forward.x, 0, o.forward.z)
        if (f.lengthSq() > 1e-6) st.flip = axW.dot(f.normalize().cross(Y).negate()) < 0
      }
    } else if (type === 'rope') {
      const atA = o.at ? tmp.set(o.at.x, o.at.y, o.at.z) : tmp.copy(pa)
      const atB = o.atB ? tmp2.set(o.atB.x, o.atB.y, o.atB.z) : tmp2.copy(pb)
      length = Math.max(0.2, atA.distanceTo(atB))
      toLocal(pa, qa, atA, anchorA)
      toLocal(pb, qb, atB, anchorB)
      data = Rp.JointData.rope(length, v(anchorA), v(anchorB))
    } else {
      // no-collide: a rope far too long to ever pull, there only to carry
      // the "no contacts between these two" flag
      data = Rp.JointData.rope(1e6, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    }
    const joint = w.createImpulseJoint(data, A.body, B.body, true)
    if (type !== 'rope') joint.setContactsEnabled(false)
    const r: Rec = { id: nextId++, type, a, b, anchorA, anchorB, length, entry: null, joint, mesh: null, motor: NaN }
    recs.set(r.id, r)
    link(r, a)
    link(r, b)
    version++
    rebalance(a)
    rebalance(b)
    A.body.wakeUp()
    B.body.wakeUp()
    return r
  }

  const drop = (r: Rec, fromRemoval: boolean) => {
    if (!recs.has(r.id)) return
    recs.delete(r.id)
    unlink(r, r.a)
    unlink(r, r.b)
    const w = world()
    if (w && r.joint) {
      // wake what it held: a thing whose weld is undone should fall
      w.removeImpulseJoint(r.joint, true)
    }
    r.joint = null
    if (r.mesh) {
      r.mesh.removeFromParent()
      r.mesh = null
    }
    version++
    if (!removing) {
      rebalance(r.a)
      rebalance(r.b)
    }
    // gone with its prop: its undo entry has nothing left to undo
    if (fromRemoval && r.entry) historyOf(sb).discard(r.entry)
  }

  const remove = (id: number) => {
    const r = recs.get(id)
    if (!r) return false
    drop(r, false)
    return true
  }

  const strip = (prop: PropId, type?: ConstraintType) => {
    const l = [...(byProp.get(prop) ?? [])].filter((r) => !type || r.type === type)
    for (const r of l) {
      drop(r, false)
      if (r.entry) historyOf(sb).discard(r.entry)
    }
    return l.length
  }

  const offRemove = sb.onRemove((p) => {
    // before the body goes: its joints come out first, so nothing is left
    // pointing at a body Rapier has freed
    const l = byProp.get(p.id)
    if (l) {
      removing = true
      try {
        for (const r of [...l]) drop(r, true)
      } finally {
        removing = false
      }
      // the other ends may no longer need their extra weight
      const others = new Set(l.flatMap((r) => [r.a, r.b]))
      others.delete(p.id)
      for (const o of others) rebalance(o)
    }
    if (parts.delete(p.id)) version++
    boosted.delete(p.id)
    if (seat === p.id) seat = null
  })

  /* --------------------------------------------------------- groups -- */

  let cachedAt = -1
  const weldRoot = new Map<PropId, PropId>()
  const machineOf = new Map<PropId, PropId[]>()
  const linkedOf = new Map<PropId, PropId[]>()

  const components = (keep: (t: ConstraintType) => boolean, out: Map<PropId, PropId[]>) => {
    out.clear()
    const ids = new Set<PropId>([...byProp.keys(), ...parts.keys()])
    for (const start of ids) {
      if (out.has(start)) continue
      const group: PropId[] = [start]
      out.set(start, group)
      for (let i = 0; i < group.length; i++) {
        for (const r of byProp.get(group[i]) ?? []) {
          if (!keep(r.type)) continue
          const o = r.a === group[i] ? r.b : r.a
          if (out.has(o)) continue
          out.set(o, group)
          group.push(o)
        }
      }
    }
  }
  const refresh = () => {
    if (cachedAt === version) return
    cachedAt = version
    const welded = new Map<PropId, PropId[]>()
    components((t) => t === 'weld', welded)
    weldRoot.clear()
    for (const [id, g] of welded) {
      if (weldRoot.has(id)) continue
      // the heaviest body carries the forces; ties go to the oldest
      let best = g[0]
      let bestM = -1
      for (const m of g) {
        const p = sb.get(m)
        const mass = p ? p.mass : 0
        if (mass > bestM + 1e-9) {
          bestM = mass
          best = m
        }
      }
      for (const m of g) weldRoot.set(m, best)
    }
    components((t) => t === 'weld' || t === 'axis', machineOf)
    components((t) => t !== 'nocollide', linkedOf)
  }

  const machine = (id: PropId) => {
    refresh()
    return machineOf.get(id) ?? [id]
  }
  const linked = (id: PropId) => {
    refresh()
    return linkedOf.get(id) ?? [id]
  }
  const massOf = (id: PropId) => {
    let m = 0
    for (const o of machine(id)) {
      const p = sb.get(o)
      if (p && p.mode === 'dynamic') m += p.body.mass()
    }
    return m || (sb.get(id)?.body.mass() ?? 0)
  }

  /* ---------------------------------------------------- the placing -- */

  const snapOnto = (a: PropId, point: Vec3Like, normal: Vec3Like, view?: Vec3Like) => {
    const A = sb.get(a)
    const st = parts.get(a)
    if (!A || !st || st.type === 'plate') return false
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize()
    const at = new THREE.Vector3(point.x, point.y, point.z)
    const q = new THREE.Quaternion()
    poseOf(A, pa, qa)
    switch (st.type) {
      case 'thruster':
        // nozzle out of the face, pushing into it
        q.setFromUnitVectors(Y, tmp.copy(n).negate())
        at.addScaledVector(n, THRUSTER.hh + 0.02)
        break
      case 'wheel': {
        // the axle along the face's normal, turned about it as little as
        // it takes to get there
        const axNow = tmp.copy(X).applyQuaternion(qa)
        q.setFromUnitVectors(axNow, n).multiply(qa)
        at.addScaledVector(n, WHEEL.hh + 0.12)
        break
      }
      case 'hoverball':
        q.copy(qa)
        at.addScaledVector(n, HOVER_R + 0.02)
        break
      case 'seat': {
        // floor on the face, facing the way the builder was looking
        const f = tmp.set(view?.x ?? 0, view?.y ?? 0, view?.z ?? -1)
        f.addScaledVector(n, -f.dot(n))
        if (f.lengthSq() < 1e-4) f.copy(NEG_Z).addScaledVector(n, -NEG_Z.dot(n))
        if (f.lengthSq() < 1e-4) f.copy(X).addScaledVector(n, -X.dot(n))
        f.normalize()
        const right = tmp2.copy(f).cross(n).normalize()
        const m = new THREE.Matrix4().makeBasis(right, n, f.clone().negate())
        q.setFromRotationMatrix(m)
        at.addScaledVector(n, SEAT_FLOOR + 0.02)
        break
      }
    }
    sb.setTransform(a, at, q)
    sb.setVelocity(a, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    if (st.type === 'hoverball') st.target = at.y
    return true
  }

  /* ------------------------------------------------------- the keys -- */

  const pairValue = (pair: number) => {
    const kp = KEY_PAIRS[pair]
    if (!kp) return 0
    let v = 0
    for (const c of kp.a) if (keys.has(c)) { v += 1; break }
    for (const c of kp.b) if (keys.has(c)) { v -= 1; break }
    return v
  }

  /* ------------------------------------------------- the controller -- */

  const force = { x: 0, y: 0, z: 0 }
  const point = { x: 0, y: 0, z: 0 }
  const fwd = new THREE.Vector3()
  const up = new THREE.Vector3()
  const right = new THREE.Vector3()
  const roll = new THREE.Vector3()
  const center = new THREE.Vector3()
  const ax = new THREE.Vector3()
  let firing = 0

  const beforeSlice = (h: number) => {
    if (!sb.ready || parts.size === 0) return
    refresh()
    if (keysTtl > 0) keysTtl--
    else keys = EMPTY
    const g = -sb.gravity

    // the seat's machine, and its frame
    let driven: Set<PropId> | null = null
    let throttle = 0
    let steer = 0
    let lift = 0
    const S = seat !== null ? sb.get(seat) : undefined
    if (S) {
      driven = new Set(machine(S.id))
      poseOf(S, pa, qa)
      fwd.copy(NEG_Z).applyQuaternion(qa)
      up.copy(Y).applyQuaternion(qa)
      right.copy(fwd).cross(up)
      // u x f: the spin that rolls a wheel along f
      roll.copy(up).cross(fwd)
      throttle = keyAxis(keys, 'back', 'forward')
      steer = keyAxis(keys, 'left', 'right')
      lift = (keyHeld(keys, 'jump') ? 1 : 0) - (keyHeld(keys, 'sprint') ? 1 : 0)
      // the middle of the machine's wheels, to tell a left one from a right
      center.set(0, 0, 0)
      let n = 0
      for (const id of driven) {
        if (parts.get(id)?.type !== 'wheel') continue
        const p = sb.get(id)
        if (!p) continue
        const t = p.body.translation()
        center.x += t.x
        center.y += t.y
        center.z += t.z
        n++
      }
      if (n) center.multiplyScalar(1 / n)
      else center.copy(pa)
    }

    // how many hoverballs share each machine's weight
    let hoverShare: Map<PropId[], number> | null = null
    firing = 0
    for (const st of parts.values()) {
      const p = sb.get(st.id)
      st.fire = 0
      if (!p || p.parked || p.mode !== 'dynamic') continue
      const inSeat = driven?.has(st.id) ?? false
      const own = st.keys >= 0 ? pairValue(st.keys) * (st.flip ? -1 : 1) : 0
      switch (st.type) {
        case 'thruster': {
          const cmd = Math.max(-1, Math.min(1, own + (inSeat ? lift : 0)))
          if (!cmd) break
          st.fire = cmd
          firing++
          poseOf(p, pb, qb)
          ax.copy(Y).applyQuaternion(qb).multiplyScalar(THRUST * cmd)
          const root = weldRoot.get(st.id) ?? st.id
          force.x = ax.x
          force.y = ax.y
          force.z = ax.z
          point.x = pb.x
          point.y = pb.y
          point.z = pb.z
          sb.addForce(root, force, point)
          break
        }
        case 'wheel': {
          poseOf(p, pb, qb)
          ax.copy(X).applyQuaternion(qb)
          let cmd = own
          let brake = BRAKE_FREE
          if (inSeat && S) {
            // which way this wheel has to turn for the machine to go
            // forward, and which side of the machine it is on
            const sgn = ax.dot(roll) >= 0 ? 1 : -1
            const side = tmp.copy(pb).sub(center).dot(right)
            const turn = side < -0.3 ? steer : side > 0.3 ? -steer : 0
            cmd = Math.max(-1, Math.min(1, throttle + turn)) * sgn
            brake = BRAKE_SEATED
          }
          st.fire = cmd
          const r = (byProp.get(st.id) ?? []).find((c) => c.type === 'axis' && c.a === st.id)
          if (r && r.joint) {
            const target = -cmd * WHEEL_SPIN
            const setting = cmd ? target : brake === BRAKE_SEATED ? -1e9 : -2e9
            if (setting !== r.motor) {
              r.motor = setting
              const j = r.joint as Rev
              j.configureMotorVelocity(cmd ? target : 0, cmd ? 30 : 10)
              j.setMotorMaxForce(cmd ? WHEEL_TORQUE : brake)
            }
            if (cmd && p.body.isSleeping()) p.body.wakeUp()
          } else if (cmd) {
            // a loose wheel: spin it about its own axle, up to top speed
            const av = p.body.angvel()
            const spin = av.x * ax.x + av.y * ax.y + av.z * ax.z
            if (spin * cmd < WHEEL_SPIN) {
              const k = cmd * WHEEL_TORQUE * 0.25 * h
              p.body.applyTorqueImpulse({ x: ax.x * k, y: ax.y * k, z: ax.z * k }, true)
            }
          }
          break
        }
        case 'hoverball': {
          const cmd = Math.max(-1, Math.min(1, own + (inSeat ? lift : 0)))
          const t = p.body.translation()
          const group = machine(st.id)
          // carried by the physgun: it holds wherever it is let go
          if (heldGroup(group)) {
            st.target = t.y
            break
          }
          if (cmd) st.target += cmd * HOVER_RATE * h
          const err = st.target - t.y
          if (!cmd && p.body.isSleeping() && Math.abs(err) < 0.08) break
          hoverShare ??= new Map()
          let n = hoverShare.get(group)
          if (n === undefined) {
            n = 0
            for (const id of group) if (parts.get(id)?.type === 'hoverball') n++
            hoverShare.set(group, n)
          }
          const M = massOf(st.id) / Math.max(1, n)
          const v = p.body.linvel()
          const k = HOVER_W * HOVER_W
          const d = 2 * HOVER_Z * HOVER_W
          const ay = Math.max(-HOVER_ACC, Math.min(HOVER_ACC + g, g + k * Math.max(-6, Math.min(6, err)) - d * v.y))
          force.x = -M * HOVER_AIR * v.x
          force.y = M * ay
          force.z = -M * HOVER_AIR * v.z
          point.x = t.x
          point.y = t.y
          point.z = t.z
          sb.addForce(weldRoot.get(st.id) ?? st.id, force, point)
          break
        }
      }
    }
  }

  const heldGroup = (group: PropId[]) => api.held !== null && group.includes(api.held)

  /** after the step: keep every constrained body and every part in bounds */
  const afterSlice = () => {
    if (!sb.ready || (recs.size === 0 && parts.size === 0)) return
    const cap = (id: PropId) => {
      const p = sb.get(id)
      if (!p || p.mode !== 'dynamic' || p.parked || p.body.isSleeping()) return
      const v = p.body.linvel()
      const s2 = v.x * v.x + v.y * v.y + v.z * v.z
      if (s2 > MAX_SPEED * MAX_SPEED) {
        const k = MAX_SPEED / Math.sqrt(s2)
        p.body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, false)
      }
      const w = p.body.angvel()
      const w2 = w.x * w.x + w.y * w.y + w.z * w.z
      if (w2 > MAX_SPIN * MAX_SPIN) {
        const k = MAX_SPIN / Math.sqrt(w2)
        p.body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false)
      }
    }
    for (const id of byProp.keys()) cap(id)
    for (const id of parts.keys()) if (!byProp.has(id)) cap(id)
  }

  const offBefore = sb.onBeforeSlice(beforeSlice)
  const offAfter = sb.onAfterSlice(afterSlice)

  /* ---------------------------------------------------- the drawing -- */

  const parent = () => (sb.root.parent ? sb.root : null)
  let ropeGeo: THREE.BufferGeometry | null = null
  const ropeMesh = () => {
    ropeGeo ??= model().box([0, 0, 0.5], [0.09, 0.09, 1], { cell: 'white', tint: '#6b5536' }).geometry()
    // the props' own material, on a plain mesh like the sandbox's warm one,
    // so a rope's first draw is a program the boot already linked
    const m = new THREE.Mesh(ropeGeo, propMaterial())
    m.castShadow = true
    m.receiveShadow = true
    m.frustumCulled = false
    m.userData.dynamic = true
    return m
  }
  const posOf = (p: Prop, pos: THREE.Vector3, q: THREE.Quaternion) => {
    // where it is drawn (interpolated), which is where the eye expects it
    if (p.mesh) {
      pos.copy(p.mesh.position)
      q.copy(p.mesh.quaternion)
    } else poseOf(p, pos, q)
  }
  const nozzle = new THREE.Vector3()
  const exhaust = new THREE.Vector3()
  const vel = { x: 0, y: 0, z: 0 }

  const present = (dt: number) => {
    const root = parent()
    for (const r of recs.values()) {
      if (r.type !== 'rope') continue
      const A = sb.get(r.a)
      const B = sb.get(r.b)
      if (!A || !B || !root) continue
      if (!r.mesh) {
        r.mesh = ropeMesh()
        root.add(r.mesh)
      }
      posOf(A, pa, qa)
      posOf(B, pb, qb)
      pa.add(tmp.copy(r.anchorA).applyQuaternion(qa))
      pb.add(tmp.copy(r.anchorB).applyQuaternion(qb))
      r.mesh.position.copy(pa)
      r.mesh.lookAt(pb)
      r.mesh.scale.set(1, 1, Math.max(0.01, pa.distanceTo(pb)))
      r.mesh.updateMatrix()
    }
    if (!firing || dt <= 0) return
    for (const st of parts.values()) {
      if (st.type !== 'thruster' || !st.fire) continue
      const p = sb.get(st.id)
      if (!p) continue
      posOf(p, pa, qa)
      const s = st.fire > 0 ? 1 : -1
      exhaust.copy(Y).applyQuaternion(qa).multiplyScalar(-s)
      nozzle.copy(pa).addScaledVector(exhaust, THRUSTER.hh + 0.15)
      const v = p.body.linvel()
      vel.x = v.x
      vel.y = v.y
      vel.z = v.z
      sb.fx.thrust(nozzle, exhaust, vel, Math.abs(st.fire), dt)
    }
  }

  /* --------------------------------------------------------- facade -- */

  const api: Contraption = {
    add,
    remove,
    strip,
    constraints: (prop) => (prop === undefined ? [...recs.values()] : [...(byProp.get(prop) ?? [])]),
    linked,
    machine,
    massOf,
    part: (id) => parts.get(id) ?? null,
    parts,
    setKeys: (id, pair) => {
      const st = parts.get(id)
      if (st) st.keys = Math.max(-1, Math.min(KEY_PAIRS.length - 1, pair))
    },
    cycleKeys: (id, dir = 1) => {
      const st = parts.get(id)
      if (!st || st.type === 'seat' || st.type === 'plate') return -1
      const n = KEY_PAIRS.length
      st.keys = (((st.keys < 0 ? 0 : st.keys + dir) % n) + n) % n
      return st.keys
    },
    flip: (id) => {
      const st = parts.get(id)
      if (!st || st.type === 'seat' || st.type === 'plate') return false
      st.flip = !st.flip
      return st.flip
    },
    snapOnto,
    input: (k, s = null, ttl = 6) => {
      keys = k
      keysTtl = ttl
      seat = s !== null && parts.get(s)?.type === 'seat' ? s : null
    },
    held: null,
    isSeat: (id) => parts.get(id)?.type === 'seat',
    seatView: (id, eyeHeight, out) => {
      const eyeUp = eyeHeight * SEATED
      const p = sb.get(id)
      if (!p || parts.get(id)?.type !== 'seat') return false
      posOf(p, pa, qa)
      up.copy(Y).applyQuaternion(qa)
      out.cushion.copy(pa).addScaledVector(up, SEAT_TOP)
      out.eye.copy(out.cushion).addScaledVector(up, eyeUp)
      fwd.copy(NEG_Z).applyQuaternion(qa)
      out.yaw = Math.atan2(-fwd.x, -fwd.z)
      return true
    },
    present,
    get stats() {
      return { constraints: recs.size, parts: parts.size, firing }
    },
    dispose: () => {
      offSpawn()
      offRemove()
      offBefore()
      offAfter()
      for (const r of [...recs.values()]) drop(r, false)
      ropeGeo?.dispose()
      contraptions.delete(sb)
    },
  }
  return api
}
