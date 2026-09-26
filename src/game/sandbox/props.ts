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

  - **forces are re-laid.** Rapier's user forces and torques persist until
    reset (each separately: `resetForces` leaves torques alone), so
    every body that was pushed by anything last slice is reset first and the
    forces are laid again (buoyancy, the weight of a player standing on it,
    whatever a tool adds through `addForce`). A body nobody pushes pays
    nothing.
  - **water.** Buoyancy is sampled at the points of a 3x3x3 grid that fall
    inside the prop's actual shape, each carrying its share of
    `mass * g / density` scaled by how far under the drawn surface it is:
    SEA_Y plus the swell the water shader draws, taken as a plane through the
    prop's footprint, so a floater heaves with the crests, tilts with their
    faces and is shoved down the slope of each one. A crate at density 0.5
    rides half under and a beach ball barely wets. Drag is Rapier's own
    (implicit, so stable at any strength) linear and angular damping, scaled
    by the water displaced per kilogram and by how much is under, and the
    water it drags toward is *moving*: a slow current, wind on whatever
    stands out, an eddy per prop, a wandering turn and a gentle rock, all
    read off the simulation's clock. A floater never sleeps, because the sea
    keeps moving under it (round two's parked on the swell like decals). What
    made the first version's sea churn (crates swinging forty degrees frame
    to frame, drums flipping end on) was not the model but a torque that was
    never cleared: see the force re-lay above. The buoyancy goes to Rapier as
    one force and one torque. A prop that goes in hard reports a splash.
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
  /** how much of it is under the drawn sea, 0..1 (the waterline cue and any
      sound that wants to know it plopped rather than thudded read this) */
  readonly wet: number
  /** free for other systems: an owner, a health bar, an undo stamp */
  data: Record<string, unknown>
}

/** a prop hit the water hard enough to throw it up. Allocated per event */
export interface SplashEvent {
  id: PropId
  prop: Prop
  /** where it went in, on the drawn surface */
  x: number
  y: number
  z: number
  /** how fast it was going down, u/s */
  speed: number
  /** mass times that speed, kg*u/s */
  impulse: number
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
  /** submerged share last slice */
  wet: number
  /** the share the water damping was last written for (rewritten on change) */
  dampedAt: number
  /** in the water last slice, for the splash on the way in */
  inWater: boolean
  lastSplash: number
  /** a fixed phase per prop, so a raft of floaters does not move as one */
  phase: number
  /** half the footprint's diagonal, clamped: the span the swell is sampled over */
  span: number
  baseLin: number
  baseAng: number
  radius: number
  shape: ShapeSpec
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

const hashBuf = new Float64Array(14)
const hashBytes = new Uint8Array(hashBuf.buffer)

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

/*
  Where a body is sampled for buoyancy: a 3x3x3 grid over its box, keeping
  only the points inside the actual shape, weighted equally. Eight octant
  centres (the first version) put a sphere's samples in the air at its
  corners and a drum's in the wrong places, so the ball floated on nothing
  and a barrel's waterline kept flipping it end on. Inside the shape, the
  samples are the shape's volume and the waterline follows from density.
*/
interface Samples {
  /** local points, xyz */
  p: Float32Array
  /** weights, summing to 1 */
  w: Float32Array
  /** the vertical span over which one sample goes from dry to under */
  t: number
}
const sampleCache = new WeakMap<ShapeSpec, Samples>()

const inside = (s: ShapeSpec, x: number, y: number, z: number): boolean => {
  switch (s.type) {
    case 'box':
    case 'hull':
      return true
    case 'ball':
      return x * x + y * y + z * z <= s.r * s.r * 1.02
    case 'cylinder':
      return x * x + z * z <= s.r * s.r * 1.02 && Math.abs(y) <= s.hh
    case 'cone': {
      // the radius shrinks from r at the base (-hh) to nothing at the tip
      const rr = s.r * (0.5 - y / (2 * s.hh))
      return Math.abs(y) <= s.hh && x * x + z * z <= rr * rr * 1.05
    }
    case 'compound':
      return s.parts.some((p) => {
        const [ax, ay, az] = p.at ?? [0, 0, 0]
        return inside(p.shape, x - ax, y - ay, z - az)
      })
  }
}

const samplesFor = (s: ShapeSpec): Samples => {
  const hit = sampleCache.get(s)
  if (hit) return hit
  const e = shapeExtents(s)
  const pts: number[] = []
  for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) for (const k of [-1, 0, 1]) {
    const x = (i * 2 * e.x) / 3
    const y = (j * 2 * e.y) / 3
    const z = (k * 2 * e.z) / 3
    if (inside(s, x, y, z)) pts.push(x, y, z)
  }
  if (pts.length < 3) pts.push(0, 0, 0)
  const n = pts.length / 3
  const out: Samples = {
    p: new Float32Array(pts),
    w: new Float32Array(n).fill(1 / n),
    // the smallest side of a sample's cell. Fixed per shape on purpose: a
    // force at a body point that depends only on that point's own depth is
    // conservative, and one whose ramp changed with the body's attitude (an
    // attempt at "how tall does this cell stand right now") was not, and
    // pumped a floating plank up to 30 rad/s of tumbling in still water. It
    // is also why this is the smallest side and not an average: a plank's
    // average was its length, and a ramp that long stood it on end
    t: Math.max(0.1, (2 * Math.min(e.x, e.y, e.z)) / 3),
  }
  sampleCache.set(s, out)
  return out
}

/** how hard water drags, per second, for a prop wholly under at density 1;
    it scales with the water displaced per kilogram. Five puts a floating
    crate's bob at a damping ratio near 0.4: it goes in, comes up, rocks once
    or twice and rides */
const WATER_DRAG = 5
/** rotation's share of it: more, for the slow nod rather than a wobble */
const WATER_SPIN_DRAG = 1.4
/** the sea's current, u/s, and the heading it veers about: downwind, the
    way the grass leans (wind.ts's uWind, 0.82 / 0.57) */
const CURRENT = 0.3
const CURRENT_HEADING = Math.atan2(0.57, 0.82)
/** what a wholly dry floater would add in wind, u/s (a ball rides high) */
const WINDAGE = 0.55
/** each floater's own wander on top, u/s */
const EDDY = 0.14
/** the yaw rate a floater wanders about, rad/s */
const TURN = 0.16
/** the rocking drive about the horizontals, rad/s it would reach unrighted */
const ROCK = 0.2
/** a prop entering the water faster than this, downward, splashes */
const SPLASH_SPEED = 5

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
  /** a prop went into the water hard */
  onSplash: (fn: (e: SplashEvent) => void) => () => void
  onSpawn: (fn: (p: Prop) => void) => () => void
  onRemove: (fn: (p: Prop) => void) => () => void
  /** once a frame, before the slices: parking, ground, rescue */
  frame: (fx: number, fz: number) => void
  beforeSlice: (h: number) => void
  afterSlice: (h: number) => void
  /** draw everything between its last two poses */
  draw: (alpha: number) => void
  readonly awake: number
  /** a fingerprint of every prop's pose and velocity, to the bit */
  stateHash: () => string
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
  const splashFns = new Set<(e: SplashEvent) => void>()
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
    const ballast = opts.shape ? undefined : kind.ballast
    const carried = ballast ? mass * ballast.share : 0
    for (const d of colliderDescs(shape, mass - carried)) {
      const c = world.createCollider(
        d.setFriction(kind.friction).setRestitution(kind.restitution).setCollisionGroups(GROUPS.prop),
        body,
      )
      colliders.push(c)
    }
    if (ballast && carried > 0) {
      // a point load: Rapier folds it in with the parallel-axis theorem
      const [bx, by, bz] = ballast.at
      body.setAdditionalMassProperties(
        carried, { x: bx, y: by, z: bz }, { x: 1e-4, y: 1e-4, z: 1e-4 }, { x: 0, y: 0, z: 0, w: 1 }, false,
      )
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
      dampedAt: 0,
      inWater: false,
      lastSplash: -1,
      phase: ((Math.imul(id, 2654435761) >>> 0) / 4294967296) * Math.PI * 2,
      span: Math.min(4, Math.max(1, Math.hypot(extents.x, extents.z))),
      baseLin,
      baseAng,
      radius: extents.length(),
      shape,
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

  const samplesOf = (r: Rec) => samplesFor(r.shape)
  const tmpP = { x: 0, y: 0, z: 0 }
  const tmpF = { x: 0, y: 0, z: 0 }
  const tmpT = { x: 0, y: 0, z: 0 }

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

  let inertiaBuf: ReturnType<RBody['effectiveAngularInertia']> | undefined

  const buoy = (r: Rec) => {
    const c = r.cur
    const wy = o.waterY()
    let share = 0
    let fy = 0
    let fx = 0
    let fz = 0
    let tx = 0
    let tz = 0
    let surf0 = wy
    if (c[1] - r.radius < wy + 0.6 && terrainY(c[0], c[2]) < wy) {
      const g = -pw.gravity
      const S = samplesOf(r)
      const n = S.w.length
      /*
        The drawn swell under the prop as a plane: its height at the centre
        and its slope by central differences over the prop's own footprint
        (`span`), so a plank lying across a crest feels the chord it spans
        rather than the tangent at its middle. Every sample is then under or
        over *that* surface, so a floater heaves with the crests and tilts
        with their faces: the sea it answers to is the one on screen.
      */
      const wave = o.waveAt
      const sp = r.span
      const w0 = wave ? wave(c[0], c[2]) : 0
      const gx = wave ? (wave(c[0] + sp, c[2]) - wave(c[0] - sp, c[2])) / (2 * sp) : 0
      const gz = wave ? (wave(c[0], c[2] + sp) - wave(c[0], c[2] - sp)) / (2 * sp) : 0
      surf0 = wy + w0
      // the water this body would displace fully under, in kilograms
      const displaced = r.mass / Math.max(0.05, r.kind.density)
      // levers are taken from the centre of mass, which is where Rapier
      // applies the summed force and about which it applies the torque
      const com = r.body.worldCom()
      for (let i = 0; i < n; i++) {
        toWorld(c, S.p[i * 3], S.p[i * 3 + 1], S.p[i * 3 + 2], tmpP)
        const surface = surf0 + gx * (tmpP.x - c[0]) + gz * (tmpP.z - c[2])
        const f = Math.min(1, Math.max(0, (surface - tmpP.y) / S.t + 0.5))
        if (f <= 0) continue
        const wf = S.w[i] * f
        share += wf
        const rx = tmpP.x - com.x
        const rz = tmpP.z - com.z
        const sy = g > 0 ? g * displaced * wf : 0
        fy += sy
        tx += -rz * sy
        tz += rx * sy
      }
      // pressure pushes along the surface's normal, not straight up: on the
      // face of a swell a floater is shoved down the slope, which is the
      // surge that carries it to and fro as each crest passes under it
      fx = -gx * fy
      fz = -gz * fy
    }
    const floats = r.kind.density < 1
    // the splash on the way in, once, and only for something that arrived
    // with some speed (a floater bobbing out and back in is not an entry)
    if (share > 0 && !r.inWater && pw.time - r.lastSplash > 0.4) {
      const vy = r.body.linvel().y
      if (vy < -SPLASH_SPEED && splashFns.size) {
        r.lastSplash = pw.time
        const e: SplashEvent = {
          id: r.id, prop: r, x: c[0], y: surf0, z: c[2], speed: -vy, impulse: -vy * r.mass,
        }
        for (const fn of splashFns) fn(e)
      }
    }
    r.inWater = share > 0
    r.wet = share
    /*
      Drag, as Rapier's own damping rather than as a force. Damping is
      integrated implicitly (v / (1 + h c)), which is stable at any strength;
      an explicit drag torque is not, and summed at the samples it wound a
      plank (tiny inertia about its long axis, long lever to its ends) up to
      47 rad/s in still water. Its size is the water displaced per kilogram
      of prop times how much of it is under, so a beach ball is held hard and
      a concrete block barely. Rewritten only when the share moves.
    */
    const perKg = share > 0 ? (share * WATER_DRAG) / Math.max(0.05, r.kind.density) : 0
    if (Math.abs(share - r.dampedAt) > 0.03 || (share === 0 && r.dampedAt !== 0)) {
      r.dampedAt = share
      r.body.setLinearDamping(r.baseLin + perKg)
      r.body.setAngularDamping(r.baseAng + perKg * WATER_SPIN_DRAG)
    }
    let ty = 0
    if (share > 0 && floats) {
      /*
        The sea is not still water, and damping alone drags every floater to
        a dead stop on it (round two's props sat parked on painted glass
        while the swell slid under them). So the water *moves*, and the
        damping drags toward the water's velocity rather than toward zero:
        a force of `damping * mass * u` makes `u` the speed the damping
        settles on. It is independent of the prop's own velocity, so it can
        drive but never pump, and the drag stays implicit.

        u is a slow current that veers over a minute, a wind on whatever
        stands out of the water (a beach ball riding high skates, a
        waterlogged plank barely goes), and an eddy of the prop's own, so two
        crates side by side drift apart rather than as a raft. The same trick
        turns them: a yaw rate that wanders, and a gentle rock about the
        horizontals the buoyancy's own righting holds to a few degrees. All
        of it reads the simulation's clock and the prop's id, never the wall
        clock or a random number, so a replay floats the same way.
      */
      const t = pw.time
      const ph = r.phase
      const ca = CURRENT_HEADING + 0.6 * Math.sin(t * 0.027 + 1.3)
      const dry = Math.max(0, 1 - share)
      const drift = CURRENT + WINDAGE * dry
      const ux = Math.cos(ca) * drift + EDDY * Math.sin(t * 0.37 + ph)
      const uz = Math.sin(ca) * drift + EDDY * Math.cos(t * 0.29 + ph * 1.7)
      const pull = perKg * r.mass
      fx += pull * ux
      fz += pull * uz
      // the drive torques are inertia times the angular damping times the
      // rate they settle on, about world y and the two horizontals
      inertiaBuf = r.body.effectiveAngularInertia(inertiaBuf)
      // each axis by its own inertia: a plank's about its length is a
      // seventieth of its yaw, and one number for all three spun it like a
      // drill bit
      const I = inertiaBuf
      const spinPull = perKg * WATER_SPIN_DRAG
      const turn = TURN * (Math.sin(t * 0.21 + ph) + 0.6 * Math.sin(ph * 3.1))
      ty = spinPull * I.m22 * turn
      tx += ROCK * spinPull * I.m11 * Math.sin(t * 1.3 + ph * 2.3)
      tz += ROCK * spinPull * I.m33 * Math.cos(t * 1.1 + ph * 1.9)
    }
    if (share > 0) {
      // one force and one torque for the whole body rather than a call per
      // sample: the sum is the same and the WASM boundary is not free
      tmpF.x = fx
      tmpF.y = fy
      tmpF.z = fz
      tmpT.x = tx
      tmpT.y = ty
      tmpT.z = tz
      r.body.addForce(tmpF, true)
      r.body.addTorque(tmpT, true)
      forced.add(r)
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
    // both: Rapier keeps forces and torques in separate accumulators, and
    // resetForces leaves the torque alone. Every force laid at a point adds
    // a torque, so until this cleared both, the buoyancy torque of every
    // floating prop grew without bound and the sea spun crates and flipped
    // drums end over end
    for (const r of forced) {
      if (!recs.has(r.id)) continue
      r.body.resetForces(false)
      r.body.resetTorques(false)
    }
    forced.clear()
    awakeCount = 0
    for (const r of recs.values()) {
      if (r.parked || r.mode !== 'dynamic') {
        r.awake = false
        continue
      }
      r.awake = !r.body.isSleeping()
      // a floater never sleeps: the sea keeps moving under it, and a body
      // asleep lays no buoyancy, so it would sit on the swell like a decal.
      // Something sunk (denser than water) may rest on the bottom
      if (!r.awake && r.wet > 0 && r.kind.density < 1) {
        r.body.wakeUp()
        r.awake = true
      }
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

  /** is any of its colliders in contact with anything right now */
  const touching = (r: Rec) => {
    let hit = false
    for (const col of r.colliders) {
      world.contactPairsWith(col, (c2) => {
        if (hit) return
        world.contactPair(col, c2, (m) => {
          if (m.numContacts() > 0) hit = true
        })
      })
      if (hit) return true
    }
    return false
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
      // rolling resistance: a speed loss of crr * g a second, never more than
      // the speed there is, taken off the horizontal motion and the spin in
      // the same proportion so a rolling drum stays rolling rather than
      // skidding, and a drum left spinning on its end like a top winds down
      // too. Rapier has no rolling friction at all, which is why a pile's
      // last barrel was still turning in place at twenty seconds. Only on
      // something (a slow vertical, then a real contact: a thrown drum loses
      // nothing in the air), and not afloat
      const crr = r.kind.rolling
      if (crr && r.wet === 0 && Math.abs(v.y) < 1.2 && touching(r)) {
        const sp = Math.hypot(v.x, v.z)
        const w = r.body.angvel()
        const spin = Math.hypot(w.x, w.y, w.z) * r.radius * 0.5
        const lose = crr * -pw.gravity * h
        const fast = Math.max(sp, spin)
        if (fast > 1e-4) {
          const k = Math.max(0, fast - lose) / fast
          r.body.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, false)
          r.body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false)
          r.vx = v.x * k
          r.vz = v.z * k
        }
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
    onSplash: (fn) => {
      splashFns.add(fn)
      return () => splashFns.delete(fn)
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
    stateHash: () => {
      // FNV-1a over the raw bytes of id, position, rotation and both
      // velocities, in id order (a Map iterates in insertion order, and ids
      // are handed out in spawn order, so two runs agree on the order too)
      let h = 2166136261
      for (const r of recs.values()) {
        const t = r.body.translation()
        const q = r.body.rotation()
        const v = r.body.linvel()
        const w = r.body.angvel()
        hashBuf[0] = r.id
        hashBuf[1] = t.x
        hashBuf[2] = t.y
        hashBuf[3] = t.z
        hashBuf[4] = q.x
        hashBuf[5] = q.y
        hashBuf[6] = q.z
        hashBuf[7] = q.w
        hashBuf[8] = v.x
        hashBuf[9] = v.y
        hashBuf[10] = v.z
        hashBuf[11] = w.x
        hashBuf[12] = w.y
        hashBuf[13] = w.z
        for (let i = 0; i < hashBytes.length; i++) h = Math.imul(h ^ hashBytes[i], 16777619) >>> 0
      }
      return h.toString(16).padStart(8, '0')
    },
    isPlayer: () => false,
  }
  return api
}
