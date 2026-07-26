import * as THREE from 'three'
import { noStand, type HullStation, type Solid } from '../physics/collision'
import {
  at, blade, createPartBuilder, loft, markDynamic, revolve, ringSuper, slab, tube,
} from './parts'
import type { VehicleMaterials } from './materials'
import {
  axes, clamp, clearAt, damp, groundNormal, groundUnder, sweepBody,
} from './chassis'
import type { DriveEnv, DriveStep, Vehicle } from './types'

/*
  The helicopter: a two-seat piston machine, and the reason the far side of
  the continent is worth building.

  The world out there is a planet with a coast two and a half kilometres from
  the front door and mountains behind it, and a car cannot get to either. A
  fixed wing could — but a fixed wing needs six hundred units of flat asphalt
  at both ends of the trip, and there are no runways in a procedurally
  generated suburb. A rotorcraft is the only air vehicle that can take off
  from the spot it is parked on and land on whatever it finds, which is the
  whole point: this is the machine you use to *go and look at something*.

  It is small on purpose. The largest clear disc anywhere near the house is
  11.3 units (registry.ts's HOME, probed rather than guessed), so the rotor
  is 7.6 units of radius — a Robinson R22 / Schweizer 300 sized thing, a
  bubble canopy over two seats with an open tubular tail boom behind it. Every
  dimension below follows from that one number.

  ## The shape

  The cabin is not a box with a windscreen; it is a *teardrop with a hole cut
  in it*. All of it — the opaque shell, the glazing and the roof — is skinned
  from the same twelve authored cross-sections (`SECTIONS`, graded into
  `CABIN`), and each section carries one extra number, `belly`: the half-width,
  in turns, of the opaque arc centred on the section's lowest point. The shell
  strip covers that arc; a second strip covers the complement, in glass as far
  as the door post and in paint from there aft, where it closes over the crown
  and becomes the roof. Because every strip is sampled from the same parametric
  section they share their edges exactly, to the float — there is no seam to
  line up and no gap to close, and the glazed area can therefore *change shape
  along the body*, which is what the real aeroplane does and what a
  closed-loft-plus-a-window-decal cannot. At the nose `belly` is 0.03, so the
  chin is glass to within a hand's width of the keel and you can see the
  ground between your feet; by the door post it has opened to 0.135 (the sill
  sits about 48 degrees below the horizontal); a little further aft it is 0.44
  and the roof has closed over, which is where the mast comes through. That
  curved chin is the single feature that makes people read "helicopter"
  instead of "flying car", and the glazing costs 231 vertices.

  Everything aft of the firewall is a tapering tube with things hung off it,
  because that is literally what it is: an R22's tail boom is a monocoque with
  a driveshaft cover along the top, a stabiliser, a fin and a gearbox.

  Four things about that shell cost more to get wrong than anything else here,
  and all four did. Every one of them is invisible to the tests you reach for
  first — a bounding box, a vertex-by-vertex containment check, an eyeball at
  the render — which is why the note under each of them is longer than the fix.

  The first is winding. `skin()` is this file's own private loft, and it
  inherited loft()'s inward-facing strip order — see the note on the function.
  An open strip has no end caps to visibly contradict it, so instead of the
  usual "the model didn't load", the cabin and the canopy just drew from the
  inside under a FrontSide material, with every computed normal aimed into the
  hull while the BoxGeometry parts merged into the same 'paint' mesh stayed
  outward. What that looks like is bad lighting, so it survives review.

  The second is that a section is not a bounding box. `belly` and `hw` describe
  a body 3.4 wide at the shoulder, but CABIN's lower halves are near-elliptical
  over a 1.1-1.2 reach, so the same body is under two units wide at the floor
  pan's underside and nothing at all a tenth below that: the last stretch above
  the keel is a narrow V. Every part down there has to be sized against its own
  height, and three of them were not — a 2.9-wide floor pan at y = 1.2 that
  stuck a black slab out of both flanks below the keel line, the outer rudder
  pedals, and the foot of the collective. All three came out through the
  *glazing*, which is the one surface here that does not hide what is behind it.

  The third is that a section is not the surface either. What gets emitted is a
  ruled strip between two rows of samples, and where the two rows disagree
  about where their columns sit — which is exactly what `belly` changing does —
  the straight line between them cuts the corner. Across the one-bay step at
  the door post that cut ran nearly half a unit deep, and the seat cushions and
  the collective both stood in the hollow it left. `graded()` is the fix and
  the note there is the argument; the rule to carry away is that *the surface
  to measure against is the one the builder emits*. Sample it densely over each
  triangle, not at its corners: three of the four faults this shell has had put
  every vertex safely inside and came out through the middle of a face.

  The fourth is that an open strip does not close itself. Where `belly` reaches
  half a turn the shell's two edges arrive at the same point, but they are
  still two columns of a strip that has no wrap-around quad, and forward of
  that they are genuinely apart. Nothing was drawn over the crown between the
  door post and the station behind it: three quarters of a square unit of open
  sky straight down onto the seat backs, printed twice into the machine's own
  ground shadow. The complement strip (`CROWN_END`) is what covers it now.

  ## The flight model, and what it deliberately is not

  This is an arcade model with one honest idea in it and a lot of assistance
  built around it. The honest idea: **thrust acts along the rotor disc normal,
  and the disc normal is the machine's own up vector.** Bank and some of the
  lift becomes a sideways force; pitch the nose down and some of it becomes
  forward force. That single fact is helicopter flight, and everything the
  player feels — that a turn is a lean, that you accelerate by *tipping*, that
  you must level out to stop — falls out of it rather than being scripted.

  The assistance around it exists because the input device is a keyboard with
  seven keys on it and the target is a player who has never flown anything:

  - **The collective is a governor, not a lever.** The vertical channel is
    servoed to a commanded *rate* (0 with nothing pressed), so centred controls
    hold altitude instead of sinking. Real machines need constant collective
    work in the hover; a player pressing nothing would simply crash.
  - **A/D is a coordinated turn, not roll and pedal.** At the hover it is
    pedal — pure yaw, no bank at all, because a machine that leans when you tap
    a key drifts off the landing spot. The bank fades in between 3 and 17 u/s
    and the pedal fades out over the same range, and from there the yaw rate is
    *derived* from the bank: yawRate = -latAcc / V, which is the textbook
    coordinated turn and means the sideways force the bank produces is exactly
    the centripetal force the turn needs. So the radius falls out of the
    physics rather than a table — 85 units at a held 40 u/s, 156 at the 55 u/s
    cruise, both inside a tenth of a percent of V²·cos(pitch)/(G·tan 28°). The
    cosine is not decoration: the thrust the bank tips sideways is the weight
    divided by cos(pitch), so a nose-down cruise turns *inside* the textbook
    V²/(G·tan bank) rather than on it — 156 where that formula says 167. And
    the sideslip measures 0.000. The
    handover has to happen *early*: while the pedal is still strong and the
    machine is already banking, the two yaw sources add, the nose ends up well
    inside the velocity vector, and full deflection becomes a flat spin the
    machine can never accelerate out of — it was 13 u/s and 62% sideways
    before BANK_V came down from 26 to 14.
  - **Centred cyclic is a velocity brake, not an attitude hold.** With no fore
    or aft input the pitch target is derived from the machine's own forward
    speed (nose up to kill it) and dies away as the speed does, which is what
    "comes to a hover" means — 55 u/s to a dead stop in four seconds, hands
    off. The same term runs on the lateral axis, at full strength at the hover
    and a third of it in a turn, and it is what stops a pedal turn drifting.
  - **The last metre lands itself.** Ground effect is modelled as a *limit*
    rather than a force: inside seven units the machine will not arrive faster
    than GE_TOUCH + GE_SLOPE·height, so a descent is caught and eased to 0.55
    u/s at contact whatever it was doing at the top. Holding Ctrl punches
    partway through that (2.3 u/s on the skids — firm, and under the
    registry's impact threshold); Ctrl+Shift mostly wins (9.8 u/s, which
    bangs); a stopped rotor wins completely (41 u/s, which is a crash). And
    below LAND_H, letting go of the collective *settles* instead of holding
    height, because a hover-hold that leaves you parked a metre up waiting for
    something to happen is the most confusing thing it could possibly do.
  - **Shift tilts the disc, not the fuselage.** The attitude limits (28 deg of
    bank, 22 of pitch) are what the model is allowed to *show*; under boost the
    thrust vector leans a further 9 degrees, which is honest — a rotor disc
    does tilt relative to its airframe — and it is what turns a 55 u/s cruise
    into a 75 u/s one against the same drag curve.

  Drag is one isotropic parasite term, linear plus quadratic
  (`DRAG_LIN`/`DRAG_QUAD`), and the two coefficients were *solved* rather than
  tuned: they are the pair that puts the terminal speed at 55 u/s against
  G·tan(22°) and at 75 against G·tan(31°). The vertical governor cancels its
  own share of that drag by feed-forward, so a commanded 11 u/s climb is 11
  u/s and not 10.3.

  ## The rotor is the whole feel

  On `mount()` the rotor takes four seconds to come up and makes lift as the
  square of its speed (thrust ∝ ω², which is true), so the machine sits on its
  skids for the first three and a quarter of them and then goes light under
  you. On `dismount()` it winds down over eight. `DriveStep.rpm` reports that
  number directly, so sfx.ts's blade-slap gate sweeps with it, and the blades
  cone up two and a half degrees at rest and four and a half under load,
  because a disc cones under thrust and a rotor that stays flat looks like a
  ceiling fan.

  ## The documented cheat: the disc does not collide

  The fuselage sweeps its footprint through the world's Box3 list and stops
  against buildings like anything else. **The rotor disc does not collide with
  anything, ever.** This is deliberate. Every solid out there is a coarse AABB
  — a tree is a box around its canopy, a house is a box around its eaves — and
  a 15.2-unit disc tested against coarse boxes clips something on almost every
  street in town. The machine would be unflyable in exactly the place it is
  parked, and the failure would look like a bug (stopped dead by nothing
  visible) rather than like a consequence. So the blades pass through geometry
  and the cabin does not, and the player's mental model — "don't fly the body
  into things" — is the one the simulation actually enforces. If the world
  ever grows real convex hulls, this is the paragraph to come back to.

  Three smaller consequences of the same coarseness, all correct and all
  worth knowing. `supportY` skips every `noStand` box by design and every
  outdoor solid is one, so there is nowhere to land but terrain — no roofs, no
  walls. Water counts as terrain to land on, which reads as the fixed floats an
  R22 can actually be fitted with. And the swept footprint is `size`, centred
  on the origin: 9 units either way, against a body that runs -6.5 to +11.5.
  So the sweep reaches a couple of units past the nose and stops a couple short
  of the fin, which is the right way round — you feel the machine stop before
  the canopy is inside a wall, and the last of the tail boom is thin air that
  nobody will ever notice passing through a hedge.
*/

const TAU = Math.PI * 2
const DEG = Math.PI / 180
/** signed power — the superellipse has to survive a negative cosine */
const spow = (v: number, e: number) => Math.sign(v) * Math.pow(Math.abs(v), e)

/* ------------------------------------------------------------ dimensions -- */

/** 1 world unit = 0.48 m. Every number below is in units unless it says so */
const ROTOR_R = 7.6
/** rotor hub height. The mast is exposed above the cabin roof, R22 fashion */
const HUB_Y = 5.3
/** the mast stands just aft of the seat backs, over the centre of gravity —
    far enough back that the roof has closed over the skylight by then, far
    enough forward that the disc still overhangs the nose by 0.35 */
const MAST_Z = 0.75
const SKID_X = 1.45
const SKID_Z0 = -2.6
const SKID_Z1 = 3.2
/** boom root and tip, and the axis it runs along (booms rise slightly aft) */
const BOOM_Z0 = 2.2
const BOOM_Z1 = 10.4
const boomY = (z: number) => 2.72 + ((z - BOOM_Z0) / (BOOM_Z1 - BOOM_Z0)) * 0.7
const boomR = (z: number) => 0.62 - ((z - BOOM_Z0) / (BOOM_Z1 - BOOM_Z0)) * 0.36
/** tail rotor: hub on the left of the fin, 1.15 radius (2.3 diameter = 1.1 m,
    which is an R22's). Its disc reaches z 9.25..11.55 and the main disc's aft
    edge is at 8.35 — a real design constraint, honoured */
const TR_X = -1.12
const TR_Y = 3.85
const TR_Z = 10.4
const TR_R = 1.15

/* --------------------------------------------------------------- flight -- */

/** the walk controller's gravity, so a fall out of the sky weighs the same as
    a fall off a roof: 34 u/s² = 16.3 m/s² */
const G = 34
/** what the airframe is allowed to show. Enough to feel dynamic, nowhere near
    enough to invert */
const MAX_BANK = 28 * DEG
const MAX_PITCH = 22 * DEG
/** how much further the disc leans than the fuselage when Shift is held. A
    rotor really does tilt relative to its airframe, and this is the whole
    mechanism behind the boost: 22 deg of attitude, 31 of thrust */
const DISC_LEAD = 9 * DEG
/** attitude servo rate, 1/s. 3.4 is a 0.29 s time constant — generous enough
    that letting go of the keys visibly levels the machine within a second */
const ATT_RATE = 3.4
/** thrust/weight at 100% rotor. 1.55 puts lift-off at spin = 1/sqrt(1.55) =
    0.80, i.e. 3.2 s into the 4 s spin-up, and caps the climb accel at 0.55 g */
const TW = 1.55
/** parasite drag, accel = (DRAG_LIN + DRAG_QUAD·V)·V. Solved, not tuned: this
    is the pair for which G·tan(22°) balances at 55 u/s and G·tan(31°) at 75 */
const DRAG_LIN = 0.181
const DRAG_QUAD = 0.001247
/** commanded vertical rates, u/s. 11 u/s is 5.3 m/s, a brisk but believable
    light-helicopter climb; Shift makes it 16 */
const CLIMB = 11
const CLIMB_BOOST = 16
const SINK = 9
const SINK_BOOST = 13
/** the governor: vertical accel = (wantVy - vy)·VERT_GAIN, so 3.2 is a 0.31 s
    settle, and it may not ask for more than a third of a g down or 0.76 up */
const VERT_GAIN = 3.2
const VERT_MIN = -12
const VERT_MAX = 26
/** with the collective centred the machine holds the height it was left at.
    A pure rate servo would hold vy=0 and still drift a unit a minute */
const HOLD_GAIN = 0.85
const HOLD_CLAMP = 4
/** ground effect: inside seven units the disc is working against its own
    downwash off the ground and the machine simply will not arrive faster than
    this — GE_TOUCH + GE_SLOPE·height, u/s. GE_TOUCH is therefore literally the
    touchdown speed: 0.55 u/s is 0.26 m/s, a skid kissing the grass */
const GE_H = 7
const GE_TOUCH = 0.55
const GE_SLOPE = 0.75
/** how much of that a deliberate descent punches through. On Ctrl alone the
    cushion still lands it softly, it just falls faster on the way in; on
    Ctrl+Shift it mostly wins, which is how you arrive hard enough to hear it */
const GE_PUSH = 1.6
const GE_PUSH_HARD = 5
/** below this, hands off the collective *settles* rather than holding height.
    Without it a player who lets go a metre up hovers there forever waiting to
    land, which is the single most confusing thing a hover-hold can do */
const LAND_H = 2.2
/** hover-brake authority. Nose-up proportional to forward speed, saturating
    at 14 u/s, so a 55 u/s cruise decelerates at ~9.4 u/s² the moment the key
    is released and creeps to a stop rather than swinging past it */
const BRAKE_V = 14
/** the speed over which the machine stops turning on its pedals and starts
    turning on its bank. 14 (6.7 m/s) is deliberately low: while the pedal is
    still authoritative *and* the machine is banking, the two yaw sources add
    and the nose ends up well inside the velocity vector — which at full
    deflection is a flat spin that can never accelerate out of itself, because
    the thrust it is producing keeps being swung somewhere new. Handing the
    turn over early is what makes W+D a turn rather than a pirouette */
const BANK_V = 14
/** how much of the lateral velocity brake survives into forward flight. It
    cannot be blended away entirely: a coordinated turn has no sideslip, so a
    brake that is off in the turn has nothing to correct anyway, and one that
    is on damps the transient going in */
const BRAKE_KEEP = 0.35
/** spot-turn rate at the hover, rad/s. 1.1 is 63 deg/s — an R22's pedal
    authority almost exactly */
const PEDAL = 1.1
/** the divisor in the coordinated-turn law never drops below this, or the
    turn rate goes to infinity as the machine slows */
const YAW_VREF = 18
/** spin-up and spin-down, per second. Four seconds up, eight down */
const SPIN_UP = 1 / 4
const SPIN_DN = 1 / 8
/** 530 rpm = 8.83 rev/s = 55.5 rad/s, an R22's, and the number sfx.ts's blade
    slap is voiced against (two blades, so the slap is twice this) */
const OMEGA = 55.5
/** tail rotor turns 5.7x the main, which is why it whines and the main slaps */
const TAIL_RATIO = 5.7
/** the disc cones under load: 2.5 deg parked, 4.5 at full song */
const REST_CONE = 2.5 * DEG
const CONE_LIFT = 2.0 * DEG
/** the air thins from here and the machine simply runs out of lift at 150,
    which is where the fog turns the world into a featureless disc. Both are
    heights above the ground below, so a mountain is still climbable */
const CEIL = 120
const CEIL_FADE = 85
/** how hard the skids hold the ground, 1/s, and the speed under which they
    hold it absolutely — a parked machine must not creep by a millimetre */
const GRIP = 9
const GRIP_SNAP = 0.05
/** what the HUD's load bar reads against */
const TOP_SPEED = 78
/** the anti-collision beacon: one flash every 1.18 s */
const BEACON_W = 5.34

const SIZE = { halfX: 1.7, halfZ: 9.0, height: 5.9 }

/* ------------------------------------------------------- the cabin shell -- */

/**
 * One cross-section of the cabin.
 *
 * `hw`/`up`/`down` are the section's half-width and its reach above and below
 * its own centreline `y`; `nUp`/`nDown` are the superellipse exponents (2 is
 * an ellipse, 3 is the softened rectangle a cabin floor pan actually is).
 * `belly` is the half-width, in turns, of the *opaque* arc centred on the
 * section's lowest point — everything outside it is glazed. See the module
 * header: this one number is what lets a chin window turn into a door sill
 * and then into a roof, along one continuous surface.
 */
interface Sect {
  z: number
  y: number
  hw: number
  up: number
  down: number
  nUp: number
  nDown: number
  belly: number
}

/** the authored sections. `graded()` turns these into the ones actually
    skinned — read CABIN, not this, for anything about the built surface */
const SECTIONS: Sect[] = [
  { z: -6.50, y: 2.06, hw: 0.10, up: 0.10, down: 0.09, nUp: 2.0, nDown: 2.0, belly: 0.030 },
  { z: -6.05, y: 2.10, hw: 0.52, up: 0.48, down: 0.42, nUp: 2.1, nDown: 2.0, belly: 0.040 },
  { z: -5.35, y: 2.14, hw: 0.94, up: 0.86, down: 0.76, nUp: 2.2, nDown: 2.0, belly: 0.050 },
  { z: -4.40, y: 2.20, hw: 1.30, up: 1.16, down: 1.00, nUp: 2.4, nDown: 2.1, belly: 0.065 },
  { z: -3.20, y: 2.27, hw: 1.55, up: 1.38, down: 1.10, nUp: 2.6, nDown: 2.3, belly: 0.085 },
  { z: -1.80, y: 2.33, hw: 1.68, up: 1.52, down: 1.17, nUp: 2.9, nDown: 2.6, belly: 0.110 },
  { z: -0.40, y: 2.35, hw: 1.70, up: 1.55, down: 1.20, nUp: 3.0, nDown: 2.9, belly: 0.135 },
  { z: 0.30, y: 2.37, hw: 1.66, up: 1.50, down: 1.19, nUp: 3.0, nDown: 3.0, belly: 0.440 },
  { z: 1.20, y: 2.44, hw: 1.48, up: 1.34, down: 1.10, nUp: 3.0, nDown: 3.0, belly: 0.500 },
  { z: 2.10, y: 2.54, hw: 1.16, up: 1.06, down: 0.92, nUp: 2.8, nDown: 2.8, belly: 0.500 },
  { z: 2.80, y: 2.66, hw: 0.86, up: 0.80, down: 0.70, nUp: 2.6, nDown: 2.6, belly: 0.500 },
  { z: 3.40, y: 2.80, hw: 0.52, up: 0.50, down: 0.46, nUp: 2.3, nDown: 2.3, belly: 0.500 },
]

/** the most a section's opaque arc may grow in one bay of a ruled strip */
const BELLY_STEP = 0.08

/**
 * Fill in intermediate sections wherever `belly` steps further than that.
 *
 * A strip is *ruled*: column j of one row is joined straight to column j of
 * the next, and the columns are spread evenly over each row's own arc. So when
 * the arc changes size the columns slide around the section, and the straight
 * line between two of them chords across the inside of the body. At the door
 * post the authored `belly` steps 0.135 -> 0.44 in one 0.7-unit bay: the
 * shell's arc nearly quadruples, the glazing's collapses from 0.73 of a turn
 * to 0.12, and the outermost pair of columns ends up 110 degrees apart. At the
 * seat cushions' height the strip emitted across that bay ran 1.18 to 1.30
 * half-wide between two sections that are 1.56 and 1.52 there — a hollow a
 * third of a unit deep, running the length of the door shoulder. That is not a
 * cosmetic problem: it is the hole the seat cushions and the collective were
 * coming out through, and the same skew is what left back-facing vertex
 * normals on 2% of the shell, which reads as a hull lit from inside.
 *
 * Graded over four bays instead of one it costs three rows of 21 vertices and
 * the same stretch runs 1.50 to 1.53. The lesson generalises: the surface this
 * file has to keep its furniture inside is the one `skin()` emits, not the one
 * `sectPoint()` describes.
 */
const graded = (secs: Sect[]): Sect[] => {
  const out: Sect[] = [secs[0]]
  for (let i = 1; i < secs.length; i++) {
    const a = secs[i - 1]
    const b = secs[i]
    const bays = Math.max(1, Math.ceil(Math.abs(b.belly - a.belly) / BELLY_STEP))
    for (let k = 1; k < bays; k++) {
      const t = k / bays
      const mix = (u: number, v: number) => u + (v - u) * t
      out.push({
        z: mix(a.z, b.z),
        y: mix(a.y, b.y),
        hw: mix(a.hw, b.hw),
        up: mix(a.up, b.up),
        down: mix(a.down, b.down),
        nUp: mix(a.nUp, b.nUp),
        nDown: mix(a.nDown, b.nDown),
        belly: mix(a.belly, b.belly),
      })
    }
    out.push(b)
  }
  return out
}

const CABIN: Sect[] = graded(SECTIONS)

/* ------------------------------------------------------------- footprint --

   What a walker collides with, and the one place the difference between a
   footprint and a bounding box is not a detail: `SIZE` describes an 18.0 x 3.4
   rectangle, while the machine it wraps is a 9.9-unit cabin with a *stick*
   coming out of the back. Three quarters of that box was air. Worse, the
   machine is not centred in its own frame — the cabin runs from -6.5 and the
   boom ends at 10.4 — so the box hung two and a half units of nothing off the
   nose while cutting the tail off short.

   So: the cabin's own sections, then the boom's own radius, which is what
   walking round the tail of a helicopter should feel like.

   Two things are deliberately absent. The **skids** are 0.5 tall and stand
   outboard of the aft cabin, but a station profile has no hole in the middle
   of it — including them would block the walk-through space between them,
   which is a worse lie than clipping a tube at ankle height. The **tail
   rotor** hangs off the port side of the fin, and a symmetric profile wide
   enough to cover it would put the same 1.15 of nothing to starboard. The
   main disc needs nothing: it turns at 5.3, well over head height.          */
const BOOM_STATIONS = [4.6, 6.0, 7.4, 8.8, BOOM_Z1]

const HULL: HullStation[] = [
  ...SECTIONS.map((s) => ({ z: s.z, hw: s.hw, top: s.y + s.up })),
  ...BOOM_STATIONS.map((z) => ({ z, hw: boomR(z), top: boomY(z) + boomR(z) })),
]

/** where the aft door post is. The glazing runs from the nose to here and
    stops; found by z rather than by index because `graded()` inserts rows */
const POST_Z = 0.30
const GLAZED = CABIN.findIndex((s) => s.z >= POST_Z) + 1
/** ...and aft of the post the glazing's own arc carries on in paint, closing
    to a point at the section where `belly` reaches half a turn. That patch is
    the roof. Without it there is nothing at all over the crown between those
    two stations: the shell strip's first and last columns only meet once the
    arc is a whole turn, and `skin()` — which knows nothing about where a strip
    came from — has no wrap-around quad to join them before then. The hole was
    0.76 square units of open sky over the seat backs, two slots of it not even
    under the mast fairing, and it printed into the machine's own shadow */
const CROWN_END = CABIN.findIndex((s) => s.belly >= 0.5) + 1

/** a point on a section, at `t` turns round it: 0 is the right flank, 0.25
    the crown, 0.5 the left flank, 0.75 the keel */
const sectPoint = (s: Sect, t: number): [number, number] => {
  const a = t * TAU
  const c = Math.cos(a)
  const v = Math.sin(a)
  const e = 2 / (v >= 0 ? s.nUp : s.nDown)
  return [s.hw * spow(c, e), s.y + (v >= 0 ? s.up : s.down) * spow(v, e)]
}

/**
 * Skin an open strip across a run of sections: one row per section, `cols`
 * columns spread evenly over that section's own [t0, t1] arc.
 *
 * The arc is per-row, which is the entire reason this exists instead of
 * `loft()`. Two strips whose ranges are complements of each other tile the
 * body exactly, and the boundary between them can wander from the keel to the
 * roof along the length without either surface knowing about the other.
 *
 * It emits exactly the strip it is handed and nothing else. In particular a
 * row whose arc happens to be a whole turn puts its first and last columns on
 * the same *point* but not on the same *vertex*, and there is no wrap-around
 * quad joining them: a strip is open by definition and a strip that closes for
 * some of its rows and not others has no honest wrap to emit. Closing a body
 * is therefore the caller's job — here it is the complement strip that runs
 * from the door post to `CROWN_END`. Adding the wrap here instead would have
 * roofed over the door windows, because the shell strip is short of a whole
 * turn along the entire cabin forward of the post.
 *
 * Winding is loft()'s, and wrong for the same reason it was wrong there. Rows
 * run counter-clockwise in the section plane and stations advance along +z, so
 * the obvious triple — prev_j, cur_j, cur_j+1 — has a normal of AB x AC =
 * (0,0,dz) x (dx,dy,dz) = (-dz·dy, dz·dx, 0), which points at the section's
 * own centreline rather than away from it. This strip carried that bug for a
 * while, and it is the worst kind to carry: an open strip has no end caps to
 * visibly disagree with it, so nothing looked broken — the cabin shell and the
 * canopy simply drew from the inside, back-faced under a FrontSide material
 * and lit by normals pointing into the hull, while the BoxGeometry parts
 * merged into the same 'paint' mesh stayed outward. A mixed-orientation mesh
 * is the proof; the reveal is that a hull lit from within reads as bad shading
 * rather than as a winding error, so nobody goes looking for the index order.
 * Both triples are reversed below, which is the whole fix; there are no caps
 * here to leave alone, and computeVertexNormals follows the index order.
 */
const skin = (
  secs: Sect[],
  t0: (s: Sect) => number,
  t1: (s: Sect) => number,
  cols: number,
) => {
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i]
    const a = t0(s)
    const b = t1(s)
    const base = pos.length / 3
    for (let j = 0; j < cols; j++) {
      const [x, y] = sectPoint(s, a + ((b - a) * j) / (cols - 1))
      pos.push(x, y, s.z)
    }
    if (i > 0) {
      const prev = base - cols
      for (let j = 0; j < cols - 1; j++) {
        idx.push(prev + j, base + j + 1, base + j, prev + j, prev + j + 1, base + j + 1)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** a tube run along one parametric line of the sections — the door sill and
    windscreen frame, which is what stops the glazing looking like a decal */
const sectEdge = (secs: Sect[], t: (s: Sect) => number, r: number) =>
  tube(
    secs.map((s) => {
      const [x, y] = sectPoint(s, t(s))
      return new THREE.Vector3(x, y, s.z)
    }),
    r,
    6,
  )

/** a plain box. 24 vertices, and nobody ever sees the arris on a rudder pedal */
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d)

/* ---------------------------------------------------------------- model -- */

interface HeliModel {
  root: THREE.Group
  /** spins about y */
  rotor: THREE.Group
  /** one node per blade so the disc can cone under load */
  blades: THREE.Group[]
  /** spins about x — the disc is vertical and hangs off the left of the fin */
  tailRotor: THREE.Group
  /** the pilot, hidden until somebody climbs in */
  pilot: THREE.Group
  beaconMat: THREE.MeshStandardMaterial
  navMats: THREE.MeshStandardMaterial[]
  glowMat: THREE.MeshStandardMaterial
  owned: THREE.Material[]
}

const buildModel = (mats: VehicleMaterials): HeliModel => {
  const slots = mats.slots
  const owned: THREE.Material[] = []
  /*
    Five little emissive materials of our own, cloned off the shared lamp so
    they keep its env map and its glass-ish base. They cannot be the shared
    lamp slots: those are the fleet's headlamps and tail lamps, and pulsing a
    beacon through them would strobe the car parked two hundred units away.
  */
  const lit = (base: string, glow: string, i = 0.6) => {
    const m = (slots.lamp as THREE.MeshStandardMaterial).clone()
    m.color.set(base)
    m.emissive = new THREE.Color(glow)
    m.emissiveIntensity = i
    owned.push(m)
    return m
  }
  const navPort = lit('#3a0d0c', '#ff2a18')
  const navStbd = lit('#0c3a18', '#25ff6a')
  const navWhite = lit('#d8dee6', '#fff4e2')
  const glowMat = lit('#0e1216', '#79e0a8', 0.25)
  const beaconMat = lit('#3a0d0c', '#ff3520', 0.2)

  const root = new THREE.Group()
  root.name = 'heli'

  /* ------------------------------------------------------------- body -- */

  const b = createPartBuilder()

  // The shell, the glazing and the roof are three strips over the same
  // sections. sillR/sillL are the two edges of the opaque belly arc, starboard
  // and port; the shell runs between them under the keel, and the other two
  // run between them the long way round — glass as far as the door post, paint
  // from there to where the arc closes over the crown.
  const sillR = (s: Sect) => 0.75 + s.belly
  const sillL = (s: Sect) => 1.75 - s.belly
  b.add(skin(CABIN, (s) => 0.75 - s.belly, sillR, 21), 'paint')
  b.add(skin(CABIN.slice(GLAZED - 1, CROWN_END), sillR, sillL, 21), 'paint')
  const glazed = CABIN.slice(0, GLAZED)
  b.add(skin(glazed, sillR, sillL, 21), 'glass')
  // the sill/windscreen frame down the boundary, and the aft door post
  b.both(() => {
    b.add(sectEdge(glazed, sillR, 0.055), 'metal')
  })
  // ...and it is authored on one flank only, so it has to be mirrored like the
  // sill above it. The arc runs t 1.19 -> 0.81, which is entirely x > 0: left
  // to itself the machine has a door frame on the right and an open hole on
  // the left. That asymmetry survived an x-symmetry check on the model's
  // bounding box, because the post reaches 1.703 against a body already 1.700
  // wide — a bbox cannot see a missing part that fits inside it
  b.both(() => {
    const post = CABIN[GLAZED - 1]
    const arc: THREE.Vector3[] = []
    for (let i = 0; i <= 6; i++) {
      const [x, y] = sectPoint(post, 0.75 + post.belly + ((0.5 - post.belly * 2) * i) / 6)
      arc.push(new THREE.Vector3(x, y, post.z))
    }
    b.add(tube(arc, 0.05, 6), 'metal')
  })

  // tail boom: a tapering tube of circular sections, capped where the fin
  // structure closes it off
  {
    const zs = [BOOM_Z0, 3.6, 5.0, 6.5, 8.0, 9.4, BOOM_Z1]
    b.add(
      loft(
        zs.map((z) => ({
          z,
          y: boomY(z),
          ring: ringSuper(boomR(z), boomR(z), boomR(z), 2, 2, 14),
        })),
        { capEnd: 'flat' },
      ),
      'paint',
    )
    // the driveshaft cover along the spine
    b.add(
      loft(
        [3.0, 5.2, 7.4, 9.6].map((z) => ({
          z,
          y: boomY(z) + boomR(z) * 0.78,
          ring: ringSuper(0.17, 0.12, 0.14, 2.6, 2.0, 10),
        })),
        { capStart: 'flat', capEnd: 'flat' },
      ),
      'metal',
    )
  }

  // fin, ventral fin and horizontal stabiliser. blade() runs out along +x, so
  // a quarter turn about z stands it up without touching the chord axis — and
  // its `root`/`tip` are *half* chords, so a 0.6 root is a 1.2-unit chord
  b.add(
    blade(1.7, { root: 0.6, tip: 0.38, thick: 0.12, sweep: 0.4, roundTip: true, steps: 5 }),
    'paint2',
    at(-0.04, 3.3, 10.76, 0, 0, Math.PI / 2),
  )
  b.add(
    blade(0.62, { root: 0.4, tip: 0.26, thick: 0.13, sweep: 0.16, roundTip: true, steps: 3 }),
    'paint2',
    at(-0.04, 3.16, 10.5, 0, 0, -Math.PI / 2),
  )
  b.both(() => {
    b.add(
      blade(1.45, { root: 0.42, tip: 0.31, thick: 0.14, roundTip: true, steps: 4 }),
      'paint2',
      at(0.16, 3.3, 8.6, 0.08),
    )
  })

  // tail gearbox: a drum lying along x (revolve's axis is y, so -90 about z
  // lays it over), plus the pylon that hangs it off the fin
  b.add(
    revolve(
      [[0.0, -0.32], [0.2, -0.34], [0.25, -0.12], [0.25, 0.16], [0.17, 0.3], [0.0, 0.3]],
      10,
    ),
    'metal',
    at(-0.66, TR_Y, TR_Z, 0, 0, -Math.PI / 2),
  )
  b.add(box(0.5, 0.72, 0.46), 'paint2', at(-0.3, 3.68, 10.48))

  // engine bay: a cowl over the aft deck, a cooling grille either side, an
  // exhaust stub out to starboard, and the two side fuel tanks
  b.add(
    loft(
      [
        { z: 0.6, ring: ringSuper(1.14, 0.6, 0.54, 3, 3, 14) },
        { z: 1.5, ring: ringSuper(1.2, 0.68, 0.6, 3, 3, 14) },
        { z: 2.4, ring: ringSuper(0.98, 0.56, 0.5, 3, 3, 14) },
        { z: 2.95, ring: ringSuper(0.66, 0.38, 0.36, 2.6, 2.6, 14) },
      ],
      { capStart: 'flat', capEnd: 'flat' },
    ),
    'trim',
    at(0, 3.24, 0),
  )
  b.both(() => {
    // the cooling louvre. It used to sit at x 1.16 amidships, which is inside
    // the tank fairing below — all 24 of its vertices buried, 48 that could
    // never render. The only stretch of cowl flank the tanks do not cover is
    // aft of their cap at z 2.3, and the cowl is tapering hard there, so the
    // panel is yawed to lie along the taper and stood a couple of hundredths
    // proud rather than let the corners sink back inside
    b.add(box(0.05, 0.34, 0.5), 'dark', at(0.823, 3.24, 2.669, 0, -0.527, 0))
    b.add(
      loft(
        [
          { z: -0.2, ring: ringSuper(0.3, 0.36, 0.36, 2.4, 2.4, 12) },
          { z: 0.6, ring: ringSuper(0.44, 0.52, 0.52, 2.6, 2.6, 12) },
          { z: 1.6, ring: ringSuper(0.44, 0.52, 0.52, 2.6, 2.6, 12) },
          { z: 2.3, ring: ringSuper(0.26, 0.32, 0.32, 2.4, 2.4, 12) },
        ],
        { capStart: 'flat', capEnd: 'flat' },
      ),
      'paint2',
      at(1.22, 3.26, 0),
    )
  })
  b.add(
    tube(
      [
        new THREE.Vector3(0.5, 2.86, 2.1),
        new THREE.Vector3(0.78, 2.8, 2.7),
        new THREE.Vector3(0.96, 2.74, 3.3),
      ],
      0.14,
      8,
      { caps: true },
    ),
    'chrome',
  )

  // the mast, its fairing where it leaves the roof, the stationary half of
  // the swashplate and the control rods that run down into the roof
  b.add(box(0.72, 0.34, 1.0), 'paint', at(0, 3.9, MAST_Z))
  b.add(revolve([[0.16, 0], [0.15, 0.34], [0.13, 1.12], [0.13, 1.4]], 12), 'chrome', at(0, 3.9, MAST_Z))
  b.add(
    revolve([[0.28, 0], [0.46, -0.02], [0.47, 0.06], [0.29, 0.08]], 14),
    'metal',
    at(0, 4.5, MAST_Z),
  )
  b.both(() => {
    b.add(
      tube(
        [new THREE.Vector3(0.34, 4.48, MAST_Z + 0.22), new THREE.Vector3(0.29, 3.9, MAST_Z + 0.1)],
        0.04,
        6,
      ),
      'chrome',
    )
  })

  // skids: an L of tube per side, two arched cross members up into the belly,
  // a step plate at each door and a wear shoe under each contact patch
  b.both(() => {
    b.add(
      tube(
        [
          new THREE.Vector3(SKID_X, 0.62, -3.2),
          new THREE.Vector3(SKID_X, 0.4, -2.92),
          new THREE.Vector3(SKID_X, 0.16, -2.72),
          new THREE.Vector3(SKID_X, 0.11, SKID_Z0),
          new THREE.Vector3(SKID_X, 0.11, -0.6),
          new THREE.Vector3(SKID_X, 0.11, 1.4),
          new THREE.Vector3(SKID_X, 0.11, 2.7),
          new THREE.Vector3(SKID_X, 0.11, SKID_Z1),
        ],
        0.11,
        8,
        { caps: true },
      ),
      'metal',
    )
    b.add(box(0.5, 0.07, 0.95), 'metal', at(SKID_X, 0.26, -0.9))
    b.add(box(0.26, 0.07, 0.7), 'rubber', at(SKID_X, 0.045, -1.4))
    b.add(box(0.26, 0.07, 0.7), 'rubber', at(SKID_X, 0.045, 1.9))
  })
  for (const z of [-1.4, 1.9]) {
    b.add(
      tube(
        [
          new THREE.Vector3(-SKID_X, 0.11, z),
          new THREE.Vector3(-1.12, 0.72, z * 0.94),
          new THREE.Vector3(-0.5, 1.16, z * 0.88),
          new THREE.Vector3(0.5, 1.16, z * 0.88),
          new THREE.Vector3(1.12, 0.72, z * 0.94),
          new THREE.Vector3(SKID_X, 0.11, z),
        ],
        0.09,
        8,
      ),
      'metal',
    )
  }

  /*
    The interior, all of it visible through that canopy and therefore worth the
    vertices: floor pan, console, panel, dials, seats, the R22's T-bar cyclic,
    the collective at the pilot's left hand, and four pedals.

    Every one of them has to be measured against the *built* surface, and the
    difference is enormous down here. CABIN's lower halves are near-elliptical
    (nDown 2.0-3.0 over a 1.1-1.2 reach), so the last two tenths of a unit
    above the keel is a narrow V: the body is 3.4 wide at the shoulder, 1.65 to
    1.97 wide along the floor pan's underside, and pinched to nothing a tenth
    below it. The floor pan was a 2.9-wide, 3.9-long slab at y = 1.2 — twice the
    width the hull has there, and its underside below the keel line along the
    whole length, so a black plank stuck out of both flanks and read, from
    every angle, as geometry driven through the fuselage.

    So: the pan is 1.56 wide and rides at 1.27-1.35, which is where the section
    first opens out enough to carry a floor, and it reaches z -2.68 so that all
    four pedals stand on it rather than off the front of it. The console is
    seated into the pan (1.31 is inside the pan's own slab) instead of hanging
    0.02 through its underside. And the seat cushions are 0.96 wide on centres
    of 0.74 — which is a real R22's 0.46 m seat — where at 1.16 on 0.80 they
    reached x 1.38 against a built skin that is 1.46 at its narrowest: fine
    against the *section*, but the strip that was actually emitted necked in to
    1.18, and 212 rays from an ordinary chase angle found upholstery in front
    of the paint. Grading the sections (see `graded`) is what gave that width
    back; the cushions came in as well, because a tenth of clearance on a part
    this visible is not a margin, and because the collective has to get past
    their outboard edge to reach the pilot's hand.
  */
  b.add(box(1.56, 0.08, 2.88), 'trim', at(0, 1.31, -1.24))
  b.add(box(0.5, 0.56, 1.3), 'trim', at(0, 1.59, -0.45))
  b.add(slab(1.9, 0.85, 0.16, 0.07), 'trim', at(0, 2.25, -2.85, -0.22))
  for (const x of [-1.12, -0.56, 0.56, 1.12]) {
    b.add(revolve([[0.14, 0], [0.14, 0.02]], 10), 'dark', at(x, 2.3, -2.78, Math.PI / 2 - 0.22))
  }
  b.both(() => {
    b.add(box(0.96, 0.18, 1.1), 'seat', at(0.74, 1.68, -0.3))
    b.add(box(0.96, 1.25, 0.16), 'seat', at(0.74, 2.32, 0.32, -0.12))
    // the pedals live in the footwell, where the section is at its narrowest:
    // the outer one used to stand at x = 1.08 against a skin half-width of
    // 0.99, so it came through the chin glazing — the one surface on this
    // machine that is transparent, and therefore the one place a part poking
    // out of the floor is guaranteed to be seen. They are inside the hull now
    // and inside the pan too: the outer pair used to overhang its edge by 0.17
    b.add(box(0.26, 0.06, 0.32), 'dark', at(0.32, 1.4, -2.5, -0.3))
    b.add(box(0.26, 0.06, 0.32), 'dark', at(0.64, 1.4, -2.5, -0.3))
  })
  b.add(
    tube(
      [
        new THREE.Vector3(0, 1.42, -0.5),
        new THREE.Vector3(0, 1.78, -0.72),
        new THREE.Vector3(0, 2.04, -0.9),
      ],
      0.055,
      6,
    ),
    'dark',
  )
  b.add(
    tube([new THREE.Vector3(-0.86, 2.04, -0.9), new THREE.Vector3(0.86, 2.04, -0.9)], 0.05, 6),
    'dark',
  )
  // the collective, pivoting off the floor at the pilot's left hip and raked
  // forward to the grip. Its foot ran out to x = -1.42 against a half-width of
  // 1.07 at that height, i.e. through the door glazing; it starts inboard and
  // a little higher now, on the pan rather than under it. Pulling it in was
  // only half the story: every one of its 224 vertices then tested inside with
  // 0.006 to spare while the tube's mid-span still stood 0.042 proud of the
  // shell, because the shell was the necked-in strip and the breach was
  // between path points, where the lever has no vertex to test. Grading the
  // sections is what actually made it fit
  b.add(
    tube(
      [
        new THREE.Vector3(-1.16, 1.46, 0.4),
        new THREE.Vector3(-1.24, 1.63, -0.1),
        new THREE.Vector3(-1.3, 1.74, -0.56),
      ],
      0.055,
      6,
    ),
    'dark',
  )

  // the landing light lives on the keel strip under the chin bubble, where
  // there is opaque skin to mount it to
  b.add(revolve([[0.17, 0], [0.17, 0.05]], 10), 'lamp', at(0, 1.42, -5.2, Math.PI / 2 + 0.5))

  const body = b.build(slots, { name: 'body' })
  root.add(body)

  /* ------------------------------------------------------------ lights -- */

  const lens = () => revolve([[0.03, 0], [0.1, 0.06], [0.11, 0.15], [0.04, 0.2]], 8)
  const oneOff = (geo: THREE.BufferGeometry, m: THREE.Material, mat: THREE.Matrix4) => {
    const pb = createPartBuilder()
    pb.add(geo, 'lamp', mat)
    const g = pb.build({ lamp: m }, { cast: false })
    root.add(g)
    return g
  }
  oneOff(lens(), navPort, at(-1.64, 2.3, -1.8, 0, 0, Math.PI / 2))
  oneOff(lens(), navStbd, at(1.64, 2.3, -1.8, 0, 0, -Math.PI / 2))
  // the white tail light shines *aft*, and has to sit aft of the fin to do it.
  // lens() grows along +y, so +90 about x lays it down the +z axis and -90 aims
  // it at the nose; with the wrong sign it was also 0.2 deep inside the fin,
  // whose chord at this height spans z 10.57..11.48 — a lamp buried in the
  // structure it is mounted on, pointing at the cabin
  oneOff(lens(), navWhite, at(-0.04, 4.42, 11.5, Math.PI / 2))
  // the instrument faces, which the day cycle lights after dusk
  {
    const pb = createPartBuilder()
    for (const x of [-1.12, -0.56, 0.56, 1.12]) {
      pb.add(
        revolve([[0.115, 0], [0.115, 0.01]], 10),
        'lamp',
        at(x, 2.3, -2.755, Math.PI / 2 - 0.22),
      )
    }
    root.add(pb.build({ lamp: glowMat }, { cast: false }))
  }
  // ...and the anti-collision beacon on the fin, pulsed from update()
  const beaconGroup = oneOff(
    revolve([[0.02, 0], [0.11, 0.05], [0.13, 0.14], [0.06, 0.2]], 10),
    beaconMat,
    at(-0.06, 4.98, 11.0),
  )
  beaconGroup.name = 'beacon'

  /* ------------------------------------------------------------- rotor -- */

  const rotor = new THREE.Group()
  rotor.position.set(0, HUB_Y, MAST_Z)
  root.add(rotor)
  {
    const h = createPartBuilder()
    h.add(
      revolve(
        [[0.11, -0.3], [0.27, -0.26], [0.32, -0.08], [0.32, 0.12], [0.24, 0.22], [0.09, 0.28]],
        14,
      ),
      'metal',
    )
    h.add(revolve([[0.09, 0.28], [0.1, 0.32], [0.05, 0.34]], 10), 'chrome')
    // the rotating half of the swashplate, and a pitch link up to each grip
    h.add(revolve([[0.3, -0.72], [0.44, -0.74], [0.45, -0.66], [0.31, -0.64]], 14), 'metal')
    h.both(() => {
      h.add(box(0.44, 0.24, 0.46), 'metal', at(0.42, 0, 0))
      h.add(
        tube(
          [new THREE.Vector3(0.4, -0.68, 0.3), new THREE.Vector3(0.37, -0.04, 0.28)],
          0.035,
          6,
        ),
        'chrome',
      )
    })
    rotor.add(h.build(slots, { name: 'head' }))
  }

  const bladeBuilder = createPartBuilder()
  bladeBuilder.add(
    blade(ROTOR_R - 0.42, {
      root: 0.24,
      tip: 0.2,
      thick: 0.16,
      twist: 0.05,
      roundTip: true,
      steps: 8,
    }),
    'metal',
    at(0.42, 0, 0),
  )
  bladeBuilder.add(box(0.32, 0.05, 0.36), 'paint2', at(7.36, 0, 0))
  const bladeA = bladeBuilder.build(slots, { name: 'blade' })
  const bladeB = bladeA.clone()
  bladeB.rotation.y = Math.PI
  rotor.add(bladeA, bladeB)

  /* -------------------------------------------------------- tail rotor -- */

  const tailRotor = new THREE.Group()
  tailRotor.position.set(TR_X, TR_Y, TR_Z)
  root.add(tailRotor)
  {
    const t = createPartBuilder()
    t.add(revolve([[0.14, -0.1], [0.18, -0.06], [0.18, 0.06], [0.14, 0.1]], 10), 'metal', at(0, 0, 0, 0, 0, -Math.PI / 2))
    const tb = blade(TR_R, { root: 0.16, tip: 0.13, thick: 0.16, twist: 0.12, roundTip: true, steps: 4 })
    t.add(tb, 'metal', at(0, 0, 0, 0, 0, Math.PI / 2))
    t.add(tb, 'metal', at(0, 0, 0, 0, 0, -Math.PI / 2))
    tailRotor.add(t.build(slots, { name: 'tailBlades' }))
  }

  /* ------------------------------------------------------------- pilot -- */

  const pilot = new THREE.Group()
  pilot.name = 'pilot'
  pilot.position.set(-0.8, 0, 0)
  pilot.visible = false
  root.add(pilot)
  {
    const p = createPartBuilder()
    p.add(box(0.62, 0.36, 0.52), 'seat', at(0, 1.92, 0.06))
    p.add(slab(0.74, 0.98, 0.5, 0.16), 'seat', at(0, 2.5, -0.02, -0.1))
    p.add(revolve([[0.06, -0.3], [0.24, -0.2], [0.28, 0.02], [0.22, 0.2], [0.06, 0.3]], 10), 'trim', at(0, 2.98, -0.06))
    p.both(() => {
      p.add(
        tube(
          [
            new THREE.Vector3(0.36, 2.66, -0.04),
            new THREE.Vector3(0.44, 2.28, -0.36),
            new THREE.Vector3(0.3, 2.06, -0.86),
          ],
          0.13,
          6,
        ),
        'seat',
      )
      p.add(
        tube(
          [
            new THREE.Vector3(0.2, 1.9, -0.12),
            new THREE.Vector3(0.23, 1.82, -0.98),
            new THREE.Vector3(0.25, 1.72, -1.36),
          ],
          0.17,
          6,
        ),
        'trim',
      )
      // the shins run forward almost flat rather than down: the cabin's lower
      // body is a V, and at the old ankle (x 1.06, y 1.24) the hull is barely
      // a unit wide, so both feet hung out through the belly — the outboard
      // one by 0.19. The floor they rest on now is the pan's top at 1.35
      p.add(
        tube(
          [
            new THREE.Vector3(0.25, 1.72, -1.36),
            new THREE.Vector3(0.24, 1.62, -1.74),
            new THREE.Vector3(0.23, 1.52, -2.1),
          ],
          0.14,
          6,
        ),
        'trim',
      )
    })
    pilot.add(p.build(slots, { name: 'crew' }))
  }

  markDynamic(root)
  return {
    root,
    rotor,
    blades: [bladeA, bladeB],
    tailRotor,
    pilot,
    beaconMat,
    navMats: [navPort, navStbd, navWhite],
    glowMat,
    owned,
  }
}

/* -------------------------------------------------------------- the sim -- */

/** the four skid contact patches, in model space */
const PROBES: Array<[number, number]> = [
  [-SKID_X, SKID_Z0],
  [SKID_X, SKID_Z0],
  [SKID_X, SKID_Z1],
  [-SKID_X, SKID_Z1],
]

export function buildHeli(opts: { mats: VehicleMaterials }): Vehicle {
  const model = buildModel(opts.mats)
  const root = model.root
  const pos = root.position

  let yaw = 0
  let pitch = 0
  let roll = 0
  const vel = new THREE.Vector3()
  /** 0..1 of governed rotor speed. Everything about how this machine feels is
      downstream of this number */
  let spin = 0
  let running = false
  let rotorAngle = 0
  let tailAngle = 0
  let landed = true
  /** the height the governor holds when the collective is centred */
  let holdY = 0
  /** a private cosmetic clock for the beacon; not world state */
  let clock = 0
  let day = 1
  let night = 0

  const solid = noStand(new THREE.Box3()) as Solid
  const up = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  const push = new THREE.Vector3()

  const step: DriveStep = {
    speed: 0,
    planar: 0,
    load: 0,
    rpm: 0,
    gear: 0,
    grounded: true,
    vy: 0,
    altitude: 0,
    slip: 0,
    braking: 0,
    surface: 'grass',
    impact: 0,
    moved: false,
  }

  /** the surface under the skids: the highest of the four contact patches, so
      a machine parked across a slope rests on its uphill skid rather than
      sinking a corner into the hill. Water counts — see the header */
  const restUnder = (env: DriveEnv) => {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    let top = -Infinity
    for (const [lx, lz] of PROBES) {
      const g = groundUnder(pos.x + lx * c + lz * s, pos.z - lx * s + lz * c, pos.y + 0.7, env)
      if (g > top) top = g
    }
    if (env.waterY !== undefined && top < env.waterY) top = env.waterY + env.waveAt(pos.x, pos.z)
    return top
  }

  const fitSolid = () => {
    const c = Math.abs(Math.cos(yaw))
    const s = Math.abs(Math.sin(yaw))
    const ex = SIZE.halfX * c + SIZE.halfZ * s
    const ez = SIZE.halfX * s + SIZE.halfZ * c
    solid.min.set(pos.x - ex, pos.y - 0.2, pos.z - ez)
    solid.max.set(pos.x + ex, pos.y + 3.1, pos.z + ez)
  }

  const writeTransform = () => {
    root.rotation.set(pitch, yaw, roll, 'YXZ')
    model.rotor.rotation.y = rotorAngle
    model.tailRotor.rotation.x = tailAngle
    const cone = REST_CONE + spin * spin * CONE_LIFT
    model.blades[0].rotation.z = cone
    model.blades[1].rotation.z = cone
  }

  const update = (env: DriveEnv, driven: boolean): DriveStep => {
    const dt = env.dt
    clock += dt
    const k = axes(env.keys, env.frozen || !driven)

    // the rotor. Linear ramps, because "four seconds" is a promise the ear
    // checks: sfx.ts sweeps its blade slap straight off this number
    const want = running ? 1 : 0
    spin =
      want > spin ? Math.min(want, spin + dt * SPIN_UP) : Math.max(want, spin - dt * SPIN_DN)
    rotorAngle = (rotorAngle + OMEGA * spin * dt) % TAU
    tailAngle = (tailAngle + OMEGA * TAIL_RATIO * spin * dt) % TAU

    const rest = restUnder(env)
    const agl = pos.y - rest

    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    // yaw 0 faces -z, so forward is (-s, -c) and right is (c, -s)
    const vFwd = vel.x * -s + vel.z * -c
    const vRight = vel.x * c + vel.z * -s
    const planar = Math.hypot(vel.x, vel.z)

    /* ------------------------------------------------------- attitude -- */

    // how much of a bank this speed earns. At walking pace, none at all: a
    // machine that leans when you tap a key drifts off the landing spot
    const bankK = clamp((planar - 3) / BANK_V, 0, 1)
    let pitchWant: number
    let rollWant: number
    if (landed) {
      // settle onto whatever the ground is doing: solve the attitude whose own
      // up vector is the ground normal, so the skids lie on the slope
      groundNormal(pos.x, pos.z, env, nrm)
      const nRight = nrm.x * c + nrm.z * -s
      const nAft = nrm.x * s + nrm.z * c
      rollWant = -Math.asin(clamp(nRight, -0.6, 0.6))
      pitchWant = Math.asin(clamp(nAft / Math.max(0.4, Math.cos(rollWant)), -0.6, 0.6))
    } else {
      // centred cyclic is a velocity brake, not an attitude hold: nose up in
      // proportion to the speed it is trying to kill, fading out as it dies
      const brakeP = clamp(vFwd / BRAKE_V, -0.75, 0.75) * MAX_PITCH
      const brakeR = clamp(vRight / BRAKE_V, -0.75, 0.75) * MAX_BANK
      pitchWant = k.fwd !== 0 ? -k.fwd * MAX_PITCH : brakeP
      rollWant =
        -k.side * MAX_BANK * bankK +
        brakeR * (k.side !== 0 ? 1 - (1 - BRAKE_KEEP) * bankK : 1)
    }
    pitch = damp(pitch, clamp(pitchWant, -MAX_PITCH, MAX_PITCH), ATT_RATE, dt)
    roll = damp(roll, clamp(rollWant, -MAX_BANK, MAX_BANK), ATT_RATE, dt)

    /* --------------------------------------------------------- thrust -- */

    // Shift leans the disc past the airframe; that is the entire boost
    const lead = k.fwd !== 0 ? -k.fwd * k.boost * DISC_LEAD : 0
    const discP = clamp(pitch + lead, -MAX_PITCH - DISC_LEAD, MAX_PITCH + DISC_LEAD)
    const cr = Math.cos(roll)
    const sr = Math.sin(roll)
    const cp = Math.cos(discP)
    const sp = Math.sin(discP)
    // the disc normal in body axes (x right, y up, z aft)
    up.set(-sr, cp * cr, sp * cr)

    // the vertical channel: a rate command, held at the last height when the
    // collective is centred, and cushioned near the ground
    let wantVy = k.up ? (k.boost ? CLIMB_BOOST : CLIMB) : k.down ? -(k.boost ? SINK_BOOST : SINK) : 0
    if (!k.up && !k.down) {
      wantVy =
        agl < LAND_H
          ? -(GE_TOUCH + agl * 0.45)
          : clamp((holdY - pos.y) * HOLD_GAIN, -HOLD_CLAMP, HOLD_CLAMP)
    } else {
      holdY = pos.y
    }
    if (agl < GE_H) {
      const punch = k.down ? (k.boost ? GE_PUSH_HARD : GE_PUSH) : 1
      const soft = -(GE_TOUCH + Math.max(0, agl) * GE_SLOPE) * punch
      if (wantVy < soft) wantVy = soft
    }

    const dragK = DRAG_LIN + DRAG_QUAD * vel.length()
    // the governor cancels the drag it is about to suffer, so a commanded
    // 11 u/s climb is 11 u/s and not 10.3
    const servo = clamp((wantVy - vel.y) * VERT_GAIN + dragK * vel.y, VERT_MIN, VERT_MAX)
    // thin air above the ceiling: the cap falls off, the demand does not, so
    // the machine stops climbing instead of hitting an invisible lid
    const rho = clamp(1 - Math.max(0, agl - CEIL) / CEIL_FADE, 0.2, 1)
    const thrust = Math.min((G + servo) / Math.max(0.35, up.y), TW * G * spin * spin * rho)

    // body up -> world: x is right (c, -s), z is aft (s, c)
    const wx = up.x * c + up.z * s
    const wz = -up.x * s + up.z * c
    vel.x += (thrust * wx - dragK * vel.x) * dt
    vel.y += (thrust * up.y - G - dragK * vel.y) * dt
    vel.z += (thrust * wz - dragK * vel.z) * dt

    /* ------------------------------------------------------------ yaw -- */

    // pedal below BANK_V, coordinated turn above it. The coordinated term is
    // the lateral acceleration the bank is already producing divided by the
    // speed, which is the definition of a turn with the ball in the middle
    const pedal = -k.side * PEDAL * (1 - bankK) * (landed ? 0.55 : 1)
    const coord = landed ? 0 : (-thrust * up.x) / Math.max(planar, YAW_VREF)
    yaw += (pedal + coord) * dt

    /* -------------------------------------------------------- contact -- */

    if (landed) {
      // skids on the ground: bleed the sideways push, and snap the last of it
      // to nothing so a parked machine does not creep a millimetre a minute
      const f = Math.exp(-GRIP * dt)
      vel.x = Math.abs(vel.x) < GRIP_SNAP ? 0 : vel.x * f
      vel.z = Math.abs(vel.z) < GRIP_SNAP ? 0 : vel.z * f
      if (vel.y < 0) vel.y = 0
    }

    pos.x += vel.x * dt
    pos.y += vel.y * dt
    pos.z += vel.z * dt

    let impact = 0
    if (pos.y <= rest) {
      if (!landed) impact = Math.max(0, -vel.y)
      pos.y = rest
      if (vel.y < 0) vel.y = 0
      landed = true
      holdY = rest
    } else if (pos.y > rest + 0.06) {
      landed = false
    }

    // the fuselage sweeps the world; the disc does not. See the header
    const hit = sweepBody(pos, yaw, SIZE.halfX, SIZE.halfZ, pos.y + 0.15, pos.y + 4.6, env.collision)
    if (hit.depth > 0) {
      push.copy(hit.push)
      pos.x += push.x
      pos.z += push.z
      const len = Math.hypot(push.x, push.z)
      if (len > 1e-6) {
        const nx = push.x / len
        const nz = push.z / len
        const into = vel.x * nx + vel.z * nz
        if (into < 0) {
          impact = Math.max(impact, -into)
          vel.x -= nx * into
          vel.z -= nz * into
        }
      }
    }

    writeTransform()
    fitSolid()

    // the beacon is cosmetic, so it may ride the frame clock: sin to the sixth
    // is a flash with a long dark gap, which is what a strobe looks like
    const beat = Math.max(0, Math.sin(clock * BEACON_W))
    const flash = beat * beat * beat * beat * beat * beat
    model.beaconMat.emissiveIntensity =
      0.08 + night * 0.18 + flash * (1.5 + day * 1.4 + night * 2.2) * (0.25 + 0.75 * spin)

    const planar2 = Math.hypot(vel.x, vel.z)
    step.speed = vel.x * -Math.sin(yaw) + vel.z * -Math.cos(yaw)
    step.planar = planar2
    step.load = clamp(planar2 / TOP_SPEED, 0, 1)
    step.rpm = spin
    step.gear = 0
    step.grounded = landed
    step.vy = vel.y
    step.altitude = Math.max(0, pos.y - rest)
    step.slip = clamp(Math.abs(vRight) / Math.max(planar2, 1), 0, 1)
    step.braking = k.fwd < 0 && vFwd > 1 ? clamp(vFwd / 20, 0, 1) : 0
    step.surface = env.surfaceAt(pos.x, pos.z)
    step.impact = impact
    step.moved = planar2 > 0.02 || Math.abs(vel.y) > 0.02
    return step
  }

  const placeAt = (x: number, z: number, hdg: number, env: DriveEnv) => {
    pos.set(x, env.groundAt(x, z), z)
    yaw = hdg
    vel.set(0, 0, 0)
    spin = 0
    running = false
    rotorAngle = 0
    tailAngle = 0
    pitch = 0
    roll = 0
    pos.y = restUnder(env)
    holdY = pos.y
    landed = true
    model.pilot.visible = false
    writeTransform()
    fitSolid()
  }

  const exitSpot = (out: THREE.Vector3, env: DriveEnv) => {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    // out from under the door, on either side, then a step further out
    for (const lx of [-(SIZE.halfX + 1.9), SIZE.halfX + 1.9, -(SIZE.halfX + 3.4), SIZE.halfX + 3.4]) {
      const wx = pos.x + lx * c
      const wz = pos.z - lx * s
      const g = groundUnder(wx, wz, pos.y + 1.2, env)
      if (Math.abs(g - pos.y) < 3 && clearAt(wx, wz, 0.8, g, g + 4, env.collision)) {
        out.set(wx, g, wz)
        return g
      }
    }
    // airborne, or boxed in: still hand back somewhere beside the skids. The
    // registry refuses a dismount from up here anyway, but it may not throw
    const lx = -(SIZE.halfX + 1.9)
    out.set(pos.x + lx * c, pos.y, pos.z - lx * s)
    return pos.y
  }

  return {
    id: 'heli',
    label: 'helicopter',
    verb: 'fly',
    root,
    view: {
      back: 15,
      up: 5.5,
      stretch: 4,
      fov: 60,
      anchor: new THREE.Vector3(0, 2.6, 1.0),
      eye: new THREE.Vector3(-0.8, 2.55, -0.7),
    },
    size: SIZE,
    hull: HULL,
    get yaw() {
      return yaw
    },
    solid,
    reach: 5,
    placeAt,
    mount: () => {
      running = true
      model.pilot.visible = true
    },
    dismount: () => {
      running = false
      model.pilot.visible = false
    },
    exitSpot,
    update,
    // the landing light is the fleet's business (setLamps); the nav lights,
    // the panel and the beacon are ours, because they are on whenever the sun
    // is not. The beacon keeps a daylight floor: a real anti-collision strobe
    // is meant to be seen at noon, which is the whole point of a strobe
    setDay: (d, n) => {
      day = d
      night = n
      for (const m of model.navMats) m.emissiveIntensity = 0.3 + n * 2.4
      model.glowMat.emissiveIntensity = 0.05 + n * 1.6
    },
    dispose: () => {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
      })
      for (const m of model.owned) m.dispose()
      model.owned.length = 0
    },
  }
}
