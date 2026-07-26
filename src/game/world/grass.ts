import * as THREE from 'three'
import { canvasTexture } from '../core/textures'
import { seeded } from '../core/rand'
import { rand2 } from './noise'
import { inYard, onHomeHardscape } from './grid'
import { SEA_Y, biomeAt, groundColorAt, terrainY } from './terrain'
import type { BiomeId } from './biomes'
import { pavedAt, placeAt, roadAt } from './settlements'
import { insideInterior } from './interiors'
import { gfx } from './quality'
import { applySway } from './wind'

/*
  The grass field, and the single largest thing standing between this world
  and looking like a toy.

  It is not part of the chunk system, and that is deliberate. Grass only reads
  at close range, so tying it to 64-unit chunks would either waste most of the
  blades on ground the player will never stand near, or thin them out to
  nothing where they matter. Instead this owns fixed pools of instances on
  lattices that *scroll*: slots live at fixed world positions, and walking
  forward only re-places the row of slots that fell off the back. Crossing a
  metre costs a hundred writes rather than nine thousand, so density can be
  high enough to be worth having. There are two lattices now — a dense one
  for the blades and a sparse one for the wildflowers — and they share one
  scroller (makeLattice below).

  Each blade instance is a *clump* of three blades, and that is the single
  biggest thing separating a lawn from a scatter of dark spikes on bare
  ground. A lattice dense enough to read as turf one blade at a time is a
  lattice dense enough to cost real time; three blades a slot at half the
  spacing gets there for the same instance count, and each blade at its own
  angle, height and arc is what stops every slot from being one identical
  spike. Slots on town ground used to be culled to a fifth on top of that,
  which is how a suburb verge ended up as bare grey concrete with a few dark
  needles in it — a suburb is lawns, and it keeps most of its grass now.

  Each blade is a four-row tapered strip — eight vertices, six triangles —
  with three things that make it read as grass rather than as cardboard:

  - normals point straight up, not out of the blade's face. A field of cards
    lit by their own facing flickers as you turn and every blade reads
    separately; lit by the ground's normal the whole field shades as one soft
    mass, which is what the eye expects of grass. It is the cheapest possible
    stand-in for the translucency a stylized grass shader would do properly.
    (The proper version — and the wind, arc bend and fresnel rim in wind.ts —
    follows the same recipe as cortiz2894/stylized-components' GrassField,
    MIT © Christian Ortiz, rebuilt on this project's onBeforeCompile spine.)
  - the instance colour *is* the ground: terrain.ts's groundColorAt, the same
    lattice interpolation the terrain mesh renders, times the ground detail
    map's average brightness, and the vertex gradient then runs from that
    colour at the root to bright and *warm* at the tip — sun-dried ends over
    a damp base. This is the one trick doing most of the work in the look
    this field is chasing (cortiz2894's GrassField demo, where blades and
    ground are indistinguishable): blade and soil are the same number by
    construction, so nothing can drift. When each derived its own colour —
    blades from the biome's leaf palette, ground from its tint pair — every
    meadow's turf read as bright litter scattered on darker felt, and every
    verge in town was neon turf standing in cement.
  - the yaw lives in an instanced attribute rather than in the instance
    matrix, so wind.ts can resolve the bend in world space before the blade's
    own facing is applied. Otherwise every blade bends along its own axis and
    the gust stops being a direction.

  The wildflowers are the meadow's grace note: crossed alpha-card quads on the
  sparse lattice, a painted petal disc apiece, white or butter or faded pink,
  swaying with the same wind. A meadow with a dozen flowers in view reads as
  alive; one with none reads as a golf course.

  Slots that land on a road, in the sea, on the home yard's hardscape or in a
  biome with no grass collapse to zero scale rather than being removed — a
  fixed instance count means the buffers are allocated once and never resized.
  The yard itself grows this same turf (shorter — somebody mows it), because
  its old authored tufts read as a different, darker plant than the field
  starting at the fence line.
*/

/*
  Two blade lattices, not one, and the reason is the only thing about this
  field that matters visually.

  Grass reads as turf when blades touch each other and as litter when they
  don't, and the number that decides which is the spacing measured in blade
  widths — not the instance count, not the triangle count. A single lattice
  has to pick one spacing for the whole field, and the old one picked 0.42
  units against a blade about 0.165 wide: two and a half blade-widths of bare
  ground between neighbours, everywhere, out to a radius of forty-seven. It
  cost 1.8M triangles a frame to do that, and every street verge in the world
  came out as green arrowheads scattered on concrete.

  So the near field is dense enough to close up (a sixth of the spacing, which
  is a hundred and thirteen blades per square unit — turf) and small, and the
  far field keeps the old sparse spacing out to the old radius, where a blade
  is a fraction of a pixel and only its colour survives. They overlap in the
  middle, which costs the far field's slots inside the near radius and is
  exactly where extra density is wanted anyway. Together they come to *less*
  than the single field did, because the far one no longer has to pretend it
  is close-range detail.
*/
const NEAR_STEP = 0.163
const FAR_STEP = 0.42
const F_STEP = 2.1

/*
  Blade heights, in world units — and the world is at about 0.43 m to the
  unit, which is the number that matters here. The first pass ran grass up to
  2.3 units, a metre of it, and a savanna came out looking like a field of
  spears with the player wading through the middle. Real grass is ankle to
  shin: a third of a unit to about one. Only the wetland reeds and savanna
  bunch grass get to be tall, because those genuinely are.

  Beach is deliberately absent. Dune grass on sand looked like weeds through
  a pavement, and an empty beach is a better beach.
*/
const GRASS_HEIGHT: Partial<Record<BiomeId, [number, number]>> = {
  plains: [0.42, 0.92],
  forest: [0.32, 0.7],
  taiga: [0.26, 0.52],
  savanna: [0.52, 1.12],
  jungle: [0.44, 0.98],
  wetland: [0.58, 1.24],
  tundra: [0.18, 0.38],
}

/** which biomes get wildflowers, and how often a flower slot blooms */
const FLOWERS: Partial<Record<BiomeId, number>> = {
  plains: 0.2,
  forest: 0.1,
  savanna: 0.07,
  tundra: 0.05,
}

const FLOWER_TINTS = ['#ffffff', '#ffe9a8', '#eeb7c8', '#c9d9ff']

/** the ground multiplies its vertex colour by a tiling detail map that
    averages a little under white; blades carry no map, so their instance
    colour is scaled by the same flat average streamer.ts hands the prop
    material (0xe0e0e0), or matched palettes render visibly paler than the
    soil — which is what turned the first savanna into straw */
const DETAIL_K = new THREE.Color(0xe0e0e0).r

export interface GrassHandles {
  /** re-place whatever slots the player just walked off the edge of */
  update: (x: number, z: number) => void
  /** fade the whole field out (indoors, or on the way to another level) */
  setVisible: (on: boolean) => void
}

/** the blades in one clump: local yaw, offset, scale and how far it arcs. The
    instance's own yaw spins the whole clump, so these angles stay relative */
const CLUMP = [
  { yaw: 0, dx: 0, dz: 0, s: 1, lean: 0.62 },
  { yaw: 2.24, dx: 0.14, dz: 0.09, s: 0.74, lean: 0.9 },
  { yaw: 4.31, dx: -0.11, dz: 0.12, s: 0.58, lean: 1.12 },
] as const

/** three tapered strips standing on the origin, unit height. Normals point up
    on purpose — see the header. */
const bladeGeometry = () => {
  const rows = 4
  const pos: number[] = []
  const nor: number[] = []
  const col: number[] = []
  const idx: number[] = []
  for (const b of CLUMP) {
    const base = pos.length / 3
    const ca = Math.cos(b.yaw)
    const sa = Math.sin(b.yaw)
    for (let i = 0; i < rows; i++) {
      const t = i / (rows - 1)
      // wider than it looks like it should be. The first field ran 0.075 to
      // 0.125 units — three to five centimetres at this world's scale — and
      // every blade read as a needle no matter how many there were. The tip
      // still has to close to nearly nothing, though: a squared-off tip is
      // what made the second field read as shredded paper
      const w = 0.5 * (1 - t * 0.87)
      // a real arc, not a ruler with a kink: a blade this straight was the
      // single thing making the first field read as a bed of nails
      const lean = t * t * b.lean
      for (const s of [-1, 1]) {
        const lx = s * w * b.s
        const lz = lean * b.s
        pos.push(b.dx + lx * ca - lz * sa, t * b.s, b.dz + lx * sa + lz * ca)
        nor.push(0, 1, 0)
        // the root is the ground colour itself, only shadowed a shade — the
        // instance colour is the drawn terrain under the clump, and the join
        // between soil and turf is exactly where a hue shift would show —
        // and the tip dries bright and warm: the gradient does the work a
        // translucency term would, for none of the cost
        const k = 0.92 + t * t * 0.5
        col.push(k * (1 + 0.1 * t), k, k * (1 - 0.22 * t))
      }
    }
    for (let i = 0; i < rows - 1; i++) {
      const a = base + i * 2
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
  }
  // One winding, material DoubleSide, and the backface normal flip patched
  // out in the shader (applySway's `upNormals`). This used to emit every
  // triangle a second time wound the other way, because DoubleSide flips the
  // normal on back faces and a blade whose normal is deliberately straight up
  // then lights from underground: half of every lawn rendered as near-black
  // spikes. The reversed copy fixed that and drew exactly the same pixels —
  // the rasteriser culls one winding or the other — for twice the index
  // buffer and twice the primitive count. The flip is one line of GLSL.
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  g.setIndex(idx)
  return g
}

/** two crossed quads with a painted petal disc; the whole flower is one
    instance, stem included in the painting */
const flowerGeometry = () => {
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (const yaw of [0, Math.PI / 2]) {
    const ca = Math.cos(yaw)
    const sa = Math.sin(yaw)
    const base = pos.length / 3
    for (const [cu, cv] of [[-1, 0], [1, 0], [1, 1], [-1, 1]] as const) {
      pos.push(cu * 0.5 * ca, cv, cu * 0.5 * sa)
      nor.push(0, 1, 0)
      uv.push(cu > 0 ? 1 : 0, cv)
    }
    // one winding; the material is DoubleSide with the normal flip patched
    // out, same as the blades above
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  g.setIndex(idx)
  return g
}

/** a daisy painted white-on-transparent: petals, a warm heart, a stem. The
    instance colour tints the petals, so one texture is every flower */
const makeFlowerTexture = () =>
  canvasTexture([64, 64], (ctx, w, h) => {
    const rand = seeded(0xf10e)
    ctx.clearRect(0, 0, w, h)
    const cx = w / 2
    const cy = h * 0.3
    // stem
    ctx.strokeStyle = 'rgb(120,150,90)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(cx, h)
    ctx.quadraticCurveTo(cx + 3, h * 0.62, cx, cy)
    ctx.stroke()
    // petals
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rand() * 0.3
      ctx.save()
      ctx.translate(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8)
      ctx.rotate(a)
      ctx.fillStyle = 'rgb(246,246,242)'
      ctx.beginPath()
      ctx.ellipse(0, 0, 9, 4.6, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    ctx.fillStyle = 'rgb(240,190,80)'
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fill()
  })

/* ------------------------------------------------------------- lattice -- */

/**
 * A scrolling lattice of instance slots. Slot (i, j) lives at a fixed world
 * position; the toroidal index means a scroll overwrites exactly the slots
 * that left the field. `fill` places or hides one slot.
 */
const makeLattice = (side: number, step: number, fill: (i: number, j: number) => void) => {
  let originI = Number.POSITIVE_INFINITY
  let originJ = Number.POSITIVE_INFINITY
  return (px: number, pz: number): boolean => {
    const oi = Math.round(px / step) - side / 2
    const oj = Math.round(pz / step) - side / 2
    if (oi === originI && oj === originJ) return false
    const first = !Number.isFinite(originI)
    if (first || Math.abs(oi - originI) >= side || Math.abs(oj - originJ) >= side) {
      for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) fill(oi + i, oj + j)
    } else {
      // only the rows and columns that just entered the field are stale
      const dx = oi - originI
      const dz = oj - originJ
      if (dx > 0) for (let k = 0; k < dx; k++)
        for (let j = 0; j < side; j++) fill(oi + side - 1 - k, oj + j)
      else if (dx < 0) for (let k = 0; k < -dx; k++)
        for (let j = 0; j < side; j++) fill(oi + k, oj + j)
      if (dz > 0) for (let k = 0; k < dz; k++)
        for (let i = 0; i < side; i++) fill(oi + i, oj + side - 1 - k)
      else if (dz < 0) for (let k = 0; k < -dz; k++)
        for (let i = 0; i < side; i++) fill(oi + i, oj + k)
    }
    originI = oi
    originJ = oj
    return true
  }
}

interface Opts {
  parent: THREE.Object3D
  trackDisposable: (d: { dispose: () => void }) => void
}

export function buildGrass({ parent, trackDisposable }: Opts): GrassHandles {
  const F_SIDE = gfx.flowerSide
  const F_HALF = (F_SIDE * F_STEP) / 2

  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion() // stays identity: the yaw is a shader job
  const s = new THREE.Vector3()
  const c = new THREE.Color()
  const hidden = new THREE.Vector3(0, 0, 0)
  const qf = new THREE.Quaternion()
  const e = new THREE.Euler()

  /**
   * One scrolling lattice of blade clumps: its own pool, material, scroller
   * and fade radius. Built twice — see the two-lattice note at the top of the
   * file — with nothing shared between the near and far fields but this code.
   */
  const makeBladeField = (side: number, step: number, widthK: number) => {
    const HALF = (side * step) / 2
    const geo = bladeGeometry()
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      // blades are thin and numerous; writing depth for every one of them is
      // most of their cost and buys nothing at this size
      alphaTest: 0,
      side: THREE.DoubleSide,
    })
    applySway(mat, {
      amplitude: 0.42, weight: 'localY', instancedYaw: true, rim: 0.85, fadeRadius: HALF,
      upNormals: true,
      // amp is in blade-local units, which xz-scale by the blade's *width*:
      // 2.2 widths of sideways push lays the tip over by about a third of a
      // metre, and the drop sinks it to roughly half height under a boot
      trample: { amp: 2.2, drop: 0.45 },
    })
    trackDisposable(geo)
    trackDisposable(mat)

    const count = side * side
    const mesh = new THREE.InstancedMesh(geo, mat, count)
    mesh.frustumCulled = false
    // blades never cast (sixteen thousand casters for no visible return) but
    // they do receive: a lawn that stays lit inside a tree's shadow floats
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const blade = new Float32Array(count * 2) // yaw, phase
    const bladeAttr = new THREE.InstancedBufferAttribute(blade, 2)
    bladeAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aBlade', bladeAttr)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    parent.add(mesh)

    /** place one blade slot; (i, j) are absolute lattice coordinates */
    const fill = (i: number, j: number) => {
      // toroidal: a slot's instance index depends only on its lattice
      // position, so a scroll overwrites exactly the ones that left the field
      const ii = ((i % side) + side) % side
      const jj = ((j % side) + side) % side
      const id = jj * side + ii

      const jitterX = rand2(i, j, 0x51f3) - 0.5
      const jitterZ = rand2(i, j, 0x77a1) - 0.5
      const x = i * step + jitterX * step * 1.6
      const z = j * step + jitterZ * step * 1.6

      // the yard grows this same turf now — its old authored tufts were a
      // darker, spikier grass standing on a lawn that matched neither, and
      // the fence line read as a seam between two art styles. Inside the
      // fence the field only respects the hardscape (house, porch, walk,
      // stones) and skips the paved logic: a fenced lawn is never a verge
      const yard = inYard(x, z, 0.6)
      let ok = !yard || !onHomeHardscape(x, z)
      let y = 0
      let biome: BiomeId = 'plains'
      let paved = 0
      if (ok) {
        y = terrainY(x, z)
        if (y < SEA_Y + 0.25) ok = false
      }
      if (ok) {
        biome = biomeAt(x, z, y, 0)
        if (!GRASS_HEIGHT[biome]) ok = false
      }
      if (ok) {
        // the drawn ground colour and pavedness under this clump, off the
        // same lattice interpolation the terrain mesh renders. Gating on the
        // exact pavedAt field was the verge bug's last hiding place: ground
        // colour lives on a 4-unit lattice, so the urban grey bleeds a full
        // cell past where pavedAt says the concrete stops, and blades gated
        // on the exact number stood bright green on ground that had already
        // faded to white. A fenced lawn is never a verge, so the yard keeps
        // its turf whatever the street outside is doing
        const drawnPaved = groundColorAt(x, z, c)
        if (!yard) {
          paved = drawnPaved
          if (paved > 0.42) ok = false
          else if (paved > 0 && rand2(i, j, 0x2b19) < paved * 1.9) ok = false
        }
      }
      // never inside a building you can walk into: an enterable shop's floor
      // is open air to this field, and blades grew up through the planks
      if (ok && insideInterior(x, z, 0.3)) ok = false
      if (!ok) {
        m.compose(hidden, q, s.set(0, 0, 0))
        mesh.setMatrixAt(id, m)
        return
      }

      const [lo, hi] = GRASS_HEIGHT[biome]!
      const r = rand2(i, j, 0x9c4d)
      // the yard is the one lawn somebody mows; on town ground the turf
      // shortens as the drawn pavedness rises, down to stubble where the
      // concrete takes over, so a verge reads as worn rather than planted
      const h = (lo + (hi - lo) * r) * (yard ? 0.7 : 1 - paved * 1.2)
      // the far field's blades are fatter. Past a dozen units a blade is a
      // couple of pixels and nobody reads it as a blade — what it contributes
      // is coverage, and coverage is what the sparse lattice is short of. The
      // near field draws over the whole region where the difference would be
      // visible, so the two never have to agree on a width
      const w = (0.13 + r * 0.07) * widthK
      m.compose(p.set(x, y - 0.05, z), q, s.set(w, h, w))
      mesh.setMatrixAt(id, m)

      blade[id * 2] = rand2(i, j, 0x3ea7) * Math.PI * 2
      blade[id * 2 + 1] = rand2(i, j, 0x1d55) * Math.PI * 2

      // the blade is painted with the pixel of ground it grows out of —
      // groundColorAt filled `c` above, straw drifts, paved fade and biome
      // blends included, since all of those live in the shared lattice now.
      // The only corrections are the detail map's average (DETAIL_K) and a
      // small per-blade jitter standing in for the map's mottle
      const k = DETAIL_K * (0.92 + rand2(i, j, 0x64b2) * 0.16)
      mesh.instanceColor!.setXYZ(id, c.r * k, c.g * k, c.b * k)
    }

    const scroll = makeLattice(side, step, fill)
    return {
      mesh,
      update: (px: number, pz: number) => {
        if (!scroll(px, pz)) return
        mesh.instanceMatrix.needsUpdate = true
        mesh.instanceColor!.needsUpdate = true
        bladeAttr.needsUpdate = true
      },
    }
  }

  // close range, where blades have to touch each other; and the long sparse
  // reach behind it, where only their colour survives the distance
  const near = makeBladeField(gfx.grassNearSide, NEAR_STEP, 1)
  const far = makeBladeField(gfx.grassSide, FAR_STEP, 1.45)

  // the flowers: their own sparse pool, same scroller, same wind
  const flowerTex = makeFlowerTexture()
  trackDisposable(flowerTex)
  const flowerGeo = flowerGeometry()
  const flowerMat = new THREE.MeshStandardMaterial({
    map: flowerTex, alphaTest: 0.45, roughness: 0.9, metalness: 0,
    side: THREE.DoubleSide,
  })
  applySway(flowerMat, {
    amplitude: 0.26, weight: 'localY', fadeRadius: F_HALF, upNormals: true,
    // flowers scale uniformly, so these are near-world units: a brushed
    // flower jostles aside rather than flattening. Its instance yaw rotates
    // the push off true radial, which the motion is too brief to betray
    trample: { amp: 0.7, drop: 0.28 },
  })
  trackDisposable(flowerGeo)
  trackDisposable(flowerMat)
  const fCount = F_SIDE * F_SIDE
  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, fCount)
  flowers.frustumCulled = false
  flowers.castShadow = false
  flowers.receiveShadow = true
  flowers.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  flowers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(fCount * 3), 3)
  flowers.instanceColor.setUsage(THREE.DynamicDrawUsage)
  parent.add(flowers)

  /** place one flower slot */
  const fillFlower = (i: number, j: number) => {
    const ii = ((i % F_SIDE) + F_SIDE) % F_SIDE
    const jj = ((j % F_SIDE) + F_SIDE) % F_SIDE
    const id = jj * F_SIDE + ii

    const x = i * F_STEP + (rand2(i, j, 0x8e2f) - 0.5) * F_STEP * 1.7
    const z = j * F_STEP + (rand2(i, j, 0x40c9) - 0.5) * F_STEP * 1.7

    let ok = !inYard(x, z, 0.8)
    let y = 0
    if (ok) {
      y = terrainY(x, z)
      if (y < SEA_Y + 0.25) ok = false
    }
    if (ok) {
      const biome = biomeAt(x, z, y, 0)
      const rate = FLOWERS[biome] ?? 0
      if (rand2(i, j, 0x3d11) > rate) ok = false
      if (ok) {
        const place = placeAt(x, z)
        if (pavedAt(place, roadAt(x, z, place)) > 0.05) ok = false
      }
      if (ok && insideInterior(x, z, 0.3)) ok = false
    }
    if (!ok) {
      m.compose(hidden, q, s.set(0, 0, 0))
      flowers.setMatrixAt(id, m)
      return
    }
    const sc = 0.55 + rand2(i, j, 0x5b77) * 0.5
    qf.setFromEuler(e.set(0, rand2(i, j, 0x66aa) * Math.PI * 2, 0))
    m.compose(p.set(x, y - 0.04, z), qf, s.set(sc, sc, sc))
    flowers.setMatrixAt(id, m)
    c.set(FLOWER_TINTS[Math.floor(rand2(i, j, 0x71e3) * FLOWER_TINTS.length)])
    flowers.instanceColor!.setXYZ(id, c.r, c.g, c.b)
  }

  const scrollFlowers = makeLattice(F_SIDE, F_STEP, fillFlower)

  const update = (px: number, pz: number) => {
    near.update(px, pz)
    far.update(px, pz)
    if (scrollFlowers(px, pz)) {
      flowers.instanceMatrix.needsUpdate = true
      flowers.instanceColor!.needsUpdate = true
    }
  }

  return {
    update,
    setVisible: (on) => {
      near.mesh.visible = on
      far.mesh.visible = on
      flowers.visible = on
    },
  }
}
