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
