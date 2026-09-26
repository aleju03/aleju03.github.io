import type * as THREE from 'three'
import { FADE_FRAG_DISSOLVE, FADE_VERT_BODY, FADE_VERT_HEAD, fadeFragHead } from './fade'
import { SEA_Y } from './land'
import { TEXELS_PER_UNIT } from '../render/texel'

/*
  The ground, drawn in the look's terms: texels, flat bands and crisp edges.

  The chunk ground used to be a vertex colour per lattice point times a grey
  speckle map, which through the pixel look read as smooth airbrushed
  gradients: sand faded into grass over four units, a verge was four units
  of grey bleeding into the lawn, a cliff was the colour of the meadow on
  top of it. Pixel art does the opposite. Materials meet on a hard, ragged
  line, and each one is drawn with a handful of tones on a texel grid.

  So the ground carries what it *is* per vertex (`aGround`: how paved, how
  sandy, how snowy, how rocky; `aTint`: its unpaved colour) and this shader
  picks one material per texel. The choice is a threshold with a per-texel
  jitter, which draws every border as a ragged pixel edge; on top of the
  vertex weights, two things decide by geometry alone: ground steeper than
  about thirty-seven degrees is rock (so a hill shows its cliff), and a
  gentle band just over the waterline is sand, wet and darker at the water,
  so every shore has a beach whatever the biome says. Each material then
  paints itself on the world texel grid (render/texel.ts): clumps and dark
  blades in the grass, ripples and grains in sand, strata and cracks in
  rock, sparkle in snow, joints in paving. Every pattern fades to its own
  average once a texel is smaller than a pixel, so the far ground is a tone
  and never moire.

  It keeps the chunk's birth dissolve (world/fade.ts), because a material
  only gets one onBeforeCompile. And it is careful about the mean: the grass
  field (grass.ts) colours its blades off the vertex colour, so the grass
  material's tones are balanced around it and a lawn stays one colour from
  the blade to the soil.
*/

const T = TEXELS_PER_UNIT.toFixed(1)

const VERT_HEAD = /* glsl */ `
  attribute vec4 aGround;
  attribute vec3 aTint;
  varying vec4 vGK;
  varying vec3 vGT;
  varying vec3 vGW;
  varying vec3 vGN;
  ${FADE_VERT_HEAD}
`
const VERT_BODY = /* glsl */ `
  ${FADE_VERT_BODY}
  vGK = aGround;
  vGT = aTint;
  vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vGN = normalize(mat3(modelMatrix) * objectNormal);
`

const FRAG_HEAD = /* glsl */ `
  varying vec4 vGK;
  varying vec3 vGT;
  varying vec3 vGW;
  varying vec3 vGN;
  ${fadeFragHead()}
  float glHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float glNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(glHash(i), glHash(i + vec2(1.0, 0.0)), u.x),
               mix(glHash(i + vec2(0.0, 1.0)), glHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`

const FRAG_COLOR = /* glsl */ `
  {
    vec2 wp = vGW.xz;
    // how many texels one pixel spans here, from the unsnapped coordinate
    float foot = max(fwidth(wp.x), fwidth(wp.y)) * ${T};
    float far = smoothstep(0.6, 1.5, foot);
    float near = 1.0 - far;
    // ...and the same for features a few texels across (a crack two texels
    // wide, a rock course, a ripple), which hold on several times further
    float near2 = 1.0 - smoothstep(0.6, 1.5, foot / 2.5);
    float near6 = 1.0 - smoothstep(0.6, 1.5, foot / 8.0);
    vec2 cell = floor(wp * ${T});
    vec2 tp = (cell + 0.5) / ${T};
    float th = glHash(cell);
    float n1 = glNoise(tp * 0.9);
    float n2 = glNoise(tp * 0.21 + 17.0);
    // the ragged edge: every border is a threshold nudged per texel
    float jit = (th - 0.5) * 0.36 * near + (n1 - 0.5) * 0.2;
    float ny = normalize(vGN).y;
    float h = vGW.y - ${SEA_Y.toFixed(2)};

    float paved = step(0.5 + jit, vGK.x);
    float rock = max(step(0.5 + jit, vGK.w), step(ny + jit * 0.12, 0.8)) * (1.0 - paved);
    float snow = step(0.5 + jit, vGK.z) * (1.0 - rock) * (1.0 - paved);
    float shore = step(h + jit * 1.6, 1.4) * step(0.9, ny);
    float sand = max(step(0.5 + jit, vGK.y), shore) * (1.0 - rock) * (1.0 - paved) * (1.0 - snow);

    vec3 base = diffuse * vGT;
    vec3 c = base;
    // soil and grass: clumps, dark blades, the odd pale fleck
    c *= 1.0 + (n1 - 0.5) * 0.3 * near6 + (n2 - 0.5) * 0.16;
    float tuft = glHash(floor(wp * ${T} / 2.0) + 3.0);
    c *= 1.0 - step(0.88, tuft) * 0.26 * near2 + step(tuft, 0.03) * 0.2 * near2;
    if (sand > 0.5) {
      // biome sand is its own tint; a shore on a grass biome is beach sand
      vec3 sc = mix(diffuse * vec3(0.54, 0.45, 0.23), base, step(0.5, vGK.y));
      // wind ripples: one-texel lines on a wavy course, and a pebble here
      // and there
      float rc0 = (tp.x * 0.83 + tp.y * 0.49) + (n2 - 0.5) * 3.0 + (n1 - 0.5) * 0.9;
      float rip = step(fract(rc0 / 2.3), 2.0 / ${T} / 2.3) * step(0.35, n1);
      float peb = step(0.985, glHash(floor(wp * ${T} / 2.0)));
      sc *= 1.0 - rip * 0.15 * near2 - peb * 0.4 * near2 + (n1 - 0.5) * 0.14 * near6;
      // wet at the water's edge, a clean darker band
      sc *= 1.0 - 0.28 * step(h + jit * 0.5, 0.55);
      c = sc;
    }
    if (snow > 0.5) {
      vec3 wc = base * (1.0 + (n2 - 0.5) * 0.12);
      // blue in the hollows, a glint here and there
      wc = mix(wc, wc * vec3(0.84, 0.91, 1.06), step(n1, 0.32) * near6);
      wc *= 1.0 + step(0.985, th) * 0.25 * near;
      c = wc;
    }
    if (rock > 0.5) {
      // a rock biome keeps its own grey; a cliff in grass country is stone
      vec3 rc = mix(diffuse * vec3(0.147, 0.133, 0.116), base, step(0.5, vGK.w));
      // stone in courses: blocks of rock split by one-texel cracks, each
      // block its own tone, which is how a cliff reads as rock and not as
      // grey paint
      float bv = vGW.y / 0.75 + n2 * 1.3;
      float bu = (tp.x + tp.y) / 1.4 + floor(bv) * 0.41;
      vec2 bd = vec2(abs(fract(bu) - 0.5) * 1.4, abs(fract(bv) - 0.5) * 0.75);
      float crack = step(0.5 * 1.4 - 2.0 / ${T}, bd.x) + step(0.5 * 0.75 - 2.0 / ${T}, bd.y);
      float tone = glHash(vec2(floor(bu), floor(bv)));
      rc *= 1.0 + (tone - 0.5) * 0.34 * near6 + (n1 - 0.5) * 0.1 * near6 - min(crack, 1.0) * 0.45 * near2;
      c = rc;
    }
    if (paved > 0.5) {
      // paving: the town's own grey, in slabs
      vec3 pc = diffuseColor.rgb;
      vec2 j = abs(fract(tp / 1.6) - 0.5) * 1.6;
      float joint = step(min(j.x, j.y), 1.0 / ${T});
      pc *= 1.0 + (n1 - 0.5) * 0.1 * near6 - joint * 0.2 * near2;
      c = pc;
    }
    diffuseColor.rgb = c;
  }
`

/**
 * Give the chunk ground material its look, and its birth dissolve.
 */
export const applyGroundLook = (mat: THREE.Material, uTime: { value: number }) => {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FADE_FRAG_DISSOLVE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
  }
  mat.customProgramCacheKey = () => 'ground-look-1'
  mat.needsUpdate = true
}
