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

  **Placing one** is a ray, then a fit. The ray is the walk's own world: the
  level's collision boxes (the house, its furniture, every building in the
  streamed ring), its ground (the terrain, marched and bisected), the props
  (a shot that lands on a crate fizzles, the way Portal will not open a hole
  in a cube) and the sea (likewise). The fit is Portal's: the whole oval has
  to lie on the surface, so a dozen short rays down the normal from points
  round its rim must all land on the plane of the hit. A shot near an edge
  is nudged inward to the nearest place it fits, a shot at a wall a little
  above the floor slides down until the oval stands on the floor (a doorway
  you can walk through, not a window you have to jump at), and a shot that
  cannot fit anywhere near fizzles. A floor or ceiling portal is turned so
  its top points the way you were looking. On the terrain the fit tolerates
  the ground's roll and lifts the oval clear of the highest bump under it.

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
/** the opening's half-width and half-height: a little taller than a body */
export const PORTAL_HW = 1.45
export const PORTAL_HH = 2.45
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
}

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

/**
 * The drawn triangles of a few meshes that lie within a box round a point
 * and face along `n`, flattened into world space once per shot, so the
 * fit's two dozen rays test a few hundred triangles rather than a merged
 * chunk's hundred thousand each. Returns a ray caster over them (distance
 * to the nearest, or null), or null when nothing drawn is there.
 */
export const soupAround = (
  meshes: readonly THREE.Mesh[], at: THREE.Vector3, r: number, n: THREE.Vector3,
): ((o: THREE.Vector3, d: THREE.Vector3, max: number) => number | null) | null => {
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
      if (len < 1e-9 || Math.abs(fn.dot(n)) / len < 0.85) continue
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    }
  }
  if (!tris.length) return null
  const T = Float32Array.from(tris)
  const p = new THREE.Vector3()
  const q = new THREE.Vector3()
  const t0 = new THREE.Vector3()
  return (o, d, max) => {
    let best: number | null = null
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
    }
    return best
  }
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
    right: new THREE.Vector3(1, 0, 0), hosts: [], ground: false, inset: 0, ready: true, site: null, age: 0,
    basis: new THREE.Matrix4(), inv: new THREE.Matrix4(),
  })

  /* ---- the fit ---- */
  const hit: Hit = { t: 0, normal: new THREE.Vector3(), box: null, ground: false }
  const q = new THREE.Vector3()
  const o = new THREE.Vector3()
  const back = new THREE.Vector3()
  const RIM = 12
  const FIT_OFF = 0.6
  /** the samples: round the rim, and a few inside so a post in the middle
      of a wall is not bridged */
  const SAMPLES: [number, number][] = []
  for (let i = 0; i < RIM; i++) {
    const a = (i / RIM) * Math.PI * 2
    SAMPLES.push([Math.cos(a) * 0.97, Math.sin(a) * 0.985])
  }
  SAMPLES.push([0, 0], [0.5, 0], [-0.5, 0], [0, 0.55], [0, -0.55])

  interface Fit {
    lift: number
    hosts: Set<Solid>
  }
  const fitHosts = new Set<Solid>()
  const fitOut: Fit = { lift: 0, hosts: fitHosts }
  /**
   * Does an oval centred on `c` lie on the surface? Every sample's ray from
   * FIT_OFF off the plane must land on it, within a hair for a box and
   * within the ground's roll for the terrain, facing the same way.
   */
  /** the drawn wall's own ray caster for this shot, and how far behind the
      box face it stands where the shot hit (see `soupAround`) */
  let drawn: ((o: THREE.Vector3, d: THREE.Vector3, max: number) => number | null) | null = null
  let drawnDepth = 0
  const fits = (
    c: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3, right: THREE.Vector3,
    boxes: readonly Solid[], world: PortalWorld, onGround: boolean,
  ): Fit | null => {
    fitHosts.clear()
    let lift = 0
    back.copy(n).negate()
    for (const [sx, sy] of SAMPLES) {
      q.copy(c).addScaledVector(right, sx * PORTAL_HW).addScaledVector(up, sy * PORTAL_HH)
      o.copy(q).addScaledVector(n, FIT_OFF)
      // the wall you can see must be there too, flat, at the depth it had
      // where the shot landed: past a building's corner the box runs on and
      // the wall does not
      if (drawn) {
        const tv = drawn(o, back, FIT_OFF + drawnDepth + 0.6)
        if (tv === null || Math.abs(tv - FIT_OFF - drawnDepth) > 0.09) return null
      }
      if (!castWorld(o, back, FIT_OFF + 0.9, boxes, world, hit)) return null
      const dev = FIT_OFF - hit.t // + the surface stands proud of the plane here
      if (hit.ground !== onGround) {
        // a kerb or a slab lying on the ground under a ground portal (and
        // the ground under a box portal) are one floor as long as they are
        // flush with it
        if (Math.abs(dev) > 0.08) return null
      }
      if (onGround) {
        if (dev > 0.55 || dev < -0.4) return null
        if (hit.normal.dot(n) < 0.75) return null
        if (dev > lift) lift = dev
      } else {
        if (Math.abs(dev) > 0.05 || hit.normal.dot(n) < 0.99) return null
      }
      if (hit.box) fitHosts.add(hit.box)
    }
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
  const fail = (color: PortalColor, reason: PortalFail, at: THREE.Vector3, n: THREE.Vector3) => {
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

  const fire = (color: PortalColor, eye: THREE.Vector3, dirIn: THREE.Vector3, world: PortalWorld): PortalShot => {
    const dir = dirIn.clone().normalize()
    const max = PORTAL_RANGE
    // a prop in the way stops the shot there
    const sb = world.sandbox
    const ph = sb ? sb.raycast(eye, dir, max, { props: true, world: false }) : null
    const boxes = world.collision.boxes
    const got = castWorld(eye, dir, max, boxes, world, hit)
    if (ph && (!got || ph.distance < hit.t)) {
      return fail(color, 'prop', ph.point, ph.normal)
    }
    if (!got || hit.t <= 0) {
      P.copy(eye).addScaledVector(dir, got ? 0 : max)
      return fail(color, 'miss', P, WORLD_UP)
    }
    P.copy(eye).addScaledVector(dir, hit.t)
    N.copy(hit.normal)
    // the sea is no surface either
    if (world.waterY !== undefined && P.y < world.waterY + 0.05 && eye.y > world.waterY) {
      const tw = (world.waterY - eye.y) / dir.y
      P.copy(eye).addScaledVector(dir, tw)
      return fail(color, 'water', P, WORLD_UP)
    }
    const onGround = hit.ground
    // the frame: a wall stands its oval upright; a floor or a ceiling turns
    // its top the way the shot was going
    if (Math.abs(N.y) < 0.7) U.copy(WORLD_UP).addScaledVector(N, -N.y).normalize()
    else {
      U.copy(dir).addScaledVector(N, -dir.dot(N))
      if (U.lengthSq() < 1e-6) U.set(0, 0, -1).addScaledVector(N, -N.z)
      U.normalize()
    }
    R.crossVectors(U, N).normalize()
    const near = nearBoxes(world, P, PORTAL_HH + 4)
    // the drawn wall behind a box: felt for once, at the hit
    drawn = null
    drawnDepth = 0
    if (!onGround && world.meshesNear) {
      const soup = soupAround(world.meshesNear(P, PORTAL_HH + 3.5), P, PORTAL_HH + 3.5, N)
      o.copy(P).addScaledVector(N, FIT_OFF)
      back.copy(N).negate()
      const t = soup ? soup(o, back, FIT_OFF + 1.5) : null
      if (soup && t !== null) {
        drawn = soup
        drawnDepth = t - FIT_OFF
      }
    }
    // where it fits: the hit itself, or the nearest spot round it
    let fit: Fit | null = null
    let lift = 0
    const hosts: Solid[] = []
    const tryAt = (c: THREE.Vector3) => {
      const f = fits(c, N, U, R, near, world, onGround)
      if (!f) return false
      best.copy(c)
      lift = f.lift
      hosts.length = 0
      for (const h of f.hosts) hosts.push(h)
      fit = f
      return true
    }
    if (!tryAt(P)) {
      search: for (let r = 0.4; r <= 2.6; r += 0.4) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2
          C.copy(P).addScaledVector(R, Math.cos(a) * r * 0.8).addScaledVector(U, Math.sin(a) * r)
          if (tryAt(C)) break search
        }
      }
    }
    if (!fit) return fail(color, 'surface', P, N)
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
        best.copy(start).addScaledVector(U, -down)
        const f = fits(best, N, U, R, near, world, onGround)
        if (f) {
          lift = f.lift
          hosts.length = 0
          for (const h of f.hosts) hosts.push(h)
        }
      }
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
        if (Math.hypot(dx, dy) < 0.05 || !fits(C, N, U, R, near, world, onGround)) return fail(color, 'surface', P, N)
        best.copy(C)
      }
    }
    // onto the wall you can see: a box stands its shoulder pad proud of it
    const inset = drawn ? drawnDepth : 0
    drawn = null
    best.addScaledVector(N, lift - inset + (onGround ? 0.04 : 0.025))
    const p = placeAt(color, world.level, best, N, U, null, hosts)
    p.ground = onGround
    p.inset = Math.max(0, inset)
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
  }
}
