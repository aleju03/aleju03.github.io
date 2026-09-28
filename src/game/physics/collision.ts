import * as THREE from 'three'

/*
  Walk-mode collision. Every solid is an axis-aligned Box3, and the model
  stays deliberately small: a box only argues with the player where their
  body and the box actually overlap in y. That one rule buys verticality —
  a solid low enough to step onto is a floor rather than a wall, supportY()
  reports the highest such top under an (x, z), and a hop therefore lands on
  the couch instead of bouncing off its side. Where a box does block, the
  player is pushed out along whichever face is closest, which is what makes
  sliding along walls feel right. Each level owns one CollisionSet; the level
  system decides which set is live. Solids must register a box or the player
  walks through them — the backrooms entrance works by deliberately not
  registering one.

  The one piece of metadata a box carries is `noStand`: an AABB is a coarse
  stand-in, and for walls, fence rails, lamp poles, tree canopies and house
  eaves its top is thin air rather than a surface. Without that bit the
  furniture the player is meant to climb doubles as a ladder onto the tops
  of the walls, so anything whose box is taller than the thing it wraps says
  so at registration.

  A box may also be `through` for a frame: a portal is open in it where the
  walker stands (sandbox/tools/portals.ts), and all three questions below
  skip it until the body has gone through or stepped away.

  The other is `hull`, and it exists because one class of solid moves: a
  vehicle. Everything the world builds is axis-aligned by construction, so an
  AABB costs it nothing — but a 9.4-unit car parked at forty-five degrees has
  an AABB half as wide again as the car is long, and the player meets that
  box two units off the paint. A hull replaces the box's own extent with an
  oriented, z-varying profile in the machine's frame: stations fore to aft,
  each carrying the half-width and the surface height there, read off the same
  section tables the bodywork is lofted from. The box stays as the broad
  phase — it is the hull's own bounds, so nothing that misses the box can hit
  the hull, and every solid without one pays exactly what it paid before.

  The third is `ramp`, the static cousin of a hull: one slope of a pitched
  roof, a box whose top rises linearly across one axis. Roofs used to be
  noStand boxes to the ridge, which was fine until flight made them somewhere
  to land, and a roof you could not stand on pushed a landing body out of its
  nearest wall. The three questions here read the slope (and treat one a
  hand over the feet as underfoot, so a hop up the roof lands instead of
  being thrown off the eaves); everything else that scans boxes sees the
  wedge's bounding box. kitbash.ts's `roofSolids` registers them for the
  town and the landmarks, houseWorld for the house. And `surfaceAbove` is
  the question the walk asks once, when a flight ends: feet let go inside a
  building come out on its top rather than out through a wall.

  Padding is x/z only (padXZ, and addBoxFrom on top of it). The pad exists so
  shoulders don't clip a wall; inflating it upward would leave the player
  standing a hand's width above every surface they climb onto, and downward
  would sink a box's underside below the floor it rests on.

  Large sets use a spatial grid for these point queries. The scene calls
  syncCollisionSet before simulation and after level.update to reconcile the
  plain, shared box array (including same-length replacement). Doors declare
  `moving`, and hulls are always live: their bounds can change between two
  queries in the same physics tick. Static boxes are checked once at that
  boundary rather than by every foot, camera and body query. Small sets and
  callers that never opt in with syncCollisionSet retain the linear scan.

  Candidate indices retain the array's order. A push across a cell boundary
  fetches that cell's remaining candidates, so a chain of overlapping walls
  resolves exactly as it did in the original scan, even across several cells.

*/

/** hard outer clamp, pre-shrunk by whatever shoulder margin the level wants */
export interface WorldBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** a solid that a hard enough impact carries out of the world rather than
    stopping against: a sapling, a cactus, a lamp post. The world registers
    these (world/debris.ts arms them); a vehicle's sweep asks. Everything
    without one is immovable, which is every solid this repo had before. */
export interface Breakable {
  /** closing speed, units/s, under which it simply holds. It doubles as how
      much it *costs* to break — see the caller in vehicles/car.ts, where a
      prop takes `limit * 0.6` units of speed off whatever broke it, so one
      number covers both "can I" and "what did that cost me" */
  limit: number
  /** it gave: the contact point, the direction the hitter was travelling
      (unit, xz) and its speed. Called once — the owner empties its own box
      inside this, so the next tick sweeps straight through where it stood */
  hit: (x: number, y: number, z: number, dx: number, dz: number, speed: number) => void
}

/** a collision box that may also declare its top off-limits. An AABB is a
    coarse stand-in for the thing it wraps, and for plenty of solids the top
    of that box is nowhere a body could stand: the ceiling plane over a
    paper-thin wall, the lampshade of a floor lamp, mid-canopy on a tree, the
    eave line of a house with a roof above it. Marking those keeps the world
    honest without asking every builder for real geometry. */
export interface Solid extends THREE.Box3 {
  noStand?: boolean
  /** a portal is open in it where the walker stands this frame
      (sandbox/tools/portals.ts): it is no wall and no floor until the body
      has gone through or stepped away */
  through?: boolean
  hull?: Hull
  /** bounds may change between queries; doors and other non-hull movers */
  moving?: boolean
  breaks?: Breakable
  ramp?: Ramp
  /** the walk's alone: the sandbox's physics has a shape of its own for
      what this box stands in for (Cubeland's blocks are Rapier voxels, flush
      and without the shoulder this box is padded by), so sandbox/ground.ts
      does not mirror it */
  walkOnly?: boolean
}

/** a top that is not level: one slope of a pitched roof. Across the box
    along `axis` it rises linearly from `lo` at the min edge to `hi` at the
    max edge, and is level the other way; the box's own max.y is the higher
    of the two, so it stays an honest broad phase. Only the three questions
    here read the slope (and the ragdoll, through `topAt`); anything else
    that scans boxes sees the wedge's bounding box, which over-reports and
    never misses. See `rampTop` for who registers them */
export interface Ramp {
  axis: 'x' | 'z'
  lo: number
  hi: number
}

/** how far over the feet a roof slope still counts as underfoot rather than
    as a wall (see resolveXZ) */
const RAMP_REACH = 0.5

/** the height of a box's top over (x, z): its max.y, or its slope's height
    there for a ramp. Hulls are not asked here (see hullTopAt) */
export const topAt = (b: Solid, x: number, z: number) => {
  const r = b.ramp
  if (!r) return b.max.y
  const t = r.axis === 'x'
    ? (x - b.min.x) / Math.max(1e-6, b.max.x - b.min.x)
    : (z - b.min.z) / Math.max(1e-6, b.max.z - b.min.z)
  return r.lo + (r.hi - r.lo) * Math.min(1, Math.max(0, t))
}

/** one control station of a hull profile: at this local z the footprint
    reaches `hw` either side of the centreline, and whatever surface is there
    stands `top` above the hull's own origin. Stations blend linearly, so the
    shape between two of them is a trapezoid — which is why a table lifted
    straight off a loft's own cross-sections describes the body it came from */
export interface HullStation {
  z: number
  hw: number
  top: number
}

/** an oriented footprint hung on a Solid. The stations are in the body's
    frame (z fore-to-aft, +y up from the origin) and the transform is written
    fresh every time the body moves; yaw arrives pre-resolved into sin/cos
    because this is read three or four times a frame and computed once. The
    convention matches the vehicles': yaw 0 faces -Z, and a local (lx, lz)
    lands at (x + lx·cos + lz·sin, z - lx·sin + lz·cos). */
export interface Hull {
  /** world position of the local origin */
  x: number
  y: number
  z: number
  sin: number
  cos: number
  /** at least two stations, sorted by z */
  st: HullStation[]
}

/** wrap a body's own profile into a hull, grown by the shoulder margin every
    other solid gets at registration: wider everywhere, and capped square a pad
    beyond each end. Squaring the ends rounds the two extreme corners outward
    by that pad, which is a tenth of a unit spent to keep a profile a plain
    list of stations. Pay it once here rather than per frame in the fit. */
export const makeHull = (st: HullStation[], pad = 0): Hull => {
  const out = st.map((s) => ({ z: s.z, hw: s.hw + pad, top: s.top }))
  const head = out[0]
  const tail = out[out.length - 1]
  if (pad > 0) {
    out.unshift({ z: head.z - pad, hw: head.hw, top: head.top })
    out.push({ z: tail.z + pad, hw: tail.hw, top: tail.top })
  }
  return { x: 0, y: 0, z: 0, sin: 0, cos: 1, st: out }
}

/** point a hull at where its body now is, and re-fit the box that fronts it.
    The bounds are the transformed station corners and nothing else: the
    profile between two stations is a trapezoid, so those corners bound it
    exactly, and a box that is exactly the hull's extent can never reject a
    point the hull would have caught. `drop` is how far below the origin the
    box reaches — the body's own underside. */
export const fitHull = (
  h: Hull,
  box: Solid,
  x: number,
  y: number,
  z: number,
  yaw: number,
  drop: number,
) => {
  h.x = x
  h.y = y
  h.z = z
  h.cos = Math.cos(yaw)
  h.sin = Math.sin(yaw)
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let top = 0
  for (const s of h.st) {
    if (s.top > top) top = s.top
    for (let k = -1; k <= 1; k += 2) {
      const lx = k * s.hw
      const wx = lx * h.cos + s.z * h.sin
      const wz = -lx * h.sin + s.z * h.cos
      if (wx < minX) minX = wx
      if (wx > maxX) maxX = wx
      if (wz < minZ) minZ = wz
      if (wz > maxZ) maxZ = wz
    }
  }
  box.min.set(x + minX, y - drop, z + minZ)
  box.max.set(x + maxX, y + top, z + maxZ)
  box.hull = h
}

/** the profile at a local z: half-width, and the surface height above the
    hull origin. Half-width comes back 0 past either end, which reads as
    "outside" everywhere it is used */
const stationAt = (h: Hull, lz: number, out: { hw: number; top: number }) => {
  const st = h.st
  const n = st.length
  if (lz <= st[0].z || lz >= st[n - 1].z) {
    out.hw = 0
    out.top = 0
    return
  }
  let i = 1
  while (i < n - 1 && st[i].z < lz) i++
  const a = st[i - 1]
  const b = st[i]
  const k = (lz - a.z) / (b.z - a.z)
  out.hw = a.hw + (b.hw - a.hw) * k
  out.top = a.top + (b.top - a.top) * k
}

const prof = { hw: 0, top: 0 }

/** how high this hull's surface is under a world (x, z), or -Infinity where
    the point misses the profile entirely. The one question the three tests
    below all ask, because "outside the footprint" and "low enough to walk
    over" are the same answer to a walker */
const hullTopAt = (h: Hull, x: number, z: number) => {
  const dx = x - h.x
  const dz = z - h.z
  stationAt(h, dx * h.sin + dz * h.cos, prof)
  if (prof.hw <= 0) return -Infinity
  const lx = dx * h.cos - dz * h.sin
  if (lx <= -prof.hw || lx >= prof.hw) return -Infinity
  return h.y + prof.top
}

/** solids that are not boxes and do not hold still: the sandbox's rigid
    bodies (src/game/sandbox/). A set may carry one, and then the three
    questions below ask it too, after the boxes, so every caller of
    supportY/resolveXZ/blockedAt (the walk, the body's feet, the chase boom)
    meets the props without knowing they exist. The provider owns the exact
    shapes; this module only knows the three questions. */
export interface DynamicSolids {
  /** the highest standable surface under (x, z) at or below `reach` (the
      provider may allow a small mantle above it), or -Infinity */
  topAt: (x: number, z: number, reach: number) => number
  /** push a body's point out of anything overlapping its y-span above the
      step band, the same deal resolveXZ gives a box */
  pushOut: (p: THREE.Vector3, footY: number, headY: number, stepUp: number) => void
  /** would a body standing here be inside one */
  blocks: (x: number, z: number, footY: number, headY: number, stepUp: number) => boolean
}

export interface CollisionSet {
  boxes: Solid[]
  bounds: WorldBounds
  /** the moving solids, when a sandbox is attached to this set */
  dynamic?: DynamicSolids
}

export const makeCollisionSet = (bounds: WorldBounds, boxes: Solid[] = []): CollisionSet => ({
  boxes,
  bounds,
})

// A cell is about a room wide. Very large boxes stay in the live list to
// keep one level-wide slab from allocating thousands of buckets.
const CELL = 16
const INDEX_THRESHOLD = 96
const MAX_CELLS = 256
interface IndexedBox {
  box: Solid
  live: boolean
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}
interface CollisionIndex {
  boxes: Solid[]
  entries: IndexedBox[]
  cells: Map<number, Map<number, number[]>>
  boxCells: Map<number, Map<number, Solid[]>>
  liveBoxes: Solid[]
  live: number[]
  version: number
}
const indices = new WeakMap<CollisionSet, CollisionIndex>()
const versions = new WeakMap<Solid[], number>()

/** A stream/structure owner replaced solids mid-tick. Existing queries rebuild
    lazily before using that array again, even if its length stayed equal. */
export const invalidateCollisionBoxes = (boxes: Solid[]) => {
  versions.set(boxes, (versions.get(boxes) ?? 0) + 1)
}

const liveBox = (b: Solid) => !!(b.hull || b.moving)

/** Opt a set into the grid and reconcile direct array/bounds mutations.
    Call before simulation and after level.update. Movers need no resync:
    mark doors `moving`, and fitHull supplies the vehicle marker. Static
    edits made elsewhere must call this before their next collision query.
    Comparing identities as well as length catches a streamed ring replacing
    N boxes with N different boxes. Y/flags stay live in the narrow phase. */
export const syncCollisionSet = (set: CollisionSet) => {
  const boxes = set.boxes
  if (boxes.length < INDEX_THRESHOLD) {
    indices.delete(set)
    return
  }
  const old = indices.get(set)
  const version = versions.get(boxes) ?? 0
  if (old && old.boxes === boxes && old.entries.length === boxes.length && old.version === version) {
    let same = true
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]
      const e = old.entries[i]
      if (e.box !== b || e.live !== liveBox(b) || (!e.live && (
        e.minX !== b.min.x || e.maxX !== b.max.x ||
        e.minZ !== b.min.z || e.maxZ !== b.max.z
      ))) {
        same = false
        break
      }
    }
    if (same) return
  }
  const index: CollisionIndex = { boxes, entries: [], cells: new Map(), boxCells: new Map(), liveBoxes: [], live: [], version }
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    const live = liveBox(b)
    index.entries.push({ box: b, live, minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z })
    const x0 = Math.floor(b.min.x / CELL)
    const x1 = Math.floor(b.max.x / CELL)
    const z0 = Math.floor(b.min.z / CELL)
    const z1 = Math.floor(b.max.z / CELL)
    if (live || !Number.isFinite(x0 + x1 + z0 + z1) ||
      (x1 - x0 + 1) * (z1 - z0 + 1) > MAX_CELLS) {
      index.live.push(i)
      continue
    }
    for (let x = x0; x <= x1; x++) {
      let column = index.cells.get(x)
      if (!column) index.cells.set(x, column = new Map())
      for (let z = z0; z <= z1; z++) {
        let cell = column.get(z)
        if (!cell) column.set(z, cell = [])
        cell.push(i)
      }
    }
  }
  // Merge the short live tail once per cell, keeping the original order.
  // Queries then iterate ordinary arrays; mixing generator and array
  // iterators in the hot narrow-phase loop deoptimizes even small sets.
  if (index.live.length) for (const column of index.cells.values()) {
    for (const [z, cell] of column) {
      const merged: number[] = []
      let a = 0
      let b = 0
      while (a < cell.length || b < index.live.length) {
        merged.push(b >= index.live.length || (a < cell.length && cell[a] < index.live[b])
          ? cell[a++] : index.live[b++])
      }
      column.set(z, merged)
    }
  }
  index.liveBoxes = index.live.map(i => boxes[i])
  for (const [x, column] of index.cells) {
    const boxColumn = new Map<number, Solid[]>()
    for (const [z, cell] of column) boxColumn.set(z, cell.map(i => boxes[i]))
    index.boxCells.set(x, boxColumn)
  }
  indices.set(set, index)
}

/** The first unvisited candidate after changing cells during push-out. */
const afterIndex = (list: readonly number[], after: number) => {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] <= after) lo = mid + 1
    else hi = mid
  }
  return lo
}
/** Rebuild an opted-in set after a notified edit or changed array length. */
const collisionIndex = (set: CollisionSet) => {
  let index = indices.get(set)
  if (index && (index.boxes !== set.boxes || index.entries.length !== set.boxes.length ||
    index.version !== (versions.get(set.boxes) ?? 0))) {
    syncCollisionSet(set)
    index = indices.get(set)
  }
  return index
}
const cellAt = (index: CollisionIndex, cx: number, cz: number) =>
  index.cells.get(cx)?.get(cz) ?? index.live

const nearbyBoxes = (set: CollisionSet, x: number, z: number): Solid[] => {
  const index = collisionIndex(set)
  return index ? index.boxCells.get(Math.floor(x / CELL))?.get(Math.floor(z / CELL)) ?? index.liveBoxes : set.boxes
}

/** mark a box as blocking-but-not-standable, in place. It has to be in
    place: the backrooms splice chunk boxes back out by identity, and the
    desk strip relies on its position in the obstacle order */
export const noStand = <T extends THREE.Box3>(b: T) => {
  ;(b as Solid).noStand = true
  return b
}

/** grow a box sideways only — see the header on why y is left alone */
export const padXZ = <T extends THREE.Box3>(b: T, pad: number) => {
  b.min.x -= pad
  b.min.z -= pad
  b.max.x += pad
  b.max.z += pad
  return b
}

/** register an object's world AABB as a solid (padded so shoulders don't clip).
    Takes the raw box list because that's what the level builders share around;
    a CollisionSet wraps the same array once a level claims it. */
export const addBoxFrom = (boxes: THREE.Box3[], obj: THREE.Object3D, pad = 0.2) => {
  obj.updateMatrixWorld(true)
  boxes.push(padXZ(new THREE.Box3().setFromObject(obj), pad))
}

/** the highest box top standing under (x, z), or `floorY` if nothing is.
    `reach` is the highest top that counts: the walker passes its feet plus a
    step allowance (so a low ledge reads as ground) and mid-air passes its
    feet alone (so a rising hop can't snap onto a surface it hasn't cleared).
    A box collapsed to a point — how a door retires its blocker when it swings
    open — supports nothing. */
export const supportY = (
  x: number,
  z: number,
  reach: number,
  set: CollisionSet,
  floorY: number,
) => {
  let top = floorY
  for (const b of nearbyBoxes(set, x, z)) {
    if (b.noStand || b.through || b.max.y <= b.min.y || b.max.y <= top) continue
    // out of reach culls a plain box outright, but a hull's box top is the
    // whole body's highest point — the bonnet under the player's feet can be
    // well inside a reach the roof is well outside of, so it has to be asked
    if (!b.hull && !b.ramp && b.max.y > reach) continue
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue
    const t = b.hull ? hullTopAt(b.hull, x, z) : topAt(b, x, z)
    // a slope a hand over the reach is still underfoot (see resolveXZ)
    if (t > (b.ramp ? reach + RAMP_REACH : reach) || t <= top) continue
    top = t
  }
  if (set.dynamic) {
    const t = set.dynamic.topAt(x, z, reach)
    if (t > top) top = t
  }
  return top
}

/** where a body whose feet are *inside* something comes out on top, or
    null when they are inside nothing. Of the solids round (x, z) that the
    feet are in, the tallest top is taken, and the answer is the highest
    standable surface at or below it plus `headroom`, so feet landed in a
    building's mass come out on its roof, and feet in the eave-level mass of
    a house come out on the slope over it (the mass is noStand; the roof is
    `headroom` higher). Asked once, by the walk, on the tick a flight ends:
    letting go of noclip inside a building used to push the body out of the
    nearest wall, and it dropped down the outside to the street */
export const surfaceAbove = (
  x: number,
  z: number,
  footY: number,
  headroom: number,
  set: CollisionSet,
) => {
  let ceil = -Infinity
  for (const b of nearbyBoxes(set, x, z)) {
    if (b.hull) continue
    if (x <= b.min.x || x >= b.max.x || z <= b.min.z || z >= b.max.z) continue
    if (b.min.y > footY || topAt(b, x, z) <= footY) continue
    if (b.max.y > ceil) ceil = b.max.y
  }
  if (ceil === -Infinity) return null
  const t = supportY(x, z, ceil + headroom, set, -Infinity)
  return t > footY ? t : null
}

/** would a body standing here be inside something? The same overlap test
    resolveXZ pushes out of, asked as a question instead — for the callers
    that want to *choose* a spot rather than be shoved out of a bad one
    (picking a free patch to spawn a second player onto, say). Bounds count:
    outside them is not a place to stand either. */
export const blockedAt = (
  x: number,
  z: number,
  footY: number,
  headY: number,
  set: CollisionSet,
  stepUp = 0,
) => {
  if (x < set.bounds.minX || x > set.bounds.maxX) return true
  if (z < set.bounds.minZ || z > set.bounds.maxZ) return true
  for (const b of nearbyBoxes(set, x, z)) {
    if (b.through) continue
    const walkable = b.noStand ? footY : footY + stepUp
    if (b.max.y <= walkable || b.min.y >= headY) continue
    if (!(x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z)) continue
    // one test for both of a hull's ways out: a point past the profile reports
    // -Infinity, a point over something low enough to walk onto reports it
    if (b.hull && hullTopAt(b.hull, x, z) <= walkable) continue
    if (b.ramp && topAt(b, x, z) <= Math.max(walkable, footY + RAMP_REACH)) continue
    return true
  }
  return set.dynamic ? set.dynamic.blocks(x, z, footY, headY, stepUp) : false
}

/** clamp to the level bounds, then push out of every box the body's own
    y-span runs into. `stepUp` is the ledge height the caller climbs instead
    of colliding with — zero in mid-air, where a hop has to clear a surface
    before it may travel over it. */
export const resolveXZ = (
  p: THREE.Vector3,
  set: CollisionSet,
  footY: number,
  headY: number,
  stepUp = 0,
) => {
  const index = collisionIndex(set)
  if (!index) return resolveLinear(p, set, footY, headY, stepUp)
  p.x = THREE.MathUtils.clamp(p.x, set.bounds.minX, set.bounds.maxX)
  p.z = THREE.MathUtils.clamp(p.z, set.bounds.minZ, set.bounds.maxZ)
  let cx = Math.floor(p.x / CELL)
  let cz = Math.floor(p.z / CELL)
  let nearby = cellAt(index, cx, cz)
  let cursor = 0
  let last = -1
  for (;;) {
    // A prior push may enter another cell. Only boxes later in the original
    // array are eligible, exactly as in the linear one-pass resolver.
    if (index) {
      const nx = Math.floor(p.x / CELL)
      const nz = Math.floor(p.z / CELL)
      if (nx !== cx || nz !== cz) {
        cx = nx
        cz = nz
        nearby = cellAt(index, cx, cz)
        cursor = afterIndex(nearby, last)
      }
    }
    if (cursor >= nearby.length) break
    last = nearby[cursor++]
    const b = set.boxes[last]
    // low enough to step onto, or entirely underfoot/overhead: not a wall.
    // A noStand solid forfeits the step allowance — its top isn't a floor,
    // so there is nothing to climb onto and it stays a wall to the last
    // millimetre — but it still stops blocking once the feet clear it,
    // which is what lets a walk cross a low rail from something taller.
    if (b.through) continue
    const walkable = b.noStand ? footY : footY + stepUp
    if (b.max.y <= walkable || b.min.y >= headY) continue
    if (!(p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z)) continue
    if (b.hull) {
      pushOutHull(p, b.hull, walkable)
      continue
    }
    // a roof slope under the feet (or low enough to step up) is a floor, and
    // so is one a hand's width over them in mid-air: a hop up the slope has
    // its feet under the surface ahead for a tick or two, and that is a
    // landing, not a wall to be thrown off the eaves by
    if (b.ramp && topAt(b, p.x, p.z) <= Math.max(walkable, footY + RAMP_REACH)) continue
    const exitL = p.x - b.min.x
    const exitR = b.max.x - p.x
    const exitN = p.z - b.min.z
    const exitF = b.max.z - p.z
    const m = Math.min(exitL, exitR, exitN, exitF)
    if (m === exitL) p.x = b.min.x
    else if (m === exitR) p.x = b.max.x
    else if (m === exitN) p.z = b.min.z
    else p.z = b.max.z
  }
  // the moving solids last: a prop pushed against a wall is resolved after
  // the wall, so the player ends up against the prop rather than inside it
  set.dynamic?.pushOut(p, footY, headY, stepUp)
}

// Keep the small-set path a plain array loop: adding a per-box grid branch
// slows those sets down more than their handful of collisions costs.
const resolveLinear = (
  p: THREE.Vector3,
  set: CollisionSet,
  footY: number,
  headY: number,
  stepUp = 0,
) => {
  p.x = THREE.MathUtils.clamp(p.x, set.bounds.minX, set.bounds.maxX)
  p.z = THREE.MathUtils.clamp(p.z, set.bounds.minZ, set.bounds.maxZ)
  for (const b of set.boxes) {
    // low enough to step onto, or entirely underfoot/overhead: not a wall.
    // A noStand solid forfeits the step allowance — its top isn't a floor,
    // so there is nothing to climb onto and it stays a wall to the last
    // millimetre — but it still stops blocking once the feet clear it,
    // which is what lets a walk cross a low rail from something taller.
    if (b.through) continue
    const walkable = b.noStand ? footY : footY + stepUp
    if (b.max.y <= walkable || b.min.y >= headY) continue
    if (!(p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z)) continue
    if (b.hull) {
      pushOutHull(p, b.hull, walkable)
      continue
    }
    // a roof slope under the feet (or low enough to step up) is a floor, and
    // so is one a hand's width over them in mid-air: a hop up the slope has
    // its feet under the surface ahead for a tick or two, and that is a
    // landing, not a wall to be thrown off the eaves by
    if (b.ramp && topAt(b, p.x, p.z) <= Math.max(walkable, footY + RAMP_REACH)) continue
    const exitL = p.x - b.min.x
    const exitR = b.max.x - p.x
    const exitN = p.z - b.min.z
    const exitF = b.max.z - p.z
    const m = Math.min(exitL, exitR, exitN, exitF)
    if (m === exitL) p.x = b.min.x
    else if (m === exitR) p.x = b.max.x
    else if (m === exitN) p.z = b.min.z
    else p.z = b.max.z
  }
  // the moving solids last: a prop pushed against a wall is resolved after
  // the wall, so the player ends up against the prop rather than inside it
  set.dynamic?.pushOut(p, footY, headY, stepUp)
}

/** where a world point sits inside a hull, and the shortest way out of it.
    Returns false when the point is outside the profile; otherwise `depth` is
    the distance to the nearest edge and (`px`, `pz`) is the world-space vector
    that takes the point there.

    Same geometry as `pushOutHull` below, asked as a measurement rather than as
    a move: `pushOutHull` shoves the walker out of one solid on the spot, while
    a vehicle sweep has to compare contacts across every solid it overlaps and
    act on the deepest one only (adding several pushes together in a corner
    ejects a car across the street). */
export const hullExit = (
  h: Hull,
  x: number,
  z: number,
  out: { px: number; pz: number; depth: number },
) => {
  const dx = x - h.x
  const dz = z - h.z
  const lx = dx * h.cos - dz * h.sin
  const lz = dx * h.sin + dz * h.cos
  stationAt(h, lz, prof)
  if (prof.hw <= 0) return false
  if (lx <= -prof.hw || lx >= prof.hw) return false
  const st = h.st
  const exitL = lx + prof.hw
  const exitR = prof.hw - lx
  const exitN = lz - st[0].z
  const exitF = st[st.length - 1].z - lz
  const m = Math.min(exitL, exitR, exitN, exitF)
  let nx = lx
  let nz = lz
  if (m === exitL) nx = -prof.hw
  else if (m === exitR) nx = prof.hw
  else if (m === exitN) nz = st[0].z
  else nz = st[st.length - 1].z
  const ox = nx - lx
  const oz = nz - lz
  out.depth = m
  out.px = ox * h.cos + oz * h.sin
  out.pz = -ox * h.sin + oz * h.cos
  return true
}

/** the same push, done in the hull's own frame. The four ways out are the two
    flanks at this station and the two ends of the profile, and because the
    sideways exit moves only x it lands exactly on the half-width it measured
    — a taper costs nothing. Sliding along a car therefore follows the paint
    instead of a corner of air. */
const pushOutHull = (p: THREE.Vector3, h: Hull, walkable: number) => {
  const dx = p.x - h.x
  const dz = p.z - h.z
  const lx = dx * h.cos - dz * h.sin
  const lz = dx * h.sin + dz * h.cos
  stationAt(h, lz, prof)
  if (prof.hw <= 0) return
  if (lx <= -prof.hw || lx >= prof.hw) return
  if (h.y + prof.top <= walkable) return
  const st = h.st
  const exitL = lx + prof.hw
  const exitR = prof.hw - lx
  const exitN = lz - st[0].z
  const exitF = st[st.length - 1].z - lz
  const m = Math.min(exitL, exitR, exitN, exitF)
  let nx = lx
  let nz = lz
  if (m === exitL) nx = -prof.hw
  else if (m === exitR) nx = prof.hw
  else if (m === exitN) nz = st[0].z
  else nz = st[st.length - 1].z
  p.x = h.x + nx * h.cos + nz * h.sin
  p.z = h.z - nx * h.sin + nz * h.cos
}
