import * as THREE from 'three'
import {
  ellipsoid, roundCone, segDist, smax, smin, surfaceNets, type Field,
} from './isoSurface'

/*
  The drawing of the player character: one skinned surface, built once per
  variant and shared by every body in the world.

  The character is a bean in the Fall Guys mould: a slim, soft capsule whose
  top is the head, a face set into the front of it, short stubby arms that
  grow out of the flanks and end in mittens, and two stumpy legs under it.
  It is **one surface**. The body is written as a signed distance field (a
  round cone for the bean, round cones for the limbs, ellipsoids for the
  feet and the mittens) joined by a smooth minimum with a generous blend
  where a limb meets the bean, polygonized once (`isoSurface.ts`), with its
  normals taken from the field's gradient. There is nothing to line up and
  nothing to tape on: the fillet at a shoulder or a hip is simply what the
  field looks like there.

  The two drawings before it are worth keeping as warnings. A jelly brawler
  built as separate parametric parts (a lathe for the trunk, tubes for the
  arms, ellipsoid feet) read, up close, as exactly that: parts pushed into
  each other, with a visible ring where every limb went in and a ball for
  every hand. And a worker in a suit read as too cute and too much like the
  game whose *rendering* the owner wanted, not its cast.

  Skin weights follow the same idea. Each vertex asks every part how far
  away it is, and parts within a blend radius of the nearest share it, so
  the fillet at a shoulder belongs half to the torso and half to the upper
  arm and a raised arm stretches the flank with it rather than swinging a
  sausage out of a hole. Inside a part the weights run smoothly along its
  chain (pelvis, torso, head up the bean; upper arm, forearm, hand along an
  arm), four influences, normalized. Two more things keep the one surface
  from folding over itself when it bends, which is what linear blend
  skinning does to any sharp joint: the weights are smoothed over the skin
  itself wherever it is shared between the bean and a limb, and each
  shoulder and hip has a helper bone on the same pivot that turns with part
  of its limb (HELPERS), so a raised arm is two soft bends, not one crease.
  `npm run measure -- body folds` counts what still folds on every
  filmstrip; `npm run shoot -- body:folds --raw` shows where.

  The arms are drawn in an A-pose, not hanging. That is the one thing the
  bind pose has to get right for a single surface: an arm authored against
  the flank is fused to it along its whole length by the blend, and the
  first time it swings out it drags a web of body with it. So the bind pose
  holds the arms out at ARM_BIND, the skeleton's rest (every rotation
  identity) still hangs them straight down, and the difference lives in the
  inverse bind matrices (`bindMatrixWorld`), so nothing that poses the rig
  had to change.

  What is *not* geometry: the face, the costume's pattern and the blink are
  painted in the fragment shader (`bodyMaterial.ts`) from the vertex's bind
  position, because a painted shape on a smooth surface is crisp at any
  resolution and costs no variant. A variant is a (headgear, build) pair;
  the headgear pieces are their own closed fields polygonized at a finer
  step and concatenated into the same buffer, so a body is still one draw
  call whatever it wears.

  Everything here is in *design units*, feet at y = 0, facing +Z. Headless:
  plain arithmetic, typed arrays and a BufferGeometry, nothing that needs a
  document or a GL context, so `npm run measure -- body` builds every
  variant in Node.
*/

/* ---------------------------------------------------------- dimensions -- */

export const THIGH = 0.36
export const SHIN = 0.34
/** the hip joints' height over the soles: inside the bean, which the stubby
    legs come out of */
export const HIP_Y = THIGH + SHIN // 0.70
export const HIP_X = 0.24
/** the foot bone's height over its sole */
export const ANKLE_H = 0.1
/** pelvis bone up to the torso bone. The bean is weighted across it */
export const WAIST_OFF = 0.3
/** the shoulder joints sit just inside the flank, so an arm grows out of it */
export const SHOULDER_X = 0.5
export const SHOULDER_OFF = 0.62
/** torso bone up to the head bone: where the bean stops being body and
    starts being head, which is only ever a matter of weights */
export const NECK_OFF = 0.95
/** stubby arms: a hanging mitten reaches the bottom of the bean */
export const UARM = 0.38
export const FARM = 0.34
/** head bone up to the eyes */
export const EYE_OFF = 0.24
/** head bone up to the top of the bean */
export const CROWN_OFF = 0.72
/** the A-pose the arms are drawn in, radians out from hanging. See the header */
export const ARM_BIND = 0.85

/* ------------------------------------------------------------ bones ----- */

/** bone slots, in skeleton order. `playerBody.ts` builds a THREE.Bone for
    each at these rest offsets; the geometry below is weighted by index.
    POM is the knot at the back of the head (a band's or bandana's tails
    swing off it), PACK the belly, a jiggle bone the front of the bean is
    partly weighted to, and EYES only a pivot the blink is read off: both of
    the latter two keep old names because the rig's springs are keyed on them */
export const B = {
  PELVIS: 0,
  TORSO: 1,
  HEAD: 2,
  UARM_L: 3,
  FARM_L: 4,
  HAND_L: 5,
  UARM_R: 6,
  FARM_R: 7,
  HAND_R: 8,
  THIGH_L: 9,
  SHIN_L: 10,
  FOOT_L: 11,
  THIGH_R: 12,
  SHIN_R: 13,
  FOOT_R: 14,
  EYES: 15,
  POM: 16,
  PACK: 17,
  // helpers: a shoulder and a hip at each limb's own pivot that turn with
  // a share of the limb (HELPERS), so the skin round a joint bends
  // over two bones instead of one. See the note above `followHelpers`
  // in playerBody.ts
  SHOULDER_L: 18,
  SHOULDER_R: 19,
  HIP_L: 20,
  HIP_R: 21,
} as const
export const BONE_COUNT = 22
/** each helper, the limb bone it follows, and how much of that limb's
    rotation it takes */
export const HELPERS: ReadonlyArray<readonly [number, number, number]> = [
  [B.SHOULDER_L, B.UARM_L, 0.5], [B.SHOULDER_R, B.UARM_R, 0.5],
  [B.HIP_L, B.THIGH_L, 0.55], [B.HIP_R, B.THIGH_R, 0.55],
]

/*
  The builds: every body is one of five beans, the same drawing with a
  different bottom radius, top radius and dome height. The eye line never
  moves, because it is what every camera agrees with (see playerBody's
  DESIGN_EYE), so "tall" is a dome that rises further over the eyes and
  "stubby" one that barely clears them.
*/
interface Build {
  /** bottom and top sphere radii of the bean */
  rb: number
  rt: number
  /** their centres' heights */
  yb: number
  yt: number
  /** front-to-back depth over width */
  zs: number
}
const BUILD_DEFS: Build[] = [
  { rb: 0.53, rt: 0.45, yb: 0.95, yt: 2.22, zs: 0.86 }, // the bean
  { rb: 0.62, rt: 0.5, yb: 1.02, yt: 2.17, zs: 0.9 }, // chubby
  { rb: 0.45, rt: 0.41, yb: 0.9, yt: 2.3, zs: 0.84 }, // slim
  { rb: 0.5, rt: 0.43, yb: 0.93, yt: 2.52, zs: 0.86 }, // tall
  { rb: 0.58, rt: 0.5, yb: 0.98, yt: 2.07, zs: 0.9 }, // stubby
]
export const BUILD_COUNT = BUILD_DEFS.length
const clampBuild = (b: number) => Math.max(0, Math.min(BUILD_COUNT - 1, Math.floor(b)))
/** how much wider than the default bean each build is: the rig holds the
    arms that much further out, so a hanging arm never sinks into the flank */
export const buildGirth = (b: number) => BUILD_DEFS[clampBuild(b)].rb / BUILD_DEFS[0].rb
/** the bottom of the default bean over the soles */
export const BODY_Y0 = BUILD_DEFS[0].yb - BUILD_DEFS[0].rb
/** the eyes, and the middle of the face panel the shader paints */
export const EYE_Y = HIP_Y + WAIST_OFF + NECK_OFF + EYE_OFF // 2.19

/** parent slot of each bone (-1: hangs off the group) and its offset from
    that parent at rest, design units */
export const BONE_REST: Array<{ parent: number; at: [number, number, number] }> = [
  { parent: -1, at: [0, HIP_Y, 0] }, // pelvis
  { parent: B.PELVIS, at: [0, WAIST_OFF, 0] }, // torso
  { parent: B.TORSO, at: [0, NECK_OFF, 0] }, // head
  { parent: B.TORSO, at: [SHOULDER_X, SHOULDER_OFF, 0] }, // upper arm L (+x)
  { parent: B.UARM_L, at: [0, -UARM, 0] },
  { parent: B.FARM_L, at: [0, -FARM, 0] },
  { parent: B.TORSO, at: [-SHOULDER_X, SHOULDER_OFF, 0] }, // upper arm R
  { parent: B.UARM_R, at: [0, -UARM, 0] },
  { parent: B.FARM_R, at: [0, -FARM, 0] },
  { parent: B.PELVIS, at: [HIP_X, 0, 0] }, // thigh L
  { parent: B.THIGH_L, at: [0, -THIGH, 0] },
  { parent: B.SHIN_L, at: [0, -SHIN + ANKLE_H, 0] },
  { parent: B.PELVIS, at: [-HIP_X, 0, 0] }, // thigh R
  { parent: B.THIGH_R, at: [0, -THIGH, 0] },
  { parent: B.SHIN_R, at: [0, -SHIN + ANKLE_H, 0] },
  { parent: B.HEAD, at: [0, EYE_OFF, 0.38] }, // eyes (blink pivot)
  // the knot at the back that tails swing off, on the head's own surface
  { parent: B.HEAD, at: [0, EYE_OFF + 0.2, -0.38] },
  { parent: B.TORSO, at: [0, 0.0, 0.42] }, // belly
  { parent: B.TORSO, at: [SHOULDER_X, SHOULDER_OFF, 0] }, // shoulder helper L
  { parent: B.TORSO, at: [-SHOULDER_X, SHOULDER_OFF, 0] }, // shoulder helper R
  { parent: B.PELVIS, at: [HIP_X, 0, 0] }, // hip helper L
  { parent: B.PELVIS, at: [-HIP_X, 0, 0] }, // hip helper R
]

/** each bone's rest position in the model's frame, design units */
export const boneRestWorld = (i: number, out: THREE.Vector3): THREE.Vector3 => {
  out.set(0, 0, 0)
  for (let b = i; b !== -1; b = BONE_REST[b].parent) {
    const [x, y, z] = BONE_REST[b].at
    out.x += x
    out.y += y
    out.z += z
  }
  return out
}

/** the rotation each bone is *drawn* at: identity except the upper arms,
    held out in the A-pose */
const bindRot = (i: number) =>
  i === B.UARM_L ? ARM_BIND : i === B.UARM_R ? -ARM_BIND
    : i === B.SHOULDER_L ? ARM_BIND * HELPERS[0][2] : i === B.SHOULDER_R ? -ARM_BIND * HELPERS[1][2] : 0
/** a bone's world matrix in the bind pose (what the mesh was drawn around);
    the inverse bind matrices are these inverted */
export const bindMatrixWorld = (i: number, out: THREE.Matrix4): THREE.Matrix4 => {
  const chain: number[] = []
  for (let b = i; b !== -1; b = BONE_REST[b].parent) chain.unshift(b)
  out.identity()
  const m = new THREE.Matrix4()
  for (const b of chain) {
    const [x, y, z] = BONE_REST[b].at
    m.makeRotationZ(bindRot(b)).setPosition(x, y, z)
    out.multiply(m)
  }
  return out
}

/** the bones the first-person lens must not see: the head and its children */
export const HEAD_BONES: ReadonlySet<number> = new Set([B.HEAD, B.EYES, B.POM])

/* ------------------------------------------------------------ colours --- */

/** what a vertex is painted with. SUIT, TRIM, ACCENT and GLOW are the look's
    four (`PlayerLook`'s body, outfit detail, headgear and eyes); SKIN is the
    face panel (the shader picks cream or ink from the eye colour) */
export const ROLE = {
  SKIN: 0,
  SUIT: 1,
  TRIM: 2,
  ACCENT: 3,
  GLOW: 4,
  INK: 5,
  CHEEK: 6,
  GLINT: 7,
  HAIR: 8,
} as const
/** no longer stamped on any vertex (the lens hides the whole body), kept so
    the role layout is stable */
export const HEAD_FLAG = 16

/* ------------------------------------------------------------- the bean -- */

/** the numbers a variant is built from, resolved per build */
interface Frame {
  /** which build this is */
  index: number
  bd: Build
  bean: Field
  /** the bean's horizontal radius (x) at a height, and its depth there */
  rx: (y: number) => number
  /** the arms and legs as separate fields, for the weights */
  arm: [Field, Field]
  leg: [Field, Field]
  /** the whole body */
  body: Field
  sh: [THREE.Vector3, THREE.Vector3]
  dir: [THREE.Vector3, THREE.Vector3]
  /** the blend radius where an arm (0 left, 1 right) or a leg meets the
      bean, at a point: the fillet the field draws, and the band the
      weights are shared over, which must be the same thing */
  armK: (k: 0 | 1, x: number, y: number, z: number) => number
  legK: (y: number) => number
}

/** Math.hypot is several times slower than this in V8, and the fields are
    evaluated a few hundred thousand times per variant */
const len = (a: number, b: number, c = 0) => Math.sqrt(a * a + b * b + c * c)

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

const FRAMES: Array<Frame | null> = new Array(BUILD_COUNT).fill(null)
const frameFor = (b: number): Frame => {
  const cached = FRAMES[b]
  if (cached) return cached
  const bd = BUILD_DEFS[b]
  const cone = roundCone(0, bd.yb, 0, 0, bd.yt, 0, bd.rb, bd.rt)
  const izs = 1 / bd.zs
  const bean: Field = (x, y, z) => cone(x, y, z * izs)
  // the horizontal radius at a height, by bisection on the field itself, so
  // headgear can sit on whatever the build drew; tabulated, because the
  // weights ask it once per vertex
  const radiusAt = (y: number) => {
    let a = 0
    let c = 1.5
    if (bean(0, y, 0) > 0) return 0
    for (let k = 0; k < 30; k++) {
      const m = (a + c) / 2
      if (bean(m, y, 0) < 0) a = m
      else c = m
    }
    return a
  }
  const TAB = 128
  const top = bd.yt + bd.rt
  const tab = new Float32Array(TAB + 1)
  for (let i = 0; i <= TAB; i++) tab[i] = radiusAt((i / TAB) * top)
  const rx = (y: number) => {
    const u = Math.max(0, Math.min(TAB, (y / top) * TAB))
    const i = Math.min(TAB - 1, Math.floor(u))
    return tab[i] + (tab[i + 1] - tab[i]) * (u - i)
  }

  const m = new THREE.Matrix4()
  const sh: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()]
  const dir: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()]
  const arms: Field[] = []
  const armRoot: THREE.Vector3[] = []
  const armTip: THREE.Vector3[] = []
  ;([[B.UARM_L, 1], [B.UARM_R, -1]] as const).forEach(([ub, side], k) => {
    const S = sh[k].setFromMatrixPosition(bindMatrixWorld(ub, m))
    const d = dir[k].set(side * Math.sin(ARM_BIND), -Math.cos(ARM_BIND), 0)
    const E = S.clone().addScaledVector(d, UARM)
    const W = E.clone().addScaledVector(d, FARM)
    // the arm starts fat inside the flank and tapers to the wrist: no
    // shoulder ball, no cuff
    const upper = roundCone(S.x, S.y, S.z, E.x, E.y, E.z, 0.15, 0.118)
    const fore = roundCone(E.x, E.y, E.z, W.x, W.y, W.z, 0.118, 0.098)
    // the mitten: a soft paddle a little wider than the wrist, flattened
    // palm to back (the palm faces the body), part of the same surface
    const C = W.clone().addScaledVector(d, 0.1)
    // in the arm's plane, perpendicular to it, toward the body
    const n = new THREE.Vector3(-side * Math.cos(ARM_BIND), -Math.sin(ARM_BIND), 0)
    const wz = new THREE.Vector3(0, 0, 1)
    const mitt = ellipsoid(C.x, C.y, C.z, 0.085, 0.15, 0.125, [n.x, n.y, n.z, d.x, d.y, d.z, wz.x, wz.y, wz.z])
    // and a thumb nub on the front edge, grown out of the mitten
    const T0 = W.clone().addScaledVector(d, 0.04).addScaledVector(wz, 0.07)
    const T1 = W.clone().addScaledVector(d, 0.11).addScaledVector(wz, 0.14).addScaledVector(n, 0.02)
    const thumb = roundCone(T0.x, T0.y, T0.z, T1.x, T1.y, T1.z, 0.05, 0.042)
    arms.push((x, y, z) =>
      smin(smin(smin(upper(x, y, z), fore(x, y, z), 0.06), mitt(x, y, z), 0.08), thumb(x, y, z), 0.05))
    armRoot.push(S.clone())
    armTip.push(W.clone().addScaledVector(d, 0.25))
  })

  const legs: Field[] = []
  for (const side of [1, -1]) {
    // drawn a hair wider than the hip bones and a little slimmer than the
    // arms are long: two stumps closer than a couple of grid cells are one
    // stump with a web between them, and a web folds the moment one leg
    // swings forward and the other back
    const x = side * (HIP_X + 0.03)
    const stump = roundCone(x, HIP_Y + 0.06, 0, x, ANKLE_H + 0.06, 0.0, 0.165, 0.14)
    // a rounded stub of a foot pushed a little forward, the sole flattened
    const foot = ellipsoid(x, 0.1, 0.07, 0.14, 0.12, 0.21)
    legs.push((px, py, pz) => smax(smin(stump(px, py, pz), foot(px, py, pz), 0.1), -py, 0.03))
  }

  const [aL, aR] = arms
  const [lL, lR] = legs
  const [SL, SR] = armRoot
  const [TL, TR] = armTip
  // a part further than this past its own bone cannot reach the blend, so
  // it is not evaluated at all: most of the grid is nowhere near an arm
  const ARM_R = 0.16 + 0.23
  const LEG_R = 0.3 + 0.2
  // a generous fillet where an arm leaves the flank, tightening along it so
  // the arm is free of the body well before the elbow
  const armK = (k: 0 | 1, x: number, y: number, z: number) => {
    const S = k === 0 ? SL : SR
    const ds = Math.sqrt((x - S.x) ** 2 + (y - S.y) ** 2 + (z - S.z) ** 2)
    return 0.025 + 0.2 * (1 - smooth(0.1, 0.36, ds))
  }
  // and the same where the legs leave the bottom of the bean
  const legK = (y: number) => 0.03 + 0.15 * smooth(0.28, 0.5, y)
  const body: Field = (x, y, z) => {
    let d = bean(x, y, z)
    if (segDist(x, y, z, SL.x, SL.y, SL.z, TL.x, TL.y, TL.z) - ARM_R < d) d = smin(d, aL(x, y, z), armK(0, x, y, z))
    if (segDist(x, y, z, SR.x, SR.y, SR.z, TR.x, TR.y, TR.z) - ARM_R < d) d = smin(d, aR(x, y, z), armK(1, x, y, z))
    const kl = legK(y)
    if (segDist(x, y, z, HIP_X + 0.03, HIP_Y + 0.06, 0, HIP_X + 0.03, 0.1, 0.07) - LEG_R < d) d = smin(d, lL(x, y, z), kl)
    if (segDist(x, y, z, -HIP_X - 0.03, HIP_Y + 0.06, 0, -HIP_X - 0.03, 0.1, 0.07) - LEG_R < d) d = smin(d, lR(x, y, z), kl)
    return d
  }
  const f: Frame = { index: b, bd, bean, rx, arm: [aL, aR], leg: [lL, lR], body, sh, dir, armK, legK }
  FRAMES[b] = f
  return f
}

/* ------------------------------------------------------------ weights --- */

/** a vertex's bones and weights along the bean: pelvis into torso into
    head by height, with the front of the belly partly on its jiggle bone */
const beanChain = (fr: Frame, x: number, y: number, z: number, acc: Float32Array, w: number) => {
  void x
  const kPT = smooth(0.8, 1.4, y)
  const kTH = smooth(1.72, 2.16, y)
  let pel = 1 - kPT
  let tor = kPT * (1 - kTH)
  const hed = kTH
  const r = Math.max(0.2, fr.rx(Math.min(Math.max(y, fr.bd.yb), fr.bd.yt)) * fr.bd.zs)
  const front = smooth(0.15, 0.85, z / r)
  const band = Math.max(0, 1 - Math.abs(y - 1.0) / 0.5)
  const belly = 0.55 * front * band * band
  pel *= 1 - belly
  tor *= 1 - belly
  // the flesh round a shoulder or a hip goes with the helper there
  for (let k = 0; k < 2; k++) {
    const S = fr.sh[k]
    const cS = 1 - smooth(0.12, 0.4, len(x - S.x, y - S.y, z - S.z))
    acc[k === 0 ? B.SHOULDER_L : B.SHOULDER_R] += w * tor * cS
    tor *= 1 - cS
    const hx = k === 0 ? HIP_X : -HIP_X
    const cH = 1 - smooth(0.12, 0.4, len(x - hx, y - HIP_Y, z))
    acc[k === 0 ? B.HIP_L : B.HIP_R] += w * pel * cH
    pel *= 1 - cH
  }
  acc[B.PELVIS] += w * pel
  acc[B.TORSO] += w * tor
  acc[B.HEAD] += w * hed
  acc[B.PACK] += w * belly
}

const armChain = (fr: Frame, k: 0 | 1, x: number, y: number, z: number, acc: Float32Array, w: number) => {
  const S = fr.sh[k]
  const d = fr.dir[k]
  const s = (x - S.x) * d.x + (y - S.y) * d.y + (z - S.z) * d.z
  const kE = smooth(UARM - 0.2, UARM + 0.16, s)
  const kW = smooth(UARM + FARM - 0.1, UARM + FARM + 0.08, s)
  const [ua, fa, ha] = k === 0 ? [B.UARM_L, B.FARM_L, B.HAND_L] : [B.UARM_R, B.FARM_R, B.HAND_R]
  // the root of the arm shares with the shoulder helper
  const root = 0.5 * (1 - smooth(0.0, 0.2, s))
  acc[k === 0 ? B.SHOULDER_L : B.SHOULDER_R] += w * (1 - kE) * root
  acc[ua] += w * (1 - kE) * (1 - root)
  acc[fa] += w * kE * (1 - kW)
  acc[ha] += w * kE * kW
}

const legChain = (k: 0 | 1, y: number, z: number, acc: Float32Array, w: number) => {
  const [th, sn, ft] = k === 0 ? [B.THIGH_L, B.SHIN_L, B.FOOT_L] : [B.THIGH_R, B.SHIN_R, B.FOOT_R]
  const kK = smooth(HIP_Y - THIGH - 0.16, HIP_Y - THIGH + 0.16, y)
  const kF = (1 - smooth(ANKLE_H - 0.02, ANKLE_H + 0.2, y)) * (0.6 + 0.4 * smooth(-0.05, 0.14, z))
  // and the top of a leg with the hip helper
  const root = 0.7 * smooth(HIP_Y - 0.34, HIP_Y - 0.06, y)
  acc[k === 0 ? B.HIP_L : B.HIP_R] += w * kK * root
  acc[th] += w * kK * (1 - root)
  acc[sn] += w * (1 - kK) * (1 - kF)
  acc[ft] += w * (1 - kK) * kF
}

/** how much wider than the fillet the weights are shared over: a little,
    so the weights change more slowly than the shape does. The band follows
    the fillet (wide at the shoulder, tight down the arm), because a single
    radius everywhere gave the flank beside a hanging elbow a share of the
    arm, and swinging the arm out dragged a web of body with it, stretched
    six times over */
const SHARE_K = 1.1
const acc = new Float32Array(BONE_COUNT)
/** weights for a point of the body, written as 4 indices + 4 weights; also
    returns how much of it is bean and how much leg (for the paint) */
const weighBody = (
  fr: Frame, x: number, y: number, z: number, full: Float32Array, o: number, part: Float32Array, po: number,
) => {
  acc.fill(0)
  const d0 = fr.bean(x, y, z)
  const d1 = fr.arm[0](x, y, z)
  const d2 = fr.arm[1](x, y, z)
  const d3 = fr.leg[0](x, y, z)
  const d4 = fr.leg[1](x, y, z)
  // each part shares with the bean over its own fillet: a vertex belongs to
  // the bean and a part in proportion to how deep into their blend it is
  const share = (d: number, k: number) => {
    const t = Math.max(0, 1 - (d - d0) / (k * SHARE_K))
    return t * t * t
  }
  const bean = (d: number, k: number) => {
    const t = Math.max(0, 1 - (d0 - d) / (k * SHARE_K))
    return t * t * t
  }
  const k1 = fr.armK(0, x, y, z)
  const k2 = fr.armK(1, x, y, z)
  const kl = fr.legK(y)
  const w1 = share(d1, k1)
  const w2 = share(d2, k2)
  const w3 = share(d3, kl)
  const w4 = share(d4, kl)
  // the bean's own weight falls away as the vertex goes deeper into a part
  const w0 = Math.min(bean(d1, k1), bean(d2, k2), bean(d3, kl), bean(d4, kl))
  const sum = w0 + w1 + w2 + w3 + w4 || 1
  beanChain(fr, x, y, z, acc, w0 / sum)
  if (w1) armChain(fr, 0, x, y, z, acc, w1 / sum)
  if (w2) armChain(fr, 1, x, y, z, acc, w2 / sum)
  if (w3) legChain(0, y, z, acc, w3 / sum)
  if (w4) legChain(1, y, z, acc, w4 / sum)
  part[po] = w0 / sum
  part[po + 1] = (w3 + w4) / sum
  full.set(acc, o)
}

/*
  Then the weights are smoothed over the mesh itself: a few rounds of each
  vertex's weights moving halfway to its neighbours' average. Weights
  computed per point from distances change as fast as the distances do, and
  across a crease (an armpit, the back of a knee, the front of an ankle) that
  is fast enough for linear blend skinning to fold the skin over itself when
  the joint bends: the armpit of a raised arm showed as a scribble of
  inside-out triangles. Smoothed along the surface, a joint's weights ramp
  over a few rows of triangles instead, and only along the skin, so nothing
  leaks across the gap between two legs or an arm and the flank.
*/
const SMOOTH_ROUNDS = 10
/**
 * Smooth `full` (V rows of BONE_COUNT weights) over the triangle mesh, but
 * only in the band that starts at the vertices `seed` picks and grows by a
 * ring each round. Everywhere else the weights are already smooth functions
 * of position (the bean's height bands, an elbow's ramp), and sweeping the
 * whole skin was most of what a variant cost to build.
 */
const smoothWeights = (full: Float32Array, idx: Uint32Array, V: number, seed: (v: number) => boolean) => {
  // neighbour lists, compressed
  const deg = new Uint32Array(V + 1)
  for (let t = 0; t < idx.length; t++) deg[idx[t] + 1] += 2
  for (let v = 0; v < V; v++) deg[v + 1] += deg[v]
  const nb = new Uint32Array(deg[V])
  const fill = deg.slice(0, V)
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e]
      nb[fill[a]++] = idx[t + ((e + 1) % 3)]
      nb[fill[a]++] = idx[t + ((e + 2) % 3)]
    }
  }
  const inBand = new Uint8Array(V)
  const band: number[] = []
  for (let v = 0; v < V; v++) {
    if (seed(v)) {
      inBand[v] = 1
      band.push(v)
    }
  }
  const nx = new Float32Array(V * BONE_COUNT)
  // which bones each vertex carries, as bits: a vertex only ever mixes the
  // few bones around it, and looping all of them was most of the cost
  const mask = new Uint32Array(V)
  for (let v = 0; v < V; v++) {
    let m = 0
    for (let b = 0; b < BONE_COUNT; b++) if (full[v * BONE_COUNT + b] > 0) m |= 1 << b
    mask[v] = m
  }
  const mix = new Uint32Array(V)
  for (let r = 0; r < SMOOTH_ROUNDS; r++) {
    // grow first, so this round already reaches one ring further
    const n0 = band.length
    for (let i = 0; i < n0; i++) {
      const v = band[i]
      for (let k = deg[v]; k < deg[v + 1]; k++) {
        const u = nb[k]
        if (!inBand[u]) {
          inBand[u] = 1
          band.push(u)
        }
      }
    }
    for (const v of band) {
      const n = deg[v + 1] - deg[v]
      const o = v * BONE_COUNT
      let bits = mask[v]
      for (let k = deg[v]; k < deg[v + 1]; k++) bits |= mask[nb[k]]
      mix[v] = bits
      for (let b = 0; bits; b++, bits >>>= 1) {
        if (!(bits & 1)) continue
        if (!n) {
          nx[o + b] = full[o + b]
          continue
        }
        let m = 0
        for (let k = deg[v]; k < deg[v + 1]; k++) m += full[nb[k] * BONE_COUNT + b]
        nx[o + b] = 0.5 * full[o + b] + (0.5 * m) / n
      }
    }
    for (const v of band) {
      const o = v * BONE_COUNT
      let bits = mix[v]
      for (let b = 0; bits; b++, bits >>>= 1) if (bits & 1) full[o + b] = nx[o + b]
      mask[v] = mix[v]
    }
  }
}

/** the four heaviest bones in `acc`, normalized */
const pick4 = (si: Uint16Array, sw: Float32Array, o: number) => {
  let total = 0
  for (let k = 0; k < 4; k++) {
    let best = -1
    let bw = 0
    for (let b = 0; b < BONE_COUNT; b++) {
      if (acc[b] > bw) {
        bw = acc[b]
        best = b
      }
    }
    if (best < 0) {
      si[o + k] = 0
      sw[o + k] = 0
      continue
    }
    si[o + k] = best
    sw[o + k] = bw
    total += bw
    acc[best] = 0
  }
  for (let k = 0; k < 4; k++) sw[o + k] /= total || 1
}

/* ------------------------------------------------------------- surfaces -- */

interface Piece {
  pos: Float32Array
  nrm: Float32Array
  si: Uint16Array
  sw: Float32Array
  part: Float32Array
  role: number
  idx: Uint32Array
}

/** the grid step of the body and of the (smaller, thinner) headgear */
const BODY_STEP = 0.047
const GEAR_STEP = 0.033

const BODY_SURF: Array<Piece | null> = new Array(BUILD_COUNT).fill(null)
const bodySurface = (b: number): Piece => {
  const cached = BODY_SURF[b]
  if (cached) return cached
  const fr = frameFor(b)
  const { bd } = fr
  const reachX = SHOULDER_X + (UARM + FARM + 0.3) * Math.sin(ARM_BIND) + 0.1
  const depth = Math.max(bd.rb, bd.rt) * bd.zs + 0.05
  const m = surfaceNets(fr.body, [-reachX, 0, -depth - 0.12], [reachX, bd.yt + bd.rt + 0.03, Math.max(depth, 0.34)], BODY_STEP)
  const V = m.pos.length / 3
  const si = new Uint16Array(V * 4)
  const sw = new Float32Array(V * 4)
  const part = new Float32Array(V * 2)
  const full = new Float32Array(V * BONE_COUNT)
  for (let v = 0; v < V; v++) {
    weighBody(fr, m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2], full, v * BONE_COUNT, part, v * 2)
  }
  // the band: wherever the skin is shared between the bean and a limb
  smoothWeights(full, m.idx, V, (v) => part[v * 2] > 0.002 && part[v * 2] < 0.998)
  for (let v = 0; v < V; v++) {
    acc.set(full.subarray(v * BONE_COUNT, v * BONE_COUNT + BONE_COUNT))
    pick4(si, sw, v * 4)
  }
  const p: Piece = { pos: m.pos, nrm: m.nrm, si, sw, part, role: ROLE.SUIT, idx: m.idx }
  BODY_SURF[b] = p
  return p
}

/** one piece of headgear: a closed field in one paint, weighted like the
    head under it (or swung off the knot, for tails) */
const gearPiece = (
  fr: Frame, f: Field, lo: [number, number, number], hi: [number, number, number], role: number,
  tails?: THREE.Vector3,
  step = GEAR_STEP,
): Piece => {
  // a generous Lipschitz allowance: flattened ellipsoids and a drooped brim
  // overstate their distances, and a block wrongly skipped as far is a
  // hole in a brim
  const m = surfaceNets(f, lo, hi, step, 2.5)
  const V = m.pos.length / 3
  const si = new Uint16Array(V * 4)
  const sw = new Float32Array(V * 4)
  const part = new Float32Array(V * 2)
  const body = bodySurface(fr.index)
  const near = nearestOn(body)
  const ni = new Int32Array(KN)
  const nd = new Float64Array(KN)
  for (let v = 0; v < V; v++) {
    const x = m.pos[v * 3]
    const y = m.pos[v * 3 + 1]
    const z = m.pos[v * 3 + 2]
    acc.fill(0)
    // headgear moves with the skin it sits on: the weights of the nearest
    // points of the bean, blended by inverse distance so they ramp the way
    // the skin under them does, or the bean's own chain for anything well
    // clear of it, like the tip of a party hat. Weighted on its own, a hood
    // disagreed with the neck under it and folded
    const n = near(x, y, z, ni, nd)
    if (n) {
      let tw = 0
      for (let q = 0; q < n; q++) {
        const wq = 1 / (nd[q] + 1e-4)
        tw += wq
        for (let k = 0; k < 4; k++) acc[body.si[ni[q] * 4 + k]] += body.sw[ni[q] * 4 + k] * wq
      }
      for (let b = 0; b < BONE_COUNT; b++) acc[b] /= tw
    } else beanChain(fr, x, y, z, acc, 1)
    if (tails) {
      // a tail hangs off the knot: the further down it, the more it swings
      const k = smooth(0.04, 0.16, len(x - tails.x, y - tails.y, z - tails.z))
      for (let b = 0; b < BONE_COUNT; b++) acc[b] *= 1 - k
      acc[B.POM] += k
    }
    pick4(si, sw, v * 4)
  }
  return { pos: m.pos, nrm: m.nrm, si, sw, part, role, idx: m.idx }
}

/** a lookup of the (up to) four bean vertices nearest a point, within
    NEAR_R, through a hash of cells: headgear has a few thousand vertices
    and the body five, so a brute-force search would cost more than the
    surface. Fills `idx`/`d2` and returns how many it found */
const NEAR_R = 0.3
const KN = 4
type Near = (x: number, y: number, z: number, idx: Int32Array, d2: Float64Array) => number
const NEAR = new WeakMap<Piece, Near>()
const nearestOn = (p: Piece): Near => {
  const hit = NEAR.get(p)
  if (hit) return hit
  const C = 0.15
  const cells = new Map<number, number[]>()
  const key = (i: number, j: number, k: number) => ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512)
  const V = p.pos.length / 3
  for (let v = 0; v < V; v++) {
    // only the bean's own skin: a hood's hem lies over the root of each arm,
    // and hung off the arm it followed the arm about
    if (p.part[v * 2] < 0.6) continue
    const kk = key(Math.floor(p.pos[v * 3] / C), Math.floor(p.pos[v * 3 + 1] / C), Math.floor(p.pos[v * 3 + 2] / C))
    let list = cells.get(kk)
    if (!list) cells.set(kk, (list = []))
    list.push(v)
  }
  const R = Math.ceil(NEAR_R / C)
  const fn: Near = (x, y, z, idx, d2) => {
    const ci = Math.floor(x / C)
    const cj = Math.floor(y / C)
    const ck = Math.floor(z / C)
    let n = 0
    const worst = () => (n < KN ? NEAR_R * NEAR_R : d2[n - 1])
    // rings outward, stopping once a ring cannot beat the worst kept
    for (let r = 0; r <= R; r++) {
      if (n === KN && ((r - 1) * C) ** 2 > worst()) break
      for (let i = ci - r; i <= ci + r; i++)
        for (let j = cj - r; j <= cj + r; j++)
          for (let k = ck - r; k <= ck + r; k++) {
            if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue
            const list = cells.get(key(i, j, k))
            if (!list) continue
            for (const v of list) {
              const d = (p.pos[v * 3] - x) ** 2 + (p.pos[v * 3 + 1] - y) ** 2 + (p.pos[v * 3 + 2] - z) ** 2
              if (d >= worst()) continue
              // insertion into the sorted short list
              let at = Math.min(n, KN - 1)
              while (at > 0 && d2[at - 1] > d) {
                d2[at] = d2[at - 1]
                idx[at] = idx[at - 1]
                at--
              }
              d2[at] = d
              idx[at] = v
              if (n < KN) n++
            }
          }
    }
    return n
  }
  NEAR.set(p, fn)
  return fn
}

/** the headgear, in `look.ts`'s HATS order */
export const HAT_COUNT = 8
const BAND = 0
const CAP = 1
const BUCKET = 2
const PARTY = 3
const HARDHAT = 4
const BANDANA = 5
const HOOD = 7

/** a ring hugging the bean's section at a height (optionally tilted by a
    plane), with an elliptical tube `rt` thick out and `ry` tall */
const bandField = (
  fr: Frame, y0: number, tx: number, tz: number, out: number, ro: number, ry: number,
): Field => {
  const r0 = fr.rx(y0) + out
  const izs = 1 / fr.bd.zs
  return (x, y, z) => {
    const q1 = len(x, z * izs) - r0
    const q2 = y - (y0 + tx * x + tz * z)
    const e = len(q1 / ro, q2 / ry)
    return (e - 1) * Math.min(ro, ry)
  }
}

/** a knot at the back of the head and two tails hanging off it */
const knotAndTails = (fr: Frame, at: THREE.Vector3, role: number, long: number): Piece[] => {
  const knot = ellipsoid(at.x, at.y, at.z, 0.1, 0.085, 0.08)
  const tails: Field[] = [1, -1].map((s) => {
    const a = roundCone(at.x + s * 0.03, at.y - 0.02, at.z - 0.02, at.x + s * 0.07, at.y - 0.12, at.z - 0.1, 0.055, 0.05)
    const b = roundCone(
      at.x + s * 0.07, at.y - 0.12, at.z - 0.1, at.x + s * 0.12, at.y - long, at.z - 0.15, 0.05, 0.042,
    )
    return (x, y, z) => smin(a(x, y, z), b(x, y, z), 0.03)
  })
  const f: Field = (x, y, z) => smin(knot(x, y, z), Math.min(tails[0](x, y, z), tails[1](x, y, z)), 0.04)
  return [gearPiece(fr, f, [at.x - 0.3, at.y - long - 0.12, at.z - 0.35], [at.x + 0.3, at.y + 0.15, at.z + 0.14], role, at)]
}

const hatPieces = (fr: Frame, kind: number): Piece[] => {
  const { bd } = fr
  const crown = bd.yt + bd.rt
  const zs = bd.zs
  const R = bd.rt
  const A = ROLE.ACCENT
  const T = ROLE.TRIM
  const box = (pad: number, yLo: number, yHi: number): [[number, number, number], [number, number, number]] => [
    [-R - pad, yLo, -R * zs - pad],
    [R + pad, yHi, R * zs + pad],
  ]
  switch (kind) {
    case BAND: {
      // the knotted cloth sweatband, worn tipped low over one brow, tied at
      // the back with its tails hanging long. The one the owner kept
      const y0 = EYE_Y + 0.2
      const f = bandField(fr, y0, 0.07, 0.05, 0.015, 0.06, 0.075)
      const back = new THREE.Vector3(0, y0 - 0.05 * fr.rx(y0) * zs, -fr.rx(y0) * zs - 0.03)
      const [lo, hi] = box(0.12, y0 - 0.2, y0 + 0.2)
      return [gearPiece(fr, f, lo, hi, A), ...knotAndTails(fr, back, A, 0.42)]
    }
    case CAP: {
      // a baseball cap: a soft crown, a stiff peak out front in the detail
      // colour and a button on top
      const yc = EYE_Y + 0.14
      const dome = ellipsoid(0, bd.yt, 0, R + 0.035, R + 0.05, (R + 0.035) * zs)
      const shell: Field = (x, y, z) => smax(dome(x, y, z), yc - y, 0.02)
      const fz = fr.rx(yc) * zs
      const tilt = 0.22
      const brim = ellipsoid(0, yc + 0.015, fz + 0.12, 0.25, 0.036, 0.2,
        [1, 0, 0, 0, Math.cos(tilt), -Math.sin(tilt), 0, Math.sin(tilt), Math.cos(tilt)])
      const button = ellipsoid(0, crown + 0.04, 0, 0.055, 0.035, 0.055)
      const [lo, hi] = box(0.1, yc - 0.05, crown + 0.12)
      return [
        gearPiece(fr, (x, y, z) => Math.min(shell(x, y, z), button(x, y, z)), lo, hi, A),
        gearPiece(fr, brim, [-0.3, yc - 0.12, fz - 0.12], [0.3, yc + 0.14, fz + 0.38], T, undefined, 0.02),
      ]
    }
    case BUCKET: {
      // a bucket hat: a soft crown and a floppy brim tipped down all round,
      // a band where they meet
      const yc = EYE_Y + 0.22
      const r0 = fr.rx(yc) + 0.05
      const izs = 1 / zs
      const body = roundCone(0, yc, 0, 0, crown - 0.08, 0, r0, r0 * 0.72)
      const top: Field = (x, y, z) => smax(body(x, y, z * izs), yc - y, 0.02)
      const Rb = r0 + 0.18
      const brim: Field = (x, y, z) => {
        const rho = len(x, z * izs)
        const yy = y - yc + 0.08 * Math.max(0, (rho - r0) / (Rb - r0)) ** 2
        const dx = rho - Rb
        const dy = Math.abs(yy) - 0.02
        return (Math.min(Math.max(dx, dy), 0) + len(Math.max(dx, 0), Math.max(dy, 0)) - 0.025) * zs
      }
      const band = bandField(fr, yc + 0.06, 0, 0, 0.06, 0.035, 0.045)
      const [lo, hi] = box(0.36, yc - 0.2, crown + 0.08)
      return [
        // the crown on the ordinary grid and only the thin brim on the fine
        // one: the two overlap where they meet, which nobody can see
        gearPiece(fr, top, [lo[0] + 0.2, lo[1] + 0.12, lo[2] + 0.2], [hi[0] - 0.2, hi[1], hi[2] - 0.2], A),
        gearPiece(fr, brim, lo, [hi[0], yc + 0.08, hi[2]], A),
        gearPiece(fr, band, lo, [hi[0], yc + 0.2, hi[2]], T),
      ]
    }
    case PARTY: {
      // a party hat perched off-true on the crown, two rings and a pom
      const base = new THREE.Vector3(0.05, crown - 0.13, 0)
      const ax = new THREE.Vector3(Math.sin(0.28), Math.cos(0.28), 0)
      const Hh = 0.62
      const tip = base.clone().addScaledVector(ax, Hh)
      const cone = roundCone(base.x, base.y, base.z, tip.x, tip.y, tip.z, 0.25, 0.02)
      const ring = (t: number): Field => {
        const rAt = 0.25 + (0.02 - 0.25) * t + 0.012
        return (x, y, z) => {
          const px = x - base.x
          const py = y - base.y
          const pz = z - base.z
          const a = px * ax.x + py * ax.y + pz * ax.z
          const rho = len(px - ax.x * a, py - ax.y * a, pz - ax.z * a)
          return len(rho - rAt, a - t * Hh) - 0.038
        }
      }
      const r1 = ring(0.2)
      const r2 = ring(0.52)
      const pom = ellipsoid(tip.x, tip.y + 0.03, tip.z, 0.09, 0.09, 0.09)
      // the base's round end dips well into the crown: a box that clipped
      // it cut the cone open underneath
      const lo: [number, number, number] = [-0.4, crown - 0.45, -0.4]
      const hi: [number, number, number] = [0.5, crown + 0.7, 0.4]
      return [
        gearPiece(fr, cone, lo, hi, A),
        gearPiece(fr, (x, y, z) => Math.min(r1(x, y, z), r2(x, y, z), pom(x, y, z)), lo, hi, T, undefined, 0.022),
      ]
    }
    case HARDHAT: {
      // a hard hat a size too big: a stiff shell with a rim all round, a
      // peak out front and a ridge over the top
      const yc = EYE_Y + 0.15
      const dome = ellipsoid(0, bd.yt, 0, R + 0.08, R + 0.11, (R + 0.08) * zs)
      const shell: Field = (x, y, z) => smax(dome(x, y, z), yc - y, 0.015)
      const r0 = fr.rx(yc) + 0.1
      const izs = 1 / zs
      const rim: Field = (x, y, z) => {
        const rho = len(x, z * izs)
        const reach = r0 + 0.05 + 0.1 * smooth(0.2, 0.9, z / (r0 * zs))
        const dx = rho - reach
        const dy = Math.abs(y - yc - 0.01) - 0.012
        return Math.min(Math.max(dx, dy), 0) + len(Math.max(dx, 0), Math.max(dy, 0)) - 0.015
      }
      const ridgeR = R + 0.1
      const ridge: Field = (x, y, z) => {
        const q = len(y - bd.yt, z * izs) - ridgeR
        return smax(len(q, x) - 0.05, yc + 0.03 - y, 0.01)
      }
      const [lo, hi] = box(0.3, yc - 0.1, crown + 0.2)
      return [
        gearPiece(fr, (x, y, z) => smin(shell(x, y, z), rim(x, y, z), 0.03), lo, hi, A),
        gearPiece(fr, ridge, lo, hi, T),
      ]
    }
    case BANDANA: {
      // cloth tied tight over the top, down lower at the back, knotted
      // there with two tails in the detail colour
      const yc = EYE_Y + 0.15
      const dome = ellipsoid(0, bd.yt, 0, R + 0.022, R + 0.03, (R + 0.022) * zs)
      const shell: Field = (x, y, z) => smax(dome(x, y, z), yc - 0.14 * smooth(0.1, -0.9, z / (R * zs)) - y, 0.02)
      const back = new THREE.Vector3(0, yc - 0.05, -fr.rx(yc - 0.05) * zs - 0.02)
      const [lo, hi] = box(0.1, yc - 0.25, crown + 0.08)
      return [gearPiece(fr, shell, lo, hi, A), ...knotAndTails(fr, back, T, 0.36)]
    }
    case HOOD: {
      // a hood up over the head and down onto the shoulders, the face
      // looking out of it, two cords hanging from the front
      // the hem clears the shoulders: the fillet where each arm grows out
      // bulges up under a lower one and moves about inside it
      const yBot = HIP_Y + WAIST_OFF + SHOULDER_OFF + 0.28
      const fz = fr.rx(EYE_Y) * zs
      const hole = ellipsoid(0, EYE_Y - 0.02, fz + 0.1, 0.34, 0.31, 0.42)
      const shell: Field = (x, y, z) =>
        smax(smax(fr.bean(x, y, z) - 0.055, yBot - y, 0.03), -hole(x, y, z), 0.035)
      const cords: Field[] = [1, -1].map((s) => {
        const z0 = fr.rx(yBot + 0.08) * zs * 0.82
        return roundCone(s * 0.19, yBot + 0.08, z0 + 0.06, s * 0.21, yBot - 0.26, z0 + 0.12, 0.035, 0.035)
      })
      const [lo, hi] = box(0.18, yBot - 0.08, crown + 0.1)
      return [
        gearPiece(fr, shell, [lo[0] - 0.1, lo[1], lo[2] - 0.1], [hi[0] + 0.1, hi[1], hi[2] + 0.1], A),
        gearPiece(fr, (x, y, z) => Math.min(cords[0](x, y, z), cords[1](x, y, z)), [-0.35, yBot - 0.4, 0], [0.35, yBot + 0.2, 0.7], T),
      ]
    }
    default:
      return [] // bare-headed
  }
}

/* ------------------------------------------------------------ variants -- */

/** the outfits (`look.ts`'s COSTUMES) and the faces are painted by the
    material from uniforms, not drawn: see bodyMaterial.ts */
export const COSTUME_COUNT = 4
export const FACE_COUNT = 5

/** one geometry per (headgear, build), built on first use and shared by
    every body wearing it. A body changes by swapping `mesh.geometry`
    between these: same attribute layout, same material, so a swap is a
    buffer rebind and never a relink. Never dispose them: module state */
const SHARED: Array<THREE.BufferGeometry | null> = new Array(HAT_COUNT * BUILD_COUNT).fill(null)
/** how long the last variant took to build, ms (the measure prints it) */
export let lastBuildMs = 0

export const bodyGeometry = (
  hat = 0, buildIndex = 0, costumeIndex = 0, faceIndex = 0,
): THREE.BufferGeometry => {
  void costumeIndex
  void faceIndex
  const kind = Math.max(0, Math.min(HAT_COUNT - 1, Math.floor(hat)))
  const b = clampBuild(buildIndex)
  const key = kind * BUILD_COUNT + b
  const cached = SHARED[key]
  if (cached) return cached
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0
  const fr = frameFor(b)
  const pieces = [bodySurface(b), ...hatPieces(fr, kind)]
  let V = 0
  let I = 0
  for (const p of pieces) {
    V += p.pos.length / 3
    I += p.idx.length
  }
  const pos = new Float32Array(V * 3)
  const nrm = new Float32Array(V * 3)
  const si = new Uint16Array(V * 4)
  const sw = new Float32Array(V * 4)
  const part = new Float32Array(V * 2)
  const role = new Float32Array(V)
  const idx = new Uint32Array(I)
  let v0 = 0
  let i0 = 0
  for (const p of pieces) {
    const n = p.pos.length / 3
    pos.set(p.pos, v0 * 3)
    nrm.set(p.nrm, v0 * 3)
    si.set(p.si, v0 * 4)
    sw.set(p.sw, v0 * 4)
    part.set(p.part, v0 * 2)
    role.fill(p.role, v0, v0 + n)
    for (let k = 0; k < p.idx.length; k++) idx[i0 + k] = p.idx[k] + v0
    v0 += n
    i0 += p.idx.length
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
  g.setAttribute('aRole', new THREE.BufferAttribute(role, 1))
  g.setAttribute('aPart', new THREE.BufferAttribute(part, 2))
  g.setIndex(V > 65535 ? new THREE.BufferAttribute(idx, 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  g.userData.shared = true
  SHARED[key] = g
  lastBuildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0
  warmLater()
  return g
}

/*
  A variant costs a couple of dozen milliseconds to build, which is a
  dropped frame if it is built the moment a stranger in a new hat walks
  into view. So once the first body exists, the rest are built in the
  background, one per idle period long enough to hold one (the browser's
  own requestIdleCallback, never forced by a timeout): the dearest part,
  each build's bean, first, then every headgear on every build. On the
  desk, where the 3D layer draws nothing, that is all of them within a
  second or two of boot; in a busy walk it may be none, and a variant is
  then built when it is first worn, as before. Headless (no
  requestIdleCallback) nothing is scheduled.
*/
type Idle = (cb: (d: { timeRemaining: () => number }) => void) => number
let warming = false
const warmLater = () => {
  const ric = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback
  if (warming || !ric) return
  warming = true
  const next = (): (() => void) | null => {
    for (let b = 0; b < BUILD_COUNT; b++) if (!BODY_SURF[b]) return () => bodySurface(b)
    for (let k = 0; k < SHARED.length; k++) {
      if (!SHARED[k]) return () => bodyGeometry(Math.floor(k / BUILD_COUNT), k % BUILD_COUNT)
    }
    return null
  }
  const step = (d: { timeRemaining: () => number }) => {
    const job = next()
    if (!job) return
    if (d.timeRemaining() >= 14) job()
    ric(step)
  }
  ric(step)
}

/** the body's own field for a build: negative inside the skin. What the
    measure uses to leave out of its fold count anything buried inside the
    body, where nobody can see it (the underside of a hat, the inner face of
    a hood) */
export const bodyField = (buildIndex: number): Field => frameFor(clampBuild(buildIndex)).body

/** build one variant from nothing (its bean, its headgear) and report the
    milliseconds, without touching the cache anybody is drawing from: what
    `npm run measure -- body` prints as the cost of meeting a stranger in a
    new hat */
export const timeVariant = (hat: number, buildIndex: number): number => {
  const b = clampBuild(buildIndex)
  const key = Math.max(0, Math.min(HAT_COUNT - 1, Math.floor(hat))) * BUILD_COUNT + b
  const keep = [SHARED[key], BODY_SURF[b], FRAMES[b]] as const
  SHARED[key] = null
  BODY_SURF[b] = null
  FRAMES[b] = null
  const t0 = performance.now()
  bodyGeometry(hat, b)
  const ms = performance.now() - t0
  SHARED[key] = keep[0]
  BODY_SURF[b] = keep[1]
  FRAMES[b] = keep[2]
  return ms
}
