import * as THREE from 'three'
import type { Sandbox } from '../sandbox'
import type { Prop } from '../props'
import {
  emptyHold, type Aim, type GrabRig, type HoldRecord, type PhysgunEvent, type PhysgunEventType,
  type RigEntry, type ToolInput, type VehicleGrab,
} from './types'

/*
  The physgun: take anything by the exact point the beam touched, carry it at
  arm's length along your view, swing it, turn it, push it away, freeze it in
  mid-air, and throw it with whatever the beam was doing when you let go.

  This module is the beam's *physics* and its bookkeeping, and nothing it
  does needs a renderer: the film harness and `measure physics` drive it in
  Node exactly as CrtScene drives it in the browser. What it looks and sounds
  like is beam.ts, viewmodel.ts and sfx.ts, all of which read the plain
  `HoldRecord` this keeps up to date and the events it fires.

  **The hold is a controller, not a teleport.** Every fixed slice the grab
  point P is pulled toward the target T (the eye plus the view direction
  times the held distance) by a damped spring solved *implicitly*:

      v' = (v + h w^2 (T - P) + 2 z w h vT) / (1 + 2 z w h + w^2 h^2)

  which is unconditionally stable at any stiffness, so a 1 kg ball held at
  twenty radians a second does not buzz, and a prop held still is dead still.
  The change of velocity is delivered as an impulse through the sandbox (so
  the impact detector never mistakes the beam for a collision), clamped to
  an acceleration budget, with the prop's own weight paid on top of the
  budget: the beam always holds a thing up, and what mass costs you is how
  fast it can be *moved*. The stiffness, the damping ratio and the budget all
  fall with mass (`tune`), which is where the feel lives:

  - a ball or a cone is critically damped at ~18 rad/s on a big budget: it
    snaps onto the beam and a flick throws it at 60 u/s;
  - a crate or a barrel is underdamped (z ~0.6) at ~8 rad/s: it trails a
    fast swing, overshoots where the swing stopped by a tenth and settles,
    swings on its grab point (the orientation spring is soft too), and a
    flick throws it at about half a ball's speed;
  - a 900 kg block drags at ~5 rad/s on a budget of a few tens of u/s^2: it
    trails a swing by a dozen units and a flick barely moves it. A small
    integral term winds out the few centimetres a soft spring sags under
    that much weight.

  Because P is the grab point and not the centre, and the orientation is
  held separately, a plank grabbed by one end hangs off the beam by that
  end, and turning it (E) pivots about the point you are holding.

  **Orientation follows your heading, not your pitch.** At the grab the
  prop's orientation is stored relative to the holder's yaw; while held it
  is driven toward yaw times that, by a critically damped angular target
  written as a velocity. Looking up and down carries the prop up and down
  without tipping it toward you, turning round carries it round with the
  same face toward you: GMod's behaviour. E + mouse turns the stored
  orientation about the view's up and right axes; Shift snaps it to a
  45-degree lattice in the heading's frame.

  Held props still collide: they are dynamic bodies throughout, so a held
  crate shoves a stack over, catches on a kerb and presses into a wall with
  exactly the budget the controller has. A prop the walker is *standing on*
  is dropped, because a beam lifting its own holder is a motor.

  **Freezing** (secondary while holding) turns the prop into a fixed body
  exactly where it is drawn; grabbing a frozen prop thaws it, and reload
  thaws whatever you are looking at. A rig limb frozen is a limb pinned in
  place, which is how a ragdoll gets posed.

  **Vehicles** are taken through the fleet's hook (`VehicleGrab`): a parked
  machine is not a prop, so the fleet stands one in for it at the moment of
  the grab and the beam holds that, weight and all. While the beam has a prop
  its `data.beam` is set, which is how the fleet knows not to hand a machine
  back to its own physics in mid-air.

  **Rigs** are bodies built by `buildPlayerBody()` (pedestrians, and other
  players through `net/grab.ts`'s adapter), grabbed by their nearest limb
  through the rig's own `grab(i, target)` hook: the verlet ragdoll follows a
  point that this module moves. A rig that says it is no longer `alive` (a
  player who left, sat down or ran out the hold's cap) is let go. They are found by testing the view ray against each limb's
  sphere, which is exact for the thing a ragdoll is made of.

  Nothing allocates per frame. The Rapier bindings do allocate for their
  own return values (`translation()`, a ray hit), which is the library's
  cost and is paid by every other system in the sandbox too.
*/

/** how far the beam reaches, units (~65 m) */
export const RANGE = 150
/** the closest the wheel pulls a held thing */
const MIN_DIST = 2.2
/** the farthest it pushes it */
const MAX_DIST = 170
/** radians of turn per pixel of mouse while rotating */
const ROT_PER_PX = 0.0065
/** the unheld beam's reach when it finds nothing */
const MISS_REACH = 14
/** stiffness a rig limb is pinned with (the rig's k, 0..1 per substep) */
const RIG_K = 0.5
/** a held grab point farther than this from its target has come unstuck
    (wedged behind a wall while you walked off): let go */
const TEAR = 60
/** fastest target velocity fed forward, u/s; a teleport is not a flick */
const MAX_TARGET_SPEED = 260
/** share of the gap between the beam's speed and the prop's handed over on
    release (see `release`) */
const THROW_SHARE = 0.7
/** share of the target's velocity fed forward (see the slice hook) */
const FEED = 0.5
/** angular speed cap, rad/s */
const MAX_SPIN = 40

export interface Tune {
  /** natural frequency of the position spring, rad/s */
  w: number
  /** its damping ratio (1 is critical) */
  z: number
  /** acceleration budget above the prop's own weight, u/s^2 */
  a: number
  /** the orientation spring, rad/s */
  wr: number
  /** its damping ratio */
  zr: number
  /** integral gain on a small resting error, as a share of w (heavy only) */
  i: number
}

/**
 * The feel, as a function of mass, on a log scale from a 2 kg ball (t = 0)
 * to a tonne (t = 1). Three bands, because that is how a physgun reads:
 *
 * - light (a ball, a cone, a bottle): stiff and critically damped, a big
 *   acceleration budget. It snaps onto the beam and a flick throws it hard.
 * - mid (a plank, a barrel, a crate): softer and underdamped (z ~0.6). It
 *   trails a fast swing by a couple of units, overshoots where the swing
 *   stops by a tenth and settles; and its orientation spring is softer too,
 *   so a crate held by a corner swings about the grab point like a
 *   pendulum. The budget is a few hundred u/s^2, so a flick throws it at
 *   about half a ball's speed.
 * - heavy (a block, a girder): slow, dragging, short of budget. It lags a
 *   swing by several units and a flick barely moves it.
 *
 * `measure physics physgun` prints settle time, overshoot and throw speed for
 * every kind off this table.
 */
export const tune = (mass: number, out: Tune = { w: 0, z: 0, a: 0, wr: 0, zr: 0, i: 0 }): Tune => {
  const m = Math.max(0.1, mass)
  const t = Math.min(1, Math.max(0, Math.log10(m / 2) / Math.log10(500)))
  out.w = 18 / (1 + 2.5 * t)
  const mid = t <= 0.05 ? 0 : t >= 0.4 ? 1 : ((t - 0.05) / 0.35) ** 2 * (3 - (2 * (t - 0.05)) / 0.35)
  // the heaviest drag rather than ring: a tonne that bounces on the beam
  // reads as a balloon
  const heavy = t <= 0.6 ? 0 : Math.min(1, (t - 0.6) / 0.4)
  out.z = 1 - 0.42 * mid + 0.22 * heavy
  out.wr = out.w * 0.85
  out.zr = 1 - 0.45 * mid + 0.2 * heavy
  out.a = 30 + 2400 / (1 + m / 2)
  // a soft spring under a heavy weight rests a few centimetres low; only
  // there does the resting error need winding out
  out.i = 0.35 * heavy
  return out
}

export interface PhysgunOpts {
  sb: Sandbox
  /** who is holding, for the record */
  holder?: string
  /** bodies the beam can take by a limb; read on a click, not every frame */
  rigs?: () => Iterable<RigEntry>
  /** props that move together with this one (welds); reload thaws them too */
  linked?: (id: number) => Iterable<number>
  /** what holding this prop actually lifts: a welded machine weighs all of
      its parts, and the hold pays that weight (default: the prop's own) */
  massOf?: (id: number) => number
  /** the fleet: parked machines the beam can take (types.ts's VehicleGrab) */
  vehicles?: VehicleGrab
}

export interface BeamView {
  /** 'hold' a thing, 'miss' firing at nothing (or at what cannot be held),
      'off' */
  mode: 'hold' | 'miss' | 'off'
  /** the far end of the beam, world */
  end: THREE.Vector3
  /** where the beam is pulling to (hold) */
  target: THREE.Vector3
  /** the surface normal at a miss's end, for a spark; zero if none */
  normal: THREE.Vector3
  strain: number
}

export interface Physgun {
  /** the plain-data hold, rewritten in place every frame */
  readonly hold: HoldRecord
  /** what the beam looks like this frame */
  readonly view: BeamView
  readonly holding: boolean
  /** E is turning the held prop, so mouse-look belongs to it */
  readonly capturesLook: boolean
  /** the held prop, if it is one */
  readonly prop: Prop | null
  /** once a frame, before the sandbox ticks */
  update: (input: ToolInput) => void
  /** once a frame, after the sandbox has drawn: the beam's far end follows
      the prop where it is *drawn*, not where its last slice left it */
  sync: () => void
  /** let go; `thrown` false stops the momentum (holstering, a vehicle) */
  release: (thrown?: boolean) => void
  /** thaw what the ray finds (and anything welded to it); true if it did */
  unfreezeAt: (aim: Aim) => boolean
  /** point the gun at another sandbox (a level cut): whatever was held or
      pinned is let go first, since it belongs to the level being left */
  retarget: (next: Sandbox) => void
  on: (fn: (e: PhysgunEvent) => void) => () => void
  /** the controller's last numbers, for tests */
  readonly debug: { err: number; speed: number; saturated: boolean }
  dispose: () => void
}

export function createPhysgun(o: PhysgunOpts): Physgun {
  // a let: the gun follows the player into whichever level's sandbox is live
  let sb = o.sb
  const hold = emptyHold(o.holder ?? 'local')
  const view: BeamView = {
    mode: 'off', end: new THREE.Vector3(), target: new THREE.Vector3(),
    normal: new THREE.Vector3(), strain: 0,
  }
  const listeners = new Set<(e: PhysgunEvent) => void>()
  const debug = { err: 0, speed: 0, saturated: false }

  // the hold, in live objects (the record mirrors them as numbers)
  let prop: Prop | null = null
  let rig: GrabRig | null = null
  let rigKey = ''
  let limb = -1
  const anchor = new THREE.Vector3()
  const target = new THREE.Vector3()
  const targetPrev = new THREE.Vector3()
  const targetVel = new THREE.Vector3()
  /** the live point a rig limb follows, read by reference */
  const rigTarget = new THREE.Vector3()
  let dist = 0
  let distGoal = 0
  let yaw = 0
  let yawPrev = 0
  let yawRate = 0
  /** held orientation relative to the heading: free (as turned) and shown */
  const relFree = new THREE.Quaternion()
  const rel = new THREE.Quaternion()
  let snapping = false
  let strain = 0
  let sat = 0
  let fresh = true

  // edges
  let fireWas = false
  let altWas = false
  let reloadWas = false
  /** a freeze spends the trigger: nothing is taken again until it is let go,
      or the beam would thaw what it just froze on the same frame */
  let spent = false

  // limbs pinned by a freeze: posed ragdolls, thawed by reload or a regrab
  const pins: Array<{ key: string; rig: GrabRig; limb: number; at: THREE.Vector3 }> = []

  const tn: Tune = { w: 0, z: 0, a: 0, wr: 0, zr: 0, i: 0 }
  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion()
  const qy = new THREE.Quaternion()
  const va = new THREE.Vector3()
  const vb = new THREE.Vector3()
  const vc = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const xAxis = new THREE.Vector3(1, 0, 0)
  const eul = new THREE.Euler(0, 0, 0, 'YXZ')
  const imp = { x: 0, y: 0, z: 0 }
  /** the integral of a small error: the steady sag a soft spring leaves
      under a heavy prop is wound out over a second or so; it only winds
      while the error is under half a unit, so a swing's lag never charges
      it, and light props (tune's `i` is 0) never use it */
  const integ = new THREE.Vector3()
  const ang = { x: 0, y: 0, z: 0 }

  const emit = (type: PhysgunEventType, x: number, y: number, z: number, speed = 0, id = hold.prop) => {
    const e: PhysgunEvent = { type, kind: hold.kind, prop: id, speed, x, y, z }
    for (const fn of listeners) fn(e)
  }

  const yawQuat = (y: number, out: THREE.Quaternion) => out.setFromAxisAngle(up, y)

  /** the grab point in the world, from a pose */
  const pointOf = (pos: THREE.Vector3, q: THREE.Quaternion, out: THREE.Vector3) =>
    out.copy(anchor).applyQuaternion(q).add(pos)

  /** the prop's pose as last drawn, or as last stepped headless */
  const drawnPose = (p: Prop, pos: THREE.Vector3, q: THREE.Quaternion) => {
    if (p.mesh) {
      pos.copy(p.mesh.position)
      q.copy(p.mesh.quaternion)
    } else sb.getTransform(p.id, pos, q)
  }

  /* --------------------------------------------------------- picking -- */

  // one Rapier ray, reused: the facade's raycast builds a new one per call
  let ray: InstanceType<NonNullable<Sandbox['rapier']>['Ray']> | null = null
  const castProps = (aim: Aim, reach: number) => {
    const pw = sb.physics
    if (!pw) return null
    ray ??= new pw.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })
    ray.origin.x = aim.eye.x
    ray.origin.y = aim.eye.y
    ray.origin.z = aim.eye.z
    ray.dir.x = aim.dir.x
    ray.dir.y = aim.dir.y
    ray.dir.z = aim.dir.z
    // world and props, never the walker's own capsule or a vehicle hull
    return pw.world.castRayAndGetNormal(ray, reach, true, undefined, ((0xffff << 16) | 3) >>> 0)
  }

  /** the nearest limb sphere along the ray, if any is nearer than `within` */
  const castRigs = (aim: Aim, within: number) => {
    let best: { key: string; rig: GrabRig; limb: number; t: number } | null = null
    if (!o.rigs) return best
    let bestT = within
    for (const e of o.rigs()) {
      const r = e.rig
      for (let i = 0; i < r.limbs.length; i++) {
        r.limbPos(i, va)
        // generous by half a radius: a beam should not need a pixel-perfect
        // wrist, and a limb is the only target a body offers
        const rad = r.limbs[i].radius * 1.5 + 0.12
        vb.subVectors(va, aim.eye)
        const along = vb.dot(aim.dir)
        if (along < 0 || along > bestT + rad) continue
        const d2 = vb.lengthSq() - along * along
        if (d2 > rad * rad) continue
        const t = along - Math.sqrt(rad * rad - d2)
        if (t < bestT) {
          bestT = t
          best = { key: e.key, rig: r, limb: i, t: Math.max(0, t) }
        }
      }
    }
    return best
  }

  /* ------------------------------------------------------- grab/drop -- */

  const grabProp = (p: Prop, point: THREE.Vector3, aim: Aim) => {
    if (sb.network && !sb.network.claim(p.id, 'hand')) return false
    if (p.mode === 'kinematic') return false
    if (p.mode === 'frozen') {
      sb.unfreeze(p.id)
      emit('unfreeze', point.x, point.y, point.z, 0, p.id)
    }
    prop = p
    // a mark for the systems that settle things on their own (destruction's
    // rubble): a player has had their hands on this one, leave it be. And
    // one that lasts only while the beam has it: a machine standing in as a
    // prop is handed back to its own physics once it is let go and settles
    p.data.handled = true
    p.data.beam = true
    sb.wake(p.id)
    sb.getTransform(p.id, va, qa)
    // the exact point touched, in the prop's own frame
    anchor.copy(point).sub(va).applyQuaternion(qb.copy(qa).invert())
    dist = distGoal = Math.max(MIN_DIST, point.distanceTo(aim.eye))
    yaw = yawPrev = aim.yaw
    // the slices of this very frame already pull: toward where it was touched
    target.copy(aim.dir).multiplyScalar(dist).add(aim.eye)
    targetPrev.copy(target)
    targetVel.set(0, 0, 0)
    relFree.copy(yawQuat(aim.yaw, qy).invert()).multiply(qa)
    rel.copy(relFree)
    hold.kind = 'prop'
    hold.prop = p.id
    hold.anchor[0] = anchor.x
    hold.anchor[1] = anchor.y
    hold.anchor[2] = anchor.z
    fresh = true
    integ.set(0, 0, 0)
    emit('grab', point.x, point.y, point.z)
    return true
  }

  const grabRig = (key: string, r: GrabRig, i: number, aim: Aim) => {
    // a frozen limb is thawed by taking it again
    for (let k = pins.length - 1; k >= 0; k--) {
      if (pins[k].rig === r && pins[k].limb === i) pins.splice(k, 1)
    }
    rig = r
    rigKey = key
    limb = i
    r.limbPos(i, rigTarget)
    dist = distGoal = Math.max(MIN_DIST, rigTarget.distanceTo(aim.eye))
    yaw = yawPrev = aim.yaw
    target.copy(rigTarget)
    targetPrev.copy(target)
    targetVel.set(0, 0, 0)
    r.grab(i, rigTarget, RIG_K)
    hold.kind = 'rig'
    hold.rig = key
    hold.limb = i
    fresh = true
    emit('grab', rigTarget.x, rigTarget.y, rigTarget.z)
  }

  const clearHold = () => {
    if (prop) {
      delete prop.data.beam
      sb.network?.release(prop.id)
    }
    prop = null
    rig = null
    rigKey = ''
    limb = -1
    hold.kind = 'none'
    hold.prop = -1
    hold.rig = ''
    hold.limb = -1
    hold.rotating = false
    strain = 0
    sat = 0
  }

  const release = (thrown = true) => {
    if (prop) {
      const p = prop
      sb.getVelocity(p.id, va)
      if (!thrown) sb.setVelocity(p.id, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
      else if (targetVel.lengthSq() > va.lengthSq()) {
        // the beam's momentum: a prop trailing a flick is going slower than
        // the flick, and letting go hands it most of the difference, as much
        // as fifty milliseconds of its budget can buy. This is what makes a
        // flick throw hard rather than lob what the lag left behind
        vb.subVectors(targetVel, va).multiplyScalar(THROW_SHARE)
        const cap = tune(p.body.mass(), tn).a * 0.05
        if (vb.length() > cap) vb.setLength(cap)
        va.add(vb)
        sb.setVelocity(p.id, va)
      }
      emit('release', view.end.x, view.end.y, view.end.z, thrown ? va.length() : 0)
    } else if (rig) {
      rig.grab(limb, null, undefined, thrown ? targetVel : undefined)
      emit('release', view.end.x, view.end.y, view.end.z, thrown ? targetVel.length() : 0)
    }
    clearHold()
  }

  const freeze = () => {
    if (prop) {
      const p = prop
      // fixed where it is *drawn*, so the freeze lands exactly on the frame
      // the player saw; and zeroed, so a thaw starts from rest
      drawnPose(p, va, qa)
      sb.setVelocity(p.id, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
      sb.freeze(p.id)
      // setTransform re-reads both stored poses, so the frozen mesh stops
      // interpolating between the last two slices it moved through
      sb.setTransform(p.id, va, qa)
      hold.freezes++
      emit('freeze', view.end.x, view.end.y, view.end.z)
      clearHold()
    } else if (rig) {
      // a posed limb: pinned where it is, until reload or a regrab
      const at = new THREE.Vector3()
      rig.limbPos(limb, at)
      pins.push({ key: rigKey, rig, limb, at })
      rig.grab(limb, at, 1)
      hold.freezes++
      emit('freeze', at.x, at.y, at.z)
      clearHold()
    }
  }

  const unfreezeAt = (aim: Aim) => {
    const hit = castProps(aim, RANGE)
    const t = hit ? hit.timeOfImpact : RANGE
    const r = castRigs(aim, t)
    if (r) {
      let any = false
      for (let k = pins.length - 1; k >= 0; k--) {
        if (pins[k].rig !== r.rig) continue
        pins[k].rig.grab(pins[k].limb, null)
        pins.splice(k, 1)
        any = true
      }
      if (any) {
        va.copy(aim.dir).multiplyScalar(r.t).add(aim.eye)
        emit('unfreeze', va.x, va.y, va.z)
      }
      return any
    }
    if (!hit) return false
    const p = sb.propOf(hit.collider)
    if (!p || p.mode !== 'frozen') return false
    va.copy(aim.dir).multiplyScalar(hit.timeOfImpact).add(aim.eye)
    sb.unfreeze(p.id)
    sb.wake(p.id)
    if (o.linked) {
      for (const id of o.linked(p.id)) {
        const q = sb.get(id)
        if (q && q.mode === 'frozen') {
          sb.unfreeze(id)
          sb.wake(id)
        }
      }
    }
    emit('unfreeze', va.x, va.y, va.z, 0, p.id)
    return true
  }

  /* ------------------------------------------------------- the frame -- */

  const tryGrab = (aim: Aim) => {
    const hit = castProps(aim, RANGE)
    const t = hit ? hit.timeOfImpact : RANGE
    const r = castRigs(aim, t)
    // a parked machine nearer than anything else the ray found: the fleet
    // stands a prop in for it, and from then on it is held like a crate
    const veh = o.vehicles?.pick(aim.eye, aim.dir, r ? r.t : t) ?? null
    if (veh) {
      va.copy(aim.dir).multiplyScalar(veh.t).add(aim.eye)
      const p = o.vehicles!.take(veh.key, sb)
      if (p) return grabProp(p, va, aim)
      view.end.copy(va)
      view.normal.set(0, 0, 0)
      return false
    }
    if (r) {
      grabRig(r.key, r.rig, r.limb, aim)
      return true
    }
    if (hit) {
      const p = sb.propOf(hit.collider)
      va.copy(aim.dir).multiplyScalar(hit.timeOfImpact).add(aim.eye)
      if (p && !p.parked) return grabProp(p, va, aim)
      // nothing to hold: the beam stops on the surface
      view.end.copy(va)
      view.normal.set(hit.normal.x, hit.normal.y, hit.normal.z)
      return false
    }
    view.end.copy(aim.dir).multiplyScalar(MISS_REACH).add(aim.eye)
    view.normal.set(0, 0, 0)
    return false
  }

  const update = (inp: ToolInput) => {
    const aim = inp.aim
    const dt = Math.max(1e-4, inp.dt)
    const fireDown = inp.fire && !fireWas
    const altDown = inp.alt && !altWas
    const reloadDown = inp.reload && !reloadWas
    fireWas = inp.fire
    altWas = inp.alt
    reloadWas = inp.reload
    if (!inp.fire) spent = false

    // a prop that vanished under the hold (removed, parked, undone), or a
    // body that can no longer be held (a player who left or sat down)
    if (prop && (!sb.get(prop.id) || prop.parked)) clearHold()
    if (rig && rig.alive && !rig.alive()) clearHold()
    for (let k = pins.length - 1; k >= 0; k--) {
      const pr = pins[k].rig
      if (pr.alive && !pr.alive()) pins.splice(k, 1)
    }
    // standing on it: a beam that lifts its own holder is a motor
    if (prop && !sb.isAuthority(prop.id)) clearHold()
    if (prop && sb.standing === prop) release(false)

    if (prop || rig) {
      if (!inp.fire) {
        release(true)
      } else if (altDown) {
        freeze()
        spent = true
      }
    }

    if (prop || rig) {
      // the wheel: a notch is a tenth of the distance plus a stride, eased in
      if (inp.wheel) distGoal = THREE.MathUtils.clamp(distGoal + inp.wheel * (distGoal * 0.12 + 0.8), MIN_DIST, MAX_DIST)
      dist += (distGoal - dist) * (1 - Math.exp(-dt * 14))
      // E + mouse turns the held prop about the view's up and right axes, in
      // the heading's frame; the view does not move meanwhile
      hold.rotating = !!prop && inp.rotate
      if (hold.rotating && (inp.lookX || inp.lookY)) {
        qa.setFromAxisAngle(up, inp.lookX * ROT_PER_PX)
        qb.setFromAxisAngle(xAxis, inp.lookY * ROT_PER_PX)
        relFree.premultiply(qa).premultiply(qb).normalize()
      }
      if (hold.rotating && inp.snap) {
        eul.setFromQuaternion(relFree, 'YXZ')
        const s = Math.PI / 4
        eul.set(Math.round(eul.x / s) * s, Math.round(eul.y / s) * s, Math.round(eul.z / s) * s, 'YXZ')
        rel.setFromEuler(eul)
        snapping = true
      } else {
        // letting go of Shift keeps the snapped orientation: a snap is a
        // placement, and it should not spring back to where the mouse was
        if (snapping) relFree.copy(rel)
        snapping = false
        rel.copy(relFree)
      }
      target.copy(aim.dir).multiplyScalar(dist).add(aim.eye)
      // the target's own velocity, fed forward so a light prop tracks a flick
      // exactly; low-passed, because frames and slices do not line up
      if (fresh) {
        targetPrev.copy(target)
        targetVel.set(0, 0, 0)
        yawPrev = aim.yaw
        yawRate = 0
        fresh = false
      }
      va.subVectors(target, targetPrev).divideScalar(dt)
      if (va.lengthSq() > MAX_TARGET_SPEED * MAX_TARGET_SPEED) va.setLength(MAX_TARGET_SPEED)
      targetVel.lerp(va, 1 - Math.exp(-dt * 120))
      targetPrev.copy(target)
      let dy = aim.yaw - yawPrev
      dy = Math.atan2(Math.sin(dy), Math.cos(dy))
      yawRate += (dy / dt - yawRate) * (1 - Math.exp(-dt * 30))
      yawPrev = aim.yaw
      yaw = aim.yaw
      if (rig) rigTarget.copy(target)
    } else {
      hold.rotating = false
      // holding the trigger sweeps: the beam takes the first thing it
      // touches, the way GMod's does, rather than only what was under the
      // crosshair on the frame the button went down
      if (inp.fire && !spent && !tryGrab(aim)) {
        view.mode = 'miss'
        if (fireDown) emit('miss', view.end.x, view.end.y, view.end.z)
      }
      if (reloadDown) unfreezeAt(aim)
    }
    if (!(prop || rig) && (!inp.fire || spent)) view.mode = 'off'
  }

  /* ------------------------------------------------ the slice hook -- */

  const beforeSlice = (h: number) => {
    const p = prop
    if (!p) return
    if (p.mode !== 'dynamic') {
      clearHold()
      return
    }
    const body = p.body
    const t = body.translation()
    const r = body.rotation()
    va.set(t.x, t.y, t.z)
    qa.set(r.x, r.y, r.z, r.w)
    const P = pointOf(va, qa, vb)
    // a prop joined into a machine carries the machine: the budget and the
    // weight are the whole thing's, laid on the part the beam has hold of
    const m = o.massOf ? Math.max(body.mass(), o.massOf(p.id)) : body.mass()
    tune(m, tn)

    /* position: an implicit damped spring on the grab point */
    const lv = body.linvel()
    const ex = target.x - P.x
    const ey = target.y - P.y
    const ez = target.z - P.z
    const err = Math.hypot(ex, ey, ez)
    if (err > TEAR) {
      release(false)
      return
    }
    const w2h = tn.w * tn.w * h
    const c = 2 * tn.z * tn.w * h
    const den = 1 + c + w2h * h
    // half the target's velocity is fed forward: all of it puts a zero in
    // the response and a critically damped hold overshoots by 13%; half is
    // the most that cannot overshoot, and it leaves a moving prop trailing
    // the beam by v/w, which is the curve in the beam during a swing
    const cf = c * FEED
    if (err < 0.5) integ.set(integ.x + ex * h, integ.y + ey * h, integ.z + ez * h)
    else integ.multiplyScalar(0.9)
    const ki = w2h * tn.w * tn.i
    let dvx = (lv.x + w2h * ex + cf * targetVel.x) / den - lv.x + ki * integ.x
    let dvy = (lv.y + w2h * ey + cf * targetVel.y) / den - lv.y + ki * integ.y
    let dvz = (lv.z + w2h * ez + cf * targetVel.z) / den - lv.z + ki * integ.z
    const dv = Math.hypot(dvx, dvy, dvz)
    const cap = tn.a * h
    const saturated = dv > cap
    if (saturated) {
      const k = cap / dv
      dvx *= k
      dvy *= k
      dvz *= k
    }
    // the weight, paid outside the budget: the beam always holds a thing up
    imp.x = m * dvx
    imp.y = m * (dvy - sb.gravity * h)
    imp.z = m * dvz
    sb.applyImpulse(p.id, imp)

    /* orientation: toward heading x relative, critically damped */
    yawQuat(yaw, qy).multiply(rel)
    // error rotation qe = target * current^-1, taken the short way round
    qb.copy(qa).invert().premultiply(qy)
    if (qb.w < 0) qb.set(-qb.x, -qb.y, -qb.z, -qb.w)
    const s = Math.sqrt(1 - Math.min(1, qb.w * qb.w))
    const angle = 2 * Math.acos(Math.min(1, qb.w))
    if (s > 1e-6) vc.set(qb.x / s, qb.y / s, qb.z / s).multiplyScalar(angle)
    else vc.set(qb.x * 2, qb.y * 2, qb.z * 2)
    const av = body.angvel()
    const wr = tn.wr
    const cr = 2 * tn.zr * wr * h
    const denr = 1 + cr + wr * wr * h * h
    const ffy = yawRate
    ang.x = (av.x + wr * wr * h * vc.x) / denr
    ang.y = (av.y + wr * wr * h * vc.y + cr * ffy) / denr
    ang.z = (av.z + wr * wr * h * vc.z) / denr
    const spin = Math.hypot(ang.x, ang.y, ang.z)
    if (spin > MAX_SPIN) {
      ang.x *= MAX_SPIN / spin
      ang.y *= MAX_SPIN / spin
      ang.z *= MAX_SPIN / spin
    }
    sb.setVelocity(p.id, undefined, ang)

    // strain: how far off the beam it is, and whether the budget ran out
    sat += ((saturated ? 1 : 0) - sat) * 0.08
    const s1 = Math.min(1, err / (0.6 + dist * 0.05))
    strain += (Math.max(s1, sat * 0.8) - strain) * 0.12
    debug.err = err
    debug.speed = Math.hypot(lv.x, lv.y, lv.z)
    debug.saturated = saturated
  }
  let offSlice = sb.onBeforeSlice(beforeSlice)

  /* ------------------------------------------------ after the draw -- */

  const sync = () => {
    if (prop) {
      drawnPose(prop, va, qa)
      pointOf(va, qa, view.end)
      view.mode = 'hold'
      view.target.copy(target)
    } else if (rig) {
      rig.limbPos(limb, view.end)
      view.mode = 'hold'
      view.target.copy(target)
      const e = view.end.distanceTo(target)
      strain += (Math.min(1, e / (0.8 + dist * 0.05)) - strain) * 0.2
      if (e > TEAR) release(false)
    }
    view.strain = strain
    hold.strain = strain
    hold.dist = dist
    hold.target[0] = target.x
    hold.target[1] = target.y
    hold.target[2] = target.z
    hold.end[0] = view.end.x
    hold.end[1] = view.end.y
    hold.end[2] = view.end.z
    hold.rot[0] = rel.x
    hold.rot[1] = rel.y
    hold.rot[2] = rel.z
    hold.rot[3] = rel.w
  }

  return {
    hold,
    view,
    get holding() {
      return prop !== null || rig !== null
    },
    get capturesLook() {
      return hold.rotating
    },
    get prop() {
      return prop
    },
    update,
    sync,
    release,
    unfreezeAt,
    retarget: (next) => {
      if (next === sb) return
      if (prop || rig) release(false)
      for (const pin of pins) pin.rig.grab(pin.limb, null)
      pins.length = 0
      offSlice()
      sb = next
      offSlice = sb.onBeforeSlice(beforeSlice)
    },
    on: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    debug,
    dispose: () => {
      if (prop || rig) release(false)
      for (const pin of pins) pin.rig.grab(pin.limb, null)
      pins.length = 0
      offSlice()
      listeners.clear()
    },
  }
}
