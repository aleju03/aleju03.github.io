import * as THREE from 'three'
import { noStand, type Solid } from '../physics/collision'
import { rand2 } from './noise'
import { SURF } from './surface'
import { terrainY } from './terrain'
import type { Layer } from './streetMesh'
import type { Parcel } from './streets'
import {
  BALL, CONE12, SHED, aabb, box, panel, pick, put, shaft, type BuildOut,
} from './kitbash'

/*
  A town's square, furnished.

  streets.ts sets one block on the middle junction aside as the plaza, and
  for a long time chunk.ts paved it and filled it with a grove on a lattice,
  so a city's centre was a wood on a car park with a birdbath somewhere in it.
  A square reads as the busiest place in town because of what stands in the
  open of it, so the trees keep to a border, the middle is open paving with a
  lighter square round the fountain, and the open is filled with the things
  people stop at: a tiered fountain, benches facing it, a row of market stalls
  under striped awnings (a second row on a big square), a café's tables under
  parasols in one corner, and planters at the corners of the inner square.

  Everything is placed off the parcel's own rectangle and hashed on its centre
  (`rand2`), never streamed, so every chunk the square spans agrees about
  where each piece is, and each piece is built by the one chunk its centre
  falls in (`mine`). The shapes (fountain, stall frames and awnings, parasols,
  planters) build at every tier, because they are what the square looks like
  from a street away; the dressing (goods on the counters, chairs, the lamps
  under the awnings) only on a detailed build. Every solid registers its box:
  the basin rim and a bench seat are floors you can step onto, everything
  taller is `noStand`.
*/

const PAVE_LIGHT = new THREE.Color('#a39e90')
const PAVE_BAND = new THREE.Color('#77736a')
const STONE = '#a9a498'
const WATER = '#3d6f86'
const TIMBER = '#6b4f38'
const IRON = '#2f3133'
const AWNINGS = [
  ['#b8413a', '#e8e0cc'], ['#2f5a8a', '#e8e0cc'], ['#3f7a4a', '#efe6c8'],
  ['#c98a2e', '#f0e8d4'], ['#6a3f6e', '#e6dccb'],
]
const PARASOLS = ['#b8413a', '#e8e0cc', '#2f5a8a', '#3f7a4a', '#c98a2e']
const GOODS = ['#c8a34e', '#a8524a', '#5a7a4e', '#d88a3a', '#9e5e8a', '#e0d060', '#7a4f38']
const BLOOMS = ['#b8474a', '#d88a3a', '#c9a2c8', '#e0d060', '#d8d8d0']

/** the open middle's half-extents (x, z): the paving the border trees ring */
export const plazaInner = (p: Parcel) => ({
  hx: Math.max(6, (p.x1 - p.x0) / 2 - 7),
  hz: Math.max(6, (p.z1 - p.z0) / 2 - 7),
})

/**
 * The paving, and this chunk's share of the furniture of plaza `p`. `mine`
 * says whether a point is in the chunk building it.
 */
export const furnishPlaza = (
  out: BuildOut, layer: Layer, p: Parcel, mine: (x: number, z: number) => boolean,
) => {
  const cx = p.x
  const cz = p.z
  const { hx, hz } = plazaInner(p)
  /** the square's short half-extent, which everything is sized off, and
      its long axis, which the market runs down */
  const R = Math.min(hx, hz)
  const alongX = hx >= hz
  const hl = Math.max(hx, hz)
  /** a point `a` along the long axis and `c` across it */
  const at = (a: number, c: number): [number, number] =>
    alongX ? [cx + a, cz + c] : [cx + c, cz + a]
  const seed = (salt: number) => rand2(Math.round(cx), Math.round(cz), salt)
  const yAt = (x: number, z: number) => terrainY(x, z)

  // the open middle in a lighter stone with a dark band round it, laid over
  // the plaza's own paving
  const rect = (ex: number, ez: number) =>
    [cx - ex, cz - ez, cx + ex, cz - ez, cx + ex, cz + ez, cx - ex, cz + ez]
  layer.poly(rect(hx + 0.6, hz + 0.6), 0.045, PAVE_BAND, SURF.paving)
  layer.poly(rect(hx, hz), 0.05, PAVE_LIGHT, SURF.paving)

  if (mine(cx, cz)) fountain(out, cx, yAt(cx, cz), cz, R)

  // benches facing the fountain, a pair on each side of it
  const br = Math.min(R - 2.5, 8.5)
  if (R >= 10) {
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (const o of [-2.6, 2.6]) {
        const bx = cx + nx * br + nz * o
        const bz = cz + nz * br + nx * o
        if (mine(bx, bz)) bench(out, bx, yAt(bx, bz), bz, -nx, -nz)
      }
    }
  }

  if (R >= 13) {
    // the market: a row of stalls down each long side of a wide square (one
    // side of a narrow one), fronts in, with a gap opposite the fountain so
    // the benches keep their view; the café's tables at one end
    const rows = R >= 18 ? [1, -1] : [seed(0x51a2) < 0.5 ? 1 : -1]
    const off = R - 3.2
    const pitch = 5.6
    const cafe = hl >= 22
    const reach = hl - (cafe ? 13 : 6)
    for (const side of rows) {
      for (let a = -Math.floor(reach / pitch) * pitch; a <= reach; a += pitch) {
        if (Math.abs(a) < 7) continue
        const [sx, sz] = at(a, side * off)
        const [fx, fz] = at(0, -side)
        if (mine(sx, sz)) {
          stall(out, sx, yAt(sx, sz), sz, Math.sign(fx - cx), Math.sign(fz - cz),
            rand2(Math.round(sx), Math.round(sz), 0x5a11))
        }
      }
    }
    if (cafe) {
      const k = seed(0x51a3) < 0.5 ? 1 : -1
      for (const [da, dc] of [[-2.8, -2.8], [2.8, -2.8], [-2.8, 2.8], [2.8, 2.8], [-2.8, 0], [2.8, 0]] as const) {
        if (dc === 0 && R < 16) continue
        const [tx, tz] = at(k * (hl - 7) + da, dc * (R >= 16 ? 2 : 1))
        if (mine(tx, tz)) parasol(out, tx, yAt(tx, tz), tz, rand2(Math.round(tx * 2), Math.round(tz * 2), 0x5a12))
      }
    }
  } else if (R >= 9) {
    // a small square: a single stall and a single parasol either side
    const side = seed(0x51a2) < 0.5 ? 1 : -1
    const [sx, sz] = at(0, side * (R - 3))
    const [fx, fz] = at(0, -side)
    if (mine(sx, sz)) stall(out, sx, yAt(sx, sz), sz, Math.sign(fx - cx), Math.sign(fz - cz), seed(0x5a11))
    const [tx, tz] = at(0, -side * (R - 3.5))
    if (mine(tx, tz)) parasol(out, tx, yAt(tx, tz), tz, seed(0x5a12))
  }

  // planters on the open middle's corners, where the band turns
  if (R >= 8) {
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const px = cx + sx * (hx - 1.6)
        const pz = cz + sz * (hz - 1.6)
        if (mine(px, pz)) planter(out, px, yAt(px, pz), pz, rand2(Math.round(px), Math.round(pz), 0x5a13))
      }
  }
}

/** a tiered fountain: an octagonal basin you can step onto the rim of, the
    water, a column, a bowl and a jet over it */
const fountain = (out: BuildOut, x: number, y: number, z: number, R: number) => {
  const r = Math.min(6.5, Math.max(3.4, R * 0.34))
  shaft(out.solid, STONE, x, y - 0.4, z, r, 1.3, r, 8, Math.PI / 8, SURF.paving)
  shaft(out.solid, WATER, x, y + 0.72, z, r - 0.45, 0.1, r - 0.45, 8, Math.PI / 8)
  shaft(out.solid, STONE, x, y + 0.8, z, 0.55, 2.4, 0.45, 8, 0, SURF.paving)
  shaft(out.solid, STONE, x, y + 3.0, z, r * 0.22, 0.6, r * 0.42, 12, 0, SURF.paving)
  shaft(out.solid, WATER, x, y + 3.52, z, r * 0.38, 0.1, r * 0.38, 12)
  shaft(out.solid, STONE, x, y + 3.6, z, 0.28, 1.3, 0.18, 8, 0, SURF.paving)
  put(out.solid, CONE12, '#9cc4d2', x, y + 5.3, z, 0, 0, 0, 0.7, 1.0, 0.7)
  // the rim is a floor; the column and bowl are not
  const a = r * 0.92
  out.boxes.push(aabb(x, y - 1, z, a, y + 0.9, a) as Solid)
  out.boxes.push(noStand(aabb(x, y + 0.9, z, r * 0.42, y + 5.8, r * 0.42)))
}

/** a slatted bench facing (fx, fz), with a back and iron ends */
const bench = (out: BuildOut, x: number, y: number, z: number, fx: number, fz: number) => {
  const along = fx === 0
  const L = 3.6
  const sx = along ? L : 1.1
  const sz = along ? 1.1 : L
  box(out.solid, TIMBER, x, y + 1.0, z, sx, 0.16, sz, 0, SURF.plank)
  box(out.solid, TIMBER, x - fx * 0.5, y + 1.75, z - fz * 0.5,
    along ? L : 0.14, 0.9, along ? 0.14 : L, 0, SURF.plank)
  for (const e of [-1, 1]) {
    box(out.solid, IRON, x + (along ? e * (L / 2 - 0.2) : 0), y + 0.5, z + (along ? 0 : e * (L / 2 - 0.2)),
      along ? 0.14 : 1.0, 1.0, along ? 1.0 : 0.14, 0, SURF.none)
  }
  out.boxes.push(aabb(x, y - 1, z, sx / 2, y + 1.08, sz / 2) as Solid)
  out.boxes.push(noStand(aabb(x - fx * 0.5, y + 1.08, z - fz * 0.5,
    along ? L / 2 : 0.1, y + 2.2, along ? 0.1 : L / 2)))
}

/**
 * A market stall facing (fx, fz): a counter at the front, four posts, a
 * monopitch awning in two-colour stripes falling toward the customer, goods on
 * the counter and, after dark, a string of lamps under the awning's edge.
 */
const stall = (
  out: BuildOut, x: number, y: number, z: number, fx: number, fz: number, roll: number,
) => {
  const W = 4.6
  const D = 3.2
  const along = fx === 0
  // the counter, across the front
  const kx = x + fx * (D / 2 - 0.55)
  const kz = z + fz * (D / 2 - 0.55)
  box(out.solid, TIMBER, kx, y + 0.65, kz, along ? W : 1.1, 1.3, along ? 1.1 : W, 0, SURF.plank)
  box(out.solid, '#8a6a48', kx, y + 1.36, kz, along ? W + 0.2 : 1.3, 0.12, along ? 1.3 : W + 0.2, 0,
    SURF.plank)
  // a back board, so the stall reads as a booth from behind
  box(out.solid, TIMBER, x - fx * (D / 2 - 0.08), y + 1.0, z - fz * (D / 2 - 0.08),
    along ? W : 0.12, 2.0, along ? 0.12 : W, 0, SURF.plank)
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      const px = x + (along ? a * (W / 2 - 0.1) : b * (D / 2 - 0.1))
      const pz = z + (along ? b * (D / 2 - 0.1) : a * (W / 2 - 0.1))
      // the awning sheds toward the customer, so the front posts are the
      // short pair (`b` runs front to back along the facing)
      const h = b * (along ? fz : fx) > 0 ? 4.4 : 5.2
      box(out.solid, IRON, px, y + h / 2, pz, 0.14, h, 0.14, 0, SURF.none)
    }
  // the awning, in stripes: SHED is high at +z, so its yaw points the high
  // edge at the back of the stall
  const [c0, c1] = pick(AWNINGS, roll)
  const yaw = Math.atan2(-fx, -fz)
  const stripes = 5
  for (let i = 0; i < stripes; i++) {
    const o = ((i + 0.5) / stripes - 0.5) * (W + 0.6)
    put(out.solid, SHED, i % 2 ? c1 : c0,
      x + (along ? o : fx * 0.35), y + 4.4, z + (along ? fz * 0.35 : o),
      0, yaw, 0, (W + 0.6) / stripes + 0.01, 0.8, D + 1.0, SURF.none)
  }
  // the awning's front valance, where the stripes are read from across the square
  panel(out.solid, c0, x + fx * (D / 2 + 0.85), y + 4.2, z + fz * (D / 2 + 0.85),
    W + 0.6, 0.4, Math.atan2(fx, fz))
  out.boxes.push(noStand(aabb(kx, y - 1, kz, (along ? W : 1.1) / 2, y + 1.42, (along ? 1.1 : W) / 2)))
  out.boxes.push(noStand(aabb(x - fx * (D / 2 - 0.08), y - 1, z - fz * (D / 2 - 0.08),
    along ? W / 2 : 0.1, y + 2.0, along ? 0.1 : W / 2)))
  if (!out.detailed) return
  // goods on the counter: crates and heaps
  for (let i = 0; i < 4; i++) {
    const r = rand2(Math.round(x * 4) + i, Math.round(z * 4), 0x5a21)
    const o = (i - 1.5) * (W / 4.4)
    const gh = 0.3 + r * 0.35
    box(out.solid, pick(GOODS, rand2(i, Math.round(roll * 997), 0x5a22)),
      kx + (along ? o : 0), y + 1.42 + gh / 2, kz + (along ? 0 : o),
      along ? 0.8 : 0.7, gh, along ? 0.7 : 0.8, 0, SURF.none)
  }
  // lamps strung under the front edge, lit with the windows
  for (let i = 0; i < 5; i++) {
    const o = (i / 4 - 0.5) * W
    put(out.glass, BALL, '#ffd9a0', x + (along ? o : fx * (D / 2 + 0.6)), y + 4.0,
      z + (along ? fz * (D / 2 + 0.6) : o), 0, 0, 0, 0.26, 0.26, 0.26)
  }
}

/** a café table under a parasol, with two chairs */
const parasol = (out: BuildOut, x: number, y: number, z: number, roll: number) => {
  shaft(out.solid, IRON, x, y, z, 0.07, 4.2, 0.07, 6)
  put(out.solid, CONE12, pick(PARASOLS, roll), x, y + 4.3, z, 0, 0, 0, 4.2, 0.9, 4.2, SURF.none)
  shaft(out.solid, '#d8d2c4', x, y + 1.1, z, 0.75, 0.1, 0.75, 12)
  shaft(out.solid, IRON, x, y, z, 0.1, 1.1, 0.1, 6)
  out.boxes.push(noStand(aabb(x, y - 1, z, 0.8, y + 1.2, 0.8)))
  if (!out.detailed) return
  for (const s of [-1, 1]) {
    const hx = x + s * 1.35
    box(out.solid, IRON, hx, y + 0.45, z, 0.7, 0.9, 0.7, 0, SURF.none)
    box(out.solid, IRON, hx + s * 0.32, y + 1.2, z, 0.08, 0.9, 0.7, 0, SURF.none)
  }
}

/** a stone planter with a round shrub in it and flowers at its feet */
const planter = (out: BuildOut, x: number, y: number, z: number, roll: number) => {
  box(out.solid, STONE, x, y + 0.5, z, 2.4, 1.0, 2.4, 0, SURF.paving)
  put(out.solid, BALL, '#3f6a34', x, y + 1.9, z, 0, 0, 0, 2.2, 2.0, 2.2)
  const bloom = pick(BLOOMS, roll)
  for (const [dx, dz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]] as const) {
    box(out.solid, bloom, x + dx, y + 1.08, z + dz, 0.5, 0.2, 0.5, 0, SURF.none)
  }
  out.boxes.push(noStand(aabb(x, y - 1, z, 1.2, y + 1.05, 1.2)))
}
