import * as THREE from 'three'
import { GRADE_DAY, GRADE_NIGHT, LUT_SIZE, bakeGrade, gradeTexture, type Grade } from './grade'
import { BLIT_FRAG, FULLSCREEN_VERT, GRADE_FRAG } from './shaders'

/*
  The look: pixel art, in 3D.

  Every frame of the room and the world is drawn by `render()` here rather
  than by `renderer.render`. The scene goes into a small target, a few
  hundred lines tall, with no antialiasing; a second pass at that same small
  size draws the outlines, tone maps, grades and posterizes it with an
  ordered dither; and a third, trivial pass upscales the result to the canvas
  nearest-neighbour, so each rendered pixel lands as a crisp block of device
  pixels. That is the Lethal Company recipe (it renders about 520 lines and
  stretches them), and what makes it read as *pixel art* rather than as a
  blurry downscale is the middle pass: the bands and the dither are drawn at
  the chunky resolution, so they are part of the pixels rather than noise on
  top of them.

  Four things about it are load-bearing, and all four are easy to break.

  **The renderer's own tone mapping and output encoding must be off**
  (`prepareRenderer`). three skips both when drawing into a target, and keys
  every material's program on them, so a renderer left on ACES and sRGB
  compiles one set of programs for the canvas and a different set for this
  target. Every warm-up in CrtScene draws to the canvas; they would warm the
  wrong programs and the walk would link the real ones mid-stride. With both
  off, a program is the same whichever way it is drawn, and the look applies
  its own ACES in the grade pass.

  **Alpha survives.** The AlejOS screen and the house television are holes
  punched through the canvas with a near-transparent, non-blending material,
  and the live DOM shows through them. The scene target is RGBA, the outline
  step skips anything not fully opaque, and the grade writes premultiplied
  colour, so a hole leaves this pass as the same 7% tint it went in as.

  **The internal resolution is the governor's knob.** Fill cost is what the
  adaptive governor in CrtScene is fighting, and it now sheds lines here
  rather than the canvas's pixel ratio (the canvas stays sharp, because a
  blurred upscale is the one thing this look cannot survive). `setLines` is
  live and costs a target reallocation, never a program.

  **The pixel is integer where it can be.** A 2.6x upscale makes pixels that
  alternate two and three device pixels wide, which is invisible in motion
  and obvious on a one-pixel outline. So the scale snaps to the nearest whole
  number when it is within `SNAP` of one (1080p at 540 lines is exactly 2x;
  1440p lands on 3x at 480) and only runs fractional between.

  Nothing here allocates per frame, and there are exactly two programs, both
  compiled by `compile()`. Without a renderer (Node, the measure harness) none
  of this is ever constructed; `grade.ts` alone runs headless.
*/

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
  /** 0 hard posterize .. 1 full ordered dither between neighbouring steps */
  dither: number
  /** silhouette darkening, 0..1 (not black: a darker version of itself) */
  outline: number
  /** convex crease lift and concave crease darkening */
  ridge: number
  valley: number
  /** silhouette gap: constant units, plus this fraction of the depth */
  gap: number
  gapK: number
  /** crease threshold, relative 1/z second difference */
  crease: number
  /** strength of the baked grade, 0 raw ACES .. 1 */
  grade: number
  vignette: number
}

export const LOOK_DEFAULTS: LookKnobs = {
  lines: 540,
  exposure: 1.1,
  levels: 18,
  chroma: 0.022,
  dither: 0.9,
  outline: 0.6,
  ridge: 0.22,
  valley: 0.16,
  gap: 0.25,
  gapK: 0.045,
  crease: 0.0012,
  grade: 1,
  vignette: 0.22,
}

/** how close to a whole number the upscale has to be before it snaps */
const SNAP = 0.35

export interface PixelLook {
  /** the live dials; mutate freely, read on the next render */
  readonly knobs: LookKnobs
  /** draw `scene` through the look into the renderer's current viewport */
  render: (scene: THREE.Scene, camera: THREE.Camera) => void
  /** multiplier on `knobs.lines`: the render-scale pref times the governor */
  setScale: (k: number) => void
  /** 0 day grade .. 1 night grade */
  setMood: (night: number) => void
  /** re-bake the day and/or night grade over the shipped presets. A texture
      upload, never a program: safe mid-walk, and what a tuning probe uses */
  setGrade: (day?: Partial<Grade>, night?: Partial<Grade>) => void
  /** link both programs now, under whatever is covering the boot */
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
    uFog: { value: new THREE.Vector3(0, 1, 0) },
    uEdge: { value: new THREE.Vector3() },
    uEdgeK: { value: new THREE.Vector3() },
    uPost: { value: new THREE.Vector3() },
    uVignette: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
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

  let scale = 1
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
    U.uEdge.value.set(K.outline, K.ridge, K.valley)
    U.uEdgeK.value.set(K.gap, K.gapK, K.crease)
    U.uPost.value.set(K.levels, K.chroma, K.dither)
    U.uVignette.value = K.vignette
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
    pushKnobs(scene, camera)

    renderer.setRenderTarget(sceneRT)
    renderer.render(scene, camera)
    renderer.autoClear = false
    renderer.setRenderTarget(gradeRT)
    renderer.render(gradeScene, quadCam)
    renderer.setRenderTarget(prevTarget)
    renderer.render(blitScene, quadCam)
    renderer.autoClear = autoClear
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
  }

  return {
    knobs: K,
    render,
    setScale: (k) => { scale = Math.max(0.1, k) },
    setMood: (n) => { U.uMood.value = Math.min(1, Math.max(0, n)) },
    setGrade,
    compile,
    internal,
    dispose,
  }
}
