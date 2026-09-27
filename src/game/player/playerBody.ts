import * as THREE from 'three'
import { createRagdoll, type RagdollEnv } from './ragdoll'
import { supportY } from '../physics/collision'
import { seeded } from '../core/rand'
import { DEFAULT_LOOK, type PlayerLook } from './look'
import {
  B, BODY_Y0, BONE_COUNT, buildGirth, BONE_REST, CROWN_OFF, EYE_OFF, HELPERS, HIP_X, HIP_Y,
  NECK_OFF, SHIN, THIGH, WAIST_OFF, bindMatrixWorld, fallbackBodyGeometry, requestBodyGeometry,
  tickBodyBuilds, SHOULDER_X, SHOULDER_OFF, UARM, FARM,
} from './bodyShape'
import { makeBodyMaterial } from './bodyMaterial'

/*
  The player's body: a bean in the Fall Guys mould, one seamless soft
  surface whose top is the head, stubby arms ending in mittens and stubby
  legs growing out of it, in one of eight headgear (drawn in bodyShape.ts,
  painted in bodyMaterial.ts), and everything that makes it move. The Gang
  Beasts brawler before it was turned down for looking like parts taped
  together, too bulky, and for leaning so far into a run it looked like it
  was falling; the motion it had is kept, restrained. The same rig is worn by the local player, every remote player
  (`net/avatars.ts`), the town's pedestrians (`world/pedestrians.ts`), the
  seated pose in the vehicles and on the sofa, and the pause-sheet preview.

  Nothing here is keyframed. The pose is derived every frame from what the
  sim actually did, in three layers.

  **The stance.** The legs are a stepper, not a cycle: each sole is planted
  at a fixed world point, steps trigger on distance actually covered, the
  swinging foot glides to a spot predicted along the real velocity, and
  two-bone IK folds each leg over its foot, so side-steps, diagonals and
  backpedals step where the body is truly going and feet never slide. The
  hips waddle over the stance foot and roll with it, the trunk leans into
  acceleration and banks into turns, and a landing drops the hips on a damped
  spring in proportion to the impact.

  A run is the Fall Guys scurry: quick short steps rather than long bounds
  (a stub leg reaches about a third of a unit in front of its hip, so a long
  stride only ever straightened it into a peg), a small bounce off every
  footfall, a slight waddle, the trunk nearly upright (under ten degrees at
  a full run, where the brawler leaned fifty-five), and the arms swinging
  low and loose, fore and aft in time with the legs, the elbows bent a
  little more than a walk's. The swing runs a little behind the legs, the
  forearm later still, and every footfall nudges the arms out.

  What the swing may never do is fly. A version of this run fed the swing's
  size into the arms' *spread* as well and flung them "out and flailing":
  at a full run that summed past two radians, one mitten thrown up over the
  head and the other stuck out level, which the owner called almost scary.
  So on the ground the shoulders are capped (forward to about sixty degrees,
  back to fifty, out to about sixty) and only a jump, a fall, a get-up or
  an emote lifts those caps.

  In the air the body is never a stick: a jump leaves out of a squashed
  crouch that springs into a stretch (the walker has no wind-up, so the
  push-off is drawn in the first frames of flight), the legs split with one
  knee up and the other trailing, the arms trail and then go up and out as
  the body drops away under them, and a landing squashes all of it, head
  included, then bounces back through a stretch. Standing, the arms hang
  loose and well off the belly with a bend at the elbow, and every forearm
  lags its upper arm.

  **The springs.** Each arm joint rides an underdamped spring fed the body's
  own accelerations, so the arms lag, overshoot and flop. The gait swing
  itself goes straight onto the joint with the spring on top of it, because a
  run steps three times a second and these springs ring at about once: fed
  through them, the swing arrived at a seventh of its size and a sprinting
  body ran with its mittens at its hips; the chest rides a
  jelly spring over the waddle; the head and chest's look-tracking are
  springs in both axes. On top of those sit four point masses simulated in
  world space and hung back on bones: the top of the bean bobbles, the
  headgear's tails swing off their knot, the belly wobbles, and each mitten
  hangs off its wrist. Their damping is relative to the point they hang
  from, so a steady run carries them along instead of leaving them behind. They are what make the body
  read as soft: start, stop, turn or land and every one of them answers late.
  The trunk squashes on a landing and stretches on the rise.

  **The idle.** A bean never stands neutral: it rocks on soft knees with its
  arms held a little out from the flanks, and weaves, twisting and leaning,
  so no two idle frames are symmetrical. Every body also stands its own way: a lean, a tip,
  a cocked head and a higher arm drawn from a hash of the player's look
  (`persona`), so a group of them never matches. A walking or running arm swings low
  and fore and aft, capped well below the shoulder; only a reach, a stretch,
  a wave, a jump or a get-up takes an arm higher.

  **The personality.** Standing still is not parked: the body breathes,
  shifts its weight from foot to foot, blinks, glances about, and after a
  while does something (stretches, bounces, waves). All of it is procedural
  and all of it is spring targets, so an idle wave has the same weight as a
  running arm.

  The showy parts of that (lean, gaze-follow, glances, fidgets) scale with
  `pose.show`, so a chase camera or another player sees the full
  performance while the first-person lens keeps a level, out-of-frame head,
  and the whole body is discarded from the colour pass (`showHead`).

  **The ragdoll.** flop() hands every joint to the verlet sim in ragdoll.ts
  and update() drapes the bones back over the particles each frame; the
  secondary springs keep running and the trunk's volume wobbles on every
  impact, so a tumbling body's tails and mittens
  flail after it. Three things keep it from landing as one lump, which it
  did: the limbs are flung outward from the trunk the instant it goes limp
  (`fling`), mittens and feet windmill through the first second of a flight
  (`flail`) while being pulled out wide and down as if to catch the ground,
  and once on the ground a weak pull in the ground plane spreads
  them into a spread-eagle and levels the shoulders so the heap rolls onto
  its back or front (`sprawl`; a heap that lands face down is rolled over
  onto its back about its own spine, because a body face down under a big
  hat is only a hat), with generous one-sided separations keeping
  arms a belly's width off the body throughout. The bones are draped over
  the particles with joint limits (`limitTo`: the head only so far off the
  trunk, a thigh far forward but hardly back), so the one surface never
  folds itself double however the heap lands. The get-up is physical too,
  which is the part the robot before it faked: beginRecover() keeps the sim running and drives every
  particle toward the standing pose with muscle springs that tighten over a
  second, legs first, so the heap hauls itself up under gravity and wobbles,
  and only the last few frames blend the bones home. It ends with a shake of
  the head. See "Hooks for a sandbox" below for how anything else knocks a
  body over or picks one up by a limb.

  It is also the vehicle driver: sit() folds these same bones into a seated
  pose (slouched and squashed into the seat),
  then CrtScene reparents the group onto the machine's authored seat.
  Everything is smoothed and allocation-free per frame; the whole body is
  one skinned draw call.

  One number decides how big all of it is: the walker's eye height, landed on
  the top of the bean (see DESIGN_LENS below), so a bean stands no taller
  than the lens that looks out of it and reads small next to a door.

  Hooks for a sandbox (Rapier impacts, a physgun, a car), all on PlayerRig:

  - `hit(impulse, point)`: an impulse (MASS x units/s) delivered at a world
    point. A standing body goes limp with the motion it had; the particles
    near the point take most of it and the rest a share, so a blow to the
    head spins a body and a blow to the legs sweeps them. Hits stack on a body
    that is already down.
  - `flop(vx, vy, vz)`: go limp with the whole body thrown at a velocity.
  - `limbs` and `limbPos(i, out)`: thirteen named limb points with radii, in
    world space whatever the body is doing (a bone while standing, a particle
    while down). What a physics world needs to wrap spheres around, and what a
    grab beam needs to aim at; `nearestLimb(point)` answers "which one".
  - `grab(i, target, k)`: hold a limb toward a live world point, read by
    reference every substep, so the caller moves the vector and the body
    follows. Grabbing a standing body knocks it down first, because being
    picked up by an ankle is a ragdoll's whole purpose. `grab(i, null)` lets
    go; a held body never counts as settled.
  - `mass`: what `hit` divides an impulse by.
*/

export interface PlayerPose {
  dt: number
  /** 0..1, planar speed over the current cap */
  gait: number
  crouchK: number
  grounded: boolean
  run: boolean
  yaw: number
  pitch: number
  /** world planar velocity, units/s */
  vx: number
  vz: number
  /** vertical velocity while airborne (+ up) */
  vy: number
  /** downward speed absorbed by a touchdown this tick, else 0 */
  landing: number
  /** 0..1: a two-handed tool (the physgun) held out along the view, the
      right hand on its grip and the left under its barrel, both arms solved
      onto them. Eased in and out by the body; omitted is 0 */
  aim?: number
  /** 0..1: how hard the held thing is pulling (the physgun's strain): the
      trunk leans back against it */
  aimLoad?: number
  /** 0 under the first-person lens .. 1 watched from outside. Scales the
      cinematic layer (speed lean, gaze-follow, glances, fidgets), which
      reads great from a chase camera or another player but, with the lens
      riding the head, would shove your own body into the frame */
  show: number
  /** 0..1 in noclip: airborne without falling. The legs hang half-reached,
      the arms drift and the whole body bobs a little, the relaxed float of
      somebody with nowhere to land rather than the tuck of a jump */
  fly?: number
}

/** a point on the body a physics world, a grab beam or a camera can use */
export interface BodyLimb {
  name:
    | 'pelvis' | 'chest' | 'head' | 'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR'
    | 'handL' | 'handR' | 'kneeL' | 'kneeR' | 'footL' | 'footR'
  /** the ragdoll particle it is */
  index: number
  /** collision radius, world units (already scaled to this body) */
  radius: number
}

export interface PlayerRig {
  group: THREE.Group
  /** drive the skeleton one frame; env is only consulted while ragdolling
      or getting up */
  update: (pose: PlayerPose, env: RagdollEnv) => void
  /** fold the live avatar into its seated pose. The seat supplies the
      transform; this method owns only the articulated body shape. `fit`
      scales the folded body about its eye: 1 on the sofa, CABIN_FIT in the
      fleet's cabins (see there) */
  sit: (fit?: number, passenger?: boolean) => void
  /**
   * Draw the head, or don't. The camera *is* the head in first person, so a
   * visible one fills the lens with the inside of your own skull; `update`
   * decides this per frame from the boom length, and anything that holds a
   * pose *instead* of calling update (a vehicle seat, a sofa) has to say so
   * itself. Shadows keep the head either way.
   */
  showHead: (visible: boolean) => void
  /** hand the skeleton to the verlet sim, thrown with this velocity. On a
      body that is already down it adds the velocity to every particle */
  flop: (vx: number, vy: number, vz: number) => void
  /** an impulse (MASS x units/s) at a world point: see the header */
  hit: (impulse: THREE.Vector3, point: THREE.Vector3) => void
  /** start getting up. The caller must have already moved `group` to the
      get-up spot (and updated its world matrix); the heap is dragged there
      if it lies somewhere else entirely (a remote body whose owner already
      stood up elsewhere) */
  beginRecover: () => void
  /** ragdolling or mid-recovery: movement input is forfeit */
  readonly down: boolean
  /** strictly particle-driven, i.e. the caller must not re-pose the group */
  readonly ragdolling: boolean
  /** the ragdoll has tumbled to rest long enough that a get-up looks right,
      and nothing is holding it */
  readonly settled: boolean
  /** camera target while down: the chest particle, world space */
  focus: (out: THREE.Vector3) => THREE.Vector3
  /** where the feet should stand after a get-up (pelvis rest x/z, world) */
  getupSpot: (out: THREE.Vector3) => THREE.Vector3
  /** the body moved on its own (ragdoll, blend, landing spring, jiggle):
      shadows near it should re-bake even though the walker stands still */
  unrest: () => boolean
  /** the yaw the body actually faces: it lags the camera while standing
      (the head covers the gap) and only pivots after a big enough turn.
      The scene orients the group with this, not the raw camera yaw */
  readonly facing: number
  /** hard-set the facing (roam start, level spawn): no lazy pivot */
  face: (yaw: number) => void
  /** report the group's cosmetic offset from the walker's true position
      (first-person trail, pitch back-slide) each frame BEFORE update: the
      planted feet ride along with its changes instead of being stretched */
  trackSlide: (x: number, z: number) => void
  /** cancel any ragdoll/blend and zero the smoothed pose (level swap) */
  reset: () => void
  /** repaint this body. Colour is a uniform on the one material it has, so
      this is free and can never relink a shader: a look changed mid-walk
      must not cost the frame a compile (see the boot-cost section in the
      root CLAUDE.md) */
  setLook: (look: PlayerLook) => void
  /** the thirteen points a physics world or a grab beam can hold */
  readonly limbs: readonly BodyLimb[]
  /** a limb's world position, whatever the body is doing */
  limbPos: (i: number, out: THREE.Vector3) => THREE.Vector3
  /** the limb nearest a world point, and how far it is (surface, not centre) */
  nearestLimb: (p: THREE.Vector3) => { index: number; dist: number }
  /** hold a limb toward a live point (read by reference), or let go */
  grab: (i: number, target: THREE.Vector3 | null, k?: number) => void
  /** what `hit` divides an impulse by */
  readonly mass: number
  /** one frame of sitting: the slumped body breathes, the head lolls and
      turns, and the head, belly and mittens jiggle with whatever the seat is
      doing (they are simulated in world space, so a car's braking throws them
      forward). Call it instead of `update` while seated */
  seatedTick: (dt: number) => void
  /** play one of the idle fidgets now, on purpose: a wave, a stretch, a
      bounce on the toes, a look at your own hands. Ignored while down */
  emote: (kind: Emote) => void
}

export type Emote = 'stretch' | 'bounce' | 'wave' | 'look'

/*
  How big a body is.

  Every rig is the same drawing scaled by the standing eye height it is built
  for (the walker's EYE, 3.84), and the question is which point of the
  drawing that height lands on. It used to be the painted eyes (DESIGN_EYE),
  on the rule that two players on the same ground should meet each other's
  gaze. For a bean that made a giant: scale 1.75, the crown at 4.87 in the
  bind pose and 4.7 standing, which is the doorways' own 4.7, and in the
  upstairs room the chase camera saw little but yellow. A Fall Guys bean is
  small in its world, so the height now lands on the *crown* (DESIGN_LENS):
  scale 1.38, the top of the head at 3.84 in the bind pose and about 3.7
  standing on its soft knees, the painted eyes near 2.9, and the whole bean
  at four fifths of a door.

  The price is the one the old rule was written to avoid: a first-person lens
  looks slightly down onto another player's face rather than level into it.
  That is the proportion asked for (you are a small thing peering over the
  top of your own head), and it is the same for everyone, so nobody sees
  anybody else as a different size. What must *not* happen is scaling by one
  point and placing by another, so anything that converts between the lens
  and the body goes through bodyScale / DESIGN_LENS, never DESIGN_EYE.
*/
/** where the painted eyes are in the drawing (the seated fold hangs from it) */
export const DESIGN_EYE = HIP_Y + WAIST_OFF + NECK_OFF + EYE_OFF // 2.19
/** the top of the head and its band: what anything floating over a head clears */
export const DESIGN_CROWN = HIP_Y + WAIST_OFF + NECK_OFF + CROWN_OFF // 2.78
/** the point of the drawing a standing lens height is scaled onto */
export const DESIGN_LENS = DESIGN_CROWN
export const bodyScale = (eye: number) => eye / DESIGN_LENS

/*
  The seated fold, in the same units.

  A chunky body is mostly trunk, and a trunk does not fold: this one is a
  good deal taller sitting down than the long-legged robot was, and the car
  was drawn round the robot. So sitting squashes. The pelvis bone (and so
  everything on it) flattens by SIT_SQUASH and spreads a little, the head is
  counter-scaled so the face stays round, the chest slouches back and the
  neck settles into the shoulders. Soft bodies do exactly that on a seat, and
  it is what keeps the head under a car's roof while the seat of the pants
  stays above its floor.
*/
const SIT_SQUASH = 0.7
const SIT_SPREAD = 1.0
const SIT_WAIST = 0.08
const SIT_NECK = NECK_OFF * 0.82
const SIT_SLOUCH = 0.16
/** the seated eye over the pelvis bone, and over the lowest point of the
    seated body (the seat of the pants), design units at the group's scale */
const seatedEye = () => {
  // the chain pelvis -> torso -> head, evaluated with plain matrices
  const m = new THREE.Matrix4().makeScale(SIT_SPREAD, SIT_SQUASH, SIT_SPREAD)
  const t = new THREE.Matrix4()
    .makeTranslation(0, SIT_WAIST, 0)
    .multiply(new THREE.Matrix4().makeRotationX(-SIT_SLOUCH))
  const h = new THREE.Matrix4()
    .makeTranslation(0, SIT_NECK, 0)
    .multiply(new THREE.Matrix4().makeRotationX(SIT_SLOUCH))
    .multiply(new THREE.Matrix4().makeScale(1 / SIT_SPREAD, 1 / SIT_SQUASH, 1 / SIT_SPREAD))
  const eye = new THREE.Vector3(0, EYE_OFF, 0).applyMatrix4(h).applyMatrix4(t).applyMatrix4(m)
  return eye
}
const SEAT_EYE_VEC = seatedEye()
/** how far a seated body's eye sits above its pelvis bone, design units */
export const DESIGN_SEAT_EYE = SEAT_EYE_VEC.y
/** ...and above the seat of its pants: what a cushion is measured against */
export const DESIGN_SEAT_BOTTOM = DESIGN_SEAT_EYE + (HIP_Y - BODY_Y0) * SIT_SQUASH
/*
  The fleet's cabins were drawn round the robot this body replaced, which sat
  about 1.35 world units from eye to seat. Even squashed, this one needs about
  1.7 (DESIGN_SEAT_BOTTOM x bodyScale), so in a car or a helicopter its seat
  of the pants went through the sill and its boots hung under the fuselage,
  so the cabins folded it smaller about its eye (`userData.fit` on a seat
  node, this as the default), which leaves the face exactly on the seat node.
  Scaled onto its crown instead of its eyes (see DESIGN_LENS) the body is
  0.79 of that size, which is smaller than the boat's and the helicopter's
  old folds already made it, so they sit at 1; only the car's side window
  still asks for a fold (see car.ts).
*/
export const CABIN_FIT = 1

// ragdoll particle indices. The first thirteen are the limbs a caller can
// name; the belly and the back are collision only, so a body lying on
// its back rests on its pack and a body on its front on its belly
const P_PELV = 0
const P_CHEST = 1
const P_HEAD = 2
const P_SHL = 3
const P_SHR = 4
const P_ELL = 5
const P_ELR = 6
const P_HANDL = 7
const P_HANDR = 8
const P_KNEEL = 9
const P_KNEER = 10
const P_FOOTL = 11
const P_FOOTR = 12
const P_BELLY = 13
const P_PACK = 14
const P_COUNT = 15
const LIMB_NAMES: BodyLimb['name'][] = [
  'pelvis', 'chest', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR',
  'handL', 'handR', 'kneeL', 'kneeR', 'footL', 'footR',
]
/** design-unit radii per particle, and relative masses: a heavy head and
    trunk, light mittens, so a tumble leads with the head and the hands flap */
/** the expressions a look can hash to (bodyMaterial's uFace), pills weighted */
const FACES = [0, 0, 0, 1, 2, 0, 3, 4]
const RADII = [0.55, 0.56, 0.5, 0.2, 0.2, 0.15, 0.15, 0.17, 0.17, 0.19, 0.19, 0.18, 0.18, 0.62, 0.46]
const MASSES = [3, 2.6, 2.4, 0.9, 0.9, 0.6, 0.6, 0.45, 0.45, 0.9, 0.9, 0.8, 0.8, 1.2, 0.6]
/** the whole body, for turning an impulse into a velocity */
const MASS = 70

/** how fast the body accepts being spun or shoved before it simply stops
    answering harder: ~1.1 turns a second, and a standing start's worth of
    acceleration. Past these the pose would stop tracking the body and start
    tracking the mouse, which is what throws the arms out on a fast circle */
const YAW_CAP = 7
const ACC_CAP = 45
const clampRate = (v: number, cap: number) => (v > cap ? cap : v < -cap ? -cap : v)

/** getting up: the whole of it, and the fraction spent gathering into the
    crouch before the push. The muscle ramp and the final blend key off it */
const RISE_TIME = 1.25
const RISE_FOLD = 0.4
const SMOOTH = (t: number) => t * t * (3 - 2 * t)
const ramp = (a: number, b: number, t: number) => SMOOTH(THREE.MathUtils.clamp((t - a) / (b - a), 0, 1))

/** rigs are seeded apart so a crowd does not blink and fidget in unison */
let rigSerial = 0
/** start the serial over: a harness that stages the same scene twice in one
    page (a film's stills, then its video) must build the same bodies */
export const resetRigSerial = () => {
  rigSerial = 0
}

/** the inverse bind matrices. The bind pose is the rest pose except for the
    upper arms, which the surface was drawn holding out (see bodyShape's
    ARM_BIND), so a rig whose rotations are all identity hangs its arms
    straight down and nothing that poses it has to know. Shared, since every
    body is the same drawing */
let BIND: THREE.Matrix4[] | null = null
const bindInverses = () =>
  (BIND ??= Array.from({ length: BONE_COUNT }, (_, i) => bindMatrixWorld(i, new THREE.Matrix4()).invert()))

export function buildPlayerBody(
  eye: number,
  grav = 34,
  look: PlayerLook = DEFAULT_LOOK,
): PlayerRig {
  const group = new THREE.Group()
  group.userData.dynamic = true // never caught by the static matrix freeze
  const S = bodyScale(eye)
  const rnd = seeded(0x5eed + 7919 * rigSerial++)

  // --- skeleton -------------------------------------------------------------
  // limbs hang along local -Y from their joint; the trunk and head grow +Y
  const bones: THREE.Bone[] = BONE_REST.map(({ at }) => {
    const b = new THREE.Bone()
    b.position.set(at[0], at[1], at[2])
    return b
  })
  BONE_REST.forEach(({ parent }, i) => (parent === -1 ? group : bones[parent]).add(bones[i]))
  const pelvis = bones[B.PELVIS]
  const torso = bones[B.TORSO]
  const head = bones[B.HEAD]
  const uarmL = bones[B.UARM_L]
  const farmL = bones[B.FARM_L]
  const handL = bones[B.HAND_L]
  const uarmR = bones[B.UARM_R]
  const farmR = bones[B.FARM_R]
  const handR = bones[B.HAND_R]
  const thighL = bones[B.THIGH_L]
  const shinL = bones[B.SHIN_L]
  const ankleL = bones[B.FOOT_L]
  const thighR = bones[B.THIGH_R]
  const shinR = bones[B.SHIN_R]
  const ankleR = bones[B.FOOT_R]
  const pom = bones[B.POM]
  const pack = bones[B.PACK]
  const REST = BONE_REST.map(({ at }) => new THREE.Vector3(at[0], at[1], at[2]))

  /*
    The arms hang off the torso, and the torso's bone carries the trunk's
    squash-and-stretch as a non-uniform scale. A child inherits that scale in
    its parent's frame, so an arm swung level in a landing came out stretched
    along the torso's widened axis, twice its length and hose-thin. Undoing
    it with the arm's own scale is wrong too: a bone's scale is applied in its
    own (rotated) frame, which for a level arm multiplied the stretch instead.
    What undoes it is the inverse squash in the *parent's* frame, before the
    arm's rotation, which a plain Object3D cannot express, so the two upper
    arms compose their own matrix: position, then the inverse squash, then
    the rotation.
  */
  const armInv = new THREE.Vector3(1, 1, 1)
  const armS = new THREE.Matrix4()
  const armUnsquash = (bone: THREE.Bone) => {
    bone.updateMatrix = () => {
      bone.matrix.makeRotationFromQuaternion(bone.quaternion)
      bone.matrix.premultiply(armS.makeScale(armInv.x, armInv.y, armInv.z))
      bone.matrix.setPosition(bone.position)
      bone.matrixWorldNeedsUpdate = true
    }
  }
  armUnsquash(uarmL)
  armUnsquash(uarmR)

  // plain anchors the ragdoll and the limb list read: where a particle sits
  // on a bone that is not itself a joint
  const anchor = (parent: THREE.Object3D, x: number, y: number, z: number) => {
    const o = new THREE.Object3D()
    o.position.set(x, y, z)
    parent.add(o)
    return o
  }
  const skullC = anchor(head, 0, 0.34, 0)
  const mittL = anchor(handL, 0, -0.1, 0)
  const mittR = anchor(handR, 0, -0.1, 0)
  const soleL = anchor(shinL, 0, -SHIN, 0)
  const soleR = anchor(shinR, 0, -SHIN, 0)
  const bellyC = anchor(torso, 0, 0.0, 0.05)
  // the back of the bean: what a body lying face up rests on
  const backC = anchor(torso, 0, 0.35, -0.2)

  /*
    Every body stands its own way. A handful of offsets (how far it leans,
    which way it tips, how its head cocks, how high each arm reaches) are
    drawn from a hash of the player's own look, so a group never matches and
    everybody's client agrees on how a given player stands, with no extra
    field on the wire.
  */
  const persona = { lean: 0, roll: 0, tilt: 0, armL: 0, armR: 0, face: 0, girth: 1 }
  const personaFor = (l: PlayerLook) => {
    let h = 2166136261
    for (const ch of `${l.shell}${l.trim}${l.accent}${l.glow}${l.hat ?? 0}`) {
      h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
    }
    const r = seeded(h)
    persona.lean = r() * 0.06
    persona.roll = (r() - 0.5) * 0.24
    persona.tilt = (r() - 0.5) * 0.4
    // one arm always reaches further than the other
    const lo = r() * 0.25
    const hi = 0.3 + r() * 0.35
    const leftHigh = r() < 0.5
    persona.armL = leftHigh ? hi : lo
    persona.armR = leftHigh ? lo : hi
    // the face is hashed from the look too, so it costs no field on the wire
    // mostly the plain pill eyes a bean is recognised by, now and then one
    // of the other four
    persona.face = FACES[h % FACES.length]
    persona.girth = buildGirth(l.build ?? 0)
  }
  personaFor(look)

  // --- the mesh -------------------------------------------------------------
  const paint = makeBodyMaterial(look)
  // the geometry is the one for this body's headgear; a repaint that changes
  // hat swaps it (see setLook)
  let hatNow = look.hat ?? 0
  let buildNow = look.build ?? 0
  paint.setFace(persona.face)
  // a variant not built yet is queued and the body wears a built one until
  // it lands (see bodyShape's tickBodyBuilds): building it on the spot is a
  // dropped frame whenever a stranger in a new hat walks into view
  let geoPending = false
  const wear = () => {
    const g = requestBodyGeometry(hatNow, buildNow)
    geoPending = !g
    return g ?? fallbackBodyGeometry(buildNow)
  }
  const mesh = new THREE.SkinnedMesh(wear(), paint.material)
  mesh.castShadow = true
  mesh.frustumCulled = false // hugs the camera; culling would blink limbs out
  // for callers that do cull it (remote bodies): a fixed sphere round the
  // standing body, rather than one computed from skinned vertices on demand
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.5, 0), 2.1)
  group.add(mesh)
  group.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton(bones, bindInverses()), new THREE.Matrix4())

  let headShown = true
  const showHead = (v: boolean) => {
    if (headShown === v) return
    headShown = v
    paint.hideHead(!v)
  }

  group.scale.setScalar(S)

  // --- ragdoll --------------------------------------------------------------
  const anchors: THREE.Object3D[] = []
  anchors[P_PELV] = pelvis
  anchors[P_CHEST] = head // the bone origin is the neck base
  anchors[P_HEAD] = skullC
  anchors[P_SHL] = uarmL
  anchors[P_SHR] = uarmR
  anchors[P_ELL] = farmL
  anchors[P_ELR] = farmR
  anchors[P_HANDL] = mittL
  anchors[P_HANDR] = mittR
  anchors[P_KNEEL] = shinL
  anchors[P_KNEER] = shinR
  anchors[P_FOOTL] = soleL
  anchors[P_FOOTR] = soleR
  anchors[P_BELLY] = bellyC
  anchors[P_PACK] = backC
  const radii = RADII.map((r) => r * S)
  const rag = createRagdoll(radii, [
    // bone edges
    { a: P_PELV, b: P_CHEST },
    { a: P_CHEST, b: P_HEAD },
    { a: P_CHEST, b: P_SHL },
    { a: P_CHEST, b: P_SHR },
    { a: P_SHL, b: P_ELL },
    { a: P_SHR, b: P_ELR },
    { a: P_ELL, b: P_HANDL },
    { a: P_ELR, b: P_HANDR },
    { a: P_PELV, b: P_KNEEL },
    { a: P_PELV, b: P_KNEER },
    { a: P_KNEEL, b: P_FOOTL },
    { a: P_KNEER, b: P_FOOTR },
    // braces: a rigid trunk wedge (the belly and pack ride it), a neck that
    // resists folding flat, and soft tethers keeping the legs in orbit
    { a: P_SHL, b: P_SHR },
    { a: P_PELV, b: P_SHL },
    { a: P_PELV, b: P_SHR },
    { a: P_BELLY, b: P_PELV },
    { a: P_BELLY, b: P_CHEST },
    { a: P_BELLY, b: P_SHL },
    { a: P_BELLY, b: P_SHR },
    { a: P_PACK, b: P_CHEST },
    { a: P_PACK, b: P_SHL },
    { a: P_PACK, b: P_SHR },
    { a: P_PACK, b: P_PELV },
    { a: P_PACK, b: P_BELLY },
    // the neck: the head is heavy and must flop, but stay *on* it. At half
    // strength these let it fold flat beside the shoulders, which reads as a
    // head that has come off rather than one that has lolled
    { a: P_HEAD, b: P_SHL, stiff: 0.9 },
    { a: P_HEAD, b: P_SHR, stiff: 0.9 },
    { a: P_HEAD, b: P_BELLY, stiff: 0.75 },
    { a: P_HEAD, b: P_PELV, stiff: 0.35 },
    { a: P_CHEST, b: P_KNEEL, stiff: 0.06 },
    { a: P_CHEST, b: P_KNEER, stiff: 0.06 },
  ],
    // self-collision: one-sided, so a heap can fold as tightly as it likes
    // right up to where a limb would pass through another. Kept soft (a hard
    // push fights the bones and buzzes) and to the pairs that actually cross.
    // Design units, scaled like the radii.
    (
      [
        // generous on purpose: these are what splay a heap. A limp body
        // whose arms may rest against its belly lands as one lump with its
        // arms tucked; one whose mittens keep a belly's width off it lands
        // spread-eagled, which is the whole comedy of a ragdoll
        { a: P_KNEEL, b: P_KNEER, min: 0.58, stiff: 0.45 },
        { a: P_FOOTL, b: P_FOOTR, min: 0.7, stiff: 0.35 },
        { a: P_ELL, b: P_ELR, min: 0.9, stiff: 0.35 },
        { a: P_HANDL, b: P_HANDR, min: 0.8, stiff: 0.3 },
        { a: P_ELL, b: P_BELLY, min: 0.78, stiff: 0.4 },
        { a: P_ELR, b: P_BELLY, min: 0.78, stiff: 0.4 },
        { a: P_HANDL, b: P_BELLY, min: 1.15, stiff: 0.35 },
        { a: P_HANDR, b: P_BELLY, min: 1.15, stiff: 0.35 },
        { a: P_HANDL, b: P_PELV, min: 0.75, stiff: 0.35 },
        { a: P_HANDR, b: P_PELV, min: 0.75, stiff: 0.35 },
        { a: P_HANDL, b: P_HEAD, min: 0.72, stiff: 0.35 },
        { a: P_HANDR, b: P_HEAD, min: 0.72, stiff: 0.35 },
        // and never tucked under the chest or behind the back: a mitten
        // folded under a body lying on its front is a limb nobody can see
        { a: P_HANDL, b: P_CHEST, min: 0.95, stiff: 0.35 },
        { a: P_HANDR, b: P_CHEST, min: 0.95, stiff: 0.35 },
        { a: P_HANDL, b: P_PACK, min: 0.8, stiff: 0.3 },
        { a: P_HANDR, b: P_PACK, min: 0.8, stiff: 0.3 },
        { a: P_FOOTL, b: P_BELLY, min: 0.9, stiff: 0.3 },
        { a: P_FOOTR, b: P_BELLY, min: 0.9, stiff: 0.3 },
        { a: P_KNEEL, b: P_BELLY, min: 0.62, stiff: 0.35 },
        { a: P_KNEER, b: P_BELLY, min: 0.62, stiff: 0.35 },
        { a: P_HEAD, b: P_KNEEL, min: 0.75, stiff: 0.35 },
        { a: P_HEAD, b: P_KNEER, min: 0.75, stiff: 0.35 },
      ] as const
    ).map((s) => ({ ...s, min: s.min * S })),
  grav, MASSES)
  const limbs: BodyLimb[] = LIMB_NAMES.map((name, index) => ({
    name, index, radius: radii[index],
  }))

  // --- state ----------------------------------------------------------------
  type Mode = 'up' | 'down' | 'rising'
  let mode: Mode = 'up'
  let downTime = 0
  let riseT = 0
  let riseFold = 0 // 0 standing .. 1 gathered into the get-up crouch
  let flops = 0
  let grabs = 0
  /** what the mesh's culling flag was before a flop switched it off */
  let cullWas = false
  /** the last pose velocity, so a hit on a walking body keeps its motion */
  const lastVel = new THREE.Vector3()

  // smoothed kinetics
  let fwdS = 0 // forward speed, local
  let sideS = 0
  let accF = 0 // forward acceleration
  let accS = 0 // sideways acceleration
  let lastFwd = 0
  let lastSide = 0
  let lastYaw = 0
  let yawRateS = 0
  let strafeYaw = 0
  let airK = 0
  let fallK = 0 // within air: 0 rising .. 1 falling
  let flyK = 0 // noclip's float, eased
  let springP = 0 // landing spring on the pelvis, design units (<= 0)
  let springV = 0
  let wobP = 0 // the jelly wobble on the trunk's volume
  let downMotion = 0 // the heap's speed last frame, for the wobble's kicks
  // sitting: whether sit() owns the pose, and its personality
  let seated = false
  let seatT = 0
  let seatTilt = 0
  let seatLook = 0
  let wobV = 0
  let idleT = 0
  let stillT = 0 // seconds without meaningful motion, for the fidgets

  // the stepper: feet live in world space and only move when a step moves
  // them, so nothing ever slides. stepT advances with distance actually
  // covered: its integer part names the swinging foot, its fraction is the
  // swing phase, which makes stride direction follow the real velocity
  let stepT = 0
  let strideNow = 0.8 // design units; a run stretches it
  let needReplant = true
  let wasGrounded = true
  let mCos = 1 // smoothed travel direction in the body frame (arm swing)
  let aimK = 0 // the right arm raised for a tool, eased
  let mSin = 0
  // the body faces where it last committed, not the camera: standing, the
  // gaze wanders freely and only past ~40 degrees do the feet pivot after it
  let facing = 0
  let facingSet = false
  let turnActive = false
  // cosmetic offsets (first-person trail, pitch back-slide) the planted
  // feet must ride along with; only real movement leaves them behind
  let slideX = 0
  let slideZ = 0
  let slideSet = false
  const plantedL = new THREE.Vector3() // current sole positions, world
  const plantedR = new THREE.Vector3()
  const swingFrom = new THREE.Vector3()
  const swingTarget = new THREE.Vector3()

  // personality clocks: when to blink next, where the eyes wander, and the
  // fidget a long idle turns into
  let blinkIn = 1 + rnd() * 3
  let blinkT = -1
  let doubleBlink = false
  let glanceIn = 2 + rnd() * 3
  let glanceYaw = 0
  let glancePitch = 0
  let glanceHold = 0
  type Fidget = Emote
  /** an emote asked for from outside plays even for a body nobody is
      watching closely; an idle fidget only for one somebody is */
  let fidgetForced = false
  let fidget: Fidget | null = null
  let fidgetT = 0
  let fidgetIn = 6 + rnd() * 5
  const FIDGET_LEN: Record<Fidget, number> = { stretch: 2.2, bounce: 1.3, wave: 2.0, look: 2.4 }
  let shakeT = -1 // the head-shake that ends a get-up

  // scratch (per-frame math stays allocation-free)
  const jointW = Array.from({ length: P_COUNT }, () => new THREE.Vector3())
  const lp = Array.from({ length: P_COUNT }, () => new THREE.Vector3())
  const riseTargets = Array.from({ length: P_COUNT }, () => new THREE.Vector3())
  const riseK = new Float32Array(P_COUNT)
  const groupInv = new THREE.Matrix4()
  const mTmp = new THREE.Matrix4()
  const xA = new THREE.Vector3()
  const yA = new THREE.Vector3()
  const zA = new THREE.Vector3()
  const vTmp = new THREE.Vector3()
  const vTmp2 = new THREE.Vector3()
  const dirTmp = new THREE.Vector3()
  const refX = new THREE.Vector3()
  const qPelv = new THREE.Quaternion()
  const qSeg = new THREE.Quaternion()
  const qInv = new THREE.Quaternion()
  const qUpper = new THREE.Quaternion()
  const qLower = new THREE.Quaternion()
  const qGroupInv = new THREE.Quaternion()
  const qIK = new THREE.Quaternion()
  const qAir = new THREE.Quaternion()
  const qW = new THREE.Quaternion()
  const eTmp = new THREE.Euler()
  const vHip = new THREE.Vector3()
  const vFoot = new THREE.Vector3()
  const vKnee = new THREE.Vector3()
  const vPole = new THREE.Vector3()
  const vRest = new THREE.Vector3()
  const vVel = new THREE.Vector3()
  const velTmp = new THREE.Vector3()
  const TAILS = new THREE.Vector3(0, -0.55, -0.83).normalize()
  const DOWN = new THREE.Vector3(0, -1, 0)

  /** the bones a pose is made of, in the order the get-up blends them */
  const POSED = [
    pelvis, torso, head, uarmL, farmL, handL, uarmR, farmR, handR,
    thighL, shinL, ankleL, thighR, shinR, ankleR,
  ]
  const capQ = POSED.map(() => new THREE.Quaternion())

  // the damped springs everything expressive rides on: position at even
  // indices, velocity at odd. Semi-implicit Euler, with a clamp as insurance
  // against a pathological frame time.
  // 0..11: arms ([shoulderX, shoulderZ, elbow] x L/R)
  // 12: chest look-yaw, 14: head look-yaw, 16: head look-pitch
  // 18: chest look-pitch, 20: chest jelly roll, 22: chest jelly pitch
  const sprS = new Float64Array(24)
  /** the springs at rest: zero everywhere but the arms' spread, which
      starts where a standing body holds them. From zero, every new body
      spent its first frames with both arms hanging straight into its own
      flanks */
  const restSprings = () => {
    sprS.fill(0)
    sprS[2] = sprS[8] = 0.6 + (persona.girth - 1) * 0.9
  }
  restSprings()
  const spring = (
    i: number, target: number, K: number, C: number, force: number, dt: number,
    lo = -2.8, hi = 2.8,
  ) => {
    sprS[i + 1] += ((target - sprS[i]) * K - C * sprS[i + 1] + force) * dt
    sprS[i + 1] = THREE.MathUtils.clamp(sprS[i + 1], -24, 24)
    sprS[i] = THREE.MathUtils.clamp(sprS[i] + sprS[i + 1] * dt, lo, hi)
    return sprS[i]
  }
  // joint limits for the sprung arms. The springs are fed the body's own
  // inertia as a force, and mouse-look can hand them accelerations no body
  // ever feels: these are the shoulder and elbow simply running out of
  // travel, the same way a real one does
  const SH_X_LO = -3.0
  const SH_X_HI = 1.4
  const SH_Z_LO = -0.3
  const SH_Z_HI = 2.9
  const EL_LO = -2.4
  const EL_HI = 0.12

  /*
    The five point masses (head, headgear tails, belly, two mittens). Each is a
    particle simulated in world space that chases where its bone would put it,
    then hangs the bone back on wherever it actually got to. That is the whole
    trick to secondary motion: the bone's rest is driven by the pose, the
    particle by the rest plus inertia, so every acceleration the body goes
    through shows up a beat late on these five.
  */
  interface Jiggle {
    p: THREE.Vector3
    v: THREE.Vector3
    /** where the rest point was last frame, for its velocity */
    r: THREE.Vector3
    fresh: boolean
  }
  const jig = (): Jiggle => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Vector3(), fresh: true })
  const jHead = jig()
  const jPom = jig()
  const jPack = jig()
  const jMitL = jig()
  const jMitR = jig()
  const JIGGLES = [jHead, jPom, jPack, jMitL, jMitR]
  let jiggleEnergy = 0
  const restV = new THREE.Vector3()
  /** step a particle toward `rest` (world), with gravity `g` (world units/s^2
      down) and a cap on how far it may stray, and report the offset.
      The damping acts on the particle's speed *relative to its rest point*:
      damped against the world instead, a body moving at a steady speed
      dragged every particle a constant distance behind it (v C / K), and a
      bean running at full tilt carried its head a third of a unit behind
      its own neck, which read as leaning back */
  const stepJiggle = (
    j: Jiggle, rest: THREE.Vector3, K: number, C: number, g: number, reach: number, dt: number,
  ) => {
    if (j.fresh || j.p.distanceToSquared(rest) > (4 * S) * (4 * S)) {
      j.p.copy(rest)
      j.r.copy(rest)
      j.v.set(0, 0, 0)
      j.fresh = false
    }
    restV.subVectors(rest, j.r).multiplyScalar(1 / Math.max(dt, 1e-4))
    j.r.copy(rest)
    // two half steps: a stiff spring at 30 fps must not explode
    const h = Math.min(dt, 1 / 20) / 2
    for (let k = 0; k < 2; k++) {
      vTmp.subVectors(rest, j.p).multiplyScalar(K)
      vTmp.y -= g
      vTmp.addScaledVector(j.v, -C).addScaledVector(restV, C)
      j.v.addScaledVector(vTmp, h)
      j.p.addScaledVector(j.v, h)
    }
    vTmp.subVectors(j.p, rest)
    const d = vTmp.length()
    if (d > reach) {
      j.p.copy(rest).addScaledVector(vTmp, reach / d)
      // the part of the velocity pushing past the stop is spent
      const along = (j.v.dot(vTmp) - restV.dot(vTmp)) / d
      if (along > 0) j.v.addScaledVector(vTmp, -along / d)
    }
    jiggleEnergy += vTmp.subVectors(j.v, restV).lengthSq()
  }

  const basisQuat = (q: THREE.Quaternion, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) => {
    mTmp.makeBasis(x, y, z)
    q.setFromRotationMatrix(mTmp)
  }
  /** orientation whose local -Y runs along dir, twist steadied by refX */
  const limbQuat = (q: THREE.Quaternion, dir: THREE.Vector3, ref: THREE.Vector3) => {
    yA.copy(dir).negate()
    zA.crossVectors(ref, yA)
    if (zA.lengthSq() < 1e-8) zA.set(0, 0, 1)
    zA.normalize()
    xA.crossVectors(yA, zA).normalize()
    basisQuat(q, xA, yA, zA)
  }

  /** turn a unit direction toward an axis until it is at most `maxAng` off
      it: a joint limit applied to the bones the ragdoll is draped with (the
      particles themselves stay free, so the heap still lands as it lands) */
  const limitTo = (dir: THREE.Vector3, axis: THREE.Vector3, maxAng: number) => {
    const c = THREE.MathUtils.clamp(dir.dot(axis), -1, 1)
    const a = Math.acos(c)
    if (a <= maxAng || a < 1e-4) return
    const sa = Math.sin(a)
    if (sa < 1e-4) {
      // straight back along the axis: any perpendicular will do
      dir.set(axis.y, axis.z, axis.x).cross(axis).normalize().multiplyScalar(Math.sin(maxAng)).addScaledVector(axis, Math.cos(maxAng))
      return
    }
    const t = maxAng / a
    const ka = Math.sin((1 - t) * a) / sa
    const kd = Math.sin(t * a) / sa
    dir.multiplyScalar(kd).addScaledVector(axis, ka).normalize()
  }

  /** drape the rigid skeleton over the particle cloud (group-local space) */
  const fitFromParticles = () => {
    group.updateMatrixWorld(true)
    groupInv.copy(group.matrixWorld).invert()
    for (let i = 0; i < P_COUNT; i++) lp[i].copy(rag.pts[i]).applyMatrix4(groupInv)

    // trunk frame: spine up, shoulder bar sideways (braces keep it rigid),
    // and the belly/pack pair decides which way is front when the shoulders
    // are edge-on, which is exactly when the cross product degenerates
    const up = yA.copy(lp[P_CHEST]).sub(lp[P_PELV]).normalize()
    const xa = xA.copy(lp[P_SHL]).sub(lp[P_SHR]).normalize()
    const za = zA.crossVectors(xa, up)
    if (za.lengthSq() < 1e-6) za.copy(lp[P_BELLY]).sub(lp[P_PACK])
    za.normalize()
    xa.crossVectors(up, za).normalize()
    basisQuat(qPelv, xa, up, za)
    // the cone a thigh may point in: tipped forward of straight down, so a
    // leg swings far out in front and only a little behind (vKnee is free
    // scratch here; the IK is not running)
    vKnee.copy(up).negate().addScaledVector(za, 0.75).normalize()
    pelvis.position.copy(lp[P_PELV])
    pelvis.quaternion.copy(qPelv)
    pelvis.scale.set(1, 1, 1)
    torso.position.copy(REST[B.TORSO])
    torso.quaternion.identity()
    torso.scale.set(1, 1, 1)
    armInv.set(1, 1, 1)
    qInv.copy(qPelv).invert()

    // head grows +Y toward its particle, but only so far off the trunk's
    // own axis: the head is the top of the bean, and a bean folded double
    // at the neck creased its own face
    dirTmp.copy(lp[P_HEAD]).sub(lp[P_CHEST]).normalize()
    limitTo(dirTmp, up, 0.38)
    zA.crossVectors(xa, dirTmp)
    if (zA.lengthSq() < 1e-8) zA.set(0, 0, 1)
    zA.normalize()
    xA.crossVectors(dirTmp, zA).normalize()
    basisQuat(qSeg, xA, dirTmp, zA)
    head.quaternion.copy(qInv).multiply(qSeg)
    head.scale.set(1, 1, 1)

    // a limb segment: point it from one particle at the next, convert to the
    // parent's frame, and hand the group-space quat on for its own child
    const fitLimb = (
      seg: THREE.Object3D,
      from: THREE.Vector3,
      to: THREE.Vector3,
      parentQ: THREE.Quaternion,
      out: THREE.Quaternion,
      axis?: THREE.Vector3,
      maxAng = Math.PI,
    ) => {
      dirTmp.copy(to).sub(from).normalize()
      if (axis) limitTo(dirTmp, axis, maxAng)
      refX.set(1, 0, 0).applyQuaternion(parentQ)
      limbQuat(qSeg, dirTmp, refX)
      out.copy(qSeg)
      seg.quaternion.copy(parentQ).invert().multiply(qSeg)
    }
    // an elbow and a knee bend only so far off the bone above them: a heap
    // folding a stub right back over itself creased the one skin across it
    fitLimb(uarmL, lp[P_SHL], lp[P_ELL], qPelv, qUpper)
    vPole.copy(dirTmp)
    fitLimb(farmL, lp[P_ELL], lp[P_HANDL], qUpper, qLower, vPole, 1.7)
    fitLimb(uarmR, lp[P_SHR], lp[P_ELR], qPelv, qUpper)
    vPole.copy(dirTmp)
    fitLimb(farmR, lp[P_ELR], lp[P_HANDR], qUpper, qLower, vPole, 1.7)
    handL.quaternion.identity()
    handR.quaternion.identity()
    // legs from the pelvis frame's hip sockets
    vTmp.set(HIP_X, 0, 0).applyQuaternion(qPelv).add(lp[P_PELV])
    // a stub of a leg swings a long way forward but not up past the belly,
    // and not far back at all: past either the skin at the hip folds (see
    // limitTo)
    fitLimb(thighL, vTmp, lp[P_KNEEL], qPelv, qUpper, vKnee, 1.2)
    vPole.copy(dirTmp)
    fitLimb(shinL, lp[P_KNEEL], lp[P_FOOTL], qUpper, qLower, vPole, 1.3)
    vTmp.set(-HIP_X, 0, 0).applyQuaternion(qPelv).add(lp[P_PELV])
    fitLimb(thighR, vTmp, lp[P_KNEER], qPelv, qUpper, vKnee, 1.2)
    vPole.copy(dirTmp)
    fitLimb(shinR, lp[P_KNEER], lp[P_FOOTR], qUpper, qLower, vPole, 1.3)
    // a crumpled body's toes hang relaxed, not frozen in the last stride
    ankleL.rotation.set(0.35, 0, 0)
    ankleR.rotation.set(0.35, 0, 0)
  }

  /*
    The helper bones. A raised arm is a bend of two radians at one joint,
    and linear blend skinning answers a bend that sharp by folding the skin
    round it over itself: the fillet where an arm grows out of a single
    surface came out as a scribble of inside-out triangles in the armpit.
    So each shoulder and each hip has a second bone on the same pivot that
    turns with about half of its limb, and the flesh round the joint is weighted to
    it (bodyShape's beanChain), which spreads one sharp bend into two soft
    ones. Nothing poses them: they only ever follow, whatever posed the limb.
  */
  const followHelpers = () => {
    for (const [hb, limb, share] of HELPERS) {
      bones[hb].quaternion.identity().slerp(bones[limb].quaternion, share)
    }
  }

  /*
    The secondary layer, run after the pose (or the ragdoll fit) has put
    every bone where it wants to be. Needs the group's world matrix, which
    the caller has set by now (position before update; a pedestrian's yaw a
    frame late, which nobody can see).
  */
  const secondary = (dt: number, show: number) => {
    followHelpers()
    jiggleEnergy = 0
    group.updateMatrixWorld(true)
    const s = S

    // the head bobbles on its neck: rest is the neck socket, the particle is
    // the head's inertia, and the offset tilts the head as well as moving it
    // so a stop reads as a nod and a swerve as a wobble
    if (seated) head.position.set(0, SIT_NECK, 0)
    else head.position.copy(REST[B.HEAD])
    head.updateMatrixWorld()
    head.getWorldPosition(vRest)
    // the head is the top of the bean, not a ball on a neck: a stiffer,
    // better damped spring than the old brawler's, tuned well off a run's stride
    // (which rang the old one at resonance and slopped the head a third of a
    // unit side to side), and a gentler tilt for the same offset
    stepJiggle(jHead, vRest, 120, 9, 0, 0.16 * s, dt)
    vTmp2.subVectors(jHead.p, vRest)
    torso.getWorldQuaternion(qW)
    vTmp2.applyQuaternion(qW.invert()).multiplyScalar(1 / s)
    head.position.add(vTmp2)
    head.rotation.x += vTmp2.z * 1.8
    head.rotation.z -= vTmp2.x * 1.8

    // the belly is jelly: its own point mass, soft and slow to settle, so a
    // footfall, a stop or a landing sets the front of the bean wobbling
    pack.position.copy(REST[B.PACK])
    pack.updateMatrixWorld()
    pack.getWorldPosition(vRest)
    stepJiggle(jPack, vRest, 110, 3.5, 0, 0.18 * s, dt)
    vTmp2.subVectors(jPack.p, vRest)
    torso.getWorldQuaternion(qW)
    vTmp2.applyQuaternion(qW.invert()).multiplyScalar(1 / s)
    pack.position.add(vTmp2)
    pack.rotation.set(vTmp2.z * -1.5, 0, vTmp2.x * 1.5)

    // the pom-pom and the mittens are pendulums: a tip particle that wants to
    // sit a stalk's length along the bone's rest direction, pulled by gravity
    // too, and the bone is turned to point at wherever it actually is
    group.updateMatrixWorld(true)
    const swing = (
      j: Jiggle, bone: THREE.Bone, restDir: THREE.Vector3, len: number,
      K: number, C: number, g: number, maxAng: number,
    ) => {
      bone.quaternion.identity()
      bone.updateMatrixWorld()
      bone.getWorldPosition(vRest)
      bone.getWorldQuaternion(qW)
      dirTmp.copy(restDir).applyQuaternion(qW)
      const origin = vHip.copy(vRest)
      vRest.addScaledVector(dirTmp, len * s)
      stepJiggle(j, vRest, K, C, g * s, 2 * len * s, dt)
      // the tip's direction from the joint, in the bone's own frame
      vTmp2.subVectors(j.p, origin).applyQuaternion(qW.invert()).normalize()
      qSeg.setFromUnitVectors(restDir, vTmp2)
      const ang = 2 * Math.acos(Math.min(1, Math.abs(qSeg.w)))
      if (ang > maxAng) qSeg.slerp(qAir.identity(), 1 - maxAng / ang).normalize()
      bone.quaternion.copy(qSeg)
    }
    // the headgear's two tails hang back and down off the knot
    swing(jPom, pom, TAILS, 0.26, 70, 3.5, 9, 0.9)
    // a mitten nods on its wrist, it does not flop: past half a radian the
    // skin at the wrist pinched into a knuckle
    swing(jMitL, handL, DOWN, 0.12, 170, 8, 3, 0.45)
    swing(jMitR, handR, DOWN, 0.12, 170, 8, 3, 0.45)

    // blinking: the painted eyes squash shut, now and then twice
    blinkIn -= dt
    if (blinkIn <= 0 && blinkT < 0) {
      blinkT = 0
      doubleBlink = rnd() < 0.2
      blinkIn = 1.6 + rnd() * 3.6
    }
    let lid = 1
    if (blinkT >= 0) {
      blinkT += dt
      const T = 0.16
      const k = blinkT / T
      lid = k < 1 ? Math.abs(Math.cos(k * Math.PI)) * 0.9 + 0.1 : 1
      if (k >= 1) {
        if (doubleBlink) {
          doubleBlink = false
          blinkT = 0 // and straight into the second
        } else blinkT = -1
      }
    }
    paint.setLid(lid)
    void show
  }

  // --- the kinetic stance ---------------------------------------------------
  const animate = (pose: PlayerPose, env: RagdollEnv) => {
    const { dt, gait } = pose
    const show = pose.show
    // what a sole standing at (x, z) would rest on. The reach cap keeps a
    // step from planting on top of something the body isn't standing on:
    // walk past the coffee table and the near foot must stay on the rug,
    // not levitate onto the tabletop beside it
    const reach = group.position.y + 0.45 * S
    const footGround = (x: number, z: number) =>
      supportY(x, z, reach, env.collision, env.groundY)
    idleT += dt
    const ease = (k: number) => 1 - Math.exp(-k * dt)

    // local-space kinematics: forward/side speed, forward accel, yaw rate
    const fwd = pose.vx * -Math.sin(pose.yaw) + pose.vz * -Math.cos(pose.yaw)
    const side = pose.vx * Math.cos(pose.yaw) - pose.vz * Math.sin(pose.yaw)
    fwdS += (fwd - fwdS) * ease(10)
    sideS += (side - sideS) * ease(10)
    // clamp what we *react* to, not the motion itself: a mouse flick can
    // swing the yaw tens of radians per second and a teleport reads as an
    // infinite acceleration; a body has a ceiling on how hard it can be
    // whipped, and these are it
    accF += (clampRate((fwd - lastFwd) / Math.max(dt, 1e-4), ACC_CAP) - accF) * ease(6)
    accS += (clampRate((side - lastSide) / Math.max(dt, 1e-4), ACC_CAP) - accS) * ease(6)
    lastFwd = fwd
    lastSide = side
    let dYaw = pose.yaw - lastYaw
    if (dYaw > Math.PI) dYaw -= Math.PI * 2
    else if (dYaw < -Math.PI) dYaw += Math.PI * 2
    yawRateS += (clampRate(dYaw / Math.max(dt, 1e-4), YAW_CAP) - yawRateS) * ease(8)
    lastYaw = pose.yaw

    // lazy facing: moving (or airborne) the body turns with the camera;
    // standing it holds its ground until the gaze is ~40 degrees away, then
    // pivots after it. Whatever gap remains, the head and chest cover
    if (!facingSet) {
      facing = pose.yaw
      facingSet = true
    }
    const speedNow = Math.hypot(pose.vx, pose.vz)
    let dFace = Math.atan2(Math.sin(pose.yaw - facing), Math.cos(pose.yaw - facing))
    if (speedNow > 0.5 || !pose.grounded) {
      facing += dFace * ease(10)
      turnActive = false
    } else {
      if (Math.abs(dFace) > 0.7) turnActive = true
      if (turnActive) {
        facing += dFace * ease(6)
        if (Math.abs(dFace) < 0.06) turnActive = false
      }
    }
    dFace = Math.atan2(Math.sin(pose.yaw - facing), Math.cos(pose.yaw - facing))

    // --- idle personality: glances, fidgets --------------------------------
    const moving = speedNow > 0.4 || !pose.grounded || pose.crouchK > 0.2
    stillT = moving ? 0 : stillT + dt
    const idleK = 1 - gait
    const watched = show > 0.5
    glanceIn -= dt
    if (glanceIn <= 0) {
      if (watched && !moving && glanceHold <= 0 && rnd() < 0.8) {
        glanceYaw = (rnd() - 0.5) * 1.3
        glancePitch = (rnd() - 0.35) * 0.45
        glanceHold = 0.8 + rnd() * 1.4
      }
      glanceIn = 2.5 + rnd() * 4
    }
    if (glanceHold > 0) {
      glanceHold -= dt
      if (glanceHold <= 0 || moving) {
        glanceHold = 0
        glanceYaw = 0
        glancePitch = 0
      }
    }
    if (fidget) {
      fidgetT += dt
      if (fidgetT >= FIDGET_LEN[fidget] || moving || (!watched && !fidgetForced)) {
        fidget = null
        fidgetForced = false
        fidgetIn = 7 + rnd() * 8
      }
    } else if (watched && stillT > 3) {
      fidgetIn -= dt
      if (fidgetIn <= 0) {
        const r = rnd()
        // no waves and no stretches on their own: an arm raised overhead to
        // the crowd is a mascot's beat. They remain as emotes for a player
        fidget = r < 0.5 ? 'bounce' : 'look'
        fidgetT = 0
        fidgetForced = false
      }
    }
    /** a fidget's envelope: 0 at the ends, 1 through the middle */
    const fEnv = (f: Fidget, a = 0.25, b = 0.25) => {
      if (fidget !== f) return 0
      const L = FIDGET_LEN[f]
      return ramp(0, a * L, fidgetT) * (1 - ramp(L * (1 - b), L, fidgetT))
    }
    const stretchK = fEnv('stretch', 0.3, 0.3)
    const bounceK = fEnv('bounce', 0.1, 0.2)
    const waveK = fEnv('wave', 0.2, 0.25)
    const lookK = fEnv('look', 0.25, 0.25)
    const bounceY = bounceK * Math.abs(Math.sin(fidgetT * Math.PI * 3.1)) * 0.08

    // the head-shake that ends a get-up: a few quick decaying yaw swings
    let shake = 0
    if (shakeT >= 0) {
      shakeT += dt
      shake = Math.sin(shakeT * 26) * Math.exp(-shakeT * 4.5) * 0.45 * Math.min(1, shakeT * 12)
      if (shakeT > 1.2) shakeT = -1
    }

    // the look-tracking rides springs: whip the mouse and the chest catches
    // up a beat late, the head a shade quicker, never a snap
    const chestLook = spring(12, THREE.MathUtils.clamp(dFace * 0.35, -0.5, 0.5), 60, 10, 0, dt)
    const headLook = spring(
      14,
      THREE.MathUtils.clamp((dFace - chestLook) * 0.85 + glanceYaw * show, -1.0, 1.0) + shake,
      110, 10, 0, dt,
    )
    // every bone here tilts its face DOWN for a positive rotation.x, so the
    // gaze target is the camera pitch negated. The head takes the bulk of a
    // gaze and the chest bends a little under it, so looking at the floor
    // folds the upper body over rather than craning one joint
    const pitchLook = spring(
      16,
      THREE.MathUtils.clamp(-pose.pitch * (pose.pitch > 0 ? 0.55 : 0.42), -0.75, 0.6) * show +
        glancePitch * show + lookK * 0.5,
      90, 10, 0, dt,
    )
    const spineLook = spring(
      18, THREE.MathUtils.clamp(-pose.pitch * 0.16, -0.24, 0.24) * show + lookK * 0.2, 70, 11, 0, dt,
    )

    // landing spring: the touchdown kicks it, it argues its way back
    // a takeoff pops the other way: the hips shoot up and the trunk
    // stretches, and the arms fling (see the jolts below)
    const takeoff = wasGrounded && !pose.grounded && pose.vy > 2
    // the walker has no wind-up to show (a jump leaves on the frame it is
    // asked for), so the push-off is drawn in the first frames of the air:
    // the hips start low, squashed, and spring out through a stretch
    if (takeoff) {
      springP = -0.2
      springV = 2.0
    }
    if (pose.landing > 0) springV -= Math.min(pose.landing, 22) * 0.14
    // soft and bouncy: a landing squashes, overshoots into a stretch and
    // wobbles back, rather than dipping once and stopping
    springV += (-75 * springP - 7 * springV) * dt
    springP = Math.max(-0.7, springP + springV * dt)

    airK += ((pose.grounded ? 0 : 1) - airK) * ease(pose.grounded ? 14 : 9)
    flyK += ((pose.fly ?? 0) - flyK) * ease(4)
    // a flyer is neither rising nor falling: the legs settle halfway between
    // the jump's tuck and the fall's reach, which reads as hanging loose
    fallK += ((pose.fly ? 0.55 : pose.vy < 0 ? 1 : 0) - fallK) * ease(7)

    // hips angle toward where the feet are actually going; chest holds the
    // camera line, so strafing reads as stepping sideways, not gliding
    const moveAng = gait > 0.12 ? Math.atan2(sideS, Math.abs(fwdS) + 0.5) : 0
    const strafeWant = THREE.MathUtils.clamp(moveAng * 0.6, -0.6, 0.6) * Math.min(1, gait * 2)
    strafeYaw += (strafeWant - strafeYaw) * ease(7)

    const runK = pose.run ? 1 : 0
    const breathe = Math.sin(idleT * 1.9) * (1 - gait)
    const speed = Math.hypot(pose.vx, pose.vz)

    // the step clock ticks on distance covered, not on time: the integer
    // part says which foot is airborne, the fraction is its swing phase
    // a run is a different gait, not a faster walk: bounding strides with a
    // flight between them, so fewer, longer steps rather than a scurry
    // stub legs take short quick steps: a jelly waddles rather than strides
    // and a run is quick short steps rather than a stretched stride: a stub
    // leg reaches ~0.36 in front of its hip, and the 1.3 this used to stride
    // at a run left the planted leg straight as a peg for half of every step
    strideNow += (0.76 + 0.14 * runK - strideNow) * ease(4)
    const prevStep = Math.floor(stepT)
    if (pose.grounded) {
      stepT += (speed * dt) / (strideNow * S)
      // a step begun must finish even if the walker stops mid-swing
      const frac = stepT - Math.floor(stepT)
      if (speed < 0.4 && frac > 0.02) stepT = Math.min(Math.floor(stepT) + 1, stepT + dt * 3)
    }
    const stepS = Math.sin(Math.PI * stepT)
    const moveK = Math.min(1, gait * 1.6)

    // crouch, landing spring and the get-up fold all lower the hips; the leg
    // IK below folds the knees exactly enough that the feet stay planted
    // soft knees always, softer standing about: a bean never locks them
    // (a stub leg has little to fold: the drop is what it can take, and
    // the rest of a crouch is the squash)
    // a run sits a little lower on bent knees, which is most of what makes
    // quick steps read as a scurry rather than a march
    const drop = pose.crouchK * 0.3 + riseFold * 0.3 - springP * 0.7 + 0.06 + 0.04 * idleK +
      0.05 * runK * gait
    const hipH = THREE.MathUtils.clamp(HIP_Y - drop, Math.abs(THIGH - SHIN) + 0.08, HIP_Y)

    // pelvis: root motion. A waddle: the hips ride over the stance foot and
    // roll with it (stepS > 0 means the left foot is swinging, so the right
    // one carries the weight), bob down through each footfall, and a run
    // pops up off the ground between them. Standing, the weight drifts from
    // one foot to the other now and then, which is most of what reads as
    // alive in a body doing nothing
    const shift = Math.sin(idleT * 0.55 + 1.1) * Math.sin(idleT * 0.21) * 0.05 * idleK * (1 - riseFold)
    const waddleX = -stepS * (0.075 - 0.045 * runK) * moveK + shift
    const dip = -Math.abs(stepS) * 0.07 * gait * (1 - runK)
    // a run's hips are lowest just after a foot lands and highest in the
    // flight before the next one does (see the toe-off in the feet below)
    const stepFrac = stepT - Math.floor(stepT)
    const pop = runK * gait * (0.5 - 0.5 * Math.cos(2 * Math.PI * (stepFrac - 0.35))) * 0.06
    pelvis.position.set(
      waddleX, hipH + dip + pop + bounceY + breathe * 0.006 + Math.sin(idleT * 1.7) * 0.05 * flyK, 0,
    )
    // a walk waddles; a run is upright and bouncy, the roll mostly gone
    const waddleRoll = stepS * (0.1 - 0.06 * runK) * moveK + shift * 1.2
    // the get-up hunch is not gated by pose.show: it is the shape of the
    // action, not flair, and the lens is off the head for the whole of it
    // A bean runs nearly upright: the lean is a hint of the speed and a
    // lurch on a start or a stop, not a sprinter's pitch. The brawler before
    // it leaned 55 degrees at a full run and read as falling over its own
    // feet; `npm run measure -- body` prints the pitch, and a run should stay
    // around ten degrees
    const lean =
      (THREE.MathUtils.clamp(fwdS * 0.006 + accF * 0.012, -0.12, 0.14) + pose.crouchK * 0.2 +
        runK * gait * 0.01 + 0.02 + persona.lean * idleK) * show +
      riseFold * 0.55 - stretchK * 0.12
    // centripetal lean: bank into a turn only as fast as the feet are
    // actually carrying the body
    // (capped at nine degrees: a bean tipped further than that on a turn
    // reads as falling over, not as cornering)
    const bank = THREE.MathUtils.clamp(
      -yawRateS * (0.02 + 0.03 * runK) * gait - sideS * 0.012,
      -0.16, 0.16,
    )
    // and flying fast lays the whole body into the flight, legs trailing,
    // the way everyone in Garry's Mod crosses a map in noclip
    const flyLean = flyK * THREE.MathUtils.clamp(fwdS * 0.02, -0.25, 0.8)
    pelvis.rotation.set(lean * 0.5 + flyLean, strafeYaw - stepS * 0.12 * gait, bank * 0.45 + waddleRoll)

    // the chest is jelly on top of the hips: a roll spring that wants to
    // hold the shoulders level over the waddle, and so arrives late and
    // overshoots, and a pitch spring kicked by starts, stops and landings
    const jellyRoll = spring(20, -waddleRoll * 0.9, 70, 3.5, -accS * 0.3 - yawRateS * 0.6 * gait, dt, -0.3, 0.3)
    const jellyPitch = spring(
      22, 0, 110, 6.5, -accF * 0.18 + (pose.landing > 0 ? pose.landing * 2.6 : 0), dt, -0.5, 0.5,
    )
    torso.position.copy(REST[B.TORSO])
    torso.rotation.set(
      lean * 0.5 + airK * 0.12 * fallK + spineLook + jellyPitch * show +
        // in the air the body lags its own flight: rising it tips back,
        // falling it pitches over, rather than stretching into a tube
        // a lunge, not a hop: in the air the body pitches into its travel
        // (and forward even from a standing jump), limbs trailing behind
        airK * (0.12 + THREE.MathUtils.clamp(fwdS * 0.025, -0.12, 0.2) +
          THREE.MathUtils.clamp(-pose.vy * 0.012, -0.15, 0.15)) * (1 - flyK),
      // standing in the guard the trunk weaves: a slow twist and a lean to
      // one side, so no two frames of an idle are symmetrical
      chestLook - strafeYaw * 0.55 + stepS * 0.14 * gait +
        Math.sin(idleT * 0.9 + 0.4) * 0.14 * idleK * show,
      bank * 0.55 + jellyRoll + (persona.roll + Math.sin(idleT * 0.61) * 0.05) * idleK * show,
    )
    // squash on a landing, stretch on the way up, breathe standing still
    // the jelly wobble: the trunk's volume on its own spring, kicked by every
    // footfall, takeoff and landing, ringing a few times before it settles
    // a stop, a start or a swerve shakes it too, not just a footfall
    wobV += (-240 * wobP - 3.5 * wobV + Math.abs(accF) * 0.35 + Math.abs(yawRateS) * 0.6 * gait) * dt
    wobP = THREE.MathUtils.clamp(wobP + wobV * dt, -0.25, 0.25)
    const squash = THREE.MathUtils.clamp(
      1 + springP * 2.2 + airK * (1 - fallK) * 0.03 + breathe * 0.014 + stretchK * 0.07 +
        Math.abs(stepS) * 0.03 * gait + wobP,
      // never squashed so far that the small head disappears into the body
      0.8, 1.12,
    )
    const bulge = Math.pow(squash, -0.8)
    // and the trunk sinks into the hips as it squashes, so the belly (which
    // is weighted to the pelvis) compresses too, not just the chest
    torso.position.y -= (1 - Math.min(1, squash)) * 0.1
    torso.scale.set(bulge, squash, bulge)
    // the arms hang off the torso and must not take its squash with them
    // (see armUnsquash below)
    armInv.set(1 / bulge, 1 / squash, 1 / bulge)

    // head: keeps the gaze on the camera line, in both axes, for outside
    // viewers only; under the first-person lens the head stays level
    head.rotation.set(
      // the chin lifts out of the get-up hunch
      pitchLook + 0.06 * gait - airK * 0.12 + breathe * 0.02 - riseFold * 0.35 - stretchK * 0.3 -
        lean * 0.5,
      headLook - strafeYaw * 0.4 - stepS * 0.06 * gait,
      -bank * 0.3 - jellyRoll * 0.5 + persona.tilt * idleK * show,
    )
    // counter the trunk's squash so the face stays round
    // the head keeps half of the squash: a landing flattens the whole body,
    // but a face squashed as hard as a belly stops reading as a face
    head.scale.set(1 / Math.sqrt(bulge), 1 / Math.sqrt(squash), 1 / Math.sqrt(bulge))

    // --- feet: world-planted, distance-triggered, solved with 2-bone IK ----
    qGroupInv.copy(group.quaternion).invert()
    // keep each sole on its own side of the body: the swing target is the hip
    // socket plus a reach along the real velocity, and for a pure side-step
    // that reach is entirely lateral, aiming the near foot straight through
    // the far leg. Clamping in the body frame bounds it both ways
    const SOLE_MIN_X = HIP_X * 0.55
    const SOLE_MAX_X = HIP_X + 0.3
    const sideClamp = (foot: THREE.Vector3, side: 1 | -1, rate: number) => {
      vTmp.copy(foot).sub(group.position).applyQuaternion(qGroupInv).multiplyScalar(1 / S)
      const own = vTmp.x * side // distance onto this leg's own side, signed
      const want = THREE.MathUtils.clamp(own, SOLE_MIN_X, SOLE_MAX_X)
      if (want === own) return
      vTmp.x = (own + (want - own) * rate) * side
      foot.copy(vTmp.multiplyScalar(S).applyQuaternion(group.quaternion).add(group.position))
    }
    const socketWorld = (side: 1 | -1, out: THREE.Vector3) => {
      // the socket under the hip, ignoring the waddle so feet do not chase it
      out.set(side * HIP_X, 0, 0).applyQuaternion(pelvis.quaternion)
      out.y += pelvis.position.y
      out.multiplyScalar(S).applyQuaternion(group.quaternion).add(group.position)
      out.y = footGround(out.x, out.z)
      return out
    }
    if (pose.grounded) {
      if (!wasGrounded || needReplant) {
        socketWorld(1, plantedL)
        socketWorld(-1, plantedR)
        stepT = Math.ceil(stepT) // no half-finished swing survives a replant
        swingFrom.copy(Math.floor(stepT) % 2 === 0 ? plantedL : plantedR)
        needReplant = false
      } else if (Math.floor(stepT) !== prevStep) {
        // footfall: the old swinger lands on its target, the other takes off
        ;(prevStep % 2 === 0 ? plantedL : plantedR).copy(swingTarget)
        swingFrom.copy(Math.floor(stepT) % 2 === 0 ? plantedL : plantedR)
      }
      const idx = Math.floor(stepT) % 2 // 0: left is airborne, 1: right
      const frac = stepT - Math.floor(stepT)
      if (speed >= 0.4 || frac > 0.02) {
        const side: 1 | -1 = idx === 0 ? 1 : -1
        const swingFoot = idx === 0 ? plantedL : plantedR
        socketWorld(side, vRest)
        vVel.set(pose.vx, 0, pose.vz)
        // land where the hip socket will be at touchdown, plus a reach of
        // roughly half a stride further along the travel direction
        swingTarget.copy(vRest)
        if (speed > 0.3) {
          swingTarget.addScaledVector(vVel, ((1 - frac) * strideNow * S) / speed)
          swingTarget.addScaledVector(vVel, (0.42 * strideNow * S) / speed)
        }
        sideClamp(swingTarget, side, 1)
        swingTarget.y = footGround(swingTarget.x, swingTarget.z)
        const k = frac * frac * (3 - 2 * frac)
        swingFoot.lerpVectors(swingFrom, swingTarget, k)
        // a little knee lift: a bean patters, quick small steps with the
        // feet barely off the ground, and a run adds only a small heel kick.
        // The brawler's lifts, three times these, raised a stub leg's thigh
        // past the horizontal and folded the bottom of the bean over it
        swingFoot.y += Math.sin(frac * Math.PI) * (0.09 + 0.03 * runK) * S * Math.min(1, speed) +
          runK * Math.sin(Math.min(1, frac * 1.6) * Math.PI) * 0.05 * S
      } else {
        // standing: a foot left far from its socket shuffles home; otherwise
        // feet stay put
        const settle = (foot: THREE.Vector3, side: 1 | -1) => {
          socketWorld(side, vRest)
          vTmp.subVectors(vRest, foot)
          vTmp.y = 0
          const d = vTmp.length()
          if (d < 0.03 * S) {
            foot.y = footGround(foot.x, foot.z)
            return
          }
          if (d > 0.24 * S) {
            foot.addScaledVector(vTmp.normalize(), Math.min(d, 2.4 * S * dt))
            foot.y = footGround(foot.x, foot.z) + Math.min(0.06 * S, d * 0.25)
          }
        }
        settle(plantedL, 1)
        settle(plantedR, -1)
        swingFrom.copy(idx === 0 ? plantedL : plantedR)
      }
    }
    // the bounce fidget lifts the heels off the floor with the hips
    const unCross = ease(12)
    sideClamp(plantedL, 1, unCross)
    sideClamp(plantedR, -1, unCross)

    // two-bone IK per leg in the pelvis frame; airborne it crossfades to a
    // tuck on the rise and a reach on the fall
    // the legs split in the air: a lead knee comes up, the other leg trails
    // behind, and on the way down both reach apart for the ground. Which one
    // leads alternates with the stride, so a run of hops does not repeat
    const lead = Math.floor(stepT) % 2 === 0 ? 1 : -1
    // rising, the legs are still extended from the shove, trailing long
    // under the body; the knee only comes up at the top, and falling both
    // reach apart for the ground
    // noclip swaps both for a dangle: knees soft, one leg a little ahead of
    // the other and the pair swaying slowly, like feet hanging off a pier
    const flyN = 1 - flyK
    const dangle = Math.sin(idleT * 1.3) * 0.2 * flyK
    const leadThigh = (-0.55 - fallK * 0.45) * flyN + (-0.32 + dangle) * flyK
    const leadShin = (0.35 + fallK * 0.75) * flyN + 0.75 * flyK
    const trailThigh = (0.95 - fallK * 0.45) * flyN + (0.18 - dangle) * flyK
    const trailShin = (0.25 + fallK * 0.65) * flyN + 0.6 * flyK
    const airSplay = (0.1 + fallK * 0.22) * flyN + 0.15 * flyK
    qInv.copy(pelvis.quaternion).invert()
    const solveLeg = (
      thigh: THREE.Bone,
      shin: THREE.Bone,
      ankle: THREE.Bone,
      foot: THREE.Vector3,
      side: 1 | -1,
      airThighX: number,
      airShinX: number,
      lift: number,
    ) => {
      // foot: world -> body -> pelvis frame
      vFoot.copy(foot).sub(group.position).applyQuaternion(qGroupInv).multiplyScalar(1 / S)
      vFoot.y += lift
      vFoot.y += bounceY
      vFoot.sub(pelvis.position).applyQuaternion(qInv)
      vHip.set(side * HIP_X, 0, 0)
      dirTmp.subVectors(vFoot, vHip)
      const L = THREE.MathUtils.clamp(dirTmp.length(), 0.25, THIGH + SHIN - 0.01)
      dirTmp.normalize()
      // knee pole: forward with a nudge outward, kept off the leg axis
      // a deep crouch opens the knees out, or two stub legs fold into each other
      vPole.set(side * (0.2 + 0.7 * pose.crouchK), 0, 1)
      vPole.addScaledVector(dirTmp, -vPole.dot(dirTmp))
      if (vPole.lengthSq() < 1e-6) vPole.set(0, 0, 1)
      vPole.normalize()
      const cosHip = THREE.MathUtils.clamp(
        (THIGH * THIGH + L * L - SHIN * SHIN) / (2 * THIGH * L), -1, 1,
      )
      const sinHip = Math.sqrt(1 - cosHip * cosHip)
      vKnee.copy(vHip).addScaledVector(dirTmp, THIGH * cosHip).addScaledVector(vPole, THIGH * sinHip)
      vTmp.subVectors(vKnee, vHip).normalize()
      limbQuat(qIK, vTmp, refX.set(1, 0, 0))
      qAir.setFromEuler(eTmp.set(airThighX, 0, side * airSplay))
      thigh.quaternion.copy(qIK).slerp(qAir, airK)
      // shin: from the knee toward the (possibly clamped) foot
      vTmp.copy(vHip).addScaledVector(dirTmp, L).sub(vKnee).normalize()
      refX.set(1, 0, 0).applyQuaternion(qIK)
      limbQuat(qSeg, vTmp, refX)
      qSeg.premultiply(qIK.invert()) // shin local = thigh^-1 * shin(pelvis)
      qAir.setFromEuler(eTmp.set(airShinX, 0, 0))
      shin.quaternion.copy(qSeg).slerp(qAir, airK)
      // ankle: counter the shin's sagittal tilt so the sole stays level on
      // the ground; airborne the toes droop instead of digging
      const tilt = Math.atan2(vTmp.z, -vTmp.y) // vTmp still holds the shin dir
      ankle.position.copy(REST[side === 1 ? B.FOOT_L : B.FOOT_R])
      ankle.rotation.set(tilt * 0.9 * (1 - airK) + 0.5 * airK, 0, 0)
    }
    // the toe-off: running, the planted foot leaves the ground before the
    // swinging one lands, so every stride has a moment with both feet in the
    // air. The planted sole stays where it is in the world; only the leg
    // solved over it lets go
    const toeOff = pose.grounded ? runK * gait * ramp(0.5, 0.95, stepFrac) * 0.12 : 0
    const swingingL = Math.floor(stepT) % 2 === 0
    solveLeg(
      thighL, shinL, ankleL, plantedL, 1,
      lead > 0 ? leadThigh : trailThigh, lead > 0 ? leadShin : trailShin, swingingL ? 0 : toeOff,
    )
    solveLeg(
      thighR, shinR, ankleR, plantedR, -1,
      lead < 0 ? leadThigh : trailThigh, lead < 0 ? leadShin : trailShin, swingingL ? toeOff : 0,
    )
    wasGrounded = pose.grounded

    // arms: the targets say where the arms WANT to be (counter-swing along
    // the travel direction, elbows pumped by a run, thrown out by a fall, up
    // in a stretch, waving) but nothing is assigned directly. Every joint
    // rides an underdamped spring toward its target, fed the body's own
    // inertia, and the elbows chase the shoulders' actual (sprung) angle one
    // beat behind, which is the follow-through
    const mag = Math.hypot(fwdS, sideS)
    if (mag > 0.5) {
      mCos += (fwdS / mag - mCos) * ease(6)
      mSin += (sideS / mag - mSin) * ease(6)
    } else {
      mCos += (1 - mCos) * ease(3)
      mSin += (0 - mSin) * ease(3)
    }
    // the gait swing is applied straight onto the joint, not through the
    // spring: a run steps at three a second and these springs ring at about
    // one, so a swing fed through them arrived at a seventh of its size and
    // the arms hung at the hips. The springs ride on top of it, for the lag,
    // the flop and everything the body's accelerations do to them
    //
    // And it is *none* of the springs' business. Feeding even part of it
    // through them is worse than useless: at walking cadence they are driven
    // well above their own ring, and a spring driven past resonance answers
    // upside down, so the half that went through them cancelled the half
    // that did not and the mittens never left the hips. Instead the swing
    // runs a little behind the legs (phase-lagged on the step clock), so the
    // arms trail the stride the way a loose shoulder does, and it swings out
    // sideways as well as fore and aft, which is what makes it visible from
    // the side as well as from the front
    // low and loose: about thirty degrees each way walking and forty at a run.
    // The 1.55 radians this once swung at a run, plus the spread it fed,
    // threw a mitten over the head on every other step
    const ampW = (0.55 + 0.15 * runK) * gait
    const swingAt = (lag: number) => Math.sin(Math.PI * (stepT - lag)) * ampW
    const swingAmt = swingAt(0.12)
    const swingF = swingAmt * mCos
    const swingS = swingAmt * mSin * 0.7
    // the arm swings a touch out as it swings through, so it clears the
    // belly and reads from the front; a hint, not a flail
    const swingOut = Math.abs(swingAmt) * 0.15
    // the forearm follows the upper arm later still, so it is bent coming
    // forward and trails open going back
    const lagEl = swingAt(0.32) * mCos
    // a loose bend at rest: an arm hanging dead straight reads as a mannequin
    // the guard: standing about, the long arms come up to a clumsy boxing
    // guard, mittens at chest height, never quite matched
    const guardK = idleK * (1 - airK) * (1 - riseFold)
    const elbowBase = 0.3 + 0.35 * runK * gait + 0.1 * guardK
    // held well out from the body, standing or not: a round belly and a
    // loose shoulder, never glued to the hips; a fall flings them wide
    // held clear of the body at rest, with a gap of air down each side: a
    // wider build holds them wider
    const spread =
      0.62 + (persona.girth - 1) * 0.9 - 0.04 * guardK + breathe * 0.05 + airK * (0.5 + fallK * 0.9) * (1 - 0.6 * flyK) + runK * gait * 0.08 + swingOut
    // airborne: flung up by the takeoff, then trailing, then up and out as
    // the body drops away under them. A flyer is not falling, so its arms
    // hang loose and a little forward and drift, out of step with the legs
    // (negative is behind: rising, the arms trail back from the lunge, and
    // come forward to reach for the ground on the way down)
    const airX =
      airK * (-0.45 + fallK * 1.15) * (1 - flyK) + flyK * (0.3 + Math.sin(idleT * 1.05 + 0.8) * 0.12)
    // at rest the long arms hang forward like a sleepwalker's, which is where
    // the goof comes from (and where a grab starts)
    // and standing about they reach, low and forward and never level, each
    // body at its own lopsided angles (see `persona`)
    // standing about they hang heavy and swing a little from the shoulders,
    // a touch forward of the body and never level with each other
    const swayLX = (Math.sin(idleT * 1.1) * 0.1 + Math.sin(idleT * 0.53 + 1.3) * 0.07) * idleK -
      0.15 - 0.15 * gait - persona.armL * 0.4 * guardK
    const swayRX = (Math.sin(idleT * 0.97 + 0.7) * 0.1 + Math.sin(idleT * 0.61 + 2.1) * 0.07) * idleK -
      0.15 - 0.15 * gait - persona.armR * 0.4 * guardK
    const swayLZ = Math.sin(idleT * 1.13 + 0.4) * 0.06 * idleK
    const swayRZ = Math.sin(idleT * 1.31 + 2.6) * 0.06 * idleK
    // inertial forces on the springs
    const throwX = accF * 0.08
    const slingZ = -yawRateS * 0.45 - accS * 0.06
    // the hips' own waddle rocks the arms out and back in
    const rock = -stepS * moveK * 0.9
    if (takeoff) {
      // arms thrown up and out with the jump
      sprS[1] -= 5.5
      sprS[7] -= 3.5
      sprS[3] += 5
      sprS[9] += 4
    }
    // every footfall bounces the arms out a little, like a loose sleeve
    if (pose.grounded && Math.floor(stepT) !== prevStep && gait > 0.25) {
      sprS[3] += 0.7 * gait
      sprS[9] += 0.7 * gait
      // and jiggles the jelly
      wobV -= (1.9 + 0.9 * runK) * gait
      jPack.v.y -= 3.6 * S * gait
      jHead.v.y -= 1.6 * S * gait
    }
    if (takeoff) wobV += 1.2
    if (pose.landing > 0) {
      wobV -= Math.min(pose.landing, 20) * 0.12
      jPack.v.y -= Math.min(pose.landing, 20) * 0.35 * S
    }
    if (pose.landing > 0) {
      const jolt = Math.min(pose.landing, 18) * 0.14
      sprS[1] -= jolt
      sprS[7] -= jolt * 0.85
      sprS[3] += jolt * 0.8 // both arms fling outward
      sprS[9] += jolt * 0.8
      sprS[17] += jolt * 0.55 // the head nods into a hard landing
      sprS[19] += jolt * 0.3 // and the chest folds a little under it
      sprS[21] += (rnd() - 0.5) * jolt * 1.2 // and lurches to one side
    }
    const KS = 42
    const CS = 4.5 // underdamped on purpose: the overshoot is the liveliness
    const KE = 45
    const CE = 6
    // the get-up plants both hands out front and pushes off them
    const push = riseFold * 1.0
    // fidgets, as extra targets: a stretch lifts both arms overhead, a wave
    // lifts the right one out to the side and wags the forearm
    const upL = stretchK * 2.7
    const upR = stretchK * 2.7 + waveK * 0.4
    const waveZ = waveK * 1.9
    const wag = waveK * Math.sin(fidgetT * 11) * 0.55
    const look = lookK * 0.9 // both hands up in front, looked at
    // forearms pump with the upper arms when running, lag them walking
    const pumpL = -Math.max(0, -lagEl) * (0.5 + 0.3 * runK)
    const pumpR = -Math.max(0, lagEl * 0.93) * (0.5 + 0.3 * runK)
    // on the ground an arm swings about sixty degrees forward, fifty back and
    // sixty out at most, whatever the springs are doing; only a stretch, a
    // wave, a look at the hands, a jump, a fall or a get-up lifts the caps.
    // Everything that ever threw an arm overhead mid-run got past here
    const freeK = Math.max(stretchK, waveK, airK, riseFold, lookK, push)
    const swingCap = -1.05 - 2.0 * freeK
    const backCap = 0.9 + 0.5 * freeK
    const outCap = 1.05 + 1.85 * freeK
    const clampX = (v: number) =>
      THREE.MathUtils.clamp(v, Math.max(SH_X_LO, swingCap), Math.min(SH_X_HI, backCap))
    const clampZ = (v: number) => Math.min(v, outCap)
    const shLX = clampX(
      spring(0, -airX + swayLX - push - upL - look, KS, CS, throwX, dt, SH_X_LO, SH_X_HI) + swingF,
    )
    const shLZ = clampZ(spring(
      2, spread + swingS + swayLZ + riseFold * 0.1 + stretchK * 0.25, KS, CS, slingZ + rock, dt,
      SH_Z_LO, SH_Z_HI,
    ))
    const elL = spring(
      4, -(elbowBase + airK * 0.4 + riseFold * 0.4 + look * 1.3) * (1 - stretchK * 0.8) + pumpL,
      // the forearm lags its upper arm: swing the shoulder forward and the
      // elbow is thrown open, then folds after it, which is the follow-through
      KE, CE, -sprS[1] * 6, dt, EL_LO, EL_HI,
    )
    const shRX = clampX(
      spring(6, -airX + swayRX - push - upR - look, KS, CS, throwX, dt, SH_X_LO, SH_X_HI) - swingF * 0.93,
    )
    const shRZ = clampZ(spring(
      8, spread - swingS + swayRZ + riseFold * 0.1 + stretchK * 0.25 + waveZ, KS, CS, -slingZ - rock, dt,
      SH_Z_LO, SH_Z_HI,
    ))
    const elR = spring(
      10,
      -(elbowBase + 0.03 + airK * 0.4 + riseFold * 0.4 + look * 1.3) *
        (1 - stretchK * 0.8) - waveK * 0.9 + wag + pumpR,
      KE, CE, -sprS[7] * 6, dt, EL_LO, EL_HI,
    )
    // shoulder z: positive spreads each arm outward, whichever side it is on
    uarmL.rotation.set(shLX, 0, shLZ)
    farmL.rotation.set(elL, 0, 0)
    uarmR.rotation.set(shRX, 0, -shRZ)
    farmR.rotation.set(elR, 0, 0)
    // a tool held in both hands, over whatever the swing was doing
    aimK += ((pose.aim ?? 0) - aimK) * (1 - Math.exp(-dt * 12))
    if (aimK > 0.01) holdTool(pose, dt)
  }

  /*
    Holding the physgun. The view's direction is carried into the torso's
    frame (the group turns by facing + a half turn, then the pelvis and the
    torso turn under it), the right hand's target is a grip point in front of
    the chest and a little out along the aim, the left hand's is under the
    barrel further out along it, and each arm is solved onto its target by a
    two-bone IK with the elbow falling down and out. The result is blended
    over the walk's own arms by aimK. The gun is then placed off the two
    hands (the tool belt reads limbPos for both), so the gun, the arms and
    the beam always agree. A heavy load leans the trunk back against it.
  */
  const ikWorld = new THREE.Vector3()
  const ikQ = new THREE.Quaternion()
  const ikQ2 = new THREE.Quaternion()
  const ikD = new THREE.Vector3()
  const ikR = new THREE.Vector3()
  const ikL = new THREE.Vector3()
  const ikS = new THREE.Vector3()
  const ikU = new THREE.Vector3()
  const ikV = new THREE.Vector3()
  const ikE = new THREE.Vector3()
  const ikT = new THREE.Vector3()
  const ikDown = new THREE.Vector3(0, -1, 0)
  const Y_AXIS = new THREE.Vector3(0, 1, 0)
  let loadK = 0
  /** solve one arm from its shoulder onto `target` (torso frame), blended */
  const solveArm = (upper: THREE.Bone, lower: THREE.Bone, side: 1 | -1, target: THREE.Vector3) => {
    const a = UARM
    const b = FARM + 0.1 // to the mitten, not the wrist
    ikS.set(side * SHOULDER_X, SHOULDER_OFF, 0)
    ikU.subVectors(target, ikS)
    const d = THREE.MathUtils.clamp(ikU.length(), 0.05, a + b - 0.01)
    ikU.normalize()
    // the elbow's angle off the shoulder-to-hand line, law of cosines
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1)
    const sinA = Math.sqrt(1 - cosA * cosA)
    // the pole: down and out, made perpendicular to the line
    ikV.set(side * 0.7, -1, -0.2)
    ikV.addScaledVector(ikU, -ikV.dot(ikU)).normalize()
    ikE.copy(ikS).addScaledVector(ikU, a * cosA).addScaledVector(ikV, a * sinA)
    // the upper arm hangs along -Y: turn -Y onto shoulder->elbow
    ikT.subVectors(ikE, ikS).normalize()
    ikQ.setFromUnitVectors(ikDown, ikT)
    upper.quaternion.slerp(ikQ, aimK)
    // the forearm, in the upper arm's frame: -Y onto elbow->hand
    ikT.copy(ikU).multiplyScalar(d).add(ikS).sub(ikE).normalize()
      .applyQuaternion(ikQ2.copy(upper.quaternion).invert())
    ikQ.setFromUnitVectors(ikDown, ikT)
    lower.quaternion.slerp(ikQ, aimK)
  }
  const holdTool = (pose: PlayerPose, dt: number) => {
    // lean back against a heavy load, eased
    loadK += ((pose.aimLoad ?? 0) - loadK) * (1 - Math.exp(-dt * 6))
    torso.rotation.x -= loadK * 0.28 * aimK
    torso.updateMatrix()
    // the aim, world, then into the torso's frame
    const cp = Math.cos(pose.pitch)
    ikWorld.set(-Math.sin(pose.yaw) * cp, Math.sin(pose.pitch), -Math.cos(pose.yaw) * cp)
    ikQ.setFromAxisAngle(Y_AXIS, facing + Math.PI).multiply(pelvis.quaternion).multiply(torso.quaternion).invert()
    ikD.copy(ikWorld).applyQuaternion(ikQ).normalize()
    // the grip in front of the chest, a little right and out along the aim;
    // the foregrip under the barrel, further out
    // (the bean's arms are short and its shoulders wide, so both points sit
    // close in: further out and the left hand could not reach the barrel)
    ikR.set(-0.06, SHOULDER_OFF - 0.32, 0.2).addScaledVector(ikD, 0.15)
    ikL.copy(ikR).addScaledVector(ikD, 0.2)
    ikL.x += 0.04
    ikL.y -= 0.05
    solveArm(uarmR, farmR, -1, ikR)
    solveArm(uarmL, farmL, 1, ikL)
  }

  /** the seated trunk and head for this moment: a slump forward over the
      lap, a lean to one side, a slow breath and a lolling look around */
  const seatedPose = (dt: number) => {
    void dt
    const b = Math.sin(seatT * 1.6) * 0.02
    torso.position.set(0, SIT_WAIST, 0)
    torso.rotation.set(-SIT_SLOUCH + 0.2 + b, Math.sin(seatT * 0.27) * 0.06, seatTilt * 0.6 + Math.sin(seatT * 0.41) * 0.04)
    head.position.set(0, SIT_NECK, 0)
    head.rotation.set(
      SIT_SLOUCH - 0.1 + Math.sin(seatT * 0.6) * 0.05,
      seatLook + Math.sin(seatT * 0.23) * 0.3,
      seatTilt + Math.sin(seatT * 0.5 + 1) * 0.06,
    )
  }

  /** remember the posed bones, so the get-up can blend toward them */
  const captureBlendSource = () => {
    POSED.forEach((b, i) => capQ[i].copy(b.quaternion))
  }

  /*
    The get-up, as muscle rather than as a blend.

    animate() has just posed the bones for this moment of the rise (the
    gathered crouch with the hands planted, unwinding into a stand); those
    anchors become targets, and the ragdoll keeps simulating with every
    particle pulled toward its own. The pull tightens over the rise and the
    legs and trunk lead, so the heap draws its knees under itself, pushes
    up off its hands, and wobbles as it comes up, under gravity the whole
    way. The bones are fitted to the particles, and only the last stretch
    of the rise blends them onto the animated pose, which by then is nearly
    where the particles already are.
  */
  const rise = (pose: PlayerPose, env: RagdollEnv) => {
    group.updateMatrixWorld(true)
    for (let i = 0; i < P_COUNT; i++) anchors[i].getWorldPosition(riseTargets[i])
    const trunk = 0.02 + ramp(0.0, 0.55, riseT) * 0.22
    const limb = 0.01 + ramp(0.15, 0.75, riseT) * 0.18
    for (let i = 0; i < P_COUNT; i++) {
      const legs = i === P_PELV || i === P_BELLY || i === P_PACK || i >= P_KNEEL
      riseK[i] = legs ? trunk : i === P_HEAD || i === P_CHEST ? trunk * 0.8 : limb
    }
    riseK[P_FOOTL] = riseK[P_FOOTR] = Math.min(1, trunk * 2)
    rag.drive(riseTargets, riseK)
    rag.step(pose.dt, env)
    captureBlendSource() // the animated pose, before the fit replaces it
    const animPelv = vTmp2.copy(pelvis.position)
    fitFromParticles()
    // blend from the fitted pose (now in the bones) to the animated one
    const k = ramp(0.6, 1, riseT)
    POSED.forEach((b, i) => b.quaternion.slerp(capQ[i], k))
    pelvis.position.lerp(animPelv, k)
  }

  const goLimp = (vx: number, vy: number, vz: number) => {
    group.updateMatrixWorld(true)
    for (let i = 0; i < P_COUNT; i++) anchors[i].getWorldPosition(jointW[i])
    rag.start(jointW, velTmp.set(vx, vy, vz), 0x51ab0 + flops++)
    rag.drive(null)
    fling()
    wobV -= 2.5 // the blow itself sets the gummy wobbling
    downMotion = 0
    mode = 'down'
    downTime = 0
    riseFold = 0
    cullWas = mesh.frustumCulled
    // a tumbling body leaves the group's origin behind; its sphere cannot
    // follow it, so it stops being culled until it is back up
    mesh.frustumCulled = false
  }

  /** the limbs thrown outward from the trunk the instant a body goes limp:
      mittens and elbows away from the chest, feet and knees away from the
      hips, all of it a little upward. What turns "a body fell over" into
      "a body was *thrown*": the trunk takes the blow, the limbs trail it */
  const FLING: Array<[number, number, number]> = [
    [P_HANDL, P_CHEST, 11], [P_HANDR, P_CHEST, 11], [P_ELL, P_CHEST, 6], [P_ELR, P_CHEST, 6],
    [P_FOOTL, P_PELV, 6], [P_FOOTR, P_PELV, 6], [P_KNEEL, P_PELV, 3.5], [P_KNEER, P_PELV, 3.5],
  ]
  const fling = () => {
    const up = yA.subVectors(rag.pts[P_CHEST], rag.pts[P_PELV]).normalize()
    for (const [i, from, k] of FLING) {
      dirTmp.subVectors(rag.pts[i], rag.pts[from])
      // away from the spine, not along it: an arm hanging down is flung out
      dirTmp.addScaledVector(up, -dirTmp.dot(up))
      if (dirTmp.lengthSq() < 1e-6) dirTmp.set(rnd() - 0.5, 0, rnd() - 0.5)
      dirTmp.normalize().addScaledVector(up, 0.35).multiplyScalar(k * S * 0.65)
      rag.kick(i, dirTmp)
    }
  }
  /** the windmill a limp body does in the air: the mittens and boots are
      pushed round in circles for the first second of a flight, fading out,
      and only while they are clear of the ground */
  const FLAIL = [P_HANDL, P_HANDR, P_FOOTL, P_FOOTR, P_ELL, P_ELR]
  const flail = (dt: number, env: RagdollEnv) => {
    if (downTime > 1.6 || grabs > 0) return
    // the reach: while the chest is still off the ground, both mittens are
    // pulled out to either side of it and down toward the ground, arms wide,
    // the way anything with arms tries to catch itself. It is a velocity
    // nudge, so the tumble still wins, but it is why a falling body is an X
    // rather than a sack
    const chest = rag.pts[P_CHEST]
    const floorC = env.groundAt ? env.groundAt(chest.x, chest.z) : env.groundY
    if (chest.y > floorC + 1.3 * S) {
      const spine = vTmp.subVectors(rag.pts[P_CHEST], rag.pts[P_PELV]).normalize()
      const lat = vTmp2.subVectors(rag.pts[P_SHL], rag.pts[P_SHR])
      lat.addScaledVector(spine, -lat.dot(spine))
      if (lat.lengthSq() > 1e-6) {
        lat.normalize()
        // a spring acceleration toward each target, per second squared
        const reachK = 45 * (1 - downTime / 1.6) * dt
        for (const [i, side] of [[P_HANDL, 1], [P_HANDR, -1]] as const) {
          dirTmp.copy(chest).addScaledVector(lat, side * 1.5 * S).addScaledVector(spine, 0.2 * S)
          dirTmp.y -= 0.6 * S
          rag.kick(i, dirTmp.sub(rag.pts[i]).multiplyScalar(reachK))
        }
      }
    }
    const amp = 110 * S * (1 - downTime / 1.6) * dt
    for (let k = 0; k < FLAIL.length; k++) {
      const i = FLAIL[k]
      const p = rag.pts[i]
      const floor = env.groundAt ? env.groundAt(p.x, p.z) : env.groundY
      if (p.y < floor + radii[i] + 0.25 * S) continue
      const ph = downTime * 13 + k * 1.7
      const w = k < 2 ? 1 : k < 4 ? 0.6 : 0.5
      rag.kick(i, velTmp.set(Math.sin(ph), Math.cos(ph) * 0.8, Math.sin(ph * 0.7 + k)).multiplyScalar(amp * w))
    }
  }

  /*
    The sprawl. Once a flight is over, a body lying on the ground drifts its
    limbs out into a spread-eagle beside its own spine: mittens out past the
    shoulders, boots apart below the hips. It is a weak pull and only in the
    ground plane (each target sits at the particle's own height), so gravity,
    the floor and any later blow all win over it; what it changes is where a
    heap *settles*, which without it was on its side with the arms stacked
    and the knees together: a lump, not somebody who has just been hit by a
    car. The frame is the spine laid flat and its horizontal perpendicular,
    which exist whichever way up the body landed.
  */
  const sprawlTo = Array.from({ length: P_COUNT }, () => new THREE.Vector3())
  const sprawlK = new Float32Array(P_COUNT)
  const SPRAWL: Array<[number, number, number, number]> = [
    // particle, from (chest 1 / pelvis 0), sideways, along the spine
    [P_HANDL, 1, 1.25, 0.1], [P_HANDR, 1, -1.25, 0.1],
    [P_ELL, 1, 0.95, 0.2], [P_ELR, 1, -0.95, 0.2],
    [P_FOOTL, 0, 0.75, -1.2], [P_FOOTR, 0, -0.75, -1.2],
    [P_KNEEL, 0, 0.5, -0.65], [P_KNEER, 0, -0.5, -0.65],
  ]
  /** the sprawl's targets are laid out from the body's own chest and pelvis,
      so every pull toward them drags the heap after its own limbs: a motor
      that walked a knocked pedestrian across the road at 1.5 u/s for the two
      seconds it ran. Shifting every target by the pull's mass-weighted mean
      leaves the shaping (limbs out, shoulders level) and takes the walk out */
  const balanceSprawl = () => {
    let sx = 0
    let sz = 0
    let w = 0
    for (let i = 0; i < P_COUNT; i++) {
      const k = sprawlK[i] * MASSES[i]
      if (k === 0) continue
      sx += (sprawlTo[i].x - rag.pts[i].x) * k
      sz += (sprawlTo[i].z - rag.pts[i].z) * k
      w += k
    }
    if (w === 0) return
    sx /= w
    sz /= w
    for (let i = 0; i < P_COUNT; i++) {
      if (sprawlK[i] === 0) continue
      sprawlTo[i].x -= sx
      sprawlTo[i].z -= sz
    }
  }
  const sprawl = () => {
    const spine = dirTmp.subVectors(rag.pts[P_CHEST], rag.pts[P_PELV])
    spine.y = 0
    const len = spine.length()
    sprawlK.fill(0)
    // it only shapes how a heap *lands*: after two seconds the body is left
    // alone to come to rest, or the pull would argue with the bones forever
    // and the heap would never count as settled
    if (len < 0.2 * S || downTime < 0.45 || downTime > 2.2 || grabs > 0) {
      rag.drive(null)
      return
    }
    spine.multiplyScalar(1 / len)
    const lat = vTmp2.set(spine.z, 0, -spine.x)
    // left is whichever way the left shoulder already is
    if (lat.dot(vTmp.subVectors(rag.pts[P_SHL], rag.pts[P_SHR])) < 0) lat.negate()
    const k = 0.028 * Math.min(1, (downTime - 0.45) * 2)
    for (const [i, from, side, along] of SPRAWL) {
      const base = rag.pts[from === 1 ? P_CHEST : P_PELV]
      sprawlTo[i]
        .copy(base)
        .addScaledVector(lat, side * S)
        .addScaledVector(spine, along * S)
      sprawlTo[i].y = rag.pts[i].y
      sprawlK[i] = k
    }
    // a heap that ended up face down is rolled over onto its back: face down
    // under a big hat, all anybody sees is a teal disc, while on its back the
    // face, the belly and all four limbs are on show
    // It rolls over a shoulder, the way a body does: one shoulder and the
    // belly are lifted, and the levelling below is held off while it turns,
    // since level shoulders are exactly what stops a body rolling
    const faceDown = rag.pts[P_BELLY].y < rag.pts[P_PACK].y - 0.05 * S
    if (faceDown && downTime < 2.2) {
      // a real roll: an angular acceleration about the spine, applied to
      // every particle alike (v += alpha dt, axis x r), signed so the belly
      // turns up. A kick on one shoulder only argued with the rest of a heap
      // thirteen times its mass lying on the ground with friction
      const axis = yA.subVectors(rag.pts[P_CHEST], rag.pts[P_PELV]).normalize()
      const c = rag.pts[P_PELV]
      xA.subVectors(rag.pts[P_BELLY], c)
      zA.crossVectors(axis, xA)
      const sign = zA.y >= 0 ? 1 : -1
      const alpha = 22 * Math.min(1, (downTime - 0.45) * 2) * sign / 60
      for (let i = 0; i < P_COUNT; i++) {
        xA.subVectors(rag.pts[i], c)
        rag.kick(i, zA.crossVectors(axis, xA).multiplyScalar(alpha))
      }
      balanceSprawl()
      rag.drive(sprawlTo, sprawlK)
      return
    }
    // and the shoulders level with each other, which rolls a body lying on
    // its side over onto its back or its front (whichever it is nearer):
    // that is how a limp body settles, and it is the pose limbs can splay in
    const mid = (rag.pts[P_SHL].y + rag.pts[P_SHR].y) / 2
    for (const i of [P_SHL, P_SHR]) {
      sprawlTo[i].copy(rag.pts[i])
      sprawlTo[i].y = mid
      sprawlK[i] = k * 1.5
    }
    balanceSprawl()
    rag.drive(sprawlTo, sprawlK)
  }

  /*
    Friction on the heap as a whole. A body lying on the ground is not
    stopped by its particles' own floor grip alone: the face-down roll above
    is an angular kick the ground turns into rolling, and a round bean
    rolling reads as a statue skating across the road (measured: a knocked
    pedestrian drifted 3.5 units at 2.5 u/s for a second and a half after it
    landed). So once three or more particles are on the floor, the heap's
    mass-weighted planar velocity is bled away at HEAP_GRIP a second. Only
    the common motion goes: the roll still turns the body over about its own
    middle, and the limbs keep flopping and settling relative to it
  */
  const HEAP_GRIP = 14
  const brakeHeap = (dt: number, env: RagdollEnv) => {
    let touching = 0
    for (let i = 0; i < P_COUNT; i++) {
      const p = rag.pts[i]
      const floor = env.groundAt ? env.groundAt(p.x, p.z) : env.groundY
      if (p.y < floor + radii[i] + 0.12 * S) touching++
    }
    if (touching < 3) return
    let mx = 0
    let mz = 0
    let m = 0
    for (let i = 0; i < P_COUNT; i++) {
      rag.velocity(i, velTmp)
      mx += velTmp.x * MASSES[i]
      mz += velTmp.z * MASSES[i]
      m += MASSES[i]
    }
    const k = (1 - Math.exp(-HEAP_GRIP * dt)) / m
    velTmp.set(-mx * k, 0, -mz * k)
    for (let i = 0; i < P_COUNT; i++) rag.kick(i, velTmp)
  }

  const limbPos = (i: number, out: THREE.Vector3) => {
    if (mode !== 'up') return out.copy(rag.pts[i])
    return anchors[i].getWorldPosition(out)
  }

  const rig: PlayerRig = {
    group,
    mass: MASS,
    limbs,
    get down() {
      return mode !== 'up'
    },
    get ragdolling() {
      return mode === 'down'
    },
    get settled() {
      return mode === 'down' && grabs === 0 && downTime > 0.8 && rag.motion() < 0.9
    },
    focus: (out) => out.copy(rag.pts[P_CHEST]),
    getupSpot: (out) => out.copy(rag.pts[P_PELV]),
    unrest: () =>
      mode !== 'up' ||
      Math.abs(springP) > 0.004 ||
      Math.abs(springV) > 0.05 ||
      airK > 0.02 ||
      jiggleEnergy > 0.02 * S * S ||
      fidget !== null,
    get facing() {
      return facing
    },
    face: (yaw) => {
      facing = yaw
      facingSet = true
      turnActive = false
    },
    trackSlide: (x, z) => {
      if (slideSet && mode !== 'down') {
        const dx = x - slideX
        const dz = z - slideZ
        if (dx !== 0 || dz !== 0) {
          plantedL.x += dx
          plantedL.z += dz
          plantedR.x += dx
          plantedR.z += dz
          swingFrom.x += dx
          swingFrom.z += dz
          swingTarget.x += dx
          swingTarget.z += dz
        }
      }
      slideX = x
      slideZ = z
      slideSet = true
    },
    sit: (fit = 1, passenger = false) => {
      /*
        Seats differ in position, but the body shape is shared: hips on the
        cushion, knees up and elbows folded forward, hands together near the
        controls. CrtScene (or `net/avatars.ts`, for everyone else) parents
        the group to the active seat after calling this, so pitch and roll
        come from the machine itself.

        The fold hangs from the *eye*, not the hips: the pelvis is placed so
        the eye lands exactly on the group's origin, which is where a seat
        node puts the face. That is the thing a seat is actually fitted to:
        every cockpit lens in the fleet is authored at its own seat's face
        height, and the sofa puts the camera there too. The squash (see
        SIT_SQUASH) is what lets the rest of this body follow it in.
      */
      mode = 'up'
      showHead(true)
      pelvis.position.set(-SEAT_EYE_VEC.x, -SEAT_EYE_VEC.y, -SEAT_EYE_VEC.z).multiplyScalar(fit)
      pelvis.rotation.set(0, 0, 0)
      // squeezed in sideways too, more for a wide build, so two people on
      // one bench sit side by side rather than one inside the other
      const squeeze = 0.82 / Math.sqrt(persona.girth)
      pelvis.scale.set(SIT_SPREAD * fit * squeeze, SIT_SQUASH * fit, SIT_SPREAD * fit)
      torso.position.set(0, SIT_WAIST, 0)
      torso.rotation.set(-SIT_SLOUCH, 0, 0)
      torso.scale.set(1, 1, 1)
      armInv.set(1, 1, 1)
      head.position.set(0, SIT_NECK, 0)
      head.rotation.set(SIT_SLOUCH, 0, 0)
      head.scale.set(1 / SIT_SPREAD, 1 / SIT_SQUASH, 1 / SIT_SPREAD)
      paint.setLid(1)
      // the pom-pom lies back along the beanie rather than standing up
      // through a roof
      pom.quaternion.identity()
      pack.position.copy(REST[B.PACK])
      pack.rotation.set(0, 0, 0)

      // tucked: thighs forward, knees together, shins folded well back under
      // them, so the legs stay inside the footprint of the seat rather than
      // reaching out through a door or under a fuselage
      thighL.rotation.set(-1.4, 0, 0.06)
      thighR.rotation.set(-1.4, 0, -0.06)
      shinL.rotation.set(2.0, 0, 0)
      shinR.rotation.set(2.0, 0, 0)
      ankleL.position.copy(REST[B.FOOT_L])
      ankleR.position.copy(REST[B.FOOT_R])
      ankleL.rotation.set(-0.5, 0, 0)
      ankleR.rotation.set(-0.5, 0, 0)

      if (passenger) {
        // the passenger has nothing to hold: mittens dumped in the lap, one arm
        // flopped out over the door side
        uarmL.rotation.set(-0.35, 0, 0.7)
        uarmR.rotation.set(-0.55, 0, -0.1)
        farmL.rotation.set(-0.5, 0, 0)
        farmR.rotation.set(-1.25, 0, 0.35)
      } else {
        // elbows in against the belly, mittens forward on the controls
        uarmL.rotation.set(-0.7, 0, 0.12)
        uarmR.rotation.set(-0.7, 0, -0.12)
        farmL.rotation.set(-1.1, 0, -0.25)
        farmR.rotation.set(-1.1, 0, 0.25)
      }
      handL.quaternion.identity()
      handR.quaternion.identity()
      // a slumped sitter with a lean and a gaze of its own, so two people in
      // one car do not sit as one silhouette
      seated = true
      seatT = rnd() * 10
      seatTilt = (passenger ? 0.16 : -0.08) + (rnd() - 0.5) * 0.1
      seatLook = passenger ? 0.45 + rnd() * 0.2 : (rnd() - 0.5) * 0.2
      for (const j of JIGGLES) j.fresh = true
      seatedPose(0)
      followHelpers()
    },
    seatedTick: (dt) => {
      if (!seated) return
      seatT += dt
      seatedPose(dt)
      secondary(dt, 1)
    },
    flop: (vx, vy, vz) => {
      if (mode === 'up') {
        goLimp(vx, vy, vz)
        return
      }
      // already down (or getting up): go limp where it is and add the throw
      mode = 'down'
      rag.drive(null)
      riseFold = 0
      velTmp.set(vx, vy, vz)
      for (let i = 0; i < P_COUNT; i++) rag.kick(i, velTmp)
    },
    hit: (impulse, point) => {
      if (mode === 'up') goLimp(lastVel.x, lastVel.y, lastVel.z)
      else if (mode === 'rising') {
        mode = 'down'
        rag.drive(null)
        riseFold = 0
        downTime = 0
      }
      downTime = Math.min(downTime, 0.2)
      // the whole impulse as a velocity, then shared: the particles near the
      // point take most of it and every particle some, which is what turns
      // an off-centre blow into a spin rather than a slide
      const sigma = 0.55 * S
      let wMax = 0
      for (let i = 0; i < P_COUNT; i++) {
        const d2 = rag.pts[i].distanceToSquared(point)
        jointW[i].x = Math.exp(-d2 / (2 * sigma * sigma))
        if (jointW[i].x > wMax) wMax = jointW[i].x
      }
      for (let i = 0; i < P_COUNT; i++) {
        const w = 0.45 + 1.4 * (jointW[i].x / Math.max(1e-6, wMax))
        velTmp.copy(impulse).multiplyScalar(w / MASS)
        rag.kick(i, velTmp)
      }
    },
    beginRecover: () => {
      if (mode !== 'down') return
      group.updateMatrixWorld(true)
      // a heap lying far from where it is asked to stand (a remote body whose
      // owner got up somewhere this client never simulated) is carried there
      // first, or the muscles would haul it across the map
      vTmp.copy(rag.pts[P_PELV])
      const dx = group.position.x - vTmp.x
      const dz = group.position.z - vTmp.z
      if (dx * dx + dz * dz > (1.6 * S) * (1.6 * S)) {
        rag.shift(vTmp2.set(dx, group.position.y + 0.5 * S - vTmp.y, dz))
      }
      // stand up facing the way the head was lying, so the body gets up
      // forward out of the heap rather than spinning round to do it
      dirTmp.subVectors(rag.pts[P_HEAD], rag.pts[P_PELV])
      if (dirTmp.x * dirTmp.x + dirTmp.z * dirTmp.z > 0.04 * S * S) {
        facing = Math.atan2(-dirTmp.x, -dirTmp.z)
        facingSet = true
        turnActive = false
      }
      mode = 'rising'
      riseT = 0
      riseFold = 1 // the first frame of the rise is already the deep fold
      needReplant = true // fresh footing under the get-up spot
      for (let i = 0; i < P_COUNT; i++) rag.pin(i, null)
      grabs = 0
    },
    reset: () => {
      mode = 'up'
      seated = false
      downTime = 0
      riseT = 0
      riseFold = 0
      springP = 0
      springV = 0
      airK = 0
      fallK = 0
      fwdS = 0
      sideS = 0
      accF = 0
      lastFwd = 0
      yawRateS = 0
      strafeYaw = 0
      accS = 0
      lastSide = 0
      stillT = 0
      fidget = null
      shakeT = -1
      restSprings()
      rag.drive(null)
      for (let i = 0; i < P_COUNT; i++) rag.pin(i, null)
      grabs = 0
      // the seated squash and anything else scaled comes off
      pelvis.scale.set(1, 1, 1)
      torso.scale.set(1, 1, 1)
      armInv.set(1, 1, 1)
      head.scale.set(1, 1, 1)
      paint.setLid(1)
      head.position.copy(REST[B.HEAD])
      torso.position.copy(REST[B.TORSO])
      pack.position.copy(REST[B.PACK])
      pom.quaternion.identity()
      for (const j of JIGGLES) j.fresh = true
      if (!mesh.frustumCulled && cullWas) mesh.frustumCulled = true
      needReplant = true // the body teleported; feet must not IK across it
      facingSet = false
      turnActive = false
      slideSet = false
    },
    setLook: (next) => {
      personaFor(next)
      // the outfit, the face and the colours are uniforms; only the
      // headgear and the build are geometry
      paint.setLook(next)
      paint.setFace(persona.face)
      const hat = next.hat ?? 0
      const b = next.build ?? 0
      if (hat !== hatNow || b !== buildNow) {
        hatNow = hat
        buildNow = b
        mesh.geometry = wear()
      }
    },
    showHead,
    emote: (kind) => {
      if (mode !== 'up') return
      fidget = kind
      fidgetT = 0
      fidgetForced = true
    },
    limbPos,
    nearestLimb: (p) => {
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < limbs.length; i++) {
        const d = limbPos(i, vTmp).distanceTo(p) - radii[i]
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      return { index: best, dist: bestD }
    },
    grab: (i, target, k = 0.35) => {
      if (i < 0 || i >= limbs.length) return
      if (target && mode === 'up') goLimp(lastVel.x, lastVel.y, lastVel.z)
      else if (target && mode === 'rising') {
        mode = 'down'
        rag.drive(null)
        riseFold = 0
      }
      const had = rag.pinned(i)
      rag.pin(i, target, k)
      grabs += (target ? 1 : 0) - (had ? 1 : 0)
      downTime = 0
    },
    update: (pose, env) => {
      tickBodyBuilds()
      if (geoPending) mesh.geometry = wear()
      seated = false
      lastVel.set(pose.vx, pose.vy, pose.vz)
      showHead(pose.show > 0.12)
      if (mode === 'down') {
        downTime += pose.dt
        flail(pose.dt, env)
        sprawl()
        rag.step(pose.dt, env)
        if (grabs === 0) brakeHeap(pose.dt, env)
        fitFromParticles()
        // the gummy keeps wobbling while it tumbles: every hit the heap takes
        // (its average speed falling away in a frame) kicks the trunk's
        // volume spring, and the trunk squashes and bulges on it
        const m = rag.motion()
        wobV -= Math.max(0, downMotion - m) * 0.16
        downMotion = m
        wobV += (-200 * wobP - 3 * wobV) * pose.dt
        wobP = THREE.MathUtils.clamp(wobP + wobV * pose.dt, -0.28, 0.28)
        {
          const sq = 1 + wobP
          const bu = Math.pow(sq, -0.8)
          torso.scale.set(bu, sq, bu)
          armInv.set(1 / bu, 1 / sq, 1 / bu)
        }
        secondary(pose.dt, pose.show)
        return
      }
      // the get-up: the fold unwinds over the back of the rise, and every
      // spring in animate() follows the hips up out of it
      if (mode === 'rising') {
        riseT = Math.min(1, riseT + pose.dt / RISE_TIME)
        const stand = Math.max(0, (riseT - RISE_FOLD) / (1 - RISE_FOLD))
        riseFold = 1 - SMOOTH(stand)
      }
      animate(pose, env)
      if (mode === 'rising') {
        rise(pose, env)
        if (riseT >= 1) {
          mode = 'up'
          riseFold = 0
          rag.drive(null)
          shakeT = 0 // shake it off
          if (cullWas) mesh.frustumCulled = true
        }
      }
      secondary(pose.dt, pose.show)
    },
  }
  return rig
}
