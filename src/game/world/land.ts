import { clamp01, fbm, mix, ridged, smoothstep, vein, warped } from './noise'

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
    with a coastal bonus. The pair feeds a Whittaker-style table in
    biomes.ts.

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
    reasonably damp, i.e. the forest the authored yard already looks like. */
const CLIMATE_X = -58300
const CLIMATE_Z = -12400

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
    SEA_Y + 3.4 + smoothstep(0.5, 0.8, c) * 46,
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
  h = mix(h, SEA_Y + 3.4 + smoothstep(0.5, 0.8, c) * 46, landK)

  // rugged 0..1: low erosion means broken ground, high means placid
  const rugged = smoothstep(0.62, 0.3, fbm(wx * F_ERO, wz * F_ERO, S_ERO, 3))

  // ranges: crests where the mask says a range runs, and only on real land
  const rangeMask = smoothstep(0.52, 0.78, fbm(wx * F_RANGE, wz * F_RANGE, S_RANGE, 3))
  const crest = ridged(wx * F_RANGE * 1.35, wz * F_RANGE * 1.35, S_CREST, 5)
  h += Math.pow(crest, 2.1) * rangeMask * rugged * landK * 380

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

  return h
}

/** 0..1 strength of the river vein through this point (1 = mid-channel) */
export const riverAt = (x: number, z: number) =>
  vein((x + WORLD_X) * F_RIVER, (z + WORLD_Z) * F_RIVER, S_RIVER, 0.03, 3)

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
  return clamp01(m - smoothstep(120, 340, height - SEA_Y) * 0.22)
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
