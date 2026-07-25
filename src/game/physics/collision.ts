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

/** a collision box that may also declare its top off-limits. An AABB is a
    coarse stand-in for the thing it wraps, and for plenty of solids the top
    of that box is nowhere a body could stand: the ceiling plane over a
    paper-thin wall, the lampshade of a floor lamp, mid-canopy on a tree, the
    eave line of a house with a roof above it. Marking those keeps the world
    honest without asking every builder for real geometry. */
export interface Solid extends THREE.Box3 {
  noStand?: boolean
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
    if (b.noStand || b.max.y <= b.min.y || b.max.y > reach || b.max.y <= top) continue
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue
    top = b.max.y
  }
  return top
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
    if (p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z) {
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
}
