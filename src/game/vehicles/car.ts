import * as THREE from 'three'
import { noStand, type HullStation, type Solid } from '../physics/collision'
import {
  at,
  createPartBuilder,
  loft,
  markDynamic,
  revolve,
  ringFloor,
  ringFrom,
  ringScale,
  ringSuper,
  slab,
  tube,
  RING_N,
  type Ring,
  type Station,
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
  The car: a compact three-door hot hatch, the thing parked at the kerb
  outside the house.

  ---------------------------------------------------------------- the shell

  It is one lofted body and one lofted greenhouse, not a pile of boxes. The
  body runs nose to tail as superelliptic cross-sections whose half-width,
  crown and rocker all move with z: widest exactly over the wheel arches
  (1.800 for the paint, which the arch flares then carry out to the car's
  stated 1.875), tucked at the nose and tail, sills drawn in underneath by a
  low `nDown` exponent so the car sits on a keel rather than on a slab. Every
  one of those sections is generated from one control table, `SECTIONS`, and —
  this is the part that pays for itself over and over — the same table is read
  back by `flankX()` and `crownY()` when a bumper, a sill strip, a door
  shut-line or a mirror stalk needs to know where the body's surface actually
  *is* at some (z, y). Nothing here is positioned by eye against a shape
  defined somewhere else, so the details sit on the paint instead of hovering
  a centimetre off it or sinking into it.

  The flank crease is a radial bump inside the ring function rather than
  `loft`'s `crease` flag. That flag duplicates a whole *station*, which makes
  a hard ring around the car — a transverse fold, right for the shut-line at
  the base of the windscreen and wrong for a feature line running lengthways.
  A longitudinal crease has to live in the outline, so `bodyRing` pushes ring
  indices 3 and 13 out by up to 3% (RING_N is 32, so those two land at exactly
  33.75 degrees above the waistline on each side, and they are exactly mirrored
  — the loft skins point j to point j, so a bump on a fixed index runs dead
  straight down the flank instead of spiralling). Smooth normals turn that 3%
  into a highlight line, which is what a pressed crease looks like in a photo.
  One crease reads as a car; the temptation to add the second was resisted.

  The greenhouse is a *glass* loft with painted parts laid over it, which is
  the trick that makes the windows work without CSG. You cannot cut a hole in
  a loft, so instead the whole canopy — windscreen, side glass and backlight
  in one continuous surface — is skinned in the `glass` slot, and the roof
  panel, the A-pillars, the blacked-out B-pillar and the C-pillars are separate
  pieces standing 0.03..0.04 proud of it. That 0.035 is the reveal: glass flush
  with paint is the single clearest tell of a toy car, and here the reveal is
  structural rather than decorative.

  Every one of those pieces is placed by asking the canopy where its surface
  is, and the shape of the question matters. The roof panel reads the canopy's
  own *ring* and grows it (`ringScale` + `ringFloor`); the pillars read a
  *fraction of its height* (`canopyRib`); the wiper reads its height at an x
  (`canopyY`). What none of them may do is name an absolute y and ask
  `canopyX` for the width there, because above that station's crown there is
  no width and the honest answer is zero — the centreline. The A- and
  C-pillars did exactly that, missed by four and nine thousandths
  respectively, and drew a body-coloured roll hoop across the windscreen and
  another across the backlight.

  The canopy's two end stations are deliberately *below* the body's crown, so
  the body swallows them. That is where the base of the windscreen and the
  base of the tailgate glass come from: not from an authored edge but from the
  intersection curve of two lofts, which is a curve no straight edge would
  have given and which costs nothing. It also removes the problem that killed
  the first attempt, where an authored screen-base ring 2.7 wide sprouted out
  of a bonnet crown only 2.3 wide and the glass appeared to grow out of the
  wings.

  ---------------------------------------------- the three holes in the shell

  Three things a car has that a loft cannot be asked for directly are a wheel
  arch, a face, and a cabin. All three were first attempted as decoration laid
  *over* a closed shell, and all three were invisible; all three are now cut
  into the section table itself, which is the only place a hole can come from
  without CSG.

  **The arches are openings, not lips.** The first version drew a torus flare
  on an unbroken flank and hoped: the rocker ran on under the wheel at y=0.45,
  more than half of every tyre was inside the paint, and a lip that stood 0.02
  proud of a 1.86 flank could not be seen at all. Now `archCutY()` lifts the
  lower-outer part of every section near an axle onto an ellipse (1.10 tall,
  0.98 long, springing from the sill line at y=0.36 and topping out at 1.46,
  which is 0.14 clear of the tyre) — so the outline runs *inward* along the
  arch roof, drops down the arch's inboard wall, and only then carries on
  around the floor pan. The loft skins that outline like any other, and the
  result is a genuine tunnel with the wheel standing in it.

  That inboard wall is the part it is easy to get wrong twice. It is not a
  vertical face at ARCH_IN: `bodyRing` can only lift the ring points it has,
  so the wall is the chord between the last point inboard of ARCH_IN and the
  first one outboard, and that chord leans *outward* as it climbs. At 1.26 it
  ran from (0.988, 0.336) to (1.247, 1.46), which is already at x = 1.42 by
  the height of the top of the tyre — outboard of the tyre's inner sidewall at
  1.315, so the whole inner half of every wheel was inside the paint even
  though the opening looked right from outside and every wheel *vertex* was
  clear. Sampled on the surfaces rather than at their vertices: 50 of 144
  inner-sidewall points and 9 of 72 rim-barrel points inside the shell. At
  1.10 the wall is one ring index further in, the chord tops out at x = 1.215
  where the tyre is, and a dense barycentric sweep of all four wheels against
  the body loft — plus edge-versus-face tests in both directions — finds 0 of
  11460 points inside and 0 crossings, closest approach 0.126.
  The tunnel is now wider than the wheel, which is what a wheel well is.

  The ellipse rather than a circle about the hub is what lets the opening close
  smoothly onto the rocker at its fore and aft ends instead of a step. The
  flare is then a `tube` swept along that *same* ellipse and the `dark` liner a
  band across the *same* ellipse 0.03 smaller — and the thing that took two
  goes is that neither may be held out at a constant x. Over the crown of the
  opening the body genuinely is 1.79 wide, but at the ends of the ellipse the
  section has tucked in to 1.12, so a flare parked at 1.800 finished as four
  cut tube ends hanging half a unit clear of the sills and the liner as two
  shelves of dark outside the paint. Both read `flankX` now, the flare's
  radius fades to a third at the ends so the lip dies into the flank instead
  of stopping, and FLARE_LIFT — the standoff that makes the widest vertex of
  the sweep land on HALF_WIDE — is measured off the built tube rather than
  computed, because a path that moves in x no longer lands a tube *face* on
  the axis the way a planar one does.

  The liner is wound so its faces look *inward* (the dark material is
  FrontSide, and an outward-wound band is invisible from the only place it is
  ever seen from) — which is also why the merged `dark` slot measures a
  *negative* signed volume, -1.8: four open bands deliberately facing the
  wrong way outweigh the closed chips around them, and it is the one slot on
  this model where that is not a bug. (It was -1.3 before the tunnel wall
  moved in and -2.2 before the bands stopped reaching past the flank, so the
  number tracks ARCH_IN and the liner's outer edge both, and is not a constant
  to check against.) The flat disc that used to sit behind each wheel is gone
  — the arch's own inboard wall is what a low camera sees now, and a disc
  buried in the floor pan was only ever hiding the absence of one.

  **The cabin is an opening too, and for a long time it was not.** The body
  loft ran closed straight over the passenger compartment at y = 2.00, which
  put every piece of the interior — floor pan, dash, seats, the driver — under
  a painted deck, and put a second, smaller, body-coloured car inside the
  greenhouse where a cabin should be. `cabinCutY` is `archCutY` upside down:
  it pushes the upper-inner outline *down* to a floor instead of lifting the
  lower-outer one up, and what comes out is a tub. The cut is indexed on the
  ring rather than thresholded on x for the reason ARCH_IN's comment gives, it
  smoothsteps up into a scuttle and a rear bulkhead over stations of its own,
  and it runs *before* the arch lift so the boot floor steps up over the rear
  wheels rather than crossing the opening. See the block above `bodyRing`.

  **The nose and the tail are the shell's open ends, dressed.** The body loft
  used to run the full 9.4 and cap flat at each extremity, which made the nose
  a solid 2.84 x 0.82 paint disc with the grille, its chrome mouth, the lower
  intake and both headlamps buried behind it — a head-on ray hit paint at
  z = -4.70 and the lamp slot was 92% dead. The shell now ends at z = -4.35
  and z = +4.40 and the last 0.3 of each end is *furniture*: grille, chrome
  bars, lamps, bumper bar, splitter at the front; tail lamps, number plate,
  diffuser and the exhaust tip at the back. Every one of those pieces is
  forward of the cap it sits against, so every one of them is the nearest
  surface from straight ahead, and the paint that shows between them is the
  nose panel — which is what a real car has there. The cap is still `flat` at
  both ends rather than `none`: it is completely hidden by the furniture, and
  keeping it means the shell stays a closed mesh whose signed volume can be
  measured (the body loft comes to +23.3, and it would be -23.3 to the decimal
  if the loft were inside out) instead of an open one whose winding nobody can
  check.

  Furniture that shares a face is furniture nobody authored, and there were
  three of those. The exhaust tip's closing disc landed on z = 4.680000 and
  the diffuser's rear face on 4.500 + 0.180 = 4.680000 — exactly coplanar, in
  the middle of the chase camera's view; the tip cannot move back, because
  4.70 is the bumper bar's and therefore the car's, so the diffuser moved
  forward to 4.42 and the tip stands 0.08 clear. The headlamp lens was 0.95
  long from x = 0.55 with an XYZ euler that swings its inboard end *forward*,
  so that end crossed the grille panel; the grille is a slim 1.56 now — a wide
  lower intake under a narrow upper one, which is the face a modern hatch has
  — and the lens is 0.56 starting at x = 0.937, with 0.097 of clear air
  between it and the chrome mouth's edge and zero surface samples or edge
  crossings shared with any part of the grille. The tail lamp was splayed 0.30
  across a tail panel that is *flat* out to x = 1.537, which does not wrap
  anything: it lifts the inboard edge, and the standoff ran 0.244 inboard
  against 0.177 outboard. At 0.08 of yaw and 0.66 of length it stands an even
  0.096..0.116 off the panel all the way across and its outboard end reaches
  the corner, where the body turns away under it.

  The other half of that lesson is `wrapPath`'s `inset`, which must be
  *smaller* than the tube radius it is used with or the bar it draws is inside
  the paint. It was 0.18 against a 0.15 radius, which put both bumpers 0.03
  under the flank all the way round and made 88% of the trim slot unreachable.
  The inset is 0.07 against 0.13 now — but *not* a uniform 0.06 of standoff,
  because BAR_R - BAR_SINK is not what a five-segment tube presents to the
  flank (a face rather than a vertex, cos 36 = 0.809) and the radius tapers to
  0.10 through the corner. Measured, the outer face stands 0.045..0.050 proud
  along the front flank and 0.053..0.065 along the rear, and where the path
  wraps the corner it dives up to 0.18 *inside* the nose panel and only the
  tip re-emerges, in front of the cap. Sunk or proud, the pair of numbers
  lives in one place so they cannot drift apart again.

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

  The whole model is 7315 vertices and 9580 triangles as drawn, 6899 and 9312
  of them parked — the difference is the driver, who is `visible = false`
  until somebody gets in. The four wheels are two builds cloned, because a
  mirrored wheel needs its own winding and a negatively scaled one is inside
  out. Measured bounding box 3.750 x 2.850 x 9.400, symmetric about x = 0 to
  the last float; the width is set by the arch flares and the length by the
  two bumper bars, which is where a real car is measured from too, and `SIZE`
  reports exactly those half-extents rather than a rounded-up guess at them.
*/

/* ------------------------------------------------------------------ scale --

   Everything below is in world units: 1 unit = 0.48 m, 2.08 units = 1 m.
   The car is 9.4 x 3.75 x 2.85 units = 4.52 x 1.80 x 1.37 m, which is a
   three-door hatch to within a few centimetres.                             */

const LENGTH = 9.4
const HALF_LEN = LENGTH / 2 // 4.7: the bumper bars' tips, front and rear
/** 1.80 m over the arch flares: the car's stated width. The paint shell's own
    widest section is 1.800, and FLARE_LIFT is derived so that the flare swept
    along the arch cut lands its widest vertex exactly here */
const HALF_WIDE = 1.875
const ROOF_Y = 2.85 // 1.37 m to the top of the roof panel
const WHEELBASE = 5.4 // 2.60 m between the axles
const AXLE_Z = WHEELBASE / 2 // front axle -2.7, rear +2.7
const TRACK = 3.05 // 1.47 m between the tyre centrelines
const HALF_TRACK = TRACK / 2
const WHEEL_R = 0.66 // a 16 inch rim in a 55-profile tyre
const TYRE_HW = 0.21 // 0.42 wide, i.e. a 195-section tyre

/** the height of the body's cross-section centreline. Every ring in SECTIONS
    is drawn around this line, so `up` is the crown above it and `down` is the
    rocker below it, and the sill lands at SECT_Y - down = 0.30 as specified */
const SECT_Y = 1.05

/** the fixed underside of the greenhouse loft. It is buried inside the body
    everywhere, which is the point: the visible bottom edge of the glass is
    wherever the canopy happens to come out of the paint */
const CANOPY_FLOOR = 1.2

/** where the paint shell stops at each end. The last 0.35 of the car is the
    front and rear furniture, which stands proud of these caps rather than
    hiding behind them — see the header */
const NOSE_Z = -4.35
const TAIL_Z = 4.40

/* -------------------------------------------------------------- body loft -- */

interface Sect {
  z: number
  /** half-width at the section's own centreline */
  hw: number
  /** crown height above SECT_Y, and rocker depth below it */
  up: number
  down: number
  /** superellipse exponents. 2 is an ellipse, 5 a softly-cornered rectangle */
  nUp: number
  nDown: number
  /** 0..1 strength of the flank crease at this station */
  shoulder: number
}

/*
  Thirteen control stations. The shape reads, front to back, as: a nose panel
  the front-end furniture bolts to, a fast rise through the lamps into the
  front arch where the car reaches its full width, a long bonnet climbing to
  the cowl crease, a constant-section door area, a second full-width bulge
  over the rear arch, and a short tail drawn in above the valance.

  This is the *control* table, not the station list the loft is given: the
  arches need stations of their own (see `BODY_Z`), and `sectionAt` blends
  this table at any z so both the loft and every detail placement below read
  one shape.
*/
const SECTIONS: Sect[] = [
  { z: NOSE_Z, hw: 1.600, up: 0.50, down: 0.52, nUp: 3.6, nDown: 3.0, shoulder: 0 },
  { z: -4.20, hw: 1.690, up: 0.62, down: 0.60, nUp: 4.0, nDown: 3.0, shoulder: 0.1 },
  { z: -3.70, hw: 1.760, up: 0.72, down: 0.70, nUp: 4.4, nDown: 3.1, shoulder: 0.3 },
  { z: -3.10, hw: 1.792, up: 0.80, down: 0.74, nUp: 4.8, nDown: 3.2, shoulder: 0.6 },
  { z: -2.70, hw: 1.800, up: 0.84, down: 0.75, nUp: 5.0, nDown: 3.2, shoulder: 0.8 },
  { z: -2.05, hw: 1.782, up: 0.88, down: 0.75, nUp: 5.2, nDown: 3.2, shoulder: 1 },
  { z: -1.45, hw: 1.748, up: 0.93, down: 0.75, nUp: 5.4, nDown: 3.2, shoulder: 1 },
  { z: -0.90, hw: 1.734, up: 0.95, down: 0.75, nUp: 5.4, nDown: 3.2, shoulder: 1 },
  { z: 0.00, hw: 1.730, up: 0.95, down: 0.75, nUp: 5.4, nDown: 3.2, shoulder: 1 },
  { z: 1.20, hw: 1.744, up: 0.95, down: 0.75, nUp: 5.4, nDown: 3.2, shoulder: 1 },
  { z: 2.10, hw: 1.782, up: 0.94, down: 0.74, nUp: 5.2, nDown: 3.2, shoulder: 1 },
  { z: 2.70, hw: 1.800, up: 0.92, down: 0.73, nUp: 5.0, nDown: 3.2, shoulder: 0.8 },
  { z: 3.50, hw: 1.776, up: 0.90, down: 0.70, nUp: 4.8, nDown: 3.1, shoulder: 0.5 },
  { z: 4.15, hw: 1.690, up: 0.86, down: 0.64, nUp: 4.4, nDown: 3.0, shoulder: 0.2 },
  { z: TAIL_Z, hw: 1.610, up: 0.80, down: 0.58, nUp: 4.2, nDown: 3.0, shoulder: 0 },
]

/* ------------------------------------------------------------ wheel arch --
   The arch opening, as an ellipse in the (z, y) plane about each axle. It
   springs from ARCH_Y — the sill line, so the opening closes onto the rocker
   at its fore and aft ends instead of stopping in a step the way a circle
   about the hub does — and reaches ARCH_H above it, which is 1.46, or 0.14
   clear of a tyre topping out at 1.32.

   ARCH_IN is where the tunnel's inboard wall starts, and it is *not* a
   vertical wall at that x. `bodyRing` can only lift the ring points it has,
   so the wall is the chord between the last point inboard of ARCH_IN and the
   first one outboard of it — and that chord leans outward as it climbs. At
   1.26 the lifted point was index 27, at x = 1.247 on the axle station, and
   the chord ran from (0.988, 0.336) up to (1.247, 1.46): by the height of the
   top of the tyre it had reached x = 1.423, well outboard of the tyre's inner
   sidewall at 1.315, so the inner half of every wheel was inside the paint.
   Sampled on the surface rather than at the vertices, 50 of 144 inner-sidewall
   points and 9 of 72 rim-barrel points were inside the shell.

   1.10 moves the wall in by one ring index. Index 27 measures 1.208..1.247
   across the arch stations and index 26 measures 0.947..0.988, so 1.10 is the
   only value with a real margin either side — anything closer flips an index
   from station to station and the wall goes jagged. The chord is then
   (0.988, 0.336) to (1.247, 1.46), which is at x = 1.215 at the top of the
   tyre: 0.10 clear of it, everywhere, with the whole wheel outside the paint.
   The tunnel is wider than the wheel, which is what a real wheel well is.   */
const ARCH_Y = 0.36
const ARCH_H = 1.10
const ARCH_RZ = 0.98
const ARCH_IN = 1.10

/** the floor of the arch opening at this z, or -Infinity where there is no
    arch. Read by `bodyRing` to lift the section's lower-outer outline, and by
    nothing else — details ask `flankX`, which reports the uncut surface */
const archCutY = (z: number) => {
  let top = -Infinity
  for (const az of [-AXLE_Z, AXLE_Z]) {
    const u = (z - az) / ARCH_RZ
    if (Math.abs(u) >= 1) continue
    top = Math.max(top, ARCH_Y + ARCH_H * Math.sqrt(1 - u * u))
  }
  return top
}

/** stations that get a transverse hard fold: the cowl, where the bonnet's
    trailing edge meets the base of the windscreen, and the tail's trailing
    lip above the number plate. Both are real shut-lines on a real hatchback */
const CREASE_Z = new Set([-1.45, 4.15])

/** ring index the flank crease sits on, and how far out it pushes. Index 3 of
    32 is 33.75 degrees above the waistline; index 13 is its mirror. 3% of the
    half-width is ~0.054 units — enough to kick the smoothed normal by about
    six degrees, which is a highlight line and not a ridge */
const SHOULDER_I = 3
const CREASE_OUT = 0.03

/* --------------------------------------------------------- cabin opening --

   The third hole in the shell, and the one that was missing. The body loft
   ran closed right over the passenger compartment: its crown at the doors is
   SECT_Y + 0.95 = 2.00, the greenhouse's glass floor is at 1.20, so the whole
   cabin was a shallow glass box standing on a painted deck. Every piece of
   the interior — a floor pan at 0.74, a dashboard at 1.72, seat cushions at
   0.94 — was authored for a cabin that opens at the floor and was therefore
   sealed underneath that deck and invisible, while what you actually saw
   through the windscreen was body colour: a second, smaller car inside the
   car. It is the same mistake the arches and the face were, in the one place
   left that could still make it.

   So the cabin is cut the same way the arches are: out of the section table,
   because that is the only place a hole can come from without CSG. `archCutY`
   lifts the lower-outer outline onto an ellipse; this pushes the upper-inner
   outline down to a floor, which turns the top of the shell through the
   cabin into a tub — flank, a near-vertical inner door wall, a floor, and
   back up the other side.

   The cut is indexed on the ring rather than thresholded on x, and that is
   deliberate for the reason ARCH_IN's comment gives at length: a fixed x
   flips which ring point it catches from station to station and the edge goes
   jagged. Index 3 is the shoulder crease, so cutting indices 4..12 puts the
   cut edge exactly on the crease — i.e. the belt line is the feature line,
   which is where a real hatchback's door tops are. It also lands just
   outboard of the greenhouse: at z = 0 the crease sits at (1.616, 1.814) and
   the glass at that height is 1.543, so the painted door top shows and the
   glass rises from inboard of it.

   CABIN_ROOF is above every crown in the table, so the ramp starts as a
   no-op and the smoothstep does the whole job of standing the scuttle and the
   rear bulkhead up — with stations of their own in BODY_Z, or the loft draws
   a 0.55-long ramp between the cowl and the first door section instead of a
   wall. And the cut is applied *before* the arch lift, so where the two
   overlap behind the rear axle the arch has the last word: the boot floor
   steps up over the wheel instead of running across the opening, which is
   both what a car does and what stops a red floor showing through the arch. */
const CABIN_Z0 = -1.45 // the cowl crease: the base of the windscreen
const CABIN_Z1 = 3.58 // the rear bulkhead, just forward of the tailgate glass
const CABIN_RAMP = 0.34
const CABIN_FLOOR = 0.68
const CABIN_ROOF = 2.10 // above SECT_Y + max(up) = 2.00, so t = 0 does nothing
/** the first ring index above the shoulder crease, and its mirror at
    RING_N/2 - CABIN_I0. 4..12 of 32 */
const CABIN_I0 = SHOULDER_I + 1

/** the ceiling of the cabin opening at this z, or +Infinity where the shell
    is closed. Read by `bodyRing` and by nothing else — details ask `flankX`,
    which reports the uncut surface */
const cabinCutY = (z: number) => {
  if (z <= CABIN_Z0 || z >= CABIN_Z1) return Infinity
  const t = clamp(Math.min(z - CABIN_Z0, CABIN_Z1 - z) / CABIN_RAMP, 0, 1)
  const k = t * t * (3 - 2 * t)
  return CABIN_ROOF - (CABIN_ROOF - CABIN_FLOOR) * k
}

const TAU = Math.PI * 2
/** signed power, so a superellipse survives a negative cosine */
const spow = (v: number, e: number) => Math.sign(v) * Math.pow(Math.abs(v), e)

const bodyRing = (s: Sect): Ring => {
  // in the ring's own frame, i.e. relative to SECT_Y
  const cut = archCutY(s.z) - SECT_Y
  const cab = cabinCutY(s.z) - SECT_Y
  return ringFrom((t) => {
    const i = t * RING_N
    const a = t * TAU
    const c = Math.cos(a)
    const sn = Math.sin(a)
    const upper = sn >= 0
    const e = 2 / (upper ? s.nUp : s.nDown)
    let x = s.hw * spow(c, e)
    let y = (upper ? s.up : s.down) * spow(sn, e)
    if (s.shoulder > 0) {
      const d = Math.min(Math.abs(i - SHOULDER_I), Math.abs(i - (RING_N / 2 - SHOULDER_I)))
      const k = 1 + CREASE_OUT * s.shoulder * Math.exp(-(d * d) / 1.7)
      x *= k
      y *= k
    }
    /*
      The cabin. Mirror image of the arch below: every point above the
      shoulder crease drops onto the cabin floor, which turns the upper-inner
      part of the outline into an inner door wall running down and a floor
      running across. Applied first, so the arch lift below wins wherever the
      two overlap behind the rear axle.
    */
    if (i > CABIN_I0 - 0.5 && i < RING_N / 2 - CABIN_I0 + 0.5 && y > cab) y = cab
    /*
      The arch. Every point outboard of the tunnel wall is lifted onto the
      arch ellipse, which turns the lower-outer quadrant of the outline into
      an arch roof running inward and a near-vertical inboard wall dropping
      back to the floor pan. The points only ever move up, so the outline
      stays a simple counter-clockwise loop and `loft` skins it — and winds it
      outward — exactly as it does an uncut one.
    */
    if (Math.abs(x) > ARCH_IN && y < cut) y = cut
    return [x, y]
  }, RING_N)
}

/*
  The station list the body loft actually gets: the control table, plus enough
  extra sections through each arch to draw the ellipse. The offsets are dense
  where the arch curve is steep and sparse over its crown; the worst chord
  error against the true ellipse is 0.033 units, which is under the flare tube
  that covers that edge. Two of them (0.40 and 0.60) are chosen to land on
  control stations that already exist, and anything landing within 0.05 of one
  is dropped rather than crowding it — two rings a finger apart cost 64
  vertices and buy a facet nobody can see.
*/
const ARCH_DZ = [-0.94, -0.80, -0.60, -0.40, 0, 0.40, 0.60, 0.80, 0.94]
const BODY_Z: number[] = SECTIONS.map((s) => s.z)
for (const az of [-AXLE_Z, AXLE_Z]) {
  for (const d of ARCH_DZ) {
    const z = az + d
    if (BODY_Z.every((q) => Math.abs(q - z) > 0.05)) BODY_Z.push(z)
  }
}
/* ...and the same for the cabin opening's two ends. `cabinCutY` smoothsteps
   the scuttle and the rear bulkhead up over CABIN_RAMP, but a smoothstep the
   loft has no stations inside is a straight line: without these the shell
   ramps from the cowl to the first door section 0.55 away and the base of the
   windscreen sits on a slope instead of on a wall. */
const CABIN_DZ = [0, 0.09, 0.19, 0.29, 0.40]
for (const [edge, dir] of [[CABIN_Z0, 1], [CABIN_Z1, -1]] as const) {
  for (const d of CABIN_DZ) {
    const z = edge + dir * d
    if (BODY_Z.every((q) => Math.abs(q - z) > 0.05)) BODY_Z.push(z)
  }
}
BODY_Z.sort((a, b) => a - b)

/** linear blend of the section table at any z, so the detail placement below
    reads exactly the surface the loft skinned */
const sectionAt = (z: number): Sect => {
  if (z <= SECTIONS[0].z) return SECTIONS[0]
  const last = SECTIONS[SECTIONS.length - 1]
  if (z >= last.z) return last
  let i = 1
  while (SECTIONS[i].z < z) i++
  const a = SECTIONS[i - 1]
  const b = SECTIONS[i]
  const t = (z - a.z) / (b.z - a.z)
  const mix = (p: number, q: number) => p + (q - p) * t
  return {
    z,
    hw: mix(a.hw, b.hw),
    up: mix(a.up, b.up),
    down: mix(a.down, b.down),
    nUp: mix(a.nUp, b.nUp),
    nDown: mix(a.nDown, b.nDown),
    shoulder: mix(a.shoulder, b.shoulder),
  }
}

/** invert |x/hw|^n + |y/h|^n = 1 for x, given y. The crease is deliberately
    ignored: a detail should follow the base surface, not ride the highlight */
const superX = (hw: number, h: number, n: number, dy: number) => {
  const k = clamp(Math.abs(dy) / h, 0, 1)
  const sa = Math.pow(k, n / 2)
  const ca = Math.sqrt(Math.max(0, 1 - sa * sa))
  return hw * Math.pow(ca, 2 / n)
}

/** ...and for y, given x */
const superYAt = (hw: number, h: number, n: number, x: number) => {
  const ca = Math.pow(clamp(Math.abs(x) / hw, 0, 1), n / 2)
  const sa = Math.sqrt(Math.max(0, 1 - ca * ca))
  return h * Math.pow(sa, 2 / n)
}

/** the body's half-width at (z, y): where to hang a mirror, a handle, a
    shut-line or a sill strip so it touches the paint */
const flankX = (z: number, y: number) => {
  const s = sectionAt(z)
  const dy = y - SECT_Y
  return dy >= 0
    ? superX(s.hw, s.up, s.nUp, dy)
    : superX(s.hw, s.down, s.nDown, dy)
}

/** and the height of the body's crown at (z, x) */
const crownY = (z: number, x: number) => {
  const s = sectionAt(z)
  return SECT_Y + superYAt(s.hw, s.up, s.nUp, x)
}

/* --------------------------------------------------------- greenhouse loft -- */

interface Can {
  z: number
  hw: number
  /** the top of the section; the bottom is always CANOPY_FLOOR */
  top: number
}

/*
  Twelve stations from under the bonnet to under the tailgate. The first and
  last are below the body's crown at their own z and are therefore invisible —
  they exist so the *body* decides where the glass starts, which gives a
  curved screen base for free. Peak half-width 1.565, against a body flank
  that has fallen to about 1.50 by the waistline the glass emerges at — the
  greenhouse leans out over the shoulder rather than sitting inside it, and
  the pillars stand 0.035 proud of the glass again on top of that.
*/
const CANOPY: Can[] = [
  { z: -1.90, hw: 1.220, top: 1.720 },
  { z: -1.55, hw: 1.320, top: 1.990 },
  { z: -1.15, hw: 1.420, top: 2.300 },
  { z: -0.62, hw: 1.510, top: 2.610 },
  { z: -0.10, hw: 1.552, top: 2.760 },
  { z: 0.60, hw: 1.565, top: 2.808 },
  { z: 1.30, hw: 1.558, top: 2.808 },
  { z: 1.90, hw: 1.528, top: 2.770 },
  { z: 2.40, hw: 1.475, top: 2.660 },
  { z: 2.95, hw: 1.395, top: 2.400 },
  { z: 3.40, hw: 1.320, top: 2.100 },
  { z: 3.70, hw: 1.260, top: 1.860 },
]

const CANOPY_N = 20 // flatter than the body, so it needs fewer points
const CAN_UP = 4.6
const CAN_DOWN = 2.6

const canopyAt = (z: number): Can => {
  if (z <= CANOPY[0].z) return CANOPY[0]
  const last = CANOPY[CANOPY.length - 1]
  if (z >= last.z) return last
  let i = 1
  while (CANOPY[i].z < z) i++
  const a = CANOPY[i - 1]
  const b = CANOPY[i]
  const t = (z - a.z) / (b.z - a.z)
  return { z, hw: a.hw + (b.hw - a.hw) * t, top: a.top + (b.top - a.top) * t }
}

/* ------------------------------------------------------------- footprint --

   What a walker actually collides with, read off the two tables above rather
   than measured against them so it cannot drift from the paint. `hw` is the
   shell's own half-width plus the 0.075 the arch flare stands proud of it,
   which puts the widest station exactly on HALF_WIDE; `top` is whichever is
   higher at that z, the body crown or the greenhouse. The bumper bars cap
   each end — they are the only part of the car outside the shell's z range,
   and the wrap round each tip is a rounded nose, so the cap is two stations
   of taper rather than a square end.

   Following the roofline rather than flattening it has a nice consequence:
   the bonnet is a surface at bonnet height, low enough to hop onto (2.0
   against a 2.08 apex), and the roof is a step up from there — where one flat
   box top made the entire plan of the car standable at roof height, so you
   could stand on thin air above the bonnet.                                 */
const canopyTop = (z: number) =>
  z <= CANOPY[0].z || z >= CANOPY[CANOPY.length - 1].z ? 0 : canopyAt(z).top

const HULL: HullStation[] = [
  { z: -HALF_LEN, hw: 0.40, top: 1.05 },
  { z: -4.50, hw: 1.35, top: 1.05 },
  ...SECTIONS.map((s) => ({
    z: s.z,
    hw: s.hw + 0.075,
    top: Math.max(SECT_Y + s.up, canopyTop(s.z)),
  })),
  { z: 4.55, hw: 1.35, top: 1.05 },
  { z: HALF_LEN, hw: 0.40, top: 1.05 },
]

/** the glass surface's half-width at (z, y) — where an A-pillar has to run if
    it is to lie on the canopy rather than float beside it */
const canopyX = (z: number, y: number) => {
  const c = canopyAt(z)
  const cy = (c.top + CANOPY_FLOOR) / 2
  const h = (c.top - CANOPY_FLOOR) / 2
  const dy = y - cy
  return dy >= 0 ? superX(c.hw, h, CAN_UP, dy) : superX(c.hw, h, CAN_DOWN, dy)
}

/** ...and the height of the glass at (z, x): where a wiper has to lie if it is
    to lie on the screen. The wiper used to be authored at three absolute
    heights and its tip sat 0.10 above the roofline, which from outside is a
    black spike sticking up out of the windscreen */
const canopyY = (z: number, x: number) => {
  const c = canopyAt(z)
  const cy = (c.top + CANOPY_FLOOR) / 2
  return cy + superYAt(c.hw, (c.top - CANOPY_FLOOR) / 2, CAN_UP, x)
}

/** one capsule ring: a section symmetric about its own centre, with the roof
    exponent above and a softer one below */
const capsuleStation = (z: number, hw: number, top: number, bottom: number): Station => {
  const h = (top - bottom) / 2
  return { z, ring: ringSuper(hw, h, h, CAN_UP, CAN_DOWN, CANOPY_N), y: (top + bottom) / 2 }
}

/* ------------------------------------------------------------- small parts -- */

/** a plain box, for the dozens of tiny details where `slab`'s 122 vertices of
    softened arris would be spent on something four pixels across */
const chip = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d)

/*
  A tube drawn with n radial segments has flat sides: wherever a face rather
  than a vertex points outward its surface falls short of the nominal radius
  by cos(pi/n). That is a rounding error on a door handle and it is not one on
  a part the car's measured box comes from — the bumper bars set the 9.4 of
  length — so the front tip corrects for it instead of landing four
  millimetres inside the spec. (The arch flare sets the 3.75 of width and used
  to correct the same way; it now measures its own tube instead, for the
  reason FLARE_LIFT gives.)
*/
const FLAT_5 = Math.cos(Math.PI / 5)

/** the arch ellipse itself, in the (z, y) plane about an axle at the origin,
    optionally shrunk. One curve, read by the flare tube and the liner, so a
    change to the opening carries both of them with it */
const archCurve = (i: number, seg: number, shrink = 0) => {
  const a = (Math.PI * i) / seg // 0 at the rear of the arch, pi at the front
  return [
    (ARCH_H - shrink) * Math.sin(a),
    (ARCH_RZ - shrink) * Math.cos(a),
  ] as const
}

/* The flare rides on the flank, not on a fixed x.

   Held out at a constant 1.800 the whole way round — as it was — it is right
   over the crown of the opening, where the body genuinely is that wide, and
   wrong everywhere else: by the fore and aft ends of the ellipse the section
   has tucked in to about 1.12 at y = 0.36, so the tube's last handspan stands
   0.68 clear of the paint. Four stubs hanging in mid-air beside the sills,
   which is exactly where the eye goes on a parked car.

   FLARE_LIFT — how far proud of the flank the lip then stands — is measured
   off the tube that actually gets built rather than computed from its radius,
   because the reach of a six-sided tube along x depends on where its
   parallel-transport frame happens to have put its vertices. That used to be
   knowable: a path at constant x lies in a plane, the seed vector is parallel
   to the first tangent so the frame falls back to (1,0,0), and a *face* ends
   up on the axis — which is what FLAT_5 still corrects for on the bumper bar's
   front tip, and what a FLAT_6 used to correct for here. A path that follows
   the flank moves in all three
   axes, the seed no longer degenerates, and the frame comes out a quarter
   turn round with a *vertex* on the axis instead: the same nominal radius
   reached 0.087 rather than 0.075 and the measured car was 3.773 wide.

   Translating a path along x translates every vertex of its tube with it and
   leaves the transport frame untouched, so one throwaway build at zero offset
   gives the exact answer for any radius, any segment count and any path: the
   widest vertex of the flare lands on HALF_WIDE, and nothing else on the car
   is outside it. */
const ARCH_SEG = 14
/** the lip fades out as the opening closes onto the rocker, so it dies into
    the flank instead of ending in a cut cylinder */
const flareR = (t: number) => 0.075 * (0.3 + 0.7 * Math.pow(Math.sin(Math.PI * t), 0.4))

const flarePath = (az: number, lift: number) =>
  Array.from({ length: ARCH_SEG + 1 }, (_, i) => {
    const [dy, dz] = archCurve(i, ARCH_SEG)
    const y = ARCH_Y + dy
    return new THREE.Vector3(flankX(az + dz, y) + lift, y, az + dz)
  })

const FLARE_LIFT = (() => {
  let m = 0
  for (const az of [-AXLE_Z, AXLE_Z]) {
    const g = tube(flarePath(az, 0), flareR, 6)
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) m = Math.max(m, p.getX(i))
    g.dispose()
  }
  return HALF_WIDE - m
})()

/**
 * The inside of a wheel arch: a band swept along the arch ellipse whose faces
 * look *inward*. Wound the obvious way it is invisible — the `dark` material
 * is FrontSide and the only place this is ever seen from is inside the arc —
 * so both the winding and the explicit normals point at the opening.
 *
 * Its outer edge reads `flankX` at every station instead of standing at a
 * fixed 1.800. Over the crown of the opening the two are the same thing,
 * but by the fore and aft ends the section has tucked in to about 1.12 and a
 * band held out at 1.80 there is a shelf hanging outside the car. Authored in
 * car space rather than about the axle, because that is the only frame
 * `flankX` can be asked a question in.
 */
const archLiner = (az: number, shrink: number, seg = 10) => {
  const pos: number[] = []
  const nrm: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= seg; i++) {
    const [dy, dz] = archCurve(i, seg, shrink)
    const y = ARCH_Y + dy
    const z = az + dz
    const xOut = Math.max(ARCH_IN + 0.03, flankX(z, y))
    // the ellipse's inward normal, which is not its radius vector
    const n = new THREE.Vector2(-dz / (ARCH_RZ * ARCH_RZ), -dy / (ARCH_H * ARCH_H)).normalize()
    pos.push(ARCH_IN, y, z, xOut, y, z)
    nrm.push(0, n.y, n.x, 0, n.y, n.x)
  }
  for (let i = 0; i < seg; i++) {
    const b = i * 2
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3))
  g.setIndex(idx)
  return g
}

/** a polyline hugging the body's flank at one z, from y0 up to y1 */
const flankPath = (z: number, y0: number, y1: number, n: number, out = 0.015) => {
  const p: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n
    p.push(new THREE.Vector3(flankX(z, y) + out, y, z))
  }
  return p
}

/** ...and one running over the crown at one z, left to right */
const crownPath = (z: number, x0: number, x1: number, n: number, out = 0.012) => {
  const p: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n
    p.push(new THREE.Vector3(x, crownY(z, x) + out, z))
  }
  return p
}

/*
  A path wrapping the nose or the tail at one height: down the left flank,
  round a quarter-ellipse corner to the tip, and back up the right.

  BAR_SINK sinks the path into the paint and BAR_R is the tube radius swept
  along it, and the whole point of the pair is that the first is *smaller*
  than the second: the bar's outer face lands BAR_R - BAR_SINK proud of the
  flank. Sunk deeper than the radius — 0.18 against 0.15, as it was — the bar
  is inside the body everywhere along the sides and behind the cap at the tip,
  and 88% of the trim slot cannot be seen from any angle. Sunk not at all, the
  tube's full radius is added to a flank already at 1.83 and the car is no
  longer 3.75 wide. 0.07 against 0.13 is the pair that satisfies both.
*/
const BAR_SINK = 0.07
const BAR_R = 0.13

const wrapPath = (zs: number[], y: number, tipZ: number) => {
  const p: THREE.Vector3[] = []
  const hw = (z: number) => Math.max(0.05, flankX(z, y) - BAR_SINK)
  // the corner: a quarter ellipse from the last flank station to the tip, so
  // the bar rounds the end of the car instead of folding to a V at it
  const zEnd = zs[zs.length - 1]
  const xEnd = hw(zEnd)
  const corner: Array<[number, number]> = []
  for (let k = 1; k <= 3; k++) {
    const a = (k / 3) * (Math.PI / 2)
    corner.push([xEnd * Math.cos(a), zEnd + (tipZ - zEnd) * Math.sin(a)])
  }
  for (const z of zs) p.push(new THREE.Vector3(-hw(z), y, z))
  for (const [x, z] of corner) p.push(new THREE.Vector3(-x, y, z))
  for (let i = corner.length - 2; i >= 0; i--) p.push(new THREE.Vector3(corner[i][0], y, corner[i][1]))
  for (let i = zs.length - 1; i >= 0; i--) p.push(new THREE.Vector3(hw(zs[i]), y, zs[i]))
  return p
}

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

export function buildCar(opts: CarOpts): Vehicle {
  const { mats } = opts
  const slots = mats.slots

  /* ------------------------------------------------------------ the shell -- */

  const b = createPartBuilder()

  // --- lower body -----------------------------------------------------------
  const bodyStations: Station[] = BODY_Z.map((z) => ({
    z,
    ring: bodyRing(sectionAt(z)),
    y: SECT_Y,
    crease: CREASE_Z.has(z),
  }))
  b.add(loft(bodyStations, { capStart: 'flat', capEnd: 'flat' }), 'paint')

  // --- greenhouse -----------------------------------------------------------
  b.add(
    loft(
      CANOPY.map((c) => capsuleStation(c.z, c.hw, c.top, CANOPY_FLOOR)),
      { capStart: 'flat', capEnd: 'flat' },
    ),
    'glass',
  )

  /*
    The painted roof panel: the greenhouse's own outline, grown by a reveal
    and floored at ROOF_FLOOR, so the loft's underside doubles as a headliner
    and its lower rim stands out as a drip rail exactly where a real roof's
    does.

    It used to be built out of `capsuleStation` like the greenhouse itself,
    with the same half-width and a floor of 2.42 — and a capsule 3.18 wide and
    0.36 tall is a plank, not a roof. The greenhouse is only 2.77 across at
    that height (it is a rounded rectangle: full width at the waist, drawn in
    hard through the corner), so the panel stood 0.20 proud at its widest,
    overhung the glass on both sides and along the front, and its lower rim
    finished *inside* the cabin instead of on the drip line. The fix is to
    stop authoring a second shape and read the first one: take the canopy's
    own ring, scale it so the offset is the reveal at the crown and at the
    waist alike, and let `ringFloor` cut it off at the roof line.
  */
  const ROOF_FLOOR = 2.42
  const ROOF_REVEAL = 0.042
  const roofZ = [-0.18, 0.16, 0.62, 1.12, 1.62, 2.06, 2.42]
  b.add(
    loft(
      roofZ.map((z, i) => {
        const c = canopyAt(z)
        const cy = (c.top + CANOPY_FLOOR) / 2
        const h = (c.top - CANOPY_FLOOR) / 2
        // ...and faired in at the two ends, so the panel dies into the glass
        // rather than stopping in a step over the header and the backlight
        const e = ROOF_REVEAL * (0.3 + 0.7 * Math.pow(Math.sin((i / (roofZ.length - 1)) * Math.PI), 0.35))
        const ring = ringScale(
          ringSuper(c.hw, h, h, CAN_UP, CAN_DOWN, CANOPY_N),
          1 + e / c.hw,
          1 + e / h,
        )
        return { z, ring: ringFloor(ring, ROOF_FLOOR - cy), y: cy }
      }),
      { capStart: 'flat', capEnd: 'flat' },
    ),
    'paint',
  )

  // --- pillars --------------------------------------------------------------
  /*
    Pillars are ribs on the greenhouse, so they are placed by a *fraction of
    the canopy's height* and not by a list of absolute heights.

    That is the whole bug behind the two hoops. `canopyX(z, y)` inverts the
    section for x, and it has nowhere to go for a y at or above that station's
    crown, so it returns 0 — the centreline. The A-pillar's base asked for
    y = 1.94 at z = -1.62, where the roofline has only climbed to 1.936, and
    the C-pillar's top asked for 2.68 at z = 2.35, where it has already fallen
    to 2.671. Both ends duly landed on x = 0.035, and what the mirrored pair
    then drew was a pointed arch straight across the middle of the windscreen
    and another across the backlight: a roll cage, in tube, in body colour,
    over the two panes of glass you look through.

    A fraction cannot do that. f < 1 is always somewhere on the flank, and
    since dy/h = 2f - 1 is independent of z, a constant f traces a clean rib
    at a constant angle around the section — so the pillar follows the
    roofline up and over instead of cutting across it, and it is impossible
    for it to reach the centreline however the CANOPY table is retuned.
  */
  const canopyRib = (z: number, f: number, bias = 0.03) => {
    const c = canopyAt(z)
    const y = CANOPY_FLOOR + f * (c.top - CANOPY_FLOOR)
    return new THREE.Vector3(canopyX(z, y) + bias, y, z)
  }
  /** the shoulder the A- and C-pillars run on: high enough to be the corner
      of the DLO, low enough that the tube half-sinks into the glass rather
      than standing on the roof. Its top meets the roof panel's rim */
  const PILLAR_F = 0.82

  b.both(() => {
    // A-pillar: cowl to header
    b.add(
      tube(
        [-1.66, -1.44, -1.18, -0.88, -0.54, -0.06].map((z) => canopyRib(z, PILLAR_F, 0.035)),
        0.1,
        5,
      ),
      'paint',
    )
    // C-pillar: roof trailing edge down to the tailgate glass base
    b.add(
      tube(
        [2.42, 2.68, 2.96, 3.24, 3.48, 3.68].map((z) => canopyRib(z, PILLAR_F, 0.03)),
        0.095,
        5,
      ),
      'paint',
    )
    // B-pillar: blacked out at the back of the door, the hot-hatch signature
    b.add(
      tube(
        [0.42, 0.58, 0.72, 0.86].map((f) => canopyRib(1.02, f, 0.02)),
        0.085,
        6,
      ),
      'dark',
    )
    // window surround along the top of the door: the DLO's lower black band
    b.add(
      tube(
        [-1.5, -1.0, -0.4, 0.2, 0.7, 1.05].map(
          (z) => new THREE.Vector3(canopyX(z, 1.9) + 0.03, 1.9, z),
        ),
        0.045,
        5,
      ),
      'dark',
    )
  })

  // --- wheel arches ---------------------------------------------------------
  /*
    The opening is already cut into the body loft (`archCutY`). What is left
    to build is the flare that finishes its edge and the liner that darkens
    the inside of it. Both are swept along the *same* ellipse and both now
    ride on the flank rather than standing at a fixed x — see FLARE_LIFT for
    what holding them out at 1.800 cost, which was four cut tube ends hanging
    in mid-air beside the sills and two shelves of liner outside the paint.
    The liner is that ellipse 0.03 smaller, spanning the tunnel from ARCH_IN
    out to the flank, faces inward. It runs from ARCH_IN rather than from
    where the paint roof actually starts (x = 1.208..1.247, depending on the
    station) so its inboard edge finishes *behind* the wall instead of
    stopping short of it: buried is invisible, and a gap between liner and
    roof would not be. There is no blocker disc either — the arch's own
    inboard wall is what a low camera sees now.
  */
  for (const az of [-AXLE_Z, AXLE_Z]) {
    b.both(() => {
      b.add(tube(flarePath(az, FLARE_LIFT), flareR, 6), 'paint')
      b.add(archLiner(az, 0.03), 'dark')
    })
  }

  // --- bumpers, valances, sills --------------------------------------------
  // the tips are what makes the car 9.4 long; the shell stops 0.35 short of
  // them at either end and everything below stands in that gap
  const FRONT_Z = [-3.70, -4.05, -4.25, NOSE_Z]
  const REAR_Z = [3.70, 4.05, 4.25, TAIL_Z]
  const barR = (t: number) => BAR_R - 0.03 * Math.sin(t * Math.PI)
  /* each tip sits at HALF_LEN minus the reach of the bar's own surface there,
     so the bar's outer face — not its centreline — is what makes the car
     exactly 9.4 long. The two ends need different numbers because the two
     paths run opposite ways and `tube`'s parallel-transport frame therefore
     lands a flat face on the axis at the nose and a vertex on it at the tail:
     the same 0.10 radius reaches 0.081 forward and 0.100 back. */
  b.add(tube(wrapPath(FRONT_Z, 0.95, -(HALF_LEN - barR(0.5) * FLAT_5)), barR, 5), 'trim')
  b.add(tube(wrapPath(REAR_Z, 1.00, HALF_LEN - barR(0.5)), barR, 5), 'trim')
  // splitter and diffuser: the dark strip under each bumper that stops the
  // car looking like it is floating. Both sit forward of their end cap
  b.add(chip(2.2, 0.15, 0.36), 'dark', at(0, 0.58, -4.50))
  // the diffuser sits 0.08 further forward than the splitter does, and that
  // asymmetry is the exhaust's: the tip's closing disc used to land on
  // 4.680000 against a diffuser rear face of 4.500 + 0.180 = 4.680000, two
  // coplanar surfaces in the middle of the chase camera's view. The tip
  // cannot move back instead — 4.70 is the bumper bar's, and the car's
  b.add(chip(2.2, 0.17, 0.36), 'dark', at(0, 0.62, 4.42))
  b.both(() => {
    // sill / side skirt, hugging the rocker between the two arch openings —
    // it has to stop short of them or it hangs in the middle of the hole
    b.add(
      tube(
        [-1.82, -1.2, -0.4, 0.4, 1.2, 1.82].map(
          (z) => new THREE.Vector3(flankX(z, 0.58) + 0.01, 0.58, z),
        ),
        0.09,
        5,
      ),
      'dark',
    )
  })

  // --- front face -----------------------------------------------------------
  /*
    Everything here lives between NOSE_Z and the bumper tip, i.e. in front of
    the shell's cap rather than behind it. The paint that shows between the
    pieces is the nose panel, which is what a real car has above its grille.
  */
  /*
    Grille and lamps share the width of the nose, and the grille used to take
    all of it: 2.00 of dark panel in a 2.10 chrome mouth left the lamps
    nowhere to go, so the lens was authored 0.95 long from x = 0.55 and its
    inboard half was inside the grille — the XYZ euler swings that end forward
    to z = -4.66 while the grille panel spans -4.56..-4.44, which is a lens
    passing straight through a grille. A slim upper grille over a wide lower
    intake is the face a modern hatch actually has, and it is also the one
    that leaves the lamps a real place to sit: the mouth now stops at 0.84 and
    the lens starts at 0.89, outboard of it with clear air between.
  */
  b.add(chip(1.56, 0.34, 0.12), 'dark', at(0, 1.28, -4.50))
  b.add(chip(1.66, 0.07, 0.11), 'chrome', at(0, 1.47, -4.52))
  b.add(chip(1.66, 0.07, 0.11), 'chrome', at(0, 1.09, -4.52))
  b.both(() => {
    b.add(chip(0.07, 0.34, 0.11), 'chrome', at(0.805, 1.28, -4.52))
  })
  b.add(chip(1.75, 0.24, 0.12), 'dark', at(0, 0.74, -4.52))

  // headlamps: a shaped lens wrapping back around the corner — the rotation
  // sweeps its outboard end rearward into the wing, which is the direction
  // the nose's own plan view runs — with a dark shadow gap under it. Two
  // spheres would read as a face; two swept wedges read as a car
  b.both(() => {
    b.add(slab(0.56, 0.30, 0.30, 0.10), 'lamp', at(1.22, 1.40, -4.44, 0.05, -0.24, 0.09))
    b.add(chip(0.50, 0.10, 0.12), 'dark', at(1.22, 1.18, -4.40, 0, -0.24, 0))
  })

  // --- rear face ------------------------------------------------------------
  b.both(() => {
    /*
      Tail lamps. The panel they sit on is the shell's flat cap at z = 4.40,
      flat all the way out to x = 1.537 where the ring's edge is, so a lens
      splayed hard across it does not wrap anything — it just lifts its
      inboard edge off. At 0.30 of yaw the standoff ran 0.244 inboard against
      0.177 outboard, which reads as a lens coming unstuck. It takes 0.08 to
      follow the panel evenly and 0.66 of length to actually *reach* the
      corner, where the last of it tucks behind the flank as the body turns
      away. Standing them 0.27 proud of the flank instead read as a blister.
    */
    b.add(slab(0.66, 0.80, 0.26, 0.09), 'lampRed', at(1.22, 1.58, 4.375, 0, 0.08, 0))
    // the dark housing the lens sits in. It used to be a chip smaller than
    // that slab on all three axes and concentric with it, i.e. a part sealed
    // inside another part; it is bigger than the lens now, so what shows is
    // the gasket line around it — 0.04 of one, not the 0.07 it was, which at
    // this size stopped reading as a gasket and started reading as a frame
    b.add(chip(0.74, 0.88, 0.16), 'dark', at(1.22, 1.58, 4.38, 0, 0.08, 0))
  })
  // number plate on its own recessed dark panel, both forward of the cap and
  // above the bumper bar rather than behind it. 1.64 wide, so its corners
  // stop short of the lamps rather than sharing their volume
  b.add(chip(1.64, 0.5, 0.06), 'dark', at(0, 1.38, 4.46))
  b.add(chip(1.5, 0.40, 0.05), 'paint2', at(0, 1.38, 4.51))
  // exhaust: one chromed can under the left of the valance, poking through it
  b.add(
    revolve([[0, 0.0], [0.13, 0.0], [0.145, 0.42], [0.16, 0.46], [0, 0.46]], 10, { sharp: [2] }),
    'chrome',
    at(-0.85, 0.62, 4.22, Math.PI / 2, 0, 0),
  )
  /* Spoiler lip. It rides on the roofline rather than on three authored
     heights: at a fixed y = 2.70 it used to be level while the roof fell away
     under it, so from the side it was a bar floating over the tailgate with
     daylight beneath. Sunk into the roof panel at its leading edge and lifting
     0.09 clear of the glass by its trailing one, it reads as what it is — the
     roof's own trailing edge, kicked up. */
  b.add(
    loft(
      [[2.40, -0.03, 1.40, 0.05], [2.64, 0.04, 1.37, 0.06], [2.88, 0.09, 1.28, 0.045]].map(
        ([z, dy, hw, h]) => ({
          z,
          ring: ringSuper(hw, h, h, 5, 5, 16),
          y: canopyAt(z).top + dy,
        }),
      ),
      { capStart: 'flat', capEnd: 'flat' },
    ),
    'paint',
  )

  // --- flank details --------------------------------------------------------
  b.both(() => {
    /* the two door shut-lines of a three-door: A-pillar base to the B-pillar.
       They stop at the belt rather than at 1.92, which is above the cut edge
       now that the cabin is open — `flankPath` reads the *uncut* flank, so the
       last handspan of each line used to hang over the door aperture */
    for (const z of [-1.52, 1.02]) b.add(tube(flankPath(z, 0.46, 1.80, 6), 0.022, 4), 'dark')
    // handle, on the door skin. It runs fore-and-aft: 0.36 of length on the x
    // axis instead put its outer face 0.01 past the car's stated width. At the
    // 1.82 it sat at before it was level with the belt, which is not a place a
    // handle goes — it read as a badge lying on top of the door
    b.add(chip(0.10, 0.09, 0.36), 'chrome', at(flankX(0.3, 1.60) + 0.03, 1.60, 0.3))
    /* Mirror on a stalk, growing out of the door's leading top corner. It used
       to be centred at y = 2.06 — a quarter of a unit above the belt and
       forward of the glass — so what it actually looked like was a small
       painted box parked on the wing with a stalk that reached nothing. The
       stalk now starts on the flank at the base of the A-pillar and the shell
       sits just outboard of the door top. Its 0.15 half-width and two small
       rotations put its outermost corner on 1.844: proud of the door, and
       inside the width, which the arch flare owns. */
    b.add(
      tube(
        [
          new THREE.Vector3(flankX(-1.32, 1.78) - 0.02, 1.78, -1.32),
          new THREE.Vector3(1.60, 1.87, -1.38),
        ],
        0.05,
        5,
      ),
      'trim',
    )
    b.add(chip(0.30, 0.20, 0.13), 'paint', at(1.68, 1.90, -1.40, 0, 0.12, 0.05))
    // ...and the glass in the back of it, on the housing's own rotated rear
    // face rather than buried at its centre
    b.add(chip(0.24, 0.15, 0.02), 'glass', at(1.687, 1.90, -1.341, 0, 0.12, 0.05))
    // wiper: an arm and a blade lying on the screen, at the heights the screen
    // actually has rather than at three authored ones
    b.add(
      tube(
        ([[0.30, -1.53], [0.62, -1.32], [0.86, -1.03]] as const).map(
          ([x, z]) => new THREE.Vector3(x, canopyY(z, x) + 0.02, z),
        ),
        0.028,
        4,
      ),
      'dark',
    )
  })
  // bonnet and tailgate shut-lines, following the crown across the car
  b.add(tube(crownPath(-1.52, -1.24, 1.24, 7), 0.022, 4), 'dark')
  b.add(tube(crownPath(4.12, -1.30, 1.30, 7), 0.022, 4), 'dark')

  /* --------------------------------------------------------- the interior -- */

  /*
    Seen through 62% opaque glass, so it is blocked in rather than detailed —
    but an empty cabin is the other thing that makes a car read as a prop, and
    until the shell was cut open above (`cabinCutY`) none of this was seen at
    all: every piece here sat under a painted deck at y = 2.00. Which is also
    why the sizes below now matter. The dashboard was 3.10 wide, which is
    0.12 outside the windscreen at the height its top reaches — invisible
    under the deck, a slab through the glass without it.

    The floor pan stops short of both arch bands (|z| 1.76..3.64) rather than
    being narrowed to ARCH_IN: the openings are a hole in the body, so a pan
    that reaches into one shows its corner through the wheel arch, and the
    seats need the width more than the boot needs the length. It is 0.06 above
    CABIN_FLOOR, so the tub's own painted floor shows as an inner rocker
    either side of it rather than the pan hovering over nothing.
  */
  b.add(chip(2.9, 0.06, 3.2), 'dark', at(0, 0.74, 0.05))
  b.add(chip(0.52, 0.62, 1.7), 'trim', at(0, 1.06, -0.25))
  // parcel shelf, long enough to close the boot off under the backlight
  b.add(chip(2.4, 0.06, 1.7), 'trim', at(0, 1.98, 2.72))
  b.add(chip(2.76, 0.50, 0.44), 'trim', at(0, 1.66, -1.10))
  b.add(chip(0.72, 0.26, 0.14), 'dark', at(-0.78, 1.88, -1.24, 0.3, 0, 0))
  b.both(() => {
    // door card, lying on the tub's inner wall — which leans in as it drops,
    // from 1.616 at the belt to 1.525 at the floor
    b.add(chip(0.14, 0.70, 2.2), 'trim', at(1.52, 1.42, -0.30))
    // seat: cushion, reclined back, headrest
    b.add(chip(0.80, 0.20, 0.86), 'seat', at(0.78, 0.90, 0.28))
    b.add(chip(0.76, 1.02, 0.20), 'seat', at(0.78, 1.52, 0.80, 0.16, 0, 0))
    b.add(chip(0.42, 0.26, 0.16), 'seat', at(0.78, 2.10, 0.88))
  })
  // gear lever and handbrake, on the console between the seats
  b.add(tube([new THREE.Vector3(0, 1.36, -0.62), new THREE.Vector3(0, 1.70, -0.68)], 0.035, 5), 'chrome')
  b.add(chip(0.14, 0.12, 0.14), 'dark', at(0, 1.76, -0.69))
  b.add(tube([new THREE.Vector3(0, 1.22, 0.08), new THREE.Vector3(0, 1.52, 0.42)], 0.04, 5), 'chrome')
  b.add(chip(0.11, 0.10, 0.22), 'dark', at(0, 1.55, 0.48, -0.7, 0, 0))

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

  /* ---------------------------------------------------------- the driver -- */

  /*
    The original static service-robot approximation — cream shell, dark
    plastic limbs, a black visor with two lit eyes — sitting in the left seat
    with its hands at quarter to three. It borrows the vehicle slots rather
    than making its own materials: paint2 for the cream, trim for the dark,
    dark for the visor, chrome for the joints. The eyes take the `lamp` slot,
    which means they come on with the headlights and are a pale grey by day.
    That is a happy accident of sharing eleven materials across three
    vehicles. It now stays hidden: CrtScene attaches the live articulated
    player rig to `driverSeat`, so every vehicle carries the exact same avatar.
  */
  const dr = createPartBuilder()
  const DX = -0.78 // the driver's seat centreline: left-hand drive
  dr.add(chip(0.62, 0.30, 0.46), 'trim', at(DX, 1.12, 0.20))
  dr.add(chip(0.72, 0.62, 0.50), 'paint2', at(DX, 1.58, 0.12, 0.14, 0, 0))
  dr.add(chip(0.34, 0.24, 0.06), 'dark', at(DX, 1.55, -0.16, 0.14, 0, 0))
  dr.add(chip(0.20, 0.14, 0.18), 'trim', at(DX, 1.90, 0.10))
  dr.add(chip(0.50, 0.42, 0.44), 'paint2', at(DX, 2.13, 0.06))
  dr.add(chip(0.36, 0.17, 0.06), 'dark', at(DX, 2.15, -0.15))
  dr.add(chip(0.07, 0.09, 0.03), 'lamp', at(DX - 0.09, 2.15, -0.18))
  dr.add(chip(0.07, 0.09, 0.03), 'lamp', at(DX + 0.09, 2.15, -0.18))
  dr.add(chip(0.09, 0.13, 0.13), 'trim', at(DX - 0.27, 2.14, 0.06))
  dr.add(chip(0.09, 0.13, 0.13), 'trim', at(DX + 0.27, 2.14, 0.06))
  for (const s of [-1, 1]) {
    const sh = DX + s * 0.38
    const hand = DX + s * 0.33
    dr.add(
      tube(
        [
          new THREE.Vector3(sh, 1.82, 0.06),
          new THREE.Vector3(sh + s * 0.03, 1.64, -0.44),
          new THREE.Vector3(hand, 1.76, -0.86),
        ],
        0.095,
        5,
      ),
      'trim',
    )
    dr.add(chip(0.14, 0.14, 0.12), 'paint2', at(hand, 1.78, -0.92))
    dr.add(chip(0.13, 0.13, 0.13), 'chrome', at(sh, 1.82, 0.06))
    dr.add(
      tube(
        [
          new THREE.Vector3(DX + s * 0.22, 1.08, 0.26),
          new THREE.Vector3(DX + s * 0.22, 1.04, -0.28),
          new THREE.Vector3(DX + s * 0.22, 0.92, -0.52),
        ],
        0.135,
        5,
      ),
      'trim',
    )
    dr.add(
      tube(
        [
          new THREE.Vector3(DX + s * 0.22, 0.92, -0.54),
          new THREE.Vector3(DX + s * 0.22, 0.80, -0.78),
        ],
        0.115,
        5,
      ),
      'trim',
    )
  }
  const driver = dr.build(slots, { cast: false, receive: false, name: 'driver' })
  driver.name = 'driver'
  driver.visible = false

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
  steerWheel.position.set(DX, 1.80, -0.92)
  steerWheel.rotation.x = -0.45

  /* --------------------------------------------------------- the assembly -- */

  const root = new THREE.Group()
  root.name = 'car'
  /* the body carries everything that leans: the shell, the interior, the
     driver and the lamps. The wheels hang off `root` instead, so they stay
     upright while the body pitches and rolls over them — which is the whole
     visible product of the suspension */
  const body = new THREE.Group()
  body.add(shell, driver, steerWheel)
  // The real player rig is attached here while occupied. Unlike `root`, this
  // group carries the suspension's pitch and roll, so the driver rides the
  // body instead of staying uncannily level while the car moves underneath.
  const driverSeat = new THREE.Group()
  driverSeat.name = 'driverSeat'
  driverSeat.position.set(DX, 0.88, 0.62)
  body.add(driverSeat)
  // the other side of the same bench: this is left-hand drive, so the mirror
  // of the driver's centreline is the passenger's
  const passengerSeat = new THREE.Group()
  passengerSeat.name = 'passengerSeat'
  passengerSeat.position.set(-DX, 0.88, 0.62)
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
    l.position.set(s * 1.15, 1.40, -4.4)
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
    if (breaks && rush > breaks.limit) {
      // it comes with us. No push, no reflection, no yaw — the car keeps its
      // line and pays for the prop out of its speed, which is the whole
      // difference between driving through a sapling and hitting a wall
      vel.multiplyScalar(1 - clamp((breaks.limit * 0.6) / rush, 0, 0.6))
      impact = Math.max(impact, rush * 0.3)
      breaks.hit(
        pos.x + hit.at.x, pos.y + 0.5, pos.z + hit.at.z,
        vel.x / rush, vel.z / rush, rush,
      )
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
      eye: new THREE.Vector3(-0.78, 2.05, 0.35),
      eye2: new THREE.Vector3(0.78, 2.05, 0.35),
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
