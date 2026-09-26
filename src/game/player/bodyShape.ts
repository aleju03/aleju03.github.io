import * as THREE from 'three'

/*
  The drawing of the player character: one skinned soup, built once per
  session and shared by every body in the world.

  The character is a jelly brawler in the Gang Beasts mould: one continuous
  piece of flat-coloured gummy, hunched, with a pinched neck under a round
  head that reads as its own shape, a narrow belly on short stumpy legs, and
  two arms that come off the shoulders clear of the body, with air under the
  armpit and down each side, thinner than the trunk and rounded at the end,
  hanging to mid-thigh. The face is small dark marks in one of five
  expressions (dots, sleepy, angry, surprised, one-eyed) hashed from the look. One piece of headgear out of eight:
  a knotted cloth sweatband, a wrestler's mask, a bucket hat, a party hat, a
  hard hat, a bandana, nothing, or a hood that drapes onto the shoulders; one
  of five builds (brawler, round, skinny, tall, squat) that change girth and
  how far the dome rises over the eyes; and one of four outfits (nothing, a
  cape, a hooped vest, an animal onesie with ears and a tail) that change the
  trunk's outline or blocking. All three are geometry variants of the one
  body (8 x 5 x 4 of them, each built on first use and shared), so it is
  still one draw call whatever it is. The character is in the colours,
  the hat and the pose, not in the body: every hat's geometry is a variant of
  the one body, so a body is still one draw call whatever it wears.

  Two earlier drawings are worth remembering as warnings. A straight-sided
  body on dark shorts and shoes read as three things stacked, a tin can on
  trousers. A pastel pear with a tall dome and a pale belly patch read as a
  plush mascot, the exact "too cute" the owner had already turned down.

  It is drawn for the look the whole game is rendered through (a low
  internal resolution, posterized, outlined), so everything that carries
  identity is a big flat block of one colour, and the material gives it a
  slight gummy sheen and a soft rim so the bean reads as a volume rather than
  as a cut-out.

  Why one skinned mesh rather than a mesh per part:

  - **Cost.** A town wears several of these. One draw call per body, two with
    a shadow. `npm run measure -- body` prints the numbers.
  - **Softness.** Real skin weights bend, which is the whole of a jelly body.
    The bean is one lathe weighted from the pelvis up through the torso into
    the head, with a third weight on a belly bone, so a lean folds it, the
    head lags and bobbles as the top of the same blob, and the belly wobbles
    on its own spring. Each limb is one tube blended across its elbow or
    knee, so an arm is a noodle rather than two sticks and a ball.
  - **Colour stays a uniform.** Every vertex carries a small `aRole` code and
    `bodyMaterial.ts` looks the colour up in a per-body palette uniform. Four
    `Color.set()` calls repaint a body and nothing can relink a shader. The
    same code carries a head flag, which is how the first-person lens stops
    seeing the inside of its own head without taking it out of the shadow map.

  Everything here is authored in *design units* in the rest pose (feet at
  y = 0, facing +Z, arms hanging straight down), which is also the bind pose,
  so a bone's inverse bind matrix is nothing but its rest position negated.
  `playerBody.ts` owns the bones; this module only says where they are at
  rest and which vertices follow which.

  Headless-safe: plain BufferGeometry and arithmetic, nothing that needs a
  document or a GL context, so `npm run measure -- body` can build it in Node.
*/

/* ---------------------------------------------------------- dimensions -- */

// stub legs: a jelly brawler is nearly all bean, and a short leg is what
// makes every step a waddle and every stop a wobble
export const THIGH = 0.36
export const SHIN = 0.34
/** the hip joints' height over the soles */
export const HIP_Y = THIGH + SHIN // 0.70
export const HIP_X = 0.24
/** the foot bone's height over its sole */
export const ANKLE_H = 0.1
/** pelvis bone up to the torso bone. The bean is weighted across it */
export const WAIST_OFF = 0.3
// heavy shoulders: the widest part of the bean is up where the arms hang
export const SHOULDER_X = 0.6
export const SHOULDER_OFF = 0.66
/** the shoulders ride the hunch forward (see `hz`), slouched */
const SHOULDER_Z = 0.12
/** torso bone up to the head bone: where the bean stops being body and
    starts being head, which is only ever a matter of weights */
export const NECK_OFF = 0.95
// tube arms long enough to swing well clear of the bean and to flop out of
// its outline in a fall
export const UARM = 0.5
export const FARM = 0.46
/** head bone up to the eyes: a face set into the upper bean, below the
    band, not jammed up under it */
export const EYE_OFF = 0.24
/** head bone up to the top of the bean: a small head on big shoulders */
export const CROWN_OFF = 0.72

/* ------------------------------------------------------------ bones ----- */

/** bone slots, in skeleton order. `playerBody.ts` builds a THREE.Bone for
    each at these rest offsets; the geometry below is weighted by index.
    POM is the knot at the back of the head (a band's, mask's or bandana's
    tails swing off it) and PACK is the
    belly, a jiggle bone the front of the bean is partly weighted to: both
    keep the names they had when they were a pom-pom and a backpack, because
    the rig's secondary springs are keyed on them */
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
} as const
export const BONE_COUNT = 18

/** the bean's extent, bottom (the seat of the shorts) to top of the head */
export const BODY_Y0 = HIP_Y - 0.26
const BODY_Y1 = HIP_Y + WAIST_OFF + NECK_OFF + CROWN_OFF - 0.02
const BODY_ZS = 0.86
/** the bean's radius at t in [0, 1] bottom to top: widest at the shoulders,
    tapering quickly into a small head that ends in a short dome. The
    control points are joined by a Catmull-Rom spline, which keeps the slope
    running through each of them: a cosine blend between them came to a
    standstill at every point, and the flat band it left at each one read as
    a quilted jacket, rings stacked up the body */
const PROF: Array<[number, number]> = [
  [0, 0.44], [0.16, 0.5], [0.34, 0.52], [0.5, 0.52], [0.58, 0.47], [0.66, 0.35], [0.75, 0.42],
  [0.85, 0.44], [1, 0.42],
]
/*
  The build: every body is one of three outlines, the same drawing scaled
  differently in three bands (hips, shoulders, head), so a crowd is not six
  copies of one shape wearing different hats. The player picks it (it rides
  in the pupils' colour, see look.ts). The eye line never moves, because it
  is what the camera agrees with, so height is varied where it can be: by how
  far the dome rises over the eyes, which is most of what reads as tall.
*/
export const BUILD_COUNT = 5
/** how much wider than the brawler each build is at the shoulders: the rig
    holds the arms that much further out, so they never sink into it */
export const buildGirth = (b: number) => BUILDS[Math.max(0, Math.min(BUILD_COUNT - 1, b))].mid
const BUILDS = [
  { hip: 1, mid: 1, head: 1, crown: 1, leg: 1 }, // the brawler
  { hip: 1.32, mid: 1.3, head: 0.95, crown: 0.9, leg: 1.2 }, // round: a ball on stumps
  { hip: 0.72, mid: 0.74, head: 0.9, crown: 1.7, leg: 0.8 }, // skinny: a stick of a thing
  { hip: 0.86, mid: 0.86, head: 0.88, crown: 3.4, leg: 0.95 }, // tall: a long domed head
  { hip: 1.15, mid: 1.18, head: 1.08, crown: 0.35, leg: 1.12 }, // squat: flat-topped, wide
]
let build = BUILDS[0]
const bandScale = (t: number) => {
  const toMid = THREE.MathUtils.smoothstep(t, 0.05, 0.5)
  const toHead = THREE.MathUtils.smoothstep(t, 0.6, 0.75)
  return (build.hip + (build.mid - build.hip) * toMid) * (1 - toHead) + build.head * toHead
}
/** the hunch: the upper body carried forward of the hips, so the mass is up
    and forward over slouched shoulders instead of a belly pushed out over
    the feet. A pure function of height, applied to everything drawn */
const hz = (y: number) => 0.16 * THREE.MathUtils.smoothstep(y, HIP_Y + 0.3, HIP_Y + 1.35)
const beanR = (t: number) => {
  let i = 1
  while (i < PROF.length - 1 && PROF[i][0] < t) i++
  const p0 = PROF[Math.max(0, i - 2)][1]
  const p1 = PROF[i - 1][1]
  const p2 = PROF[i][1]
  const p3 = PROF[Math.min(PROF.length - 1, i + 1)][1]
  const k = THREE.MathUtils.clamp((t - PROF[i - 1][0]) / (PROF[i][0] - PROF[i - 1][0]), 0, 1)
  const r =
    0.5 *
    (2 * p1 + (-p0 + p2) * k + (2 * p0 - 5 * p1 + 4 * p2 - p3) * k * k +
      (-p0 + 3 * p1 - 3 * p2 + p3) * k * k * k)
  // a round bottom, and a round dome as tall as it is wide on top
  const bot = t < 0.16 ? Math.sqrt(Math.max(0, 1 - ((0.16 - t) / 0.16) ** 2)) : 1
  const top = t > 0.85 ? Math.sqrt(Math.max(0, 1 - ((t - 0.85) / 0.15) ** 2)) : 1
  return r * bot * top * bandScale(t)
}
/** the stretch of everything above the eyes, per build: the eyes stay put
    and the dome rises or settles over them. Drawing code works in unstretched
    height `t` and places with `stretch`; anything that asks the surface a
    question at a real height goes through `tOf`, which undoes it */
const EYE_TOP = HIP_Y + WAIST_OFF + NECK_OFF + EYE_OFF + 0.04
const stretch = (y: number) => (y <= EYE_TOP ? y : EYE_TOP + (y - EYE_TOP) * build.crown)
const unstretch = (y: number) => (y <= EYE_TOP ? y : EYE_TOP + (y - EYE_TOP) / build.crown)
const tOf = (y: number) => (unstretch(y) - BODY_Y0) / (BODY_Y1 - BODY_Y0)

const KNOT_UP = EYE_OFF + 0.2
const HEAD_Z = hz(HIP_Y + WAIST_OFF + NECK_OFF + 0.2)
const KNOT_Z = (() => {
  const y = HIP_Y + WAIST_OFF + NECK_OFF + KNOT_UP
  return hz(y) - beanR(THREE.MathUtils.clamp(tOf(y), 0, 1)) * BODY_ZS - 0.04
})()

/** parent slot of each bone (-1: hangs off the group) and its offset from
    that parent at rest, design units */
export const BONE_REST: Array<{ parent: number; at: [number, number, number] }> = [
  { parent: -1, at: [0, HIP_Y, 0] }, // pelvis
  { parent: B.PELVIS, at: [0, WAIST_OFF, 0] }, // torso
  // the head pivots under its own lobe, which the hunch carries forward: a
  // pivot left behind it swung the back of the head down through the neck
  // every time the chin came up, and folded the neck inside out
  { parent: B.TORSO, at: [0, NECK_OFF, HEAD_Z] }, // head
  { parent: B.TORSO, at: [SHOULDER_X, SHOULDER_OFF, SHOULDER_Z] }, // upper arm L (+x)
  { parent: B.UARM_L, at: [0, -UARM, 0] },
  { parent: B.FARM_L, at: [0, -FARM, 0] },
  { parent: B.TORSO, at: [-SHOULDER_X, SHOULDER_OFF, SHOULDER_Z] }, // upper arm R
  { parent: B.UARM_R, at: [0, -UARM, 0] },
  { parent: B.FARM_R, at: [0, -FARM, 0] },
  { parent: B.PELVIS, at: [HIP_X, 0, 0] }, // thigh L
  { parent: B.THIGH_L, at: [0, -THIGH, 0] },
  { parent: B.SHIN_L, at: [0, -SHIN + ANKLE_H, 0] },
  { parent: B.PELVIS, at: [-HIP_X, 0, 0] }, // thigh R
  { parent: B.THIGH_R, at: [0, -THIGH, 0] },
  { parent: B.SHIN_R, at: [0, -SHIN + ANKLE_H, 0] },
  { parent: B.HEAD, at: [0, EYE_OFF, 0.44] }, // eyes (blink pivot)
  // the knot at the back that tails swing off: on the head's own surface,
  // or the tails pivot about a point behind their root and come adrift
  { parent: B.HEAD, at: [0, KNOT_UP, KNOT_Z - HEAD_Z] },
  { parent: B.TORSO, at: [0, 0.02, 0.5] }, // belly
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

/** the bones the first-person lens must not see: the head and its children */
export const HEAD_BONES: ReadonlySet<number> = new Set([B.HEAD, B.EYES, B.POM])

/* ------------------------------------------------------------ colours --- */

/** what a vertex is painted with. SUIT, TRIM, ACCENT and GLOW are the look's
    four (`PlayerLook`'s jelly, headgear detail, headgear and pupils); GLINT
    is the whites of the eyes, and the rest are unused on this body but kept
    so the palette layout is stable */
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
/** added to a role code for anything the first-person lens must not draw */
export const HEAD_FLAG = 16

/* ------------------------------------------------------------ builder --- */

interface Soup {
  pos: number[]
  nrm: number[]
  si: number[]
  sw: number[]
  role: number[]
  idx: number[]
}

/** which bones pull a vertex and how hard: two blended by w0, and optionally
    a third (b2) taking a share w2 off the top of both */
type Weigh = (
  p: THREE.Vector3,
) => [number, number, number] | [number, number, number, number, number]
const rigid = (b: number): Weigh => () => [b, b, 1]
/** blend two bones across a band of `axis` (the value where the weight is
    half), soft over `half` either side of it: a smooth elbow, knee or waist */
const blend = (
  lo: number, hi: number, axisY: number, half: number,
): Weigh => (p) => {
  const t = THREE.MathUtils.clamp((p.y - (axisY - half)) / (2 * half), 0, 1)
  const k = t * t * (3 - 2 * t)
  // k is how far up the band: 1 belongs to the upper bone
  return [hi, lo, k]
}

const vA = new THREE.Vector3()
const vB = new THREE.Vector3()
const vC = new THREE.Vector3()
const vD = new THREE.Vector3()
const vN = new THREE.Vector3()

/**
 * A parametric patch: `f(u, v, out)` for u, v in [0, 1], sampled on a grid
 * and triangulated. Normals are the cross product of the two partial
 * derivatives, taken numerically, so every primitive below (ellipsoids,
 * lathes, tubes, rounded boxes) is just a function; at a pole, where one
 * derivative vanishes, the normal falls back to the direction away from
 * `centre`, which is right for every closed shape here.
 */
const patch = (
  s: Soup,
  f: (u: number, v: number, out: THREE.Vector3) => void,
  nu: number,
  nv: number,
  role: number,
  weigh: Weigh,
  centre: THREE.Vector3 | ((p: THREE.Vector3) => THREE.Vector3),
  flip = false,
) => {
  const base = s.pos.length / 3
  const e = 1e-3
  for (let j = 0; j <= nv; j++) {
    const v = j / nv
    for (let i = 0; i <= nu; i++) {
      const u = i / nu
      f(u, v, vA)
      f(Math.min(1, u + e), v, vB)
      f(Math.max(0, u - e), v, vC)
      vB.sub(vC)
      f(u, Math.min(1, v + e), vC)
      f(u, Math.max(0, v - e), vD)
      vC.sub(vD)
      vN.crossVectors(vC, vB)
      const ctr = typeof centre === 'function' ? centre(vA) : centre
      if (vN.lengthSq() < 1e-14) vN.subVectors(vA, ctr)
      vN.normalize()
      // point the normal away from the centre whatever the patch's winding
      vD.subVectors(vA, ctr)
      if (vN.dot(vD) < 0) vN.negate()
      if (flip) vN.negate()
      s.pos.push(vA.x, vA.y, vA.z)
      s.nrm.push(vN.x, vN.y, vN.z)
      const [b0, b1, w0, b2 = 0, w2 = 0] = weigh(vA)
      s.si.push(b0, b1, b2, 0)
      s.sw.push(w0 * (1 - w2), (1 - w0) * (1 - w2), w2, 0)
      s.role.push(role)
    }
  }
  const row = nu + 1
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = base + j * row + i
      const b = a + 1
      const c = a + row
      const d = c + 1
      // wound so the outward normal faces the viewer; fixed up per triangle
      // below rather than trusted, because the parametrisations disagree
      s.idx.push(a, c, b, b, c, d)
    }
  }
  // make every triangle's winding agree with its vertex normals
  for (let t = s.idx.length - nu * nv * 6; t < s.idx.length; t += 3) {
    const [i0, i1, i2] = [s.idx[t], s.idx[t + 1], s.idx[t + 2]]
    vA.fromArray(s.pos, i0 * 3)
    vB.fromArray(s.pos, i1 * 3).sub(vA)
    vC.fromArray(s.pos, i2 * 3).sub(vA)
    vD.crossVectors(vB, vC)
    vN.fromArray(s.nrm, i0 * 3)
      .add(vA.fromArray(s.nrm, i1 * 3))
      .add(vA.fromArray(s.nrm, i2 * 3))
    if (vD.dot(vN) < 0) {
      s.idx[t + 1] = i2
      s.idx[t + 2] = i1
    }
  }
}

/** an ellipsoid, optionally oriented by a basis and flattened below `floor` */
const ellipsoid = (
  s: Soup,
  c: THREE.Vector3,
  r: THREE.Vector3,
  role: number,
  weigh: Weigh,
  seg: [number, number] = [14, 10],
  basis?: THREE.Matrix4,
  floor = -Infinity,
  lump = 0,
) => {
  const m = basis ?? new THREE.Matrix4()
  const centre = c.clone()
  patch(
    s,
    (u, v, out) => {
      const th = u * Math.PI * 2
      const ph = v * Math.PI
      const bump = lump ? 1 + lump * Math.sin(th * 5) * Math.sin(ph * 4) : 1
      out.set(
        Math.sin(ph) * Math.cos(th) * r.x * bump,
        Math.cos(ph) * r.y * bump,
        Math.sin(ph) * Math.sin(th) * r.z * bump,
      )
      out.applyMatrix4(m).add(c)
      if (out.y < floor) out.y = floor
    },
    seg[0], seg[1], role, weigh, centre,
  )
}

/** a round tube along a polyline (parallel-transported rings), capped with
    hemispheres, radius interpolated along it */
const tube = (
  s: Soup,
  path: THREE.Vector3[],
  r0: number,
  r1: number,
  role: number,
  weigh: Weigh,
  seg = 10,
  flat = 1,
) => {
  // arc length, for the radius profile
  const L: number[] = [0]
  for (let i = 1; i < path.length; i++) L.push(L[i - 1] + path[i].distanceTo(path[i - 1]))
  const total = L[L.length - 1]
  const at = (d: number, out: THREE.Vector3, tan: THREE.Vector3) => {
    let i = 1
    while (i < path.length - 1 && L[i] < d) i++
    const k = THREE.MathUtils.clamp((d - L[i - 1]) / Math.max(1e-6, L[i] - L[i - 1]), 0, 1)
    out.lerpVectors(path[i - 1], path[i], k)
    tan.subVectors(path[i], path[i - 1]).normalize()
  }
  // frames: a reference normal carried along by projection (see props.ts's
  // sweep on why an up-vector frame twists a limb inside out)
  const steps = Math.max(2, Math.round(total / 0.05))
  const rings: Array<{ p: THREE.Vector3; n: THREE.Vector3; b: THREE.Vector3; r: number }> = []
  const tan = new THREE.Vector3()
  const ref = new THREE.Vector3(1, 0, 0)
  for (let k = 0; k <= steps; k++) {
    const d = (k / steps) * total
    const p = new THREE.Vector3()
    at(d, p, tan)
    ref.addScaledVector(tan, -ref.dot(tan))
    if (ref.lengthSq() < 1e-6) ref.set(0, 0, 1).addScaledVector(tan, -tan.z)
    ref.normalize()
    const n = ref.clone()
    const b = new THREE.Vector3().crossVectors(tan, n).normalize()
    rings.push({ p, n, b, r: THREE.MathUtils.lerp(r0, r1, k / steps) })
  }
  const first = rings[0]
  const last = rings[rings.length - 1]
  const t0 = vA.subVectors(rings[1].p, first.p).normalize().clone()
  const t1 = vA.subVectors(last.p, rings[rings.length - 2].p).normalize().clone()
  // cap rings: a hemisphere's worth of shrinking rings past either end
  const CAP = 4
  const all: typeof rings = []
  for (let k = CAP; k >= 1; k--) {
    const a = (k / CAP) * (Math.PI / 2)
    all.push({
      p: first.p.clone().addScaledVector(t0, -Math.sin(a) * first.r),
      n: first.n, b: first.b, r: first.r * Math.cos(a),
    })
  }
  all.push(...rings)
  for (let k = 1; k <= CAP; k++) {
    const a = (k / CAP) * (Math.PI / 2)
    all.push({
      p: last.p.clone().addScaledVector(t1, Math.sin(a) * last.r),
      n: last.n, b: last.b, r: last.r * Math.cos(a),
    })
  }
  const mid = rings[Math.floor(rings.length / 2)].p
  // the centre used for normal orientation must be local to each ring, or a
  // bent tube's inner wall points the wrong way: sample it per vertex
  const n = all.length - 1
  const base = s.pos.length / 3
  for (let j = 0; j <= n; j++) {
    const R = all[j]
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2
      const cx = Math.cos(th)
      const sy = Math.sin(th) * flat
      vA.copy(R.p).addScaledVector(R.n, cx * R.r).addScaledVector(R.b, sy * R.r)
      vN.copy(R.n).multiplyScalar(cx).addScaledVector(R.b, Math.sin(th) / flat)
      if (j === 0 || j === n) vN.subVectors(vA, R.p)
      // cap rings lean their normals along the axis
      if (j < CAP) vN.addScaledVector(t0, -(1 - R.r / first.r) * 1.4)
      if (j > n - CAP) vN.addScaledVector(t1, (1 - R.r / last.r) * 1.4)
      vN.normalize()
      s.pos.push(vA.x, vA.y, vA.z)
      s.nrm.push(vN.x, vN.y, vN.z)
      const [b0, b1, w0, b2 = 0, w2 = 0] = weigh(vA)
      s.si.push(b0, b1, b2, 0)
      s.sw.push(w0 * (1 - w2), (1 - w0) * (1 - w2), w2, 0)
      s.role.push(role)
    }
  }
  void mid
  const row = seg + 1
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < seg; i++) {
      const a = base + j * row + i
      const b = a + 1
      const c = a + row
      const d = c + 1
      s.idx.push(a, b, c, b, d, c)
    }
  }
  // agree the winding with the normals, as patch() does
  for (let t = s.idx.length - n * seg * 6; t < s.idx.length; t += 3) {
    const [i0, i1, i2] = [s.idx[t], s.idx[t + 1], s.idx[t + 2]]
    vA.fromArray(s.pos, i0 * 3)
    vB.fromArray(s.pos, i1 * 3).sub(vA)
    vC.fromArray(s.pos, i2 * 3).sub(vA)
    vD.crossVectors(vB, vC)
    vN.fromArray(s.nrm, i0 * 3)
    if (vD.dot(vN) < 0) {
      s.idx[t + 1] = i2
      s.idx[t + 2] = i1
    }
  }
}

/* ------------------------------------------------------------- the body -- */

/** the headgear, in `look.ts`'s HATS order */
export const HAT_COUNT = 8

/** one geometry per headgear, built on first use and shared by every body
    wearing it. A body changes hat by swapping `mesh.geometry` between these:
    the attributes are the same layout on the same material, so a swap is a
    buffer rebind and never a relink. Never dispose them: they are module
    state */
/** the outfits, in `look.ts`'s COSTUMES order: nothing, a cape, a hooped
    vest, and an animal onesie (ears and a tail). Each changes the trunk's
    outline or its colour blocking, not only the head */
export const COSTUME_COUNT = 4
const CAPE = 1
const STRIPES = 2
const ONESIE = 3
const SHARED: Array<THREE.BufferGeometry | null> =
  new Array(HAT_COUNT * BUILD_COUNT * COSTUME_COUNT * 5).fill(null)
/** the expressions: two dots, sleepy, angry, surprised, one-eyed */
export const FACE_COUNT = 5
const SLEEPY = 1
const ANGRY = 2
const SURPRISED = 3
const ONE_EYE = 4

export const bodyGeometry = (
  hat = 0, buildIndex = 0, costumeIndex = 0, faceIndex = 0,
): THREE.BufferGeometry => {
  const face = Math.max(0, Math.min(FACE_COUNT - 1, Math.floor(faceIndex)))
  const kind = Math.max(0, Math.min(HAT_COUNT - 1, Math.floor(hat)))
  const b = Math.max(0, Math.min(BUILD_COUNT - 1, Math.floor(buildIndex)))
  const costume = Math.max(0, Math.min(COSTUME_COUNT - 1, Math.floor(costumeIndex)))
  const key = ((kind * BUILD_COUNT + b) * COSTUME_COUNT + costume) * FACE_COUNT + face
  const cached = SHARED[key]
  if (cached) return cached
  build = BUILDS[b]
  const s: Soup = { pos: [], nrm: [], si: [], sw: [], role: [], idx: [] }
  const rest = (i: number) => boneRestWorld(i, new THREE.Vector3())
  const pelvisY = rest(B.PELVIS).y
  const torsoY = rest(B.TORSO).y
  const headY = rest(B.HEAD).y
  const shoulderY = rest(B.UARM_L).y
  const H = HEAD_FLAG
  const MASK = 1

  // --- the bean: pelvis into torso into head, with the belly's front on its
  // own jiggle bone. Weighted in bands so every bend is soft: that is the
  // difference between a jelly and a stack of parts
  const lowBand = blend(B.PELVIS, B.TORSO, (pelvisY + torsoY) / 2 + 0.08, 0.26)
  // a long soft band through the neck: a narrow neck weighted over a short
  // one folded its own back through the face when the head nodded
  const highBand = blend(B.TORSO, B.HEAD, headY - 0.02, 0.3)
  const bellyY = rest(B.PACK).y
  const bean: Weigh = (p) => {
    const [b0, b1, w0] = p.y < (torsoY + headY) / 2 ? lowBand(p) : highBand(p)
    const r = Math.max(0.01, beanR(THREE.MathUtils.clamp(tOf(p.y), 0, 1)))
    const front = THREE.MathUtils.smoothstep(p.z / (r * BODY_ZS), 0.1, 0.8)
    const band = Math.max(0, 1 - Math.abs(p.y - bellyY) / 0.45)
    return [b0, b1, w0, B.PACK, 0.65 * front * band * band]
  }
  const axisAt = new THREE.Vector3()
  const slice = (t0: number, t1: number, role: number, rings: number) =>
    patch(
      s,
      (u, v, out) => {
        const th = u * Math.PI * 2
        const t = t0 + (t1 - t0) * v
        const r = beanR(t)
        const y = stretch(BODY_Y0 + (BODY_Y1 - BODY_Y0) * t)
        out.set(Math.cos(th) * r, y, Math.sin(th) * r * BODY_ZS + hz(y))
      },
      // outward is judged from the axis at the vertex's own height: from one
      // centre for the whole bean, the back of a pinched, hunched neck points
      // more down than out, read as inward, and was wound inside out (a hole
      // at the back of the neck you could see the eyes through)
      24, rings, role, bean, (p) => axisAt.set(0, THREE.MathUtils.clamp(p.y, BODY_Y0 + 0.2, BODY_Y1 - 0.05), hz(p.y)),
    )
  // one gummy, one colour, bottom to crown. Everything from a little under
  // the shoulders up is head-flagged, and so are the arms: the lens rides
  // there, and looking down it saw the near plane cut the shoulders into a
  // rim across the bottom of the frame with faceted forearms in front of it
  const tNeck = tOf(shoulderY - 0.25)
  const tHead = tOf(headY + 0.02)
  if (costume === STRIPES) {
    // hooped like a strongman's vest: the trunk in bands of the two colours
    const tLo = tOf(pelvisY - 0.12)
    const bands = 7
    slice(0, tLo, ROLE.SUIT, 6)
    for (let k = 0; k < bands; k++) {
      const a = tLo + ((tNeck - tLo) * k) / bands
      const b = tLo + ((tNeck - tLo) * (k + 1)) / bands
      slice(a, b, k % 2 ? ROLE.SUIT : ROLE.TRIM, 3)
    }
  } else slice(0, tNeck, ROLE.SUIT, 22) // the body
  slice(tNeck, tHead, ROLE.SUIT + H, 4) // the neck, which the lens must not see
  // the head, which is the mask when the mask is worn
  slice(tHead, 1, (kind === MASK ? ROLE.ACCENT : ROLE.SUIT) + H, 16)

  // --- arms: long tube arms, shoulder to wrist, soft across the elbow, and a
  // round fist. Long enough that a hanging fist reaches past the hips: a
  // jelly brawler's arms are for grabbing, and a short arm cannot
  // The arm grows out of the body rather than being stuck on it: the tube
  // starts inside the shoulder, fat, and its root is weighted partly to the
  // torso, so a raised arm pulls the shoulder's dough up with it instead of
  // pivoting a cylinder against a capsule
  for (const [ua, fa, hb, side] of [
    [B.UARM_L, B.FARM_L, B.HAND_L, 1],
    [B.UARM_R, B.FARM_R, B.HAND_R, -1],
  ] as const) {
    const sh = rest(ua)
    const el = rest(fa)
    const wr = rest(hb)
    // a soft elbow: the bend is spread over a long band, so a bent arm curves
    const elbow = blend(fa, ua, el.y, 0.17)
    const root = sh.clone().add(new THREE.Vector3(-side * 0.1, 0.0, 0))
    const armW: Weigh = (p) => {
      const out = side * p.x
      const inner = side * sh.x
      // only the root, not the inner half of the whole hanging arm: that
      // pinned a strip of every upper arm to the torso and pulled it into a
      // web when the arm came up
      // the end of the sausage is the hand, and swings with the hand bone
      if (p.y < wr.y + 0.06) return [hb, fa, 0.8]
      if (out >= inner || p.y < sh.y - 0.1) return elbow(p)
      const k = THREE.MathUtils.smoothstep(out, inner - 0.14, inner)
      return [ua, B.TORSO, 0.55 + 0.45 * k]
    }
    tube(
      // not a ball on a stick: the hand is only the sausage's rounded end
      s, [root, sh, el, wr.clone().add(new THREE.Vector3(0, -0.06, 0))], 0.18, 0.14, ROLE.SUIT + H,
      armW, 10,
    )
  }

  // --- legs: stubby nubs of the same gummy, a round foot on each
  for (const [th, sn, ft] of [
    [B.THIGH_L, B.SHIN_L, B.FOOT_L],
    [B.THIGH_R, B.SHIN_R, B.FOOT_R],
  ] as const) {
    const hip = rest(th)
    const knee = rest(sn)
    const ank = rest(ft)
    // fat at the top and sunk into the body, the top weighted partly to the
    // pelvis: a leg that is a stub of the same dough, not a peg in a hole
    const knee2 = blend(sn, th, knee.y, 0.1)
    const legW: Weigh = (p) => {
      if (p.y <= hip.y) return knee2(p)
      const k = THREE.MathUtils.smoothstep(p.y, hip.y, hip.y + 0.22)
      return [B.PELVIS, th, 0.3 + 0.6 * k]
    }
    tube(
      s,
      [hip.clone().add(new THREE.Vector3(0, 0.24, 0)), hip, knee, ank.clone().add(new THREE.Vector3(0, 0.06, 0.03))],
      0.25 * build.leg, 0.21 * build.leg, ROLE.SUIT, legW, 10,
    )
    // the foot swallows the end of the leg: a tall soft lump the stump runs
    // down into, not a shoe with a padded collar round the ankle
    ellipsoid(
      // the stump runs straight into the ground and its own round end is the
      // foot; this only pushes a toe out in front, narrower than the stump so
      // there is no seam or cuff where the two meet
      s, new THREE.Vector3(ank.x, 0.065, 0.1),
      new THREE.Vector3(0.17 * build.leg, 0.1, 0.28),
      ROLE.SUIT, (p) => (p.y > 0.2 ? [ft, sn, 0.6] : [ft, ft, 1]), [14, 10], undefined, 0.0,
    )
  }

  /** a point on the head's surface at a height and a bearing (0 is +x, PI/2
      straight ahead), lifted off it along the normal; and that normal */
  const onHead = (y: number, th: number, lift: number, out: THREE.Vector3, nOut?: THREE.Vector3) => {
    const r = beanR(THREE.MathUtils.clamp(tOf(y), 0, 1))
    const rz = r * BODY_ZS
    const x = Math.cos(th) * r
    const z = Math.sin(th) * rz
    const n = (nOut ?? new THREE.Vector3()).set(x / Math.max(1e-4, r * r), 0, z / Math.max(1e-4, rz * rz))
    // a dome leans the normal up as the radius closes in toward the crown
    const dr = beanR(THREE.MathUtils.clamp(tOf(y + 0.02), 0, 1)) - r
    n.normalize()
    n.y = -dr / 0.02 * 0.9
    n.normalize()
    return out.set(x, y, z + hz(y)).addScaledVector(n, lift)
  }
  const head = rigid(B.HEAD)
  const tails = rigid(B.POM)

  // --- the face: small dark marks on their own blink bone, and one of five
  // expressions (dots, sleepy, angry, surprised, one-eyed). Big white googly
  // eyes were what made the earlier ones a mascot
  const eyeY = headY + EYE_OFF
  const eyes = rigid(B.EYES)
  const eyeFrames: Array<{ c: THREE.Vector3; m: THREE.Matrix4; side: THREE.Vector3; up: THREE.Vector3; n: THREE.Vector3 }> = []
  for (const sign of [1, -1]) {
    const n = new THREE.Vector3()
    const th = Math.PI / 2 - sign * 0.42
    const c = onHead(eyeY, th, -0.01, new THREE.Vector3(), n)
    const sideV = new THREE.Vector3(0, 1, 0).cross(n).normalize()
    const up = new THREE.Vector3().crossVectors(n, sideV).normalize()
    const m = new THREE.Matrix4().makeBasis(sideV, up, n)
    eyeFrames.push({ c, m, side: sideV, up, n })
    if (face === ONE_EYE) continue
    const r = face === SLEEPY
      ? new THREE.Vector3(0.06, 0.022, 0.026)
      : face === SURPRISED
        ? new THREE.Vector3(0.07, 0.085, 0.03)
        : new THREE.Vector3(0.048, 0.058, 0.028)
    ellipsoid(s, c, r, ROLE.GLOW + H, eyes, [10, 8], m)
    if (face === ANGRY) {
      // a brow slanting down to the middle
      tube(
        s,
        [
          c.clone().addScaledVector(up, 0.09).addScaledVector(sideV, -sign * 0.07).addScaledVector(n, 0.01),
          c.clone().addScaledVector(up, 0.13).addScaledVector(sideV, sign * 0.07).addScaledVector(n, 0.01),
        ],
        0.022, 0.022, ROLE.GLOW + H, head, 6,
      )
    }
    if (face === SLEEPY) {
      // a heavy lid over each eye
      ellipsoid(s, c.clone().addScaledVector(up, 0.035), new THREE.Vector3(0.075, 0.035, 0.03), ROLE.SUIT + H, eyes, [10, 6], m)
    }
  }
  if (face === ONE_EYE) {
    const n = new THREE.Vector3()
    const c = onHead(eyeY, Math.PI / 2, -0.01, new THREE.Vector3(), n)
    const sideV = new THREE.Vector3(0, 1, 0).cross(n).normalize()
    const up = new THREE.Vector3().crossVectors(n, sideV).normalize()
    ellipsoid(s, c, new THREE.Vector3(0.07, 0.08, 0.03), ROLE.GLOW + H, eyes, [10, 8], new THREE.Matrix4().makeBasis(sideV, up, n))
  }
  if (face === SURPRISED || face === ANGRY) {
    // a mouth: a little O, or a flat grim line
    const n = new THREE.Vector3()
    const c = onHead(eyeY - 0.17, Math.PI / 2, 0.0, new THREE.Vector3(), n)
    const sideV = new THREE.Vector3(0, 1, 0).cross(n).normalize()
    const up = new THREE.Vector3().crossVectors(n, sideV).normalize()
    const m = new THREE.Matrix4().makeBasis(sideV, up, n)
    ellipsoid(
      s, c, face === SURPRISED ? new THREE.Vector3(0.045, 0.055, 0.025) : new THREE.Vector3(0.08, 0.016, 0.025),
      ROLE.GLOW + H, head, [10, 6], m,
    )
  }

  /** a ring round the head at a height, standing `lift` off it */
  const ringAt = (y: number, lift: number, rad: number, role: number, flat = 2.2) => {
    const pts: THREE.Vector3[] = []
    for (let k = 0; k <= 28; k++) pts.push(onHead(y, (k / 28) * Math.PI * 2, lift, new THREE.Vector3()))
    tube(s, pts, rad, rad, role, head, 8, flat)
  }
  /** a knot at the back of the head and two tails off it on the springy bone */
  const knotAndTails = (role: number, long = 0.28) => {
    // always at the knot bone, whatever the headgear: see KNOT_Z
    const knot = rest(B.POM)
    ellipsoid(s, knot, new THREE.Vector3(0.1, 0.085, 0.08), role, head, [8, 6])
    for (const side of [1, -1]) {
      tube(
        s,
        [
          knot.clone(),
          knot.clone().add(new THREE.Vector3(side * 0.06, -0.1, -0.1)),
          knot.clone().add(new THREE.Vector3(side * 0.1, -long, -0.16)),
        ],
        0.055, 0.04, role, tails, 6, 0.45,
      )
    }
  }
  /** a cap over the head from a height to the crown, grown by `k` */
  const cap = (y0: number, k: number, role: number, rings = 8) => {
    const t0 = tOf(y0)
    patch(
      s,
      (u, v, out) => {
        const t = t0 + (1 - t0) * v
        const r = beanR(Math.min(1, t)) * k
        out.set(
          Math.cos(u * Math.PI * 2) * r,
          stretch(BODY_Y0 + (BODY_Y1 - BODY_Y0) * t) + (k - 1) * 0.3 * v,
          Math.sin(u * Math.PI * 2) * r * BODY_ZS + hz(BODY_Y0 + (BODY_Y1 - BODY_Y0) * t),
        )
      },
      22, rings, role, head, new THREE.Vector3(0, headY + 0.3, hz(headY)),
    )
  }
  /** a surface of revolution about the head's axis: radius and height at t */
  const rev = (prof: (t: number) => [number, number], role: number, seg: [number, number], tilt?: THREE.Matrix4) =>
    patch(
      s,
      (u, v, out) => {
        const [r, y] = prof(v)
        out.set(Math.cos(u * Math.PI * 2) * r, y, Math.sin(u * Math.PI * 2) * r)
        if (tilt) out.applyMatrix4(tilt)
        out.z += hz(headY + 0.3)
      },
      seg[0], seg[1], role, head, new THREE.Vector3(0, prof(0.5)[1], 0),
    )
  const crownY = stretch(BODY_Y1)
  const A = ROLE.ACCENT + H
  const T = ROLE.TRIM + H

  switch (kind) {
    case 0: {
      // the sweatband: low on the brow, right over the eyes, tails at the
      // back, with a proper dome of head showing above it (set higher, it
      // read from above as the lip of an open tin)
      // cloth, not a halo: a thick knotted band, tied off-centre at the back
      // with the tails hanging long, worn tipped low over one brow
      const y = rest(B.POM).y + 0.04
      const pts: THREE.Vector3[] = []
      for (let k = 0; k <= 32; k++) {
        const th = (k / 32) * Math.PI * 2
        const yy = y + 0.05 * Math.sin(th) * 0.8 + 0.035 * Math.cos(th)
        pts.push(onHead(yy, th, 0.03 + 0.008 * Math.sin(th * 7), new THREE.Vector3()))
      }
      tube(s, pts, 0.068, 0.068, A, head, 8, 1.1)
      knotAndTails(A, 0.42)
      break
    }
    case 1: {
      // the wrestler's mask: the head itself is painted in the headgear colour
      // (above), with a stripe over the crown, a rim round each eye and laces
      // hanging at the back
      const stripe: THREE.Vector3[] = []
      for (let k = 0; k <= 16; k++) {
        const a = (k / 16) * Math.PI // front to back over the top
        const y = headY + 0.2 + (crownY - headY - 0.2) * Math.sin(a)
        // straight up the middle of the face, over the crown and down the back
        const r = beanR(THREE.MathUtils.clamp(tOf(y), 0, 1)) * BODY_ZS + 0.02
        const p = new THREE.Vector3(0, y + (y > crownY - 0.05 ? 0.02 : 0), (a > Math.PI / 2 ? -r : r) + hz(y))
        stripe.push(p)
      }
      tube(s, stripe, 0.05, 0.05, T, head, 8, 1)
      for (const f of eyeFrames) {
        const rim: THREE.Vector3[] = []
        for (let k = 0; k <= 16; k++) {
          const a = (k / 16) * Math.PI * 2
          rim.push(
            f.c.clone()
              .addScaledVector(f.side, Math.cos(a) * 0.1)
              .addScaledVector(f.up, Math.sin(a) * 0.11)
              .addScaledVector(f.n, 0.004),
          )
        }
        tube(s, rim, 0.026, 0.026, T, head, 6, 1)
      }
      knotAndTails(T, 0.34)
      break
    }
    case 2: {
      // the bucket hat: a soft crown and a floppy brim tipped down all round
      const y0 = eyeY + 0.2
      const r0 = beanR(tOf(y0)) + 0.05
      rev((t) => [r0 * (1 - 0.12 * t) * (t > 0.85 ? Math.sqrt(Math.max(0, 1 - ((t - 0.85) / 0.15) ** 2)) : 1), y0 + (crownY + 0.12 - y0) * t], A, [22, 8])
      rev((t) => [r0 + 0.24 * t, y0 - 0.09 * t * t], A, [24, 3])
      ringAt(y0 + 0.07, 0.07, 0.04, T)
      break
    }
    case 3: {
      // the party hat: a striped cone perched off-true on the crown, a pom on top
      const tilt = new THREE.Matrix4()
        .makeTranslation(0.06, crownY - 0.1, 0)
        .multiply(new THREE.Matrix4().makeRotationZ(-0.28))
      const h = 0.62
      rev((t) => [0.24 * (1 - t) + 0.005, h * t], A, [16, 6], tilt)
      for (const at of [0.2, 0.5]) {
        rev((t) => [(0.24 * (1 - at) + 0.012) + 0.02 * Math.sin(t * Math.PI), h * at + 0.05 * (t - 0.5)], T, [16, 3], tilt)
      }
      const tip = new THREE.Vector3(0, h + 0.03, 0).applyMatrix4(tilt)
      ellipsoid(s, tip, new THREE.Vector3(0.085, 0.085, 0.085), T, head, [8, 6], undefined, -Infinity, 0.12)
      break
    }
    case 4: {
      // the hard hat: a stiff shell a size too big, a peak out front and a
      // ridge over the top
      const y0 = eyeY + 0.2
      cap(y0, 1.12, A, 8)
      rev((t) => [beanR(tOf(y0)) * 1.12 + 0.06 * t, y0 - 0.01 * t], A, [24, 2])
      const peak: THREE.Vector3[] = []
      for (let k = 0; k <= 10; k++) {
        const th = Math.PI / 2 + (k / 10 - 0.5) * 1.6
        peak.push(onHead(y0, th, 0.16, new THREE.Vector3()).setY(y0 - 0.02))
      }
      tube(s, peak, 0.1, 0.06, A, head, 6, 3.5)
      const ridge: THREE.Vector3[] = []
      for (let k = 0; k <= 12; k++) {
        const a = (k / 12) * Math.PI
        const y = y0 + 0.05 + (crownY + 0.1 - y0) * Math.sin(a)
        ridge.push(new THREE.Vector3(0, y, Math.cos(a) * (beanR(tOf(Math.min(y, crownY))) * 1.12 * BODY_ZS) + hz(y)))
      }
      tube(s, ridge, 0.05, 0.05, T, head, 6, 1.4)
      break
    }
    case 5: {
      // the bandana: cloth tied tight over the top, knotted at the back with
      // two long tails, and a few dots
      const y0 = eyeY + 0.2
      cap(y0, 1.035, A, 8)
      knotAndTails(A, 0.34)
      for (const [th, dy] of [[1.2, 0.12], [1.95, 0.1], [0.4, 0.18], [2.7, 0.2], [1.55, 0.3], [-0.5, 0.15], [3.6, 0.14]] as const) {
        const n = new THREE.Vector3()
        const p = onHead(y0 + dy, th, 0.05, new THREE.Vector3(), n)
        const sideV = new THREE.Vector3(0, 1, 0).cross(n).normalize()
        const up = new THREE.Vector3().crossVectors(n, sideV).normalize()
        ellipsoid(s, p, new THREE.Vector3(0.04, 0.04, 0.012), T, head, [6, 4], new THREE.Matrix4().makeBasis(sideV, up, n))
      }
      break
    }
    case 7: {
      // the hood: up over the head and draped down the back onto the
      // shoulders, a rolled rim round the face. It changes the outline, which
      // a hat on top of the same bean cannot
      const y0 = eyeY + 0.13
      cap(y0, 1.1, A, 8)
      const yBot = shoulderY - 0.02
      const drape = blend(B.TORSO, B.HEAD, headY + 0.02, 0.2)
      patch(
        s,
        (u, v, out) => {
          const th = Math.PI - 0.35 + u * (Math.PI + 0.7) // round the back, ear to ear
          const y = y0 + (yBot - y0) * v
          const r = beanR(THREE.MathUtils.clamp(tOf(y), 0, 1)) * 1.06 + 0.04 + 0.02 * v
          out.set(Math.cos(th) * r, y, Math.sin(th) * r * BODY_ZS + hz(y))
        },
        16, 6, A, drape, new THREE.Vector3(0, (y0 + yBot) / 2, 0),
      )
      const rim: THREE.Vector3[] = []
      for (let k = 0; k <= 16; k++) {
        const th = Math.PI / 2 + (k / 16 - 0.5) * 2.9
        const lift = Math.abs(k / 16 - 0.5) * 0.3
        rim.push(onHead(y0 + lift, th, 0.07, new THREE.Vector3()))
      }
      tube(s, rim, 0.07, 0.07, T, head, 8, 1)
      break
    }
    default:
      break // bare-headed
  }

  // --- the outfit ---------------------------------------------------------
  if (costume === CAPE) {
    // a cape: tied at the throat, hanging off the shoulders down the back to
    // the knees and flaring as it goes, which turns the bean into a triangle
    // from behind and from the side
    const yTop = shoulderY + 0.06
    const yBot = HIP_Y * 0.75
    const capeW = blend(B.PELVIS, B.TORSO, (pelvisY + torsoY) / 2, 0.3)
    patch(
      s,
      (u, v, out) => {
        const th = Math.PI + 0.25 + u * (Math.PI - 0.5) // across the back
        const y = yTop + (yBot - yTop) * v
        const r = beanR(THREE.MathUtils.clamp(tOf(Math.max(y, BODY_Y0 + 0.2)), 0, 1)) + 0.05 + 0.32 * v
        out.set(Math.cos(th) * r, y, Math.sin(th) * r * BODY_ZS + hz(y) - 0.04 * v)
      },
      16, 8, ROLE.TRIM, capeW, new THREE.Vector3(0, (yTop + yBot) / 2, 0.2),
    )
    const tie: THREE.Vector3[] = []
    for (let k = 0; k <= 16; k++) {
      const th = Math.PI * 0.15 + (k / 16) * Math.PI * 0.7 // round the front of the neck
      tie.push(onHead(yTop, th, 0.04, new THREE.Vector3()))
    }
    tube(s, tie, 0.055, 0.055, ROLE.TRIM, rigid(B.TORSO), 6)
  } else if (costume === ONESIE) {
    // an animal onesie: two round ears up top and a fat tail out the back,
    // in the outfit colour
    for (const side of [1, -1]) {
      const n = new THREE.Vector3()
      const p = onHead(crownY - 0.12, Math.PI / 2 + side * 1.2, 0.0, new THREE.Vector3(), n)
      const up = new THREE.Vector3(side * 0.35, 1, 0.1).normalize()
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 0, 1)).normalize(),
        up,
        new THREE.Vector3(0, 0, 1),
      )
      ellipsoid(s, p.addScaledVector(up, 0.1), new THREE.Vector3(0.13, 0.17, 0.06), ROLE.TRIM + H, head, [10, 8], m)
    }
    const tailRoot = new THREE.Vector3(0, pelvisY + 0.1, -beanR(tOf(pelvisY + 0.1)) * BODY_ZS + hz(pelvisY + 0.1) + 0.06)
    tube(
      s,
      [
        tailRoot,
        tailRoot.clone().add(new THREE.Vector3(0, 0.02, -0.16)),
        tailRoot.clone().add(new THREE.Vector3(0.02, 0.12, -0.26)),
      ],
      0.15, 0.12, ROLE.TRIM, rigid(B.PELVIS), 8,
    )
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(s.nrm, 3))
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(s.si, 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(s.sw, 4))
  g.setAttribute('aRole', new THREE.Float32BufferAttribute(s.role, 1))
  g.setIndex(s.idx)
  g.computeBoundingBox()
  g.computeBoundingSphere()
  g.userData.shared = true
  SHARED[key] = g
  build = BUILDS[0]
  return g
}
