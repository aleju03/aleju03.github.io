import * as THREE from 'three'
import { GRID, OFF_X, OFF_Z } from '../world/grid'
import { fbm, noise2, rand2, rand3 } from '../world/noise'
import type { Solid } from '../physics/collision'
import { noStand } from '../physics/collision'
import { MOON_ORIGIN, MOON_WALK } from './space'

/*
  The Moon: grey regolith, craters inside craters, a black sky with the
  Earth hanging in it (drawn by world/globe.ts, the same globe you looked
  down on from orbit), and a sixth of the gravity.

  It is a level of its own ('moon', in homeLevels.ts) standing at
  MOON_ORIGIN in the scene, far enough from the house that everything of
  the overworld's is past its far plane, and it is built the first time
  somebody arrives, under the level cut's blackout. Everything about the
  ground is a pure function of position, like the overworld's:

  - **the height** is a gentle undulation plus five scales of crater, each
    a jittered grid of bowls with a raised rim and, in the bigger ones, a
    central peak, summed over the neighbouring cells. The biggest two are
    basins you only see from space; the smallest are pits you step in.
  - **the walkable square** (MOON_WALK either side of the origin) is the
    lattice the sandbox's heightfields and `groundYAt` both read, on the
    overworld's own GRID and origin, so a crate rests on the drawn triangle
    and the walker stands on it (the "mesh and collision agree" rule).
  - **past it** the ground falls away on a curve, so the horizon is a
    horizon and not the edge of a mesh: the Moon is small, and it looks it.
  - **the mesh** is one tensor grid, four units a cell over the walkable
    square and widening geometrically outward, so there are no T-junctions
    to crack and the whole thing is one draw.

  The albedo is exported for the globe, which paints the Moon you fly
  toward from these same fields, so the landing site you see from orbit is
  the one you land on. Headless-safe: nothing here needs a renderer until
  the mesh is asked for.
*/

/** crater scales: grid cell, chance of a crater per cell, depth/radius */
const SCALES = [
  { cell: 4200, p: 0.55, depth: 0.05, salt: 0x51a1 },
  { cell: 1300, p: 0.6, depth: 0.09, salt: 0x51b2 },
  { cell: 380, p: 0.7, depth: 0.2, salt: 0x51c3 },
  { cell: 110, p: 0.72, depth: 0.24, salt: 0x51d4 },
  { cell: 34, p: 0.55, depth: 0.22, salt: 0x51e5 },
] as const

/** the curve past the walkable square: falls away as (d - FLAT)^2 / 2R */
const FLAT = 800
const CURVE_R = 6000
/** the pad the arrival lands over, flattened so a spawn stands level */
const PAD = 26

/** the sum of every crater near (u, v), moon-local; also how much fresh
    rim (bright ejecta) is under the point */
const craters = (u: number, v: number, out: { rim: number }) => {
  let h = 0
  let rim = 0
  for (const s of SCALES) {
    const ci = Math.floor(u / s.cell)
    const cj = Math.floor(v / s.cell)
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di
        const j = cj + dj
        if (rand2(i, j, s.salt) > s.p) continue
        const cx = (i + 0.2 + 0.6 * rand3(i, j, 1, s.salt)) * s.cell
        const cz = (j + 0.2 + 0.6 * rand3(i, j, 2, s.salt)) * s.cell
        const r = s.cell * (0.12 + 0.26 * rand3(i, j, 3, s.salt))
        const dx = u - cx
        const dz = v - cz
        const d2 = dx * dx + dz * dz
        const reach = r * 1.9
        if (d2 > reach * reach) continue
        const t = Math.sqrt(d2) / r
        const d = r * s.depth
        const rh = d * 0.3
        if (t < 1) {
          const t2 = t * t
          h += -d * (1 - t2) + rh * t2 * t2 * t2
          // a central peak in the ones big enough to have made one
          if (s.cell >= 380) h += d * 0.4 * Math.exp(-(t2 / 0.03))
        } else {
          const e = (t - 1) / 0.35
          h += rh * Math.exp(-e * e)
        }
        // young small craters are bright; the rim and the ejecta around it
        if (s.cell <= 380) rim += Math.max(0, 1 - Math.abs(t - 1) * 2.2) * (0.6 + 0.4 * rand3(i, j, 4, s.salt))
      }
    }
  }
  out.rim = rim
  return h
}

const rimOut = { rim: 0 }

/** the raw field before the pad and the curve, moon-local */
const rawHeight = (u: number, v: number) =>
  (fbm(u / 900, v / 900, 0x6d1, 3) - 0.5) * 26 + (noise2(u / 55, v / 55, 0x6d2) - 0.5) * 1.6 + craters(u, v, rimOut)

const PAD_Y = rawHeight(0, 0)

/** the Moon's ground height at a scene position: the analytic field the
    lattice samples */
export const moonHeight = (x: number, z: number) => {
  const u = x - MOON_ORIGIN.x
  const v = z - MOON_ORIGIN.z
  let h = rawHeight(u, v)
  const d = Math.hypot(u, v)
  if (d < PAD * 2) {
    const t = Math.min(1, Math.max(0, (d - PAD) / PAD))
    h = PAD_Y + (h - PAD_Y) * t * t * (3 - 2 * t)
  }
  if (d > FLAT) h -= ((d - FLAT) * (d - FLAT)) / (2 * CURVE_R)
  return h
}

/** the regolith's brightness at a moon-local point, 0..1 (the globe reads
    it, and the mesh's vertex colours are this times a tint) */
export const moonAlbedo = (u: number, v: number) => {
  craters(u, v, rimOut)
  const mare = fbm(u / 2600 + 7, v / 2600 - 3, 0x6d3, 3)
  let g = 0.5 - 0.17 * Math.min(1, Math.max(0, (0.52 - mare) * 5))
  g += 0.12 * Math.min(1, rimOut.rim)
  g += (noise2(u / 9, v / 9, 0x6d4) - 0.5) * 0.06
  return Math.min(0.85, Math.max(0.12, g))
}

const cache = new Map<number, number>()
/** the height at lattice point (i, j) of world/grid.ts's GRID, cached like
    the terrain's: the sandbox's heightfields and groundYAt both read it */
export const moonLattice = (i: number, j: number) => {
  const key = (i + 1048576) * 2097152 + (j + 1048576)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const h = moonHeight(OFF_X + i * GRID, OFF_Z + j * GRID)
  if (cache.size > 200000) cache.clear()
  cache.set(key, h)
  return h
}

/** the drawn surface: the lattice, split along the (0,0)-(1,1) diagonal the
    mesh uses (terrain.ts's terrainY, over this lattice instead) */
export const moonGroundY = (x: number, z: number) => {
  const fx = (x - OFF_X) / GRID
  const fz = (z - OFF_Z) / GRID
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  const u = fx - i
  const v = fz - j
  const h00 = moonLattice(i, j)
  const h11 = moonLattice(i + 1, j + 1)
  if (v < u) {
    const h10 = moonLattice(i + 1, j)
    return h00 + (h10 - h00) * u + (h11 - h10) * v
  }
  const h01 = moonLattice(i, j + 1)
  return h00 + (h11 - h01) * u + (h01 - h00) * v
}

/** the walkable square, as the Moon's collision set's bounds */
export const MOON_BOUNDS = {
  minX: MOON_ORIGIN.x - MOON_WALK,
  maxX: MOON_ORIGIN.x + MOON_WALK,
  minZ: MOON_ORIGIN.z - MOON_WALK,
  maxZ: MOON_ORIGIN.z + MOON_WALK,
}

/** one axis of the tensor grid: lattice-aligned GRID steps over the inner
    run, then steps growing by `grow` out to `outer` either side */
const axis = (centre: number, off: number, inner: number, outer: number, grow: number) => {
  const out: number[] = []
  const j0 = Math.ceil((centre - inner - off) / GRID)
  const j1 = Math.floor((centre + inner - off) / GRID)
  for (let j = j0; j <= j1; j++) out.push(off + j * GRID)
  let step = GRID
  let x = out[0]
  const left: number[] = []
  while (x > centre - outer) {
    step *= grow
    x -= step
    left.push(x)
  }
  step = GRID
  x = out[out.length - 1]
  while (x < centre + outer) {
    step *= grow
    x += step
    out.push(x)
  }
  return [...left.reverse(), ...out]
}

let material: THREE.MeshStandardMaterial | null = null
/** the one regolith material: the mesh, the boulders and the warm stand-in */
const moonMaterial = () => {
  material ??= new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  })
  return material
}

const TINT = new THREE.Color('#d9d4c9')

export interface MoonHandles {
  /** everything drawn on the Moon; hidden while the Moon is not live */
  root: THREE.Group
  /** one degenerate triangle carrying the regolith material, always in the
      scene, so the covered compile at world attach links its program and the
      cut to the Moon links nothing */
  warm: THREE.Mesh
  /** the boulders' boxes: the Moon level's CollisionSet wraps this array */
  obstacles: Solid[]
  /** build the ground if it is not built yet (the first arrival, under the
      cut's blackout); cheap every time after */
  ensureBuilt: () => void
}

export const buildMoon = (opts: {
  parent: THREE.Object3D
  /** the Moon level's box list, which it built before the Moon was loaded */
  obstacles: Solid[]
  trackDisposable: (d: { dispose: () => void }) => void
}): MoonHandles => {
  const root = new THREE.Group()
  root.name = 'moon'
  root.visible = false
  opts.parent.add(root)
  const mat = moonMaterial()
  opts.trackDisposable(mat)

  const warmGeo = new THREE.BufferGeometry()
  warmGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1e4, 0, 0, -1e4, 0, 0, -1e4, 0], 3))
  warmGeo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3))
  warmGeo.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3))
  const warm = new THREE.Mesh(warmGeo, mat)
  warm.castShadow = true
  warm.receiveShadow = true
  warm.frustumCulled = false
  opts.trackDisposable(warmGeo)

  const { obstacles } = opts
  let built = false

  const buildGround = () => {
    const xs = axis(MOON_ORIGIN.x, OFF_X, MOON_WALK + 80, 4300, 1.13)
    const zs = axis(MOON_ORIGIN.z, OFF_Z, MOON_WALK + 80, 4300, 1.13)
    const nx = xs.length
    const nz = zs.length
    const pos = new Float32Array(nx * nz * 3)
    const col = new Float32Array(nx * nz * 3)
    const inner = MOON_WALK + 80
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = xs[i]
        const z = zs[j]
        const k = j * nx + i
        const lat = Math.abs(x - MOON_ORIGIN.x) <= inner && Math.abs(z - MOON_ORIGIN.z) <= inner
        // on the lattice exactly where anything can stand, so the drawn
        // triangle is the one collision reads
        pos[k * 3] = x
        pos[k * 3 + 1] = lat
          ? moonLattice(Math.round((x - OFF_X) / GRID), Math.round((z - OFF_Z) / GRID))
          : moonHeight(x, z)
        pos[k * 3 + 2] = z
        const g = moonAlbedo(x - MOON_ORIGIN.x, z - MOON_ORIGIN.z)
        col[k * 3] = g * TINT.r
        col[k * 3 + 1] = g * TINT.g
        col[k * 3 + 2] = g * TINT.b
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6)
    let n = 0
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i
        const b = a + 1
        const c = a + nx
        const d = c + 1
        // split along (0,0)-(1,1), the diagonal moonGroundY interpolates
        idx[n++] = a
        idx[n++] = c
        idx[n++] = d
        idx[n++] = a
        idx[n++] = d
        idx[n++] = b
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    opts.trackDisposable(geo)
    const mesh = new THREE.Mesh(geo, mat)
    // the ground receives and does not cast, like the overworld's: the sun's
    // map is a small box that follows you, and ground casting into it shaded
    // the whole foreground and left only the horizon lit
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.name = 'moon-ground'
    root.add(mesh)
  }

  /*
    Boulders: a few dozen lumps of the same grey, one merged draw, each
    registering the box it stands in. Their tops are somewhere a player can
    stand (a boulder is a thing you climb), so none is marked noStand except
    the tall ones, whose box top is air over a rounded crown.
  */
  const buildBoulders = () => {
    const base = new THREE.IcosahedronGeometry(1, 1)
    const bp = base.getAttribute('position')
    const parts: THREE.BufferGeometry[] = []
    for (let k = 0; k < 46; k++) {
      const a = rand3(k, 7, 1, 0x6e1) * Math.PI * 2
      const r = 40 + Math.sqrt(rand3(k, 7, 2, 0x6e1)) * (MOON_WALK - 60)
      const x = MOON_ORIGIN.x + Math.cos(a) * r
      const z = MOON_ORIGIN.z + Math.sin(a) * r
      const s = 0.8 + Math.pow(rand3(k, 7, 3, 0x6e1), 2.2) * 5.5
      const sy = s * (0.55 + 0.3 * rand3(k, 7, 4, 0x6e1))
      const g = base.clone()
      const p = g.getAttribute('position')
      for (let v = 0; v < p.count; v++) {
        // a lump, not a ball: every vertex pushed in or out a little by a
        // hash of where it points, so no two boulders share a silhouette
        const lx = bp.getX(v)
        const ly = bp.getY(v)
        const lz = bp.getZ(v)
        const w = 0.78 + 0.34 * rand2(Math.round(lx * 7 + k * 13), Math.round(lz * 7 + ly * 5), 0x6e2)
        p.setXYZ(v, lx * s * w, ly * sy * w, lz * s * w)
      }
      const gy = moonGroundY(x, z)
      g.translate(x, gy + sy * 0.35, z)
      const g2 = g.toNonIndexed()
      g2.computeVertexNormals()
      const c = new Float32Array(g2.getAttribute('position').count * 3)
      const shade = 0.34 + 0.12 * rand3(k, 7, 5, 0x6e1)
      for (let v = 0; v < c.length; v += 3) {
        c[v] = shade * TINT.r
        c[v + 1] = shade * TINT.g
        c[v + 2] = shade * TINT.b
      }
      g2.setAttribute('color', new THREE.BufferAttribute(c, 3))
      parts.push(g2)
      g.dispose()
      if (s > 1.1) {
        const box = new THREE.Box3(
          new THREE.Vector3(x - s * 0.75, gy - 1, z - s * 0.75),
          new THREE.Vector3(x + s * 0.75, gy + sy * 1.2, z + s * 0.75),
        ) as Solid
        if (sy > 3.2) noStand(box)
        obstacles.push(box)
      }
    }
    base.dispose()
    // merged by hand: every part is non-indexed with the same three attributes
    let count = 0
    for (const p of parts) count += p.getAttribute('position').count
    const pos = new Float32Array(count * 3)
    const nor = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    let o = 0
    for (const p of parts) {
      pos.set(p.getAttribute('position').array as Float32Array, o)
      nor.set(p.getAttribute('normal').array as Float32Array, o)
      col.set(p.getAttribute('color').array as Float32Array, o)
      o += p.getAttribute('position').count * 3
      p.dispose()
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.computeBoundingSphere()
    opts.trackDisposable(geo)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.name = 'moon-boulders'
    root.add(mesh)
  }

  return {
    root,
    warm,
    obstacles,
    ensureBuilt: () => {
      if (built) return
      built = true
      buildGround()
      buildBoulders()
      root.updateMatrixWorld(true)
      root.traverse((o) => {
        o.matrixAutoUpdate = false
      })
    },
  }
}
