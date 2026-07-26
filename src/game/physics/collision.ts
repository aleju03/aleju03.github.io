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

  Padding is x/z only (padXZ, and addBoxFrom on top of it). The pad exists so
  shoulders don't clip a wall; inflating it upward would leave the player
  standing a hand's width above every surface they climb onto, and downward
  would sink a box's underside below the floor it rests on.

  When the world grows past a few hundred boxes, the upgrade path is inside
  resolveXZ/supportY: swap the linear scan for a spatial hash over the same
  CollisionSet contract (or graduate to a real physics lib) without touching
  any caller.
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
  hull?: Hull
  breaks?: Breakable
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

export interface CollisionSet {
  boxes: Solid[]
  bounds: WorldBounds
}

export const makeCollisionSet = (bounds: WorldBounds, boxes: Solid[] = []): CollisionSet => ({
  boxes,
  bounds,
})

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
  for (const b of set.boxes) {
    if (b.noStand || b.max.y <= b.min.y || b.max.y <= top) continue
    // out of reach culls a plain box outright, but a hull's box top is the
    // whole body's highest point — the bonnet under the player's feet can be
    // well inside a reach the roof is well outside of, so it has to be asked
    if (!b.hull && b.max.y > reach) continue
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue
    const t = b.hull ? hullTopAt(b.hull, x, z) : b.max.y
    if (t > reach || t <= top) continue
    top = t
  }
  return top
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
  for (const b of set.boxes) {
    const walkable = b.noStand ? footY : footY + stepUp
    if (b.max.y <= walkable || b.min.y >= headY) continue
    if (!(x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z)) continue
    // one test for both of a hull's ways out: a point past the profile reports
    // -Infinity, a point over something low enough to walk onto reports it
    if (b.hull && hullTopAt(b.hull, x, z) <= walkable) continue
    return true
  }
  return false
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
  p.x = THREE.MathUtils.clamp(p.x, set.bounds.minX, set.bounds.maxX)
  p.z = THREE.MathUtils.clamp(p.z, set.bounds.minZ, set.bounds.maxZ)
  for (const b of set.boxes) {
    // low enough to step onto, or entirely underfoot/overhead: not a wall.
    // A noStand solid forfeits the step allowance — its top isn't a floor,
    // so there is nothing to climb onto and it stays a wall to the last
    // millimetre — but it still stops blocking once the feet clear it,
    // which is what lets a walk cross a low rail from something taller.
    const walkable = b.noStand ? footY : footY + stepUp
    if (b.max.y <= walkable || b.min.y >= headY) continue
    if (!(p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z)) continue
    if (b.hull) {
      pushOutHull(p, b.hull, walkable)
      continue
    }
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
