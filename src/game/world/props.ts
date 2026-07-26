import * as THREE from 'three'
import type { MeshBuilder } from '../core/geometry'
import type { PropKind } from './biomes'
import { rand3 } from './noise'
import { gfx } from './quality'
import { SURF, type SurfaceId } from './surface'

/*
  Everything that grows. Each kind is a small kit of primitives built once at
  module load and stamped into a chunk's mesh builder with a transform and a
  palette — so a jungle and a taiga share the same trunk geometry and differ
  only in the colours written per vertex, and a whole forest still arrives as
  one draw call.

  Broadleaf canopies are painterly alpha cards: quads spread over a cluster
  of lobes, sampling one runtime-painted leaf-cluster texture (the canvas is
  makeLeafTexture in treeMesh.ts, which both the chunk material and the
  standalone yard trees import — this module stays DOM-free so the sim runs
  headless). They went through two earlier shapes — sharp octahedra, then
  clustered smooth balls — and both had the same tell at walking distance: a
  closed solid silhouette reads as topiary, however good its shading. What
  makes painted-tree demos read as *foliage* is that the silhouette is made of
  leaves: ragged, half-transparent at the rim, catching sky through the gaps.
  Cards buy exactly that, and at four vertices a card they are cheaper than
  the balls were. Two tricks keep them from reading as what they actually are:
  a round lobe's card normals are bent to its sphere (the crown shades as one
  round mass, not as flat posters) while a flat one's point up, because a
  parasol is a layer of foliage rather than a ball of it; and every quad is
  emitted twice with reversed winding, so the material stays FrontSide — a
  card's back face takes the front's normals, which is the same
  lit-from-above-both-sides cheat the palm fronds already use. There is no
  opaque core in any of them: light through the crown is the look.

  Two numbers decide whether a card reads as leaves or as a green plane, and
  neither is the card count. One is its size against its lobe — past about
  half the lobe radius a card is wider than the thing it belongs to and hangs
  off the rim as a quad. The other is whether the texture has anything inside
  it, which for a long time it did not.

  The other half of the look is the shade ramp: every foliage part is painted
  dark at its underside and bright at its crown as it is stamped (MeshBuilder's
  ShadeSpan). Uniformly lit foliage reads as plastic no matter how good the
  silhouette is, and the ramp costs one multiply per vertex at build time and
  nothing at all per frame.

  Trunks are grown, not stamped (see the `wood` section below). Every tree in
  here used to be one CylinderGeometry — the same tapered pole for a birch and
  for a jungle broadleaf, differing only in the colour written over it — and
  from ten units away that is exactly what it read as: a canopy doing all the
  work over a stick holding it up. `wood()` sweeps a tube along a spine that
  wanders, flares into the ground and forks into limbs, and hands back the tips
  it ended on; the kit then hangs its canopy lobes on those tips. That last
  part is what actually buys variety, because the crown becomes a consequence
  of the skeleton: two variants that branch differently have different
  silhouettes rather than the same ball at two heights.

  VARIANTS per kind, picked by hash, is the rest of the anti-repetition
  strategy alongside per-instance scale, yaw and a colour jitter. It reads as
  variety at walking speed, which is the only speed anyone sees it at.

  Every kit declares `solid`: the radius and height of the collision box the
  scatterer should register, or null for anything you are meant to walk
  straight through. Grass, reeds and small shrubs are deliberately null —
  a world where every tuft is a bollard is a world you cannot walk across.
*/

/** one painted piece of a kit. 'card' is foliage too — painted with the leaf
    palette entry — but it must land in the chunk's UV-carrying card builder,
    whose material samples the leaf texture with alpha test. */
interface Part {
  geo: THREE.BufferGeometry
  /** which palette entry paints it */
  slot: 'bark' | 'leaf' | 'accent' | 'card'
  /** paint it this instead of the palette entry, for the handful of things
      whose colour is not a property of the biome they grow in — a birch is
      white bark in a forest and white bark in a taiga, and borrowing `accent`
      for it made it stone-grey in one and sand in another */
  tint?: THREE.Color
  /** override the surface treatment stampKit would pick from the slot */
  surf?: SurfaceId
}

export interface Kit {
  parts: Part[]
  /** collision cylinder, in the kit's own unit scale, or null for walk-through */
  solid: { r: number; h: number } | null
  /** nominal height, so the scatterer can keep things off low ceilings */
  height: number
}

export interface Palette {
  bark: THREE.Color
  leaf: THREE.Color
  accent: THREE.Color
}

/* ------------------------------------------------------------- helpers -- */

const parts: Part[] = []
const push = (
  geo: THREE.BufferGeometry, slot: Part['slot'], m: THREE.Matrix4,
  extra?: Omit<Part, 'geo' | 'slot'>,
) => {
  parts.push({ geo: geo.clone().applyMatrix4(m), slot, ...extra })
}
/** the same, for geometry generated for this kit alone: no clone, and it is
    already in kit space, so there is no transform either */
const own = (
  geo: THREE.BufferGeometry, slot: Part['slot'], extra?: Omit<Part, 'geo' | 'slot'>,
) => {
  parts.push({ geo, slot, ...extra })
}
const at = (x: number, y: number, z: number, sx = 1, sy = sx, sz = sx, ry = 0) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)),
    new THREE.Vector3(sx, sy, sz),
  )
const drain = (solid: Kit['solid'], height: number): Kit => {
  const k: Kit = { parts: parts.slice(), solid, height }
  parts.length = 0
  return k
}

/** the one deterministic generator everything in this module builds from */
const rng32 = (seed: number) => {
  let s = (seed * 2654435761) >>> 0
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0
    return (s >>> 8) / 16777216
  }
}

/**
 * A lumpy ball of radius 0.5, indexed, smooth-shaded, deterministic in `seed`.
 *
 * Indexed matters more than the vertex count here: three's PolyhedronGeometry
 * (Octahedron, Icosahedron) is non-indexed, so the twenty faces of an
 * icosahedron cost sixty vertices. This costs `lon * (lat - 1) + 2` — 23 at
 * the default — for a rounder outline than either.
 *
 * The radial jitter is what stops it looking like a UV sphere: each vertex is
 * pushed in or out by up to a tenth, the normal follows the pushed position,
 * and the result reads as a mass of leaves rather than as a balloon.
 */
const ball = (seed: number, lon = 7, lat = 4) => {
  const rnd = rng32(seed)
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  const put = (theta: number, phi: number) => {
    const r = 0.5 * (0.9 + rnd() * 0.2)
    const x = Math.sin(theta) * Math.cos(phi)
    const y = Math.cos(theta)
    const z = Math.sin(theta) * Math.sin(phi)
    pos.push(x * r, y * r, z * r)
    nor.push(x, y, z)
  }
  put(0, 0) // north pole
  for (let j = 1; j < lat; j++)
    for (let i = 0; i < lon; i++) put((j / lat) * Math.PI, (i / lon) * Math.PI * 2)
  put(Math.PI, 0) // south pole
  const ring = (j: number) => 1 + (j - 1) * lon
  for (let i = 0; i < lon; i++) {
    const n = (i + 1) % lon
    idx.push(0, ring(1) + n, ring(1) + i)
    idx.push(pos.length / 3 - 1, ring(lat - 1) + i, ring(lat - 1) + n)
  }
  for (let j = 1; j < lat - 1; j++)
    for (let i = 0; i < lon; i++) {
      const n = (i + 1) % lon
      const a = ring(j) + i
      const b = ring(j) + n
      const c = ring(j + 1) + i
      const d = ring(j + 1) + n
      idx.push(a, b, d, a, d, c)
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  g.setIndex(idx)
  return g
}

/** a canopy lobe: centre and radius in the kit's own space */
type Lobe = [x: number, y: number, z: number, r: number]

/**
 * A cluster of painterly foliage cards over a set of lobes. Each card is one
 * quad (emitted twice, wound both ways — see the module header) whose four
 * normals point away from its lobe's centre, slightly up-weighted, so the
 * merged crown light-wraps like a sphere while its silhouette stays leaves.
 * UVs span the whole leaf-cluster texture per card.
 *
 * `flat` lays the cards near-horizontal — the acacia's parasol — instead of
 * facing them every which way, and `tilt` is how far off horizontal they are
 * allowed to stray when it does. That knob is not cosmetic: a canopy of
 * perfectly horizontal cards has no thickness at all in silhouette, and an
 * acacia seen from a walker's eye level rendered as a handful of green
 * streaks floating over the savanna. Enough tilt and you see faces from the
 * side instead of edges.
 */
const cards = (seed: number, lobes: Lobe[], flat = false, tilt = 0.5) => {
  const rnd = rng32(seed)
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const ctr = new THREE.Vector3()
  const pt = new THREE.Vector3()
  const n = new THREE.Vector3()
  const facing = new THREE.Vector3()
  for (const [lx, ly, lz, r] of lobes) {
    const count = Math.round((4.4 + r * 2.5) * gfx.canopyK)
    for (let c = 0; c < count; c++) {
      const az = rnd() * Math.PI * 2
      const el = (rnd() - 0.38) * 1.6
      // cards live on the lobe's outer shell, not through its middle. The
      // first cut scattered them from the centre out, and the result at
      // close range was a bird's nest: interior cards seen edge-on as dark
      // slivers, and holes at the rim for the sky (or the buried core) to
      // stare through
      const rr = r * (0.5 + rnd() * 0.45)
      ctr.set(
        lx + Math.cos(el) * Math.cos(az) * rr,
        ly + Math.sin(el) * rr * 0.85,
        lz + Math.cos(el) * Math.sin(az) * rr,
      )
      if (flat) {
        const yaw = rnd() * Math.PI * 2
        right.set(Math.cos(yaw), 0, Math.sin(yaw))
        facing.set((rnd() - 0.5) * tilt, 1, (rnd() - 0.5) * tilt).normalize()
        up.crossVectors(facing, right).normalize()
      } else {
        // near-tangent to the shell: the card faces outward (with jitter), so
        // from any side the crown presents leaf faces, never card edges.
        // Widening this jitter does not help the cards that still end up
        // edge-on at the crown's rim — for any orientation distribution the
        // same fraction of cards contains the view ray, so it relocates the
        // slivers rather than removing them. What made them tolerable was
        // giving the leaf texture holes, so an edge-on card is a perforated
        // wisp instead of a solid green blade
        facing.set(
          ctr.x - lx + (rnd() - 0.5) * r * 0.6,
          (ctr.y - ly) * 1.1 + r * 0.2,
          ctr.z - lz + (rnd() - 0.5) * r * 0.6,
        ).normalize()
        right.set(-facing.z, 0, facing.x)
        if (right.lengthSq() < 1e-3) right.set(1, 0, 0)
        right.normalize()
        up.crossVectors(facing, right)
        const spin = rnd() * Math.PI * 2
        const cs = Math.cos(spin)
        const sn = Math.sin(spin)
        pt.copy(right)
        right.multiplyScalar(cs).addScaledVector(up, sn)
        up.multiplyScalar(cs).addScaledVector(pt, -sn)
      }
      // a card is never much more than half its lobe across. At 0.5..0.8 of
      // the radius the biggest ones were wider than the lobe they belonged to,
      // and a quad that size hanging off the rim of a crown cannot read as
      // anything but a plane, whatever is painted on it
      const sz = r * (0.4 + rnd() * 0.26)
      const base = pos.length / 3
      for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        pt.copy(ctr).addScaledVector(right, cu * sz).addScaledVector(up, cv * sz * (flat ? 0.7 : 1))
        pos.push(pt.x, pt.y, pt.z)
        // a round crown shades as a sphere, so its normals bend away from the
        // lobe's centre. A flat one is a horizontal layer of foliage and has
        // to shade like one: mostly up, leaning out only a little. Bending a
        // parasol's normals to its lobe pointed them sideways, the sun is
        // overhead, and a conifer's skirt came out as dark dashes ringing a
        // clean bright triangle
        if (flat) n.set((pt.x - lx) * 0.3, r * 0.85, (pt.z - lz) * 0.3)
        else n.set(pt.x - lx, (pt.y - ly) * 1.2 + r * 0.24, pt.z - lz)
        n.normalize()
        nor.push(n.x, n.y, n.z)
        uv.push(cu > 0 ? 1 : 0, cv > 0 ? 1 : 0)
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  g.setIndex(idx)
  return g
}

/* ---------------------------------------------------------------- wood -- */

/** one cross-section of a swept limb */
interface Station { x: number; y: number; z: number; r: number }

/**
 * Sweep a tube through `st` into shared arrays.
 *
 * The frame is parallel-transported — each ring's reference direction is the
 * previous one with its component along the new tangent projected out —
 * rather than rebuilt per ring from a fixed up vector. A Frenet or up-vector
 * frame flips as a limb passes horizontal and twists the tube inside out
 * exactly where a branch reaches out of the crown, which is the one place you
 * are looking at it.
 *
 * The seam column is shared, unlike CylinderGeometry's. None of this carries
 * UVs — bark is computed from world position in surface.ts — so the duplicate
 * column a texture coordinate would need is pure cost, and a six-sided tube
 * pays a seventh of its vertices for it. `ridge` modulates the radius around
 * the circumference so a trunk's outline is lobed rather than a circle, and a
 * ring of radius 0 collapses to a single apex vertex, which is how a limb ends
 * closed for one vertex instead of `sides` of them.
 */
const sweep = (
  pos: number[], nor: number[], idx: number[],
  st: Station[], sides: number, ridge: number, phase: number,
) => {
  const t = new THREE.Vector3()
  const n = new THREE.Vector3()
  const b = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  let prevBase = -1
  let prevApex = false
  for (let i = 0; i < st.length; i++) {
    const s = st[i]
    const a = st[Math.max(0, i - 1)]
    const c = st[Math.min(st.length - 1, i + 1)]
    t.set(c.x - a.x, c.y - a.y, c.z - a.z)
    if (t.lengthSq() < 1e-10) t.set(0, 1, 0)
    t.normalize()
    if (i === 0) {
      tmp.set(0, 1, 0)
      if (Math.abs(t.y) > 0.9) tmp.set(1, 0, 0)
      n.crossVectors(t, tmp).normalize()
    } else {
      n.addScaledVector(t, -n.dot(t))
      if (n.lengthSq() < 1e-8) {
        tmp.set(0, 1, 0)
        if (Math.abs(t.y) > 0.9) tmp.set(1, 0, 0)
        n.crossVectors(t, tmp)
      }
      n.normalize()
    }
    b.crossVectors(t, n)
    // how fast the radius is changing along the limb, so the ring's normals
    // lean with the taper. Purely radial normals light a strongly tapered
    // trunk as if it were a cylinder, which loses the whole point of the taper
    const dl = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z)
    const slope = dl > 1e-5 ? (c.r - a.r) / dl : 0
    const base = pos.length / 3
    const apex = s.r < 1e-3
    if (apex) {
      pos.push(s.x, s.y, s.z)
      nor.push(t.x, t.y, t.z)
    } else {
      for (let k = 0; k < sides; k++) {
        const ang = (k / sides) * Math.PI * 2
        const ca = Math.cos(ang)
        const sa = Math.sin(ang)
        const rr = s.r * (1 + ridge * Math.sin(ang * 3 + phase))
        pos.push(
          s.x + (n.x * ca + b.x * sa) * rr,
          s.y + (n.y * ca + b.y * sa) * rr,
          s.z + (n.z * ca + b.z * sa) * rr,
        )
        tmp.set(n.x * ca + b.x * sa, n.y * ca + b.y * sa, n.z * ca + b.z * sa)
          .addScaledVector(t, -slope)
          .normalize()
        nor.push(tmp.x, tmp.y, tmp.z)
      }
    }
    if (i > 0) {
      if (apex) {
        for (let k = 0; k < sides; k++) {
          idx.push(prevBase + k, prevBase + ((k + 1) % sides), base)
        }
      } else if (prevApex) {
        for (let k = 0; k < sides; k++) {
          idx.push(prevBase, base + ((k + 1) % sides), base + k)
        }
      } else {
        for (let k = 0; k < sides; k++) {
          const k2 = (k + 1) % sides
          idx.push(prevBase + k, base + k2, base + k)
          idx.push(prevBase + k, prevBase + k2, base + k2)
        }
      }
    }
    prevBase = base
    prevApex = apex
  }
}

/** where along a limb its cross-sections are cut. The trunk's cluster near the
    ground because that is where the root flare lives; past the first fifth
    nothing about a trunk changes fast enough to be worth a ring. Three rings
    inside the flare and not two: at two, the swell ended on a hard shoulder
    and every tree stood on a bottle. */
const T_TRUNK = [0, 0.04, 0.1, 0.2, 0.45, 1]
const T_LIMB = [0, 0.3, 0.64, 1]
const T_TWIG = [0, 0.45, 1]

export interface WoodCfg {
  /** height of the clear trunk, to the first fork */
  h: number
  /** trunk radius above the flare */
  r: number
  /** how much wider than that the very base swells: the root flare */
  flare?: number
  /** radius at the top of the trunk, as a fraction of `r` */
  taper?: number
  /** how far the trunk drifts sideways over its height, in trunk heights */
  lean?: number
  /** fork levels. 0 is a bare swept pole; 2 is a trunk, its limbs, and theirs */
  levels?: number
  /** children per fork */
  splits?: number
  /** how far a child leans off its parent, radians */
  spread?: number
  /** how hard a limb curves back toward vertical over its length. Negative
      droops, which is what a willowy branch or a dead one does */
  rise?: number
  /** first-level limb length, as a fraction of the trunk height */
  len?: number
  /** per-level length multiplier */
  shrink?: number
  /** per-level radius multiplier. The default is da Vinci's rule for two
      children — a fork keeps its cross-sectional area, so each child is
      1/sqrt(splits) of its parent — which is why a tree tapers the way it does */
  thin?: number
  /** vertical ridge depth around the circumference */
  ridge?: number
  /** radial segments in the trunk; every level up is one fewer */
  sides?: number
  /** override the trunk's station list (a palm's long curve needs more) */
  ts?: number[]
  /** how far below the origin the trunk starts, so the flare is buried */
  sink?: number
}

export interface Wood {
  geo: THREE.BufferGeometry
  /** the end of every limb the growth stopped on: where a crown lobe belongs */
  tips: Array<[x: number, y: number, z: number]>
  /** every fork point above the first, for filling the middle of a crown */
  forks: Array<[x: number, y: number, z: number]>
  /** the top of the trunk itself, for kits that stack something on it */
  top: [x: number, y: number, z: number]
}

/**
 * Grow one woody skeleton and return it as a single geometry.
 *
 * Limbs are not butted end to end: each child starts a tenth of the way back
 * inside its parent and is never wider than the parent is there, so the tubes
 * interpenetrate. Everything here is opaque and closed around, which makes the
 * overlap invisible and saves stitching two rings of different radii and
 * different frames into one another — the palm's old stack of cylinders is
 * what that looks like when it goes wrong, and it took a three-fifths overlap
 * to stop reading as a mast snapped in three places.
 */
const wood = (seed: number, cfg: WoodCfg): Wood => {
  const {
    h, r, flare = 0.7, taper = 0.6, lean = 0.05, levels = 2, splits = 2,
    spread = 0.7, rise = 0.3, len = 0.58, shrink = 0.7,
    thin = 1 / Math.sqrt(splits), ridge = 0.09, sides = 5, ts = T_TRUNK,
    sink = 0.45,
  } = cfg
  const rnd = rng32(seed)
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  const tips: Wood['tips'] = []
  const forks: Wood['forks'] = []
  let top: Wood['top'] = [0, h, 0]
  const leanAz = rnd() * Math.PI * 2

  const limb = (
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    L: number, r0: number, level: number,
  ) => {
    const last = level >= levels
    const cut = level === 0 ? ts : level === 1 ? T_LIMB : T_TWIG
    const r1 = last ? 0 : r0 * taper
    // the trunk drifts sideways; a limb curves back up toward the light
    const cx = level === 0 ? Math.cos(leanAz) * lean * L : 0
    const cy = level === 0 ? 0 : rise * L
    const cz = level === 0 ? Math.sin(leanAz) * lean * L : 0
    const st: Station[] = cut.map((t) => ({
      x: ox + dx * L * t + cx * t * t,
      y: oy + dy * L * t + cy * t * t,
      z: oz + dz * L * t + cz * t * t,
      // the flare is a swell over the bottom fifth of the trunk only — above
      // that a tree is a taper, and a flare that reaches any higher reads as
      // a traffic cone
      r: (r0 + (r1 - r0) * t) *
        (level === 0 ? 1 + flare * Math.pow(Math.max(0, 1 - t / 0.22), 1.8) : 1),
    }))
    sweep(pos, nor, idx, st, Math.max(3, sides - level), level === 0 ? ridge : ridge * 0.5,
      seed * 0.37 + level * 2.1)
    const e = st[st.length - 1]
    if (level === 0) top = [e.x, e.y, e.z]
    if (last) {
      tips.push([e.x, e.y, e.z])
      return
    }
    if (level > 0) forks.push([e.x, e.y, e.z])
    // start the children back inside the parent, at the radius it has there
    const s9 = 0.9
    const sx = ox + dx * L * s9 + cx * s9 * s9
    const sy = oy + dy * L * s9 + cy * s9 * s9
    const sz = oz + dz * L * s9 + cz * s9 * s9
    const rs = (r0 + (r1 - r0) * s9) * thin
    // a frame around the parent's own direction, so a fork spreads about the
    // limb it grows from rather than about the world's vertical
    const d = new THREE.Vector3(dx, dy, dz).normalize()
    const ref = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const u = new THREE.Vector3().crossVectors(d, ref).normalize()
    const w = new THREE.Vector3().crossVectors(d, u)
    const phi = rnd() * Math.PI * 2
    const child = new THREE.Vector3()
    for (let i = 0; i < splits; i++) {
      const az = phi + (i / splits) * Math.PI * 2 + (rnd() - 0.5) * 0.7
      const sp = spread * (0.7 + rnd() * 0.6)
      child.copy(d).multiplyScalar(Math.cos(sp))
        .addScaledVector(u, Math.sin(sp) * Math.cos(az))
        .addScaledVector(w, Math.sin(sp) * Math.sin(az))
        .normalize()
      limb(sx, sy, sz, child.x, child.y, child.z,
        L * (level === 0 ? len : shrink) * (0.82 + rnd() * 0.36), rs, level + 1)
    }
  }

  limb(0, -sink, 0, 0, 1, 0, h + sink, r, 0)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  geo.setIndex(idx)
  return { geo, tips, forks, top }
}

// shared primitives; every kit is these under a transform. The conifer tiers
// are open-ended: three builds a cap as a fan of centre vertices per segment,
// which nearly triples a six-sided cone for a disc that is always buried in
// foliage.
/** squatter lumps for undergrowth and stone */
const NUB = [ball(11, 6, 3), ball(12, 6, 3), ball(13, 6, 3)]
/** the same lumps flat-shaded, for rock: a stylized stone is faceted, and a
    smooth-shaded one reads as a moss ball whatever it is painted */
const FACET = NUB.map((g) => {
  const f = g.toNonIndexed()
  f.computeVertexNormals()
  return f
})
const CONE = new THREE.ConeGeometry(0.5, 1, 7, 1, true)
CONE.translate(0, 0.5, 0)
/** a unit box with its origin at the bottom face, so a scale is a height */
const SLAB = new THREE.BoxGeometry(1, 1, 1)
SLAB.translate(0, 0.5, 0)

/**
 * A drooping leaf blade: unit length along +z, tapering and bending down,
 * with a raised ridge down the middle so it is a shallow V rather than a
 * sheet. Palm fronds and reeds were boxes before, and a box catches the light
 * as three flat planes — a palm looked like a hat rack.
 *
 * Every triangle is emitted twice, wound both ways. The chunk material is
 * FrontSide (the whole world is closed solids, and turning it double-sided
 * would double the fill cost of a forest), so a one-sided frond is invisible
 * from underneath — which is exactly where you stand when you look at a palm.
 * Doubling the index costs no vertices at all, and the back faces taking the
 * front's upward normals is a feature: foliage lit from above from both sides
 * is what every stylized tree does on purpose.
 */
const BLADE = (() => {
  const rows = 5
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1)
    const w = 0.5 * (1 - t * t * 0.8)
    const droop = -t * t * 0.5
    // left edge, centre ridge, right edge
    pos.push(-w, droop, t, 0, droop + 0.16 * (1 - t * 0.6), t, w, droop, t)
  }
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 3
    for (const [p, q, r, s] of [[a, a + 3, a + 4, a + 1], [a + 1, a + 4, a + 5, a + 2]]) {
      idx.push(p, q, r, p, r, s)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setIndex(idx)
  // normals come from the front faces alone — averaging in the mirrored set
  // would cancel them to zero and light the frond black
  g.computeVertexNormals()
  const back: number[] = []
  for (let i = 0; i < idx.length; i += 3) back.push(idx[i], idx[i + 2], idx[i + 1])
  g.setIndex([...idx, ...back])
  return g
})()

/* --------------------------------------------------------------- kits -- */

/*
  A note on scale, since every number below depends on it: the eye stands at
  about 3.55 units, so a canopy has to be centred near 7 with its underside
  clear of 4.5 or the player walks through the leaves instead of under them.
  The first cut of these kits put broadleaf canopies at 4.2 and the result was
  a forest you wear rather than one you walk in. Trunks carry most of the
  height now, and the instance scale ranges in biomes.ts were narrowed to
  match — a tree that varies 2x in size reads as two different species.
*/

/**
 * The crown that hangs on a skeleton: one lobe of radius `r` per limb tip,
 * jittered so it is not a row of identical beads, plus one `mid`-scaled lobe
 * slung under their centroid to close the middle.
 *
 * One lobe per tip and no more, deliberately. Lobing every fork as well is the
 * obvious thing to do and it doubled the card count of a broadleaf — and card
 * count is *fill* cost, paid over the whole silhouette of a forest, which is
 * the one budget in this file worth defending. The tips alone place four
 * canopy masses where the branches actually reach, which is the entire point;
 * a fifth in the middle is what stops them reading as four separate bushes.
 */
const crown = (w: Wood, r: number, mid = 1): Lobe[] => {
  const lobes: Lobe[] = w.tips.map(([x, y, z], i) =>
    [x, y, z, r * (0.84 + ((i * 7) % 5) * 0.08)])
  if (mid > 0 && w.tips.length > 1) {
    const n = w.tips.length
    let cx = 0
    let cy = 0
    let cz = 0
    for (const [x, y, z] of w.tips) {
      cx += x / n
      cy += y / n
      cz += z / n
    }
    lobes.push([cx, cy - r * 0.34, cz, r * mid])
  }
  return lobes
}

const broadleaf = (v: number, vi: number): Kit => {
  const h = 9.6 + v * 2.6
  // a trunk to a third of the height, then two forks: the crown ends up
  // between 5 and 11 units, which is the band a 3.55-unit eye reads as
  // "under a tree" rather than "inside a hedge"
  const w = wood(0xb1a5 + vi * 977, {
    h: h * 0.38, r: 0.44 + v * 0.06, flare: 0.8, taper: 0.66,
    lean: 0.06 + v * 0.05, levels: 2, splits: 2,
    spread: 0.46, rise: 0.6, len: 0.74, shrink: 0.7, ridge: 0.11, sides: 6,
  })
  own(w.geo, 'bark')
  // no opaque core. It went through two shapes (octagon, then a smooth ball)
  // and both ended the same way: any gap in the cards framed a solid dark
  // sphere, which reads worse than the sky it was hiding. The painted-tree
  // demos this look chases let light through their crowns on purpose —
  // density does the work now, not a plug
  push(cards(11 + vi * 31, crown(w, 1.98, 1.2)), 'card', at(0, 0, 0))
  return drain({ r: 0.62, h: h * 0.6 }, h + 2.8)
}

/** birch bark is white wherever a birch grows, so it is painted here rather
    than drawn from the biome's `accent` — which also has to be stone in the
    tundra and sand on the beach, and made every birch outside a forest the
    colour of whatever else that biome needed a third colour for */
const BIRCH_BARK = new THREE.Color('#cfcdc2')

const birch = (v: number, vi: number): Kit => {
  const h = 10.6 + v * 2.2
  // slim, barely tapered, and it keeps a leader: a birch forks high and
  // shallow, so the white pole stays the thing you see
  const w = wood(0x81c4 + vi * 653, {
    h: h * 0.58, r: 0.19 + v * 0.03, flare: 0.5, taper: 0.78,
    lean: 0.05, levels: 2, splits: 2, spread: 0.34, rise: 0.55,
    len: 0.36, shrink: 0.7, ridge: 0.05, sides: 5, sink: 0.3,
  })
  own(w.geo, 'accent', { tint: BIRCH_BARK, surf: SURF.birch })
  push(cards(23 + vi * 37, crown(w, 1.62, 1.15)), 'card', at(0, 0, 0))
  return drain({ r: 0.46, h: h * 0.72 }, h + 2.2)
}

const pine = (v: number, vi: number): Kit => {
  const h = 11.5 + v * 4.5
  // a conifer keeps one leader all the way up, so this is a bare swept pole:
  // flared at the root, tapering hard, and running past the second tier where
  // the foliage takes over
  const w = wood(0x9c07 + vi * 401, {
    h: h * 0.5, r: 0.34 + v * 0.05, flare: 0.9, taper: 0.42,
    lean: 0.03, levels: 0, ridge: 0.13, sides: 6,
  })
  own(w.geo, 'bark')
  // four tiers, each rotated off the last. The cone is only the opaque core
  // now; the branches around it are near-horizontal card fans — the pineLeaf
  // construction from cortiz2894/stylized-components, merged instead of
  // instanced — so a conifer's silhouette is drooping foliage, not a stack
  // of clean triangles
  const tier = [
    [0.3, 3.9, 0.34], [0.5, 3.1, 0.3], [0.68, 2.3, 0.27], [0.84, 1.4, 0.22],
  ] as const
  const lobes: Lobe[] = []
  tier.forEach(([ty, r, th], i) => {
    const tx = (i % 2 ? 0.18 : -0.14) * (1 + v)
    const tz = (i % 2 ? -0.12 : 0.16) * (1 + v)
    push(CONE, 'leaf', at(tx, h * ty, tz, r * 0.55, h * th, r * 0.55, i * 1.1))
    lobes.push([tx, h * ty + h * th * 0.3, tz, r * 0.52])
  })
  // tilted well off horizontal, like the acacia's: a conifer's foliage does
  // droop, but cards laid perfectly flat present their edges to a walker and
  // the tiers end up ringed with dark dashes instead of needles
  push(cards(67 + vi * 29, lobes, true, 0.95), 'card', at(0, 0, 0))
  return drain({ r: 0.55, h: h * 0.42 }, h + 1)
}

/** the palm's long curve wants stations spread up the whole trunk, not
    clustered at a root flare it barely has */
const T_PALM = [0, 0.07, 0.2, 0.36, 0.54, 0.74, 1]

const palm = (v: number, vi: number): Kit => {
  const h = 9.4 + v * 2.6
  // one swept tube along a curve, where this used to be six cylinders walking
  // sideways with a three-fifths overlap between them: butted straight
  // segments left gaps you could see through, and a palm with holes in it
  // reads as a broken mast. A sweep has no seams to hide and costs a third of
  // what the stack did
  const w = wood(0x9a1f + vi * 811, {
    h, r: 0.33, flare: 0.55, taper: 0.62, lean: 0.16 + v * 0.12,
    levels: 0, ridge: 0.07, sides: 6, ts: T_PALM, sink: 0.3,
  })
  own(w.geo, 'bark')
  const [tx, , tz] = w.top
  push(NUB[0], 'bark', at(tx, h - 0.45, tz, 1.0, 0.9, 1.0))
  for (let f = 0; f < 8; f++) {
    const a = (f / 8) * Math.PI * 2 + v
    push(
      BLADE,
      'leaf',
      new THREE.Matrix4().compose(
        new THREE.Vector3(tx, h - 0.1, tz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.28 + (f % 2) * 0.22, -a, 0, 'YXZ')),
        new THREE.Vector3(2.2, 2.4, 5.2),
      ),
    )
  }
  return drain({ r: 0.5, h: h * 0.55 }, h + 1)
}

const acacia = (v: number, vi: number): Kit => {
  const h = 8.0 + v * 2.2
  // the shape that makes a savanna read as a savanna is as much the trunk as
  // the parasol: a short bole that splits low and wide into limbs that lean
  // right out to the rim of the canopy, so the crown is held up at its edges
  const w = wood(0xacac + vi * 577, {
    h: h * 0.34, r: 0.42, flare: 0.95, taper: 0.7, lean: 0.09,
    levels: 2, splits: 2, spread: 0.84, rise: 0.14,
    len: 1.05, shrink: 0.7, ridge: 0.1, sides: 6,
  })
  own(w.geo, 'bark')
  // layered near-horizontal cards, no slab — the parasol reads through its gaps
  const lobes = crown(w, 2.3, 1.4)
  // and it is flat: every lobe is pulled to the same height, which is the one
  // thing an acacia's canopy does that no other tree's does
  const flatY = lobes.reduce((a, l) => a + l[1], 0) / lobes.length
  for (const l of lobes) l[1] = flatY + (l[1] - flatY) * 0.6
  push(cards(37 + vi * 43, lobes, true, 1.35), 'card', at(0, 0, 0))
  return drain({ r: 0.56, h: h * 0.72 }, h + 1.0)
}

const deadtree = (v: number, vi: number): Kit => {
  const h = 6.6 + v * 2.2
  // a snag: the limbs droop instead of reaching (negative rise), fork three
  // ways and end in points, which is the whole silhouette — there is no
  // canopy here to cover for it
  const w = wood(0xdead + vi * 733, {
    h: h * 0.52, r: 0.4, flare: 1.0, taper: 0.6, lean: 0.11,
    levels: 2, splits: 3, spread: 0.78, rise: -0.1,
    len: 0.6, shrink: 0.46, thin: 0.62, ridge: 0.16, sides: 5,
  })
  own(w.geo, 'bark')
  return drain({ r: 0.5, h: h * 0.8 }, h)
}

const cactus = (v: number): Kit => {
  const h = 4.2 + v * 2.2
  push(SLAB, 'leaf', at(0, 0, 0, 0.95, h, 0.95))
  push(NUB[2], 'leaf', at(0, h - 0.24, 0, 0.95, 0.72, 0.95))
  push(SLAB, 'leaf', at(-1.0, h * 0.42, 0, 1.5, 0.6, 0.6))
  push(SLAB, 'leaf', at(-1.35, h * 0.42, 0, 0.6, 2.0, 0.6))
  if (v > 0.4) {
    push(SLAB, 'leaf', at(1.0, h * 0.58, 0, 1.4, 0.6, 0.6))
    push(SLAB, 'leaf', at(1.3, h * 0.58, 0, 0.6, 1.6, 0.6))
  }
  return drain({ r: 0.7, h: h * 0.85 }, h)
}

const bush = (v: number): Kit => {
  // lobes ride high enough that no card can dip underground: a bush whose
  // cards clip into the lawn reads as shredded paper dropped on it
  push(cards(53 + Math.floor(v * 90), [
    [0, 1.05, 0, 1.0],
    [0.8 - v * 1.3, 0.9, 0.55, 0.72],
    [-0.6 + v, 0.95, -0.6, 0.62],
  ]), 'card', at(0, 0, 0))
  return drain({ r: 1.0, h: 1.5 }, 2.2)
}

const shrub = (v: number): Kit => {
  push(NUB[0], 'leaf', at(0, 0.52, 0, 1.6 + v * 0.4, 1.1, 1.5))
  push(NUB[2], 'leaf', at(0.5 - v * 0.7, 0.36, -0.35, 1.0, 0.75, 1.0))
  return drain(null, 1.2)
}

const rock = (v: number): Kit => {
  push(FACET[1], 'accent', at(0, 0.34, 0, 1.8 + v, 1.1 + v * 0.5, 1.6, v * 3))
  return drain(null, 1.1)
}

const boulder = (v: number): Kit => {
  push(FACET[0], 'accent', at(0, 1.0, 0, 4.2 + v * 1.6, 2.5, 3.7, v * 2))
  push(FACET[2], 'accent', at(1.5, 0.5, -0.9, 2.1, 1.3, 1.9, v))
  return drain({ r: 1.9, h: 2.0 }, 2.6)
}

/** a fistful of blades, each a drooping leaf rather than a stick — a marsh is
    mostly this, so it is worth the eight extra vertices apiece */
const reed = (v: number): Kit => {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + v * 3
    push(BLADE, 'leaf', new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(1.34 + (i % 2) * 0.14, -a, 0, 'YXZ')),
      new THREE.Vector3(0.42, 1, 2.6 + v * 0.9),
    ))
  }
  return drain(null, 2.6)
}

/**
 * A clump of grass, for the mid distance where the real blade field
 * (world/grass.ts) has already faded out. Three squashed lumps rather than the
 * pair of crossed cards this started as: cards were cheaper by a few vertices
 * and looked it, turning edge-on into thin dark slivers that littered every
 * meadow with what read as scorch marks.
 */
const tuft = (v: number): Kit => {
  push(NUB[0], 'leaf', at(0, 0.18, 0, 1.15 + v * 0.35, 0.66, 1.0))
  push(NUB[2], 'leaf', at(0.36 - v * 0.6, 0.13, 0.24, 0.78, 0.5, 0.72))
  push(NUB[1], 'leaf', at(-0.3 + v * 0.4, 0.11, -0.26, 0.62, 0.42, 0.6))
  return drain(null, 0.6)
}

const MAKERS: Record<PropKind, (v: number, vi: number) => Kit> = {
  broadleaf, birch, pine, palm, acacia, deadtree, cactus,
  bush, shrub, rock, boulder, reed, tuft,
}

/**
 * How many shapes there are of each kind. It was three, back when a variant
 * changed only a height and a couple of lobe offsets and a fourth would have
 * been the same tree again. Now that the skeleton is seeded per variant, each
 * one is a genuinely different tree, and six of them is what stops a forest
 * from reading as a pattern — the cost is the kit geometry alone, built once
 * per kind that is actually used and shared by every instance of it.
 */
export const VARIANTS = 6

/** the variants of a kind, built once. Kit geometry is never disposed: it is
    the source every chunk stamps from, not something a chunk owns. */
const KITS: Partial<Record<PropKind, Kit[]>> = {}

export const kitsFor = (kind: PropKind): Kit[] => {
  let k = KITS[kind]
  if (!k) {
    k = Array.from({ length: VARIANTS }, (_, i) =>
      MAKERS[kind](0.12 + (i / (VARIANTS - 1)) * 0.76, i))
    KITS[kind] = k
  }
  return k
}

/** deterministic variant choice for an instance */
export const variantFor = (kind: PropKind, gx: number, gz: number, i: number) =>
  Math.floor(rand3(gx, gz, i, kind.length * 7919 + 0x31) * VARIANTS) % VARIANTS

/* -------------------------------------------------------------- stamp -- */

const tmpM = new THREE.Matrix4()
const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpP = new THREE.Vector3()
const tmpS = new THREE.Vector3()
const tmpC = new THREE.Color()

/**
 * Stamp one instance of a kit into a builder. `jitter` (-1..1) shifts every
 * painted colour by the same small amount, which is what stops a stand of
 * pines from looking like one tree photocopied.
 *
 * The shift is multiplicative, and that is not a style choice. It was an
 * `offsetHSL(_, _, jitter * 0.07)` first, which turned half of every forest
 * pure black: Color.getHSL reports lightness in the renderer's *linear*
 * working space, not in sRGB, and a trunk at #4a3826 sits at l = 0.044 there.
 * Subtracting 0.07 from that clamps to zero. Scaling can't reach black from a
 * non-black colour no matter what the working space is.
 */
export const stampKit = (
  out: MeshBuilder,
  cardOut: MeshBuilder,
  kit: Kit,
  pal: Palette,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  jitter: number,
) => {
  tmpQ.setFromEuler(tmpE.set(0, yaw, 0))
  tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.setScalar(scale))
  const k = 1 + jitter * 0.2
  // foliage sways from the ground up; bark does not. A trunk that bends with
  // its canopy reads as rubber, and the canopy's own weight already runs from
  // 0 at the ground to 1 at the crown, so a tree bends where a tree bends
  const tall = kit.height * scale
  const span = { base: y, span: tall }
  // and it is shaded the same way it is lit: the underside of a crown sees
  // only bounce, the top sees the sky. Baked per vertex at stamp time, which
  // is the cheapest ambient occlusion there is. Ground-hugging kits (tufts,
  // shrubs, bushes) ease off the dark end: a knee-high clump lives entirely
  // in the "underside" of its own ramp, and a lawn full of them read as
  // scattered lumps of coal
  const lo = kit.height < 2.6 ? 0.84 : 0.6
  const shade = { base: y + tall * 0.3, span: tall * 0.72, lo, hi: 1.14 }
  for (const p of kit.parts) {
    const card = p.slot === 'card'
    const c = p.tint ?? (card ? pal.leaf : pal[p.slot as keyof Palette])
    // the per-channel skew is the hue variation the HSL version used to give
    tmpC.setRGB(c.r * (k + jitter * 0.04), c.g * k, c.b * (k - jitter * 0.04))
    const leaf = card || p.slot === 'leaf'
    // cards go to the chunk's UV-carrying builder, whose material samples the
    // painted leaf texture; everything else merges into the plain soup
    const target = card ? cardOut : out
    target.surface = p.surf ?? (leaf ? SURF.none : SURF.bark)
    target.add(p.geo, tmpM, tmpC, leaf ? span : undefined, leaf ? shade : undefined)
    target.surface = SURF.none
  }
}
