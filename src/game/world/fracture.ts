import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import type { Span } from './debris'
import { PREBORN } from './fade'
import { SURF } from './surface'
import { seeded } from '../core/rand'

/*
  How a building comes apart: the geometry half of destruction, and all of it
  pure, so it runs in Node and a critic's numbers and a player's collapse come
  out of the same code.

  A building out here is not an object. It is a run of stamps inside a chunk's
  merged soup (chunk.ts records the span and, via MeshBuilder's `marks`, where
  each stamp inside it starts), and most of those stamps are *solid*: a
  mid-rise is one brick box the full height of the building with windows
  pasted on its faces, which is the right thing to draw and the wrong thing to
  break, because a solid box cut into cells is a stack of solid blocks. So the
  first time anything damages a building it is rebuilt, once, as a structure:

  - **Hollowed.** Every stamp big enough to enclose a room (both plan extents
    over three units) is replaced by a shell of slabs, one per face, mitred
    against its neighbours by building the inner surface as the same stamp
    scaled inward. The outer faces keep their own vertices, colours and
    `aSurf` exactly, so nothing on the outside changes by a pixel. Bottom
    faces are dropped (they are underground), and so is any face buried in
    another shell (the top of a stone band inside the body it wraps).
  - **Floored.** A shell taller than a storey and a half gets a concrete slab
    at each storey line, cut from the stamp's own cross-section at that
    height, so a round tower gets round floors. They were never drawn before
    because nothing could see inside; now the collapse pancakes onto them and
    the ruin has somewhere to stand.
  - **Cut into cells.** Planes at the storey lines (paired up on tall
    buildings) and every five to nine units across the plan split every
    fragment that straddles them. A cut through a closed convex fragment is
    capped with the convex hull of the cut, painted in the stamp's core
    colour and keeping its surface code, so a broken brick wall shows brick
    edges rather than a hollow box.
  - **Grouped into pieces.** Everything in one cell facing one way is one
    piece: the north wall of the third storey between two columns, with its
    windows, sills and band strip; that storey's floor; that bay of roof.
    Each piece is contiguous in the rebuilt geometry, which is the whole
    point: it is a span, and a span is something world/debris.ts's collapse
    already knows how to lift out of a merged mesh.

  And a support graph over the pieces: which rest on which (vertical) and
  which are bonded side by side (lateral). sandbox/destruction.ts walks it to
  decide what stays up.

  Determinism is the contract here as everywhere else: the cell grid comes
  from the lot, not from the geometry's vertex count, so a building rebuilt on
  the outer ring (no windows) and on the near ring (windows) cuts into the
  same pieces with the same keys, and a destroyed piece's key re-applies to
  either.
*/

/* --------------------------------------------------------------- records -- */

/** what chunk.ts remembers about every building it stamps: enough to find
    it again in the merged soup and take it apart, and nothing else */
export interface StructureRec {
  /** position-stable: the chunk and the lot, never a running count */
  id: string
  /** the kit that built it (a BuildKind or a LandmarkKind) */
  kind: string
  /** the ground it stands on */
  baseY: number
  /** the storey height the kit builds to, which is where the floors go */
  storeyH: number
  /** 0 timber and render, 1 masonry, 2 a framed tower: how much it takes */
  grade: number
  /** its spans in the chunk's detail and glass soups */
  det: Span | null
  gl: Span | null
  /** first vertex and first index of every stamp, pairs, absolute */
  marks: Int32Array
  gmarks: Int32Array
  /** the solids it registered, emptied when it is rebuilt as pieces */
  boxes: Solid[]
}

/** storey heights, off the kits themselves (buildings.ts, houses.ts) */
export const STOREY: Record<string, number> = {
  house: 4.4, shop: 6.2, midrise: 4.6, mixed: 4.4, tower: 5.4, slab: 4.4,
  round: 4.6, warehouse: 6.0, chapel: 5.0, parking: 3.6,
}
/** how much each kind takes (see StructureRec.grade) */
export const GRADE: Record<string, number> = {
  house: 0, shop: 0, midrise: 1, mixed: 1, tower: 2, slab: 2, round: 2,
  warehouse: 0, chapel: 1, parking: 2,
}

/* ----------------------------------------------------------------- frags -- */

/**
 * One convex-ish piece of surface: a triangle soup with per-vertex normals and
 * colours, one surface code, and whether it is a closed solid (a cut through
 * a closed one is capped; a cut through a window pane is just a shorter pane).
 */
export interface Frag {
  /** xyz per vertex, three vertices a triangle, rest-world coordinates */
  p: number[]
  n: number[]
  c: number[]
  surf: number
  closed: boolean
  /** what a cut through it is painted */
  core: [number, number, number]
  /** outward facing: 0 +x, 1 -x, 2 +z, 3 -z, 4 up (roof), 5 floor, -1 unknown */
  face: number
  glass: boolean
}

export type PieceKind = 'wall' | 'floor' | 'roof' | 'misc'

export interface Piece {
  /** stable across tiers: cell and facing */
  key: number
  kind: PieceKind
  /** cell indices */
  ix: number
  iy: number
  iz: number
  min: THREE.Vector3
  max: THREE.Vector3
  /** centre of mass, near enough (volume-weighted fragment centroids) */
  center: THREE.Vector3
  /** cubic units of material */
  vol: number
  /** its spans in the rebuilt geometry: [first vertex, count] */
  d: [number, number] | null
  g: [number, number] | null
  frags: Frag[]
  /** pieces this one rests on, and pieces bonded beside it (indices) */
  under: number[]
  side: number[]
  /** pieces resting on this one */
  over: number[]
  grounded: boolean
}

export interface Fractured {
  rec: StructureRec
  pieces: Piece[]
  detail: THREE.BufferGeometry | null
  glass: THREE.BufferGeometry | null
  /** the plan and height it was cut over */
  min: THREE.Vector3
  max: THREE.Vector3
  /** storey bins (y) and how tall each is */
  ny: number
  binH: number
  y0: number
}

/* -------------------------------------------------------------- reading -- */

interface Soup {
  pos: ArrayLike<number>
  nor: ArrayLike<number> | null
  col: ArrayLike<number> | null
  surf: ArrayLike<number> | null
  idx: ArrayLike<number> | null
}

const soupOf = (g: THREE.BufferGeometry): Soup => ({
  pos: g.getAttribute('position').array as ArrayLike<number>,
  nor: (g.getAttribute('normal')?.array as ArrayLike<number>) ?? null,
  col: (g.getAttribute('color')?.array as ArrayLike<number>) ?? null,
  surf: (g.getAttribute('aSurf')?.array as ArrayLike<number>) ?? null,
  idx: (g.getIndex()?.array as ArrayLike<number>) ?? null,
})

const coreOf = (r: number, g: number, b: number): [number, number, number] => {
  // the inside of a wall is its own material a shade darker and greyer:
  // mortar and blockwork behind the render, which reads as a break rather
  // than as a painted edge
  const l = (r + g + b) / 3
  return [(r * 0.55 + l * 0.45) * 0.7, (g * 0.55 + l * 0.45) * 0.7, (b * 0.55 + l * 0.45) * 0.7]
}

/** every stamp of one span, as closed-or-open fragments */
const readStamps = (
  soup: Soup, span: Span, marks: Int32Array, glass: boolean,
): Frag[] => {
  const [v0, vn, i0, ic] = span
  const out: Frag[] = []
  const n = marks.length / 2
  for (let k = 0; k < n; k++) {
    const vs = marks[k * 2]
    const is = marks[k * 2 + 1]
    const ve = k + 1 < n ? marks[k * 2 + 2] : v0 + vn
    const ie = k + 1 < n ? marks[k * 2 + 3] : i0 + ic
    if (ve <= vs) continue
    const p: number[] = []
    const nn: number[] = []
    const c: number[] = []
    const push = (vi: number) => {
      p.push(soup.pos[vi * 3], soup.pos[vi * 3 + 1], soup.pos[vi * 3 + 2])
      if (soup.nor) nn.push(soup.nor[vi * 3], soup.nor[vi * 3 + 1], soup.nor[vi * 3 + 2])
      else nn.push(0, 1, 0)
      if (soup.col) c.push(soup.col[vi * 3], soup.col[vi * 3 + 1], soup.col[vi * 3 + 2])
      else c.push(1, 1, 1)
    }
    if (soup.idx) for (let i = is; i < ie; i++) push(soup.idx[i])
    else for (let i = vs; i < ve; i++) push(i)
    if (p.length < 9) continue
    const s = soup.surf ? soup.surf[vs] : 0
    const f: Frag = {
      p, n: nn, c, surf: s, closed: false,
      core: coreOf(c[0], c[1], c[2]), face: -1, glass,
    }
    f.closed = !glass && isClosed(f)
    out.push(f)
  }
  return out
}

/* ------------------------------------------------------------ measuring -- */

const va = new THREE.Vector3()
const vb = new THREE.Vector3()

/** a closed surface has no net vector area; an open one (a pane, a roof with
    no underside) has a lot of it */
const isClosed = (f: Frag) => {
  let sx = 0
  let sy = 0
  let sz = 0
  let area = 0
  const p = f.p
  for (let i = 0; i < p.length; i += 9) {
    va.set(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2])
    vb.set(p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2])
    va.cross(vb)
    sx += va.x
    sy += va.y
    sz += va.z
    area += va.length()
  }
  return area > 1e-6 && Math.hypot(sx, sy, sz) < area * 0.02
}

export const fragBox = (f: Frag, out = new THREE.Box3()) => {
  out.makeEmpty()
  const p = f.p
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]
    const y = p[i + 1]
    const z = p[i + 2]
    if (x < out.min.x) out.min.x = x
    if (y < out.min.y) out.min.y = y
    if (z < out.min.z) out.min.z = z
    if (x > out.max.x) out.max.x = x
    if (y > out.max.y) out.max.y = y
    if (z > out.max.z) out.max.z = z
  }
  return out
}

/** enclosed volume (closed fragments only) and its centroid, by the
    divergence theorem over the triangles */
const fragVolume = (f: Frag, centroid: THREE.Vector3) => {
  let v = 0
  let cx = 0
  let cy = 0
  let cz = 0
  const p = f.p
  for (let i = 0; i < p.length; i += 9) {
    const d = (
      p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) -
      p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) +
      p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])
    ) / 6
    v += d
    cx += d * (p[i] + p[i + 3] + p[i + 6]) / 4
    cy += d * (p[i + 1] + p[i + 4] + p[i + 7]) / 4
    cz += d * (p[i + 2] + p[i + 5] + p[i + 8]) / 4
  }
  if (Math.abs(v) > 1e-6) centroid.set(cx / v, cy / v, cz / v)
  else {
    const b = fragBox(f, tmpBox)
    b.getCenter(centroid)
  }
  return Math.abs(v)
}
const tmpBox = new THREE.Box3()

/** area-weighted mean normal of a fragment's surface */
const meanNormal = (f: Frag, out: THREE.Vector3) => {
  out.set(0, 0, 0)
  const p = f.p
  for (let i = 0; i < p.length; i += 9) {
    va.set(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2])
    vb.set(p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2])
    out.add(va.cross(vb))
  }
  return out.lengthSq() > 1e-12 ? out.normalize() : out.set(0, 1, 0)
}

const faceOf = (nx: number, ny: number, nz: number) => {
  if (ny > 0.55) return 4
  if (ny < -0.8) return 5
  return Math.abs(nx) >= Math.abs(nz) ? (nx >= 0 ? 0 : 1) : (nz >= 0 ? 2 : 3)
}

/* -------------------------------------------------------------- cutting -- */

/** the unit normal and offset of a plane n.x = d */
export interface Plane {
  nx: number
  ny: number
  nz: number
  d: number
}

const EPS = 1e-5

/** 2D convex hull, Andrew's monotone chain, CCW; points as [u, v, index] */
const hull2 = (pts: Array<[number, number, number]>) => {
  if (pts.length < 3) return pts
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number, number]> = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop()
    lower.push(p)
  }
  const upper: Array<[number, number, number]> = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/**
 * The same hull by gift-wrapping, for the small point sets a face or a cut
 * leaves (a dozen points, a handful on the hull), into scratch buffers: no
 * sort, no tuples, which is most of what taking a tower apart costs.
 * Counter-clockwise; collinear and duplicate points are skipped.
 */
const HU = new Float64Array(256)
const HV = new Float64Array(256)
const HI = new Int32Array(64)
const hullIdx = (n: number) => {
  let s = 0
  for (let i = 1; i < n; i++) {
    if (HU[i] < HU[s] - 1e-9 || (Math.abs(HU[i] - HU[s]) <= 1e-9 && HV[i] < HV[s])) s = i
  }
  let h = 0
  let o = s
  do {
    HI[h++] = o
    let nx = -1
    for (let j = 0; j < n; j++) {
      if (j === o) continue
      const ju = HU[j] - HU[o]
      const jv = HV[j] - HV[o]
      if (ju * ju + jv * jv < 1e-12) continue
      if (nx < 0) {
        nx = j
        continue
      }
      const cu = HU[nx] - HU[o]
      const cv = HV[nx] - HV[o]
      const cr = cu * jv - cv * ju
      // j is to the right of o->nx: it wraps tighter; collinear: the farther
      if (cr < -1e-9 || (Math.abs(cr) <= 1e-9 && ju * ju + jv * jv > cu * cu + cv * cv)) nx = j
    }
    if (nx < 0) break
    o = nx
  } while (o !== s && h < HI.length && h <= n)
  return o === s ? h : 0
}

/**
 * Fill a convex polygon of 3D points lying in plane `n` with a triangle fan
 * whose face looks along `face`, onto the end of `f`, painted `col`. Points
 * arrive unordered; they are projected into the plane and hulled, which is
 * also what throws away the duplicates a cut through a vertex leaves behind.
 */
const capFan = (
  f: Frag, pts: number[], nx: number, ny: number, nz: number,
  fx: number, fy: number, fz: number, col: [number, number, number],
  /** per-point normals and colours to carry instead of (fx, fy, fz) and col */
  srcN?: number[], srcC?: number[],
) => {
  const n = pts.length / 3
  if (n < 3) return
  // an orthonormal basis in the plane
  const ax = Math.abs(nx) < 0.9 ? 1 : 0
  const ay = ax ? 0 : 1
  // u = a x n, normalised; v = n x u
  let ux = ay * nz
  let uy = -ax * nz
  let uz = ax * ny - ay * nx
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul
  uy /= ul
  uz /= ul
  const vx = ny * uz - nz * uy
  const vy = nz * ux - nx * uz
  const vz = nx * uy - ny * ux
  if (n > HU.length) return
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3]
    const y = pts[i * 3 + 1]
    const z = pts[i * 3 + 2]
    HU[i] = x * ux + y * uy + z * uz
    HV[i] = x * vx + y * vy + z * vz
  }
  const hn = hullIdx(n)
  if (hn < 3) return
  // area, to throw away the slivers a grazing cut produces
  let area = 0
  for (let i = 0; i < hn; i++) {
    const a = HI[i]
    const b = HI[(i + 1) % hn]
    area += HU[a] * HV[b] - HU[b] * HV[a]
  }
  if (Math.abs(area) < 1e-4) return
  // the hull comes back counter-clockwise in (u, v); u x v = n, so it faces
  // +n, and a fan that should face the other way is walked backwards
  const back = nx * fx + ny * fy + nz * fz < 0
  const put = (k: number) => {
    const i = HI[k]
    f.p.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])
    if (srcN) f.n.push(srcN[i * 3], srcN[i * 3 + 1], srcN[i * 3 + 2])
    else f.n.push(fx, fy, fz)
    if (srcC) f.c.push(srcC[i * 3], srcC[i * 3 + 1], srcC[i * 3 + 2])
    else f.c.push(col[0], col[1], col[2])
  }
  for (let i = 1; i + 1 < hn; i++) {
    put(0)
    if (back) {
      put(i + 1)
      put(i)
    } else {
      put(i)
      put(i + 1)
    }
  }
}

/**
 * Re-face a fragment: every flat face is gathered back into one convex
 * polygon and re-fanned from the corners it actually has, carrying each
 * corner's own normal and colour. A plane cut leaves each face it crosses as a
 * polygon of up to four corners per source triangle, and a face cut by six
 * planes in a row keeps every sliver of every cut, so without this a storey of
 * wall ends up at thirty times the triangles it started with.
 */
export const simplify = (f: Frag): Frag => {
  const p = f.p
  const groups = new Map<number, number[]>()
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i + 3] - p[i]
    const ay = p[i + 4] - p[i + 1]
    const az = p[i + 5] - p[i + 2]
    const bx = p[i + 6] - p[i]
    const by = p[i + 7] - p[i + 1]
    const bz = p[i + 8] - p[i + 2]
    let cx = ay * bz - az * by
    let cy = az * bx - ax * bz
    let cz = ax * by - ay * bx
    const l = Math.hypot(cx, cy, cz)
    if (l < 1e-9) continue // degenerate: dropped
    cx /= l
    cy /= l
    cz /= l
    const dd = cx * p[i] + cy * p[i + 1] + cz * p[i + 2]
    // a numeric key: 7 bits a normal component, the rest the offset
    const key = ((Math.round(cx * 60) + 64) * 128 + (Math.round(cy * 60) + 64)) * 128 +
      (Math.round(cz * 60) + 64) + Math.round(dd * 16) * 2097152
    let g = groups.get(key)
    if (!g) groups.set(key, (g = []))
    g.push(i)
  }
  const out = emptyLike(f)
  const pts: number[] = []
  const ns: number[] = []
  const cs: number[] = []
  for (const tris of groups.values()) {
    const i0 = tris[0]
    if (tris.length === 1) {
      for (let k = 0; k < 9; k++) {
        out.p.push(p[i0 + k])
        out.n.push(f.n[i0 + k])
        out.c.push(f.c[i0 + k])
      }
      continue
    }
    pts.length = 0
    ns.length = 0
    cs.length = 0
    for (const ti of tris) {
      for (let k = 0; k < 9; k++) {
        pts.push(p[ti + k])
        ns.push(f.n[ti + k])
        cs.push(f.c[ti + k])
      }
    }
    const ax = p[i0 + 3] - p[i0]
    const ay = p[i0 + 4] - p[i0 + 1]
    const az = p[i0 + 5] - p[i0 + 2]
    const bx = p[i0 + 6] - p[i0]
    const by = p[i0 + 7] - p[i0 + 1]
    const bz = p[i0 + 8] - p[i0 + 2]
    let cx = ay * bz - az * by
    let cy = az * bx - ax * bz
    let cz = ax * by - ay * bx
    const l = Math.hypot(cx, cy, cz) || 1
    cx /= l
    cy /= l
    cz /= l
    capFan(out, pts, cx, cy, cz, cx, cy, cz, f.core, ns, cs)
  }
  return out.p.length ? out : f
}

const emptyLike = (f: Frag): Frag => ({
  p: [], n: [], c: [], surf: f.surf, closed: f.closed, core: f.core, face: f.face, glass: f.glass,
})

/**
 * Cut a fragment by a plane: [the part in front (n.x > d), the part behind],
 * either of which may be null. Closed fragments get the cut capped on both
 * halves, in the fragment's core colour, keeping its surface code, so brick
 * that breaks shows brick in the break.
 */
export const splitFrag = (f: Frag, pl: Plane): [Frag | null, Frag | null] => {
  const { nx, ny, nz, d } = pl
  const p = f.p
  // quick reject: every vertex on one side
  let anyF = false
  let anyB = false
  for (let i = 0; i < p.length; i += 3) {
    const s = p[i] * nx + p[i + 1] * ny + p[i + 2] * nz - d
    if (s > EPS) anyF = true
    else if (s < -EPS) anyB = true
    if (anyF && anyB) break
  }
  if (!anyB) return [f, null]
  if (!anyF) return [null, f]

  const front = emptyLike(f)
  const back = emptyLike(f)
  const cut: number[] = []
  const N = f.n
  const C = f.c
  // polygons of up to four corners, nine attributes a corner
  const fp = SPLIT_F
  const bp = SPLIT_B
  const copy = (dst: Float64Array, k: number, vi: number) => {
    const o = k * 9
    dst[o] = p[vi]
    dst[o + 1] = p[vi + 1]
    dst[o + 2] = p[vi + 2]
    dst[o + 3] = N[vi]
    dst[o + 4] = N[vi + 1]
    dst[o + 5] = N[vi + 2]
    dst[o + 6] = C[vi]
    dst[o + 7] = C[vi + 1]
    dst[o + 8] = C[vi + 2]
  }
  const mid = (dst: Float64Array, k: number, a: number, b: number, t: number) => {
    const o = k * 9
    dst[o] = p[a] + (p[b] - p[a]) * t
    dst[o + 1] = p[a + 1] + (p[b + 1] - p[a + 1]) * t
    dst[o + 2] = p[a + 2] + (p[b + 2] - p[a + 2]) * t
    dst[o + 3] = N[a] + (N[b] - N[a]) * t
    dst[o + 4] = N[a + 1] + (N[b + 1] - N[a + 1]) * t
    dst[o + 5] = N[a + 2] + (N[b + 2] - N[a + 2]) * t
    dst[o + 6] = C[a] + (C[b] - C[a]) * t
    dst[o + 7] = C[a + 1] + (C[b + 1] - C[a + 1]) * t
    dst[o + 8] = C[a + 2] + (C[b + 2] - C[a + 2]) * t
  }
  const corner = (dst: Frag, poly: Float64Array, o: number) => {
    dst.p.push(poly[o], poly[o + 1], poly[o + 2])
    dst.n.push(poly[o + 3], poly[o + 4], poly[o + 5])
    dst.c.push(poly[o + 6], poly[o + 7], poly[o + 8])
  }
  const emit = (dst: Frag, poly: Float64Array, n: number) => {
    for (let i = 1; i + 1 < n; i++) {
      corner(dst, poly, 0)
      corner(dst, poly, i * 9)
      corner(dst, poly, (i + 1) * 9)
    }
  }
  const s = [0, 0, 0]
  for (let t = 0; t < p.length; t += 9) {
    for (let i = 0; i < 3; i++) {
      const o = t + i * 3
      s[i] = p[o] * nx + p[o + 1] * ny + p[o + 2] * nz - d
    }
    let nf = 0
    let nb = 0
    for (let i = 0; i < 3; i++) {
      const a = t + i * 3
      const j = (i + 1) % 3
      const b = t + j * 3
      const sa = s[i]
      const sb = s[j]
      if (sa >= -EPS) copy(fp, nf++, a)
      if (sa <= EPS) copy(bp, nb++, a)
      if (Math.abs(sa) <= EPS) cut.push(p[a], p[a + 1], p[a + 2])
      if ((sa > EPS && sb < -EPS) || (sa < -EPS && sb > EPS)) {
        const k = sa / (sa - sb)
        mid(fp, nf++, a, b, k)
        mid(bp, nb++, a, b, k)
        cut.push(fp[(nf - 1) * 9], fp[(nf - 1) * 9 + 1], fp[(nf - 1) * 9 + 2])
      }
    }
    if (nf >= 3) emit(front, fp, nf)
    if (nb >= 3) emit(back, bp, nb)
  }
  if (f.closed && cut.length >= 9) {
    capFan(front, cut, nx, ny, nz, -nx, -ny, -nz, f.core)
    capFan(back, cut, nx, ny, nz, nx, ny, nz, f.core)
  }
  return [front.p.length ? front : null, back.p.length ? back : null]
}
const SPLIT_F = new Float64Array(4 * 9)
const SPLIT_B = new Float64Array(4 * 9)

/* ------------------------------------------------------------ hollowing -- */

/** round a coordinate onto a key; faces and edges are matched by position,
    because a stamp's faces do not share vertices */
const q = (x: number) => Math.round(x * 64)

/**
 * A volumetric stamp as a shell of slabs, one per face (bottoms and buried
 * faces dropped). The inner surface is the stamp scaled inward about its own
 * box, walls in by `t` and the top down by `tTop`, so two neighbouring slabs
 * meet on the mitre between their outer and inner edges rather than
 * overlapping in the corner, which matters the moment one of them is a
 * physics body and the other is still a static wall.
 */
const hollow = (f: Frag, t: number, tTop: number, buried: (x: number, y: number, z: number) => boolean) => {
  const b = fragBox(f, new THREE.Box3())
  const ex = b.max.x - b.min.x
  const ey = b.max.y - b.min.y
  const ez = b.max.z - b.min.z
  const cx = (b.min.x + b.max.x) / 2
  const cz = (b.min.z + b.max.z) / 2
  const y0 = b.min.y
  const sx = Math.max(0.15, 1 - (2 * t) / ex)
  const sz = Math.max(0.15, 1 - (2 * t) / ez)
  const sy = Math.max(0.15, 1 - tTop / ey)
  const inner = (x: number, y: number, z: number) =>
    [cx + (x - cx) * sx, y0 + (y - y0) * sy, cz + (z - cz) * sz]
  // plaster inside: a pale warm grey, lit like any wall once it is exposed
  const plaster: [number, number, number] = [0.42, 0.39, 0.34]

  // triangles grouped into faces by plane
  const faces = new Map<string, number[]>()
  const p = f.p
  const nrm = new THREE.Vector3()
  for (let i = 0; i < p.length; i += 9) {
    va.set(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2])
    vb.set(p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2])
    nrm.copy(va.cross(vb))
    if (nrm.lengthSq() < 1e-12) continue
    nrm.normalize()
    const dd = nrm.x * p[i] + nrm.y * p[i + 1] + nrm.z * p[i + 2]
    const key = `${Math.round(nrm.x * 40)},${Math.round(nrm.y * 40)},${Math.round(nrm.z * 40)},${Math.round(dd * 8)}`
    let list = faces.get(key)
    if (!list) faces.set(key, (list = []))
    list.push(i)
  }

  const slabs: Frag[] = []
  for (const tris of faces.values()) {
    const i0 = tris[0]
    va.set(p[i0 + 3] - p[i0], p[i0 + 4] - p[i0 + 1], p[i0 + 5] - p[i0 + 2])
    vb.set(p[i0 + 6] - p[i0], p[i0 + 7] - p[i0 + 1], p[i0 + 8] - p[i0 + 2])
    const fn = va.cross(vb).normalize().clone()
    if (fn.y < -0.7) continue
    // buried: every corner of the face inside another shell
    let allIn = true
    for (const ti of tris) {
      for (let k = 0; k < 3 && allIn; k++) {
        if (!buried(p[ti + k * 3], p[ti + k * 3 + 1], p[ti + k * 3 + 2])) allIn = false
      }
      if (!allIn) break
    }
    if (allIn) continue

    const s: Frag = {
      p: [], n: [], c: [], surf: f.surf, closed: true, core: f.core,
      face: faceOf(fn.x, fn.y, fn.z), glass: false,
    }
    // the outside, exactly as it was drawn
    for (const ti of tris) {
      for (let k = 0; k < 9; k++) {
        s.p.push(p[ti + k])
        s.n.push(f.n[ti + k])
        s.c.push(f.c[ti + k])
      }
    }
    // the inside, the same triangles on the shrunken stamp, wound the other
    // way and facing in
    for (const ti of tris) {
      const A = inner(p[ti], p[ti + 1], p[ti + 2])
      const B = inner(p[ti + 3], p[ti + 4], p[ti + 5])
      const C = inner(p[ti + 6], p[ti + 7], p[ti + 8])
      s.p.push(...A, ...C, ...B)
      for (let k = 0; k < 3; k++) {
        s.n.push(-fn.x, -fn.y, -fn.z)
        s.c.push(...plaster)
      }
    }
    // the rim: every edge of the face used by one triangle only
    const edges = new Map<string, [number, number, number, number, number, number, number]>()
    for (const ti of tris) {
      for (let k = 0; k < 3; k++) {
        const a = ti + k * 3
        const bb = ti + ((k + 1) % 3) * 3
        const ka = `${q(p[a])},${q(p[a + 1])},${q(p[a + 2])}`
        const kb = `${q(p[bb])},${q(p[bb + 1])},${q(p[bb + 2])}`
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
        const have = edges.get(key)
        if (have) have[6]++
        else edges.set(key, [p[a], p[a + 1], p[a + 2], p[bb], p[bb + 1], p[bb + 2], 1])
      }
    }
    // the face's centre, to point each rim quad away from
    let mx = 0
    let my = 0
    let mz = 0
    for (let k = 0; k < s.p.length; k += 3) {
      mx += s.p[k]
      my += s.p[k + 1]
      mz += s.p[k + 2]
    }
    const nv = s.p.length / 3
    mx /= nv
    my /= nv
    mz /= nv
    for (const e of edges.values()) {
      if (e[6] !== 1) continue
      const A = [e[0], e[1], e[2]]
      const B = [e[3], e[4], e[5]]
      const A2 = inner(e[0], e[1], e[2])
      const B2 = inner(e[3], e[4], e[5])
      va.set(B[0] - A[0], B[1] - A[1], B[2] - A[2])
      vb.set(B2[0] - A[0], B2[1] - A[1], B2[2] - A[2])
      const qn = va.cross(vb)
      if (qn.lengthSq() < 1e-10) continue
      qn.normalize()
      const ox = (A[0] + B[0]) / 2 - mx
      const oy = (A[1] + B[1]) / 2 - my
      const oz = (A[2] + B[2]) / 2 - mz
      const flip = qn.x * ox + qn.y * oy + qn.z * oz < 0
      if (flip) qn.negate()
      const quad = flip ? [A, B2, B, A, A2, B2] : [A, B, B2, A, B2, A2]
      for (const v of quad) {
        s.p.push(v[0], v[1], v[2])
        s.n.push(qn.x, qn.y, qn.z)
        s.c.push(f.core[0], f.core[1], f.core[2])
      }
    }
    slabs.push(s)
  }
  return slabs
}

/** the stamp's cross-section at height y, as points in that plane */
const sectionAt = (f: Frag, y: number) => {
  const pts: number[] = []
  const p = f.p
  for (let i = 0; i < p.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const a = i + k * 3
      const b = i + ((k + 1) % 3) * 3
      const sa = p[a + 1] - y
      const sb = p[b + 1] - y
      if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
        const t = sa / (sa - sb)
        pts.push(p[a] + (p[b] - p[a]) * t, y, p[a + 2] + (p[b + 2] - p[a + 2]) * t)
      }
    }
  }
  return pts
}

const CONCRETE: [number, number, number] = [0.3, 0.29, 0.27]

/** a horizontal slab under the polygon `pts` (points at height y), from
    y - th up to y, shrunk about its centre by (sx, sz) */
const slabFrom = (pts: number[], y: number, th: number, sx: number, sz: number): Frag | null => {
  if (pts.length < 9) return null
  let cx = 0
  let cz = 0
  const n = pts.length / 3
  for (let i = 0; i < n; i++) {
    cx += pts[i * 3]
    cz += pts[i * 3 + 2]
  }
  cx /= n
  cz /= n
  const h = hull2(Array.from({ length: n }, (_, i) =>
    [cx + (pts[i * 3] - cx) * sx, cz + (pts[i * 3 + 2] - cz) * sz, i] as [number, number, number]))
  if (h.length < 3) return null
  const f: Frag = {
    p: [], n: [], c: [], surf: SURF.paving, closed: true,
    core: [CONCRETE[0] * 0.8, CONCRETE[1] * 0.8, CONCRETE[2] * 0.8], face: 5, glass: false,
  }
  const top = h.map((v) => [v[0], y, v[1]])
  const bot = h.map((v) => [v[0], y - th, v[1]])
  const tri = (a: number[], b: number[], c: number[], nx: number, ny: number, nz: number) => {
    // wind to face (nx, ny, nz)
    va.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    vb.set(c[0] - a[0], c[1] - a[1], c[2] - a[2])
    va.cross(vb)
    const flip = va.x * nx + va.y * ny + va.z * nz < 0
    f.p.push(...a, ...(flip ? c : b), ...(flip ? b : c))
    for (let k = 0; k < 3; k++) {
      f.n.push(nx, ny, nz)
      f.c.push(...CONCRETE)
    }
  }
  for (let i = 1; i + 1 < top.length; i++) {
    tri(top[0], top[i], top[i + 1], 0, 1, 0)
    tri(bot[0], bot[i], bot[i + 1], 0, -1, 0)
  }
  for (let i = 0; i < top.length; i++) {
    const j = (i + 1) % top.length
    const ex = top[j][0] - top[i][0]
    const ez = top[j][2] - top[i][2]
    const l = Math.hypot(ex, ez) || 1
    // outward in a CCW (u = x, v = z) hull is (ez, -ex)... either way, the
    // winder above checks it against the centre
    let nx = ez / l
    let nz = -ex / l
    const mx = (top[i][0] + top[j][0]) / 2 - cx
    const mz = (top[i][2] + top[j][2]) / 2 - cz
    if (nx * mx + nz * mz < 0) {
      nx = -nx
      nz = -nz
    }
    tri(top[i], top[j], bot[j], nx, 0, nz)
    tri(top[i], bot[j], bot[i], nx, 0, nz)
  }
  return f
}

/* ------------------------------------------------------------ the build -- */

const CELL_MIN = 5
const CELL_MAX = 9

/**
 * Take one recorded building apart: read its stamps out of the chunk's
 * merged geometry, hollow and floor it, cut it into cells, and hand back the
 * pieces and one rebuilt geometry per layer with every piece contiguous.
 */
export const fractureStructure = (
  rec: StructureRec,
  detailGeo: THREE.BufferGeometry | null,
  glassGeo: THREE.BufferGeometry | null,
): Fractured | null => {
  const it = fractureSteps(rec, detailGeo, glassGeo, Infinity)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

/**
 * The same, a slice at a time: a generator that yields whenever it has spent
 * `budgetMs` since it was last resumed, so taking a tower apart (ten to
 * forty milliseconds, most of it in the cutting) can be spread across a few
 * frames instead of landing in the one the blast is drawn in. Resume it with
 * `next()` each frame; its return value is the fractured building.
 */
export function* fractureSteps(
  rec: StructureRec,
  detailGeo: THREE.BufferGeometry | null,
  glassGeo: THREE.BufferGeometry | null,
  budgetMs: number,
): Generator<void, Fractured | null, void> {
  let slice = performance.now()
  if (!rec.det || !detailGeo) return null
  const raw = readStamps(soupOf(detailGeo), rec.det, rec.marks, false)
  if (rec.gl && glassGeo) raw.push(...readStamps(soupOf(glassGeo), rec.gl, rec.gmarks, true))
  if (!raw.length) return null

  const H = rec.storeyH
  // which stamps enclose a room
  const boxes = raw.map((f) => fragBox(f, new THREE.Box3()))
  const shells: number[] = []
  raw.forEach((f, i) => {
    const b = boxes[i]
    if (f.glass) return
    if (b.max.x - b.min.x >= 3 && b.max.z - b.min.z >= 3 && b.max.y - b.min.y >= 0.4) shells.push(i)
  })
  const all = new THREE.Box3()
  for (const b of boxes) all.union(b)
  const body = new THREE.Box3()
  for (const i of shells) body.union(boxes[i])
  if (body.isEmpty()) body.copy(all)
  const plan = Math.min(body.max.x - body.min.x, body.max.z - body.min.z)
  const T = Math.min(0.85, Math.max(0.45, plan * 0.045))

  /** inside another shell by half a unit or more */
  const buriedIn = (self: number) => (x: number, y: number, z: number) => {
    for (const j of shells) {
      if (j === self) continue
      const b = boxes[j]
      if (x > b.min.x - 0.5 && x < b.max.x + 0.5 && z > b.min.z - 0.5 && z < b.max.z + 0.5 &&
        y > b.min.y + 0.05 && y < b.max.y - 0.05) return true
    }
    return false
  }

  let frags: Frag[] = []
  const shellSet = new Set(shells)
  raw.forEach((f, i) => {
    if (!shellSet.has(i)) {
      frags.push(f)
      return
    }
    const ey = boxes[i].max.y - boxes[i].min.y
    frags.push(...hollow(f, T, Math.min(T, ey * 0.45), buriedIn(i)))
  })

  // floors at every storey line of every shell tall enough to have storeys
  const floors: Array<{ y: number; box: THREE.Box3 }> = []
  const bySize = [...shells].sort((a, b) => {
    const A = boxes[a]
    const B = boxes[b]
    return (B.max.x - B.min.x) * (B.max.z - B.min.z) - (A.max.x - A.min.x) * (A.max.z - A.min.z)
  })
  for (const i of bySize) {
    const b = boxes[i]
    if (b.max.y - b.min.y < H * 1.5) continue
    const ex = b.max.x - b.min.x
    const ez = b.max.z - b.min.z
    for (let k = 1; ; k++) {
      const y = rec.baseY + k * H
      if (y > b.max.y - 1.2) break
      if (y < b.min.y + 1) continue
      const cx = (b.min.x + b.max.x) / 2
      const cz = (b.min.z + b.max.z) / 2
      if (floors.some((f) => Math.abs(f.y - y) < 0.5 && cx > f.box.min.x && cx < f.box.max.x &&
        cz > f.box.min.z && cz < f.box.max.z)) continue
      const slab = slabFrom(sectionAt(raw[i], y), y, 0.45,
        Math.max(0.1, 1 - (2 * T) / ex), Math.max(0.1, 1 - (2 * T) / ez))
      if (!slab) continue
      frags.push(slab)
      floors.push({ y, box: fragBox(slab, new THREE.Box3()) })
    }
  }

  if (performance.now() - slice > budgetMs) {
    yield
    slice = performance.now()
  }
  // the grid: storey lines (paired on a tall building) and plan cells
  const top = all.max.y
  const storeys = Math.max(1, Math.round((top - rec.baseY) / H))
  const binH = H * (storeys > 8 ? 2 : 1)
  const ny = Math.max(1, Math.ceil((top - rec.baseY + 0.5) / binH))
  const ex = body.max.x - body.min.x
  const ez = body.max.z - body.min.z
  const cellOf = (e: number) => Math.min(CELL_MAX, Math.max(CELL_MIN, e / 5))
  const nx = Math.max(1, Math.round(ex / cellOf(ex)))
  const nz = Math.max(1, Math.round(ez / cellOf(ez)))
  const planes: Plane[] = []
  for (let i = 1; i < nx; i++) planes.push({ nx: 1, ny: 0, nz: 0, d: body.min.x + (i * ex) / nx })
  for (let i = 1; i < nz; i++) planes.push({ nx: 0, ny: 0, nz: 1, d: body.min.z + (i * ez) / nz })
  // a storey's cut sits half a unit under its floor, so the slab belongs to
  // the storey it is the floor of
  for (let k = 1; k < ny; k++) planes.push({ nx: 0, ny: 1, nz: 0, d: rec.baseY + k * binH - 0.5 })

  const fb = new THREE.Box3()
  const DBG = (globalThis as unknown as { __fracDbg?: number[] }).__fracDbg
  if (DBG) DBG.push(performance.now())
  // each fragment goes through the planes it straddles and no others, and
  // only what was actually cut is re-faced, once, at the end of its run
  const done: Frag[] = []
  const cutBy = (f: Frag, from: number, cut: boolean) => {
    const b = fragBox(f, new THREE.Box3())
    for (let k = from; k < planes.length; k++) {
      const pl = planes[k]
      const lo = pl.nx ? b.min.x : pl.ny ? b.min.y : b.min.z
      const hi = pl.nx ? b.max.x : pl.ny ? b.max.y : b.max.z
      if (hi <= pl.d + EPS || lo >= pl.d - EPS) continue
      const [fa, fb2] = splitFrag(f, pl)
      // a fragment still on its way through several planes is re-faced as it
      // goes once it has fragmented, or every later cut pays for every
      // sliver the earlier ones left
      if (fa) cutBy(fa.p.length > 216 ? simplify(fa) : fa, k + 1, true)
      if (fb2) cutBy(fb2.p.length > 216 ? simplify(fb2) : fb2, k + 1, true)
      return
    }
    done.push(cut ? simplify(f) : f)
  }
  for (const f of frags) {
    cutBy(f, 0, false)
    if (performance.now() - slice > budgetMs) {
      yield
      slice = performance.now()
    }
  }
  frags = done

  if (DBG) DBG.push(performance.now())
  if (DBG) DBG.push(performance.now())
  // pieces: one per cell and facing
  const cx0 = (body.min.x + body.max.x) / 2
  const cz0 = (body.min.z + body.max.z) / 2
  const groups = new Map<number, Frag[]>()
  const cen = new THREE.Vector3()
  const mn = new THREE.Vector3()
  const cells = new Map<number, number[]>()
  for (const f of frags) {
    fragBox(f, fb)
    fb.getCenter(cen)
    const ix = Math.min(nx - 1, Math.max(0, Math.floor(((cen.x - body.min.x) / ex) * nx)))
    const iz = Math.min(nz - 1, Math.max(0, Math.floor(((cen.z - body.min.z) / ez) * nz)))
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((cen.y - rec.baseY + 0.5) / binH)))
    let face = f.face
    if (face < 0) {
      if (f.closed) {
        // a trim, a sill, a chimney: it belongs to whichever wall it is out
        // beside, which is the direction from the building's middle
        const dx = cen.x - cx0
        const dz = cen.z - cz0
        const fy = fb.min.y > body.max.y - 0.3 ? 4 : -1
        face = fy >= 0 ? fy : Math.abs(dx) / ex >= Math.abs(dz) / ez ? (dx >= 0 ? 0 : 1) : (dz >= 0 ? 2 : 3)
      } else {
        meanNormal(f, mn)
        face = faceOf(mn.x, mn.y, mn.z)
        if (face === 5) face = 4
      }
    }
    const cell = (iy * nx + ix) * nz + iz
    const key = cell * 6 + face
    let g = groups.get(key)
    if (!g) {
      groups.set(key, (g = []))
      let c = cells.get(cell)
      if (!c) cells.set(cell, (c = []))
      c.push(key)
    }
    g.push(f)
  }
  // a pane or a trim alone in its cell's facing is not a piece; it goes with
  // whatever solid shares its cell
  for (const keys of cells.values()) {
    const solidKeys = keys.filter((k) => groups.get(k)!.some((f) => f.closed && !f.glass))
    if (!solidKeys.length) continue
    for (const k of keys) {
      if (solidKeys.includes(k)) continue
      const face = k % 6
      const home = solidKeys.find((s) => s % 6 === face) ?? solidKeys[0]
      groups.get(home)!.push(...groups.get(k)!)
      groups.delete(k)
    }
  }

  const keys = [...groups.keys()].sort((a, b) => a - b)
  const pieces: Piece[] = []
  let dCount = 0
  let gCount = 0
  for (const key of keys) {
    const fl = groups.get(key)!
    const face = key % 6
    const cell = Math.floor(key / 6)
    const iz = cell % nz
    const ix = Math.floor(cell / nz) % nx
    const iy = Math.floor(cell / (nz * nx))
    const min = new THREE.Vector3(Infinity, Infinity, Infinity)
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    let vol = 0
    const center = new THREE.Vector3()
    let dv = 0
    let gv = 0
    for (const f of fl) {
      fragBox(f, fb)
      min.min(fb.min)
      max.max(fb.max)
      if (f.glass) gv += f.p.length / 3
      else dv += f.p.length / 3
      if (f.closed) {
        const v = fragVolume(f, cen)
        vol += v
        center.addScaledVector(cen, v)
      }
    }
    if (vol > 1e-6) center.multiplyScalar(1 / vol)
    else center.addVectors(min, max).multiplyScalar(0.5)
    // a piece of open surface only still weighs something
    vol = Math.max(vol, 0.05 * (max.x - min.x + max.y - min.y + max.z - min.z))
    // a wall is anything standing that carries: a hollowed face, or a solid
    // stamp over a metre tall (the enterable shop's walls are stamped thin
    // and are never hollowed, and they carry its roof all the same)
    const kind: PieceKind = face === 5 ? 'floor' : face === 4 ? 'roof'
      : fl.some((f) => f.closed && !f.glass && (f.face >= 0 || fragBox(f, fb).max.y - fb.min.y > 1.2))
        ? 'wall' : 'misc'
    pieces.push({
      key, kind, ix, iy, iz, min, max, center, vol,
      d: dv ? [dCount, dv] : null,
      g: gv ? [gCount, gv] : null,
      frags: fl, under: [], side: [], over: [],
      grounded: min.y <= rec.baseY + 0.45,
    })
    dCount += dv
    gCount += gv
  }

  if (performance.now() - slice > budgetMs) {
    yield
    slice = performance.now()
  }
  if (DBG) DBG.push(performance.now())
  const detail = buildGeometry(pieces, false, dCount)
  const glass = gCount ? buildGeometry(pieces, true, gCount) : null
  if (DBG) DBG.push(performance.now())
  if (performance.now() - slice > budgetMs) yield
  linkSupports(pieces)
  // whatever the graph cannot explain standing at rest (a rooftop plant
  // room bedded into a parapet the box test misses, a sign on a bracket) is
  // taken to be fixed where it is: the first knock on a building must not
  // drop pieces that nothing touched
  for (const i of unsupported(pieces, () => true)) pieces[i].grounded = true
  if (DBG) DBG.push(performance.now())
  return {
    rec, pieces, detail, glass,
    min: all.min.clone(), max: all.max.clone(), ny, binH, y0: rec.baseY,
  }
}

/* -------------------------------------------------------------- output -- */

/** write fragments into a fresh geometry with the chunk soup's attribute
    layout, in rest-world coordinates */
export const fragsToGeometry = (frags: Frag[], count?: number) => {
  let n = count ?? 0
  if (count === undefined) for (const f of frags) n += f.p.length / 3
  const pos = new Float32Array(n * 3)
  const nor = new Float32Array(n * 3)
  const col = new Float32Array(n * 3)
  const surf = new Float32Array(n)
  let o = 0
  for (const f of frags) {
    pos.set(f.p, o * 3)
    nor.set(f.n, o * 3)
    col.set(f.c, o * 3)
    surf.fill(f.surf, o, o + f.p.length / 3)
    o += f.p.length / 3
  }
  return finishGeometry(pos, nor, col, surf, n)
}

const finishGeometry = (
  pos: Float32Array, nor: Float32Array, col: Float32Array, surf: Float32Array, n: number,
) => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 1))
  // nothing here sways, and nothing is arriving: see debris.ts's cut()
  g.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(n), 1))
  g.setAttribute('aBirth', new THREE.BufferAttribute(new Float32Array(n).fill(PREBORN), 1))
  g.computeBoundingSphere()
  return g
}

const buildGeometry = (pieces: Piece[], glass: boolean, n: number) => {
  const frags: Frag[] = []
  for (const pc of pieces) for (const f of pc.frags) if (f.glass === glass) frags.push(f)
  return fragsToGeometry(frags, n)
}

/** a piece's (or a cluster's) own geometry, detail only: a piece that
    leaves the building leaves its glass behind as a burst of shards */
export const piecesGeometry = (list: Piece[]) => {
  const frags: Frag[] = []
  for (const pc of list) for (const f of pc.frags) if (!f.glass) frags.push(f)
  return frags.length ? fragsToGeometry(frags) : null
}

/**
 * The points a convex collider is hulled from, relative to `o`: each
 * fragment's vertices, rounded onto a 1/16 grid and deduplicated, and pulled a
 * hair toward the middle so a piece born touching its neighbours is not born
 * inside them.
 */
export const hullPoints = (frags: Frag[], o: THREE.Vector3, shrink = 0.04) => {
  const seen = new Set<string>()
  const pts: number[] = []
  const b = new THREE.Box3()
  for (const f of frags) if (!f.glass) b.union(fragBox(f, tmpBox))
  const c = b.getCenter(new THREE.Vector3())
  for (const f of frags) {
    if (f.glass) continue
    const p = f.p
    for (let i = 0; i < p.length; i += 3) {
      const key = `${Math.round(p[i] * 16)},${Math.round(p[i + 1] * 16)},${Math.round(p[i + 2] * 16)}`
      if (seen.has(key)) continue
      seen.add(key)
      const x = p[i] + Math.sign(c.x - p[i]) * shrink
      const y = p[i + 1] + Math.sign(c.y - p[i + 1]) * shrink
      const z = p[i + 2] + Math.sign(c.z - p[i + 2]) * shrink
      pts.push(x - o.x, y - o.y, z - o.z)
    }
  }
  return pts
}

/* ---------------------------------------------------------- the graph -- */

/**
 * What rests on what. A piece rests on anything whose top meets its bottom
 * with their plans overlapping or touching (touching counts: a floor sits
 * *inside* the walls around it, so their plans only ever share an edge);
 * pieces whose heights overlap and whose plans touch are bonded side by side.
 */
const linkSupports = (pieces: Piece[]) => {
  const G = 0.3
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i]
    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j]
      if (a.max.x < b.min.x - G || b.max.x < a.min.x - G) continue
      if (a.max.z < b.min.z - G || b.max.z < a.min.z - G) continue
      const ha = a.max.y - a.min.y
      const hb = b.max.y - b.min.y
      // b on a: a starts lower and reaches b's foot (or past it: a vent
      // bedded into a barrel roof still sits on the roof)
      if (a.min.y < b.min.y - 0.1 && a.max.y > b.min.y - 0.7) {
        b.under.push(i)
        a.over.push(j)
        continue
      }
      if (b.min.y < a.min.y - 0.1 && b.max.y > a.min.y - 0.7) {
        a.under.push(j)
        b.over.push(i)
        continue
      }
      const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y)
      if (oy > 0.3 * Math.min(ha, hb)) {
        a.side.push(j)
        b.side.push(i)
      }
    }
  }
}

/** how many sideways bonds a piece of each kind may hang from before it is
    not held up at all: a wall panel spans two bays, a floor three */
const REACH: Record<PieceKind, number> = { wall: 2, floor: 3, roof: 3, misc: 1 }

/**
 * Which of the still-standing pieces are still held up. A piece is held if it
 * is on the ground, if it rests on a held piece, or if it hangs off held
 * neighbours by no more than its kind's reach in sideways bonds (the count
 * starts again at every piece that rests on something, so a plant room on a
 * roof is as held as the roof). `alive` says which are still standing;
 * returns the ones that are not held.
 */
export const unsupported = (pieces: Piece[], alive: (i: number) => boolean) => {
  const FAR = 1 << 20
  const dist = new Int32Array(pieces.length).fill(FAR)
  const queue: number[] = []
  for (let i = 0; i < pieces.length; i++) {
    if (alive(i) && pieces[i].grounded) {
      dist[i] = 0
      queue.push(i)
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]
    const d = dist[i]
    for (const j of pieces[i].over) {
      if (!alive(j) || dist[j] <= 0) continue
      dist[j] = 0
      queue.push(j)
    }
    for (const j of pieces[i].side) {
      if (!alive(j) || dist[j] <= d + 1 || d + 1 > REACH[pieces[j].kind]) continue
      dist[j] = d + 1
      queue.push(j)
    }
  }
  const out: number[] = []
  for (let i = 0; i < pieces.length; i++) if (alive(i) && dist[i] === FAR) out.push(i)
  return out
}

/* ------------------------------------------------------------ shatter -- */

/** volume, centre of mass and bounds of a set of fragments (glass ignored);
    open surfaces weigh a little, as a piece of them does */
export const massOf = (frags: Frag[]) => {
  const box = new THREE.Box3()
  const center = new THREE.Vector3()
  const c = new THREE.Vector3()
  let vol = 0
  for (const f of frags) {
    if (f.glass) continue
    box.union(fragBox(f, tmpBox))
    if (!f.closed) continue
    const v = fragVolume(f, c)
    vol += v
    center.addScaledVector(c, v)
  }
  if (vol > 1e-6) center.multiplyScalar(1 / vol)
  else if (!box.isEmpty()) box.getCenter(center)
  if (!box.isEmpty()) {
    const e = box.getSize(c)
    vol = Math.max(vol, 0.05 * (e.x + e.y + e.z))
  }
  return { vol, center, box }
}

/**
 * Break one piece's fragments into `n` chunks along Voronoi cells: `n` seed
 * points scattered through it, and every cell cut out by the bisecting planes
 * to the other seeds. Closed fragments are capped at every cut with the
 * stamp's core colour and its surface code, which is what makes a broken
 * brick wall show brick in the break. A thin panel's seeds sit on its middle
 * plane with only a little lean, so the cuts run *through* the panel, the way
 * a wall breaks, rather than peeling it into skins. Glass is not cut: a pane
 * leaves as shards (the sandbox's fx). Deterministic in `seed`.
 */
export const shatterFrags = (frags: Frag[], seed: number, n: number): Frag[][] => {
  const solid = frags.filter((f) => !f.glass)
  if (n < 2 || !solid.length) return [solid]
  const box = new THREE.Box3()
  for (const f of solid) box.union(fragBox(f, tmpBox))
  const size = box.getSize(new THREE.Vector3())
  const mid = box.getCenter(new THREE.Vector3())
  const rnd = seeded(seed >>> 0)
  // which axis is thin: that coordinate stays near the middle
  const thin = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2
  const seeds: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector3(
      box.min.x + size.x * (0.12 + 0.76 * rnd()),
      box.min.y + size.y * (0.12 + 0.76 * rnd()),
      box.min.z + size.z * (0.12 + 0.76 * rnd()),
    )
    const k = 0.15 * (rnd() - 0.5)
    if (thin === 0) p.x = mid.x + size.x * k
    else if (thin === 1) p.y = mid.y + size.y * k
    else p.z = mid.z + size.z * k
    seeds.push(p)
  }
  const out: Frag[][] = []
  const pl: Plane = { nx: 0, ny: 0, nz: 0, d: 0 }
  for (let i = 0; i < n; i++) {
    let cell = solid
    for (let j = 0; j < n && cell.length; j++) {
      if (j === i) continue
      const a = seeds[i]
      const b = seeds[j]
      let nx = b.x - a.x
      let ny = b.y - a.y
      let nz = b.z - a.z
      const l = Math.hypot(nx, ny, nz)
      if (l < 1e-4) continue
      nx /= l
      ny /= l
      nz /= l
      pl.nx = nx
      pl.ny = ny
      pl.nz = nz
      pl.d = (nx * (a.x + b.x) + ny * (a.y + b.y) + nz * (a.z + b.z)) / 2
      const next: Frag[] = []
      for (const f of cell) {
        const back = splitFrag(f, pl)[1]
        if (back) next.push(back)
      }
      cell = next
    }
    if (cell.length) out.push(cell.map((f) => (f.p.length > 72 ? simplify(f) : f)))
  }
  return out.length ? out : [solid]
}

/** the corners of a set of pieces' boxes relative to `o`: a cheap, honest
    convex collider for a cluster of them falling as one */
export const cornerPoints = (pieces: Piece[], o: THREE.Vector3, shrink = 0.05) => {
  const pts: number[] = []
  for (const pc of pieces) {
    for (let k = 0; k < 8; k++) {
      pts.push(
        (k & 1 ? pc.max.x - shrink : pc.min.x + shrink) - o.x,
        (k & 2 ? pc.max.y - shrink : pc.min.y + shrink) - o.y,
        (k & 4 ? pc.max.z - shrink : pc.min.z + shrink) - o.z,
      )
    }
  }
  return pts
}

/* ---------------------------------------------------------- the break -- */

/**
 * Knock corners off a piece: `n` planes slanted across random corners of its
 * box, keeping the side toward its middle, each cut capped in the stamp's
 * core colour. A panel lifted out of a building is a clean rectangle of the
 * cell grid; chipped, its outline is a broken one. Deterministic in `seed`.
 */
export const chipFrags = (frags: Frag[], seed: number, n: number): Frag[] => {
  const solid = frags.filter((f) => !f.glass)
  if (!solid.length || n < 1) return solid
  const box = new THREE.Box3()
  for (const f of solid) box.union(fragBox(f, tmpBox))
  const c = box.getCenter(new THREE.Vector3())
  const e = box.getSize(new THREE.Vector3()).multiplyScalar(0.5)
  const rnd = seeded(seed >>> 0)
  let out = solid
  const pl: Plane = { nx: 0, ny: 0, nz: 0, d: 0 }
  for (let k = 0; k < n; k++) {
    // a corner, and a plane across it facing out of it (jittered)
    const sx = rnd() < 0.5 ? -1 : 1
    const sy = rnd() < 0.5 ? -1 : 1
    const sz = rnd() < 0.5 ? -1 : 1
    let nx = sx / Math.max(0.2, e.x) * (0.7 + rnd() * 0.6)
    let ny = sy / Math.max(0.2, e.y) * (0.7 + rnd() * 0.6)
    let nz = sz / Math.max(0.2, e.z) * (0.7 + rnd() * 0.6)
    const l = Math.hypot(nx, ny, nz)
    nx /= l
    ny /= l
    nz /= l
    // how deep into the corner: the support distance times a share
    const reach = Math.abs(nx) * e.x + Math.abs(ny) * e.y + Math.abs(nz) * e.z
    pl.nx = nx
    pl.ny = ny
    pl.nz = nz
    pl.d = nx * c.x + ny * c.y + nz * c.z + reach * (0.45 + rnd() * 0.3)
    const next: Frag[] = []
    for (const f of out) {
      const back = splitFrag(f, pl)[1]
      if (back) next.push(back.p.length > 72 ? simplify(back) : back)
    }
    if (next.length) out = next
  }
  return out
}

const stick = (
  x: number, y: number, z: number, dx: number, dy: number, dz: number,
  len: number, w: number, h: number, col: [number, number, number], surf: number,
): Frag => {
  const g = new THREE.BoxGeometry(w, h, len).toNonIndexed()
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dx, dy, dz).normalize())
  m.compose(new THREE.Vector3(x + dx * len * 0.35, y + dy * len * 0.35, z + dz * len * 0.35), q, new THREE.Vector3(1, 1, 1))
  g.applyMatrix4(m)
  const p = Array.from(g.getAttribute('position').array as Float32Array)
  const nn = Array.from(g.getAttribute('normal').array as Float32Array)
  g.dispose()
  const c: number[] = []
  for (let i = 0; i < p.length / 3; i++) c.push(col[0], col[1], col[2])
  return { p, n: nn, c, surf, closed: true, core: col, face: -1, glass: false }
}

/**
 * What sticks out of a break: bent rebar out of concrete and brick (grade 1
 * and up), splintered joists and battens out of a timber and render house.
 * Drawn only (the collider is the piece's own hull), a few sticks along the
 * piece's thin edges pointing out of them, which is where it broke.
 */
export const breakDecor = (frags: Frag[], seed: number, grade: number, count: number): Frag[] => {
  const box = new THREE.Box3()
  for (const f of frags) if (!f.glass) box.union(fragBox(f, tmpBox))
  if (box.isEmpty() || count < 1) return []
  const size = box.getSize(new THREE.Vector3())
  const c = box.getCenter(new THREE.Vector3())
  const rnd = seeded(seed >>> 0)
  // the thin axis; sticks come out of the other two
  const thin = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2
  const out: Frag[] = []
  for (let k = 0; k < count; k++) {
    let axis = Math.floor(rnd() * 3)
    if (axis === thin) axis = (axis + 1) % 3
    const s = rnd() < 0.5 ? -1 : 1
    const p = [c.x, c.y, c.z]
    const half = [size.x / 2, size.y / 2, size.z / 2]
    for (let a = 0; a < 3; a++) {
      if (a === axis) p[a] += s * half[a] * 0.9
      else p[a] += (rnd() - 0.5) * half[a] * (a === thin ? 0.4 : 1.4)
    }
    const d = [0, 0, 0]
    d[axis] = s
    // bent or snapped off at an angle
    for (let a = 0; a < 3; a++) if (a !== axis) d[a] = (rnd() - 0.5) * 0.9
    if (grade >= 1) {
      const rust: [number, number, number] = [0.13 + rnd() * 0.05, 0.08, 0.06]
      out.push(stick(p[0], p[1], p[2], d[0], d[1], d[2], 0.6 + rnd() * 1.1, 0.09, 0.09, rust, SURF.none))
    } else {
      const wood: [number, number, number] = [0.5 + rnd() * 0.1, 0.36, 0.2]
      out.push(stick(p[0], p[1], p[2], d[0], d[1], d[2], 0.8 + rnd() * 1.4, 0.34, 0.12, wood, SURF.plank))
    }
  }
  return out
}
