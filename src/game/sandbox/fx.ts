import * as THREE from 'three'
import { cellCenter, propMaterial } from './art'
import { GLOW_ALPHA, type FakeLights } from '../render/pixelLook'

/*
  The sandbox's particles: fireballs, sparks, smoke, splinters, glass, melon
  and the scorch marks they leave. Everything that happens *to* a prop and is
  too small or too brief to be a rigid body is drawn here.

  It is built for the pixel look rather than against it. A blast is light
  first: a near-white glow added over the scene, three or four barrels
  across and gone in a third of a second, its middle marked as a light so
  the look neither grades nor inks it (sprites, below), while the look's
  fake flash light lights the street, the fronts and the props round it.
  Flame spears (stretched diamonds) reach out well past it for a fifth of a
  second. Behind the light the fireball is flame sprites of every size,
  each with a torn, flickering edge that licks upward, drawn as a light
  (so the look inks no rim between them and nothing behind shows through):
  a crowd of them is one fire with a ragged silhouette, white-yellow in the
  middle and orange at the tips, with licks of dark soot at its crown.
  Smoke is a column of soft, ragged sprites that climbs straight up, swells
  and darkens, translucent through its blend and lit by the scene's
  ambient. Sparks are thin boxes stretched along their velocity; splinters,
  glass and melon are small lit boxes. Nothing writes alpha except the
  glow's core and the flames, which write the look's light mark, which is
  what keeps the look's alpha-is-a-hole rule happy.

  Cost. Eight instanced meshes (bits on the props' own atlas material;
  jets and sparks on one banded unlit material; the glow, its core, the
  flames, the smoke and S5's masonry dust on one sprite program in three
  blends)
  and a small pool of decal meshes (two materials, one program between
  them). That is three new programs for every effect in the sandbox, all
  created with the sandbox and compiled under the boot cover with it,
  because they hang in the scene from the start with nothing to draw. No
  particle ever allocates: each pool is a fixed ring of slots in typed
  arrays, written straight into the instance matrices. Nothing casts a
  shadow.

  It steps in simulation time (the facade calls `step` after every fixed
  slice), so bullet time slows the fire with the barrels and a paused world
  holds its explosion mid-bloom. Headless (no parent) every call is a no-op.
*/

export interface Vec3Like {
  x: number
  y: number
  z: number
}

export interface Fx {
  /** the whole blast: flash, fireball, sparks, dirt, smoke, dust ring, scorch */
  explosion: (at: Vec3Like, power: number, radius: number) => void
  /** a prop coming apart: what flies off depends on what it was made of */
  debris: (kind: 'wood' | 'glass' | 'melon' | 'plastic' | 'metal', at: Vec3Like, vel: Vec3Like, size: number) => void
  /** one frame of a fuse burning at a point */
  burn: (at: Vec3Like, k: number) => void
  /** a puff of dust where something heavy landed */
  dust: (at: Vec3Like, size: number) => void
  /** masonry dust from a building coming down: big slow billows the
      colour of what broke (linear rgb), rolling out along the ground and
      hanging in the air for seconds. `size` is about a storey's width */
  plume: (at: Vec3Like, size: number, r: number, g: number, b: number) => void
  /** chunky bits of a wall knocked loose, in its own colour, thrown with
      `vel` and scattered over `size` */
  rubble: (at: Vec3Like, vel: Vec3Like, size: number, r: number, g: number, b: number) => void
  /** write the current flash (a blast, a burning fuse) into the pixel
      look's fake lights; once a frame, after the look is dressed */
  lightLook: (lights: FakeLights) => void
  /** advance everything by h seconds */
  step: (h: number) => void
  /** particles alive, for the harness */
  readonly live: number
  dispose: () => void
}

const NOOP_FX: Fx = {
  explosion: () => {},
  debris: () => {},
  burn: () => {},
  dust: () => {},
  plume: () => {},
  rubble: () => {},
  lightLook: () => {},
  step: () => {},
  live: 0,
  dispose: () => {},
}

/* ---------------------------------------------------------- the pools -- */

type Behave = 'fall' | 'fire' | 'smoke' | 'spark' | 'jet' | 'glow'

interface Pool {
  mesh: THREE.InstancedMesh
  cap: number
  behave: Behave
  next: number
  hi: number
  live: number
  p: Float32Array
  v: Float32Array
  /** age, life, delay-free age starts negative */
  age: Float32Array
  life: Float32Array
  /** scale xyz at birth, and how much it grows (fire, smoke) */
  s: Float32Array
  grow: Float32Array
  /** colour */
  c: Float32Array
  /** tumble: an axis and a rate */
  ax: Float32Array
  rate: Float32Array
  ang: Float32Array
  drag: Float32Array
  /** the share of its life after which it starts to shrink away */
  fadeAt: Float32Array
  /** per-instance opacity, for the sprite pools (smoke); null elsewhere */
  alpha: THREE.InstancedBufferAttribute | null
  /** a second mesh drawing the same instances with another blend (the
      glow's marked core over its additive halo) */
  twin: THREE.InstancedMesh | null
}

const pool = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, behave: Behave): Pool => {
  const mesh = new THREE.InstancedMesh(geo, mat, cap)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.setColorAt(0, new THREE.Color(1, 1, 1))
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  // every slot starts collapsed to nothing
  const zero = new THREE.Matrix4().makeScale(0, 0, 0)
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, zero)
  mesh.count = 1
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.userData.dynamic = true
  const alpha = geo.getAttribute('aAlpha') as THREE.InstancedBufferAttribute | undefined
  if (alpha) alpha.setUsage(THREE.DynamicDrawUsage)
  return {
    mesh, cap, behave, next: 0, hi: 0, live: 0, alpha: alpha ?? null, twin: null,
    p: new Float32Array(cap * 3), v: new Float32Array(cap * 3),
    age: new Float32Array(cap), life: new Float32Array(cap),
    s: new Float32Array(cap * 3), grow: new Float32Array(cap),
    c: new Float32Array(cap * 3),
    ax: new Float32Array(cap * 3), rate: new Float32Array(cap), ang: new Float32Array(cap),
    drag: new Float32Array(cap),
    fadeAt: new Float32Array(cap),
  }
}

/** a unit shape with its uvs pinned to the atlas's white cell and a white
    vertex colour (the atlas material multiplies by one; a geometry without
    the attribute reads it as black) */
const pinnedUV = (g: THREE.BufferGeometry, u: number, v: number) => {
  const t = g.getAttribute('uv')
  for (let i = 0; i < t.count; i++) t.setXY(i, u, v)
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(t.count * 3).fill(1), 3))
  return g
}

/*
  Fire and smoke are opaque and banded. The first version dissolved its fireballs
  through the same dither as the smoke, and through the look's posterize
  that read as a screen door: orange spheres you could see the street
  through, their hot middle and their edge both lost to the pattern, going
  muddy brown as they thinned. So a flame is now solid for its whole life
  (it shrinks away instead of thinning), writes depth like anything else
  solid, so the blobs occlude each other and the outline pass draws round
  the ball, and shades itself in three flat bands off how squarely each
  fragment faces the lens: a white-hot heart where the ball faces you, the
  body, and a deeper rind at the limb. Those are banded before the grade
  sees them, so the posterize has hard edges to keep rather than a gradient
  to dither.

  Smoke went the same way a round later, for the same reason: a puff
  thinned through a Bayer dither on gl_FragCoord read as a sparse dot
  pattern laid over the street, not as smoke. It is now a solid lit ball
  with the same three bands (a paler face and a darker limb, so a cluster of
  puffs keeps its shape), outlined like anything solid, and it goes by
  shrinking. `bands` is the three multipliers: face, body, limb.
*/
const banded = <M extends THREE.Material>(m: M, key: string, bands: [number, number, number]): M => {
  const f = (n: number) => n.toFixed(3)
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'varying vec3 vFxN;\nvarying vec3 vFxV;\nvoid main() {')
      .replace('#include <project_vertex>', [
        '#include <project_vertex>',
        'vec3 fxN = normal;',
        '#ifdef USE_INSTANCING',
        '  fxN = mat3(instanceMatrix) * fxN;',
        '#endif',
        'vFxN = normalMatrix * fxN;',
        'vFxV = -mvPosition.xyz;',
      ].join('\n'))
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'varying vec3 vFxN;\nvarying vec3 vFxV;\nvoid main() {')
      .replace('#include <opaque_fragment>', [
        'float fxF = abs(dot(normalize(vFxN), normalize(vFxV)));',
        `outgoingLight *= fxF > 0.8 ? ${f(bands[0])} : (fxF > 0.45 ? ${f(bands[1])} : ${f(bands[2])});`,
        '#include <opaque_fragment>',
      ].join('\n'))
  }
  m.customProgramCacheKey = () => key
  return m
}

/*
  Sprites: camera-facing quads for the two things a solid ball cannot be,
  light and air. One ShaderMaterial program in three blends (blending is GL
  state, not a program), all of them leaving the target's alpha as the
  scene wrote it except where they mean to mark it:

    glow (additive): the blast's core, near white and HDR, added over
      whatever is behind it so a barrel tumbling through the fireball is
      still seen inside it, the way Garry's Mod blows the middle out;
    core (additive, writes GLOW_ALPHA): the same glow's inner disc, marked
      as a light so the look leaves it out of the grade, the outline ink
      and the lamp light (pixelLook's GLOW_ALPHA, the physgun beam's trick);
    smoke (premultiplied over): soft, translucent air in three stepped
      bands of opacity with a dithered seam between them, lit by the scene's
      ambient (`uShade`, set from the look each frame), so a column of it
      darkens by night and never glows. It is transparent through blending,
      never through alpha in the target, so it is not a hole.

  The quads are billboarded in the vertex shader from the instance matrix's
  translation and its x and y scales, so a flattened instance is a lens of
  dust lying along the ground.
*/
const SPRITE_VERT = `
attribute float aAlpha;
uniform float uMode;
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
varying float vSeed;
void main() {
  // a slot's own number, stable for its whole life: what makes one flame's
  // ragged edge different from the next without a per-frame shimmer
  vSeed = fract(float(gl_InstanceID) * 0.6180339 + 0.13);
  vUv = position.xy * 2.0;
  #ifdef USE_INSTANCING_COLOR
    vCol = instanceColor;
  #else
    vCol = vec3(1.0);
  #endif
  vA = aAlpha;
  vec3 c = instanceMatrix[3].xyz;
  vec2 sz = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  // no sprite may fill the screen: the glow is held to about a fifth of
  // the view's height at its distance, the fire to a third (a blast beside
  // the lens whited out most of the frame, and the barrels and bodies in it
  // with it)
  float lim = -mv.z * (uMode < 1.5 ? 0.22 : 0.34);
  sz = min(sz, vec2(lim));
  mv.xy += position.xy * sz * 2.0;
  // smoke is drawn at its near face, not its middle: a quad through a
  // puff's centre is cut in a hard straight line by any wall the puff
  // reaches, and it read as grey discs stuck to the building. Glow and fire
  // keep their middles, so a barrel in front of the blast is in front of it
  // and one behind is behind it
  if (uMode > 1.5 && uMode < 2.5) mv.z += min(sz.x, sz.y) * 0.9;
  // a hot tongue is drawn a little forward of its middle, a cool one at
  // it: the heart of the fire shows through the cooler rind round it, the
  // way additive fire would, instead of being buried by it
  if (uMode > 2.5) mv.z += min(sz.x, sz.y) * clamp((vCol.r - 0.7) * 2.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}
`
const SPRITE_FRAG = `
uniform float uMode;
uniform float uShade;
uniform float uGlowA;
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
varying float vSeed;
float bayer(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[i]) + 0.5) / 16.0;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  // the radius, jittered by the ordered dither so a band's edge is a seam
  // of whole art pixels rather than a smooth ramp
  float r = length(vUv) + (bayer(gl_FragCoord.xy) - 0.5) * 0.09;
  if (r > 1.0) discard;
  if (uMode < 0.5) {
    // the halo: three flat steps of added light
    float k = r < 0.42 ? 1.0 : r < 0.68 ? 0.5 : 0.2;
    gl_FragColor = vec4(vCol * k, 0.0);
  } else if (uMode < 1.5) {
    // the marked core: the inner step only
    if (r > 0.42) discard;
    gl_FragColor = vec4(vCol * 0.6, uGlowA);
  } else if (uMode < 2.5) {
    // smoke: a lumpy blob off value noise (a different lump on every slot,
    // never a repeated star), in four steps of opacity from a dense middle
    // to a thin rim, the steps' seams dithered, so a cloud of them thins
    // into the sky instead of ending on a cut edge
    float n = vnoise(vUv * 2.0 + vSeed * vec2(13.0, 29.0));
    float d = length(vUv) + (bayer(gl_FragCoord.xy) - 0.5) * 0.12;
    float edge = 0.62 + 0.36 * n;
    if (d > edge) discard;
    float q = d / edge;
    float a = (q < 0.4 ? 0.85 : q < 0.65 ? 0.6 : q < 0.85 ? 0.36 : 0.16) * vA;
    // a lit crown and a shaded belly, as a puff lit from above
    float lit = vUv.y > 0.35 ? 1.16 : vUv.y < -0.45 ? 0.82 : 1.0;
    gl_FragColor = vec4(vCol * lit * uShade * a, a);
  } else {
    // flame: one tongue of a fireball, a teardrop narrowing upward whose
    // edge is value noise scrolling up through it, so it licks and never
    // repeats a shape. Heat (instance red, set hottest for the tongues at
    // the heart of the blast and cooling with age) falls from its middle
    // out through four flat bands: white-yellow, yellow, orange, red tips.
    // Written as a light (GLOW_ALPHA) so the look inks no rim round it and
    // grades none of its colour away, and with depth, so the tongues and
    // everything flying through them sort front to back
    vec2 p = vUv;
    p.y += 0.15;
    float n = vnoise(p * 2.2 + vec2(vSeed * 17.0, vSeed * 31.0 - uTime * 2.6));
    float n2 = vnoise(p * 4.6 + vec2(vSeed * 7.0, -uTime * 4.5));
    float w = 1.0 - 0.5 * clamp(p.y, 0.0, 1.0);
    float d = length(vec2(p.x / max(w, 0.3), p.y * 0.78));
    float edge = 0.5 + 0.34 * n + 0.14 * n2;
    if (d > edge) discard;
    float q = d / edge;
    float heat = vCol.r * (1.12 - 0.85 * q) + (bayer(gl_FragCoord.xy) - 0.5) * 0.1;
    vec3 c = heat > 0.8 ? vec3(5.0, 4.2, 2.4)
      : heat > 0.58 ? vec3(3.2, 1.9, 0.3)
      : heat > 0.36 ? vec3(1.7, 0.42, 0.04)
      : vec3(0.85, 0.14, 0.02);
    gl_FragColor = vec4(c, uGlowA);
  }
}
`
const spriteMaterial = (mode: 0 | 1 | 2 | 3) => {
  const m = new THREE.ShaderMaterial({
    vertexShader: SPRITE_VERT,
    fragmentShader: SPRITE_FRAG,
    uniforms: { uMode: { value: mode }, uShade: { value: 1 }, uGlowA: { value: GLOW_ALPHA }, uTime: { value: 0 } },
    transparent: true,
    // the flames sort among themselves and with the props by depth; they
    // are marked as a light, so the look draws no outline where they do
    depthWrite: mode === 3,
  })
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendEquationAlpha = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = mode >= 2 ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor
  // the core and the flames replace alpha with the light mark; the rest
  // keep the scene's
  const marks = mode === 1 || mode === 3
  m.blendSrcAlpha = marks ? THREE.OneFactor : THREE.ZeroFactor
  m.blendDstAlpha = marks ? THREE.ZeroFactor : THREE.OneFactor
  m.name = ['sandbox-glow', 'sandbox-core', 'sandbox-smoke', 'sandbox-flame'][mode]
  return m
}
/** a unit quad with a per-instance opacity */
const spriteQuad = (cap: number) => {
  const g = new THREE.PlaneGeometry(1, 1)
  g.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1))
  return g
}

/** smoke's brightness per unit of the look's ambient (its luminance) */
const SHADE = 2.4

/* the fire ramp, HDR linear: white-hot to soot */
const RAMP: Array<[number, number, number, number]> = [
  [0, 4.2, 3.0, 1.3],
  [0.1, 3.2, 1.3, 0.2],
  [0.3, 2.0, 0.5, 0.07],
  [0.55, 0.9, 0.17, 0.04],
  [0.8, 0.26, 0.07, 0.03],
  [1, 0.09, 0.045, 0.035],
]
const ramp = (t: number, out: Float32Array, o: number) => {
  let i = 1
  while (i < RAMP.length - 1 && RAMP[i][0] < t) i++
  const [t0, r0, g0, b0] = RAMP[i - 1]
  const [t1, r1, g1, b1] = RAMP[i]
  const k = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))
  out[o] = r0 + (r1 - r0) * k
  out[o + 1] = g0 + (g1 - g0) * k
  out[o + 2] = b0 + (b1 - b0) * k
}

/* ------------------------------------------------------------ decals -- */

const decalTexture = (paint: (ctx: CanvasRenderingContext2D) => void) => {
  const cv = document.createElement('canvas')
  cv.width = 32
  cv.height = 32
  const ctx = cv.getContext('2d')!
  paint(ctx)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  return t
}

/** a ragged blotch on the texel grid: a disc with noise at its rim */
const blotch = (ctx: CanvasRenderingContext2D, seed: number, inner: string, outer: string, spikes: boolean) => {
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const lobes = Array.from({ length: 9 }, () => 0.75 + rnd() * 0.35)
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const dx = x + 0.5 - 16
      const dy = y + 0.5 - 16
      const r = Math.hypot(dx, dy) / 15
      const a = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) * 9
      const i = Math.floor(a) % 9
      const lobe = lobes[i] + (lobes[(i + 1) % 9] - lobes[i]) * (a - Math.floor(a))
      const edge = lobe * (spikes && rnd() < 0.06 ? 1.25 : 1) + (rnd() - 0.5) * 0.12
      if (r > edge) continue
      ctx.fillStyle = r < edge * 0.55 ? inner : outer
      ctx.fillRect(x, y, 1, 1)
    }
}

/* ------------------------------------------------------------- create -- */

export interface FxOpts {
  /** where the pools hang; null for headless */
  parent: THREE.Object3D | null
  /** the ground under a point, for bouncing bits and laying decals */
  groundY: (x: number, z: number) => number
}

export const createFx = (o: FxOpts): Fx => {
  const parent = o.parent
  if (!parent || typeof document === 'undefined') return NOOP_FX
  const ground = o.groundY

  const root = new THREE.Group()
  root.name = 'sandbox-fx'
  parent.add(root)

  // the props' atlas material lends its white cell to the bits, which are
  // the same instanced program the props' batches already use
  const litMat = propMaterial()
  const whiteUV = cellCenter('white')
  const fireMat = banded(new THREE.MeshBasicMaterial({ color: 0xffffff }), 'sandbox-fire', [1.75, 1, 0.62])
  fireMat.name = 'sandbox-fire'
  const smokeMat = spriteMaterial(2)
  const flameMat = spriteMaterial(3)
  const glowMat = spriteMaterial(0)
  const coreMat = spriteMaterial(1)

  const CAP = { bits: 700, puffs: 480, fire: 360, sparks: 260, jets: 96, dust: 520, glows: 48 }
  const ico0 = spriteQuad(CAP.puffs)
  const quadG = spriteQuad(CAP.glows)
  const ico1 = spriteQuad(CAP.fire)
  const cube = pinnedUV(new THREE.BoxGeometry(1, 1, 1), whiteUV[0], whiteUV[1])
  const spark = new THREE.BoxGeometry(1, 1, 1)
  // a flame tongue: a diamond drawn out along z, its base at the centre of
  // the blast so it grows outward from it
  const tongue = new THREE.OctahedronGeometry(0.5, 0).translate(0, 0, 0.5)

  const bits = pool(cube, litMat, CAP.bits, 'fall')
  const puffs = pool(ico0, smokeMat, CAP.puffs, 'smoke')
  const fire = pool(ico1, flameMat, CAP.fire, 'fire')
  const sparks = pool(spark, fireMat, CAP.sparks, 'spark')
  const jets = pool(tongue, fireMat, CAP.jets, 'jet')
  // the glow's halo and its marked core: two meshes over one set of
  // instances, the core drawn second
  const glows = pool(quadG, glowMat, CAP.glows, 'glow')
  const core = new THREE.InstancedMesh(quadG, coreMat, CAP.glows)
  core.instanceMatrix = glows.mesh.instanceMatrix
  core.instanceColor = glows.mesh.instanceColor
  core.count = 1
  core.frustumCulled = false
  core.userData.dynamic = true
  glows.twin = core
  // masonry dust: the smoke's own translucent sprites (so no new program),
  // in the colour of the wall that went, rolling out along the ground and
  // then rising, swelling and thinning through the blend. A solid billow,
  // banded or lit, reads as a boulder on the lawn; air has to be see-through
  const dust = pool(spriteQuad(CAP.dust), smokeMat, CAP.dust, 'smoke')
  // air last: after everything solid, the fire over its own smoke
  puffs.mesh.renderOrder = 10
  fire.mesh.renderOrder = 11
  sparks.mesh.renderOrder = 11
  jets.mesh.renderOrder = 11
  dust.mesh.renderOrder = 10
  glows.mesh.renderOrder = 12
  core.renderOrder = 13
  const pools = [bits, puffs, fire, sparks, jets, dust, glows]
  for (const p of pools) root.add(p.mesh)
  root.add(core)

  /* decals: a small ring of flat quads, two materials, one program */
  // lit, like the road it lies on: an unlit dark decal is a fixed colour
  // the look's lamp and flash light then divide by the dusk's ambient to
  // recover an albedo from, and at dusk the scorch came out as a bright
  // orange ring on the asphalt
  const mkDecalMat = (tex: THREE.Texture) => {
    const m = new THREE.MeshLambertMaterial({
      map: tex, alphaTest: 0.5, transparent: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    })
    return m
  }
  const scorchMat = mkDecalMat(decalTexture((c) => blotch(c, 7, '#1c1916', '#3b342d', true)))
  scorchMat.name = 'sandbox-scorch'
  const splatMat = mkDecalMat(decalTexture((c) => blotch(c, 19, '#8c1f1c', '#b8322a', true)))
  splatMat.name = 'sandbox-splat'
  const decalGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const DECALS = 24
  const decals: Array<{ mesh: THREE.Mesh; age: number; size: number }> = []
  for (let i = 0; i < DECALS; i++) {
    const mesh = new THREE.Mesh(decalGeo, i === 0 ? splatMat : scorchMat)
    // the first two carry one material each and are drawn every frame,
    // collapsed to nothing and never culled, for the pools' reason above
    mesh.scale.setScalar(0)
    mesh.frustumCulled = i >= 2
    if (i >= 2) mesh.visible = false
    mesh.userData.dynamic = true
    mesh.castShadow = false
    mesh.receiveShadow = false
    root.add(mesh)
    decals.push({ mesh, age: -1, size: 0 })
  }
  let nextDecal = 2
  const tn = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const decal = (x: number, z: number, size: number, splat: boolean) => {
    const d = decals[nextDecal]
    nextDecal = nextDecal + 1 >= DECALS ? 2 : nextDecal + 1
    const y = ground(x, z)
    const e = 0.6
    tn.set(ground(x - e, z) - ground(x + e, z), 2 * e, ground(x, z - e) - ground(x, z + e)).normalize()
    d.mesh.material = splat ? splatMat : scorchMat
    d.mesh.position.set(x, y + 0.03, z)
    d.mesh.quaternion.setFromUnitVectors(up, tn)
    d.mesh.rotateY(Math.random() * Math.PI * 2)
    d.mesh.scale.set(size, 1, size)
    d.mesh.visible = true
    d.age = 0
    d.size = size
  }

  /* ------------------------------------------------------------ emit -- */

  const emit = (
    P: Pool, x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, sx: number, sy: number, sz: number, r: number, g: number, b: number,
    opts: { delay?: number; grow?: number; drag?: number; spin?: number; fadeAt?: number } = {},
  ) => {
    const i = P.next
    P.next = (P.next + 1) % P.cap
    if (i + 1 > P.hi) P.hi = i + 1
    const i3 = i * 3
    P.p[i3] = x; P.p[i3 + 1] = y; P.p[i3 + 2] = z
    P.v[i3] = vx; P.v[i3 + 1] = vy; P.v[i3 + 2] = vz
    P.age[i] = -(opts.delay ?? 0)
    P.life[i] = life
    P.s[i3] = sx; P.s[i3 + 1] = sy; P.s[i3 + 2] = sz
    P.grow[i] = opts.grow ?? 1
    P.c[i3] = r; P.c[i3 + 1] = g; P.c[i3 + 2] = b
    const ax = Math.random() - 0.5
    const ay = Math.random() - 0.5
    const az = Math.random() - 0.5
    const al = Math.hypot(ax, ay, az) || 1
    P.ax[i3] = ax / al; P.ax[i3 + 1] = ay / al; P.ax[i3 + 2] = az / al
    P.rate[i] = (opts.spin ?? 8) * (0.5 + Math.random())
    P.ang[i] = Math.random() * 6.28
    P.drag[i] = opts.drag ?? 0
    P.fadeAt[i] = opts.fadeAt ?? (P.behave === 'fire' ? 0.5 : 0.3)
  }

  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  /** a random direction, biased upward by `lift` */
  const dir = (lift: number, out: number[]) => {
    const a = Math.random() * Math.PI * 2
    const y = Math.random() * (1 - lift) + lift
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    out[0] = Math.cos(a) * r
    out[1] = y
    out[2] = Math.sin(a) * r
    return out
  }
  const d3 = [0, 0, 0]

  /* the flash: one light in the look's fake-light pass (no PointLight, so
     no program changes), white-orange for a blink and then the fire's glow
     dying over most of a second. A burning fuse flickers in the same slot
     while no blast is using it */
  const flash = { x: 0, y: 0, z: 0, r: 0, power: 0, t: 99, burn: 0, bx: 0, by: 0, bz: 0 }

  const fx: Fx = {
    explosion: (at, power, radius) => {
      const k = Math.sqrt(Math.max(0.2, power))
      const R = radius
      flash.x = at.x
      flash.y = at.y + 1.2
      flash.z = at.z
      flash.r = R * 0.95
      flash.power = k
      flash.t = 0
      // the heart: light, not a ball. One big near-white glow added over
      // everything, three or four barrels across, with a few smaller ones
      // round it, all gone within about a third of a second; a barrel
      // tumbling out of the middle is seen through it, and its inner disc
      // is marked as a light so nothing inks or grades it
      emit(glows, at.x, at.y + 1.2, at.z, 0, 2, 0, rnd(0.28, 0.34), R * 0.28 * k, R * 0.28 * k, 1,
        2.4, 2.05, 1.6, { grow: 1.6, drag: 3 })
      for (let i = 0; i < 4; i++) {
        dir(0.15, d3)
        const o = R * rnd(0.12, 0.22)
        const s = R * rnd(0.13, 0.19) * k
        emit(glows, at.x + d3[0] * o, at.y + 1.2 + d3[1] * o * 0.8, at.z + d3[2] * o, d3[0] * 8, d3[1] * 8 + 3, d3[2] * 8,
          rnd(0.18, 0.28), s, s, 1, 2.6, 2.1, 1.4, { grow: 1.5, drag: 5, delay: rnd(0, 0.03) })
      }
      // spears of flame thrown out radially, mostly upward, reaching well
      // past the fireball for a fifth of a second: the spiky silhouette that
      // says blast and not bonfire
      const tongues = Math.round(12 + 6 * k)
      for (let i = 0; i < tongues; i++) {
        dir(0.12, d3)
        const sp = rnd(35, 55) * k
        const len = rnd(7, 13) * k
        const w = rnd(0.45, 0.8) * k
        emit(jets, at.x, at.y + 0.8, at.z, d3[0] * sp, d3[1] * sp, d3[2] * sp, rnd(0.16, 0.28), w, w, len,
          1.6, 1.35, 1.0, { drag: 7, fadeAt: 0.35 })
      }
      // the fireball behind the light: tongues of flame of every size,
      // spread through a volume round the blast (so props fly in front of
      // some and behind others), the slow ones at the heart white-yellow and
      // the fast outer ones cooling to orange and red, all of them rising
      // (fire.step gives flame its own buoyancy) and shrinking as they go
      const tongues2 = Math.round(18 + 8 * k)
      for (let i = 0; i < tongues2; i++) {
        dir(0.05, d3)
        const big = Math.random()
        const s = (0.45 + big * big * 1.5) * k
        const out = Math.random()
        const sp = (3 + out * 12) * k
        const heat = 1.25 - 0.5 * out - 0.2 * big
        const o = 0.4 + out * 1.4
        emit(fire, at.x + d3[0] * o, at.y + 0.9 + d3[1] * o, at.z + d3[2] * o,
          d3[0] * sp, d3[1] * sp + rnd(3, 7), d3[2] * sp, rnd(0.4, 0.75), s, s * 1.15, s, heat, 0, 0,
          { grow: rnd(1.25, 1.55), drag: 4, delay: rnd(0.04, 0.14), fadeAt: 0.3 })
      }
      // and its crown: tongues let go late from the heart that climb on
      // their own as the ball below them shrinks
      for (let i = 0; i < 7; i++) {
        const s = rnd(0.5, 0.95) * k
        emit(fire, at.x + rnd(-0.8, 0.8), at.y + 1.8 + rnd(0, 1), at.z + rnd(-0.8, 0.8),
          rnd(-1.5, 1.5), rnd(9, 14), rnd(-1.5, 1.5), rnd(0.45, 0.7), s, s * 1.3, s, rnd(0.95, 1.15), 0, 0,
          { grow: 1.3, drag: 2, delay: rnd(0.2, 0.4), fadeAt: 0.35 })
      }
      // soot rolling off the top and the rim as the fire goes: smoke, not
      // flame, so it is soft-edged and see-through rather than a dark stamp
      for (let i = 0; i < 6; i++) {
        dir(0.35, d3)
        const s = rnd(1.0, 1.7) * k
        const g = rnd(0.08, 0.13)
        emit(puffs, at.x + d3[0] * 2.4, at.y + 2.6 + d3[1], at.z + d3[2] * 2.4,
          d3[0] * 3, rnd(5, 8), d3[2] * 3, rnd(1.6, 2.4), s, s, 1, g, g * 0.95, g * 0.9,
          { grow: rnd(1.8, 2.4), drag: 0.8, spin: 0, delay: rnd(0.25, 0.45), fadeAt: 0.25 })
      }
      // sparks: streaks flung far and falling
      const n = Math.round(26 + 14 * k)
      for (let i = 0; i < n; i++) {
        dir(0.1, d3)
        const sp = rnd(28, 70) * k
        emit(sparks, at.x, at.y + 0.6, at.z, d3[0] * sp, d3[1] * sp, d3[2] * sp, rnd(0.35, 0.9),
          0.09, 0.09, 1, rnd(6, 9), rnd(3.6, 5.5), rnd(0.8, 1.6), { drag: 0.8 })
      }
      // dirt and grit
      for (let i = 0; i < 16; i++) {
        dir(0.45, d3)
        const sp = rnd(10, 26) * k
        const s = rnd(0.12, 0.34)
        const g = rnd(0.05, 0.12)
        emit(bits, at.x, at.y + 0.3, at.z, d3[0] * sp, d3[1] * sp, d3[2] * sp, rnd(1.6, 2.8), s, s, s, g, g * 0.9, g * 0.8, { spin: 14 })
      }
      // smoke: a column that climbs out of the fire as it dies, fed from
      // the bottom for a second, each puff rising straight up (a blast has
      // no wind of its own), swelling and darkening as it goes
      for (let i = 0; i < 16; i++) {
        const d = rnd(0.15, 1.2)
        const s = rnd(1.1, 1.8) * k * (0.8 + d * 0.3)
        const g = rnd(0.2, 0.28)
        emit(puffs, at.x + rnd(-0.8, 0.8), at.y + 1 + rnd(0, 1.5), at.z + rnd(-0.8, 0.8),
          rnd(-0.4, 0.4), rnd(4, 7), rnd(-0.4, 0.4), rnd(2.4, 3.4), s, s, 1, g, g * 0.95, g * 0.9,
          { delay: d, grow: rnd(2, 2.8), drag: 0.5, spin: 0, fadeAt: 0.3 })
      }
      // a dust ring racing out along the ground
      const gy = ground(at.x, at.z)
      if (at.y - gy < 3) {
        // (flat, wide lenses of dust rather than balls, low and never
        // spinning: now that puffs are solid, a round grey one sitting on
        // the grass read as a stone)
        for (let i = 0; i < 22; i++) {
          const a = (i / 22) * Math.PI * 2 + rnd(-0.1, 0.1)
          const sp = rnd(16, 24) * k
          const s = rnd(0.8, 1.2)
          emit(puffs, at.x + Math.cos(a), gy + 0.25, at.z + Math.sin(a), Math.cos(a) * sp, rnd(0.3, 1.2), Math.sin(a) * sp,
            rnd(0.5, 0.75), s, s * 0.45, s, 0.55, 0.48, 0.38, { grow: 2.2, drag: 3.2, spin: 0, fadeAt: 0.2 })
        }
        decal(at.x, at.z, R * 0.32 * k, false)
      }
    },

    debris: (kind, at, vel, size) => {
      const spread = 6 + size * 2
      const c = {
        wood: [0.62, 0.42, 0.22],
        glass: [0.5, 0.8, 0.55],
        melon: [0.75, 0.08, 0.07],
        plastic: [0.8, 0.78, 0.72],
        metal: [0.45, 0.46, 0.48],
      }[kind]
      const count = kind === 'glass' ? 22 : kind === 'melon' ? 26 : kind === 'wood' ? 34 : 16
      for (let i = 0; i < count; i++) {
        dir(0.2, d3)
        const sp = rnd(0.3, 1) * spread
        let sx: number, sy: number, sz: number
        let r = c[0], g = c[1], b = c[2]
        if (kind === 'wood') {
          // splinters: long, thin
          // splinters: long, thin, and a few chips; a texel or two across
          // at the look's scale, so they read as a spray rather than dust
          const chip = Math.random() < 0.3
          sx = rnd(0.06, 0.1); sy = rnd(0.05, 0.09); sz = chip ? rnd(0.08, 0.16) : rnd(0.25, 0.6) * Math.min(1.4, size)
          const k = rnd(0.8, 1.25); r *= k; g *= k; b *= k
        } else if (kind === 'glass') {
          sx = rnd(0.06, 0.16); sy = 0.02; sz = rnd(0.06, 0.16)
          const k = rnd(0.7, 1.4); r *= k; g *= k; b *= k
        } else if (kind === 'melon') {
          const s = rnd(0.06, 0.2)
          sx = s; sy = s; sz = s
          const pick = Math.random()
          if (pick < 0.15) { r = 0.2; g = 0.34; b = 0.13 } else if (pick < 0.25) { r = 0.03; g = 0.02; b = 0.02 } else if (pick < 0.35) { r = 0.85; g = 0.82; b = 0.62 }
        } else {
          const s = rnd(0.06, 0.16)
          sx = s; sy = s; sz = s
        }
        emit(bits, at.x + d3[0] * size * 0.4, at.y + d3[1] * size * 0.4, at.z + d3[2] * size * 0.4,
          vel.x * 0.6 + d3[0] * sp, vel.y * 0.4 + d3[1] * sp + 2, vel.z * 0.6 + d3[2] * sp,
          rnd(1.2, 2.4), sx, sy, sz, r, g, b, { spin: 16 })
      }
      if (kind === 'wood' || kind === 'plastic') fx.dust(at, size)
      if (kind === 'wood') {
        // and a haze of sawdust that hangs over the pile and sinks onto it
        const gy = ground(at.x, at.z)
        for (let i = 0; i < 7; i++) {
          dir(0.1, d3)
          const s = rnd(0.35, 0.6) * Math.min(1.6, size)
          emit(puffs, at.x + d3[0] * size * 0.8, Math.max(gy + 0.4, at.y + rnd(-0.3, 0.6)), at.z + d3[2] * size * 0.8,
            d3[0] * 1.2, rnd(-1.4, -0.4), d3[2] * 1.2, rnd(1.6, 2.4), s, s * 0.55, s, 0.4, 0.31, 0.2,
            { delay: rnd(0.05, 0.25), grow: 1.9, drag: 1.6, spin: 0.6, fadeAt: 0.25 })
        }
      }
      if (kind === 'melon') {
        const gy = ground(at.x, at.z)
        if (at.y - gy < 2.5) decal(at.x, at.z, 1.6 + size, true)
      }
    },

    burn: (at, k) => {
      flash.burn = Math.max(flash.burn, 0.5 + 0.5 * k)
      flash.bx = at.x
      flash.by = at.y + 0.6
      flash.bz = at.z
      if (Math.random() < 0.55) {
        const s = rnd(0.35, 0.7) * (0.6 + k)
        emit(fire, at.x + rnd(-0.25, 0.25), at.y, at.z + rnd(-0.25, 0.25), rnd(-0.6, 0.6), rnd(3, 6), rnd(-0.6, 0.6),
          rnd(0.25, 0.45), s, s, s, rnd(0.7, 0.95), 0, 0, { grow: 1.3, drag: 0.5 })
      }
      if (Math.random() < 0.12) {
        const s = rnd(0.4, 0.8)
        const g = rnd(0.05, 0.1)
        emit(puffs, at.x, at.y + 0.6, at.z, rnd(-0.5, 0.5), rnd(2.5, 4), rnd(-0.5, 0.5), rnd(1.4, 2.2), s, s, s, g, g, g,
          { grow: 2.4, drag: 0.4, spin: 1 })
      }
      if (Math.random() < 0.08) {
        emit(sparks, at.x, at.y, at.z, rnd(-3, 3), rnd(5, 10), rnd(-3, 3), rnd(0.3, 0.6), 0.06, 0.06, 0.4, 7, 4, 1, { drag: 0.5 })
      }
    },

    dust: (at, size) => {
      const n = 3 + Math.round(size * 2)
      for (let i = 0; i < n; i++) {
        dir(0.3, d3)
        const s = rnd(0.22, 0.42) * Math.min(2.5, size)
        emit(puffs, at.x + d3[0] * size * 0.5, at.y, at.z + d3[2] * size * 0.5, d3[0] * 3, rnd(0.6, 1.6), d3[2] * 3,
          rnd(0.5, 0.8), s, s, s, 0.32, 0.29, 0.24, { grow: 1.8, drag: 2.5, spin: 1.5, fadeAt: 0.05 })
      }
    },

    plume: (at, size, r0, g0, b0) => {
      // billows the wall's own colour pulled toward a warm grey, rolling out
      // along the ground the way a collapse pushes its dust ahead of it, then
      // rising, swelling and thinning to nothing: translucent sprites, so a
      // cloud of it shows the ruin through it
      const n = Math.min(10, 3 + Math.round(size * 0.8))
      const sz = Math.min(1.4, 0.5 + size * 0.07)
      const r = r0 * 0.5 + 0.12
      const g = g0 * 0.5 + 0.11
      const b = b0 * 0.5 + 0.095
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const out = rnd(2, 7) * Math.min(1.8, 0.6 + size * 0.08)
        const s = rnd(0.7, 1.3) * sz
        const k = i % 3 === 0 ? rnd(0.72, 0.82) : rnd(0.95, 1.1)
        emit(dust, at.x + Math.cos(a) * size * 0.25, at.y + rnd(-0.2, 0.8), at.z + Math.sin(a) * size * 0.25,
          Math.cos(a) * out, rnd(0.6, 2.4), Math.sin(a) * out, rnd(1.8, 3.2), s, s * rnd(0.75, 1), s,
          r * k, g * k, b * k,
          { delay: rnd(0, 0.3), grow: rnd(1.8, 2.6), drag: 1.2, spin: 0.5, fadeAt: 0.1 })
      }
    },

    rubble: (at, vel, size, r, g, b) => {
      const n = Math.min(18, 5 + Math.round(size * 2))
      for (let i = 0; i < n; i++) {
        dir(0.15, d3)
        const sp = rnd(1, 6)
        const s = rnd(0.14, 0.42) * Math.min(1.6, 0.6 + size * 0.2)
        const k = rnd(0.75, 1.2)
        emit(bits, at.x + (Math.random() - 0.5) * size, at.y + (Math.random() - 0.5) * size * 0.5, at.z + (Math.random() - 0.5) * size,
          vel.x * 0.7 + d3[0] * sp, vel.y * 0.5 + d3[1] * sp + 1.5, vel.z * 0.7 + d3[2] * sp,
          rnd(1.6, 3), s, s * rnd(0.6, 1), s, r * k, g * k, b * k, { spin: 9 })
      }
    },

    lightLook: (lights) => {
      // smoke is lit by the scene's own ambient: pale by day, near black
      // under the stars, never glowing
      const amb = lights.ambient
      smokeMat.uniforms.uShade.value = Math.min(1.1, Math.max(0.1, (amb.r * 0.3 + amb.g * 0.59 + amb.b * 0.11) * SHADE))
      const f = lights.flash
      if (flash.t < 1.4) {
        // for the first three frames a whiter flash that lights the street,
        // the fronts across it and everything standing near, then the
        // fireball's orange glow falling away over most of a second. It is
        // held under what whites out the frame: the look also draws a third
        // of its radius as lit air, and at twice this a blast beside the
        // lens washed seventy per cent of the picture, bodies and barrels
        // with it
        const t = flash.t
        const blink = t < 0.05 ? 1 : Math.max(0, 1 - (t - 0.05) / 0.06)
        const glow = Math.exp(-t * 2.6) * (0.85 + 0.15 * Math.sin(t * 60))
        const g = flash.power * (0.8 * blink + 2.2 * glow)
        f.pos.set(flash.x, flash.y, flash.z)
        f.radius = flash.r
        f.color.setRGB(g * 1.0, g * (0.52 + 0.4 * blink), g * (0.18 + 0.62 * blink))
      } else if (flash.burn > 0.01) {
        const g = flash.burn * (0.9 + 0.3 * Math.sin(flash.t * 31) * Math.sin(flash.t * 17))
        f.pos.set(flash.bx, flash.by, flash.bz)
        f.radius = 7
        f.color.setRGB(1.6 * g, 0.72 * g, 0.22 * g)
      } else {
        f.radius = 0
      }
    },

    step: (h) => {
      flameMat.uniforms.uTime.value += h
      flash.t += h
      flash.burn = Math.max(0, flash.burn - h * 3)
      live = 0
      for (const P of pools) {
        stepPool(P, h)
        live += P.live
      }
      for (const d of decals) {
        if (d.age < 0) continue
        d.age += h
        // scorch marks last a while, then sink away
        const left = 50 - d.age
        if (left < 3) {
          const k = Math.max(0, left / 3)
          d.mesh.scale.set(d.size * k, 1, d.size * k)
          if (k <= 0) {
            d.age = -1
            d.mesh.visible = false
          }
        }
      }
    },

    get live() {
      return live
    },

    dispose: () => {
      root.removeFromParent()
      for (const P of pools) P.mesh.dispose()
      ico0.dispose(); ico1.dispose(); cube.dispose(); spark.dispose(); tongue.dispose()
      quadG.dispose(); core.dispose()
      smokeMat.dispose(); glowMat.dispose(); coreMat.dispose(); flameMat.dispose()
      decalGeo.dispose()
      fireMat.dispose(); scorchMat.dispose(); splatMat.dispose()
      scorchMat.map?.dispose(); splatMat.map?.dispose()
    },
  }
  let live = 0

  /* -------------------------------------------------------------- step -- */

  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const scl = new THREE.Vector3()
  const axis = new THREE.Vector3()
  const vdir = new THREE.Vector3()
  const zAxis = new THREE.Vector3(0, 0, 1)
  const col = new THREE.Color()
  const cbuf = new Float32Array(3)
  const G = 34

  const stepPool = (P: Pool, h: number) => {
    if (!P.hi) return
    let hi = 0
    let live = 0
    let dirtyC = false
    for (let i = 0; i < P.hi; i++) {
      if (P.life[i] <= 0) continue
      const i3 = i * 3
      P.age[i] += h
      const age = P.age[i]
      if (age < 0) {
        // not born yet: stays collapsed
        hi = i + 1
        live++
        continue
      }
      const t = age / P.life[i]
      if (t >= 1) {
        P.life[i] = 0
        m4.makeScale(0, 0, 0)
        P.mesh.setMatrixAt(i, m4)
        continue
      }
      hi = i + 1
      live++
      // motion
      const drag = Math.exp(-P.drag[i] * h)
      P.v[i3] *= drag
      P.v[i3 + 2] *= drag
      if (P.behave === 'fall' || P.behave === 'spark') P.v[i3 + 1] -= G * h
      else P.v[i3 + 1] = P.v[i3 + 1] * drag + (P.behave === 'fire' ? 7 : P.behave === 'jet' ? 1.5 : 0.6) * h
      P.p[i3] += P.v[i3] * h
      P.p[i3 + 1] += P.v[i3 + 1] * h
      P.p[i3 + 2] += P.v[i3 + 2] * h
      if (P.behave === 'fall') {
        const gy = ground(P.p[i3], P.p[i3 + 2]) + P.s[i3 + 1] * 0.5
        if (P.p[i3 + 1] < gy) {
          // land: bounce low, skid, stop tumbling
          P.p[i3 + 1] = gy
          P.v[i3 + 1] = Math.abs(P.v[i3 + 1]) * 0.25
          P.v[i3] *= 0.5
          P.v[i3 + 2] *= 0.5
          P.rate[i] *= 0.5
          if (P.v[i3 + 1] < 1) P.v[i3 + 1] = 0
        }
      }
      pos.set(P.p[i3], P.p[i3 + 1], P.p[i3 + 2])
      // shape over life
      let k = 1
      if (P.behave === 'fire' || P.behave === 'jet') {
        // swell fast and hold while it cools, then shrink away solid (never
        // thinned: see `banded`), going out at a deep red rather than
        // cooling all the way to soot, which is the smoke's job
        const g = P.grow[i]
        k = 1 + (g - 1) * (1 - (1 - Math.min(1, t * 3)) ** 3)
        const f0 = P.fadeAt[i]
        if (P.behave === 'jet') k = Math.min(1, t * 6)
        if (t > f0) k *= 1 - ((t - f0) / (1 - f0)) ** 2
        if (P === fire) {
          // a flame sprite carries heat and soot, not a colour: the heat
          // cools over its life (so a tongue's bands slide from white-hot
          // to orange tips), the soot stays what it was born as
          col.setRGB(P.c[i3] * (1 - 0.5 * t), P.c[i3 + 1], 0)
        } else {
          ramp(t * 0.62, cbuf, 0)
          col.setRGB(cbuf[0] * P.c[i3], cbuf[1] * P.c[i3 + 1], cbuf[2] * P.c[i3 + 2])
        }
        P.mesh.setColorAt(i, col)
        dirtyC = true
      } else if (P.behave === 'smoke') {
        // billow out, and go by shrinking once it has done growing: solid
        // to the last pixel (see `banded`), each puff on its own clock so a
        // cloud breaks up into lumps rather than dwindling as one
        const g = P.grow[i]
        k = 1 + (g - 1) * (1 - (1 - t) ** 2)
        if (age < 0.1) k *= 0.4 + 0.6 * (age / 0.1)
        const f0 = P.fadeAt[i]
        if (P.alpha) {
          // a sprite keeps growing and thins through its blend instead
          // (true transparency, so no dither and no hole), darkening as it
          // climbs away from the fire that lit it (masonry dust was never
          // lit by a fire, and only dims a little as it spreads)
          const a = t < f0 ? Math.min(1, age / 0.08) : Math.max(0, 1 - (t - f0) / (1 - f0))
          P.alpha.setX(i, P === dust ? a * 0.6 : a)
          const dk = P === dust ? 1 - 0.2 * t : 1 - 0.4 * t
          col.setRGB(P.c[i3] * dk, P.c[i3 + 1] * dk, P.c[i3 + 2] * dk)
          P.mesh.setColorAt(i, col)
          dirtyC = true
        } else if (t > f0) k *= 1 - ((t - f0) / (1 - f0)) ** 1.6
      } else if (P.behave === 'glow') {
        // swells fast, and its light dies away over its whole short life
        const g = P.grow[i]
        k = 1 + (g - 1) * (1 - (1 - Math.min(1, t * 4)) ** 2)
        const e = (1 - t) ** 1.5
        col.setRGB(P.c[i3] * e, P.c[i3 + 1] * e, P.c[i3 + 2] * e)
        P.mesh.setColorAt(i, col)
        dirtyC = true
      } else if (P.behave === 'fall') {
        if (t > 0.8) k = Math.max(0, 1 - (t - 0.8) / 0.2)
      } else if (P.behave === 'spark') {
        if (t > 0.6) k = Math.max(0, 1 - (t - 0.6) / 0.4)
      }
      if (P.behave !== 'fire' && P.behave !== 'glow' && !P.alpha && age <= h * 1.01) {
        col.setRGB(P.c[i3], P.c[i3 + 1], P.c[i3 + 2])
        P.mesh.setColorAt(i, col)
        dirtyC = true
      }
      if (P.behave === 'jet') {
        // a tongue of flame pointed along its flight, as long as it was born
        vdir.set(P.v[i3], P.v[i3 + 1], P.v[i3 + 2])
        const sp = vdir.length()
        if (sp > 1e-3) q.setFromUnitVectors(zAxis, vdir.multiplyScalar(1 / sp))
        scl.set(P.s[i3] * k, P.s[i3 + 1] * k, P.s[i3 + 2] * (0.4 + 0.6 * k))
      } else if (P.behave === 'spark') {
        // stretched along the velocity, a streak of light
        vdir.set(P.v[i3], P.v[i3 + 1], P.v[i3 + 2])
        const sp = vdir.length()
        if (sp > 1e-3) q.setFromUnitVectors(zAxis, vdir.multiplyScalar(1 / sp))
        scl.set(P.s[i3] * k, P.s[i3 + 1] * k, Math.max(0.2, sp * 0.045) * k)
      } else {
        P.ang[i] += P.rate[i] * h
        axis.set(P.ax[i3], P.ax[i3 + 1], P.ax[i3 + 2])
        q.setFromAxisAngle(axis, P.ang[i])
        scl.set(P.s[i3] * k, P.s[i3 + 1] * k, P.s[i3 + 2] * k)
      }
      m4.compose(pos, q, scl)
      P.mesh.setMatrixAt(i, m4)
    }
    P.hi = hi
    P.live = live
    // never fewer than one instance, and never hidden: a pool with nothing
    // in it still draws its first slot (collapsed to a point), so its
    // program is linked by whatever frame first draws the scene, which in
    // the game is a warm-up under the boot cover rather than the first
    // explosion. compileAsync alone is not enough: it links against the
    // lights as they stand at the call, and a pass that draws with any
    // other count links again
    P.mesh.count = Math.max(1, hi)
    P.mesh.instanceMatrix.needsUpdate = true
    if (dirtyC && P.mesh.instanceColor) P.mesh.instanceColor.needsUpdate = true
    if (P.alpha) P.alpha.needsUpdate = true
    if (P.twin) P.twin.count = P.mesh.count
  }

  return fx
}
