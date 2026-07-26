import * as THREE from 'three'
import { canvasTexture } from '../core/textures'
import { seeded } from '../core/rand'
import { createMeshBuilder } from '../core/geometry'
import type { PropKind } from './biomes'
import { VARIANTS, kitsFor, stampKit, type Palette } from './props'
import { applySway } from './wind'

/*
  A standalone tree, outside the chunk system: the same kits props.ts stamps
  into the streamed world, built into their own little group so an authored
  level can plant one at an exact spot. The yard uses these now — its trees
  used to be the CC GLB models, which grew up alongside a hand-made street
  that no longer exists, and against the painterly card canopies over the
  fence they read as imports from a different game.

  The leaf-cluster texture lives here (not in streamer.ts) because both the
  chunk material and these standalone trees sample it, and this module is the
  one place both can import without a cycle. Materials are module singletons,
  like the kits themselves: built on first use, never disposed, shared by
  every tree.
*/

/**
 * The painted leaf cluster every foliage card samples. Painted in bright,
 * barely-green neutrals: the cards' vertex colours carry the actual leaf
 * palette (a jungle crown and a birch crown are the same texture), so this
 * map supplies only the clumping, the ragged rim and the alpha.
 *
 * Three passes, and the middle one is the whole point. This started as a
 * single scatter of 240 ellipses, which at roughly twice the coverage of the
 * disc they landed in overlapped into one solid blob — ragged at the rim and
 * opaque everywhere else. That is invisible on a small card and it is exactly
 * what you see on a big one: a green plane hanging off the edge of a crown,
 * because there is nothing inside the shape for the eye to read as leaves. So
 * the cluster is painted, then punched open, then sown with a few more leaves
 * over the holes so they read as gaps *between* leaves rather than as bites
 * taken out of a disc.
 *
 * Each leaf is drawn twice, a dark copy offset a pixel and a half behind a
 * lighter one, so two overlapping leaves still have an edge between them.
 * Without that the interior went back to being a blob however many holes were
 * punched in it.
 */
export const makeLeafTexture = () =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const rand = seeded(0x1eaf)
    ctx.clearRect(0, 0, w, h)
    const cx = w / 2
    const cy = h / 2
    const R = w * 0.47
    const TAU = Math.PI * 2
    const leaf = (x: number, y: number, s: number, lum: number) => {
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(rand() * TAU)
      const rgb = (k: number) =>
        `rgb(${Math.floor(lum * k * 0.9)},${Math.floor(Math.min(255, lum * k * 1.04))},${Math.floor(lum * k * 0.8)})`
      ctx.fillStyle = rgb(0.72)
      ctx.beginPath()
      ctx.ellipse(1.6, 1.8, s, s * 0.54, 0, 0, TAU)
      ctx.fill()
      ctx.fillStyle = rgb(1)
      ctx.beginPath()
      ctx.ellipse(0, 0, s * 0.93, s * 0.48, 0, 0, TAU)
      ctx.fill()
      ctx.restore()
    }
    // the body of the cluster. Leaves thin out toward the edge of the disc,
    // which is what gives a crown a silhouette made of leaves rather than a
    // cut edge
    for (let i = 0; i < 165; i++) {
      const a = rand() * TAU
      const rr = Math.pow(rand(), 0.58) * R
      leaf(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.94, 8 + rand() * 13,
        170 + rand() * 85)
    }
    // punch it open
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 52; i++) {
      const a = rand() * TAU
      const rr = Math.pow(rand(), 0.42) * R
      const s = 6 + rand() * 15
      ctx.save()
      ctx.translate(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.94)
      ctx.rotate(rand() * TAU)
      ctx.beginPath()
      ctx.ellipse(0, 0, s, s * 0.68, 0, 0, TAU)
      ctx.fill()
      ctx.restore()
    }
    ctx.globalCompositeOperation = 'source-over'
    // and sow leaves back over the gaps
    for (let i = 0; i < 62; i++) {
      const a = rand() * TAU
      const rr = Math.pow(rand(), 0.5) * R
      leaf(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.94, 6 + rand() * 9,
        185 + rand() * 70)
    }
  })

/** the temperate-forest palette the yard shares with the woods over the fence */
const YARD_PAL: Palette = {
  bark: new THREE.Color('#4a3826'),
  leaf: new THREE.Color('#477431'),
  accent: new THREE.Color('#c8c6bb'),
}

let mats: {
  solid: THREE.MeshStandardMaterial
  leaf: THREE.MeshStandardMaterial
  depth: THREE.MeshDepthMaterial
} | null = null

const materials = () => {
  if (mats) return mats
  const tex = makeLeafTexture()
  const solid = new THREE.MeshStandardMaterial({
    color: 0xe0e0e0, vertexColors: true, roughness: 0.92, metalness: 0,
  })
  applySway(solid, { amplitude: 0.34, weight: 'attribute' })
  const leaf = new THREE.MeshStandardMaterial({
    map: tex, alphaTest: 0.38, vertexColors: true, roughness: 0.95, metalness: 0,
  })
  applySway(leaf, { amplitude: 0.4, weight: 'attribute', rim: 0.45 })
  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.38,
  })
  mats = { solid, leaf, depth }
  return mats
}

export interface KitTree {
  group: THREE.Group
  /** the geometries the caller owns and must dispose */
  geos: THREE.BufferGeometry[]
  /** collision cylinder in world units at this scale, or null */
  solid: { r: number; h: number } | null
}

/** one tree, standing on its group's origin */
export const buildKitTree = (
  kind: PropKind, variant: number, scale: number, yaw: number, jitter = 0,
): KitTree => {
  const kit = kitsFor(kind)[((variant % VARIANTS) + VARIANTS) % VARIANTS]
  const m = materials()
  const solidB = createMeshBuilder()
  const cardB = createMeshBuilder(true)
  stampKit(solidB, cardB, kit, YARD_PAL, 0, 0, 0, scale, yaw, jitter)
  const group = new THREE.Group()
  const geos: THREE.BufferGeometry[] = []
  const sg = solidB.build()
  if (sg) {
    geos.push(sg)
    const mesh = new THREE.Mesh(sg, m.solid)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  const cg = cardB.build()
  if (cg) {
    geos.push(cg)
    const mesh = new THREE.Mesh(cg, m.leaf)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.customDepthMaterial = m.depth
    group.add(mesh)
  }
  return {
    group,
    geos,
    solid: kit.solid ? { r: kit.solid.r * scale, h: kit.solid.h * scale } : null,
  }
}
