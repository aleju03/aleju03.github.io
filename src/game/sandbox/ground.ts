import type RAPIER_NS from '@dimforge/rapier3d-compat'
import type { CollisionSet, Hull, Solid } from '../physics/collision'
import { CHUNK, GRID, originX, originZ } from '../world/grid'
import { latticeHeight } from '../world/terrain'
import { GROUPS, type PhysicsWorld, type RBody, type RCollider } from './physics'

/*
  Everything a prop can hit that is not another prop: the ground, the world's
  solids and the fleet, mirrored into Rapier from the structures the walk
  already uses, and only where something could touch them.

  The ground is one heightfield per 64-unit chunk, built from the very
  lattice the terrain mesh and `terrainY()` read (`latticeHeight`), so a crate
  rests on the drawn triangle rather than on the smooth field it approximates,
  which is the same "mesh and collision must agree" rule the walk lives by.
  One wrinkle, found by probing a one-cell heightfield: Rapier cuts every cell
  along the diagonal from (x0, z1) to (x1, z0), and the terrain mesh cuts from
  (x0, z0) to (x1, z1). Mirroring is not a rotation, but a quarter turn about
  y maps one diagonal onto the other, so each chunk's heightfield is laid out
  rotated 90 degrees with its rows along world x and its columns running down
  world z. `npm run measure -- physics` raycasts it against `terrainY` at
  random points to hold that honest.

  The solids come from the walk's own CollisionSet (the house, its furniture,
  and the nine chunks around the player, which the streamer keeps topped up)
  plus, through `chunkSolids`, the boxes of any further chunk a prop has
  wandered into. Each box becomes one fixed cuboid, tracked by identity, and
  its extent is re-read every frame, because the set's owners change boxes in
  place: an open door collapses its blocker to a point (the cuboid is
  disabled), a felled tree empties its box (likewise), a closed door puts it
  back. `noStand` is irrelevant here: that flag is about where a *player* may
  stand, and a crate may land on a wall top.

  Streaming follows the streamer's collision-shelf idea with one more reason
  to keep a chunk: the ring is the chunks around the player *plus* the chunks
  under every prop that is not parked. A chunk nobody has needed for a few
  seconds is dropped. A heightfield is 289 cached lattice lookups and one
  collider, so a missing one is built on the spot when a prop needs it rather
  than queued: a queued floor is a floor something falls through.

  The fleet is mirrored as kinematic bodies: each vehicle's `hull` (the
  oriented profile the walker collides with) becomes a convex hull of its
  stations, driven to the hull's pose every slice. Kinematic means infinite
  mass, so a car shoves a crate aside and a heavy block alike; the car's own
  dynamics never hear about it.
*/

const N = CHUNK / GRID

export interface GroundOpts {
  pw: PhysicsWorld
  collision: CollisionSet
  /** the solids of any loaded chunk, for props outside the walk's nine */
  chunkSolids?: (cx: number, cz: number) => readonly Solid[] | null | undefined
}

export interface Ground {
  /** keep chunk (cx, cz)'s ground and solids alive this frame, building them
      now if they are missing. Returns false only if it could not */
  need: (cx: number, cz: number) => boolean
  /** has this chunk got its ground */
  has: (cx: number, cz: number) => boolean
  /** retire what nobody needed and re-read the solids. Once a *slice*, not
      a frame: which colliders exist, and in what order they were made,
      is part of the simulation's state, and a frame-paced stream made two
      runs of the same breakage differ with the frame rate. `tick` false
      builds what is missing without counting a slice (nothing retires):
      the sandbox's pass for a frame that takes no slice */
  stream: (tick?: boolean) => void
  /** aim the fleet's mirrors for this frame's slices; once a frame */
  vehicles: () => void
  /** both, for a caller that has no slices to hand */
  sync: () => void
  /** the world's solids changed in number (a building taken apart into
      pieces): gather them again on the next sync rather than within the
      minute-long fallback */
  markDirty: () => void
  /** move the fleet's mirrors toward their hulls: slice k of n this frame */
  slice: (k: number, n: number) => void
  /** the world solid behind a collider, if it is one */
  solidOf: (c: RCollider) => Solid | undefined
  isGround: (c: RCollider) => boolean
  isVehicle: (c: RCollider) => boolean
  readonly stats: { chunks: number; solids: number; vehicles: number }
  dispose: () => void
}

const key = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768)
/** slices a chunk survives without being asked for (four seconds) */
const KEEP_FRAMES = 240
/** past this many solids per stream, the rest wait for the next slice */
const SOLIDS_PER_FRAME = 700

export const createGround = ({ pw, collision, chunkSolids }: GroundOpts): Ground => {
  const { R, world } = pw
  const chunks = new Map<number, { cx: number; cz: number; col: RCollider; seen: number }>()
  const groundHandles = new Set<number>()
  let frame = 0

  // a quarter turn about y: see the header
  const QUARTER = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
  const heights = new Float32Array((N + 1) * (N + 1))

  const buildChunk = (cx: number, cz: number) => {
    const i0 = cx * N
    const j0 = cz * N
    for (let c = 0; c <= N; c++)
      for (let r = 0; r <= N; r++) heights[c * (N + 1) + r] = latticeHeight(i0 + r, j0 + (N - c))
    const desc = R.ColliderDesc.heightfield(
      N, N, heights, { x: CHUNK, y: 1, z: CHUNK }, R.HeightFieldFlags.FIX_INTERNAL_EDGES,
    )
      .setTranslation(originX(cx) + CHUNK / 2, 0, originZ(cz) + CHUNK / 2)
      .setRotation(QUARTER)
      .setCollisionGroups(GROUPS.world)
      .setFriction(0.8)
      .setRestitution(0.05)
    const col = world.createCollider(desc)
    groundHandles.add(col.handle)
    return col
  }

  const need = (cx: number, cz: number) => {
    const k = key(cx, cz)
    const have = chunks.get(k)
    if (have) {
      have.seen = frame
      return true
    }
    chunks.set(k, { cx, cz, col: buildChunk(cx, cz), seen: frame })
    solidsDirty = true
    return true
  }

  /* ---------------------------------------------------------- solids -- */

  interface Mirror {
    col: RCollider
    minX: number
    minY: number
    minZ: number
    maxX: number
    maxY: number
    maxZ: number
    on: boolean
  }
  const mirrors = new Map<Solid, Mirror>()
  const byHandle = new Map<number, Solid>()
  let solidsDirty = true
  let lastLen = -1
  let lastSweep = -1
  const wanted = new Set<Solid>()

  const chunkOfPoint = (x: number, z: number) =>
    key(Math.floor((x - originX(0)) / CHUNK), Math.floor((z - originZ(0)) / CHUNK))

  const live = (b: Solid) =>
    b.max.x > b.min.x && b.max.y > b.min.y && b.max.z > b.min.z

  const place = (m: Mirror, b: Solid) => {
    m.minX = b.min.x
    m.minY = b.min.y
    m.minZ = b.min.z
    m.maxX = b.max.x
    m.maxY = b.max.y
    m.maxZ = b.max.z
    const on = live(b)
    if (on) {
      m.col.setHalfExtents({
        x: (b.max.x - b.min.x) / 2,
        y: (b.max.y - b.min.y) / 2,
        z: (b.max.z - b.min.z) / 2,
      })
      m.col.setTranslation({
        x: (b.max.x + b.min.x) / 2,
        y: (b.max.y + b.min.y) / 2,
        z: (b.max.z + b.min.z) / 2,
      })
    }
    if (on !== m.on) {
      m.col.setEnabled(on)
      m.on = on
    }
  }

  const probe = new R.Cuboid(0.5, 0.5, 0.5)
  const NO_ROT = { x: 0, y: 0, z: 0, w: 1 }
  const wakeAround = (m: Mirror) => {
    if (!m.on) return
    probe.halfExtents = {
      x: (m.maxX - m.minX) / 2 + 0.5,
      y: (m.maxY - m.minY) / 2 + 0.5,
      z: (m.maxZ - m.minZ) / 2 + 0.5,
    }
    world.intersectionsWithShape(
      { x: (m.maxX + m.minX) / 2, y: (m.maxY + m.minY) / 2, z: (m.maxZ + m.minZ) / 2 },
      NO_ROT, probe,
      (c) => {
        const b = c.parent()
        if (b) toWake.push(b)
        return true
      },
      undefined, GROUPS.queryProps,
    )
    // woken after the query, never inside it: the query holds the world
    // borrowed, and a body touched from its callback leaves it borrowed for
    // good (the next dispose dies). Destruction empties boxes by the dozen
    for (const b of toWake) b.wakeUp()
    toWake.length = 0
  }
  const toWake: RBody[] = []

  const addMirror = (b: Solid) => {
    const col = world.createCollider(
      R.ColliderDesc.cuboid(0.5, 0.5, 0.5).setCollisionGroups(GROUPS.world).setFriction(0.7),
    )
    const m: Mirror = { col, minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, on: true }
    place(m, b)
    mirrors.set(b, m)
    byHandle.set(col.handle, b)
  }

  const collectWanted = () => {
    wanted.clear()
    for (const b of collision.boxes) {
      if (b.hull) continue
      if (chunks.has(chunkOfPoint((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2))) wanted.add(b)
    }
    if (chunkSolids) {
      for (const c of chunks.values()) {
        const list = chunkSolids(c.cx, c.cz)
        if (list) for (const b of list) wanted.add(b)
      }
    }
  }

  const syncSolids = () => {
    if (collision.boxes.length !== lastLen) {
      lastLen = collision.boxes.length
      solidsDirty = true
    }
    if (frame % 60 === 0 && frame !== lastSweep) {
      lastSweep = frame
      solidsDirty = true
    }
    if (solidsDirty) {
      solidsDirty = false
      collectWanted()
      for (const [b, m] of mirrors) {
        if (wanted.has(b)) continue
        byHandle.delete(m.col.handle)
        world.removeCollider(m.col, false)
        mirrors.delete(b)
      }
      let made = 0
      for (const b of wanted) {
        if (mirrors.has(b)) continue
        if (made++ >= SOLIDS_PER_FRAME) {
          solidsDirty = true // the rest next frame
          break
        }
        addMirror(b)
      }
    }
    // in-place edits: doors, debris. Six compares a box
    for (const [b, m] of mirrors) {
      if (
        b.min.x !== m.minX || b.min.y !== m.minY || b.min.z !== m.minZ ||
        b.max.x !== m.maxX || b.max.y !== m.maxY || b.max.z !== m.maxZ
      ) {
        // a box that shrank can leave a sleeping pile hanging in the air, so
        // wake whatever sits on or against where it was
        wakeAround(m)
        place(m, b)
      }
    }
  }

  /* --------------------------------------------------------- vehicles -- */

  interface Rig {
    body: RBody
    hull: Hull
    box: Solid
    // pose at the start of this frame's slices, and where they end
    fx: number
    fy: number
    fz: number
    fyaw: number
    tx: number
    ty: number
    tz: number
    tyaw: number
    on: boolean
  }
  const rigs = new Map<Hull, Rig>()
  const vehicleHandles = new Set<number>()

  const buildRig = (box: Solid, h: Hull): Rig => {
    const drop = h.y - box.min.y
    const pts: number[] = []
    for (const s of h.st) {
      for (const x of [-s.hw, s.hw]) {
        pts.push(x, Math.max(0.2, s.top), s.z)
        pts.push(x, -drop, s.z)
      }
    }
    const yaw = Math.atan2(h.sin, h.cos)
    const body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(h.x, h.y, h.z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
    )
    const desc = R.ColliderDesc.convexHull(new Float32Array(pts))
    if (desc) {
      const col = world.createCollider(
        desc.setCollisionGroups(GROUPS.vehicle).setFriction(0.6),
        body,
      )
      vehicleHandles.add(col.handle)
    }
    return {
      body, hull: h, box,
      fx: h.x, fy: h.y, fz: h.z, fyaw: yaw, tx: h.x, ty: h.y, tz: h.z, tyaw: yaw, on: true,
    }
  }

  const syncVehicles = () => {
    for (const b of collision.boxes) {
      if (!b.hull) continue
      let rig = rigs.get(b.hull)
      if (!rig) {
        rig = buildRig(b, b.hull)
        rigs.set(b.hull, rig)
      }
      const h = b.hull
      const t = rig.body.translation()
      const yaw = Math.atan2(h.sin, h.cos)
      rig.fx = t.x
      rig.fy = t.y
      rig.fz = t.z
      rig.fyaw = rig.tyaw
      rig.tx = h.x
      rig.ty = h.y
      rig.tz = h.z
      rig.tyaw = yaw
      // a recall or a respawn is a teleport, not a very fast drive: arriving
      // at 300 u/s would launch everything it lands on
      if (Math.hypot(h.x - t.x, h.y - t.y, h.z - t.z) > 12) {
        rig.body.setTranslation({ x: h.x, y: h.y, z: h.z }, false)
        rig.fx = h.x
        rig.fy = h.y
        rig.fz = h.z
        rig.fyaw = yaw
      }
      const on = live(b)
      if (on !== rig.on) {
        rig.body.setEnabled(on)
        rig.on = on
      }
    }
  }

  const slice = (k: number, n: number) => {
    const f = (k + 1) / n
    for (const rig of rigs.values()) {
      if (!rig.on) continue
      let dy = rig.tyaw - rig.fyaw
      if (dy > Math.PI) dy -= 2 * Math.PI
      if (dy < -Math.PI) dy += 2 * Math.PI
      const yaw = rig.fyaw + dy * f
      rig.body.setNextKinematicTranslation({
        x: rig.fx + (rig.tx - rig.fx) * f,
        y: rig.fy + (rig.ty - rig.fy) * f,
        z: rig.fz + (rig.tz - rig.fz) * f,
      })
      rig.body.setNextKinematicRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
    }
  }

  const stats = { chunks: 0, solids: 0, vehicles: 0 }

  const stream = (tick = true) => {
    if (tick) frame++
    if (tick) for (const [k, c] of chunks) {
      if (frame - c.seen <= KEEP_FRAMES) continue
      groundHandles.delete(c.col.handle)
      world.removeCollider(c.col, true)
      chunks.delete(k)
      solidsDirty = true
    }
    syncSolids()
    stats.chunks = chunks.size
    stats.solids = mirrors.size
    stats.vehicles = rigs.size
  }

  return {
    need,
    has: (cx, cz) => chunks.has(key(cx, cz)),
    stream,
    vehicles: () => syncVehicles(),
    sync: () => {
      stream()
      syncVehicles()
    },
    slice,
    markDirty: () => {
      solidsDirty = true
    },
    solidOf: (c) => byHandle.get(c.handle),
    isGround: (c) => groundHandles.has(c.handle),
    isVehicle: (c) => vehicleHandles.has(c.handle),
    stats,
    dispose: () => {
      for (const c of chunks.values()) world.removeCollider(c.col, false)
      for (const m of mirrors.values()) world.removeCollider(m.col, false)
      for (const r of rigs.values()) world.removeRigidBody(r.body)
      chunks.clear()
      mirrors.clear()
      rigs.clear()
    },
  }
}

export type { RAPIER_NS }
