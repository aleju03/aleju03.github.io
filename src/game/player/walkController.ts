import * as THREE from 'three'
import type { CollisionSet } from '../physics/collision'
import { resolveXZ, supportY } from '../physics/collision'
import { axis, held } from '../sandbox/bindings'

/*
  The first-person movement sim, React-free and renderer-free: it reads a
  key set, integrates velocity/gravity/crouch, resolves collision against
  whatever CollisionSet the current level hands it, and writes position and
  yaw/pitch onto the rig it was given (today that rig is the camera itself;
  in a networked future it's any object with a position and YXZ rotation).
  Feel notes carried over from the original tuning: velocity eases so steps
  start and stop with a little weight; gravity is heavy-ish so space is a
  hop, not a moon walk (apex ≈ v²/2g, a bit under half an eye height);
  crouch wins the argument with sprint; a faint footstep bob rides on how
  fast you actually move and is suspended mid-air; a sprint widens the lens
  a touch and the projection only re-bakes when it actually moved.

  Height is real: the feet track an absolute world y rather than an offset
  over one flat floor, and every tick asks collision.ts what the tallest
  surface under them is. So a hop clears the arm of the couch and lands on
  the cushion, a low ledge is climbed at a walk (tune.step), a drop taller
  than that is stepped off into a fall, and a surface too tall to climb is
  still a wall you slide along. The step/drop easing is smoothed rather than
  snapped so the lens rises onto furniture instead of teleporting.

  Height is also no longer one number per level. A level may hand over a
  `groundAt(x, z)` instead of a flat `groundY`, which is how the open world's
  terrain holds the player up: it is sampled *after* collision has resolved
  the step, so the floor being asked about is the one the feet actually ended
  on. Levels that are flat (the house, level 0) simply don't pass one.

  And where there is a `waterY`, deep enough water swims. Buoyancy is a spring
  toward a float height that keeps the eye just above the surface, under a
  tenth of normal gravity and a lot of drag; jump swims up, crouch dives, and
  planar speed drops by nearly half. It stays inside this module because it is
  the same integrator with different constants — the alternative, a wading
  wall at the shoreline, makes an ocean into scenery.

  While `frozen` (a level cut in flight) planar input and jumps are ignored
  but gravity and the crouch ease keep integrating, exactly like the old
  inline loop.

  And `noclip` is Garry's Mod's free flight, the third integrator in here and
  the simplest: no collision, no gravity, no ground. You fly where you look
  (pitch included, so W at the sky climbs), jump rises and c sinks straight
  up and down, sprint is fast and ctrl is slow (the key table's fly* rows). Velocity chases the
  wished one through an exponential ease, quicker to speed up than to coast
  down, which is what makes it feel like a body with a little mass rather
  than a camera on rails, and the lens banks a hair into a strafe. Switching
  it off anywhere simply hands the flight's velocity to the walk as a fall,
  so letting go mid-air drops you with the momentum you had, and letting go
  underground puts you back on the surface, because the landing test finds
  the feet already below the support.
*/

export interface WalkTuning {
  /** standing eye height over the surface underfoot */
  eye: number
  speed: number
  runSpeed: number
  crouchSpeed: number
  /** how far the eye sinks at full crouch */
  crouchDrop: number
  jumpV: number
  grav: number
  /** the tallest ledge a walk climbs (and the tallest drop it steps down
      rather than falling off). Scale it with `eye`, not with the metre */
  step: number
}

export interface WalkStepOpts {
  dt: number
  keys: ReadonlySet<string>
  /** a level transition holds the player still */
  frozen: boolean
  /** the current level's floor height — the surface under everything else */
  groundY: number
  /** per-position floor, for levels whose ground is not flat. Sampled after
      the planar step resolves, so it reports the ground actually arrived at.
      Takes precedence over `groundY`, which stays the fallback. */
  groundAt?: (x: number, z: number) => number
  /** the flat ceiling over it, where the level has one: the hop bonks off it
      instead of carrying the lens through */
  ceilingY?: number
  /** the waterline, where the level has one. Below it deep enough to cover
      the chest, the walk becomes a swim. */
  waterY?: number
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
  /** world velocity, units/s — what the body rig leans and swings from */
  vx: number
  vz: number
  /** vertical velocity while airborne (+ up), 0 on the ground */
  vy: number
  /** downward speed a touchdown absorbed this tick, else 0 (landing weight) */
  landing: number
  /** the surface the feet are standing on (or falling toward) this tick */
  support: number
  /** a sole landed this tick — one per bob cycle, at the bottom of the dip.
      The sim only reports it; the scene decides what a step sounds like */
  footfall: boolean
  /** the body is in water over its chest: buoyancy owns the vertical, planar
      speed is damped, and the scene should stop asking the ground what a
      footstep sounds like */
  swimming: boolean
  /** 0 dry .. 1 eye at the waterline; the scene tints and muffles with it */
  wet: number
  /** noclip: collision, gravity and the ground are all off this tick */
  flying: boolean
}

export interface WalkController {
  yaw: number
  pitch: number
  /** the shared footstep clock the body rig scissors its legs to */
  readonly bobT: number
  /** 0 standing .. 1 crouched, smoothed */
  readonly crouchK: number
  /** absolute world height of the soles — furniture tops included */
  readonly feetY: number
  /** free flight (see the header). Setting it mid-air carries the velocity
      across in both directions */
  noclip: boolean
  /** multiplies the walk's gravity: the console's `gravity` reaches the
      player through this. Clamped so nobody can be stranded in the sky */
  gravityScale: number
  /** mouse-look; sens is the player's multiplier, sign flips lock vs drag */
  turn: (dx: number, dy: number, sign: 1 | -1, sens: number) => void
  /** hard-place the player (level spawn): position, heading, floor underfoot */
  spawnAt: (x: number, z: number, yaw: number, feetY: number) => void
  /** move the feet without touching yaw/pitch (standing up where a ragdoll
      came to rest); feetY is absolute, so a body that settled on the sofa
      stands up on the sofa */
  teleport: (x: number, z: number, feetY: number) => void
  /** kill planar velocity only (the moment a level cut triggers) */
  haltPlanar: () => void
  /** zero all motion state (level swap, sitting down) */
  resetMotion: () => void
  /** one physics tick; moves and orients the rig, returns what happened */
  update: (o: WalkStepOpts) => WalkStep
}

/** clearance the eye keeps under a ceiling: enough that the near plane (0.1)
    never crosses it, and a jump into a low one reads as bumping your head */
const CROWN = 0.4

/** free flight's cruising speed, units/s: a little under three sprints,
    which crosses a town block in a couple of seconds. Sprint multiplies it,
    ctrl divides it */
const FLY_SPEED = 26
const FLY_FAST = 3.2
const FLY_SLOW = 0.22
/** the most downward speed a flight hands the fall that follows it, u/s */
const LAND_CARRY = 10

export function createWalkController(
  rig: THREE.PerspectiveCamera,
  tune: WalkTuning,
): WalkController {
  let yaw = 0
  let pitch = 0
  let crouchK = 0
  let feetY = 0 // absolute; the sole height, whatever it is standing on
  let vy = 0
  let grounded = true
  let bobT = 0
  let stride = 0 // which bob cycle the last voiced footfall belonged to
  let noclip = false
  let gravityScale = 1
  let bank = 0 // the flight's strafe roll, radians
  const fly = new THREE.Vector3() // the flight's velocity, all three axes
  /** what a flight hands the fall when noclip goes off mid-air: planar
      momentum that only air drag takes away, on top of the walk's own
      air control (which eases toward the keys at the same quick rate it
      does on the ground, and would otherwise stop a 26 u/s flyer dead in a
      few frames). Zero again the moment the feet touch anything */
  const drift = new THREE.Vector3()
  const wish = new THREE.Vector3()
  const vel = new THREE.Vector3()
  const want = new THREE.Vector3()
  // reused across ticks: the walk loop runs at 60Hz and shouldn't feed the GC
  const step: WalkStep = {
    planar: 0, gait: 0, grounded: true, duck: false, run: false, moved: false,
    vx: 0, vz: 0, vy: 0, landing: 0, support: 0, footfall: false,
    swimming: false, wet: 0, flying: false,
  }

  /** the flight tick: see the header */
  const flyStep = (o: WalkStepOpts): WalkStep => {
    const { dt, keys, frozen, waterY, fovBase } = o
    const fwd = frozen ? 0 : axis(keys, 'back', 'forward')
    const side = frozen ? 0 : axis(keys, 'left', 'right')
    const up = frozen ? 0 : axis(keys, 'flyDown', 'flyUp')
    const cp = Math.cos(pitch)
    // forward is the gaze, pitch and all; right stays level, so a strafe
    // never climbs; up is the world's up, not the camera's
    wish.set(
      (-Math.sin(yaw) * cp) * fwd + Math.cos(yaw) * side,
      Math.sin(pitch) * fwd + up,
      (-Math.cos(yaw) * cp) * fwd - Math.sin(yaw) * side,
    )
    const want = wish.length()
    if (want > 1) wish.multiplyScalar(1 / want)
    const speed =
      FLY_SPEED * (held(keys, 'flyFast') ? FLY_FAST : 1) * (held(keys, 'flySlow') ? FLY_SLOW : 1)
    wish.multiplyScalar(speed)
    // quicker to get going than to coast to a stop: the coast is the part
    // that reads as weight, and a snappy start is the part that reads as
    // control. Braking against the current velocity uses the quick rate too
    const braking = want > 0 && fly.dot(wish) < 0
    const rate = want > 0 ? (braking ? 9 : 5.5) : 2.6
    fly.lerp(wish, 1 - Math.exp(-rate * dt))
    rig.position.addScaledVector(fly, dt)
    crouchK += (0 - crouchK) * (1 - Math.exp(-11 * dt))
    feetY = rig.position.y - tune.eye
    vy = fly.y
    grounded = false
    // a hair of roll into the strafe, scaled by how fast the flight is going
    const planar = Math.hypot(fly.x, fly.z)
    const bankWant = -side * 0.045 * Math.min(1, fly.length() / FLY_SPEED)
    bank += (bankWant - bank) * (1 - Math.exp(-5 * dt))
    rig.rotation.x = pitch
    rig.rotation.y = yaw
    rig.rotation.z = bank
    // the lens widens with speed, more than a sprint does: at three times
    // cruise the world should visibly stream
    const k = Math.max(0, Math.min(1, (fly.length() - FLY_SPEED * 0.6) / (FLY_SPEED * 2.4)))
    const fovWant = fovBase + 12 * k
    if (Math.abs(rig.fov - fovWant) > 0.02) {
      rig.fov += (fovWant - rig.fov) * (1 - Math.exp(-6 * dt))
      rig.updateProjectionMatrix()
    }
    step.planar = planar
    step.gait = 0
    step.grounded = false
    step.duck = false
    step.run = false
    step.swimming = false
    step.flying = true
    step.wet =
      waterY === undefined
        ? 0
        : Math.min(1, Math.max(0, (waterY - feetY) / Math.max(0.01, tune.eye)))
    step.vx = fly.x
    step.vz = fly.z
    step.vy = fly.y
    step.landing = 0
    step.footfall = false
    step.support = feetY
    step.moved = fly.lengthSq() > 0.0025 || Math.abs(bank) > 1e-3
    return step
  }

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
    get feetY() {
      return feetY
    },
    get noclip() {
      return noclip
    },
    set noclip(on: boolean) {
      if (on === noclip) return
      noclip = on
      if (on) {
        // take off with whatever the walk was doing, so a toggle mid-jump
        // keeps the jump's drift instead of stopping dead in the air
        fly.set(vel.x, grounded ? 0 : vy, vel.z)
        grounded = false
      } else {
        // and land the same way round: the flight's velocity becomes a fall
        // that keeps its drift until it lands
        vel.set(0, 0, 0)
        drift.set(fly.x, 0, fly.z)
        // the planar drift is kept whole, the dive is not: letting go a hop
        // over a street while sinking must land you on your feet, and a real
        // drop still earns its flop from the gravity it falls through
        vy = Math.max(fly.y, -LAND_CARRY)
        grounded = false
        fly.set(0, 0, 0)
        bank = 0
        rig.rotation.z = 0
      }
    },
    get gravityScale() {
      return gravityScale
    },
    set gravityScale(k: number) {
      gravityScale = Math.max(0.1, Math.min(4, k))
    },
    turn: (dx, dy, sign, sens) => {
      const k = 0.0019 * sens
      yaw += sign * dx * k
      pitch = THREE.MathUtils.clamp(pitch + sign * dy * k, -1.35, 1.35)
    },
    spawnAt: (x, z, yawTo, y) => {
      feetY = y
      vy = 0
      fly.set(0, 0, 0)
      grounded = true
      rig.position.set(x, y + tune.eye, z)
      yaw = yawTo
      pitch = 0
    },
    teleport: (x, z, y) => {
      feetY = y
      vy = 0
      fly.set(0, 0, 0)
      grounded = true
      rig.position.set(x, y + tune.eye, z)
    },
    haltPlanar: () => {
      vel.set(0, 0, 0)
      drift.set(0, 0, 0)
      fly.set(0, 0, 0)
    },
    resetMotion: () => {
      vel.set(0, 0, 0)
      drift.set(0, 0, 0)
      fly.set(0, 0, 0)
      crouchK = 0
      vy = 0
      grounded = true
      bobT = 0
      stride = 0 // or the clock rewind reads as one phantom footfall
    },
    update: (o) => {
      if (noclip) return flyStep(o)
      const { dt, keys, frozen, groundY, groundAt, ceilingY, waterY, collision, fovBase } = o
      step.flying = false
      const grav = tune.grav * gravityScale
      const fwd = frozen ? 0 : axis(keys, 'back', 'forward')
      const side = frozen ? 0 : axis(keys, 'left', 'right')
      // shift sprints, ctrl (or c) crouches; crouching wins the argument
      const duck = held(keys, 'crouch')
      const run = !duck && held(keys, 'sprint')
      // deep enough to swim: the water is over the chest. Decided on last
      // tick's feet, before anything moves, so the mode can't flicker
      // mid-integration between the planar step and the vertical one
      const swimming = waterY !== undefined && waterY - feetY > tune.eye * 0.62
      const speed =
        (duck && !swimming ? tune.crouchSpeed : run ? tune.runSpeed : tune.speed) *
        (swimming ? 0.55 : 1)
      // no crouching in open water — the key is the dive control down there
      crouchK += ((duck && !swimming ? 1 : 0) - crouchK) * (1 - Math.exp(-11 * dt))
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
      const driftX = rig.position.x
      const driftZ = rig.position.z
      if (!grounded && !swimming) {
        drift.multiplyScalar(Math.exp(-0.35 * dt))
        rig.position.addScaledVector(drift, dt)
      } else drift.set(0, 0, 0)
      // a solid is only a wall where it overlaps the body: standing, ledges
      // up to tune.step are climbed through; airborne, nothing is, so a hop
      // has to clear a surface before it can carry over it
      const stepUp = grounded ? tune.step : 0
      resolveXZ(rig.position, collision, feetY, feetY + tune.eye, stepUp)
      // a wall met mid-drift takes that axis of the drift away
      if (drift.x !== 0 && Math.abs(rig.position.x - driftX) < Math.abs(drift.x * dt) * 0.5) drift.x = 0
      if (drift.z !== 0 && Math.abs(rig.position.z - driftZ) < Math.abs(drift.z * dt) * 0.5) drift.z = 0
      // whatever is under the feet now — the level floor unless a box top
      // stands between. The floor itself is per-position where the level says
      // so (terrain), and it is sampled here rather than before the move: the
      // ground that matters is the one the step actually landed on.
      const floorY = groundAt
        ? groundAt(rig.position.x, rig.position.z)
        : groundY
      const support = supportY(
        rig.position.x,
        rig.position.z,
        feetY + (grounded ? tune.step : 0.02),
        collision,
        floorY,
      )
      // space jumps; holding it bunny-hops off each landing
      if (!frozen && !swimming && held(keys, 'jump') && grounded && !duck) {
        grounded = false
        vy = tune.jumpV
      }
      step.landing = 0
      if (swimming && waterY !== undefined) {
        // buoyancy: a spring toward the height that floats the eye just clear
        // of the surface, under a tenth of gravity and a lot of drag. Jump
        // swims up, crouch dives; both are accelerations, so neither can beat
        // the spring far enough to launch the body out of the water
        grounded = false
        // the +0.8 is not where the eye ends up — it is the spring's rest
        // point, and the residual gravity below pulls the equilibrium down by
        // grav*0.1/6.5 ≈ 0.52 from it. Net: the eye settles a quarter unit
        // clear of the surface. Setting the rest point to the wanted height
        // instead left the head permanently just under water.
        const floatFeet = waterY + 0.8 - tune.eye
        vy += (floatFeet - feetY) * 6.5 * dt
        vy -= grav * 0.1 * dt
        if (!frozen && held(keys, 'jump')) vy += 30 * dt
        if (!frozen && duck) vy -= 30 * dt
        vy *= Math.exp(-3.4 * dt)
        feetY += vy * dt
        // the bottom is still the bottom: a shallow lake is stood in, not swum
        if (feetY <= support) {
          feetY = support
          if (vy < 0) vy = 0
        }
      } else if (!grounded) {
        vy -= grav * dt
        feetY += vy * dt
        if (vy <= 0 && feetY <= support) {
          feetY = support
          grounded = true
          step.landing = -vy // the impact the body rig folds its knees over
          vy = 0
        }
      } else if (feetY - support > tune.step) {
        // walked off the edge of something: fall from right here
        grounded = false
        vy = 0
      } else if (feetY !== support) {
        // climb a ledge / follow a small drop: eased, so the lens rides up
        // onto the couch instead of teleporting there
        feetY += (support - feetY) * (1 - Math.exp(-20 * dt))
        if (Math.abs(support - feetY) < 1e-4) feetY = support
      }
      // a low ceiling stops the rise: the lens keeps CROWN under it, which is
      // what stands between a hop and a look through the tiles. Outside the
      // airborne branch on purpose — climbing onto something under a low
      // ceiling has to be capped too — and floored at the support rather
      // than the level ground, or the cap would push the feet down through
      // whatever they are standing on.
      if (ceilingY !== undefined) {
        const cap = ceilingY - CROWN - tune.eye
        if (feetY > cap) {
          feetY = Math.max(support, cap)
          if (vy > 0) vy = 0
        }
      }
      // a faint footstep bob, scaled by how fast you actually move;
      // suspended in the air, where nobody is stepping on anything
      const planar = Math.hypot(vel.x, vel.z)
      if (grounded) bobT += planar * dt * 0.55
      // a footfall each time the bob bottoms out (phase 0.75) — the tick the
      // lens dips onto the planted sole, which is when a step should sound
      const strideNow = Math.floor(bobT + 0.25)
      step.footfall = grounded && strideNow !== stride
      stride = strideNow
      const gait = Math.min(1, planar / speed)
      rig.position.y =
        feetY +
        tune.eye -
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
      step.duck = duck && !swimming
      step.run = run
      step.swimming = swimming
      step.wet =
        waterY === undefined
          ? 0
          : Math.min(1, Math.max(0, (waterY - feetY) / Math.max(0.01, tune.eye)))
      step.vx = vel.x + drift.x
      step.vz = vel.z + drift.z
      step.vy = grounded ? 0 : vy
      step.support = support
      step.moved =
        planar > 0.05 || !grounded || Math.abs((duck ? 1 : 0) - crouchK) > 0.02 || feetY !== support
      return step
    },
  }
}
