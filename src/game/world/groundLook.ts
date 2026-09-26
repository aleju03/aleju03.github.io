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

/** how much of each biome is farmed, from the air: the patchwork of fields
    and hedgerows that makes open country read as country rather than as a
    camouflage of grass and straw. Chunk ground and the far field bake the
    same weight per vertex (`fieldWeight`) and draw the same pattern
    (`FIELDS_GLSL`), so the fields run on across the ring's edge */
const FIELD_W: Partial<Record<string, number>> = { plains: 1, savanna: 0.55, forest: 0.2, wetland: 0.1 }
export const fieldWeight = (biome: string, paved: number, town: boolean) =>
  town ? 0 : (FIELD_W[biome] ?? 0) * (1 - paved)

/** fades the fields into the chunk ground from the air (streamer.ts sets it
    from the camera's height): underfoot the grass field grows from the
    vertex colour, and a wheat field drawn under green blades reads as a
    mistake. The far field is always past the fog on the ground anyway */
export const groundLookUniforms = { uFieldK: { value: 0 } }

/**
 * Farmland, as a function of world position: rows of fields of hashed
 * widths, each a crop tone (wheat with its rows, young green, ploughed
 * furrows, hay) or left as meadow, with a one-pixel hedgerow round every
 * one. Clustered into farming country by a slow noise, so it is a feature
 * of places rather than a grid laid over the planet. Everything past the
 * point a furrow is a pixel becomes its own average. Returns the field
 * colour (before the material's grey) in rgb and how much of it applies in
 * a; `hedge` is the hedgerow's coverage.
 */
export const FIELDS_GLSL = /* glsl */ `
  float fdHash(vec2 p) {
    return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
  }
  float fdNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(fdHash(i), fdHash(i + vec2(1.0, 0.0)), f.x),
               mix(fdHash(i + vec2(0.0, 1.0)), fdHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  vec4 fields(vec2 w, float px, out float hedge) {
    hedge = 0.0;
    float farm = smoothstep(0.3, 0.4, fdNoise(w / 520.0 + 11.0));
    if (farm <= 0.0) return vec4(0.0);
    float rowH = 34.0;
    float row = floor(w.y / rowH);
    float colW = 38.0 + 46.0 * fdHash(vec2(row, 7.0));
    float off = fdHash(vec2(row, 3.0)) * colW;
    float col = floor((w.x + off) / colW);
    vec2 f = vec2(fract((w.x + off) / colW) * colW, fract(w.y / rowH) * rowH);
    float h = fdHash(vec2(col, row));
    float edge = min(min(f.x, colW - f.x), min(f.y, rowH - f.y));
    float hw = 0.8;
    hedge = (1.0 - smoothstep(hw - px * 0.5, hw + px * 0.5, edge)) * farm;
    float rows = 1.0 - smoothstep(0.4, 1.0, px / 1.6);
    vec3 c;
    if (h < 0.24) {
      c = vec3(0.46, 0.37, 0.13) * (1.0 - 0.14 * rows * step(0.55, fract(f.y / 1.6)));
    } else if (h < 0.44) {
      c = vec3(0.19, 0.31, 0.09) * (1.0 - 0.12 * rows * step(0.5, fract(f.x / 1.4)));
    } else if (h < 0.58) {
      c = vec3(0.23, 0.15, 0.08) * (1.0 - 0.2 * rows * step(0.5, fract(f.y / 1.2)));
    } else if (h < 0.72) {
      c = vec3(0.37, 0.36, 0.17);
    } else {
      return vec4(0.0, 0.0, 0.0, 0.0);
    }
    return vec4(c, farm);
  }
`

const VERT_HEAD = /* glsl */ `
  attribute vec4 aGround;
  attribute vec4 aTint;
  varying vec4 vGK;
  varying vec3 vGT;
  varying float vGF;
  varying vec3 vGW;
  varying vec3 vGN;
  ${FADE_VERT_HEAD}
`
const VERT_BODY = /* glsl */ `
  ${FADE_VERT_BODY}
  vGK = aGround;
  vGT = aTint.rgb;
  vGF = aTint.a;
  vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vGN = normalize(mat3(modelMatrix) * objectNormal);
`

const FRAG_HEAD = /* glsl */ `
  varying vec4 vGK;
  varying vec3 vGT;
  varying float vGF;
  varying vec3 vGW;
  varying vec3 vGN;
  uniform float uFieldK;
  ${fadeFragHead()}
  ${FIELDS_GLSL}
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
    // farmland, from the air (see FIELDS_GLSL): on gentle, open soil
    if (uFieldK > 0.0 && vGF > 0.05 && paved + rock + snow < 0.5 && ny > 0.93 && h > 1.6) {
      float hedgeK;
      float pxW = foot / ${T};
      vec4 fd = fields(wp, pxW, hedgeK);
      float k = uFieldK * step(0.5 + jit * 0.3, vGF + 0.35) * fd.a;
      c = mix(c, diffuse * fd.rgb, k);
      c = mix(c, diffuse * vec3(0.07, 0.13, 0.05), hedgeK * uFieldK * step(0.5, vGF + 0.35));
    }
    if (sand > 0.5) {
      // biome sand is its own tint; a shore on a grass biome is beach sand
      vec3 sc = mix(diffuse * vec3(0.54, 0.45, 0.23), base, step(0.5, vGK.y));
      // wind ripples: a lit crest and a shaded trough in each, parallel
      // and only gently bent, which is what reads as ripples; one dark line
      // on a wavy course read as the cracks in dried mud
      float rc0 = (tp.x * 0.83 + tp.y * 0.49) + (n2 - 0.5) * 1.1;
      float rip = fract(rc0 / (1.1 + 0.4 * n1));
      float crest = step(rip, 0.22);
      float trough = step(0.22, rip) * step(rip, 0.4);
      float peb = step(0.985, glHash(floor(wp * ${T} / 2.0)));
      sc *= 1.0 + (crest * 0.13 - trough * 0.16) * near2 - peb * 0.4 * near2 + (n1 - 0.5) * 0.12 * near6;
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
      vec3 rc = mix(diffuse * vec3(0.13, 0.128, 0.122), base, step(0.5, vGK.w));
      // stone in courses: blocks of rock split by one-texel cracks, each
      // block its own tone, which is how a cliff reads as rock and not as
      // grey paint
      float bv = vGW.y / 1.5 + n2 * 1.7 + n1 * 0.35;
      float bl = 2.4 + 1.8 * glHash(vec2(floor(bv), 3.0));
      // along the contour of the face, whichever way it looks: on a face
      // turned along the diagonal, x + y was constant and every block
      // stretched into one big square of its tone, a checkerboard
      vec2 nh = normalize(vGN.xz + vec2(1e-4, 0.0));
      float along = dot(tp, vec2(-nh.y, nh.x));
      float bu = along / bl + glHash(vec2(floor(bv), 9.0));
      vec2 bd = vec2(abs(fract(bu) - 0.5) * bl, abs(fract(bv) - 0.5) * 1.5);
      float crack = step(0.5 * bl - 2.0 / ${T}, bd.x) + step(0.5 * 1.5 - 2.0 / ${T}, bd.y);
      // each course catches the light along its top edge: a ledge
      float ledge = step(0.78, fract(bv)) * (1.0 - step(0.5 * 1.5 - 2.0 / ${T}, bd.y));
      float tone = glHash(vec2(floor(bu), floor(bv)));
      rc *= 1.0 + (tone - 0.5) * 0.16 * near6 + (n1 - 0.5) * 0.1 * near6
        + ledge * 0.16 * near2 - min(crack, 1.0) * 0.5 * near2;
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
    shader.uniforms.uFieldK = groundLookUniforms.uFieldK
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FADE_FRAG_DISSOLVE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
  }
  mat.customProgramCacheKey = () => 'ground-look-2'
  mat.needsUpdate = true
}
