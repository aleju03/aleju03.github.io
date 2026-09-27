import * as THREE from 'three'
import { noStand, type HullStation, type Solid } from '../physics/collision'
import {
  V, at, blade, capRing, createFacets, createPartBuilder, loft, markDynamic, revolve, ringSuper,
  skinRings, slab, tube,
} from './parts'
import type { VehicleMaterials } from './materials'
import {
  axes, clamp, clearAt, damp, groundNormal, groundUnder, netMotion, sweepBody,
  type NetMotion,
} from './chassis'
import type { DriveEnv, DriveStep, NetPose, Vehicle } from './types'

/*
  The helicopter: a light utility machine of the mid-2000s, the kind a
  local news station leases, and the reason the far side of
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
  is 7.6 units of radius, about the disc of a light turbine single, and the
  cabin, the boom and the fin are drawn to that. Every dimension below
  follows from that one number.

  ## The shape

  It is drawn the way the car is (car.ts's header, and parts.ts's
  `createFacets`): flat panels with creased normals, which is what reads
  through the pixel look, where the smooth bubble it replaced read as a
  blue blob with a stick out of the back. The cabin is a table of stations
  (`SECTIONS`), each a closed five-point half profile (keel, chine, belt,
  roof edge, crown), so every ring segment is the same panel the whole
  length: the dark belly, the lower flank, the stripe band, the window band
  and the roof. Each cell is told what it is made of by its panel and its
  bay (`skinRings`), which is how glass and paint share edges exactly with
  no CSG: the first three bays are the nose, a faceted glass bubble above a
  white keel strip (windscreen, chin windows and the roof's leading edge in
  one run); aft of it the window band is glass door by door, with the door
  posts as bays of their own left in paint; and the operator's livery is a
  red stripe down the flank and a band round the boom on a white body.

  On the roof sits the engine and transmission fairing, one faceted
  housing with an intake either side and an exhaust stack out of its tail,
  and the mast comes out of its top to a hub raised to clear it. The boom is
  a flat-sided octagon tapering aft with the driveshaft cover on its spine,
  and carries the stabiliser, the fin and the tail rotor on the port side.
  The skids are tubes, because a skid is a tube.

  The interior (floor pan, console, panel, seats, the cyclic, the collective
  and four pedals) was fitted to the old shell and stands inside this one
  with room to spare: the full section is 1.55 wide at the belt and the
  seated bean's hat reaches 3.74 under a roof at 3.9 to 4.05.

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

/* ------------------------------------------------------------ dimensions -- */

/** 1 world unit = 0.48 m. Every number below is in units unless it says so */
const ROTOR_R = 7.6
/** rotor hub height. The mast is exposed above the cabin roof, R22 fashion */
const HUB_Y = 5.66
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

const SIZE = { halfX: 1.7, halfZ: 9.0, height: 6.1 }

/* ------------------------------------------------------- the cabin shell -- */

/**
 * One station of the cabin, as a closed five-point half profile: the keel,
 * the chine, the belt (the widest line, where the side glass starts), the
 * roof edge and the crown. Every station is turned into the same ring, so
 * ring segment k is the same panel the whole length of the cabin: the belly,
 * the lower flank, the stripe band, the window band and the roof.
 */
interface Sect {
  z: number
  /** keel half-width and height */
  kw: number
  yk: number
  /** belt half-width, and the chine's and the belt's heights */
  hw: number
  yc: number
  yb: number
  /** roof edge half-width and height, and the crown's height */
  rw: number
  yr: number
  yt: number
}

const cabinSect = (z: number, kw: number, yk: number, hw: number, yc: number, yb: number, rw: number, yr: number, yt: number): Sect =>
  ({ z, kw, yk, hw, yc, yb, rw, yr, yt })

/** the station the cabin is full size at, repeated through the doors so the
    door posts can be stations of their own */
const FULL = (z: number) => cabinSect(z, 0.6, 1.15, 1.55, 1.35, 2.35, 1.3, 3.9, 4.05)

/* The cabin, nose to where it necks into the boom. The first four stations
   are the glass nose: a bubble that closes from the full section down to a
   point low on the centreline, so the windscreen, the chin windows and the
   roof's leading edge are all one run of faceted glass. Then the doors,
   whose posts get a pair of stations each; then the aft cabin tapers and
   climbs into the boom, which is its own loft. */
const SECTIONS: Sect[] = [
  cabinSect(-6.5, 0.08, 1.98, 0.22, 2.02, 2.24, 0.12, 2.44, 2.5),
  cabinSect(-6.1, 0.34, 1.55, 0.82, 1.7, 2.3, 0.56, 2.96, 3.02),
  cabinSect(-5.4, 0.5, 1.3, 1.22, 1.45, 2.32, 0.96, 3.46, 3.58),
  cabinSect(-4.6, 0.56, 1.2, 1.46, 1.38, 2.34, 1.2, 3.8, 3.95),
  FULL(-3.3),
  FULL(-3.1),
  FULL(-1.2),
  FULL(-1.0),
  FULL(0.3),
  cabinSect(1.2, 0.5, 1.3, 1.45, 1.5, 2.45, 1.2, 3.85, 4.0),
  cabinSect(2.0, 0.34, 2.0, 0.95, 2.2, 2.8, 0.75, 3.6, 3.7),
  cabinSect(2.7, 0.28, 2.38, 0.62, 2.5, 2.9, 0.44, 3.28, 3.34),
]

/** the ring at a station: left keel, over the top, to the right keel; the
    ring is closed, so its last segment is the belly */
const ringOf = (s: Sect) => {
  const half: Array<[number, number]> = [[s.kw, s.yk], [s.hw * 0.9, s.yc], [s.hw, s.yb], [s.rw, s.yr]]
  const r: THREE.Vector3[] = []
  for (const [x, y] of half) r.push(new THREE.Vector3(-x, y, s.z))
  r.push(new THREE.Vector3(0, s.yt, s.z))
  for (let i = half.length - 1; i >= 0; i--) r.push(new THREE.Vector3(half[i][0], half[i][1], s.z))
  return r
}

/** ring segment k's panel, counted from the keel up on either side */
const panelOf = (k: number) => (k === 8 ? -1 : k < 4 ? k : 7 - k)

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
  ...SECTIONS.map((s) => ({ z: s.z, hw: s.hw, top: s.yt })),
  ...BOOM_STATIONS.map((z) => ({ z, hw: boomR(z), top: boomY(z) + boomR(z) })),
]

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
  const f = createFacets()

  /*
    The cabin: the stations' rings skinned into panels, each cell told what
    it is made of by the panel it sits in and the bay it spans. The nose
    bubble is glass above the keel strip (windscreen, chin windows and the
    roof's front edge in one), the window band aft of it is glass door by
    door with the posts left in paint between, and the rest is a white body
    with the operator's red stripe along the flank and a dark belly.
  */
  const rings = SECTIONS.map(ringOf)
  const NOSE_BAYS = 3 // bays forward of the first full station: the bubble
  // the front door, the rear door and the quarter light; the bays between
  // them are the door posts
  const glassBay = (s: number) => s === 3 || s === 5 || s === 7
  skinRings(f, rings, (s, k) => {
    const panel = panelOf(k)
    if (panel === -1) return 'trim'
    if (s < NOSE_BAYS) return panel >= 1 ? 'glass' : 'paint2'
    if (panel === 2 && glassBay(s)) return 'glass'
    if (panel === 1 && s < 9) return 'paint'
    return 'paint2'
  }, true)
  capRing(f, rings[0], -1, 'paint2')
  capRing(f, rings[rings.length - 1], 1, 'paint2')

  // tail boom: a flat-sided octagon tapering aft, so it takes a highlight on
  // its top facets and a clean edge against the sky; and the driveshaft
  // cover along its spine
  {
    const zs = [2.4, 3.6, 5.0, 6.5, 8.0, 9.4, BOOM_Z1]
    const oct = (z: number) => {
      const r = boomR(z)
      const y = boomY(z)
      const ring: THREE.Vector3[] = []
      // left to right over the top, then back under: the same winding as the cabin
      for (let i = 0; i < 8; i++) {
        const a = Math.PI + Math.PI / 8 - (i / 8) * Math.PI * 2
        ring.push(V(Math.cos(a) * r, y + Math.sin(a) * r, z))
      }
      return ring
    }
    const boom = zs.map(oct)
    skinRings(f, boom, () => 'paint2', true)
    capRing(f, boom[boom.length - 1], 1, 'paint2')
    // a red band round the boom behind the cabin, the operator's other mark
    const grow = (p: THREE.Vector3) => V(p.x * 1.03, boomY(p.z) + (p.y - boomY(p.z)) * 1.03, p.z)
    const band = [oct(4.2), oct(4.9)].map((r) => r.map(grow))
    skinRings(f, band, () => 'paint', true)
  }
  b.add(
    loft(
      [3.0, 5.2, 7.4, 9.6].map((z) => ({
        z,
        y: boomY(z) + boomR(z) * 0.86,
        ring: ringSuper(0.16, 0.1, 0.12, 4, 2.0, 8),
      })),
      { capStart: 'flat', capEnd: 'flat' },
    ),
    'metal',
  )

  /*
    The engine and transmission fairing on the roof: the turbine a utility
    machine of the period carries up top, as one faceted housing with an
    intake grille either side, and an exhaust stack out of its tail.
  */
  {
    const fair = (z: number, w: number, h: number) => [
      V(-w, 3.9, z), V(-w * 0.92, 3.9 + h * 0.8, z), V(0, 3.9 + h, z), V(w * 0.92, 3.9 + h * 0.8, z), V(w, 3.9, z),
    ]
    const hs = [fair(-1.5, 0.55, 0.28), fair(-0.9, 0.78, 0.78), fair(1.9, 0.78, 0.78), fair(2.7, 0.5, 0.42)]
    skinRings(f, hs, () => 'paint2')
    capRing(f, hs[hs.length - 1], 1, 'paint2')
    for (const side of [-1, 1]) {
      f.quadOut(
        V(side * 0.785, 4.0, -0.4), V(side * 0.785, 4.0, 0.7), V(side * 0.785, 4.42, 0.7), V(side * 0.785, 4.42, -0.4),
        'dark', V(side, 0, 0),
      )
    }
  }
  b.add(
    tube([new THREE.Vector3(0.3, 4.4, 2.3), new THREE.Vector3(0.4, 4.85, 2.9)], 0.16, 8, { caps: true }),
    'chrome',
  )
  f.flush(b)

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

  // the mast out of the top of the fairing, the stationary half of the
  // swashplate and the control rods that run down into it
  b.add(revolve([[0.2, 0], [0.17, 0.3], [0.13, 1.2], [0.13, 1.56]], 12), 'chrome', at(0, 4.1, MAST_Z))
  b.add(
    revolve([[0.28, 0], [0.46, -0.02], [0.47, 0.06], [0.29, 0.08]], 14),
    'metal',
    at(0, 4.86, MAST_Z),
  )
  b.both(() => {
    b.add(
      tube(
        [new THREE.Vector3(0.34, 4.84, MAST_Z + 0.22), new THREE.Vector3(0.29, 4.6, MAST_Z + 0.1)],
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
    vertices: floor pan, console, panel, dials, seats, a T-bar cyclic,
    the collective at the pilot's left hand, and four pedals.

    The keel is a flat strip 1.2 wide at 1.15, so the floor pan (1.56 wide
    at 1.27-1.35) rests on the chine rather than hanging through the belly,
    the pedals stand on the pan, and the cushions (0.96 wide on centres of
    0.74) are well inside a cabin 3.1 wide at the belt.
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

  // Kept as an inert model-space reference for the authored cabin fit. The
  // occupied helicopter now carries the live articulated player at the
  // driverSeat created by buildHeli(), so this approximation stays hidden.
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

/** the two chairs: the seated face, either side of the centreline */
const SEAT_X = 0.6
const SEAT_Y = 2.72
const SEAT_Z = -0.5
/** no fold: 0.78 when the body was scaled onto its painted eyes, which is
    what scaling it onto its crown (playerBody's DESIGN_LENS) now does anyway */
const SEAT_FIT = 1

export function buildHeli(opts: { mats: VehicleMaterials }): Vehicle {
  const model = buildModel(opts.mats)
  const root = model.root
  // y is the seated body's face, not its hips: `playerBody.sit()` hangs the
  // fold from the eye, so a seat node and this machine's cockpit lens are the
  // same height by construction
  const driverSeat = new THREE.Group()
  driverSeat.name = 'driverSeat'
  // forward of where the robot sat: the character is deeper through the
  // chest and its backpack went into the engine cowling at z 0.06. `fit`
  // is how far `sit()` folds a body smaller about its eye to clear the
  // cabin floor (see playerBody's CABIN_FIT)
  driverSeat.position.set(SEAT_X * -1, SEAT_Y, SEAT_Z)
  // the cabin a rider stays inside (playerBody's `sit`), seat frame: the door
  // glass at 1.4 from the centreline at head height, the roof over it at
  // 3.9, the panel ahead and the aft bulkhead behind
  driverSeat.userData.room = new THREE.Box3(new THREE.Vector3(-0.6, -1.37, -2.0), new THREE.Vector3(0.7, 0.98, 1.5))
  driverSeat.userData.fit = SEAT_FIT
  root.add(driverSeat)
  // the right-hand seat, the mirror of the pilot's: nothing else about the
  // cabin has to change to hold somebody
  const passengerSeat = new THREE.Group()
  passengerSeat.name = 'passengerSeat'
  passengerSeat.position.set(SEAT_X, SEAT_Y, SEAT_Z)
  passengerSeat.userData.room = new THREE.Box3(new THREE.Vector3(-0.7, -1.37, -2.0), new THREE.Vector3(0.6, 0.98, 1.5))
  passengerSeat.userData.fit = SEAT_FIT
  root.add(passengerSeat)
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

  /* ------------------------------------------------------------ net drive -- */

  /*
    Somebody else flying. The rotor is the whole of this machine's presence —
    a helicopter crossing the sky with a still disc is a prop, not an aircraft
    — so `spin` keeps ramping on exactly the clock the local one uses, which
    also means the blade slap in sfx.ts is riding the same number for a remote
    machine as for the one you are sitting in.

    `running` is deliberately left alone. It belongs to mount/dismount, so
    when the far-side pilot gets out and the registry stops calling this, the
    ordinary parked update finds a stopped engine and winds the disc down over
    its eight seconds instead of stopping it dead.
  */
  const netM: NetMotion = { f: 0, planar: 0, yawRate: 0 }
  let netYaw = 0

  const netStep = (env: DriveEnv, p: NetPose): DriveStep => {
    const dt = env.dt
    clock += dt
    if (p.snapped) netYaw = p.yaw
    netMotion(p, netYaw, dt, netM)
    netYaw = p.yaw

    pos.set(p.x, p.y, p.z)
    yaw = p.yaw
    pitch = p.pitch
    roll = p.roll
    vel.set(p.vx, p.vy, p.vz)

    spin = Math.min(1, spin + dt * SPIN_UP)
    rotorAngle = (rotorAngle + OMEGA * spin * dt) % TAU
    tailAngle = (tailAngle + OMEGA * TAIL_RATIO * spin * dt) % TAU
    writeTransform()
    fitSolid()

    const beat = Math.max(0, Math.sin(clock * BEACON_W))
    const flash = beat * beat * beat * beat * beat * beat
    model.beaconMat.emissiveIntensity =
      0.08 + night * 0.18 + flash * (1.5 + day * 1.4 + night * 2.2) * (0.25 + 0.75 * spin)

    const rest = restUnder(env)
    landed = pos.y - rest < 0.35
    step.speed = netM.f
    step.planar = netM.planar
    step.load = clamp(netM.planar / TOP_SPEED, 0, 1)
    step.rpm = spin
    step.gear = 0
    step.grounded = landed
    step.vy = p.vy
    step.altitude = Math.max(0, pos.y - rest)
    step.slip = 0
    step.braking = 0
    step.surface = env.surfaceAt(pos.x, pos.z)
    step.impact = 0
    step.moved = netM.planar > 0.02 || Math.abs(p.vy) > 0.02
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
    driverSeat,
    passengerSeat,
    view: {
      back: 15,
      up: 5.5,
      stretch: 4,
      fov: 60,
      anchor: new THREE.Vector3(0, 2.6, 1.0),
      eye: new THREE.Vector3(-SEAT_X, SEAT_Y, SEAT_Z - 0.2),
      eye2: new THREE.Vector3(SEAT_X, SEAT_Y, SEAT_Z - 0.2),
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
    reach: 5,
    // a turbine single is heavy for its size; on the physgun it drags like a
    // car and floats a while, nose down, if you drop it in the sea
    carry: { mass: 320, density: 0.8, bottom: 0.02 },
    placeAt,
    mount: () => {
      running = true
    },
    dismount: () => {
      running = false
    },
    exitSpot,
    update,
    netStep,
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
