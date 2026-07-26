import * as THREE from 'three'

/*
  How a streamed chunk arrives without popping.

  The streamer builds geometry behind the fog, but a fast traveller outruns
  the queue and a re-tiered chunk grows its trees in plain sight — either way
  a finished mesh lands on screen in one frame. The fix cannot be material
  opacity, because every chunk in the ring shares six materials, and it cannot
  be real transparency on the opaque soup, because that would re-sort and —
  worse — relink shader variants mid-walk. So each geometry carries one baked
  per-vertex float, `aBirth`: the world-clock time (wind's uTime) the vertices
  first existed, constant across whatever slice of the chunk was born together.
  The shaders already share that clock, and the fragment stage compares the two:

  - opaque surfaces (ground, detail soup, foliage cards) dissolve in through a
    screen-door dither — an interleaved-gradient-noise threshold on
    gl_FragCoord, discarded early in main. Stable per pixel, needs no sorting,
    keeps depth writes, and the leaf material already pays a discard for its
    alpha test.
  - transparent surfaces (water, window glass) simply multiply alpha up.

  Geometry that must not fade — everything primed under the boot cover, sync
  builds under the player's feet, and the slices of a re-tiered chunk that were
  already on screen — is stamped `PREBORN`, far enough in the past that the
  math saturates on the first frame. The chunk builder decides slice by slice
  (see buildChunk's `fade` argument); this module only owns the numbers and
  the GLSL.

  The sun's depth pass is deliberately left out: the default depth material is
  scene-shared and a fading chunk is at least two chunks out, past the shadow
  map's reach, so a shadow arriving a beat before its tree is never visible.
*/

/** how long a newly streamed slice takes to dissolve in, seconds */
export const FADE_S = 0.9

/** the birth stamp meaning "was always here": far enough in the past that
    every fade expression saturates on the first frame drawn */
export const PREBORN = -1e6

export const FADE_VERT_HEAD = /* glsl */ `
  attribute float aBirth;
  varying float vBirth;
`

export const FADE_VERT_BODY = /* glsl */ `
  vBirth = aBirth;
`

/** the fragment stage declares its own uTime unless the host shader already
    has one there (the water does) */
export const fadeFragHead = (declareTime = true) => /* glsl */ `
  varying float vBirth;
  ${declareTime ? 'uniform float uTime;' : ''}
`

/** opaque dissolve: interleaved gradient noise thresholded against age.
    Injected right after <clipping_planes_fragment> — the top of main — so a
    discarded fragment pays for nothing else */
export const FADE_FRAG_DISSOLVE = /* glsl */ `
  {
    float fadeK = (uTime - vBirth) * float(${1 / FADE_S});
    if (fadeK < 1.0) {
      float fadeD = fract(52.9829189 *
        fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (fadeD >= fadeK) discard;
    }
  }
`

/** transparent fade: goes after <opaque_fragment> (or anywhere gl_FragColor
    is already written) and rides the material's existing blending */
export const FADE_FRAG_ALPHA = /* glsl */ `
  gl_FragColor.a *= clamp((uTime - vBirth) * float(${1 / FADE_S}), 0.0, 1.0);
`

/**
 * Patch a material that has no other injection so its geometry fades in by
 * `aBirth`. The chunk's ground and window glass use this; the detail and leaf
 * materials carry the same GLSL through applySway (a material only gets one
 * onBeforeCompile), and the water carries it inside makeWaterStylized.
 * The shared uTime uniform is passed in rather than imported so this module
 * stays free of the wind's clock.
 */
export const applyFadeIn = (
  mat: THREE.Material,
  uTime: { value: number },
  mode: 'dissolve' | 'alpha',
) => {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FADE_VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FADE_VERT_BODY}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fadeFragHead()}`)
      .replace(
        mode === 'dissolve'
          ? '#include <clipping_planes_fragment>'
          : '#include <opaque_fragment>',
        mode === 'dissolve'
          ? `#include <clipping_planes_fragment>\n${FADE_FRAG_DISSOLVE}`
          : `#include <opaque_fragment>\n${FADE_FRAG_ALPHA}`,
      )
  }
  mat.customProgramCacheKey = () => `fade:${mode}`
  mat.needsUpdate = true
}

/** stamp one constant birth over a whole geometry */
export const bakeBirth = (g: THREE.BufferGeometry, birth: number) => {
  const n = g.getAttribute('position').count
  g.setAttribute('aBirth', new THREE.BufferAttribute(new Float32Array(n).fill(birth), 1))
}
