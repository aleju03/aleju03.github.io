/*
  The one grid everything outdoors agrees on.

  A chunk is 64 units square and the streaming ring, the town road network and
  the terrain mesh all index off it. The offset is not arbitrary: the world is
  shifted so that chunk (0, 0) is exactly the block the house stands in, which
  buys two things. Roads run along chunk borders, so a town's street grid never
  cuts a block in half and no building ever straddles a streaming boundary; and
  the border in front of the property lands on z = -11.2, which is precisely
  where the hand-authored street used to sit (its asphalt ran -14.4..-8). The
  generated street therefore arrives exactly where the porch, the gate and the
  front walk were already built to meet it.

  GRID is the terrain mesh's cell size. Collision samples the surface through
  the same lattice (terrain.ts's terrainY), so the player stands on the drawn
  triangle rather than on the analytic field the triangle approximates — off
  by up to a third of a unit on a hillside, which is the difference between
  walking on the grass and wading through it.
*/

/** chunk edge length in world units */
export const CHUNK = 64

/** world position of chunk (0,0)'s minimum corner */
export const OFF_X = -32
export const OFF_Z = -11.2

/** terrain mesh cell size; CHUNK must stay an integer multiple of it */
export const GRID = 4

export const chunkX = (x: number) => Math.floor((x - OFF_X) / CHUNK)
export const chunkZ = (z: number) => Math.floor((z - OFF_Z) / CHUNK)
export const originX = (cx: number) => cx * CHUNK + OFF_X
export const originZ = (cz: number) => cz * CHUNK + OFF_Z

/** the property the house owns, plus a margin. Nothing generated — no tree,
    no building, no street furniture — is allowed inside it: this is the one
    place in an endless procedural world that was authored by hand. */
export const RESERVED = { minX: -17.5, maxX: 17.5, minZ: -8.5, maxZ: 43 }

export const inReserved = (x: number, z: number, pad = 0) =>
  x > RESERVED.minX - pad &&
  x < RESERVED.maxX + pad &&
  z > RESERVED.minZ - pad &&
  z < RESERVED.maxZ + pad

/** the fence line itself, inside RESERVED's margin (houseWorld's YARD rect,
    mirrored here so world modules can read it without importing a level).
    Solid, collidable worldgen still respects RESERVED — but *cosmetic* cover
    (grass blades, tufts, flowers) is allowed onto the strip between the two:
    a bald green moat around the fence read as a hole cut in the world's turf. */
export const YARD_FENCE = { minX: -13.5, maxX: 13.5, minZ: -4, maxZ: 38.5 }

export const inYard = (x: number, z: number, pad = 0) =>
  x > YARD_FENCE.minX - pad &&
  x < YARD_FENCE.maxX + pad &&
  z > YARD_FENCE.minZ - pad &&
  z < YARD_FENCE.maxZ + pad

/** the authored hardscape inside the fence — the house slab, the back porch,
    the front step and walk, the stepping stones — mirrored from houseWorld the
    same way YARD_FENCE is, so the grass field can grow the yard's turf and
    still mow around what was built by hand. */
const HOME_HARD_RECTS = [
  { minX: -8.1, maxX: 8.1, minZ: -2.3, maxZ: 25.0 }, // house + wall margin
  { minX: -5.6, maxX: -1.5, minZ: 24.4, maxZ: 27.5 }, // back porch slab
  { minX: 3.85, maxX: 7.15, minZ: -3.1, maxZ: -1.7 }, // front doorstep
  { minX: 4.6, maxX: 6.4, minZ: -4.3, maxZ: -2.9 }, // front walk to the gate
]
const HOME_STONES: Array<[number, number]> = [
  [-2.1, 27.3], [-1.0, 28.4], [0.2, 29.3], [1.5, 30.1],
  [2.8, 30.9], [3.9, 31.9], [4.6, 33.1],
]
export const onHomeHardscape = (x: number, z: number) => {
  for (const r of HOME_HARD_RECTS)
    if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) return true
  for (const [sx, sz] of HOME_STONES)
    if ((x - sx) ** 2 + (z - sz) ** 2 < 0.72) return true
  return false
}
