import * as THREE from 'three'
import { TEXTURES, TEX_SIZE, paintTexture } from '../../sandbox/blocks'
import { FADE_FRAG_ALPHA, FADE_FRAG_DISSOLVE, FADE_VERT_BODY, FADE_VERT_HEAD, fadeFragHead } from '../../world/fade'

/*
  The two materials Cubeland's ground is drawn with: the blocks, and the
  water over them. Both are the scene's ordinary MeshStandardMaterial, so
  they keep its sun, its shadows, its fog and its hemisphere light, with an
  `onBeforeCompile` that swaps the colour map for one layer of an array
  texture.

  **An array texture, not an atlas.** The mesher merges faces into big
  rectangles whose texture coordinates run in blocks, so a quad five blocks
  wide wants its texture five times across. An atlas cannot repeat one of
  its cells; a `DataArrayTexture` of 16x16 layers with repeat wrapping
  does it in the sampler, and its mipmaps are made per layer, so a distant
  hillside neither shimmers nor bleeds a neighbouring texture into it.
  Magnified it is nearest, which is the look; minified it is
  nearest-within-a-mip, which keeps the pixels square as they shrink.

  **See-through pixels are cut, not blended**: a pixel under half alpha is
  discarded, which is how the leaves, the glass and the flowers have holes
  and still draw in the opaque pass with the depth they need for the look's
  outlines. The material's own `alphaTest` stays 0 on purpose: set, three
  would give its shadow pass the colour map at these block-unit coordinates,
  and a tree's shadow would be a lottery of holes. Leaves cast whole.

  **Chunks fade in** the way the open world's do (world/fade.ts): each
  vertex carries the time its chunk was meshed (`aBirth`) and the solid
  pass dissolves it in through the same screen-door dither against
  `fadeClock`, the water by alpha. A chunk re-meshed on screen is stamped
  PREBORN and simply swaps.

  **Glow** is a per-vertex flag (the glowstone) that adds the texture's own
  colour to the emitted light, at the look's HDR, so it burns in a cave.

  The vertex colour arrives at half scale (a biome's tint can lift a
  channel over one) and is doubled here with the texel. The vertex format
  is the mesher's: 16-bit positions and texture
  coordinates in eighths of a block (the mesh is scaled; the texture
  coordinate is scaled here), byte normals and colours, and the layer and
  glow as two bytes. Each material has its own program key, and both are
  compiled under the map's card with everything else.
*/

export interface TerrainMats {
  solid: THREE.MeshStandardMaterial
  water: THREE.MeshStandardMaterial
  texture: THREE.DataArrayTexture
}

/** the clock the fade compares a chunk's birth against, seconds (the level
    advances it every frame) */
export const fadeClock = { value: 0 }

const inject = (key: string) => (shader: THREE.WebGLProgramParametersWithUniforms, tex: THREE.DataArrayTexture) => {
  shader.uniforms.uBlocks = { value: tex }
  shader.uniforms.uTime = fadeClock
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>\nattribute vec2 aTex;\nattribute vec2 aBlk;\nvarying vec2 vTex;\nvarying vec2 vBlk;\n${FADE_VERT_HEAD}`,
    )
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n  vTex = aTex * 0.125;\n  vBlk = aBlk;\n${FADE_VERT_BODY}`)
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>\nuniform highp sampler2DArray uBlocks;\nvarying vec2 vTex;\nvarying vec2 vBlk;\n${fadeFragHead(true)}`,
    )
    .replace(
      key === 'water' ? '#include <opaque_fragment>' : '#include <clipping_planes_fragment>',
      key === 'water' ? `#include <opaque_fragment>\n${FADE_FRAG_ALPHA}` : `#include <clipping_planes_fragment>\n${FADE_FRAG_DISSOLVE}`,
    )
    .replace(
      '#include <map_fragment>',
      key === 'water'
        ? 'vec4 blockTexel = texture(uBlocks, vec3(vTex, vBlk.x));\n  diffuseColor.rgb *= blockTexel.rgb * 2.0;'
        : 'vec4 blockTexel = texture(uBlocks, vec3(vTex, vBlk.x));\n  if (blockTexel.a < 0.5) discard;\n  diffuseColor.rgb *= blockTexel.rgb * 2.0;',
    )
    .replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vBlk.y * 1.8;',
    )
}

let shared: TerrainMats | null = null

/** the materials, made once per session (the textures are painted on the
    first call; headless, the texture is still built but never uploaded) */
export const terrainMaterials = (): TerrainMats => {
  if (shared) return shared
  const layers = TEXTURES.length
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4 * layers)
  TEXTURES.forEach((name, i) => data.set(paintTexture(name), i * TEX_SIZE * TEX_SIZE * 4))
  const texture = new THREE.DataArrayTexture(data, TEX_SIZE, TEX_SIZE, layers)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true

  const make = (key: 'solid' | 'water') => {
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: key === 'water' ? 0.35 : 1,
      metalness: 0,
      transparent: key === 'water',
      opacity: key === 'water' ? 0.72 : 1,
      depthWrite: key !== 'water',
      emissive: new THREE.Color(0, 0, 0),
    })
    const fn = inject(key)
    m.onBeforeCompile = (shader) => fn(shader, texture)
    m.customProgramCacheKey = () => `cubeland-${key}`
    m.name = `cubeland-${key}`
    return m
  }
  shared = { solid: make('solid'), water: make('water'), texture }
  return shared
}
