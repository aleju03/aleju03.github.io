import * as THREE from 'three'
import {
  FADE_FRAG_DISSOLVE, FADE_VERT_BODY, FADE_VERT_HEAD, fadeFragHead,
} from './fade'
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

  The wind's counterpart is the trample: grass has to move *away from you*
  as well as with the weather, or walking through a meadow feels like wading
  through a photograph. It works the way the water's splash rings do (see
  streamer.ts): no per-blade state anywhere, just a tiny event list the
  vertex shader replays analytically. One live "press" rides under the
  player's feet and bends everything inside arm's reach radially outward;
  walking lays a short ring-buffer trail of footprint stamps behind it, each
  decaying on an exponential with a damped cosine ringing through it — so a
  blade you step off doesn't ease politely upright, it springs back and
  overshoots. A pressed blade also loses most of its wind, because grass
  pinned under a boot does not flutter. Per vertex the whole thing is a
  dozen distance tests, which is cheaper than the sines the wind already
  spends.
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

/* ------------------------------------------------------------- trample -- */

/** footprint stamps the blades replay: world xz, the uTime they landed, and
    strength. Twelve cover a sprint's worth of trail before the ring laps
    itself — by which point a stamp's envelope is under 3% and the overwrite
    doesn't pop */
const TRAMPLES = 12
/** how far a step's influence reaches, world units */
const TRAMPLE_R = 1.35

export const trampleUniforms = {
  uTramples: {
    value: Array.from({ length: TRAMPLES }, () => new THREE.Vector4(0, 0, -1e6, 0)),
  },
  /** the live press under the player: xz, strength, radius */
  uPress: { value: new THREE.Vector4(0, 0, 0, 1.15) },
}

let trampleHead = 0
let trailX = Number.NaN
let trailZ = 0

/** stamp one decaying footprint; anything that disturbs grass may call it */
export const pushTrample = (x: number, z: number, strength = 1) => {
  trampleUniforms.uTramples.value[trampleHead]
    .set(x, z, windUniforms.uTime.value, strength)
  trampleHead = (trampleHead + 1) % TRAMPLES
}

/**
 * Feed the walker's feet in, once a frame. While grounded the live press
 * follows them exactly — grass under you stays bent for as long as you stand
 * on it — and every step's worth of travel drops a footprint stamp behind, at
 * a spacing that widens with speed so a car crossing a meadow doesn't lap the
 * ring while its trail is still visible. Leaving the ground converts the
 * press into one last stamp, which is what makes the grass under a jump
 * spring up while you hang over it.
 */
export const updateTrample = (x: number, z: number, speed: number, onGround: boolean) => {
  const press = trampleUniforms.uPress.value
  if (!onGround) {
    if (press.z > 0 && !Number.isNaN(trailX)) pushTrample(trailX, trailZ)
    press.z = 0
    trailX = Number.NaN
    return
  }
  press.x = x
  press.y = z
  press.z = 1
  if (Number.isNaN(trailX)) {
    trailX = x
    trailZ = z
    return
  }
  if (Math.hypot(x - trailX, z - trailZ) >= Math.max(0.6, speed * 0.12)) {
    pushTrample(x, z)
    trailX = x
    trailZ = z
  }
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

/** the trample resolver; injected after WIND_GLSL (it reads uTime). Returns
    the world-space push direction, length-capped at 1, and writes how hard
    this spot is being pressed (0..1) so the caller can damp the wind with it */
const TRAMPLE_GLSL = /* glsl */ `
  uniform vec4 uTramples[${TRAMPLES}];
  uniform vec4 uPress;

  vec2 trample(vec3 wPos, out float pressK) {
    vec2 push = vec2(0.0);
    float k = 0.0;
    // the live press under the player's feet: no envelope, it holds as long
    // as they stand there
    vec2 d = wPos.xz - uPress.xy;
    float dist = length(d);
    if (uPress.z > 0.001 && dist < uPress.w) {
      float f = (1.0 - smoothstep(0.1, uPress.w, dist)) * uPress.z;
      push += d / max(dist, 0.1) * f;
      k = f;
    }
    // the footprint trail: each stamp recovers on an exponential with a
    // damped cosine ringing through it, so a released blade springs back and
    // overshoots instead of easing up like a pneumatic door
    for (int i = 0; i < ${TRAMPLES}; i++) {
      float age = uTime - uTramples[i].z;
      if (age < 0.0 || age > 1.6) continue;
      d = wPos.xz - uTramples[i].xy;
      dist = length(d);
      if (dist > float(${TRAMPLE_R})) continue;
      float env = exp(-age * 2.6) * (0.68 + 0.32 * cos(age * 10.0));
      float f = (1.0 - smoothstep(0.1, float(${TRAMPLE_R}), dist)) * uTramples[i].w * env;
      push += d / max(dist, 0.1) * f;
      k = max(k, f);
    }
    float m = length(push);
    if (m > 1.0) push /= m;
    pressK = min(k, 1.0);
    return push;
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
   * Also bend away from the player's feet and their footprint trail (the
   * trample above). `amp` is the sideways push at the tip and `drop` how far
   * a fully pressed tip sinks — both in the geometry's *local* units, because
   * they apply before the instance matrix: a blade's xz is scaled by its
   * width and its y by its height, so the numbers differ per mesh and are
   * tuned per caller rather than shared. Grass and flowers opt in; trees do
   * not get stepped on.
   */
  trample?: { amp: number; drop: number }
  /**
   * Also dissolve geometry in by its baked `aBirth` stamp (world/fade.ts), so
   * a chunk the streamer finishes mid-walk arrives over a second instead of in
   * a frame. Only the chunk soup's materials opt in — their geometry always
   * carries the attribute; the grass field manages its own appearance.
   */
  fadeIn?: boolean
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
    if (opts.trample) {
      shader.uniforms.uTramples = trampleUniforms.uTramples
      shader.uniforms.uPress = trampleUniforms.uPress
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         ${WIND_GLSL}
         ${opts.trample ? TRAMPLE_GLSL : ''}
         ${opts.weight === 'attribute' ? 'attribute float aSway;' : ''}
         ${opts.instancedYaw ? 'attribute vec2 aBlade;' : ''}
         ${opts.surface ? surfaceVertHead() : ''}
         ${opts.fadeIn ? FADE_VERT_HEAD : ''}`,
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
            ${opts.trample ? `
              float pressK;
              vec2 tPush = trample(instOrigin, pressK);
              float w2t = swayW * swayW;
              float tK = pressK * w2t;
              // a pinned blade loses most of its wind — grass under a boot
              // does not flutter
              vec2 off = windBend(instOrigin, swayW, phase,
                float(${opts.amplitude}) * (1.0 - 0.75 * pressK), dropY);
              transformed.xz += off + tPush * w2t * float(${opts.trample.amp});
              transformed.y -= dropY + tK * tK * float(${opts.trample.drop});
            ` : `
              vec2 off = windBend(instOrigin, swayW, phase, float(${opts.amplitude}), dropY);
              transformed.xz += off;
              transformed.y -= dropY;
            `}
          }
        }
        ${opts.surface ? surfaceVertBody() : ''}
        ${opts.fadeIn ? FADE_VERT_BODY : ''}`,
      )
    if (opts.fadeIn) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${fadeFragHead()}`)
        // at the very top of main, so a dissolved fragment costs nothing else
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>\n${FADE_FRAG_DISSOLVE}`,
        )
    }
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
    `:${opts.upNormals ? 1 : 0}` +
    `:${opts.trample ? `${opts.trample.amp},${opts.trample.drop}` : 0}` +
    `:${opts.fadeIn ? 1 : 0}`
  mat.needsUpdate = true
}
