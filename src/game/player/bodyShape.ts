import * as THREE from 'three'
import {
  drain, ellipsoid, roundCone, segDist, smax, smin, surfaceNetsSteps, type Field,
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
  resolution and costs no variant. A variant is a (headgear, build, gear)
  triple, gear being the two things worn with any hat (the beaver's tail,
  ears and snout, and the headphones: see GEAR_BEAVER); the headgear and
  gear pieces are their own closed fields polygonized at a finer step and
  concatenated into the same buffer, so a body is still one draw call
  whatever it wears.

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
export const HIP_X = 0.26
/** the foot bone's height over its sole */
export const ANKLE_H = 0.1
/** pelvis bone up to the torso bone. The bean is weighted across it */
export const WAIST_OFF = 0.3
/** the shoulder joints sit just inside the flank, so an arm grows out of it */
export const SHOULDER_X = 0.58
export const SHOULDER_OFF = 0.62
/** torso bone up to the head bone: where the bean stops being body and
    starts being head, which is only ever a matter of weights */
export const NECK_OFF = 0.95
/** stubby arms: a hanging mitten reaches the bottom of the bean */
export const UARM = 0.4
export const FARM = 0.35
/** head bone up to the eyes */
export const EYE_OFF = 0.24
/** head bone up to the top of the default bean: the egg's crown (c + b2 =
    2.78, see BUILD_DEFS) less the head bone's 1.95. It read 0.59 for a long
    time, a quarter unit short of the drawing, which is how a bean measured
    as 2.54 tall stood as high as a door */
export const CROWN_OFF = 0.83
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
  The builds: every body is one of five eggs. The bean is two halves of a
  superellipse of revolution joined at the belly (`c`), where it is widest:
  a short, round bottom half (`b1` down to the seat) and a tall top half
  (`b2` up to the crown) whose exponent above two gives the dome its blunt,
  full shoulder instead of an ellipsoid's point. The eye line never moves,
  and every build is scaled the same (off the default bean's crown, see
  playerBody's DESIGN_LENS), so "tall" is a dome that rises further over the
  eyes and "stubby" one that barely clears them.

  The earlier bean was a round cone, the hull of two spheres: straight
  flanks, 2.3 times as tall as wide, and next to the reference it read as a
  tall pickle rather than an egg. This one is about 2.2 times as tall as
  wide counting the legs, 1.9 without, widest low, the way the reference is.
*/
interface Build {
  /** the belly's radius (the widest) and its height */
  a: number
  c: number
  /** the half-heights below and above the belly */
  b1: number
  b2: number
  /** the superellipse exponents of the two halves */
  n1: number
  n2: number
  /** front-to-back depth over width */
  zs: number
}
const BUILD_DEFS: Build[] = [
  { a: 0.67, c: 1.0, b1: 0.65, b2: 1.78, n1: 2.2, n2: 2.6, zs: 0.9 }, // the bean
  { a: 0.77, c: 1.02, b1: 0.68, b2: 1.72, n1: 2.2, n2: 2.7, zs: 0.92 }, // chubby
  { a: 0.58, c: 1.0, b1: 0.63, b2: 1.84, n1: 2.2, n2: 2.5, zs: 0.88 }, // slim
  { a: 0.63, c: 1.02, b1: 0.66, b2: 2.08, n1: 2.2, n2: 2.6, zs: 0.9 }, // tall
  { a: 0.73, c: 0.98, b1: 0.62, b2: 1.62, n1: 2.3, n2: 2.8, zs: 0.92 }, // stubby
]
export const BUILD_COUNT = BUILD_DEFS.length
const clampBuild = (b: number) => Math.max(0, Math.min(BUILD_COUNT - 1, Math.floor(b)))
/** how much wider than the default bean each build is: the rig holds the
    arms that much further out, so a hanging arm never sinks into the flank */
export const buildGirth = (b: number) => BUILD_DEFS[clampBuild(b)].a / BUILD_DEFS[0].a
/** the bottom of the default bean over the soles */
export const BODY_Y0 = BUILD_DEFS[0].c - BUILD_DEFS[0].b1
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
  /** the spacesuit's white: the helmet shell */
  WHITE: 9,
  /** the spacesuit's grey: the life-support pack */
  GREY: 10,
  /** the beaver's fur (its ears), in the look's fur shade */
  FUR: 11,
  /** the beaver's cream: its snout and the inside of its ears */
  CREAM: 12,
  /** the beaver's tail, printed with its scales */
  TAIL: 13,
  /** the headphones' black: band, cushions, cups and the boom mic */
  PHONES: 14,
  /** the headphones' metal: forks, sliders, the rings and logos on the cups */
  PHONES_METAL: 15,
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
  /** the bean's horizontal radius (x) at a height */
  rx: (y: number) => number
  /** the top of the bean */
  crown: number
  face: FaceWindow
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
/** the face window of a build: its half-width, half-height and centre
    height, design units. The field sinks the bean behind it and the
    material paints the panel and the eyes inside it, from the same numbers */
export interface FaceWindow {
  w: number
  h: number
  y: number
}
/** how far the face sits into the bean, and the soft lip round it */
const FACE_SINK = 0.045
const FACE_LIP = 0.018

/**
 * The egg: the two superellipse halves meeting at the belly. The value is
 * the implicit function over its own gradient's length, which is a true
 * distance on the surface and a close one near it: all the polygonizer and
 * the blends ever ask.
 */
const eggField = (bd: Build): Field => {
  const izs = 1 / bd.zs
  return (x, y, z) => {
    const zz = z * izs
    const rho = Math.sqrt(x * x + zz * zz)
    const up = y >= bd.c
    const b = up ? bd.b2 : bd.b1
    const n = up ? bd.n2 : bd.n1
    const u = rho / bd.a
    const v = Math.abs(y - bd.c) / b
    const un1 = u > 0 ? Math.pow(u, n - 1) : 0
    const vn1 = v > 0 ? Math.pow(v, n - 1) : 0
    const S = un1 * u + vn1 * v
    if (S < 1e-12) return -Math.min(bd.a, b)
    const r = Math.pow(S, 1 / n)
    // |grad| of S^(1/n): S^(1/n - 1) * |(u^(n-1)/a, v^(n-1)/b)|
    const g = (r / S) * Math.sqrt((un1 / bd.a) ** 2 + (vn1 / b) ** 2)
    return (r - 1) / Math.max(g, 1e-6)
  }
}

const frameFor = (b: number): Frame => {
  const cached = FRAMES[b]
  if (cached) return cached
  const bd = BUILD_DEFS[b]
  const egg = eggField(bd)
  const crown = bd.c + bd.b2
  // the horizontal radius at a height, by bisection on the egg itself, so
  // headgear can sit on whatever the build drew; tabulated, because the
  // weights ask it once per vertex
  const radiusAt = (y: number) => {
    let lo = 0
    let hi = 1.5
    if (egg(0, y, 0) > 0) return 0
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2
      if (egg(mid, y, 0) < 0) lo = mid
      else hi = mid
    }
    return lo
  }
  const TAB = 128
  const tab = new Float32Array(TAB + 1)
  for (let i = 0; i <= TAB; i++) tab[i] = radiusAt((i / TAB) * crown)
  const rx = (y: number) => {
    const u = Math.max(0, Math.min(TAB, (y / crown) * TAB))
    const i = Math.min(TAB - 1, Math.floor(u))
    return tab[i] + (tab[i + 1] - tab[i]) * (u - i)
  }

  /*
    The face window: an oval about two thirds of the head's width, set into
    the front of the bean. Inside it the skin is pushed in by FACE_SINK,
    easing up to the rim, and a soft lip stands proud just outside it, so
    the face is a window the bean looks out of rather than a decal on it.
    It is a displacement of the egg's own distance, which keeps the face
    curved with the head, and it only touches the front half.
  */
  const hr = rx(EYE_Y)
  const face: FaceWindow = { w: 0.7 * hr, h: 0.31, y: EYE_Y - 0.03 }
  const iw = 1 / face.w
  const ih = 1 / face.h
  const bean: Field = (x, y, z) => {
    const d = egg(x, y, z)
    if (z < 0.02 || Math.abs(y - face.y) > face.h * 1.65) return d
    const e = Math.sqrt((x * iw) ** 2 + ((y - face.y) * ih) ** 2)
    if (e > 1.6) return d
    const front = smooth(0.02, 0.22, z)
    // both several grid cells wide: a lip narrower than a cell comes out of
    // the polygonizer as a frayed dark hem round the face
    const sink = FACE_SINK * (1 - smooth(0.7, 1.0, e))
    const lip = FACE_LIP * Math.exp(-(((e - 1.1) / 0.16) ** 2))
    return d + front * (sink - lip)
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
    // one straight tapering cone from well inside the flank to the wrist:
    // the root's round end is buried, so no shoulder pad stands proud of the
    // body, and there is no second cone to blend at the elbow, because a
    // smooth minimum swells wherever two parts meet and an arm of two
    // blended cones read as a string of sausages
    const G = new THREE.Vector3(side * (rx(S.y) - 0.13), S.y, S.z)
    const arm = roundCone(G.x, G.y, G.z, W.x, W.y, W.z, 0.16, 0.112)
    // the mitten: a soft paddle a little wider than the wrist, flattened
    // palm to back (the palm faces the body), with a thumb on its front edge
    // and three short fat fingers at its end, all of it the same surface
    const C = W.clone().addScaledVector(d, 0.07)
    // in the arm's plane, perpendicular to it, toward the body
    const n = new THREE.Vector3(-side * Math.cos(ARM_BIND), -Math.sin(ARM_BIND), 0)
    const wz = new THREE.Vector3(0, 0, 1)
    const mitt = ellipsoid(C.x, C.y, C.z, 0.085, 0.13, 0.135, [n.x, n.y, n.z, d.x, d.y, d.z, wz.x, wz.y, wz.z])
    const T0 = C.clone().addScaledVector(d, -0.02).addScaledVector(wz, 0.08)
    const T1 = C.clone().addScaledVector(d, 0.05).addScaledVector(wz, 0.16).addScaledVector(n, 0.025)
    const thumb = roundCone(T0.x, T0.y, T0.z, T1.x, T1.y, T1.z, 0.048, 0.042)
    const fingers = [-1, 0, 1].map((f) => {
      const F0 = C.clone().addScaledVector(d, 0.07).addScaledVector(wz, f * 0.058 - 0.015)
      const F1 = F0.clone().addScaledVector(d, 0.085 - Math.abs(f) * 0.015).addScaledVector(wz, f * 0.02)
      return roundCone(F0.x, F0.y, F0.z, F1.x, F1.y, F1.z, 0.047, 0.043)
    })
    const [f0, f1, f2] = fingers
    arms.push((x, y, z) => {
      const hand = smin(
        smin(mitt(x, y, z), thumb(x, y, z), 0.035),
        Math.min(f0(x, y, z), f1(x, y, z), f2(x, y, z)), 0.03,
      )
      return smin(arm(x, y, z), hand, 0.05)
    })
    armRoot.push(S.clone())
    armTip.push(W.clone().addScaledVector(d, 0.3))
  })

  const legs: Field[] = []
  // drawn a hair wider than the hip bones: two stumps closer than a couple
  // of grid cells are one stump with a web between them, and a web folds the
  // moment one leg swings forward and the other back
  const LX = HIP_X + 0.03
  for (const side of [1, -1]) {
    const x = side * LX
    const stump = roundCone(x, HIP_Y + 0.06, 0, x, ANKLE_H + 0.06, 0.0, 0.165, 0.145)
    // a rounded stub of a foot pushed a little forward, the sole flattened,
    // blended wide into the stump: a tight blend left a ring at the ankle
    // and the feet read as slippers
    const foot = ellipsoid(x, 0.095, 0.07, 0.15, 0.115, 0.21)
    // the sole a hair off the ground: exactly on it, its inside lost the
    // depth test to the road and the first-person cap had two holes in it
    legs.push((px, py, pz) => smax(smin(stump(px, py, pz), foot(px, py, pz), 0.16), 0.012 - py, 0.03))
  }

  const [aL, aR] = arms
  const [lL, lR] = legs
  const [SL, SR] = armRoot
  const [TL, TR] = armTip
  // a part further than this past its own bone cannot reach the blend, so
  // it is not evaluated at all: most of the grid is nowhere near an arm
  const ARM_R = 0.2 + 0.23
  const LEG_R = 0.3 + 0.2
  // a generous fillet where an arm leaves the flank, tightening along it so
  // the arm is free of the body well before the elbow
  const armK = (k: 0 | 1, x: number, y: number, z: number) => {
    const S = k === 0 ? SL : SR
    const ds = Math.sqrt((x - S.x) ** 2 + (y - S.y) ** 2 + (z - S.z) ** 2)
    return 0.025 + 0.16 * (1 - smooth(0.08, 0.34, ds))
  }
  // and the same where the legs leave the bottom of the bean
  const legK = (y: number) => 0.03 + 0.15 * smooth(0.2, 0.44, y)
  const body: Field = (x, y, z) => {
    let d = bean(x, y, z)
    if (segDist(x, y, z, SL.x, SL.y, SL.z, TL.x, TL.y, TL.z) - ARM_R < d) d = smin(d, aL(x, y, z), armK(0, x, y, z))
    if (segDist(x, y, z, SR.x, SR.y, SR.z, TR.x, TR.y, TR.z) - ARM_R < d) d = smin(d, aR(x, y, z), armK(1, x, y, z))
    const kl = legK(y)
    if (segDist(x, y, z, LX, HIP_Y + 0.06, 0, LX, 0.1, 0.07) - LEG_R < d) d = smin(d, lL(x, y, z), kl)
    if (segDist(x, y, z, -LX, HIP_Y + 0.06, 0, -LX, 0.1, 0.07) - LEG_R < d) d = smin(d, lR(x, y, z), kl)
    return d
  }
  const f: Frame = { index: b, bd, bean, rx, crown, face, arm: [aL, aR], leg: [lL, lR], body, sh, dir, armK, legK }
  FRAMES[b] = f
  return f
}

/** the face window a build's bean is drawn with (see FaceWindow) */
export const faceWindow = (buildIndex: number): FaceWindow => frameFor(clampBuild(buildIndex)).face

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
  const r = Math.max(0.2, fr.rx(Math.min(Math.max(y, fr.bd.c), fr.crown - 0.2)) * fr.bd.zs)
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
    const cH = 1 - smooth(0.18, 0.58, len(x - hx, y - HIP_Y, z))
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
  // the knee is spread over the whole visible stub: it sits right where
  // the stub leaves the bean, and a knee weighted there hinged the fillet
  const kK = smooth(0.06, 0.56, y)
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
function* smoothWeights(full: Float32Array, idx: Uint32Array, V: number, seed: (v: number) => boolean): Generator<void, void, void> {
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
    yield
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
/** one build's bean, as steps (see pumpBodyBuilds) */
function* bodySurfaceSteps(b: number): Generator<void, Piece, void> {
  const cached = BODY_SURF[b]
  if (cached) return cached
  const fr = frameFor(b)
  const { bd } = fr
  const reachX = SHOULDER_X + (UARM + FARM + 0.3) * Math.sin(ARM_BIND) + 0.1
  const depth = bd.a * bd.zs + 0.05
  const m = yield* surfaceNetsSteps(
    fr.body, [-reachX, 0, -depth - 0.12], [reachX, fr.crown + 0.04, Math.max(depth, 0.34)], BODY_STEP,
  )
  const V = m.pos.length / 3
  const si = new Uint16Array(V * 4)
  const sw = new Float32Array(V * 4)
  const part = new Float32Array(V * 2)
  const full = new Float32Array(V * BONE_COUNT)
  for (let v = 0; v < V; v++) {
    if ((v & 255) === 255) yield
    weighBody(fr, m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2], full, v * BONE_COUNT, part, v * 2)
  }
  // the band: wherever the skin is shared between the bean and a limb
  yield* smoothWeights(full, m.idx, V, (v) => part[v * 2] > 0.002 && part[v * 2] < 0.998)
  for (let v = 0; v < V; v++) {
    if ((v & 1023) === 1023) yield
    acc.set(full.subarray(v * BONE_COUNT, v * BONE_COUNT + BONE_COUNT))
    pick4(si, sw, v * 4)
  }
  const p: Piece = { pos: m.pos, nrm: m.nrm, si, sw, part, role: ROLE.SUIT, idx: m.idx }
  BODY_SURF[b] = p
  return p
}

/** one piece of headgear: a closed field in one paint, weighted like the
    head under it (or swung off the knot, for tails) */
/** a piece still to be built: a generator factory, so the headgear list
    can be drawn up at once and each piece built a slice at a time */
type PieceJob = () => Generator<void, Piece, void>
const gearPiece = (
  fr: Frame, f: Field, lo: [number, number, number], hi: [number, number, number], role: number,
  tails?: THREE.Vector3,
  step = GEAR_STEP,
  /** a bone every vertex is weighted to outright, for something rigid
      that only rides the head (the headphones), rather than the skin */
  rigid?: number,
): PieceJob => function* () {
  // a generous Lipschitz allowance: flattened ellipsoids and a drooped brim
  // overstate their distances, and a block wrongly skipped as far is a
  // hole in a brim
  const m = yield* surfaceNetsSteps(f, lo, hi, step, 2.5)
  const V = m.pos.length / 3
  const si = new Uint16Array(V * 4)
  const sw = new Float32Array(V * 4)
  const part = new Float32Array(V * 2)
  const body = yield* bodySurfaceSteps(fr.index)
  const near = nearestOn(body)
  const ni = new Int32Array(KN)
  const nd = new Float64Array(KN)
  for (let v = 0; v < V; v++) {
    if ((v & 255) === 255) yield
    const x = m.pos[v * 3]
    const y = m.pos[v * 3 + 1]
    const z = m.pos[v * 3 + 2]
    acc.fill(0)
    if (rigid !== undefined) {
      acc[rigid] = 1
      pick4(si, sw, v * 4)
      continue
    }
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
export const HAT_COUNT = 9
const BAND = 0
const CAP = 1
const BUCKET = 2
const PARTY = 3
const HARDHAT = 4
const BANDANA = 5
const HOOD = 7
const HELMET = 8

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
const knotAndTails = (fr: Frame, at: THREE.Vector3, role: number, long: number): PieceJob[] => {
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

/** a headgear, built: its pieces, and what anything worn over it must
    clear (`hug`: the bean and the hat's own shell, brims and all, never
    its tails or cords), or null when nothing can be worn over it (the
    helmet). `bandZ` is where a headband crossing the top goes: over the
    middle of the head, except behind a party hat */
interface HatBuild {
  jobs: PieceJob[]
  hug: Field | null
  bandZ: number
}

const hatBuild = (fr: Frame, kind: number): HatBuild => {
  const H = (jobs: PieceJob[], hug: Field | null, bandZ = -0.02): HatBuild => ({ jobs, hug, bandZ })
  const bean = fr.bean
  const { bd, crown } = fr
  const zs = bd.zs
  const A = ROLE.ACCENT
  const T = ROLE.TRIM
  /** a box round the head from yLo up, padded: the widest the head gets in
      that range is at its bottom */
  const box = (pad: number, yLo: number, yHi: number): [[number, number, number], [number, number, number]] => {
    const r = fr.rx(Math.max(yLo, bd.c))
    return [
      [-r - pad, yLo, -r * zs - pad],
      [r + pad, yHi, r * zs + pad],
    ]
  }
  // every shell below is the bean's own field pushed out a little: it hugs
  // whatever dome the build drew, where the old ellipsoid caps sat on a
  // sphere the egg no longer has. The face window reaches EYE + 0.28, so
  // anything worn on the head starts above it
  const above = EYE_Y + 0.31
  switch (kind) {
    case BAND: {
      // the knotted cloth headband, tipped a little over one brow and tied
      // at the back with its tails hanging long. The one the owner kept. A
      // flat band lying on the head, not a hoop standing off it: a round
      // tube a finger proud of the skin read, in a tumble, as a ring
      // floating round the face
      const y0 = above + 0.01
      const f = bandField(fr, y0, 0.05, 0.03, -0.012, 0.045, 0.085)
      const back = new THREE.Vector3(0, y0 - 0.03 * fr.rx(y0) * zs, -fr.rx(y0) * zs - 0.015)
      const [lo, hi] = box(0.12, y0 - 0.2, y0 + 0.2)
      return H([gearPiece(fr, f, lo, hi, A), ...knotAndTails(fr, back, A, 0.42)], (x, y, z) => Math.min(bean(x, y, z), f(x, y, z)))
    }
    case CAP: {
      // a baseball cap: a soft crown hugging the dome and a long stiff peak
      // out front, both in the hat colour, and a button on top in the
      // detail colour. The peak was the detail colour once, and in the
      // default cream it vanished against the face panel under it: a cap
      // with no visible peak reads as a skullcap
      const yc = above
      const shell: Field = (x, y, z) => smax(fr.bean(x, y, z) - 0.04, yc - y, 0.02)
      const fz = fr.rx(yc) * zs
      const tilt = 0.14
      const brim = ellipsoid(0, yc + 0.01, fz + 0.17, 0.3, 0.036, 0.27,
        [1, 0, 0, 0, Math.cos(tilt), -Math.sin(tilt), 0, Math.sin(tilt), Math.cos(tilt)])
      const button = ellipsoid(0, crown + 0.045, 0, 0.055, 0.035, 0.055)
      const [lo, hi] = box(0.1, yc - 0.05, crown + 0.12)
      return H([
        gearPiece(fr, shell, lo, hi, A),
        gearPiece(fr, button, [-0.1, crown - 0.05, -0.1], [0.1, crown + 0.12, 0.1], T, undefined, 0.02),
        gearPiece(fr, brim, [-0.35, yc - 0.12, fz - 0.14], [0.35, yc + 0.14, fz + 0.5], A, undefined, 0.02),
      ], (x, y, z) => Math.min(bean(x, y, z), shell(x, y, z), button(x, y, z)))
    }
    case BUCKET: {
      // a bucket hat: a soft crown and a floppy brim tipped down all round,
      // a band where they meet, sat high enough that the face still looks
      // out from under it
      const yc = above + 0.03
      const r0 = fr.rx(yc) + 0.05
      const izs = 1 / zs
      const body = roundCone(0, yc, 0, 0, crown - 0.05, 0, r0, r0 * 0.78)
      const top: Field = (x, y, z) => smax(body(x, y, z * izs), yc - y, 0.02)
      const Rb = r0 + 0.17
      const brim: Field = (x, y, z) => {
        const rho = len(x, z * izs)
        const yy = y - yc + 0.07 * Math.max(0, (rho - r0) / (Rb - r0)) ** 2
        const dx = rho - Rb
        const dy = Math.abs(yy) - 0.02
        return (Math.min(Math.max(dx, dy), 0) + len(Math.max(dx, 0), Math.max(dy, 0)) - 0.025) * zs
      }
      const band = bandField(fr, yc + 0.06, 0, 0, 0.055, 0.035, 0.045)
      const [lo, hi] = box(0.36, yc - 0.2, crown + 0.1)
      return H([
        // the crown on the ordinary grid and only the thin brim on the fine
        // one: the two overlap where they meet, which nobody can see
        gearPiece(fr, top, [lo[0] + 0.2, lo[1] + 0.12, lo[2] + 0.2], [hi[0] - 0.2, hi[1], hi[2] - 0.2], A),
        gearPiece(fr, brim, lo, [hi[0], yc + 0.08, hi[2]], A),
        gearPiece(fr, band, lo, [hi[0], yc + 0.2, hi[2]], T),
      ], (x, y, z) => Math.min(bean(x, y, z), top(x, y, z), brim(x, y, z), band(x, y, z)))
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
      // a headband goes behind the cone, not up and over it
      return H([
        gearPiece(fr, cone, lo, hi, A),
        gearPiece(fr, (x, y, z) => Math.min(r1(x, y, z), r2(x, y, z), pom(x, y, z)), lo, hi, T, undefined, 0.022),
      ], (x, y, z) => Math.min(bean(x, y, z), cone(x, y, z)), -0.3)
    }
    case HARDHAT: {
      // a hard hat a size too big: a stiff shell with a rim all round, a
      // peak out front and a ridge over the top
      const yc = above - 0.02
      const shell: Field = (x, y, z) => smax(fr.bean(x, y, z) - 0.08, yc - y, 0.015)
      const r0 = fr.rx(yc) + 0.08
      const izs = 1 / zs
      const rim: Field = (x, y, z) => {
        const rho = len(x, z * izs)
        const reach = r0 + 0.05 + 0.1 * smooth(0.2, 0.9, z / (r0 * zs))
        const dx = rho - reach
        const dy = Math.abs(y - yc - 0.01) - 0.012
        return Math.min(Math.max(dx, dy), 0) + len(Math.max(dx, 0), Math.max(dy, 0)) - 0.015
      }
      // a strip of a slightly bigger shell, front to back over the top
      const ridge: Field = (x, y, z) =>
        smax(smax(fr.bean(x, y, z) - 0.125, Math.abs(x) - 0.045, 0.015), yc + 0.03 - y, 0.01)
      const [lo, hi] = box(0.3, yc - 0.1, crown + 0.2)
      return H([
        gearPiece(fr, (x, y, z) => smin(shell(x, y, z), rim(x, y, z), 0.03), lo, hi, A),
        gearPiece(fr, ridge, lo, hi, T),
      ], (x, y, z) => Math.min(bean(x, y, z), smin(shell(x, y, z), rim(x, y, z), 0.03), ridge(x, y, z)))
    }
    case BANDANA: {
      // cloth tied tight over the top, down lower at the back, knotted
      // there with two tails in the detail colour
      const yc = above
      const r = fr.rx(yc)
      const shell: Field = (x, y, z) =>
        smax(fr.bean(x, y, z) - 0.025, yc - 0.16 * smooth(0.1, -0.9, z / (r * zs)) - y, 0.02)
      const back = new THREE.Vector3(0, yc - 0.08, -fr.rx(yc - 0.08) * zs - 0.02)
      const [lo, hi] = box(0.1, yc - 0.3, crown + 0.08)
      return H([gearPiece(fr, shell, lo, hi, A), ...knotAndTails(fr, back, T, 0.36)], (x, y, z) => Math.min(bean(x, y, z), shell(x, y, z)))
    }
    case HOOD: {
      // a hood up over the head and down onto the shoulders, the face
      // looking out of it, two cords hanging from the front
      // the hem clears the shoulders: the fillet where each arm grows out
      // bulges up under a lower one and moves about inside it
      const yBot = HIP_Y + WAIST_OFF + SHOULDER_OFF + 0.38
      const fz = fr.rx(EYE_Y) * zs
      const { w, h, y: fy } = fr.face
      const hole = ellipsoid(0, fy, fz + 0.1, w + 0.13, h + 0.1, 0.42)
      const shell: Field = (x, y, z) =>
        smax(smax(fr.bean(x, y, z) - 0.055, yBot - y, 0.03), -hole(x, y, z), 0.035)
      // the cords hang either side of the face, not across it
      const cords: Field[] = [1, -1].map((s) => {
        const cx = w + 0.1
        const z0 = Math.sqrt(Math.max(0, fr.rx(yBot) ** 2 - cx * cx)) * zs
        return roundCone(s * cx, yBot + 0.04, z0 + 0.05, s * (cx + 0.02), yBot - 0.3, z0 + 0.1, 0.035, 0.035)
      })
      const [lo, hi] = box(0.18, yBot - 0.08, crown + 0.1)
      return H([
        gearPiece(fr, shell, [lo[0] - 0.1, lo[1], lo[2] - 0.1], [hi[0] + 0.1, hi[1], hi[2] + 0.1], A),
        gearPiece(fr, (x, y, z) => Math.min(cords[0](x, y, z), cords[1](x, y, z)), [-0.4, yBot - 0.4, 0], [0.4, yBot + 0.2, 0.8], T),
      ], (x, y, z) => Math.min(bean(x, y, z), shell(x, y, z)))
    }
    case HELMET: {
      /*
        The space helmet, and the life-support pack that goes with it. A
        bubble a little proud of the whole dome, cut off at a neck ring above
        the shoulders, with a big visor opening over the face window: the
        face panel sunk into the bean behind it is the visor glass (the
        material tints it gold when this hat is on, eyes still showing
        through), which is how a Fall Guys bean in a helmet still has a
        face. The rim of that opening, the neck ring, an antenna and the
        pack's trim take the hat colour; the shell and the pack are the
        suit's white and the pack its grey; a lamp on the other temple is
        the glint white.
      */
      const W = ROLE.WHITE
      const yBot = HIP_Y + WAIST_OFF + SHOULDER_OFF + 0.2
      const { w, h, y: fy } = fr.face
      const hr = fr.rx(fy)
      // rounder than the dome under it, so it reads as a bowl worn over the
      // head rather than as the bean's own top painted white
      const bubble = ellipsoid(0, fy + 0.06, 0.02, hr + 0.2, crown - fy + 0.13, hr * zs + 0.2)
      const dome: Field = (x, y, z) => smin(fr.bean(x, y, z) - 0.085, bubble(x, y, z), 0.12)
      const vw = w + 0.09
      const vh = h + 0.07
      const fz = hr * zs
      const hole = ellipsoid(0, fy, fz + 0.12, vw, vh, 0.5)
      const shell: Field = (x, y, z) => smax(smax(dome(x, y, z), yBot - y, 0.03), -hole(x, y, z), 0.03)
      // the visor's rim: a tube running round the opening on the shell
      const rim: Field = (x, y, z) => {
        const e = len(x / vw, (y - fy) / vh)
        const along = (e - 1) * Math.min(vw, vh)
        return len(along, dome(x, y, z)) - 0.04 + Math.max(0, 0.05 - z) * 2
      }
      const neck = bandField(fr, yBot + 0.02, 0, 0, 0.1, 0.075, 0.055)
      const aBase = new THREE.Vector3(hr * 0.72, crown - 0.02, -0.1)
      const antenna = roundCone(aBase.x, aBase.y, aBase.z, aBase.x + 0.08, aBase.y + 0.36, aBase.z - 0.04, 0.03, 0.016)
      const ball = ellipsoid(aBase.x + 0.08, aBase.y + 0.39, aBase.z - 0.04, 0.045, 0.045, 0.045)
      const lampAt = new THREE.Vector3(-(hr + 0.1) * 0.93, fy + 0.2, (hr * zs + 0.1) * 0.35)
      const lampHousing = roundCone(lampAt.x + 0.04, lampAt.y, lampAt.z - 0.02, lampAt.x - 0.03, lampAt.y, lampAt.z + 0.03, 0.075, 0.07)
      const lamp = ellipsoid(lampAt.x - 0.06, lampAt.y, lampAt.z + 0.05, 0.03, 0.05, 0.05)
      // the pack: a rounded slab on the back, below the helmet
      const py0 = HIP_Y + WAIST_OFF + 0.05
      const py1 = yBot - 0.02
      const pyc = (py0 + py1) / 2
      const backZ = -fr.rx(pyc) * zs
      const pack: Field = (x, y, z) => {
        const qx = Math.abs(x) - 0.32
        const qy = Math.abs(y - pyc) - ((py1 - py0) / 2 - 0.08)
        const qz = Math.abs(z - (backZ - 0.13)) - 0.1
        return Math.min(Math.max(qx, qy, qz), 0) + len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) - 0.08
      }
      // two hoses from the pack's shoulders round to the neck ring, and a
      // stripe across the pack in the hat colour
      const hoses: Field[] = [1, -1].map((sx) =>
        roundCone(sx * 0.22, py1 - 0.02, backZ - 0.12, sx * 0.34, yBot + 0.02, -0.15, 0.035, 0.035))
      const band: Field = (x, y, z) => smax(pack(x, y, z) - 0.018, Math.abs(y - (pyc + 0.12)) - 0.045, 0.01)
      const [lo, hi] = box(0.32, yBot - 0.15, crown + 0.22)
      const packLo: [number, number, number] = [-0.52, py0 - 0.12, backZ - 0.42]
      const packHi: [number, number, number] = [0.5, yBot + 0.2, 0.05]
      // nothing is worn over the helmet: headphones on a bubble would clip
      // its antenna and lamp, and nobody hears anything in space anyway
      return H([
        // the shell is big and smooth, so it is drawn a size coarser than
        // other headgear: the finer grid tripled this variant for nothing
        gearPiece(fr, shell, [lo[0] - 0.05, lo[1], lo[2] - 0.05], [hi[0] + 0.05, hi[1], hi[2] + 0.1], W, undefined, 0.045),
        gearPiece(fr, (x, y, z) => Math.min(rim(x, y, z), neck(x, y, z), antenna(x, y, z), ball(x, y, z), lampHousing(x, y, z)),
          [lo[0] - 0.05, lo[1] - 0.1, lo[2] - 0.05], [hi[0] + 0.05, crown + 0.5, hi[2] + 0.12], A, undefined, 0.032),
        gearPiece(fr, lamp, [lampAt.x - 0.2, lampAt.y - 0.12, lampAt.z - 0.1], [lampAt.x + 0.1, lampAt.y + 0.12, lampAt.z + 0.2], ROLE.GLINT, undefined, 0.02),
        gearPiece(fr, (x, y, z) => Math.min(pack(x, y, z), hoses[0](x, y, z), hoses[1](x, y, z)), packLo, packHi, ROLE.GREY, undefined, 0.04),
        gearPiece(fr, band, packLo, packHi, A),
      ], null)
    }
    default:
      return H([], bean) // bare-headed
  }
}

/* -------------------------------------------------- worn with any hat -- */

/** what a variant wears besides its headgear, as bits: the beaver's
    modelled parts and the headphones. Both go with any hat, which is why
    they are not hats */
export const GEAR_BEAVER = 1
export const GEAR_PHONES = 2
export const GEAR_COUNT = 4

/** how far along a ray from o (direction d, unit) the outermost inside of
    a field lies, marching in from `far` and then bisecting: the outside of
    a hat, brim and all, where a strap laid over it rests. 0 on a miss */
const outermost = (
  f: Field, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, far = 1.8,
): number => {
  const at = (r: number) => f(ox + dx * r, oy + dy * r, oz + dz * r)
  const STEP = 0.015
  let r = far
  while (r > 0 && at(r) >= 0) r -= STEP
  if (r <= 0) return 0
  let lo = r
  let hi = r + STEP
  for (let k = 0; k < 7; k++) {
    const mid = (lo + hi) / 2
    if (at(mid) < 0) lo = mid
    else hi = mid
  }
  return lo
}

/** a field's gradient, normalized: which way is out */
const gradOf = (f: Field, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 => {
  const e = 0.008
  return out.set(
    f(x + e, y, z) - f(x - e, y, z), f(x, y + e, z) - f(x, y - e, z), f(x, y, z + e) - f(x, y, z - e),
  ).normalize()
}

/** a rounded disc whose axis is x: radius `r`, from x0 to x1, its edges
    rounded by `rr`. A cushion, a cup */
const discX = (cy: number, cz: number, r: number, x0: number, x1: number, rr: number): Field => {
  const cx = (x0 + x1) / 2
  const ht = (x1 - x0) / 2
  return (x, y, z) => {
    const a = len(y - cy, z - cz) - (r - rr)
    const b = Math.abs(x - cx) - (ht - rr)
    return Math.min(Math.max(a, b), 0) + len(Math.max(a, 0), Math.max(b, 0)) - rr
  }
}

/** a ring round the x axis at x = cx: radius `r`, tube `t` */
const ringX = (cx: number, cy: number, cz: number, r: number, t: number): Field =>
  (x, y, z) => len(len(y - cy, z - cz) - r, x - cx) - t

/** a flat strap laid along a polyline in the plane z = z0: `ht` thick
    across the line and `hw` wide along z, its edges rounded by `rr` */
const strap = (pts: Array<[number, number]>, z0: number, ht: number, hw: number, rr: number): Field => {
  const n = pts.length
  return (x, y, z) => {
    let d2 = Infinity
    for (let i = 0; i + 1 < n; i++) {
      const [ax, ay] = pts[i]
      const [bx, by] = pts[i + 1]
      const ex = bx - ax
      const ey = by - ay
      let t = ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const qx = x - ax - ex * t
      const qy = y - ay - ey * t
      const q = qx * qx + qy * qy
      if (q < d2) d2 = q
    }
    const a = Math.sqrt(d2) - (ht - rr)
    const b = Math.abs(z - z0) - (hw - rr)
    return Math.min(Math.max(a, b), 0) + len(Math.max(a, 0), Math.max(b, 0)) - rr
  }
}

/** a tube along a 3D polyline */
const tube = (pts: THREE.Vector3[], r: number): Field => (x, y, z) => {
  let d = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    d = Math.min(d, segDist(x, y, z, a.x, a.y, a.z, b.x, b.y, b.z))
  }
  return d - r
}

type Box = [[number, number, number], [number, number, number]]
/** the box round a set of points, padded */
const boxOf = (pts: ReadonlyArray<{ x: number; y: number; z: number }>, pad: number): Box => {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const p of pts) {
    lo[0] = Math.min(lo[0], p.x - pad)
    lo[1] = Math.min(lo[1], p.y - pad)
    lo[2] = Math.min(lo[2], p.z - pad)
    hi[0] = Math.max(hi[0], p.x + pad)
    hi[1] = Math.max(hi[1], p.y + pad)
    hi[2] = Math.max(hi[2], p.z + pad)
  }
  return [lo, hi]
}

/** the convex hull of 2D points (Andrew's monotone chain), counter-clockwise */
const hull2 = (src: Array<[number, number]>): Array<[number, number]> => {
  const p = [...src].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Array<[number, number]> = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** how far a ray from the origin travels before leaving a convex polygon
    that contains it */
const rayOut = (poly: Array<[number, number]>, dx: number, dy: number): number => {
  let best = 0
  for (let i = 0; i < poly.length; i++) {
    const [px, py] = poly[i]
    const [qx, qy] = poly[(i + 1) % poly.length]
    const ex = qx - px
    const ey = qy - py
    const den = dx * ey - dy * ex
    if (Math.abs(den) < 1e-9) continue
    const t = (px * ey - py * ex) / den
    const u = (px * dy - py * dx) / den
    if (u >= -1e-6 && u <= 1 + 1e-6 && t > best) best = t
  }
  return best
}

const EMPTY_PIECE: Piece = {
  pos: new Float32Array(0), nrm: new Float32Array(0), si: new Uint16Array(0), sw: new Float32Array(0),
  part: new Float32Array(0), role: 0, idx: new Uint32Array(0),
}

/** `count` jobs sharing one setup (a few thousand field samples, where a
    strap or an ear lands), which is paid inside the first of them a slice
    at a time rather than when the job list is drawn up: a variant is built
    in 2.5 ms slices mid-walk, and a setup run eagerly would be one slice
    of ten */
const lazyJobs = <T>(
  count: number, setup: () => Generator<void, T, void>, make: (s: T, i: number) => PieceJob | null,
): PieceJob[] => {
  let done: { v: T } | null = null
  const get = function* (): Generator<void, T, void> {
    if (!done) done = { v: yield* setup() }
    return done.v
  }
  return Array.from({ length: count }, (_, i) => function* () {
    const job = make(yield* get(), i)
    return job ? yield* job() : EMPTY_PIECE
  })
}

/*
  The beaver onesie. The fur, the cream belly and the paws are printed on
  the bean by the material (costume 5, in the look's fur shade); what is
  modelled is what a print cannot do: a flat paddle of a tail hanging off
  the seat, printed with its scales (role TAIL), two small round ears, and
  a snout low in the face window: two cream cheeks, a dark nose and two big
  front teeth. The ears are found on whatever the head is wearing (`hug`:
  the hood's outside when the hood is up), low on the back of the skull:
  under the line where a cap, a hard hat or a bucket hat's brim starts, and
  behind where a pair of headphones' forks come down, so all three can be
  worn at once. Under the space helmet (`hug` null) there are no ears and
  no snout, since the bubble would cut them and the visor covers the face.
*/
const beaverPieces = (fr: Frame, hug: Field | null): PieceJob[] => {
  const zs = fr.bd.zs
  const jobs: PieceJob[] = []
  // the tail: a short root out of the seat, then the paddle hanging back
  // and down at forty-odd degrees, its broad face to the back
  const yR = 0.8
  const backZ = -fr.rx(yR) * zs
  const L = new THREE.Vector3(0, -0.72, -0.69).normalize()
  const N = new THREE.Vector3(0, 0.69, -0.72).normalize()
  const root = new THREE.Vector3(0, yR, backZ + 0.05)
  const mid = root.clone().addScaledVector(L, 0.44)
  const paddle = ellipsoid(mid.x, mid.y, mid.z, 0.25, 0.05, 0.33, [1, 0, 0, N.x, N.y, N.z, L.x, L.y, L.z])
  const neck = root.clone().addScaledVector(L, 0.16)
  const stem = roundCone(root.x, root.y, root.z, neck.x, neck.y, neck.z, 0.12, 0.07)
  const tail: Field = (x, y, z) => smin(stem(x, y, z), paddle(x, y, z), 0.06)
  const tip = mid.clone().addScaledVector(L, 0.36)
  const [tlo, thi] = boxOf([root, tip, mid.clone().addScaledVector(N, 0.1)], 0.3)
  jobs.push(gearPiece(fr, tail, tlo, thi, ROLE.TAIL, undefined, 0.03))
  if (!hug) return jobs

  const { h, y: fy } = fr.face
  // the front of the face at a point of the window, which is sunk into the bean
  const front = (x: number, y: number) => outermost(fr.bean, x, y, 0, 0, 0, 1, 1.2)
  // the snout: two cheeks, a nose on them and the teeth under them, low in
  // the window so the eyes above it still read
  const cy = fy - 0.52 * h
  const cheeks: Field[] = [1, -1].map((s) => {
    const x = s * 0.078
    return ellipsoid(x, cy, front(x, cy) + 0.02, 0.092, 0.07, 0.06)
  })
  const ny = cy + 0.055
  const nose = ellipsoid(0, ny, front(0, ny) + 0.068, 0.055, 0.036, 0.036)
  const ty = cy - 0.085
  const tz = front(0, ty) + 0.05
  const teeth: Field[] = [1, -1].map((s) => {
    const cx = s * 0.029
    return (x, y, z) => {
      const qx = Math.abs(x - cx) - 0.013
      const qy = Math.abs(y - ty) - 0.038
      const qz = Math.abs(z - tz) - 0.004
      return Math.min(Math.max(qx, qy, qz), 0) + len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) - 0.012
    }
  })
  const snoutLo: [number, number, number] = [-0.25, ty - 0.12, 0.1]
  const snoutHi: [number, number, number] = [0.25, ny + 0.1, 0.9]
  jobs.push(
    gearPiece(fr, (x, y, z) => smin(cheeks[0](x, y, z), cheeks[1](x, y, z), 0.03), snoutLo, snoutHi, ROLE.CREAM, undefined, 0.022),
    gearPiece(fr, nose, snoutLo, snoutHi, ROLE.INK, undefined, 0.02),
    gearPiece(fr, (x, y, z) => Math.min(teeth[0](x, y, z), teeth[1](x, y, z)), snoutLo, snoutHi, ROLE.WHITE, undefined, 0.012),
  )

  // the ears, each a fur disc with a cream one set into its front face
  jobs.push(...lazyJobs(4, function* () {
    const out: Array<{ f: Field; box: Box }> = []
    const yE = EYE_Y + 0.21
    const creams: Array<{ f: Field; box: Box }> = []
    for (const s of [1, -1]) {
      yield
      const th = s * 2.0
      const dx = Math.sin(th)
      const dz = Math.cos(th)
      const r = outermost(hug, 0, yE, 0, dx, 0, dz)
      const P = new THREE.Vector3(dx * r, yE, dz * r)
      const n = gradOf(hug, P.x, P.y, P.z, new THREE.Vector3())
      const up = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize()
      // the ear's face turns forward
      const t = new THREE.Vector3().crossVectors(n, up)
      if (t.z < 0) t.negate()
      const C = P.clone().addScaledVector(n, 0.04).addScaledVector(up, 0.01)
      const basis = [n.x, n.y, n.z, up.x, up.y, up.z, t.x, t.y, t.z]
      const I = C.clone().addScaledVector(t, 0.027).addScaledVector(n, 0.016)
      out.push({ f: ellipsoid(C.x, C.y, C.z, 0.105, 0.1, 0.04, basis), box: boxOf([C], 0.16) })
      creams.push({ f: ellipsoid(I.x, I.y, I.z, 0.062, 0.058, 0.018, basis), box: boxOf([I], 0.1) })
    }
    return out.concat(creams)
  }, (ears, i) => gearPiece(fr, ears[i].f, ears[i].box[0], ears[i].box[1], i < 2 ? ROLE.FUR : ROLE.CREAM, undefined, 0.02)))
  return jobs
}

/*
  The headphones: a closed-back gaming headset, drawn after a HyperX Cloud
  Alpha. A black padded band with a stripe of the accent down its spine,
  the accent's metal sliders and forks holding two big round black cups,
  each a leather cushion against the head and a shell with a ring and a
  small logo of the accent on its outer face, and a black boom mic with a
  foam tip off the left cup (the body's left, +x). Black and red unless the
  look says otherwise (`phones` in look.ts), which is a palette entry, not
  geometry.

  They are worn over whatever is on the head, and that is the whole
  problem, so nothing here is placed by hand. `hug` is the bean and the
  hat's own outside (brims and all, never tails or cords); the cups sit
  against its widest point over their footprint at ear height, and the
  band is the convex hull of its outline in the band's plane, laid a strap's
  thickness off it: over a cap it crosses the cap's crown and button, over a
  hood the hood, over a bucket hat it rides out over the brim, and behind a
  party hat (`bandZ`) rather than up round the cone. The mic's path is
  pushed out of the same field so it never goes through a hood's rim.

  Every vertex is weighted to the head bone outright: a headset is rigid,
  and skinned to the neck under its lower rim the cups sheared on a nod.
*/
const phonesPieces = (fr: Frame, hug: Field, bandZ: number): PieceJob[] => {
  const yC = EYE_Y - 0.03
  const zC = -0.02
  /** the cups' radius */
  const R = 0.2
  /** how far the band's middle lies off whatever it rests on */
  const CLEAR = 0.04
  const K = 40
  const H = B.HEAD
  interface Rig {
    band: Field
    stripe: Field
    bandBox: Box
    sliders: Field
    sliderBox: Box
    xin: number
    xo: number
    xm: number
    Ry: number
    mic: Field
    micBox: Box
  }
  return lazyJobs<Rig>(8, function* () {
    // the cups' inner face: the widest the head (and hat) get over their footprint
    let xin = 0
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const dy = (i / 2) * R * 0.85
        const dz = (j / 2) * R * 0.85
        if (dy * dy + dz * dz > (R * 0.9) ** 2) continue
        for (const sx of [1, -1]) xin = Math.max(xin, outermost(hug, 0, yC + dy, zC + dz, sx, 0, 0, 1.4))
      }
      yield
    }
    xin += 0.012
    const xo = xin + 0.17
    const xm = xin + 0.11
    const Ry = R + 0.032
    const Ty = yC + Ry
    // the outline of the head and hat in the band's plane, over the top
    const pts: Array<[number, number]> = []
    for (let a = -84; a <= 84; a += 4) {
      const ph = (a * Math.PI) / 180
      const dx = Math.sin(ph)
      const dy = Math.cos(ph)
      let r = 0
      for (const dz of [-0.07, 0, 0.07]) r = Math.max(r, outermost(hug, 0, yC, bandZ + dz, dx, dy, 0))
      pts.push([dx * r, dy * r])
      if (a % 16 === 0) yield
    }
    // the band comes down to just over each fork, and the hull closes under
    // the centre so the centre is inside it
    const Ax = xm - CLEAR
    const Ay = Ty + 0.09 - yC
    pts.push([Ax, Ay], [-Ax, Ay], [0, -0.3])
    const hull = hull2(pts)
    const phA = Math.atan2(Ax, Ay)
    const rs: number[] = []
    const phs: number[] = []
    for (let k = 0; k <= K; k++) {
      const ph = -phA + (2 * phA * k) / K
      phs.push(ph)
      rs.push(rayOut(hull, Math.sin(ph), Math.cos(ph)) + CLEAR)
    }
    // a light smoothing that may only move the band outward
    const sm = rs.map((r, k) => {
      let s = 0
      let n = 0
      for (let q = -2; q <= 2; q++) {
        const i = k + q
        if (i < 0 || i > K) continue
        s += rs[i]
        n++
      }
      return Math.max(r, s / n)
    })
    const line = phs.map((ph, k): [number, number] => [Math.sin(ph) * sm[k], yC + Math.cos(ph) * sm[k]])
    const spine = phs
      .map((ph, k): [number, number] => [Math.sin(ph) * (sm[k] + 0.03), yC + Math.cos(ph) * (sm[k] + 0.03)])
      .slice(Math.round(K * 0.14), Math.round(K * 0.86) + 1)
    const band = strap(line, bandZ, 0.036, 0.078, 0.026)
    const stripe = strap(spine, bandZ, 0.012, 0.022, 0.01)
    const topY = Math.max(...line.map((p) => p[1]))
    const bx = Math.max(...line.map((p) => Math.abs(p[0])))
    const bandBox: Box = [[-bx - 0.12, yC - 0.05, bandZ - 0.14], [bx + 0.12, topY + 0.1, bandZ + 0.14]]
    // the sliders, from each end of the band down to the top of its fork,
    // with a block where they leave the band
    const ends = [line[0], line[K]].map(([x, y]) => new THREE.Vector3(x, y, bandZ))
    const tops = ends.map((e) => new THREE.Vector3(Math.sign(e.x) * xm, Ty, zC))
    const rods = ends.map((e, i) => roundCone(e.x, e.y + 0.02, e.z, tops[i].x, tops[i].y, tops[i].z, 0.026, 0.024))
    const blocks = ends.map((e) => ellipsoid(e.x, e.y, e.z, 0.045, 0.055, 0.052))
    const sliders: Field = (x, y, z) =>
      Math.min(rods[0](x, y, z), rods[1](x, y, z), blocks[0](x, y, z), blocks[1](x, y, z))
    const sliderBox = boxOf([...ends, ...tops], 0.1)
    yield
    // the boom: out of the front of the left cup, down and forward to the
    // corner of the mouth, pushed clear of anything it would pass through
    const tipY = yC - 0.19
    const tipX = 0.3
    const tip = new THREE.Vector3(tipX, tipY, outermost(hug, tipX, tipY, 0, 0, 0, 1, 1.4) + 0.11)
    const P0 = new THREE.Vector3(xin + 0.12, yC - 0.09, zC + 0.1)
    const P1 = new THREE.Vector3(xo + 0.03, yC - 0.3, zC + 0.3)
    const path: THREE.Vector3[] = []
    const g = new THREE.Vector3()
    for (let k = 0; k <= 10; k++) {
      const t = k / 10
      const p = new THREE.Vector3()
        .addScaledVector(P0, (1 - t) * (1 - t)).addScaledVector(P1, 2 * t * (1 - t)).addScaledVector(tip, t * t)
      if (k > 1) {
        for (let it = 0; it < 4; it++) {
          const d = hug(p.x, p.y, p.z)
          if (d >= 0.05) break
          p.addScaledVector(gradOf(hug, p.x, p.y, p.z, g), 0.05 - d)
        }
      }
      path.push(p)
    }
    const end = path[path.length - 1]
    const boom = tube(path, 0.02)
    const foam = ellipsoid(end.x, end.y, end.z, 0.055, 0.05, 0.058)
    const mic: Field = (x, y, z) => smin(boom(x, y, z), foam(x, y, z), 0.02)
    return { band, stripe, bandBox, sliders, sliderBox, xin, xo, xm, Ry, mic, micBox: boxOf(path, 0.1) }
  }, (r, i) => {
    const cupBox = (s: number): Box => {
      const x0 = r.xin - 0.04
      const x1 = r.xo + 0.04
      return [
        [s > 0 ? x0 : -x1, yC - r.Ry - 0.08, zC - r.Ry - 0.08],
        [s > 0 ? x1 : -x0, yC + r.Ry + 0.08, zC + r.Ry + 0.08],
      ]
    }
    // one side's cup, drawn for +x; the other side reads it mirrored
    const cushion = discX(yC, zC, R, r.xin, r.xin + 0.08, 0.035)
    const shell = discX(yC, zC, R - 0.018, r.xin + 0.06, r.xo, 0.05)
    const black: Field = (x, y, z) => Math.min(cushion(x, y, z), shell(x, y, z))
    const ring = ringX(r.xo - 0.008, yC, zC, 0.128, 0.018)
    const logo = ellipsoid(r.xo - 0.004, yC, zC, 0.016, 0.042, 0.03)
    const arc: Field = (x, y, z) =>
      smax(len(len(y - yC, z - zC) - r.Ry, x - r.xm) - 0.022, yC - 0.005 - y, 0.01)
    const pivots = [1, -1].map((s) => ellipsoid(r.xm, yC, zC + s * r.Ry, 0.034, 0.034, 0.034))
    const metal: Field = (x, y, z) =>
      Math.min(ring(x, y, z), logo(x, y, z), arc(x, y, z), pivots[0](x, y, z), pivots[1](x, y, z))
    const M = ROLE.PHONES_METAL
    const P = ROLE.PHONES
    switch (i) {
      case 0: return gearPiece(fr, r.band, r.bandBox[0], r.bandBox[1], P, undefined, 0.026, H)
      case 1: return gearPiece(fr, r.stripe, r.bandBox[0], r.bandBox[1], M, undefined, 0.012, H)
      case 2: return gearPiece(fr, r.sliders, r.sliderBox[0], r.sliderBox[1], M, undefined, 0.018, H)
      case 3: return gearPiece(fr, black, ...cupBox(1), P, undefined, 0.026, H)
      case 4: return gearPiece(fr, (x, y, z) => black(-x, y, z), ...cupBox(-1), P, undefined, 0.026, H)
      case 5: return gearPiece(fr, metal, ...cupBox(1), M, undefined, 0.015, H)
      case 6: return gearPiece(fr, (x, y, z) => metal(-x, y, z), ...cupBox(-1), M, undefined, 0.015, H)
      default: return gearPiece(fr, r.mic, r.micBox[0], r.micBox[1], P, undefined, 0.016, H)
    }
  })
}

/* ------------------------------------------------------------ variants -- */

/** the outfits (`look.ts`'s COSTUMES) and the faces are painted by the
    material from uniforms, not drawn: see bodyMaterial.ts */
export const COSTUME_COUNT = 6
export const FACE_COUNT = 5

/** one geometry per (headgear, build, gear), built on first use and shared
    by every body wearing it. A body changes by swapping `mesh.geometry`
    between these: same attribute layout, same material, so a swap is a
    buffer rebind and never a relink. Never dispose them: module state.
    The first HAT_COUNT * BUILD_COUNT slots are gear 0, the ones the idle
    warm-up builds; a beaver or a headset is built when somebody wears one */
const SHARED: Array<THREE.BufferGeometry | null> = new Array(HAT_COUNT * BUILD_COUNT * GEAR_COUNT).fill(null)
/** the helmet takes no headphones, so its phones variants are its bare ones */
const gearFor = (kind: number, gear: number) =>
  (kind === HELMET ? gear & ~GEAR_PHONES : gear) & (GEAR_COUNT - 1)
const keyOf = (kind: number, b: number, gear: number) => (gearFor(kind, gear) * HAT_COUNT + kind) * BUILD_COUNT + b
/** how long the last variant took to build, ms (the measure prints it) */
export let lastBuildMs = 0

/** one variant, as steps: its build's bean, each piece of its headgear
    and of whatever it wears with it, then the concatenation. Returns the
    shared geometry */
function* variantSteps(kind: number, b: number, gear = 0): Generator<void, THREE.BufferGeometry, void> {
  const key = keyOf(kind, b, gear)
  const cached = SHARED[key]
  if (cached) return cached
  const fr = frameFor(b)
  const pieces = [yield* bodySurfaceSteps(b)]
  const hat = hatBuild(fr, kind)
  const jobs = [...hat.jobs]
  if (gear & GEAR_BEAVER) jobs.push(...beaverPieces(fr, hat.hug))
  if (gear & GEAR_PHONES && hat.hug) jobs.push(...phonesPieces(fr, hat.hug, hat.bandZ))
  for (const job of jobs) {
    const piece = yield* job()
    if (piece.idx.length) pieces.push(piece)
  }
  yield
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
  return g
}

const clampHat = (hat: number) => Math.max(0, Math.min(HAT_COUNT - 1, Math.floor(hat)))

/** a variant, built on the spot if it is not built yet. What Node, the
    probes and the very first body of a session use; everything that can
    wait uses `requestBodyGeometry` */
export const bodyGeometry = (hat = 0, buildIndex = 0, gear = 0): THREE.BufferGeometry => {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0
  const g = drain(variantSteps(clampHat(hat), clampBuild(buildIndex), gear))
  lastBuildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0
  warmLater()
  return g
}

/*
  Building a variant takes a few dozen milliseconds, and a variant is first
  needed at the worst moment: a stranger in a new hat walking into view, a
  pedestrian spawned mid-stride, a player changing their look. So outside of
  Node a new variant is never built on the spot. It is queued, the body
  wears a variant that is already built (its own build bare, or any) until it
  is ready, and the queue is worked a slice at a time by `tickBodyBuilds`,
  which every body's update calls and which does at most TICK_BUDGET_MS of
  building in any TICK_EVERY_MS of wall clock, however many bodies there
  are. The first variant of a session is the exception: there is nothing to
  wear instead, and it is built under the boot cover anyway.
*/
const TICK_BUDGET_MS = 2.5
const TICK_EVERY_MS = 10
let syncBuilds = typeof window === 'undefined'
/** true: every variant is built the moment it is asked for (Node, the
    probes, anything that must see the finished body at once) */
export const setBodyBuildSync = (sync: boolean) => {
  syncBuilds = sync
}
interface BuildJob {
  key: number
  gen: Generator<void, THREE.BufferGeometry, void>
}
const queue: BuildJob[] = []
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const enqueue = (kind: number, b: number, gear = 0) => {
  const key = keyOf(kind, b, gear)
  if (SHARED[key] || queue.some((j) => j.key === key)) return
  queue.push({ key, gen: variantSteps(kind, b, gear) })
}
/** the variant, if it is built; otherwise it is queued and this is null.
    `gear` is GEAR_BEAVER | GEAR_PHONES */
export const requestBodyGeometry = (hat: number, buildIndex: number, gear = 0): THREE.BufferGeometry | null => {
  const kind = clampHat(hat)
  const b = clampBuild(buildIndex)
  const cached = SHARED[keyOf(kind, b, gear)]
  if (cached) return cached
  if (syncBuilds || !SHARED.some((g) => g)) return bodyGeometry(kind, b, gear)
  enqueue(kind, b, gear)
  return null
}
/** something already built to wear while a variant is queued: the same
    headgear without the extras, the same build bare-headed, or failing
    that anything */
export const fallbackBodyGeometry = (buildIndex: number, hat = 6): THREE.BufferGeometry => {
  const b = clampBuild(buildIndex)
  return SHARED[keyOf(clampHat(hat), b, 0)] ?? SHARED[6 * BUILD_COUNT + b] ?? SHARED.find((g) => g) ?? bodyGeometry(6, b)
}
/** work the queue for up to `budgetMs`. Returns whether anything is left */
export const pumpBodyBuilds = (budgetMs: number): boolean => {
  const t0 = now()
  while (queue.length && now() - t0 < budgetMs) {
    const job = queue[0]
    if (SHARED[job.key] || job.gen.next().done) queue.shift()
  }
  return queue.length > 0
}
let lastTick = -Infinity
/** the per-frame share of the queue: cheap to call from every body */
export const tickBodyBuilds = () => {
  if (!queue.length) return
  const t = now()
  if (t - lastTick < TICK_EVERY_MS) return
  lastTick = t
  pumpBodyBuilds(TICK_BUDGET_MS)
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
  const next = () => {
    // every build's bare bean first (the fallback everything else wears),
    // then every headgear on every build
    for (let b = 0; b < BUILD_COUNT; b++) if (!SHARED[6 * BUILD_COUNT + b]) return enqueue(6, b)
    for (let k = 0; k < HAT_COUNT * BUILD_COUNT; k++) {
      if (!SHARED[k]) return enqueue(Math.floor(k / BUILD_COUNT), k % BUILD_COUNT)
    }
  }
  const step = (d: { timeRemaining: () => number }) => {
    if (!queue.length) next()
    if (!queue.length) return
    const left = d.timeRemaining() - 1
    if (left > 1) pumpBodyBuilds(left)
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
export const timeVariant = (hat: number, buildIndex: number, gear = 0): number => {
  const b = clampBuild(buildIndex)
  const key = keyOf(clampHat(hat), b, gear)
  const keep = [SHARED[key], BODY_SURF[b], FRAMES[b]] as const
  SHARED[key] = null
  BODY_SURF[b] = null
  FRAMES[b] = null
  const t0 = performance.now()
  bodyGeometry(hat, b, gear)
  const ms = performance.now() - t0
  SHARED[key] = keep[0]
  BODY_SURF[b] = keep[1]
  FRAMES[b] = keep[2]
  return ms
}
