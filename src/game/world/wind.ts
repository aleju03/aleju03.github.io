import * as THREE from 'three'
import {
  SURFACE_FRAG_BODY, SURFACE_FRAG_HEAD, surfaceVertBody, surfaceVertHead,
} from './surface'

/*
  One wind, shared by everything that grows.

  A stylized outdoor scene lives or dies on whether the vegetation moves, and
  moves *together*: a gust has to cross the field, bending the grass a moment
  before it reaches the tree, or the whole thing reads as a diorama. So there
  is exactly one clock and one direction here, and every material that wants
  to sway patches the same three uniforms into its vertex shader.

  The bend is built from four terms, which is the shape most stylized grass
  ends up with:

  - a travelling gust: a low-frequency wave moving across world space along
    the wind direction, so you see it arrive
  - a slow breeze underneath it, so nothing is ever perfectly still
  - a fast chop per instance, phase-offset, so neighbours don't move in lockstep
  - tip flutter, weighted to the very end of the blade

  The bend is applied as an *arc*, not a shear: the tip is pushed sideways and
  pulled down by roughly the square of the displacement, so a blade keeps its
  length instead of stretching into a streak. That single term is most of the
  difference between grass and wallpaper.

  Everything is injected through onBeforeCompile on ordinary
  MeshStandardMaterials rather than written as a whole custom shader. That
  keeps the project's lighting, fog and tone mapping exactly as they are —
  a hand-written shader would have to reimplement all of it — and it keeps
  this working on the WebGL renderer the rest of the site already uses.
*/

export const windUniforms = {
  uTime: { value: 0 },
  /** direction (xz) and strength (y unused), normalized xz */
  uWind: { value: new THREE.Vector3(0.82, 0, 0.57) },
  /** global strength, eased by weather/time of day */
  uGust: { value: 1 },
}

export const tickWind = (dt: number) => {
  windUniforms.uTime.value += dt
}

/** how hard it is blowing right now, 0..1.5; the sky ramps this */
export const setGust = (k: number) => {
  windUniforms.uGust.value = k
}

/** the GLSL every swaying material shares. `wPos` is world position (for the
    travelling wave), `weight` is 0 at the anchored end and 1 at the tip. */
export const WIND_GLSL = /* glsl */ `
  uniform float uTime;
  uniform vec3 uWind;
  uniform float uGust;

  // returns the world-space xz offset, and writes the arc drop into dropY
  vec2 windBend(vec3 wPos, float weight, float phase, float amp, out float dropY) {
    float along = dot(wPos.xz, uWind.xz);
    // the gust travelling across the field, plus a slower breeze under it
    float gust = sin(along * 0.045 - uTime * 1.35 + phase);
    float breeze = sin(along * 0.011 - uTime * 0.42) * 0.6;
    // per-instance chop and tip flutter
    float chop = sin(uTime * 3.1 + phase * 2.7) * 0.28;
    float flutter = sin(uTime * 7.3 + phase * 5.1) * 0.12 * weight;
    float w2 = weight * weight;
    float bend = (0.55 + 0.45 * gust + breeze * 0.35 + chop) * uGust * amp * w2;
    bend += flutter * uGust * amp;
    // an arc, not a shear: the tip drops as it swings out, so the blade
    // keeps its length instead of stretching
    dropY = bend * bend * 0.42;
    return uWind.xz * bend;
  }
`

interface SwayOpts {
  /** peak sideways displacement at the tip, in world units */
  amplitude: number
  /**
   * where the sway weight comes from.
   *  - 'localY': the vertex's own local y, 0..1. For instanced geometry built
   *    as a unit-height blade, this is exact and free.
   *  - 'attribute': a baked per-vertex `aSway` attribute, for merged geometry
   *    where local space was lost at merge time.
   */
  weight: 'localY' | 'attribute'
  /** instanced blades also carry a yaw we apply here rather than in the
      instance matrix, so the wind can be resolved in world space first */
  instancedYaw?: boolean
  /**
   * strength of a rim/translucency term, 0 to skip it. Grass is thin enough
   * that light comes *through* it, and that backlit glow along the edge of a
   * clump is most of what separates a stylized field from a green carpet.
   * Approximated with a Fresnel-ish view term rather than real subsurface
   * scattering, which is three orders of magnitude cheaper and, on blades
   * this small, indistinguishable.
   */
  rim?: number
  /**
   * also carry the procedural surface treatment in world/surface.ts, keyed off
   * the geometry's `aSurf` attribute. It rides along here rather than in its
   * own patcher because a material has exactly one onBeforeCompile, and the
   * chunk's detail material wants both — bark that sways and brickwork that
   * doesn't, out of the same draw call.
   */
  surface?: boolean
  /**
   * Thin instances out as they approach this distance from the camera, so a
   * fixed lattice of grass ends in a soft circle instead of the square its
   * buffer actually is. Done here rather than when the slot is placed because
   * a scrolling lattice only rewrites the slots that just entered the field —
   * every other slot's distance would go stale.
   *
   * *Thin out*, not shrink. Scaling every blade down together mows the field:
   * you get a ring of stubble around the player that follows them, which is
   * far more obvious than the hard edge it was hiding — and it is exactly
   * what the dense near field's boundary looked like. So each blade instead
   * carries its own stable threshold and disappears when the fade passes it,
   * over a narrow band so a single blade still shrinks rather than pops. The
   * field loses blades with distance and the survivors keep their height,
   * which is what a real field does as it goes out of resolution.
   */
  fadeRadius?: number
  /**
   * Undo three's backface normal flip, so a DoubleSide material lights both
   * faces off the same normal.
   *
   * This exists for the up-pointing normals grass and foliage cards carry on
   * purpose (see grass.ts's header): three flips the normal on back faces,
   * which is right for a closed solid and catastrophic for a blade whose
   * normal points at the sky — half the field lights from underground and
   * renders near-black. The old workaround was to emit every triangle twice,
   * wound both ways, and keep the material FrontSide. That works, and it
   * doubles the index buffer and the primitive count to draw exactly the same
   * pixels, since the rasteriser culls one winding or the other anyway.
   * One line of GLSL is the cheaper answer.
   */
  upNormals?: boolean
}

/**
 * Patch a standard material so its vertices sway. Safe to call on a material
 * that is also instanced, vertex-coloured and fogged — everything three
 * injects around `begin_vertex` is left alone.
 */
export const applySway = (mat: THREE.Material, opts: SwayOpts) => {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime
    shader.uniforms.uWind = windUniforms.uWind
    shader.uniforms.uGust = windUniforms.uGust
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         ${WIND_GLSL}
         ${opts.weight === 'attribute' ? 'attribute float aSway;' : ''}
         ${opts.instancedYaw ? 'attribute vec2 aBlade;' : ''}
         ${opts.surface ? surfaceVertHead() : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 instOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #else
            vec3 instOrigin = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif
          float swayW = ${opts.weight === 'attribute' ? 'aSway' : 'clamp(position.y, 0.0, 1.0)'};
          float phase = ${opts.instancedYaw
            ? 'aBlade.y'
            : 'fract(sin(dot(instOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.283'};
          ${opts.fadeRadius ? `
            // the taper starts early and runs long: a short band read as a
            // mowed line where the lattice ended
            float fadeD = length(instOrigin.xz - cameraPosition.xz);
            float fadeK = smoothstep(
              float(${opts.fadeRadius}) * 0.55, float(${opts.fadeRadius}), fadeD);
            // the blade's own threshold, off the phase it already carries
            float fadeT = fract(sin(phase * 91.7) * 4375.85);
            transformed *= 1.0 - smoothstep(fadeT - 0.16, fadeT + 0.04, fadeK);
          ` : ''}
          ${opts.instancedYaw
            ? `// the blade's own facing lives here, not in the instance matrix:
               // resolving it in the shader lets the bend stay in world space
               float ca = cos(aBlade.x), sa = sin(aBlade.x);
               transformed.xz = vec2(transformed.x * ca - transformed.z * sa,
                                     transformed.x * sa + transformed.z * ca);`
            : ''}
          if (swayW > 0.001) {
            float dropY;
            vec2 off = windBend(instOrigin, swayW, phase, float(${opts.amplitude}), dropY);
            transformed.xz += off;
            transformed.y -= dropY;
          }
        }
        ${opts.surface ? surfaceVertBody() : ''}`,
      )
    if (opts.upNormals) {
      // faceDirection is +1 on front faces and -1 on back ones, so applying
      // it a second time is exactly the inverse of three's flip. Written this
      // way rather than by reassigning vNormal because it makes no assumption
      // about what the chunk did before it — and nonPerturbedNormal, which
      // the chunk hands to clearcoat and friends, has to agree with it
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         #ifdef DOUBLE_SIDED
           normal *= faceDirection;
           nonPerturbedNormal = normal;
         #endif`,
      )
    }
    if (opts.rim || opts.surface) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           ${opts.rim ? 'uniform vec3 uWind;' : ''}
           ${opts.surface ? SURFACE_FRAG_HEAD : ''}`,
        )
        // <opaque_fragment> is where gl_FragColor is first written, before
        // tone mapping and before fog. Patching after <dithering_fragment>
        // instead — which is where this started — means a wall three hundred
        // units out still shows its brick courses painted over the fog, and a
        // blade of grass rim-lights through it
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
           ${opts.rim ? `{
             // grazing angles are where a thin blade is most translucent
             vec3 vd = normalize(vViewPosition);
             float fres = pow(1.0 - abs(dot(vd, normalize(vNormal))), 2.5);
             gl_FragColor.rgb += gl_FragColor.rgb * fres * float(${opts.rim});
           }` : ''}
           ${opts.surface ? SURFACE_FRAG_BODY : ''}`,
        )
    }
  }
  // materials that differ only by their injected shader still need distinct
  // program caches, or three hands them each other's compiled program
  mat.customProgramCacheKey = () =>
    `sway:${opts.weight}:${opts.amplitude}:${opts.instancedYaw}` +
    `:${opts.rim ?? 0}:${opts.surface ? 1 : 0}:${opts.fadeRadius ?? 0}` +
    `:${opts.upNormals ? 1 : 0}`
  mat.needsUpdate = true
}
