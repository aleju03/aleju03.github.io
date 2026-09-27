import * as THREE from 'three'
import type { CollisionSet, Solid } from '../physics/collision'
import { chunkX, chunkZ } from '../world/grid'
import { createGround, TERRAIN_GROUND, type Ground, type SandboxGround } from './ground'
import { KINDS, propMaterial, registerKind, shapeExtents, type PropKind } from './kinds'
import {
  createPhysicsWorld, GROUPS, loadRapier, STEP, type PhysicsWorld, type Rapier, type RCollider,
} from './physics'
import {
  createProps, type ImpactEvent, type Prop, type PropId, type PropMode, type Props,
  type QuatLike, type SpawnOpts, type SplashEvent, type Vec3Like,
} from './props'
import { createWalker, type Walker, type WalkerState } from './walker'
import { createWake } from './wake'
import './catalogue'
// the contraption parts register after the catalogue, under their own tab
import './contraption/parts'
import { createBatcher, warmBatch, type Batcher } from './batch'
import { createFx, type Fx } from './fx'
import { createLife, type BreakEvent, type PropLife } from './breakables'
import { createExplosions, type ExplosionEvent, type Explosions } from './explosion'
// the scene reaches these through its dynamic import of this module, so
// knocking the walker and the town flat costs the room boot nothing
export { blastImpact, blastWatch } from './explosion'
export { CATALOGUE, CATEGORIES, catalogueEntry, inCategory, type CatalogueEntry, type Category } from './catalogue'
export { renderThumbnails } from './thumbnails'
// destruction registers its rubble kinds and its console commands on import,
// and the scene attaches it to the world's ruins once both exist
export { attachDestruction, destructionOf, type Destruction, type DamageRecord } from './destruction'
import { setEar, setEarFallback } from './impactSounds'

/*
  The sandbox: one facade over the physics world, the ground it stands on,
  the props and the walker's place among them. This is the only thing the
  scene and the other sandbox systems (the physgun, the console, destruction,
  the network) hold, and `tick` is the only thing CrtScene calls, once a frame.

  It exists before Rapier does. `createSandbox` is synchronous and cheap, and
  starts the Rapier download itself; until that lands `ready` is false, `tick`
  does nothing, and spawns are queued (their ids are handed out at once, so a
  caller can hold on to what it asked for). So creating it never blocks a
  frame, and it can be created at the moment the world attaches, under the
  boot cover, which is where its one material is compiled (the `warm` mesh,
  parked far below the world where it is never drawn but is seen by
  `compileAsync`).

  A frame is:
    1. the ground ring follows the focus (the walker, or whatever `focus`
       says when nobody is walking) and every prop that is not parked;
    2. the walker's shoves from this frame's walk are applied, the prop it
       is standing on is found, and its kinematic mirror is aimed;
    3. as many fixed slices as the frame's dt buys, each laying forces
       (buoyancy, the walker's weight, whatever a tool hooks in with
       `onBeforeSlice`) and each checking for impacts and lost bodies;
    4. every mesh drawn between its last two poses, and the walker carried
       with whatever they are riding.

  It is renderer-free: with no `parent` it builds no meshes and runs in Node,
  which is what `npm run measure -- physics` and the film harness drive.

  Importing it imports the catalogue (catalogue.ts registers the forty-one
  kinds), and the facade carries the three things that make props more than
  rigid bodies: breakables.ts (impact sounds, damage, gibs, fuses),
  explosion.ts (`explode` and `onExplosion`) and fx.ts (the particles, stepped
  in sim time after every slice). Prop meshes are batch proxies (batch.ts),
  written into one InstancedMesh per shape after the draw, so a street of
  three hundred props costs a draw per kind in view.
*/

export type {
  BreakEvent, ExplosionEvent, ImpactEvent, Prop, PropId, PropKind, PropMode, QuatLike, SpawnOpts, SplashEvent,
  Vec3Like, WalkerState,
}
export { KINDS, registerKind }

export interface SandboxOpts {
  /** where prop meshes go; omit to run headless */
  parent?: THREE.Object3D | null
  /** the overworld's collision set: its boxes become static colliders, and
      the walker seam is attached to it as `dynamic` */
  collision: CollisionSet
  /** the waterline, read live (the sea does not exist until the world does) */
  waterY?: () => number
  /** the drawn swell on top of it */
  waveAt?: (x: number, z: number) => number
  /** drop the world's own ripple rings on the sea (the water shader's); the
      sandbox calls it when a prop goes in hard */
  splash?: (x: number, z: number) => void
  /** the solids of any loaded chunk, for props outside the walker's nine */
  chunkSolids?: (cx: number, cz: number) => readonly Solid[] | null | undefined
  /** hand the walker seam to `collision` (default true) */
  walker?: boolean
  /** what the props land on, when it is not the overworld's terrain: a level
      with ground of its own (the Moon) hands in its lattice here */
  ground?: SandboxGround
}

export interface SandboxTick {
  dt: number
  /** false holds the simulation still: another level, the pause sheet */
  active: boolean
  /** the walker, when somebody is on foot */
  walker?: WalkerState | null
  /** what the ring centres on when nobody is walking (a driver, a camera) */
  focus?: Vec3Like
}

export interface SandboxFrame {
  /** fixed slices taken this frame */
  steps: number
  /** props awake */
  awake: number
  /** awake props within shadow range of the focus: the scene re-bakes the
      sun's map while this is non-zero */
  moving: number
  /** milliseconds this tick cost */
  ms: number
}

export interface RayHit {
  distance: number
  point: THREE.Vector3
  normal: THREE.Vector3
  /** the prop hit, if it was one */
  prop: Prop | null
  /** the world solid hit, if it was one */
  solid: Solid | null
  /** true when it was the terrain */
  ground: boolean
}

export interface Sandbox {
  readonly ready: boolean
  readonly whenReady: Promise<void>
  /** every prop mesh hangs off this */
  readonly root: THREE.Group
  /** a mesh carrying every sandbox material, for a covered compile */
  readonly warm: THREE.Object3D
  tick: (t: SandboxTick) => SandboxFrame

  /* props */
  spawn: (kind: string, at: Vec3Like, opts?: SpawnOpts) => PropId
  remove: (id: PropId) => boolean
  /** remove every prop */
  clear: () => void
  get: (id: PropId) => Prop | undefined
  forEach: (fn: (p: Prop) => void) => void
  readonly count: number
  getTransform: (id: PropId, pos: THREE.Vector3, quat?: THREE.Quaternion) => boolean
  setTransform: (id: PropId, pos: Vec3Like, quat?: QuatLike) => void
  getVelocity: (id: PropId, lin: THREE.Vector3, ang?: THREE.Vector3) => boolean
  setVelocity: (id: PropId, lin?: Vec3Like, ang?: Vec3Like) => void
  applyImpulse: (id: PropId, impulse: Vec3Like, at?: Vec3Like) => void
  /** a force for the coming slice; call from an `onBeforeSlice` hook */
  addForce: (id: PropId, force: Vec3Like, at?: Vec3Like) => void
  freeze: (id: PropId) => void
  unfreeze: (id: PropId) => void
  setMode: (id: PropId, mode: PropMode) => void
  moveKinematic: (id: PropId, pos: Vec3Like, quat?: QuatLike) => void
  wake: (id: PropId) => void
  /** is any other prop touching this one (a gib a crate rests on) */
  inContact: (id: PropId) => boolean

  /* events and hooks; each returns its unsubscribe */
  onImpact: (fn: (e: ImpactEvent) => void) => () => void
  /** a prop went into the water hard (the splash is already drawn) */
  onSplash: (fn: (e: SplashEvent) => void) => () => void
  onSpawn: (fn: (p: Prop) => void) => () => void
  onRemove: (fn: (p: Prop) => void) => () => void
  /** runs ahead of every fixed slice, with the slice length */
  onBeforeSlice: (fn: (h: number) => void) => () => void
  onAfterSlice: (fn: (h: number) => void) => () => void

  /* queries */
  /** the first prop, solid or ground along a ray (props and world only;
      never the walker or a vehicle) */
  raycast: (origin: Vec3Like, dir: Vec3Like, maxDist: number, opts?: { props?: boolean; world?: boolean }) => RayHit | null
  /** the prop a Rapier collider belongs to (for a tool casting its own ray) */
  propOf: (c: unknown) => Prop | null
  /** the prop the walker is standing on, if any (a physgun must not lift it) */
  readonly standing: Prop | null
  /** every prop overlapping a ball */
  queryBall: (center: Vec3Like, r: number, fn: (p: Prop) => void) => void
  /** the drawn ground height */
  groundY: (x: number, z: number) => number
  /** the world's solids changed in number (destruction added a building's
      pieces): mirror them on the next frame */
  solidsChanged: () => void
  /** the height at which a kind, upright, rests on the ground here */
  restY: (kind: string, x: number, z: number) => number

  /** where the last tick was centred: the walker's eye, or its `focus` */
  readonly focus: THREE.Vector3

  /* what props do besides move (breakables.ts, explosion.ts) */
  /** a blast: radial impulse, damage (chains other explosives), fx, boom */
  explode: (at: Vec3Like, power?: number, radius?: number) => ExplosionEvent
  /** every blast, after it has pushed the props: knock people flat, crack
      buildings (explosion.ts's blastImpact/blastWatch do the maths) */
  onExplosion: (fn: (e: ExplosionEvent) => void) => () => void
  /** a prop broke into gibs or went off */
  onBreak: (fn: (e: BreakEvent) => void) => () => void
  /** deal a blow (u/s of velocity change) to a breakable or an explosive */
  damage: (id: PropId, amount: number, from?: Vec3Like) => void
  /** break a breakable now; false when it does not break */
  shatter: (id: PropId) => boolean
  /** light an explosive's fuse */
  ignite: (id: PropId) => void
  /** the particles, for anything else that wants dust or sparks */
  readonly fx: Fx
  /** where the listener is (the camera) and which way is right, once a
      frame; impact sounds are placed and panned against it */
  ear: (x: number, y: number, z: number, rightX?: number, rightZ?: number) => void

  /* the console's knobs */
  gravity: number
  timescale: number

  /** the raw world, for systems that need more than the verbs (joints) */
  /** a fingerprint of the whole simulation (every prop's pose and velocity,
      to the bit, and the simulated clock): equal inputs give equal hashes,
      which is what a replay or a desync check compares. '' before Rapier */
  stateHash: () => string
  /** the simulation's own random numbers, 0..1: seeded per sandbox and
      drawn only by the simulation (a gib's kick, a fuse's length, where a
      blast lands on a crate), so a replay draws the same ones. Anything
      that is only drawn or heard (sparks, a clatter's pitch) keeps
      Math.random and stays out of the hash */
  random: () => number

  readonly rapier: Rapier | null
  readonly physics: PhysicsWorld | null
  readonly stats: {
    props: number
    awake: number
    chunks: number
    solids: number
    vehicles: number
    time: number
    gibs: number
    burning: number
    particles: number
    /** instanced draws the props took last frame, and how many instances */
    batches: number
    instances: number
  }
  dispose: () => void
}

interface Live {
  pw: PhysicsWorld
  ground: Ground
  props: Props
  walker: Walker | null
}

export function createSandbox(opts: SandboxOpts): Sandbox {
  const root = new THREE.Group()
  root.name = 'sandbox'
  if (opts.parent) opts.parent.add(root)

  // the one material, on a shape far below anything, never drawn but always
  // visible to compileAsync (see the header)
  const warm = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), propMaterial())
  warm.position.set(0, -1e4, 0)
  warm.castShadow = true
  warm.receiveShadow = true
  warm.frustumCulled = true
  if (opts.parent) root.add(warm)
  // ...and the instanced variant, which the props and the particles draw
  // with, drawn (as nothing) in every pass so shadows link it too
  const warmI = warmBatch()
  if (opts.parent) root.add(warmI)
  const batcher: Batcher | null = opts.parent ? createBatcher(root) : null
  const surface = opts.ground ?? TERRAIN_GROUND
  const terrainY = surface.heightAt
  const effects: Fx = createFx({ parent: opts.parent ? root : null, groundY: terrainY })

  // the waterline cue: foam collars and splashes, drawn only with a parent
  const wake = createWake(opts.parent ? root : null)
  const waterY = opts.waterY ?? (() => -1e6)
  const surfaceAt = (x: number, z: number) => waterY() + (opts.waveAt ? opts.waveAt(x, z) : 0)

  let live: Live | null = null
  let lastWorldSplash = -1
  // mulberry32: small, fast, and the same sequence in Node and a browser
  let seed = 0x5eed1
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  let disposed = false
  let gravity = -34
  let timescale = 1
  let reservedId = 1
  const queued: Array<(l: Live) => void> = []
  const beforeFns = new Set<(h: number) => void>()
  const afterFns = new Set<(h: number) => void>()
  // the facade owns the listener sets, so a subscription made before Rapier
  // landed is as good as one made after; the props module gets one forwarder
  const listeners = {
    impact: new Set<(e: ImpactEvent) => void>(),
    splash: new Set<(e: SplashEvent) => void>(),
    spawn: new Set<(p: Prop) => void>(),
    remove: new Set<(p: Prop) => void>(),
  }

  const whenReady = loadRapier().then((R) => {
    if (disposed) return
    const pw = createPhysicsWorld(R)
    pw.gravity = gravity
    pw.timescale = timescale
    const ground = createGround({ pw, collision: opts.collision, chunkSolids: opts.chunkSolids, surface })
    const props = createProps({
      pw,
      ground,
      root: opts.parent ? root : null,
      waterY,
      waveAt: opts.waveAt,
      groundAt: terrainY,
    })
    const walker = opts.walker === false ? null : createWalker(pw, props)
    if (walker) {
      opts.collision.dynamic = walker.provider
      props.isPlayer = walker.isPlayer
    }
    live = { pw, ground, props, walker }
    props.onImpact((e) => {
      for (const fn of listeners.impact) fn(e)
    })
    props.onSplash((e) => {
      wake.splash(e.x, e.y, e.z, e.speed, Math.max(e.prop.extents.x, e.prop.extents.z), pw.time)
      // the world's ripple rings are a ring buffer of eight shared with the
      // player's own wading, and ten props landing at once drew one white
      // whorl over the whole bay: one every quarter second is plenty
      if (opts.splash && pw.time - lastWorldSplash > 0.25) {
        lastWorldSplash = pw.time
        opts.splash(e.x, e.z)
      }
      for (const fn of listeners.splash) fn(e)
    })
    props.onSpawn((p) => {
      for (const fn of listeners.spawn) fn(p)
    })
    props.onRemove((p) => {
      for (const fn of listeners.remove) fn(p)
    })
    for (const op of queued) op(live)
    queued.length = 0
  })

  const frameOut: SandboxFrame = { steps: 0, awake: 0, moving: 0, ms: 0 }
  const focusAt = new THREE.Vector3()
  const SHADOW_RANGE2 = 90 * 90

  const tick = (t: SandboxTick): SandboxFrame => {
    frameOut.steps = 0
    frameOut.moving = 0
    const l = live
    if (!l) return frameOut
    const t0 = performance.now()
    const w = t.walker ?? null
    const fx = w ? w.eye.x : (t.focus?.x ?? 0)
    const fz = w ? w.eye.z : (t.focus?.z ?? 0)
    focusAt.set(fx, w ? w.eye.y : (t.focus?.y ?? 0), fz)
    // the ground under the focus (so a spawn at arm's length has a floor) and
    // under every prop, parking and streaming: at the head of every slice,
    // not of every frame, because which colliders exist and the order they
    // were made in is simulation state, and streamed per frame it made the
    // same breakage come out differently at 144 Hz than at 60. Once more up
    // front for a frame that takes no slice (a paused world still wants the
    // floor under a spawn); with nothing moved in between, the slice's own
    // pass then finds nothing new to make
    const cx = chunkX(fx)
    const cz = chunkZ(fz)
    const stream = (tick = true) => {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) l.ground.need(cx + dx, cz + dz)
      l.props.frame(fx, fz)
      l.ground.stream(tick)
    }
    stream(false)
    l.ground.vehicles()
    l.walker?.frame(t.active ? w : null, t.dt)
    if (t.active) {
      frameOut.steps = l.pw.advance(
        t.dt,
        (h, k, n) => {
          stream()
          l.props.beforeSlice(h)
          l.walker?.beforeSlice(k, n)
          l.ground.slice(k, n)
          for (const fn of beforeFns) fn(h)
        },
        (h) => {
          l.props.afterSlice(h)
          life.step(h)
          effects.step(h)
          for (const fn of afterFns) fn(h)
        },
      )
      l.props.draw(l.pw.alpha)
      // the render stands between the last two slices, and so does the foam
      wake.draw(l.pw.time - STEP * (1 - l.pw.alpha), l.props.forEach, surfaceAt)
      l.walker?.carry(w)
    }
    batcher?.sync()
    setEarFallback(focusAt.x, focusAt.y, focusAt.z)
    frameOut.awake = l.props.awake
    if (frameOut.awake) {
      l.props.forEach((p) => {
        if (p.parked || p.mode !== 'dynamic' || p.body.isSleeping()) return
        const t2 = p.body.translation()
        if ((t2.x - fx) ** 2 + (t2.z - fz) ** 2 < SHADOW_RANGE2) frameOut.moving++
      })
    }
    frameOut.ms = performance.now() - t0
    return frameOut
  }

  const run = (op: (l: Live) => void) => {
    if (live) op(live)
    else queued.push(op)
  }
  const tmpDir = new THREE.Vector3()
  // filled in once the facade exists: both subscribe through it
  let life: PropLife = null as unknown as PropLife
  let explosions: Explosions = null as unknown as Explosions

  const sb: Sandbox = {
    get ready() {
      return live !== null
    },
    whenReady,
    root,
    warm,
    tick,
    spawn: (kind, at, o = {}) => {
      if (live) return live.props.spawn(kind, at, o)
      const id = o.id ?? reservedId++
      if (id >= reservedId) reservedId = id + 1
      const pos = { x: at.x, y: at.y, z: at.z }
      queued.push((l) => void l.props.spawn(kind, pos, { ...o, id }))
      return id
    },
    remove: (id) => (live ? live.props.remove(id) : false),
    clear: () => run((l) => l.props.clear()),
    get: (id) => live?.props.get(id),
    forEach: (fn) => live?.props.forEach(fn),
    get count() {
      return live ? live.props.count : queued.length
    },
    getTransform: (id, pos, quat) => (live ? live.props.getTransform(id, pos, quat) : false),
    setTransform: (id, pos, quat) => run((l) => l.props.setTransform(id, pos, quat)),
    getVelocity: (id, lin, ang) => (live ? live.props.getVelocity(id, lin, ang) : false),
    setVelocity: (id, lin, ang) => run((l) => l.props.setVelocity(id, lin, ang)),
    applyImpulse: (id, imp, at) => run((l) => l.props.applyImpulse(id, imp, at)),
    addForce: (id, f, at) => live?.props.addForce(id, f, at),
    freeze: (id) => run((l) => l.props.setMode(id, 'frozen')),
    unfreeze: (id) => run((l) => l.props.setMode(id, 'dynamic')),
    setMode: (id, mode) => run((l) => l.props.setMode(id, mode)),
    moveKinematic: (id, pos, quat) => live?.props.moveKinematic(id, pos, quat),
    wake: (id) => live?.props.wake(id),
    inContact: (id) => live?.props.inContact(id) ?? false,
    onImpact: (fn) => {
      listeners.impact.add(fn)
      return () => listeners.impact.delete(fn)
    },
    onSplash: (fn) => {
      listeners.splash.add(fn)
      return () => listeners.splash.delete(fn)
    },
    onSpawn: (fn) => {
      listeners.spawn.add(fn)
      return () => listeners.spawn.delete(fn)
    },
    onRemove: (fn) => {
      listeners.remove.add(fn)
      return () => listeners.remove.delete(fn)
    },
    onBeforeSlice: (fn) => {
      beforeFns.add(fn)
      return () => beforeFns.delete(fn)
    },
    onAfterSlice: (fn) => {
      afterFns.add(fn)
      return () => afterFns.delete(fn)
    },
    raycast: (origin, dir, maxDist, o = {}) => {
      const l = live
      if (!l) return null
      const { R, world } = l.pw
      tmpDir.set(dir.x, dir.y, dir.z).normalize()
      const want = (o.props ?? true ? 2 : 0) | (o.world ?? true ? 1 : 0)
      if (!want) return null
      const hit = world.castRayAndGetNormal(
        new R.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: tmpDir.x, y: tmpDir.y, z: tmpDir.z }),
        maxDist, true, undefined, ((0xffff << 16) | want) >>> 0,
      )
      if (!hit) return null
      const c = hit.collider as RCollider
      return {
        distance: hit.timeOfImpact,
        point: new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(tmpDir, hit.timeOfImpact),
        normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
        prop: l.props.ofCollider(c) ?? null,
        solid: l.ground.solidOf(c) ?? null,
        ground: l.ground.isGround(c),
      }
    },
    propOf: (c) => (live ? live.props.ofCollider(c as RCollider) ?? null : null),
    get standing() {
      return live?.walker?.standing ?? null
    },
    queryBall: (center, r, fn) => {
      const l = live
      if (!l) return
      const seen = new Set<PropId>()
      const found: Prop[] = []
      l.pw.world.intersectionsWithShape(center, { x: 0, y: 0, z: 0, w: 1 }, new l.pw.R.Ball(r), (c) => {
        const p = l.props.ofCollider(c)
        if (p && !seen.has(p.id)) {
          seen.add(p.id)
          found.push(p)
        }
        return true
      }, undefined, GROUPS.queryProps)
      // handed out after the query, never from inside it: the query holds
      // Rapier's world borrowed, so a callback that wakes or pushes a body
      // throws across the WASM boundary, the error is lost, and the world is
      // left borrowed (an explosion threw nothing and the next dispose died)
      for (const p of found) fn(p)
    },
    groundY: terrainY,
    solidsChanged: () => live?.ground.markDirty(),
    restY: (kind, x, z) => {
      const k = KINDS[kind]
      if (!k) return terrainY(x, z)
      const e = shapeExtents(k.shape)
      // the lowest point of an upright shape under its origin, sampled at the
      // footprint's corners so a crate on a slope does not start buried
      let g = -Infinity
      for (const [ox, oz] of [[0, 0], [e.x, e.z], [-e.x, e.z], [e.x, -e.z], [-e.x, -e.z]]) {
        g = Math.max(g, terrainY(x + ox, z + oz))
      }
      return g + e.y + 0.02
    },
    focus: focusAt,
    get gravity() {
      return gravity
    },
    set gravity(g: number) {
      gravity = g
      if (live) live.pw.gravity = g
    },
    get timescale() {
      return timescale
    },
    set timescale(k: number) {
      timescale = Math.max(0, Math.min(4, k))
      if (live) live.pw.timescale = timescale
    },
    random,
    stateHash: () => (live ? `${live.props.stateHash()}@${live.pw.time.toFixed(4)}` : ''),
    explode: (at, power = 1, radius = 16) => explosions.explode(at, power, radius, null),
    onExplosion: (fn) => explosions.onExplosion(fn),
    onBreak: (fn) => life.onBreak(fn),
    damage: (id, amount, from) => life.damage(id, amount, from),
    shatter: (id) => life.shatter(id),
    ignite: (id) => life.ignite(id),
    fx: effects,
    ear: (x, y, z, rx = 0, rz = 0) => setEar(x, y, z, rx, rz),
    get rapier() {
      return live?.pw.R ?? null
    },
    get physics() {
      return live?.pw ?? null
    },
    get stats() {
      const l = live
      return {
        props: l?.props.count ?? 0,
        awake: l?.props.awake ?? 0,
        chunks: l?.ground.stats.chunks ?? 0,
        solids: l?.ground.stats.solids ?? 0,
        vehicles: l?.ground.stats.vehicles ?? 0,
        time: l?.pw.time ?? 0,
        gibs: life.gibs,
        burning: life.burning,
        particles: effects.live,
        batches: batcher?.stats.batches ?? 0,
        instances: batcher?.stats.instances ?? 0,
      }
    },
    dispose: () => {
      disposed = true
      if (opts.collision.dynamic && live?.walker && opts.collision.dynamic === live.walker.provider) {
        opts.collision.dynamic = undefined
      }
      root.removeFromParent()
      warm.geometry.dispose()
      wake.dispose()
      warmI.geometry.dispose()
      warmI.dispose()
      batcher?.dispose()
      effects.dispose()
      if (live) {
        live.props.clear()
        live.ground.dispose()
        live.pw.dispose()
        live = null
      }
    },
  }
  life = createLife(sb, effects, (at, power, radius, source) => void explosions.explode(at, power, radius, source))
  explosions = createExplosions(sb, effects, life.damage)
  return sb
}

export type { Rapier }
