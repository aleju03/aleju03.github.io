import * as THREE from 'three'
import { GLOW_ALPHA } from '../../render/pixelLook'
import { ovalR, PORTAL_HH, PORTAL_HW, toPortal, type Portal, type Portals } from './portals'

/*
  What a portal looks like: an oval in the surface with a lit rim in its
  colour, and through it, the other side.

  **Seeing through** is a second render of the same scene from a virtual
  camera: the lens carried through the pair (portals.ts's `transform`, the
  same matrix that carries the walker), into a target the size of the look's
  own internal frame, which the oval then samples in *screen* space
  (`gl_FragCoord / uRes`). So the picture through the hole is pixel for pixel
  the one the scene target would have drawn there, and because it is drawn
  into the scene target like any other surface, the look's grade, posterize,
  outlines and air run over it with everything else: it is not a picture of
  the other side, it is the other side, drawn through the pixel look.

  Three things keep that pass honest and cheap:

  - **An oblique near plane** (Lengyel's trick, the one three's Reflector
    uses): the virtual camera stands *behind* the exit portal, inside
    whatever wall it is on, so its near plane is bent onto the exit's plane
    and the wall behind it is clipped away. That is a projection matrix and
    nothing else, so no program is keyed on it (a clipping plane would be
    `NUM_CLIPPING_PLANES` and relink every lit material mid-walk).
  - **A cropped frustum**: the projection is narrowed to the oval's own
    rectangle on screen and the target's viewport and scissor set to it, so
    a portal a hundred pixels across costs a hundred pixels of fill and the
    draw calls of what can be seen through it, not a second frame.
  - **Only when it can be seen**: in front of it, inside the frustum and in
    range. A portal nobody is looking at costs a matrix test.

  Recursion (a portal seen through a portal) is not rendered: during the
  passes every oval draws its closed swirl and samples a one-texel dummy,
  since sampling the target being drawn into is a feedback loop WebGL
  refuses. A portal with no partner also shows the swirl, Portal's closed
  look. When the lens is about to pass through the oval (inside it and a
  hand's width off the plane, where the near plane would cut the surface
  away and show the inside of the wall for a frame), the oval draws as a
  full-screen quad of the view instead, at a depth behind the gun.

  Remote ovals clone the two warmed materials and reuse their shader
  program. Four render targets serve the nearest visible views; farther
  ovals retain their coloured swirl without another scene pass. The two
  original materials are compiled under the boot cover by `stage()` with
  the belt's other parts. A pair that spans two levels (the Moon) renders
  through `hooks.cross`, which dresses the scene as the far level for the
  one pass and undresses it after, or shows the snapshot it hands back. A
  dressed view is written with the look's light code, so the grade and the
  night's fake lamps of the level you stand in leave another level's
  daylight alone.
*/

/** the rim, as a share of the oval past the opening */
const RIM = 1.09
/** the portals' colours, linear and HDR: the look's ACES takes them to a
    clean sky blue and a warm orange */
export const PORTAL_COLORS = [new THREE.Color(0.12, 0.78, 3.6), new THREE.Color(3.6, 1.05, 0.08)] as const
/** past this the pass is not worth it: the fog has the far side anyway */
const VIEW_RANGE = 320
/** Nearest visible views share a fixed target budget, even in a full lobby. */
const MAX_PASSES = 4

const VERT = /* glsl */ `
uniform float uFull;
varying vec2 vE;
void main() {
  vE = (uv * 2.0 - 1.0) * ${RIM.toFixed(3)};
  if (uFull > 0.5) {
    // the whole screen, behind the first-person gun (its depth is squeezed
    // into the front quarter of the range) and in front of everything else
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  } else {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
}`

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float uOpen;
uniform float uMode;
uniform float uTime;
uniform float uFull;
uniform float uEmit;
uniform vec4 uSnap;
uniform mat4 uSnapM;
varying vec2 vE;
void main() {
  float r = length(vE);
  float a = atan(vE.y, vE.x);
  float R = uOpen;
  if (uFull < 0.5) {
    // the edge breathes a little, in flat steps
    float wob = 0.02 * sin(a * 5.0 + uTime * 2.3) + 0.012 * sin(a * 11.0 - uTime * 3.7);
    float edge = R * (1.0 + wob);
    if (r > edge * ${RIM.toFixed(3)}) discard;
    if (r > edge) {
      // the rim: a light, so it keeps its colour through the grade
      float k = 0.85 + 0.3 * step(0.0, sin(a * 7.0 - uTime * 4.0));
      gl_FragColor = vec4(uColor * k, ${GLOW_ALPHA.toFixed(6)});
      return;
    }
  }
  vec3 col;
  if (uMode > 1.5) {
    // a snapshot of the far side, looked up by the direction through the
    // oval (a level too far to redraw every frame)
    vec4 c = uSnapM * vec4(gl_FragCoord.xy / uRes * 2.0 - 1.0, 1.0, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    col = texture2D(uMap, clamp(uv, 0.0, 1.0)).rgb * uSnap.x;
    float t = step(0.9 * R, r) * 0.5 + step(0.95 * R, r) * 0.5;
    col = mix(col, uColor * 0.3, t * 0.45);
  } else if (uMode > 0.5) {
    col = texture2D(uMap, gl_FragCoord.xy / uRes).rgb;
    // a thin haze of the portal's colour just inside the rim, in two steps
    float t = uFull > 0.5 ? 0.0 : step(0.9 * R, r) * 0.5 + step(0.95 * R, r) * 0.5;
    col = mix(col, uColor * 0.3, t * 0.45);
  } else {
    // closed: bands swirling in to the middle, in three flat tones
    float s = sin(r * 11.0 - uTime * 3.2 + a * 2.0);
    float k = 0.28 + 0.2 * step(0.2, s) + 0.35 * step(0.72, r / max(R, 0.001));
    col = uColor * 0.42 * k;
  }
  // another level's light is its own: written as a light, the look leaves
  // it out of this level's grade and its lamps (the night's headlamp read
  // the Moon's sunlit ground as albedo and burned it white)
  gl_FragColor = vec4(col, uEmit > 0.5 ? ${GLOW_ALPHA.toFixed(6)} : 1.0);
}`

export interface PortalHooks {
  /** before the first pass of a frame: hide what belongs to the lens (the
      first-person gun), show what the lens hides (your own head) */
  begin?: () => void
  end?: () => void
  /**
   * The partner is in another level: dress the scene as that level for one
   * pass from `vcam` and return the undressing, or return null to show the
   * closed swirl. Or hand back `{ snapshot }` to draw a stored picture.
   */
  cross?: (to: Portal, vcam: THREE.PerspectiveCamera) =>
    | { restore: () => void; far?: number }
    | { snapshot: THREE.Texture; viewProj: THREE.Matrix4; gain?: number }
    | null
}

export interface PortalView {
  readonly root: THREE.Group
  /** where the Moon's copy of a portal hangs (a moving root), or the scene */
  setParent: (color: 0 | 1, parent: THREE.Object3D | null) => void
  /** place the ovals for the level that is live, and draw the views */
  render: (
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
    w: number, h: number, level: string, now: number, hooks?: PortalHooks,
  ) => void
  /** views drawn last frame, and the pixels they covered */
  readonly stats: { passes: number; pixels: number }
  stage: (camera: THREE.Camera) => void
  unstage: () => void
  dispose: () => void
}

export function createPortalView(portals: Portals, parent: THREE.Object3D, renderer: THREE.WebGLRenderer): PortalView {
  const root = new THREE.Group()
  root.name = 'portals'
  root.userData.dynamic = true
  parent.add(root)
  const geo = new THREE.PlaneGeometry(2 * PORTAL_HW * RIM, 2 * PORTAL_HH * RIM)
  const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  dummy.needsUpdate = true
  const gl = renderer.getContext()
  const half = renderer.extensions.has('EXT_color_buffer_float') ||
    renderer.extensions.has('EXT_color_buffer_half_float') ||
    !!gl.getExtension?.('EXT_color_buffer_half_float')
  const makeRT = () => {
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    })
    rt.scissorTest = true
    return rt
  }
  const rts = Array.from({ length: MAX_PASSES }, makeRT)
  const mats = [0, 1].map((i) =>
    new THREE.ShaderMaterial({
      name: 'portal',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: dummy },
        uRes: { value: new THREE.Vector2(1, 1) },
        uColor: { value: PORTAL_COLORS[i].clone() },
        uOpen: { value: 0 },
        uMode: { value: 0 },
        uTime: { value: 0 },
        uFull: { value: 0 },
        uEmit: { value: 0 },
        uSnap: { value: new THREE.Vector4() },
        uSnapM: { value: new THREE.Matrix4() },
      },
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    }),
  )
  const meshes = mats.map((m, i) => {
    const mesh = new THREE.Mesh(geo, m)
    mesh.name = i ? 'portal-orange' : 'portal-blue'
    mesh.matrixAutoUpdate = false
    mesh.userData.dynamic = true
    mesh.visible = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    root.add(mesh)
    return mesh
  })
  const parents: (THREE.Object3D | null)[] = [null, null]
  const remoteSlots = new Map<string, number>()
  const slotKeys: (string | null)[] = ['local:0', 'local:1']
  const current: (Portal | null)[] = [null, null]
  const syncSlots = () => {
    current[0] = portals.list[0]; current[1] = portals.list[1]
    const live = new Set(portals.all.filter((p) => p?.owner).map((p) => `${p!.owner}:${p!.color}`))
    for (const [key, i] of remoteSlots) if (!live.has(key)) {
      meshes[i].removeFromParent(); meshes[i].visible = false
      mats[i].dispose(); current[i] = null; slotKeys[i] = null
      remoteSlots.delete(key)
    }
    for (const p of portals.all) {
      if (!p?.owner) continue
      const key = `${p.owner}:${p.color}`
      let i = remoteSlots.get(key)
      if (i === undefined) {
        i = slotKeys.findIndex((k, index) => index >= 2 && k === null)
        if (i < 0) i = slotKeys.length
        // Cloning uniforms retains the already-warmed shader program.
        const sampled = mats[p.color].uniforms.uMap.value
        mats[p.color].uniforms.uMap.value = dummy
        mats[i] = mats[p.color].clone()
        mats[p.color].uniforms.uMap.value = sampled
        mats[i].uniforms.uMap.value = dummy
        const mesh = new THREE.Mesh(geo, mats[i])
        mesh.name = `portal-${key}`
        mesh.matrixAutoUpdate = false; mesh.userData.dynamic = true
        mesh.castShadow = false; mesh.receiveShadow = false
        root.add(mesh); meshes[i] = mesh; parents[i] = null
        slotKeys[i] = key; remoteSlots.set(key, i)
      }
      current[i] = p
    }
  }


  const vcam = new THREE.PerspectiveCamera()
  const lens = new THREE.PerspectiveCamera()
  vcam.matrixAutoUpdate = false
  vcam.matrixWorldAutoUpdate = false
  const M = new THREE.Matrix4()
  const P = new THREE.Matrix4()
  const Pi = new THREE.Matrix4()
  const S = new THREE.Matrix4()
  const frustum = new THREE.Frustum()
  const pv = new THREE.Matrix4()
  const sphere = new THREE.Sphere()
  const corner = new THREE.Vector4()
  const v4 = new THREE.Vector4()
  const c4 = new THREE.Vector4()
  const nv = new THREE.Vector3()
  const pt = new THREE.Vector3()
  const lp = new THREE.Vector3()
  const cam = new THREE.Vector3()
  const scl = new THREE.Vector3()
  const rot = new THREE.Matrix4()
  const stats = { passes: 0, pixels: 0 }
  let time = 0

  /** the oval's rectangle on the target, in pixels, or null off screen */
  const rect = { x: 0, y: 0, w: 0, h: 0 }
  const screenRect = (p: Portal, camera: THREE.Camera, w: number, h: number) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let behind = false
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        pt.copy(p.pos).addScaledVector(p.right, sx * PORTAL_HW * RIM).addScaledVector(p.up, sy * PORTAL_HH * RIM)
        v4.set(pt.x, pt.y, pt.z, 1).applyMatrix4(pv)
        if (v4.w <= 1e-3) {
          behind = true
          continue
        }
        const x = v4.x / v4.w
        const y = v4.y / v4.w
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (behind) {
      x0 = -1
      y0 = -1
      x1 = 1
      y1 = 1
    }
    x0 = Math.max(-1, x0)
    y0 = Math.max(-1, y0)
    x1 = Math.min(1, x1)
    y1 = Math.min(1, y1)
    if (x1 <= x0 || y1 <= y0) return null
    const px0 = Math.max(0, Math.floor(((x0 + 1) / 2) * w) - 1)
    const py0 = Math.max(0, Math.floor(((y0 + 1) / 2) * h) - 1)
    const px1 = Math.min(w, Math.ceil(((x1 + 1) / 2) * w) + 1)
    const py1 = Math.min(h, Math.ceil(((y1 + 1) / 2) * h) + 1)
    if (px1 <= px0 || py1 <= py0) return null
    rect.x = px0
    rect.y = py0
    rect.w = px1 - px0
    rect.h = py1 - py0
    void camera
    return rect
  }

  /** narrow a projection to a pixel rectangle of a w x h target */
  const crop = (proj: THREE.Matrix4, r: typeof rect, w: number, h: number, out: THREE.Matrix4) => {
    const nx0 = (r.x / w) * 2 - 1
    const nx1 = ((r.x + r.w) / w) * 2 - 1
    const ny0 = (r.y / h) * 2 - 1
    const ny1 = ((r.y + r.h) / h) * 2 - 1
    const sx = 2 / (nx1 - nx0)
    const sy = 2 / (ny1 - ny0)
    const cx = (nx0 + nx1) / 2
    const cy = (ny0 + ny1) / 2
    S.set(sx, 0, 0, -sx * cx, 0, sy, 0, -sy * cy, 0, 0, 1, 0, 0, 0, 0, 1)
    return out.multiplyMatrices(S, proj)
  }

  /** bend the projection's near plane onto a world plane (Lengyel) */
  const oblique = (proj: THREE.Matrix4, view: THREE.Matrix4, n: THREE.Vector3, at: THREE.Vector3) => {
    nv.copy(n).transformDirection(view)
    pt.copy(at).applyMatrix4(view)
    c4.set(nv.x, nv.y, nv.z, -nv.dot(pt))
    // the lens must be behind the plane, or there is nothing to bend
    if (c4.w >= -1e-4) return
    Pi.copy(proj).invert()
    // the plane in clip space picks the far corner of the frustum it faces
    const e = Pi.elements
    const cx = c4.x * e[0] + c4.y * e[1] + c4.z * e[2] + c4.w * e[3]
    const cy = c4.x * e[4] + c4.y * e[5] + c4.z * e[6] + c4.w * e[7]
    corner.set(Math.sign(cx) || 1, Math.sign(cy) || 1, 1, 1).applyMatrix4(Pi)
    const m = proj.elements
    const m4q = m[3] * corner.x + m[7] * corner.y + m[11] * corner.z + m[15] * corner.w
    const cq = c4.x * corner.x + c4.y * corner.y + c4.z * corner.z + c4.w * corner.w
    if (Math.abs(cq) < 1e-9) return
    const k = (2 * m4q) / cq
    m[2] = k * c4.x - m[3]
    m[6] = k * c4.y - m[7]
    m[10] = k * c4.z - m[11]
    m[14] = k * c4.w - m[15]
  }

  const opening = (age: number) => {
    // out from a point with a little overshoot, over a fifth of a second
    const t = Math.min(1, age / 0.22)
    const c = 1.9
    return t >= 1 ? 1 : 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
  }

  const place = (i: number, p: Portal) => {
    const mesh = meshes[i]
    const want = parents[i] ?? root
    if (mesh.parent !== want) want.add(mesh)
    mesh.matrix.copy(p.basis)
    mesh.matrixWorldNeedsUpdate = true
  }

  const render: PortalView['render'] = (rr, scene, camera, w, h, level, now, hooks) => {
    time = now
    stats.passes = 0
    stats.pixels = 0
    syncSlots()
    const want: { i: number; p: Portal; to: Portal; full: boolean; r: typeof rect }[] = []
    camera.updateMatrixWorld()
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(pv)
    cam.setFromMatrixPosition(camera.matrixWorld)
    for (let i = 0; i < current.length; i++) {
      const p = current[i]
      const mesh = meshes[i]
      const mat = mats[i]
      const u = mat.uniforms
      // a portal is drawn in its own level; the Moon's copy rides its root
      if (!p || (p.level !== level && !parents[i])) {
        mesh.visible = false
        continue
      }
      mesh.visible = true
      place(i, p)
      u.uOpen.value = opening(p.age)
      u.uTime.value = time
      u.uRes.value.set(w, h)
      u.uFull.value = 0
      u.uEmit.value = 0
      mesh.frustumCulled = true
      const to = portals.partner(p)
      u.uMode.value = 0
      u.uMap.value = dummy
      if (!to || p.level !== level) continue
      // can it be seen at all
      toPortal(p, cam, lp)
      if (lp.z < -0.05) continue
      if (cam.distanceTo(p.pos) > VIEW_RANGE) continue
      const full = lp.z < 0.35 && ovalR(lp.x, lp.y) < 0.8
      sphere.set(p.pos, PORTAL_HH * RIM)
      if (!full && !frustum.intersectsSphere(sphere)) continue
      let r = full ? { x: 0, y: 0, w, h } : screenRect(p, camera, w, h)
      if (!r) continue
      r = { ...r }
      want.push({ i, p, to, full, r })
    }
    if (!want.length) return
    want.sort((a, b) => Number(b.full) - Number(a.full) || cam.distanceToSquared(a.p.pos) - cam.distanceToSquared(b.p.pos))
    want.length = Math.min(want.length, MAX_PASSES)
    const prevTarget = rr.getRenderTarget()
    hooks?.begin?.()
    // every oval shows its swirl during the passes (no recursion)
    const modes = want.map(() => 0)
    for (const m of mats) {
      m.uniforms.uMode.value = 0
      m.uniforms.uMap.value = dummy
    }
    for (let k = 0; k < want.length; k++) {
      const { i, p, to, r } = want[k]
      const rt = rts[k]
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h)
      // the lens, carried through the pair
      portals.transform(p, M)
      vcam.matrixWorld.multiplyMatrices(M, camera.matrixWorld)
      vcam.matrixWorld.decompose(vcam.position, vcam.quaternion, scl)
      vcam.matrixWorldInverse.copy(vcam.matrixWorld).invert()
      let restore: (() => void) | null = null
      let far = camera.far
      if (to.level !== p.level) {
        const got = hooks?.cross?.(to, vcam) ?? null
        if (!got) continue
        if ('snapshot' in got) {
          // screen -> a direction from the lens -> through the pair -> the
          // snapshot's own picture of that direction
          const u = mats[i].uniforms
          rot.extractRotation(vcam.matrixWorld)
          u.uSnapM.value.multiplyMatrices(got.viewProj, rot).multiply(camera.projectionMatrixInverse)
          u.uSnap.value.x = got.gain ?? 1
          modes[k] = 2
          mats[i].userData.snap = got.snapshot
          continue
        }
        restore = got.restore
        far = got.far ?? far
      }
      // the lens's own projection (its far plane moved out for a far side
      // that wants one), narrowed to the oval, its near plane bent onto the exit
      if (far !== camera.far) {
        lens.copy(camera)
        lens.far = far
        lens.updateProjectionMatrix()
        crop(lens.projectionMatrix, r, w, h, P)
      } else crop(camera.projectionMatrix, r, w, h, P)
      oblique(P, vcam.matrixWorldInverse, to.n, to.pos)
      vcam.near = camera.near
      vcam.far = far
      vcam.projectionMatrix.copy(P)
      vcam.projectionMatrixInverse.copy(P).invert()
      rt.viewport.set(r.x, r.y, r.w, r.h)
      rt.scissor.set(r.x, r.y, r.w, r.h)
      rr.setRenderTarget(rt)
      rr.render(scene, vcam)
      restore?.()
      if (restore) mats[i].uniforms.uEmit.value = 1
      modes[k] = 1
      stats.passes++
      stats.pixels += r.w * r.h
    }
    rr.setRenderTarget(prevTarget)
    hooks?.end?.()
    for (let k = 0; k < want.length; k++) {
      const { i, full } = want[k]
      const u = mats[i].uniforms
      u.uMode.value = modes[k]
      if (modes[k] === 1) u.uMap.value = rts[k].texture
      else if (modes[k] === 2) u.uMap.value = (mats[i].userData.snap as THREE.Texture) ?? dummy
      if (full && modes[k]) {
        u.uFull.value = 1
        meshes[i].frustumCulled = false
      }
    }
  }

  let staged = false
  const stage = (camera: THREE.Camera) => {
    staged = true
    camera.updateMatrixWorld()
    for (let i = 0; i < 2; i++) {
      const mesh = meshes[i]
      if (mesh.parent !== root) root.add(mesh)
      mesh.visible = true
      pt.set(i ? 1.2 : -1.2, 0, -4).applyMatrix4(camera.matrixWorld)
      // (a matrix's lookAt points +z from the target at the eye: here the
      // oval's face, from its spot back at the lens)
      M.lookAt(cam.setFromMatrixPosition(camera.matrixWorld), pt, camera.up)
      mesh.matrix.copy(M).setPosition(pt)
      mesh.matrixWorldNeedsUpdate = true
      mats[i].uniforms.uMode.value = 1
      mats[i].uniforms.uMap.value = dummy
      mats[i].uniforms.uOpen.value = 1
    }
  }
  const unstage = () => {
    if (!staged) return
    staged = false
    for (const m of meshes) m.visible = false
  }

  return {
    root,
    setParent: (color, par) => {
      parents[color] = par
    },
    render,
    stats,
    stage,
    unstage,
    dispose: () => {
      root.removeFromParent()
      for (const m of meshes) m.removeFromParent()
      geo.dispose()
      dummy.dispose()
      for (const rt of rts) rt.dispose()
      for (const m of mats) m.dispose()
    },
  }
}
