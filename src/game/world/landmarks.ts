import { mix, rand2, siteOf, smoothstep } from './noise'
import { SEA_Y, continentAt, elevationAt, moistureAt, temperatureAt } from './land'
import { classify, type BiomeId } from './biomes'
import { placeAt, roadAt, townGradedHeight } from './settlements'
import { CHUNK, originX, originZ } from './grid'

/*
  The things standing out in the country, and where they get to stand.

  Towns answer "what is here" for the few percent of the world that is built
  on. Everywhere else was landform, weather and trees, and an endless planet
  of nothing but those reads as a screensaver however good the trees are: you
  walk for two minutes, the biome changes, and nothing has *happened*. What
  fixes that is not more density, it is punctuation. A lighthouse on a
  headland is worth more than a thousand extra pines, because it is a place
  rather than a texture, and because from four hundred metres out it is a
  reason to keep walking.

  So this is a second site grid, laid the same way settlements.ts lays towns
  and land.ts lays oases: one jittered site per cell, hashed by cell
  coordinates so the answer is a pure function of position, memoised because
  the gate behind it costs a dozen elevation probes. What a site becomes is
  decided by the ground it landed on. The coast test picks lighthouses and
  shipwrecks, the biome table picks the rest, and a site that fails every
  gate is simply empty countryside, which most of them are.

  Two numbers make the lookups cheap enough for the terrain grader to ask per
  vertex. `siteOf` jitters a site to within the middle 62% of its cell, so a
  site never comes closer than 0.19 * CELL to the cell boundary; keep every
  structure's graded pad under that clearance and a point can only ever be
  inside the pad of a site in its *own* cell. That turns the 3x3 neighbourhood
  scan every other site grid here pays for into one memoised lookup and one
  hypot. `PAD_MAX` is that clearance, asserted rather than hoped for, and it
  is also why nothing in the table below grades further than 34 units: the
  moment one does, this whole file needs the 3x3 scan back.

  Nothing here is allowed on a road, in a town or inside the skirt of one, or
  anywhere near the authored property. Those are all somebody else's ground
  and the generator does not get to put a windmill on them.
*/

export type LandmarkKind =
  | 'lighthouse'
  | 'windmill'
  | 'farm'
  | 'mast'
  | 'ruins'
  | 'watertower'
  | 'stones'
  | 'cabin'
  | 'wreck'

export interface Landmark {
  kind: LandmarkKind
  x: number
  z: number
  /** footprint half-extent: the scatterer keeps trees out of this circle */
  r: number
  /** how far the graded pad reaches, r for a kind that grades nothing */
  pad: number
  /** the height the pad grades to */
  y: number
  /** which way it faces, in radians (0 = facing +z), free of the lattice */
  face: number
  /** the ground it landed on, so a builder can paint for its climate */
  biome: BiomeId
  /** stable per-site seed */
  seed: number
}

/** one candidate per cell of this grid. Sized against a measured hit rate
    rather than picked: about three cells in ten survive the gates below, so
    400 puts a landmark every ~730 units, which is a minute and a half's walk
    or fifteen seconds in the car. At the 620 the first cut used it was nearly
    a thousand, and the loaded ring is only 512 units across, so the country
    read as empty because most of the time it genuinely was. */
const LM_CELL = 400
const S_LM = 0x3c7f
const S_KIND = 0x91b5

/** the clearance `siteOf`'s 0.62 jitter guarantees between a site and its own
    cell's edge. No structure's `pad` may exceed it: see the header */
const PAD_MAX = LM_CELL * 0.19

/** how far a landmark's shaping may pitch the ground, rise over run. Well
    over anything the flatness gates can hand it, so the plane is a guarantee
    rather than a shape, and a bank never steps at the edge of the pad */
const BATTER = 0.8

/** footprint and grading reach per kind, in units */
const SIZE: Record<LandmarkKind, [r: number, pad: number]> = {
  lighthouse: [11, 22],
  windmill: [9, 18],
  farm: [22, 34],
  mast: [15, 24],
  ruins: [13, 22],
  watertower: [7, 14],
  stones: [12, 20],
  cabin: [9, 17],
  // a wreck lies where the sea left it: grading a beach flat under a hull
  // would read as a car park with a boat parked on it
  wreck: [13, 13],
}

/* --------------------------------------------------------------- siting -- */

/** |grad h| off the raw field, over the span the pad actually has to cover */
const slopeOver = (x: number, z: number, d: number) => {
  const gx = (elevationAt(x + d, z) - elevationAt(x - d, z)) / (2 * d)
  const gz = (elevationAt(x, z + d) - elevationAt(x, z - d)) / (2 * d)
  return Math.hypot(gx, gz)
}

/**
 * How much of a ring at `r` around a point is open *sea*, as opposed to any
 * old water. The distinction matters and depth cannot make it: land.ts carves
 * a river 17 units into the lowlands, which is deeper than the shelf a
 * hundred metres off a beach, so "is it under SEA_Y and is it deep" says yes
 * to a riverbank. Continentalness says no by construction, since a river is
 * cut into ground that is continental and an ocean is where the continent
 * ran out. The first version skipped this and the probe's first lighthouse
 * came out in the middle of a taiga forest, on a creek.
 */
const SEA_SAMPLES = 12

const seaRing = (x: number, z: number, r: number) => {
  let n = 0
  for (let i = 0; i < SEA_SAMPLES; i++) {
    const a = (i / SEA_SAMPLES) * Math.PI * 2
    const px = x + Math.cos(a) * r
    const pz = z + Math.sin(a) * r
    // continentalness first: it is the cheaper of the two and it rejects
    // almost everything inland, so most samples never pay for an elevation
    if (continentAt(px, pz) < 0.45 && elevationAt(px, pz) < SEA_Y) n++
  }
  return n / SEA_SAMPLES
}

/**
 * How coastal a point is: the strongest "some of this is sea and some of it
 * is not" reading, off three rings.
 *
 * One radius alone is a band filter on the distance to the shore, about sixty
 * units wide, which a 400-unit site grid lands in roughly once in a hundred
 * cells. Every number here was measured rather than picked, over the same
 * 22 km square, counting candidates that clear the height window: two rings
 * of 8 gave 21, three rings of 12 gives 51, and a fourth out at 290 gives 139
 * but starts calling ground a quarter of a kilometre inland "coastal", which
 * is a lighthouse with a forest between it and the sea.
 */
const RINGS = [55, 120, 200]

const coastalness = (x: number, z: number) => {
  let best = 0
  let any = 0
  for (const r of RINGS) {
    const f = seaRing(x, z, r)
    any = Math.max(any, f)
    best = Math.max(best, 0.5 - Math.abs(f - 0.5))
  }
  // one sea sample on one ring at all, or it is not coast, it is weather
  return any < 0.08 ? 0 : best * 2
}

/**
 * Which kinds the ground at a site will take. Order does not matter, since
 * the site's own roll picks uniformly from whatever comes back, but *count*
 * does: a kind listed twice for a biome is twice as likely there, which is
 * the whole weighting mechanism and the reason the temperate belt is mostly
 * farms rather than mostly ruins.
 */
const eligible = (
  biome: BiomeId, h: number, slope: number, coast: number,
): LandmarkKind[] => {
  const out: LandmarkKind[] = []
  const above = h - SEA_Y
  // the coast pair. A lighthouse wants water on some sides and not most,
  // which is what "headland" means as a number, and enough height under it
  // that the lamp is not at wave level
  if (coast > 0.34 && above > 1.5 && above < 40 && slope < 0.4) out.push('lighthouse')
  if (coast > 0.5 && above > -0.5 && above < 2.8 && slope < 0.2) out.push('wreck')
  if (above < 1.2) return out

  switch (biome) {
    case 'plains':
    case 'savanna':
      if (slope < 0.1) {
        out.push('farm', 'farm', 'windmill', 'windmill', 'watertower', 'stones')
      }
      if (slope < 0.15) out.push('ruins')
      break
    case 'forest':
      if (slope < 0.1) out.push('farm', 'farm', 'cabin', 'cabin')
      if (slope < 0.15) out.push('ruins', 'watertower')
      break
    case 'taiga':
      if (slope < 0.15) out.push('cabin', 'cabin', 'mast')
      break
    case 'tundra':
      if (slope < 0.13) out.push('stones', 'stones', 'mast', 'windmill')
      if (slope < 0.17) out.push('ruins')
      break
    case 'snow':
      if (slope < 0.15) out.push('cabin', 'mast', 'stones')
      break
    case 'desert':
      if (slope < 0.13) out.push('ruins', 'stones', 'watertower')
      if (slope < 0.17) out.push('mast')
      break
    case 'jungle':
      // a jungle has one story to tell and it is a good one, but three
      // hundred square kilometres of the same overgrown temple is not it
      if (slope < 0.13) out.push('ruins', 'ruins', 'cabin', 'stones')
      break
    case 'wetland':
      if (slope < 0.1) out.push('cabin', 'cabin', 'stones')
      break
    case 'beach':
      if (slope < 0.1) out.push('cabin', 'watertower')
      break
    case 'rock':
      // Rock is by definition steep, so only the mast, which is guyed into
      // whatever it lands on and wants the height anyway. 0.22 rather than
      // the 0.3 it can stand on, because a mast grades a 24-unit pad and at
      // 0.3 the raw ground has climbed 7.2 units by the rim, which is
      // exactly where the release plane stops being slack
      if (slope < 0.22) out.push('mast')
      break
    default:
      break
  }
  // anything with a real view gets a mast on it wherever it is buildable
  if (above > 90 && slope < 0.26 && !out.includes('mast')) out.push('mast')
  return out
}

const cellCache = new Map<number, Landmark | null>()

const landmarkOfCell = (cx: number, cz: number): Landmark | null => {
  const key = (cx + 65536) * 262144 + (cz + 65536)
  const hit = cellCache.get(key)
  if (hit !== undefined) return hit
  const lm = siteLandmark(cx, cz)
  if (cellCache.size > 20000) cellCache.clear()
  cellCache.set(key, lm)
  return lm
}

const siteLandmark = (cx: number, cz: number): Landmark | null => {
  const s = siteOf(cx, cz, LM_CELL, S_LM)
  // a quarter of all cells are simply empty country before any gate runs.
  // Punctuation stops being punctuation when there is one on every page
  if (s.roll > 0.76) return null
  // the authored property and its approach are not the generator's to edit
  if (Math.hypot(s.x, s.z) < 240) return null
  const place = placeAt(s.x, s.z)
  // Outside the town, and clear of the skirt its grading is still bending.
  // 1.5 rather than something tighter because the *chunk* builder decides it
  // is in town by asking at the chunk's centre: a block whose middle sits at
  // d = 0.95 reaches d = 1.33 at its corner on the smallest hamlet, and a
  // landmark sited into that corner would grow through somebody's houses
  if (place.d < 1.5) return null
  if (roadAt(s.x, s.z, place).dist < 26) return null

  const h = elevationAt(s.x, s.z)
  if (h < SEA_Y - 1) return null
  const slope = slopeOver(s.x, s.z, 20)
  const biome = classify(
    h - SEA_Y, slope, temperatureAt(s.x, s.z, h), moistureAt(s.x, s.z, h),
  )
  const kinds = eligible(biome, h, slope, coastalness(s.x, s.z))
  if (!kinds.length) return null

  // a coastal site that could hold a lighthouse usually should: they are the
  // rarest ground on the planet and the most worth walking to
  const pickRoll = rand2(cx, cz, S_KIND)
  const kind = kinds.includes('lighthouse') && pickRoll < 0.55
    ? 'lighthouse'
    : kinds[Math.min(kinds.length - 1, Math.floor(pickRoll * kinds.length))]

  const [rr, pp] = SIZE[kind]
  return {
    kind,
    x: s.x,
    z: s.z,
    r: rr,
    pad: Math.min(pp, PAD_MAX),
    y: townGradedHeight(place, h),
    // a structure out here answers to nothing, so it faces any way it likes.
    // The one exception is the lighthouse, which turns its keeper's cottage
    // inland: structures.ts reads `face` as "the way the front looks"
    face: rand2(cx, cz, S_KIND ^ 0x51e3) * Math.PI * 2,
    biome,
    seed: (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ 0x2bd1) >>> 0,
  }
}

/* -------------------------------------------------------------- lookups -- */

/**
 * The landmark whose site falls inside chunk (cx, cz), if any. A chunk is 64
 * units and a site cell is 480, so a chunk touches at most four cells and
 * two sites can never be under 180 units apart: one per chunk at the very
 * most, which is what lets the chunk builder treat this as a single object
 * rather than a list.
 */
export const landmarkIn = (cx: number, cz: number): Landmark | null => {
  const ox = originX(cx)
  const oz = originZ(cz)
  const c0 = Math.floor(ox / LM_CELL)
  const c1 = Math.floor((ox + CHUNK) / LM_CELL)
  const d0 = Math.floor(oz / LM_CELL)
  const d1 = Math.floor((oz + CHUNK) / LM_CELL)
  for (let d = d0; d <= d1; d++)
    for (let c = c0; c <= c1; c++) {
      const lm = landmarkOfCell(c, d)
      if (lm && lm.x >= ox && lm.x < ox + CHUNK && lm.z >= oz && lm.z < oz + CHUNK) {
        return lm
      }
    }
  return null
}

/** the landmark whose pad could possibly cover this point. One lookup, by the
    clearance argument in the header: a neighbouring cell's site is at least
    PAD_MAX away from anything in this one. */
export const landmarkAt = (x: number, z: number): Landmark | null =>
  landmarkOfCell(Math.floor(x / LM_CELL), Math.floor(z / LM_CELL))

/**
 * A landmark's grading applied to a raw ground height: flat on its pad, then
 * eased back into the landform, held under a plane climbing at BATTER so the
 * blend cannot outrun itself on a slope. Sites are gated flat enough that the
 * plane never actually binds, which is the point of it: it is the guarantee
 * the blend lacks, and the reason no pad can leave a scarp at its rim.
 */
export const landmarkGradedHeight = (x: number, z: number, rawH: number) => {
  const lm = landmarkAt(x, z)
  if (!lm || lm.pad <= lm.r) return rawH
  const d = Math.hypot(x - lm.x, z - lm.z)
  if (d >= lm.pad) return rawH
  if (d <= lm.r) return lm.y
  const past = d - lm.r
  const diff = rawH - lm.y
  const eased = mix(rawH, lm.y, 1 - smoothstep(0, lm.pad - lm.r, past))
  const plane = lm.y + Math.sign(diff) * BATTER * past
  return diff > 0 ? Math.min(eased, plane) : Math.max(eased, plane)
}

/** for the headless probe: the cell grid the sites are laid on */
export const LANDMARK_CELL = LM_CELL
