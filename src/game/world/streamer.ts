import * as THREE from 'three'
import { canvasTexture } from '../core/textures'
import { seeded } from '../core/rand'
import type { Solid } from '../physics/collision'
import { CHUNK, chunkX, chunkZ, OFF_Z, originX, originZ } from './grid'
import {
  buildChunk, tierFor, type Chunk, type ChunkFade, type ChunkMats, type Tier,
} from './chunk'
import { applyFadeIn, FADE_FRAG_ALPHA, FADE_VERT_BODY, FADE_VERT_HEAD, fadeFragHead } from './fade'
import { registerInteriors, unregisterInteriors } from './interiors'
import type { ShopDoorSpec } from './shopDoors'
import { SEA_Y, terrainY } from './terrain'
import { applySway, tickWind, updateTrample, windUniforms } from './wind'
import { buildGrass, type GrassHandles } from './grass'
import { makeLeafTexture } from './treeMesh'

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

/** a grey speckle that the vertex colours tint. Everything outdoors shares
    it, so ground reads as ground whether it is sand, snow or asphalt */
const makeDetailTexture = () =>
  canvasTexture([128, 128], (ctx, w, h) => {
    const rand = seeded(0x6d17)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 5200; i++) {
      const v = Math.floor(190 + rand() * 65)
      ctx.fillStyle = `rgba(${v},${v},${v},${0.35 + rand() * 0.4})`
      ctx.fillRect(rand() * w, rand() * h, 1, 1 + (rand() < 0.3 ? 1 : 0))
    }
    for (let i = 0; i < 40; i++) {
      const g = ctx.createRadialGradient(
        rand() * w, rand() * h, 1, rand() * w, rand() * h, 8 + rand() * 22)
      g.addColorStop(0, 'rgba(150,150,150,0.14)')
      g.addColorStop(1, 'rgba(150,150,150,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
  }, [1, 1])

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

/**
 * Stylized water, by injection rather than by a whole custom shader — so it
 * keeps the scene's fog, tone mapping and lighting instead of reimplementing
 * them. Four things happen:
 *
 * - the surface rolls on two crossed sine waves, which is enough motion to
 *   stop a lake reading as glass laid on the ground
 * - a cel-shaded highlight web rides the surface: Voronoi F1 − SmoothF1,
 *   thresholded hard, over a slowly flowing and noise-distorted UV. That
 *   subtraction is zero in cell interiors and positive along the boundaries,
 *   which is exactly the bright caustic web anime water draws by hand. The
 *   technique (a Blender node-graph trick rebuilt in GLSL) is adapted from
 *   cortiz2894/stylized-components' WaterFloor (MIT © Christian Ortiz), as
 *   are the splash rings below: their *analytic* ripples — hard-edged rings
 *   replayed from a tiny event list, expanding and exponentially fading —
 *   not their GPU wave simulation, whose three render-target passes are a
 *   price the cold-iGPU budget doesn't pay for a sea seen from the shore.
 *   Wading in and swimming push events; each costs the fragment a few
 *   distance tests that early-out once the ripple has died.
 * - `aDepth` (baked per vertex by the chunk builder) drives opacity, so the
 *   water thins to nothing at the shoreline instead of ending on a hard line
 * - a foam band rides the last unit of that depth, brightened where the waves
 *   are cresting, which is what makes a beach look like a beach
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
         float wSmin(float a, float b, float k) {
           float h = max(k - abs(a - b), 0.0) / k;
           return min(a, b) - h * h * h * k / 6.0;
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
         }
         // F1 and SmoothF1 in one pass over the 3x3 neighbourhood; the same
         // cell offsets feed both, or their difference stops meaning "edge".
         // The wide smin radius is what makes the boundary ridge broad enough
         // to threshold into a thick hand-drawn line rather than a hairline
         vec2 wVoro(vec2 p) {
           vec2 i = floor(p), f = fract(p);
           float f1 = 8.0, sf = 8.0;
           for (int y = -1; y <= 1; y++)
             for (int x = -1; x <= 1; x++) {
               vec2 n = vec2(float(x), float(y));
               float d = length(n + wHash2(i + n) - f);
               f1 = min(f1, d);
               sf = wSmin(sf, d, 0.5);
             }
           return vec2(f1, sf);
         }`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         // the cel highlight web, drifting with the wind and warped by a slow
         // noise so the cells never read as a stationary grid. Thresholded
         // through fwidth so the line keeps a constant screen-space softness:
         // a fixed-width smoothstep aliased into structured moiré at grazing
         // angles, which is most of what a standing player sees of the sea
         {
           vec2 flow = vWXZ * 0.085 + vec2(uTime * 0.035, uTime * 0.022);
           flow += (wNoise(vWXZ * 0.045 + uTime * 0.03) - 0.5) * 0.9;
           vec2 vv = wVoro(flow);
           float e = vv.x - vv.y;
           float w = fwidth(e);
           // the ridge tops out near k/6 = 0.083 between two sites; cutting
           // this close to the top keeps the lines bold but not dominant,
           // and lets the smin junctions swell into hand-drawn blobs
           float cel = smoothstep(0.066 - w, 0.078 + w, e);
           // once a pixel spans a good part of the ridge the web is only
           // noise; hand the far field to the fog as flat colour instead
           cel *= 1.0 - smoothstep(0.025, 0.075, w);
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
         // The ramp is long and the lift modest on purpose — at 1.9 over
         // seven units the whole visible sea from a beach was inside the
         // bright end of it, and an ocean came out as a pale strip of milk
         float shallow = 1.0 - clamp(vDepth / 16.0, 0.0, 1.0);
         // the lift leans cyan so the shelf reads tropical against the deep blue
         gl_FragColor.rgb = mix(
           gl_FragColor.rgb, gl_FragColor.rgb * vec3(1.16, 1.42, 1.38) + 0.02, shallow * 0.75);
         float foam = smoothstep(1.2, 0.12, vDepth) * (0.55 + 0.45 * vWave);
         gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.92, 0.96, 0.97), clamp(foam, 0.0, 0.85));
         gl_FragColor.a *= smoothstep(0.0, 0.5, vDepth);
         // a freshly streamed sea eases in with its chunk (world/fade.ts)
         ${FADE_FRAG_ALPHA}`,
      )
  }
  mat.customProgramCacheKey = () => 'stylized-water-cel'
  mat.needsUpdate = true
}

export function buildWorld(opts: Opts): WorldHandles {
  const { scene, obstacles, onNearDoors, onChunk, trackTexture, trackDisposable } = opts
  const root = new THREE.Group()
  scene.add(root)

  /** every box this streamer has ever pushed; anything not in here is
      authored content and must never be touched */
  const worldOwned = new WeakSet<Solid>()

  const detailTex = makeDetailTexture()
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping
  trackTexture(detailTex)
  trackDisposable(detailTex)

  const groundMat = new THREE.MeshStandardMaterial({
    map: detailTex, vertexColors: true, roughness: 1, metalness: 0,
  })
  // every chunk material fades its geometry in by the baked aBirth stamp
  // (world/fade.ts): dissolve-by-dither on the opaques, alpha on the rest.
  // The ground and glass get the standalone patcher; the detail and leaf
  // soups carry the same GLSL through applySway (one onBeforeCompile per
  // material), and the water carries it inside makeWaterStylized above
  applyFadeIn(groundMat, windUniforms.uTime, 'dissolve')
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
  const leafTex = makeLeafTexture()
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
  const mats: ChunkMats = {
    ground: groundMat, detail: detailMat, glass: glassMat, water: waterMat,
    leaf: leafMat, leafDepth,
  }

  const chunks = new Map<string, Chunk>()
  const queue: Array<{ cx: number; cz: number; tier: Tier; d: number; retier: boolean }> = []
  let curX = Number.POSITIVE_INFINITY
  let curZ = Number.POSITIVE_INFINITY
  /** the live ring radius; the altitude ramp swaps it (see RADIUS_HIGH) */
  let radius = RADIUS
  /** a running average of what one chunk costs to build, so the drain can
      stop *before* it blows the frame rather than after. Testing the clock
      only on the way in lets a single 27 ms jungle chunk through whatever the
      budget says, and that one chunk is the hitch */
  let chunkMs = 3

  const key = (cx: number, cz: number) => `${cx},${cz}`

  const drop = (c: Chunk) => {
    root.remove(c.group)
    for (const g of c.geos) g.dispose()
    chunks.delete(key(c.cx, c.cz))
    unregisterInteriors(key(c.cx, c.cz))
  }

  const make = (cx: number, cz: number, tier: Tier, fade?: ChunkFade) => {
    const c = buildChunk(cx, cz, tier, mats, fade)
    root.add(c.group)
    chunks.set(key(cx, cz), c)
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
    const wantRadius = radius === RADIUS ? (alt > 46 ? RADIUS_HIGH : RADIUS) : alt < 32 ? RADIUS : RADIUS_HIGH
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
    if (!queue.length) return
    // the budget rides the player's speed, and the drain stops when the *next*
    // chunk would not fit rather than when the last one already didn't
    const budget = BUDGET_MS + (BUDGET_MAX - BUDGET_MS) * Math.min(1, speed / BUDGET_SPEED)
    drain(budget)
  }

  const TIER_RANK: Record<Tier, number> = { bare: 0, flora: 1, full: 2 }

  /** take chunks off the queue until `budget` milliseconds are spent.
      `announce` stamps what gets built with a fresh birth so it dissolves in
      (world/fade.ts); a priming pass under the boot cover passes false, so the
      lens never opens onto a world still materialising */
  const drain = (budget: number, announce = true) => {
    const t0 = performance.now()
    for (;;) {
      if (!queue.length) break
      const spent = performance.now() - t0
      if (spent > 0 && spent + chunkMs > budget) break
      const w = queue.shift()
      if (!w) break
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
      chunkMs = chunkMs * 0.8 + (performance.now() - c0) * 0.2
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

  const WATER_DAY = new THREE.Color('#2a6fc0')
  const WATER_NIGHT = new THREE.Color('#111d26')

  return {
    root,
    update,
    prime,
    splash: pushSplash,
    get pending() {
      return queue.length
    },
    setNight: (night) => {
      glassMat.opacity = night
    },
    setWaterTint: (sky, sun) => {
      waterMat.color.lerpColors(WATER_NIGHT, WATER_DAY, sun)
      // a touch of the sky's own colour, which is most of what makes water
      // read as water rather than as blue-painted ground
      waterMat.color.lerp(sky, 0.15)
      // the caustic web is sunlight; by night it dims to a ghost of itself
      waterCel.value = 0.07 + sun * 0.75
    },
  }
}

/** the waterline, re-exported so the level and the walk controller can agree
    on where swimming starts without importing the field stack */
export { SEA_Y }

/** debug helper: which chunk a world point belongs to */
export const chunkAt = (x: number, z: number) => ({
  cx: chunkX(x), cz: chunkZ(z), ox: originX(chunkX(x)), oz: originZ(chunkZ(z)), size: CHUNK,
})
