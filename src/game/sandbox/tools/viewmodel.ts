import * as THREE from 'three'
import { GLOW_ALPHA } from '../../render/pixelLook'

/*
  The physgun you hold: a chunky procedural gun at the bottom right of the
  view, and the same gun in the hand of your body when the camera is behind
  it.

  **Shape.** GMod's physgun is a boxy receiver, a drum of glowing coils, a
  stubby barrel and a claw of prongs round the emitter, and that silhouette is
  what reads as "physgun" at any size. This one keeps the silhouette and
  draws it in this world's terms: flat-shaded slabs and eight-sided drums (the
  pixel look outlines creases and silhouettes, so a chunky form reads and a
  smooth one does not), a slate body with a cream cover and ochre prongs
  picked from the look's anchor families, and the blue light showing through
  the gaps between the drum's bands rather than painted on. The prongs are
  hinged: they open when the beam takes hold and snap shut on release, the
  core brightens and the inner drum spins up with the load, so the gun itself
  says what the beam is doing.

  **Never through a wall.** The first-person copy is drawn in the same pass
  as everything else, in world space in front of the camera, but its depth is
  squeezed into the front of the depth range in the vertex shader
  (`gl_Position.z` remapped toward the near plane), so whatever the camera is
  pressed against, the gun is in front of it. That is an `onBeforeCompile`
  on ordinary standard materials with a uniform (`uVm`) switching it, so the
  third-person copy is the *same programs* with the uniform at zero: two
  programs for the whole gun, compiled under the boot cover by `stage()`,
  nothing linked on the first draw and no second render pass for the look to
  know about. The squeezed depth still differs from the world's behind it, so
  the look outlines the gun's silhouette like everything else.

  **Motion** is springs on a few numbers, all integrated semi-implicitly:
  sway (the gun lags the view and rolls into turns), bob (a figure eight off
  the walk's own gait), a kick when the beam takes hold or freezes something,
  the draw from below the frame when the tool comes out, and a strain shake
  while something heavy fights the beam. Nothing allocates per frame.
*/

const SLATE = '#5a6478'
const SLATE_DARK = '#2a2f3a'
const STEEL = '#9aa3b0'
const OCHRE = '#c08a2e'
const RUBBER = '#1e2128'

// the glow, linear and HDR: the look's ACES takes the hot one to a pale
// cyan and leaves the idle one a clear blue
const CORE_IDLE = new THREE.Color(0.02, 0.4, 1.6)
const CORE_HOT = new THREE.Color(0.08, 0.95, 2.7)

/** where the gun sits in the camera's frame, first person, and its size
    there: the bottom-right corner, a quarter of the frame, the claw about
    two thirds of the way across */
const FP_OFFSET = new THREE.Vector3(0.3, -0.26, -0.56)
const FP_SCALE = 0.34
/** the lens those two were laid out through. A different fov scales the
    gun's size and its sideways offset (never its depth) by the ratio of the
    half-angle tangents, so it fills the same corner of the frame at any
    fov the pause sheet allows */
const FP_REF_TAN = Math.tan(THREE.MathUtils.degToRad(74) / 2)
/** the gun in the body's hand, world units per model unit: a body is ~4.5
    tall and its forearm short, so the gun is drawn big enough to read */
const TP_SCALE = 2.0
/** how far under the aim the body's gun points, radians */
const TP_HIP = 0.32
/** the first-person gun's own turn in the frame (pitch, yaw, roll): yawed
    in so its flank shows and the claw points at the crosshair */
const FP_TURN = new THREE.Euler(0.03, 0.3, -0.3, 'YXZ')

const VM_KEY = 'physgun-vm-depth'

/** squeeze first-person depth into the front of the range: z' = -w + (z + w) k */
const vmCompile = function (this: THREE.Material, shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.uVm = this.userData.uVm
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uVm;')
    .replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n  gl_Position.z = mix(gl_Position.z, -gl_Position.w + (gl_Position.z + gl_Position.w) * 0.25, uVm);',
    )
}

const vmMaterial = <M extends THREE.Material>(m: M, fp: boolean): M => {
  m.userData.uVm = { value: fp ? 1 : 0 }
  m.onBeforeCompile = vmCompile
  m.customProgramCacheKey = () => VM_KEY
  return m
}

/** a light: writes the look's glow code into alpha (solid, and left out of
    the baked grade, which would grey its blue down to the sky's) */
const glowing = (m: THREE.MeshBasicMaterial) => {
  m.opacity = GLOW_ALPHA
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.ZeroFactor
  m.blendSrcAlpha = THREE.OneFactor
  m.blendDstAlpha = THREE.ZeroFactor
  return m
}

interface Mats {
  slate: THREE.MeshStandardMaterial
  dark: THREE.MeshStandardMaterial
  steel: THREE.MeshStandardMaterial
  ochre: THREE.MeshStandardMaterial
  rubber: THREE.MeshStandardMaterial
  hand: THREE.MeshStandardMaterial
  core: THREE.MeshBasicMaterial
  lens: THREE.MeshBasicMaterial
}

const makeMats = (fp: boolean): Mats => {
  const std = (c: string, rough = 0.62, metal = 0.25) =>
    vmMaterial(new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, flatShading: true }), fp)
  return {
    slate: std(SLATE),
    dark: std(SLATE_DARK, 0.7, 0.3),
    steel: std(STEEL, 0.5, 0.45),
    ochre: std(OCHRE, 0.45, 0.55),
    rubber: std(RUBBER, 0.9, 0),
    // the jelly: smooth-shaded, a little glossy, in the body's own colour
    hand: vmMaterial(new THREE.MeshStandardMaterial({ color: '#4d8fe0', roughness: 0.38, metalness: 0 }), fp),
    core: vmMaterial(glowing(new THREE.MeshBasicMaterial({ color: CORE_IDLE.clone() })), fp),
    lens: vmMaterial(glowing(new THREE.MeshBasicMaterial({ color: CORE_IDLE.clone() })), fp),
  }
}

/** geometries, shared by both copies of the gun */
interface Geos {
  list: THREE.BufferGeometry[]
  box: (w: number, h: number, d: number) => THREE.BufferGeometry
  drum: (r: number, len: number, seg?: number, r2?: number) => THREE.BufferGeometry
  /** a unit ball, scaled into a lump by its mesh */
  blob: (detail: number) => THREE.BufferGeometry
}
const makeGeos = (): Geos => {
  const list: THREE.BufferGeometry[] = []
  const cache = new Map<string, THREE.BufferGeometry>()
  const keep = (k: string, g: () => THREE.BufferGeometry) => {
    let v = cache.get(k)
    if (!v) {
      v = g()
      cache.set(k, v)
      list.push(v)
    }
    return v
  }
  return {
    list,
    box: (w, h, d) => keep(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)),
    // a cylinder lying along z
    drum: (r, len, seg = 8, r2 = r) =>
      keep(`d${r},${len},${seg},${r2}`, () => new THREE.CylinderGeometry(r2, r, len, seg).rotateX(Math.PI / 2)),
    blob: (detail) => keep(`s${detail}`, () => new THREE.IcosahedronGeometry(1, detail)),
  }
}

interface Gun {
  root: THREE.Group
  mats: Mats
  prongs: THREE.Group[]
  spinner: THREE.Object3D
  muzzle: THREE.Object3D
  hand: THREE.Object3D
}

/** the model: origin at the grip, forward is -z, a little over a unit long */
const buildGun = (g: Geos, mats: Mats, withHand: boolean): Gun => {
  const root = new THREE.Group()
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(geo, m)
    mesh.position.set(x, y, z)
    mesh.castShadow = false
    mesh.receiveShadow = false
    parent.add(mesh)
    return mesh
  }
  // the receiver: a slab with a steel cover and a dark belly
  add(g.box(0.2, 0.17, 0.32), mats.slate, 0, 0.1, 0.05)
  add(g.box(0.15, 0.06, 0.26), mats.steel, 0, 0.2, 0.07)
  add(g.box(0.17, 0.05, 0.5), mats.dark, 0, 0.0, -0.1)
  // rear cap and its knob
  add(g.drum(0.1, 0.09, 8), mats.dark, 0, 0.1, 0.22)
  add(g.drum(0.045, 0.06, 6), mats.ochre, 0, 0.1, 0.28)
  // the core drum, the gun's signature: a fat glowing cylinder behind four
  // dark bands, so the light shows through the gaps between them, and an
  // inner ring of fins that spins with the load
  add(g.drum(0.15, 0.32, 8), mats.core, 0, 0.13, -0.24)
  for (const z of [-0.09, -0.19, -0.29, -0.39]) add(g.drum(0.185, 0.04, 8), mats.dark, 0, 0.13, z)
  const spinner = new THREE.Group()
  spinner.position.set(0, 0.13, -0.24)
  root.add(spinner)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    for (const z of [-0.1, 0, 0.1]) {
      const fin = add(g.box(0.035, 0.05, 0.05), mats.ochre, Math.cos(a) * 0.175, Math.sin(a) * 0.175, z, spinner)
      fin.rotation.z = a
    }
  }
  // side coils: the blue tubes along the flanks, clamped at each end
  for (const s of [-1, 1]) {
    add(g.drum(0.026, 0.42, 6), mats.core, s * 0.125, 0.0, -0.2)
    add(g.box(0.045, 0.05, 0.05), mats.dark, s * 0.125, 0.0, -0.01)
    add(g.box(0.045, 0.05, 0.05), mats.dark, s * 0.125, 0.0, -0.4)
  }
  // a low spine over the top, and a steel fin on it
  add(g.box(0.05, 0.05, 0.36), mats.dark, 0, 0.33, -0.24)
  add(g.box(0.025, 0.07, 0.18), mats.steel, 0, 0.38, -0.2)
  // barrel, emitter collar and the lens the beam comes out of
  add(g.drum(0.085, 0.2, 8, 0.1), mats.slate, 0, 0.12, -0.5)
  add(g.drum(0.12, 0.05, 8), mats.dark, 0, 0.12, -0.6)
  add(g.drum(0.07, 0.03, 8), mats.lens, 0, 0.12, -0.63)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.12, -0.74)
  root.add(muzzle)
  // the claw: three prongs hinged at the collar
  const prongs: THREE.Group[] = []
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i / 3) * Math.PI * 2
    const hinge = new THREE.Group()
    hinge.position.set(Math.cos(a) * 0.11, 0.12 + Math.sin(a) * 0.11, -0.6)
    hinge.rotation.z = a - Math.PI / 2
    root.add(hinge)
    // local +y points out from the axis; the prong runs forward then hooks in
    add(g.box(0.045, 0.04, 0.2), mats.ochre, 0, 0, -0.1, hinge)
    const tip = add(g.box(0.04, 0.035, 0.1), mats.ochre, 0, -0.025, -0.23, hinge)
    tip.rotation.x = -0.55
    // a glowing pad on the inside of each hook: the claw lights with the core
    const pad = add(g.box(0.026, 0.02, 0.05), mats.core, 0, -0.05, -0.25, hinge)
    pad.rotation.x = -0.55
    add(g.box(0.05, 0.05, 0.05), mats.dark, 0, 0, 0, hinge)
    prongs.push(hinge)
  }
  // grip, trigger and guard
  const grip = add(g.box(0.08, 0.26, 0.11), mats.rubber, 0, -0.1, 0.06)
  grip.rotation.x = -0.28
  add(g.box(0.025, 0.06, 0.03), mats.dark, 0, -0.03, -0.05)
  add(g.box(0.03, 0.02, 0.14), mats.dark, 0, -0.07, -0.04)
  // the hand: a jelly fist round the grip in the body's own colour. The
  // body is hidden in first person, so the fist *is* the player there: a
  // soft round lump closed over the grip, a thumb over the top, and a stub
  // of wrist leaving the frame. No arm, no sleeve
  const hand = new THREE.Group()
  root.add(hand)
  if (withHand) {
    const fist = add(g.blob(1), mats.hand, 0.01, -0.09, 0.07, hand)
    fist.scale.set(0.12, 0.13, 0.13)
    fist.rotation.x = -0.28
    const knuckles = add(g.blob(1), mats.hand, -0.02, -0.03, -0.01, hand)
    knuckles.scale.set(0.1, 0.075, 0.085)
    const thumb = add(g.blob(1), mats.hand, -0.07, 0.0, 0.05, hand)
    thumb.scale.set(0.05, 0.045, 0.08)
    thumb.rotation.x = -0.3
    const wrist = add(g.blob(1), mats.hand, 0.03, -0.2, 0.2, hand)
    wrist.scale.set(0.1, 0.11, 0.16)
    wrist.rotation.x = 0.6
  }
  return { root, mats, prongs, spinner, muzzle, hand }
}

export interface ViewFrame {
  camera: THREE.PerspectiveCamera
  dt: number
  /** planar speed over the run cap, 0..1 */
  gait: number
  grounded: boolean
  /** the beam has something */
  holding: boolean
  strain: number
  /** first person: draw the viewmodel; else the body's copy */
  firstPerson: boolean
  /** third person: where the body's right hand is (world), and the aim */
  hand?: THREE.Vector3 | null
  aim?: THREE.Vector3 | null
  /** the point the gun points at (the held thing's target, or far down the
      view): the barrel is aimed at it, so the beam leaves along the barrel */
  aimAt?: THREE.Vector3 | null
  /** drawn at all (the physgun is out, nobody is driving) */
  shown: boolean
}

export interface Viewmodel {
  readonly root: THREE.Group
  /** the first-person gun */
  readonly fp: THREE.Group
  /** the body's copy */
  readonly tp: THREE.Group
  update: (f: ViewFrame) => void
  /** the beam's start and direction, off whichever copy is drawn */
  muzzle: (pos: THREE.Vector3, dir: THREE.Vector3) => void
  /** a jolt: 1 for a grab, less for a freeze or release */
  kick: (k: number) => void
  /** the hand's colour, from the body's look */
  setHandColor: (c: THREE.ColorRepresentation) => void
  stage: (camera: THREE.Camera) => void
  unstage: () => void
  dispose: () => void
}

export function createViewmodel(parent: THREE.Object3D): Viewmodel {
  const root = new THREE.Group()
  root.name = 'physgun-viewmodel'
  root.userData.dynamic = true
  parent.add(root)
  const geos = makeGeos()
  const fpGun = buildGun(geos, makeMats(true), true)
  const tpGun = buildGun(geos, makeMats(false), false)
  const fp = fpGun.root
  const tp = tpGun.root
  for (const g of [fp, tp]) {
    g.traverse((o) => {
      o.frustumCulled = false
    })
    g.visible = false
    root.add(g)
  }
  tp.scale.setScalar(TP_SCALE)
  fp.scale.setScalar(FP_SCALE)

  // springs: position offset (camera space), rotation offset (pitch, yaw,
  // roll), the prong opening, the draw
  const off = new THREE.Vector3()
  const offV = new THREE.Vector3()
  const rot = new THREE.Vector3()
  const rotV = new THREE.Vector3()
  let open = 0
  let openV = 0
  let drawn = 0
  let bob = 0
  let time = 0
  let glow = 0
  let spin = 0
  let hasLast = false
  const eul = new THREE.Euler(0, 0, 0, 'YXZ')
  const eulLast = new THREE.Euler(0, 0, 0, 'YXZ')
  const want = new THREE.Vector3()
  const wantR = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const tmp = new THREE.Vector3()
  const m4 = new THREE.Matrix4()
  const aimQ = new THREE.Quaternion()
  const xAxis = new THREE.Vector3(1, 0, 0)
  const camUp = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  let aimed = false
  const up = new THREE.Vector3(0, 1, 0)
  let usingFp = true

  const spring = (x: number, v: number, goal: number, w: number, z: number, dt: number) => {
    // implicit in the spring and the damper, so a stiff spring on a long
    // frame cannot blow up
    const nv = (v + dt * w * w * (goal - x)) / (1 + 2 * z * w * dt + w * w * dt * dt)
    return [x + nv * dt, nv] as const
  }

  const update = (f: ViewFrame) => {
    const dt = Math.max(0, Math.min(0.05, f.dt))
    time += dt
    drawn += ((f.shown ? 1 : 0) - drawn) * (1 - Math.exp(-dt * (f.shown ? 9 : 16)))
    const visible = drawn > 0.02
    usingFp = f.firstPerson
    fp.visible = visible && f.firstPerson
    tp.visible = visible && !f.firstPerson

    // look rates, from the camera's own turn this frame
    const cam = f.camera
    eul.setFromQuaternion(cam.quaternion, 'YXZ')
    let yawRate = 0
    let pitchRate = 0
    if (hasLast && dt > 0) {
      let dy = eul.y - eulLast.y
      dy = Math.atan2(Math.sin(dy), Math.cos(dy))
      yawRate = dy / dt
      pitchRate = (eul.x - eulLast.x) / dt
    }
    eulLast.copy(eul)
    hasLast = true

    // bob: a figure eight off the gait, only on the ground
    const g = f.grounded ? f.gait : 0
    bob += dt * (5 + 6 * g)
    const bx = Math.sin(bob) * 0.014 * g
    const by = -Math.abs(Math.cos(bob)) * 0.02 * g + Math.sin(time * 1.7) * 0.0035
    // sway: the gun lags the turn and rolls into it
    const sy = THREE.MathUtils.clamp(yawRate * 0.012, -0.07, 0.07)
    const sp = THREE.MathUtils.clamp(pitchRate * 0.01, -0.05, 0.05)
    want.set(bx - sy * 0.6, by - sp * 0.5 - (1 - drawn) * 0.45, 0)
    // strain shake
    const sh = f.holding ? f.strain * f.strain * 0.012 : 0
    want.x += Math.sin(time * 71) * sh
    want.y += Math.sin(time * 83 + 1) * sh
    wantR.set(sp * 1.2 + (1 - drawn) * 0.6, sy * 1.4, sy * 2.2)
    for (let i = 0; i < 3; i++) {
      const [x, v] = spring(off.getComponent(i), offV.getComponent(i), want.getComponent(i), 16, 0.75, dt)
      off.setComponent(i, x)
      offV.setComponent(i, v)
      const [rx, rv] = spring(rot.getComponent(i), rotV.getComponent(i), wantR.getComponent(i), 14, 0.7, dt)
      rot.setComponent(i, rx)
      rotV.setComponent(i, rv)
    }
    // the claw opens on a hold, with a little overshoot
    ;[open, openV] = spring(open, openV, f.holding ? 1 : 0, 22, 0.45, dt)
    for (const gun of [fpGun, tpGun]) {
      for (const pr of gun.prongs) pr.rotation.x = open * 0.42
    }
    // the core: idle, then hot with the hold, flickering with strain
    glow += ((f.holding ? 1 : 0) - glow) * (1 - Math.exp(-dt * 10))
    const flick = 0.92 + 0.08 * Math.sin(time * 37) + (f.holding ? f.strain * 0.25 * Math.sin(time * 91) : 0)
    spin += dt * (1.5 + glow * 14 + f.strain * 10)
    for (const gun of [fpGun, tpGun]) {
      gun.mats.core.color.copy(CORE_IDLE).lerp(CORE_HOT, glow).multiplyScalar(flick)
      gun.mats.lens.color.copy(CORE_IDLE).lerp(CORE_HOT, glow).multiplyScalar(flick * (1.1 + glow * 0.6))
      gun.spinner.rotation.z = spin
    }

    if (fp.visible) {
      // camera frame, then the offset, then the springs
      const k = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / FP_REF_TAN
      fp.scale.setScalar(FP_SCALE * k)
      fp.position.copy(FP_OFFSET).add(off)
      fp.position.x *= k
      fp.position.y *= k
      fp.position.applyMatrix4(cam.matrixWorld)
      // the barrel points at what the beam is aimed at; then the roll and
      // the springs' sway on top
      if (f.aimAt) {
        camUp.set(0, 1, 0).applyQuaternion(cam.quaternion)
        m4.lookAt(fp.position, f.aimAt, camUp)
        aimQ.setFromRotationMatrix(m4)
        fp.quaternion.slerp(aimQ, aimed ? 1 - Math.exp(-dt * 30) : 1)
        aimed = true
      } else {
        fp.quaternion.copy(cam.quaternion)
        fp.quaternion.multiply(q.setFromEuler(eul.set(0, FP_TURN.y, 0, 'YXZ')))
        aimed = false
      }
      eul.set(FP_TURN.x + rot.x, rot.y, FP_TURN.z + rot.z, 'YXZ')
      fp.quaternion.multiply(q.setFromEuler(eul))
    }
    if (tp.visible && f.hand) {
      tp.position.copy(f.hand)
      // a matrix's lookAt points its +z from the target back at the eye, so
      // looking from the hand at the aim point leaves -z, the gun's forward,
      // on it
      if (f.aimAt) m4.lookAt(f.hand, f.aimAt, up)
      else m4.lookAt(tmp.set(0, 0, 0), f.aim ?? tmp2.set(0, 0, -1).applyQuaternion(cam.quaternion), up)
      tp.quaternion.setFromRotationMatrix(m4)
      // held from the hip, a little under the aim: the beam leaves the
      // barrel low and arcs up to what it holds, which is what reads as a
      // beam and not a rod from over the shoulder
      tp.quaternion.multiply(q.setFromAxisAngle(xAxis, -TP_HIP))
    }
  }

  const muzzle = (pos: THREE.Vector3, dir: THREE.Vector3) => {
    const gun = usingFp ? fpGun : tpGun
    gun.root.updateMatrixWorld(true)
    gun.muzzle.getWorldPosition(pos)
    dir.set(0, 0, -1).applyQuaternion(gun.root.quaternion).normalize()
  }

  const kick = (k: number) => {
    offV.z += 1.6 * k
    rotV.x += 5 * k
  }

  let staged = false
  const stage = (camera: THREE.Camera) => {
    staged = true
    camera.updateMatrixWorld()
    fp.visible = true
    tp.visible = true
    fp.position.copy(FP_OFFSET).applyMatrix4(camera.matrixWorld)
    fp.quaternion.copy(camera.quaternion)
    tp.position.set(-0.6, -0.2, -2.5).applyMatrix4(camera.matrixWorld)
    tp.quaternion.copy(camera.quaternion)
  }
  const unstage = () => {
    if (!staged) return
    staged = false
    fp.visible = false
    tp.visible = false
  }

  return {
    root,
    fp,
    tp,
    update,
    muzzle,
    kick,
    setHandColor: (c) => {
      fpGun.mats.hand.color.set(c)
      tpGun.mats.hand.color.set(c)
    },
    stage,
    unstage,
    dispose: () => {
      root.removeFromParent()
      for (const g of geos.list) g.dispose()
      for (const gun of [fpGun, tpGun]) for (const m of Object.values(gun.mats)) (m as THREE.Material).dispose()
    },
  }
}
