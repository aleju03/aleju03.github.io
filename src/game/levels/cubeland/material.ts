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

  **Light.** Each vertex carries its sky light and its block light (the
  mesher's flood from torches, lamps and lava, 0..15). Sky light is baked
  into the vertex colour and scaled by the scene's own sun and sky as ever;
  block light is added here as warm emitted light on the block's own
  colour (the sky's darkening undone first, so a torch shows a cave wall
  its true colour), weighted by how little daylight reaches that face
  (`daylight` times its sky light), so a torch hardly shows at noon on open
  ground and lights a cave by day and everything round it at night. A
  per-vertex flag makes the things that are light (glowstone, lanterns, the
  flame of a torch, lava) glow in their own colour, at the look's HDR.
  Liquids scroll their texture, slowly when still and quickly when flowing.

  The vertex colour arrives at half scale (a biome's tint can lift a
  channel over one) and is doubled here with the texel. The vertex format
  is the mesher's (the layer, the flags and the two lights are aBlk's four
  bytes): 16-bit positions and texture
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

/** how much of the day's sky light is out there, 0 night .. 1 day (the
    level sets it off its clock): block light shows most where it is not */
export const daylight = { value: 1 }
/** the colour and strength of block light, linear HDR: a warm torch */
const LAMP = 'vec3(1.7, 0.98, 0.42)'

const inject = (key: string) => (shader: THREE.WebGLProgramParametersWithUniforms, tex: THREE.DataArrayTexture) => {
  shader.uniforms.uBlocks = { value: tex }
  shader.uniforms.uTime = fadeClock
  shader.uniforms.uDay = daylight
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>\nattribute vec2 aTex;\nattribute vec4 aBlk;\nvarying vec2 vTex;\nvarying vec4 vBlk;\nuniform float uTime;\n${FADE_VERT_HEAD}`,
    )
    .replace('#include <begin_vertex>', `#include <begin_vertex>
  vTex = aTex * 0.125;
  vBlk = aBlk;
  // liquids move: a slow shimmer on a still one, a quick run on a flowing one
  float liquidF = mod(floor(aBlk.y / 2.0), 2.0);
  float flowF = mod(floor(aBlk.y / 4.0), 2.0);
  vTex.y -= liquidF * uTime * (flowF > 0.5 ? 1.3 : 0.18);
${FADE_VERT_BODY}`)
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>\nuniform highp sampler2DArray uBlocks;\nuniform float uDay;\nvarying vec2 vTex;\nvarying vec4 vBlk;\n${fadeFragHead(true)}`,
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
      `#include <emissivemap_fragment>
  {
    // the colour the block would be in full sky light (mesher.ts bakes the
    // sky into the vertex colour on exactly this curve)
    float skyV = vBlk.z / 15.0;
    vec3 albedo = diffuseColor.rgb / (0.1 + 0.9 * pow(skyV, 1.5));
    // block light: the game's own falloff, and a torch counts for most
    // where the day does not reach
    float lampV = pow(vBlk.w / 15.0, 1.9);
    totalEmissiveRadiance += albedo * ${LAMP} * lampV * (1.0 - 0.85 * uDay * skyV);
    // and what is itself light
    totalEmissiveRadiance += albedo * mod(vBlk.y, 2.0) * 1.7;
  }`,
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
