import * as THREE from 'three'
import { cellCenter, propMaterial } from './art'
import type { FakeLights } from '../render/pixelLook'

/*
  The sandbox's particles: fireballs, sparks, smoke, splinters, glass, melon
  and the scorch marks they leave. Everything that happens *to* a prop and is
  too small or too brief to be a rigid body is drawn here.

  It is built for the pixel look rather than against it. There are no soft
  sprites, no additive haze and no lights. A fireball is a cluster of chunky
  balls, solid and depth-writing, each shaded in three flat bands off how
  squarely it faces the lens (`bandedFire`), whose colour runs white-hot,
  yellow, orange and blood red in HDR, so the look's ACES and posterize turn
  it into flat shapes of flame with a hot heart and a deep rind, and it
  shrinks away rather than thinning; smoke is the same balls, lit, in grey,
  swelling and rising and dissolving through a dither; sparks are thin boxes
  stretched along their velocity. The flash is a light in the look's fake
  light pass plus a few small white-hot balls at the heart, not a sphere of
  light the size of a room. All of it is opaque, which is also what keeps
  the look's alpha-is-a-hole rule happy.

  Cost. Four instanced meshes (bits and puffs share the props' own atlas
  material, fire and sparks share one unlit `MeshBasicMaterial`) and a small
  pool of decal meshes (two materials, one program between them). That is
  three new programs for every effect in the sandbox, all created with the
  sandbox and compiled under the boot cover with it, because they hang in the
  scene from the start with nothing to draw. No particle ever allocates: each
  pool is a fixed ring of slots in typed arrays, written straight into the
  instance matrices. Nothing casts a shadow.

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

type Behave = 'fall' | 'fire' | 'smoke' | 'spark'

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
  /** the share of its life after which it starts to dissolve */
  fadeAt: Float32Array
  /** how much of it is drawn, 0..1, dissolved by an ordered dither in the
      material (fire and smoke); null for pools that only shrink */
  fade: THREE.InstancedBufferAttribute | null
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
  const fade = geo.getAttribute('aFade') as THREE.InstancedBufferAttribute | undefined
  if (fade) fade.setUsage(THREE.DynamicDrawUsage)
  return {
    mesh, cap, behave, next: 0, hi: 0, live: 0, fade: fade ?? null,
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

/** give a pool geometry a per-instance dissolve, all drawn */
const withFade = (g: THREE.BufferGeometry, cap: number) => {
  g.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1))
  return g
}

/*
  Smoke dissolves rather than fades. Nothing here may be translucent
  (the look reads alpha under one as a hole in the canvas), so a puff thins
  out through a 4x4 ordered dither on gl_FragCoord: in the look's low-res
  target that is a pattern of whole art pixels, the same Bayer grain the
  posterize uses, so smoke comes apart the way pixel-art smoke is drawn.
  It also leaves the depth buffer alone and draws after everything opaque:
  the look outlines whatever depth says is in front, and an outlined puff is
  a boulder, while an unoutlined one is air. (Fire used to dissolve the same
  way; see `bandedFire` for why it stopped.)
*/
const ditherFade = <M extends THREE.Material>(m: M, key: string): M => {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'attribute float aFade;\nvarying float vFade;\nvoid main() {\n  vFade = aFade;')
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', [
      'varying float vFade;',
      'float fxBayer(vec2 p) {',
      '  ivec2 q = ivec2(mod(p, 4.0));',
      '  int i = q.x + q.y * 4;',
      '  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);',
      '  return (float(b[i]) + 0.5) / 16.0;',
      '}',
      'void main() {',
      '  if (vFade < fxBayer(gl_FragCoord.xy)) discard;',
    ].join('\n'))
  }
  m.customProgramCacheKey = () => key
  m.depthWrite = false
  return m
}

/*
  Fire is opaque and banded. The first version dissolved its fireballs
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
*/
const bandedFire = <M extends THREE.Material>(m: M, key: string): M => {
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
        'outgoingLight *= fxF > 0.8 ? 1.75 : (fxF > 0.45 ? 1.0 : 0.62);',
        '#include <opaque_fragment>',
      ].join('\n'))
  }
  m.customProgramCacheKey = () => key
  return m
}

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
  const fireMat = bandedFire(new THREE.MeshBasicMaterial({ color: 0xffffff }), 'sandbox-fire')
  fireMat.name = 'sandbox-fire'
  const smokeMat = ditherFade(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'sandbox-smoke')
  smokeMat.name = 'sandbox-smoke'

  const CAP = { bits: 700, puffs: 480, fire: 300, sparks: 260, dust: 520 }
  const ico0 = withFade(new THREE.IcosahedronGeometry(1, 1), CAP.puffs)
  const ico1 = new THREE.IcosahedronGeometry(1, 2)
  const cube = pinnedUV(new THREE.BoxGeometry(1, 1, 1), whiteUV[0], whiteUV[1])
  const spark = new THREE.BoxGeometry(1, 1, 1)
  const ico2 = new THREE.IcosahedronGeometry(1, 1)

  const bits = pool(cube, litMat, CAP.bits, 'fall')
  const puffs = pool(ico0, smokeMat, CAP.puffs, 'smoke')
  const fire = pool(ico1, fireMat, CAP.fire, 'fire')
  const sparks = pool(spark, fireMat, CAP.sparks, 'spark')
  // masonry dust: the fire's banded unlit material (so no new program) in
  // earth colours. Lit, a billow is a ball with a bright top and a dark
  // underside, and at this resolution that reads as a boulder; banded flat
  // off the lens, a crowd of them overlapping in two tones reads as a cloud.
  // Like the fire, a billow shrinks away rather than thinning
  const dust = pool(ico2, fireMat, CAP.dust, 'smoke')
  // air last: after everything solid, the fire over its own smoke
  puffs.mesh.renderOrder = 10
  fire.mesh.renderOrder = 11
  sparks.mesh.renderOrder = 11
  dust.mesh.renderOrder = 10
  const pools = [bits, puffs, fire, sparks, dust]
  for (const p of pools) root.add(p.mesh)

  /* decals: a small ring of flat quads, two materials, one program */
  const mkDecalMat = (tex: THREE.Texture) => {
    const m = new THREE.MeshBasicMaterial({
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
    if (P.fade) P.fade.setX(i, 1)
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
      // the heart: a few white-hot balls at the centre that swell for a
      // tenth of a second and are gone. (It was one ball a fifth of the
      // radius across at flash brightness, which through the look was a flat
      // cream disc over half the frame: a flash reads from the light it
      // throws on the street, not from a sphere of it)
      for (let i = 0; i < 3; i++) {
        dir(0.2, d3)
        const s = rnd(0.9, 1.3) * k
        emit(fire, at.x + d3[0] * 0.4, at.y + 0.7 + d3[1] * 0.4, at.z + d3[2] * 0.4, d3[0] * 3, d3[1] * 3 + 2, d3[2] * 3,
          rnd(0.18, 0.26), s, s, s, 1.5, 1.45, 1.4, { grow: 2.4, drag: 6 })
      }
      // the fireball: a cluster of blobs thrown out and dragged to a stop
      const blobs = Math.round(14 + 7 * k)
      for (let i = 0; i < blobs; i++) {
        dir(0.05, d3)
        const sp = rnd(5, 14) * k
        const s = rnd(0.8, 1.5) * k
        // the outer blobs run cooler than the core: an orange rind round a
        // white-hot heart is what makes a fireball read as a ball
        const hot = i < 6 ? 1.05 : rnd(0.6, 0.85)
        emit(fire, at.x + d3[0] * 0.6, at.y + 0.6 + d3[1] * 0.6, at.z + d3[2] * 0.6,
          d3[0] * sp, d3[1] * sp + rnd(3, 7), d3[2] * sp, rnd(0.45, 0.85), s, s, s, hot, hot * 0.92, hot * 0.85,
          { grow: rnd(1.5, 2.0), drag: 4.5, delay: i < 5 ? 0 : rnd(0, 0.07) })
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
      // smoke rolling up out of the fire as it dies
      for (let i = 0; i < 10; i++) {
        dir(0.5, d3)
        const s = rnd(0.8, 1.4) * k
        const g = rnd(0.09, 0.18)
        emit(puffs, at.x + d3[0] * R * 0.12, at.y + 0.8 + d3[1] * 1.5, at.z + d3[2] * R * 0.12,
          d3[0] * 3, rnd(3, 7), d3[2] * 3, rnd(1.6, 2.6), s, s, s, g, g * 0.94, g * 0.88,
          { delay: rnd(0.12, 0.45), grow: rnd(1.5, 1.9), drag: 0.9, spin: 1.2 })
      }
      // a dust ring racing out along the ground
      const gy = ground(at.x, at.z)
      if (at.y - gy < 3) {
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2 + rnd(-0.1, 0.1)
          const sp = rnd(16, 24) * k
          const s = rnd(0.5, 0.85)
          emit(puffs, at.x + Math.cos(a), gy + 0.4, at.z + Math.sin(a), Math.cos(a) * sp, rnd(0.5, 2), Math.sin(a) * sp,
            rnd(0.6, 0.9), s, s, s, 0.36, 0.32, 0.26, { grow: 1.9, drag: 3.2, spin: 2, fadeAt: 0.05 })
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
            d3[0] * 1.2, rnd(-1.4, -0.4), d3[2] * 1.2, rnd(1.6, 2.4), s, s, s, 0.34, 0.29, 0.22,
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
          rnd(0.25, 0.45), s, s, s, 1, 1, 1, { grow: 1.3, drag: 0.5 })
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
      // many small billows rather than a few big ones, in two tones of the
      // wall's own colour pulled toward a warm grey, hugging the ground and
      // rolling outward the way a collapse pushes its dust ahead of it
      // small and many: banded and outlined, a big billow is a boulder
      const n = Math.min(24, 6 + Math.round(size * 1.6))
      const sz = Math.min(0.85, 0.35 + size * 0.05)
      // the banded material lifts a billow's middle by 1.75: kept under it
      const r = r0 * 0.3 + 0.07
      const g = g0 * 0.3 + 0.066
      const b = b0 * 0.3 + 0.056
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const out = rnd(3, 9) * Math.min(1.8, 0.6 + size * 0.08)
        const s = rnd(0.6, 1.3) * sz
        // a darker core low down, paler billows over it
        const k = i % 3 === 0 ? rnd(0.62, 0.72) : rnd(0.92, 1.08)
        emit(dust, at.x + Math.cos(a) * size * 0.25, at.y + rnd(-0.3, 0.8) + (k > 0.8 ? 0.6 : 0), at.z + Math.sin(a) * size * 0.25,
          Math.cos(a) * out, rnd(0.2, 1.8), Math.sin(a) * out, rnd(1.6, 3.4), s, s * rnd(0.7, 1), s,
          r * k, g * k, b * k,
          { delay: rnd(0, 0.3), grow: rnd(1.6, 2.2), drag: 1.5, spin: 0.8, fadeAt: 0.12 })
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
      const f = lights.flash
      if (flash.t < 1.4) {
        // a blink of white-hot, then the fireball's orange, falling away
        const t = flash.t
        const blink = Math.max(0, 1 - t / 0.09)
        const glow = Math.exp(-t * 2.6) * (0.85 + 0.15 * Math.sin(t * 60))
        // (by day the street is already lit, so this is a warm lift on what
        // is round the blast, not a white-out; the look also draws a third
        // of the radius as lit air, which at the old gain was the frame)
        const g = flash.power * (1.3 * blink + 1.05 * glow)
        f.pos.set(flash.x, flash.y, flash.z)
        f.radius = flash.r * (0.75 + 0.25 * Math.min(1, t * 8))
        f.color.setRGB(g * 1.0, g * (0.5 + 0.3 * blink), g * (0.16 + 0.4 * blink))
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
      ico0.dispose(); ico1.dispose(); ico2.dispose(); cube.dispose(); spark.dispose()
      smokeMat.dispose()
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
      else P.v[i3 + 1] = P.v[i3 + 1] * drag + (P.behave === 'fire' ? 1.5 : 0.6) * h
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
      let fade = 1
      if (P.behave === 'fire') {
        // swell fast and hold while it cools, then shrink away solid (never
        // thinned: see bandedFire), going out at a deep red rather than
        // cooling all the way to soot, which is the smoke's job
        const g = P.grow[i]
        k = 1 + (g - 1) * (1 - (1 - Math.min(1, t * 3)) ** 3)
        const f0 = P.fadeAt[i]
        if (t > f0) k *= 1 - ((t - f0) / (1 - f0)) ** 2
        ramp(t * 0.62, cbuf, 0)
        col.setRGB(cbuf[0] * P.c[i3], cbuf[1] * P.c[i3 + 1], cbuf[2] * P.c[i3 + 2])
        P.mesh.setColorAt(i, col)
        dirtyC = true
      } else if (P.behave === 'smoke') {
        // billow out, and thin from the moment it stops growing
        const g = P.grow[i]
        k = 1 + (g - 1) * (1 - (1 - t) ** 2)
        if (age < 0.1) k *= 0.4 + 0.6 * (age / 0.1)
        const f0 = P.fadeAt[i]
        fade = t < f0 ? 1 : Math.max(0, 1 - (t - f0) / (1 - f0)) ** 0.8
        // a pool that cannot dither (the dust, on the fire's material)
        // shrinks out instead
        if (!P.fade && t > 0.55) k *= Math.max(0, 1 - (t - 0.55) / 0.45) ** 0.7
      } else if (P.behave === 'fall') {
        if (t > 0.8) k = Math.max(0, 1 - (t - 0.8) / 0.2)
      } else if (P.behave === 'spark') {
        if (t > 0.6) k = Math.max(0, 1 - (t - 0.6) / 0.4)
      }
      if (P.behave !== 'fire' && age <= h * 1.01) {
        col.setRGB(P.c[i3], P.c[i3 + 1], P.c[i3 + 2])
        P.mesh.setColorAt(i, col)
        dirtyC = true
      }
      if (P.behave === 'spark') {
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
      if (P.fade) P.fade.setX(i, fade)
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
    if (P.fade) P.fade.needsUpdate = true
    if (dirtyC && P.mesh.instanceColor) P.mesh.instanceColor.needsUpdate = true
  }

  return fx
}
