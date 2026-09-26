import type * as THREE from 'three'
import type { DynamicSolids } from '../physics/collision'
import { GROUPS, WORLD_FRICTION, type PhysicsWorld, type RBody, type RCollider } from './physics'
import type { Props, Prop } from './props'

/*
  The player among the props: how a walker that is not a rigid body meets a
  world full of them.

  The walk controller stays the source of truth for the walk
  (player/walkController.ts owns velocity, gravity, the step-up, swimming),
  and it already asks collision.ts three questions every tick: what is the
  tallest surface under me, push me out of whatever I walked into, and would
  I fit here. This module answers those three for the props, as the
  CollisionSet's `dynamic` provider, so the walk, the body's planted feet and
  the chase boom all meet props without a line changing in any of them. The
  answers are exact, asked of Rapier's own shapes rather than of boxes around
  them: a tilted plank is a ramp, a barrel on its side is a round thing you
  slide off, a crate is square.

  - **Standing** is five rays down through the props only, at the foot's
    centre and four points on a 0.24 ring, taking the highest face that
    points up and is within reach. It allows a mantle of MANTLE above the
    step reach, because the push-out below ignores contacts whose normal is
    mostly vertical, and without that slack a prop whose top sits a hair above
    the step band is neither climbed nor pushed against, and the walker sinks
    into it.
  - **Pushing out** is a vertical cylinder of the body's radius from the top
    of the step band to the crown, tested against every prop it overlaps
    with Rapier's exact contact query and moved out horizontally along the
    contact normal. Each contact is also *recorded*, because a push is two
    things: the walker stops, and the prop is shoved.
  - **The shove** is applied once a frame from those records: an impulse
    toward a speed that falls with the prop's mass (`shoveSpeed`: a ball is
    kicked ahead of your feet at more than a walk, a plank goes at a walk, a
    crate at about a third of one), capped at PUSH_FORCE. The first version
    aimed every prop at the walk's own speed and a 35 kg crate went ten units
    in two and a half seconds, which reads as cardboard; a Source player
    leaning on a crate nudges it. Against friction the cap is the rest of
    what makes mass matter: a 900 kg block does not move at all. The walker,
    stopped by the push-out, advances exactly as fast as the prop gives way,
    so leaning on something heavy slows you to its pace.
  - **Weight and riding.** Standing on a prop presses it down with the
    walker's weight at the foot (a plank seesaws, a floating crate settles
    lower), and when it moves the walker is carried by the displacement of
    the point they stand on, taken from the pose the prop is *drawn* at, so
    the rider and the ride never drift apart on screen.
  - **Being hit** is a kinematic capsule mirroring the walker, slightly
    thinner than the push-out cylinder so walking never shoves anything
    through it (only the capped push does), and starting above the step band
    so it never lifts what you are standing on. A thrown crate stops against
    it, a falling one lands on your head and rolls off, and CCD on every prop
    means nothing fast passes through.
*/

/** the walker's radius against props */
const BODY_R = 0.5
/** the kinematic mirror's radius: thinner, see the header */
const KIN_R = 0.42
/** the crown over the eye (the robot's head top is ~0.9 above its eyes) */
const HEAD_EXTRA = 0.8
/** the foot ring the standing rays sample */
const FOOT_R = 0.24
/** how far above the step reach a prop top is still climbed */
const MANTLE = 0.3
/** a face steeper than this is not a floor */
const FLOOR_NY = 0.45
/** the most force a walker can put into a prop, kg*u/s² */
export const PUSH_FORCE = 1500
/** the speed a shove works a prop up to, as a share of the walk's: a
    prop of SHOVE_KG goes at a walk, lighter ones faster (up to a kick),
    heavier ones slower in proportion */
const SHOVE_KG = 12
export const shoveSpeed = (mass: number) => Math.min(1.3, Math.max(0.12, SHOVE_KG / mass))
/** what a walker weighs, kg */
export const WALKER_MASS = 80

export interface WalkerState {
  /** the camera (eye) position; x and z are moved when riding */
  eye: THREE.Vector3
  feetY: number
  /** the walk's velocity (its intent, not what collision let it do) */
  vx: number
  vz: number
  grounded: boolean
  /** the step allowance the walk climbs */
  step: number
}

interface Push {
  prop: Prop
  /** unit direction from the walker into the prop, xz */
  dx: number
  dz: number
  x: number
  y: number
  z: number
}

export interface Walker {
  provider: DynamicSolids
  /** once a frame before the slices: shove what was pushed, arm the mirror */
  frame: (w: WalkerState | null, dt: number) => void
  beforeSlice: (k: number, n: number) => void
  /** after the draw: carry a rider with their ride */
  carry: (w: WalkerState | null) => void
  isPlayer: (c: RCollider) => boolean
  /** the prop the walker stood on this frame */
  readonly standing: Prop | null
}

export const createWalker = (pw: PhysicsWorld, props: Props): Walker => {
  const { R, world } = pw
  const cyl = new R.Cylinder(1, BODY_R)
  const ID = { x: 0, y: 0, z: 0, w: 1 }
  const DOWN = { x: 0, y: -1, z: 0 }
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, DOWN)
  const center = { x: 0, y: 0, z: 0 }
  const pushes: Push[] = []
  const cands: RCollider[] = []
  const RING: Array<[number, number]> = [
    [0, 0], [FOOT_R * 0.7, FOOT_R * 0.7], [-FOOT_R * 0.7, FOOT_R * 0.7],
    [FOOT_R * 0.7, -FOOT_R * 0.7], [-FOOT_R * 0.7, -FOOT_R * 0.7],
  ]

  let hitCol: RCollider | null = null
  const hitPt = { x: 0, y: 0, z: 0 }

  const topAt = (x: number, z: number, reach: number) => {
    hitCol = null
    if (!props.count) return -Infinity
    let best = -Infinity
    const from = reach + 30
    const limit = reach + MANTLE
    for (const [ox, oz] of RING) {
      ray.origin = { x: x + ox, y: from, z: z + oz }
      world.intersectionsWithRay(ray, 60, true, (hit) => {
        const y = from - hit.timeOfImpact
        if (y > limit || y <= best || hit.normal.y < FLOOR_NY) return true
        best = y
        hitCol = hit.collider
        hitPt.x = x + ox
        hitPt.y = y
        hitPt.z = z + oz
        return true
      }, undefined, GROUPS.queryProps)
    }
    return best
  }

  const shapeAt = (x: number, z: number, footY: number, headY: number, stepUp: number) => {
    const bottom = footY + stepUp + 0.02
    const top = headY + HEAD_EXTRA
    if (top <= bottom) return false
    cyl.halfHeight = (top - bottom) / 2
    center.x = x
    center.y = (top + bottom) / 2
    center.z = z
    return true
  }

  const provider: DynamicSolids = {
    topAt,
    pushOut: (p, footY, headY, stepUp) => {
      if (!props.count || !shapeAt(p.x, p.z, footY, headY, stepUp)) return
      cands.length = 0
      world.intersectionsWithShape(center, ID, cyl, (c) => {
        cands.push(c)
        return cands.length < 12
      }, undefined, GROUPS.queryProps)
      for (const c of cands) {
        const k = c.contactShape(cyl, center, ID, 0)
        if (!k || k.distance >= 0) continue
        const n = k.normal1
        const len = Math.hypot(n.x, n.z)
        // mostly vertical: a floor (standing handles it) or a ceiling
        if (len < 0.6) continue
        const push = Math.min(0.6, -k.distance / len)
        p.x += (n.x / len) * push
        p.z += (n.z / len) * push
        center.x = p.x
        center.z = p.z
        const prop = props.ofCollider(c)
        if (prop && pushes.length < 16) {
          pushes.push({ prop, dx: -n.x / len, dz: -n.z / len, x: k.point1.x, y: k.point1.y, z: k.point1.z })
        }
      }
    },
    blocks: (x, z, footY, headY, stepUp) => {
      if (!props.count || !shapeAt(x, z, footY, headY, stepUp)) return false
      let hit = false
      world.intersectionsWithShape(center, ID, cyl, () => {
        hit = true
        return false
      }, undefined, GROUPS.queryProps)
      return hit
    },
  }

  /* ------------------------------------------------ the kinematic mirror -- */

  const kinBottom = 0.35
  const kinTop = 4.55
  const kinHalf = (kinTop - kinBottom) / 2 - KIN_R
  const body: RBody = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1e4, 0))
  const kinCol = world.createCollider(
    R.ColliderDesc.capsule(kinHalf, KIN_R).setCollisionGroups(GROUPS.player).setFriction(WORLD_FRICTION * 0.65),
    body,
  )
  body.setEnabled(false)
  const from = { x: 0, y: 0, z: 0 }
  const to = { x: 0, y: 0, z: 0 }
  let on = false

  /* ------------------------------------------------- standing and riding -- */

  let standing: Prop | null = null
  let wasStanding: Prop | null = null
  /*
    What a ride carries is its translation and its turn about the vertical,
    and deliberately nothing else. Carrying the stand point through the full
    rotation looked right and was a motor: the walker's weight, pressed at
    the foot, tips the prop a fraction of a degree on its soft contacts, the
    tilt carries the foot a hair outward, the weight's lever grows, and a
    two-crate stack stood on for half a second walked itself out from under
    the player and fell over (measured: 19 units). A person standing on a
    tilting crate does not slide with the tilt either; they stay where their
    feet are until it throws them.
  */
  let riding = false
  /** the ride's origin and heading, and the walker's offset from it */
  let ox = 0
  let oz = 0
  let oh = 0
  let offX = 0
  let offZ = 0
  const tmpQ = { x: 0, y: 0, z: 0, w: 1 }

  const drawnPose = (p: Prop) => {
    const m = p.mesh
    if (m) return { px: m.position.x, py: m.position.y, pz: m.position.z, q: m.quaternion }
    const t = p.body.translation()
    const q = p.body.rotation()
    tmpQ.x = q.x
    tmpQ.y = q.y
    tmpQ.z = q.z
    tmpQ.w = q.w
    return { px: t.x, py: t.y, pz: t.z, q: tmpQ }
  }
  /** a heading for a rotation: whichever of its local x and z axes lies
      flatter, projected onto the ground */
  const headingOf = (q: { x: number; y: number; z: number; w: number }) => {
    // local x rotated: first column of the rotation matrix
    const xx = 1 - 2 * (q.y * q.y + q.z * q.z)
    const xy = 2 * (q.x * q.y + q.w * q.z)
    const xz = 2 * (q.x * q.z - q.w * q.y)
    // local z rotated: third column
    const zx = 2 * (q.x * q.z + q.w * q.y)
    const zy = 2 * (q.y * q.z - q.w * q.x)
    const zz = 1 - 2 * (q.x * q.x + q.y * q.y)
    return Math.abs(xy) < Math.abs(zy) ? Math.atan2(-xz, xx) : Math.atan2(zx, zz)
  }

  const weightAt = { x: 0, y: 0, z: 0 }
  let weight = 0

  const frame = (w: WalkerState | null, dt: number) => {
    // the shove: every prop the walk pressed into this frame
    if (w && pushes.length) {
      const cap = PUSH_FORCE * Math.max(dt, 1 / 240)
      for (const p of pushes) {
        if (p.prop.mode !== 'dynamic' || p.prop.parked) continue
        const vIn = w.vx * p.dx + w.vz * p.dz
        if (vIn < 0.1) continue
        const v = p.prop.body.linvel()
        const vp = v.x * p.dx + v.z * p.dz
        const want = vIn * shoveSpeed(p.prop.mass)
        const j = Math.min(cap, p.prop.mass * (want - vp))
        if (j <= 0) continue
        // at the height of the prop's own centre where the body can reach it,
        // so a shove slides a crate rather than spinning it about the point
        // the cylinder happened to find first
        const cy = p.prop.body.translation().y
        const y = Math.min(w.feetY + 3.4, Math.max(w.feetY + w.step + 0.1, cy))
        props.applyImpulse(p.prop.id, { x: p.dx * j, y: 0, z: p.dz * j }, { x: p.x, y, z: p.z })
      }
    }
    pushes.length = 0

    // standing: asked again here, at the walk's final position, rather than
    // trusted from whichever supportY call ran last (the feet and the boom
    // ask too, at other points)
    standing = null
    weight = 0
    if (w && w.grounded && props.count) {
      const top = topAt(w.eye.x, w.eye.z, w.feetY + w.step)
      if (hitCol && Math.abs(top - w.feetY) < 0.12) {
        standing = props.ofCollider(hitCol) ?? null
        if (standing && standing.mode === 'dynamic') {
          weight = WALKER_MASS * -pw.gravity
          weightAt.x = hitPt.x
          weightAt.y = hitPt.y
          weightAt.z = hitPt.z
          // a body asleep under a still walker may stay asleep; one that has
          // just been stepped on, or walked across, must feel it
          if (standing !== wasStanding || Math.hypot(w.vx, w.vz) > 0.3) standing.body.wakeUp()
        }
      }
    }
    wasStanding = standing
    riding = false
    if (standing && w) {
      const d = drawnPose(standing)
      ox = d.px
      oz = d.pz
      oh = headingOf(d.q)
      offX = w.eye.x - d.px
      offZ = w.eye.z - d.pz
      riding = true
    }

    // the mirror
    if (!w) {
      if (on) {
        body.setEnabled(false)
        on = false
      }
      return
    }
    const cy = w.feetY + (kinBottom + kinTop) / 2
    if (!on) {
      body.setEnabled(true)
      body.setTranslation({ x: w.eye.x, y: cy, z: w.eye.z }, true)
      on = true
    }
    const t = body.translation()
    from.x = t.x
    from.y = t.y
    from.z = t.z
    to.x = w.eye.x
    to.y = cy
    to.z = w.eye.z
    // a teleport (a spawn, a level cut, standing up from a ragdoll across the
    // room) is not a very fast walk: swept kinematically, an infinitely heavy
    // capsule would bulldoze everything between the two spots. A walk moves
    // a fraction of a unit a frame and a long fall under two
    if (Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) > 3) {
      body.setTranslation(to, true)
      from.x = to.x
      from.y = to.y
      from.z = to.z
    }
  }

  const beforeSlice = (k: number, n: number) => {
    if (on) {
      const f = (k + 1) / n
      body.setNextKinematicTranslation({
        x: from.x + (to.x - from.x) * f,
        y: from.y + (to.y - from.y) * f,
        z: from.z + (to.z - from.z) * f,
      })
    }
    if (standing && weight > 0 && standing.mode === 'dynamic') {
      props.addForce(standing.id, { x: 0, y: -weight, z: 0 }, weightAt)
    }
  }

  const carry = (w: WalkerState | null) => {
    if (!w || !riding || !standing) return
    const d = drawnPose(standing)
    let dh = headingOf(d.q) - oh
    if (dh > Math.PI) dh -= 2 * Math.PI
    if (dh < -Math.PI) dh += 2 * Math.PI
    // a heading that jumped has swapped axes (the prop turned over), not spun
    if (Math.abs(dh) > 0.3) dh = 0
    const c = Math.cos(dh)
    const sn = Math.sin(dh)
    // the same convention as the rest of the runtime: a turn of +dh about y
    const nx = d.px + offX * c + offZ * sn
    const nz = d.pz - offX * sn + offZ * c
    const dx = nx - w.eye.x
    const dz = nz - w.eye.z
    // a ride that moved further than a stride in one frame has thrown its
    // rider off rather than carried them
    if (Math.hypot(dx, dz) < 1.5 && Math.hypot(d.px - ox, d.pz - oz) < 1.5) {
      w.eye.x = nx
      w.eye.z = nz
    }
  }

  return {
    provider,
    frame,
    beforeSlice,
    carry,
    isPlayer: (c) => c.handle === kinCol.handle,
    get standing() {
      return standing
    },
  }
}
