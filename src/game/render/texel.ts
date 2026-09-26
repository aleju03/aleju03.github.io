import * as THREE from 'three'

/*
  The world's texel grid, and the one texture setting that goes with it.

  A pixel-art look is two grids agreeing: the screen's (pixelLook.ts renders
  a few hundred chunky lines) and the surfaces' (what a brick, a slab or a
  shingle is drawn *with*). When a wall's pattern is computed per fragment at
  full precision, its mortar lines are smooth antialiased strokes and the wall
  reads as a vector drawing that happens to be low resolution. Quantize the
  pattern's coordinates to a fixed world-space grid first and every line is
  a whole number of texels thick, every brick an exact block of them, and up
  close the wall is a painted texture made of visible square texels, which is
  what a pixel artist would have drawn.

  `TEXELS_PER_UNIT` is that grid. Sixteen per world unit (the walker's eye is
  3.84 units up, so about 60 texels to a person's height) is where a texel is
  one screen pixel about fifteen units away at the default 540 lines: closer
  than that the texels get chunky, further they fade to their average rather
  than shimmering. Everything that paints a surface should share it, the
  procedural pass in `world/surface.ts` and any canvas texture mapped at a
  known world scale alike, or two neighbouring surfaces show two different
  pixel sizes and the illusion is gone.

  `texelate` is the texture half: magnify nearest-neighbour, so a canvas
  texture seen up close shows its texels as squares instead of a bilinear
  smear, while minification keeps its mipmaps, because a nearest-filtered
  texture in the distance is exactly the sparkle the look cannot afford.
*/

export const TEXELS_PER_UNIT = 16

/** crisp texels up close, filtered mips far away. Returns the texture */
export const texelate = <T extends THREE.Texture>(tex: T): T => {
  tex.magFilter = THREE.NearestFilter
  tex.needsUpdate = true
  return tex
}

const MAP_SLOTS = ['map', 'emissiveMap'] as const

/** texelate every colour map under an object: downloaded models, whose
    textures arrive bilinear. Call before the first draw, under the cover,
    since a filter change on an uploaded texture is a re-upload */
export const texelateTree = (root: THREE.Object3D) => {
  const seen = new Set<THREE.Texture>()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) {
      for (const slot of MAP_SLOTS) {
        const t = (m as THREE.MeshStandardMaterial)[slot]
        if (t && !seen.has(t) && t.magFilter !== THREE.NearestFilter) {
          seen.add(t)
          texelate(t)
        }
      }
    }
  })
}
