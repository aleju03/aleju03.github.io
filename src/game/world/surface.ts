/*
  What makes a wall look like a wall.

  Every solid in a chunk arrives as one merged, vertex-coloured soup — which is
  the only reason a city can be three draw calls, and also the reason none of
  it had any surface. A merged box has no UVs worth the name, so a house was
  literally a flat rectangle of one colour, and a street of them read as a
  cardboard model. Unwrapping is not an option at this vertex count, and
  neither is a texture atlas: nothing here ships images, and the geometry is
  rebuilt every time the player crosses a chunk border.

  So the pattern is computed instead, in the fragment shader, from world
  position and world normal — triplanar in the cheap sense: pick the two axes
  the face is *not* pointing down, and you have a stable planar coordinate on
  any axis-aligned surface, which is what every wall, kerb, roof and road in
  this world is. Each stamp carries a one-float `aSurf` code saying which
  treatment it wants, and everything organic asks for none and pays only for
  the branch.

  The patterns are deliberately analytic — bands, grids, staggered courses —
  with a single noise call shared between them for grain. Analytic detail
  survives distance without shimmering (it fades on the same fwidth the eye
  does), and one hash-noise per fragment is a cost a cold iGPU can carry across
  a whole city block. Everything modulates the existing lit colour rather than
  replacing it, so fog, tone mapping and the day cycle all still apply.
*/

import type * as THREE from 'three'

export const SURF = {
  /** organic, or anything that would rather be left alone */
  none: 0,
  /** painted render: fine mottle, nothing else */
  plaster: 1,
  /** staggered courses with mortar joints */
  brick: 2,
  /** curtain wall: storey bands and vertical mullions */
  panel: 3,
  /** roof: overlapping courses running with the slope */
  shingle: 4,
  /** road: grain plus faint wheel polish along the lane */
  asphalt: 5,
  /** pavement, kerbs, doorsteps: slab joints */
  paving: 6,
  /** trunks and posts: vertical fibre */
  bark: 7,
  /** planks: boards with a groove between them */
  plank: 8,
  /** birch bark: pale, with horizontal lenticels and shed-branch scars */
  birch: 9,
} as const

export type SurfaceId = (typeof SURF)[keyof typeof SURF]

/** injected into the vertex shader, alongside whatever else is patching it.
    `fixed` skips the per-vertex attribute for callers whose whole material is
    one treatment — the house's own walls, which are not part of the chunk
    soup and carry no aSurf */
export const surfaceVertHead = (fixed?: number) => /* glsl */ `
  ${fixed === undefined ? 'attribute float aSurf;' : ''}
  varying float vSurf;
  varying vec3 vWPos;
  varying vec3 vWNrm;
`

/** goes after <begin_vertex>, so it sees the final (swayed) position */
export const surfaceVertBody = (fixed?: number) => /* glsl */ `
  vSurf = ${fixed === undefined ? 'aSurf' : `float(${fixed})`};
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vWNrm = normalize(mat3(modelMatrix) * objectNormal);
`

export const SURFACE_FRAG_HEAD = /* glsl */ `
  varying float vSurf;
  varying vec3 vWPos;
  varying vec3 vWNrm;

  float sfHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float sfNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(sfHash(i), sfHash(i + vec2(1.0, 0.0)), u.x),
               mix(sfHash(i + vec2(0.0, 1.0)), sfHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // a line of width w every p units, antialiased against the pixel footprint
  // so a brick course fades out at distance instead of turning into moire
  float sfLine(float x, float p, float w) {
    float d = abs(fract(x / p) - 0.5) * p;
    float aa = fwidth(x) + 0.004;
    return 1.0 - smoothstep(w - aa, w + aa, d);
  }
`

/** goes at the end of the fragment shader; multiplies the lit colour */
export const SURFACE_FRAG_BODY = /* glsl */ `
  if (vSurf > 0.5) {
    vec3 an = abs(vWNrm);
    // the planar coordinate for this face: on a wall, "along" and "up";
    // on anything flat, the two ground axes
    bool flat_ = an.y > 0.6;
    float u = flat_ ? vWPos.x : (an.x > an.z ? vWPos.z : vWPos.x);
    float v = flat_ ? vWPos.z : vWPos.y;
    float grain = sfNoise(vec2(u, v) * 3.1);
    float k = 1.0;

    if (vSurf < 1.5) {
      // plaster: a fine mottle plus a slow one, so a big wall has weather on it
      k = 1.0 + (grain - 0.5) * 0.13 + (sfNoise(vec2(u, v) * 0.36) - 0.5) * 0.1;
    } else if (vSurf < 2.5) {
      // brick: 0.34 courses, 0.72 long, every other row offset by half
      float row = floor(v / 0.34);
      float off = mod(row, 2.0) * 0.36;
      float mortar = max(sfLine(v + 0.17, 0.34, 0.03), sfLine(u + off, 0.72, 0.028));
      float brick = sfHash(vec2(floor((u + off) / 0.72), row));
      k = (1.0 + (brick - 0.5) * 0.17 + (grain - 0.5) * 0.08) * (1.0 - mortar * 0.34);
    } else if (vSurf < 3.5) {
      // curtain wall: storey bands, mullions between them, glassy panels
      float storey = sfLine(v + 1.6, 3.2, 0.09);
      float mullion = sfLine(u, 1.6, 0.045);
      float pane = sfHash(vec2(floor(u / 1.6), floor(v / 3.2)));
      k = (1.0 + (pane - 0.5) * 0.14) * (1.0 - storey * 0.3 - mullion * 0.22);
    } else if (vSurf < 4.5) {
      // shingle: courses across the slope, each row nicked into tabs
      float course = sfLine(v * 1.9 + u * 0.02, 0.42, 0.05);
      float tab = sfLine(u, 0.5, 0.022);
      float shade = sfHash(vec2(floor(u / 0.5), floor(v * 1.9 / 0.42)));
      k = (1.0 + (shade - 0.5) * 0.15) * (1.0 - course * 0.26 - tab * 0.1);
    } else if (vSurf < 5.5) {
      // asphalt: coarse grain, and two polished tracks where the wheels go
      float polish = sfLine(u, 3.2, 0.6) * 0.06;
      k = 1.0 + (grain - 0.5) * 0.2 + (sfNoise(vec2(u, v) * 11.0) - 0.5) * 0.1 + polish;
    } else if (vSurf < 6.5) {
      // paving: 1.4 slabs with a joint, each one its own shade of grey
      float joint = max(sfLine(u, 1.4, 0.028), sfLine(v, 1.4, 0.028));
      float slab = sfHash(floor(vec2(u, v) / 1.4));
      k = (1.0 + (slab - 0.5) * 0.11 + (grain - 0.5) * 0.07) * (1.0 - joint * 0.28);
    } else if (vSurf < 7.5) {
      // bark: fibre running up the trunk, and a slow swell around it
      float fibre = sfNoise(vec2(u * 9.0, v * 1.1));
      k = 1.0 + (fibre - 0.5) * 0.3 + (sfNoise(vec2(u * 2.2, v * 0.4)) - 0.5) * 0.16;
    } else if (vSurf < 8.5) {
      // plank: boards with a groove between, and grain along them
      float groove = sfLine(v, 0.36, 0.02);
      float board = sfHash(vec2(floor(v / 0.36), 0.0));
      k = (1.0 + (board - 0.5) * 0.13 + (sfNoise(vec2(u * 6.0, v * 1.4)) - 0.5) * 0.14)
        * (1.0 - groove * 0.24);
    } else {
      // birch: the opposite of bark. The noise is stretched the other way —
      // low frequency around the trunk, high up it — so it breaks into short
      // horizontal dashes, and only the top of its range is kept, which is
      // what makes them read as marks *on* white bark rather than as mottling
      // of it. The second, much coarser field is the dark collar left where a
      // low branch was shed; without it a birch is a barcode
      float lent = smoothstep(0.60, 0.88, sfNoise(vec2(u * 1.3, v * 9.0)));
      float scar = smoothstep(0.72, 0.95, sfNoise(vec2(u * 2.4, v * 1.1)));
      k = (1.0 + (grain - 0.5) * 0.07) * (1.0 - lent * 0.42 - scar * 0.34);
    }
    gl_FragColor.rgb *= k;
  }
`

/**
 * Give one whole material a single treatment, with no per-vertex attribute.
 * This is what the authored house uses: its walls are flat-coloured
 * MeshStandardMaterials built long before any of this existed, they have no
 * UVs worth tiling a canvas texture across, and a plain colour on a six-metre
 * wall reads as cardboard from the street.
 */
export const applyFixedSurface = (mat: THREE.Material, surf: SurfaceId) => {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${surfaceVertHead(surf)}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${surfaceVertBody(surf)}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURFACE_FRAG_HEAD}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${SURFACE_FRAG_BODY}`)
  }
  mat.customProgramCacheKey = () => `surface:${surf}`
  mat.needsUpdate = true
}
