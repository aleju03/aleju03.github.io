import * as THREE from 'three'
import {
  at,
  blade,
  createPartBuilder,
  loft,
  markDynamic,
  revolve,
  ringFrom,
  ringSuper,
  slab,
  tube,
  type Ring,
  type Station,
} from './parts'
import { axes, clamp, clearAt, damp, groundUnder, sweepBody } from './chassis'
import type { VehicleMaterials } from './materials'
import type { DriveEnv, DriveStep, Vehicle } from './types'
import type { HullStation, Solid } from '../physics/collision'

/*
  The boat: a small open runabout with a centre console and an outboard, the
  kind of thing left pulled up on a quiet coast. Thirteen units stem to
  transom, which at this world's scale (1 unit = 0.48 m) is a 6.25 m hull —
  small enough that one person drives it perched at the console, big enough
  that the swell moves it rather than throws it.

  ------------------------------------------------------------------ the hull

  A hull is the one shape in this project that a box will not fake, and it is
  exactly what `loft` and a piecewise section function were written for. Every
  station here is the same eighteen-point half-outline, mirrored: a V bottom
  from the keel out to the chine, topsides from the chine up to the sheer, the
  gunwale cap rolling inboard, and then — inside the same closed ring — the
  cockpit wall dropping to the sole and the sole running back to the
  centreline.

  That last half is the part worth explaining. A hull lofted as a plain closed
  tube is a bathtub whose deck you can see the underside of; a hull lofted as
  a *section through the moulding* — outer skin up over the sheer and back
  down the inside to the sole — comes out of one call with a real cockpit in
  it, a real foredeck over the bow, and no seam to hide. It is also how the
  boat is really built: a hull moulding and a liner moulding bonded at the
  sheer.

  One number opens and closes the cockpit: `open`, 0 at the ends and 1
  amidships. At open = 0 the "sole" rises to just above the sheer and pulls in
  to half the beam, so the inner half of the ring stops being a cockpit and
  becomes a cambered foredeck; at open = 1 it drops 1.16 units (0.56 m) and
  the same vertices are a cockpit you stand in. Nothing else in the ring
  changes, so every feature keeps its index from the stem to the transom.

  Three things do most of the recognising, and all three are cheap:

  - **The chine.** The crease where the V bottom folds into the topsides is
    the single most identifiable line on a small planing boat. It is a
    *longitudinal* fold, so `Station.crease` — which splits smoothing across a
    station, i.e. transversely — cannot make it. Instead the chine point goes
    into the half-outline **twice**. The two coincident vertices give the
    strip below the chine and the strip above it their own normals,
    `computeVertexNormals` averages within each side rather than across, and
    the fold stays a knife edge for the whole thirteen units at a cost of one
    vertex per station per side. The sole-to-wall corner is doubled for the
    same reason.
  - **The deadrise varies.** 40 degrees at the entry, 24 amidships, 11 at the
    transom. A hull with one deadrise all the way either pounds (too flat
    forward) or will not plane (too deep aft); the taper is what a planing
    hull *is*.
  - **The sheer sweeps.** The gunwale is at y = 1.44 at the stem and 0.95 at
    the transom, and that comes out of the stations' own y values, never out
    of scaling the section. Scale a section and the whole hull grows with it,
    which reads as a bathtub however good the plan view is.

  Beam grows to its 4.60 maximum about 60% aft and then holds to a wide square
  transom. The transom is a flat vertical cap, and the last station closes its
  cockpit back to open = 0 before that cap is fanned: `loft`'s cap is a fan
  from the ring's centroid, which tiles a convex outline correctly and folds
  triangles back on themselves over the C-shape an open station would give it.

  ---------------------------------------------------------------- the physics

  The boat floats on the *drawn* sea, not on the flat waterline. streamer.ts
  displaces the water in a vertex shader with two crossed sines (0.22 units,
  wavelengths 24 and 33, about 1.6 degrees of slope at the steepest), and a
  hull sitting at `waterY` sits inside the crests and under the troughs —
  most visibly exactly when the boat is the thing you are looking at. So four
  probes (bow, stern, port, starboard) each ask `env.waveAt`, and the four
  answers become one height to float at and two angles to lie at. The boat is
  deliberately not allowed to exaggerate them: pitch and roll *damp* toward
  the surface's own angles rather than springing about them, so a swell this
  gentle stays a swell and never becomes a rodeo.

  The same four probes ask what the sea bed is doing, and both answers combine
  the same way at every probe: the height the origin would rest at here is
  `max(waterSurface, bedHeight - hullBottomOffset)`. That one expression
  covers floating in deep water, scraping over a shoal, sitting on a beach and
  standing on dry land a mile inland — and because the bed term is a hard
  floor *under* the buoyancy spring rather than another force fighting it, the
  boat can neither sink through sand nor buzz against it.

  Resistance has two regimes, because that is the whole feel of a small
  powerboat. Below about 13 u/s the hull is pushing water aside and its drag
  coefficient is 0.042; past about 23 it is skating on its own bottom at
  0.0056, seven times less. In between it noses up, hangs on the hump, and
  then goes. Both are quadratic, so top speed falls straight out of thrust:
  12 u/s² against 0.0056 v² settles at 42 u/s (20 m/s, 39 knots).

  Steering is thrust vectoring, because an outboard has no rudder — the whole
  leg swivels and the propeller pushes the stern sideways. Three behaviours
  come out of that for free and none of them is special-cased: a boat with the
  engine at idle does not steer at all, a boat pivots on the spot with the
  helm hard over and a burst of throttle, and reverse steers backwards. The
  hull resists sideways motion about forty times harder than it resists going
  ahead, so it carves a turn rather than sliding through it — but only about
  forty times, so it still drifts five or six degrees at speed, and heels
  *into* the turn the way a planing hull does rather than out of it like a car.

  -------------------------------------------------------------- a repair log

  Everything from `loft`, `slab` and `tube` used to be passed through a local
  `flip()`, because those three once wound their side triangles inward. The
  workaround was worse than the bug it patched. `flip()` reverses a whole
  geometry, and the flat end caps were never wound inward in the first place —
  so every cap it touched came out facing into the shell, and a back-facing cap
  under a FrontSide material is not a dark patch, it is a hole. The transom was
  one of them: the entire 4.4 x 1.8 aft face, with `view.back` parking the
  chase camera dead astern of it. So were the console top, the outboard's aft
  face, both flat centres of every `slab`, and every capped tube end.

  parts.ts is fixed at source now — a capped loft barrel comes back at +5.673
  of signed volume with every face pointing away from its axis — so nothing
  here reverses winding, and nothing here should ever need to again. If a shell
  ever looks inside out, the fix belongs in parts.ts, not in a wrapper here.

  Taking the wrapper away uncovered two things that were wound backwards on
  their own account, and both are fixed where they are authored rather than by
  reversing anything: the windscreen's crescent ring ran clockwise (`flip()`
  had been accidentally correcting it), and the wheel rim's section circled the
  wrong way (`flip()` never touched that one, so the rim had been inside out
  from the day it was written). Every closed shell on the boat now has a
  positive signed volume and a consistently wound index — hull +37.81, console
  +1.67, outboard cowl +0.33, transom cap +13.95 — and none of its 72 flat
  caps faces inward.
*/

/* ------------------------------------------------------------------- scale --

   1 world unit = 0.48 m. Everything below is in world units, with the metric
   equivalent given wherever the number came off a real boat.                  */

/** stem at -HALF_LEN, transom at +HALF_LEN: a 13.0-unit (6.25 m) hull */
const HALF_LEN = 6.5
/** the origin is the waterline at rest, so this is the draft: 0.80 u = 0.38 m */
const KEEL = 0.8
/** how far the fixed structure reaches above the waterline (the bow rail),
    which with KEEL makes the quoted 2.6 of height */
const TOPS = 1.8
/** half-beam over the rubbing strake: 4.60 u = 2.21 m of beam */
const HALF_BEAM = 2.3

/* ----------------------------------------------------------------- sections */

interface Section {
  z: number
  /** half-beam at the sheer */
  hw: number
  /** half-beam at the chine */
  chw: number
  /** the keel, on the centreline */
  keel: number
  /** the chine, where the V bottom folds into the topsides */
  chine: number
  /** the gunwale — this is the sheer line, and it sweeps */
  sheer: number
  /** 0 the ring closes into a cambered deck, 1 it opens to a full cockpit */
  open: number
}

/*
  Thirteen stations. Read down `keel` for the profile — the forefoot lifting
  clear of the water forward, a nearly straight run aft, a little rocker at
  the transom so the stern does not squat forever. Read down `sheer` for the
  sweep. Take (chine - keel) over `chw` for the deadrise.
*/
const SECTIONS: Section[] = [
  { z: -6.50, hw: 0.05, chw: 0.04, keel: 0.70, chine: 0.78, sheer: 1.44, open: 0 },
  { z: -6.05, hw: 0.36, chw: 0.28, keel: 0.36, chine: 0.72, sheer: 1.40, open: 0 },
  { z: -5.30, hw: 0.86, chw: 0.68, keel: 0.02, chine: 0.58, sheer: 1.34, open: 0 },
  { z: -4.20, hw: 1.42, chw: 1.18, keel: -0.34, chine: 0.30, sheer: 1.26, open: 0 },
  { z: -3.00, hw: 1.80, chw: 1.56, keel: -0.58, chine: 0.10, sheer: 1.19, open: 0 },
  { z: -1.80, hw: 2.02, chw: 1.80, keel: -0.71, chine: -0.05, sheer: 1.14, open: 0.30 },
  { z: -0.60, hw: 2.14, chw: 1.95, keel: -0.78, chine: -0.14, sheer: 1.10, open: 0.80 },
  { z: 0.60, hw: 2.19, chw: 2.04, keel: -0.80, chine: -0.20, sheer: 1.07, open: 1 },
  { z: 2.20, hw: 2.20, chw: 2.09, keel: -0.80, chine: -0.25, sheer: 1.03, open: 1 },
  { z: 3.80, hw: 2.20, chw: 2.12, keel: -0.79, chine: -0.29, sheer: 1.00, open: 1 },
  { z: 5.20, hw: 2.20, chw: 2.13, keel: -0.77, chine: -0.32, sheer: 0.97, open: 0.95 },
  { z: 6.30, hw: 2.20, chw: 2.14, keel: -0.74, chine: -0.34, sheer: 0.95, open: 0.55 },
  { z: 6.50, hw: 2.20, chw: 2.14, keel: -0.72, chine: -0.33, sheer: 0.95, open: 0 },
]

/** how far inboard the gunwale cap runs before turning down into the cockpit.
    0.20 u is a 10 cm coaming, which is what a hand actually grabs */
const COAMING = 0.2
/** the cap sits this far under the sheer line, so the strake has a shoulder */
const CAP_DROP = 0.05
/** cockpit sole below the cap at open = 1: 1.16 u = 0.56 m, i.e. waist deep */
const COCKPIT = 1.16

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** the usual hermite ramp; chassis.ts does not export one */
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** the section anywhere along the hull, for hanging fittings off */
const sectionAt = (z: number): Section => {
  const cz = clamp(z, SECTIONS[0].z, SECTIONS[SECTIONS.length - 1].z)
  let i = 0
  while (i < SECTIONS.length - 2 && SECTIONS[i + 1].z < cz) i++
  const a = SECTIONS[i]
  const b = SECTIONS[i + 1]
  const t = (cz - a.z) / (b.z - a.z)
  return {
    z: cz,
    hw: lerp(a.hw, b.hw, t),
    chw: lerp(a.chw, b.chw, t),
    keel: lerp(a.keel, b.keel, t),
    chine: lerp(a.chine, b.chine, t),
    sheer: lerp(a.sheer, b.sheer, t),
    open: lerp(a.open, b.open, t),
  }
}

/* ------------------------------------------------------------- footprint --

   What a walker collides with: the station table again, widened by the 0.10
   the rubbing strake stands proud of the sheer (which is the whole of the
   difference between the widest station and the quoted 2.3 half-beam), and
   standing as high as the sheer line at each station.

   That the profile comes to a point at the stem is the point of doing this at
   all — the old box was a 4.6 x 13.0 rectangle, so the bow's fine entry was
   two triangles of invisible wall a metre and a half deep, sitting exactly
   where anyone wading out to the boat approaches it. Sheer as the top matters
   for the same reason in y: a flat 2.6 stood the deck a full unit above the
   gunwale you can see.                                                      */
const HULL: HullStation[] = SECTIONS.map((s) => ({
  z: s.z,
  hw: s.hw + 0.1,
  top: s.sheer,
}))

/** the gunwale cap's inboard edge, clamped so a fine bow never turns inside out */
const capInner = (s: Section) => s.hw - Math.min(COAMING, s.hw * 0.45)

/** the cockpit sole (or, where `open` is 0, the crowned deck) at this station */
const soleOf = (s: Section) => {
  const deckY = s.sheer - CAP_DROP
  const inner = capInner(s)
  const y = deckY + 0.06 - COCKPIT * s.open
  return {
    y,
    hw: inner * (0.55 + 0.3 * s.open),
    centreY: y + 0.1 * (1 - s.open),
    deckY,
    inner,
  }
}

/** where the outside of the hull is directly under (x, z): the V, then the
    chine, then the topside. The flotation probes sit on this, so a probe out
    on the beam knows it is on the turn of the bilge and not on the keel */
const bottomAt = (x: number, z: number) => {
  const s = sectionAt(z)
  const t = clamp(Math.abs(x) / Math.max(1e-3, s.chw), 0, 1)
  return lerp(s.keel, s.chine, t)
}

/*
  One station's outline: eighteen half-points mirrored into a 34-point ring.
  The indices are fixed for every station, which is what makes each feature a
  line down the hull instead of a spiral around it:

    0..4   the V bottom, keel to chine, with a whisker of convex belly
    5      the chine again — coincident, so the fold shades hard
    6..8   the topsides, flared outboard as they rise
    9..10  the gunwale cap rolling inboard
    11..13 the cockpit wall dropping away
    14     the sole's outboard corner
    15     that corner again, so sole and wall meet in a crisp line
    16..17 the sole in to the centreline
*/
const hullRing = (s: Section): Ring => {
  const half: number[][] = []
  const sole = soleOf(s)

  // the V, with 5.5% of its own rise added as belly: a real bottom panel is
  // very slightly convex, and a dead flat one catches light like sheet metal
  const rise = s.chine - s.keel
  for (let i = 0; i <= 4; i++) {
    const t = i / 4
    half.push([s.chw * t, s.keel + rise * t + 0.055 * rise * Math.sin(Math.PI * t)])
  }
  half.push([s.chw, s.chine]) // the chine, twice — see the header

  // topsides. The flare is front-loaded (t^0.72) so the section leaves the
  // chine leaning outboard and stands up again as it reaches the sheer
  for (let i = 1; i <= 3; i++) {
    const t = i / 3
    half.push([lerp(s.chw, s.hw, Math.pow(t, 0.72)), lerp(s.chine, s.sheer, t)])
  }

  // the cap, rolling over and inboard
  half.push([lerp(s.hw, sole.inner, 0.35), s.sheer - CAP_DROP * 0.4])
  half.push([sole.inner, sole.deckY])

  // down the inside to the sole. The wall tucks in faster than it drops
  // (t^0.8 on x) so the cockpit gets a moulded radius rather than a corner
  for (let i = 1; i <= 3; i++) {
    const t = i / 4
    half.push([lerp(sole.inner, sole.hw, Math.pow(t, 0.8)), lerp(sole.deckY, sole.y, t)])
  }
  half.push([sole.hw, sole.y])
  half.push([sole.hw, sole.y]) // twice: the sole/wall corner stays sharp
  half.push([sole.hw * 0.5, lerp(sole.y, sole.centreY, 0.62)])
  half.push([0, sole.centreY])

  const ring: Ring = []
  for (const [x, y] of half) ring.push(x, y)
  for (let i = half.length - 2; i >= 1; i--) ring.push(-half[i][0], half[i][1])
  return ring
}

/* ------------------------------------------------------------------- bones */

/** a limb or a spar: a tapered solid of revolution running up +y from y = 0 */
const bone = (r0: number, r1: number, len: number, seg = 8) =>
  revolve(
    [
      [0, 0],
      [r0 * 0.9, len * 0.06],
      [r0, len * 0.3],
      [r1, len * 0.85],
      [r1 * 0.8, len],
      [0, len],
    ],
    seg,
  )

/* ------------------------------------------------------------------ physics */

/** the walk controller's gravity, so a boat falls at the same rate a body does */
const G = 34
/** planing top speed, u/s. 42 u/s = 20.2 m/s = 39 knots */
const TOP = 42
/** full-throttle thrust as an acceleration, u/s². 12 u/s² = 5.8 m/s² — brisk
    for a boat, but this is a machine you have to enjoy getting into */
const THRUST = 12
/** astern the propeller works in its own wash and the transom drags: under a
    third of the push against five times the resistance, so about 6 u/s */
const THRUST_REV = 3.4
const CD_REV = 0.09
/** the linear part of hull resistance — skin friction, which never goes away */
const CD_LIN = 0.05
/** displacement drag: pushing a hole through the water at 0.042 v² */
const CD_DISPL = 0.0422
/** planing drag, derived rather than guessed so that TOP is exactly TOP */
const CD_PLANE = (THRUST - CD_LIN * TOP) / (TOP * TOP)
/** the hump: below LO the hull is in the water, above HI it is on top of it */
const PLANE_LO = 13
const PLANE_HI = 23
/** buoyancy has to hold the boat up at exactly the resting draft, so its
    stiffness is fixed at G / KEEL — a natural frequency of 6.5 rad/s, i.e. a
    one second heave period. HEAVE_DAMP 12 puts that at 0.92 of critical:
    settled inside two seconds with no second bounce, and still light enough
    to follow a swell moving underneath it */
const HEAVE_DAMP = 12
/** how far the outboard swings: 0.52 rad = 30 degrees hard over */
const MAX_RUD = 0.52
/** the thrust's lever arm about the centre of gravity */
const LEVER = 6.2
/** yaw inertia per unit mass — a radius of gyration of about a quarter of the
    length, squared: (13/4)² = 10.6 */
const IY = 11
/** sideslip weathervaning: how hard the hull turns to face its own drift */
const WEATHER = 0.115
/** yaw resistance, a constant part plus a part that grows with way on. That
    second term is why a boat tracks straight at speed and wanders at idle.
    Both are low: they were four times this and she turned in six lengths,
    which is a ferry. At 0.9 + 0.045 v she comes round in about three */
const YAW_LIN = 0.9
const YAW_QUAD = 0.045
/** lateral resistance. At 3 u/s of drift this is 18 u/s² against 0.4 u/s² of
    longitudinal drag at the same speed — a hull resists sideways motion about
    forty times harder than it resists going ahead, which is what makes a
    carve a carve. Not four hundred times, so it still drifts */
const SIDE_LIN = 1.6
const SIDE_QUAD = 1.5
/** heel into the turn, radians per rad/s of yaw at full speed, capped at 15
    degrees. A planing hull banks inboard; only a displacement hull leans out */
const HEEL = 0.4
const HEEL_MAX = 0.26
/** clearance under the hull at which the bottom starts to touch and to drag */
const SCRAPE = 0.45
/** and how hard: with the keel on the sand this takes 9 u/s² per u/s away,
    which stops a boat doing 20 in about a length and a half */
const SCRAPE_DRAG = 9
/**
 * ...and then this holds her there. A resistance proportional to speed can
 * only ever reach an equilibrium with the thrust, and 12 u/s² of thrust
 * against 9 u/s² per u/s of scrape is an equilibrium at 1.3 u/s: the boat
 * decelerated beautifully from 41 and then crawled up the beach for ever.
 * Sand does not work like that — it takes hold — so there is a Coulomb term
 * as well, dead resistance that does not care how fast you are going, scaled
 * by graze² so it only exists once the hull is genuinely on the bottom.
 */
const SCRAPE_STICK = 16
/**
 * How much of all that the bottom actually applies, which is not the same in
 * both directions and must not be, or the boat is welded to the beach she
 * just drove onto. Ground resists being *climbed*: the term is
 * `base + 12 x (how fast the bed rises the way she is trying to go)`, which
 * on the 3.3-degree shelf she grounds on comes out at 1.3 going up the beach
 * (20 u/s² of hold against 12 of thrust — she stops) and at the 0.1 floor
 * coming back down it (1.6 against 3.4 of astern thrust — she comes off,
 * slowly, which is exactly how it goes). The two bases differ because a
 * propeller dragging a hull back down its own furrow has an easier time of it
 * than one trying to push a hull into ground it has not moved yet.
 */
const HOLD_AHEAD = 0.65
const HOLD_ASTERN = 0.18
const HOLD_SLOPE = 12
/** the propeller's depth below the origin, and how much water it needs to
    bite. Run the transom into the shallows and the engine simply stops
    working, which is exactly the right punishment */
const PROP_Y = 1
const PROP_BITE = 0.55

const TAU = Math.PI * 2

/* --------------------------------------------------------------------- build */

export interface BoatOpts {
  mats: VehicleMaterials
}

export function buildBoat(opts: BoatOpts): Vehicle {
  const { mats } = opts

  /* ------------------------------------------------------------ the hull -- */

  const B = createPartBuilder()

  const stations: Station[] = SECTIONS.map((s, i) => ({
    z: s.z,
    ring: hullRing(s),
    // the transom is a pressed corner, not a rolled one: split smoothing at
    // the last full station so the flat cap cannot drag its normal forward
    // into the run of the topsides
    crease: i === SECTIONS.length - 2,
  }))
  B.add(loft(stations, { capStart: 'flat', capEnd: 'flat' }), 'paint2')

  // a moulded sole panel laid a hair over the liner. It is here to give the
  // cockpit floor a colour of its own; a one-colour interior reads as a bucket
  const solePanel: Station[] = []
  for (const z of [-1.5, 0.4, 2.6, 4.6, 5.7]) {
    const sole = soleOf(sectionAt(z))
    solePanel.push({ z, y: sole.y + 0.035, ring: ringSuper(sole.hw * 0.94, 0.03, 0.03, 6, 6, 12) })
  }
  B.add(loft(solePanel, { capStart: 'flat', capEnd: 'flat' }), 'trim')

  /* the three lines that run the length of her. Every path stops just inside
     the stem and the transom: a tube's end ring is perpendicular to the path,
     so a path that ran to z = +-6.5 exactly would push its own radius past
     the hull it is supposed to be fitted to */
  const RAIL_Z = [-6.42, -6.05, -5.3, -4.2, -3, -1.8, -0.6, 0.6, 2.2, 3.8, 5.2, 6.3, 6.44]
  const railPath = (fn: (s: Section) => [number, number]) =>
    RAIL_Z.map((z) => {
      const s = sectionAt(z)
      const [x, y] = fn(s)
      return new THREE.Vector3(x, y, z)
    })

  B.both(() => {
    // the spray rail, sitting on the chine. Its job on the water is to throw
    // spray down and outboard instead of letting it climb the topsides; its
    // job here is to put a highlight along the fold, which is the same thing
    B.add(tube(railPath((s) => [s.chw - 0.02, s.chine - 0.01]), 0.075, 6), 'paint2')
    // the cove stripe, a third of the way up the topsides — the one place the
    // boat's own colour shows, because a runabout is a white boat with a line
    B.add(
      tube(
        railPath((s) => [lerp(s.chw, s.hw, 0.62) + 0.015, lerp(s.chine, s.sheer, 0.34)]),
        0.055,
        6,
      ),
      'paint',
    )
    // the rubbing strake: black, proud of the gunwale, and the reason coming
    // alongside a dock does not take the paint off. Its outer face is what
    // sets the quoted 4.60 of beam
    B.add(tube(railPath((s) => [s.hw + 0.02, s.sheer - 0.06]), 0.08, 6), 'dark')
  })

  /* --------------------------------------------------------- the console -- */

  const CONSOLE_Z = 0.55
  const CONSOLE_TOP = 1.28
  const consoleSole = soleOf(sectionAt(CONSOLE_Z)).y
  const CONSOLE_H = CONSOLE_TOP - consoleSole
  /*
    How far aft the moulding reaches at its top two stations, and the heights
    those sit at. Everything that hangs on the aft face — the dash panel, the
    wheel — is placed against these rather than against a guessed number,
    because the face is neither flat nor vertical: it swells to 0.55 aft at
    shoulder height and then pulls back in to 0.5 at the cap.
  */
  const AFT_UPPER = 0.55
  const AFT_TOP = 0.5
  const UPPER_Y = consoleSole + CONSOLE_H * 0.86
  /** and the angle that last stretch leans at, which is the angle anything
      let into it has to lie at. Negative rakes the face's outward normal up
      and aft, the way `at()`'s rx does */
  const AFT_RAKE = Math.atan2(AFT_TOP - AFT_UPPER, CONSOLE_TOP - UPPER_Y)

  {
    // lofted up its own +z and then stood on end, because the kit skins along
    // z and a console is a vertical thing. rx = -90 maps the loft's +z to +y
    // and the section's +y to -z, i.e. up and forward — which is how the
    // rings below are dimensioned: (half-width, forward reach, aft reach)
    const col: Station[] = [
      { z: 0, ring: ringSuper(0.72, 0.5, 0.5, 5, 5, 16) },
      { z: CONSOLE_H * 0.48, ring: ringSuper(0.7, 0.48, 0.52, 5, 5, 16) },
      { z: CONSOLE_H * 0.86, ring: ringSuper(0.66, 0.4, AFT_UPPER, 4.5, 4.5, 16) },
      { z: CONSOLE_H, ring: ringSuper(0.58, 0.3, AFT_TOP, 4, 4, 16) },
    ]
    B.add(
      loft(col, { capStart: 'flat', capEnd: 'flat' }),
      'paint2',
      at(0, consoleSole, CONSOLE_Z, -Math.PI / 2),
    )
    /*
      The dash: a dark panel let into the aft face above the wheel. It was
      placed at z = 1.01 with an invented -0.22 of rake, and the skin at those
      heights runs 1.05..1.10 — so every one of the panel's own vertices sat
      *inside* the moulding and the thing never drew at all, which reads as a
      missing part rather than as a misplaced one. 1.12 stands its whole aft
      face proud of the skin (by 0.05 at the tightest point, the top centre)
      while its forward face still bites into the moulding on the centreline,
      which is what makes this a panel let in rather than one stuck on, and
      AFT_RAKE lies it along the face instead of across it.
    */
    B.add(slab(0.92, 0.3, 0.06, 0.03), 'dark', at(0, CONSOLE_TOP - 0.19, 1.12, AFT_RAKE))
  }

  {
    /*
      The windscreen: a crescent ring — an arc out and an arc back, doubled at
      both ends so the edges stay sharp — lofted a short way and stood on end.
      Curving it across the beam is the whole trick; a flat pane in front of a
      console reads as a bus shelter. 0.50 units of screen (24 cm) raked 20
      degrees aft, which keeps its top just under the bow rail's.

      The first half of t is the *inner* arc, and that is not a detail. `loft`
      needs its rings wound counter-clockwise, like `ringSuper`'s; running the
      outer arc first traces this crescent the other way round and the pane
      comes out inside out. It used to, and the `flip()` this file has just
      lost was quietly correcting it — the one thing that wrapper ever got
      right, and only by accident.
    */
    const R = 1.9
    const screenRing = (halfAng: number, thick: number): Ring =>
      ringFrom((t) => {
        const u = t < 0.5 ? t * 2 : (1 - t) * 2
        const a = (u - 0.5) * 2 * halfAng
        const rr = R + (t < 0.5 ? -thick * 0.5 : thick * 0.5)
        return [Math.sin(a) * rr, Math.cos(a) * rr - R]
      }, 20)
    const glass: Station[] = [
      { z: 0, ring: screenRing(0.36, 0.05) },
      { z: 0.5, ring: screenRing(0.345, 0.045) },
    ]
    B.add(
      loft(glass, { capStart: 'flat', capEnd: 'flat' }),
      'glass',
      at(0, CONSOLE_TOP - 0.03, CONSOLE_Z - 0.4, -Math.PI / 2 + 0.35),
    )
  }

  // the throttle: one lever to starboard, forward for ahead
  B.add(
    tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.28, -0.1)], 0.035, 6, { caps: true }),
    'chrome',
    at(0.62, CONSOLE_TOP - 0.14, 0.94),
  )
  B.add(
    revolve([[0, 0], [0.07, 0.03], [0.07, 0.1], [0, 0.13]], 8),
    'dark',
    at(0.62, CONSOLE_TOP + 0.12, 0.84),
  )

  /* ----------------------------------------------------------- the seats -- */

  /** a pedestal seat. `back` is which way the backrest leans (+1 aft-facing
      rest for a forward-facing seat), `lift` the cushion above the sole */
  const seatAt = (z: number, back: number, lift: number) => {
    const sole = soleOf(sectionAt(z)).y
    B.add(
      revolve([[0.14, 0], [0.1, 0.1], [0.09, lift - 0.1], [0.16, lift - 0.02], [0, lift]], 10),
      'chrome',
      at(0, sole, z),
    )
    B.add(slab(0.86, 0.16, 0.58, 0.07), 'seat', at(0, sole + lift, z))
    B.add(slab(0.82, 0.6, 0.14, 0.06), 'seat', at(0, sole + lift + 0.34, z + back * 0.3, back * -0.16))
  }
  // the helm perch, aft of the console — the driver half sits on it
  seatAt(1.75, 1, 0.87)
  // and a lower seat forward of it, over the tank, facing back into the boat
  seatAt(-0.35, -1, 0.6)

  /* ------------------------------------------------- rails, cleats, lamps -- */

  /** the bow rail's height is capped so that its top — the highest fixed
      point on the boat — lands exactly on TOPS above the waterline */
  const railY = (s: Section) => Math.min(s.sheer - CAP_DROP + 0.42, TOPS - 0.07)

  B.both(() => {
    /*
      The bow rail: a stainless hoop from the forward end of the cockpit round
      the stem, pulled inboard as it goes.
    */
    const path: THREE.Vector3[] = []
    for (const z of [-1.9, -2.9, -3.9, -4.8, -5.5, -6.05, -6.4]) {
      const s = sectionAt(z)
      const t = clamp((z + 6.4) / 2.4, 0, 1) // pinch in toward the stem
      path.push(new THREE.Vector3(capInner(s) * (0.42 + 0.58 * t), railY(s), z))
    }
    path.push(new THREE.Vector3(0, TOPS - 0.07, -6.44))
    B.add(tube(path, 0.07, 6, { caps: true }), 'chrome')

    for (const z of [-2.6, -4.2, -5.6]) {
      const s = sectionAt(z)
      const t = clamp((z + 6.4) / 2.4, 0, 1)
      const x = capInner(s) * (0.42 + 0.58 * t)
      B.add(
        tube(
          [
            new THREE.Vector3(x, s.sheer - CAP_DROP - 0.02, z),
            new THREE.Vector3(x, railY(s), z),
          ],
          0.055,
          6,
        ),
        'chrome',
      )
    }

    // horn cleats, bow and quarter, for lines nobody will ever tie
    for (const z of [-4.3, 5.5]) {
      const s = sectionAt(z)
      const x = capInner(s) * 0.72
      const y = s.sheer - CAP_DROP + 0.03
      B.add(
        tube(
          [new THREE.Vector3(x, y + 0.1, z - 0.2), new THREE.Vector3(x, y + 0.1, z + 0.2)],
          0.055,
          6,
          { caps: true },
        ),
        'chrome',
      )
      B.add(slab(0.16, 0.12, 0.18, 0.03), 'chrome', at(x, y + 0.04, z))
    }
  })

  // a grab rail across the front of the console for whoever is sitting there
  B.add(
    tube(
      [
        new THREE.Vector3(-0.6, CONSOLE_TOP - 0.16, 0.06),
        new THREE.Vector3(-0.58, CONSOLE_TOP + 0.02, -0.04),
        new THREE.Vector3(0, CONSOLE_TOP + 0.06, -0.07),
        new THREE.Vector3(0.58, CONSOLE_TOP + 0.02, -0.04),
        new THREE.Vector3(0.6, CONSOLE_TOP - 0.16, 0.06),
      ],
      0.05,
      6,
      { caps: true },
    ),
    'chrome',
  )

  /*
    Navigation lights: red to port, green to starboard, white showing astern.
    The arrangement is a rule of the road, and having it backwards is the kind
    of thing exactly one person notices and then cannot stop noticing. Red and
    white ride the shared lamp slots so the day cycle lights them along with
    every other lamp in the world; green is a colour the kit does not have, so
    it gets one material of its own — made through `mats.paint`, which means
    `mats` owns and disposes it.
  */
  const NAV_Z = -3.55
  const navS = sectionAt(NAV_Z)
  const navY = navS.sheer - CAP_DROP + 0.06
  const navX = capInner(navS) * 0.9
  const lens = revolve([[0, 0], [0.075, 0.02], [0.08, 0.09], [0.05, 0.14], [0, 0.15]], 10)
  const navBody = revolve([[0.09, 0], [0.09, 0.08], [0.06, 0.1], [0, 0.1]], 10)
  B.add(navBody, 'trim', at(-navX, navY, NAV_Z))
  B.add(navBody, 'trim', at(navX, navY, NAV_Z))
  B.add(lens, 'lampRed', at(-navX, navY + 0.05, NAV_Z))

  // the all-round white, on a short pole set to starboard of the motor
  B.add(
    tube([new THREE.Vector3(0.78, 0.86, 6.3), new THREE.Vector3(0.78, 1.5, 6.3)], 0.045, 6, {
      caps: true,
    }),
    'chrome',
  )
  B.add(lens, 'lamp', at(0.78, 1.5, 6.3))

  // the transom bracket the outboard hangs off. It is bolted to the boat, so
  // it lives in the hull and does not swing with the steering
  B.add(slab(0.66, 0.5, 0.26, 0.05), 'chrome', at(0, 0.72, 6.35))

  const hull = B.build(mats.slots, { name: 'hull' })

  /* --------------------------------------------------------- the green lens */

  const green = mats.paint('#0d7a3a', { metallic: 0.1, roughness: 0.16 })
  green.emissive = new THREE.Color('#18ff72')
  green.emissiveIntensity = 0.25
  const GB = createPartBuilder()
  GB.add(lens, 'lamp', at(navX, navY + 0.05, NAV_Z))
  const greenLamp = GB.build({ lamp: green }, { name: 'navGreen' })

  /* ------------------------------------------------------------ the helm -- */

  /*
    The wheel is its own node because it turns. It is built with its axle
    along +z — a torus revolved about y, then laid over — so the node spins on
    `rotation.z` inside a parent that carries the console's rake and nothing
    has to unpick one rotation from the other.
  */
  const WB = createPartBuilder()
  {
    /*
      The rim, a torus. Its section is traced bottom-outer-top, not
      top-outer-bottom: `revolve` takes the profile's own winding for the
      surface's, so a section that circles the other way makes a rim whose
      faces all point into the tube. This one did, and unlike the shells above
      it was never passed through `flip()` — so the rim has been invisible
      from outside since it was written, which on a chrome ring against a
      white console is easy to read as a lighting quirk.
    */
    WB.add(
      revolve([[0.3, 0], [0.345, -0.045], [0.36, 0], [0.345, 0.045], [0.3, 0]], 14),
      'chrome',
      at(0, 0, 0, Math.PI / 2),
    )
    WB.add(
      revolve([[0, -0.07], [0.09, -0.06], [0.1, 0.05], [0, 0.08]], 10),
      'chrome',
      at(0, 0, 0, Math.PI / 2),
    )
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4
      WB.add(
        tube(
          [new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * 0.33, Math.sin(a) * 0.33, 0)],
          0.032,
          5,
        ),
        'chrome',
      )
    }
  }
  const helmSpin = WB.build(mats.slots, { name: 'wheel' })
  const helm = new THREE.Group()
  helm.name = 'helm'
  /*
    Where it hangs. The wheel used to sit at (0, 0.98, 1.04), which is inside
    the console: the aft skin at that height stands at z = 1.093, so the hub,
    both hands and the whole upper half of the rim — three o'clock round
    through twelve to nine — were buried in the moulding, and all that came
    out was the bottom of the rim and a sliver over the cap. Fifteen of
    twenty-one probe points tested inside the shell.

    So it moved aft *and* up, and both moves are load bearing. Aft of 1.15
    clears the skin, and 1.20 leaves 0.13 of daylight at the tightest point.
    The lift to 1.22 — a hair under CONSOLE_TOP, so the rim's upper half now
    stands proud of the cap the way a helm wheel actually does — is what keeps
    it out of the driver's thighs: the rim already cut 0.06 into them where it
    was, and going aft alone would have taken that to 0.16. It now clears.
    The hands (and the arms behind them) were re-solved onto the rim at the
    same time; they ride the same offset off the hub as before.
  */
  helm.position.set(0, 1.22, 1.2)
  helm.rotation.x = -0.42 // the wheel face tilts back toward the driver
  helm.add(helmSpin)

  /* -------------------------------------------------------- the outboard -- */

  /*
    The motor is its own node because it steers. An outboard has no rudder: it
    swivels the whole leg, and from astern that is the most legible thing the
    boat does. `outboard.rotation.y` is the same angle update() takes the
    thrust vector at, so what you see is what is pushing.
  */
  const OUT_Y = 0.95
  const OUT_Z = 6.45
  const MB = createPartBuilder()
  {
    // the cowling — the only part of the boat that is neither white nor steel
    const cowl: Station[] = [
      { z: -0.06, y: 0.3, ring: ringSuper(0.3, 0.2, 0.24, 4, 4, 14) },
      { z: 0.16, y: 0.3, ring: ringSuper(0.4, 0.27, 0.3, 4.5, 4.5, 14) },
      { z: 0.52, y: 0.28, ring: ringSuper(0.42, 0.28, 0.31, 4.5, 4.5, 14) },
      { z: 0.78, y: 0.24, ring: ringSuper(0.34, 0.22, 0.26, 4, 4, 14) },
    ]
    MB.add(loft(cowl, { capStart: 'flat', capEnd: 'flat' }), 'paint2')
    MB.both(() => {
      MB.add(slab(0.05, 0.12, 0.42, 0.02), 'dark', at(0.4, 0.3, 0.4))
    })

    // the midsection, a streamlined strut. Lofted up its own +z and then
    // rolled over: rx = +90 maps +z to -y, so the loft runs downward and the
    // section's +y becomes aft
    const leg: Station[] = [
      { z: 0, ring: ringSuper(0.21, 0.26, 0.2, 3, 3, 12) },
      { z: 0.62, ring: ringSuper(0.185, 0.24, 0.17, 3, 3, 12) },
      { z: 1.28, ring: ringSuper(0.17, 0.23, 0.16, 3, 3, 12) },
      { z: 1.73, ring: ringSuper(0.19, 0.25, 0.18, 3, 3, 12) },
    ]
    MB.add(loft(leg, { capStart: 'flat', capEnd: 'flat' }), 'metal', at(0, -0.05, 0.3, Math.PI / 2))

    // the anti-ventilation plate, set level with the keel line at the transom
    // so it skims the water the hull leaves behind rather than ploughing it
    MB.add(slab(0.84, 0.06, 0.92, 0.03), 'metal', at(0, -1.67, 0.12))

    // the gearcase: a torpedo with the shaft through it
    const gearcase: Station[] = [
      { z: -0.44, ring: ringSuper(0.06, 0.07, 0.07, 3, 3, 10) },
      { z: -0.18, ring: ringSuper(0.15, 0.16, 0.16, 3, 3, 10) },
      { z: 0.3, ring: ringSuper(0.17, 0.18, 0.18, 3, 3, 10) },
      { z: 0.58, ring: ringSuper(0.13, 0.14, 0.14, 3, 3, 10) },
    ]
    MB.add(loft(gearcase, { capStart: 'flat', capEnd: 'flat' }), 'metal', at(0, -1.95, 0.1))
    // the skeg, which is what actually hits the bottom first
    MB.add(slab(0.07, 0.3, 0.58, 0.03), 'metal', at(0, -2.1, 0.02))
  }
  const outboard = new THREE.Group()
  outboard.name = 'outboard'
  outboard.position.set(0, OUT_Y, OUT_Z)
  outboard.add(MB.build(mats.slots, { name: 'motor' }))

  const PB = createPartBuilder()
  {
    PB.add(
      revolve([[0, -0.1], [0.09, -0.1], [0.1, 0.02], [0.06, 0.14], [0, 0.16]], 10),
      'metal',
      at(0, 0, 0, Math.PI / 2),
    )
    for (let i = 0; i < 3; i++) {
      /*
        Three blades. `blade` lays its chord along z and its span along x, so
        an untwisted one stands edge-on to the disc — 90 degrees of pitch.
        Rolling it 1.30 rad about its own span brings that back to 15 degrees
        at the tip, and a twist of -0.22 (which washes out to nothing at the
        tip, so it only touches the root) opens the root to 28. Root coarser
        than tip is the right way round: the root sees a slower helix.

        The two rotations must compose in that order — pitch about the blade's
        own span, then clock it around the shaft — which is one more order
        than a single Euler can express, so the matrices are multiplied.
      */
      const a = (i / 3) * TAU
      PB.add(
        blade(0.25, { root: 0.13, tip: 0.1, thick: 0.3, twist: -0.22, steps: 4, roundTip: true }),
        'metal',
        at(0, 0, 0.02, 0, 0, a).multiply(at(0.05, 0, 0, 1.3)),
      )
    }
  }
  const prop = new THREE.Group()
  prop.name = 'prop'
  prop.position.set(0, -1.95, 0.7)
  prop.add(PB.build(mats.slots, { name: 'blades' }))
  outboard.add(prop)

  /* ----------------------------------------------------------- the driver -- */

  /*
    Somebody at the helm: perched on the leaning post, both hands on the
    wheel, eyes at (0, 2.35, 1.30) — the same point DriveView hands the
    camera, so the cockpit lens looks out of this figure's head rather than
    out of thin air beside it. Hidden until the player boards.
  */
  const DB = createPartBuilder()
  {
    const seatY = soleOf(sectionAt(1.75)).y + 0.95
    DB.both(() => {
      // thigh down-and-forward off the perch, shin down to the sole
      DB.add(bone(0.15, 0.13, 0.6), 'trim', at(0.17, seatY + 0.02, 1.52, -2.3))
      DB.add(bone(0.13, 0.11, 0.5), 'trim', at(0.17, seatY - 0.38, 1.07, -2.83))
      /*
        Upper arm and forearm, onto the wheel rim. The hand is the fixed end:
        it rides the same (0.28, 0.02, 0.04) off the hub it always did, so
        when the wheel moved aft and up out of the console the hand went with
        it and these two angles were re-solved for the new target rather than
        nudged. Shoulder (0.3, 2, 1.44) to hand (0.28, 1.24, 1.24) is 0.786 of
        the 1.04 the two bones have between them, so the elbow now stands out
        to windward instead of the arm hanging nearly straight down.
      */
      DB.add(bone(0.1, 0.09, 0.49), 'seat', at(0.3, 2, 1.44, -3.01, 0, -0.731))
      DB.add(bone(0.09, 0.08, 0.55), 'seat', at(0.627, 1.638, 1.392, -2.777, 0, 0.683))
      DB.add(revolve([[0, 0], [0.09, 0.05], [0.07, 0.13], [0, 0.15]], 8), 'trim', at(0.28, 1.24, 1.24))
    })
    const torso: Station[] = [
      { z: 0, ring: ringSuper(0.24, 0.16, 0.16, 3.5, 3.5, 12) },
      { z: 0.4, ring: ringSuper(0.27, 0.18, 0.18, 3.5, 3.5, 12) },
      { z: 0.92, ring: ringSuper(0.3, 0.19, 0.19, 3.5, 3.5, 12) },
      { z: 1.1, ring: ringSuper(0.2, 0.15, 0.15, 3, 3, 12) },
    ]
    DB.add(
      loft(torso, { capStart: 'flat', capEnd: 'flat' }),
      'seat',
      at(0, seatY + 0.02, 1.62, -Math.PI / 2 - 0.16),
    )
    DB.add(bone(0.1, 0.11, 0.16), 'trim', at(0, 1.95, 1.44))
    DB.add(
      revolve([[0, 0], [0.22, 0.1], [0.26, 0.26], [0.2, 0.42], [0, 0.5]], 10),
      'trim',
      at(0, 2.05, 1.36),
    )
  }
  const driver = DB.build(mats.slots, { name: 'driver' })
  driver.visible = false

  /* --------------------------------------------------------------- assembly */

  const root = new THREE.Group()
  root.name = 'boat'
  root.add(hull, greenLamp, helm, outboard, driver)
  markDynamic(root)

  /* ------------------------------------------------------------------ state */

  const pos = new THREE.Vector3()
  const vel = new THREE.Vector3()
  let yaw = 0
  let yawRate = 0
  let pitch = 0
  let roll = 0
  let steer = 0
  let throttle = 0
  let propAngle = 0
  let aground = false
  let resting = false

  const solid = new THREE.Box3() as Solid
  solid.noStand = true

  /*
    Where the hull asks what it is over. The first four are bow, stern, port
    and starboard — the flotation square, and the only ones the attitude is
    read from. The fifth is the deepest point of the keel amidships, and it
    exists purely because the other four are up on the turn of the bilge or
    out on the rockered ends: without it the middle of the keel, which is a
    third of a unit lower than the plane those four define, ploughs a furrow
    through the sand every time she takes the ground.

    The third number in each is the outside of the hull there, in model space.
  */
  const PROBE: Array<[number, number, number]> = [
    [0, -5, bottomAt(0, -5)],
    [0, 5, bottomAt(0, 5)],
    [-1.85, 0.6, bottomAt(-1.85, 0.6)],
    [1.85, 0.6, bottomAt(1.85, 0.6)],
    [0, 1.2, bottomAt(0, 1.2)],
  ]
  const NP = PROBE.length
  /** the pitch and roll arms the first four give us */
  const ARM_Z = 5
  const ARM_X = 1.85

  const sea = new Array<number>(NP).fill(0)
  const bed = new Array<number>(NP).fill(0)
  /** the height of whatever is holding the hull up at each probe */
  const surf = new Array<number>(NP).fill(0)
  /** the lowest the origin may sit before that probe is through the bed */
  const floors = new Array<number>(NP).fill(0)

  const step: DriveStep = {
    speed: 0, planar: 0, load: 0, rpm: 0, gear: 0, grounded: true, vy: 0,
    altitude: 0, slip: 0, braking: 0, surface: 'water', impact: 0, moved: false,
  }

  const tmp = new THREE.Vector3()

  /**
   * Ask the world what is under each of the four probes. Sea and bed are the
   * two candidates for support and the higher one wins, which is why one
   * expression covers afloat, aground, beached and parked in a field.
   *
   * Note what `surf` is and is not. It is the *height of the surface* at that
   * probe, and the attitude is read off differences between those heights —
   * not off the origin heights each probe would need in order to touch. That
   * distinction cost an afternoon: the hull's own bottom rises 0.7 units from
   * the transom to the bow, so a boat asked to put both probes on the sand
   * has to bury its stem four degrees down, and every beached boat sat there
   * nose first. A hull rests on its deepest point and lies along the ground;
   * only `floors` cares where the hull's bottom actually is.
   */
  const sample = (env: DriveEnv) => {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const w = env.waterY
    for (let i = 0; i < NP; i++) {
      const [lx, lz, ly] = PROBE[i]
      const wx = pos.x + lx * c + lz * s
      const wz = pos.z - lx * s + lz * c
      sea[i] = w === undefined ? -Infinity : w + env.waveAt(wx, wz)
      // reach only a little above where this probe is: a box top over the
      // boat's head is a bridge, not a sea bed
      bed[i] = groundUnder(wx, wz, pos.y + ly + 0.6, env)
      surf[i] = Math.max(sea[i], bed[i])
    }
  }

  /** where each probe's hull bottom would touch, at the attitude she is lying
      at right now: pitch lifts a point at -z, roll lifts a point at +x */
  const bedFloors = () => {
    const sp = Math.sin(pitch)
    const sr = Math.sin(roll)
    let hi = -Infinity
    for (let i = 0; i < NP; i++) {
      const [lx, lz, ly] = PROBE[i]
      floors[i] = bed[i] - ly + lz * sp - lx * sr
      if (floors[i] > hi) hi = floors[i]
    }
    return hi
  }

  const meanOf = (a: number[]) => {
    let t = 0
    for (let i = 0; i < NP; i++) t += a[i]
    return t / NP
  }

  const writeTransform = () => {
    root.position.copy(pos)
    // YXZ: yaw outermost, then pitch about the yawed athwartships axis, then
    // roll about the hull's own fore-and-aft axis. Any other order rolls the
    // boat about a world axis and it wobbles like a compass card
    root.rotation.set(pitch, yaw, roll, 'YXZ')
    const c = Math.abs(Math.cos(yaw))
    const s = Math.abs(Math.sin(yaw))
    solid.min.set(
      pos.x - (HALF_BEAM * c + HALF_LEN * s),
      pos.y - KEEL,
      pos.z - (HALF_BEAM * s + HALF_LEN * c),
    )
    solid.max.set(
      pos.x + (HALF_BEAM * c + HALF_LEN * s),
      pos.y + TOPS,
      pos.z + (HALF_BEAM * s + HALF_LEN * c),
    )
  }

  const settle = (env: DriveEnv) => {
    sample(env)
    pitch = clamp((surf[0] - surf[1]) / (2 * ARM_Z), -0.4, 0.4)
    roll = clamp((surf[3] - surf[2]) / (2 * ARM_X), -0.4, 0.4)
    pos.y = Math.max(meanOf(sea), bedFloors())
    vel.set(0, 0, 0)
    yawRate = 0
    writeTransform()
  }

  /* ------------------------------------------------------------------ tick */

  const update = (env: DriveEnv, driven: boolean): DriveStep => {
    // a guard, not a substep: the caller already hands us <= 1/90 s, but if a
    // tab is restored after a stall we would rather crawl than teleport
    const dt = Math.min(env.dt, 0.05)
    if (dt <= 0) return step

    const key = axes(env.keys, env.frozen || !driven)
    // an outboard's throttle is a lever you push and the helm is a couple of
    // turns lock to lock: neither of them snaps
    throttle = damp(throttle, key.fwd, 3.2, dt)
    steer = damp(steer, key.side, 5.5, dt)

    sample(env)

    const seaMean = meanOf(sea)
    const floor = bedFloors()
    /*
      Afloat means there is water here worth the name — a fifth of a unit
      (10 cm) of it over the mean bed under her — and not that she is clear of
      the bottom. Those are different questions and the first one is the one
      that matters: a boat sitting on a shoal with her stern in half a unit of
      water is aground, but she is still a boat, still has a propeller in the
      water and can still be backed off, and that is the whole interesting
      case. The earlier test compared the sea to the height she would rest at,
      which folded her own draft into it and left her welded to the shoal.
    */
    const afloat = env.waterY !== undefined && seaMean - meanOf(bed) > 0.2

    // clearance under the hull, forward and aft, before anything moves. The
    // keel probe counts in both: it is amidships and it is the deepest point
    let clearFwd = Infinity
    let clearAft = Infinity
    for (let i = 0; i < NP; i++) {
      const c = pos.y - floors[i]
      if (i !== 1) clearFwd = Math.min(clearFwd, c)
      if (i !== 0) clearAft = Math.min(clearAft, c)
    }

    /* ---- heave: a spring toward the surface, and weight ----------------- */

    const sink = seaMean - pos.y
    // buoyancy is zero with the keel clear of the water, exactly balances
    // weight at the resting draft, and grows linearly past it — capped,
    // because a hull dropped from a height must not be fired back out
    const buoy = clamp(1 + sink / KEEL, 0, 3)
    const wet = clamp(1 + sink / KEEL, 0, 1)
    vel.y += (G * buoy - G - HEAVE_DAMP * vel.y * wet) * dt
    pos.y += vel.y * dt

    let impact = 0
    if (pos.y < floor) {
      // the bed is a floor under the spring rather than another force inside
      // it: no stiffness to tune, nothing to oscillate, nothing to sink
      // through, and a boat sitting on sand is exactly still
      if (!resting && -vel.y > 1) impact = -vel.y
      pos.y = floor
      if (vel.y < 0) vel.y = 0
      resting = true
    } else {
      resting = false
    }

    /* ---- attitude: lie on whatever is holding us up -------------------- */

    let pitchWant = clamp((surf[0] - surf[1]) / (2 * ARM_Z), -0.45, 0.45)
    let rollWant = clamp((surf[3] - surf[2]) / (2 * ARM_X), -0.45, 0.45)

    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const rx = Math.cos(yaw)
    const rz = -Math.sin(yaw)
    const u = vel.x * fx + vel.z * fz
    const v = vel.x * rx + vel.z * rz
    const speed = Math.abs(u)
    const planing = afloat ? smoothstep(PLANE_LO, PLANE_HI, speed) : 0

    /*
      Trim. Under power a hull squats and lifts its bow, most of all right at
      the hump where it is climbing its own bow wave; once it is planing it
      settles back to a couple of degrees. None of this is a force — it is
      where the boat *sits* — so it is added to the angle the water asks for.
    */
    if (afloat && throttle > 0) {
      const hump = Math.exp(-(((speed - 17) / 6) ** 2))
      pitchWant += throttle * (0.05 + 0.1 * hump) - planing * 0.035
    }
    if (afloat) {
      rollWant += clamp(HEEL * yawRate * Math.min(1, speed / 18), -HEEL_MAX, HEEL_MAX)
    }
    // a hull answers the sea in about a fifth of a second, and a hull sitting
    // on a beach has stopped arguing entirely, so one rate does for both
    pitch = damp(pitch, pitchWant, 6, dt)
    roll = damp(roll, rollWant, 5, dt)

    /* ---- surge, sway and yaw ------------------------------------------- */

    if (afloat) {
      // the propeller has to be in the water to do anything at all, and it is
      // measured against the stern's own surface, so a boat that has backed
      // its transom onto sand simply loses its engine
      const bite = clamp((sea[1] - (pos.y - PROP_Y)) / PROP_BITE, 0, 1)
      const rud = steer * MAX_RUD
      const thrust = (throttle > 0 ? throttle * THRUST : throttle * THRUST_REV) * bite

      // thrust vectoring: the leg swings, the stern is pushed the way the
      // propeller points, and the bow goes the other way
      const au = thrust * Math.cos(rud)
      const av = -thrust * Math.sin(rud)

      // resistance. Displacement below the hump, planing above it, and the
      // crossfade between the two coefficients IS the two-phase acceleration
      const cd = throttle < 0 && u <= 0 ? CD_REV : lerp(CD_DISPL, CD_PLANE, planing)
      /*
        The bottom touching: a soft graze from half a unit of clearance down to
        a dead stop on the sand. Which end of the hull bites depends on which
        way she is *trying* to go, so a boat with her bow up a beach can still
        back off — and once she is stopped there is no `u` to read that from,
        which is why the direction falls back to the thrust. Without that
        fallback the stick term below reads the buried bow while the propeller
        is trying to pull the boat off by the stern, and she never comes off.
      */
      const dir = Math.abs(u) > 0.05 ? Math.sign(u) : Math.sign(au)
      const graze = clamp((SCRAPE - (dir >= 0 ? clearFwd : clearAft)) / SCRAPE, 0, 1)
      // how fast the bed rises the way she is trying to go, per unit travelled
      const uphill = ((bed[0] - bed[1]) / (2 * ARM_Z)) * (dir >= 0 ? 1 : -1)
      const hold = clamp(
        (dir >= 0 ? HOLD_AHEAD : HOLD_ASTERN) + uphill * HOLD_SLOPE,
        0.1,
        1.3,
      )
      const resist =
        ((cd * speed + CD_LIN) * speed +
          (SCRAPE_DRAG * graze * speed + SCRAPE_STICK * graze * graze) * hold) *
        dt

      // thrust first, then resistance clamped to what is actually there:
      // drag that can overshoot zero is drag that drives a boat backwards
      let nu = u + au * dt
      nu -= Math.sign(nu) * Math.min(Math.abs(nu), resist)
      let nv = v + av * dt
      nv -= Math.sign(nv) * Math.min(Math.abs(nv), (SIDE_LIN + SIDE_QUAD * Math.abs(v)) * Math.abs(v) * dt)

      vel.x = fx * nu + rx * nv
      vel.z = fz * nu + rz * nv

      const yawAcc =
        (-LEVER * thrust * Math.sin(rud) - WEATHER * v * speed) / IY -
        (YAW_LIN + YAW_QUAD * speed) * yawRate
      yawRate += yawAcc * dt
      yaw += yawRate * dt

      // "aground" is latched with hysteresis: the bottom starts biting well
      // before the hull is actually resting on it, and a flag that chattered
      // would report an impact every other tick in the surf
      if (graze > 0.5) {
        if (!aground && speed > 1.5) impact = Math.max(impact, speed)
        aground = true
      } else if (graze < 0.25) {
        aground = false
      }
    } else {
      /*
        Dry land. Nothing to push against and nothing to float in, so the boat
        is furniture: bleed off whatever motion is left over a couple of
        tenths and then snap it to nothing, because a hull shivering on a
        beach at 0.01 u/s is the one artefact everybody sees.
      */
      const k = Math.exp(-9 * dt)
      vel.x *= k
      vel.z *= k
      yawRate *= k
      if (Math.abs(vel.x) < 0.02) vel.x = 0
      if (Math.abs(vel.z) < 0.02) vel.z = 0
      if (Math.abs(yawRate) < 0.004) yawRate = 0
      yaw += yawRate * dt
      aground = true
    }

    pos.x += vel.x * dt
    pos.z += vel.z * dt

    /* ---- and anything solid in the way --------------------------------- */

    const hit = sweepBody(
      pos, yaw, HALF_BEAM * 0.86, HALF_LEN * 0.94, pos.y - KEEL, pos.y + 0.9, env.collision,
    )
    if (hit.depth > 0) {
      pos.x += hit.push.x
      pos.z += hit.push.z
      tmp.set(hit.push.x, 0, hit.push.z).normalize()
      const closing = -(vel.x * tmp.x + vel.z * tmp.z)
      if (closing > 0) {
        impact = Math.max(impact, closing)
        // the normal component comes out and 60% of it goes back in: a hull
        // hitting a piling stops, it does not stick to it
        vel.x += tmp.x * closing * 1.6
        vel.z += tmp.z * closing * 1.6
      }
      // a glancing blow on one quarter also turns the boat, which is what
      // makes scraping a rock feel like scraping a rock
      yawRate += clamp((hit.at.z * hit.push.x - hit.at.x * hit.push.z) * 0.06, -0.6, 0.6)
    }

    writeTransform()

    /* ---- report -------------------------------------------------------- */

    const uNow = vel.x * fx + vel.z * fz
    const vNow = vel.x * rx + vel.z * rz
    const planar = Math.hypot(vel.x, vel.z)
    step.speed = uNow
    step.planar = planar
    step.load = clamp(planar / TOP, 0, 1)
    step.rpm = afloat ? clamp(0.1 + 0.55 * Math.abs(throttle) + 0.35 * (planar / TOP), 0, 1) : 0
    step.gear = 0
    step.grounded = true
    step.vy = vel.y
    step.altitude = Math.max(0, pos.y - Math.max(seaMean, floor))
    step.slip = planar > 0.3 ? clamp(Math.abs(vNow) / planar, 0, 1) : 0
    step.braking = throttle < -0.05 && uNow > 0.5 ? clamp(-throttle, 0, 1) : 0
    step.surface = afloat && !aground ? 'water' : env.surfaceAt(pos.x, pos.z)
    step.impact = impact
    step.moved = planar > 0.02 || Math.abs(vel.y) > 0.02 || Math.abs(yawRate) > 0.002

    /* ---- and drive what the eye can see -------------------------------- */

    outboard.rotation.y = steer * MAX_RUD
    helmSpin.rotation.z = -steer * 2.6 // a bit under two turns of lock
    propAngle = (propAngle + step.rpm * 30 * dt) % TAU
    prop.rotation.z = propAngle

    return step
  }

  /* ------------------------------------------------------------- the rest -- */

  const placeAt = (x: number, z: number, heading: number, env: DriveEnv) => {
    pos.set(x, env.waterY ?? env.groundAt(x, z) + KEEL, z)
    yaw = heading
    steer = 0
    throttle = 0
    aground = false
    resting = false
    // twice: the first pass finds roughly where the surface is, the second
    // resamples with the hull already near it, which matters on a slope
    settle(env)
    settle(env)
  }

  /**
   * Somewhere to stand the driver down. Dry land within about nine units is
   * always preferred — three rings, nearest first, wanting ground clear of
   * the waterline and clear of anything solid. Failing that the player goes
   * into the water alongside at the height the walk controller's swim floats
   * a body (waterY + 0.8 - eye), which is a perfectly good way to leave a
   * boat and half the reason swimming is implemented at all.
   */
  const exitSpot = (out: THREE.Vector3, env: DriveEnv) => {
    const w = env.waterY
    for (const r of [4.2, 6.2, 8.4]) {
      for (let i = 0; i < 8; i++) {
        // start abeam to port and work round: you step off the side of a
        // boat, not over the bow
        const a = yaw + Math.PI / 2 + (i % 2 ? -1 : 1) * Math.floor((i + 1) / 2) * 0.72
        const x = pos.x + Math.sin(a) * r
        const z = pos.z + Math.cos(a) * r
        const g = env.groundAt(x, z)
        if (w !== undefined && g < w + 0.25) continue
        if (!clearAt(x, z, 1.1, g, g + 3.6, env.collision)) continue
        out.set(x, g, z)
        return g
      }
    }
    const a = yaw + Math.PI / 2
    const x = pos.x + Math.sin(a) * 3.4
    const z = pos.z + Math.cos(a) * 3.4
    const g = env.groundAt(x, z)
    const feet = w === undefined ? g : Math.max(g, w - 2.75)
    out.set(x, feet, z)
    return feet
  }

  const setDay = (day: number, night: number) => {
    // the shared lamp slots are the day cycle's business; the one material
    // this boat owns has to be told the same story by hand
    green.emissiveIntensity = 0.2 + night * 1.9
    green.envMapIntensity = 0.16 + 0.94 * day
  }

  const dispose = () => {
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.geometry.dispose()
    })
    // `green` came out of mats.paint(), which registered it for disposal there
  }

  return {
    id: 'boat',
    label: 'boat',
    verb: 'board',
    root,
    view: {
      back: 13,
      up: 4.2,
      stretch: 4,
      fov: 64,
      anchor: new THREE.Vector3(0, 1.2, 0.6),
      eye: new THREE.Vector3(0, 2.35, 1.3),
    },
    size: { halfX: 2.3, halfZ: 6.5, height: 2.6 },
    hull: HULL,
    get yaw() {
      return yaw
    },
    solid,
    reach: 5,
    placeAt,
    mount: () => {
      driver.visible = true
    },
    dismount: () => {
      driver.visible = false
    },
    exitSpot,
    update,
    setDay,
    dispose,
  }
}
