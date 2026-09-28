/*
  Footprints the vegetation must stay out of: walk-in interiors, and every
  surface a building lays lower than a blade of grass.

  The grass field and the wildflowers are not part of the chunk system (see
  grass.ts's header), so they cannot see the buildings a chunk erected. A
  solid building hides whatever grows under it inside its own box, but two
  kinds of thing do not: an enterable shop, whose inside is open air rather
  than solid box, and anything flat and low (a drive, a path, a porch deck, a
  stoop), which a half-metre blade grows straight up through. The chunk
  builder therefore reports every such footprint it builds, the streamer
  registers them alongside the chunk's lifetime, and the blade and flower
  fills ask one cheap test before placing a slot.

  Two things make that test honest. The fills run when the grass lattice
  scrolls, which is usually *before* the chunk under it has streamed in (a
  boot, a teleport, a fast drive), so a registration also tells its
  listeners which rectangles just arrived and the grass re-fills the slots
  under them; without that, every shop built after the field had filled
  kept the blades already standing in it, which is how a floor full of
  grass got photographed. And there are a thousand or so of these live in a
  suburb, against tens of thousands of tests a refill, so they are bucketed
  on a coarse grid rather than scanned: a test reads one cell.
*/

export interface InteriorRect {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/** bucket edge, in units: a lot is about this size, so most rects touch one
    to four cells */
const CELL = 16
/** the widest pad any caller passes; rects are bucketed this much grown so
    a padded test never misses one lying just over a cell edge */
const PAD_MAX = 1

const live = new Map<string, InteriorRect[]>()
let grid = new Map<number, InteriorRect[]>()
const listeners = new Set<(added: InteriorRect[]) => void>()

const cellKey = (ci: number, cj: number) => ci * 73856093 ^ cj * 19349663

const rebuild = () => {
  grid = new Map()
  for (const rects of live.values()) {
    for (const r of rects) {
      const i0 = Math.floor((r.minX - PAD_MAX) / CELL)
      const i1 = Math.floor((r.maxX + PAD_MAX) / CELL)
      const j0 = Math.floor((r.minZ - PAD_MAX) / CELL)
      const j1 = Math.floor((r.maxZ + PAD_MAX) / CELL)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = cellKey(i, j)
          const list = grid.get(k)
          if (list) list.push(r)
          else grid.set(k, [r])
        }
    }
  }
}

/** a chunk's footprints, keyed by the streamer's own chunk key */
export const registerInteriors = (key: string, rects: InteriorRect[]) => {
  if (!rects.length) {
    if (live.delete(key)) rebuild()
    return
  }
  live.set(key, rects)
  rebuild()
  for (const fn of listeners) fn(rects)
}

export const unregisterInteriors = (key: string) => {
  if (live.delete(key)) rebuild()
}

/** hear about footprints as they arrive, so anything that already placed
    itself over one can take itself back out. Returns the unsubscribe */
export const onInteriorsAdded = (fn: (added: InteriorRect[]) => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** is this point inside (or within `pad` of, up to a unit) any live footprint */
export const insideInterior = (x: number, z: number, pad = 0) => {
  const list = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)))
  if (!list) return false
  for (const r of list) {
    if (x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad) {
      return true
    }
  }
  return false
}
