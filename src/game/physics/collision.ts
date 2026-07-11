import * as THREE from 'three'

/*
  Walk-mode collision. The model is deliberately simple: every solid is an
  axis-aligned Box3 checked on x/z only (no y — verticality is jumpY on top
  of a level's flat groundY for now), and a hit pushes the player out along
  whichever face is closest, which is what makes sliding along walls feel
  right. Each level owns one CollisionSet; the level system decides which
  set is live. Solids must register a box or the player walks through them —
  the backrooms entrance works by deliberately not registering one.

  When the world grows past a few hundred boxes, the upgrade path is inside
  resolveXZ: swap the linear scan for a spatial hash over the same CollisionSet
  contract (or graduate to a real physics lib) without touching any caller.
*/

/** hard outer clamp, pre-shrunk by whatever shoulder margin the level wants */
export interface WorldBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface CollisionSet {
  boxes: THREE.Box3[]
  bounds: WorldBounds
}

export const makeCollisionSet = (bounds: WorldBounds, boxes: THREE.Box3[] = []): CollisionSet => ({
  boxes,
  bounds,
})

/** register an object's world AABB as a solid (padded so shoulders don't clip).
    Takes the raw box list because that's what the level builders share around;
    a CollisionSet wraps the same array once a level claims it. */
export const addBoxFrom = (boxes: THREE.Box3[], obj: THREE.Object3D, pad = 0.2) => {
  obj.updateMatrixWorld(true)
  boxes.push(new THREE.Box3().setFromObject(obj).expandByScalar(pad))
}

/** clamp to the level bounds, then push out of any box along its nearest face */
export const resolveXZ = (p: THREE.Vector3, set: CollisionSet) => {
  p.x = THREE.MathUtils.clamp(p.x, set.bounds.minX, set.bounds.maxX)
  p.z = THREE.MathUtils.clamp(p.z, set.bounds.minZ, set.bounds.maxZ)
  for (const b of set.boxes) {
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
