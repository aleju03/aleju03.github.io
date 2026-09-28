import { clamp01, mix, noise2, rand2, siteOf, smoothstep } from './noise'
import { elevationAt, habitabilityAt, terraceAt, SEA_Y } from './land'
import { hit, levelOf, liveOf, MARGIN, networkOf, piecesAt, probe, heightAtD } from './streets'

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

  Streets are no longer here. They used to be the chunk grid itself, every
  chunk border a street and every block one chunk, which read as graph paper
  from the air and as one repeated block from the pavement. The plan now
  lives in streets.ts, grown once per town (irregular core grid, diagonal
  avenues, curving suburbs, roads out) and cached; this module keeps the
  settlement itself (where, how big, which district, how the ground is
  graded) and answers `roadAt` off that plan. District edges are jittered by
  a slow noise so the rings between downtown, the walk-ups and the suburbs
  are gradients rather than circles.

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

/* --------------------------------------------------------------- siting -- */

const siteCache = new Map<number, Town | null>()

/** the settlement owned by one cell of the site grid, or null if that cell
    rolled empty or drew unbuildable ground. Memoized: the habitability probe
    behind it costs five elevation samples, and this is asked per terrain
    vertex. */
const townOfCell = (cx: number, cz: number): Town | null => {
  const key = (cx + 32768) * 65536 + (cz + 32768)
  const got = siteCache.get(key)
  if (got !== undefined) return got
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

/** a town's own distance at a point: 0 at its centre, 1 on its warped rim */
export const townD = (t: Town, x: number, z: number) => {
  const ox = x - t.x
  const oz = z - t.z
  const dist = Math.hypot(ox, oz)
  return dist / rimRadius(t, ox, oz, dist)
}

/** every settlement whose site cell is next to this point's */
export const townsNear = (x: number, z: number): Town[] => {
  const cx = Math.floor(x / SITE_CELL)
  const cz = Math.floor(z / SITE_CELL)
  const out: Town[] = []
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const t = townOfCell(cx + dx, cz + dz)
      if (t) out.push(t)
    }
  return out
}

/** the settlement claiming a point (nearest by town distance), without the
    grading placeAt also works out */
export const nearestTown = (x: number, z: number): Town | null => {
  const cx = Math.floor(x / SITE_CELL)
  const cz = Math.floor(z / SITE_CELL)
  let best: Town | null = null
  let bestD = Infinity
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const t = townOfCell(cx + dx, cz + dz)
      if (!t) continue
      const d = townD(t, x, z)
      if (d < bestD) {
        bestD = d
        best = t
      }
    }
  return best
}

const S_DISTRICT = 0x61c3

/** the district rings, jittered by a slow noise so neither edge is a
    circle. The home town calms it within a couple of hundred units of the
    house, whose block has to stay the suburb it was placed in */
const districtAt = (t: Town, d: number, x: number, z: number): District | null => {
  if (d >= 1) return null
  let j = (noise2(x / 170, z / 170, S_DISTRICT ^ t.seed) - 0.5) * 0.12
  if (t.home) j *= smoothstep(120, 260, Math.hypot(x, z))
  const dd = d + j
  return dd < 0.26 ? 'downtown' : dd < 0.58 ? 'midrise' : 'suburb'
}

/**
 * Which settlement claims this point, and how strongly. Returns the nearest
 * town whose rim contains the point; failing that, the nearest one at all
 * (with d > 1), so callers can still ask "how close to town is this".
 */
export const placeAt = (x: number, z: number): Place => {
  const best = nearestTown(x, z)
  if (!best) return EMPTY
  const bestD = townD(best, x, z)
  return {
    town: best, d: bestD, district: districtAt(best, bestD, x, z), padY: padYAt(x, z, best),
  }
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
 * vertex every GRID units, and a straight street is snapped onto a vertex
 * column (streets.ts), so the corridor is only truly flat out to the last
 * *vertex* it pins: at 6.1 the vertex at 8 was still half-graded, the
 * triangle between 4 and 8 sloped back up through the kerb, and the pavement
 * grew a row of terrain teeth along its outer edge. Two whole cells (8.2)
 * pins the vertices at 0, 4 and 8. A curving street cannot sit on the
 * lattice, which is fine now that the deck copies the ground it lies on
 * rather than floating flat over it (world/streetMesh.ts).
 */
export const CORRIDOR = 8.2
/** and how long the ramp back to natural ground is at minimum. Two cells, so
    the shoulder is a bank rather than a step — terrain.ts stretches the run
    further where the corridor cuts deep, exactly the way the town skirt does */
export const CORRIDOR_EASE = 8
/** one street's claim on a point, for the earthwork under it */
export interface RoadArm {
  /** distance from the street's centreline (a turning circle reports it
      from a ring one lane in from its kerb) */
  dist: number
  /** the street's presence here: 0 where it has faded (steep ground, the far
      end of a road out of town), 1 where it is fully built */
  live: number
  /** the level the street grades toward here: the graded ground along its
      centreline, so a country road follows the hills lengthways and stays
      flat underfoot the way a real one is cut */
  level: number
}

export interface Road {
  /** 0 no road .. 1 full corridor: what the terrain grades toward */
  grade: number
  /** distance from the nearest live centreline, in units */
  dist: number
  /** the nearest live street's direction here (unit), and the foot of the
      distance on its centreline. Streets run any way now, so a caller that
      wants to walk along one or step onto its pavement reads these */
  dirX: number
  dirZ: number
  footX: number
  footZ: number
  /** the winner's presence (see RoadArm.live) */
  live: number
  /** inside the asphalt */
  asphalt: boolean
  /** on the sidewalk slab */
  walk: boolean
  /** two different streets both claim this point's pavement or asphalt */
  junction: boolean
}

const NO_ROAD: Road = {
  grade: 0, dist: 1e9, dirX: 1, dirZ: 0, footX: 0, footZ: 0, live: 0,
  asphalt: false, walk: false, junction: false,
}

/** graded ground (the town skirt applied to the raw field): what the
    streets' steepness gate reads */
export const gradedAt = (x: number, z: number) => townGradedHeight(placeAt(x, z), elevationAt(x, z))

/**
 * The street network at a point: the nearest live street of the town that
 * claims it (streets.ts owns the plan). Outside a town only the roads out
 * survive, and they fade as they run into the countryside so a road never
 * ends in a blunt rectangle of asphalt.
 */
export const roadAt = (x: number, z: number, place: Place): Road => {
  const t = place.town
  if (!t) return NO_ROAD
  const list = piecesAt(networkOf(t), x, z)
  if (!list) return NO_ROAD
  let bestD = Infinity
  let live = 0
  let fx = 0
  let fz = 0
  let dx = 1
  let dz = 0
  let near: unknown = null
  let junction = false
  const W = ROAD_HALF + WALK_W
  for (const p of list) {
    // the bounding box first: a piece whose box is further than both the
    // best so far and the pavement cannot matter, and most of a cell's list
    // is exactly that
    const bx = Math.max(p.x0 - x, 0, x - p.x1)
    const bz = Math.max(p.z0 - z, 0, z - p.z1)
    const bd = Math.sqrt(bx * bx + bz * bz)
    if (bd >= bestD && bd > W) continue
    const d = probe(p, x, z)
    if (d > MARGIN) continue
    if (d >= bestD && d > W) continue
    const k = liveOf(p, hit.t)
    if (k <= 0.001) continue
    if (d <= W && k > 0.3) {
      if (near === null) near = p.street
      else if (near !== p.street) junction = true
    }
    if (d < bestD) {
      bestD = d
      live = k
      fx = hit.fx
      fz = hit.fz
      dx = hit.dx
      dz = hit.dz
    }
  }
  if (bestD === Infinity) return NO_ROAD
  return {
    grade: smoothstep(CORRIDOR + CORRIDOR_EASE, CORRIDOR, bestD) * live,
    dist: bestD, dirX: dx, dirZ: dz, footX: fx, footZ: fz, live,
    asphalt: bestD <= ROAD_HALF && live > 0.3,
    walk: bestD > ROAD_HALF && bestD <= ROAD_HALF + WALK_W && live > 0.3,
    junction,
  }
}

/** scratch for roadArms: one row per piece within reach */
const rowId: number[] = []
const rowD: number[] = []
const rowK: number[] = []
const rowL: number[] = []
/** how far past a street's nearest segment another of its segments still
    has a say in its level */
const BLEND = 6

/**
 * Every street close enough to shape the ground at a point, as one arm per
 * street: its nearest distance, and its level and presence blended over its
 * segments within BLEND of that distance, by weights that are continuous in
 * position and fade to nothing at the reach, so no segment entering the
 * lookup, leaving it or becoming the nearest can step the ground. terrain.ts
 * combines the arms by taking the strongest pull up and the strongest pull
 * down rather than applying them in turn.
 *
 * Both halves were measured rather than chosen. Applied one segment at a
 * time, a curving road's dozen short segments each pulled by their own full
 * slack, so on the inside of a bend three or four of them stacked into a
 * bank three or four times the batter (66 degrees over natural, probed); a
 * climbing road's segments ahead and behind pulled up and down at once and
 * doubled it; and two streets ending on one node at the rim of a town
 * doubled it at every corner.
 */
export const roadArms = (x: number, z: number, place: Place, reach: number, out: RoadArm[]) => {
  out.length = 0
  const t = place.town
  if (!t) return out
  const list = piecesAt(networkOf(t), x, z)
  if (!list) return out
  let n = 0
  for (const p of list) {
    const d = probe(p, x, z)
    if (d >= reach) continue
    rowId[n] = p.street.id
    rowD[n] = d
    rowK[n] = liveOf(p, hit.t)
    rowL[n] = levelOf(p, hit.t)
    n++
  }
  // one street at a time, in id order; a point has a handful of rows at most
  let prev = -1
  for (;;) {
    let id = Infinity
    for (let i = 0; i < n; i++) if (rowId[i] > prev && rowId[i] < id) id = rowId[i]
    if (id === Infinity) break
    prev = id
    let dmin = Infinity
    for (let i = 0; i < n; i++) if (rowId[i] === id && rowD[i] < dmin) dmin = rowD[i]
    let sw = 0
    let sk = 0
    let sl = 0
    for (let i = 0; i < n; i++) {
      if (rowId[i] !== id) continue
      const u = 1 - (rowD[i] - dmin) / BLEND
      if (u <= 0) continue
      const w = u * u * smoothstep(reach, reach - 4, rowD[i]) + 1e-9
      sw += w
      sk += w * rowK[i]
      sl += w * rowL[i]
    }
    const live = sk / sw
    if (live > 0.001) out.push({ dist: dmin, live, level: sl / sw })
  }
  return out
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
  // continuous in the town distance, so the paving thins as a gradient from
  // the middle outward rather than stepping at a district ring
  const d = place.d
  const core = smoothstep(0.64, 0.5, d)
  const down = smoothstep(0.32, 0.2, d)
  const peak = mix(0.35, mix(0.85, 0.98, down), core)
  const fade = mix(3, mix(15, 40, down), core)
  return clamp01(peak * (1 - off / fade))
}

/** how tall a building may stand at this point, in world units: a peak in
    the middle of a city that is gone by the edge of downtown, a shoulder of
    walk-ups, then houses. Continuous in the town distance (streets.ts rolls
    each lot's own height off the same curve), so a skyline has a shoulder
    rather than a cliff edge at a district ring. */
export const buildingHeightAt = (place: Place) => {
  if (!place.town || !place.district) return 0
  return heightAtD(place.town, place.d)
}
