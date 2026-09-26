import * as THREE from 'three'
import { canvasTexture } from '../../core/textures'

/*
  What the physgun's beam looks like: the curved blue energy from the muzzle
  to the grab point, a glow where it bites, a flare at the gun, a halo on the
  thing it holds, and the blue flash of a freeze.

  It draws from numbers, never from the physgun: a muzzle, an aim, a far end,
  a target and a strain. So the same object draws the local player's beam
  from the live physgun and a remote player's from a `HoldRecord` off the
  wire, which is the multiplayer half of this piece (S6 only has to supply
  the numbers).

  **The curve.** A quadratic Bezier whose control point sits on the aim line
  at three quarters of the way to the grab point's projection onto it. While
  the held thing is exactly where the beam wants it, the grab point is on the
  aim line and the beam is straight; when it lags a swing, the beam leaves the
  gun along the aim and bends round onto the prop, which is the whole GMod
  picture. The control point is itself sprung, so even a snappy prop whips
  the beam for a moment on a fast turn. Strain adds a lateral wobble, loudest
  mid-span, so a heavy thing on the beam looks like it is costing something.

  **The ribbon.** One strip of 33 sections, rewritten in place each frame
  (positions and tangents; nothing allocates), expanded sideways in the
  vertex shader toward the camera. The half-width is a world size or a pixel
  size, whichever is larger, which is the rule that keeps it alive through
  the pixel look: at 520 lines a physically thin beam is under a pixel twenty
  units out and simply vanishes, so it never goes under `MIN_PX`. The
  fragment is a hot core over a wider soft glow, with two octaves of value
  noise and a travelling packet scrolled from gun to target, all in HDR
  (the look owns ACES; a core at 3 lands near white, a glow at 1 stays blue).

  **Blending that keeps alpha.** Everything here adds colour and never
  touches the target's alpha (colour ONE+ONE, alpha ZERO+ONE), so a beam
  swept across the AlejOS screen's glass hole does not paint the hole shut.

  **Programs.** Three: the ribbon, the glow sprites (one SpriteMaterial
  program shared by all of them) and the halo shell. All are built at
  construction and put in front of the camera by `stage()` for the boot
  cover's compile and first draw, so the first grab links nothing (see the
  boot-cost section of the root CLAUDE.md). A second beam (a remote holder)
  is a second `createBeam`, which is the same three programs again.
*/

const SEGS = 32
const PTS = SEGS + 1
/** narrowest a beam may draw, in half-pixels of the look's internal target */
const MIN_PX = 2.6

const CORE = new THREE.Color(1.5, 2.7, 3.4)
const GLOW = new THREE.Color(0.1, 0.62, 1.7)
/** the freeze flash: whiter, and a shade toward the deep blue GMod uses */
const FLASH = new THREE.Color(1.4, 2.2, 4.2)

const VERT = /* glsl */ `
attribute vec3 aTan;
attribute float aSide;
attribute float aT;
uniform float uW0;
uniform float uW1;
uniform float uPx;
varying float vS;
varying float vT;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 tv = normalize((modelViewMatrix * vec4(aTan, 0.0)).xyz);
  vec3 side = normalize(cross(tv, normalize(-mv.xyz)));
  float hw = max(mix(uW0, uW1, aT), uPx * max(0.05, -mv.z));
  mv.xyz += side * aSide * hw;
  gl_Position = projectionMatrix * mv;
  vS = aSide;
  vT = aT;
}
`

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uLen;
uniform float uAmount;
uniform float uStrain;
uniform vec3 uCore;
uniform vec3 uGlow;
varying float vS;
varying float vT;
float hash(float n) { return fract(sin(n) * 43758.5453); }
float vnoise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}
void main() {
  float s = abs(vS);
  float along = vT * uLen;
  // energy running from the gun to the target
  float n = vnoise(along * 1.6 - uTime * 21.0) * 0.6 + vnoise(along * 4.1 - uTime * 43.0 + 7.3) * 0.4;
  float packet = pow(max(0.0, sin(along * 0.9 - uTime * 11.0)), 10.0);
  float core = exp(-s * s * 14.0);
  float glow = exp(-s * s * 3.0) * (1.0 - s * 0.6);
  // hotter at the muzzle, a little hotter again where it bites
  float ends = 1.0 + 0.7 * exp(-vT * 9.0) + 0.4 * exp(-(1.0 - vT) * 14.0);
  float e = (0.55 + 0.65 * n + 0.9 * packet) * ends * (1.0 + uStrain * 0.5);
  vec3 col = uCore * core * e + uGlow * glow * (0.45 + 0.6 * n + 0.4 * packet);
  gl_FragColor = vec4(col * uAmount, 1.0);
}
`

const HALO_VERT = /* glsl */ `
uniform float uGrow;
varying float vRim;
void main() {
  // pushed out radially as well as along the normal, so a flat-shaded box
  // (split normals at every corner) grows into one closed shell, not six
  // separate plates with gaps at the edges
  vec3 p = position + normalize(position + vec3(1e-4)) * uGrow + normal * uGrow * 0.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`

const HALO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
uniform float uFill;
varying float vRim;
void main() {
  float f = pow(vRim, 1.6) + uFill;
  gl_FragColor = vec4(uColor * f * uAmount, 1.0);
}
`

/** colour adds, alpha is left exactly as the scene wrote it */
const additive = <M extends THREE.Material>(m: M): M => {
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.OneFactor
  m.blendEquationAlpha = THREE.AddEquation
  m.blendSrcAlpha = THREE.ZeroFactor
  m.blendDstAlpha = THREE.OneFactor
  m.transparent = true
  m.depthWrite = false
  return m
}

export const haloMaterial = () =>
  additive(new THREE.ShaderMaterial({
    vertexShader: HALO_VERT,
    fragmentShader: HALO_FRAG,
    uniforms: {
      uColor: { value: GLOW.clone().multiplyScalar(0.9) },
      uAmount: { value: 0 },
      uFill: { value: 0.05 },
      uGrow: { value: 0.07 },
    },
  }))

export interface BeamFrame {
  /** where the beam leaves the gun, and the gun's forward */
  muzzle: THREE.Vector3
  forward: THREE.Vector3
  /** the far end: the grab point (hold) or the surface hit (miss) */
  end: THREE.Vector3
  /** 'hold', 'miss' or 'off' */
  mode: 'hold' | 'miss' | 'off'
  strain: number
  dt: number
  /** the look's internal lines and the camera's vertical fov (degrees), for
      the beam's minimum pixel width */
  lines: number
  fov: number
  camera: THREE.Camera
}

export interface Beam {
  readonly root: THREE.Group
  /** draw this frame's beam */
  update: (f: BeamFrame) => void
  /** light a prop up as held (0..1 each frame), by its mesh */
  holdHalo: (mesh: THREE.Object3D | null) => void
  /** the freeze pop, on whatever mesh (or at a point, for a limb) */
  flash: (mesh: THREE.Object3D | null, at: THREE.Vector3) => void
  /** a grab or release crackle at the far end: a brief brightening */
  kick: (k: number) => void
  /** put every part in front of a camera for a covered compile and draw */
  stage: (camera: THREE.Camera) => void
  /** ...and back to normal */
  unstage: () => void
  dispose: () => void
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
  const mat = additive(new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uW0: { value: 0.07 },
      uW1: { value: 0.05 },
      uPx: { value: 0.002 },
      uTime: { value: 0 },
      uLen: { value: 1 },
      uAmount: { value: 1 },
      uStrain: { value: 0 },
      uCore: { value: CORE.clone() },
      uGlow: { value: GLOW.clone() },
    },
  }))
  const ribbon = new THREE.Mesh(geo, mat)
  ribbon.frustumCulled = false
  ribbon.renderOrder = 5
  ribbon.visible = false
  root.add(ribbon)
  const u = mat.uniforms

  /* ------------------------------------------------------ the sprites -- */
  // premultiplied: it fades to black, not to transparent white, because the
  // blend adds colour and ignores alpha (a white-to-clear gradient would add
  // a white square)
  const glowTex = canvasTexture([64, 64], (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    g.addColorStop(0, '#fff')
    g.addColorStop(0.18, '#bbb')
    g.addColorStop(0.45, '#3a3a3a')
    g.addColorStop(1, '#000')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })
  const spriteMat = (c: THREE.Color) =>
    additive(new THREE.SpriteMaterial({ map: glowTex, color: c.clone(), depthTest: true }))
  const endMat = spriteMat(new THREE.Color(0.9, 2.0, 3.2))
  const muzzleMat = spriteMat(new THREE.Color(1.1, 2.2, 3.4))
  const popMat = spriteMat(FLASH)
  const endGlow = new THREE.Sprite(endMat)
  const muzzleGlow = new THREE.Sprite(muzzleMat)
  const pop = new THREE.Sprite(popMat)
  for (const s of [endGlow, muzzleGlow, pop]) {
    s.frustumCulled = false
    s.visible = false
    s.renderOrder = 6
    root.add(s)
  }

  /* --------------------------------------------------------- the halo -- */
  const holdMat = haloMaterial()
  const flashMat = haloMaterial()
  flashMat.uniforms.uColor.value.copy(FLASH)
  flashMat.uniforms.uGrow.value = 0.1
  /** one shell per prop mesh, built on its first grab and kept */
  const shells = new WeakMap<THREE.Object3D, { hold: THREE.Mesh[]; flash: THREE.Mesh[] }>()
  const shellsOf = (m: THREE.Object3D) => {
    let s = shells.get(m)
    if (s) return s
    s = { hold: [], flash: [] }
    const meshes: THREE.Mesh[] = []
    m.traverse((o) => {
      const mm = o as THREE.Mesh
      if (mm.isMesh && !mm.userData.halo) meshes.push(mm)
    })
    for (const mm of meshes) {
      for (const [list, mt] of [[s.hold, holdMat], [s.flash, flashMat]] as const) {
        const h = new THREE.Mesh(mm.geometry, mt)
        h.userData.halo = true
        h.visible = false
        h.castShadow = false
        h.receiveShadow = false
        h.renderOrder = 4
        mm.add(h)
        list.push(h)
      }
    }
    shells.set(m, s)
    return s
  }
  let haloOn: THREE.Object3D | null = null
  let haloK = 0
  let flashOn: THREE.Object3D | null = null
  let flashT = 1
  /** the warm-up's own shell: a unit box the halo programs compile on */
  const warmShell = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), holdMat)
  const warmFlash = new THREE.Mesh(warmShell.geometry, flashMat)
  warmShell.visible = warmFlash.visible = false
  warmShell.frustumCulled = warmFlash.frustumCulled = false
  root.add(warmShell, warmFlash)

  /* ------------------------------------------------------ the curve -- */
  const ctrl = new THREE.Vector3()
  const ctrlVel = new THREE.Vector3()
  const ctrlGoal = new THREE.Vector3()
  let ctrlFresh = true
  const p = new THREE.Vector3()
  const d = new THREE.Vector3()
  const perpA = new THREE.Vector3()
  const perpB = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  let time = 0
  let amount = 0
  let kickK = 0
  let lastMode: BeamFrame['mode'] = 'off'
  let flicker = 1

  const update = (f: BeamFrame) => {
    const dt = Math.max(0, Math.min(0.1, f.dt))
    time += dt
    kickK = Math.max(0, kickK - dt * 6)
    // fade in fast, out faster; a miss flickers like a beam finding nothing
    const want = f.mode === 'off' ? 0 : f.mode === 'miss' ? 0.55 : 1
    amount += (want - amount) * (1 - Math.exp(-dt * (want > amount ? 40 : 28)))
    if (f.mode !== 'off') lastMode = f.mode
    const live = amount > 0.02
    ribbon.visible = live
    endGlow.visible = live
    muzzleGlow.visible = live
    if (live) {
      const L = Math.max(0.01, f.muzzle.distanceTo(f.end))
      // the control point: on the aim line, three quarters of the way to the
      // grab point's projection onto it, then sprung so a fast turn whips it
      d.subVectors(f.end, f.muzzle)
      const along = Math.max(0.2, d.dot(f.forward))
      ctrlGoal.copy(f.forward).multiplyScalar(along * (lastMode === 'miss' ? 0.5 : 0.75)).add(f.muzzle)
      if (ctrlFresh || lastMode === 'miss') {
        ctrl.copy(ctrlGoal)
        ctrlVel.set(0, 0, 0)
        ctrlFresh = false
      } else {
        // critically damped at 26 rad/s, semi-implicit
        const w = 26
        tmp.subVectors(ctrlGoal, ctrl).multiplyScalar(w * w * dt)
        ctrlVel.addScaledVector(tmp, 1).multiplyScalar(1 / (1 + 2 * w * dt))
        ctrl.addScaledVector(ctrlVel, dt)
      }
      // two perpendiculars to the chord for the wobble
      d.normalize()
      perpA.set(0, 1, 0).cross(d)
      if (perpA.lengthSq() < 1e-4) perpA.set(1, 0, 0).cross(d)
      perpA.normalize()
      perpB.crossVectors(d, perpA)
      const wob = (0.02 + 0.32 * f.strain) * Math.min(1, L / 8)
      for (let i = 0; i < PTS; i++) {
        const t = i / SEGS
        const a = 1 - t
        // quadratic Bezier and its derivative
        p.copy(f.muzzle).multiplyScalar(a * a)
          .addScaledVector(ctrl, 2 * a * t)
          .addScaledVector(f.end, t * t)
        const tx = 2 * a * (ctrl.x - f.muzzle.x) + 2 * t * (f.end.x - ctrl.x)
        const ty = 2 * a * (ctrl.y - f.muzzle.y) + 2 * t * (f.end.y - ctrl.y)
        const tz = 2 * a * (ctrl.z - f.muzzle.z) + 2 * t * (f.end.z - ctrl.z)
        // wobble: two travelling sines per axis, pinned at both ends
        const env = Math.sin(Math.PI * t)
        const ph = t * L * 0.55
        const wa = (Math.sin(ph * 2.1 - time * 23) + 0.6 * Math.sin(ph * 5.3 + time * 37)) * wob * env
        const wb = (Math.sin(ph * 1.7 + time * 19 + 1.3) + 0.6 * Math.sin(ph * 4.4 - time * 31)) * wob * env
        p.addScaledVector(perpA, wa).addScaledVector(perpB, wb)
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
      if (lastMode === 'miss') flicker = 0.55 + Math.random() * 0.6
      else flicker = 1
      const k = amount * flicker * (1 + kickK * 1.6)
      u.uAmount.value = k
      u.uTime.value = time
      u.uLen.value = L
      u.uStrain.value = f.strain
      u.uPx.value = (MIN_PX * 2 * Math.tan(THREE.MathUtils.degToRad(f.fov) / 2)) / Math.max(60, f.lines)
      u.uW0.value = 0.045
      u.uW1.value = lastMode === 'miss' ? 0.03 : 0.05
      // the bite: a glow at the far end, nudged toward the camera so the
      // surface it sits on does not cut it in half
      tmp.copy(f.camera.position).sub(f.end)
      const toCam = Math.min(0.5, tmp.length() * 0.5)
      endGlow.position.copy(f.end).addScaledVector(tmp.normalize(), toCam)
      const endDist = f.camera.position.distanceTo(endGlow.position)
      const endSize = (lastMode === 'miss' ? 0.7 : 1.5) + endDist * 0.02 + f.strain * 0.6 + kickK * 1.6
      endGlow.scale.setScalar(endSize * (0.9 + 0.1 * Math.sin(time * 40)))
      endMat.opacity = 1
      endMat.color.setRGB(0.9, 2.0, 3.2).multiplyScalar(k)
      muzzleGlow.position.copy(f.muzzle)
      muzzleGlow.scale.setScalar((0.2 + kickK * 0.25) * (0.85 + 0.15 * Math.sin(time * 53)))
      muzzleMat.color.setRGB(1.1, 2.2, 3.4).multiplyScalar(Math.min(1.4, k))
    } else {
      ctrlFresh = true
    }

    /* the held prop's halo, eased on and off */
    const hk = haloOn ? 1 : 0
    haloK += (hk - haloK) * (1 - Math.exp(-dt * 18))
    holdMat.uniforms.uAmount.value = haloK * (0.8 + 0.2 * Math.sin(time * 16)) * (1 + f.strain * 0.6)

    /* the freeze flash: a hard pop, gone in a third of a second */
    if (flashOn || pop.visible) {
      flashT += dt
      const k = Math.max(0, 1 - flashT / 0.35)
      flashMat.uniforms.uAmount.value = k * k * 3
      flashMat.uniforms.uFill.value = 0.35 * k
      popMat.color.copy(FLASH).multiplyScalar(k * 1.6)
      pop.scale.setScalar(1.2 + (1 - k) * 3.5)
      if (k <= 0) {
        if (flashOn) for (const h of shellsOf(flashOn).flash) h.visible = false
        flashOn = null
        pop.visible = false
      }
    }
  }

  const holdHalo = (mesh: THREE.Object3D | null) => {
    if (mesh === haloOn) return
    if (haloOn) for (const h of shellsOf(haloOn).hold) h.visible = false
    haloOn = mesh
    if (mesh) for (const h of shellsOf(mesh).hold) h.visible = true
  }

  const flash = (mesh: THREE.Object3D | null, point: THREE.Vector3) => {
    if (flashOn) for (const h of shellsOf(flashOn).flash) h.visible = false
    flashOn = mesh
    if (mesh) for (const h of shellsOf(mesh).flash) h.visible = true
    flashT = 0
    pop.position.copy(point)
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
    u.uAmount.value = 0.001
    ribbon.visible = true
    put(endGlow, 2, 0)
    put(muzzleGlow, 2, 0.1)
    put(pop, 2, -0.1)
    put(warmShell, 3, 0.4)
    put(warmFlash, 3, -0.4)
    endMat.color.setScalar(0.001)
    muzzleMat.color.setScalar(0.001)
    popMat.color.setScalar(0.001)
  }
  const unstage = () => {
    if (!staged) return
    staged = false
    for (const o of [ribbon, endGlow, muzzleGlow, pop, warmShell, warmFlash]) o.visible = false
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
    dispose: () => {
      root.removeFromParent()
      geo.dispose()
      mat.dispose()
      glowTex.dispose()
      endMat.dispose()
      muzzleMat.dispose()
      popMat.dispose()
      holdMat.dispose()
      flashMat.dispose()
      warmShell.geometry.dispose()
    },
  }
}
