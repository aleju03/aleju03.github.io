import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { GLOW_ALPHA } from '../../render/pixelLook'

/*
  What the physgun's beam looks like: the curved blue energy from the muzzle
  to the grab point, a glow where it bites, a flare at the gun, a cyan rim on
  the thing it holds, and the blue flash of a freeze.

  It draws from numbers, never from the physgun: a muzzle, a far end, the
  point the beam is pulling toward, and a strain. So the same object draws
  the local player's beam from the live physgun and a remote player's from a
  `HoldRecord` off the wire (`fromRecord` below fills the frame from one),
  which is the multiplayer half of this piece: S6 only has to supply the
  numbers.

  **The curve** is GMod's: one quadratic Bezier from the muzzle to the grab
  point, its control point half the beam's length out along the barrel. In
  first person the gun is aimed at the beam's *target* (the spot on your
  view ray where the held thing is being pulled; viewmodel.ts), so while
  the thing is where the beam wants it the beam is a straight line; while
  it lags a swing, the beam still leaves along the barrel toward where you
  are aiming and bows smoothly over onto the prop, deeper the harder you
  swing something heavy. In third person the gun is held lower than the aim,
  so the beam always arcs up out of it. The departure is bounded twice, in
  the world (MAX_BEND) and as drawn (MAX_BEND_SCREEN, bisected against the
  camera), because a block dragged far off the aim otherwise turns the bow
  into a hairpin, and the muzzle is so close to the first-person lens that a
  modest bend in the world is a right angle on screen. A quadratic has no corner and no
  inflection anywhere, which matters: the round-2 cubic ran *through* the
  target and turned there, and a heavy block trailing a swing drew a hard
  V at the crosshair. Sixty-four sections keep it smooth at the look's
  resolution. There is no lateral wobble: a zigzag reads as a scribble
  through the pixel look, not as energy.

  **Colour through the look.** The look owns ACES, a chroma cap and a hue
  pull, so an additive HDR blue saturates to white long before it reads as
  cyan (the first cut of this beam was a thin white squiggle), and even a
  well-chosen cyan was greyed by the grade to the sky's own pastel. So the
  ribbon itself is opaque where it draws: three stepped tones (a hot core, a
  cyan band, a deeper rim the look's silhouette line darkens once more),
  depth written so the air pass hazes it by its own distance and not by the
  sky's, and the look's glow code (`GLOW_ALPHA`) written into alpha so the
  grade pass leaves its colour out of the baked grade. Around it, a second
  wider copy, the blobs and the rim are premultiplied glows that light what
  is behind them and keep the target's alpha exactly as the scene wrote it
  (alpha ZERO / ONE), so a glow swept across the AlejOS screen's glass hole
  does not paint the hole shut.

  **Width in pixels, and only pixels.** GMod's beam is a thin bright core of
  the same width all the way out, so this one is sized in pixels of the
  look's internal target and nothing else: a one-pixel white-hot core, a
  pixel of cyan either side, and a tight transparent glow a few pixels out
  (the same ribbon drawn again, wider). The ribbon (65 sections rewritten in
  place) is expanded toward the camera in the vertex shader by that pixel
  width at its own depth. A world-sized width made the first cut a fat spike
  at the muzzle, three metres from the lens, and a smear round the gun.

  **The rim** is an inverted hull: each mesh of the held prop gets a
  back-face copy pushed outward (per axis, off its own bounding box, so a
  box grows into a box and a barrel into a barrel with no gaps at the flat
  shading's split corners), which only shows where it sticks out past the
  silhouette. That is GMod's cyan outline, and unlike a fresnel fill it never
  washes the prop's own colours out. A freeze is the same outline pulsing:
  it swells to three pixels, goes white-hot and rings twice back down over
  half a second, with only a faint glaze of light over the prop itself, so
  the thing you froze never stops looking like itself (the first cut
  filled it pale blue, and for three frames it read as the prop vanishing).

  **Programs.** Five: the ribbon, its glow (the same shader, blended
  differently), the glow blob (every sprite shares it), the rim and the flash
  fill. The per-mesh shells are clones of the last two, so they share their
  programs. All are built at construction and put in front
  of the camera by `stage()` for the boot cover's compile and first draw, so
  the first grab links nothing (the film prints the count, and it is 0).
*/

const SEGS = 64
/** where the curve's control point sits toward the target, as a share of
    the beam's length: the deeper, the bigger the bow when the prop trails */
const BOW = 0.5
/** the most the beam may leave the muzzle off the straight line to the grab
    point, radians: the bow's depth, and the limit that keeps it a bow */
const MAX_BEND = 0.5
/** ...and the most it may leave the muzzle off that line as drawn, radians */
const MAX_BEND_SCREEN = 0.6
const aspectOf = (c: THREE.Camera) => {
  const p = c as THREE.PerspectiveCamera
  return p.isPerspectiveCamera ? 1 / p.aspect : 1
}
const PTS = SEGS + 1
/** narrowest the glow may draw, in pixels of the look's internal target
    (half-width) */
const MIN_PX = 1.3
/** narrowest a rim may be, in pixels */
const RIM_PX = 1.2

/** the beam's colours, linear, before the look's exposure and ACES */
const BAND = new THREE.Color(0.015, 0.55, 1.3)
const CORE = new THREE.Color(0.9, 2.2, 2.6)
const HALO = new THREE.Color(0.05, 0.85, 1.6)
/** the freeze: a deeper, whiter blue */
const FLASH = new THREE.Color(0.6, 1.8, 2.6)

/* ------------------------------------------------------------ shaders -- */

const RIBBON_VERT = /* glsl */ `
attribute vec3 aTan;
attribute float aSide;
attribute float aT;
uniform float uW0;
uniform float uW1;
uniform float uPx;
uniform float uMinPx;
uniform float uWide;
varying float vS;
varying float vT;
varying float vPx;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 tv = (modelViewMatrix * vec4(aTan, 0.0)).xyz;
  vec3 side = cross(tv, normalize(-mv.xyz));
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
  float px = uPx * max(0.05, -mv.z);
  float hw = max(mix(uW0, uW1, aT), px * uMinPx) * uWide;
  mv.xyz += side * aSide * hw;
  gl_Position = projectionMatrix * mv;
  vS = aSide;
  vT = aT;
  // how many pixels wide the half-ribbon is here, so the core can be kept
  // at least a pixel across however thin the whole thing gets
  vPx = hw / max(px * uWide, 1e-6);
}
`

const RIBBON_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLen;
uniform float uAmount;
uniform float uStrain;
uniform float uMiss;
uniform vec3 uBand;
uniform vec3 uCore;
uniform float uWide;
uniform float uGlowA;
varying float vS;
varying float vT;
varying float vPx;
float hash(float n) { return fract(sin(n) * 43758.5453); }
float vnoise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}
void main() {
  float s = abs(vS) * uWide;
  float along = vT * uLen;
  // energy travelling from the gun to the target: bright packets ride the
  // core out to the grab point, a slow shimmer under them
  float n = vnoise(along * 0.9 - uTime * 14.0) * 0.55 + vnoise(along * 3.3 - uTime * 37.0 + 7.3) * 0.45;
  float packet = pow(max(0.0, sin(along * 1.3 - uTime * 26.0)), 6.0);
  if (uWide > 1.0) {
    // the glow: a second, wider copy of the ribbon drawn round the first,
    // tight and faint, lighting what is behind it rather than covering it,
    // with sparks crackling in it (single hot pixels that live a few frames)
    if (s < 1.0) discard;
    float g = pow(max(0.0, 1.0 - s / uWide), 2.2) * (0.5 + 0.25 * n + 0.35 * packet) * uAmount * (1.0 - uMiss * 0.5);
    float cell = floor(along * 2.6 + vS * 2.0);
    float spark = step(0.93, hash(cell * 17.3 + floor(uTime * 20.0) * 3.1)) * step(s, uWide * 0.6) * uAmount;
    if (g < 0.03 && spark < 0.5) discard;
    gl_FragColor = spark > 0.5 ? vec4(uCore * 0.9, 1.0) : vec4(uBand * 1.3 * g, g * 0.35);
    return;
  }
  // the ribbon: a white-hot core a pixel wide with a pixel of cyan either
  // side. A miss is the core alone, flickering
  float core = step(s, 0.42 + 0.2 * packet);
  float hot = (0.85 + 0.25 * n + 0.6 * packet) * (1.0 + uStrain * 0.3);
  vec3 col = mix(uBand * (0.9 + 0.3 * n + 0.5 * packet), uCore * hot, core);
  float a = mix(1.0, core, uMiss) * uAmount;
  if (a < 0.5) discard;
  // the look's glow code in alpha: solid, and left out of the baked grade
  gl_FragColor = vec4(col, uGlowA);
}
`

const BLOB_VERT = /* glsl */ `
uniform float uSize;
uniform float uPx;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float size = max(uSize, uPx * max(0.05, -mv.z));
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0;
}
`

const BLOB_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uAmount;
uniform float uRing;
uniform float uStar;
uniform float uSpin;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  if (uStar > 0.0) {
    // a sparkle: four long hard rays and four short diagonal ones that
    // flicker, round a hot centre, turning; no soft cloud
    float c = cos(uSpin), sn = sin(uSpin);
    vec2 q = abs(vec2(c * vUv.x - sn * vUv.y, sn * vUv.x + c * vUv.y));
    float ray = max(step(q.y, 0.09) * step(q.x, 1.0 - r * 0.2), step(q.x, 0.09) * step(q.y, 0.8));
    vec2 d = vec2(q.x + q.y, abs(q.x - q.y)) * 0.7071;
    float flick = 0.35 + 0.25 * sin(uSpin * 7.0);
    ray = max(ray, step(d.y, 0.08) * step(d.x, flick));
    float centre = step(r, 0.18);
    float a = max(ray * (1.0 - r), centre) * uAmount * uStar;
    if (a < 0.2) discard;
    gl_FragColor = vec4(mix(uColor, uHot, max(centre, 1.0 - r)) * a, a);
    return;
  }
  // a white-hot disc inside a cyan glow, stepped rather than smooth so it
  // reads as a pixel-art flare, plus an optional ring (the freeze pop)
  float glow = pow(1.0 - r, 1.6);
  float hot = 1.0 - smoothstep(0.22, 0.34, r);
  float ring = uRing > 0.0 ? (1.0 - smoothstep(0.0, 0.1, abs(r - uRing))) * (1.0 - uRing) : 0.0;
  vec3 col = mix(uColor, uHot, max(hot, ring));
  float a = min(1.0, max(max(glow * 0.9, hot), ring) * uAmount);
  if (a < 0.01) discard;
  // lights more than it covers, so blue over a brown crate is a brighter
  // crate with a blue bloom on it, not a purple one
  gl_FragColor = vec4(col * a, a * mix(0.5, 1.0, hot));
}
`

// the shells: pushed out per axis off the mesh's own box, so a flat-shaded
// box grows into a bigger box rather than six plates with gaps between
const SHELL_VERT = /* glsl */ `
uniform vec3 uCenter;
uniform vec3 uHalf;
uniform float uGrow;
uniform float uPx;
varying float vRim;
void main() {
  vec3 d = clamp((position - uCenter) / max(uHalf, vec3(1e-3)), -1.0, 1.0);
  vec4 c = modelViewMatrix * vec4(uCenter, 1.0);
  // the grow is at least a few pixels at the prop's own distance, in world
  // units of the mesh (its scale is divided back out)
  float s = length((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  float grow = max(uGrow, uPx * max(0.05, -c.z)) / max(s, 1e-4);
  vec3 p = position + d * grow;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`

const SHELL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
uniform float uFill;
uniform float uCover;
uniform float uSolid;
uniform float uGlowA;
varying float vRim;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  float a = min(1.0, (uFill + (1.0 - uFill) * vRim * vRim) * uAmount);
  if (uSolid > 0.5) {
    // the outline: a solid pixel line in the look's glow code (so the grade
    // leaves its cyan alone), faded by an ordered dither rather than by
    // blending, which keeps every pixel of it crisp
    ivec2 p = ivec2(gl_FragCoord.xy) & 3;
    if (a < (BAYER[p.y * 4 + p.x] + 0.5) / 16.0) discard;
    gl_FragColor = vec4(uColor, uGlowA);
    return;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * a, a * uCover);
}
`

/** premultiplied: a fragment adds its colour and takes away `alpha` of what
    is behind, so a glow can light the scene (alpha under its coverage) or
    cover it (alpha 1). The target's own alpha is left exactly as the scene
    wrote it, so the look's glass holes survive a beam across them */
const over = <M extends THREE.Material>(m: M): M => {
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.OneMinusSrcAlphaFactor
  m.blendEquationAlpha = THREE.AddEquation
  m.blendSrcAlpha = THREE.ZeroFactor
  m.blendDstAlpha = THREE.OneFactor
  m.transparent = true
  m.depthWrite = false
  return m
}

const blobMaterial = (color: THREE.Color, hot: THREE.Color) =>
  over(new THREE.ShaderMaterial({
    vertexShader: BLOB_VERT,
    fragmentShader: BLOB_FRAG,
    uniforms: {
      uColor: { value: color.clone() },
      uHot: { value: hot.clone() },
      uAmount: { value: 0 },
      uSize: { value: 0.5 },
      uPx: { value: 0.01 },
      uRing: { value: 0 },
      uStar: { value: 0 },
      uSpin: { value: 0 },
    },
  }))

const shellMaterial = (side: THREE.Side) =>
  over(new THREE.ShaderMaterial({
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    side,
    uniforms: {
      uColor: { value: HALO.clone() },
      uAmount: { value: 0 },
      uFill: { value: 1 },
      uCover: { value: 1 },
      uSolid: { value: 0 },
      uGlowA: { value: GLOW_ALPHA },
      uGrow: { value: 0.03 },
      uPx: { value: 0.01 },
      uCenter: { value: new THREE.Vector3() },
      uHalf: { value: new THREE.Vector3(1, 1, 1) },
    },
  }))

/** world size of one internal pixel at unit depth */
export const pixelAtUnit = (fovDeg: number, lines: number) =>
  (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)) / Math.max(60, lines)

export interface BeamFrame {
  /** where the beam leaves the gun */
  muzzle: THREE.Vector3
  /** the barrel's forward, unit: the curve leaves along it (bounded, see
      MAX_BEND) */
  forward: THREE.Vector3
  /** the far end: the grab point (hold) or the surface hit (miss) */
  end: THREE.Vector3
  /** where the beam is pulling the grab point to (hold); the bow bends
      through it. Ignored on a miss */
  target: THREE.Vector3
  /** 'hold', 'miss' or 'off' */
  mode: 'hold' | 'miss' | 'off'
  strain: number
  dt: number
  /** the look's internal lines and the camera's vertical fov (degrees), for
      the minimum pixel widths */
  lines: number
  fov: number
  camera: THREE.Camera
}

export interface Beam {
  readonly root: THREE.Group
  /** draw this frame's beam */
  update: (f: BeamFrame) => void
  /** outline a prop as held (eased on and off), by its mesh */
  holdHalo: (mesh: THREE.Object3D | null) => void
  /** the freeze pop, on whatever mesh (or only at a point, for a limb) */
  flash: (mesh: THREE.Object3D | null, at: THREE.Vector3, k?: number) => void
  /** a grab or release crackle at both ends: a brief brightening */
  kick: (k: number) => void
  /** every rim and flash off at once, with no fade (a holster) */
  clear: () => void
  /** put every part in front of a camera for a covered compile and draw */
  stage: (camera: THREE.Camera) => void
  /** ...and back to normal */
  unstage: () => void
  dispose: () => void
}

interface Shell {
  rim: THREE.Mesh[]
  fill: THREE.Mesh[]
  rimMats: THREE.ShaderMaterial[]
  fillMats: THREE.ShaderMaterial[]
}

export function createBeam(parent: THREE.Object3D): Beam {
  const root = new THREE.Group()
  root.name = 'physgun-beam'
  root.userData.dynamic = true
  parent.add(root)

  /* ------------------------------------------------------- the ribbon -- */
  const pos = new Float32Array(PTS * 2 * 3)
  const tan = new Float32Array(PTS * 2 * 3)
  const side = new Float32Array(PTS * 2)
  const at = new Float32Array(PTS * 2)
  const index: number[] = []
  for (let i = 0; i < PTS; i++) {
    side[i * 2] = -1
    side[i * 2 + 1] = 1
    at[i * 2] = at[i * 2 + 1] = i / SEGS
    if (i < SEGS) {
      const a = i * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)
  const tanAttr = new THREE.BufferAttribute(tan, 3).setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('position', posAttr)
  geo.setAttribute('aTan', tanAttr)
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  geo.setAttribute('aT', new THREE.BufferAttribute(at, 1))
  geo.setIndex(index)
  const mat = over(new THREE.ShaderMaterial({
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    uniforms: {
      uW0: { value: 0.1 },
      uW1: { value: 0.07 },
      uPx: { value: 0.002 },
      uMinPx: { value: MIN_PX },
      uWide: { value: 1 },
      uGlowA: { value: GLOW_ALPHA },
      uTime: { value: 0 },
      uLen: { value: 1 },
      uAmount: { value: 1 },
      uStrain: { value: 0 },
      uMiss: { value: 0 },
      uBand: { value: BAND.clone() },
      uCore: { value: CORE.clone() },
    },
  }))
  // the ribbon is opaque where it draws and writes depth: the look hazes
  // every pixel by the depth under it, so a beam that left the depth to the
  // sky behind it was washed to the sky's own grey-white
  mat.depthWrite = true
  mat.transparent = false
  // and it writes the look's glow code into alpha rather than keeping the
  // scene's, so the grade pass leaves its cyan alone (pixelLook's GLOW_ALPHA)
  mat.blendSrcAlpha = THREE.OneFactor
  mat.blendDstAlpha = THREE.ZeroFactor
  const ribbon = new THREE.Mesh(geo, mat)
  ribbon.frustumCulled = false
  ribbon.renderOrder = 5
  ribbon.visible = false
  root.add(ribbon)
  const u = mat.uniforms
  // the glow round it: the same geometry and program, wider, transparent
  const glowMat = over(mat.clone())
  const gu = glowMat.uniforms
  gu.uWide.value = 2.4
  const glow = new THREE.Mesh(geo, glowMat)
  glow.frustumCulled = false
  glow.renderOrder = 5
  glow.visible = false
  root.add(glow)

  /* -------------------------------------------------------- the blobs -- */
  // one quad, billboarded in the vertex shader; every blob shares its program
  const quad = new THREE.PlaneGeometry(1, 1)
  const blob = (c: THREE.Color, hot: THREE.Color, order = 6) => {
    const m = new THREE.Mesh(quad, blobMaterial(c, hot))
    m.frustumCulled = false
    m.visible = false
    m.renderOrder = order
    root.add(m)
    return m
  }
  const WHITE = new THREE.Color(1.6, 2.6, 3.2)
  const endGlow = blob(HALO, WHITE)
  const muzzleGlow = blob(HALO, WHITE, 7)
  const pop = blob(FLASH, WHITE, 7)
  const endU = (endGlow.material as THREE.ShaderMaterial).uniforms
  const muzU = (muzzleGlow.material as THREE.ShaderMaterial).uniforms
  // the muzzle star sits on the first-person gun, whose depth is squeezed
  // to the front of the range (viewmodel.ts): tested against that it is
  // always behind the gun it is drawn on, so it is not depth tested
  ;(muzzleGlow.material as THREE.Material).depthTest = false
  const popU = (pop.material as THREE.ShaderMaterial).uniforms

  /* -------------------------------------------------------- the shells -- */
  const rimBase = shellMaterial(THREE.BackSide)
  // the rim is solid and writes the glow code into alpha (see SHELL_FRAG)
  rimBase.uniforms.uSolid.value = 1
  rimBase.blendSrcAlpha = THREE.OneFactor
  rimBase.blendDstAlpha = THREE.ZeroFactor
  const fillBase = shellMaterial(THREE.FrontSide)
  fillBase.uniforms.uColor.value.copy(FLASH)
  const box = new THREE.Box3()
  /** one pair of shells per prop mesh, built on its first grab and kept.
      Clones of the base materials: their own uniforms, the same programs */
  const shells = new WeakMap<THREE.Object3D, Shell>()
  /** a mesh's convex hull, per geometry: the shells wrap the hull, because
      an inverted hull round a concave mesh (a crate's proud slats) draws a
      line along every slat as well as round the outside */
  const hulls = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()
  const hullOf = (g: THREE.BufferGeometry) => {
    let h = hulls.get(g)
    if (h) return h
    const a = g.getAttribute('position')
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < a.count; i++) pts.push(new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)))
    try {
      h = pts.length >= 4 ? new ConvexGeometry(pts) : g
    } catch {
      h = g
    }
    hulls.set(g, h)
    return h
  }
  const shellOf = (m: THREE.Object3D): Shell => {
    let s = shells.get(m)
    if (s) return s
    const rimMat = rimBase.clone()
    const fillMat = fillBase.clone()
    s = { rim: [], fill: [], rimMats: [], fillMats: [] }
    // a prop drawn by the batch is a proxy that draws nothing itself but
    // carries its shape's geometry (`batch.ts`); anything else, its meshes
    const meshes: Array<{ at: THREE.Object3D; geo: THREE.BufferGeometry }> = []
    m.traverse((o) => {
      if (o.userData.halo) return
      const px = o as THREE.Object3D & { isBatchProxy?: boolean; geo?: THREE.BufferGeometry | null }
      if (px.isBatchProxy && px.geo) meshes.push({ at: o, geo: px.geo })
      else if ((o as THREE.Mesh).isMesh) meshes.push({ at: o, geo: (o as THREE.Mesh).geometry })
    })
    for (const { at: mm, geo } of meshes) {
      const g = hullOf(geo)
      if (!g.boundingBox) g.computeBoundingBox()
      box.copy(g.boundingBox!)
      // each mesh its own box: the clone's uniforms are per shell, so a
      // compound prop's parts are cloned per part
      const rm = meshes.length > 1 ? rimMat.clone() : rimMat
      const fm = meshes.length > 1 ? fillMat.clone() : fillMat
      for (const mt of [rm, fm]) {
        box.getCenter(mt.uniforms.uCenter.value)
        box.getSize(mt.uniforms.uHalf.value).multiplyScalar(0.5)
      }
      s.rimMats.push(rm)
      s.fillMats.push(fm)
      for (const [list, mt] of [[s.rim, rm], [s.fill, fm]] as const) {
        const h = new THREE.Mesh(g, mt)
        h.userData.halo = true
        h.visible = false
        h.castShadow = false
        h.receiveShadow = false
        h.frustumCulled = false
        h.renderOrder = 4
        mm.add(h)
        list.push(h)
      }
    }
    shells.set(m, s)
    return s
  }
  const shellMats = (s: Shell, which: 'rim' | 'fill') => (which === 'rim' ? s.rimMats : s.fillMats)
  /** the warm-up's own shells: a box the shell programs compile on */
  const warmGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3)
  const warmRim = new THREE.Mesh(warmGeo, rimBase)
  const warmFill = new THREE.Mesh(warmGeo, fillBase)
  for (const w of [warmRim, warmFill]) {
    w.visible = false
    w.frustumCulled = false
    root.add(w)
  }

  /* ------------------------------------------------------ the curve -- */
  const ctrl = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  const dirK = new THREE.Vector3()
  const s0 = new THREE.Vector3()
  const s1 = new THREE.Vector3()
  const s2 = new THREE.Vector3()
  const ctrlVel = new THREE.Vector3()
  const ctrlGoal = new THREE.Vector3()
  let ctrlFresh = true
  const p = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  let time = 0
  let amount = 0
  let kickK = 0
  let lastMode: BeamFrame['mode'] = 'off'
  let px = 0.004

  let haloOn: THREE.Object3D | null = null
  let haloOff: THREE.Object3D | null = null
  let haloK = 0
  let haloOffK = 0
  let flashOn: THREE.Object3D | null = null
  const popAt = new THREE.Vector3()
  let flashT = 1
  let flashK = 1

  const setShell = (m: THREE.Object3D | null, which: 'rim' | 'fill', on: boolean) => {
    if (!m) return
    const s = shellOf(m)
    for (const h of which === 'rim' ? s.rim : s.fill) h.visible = on
  }

  const update = (f: BeamFrame) => {
    const dt = Math.max(0, Math.min(0.1, f.dt))
    time += dt
    kickK = Math.max(0, kickK - dt * 5)
    px = pixelAtUnit(f.fov, f.lines)
    // fade in fast, out a touch slower; a miss is a fainter stub
    const want = f.mode === 'off' ? 0 : f.mode === 'miss' ? 0.8 : 1
    amount += (want - amount) * (1 - Math.exp(-dt * (want > amount ? 45 : 22)))
    if (f.mode !== 'off') lastMode = f.mode
    const live = amount > 0.02
    ribbon.visible = live
    glow.visible = live
    endGlow.visible = live
    muzzleGlow.visible = live
    if (live) {
      const miss = lastMode === 'miss'
      const L = Math.max(0.01, f.muzzle.distanceTo(f.end))
      // one smooth curve, a quadratic Bezier with no corner anywhere: out of
      // the muzzle toward a control point partway along the line to the
      // target (the barrel is aimed at the target, so the beam leaves along
      // the barrel), bowing over onto the grab point. On a miss the control
      // is the chord's middle and the beam is straight. The control is
      // sprung a little, so a fast turn whips the bow before it settles
      if (miss) ctrlGoal.addVectors(f.muzzle, f.end).multiplyScalar(0.5)
      else {
        // along the line to the target, half the beam's own length out: far
        // enough to leave along the barrel, near enough that a prop trailing
        // well off the aim bows the beam over rather than hooking it back
        // the direction it leaves in: toward the target, but never more than
        // MAX_BEND off the straight line to the grab point. A prop far off
        // the aim (a heavy block trailing a hard turn) otherwise pulls a
        // curve that leaves toward the crosshair into a hairpin back to the
        // prop; clamped, it is one wide bow however far it is dragged
        // the barrel's own forward, as GMod does it: in first person the
        // gun is aimed at the target so this is the aim; in third person it
        // is held lower than the aim, and the beam arcs up out of it
        tmp.copy(f.forward).normalize()
        tmp2.copy(f.end).sub(f.muzzle).multiplyScalar(1 / L)
        const ang = Math.acos(Math.min(1, Math.max(-1, tmp.dot(tmp2))))
        // and the limit is checked where it is seen: the muzzle is half a
        // unit from the lens, so a bend that is modest in the world can
        // still leave the gun at ninety degrees on screen. Bisect the
        // slerp from the chord toward the aim until the on-screen
        // departure is under MAX_BEND_SCREEN
        f.camera.updateMatrixWorld()
        s0.copy(f.muzzle).project(f.camera)
        s2.copy(f.end).project(f.camera)
        const cx = s2.x - s0.x
        const cy = (s2.y - s0.y) * aspectOf(f.camera)
        const cl = Math.hypot(cx, cy)
        let lo = 0
        let hi = Math.min(1, MAX_BEND / Math.max(ang, 1e-4))
        const dir = (k: number) => {
          if (ang < 1e-4) return dirK.copy(tmp2)
          const so = Math.sin(ang)
          return dirK.copy(tmp2).multiplyScalar(Math.sin((1 - k) * ang) / so)
            .addScaledVector(tmp, Math.sin(k * ang) / so)
        }
        const bendOnScreen = (k: number) => {
          s1.copy(f.muzzle).addScaledVector(dir(k), L * BOW).project(f.camera)
          const dx = s1.x - s0.x
          const dy = (s1.y - s0.y) * aspectOf(f.camera)
          const dl = Math.hypot(dx, dy)
          if (dl < 1e-5 || cl < 1e-5 || s1.z > 1) return 0
          return Math.acos(Math.min(1, Math.max(-1, (dx * cx + dy * cy) / (dl * cl))))
        }
        if (bendOnScreen(hi) > MAX_BEND_SCREEN) {
          for (let it = 0; it < 8; it++) {
            const m = (lo + hi) / 2
            if (bendOnScreen(m) > MAX_BEND_SCREEN) hi = m
            else lo = m
          }
          hi = lo
        }
        ctrlGoal.copy(f.muzzle).addScaledVector(dir(hi), L * BOW)
      }
      if (ctrlFresh || miss) {
        ctrl.copy(ctrlGoal)
        ctrlVel.set(0, 0, 0)
        ctrlFresh = false
      } else {
        const w = 30
        const z = 0.75
        tmp.subVectors(ctrlGoal, ctrl).multiplyScalar(w * w * dt)
        ctrlVel.add(tmp).multiplyScalar(1 / (1 + 2 * z * w * dt + w * w * dt * dt))
        ctrl.addScaledVector(ctrlVel, dt)
      }
      const P0 = f.muzzle
      const P2 = f.end
      for (let i = 0; i < PTS; i++) {
        const t = i / SEGS
        const a = 1 - t
        // quadratic Bezier and its derivative
        const b0 = a * a
        const b1 = 2 * a * t
        const b2 = t * t
        p.set(
          b0 * P0.x + b1 * ctrl.x + b2 * P2.x,
          b0 * P0.y + b1 * ctrl.y + b2 * P2.y,
          b0 * P0.z + b1 * ctrl.z + b2 * P2.z,
        )
        const tx = 2 * a * (ctrl.x - P0.x) + 2 * t * (P2.x - ctrl.x)
        const ty = 2 * a * (ctrl.y - P0.y) + 2 * t * (P2.y - ctrl.y)
        const tz = 2 * a * (ctrl.z - P0.z) + 2 * t * (P2.z - ctrl.z)
        for (let k = 0; k < 2; k++) {
          const j = (i * 2 + k) * 3
          pos[j] = p.x
          pos[j + 1] = p.y
          pos[j + 2] = p.z
          tan[j] = tx
          tan[j + 1] = ty
          tan[j + 2] = tz
        }
      }
      posAttr.needsUpdate = true
      tanAttr.needsUpdate = true
      // a miss flickers like a beam finding nothing to take
      const flicker = miss ? 0.6 + 0.4 * Math.abs(Math.sin(time * 61) * Math.sin(time * 23)) : 1
      const k = Math.min(1, amount * flicker)
      u.uAmount.value = k
      u.uTime.value = time
      u.uLen.value = L
      u.uStrain.value = f.strain
      u.uMiss.value = miss ? 1 : 0
      u.uPx.value = px
      // a grab or a release thickens it for a beat, by a pixel at most
      u.uMinPx.value = (miss ? 1.1 : MIN_PX) * (1 + kickK * 0.5)
      u.uW0.value = 0
      u.uW1.value = 0
      u.uCore.value.copy(CORE).multiplyScalar(1 + kickK * 0.4)
      // the glow copies every number but its width
      for (const key of ['uAmount', 'uTime', 'uLen', 'uStrain', 'uMiss', 'uPx', 'uMinPx', 'uW0', 'uW1'] as const) {
        gu[key].value = u[key].value
      }
      // the bite: a sparkle where the beam meets the thing, pulled well
      // toward the camera: the grab point is on the collider, and a model's
      // proud slats and rims stand in front of it, which hid the whole
      // sparkle behind the prop it was meant to sit on
      tmp.copy(f.camera.position).sub(f.end)
      const toCam = Math.min(1.8, tmp.length() * 0.3)
      endGlow.position.copy(f.end).addScaledVector(tmp.normalize(), toCam)
      endU.uStar.value = 1
      endU.uSpin.value = time * 3
      endU.uSize.value = 0
      endU.uPx.value = px * (miss ? 9 : 20) * (1 + kickK * 0.8 + 0.15 * Math.sin(time * 37))
      endU.uAmount.value = k
      // the muzzle: a small hard star on the claw, not a cloud
      muzzleGlow.position.copy(f.muzzle)
      muzU.uStar.value = 1
      muzU.uSpin.value = -time * 4
      muzU.uSize.value = 0
      muzU.uPx.value = px * 7 * (1 + kickK * 0.6 + 0.1 * Math.sin(time * 53))
      muzU.uAmount.value = k
      // the scene's world matrices are not refreshed for us (the render
      // path updates only what it knows moves), so the two stars bring
      // their own up to date; without this they drew where stage() left them
      endGlow.updateMatrixWorld()
      muzzleGlow.updateMatrixWorld()
    } else {
      ctrlFresh = true
    }

    /* the held prop's rim, eased on and off, pulsing with the strain */
    haloK += ((haloOn ? 1 : 0) - haloK) * (1 - Math.exp(-dt * 20))
    if (haloOn) {
      const s = shellOf(haloOn)
      // solid once it is on (the dither only fades it in and out); the
      // strain and a grab's kick show as thickness, not as flicker
      const amt = Math.min(1, haloK * 1.1)
      for (const m of shellMats(s, 'rim')) {
        m.uniforms.uAmount.value = amt
        m.uniforms.uFill.value = 1
        m.uniforms.uPx.value = RIM_PX * px * (1 + kickK * 1.2 + f.strain * 0.6)
        m.uniforms.uGrow.value = 0.02
        m.uniforms.uColor.value.copy(HALO)
      }
    }
    // the one just let go fades its rim out rather than blinking off
    if (haloOff) {
      haloOffK = Math.max(0, haloOffK - dt * 6)
      if (haloOffK <= 0 || haloOff === flashOn) {
        setShell(haloOff, 'rim', false)
        if (haloOff !== flashOn) setShell(haloOff, 'fill', false)
        haloOff = null
      } else {
        for (const m of shellMats(shellOf(haloOff), 'rim')) m.uniforms.uAmount.value = haloOffK * 0.8
      }
    }

    /* the freeze: the outline goes white-hot, swells and rings twice back
       down; the prop keeps its own colours under a faint glaze of light */
    if (flashOn || pop.visible) {
      flashT += dt
      const k = Math.max(0, 1 - flashT / 0.8)
      const e = k * k
      // two rings of the outline: full, then a smaller echo
      const ring = Math.max(0, Math.cos(flashT * 20)) * e
      if (flashOn) {
        const s = shellOf(flashOn)
        // a bright glaze of light for the first beat, added over the prop
        // (never covering it, so it keeps its own colours)
        for (const m of shellMats(s, 'fill')) {
          m.uniforms.uAmount.value = Math.max(0, 1 - flashT / 0.12) * 0.22 * flashK
          m.uniforms.uFill.value = 0.35
          m.uniforms.uCover.value = 0
          m.uniforms.uPx.value = 0
          m.uniforms.uGrow.value = 0.006
          m.uniforms.uColor.value.copy(FLASH)
        }
        // and the full-body outline: thick, white-hot, ringing down
        for (const m of shellMats(s, 'rim')) {
          m.uniforms.uAmount.value = Math.max(flashOn === haloOn ? haloK : 0, Math.min(1, e * 4) * flashK)
          m.uniforms.uPx.value = RIM_PX * px * (2.2 + ring * 2.8)
          m.uniforms.uColor.value.copy(FLASH).lerp(WHITE, 0.3 + ring * 0.7)
        }
      }
      popU.uAmount.value = Math.min(1, e * 1.2 * flashK)
      popU.uRing.value = 0.3 + (1 - k) * 0.65
      popU.uSize.value = 0
      popU.uPx.value = px * (18 + (1 - k) * 22)
      // in front of the surface it is on, or the prop's own face cuts it
      tmp.copy(f.camera.position).sub(popAt)
      pop.position.copy(popAt).addScaledVector(tmp.normalize(), Math.min(1.6, f.camera.position.distanceTo(popAt) * 0.3))
      pop.updateMatrixWorld()
      if (k <= 0) {
        if (flashOn && flashOn !== haloOn) {
          setShell(flashOn, 'fill', false)
          setShell(flashOn, 'rim', false)
        } else if (flashOn) setShell(flashOn, 'fill', false)
        flashOn = null
        pop.visible = false
      }
    }
  }

  const holdHalo = (mesh: THREE.Object3D | null) => {
    if (mesh === haloOn) return
    if (haloOn) {
      if (haloOff && haloOff !== flashOn) setShell(haloOff, 'rim', false)
      // a freeze lets go and flashes the same prop on the same frame: the
      // flash owns its shells from here
      if (haloOn !== flashOn) {
        haloOff = haloOn
        haloOffK = haloK
        setShell(haloOn, 'fill', false)
      }
    }
    haloOn = mesh
    haloK = 0
    if (mesh) {
      if (mesh === haloOff) haloOff = null
      setShell(mesh, 'rim', true)
    }
  }

  const flash = (mesh: THREE.Object3D | null, point: THREE.Vector3, k = 1) => {
    if (flashOn && flashOn !== mesh && flashOn !== haloOn) {
      setShell(flashOn, 'fill', false)
      setShell(flashOn, 'rim', false)
    }
    flashOn = mesh
    flashK = k
    if (mesh) {
      if (mesh === haloOff) haloOff = null
      setShell(mesh, 'rim', true)
      setShell(mesh, 'fill', true)
    }
    flashT = 0
    popAt.copy(point)
    pop.visible = true
  }

  let staged = false
  const stage = (camera: THREE.Camera) => {
    staged = true
    camera.updateMatrixWorld()
    const put = (o: THREE.Object3D, dz: number, dx: number) => {
      o.position.set(dx, 0, -dz).applyMatrix4(camera.matrixWorld)
      o.visible = true
    }
    // a short real ribbon, so its first draw happens under the cover too
    for (let i = 0; i < PTS; i++) {
      tmp.set(0.2, -0.1, -1 - i * 0.1).applyMatrix4(camera.matrixWorld)
      for (let k = 0; k < 2; k++) {
        const j = (i * 2 + k) * 3
        pos[j] = tmp.x
        pos[j + 1] = tmp.y
        pos[j + 2] = tmp.z
        tan[j] = 0
        tan[j + 1] = 0
        tan[j + 2] = 1
      }
    }
    posAttr.needsUpdate = true
    tanAttr.needsUpdate = true
    // drawn, but at a coverage that the fragment discards: the program and
    // the buffers are paid for, the frame shows nothing
    u.uAmount.value = 0.001
    ribbon.visible = true
    glow.visible = true
    put(endGlow, 2, 0)
    put(muzzleGlow, 2, 0.1)
    put(pop, 2, -0.1)
    put(warmRim, 3, 0.4)
    put(warmFill, 3, -0.4)
    for (const m of [endU, muzU, popU]) m.uAmount.value = 0.001
    rimBase.uniforms.uAmount.value = 0.001
    fillBase.uniforms.uAmount.value = 0.001
  }
  const unstage = () => {
    if (!staged) return
    staged = false
    for (const o of [ribbon, glow, endGlow, muzzleGlow, pop, warmRim, warmFill]) o.visible = false
    amount = 0
    ctrlFresh = true
  }

  return {
    root,
    update,
    holdHalo,
    flash,
    kick: (k) => {
      kickK = Math.max(kickK, k)
    },
    stage,
    unstage,
    clear: () => {
      for (const m of [haloOn, haloOff, flashOn]) {
        setShell(m, 'rim', false)
        setShell(m, 'fill', false)
      }
      haloOn = haloOff = flashOn = null
      haloK = haloOffK = 0
      pop.visible = false
    },
    dispose: () => {
      root.removeFromParent()
      geo.dispose()
      quad.dispose()
      warmGeo.dispose()
      mat.dispose()
      glowMat.dispose()
      for (const b of [endGlow, muzzleGlow, pop]) (b.material as THREE.Material).dispose()
      rimBase.dispose()
      fillBase.dispose()
    },
  }
}

/**
 * A beam frame from somebody else's `HoldRecord`: the far end and the target
 * come off the wire, the muzzle from wherever their body's gun is drawn. The
 * physgun's own frame is filled the same way from its live view, so a remote
 * beam and the local one are drawn by the same code from the same numbers.
 */
export const frameFromRecord = (
  rec: {
    kind: 'prop' | 'rig' | 'none'
    end: readonly [number, number, number]
    target: readonly [number, number, number]
    strain: number
  },
  out: BeamFrame,
) => {
  out.mode = rec.kind === 'none' ? 'off' : 'hold'
  out.end.set(rec.end[0], rec.end[1], rec.end[2])
  out.target.set(rec.target[0], rec.target[1], rec.target[2])
  out.strain = rec.strain
  return out
}
