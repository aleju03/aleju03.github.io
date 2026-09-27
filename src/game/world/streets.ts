import { seeded } from '../core/rand'
import { RESERVED, chunkX, chunkZ, OFF_X, OFF_Z } from './grid'
import { clamp01, hash2, noise2, rand2, smoothstep } from './noise'
import { BLOCK_KIND_FOR, BLOCK_KIND_RATE, KIND_FOR, type BuildKind } from './buildings'
import type { District, Town } from './settlements'
import { gradedAt, ROAD_HALF, townD, WALK_W } from './settlements'

/*
  A town's street plan and the lots along it, grown once per settlement.

  The first streets out here were the chunk grid itself: every chunk border a
  street, every block one chunk, every junction a four-way. From the air that
  was graph paper, and from the pavement every block was the same 53-unit
  square with the same nine lots in it. This module replaces the lattice with
  a plan that is a pure function of the town (its seed, centre and rim) and
  nothing else, built the first time anything asks about that town and cached,
  so the answer is the same whichever way a player walks in and on every
  machine in a shared session. Nothing here is global: a network only ever
  reads its own town and the ground fields, which are themselves pure.

  The plan has four layers, laid down in order, each one reading the ones
  before it through a spatial index so it can attach to them and keep clear
  of them:

  - **Lines.** Two families of streets, north-south and east-west, spaced
    irregularly: tight at the middle (about 50 units) and opening up toward
    the rim (about 90). In the core (downtown and the walk-ups, a ragged
    noise-edged disc) every line is a street, some segments drop out (so
    blocks run double and junctions become Ts), and east-west segments in the
    walk-up ring sometimes jog a dozen units at a junction the way two
    subdivisions platted by different people meet. Past the core only every
    second or third line survives as a *collector*, and those wave gently.
    The two lines through the centre are the **arterials**: they never drop,
    and past the rim they carry on into the countryside as the roads out,
    drifting off the straight the way a country road follows its fields. The
    east-west one is the **main street**, fronted by continuous shops.
  - **Avenues.** A city (and some towns) cuts one or two straight diagonals
    through the core, ending on grid streets. Nothing is platted along them,
    so the grid's lots stop short of them in triangles.
  - **Neighbourhoods.** Each superblock the collectors enclose in the suburb
    ring gets a pattern of its own: a crescent, a loop, a run of culs-de-sac
    ending in turning circles, a meandering through street, a park, or a
    school or church on a big lot. These are the curves.
  - **Lots.** Every street side is walked from junction to junction and cut
    into lots whose frontage, depth and setback depend on how far from the
    middle they are, then accepted greedily in priority order (plazas and
    parks first, main street next, then everything else) against the streets
    and each other. Towers cluster in the middle and fall away; so does
    density, gradually, all the way to the rim.

  What the kits get is a Lot (kitbash.ts): a footprint, a height and a facing.
  Facing is snapped to a cardinal because the collision model is axis-aligned
  boxes (see src/game/CLAUDE.md), so a house on a curve faces the nearest
  cardinal to its street and is set back along the street's true normal, which
  is what makes a crescent read as a crescent. Lots whose street runs more
  than about thirty degrees off a cardinal are not platted at all.

  The home town is authored at the edges: the east arterial is the straight
  street past the property (x = 32), the street in front of the gate is a
  collector pinned to z = -11.2 and kept straight for a long way either side,
  and the property's own little ring of streets (x = -32 and the back street
  at z = 52.8, where the helicopter parks) is laid by hand. Nothing else may
  come near the property.

  Cost: a city plan is a few milliseconds and happens once per town; the
  lots are generated lazily on first request (chunk.ts, farfield.ts), since
  terrain height only ever needs the streets.
*/

/* ------------------------------------------------------------ types -- */

export type StreetKind = 'arterial' | 'grid' | 'collector' | 'avenue' | 'local'

export interface Street {
  id: number
  kind: StreetKind
  town: Town
  /** vertices, x and z interleaved */
  p: number[]
  /** arc length at each vertex */
  s: number[]
  /** the presence gate at each vertex (steepness and, on an arterial, the
      fade into the countryside), filled lazily; -1 is not yet known */
  k: Float32Array
  /** the graded ground at each vertex (the town skirt on the raw field),
      filled lazily; NaN is not yet known. The earthwork levels a street
      toward this, interpolated along each segment */
  h: Float32Array
  /** arc lengths where the street meets another; lots are cut between them */
  nodes: number[]
  /** the main street: shopfronts down both sides */
  main: boolean
  seed: number
}

export interface Seg {
  bulb: false
  /** query stamp, so a multi-cell lookup lists each piece once */
  mark: number
  /** bounding box, for the cheap rejection in `pieceNear` */
  x0: number
  z0: number
  x1: number
  z1: number
  street: Street
  /** index of the start vertex in the street */
  i: number
  ax: number
  az: number
  ux: number
  uz: number
  len: number
}

/** a turning circle at the end of a cul-de-sac */
export interface Bulb {
  bulb: true
  mark: number
  x0: number
  z0: number
  x1: number
  z1: number
  street: Street
  x: number
  z: number
  r: number
}

export type Piece = Seg | Bulb

export type ParcelUse = 'build' | 'park' | 'plaza' | 'lot'

export interface Parcel {
  id: number
  /** footprint centre and size in world axes (w along x, d along z) */
  x: number
  z: number
  w: number
  d: number
  /** which way the front faces, yaw (0 = +z); always a cardinal */
  face: number
  use: ParcelUse
  kind: BuildKind
  height: number
  district: District
  /** the envelope (yard, setback and all): for overlap and keep-out */
  x0: number
  z0: number
  x1: number
  z1: number
  /** the chunk that builds it */
  cx: number
  cz: number
}

export interface Network {
  town: Town
  streets: Street[]
  pieces: Piece[]
  cells: Map<number, Piece[]>
  /** parks, plazas and civic lots the plan set aside before any lot */
  reserved: Parcel[]
  parcels: Parcel[] | null
  byChunk: Map<number, Parcel[]> | null
}

/* ------------------------------------------------------- the index -- */

/** spatial index cell. Every piece is filed in every cell within MARGIN of
    it, so one lookup answers "everything within MARGIN of this point" */
const CELL = 32
/** covers the earthwork's reach (terrain.ts REACH) and the corridor ease */
export const MARGIN = 32
const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768)

const fileIn = (cells: Map<number, Piece[]>, p: Piece) => {
  const { x0, z0, x1, z1 } = p
  const i0 = Math.floor((x0 - MARGIN) / CELL)
  const i1 = Math.floor((x1 + MARGIN) / CELL)
  const j0 = Math.floor((z0 - MARGIN) / CELL)
  const j1 = Math.floor((z1 + MARGIN) / CELL)
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = cellKey(i, j)
      const list = cells.get(k)
      if (list) list.push(p)
      else cells.set(k, [p])
    }
}

/** the pieces filed at a point: everything within MARGIN of it, maybe more */
export const piecesAt = (net: Network, x: number, z: number) =>
  net.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)))

/** every piece within MARGIN of a rectangle, each once */
let stamp = 0
export const piecesIn = (net: Network, x0: number, z0: number, x1: number, z1: number) => {
  const mark = ++stamp
  const out: Piece[] = []
  for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++)
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      const list = net.cells.get(cellKey(i, j))
      if (!list) continue
      for (const p of list) if (p.mark !== mark) {
        p.mark = mark
        out.push(p)
      }
    }
  return out
}

/* ------------------------------------------------------- the probe -- */

/** scratch answer of `probe`: distance to the piece's centreline (a bulb
    reports it as if its rim were a kerb), the foot of that distance, the
    street's direction there and the parameter along a segment */
export const hit = { dist: 0, t: 0, fx: 0, fz: 0, dx: 1, dz: 0 }

export const probe = (p: Piece, x: number, z: number) => {
  if (p.bulb) {
    const ox = x - p.x
    const oz = z - p.z
    const r = Math.hypot(ox, oz)
    const ring = p.r - ROAD_HALF
    hit.dist = Math.max(0, r - ring)
    hit.t = 0
    if (r > 1e-6) {
      hit.fx = p.x + (ox / r) * ring
      hit.fz = p.z + (oz / r) * ring
      hit.dx = -oz / r
      hit.dz = ox / r
    } else {
      hit.fx = p.x; hit.fz = p.z; hit.dx = 1; hit.dz = 0
    }
    return hit.dist
  }
  let t = (x - p.ax) * p.ux + (z - p.az) * p.uz
  t = t < 0 ? 0 : t > p.len ? p.len : t
  hit.t = t
  hit.fx = p.ax + p.ux * t
  hit.fz = p.az + p.uz * t
  hit.dx = p.ux
  hit.dz = p.uz
  hit.dist = Math.hypot(x - hit.fx, z - hit.fz)
  return hit.dist
}

/** how far along the arterial's reach a road out of town runs */
export const SPINE_REACH = 2.4

/** the presence gate at one vertex: 0 where the ground under the street is
    too steep to pave, and on an arterial, fading out through the last fifth
    of its reach so a road never ends in a blunt rectangle of asphalt.
    Measured off the *graded* ground (the town shelf already applied), so it
    passes by construction inside a town and bites on the skirt and beyond */
const gateAt = (st: Street, i: number) => {
  const v = st.k[i]
  if (v >= 0) return v
  const x = st.p[i * 2]
  const z = st.p[i * 2 + 1]
  const t = st.town
  let fade = 1
  if (st.kind === 'arterial') {
    const reach = t.radius * SPINE_REACH
    fade = smoothstep(reach, reach * 0.82, Math.hypot(x - t.x, z - t.z))
  }
  let steep = 1
  if (fade > 0 && townD(t, x, z) > 0.84) {
    const n = st.p.length / 2
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    let ux = st.p[b * 2] - st.p[a * 2]
    let uz = st.p[b * 2 + 1] - st.p[a * 2 + 1]
    const l = Math.hypot(ux, uz) || 1
    ux /= l
    uz /= l
    const h0 = gradedAt(x - ux * 14, z - uz * 14)
    const h1 = gradedAt(x + ux * 14, z + uz * 14)
    steep = smoothstep(0.52, 0.3, Math.abs(h1 - h0) / 28)
  }
  const out = fade * steep
  st.k[i] = out
  return out
}

const levelAt = (st: Street, i: number) => {
  let v = st.h[i]
  if (Number.isNaN(v)) {
    v = gradedAt(st.p[i * 2], st.p[i * 2 + 1])
    st.h[i] = v
  }
  return v
}

/** the level a piece's earthwork grades toward at parameter `t`: the
    graded ground under its vertices, interpolated. Sampling it at the foot
    of every query instead was a field lookup per segment per terrain vertex,
    and a curving road out of town has five segments within reach of any
    point beside it */
export const levelOf = (p: Piece, t: number) => {
  const st = p.street
  if (p.bulb) return levelAt(st, st.p.length / 2 - 1)
  const a = levelAt(st, p.i)
  const b = levelAt(st, p.i + 1)
  return a + (b - a) * (p.len > 0 ? t / p.len : 0)
}

/** how present a piece is at parameter `t` along it: continuous along the
    street, since a step in presence is a step in the earthwork under it */
export const liveOf = (p: Piece, t: number) => {
  const st = p.street
  if (p.bulb) return gateAt(st, st.p.length / 2 - 1)
  const k0 = gateAt(st, p.i)
  const k1 = gateAt(st, p.i + 1)
  return k0 + (k1 - k0) * (p.len > 0 ? t / p.len : 0)
}

/* ------------------------------------------------------ the builder -- */

/** the attach tolerance: a street end this close to another's centreline
    has met it */
const MEET = 0.8

/** how far out (as a town distance) anything but an arterial may be laid:
    the edge of the flat shelf the town is graded onto (townGradedHeight
    holds it flat to 0.9). Past it the ground is the skirt easing back into
    the hills, and two streets out there sat at genuinely different heights
    thirty units apart, with the bank between them steeper than the batter */
const SHELF = 0.9

interface Line {
  /** 'ns' lines run north-south and sit at a constant-ish x */
  ns: boolean
  v: number
  idx: number
  amp: number
  wl: number
  ph: number
  drift: number
  arterial: boolean
  collector: boolean
  forced: boolean
  /** home only: an amplitude taper keeping the line straight near the house */
  calm: number
}

interface Plan {
  t: Town
  rng: () => number
  net: Network
  coreR: number
  rimR: number
  add: (kind: StreetKind, pts: number[], nodes?: number[], main?: boolean) => Street | null
  bulb: (st: Street, x: number, z: number, r: number) => void
  /** the nearest distance from a point to any street but `skip` */
  clearance: (x: number, z: number, skip?: Street | null) => number
  /** pre-platted parcels (parks, plazas, civic lots), accepted first */
  reserved: Parcel[]
  /** superblock patterns may not enter this */
  keepOut: { x0: number; z0: number; x1: number; z1: number } | null
}

const S_DROP = 0x9d43
const S_JOG = 0x51b9
const S_CORE = 0x2a6d
const S_DRIFT = 0x7f13

/** the lattice a straight street wants to sit on: a vertex column, so its
    bench is level across the whole width of the deck */
const snapX = (v: number) => OFF_X + Math.round((v - OFF_X) / 4) * 4
const snapZ = (v: number) => OFF_Z + Math.round((v - OFF_Z) / 4) * 4

/** where the walk-up core gives way to the suburbs, as a town distance: a
    ragged noise edge rather than a circle, so there is no ring to see */
const coreEdge = (t: Town, x: number, z: number) =>
  0.6 + (noise2(x / 240, z / 240, S_CORE ^ t.seed) - 0.5) * 0.16

const inCore = (t: Town, x: number, z: number) =>
  townD(t, x, z) < coreEdge(t, x, z) && !(t.home && z > -40)

/** the line's sideways offset at `u` (its running coordinate) */
const offOf = (L: Line, t: Town, u: number, coreR: number, rimR: number) => {
  const cu = L.ns ? t.z : t.x
  const cv = L.ns ? t.x : t.z
  const r = Math.hypot(L.v - cv, u - cu)
  let a = L.amp * smoothstep(coreR * 0.85, coreR * 1.2, r)
  if (L.calm) a *= smoothstep(L.calm, L.calm + 140, Math.abs(u))
  let off = a ? a * Math.sin((u / L.wl) * Math.PI * 2 + L.ph) : 0
  if (L.drift) {
    const k = smoothstep(rimR * 0.95, rimR * 1.35, Math.abs(u - cu))
    if (k > 0) off += L.drift * (noise2(u / 420, L.idx * 7.31 + (L.ns ? 0 : 50), S_DRIFT ^ t.seed) - 0.5) * 2 * k
  }
  return off
}

const lineAt = (L: Line, t: Town, u: number, coreR: number, rimR: number): [number, number] => {
  const o = offOf(L, t, u, coreR, rimR)
  return L.ns ? [L.v + o, u] : [u, L.v + o]
}

/** where a north-south and an east-west line cross. Both offsets are small
    and slow, so three rounds of substitution converge well under a
    centimetre */
const cross = (a: Line, b: Line, t: Town, coreR: number, rimR: number): [number, number] => {
  let z = b.v
  let x = a.v
  for (let k = 0; k < 4; k++) {
    x = a.v + offOf(a, t, z, coreR, rimR)
    z = b.v + offOf(b, t, x, coreR, rimR)
  }
  return [x, z]
}

/** one family of lines, marched outward from the centre at a spacing that
    opens up with distance */
const makeLines = (
  t: Town, ns: boolean, rng: () => number, span: number, coreR: number,
  base: number, forced: number[],
): Line[] => {
  const snap = ns ? snapX : snapZ
  const c = ns ? t.x : t.z
  const vals: Array<{ v: number; idx: number; forced: boolean }> = [{ v: base, idx: 0, forced: true }]
  for (const dir of [1, -1]) {
    let v = base
    let idx = 0
    for (;;) {
      const far = clamp01(Math.abs(v - c) / (coreR * 0.95))
      const sp = (46 + far * 44) * (0.7 + rng() * 0.75)
      v = snap(v + dir * sp)
      idx += dir
      if (Math.abs(v - c) > span) break
      vals.push({ v, idx, forced: false })
    }
  }
  // pin the authored lines: the nearest generated line moves onto each, and
  // anything left crowding it goes
  for (const f of forced) {
    let best = vals[0]
    for (const e of vals) if (Math.abs(e.v - f) < Math.abs(best.v - f)) best = e
    if (best.idx === 0) continue
    best.v = f
    best.forced = true
  }
  const kept = vals.filter((e) => e.forced || !vals.some((o) => o.forced && o !== e && Math.abs(o.v - e.v) < 44))
  kept.sort((a, b) => a.v - b.v)
  const lines: Line[] = kept.map((e) => ({
    ns, v: e.v, idx: e.idx,
    amp: 5 + rng() * 7, wl: 260 + rng() * 260, ph: rng() * Math.PI * 2,
    drift: 0, arterial: e.idx === 0, collector: e.idx === 0 || e.forced,
    forced: e.forced, calm: 0,
  }))
  // collectors: every second or third line past the core, spaced 120-180
  // apart, walking outward from the arterial
  const zero = lines.findIndex((l) => l.arterial)
  for (const dir of [1, -1]) {
    let last = lines[zero].v
    let gap = 120 + rng() * 60
    for (let i = zero + dir; i >= 0 && i < lines.length; i += dir) {
      const l = lines[i]
      if (l.forced) {
        last = l.v
        gap = 120 + rng() * 60
        continue
      }
      if (Math.abs(l.v - last) >= gap) {
        l.collector = true
        last = l.v
        gap = 120 + rng() * 60
      }
    }
  }
  // no ordinary collector crowding an authored one
  for (const l of lines) {
    if (!l.collector || l.forced) continue
    if (lines.some((o) => o.forced && !o.arterial && Math.abs(o.v - l.v) < 110)) l.collector = false
  }
  return lines
}

/**
 * A town's plan, as a job: it yields between lines, superblocks and
 * streets so the far field can grow it a slice at a time long before anyone
 * walks in (prepareTown), and anything that needs it now simply runs it to
 * the end (networkOf). The result is the same either way; only when the
 * milliseconds are spent differs.
 */
function* planJob(t: Town, net: Network): Generator<void, void> {
  const rng = seeded((t.seed ^ 0x5e7a) >>> 0)
  const rimR = t.home ? t.radius : t.radius * 1.26
  const coreR = t.radius * 0.6
  let sid = 0

  const plan: Plan = {
    t, rng, net, coreR, rimR, reserved: net.reserved, keepOut: null,
    add: (kind, pts, nodes = [], main = false) => {
      // drop repeated vertices; a zero-length segment has no direction
      const p: number[] = []
      for (let i = 0; i < pts.length; i += 2) {
        const n = p.length
        if (n && Math.hypot(pts[i] - p[n - 2], pts[i + 1] - p[n - 1]) < 0.05) continue
        p.push(pts[i], pts[i + 1])
      }
      if (p.length < 4) return null
      const s = [0]
      for (let i = 2; i < p.length; i += 2) {
        s.push(s[s.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]))
      }
      const st: Street = {
        id: sid++, kind, town: t, p, s, k: new Float32Array(p.length / 2).fill(-1),
        h: new Float32Array(p.length / 2).fill(NaN),
        nodes: nodes.slice().sort((a, b) => a - b), main, seed: hash2(t.seed, sid, 0x1a77),
      }
      net.streets.push(st)
      for (let i = 0; i + 1 < p.length / 2; i++) {
        const ax = p[i * 2]
        const az = p[i * 2 + 1]
        const len = s[i + 1] - s[i]
        const bx = p[i * 2 + 2]
        const bz = p[i * 2 + 3]
        const seg: Seg = {
          bulb: false, mark: 0, street: st, i, ax, az,
          ux: (bx - ax) / len, uz: (bz - az) / len, len,
          x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz),
        }
        net.pieces.push(seg)
        fileIn(net.cells, seg)
      }
      return st
    },
    bulb: (st, x, z, r) => {
      const b: Bulb = {
        bulb: true, mark: 0, street: st, x, z, r, x0: x - r, z0: z - r, x1: x + r, z1: z + r,
      }
      net.pieces.push(b)
      fileIn(net.cells, b)
    },
    clearance: (x, z, skip = null) => {
      let best = Infinity
      const list = piecesAt(net, x, z)
      if (!list) return best
      for (const p of list) {
        if (p.street === skip) continue
        const d = probe(p, x, z)
        if (d < best) best = d
      }
      return best
    },
  }

  if (t.rank === 'hamlet') {
    hamlet(plan)
  } else {
    yield* town(plan)
  }
  yield
  yield* finishNodes(plan)
}

const emptyNet = (t: Town): Network => ({
  town: t, streets: [], pieces: [], cells: new Map(), reserved: [], parcels: null, byChunk: null,
})

/**
 * Where each street actually meets another, as arc lengths: the crossings a
 * line recorded, kept only if something still crosses there (a line past the
 * core drops most of its crossings), plus every street end that lands on it
 * (culs-de-sac, crescents, avenues, jogs). The lot walk cuts at these, so a
 * row of lots runs corner to corner instead of breaking at phantom junctions.
 */
function* finishNodes(P: Plan): Generator<void, void> {
  const net = P.net
  const extra = new Map<Street, number[]>()
  for (const st of net.streets) {
    const n = st.p.length / 2
    for (const vi of [0, n - 1]) {
      const x = st.p[vi * 2]
      const z = st.p[vi * 2 + 1]
      const list = piecesAt(net, x, z)
      if (!list) continue
      for (const p of list) {
        if (p.bulb || p.street === st) continue
        if (probe(p, x, z) < 1.5) {
          const arr = extra.get(p.street) ?? []
          arr.push(p.street.s[p.i] + hit.t)
          extra.set(p.street, arr)
        }
      }
    }
  }
  yield
  let n = 0
  for (const st of net.streets) {
    if ((++n & 31) === 0) yield
    const keep = st.nodes.filter((s) => {
      const q = pointAt(st, s)
      return P.clearance(q.x, q.z, st) < 1.5
    })
    const all = keep.concat(extra.get(st) ?? []).sort((a, b) => a - b)
    const out: number[] = []
    for (const s of all) if (!out.length || s - out[out.length - 1] > 2) out.push(s)
    st.nodes = out
  }
}

/* ---------------------------------------------------------- a hamlet -- */

/** a crossroads that wanders, with a lane or two off it */
const hamlet = (P: Plan) => {
  const { t, rng, coreR, rimR } = P
  const x0 = snapX(t.x)
  const z0 = snapZ(t.z)
  const mk = (ns: boolean, v: number): Line => ({
    ns, v, idx: 0, amp: 6 + rng() * 6, wl: 220 + rng() * 160, ph: rng() * 6.28,
    drift: 50 + rng() * 40, arterial: true, collector: true, forced: true, calm: 0,
  })
  const a = mk(true, x0)
  const b = mk(false, z0)
  // the wave has to be felt inside a village, so it starts at the middle
  const inner = 1
  void coreR
  const reach = t.radius * SPINE_REACH
  const [nx, nz] = cross(a, b, t, inner, rimR)
  for (const L of [a, b]) {
    const pts: number[] = []
    const c = L.ns ? t.z : t.x
    const node = L.ns ? nz : nx
    for (let u = c - reach; u <= c + reach + 1e-6; u += 14) {
      if (u < node && u + 14 > node) {
        const [x, z] = lineAt(L, t, u, inner, rimR)
        pts.push(x, z, nx, nz)
        continue
      }
      const [x, z] = lineAt(L, t, u, inner, rimR)
      pts.push(x, z)
    }
    const st = P.add('arterial', pts, [], !L.ns)
    if (st) {
      // the node's arc length, for the lot walk
      let bi = 0
      for (let i = 0; i < st.p.length / 2; i++) {
        if (Math.hypot(st.p[i * 2] - nx, st.p[i * 2 + 1] - nz) < 0.1) bi = i
      }
      st.nodes.push(st.s[bi])
    }
  }
  // a lane or two off the crossroads
  const lanes = 1 + Math.floor(rng() * 2)
  for (let k = 0; k < lanes; k++) {
    const ang = rng() * Math.PI * 2
    const r0 = t.radius * (0.3 + rng() * 0.35)
    stub(P, t.x + Math.cos(ang) * r0, t.z + Math.sin(ang) * r0, 40 + rng() * 40, rng)
  }
}

/* ------------------------------------------------- a town or a city -- */

function* town(P: Plan): Generator<void, void> {
  const { t, rng, coreR, rimR } = P
  const span = rimR * 1.02
  const home = t.home
  // the arterials sit on the lattice nearest the centre; the home town's
  // north-south one is the street past the property
  const baseX = home ? 32 : snapX(t.x + (rng() - 0.5) * 30)
  const baseZ = snapZ(t.z + (home ? 0 : (rng() - 0.5) * 30))
  const arterial = (ns: boolean, v: number): Line => ({
    ns, v, idx: ns ? 0 : 1, amp: home ? 0 : 3 + rng() * 3, wl: 300 + rng() * 200,
    ph: rng() * Math.PI * 2, drift: home && ns ? 60 : 50 + rng() * 50,
    arterial: true, collector: true, forced: true, calm: 0,
  })
  const AX = arterial(true, baseX)
  const AZ = arterial(false, baseZ)
  // four plats, one per half of each family, each spaced on its own: the
  // quadrants meet the arterials at staggered T-junctions instead of one
  // lattice running straight through the middle of town
  const half = (ns: boolean, set: number, forced: number[]) =>
    makeLines(t, ns, rng, span, coreR, ns ? baseX : baseZ, forced)
      .filter((l) => !l.arterial)
      .map((l) => ({ ...l, idx: set * 1000 + l.idx }))
  const nsN = half(true, 1, [])
  const nsS = half(true, 2, home ? [-32] : [])
  const ewW = half(false, 3, home ? [OFF_Z] : [])
  const ewE = half(false, 4, home ? [OFF_Z] : [])
  for (const L of [...nsN, ...nsS, ...ewW, ...ewE]) {
    if (home && L.forced) {
      // the street in front of the gate stays straight for a long way
      L.calm = 170
      if (L.ns) L.collector = false
    }
  }

  // every crossing, once
  const X = new Map<number, [number, number]>()
  const crossing = (a: Line, b: Line) => {
    const key = a.idx * 8192 + b.idx
    let c = X.get(key)
    if (!c) {
      c = cross(a, b, t, coreR, rimR)
      X.set(key, c)
    }
    return c
  }

  const reach = t.radius * SPINE_REACH
  const drop = (L: Line, k: number, d: number) => {
    if (L.arterial || L.forced) return false
    const p = d < 0.26 ? 0.08 : 0.22
    return rand2(L.idx * 31, k, S_DROP ^ t.seed) < p
  }

  const layLine = (L: Line, others: Line[]) => {
    // crossings in order along the line
    const cr = others.map((o) => {
      const [x, z] = L.ns ? crossing(L, o) : crossing(o, L)
      return { u: L.ns ? z : x, x, z, o }
    }).sort((a, b) => a.u - b.u)
    if (cr.length < 2) return
    // which gaps between crossings are paved, and with what jog
    const live: boolean[] = []
    const jog: number[] = []
    let edge = 0
    let edgeAlive = true
    for (let k = 0; k + 1 < cr.length; k++) {
      const a = cr[k]
      const b = cr[k + 1]
      const mx = (a.x + b.x) / 2
      const mz = (a.z + b.z) / 2
      const d = townD(t, mx, mz)
      if (a.o.collector) {
        edge++
        edgeAlive = L.arterial || L.forced ||
          rand2(L.idx * 17, edge, S_DROP ^ 0x55 ^ t.seed) > 0.1
      }
      let ok: boolean
      let j = 0
      if (inCore(t, mx, mz)) {
        ok = d < 1 && !drop(L, k, d)
        if (ok && !L.arterial && !L.forced && d > 0.28 && !a.o.arterial && !b.o.arterial &&
          rand2(L.idx, k, S_JOG ^ t.seed) < 0.16) {
          j = (rand2(k, L.idx, S_JOG ^ t.seed) < 0.5 ? -1 : 1) * (rand2(L.idx + 9, k, S_JOG) < 0.5 ? 8 : 12)
        }
      } else {
        ok = L.collector && edgeAlive && (d < SHELF || L.arterial)
      }
      if (home && !L.arterial && !L.forced) {
        // nothing but the authored streets on the property's block
        if (mx > -120 && mx < 120 && mz > -30 && mz < 110) ok = false
      }
      live.push(ok)
      jog.push(j)
    }
    // runs of consecutive paved gaps with one jog become one street each
    const kind: StreetKind = L.arterial ? 'arterial' : L.collector ? 'collector' : 'grid'
    let k = 0
    const n = live.length
    while (k < n) {
      if (!live[k]) {
        k++
        continue
      }
      const j0 = jog[k]
      let e = k
      while (e + 1 < n && live[e + 1] && jog[e + 1] === j0) e++
      const pts: number[] = []
      const us: number[] = []
      const put = (x: number, z: number, node: boolean) => {
        if (!L.ns) z += j0
        else x += j0
        pts.push(x, z)
        if (node) us.push(pts.length / 2 - 1)
      }
      // an arterial carries on past its last crossings into the country
      if (L.arterial && k === 0) {
        const c = L.ns ? t.z : t.x
        for (let u = c - reach; u < cr[0].u - 8; u += 14) {
          const [x, z] = lineAt(L, t, u, coreR, rimR)
          put(x, z, false)
        }
      }
      for (let q = k; q <= e + 1; q++) {
        const c = cr[q]
        put(c.x, c.z, true)
        if (q === e + 1) break
        const nxt = cr[q + 1]
        // a wavy stretch is sampled; a straight one is one segment
        const gap = nxt.u - c.u
        const wavy = L.drift || offOf(L, t, (c.u + nxt.u) / 2, coreR, rimR) !== 0 ||
          offOf(L, t, c.u + gap * 0.25, coreR, rimR) !== 0
        // ...and anything out of the core is sampled regardless, since the
        // steepness gate is read per vertex
        const loose = !inCore(t, (c.x + nxt.x) / 2, (c.z + nxt.z) / 2)
        if (wavy || loose) {
          const steps = Math.ceil(gap / 12)
          for (let s = 1; s < steps; s++) {
            const u = c.u + (gap * s) / steps
            const [x, z] = lineAt(L, t, u, coreR, rimR)
            put(x, z, false)
          }
        }
      }
      if (L.arterial && e === n - 1) {
        const c = L.ns ? t.z : t.x
        const last = cr[cr.length - 1].u
        for (let u = last + 14; u <= c + reach; u += 14) {
          const [x, z] = lineAt(L, t, u, coreR, rimR)
          put(x, z, false)
        }
      }
      const st = P.add(kind, pts, [], L.arterial && !L.ns)
      if (st) {
        // node arc lengths: the vertices put down at crossings, looked up
        // after add() has dropped any duplicate
        for (const vi of us) {
          const x = pts[vi * 2]
          const z = pts[vi * 2 + 1]
          for (let i = 0; i < st.p.length / 2; i++) {
            if (Math.abs(st.p[i * 2] - x) < 0.01 && Math.abs(st.p[i * 2 + 1] - z) < 0.01) {
              st.nodes.push(st.s[i])
              break
            }
          }
        }
        st.nodes.sort((a, b) => a - b)
      }
      k = e + 1
    }
  }

  // the quadrants: each half-family's lines on its own side of the
  // arterials, crossing only the other half-family on that side and ending
  // on the arterial between them
  interface Quad { ns: Line[]; ew: Line[]; west: boolean; north: boolean }
  const quads: Quad[] = []
  for (const north of [true, false])
    for (const west of [true, false]) {
      const ns = (north ? nsN : nsS).filter((l) => (west ? l.v < baseX - 20 : l.v > baseX + 20))
      const ew = (west ? ewW : ewE).filter((l) => (north ? l.v < baseZ - 20 : l.v > baseZ + 20))
      quads.push({ ns, ew, west, north })
    }
  for (const q of quads) {
    for (const L of q.ns) {
      layLine(L, [...q.ew, AZ])
      yield
    }
    for (const L of q.ew) {
      layLine(L, [...q.ns, AX])
      yield
    }
  }
  // the arterials, met from both sides by everything that ends on them
  layLine(AX, [...ewW, ...ewE, AZ])
  yield
  layLine(AZ, [...nsN, ...nsS, AX])
  yield

  // the property's own block, laid by hand: the side street at x = -32 and
  // the back street at z = 52.8 (where the helicopter stands)
  if (home) {
    P.add('local', [-32, OFF_Z, -32, 52.8], [0, 64])
    P.add('local', [-32, 52.8, 32, 52.8], [0, 64])
    P.keepOut = { x0: -80, z0: -25, x1: 80, z1: 100 }
  }

  /** a quadrant's lines in order out from the arterials, arterial first */
  const bounds = (q: Quad) => {
    const xs = [AX, ...q.ns.slice().sort((a, b) => (q.west ? b.v - a.v : a.v - b.v))]
    const zs = [AZ, ...q.ew.slice().sort((a, b) => (q.north ? b.v - a.v : a.v - b.v))]
    return { xs, zs }
  }
  /** the block between the i-th and (i+1)-th lines out of a quadrant's
      corner, set aside if nothing crosses it */
  const tryBlock = (q: Quad, i: number, j: number, use: ParcelUse) => {
    const { xs, zs } = bounds(q)
    if (i + 1 >= xs.length || j + 1 >= zs.length) return false
    const pad = ROAD_HALF + WALK_W + 0.8
    const x0 = Math.min(xs[i].v, xs[i + 1].v) + pad
    const x1 = Math.max(xs[i].v, xs[i + 1].v) - pad
    const z0 = Math.min(zs[j].v, zs[j + 1].v) + pad
    const z1 = Math.max(zs[j].v, zs[j + 1].v) - pad
    if (x1 - x0 < 18 || z1 - z0 < 18) return false
    return reserveRect(P, x0, z0, x1, z1, use)
  }
  // the plaza: a block on the middle junction that nothing crosses
  for (const q of quads) if (tryBlock(q, 0, 0, 'plaza')) break
  yield

  // diagonal avenues through the core, ending on the grid, kept off the
  // plaza (it is the one block they would most like to cross)
  const avenues = t.rank === 'city' ? (rng() < 0.45 ? 2 : 1) : rng() < 0.5 ? 1 : 0
  let lastAng = 0
  for (let a = 0; a < avenues; a++) {
    const sign = a === 0 ? (rng() < 0.5 ? 1 : -1) : -Math.sign(lastAng)
    const ang = sign * (0.45 + rng() * 0.55)
    lastAng = ang
    for (let k = 0; k < 5; k++) {
      const r = coreR * (0.1 + k * 0.08)
      const phi = rng() * Math.PI * 2
      const ok = avenue(P, t.x + Math.cos(phi) * r, t.z + Math.sin(phi) * r, ang)
      yield
      if (ok) break
    }
  }
  // a few pocket parks in the walk-up ring
  const parks = t.rank === 'city' ? 3 : 1
  for (let k = 0, tries = 0; k < parks && tries < 30; tries++) {
    const q = quads[Math.floor(rng() * 4)]
    const { xs, zs } = bounds(q)
    const i = Math.floor(rng() * (xs.length - 1))
    const j = Math.floor(rng() * (zs.length - 1))
    if (i + 1 >= xs.length || j + 1 >= zs.length) continue
    const mx = (xs[i].v + xs[i + 1].v) / 2
    const mz = (zs[j].v + zs[j + 1].v) / 2
    if (townD(t, mx, mz) < 0.26 || !inCore(t, mx, mz)) continue
    if (tryBlock(q, i, j, 'park')) k++
  }

  // the neighbourhoods: each superblock a quadrant's collectors enclose
  for (const q of quads) {
    const { xs, zs } = bounds(q)
    const cx = xs.filter((l) => l.collector || l.arterial)
    const cz = zs.filter((l) => l.collector || l.arterial)
    for (let a = 0; a + 1 < cx.length; a++)
      for (let b = 0; b + 1 < cz.length; b++) {
        const [w, e] = cx[a].v < cx[a + 1].v ? [cx[a], cx[a + 1]] : [cx[a + 1], cx[a]]
        const [n, s] = cz[b].v < cz[b + 1].v ? [cz[b], cz[b + 1]] : [cz[b + 1], cz[b]]
        neighbourhood(P, w, e, n, s)
        yield
      }
  }
  yield* infill(P)
}

/**
 * Whatever the superblocks left: walk every suburban collector and road out,
 * and wherever there is room either side, hang a cul-de-sac or a crescent
 * off it. Superblocks rarely sit square in the suburb ring (the core's edge
 * is ragged and the rim is warped), so this is what actually fills most of
 * it; every proposal is checked against what is already there, so it only
 * ever threads into space.
 */
function* infill(P: Plan): Generator<void, void> {
  const { t } = P
  const sub = seeded(hash2(t.seed, 0x1f, 0x33a9))
  const roots = P.net.streets.filter((st) => st.kind === 'collector' || st.kind === 'arterial')
  for (const st of roots) {
    const total = st.s[st.s.length - 1]
    let s = 30 + sub() * 40
    while (s < total - 30) {
      const q = pointAt(st, s)
      const x = q.x
      const z = q.z
      const ux = q.ux
      const uz = q.uz
      const d = townD(t, x, z)
      if (d < SHELF - 0.03 && d > 0.3 && !inCore(t, x, z)) {
        for (const side of [1, -1]) {
          if (sub() > 0.94) continue
          const nx = -uz * side
          const nz = ux * side
          const roll = sub()
          if (roll < 0.28) {
            // a connector: straight across to whatever street is there,
            // which is what turns a comb of culs-de-sac into blocks
            let hitS = 0
            for (let k = 24; k < 170; k += 2) {
              if (P.clearance(x + nx * k, z + nz * k, st) < MEET) {
                hitS = k
                break
              }
            }
            if (hitS > 50) {
              const pts: number[] = []
              const bend = (sub() - 0.5) * 16
              const steps = Math.ceil(hitS / 10)
              for (let i = 0; i <= steps; i++) {
                const f = i / steps
                const o = i === steps ? 0 : bend * Math.sin(Math.PI * f)
                pts.push(x + nx * hitS * f + ux * o, z + nz * hitS * f + uz * o)
              }
              if (joiner(P, pts)) continue
            }
          }
          if (roll > 0.8) {
            // a crescent: out, along the street, and back
            const depth = 42 + sub() * 26
            const run = 70 + sub() * 40
            const bx = x + ux * run
            const bz = z + uz * run
            if (meets(P, bx, bz)) {
              const pts = dense(rounded([
                x, z, x + nx * depth, z + nz * depth,
                bx + nx * depth, bz + nz * depth, bx, bz,
              ], 18, false), 10)
              if (joiner(P, pts)) continue
            }
          }
          stub(P, x + nx * 2, z + nz * 2, 44 + sub() * 70, sub, [nx, nz])
        }
      }
      s += 36 + sub() * 30
      yield
    }
  }
}

/** keep a rectangle for a park, a plaza or a civic lot, if no street
    crosses it */
const reserveRect = (
  P: Plan, x0: number, z0: number, x1: number, z1: number, use: ParcelUse,
  kind: BuildKind = 'house', face = 0,
) => {
  for (const p of piecesIn(P.net, x0, z0, x1, z1)) {
    if (pieceNear(p, x0, z0, x1, z1, ROAD_HALF + WALK_W + 0.3)) return false
  }
  if (P.t.home && x0 < RESERVED.maxX + 6 && x1 > RESERVED.minX - 6 &&
    z0 < RESERVED.maxZ + 6 && z1 > RESERVED.minZ - 6) return false
  const d = townD(P.t, (x0 + x1) / 2, (z0 + z1) / 2)
  P.reserved.push({
    id: 0, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, face,
    use, kind, height: 9 + P.rng() * 4, district: districtOf(d),
    x0, z0, x1, z1, cx: 0, cz: 0,
  })
  return true
}

/** a diagonal through the core, trimmed back to the last grid street it
    crosses at either end so both ends are junctions */
const avenue = (P: Plan, px: number, pz: number, ang: number): boolean => {
  const { t } = P
  const ux = Math.cos(ang)
  const uz = Math.sin(ang)
  const ends: number[] = []
  for (const dir of [1, -1]) {
    let lastCross = 0
    let was = Infinity
    for (let s = 3; s < t.radius * 1.2; s += 3) {
      const x = px + ux * s * dir
      const z = pz + uz * s * dir
      if (!inCore(P.t, x, z) || townD(t, x, z) > 0.5) break
      const c = P.clearance(x, z)
      if (c < 1.2 && was >= 1.2) lastCross = s
      was = c
    }
    ends.push(lastCross * dir)
  }
  if (ends[0] - ends[1] < 80) return false
  const pts = [px + ux * ends[1], pz + uz * ends[1], px + ux * ends[0], pz + uz * ends[0]]
  // nothing authored in the way, and no plaza or park cut in two
  if (P.keepOut && segHitsRect(pts[0], pts[1], pts[2], pts[3], P.keepOut)) return false
  for (const r of P.reserved) {
    const g = { x0: r.x0 - 6, z0: r.z0 - 6, x1: r.x1 + 6, z1: r.z1 + 6 }
    if (segHitsRect(pts[0], pts[1], pts[2], pts[3], g)) return false
  }
  return P.add('avenue', pts) !== null
}

/* ------------------------------------------------ the neighbourhoods -- */

/** a point on a line at running coordinate u, and the line's inward normal
    toward the superblock */
const onLine = (P: Plan, L: Line, u: number) => lineAt(L, P.t, u, P.coreR, P.rimR)

/** a street end has met something here */
const meets = (P: Plan, x: number, z: number) => P.clearance(x, z) < MEET

/** is a proposed street clear of everything but the ends it attaches by */
const clearPath = (P: Plan, pts: number[], skipHead: number, skipTail: number, room: number) => {
  let s = 0
  let total = 0
  for (let i = 2; i < pts.length; i += 2) total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1])
  for (let i = 0; i < pts.length; i += 2) {
    if (i) s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1])
    const x = pts[i]
    const z = pts[i + 1]
    if (townD(P.t, x, z) > SHELF) return false
    const k = P.keepOut
    if (k && x > k.x0 && x < k.x1 && z > k.z0 && z < k.z1) return false
    if (s < skipHead || total - s < skipTail) continue
    if (P.clearance(x, z) < room) return false
  }
  for (const r of P.reserved) {
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i]
      const z = pts[i + 1]
      if (x > r.x0 - 6 && x < r.x1 + 6 && z > r.z0 - 6 && z < r.z1 + 6) return false
    }
  }
  return true
}

/** a cul-de-sac from a point on a street, heading away from it, bending a
    little, and ending in a turning circle */
const stub = (
  P: Plan, x: number, z: number, len: number, rng: () => number,
  dir?: [number, number],
): boolean => {
  // find the street it hangs off, and its normal there
  const list = piecesAt(P.net, x, z)
  if (!list) return false
  let best: Piece | null = null
  let bd = Infinity
  let fx = 0
  let fz = 0
  let tx = 1
  let tz = 0
  for (const p of list) {
    if (p.bulb) continue
    const d = probe(p, x, z)
    if (d < bd) {
      bd = d
      best = p
      fx = hit.fx; fz = hit.fz; tx = hit.dx; tz = hit.dz
    }
  }
  if (!best || bd > 60) return false
  let nx = -tz
  let nz = tx
  if (dir) {
    if (nx * dir[0] + nz * dir[1] < 0) { nx = -nx; nz = -nz }
  } else if ((x - fx) * nx + (z - fz) * nz < 0) {
    nx = -nx
    nz = -nz
  }
  // not off a junction
  if (P.clearance(fx, fz, best.street) < 18) return false
  const bend = (rng() - 0.5) * 2 * Math.min(18, len * 0.3)
  const pts: number[] = []
  const steps = Math.max(2, Math.ceil(len / 10))
  for (let i = 0; i <= steps; i++) {
    const s = (len * i) / steps
    const side = bend * Math.sin((Math.PI * s) / len * 0.8)
    pts.push(fx + nx * s + tx * side, fz + nz * s + tz * side)
  }
  const R = 8.5
  if (!clearPath(P, pts, 24, 0, 20)) return false
  const ex = pts[pts.length - 2]
  const ez = pts[pts.length - 1]
  if (P.clearance(ex, ez) < R + 15) return false
  const st = P.add('local', pts, [0])
  if (!st) return false
  P.bulb(st, ex, ez, R)
  return true
}

/** a street from one point on a street to another, along `pts` (which must
    start and end on existing streets) */
const joiner = (P: Plan, pts: number[]) => {
  if (!meets(P, pts[0], pts[1]) || !meets(P, pts[pts.length - 2], pts[pts.length - 1])) return false
  if (!clearPath(P, pts, 24, 24, 20)) return false
  const st = P.add('local', pts, [])
  if (!st) return false
  st.nodes.push(0, st.s[st.s.length - 1])
  st.nodes.sort((a, b) => a - b)
  return true
}

/** rounded polyline through corner points, corner radius `r` */
const rounded = (corners: number[], r: number, closed: boolean) => {
  const n = corners.length / 2
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const x = corners[i * 2]
    const z = corners[i * 2 + 1]
    const first = i === 0
    const last = i === n - 1
    if (!closed && (first || last)) {
      out.push(x, z)
      continue
    }
    const pi = (i - 1 + n) % n
    const ni = (i + 1) % n
    const ax = corners[pi * 2] - x
    const az = corners[pi * 2 + 1] - z
    const bx = corners[ni * 2] - x
    const bz = corners[ni * 2 + 1] - z
    const la = Math.hypot(ax, az)
    const lb = Math.hypot(bx, bz)
    const rr = Math.min(r, la * 0.45, lb * 0.45)
    // a quadratic through the corner, five samples
    const sx = x + (ax / la) * rr
    const sz = z + (az / la) * rr
    const ex = x + (bx / lb) * rr
    const ez = z + (bz / lb) * rr
    for (let k = 0; k <= 4; k++) {
      const u = k / 4
      const w = 1 - u
      out.push(w * w * sx + 2 * w * u * x + u * u * ex, w * w * sz + 2 * w * u * z + u * u * ez)
    }
  }
  if (closed) out.push(out[0], out[1])
  return out
}

/** densify a polyline so no segment is longer than `step` */
const dense = (pts: number[], step: number) => {
  const out: number[] = [pts[0], pts[1]]
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2]
    const az = pts[i - 1]
    const bx = pts[i]
    const bz = pts[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step))
    for (let k = 1; k <= n; k++) out.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n)
  }
  return out
}

/**
 * One superblock of the suburb ring, bounded by four collectors (nominally;
 * any of them may have dropped out or waved), given a pattern of its own.
 * A superblock with grid streets still in it is half core and is left to
 * them.
 */
const neighbourhood = (P: Plan, w: Line, e: Line, n: Line, s: Line) => {
  const { t, rng } = P
  const x0 = w.v
  const x1 = e.v
  const z0 = n.v
  const z1 = s.v
  const W = x1 - x0
  const H = z1 - z0
  const mx = (x0 + x1) / 2
  const mz = (z0 + z1) / 2
  const dMid = townD(t, mx, mz)
  // the pattern is rolled whatever happens, so one superblock's roll never
  // depends on whether its neighbour's streets fit
  const roll = rng()
  const r2 = rng()
  const r3 = rng()
  const sub = seeded(hash2(Math.round(mx), Math.round(mz), 0x6c1d ^ t.seed))
  if (dMid > SHELF - 0.02) return
  const m = 34
  if (W < 2 * m + 30 || H < 2 * m + 30) return
  // grid streets inside it: the core reaches in here, so it only gets what
  // can be threaded in between them
  let mixed = false
  for (const p of piecesIn(P.net, x0 + m, z0 + m, x1 - m, z1 - m)) {
    if (pieceNear(p, x0 + m, z0 + m, x1 - m, z1 - m, 1)) {
      mixed = true
      break
    }
  }
  const rim = dMid > SHELF - 0.1
  // the four sides as (line, running coordinate range, inward direction)
  const sides: Array<{ L: Line; a: number; b: number; nx: number; nz: number; depth: number }> = [
    { L: n, a: x0, b: x1, nx: 0, nz: 1, depth: H },
    { L: s, a: x0, b: x1, nx: 0, nz: -1, depth: H },
    { L: w, a: z0, b: z1, nx: 1, nz: 0, depth: W },
    { L: e, a: z0, b: z1, nx: -1, nz: 0, depth: W },
  ]
  const at = (side: typeof sides[number], f: number) => onLine(P, side.L, side.a + (side.b - side.a) * f)

  const culs = (count: number) => {
    let made = 0
    for (let k = 0; k < count * 3 && made < count; k++) {
      const side = sides[Math.floor(sub() * 4)]
      const f = 0.22 + sub() * 0.56
      const [px, pz] = at(side, f)
      if (!meets(P, px, pz)) continue
      const len = (side.depth - m) * (0.42 + sub() * 0.3)
      if (len < 34) continue
      if (stub(P, px + side.nx * 2, pz + side.nz * 2, len, sub, [side.nx, side.nz])) made++
    }
    return made
  }

  if (P.keepOut && x0 < P.keepOut.x1 && x1 > P.keepOut.x0 && z0 < P.keepOut.z1 && z1 > P.keepOut.z0) {
    // the property's superblock keeps to culs-de-sac, well away from it
    culs(2)
    return
  }
  if (rim || mixed) {
    // the edge of town thins out: a lane or nothing
    if (roll < 0.6) culs(1)
    return
  }

  if (roll < 0.07 && W > 110 && H > 110) {
    // a park: the whole middle, ringed by the backs of the collector lots
    reserveRect(P, x0 + m + 4, z0 + m + 4, x1 - m - 4, z1 - m - 4, 'park')
    return
  }
  if (roll < 0.15) {
    // a school or a church on a big lot off one side, and a lane beside it
    const side = sides[Math.floor(r2 * 4)]
    const [px, pz] = at(side, 0.5)
    if (meets(P, px, pz)) {
      const fw = 40 + r3 * 12
      const dp = 32 + r3 * 8
      const set = ROAD_HALF + WALK_W + 5
      const cxp = px + side.nx * (set + dp / 2)
      const czp = pz + side.nz * (set + dp / 2)
      const hw = side.nx ? dp / 2 : fw / 2
      const hd = side.nx ? fw / 2 : dp / 2
      const kind: BuildKind = r3 < 0.5 ? 'chapel' : 'midrise'
      const face = Math.atan2(-side.nx, -side.nz)
      reserveRect(P, cxp - hw, czp - hd, cxp + hw, czp + hd, 'build', kind, face)
    }
    culs(1)
    return
  }
  if (roll < 0.38 && W > 170 && H > 170) {
    // a loop: a rounded ring well inside, joined to one side by a stub
    const inset = 60
    const ring = rounded([
      x0 + inset, z0 + inset, x1 - inset, z0 + inset, x1 - inset, z1 - inset, x0 + inset, z1 - inset,
    ], 22, true)
    // start the ring in the middle of its north side, so the seam is straight
    const sx = (x0 + x1) / 2
    const sz = z0 + inset
    const body = ring.slice(0, 40)
    const pts = dense([sx, sz, ...body.slice(10), ...body.slice(0, 10), sx, sz], 12)
    if (clearPath(P, pts, 0, 0, 30)) {
      const st = P.add('local', pts, [])
      if (st) {
        const side = sides[Math.floor(r2 * 4)]
        const f = 0.35 + r3 * 0.3
        const [px, pz] = at(side, f)
        const lx = side.nx ? (side.nx > 0 ? x0 + inset : x1 - inset) : px
        const lz = side.nz ? (side.nz > 0 ? z0 + inset : z1 - inset) : pz
        joiner(P, dense([px, pz, lx, lz], 12))
        if (sub() < 0.5) {
          reserveRect(P, x0 + inset + 12, z0 + inset + 12, x1 - inset - 12, z1 - inset - 12, 'park')
        }
        return
      }
    }
  }
  if (roll < 0.62) {
    // a crescent: out from one side, along, and back to it
    const side = sides[Math.floor(r2 * 4)]
    const fa = 0.18 + r3 * 0.1
    const fb = 0.72 + sub() * 0.1
    const [ax, az] = at(side, fa)
    const [bx, bz] = at(side, fb)
    const depth = Math.min(side.depth - m - 34, (side.depth - m) * (0.55 + sub() * 0.2))
    if (depth > 46 && meets(P, ax, az) && meets(P, bx, bz)) {
      const pts = dense(rounded([
        ax, az,
        ax + side.nx * depth, az + side.nz * depth,
        bx + side.nx * depth, bz + side.nz * depth,
        bx, bz,
      ], 20, false), 10)
      if (joiner(P, pts)) {
        if (sub() < 0.45) {
          const lo = Math.min(ax, bx, ax + side.nx * depth, bx + side.nx * depth)
          const hi = Math.max(ax, bx, ax + side.nx * depth, bx + side.nx * depth)
          const lz = Math.min(az, bz, az + side.nz * depth, bz + side.nz * depth)
          const hz = Math.max(az, bz, az + side.nz * depth, bz + side.nz * depth)
          const inset = 34
          if (hi - lo > 2 * inset + 16 && hz - lz > 2 * inset + 16) {
            reserveRect(P, lo + inset, lz + inset, hi - inset, hz - inset, 'park')
          }
        }
        culs(1)
        return
      }
    }
  }
  if (roll < 0.8) {
    // a street that meanders across from one side to the other
    const vert = r2 < 0.5
    const A = vert ? sides[0] : sides[2]
    const B = vert ? sides[1] : sides[3]
    const f = 0.35 + r3 * 0.3
    const [ax, az] = at(A, f)
    const [bx, bz] = at(B, f + (sub() - 0.5) * 0.2)
    if (meets(P, ax, az) && meets(P, bx, bz)) {
      const amp = (10 + sub() * 16) * (sub() < 0.5 ? -1 : 1)
      const waves = sub() < 0.6 ? 1 : 2
      const pts: number[] = []
      const len = Math.hypot(bx - ax, bz - az)
      const ux = (bx - ax) / len
      const uz = (bz - az) / len
      const steps = Math.ceil(len / 10)
      for (let i = 0; i <= steps; i++) {
        const k = i / steps
        const off = amp * Math.sin(Math.PI * k * waves)
        pts.push(ax + (bx - ax) * k - uz * off, az + (bz - az) * k + ux * off)
      }
      if (joiner(P, pts)) {
        culs(1)
        return
      }
    }
  }
  culs(1 + Math.floor(r3 * 2.4))
}

/* -------------------------------------------------------- geometry -- */

const pointRect = (x: number, z: number, x0: number, z0: number, x1: number, z1: number) =>
  Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1))

const segHitsRect = (
  ax: number, az: number, bx: number, bz: number,
  r: { x0: number; z0: number; x1: number; z1: number },
) => {
  // Liang-Barsky
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dz = bz - az
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const u = q / p
    if (p < 0) {
      if (u > t1) return false
      if (u > t0) t0 = u
    } else {
      if (u < t0) return false
      if (u < t1) t1 = u
    }
    return true
  }
  return clip(-dx, ax - r.x0) && clip(dx, r.x1 - ax) && clip(-dz, az - r.z0) && clip(dz, r.z1 - az)
}

const pointSeg = (x: number, z: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(x - ax - dx * t, z - az - dz * t)
}

/** the distance from a piece's centreline (a bulb's rim, less a lane) to a
    rectangle: 0 if they touch */
export const pieceToRect = (p: Piece, x0: number, z0: number, x1: number, z1: number) => {
  if (p.bulb) return Math.max(0, pointRect(p.x, p.z, x0, z0, x1, z1) - (p.r - ROAD_HALF))
  const bx = p.ax + p.ux * p.len
  const bz = p.az + p.uz * p.len
  if (segHitsRect(p.ax, p.az, bx, bz, { x0, z0, x1, z1 })) return 0
  return Math.min(
    pointRect(p.ax, p.az, x0, z0, x1, z1),
    pointRect(bx, bz, x0, z0, x1, z1),
    pointSeg(x0, z0, p.ax, p.az, bx, bz),
    pointSeg(x1, z0, p.ax, p.az, bx, bz),
    pointSeg(x0, z1, p.ax, p.az, bx, bz),
    pointSeg(x1, z1, p.ax, p.az, bx, bz),
  )
}

/** is a piece within `pad` of a rectangle: its bounding box first, which
    throws out nearly everything a cell lookup returns */
export const pieceNear = (
  p: Piece, x0: number, z0: number, x1: number, z1: number, pad: number,
) => {
  if (p.x1 < x0 - pad || p.x0 > x1 + pad || p.z1 < z0 - pad || p.z0 > z1 + pad) return false
  return pieceToRect(p, x0, z0, x1, z1) < pad
}

/* ------------------------------------------------------------- lots -- */

const districtOf = (d: number): District => (d < 0.26 ? 'downtown' : d < 0.58 ? 'midrise' : 'suburb')

/** how tall a building may stand at a town distance, smoothly: a peak in the
    middle that is gone by the edge of downtown, a shoulder of walk-ups, and
    houses. Shared with settlements.ts's buildingHeightAt */
export const heightAtD = (t: Town, d: number) => {
  const scale = t.rank === 'city' ? 1 : t.rank === 'town' ? 0.62 : 0.34
  const core = Math.exp(-((d / 0.13) ** 2))
  const mid = smoothstep(0.62, 0.2, d)
  return Math.max(8, scale * (118 * core + 40 * mid + 15))
}

const S_LOT = 0x4d27

interface Cand extends Parcel {
  pri: number
}

/**
 * Walk one side of one street from junction to junction and cut it into
 * candidate lots. The walk is by arc length, so a lot follows its street
 * round a bend; its footprint stays axis-aligned and faces the nearest
 * cardinal to the street.
 */
const walkSide = (net: Network, st: Street, side: number, out: Cand[]) => {
  const t = net.town
  const total = st.s[st.s.length - 1]
  const cuts = [0, ...st.nodes.filter((s) => s > 0.5 && s < total - 0.5), total]
  const rng = seeded(hash2(st.id * 2 + (side > 0 ? 1 : 0), t.seed, S_LOT))
  // one setback per street side, jittered per lot: a street reads as a street
  // when its houses mostly agree
  const baseSet = 4.5 + rng() * 6
  for (let c = 0; c + 1 < cuts.length; c++) {
    const from = cuts[c] + ROAD_HALF + WALK_W + 1.2
    const to = cuts[c + 1] - ROAD_HALF - WALK_W - 1.2
    let s = from + rng() * 2
    while (s < to - 6) {
      const q = pointAt(st, s + 4)
      const d = townD(t, q.x, q.z)
      if (d > 1.0) {
        s += 12
        continue
      }
      const dn = d + (rng() - 0.5) * 0.1
      const r1 = rng()
      const r2 = rng()
      const r3 = rng()
      const main = st.main && dn > 0.1 && dn < 0.56
      let use: ParcelUse = 'build'
      let kind: BuildKind
      let fw: number
      let dp: number
      let set: number
      let gap: number
      let back = 0.4
      let sideM = 0.15
      let through = false
      const district = districtOf(dn)
      if (main) {
        kind = r1 < 0.62 ? 'shop' : 'mixed'
        fw = kind === 'shop' ? 8 + r2 * 5 : 12 + r2 * 6
        dp = 11 + r3 * 6
        set = 0.3
        gap = 0
      } else if (district !== 'suburb') {
        const towerP = t.rank === 'hamlet' ? 0 : clamp01((0.31 - dn) / 0.13)
        if (r1 < BLOCK_KIND_RATE(district) * 0.5) {
          kind = BLOCK_KIND_FOR(district, r2)
          fw = 32 + r3 * 12
          dp = 30 + r2 * 12
          through = true
        } else if (district === 'midrise' && r1 > 0.95) {
          use = 'lot'
          kind = 'parking'
          fw = 14 + r3 * 8
          dp = 10 + r2 * 4
        } else if (r2 < towerP) {
          kind = KIND_FOR('downtown', r3)
          fw = 24 + r1 * 20
          dp = 24 + r3 * 20
          through = true
        } else {
          kind = KIND_FOR('midrise', r3)
          fw = kind === 'shop' ? 8 + r1 * 5 : kind === 'mixed' ? 12 + r1 * 6 : 16 + r1 * 10
          dp = kind === 'midrise' ? 14 + r2 * 8 : 11 + r2 * 6
        }
        set = district === 'downtown' ? 0.3 + r3 * 0.9 : 0.6 + r3 * 2.4
        gap = district === 'downtown' ? r3 * 1.5 : r3 < 0.3 ? 2 + r1 * 4 : 0.2
      } else {
        // the suburbs thin out toward the rim, a lot at a time
        if (rng() < 0.03 + smoothstep(0.86, 1.0, d) * 0.5) {
          s += 10 + rng() * 10
          continue
        }
        // a shop out here is the corner shop, which platting decides once it
        // knows which lots are on corners
        kind = KIND_FOR('suburb', r1)
        if (kind === 'shop') kind = 'house'
        fw = 9 + r2 * 4.5
        dp = 8.5 + r3 * 4
        set = baseSet + (rng() - 0.5) * 3 + (d > 0.85 ? 3 : 0)
        gap = 1.5 + rng() * 4
        back = 4.5
        sideM = 1.4
      }
      if (district !== 'suburb' || main) {
        // a core lot runs corner to corner: the last one on an edge takes
        // what is left rather than spilling into the cross street
        const left = to - s
        if (left < 8) break
        if (fw > left || left - fw < 8) fw = left
      }
      const mid = s + fw / 2
      if (mid > to) break
      const q2 = pointAt(st, mid)
      // the lot's side of the street, and the cardinal it faces
      const nx = -q2.uz * side
      const nz = q2.ux * side
      const fx = Math.abs(nx) > Math.abs(nz) ? -Math.sign(nx) : 0
      const fz = fx === 0 ? -Math.sign(nz) : 0
      const cos = -(nx * fx + nz * fz)
      if (cos < 0.86) {
        s += 8
        continue
      }
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos))
      // how deep the block is behind this frontage, for the lots that fill it
      if (district !== 'suburb' || use !== 'build') {
        const avail = depthBehind(net, st, q2.x + nx * (ROAD_HALF + WALK_W), q2.z + nz * (ROAD_HALF + WALK_W), -fx, -fz)
        const room = avail - set - 0.6
        if (through && dp > room * 0.6) dp = room
        else dp = Math.min(dp, room / 2 - 0.4)
        if (use === 'lot') dp = Math.min(dp, 14)
        dp = Math.min(dp, 48)
        if (dp < 8) {
          s += 6
          continue
        }
      }
      // the front wall is set back from the kerb along the street's true
      // normal, and pushed a little further on a bend so its near corner
      // keeps the setback too
      const push = ROAD_HALF + WALK_W + set + (fw / 2) * sin / Math.max(cos, 0.5)
      const bx = q2.x + nx * push - fx * (dp / 2)
      const bz = q2.z + nz * push - fz * (dp / 2)
      const w = fx ? dp : fw
      const dd = fx ? fw : dp
      // the envelope: footprint plus setback toward the street, yard behind
      // and a margin either side
      const ex = fx ? back : sideM
      const ez = fz ? back : sideM
      let x0 = bx - w / 2 - ex
      let x1 = bx + w / 2 + ex
      let z0 = bz - dd / 2 - ez
      let z1 = bz + dd / 2 + ez
      // ...and the front side runs out to the pavement's edge
      if (fx > 0) x1 = bx + w / 2 + set
      if (fx < 0) x0 = bx - w / 2 - set
      if (fz > 0) z1 = bz + dd / 2 + set
      if (fz < 0) z0 = bz - dd / 2 - set
      const height = kind === 'house' ? 8 : heightAtD(t, dn) * (0.7 + rng() * 0.6)
      out.push({
        id: 0, x: bx, z: bz, w, d: dd, face: Math.atan2(fx, fz), use, kind, height,
        district: main ? 'midrise' : district, x0, z0, x1, z1, cx: 0, cz: 0,
        pri: (main ? 0 : district === 'downtown' ? 1 : district === 'midrise' ? 2 : 3) * 1e5 + d * 1e3,
      })
      s += fw + gap
    }
  }
}

/** where a street is at arc length s, and which way it runs */
const pt = { x: 0, z: 0, ux: 1, uz: 0 }
const pointAt = (st: Street, s: number) => {
  const S = st.s
  let lo = 0
  let hi = S.length - 1
  if (s <= 0) lo = 0
  else if (s >= S[hi]) lo = hi - 1
  else {
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (S[m] <= s) lo = m
      else hi = m
    }
  }
  const i = Math.min(lo, S.length - 2)
  const len = S[i + 1] - S[i]
  const f = len > 0 ? Math.min(1, Math.max(0, (s - S[i]) / len)) : 0
  const ax = st.p[i * 2]
  const az = st.p[i * 2 + 1]
  const bx = st.p[i * 2 + 2]
  const bz = st.p[i * 2 + 3]
  pt.x = ax + (bx - ax) * f
  pt.z = az + (bz - az) * f
  pt.ux = len > 0 ? (bx - ax) / len : 1
  pt.uz = len > 0 ? (bz - az) / len : 0
  return pt
}

/** how far a block runs behind a frontage before the next street's
    pavement, up to a hundred: the ray from the pavement's edge against each
    other street's pavement band (a turning circle's too), solved rather
    than marched */
const depthBehind = (net: Network, st: Street, x: number, z: number, dx: number, dz: number) => {
  const L = 100
  const W = ROAD_HALF + WALK_W
  let best = L
  const list = piecesIn(net, Math.min(x, x + dx * L), Math.min(z, z + dz * L),
    Math.max(x, x + dx * L), Math.max(z, z + dz * L))
  for (const p of list) {
    if (p.street === st) continue
    if (p.bulb) {
      const R = p.r + WALK_W
      const ox = p.x - x
      const oz = p.z - z
      const along = ox * dx + oz * dz
      const perp2 = ox * ox + oz * oz - along * along
      if (along < 0 || perp2 > R * R) continue
      const t = along - Math.sqrt(R * R - perp2)
      if (t < best) best = Math.max(0, t)
      continue
    }
    const nx = -p.uz
    const nz = p.ux
    const s0 = (x - p.ax) * nx + (z - p.az) * nz
    const sd = dx * nx + dz * nz
    let t: number
    if (Math.abs(s0) <= W) t = 0
    else if (s0 * sd < 0) t = (Math.abs(s0) - W) / Math.abs(sd)
    else continue
    if (t >= best) continue
    const u = (x + dx * t - p.ax) * p.ux + (z + dz * t - p.az) * p.uz
    if (u < -W || u > p.len + W) continue
    best = t
  }
  return best
}

/** the lots of a town, platted on first request and cached with its plan;
    a job for the same reason the plan is (see planJob) */
function* platJob(net: Network): Generator<void, void> {
  const t = net.town
  const cands: Cand[] = net.reserved.map((r) => ({ ...r, pri: -1 }))
  for (const st of net.streets) {
    if (st.kind === 'avenue') continue
    walkSide(net, st, 1, cands)
    yield
    walkSide(net, st, -1, cands)
    yield
  }
  cands.sort((a, b) => a.pri - b.pri)
  yield
  let n = 0
  const taken = new Map<number, Parcel[]>()
  const out: Parcel[] = []
  const heli = { x: -9, z: 50 }
  for (const c of cands) {
    if ((++n & 31) === 0) yield
    if (t.home) {
      if (c.x0 < RESERVED.maxX + 4 && c.x1 > RESERVED.minX - 4 &&
        c.z0 < RESERVED.maxZ + 4 && c.z1 > RESERVED.minZ - 4) continue
      if (pointRect(heli.x, heli.z, c.x0, c.z0, c.x1, c.z1) < 14) continue
    }
    // clear of every street's pavement
    let ok = true
    const pad = ROAD_HALF + WALK_W - 0.1
    const near = piecesIn(net, c.x0, c.z0, c.x1, c.z1)
    for (const p of near) {
      if (pieceNear(p, c.x0, c.z0, c.x1, c.z1, pad)) {
        ok = false
        break
      }
    }
    if (!ok) continue
    // and of every lot already taken
    const i0 = Math.floor(c.x0 / CELL)
    const i1 = Math.floor(c.x1 / CELL)
    const j0 = Math.floor(c.z0 / CELL)
    const j1 = Math.floor(c.z1 / CELL)
    for (let j = j0; j <= j1 && ok; j++)
      for (let i = i0; i <= i1 && ok; i++) {
        const list = taken.get(cellKey(i, j))
        if (!list) continue
        for (const o of list) {
          if (c.x0 < o.x1 && c.x1 > o.x0 && c.z0 < o.z1 && c.z1 > o.z0) {
            ok = false
            break
          }
        }
      }
    if (!ok) continue
    const p: Parcel = {
      id: hash2(Math.round(c.x * 2), Math.round(c.z * 2), 0x7a3e),
      x: c.x, z: c.z, w: c.w, d: c.d, face: c.face, use: c.use, kind: c.kind,
      height: c.height, district: c.district,
      x0: c.x0, z0: c.z0, x1: c.x1, z1: c.z1,
      cx: chunkX(c.x), cz: chunkZ(c.z),
    }
    // a suburban lot on a corner is sometimes the corner shop
    if (p.use === 'build' && p.kind === 'house') {
      // two streets within reach of one lot is a corner
      let first: Street | null = null
      let streets = 0
      for (const q of near) {
        if (q.street === first) continue
        if (pieceNear(q, p.x0, p.z0, p.x1, p.z1, ROAD_HALF + WALK_W + 3)) {
          if (!first) first = q.street
          streets++
        }
      }
      if (streets >= 2 && rand2(p.id, 3, 0x2b1f) < 0.3) p.kind = 'shop'
    }
    out.push(p)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = cellKey(i, j)
        const list = taken.get(k)
        if (list) list.push(p)
        else taken.set(k, [p])
      }
  }
  // filed by every chunk the envelope touches: the owner builds it, the
  // others keep their trees out of it
  const byChunk = new Map<number, Parcel[]>()
  yield
  for (const [n, p] of out.entries()) {
    if ((n & 255) === 255) yield
    for (let j = chunkZ(p.z0); j <= chunkZ(p.z1); j++)
      for (let i = chunkX(p.x0); i <= chunkX(p.x1); i++) {
        const k = cellKey(i, j)
        const list = byChunk.get(k)
        if (list) list.push(p)
        else byChunk.set(k, [p])
      }
  }
  net.parcels = out
  net.byChunk = byChunk
}

/* ------------------------------------------------------------ cache -- */

interface Entry {
  net: Network
  /** the plan, while it is still being grown */
  plan: Generator<void, void> | null
  /** the lots, likewise */
  lots: Generator<void, void> | null
}

const cache = new Map<Town, Entry>()
/** a few towns' plans at once is all a walk or a flight ever touches; an
    evicted one rebuilds identically */
const CACHE_CAP = 12

let lastT: Town | null = null
let lastE: Entry | null = null

const entryOf = (t: Town): Entry => {
  // the same town is asked for thousands of times in a row
  if (t === lastT && lastE) return lastE
  const got = cache.get(t)
  lastT = t
  if (got) {
    lastE = got
    // most recently used last
    cache.delete(t)
    cache.set(t, got)
    return got
  }
  const net = emptyNet(t)
  const e: Entry = { net, plan: planJob(t, net), lots: null }
  lastE = e
  cache.set(t, e)
  if (cache.size > CACHE_CAP) {
    const first = cache.keys().next().value
    if (first) cache.delete(first)
  }
  return e
}

const finishPlan = (e: Entry) => {
  if (!e.plan) return
  while (!e.plan.next().done) { /* run it out */ }
  e.plan = null
}

/** a town's street plan, grown to the end now if it is not already */
export const networkOf = (t: Town): Network => {
  const e = entryOf(t)
  if (e.plan) finishPlan(e)
  return e.net
}

/** a town's plan with its lots, platted to the end now if need be */
export const parcelsOf = (t: Town): Network => {
  const e = entryOf(t)
  if (e.plan) finishPlan(e)
  if (!e.net.parcels) {
    e.lots ??= platJob(e.net)
    while (!e.lots.next().done) { /* run it out */ }
    e.lots = null
  }
  return e.net
}

/**
 * Grow a town's plan and lots a slice at a time: one step per `next()`,
 * each well under a millisecond. The far field runs this for every town
 * near a tile before it samples the tile's ground, so by the time anything
 * asks for a town synchronously (a chunk, a height) it is already built.
 */
export function* prepareTown(t: Town, lots: boolean): Generator<void, void> {
  const e = entryOf(t)
  while (e.plan) {
    if (e.plan.next().done) e.plan = null
    else yield
  }
  if (!lots || e.net.parcels) return
  e.lots ??= platJob(e.net)
  while (e.lots) {
    if (e.lots.next().done) e.lots = null
    else yield
  }
}

/** the lots of a town touching one chunk (each is built by its own
    `cx, cz`; the rest are there to keep trees out of it) */
export const parcelsInChunk = (t: Town, cx: number, cz: number): Parcel[] =>
  parcelsOf(t).byChunk!.get(cellKey(cx, cz)) ?? []
