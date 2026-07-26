import { clamp01, fbm, mix, ridged, siteOf, smoothstep, vein, warped } from './noise'

/*
  The raw planet: elevation and climate as pure functions of (x, z), with no
  knowledge of chunks, towns, the house, or anything else built on top. Every
  other world module reads these fields and decides what to do about them —
  terrain.ts grades them and picks a biome, settlements.ts asks whether a
  patch of ground is habitable before putting a town on it.

  It is a field stack, in the order a planet would build one:

  - continentalness decides land from sea. One warped low-frequency field,
    thresholded softly, gives coastlines that wander instead of drawing
    circles, and a continental shelf that shallows toward the shore rather
    than dropping off a cliff at the waterline.
  - erosion decides whether a region is placid or rugged, independently of
    how high it is. This is what stops "high" and "jagged" from being the
    same word: there are flat highlands and there are broken lowlands.
  - ranges are ridged noise gated by a mask, so mountains run in lines with
    passes between them, the way real orogeny leaves them, rather than
    peppering the map with isolated cones.
  - rivers and basins are subtractive. A river is a thin warped vein carved
    a fixed depth into whatever is there, so in the lowlands it fills (it
    ends up under sea level and terrain.ts floods it) and in the highlands
    the same vein reads as a dry canyon. Basins are broad depressions that
    flood into lakes by the same rule. Nothing here decides "this is water";
    water is simply everywhere the finished ground ends up below SEA_Y,
    which keeps oceans, lakes and rivers on one code path.
  - temperature is mostly latitude — a cosine in z, so walking north gets
    cold and walking south gets hot — plus local noise and an altitude
    lapse, so a mountain in the tropics still wears snow. Moisture is noise
    minus a drying term with altitude. The pair feeds a Whittaker-style
    table in biomes.ts.
  - oases are the one feature placed by site rather than by field: rare
    cells of the hot drylands sink a small bowl through the waterline and
    raise a moisture halo around it, so the biome table greens the ring on
    its own — a pond, jungle at the water, savanna scrub fading back into
    the sand, with no oasis special case anywhere downstream.

  The world repeats its climate bands every LAT_SPAN units, which is the one
  deliberate lie: an endless plane has no poles, so the bands cycle instead.
  At walking pace the nearest ice is a few minutes north of the house and the
  nearest desert a few minutes south, which is the point.
*/

/** the waterline. Below it, ground is a sea/lake/river bed. The house pad
    sits at y=0, six units clear, so the property is never at risk of it. */
export const SEA_Y = -6

/** climate band wavelength in z: one full cold→hot→cold cycle */
const LAT_SPAN = 11000

/*
  Where the house sits on the planet. Every field below is sampled at
  (x + WORLD_X, z + WORLD_Z), so this pair slides the whole world under the
  origin without changing a single seed — which is how the property ended up
  a few hundred units inside a temperate landmass with a coastline a walk
  away, instead of the patch of open sea the raw field had there. Retuning the
  world's shape is a matter of moving these two numbers and re-running the
  probe, not of hunting for a seed that happens to be kind to the origin.
  The latitude term deliberately does NOT use the offset: north of the house
  has to be cold and south hot, and that is anchored to the house.
*/
const WORLD_X = -57400
const WORLD_Z = 3700

/** the same trick again for the weather, on its own offset. Landmass and
    climate are independent fields, so this slides the isotherms over the
    continent without reshaping it — which is what settles the argument
    between "the house should be on a temperate coast" and "the house should
    be a few hundred units inland". Tuned so the property reads temperate and
    reasonably damp, i.e. the forest the authored yard already looks like —
    and, re-probed, so the desert a few minutes south is a modest patch. The
    first calibration parked a near-worst-case desert (4200x3700 units, the
    second-largest in an 86 km sweep of the hot belt) with its corner 400
    units from the property line. */
const CLIMATE_X = -52300
const CLIMATE_Z = -18400

/** spread a stacked-octave field back out over 0..1. Summing octaves pulls
    values toward the middle (the central limit doing its job), so a raw fbm
    lives almost entirely in 0.27..0.73 — and a biome table with a threshold
    at 0.27 would then simply never fire. */
const spread = (v: number, k: number) => clamp01((v - 0.5) * k + 0.5)

// feature frequencies, in 1/world-units (1 unit ~= 0.43 m at this scale)
const F_CONT = 1 / 5200
const F_ERO = 1 / 2100
const F_RANGE = 1 / 1650
const F_HILL = 1 / 380
const F_DET = 1 / 88
const F_RIVER = 1 / 2900
const F_BASIN = 1 / 1250
const F_TEMP = 1 / 2400
const F_MOIST = 1 / 1900

const S_CONT = 0x1a7c
const S_ERO = 0x33b1
const S_RANGE = 0x5cd2
const S_CREST = 0x77e9
const S_HILL = 0x91f4
const S_DET = 0xa20b
const S_RIVER = 0xbe61
const S_BASIN = 0xc4d8
const S_TEMP = 0xd11e
const S_MOIST = 0xe903

/** 0 open ocean .. 1 well inland. Sampled on its own because settlements and
    the coastline test both want "how continental is this" without paying for
    a full height evaluation. Thresholds elsewhere are calibrated against its
    measured distribution: 0.40 puts about 72% of the world above water. */
export const continentAt = (x: number, z: number) =>
  warped((x + WORLD_X) * F_CONT, (z + WORLD_Z) * F_CONT, S_CONT, 0.9, 4)

/** 0 at sea .. 1 fully continental interior */
export const landAt = (x: number, z: number) => smoothstep(0.4, 0.5, continentAt(x, z))

/**
 * The continental base alone: sea floor and the broad rise of the landmass,
 * with no hills, ranges, rivers or grain on it. Smooth by construction (one
 * 1/5200 field), which is exactly what a town wants to be graded onto — a
 * settlement then sits on a gently sloping terrace rather than on a mesa
 * punched out of the hillside.
 */
export const terraceAt = (x: number, z: number) => {
  const c = continentAt(x, z)
  return mix(
    mix(SEA_Y - 36, SEA_Y - 1.1, smoothstep(0.26, 0.4, c)),
    SEA_Y + 3.4 + smoothstep(0.5, 0.8, c) * 60,
    smoothstep(0.4, 0.5, c),
  )
}

/**
 * Ungraded ground height at a point: the planet before anything human is
 * imposed on it. terrain.ts is the one that flattens town plateaus and the
 * house pad into this.
 */
export const elevationAt = (x: number, z: number) => {
  const wx = x + WORLD_X
  const wz = z + WORLD_Z
  const c = continentAt(x, z)
  const landK = smoothstep(0.4, 0.5, c)

  // sea floor: an abyss that shallows onto a shelf as the coast approaches
  let h = mix(SEA_Y - 36, SEA_Y - 1.1, smoothstep(0.26, 0.4, c))
  // ...and the land that rises out of it, higher the further inland it gets
  h = mix(h, SEA_Y + 3.4 + smoothstep(0.5, 0.8, c) * 60, landK)

  // rugged 0..1: low erosion means broken ground, high means placid
  const rugged = smoothstep(0.62, 0.3, fbm(wx * F_ERO, wz * F_ERO, S_ERO, 3))

  // ranges: crests where the mask says a range runs, and only on real land.
  // The mask gate is calibrated against fbm's measured spread (a 3-octave sum
  // rarely leaves 0.27..0.73): the first tune gated at 0.52..0.78 AND
  // multiplied by rugged outright, two rare fields that had to coincide, and
  // the probe put >80-unit relief on 1.5% of the land — a planet with no
  // mountains on it. The mask now carries the range and erosion only tempers
  // it, which is also truer to the geology the header claims: orogeny decides
  // where ranges run, erosion decides how worn they stand.
  const rangeMask = smoothstep(0.44, 0.7, fbm(wx * F_RANGE, wz * F_RANGE, S_RANGE, 3))
  const crest = ridged(wx * F_RANGE * 1.35, wz * F_RANGE * 1.35, S_CREST, 5)
  h += Math.pow(crest, 2.0) * rangeMask * mix(0.45, 1, rugged) * landK * 560

  // rolling hills over everything ashore, flattened where erosion won — but
  // never to a floor. The first tune ran these at 34 with a 0.35 floor and
  // the temperate belt around the home town came out as a snooker table:
  // "placid" has to mean gentle hills, because "flat" reads as unfinished
  h += (fbm(wx * F_HILL, wz * F_HILL, S_HILL, 3) - 0.42) * 50 * landK * mix(0.52, 1, rugged)
  // and the fine grain that keeps a hillside from reading as a ramp
  h += (fbm(wx * F_DET, wz * F_DET, S_DET, 3) - 0.5) * 6.4 * landK

  // basins: broad depressions. In lowland they end up under SEA_Y and become
  // lakes; on a plateau they are just a bowl in the grass
  h -= smoothstep(0.72, 0.93, fbm(wx * F_BASIN, wz * F_BASIN, S_BASIN, 3)) * 26 * landK

  // rivers: one carve depth everywhere, so lowlands flood and highlands get
  // a canyon. Narrowed where the range mask is strong, or every peak would
  // be sliced in half by a gorge
  h -= riverAt(x, z) * landK * mix(17, 7, rangeMask)

  // oases: the apron sinks the surroundings toward a shelf just above the
  // waterline — cutting only, never raising, so an overlap with a basin or
  // river deepens instead of growing a berm — and the bowl digs through to
  // under it. moistureAt greens the ring
  const o = oasisAt(x, z)
  if (o) {
    const shelf = Math.min(SEA_Y + 8, Math.max(SEA_Y + 2, terraceAt(x, z) + 1.2))
    if (o.apron > 0 && h > shelf) h = mix(h, shelf, o.apron)
    h = mix(h, SEA_Y - 3.6, o.bowl)
  }

  return h
}

/** 0..1 strength of the river vein through this point (1 = mid-channel) */
export const riverAt = (x: number, z: number) =>
  vein((x + WORLD_X) * F_RIVER, (z + WORLD_Z) * F_RIVER, S_RIVER, 0.03, 3)

/* --------------------------------------------------------------- oases -- */

/*
  A desert with nothing in it for four kilometres reads as a loading screen.
  An oasis is two field edits and no new machinery downstream: elevationAt
  sinks a wide apron to a shelf just above the waterline and a bowl through
  it, so the standard "below the waterline is water" rule fills the pond;
  and moistureAt raises a halo around it, so the Whittaker table in
  biomes.ts draws the green ring by itself — jungle at the shore, savanna
  scrub fading back into sand. The apron only ever cuts, never banks up:
  whatever height the dunes are, the rim the shore is carved from starts at
  most 14 units over the pond floor, which is what keeps the waterline
  ringed by beach instead of by a rock cliff. (The first version instead
  *required* low ground, terraceAt < SEA_Y+12 on top of continentAt > 0.55
  — jointly a continentalness window of 0.03 that no site on the planet
  fell into, and the feature silently never fired.) Sites are hashed cells
  like settlements, gated on the raw climate fields (latitude and weather
  noise, never the finished temp/moist — those include the altitude lapse
  and the halo itself, and the second is a cycle). The only ground gate that
  remains is an estimate of the site's height, excluding open water on one
  side and true highlands — where a sunken waterhole would be a mine shaft —
  on the other.
*/
const OASIS_CELL = 900
const S_OASIS = 0xf27a

interface OasisSite {
  x: number
  z: number
  /** pond radius; the apron and halo reach about twice this */
  r: number
}

/** memoized: every elevation and moisture probe in the hot belt asks, and
    the gates below cost a few fbm reads per site */
const oasisMemo = new Map<string, OasisSite | null>()

const oasisSiteOf = (cx: number, cz: number): OasisSite | null => {
  const key = cx + ',' + cz
  const hit = oasisMemo.get(key)
  if (hit !== undefined) return hit
  const s = siteOf(cx, cz, OASIS_CELL, S_OASIS)
  let out: OasisSite | null = null
  if (s.roll < 0.8) {
    // hot by latitude + weather (no lapse: the pond floor is near sea
    // level) and desert-dry by raw weather — the same 0.27 the biome table
    // uses, so anywhere sand can be, a pond can be
    const u = (s.z + 3000) / LAT_SPAN
    const tri = 4 * Math.abs(u - Math.floor(u + 0.5)) - 1
    const local =
      spread(fbm((s.x + CLIMATE_X) * F_TEMP, (s.z + CLIMATE_Z) * F_TEMP, S_TEMP, 3), 1.7) - 0.5
    const dry = spread(fbm((s.x + CLIMATE_X) * F_MOIST, (s.z + CLIMATE_Z) * F_MOIST, S_MOIST, 4), 1.9)
    // ground check without elevationAt — that now reads the oasis field
    // back, and asking it from in here would recurse into this very cell.
    // Terrace plus the hill term is close enough to keep sites off open
    // water (coastal shelf deserts hold their ground with hills alone, so
    // the terrace by itself would wrongly drown them) and off the high
    // plateaus, where a sunken waterhole would be a mine shaft
    const c = continentAt(s.x, s.z)
    const landK = smoothstep(0.4, 0.5, c)
    const ground =
      terraceAt(s.x, s.z) +
      (fbm((s.x + WORLD_X) * F_HILL, (s.z + WORLD_Z) * F_HILL, S_HILL, 3) - 0.42) *
        50 * landK * 0.75
    if (
      0.5 + 0.46 * tri + local * 0.34 > 0.62 &&
      dry < 0.27 &&
      c > 0.45 &&
      ground > SEA_Y + 1.5 &&
      ground < SEA_Y + 30
    )
      out = { x: s.x, z: s.z, r: 65 + s.roll * 50 }
  }
  oasisMemo.set(key, out)
  return out
}

/** the oasis influence over (x, z): apron and bowl grade the ground,
    halo waters the ring. Overlapping sites combine by max, which keeps the
    fields continuous where two aprons meet — "nearest site wins" would put
    a seam through the overlap. The latitude test up front makes the whole
    feature free outside the hot belt — the temperate and polar two-thirds
    of the world never touch the site grid. It is safe because a site
    0.62-hot lies well inside the belt and influence reaches at most ~240
    units from it, a latitude drift of under 0.05. */
const oasisAt = (
  x: number,
  z: number,
): { apron: number; bowl: number; halo: number } | null => {
  const u = (z + 3000) / LAT_SPAN
  if (0.5 + 0.46 * (4 * Math.abs(u - Math.floor(u + 0.5)) - 1) < 0.55) return null
  const cx = Math.floor(x / OASIS_CELL)
  const cz = Math.floor(z / OASIS_CELL)
  let apron = 0
  let bowl = 0
  let halo = 0
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const s = oasisSiteOf(cx + dx, cz + dz)
      if (!s) continue
      const d = Math.hypot(x - s.x, z - s.z)
      if (d >= s.r * 2.3) continue
      apron = Math.max(apron, smoothstep(s.r * 2.2, s.r, d))
      bowl = Math.max(bowl, smoothstep(s.r, s.r * 0.25, d))
      halo = Math.max(halo, smoothstep(s.r * 2.2, s.r * 0.6, d))
    }
  return apron > 0 || halo > 0 ? { apron, bowl, halo } : null
}

/** 0 arctic .. 1 tropical. Latitude does most of the work — a cosine in z, so
    the walk north gets cold and the walk south gets hot — with local weather
    on top and an altitude lapse under it, which is what keeps snow on a
    tropical summit. */
export const temperatureAt = (x: number, z: number, height: number) => {
  // a triangle wave, not a cosine: a cosine is arcsine-distributed and parks
  // most of the world at one pole or the other, which starved the temperate
  // band the house lives in. A triangle spends equal ground on every latitude
  // phase: coldest at z = -3000, hottest at z = +2500, so north is winter and
  // south is summer the way most people expect a map to read
  const u = (z + 3000) / LAT_SPAN
  const tri = 4 * Math.abs(u - Math.floor(u + 0.5)) - 1 // -1 .. 1
  const lat = 0.5 + 0.46 * tri
  const local =
    spread(fbm((x + CLIMATE_X) * F_TEMP, (z + CLIMATE_Z) * F_TEMP, S_TEMP, 3), 1.7) - 0.5
  return clamp01(lat + local * 0.34 - smoothstep(10, 300, height - SEA_Y) * 0.52)
}

/** 0 arid .. 1 soaking. Noise, contrast-stretched so the dry end of the biome
    table is actually reachable, minus a drying term with altitude — the cheap
    stand-in for a rain shadow, and what puts scree and alpine desert above
    the treeline instead of meadow. */
export const moistureAt = (x: number, z: number, height: number) => {
  const m = spread(fbm((x + CLIMATE_X) * F_MOIST, (z + CLIMATE_Z) * F_MOIST, S_MOIST, 4), 1.9)
  // the oasis halo: wide enough that the pond wears jungle at the shore and
  // savanna scrub beyond it before the sand resumes
  const o = oasisAt(x, z)
  return clamp01(m + (o ? o.halo * 0.55 : 0) - smoothstep(120, 340, height - SEA_Y) * 0.22)
}

/** how buildable a patch is, 0..1 — dry land, not too steep, not a river.
    settlements.ts sites towns by this, so nothing lands in the sea or on a
    cliff face. Deliberately cheap: four elevation probes, no biome work. */
export const habitabilityAt = (x: number, z: number) => {
  const h = elevationAt(x, z)
  if (h < SEA_Y + 2) return 0
  const d = 26
  const gx = (elevationAt(x + d, z) - elevationAt(x - d, z)) / (2 * d)
  const gz = (elevationAt(x, z + d) - elevationAt(x, z - d)) / (2 * d)
  const slope = Math.hypot(gx, gz)
  return smoothstep(0.42, 0.1, slope) * smoothstep(SEA_Y + 2, SEA_Y + 9, h)
}
