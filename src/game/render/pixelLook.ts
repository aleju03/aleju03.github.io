import * as THREE from 'three'
import { GRADE_DAY, GRADE_NIGHT, LUT_SIZE, bakeGrade, gradeTexture, type Grade } from './grade'
import {
  BLIT_FRAG, FULLSCREEN_VERT, GRADE_FRAG, MAX_POOLS, PUNCH_FRAG, PUNCH_VERT,
} from './shaders'

/*
  The look: pixel art, in 3D, with air in it.

  Every frame of the room and the world is drawn by `render()` here rather
  than by `renderer.render`. The scene goes into a small target, a few
  hundred lines tall, with no antialiasing; a second pass at that same small
  size lights, outlines, hazes, tone maps, grades and posterizes it; and a
  third, trivial pass upscales the result to the canvas nearest-neighbour, so
  each rendered pixel lands as a crisp block of device pixels. That is the
  Lethal Company recipe (it renders about 520 lines and stretches them), and
  what makes it read as *pixel art* rather than as a blurry downscale is the
  middle pass: the bands, the dither and the lines are drawn at the chunky
  resolution, so they are part of the pixels rather than noise on top.

  The middle pass is also where the *atmosphere* lives, because it is the one
  place that knows how far away every pixel is:

  - **The air** (`air`): aerial perspective on top of the scene's own fog,
    a curve that keeps the near ground in full colour, flattens the middle
    distance toward the air colour and turns the far one into a silhouette,
    so depth reads as layers the way a painter would stage it (the
    posterize's lightness steps are what cut it into planes; `planes` can
    quantize the haze itself too, but its seams dither across any wall that
    happens to straddle one, so it ships off). The sky is tied to the same
    colour at the horizon, and the air warms toward the sun. CrtScene sets
    the density from the time of day and the ground under the camera; the
    colour is the scene fog's, times a warm tint by day.
  - **Fake light** (`lights`): lamp pools and a headlamp, shaded here from
    depth rather than by any material. A real PointLight per streetlamp
    would change every lit program's light count as lamps came into range,
    which is a shader link mid-walk; a uniform array of the nearest sixteen
    changes nothing but numbers. This is what gives the night its lit
    islands without costing it a single program.

  Four things about it are load-bearing, and all four are easy to break.

  **The renderer's own tone mapping and output encoding must be off**
  (`prepareRenderer`). three skips both when drawing into a target, and keys
  every material's program on them, so a renderer left on ACES and sRGB
  compiles one set of programs for the canvas and a different set for this
  target. Every warm-up in CrtScene draws to the canvas; they would warm the
  wrong programs and the walk would link the real ones mid-stride. With both
  off, a program is the same whichever way it is drawn, and the look applies
  its own ACES in the grade pass.

  **The glass holes are redrawn at full resolution.** The AlejOS screen and
  the house television are holes punched through the canvas with a
  near-transparent, non-blending material, and the live DOM shows through
  them. At the look's resolution their rims were staircases of chunky black
  notches, so the grade pass now fills a hole from its solid neighbours
  (the rim pixels become bezel) and `addHole` registers the glass mesh for a
  last pass at the canvas's own resolution that punches the exact shape,
  depth-tested by hand against the chunky depth so anything in front of the
  screen still covers it.

  **The internal resolution is the governor's knob.** Fill cost is what the
  adaptive governor in CrtScene is fighting, and it sheds lines here rather
  than the canvas's pixel ratio (the canvas stays sharp, because a blurred
  upscale is the one thing this look cannot survive). `setScale` is live and
  costs a target reallocation, never a program.

  **The pixel is integer where it can be.** A 2.6x upscale makes pixels that
  alternate two and three device pixels wide, which is invisible in motion
  and obvious on a one-pixel outline. So the scale snaps to the nearest whole
  number when it is within `SNAP` of one and only runs fractional between.

  Nothing here allocates per frame, and there are exactly three programs, all
  compiled by `compile()`. Without a renderer (Node, the measure harness) none
  of this is ever constructed; `grade.ts` alone runs headless.
*/

/**
 * The alpha a light source writes into the scene target: solid (anything at
 * or over 0.99 is), but a code the grade pass reads as "leave my colour out
 * of the baked grade". 254/255 survives an 8-bit target exactly. A material
 * writes it with custom blending that keeps colour as usual and replaces
 * the target's alpha with its own (see `sandbox/tools/beam.ts`)
 */
export const GLOW_ALPHA = 254 / 255

/** The dials. All of them are uniforms or a target size, so any may move on
    any frame; none of them may ever become a #define */
export interface LookKnobs {
  /** internal lines at render scale 1, before the governor. Lethal: ~520 */
  lines: number
  /** exposure into ACES; CrtScene's was 1.1 */
  exposure: number
  /** OKLab lightness steps. Fewer is more banded */
  levels: number
  /** OKLab a/b grid step. Larger is a smaller palette */
  chroma: number
  /** width of the dithered seam between two bands, as a fraction of a step:
      1 is a full ordered dither everywhere, 0 is hard posterize */
  dither: number
  /** film grain on lightness, in OKLab L */
  grain: number
  /** silhouette darkening, 0..1 (not black: a darker version of itself) */
  outline: number
  /** ink on folds between faces, and the lift on folds that face the eye */
  fold: number
  ridge: number
  /** silhouette gap: constant units, plus this fraction of the depth */
  gap: number
  gapK: number
  /** fold threshold, as 1 - cos of the angle between neighbouring normals */
  foldK: number
  /** convex threshold, relative 1/z second difference */
  ridgeK: number
  /** strength of the baked grade, 0 raw ACES .. 1 */
  grade: number
  vignette: number
}

export const LOOK_DEFAULTS: LookKnobs = {
  lines: 400,
  exposure: 1.1,
  levels: 13,
  chroma: 0.02,
  dither: 0.2,
  grain: 0.012,
  outline: 0.62,
  fold: 0.4,
  ridge: 0.2,
  gap: 0.25,
  gapK: 0.045,
  foldK: 0.12,
  ridgeK: 0.0012,
  grade: 1,
  vignette: 0.2,
}

/** The air between the eye and everything it sees. Distances are world
    units (the walker's eye is 3.84 up). `color` defaults to the scene fog's
    every frame unless `ownColor` is set */
export interface Air {
  /** where the haze begins */
  start: number
  /** e-folding distance: at `start + dist` the air has 63% of its say */
  dist: number
  /** how much of the colour the air may take, 0..1 */
  max: number
  /** quantize the haze into this many planes; 0 is smooth */
  planes: number
  color: THREE.Color
  ownColor: boolean
  /** multiplies the fog-derived colour: how the look warms the day's air
      without touching the sky module's fog */
  tint: THREE.Color
  /** unit vector toward the sun, world space, and the warm glow around it */
  sunDir: THREE.Vector3
  sunGlow: THREE.Color
  /** horizon pull on the sky, how high it reaches (in dir.y), and a pull on
      the whole sky */
  skyHorizon: number
  skyReach: number
  skyAll: number
}

export const AIR_DEFAULTS = (): Air => ({
  start: 6,
  dist: 120,
  max: 0.8,
  planes: 0,
  color: new THREE.Color(0.4, 0.45, 0.5),
  ownColor: false,
  tint: new THREE.Color(1, 1, 1),
  sunDir: new THREE.Vector3(0, 1, 0),
  sunGlow: new THREE.Color(0, 0, 0),
  skyHorizon: 0.85,
  skyReach: 0.3,
  skyAll: 0.2,
})

/** Light the look shades without any material knowing */
export interface FakeLights {
  /** world x, y, z and radius per pool; the first `count` are live */
  pools: Float32Array
  count: number
  /** pool colour times its strength; zero by day */
  poolColor: THREE.Color
  /** how brightly a lamp lights the air around it, and how wide that is */
  halo: number
  haloRadius: number
  /** what an unlit night surface is lit by, so its albedo can be recovered */
  ambient: THREE.Color
  head: {
    on: boolean
    pos: THREE.Vector3
    dir: THREE.Vector3
    color: THREE.Color
    range: number
    /** cosines of the outer and inner cone */
    outer: number
    inner: number
  }
}

/** how close to a whole number the upscale has to be before it snaps */
const SNAP = 0.35

export interface PixelLook {
  /** the live dials; mutate freely, read on the next render */
  readonly knobs: LookKnobs
  /** the air; mutate freely */
  readonly air: Air
  /** the fake lights; mutate freely */
  readonly lights: FakeLights
  /** draw `scene` through the look into the renderer's current viewport */
  render: (scene: THREE.Scene, camera: THREE.Camera) => void
  /** multiplier on `knobs.lines`: the render-scale pref times the governor */
  setScale: (k: number) => void
  /** 0 day grade .. 1 night grade */
  setMood: (night: number) => void
  /** re-bake the day and/or night grade over the shipped presets. A texture
      upload, never a program: safe mid-walk, and what a tuning probe uses */
  setGrade: (day?: Partial<Grade>, night?: Partial<Grade>) => void
  /** redraw this glass-hole mesh at full resolution every frame (see the
      header). Its material's opacity is the tint it punches */
  addHole: (mesh: THREE.Mesh) => void
  /** link every program now, under whatever is covering the boot */
  compile: () => void
  /** what the last render actually drew at, for HUDs and measurements */
  readonly internal: { w: number; h: number; k: number }
  dispose: () => void
}

/**
 * Put a renderer into the state the look needs: no tone mapping, linear
 * output. Call before any material is compiled, and never flip it back
 * while the look is in use (see the header: it changes every program key).
 */
export const prepareRenderer = (renderer: THREE.WebGLRenderer) => {
  renderer.toneMapping = THREE.NoToneMapping
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace
}

/** integer-ish upscale factor for an output `h` device pixels tall */
export const pixelScale = (h: number, lines: number) => {
  const raw = Math.max(1, h / Math.max(1, lines))
  const r = Math.round(raw)
  return Math.abs(raw - r) <= SNAP ? r : raw
}

export const createPixelLook = (
  renderer: THREE.WebGLRenderer,
  knobs: Partial<LookKnobs> = {},
): PixelLook => {
  prepareRenderer(renderer)
  const K: LookKnobs = { ...LOOK_DEFAULTS, ...knobs }
  const air = AIR_DEFAULTS()
  const lights: FakeLights = {
    pools: new Float32Array(MAX_POOLS * 4),
    count: 0,
    poolColor: new THREE.Color(0, 0, 0),
    halo: 0.03,
    haloRadius: 1.5,
    ambient: new THREE.Color(0.05, 0.06, 0.08),
    head: {
      on: false,
      pos: new THREE.Vector3(),
      dir: new THREE.Vector3(0, 0, -1),
      color: new THREE.Color(0, 0, 0),
      range: 26,
      outer: Math.cos(0.62),
      inner: Math.cos(0.18),
    },
  }

  // HDR if the card can render into half floats, which every desktop WebGL2
  // can; otherwise 8-bit linear, which bands in the darks, and the posterize
  // step is about to band them anyway
  const gl = renderer.getContext()
  const half = renderer.extensions.has('EXT_color_buffer_float') ||
    renderer.extensions.has('EXT_color_buffer_half_float') ||
    !!gl.getExtension?.('EXT_color_buffer_half_float')
  const depthTex = new THREE.DepthTexture(1, 1, THREE.FloatType)
  depthTex.minFilter = depthTex.magFilter = THREE.NearestFilter
  const sceneRT = new THREE.WebGLRenderTarget(1, 1, {
    type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture: depthTex,
  })
  const gradeRT = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  })

  const lutDay = gradeTexture(GRADE_DAY)
  const lutNight = gradeTexture(GRADE_NIGHT)

  // one triangle over the whole viewport: no diagonal seam, no quad overdraw
  const tri = new THREE.BufferGeometry()
  tri.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  const U = {
    tColor: { value: sceneRT.texture as THREE.Texture },
    tDepth: { value: depthTex as THREE.Texture },
    tLutA: { value: lutDay as THREE.Texture },
    tLutB: { value: lutNight as THREE.Texture },
    uMood: { value: 0 },
    uGrade: { value: 1 },
    uLutSize: { value: LUT_SIZE },
    uExposure: { value: 1.1 },
    uClip: { value: new THREE.Vector2(0.1, 900) },
    uTan: { value: new THREE.Vector2(1, 1) },
    uCamPos: { value: new THREE.Vector3() },
    uCamRot: { value: new THREE.Matrix3() },
    uFog: { value: new THREE.Vector3(0, 1, 0) },
    uEdge: { value: new THREE.Vector3() },
    uEdgeK: { value: new THREE.Vector4() },
    uPost: { value: new THREE.Vector4() },
    uVignette: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uFrame: { value: 0 },
    uAir: { value: new THREE.Vector4() },
    uAirCol: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunGlow: { value: new THREE.Color() },
    uSkyAir: { value: new THREE.Vector3() },
    uPools: { value: Array.from({ length: MAX_POOLS }, () => new THREE.Vector4()) },
    uPoolCount: { value: 0 },
    uPoolCol: { value: new THREE.Color() },
    uHalo: { value: new THREE.Vector2() },
    uAmbient: { value: new THREE.Color() },
    uHeadPos: { value: new THREE.Vector3() },
    uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
    uHeadCol: { value: new THREE.Color() },
    uHeadK: { value: new THREE.Vector4() },
  }
  const gradeMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: GRADE_FRAG,
    uniforms: U,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  })
  const blitU = {
    tSrc: { value: gradeRT.texture as THREE.Texture },
    uMap: { value: new THREE.Vector4(0, 0, 1, 1) },
  }
  const blitMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: BLIT_FRAG,
    uniforms: blitU,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  })
  const quad = (m: THREE.Material) => {
    const s = new THREE.Scene()
    const mesh = new THREE.Mesh(tri, m)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    s.add(mesh)
    s.matrixWorldAutoUpdate = false
    return s
  }
  const gradeScene = quad(gradeMat)
  const blitScene = quad(blitMat)
  // the quads ignore the camera entirely; three still wants one
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  // the punch layer: a proxy per registered hole, sharing its geometry and
  // following its world matrix, drawn after the upscale at full resolution.
  // Every proxy shares one program; only the tint differs, as a uniform
  const holeScene = new THREE.Scene()
  holeScene.matrixWorldAutoUpdate = false
  const holes: Array<{ src: THREE.Mesh; proxy: THREE.Mesh; mat: THREE.RawShaderMaterial }> = []
  const punchMat = (alpha: number) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: PUNCH_VERT,
    fragmentShader: PUNCH_FRAG,
    uniforms: {
      tDepth: { value: depthTex as THREE.Texture },
      uMap: blitU.uMap,
      uClip: U.uClip,
      uAlpha: { value: alpha },
    },
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  })
  // one stand-in so compile() links the punch program before any hole exists
  const warmPunch = new THREE.Mesh(tri, punchMat(0))
  warmPunch.frustumCulled = false
  warmPunch.visible = false

  let scale = 1
  let frame = 0
  const internal = { w: 0, h: 0, k: 1 }
  const vp = new THREE.Vector4()

  /** fit the targets to an output of w x h device pixels */
  const fit = (w: number, h: number) => {
    const k = pixelScale(h, K.lines * scale)
    // the texel grid spans the output exactly, so the WebGL image and the
    // CSS3D layer behind it project the same frustum onto the same pixels
    const iw = Math.max(1, Math.round(w / k))
    const ih = Math.max(1, Math.round(h / k))
    if (iw !== internal.w || ih !== internal.h) {
      sceneRT.setSize(iw, ih)
      gradeRT.setSize(iw, ih)
      internal.w = iw
      internal.h = ih
      U.uRes.value.set(iw, ih)
    }
    internal.k = k
    blitU.uMap.value.z = iw / w
    blitU.uMap.value.w = ih / h
  }

  const pushKnobs = (scene: THREE.Scene, camera: THREE.Camera) => {
    const cam = camera as THREE.PerspectiveCamera
    U.uClip.value.set(cam.near ?? 0.1, cam.far ?? 1000)
    if (cam.isPerspectiveCamera) {
      const ty = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / (cam.zoom || 1)
      U.uTan.value.set(ty * cam.aspect, ty)
    }
    U.uCamPos.value.setFromMatrixPosition(camera.matrixWorld)
    U.uCamRot.value.setFromMatrix4(camera.matrixWorld)
    const fog = scene.fog
    if (fog && (fog as THREE.Fog).isFog) {
      U.uFog.value.set((fog as THREE.Fog).near, (fog as THREE.Fog).far, 1)
    } else if (fog && (fog as THREE.FogExp2).isFogExp2) {
      // exp2 fog is ~94% opaque at 2/density: call that its far plane
      U.uFog.value.set(0, 2 / Math.max(1e-4, (fog as THREE.FogExp2).density), 1)
    } else {
      U.uFog.value.set(0, 1, 0)
    }
    U.uExposure.value = K.exposure
    U.uGrade.value = K.grade
    U.uEdge.value.set(K.outline, K.fold, K.ridge)
    U.uEdgeK.value.set(K.gap, K.gapK, K.foldK, K.ridgeK)
    U.uPost.value.set(K.levels, K.chroma, K.dither, K.grain)
    U.uVignette.value = K.vignette
    U.uFrame.value = frame++ % 4096

    U.uAir.value.set(air.start, Math.max(1, air.dist), air.max, air.planes)
    if (!air.ownColor && fog) air.color.copy((fog as THREE.Fog).color).multiply(air.tint)
    U.uAirCol.value.copy(air.color)
    U.uSunDir.value.copy(air.sunDir)
    U.uSunGlow.value.copy(air.sunGlow)
    U.uSkyAir.value.set(air.skyHorizon, Math.max(0.01, air.skyReach), air.skyAll)

    const n = Math.min(MAX_POOLS, lights.count)
    for (let i = 0; i < n; i++) {
      U.uPools.value[i].fromArray(lights.pools, i * 4)
    }
    U.uPoolCount.value = n
    U.uPoolCol.value.copy(lights.poolColor)
    U.uHalo.value.set(lights.halo, lights.haloRadius)
    U.uAmbient.value.copy(lights.ambient)
    const hd = lights.head
    U.uHeadPos.value.copy(hd.pos)
    U.uHeadDir.value.copy(hd.dir)
    U.uHeadCol.value.copy(hd.color)
    U.uHeadK.value.set(hd.range, hd.outer, hd.inner, hd.on ? 1 : 0)
  }

  const render = (scene: THREE.Scene, camera: THREE.Camera) => {
    const prevTarget = renderer.getRenderTarget()
    const autoClear = renderer.autoClear
    // the output region is whatever viewport the caller left set: the whole
    // canvas for CrtScene, one tile of a contact sheet for the probe
    renderer.getViewport(vp)
    const pr = renderer.getPixelRatio()
    const w = Math.max(1, Math.round(vp.z * pr))
    const h = Math.max(1, Math.round(vp.w * pr))
    fit(w, h)
    blitU.uMap.value.x = vp.x * pr
    blitU.uMap.value.y = vp.y * pr

    renderer.setRenderTarget(sceneRT)
    renderer.render(scene, camera)
    // after the scene render, so the camera's matrices are this frame's
    pushKnobs(scene, camera)
    renderer.autoClear = false
    renderer.setRenderTarget(gradeRT)
    renderer.render(gradeScene, quadCam)
    renderer.setRenderTarget(prevTarget)
    renderer.render(blitScene, quadCam)
    if (holes.length) {
      let any = false
      for (const h of holes) {
        const on = h.src.visible && isShown(h.src)
        h.proxy.visible = on
        if (!on) continue
        any = true
        h.proxy.matrixWorld.copy(h.src.matrixWorld)
        h.mat.uniforms.uAlpha.value = (h.src.material as THREE.Material).opacity
      }
      if (any) renderer.render(holeScene, camera)
    }
    renderer.autoClear = autoClear
  }

  /** a mesh draws only if every ancestor is visible too */
  const isShown = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
    return true
  }

  const addHole = (mesh: THREE.Mesh) => {
    const mat = punchMat((mesh.material as THREE.Material).opacity)
    const proxy = new THREE.Mesh(mesh.geometry, mat)
    proxy.matrixAutoUpdate = false
    proxy.frustumCulled = false
    holeScene.add(proxy)
    holes.push({ src: mesh, proxy, mat })
  }

  const rebake = (tex: THREE.Data3DTexture, g: Grade) => {
    tex.image.data = bakeGrade(g)
    tex.needsUpdate = true
  }
  const setGrade = (day?: Partial<Grade>, night?: Partial<Grade>) => {
    if (day) rebake(lutDay, { ...GRADE_DAY, ...day })
    if (night) rebake(lutNight, { ...GRADE_NIGHT, ...night })
  }

  const compile = () => {
    renderer.compile(gradeScene, quadCam)
    renderer.compile(blitScene, quadCam)
    warmPunch.visible = true
    holeScene.add(warmPunch)
    renderer.compile(holeScene, quadCam)
    holeScene.remove(warmPunch)
    warmPunch.visible = false
  }

  const dispose = () => {
    sceneRT.dispose()
    gradeRT.dispose()
    depthTex.dispose()
    lutDay.dispose()
    lutNight.dispose()
    tri.dispose()
    gradeMat.dispose()
    blitMat.dispose()
    ;(warmPunch.material as THREE.Material).dispose()
    for (const h of holes) h.mat.dispose()
  }

  return {
    knobs: K,
    air,
    lights,
    render,
    setScale: (k) => { scale = Math.max(0.1, k) },
    setMood: (n) => { U.uMood.value = Math.min(1, Math.max(0, n)) },
    setGrade,
    addHole,
    compile,
    internal,
    dispose,
  }
}
