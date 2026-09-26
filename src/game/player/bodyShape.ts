import * as THREE from 'three'

/*
  The drawing of the player character: one skinned soup, built once per
  session and shared by every body in the world.

  The character is a soft little person in a work suit: a pear-shaped body
  that is mostly belly, a rolled collar, a big round head with two ink-drop
  eyes, a smile, blush and ears, a knitted beanie standing up in a soft dome
  with a pom-pom and a headlamp and a fringe of hair escaping it at the back
  (so the back of the head is somebody, not an egg), stubby rubber-hose arms
  ending in mittens, short legs in chunky boots, and a backpack on straps.
  Where a limb meets its glove or boot, the cuff rides the limb and not the
  hand or foot, so the only surfaces that ever cross are the same colour.
  It is drawn for the look the whole game is moving to (a low internal
  resolution, posterized, outlined), so everything that carries identity is a
  big flat block of one colour: the suit, the beanie, the dark gloves and
  boots, the skin of the face. The details that make it a *someone* are sized
  to survive being a few pixels: the eyes are tall ovals rather than dots, the
  lamp is a lit spot rather than a lens, and the pom-pom exists mostly to
  wobble.

  Why one skinned mesh rather than a mesh per part, which is what the robot
  before it was (thirty-one meshes, fourteen materials, 29.7k vertices):

  - **Cost.** A town wears several of these. One draw call per body, two with
    a shadow, against thirty-one and sixty-two, and about a tenth of the
    vertices. `npm run measure -- body` prints the numbers.
  - **Softness.** Real skin weights bend. The body is one lathe weighted from
    the pelvis to the chest, so a lean folds the belly instead of cracking a
    seam between two boxes, and each limb is one tube blended across its
    elbow or knee, so an arm is a noodle rather than two sticks and a ball.
  - **Colour stays a uniform.** Every vertex carries a small `aRole` code
    (skin, suit, trim, accent, glow, ink, cheek, glint, hair), and `bodyMaterial.ts`
    looks the colour up in a per-body palette uniform. Four `Color.set()`
    calls repaint a body and nothing can relink a shader. The same code
    carries a head flag, which is how the first-person lens stops seeing the
    inside of its own skull without taking the head out of the shadow map.

  Everything here is authored in *design units* in the rest pose (feet at
  y = 0, facing +Z, arms hanging straight down), which is also the bind pose,
  so a bone's inverse bind matrix is nothing but its rest position negated.
  `playerBody.ts` owns the bones; this module only says where they are at
  rest and which vertices follow which.

  Headless-safe: plain BufferGeometry and arithmetic, nothing that needs a
  document or a GL context, so `npm run measure -- body` can build it in Node.
*/

/* ---------------------------------------------------------- dimensions -- */

export const THIGH = 0.52
export const SHIN = 0.5
/** the hip joints' height over the soles */
export const HIP_Y = THIGH + SHIN // 1.02
export const HIP_X = 0.2
/** the foot bone's height over its sole: the ankle the boot pivots on */
export const ANKLE_H = 0.12
/** pelvis bone up to the torso bone. The body's lathe is weighted across it */
export const WAIST_OFF = 0.2
export const SHOULDER_X = 0.42
export const SHOULDER_OFF = 0.5
/** torso bone up to the head bone, which is the chin pivot, not the middle */
export const NECK_OFF = 0.74
export const UARM = 0.32
export const FARM = 0.3
/** the head bone up to the middle of the skull, and the skull's radii */
const HEAD_CY = 0.44
const HEAD_CZ = 0.02
const HEAD_R = new THREE.Vector3(0.54, 0.49, 0.5)
/** how much taller than the skull the beanie's dome stands: a knitted hat
    rises in a soft point, and a flat one reads as a beret or a bowl */
const CAP_TALL = 1.3
/** head bone up to the eyes. Just above the middle of the skull, which is
    where a round cartoon face keeps them, and where the crown stays low
    enough over the eye line to fit under a car's roof (see DESIGN_CROWN) */
export const EYE_OFF = 0.52
/** head bone up to the top of the pom-pom: the highest thing on the body */
export const CROWN_OFF = 1.28

/* ------------------------------------------------------------ bones ----- */

/** bone slots, in skeleton order. `playerBody.ts` builds a THREE.Bone for
    each at these rest offsets; the geometry below is weighted by index */
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
  { parent: B.HEAD, at: [0, EYE_OFF, 0.42] }, // eyes (blink pivot)
  { parent: B.HEAD, at: [0, HEAD_CY + HEAD_R.y * CAP_TALL - 0.05, -0.04] }, // pom-pom root
  { parent: B.TORSO, at: [0, 0.42, -0.5] }, // backpack
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

/** what a vertex is painted with. The first five are the look's business
    (skin is fixed; suit, trim, accent and glow are `PlayerLook`'s four); the
    last three are the face, and fixed */
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

/** which bones pull a vertex, and how hard: up to two, weights summing to 1 */
type Weigh = (p: THREE.Vector3) => [number, number, number]
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
      const [b0, b1, w0] = weigh(vA)
      s.si.push(b0, b1, 0, 0)
      s.sw.push(w0, 1 - w0, 0, 0)
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

/** a surface of revolution about a vertical axis: `prof(t)` returns the
    radius and height at t in [0, 1], bottom to top. `zs` squashes the
    cross-section front to back */
const lathe = (
  s: Soup,
  prof: (t: number) => [number, number],
  role: number,
  weigh: Weigh,
  seg: [number, number],
  zs = 1,
  scale = 1,
) => {
  const centre = new THREE.Vector3(0, (prof(0)[1] + prof(1)[1]) / 2, 0)
  patch(
    s,
    (u, v, out) => {
      const th = u * Math.PI * 2
      const [r, y] = prof(v)
      out.set(Math.cos(th) * r * scale, y, Math.sin(th) * r * zs * scale)
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
      const [b0, b1, w0] = weigh(vA)
      s.si.push(b0, b1, 0, 0)
      s.sw.push(w0, 1 - w0, 0, 0)
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

/** a rounded box (superellipsoid): `e` near 0 is a box, 1 an ellipsoid */
const roundBox = (
  s: Soup, c: THREE.Vector3, h: THREE.Vector3, e: number, role: number, weigh: Weigh,
  seg: [number, number] = [16, 12],
) => {
  const sp = (x: number, p: number) => Math.sign(x) * Math.pow(Math.abs(x), p)
  patch(
    s,
    (u, v, out) => {
      const th = u * Math.PI * 2 - Math.PI
      const ph = v * Math.PI - Math.PI / 2
      const cp = sp(Math.cos(ph), e)
      out.set(
        h.x * cp * sp(Math.cos(th), e),
        -h.y * sp(Math.sin(ph), e),
        h.z * cp * sp(Math.sin(th), e),
      ).add(c)
    },
    seg[0], seg[1], role, weigh, c.clone(),
  )
}

/* ------------------------------------------------------------- the body -- */

/** the body's lathe profile: a pear that is mostly belly, round at the seat
    and narrowing into the shoulders, so the arms hang off a slope rather than
    a ledge. Radius and height at t in [0, 1] */
/** the bottom of the body (the seat of the suit) and its top, at rest */
export const BODY_Y0 = 0.84
const BODY_Y1 = 2.06
const BODY_ZS = 0.8
const bodyR = (t: number) => {
  const round = Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.58)
  return round * (0.6 - 0.2 * t)
}
const bodyProf = (t: number): [number, number] => [bodyR(t), BODY_Y0 + (BODY_Y1 - BODY_Y0) * t]
/** the body's surface in front and behind, at a height and a sideways x */
const bodyZ = (y: number, x: number) => {
  const t = THREE.MathUtils.clamp((y - BODY_Y0) / (BODY_Y1 - BODY_Y0), 0, 1)
  const r = bodyR(t)
  return Math.sqrt(Math.max(0, r * r - x * x)) * BODY_ZS
}

let SHARED: THREE.BufferGeometry | null = null

/** the one geometry every body in the session shares. Never dispose it:
    it is module state, like the robot's part set was */
export const bodyGeometry = (): THREE.BufferGeometry => {
  if (SHARED) return SHARED
  const s: Soup = { pos: [], nrm: [], si: [], sw: [], role: [], idx: [] }
  const rest = (i: number) => boneRestWorld(i, new THREE.Vector3())
  const pelvisY = rest(B.PELVIS).y
  const torsoY = rest(B.TORSO).y
  const headY = rest(B.HEAD).y
  const H = HEAD_FLAG

  // --- trunk: one lathe, pelvis to chest, soft across the waist
  const trunk = blend(B.PELVIS, B.TORSO, (pelvisY + torsoY) / 2 + 0.12, 0.22)
  lathe(s, bodyProf, ROLE.SUIT, trunk, [22, 16], BODY_ZS)
  // the belt: the same profile a hair proud of it, over a short band
  const beltLo = (pelvisY + 0.06 - BODY_Y0) / (BODY_Y1 - BODY_Y0)
  const beltHi = beltLo + 0.075
  lathe(
    s,
    (t) => {
      const tt = beltLo + (beltHi - beltLo) * t
      return [bodyR(tt), BODY_Y0 + (BODY_Y1 - BODY_Y0) * tt]
    },
    ROLE.TRIM, trunk, [22, 2], BODY_ZS, 1.035,
  )

  // --- backpack and its straps
  const packC = rest(B.PACK)
  roundBox(s, packC, new THREE.Vector3(0.33, 0.37, 0.17), 0.32, ROLE.ACCENT, rigid(B.PACK))
  // the flap: a darker lid over the top third
  roundBox(
    s, packC.clone().add(new THREE.Vector3(0, 0.2, -0.015)),
    new THREE.Vector3(0.345, 0.16, 0.18), 0.3, ROLE.TRIM, rigid(B.PACK), [14, 8],
  )
  for (const side of [1, -1]) {
    const x = side * 0.22
    const path: THREE.Vector3[] = []
    // up the back, over the shoulder and down the front, hugging the body
    const yTop = BODY_Y1 - 0.14
    for (let k = 0; k <= 8; k++) {
      const y = THREE.MathUtils.lerp(packC.y, yTop, k / 8)
      path.push(new THREE.Vector3(x, y, -bodyZ(y, x) - 0.02))
    }
    path.push(new THREE.Vector3(x, yTop + 0.06, 0))
    for (let k = 0; k <= 10; k++) {
      const y = THREE.MathUtils.lerp(yTop, torsoY + 0.08, k / 10)
      path.push(new THREE.Vector3(x, y, bodyZ(y, x) + 0.02))
    }
    tube(s, path, 0.04, 0.04, ROLE.TRIM, rigid(B.TORSO), 6, 0.45)
  }

  // --- arms: one tube each, shoulder to wrist, soft across the elbow; a
  // mitten with a thumb on the hand bone
  for (const [ua, fa, hb, side] of [
    [B.UARM_L, B.FARM_L, B.HAND_L, 1],
    [B.UARM_R, B.FARM_R, B.HAND_R, -1],
  ] as const) {
    const sh = rest(ua)
    const el = rest(fa)
    const wr = rest(hb)
    const arm = blend(fa, ua, el.y, 0.08)
    // the sleeve stops short of the wrist and thins into it, so its end is
    // buried in the cuff rather than poking out through the mitten
    tube(
      s, [sh, el, wr.clone().add(new THREE.Vector3(0, 0.07, 0))],
      0.15, 0.11, ROLE.SUIT, arm, 10,
    )
    const mit = wr.clone().add(new THREE.Vector3(0, -0.1, 0.0))
    ellipsoid(s, mit, new THREE.Vector3(0.135, 0.165, 0.15), ROLE.TRIM, rigid(hb), [12, 9])
    ellipsoid(
      s, mit.clone().add(new THREE.Vector3(-side * 0.08, 0.04, 0.1)),
      new THREE.Vector3(0.055, 0.075, 0.055), ROLE.TRIM, rigid(hb), [8, 6],
    )
    // a glove cuff over the end of the sleeve, on the forearm like the
    // boot's top is on the shin, so the mitten flopping at the wrist only
    // ever crosses its own cuff
    tube(
      s, [wr.clone().add(new THREE.Vector3(0, 0.1, 0)), wr.clone().add(new THREE.Vector3(0, 0.0, 0))],
      0.14, 0.135, ROLE.TRIM, rigid(fa), 10,
    )
  }

  // --- legs: thigh to ankle, soft across the knee; a chunky boot on the foot
  for (const [th, sn, ft] of [
    [B.THIGH_L, B.SHIN_L, B.FOOT_L],
    [B.THIGH_R, B.SHIN_R, B.FOOT_R],
  ] as const) {
    const hip = rest(th)
    const knee = rest(sn)
    const ank = rest(ft)
    const leg = blend(sn, th, knee.y, 0.09)
    tube(
      s, [hip.clone().add(new THREE.Vector3(0, 0.08, 0)), knee, ank.clone().add(new THREE.Vector3(0, 0.16, 0))],
      0.215, 0.16, ROLE.SUIT, leg, 10,
    )
    // the boot: an egg with its bottom sliced flat into a sole, toe out
    // front, and a fat rolled top the leg disappears into. The top rides the
    // *shin*, not the foot: the ankle turns to keep the sole flat, and a
    // collar on the foot let the trouser poke out of it at every step. Now
    // the only thing that crosses anything is boot into boot
    ellipsoid(
      s, new THREE.Vector3(ank.x, 0.11, 0.07), new THREE.Vector3(0.19, 0.17, 0.28),
      ROLE.TRIM, rigid(ft), [14, 10], undefined, 0.0,
    )
    tube(
      s, [ank.clone().add(new THREE.Vector3(0, 0.2, -0.01)), ank.clone().add(new THREE.Vector3(0, 0.06, -0.01))],
      0.19, 0.18, ROLE.TRIM, rigid(sn), 10,
    )
  }

  // --- the head: a big round face under a beanie
  const hc = new THREE.Vector3(0, headY + HEAD_CY, HEAD_CZ)
  const head = rigid(B.HEAD)
  ellipsoid(s, hc, HEAD_R, ROLE.SKIN + H, head, [22, 16])

  // the beanie: the skull grown a touch and cut on a plane that rides
  // higher at the front, so it sits pushed back off the forehead
  const BR = HEAD_R.clone().multiplyScalar(1.075)
  BR.y = HEAD_R.y * CAP_TALL
  const cutAt = (z: number) => 0.2 + 0.07 * (z / BR.z) // above hc, per z
  const capPoint = (th: number, ph: number, out: THREE.Vector3) =>
    out.set(
      Math.sin(ph) * Math.cos(th) * BR.x,
      Math.cos(ph) * BR.y,
      Math.sin(ph) * Math.sin(th) * BR.z,
    )
  /** how far down from the pole the cap reaches at this bearing. Its own
      scratch vector: patch() is holding the shared ones mid-derivative
      when this runs, and borrowing one scrambled every normal on the cap */
  const rimTmp = new THREE.Vector3()
  const rimPh = (th: number) => {
    let lo = 0
    let hi = Math.PI * 0.75
    for (let k = 0; k < 24; k++) {
      const m = (lo + hi) / 2
      capPoint(th, m, rimTmp)
      if (rimTmp.y > cutAt(rimTmp.z)) lo = m
      else hi = m
    }
    return lo
  }
  patch(
    s,
    (u, v, out) => {
      const th = u * Math.PI * 2
      capPoint(th, v * rimPh(th), out).add(hc)
    },
    22, 8, ROLE.ACCENT + H, head, hc,
  )
  // the folded cuff: a fat ring swept round the rim
  const rim: THREE.Vector3[] = []
  for (let k = 0; k <= 28; k++) {
    const th = (k / 28) * Math.PI * 2
    const p = capPoint(th, rimPh(th), new THREE.Vector3())
    // pushed out a little along its own horizontal
    const o = new THREE.Vector3(p.x, 0, p.z).normalize().multiplyScalar(0.005)
    rim.push(p.add(o).add(hc).add(new THREE.Vector3(0, 0.045, 0)))
  }
  tube(s, rim, 0.058, 0.058, ROLE.ACCENT + H, head, 8, 1.35)

  // the pom-pom, on its own springy bone
  const pom = rest(B.POM)
  ellipsoid(
    s, pom.clone().add(new THREE.Vector3(0, 0.11, -0.01)), new THREE.Vector3(0.13, 0.12, 0.13),
    ROLE.ACCENT + H, rigid(B.POM), [12, 9], undefined, -Infinity, 0.09,
  )
  ellipsoid(
    s, pom.clone().add(new THREE.Vector3(0, 0.02, 0)), new THREE.Vector3(0.05, 0.06, 0.05),
    ROLE.ACCENT + H, rigid(B.POM), [6, 5],
  )

  /** a feature lying on the skull: centred where the surface is at (x, y),
      oriented to its normal, with radii along (side, up, out) */
  const onFace = (
    x: number, y: number, r: THREE.Vector3, role: number, weigh: Weigh, lift = 0,
    seg: [number, number] = [12, 8], onCap = false,
  ) => {
    const R = onCap ? BR : HEAD_R
    const nx = x / R.x
    const ny = y / R.y
    const nz = Math.sqrt(Math.max(0.02, 1 - nx * nx - ny * ny))
    const p = new THREE.Vector3(x, y, nz * R.z).add(hc)
    const n = new THREE.Vector3(nx / R.x, ny / R.y, nz / R.z).normalize()
    const side = new THREE.Vector3(0, 1, 0).cross(n).normalize()
    const up = new THREE.Vector3().crossVectors(n, side).normalize()
    const m = new THREE.Matrix4().makeBasis(side, up, n)
    p.addScaledVector(n, lift)
    ellipsoid(s, p, r, role, weigh, seg, m)
  }
  const eyes = rigid(B.EYES)
  const eyeY = EYE_OFF - HEAD_CY
  for (const side of [1, -1]) {
    // eyes sized for a picture a few hundred pixels tall: at lineup
    // distance a face is twenty pixels across, and these have to stay two
    // dark blobs rather than one smudge
    onFace(side * 0.2, eyeY, new THREE.Vector3(0.088, 0.13, 0.035), ROLE.INK + H, eyes, 0.0)
    onFace(side * 0.2 + 0.03, eyeY + 0.05, new THREE.Vector3(0.03, 0.032, 0.014), ROLE.GLINT + H, eyes, 0.034, [6, 4])
    onFace(side * 0.32, eyeY - 0.15, new THREE.Vector3(0.08, 0.05, 0.016), ROLE.CHEEK + H, head, 0.0, [10, 6])
    // ears: a bump either side is what stops the back of a head being an egg
    const ear = new THREE.Vector3(side * (HEAD_R.x - 0.01), hc.y + eyeY - 0.05, hc.z - 0.03)
    ellipsoid(s, ear, new THREE.Vector3(0.07, 0.11, 0.08), ROLE.SKIN + H, head, [8, 6])
    ellipsoid(s, ear.clone().add(new THREE.Vector3(side * 0.03, 0, 0.01)), new THREE.Vector3(0.035, 0.065, 0.045), ROLE.CHEEK + H, head, [6, 5])
  }
  // the smile: a short arc of ink under the eyes, lying on the skin
  const smile: THREE.Vector3[] = []
  for (let k = 0; k <= 8; k++) {
    const x = -0.075 + (k / 8) * 0.15
    const y = eyeY - 0.17 + 2.6 * x * x
    const nz = Math.sqrt(Math.max(0, 1 - (x / HEAD_R.x) ** 2 - (y / HEAD_R.y) ** 2))
    smile.push(new THREE.Vector3(x, y, nz * HEAD_R.z + 0.004).add(hc))
  }
  tube(s, smile, 0.017, 0.017, ROLE.INK + H, head, 6)

  // hair: one smooth mass at the back of the head under the cuff, the skull
  // grown a hair and cut to a band from ear to ear. It was a row of tufts,
  // and from behind at any distance a row of dark blobs under a hat reads
  // as eyes or a moustache; a single shape reads as a haircut
  const HR = HEAD_R.clone().multiplyScalar(1.035)
  const hairPoint = (th: number, drop: number, out: THREE.Vector3) => {
    // bearing th round the back, from just under the rim down `drop`
    const x = Math.cos(th)
    const z = Math.sin(th)
    const top = cutAt(z * HR.z) + 0.02
    const y = top - drop
    const k = Math.sqrt(Math.max(0, 1 - (y / HR.y) ** 2))
    return out.set(x * HR.x * k, y, z * HR.z * k)
  }
  patch(
    s,
    (u, v, out) => {
      const th = Math.PI * (1.08 + u * 0.84) // ear to ear round the back (-z)
      // deepest at the nape, tapering to nothing at the ears
      const depth = 0.24 * Math.pow(Math.sin(u * Math.PI), 0.7)
      hairPoint(th, v * depth, out).add(hc)
    },
    16, 3, ROLE.HAIR + H, head, hc,
  )

  // a rolled collar round the neck: the suit's own colour, filling the notch
  // between a round head and a round body so the head sits on the shoulders
  // rather than floating over them
  const collar: THREE.Vector3[] = []
  const collarY = BODY_Y1 - 0.13
  for (let k = 0; k <= 24; k++) {
    const th = (k / 24) * Math.PI * 2
    collar.push(new THREE.Vector3(Math.cos(th) * 0.3, collarY, Math.sin(th) * 0.27 + 0.02))
  }
  tube(s, collar, 0.1, 0.1, ROLE.SUIT, rigid(B.TORSO), 8)

  // the headlamp: a small lit lens set into the middle of the cuff, with a
  // thin rim of trim round it. It had a dark housing, and at a distance a
  // dark lump with a bright spot just above the eyes read as an eyepatch
  const lampY = cutAt(BR.z) + 0.05
  onFace(0, lampY, new THREE.Vector3(0.062, 0.05, 0.03), ROLE.TRIM + H, head, 0.055, [10, 6], true)
  onFace(0, lampY, new THREE.Vector3(0.05, 0.04, 0.03), ROLE.GLOW + H, head, 0.07, [10, 6], true)

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
