import * as THREE from 'three'
import type { MeshBuilder } from '../core/geometry'
import { CHUNK, GRID, OFF_X, OFF_Z, inReserved, originX, originZ } from './grid'
import { terrainY } from './terrain'
import { CURB_H, ROAD_HALF, WALK_W, nearestTown, townsNear } from './settlements'
import { SURF } from './surface'
import {
  liveOf, networkOf, pieceNear, piecesIn, probe, type Bulb, type Piece, type Seg, type Street,
} from './streets'

/*
  The streets of one chunk, as geometry: asphalt, pavements, kerbs, the
  dashed centre line and the lamps, for whatever part of a town's plan
  (streets.ts) crosses this chunk.

  Streets run any way now, so nothing here assumes an axis. A street is a
  polyline; its deck is a ribbon offset either side of it, mitred at every
  vertex so a bend has no wedge missing on the outside and no overlap on
  the inside. Where two streets meet, each lays its own asphalt through the
  junction (the same colour at the same height, so the overlap is invisible)
  and each pavement stops where it would run onto another street's asphalt,
  which is found by sampling rather than solved: a pavement is cut wherever a
  point on it is inside some other street's carriageway, or inside a
  turning circle. That one rule does T-junctions, crossroads at any angle,
  the mouth of a cul-de-sac and the ring of pavement round its end.

  The deck does not sit on the ground, it *copies* it. Every polygon is cut
  on the terrain lattice (both axes and the diagonal each cell is split on,
  see terrain.ts) and each piece is laid at terrainY + lift, so it lies on
  the drawn triangles exactly. A deck spanning a crease is a chord across
  it, and wherever the crease is convex the ground comes up through the
  asphalt: 2% of every deck once did, 0.83 units proud at worst. Raising the
  lift is not the lever; it would need seventeen times the clearance and
  reads as a lip at the kerb. Cutting also clips to this chunk's own cells,
  so a street crossing a chunk border is laid half by each, seamlessly.

  Lamps are placed by arc length along their street, so each one is decided
  once whichever chunk asks, and built by the chunk it stands in.
*/

/** how far the deck floats over the ground it copies: enough to beat depth
    precision at the far end of the ring, small enough to never show a lip */
export const LIFT = 0.05

const rq0 = new THREE.Vector3()
const rq1 = new THREE.Vector3()
const rq2 = new THREE.Vector3()
const rq3 = new THREE.Vector3()

/** one chunk's hand for laying things on the drawn ground */
export interface Layer {
  /** a convex polygon (x, z interleaved, either winding), laid face up
      `lift` over the ground and cut on every crease inside this chunk */
  poly: (pts: number[], lift: number, c: THREE.Color, surf?: number) => void
  /** a vertical face from (ax, az) to (bx, bz), `y0` to `y1` over the
      ground, facing (ox, oz); cut at every crease it crosses in this chunk */
  face: (
    ax: number, az: number, bx: number, bz: number,
    y0: number, y1: number, ox: number, oz: number, c: THREE.Color, surf?: number,
  ) => void
}

/** clip a polygon to one half-plane: keep a*x + b*z + c >= 0 */
const clipHalf = (pts: number[], a: number, b: number, c: number) => {
  const out: number[] = []
  const n = pts.length / 2
  for (let i = 0; i < n; i++) {
    const x0 = pts[i * 2]
    const z0 = pts[i * 2 + 1]
    const j = (i + 1) % n
    const x1 = pts[j * 2]
    const z1 = pts[j * 2 + 1]
    const f0 = a * x0 + b * z0 + c
    const f1 = a * x1 + b * z1 + c
    if (f0 >= -1e-9) out.push(x0, z0)
    if ((f0 > 1e-9 && f1 < -1e-9) || (f0 < -1e-9 && f1 > 1e-9)) {
      const t = f0 / (f0 - f1)
      out.push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)
    }
  }
  return out
}

export const makeLayer = (cx: number, cz: number, out: MeshBuilder): Layer => {
  const ox = originX(cx)
  const oz = originZ(cz)
  const N = CHUNK / GRID
  const lay = (x: number, z: number, lift: number, v: THREE.Vector3) =>
    v.set(x, terrainY(x, z) + lift, z)

  /** a convex piece already inside one ground triangle: any triangulation of
      it samples the same plane, so quads are free and go out two at a time */
  const fan = (p: number[], lift: number, c: THREE.Color) => {
    const n = p.length / 2
    if (n < 3) return
    const ny = (p[3] - p[1]) * (p[4] - p[0]) - (p[2] - p[0]) * (p[5] - p[1])
    // clipping leaves slivers where an edge grazes a crease; they are worth
    // nothing and their normals are noise
    if (Math.abs(ny) < 1e-9) return
    const idx = (k: number) => (ny > 0 ? k : k === 0 ? 0 : n - k)
    let i = 1
    for (; i + 2 < n; i += 2) {
      const a = idx(0)
      const b = idx(i)
      const cc = idx(i + 1)
      const d = idx(i + 2)
      lay(p[a * 2], p[a * 2 + 1], lift, rq0)
      lay(p[b * 2], p[b * 2 + 1], lift, rq1)
      lay(p[cc * 2], p[cc * 2 + 1], lift, rq2)
      lay(p[d * 2], p[d * 2 + 1], lift, rq3)
      out.quad(rq0, rq1, rq2, rq3, c)
    }
    if (i + 1 < n) {
      const a = idx(0)
      const b = idx(i)
      const cc = idx(i + 1)
      lay(p[a * 2], p[a * 2 + 1], lift, rq0)
      lay(p[b * 2], p[b * 2 + 1], lift, rq1)
      lay(p[cc * 2], p[cc * 2 + 1], lift, rq2)
      out.tri(rq0, rq1, rq2, c)
    }
  }

  const poly = (pts: number[], lift: number, c: THREE.Color, surf: number = SURF.none) => {
    out.surface = surf
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i])
      minZ = Math.min(minZ, pts[i + 1]); maxZ = Math.max(maxZ, pts[i + 1])
    }
    const i0 = Math.max(0, Math.floor((minX - ox) / GRID))
    const i1 = Math.min(N, Math.ceil((maxX - ox) / GRID))
    const j0 = Math.max(0, Math.floor((minZ - oz) / GRID))
    const j1 = Math.min(N, Math.ceil((maxZ - oz) / GRID))
    for (let j = j0; j < j1; j++)
      for (let i = i0; i < i1; i++) {
        const x0 = ox + i * GRID
        const z0 = oz + j * GRID
        let p = clipHalf(pts, 1, 0, -x0)
        if (p.length < 6) continue
        p = clipHalf(p, -1, 0, x0 + GRID)
        if (p.length < 6) continue
        p = clipHalf(p, 0, 1, -z0)
        if (p.length < 6) continue
        p = clipHalf(p, 0, -1, z0 + GRID)
        if (p.length < 6) continue
        // the cell's diagonal, (x - OFF_X) - (z - OFF_Z) = k * GRID, which
        // buildGround splits every cell on
        const k = (cx * N + i) - (cz * N + j)
        const c0 = -OFF_X + OFF_Z - k * GRID
        const a = clipHalf(p, 1, -1, c0)
        if (a.length >= 6) fan(a, lift, c)
        const b = clipHalf(p, -1, 1, -c0)
        if (b.length >= 6) fan(b, lift, c)
      }
    out.surface = SURF.none
  }

  const face = (
    ax: number, az: number, bx: number, bz: number,
    y0: number, y1: number, fx: number, fz: number, c: THREE.Color, surf: number = SURF.none,
  ) => {
    const dx = bx - ax
    const dz = bz - az
    // clip to the chunk (Liang-Barsky)
    let t0 = 0
    let t1 = 1
    const edge = (p: number, q: number) => {
      if (Math.abs(p) < 1e-12) return q >= 0
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
    if (!(edge(-dx, ax - ox) && edge(dx, ox + CHUNK - ax) &&
      edge(-dz, az - oz) && edge(dz, oz + CHUNK - az))) return
    if (t1 - t0 < 1e-6) return
    // every crease the edge crosses: lattice columns, rows and diagonals,
    // each an arithmetic progression along the edge
    const ts = [t0, t1]
    const cuts = (v0: number, dv: number, origin: number) => {
      if (Math.abs(dv) < 1e-9) return
      const a = v0 + dv * t0
      const b = v0 + dv * t1
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      for (let k = Math.ceil((lo - origin) / GRID); origin + k * GRID < hi; k++) {
        const t = (origin + k * GRID - v0) / dv
        if (t > t0 + 1e-6 && t < t1 - 1e-6) ts.push(t)
      }
    }
    cuts(ax, dx, OFF_X)
    cuts(az, dz, OFF_Z)
    cuts((ax - OFF_X) - (az - OFF_Z), dx - dz, 0)
    ts.sort((a, b) => a - b)
    out.surface = surf
    // the builder's quad faces (-dz, dx) of its first edge
    const flip = -dz * fx + dx * fz < 0
    for (let i = 0; i + 1 < ts.length; i++) {
      if (ts[i + 1] - ts[i] < 1e-6) continue
      let pa = ts[i]
      let pb = ts[i + 1]
      if (flip) [pa, pb] = [pb, pa]
      const xa = ax + dx * pa
      const za = az + dz * pa
      const xb = ax + dx * pb
      const zb = az + dz * pb
      lay(xa, za, y0, rq0)
      lay(xb, zb, y0, rq1)
      lay(xb, zb, y1, rq2)
      lay(xa, za, y1, rq3)
      out.quad(rq0, rq1, rq2, rq3, c)
    }
    out.surface = SURF.none
  }
  return { poly, face }
}

const ASPHALT = new THREE.Color('#2b2d31')
const WALK = new THREE.Color('#6b6b64')
const KERB = new THREE.Color('#7a786f')
const LINE = new THREE.Color('#a89a6b')

/** lamp spacing along a street, in units */
const LAMP_EVERY = 27

/** asked for each lamp this chunk owns: where, which way the arm reaches
    (yaw), and a stable id */
export type LampFn = (x: number, y: number, z: number, yaw: number, id: string) => void

/**
 * Lay every street of every town near this chunk that crosses it. Returns
 * nothing: lamps go out through `lamp`, everything else into `out`.
 */
export function* buildStreetsSteps(
  cx: number, cz: number, out: MeshBuilder, detailed: boolean, lamp: LampFn,
): Generator<void, void, void> {
  const ox = originX(cx)
  const oz = originZ(cz)
  const layer = makeLayer(cx, cz, out)
  const towns = townsNear(ox + CHUNK / 2, oz + CHUNK / 2)
  const shared = towns.length > 1
  for (const t of towns) {
    const net = networkOf(t)
    const pieces = piecesIn(net, ox - 8, oz - 8, ox + CHUNK + 8, oz + CHUNK + 8)
    if (!pieces.length) continue
    /** a point belongs to this town's streets only where roadAt would say so */
    const ours = (x: number, z: number) => !shared || nearestTown(x, z) === t
    const streets = new Set<Street>()
    const bulbs: Bulb[] = []
    for (const p of pieces) {
      if (!pieceNear(p, ox, oz, ox + CHUNK, oz + CHUNK, ROAD_HALF + WALK_W + 1)) continue
      if (p.bulb) bulbs.push(p)
      else streets.add(p.street)
    }
    for (const st of streets) {
      yield
      layStreet(st, pieces, layer, ox, oz, detailed, lamp, ours)
    }
    for (const b of bulbs) {
      yield
      layBulb(b, pieces, layer, ours)
    }
  }
}

/** is a point on some other street's carriageway (or any turning circle) */
const onOther = (x: number, z: number, st: Street | null, others: Piece[]) => {
  for (const p of others) {
    if (!p.bulb && p.street === st) continue
    if (x < p.x0 - ROAD_HALF || x > p.x1 + ROAD_HALF || z < p.z0 - ROAD_HALF || z > p.z1 + ROAD_HALF) continue
    if (probe(p, x, z) < ROAD_HALF - 0.05 && liveOf(p, 0) > 0.3) return true
  }
  return false
}

/** the stretch of a segment, as a fraction range, that another piece's box
    (grown by `pad`) overlaps when projected onto it */
const shadowOn = (seg: Seg, p: Piece, pad: number): [number, number] => {
  let lo = Infinity
  let hi = -Infinity
  for (const cx of [p.x0 - pad, p.x1 + pad])
    for (const cz of [p.z0 - pad, p.z1 + pad]) {
      const u = ((cx - seg.ax) * seg.ux + (cz - seg.az) * seg.uz) / seg.len
      lo = Math.min(lo, u)
      hi = Math.max(hi, u)
    }
  return [lo, hi]
}

const layStreet = (
  st: Street, pieces: Piece[], layer: Layer, ox: number, oz: number,
  detailed: boolean, lamp: LampFn, ours: (x: number, z: number) => boolean,
) => {
  const P = st.p
  const n = P.length / 2
  const closed = n > 2 && Math.hypot(P[0] - P[(n - 1) * 2], P[1] - P[(n - 1) * 2 + 1]) < 0.05
  // the mitred normal at each vertex, scaled so a ribbon offset along it
  // keeps its width through the bend
  const nx = new Float64Array(n)
  const nz = new Float64Array(n)
  const segDir = (i: number): [number, number] => {
    const dx = P[i * 2 + 2] - P[i * 2]
    const dz = P[i * 2 + 3] - P[i * 2 + 1]
    const l = Math.hypot(dx, dz) || 1
    return [dx / l, dz / l]
  }
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? segDir(i - 1) : closed ? segDir(n - 2) : null
    const next = i < n - 1 ? segDir(i) : closed ? segDir(0) : null
    const a = prev ?? next!
    const b = next ?? prev!
    let tx = a[0] + b[0]
    let tz = a[1] + b[1]
    const tl = Math.hypot(tx, tz)
    if (tl < 1e-6) {
      tx = b[0]
      tz = b[1]
    } else {
      tx /= tl
      tz /= tl
    }
    const scale = 1 / Math.max(0.55, tx * b[0] + tz * b[1])
    nx[i] = -tz * scale
    nz[i] = tx * scale
  }
  /** a point at fraction f along segment i, `o` off the centreline */
  const at = (i: number, f: number, o: number): [number, number] => {
    const ax = P[i * 2] + nx[i] * o
    const az = P[i * 2 + 1] + nz[i] * o
    const bx = P[i * 2 + 2] + nx[i + 1] * o
    const bz = P[i * 2 + 3] + nz[i + 1] * o
    return [ax + (bx - ax) * f, az + (bz - az) * f]
  }
  const segs = pieces.filter((p): p is Seg => !p.bulb && p.street === st)
  const reach = ROAD_HALF + WALK_W + 1
  for (const seg of segs) {
    if (!pieceNear(seg, ox, oz, ox + CHUNK, oz + CHUNK, reach)) continue
    const i = seg.i
    const L = seg.len
    const bx0 = Math.min(seg.ax, seg.ax + seg.ux * L) - 12
    const bx1 = Math.max(seg.ax, seg.ax + seg.ux * L) + 12
    const bz0 = Math.min(seg.az, seg.az + seg.uz * L) - 12
    const bz1 = Math.max(seg.az, seg.az + seg.uz * L) + 12
    const others = pieces.filter((p) => (p.bulb || p.street !== st) &&
      pieceNear(p, bx0, bz0, bx1, bz1, ROAD_HALF))
    // the part of the segment that can reach this chunk, as a fraction range
    let f0 = 0
    let f1 = 1
    {
      const pad = reach + 1
      const dx = seg.ux * L
      const dz = seg.uz * L
      const edge = (p: number, q: number) => {
        if (Math.abs(p) < 1e-12) return q >= 0
        const u = q / p
        if (p < 0) { if (u > f1) return false; if (u > f0) f0 = u }
        else { if (u < f0) return false; if (u < f1) f1 = u }
        return true
      }
      if (!(edge(-dx, seg.ax - (ox - pad)) && edge(dx, ox + CHUNK + pad - seg.ax) &&
        edge(-dz, seg.az - (oz - pad)) && edge(dz, oz + CHUNK + pad - seg.az))) continue
    }
    // presence and ownership, per four-unit step
    const steps = Math.max(1, Math.ceil(L / GRID))
    const live: boolean[] = []
    for (let s = 0; s < steps; s++) {
      const fm = (s + 0.5) / steps
      if (fm < f0 - 1 / steps || fm > f1 + 1 / steps) {
        live.push(false)
        continue
      }
      const mx = seg.ax + seg.ux * L * fm
      const mz = seg.az + seg.uz * L * fm
      live.push(liveOf(seg, L * fm) >= 0.35 && ours(mx, mz))
    }
    const liveAt = (f: number) => live[Math.min(steps - 1, Math.max(0, Math.floor(f * steps)))]

    // asphalt, one polygon per run of live steps
    for (let s = 0; s < steps;) {
      if (!live[s]) { s++; continue }
      let e = s
      while (e + 1 < steps && live[e + 1]) e++
      const a = s / steps
      const b = (e + 1) / steps
      const [x0, z0] = at(i, a, -ROAD_HALF)
      const [x1, z1] = at(i, b, -ROAD_HALF)
      const [x2, z2] = at(i, b, ROAD_HALF)
      const [x3, z3] = at(i, a, ROAD_HALF)
      layer.poly([x0, z0, x1, z1, x2, z2, x3, z3], LIFT, ASPHALT, SURF.asphalt)
      s = e + 1
    }

    // pavements and kerbs, cut wherever they would run onto another street.
    // Only the stretches some other street's box overlaps need sampling;
    // everywhere else the pavement simply runs
    const shadows = others.map((p) => shadowOn(seg, p, ROAD_HALF + WALK_W + 1))
    const shaded = (f: number) => shadows.some(([a, b]) => f >= a && f <= b)
    const df = Math.min(0.5 / L, 0.25)
    for (const sgn of [-1, 1]) {
      const oIn = sgn * ROAD_HALF
      const oOut = sgn * (ROAD_HALF + WALK_W)
      let runStart = -1
      const flush = (fe: number) => {
        if (runStart < 0) return
        const a = Math.max(0, runStart)
        const b = Math.min(1, fe)
        runStart = -1
        if (b - a < 1e-4) return
        const [x0, z0] = at(i, a, oIn)
        const [x1, z1] = at(i, b, oIn)
        const [x2, z2] = at(i, b, oOut)
        const [x3, z3] = at(i, a, oOut)
        layer.poly([x0, z0, x1, z1, x2, z2, x3, z3], CURB_H, WALK, SURF.paving)
        // the kerb's face looks back at the road it holds up
        layer.face(x0, z0, x1, z1, LIFT, CURB_H, -seg.uz * -sgn, seg.ux * -sgn, KERB, SURF.paving)
      }
      const lo = Math.max(0, f0 - df)
      const hi = Math.min(1, f1 + df)
      for (let f = lo; f <= hi + 1e-9; f += df) {
        const fc = Math.min(f, 1)
        let ok = liveAt(fc)
        if (ok && shaded(fc)) {
          for (const o of [oIn * 1.03, (oIn + oOut) / 2, oOut - sgn * 0.1]) {
            const [x, z] = at(i, fc, o)
            if (onOther(x, z, st, others)) {
              ok = false
              break
            }
          }
        }
        if (ok && runStart < 0) runStart = f === lo ? lo : fc - df / 2
        if (!ok) flush(fc - df / 2)
      }
      flush(hi)
    }

    if (!detailed) continue
    // a dashed centre line, kept out of junctions
    for (let s = 0; s < steps; s++) {
      if (!live[s]) continue
      const a = s / steps
      const b = (s + 1) / steps
      const arc = st.s[i] + L * (a + b) / 2
      if (Math.floor(arc / GRID) % 2) continue
      const [mx, mz] = at(i, (a + b) / 2, 0)
      let clear = true
      for (const p of others) {
        if (probe(p, mx, mz) < ROAD_HALF + 3) {
          clear = false
          break
        }
      }
      if (!clear) continue
      const u0 = a + (b - a) * 0.22
      const u1 = b - (b - a) * 0.22
      const [x0, z0] = at(i, u0, -0.11)
      const [x1, z1] = at(i, u1, -0.11)
      const [x2, z2] = at(i, u1, 0.11)
      const [x3, z3] = at(i, u0, 0.11)
      layer.poly([x0, z0, x1, z1, x2, z2, x3, z3], LIFT + 0.012, LINE)
    }
    // lamps, by arc length along the street so each is decided once
    const phase = st.seed % LAMP_EVERY
    for (let k = Math.ceil((st.s[i] - phase) / LAMP_EVERY); ; k++) {
      const arc = phase + k * LAMP_EVERY
      if (arc >= st.s[i + 1]) break
      const f = (arc - st.s[i]) / L
      if (!liveAt(f)) continue
      const sgn = k % 2 ? 1 : -1
      const [lx, lz] = at(i, f, sgn * (ROAD_HALF + WALK_W * 0.75))
      if (lx < ox || lx >= ox + CHUNK || lz < oz || lz >= oz + CHUNK) continue
      // never on the property's frontage, where it would stand squarely
      // between the gate and the front door
      if (inReserved(lx, lz, 8)) continue
      let clear = true
      for (const p of others) {
        if (probe(p, lx, lz) < ROAD_HALF + WALK_W + 2) {
          clear = false
          break
        }
      }
      if (!clear) continue
      // the arm reaches back over the road: local +x onto the direction from
      // the mast to the centreline
      const tx = -seg.uz * -sgn
      const tz = seg.ux * -sgn
      lamp(lx, terrainY(lx, lz), lz, Math.atan2(-tz, tx), `${st.id}:${k}`)
    }
  }
}

/** a turning circle: an asphalt disc, and a ring of pavement round it with
    a gap where its street comes in */
const layBulb = (b: Bulb, pieces: Piece[], layer: Layer, ours: (x: number, z: number) => boolean) => {
  if (liveOf(b, 0) < 0.35 || !ours(b.x, b.z)) return
  const K = 20
  const disc: number[] = []
  for (let k = 0; k < K; k++) {
    const a = (k / K) * Math.PI * 2
    disc.push(b.x + Math.cos(a) * b.r, b.z + Math.sin(a) * b.r)
  }
  layer.poly(disc, LIFT, ASPHALT, SURF.asphalt)
  const segs = pieces.filter((p) => !p.bulb &&
    pieceNear(p, b.x - b.r - 3, b.z - b.r - 3, b.x + b.r + 3, b.z + b.r + 3, ROAD_HALF))
  const r0 = b.r
  const r1 = b.r + WALK_W
  for (let k = 0; k < K; k++) {
    const a0 = (k / K) * Math.PI * 2
    const a1 = ((k + 1) / K) * Math.PI * 2
    const am = (a0 + a1) / 2
    let blocked = false
    for (const rr of [r0 + 0.1, (r0 + r1) / 2, r1 - 0.1]) {
      const x = b.x + Math.cos(am) * rr
      const z = b.z + Math.sin(am) * rr
      for (const p of segs) {
        if (probe(p, x, z) < ROAD_HALF - 0.05) {
          blocked = true
          break
        }
      }
      if (blocked) break
    }
    if (blocked) continue
    const c0 = Math.cos(a0)
    const s0 = Math.sin(a0)
    const c1 = Math.cos(a1)
    const s1 = Math.sin(a1)
    layer.poly([
      b.x + c0 * r0, b.z + s0 * r0, b.x + c0 * r1, b.z + s0 * r1,
      b.x + c1 * r1, b.z + s1 * r1, b.x + c1 * r0, b.z + s1 * r0,
    ], CURB_H, WALK, SURF.paving)
    layer.face(b.x + c0 * r0, b.z + s0 * r0, b.x + c1 * r0, b.z + s1 * r0,
      LIFT, CURB_H, -Math.cos(am), -Math.sin(am), KERB, SURF.paving)
  }
}
