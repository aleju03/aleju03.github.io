import * as THREE from 'three'
import type { CollisionSet } from '../physics/collision'
import { resolveXZ } from '../physics/collision'

/*
  The first-person movement sim, React-free and renderer-free: it reads a
  key set, integrates velocity/gravity/crouch, resolves collision against
  whatever CollisionSet the current level hands it, and writes position and
  yaw/pitch onto the rig it was given (today that rig is the camera itself;
  in a networked future it's any object with a position and YXZ rotation).
  Feel notes carried over from the original tuning: velocity eases so steps
  start and stop with a little weight; gravity is heavy-ish so space is a
  hop, not a moon walk (apex ≈ v²/2g ≈ 1.6 units, about knee height);
  crouch wins the argument with sprint; a faint footstep bob rides on how
  fast you actually move and is suspended mid-air; a sprint widens the lens
  a touch and the projection only re-bakes when it actually moved.

  While `frozen` (a level cut in flight) planar input and jumps are ignored
  but gravity and the crouch ease keep integrating, exactly like the old
  inline loop.
*/

export interface WalkTuning {
  /** standing eye height over the current ground */
  eye: number
  speed: number
  runSpeed: number
  crouchSpeed: number
  /** how far the eye sinks at full crouch */
  crouchDrop: number
  jumpV: number
  grav: number
}

export interface WalkStepOpts {
  dt: number
  keys: ReadonlySet<string>
  /** a level transition holds the player still */
  frozen: boolean
  /** the current level's floor height under the feet */
  groundY: number
  collision: CollisionSet
  /** the player's fov preference; sprinting stretches it slightly */
  fovBase: number
}

/** what a tick looked like, for the body rig, shadow flags and prompts.
    The controller reuses one instance across ticks — read it, don't keep it. */
export interface WalkStep {
  /** horizontal speed, units/s */
  planar: number
  /** 0..1, planar over the current speed cap */
  gait: number
  grounded: boolean
  duck: boolean
  run: boolean
  /** anything about the pose changed enough that shadow maps should re-bake */
  moved: boolean
}

export interface WalkController {
  yaw: number
  pitch: number
  /** the shared footstep clock the body rig scissors its legs to */
  readonly bobT: number
  /** 0 standing .. 1 crouched, smoothed */
  readonly crouchK: number
  /** feet height over the ground right now (jump arc) */
  readonly airY: number
  /** mouse-look; sens is the player's multiplier, sign flips lock vs drag */
  turn: (dx: number, dy: number, sign: 1 | -1, sens: number) => void
  /** hard-place the player (level spawn): position, heading, level floor */
  spawnAt: (x: number, z: number, yaw: number, groundY: number) => void
  /** kill planar velocity only (the moment a level cut triggers) */
  haltPlanar: () => void
  /** zero all motion state (level swap, sitting down) */
  resetMotion: () => void
  /** one physics tick; moves and orients the rig, returns what happened */
  update: (o: WalkStepOpts) => WalkStep
}

export function createWalkController(
  rig: THREE.PerspectiveCamera,
  tune: WalkTuning,
): WalkController {
  let yaw = 0
  let pitch = 0
  let crouchK = 0
  let jumpY = 0 // feet height over the ground while airborne
  let vy = 0
  let grounded = true
  let bobT = 0
  const vel = new THREE.Vector3()
  const want = new THREE.Vector3()
  // reused across ticks: the walk loop runs at 60Hz and shouldn't feed the GC
  const step: WalkStep = { planar: 0, gait: 0, grounded: true, duck: false, run: false, moved: false }

  return {
    get yaw() {
      return yaw
    },
    set yaw(v: number) {
      yaw = v
    },
    get pitch() {
      return pitch
    },
    set pitch(v: number) {
      pitch = v
    },
    get bobT() {
      return bobT
    },
    get crouchK() {
      return crouchK
    },
    get airY() {
      return jumpY
    },
    turn: (dx, dy, sign, sens) => {
      const k = 0.0019 * sens
      yaw += sign * dx * k
      pitch = THREE.MathUtils.clamp(pitch + sign * dy * k, -1.35, 1.35)
    },
    spawnAt: (x, z, yawTo, groundY) => {
      rig.position.set(x, groundY + tune.eye, z)
      yaw = yawTo
      pitch = 0
    },
    haltPlanar: () => {
      vel.set(0, 0, 0)
    },
    resetMotion: () => {
      vel.set(0, 0, 0)
      crouchK = 0
      jumpY = 0
      vy = 0
      grounded = true
      bobT = 0
    },
    update: ({ dt, keys, frozen, groundY, collision, fovBase }) => {
      const fwd = frozen
        ? 0
        : (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
          (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
      const side = frozen
        ? 0
        : (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
          (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
      // shift sprints, ctrl (or c) crouches; crouching wins the argument
      const duck = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC')
      const run = !duck && (keys.has('ShiftLeft') || keys.has('ShiftRight'))
      const speed = duck ? tune.crouchSpeed : run ? tune.runSpeed : tune.speed
      crouchK += ((duck ? 1 : 0) - crouchK) * (1 - Math.exp(-11 * dt))
      want.set(0, 0, 0)
      if (fwd || side) {
        want
          .set(
            -Math.sin(yaw) * fwd + Math.cos(yaw) * side,
            0,
            -Math.cos(yaw) * fwd - Math.sin(yaw) * side,
          )
          .normalize()
          .multiplyScalar(speed)
      }
      // ease the velocity so steps start and stop with a little weight
      vel.lerp(want, 1 - Math.exp(-10 * dt))
      rig.position.addScaledVector(vel, dt)
      resolveXZ(rig.position, collision)
      // space jumps; holding it bunny-hops off each landing
      if (!frozen && keys.has('Space') && grounded && !duck) {
        grounded = false
        vy = tune.jumpV
      }
      if (!grounded) {
        vy -= tune.grav * dt
        jumpY = Math.max(0, jumpY + vy * dt)
        if (jumpY === 0 && vy < 0) {
          grounded = true
          vy = 0
        }
      }
      // a faint footstep bob, scaled by how fast you actually move;
      // suspended in the air, where nobody is stepping on anything
      const planar = Math.hypot(vel.x, vel.z)
      if (grounded) bobT += planar * dt * 0.55
      const gait = Math.min(1, planar / speed)
      rig.position.y =
        groundY +
        tune.eye +
        jumpY -
        crouchK * tune.crouchDrop +
        (grounded ? Math.sin(bobT * Math.PI * 2) * (run ? 0.038 : 0.028) * gait : 0)
      rig.rotation.x = pitch
      rig.rotation.y = yaw
      rig.rotation.z = 0
      // the walk fov is the player's setting; a sprint widens the lens a
      // touch on top, and the projection only re-bakes when it moved
      const fovWant =
        fovBase +
        5 * Math.max(0, Math.min(1, (planar - tune.speed) / (tune.runSpeed - tune.speed)))
      if (Math.abs(rig.fov - fovWant) > 0.02) {
        rig.fov += (fovWant - rig.fov) * (1 - Math.exp(-8 * dt))
        rig.updateProjectionMatrix()
      }
      step.planar = planar
      step.gait = gait
      step.grounded = grounded
      step.duck = duck
      step.run = run
      step.moved = planar > 0.05 || !grounded || Math.abs((duck ? 1 : 0) - crouchK) > 0.02
      return step
    },
  }
}
