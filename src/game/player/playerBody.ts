import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { createRagdoll, type RagdollEnv } from './ragdoll'
import { supportY } from '../physics/collision'

/*
  The player's body: the same stubby service robot as before, but rebuilt as
  a real articulated skeleton — pelvis/torso/head chain, two-segment arms
  and legs — so it reads as a creature from any angle, not just as scenery
  under a first-person lens. The pose is kinetic, derived from what the sim
  actually did this frame rather than which keys are down: it leans into
  acceleration and banks into turns, angles its hips toward the direction it
  strafes, tucks in a rising jump and reaches on the fall, and lands on a
  damped spring that folds the knees in proportion to the impact. The legs
  aren't a canned cycle: each sole is planted at a fixed world point, steps
  trigger on distance actually covered, the airborne foot glides to a spot
  predicted along the real velocity, and two-bone IK folds each leg over its
  foot — so side-steps, diagonals and backpedals step where the body is
  truly going, and feet never slide; ankle pivots keep the soles level with
  the floor whatever the shins are doing. The arms aren't keyframed either:
  each joint rides an underdamped spring toward its gait target, fed the
  body's own accelerations, so they lag, overshoot and settle — with the
  elbows chasing the shoulders one beat behind — and the head and chest's
  look-tracking rides the same springs, so a whipped mouse is followed with
  weight, never a snap. That tracking is both axes and both bones: the neck
  takes most of the gaze and the spine bends a little under it, so a look at
  the floor folds the body over instead of craning one joint. The showy
  parts of that layer (lean, gaze-follow) scale with pose.show, so a
  chase camera or another player sees the full performance while the
  first-person lens keeps a level, out-of-frame head. Crouch is
  analytic two-bone IK (cosine law), so the feet stay planted while the hips
  drop. The same skeleton doubles as the ragdoll: flop() hands every joint
  to the verlet sim in ragdoll.ts, update() fits the bones back over the
  particles each frame, and beginRecover() gets back up in two beats: the
  heap first gathers itself into a deep crouch with the hands planted out
  front — that is where the crumpled pose is blended away, so the limbs
  travel to a shape they can push from rather than being straightened in
  mid-air — and then stands out of it, which the ordinary stance already
  knows how to do once the fold unwinds. Everything is smoothed and allocation-
  free per frame; the whole rig is ~30 small meshes over six materials.
*/

export interface PlayerPose {
  dt: number
  /** 0..1, planar speed over the current cap */
  gait: number
  crouchK: number
  grounded: boolean
  run: boolean
  yaw: number
  pitch: number
  /** world planar velocity, units/s */
  vx: number
  vz: number
  /** vertical velocity while airborne (+ up) */
  vy: number
  /** downward speed absorbed by a touchdown this tick, else 0 */
  landing: number
  /** 0 under the first-person lens .. 1 watched from outside. Scales the
      cinematic layer — speed lean and head pitch-follow — which reads great
      from a chase camera or another player but, with the lens riding the
      head, shoves your own crown into the look-down frame */
  show: number
}

export interface PlayerRig {
  group: THREE.Group
  /** drive the skeleton one frame; env is only consulted while ragdolling */
  update: (pose: PlayerPose, env: RagdollEnv) => void
  /** hand the skeleton to the verlet sim, thrown with this velocity */
  flop: (vx: number, vy: number, vz: number) => void
  /** start blending back to the stance. The caller must have already moved
      `group` to the get-up spot (and updated its world matrix): the blend
      source is re-fitted against the group's new frame right here */
  beginRecover: () => void
  /** ragdolling or mid-recovery: movement input is forfeit */
  readonly down: boolean
  /** strictly particle-driven, i.e. the caller must not re-pose the group */
  readonly ragdolling: boolean
  /** the ragdoll has tumbled to rest long enough that a get-up looks right */
  readonly settled: boolean
  /** camera target while down: the chest particle, world space */
  focus: (out: THREE.Vector3) => THREE.Vector3
  /** where the feet should stand after a get-up (pelvis rest x/z, world) */
  getupSpot: (out: THREE.Vector3) => THREE.Vector3
  /** the body moved on its own (ragdoll, blend, landing spring): shadows
      near it should re-bake even though the walker reports standing still */
  unrest: () => boolean
  /** the yaw the body actually faces — it lags the camera while standing
      (the head covers the gap) and only pivots after a big enough turn.
      The scene orients the group with this, not the raw camera yaw */
  readonly facing: number
  /** hard-set the facing (roam start, level spawn): no lazy pivot */
  face: (yaw: number) => void
  /** report the group's cosmetic offset from the walker's true position
      (first-person trail, pitch back-slide) each frame BEFORE update: the
      planted feet ride along with its changes instead of being stretched */
  trackSlide: (x: number, z: number) => void
  /** cancel any ragdoll/blend and zero the smoothed pose (level swap) */
  reset: () => void
}

/** the eye height the proportions below were drawn for; the group scales
    itself so any actual camera height maps onto them */
const DESIGN_EYE = 3.5

// skeleton dimensions, design units, feet at y = 0
const THIGH = 0.68
const SHIN = 0.66
const HIP_Y = THIGH + SHIN
const HIP_X = 0.28
const WAIST_OFF = 0.22 // pelvis origin (hip line) up to the torso bone
const SHOULDER_X = 0.64
const SHOULDER_OFF = 0.48 // torso origin up to the shoulder line
const NECK_OFF = 0.72 // torso origin up to the head bone
const UARM = 0.48
const FARM = 0.46

// ragdoll particle indices
const P_PELV = 0
const P_CHEST = 1
const P_HEAD = 2
const P_SHL = 3
const P_SHR = 4
const P_ELL = 5
const P_ELR = 6
const P_HANDL = 7
const P_HANDR = 8
const P_KNEEL = 9
const P_KNEER = 10
const P_FOOTL = 11
const P_FOOTR = 12
const P_COUNT = 13

/** how fast the body accepts being spun or shoved before it simply stops
    answering harder: ~1.1 turns a second, and a standing start's worth of
    acceleration. Past these the pose would stop tracking the body and start
    tracking the mouse — which is what threw the arms out on a fast circle. */
const YAW_CAP = 7
const ACC_CAP = 45
const clampRate = (v: number, cap: number) => (v > cap ? cap : v < -cap ? -cap : v)

// getting up runs in two stages rather than one straight blend: the heap
// first gathers itself into a deep crouch (that's where the crumpled pose
// is blended away), then pushes up out of it. RISE_FOLD is the fraction of
// the whole spent on the fold.
const RISE_TIME = 0.92
const RISE_FOLD = 0.42
const EASE = (t: number) => 1 - Math.pow(1 - t, 3)
const SMOOTH = (t: number) => t * t * (3 - 2 * t)

export function buildPlayerBody(eye: number, grav = 34): PlayerRig {
  const group = new THREE.Group()
  group.userData.dynamic = true // never caught by the static matrix freeze

  // desk-peripheral palette: keycap cream, dark plastic, one rust accent
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#d9d4c9', roughness: 0.62 })
  const darkMat = new THREE.MeshStandardMaterial({
    color: '#2f3236', roughness: 0.55, metalness: 0.15,
  })
  const accentMat = new THREE.MeshStandardMaterial({ color: '#9d5542', roughness: 0.66 })
  const visorMat = new THREE.MeshStandardMaterial({
    color: '#12161a', roughness: 0.3, metalness: 0.2,
  })
  const eyeMat = new THREE.MeshStandardMaterial({
    color: '#0a0d10', emissive: new THREE.Color('#a9d7ff'),
    emissiveIntensity: 2.2, roughness: 0.4,
  })
  const tipMat = new THREE.MeshStandardMaterial({
    color: '#2c1c08', emissive: new THREE.Color('#ffb869'),
    emissiveIntensity: 1.6, roughness: 0.5,
  })

  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D) => {
    const m = new THREE.Mesh(geo, mat)
    m.castShadow = true
    m.frustumCulled = false // hugs the camera; culling would blink limbs out
    parent.add(m)
    return m
  }
  const bone = (parent: THREE.Object3D, x: number, y: number, z: number) => {
    const b = new THREE.Group()
    b.position.set(x, y, z)
    parent.add(b)
    return b
  }

  // --- skeleton -----------------------------------------------------------
  // limbs hang along local -Y from their joint; torso/head grow along +Y
  const pelvis = bone(group, 0, HIP_Y, 0)
  const torso = bone(pelvis, 0, WAIST_OFF, 0)
  const head = bone(torso, 0, NECK_OFF, 0)
  const uarmL = bone(torso, SHOULDER_X, SHOULDER_OFF, 0)
  const farmL = bone(uarmL, 0, -UARM, 0)
  const uarmR = bone(torso, -SHOULDER_X, SHOULDER_OFF, 0)
  const farmR = bone(uarmR, 0, -UARM, 0)
  const thighL = bone(pelvis, HIP_X, 0, 0)
  const shinL = bone(thighL, 0, -THIGH, 0)
  const thighR = bone(pelvis, -HIP_X, 0, 0)
  const shinR = bone(thighR, 0, -THIGH, 0)

  // pelvis: the dark hip block the legs plug into
  part(new RoundedBoxGeometry(0.92, 0.36, 0.58, 3, 0.12), darkMat, pelvis).position.set(0, 0.08, 0)

  // torso: cream shell, dark belly screen, one status dot (faces +z)
  part(new RoundedBoxGeometry(1.08, 0.8, 0.68, 3, 0.16), bodyMat, torso).position.set(0, 0.34, 0)
  part(new RoundedBoxGeometry(0.5, 0.4, 0.1, 3, 0.06), visorMat, torso).position.set(0, 0.28, 0.31)
  part(new THREE.SphereGeometry(0.05, 10, 8), tipMat, torso).position.set(0.3, 0.6, 0.32)

  // arms: accent ball shoulders, dark segments, cream hands
  const uarmGeo = new RoundedBoxGeometry(0.22, 0.52, 0.26, 3, 0.1)
  const farmGeo = new RoundedBoxGeometry(0.2, 0.48, 0.24, 3, 0.09)
  const armPair = (ua: THREE.Group, fa: THREE.Group) => {
    part(new THREE.SphereGeometry(0.17, 12, 10), accentMat, ua)
    part(uarmGeo, darkMat, ua).position.set(0, -0.24, 0)
    part(new THREE.SphereGeometry(0.12, 10, 8), darkMat, fa)
    part(farmGeo, darkMat, fa).position.set(0, -0.2, 0)
    const hand = part(new THREE.SphereGeometry(0.15, 12, 10), bodyMat, fa)
    hand.position.set(0, -FARM, 0)
    return hand
  }
  const handL = armPair(uarmL, farmL)
  const handR = armPair(uarmR, farmR)

  // legs: dark segments, accent knee, cream toe cap out front
  const thighGeo = new RoundedBoxGeometry(0.34, 0.66, 0.4, 3, 0.12)
  const shinGeo = new RoundedBoxGeometry(0.3, 0.56, 0.36, 3, 0.1)
  const toeGeo = new RoundedBoxGeometry(0.34, 0.2, 0.5, 3, 0.08)
  const legPair = (th: THREE.Group, sh: THREE.Group) => {
    part(thighGeo, darkMat, th).position.set(0, -0.32, 0)
    part(new THREE.SphereGeometry(0.14, 10, 8), accentMat, sh)
    part(shinGeo, darkMat, sh).position.set(0, -0.3, 0)
    // the toe cap hangs from its own ankle pivot so the sole can stay
    // level with the floor whatever the shin is doing
    const ankle = new THREE.Group()
    ankle.position.set(0, -SHIN + 0.08, 0)
    sh.add(ankle)
    part(toeGeo, bodyMat, ankle).position.set(0, 0.02, 0.09)
    const foot = new THREE.Object3D() // ragdoll anchor at the sole
    foot.position.set(0, -SHIN, 0)
    sh.add(foot)
    return { ankle, foot }
  }
  const { ankle: ankleL, foot: footL } = legPair(thighL, shinL)
  const { ankle: ankleR, foot: footR } = legPair(thighR, shinR)

  // the head: small and set back to mostly dodge the first-person frustum;
  // the headSkin toggle below finishes the job without amputating shadows
  part(new THREE.CylinderGeometry(0.13, 0.15, 0.18, 12), darkMat, head).position.set(0, 0, -0.04)
  const skull = part(new RoundedBoxGeometry(0.8, 0.62, 0.7, 3, 0.17), bodyMat, head)
  skull.position.set(0, 0.41, -0.08)
  part(new RoundedBoxGeometry(0.56, 0.3, 0.12, 3, 0.06), visorMat, head).position.set(0, 0.44, 0.24)
  ;[0.14, -0.14].forEach((x) => {
    part(new RoundedBoxGeometry(0.11, 0.15, 0.04, 2, 0.02), eyeMat, head).position.set(x, 0.44, 0.295)
  })
  const earGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12)
  ;[1, -1].forEach((side) => {
    const ear = part(earGeo, darkMat, head)
    ear.rotation.z = Math.PI / 2
    ear.position.set(side * 0.44, 0.44, -0.08)
  })
  part(new THREE.CylinderGeometry(0.028, 0.028, 0.3, 8), darkMat, head).position.set(0.18, 0.83, -0.22)
  part(new THREE.SphereGeometry(0.07, 10, 8), tipMat, head).position.set(0.18, 1.01, -0.22)

  // the head always casts shadows but must never block the lens riding it:
  // steeply pitched down, the frame bottom looks down-backward and finds
  // the crown. Its meshes get private material clones whose color/depth
  // writes switch off while pose.show says the camera is home — invisible
  // to the lens, still solid to every shadow map's depth pass
  const headSkin: THREE.Material[] = []
  head.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.material = (m.material as THREE.Material).clone()
    headSkin.push(m.material as THREE.Material)
  })
  let headShown = true
  const showHead = (v: boolean) => {
    if (headShown === v) return
    headShown = v
    headSkin.forEach((mat) => {
      mat.colorWrite = v
      mat.depthWrite = v
    })
  }

  const S = eye / DESIGN_EYE
  group.scale.setScalar(S)

  // --- ragdoll ------------------------------------------------------------
  // one anchor object per particle; radii in world units (hence the S)
  const anchors: THREE.Object3D[] = []
  anchors[P_PELV] = pelvis
  anchors[P_CHEST] = head // the bone origin is the neck base
  anchors[P_HEAD] = skull
  anchors[P_SHL] = uarmL
  anchors[P_SHR] = uarmR
  anchors[P_ELL] = farmL
  anchors[P_ELR] = farmR
  anchors[P_HANDL] = handL
  anchors[P_HANDR] = handR
  anchors[P_KNEEL] = shinL
  anchors[P_KNEER] = shinR
  anchors[P_FOOTL] = footL
  anchors[P_FOOTR] = footR
  const radii = [0.3, 0.3, 0.32, 0.18, 0.18, 0.12, 0.12, 0.14, 0.14, 0.15, 0.15, 0.16, 0.16].map(
    (r) => r * S,
  )
  const rag = createRagdoll(radii, [
    // bone edges
    { a: P_PELV, b: P_CHEST },
    { a: P_CHEST, b: P_HEAD },
    { a: P_CHEST, b: P_SHL },
    { a: P_CHEST, b: P_SHR },
    { a: P_SHL, b: P_ELL },
    { a: P_SHR, b: P_ELR },
    { a: P_ELL, b: P_HANDL },
    { a: P_ELR, b: P_HANDR },
    { a: P_PELV, b: P_KNEEL },
    { a: P_PELV, b: P_KNEER },
    { a: P_KNEEL, b: P_FOOTL },
    { a: P_KNEER, b: P_FOOTR },
    // braces: a rigid torso box, a neck that resists folding flat, and a
    // couple of very soft tethers that keep the legs in the body's orbit
    { a: P_SHL, b: P_SHR },
    { a: P_PELV, b: P_SHL },
    { a: P_PELV, b: P_SHR },
    { a: P_HEAD, b: P_SHL, stiff: 0.5 },
    { a: P_HEAD, b: P_SHR, stiff: 0.5 },
    { a: P_CHEST, b: P_KNEEL, stiff: 0.08 },
    { a: P_CHEST, b: P_KNEER, stiff: 0.08 },
  ],
    // self-collision: one-sided, so a heap can fold as tightly as it likes
    // right up to the point where a limb would pass through another. Kept
    // soft (a hard push fights the bones and buzzes) and to the pairs that
    // actually cross: left against right, and arms against the trunk they
    // swing past. Design units, scaled like the radii.
    (
      [
        { a: P_KNEEL, b: P_KNEER, min: 0.46, stiff: 0.5 },
        { a: P_FOOTL, b: P_FOOTR, min: 0.38, stiff: 0.4 },
        { a: P_ELL, b: P_ELR, min: 0.52, stiff: 0.4 },
        { a: P_HANDL, b: P_HANDR, min: 0.34, stiff: 0.35 },
        { a: P_ELL, b: P_PELV, min: 0.46, stiff: 0.45 },
        { a: P_ELR, b: P_PELV, min: 0.46, stiff: 0.45 },
        { a: P_HANDL, b: P_PELV, min: 0.42, stiff: 0.4 },
        { a: P_HANDR, b: P_PELV, min: 0.42, stiff: 0.4 },
        { a: P_HANDL, b: P_KNEEL, min: 0.34, stiff: 0.3 },
        { a: P_HANDR, b: P_KNEER, min: 0.34, stiff: 0.3 },
        { a: P_HEAD, b: P_KNEEL, min: 0.5, stiff: 0.35 },
        { a: P_HEAD, b: P_KNEER, min: 0.5, stiff: 0.35 },
      ] as const
    ).map((s) => ({ ...s, min: s.min * S })),
  grav)

  // --- state --------------------------------------------------------------
  type Mode = 'up' | 'down' | 'rising'
  let mode: Mode = 'up'
  let downTime = 0
  let riseT = 0
  let riseFold = 0 // 0 standing .. 1 gathered into the get-up crouch
  let flops = 0

  // smoothed kinetics
  let fwdS = 0 // forward speed, local
  let sideS = 0
  let accF = 0 // forward acceleration
  let accS = 0 // sideways acceleration
  let lastFwd = 0
  let lastSide = 0
  let lastYaw = 0
  let yawRateS = 0
  let strafeYaw = 0
  let airK = 0
  let fallK = 0 // within air: 0 rising .. 1 falling
  let springP = 0 // landing spring on the pelvis, design units (<= 0)
  let springV = 0
  let idleT = 0

  // the stepper: feet live in world space and only move when a step moves
  // them, so nothing ever slides. stepT advances with distance actually
  // covered — its integer part names the swinging foot, its fraction is the
  // swing phase — which makes stride direction follow the real velocity:
  // side-steps, diagonals and backpedals all step where the body is going
  let stepT = 0
  let strideNow = 1.0 // design units; sprint stretches it a little
  let needReplant = true
  let wasGrounded = true
  let mCos = 1 // smoothed travel direction in the body frame (arm swing)
  let mSin = 0
  // the body faces where it last committed, not the camera: standing, the
  // gaze wanders freely and only past ~40° do the feet pivot after it
  let facing = 0
  let facingSet = false
  let turnActive = false
  // cosmetic offsets (first-person trail, pitch back-slide) the planted
  // feet must ride along with — only real movement leaves them behind
  let slideX = 0
  let slideZ = 0
  let slideSet = false
  const plantedL = new THREE.Vector3() // current sole positions, world
  const plantedR = new THREE.Vector3()
  const swingFrom = new THREE.Vector3()
  const swingTarget = new THREE.Vector3()

  // scratch (per-frame math stays allocation-free)
  const jointW = Array.from({ length: P_COUNT }, () => new THREE.Vector3())
  const lp = Array.from({ length: P_COUNT }, () => new THREE.Vector3())
  const groupInv = new THREE.Matrix4()
  const mTmp = new THREE.Matrix4()
  const xA = new THREE.Vector3()
  const yA = new THREE.Vector3()
  const zA = new THREE.Vector3()
  const vTmp = new THREE.Vector3()
  const dirTmp = new THREE.Vector3()
  const refX = new THREE.Vector3()
  const qPelv = new THREE.Quaternion()
  const qSeg = new THREE.Quaternion()
  const qInv = new THREE.Quaternion()
  const qUpper = new THREE.Quaternion()
  const qLower = new THREE.Quaternion()
  const qGroupInv = new THREE.Quaternion()
  const qIK = new THREE.Quaternion()
  const qAir = new THREE.Quaternion()
  const eTmp = new THREE.Euler()
  const vHip = new THREE.Vector3()
  const vFoot = new THREE.Vector3()
  const vKnee = new THREE.Vector3()
  const vPole = new THREE.Vector3()
  const vRest = new THREE.Vector3()
  const vVel = new THREE.Vector3()
  const velTmp = new THREE.Vector3()

  const BONES = [
    pelvis, torso, head, uarmL, farmL, uarmR, farmR,
    thighL, shinL, ankleL, thighR, shinR, ankleR,
  ]
  const capQ = BONES.map(() => new THREE.Quaternion())
  const capPelvPos = new THREE.Vector3()

  // the damped springs everything expressive rides on — position at even
  // indices, velocity at odd. Semi-implicit Euler, with a clamp as
  // insurance against a pathological frame time.
  // 0..11: arms ([shoulderX, shoulderZ, elbow] × L/R)
  // 12: chest look-yaw · 14: head look-yaw · 16: head look-pitch
  // 18: chest look-pitch
  const sprS = new Float64Array(20)
  const spring = (
    i: number, target: number, K: number, C: number, force: number, dt: number,
    lo = -2.6, hi = 2.6,
  ) => {
    sprS[i + 1] += ((target - sprS[i]) * K - C * sprS[i + 1] + force) * dt
    sprS[i + 1] = THREE.MathUtils.clamp(sprS[i + 1], -22, 22)
    sprS[i] = THREE.MathUtils.clamp(sprS[i] + sprS[i + 1] * dt, lo, hi)
    return sprS[i]
  }
  // joint limits for the sprung arms. The springs are fed the body's own
  // inertia as a force, and mouse-look can hand them accelerations no body
  // ever feels — these are the shoulder and elbow simply running out of
  // travel, the same way a real one does.
  const SH_X_LO = -1.8
  const SH_X_HI = 1.4
  const SH_Z = 1.0
  const EL_LO = -2.5
  const EL_HI = 0.15

  const basisQuat = (q: THREE.Quaternion, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) => {
    mTmp.makeBasis(x, y, z)
    q.setFromRotationMatrix(mTmp)
  }
  /** orientation whose local -Y runs along dir, twist steadied by refX */
  const limbQuat = (q: THREE.Quaternion, dir: THREE.Vector3, refX: THREE.Vector3) => {
    yA.copy(dir).negate()
    zA.crossVectors(refX, yA)
    if (zA.lengthSq() < 1e-8) zA.set(0, 0, 1)
    zA.normalize()
    xA.crossVectors(yA, zA).normalize()
    basisQuat(q, xA, yA, zA)
  }

  /** drape the rigid skeleton over the particle cloud (group-local space) */
  const fitFromParticles = () => {
    group.updateMatrixWorld(true)
    groupInv.copy(group.matrixWorld).invert()
    for (let i = 0; i < P_COUNT; i++) lp[i].copy(rag.pts[i]).applyMatrix4(groupInv)

    // torso frame: spine up, shoulder bar sideways (braces keep it rigid)
    const up = yA.copy(lp[P_CHEST]).sub(lp[P_PELV]).normalize()
    const xa = xA.copy(lp[P_SHL]).sub(lp[P_SHR]).normalize()
    const za = zA.crossVectors(xa, up).normalize()
    xa.crossVectors(up, za).normalize()
    basisQuat(qPelv, xa, up, za)
    pelvis.position.copy(lp[P_PELV])
    pelvis.quaternion.copy(qPelv)
    torso.position.set(0, WAIST_OFF, 0)
    torso.quaternion.identity()
    qInv.copy(qPelv).invert()

    // head grows +Y toward its particle
    dirTmp.copy(lp[P_HEAD]).sub(lp[P_CHEST]).normalize()
    zA.crossVectors(xa, dirTmp)
    if (zA.lengthSq() < 1e-8) zA.set(0, 0, 1)
    zA.normalize()
    xA.crossVectors(dirTmp, zA).normalize()
    basisQuat(qSeg, xA, dirTmp, zA)
    head.quaternion.copy(qInv).multiply(qSeg)

    // a limb segment: point it from one particle at the next, convert to the
    // parent's frame, and hand the group-space quat on for its own child
    const fitLimb = (
      seg: THREE.Object3D,
      from: THREE.Vector3,
      to: THREE.Vector3,
      parentQ: THREE.Quaternion,
      out: THREE.Quaternion,
    ) => {
      dirTmp.copy(to).sub(from).normalize()
      refX.set(1, 0, 0).applyQuaternion(parentQ)
      limbQuat(qSeg, dirTmp, refX)
      out.copy(qSeg)
      seg.quaternion.copy(parentQ).invert().multiply(qSeg)
    }
    fitLimb(uarmL, lp[P_SHL], lp[P_ELL], qPelv, qUpper)
    fitLimb(farmL, lp[P_ELL], lp[P_HANDL], qUpper, qLower)
    fitLimb(uarmR, lp[P_SHR], lp[P_ELR], qPelv, qUpper)
    fitLimb(farmR, lp[P_ELR], lp[P_HANDR], qUpper, qLower)
    // legs from the pelvis frame's hip sockets
    vTmp.set(HIP_X, 0, 0).applyQuaternion(qPelv).add(lp[P_PELV])
    fitLimb(thighL, vTmp, lp[P_KNEEL], qPelv, qUpper)
    fitLimb(shinL, lp[P_KNEEL], lp[P_FOOTL], qUpper, qLower)
    vTmp.set(-HIP_X, 0, 0).applyQuaternion(qPelv).add(lp[P_PELV])
    fitLimb(thighR, vTmp, lp[P_KNEER], qPelv, qUpper)
    fitLimb(shinR, lp[P_KNEER], lp[P_FOOTR], qUpper, qLower)
    // a crumpled body's toes hang relaxed, not frozen in the last stride
    ankleL.rotation.set(0.2, 0, 0)
    ankleR.rotation.set(0.2, 0, 0)
  }

  // --- the kinetic stance -------------------------------------------------
  const animate = (pose: PlayerPose, env: RagdollEnv) => {
    const { dt, gait } = pose
    // what a sole standing at (x, z) would rest on. The reach cap keeps a
    // step from planting on top of something the body isn't standing on:
    // walk past the coffee table and the near foot must stay on the rug,
    // not levitate onto the tabletop beside it
    const reach = group.position.y + 0.45 * S
    const footGround = (x: number, z: number) =>
      supportY(x, z, reach, env.collision, env.groundY)
    idleT += dt
    const ease = (k: number) => 1 - Math.exp(-k * dt)

    // local-space kinematics: forward/side speed, forward accel, yaw rate
    const fwd = pose.vx * -Math.sin(pose.yaw) + pose.vz * -Math.cos(pose.yaw)
    const side = pose.vx * Math.cos(pose.yaw) - pose.vz * Math.sin(pose.yaw)
    fwdS += (fwd - fwdS) * ease(10)
    sideS += (side - sideS) * ease(10)
    // clamp what we *react* to, not the motion itself. A mouse flick can
    // swing the yaw tens of radians per second and a teleport can read as an
    // infinite acceleration; fed straight into the springs below, those
    // saturate them and throw the arms out sideways. A body has a ceiling on
    // how hard it can be whipped, and these are it.
    accF += (clampRate((fwd - lastFwd) / Math.max(dt, 1e-4), ACC_CAP) - accF) * ease(6)
    accS += (clampRate((side - lastSide) / Math.max(dt, 1e-4), ACC_CAP) - accS) * ease(6)
    lastFwd = fwd
    lastSide = side
    let dYaw = pose.yaw - lastYaw
    if (dYaw > Math.PI) dYaw -= Math.PI * 2
    else if (dYaw < -Math.PI) dYaw += Math.PI * 2
    yawRateS += (clampRate(dYaw / Math.max(dt, 1e-4), YAW_CAP) - yawRateS) * ease(8)
    lastYaw = pose.yaw

    // lazy facing: moving (or airborne) the body turns with the camera;
    // standing it holds its ground until the gaze is ~40° away, then
    // pivots after it (the feet shuffle home through the settle below).
    // whatever gap remains, the head and chest counter-rotate to cover
    if (!facingSet) {
      facing = pose.yaw
      facingSet = true
    }
    const speedNow = Math.hypot(pose.vx, pose.vz)
    let dFace = Math.atan2(Math.sin(pose.yaw - facing), Math.cos(pose.yaw - facing))
    if (speedNow > 0.5 || !pose.grounded) {
      facing += dFace * ease(10)
      turnActive = false
    } else {
      if (Math.abs(dFace) > 0.7) turnActive = true
      if (turnActive) {
        facing += dFace * ease(6)
        if (Math.abs(dFace) < 0.06) turnActive = false
      }
    }
    dFace = Math.atan2(Math.sin(pose.yaw - facing), Math.cos(pose.yaw - facing))
    // the look-tracking rides springs too: whip the mouse and the chest
    // catches up a beat late, the head a shade quicker — never a snap
    const chestLook = spring(12, THREE.MathUtils.clamp(dFace * 0.35, -0.5, 0.5), 60, 10, 0, dt)
    const headLook = spring(
      14,
      THREE.MathUtils.clamp((dFace - chestLook) * 0.85, -1.0, 1.0),
      90, 11, 0, dt,
    )
    // the same trick vertically — and note the sign: every bone here tilts its
    // face DOWN for a positive rotation.x (that is what folds the chest over
    // the knees in the get-up), so the gaze target is the camera pitch
    // negated. A gaze is also a neck AND a spine: the head takes the bulk of
    // it and the chest bends a little under it, so looking at the floor folds
    // the whole upper body over rather than craning one bone — which is what
    // makes the pose readable from behind, the one angle a lone neck rotation
    // is nearly invisible from. Looking down follows a little shallower than
    // looking up: the chin runs out of room against the chest long before the
    // crown does going back.
    const pitchLook = spring(
      16,
      THREE.MathUtils.clamp(-pose.pitch * (pose.pitch > 0 ? 0.55 : 0.42), -0.75, 0.6) * pose.show,
      90, 11, 0, dt,
    )
    const spineLook = spring(
      18, THREE.MathUtils.clamp(-pose.pitch * 0.16, -0.24, 0.24) * pose.show, 70, 11, 0, dt,
    )

    // landing spring: the touchdown kicks it, it argues its way back
    if (pose.landing > 0) springV -= Math.min(pose.landing, 14) * 0.055
    springV += (-90 * springP - 13 * springV) * dt
    springP = Math.max(-0.42, springP + springV * dt)

    airK += ((pose.grounded ? 0 : 1) - airK) * ease(pose.grounded ? 14 : 9)
    fallK += ((pose.vy < 0 ? 1 : 0) - fallK) * ease(7)

    // hips angle toward where the feet are actually going; chest holds the
    // camera line, so strafing reads as stepping sideways, not gliding
    // (|fwd| so a straight backpedal keeps the hips square)
    const moveAng = gait > 0.12 ? Math.atan2(sideS, Math.abs(fwdS) + 0.5) : 0
    const strafeWant = THREE.MathUtils.clamp(moveAng * 0.6, -0.6, 0.6) * Math.min(1, gait * 2)
    strafeYaw += (strafeWant - strafeYaw) * ease(7)

    const runK = pose.run ? 1 : 0
    const breathe = Math.sin(idleT * 1.9) * (1 - gait)
    const speed = Math.hypot(pose.vx, pose.vz)

    // the step clock ticks on distance covered, not on time: the integer
    // part says which foot is airborne, the fraction is its swing phase
    strideNow += (1.0 + 0.35 * runK - strideNow) * ease(4)
    const prevStep = Math.floor(stepT)
    if (pose.grounded) {
      stepT += (speed * dt) / (strideNow * S)
      // a step begun must finish even if the walker stops mid-swing
      const frac = stepT - Math.floor(stepT)
      if (speed < 0.4 && frac > 0.02) stepT = Math.min(Math.floor(stepT) + 1, stepT + dt * 3)
    }
    const stepS = Math.sin(Math.PI * stepT)

    // crouch, landing spring and the get-up fold all lower the hips; the leg
    // IK below folds the knees exactly enough that the feet stay planted
    const drop = pose.crouchK * 0.85 + riseFold * 0.8 - springP
    const hipH = THREE.MathUtils.clamp(HIP_Y - drop, Math.abs(THIGH - SHIN) + 0.06, HIP_Y)

    // pelvis: root motion — gait dip, crouch, spring; lean and bank on top
    // (the lean is outside-viewer flair: pose.show zeroes it under the lens)
    const dip = -Math.abs(stepS) * (0.045 + 0.03 * runK) * gait
    pelvis.position.set(0, hipH + dip, 0)
    // the get-up hunch is not gated by pose.show: it is the shape of the
    // action, not flair, and the lens is off the head for the whole of it
    const lean =
      (THREE.MathUtils.clamp(fwdS * 0.02 + accF * 0.02, -0.3, 0.34) + pose.crouchK * 0.24) *
        pose.show +
      riseFold * 0.5
    // centripetal lean: bank into a turn only as fast as the feet are
    // actually carrying the body — a walking mouse-turn keeps the trunk
    // upright, a sprint corner still lays it in
    const bank = THREE.MathUtils.clamp(
      -yawRateS * (0.015 + 0.035 * runK) * gait - sideS * 0.012,
      -0.22, 0.22,
    )
    // gait twist: the pelvis rotates the swing-side hip forward (stepS > 0
    // is the left foot airborne, and -y advances the +x hip); the shoulders
    // counter-rotate over it and the head steadies the gaze on top
    pelvis.rotation.set(lean * 0.55, strafeYaw - stepS * 0.1 * gait, bank * 0.45)
    torso.position.set(0, WAIST_OFF, 0)
    torso.rotation.set(
      lean * 0.45 + airK * 0.12 * fallK + spineLook,
      chestLook - strafeYaw * 0.55 + stepS * 0.12 * gait,
      bank * 0.55,
    )

    // head: keeps the gaze on the camera line, in both axes — for outside
    // viewers only; under the first-person lens the head stays level, or a
    // look down finds the crown of its own head in frame
    head.rotation.set(
      // the chin lifts out of the get-up hunch: the chest is folded 0.5 rad
      // over the knees, so a level gaze means countering most of it
      pitchLook + 0.08 * gait - airK * 0.1 + breathe * 0.015 - riseFold * 0.3,
      headLook - strafeYaw * 0.4 - stepS * 0.06 * gait,
      -bank * 0.3,
    )
    head.position.set(0, NECK_OFF + breathe * 0.018, 0)

    // --- feet: world-planted, distance-triggered, solved with 2-bone IK --
    // a planted sole is a fixed world point (nothing slides); the swinging
    // foot glides to a landing spot predicted along the real velocity
    qGroupInv.copy(group.quaternion).invert()
    // Keep each sole on its own side of the body. The swing target is the hip
    // socket plus a reach along the real velocity, and for a pure side-step
    // that reach is entirely lateral — it aims the near foot straight through
    // the far leg, which is the X-shape a strafe used to make. Clamping in the
    // body frame bounds it both ways: never across the midline, and never
    // lunged out past a side-step. Design units; z (the stride) is untouched.
    const SOLE_MIN_X = HIP_X * 0.5
    const SOLE_MAX_X = HIP_X + 0.42
    const sideClamp = (foot: THREE.Vector3, side: 1 | -1, rate: number) => {
      vTmp.copy(foot).sub(group.position).applyQuaternion(qGroupInv).multiplyScalar(1 / S)
      const own = vTmp.x * side // distance onto this leg's own side, signed
      const want = THREE.MathUtils.clamp(own, SOLE_MIN_X, SOLE_MAX_X)
      if (want === own) return
      vTmp.x = (own + (want - own) * rate) * side
      foot.copy(vTmp.multiplyScalar(S).applyQuaternion(group.quaternion).add(group.position))
    }
    const socketWorld = (side: 1 | -1, out: THREE.Vector3) => {
      out.set(side * HIP_X, 0, 0).applyQuaternion(pelvis.quaternion).add(pelvis.position)
      out.multiplyScalar(S).applyQuaternion(group.quaternion).add(group.position)
      out.y = footGround(out.x, out.z)
      return out
    }
    if (pose.grounded) {
      if (!wasGrounded || needReplant) {
        socketWorld(1, plantedL)
        socketWorld(-1, plantedR)
        stepT = Math.ceil(stepT) // no half-finished swing survives a replant
        swingFrom.copy(Math.floor(stepT) % 2 === 0 ? plantedL : plantedR)
        needReplant = false
      } else if (Math.floor(stepT) !== prevStep) {
        // footfall: the old swinger lands on its target, the other takes off
        ;(prevStep % 2 === 0 ? plantedL : plantedR).copy(swingTarget)
        swingFrom.copy(Math.floor(stepT) % 2 === 0 ? plantedL : plantedR)
      }
      const idx = Math.floor(stepT) % 2 // 0: left is airborne, 1: right
      const frac = stepT - Math.floor(stepT)
      if (speed >= 0.4 || frac > 0.02) {
        const side: 1 | -1 = idx === 0 ? 1 : -1
        const swing = idx === 0 ? plantedL : plantedR
        socketWorld(side, vRest)
        vVel.set(pose.vx, 0, pose.vz)
        // land where the hip socket will be at touchdown, plus a reach of
        // roughly half a stride further along the travel direction
        swingTarget.copy(vRest)
        if (speed > 0.3) {
          swingTarget.addScaledVector(vVel, ((1 - frac) * strideNow * S) / speed)
          swingTarget.addScaledVector(vVel, (0.42 * strideNow * S) / speed)
        }
        // clamp to this leg's own side before asking what it lands on, or a
        // side-step would sample the ground under the other foot
        sideClamp(swingTarget, side, 1)
        // the sole lands on whatever is actually under the target — the rug,
        // the coffee table, the cushion — so the lerp carries the step up or
        // down and the arc only has to add clearance over it
        swingTarget.y = footGround(swingTarget.x, swingTarget.z)
        const k = frac * frac * (3 - 2 * frac)
        swing.lerpVectors(swingFrom, swingTarget, k)
        swing.y += Math.sin(frac * Math.PI) * (0.09 + 0.07 * runK) * S * Math.min(1, speed)
      } else {
        // standing: a foot left far from its socket (turning on the spot,
        // a step that ended wide) shuffles home; otherwise feet stay put
        const settle = (foot: THREE.Vector3, side: 1 | -1) => {
          socketWorld(side, vRest)
          vTmp.subVectors(vRest, foot)
          vTmp.y = 0
          const d = vTmp.length()
          if (d < 0.03 * S) {
            foot.y = footGround(foot.x, foot.z)
            return
          }
          if (d > 0.26 * S) {
            foot.addScaledVector(vTmp.normalize(), Math.min(d, 2.6 * S * dt))
            // a tiny shuffle hop over whatever this foot is standing on
            foot.y = footGround(foot.x, foot.z) + Math.min(0.05 * S, d * 0.2)
          }
        }
        settle(plantedL, 1)
        settle(plantedR, -1)
        swingFrom.copy(idx === 0 ? plantedL : plantedR)
      }
    }

    // the standing foot is planted in world space, so a body that turns or
    // strafes past it can leave it crossed even though its target was legal.
    // Eased rather than snapped: where nothing is wrong this does nothing,
    // and where something is, the leg walks back out instead of popping.
    const unCross = ease(12)
    sideClamp(plantedL, 1, unCross)
    sideClamp(plantedR, -1, unCross)

    // two-bone IK per leg in the pelvis frame; airborne it crossfades to a
    // tuck on the rise and a reach on the fall
    const tuckThigh = -0.75 + fallK * 0.55
    const tuckShin = 1.25 - fallK * 0.9
    qInv.copy(pelvis.quaternion).invert()
    const solveLeg = (
      thigh: THREE.Group,
      shin: THREE.Group,
      ankle: THREE.Group,
      foot: THREE.Vector3,
      side: 1 | -1,
      airThighX: number,
      airShinX: number,
    ) => {
      // foot: world → body → pelvis frame
      vFoot.copy(foot).sub(group.position).applyQuaternion(qGroupInv).multiplyScalar(1 / S)
      vFoot.sub(pelvis.position).applyQuaternion(qInv)
      vHip.set(side * HIP_X, 0, 0)
      dirTmp.subVectors(vFoot, vHip)
      const L = THREE.MathUtils.clamp(dirTmp.length(), 0.25, THIGH + SHIN - 0.01)
      dirTmp.normalize()
      // knee pole: forward with a nudge outward, kept off the leg axis
      vPole.set(side * 0.12, 0, 1)
      vPole.addScaledVector(dirTmp, -vPole.dot(dirTmp))
      if (vPole.lengthSq() < 1e-6) vPole.set(0, 0, 1)
      vPole.normalize()
      const cosHip = THREE.MathUtils.clamp(
        (THIGH * THIGH + L * L - SHIN * SHIN) / (2 * THIGH * L), -1, 1,
      )
      const sinHip = Math.sqrt(1 - cosHip * cosHip)
      vKnee.copy(vHip).addScaledVector(dirTmp, THIGH * cosHip).addScaledVector(vPole, THIGH * sinHip)
      vTmp.subVectors(vKnee, vHip).normalize()
      limbQuat(qIK, vTmp, refX.set(1, 0, 0))
      qAir.setFromEuler(eTmp.set(airThighX, 0, side * 0.02))
      thigh.quaternion.copy(qIK).slerp(qAir, airK)
      // shin: from the knee toward the (possibly clamped) foot
      vTmp.copy(vHip).addScaledVector(dirTmp, L).sub(vKnee).normalize()
      refX.set(1, 0, 0).applyQuaternion(qIK)
      limbQuat(qSeg, vTmp, refX)
      qSeg.premultiply(qIK.invert()) // shin local = thigh⁻¹ · shin(pelvis)
      qAir.setFromEuler(eTmp.set(airShinX, 0, 0))
      shin.quaternion.copy(qSeg).slerp(qAir, airK)
      // ankle: counter most of the shin's sagittal tilt so the sole stays
      // level on the ground; airborne the toes droop instead of digging
      const tilt = Math.atan2(vTmp.z, -vTmp.y) // vTmp still holds the shin dir
      ankle.rotation.set(tilt * 0.85 * (1 - airK) + 0.45 * airK, 0, 0)
    }
    solveLeg(thighL, shinL, ankleL, plantedL, 1, tuckThigh, tuckShin)
    solveLeg(thighR, shinR, ankleR, plantedR, -1, tuckThigh * 0.85, tuckShin)
    wasGrounded = pose.grounded

    // arms: the targets below say where the arms WANT to be — counter-swing
    // along the travel direction, elbows pumped by a sprint, thrown out by
    // a fall — but nothing is assigned directly. Every joint rides an
    // underdamped spring toward its target, fed the body's own inertia:
    // a sprint start drags the arms back, a hard stop lets them swing
    // through and settle, a turn slings them to the outside, a landing
    // jolts them — and the elbows chase the shoulders' actual (sprung)
    // angle one beat behind, which is the follow-through
    const mag = Math.hypot(fwdS, sideS)
    if (mag > 0.5) {
      mCos += (fwdS / mag - mCos) * ease(6)
      mSin += (sideS / mag - mSin) * ease(6)
    } else {
      mCos += (1 - mCos) * ease(3)
      mSin += (0 - mSin) * ease(3)
    }
    const swingAmt = stepS * (0.55 + 0.3 * runK) * gait
    const swingF = swingAmt * mCos
    const swingS = swingAmt * mSin * 0.7
    const elbowBase = 0.2 + 0.6 * runK * gait
    const spread = 0.07 + breathe * 0.03 + airK * (0.2 + fallK * 0.35)
    const airX = airK * (0.5 - fallK * 0.25)
    // idle micro-sway: incommensurate sines, phased so the arms never
    // mirror each other exactly — stillness reads as breathing, not parking
    const idleK = 1 - gait
    const swayLX = (Math.sin(idleT * 1.7) * 0.022 + Math.sin(idleT * 0.83 + 1.3) * 0.014) * idleK
    const swayRX = (Math.sin(idleT * 1.52 + 0.7) * 0.02 + Math.sin(idleT * 0.94 + 2.1) * 0.015) * idleK
    const swayLZ = Math.sin(idleT * 1.13 + 0.4) * 0.016 * idleK
    const swayRZ = Math.sin(idleT * 1.31 + 2.6) * 0.016 * idleK
    // inertial forces on the springs
    const throwX = accF * 0.05
    const slingZ = -yawRateS * 0.35 - accS * 0.045
    if (pose.landing > 0) {
      const jolt = Math.min(pose.landing, 12) * 0.06
      sprS[1] -= jolt
      sprS[7] -= jolt * 0.85
      sprS[3] += jolt * 0.35
      sprS[9] += jolt * 0.35
      // a nod is the face going down, i.e. positive on both of these
      sprS[17] += jolt * 0.5 // the head nods into a hard landing
      sprS[19] += jolt * 0.25 // and the chest folds a little under it
    }
    const KS = 70
    const CS = 9 // underdamped on purpose: the overshoot is the liveliness
    const KE = 52
    const CE = 7.5
    // the get-up plants both hands out front and pushes off them; because
    // these are spring targets the arms swing there and settle rather than
    // snapping, which is what sells the shove
    const push = riseFold * 0.8
    // contralateral phase: stepS > 0 is the LEFT foot swinging forward, so
    // the left arm's target goes back (+x) while the right one reaches
    // forward (-x is forward — the elbows below only flex that way)
    const shLX = spring(0, swingF - airX + swayLX - push, KS, CS, throwX, dt, SH_X_LO, SH_X_HI)
    const shLZ = spring(
      2, spread + swingS + swayLZ + riseFold * 0.14, KS, CS, slingZ, dt, -SH_Z, SH_Z,
    )
    const elL = spring(
      4, -(elbowBase + Math.max(0, -shLX) * 0.75 + airK * 0.35 + riseFold * 0.5),
      KE, CE, 0, dt, EL_LO, EL_HI,
    )
    const shRX = spring(
      6, -swingF * 0.93 - airX + swayRX - push, KS, CS, throwX, dt, SH_X_LO, SH_X_HI,
    )
    const shRZ = spring(
      8, -spread + swingS + swayRZ - riseFold * 0.14, KS, CS, slingZ, dt, -SH_Z, SH_Z,
    )
    const elR = spring(
      10, -(elbowBase + 0.03 + Math.max(0, -shRX) * 0.75 + airK * 0.35 + riseFold * 0.5),
      KE, CE, 0, dt, EL_LO, EL_HI,
    )
    uarmL.rotation.set(shLX, 0, shLZ)
    farmL.rotation.set(elL, 0, 0)
    uarmR.rotation.set(shRX, 0, shRZ)
    farmR.rotation.set(elR, 0, 0)
  }

  const captureBlendSource = () => {
    BONES.forEach((b, i) => capQ[i].copy(b.quaternion))
    capPelvPos.copy(pelvis.position)
  }
  const applyBlend = (k: number) => {
    BONES.forEach((b, i) => {
      qSeg.copy(b.quaternion)
      b.quaternion.slerpQuaternions(capQ[i], qSeg, k)
    })
    pelvis.position.lerpVectors(capPelvPos, pelvis.position, k)
  }

  return {
    group,
    get down() {
      return mode !== 'up'
    },
    get ragdolling() {
      return mode === 'down'
    },
    get settled() {
      return mode === 'down' && downTime > 0.65 && rag.motion() < 0.9
    },
    focus: (out) => out.copy(rag.pts[P_CHEST]),
    getupSpot: (out) => out.copy(rag.pts[P_PELV]),
    unrest: () =>
      mode !== 'up' || Math.abs(springP) > 0.004 || Math.abs(springV) > 0.05 || airK > 0.02,
    get facing() {
      return facing
    },
    face: (yaw) => {
      facing = yaw
      facingSet = true
      turnActive = false
    },
    trackSlide: (x, z) => {
      if (slideSet && mode !== 'down') {
        const dx = x - slideX
        const dz = z - slideZ
        if (dx !== 0 || dz !== 0) {
          plantedL.x += dx
          plantedL.z += dz
          plantedR.x += dx
          plantedR.z += dz
          swingFrom.x += dx
          swingFrom.z += dz
          swingTarget.x += dx
          swingTarget.z += dz
        }
      }
      slideX = x
      slideZ = z
      slideSet = true
    },
    flop: (vx, vy, vz) => {
      group.updateMatrixWorld(true)
      for (let i = 0; i < P_COUNT; i++) anchors[i].getWorldPosition(jointW[i])
      rag.start(jointW, velTmp.set(vx, vy, vz), 0x51ab0 + flops++)
      mode = 'down'
      downTime = 0
    },
    beginRecover: () => {
      if (mode !== 'down') return
      fitFromParticles() // against the group's new frame — see the interface
      captureBlendSource()
      mode = 'rising'
      riseT = 0
      riseFold = 1 // the first frame of the rise is already the deep fold
      needReplant = true // fresh footing under the get-up spot
    },
    reset: () => {
      mode = 'up'
      downTime = 0
      riseT = 0
      riseFold = 0
      springP = 0
      springV = 0
      airK = 0
      fallK = 0
      fwdS = 0
      sideS = 0
      accF = 0
      lastFwd = 0
      yawRateS = 0
      strafeYaw = 0
      accS = 0
      lastSide = 0
      sprS.fill(0)
      needReplant = true // the body teleported; feet must not IK across it
      facingSet = false
      turnActive = false
      slideSet = false
    },
    update: (pose, env) => {
      showHead(pose.show > 0.12)
      if (mode === 'down') {
        downTime += pose.dt
        rag.step(pose.dt, env)
        fitFromParticles()
        return
      }
      // the get-up in two beats. Beat one gathers the heap into a deep
      // crouch — that is where the crumpled pose is blended out, so the
      // limbs travel to a shape they can push from rather than being
      // straightened in mid-air. Beat two stands out of the crouch, which
      // the ordinary stance already knows how to do: riseFold just unwinds
      // and every spring in animate() follows it up.
      if (mode === 'rising') {
        riseT = Math.min(1, riseT + pose.dt / RISE_TIME)
        const stand = Math.max(0, (riseT - RISE_FOLD) / (1 - RISE_FOLD))
        riseFold = 1 - SMOOTH(stand)
      }
      animate(pose, env)
      if (mode === 'rising') {
        applyBlend(EASE(Math.min(1, riseT / RISE_FOLD)))
        if (riseT >= 1) {
          mode = 'up'
          riseFold = 0
        }
      }
    },
  }
}
