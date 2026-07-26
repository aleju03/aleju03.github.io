import { clamp01, mix, noise2, rand2, siteOf, smoothstep } from './noise'
import { elevationAt, habitabilityAt, terraceAt, SEA_Y } from './land'
import { CHUNK, OFF_X, OFF_Z } from './grid'

/*
  Where people live, and the streets they laid.

  One jittered site per 2600-unit cell, ranked by a hash roll into a hamlet, a
  town or a city, and thrown away entirely if land.ts says the ground is sea,
  cliff or riverbed. Lookups only ever consult the 3x3 cells around a point, so
  "is there a town here" stays O(1) no matter how far the player has walked —
  and because the answer is a pure function of the cell coordinates, the same
  city is in the same place whether you arrive from the north or the south.

  Inside a settlement, distance from the centre picks a district the way real
  land value does: towers at the middle, mid-rise blocks around them, houses
  and yards at the edge. The rim is warped by a noise ring so a city reads as a
  sprawl rather than a dartboard.

  Streets are the chunk grid itself (grid.ts), which is the whole trick behind
  never having to reconcile a road with a chunk seam: every road runs along a
  chunk border, so a block is exactly one chunk and a building is always
  interior to one. Two of those lines — the pair nearest the centre — keep
  going past the town limit as the roads out, which is what gives the player
  something to follow into the countryside. The full lattice reads as graph
  paper from the pavement, though — every junction a four-way, every block one
  chunk — so segAliveK drops whole chunk-edge segments by hash: the grid keeps
  its downtown mesh and frays toward the rim into T-junctions, corners, dead
  ends and double blocks. The spines never drop, and neither does anything
  near the authored home block.

  The home town is hand-placed rather than rolled: an unwarped disc centred
  well north of the house, sized so the property lands squarely in the suburb
  ring with the mid-rise blocks a couple of streets up and downtown a few
  minutes' walk further. Its terrace is pinned to y=0, because the house floor
  is y=0 and no amount of procedural charm is worth a doorstep that floats.
*/

export type District = 'downtown' | 'midrise' | 'suburb'

export interface Town {
  x: number
  z: number
  /** nominal radius; the rim is warped around it */
  radius: number
  rank: 'hamlet' | 'town' | 'city'
  /** stable per-town seed for everything built inside it */
  seed: number
  /** true for the one town the house sits in — never warped, always at y=0 */
  home: boolean
}

export interface Place {
  town: Town | null
  /** distance to the centre over the warped rim radius: <1 is inside */
  d: number
  district: District | null
  /** the height the graded ground is heading for */
  padY: number
}

const SITE_CELL = 2600
const S_SITE = 0x6b17
const S_RIM = 0x2fd9

/** the one authored settlement. Centre and radius are chosen so the property
    at the origin lands at d ~= 0.65 — comfortably inside the suburb ring, two
    blocks short of the mid-rise, and about five north of downtown. The first
    cut ran a 1080 radius, which is a fifteen-minute walk of city in every
    direction: at walking pace it read as endless, which is the one thing a
    city on an actually endless plane must never be. At 520 the whole thing —
    lawn, downtown, far rim — is a stroll, and the countryside shows up while
    the skyline is still worth turning around for. */
const HOME: Town = {
  x: 0,
  z: -340,
  radius: 520,
  rank: 'city',
  seed: 0x4a1e,
  home: true,
}

/** how far out of town the spine roads run, as a multiple of the radius */
const SPINE_REACH = 2.4

/* --------------------------------------------------------------- siting -- */

const siteCache = new Map<string, Town | null>()

/** the settlement owned by one cell of the site grid, or null if that cell
    rolled empty or drew unbuildable ground. Memoized: the habitability probe
    behind it costs five elevation samples, and this is asked per terrain
    vertex. */
const townOfCell = (cx: number, cz: number): Town | null => {
  const key = `${cx},${cz}`
  const hit = siteCache.get(key)
  if (hit !== undefined) return hit
  let town: Town | null = null
  if (cx === 0 && cz === 0) {
    town = HOME
  } else {
    const site = siteOf(cx, cz, SITE_CELL, S_SITE)
    // don't crowd the authored town — a rolled city overlapping it would put
    // towers through the neighbourhood
    const nearHome = Math.hypot(site.x - HOME.x, site.z - HOME.z) < HOME.radius + 900
    if (!nearHome && site.roll >= 0.4 && habitabilityAt(site.x, site.z) > 0.34) {
      const r = rand2(cx, cz, S_SITE ^ 0x77c1)
      town =
        site.roll > 0.93
          ? { x: site.x, z: site.z, radius: 700 + r * 320, rank: 'city', seed: 0, home: false }
          : site.roll > 0.72
            ? { x: site.x, z: site.z, radius: 300 + r * 190, rank: 'town', seed: 0, home: false }
            : { x: site.x, z: site.z, radius: 120 + r * 90, rank: 'hamlet', seed: 0, home: false }
      town.seed = (cx * 73856093) ^ (cz * 19349663) ^ 0x51ed
    }
  }
  siteCache.set(key, town)
  return town
}

/** the rim radius in a given direction: a warped ring so a city sprawls along
    some axes and stops short on others. The home town opts out — its district
    rings have to be exactly where the house was placed against them. */
const rimRadius = (t: Town, dx: number, dz: number, dist: number) => {
  if (t.home || dist < 1e-4) return t.radius
  const a = Math.atan2(dz, dx)
  const w = noise2(Math.cos(a) * 2.4 + 8, Math.sin(a) * 2.4 - 3, S_RIM ^ t.seed)
  return t.radius * (0.74 + w * 0.52)
}

const EMPTY: Place = { town: null, d: 99, district: null, padY: 0 }

/**
 * Which settlement claims this point, and how strongly. Returns the nearest
 * town whose rim contains the point; failing that, the nearest one at all
 * (with d > 1), so callers can still ask "how close to town is this".
 */
export const placeAt = (x: number, z: number): Place => {
  const cx = Math.floor(x / SITE_CELL)
  const cz = Math.floor(z / SITE_CELL)
  let best: Town | null = null
  let bestD = Infinity
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const t = townOfCell(cx + dx, cz + dz)
      if (!t) continue
      const ox = x - t.x
      const oz = z - t.z
      const dist = Math.hypot(ox, oz)
      const d = dist / rimRadius(t, ox, oz, dist)
      if (d < bestD) {
        bestD = d
        best = t
      }
    }
  if (!best) return EMPTY
  const district: District | null =
    bestD >= 1 ? null : bestD < 0.26 ? 'downtown' : bestD < 0.58 ? 'midrise' : 'suburb'
  return { town: best, d: bestD, district, padY: padYAt(x, z, best) }
}

/**
 * A settlement's grading applied to a raw ground height: flat on the shelf
 * through the built-up area, then an ease back into the landform past the
 * last building. The ease is measured in world units and stretched by how
 * tall the bank actually is — the first cut eased over a fixed slice of the
 * town's radius, which was fine in gentle country and a quarry face where a
 * mountain range ran along the rim: a hamlet against a 150-unit ridge got the
 * same 40-unit skirt as one on a meadow. Scaling the run with the rise caps
 * the bank near 25 degrees however big the hill, so a town in the mountains
 * meets them as a climbable mountainside rather than a wall.
 */
export const townGradedHeight = (place: Place, rawH: number) => {
  const t = place.town
  if (!t) return rawH
  // how far past the built rim this point stands, in units (the warped rim
  // makes t.radius approximate off the home town, which is close enough for
  // the length of an embankment)
  const past = (place.d - 0.9) * t.radius
  if (past <= 0) return place.padY
  const diff = rawH - place.padY
  const ease = 70 + Math.min(560, Math.abs(diff) * 2.4)
  if (past >= ease) return rawH
  const eased = mix(rawH, place.padY, 1 - smoothstep(0, ease, past))
  // ...held under a plane climbing from the shelf at ~27 degrees. The eased
  // blend alone is gentle on average but its midpoint runs half again the
  // mean pitch, which against the 300-unit range on the home town's west
  // rim measured 54 degrees; the plane is the guarantee the blend lacks
  const plane = place.padY + Math.sign(diff) * 0.5 * past
  return diff > 0 ? Math.min(eased, plane) : Math.max(eased, plane)
}

/**
 * The height a settlement's graded ground is heading for. It follows the
 * continental terrace rather than pinning to one number, so a town is a
 * gently sloping shelf cut into the landform instead of a mesa with a rim
 * around it — over a kilometre-wide city the terrace moves by a couple of
 * dozen units, about a degree, which reads as "the ground here is flat" while
 * still belonging to the hillside it sits on.
 *
 * The home town is the same shelf shifted so it passes through exactly zero
 * at the origin. The house is authored at y=0 and the doorstep is not
 * negotiable; everything else bends around that.
 */
const HOME_DATUM = terraceAt(0, 0)

const padYAt = (x: number, z: number, t: Town) =>
  t.home
    ? terraceAt(x, z) - HOME_DATUM
    : Math.max(SEA_Y + 2.6, terraceAt(x, z) + 1.4)

/* ---------------------------------------------------------------- roads -- */

/** asphalt half-width. 6.4 units door to door, which is what the street in
    front of the house has always been */
export const ROAD_HALF = 3.2
/** sidewalk width outside the curb */
export const WALK_W = 1.5
/** curb height; low enough that the walk steps up it without a jump */
export const CURB_H = 0.15
/**
 * How far out the ground is graded flat for a road (asphalt + walk + verge).
 *
 * This is measured in lattice cells, not in taste. The terrain mesh has a
 * vertex every GRID units and a road centreline always lands on one, so the
 * corridor is only truly flat out to the last *vertex* it pins: at 6.1 the
 * vertex at 8 was still half-graded, the triangle between 4 and 8 sloped back
 * up through the kerb, and the pavement grew a row of terrain teeth along its
 * outer edge. Two whole cells (8.2) pins the vertices at 0, 4 and 8, which
 * puts the last of them a comfortable 3.5 clear of the pavement's edge.
 */
export const CORRIDOR = 8.2
/** and how long the ramp back to natural ground is at minimum. Two cells, so
    the shoulder is a bank rather than a step — terrain.ts stretches the run
    further where the corridor cuts deep, exactly the way the town skirt does */
export const CORRIDOR_EASE = 8
/** the widest a road's earthwork can get (terrain.ts's REACH); roadAt keeps
    answering out to CORRIDOR + this so heightAt can shape the whole
    embankment, and it must stay inside the half-chunk the nearest-line
    lookup can see */
const EASE_REACH = 22

/** one street's claim on a point: its centreline and how present it is */
export interface RoadArm {
  axis: 'x' | 'z'
  /** the constant coordinate of the centreline (its z for an 'x' road).
      terrain.ts grades a road level across its width by sampling the ground
      on this line, so a country road follows the hills lengthways and stays
      flat underfoot the way a real one is cut. */
  line: number
  /** distance from the centreline, in units */
  dist: number
  /** the street's presence before the cross-corridor falloff — heightAt
      rebuilds its own, depth-aware falloff from this */
  live: number
  /** how much street continues along the line before it stops — Infinity in
      the middle of a live run, the distance to the last node where the next
      segment dropped out or the town ends. The earthwork tapers on it: a
      street's bench released to nothing by its final node, instead of the
      4-to-16-unit scarp it otherwise leaves standing across the junction
      plane wherever a graded street dead-ends on a hillside. */
  end: number
}

export interface Road {
  /** 0 no road .. 1 full corridor: what the terrain grades toward */
  grade: number
  /** distance from the nearest active centreline, in units */
  dist: number
  /** the road runs along this axis ('x' = an east-west street) */
  axis: 'x' | 'z' | null
  /** the winner's centreline (see RoadArm.line) */
  line: number
  /** the winner's pre-falloff presence (see RoadArm.live) */
  live: number
  /** the winner's remaining live run along its line (see RoadArm.end) */
  end: number
  /** the crossing street's claim, where a second one is in earthwork range.
      heightAt applies both arms in a fixed axis order: which street is
      *nearest* flips along the diagonal of every block corner, and ground
      that followed only the winner stepped seven units where that flip
      crossed a graded skirt — the two streets sit at different levels there */
  other: RoadArm | null
  /** inside the asphalt */
  asphalt: boolean
  /** on the sidewalk slab */
  walk: boolean
  /** both an east-west and a north-south street claim this point */
  junction: boolean
}

const NO_ROAD: Road = {
  grade: 0, dist: 1e9, axis: null, line: 0, live: 0, end: Infinity, other: null,
  asphalt: false, walk: false, junction: false,
}

/*
  How steep the ground under a road may get before the tarmac gives out.

  Roads used to be unconditional along their lines, and the terrain paid for
  it: first as slot canyons (the corridor grading cut through any ridge in the
  way — capped now in terrain.ts), then, with the cut capped, as asphalt
  climbing a hillside like a ramp nailed to a wall. The honest behaviour is
  the one real roads have: they end at the foot of ground too steep to pave.

  Measured off the *graded* profile — raw elevation with the town skirt
  applied — in coarse cells and memoized by cell, because roadAt runs per
  terrain vertex and elevationAt is the expensive field stack. Grading is the
  point: inside a town the shelf has flattened whatever the raw field says,
  so the gate passes by construction, and on the skirt it reads the actual
  embankment the road would have to climb. The first version instead read raw
  ground and blended the fade out wherever town grading was active — which
  forced the spine up the rim bank at whatever pitch the hillside had, and
  with a range along the rim that was a lamp-lit ramp nailed to a cliff.
*/
const STEEP_CELL = 24
const steepCache = new Map<number, number>()

const gradedAt = (x: number, z: number) => townGradedHeight(placeAt(x, z), elevationAt(x, z))

const steepCellK = (axis: 'x' | 'z', line: number, cell: number) => {
  const lineIdx = Math.round((line - (axis === 'z' ? OFF_X : OFF_Z)) / CHUNK)
  const key = ((lineIdx + 32768) * 262144 + (cell + 100000)) * 2 + (axis === 'z' ? 1 : 0)
  const hit = steepCache.get(key)
  if (hit !== undefined) return hit
  const mid = cell * STEEP_CELL
  const h0 = axis === 'z' ? gradedAt(line, mid - 14) : gradedAt(mid - 14, line)
  const h1 = axis === 'z' ? gradedAt(line, mid + 14) : gradedAt(mid + 14, line)
  const k = smoothstep(0.52, 0.3, Math.abs(h1 - h0) / 28)
  if (steepCache.size > 40000) steepCache.clear()
  steepCache.set(key, k)
  return k
}

/** the gate at `s`, interpolated between the enclosing cell centres: the
    per-cell value steps at every cell border, and a step in the gate is a
    step in the earthwork under it — a scarp drawn across the verge for no
    reason the walker can see */
const roadSteepK = (axis: 'x' | 'z', line: number, s: number) => {
  const u = s / STEEP_CELL - 0.5
  const c0 = Math.floor(u)
  return mix(steepCellK(axis, line, c0), steepCellK(axis, line, c0 + 1), u - c0)
}

/*
  Which streets of a town's lattice actually got built, decided per segment —
  one chunk edge between two junctions, hashed by its lattice identity so
  every chunk that touches it agrees. Downtown keeps most of its mesh, the
  rings toward the rim lose more, so the grid frays outward the way city
  tissue does: T-junctions, corners, dead-ended lanes, blocks that run double.
  The two spine lines are exempt (they are the roads out, and a main street
  that randomly stopped would strand the whole design), and so is everything
  near the origin: the approach to the authored property is not the
  generator's to edit.
*/
const S_SEG = 0x9d43
const segCache = new Map<number, number>()

const segAliveK = (axis: 'x' | 'z', line: number, s: number) => {
  const offL = axis === 'z' ? OFF_X : OFF_Z
  const offS = axis === 'z' ? OFF_Z : OFF_X
  const lineIdx = Math.round((line - offL) / CHUNK)
  const segIdx = Math.floor((s - offS) / CHUNK)
  const key = ((lineIdx + 32768) * 131072 + (segIdx + 32768)) * 2 + (axis === 'z' ? 1 : 0)
  const hit = segCache.get(key)
  if (hit !== undefined) return hit
  const mid = offS + (segIdx + 0.5) * CHUNK
  const mx = axis === 'z' ? line : mid
  const mz = axis === 'z' ? mid : line
  let alive = 1
  if (Math.max(Math.abs(mx), Math.abs(mz)) > 110) {
    const p = placeAt(mx, mz)
    if (p.district) {
      const drop = p.district === 'downtown' ? 0.12 : p.district === 'midrise' ? 0.3 : 0.42
      if (rand2(lineIdx, segIdx, S_SEG ^ (axis === 'z' ? 0x5b : 0xa7)) < drop) alive = 0
    }
  }
  if (segCache.size > 40000) segCache.clear()
  segCache.set(key, alive)
  return alive
}

/** distance along the line to where the street's live run *hard-stops* — a
    neighbouring segment dropped from the lattice — if one is close enough
    for the earthwork taper to care. Only the binary source of street ends
    counts here: the town-rim and steepness fades are already continuous in
    `live`, and a taper keyed on them double-counts and, worse, disagrees
    with them at nodes (a segment straddling the rim is "off" by its
    midpoint but half-live at its near end, and the earthwork stepped where
    the two answers met). */
const armEndAt = (axis: 'x' | 'z', line: number, s: number): number => {
  const offS = axis === 'z' ? OFF_Z : OFF_X
  const segIdx = Math.floor((s - offS) / CHUNK)
  const base = offS + segIdx * CHUNK
  const u = s - base
  let end = Infinity
  if (u < 34 && segAliveK(axis, line, base - CHUNK / 2) === 0) end = u
  if (CHUNK - u < 34 && segAliveK(axis, line, base + CHUNK * 1.5) === 0) {
    end = Math.min(end, CHUNK - u)
  }
  return end
}

/** the grid line nearest a coordinate, on the chunk lattice */
const nearestLine = (v: number, off: number) => off + Math.round((v - off) / CHUNK) * CHUNK

/**
 * The street network at a point. Inside a settlement every chunk border is a
 * street; outside, only the two spine lines through the centre survive, and
 * they fade out as they run into the countryside so a road never ends in a
 * blunt rectangle of asphalt.
 */
export const roadAt = (x: number, z: number, place: Place): Road => {
  const t = place.town
  if (!t) return NO_ROAD
  const lineX = nearestLine(x, OFF_X)
  const lineZ = nearestLine(z, OFF_Z)
  const dToNS = Math.abs(x - lineX) // to a street running north-south
  const dToEW = Math.abs(z - lineZ) // to a street running east-west

  // how present each street is here: everywhere in town — fading out through
  // the start of the skirt rather than stopping dead on the rim curve, since
  // a binary edge here is a wall in the earthwork under the street's end —
  // and along the two spines for a while past the town limit
  const spineX = nearestLine(t.x, OFF_X)
  const spineZ = nearestLine(t.z, OFF_Z)
  const reach = t.radius * SPINE_REACH
  const inTown = smoothstep(1.1, 1.0, place.d)
  const nsLive = Math.max(
    inTown,
    lineX === spineX ? smoothstep(reach, reach * 0.82, Math.abs(z - t.z)) : 0,
  )
  const ewLive = Math.max(
    inTown,
    lineZ === spineZ ? smoothstep(reach, reach * 0.82, Math.abs(x - t.x)) : 0,
  )
  if (nsLive <= 0 && ewLive <= 0) return NO_ROAD

  // a hamlet gets a single crossroads, not a full grid: suppress any line
  // that isn't a spine — and elsewhere the lattice frays by dropped segments
  const ns0 = t.rank === 'hamlet' && lineX !== spineX ? 0 : nsLive
  const ew0 = t.rank === 'hamlet' && lineZ !== spineZ ? 0 : ewLive
  const ns = ns0 > 0 && lineX !== spineX ? ns0 * segAliveK('z', lineX, z) : ns0
  const ew = ew0 > 0 && lineZ !== spineZ ? ew0 * segAliveK('x', lineZ, x) : ew0

  // spines never drop segments, so they never taper on a neighbour's roll
  const nsArm: RoadArm | null =
    ns > 0 && dToNS <= CORRIDOR + EASE_REACH
      ? {
          axis: 'z', line: lineX, dist: dToNS,
          live: ns * roadSteepK('z', lineX, z),
          end: lineX === spineX ? Infinity : armEndAt('z', lineX, z),
        }
      : null
  const ewArm: RoadArm | null =
    ew > 0 && dToEW <= CORRIDOR + EASE_REACH
      ? {
          axis: 'x', line: lineZ, dist: dToEW,
          live: ew * roadSteepK('x', lineZ, x),
          end: lineZ === spineZ ? Infinity : armEndAt('x', lineZ, x),
        }
      : null
  const a = nsArm && nsArm.live > 0.001 ? nsArm : null
  const b = ewArm && ewArm.live > 0.001 ? ewArm : null
  if (!a && !b) return NO_ROAD
  // the nearer live street answers for the surface; the other still shapes
  // the ground (see Road.other)
  const w = a && b ? (a.dist <= b.dist ? a : b) : a ?? b!
  const o = a && b ? (w === a ? b : a) : null
  return {
    grade: smoothstep(CORRIDOR + CORRIDOR_EASE, CORRIDOR, w.dist) * w.live,
    dist: w.dist,
    axis: w.axis,
    line: w.line,
    live: w.live,
    end: w.end,
    other: o,
    asphalt: w.dist <= ROAD_HALF && w.live > 0.3,
    walk: w.dist > ROAD_HALF && w.dist <= ROAD_HALF + WALK_W && w.live > 0.3,
    junction:
      ns > 0 && ew > 0 && dToNS <= ROAD_HALF + WALK_W && dToEW <= ROAD_HALF + WALK_W,
  }
}

/**
 * How hard a town has paved this point: 1 is a street surface, 0 is untouched
 * ground. It fades with distance from the kerb, and how fast depends on the
 * district — downtown is a floor from one building line to the other, a
 * suburb is a metre of verge and then garden.
 *
 * Ground colour and grass both read it, which is the point of it existing:
 * they disagreed before, and the result was bright green tufts standing in
 * bare concrete on every street the player actually walks down.
 */
export const pavedAt = (place: Place, road: Road) => {
  if (road.asphalt || road.walk) return 1
  if (!place.district) return 0
  const off = Math.max(0, road.dist - (ROAD_HALF + WALK_W))
  const [peak, fade] = place.district === 'downtown'
    ? [0.98, 40]
    : place.district === 'midrise' ? [0.85, 15] : [0.35, 3]
  return clamp01(peak * (1 - off / fade))
}

/** the buildable interior of a block, i.e. one chunk minus its street
    corridors. Building placement works in this rectangle. */
export const blockInset = ROAD_HALF + WALK_W + 1.0

/** how tall a building may stand at this point, in world units. Downtown gets
    towers, the mid-rise ring gets walk-ups, the suburbs get houses; each
    tapers toward the ring outside it so a skyline has a shoulder rather than
    a cliff edge. */
export const buildingHeightAt = (place: Place) => {
  if (!place.town || !place.district) return 0
  const scale = place.town.rank === 'city' ? 1 : place.town.rank === 'town' ? 0.62 : 0.34
  if (place.district === 'downtown') {
    return clamp01(1 - place.d / 0.26) * 118 * scale + 34 * scale
  }
  if (place.district === 'midrise') {
    return smoothstep(0.58, 0.26, place.d) * 40 * scale + 15 * scale
  }
  return smoothstep(1.0, 0.58, place.d) * 5 * scale + 8
}
