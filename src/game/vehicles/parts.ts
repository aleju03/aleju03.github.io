import * as THREE from 'three'

/*
  The modelling kit the vehicles are shaped from.

  Nothing in this project ships a model file (see the "nothing shipped,
  nothing copyrighted" rule in CLAUDE.md), so a car has to be *described*
  rather than downloaded. Boxes won't do it: what separates a vehicle from a
  crate is that its surfaces are curved and continuous — a bonnet that flows
  into a wing, a hull that tapers from a full midship section to a fine
  entry, a tail boom that necks down into its fin. Every one of those is the
  same operation: a series of cross-sections along an axis, skinned.

  So `loft()` is the workhorse here, and `ringSuper()` is what feeds it. A
  superellipse |x/a|^n + |y/b|^n = 1 covers, with one exponent, the entire
  range a vehicle body needs: n=2 is an ellipse (a fuselage), n≈4-6 is the
  rounded rectangle a car's lower body actually is, n→∞ is a slab, and — the
  reason it is worth the pow() — n<2 is *concave*, so n≈1.3 on the lower half
  of a section is a V-bottom with a little rocker in it, which is a planing
  hull. Upper and lower halves take their own exponent and their own height,
  which is how one function draws a boat (soft flared deck over a hard V) and
  a car roof (a wide flat crown over a tucked-in rocker).

  Smooth shading is the default because these are pressed metal shells, and
  hard edges are opted into per station (`crease`) by duplicating that ring:
  computeVertexNormals then averages within each side of the seam instead of
  across it. That is how a chine on a hull, a shut-line at the back of a
  bonnet, or the fold along a car's shoulder stays sharp while everything
  either side of it stays glassy.

  Two more things earn their place:

  - `both()`. Vehicles are symmetric, and authoring the left half twice is
    how a model ends up subtly lopsided. It runs an authoring callback once,
    then again under an x-mirror, flipping winding and normals so the mirrored
    half is not inside out.
  - the per-material `PartBuilder`. A vehicle wants clearcoat on the paint,
    roughness 0.9 on the tyres and metalness 1 on the chrome, so it can't be
    one vertex-coloured soup like the chunk mesh is. It is instead one merged
    mesh per *material slot* — six or seven draw calls for a whole car, which
    is the same order as one piece of the house.

  Everything here is renderer-free and DOM-free: geometry in, geometry out.
*/

/** a closed cross-section outline in the model's (x, y) plane, flattened to
    [x0, y0, x1, y1, ...]. Two rings can only be skinned to each other if they
    carry the same number of points, and the j-th point of one is skinned to
    the j-th of the next — so a feature (a chine, a shoulder crease) stays on
    the same index the whole length of the loft and runs as a straight line
    rather than spiralling around the body */
export type Ring = number[]

/** default points per ring. 32 is smooth enough that a bonnet reflection has
    no visible facets at arm's length and still costs under a thousand
    vertices for a whole car body */
export const RING_N = 32

const TAU = Math.PI * 2
/** signed power, so the superellipse survives negative cosines */
const spow = (v: number, e: number) => Math.sign(v) * Math.pow(Math.abs(v), e)

/**
 * A superellipse ring with independent upper and lower halves.
 *
 * `hw` is the half-width; `up`/`down` are how far the outline reaches above
 * and below the section's own centreline. `nUp`/`nDown` are the exponents:
 * 2 is an ellipse, 4-8 is a rounded rectangle with progressively tighter
 * corners, and anything under 2 bends the other way — 1 is a straight-sided
 * V, 1.3 a V with a little belly in it.
 */
export const ringSuper = (
  hw: number,
  up: number,
  down: number,
  nUp = 4,
  nDown = 4,
  n = RING_N,
): Ring => {
  const out: Ring = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU
    const c = Math.cos(t)
    const s = Math.sin(t)
    const upper = s >= 0
    const e = 2 / (upper ? nUp : nDown)
    out.push(hw * spow(c, e), (upper ? up : down) * spow(s, e))
  }
  return out
}

/** a ring from any parametric outline, sampled at n even values of t. Use it
    when a section has a feature that has to land on a fixed index — pass a
    piecewise function of t and the break lands on the same vertex in every
    station, which is what makes a chine a line instead of a spiral */
export const ringFrom = (fn: (t: number) => [number, number], n = RING_N): Ring => {
  const out: Ring = []
  for (let i = 0; i < n; i++) {
    const [x, y] = fn(i / n)
    out.push(x, y)
  }
  return out
}

export const ringScale = (r: Ring, sx: number, sy = sx): Ring =>
  r.map((v, i) => v * (i % 2 ? sy : sx))

export const ringOffset = (r: Ring, dx: number, dy: number): Ring =>
  r.map((v, i) => v + (i % 2 ? dy : dx))

/** blend two rings of matching length; the cheapest way to make a section
    morph from one character into another along a body */
export const ringLerp = (a: Ring, b: Ring, t: number): Ring =>
  a.map((v, i) => v + (b[i] - v) * t)

/** clamp a ring's floor, so a hull section can sit on a flat keel plank or a
    car's lower body can stop at the rocker line without redrawing it */
export const ringFloor = (r: Ring, y: number): Ring =>
  r.map((v, i) => (i % 2 ? Math.max(v, y) : v))

/** ...and its ceiling */
export const ringRoof = (r: Ring, y: number): Ring =>
  r.map((v, i) => (i % 2 ? Math.min(v, y) : v))

/** one cross-section placed along the loft's axis (+z, i.e. toward the
    vehicle's tail — everything here is authored nose-at-negative-z, which is
    the direction a yaw of 0 faces) */
export interface Station {
  z: number
  ring: Ring
  /** shift the whole ring: a bonnet line that drops, a hull that rockers up */
  x?: number
  y?: number
  /** don't smooth normals across this station: the ring is emitted twice and
      each strip gets its own copy, so the seam reads as a pressed fold */
  crease?: boolean
}

export type Cap = 'none' | 'flat'

/**
 * Skin a series of cross-sections into a shell.
 *
 * Stations are skinned in the order given, point j to point j, so all rings
 * must be the same length. `capStart`/`capEnd` close the ends with a fan from
 * the ring's centroid — its vertices are always separate from the shell's, or
 * the cap's flat normal would bleed into the last section and flatten it.
 */
export const loft = (
  stations: Station[],
  opts: { capStart?: Cap; capEnd?: Cap } = {},
): THREE.BufferGeometry => {
  const pos: number[] = []
  const idx: number[] = []
  const n = stations[0].ring.length / 2

  /** push one ring's worth of vertices, return the base index */
  const emit = (s: Station) => {
    const base = pos.length / 3
    for (let j = 0; j < n; j++) {
      pos.push(s.ring[j * 2] + (s.x ?? 0), s.ring[j * 2 + 1] + (s.y ?? 0), s.z)
    }
    return base
  }

  // walk the stations, emitting a fresh ring after every crease so the two
  // strips either side of it never share a vertex
  let prev = emit(stations[0])
  for (let i = 1; i < stations.length; i++) {
    const cur = emit(stations[i])
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n
      /*
        Wound so the front face points AWAY from the axis. Ring points run
        counter-clockwise in the section plane (x = cos, y = sin) and stations
        advance along +z, so the obvious order — prev_j, cur_j, cur_k — gives a
        normal of AB x AC = (0,0,dz) x (0,dy,dz) = (-dz*dy, 0, 0): inward, on
        every side triangle of every loft. The caps below happen to be right,
        which is the worst possible failure mode. What you get is a vehicle
        whose two end caps are solid and whose entire shell is invisible from
        outside and lit by inverted normals from inside — and because a
        MeshStandardMaterial is FrontSide, that reads as "the model didn't
        load" rather than as a winding bug. Reversing both triangles fixes it
        and costs nothing; computeVertexNormals follows the index order.
      */
      idx.push(prev + j, cur + k, cur + j, prev + j, prev + k, cur + k)
    }
    prev = stations[i].crease ? emit(stations[i]) : cur
  }

  const cap = (s: Station, front: boolean) => {
    const base = pos.length / 3
    let cx = 0
    let cy = 0
    for (let j = 0; j < n; j++) {
      cx += s.ring[j * 2]
      cy += s.ring[j * 2 + 1]
    }
    cx = cx / n + (s.x ?? 0)
    cy = cy / n + (s.y ?? 0)
    pos.push(cx, cy, s.z)
    for (let j = 0; j < n; j++) {
      pos.push(s.ring[j * 2] + (s.x ?? 0), s.ring[j * 2 + 1] + (s.y ?? 0), s.z)
    }
    for (let j = 0; j < n; j++) {
      const a = base + 1 + j
      const b = base + 1 + ((j + 1) % n)
      if (front) idx.push(base, b, a)
      else idx.push(base, a, b)
    }
  }
  if (opts.capStart === 'flat') cap(stations[0], true)
  if (opts.capEnd === 'flat') cap(stations[stations.length - 1], false)

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * A surface of revolution around the y axis, from a profile of [radius, y]
 * pairs. Wheels, rims, hubs, rotor masts, exhaust cans, navigation lights and
 * the boat's propeller boss are all this. UVs run u around the axis and v
 * along the profile, so a tyre can carry a tread map painted in a canvas.
 *
 * `sharp` marks a profile point as a hard edge — the shoulder of a tyre, the
 * lip of a rim — by duplicating that row, exactly like `loft`'s crease.
 */
export const revolve = (
  profile: Array<[r: number, y: number]>,
  seg = 24,
  opts: { arc?: number; sharp?: number[] } = {},
): THREE.BufferGeometry => {
  const arc = opts.arc ?? TAU
  const closed = Math.abs(arc - TAU) < 1e-6
  const cols = closed ? seg : seg + 1
  const sharp = new Set(opts.sharp ?? [])
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []

  const rows: number[] = []
  const emit = (p: [number, number], v: number) => {
    const base = pos.length / 3
    for (let i = 0; i < cols; i++) {
      const a = (i / seg) * arc
      pos.push(Math.cos(a) * p[0], p[1], Math.sin(a) * p[0])
      uv.push(i / seg, v)
    }
    return base
  }
  for (let k = 0; k < profile.length; k++) {
    const v = k / Math.max(1, profile.length - 1)
    rows.push(emit(profile[k], v))
    // a sharp row is emitted twice: the strip above it takes the second copy
    if (sharp.has(k) && k > 0 && k < profile.length - 1) rows.push(emit(profile[k], v))
  }
  let r = 0
  for (let k = 0; k < profile.length - 1; k++) {
    const a = rows[r]
    r += sharp.has(k) && k > 0 ? 2 : 1
    const b = rows[r]
    for (let i = 0; i < cols - (closed ? 0 : 1); i++) {
      const j = closed ? (i + 1) % cols : i + 1
      idx.push(a + i, b + i, b + j, a + i, b + j, a + j)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * A round tube swept along a polyline: landing skids, exhaust runs, roll
 * hoops, aerials, railings, the boat's bow rail.
 *
 * The frame is parallel-transported rather than rebuilt from a fixed up
 * vector at each point, which is what keeps a tube from twisting through a
 * quarter turn where the path passes near vertical — a skid tube bends from
 * horizontal to vertical twice, and the naive frame flips it inside out at
 * exactly those bends.
 */
export const tube = (
  path: THREE.Vector3[],
  radius: number | ((t: number) => number),
  radial = 8,
  opts: { caps?: boolean } = {},
): THREE.BufferGeometry => {
  const pos: number[] = []
  const idx: number[] = []
  const tan = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  const bin = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const rAt = typeof radius === 'function' ? radius : () => radius

  // seed the transport frame with any vector not parallel to the first tangent
  tan.subVectors(path[1], path[0]).normalize()
  nrm.set(0, 1, 0)
  if (Math.abs(nrm.dot(tan)) > 0.9) nrm.set(1, 0, 0)
  nrm.crossVectors(tan, nrm).normalize()

  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const next = path[Math.min(i + 1, path.length - 1)]
      const prev = path[Math.max(i - 1, 0)]
      const nt = tmp.subVectors(next, prev).normalize()
      // rotate the carried normal by the same rotation that takes the old
      // tangent to the new one; no reference vector, so no flip
      const q = new THREE.Quaternion().setFromUnitVectors(tan, nt)
      nrm.applyQuaternion(q).normalize()
      tan.copy(nt)
    }
    bin.crossVectors(tan, nrm).normalize()
    const r = rAt(i / (path.length - 1))
    const base = pos.length / 3
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU
      const c = Math.cos(a)
      const s = Math.sin(a)
      pos.push(
        path[i].x + (nrm.x * c + bin.x * s) * r,
        path[i].y + (nrm.y * c + bin.y * s) * r,
        path[i].z + (nrm.z * c + bin.z * s) * r,
      )
    }
    if (i > 0) {
      const prevBase = base - radial
      for (let j = 0; j < radial; j++) {
        const k = (j + 1) % radial
        // outward-facing, for the same reason spelled out in loft(): the
        // transport frame (nrm, bin, tan) is right-handed, so the naive order
        // points every side triangle at the tube's own axis
        idx.push(prevBase + j, base + k, base + j, prevBase + j, prevBase + k, base + k)
      }
    }
  }
  if (opts.caps) {
    for (const [at, front] of [[0, true] as const, [path.length - 1, false] as const]) {
      const ring = at * radial
      const base = pos.length / 3
      pos.push(path[at].x, path[at].y, path[at].z)
      for (let j = 0; j < radial; j++) {
        const k = (j + 1) % radial
        if (front) idx.push(base, ring + k, ring + j)
        else idx.push(base, ring + j, ring + k)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * An aerofoil blade running out along +x: a rotor blade, a propeller, a tail
 * fin, a boat rudder, a helicopter's horizontal stabiliser.
 *
 * The section is a real symmetric aerofoil rather than a rectangle — chord
 * along z, thickness along y, a blunt leading edge and a fine trailing one —
 * because a rotor at idle spends most of its time edge-on to the camera, and
 * edge-on is exactly where a flat card disappears. `twist` washes the root out
 * of the tip's pitch the way a real blade does, and it costs nothing.
 */
export const blade = (
  span: number,
  opts: {
    /** chord at the root, and at the tip */
    root?: number
    tip?: number
    /** peak thickness as a fraction of the local chord */
    thick?: number
    /** root pitch in radians, washing out to zero at the tip */
    twist?: number
    /** how far the tip trails the root along the chord */
    sweep?: number
    steps?: number
    /** round the last fifth off into a nose instead of a square chop */
    roundTip?: boolean
  } = {},
): THREE.BufferGeometry => {
  const rootC = opts.root ?? 0.5
  const tipC = opts.tip ?? rootC * 0.8
  const thick = opts.thick ?? 0.12
  const twist = opts.twist ?? 0
  const sweep = opts.sweep ?? 0
  const steps = opts.steps ?? 6
  const sec = 12
  const pos: number[] = []
  const idx: number[] = []

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const round = opts.roundTip
      ? Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, t - 0.8) / 0.2, 2)))
      : 1
    const c = Math.max(1e-3, (rootC + (tipC - rootC) * t) * round)
    const a = twist * (1 - t)
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const base = pos.length / 3
    for (let j = 0; j < sec; j++) {
      const ang = (j / sec) * TAU
      // chord runs -c..+c; thickness is the classic 4-digit-ish bulge, fat a
      // third back from the leading edge and tapering to nothing at the tail
      const z = Math.cos(ang) * c
      const f = Math.sqrt(Math.max(0, 1 - (z / c) ** 2))
      const y = Math.sin(ang) * thick * c * (0.35 + 0.65 * f)
      pos.push(t * span, sa * z + ca * y, ca * z - sa * y + sweep * t)
    }
    if (i > 0) {
      const prev = base - sec
      for (let j = 0; j < sec; j++) {
        const k = (j + 1) % sec
        idx.push(prev + j, base + j, base + k, prev + j, base + k, prev + k)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/* ---------------------------------------------------------- part builder -- */

/** the material families a vehicle is painted from. One merged mesh per slot
    that actually gets used, so a whole car is six or seven draw calls */
export type Slot =
  /** the main body colour, with clearcoat over it */
  | 'paint'
  /** a second body colour: roof, stripe, hull topsides */
  | 'paint2'
  /** unpainted moulded plastic: bumpers, sills, dashboards, seats */
  | 'trim'
  /** polished metal: grille, mirror shells, exhaust, rails, rotor mast */
  | 'chrome'
  /** brushed / painted metal that is not the body: engine, skids, blades */
  | 'metal'
  /** tinted glazing */
  | 'glass'
  /** tyres, seals, mats */
  | 'rubber'
  /** shadow gaps, arch liners, grille mesh, anything that should read as a
      hole rather than as a surface */
  | 'dark'
  /** headlamps, cabin light, instrument glow */
  | 'lamp'
  /** tail lamps and beacons */
  | 'lampRed'
  /** upholstery */
  | 'seat'

export interface PartBuilder {
  /** stamp a geometry into a slot, optionally transformed */
  add: (geo: THREE.BufferGeometry, slot: Slot, m?: THREE.Matrix4) => void
  /** run an authoring block, then run it again mirrored across x. Winding and
      normals are flipped for the mirrored pass, so the far side is not inside
      out — which is the one bug you cannot see until the light moves */
  both: (fn: () => void) => void
  /** push a transform every subsequent add is composed with (and `both`
      composes its mirror on top of); returns a function that pops it */
  push: (m: THREE.Matrix4) => () => void
  /** slots that got anything, in insertion order */
  readonly used: Slot[]
  /** merge each slot into one mesh and return them under a group */
  build: (
    mats: Partial<Record<Slot, THREE.Material>>,
    opts?: { cast?: boolean; receive?: boolean; name?: string },
  ) => THREE.Group
}

interface SlotData {
  pos: number[]
  nrm: number[]
  uv: number[]
  idx: number[]
}

const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1)

export function createPartBuilder(): PartBuilder {
  const slots = new Map<Slot, SlotData>()
  const stack: THREE.Matrix4[] = []
  const cur = new THREE.Matrix4()
  const nm = new THREE.Matrix3()
  const v = new THREE.Vector3()

  const recompose = () => {
    cur.identity()
    for (const m of stack) cur.multiply(m)
  }

  const builder: PartBuilder = {
    add(geo, slot, m) {
      let d = slots.get(slot)
      if (!d) {
        d = { pos: [], nrm: [], uv: [], idx: [] }
        slots.set(slot, d)
      }
      const world = m ? cur.clone().multiply(m) : cur
      const flip = world.determinant() < 0
      nm.getNormalMatrix(world)
      const p = geo.getAttribute('position')
      const n = geo.getAttribute('normal')
      const t = geo.getAttribute('uv')
      const base = d.pos.length / 3
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(world)
        d.pos.push(v.x, v.y, v.z)
        if (n) {
          // the normal matrix of a mirror is the mirror, so the transformed
          // normal already points the right way once the winding below is
          // reversed to match — do one without the other and the far half of
          // every vehicle lights black
          v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize()
          d.nrm.push(v.x, v.y, v.z)
        } else {
          d.nrm.push(0, 1, 0)
        }
        if (t) d.uv.push(t.getX(i), t.getY(i))
        else d.uv.push(0, 0)
      }
      const gi = geo.getIndex()
      const count = gi ? gi.count : p.count
      const at = (i: number) => (gi ? gi.getX(i) : i)
      for (let i = 0; i < count; i += 3) {
        if (flip) d.idx.push(base + at(i), base + at(i + 2), base + at(i + 1))
        else d.idx.push(base + at(i), base + at(i + 1), base + at(i + 2))
      }
    },
    push(m) {
      stack.push(m)
      recompose()
      return () => {
        stack.pop()
        recompose()
      }
    },
    both(fn) {
      fn()
      const pop = builder.push(MIRROR)
      fn()
      pop()
    },
    get used() {
      return [...slots.keys()]
    },
    build(mats, opts = {}) {
      const group = new THREE.Group()
      if (opts.name) group.name = opts.name
      for (const [slot, d] of slots) {
        const mat = mats[slot]
        if (!mat || !d.pos.length) continue
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(d.pos), 3))
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(d.nrm), 3))
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(d.uv), 2))
        g.setIndex(
          d.pos.length / 3 > 65535
            ? new THREE.BufferAttribute(new Uint32Array(d.idx), 1)
            : new THREE.BufferAttribute(new Uint16Array(d.idx), 1),
        )
        g.computeBoundingSphere()
        const mesh = new THREE.Mesh(g, mat)
        mesh.name = slot
        mesh.castShadow = opts.cast ?? true
        // glazing that receives shadows goes black in its own doorway; the
        // shells receive so a wing shades the body under it
        mesh.receiveShadow = (opts.receive ?? true) && slot !== 'glass' && slot !== 'lamp'
        group.add(mesh)
      }
      return group
    },
  }
  return builder
}

/* --------------------------------------------------------------- helpers -- */

/** compose a transform the short way, for the hundreds of little placements a
    vehicle is made of */
export const at = (
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  )

/**
 * Everything that keeps moving must say so.
 *
 * CrtScene freezes the whole static scene graph once the room is built
 * (`scene.traverse(o => { if (!o.userData.dynamic) o.matrixAutoUpdate = false })`),
 * and a frozen vehicle is a vehicle that renders wherever it was assembled no
 * matter what its transform says afterwards. The sky hits the same wall and
 * solves it the same way.
 */
export const markDynamic = (o: THREE.Object3D) => {
  o.traverse((c) => {
    c.userData.dynamic = true
  })
  return o
}

/**
 * A slab with softened edges, centred on the origin and running w x h x d.
 * Seat cushions, dashboards, number plates, mirror shells, radiator cores —
 * everything that really is a box, but where a razor-sharp arris catches a
 * highlight no moulded part ever would.
 *
 * It is a four-station loft rather than a subdivided box: the rounding is one
 * inset ring at each end, and the corner radius lives in the section's
 * superellipse exponent, so the whole thing costs eighty vertices.
 */
export const slab = (w: number, h: number, d: number, r = 0.05) => {
  const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)
  if (rr <= 1e-3) return new THREE.BoxGeometry(w, h, d)
  // a bigger corner radius wants a lower exponent; 2 would be an ellipse
  const n = THREE.MathUtils.clamp(Math.min(w, h) / rr, 2.2, 12)
  const outer = ringSuper(w / 2, h / 2, h / 2, n, n, 20)
  const inner = ringScale(outer, 1 - (rr * 2) / w, 1 - (rr * 2) / h)
  return loft(
    [
      { z: -d / 2, ring: inner },
      { z: -d / 2 + rr, ring: outer },
      { z: d / 2 - rr, ring: outer },
      { z: d / 2, ring: inner },
    ],
    { capStart: 'flat', capEnd: 'flat' },
  )
}
