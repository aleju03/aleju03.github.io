import * as THREE from 'three'
import { supportY } from '../physics/collision'
import { clamp, damp, angleDelta } from './chassis'
import type { DriveEnv, DriveStep, Vehicle } from './types'

/*
  The camera you drive from.

  The walk has chaseCam.ts, and it is the wrong shape for this. That boom
  hangs off the player's head and points wherever the mouse points, because a
  walker's lens *is* their gaze. A vehicle's is not: you look where the
  machine is going, and the camera's job is to make the machine legible —
  which way it is pointing, how fast, and whether the back end has let go.

  So this is a different instrument, with four ideas in it:

  - **It follows the heading, not the mouse.** The boom's own yaw chases the
    vehicle's, and the chase is *soft*: a hard turn swings the camera wide for
    a moment before it catches up, which is what makes a corner feel like a
    corner. The lag is speed-scaled — parked, it snaps into line so you can
    look around; at speed it trails.

  - **It leans on the drift.** When the tail steps out (`step.slip`) the boom
    yaws toward the direction of travel rather than the nose, so a slide is
    something you watch happen side-on instead of something that happens to
    the camera. Half a car length of offset is plenty; more and you cannot
    tell where the front is pointing.

  - **Speed is sold with the lens, not the number.** The boom stretches back
    and drops, and the fov opens, both on the same normalised speed. Nothing
    communicates 40 units a second in a world with no odometer like the frame
    widening around you.

  - **Free-look is a temporary opinion.** Dragging the mouse orbits the boom,
    and the offset decays back to centre once you let go and are moving. A
    camera that stays wherever you last flicked it is a camera you spend the
    whole drive fighting; one that snaps back instantly is one you cannot look
    out of the side window with. A second and a half of hold, then a gentle
    return, is the setting that stops feeling like either.

  Cockpit view (v) is the same instrument with the boom at zero: the lens sits
  at the vehicle's own eye point, rides its roll and pitch, and free-look
  becomes head movement with a wider range, since that is the only way to see
  out of the side of a helicopter. It lasts as long as the drive and no longer
  — `reset` puts every boarding back on the boom. Carrying it across is the
  kind of state that reads as a bug rather than a preference: you climb into a
  machine you have never driven, in a view you chose in a different one, and
  the first thing you see is the inside of a dashboard.

  Wall clamping reuses the walk boom's trick — sample down the ray, stop short
  of the first blocked point, shrink instantly and grow slowly — because a
  camera that eases *into* a wall shows you the inside of it for two frames,
  and two frames is all it takes to look broken.
*/

const MARGIN = 0.5
const SAMPLES = 10
/** how long the mouse stays "in charge" after the last movement */
const HOLD = 1.5

export interface DriveCam {
  /** mouse-look; same signature the walk uses so input.ts needs no branch */
  turn: (dx: number, dy: number, sign: 1 | -1, sens: number) => void
  /** chase or cockpit; the pause menu and v both write it */
  cockpit: boolean
  /** the heading the walker should adopt when they get out: where the player
      was actually looking, not where the machine was pointing */
  readonly yaw: number
  readonly pitch: number
  /** snap the boom into place with no interpolation (mount, respawn).
      `startYaw` seeds it with the heading the player was already facing, so
      climbing in swings the camera round to the machine instead of cutting */
  reset: (v: Vehicle, startYaw?: number) => void
  /** place the camera for this frame */
  apply: (
    cam: THREE.PerspectiveCamera,
    dt: number,
    v: Vehicle,
    step: DriveStep,
    env: DriveEnv,
    fovBase: number,
  ) => void
}

export function createDriveCam(): DriveCam {
  let cockpit = false
  /** the boom's own heading, chasing the vehicle's */
  let boomYaw = 0
  let boomPitch = 0.16
  /** the player's temporary offset from that, and how long it survives */
  let lookYaw = 0
  let lookPitch = 0
  let hold = 0
  let dist = 0
  let started = false
  // where the machine was last frame, so the boom can lean on the direction
  // it is actually travelling rather than the direction it is pointing —
  // measured here instead of asked for, which keeps world velocity out of the
  // DriveStep contract that three separate vehicles have to fill in
  let prevX = 0
  let prevZ = 0
  let travelYaw = 0

  const want = new THREE.Vector3()
  const probe = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const anchor = new THREE.Vector3()
  const focus = new THREE.Vector3()
  const smoothed = new THREE.Vector3()
  const lookAt = new THREE.Vector3()
  const lookM = new THREE.Matrix4()
  const up = new THREE.Vector3(0, 1, 0)

  const blocked = (p: THREE.Vector3, env: DriveEnv) => {
    if (p.y < env.groundAt(p.x, p.z) + MARGIN) return true
    if (p.y < supportY(p.x, p.z, p.y, env.collision, -1e9) + MARGIN) return true
    for (const b of env.collision.boxes) {
      if (
        p.x > b.min.x - MARGIN && p.x < b.max.x + MARGIN &&
        p.z > b.min.z - MARGIN && p.z < b.max.z + MARGIN &&
        p.y > b.min.y - MARGIN && p.y < b.max.y + MARGIN
      )
        return true
    }
    return false
  }

  return {
    get yaw() {
      return boomYaw + lookYaw
    },
    get pitch() {
      return -boomPitch + lookPitch
    },
    get cockpit() {
      return cockpit
    },
    set cockpit(v: boolean) {
      cockpit = v
    },
    turn: (dx, dy, sign, sens) => {
      const k = 0.0019 * sens
      lookYaw += sign * dx * k
      // the offset is bounded: past a half turn the boom has no idea which way
      // is forward any more, and neither does the player
      lookYaw = clamp(lookYaw, -2.6, 2.6)
      // positive is up, the same as the walk controller's pitch and the same
      // as the cockpit's rotateX below. The chase boom gets more room to look
      // down than up, because what a chase camera is for is seeing the machine
      lookPitch = clamp(lookPitch + sign * dy * k, cockpit ? -1.1 : -1.15, cockpit ? 1.0 : 0.75)
      hold = HOLD
    },
    reset: (v, startYaw) => {
      // every boarding starts on the boom, whatever the last drive ended on
      cockpit = false
      boomYaw = startYaw ?? v.yaw
      travelYaw = v.yaw
      boomPitch = 0.16
      lookYaw = 0
      lookPitch = 0
      hold = 0
      dist = 0
      // `started` stays true when a start heading was given: the first apply()
      // would otherwise snap the boom straight to the machine's yaw, which is
      // the swing this parameter exists to avoid
      started = startYaw !== undefined
      smoothed.set(0, 0, 0)
      prevX = v.root.position.x
      prevZ = v.root.position.z
    },
    apply: (cam, dt, v, step, env, fovBase) => {
      const view = v.view
      // `load` is the vehicle's own speed over its own top speed, so one
      // camera serves a 40 u/s car and a 75 u/s helicopter without a table
      const fast = clamp(step.load, 0, 1)
      // each machine has a field of view that suits it (a cockpit wants more
      // than a chase boom), and the player's own preference offsets it rather
      // than replacing it — the pause menu slider still means something at
      // the wheel
      const base = view.fov + (fovBase - 60)

      // which way the machine actually went this frame, in the same yaw
      // convention the rest of the runtime uses (forward is -z)
      const dx = v.root.position.x - prevX
      const dz = v.root.position.z - prevZ
      prevX = v.root.position.x
      prevZ = v.root.position.z
      if (dx * dx + dz * dz > 1e-6) travelYaw = Math.atan2(-dx, -dz)

      // the boom's heading chases the machine's, but a fast drift pulls it
      // toward where the machine is actually travelling instead
      let target = v.yaw
      if (step.slip > 0.12 && step.planar > 6) {
        target = v.yaw + angleDelta(v.yaw, travelYaw) * Math.min(0.55, step.slip * 0.8)
      }
      // parked, the boom snaps to heel so the player can look around; at speed
      // it trails, which is most of what a corner feels like
      const chase = cockpit ? 26 : 2.6 + fast * 5.5
      if (!started) {
        boomYaw = target
        started = true
      } else {
        boomYaw += angleDelta(boomYaw, target) * (1 - Math.exp(-chase * dt))
      }

      // the mouse's opinion decays once it stops being expressed — but only
      // while moving. Parked, a player looking at the scenery keeps their view
      if (hold > 0) hold -= dt
      else if (step.planar > 2.5) {
        const back = 1 - Math.exp(-1.9 * dt)
        lookYaw -= lookYaw * back
        lookPitch -= lookPitch * back
      }

      const yaw = boomYaw + lookYaw
      // pitch: a little more overhead the faster you go, so the road ahead
      // stays in frame instead of sliding under the bonnet
      boomPitch = damp(boomPitch, 0.14 + fast * 0.1, 4, dt)
      // the ray's pitch drops the boom down the arc, so *more* of it puts the
      // lens lower and tilts the view up. Free-look is stated the other way
      // round — positive is up, as everywhere else — so it adds here rather
      // than subtracting. Subtracting is what made the mouse invert at the
      // wheel: drag down, boom sinks, view rises
      const pitch = boomPitch + lookPitch

      v.root.updateMatrixWorld()

      if (cockpit) {
        anchor.copy(view.eye).applyMatrix4(v.root.matrixWorld)
        cam.position.copy(anchor)
        // the head rides the machine's own attitude, then looks where the
        // player looks. Reading the vehicle's quaternion rather than its yaw
        // is what makes a bank in the helicopter and a lean in a corner
        // actually felt rather than merely seen
        cam.quaternion.copy(v.root.quaternion)
        cam.rotateY(lookYaw)
        cam.rotateX(lookPitch)
        const fovWant = base + fast * 6
        if (Math.abs(cam.fov - fovWant) > 0.02) {
          cam.fov = damp(cam.fov, fovWant, 8, dt)
          cam.updateProjectionMatrix()
        }
        dist = 0
        return
      }

      anchor.copy(view.anchor).applyMatrix4(v.root.matrixWorld)
      // look a little ahead of the machine rather than at it: the frame then
      // belongs to where you are going, which is the whole point of a chase cam
      focus.copy(anchor)
      focus.x -= Math.sin(v.yaw) * (2 + fast * 7)
      focus.z -= Math.cos(v.yaw) * (2 + fast * 7)
      focus.y += view.up * 0.22

      const reach = view.back + view.stretch * fast
      dir.set(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch),
      )
      // sample outward along the boom and stop short of the first blocked one
      let free = 0
      for (let i = 1; i <= SAMPLES; i++) {
        const t = (i / SAMPLES) * reach
        probe.copy(anchor).addScaledVector(dir, -t)
        probe.y += view.up * (t / reach)
        if (blocked(probe, env)) break
        free = t
      }
      // a wall crushes the boom this frame; open ground gives it back slowly
      dist = free < dist ? free : damp(dist, free, 9, dt)

      want.copy(anchor).addScaledVector(dir, -dist)
      want.y += view.up * (dist / Math.max(0.001, reach))
      // and never let the lens drop through the floor when the boom is short
      const floor = Math.max(
        env.groundAt(want.x, want.z),
        supportY(want.x, want.z, want.y, env.collision, -1e9),
      )
      want.y = Math.max(want.y, floor + MARGIN)

      if (!smoothed.lengthSq()) smoothed.copy(want)
      // position is smoothed, but a shortening boom is not: a camera that
      // eases into a wall shows you the inside of it
      const grab = dist < 0.001 ? 1 : 1 - Math.exp(-(9 + fast * 8) * dt)
      smoothed.lerp(want, grab)
      cam.position.copy(smoothed)

      lookAt.copy(focus)
      lookM.lookAt(cam.position, lookAt, up)
      cam.quaternion.setFromRotationMatrix(lookM)

      const fovWant = base + fast * 11
      if (Math.abs(cam.fov - fovWant) > 0.02) {
        cam.fov = damp(cam.fov, fovWant, 6, dt)
        cam.updateProjectionMatrix()
      }
    },
  }
}
