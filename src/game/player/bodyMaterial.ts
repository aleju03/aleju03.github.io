import * as THREE from 'three'
import { DEFAULT_LOOK, type PlayerLook } from './look'

/*
  The one material a body is drawn with, and the reason a repaint is free.

  `bodyShape.ts` stamps every vertex with an `aRole` code: which of eight
  paints it wears (skin, suit, trim, accent, glow, ink, cheek, glint, hair), plus a
  flag on everything above the neck. This is an ordinary MeshStandardMaterial
  with two small injections, so the scene's lights, fog, shadows and tone map
  reach the body exactly as they reach everything else:

  - the diffuse colour is looked up in `uPal`, a per-body palette uniform, and
    the glow role adds itself as emissive. A look change is four `Color.set()`
    calls into that array. Nothing about the material's *configuration* ever
    changes, so a repaint can never relink a shader (the root CLAUDE.md's
    boot-cost rule);
  - `uHideHead` discards the head's fragments in the colour pass. The camera
    *is* the head in first person, and a visible one fills the lens with the
    inside of your own skull. The shadow pass draws with three's own depth
    material, which knows nothing of the flag, so the head still casts.

  Every body builds its own instance (the palette is per body) but they all
  share one compiled program: `customProgramCacheKey` names the injection,
  so the local player, every remote player, the town's pedestrians and the
  pause-sheet preview link it once between them.
*/

/** the paints nobody picks: the face, the ink and blush on it, the hair */
const SKIN = '#f2d6bd'
const INK = '#1c1a22'
const CHEEK = '#ee9a8a'
const GLINT = '#ffffff'
const HAIR = '#7a4e33'

export interface BodyMaterial {
  material: THREE.MeshStandardMaterial
  setLook: (look: PlayerLook) => void
  /** true hides the head from the colour pass (not from shadows) */
  hideHead: (hidden: boolean) => void
  /** a multiplier on anything painted in the glint role, e.g. brighter at night */
  setGlow: (k: number) => void
}

export function makeBodyMaterial(look: PlayerLook = DEFAULT_LOOK): BodyMaterial {
  const pal = [SKIN, look.shell, look.trim, look.accent, look.glow, INK, CHEEK, GLINT, HAIR].map(
    (c) => new THREE.Color(c),
  )
  const uniforms = {
    uPal: { value: pal },
    uGlowK: { value: 1.6 },
    uHideHead: { value: 0 },
    uFaceLift: { value: 1 },
    uGummy: { value: 0.16 },
  }
  // a gummy sheen: smooth enough to carry a highlight blob through the
  // posterize, which is most of what makes a bean read as jelly
  const material = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0 })
  material.name = 'playerBody'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPal = uniforms.uPal
    shader.uniforms.uGlowK = uniforms.uGlowK
    shader.uniforms.uHideHead = uniforms.uHideHead
    shader.uniforms.uFaceLift = uniforms.uFaceLift
    shader.uniforms.uGummy = uniforms.uGummy
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aRole;
varying float vRole;
varying float vHead;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vHead = step(15.5, aRole);
vRole = aRole - 16.0 * vHead;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uPal[9];
uniform float uGlowK;
uniform float uHideHead;
uniform float uFaceLift;
uniform float uGummy;
varying float vRole;
varying float vHead;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if (vHead * uHideHead > 0.5) discard;
int role = int(vRole + 0.5);
diffuseColor.rgb = uPal[role];`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float lit = role == 7 ? 0.12 : 0.0;
totalEmissiveRadiance += uPal[role] * lit * uGlowK;
// a soft rim on the whole body, and a floor of light under the face: at dusk
// the scene's light falls away and a face with nothing of its own goes to a
// black disc under the hat, which is the one part of this body that has to
// read. uFaceLift scales both; it is a uniform, so tuning it relinks nothing
float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.5);
// the face is the top of the bean: everything head-flagged but the eyes
float face = (vHead > 0.5 && role != 4) ? 1.0 : 0.0;
totalEmissiveRadiance += uPal[role] * uFaceLift * (face * (0.07 + 0.22 * rim) + 0.1 * rim);
// the gummy: a little light of its own, strongest in the core and softest at
// the rim, the way light sits inside a jelly sweet. It flattens the shading
// ramp the posterize would otherwise cut into stacked bands
totalEmissiveRadiance += uPal[role] * uGummy * (0.55 + 0.45 * (1.0 - rim));
// the eyes are glossier than the gummy: a sharper highlight reads as wet
roughnessFactor = (role == 4 || role == 5) ? 0.3 : roughnessFactor;`,
      )
  }
  material.customProgramCacheKey = () => 'playerBody-v3'

  return {
    material,
    setLook: (next) => {
      pal[1].set(next.shell)
      pal[2].set(next.trim)
      pal[3].set(next.accent)
      pal[4].set(next.glow)
    },
    hideHead: (hidden) => {
      uniforms.uHideHead.value = hidden ? 1 : 0
    },
    setGlow: (k) => {
      uniforms.uGlowK.value = k
    },
  }
}
