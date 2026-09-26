import * as THREE from 'three'
import { resolveXZ, type CollisionSet } from '../physics/collision'

/*
  Bodies meeting bodies: the walker against the town's pedestrians and the
  other players, Fall Guys style, where bumping into people is part of the
  fun rather than something the engine forgot.

  Before this the walk met boxes, hulls and props and nothing else, so a
  player sprinting at a pedestrian went through them like a ghost, and two
  players could stand inside each other. Every body is now an upright
  cylinder (a capsule seen from above, which is all a walk on the ground can
  tell apart), and one pass a frame after the walk has moved settles every
  contact the walker is in. What happens depends on how the two met:

  - **A lean.** Walking into somebody pushes the two of you apart. The
    overlap is split by `give`: a pedestrian is local state and takes half
    of it (if it has room, and if not the walker takes the lot), a remote
    player is somebody else's to move and takes none, so they are a wall to
    you exactly as you are to them on their screen. Leaning in at more than
    a stroll also staggers them a little.
  - **A charge.** Running into somebody (your own speed along the line
    between you past CHARGE, which a walk does not reach and a sprint does)
    knocks them flat, and you rebound off them with a hop, more the harder
    you hit.
  - **A tackle.** Airborne, far less is needed: a hop into somebody's chest
    at a walking pace takes them down, because that is what jumping at a
    person is for.
  - **A stomp.** Coming down on somebody from above (falling, soles over the
    lower part of them) flattens them and bounces you back up off their head.

  This module decides and moves the walker; it never touches a body it does
  not own. Everything it can bump is a `Bumpable`, a small indexed interface
  that answers "where is body i", "may I shove it" and "it was hit": the
  pedestrians implement it by moving and ragdolling their own rigs, and the
  remote players (`net/shove.ts`) by refusing every shove and sending the hit
  over the network for the victim's own client to apply to itself, since
  nobody here moves anybody else's body.

  Sizes are measured, not typed: `bodyExtent` reads the rig's own mesh (the
  crown for the height, the trunk's girth for the radius), so a redrawn body
  collides at its new size without anyone remembering to change a number
  here.

  Headless: plain numbers, one scratch record, no allocation per frame, no
  renderer.
*/

export interface BodyExtent {
  /** the upright cylinder's radius, world units */
  radius: number
  /** soles to crown, world units */
  height: number
}

/** a body that can be bumped, as this frame sees it */
export interface Peer {
  x: number
  z: number
  /** absolute height of the soles */
  feetY: number
  /** planar velocity, units/s */
  vx: number
  vz: number
  radius: number
  height: number
}

export type BumpKind = 'none' | 'lean' | 'charge' | 'tackle' | 'stomp'

/** what one contact came to, filled by `touch` */
export interface Bump {
  kind: BumpKind
  /** unit normal from the peer to the walker, planar */
  nx: number
  nz: number
  /** how far the two cylinders overlap, planar */
  depth: number
  /** the walker's own speed into the peer along the normal */
  approach: number
  /** the velocity the peer is thrown with (a knock) or staggered at (a lean),
      units/s. A rig's `hit` wants it times the rig's mass */
  vx: number
  vy: number
  vz: number
  /** where on the peer it lands, world */
  px: number
  py: number
  pz: number
  /** the walker's recoil, units/s */
  rx: number
  ry: number
  rz: number
}

export interface Bumpable {
  /** how many slots there are to ask about (live or not) */
  readonly size: number
  /** fill `out` with body i, or say it is not there to be bumped (not
      live, lying down, sitting in a car, flying) */
  peer: (i: number, out: Peer) => boolean
  /** move body i by (dx, dz). False when it cannot go there (a wall behind
      it) or cannot be moved from here at all (somebody else's body) */
  nudge: (i: number, dx: number, dz: number) => boolean
  /** body i was bumped. Called once per contact per frame for a lean, and
      once for a knock (the body is down after it and stops being a peer) */
  hit: (i: number, bump: Bump) => void
  /** anybody lying down near the walker gets trampled: optional, and only
      the owner of a body can do it */
  trample?: (x: number, z: number, feetY: number, vx: number, vz: number, radius: number) => number
}

/** the walker, this frame */
export interface Bumper {
  /** the eye: x and z are corrected in place */
  eye: THREE.Vector3
  feetY: number
  vx: number
  vz: number
  vy: number
  grounded: boolean
  radius: number
  height: number
}

export interface ContactReport {
  /** contacts this frame, by kind */
  leans: number
  knocks: number
  stomps: number
  trampled: number
  /** the smallest planar gap between the walker's cylinder and any peer it
      overlaps vertically, after the pass (negative is interpenetration) */
  gap: number
}

/* ------------------------------------------------------------- tuning -- */

/** the walker's own speed into a body, on the ground, that knocks it flat.
    The walk cruises at 5.9 and the sprint at 9.4 (CrtScene's tune), so this
    sits between: a walk leans, a run bowls people over */
export const CHARGE = 7.2
/** ...and in the air: a hop at somebody from a walk is a tackle */
export const TACKLE = 3.2
/** a lean at more than this staggers the body leaned on */
const STAGGER = 3
/** the stagger's speed, as a share of the approach, and its cap */
const STAGGER_K = 0.7
const STAGGER_MAX = 4
/** past the top of the arc (rising slower than this, or falling), with the
    soles over this share of the other body's height, is landing on them. A
    hop's apex is ~2.1 over the ground and a body ~4.6 tall, so the share is
    low: coming down on somebody's shoulders counts */
const STOMP_VY = 1
const STOMP_OVER = 0.3
/** the bounce off a head, units/s up: a little under a hop, so a stomp
    reads as a trampoline and not as a second jump */
const STOMP_BOUNCE = 9
/** the walker's rebound off a knock: this share of the approach back along
    the normal, and a stumbling hop */
const RECOIL = 0.45
const RECOIL_HOP = 2.4
/** a knock throws the body along the walker's travel a little faster than
    it was coming, and up: the same scoop impacts.ts gives a bumper */
const THROW = 1.1
const THROW_UP = 2
const THROW_UP_K = 0.25

/* -------------------------------------------------------- measurement -- */

/*
  How big a rig is, read off its own mesh.

  The height is the mesh's highest vertex, the radius the trunk's: of every
  vertex between 30% and 70% of the height, the 75th-percentile distance
  from the upright axis through the soles. A percentile rather than the
  maximum because arms, a belly or a nose poke out of the band and are not
  what two bodies meet with; the axis rather than the band's own centroid
  because the rig is placed by its soles and so is the cylinder.

  Measured once per geometry (a repaint that changes the build swaps it),
  in the mesh's own units, then scaled by the group's scale, which is how
  `buildPlayerBody` sizes a body onto its eye height.
*/
const measured = new WeakMap<THREE.BufferGeometry, { r: number; h: number }>()
const meshes = new WeakMap<THREE.Object3D, THREE.Mesh | null>()
/** a body with nothing measurable in it: the old robot's numbers */
const FALLBACK = { r: 0.55, h: 2.65 }

const findMesh = (group: THREE.Object3D) => {
  let best: THREE.Mesh | null = null
  let most = 0
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || (o as THREE.Sprite).isSprite) return
    const n = m.geometry?.getAttribute('position')?.count ?? 0
    if (n > most) {
      most = n
      best = m
    }
  })
  return best
}

const measure = (mesh: THREE.Mesh, group: THREE.Object3D) => {
  const g = mesh.geometry
  const hit = measured.get(g)
  if (hit) return hit
  // the mesh's placement inside the group, which for every rig today is
  // the identity, but a redrawn body is free to nest its mesh
  const m = new THREE.Matrix4()
  for (let o: THREE.Object3D | null = mesh; o && o !== group; o = o.parent) {
    o.updateMatrix()
    m.premultiply(o.matrix)
  }
  const P = g.getAttribute('position')
  const v = new THREE.Vector3()
  let lo = Infinity
  let top = -Infinity
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(m)
    if (v.y < lo) lo = v.y
    if (v.y > top) top = v.y
  }
  const band0 = lo + (top - lo) * 0.3
  const band1 = lo + (top - lo) * 0.7
  const rs = new Float32Array(P.count)
  let n = 0
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(m)
    if (v.y < band0 || v.y > band1) continue
    rs[n++] = Math.hypot(v.x, v.z)
  }
  const band = rs.subarray(0, n).sort()
  const out = n && Number.isFinite(top)
    ? { r: band[Math.floor((n - 1) * 0.75)], h: Math.max(0, top) }
    : FALLBACK
  measured.set(g, out)
  return out
}

/** the upright cylinder a rig collides as, measured off its own mesh (see
    above). Cheap after the first call per geometry: two WeakMap lookups */
export const bodyExtent = (group: THREE.Object3D, out: BodyExtent): BodyExtent => {
  let mesh = meshes.get(group)
  if (mesh === undefined) {
    mesh = findMesh(group)
    meshes.set(group, mesh)
  }
  const d = mesh ? measure(mesh, group) : FALLBACK
  out.radius = d.r * group.scale.x
  out.height = d.h * group.scale.y
  return out
}

/* ------------------------------------------------------------ contact -- */

/**
 * One walker against one body: do they touch, and how. Fills `out` and
 * returns its kind; 'none' leaves the rest of `out` stale.
 */
export const touch = (me: Bumper, o: Peer, out: Bump): BumpKind => {
  out.kind = 'none'
  // the two vertical spans have to overlap: a hop clean over a head, or a
  // body on the roof above, is not a contact
  if (me.feetY >= o.feetY + o.height || me.feetY + me.height <= o.feetY) return 'none'
  const reach = me.radius + o.radius
  let dx = me.eye.x - o.x
  let dz = me.eye.z - o.z
  const d2 = dx * dx + dz * dz
  if (d2 >= reach * reach) return 'none'
  let d = Math.sqrt(d2)
  if (d < 1e-4) {
    // dead centre (a spawn, a teleport onto somebody): out the way the
    // walker came from, or any way at all
    const s = Math.hypot(me.vx, me.vz)
    dx = s > 1e-3 ? -me.vx / s : 1
    dz = s > 1e-3 ? -me.vz / s : 0
    d = 1
  }
  const nx = dx / d
  const nz = dz / d
  out.nx = nx
  out.nz = nz
  out.depth = reach - Math.min(d, reach)
  out.approach = -(me.vx * nx + me.vz * nz)
  const speed = Math.hypot(me.vx, me.vz)

  // coming down on them: soles over the lower part of the body, falling
  const falling = !me.grounded && me.vy < STOMP_VY
  if (falling && me.feetY > o.feetY + o.height * STOMP_OVER) {
    out.kind = 'stomp'
    out.vx = me.vx * 0.5
    out.vy = me.vy * 0.4
    out.vz = me.vz * 0.5
    out.px = o.x
    out.py = o.feetY + o.height * 0.85
    out.pz = o.z
    out.rx = nx * 1.5
    out.ry = STOMP_BOUNCE
    out.rz = nz * 1.5
    return 'stomp'
  }
  // the point of contact: on their surface toward us, at chest height
  out.px = o.x + nx * o.radius
  out.py = o.feetY + o.height * 0.55
  out.pz = o.z + nz * o.radius
  const knock = me.grounded ? out.approach > CHARGE : out.approach > TACKLE
  if (knock) {
    out.kind = me.grounded ? 'charge' : 'tackle'
    out.vx = me.vx * THROW
    out.vy = THROW_UP + speed * THROW_UP_K + Math.max(0, me.vy) * 0.5
    out.vz = me.vz * THROW
    out.rx = nx * out.approach * RECOIL
    out.ry = me.grounded ? RECOIL_HOP : 0
    out.rz = nz * out.approach * RECOIL
    return out.kind
  }
  out.kind = 'lean'
  const st = out.approach > STAGGER ? Math.min(STAGGER_MAX, out.approach * STAGGER_K) : 0
  out.vx = -nx * st
  out.vy = 0
  out.vz = -nz * st
  out.rx = 0
  out.ry = 0
  out.rz = 0
  return 'lean'
}

/* ----------------------------------------------------------- resolver -- */

export interface ContactStep {
  me: Bumper
  /** the walker's shove, for a rebound or a bounce (`WalkController.push`) */
  push: (vx: number, vy: number, vz: number) => void
  /** walls win over bodies: after a separation the walker is resolved
      against the level again, with the walk's own step allowance */
  collision: CollisionSet
  stepUp: number
  sets: readonly (Bumpable | null | undefined)[]
  /** a clock in seconds, for the knock cooldown */
  now: number
}

export interface BodyContact {
  /** one frame's contacts; call after the walk has moved */
  step: (o: ContactStep) => ContactReport
}

/** how many times the pass goes round: a walker wedged between two bodies
    settles in two, and a third catches a wall pushing it back in */
const ITER = 3
/** one knock per body per this long. A pedestrian is down after one and
    stops being a peer, but a remote player stays standing on this screen
    until their own client says otherwise a round trip later, and a sprint
    held into them would otherwise rebound the walker off them every frame */
const KNOCK_COOLDOWN = 0.7

export function createBodyContact(): BodyContact {
  const peer: Peer = { x: 0, z: 0, feetY: 0, vx: 0, vz: 0, radius: 0, height: 0 }
  const bump: Bump = {
    kind: 'none', nx: 0, nz: 0, depth: 0, approach: 0,
    vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0,
  }
  const report: ContactReport = { leans: 0, knocks: 0, stomps: 0, trampled: 0, gap: Infinity }
  /** when each body may next be knocked, per set; grown, never shrunk */
  const cool = new Map<Bumpable, Float64Array>()
  const coolOf = (set: Bumpable) => {
    let c = cool.get(set)
    if (!c || c.length < set.size) {
      const next = new Float64Array(Math.max(8, set.size * 2)).fill(-Infinity)
      if (c) next.set(c)
      c = next
      cool.set(set, c)
    }
    return c
  }

  return {
    step: (o) => {
      const { me, sets } = o
      report.leans = 0
      report.knocks = 0
      report.stomps = 0
      report.trampled = 0
      report.gap = Infinity
      let bounced = false
      for (let it = 0; it < ITER; it++) {
        let touched = false
        for (const set of sets) {
          if (!set) continue
          const c = coolOf(set)
          for (let i = 0; i < set.size; i++) {
            if (!set.peer(i, peer)) continue
            // broad phase: a box round both, before any square root
            const reach = me.radius + peer.radius
            if (Math.abs(me.eye.x - peer.x) >= reach || Math.abs(me.eye.z - peer.z) >= reach) continue
            let kind = touch(me, peer, bump)
            if (kind === 'none') continue
            // a body still cooling from the last knock is leaned on instead
            if (kind !== 'lean' && c[i] > o.now) {
              kind = bump.kind = 'lean'
              bump.vx = bump.vy = bump.vz = 0
            }
            touched = true
            // what happens to them happens once a frame, on the first pass
            if (it === 0) {
              if (kind !== 'lean') c[i] = o.now + KNOCK_COOLDOWN
              if (kind === 'stomp') {
                report.stomps++
                set.hit(i, bump)
                if (!bounced) {
                  o.push(bump.rx, bump.ry, bump.rz)
                  bounced = true
                }
                // the bounce carries the walker off them; no shove apart
                continue
              }
              if (kind === 'lean') report.leans++
              else report.knocks++
              set.hit(i, bump)
              if (kind !== 'lean' && !bounced) {
                o.push(bump.rx, bump.ry, bump.rz)
                bounced = true
              }
            } else if (kind === 'stomp') continue
            // apart: their share first, if they can take it, then ours
            const theirs = bump.depth * 0.5
            const took = set.nudge(i, -bump.nx * theirs, -bump.nz * theirs)
            const ours = took ? bump.depth - theirs : bump.depth
            me.eye.x += bump.nx * ours
            me.eye.z += bump.nz * ours
          }
        }
        if (!touched) break
        // a body shoved into a wall stays out of the wall
        resolveXZ(me.eye, o.collision, me.feetY, me.feetY + me.height, o.stepUp)
      }
      // the measurement: after everything, how close is the walker to
      // anybody it shares a height with
      for (const set of sets) {
        if (!set) continue
        for (let i = 0; i < set.size; i++) {
          if (!set.peer(i, peer)) continue
          if (me.feetY >= peer.feetY + peer.height || me.feetY + me.height <= peer.feetY) continue
          const gap = Math.hypot(me.eye.x - peer.x, me.eye.z - peer.z) - me.radius - peer.radius
          if (gap < report.gap) report.gap = gap
        }
        if (set.trample) {
          const s = Math.hypot(me.vx, me.vz)
          if (s > 2) report.trampled += set.trample(me.eye.x, me.eye.z, me.feetY, me.vx, me.vz, me.radius)
        }
      }
      return report
    },
  }
}
