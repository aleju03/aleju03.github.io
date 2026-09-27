import * as THREE from 'three'
import { GRID, OFF_X, OFF_Z } from '../world/grid'
import { fbm, noise2, rand2, rand3 } from '../world/noise'
import type { Solid } from '../physics/collision'
import { noStand } from '../physics/collision'
import { MOON_ORIGIN, MOON_R, MOON_WALK } from './space'

/*
  The Moon: grey regolith, craters inside craters, a black sky with the
  Earth hanging in it (drawn by world/globe.ts, the same globe you looked
  down on from orbit), and a sixth of the gravity.

  It is a level of its own ('moon', in homeLevels.ts) standing at
  MOON_ORIGIN in the scene, far enough from the house that everything of
  the overworld's is past its far plane. It is built a millisecond or two a
  frame while you fly at it, and from well out the same meshes ride on the
  Moon out there (levels/outsideWorld.ts places this root), so landing is
  no cut at all. Everything about the ground is a pure function of
  position, like the overworld's:

  - **the height** is a gentle undulation plus six scales of crater, each
    a jittered grid of bowls with a raised rim and, in the bigger ones, a
    central peak, summed over the neighbouring cells. The biggest two are
    basins you only see from space; the smallest are pits you step in. No
    two are alike: each rolls its own depth and rim, and the youngest (the
    deepest) throw bright rays of ejecta across the grey.
  - **the walkable square** (MOON_WALK either side of the origin) is the
    lattice the sandbox's heightfields and `groundYAt` both read, on the
    overworld's own GRID and origin, so a crate rests on the drawn triangle
    and the walker stands on it (the "mesh and collision agree" rule).
  - **everywhere** the ground falls away on the Moon's own sphere (MOON_R),
    exactly, so this patch is a piece of the ball you flew in over: from
    space it sits on world/globe.ts's Moon, which carries on past its edge,
    and the approach lands on it with no cut (levels/outsideWorld.ts).
  - **the mesh** is four nested square rings of square cells (4, 8, 16 and
    64 units), each ring's outer edge welded to the next one's vertices, so
    no cell is ever stretched (a tensor grid of widening rows smeared every
    crater wall into streaks) and no seam cracks open onto the black sky.
  - **the regolith** is grey: the vertex colour carries the crater albedo,
    and the fragment shader adds a grain from world position in three
    dimensions, so a crater wall is as fine as the floor. The material also
    takes most of the light's own colour back out before the look's grade,
    because a low warm sun and space's blue ambient landed it brown in the
    light and navy in the shade. That is a line in the one program the warm
    stand-in already links under cover, so landing links nothing.

  The albedo is exported for the globe, which paints the Moon you fly
  toward from these same fields, so the landing site you see from orbit is
  the one you land on. Headless-safe: nothing here needs a renderer until
  the mesh is asked for.
*/

/** crater scales: grid cell, chance of a crater per cell, depth/radius */
const SCALES = [
  { cell: 4200, p: 0.55, depth: 0.05, salt: 0x51a1 },
  { cell: 1300, p: 0.62, depth: 0.1, salt: 0x51b2 },
  { cell: 380, p: 0.78, depth: 0.24, salt: 0x51c3 },
  { cell: 110, p: 0.86, depth: 0.3, salt: 0x51d4 },
  { cell: 34, p: 0.78, depth: 0.3, salt: 0x51e5 },
  // pits a stride or two across, the finest the walked lattice resolves
  { cell: 15, p: 0.42, depth: 0.26, salt: 0x51f6 },
] as const

/** how far the drawn patch reaches either side of the landing site: past it
    the globe's Moon carries on (world/globe.ts takes this as its hole) */
export const MOON_PATCH = 5120
/** the pad the arrival lands over, flattened so a spawn stands level */
const PAD = 26

/** the sum of every crater near (u, v), moon-local; also how much fresh
    rim (bright ejecta) is under the point */
const craters = (u: number, v: number, out: { rim: number; floor: number }) => {
  let h = 0
  let rim = 0
  let floor = 0
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
        // no two alike: some shallow and soft-rimmed and old, some deep with
        // a sharp high lip
        const age = rand3(i, j, 5, s.salt)
        const d = r * s.depth * (0.5 + 0.9 * age)
        const rh = d * (0.22 + 0.3 * rand3(i, j, 6, s.salt))
        if (t < 1) {
          const t2 = t * t
          h += -d * (1 - t2) + rh * t2 * t2 * t2
          // a central peak in the ones big enough to have made one
          if (s.cell >= 380) h += d * 0.4 * Math.exp(-(t2 / 0.03))
        } else {
          const e = (t - 1) / 0.35
          h += rh * Math.exp(-e * e)
        }
        // young small craters are bright; the rim and the ejecta around it,
        // and their floors in shadow-grey fines
        if (s.cell <= 380) {
          rim += Math.max(0, 1 - Math.abs(t - 1) * 2.2) * (0.6 + 0.4 * rand3(i, j, 4, s.salt))
          if (t < 0.8) floor += 1 - t / 0.8
          // the youngest (the deepest) throw bright rays of ejecta out
          // across the grey, the thing that makes a crater field read as a
          // crater field from above rather than as a pitted plain
          if (age > 0.78 && t > 0.9 && t < 2.6) {
            const a = Math.atan2(dz, dx) * 5 + rand3(i, j, 7, s.salt) * 6.283
            const ray = Math.max(0, Math.sin(a) * Math.sin(a * 0.6 + 1.3))
            rim += ray * ray * (1 - (t - 0.9) / 1.7) * 0.9
          }
        }
      }
    }
  }
  out.rim = rim
  out.floor = floor
  return h
}

const rimOut = { rim: 0, floor: 0 }

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
  // the sphere's own fall, exactly (not a parabola), so the patch's edge
  // meets the globe drawn past it
  const dd = Math.min(d, MOON_R * 0.999)
  h -= MOON_R - Math.sqrt(MOON_R * MOON_R - dd * dd)
  return h
}

/** the regolith's brightness at a moon-local point, 0..1 (the globe reads
    it, and the mesh's vertex colours are this times a tint) */
export const moonAlbedo = (u: number, v: number) => {
  craters(u, v, rimOut)
  const mare = fbm(u / 2600 + 7, v / 2600 - 3, 0x6d3, 3)
  let g = 0.56 - 0.14 * Math.min(1, Math.max(0, (0.52 - mare) * 5))
  g += 0.17 * Math.min(1, rimOut.rim)
  g -= 0.06 * Math.min(1, rimOut.floor)
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

let material: THREE.MeshStandardMaterial | null = null
/** the one regolith material: the mesh, the boulders and the warm stand-in */
const moonMaterial = () => {
  if (material) return material
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  })
  // a grain in three dimensions off world position, so a steep crater wall
  // is as fine as the flat (the vertex colours are only the crater albedo)
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vMoonW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vMoonW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vMoonW;
        float mHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float mNoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(mHash(i), mHash(i + vec3(1, 0, 0)), f.x), mix(mHash(i + vec3(0, 1, 0)), mHash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(mHash(i + vec3(0, 0, 1)), mHash(i + vec3(1, 0, 1)), f.x), mix(mHash(i + vec3(0, 1, 1)), mHash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 mp = fract(vMoonW / 4096.0) * 4096.0;
          float grain = mNoise(mp * 0.7) * 0.6 + mNoise(mp * 2.3) * 0.4;
          diffuseColor.rgb *= 0.82 + 0.36 * grain;
        }`)
      // regolith is grey under any light: most of the colour a low warm sun
      // and space's blue ambient put into it is taken back out here, before
      // the look's grade, which then only warms it a touch. Without it the
      // ground landed as brown in the sun and navy in the shade
      .replace('#include <opaque_fragment>', `
        outgoingLight = mix(vec3(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722))), outgoingLight, 0.3);
        #include <opaque_fragment>`)
  }
  m.customProgramCacheKey = () => 'moon-regolith-3'
  material = m
  return m
}

/** grey, a touch cool, because the look's grade warms whatever it is given
    (the material takes the light's own colour back out, see moonMaterial) */
const TINT = new THREE.Color('#a9adb3')

export interface MoonHandles {
  /** everything drawn on the Moon; hidden while the Moon is not live */
  root: THREE.Group
  /** one degenerate triangle carrying the regolith material, always in the
      scene, so the covered compile at world attach links its program and the
      cut to the Moon links nothing */
  warm: THREE.Mesh
  /** the boulders' boxes: the Moon level's CollisionSet wraps this array */
  obstacles: Solid[]
  /** build the ground if it is not built yet; cheap every time after. The
      approach calls it well out, a few hundred milliseconds of work that
      outsideWorld time-slices ahead of need */
  ensureBuilt: () => void
  /** build for up to `ms` milliseconds; true once it is all there */
  build: (ms: number) => boolean
  readonly built: boolean
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
  root.userData.dynamic = true
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

  /** rings of square cells about the landing site: cell edge, half-width */
  const RINGS = [
    { cell: 4, half: 640 },
    { cell: 8, half: 1280 },
    { cell: 16, half: 2560 },
    { cell: 64, half: MOON_PATCH },
  ]
  // a generator, so the approach can build it a few milliseconds a frame
  function* buildGround() {
    // the centre on the world lattice, so the finest ring is the lattice
    // itself and collision reads the drawn triangles
    const cx = OFF_X + Math.round((MOON_ORIGIN.x - OFF_X) / GRID) * GRID
    const cz = OFF_Z + Math.round((MOON_ORIGIN.z - OFF_Z) / GRID) * GRID
    for (let k = 0; k < RINGS.length; k++) {
      const { cell, half } = RINGS[k]
      const hole = k > 0 ? RINGS[k - 1].half : 0
      const n = Math.round(half / cell)
      const side = n * 2 + 1
      const pos = new Float32Array(side * side * 3)
      const col = new Float32Array(side * side * 3)
      const coarse = k + 1 < RINGS.length ? RINGS[k + 1].cell / cell : 1
      for (let j = 0; j < side; j++) {
        for (let i = 0; i < side; i++) {
          const x = cx + (i - n) * cell
          const z = cz + (j - n) * cell
          const o = (j * side + i) * 3
          pos[o] = x
          pos[o + 2] = z
          pos[o + 1] = k === 0
            ? moonLattice(Math.round((x - OFF_X) / GRID), Math.round((z - OFF_Z) / GRID))
            : moonHeight(x, z)
          const g = moonAlbedo(x - MOON_ORIGIN.x, z - MOON_ORIGIN.z)
          col[o] = g * TINT.r
          col[o + 1] = g * TINT.g
          col[o + 2] = g * TINT.b
        }
        if (j % 8 === 7) yield
      }
      // weld the outer edge to the coarser ring's vertices: every vertex the
      // coarser ring does not have takes the height of the straight line
      // between the two it does, so the edges are one polyline
      if (coarse > 1) {
        const edge = (i: number, j: number, di: number, dj: number) => {
          const t = ((di ? i : j) % coarse) / coarse
          if (t === 0) return
          const i0 = di ? i - (i % coarse) : i
          const j0 = dj ? j - (j % coarse) : j
          const a = (j0 * side + i0) * 3 + 1
          const b = ((j0 + dj * coarse) * side + (i0 + di * coarse)) * 3 + 1
          pos[(j * side + i) * 3 + 1] = pos[a] + (pos[b] - pos[a]) * t
        }
        for (let q = 0; q < side; q++) {
          edge(q, 0, 1, 0)
          edge(q, side - 1, 1, 0)
          edge(0, q, 0, 1)
          edge(side - 1, q, 0, 1)
        }
      }
      const idx: number[] = []
      for (let j = 0; j < side - 1; j++) {
        for (let i = 0; i < side - 1; i++) {
          const x0 = (i - n) * cell
          const z0 = (j - n) * cell
          if (hole && x0 >= -hole && x0 + cell <= hole && z0 >= -hole && z0 + cell <= hole) continue
          const a = j * side + i
          const b = a + 1
          const c = a + side
          const d = c + 1
          // split along (0,0)-(1,1), the diagonal moonGroundY interpolates
          idx.push(a, c, d, a, d, b)
        }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      geo.setIndex(idx)
      geo.computeVertexNormals()
      geo.computeBoundingSphere()
      opts.trackDisposable(geo)
      const mesh = new THREE.Mesh(geo, mat)
      // the ground receives and does not cast, like the overworld's: the
      // sun's map is a small box that follows you, and ground casting into it
      // shaded the whole foreground and left only the horizon lit
      mesh.castShadow = false
      mesh.receiveShadow = true
      mesh.name = k === 0 ? 'moon-ground' : `moon-ground-${k}`
      root.add(mesh)
      yield
    }
  }
  let steps: Generator<undefined, void> | null = null
  const finish = () => {
    buildBoulders()
    root.updateMatrixWorld(true)
    // the parts are still; the root is not, it is carried through space on
    // the way in (outsideWorld places it on the Moon out there)
    root.traverse((o) => {
      if (o !== root) o.matrixAutoUpdate = false
    })
    built = true
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
      const r = 40 + Math.sqrt(rand3(k, 7, 2, 0x6e1)) * 560
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
      steps ??= buildGround()
      while (!steps.next().done) { /* all of it, now */ }
      finish()
    },
    build: (ms) => {
      if (built) return true
      steps ??= buildGround()
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        if (steps.next().done) {
          finish()
          return true
        }
      }
      return false
    },
    get built() {
      return built
    },
  }
}
