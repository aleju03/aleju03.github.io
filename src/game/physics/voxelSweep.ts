import type * as THREE from 'three'
import type { CollisionSet, Solid } from './collision'

/*
  The walk through a voxel grid, swept rather than pushed out.

  collision.ts answers "is the body inside something" and shoves it out of
  whichever face is nearest. That is exact only while a tick moves the body
  less than half the thinnest solid, and Cubeland's thinnest solid is one
  block padded by a shoulder either side, 2.84 units: a fall that noclip let
  go of carries up to 83 u/s of drift, a portal fling more, and at the frame
  loop's 50 ms dt cap even the first of those is 4 units a tick. The body
  landed past the middle of the hillside, the nearest face was the far one or
  a cave wall, and once the feet were inside a column box nothing under them
  was standable any more (supportY only counts tops at or below the feet), so
  the walk fell straight down through the stone into the caves.

  So where a level's static solids *are* a grid (CollisionSet.voxels), the
  walk asks the grid instead, the way the famous block game does: the planar
  step is split per axis (the longer first) and each is clipped against the
  cells the body's box would sweep through, stopping a skin short of the
  first solid one. A cell the body already overlaps never blocks, so a body
  a block was placed in can still walk out of it. The vertical gets the same
  treatment in its two directions: a rise is clipped under the first cell
  over the head (`voxelCeiling`), and the fall's landing height is the
  highest cell top under the feet (`voxelSupport`), read off the grid rather
  than off the walker's box ring, so a move that outruns the ring still
  lands. And feet that end up inside a block anyway (a peer's block, a sand
  fall, a stand-up out of a ragdoll) are lifted to the first gap tall enough
  to stand in (`voxelLift`) rather than left to fall out of the bottom.

  None of this replaces the boxes: they are the same shape (a cell grown by
  `half` sideways is exactly a padded box), so once the sweep has run
  resolveXZ finds nothing to push, and it stays in charge of the level
  bounds, the props and anything else in the set. A box a portal has opened
  (`through`) lets its cells through here as well.

  Cost is the cells actually crossed: a walking tick reads a dozen, a fall
  from the top of the world about a hundred and fifty. React-free and
  renderer-free like the rest of physics/.
*/

export interface VoxelGrid {
  /** a cell's edge in world units; cells stack from y = 0 */
  size: number
  /** world x and z of cell (0, *, 0)'s corner */
  ox: number
  oz: number
  /** the walker's half-width: what the level's boxes are padded by */
  half: number
  /** is this cell solid to a walker */
  solid: (cx: number, cy: number, cz: number) => boolean
}

/** flush is not overlapping: a face this close counts as touching */
const EPS = 1e-4
/** the gap a clip leaves in front of a face, so the next tick's arithmetic
    cannot read the body as already inside the cell it stopped against */
const SKIN = 1e-3
/** the head's clearance under a block, the same the level's ceilingAt keeps */
const CROWN_GAP = 0.02
/** no sweep reads further than this many cells along one axis; a body told
    to go further in a tick stops there instead of passing anything */
const MAX_CELLS = 256

/** the boxes a portal has opened this tick (see voxelBegin) */
const open: Solid[] = []

/** once per walk tick, before any of the rest: notes which of the set's
    boxes are open (`through`), so their cells let the body in. Almost always
    none, and one pass over the ring's boxes when there are */
export const voxelBegin = (set: CollisionSet) => {
  open.length = 0
  for (const b of set.boxes) if (b.through) open.push(b)
}

const blocked = (g: VoxelGrid, cx: number, cy: number, cz: number) => {
  if (!g.solid(cx, cy, cz)) return false
  if (!open.length) return true
  const x = g.ox + (cx + 0.5) * g.size
  const y = (cy + 0.5) * g.size
  const z = g.oz + (cz + 0.5) * g.size
  for (const b of open) {
    if (x > b.min.x && x < b.max.x && y > b.min.y && y < b.max.y && z > b.min.z && z < b.max.z) return false
  }
  return true
}

/** how far along one axis the body may go: `dist` clipped a skin short of the
    first solid cell its box would sweep into. `along`/`across` are the body's
    centre on the moving and the other planar axis, in world units */
const clipAxis = (
  g: VoxelGrid,
  alongX: boolean,
  along: number,
  across: number,
  dist: number,
  y0: number,
  y1: number,
) => {
  if (dist === 0) return 0
  const s = g.size
  const h = g.half
  const oA = alongX ? g.ox : g.oz
  const oC = alongX ? g.oz : g.ox
  const c0 = Math.floor((across - h + EPS - oC) / s)
  const c1 = Math.floor((across + h - EPS - oC) / s)
  const hit = (a: number) => {
    for (let c = c0; c <= c1; c++)
      for (let cy = y0; cy <= y1; cy++) if (alongX ? blocked(g, a, cy, c) : blocked(g, c, cy, a)) return true
    return false
  }
  if (dist > 0) {
    // the leading face, and the first column wholly ahead of it
    const e = along + h - oA
    const first = Math.ceil((e - EPS) / s)
    for (let a = first, n = 0; a * s < e + dist; a++, n++) {
      if (n >= MAX_CELLS) return Math.max(0, a * s - SKIN - e)
      if (hit(a)) return Math.max(0, a * s - SKIN - e)
    }
    return dist
  }
  const e = along - h - oA
  const first = Math.floor((e + EPS) / s) - 1
  for (let a = first, n = 0; (a + 1) * s > e + dist; a--, n++) {
    if (n >= MAX_CELLS) return Math.min(0, (a + 1) * s + SKIN - e)
    if (hit(a)) return Math.min(0, (a + 1) * s + SKIN - e)
  }
  return dist
}

/** move the body from (x0, z0) to where `p` already says, clipped per axis
    against the grid; writes the result into `p`. The body spans footY to
    headY, and a cell whose top is within `stepUp` of the feet is a floor to
    walk onto, not a wall (the same deal resolveXZ gives a box) */
export const voxelSweepXZ = (
  set: CollisionSet,
  p: THREE.Vector3,
  x0: number,
  z0: number,
  footY: number,
  headY: number,
  stepUp: number,
) => {
  const g = set.voxels
  if (!g) return
  const dx = p.x - x0
  const dz = p.z - z0
  if (dx === 0 && dz === 0) return
  const y0 = Math.floor((footY + stepUp) / g.size)
  const y1 = Math.ceil((headY - EPS) / g.size) - 1
  p.x = x0
  p.z = z0
  if (y1 < y0) {
    p.x += dx
    p.z += dz
    return
  }
  // the longer axis first, so a glancing run along a wall is not stopped by
  // the short axis catching the corner of the wall it is sliding past
  if (Math.abs(dx) >= Math.abs(dz)) {
    p.x += clipAxis(g, true, p.x, p.z, dx, y0, y1)
    p.z += clipAxis(g, false, p.z, p.x, dz, y0, y1)
  } else {
    p.z += clipAxis(g, false, p.z, p.x, dz, y0, y1)
    p.x += clipAxis(g, true, p.x, p.z, dx, y0, y1)
  }
}

/** is any cell under the body's footprint at this cell height solid */
const rowBlocked = (g: VoxelGrid, x: number, z: number, cy: number) => {
  const s = g.size
  const h = g.half - EPS
  const x0 = Math.floor((x - h - g.ox) / s)
  const x1 = Math.floor((x + h - g.ox) / s)
  const z0 = Math.floor((z - h - g.oz) / s)
  const z1 = Math.floor((z + h - g.oz) / s)
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) if (blocked(g, cx, cy, cz)) return true
  return false
}

/** the highest cell top under the body's footprint at or below `reach`, if
    it is over `above`; otherwise `above`. The walk passes the box ring's own
    answer as `above`, so the scan only reads the cells between the two and
    normally agrees with it at once */
export const voxelSupport = (set: CollisionSet, x: number, z: number, reach: number, above: number) => {
  const g = set.voxels
  if (!g) return above
  const s = g.size
  for (let cy = Math.floor(reach / s) - 1, n = 0; (cy + 1) * s > above && n < MAX_CELLS; cy--, n++) {
    if (rowBlocked(g, x, z, cy)) return (cy + 1) * s
  }
  return above
}

/** the highest the head may rise to on the way from `fromHead` to `toHead`:
    under the first solid cell over the footprint, or `toHead` if there is
    none. A cell the head is already in does not count */
export const voxelCeiling = (set: CollisionSet, x: number, z: number, fromHead: number, toHead: number) => {
  const g = set.voxels
  if (!g || toHead <= fromHead) return toHead
  const s = g.size
  for (let cy = Math.floor((fromHead - EPS) / s) + 1, n = 0; cy * s < toHead && n < MAX_CELLS; cy++, n++) {
    if (rowBlocked(g, x, z, cy)) return Math.min(toHead, cy * s - CROWN_GAP)
  }
  return toHead
}

/** feet inside a solid cell: the height of the first gap above them tall
    enough for a body `height` tall, or null when the feet are in the open */
export const voxelLift = (set: CollisionSet, x: number, z: number, footY: number, height: number) => {
  const g = set.voxels
  if (!g) return null
  const s = g.size
  const start = Math.floor((footY + 0.05) / s)
  if (!rowBlocked(g, x, z, start)) return null
  const need = Math.max(1, Math.ceil(height / s))
  let run = 0
  for (let cy = start + 1, n = 0; n < MAX_CELLS; cy++, n++) {
    if (rowBlocked(g, x, z, cy)) run = 0
    else if (++run >= need) return (cy - need + 1) * s
  }
  return null
}
