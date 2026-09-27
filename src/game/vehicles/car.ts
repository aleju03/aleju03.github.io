import * as THREE from 'three'
import { noStand, type HullStation, type Solid } from '../physics/collision'
import {
  V,
  at,
  createFacets,
  createPartBuilder,
  markDynamic,
  revolve,
  tube,
  type Slot,
} from './parts'
import {
  SURFACE_FEEL,
  axes,
  clamp,
  clearAt,
  damp,
  groundNormal,
  groundUnder,
  netMotion,
  sweepBody,
  type NetMotion,
} from './chassis'
import type { DriveEnv, DriveStep, NetPose, Vehicle } from './types'
import type { VehicleMaterials } from './materials'

/*
  The car: a mid-2000s three-door hatch, the thing parked at the kerb
  outside the house, of an age with the computer upstairs.

  ---------------------------------------------------------------- the shell

  It is drawn the way a car is drawn on paper, in side and plan view, and it
  has to read at the pixel look's resolution, where the whole car is a few
  hundred pixels wide. That settles the style before anything else: flat,
  clearly separated planes with hard breaks between them, strong enough to
  survive the posterize and to be picked out by the look's fold ink, and no
  detail finer than a pixel or two. The loft this replaced was a smooth
  superellipse body with a smooth greenhouse on top, and through the look it
  read as a melted bar of soap: a lumpy bonnet, arches that were bulges, two
  white blobs for headlamps and a black B-pillar tube standing up through
  the side glass.

  `SECTIONS` is the control table: at each station the half-width, the sill,
  the beltline and the crown of the bonnet or boot lid. `profile(z)` turns a
  station into the same eight-point half section every time (tucked rocker,
  lower flank, bumper line, the flank's widest line, the shoulder, the deck
  edge, the deck and the centreline), so ring point j is the same feature the
  whole length of the car and skinning station to station draws the panels.
  Normals are *creased* (parts.ts's `createFacets`): faces
  meeting at more than about 34 degrees get a hard edge, anything gentler is
  smoothed, so the shoulder, the bonnet's edges and the corners of the nose
  and tail are crisp lines while the flank between them is one sheet of
  paint. `flankX()` reads the same profile back, which is how the shut-lines,
  the bumper joints, the handles and the mirrors land on the paint rather than
  near it.

  Three things a closed section cannot be asked for, and all three are cut
  into the profile rather than laid over it, which is the only place a hole
  can come from without CSG. The **wheel arches** are circles about the hubs,
  0.14 clear of the tyre at the top: where the circle is above the sill the
  lower rows are lifted onto it, and a lip standing ARCH_LIP proud of the
  flank finishes the edge, with a dark liner and an inboard wall behind it so
  the opening reads as a well with a wheel in it. The **cabin** is open from
  the scuttle to the rear bulkhead: there the deck rows drop to a floor, so
  the top of the body is a tub with inner door walls (trim) and door tops
  (paint), and a pair of stations a few centimetres apart at each end makes
  the step a wall rather than a ramp. And the **ends** are flat faces, fanned
  from their middles, because a flat face is where a real car's lamps, grille
  and plates are set: the headlamps are a lens on the nose face that carries
  on round the chamfered corner as cells of the body itself (the same for
  the tail lamps), so they are shapes in the bodywork rather than things
  stuck to it.

  The greenhouse stands on the door tops, drawn in over them (tumblehome) to
  a crowned roof. Glass and pillars are cells of one surface, split at
  `COLUMNS`, each a (base z, roof z) pair so a pillar leans the way the glass
  beside it does: A-pillar, door glass, a blacked-out B-pillar, the rear
  quarter light and the broad C-pillar that makes a hatch a hatch. Cells
  that share an edge cannot open a gap, and the opaque ones carry a trim
  lining facing in, since from the driver's seat a pillar and the roof are
  seen from behind. The windscreen and the tailgate glass are two panes each,
  meeting on the centreline, so they follow the roof's crown. The glass is
  flush with the pillars: at this resolution a reveal is less than a pixel,
  and the fold between the screen and the roof is what the ink draws.

  The end faces carry flat decals a centimetre or two proud: lamp lenses in
  dark surrounds, the grille with a chrome bar and badge, a wide lower intake
  with fog lamps in its corners, the plates, and the bumper joint, which
  runs on along both flanks to the arches and is what makes a bumper a
  separate part. A floor pan closes the section underneath, narrow through
  the arches and full width between them.

  --------------------------------------------------------------- the physics

  Four independent raycast spring/dampers, and a body with three degrees of
  freedom above them: heave, pitch and roll. That third piece is what most
  arcade cars skip and it is 80% of the feel — the squat, the dive and the
  lean are the whole reason a car reads as heavy.

  Spring rate comes from the frequency, not from a guessed number: 2 Hz means
  w = 2*pi*2 = 12.57 rad/s, so K = w^2 = 158 (units/s^2 of acceleration per
  unit of compression), and the damper is C = 2*zeta*w = 13.8 at zeta = 0.55.
  Static sag then follows arithmetically and cannot be chosen: gravity here is
  34 u/s^2, so the car sits at 34/158 = 0.215 units of compression, which is
  why SPRING_FREE is 0.565 and not 0.35. The brief's "+/- 0.35 of travel" is
  the *geometric* limit, and it is honoured — the bump stop is at 0.35 above
  static and the droop stop 0.35 below — but the wheel actually goes light at
  0.215 of droop, because that is where a 2 Hz spring under this gravity runs
  out of load. Anything else would be a lie about one of the three numbers.

  Pitch and roll are integrated as real angular DOF, with the suspension
  forces producing the restoring moments through their own moment arms. That
  makes the attitude self-consistent with the ride: drive up a kerb and the
  car leans because one spring compressed, no special case needed. Radii of
  gyration are 2.40 for pitch and 1.15 for roll (1.15 m and 0.55 m — a compact
  car's real figures), which lands pitch at 2.25 Hz and roll at 2.65 Hz, both
  a little stiffer than heave exactly as a real car is.

  Load transfer is then applied as an explicit moment, because a raycast
  suspension cannot generate one on its own: cornering force acts at the
  contact patches and the inertia acts at the centre of gravity, and with no
  rigid-body solver in between, the couple has to be written down. It is
  written down at an exaggerated CG height — 2.4 for pitch, 1.5 for roll,
  against a true CG of about 1.05 — because the honest numbers give 1.6 deg of
  dive under maximum braking, which is correct, invisible from a boom camera
  11.5 units back, and therefore worthless. At the values used, a full stop
  from top speed drops the nose about 0.29 units and a hard corner leans the
  car 4.7 deg. Both are readable; neither is cartoon.

  Stability was the constraint the whole time, because the integrator is
  semi-implicit Euler at whatever dt the caller hands over. The binding number
  is w*dt < 2: heave 12.57, pitch 14.1, roll 16.7, and the bump stop 26.5 —
  worst case 26.5/30 = 0.88 at a 30 Hz frame, comfortably inside. The drop
  test in the throwaway sim ran at 1/90, 1/60 and 1/30 and settles at all
  three.

  Longitudinally there are five gears and a reverse, and the shift is what
  shapes `rpm`: the gear changes instantly and the throttle is cut for 0.17 s,
  so the reported rev climbs to 0.96 and drops to 0.63..0.74 on every upshift,
  which is the sawtooth the sound synth needs. Top speed is set by where the
  torque curve crosses the drag curve, so it is a consequence rather than a
  clamp — 15.5 * 0.77 of drive against 0.006416 * v^2 + 1.4 of drag balances
  at 40 u/s, which is 69 km/h at real scale and 6.8 times running pace, and
  reads as fast in a world whose eye height is 1.7 m. What limits the launch
  is not the engine but LONG_GRIP: the first two gears would otherwise pull
  0.9 g off the line, so drive is capped at what the contact patches will take
  (15 u/s^2 scaled by the surface), which is also what makes a beach a beach.
  Measured: 40.3 u/s terminal, 0 to 38 in 5.7 s, and 28.5 units of braking
  distance from the top (1.5 s), over a nose that dives 4.1 degrees.

  Cornering is a kinematic bicycle model with a grip ceiling and a separate
  lateral-velocity state, which is the cheapest formulation that can actually
  drift. Steering lock decays exponentially with speed from 35.5 deg at a
  crawl to 5.4 deg flat out — without that the car is undriveable above about
  15 u/s. The yaw rate the steering asks for is capped by the front tyres'
  grip (that is understeer, and it is why you cannot corner harder by turning
  the wheel further), and the car's lateral velocity is bled off by the rear
  tyres at a rate capped by *their* grip. Space takes 84% of the rear grip
  away and multiplies the yaw rate by 1 + 1.7 * looseness, so the tail comes
  round and the body keeps travelling where it was going. Let go and the rear
  grip returns, the lateral velocity decays at 20/s, and the car straightens
  itself out — `slip` goes back to zero because the thing it measures went
  back to zero, not because a timer expired. Measured: full lock held at
  15 u/s turns a 20.3-unit circle that stays inside 1.2% over 400 ticks,
  pulling 11.1 u/s^2 against the 24 ceiling and leaning 2.6 degrees; full lock
  plus handbrake from 25 u/s swings the car 79 degrees with slip saturated and
  is back to zero 0.44 s after the key comes up.

  Gravity acts along the road as well as across it. The four springs alone
  only ever push *up*, so for a long time the car climbed a 45-degree
  mountainside at full speed without losing a unit of it and, released on the
  same slope, coasted a hundred units further uphill and stopped there. The
  missing term is one line: `groundNormal` gives the up vector of the drawn
  ground, and the component of it along the heading is exactly
  `GRAV * (n.x * fwdX + n.z * fwdZ)`, which is `GRAV * sin(slope)` down the
  fall line and identically zero on the flat — so every measured number on
  level asphalt is untouched. It is added *after* the rolling-resistance
  bleed, not before, because that bleed snaps a crawling car to a dead stop
  and gravity is not something a drag term is allowed to cancel.

  ...and a parked car is held by static friction, which has to be written down
  as one. Left with only drag opposing it, the fall-line term is fought by
  `feel.drag * 0.35 + ENGINE_BRAKE` = 2.69 u/s^2 at rest on asphalt, which
  gives up at 4.54 degrees — and 33.1% of this planet's dry land is steeper
  than that, 12.1% steeper than 8 degrees (31619 dry `terrainY` samples over
  6000x6000). Every car parked on that third drove itself downhill in reverse,
  collision box and all: 6.6 units in 8 s at 5 degrees, 45.4 at 8, and 83.0
  pinned against the reverse rev limiter at 15, with `moved` true on all 960
  ticks so the hand-baked shadow map re-fired every frame too — and that flag
  now reports the pitch and roll the body *realised* rather than the rates the
  integrator asked for, because parked across anything steeper than PITCH_CAP
  the moment never stops pushing and the clamp swallows every bit of it.

  What holds a real car is its tyres, and their budget is
  HOLD_MU * GRAV * cos(slope) against a pull of GRAV * sin(slope): under the
  break-away angle nothing moves at all, over it the same budget opposes the
  slide it can no longer stop. 46.4 degrees is where that lands, and the
  choice is not arbitrary — the climb gate below refuses anything over 36.9,
  so the hold has to be the larger number or the car could drive somewhere it
  cannot then stand. Of the same samples, 0.5% of dry land is over the climb
  gate and 0.1% over the hold, so what is left sliding is terrain the car
  could never have got onto in the first place. The gate is speed
  rather than input, so it also catches a car that has rolled to a halt, and
  it is released the instant the driver asks for throttle or reverse — a car
  that cannot be rolled back down a hill on purpose has the handbrake welded
  on. Measured over 960 undriven ticks at 0, 4, 5, 8, 15, 25, 35 and 45
  degrees, pointing up, down and across the fall line: drift 0.000 in every
  one of the 24 cases, `moved` false in all of them once the suspension has
  settled, and `placeAt` — which used to leave the car 0.079 off at 5 degrees
  and 3.875 at 45 during its own 60-tick settle — now lands it exactly where
  it was asked to.

  A gradient the tyres could not actually climb is a wall, not a ramp. Without
  that the springs happily levitate the car up a 60-unit cliff face: the
  support probe finds the clifftop under the front wheels, the bump stop fires
  at its 420-unit cap, and the whole machine goes up the wall. So the ground
  is sampled CLIMB_PROBE ahead of the centre along the direction of travel and
  compared with the ground under the wheels; over MAX_GRADE (0.75, about 37
  degrees) the longitudinal speed is killed and the contact is reported as an
  impact, exactly as a collision would be. The probe reads `groundAt` and not
  the support probe on purpose — kerbs, road decks and the porch step are
  collision box tops, and none of them should read as a cliff.

  Water is not a driving surface and the car does not swim. The support probe
  is clamped so the wheels can never fall more than 1.5 units below the
  waterline (which is up over the sills), and the drag climbs with depth, so
  driving into the sea wades, bogs and stops within a couple of car lengths
  instead of sinking through the seabed or floating like a boat. `wade`
  divides by that same 1.5 rather than by a rounder 2.0, because the clamp is
  what bounds the numerator: over 2.0 the depth term could never have passed
  0.75 and the deepest water was quietly a quarter weaker than intended.

  Collision is one `sweepBody` a tick against the body's own footprint, taken
  between 0.34 and 2.7 above the chassis floor so a kerb is something to drive
  over rather than something to stop against. The push is capped at 0.5 units
  so nothing teleports, only the closing component of the velocity is removed,
  a bite proportional to the closing rate comes off what is left, and the
  cross product of the contact offset with the push adds a little yaw — so a
  square hit stops you dead and a glancing one turns you. Driven flat out into
  a wall the car reports a 22 u/s impact, never moves more than 0.24 units in
  a tick, and comes to rest exactly its own half-length clear of the face.

  Unless the thing it met gives way. A solid may carry a `Breakable`
  (collision.ts) saying how fast something has to be closing to take it out of
  the world — a sapling, a cactus, a lamp post — and against one of those the
  push, the yaw and the velocity reflection are all skipped: the car keeps its
  line and pays a bite of speed instead, `limit * 0.6` units of it, so hitting
  a lamp post at just over its limit is nearly a stop and mowing a cactus at
  forty barely registers. The break test reads the car's planar speed rather
  than the closing rate along the contact normal, because a box's exit face is
  axis-aligned and clipping a trunk's corner at speed reports almost no
  closing at all — and a tree brushed off the wing at forty is still a tree
  that comes down. What happens to it after that is world/debris.ts's.

  That test alone leaves one hole, and it is the one everybody finds first: a
  car already *touching* a breakable can never break it. Contact removes the
  closing component of the velocity every tick, so a car nosed into a bush
  with the throttle buried never reaches 0.1 u/s, let alone the limit, and the
  bush is a wall forever. Measured against the real collision set, an approach
  at 5 u/s ended in a four-second dead stop with no way out but reverse. So a
  light solid also yields to being *leant on*: while the throttle is held into
  something under SHOVE_MAX, the drive force accumulates as work, and it goes
  when that clears its limit — about a third of a second for a bush, a couple
  for a dead tree. The gate is what keeps the original intent, that something
  out there can stop a hatchback: a birch and up is over SHOVE_MAX and still
  wants a genuine run-up, which is the difference between pushing through
  undergrowth and pushing over a tree.

  The other thing that reports an `impact` is a landing, and the only honest
  measure of one is how fast a *spring* is closing — never `vy`. The old test
  was `grounded && vyPrev < -6 && vy > vyPrev`, and vy is the whole car's
  descent: 35 u/s down a 20-degree slope is -12 u/s of it with the suspension
  sitting perfectly still, while the spring integration lifts vy on about half
  the ticks. Sat in the car on a 30-degree slope with no key pressed at all,
  that fired on 435 of 720 ticks, and `registry.ts` plays `vehicleImpact()` on
  every one — a collision sound forty-five times a second for as long as
  anybody sat there. A spring closing faster than SLAM_RATE *and* driven past
  SLAM_LEN into its bump travel is a real hit, whether the wheel had left the
  ground (a landing) or never did (a kerb at speed), and LAND_HOLD makes one
  arrival one event instead of the ten ticks it takes to stop bouncing.
  Measured: zero impacts over 720 ticks at 0, 10, 20, 30 and 45 degrees both
  parked and under full throttle down the slope, a 0.15 kerb taken at 30 u/s
  silent (it stops at 0.182 of spring length, and the 45-degree descent at
  0.276), and a genuine three-unit drop reporting exactly one impact of 13.8.

  The whole model is 8517 vertices and 5388 triangles as drawn, wheels
  included: fewer than the loft's 9580, because flat panels need no
  tessellation to look flat. The four wheels are two builds cloned, because
  a mirrored wheel needs its own winding and a negatively scaled one is
  inside out. Measured bounding box 3.99 x 3.06 x 8.97, symmetric about
  x = 0; the 3.99 is the mirrors, which stand outside the footprint the way
  real ones do, so `SIZE` reports the arch lips (HALF_WIDE) and the plates
  (HALF_LEN), which is where a collision should begin.

  The two front seats are the seat nodes (SEAT_EYE_Y, SEAT_FIT). With the
  bean at its crown-scaled size the fold is 0.8 about a face at 2.10, which
  measures (`npm run shoot -- body:car`, whose side tile prints it) a rider
  from 0.90, sunk into the cushion, to 2.92 at the top of a hat, under a
  headliner at about 2.98 over the seats.
*/

/* ------------------------------------------------------------------ scale --

   Everything below is in world units: 1 unit = 0.48 m, 2.08 units = 1 m.
   The car is 9.0 x 3.7 x 3.02 units = 4.33 x 1.78 x 1.45 m, which is a
   mid-2000s three-door hatch (a Golf of the time is 4.22 x 1.76 x 1.48). */

const LENGTH = 9.0
const HALF_LEN = LENGTH / 2 // 4.5: the plates and the exhaust, front and rear
/** 1.84 m over the arch lips: the car's stated width, and the collision
    footprint's. The body's own flank is BODY_HW; the lips stand ARCH_LIP
    proud of it, and the mirrors are outside it the way real ones are */
const BODY_HW = 1.79
const ARCH_LIP = 0.055
const HALF_WIDE = BODY_HW + ARCH_LIP
const ROOF_Y = 3.06 // 1.47 m to the crown of the roof
/** ...and to its edges over the side glass: the crown is the difference */
const ROOF_EDGE_Y = 2.97
const WHEELBASE = 5.4 // 2.60 m between the axles
const AXLE_Z = WHEELBASE / 2 // front axle -2.7, rear +2.7
const TRACK = 3.05 // 1.47 m between the tyre centrelines
const HALF_TRACK = TRACK / 2
const WHEEL_R = 0.66 // a 16 inch rim in a 55-profile tyre
const TYRE_HW = 0.21 // 0.42 wide, i.e. a 195-section tyre

/** the flat faces the lamps, grille and plates are set into */
const NOSE_Z = -4.46
const TAIL_Z = 4.42

/* ----------------------------------------------------------- the section --

   The body is described the way a car is drawn in side and plan view: a
   table of stations along its length, each giving the half-width, the sill,
   the beltline and the bonnet (or boot lid) crown there. Every station is
   turned into the same eight-point half profile (`profile`), so ring point j
   is the same feature the whole length of the car: the tucked rocker, the
   lower flank, the bumper line, the flank's widest line, the shoulder, the
   deck edge, the deck and the centreline. Skinned station to station those
   rows are the panels, and a row that turns a corner is a crease. */
interface Sect {
  z: number
  hw: number
  sill: number
  belt: number
  /** bonnet or boot-lid crown on the centreline; unused where the cabin is
      open, since there the deck is the cabin floor */
  deck: number
}

const SECTIONS: Sect[] = [
  { z: NOSE_Z, hw: 1.46, sill: 0.62, belt: 1.61, deck: 1.63 },
  { z: -4.30, hw: 1.64, sill: 0.56, belt: 1.68, deck: 1.72 },
  { z: -3.95, hw: 1.76, sill: 0.52, belt: 1.75, deck: 1.81 },
  { z: -2.70, hw: BODY_HW, sill: 0.50, belt: 1.86, deck: 1.93 },
  { z: -2.00, hw: BODY_HW, sill: 0.48, belt: 1.93, deck: 2.00 },
  { z: 0.00, hw: BODY_HW, sill: 0.48, belt: 2.03, deck: 2.06 },
  { z: 2.70, hw: BODY_HW, sill: 0.50, belt: 2.12, deck: 2.16 },
  { z: 3.70, hw: 1.77, sill: 0.53, belt: 2.15, deck: 2.19 },
  { z: 4.20, hw: 1.70, sill: 0.58, belt: 2.12, deck: 2.16 },
  { z: TAIL_Z, hw: 1.50, sill: 0.64, belt: 2.05, deck: 2.09 },
]

const sectionAt = (z: number): Sect => {
  if (z <= SECTIONS[0].z) return { ...SECTIONS[0], z }
  const last = SECTIONS[SECTIONS.length - 1]
  if (z >= last.z) return { ...last, z }
  let i = 1
  while (SECTIONS[i].z < z) i++
  const a = SECTIONS[i - 1]
  const b = SECTIONS[i]
  const t = (z - a.z) / (b.z - a.z)
  const mix = (p: number, q: number) => p + (q - p) * t
  return { z, hw: mix(a.hw, b.hw), sill: mix(a.sill, b.sill), belt: mix(a.belt, b.belt), deck: mix(a.deck, b.deck) }
}

/** the heights of the two rows that are the same everywhere: the bumper
    line the headlamps sit on and the flank's widest line they reach up to */
const LAMP_Y = 1.26
const CREASE_Y = 1.56

/* The wheel arches are a circle about each hub, 0.14 clear of the tyre at
   the top, and the section's lower edge simply follows it: where the circle
   is above the sill, the rocker, the lower flank and the bumper line are
   lifted onto it and squeeze up under the crease. Below the hub the opening
   drops straight to the sill, which is how a real arch meets a real rocker. */
const ARCH_R = 0.8
const archY = (z: number) => {
  let y = -Infinity
  for (const az of [-AXLE_Z, AXLE_Z]) {
    const d = z - az
    if (Math.abs(d) <= ARCH_R) y = Math.max(y, WHEEL_R + Math.sqrt(ARCH_R * ARCH_R - d * d))
  }
  return y
}

/* The cabin is open from the scuttle to the rear bulkhead: there the deck
   rows drop to a floor instead of closing over the top, which turns the top
   of the body into a tub with an inner door wall, and the greenhouse stands
   on the door tops. Each end gets a pair of stations a few centimetres apart
   so the step down is a wall (the scuttle under the windscreen, the bulkhead
   under the tailgate glass), not a ramp. */
const CABIN_Z0 = -1.94
const CABIN_Z1 = 3.96
const CABIN_FLOOR = 0.72
/** the door's leading and trailing shut-lines */
const DOOR_Z0 = -1.8
const DOOR_Z1 = 1.16
const cabinOpen = (z: number) => z > CABIN_Z0 - 1e-6 && z < CABIN_Z1 + 1e-6

/** the eight-point half profile at z, bottom edge to centreline, as [x, y] */
const profile = (z: number): Array<[number, number]> => {
  const s = sectionAt(z)
  const bottom = Math.max(s.sill, archY(z))
  const hw = s.hw
  const lower: Array<[number, number]> = [
    [hw - 0.13, bottom],
    [hw - 0.015, Math.max(0.86, bottom + 0.03)],
    [hw, Math.max(LAMP_Y, bottom + 0.06)],
    [hw, CREASE_Y],
    [hw - 0.1, s.belt],
  ]
  if (cabinOpen(z)) {
    return [...lower, [hw - 0.26, s.belt], [hw - 0.28, CABIN_FLOOR], [0, CABIN_FLOOR]]
  }
  return [...lower, [hw - 0.26, s.belt + 0.035], [hw * 0.55, s.deck - 0.01], [0, s.deck]]
}
const ROWS = 8

/** the outside of the flank (rows 0..4) at (z, y): where a seam, a handle
    or a bumper line has to lie to be on the paint */
const flankX = (z: number, y: number) => {
  const p = profile(z)
  if (y <= p[0][1]) return p[0][0]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = p[i]
    const [x1, y1] = p[i + 1]
    if (y <= y1) return x0 + ((x1 - x0) * (y - y0)) / Math.max(1e-6, y1 - y0)
  }
  return p[4][0]
}

/* The stations the body is actually skinned on: the table, the two cabin
   walls, and enough of each arch to draw its circle. */
const BODY_Z: number[] = SECTIONS.map((s) => s.z)
const addZ = (z: number) => {
  if (BODY_Z.every((q) => Math.abs(q - z) > 0.004)) BODY_Z.push(z)
}
for (const az of [-AXLE_Z, AXLE_Z]) {
  for (const k of [-1.0125, -1, -0.94, -0.8, -0.6, -0.36, 0, 0.36, 0.6, 0.8, 0.94, 1, 1.0125]) {
    addZ(az + k * ARCH_R)
  }
}
for (const z of [CABIN_Z0 - 0.06, CABIN_Z0, CABIN_Z1, CABIN_Z1 + 0.06, DOOR_Z0, DOOR_Z1]) addZ(z)
BODY_Z.sort((a, b) => a - b)

/* ------------------------------------------------------------ greenhouse --

   Five columns along each side, each a (base z, roof z) pair, so a pillar
   leans the way the glass beside it does: the windscreen's edge, the
   A-pillar's trailing edge, the B-pillar (blacked out) and the C-pillar, which
   on a hatch is the widest panel on the car. The base runs on the door tops
   a little inboard of the shoulder, the roof edge is drawn in over it (the
   tumblehome), and the roof is crowned on the centreline. */
const WS_BASE_Z = -1.96
const WS_TOP_Z = 0.05
const BL_TOP_Z = 3.0
const BL_BASE_Z = 3.98
const COLUMNS: Array<[number, number]> = [
  [WS_BASE_Z, WS_TOP_Z],
  [-1.76, 0.2],
  [1.0, 0.9],
  [1.24, 1.12],
  [2.72, 2.4],
  [BL_BASE_Z, BL_TOP_Z],
]
/** the base line: on the door tops, 0.17 inboard of the flank */
const glassBase = (z: number): THREE.Vector3 => {
  const s = sectionAt(z)
  return new THREE.Vector3(s.hw - 0.17, s.belt - (z < CABIN_Z0 ? 0.02 : 0), z)
}
/** the roof edge, drawn in over the base, falling a touch toward the tail */
const roofEdge = (z: number): THREE.Vector3 => {
  const t = clamp((z - WS_TOP_Z) / (BL_TOP_Z - WS_TOP_Z), 0, 1)
  return new THREE.Vector3(1.36 - 0.03 * t, ROOF_EDGE_Y - 0.04 * t, z)
}
const roofCrown = (z: number): THREE.Vector3 => {
  const e = roofEdge(z)
  return new THREE.Vector3(0, e.y + (ROOF_Y - ROOF_EDGE_Y), z)
}

/** the top of the car at z along the centreline: bonnet, glass, roof, glass,
    boot lid. Read by the collision profile, so a walker stands on the car
    the car draws */
const topAt = (z: number) => {
  const s = sectionAt(z)
  if (z <= WS_BASE_Z || z >= BL_BASE_Z) return s.deck
  if (z < WS_TOP_Z) {
    const t = (z - WS_BASE_Z) / (WS_TOP_Z - WS_BASE_Z)
    return Math.max(s.deck, glassBase(WS_BASE_Z).y + (roofCrown(WS_TOP_Z).y - glassBase(WS_BASE_Z).y) * t)
  }
  if (z > BL_TOP_Z) {
    const t = (z - BL_TOP_Z) / (BL_BASE_Z - BL_TOP_Z)
    return Math.max(s.deck, roofCrown(BL_TOP_Z).y + (glassBase(BL_BASE_Z).y - roofCrown(BL_TOP_Z).y) * t)
  }
  return roofCrown(z).y
}

/* ------------------------------------------------------------- footprint --

   What a walker actually collides with, read off the same tables the paint
   is skinned from so it cannot drift from it: the section's half-width plus
   the arch lip, and the top of the car at that station. The windscreen and
   the tailgate glass get stations of their own so the profile climbs the
   glass instead of cutting the corner, and the bonnet is a surface at bonnet
   height, low enough to hop onto, with the roof a step up from there. The
   plates and bumper faces cap each end as two narrow stations. */
const HULL: HullStation[] = [
  { z: -HALF_LEN, hw: 1.3, top: 1.2 },
  ...[...SECTIONS.map((s) => s.z), WS_BASE_Z, WS_TOP_Z, BL_TOP_Z, BL_BASE_Z]
    .sort((a, b) => a - b)
    .map((z) => ({ z, hw: sectionAt(z).hw + ARCH_LIP, top: topAt(z) })),
  { z: HALF_LEN, hw: 1.3, top: 1.2 },
]

/* ------------------------------------------------------------- mesh kit -- */

/** a plain box, for the dozens of small details where a bevel would be
    spent on something four pixels across */
const chip = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d)


/** a flat decal on the nose or the tail face: a rectangle at z, facing
    along `dir` (-1 forward, +1 back), standing `off` proud of the face */
const facePanel = (
  f: ReturnType<typeof createFacets>,
  x0: number, x1: number, y0: number, y1: number,
  z: number, dir: number, slot: Slot,
) => {
  f.quadOut(V(x0, y0, z), V(x1, y0, z), V(x1, y1, z), V(x0, y1, z), slot, V(0, 0, dir))
}

/** a thin line lying on the flank from (z0, y0) to (z1, y1), `off` proud of
    the paint: a shut-line, a bumper joint. Its width is across the line */
const flankLine = (
  f: ReturnType<typeof createFacets>,
  pts: Array<[number, number]>, half: number, slot: Slot, off = 0.012,
) => {
  for (let i = 0; i < pts.length - 1; i++) {
    const [za, ya] = pts[i]
    const [zb, yb] = pts[i + 1]
    // across the line, in the (z, y) plane
    const len = Math.hypot(zb - za, yb - ya) || 1
    const nz = (-(yb - ya) / len) * half
    const ny = ((zb - za) / len) * half
    const at = (z: number, y: number) => V(flankX(z, y) + off, y, z)
    f.quadBoth(at(za - nz, ya - ny), at(zb - nz, yb - ny), at(zb + nz, yb + ny), at(za + nz, ya + ny), slot, V(1, 0, 0))
  }
}

const TAU = Math.PI * 2

/* ---------------------------------------------------------------- dynamics -- */

const GRAV = 34 // 16.3 m/s^2, the walk controller's deliberately heavy gravity

/** 2 Hz suspension: w = 2*pi*2, K = w^2, C = 2*zeta*w at zeta = 0.55 */
const SPRING_W = Math.PI * 4
const SPRING_K = SPRING_W * SPRING_W // 157.9
const SPRING_C = 2 * 0.55 * SPRING_W // 13.82
/** the length at which the spring is unloaded. Static sag is GRAV/SPRING_K =
    0.215, and the wheel must sit WHEEL_R under the hardpoint at rest, so this
    is forced: 0.35 (the rest length) + 0.215 */
const SPRING_FREE = 0.35 + GRAV / SPRING_K
/** hardpoint height above the chassis origin: wheel radius plus rest length */
const HARD_Y = WHEEL_R + 0.35
/** geometric stops. Bump at 0.35 above static, droop 0.35 below */
const LEN_MIN = 0
const LEN_MAX = 0.7
/** below this the bump rubber takes over. w = sqrt(700) = 26.5, so w*dt at a
    30 Hz frame is 0.88 — inside the semi-implicit Euler limit of 2 */
const STOP_LEN = 0.07
const STOP_K = 700
const FORCE_CAP = 420 // ~12 g at one corner; a landing cannot fire the car off

/** radii of gyration: 1.15 m in pitch, 0.55 m in roll, converted */
const RAD_PITCH2 = 2.4 * 2.4
const RAD_ROLL2 = 1.15 * 1.15
/** the CG heights the load-transfer couple is applied at. The true CG is
    about 1.05; these are exaggerated because 1.6 degrees of honest dive is
    invisible from a boom camera 11.5 units back */
const H_PITCH = 2.4
const H_ROLL = 1.5
const PITCH_CAP = 0.30
const ROLL_CAP = 0.28
/** attitude held in the air: a little nose-down, wings level */
const AIR_PITCH = -0.06

const TOP_SPEED = 40 // 19.2 m/s = 69 km/h, 6.8x running pace
const REV_TOP = 12
/** road speed each gear runs out at */
const GEAR_TOP = [9, 16.5, 24, 31.5, 40]
/** and the torque multiplier it pulls with. A compressed spread, not a real
    gearbox's — first gear at a true ratio would be 0.6 g off the line */
const GEAR_GAIN = [2.35, 1.72, 1.34, 1.12, 1.0]
const POWER = 15.5
/** balances POWER * torque(1) against rolling drag at exactly TOP_SPEED, so
    the top speed is where two curves cross rather than where a clamp bites:
    (15.5 * 0.77 - 1.4) / 40^2 */
const AERO = 0.006416
/** the tyres, not the engine, are what limits a standing start. 15 u/s^2 is
    0.72 g, which is a good street tyre on dry asphalt and — read through
    SURFACE_FEEL.grip — is also what makes sand feel like wading */
const LONG_GRIP = 15
const ENGINE_BRAKE = 2.2
/** what a *stopped* car's tyres hold before they let it slide, as tan(slope).
    It is neither LONG_GRIP (capped low on purpose so a launch does not read
    as a dragster) nor BRAKE: it is the peak a dry tyre gives before it breaks
    away, and 1.05 — 46.4 degrees — is chosen so the car holds any slope it
    could have got onto under its own power. The climb gate stops it at
    MAX_GRADE, 37 degrees; a machine that can drive up 37 and then slide back
    down it would be absurd, so the hold has to be the larger number */
const HOLD_MU = 1.05
/** and what counts as stopped. 0.5 u/s is 0.24 m/s: below it the car is
    parked and the fall line is held, above it the fall line is free to pull */
const HOLD_SPEED = 0.5
/** the heaviest thing a standing shove can move, as a break limit. A bush
    (2.5) and a cactus (7) yield to a lean; a birch (15) does not, and a
    mature broadleaf (26) is what the world stops you with */
const SHOVE_MAX = 10
/** and how much work it takes, per unit of limit. Drive force on grass caps
    around 10, so a bush goes in a third of a second and a dead tree in one */
const SHOVE_COST = 1.4
const BRAKE = 22 // 10.6 m/s^2, about 1.08 g: a good hatch on dry asphalt
const HAND_LONG = 9
const SHIFT_TIME = 0.17 // throttle cut, and therefore the dip in the note

/** full lock at a crawl (35.5 deg), and what is left at speed (5.4 deg). The
    decay constant is a speed, not a fraction: 13 u/s halves the difference */
const LOCK_HI = 0.62
const LOCK_LO = 0.095
const LOCK_FADE = 13
const STEER_RATIO = 5 // road angle to steering-wheel angle, for the model

const GRIP = 24 // peak lateral acceleration on dry asphalt, u/s^2
const LAT_STIFF = 20 // how fast the tyres eat lateral velocity, per second
const OVERSTEER = 1.7 // yaw-rate multiplier at fully broken-away rear
const YAW_RATE_LAG = 8.5

const PUSH_CAP = 0.5 // the most a collision may teleport the car in one tick

/** what a landing is, measured on the springs: one of them driven this deep
    into its bump travel (0.20 of the 0.35 there is above static) while still
    closing this fast (units/s of its own length). Both conditions are needed
    and neither is vy. A wheel arriving on the road closes at the speed it is
    approaching that road, which is what `len` differences report; vy is the
    whole car's descent and sits at -12 u/s down a 20-degree slope with the
    suspension perfectly still. Measured against the alternatives: a 0.15 kerb
    taken at 30 u/s stops at 0.182 of length and a 45-degree descent under
    full throttle at 0.276, while a three-unit drop closes at 13.9 u/s and
    goes all the way to the stop */
const SLAM_LEN = SPRING_FREE - GRAV / SPRING_K - 0.20
const SLAM_RATE = 9
/** one arrival is one event. A landing bounces for the better part of a
    second, and a bump stop rings; without this the same touchdown reports an
    impact per tick all the way down */
const LAND_HOLD = 0.3

/** how far ahead of the body's centre the ground is sampled for the climb
    gate, and the steepest gradient the wheels are allowed to take. 0.75 is
    about 37 degrees — well past any road and any ramp the world builds, and
    well under the mountainsides the springs used to levitate the car up. The
    probe is a shade under HALF_LEN so the car stops with its bumper against
    the face rather than a car's length short of it or buried in it */
const CLIMB_PROBE = 4.4
const MAX_GRADE = 0.75

/** torque against normalised revs: soft off idle, peak at 0.59, tailing off
    at the limiter so there is a reason to shift */
const torqueAt = (r: number) => clamp(0.62 + 1.0 * r - 0.85 * r * r, 0.15, 1)

/* ------------------------------------------------------------------ build -- */

export interface CarOpts {
  mats: VehicleMaterials
}

/** the seated face in either front seat, and how far `sit()` folds a body
    smaller about it (playerBody's CABIN_FIT). The face is in the side
    window, where somebody outside can see who is driving; the fold is what
    keeps the crown (and a hat) under the headliner and the seat of the
    pants on the cushion at that height */
const SEAT_EYE_Y = 2.1
const SEAT_Z = 0.3
const SEAT_FIT = 0.8
/** the driver's centreline: left-hand drive */
const DX = -0.78

export function buildCar(opts: CarOpts): Vehicle {
  const { mats } = opts
  const slots = mats.slots

  /* ------------------------------------------------------------ the shell -- */

  const b = createPartBuilder()
  const f = createFacets()

  // --- the body: every station's ring, both halves, skinned station to
  // station. A ring runs from the left sill over the top to the right sill,
  // so the section is open underneath (the floor pan closes it) and one
  // winding faces every panel outward, and every cabin wall inward
  const rings = BODY_Z.map((z) => {
    const half = profile(z)
    const ring: THREE.Vector3[] = []
    for (let i = 0; i < ROWS; i++) ring.push(V(-half[i][0], half[i][1], z))
    for (let i = ROWS - 2; i >= 0; i--) ring.push(V(half[i][0], half[i][1], z))
    return ring
  })
  /** which row pair a ring segment is, counted from the sill on either side */
  const rowOf = (k: number) => (k < ROWS - 1 ? k : 2 * ROWS - 3 - k)
  const SEGS = 2 * ROWS - 2
  for (let s = 0; s < rings.length - 1; s++) {
    const z0 = BODY_Z[s]
    const z1 = BODY_Z[s + 1]
    const zm = (z0 + z1) / 2
    const open = cabinOpen(z0) && cabinOpen(z1)
    for (let k = 0; k < SEGS; k++) {
      const row = rowOf(k)
      let slot: Slot = 'paint'
      // the tub: inner door walls and floor are trim, the door tops paint
      if (open && row >= 5) slot = 'trim'
      // the lamps wrap the corners and sweep back along the wings, the way
      // a mid-2000s car's do: between the bumper line and the crease at the
      // nose, between the crease and the shoulder at the tail
      if (z1 <= -3.95 + 1e-6 && row === 2) slot = 'lamp'
      if (zm > 4.02 && row === 3) slot = 'lampRed'
      f.quad(rings[s][k], rings[s + 1][k], rings[s + 1][k + 1], rings[s][k + 1], slot)
    }
  }
  /* the two end faces, fanned from their middles. The nose face is where the
     grille, the lamps, the intake and the plate go; the tail face carries the
     lamps and the plate */
  for (const [ring, dir] of [[rings[0], -1], [rings[rings.length - 1], 1]] as const) {
    const zc = ring[0].z
    const c = V(0, (ring[0].y + ring[ROWS - 1].y) / 2, zc)
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k]
      const q = ring[(k + 1) % ring.length]
      if (dir < 0) f.tri(c, p, q, 'paint')
      else f.tri(c, q, p, 'paint')
    }
  }

  // --- greenhouse ------------------------------------------------------------
  /* Glass and pillars are cells of one surface, so they meet without a gap:
     a column pair per cell, base on the door top, top on the roof edge. The
     opaque cells get a trim lining facing in, since from the driver's seat a
     pillar is seen from behind and a front face alone would be a hole */
  const colBase = COLUMNS.map(([zb]) => glassBase(zb))
  const colTop = COLUMNS.map(([, zt]) => roofEdge(zt))
  const CELL: Slot[] = ['paint', 'glass', 'dark', 'glass', 'paint']
  const lining = (a: THREE.Vector3, b2: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, out: THREE.Vector3) => {
    const k = -0.025
    const s = out.clone().normalize().multiplyScalar(k)
    f.quadBoth(a.clone().add(s), b2.clone().add(s), c.clone().add(s), d.clone().add(s), 'trim', out.clone().negate())
  }
  for (let i = 0; i < CELL.length; i++) {
    const out = V(1, 0.3, 0)
    f.quadBoth(colBase[i], colBase[i + 1], colTop[i + 1], colTop[i], CELL[i], out)
    if (CELL[i] !== 'glass') lining(colBase[i], colBase[i + 1], colTop[i + 1], colTop[i], out)
  }
  // the roof: edge to crown on each side, over the column tops, so its edges
  // are the side glass's own
  const roofZ = COLUMNS.map(([, zt]) => zt)
  for (let i = 0; i < roofZ.length - 1; i++) {
    const a = roofEdge(roofZ[i])
    const bb = roofEdge(roofZ[i + 1])
    const ca = roofCrown(roofZ[i])
    const cb = roofCrown(roofZ[i + 1])
    f.quadBoth(a, bb, cb, ca, 'paint', V(0.2, 1, 0))
    lining(a, bb, cb, ca, V(0.2, 1, 0))
  }
  // windscreen and tailgate glass: two panes meeting on the centreline, so
  // the glass follows the roof's crown instead of leaving a slot under it
  const wsC = V(0, glassBase(WS_BASE_Z).y, WS_BASE_Z)
  f.quadBoth(wsC, colBase[0], colTop[0], roofCrown(WS_TOP_Z), 'glass', V(0, 0.6, -1))
  const blC = V(0, glassBase(BL_BASE_Z).y, BL_BASE_Z)
  f.quadBoth(blC, colBase[5], colTop[5], roofCrown(BL_TOP_Z), 'glass', V(0, 0.6, 1))
  // the roof spoiler: the roof's trailing edge carried on and kicked up
  {
    const e0 = roofEdge(BL_TOP_Z)
    const c0 = roofCrown(BL_TOP_Z)
    const e1 = V(e0.x - 0.06, e0.y + 0.02, BL_TOP_Z + 0.34)
    const c1 = V(0, c0.y - 0.02, BL_TOP_Z + 0.34)
    const drop = (p: THREE.Vector3) => V(p.x, p.y - 0.09, p.z)
    f.quadBoth(e0, e1, c1, c0, 'paint', V(0, 1, 0))
    f.quadBoth(drop(e0), drop(e1), drop(c1), drop(c0), 'paint', V(0, -1, 0))
    f.quadBoth(e1, drop(e1), drop(c1), c1, 'paint', V(0, 0, 1))
    f.quadBoth(e0, drop(e0), drop(e1), e1, 'paint', V(1, 0, 0))
  }

  // --- wheel arches ----------------------------------------------------------
  /* The opening is already in the section (the lower rows ride `archY`).
     What finishes it is a lip standing ARCH_LIP proud of the flank round the
     top of the circle and down both legs to the sill, its underside rolling
     back into the opening, and a dark well behind it: a liner under the lip
     and a wall inboard of the tyre, so the arch reads as a hole with a wheel
     in it rather than as paint with a wheel stuck on */
  const LIP_W = 0.13
  for (const az of [-AXLE_Z, AXLE_Z]) {
    // the path round the opening, rear leg first, as (dz, y) with its
    // outward direction (away from the hub, or straight fore/aft on a leg)
    const path: Array<[number, number, number, number]> = []
    const sill = sectionAt(az).sill + 0.03
    path.push([ARCH_R, sill, 1, 0], [ARCH_R, WHEEL_R, 1, 0])
    for (let i = 1; i < 14; i++) {
      const a = (i / 14) * Math.PI
      path.push([ARCH_R * Math.cos(a), WHEEL_R + ARCH_R * Math.sin(a), Math.cos(a), Math.sin(a)])
    }
    path.push([-ARCH_R, WHEEL_R, -1, 0], [-ARCH_R, sill, -1, 0])
    for (let i = 0; i < path.length - 1; i++) {
      const pa = path[i]
      const pb = path[i + 1]
      const edge = (p: typeof pa, r: number) => {
        const z = az + p[0] + p[2] * r
        const y = p[1] + p[3] * r
        return { z, y }
      }
      const ia = edge(pa, 0)
      const ib = edge(pb, 0)
      const oa = edge(pa, LIP_W)
      const ob = edge(pb, LIP_W)
      const hwA = sectionAt(ia.z).hw
      const hwB = sectionAt(ib.z).hw
      // the lip's face: out at the lip's edge, flush with the flank behind it
      const lipA = V(hwA + ARCH_LIP, ia.y, ia.z)
      const lipB = V(hwB + ARCH_LIP, ib.y, ib.z)
      f.quadBoth(lipA, lipB, V(flankX(ob.z, ob.y), ob.y, ob.z), V(flankX(oa.z, oa.y), oa.y, oa.z), 'paint', V(1, 0, 0))
      // its underside, rolling back to the body's tucked lower edge
      const inA = V(hwA - 0.13, ia.y, ia.z)
      const inB = V(hwB - 0.13, ib.y, ib.z)
      // toward the hub, which is where the underside and the liner face
      const down = V(0, WHEEL_R - (ia.y + ib.y) / 2, az - (ia.z + ib.z) / 2)
      f.quadBoth(inA, inB, lipB, lipA, 'paint', down)
      // the liner: the roof of the well, in from under the lip to the wall
      f.quadBoth(V(1.1, ia.y, ia.z), V(1.1, ib.y, ib.z), inB, inA, 'dark', down)
      // and the wall inboard of the tyre, fanned from the hub
      f.triBoth(V(1.1, WHEEL_R, az), V(1.1, ib.y, ib.z), V(1.1, ia.y, ia.z), 'dark', V(1, 0, 0))
    }
    // the wall's bottom, from leg to leg under the hub
    f.quadBoth(
      V(1.1, sill - 0.08, az + ARCH_R), V(1.1, sill - 0.08, az - ARCH_R),
      V(1.1, WHEEL_R, az - ARCH_R), V(1.1, WHEEL_R, az + ARCH_R), 'dark', V(1, 0, 0),
    )
  }

  // --- the underside ----------------------------------------------------------
  // the floor pan, narrow through the arches and full width between and
  // beyond them, so a low camera sees a dark floor rather than into the shell
  b.add(chip(2.2, 0.1, 8.7), 'dark', at(0, 0.5, 0))
  b.add(chip(3.2, 0.08, 3.74), 'dark', at(0, 0.49, 0))
  b.add(chip(2.9, 0.08, 0.86), 'dark', at(0, 0.6, -3.93))
  b.add(chip(2.9, 0.08, 0.82), 'dark', at(0, 0.62, 3.93))

  // --- the nose ----------------------------------------------------------------
  const NF = NOSE_Z - 0.012
  const NF2 = NOSE_Z - 0.02
  const NHW = SECTIONS[0].hw
  /* headlamp: a lens across the face that carries on round the corner and
     back along the wing (the lamp cells of the body), in a dark surround.
     It is a wedge, not a slab: shallow at its inboard end and full height
     where it turns the corner, which is the swept-back lamp of the period
     and what stops two pale rectangles reading as a pair of blobs. A dark
     projector bowl at the inboard end gives it an inside */
  const lampQuad = (x0: number, x1: number, lo0: number, hi0: number, lo1: number, hi1: number, z: number, slot: Slot) => {
    f.quadBoth(V(x0, lo0, z), V(x1, lo1, z), V(x1, hi1, z), V(x0, hi0, z), slot, V(0, 0, -1))
  }
  lampQuad(0.68, NHW, 1.33, 1.58, 1.23, 1.59, NF, 'dark')
  lampQuad(0.73, NHW, 1.37, 1.55, 1.27, 1.56, NF2, 'lamp')
  lampQuad(0.8, 1.02, 1.39, 1.52, 1.37, 1.53, NF2 - 0.004, 'dark')
  // grille between the lamps, a chrome bar across it and the badge
  facePanel(f, -0.62, 0.62, 1.31, 1.52, NF, -1, 'dark')
  facePanel(f, -0.62, 0.62, 1.4, 1.44, NF2, -1, 'chrome')
  facePanel(f, -0.11, 0.11, 1.33, 1.5, NF2 - 0.004, -1, 'chrome')
  // the bumper's joint with the wings, across the face and back along both
  // flanks to the arch, which is what makes a bumper a separate part
  facePanel(f, -NHW, NHW, 1.19, 1.23, NF, -1, 'dark')
  flankLine(f, [[NOSE_Z, 1.21], [-4.3, 1.21], [-3.95, 1.21], [-AXLE_Z - ARCH_R - 0.02, 1.21]], 0.02, 'dark')
  // plate over a wide lower intake
  facePanel(f, -1.02, 1.02, 0.7, 0.96, NF, -1, 'dark')
  facePanel(f, -0.5, 0.5, 0.99, 1.16, NF, -1, 'paint2')
  facePanel(f, -1.1, 1.1, 0.62, 0.66, NF, -1, 'dark')

  // --- the tail ------------------------------------------------------------------
  const TF = TAIL_Z + 0.012
  const TF2 = TAIL_Z + 0.02
  for (const s of [-1, 1]) {
    const lo = (a: number, c: number) => (s > 0 ? [a, c] : [-c, -a]) as [number, number]
    const [a0, a1] = lo(0.86, 1.5)
    facePanel(f, a0, a1, 1.52, 2.0, TF, 1, 'dark')
    const [l0, l1] = lo(0.9, 1.5)
    facePanel(f, l0, l1, 1.56, 1.96, TF2, 1, 'lampRed')
  }
  // plate in its recess, the tailgate badge, the bumper joint, the diffuser
  facePanel(f, -0.58, 0.58, 1.18, 1.5, TF, 1, 'dark')
  facePanel(f, -0.52, 0.52, 1.22, 1.46, TF2, 1, 'paint2')
  facePanel(f, -0.1, 0.1, 1.64, 1.76, TF2, 1, 'chrome')
  facePanel(f, -1.5, 1.5, 1.08, 1.12, TF, 1, 'dark')
  flankLine(f, [[TAIL_Z, 1.1], [4.2, 1.1], [3.7, 1.1], [AXLE_Z + ARCH_R + 0.02, 1.1]], 0.02, 'dark')
  facePanel(f, -1.2, 1.2, 0.66, 0.84, TF, 1, 'dark')
  // exhaust: one chromed can under the left of the bumper
  b.add(
    revolve([[0, 0.0], [0.1, 0.0], [0.11, 0.3], [0.12, 0.33], [0, 0.33]], 10, { sharp: [2] }),
    'chrome',
    at(-0.8, 0.68, TAIL_Z - 0.26, Math.PI / 2, 0, 0),
  )

  // --- the flanks -----------------------------------------------------------------
  // the door: shut-lines at its leading and trailing edges, sill to belt
  for (const z of [DOOR_Z0, DOOR_Z1]) {
    const top = sectionAt(z).belt - 0.03
    flankLine(f, [[z, 0.56], [z, 0.9], [z, LAMP_Y], [z, CREASE_Y], [z, top]], 0.018, 'dark')
  }
  flankLine(f, [[DOOR_Z0, 0.56], [DOOR_Z1, 0.56]], 0.018, 'dark')
  f.flush(b)
  b.both(() => {
    // handle, on the door skin just under the crease
    b.add(chip(0.06, 0.08, 0.34), 'chrome', at(flankX(0.84, 1.66) + 0.02, 1.66, 0.84))
    // mirror: a stalk from the door's leading top corner to a housing that
    // stands out past the arch lips, glass facing back
    const MZ = DOOR_Z0 + 0.16
    const my = sectionAt(MZ).belt
    b.add(tube([V(1.62, my + 0.02, MZ), V(1.84, my + 0.1, MZ + 0.02)], 0.04, 5), 'trim')
    b.add(chip(0.16, 0.22, 0.3), 'paint', at(1.9, my + 0.14, MZ, 0, 0.1, 0))
    b.add(chip(0.12, 0.16, 0.02), 'dark', at(1.91, my + 0.14, MZ + 0.155, 0, 0.1, 0))
    // wiper, parked along the base of the screen
    const wy = (z: number) => glassBase(WS_BASE_Z).y + ((z - WS_BASE_Z) / (WS_TOP_Z - WS_BASE_Z)) * (roofCrown(WS_TOP_Z).y - glassBase(WS_BASE_Z).y) + 0.03
    b.add(tube([V(0.12, wy(-1.86), -1.86), V(1.0, wy(-1.8), -1.8)], 0.028, 4), 'dark')
  })

  /* --------------------------------------------------------- the interior -- */
  /* Seen through tinted glass, so it is blocked in rather than detailed, but
     an empty cabin is what makes a car read as a prop. The tub's own floor
     and door walls are the section's (trim); these stand on them */
  b.add(chip(3.0, 0.52, 0.66), 'trim', at(0, 1.66, -1.56))
  b.add(chip(0.7, 0.2, 0.24), 'dark', at(DX, 1.98, -1.36))
  b.add(chip(0.46, 0.5, 1.5), 'trim', at(0, 1.0, -0.4))
  // parcel shelf over the boot, under the tailgate glass
  b.add(chip(2.9, 0.05, 1.0), 'trim', at(0, 2.02, 3.45))
  b.both(() => {
    // front seat: cushion, reclined back, headrest
    b.add(chip(0.8, 0.22, 0.86), 'seat', at(-DX, 1.0, 0.35))
    b.add(chip(0.76, 1.0, 0.2), 'seat', at(-DX, 1.6, 0.86, 0.16, 0, 0))
    b.add(chip(0.44, 0.28, 0.16), 'seat', at(-DX, 2.26, 0.95, 0.1, 0, 0))
  })
  // the rear bench
  b.add(chip(2.7, 0.24, 0.8), 'seat', at(0, 1.0, 2.2))
  b.add(chip(2.7, 0.9, 0.2), 'seat', at(0, 1.55, 2.66, 0.18, 0, 0))
  // gear lever on the console
  b.add(tube([V(0, 1.25, -0.5), V(0, 1.58, -0.56)], 0.035, 5), 'chrome')
  b.add(chip(0.12, 0.12, 0.12), 'dark', at(0, 1.62, -0.57))

  const shell = b.build(slots, { cast: true, receive: true, name: 'shell' })

  /* ---------------------------------------------------------- the wheels -- */

  /*
    Built once per side rather than once and mirrored with a negative scale:
    a scale of -1 flips the winding, and a wheel whose faces are inside out is
    the bug you only notice when the sun moves. The two builds are cloned for
    the second axle, and Object3D.clone shares geometry, so the model carries
    two wheels' worth of buffers and draws four.
  */
  const makeWheel = (mirror: boolean) => {
    const w = createPartBuilder()
    const pop = mirror ? w.push(new THREE.Matrix4().makeScale(-1, 1, 1)) : null
    // revolve works around Y; -90 degrees about Z puts the axle on X, which
    // is the axis the wheel rolls about
    const spin = at(0, 0, 0, 0, 0, -Math.PI / 2)

    // tyre: a real sidewall bulge and a shoulder that is a hard edge, so the
    // tread band catches its own highlight. UVs come off the revolve, which
    // is what the rubber material's painted tread map is wrapped with
    w.add(
      revolve(
        [
          [0.455, -TYRE_HW + 0.005],
          [0.545, -0.195],
          [0.625, -0.150],
          [0.657, -0.098],
          [WHEEL_R, -0.040],
          [WHEEL_R, 0.040],
          [0.657, 0.098],
          [0.625, 0.150],
          [0.545, 0.195],
          [0.455, TYRE_HW - 0.005],
        ],
        16,
        { sharp: [3, 6] },
      ),
      'rubber',
      spin,
    )
    /*
      The rim is a ring, not a dish. Its profile used to close to r = 0, which
      made the face a solid disc, the "spokes" half-buried ribs standing on
      it, and the brake disc and caliper behind it things no camera could ever
      see. The profile now runs out along the barrel, over the flange lip,
      inward across the face only as far as r = 0.30 and then *back* along the
      inside of the barrel to where it started — a closed loop revolved, so
      the wheel has a real hole through it with the brake hardware behind.
      Both this and the tyre were also visibly faceted at 8 and 14 segments,
      and the wheels are the closest geometry to the cockpit camera there is.
    */
    w.add(
      revolve(
        [
          [0.455, -0.195],
          [0.400, -0.150],
          [0.370, -0.020],
          [0.400, 0.120],
          [0.455, 0.190],
          [0.430, 0.205],
          [0.345, 0.170],
          [0.300, 0.120],
          [0.300, -0.060],
          [0.370, -0.165],
          [0.455, -0.195],
        ],
        14,
        { sharp: [4, 5] },
      ),
      'chrome',
      spin,
    )
    // hub boss: its own closed solid, since the face it used to sit on is a
    // hole now
    w.add(
      revolve([[0, -0.02], [0.125, 0.02], [0.135, 0.10], [0.100, 0.135], [0, 0.135]], 8,
        { sharp: [2] }),
      'chrome',
      spin,
    )
    // five spokes bridging the boss to the rim across real gaps: 0.11 wide
    // each at r = 0.225, so 60% of that circle is open
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU
      w.add(chip(0.05, 0.235, 0.11), 'chrome', at(0.13, Math.cos(a) * 0.225, Math.sin(a) * 0.225, a, 0, 0))
    }
    // brake disc and caliper, seen through the gaps
    w.add(
      revolve([[0.11, -0.02], [0.40, -0.02], [0.40, 0.02], [0.11, 0.02]], 10),
      'metal',
      at(-0.02, 0, 0, 0, 0, -Math.PI / 2),
    )
    w.add(chip(0.10, 0.24, 0.15), 'paint', at(-0.03, 0.30, -0.08))
    pop?.()
    return w.build(slots, { cast: true, receive: false, name: 'wheel' })
  }

  const wheelRight = makeWheel(false)
  const wheelLeft = makeWheel(true)

  /* --------------------------------------------------- the steering wheel -- */

  const sw = createPartBuilder()
  sw.add(new THREE.TorusGeometry(0.33, 0.045, 4, 12), 'dark')
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * TAU
    sw.add(chip(0.07, 0.30, 0.035), 'trim', at(Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0, 0, 0, a - Math.PI / 2))
  }
  sw.add(revolve([[0, -0.03], [0.11, -0.03], [0.11, 0.03], [0, 0.03]], 8, { sharp: [1, 2] }), 'trim',
    at(0, 0, 0, Math.PI / 2, 0, 0))
  const steerWheel = sw.build(slots, { cast: false, receive: false, name: 'steerWheel' })
  // the column lies back 26 degrees, so the rim's axis points up at the driver
  steerWheel.position.set(DX, 1.84, -0.86)
  steerWheel.rotation.x = -0.45

  /* --------------------------------------------------------- the assembly -- */

  const root = new THREE.Group()
  root.name = 'car'
  /* the body carries everything that leans: the shell, the interior, the
     driver and the lamps. The wheels hang off `root` instead, so they stay
     upright while the body pitches and rolls over them — which is the whole
     visible product of the suspension */
  const body = new THREE.Group()
  body.add(shell, steerWheel)
  /* The real player rig is attached here while occupied. Unlike `root`, this
     group carries the suspension's pitch and roll, so the driver rides the
     body instead of staying uncannily level while the car moves underneath.

     Its y is the seated body's *face*, not its hips (`playerBody.sit()`
     hangs the fold from the eye), which is why it is the same SEAT_EYE_Y the
     cockpit lens below uses: the lens sits at the avatar's face, so the two
     numbers were always meant to be one. This cabin is 1.65 tall inside and
     the character is a good deal more than that from seat to crown, so the
     seat carries a `fit` that folds the seated body smaller about its eye
     (playerBody's CABIN_FIT) until it clears both the floor and the roof. */
  const driverSeat = new THREE.Group()
  driverSeat.name = 'driverSeat'
  driverSeat.position.set(DX, SEAT_EYE_Y, SEAT_Z)
  driverSeat.userData.fit = SEAT_FIT
  body.add(driverSeat)
  // the other side of the same bench: this is left-hand drive, so the mirror
  // of the driver's centreline is the passenger's
  const passengerSeat = new THREE.Group()
  passengerSeat.name = 'passengerSeat'
  passengerSeat.position.set(-DX, SEAT_EYE_Y, SEAT_Z)
  passengerSeat.userData.fit = SEAT_FIT
  body.add(passengerSeat)
  root.add(body)

  const mounts: THREE.Object3D[] = []
  const spins: THREE.Object3D[] = []
  /** FL, FR, RL, RR: the order every per-corner loop below uses */
  const CORNER: Array<[number, number]> = [
    [-HALF_TRACK, -AXLE_Z],
    [HALF_TRACK, -AXLE_Z],
    [-HALF_TRACK, AXLE_Z],
    [HALF_TRACK, AXLE_Z],
  ]
  for (let i = 0; i < 4; i++) {
    const mount = new THREE.Object3D()
    mount.position.set(CORNER[i][0], WHEEL_R, CORNER[i][1])
    const spin = new THREE.Object3D()
    const mesh = CORNER[i][0] < 0
      ? (i === 0 ? wheelLeft : wheelLeft.clone())
      : (i === 1 ? wheelRight : wheelRight.clone())
    spin.add(mesh)
    mount.add(spin)
    root.add(mount)
    mounts.push(mount)
    spins.push(spin)
  }

  /* headlamp beams. castShadow is off on purpose: the shadow budget in this
     project is hand-baked one light per frame, and a pair of moving shadow
     spots would blow it in a single corner.

     They are also switched off with `.visible`, not with `.intensity`. Three's
     WebGLLights counts every *visible* spot light into NUM_SPOT_LIGHTS
     whatever its intensity, and that number is baked into every lit program
     in the scene — so a pair of zero-intensity spots parked on a car recompile
     the whole world's shaders with two spot slots nobody uses. Zero intensity
     costs a uniform upload; zero intensity and still visible costs a
     recompile. The dusk layout is exposed once under BootCover by
     `setLightWarmup`, then hidden again, so the threshold hits a cached program
     without making those two unused slots a permanent daytime cost.

     Re-checked against three 0.184.0: `projectObject` returns early on
     `visible === false`, so an invisible light is not counted into
     NUM_SPOT_LIGHTS and the mechanism above is real. The tempting one-liner,
     pinning `visible = true` forever and driving intensity, does kill the dusk
     threshold outright, at the price of two extra spot slots evaluated per
     fragment on every lit surface in the scene, all day, to spare a
     transition that both routes reaching the fleet already pay under a cover
     (`/world` under BootCover, the front door under `loadWorldCovered`). It is
     the wrong side of that trade while the warm-up stays covered. What would
     change the answer is a *late* material never seen by the warm-up. A
     remote player's body used to be exactly that, until playerBody's geometry
     and this module's materials became shared. */
  const beams: THREE.SpotLight[] = []
  for (const s of [-1, 1]) {
    const l = new THREE.SpotLight(0xfff0d2, 0, 52, 0.42, 0.55, 1.2)
    l.position.set(s * 1.12, 1.41, NOSE_Z - 0.05)
    l.castShadow = false
    l.visible = false
    l.target.position.set(s * 1.6, -1.2, -26)
    body.add(l, l.target)
    beams.push(l)
  }

  markDynamic(root)

  /* ------------------------------------------------------------- the sim -- */

  const pos = new THREE.Vector3()
  const vel = new THREE.Vector3()
  let vy = 0
  let yaw = 0
  let yawRate = 0
  let pitch = 0
  let pitchRate = 0
  let roll = 0
  let rollRate = 0
  let steer = 0
  let gear = 0 // index into GEAR_TOP, or -1 for reverse
  let shiftT = 0
  let revShown = 0
  let spinAngle = 0
  let brakeK = 0
  let slipK = 0
  let dayK = 1
  let lampHead = -1
  let lampTail = -1
  let lightWarmup = false

  const len = [SPRING_FREE - GRAV / SPRING_K, SPRING_FREE - GRAV / SPRING_K, SPRING_FREE - GRAV / SPRING_K, SPRING_FREE - GRAV / SPRING_K]
  /** last tick's lengths, so the landing detector can read how fast a spring
      is closing rather than how fast the whole car is descending */
  const lenPrev = len.slice()
  /** peak closing rate of each spring's current compression, reset the moment
      it starts extending again — see the landing detector */
  const slamV = [0, 0, 0, 0]
  const contact = [true, true, true, true]
  let impactHold = 0
  /** how much throttle has been spent leaning on the breakable currently
      under the nose, and which one it is — see the shove rule below */
  let shove = 0
  let shoveOn: Solid | null = null

  /* the footprint the registry sizes a collision box from, and the one
     `sweepBody` argues with: the car's own measured half-extents, not a
     rounded-up guess at them. 1.88 against a body that is 1.875 wide was
     five thousandths of nothing, and the two numbers drifting apart is
     exactly how a machine ends up with a hitbox nobody authored */
  const SIZE = { halfX: HALF_WIDE, halfZ: HALF_LEN, height: ROOF_Y }
  const solid = noStand(new THREE.Box3()) as Solid
  const sweepC = new THREE.Vector3()

  const out: DriveStep = {
    // gear is reported one-based (and -1 for reverse), so this is `gear`
    // itself rather than a literal that can drift away from it
    speed: 0, planar: 0, load: 0, rpm: 0, gear: gear + 1, grounded: true, vy: 0,
    altitude: 0, slip: 0, braking: 0, surface: 'asphalt', impact: 0, moved: false,
  }
  const upV = new THREE.Vector3()

  const refreshSolid = () => {
    const c = Math.abs(Math.cos(yaw))
    const s = Math.abs(Math.sin(yaw))
    const ex = SIZE.halfX * c + SIZE.halfZ * s
    const ez = SIZE.halfX * s + SIZE.halfZ * c
    solid.min.set(pos.x - ex, pos.y + 0.05, pos.z - ez)
    solid.max.set(pos.x + ex, pos.y + SIZE.height, pos.z + ez)
  }

  /** the lamp slots are shared by all three vehicles, so only touch them when
      the value actually moved — otherwise a parked car fights a moving boat
      for the same two emissive numbers every frame */
  const syncLamps = () => {
    const head = dayK < 0.34 ? clamp((0.34 - dayK) / 0.22, 0, 1) : 0
    const tail = Math.max(brakeK, head * 0.4)
    if (Math.abs(head - lampHead) < 0.02 && Math.abs(tail - lampTail) < 0.02) return
    lampHead = head
    lampTail = tail
    mats.setLamps(head, tail)
    for (const l of beams) {
      l.intensity = head * 30
      l.visible = lightWarmup || head > 0.01
    }
  }

  /** how high the world is under a wheel, with the waterline as a floor: a
      car cannot drive on the seabed, so the probe simply refuses to look more
      than 1.5 units below the surface (water over the sills) */
  const supportAt = (x: number, z: number, reach: number, env: DriveEnv) => {
    const g = groundUnder(x, z, reach, env)
    if (env.waterY === undefined) return g
    const w = env.waterY + env.waveAt(x, z)
    return Math.max(g, w - 1.5)
  }

  const step = (env: DriveEnv, driven: boolean, dt: number) => {
    const key = axes(env.keys, env.frozen || !driven)
    const surface = env.surfaceAt(pos.x, pos.z)
    const feel = SURFACE_FEEL[surface]

    /* ---- suspension: four springs, and the heave/pitch/roll they hold up -- */
    let fSum = 0
    let mPitch = 0
    let mRoll = 0
    let grounded = false
    let groundAvg = 0
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    for (let i = 0; i < 4; i++) {
      const lx = CORNER[i][0]
      const lz = CORNER[i][1]
      // yaw 0 faces -z, so this is the same rotation sweepBody uses
      const wx = pos.x + lx * cy + lz * sy
      const wz = pos.z - lx * sy + lz * cy
      // small-angle hardpoint: rotating (lx, HARD_Y, lz) lifts it by
      // lx*sin(roll) and drops it by lz*sin(pitch)
      const hardY = pos.y + HARD_Y + lx * roll - lz * pitch
      const g = supportAt(wx, wz, hardY, env)
      groundAvg += g
      const raw = hardY - (g + WHEEL_R)
      len[i] = clamp(raw, LEN_MIN, LEN_MAX)
      // the corner's own vertical speed, which is what the damper resists.
      // A finite difference on `len` would be one frame stale and would ring
      const cornerVy = vy + rollRate * lx - pitchRate * lz
      const comp = SPRING_FREE - len[i]
      // named `force`, not `f`: the longitudinal speed eighteen lines down is
      // also `f`, and one of them shadowing the other is a bug waiting to be
      // written by whoever moves a line between the two blocks
      let force = SPRING_K * comp - SPRING_C * cornerVy
      if (len[i] < STOP_LEN) force += STOP_K * (STOP_LEN - len[i])
      force = clamp(force, 0, FORCE_CAP) * 0.25
      contact[i] = raw < SPRING_FREE
      if (contact[i]) grounded = true
      else force = 0
      fSum += force
      // torque_x = -lz * F_y, torque_z = +lx * F_y
      mPitch -= lz * force
      mRoll += lx * force
    }
    groundAvg *= 0.25

    /* ---- longitudinal: gearbox, torque, brakes, drag --------------------- */
    const fwdX = -sy
    const fwdZ = -cy
    const rgtX = cy
    const rgtZ = -sy
    let f = vel.x * fwdX + vel.z * fwdZ
    let s = vel.x * rgtX + vel.z * rgtZ

    const throttleKey = key.fwd > 0 ? 1 : 0
    const backKey = key.fwd < 0 ? 1 : 0
    const hand = key.up > 0 ? 1 : 0

    if (shiftT > 0) shiftT = Math.max(0, shiftT - dt)

    // pick a gear from road speed alone; a torque converter would be a whole
    // extra state for something nobody can hear
    if (gear >= 0) {
      if (gear < 4 && f / GEAR_TOP[gear] > 0.95 && shiftT <= 0) {
        gear++
        shiftT = SHIFT_TIME
      } else if (gear > 0 && f < GEAR_TOP[gear - 1] * 0.62 && shiftT <= 0) {
        gear--
        shiftT = SHIFT_TIME * 0.5
      }
    }
    // S is the brake while rolling forward and reverse once stopped
    let braking = 0
    let drive = 0
    if (grounded && !env.frozen && driven) {
      if (backKey) {
        if (f > 0.6) braking = 1
        else gear = -1
      } else if (gear < 0 && (throttleKey || f > -0.05)) {
        // out of reverse the moment the driver asks for forward, or the car
        // has rolled to a stop on its own. Two separate branches said this
        // and the second one covered every case the first did
        gear = 0
      }
    }
    const rev = gear < 0
      ? clamp(-f / REV_TOP, 0, 1.02)
      : Math.max(
        clamp(f / GEAR_TOP[gear], 0, 1.02),
        gear === 0 ? throttleKey * 0.22 : 0,
      )
    if (grounded && shiftT <= 0) {
      if (gear < 0 && backKey) drive = -POWER * 0.9 * torqueAt(rev)
      else if (throttleKey && gear >= 0) drive = POWER * GEAR_GAIN[gear] * torqueAt(rev)
      // what the contact patches will actually take. Without this the first
      // two gears pull 0.9 g and the car leaves like a dragster
      const tract = LONG_GRIP * feel.grip
      drive = clamp(drive, -tract, tract)
    }

    /* rolling and aero drag, plus engine braking when nothing is asked for.
       Rolling resistance fades out at low speed, and that is not cosmetic:
       sand drags at 8.5 and its grip caps traction at 15 * 0.5 = 7.5, so a
       constant rolling term made the car literally unable to pull away on a
       beach. Scaling it in over the first 12 u/s leaves sand topping out at a
       jog — wading, which is the intent — while keeping the terminal speeds
       on every surface exactly where the full drag figure puts them */
    const speedAbs = Math.abs(f)
    let resist = feel.drag * clamp(0.35 + speedAbs / 12, 0.35, 1) + AERO * f * f
    if (grounded && !throttleKey && !backKey) resist += ENGINE_BRAKE
    // water: the deeper the wading, the heavier it gets. Two car lengths and
    // the sea has stopped you
    let wade = 0
    if (env.waterY !== undefined) {
      // 1.5, because that is the clamp supportAt already put on the probe:
      // groundAvg can never sit more than 1.5 under the waterline, so a 2.0
      // here made the deepest possible water read as 0.75 and no more
      wade = clamp((env.waterY - groundAvg) / 1.5, 0, 1)
      if (wade > 0.05) {
        resist += 26 * wade
        drive *= 1 - wade
      }
    }
    if (braking) resist += BRAKE * feel.grip
    if (hand) resist += HAND_LONG
    if (!grounded) resist = AERO * f * f

    f += drive * dt
    const bleed = resist * dt
    f = speedAbs <= bleed && drive === 0 ? 0 : f - Math.sign(f) * Math.min(bleed, speedAbs)

    /* gravity down the fall line, and the tyres that hold against it.

       The four springs only ever push up, so without the fall-line term the
       car climbs a mountainside at its terminal speed and will not roll back
       off one. `groundNormal` tilts downhill, which makes its horizontal part
       the descent direction and its length sin(slope), so the pull is
       GRAV * sin(slope) along the heading and exactly zero on the flat —
       every measured number on level asphalt is untouched.

       What stops a *parked* car is static friction, and it has to be written
       down as one, because drag cannot do the job: at rest on asphalt the
       whole rolling-plus-engine-brake budget is 2.69 u/s^2, which gives up at
       4.5 degrees, and a third of this planet's dry land is steeper than
       that. Left to drag alone, every car parked on that third drove itself
       downhill in reverse, carrying its collision box with it. The budget the
       tyres actually have is HOLD_MU * GRAV * cos(slope) against a pull of
       GRAV * sin(slope), and it is the *whole* horizontal pull that has to be
       held, not just its share along the heading: a car parked across the
       fall line is held by the same four contact patches. Under the
       break-away angle nothing moves at all; over it, the same budget opposes
       the slide it can no longer stop, so a car cannot free-fall down a cliff
       face either. The gate is speed, not input, so the hold also catches a
       car that has just rolled to a stop — and it is deliberately released
       the instant the driver asks for throttle or reverse, because a car that
       cannot be rolled backwards down a hill on purpose is a car with the
       handbrake welded on. */
    let climbBlock = 0
    if (grounded) {
      groundNormal(pos.x, pos.z, env, upV)
      const gLong = GRAV * (upV.x * fwdX + upV.z * fwdZ)
      const parked =
        !throttleKey && !backKey && Math.abs(f) < HOLD_SPEED && Math.abs(s) < HOLD_SPEED
      const holdMax = HOLD_MU * GRAV * upV.y
      if (parked && GRAV * Math.hypot(upV.x, upV.z) <= holdMax) {
        f = 0
        s = 0
      } else if (parked) {
        f += Math.sign(gLong) * Math.max(0, Math.abs(gLong) - holdMax) * dt
      } else {
        f += gLong * dt
      }

      /* ...and the gate on what the wheels can roll up. The support probe
         happily finds the top of a cliff under the front wheels and the bump
         stop then fires the whole car up the face, so the drawn ground is
         sampled ahead along the direction of travel and anything over
         MAX_GRADE stops the car the way a wall would. `groundAt`, not
         `supportAt`: kerbs, road decks and the porch step are box tops, and
         none of them is a cliff */
      if (Math.abs(f) > 0.05) {
        const dir = Math.sign(f)
        const rise =
          env.groundAt(pos.x + fwdX * dir * CLIMB_PROBE, pos.z + fwdZ * dir * CLIMB_PROBE) -
          groundAvg
        if (rise > CLIMB_PROBE * MAX_GRADE) {
          climbBlock = Math.abs(f)
          f = 0
        }
      }
    }

    // reverse has no aero balance to stop it, so it gets a hard rev limiter;
    // forward is allowed a quarter over the top only so a hill can give it
    f = clamp(f, -REV_TOP, TOP_SPEED * 1.25)

    /* ---- lateral: steering lock, grip ceiling, slip ---------------------- */
    const planarNow = Math.hypot(vel.x, vel.z)
    const lock = LOCK_LO + (LOCK_HI - LOCK_LO) * Math.exp(-planarNow / LOCK_FADE)
    const wantSteer = -key.side * lock
    steer = damp(steer, wantSteer, key.side === 0 ? 11 : 7, dt)

    const gripF = GRIP * feel.grip * (1 - 0.6 * wade)
    const loose = hand ? 0.84 : 0
    const gripR = gripF * (1 - loose)
    const latMax = 0.5 * (gripF + gripR)

    let wantYaw: number
    if (grounded) {
      const kin = (f * Math.tan(steer)) / WHEELBASE
      // the front tyres cap how tight a path the car can be asked to follow;
      // that cap is understeer, and it is why more lock does not help
      const capW = gripF / Math.max(2.5, Math.abs(f))
      wantYaw = clamp(kin, -capW, capW) * (1 + OVERSTEER * loose)
    } else {
      wantYaw = yawRate * (1 - 1.2 * dt)
    }
    yawRate = damp(yawRate, wantYaw, YAW_RATE_LAG, dt)
    yaw += yawRate * dt

    // re-decompose in the new heading: yawing on its own has just handed the
    // velocity a lateral component of -f * yawRate * dt, which is the slip
    // the tyres now have to fight
    const cy2 = Math.cos(yaw)
    const sy2 = Math.sin(yaw)
    const fx2 = -sy2
    const fz2 = -cy2
    const rx2 = cy2
    const rz2 = -sy2
    vel.x = f * fwdX + s * rgtX
    vel.z = f * fwdZ + s * rgtZ
    f = vel.x * fx2 + vel.z * fz2
    s = vel.x * rx2 + vel.z * rz2
    if (grounded) {
      const latF = clamp(-s * LAT_STIFF, -latMax, latMax)
      s += latF * dt
    }
    vel.x = f * fx2 + s * rx2
    vel.z = f * fz2 + s * rz2

    /* ---- attitude: spring moments plus the load-transfer couple ---------- */
    const aFwd = drive - (braking ? BRAKE * feel.grip : 0) - Math.sign(f) * (feel.drag + AERO * f * f)
    const aLat = -f * yawRate
    let pitchAcc = mPitch / RAD_PITCH2
    let rollAcc = mRoll / RAD_ROLL2
    if (grounded) {
      pitchAcc += (H_PITCH * aFwd) / RAD_PITCH2
      rollAcc += (H_ROLL * aLat) / RAD_ROLL2
    } else {
      pitchAcc += (AIR_PITCH - pitch) * 5 - pitchRate * 2.4
      rollAcc += -roll * 6 - rollRate * 3.0
    }
    const pitch0 = pitch
    const roll0 = roll
    pitchRate += pitchAcc * dt
    rollRate += rollAcc * dt
    pitch = clamp(pitch + pitchRate * dt, -PITCH_CAP, PITCH_CAP)
    roll = clamp(roll + rollRate * dt, -ROLL_CAP, ROLL_CAP)
    if (pitch <= -PITCH_CAP || pitch >= PITCH_CAP) pitchRate *= 0.2
    if (roll <= -ROLL_CAP || roll >= ROLL_CAP) rollRate *= 0.2

    /* ---- heave and travel ------------------------------------------------ */
    vy += (fSum - GRAV) * dt
    pos.y += vy * dt
    pos.x += vel.x * dt
    pos.z += vel.z * dt

    /* ---- landings -------------------------------------------------------
       A landing is a suspension arriving, and the only honest measure of how
       hard is how fast the spring is *closing* — the wheel's approach speed
       relative to the ground under it, which is what `len` differences give
       and what `vy` emphatically does not. The old test was
       `grounded && vyPrev < -6 && vy > vyPrev`, and vy is as negative as you
       like on any descent: 35 u/s down a 20-degree slope is -12 u/s of vy
       with the springs sitting still, and the spring integration lifts vy on
       about every other tick, so it fired forty-five times a second — a
       collision sound per tick for as long as the player sat on a hill. A
       spring driven past SLAM_LEN into its bump travel, having closed faster
       than SLAM_RATE on the way there, is a real hit — whether the wheel was
       in the air (a landing) or never left it (a kerb at speed). The rate is
       the peak of the closure rather than whatever is left at that depth: a
       landing sheds most of its approach speed in the first third of the
       travel, so reading it at the bottom under-reports by half. One arrival
       is one event, so LAND_HOLD keeps the bounce that follows it quiet. */
    let impact = climbBlock > 0.4 ? climbBlock : 0
    if (impactHold > 0) impactHold = Math.max(0, impactHold - dt)
    let land = 0
    for (let i = 0; i < 4; i++) {
      const closing = (lenPrev[i] - len[i]) / dt
      // the fastest this spring closed on the way down, not the speed it has
      // left by the time it is deep enough to count: a landing sheds most of
      // its approach speed in the first third of the travel
      slamV[i] = closing > 0 ? Math.max(slamV[i], closing) : 0
      if (len[i] < SLAM_LEN && slamV[i] > SLAM_RATE) land = Math.max(land, slamV[i])
      lenPrev[i] = len[i]
    }
    if (land > 0 && impactHold <= 0) {
      impact = Math.max(impact, land)
      impactHold = LAND_HOLD
    }

    /* ---- collision -------------------------------------------------------- */
    sweepC.set(pos.x, 0, pos.z)
    const hit = sweepBody(
      sweepC, yaw, SIZE.halfX, SIZE.halfZ,
      pos.y + 0.34, pos.y + 2.7, env.collision,
    )
    const breaks = hit.depth > 0 ? hit.solid?.breaks : undefined
    const rush = Math.hypot(vel.x, vel.z)
    /* the shove: work spent pressing into whatever is under the nose. It
       resets on losing contact or on meeting something else, so it is a
       sustained push against one prop and not a tally across a hedge, and it
       only counts while the drive is pointed the way the car is stuck */
    if (!breaks || hit.solid !== shoveOn) {
      shove = 0
      shoveOn = breaks ? hit.solid : null
    }
    let shoved = false
    if (breaks && breaks.limit <= SHOVE_MAX && Math.abs(drive) > 0.1) {
      shove += Math.abs(drive) * dt
      shoved = shove > breaks.limit * SHOVE_COST
    }
    if (breaks && (rush > breaks.limit || shoved)) {
      // it comes with us. No push, no reflection, no yaw — the car keeps its
      // line and pays for the prop out of its speed, which is the whole
      // difference between driving through a sapling and hitting a wall
      vel.multiplyScalar(1 - clamp((breaks.limit * 0.6) / rush, 0, 0.6))
      impact = Math.max(impact, rush * 0.3)
      /* which way it leaves. A car with speed throws the prop down its own
         line; a car that shoved it over from a standstill has no line to
         speak of, and `vel / rush` at rest is a division by nothing, so the
         nose does the talking and it flops away at walking pace */
      const push = rush > 0.5
      const dirX = push ? vel.x / rush : Math.sin(yaw) * -Math.sign(drive || 1)
      const dirZ = push ? vel.z / rush : Math.cos(yaw) * -Math.sign(drive || 1)
      breaks.hit(
        pos.x + hit.at.x, pos.y + 0.5, pos.z + hit.at.z,
        dirX, dirZ, push ? rush : breaks.limit,
      )
      shove = 0
      shoveOn = null
    } else if (hit.depth > 0) {
      const px = clamp(hit.push.x, -PUSH_CAP, PUSH_CAP)
      const pz = clamp(hit.push.z, -PUSH_CAP, PUSH_CAP)
      pos.x += px
      pos.z += pz
      const nl = Math.hypot(px, pz) || 1
      const nx = px / nl
      const nz = pz / nl
      const closing = -(vel.x * nx + vel.z * nz)
      if (closing > 0) {
        impact = Math.max(impact, closing)
        // remove the closing component, then take a bite out of what is left
        vel.x += nx * closing
        vel.z += nz * closing
        const bite = clamp(closing / 24, 0, 0.5)
        vel.multiplyScalar(1 - bite)
        // an off-centre hit spins the car; a square one does not
        yawRate += clamp((hit.at.z * nx - hit.at.x * nz) * closing * 0.02, -1.6, 1.6)
      }
    }

    /* ---- wheels ---------------------------------------------------------- */
    for (let i = 0; i < 4; i++) {
      const lx = CORNER[i][0]
      const lz = CORNER[i][1]
      mounts[i].position.set(lx, HARD_Y + lx * roll - lz * pitch - clamp(len[i], 0.02, LEN_MAX), lz)
      if (i < 2) mounts[i].rotation.y = steer
    }
    spinAngle -= (f * dt) / WHEEL_R
    if (spinAngle < -TAU || spinAngle > TAU) spinAngle %= TAU
    for (const sp of spins) sp.rotation.x = spinAngle
    steerWheel.rotation.z = steer * STEER_RATIO

    /* ---- transforms ------------------------------------------------------ */
    root.position.copy(pos)
    root.rotation.y = yaw
    body.rotation.set(pitch, 0, roll)

    /* ---- report ---------------------------------------------------------- */
    const planar = Math.hypot(vel.x, vel.z)
    const revNow = shiftT > 0 ? rev * 0.86 : rev
    revShown = damp(revShown, 0.13 + 0.87 * clamp(revNow, 0, 1), 22, dt)
    brakeK = damp(brakeK, braking ? 1 : hand ? 0.7 : 0, 16, dt)
    const beta = Math.atan2(Math.abs(s), Math.abs(f) + 0.6)
    slipK = damp(slipK, clamp(beta / 0.42, 0, 1) * clamp(planar / 3.5, 0, 1), 12, dt)

    out.speed = f
    out.planar = planar
    out.load = clamp(planar / TOP_SPEED, 0, 1)
    out.rpm = clamp(revShown, 0, 1)
    out.gear = gear < 0 ? -1 : gear + 1
    out.grounded = grounded
    out.vy = vy
    out.altitude = Math.max(0, pos.y - groundAvg)
    out.slip = slipK
    out.braking = brakeK
    out.surface = surface
    out.impact = impact
    /* the attitude terms are the rates the body *realised*, not the ones the
       integrator asked for: parked across a slope steeper than PITCH_CAP the
       moment never stops pushing, so pitchRate is permanently nonzero while
       the clamp holds the car perfectly still — and a shadow map re-baked
       every frame for a car that has not moved a millimetre is exactly the
       cost this flag exists to avoid */
    out.moved =
      planar > 0.02 || Math.abs(vy) > 0.02 || Math.abs(yawRate) > 0.01 ||
      Math.abs(pitch - pitch0) > 0.02 * dt || Math.abs(roll - roll0) > 0.02 * dt
    syncLamps()
  }

  /* ------------------------------------------------------------ net drive -- */

  /*
    Somebody else's car, on our screen.

    Nothing here integrates. The six numbers are copied in and every moving
    part is then solved *backwards* from them: the wheels roll at the speed the
    interpolation implies, the front pair point where a car turning that hard
    at that speed would have to be pointed, and the brake lamps come on when
    the speed is falling. Deriving the steering from the yaw rate rather than
    putting it on the wire is the same trade the velocity is: two more floats
    fifteen times a second to tell us something the transform already knows.

    The suspension is the one thing that is *not* solved. Its lengths are left
    where the parked settle put them, because pitch and roll arrive on the
    wire already — the springs are how a local car earns its attitude, and a
    remote one is simply handed it.
  */
  const netM: NetMotion = { f: 0, planar: 0, yawRate: 0 }
  let netYaw = 0
  let netSpeed = 0

  const netStep = (env: DriveEnv, p: NetPose) => {
    const dt = env.dt
    if (p.snapped) netYaw = p.yaw
    netMotion(p, netYaw, dt, netM)
    netYaw = p.yaw

    pos.set(p.x, p.y, p.z)
    yaw = p.yaw
    pitch = p.pitch
    roll = p.roll
    vel.set(p.vx, 0, p.vz)
    vy = p.vy
    yawRate = netM.yawRate

    // the bicycle model, run in reverse: a car of this wheelbase turning at
    // this rate, at this speed, has its front wheels at this angle. Below a
    // walking pace the relationship inverts into nonsense (a stationary car
    // can yaw at any rate for zero steering), so it fades out down there
    const useable = Math.abs(netM.f) > 1.2
    const want = useable
      ? clamp(Math.atan((netM.yawRate * WHEELBASE) / netM.f), -0.6, 0.6)
      : 0
    steer = p.snapped ? want : damp(steer, want, 9, dt)

    for (let i = 0; i < 4; i++) {
      const lx = CORNER[i][0]
      const lz = CORNER[i][1]
      mounts[i].position.set(lx, HARD_Y + lx * roll - lz * pitch - clamp(len[i], 0.02, LEN_MAX), lz)
      if (i < 2) mounts[i].rotation.y = steer
    }
    spinAngle -= (netM.f * dt) / WHEEL_R
    if (spinAngle < -TAU || spinAngle > TAU) spinAngle %= TAU
    for (const sp of spins) sp.rotation.x = spinAngle
    steerWheel.rotation.z = steer * STEER_RATIO

    root.position.copy(pos)
    root.rotation.y = yaw
    body.rotation.set(pitch, 0, roll)

    // slowing down hard is the only brake signal there is from out here, and
    // it is the right one: what a watcher reads off the tail lamps is the car
    // shedding speed, not the pedal being pressed
    const decel = p.snapped || dt <= 0 ? 0 : (netSpeed - Math.abs(netM.f)) / dt
    netSpeed = Math.abs(netM.f)
    brakeK = damp(brakeK, clamp(decel / 12, 0, 1), 14, dt)
    revShown = damp(revShown, 0.13 + 0.87 * clamp(Math.abs(netM.f) / TOP_SPEED, 0, 1), 14, dt)
    slipK = damp(slipK, 0, 8, dt)

    const surface = env.surfaceAt(pos.x, pos.z)
    out.speed = netM.f
    out.planar = netM.planar
    out.load = clamp(netM.planar / TOP_SPEED, 0, 1)
    out.rpm = clamp(revShown, 0, 1)
    out.gear = netM.f < -0.5 ? -1 : 1
    // a remote car is on the ground unless it is visibly off it: the dust
    // needs an answer and there is no suspension here to ask
    out.altitude = Math.max(0, pos.y - supportAt(pos.x, pos.z, pos.y + HARD_Y + 1, env))
    out.grounded = out.altitude < 0.6
    out.vy = p.vy
    out.slip = slipK
    out.braking = brakeK
    out.surface = surface
    out.impact = 0
    out.moved = netM.planar > 0.02 || Math.abs(netM.yawRate) > 0.01
    syncLamps()
    refreshSolid()
    return out
  }

  /* ---------------------------------------------------------- the contract -- */

  const vehicle: Vehicle = {
    id: 'car',
    label: 'car',
    verb: 'drive',
    root,
    driverSeat,
    passengerSeat,
    view: {
      back: 11.5,
      up: 3.6,
      stretch: 3.5,
      fov: 62,
      anchor: new THREE.Vector3(0, 1.7, 0.2),
      eye: new THREE.Vector3(DX, SEAT_EYE_Y, SEAT_Z - 0.2),
      eye2: new THREE.Vector3(-DX, SEAT_EYE_Y, SEAT_Z - 0.2),
    },
    size: SIZE,
    hull: HULL,
    get yaw() {
      return yaw
    },
    get pitch() {
      return pitch
    },
    get roll() {
      return roll
    },
    solid,
    reach: 4.2,
    // light for a hatchback, heavy for a prop: the beam drags it round a
    // swing and a flick throws it a few car lengths. It sinks, slowly
    carry: { mass: 350, density: 1.3, bottom: 0.02 },

    placeAt: (x, z, y0, env) => {
      pos.set(x, 0, z)
      yaw = y0
      vel.set(0, 0, 0)
      vy = 0
      yawRate = 0
      pitch = pitchRate = roll = rollRate = 0
      steer = 0
      gear = 0
      shiftT = 0
      let g = 0
      const c = Math.cos(yaw)
      const sn = Math.sin(yaw)
      for (let i = 0; i < 4; i++) {
        const wx = x + CORNER[i][0] * c + CORNER[i][1] * sn
        const wz = z - CORNER[i][0] * sn + CORNER[i][1] * c
        g += supportAt(wx, wz, env.groundAt(wx, wz) + HARD_Y + 1, env)
      }
      pos.y = g * 0.25 + 0.02
      // let the springs find the ground rather than trusting the average: on
      // a slope the settle is what produces the parked car's pitch and roll
      for (let i = 0; i < 60; i++) step(env, false, 1 / 90)
      vel.set(0, 0, 0)
      vy = 0
      yawRate = 0
      refreshSolid()
    },

    mount: () => {
      solid.makeEmpty()
    },

    dismount: () => {
      refreshSolid()
    },

    exitSpot: (o, env) => {
      const c = Math.cos(yaw)
      const sn = Math.sin(yaw)
      // driver's door first, then further out, then the passenger side
      const tries: Array<[number, number]> = [
        [-(SIZE.halfX + 1.5), 0.4],
        [-(SIZE.halfX + 3.0), 0.4],
        [SIZE.halfX + 1.5, 0.4],
        [SIZE.halfX + 3.0, 0.4],
        [0, -(SIZE.halfZ + 1.8)],
      ]
      for (const [lx, lz] of tries) {
        const wx = pos.x + lx * c + lz * sn
        const wz = pos.z - lx * sn + lz * c
        const g = groundUnder(wx, wz, pos.y + 2.2, env)
        if (Math.abs(g - pos.y) > 2.4) continue
        if (!clearAt(wx, wz, 0.9, g + 0.25, g + 3.6, env.collision, solid)) continue
        o.set(wx, g, wz)
        return g
      }
      // nowhere to stand: put them on the roof and let gravity sort it out
      o.set(pos.x, pos.y + ROOF_Y + 0.1, pos.z)
      return pos.y + ROOF_Y + 0.1
    },

    update: (env, driven) => {
      solid.makeEmpty()
      step(env, driven, env.dt)
      if (!driven) refreshSolid()
      return out
    },

    netStep,

    setDay: (day) => {
      dayK = day
      syncLamps()
    },

    setLightWarmup: (on) => {
      lightWarmup = on
      // Only visibility matters to Three's lighting program key. Intensity
      // stays on the real day-cycle value (zero during the covered warm-up),
      // so this compiles the dusk layout without visibly turning the beams on.
      for (const l of beams) l.visible = on || lampHead > 0.01
    },

    dispose: () => {
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) m.geometry.dispose()
      })
    },
  }

  return vehicle
}
