import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import { CHUNK, chunkX, chunkZ, OFF_Z, originX, originZ } from './grid'
import {
  buildChunk, tierFor, type Chunk, type ChunkFade, type ChunkMats, type Tier,
} from './chunk'
import { applyGroundLook, groundLookUniforms } from './groundLook'
import { applyFadeIn, FADE_FRAG_ALPHA, FADE_VERT_BODY, FADE_VERT_HEAD, fadeFragHead } from './fade'
import { registerInteriors, unregisterInteriors } from './interiors'
import type { ShopDoorSpec } from './shopDoors'
import { SEA_Y, terrainY } from './terrain'
import { applySway, tickWind, updateTrample, windUniforms } from './wind'
import { buildGrass, type GrassHandles } from './grass'
import { makeLeafTexture } from './treeMesh'
import { texelate } from '../render/texel'
import { nearestLamps } from '../render/atmosphere'
import { buildFarField } from './farfield'
import { FADE_S } from './fade'

/*
  The ring of chunks around the player, and the budget that keeps building it
  from costing a frame.

  Two radii, because the two things a chunk costs are not the same thing.
  Geometry is cheap to keep and expensive to make, so the loaded ring reaches
  RADIUS chunks out and chunks are only ever built or thrown away when the
  player crosses a border. Collision is the opposite — cheap to make, and
  every box in the set is scanned three or four times a frame — so only the
  nine chunks around the player hand their boxes to the live collision set,
  and the rest keep theirs on the shelf. Re-shelving on a border crossing is a
  truncate and a push of a few hundred references, which costs nothing.

  Building is queued and time-boxed. Crossing a border can want a whole new
  column of chunks at once, and a forest chunk is a few thousand vertices of
  merged geometry, so the queue is drained nearest-first under a millisecond
  budget per frame. The consequence is that the far ring can lag a moment
  behind a sprint, which fog covers, and that the *near* ring is built
  synchronously on the first call so the player never spawns over a hole.
  What the drain does finish in view of the player dissolves in over a second
  rather than popping — the birth-stamp mechanism is world/fade.ts's.

  The collision array handed out here is the same array the house and the desk
  already registered into: world boxes are appended after the authored ones,
  and on every restream the world's own are filtered out (by identity, via a
  WeakSet) and re-pushed. It used to truncate back to the count measured at
  construction instead, and that count was a lie: the furniture registers its
  boxes whenever its models finish streaming, which is *after* the world is
  up — so the first chunk border you crossed silently deleted every sofa and
  wardrobe in the house. Order is load-bearing — resolveXZ is a sequential
  pass where the last overlapping box wins, and the desk strip has to keep
  winning over the bedroom wall — and the filter is stable, so authored boxes
  keep their relative order.
*/

/** how far the loaded ring reaches, in chunks. 4 puts the edge 256 units out,
    comfortably past the daylight fog */
const RADIUS = 4
/** ...and how far it reaches from the air. Fog and ring have to move together
    (sky.ts's fogFar is written against the 256 figure above), so this is the
    other half of the altitude ramp in outsideWorld.ts: 6 chunks puts the edge
    at 384, which is what a widened fog needs in front of it. It costs forty
    more chunks, almost all of them the cheap 'bare' tier at that range */
const RADIUS_HIGH = 6
/** ...unless the far field (world/farfield.ts) has the view past the ring
    covered, in which case the ring from the air shrinks to the chunks that
    carry trees and the far field draws everything beyond: its terrain,
    canopy and town impostors cost a fraction of forty 'bare' chunks and
    reach ten times as far */
const RADIUS_FAR = 3
/** milliseconds a frame the far field may build in: plenty from the air,
    where it is what the player is looking at, and a trickle on the ground,
    only when the chunk queue is empty, so it is ready before anyone flies */
const FAR_MS_AIR = 2.5
const FAR_MS_GROUND = 0.6
/** chunks whose boxes are live in the collision set, as a Chebyshev radius */
const SOLID_RADIUS = 1
/** how much `prime` always builds, however little time it is given. Two rings
    is everything inside 128 units, which is what the player can actually see
    the ground of while standing up; the rest streams in behind the fog —
    unless the caller passes a millisecond budget to buy more of it */
const PRIME_RADIUS = 2
/** milliseconds of chunk building allowed per frame once the world is up */
const BUDGET_MS = 2.4
/**
 * ...and how much that budget stretches by when the player is travelling.
 *
 * The whole ring was tuned around a walker: at 3.4 units a second a chunk
 * border arrives every nineteen seconds and 2.4 ms a frame drains the queue
 * with time to spare. A car at 40 crosses one every 1.6 s and a helicopter at
 * 75 every 0.85, and against a forest column that wants ninety milliseconds of
 * building, 2.4 ms a frame is simply behind forever — the visible symptom
 * being the front edge of the world staying open inside the fog, which is the
 * one thing the fog exists to prevent. The budget therefore rides the player's
 * own speed. It is capped rather than proportional because the adaptive
 * resolution governor in CrtScene answers a 22 ms frame by permanently
 * dropping the pixel ratio, and trading crispness for streaming is a bad deal.
 */
const BUDGET_MAX = 7.5
/** speed at which the budget is fully stretched, units/s */
const BUDGET_SPEED = 26

/*
  The sea's swell, on the CPU.

  The wave is authored in `makeWaterStylized`'s vertex shader below and that
  stays the definition; this is the same expression evaluated where something
  physical needs it — a boat that floats on `SEA_Y` sits inside the crests and
  under the troughs, which is exactly the mesh-versus-field disagreement
  terrain.ts's header was written about.

  Two details make it agree with what is drawn rather than merely with the
  formula. The displacement is faded by the same shoreline factor the shader
  uses (`aDepth * 0.6`, clamped), so the swell dies in the shallows here too.
  And it is sampled on the water mesh's own 8-unit lattice and interpolated,
  because the mesh is a `PlaneGeometry(CHUNK, CHUNK, 8, 8)` — three samples per
  wavelength — so the drawn surface is a coarse polyline through the sine, not
  the sine. The one liberty taken is bilinear interpolation over the cell where
  the GPU does barycentric over two triangles; the two differ by at most a
  quarter of the cell's diagonal curvature, which against a 0.22-unit amplitude
  is under two centimetres of a hull's 0.8-unit draft.
*/
const WATER_CELL = 8

const waveRaw = (wx: number, wz: number, t: number) => {
  const depth = SEA_Y - terrainY(wx, wz)
  if (depth <= 0) return 0
  const shore = Math.min(1, depth * 0.6)
  return (
    (Math.sin(wx * 0.26 + t * 1.1) * 0.5 + Math.sin(wz * 0.19 - t * 0.83) * 0.5) * 0.22 * shore
  )
}

/** how far the drawn sea surface is displaced from SEA_Y at this point, now */
export const waveHeightAt = (x: number, z: number) => {
  const t = windUniforms.uTime.value
  const fi = x / WATER_CELL
  const fj = (z - OFF_Z) / WATER_CELL
  const i = Math.floor(fi)
  const j = Math.floor(fj)
  const u = fi - i
  const v = fj - j
  const x0 = i * WATER_CELL
  const z0 = OFF_Z + j * WATER_CELL
  const h00 = waveRaw(x0, z0, t)
  const h10 = waveRaw(x0 + WATER_CELL, z0, t)
  const h01 = waveRaw(x0, z0 + WATER_CELL, t)
  const h11 = waveRaw(x0 + WATER_CELL, z0 + WATER_CELL, t)
  return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v
}

export interface WorldHandles {
  root: THREE.Group
  /** stream around the player and advance the wind; call once per rendered
      frame, with the frame's delta so the sway is frame-rate independent.
      `alt` is the camera's height over the ground under it: the grass field,
      the splash detector and the ring's own radius all read it, because every
      one of them was tuned for an eye 3.55 units up */
  update: (x: number, z: number, dt: number, alt?: number) => void
  /** 0 day .. 1 night: lights the windows and streetlamps */
  setNight: (night: number) => void
  /** tint the water with the sky so it doesn't glow at midnight */
  setWaterTint: (c: THREE.Color, sun: number) => void
  /** build the ring around a point right now, ignoring the frame budget: the
      two inner rings always, plus as much of the rest as `ms` milliseconds
      buys. Only a boot with a cover over it can afford the second argument */
  prime: (x: number, z: number, ms?: number) => void
  /** drop a splash ring on the water at a world position */
  splash: (x: number, z: number) => void
  /** how many chunks are still queued (the HUD may want to know) */
  readonly pending: number
  /** the collision boxes of a loaded chunk, live set or not (the sandbox's
      props can roll out of the nine chunks the walker collides with) */
  solidsIn: (cx: number, cz: number) => readonly Solid[] | null
  /** how far past (x, z) the far field reaches without a gap, 0 until its
      rings exist: the fog and the camera's far plane open to this */
  farReach: (x: number, z: number) => number
  /** build the far field around a point now, up to `ms` milliseconds: the
      harness, which has no frames to spread it over */
  primeFar: (x: number, z: number, alt: number, ms: number) => void
  /** what the far field is drawing, for the harness */
  farStats: () => { tiles: number; verts: number; tris: number; pending: number }
  /** a chunk's solids changed shape or number since it was built (a
      building taken apart into pieces): re-shelve the collision set */
  resolid: () => void
  /** the nearest `max` light fixtures to (x, z) in the loaded chunks, as
      world xyz triples into `out`; returns how many. For the look's lamp
      pools. Walks a 5x5 of chunks, so ask when the walker has moved rather
      than every frame */
  nearLamps: (x: number, z: number, out: Float32Array, max: number) => number
}

interface Opts {
  /** what the chunk root is parented to (outsideWorld's group, so a level
      can hide the sky and the ground together) */
  scene: THREE.Object3D
  /** the shared obstacle list; world boxes live after `authoredCount` */
  obstacles: Solid[]
  /** the hinged shop doors of the chunks whose collision is live, whenever
      that set changes — outsideWorld hands these to world/shopDoors.ts */
  onNearDoors?: (specs: ShopDoorSpec[]) => void
  /** every chunk as it is built, so world/debris.ts can arm the props a
      vehicle may knock down — and re-flatten the ones it already has */
  onChunk?: (c: Chunk) => void
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

/** how strongly the cel highlights read; the sky dims this at night so the
    sea doesn't sparkle under starlight */
const waterCel = { value: 0.5 }

/** splash events the ripple rings replay: world xz + the uTime they landed.
    A ring buffer of eight — a ripple lives ~3 seconds, and nothing in this
    world makes splashes faster than that decays */
const RIPPLES = 8
const rippleU = {
  uRippleCenters: {
    value: Array.from({ length: RIPPLES }, () => new THREE.Vector2(1e6, 1e6)),
  },
  uRippleTimes: { value: new Float32Array(RIPPLES).fill(-1e6) },
}
let rippleHead = 0
const pushSplash = (x: number, z: number) => {
  rippleU.uRippleCenters.value[rippleHead].set(x, z)
  rippleU.uRippleTimes.value[rippleHead] = windUniforms.uTime.value
  rippleHead = (rippleHead + 1) % RIPPLES
}
/** the same, for anything that has no world handle to hand (the film harness) */
export const splashAt = pushSplash

/**
 * Stylized water, by injection rather than by a whole custom shader — so it
 * keeps the scene's fog, tone mapping and lighting instead of reimplementing
 * them. Four things happen:
 *
 * - the surface rolls on two crossed sine waves, which is enough motion to
 *   stop a lake reading as glass laid on the ground
 * - sunlight glints on the surface. The highlight began as the anime caustic
 *   web, Voronoi F1 - SmoothF1 thresholded into hand-drawn lines, adapted from
 *   cortiz2894/stylized-components' WaterFloor (MIT © Christian Ortiz), and
 *   at the pixel look's resolution that read as tiles on a pool floor. The
 *   light on the water is now short one-pixel glints on a drifting grid,
 *   each swelling and fading on its own clock. Still from that repo
 *   are the splash rings below: their *analytic* ripples — hard-edged rings
 *   replayed from a tiny event list, expanding and exponentially fading —
 *   not their GPU wave simulation, whose three render-target passes are a
 *   price the cold-iGPU budget doesn't pay for a sea seen from the shore.
 *   Wading in and swimming push events; each costs the fragment a few
 *   distance tests that early-out once the ripple has died.
 * - `aDepth` (baked per vertex by the chunk builder) drives opacity, so the
 *   water thins to nothing at the shoreline instead of ending on a hard line
 * - the depth is drawn in three shelves with ragged pixel contours, and the
 *   shore in lines: a lip of foam where water meets sand, a surf line that
 *   breathes with the swell, and crests catching the light, which is what
 *   makes a beach look like a beach in pixel art
 */
const makeWaterStylized = (mat: THREE.MeshStandardMaterial) => {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime
    shader.uniforms.uCel = waterCel
    shader.uniforms.uRippleCenters = rippleU.uRippleCenters
    shader.uniforms.uRippleTimes = rippleU.uRippleTimes
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         attribute float aDepth;
         varying float vDepth;
         varying float vWave;
         varying vec2 vWXZ;
         ${FADE_VERT_HEAD}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         ${FADE_VERT_BODY}
         vDepth = aDepth;
         vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vWXZ = wp.xz;
         float wave = sin(wp.x * 0.26 + uTime * 1.1) * 0.5
                    + sin(wp.z * 0.19 - uTime * 0.83) * 0.5;
         // the swell dies out in the shallows, the way a real one does
         float shore = clamp(aDepth * 0.6, 0.0, 1.0);
         transformed.y += wave * 0.22 * shore;
         vWave = wave;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform float uCel;
         uniform vec2 uRippleCenters[${RIPPLES}];
         uniform float uRippleTimes[${RIPPLES}];
         ${fadeFragHead(false)}
         varying float vDepth;
         varying float vWave;
         varying vec2 vWXZ;
         vec2 wHash2(vec2 p) {
           p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
           return fract(sin(p) * 43758.5453);
         }
         float wNoise(vec2 p) {
           vec2 i = floor(p);
           vec2 f = fract(p);
           f = f * f * (3.0 - 2.0 * f);
           float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
           float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
           float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
           float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
           return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
         }`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         {
           // glints: short one-pixel dashes of sunlight on a drifting,
           // jittered grid, each one swelling and fading on its own clock.
           // (the Voronoi web that used to be here read as the cracks in a
           // pool floor at this resolution)
           vec2 g = vWXZ * vec2(0.34, 0.95) + vec2(uTime * 0.12, uTime * 0.05);
           g += (vec2(wNoise(vWXZ * 0.045 + uTime * 0.03), wNoise(vWXZ * 0.05 - uTime * 0.02)) - 0.5) * 0.8;
           vec2 gi = floor(g);
           vec2 hh = wHash2(gi);
           vec2 d = fract(g) - 0.5 - (hh - 0.5) * 0.45;
           float life = max(0.0, sin(uTime * 1.3 + hh.x * 6.2831));
           float fy = max(fwidth(g.y), 1e-4);
           float cel = step(abs(d.y), max(0.06, fy * 0.5)) * step(abs(d.x), 0.34 * life) * step(0.5, hh.y);
           // once a dash is thinner than a pixel it is only noise
           cel *= 1.0 - smoothstep(0.12, 0.3, fy);
           // fade the web out in the last stretch of shallows so it never
           // draws over the foam band
           cel *= smoothstep(0.5, 2.2, vDepth);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.94, 0.98, 1.0), cel * uCel);
         }
         // splash rings: three concentric anime rings per event, expanding
         // and dying on an exponential. Dead events early-out before the
         // ring math, so still water pays eight subtractions and nothing else
         {
           float ripple = 0.0;
           for (int i = 0; i < ${RIPPLES}; i++) {
             float elapsed = uTime - uRippleTimes[i];
             if (elapsed < 0.0 || elapsed > 3.2) continue;
             float d = length(vWXZ - uRippleCenters[i]);
             for (int r = 0; r < 3; r++) {
               float re = elapsed - float(r) * 0.26;
               if (re < 0.0) continue;
               float ringR = 0.45 + re * 2.7;
               float ring = 1.0 - smoothstep(0.0, 0.36, abs(d - ringR));
               ripple += ring * exp(-re * 1.5);
             }
           }
           gl_FragColor.rgb = mix(
             gl_FragColor.rgb, vec3(0.9, 0.97, 0.97), clamp(ripple, 0.0, 1.0) * 0.6);
         }
         // deep water is darker and more opaque; the shallows go clear.
         // Drawn as three shelves with ragged one-pixel contours between
         // them rather than a smooth ramp, the way a pixel artist paints a
         // coast: the reef, the shelf, the deep. The lift leans cyan so the
         // shelf reads tropical against the deep blue, and it stays modest:
         // a long bright ramp once turned a whole ocean into a strip of milk
         float jit = (wHash2(floor(vWXZ * 4.0)).x - 0.5) * 0.7;
         float shelf = vDepth + jit;
         // Separated by value, not by hue: the grade caps chroma, and a cyan
         // shelf over a blue sea graded to one baby blue. Each shelf is a
         // clear step lighter than the one outside it, leaning a little
         // green as it shoals
         float shallow = shelf < 1.1 ? 1.0 : shelf < 3.0 ? 0.62 : shelf < 7.0 ? 0.32 : shelf < 14.0 ? 0.1 : 0.0;
         vec3 lift = mix(vec3(1.0), vec3(1.45, 2.05, 1.85), shallow);
         gl_FragColor.rgb = gl_FragColor.rgb * lift * (shelf > 14.0 ? 0.7 : 1.0) + 0.02 * shallow;
         // the shore in lines, not a gradient: a solid lip of foam where the
         // water meets the sand, a line a little further out that breathes
         // in and out with the swell, and the swell's crests catching light
         float dw = max(fwidth(vDepth), 1e-3);
         float lip = 1.0 - smoothstep(0.22, 0.22 + dw * 1.2, vDepth);
         float surfAt = 0.95 + 0.35 * sin(uTime * 1.25 + vWXZ.x * 0.05 + vWXZ.y * 0.04);
         float surf = 1.0 - smoothstep(0.0, dw * 1.3, abs(vDepth - surfAt));
         float crest = step(0.86, vWave) * (1.0 - smoothstep(1.4, 3.0, vDepth));
         float foam = max(max(lip, surf * 0.85), crest * 0.5);
         gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.92, 0.96, 0.97), clamp(foam, 0.0, 0.9));
         gl_FragColor.a *= smoothstep(0.0, 0.5, vDepth);
         // Deep water is opaque. Seen at a slant from the air, the seabed
         // under the ring's last chunks lies past the ring's edge, where no
         // chunk and (by the far field's mask) no far tile is drawn, so the
         // outer half-chunk of sea read as a pale seam round the ring
         gl_FragColor.a = mix(gl_FragColor.a, 1.0, smoothstep(2.5, 6.0, vDepth));
         // a freshly streamed sea eases in with its chunk (world/fade.ts)
         ${FADE_FRAG_ALPHA}`,
      )
  }
  mat.customProgramCacheKey = () => 'stylized-water-cel'
  mat.needsUpdate = true
}

/**
 * The six materials a chunk is drawn with.
 *
 * Exported, and that is the point of it being a function at all: it used to
 * be sixty lines inline in `buildWorld`, so anything that wanted to render
 * chunks outside the game (`scripts/probe/`, above all) had to hand-roll its
 * own set. A probe that hand-rolls these lies about the world in exactly the
 * ways that matter most, since what the hand-rolled version always leaves out
 * is the leaf texture's alpha test and the surface pass, i.e. the difference
 * between a tree and a green slab and between brickwork and a grey rectangle.
 * One shot taken that way sent a whole conversation chasing a tree problem
 * that did not exist. Anything that draws a chunk calls this.
 */
export const makeChunkMats = (
  trackTexture: (t: THREE.Texture) => void,
  trackDisposable: (d: { dispose: () => void }) => void,
): ChunkMats => {
  // the ground draws its own texels (world/groundLook.ts): per-texel
  // material choice, ragged borders, slope rock and a beach at every shore.
  // The grey multiplier is the old speckle map's average, which is what the
  // detail soup and the far field both match (see below)
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xe0e0e0, vertexColors: true, roughness: 1, metalness: 0,
  })
  // it carries the chunk's birth dissolve (world/fade.ts) inside the same
  // injection, since a material only gets one onBeforeCompile
  applyGroundLook(groundMat, windUniforms.uTime)
  // the grey is deliberate. The ground multiplies its vertex colour by a
  // detail map that averages a little under white, and props carry no map at
  // all — matched palettes therefore rendered props visibly brighter than the
  // ground they stand on, so a meadow's grass clumps read as litter scattered
  // over it. This is that map's average, applied as a flat multiplier.
  const detailMat = new THREE.MeshStandardMaterial({
    color: 0xe0e0e0, vertexColors: true, roughness: 0.92, metalness: 0,
  })
  // windows and bulbs: unlit, so a skyline reads at midnight without a single
  // real light in the scene, and faded out entirely by day
  const glassMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
  })
  applyFadeIn(glassMat, windUniforms.uTime, 'alpha')
  // foliage bends; kerbs, walls and roofs share the material and simply carry
  // a zero sway weight, so one draw call covers both. The same injection also
  // carries the procedural surface pass (world/surface.ts) — brick courses,
  // shingles, paving joints, bark — because a material only gets one
  // onBeforeCompile and this soup contains all of it
  applySway(detailMat, { amplitude: 0.34, weight: 'attribute', surface: true, fadeIn: true })

  // foliage cards: alpha-tested so they need no sorting, a strong rim so a
  // backlit crown glows at its edge the way thin leaves do
  const leafTex = texelate(makeLeafTexture())
  trackTexture(leafTex)
  trackDisposable(leafTex)
  const leafMat = new THREE.MeshStandardMaterial({
    map: leafTex, alphaTest: 0.38, vertexColors: true, roughness: 0.95, metalness: 0,
  })
  applySway(leafMat, { amplitude: 0.4, weight: 'attribute', rim: 0.45, fadeIn: true })
  // what a crown looks like to the sun's shadow map: the same alpha test,
  // so foliage casts leaf-shaped dapple rather than solid rectangles
  const leafDepth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.38,
  })

  // matte on purpose: a glossy sun highlight over the vertex-displaced swell
  // breaks into per-pixel sparkle, and the toon look wants none of it anyway
  const waterMat = new THREE.MeshStandardMaterial({
    color: '#2c4a52', transparent: true, opacity: 0.9,
    roughness: 0.9, metalness: 0,
  })
  makeWaterStylized(waterMat)
  ;[groundMat, detailMat, glassMat, waterMat, leafMat, leafDepth].forEach(trackDisposable)
  return {
    ground: groundMat, detail: detailMat, glass: glassMat, water: waterMat,
    leaf: leafMat, leafDepth,
  }
}

const WATER_DAY = new THREE.Color('#0f3466')
const WATER_NIGHT = new THREE.Color('#111d26')

/** the sea's colour for a moment of the day: the streamer's day cycle, and
    the harness's still frames, which build the materials without a world */
export const tintWater = (mat: THREE.Material, sky: THREE.Color, sun: number) => {
  const m = mat as THREE.MeshStandardMaterial
  m.color.lerpColors(WATER_NIGHT, WATER_DAY, sun)
  // a touch of the sky's own colour, which is most of what makes water
  // read as water rather than as blue-painted ground
  m.color.lerp(sky, 0.15)
  // the glints are sunlight; by night they dim to a ghost of themselves
  waterCel.value = 0.07 + sun * 0.75
}

export function buildWorld(opts: Opts): WorldHandles {
  const { scene, obstacles, onNearDoors, onChunk, trackTexture, trackDisposable } = opts
  const root = new THREE.Group()
  scene.add(root)

  /** every box this streamer has ever pushed; anything not in here is
      authored content and must never be touched */
  const worldOwned = new WeakSet<Solid>()

  const mats = makeChunkMats(trackTexture, trackDisposable)
  // the two the day cycle reaches into, narrowed back to what they actually
  // are: ChunkMats types them as plain Materials because a chunk only needs
  // to draw with them, and only this file dims the glass and tints the sea
  const glassMat = mats.glass as THREE.MeshBasicMaterial
  const waterMat = mats.water as THREE.MeshStandardMaterial

  const chunks = new Map<string, Chunk>()
  /** when each chunk's ground is solid (its birth fade over), on the wind
      clock; the far field is discarded under a chunk only from then */
  const solidAt = new Map<string, number>()
  const far = buildFarField({ parent: root, water: waterMat.color, trackDisposable })
  /** bumped whenever the set of solid chunks changes, so the far field's
      mask is rebuilt only then; `pendingSolid` is the next fade to finish */
  let solidEpoch = 0
  let pendingSolid = Number.POSITIVE_INFINITY
  const tickSolid = () => {
    const now = windUniforms.uTime.value
    if (now < pendingSolid) return
    solidEpoch++
    pendingSolid = Number.POSITIVE_INFINITY
    for (const t of solidAt.values()) if (t > now && t < pendingSolid) pendingSolid = t
  }
  const chunkSolid = (cx: number, cz: number) => {
    const t = solidAt.get(key(cx, cz))
    return t !== undefined && windUniforms.uTime.value >= t
  }
  const queue: Array<{ cx: number; cz: number; tier: Tier; d: number; retier: boolean }> = []
  let curX = Number.POSITIVE_INFINITY
  let curZ = Number.POSITIVE_INFINITY
  /** the live ring radius; the altitude ramp swaps it (see RADIUS_HIGH) */
  let radius = RADIUS
  /** a running average of what one chunk costs to build, so the drain can stop
      *before* it blows the frame rather than after. Testing the clock only on
      the way in lets a single 27 ms jungle chunk through whatever the budget
      says, and that one chunk is the hitch.

      Kept per tier, because one average over all three is an average of things
      that are not alike: a `bare` ocean chunk is ground and nothing else, a
      `full` one in the middle of town carries every building, tree and fence
      in its block. A single EMA blends them into a number that is wrong for
      both: pessimistic enough to stop after one cheap chunk, optimistic
      enough to start a second expensive one. The seeds are the measured shape
      (bare cheap, full several times that); two crossings correct them. */
  const chunkMs: Record<Tier, number> = { bare: 1.5, flora: 4, full: 6 }

  const key = (cx: number, cz: number) => `${cx},${cz}`

  /*
    Freeing a chunk's buffers is the one cost in here with no deadline.

    By the time `drop` returns, the chunk is out of the scene graph, out of the
    chunk map and out of the interior registry: nothing draws it and nothing
    can find it again. All that is left is handing its geometries back to the
    driver, and `BufferGeometry.dispose()` reaches `gl.deleteBuffer` on the
    spot. That is fine for the one or two chunks a border crossing retires,
    and not fine for the altitude ramp, where RADIUS_HIGH collapsing back to
    RADIUS drops eighty-eight chunks and a few hundred buffers inside a single
    frame, on the frame a helicopter is descending.

    So queue the geometries and hand a few back per frame. Nothing observable
    depends on when it happens.
  */
  const freeing: THREE.BufferGeometry[] = []
  const FREE_PER_FRAME = 24
  const freeSome = () => {
    for (let i = 0; i < FREE_PER_FRAME; i++) {
      const g = freeing.pop()
      if (!g) break
      g.dispose()
    }
  }

  const drop = (c: Chunk) => {
    root.remove(c.group)
    for (const g of c.geos) freeing.push(g)
    chunks.delete(key(c.cx, c.cz))
    solidAt.delete(key(c.cx, c.cz))
    solidEpoch++
    unregisterInteriors(key(c.cx, c.cz))
  }

  const make = (cx: number, cz: number, tier: Tier, fade?: ChunkFade) => {
    const c = buildChunk(cx, cz, tier, mats, fade)
    root.add(c.group)
    chunks.set(key(cx, cz), c)
    const solid = fade && fade.from === undefined ? fade.at + FADE_S : -Infinity
    solidAt.set(key(cx, cz), solid)
    solidEpoch++
    if (solid < pendingSolid && solid > windUniforms.uTime.value) pendingSolid = solid
    registerInteriors(key(cx, cz), c.interiors)
    // before anything can see it: a chunk rebuilt over ground the player has
    // already cleared must arrive already cleared
    onChunk?.(c)
    return c
  }

  /** re-shelve the collision set: authored boxes, then the near ring's —
      and report the same ring's hinged doors, whose collision is live too */
  const refreshSolids = (pcx: number, pcz: number) => {
    let w = 0
    for (let i = 0; i < obstacles.length; i++) {
      if (!worldOwned.has(obstacles[i])) obstacles[w++] = obstacles[i]
    }
    obstacles.length = w
    const doors: ShopDoorSpec[] = []
    for (let dz = -SOLID_RADIUS; dz <= SOLID_RADIUS; dz++)
      for (let dx = -SOLID_RADIUS; dx <= SOLID_RADIUS; dx++) {
        const c = chunks.get(key(pcx + dx, pcz + dz))
        if (c) {
          for (const b of c.boxes) {
            worldOwned.add(b)
            obstacles.push(b)
          }
          for (const d of c.doors) doors.push(d)
        }
      }
    onNearDoors?.(doors)
  }

  /**
   * Decide what the ring should hold; build what is genuinely missing now and
   * queue the rest.
   *
   * The ordering here was rewritten for vehicles and the reason is worth
   * keeping. It used to drop every chunk whose *tier* had changed alongside
   * every chunk that had left the ring, and then rebuild anything within the
   * solid radius synchronously. On a walker that is invisible. Measured
   * against a one-chunk step it is not: a single axis crossing dropped and
   * rebuilt twenty-nine chunks rather than nine, of which three were rebuilt
   * inside the crossing frame — and *none of those three was actually
   * missing*. Every one of them already had geometry on screen and was being
   * torn down and remade a tier up or down. That was twelve to seventy
   * milliseconds of stall, once per border, spent on chunks the player could
   * already see.
   *
   * So a chunk that merely needs re-tiering is no longer dropped. It keeps its
   * geometry and its collision boxes and joins the queue, and the drain swaps
   * the replacement in when it is ready. Only a genuine hole in the floor —
   * which, on a one-chunk step, can only happen after a jump of three chunks
   * or more — is still built on the spot.
   */
  const restream = (pcx: number, pcz: number, syncRadius: number) => {
    const want = new Map<
      string,
      { cx: number; cz: number; tier: Tier; d: number; retier: boolean }
    >()
    for (let dz = -radius; dz <= radius; dz++)
      for (let dx = -radius; dx <= radius; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dz))
        const cx = pcx + dx
        const cz = pcz + dz
        want.set(key(cx, cz), { cx, cz, tier: tierFor(d), d, retier: false })
      }
    for (const c of [...chunks.values()]) {
      const w = want.get(key(c.cx, c.cz))
      if (!w) {
        drop(c) // gone from the ring
        continue
      }
      if (w.tier !== c.tier) w.retier = true
    }
    queue.length = 0
    for (const w of want.values()) {
      const have = chunks.get(key(w.cx, w.cz))
      if (have && !w.retier) continue
      // a hole in the floor with nothing solid in it is never acceptable, and
      // neither is a priming pass that leaves one; everything else waits
      if (w.d <= syncRadius || (!have && w.d <= SOLID_RADIUS)) {
        if (have) drop(have)
        make(w.cx, w.cz, w.tier)
        continue
      }
      queue.push(w)
    }
    // brand-new chunks first, then the re-tiers, and nearest-first inside
    // each: an open edge at the front of the world is what the player is
    // driving into, while a chunk waiting for its trees already draws
    queue.sort((a, b) => (a.retier ? 1 : 0) - (b.retier ? 1 : 0) || a.d - b.d)
    refreshSolids(pcx, pcz)
  }

  const grass: GrassHandles = buildGrass({ parent: root, trackDisposable })

  // wading and swimming leave rings behind: one on the way in, then one per
  // stroke-ish interval while moving. Detected here rather than in the walk
  // controller because this is the module that owns the water's uniforms —
  // the sim stays ignorant of how (or whether) it is being drawn.
  let prevX = Number.NaN
  let prevZ = 0
  let wasWet = false
  let lastSplash = -1e6

  const update = (x: number, z: number, dt: number, alt = 0) => {
    tickWind(dt)
    const moved = Number.isNaN(prevX) ? 0 : Math.hypot(x - prevX, z - prevZ)
    const speed = dt > 0 ? moved / dt : 0
    prevX = x
    prevZ = z
    /*
      Above about twenty-five units there is nothing under you that a blade of
      grass improves. The field is a 60-unit lattice pinned under the camera
      with frustum culling off, so from the air it is a hard-edged disc of
      full-height grass sliding along beneath the aircraft — worse-looking than
      no grass at all — and it costs a hundred milliseconds a second of lattice
      refills at flying speed, none of which is inside the build budget. So it
      is hidden and, more importantly, stops scrolling.
    */
    const low = alt < 25
    grass.setVisible(low)
    if (low) grass.update(x, z)
    // the same on-the-ground gate the splash uses: eye height is under three
    // units, so a jump lifts the press off the grass exactly when the feet do
    updateTrample(x, z, speed, alt < 3)
    // ...and the splash detector needs the same altitude gate. It asks only
    // whether the ground *under* the camera is below the waterline, which is
    // true of a helicopter three hundred units over the sea: without this it
    // stamps a ripple ring on the water twice a second from cruising altitude
    if (alt < 3) {
      const wet = terrainY(x, z) < SEA_Y - 0.1
      const t = windUniforms.uTime.value
      if (wet && (!wasWet || (speed > 1.1 && t - lastSplash > 0.44))) {
        pushSplash(x, z)
        lastSplash = t
      }
      wasWet = wet
    } else {
      wasWet = false
    }
    // the ring widens with height, in step with the fog (see RADIUS_HIGH).
    // The two thresholds are apart on purpose: a helicopter hovering exactly
    // on one number would otherwise rebuild the entire world every second
    // From the air the far field takes over past the flora ring as soon as
    // it has the whole view covered; until then the old wide ring stands in
    // the fields fade into the chunk ground as the grass field fades out
    groundLookUniforms.uFieldK.value = Math.min(1, Math.max(0, (alt - 15) / 30))
    tickSolid()
    far.update(x, z, alt, chunkSolid, solidEpoch)
    const high = far.complete ? RADIUS_FAR : RADIUS_HIGH
    const wantRadius = radius === RADIUS ? (alt > 46 ? high : RADIUS) : alt < 32 ? RADIUS : high
    const pcx = chunkX(x)
    const pcz = chunkZ(z)
    if (wantRadius !== radius) {
      radius = wantRadius
      curX = pcx
      curZ = pcz
      restream(pcx, pcz, 0)
    } else if (pcx !== curX || pcz !== curZ) {
      curX = pcx
      curZ = pcz
      restream(pcx, pcz, 0)
    }
    freeSome()
    let drained = 0
    if (queue.length) {
      // the budget rides the player's speed, and the drain stops when the
      // *next* chunk would not fit rather than when the last one already didn't
      const budget = BUDGET_MS + (BUDGET_MAX - BUDGET_MS) * Math.min(1, speed / BUDGET_SPEED)
      const d0 = performance.now()
      drain(budget)
      drained = performance.now() - d0
    }
    // again, now the ring has had its say: a ring that just shrank dropped
    // chunks this frame, and the far field must be under them this frame
    tickSolid()
    far.update(x, z, alt, chunkSolid, solidEpoch)
    // off the ground the far field is what is being looked at, so it builds
    // whether or not it is showing yet, but inside what the chunk drain
    // left of the stretched budget, never on top of it
    far.work(alt > 12
      ? Math.max(FAR_MS_GROUND, Math.min(FAR_MS_AIR, BUDGET_MAX - drained))
      : queue.length ? 0 : FAR_MS_GROUND)
  }

  const TIER_RANK: Record<Tier, number> = { bare: 0, flora: 1, full: 2 }

  /** take chunks off the queue until `budget` milliseconds are spent.
      `announce` stamps what gets built with a fresh birth so it dissolves in
      (world/fade.ts); a priming pass under the boot cover passes false, so the
      lens never opens onto a world still materialising */
  const drain = (budget: number, announce = true) => {
    const t0 = performance.now()
    let built = 0
    for (;;) {
      const w = queue[0]
      if (!w) break
      /*
        One chunk a frame is a floor, not an accident, and it is worth saying
        so because the code used to express it by accident: the old guard was
        `spent > 0 && ...`, which skipped the check on the first pass because
        the clock had not moved yet. That worked, but it leaned on
        `performance.now()` being coarse: a chunk built inside the timer's
        resolution left `spent` at zero and the loop ran on, so the same line
        could either apply the budget or ignore it depending on how the page
        was isolated.

        Say it directly instead. A chunk cannot be built in slices, and the
        average one costs more than BUDGET_MS on its own, so applying the
        budget to the first candidate too would leave the queue permanently
        full and the front edge of the world permanently open inside the fog,
        the one thing the fog exists to hide. What the budget governs is
        everything after the first.

        The real cap on a single chunk needs the build split into resumable
        passes (ground, roads, buildings, flora, merge) so it can be stopped
        partway. That is the same restructuring the worker move wants, and it
        is not free to bolt on here.
      */
      if (built > 0 && performance.now() - t0 + chunkMs[w.tier] > budget) break
      queue.shift()
      const have = chunks.get(key(w.cx, w.cz))
      let fade: ChunkFade | undefined
      if (announce) fade = { at: windUniforms.uTime.value }
      if (have) {
        if (have.tier === w.tier) continue
        // an upgrade dissolves in only what the old tier lacked; a downgrade
        // only removes, and fading its survivors would blink geometry the
        // player is already looking at
        if (fade) {
          fade = TIER_RANK[w.tier] > TIER_RANK[have.tier]
            ? { ...fade, from: have.tier } : undefined
        }
        drop(have)
      }
      const c0 = performance.now()
      make(w.cx, w.cz, w.tier, fade)
      chunkMs[w.tier] = chunkMs[w.tier] * 0.8 + (performance.now() - c0) * 0.2
      built += 1
      // a chunk arriving inside the collision radius changed the boxes under
      // the player's feet, and refreshSolids only runs on a border crossing
      if (Math.max(Math.abs(w.cx - curX), Math.abs(w.cz - curZ)) <= SOLID_RADIUS) {
        refreshSolids(curX, curZ)
      }
    }
  }

  const prime = (x: number, z: number, ms = 0) => {
    curX = chunkX(x)
    curZ = chunkZ(z)
    restream(curX, curZ, PRIME_RADIUS)
    // ...and, when the caller is a boot with a cover still over it, keep
    // going into the outer rings. Anything left here streams in behind the
    // fog as usual; what this buys is that it isn't *also* being built on
    // the frames where the player is first looking at it
    if (ms > 0) drain(ms, false)
  }

  const LAMP_SCRATCH = 512
  const lampScratch = new Float32Array(LAMP_SCRATCH * 3)
  const lampD2 = new Float32Array(64)
  const nearLamps = (x: number, z: number, out: Float32Array, max: number) => {
    const pcx = chunkX(x)
    const pcz = chunkZ(z)
    let m = 0
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const c = chunks.get(key(pcx + dx, pcz + dz))
        if (!c) continue
        for (const l of c.lamps) {
          if (m >= LAMP_SCRATCH) break
          lampScratch[m * 3] = l.x
          lampScratch[m * 3 + 1] = l.y
          lampScratch[m * 3 + 2] = l.z
          m++
        }
      }
    return nearestLamps(x, z, lampScratch, m, out, Math.min(max, lampD2.length), lampD2)
  }

  return {
    root,
    update,
    prime,
    splash: pushSplash,
    get pending() {
      return queue.length
    },
    solidsIn: (cx, cz) => chunks.get(key(cx, cz))?.boxes ?? null,
    farReach: (x, z) => (far.visible ? far.reach(x, z) : 0),
    primeFar: (x, z, alt, ms) => {
      far.update(x, z, alt, chunkSolid, solidEpoch)
      const t0 = performance.now()
      while (far.pending && performance.now() - t0 < ms) {
        far.work(ms)
        far.update(x, z, alt, chunkSolid, solidEpoch)
      }
    },
    farStats: () => ({ ...far.stats(), pending: far.pending }),
    resolid: () => {
      if (Number.isFinite(curX)) refreshSolids(curX, curZ)
    },
    nearLamps,
    setNight: (night) => {
      glassMat.opacity = night
      far.setNight(night)
    },
    setWaterTint: (sky, sun) => tintWater(waterMat, sky, sun),
  }
}

/** the waterline, re-exported so the level and the walk controller can agree
    on where swimming starts without importing the field stack */
export { SEA_Y }

/** debug helper: which chunk a world point belongs to */
export const chunkAt = (x: number, z: number) => ({
  cx: chunkX(x), cz: chunkZ(z), ox: originX(chunkX(x)), oz: originZ(chunkZ(z)), size: CHUNK,
})
