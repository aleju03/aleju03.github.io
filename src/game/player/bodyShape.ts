import * as THREE from 'three'

/*
  The drawing of the player character: one skinned soup, built once per
  session and shared by every body in the world.

  The character is a jelly brawler in the Gang Beasts mould: one continuous
  piece of gummy shaped like a pear, a narrow round-domed head flowing into a
  wide soft belly (the head is only the top of it), two stubby nubs of the
  same gummy for legs, two tube arms ending in round fists, a face that is two
  big goofy eyes and nothing else, and one accessory, a brawler's headband
  tied at the back with two tails that swing. No costume: the colours are the
  character. A paler belly patch, the band and the pupils are the other three
  colours, so two players in the same gummy are still told apart. An earlier
  version had a straight-sided body on dark shorts and shoes, and from any
  distance it read as three things stacked, a tin can on trousers.

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
export const SHOULDER_X = 0.54
export const SHOULDER_OFF = 0.6
/** torso bone up to the head bone: where the bean stops being body and
    starts being head, which is only ever a matter of weights */
export const NECK_OFF = 0.8
// tube arms long enough to swing well clear of the bean and to flop out of
// its outline in a fall
export const UARM = 0.38
export const FARM = 0.36
/** head bone up to the eyes: a face set into the upper bean, below the
    band, not jammed up under it */
export const EYE_OFF = 0.42
/** head bone up to the top of the bean and its headband */
export const CROWN_OFF = 1.1

/* ------------------------------------------------------------ bones ----- */

/** bone slots, in skeleton order. `playerBody.ts` builds a THREE.Bone for
    each at these rest offsets; the geometry below is weighted by index.
    POM is the headband's knot (its tails swing off it) and PACK is the
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
/** the bean's radius at t in [0, 1] bottom to top: a pear. Widest low in the
    belly, narrowing steadily into a head that ends in a round dome. The
    control points are joined by a Catmull-Rom spline, which keeps the slope
    running through each of them: a cosine blend between them came to a
    standstill at every point, and the flat band it left at each one read as
    a quilted jacket, rings stacked up the body */
const PROF: Array<[number, number]> = [
  [0, 0.64], [0.15, 0.74], [0.33, 0.7], [0.52, 0.58], [0.68, 0.5], [0.8, 0.47], [1, 0.45],
]
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
  const bot = t < 0.18 ? Math.sqrt(Math.max(0, 1 - ((0.18 - t) / 0.18) ** 2)) : 1
  const top = t > 0.8 ? Math.sqrt(Math.max(0, 1 - ((t - 0.8) / 0.2) ** 2)) : 1
  return r * bot * top
}
const tOf = (y: number) => (y - BODY_Y0) / (BODY_Y1 - BODY_Y0)
/** the bean's surface in front, at a height and a sideways x */
const beanZ = (y: number, x: number) => {
  const r = beanR(THREE.MathUtils.clamp(tOf(y), 0, 1))
  return Math.sqrt(Math.max(0, r * r - x * x)) * BODY_ZS
}

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
  { parent: B.HEAD, at: [0, EYE_OFF, 0.44] }, // eyes (blink pivot)
  { parent: B.HEAD, at: [0, 0.66, -0.44] }, // headband knot, tails swing off it
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
    four (`PlayerLook`'s body, shorts, headband and eyes); the rest are fixed
    and, on this body, unused but kept so the palette layout is stable */
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
  centre: THREE.Vector3,
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
      if (vN.lengthSq() < 1e-14) vN.subVectors(vA, centre)
      vN.normalize()
      // point the normal away from the centre whatever the patch's winding
      vD.subVectors(vA, centre)
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

let SHARED: THREE.BufferGeometry | null = null

/** the one geometry every body in the session shares. Never dispose it:
    it is module state */
export const bodyGeometry = (): THREE.BufferGeometry => {
  if (SHARED) return SHARED
  const s: Soup = { pos: [], nrm: [], si: [], sw: [], role: [], idx: [] }
  const rest = (i: number) => boneRestWorld(i, new THREE.Vector3())
  const pelvisY = rest(B.PELVIS).y
  const torsoY = rest(B.TORSO).y
  const headY = rest(B.HEAD).y
  const H = HEAD_FLAG

  // --- the bean: pelvis into torso into head, with the belly's front on its
  // own jiggle bone. Weighted in bands so every bend is soft: that is the
  // difference between a jelly and a stack of parts
  const lowBand = blend(B.PELVIS, B.TORSO, (pelvisY + torsoY) / 2 + 0.08, 0.26)
  const highBand = blend(B.TORSO, B.HEAD, headY + 0.05, 0.22)
  const bellyY = rest(B.PACK).y
  const bean: Weigh = (p) => {
    const [b0, b1, w0] = p.y < (torsoY + headY) / 2 ? lowBand(p) : highBand(p)
    const r = Math.max(0.01, beanR(THREE.MathUtils.clamp(tOf(p.y), 0, 1)))
    const front = THREE.MathUtils.smoothstep(p.z / (r * BODY_ZS), 0.1, 0.8)
    const band = Math.max(0, 1 - Math.abs(p.y - bellyY) / 0.45)
    return [b0, b1, w0, B.PACK, 0.65 * front * band * band]
  }
  const slice = (t0: number, t1: number, role: number, rings: number) =>
    patch(
      s,
      (u, v, out) => {
        const th = u * Math.PI * 2
        const t = t0 + (t1 - t0) * v
        const r = beanR(t)
        out.set(Math.cos(th) * r, BODY_Y0 + (BODY_Y1 - BODY_Y0) * t, Math.sin(th) * r * BODY_ZS)
      },
      24, rings, role, bean, new THREE.Vector3(0, (BODY_Y0 + BODY_Y1) / 2, 0),
    )
  // one gummy, one colour, bottom to crown: no waistline, no trousers
  const tHead = tOf(headY + 0.06)
  slice(0, tHead, ROLE.SUIT, 26) // the body
  slice(tHead, 1, ROLE.SUIT + H, 18) // the head, which the lens must not see

  // the belly patch: a second, paler gummy tone on the front of the pear. It
  // is the pear's own surface a hair proud of itself over an oval, so it
  // follows every curve and rides the belly's jiggle with it (a flat disc
  // stood off the side of the body like a lid)
  {
    const t0 = tOf(bellyY - 0.52)
    const t1 = tOf(bellyY + 0.34)
    patch(
      s,
      (u, v, out) => {
        const t = t0 + (t1 - t0) * v
        const half = 0.72 * Math.sqrt(Math.max(0, 1 - (2 * v - 1) ** 2))
        const th = Math.PI / 2 + (u * 2 - 1) * half
        const r = beanR(t) + 0.012
        out.set(Math.cos(th) * r, BODY_Y0 + (BODY_Y1 - BODY_Y0) * t, Math.sin(th) * r * BODY_ZS)
      },
      14, 12, ROLE.TRIM, bean, new THREE.Vector3(0, bellyY, 0),
    )
  }

  // --- arms: one tube each, shoulder to wrist, soft across the elbow, and a
  // round fist
  for (const [ua, fa, hb] of [
    [B.UARM_L, B.FARM_L, B.HAND_L],
    [B.UARM_R, B.FARM_R, B.HAND_R],
  ] as const) {
    const sh = rest(ua)
    const el = rest(fa)
    const wr = rest(hb)
    tube(
      s, [sh, el, wr.clone().add(new THREE.Vector3(0, 0.02, 0))], 0.18, 0.155, ROLE.SUIT,
      blend(fa, ua, el.y, 0.09), 10,
    )
    ellipsoid(
      s, wr.clone().add(new THREE.Vector3(0, -0.1, 0.01)), new THREE.Vector3(0.22, 0.21, 0.22),
      ROLE.SUIT, rigid(hb), [12, 9],
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
    tube(
      s,
      [hip.clone().add(new THREE.Vector3(0, 0.12, 0)), knee, ank.clone().add(new THREE.Vector3(0, 0.1, 0))],
      0.23, 0.2, ROLE.SUIT, blend(sn, th, knee.y, 0.1), 10,
    )
    ellipsoid(
      s, new THREE.Vector3(ank.x, 0.12, 0.07), new THREE.Vector3(0.22, 0.16, 0.27),
      ROLE.SUIT, rigid(ft), [14, 10], undefined, 0.0,
    )
  }

  // --- the face: two big goofy eyes, white with a pupil each, set a little
  // apart and a little off true (the pupils look slightly down and away from
  // each other), on their own blink bone. No mouth: a jelly brawler's face is
  // its eyes, and a smile is what made the last one cute
  const head = rigid(B.HEAD)
  const eyeY = headY + EYE_OFF
  const eyes = rigid(B.EYES)
  for (const side of [1, -1]) {
    const x = side * 0.19
    const z = beanZ(eyeY, x)
    // oriented to the bean's surface there
    const r = beanR(tOf(eyeY))
    const rz = r * BODY_ZS
    const n = new THREE.Vector3(x / (r * r), 0, z / (rz * rz)).normalize()
    const sideV = new THREE.Vector3(0, 1, 0).cross(n).normalize()
    const up = new THREE.Vector3().crossVectors(n, sideV).normalize()
    const m = new THREE.Matrix4().makeBasis(sideV, up, n)
    const c = new THREE.Vector3(x, eyeY, z - 0.012)
    ellipsoid(s, c, new THREE.Vector3(0.105, 0.125, 0.04), ROLE.GLINT + H, eyes, [12, 10], m)
    const pupil = c.clone()
      .addScaledVector(sideV, side * 0.025)
      .addScaledVector(up, -0.03)
      .addScaledVector(n, 0.03)
    ellipsoid(s, pupil, new THREE.Vector3(0.055, 0.068, 0.025), ROLE.GLOW + H, eyes, [10, 8], m)
  }

  // --- the headband: a ring round the head a little above the eyes, a knot
  // at the back, and two tails hanging off the knot on their own springy bone
  const bandY = headY + 0.66
  const ring: THREE.Vector3[] = []
  const bandR = beanR(tOf(bandY)) + 0.012
  for (let k = 0; k <= 28; k++) {
    const th = (k / 28) * Math.PI * 2
    ring.push(new THREE.Vector3(Math.cos(th) * bandR, bandY, Math.sin(th) * bandR * BODY_ZS))
  }
  tube(s, ring, 0.05, 0.05, ROLE.ACCENT + H, head, 8, 2.2)
  const knot = rest(B.POM)
  knot.z = -beanZ(bandY, 0) - 0.03
  ellipsoid(s, knot, new THREE.Vector3(0.09, 0.08, 0.07), ROLE.ACCENT + H, head, [8, 6])
  for (const side of [1, -1]) {
    tube(
      s,
      [
        knot.clone(),
        knot.clone().add(new THREE.Vector3(side * 0.06, -0.1, -0.12)),
        knot.clone().add(new THREE.Vector3(side * 0.1, -0.26, -0.18)),
      ],
      0.045, 0.035, ROLE.ACCENT + H, rigid(B.POM), 6, 0.45,
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
  SHARED = g
  return g
}
