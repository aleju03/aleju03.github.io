import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import { chunkX, chunkZ } from '../world/grid'
import { terrainY } from '../world/terrain'
import type { Ground } from './ground'
import { KINDS, shapeExtents, type PropKind, type ShapeSpec } from './kinds'
import { GROUPS, type PhysicsWorld, type RBody, type RCollider } from './physics'

/*
  The props: every rigid body a player can spawn, grab, stack or throw, and
  the registry that is the one door to them.

  A prop is a Rapier body with one or more colliders (from its kind's
  ShapeSpec), an optional Object3D drawn from the kind, and a little session
  state. Everything outside the sandbox addresses it by a numeric `PropId` and
  goes through the verbs here (spawn, remove, transform, velocity, impulse,
  freeze, kinematic, wake, iterate), so the physgun, the console's undo,
  destruction and the network all speak the same small language and none of
  them has to hold a Rapier handle. The raw body is still on the record for
  anyone who needs more than the verbs.

  Four things happen to every prop each slice, in this order, and they are
  the reason this module is more than a Map:

  - **forces are re-laid.** Rapier's user forces persist until reset, so
    every body that was pushed by anything last slice is reset first and the
    forces are laid again (buoyancy, the weight of a player standing on it,
    whatever a tool adds through `addForce`). A body nobody pushes pays
    nothing.
  - **water.** Buoyancy is eight samples at the octant centres of the prop's
    box, each carrying an eighth of `mass * g / density` scaled by how far
    under the drawn surface (SEA_Y plus the swell the water shader draws) it
    is. Applied at the samples rather than the centre, it rights a floating
    crate, tips a plank flat and lets the swell rock a barrel, which is the
    whole look of a sea full of props. Drag rises with the submerged share,
    and it grows per kilogram with the water displaced, so a block that sinks
    sinks slowly, a crate dropped from a height plunges, bobs and settles, and
    a beach ball shoved under pops up rather than being fired into the sky.
  - **impacts.** A body whose velocity changed by more than gravity can
    explain, in one slice, hit something. That is reported once, with the
    impulse (`mass * dv`), the speed of the change, where, and what it hit,
    for the sound builder and for destruction. Measuring the change in
    velocity rather than listening to contact forces is deliberate: a resting
    stack has large contact forces and no impacts at all.
  - **poses.** The previous and current pose of every awake body are kept so
    the mesh can be drawn between them (`alpha`), which is what makes a
    60 Hz simulation look smooth on a 144 Hz panel. A sleeping body is not
    read at all.

  And two safety nets, because the world streams and nothing may fall
  forever. A prop farther than PARK_RANGE from the focus is *parked*: its body
  is disabled where it is, keeping its transform, and wakes up when someone
  comes back. And a prop found well under the drawn ground (tunnelled, or
  left behind by a heightfield that was not there yet) is lifted back onto it
  a few times before it is given up on and removed.
*/

export type PropId = number

export interface Vec3Like {
  x: number
  y: number
  z: number
}
export interface QuatLike {
  x: number
  y: number
  z: number
  w: number
}

export interface SpawnOpts {
  /** orientation; `yaw` is the shorthand for a turn about y */
  quaternion?: QuatLike
  yaw?: number
  velocity?: Vec3Like
  angular?: Vec3Like
  /** spawn welded to the world (a frozen prop is a fixed body) */
  frozen?: boolean
  /** force the id (a prop arriving over the network keeps its sender's) */
  id?: PropId
  /** replace the kind's mesh for this one prop; null for none */
  mesh?: THREE.Object3D | null
  /** replace the kind's collision shape for this one prop (debris) */
  shape?: ShapeSpec
  /** replace the kind's mass */
  mass?: number
  /** anything the caller wants to keep on the record */
  data?: Record<string, unknown>
}

export type PropMode = 'dynamic' | 'frozen' | 'kinematic'

export interface Prop {
  readonly id: PropId
  readonly kind: PropKind
  readonly body: RBody
  readonly colliders: RCollider[]
  /** the drawn object, synced from the body every frame; null headless */
  readonly mesh: THREE.Object3D | null
  /** local half extents of the collision shape */
  readonly extents: THREE.Vector3
  readonly mass: number
  mode: PropMode
  /** disabled because nobody is near it; see the header */
  parked: boolean
  /** free for other systems: an owner, a health bar, an undo stamp */
  data: Record<string, unknown>
}

export type ImpactWith = 'prop' | 'ground' | 'solid' | 'vehicle' | 'player' | 'unknown'

/** a prop hit something. Allocated per event (they are rare); keep it if you like */
export interface ImpactEvent {
  id: PropId
  prop: Prop
  /** what it hit */
  with: ImpactWith
  /** the other prop, when it was one */
  other: Prop | null
  /** the world solid, when it was one (its `breaks` is destruction's hook) */
  solid: Solid | null
  /** mass times the change in velocity, kg*u/s */
  impulse: number
  /** the change in velocity itself, u/s */
  speed: number
  x: number
  y: number
  z: number
}

interface Rec extends Prop {
  mode: PropMode
  /** pose before and after the last slice: px py pz qx qy qz qw */
  prev: Float64Array
  cur: Float64Array
  /** velocity before the slice, for the impact test */
  vx: number
  vy: number
  vz: number
  awake: boolean
  lastImpact: number
  lost: number
  /** submerged share last slice, so damping is only rewritten on change */
  wet: number
  baseLin: number
  baseAng: number
  radius: number
}

/** props farther than this from the focus are parked */
export const PARK_RANGE = 200
/** ...and unparked inside this, so the edge does not flicker */
const UNPARK_RANGE = 184
/** a change of velocity under this in one slice is not an impact, u/s */
const IMPACT_DV = 3
/** one prop reports at most one impact per this many seconds */
const IMPACT_GAP = 0.09
/** how far under the ground (in radii) counts as lost */
const LOST_DEPTH = 1.5
const MAX_RESCUES = 3

const volumeOf = (s: Exclude<ShapeSpec, { type: 'compound' }>) => {
  switch (s.type) {
    case 'box':
      return 8 * s.hx * s.hy * s.hz
    case 'ball':
      return (4 / 3) * Math.PI * s.r ** 3
    case 'cylinder':
      return Math.PI * s.r * s.r * 2 * s.hh
    case 'cone':
      return (Math.PI * s.r * s.r * 2 * s.hh) / 3
    case 'hull': {
      const e = shapeExtents(s)
      return 8 * e.x * e.y * e.z * 0.6
    }
  }
}

export interface PropsOpts {
  pw: PhysicsWorld
  ground: Ground
  /** where meshes go; omit headless */
  root: THREE.Object3D | null
  /** the waterline, read live */
  waterY: () => number
  /** the drawn swell on top of it */
  waveAt?: (x: number, z: number) => number
}

export interface Props {
  spawn: (kind: string, at: Vec3Like, opts?: SpawnOpts) => PropId
  remove: (id: PropId) => boolean
  clear: () => void
  get: (id: PropId) => Prop | undefined
  /** the prop a collider belongs to */
  ofCollider: (c: RCollider) => Prop | undefined
  forEach: (fn: (p: Prop) => void) => void
  readonly count: number
  getTransform: (id: PropId, pos: THREE.Vector3, quat?: THREE.Quaternion) => boolean
  setTransform: (id: PropId, pos: Vec3Like, quat?: QuatLike) => void
  getVelocity: (id: PropId, lin: THREE.Vector3, ang?: THREE.Vector3) => boolean
  setVelocity: (id: PropId, lin?: Vec3Like, ang?: Vec3Like) => void
  applyImpulse: (id: PropId, impulse: Vec3Like, at?: Vec3Like) => void
  /** a force for the coming slice only; call it from a before-slice hook */
  addForce: (id: PropId, force: Vec3Like, at?: Vec3Like) => void
  setMode: (id: PropId, mode: PropMode) => void
  /** where a kinematic prop should be at the end of the next slice */
  moveKinematic: (id: PropId, pos: Vec3Like, quat?: QuatLike) => void
  wake: (id: PropId) => void
  onImpact: (fn: (e: ImpactEvent) => void) => () => void
  onSpawn: (fn: (p: Prop) => void) => () => void
  onRemove: (fn: (p: Prop) => void) => () => void
  /** once a frame, before the slices: parking, ground, rescue */
  frame: (fx: number, fz: number) => void
  beforeSlice: (h: number) => void
  afterSlice: (h: number) => void
  /** draw everything between its last two poses */
  draw: (alpha: number) => void
  readonly awake: number
  /** set by the facade so impacts can say "player" */
  isPlayer: (c: RCollider) => boolean
}

export const createProps = (o: PropsOpts): Props => {
  const { pw, ground, root } = o
  const { R, world } = pw
  const recs = new Map<PropId, Rec>()
  const byCollider = new Map<number, Rec>()
  const forced = new Set<Rec>()
  const impactFns = new Set<(e: ImpactEvent) => void>()
  const spawnFns = new Set<(p: Prop) => void>()
  const removeFns = new Set<(p: Prop) => void>()
  let nextId = 1
  let awakeCount = 0
  const templates = new Map<string, THREE.Object3D | null>()

  const meshFor = (k: PropKind) => {
    if (!root || !k.mesh) return null
    let t = templates.get(k.id)
    if (t === undefined) {
      t = k.mesh()
      templates.set(k.id, t)
    }
    return t ? t.clone() : null
  }

  const colliderDescs = (s: ShapeSpec, mass: number) => {
    const parts = s.type === 'compound' ? s.parts : [{ shape: s, at: undefined, rot: undefined, w: 1 }]
    // a part's share of the mass is its volume times its weight, which is how
    // a lamp post's cast base keeps its centre of mass at its foot
    const vols = parts.map((p) => volumeOf(p.shape) * (p.w ?? 1))
    const total = vols.reduce((a, b) => a + b, 0) || 1
    return parts.map((p, i) => {
      const ps = p.shape
      let d: InstanceType<typeof R.ColliderDesc> | null
      switch (ps.type) {
        case 'box':
          d = R.ColliderDesc.cuboid(ps.hx, ps.hy, ps.hz)
          break
        case 'ball':
          d = R.ColliderDesc.ball(ps.r)
          break
        case 'cylinder':
          d = R.ColliderDesc.cylinder(ps.hh, ps.r)
          break
        case 'cone':
          d = R.ColliderDesc.cone(ps.hh, ps.r)
          break
        case 'hull':
          d = R.ColliderDesc.convexHull(new Float32Array(ps.points))
          break
      }
      if (!d) d = R.ColliderDesc.ball(0.3)
      if (p.at) d.setTranslation(p.at[0], p.at[1], p.at[2])
      if (p.rot) d.setRotation({ x: p.rot[0], y: p.rot[1], z: p.rot[2], w: p.rot[3] })
      return d.setMass((mass * vols[i]) / total)
    })
  }

  const readPose = (r: Rec, out: Float64Array) => {
    const t = r.body.translation()
    const q = r.body.rotation()
    out[0] = t.x
    out[1] = t.y
    out[2] = t.z
    out[3] = q.x
    out[4] = q.y
    out[5] = q.z
    out[6] = q.w
  }

  const spawn = (kindId: string, at: Vec3Like, opts: SpawnOpts = {}): PropId => {
    const kind = KINDS[kindId]
    if (!kind) throw new Error(`no prop kind "${kindId}"`)
    const id = opts.id ?? nextId++
    if (id >= nextId) nextId = id + 1
    if (recs.has(id)) remove(id)
    const shape = opts.shape ?? kind.shape
    const mass = opts.mass ?? kind.mass
    const q = opts.quaternion ??
      (opts.yaw !== undefined
        ? { x: 0, y: Math.sin(opts.yaw / 2), z: 0, w: Math.cos(opts.yaw / 2) }
        : { x: 0, y: 0, z: 0, w: 1 })
    const baseLin = kind.linearDamping ?? 0.05
    const baseAng = kind.angularDamping ?? 0.1
    const desc = (opts.frozen ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic())
      .setTranslation(at.x, at.y, at.z)
      .setRotation(q)
      .setLinearDamping(baseLin)
      .setAngularDamping(baseAng)
      .setCcdEnabled(true)
    if (opts.velocity) desc.setLinvel(opts.velocity.x, opts.velocity.y, opts.velocity.z)
    if (opts.angular) desc.setAngvel(opts.angular)
    const body = world.createRigidBody(desc)
    const colliders: RCollider[] = []
    for (const d of colliderDescs(shape, mass)) {
      const c = world.createCollider(
        d.setFriction(kind.friction).setRestitution(kind.restitution).setCollisionGroups(GROUPS.prop),
        body,
      )
      colliders.push(c)
    }
    const mesh = opts.mesh !== undefined ? opts.mesh : meshFor(kind)
    if (mesh && root) {
      mesh.userData.dynamic = true
      mesh.userData.propId = id
      mesh.position.set(at.x, at.y, at.z)
      mesh.quaternion.set(q.x, q.y, q.z, q.w)
      root.add(mesh)
    }
    const extents = shapeExtents(shape)
    const r: Rec = {
      id, kind, body, colliders, mesh, extents, mass,
      mode: opts.frozen ? 'frozen' : 'dynamic',
      parked: false,
      data: opts.data ?? {},
      prev: new Float64Array([at.x, at.y, at.z, q.x, q.y, q.z, q.w]),
      cur: new Float64Array([at.x, at.y, at.z, q.x, q.y, q.z, q.w]),
      vx: opts.velocity?.x ?? 0,
      vy: opts.velocity?.y ?? 0,
      vz: opts.velocity?.z ?? 0,
      awake: true,
      lastImpact: -1,
      lost: 0,
      wet: 0,
      baseLin,
      baseAng,
      radius: extents.length(),
    }
    body.userData = r
    recs.set(id, r)
    for (const c of colliders) byCollider.set(c.handle, r)
    // its floor must exist before its first slice
    ground.need(chunkX(at.x), chunkZ(at.z))
    for (const fn of spawnFns) fn(r)
    return id
  }

  const remove = (id: PropId) => {
    const r = recs.get(id)
    if (!r) return false
    for (const fn of removeFns) fn(r)
    for (const c of r.colliders) byCollider.delete(c.handle)
    forced.delete(r)
    world.removeRigidBody(r.body)
    if (r.mesh) r.mesh.removeFromParent()
    recs.delete(id)
    return true
  }

  const need = (r: Rec) => {
    const x = r.cur[0]
    const z = r.cur[2]
    const e = r.radius + 1
    const x0 = chunkX(x - e)
    const x1 = chunkX(x + e)
    const z0 = chunkZ(z - e)
    const z1 = chunkZ(z + e)
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) ground.need(cx, cz)
  }

  /* -------------------------------------------------------------- water -- */

  const OCT = [
    [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
  ]
  const tmpF = { x: 0, y: 0, z: 0 }
  const tmpP = { x: 0, y: 0, z: 0 }

  /** rotate (x, y, z) by the quaternion in c[3..6] and add c[0..2] */
  const toWorld = (c: Float64Array, x: number, y: number, z: number, out: Vec3Like) => {
    const qx = c[3]
    const qy = c[4]
    const qz = c[5]
    const qw = c[6]
    const tx = 2 * (qy * z - qz * y)
    const ty = 2 * (qz * x - qx * z)
    const tz = 2 * (qx * y - qy * x)
    out.x = c[0] + x + qw * tx + (qy * tz - qz * ty)
    out.y = c[1] + y + qw * ty + (qz * tx - qx * tz)
    out.z = c[2] + z + qw * tz + (qx * ty - qy * tx)
  }

  const buoy = (r: Rec) => {
    const c = r.cur
    const wy = o.waterY()
    let share = 0
    if (c[1] - r.radius < wy + 0.6 && terrainY(c[0], c[2]) < wy) {
      const g = -pw.gravity
      const e = r.extents
      const thick = Math.max(0.1, ((e.x + e.y + e.z) / 3) * 1.0)
      const lift = g > 0 ? (r.mass * g) / Math.max(0.05, r.kind.density) / 8 : 0
      for (const [sx, sy, sz] of OCT) {
        toWorld(c, (sx * e.x) / 2, (sy * e.y) / 2, (sz * e.z) / 2, tmpP)
        const surface = wy + (o.waveAt ? o.waveAt(tmpP.x, tmpP.z) : 0)
        const f = Math.min(1, Math.max(0, (surface - tmpP.y) / thick + 0.5))
        if (f <= 0) continue
        share += f / 8
        tmpF.x = 0
        tmpF.y = lift * f
        tmpF.z = 0
        r.body.addForceAtPoint(tmpF, tmpP, true)
      }
      if (share > 0) forced.add(r)
    }
    // drag grows with how much of it is under, and per kilogram it grows with
    // how much water it displaces: water pushes on volume, so a beach ball
    // (1.2 kg for a big volume) is held back hard and a concrete block barely.
    // With one damping for everything the ball, buoyed at twelve times its
    // weight, was fired twenty units out of the sea every time it went under.
    // Rewritten only when the share moves
    if (Math.abs(share - r.wet) > 0.04 || (share === 0 && r.wet !== 0)) {
      r.wet = share
      const perKg = Math.min(16, 1.2 / Math.max(0.05, r.kind.density))
      r.body.setLinearDamping(r.baseLin + (0.6 + perKg) * share)
      r.body.setAngularDamping(r.baseAng + (0.4 + perKg * 0.6) * share)
    }
  }

  /* ------------------------------------------------------------ impacts -- */

  const emitImpact = (r: Rec, dv: number) => {
    const col = r.colliders[0]
    let best = -1
    let other: RCollider | null = null
    const pt = { x: r.cur[0], y: r.cur[1], z: r.cur[2] }
    world.contactPairsWith(col, (c2) => {
      world.contactPair(col, c2, (m) => {
        let sum = 0
        for (let i = 0; i < m.numContacts(); i++) sum += m.contactImpulse(i)
        if (sum > best) {
          best = sum
          other = c2
          const p = m.numSolverContacts() > 0 ? m.solverContactPoint(0) : null
          if (p) {
            pt.x = p.x
            pt.y = p.y
            pt.z = p.z
          }
        }
      })
    })
    let kind: ImpactWith = 'unknown'
    let otherProp: Prop | null = null
    let solid: Solid | null = null
    const oc = other as RCollider | null
    if (oc) {
      const op = byCollider.get(oc.handle)
      if (op) {
        kind = 'prop'
        otherProp = op
      } else if (ground.isGround(oc)) kind = 'ground'
      else if (ground.isVehicle(oc)) kind = 'vehicle'
      else if (api.isPlayer(oc)) kind = 'player'
      else {
        solid = ground.solidOf(oc) ?? null
        if (solid) kind = 'solid'
      }
    }
    const e: ImpactEvent = {
      id: r.id, prop: r, with: kind, other: otherProp, solid,
      impulse: r.mass * dv, speed: dv, x: pt.x, y: pt.y, z: pt.z,
    }
    for (const fn of impactFns) fn(e)
  }

  /* -------------------------------------------------------------- frame -- */

  const frame = (fx: number, fz: number) => {
    for (const r of recs.values()) {
      const dx = r.cur[0] - fx
      const dz = r.cur[2] - fz
      const d2 = dx * dx + dz * dz
      if (!r.parked && d2 > PARK_RANGE * PARK_RANGE) {
        r.parked = true
        r.body.setEnabled(false)
        continue
      }
      if (r.parked) {
        if (d2 > UNPARK_RANGE * UNPARK_RANGE) continue
        r.parked = false
        need(r)
        r.body.setEnabled(true)
        r.body.wakeUp()
      }
      if (r.mode !== 'frozen') need(r)
    }
  }

  const beforeSlice = () => {
    // re-lay forces: everything pushed last slice starts clean
    for (const r of forced) if (recs.has(r.id)) r.body.resetForces(false)
    forced.clear()
    awakeCount = 0
    for (const r of recs.values()) {
      if (r.parked || r.mode !== 'dynamic') {
        r.awake = false
        continue
      }
      r.awake = !r.body.isSleeping()
      r.prev.set(r.cur)
      if (!r.awake) continue
      awakeCount++
      const v = r.body.linvel()
      r.vx = v.x
      r.vy = v.y
      r.vz = v.z
      buoy(r)
    }
  }

  const afterSlice = (h: number) => {
    const t = pw.time + h
    for (const r of recs.values()) {
      if (r.parked) continue
      if (r.mode === 'kinematic') {
        r.prev.set(r.cur)
        readPose(r, r.cur)
        continue
      }
      if (!r.awake) continue
      readPose(r, r.cur)
      const v = r.body.linvel()
      const dvx = v.x - r.vx
      const dvy = v.y - r.vy - pw.gravity * h
      const dvz = v.z - r.vz
      const dv = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz)
      if (dv > IMPACT_DV && t - r.lastImpact > IMPACT_GAP && impactFns.size) {
        r.lastImpact = t
        emitImpact(r, dv)
      }
      // lost under the ground: lift it back, or give up on it
      const gy = terrainY(r.cur[0], r.cur[2])
      if (r.cur[1] < gy - Math.max(2, r.radius * LOST_DEPTH) || r.cur[1] < -2000) {
        if (++r.lost > MAX_RESCUES || r.cur[1] < -2000) {
          remove(r.id)
          continue
        }
        r.body.setTranslation({ x: r.cur[0], y: gy + r.extents.y + 0.3, z: r.cur[2] }, true)
        r.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        r.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
        readPose(r, r.cur)
        r.prev.set(r.cur)
      }
    }
  }

  const qa = new THREE.Quaternion()
  const draw = (alpha: number) => {
    const a = Math.min(1, Math.max(0, alpha))
    for (const r of recs.values()) {
      const m = r.mesh
      if (!m) continue
      const p = r.prev
      const c = r.cur
      m.position.set(p[0] + (c[0] - p[0]) * a, p[1] + (c[1] - p[1]) * a, p[2] + (c[2] - p[2]) * a)
      qa.set(p[3], p[4], p[5], p[6])
      m.quaternion.set(c[3], c[4], c[5], c[6])
      m.quaternion.slerpQuaternions(qa, m.quaternion, a)
    }
  }

  const with_ = (id: PropId, fn: (r: Rec) => void) => {
    const r = recs.get(id)
    if (r) fn(r)
  }

  const api: Props = {
    spawn,
    remove,
    clear: () => {
      for (const id of [...recs.keys()]) remove(id)
    },
    get: (id) => recs.get(id),
    ofCollider: (c) => byCollider.get(c.handle),
    forEach: (fn) => {
      for (const r of recs.values()) fn(r)
    },
    get count() {
      return recs.size
    },
    getTransform: (id, pos, quat) => {
      const r = recs.get(id)
      if (!r) return false
      pos.set(r.cur[0], r.cur[1], r.cur[2])
      quat?.set(r.cur[3], r.cur[4], r.cur[5], r.cur[6])
      return true
    },
    setTransform: (id, pos, quat) =>
      with_(id, (r) => {
        r.body.setTranslation(pos, true)
        if (quat) r.body.setRotation(quat, true)
        readPose(r, r.cur)
        r.prev.set(r.cur)
        need(r)
      }),
    getVelocity: (id, lin, ang) => {
      const r = recs.get(id)
      if (!r) return false
      const v = r.body.linvel()
      lin.set(v.x, v.y, v.z)
      if (ang) {
        const w = r.body.angvel()
        ang.set(w.x, w.y, w.z)
      }
      return true
    },
    setVelocity: (id, lin, ang) =>
      with_(id, (r) => {
        if (lin) {
          r.body.setLinvel(lin, true)
          // a velocity someone set is not an impact
          r.vx = lin.x
          r.vy = lin.y
          r.vz = lin.z
        }
        if (ang) r.body.setAngvel(ang, true)
      }),
    applyImpulse: (id, imp, at) =>
      with_(id, (r) => {
        if (at) r.body.applyImpulseAtPoint(imp, at, true)
        else r.body.applyImpulse(imp, true)
        r.vx += imp.x / r.mass
        r.vy += imp.y / r.mass
        r.vz += imp.z / r.mass
      }),
    addForce: (id, f, at) =>
      with_(id, (r) => {
        if (at) r.body.addForceAtPoint(f, at, true)
        else r.body.addForce(f, true)
        forced.add(r)
      }),
    setMode: (id, mode) =>
      with_(id, (r) => {
        if (r.mode === mode) return
        r.mode = mode
        r.body.setBodyType(
          mode === 'frozen'
            ? R.RigidBodyType.Fixed
            : mode === 'kinematic'
              ? R.RigidBodyType.KinematicPositionBased
              : R.RigidBodyType.Dynamic,
          true,
        )
        if (mode === 'dynamic') {
          r.body.wakeUp()
          const v = r.body.linvel()
          r.vx = v.x
          r.vy = v.y
          r.vz = v.z
        }
      }),
    moveKinematic: (id, pos, quat) =>
      with_(id, (r) => {
        if (r.mode !== 'kinematic') return
        r.body.setNextKinematicTranslation(pos)
        if (quat) r.body.setNextKinematicRotation(quat)
      }),
    wake: (id) => with_(id, (r) => r.body.wakeUp()),
    onImpact: (fn) => {
      impactFns.add(fn)
      return () => impactFns.delete(fn)
    },
    onSpawn: (fn) => {
      spawnFns.add(fn)
      return () => spawnFns.delete(fn)
    },
    onRemove: (fn) => {
      removeFns.add(fn)
      return () => removeFns.delete(fn)
    },
    frame,
    beforeSlice,
    afterSlice,
    draw,
    get awake() {
      return awakeCount
    },
    isPlayer: () => false,
  }
  return api
}
