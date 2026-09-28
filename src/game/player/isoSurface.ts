/*
  A signed distance field turned into one closed triangle mesh: surface nets
  over a regular grid, then every vertex walked onto the true surface along
  the field's own gradient, which is also where its normal comes from.

  This is what lets the player character be *one* surface. The body is
  written as a field (a bean, limb capsules, feet and mittens, joined by a
  smooth minimum), and a field has no seams to hide: wherever two parts meet,
  the blend has already decided the fillet, and the polygonizer only ever
  sees one skin. The earlier bodies were separate parametric patches pushed
  into each other, and up close every joint read as a part taped on.

  Surface nets rather than marching cubes because it produces one vertex per
  surface cell (so about half the vertices for the same grid) and quads that
  are already well shaped; the Newton projection afterwards removes the
  grid's terracing, which is what a naive net looks like on a smooth shape.

  The grid is sampled sparsely. A coarse pass evaluates the field once per
  block of cells, and a block whose centre is further from the surface than
  its own half-diagonal (with a margin for the field not being an exact
  distance) cannot contain it, so its points are filled with that sign and
  never evaluated. On the body that skips roughly nine points in ten, which
  is most of the difference between a variant built in a few milliseconds
  and one that hitches a frame when a stranger in a new hat walks past.

  The result is always watertight, because the field is positive on the
  padded boundary of the grid, so every sign change is enclosed. Headless:
  plain arithmetic and typed arrays, no THREE, runs in Node.
*/

export type Field = (x: number, y: number, z: number) => number

export interface IsoMesh {
  pos: Float32Array
  nrm: Float32Array
  idx: Uint32Array
}

/** corner offsets of a cell, and the 12 edges as corner pairs */
const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
] as const
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
] as const
const EDGE_FLAT = new Uint8Array(EDGES.flat())

/**
 * Polygonize `f` inside [lo, hi] at grid spacing `h`. `lip` is how far the
 * field may overstate a distance (1 for an exact SDF; a smooth-min of scaled
 * shapes wants a little more), used only by the sparse skip.
 */
export function surfaceNets(
  f: Field,
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
  h: number,
  lip = 1.35,
): IsoMesh {
  return drain(surfaceNetsSteps(f, lo, hi, h, lip))
}

/** a generator run to its end, synchronously */
export const drain = <T>(g: Generator<void, T, void>): T => {
  let r = g.next()
  while (!r.done) r = g.next()
  return r.value
}

/** how much work (roughly, field evaluations) passes between yields */
const SLICE = 600

/**
 * The same, as a generator that yields every few hundred field evaluations,
 * so a caller can spread one mesh over several frames (see bodyShape's
 * `pumpBodyBuilds`). Returns the mesh.
 */
export function* surfaceNetsSteps(
  f: Field,
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
  h: number,
  lip = 1.35,
): Generator<void, IsoMesh, void> {
  let work = 0
  // one cell of padding all round, so the boundary is always outside
  const x0 = lo[0] - h
  const y0 = lo[1] - h
  const z0 = lo[2] - h
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 3
  const ny = Math.ceil((hi[1] - lo[1]) / h) + 3
  const nz = Math.ceil((hi[2] - lo[2]) / h) + 3
  const sx = 1
  const sy = nx
  const sz = nx * ny
  const val = new Float32Array(nx * ny * nz)

  // --- the sparse sample. Only blocks near the surface are evaluated, and
  // everything after this only ever visits them: a cell or an edge with a
  // sign change lies wholly inside a near block's points (its own block's
  // range includes the far boundary), so a far block has nothing to give
  const BLK = 4
  const reach = ((BLK * h) * Math.sqrt(3)) / 2 * lip + h
  const near: number[] = []
  for (let bz = 0; bz < nz - 1; bz += BLK)
    for (let by = 0; by < ny - 1; by += BLK)
      for (let bx = 0; bx < nx - 1; bx += BLK) {
        const ex = Math.min(nx - 1, bx + BLK)
        const ey = Math.min(ny - 1, by + BLK)
        const ez = Math.min(nz - 1, bz + BLK)
        const c = f(x0 + ((bx + ex) / 2) * h, y0 + ((by + ey) / 2) * h, z0 + ((bz + ez) / 2) * h)
        if (++work > SLICE) {
          work = 0
          yield
        }
        if (Math.abs(c) > reach) continue
        near.push(bx, by, bz)
        work += 125
        for (let k = bz; k <= ez; k++)
          for (let j = by; j <= ey; j++)
            for (let i = bx; i <= ex; i++) {
              const at = i + j * sy + k * sz
              if (val[at] !== 0) continue // shared with a block already done
              let v = f(x0 + i * h, y0 + j * h, z0 + k * h)
              // an exact zero has no sign; nudge it outward. The padding
              // ring is outside by construction
              if (v === 0) v = 1e-7
              if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) v = Math.max(v, 1e-3)
              val[at] = v
            }
      }

  // --- one vertex per cell the surface passes through
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * nz).fill(-1)
  const cyS = nx - 1
  const czS = (nx - 1) * (ny - 1)
  const P: number[] = []
  const G: number[] = []
  const cv = new Float64Array(8)
  const OFF = CORNERS.map((o) => o[0] * sx + o[1] * sy + o[2] * sz)
  for (let q = 0; q < near.length; q += 3) {
    if ((work += 40) > SLICE) {
      work = 0
      yield
    }
    const bx = near[q]
    const by = near[q + 1]
    const bz = near[q + 2]
    const ex = Math.min(nx - 1, bx + BLK)
    const ey = Math.min(ny - 1, by + BLK)
    const ez = Math.min(nz - 1, bz + BLK)
    for (let k = bz; k < ez; k++)
      for (let j = by; j < ey; j++)
        for (let i = bx; i < ex; i++) {
          const base = i + j * sy + k * sz
          let mask = 0
          for (let c = 0; c < 8; c++) {
            const v = val[base + OFF[c]]
            cv[c] = v
            if (v < 0) mask |= 1 << c
          }
          if (mask === 0 || mask === 255) continue
          let ax = 0
          let ay = 0
          let az = 0
          let n = 0
          for (let e2 = 0; e2 < 24; e2 += 2) {
            const a = EDGE_FLAT[e2]
            const b = EDGE_FLAT[e2 + 1]
            const va = cv[a]
            const vb = cv[b]
            if (va < 0 === vb < 0) continue
            const t = va / (va - vb)
            // corner c sits at (c & 1, c >> 1 & 1, c >> 2 & 1)
            const Ax = a & 1
            const Ay = (a >> 1) & 1
            const Az = (a >> 2) & 1
            ax += Ax + ((b & 1) - Ax) * t
            ay += Ay + (((b >> 1) & 1) - Ay) * t
            az += Az + (((b >> 2) & 1) - Az) * t
            n++
          }
          cellVert[i + j * cyS + k * czS] = P.length / 3
          P.push(x0 + (i + ax / n) * h, y0 + (j + ay / n) * h, z0 + (k + az / n) * h)
          // the field's slope across the cell, per unit length (corner c
          // has bit 0 for x, 1 for y, 2 for z)
          G.push(
            (cv[1] - cv[0] + cv[3] - cv[2] + cv[5] - cv[4] + cv[7] - cv[6]) / (4 * h),
            (cv[2] - cv[0] + cv[3] - cv[1] + cv[6] - cv[4] + cv[7] - cv[5]) / (4 * h),
            (cv[4] - cv[0] + cv[5] - cv[1] + cv[6] - cv[2] + cv[7] - cv[3]) / (4 * h),
          )
        }
  }

  // --- one quad per grid edge the surface crosses, joining the four cells
  // around that edge. Wound from the inside corner out, so the face looks
  // away from the solid
  const I: number[] = []
  const cellAt = (i: number, j: number, k: number) => cellVert[i + j * cyS + k * czS]
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    // split along the shorter diagonal: long thin triangles shade badly
    const dac = (P[a * 3] - P[c * 3]) ** 2 + (P[a * 3 + 1] - P[c * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[c * 3 + 2]) ** 2
    const dbd = (P[b * 3] - P[d * 3]) ** 2 + (P[b * 3 + 1] - P[d * 3 + 1]) ** 2 + (P[b * 3 + 2] - P[d * 3 + 2]) ** 2
    if (dac <= dbd) {
      if (flip) I.push(a, c, b, a, d, c)
      else I.push(a, b, c, a, c, d)
    } else if (flip) I.push(a, d, b, b, d, c)
    else I.push(a, b, d, b, c, d)
  }
  for (let q = 0; q < near.length; q += 3) {
    if ((work += 40) > SLICE) {
      work = 0
      yield
    }
    const bx = near[q]
    const by = near[q + 1]
    const bz = near[q + 2]
    const ex = Math.min(nx - 1, bx + BLK)
    const ey = Math.min(ny - 1, by + BLK)
    const ez = Math.min(nz - 1, bz + BLK)
    for (let k = Math.max(1, bz); k < ez; k++)
      for (let j = Math.max(1, by); j < ey; j++)
        for (let i = Math.max(1, bx); i < ex; i++) {
          const in0 = val[i + j * sy + k * sz] < 0
          if (in0 !== val[i + 1 + j * sy + k * sz] < 0) {
            quad(cellAt(i, j - 1, k - 1), cellAt(i, j, k - 1), cellAt(i, j, k), cellAt(i, j - 1, k), !in0)
          }
          if (in0 !== val[i + (j + 1) * sy + k * sz] < 0) {
            quad(cellAt(i - 1, j, k - 1), cellAt(i - 1, j, k), cellAt(i, j, k), cellAt(i, j, k - 1), !in0)
          }
          if (in0 !== val[i + j * sy + (k + 1) * sz] < 0) {
            quad(cellAt(i - 1, j - 1, k), cellAt(i, j - 1, k), cellAt(i, j, k), cellAt(i - 1, j, k), !in0)
          }
        }
  }

  // --- walk every vertex onto the zero set, and take its normal there
  const V = P.length / 3
  const pos = new Float32Array(V * 3)
  const nrm = new Float32Array(V * 3)
  const e = h * 0.12
  for (let v = 0; v < V; v++) {
    if ((work += 8) > SLICE) {
      work = 0
      yield
    }
    let x = P[v * 3]
    let y = P[v * 3 + 1]
    let z = P[v * 3 + 2]
    const ox = x
    const oy = y
    const oz = z
    // Newton on the field, along the cell's own gradient (free: it is the
    // difference of the corner values already sampled). The start is within
    // a cell of the surface, where the direction barely changes, so each
    // step costs one evaluation
    const gx = G[v * 3]
    const gy = G[v * 3 + 1]
    const gz = G[v * 3 + 2]
    const g2 = gx * gx + gy * gy + gz * gz
    let d = f(x, y, z)
    if (g2 > 1e-20) {
      for (let it = 0; it < 3 && Math.abs(d) > h * 2e-3; it++) {
        const s = d / g2
        x -= gx * s
        y -= gy * s
        z -= gz * s
        d = f(x, y, z)
      }
    }
    // never let a vertex wander out of its own neighbourhood: near a thin
    // part the nearest zero can belong to the other side of it
    const dx = x - ox
    const dy = y - oy
    const dz = z - oz
    const m = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (m > h * 0.9) {
      x = ox + (dx / m) * h * 0.9
      y = oy + (dy / m) * h * 0.9
      z = oz + (dz / m) * h * 0.9
    }
    // the normal is the field's gradient where the vertex ended up: forward
    // differences off the value there, at a tenth of a cell
    if (m > h * 0.9) d = f(x, y, z)
    const nx2 = f(x + e, y, z) - d
    const ny2 = f(x, y + e, z) - d
    const nz2 = f(x, y, z + e) - d
    const gl = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2) || 1
    pos[v * 3] = x
    pos[v * 3 + 1] = y
    pos[v * 3 + 2] = z
    nrm[v * 3] = nx2 / gl
    nrm[v * 3 + 1] = ny2 / gl
    nrm[v * 3 + 2] = nz2 / gl
  }

  // agree every triangle's winding with its normals (the quad orientation
  // above is right by construction; this is insurance against a degenerate
  // cell, and costs nothing next to the sampling)
  const idx = new Uint32Array(I)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3
    const b = idx[t + 1] * 3
    const c = idx[t + 2] * 3
    const ux = pos[b] - pos[a]
    const uy = pos[b + 1] - pos[a + 1]
    const uz = pos[b + 2] - pos[a + 2]
    const wx = pos[c] - pos[a]
    const wy = pos[c + 1] - pos[a + 1]
    const wz = pos[c + 2] - pos[a + 2]
    const cx = uy * wz - uz * wy
    const cy = uz * wx - ux * wz
    const cz = ux * wy - uy * wx
    const nx2 = nrm[a] + nrm[b] + nrm[c]
    const ny2 = nrm[a + 1] + nrm[b + 1] + nrm[c + 1]
    const nz2 = nrm[a + 2] + nrm[b + 2] + nrm[c + 2]
    if (cx * nx2 + cy * ny2 + cz * nz2 < 0) {
      const s = idx[t + 1]
      idx[t + 1] = idx[t + 2]
      idx[t + 2] = s
    }
  }
  return { pos, nrm, idx }
}

/* ------------------------------------------------ distance primitives -- */

/** polynomial smooth minimum: the fillet between two parts, `k` wide */
export const smin = (a: number, b: number, k: number) => {
  if (k <= 0) return Math.min(a, b)
  const hh = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - hh * hh * k * 0.25
}
export const smax = (a: number, b: number, k: number) => -smin(-a, -b, k)

/** a cone with rounded ends between two points (Quilez), precomputed once */
export const roundCone = (
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, r1: number, r2: number,
): Field => {
  const bax = bx - ax
  const bay = by - ay
  const baz = bz - az
  const l2 = bax * bax + bay * bay + baz * baz
  const rr = r1 - r2
  const a2 = l2 - rr * rr
  const il2 = 1 / l2
  return (x, y, z) => {
    const pax = x - ax
    const pay = y - ay
    const paz = z - az
    const yy = pax * bax + pay * bay + paz * baz
    const zz = yy - l2
    const qx = pax * l2 - bax * yy
    const qy = pay * l2 - bay * yy
    const qz = paz * l2 - baz * yy
    const x2 = qx * qx + qy * qy + qz * qz
    const y2 = yy * yy * l2
    const z2 = zz * zz * l2
    const k = Math.sign(rr) * rr * rr * x2
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1
  }
}

/**
 * An ellipsoid (Quilez's bound) centred at c, with semi-axes along the
 * columns of an orthonormal basis (u, v, w) given as 9 numbers, row-major
 * per axis. Omit the basis for axis-aligned.
 */
export const ellipsoid = (
  cx: number, cy: number, cz: number, rx: number, ry: number, rz: number,
  basis?: readonly number[],
): Field => {
  const [ux, uy, uz, vx, vy, vz, wx, wy, wz] = basis ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]
  return (x, y, z) => {
    const px = x - cx
    const py = y - cy
    const pz = z - cz
    const a = (px * ux + py * uy + pz * uz)
    const b = (px * vx + py * vy + pz * vz)
    const c = (px * wx + py * wy + pz * wz)
    const k0 = Math.sqrt((a / rx) ** 2 + (b / ry) ** 2 + (c / rz) ** 2)
    const k1 = Math.sqrt((a / (rx * rx)) ** 2 + (b / (ry * ry)) ** 2 + (c / (rz * rz)) ** 2)
    return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1
  }
}

/** distance from a point to a segment: the cheap bound a part is skipped by
    when it is too far away to touch the blend */
export const segDist = (
  x: number, y: number, z: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
): number => {
  const bax = bx - ax
  const bay = by - ay
  const baz = bz - az
  const l2 = bax * bax + bay * bay + baz * baz
  let t = ((x - ax) * bax + (y - ay) * bay + (z - az) * baz) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = x - ax - bax * t
  const dy = y - ay - bay * t
  const dz = z - az - baz * t
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
