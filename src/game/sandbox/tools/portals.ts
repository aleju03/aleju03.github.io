import * as THREE from 'three'
import type { CollisionSet, Solid } from '../../physics/collision'
import type { Prop, Sandbox } from '../sandbox'

/*
  The portals: two holes in the world, a blue one and an orange one, and
  whatever goes into one comes out of the other. Headless like the physgun
  and the tool gun: this module places them, answers the walker's and the
  props' questions about them and carries things through, and knows nothing
  about how a portal is drawn (portalView.ts) or what the gun looks like
  (viewmodel.ts). The belt fires it; CrtScene asks it about the walker.

  **Placing one** is a ray, then a fit, and both answer to what is *drawn*.
  The ray is cast against the walk's own world (the level's collision
  boxes, its ground, the props, the sea) because that is cheap, but a
  collision box is not a surface: lamp posts wear guard boxes, buildings
  stand broad-phase boxes proud of their walls and past their corners, and a
  portal fitted to one of those hung in the air. So the drawn meshes round
  the hit are felt for along the ray (`soupAround`: the few hundred
  triangles there, flattened once per shot), and a box with nothing drawn
  near its face is set aside and the ray goes on. A prop or the sea fizzles
  the shot, the way Portal will not open a hole in a cube. The fit is
  Portal's: the whole oval has to lie on that drawn surface, so seventeen
  short rays down the normal from its rim and middle must each meet a facet
  facing the same way, and all of them one plane within four centimetres;
  the oval then sits on that plane, two centimetres proud. A shot near an
  edge is nudged inward to the nearest place it fits, a shot at a wall a
  little above the floor slides down until the oval stands on the floor (a
  doorway you can walk through, not a window you have to jump at), a floor
  or ceiling portal is turned so its top points the way you were looking,
  and anything that cannot fit near where it landed fizzles: a lamp post, a
  corner, ground that rolls under it. Headless there is nothing drawn, and
  the boxes and the ground function stand in for the surface.

  **The pair's transform** is the whole trick. Each portal is a frame: right,
  up and the normal out of the surface, at its centre. Going in one is going
  out of the other turned half round its up axis, so the map from the blue
  side to the orange is `orange * flip * blue^-1`, and the same matrix
  carries a point, a velocity and a gaze. That is what makes momentum carry:
  fall into a floor portal at thirty units a second and the fall comes out of
  a wall portal as thirty units a second of flight.

  **The walker** is a point body in a world of boxes, so walking into a wall
  needs the wall to get out of the way. While the body's centre is in front
  of an open portal and inside its oval (`aperture`), the boxes the portal
  lies on are marked `through` and every collision query skips them for that
  frame; over a floor portal on the terrain `hole` answers "no ground here".
  The crossing is then a segment test: the body's centre, and its eye, from
  last frame to this one, through the plane inside the oval. Whichever
  crosses first carries the body, and the walker comes out upright with its
  gaze and its velocity turned by the pair (Portal rolls the view back level
  after a floor-to-wall trip; a walker that never rolls simply is level).

  **Props** go through by touch, not by passing into the surface: a Rapier
  body cannot enter the wall the portal is on, so each fixed slice any
  awake prop whose centre is over an oval, moving into it and closer than
  its own half-depth along the normal, is moved out of the partner with its
  orientation, velocity and spin turned by the pair and set down clear of
  the exit's own surface. A prop resting on a floor portal falls in (gravity
  is the "moving into it" there), which is how a crate dropped between two
  floor portals falls for ever. What does not go through: a prop held on
  the physgun, a frozen or parked one, and anything crossing into another
  level (props belong to their level's sandbox).

  A portal belongs to the level it was opened in, and the pair may span two
  (the Moon: `placeAt` opens one on a fixed spot there). Whether a crossing
  may change level is the caller's business, which is the one place that can
  run a level change.
*/

export type PortalColor = 0 | 1
/** the opening's half-width and half-height: a little taller than a body,
    and narrow enough to fit on a door (the house's are 2.1 by 4.7) */
export const PORTAL_HW = 0.95
export const PORTAL_HH = 2.25
/** how far the gun reaches */
export const PORTAL_RANGE = 420
/** the walker's centre over its soles: the point that is carried through */
export const PORTAL_BODY_MID = 2.05

/** what a level looks like to the gun, asked live on every shot */
export interface PortalWorld {
  level: string
  collision: CollisionSet
  /** the ground under (x, z), where the level has terrain */
  groundAt?: (x: number, z: number) => number
  groundY: number
  waterY?: number
  sandbox: Sandbox | null
  /** the drawn meshes whose bounds reach within `r` of a point. Collision
      boxes stand a shoulder's width proud of the walls they wrap and can
      run past a building's corner, so a portal on a box is also fitted to
      the wall you can see (see `soupAround`); without this it sits on the
      box */
  meshesNear?: (at: THREE.Vector3, r: number) => readonly THREE.Mesh[]
  /** the first drawn mesh of the furnished house along a ray (a door leaf,
      a mattress, a wardrobe: nothing there has a collision face to find it
      by). A portal fitted to one rides it */
  drawnHit?: (o: THREE.Vector3, d: THREE.Vector3, max: number) =>
    { t: number; normal: THREE.Vector3; object: THREE.Object3D } | null
}

/** what a portal rides: a drawn object of the house (a swinging door leaf),
    or a sandbox prop; `local` is the portal's frame in the anchor's */
export type PortalAnchor =
  | { kind: 'object'; obj: THREE.Object3D; local: THREE.Matrix4 }
  | { kind: 'prop'; sb: Sandbox; id: number; local: THREE.Matrix4 }

export interface Portal {
  readonly color: PortalColor
  /** the level it was opened in */
  level: string
  /** centre (a hair off the surface), normal out of it, and its up and right */
  pos: THREE.Vector3
  n: THREE.Vector3
  up: THREE.Vector3
  right: THREE.Vector3
  /** the collision boxes it lies on: they stop being walls where it is */
  hosts: Solid[]
  /** it lies on the level's ground function */
  ground: boolean
  /** how far in front of the oval the collision surface under it stands
      (the box's shoulder pad): a prop pressed to the wall is this far off */
  inset: number
  /** false while the far side is still being made (the Moon's ground):
      a portal that is not ready shows its swirl and leads nowhere */
  ready: boolean
  /** what it rides, if anything moves under it (see `follow`) */
  anchor: PortalAnchor | null
  /** how far in front of the oval the walker is let through: a prop holds
      the walker off by its radius, so a portal on one is crossed there */
  skin: number
  /** a fixed spot's id (the Moon's), when it is one */
  site: string | null
  /** seconds since it opened, for the view's opening */
  age: number
  /** columns right, up, n, pos, and its inverse */
  basis: THREE.Matrix4
  inv: THREE.Matrix4
}

export type PortalFail = 'miss' | 'surface' | 'prop' | 'water'
export interface PortalShot {
  ok: boolean
  color: PortalColor
  /** where the shot landed (the portal's centre when it opened) */
  point: THREE.Vector3
  normal: THREE.Vector3
  reason?: PortalFail
}

export type PortalEventType = 'open' | 'fizzle' | 'close' | 'pass'
export interface PortalEvent {
  type: PortalEventType
  color: PortalColor
  point: THREE.Vector3
  /** 'pass': a prop id, or -1 for the walker */
  prop: number
}

/** a crossing: which portal was entered, and the partner it leads out of */
export interface PortalCrossing {
  from: Portal
  to: Portal
}

export interface Portals {
  /** [blue, orange] */
  readonly list: readonly (Portal | null)[]
  /** fire one colour down a ray; opens it or fizzles */
  fire: (color: PortalColor, eye: THREE.Vector3, dir: THREE.Vector3, world: PortalWorld) => PortalShot
  /** open one on a known frame (a fixed spot), replacing whatever it was */
  placeAt: (color: PortalColor, level: string, pos: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3, site?: string | null, hosts?: Solid[]) => Portal
  /** close one colour, or both */
  close: (color?: PortalColor) => void
  /** the other one, if open */
  partner: (p: Portal) => Portal | null
  /** the map from `from`'s side to its partner's (point, velocity, gaze) */
  transform: (from: Portal, out: THREE.Matrix4) => THREE.Matrix4
  /** open portals in `level` that have a partner somewhere */
  linkedIn: (level: string) => Portal[]
  /** is any linked portal open in `level` (allocation-free, for the frame) */
  anyIn: (level: string) => boolean
  tick: (dt: number) => void
  /** mark the boxes under an open portal the body is standing in front of
      (see the header); clears last frame's marks first */
  aperture: (level: string, center: THREE.Vector3) => void
  /** is there a floor portal on the ground at (x, z) */
  hole: (level: string, x: number, z: number) => boolean
  /** did the segment a0 -> a1 go into an open portal of `level` */
  crossing: (level: string, a0: THREE.Vector3, a1: THREE.Vector3) => PortalCrossing | null
  /** once per fixed slice of `sb`: carry props through. `held` is skipped */
  carryProps: (sb: Sandbox, level: string, held: number | null) => void
  on: (fn: (e: PortalEvent) => void) => () => void
  /** bumped whenever a portal opens or closes */
  readonly version: number
  /** why the last shot fizzled, in a word or two (for a harness) */
  readonly why: string
  /**
   * The first open oval of `level` a ray meets, front side on, within
   * `reach`: how far along it is, where, and the ray carried out of its
   * partner (a point on the far side is `M * (eye + dir * t)` for any t
   * past the oval). Null when no oval is on the ray.
   */
  rayEnters: (level: string, eye: THREE.Vector3, dir: THREE.Vector3, reach: number) =>
    { t: number; at: THREE.Vector3; from: Portal; to: Portal; M: THREE.Matrix4 } | null
  /** once a frame: a portal riding a door or a prop is moved with it, and
      one whose prop has gone is closed */
  follow: () => void
  /** the opening's half-extents (for the scene, which cannot import them) */
  readonly hw: number
  readonly hh: number
}

/* ------------------------------------------------------------ geometry -- */

const FLIP = new THREE.Matrix4().makeRotationY(Math.PI)

const setBasis = (p: Portal) => {
  p.basis.makeBasis(p.right, p.up, p.n).setPosition(p.pos)
  p.inv.copy(p.basis).invert()
}

/** inside the oval, in its own units: (x/HW)^2 + (y/HH)^2 */
export const ovalR = (x: number, y: number) => (x / PORTAL_HW) ** 2 + (y / PORTAL_HH) ** 2

const tv = new THREE.Vector3()
/** a point in a portal's frame: x right, y up, z out of the surface */
export const toPortal = (p: Portal, at: THREE.Vector3, out: THREE.Vector3) => {
  tv.subVectors(at, p.pos)
  return out.set(tv.dot(p.right), tv.dot(p.up), tv.dot(p.n))
}

/* ------------------------------------------------------------ the rays -- */

interface Hit {
  t: number
  normal: THREE.Vector3
  box: Solid | null
  ground: boolean
}

/** a ray against one box: the entry distance and the face it came in by, or
    0 when the origin is inside it (a wall standing where the ray starts is a
    wall in the way). Infinity for a miss */
const rayBox = (o: THREE.Vector3, d: THREE.Vector3, b: THREE.Box3, n: THREE.Vector3) => {
  let tmin = -Infinity
  let tmax = Infinity
  let axis = -1
  let sign = 0
  for (let k = 0; k < 3; k++) {
    const ok = o.getComponent(k)
    const dk = d.getComponent(k)
    const lo = b.min.getComponent(k)
    const hi = b.max.getComponent(k)
    if (Math.abs(dk) < 1e-9) {
      if (ok < lo || ok > hi) return Infinity
      continue
    }
    let t0 = (lo - ok) / dk
    let t1 = (hi - ok) / dk
    let s = -1
    if (t0 > t1) {
      const tt = t0
      t0 = t1
      t1 = tt
      s = 1
    }
    if (t0 > tmin) {
      tmin = t0
      axis = k
      sign = s
    }
    if (t1 < tmax) tmax = t1
    if (tmin > tmax) return Infinity
  }
  if (tmax < 0) return Infinity
  if (tmin < 0) {
    n.set(0, 0, 0)
    return 0
  }
  n.set(0, 0, 0).setComponent(axis, sign)
  return tmin
}

const gNormal = (g: (x: number, z: number) => number, x: number, z: number, out: THREE.Vector3) => {
  const e = 0.3
  return out.set(g(x - e, z) - g(x + e, z), 2 * e, g(x, z - e) - g(x, z + e)).normalize()
}

const bn = new THREE.Vector3()
const hitAt = new THREE.Vector3()

/** the first box or ground along a ray, within `max` */
const castWorld = (
  o: THREE.Vector3, d: THREE.Vector3, max: number, boxes: readonly Solid[], world: PortalWorld, out: Hit,
): boolean => {
  let best = max
  let found = false
  for (const b of boxes) {
    // a moving machine is no surface for a hole, and a retired door or a
    // felled tree has collapsed its box to a point
    if (b.hull || b.max.x <= b.min.x || b.max.y <= b.min.y || b.max.z <= b.min.z) continue
    const t = rayBox(o, d, b, bn)
    if (t < best) {
      best = t
      found = true
      out.t = t
      out.normal.copy(bn)
      out.box = b
      out.ground = false
    }
  }
  // the ground: marched in growing steps and bisected where it is crossed
  const g = world.groundAt
  const gy = (x: number, z: number) => (g ? g(x, z) : world.groundY)
  let prevT = 0
  let h0 = o.y - gy(o.x, o.z)
  if (h0 < 0) {
    if (0 < best) {
      out.t = 0
      out.normal.set(0, 1, 0)
      out.box = null
      out.ground = true
      return true
    }
    return found
  }
  let t = 0
  while (t < best) {
    t = Math.min(best, t + 0.35 + t * 0.015)
    hitAt.copy(o).addScaledVector(d, t)
    const h = hitAt.y - gy(hitAt.x, hitAt.z)
    if (h < 0) {
      let a = prevT
      let c = t
      for (let i = 0; i < 14; i++) {
        const m = (a + c) / 2
        hitAt.copy(o).addScaledVector(d, m)
        if (hitAt.y - gy(hitAt.x, hitAt.z) < 0) c = m
        else a = m
      }
      const tt = (a + c) / 2
      if (tt < best) {
        hitAt.copy(o).addScaledVector(d, tt)
        out.t = tt
        if (g) gNormal(g, hitAt.x, hitAt.z, out.normal)
        else out.normal.set(0, 1, 0)
        out.box = null
        out.ground = true
        return true
      }
      break
    }
    h0 = h
    prevT = t
  }
  void h0
  return found
}

/* ------------------------------------------------ the drawn surface -- */

/** a ray caster over a flat list of world triangles (nine floats each) */
const makeSoup = (T: Float32Array, n: THREE.Vector3): Soup => {
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const p = new THREE.Vector3()
  const q = new THREE.Vector3()
  const t0 = new THREE.Vector3()
  const normal = new THREE.Vector3()
  let hitI = -1
  const cast = (o: THREE.Vector3, d: THREE.Vector3, max: number) => {
    let best: number | null = null
    hitI = -1
    for (let i = 0; i < T.length; i += 9) {
      // Moller-Trumbore, both windings
      e1.set(T[i + 3] - T[i], T[i + 4] - T[i + 1], T[i + 5] - T[i + 2])
      e2.set(T[i + 6] - T[i], T[i + 7] - T[i + 1], T[i + 8] - T[i + 2])
      p.crossVectors(d, e2)
      const det = e1.dot(p)
      if (Math.abs(det) < 1e-9) continue
      const inv = 1 / det
      t0.set(o.x - T[i], o.y - T[i + 1], o.z - T[i + 2])
      const u = t0.dot(p) * inv
      if (u < 0 || u > 1) continue
      q.crossVectors(t0, e1)
      const v = d.dot(q) * inv
      if (v < 0 || u + v > 1) continue
      const t = e2.dot(q) * inv
      if (t < 0 || t > max || (best !== null && t >= best)) continue
      best = t
      hitI = i
    }
    if (hitI >= 0) {
      const i = hitI
      e1.set(T[i + 3] - T[i], T[i + 4] - T[i + 1], T[i + 5] - T[i + 2])
      e2.set(T[i + 6] - T[i], T[i + 7] - T[i + 1], T[i + 8] - T[i + 2])
      normal.crossVectors(e1, e2).normalize()
      if (normal.dot(n) < 0) normal.negate()
    }
    return best
  }
  return { cast, normal }
}

/**
 * The same caster over a sandbox prop's box: its six faces where the body is
 * now. A prop is drawn from an instanced batch the drawn-surface pass skips,
 * and its collision box is its drawn shape near enough (a panel is exactly
 * one), so this is the surface a portal on it must fit.
 */
export const soupOfBox = (pos: THREE.Vector3, quat: THREE.Quaternion, ext: THREE.Vector3, n: THREE.Vector3): Soup => {
  const T: number[] = []
  const c = new THREE.Vector3()
  const corner = (sx: number, sy: number, sz: number) =>
    c.set(sx * ext.x, sy * ext.y, sz * ext.z).applyQuaternion(quat).add(pos).toArray()
  // each face as two triangles: axis k, side s
  for (let k = 0; k < 3; k++) {
    for (const s of [-1, 1]) {
      const q: number[][] = []
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const f = [0, 0, 0]
        f[k] = s
        f[(k + 1) % 3] = u
        f[(k + 2) % 3] = v
        q.push(corner(f[0], f[1], f[2]))
      }
      T.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3])
    }
  }
  return makeSoup(Float32Array.from(T), n)
}

/**
 * The drawn triangles of a few meshes that lie within a box round a point
 * and face along `n`, flattened into world space once per shot, so the
 * fit's two dozen rays test a few hundred triangles rather than a merged
 * chunk's hundred thousand each. `minCos` is how square to `n` a facet
 * must face to be kept. Returns a ray caster over them (distance to the
 * nearest, and that facet's normal turned toward `n`), or null when nothing
 * drawn is there.
 */
export interface Soup {
  /** the distance to the nearest facet along a ray, within `max`, or null */
  cast: (o: THREE.Vector3, d: THREE.Vector3, max: number) => number | null
  /** the last facet `cast` met, its unit normal (either winding) */
  readonly normal: THREE.Vector3
}

export const soupAround = (
  meshes: readonly THREE.Mesh[], at: THREE.Vector3, r: number, n: THREE.Vector3, minCos = 0.85,
): Soup | null => {
  const tris: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const fn = new THREE.Vector3()
  const inv = new THREE.Matrix4()
  const lc = new THREE.Vector3()
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!pos) continue
    const idx = m.geometry.getIndex()
    const count = idx ? idx.count : pos.count
    const mw = m.matrixWorld
    // the region in the mesh's own frame, so most triangles are refused on
    // raw coordinates without a matrix multiply (a merged chunk is mostly
    // somewhere else)
    inv.copy(mw).invert()
    lc.copy(at).applyMatrix4(inv)
    const lr = r / Math.max(1e-6, Math.cbrt(Math.abs(mw.determinant())))
    const px = pos.array as ArrayLike<number>
    const st = pos.itemSize
    const plain = !(pos as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !pos.normalized
    const X = (k: number) => (plain ? px[k * st] : pos.getX(k))
    const Y = (k: number) => (plain ? px[k * st + 1] : pos.getY(k))
    const Z = (k: number) => (plain ? px[k * st + 2] : pos.getZ(k))
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = idx ? idx.getX(i) : i
      const ib = idx ? idx.getX(i + 1) : i + 1
      const ic = idx ? idx.getX(i + 2) : i + 2
      const ax = X(ia), bx = X(ib), cx = X(ic)
      if (Math.max(ax, bx, cx) < lc.x - lr || Math.min(ax, bx, cx) > lc.x + lr) continue
      const ay = Y(ia), by = Y(ib), cy = Y(ic)
      if (Math.max(ay, by, cy) < lc.y - lr || Math.min(ay, by, cy) > lc.y + lr) continue
      const az = Z(ia), bz = Z(ib), cz = Z(ic)
      if (Math.max(az, bz, cz) < lc.z - lr || Math.min(az, bz, cz) > lc.z + lr) continue
      a.set(ax, ay, az).applyMatrix4(mw)
      b.set(bx, by, bz).applyMatrix4(mw)
      c.set(cx, cy, cz).applyMatrix4(mw)
      fn.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a))
      const len = fn.length()
      // facing the shot (either winding: a mesh may be drawn double-sided)
      if (len < 1e-9 || Math.abs(fn.dot(n)) / len < minCos) continue
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    }
  }
  if (!tris.length) return null
  return makeSoup(Float32Array.from(tris), n)
}

/* ----------------------------------------------------------- the module -- */

export function createPortals(): Portals {
  const list: (Portal | null)[] = [null, null]
  let version = 0
  const fns = new Set<(e: PortalEvent) => void>()
  const ev: PortalEvent = { type: 'open', color: 0, point: new THREE.Vector3(), prop: -1 }
  const emit = (type: PortalEventType, color: PortalColor, point: THREE.Vector3, prop = -1) => {
    ev.type = type
    ev.color = color
    ev.point.copy(point)
    ev.prop = prop
    for (const fn of fns) fn(ev)
  }

  const make = (color: PortalColor): Portal => ({
    color, level: '', pos: new THREE.Vector3(), n: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0), hosts: [], ground: false, inset: 0, ready: true, anchor: null, skin: 0, site: null, age: 0,
    basis: new THREE.Matrix4(), inv: new THREE.Matrix4(),
  })

  /* ---- the fit ---- */
  const hit: Hit = { t: 0, normal: new THREE.Vector3(), box: null, ground: false }
  const q = new THREE.Vector3()
  const o = new THREE.Vector3()
  const back = new THREE.Vector3()
  const RIM = 12
  const FIT_OFF = 0.6
  /** how far off the fitted plane any sample of the drawn surface may lie */
  const FLUSH = 0.04
  /** ...and a soft thing of the house's (a mattress, a cushion) this */
  const FLUSH_SOFT = 0.12
  let flushTol = FLUSH
  /** the drawn surface's facets must face within this of the oval's normal */
  const FACING = Math.cos(THREE.MathUtils.degToRad(14))
  /** the samples: round the rim, and a few inside so a post in the middle
      of a wall is not bridged */
  const SAMPLES: [number, number][] = []
  for (let i = 0; i < RIM; i++) {
    const a = (i / RIM) * Math.PI * 2
    SAMPLES.push([Math.cos(a) * 0.97, Math.sin(a) * 0.985])
  }
  SAMPLES.push([0, 0], [0.5, 0], [-0.5, 0], [0, 0.55], [0, -0.55])

  interface Fit {
    /** the drawn surface's plane, relative to the trial one: its offset
        along the normal at the centre, and its rise per unit right and up */
    off: number
    a: number
    b: number
    /** the farthest any sample lies off that plane */
    resid: number
    /** headless: how far to lift the oval clear of the ground's highest bump */
    lift: number
    hosts: Set<Solid>
    /** how far the collision surface stands in front of the plane */
    inset: number
  }
  const fitHosts = new Set<Solid>()
  const fitOut: Fit = { off: 0, a: 0, b: 0, resid: 0, lift: 0, hosts: fitHosts, inset: 0 }
  /** the drawn surface round this shot (see `soupAround`), or null headless */
  let drawn: Soup | null = null
  const sx = new Float64Array(SAMPLES.length)
  const sy = new Float64Array(SAMPLES.length)
  const sd = new Float64Array(SAMPLES.length)

  /** the boxes under the oval, and how far proud of it the nearest stands:
      they are what the walker must be let into (they are not the surface) */
  const collectHosts = (c: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3, right: THREE.Vector3, boxes: readonly Solid[]) => {
    fitHosts.clear()
    let inset = 0
    back.copy(n).negate()
    for (const [px, py] of SAMPLES) {
      q.copy(c).addScaledVector(right, px * PORTAL_HW).addScaledVector(up, py * PORTAL_HH)
      o.copy(q).addScaledVector(n, 3.2)
      for (const b of boxes) {
        if (b.hull) continue
        const t = rayBox(o, back, b, bn)
        if (t > 3.2 + 0.9) continue
        fitHosts.add(b)
        if (3.2 - t > inset) inset = 3.2 - t
      }
    }
    return inset
  }

  /**
   * Does an oval centred on `c` lie on a surface you can see? Every sample's
   * ray from FIT_OFF off the plane must meet a drawn facet facing along the
   * normal, and all of them must lie on one plane within FLUSH; that plane
   * (which may lean a little off the trial one) is where the oval goes.
   * Headless there is nothing drawn, and the collision boxes and the ground
   * function stand in for it, as they did before anything was drawn.
   */
  const fits = (
    c: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3, right: THREE.Vector3,
    boxes: readonly Solid[], world: PortalWorld, onGround: boolean,
  ): Fit | null => {
    back.copy(n).negate()
    if (drawn) {
      let k = 0
      for (const [px, py] of SAMPLES) {
        q.copy(c).addScaledVector(right, px * PORTAL_HW).addScaledVector(up, py * PORTAL_HH)
        o.copy(q).addScaledVector(n, FIT_OFF)
        const t = drawn.cast(o, back, FIT_OFF + 0.7)
        if (t === null || drawn.normal.dot(n) < FACING) return null
        // and nothing standing over it: a fence rail, a shelf, a post
        q.copy(o).addScaledVector(back, t - 0.06)
        if (drawn.cast(q, n, 1.2) !== null) return null
        sx[k] = px * PORTAL_HW
        sy[k] = py * PORTAL_HH
        sd[k] = FIT_OFF - t // + the surface stands proud of the trial plane
        k++
      }
      // the plane through them: least squares on d = a x + b y + off
      let Sxx = 0, Syy = 0, Sxy = 0, Sx = 0, Sy = 0, Sd = 0, Sxd = 0, Syd = 0
      for (let i = 0; i < k; i++) {
        Sxx += sx[i] * sx[i]; Syy += sy[i] * sy[i]; Sxy += sx[i] * sy[i]
        Sx += sx[i]; Sy += sy[i]; Sd += sd[i]; Sxd += sx[i] * sd[i]; Syd += sy[i] * sd[i]
      }
      const m = new THREE.Matrix3().set(Sxx, Sxy, Sx, Sxy, Syy, Sy, Sx, Sy, k)
      if (Math.abs(m.determinant()) < 1e-9) return null
      const sol = new THREE.Vector3(Sxd, Syd, Sd).applyMatrix3(m.invert())
      let resid = 0
      let above = 0
      for (let i = 0; i < k; i++) {
        const e = sd[i] - (sol.x * sx[i] + sol.y * sy[i] + sol.z)
        resid = Math.max(resid, Math.abs(e))
        above = Math.max(above, e)
      }
      if (resid > flushTol || Math.abs(sol.x) > 0.25 || Math.abs(sol.y) > 0.25) return null
      fitOut.a = sol.x
      fitOut.b = sol.y
      // on a soft surface (a mattress) the oval lies on its highest point
      fitOut.off = sol.z + (flushTol > FLUSH ? above : 0)
      fitOut.resid = resid
      fitOut.lift = 0
      fitOut.inset = collectHosts(q.copy(c).addScaledVector(n, sol.z), n, up, right, boxes)
      return fitOut
    }
    // headless: the boxes and the ground function are the surface
    fitHosts.clear()
    let lift = 0
    for (const [px, py] of SAMPLES) {
      q.copy(c).addScaledVector(right, px * PORTAL_HW).addScaledVector(up, py * PORTAL_HH)
      o.copy(q).addScaledVector(n, FIT_OFF)
      if (!castWorld(o, back, FIT_OFF + 0.9, boxes, world, hit)) return null
      const dev = FIT_OFF - hit.t
      if (onGround) {
        if (Math.abs(dev) > 0.12 || hit.normal.dot(n) < 0.9) return null
        if (dev > lift) lift = dev
      } else if (Math.abs(dev) > 0.05 || hit.normal.dot(n) < 0.99) return null
      if (hit.box) fitHosts.add(hit.box)
    }
    fitOut.a = fitOut.b = fitOut.off = fitOut.resid = fitOut.inset = 0
    fitOut.lift = lift
    return fitOut
  }

  const cands: Solid[] = []
  const nearBoxes = (world: PortalWorld, at: THREE.Vector3, r: number) => {
    cands.length = 0
    for (const b of world.collision.boxes) {
      if (b.hull) continue
      if (at.x < b.min.x - r || at.x > b.max.x + r) continue
      if (at.y < b.min.y - r || at.y > b.max.y + r) continue
      if (at.z < b.min.z - r || at.z > b.max.z + r) continue
      cands.push(b)
    }
    return cands
  }

  const shot: PortalShot = { ok: false, color: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() }
  let why = ''
  const fail = (color: PortalColor, reason: PortalFail, at: THREE.Vector3, n: THREE.Vector3, detail = '') => {
    why = reason + (detail ? ` (${detail})` : '')
    drawn = null
    shot.ok = false
    shot.color = color
    shot.reason = reason
    shot.point.copy(at)
    shot.normal.copy(n)
    // a shot into nothing is the caller's to answer (the sky may take it)
    if (reason !== 'miss') emit('fizzle', color, at)
    return shot
  }

  const P = new THREE.Vector3()
  const N = new THREE.Vector3()
  const U = new THREE.Vector3()
  const R = new THREE.Vector3()
  const C = new THREE.Vector3()
  const best = new THREE.Vector3()
  const WORLD_UP = new THREE.Vector3(0, 1, 0)
  const anchorM = new THREE.Matrix4()
  const ONE = new THREE.Vector3(1, 1, 1)
  const skipped = new Set<Solid>()
  const WP = new THREE.Vector3()
  const WN = new THREE.Vector3()
  const ap = new THREE.Vector3()
  const aq = new THREE.Quaternion()
  /** the world's landing was a bare box: nothing drawn anywhere near it */
  let drawnLess = false
  const pass: Solid[] = []

  /** the oval's frame on a surface facing `n`: a wall stands it upright, a
      floor or a ceiling turns its top the way the shot was going */
  const frame = (n: THREE.Vector3, dir: THREE.Vector3) => {
    if (Math.abs(n.y) < 0.7) U.copy(WORLD_UP).addScaledVector(n, -n.y).normalize()
    else {
      U.copy(dir).addScaledVector(n, -dir.dot(n))
      if (U.lengthSq() < 1e-6) U.set(0, 0, -1).addScaledVector(n, -n.z)
      U.normalize()
    }
    R.crossVectors(U, n).normalize()
  }

  const fire = (color: PortalColor, eye: THREE.Vector3, dirIn: THREE.Vector3, world: PortalWorld): PortalShot => {
    const dir = dirIn.clone().normalize()
    const max = PORTAL_RANGE
    const sb = world.sandbox
    // three things a shot can land on, the nearest wins: a prop, a drawn
    // piece of the house's furniture, and the world (boxes, ground, chunks)
    const ph = sb ? sb.raycast(eye, dir, max, { props: true, world: false }) : null
    const hh = world.drawnHit ? world.drawnHit(eye, dir, max) : null
    skipped.clear()
    drawn = null
    let onGround = false
    /*
      The world's own landing, on something you can see. The ray is cast
      against the collision boxes and the ground (cheap, and what the walker
      lives in), and then the drawn meshes are felt for along the ray round
      that hit. A box with nothing drawn near its face (a guard round a lamp
      post, a broad-phase box, one standing proud of its wall or running
      past a building's corner) is no surface: it is set aside and the ray
      goes on.
    */
    let wt = Infinity
    let wFail: PortalFail = 'miss'
    for (let attempt = 0; ; attempt++) {
      pass.length = 0
      for (const b of world.collision.boxes) if (!skipped.has(b)) pass.push(b)
      const got = castWorld(eye, dir, max, pass, world, hit)
      if (!got || hit.t <= 0) {
        WP.copy(eye).addScaledVector(dir, got ? 0 : max)
        break
      }
      WP.copy(eye).addScaledVector(dir, hit.t)
      WN.copy(hit.normal)
      // the sea is no surface either
      if (world.waterY !== undefined && WP.y < world.waterY + 0.05 && eye.y > world.waterY) {
        const tw = (world.waterY - eye.y) / dir.y
        WP.copy(eye).addScaledVector(dir, tw)
        wFail = 'water'
        wt = tw
        break
      }
      onGround = hit.ground
      if (!world.meshesNear) {
        wt = hit.t
        wFail = 'surface'
        break
      }
      // the drawn surface along the ray, from a little before the hit to a
      // little past it
      const t0 = Math.max(0, hit.t - 1.5)
      const t1 = hit.t + 3
      C.copy(eye).addScaledVector(dir, (t0 + t1) / 2)
      const along = soupAround(world.meshesNear(C, (t1 - t0) / 2 + 0.5), C, (t1 - t0) / 2 + 0.5, dir, 0.02)
      o.copy(eye).addScaledVector(dir, t0)
      const ta = along ? along.cast(o, dir, t1 - t0) : null
      if (along && ta !== null) {
        wt = t0 + ta
        wFail = 'surface'
        WP.copy(o).addScaledVector(dir, ta)
        WN.copy(along.normal)
        break
      }
      if (hit.box && attempt < 4) {
        skipped.add(hit.box)
        continue
      }
      wt = hit.t
      wFail = 'surface'
      drawnLess = true
      break
    }
    const tp = ph ? ph.distance : Infinity
    const th = hh ? hh.t : Infinity
    let pending: { kind: 'prop'; id: number } | { kind: 'object'; obj: THREE.Object3D } | null = null
    if (ph && tp <= th && tp <= wt) {
      // a prop: a box-shaped one wide and flat enough takes a portal, which
      // rides it; anything else fizzles, the way Portal will not open a
      // hole in a cube
      const pr = ph.prop
      if (!pr || !sb || pr.kind.shape.type !== 'box' || !sb.getTransform(pr.id, ap, aq)) {
        return fail(color, 'prop', ph.point, ph.normal)
      }
      P.copy(ph.point)
      N.copy(ph.normal)
      drawn = soupOfBox(ap, aq, pr.extents, N)
      onGround = false
      pending = { kind: 'prop', id: pr.id }
    } else if (hh && th <= wt) {
      P.copy(eye).addScaledVector(dir, th)
      N.copy(hh.normal)
      onGround = false
      pending = { kind: 'object', obj: hh.object }
    } else if (wt < Infinity && wFail === 'surface' && !drawnLess) {
      P.copy(WP)
      N.copy(WN)
    } else if (wt < Infinity) {
      return fail(color, wFail, WP, WN)
    } else {
      return fail(color, 'miss', WP, WORLD_UP)
    }
    drawnLess = false
    if (N.dot(dir) > 0) N.negate()
    // a facet within a few degrees of square is square (a wall's own
    // triangles lean by rounding, and the oval would lean with them)
    for (let k = 0; k < 3; k++) {
      const v = N.getComponent(k)
      if (Math.abs(Math.abs(v) - 1) < 0.01) N.set(0, 0, 0).setComponent(k, Math.sign(v))
    }
    N.normalize()
    frame(N, dir)
    const near = nearBoxes(world, P, PORTAL_HH + 4)
    // the drawn surface round the landing, facing it, felt once per shot
    if (!drawn && world.meshesNear) {
      drawn = soupAround(world.meshesNear(P, PORTAL_HH + 3.5), P, PORTAL_HH + 3.5, N, FACING)
      if (!drawn) return fail(color, 'surface', P, N, 'nothing drawn there')
    }
    // where it fits: the hit itself, or the nearest spot round it
    let fit: Fit | null = null
    const keep = { off: 0, a: 0, b: 0, lift: 0, inset: 0, resid: 0 }
    const hosts: Solid[] = []
    const take = (c: THREE.Vector3, f: Fit) => {
      best.copy(c)
      keep.off = f.off
      keep.a = f.a
      keep.b = f.b
      keep.lift = f.lift
      keep.inset = f.inset
      keep.resid = f.resid
      hosts.length = 0
      for (const h of f.hosts) hosts.push(h)
      fit = f
    }
    const tryAt = (c: THREE.Vector3) => {
      const f = fits(c, N, U, R, near, world, onGround)
      if (!f) return false
      take(c, f)
      return true
    }
    // a floor or a bed may take the oval only one way round: a portal
    // lying down is also tried turned a quarter and an eighth
    const turns = Math.abs(N.y) > 0.7 ? [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4] : [0]
    const U0 = U.clone()
    const R0 = R.clone()
    flushTol = pending?.kind === 'object' ? FLUSH_SOFT : FLUSH
    turn: for (const th of turns) {
      U.copy(U0).multiplyScalar(Math.cos(th)).addScaledVector(R0, Math.sin(th)).normalize()
      R.crossVectors(U, N).normalize()
      if (tryAt(P)) break
      for (const r of [0.15, 0.3, 0.5, 0.75, 1, 1.4, 1.8, 2.2, 2.6]) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2
          C.copy(P).addScaledVector(R, Math.cos(a) * r * 0.8).addScaledVector(U, Math.sin(a) * r)
          if (tryAt(C)) break turn
        }
      }
    }
    if (!fit) return fail(color, 'surface', P, N, `no fit on ${pending?.kind ?? (onGround ? 'ground' : 'wall')}`)
    // a wall portal a little above a floor slides down to stand on it
    if (Math.abs(N.y) < 0.3) {
      const start = best.clone()
      let down = 0
      let stopped = false
      for (let s = 0.2; s <= 2.2; s += 0.2) {
        C.copy(start).addScaledVector(U, -s)
        if (!fits(C, N, U, R, near, world, onGround)) {
          stopped = true
          break
        }
        down = s
      }
      if (stopped && down > 0) {
        C.copy(start).addScaledVector(U, -down)
        const f = fits(C, N, U, R, near, world, onGround)
        if (f) take(C, f)
      }
    }
    // onto the drawn plane itself: its offset, and its lean
    best.addScaledVector(N, keep.off)
    if (keep.a !== 0 || keep.b !== 0) {
      N.addScaledVector(R, -keep.a).addScaledVector(U, -keep.b).normalize()
      // the oval keeps the turn it was fitted at, square to the new normal
      U.addScaledVector(N, -U.dot(N)).normalize()
      R.crossVectors(U, N).normalize()
    }
    // not on top of its partner
    const other = list[1 - color]
    if (other && other.level === world.level && other.n.dot(N) > 0.95 &&
      Math.abs(tv.subVectors(best, other.pos).dot(N)) < 0.4) {
      const dx = tv.dot(R)
      const dy = tv.dot(U)
      const sep = ovalR(dx / 2, dy / 2)
      if (sep < 1) {
        // push the new one clear along the line between them, if it fits there
        const need = 1.02 / Math.sqrt(Math.max(1e-6, sep))
        C.copy(other.pos).addScaledVector(R, dx * need).addScaledVector(U, dy * need)
        C.addScaledVector(N, tv.subVectors(best, C).dot(N))
        const f = Math.hypot(dx, dy) < 0.05 ? null : fits(C, N, U, R, near, world, onGround)
        if (!f || Math.abs(f.off) > FLUSH) return fail(color, 'surface', P, N)
        best.copy(C).addScaledVector(N, f.off)
      }
    }
    drawn = null
    // flush, a hair proud so it never fights the surface for depth
    best.addScaledVector(N, keep.lift + 0.02)
    const p = placeAt(color, world.level, best, N, U, null, pending?.kind === 'prop' ? [] : hosts)
    p.ground = onGround
    p.inset = pending?.kind === 'prop' ? 0 : Math.max(0, keep.inset)
    // riding what it was opened on: its frame kept in that thing's own
    if (pending?.kind === 'prop' && sb && sb.getTransform(pending.id, ap, aq)) {
      p.anchor = { kind: 'prop', sb, id: pending.id, local: anchorM.compose(ap, aq, ONE).invert().multiply(p.basis).clone() }
      // a prop holds the walker off by its radius (sandbox/walker.ts)
      p.skin = 0.55
    } else if (pending?.kind === 'object') {
      pending.obj.updateWorldMatrix(true, false)
      p.anchor = { kind: 'object', obj: pending.obj, local: anchorM.copy(pending.obj.matrixWorld).invert().multiply(p.basis).clone() }
    }
    shot.ok = true
    shot.color = color
    shot.reason = undefined
    shot.point.copy(p.pos)
    shot.normal.copy(N)
    return shot
  }

  const placeAt = (
    color: PortalColor, level: string, pos: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3,
    site: string | null = null, hosts: Solid[] = [],
  ) => {
    const p = make(color)
    p.level = level
    p.pos.copy(pos)
    p.n.copy(n).normalize()
    p.up.copy(up).addScaledVector(p.n, -up.dot(p.n)).normalize()
    p.right.crossVectors(p.up, p.n).normalize()
    p.hosts = hosts.slice()
    p.site = site
    setBasis(p)
    list[color] = p
    version++
    emit('open', color, p.pos)
    return p
  }

  const partner = (p: Portal) => {
    const other = list[1 - p.color]
    return other && list[p.color] === p && p.ready && other.ready ? other : null
  }

  const transform = (from: Portal, out: THREE.Matrix4) => {
    const to = partner(from)
    if (!to) return out.identity()
    return out.multiplyMatrices(to.basis, FLIP).multiply(from.inv)
  }

  /* ---- the walker ---- */
  const marked: Solid[] = []
  const lp = new THREE.Vector3()
  const aperture = (level: string, center: THREE.Vector3) => {
    for (const b of marked) b.through = false
    marked.length = 0
    for (const p of list) {
      if (!p || p.level !== level || !partner(p) || !p.hosts.length) continue
      toPortal(p, center, lp)
      // in front of it (a floor portal's centre stands a body's half-height
      // over it), or just through, and inside the oval
      if (lp.z > 3.2 || lp.z < -0.8) continue
      if (ovalR(lp.x, lp.y) >= 1) continue
      for (const b of p.hosts) {
        b.through = true
        marked.push(b)
      }
    }
  }

  const hole = (level: string, x: number, z: number) => {
    for (const p of list) {
      if (!p || !p.ground || p.level !== level || p.n.y < 0.45 || !partner(p)) continue
      // (x, z) dropped onto the portal's plane
      const y = p.pos.y - ((x - p.pos.x) * p.n.x + (z - p.pos.z) * p.n.z) / p.n.y
      toPortal(p, lp.set(x, y, z), lp)
      if (ovalR(lp.x, lp.y) < 1) return true
    }
    return false
  }

  const cross: PortalCrossing = { from: null as unknown as Portal, to: null as unknown as Portal }
  const la = new THREE.Vector3()
  const lb = new THREE.Vector3()
  const crossing = (level: string, a0: THREE.Vector3, a1: THREE.Vector3): PortalCrossing | null => {
    for (const p of list) {
      if (!p || p.level !== level) continue
      const to = partner(p)
      if (!to) continue
      toPortal(p, a0, la)
      toPortal(p, a1, lb)
      la.z -= p.skin
      lb.z -= p.skin
      if (!(la.z >= 0 && lb.z < 0)) continue
      const k = la.z / (la.z - lb.z)
      const x = la.x + (lb.x - la.x) * k
      const y = la.y + (lb.y - la.y) * k
      if (ovalR(x, y) >= 1) continue
      cross.from = p
      cross.to = to
      return cross
    }
    return null
  }

  /* ---- props ---- */
  const M = new THREE.Matrix4()
  const qM = new THREE.Quaternion()
  const pp = new THREE.Vector3()
  const pq = new THREE.Quaternion()
  const pv = new THREE.Vector3()
  const pw = new THREE.Vector3()
  const nl = new THREE.Vector3()
  const iq = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const tmpPos = new THREE.Vector3()
  const moving: Prop[] = []
  /** the prop's depth along a direction: its box's support distance */
  const depthAlong = (prop: Prop, q: THREE.Quaternion, n: THREE.Vector3) => {
    nl.copy(n).applyQuaternion(iq.copy(q).invert())
    const e = prop.extents
    return Math.abs(nl.x) * e.x + Math.abs(nl.y) * e.y + Math.abs(nl.z) * e.z
  }
  const carryProps = (sb: Sandbox, level: string, held: number | null) => {
    const open = linkedIn(level).filter((p) => partner(p)!.level === level)
    if (!open.length) return
    moving.length = 0
    sb.forEach((pr) => {
      if (pr.mode === 'dynamic' && !pr.parked && pr.id !== held) moving.push(pr)
    })
    for (const pr of moving) {
      if (!sb.getTransform(pr.id, pp, pq)) continue
      sb.getVelocity(pr.id, pv, pw)
      for (const p of open) {
        if (p.anchor?.kind === 'prop' && p.anchor.id === pr.id) continue
        toPortal(p, pp, lp)
        if (lp.z < -0.5 || lp.z > 4) continue
        if (ovalR(lp.x, lp.y) >= 0.92) continue
        const r = depthAlong(pr, pq, p.n)
        const vin = pv.dot(p.n)
        const resting = p.n.y > 0.6 && vin < 0.15
        if (lp.z > r + 0.12 + p.inset) continue
        if (!(vin < -0.25 || resting)) continue
        const to = partner(p)!
        transform(p, M)
        M.decompose(tmpPos, qM, scale)
        pp.applyMatrix4(M)
        pq.premultiply(qM)
        pv.applyQuaternion(qM)
        pw.applyQuaternion(qM)
        // set down clear of the exit's own surface
        const r2 = depthAlong(pr, pq, to.n)
        const d2 = tv.subVectors(pp, to.pos).dot(to.n)
        const clear = r2 + 0.06 + to.inset
        if (d2 < clear) pp.addScaledVector(to.n, clear - d2)
        // and never slower out of a floor portal than it takes to clear it
        if (to.n.y > 0.6 && pv.dot(to.n) < 1) pv.addScaledVector(to.n, 1 - pv.dot(to.n))
        sb.setTransform(pr.id, pp, pq)
        sb.setVelocity(pr.id, pv, pw)
        emit('pass', to.color, pp, pr.id)
        break
      }
    }
  }

  const linkedIn = (level: string) => {
    const out: Portal[] = []
    for (const p of list) if (p && p.level === level && partner(p)) out.push(p)
    return out
  }

  const fp = new THREE.Vector3()
  const fq = new THREE.Quaternion()
  const fm = new THREE.Matrix4()
  const FONE = new THREE.Vector3(1, 1, 1)
  const closeOne = (c: PortalColor) => {
    const p = list[c]
    if (!p) return
    list[c] = null
    version++
    emit('close', c, p.pos)
    for (const b of marked) b.through = false
    marked.length = 0
  }

  return {
    list,
    fire,
    placeAt,
    close: (color) => {
      for (const c of [0, 1] as const) {
        if (color !== undefined && c !== color) continue
        const p = list[c]
        if (!p) continue
        list[c] = null
        version++
        emit('close', c, p.pos)
      }
      for (const b of marked) b.through = false
      marked.length = 0
    },
    partner,
    transform,
    linkedIn,
    anyIn: (level) => {
      for (const p of list) if (p && p.level === level && partner(p)) return true
      return false
    },
    tick: (dt) => {
      for (const p of list) if (p) p.age += dt
    },
    aperture,
    hole,
    crossing,
    carryProps,
    on: (fn) => {
      fns.add(fn)
      return () => fns.delete(fn)
    },
    get version() {
      return version
    },
    get why() {
      return why
    },
    rayEnters: (level, eye, dir, reach) => {
      let best: { t: number; at: THREE.Vector3; from: Portal; to: Portal; M: THREE.Matrix4 } | null = null
      for (const p of list) {
        if (!p || p.level !== level) continue
        const to = partner(p)
        if (!to) continue
        const dn = dir.dot(p.n)
        if (dn >= -1e-4) continue
        const t = tv.subVectors(p.pos, eye).dot(p.n) / dn
        if (t < 0 || t > reach || (best && t >= best.t)) continue
        const at = eye.clone().addScaledVector(dir, t)
        toPortal(p, at, lp)
        if (ovalR(lp.x, lp.y) >= 1) continue
        best = { t, at, from: p, to, M: transform(p, new THREE.Matrix4()) }
      }
      return best
    },
    follow: () => {
      for (const p of list) {
        const a = p?.anchor
        if (!p || !a) continue
        if (a.kind === 'prop') {
          if (!a.sb.get(a.id) || !a.sb.getTransform(a.id, fp, fq)) {
            closeOne(p.color)
            continue
          }
          fm.compose(fp, fq, FONE)
        } else {
          let root: THREE.Object3D = a.obj
          while (root.parent) root = root.parent
          if (!(root as THREE.Scene).isScene) {
            closeOne(p.color)
            continue
          }
          a.obj.updateWorldMatrix(true, false)
          fm.copy(a.obj.matrixWorld)
        }
        fm.multiply(a.local)
        if (fm.equals(p.basis)) continue
        p.basis.copy(fm)
        p.inv.copy(fm).invert()
        const e = fm.elements
        p.right.set(e[0], e[1], e[2]).normalize()
        p.up.set(e[4], e[5], e[6]).normalize()
        p.n.set(e[8], e[9], e[10]).normalize()
        p.pos.set(e[12], e[13], e[14])
      }
    },
    hw: PORTAL_HW,
    hh: PORTAL_HH,
  }
}
