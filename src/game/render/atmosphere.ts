import type * as THREE from 'three'
import type { Air, FakeLights } from './pixelLook'
import { MAX_POOLS } from './shaders'

/*
  How thick the air is and what lights the night, as a function of the sky.

  `pixelLook.ts` owns the machinery (a haze curve and a few planes of it, a
  sky pulled into it at the horizon, lamp pools and a headlamp shaded from
  depth), and this module owns the numbers that turn it into weather. It is
  shared by CrtScene and the shoot harness so a shot and the game agree, and
  it takes plain numbers rather than sky.ts's state so it can be reasoned
  about, and tuned, on its own.

  The brief is Lethal Company's craft without its dread. By day the air is a
  warm haze that layers the view into planes (the street in full colour, the
  next block flattened toward the sky, the hills beyond as silhouettes) while
  a town down the road is still a place you can see and head for. It
  thickens where the ground is wooded or wet and at the ends of the day, and
  thins over open country and down a street. At night the haze is the dark, and what stands
  out of it is lit: lamp pools under the streetlights, windows, and the
  pool of your own headlamp.

  Distances are world units (the walker's eye is 3.84 up; a unit is about
  half a metre).
*/

/** How much denser than the default the air is over each biome: a multiplier
    on the haze distance, under 1 is thicker. Keyed by name so this module
    needs nothing from world/ */
export const BIOME_AIR: Record<string, number> = {
  /** a street: whatever the land under it, a town is somewhere you should
      be able to see down */
  town: 1.15,
  forest: 0.72,
  jungle: 0.6,
  taiga: 0.75,
  wetland: 0.62,
  plains: 1.15,
  savanna: 1.2,
  desert: 1.35,
  beach: 1.2,
  tundra: 1.05,
  snow: 0.95,
  rock: 1.05,
}

export interface SkyNumbers {
  /** 0 night .. 1 day */
  day: number
  night: number
  /** peaks at the horizon crossings */
  twilight: number
  /** 0 outside .. 1 inside the house */
  indoor: number
}

/** the lamp colour, before the night gain: sodium-warm, friendly */
const LAMP = [1.0, 0.7, 0.4] as const
/** how hard a lamp pool lights, at full night */
const LAMP_GAIN = 6
/** the headlamp: a warm white, and how hard */
const HEAD = [1.0, 0.93, 0.8] as const
const HEAD_GAIN = 0.9

/**
 * Set the look's air for a moment of the day. `biome` is the multiplier from
 * BIOME_AIR for the ground under the camera (1 if unknown), `sunDir` points
 * at the sun in world space, `sunColor` is the sun light's colour.
 */
export const airForSky = (
  air: Air, s: SkyNumbers, biome: number, sunDir: THREE.Vector3, sunColor: THREE.Color,
) => {
  const out = 1 - s.indoor
  // the haze distance: open at noon, closing in through twilight to night
  const dist = (170 * s.day + 62 * (1 - s.day)) * (1 - 0.2 * s.twilight) * biome
  air.start = 6
  air.dist = dist
  air.max = (0.62 + 0.14 * s.night * (1 - s.twilight) + 0.06 * s.twilight) * out
  air.planes = 0
  // warm hazy air by day: the sky module's fog is a cool pale blue, which
  // reads as overcast once the grade has had it; nudged toward cream it
  // reads as a summer afternoon's haze instead
  const warm = s.day * (1 - s.twilight)
  air.tint.setRGB(1 + 0.16 * warm, 1 + 0.04 * warm, 1 - 0.22 * warm)
  air.sunDir.copy(sunDir)
  // the air glows warm toward a low sun, and hardly at all toward a high one
  const glow = (0.12 + 0.55 * s.twilight) * s.day * out
  air.sunGlow.copy(sunColor).multiplyScalar(glow)
  air.skyHorizon = 0.8 * out
  air.skyReach = 0.28 + 0.12 * s.twilight
  air.skyAll = 0.04 * out
}

/**
 * The night's lights. `lamps` holds world x, y, z per lamp (the nearest
 * first, `count` of them), `ambient` is the hemisphere's colour times its
 * intensity, and `head` says whether and where the headlamp is on.
 */
export const lightsForSky = (
  lights: FakeLights, s: SkyNumbers, lamps: Float32Array, count: number,
  ambient: THREE.Color,
) => {
  const n = Math.min(MAX_POOLS, count)
  for (let i = 0; i < n; i++) {
    lights.pools[i * 4] = lamps[i * 3]
    lights.pools[i * 4 + 1] = lamps[i * 3 + 1]
    lights.pools[i * 4 + 2] = lamps[i * 3 + 2]
    // a streetlamp six units up lights a pool about eleven across
    lights.pools[i * 4 + 3] = 11
  }
  lights.count = n
  const k = LAMP_GAIN * Math.min(1, s.night * 1.4)
  lights.poolColor.setRGB(LAMP[0] * k, LAMP[1] * k, LAMP[2] * k)
  // a lambert surface under a hemisphere light returns albedo * irradiance / pi
  lights.ambient.copy(ambient).multiplyScalar(1 / Math.PI)
  const h = HEAD_GAIN * Math.min(1, Math.max(0, (s.night - 0.3) / 0.4))
  lights.head.color.setRGB(HEAD[0] * h, HEAD[1] * h, HEAD[2] * h)
  lights.head.on = h > 0.01
}

/**
 * The nearest `max` lamps to (x, z) out of a flat xyz list, written into
 * `out`, returning how many. An insertion sort into a fixed buffer: no
 * allocation, and the lists are a few dozen long.
 */
export const nearestLamps = (
  x: number, z: number, from: ArrayLike<number>, fromCount: number,
  out: Float32Array, max: number, dist2: Float32Array,
) => {
  let n = 0
  for (let i = 0; i < fromCount; i++) {
    const lx = from[i * 3]
    const ly = from[i * 3 + 1]
    const lz = from[i * 3 + 2]
    const d = (lx - x) * (lx - x) + (lz - z) * (lz - z)
    if (n === max && d >= dist2[n - 1]) continue
    let j = n < max ? n++ : n - 1
    while (j > 0 && dist2[j - 1] > d) {
      dist2[j] = dist2[j - 1]
      out[j * 3] = out[(j - 1) * 3]
      out[j * 3 + 1] = out[(j - 1) * 3 + 1]
      out[j * 3 + 2] = out[(j - 1) * 3 + 2]
      j--
    }
    dist2[j] = d
    out[j * 3] = lx
    out[j * 3 + 1] = ly
    out[j * 3 + 2] = lz
  }
  return n
}
