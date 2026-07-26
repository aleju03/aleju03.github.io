/*
  Walk-in interiors, as rectangles the vegetation must stay out of.

  The grass field and the wildflowers are not part of the chunk system (see
  grass.ts's header), so they cannot see the buildings a chunk erected — and
  an enterable shop is the one building whose inside is open air rather than
  solid box, which is exactly where blades used to grow through the floor.
  The chunk builder therefore reports every interior footprint it builds
  (stoop included), the streamer registers them alongside the chunk's
  lifetime, and the blade/flower fills ask one cheap rectangle test before
  placing a slot.

  The registry is flattened into one array on every change because lookups
  outnumber changes by five orders of magnitude: a full lattice refill is
  tens of thousands of tests, a chunk border crossing changes a handful of
  entries. Live interiors number a few dozen at worst (shops are scattered a
  few to a town), so the linear scan is cheaper than any index would be.
*/

export interface InteriorRect {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

const live = new Map<string, InteriorRect[]>()
let flat: InteriorRect[] = []

const rebuild = () => {
  flat = []
  for (const rects of live.values()) flat.push(...rects)
}

/** a chunk's interiors, keyed by the streamer's own chunk key */
export const registerInteriors = (key: string, rects: InteriorRect[]) => {
  if (!rects.length) {
    if (live.delete(key)) rebuild()
    return
  }
  live.set(key, rects)
  rebuild()
}

export const unregisterInteriors = (key: string) => {
  if (live.delete(key)) rebuild()
}

/** is this point inside (or within `pad` of) any live interior */
export const insideInterior = (x: number, z: number, pad = 0) => {
  for (const r of flat) {
    if (x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad) {
      return true
    }
  }
  return false
}
