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
  something to follow into the countryside.

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
  /** 0 untouched countryside .. 1 fully graded building ground */
  grade: number
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

const EMPTY: Place = { town: null, d: 99, district: null, grade: 0, padY: 0 }

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
  // graded flat through the built-up area, then an easing back into the
  // landscape past the last building. The band still has to be wide enough
  // that a town in hill country meets the hillside as a bank rather than a
  // quarry face — but the first cut ran it to 1.3 radii, and with the big
  // home city that flattened every approach for a quarter-hour's walk. The
  // hills now start where the buildings stop.
  const grade = smoothstep(1.16, 0.86, bestD)
  return { town: best, d: bestD, district, grade, padY: padYAt(x, z, best) }
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
const CORRIDOR = 8.2
/** and how long the ramp back to natural ground is. Two cells again, so the
    shoulder is a bank rather than a step */
const CORRIDOR_EASE = 8

export interface Road {
  /** 0 no road .. 1 full corridor: what the terrain grades toward */
  grade: number
  /** distance from the nearest active centreline, in units */
  dist: number
  /** the road runs along this axis ('x' = an east-west street) */
  axis: 'x' | 'z' | null
  /** the constant coordinate of that centreline (its z for an 'x' road).
      terrain.ts grades a road level across its width by sampling the ground
      on this line, so a country road follows the hills lengthways and stays
      flat underfoot the way a real one is cut. */
  line: number
  /** inside the asphalt */
  asphalt: boolean
  /** on the sidewalk slab */
  walk: boolean
  /** both an east-west and a north-south street claim this point */
  junction: boolean
}

const NO_ROAD: Road = {
  grade: 0, dist: 1e9, axis: null, line: 0, asphalt: false, walk: false, junction: false,
}

/*
  How steep the ground under a road may get before the tarmac gives out.

  Roads used to be unconditional along their lines, and the terrain paid for
  it: first as slot canyons (the corridor grading cut through any ridge in the
  way — capped now in terrain.ts), then, with the cut capped, as asphalt
  climbing a hillside like a ramp nailed to a wall. The honest behaviour is
  the one real roads have: they end at the foot of ground too steep to pave.

  Sampled from the raw elevation along the centreline in coarse cells and
  memoized by cell, because roadAt runs per terrain vertex and elevationAt is
  the expensive field stack. Inside a graded town the fade is blended back
  out — the terrace has flattened the ground no matter what the raw field
  says under it.
*/
const STEEP_CELL = 24
const steepCache = new Map<number, number>()

const roadSteepK = (axis: 'x' | 'z', line: number, s: number) => {
  const cell = Math.round(s / STEEP_CELL)
  const lineIdx = Math.round((line - (axis === 'z' ? OFF_X : OFF_Z)) / CHUNK)
  const key = ((lineIdx + 32768) * 262144 + (cell + 100000)) * 2 + (axis === 'z' ? 1 : 0)
  const hit = steepCache.get(key)
  if (hit !== undefined) return hit
  const mid = cell * STEEP_CELL
  const h0 = axis === 'z' ? elevationAt(line, mid - 14) : elevationAt(mid - 14, line)
  const h1 = axis === 'z' ? elevationAt(line, mid + 14) : elevationAt(mid + 14, line)
  const k = smoothstep(0.52, 0.3, Math.abs(h1 - h0) / 28)
  if (steepCache.size > 40000) steepCache.clear()
  steepCache.set(key, k)
  return k
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

  // how present each street is here: everywhere in town, and along the two
  // spines for a while past the town limit
  const spineX = nearestLine(t.x, OFF_X)
  const spineZ = nearestLine(t.z, OFF_Z)
  const reach = t.radius * SPINE_REACH
  const inTown = place.district !== null ? 1 : 0
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
  // that isn't a spine
  const ns = t.rank === 'hamlet' && lineX !== spineX ? 0 : nsLive
  const ew = t.rank === 'hamlet' && lineZ !== spineZ ? 0 : ewLive

  const dNS = ns > 0 ? dToNS : 1e9
  const dEW = ew > 0 ? dToEW : 1e9
  const dist = Math.min(dNS, dEW)
  if (dist > CORRIDOR + CORRIDOR_EASE) return NO_ROAD
  const nsWins = dNS < dEW
  let live = nsWins ? ns : ew
  // the steepness fade, blended out where the town terrace has already
  // levelled the ground (the raw field under a graded street is irrelevant).
  // Deep in town this skips the elevation probes entirely.
  if (place.grade < 0.8) {
    const steep = roadSteepK(nsWins ? 'z' : 'x', nsWins ? lineX : lineZ, nsWins ? z : x)
    live *= mix(steep, 1, clamp01(place.grade * 1.25))
  }
  if (live <= 0.001) return NO_ROAD
  return {
    grade: smoothstep(CORRIDOR + CORRIDOR_EASE, CORRIDOR, dist) * live,
    dist,
    axis: nsWins ? 'z' : 'x',
    line: nsWins ? lineX : lineZ,
    asphalt: dist <= ROAD_HALF && live > 0.3,
    walk: dist > ROAD_HALF && dist <= ROAD_HALF + WALK_W && live > 0.3,
    junction: dNS <= ROAD_HALF + WALK_W && dEW <= ROAD_HALF + WALK_W,
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
