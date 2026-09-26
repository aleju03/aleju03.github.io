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

  The brief is Lethal Company's craft without its dread. By day the air is
  thin and a little warm: things keep their colour and contrast a long way
  out, and a town down the road is a place you can see and head for. It is
  at dusk that it layers the view into planes (the street in full colour,
  the next block flattened toward the sky, the hills beyond as silhouettes).
  It thickens where the ground is wooded or wet and at the ends of the day,
  and thins over open country and down a street. At night the haze is a
  moonlit blue, dark but brighter than the ground, so roofs, hills and
  crowns read as silhouettes against it, and what stands out of it is lit:
  lamp pools under the streetlights, windows, and, once it is properly
  dark, the soft pool of your own headlamp.

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
  alt = 0, reach = 0, baseY = 0,
) => {
  const out = 1 - s.indoor
  // the haze distance: open at noon, closing in through twilight to night
  // noon is thin on purpose: a friendly day has contrast half a kilometre
  // out, and the layering it wants comes from the dusk and the woods
  const dark = s.night * (1 - s.twilight)
  // the woods thicken the air mostly once the light goes: at noon a forest
  // should still read as green all the way into the trees
  const lift = Math.min(1, Math.max(0, (alt - 15) / 110))
  // ...and not from the air, where the frame is a whole landscape and the
  // wood under the camera is a speck of it
  const woods = 1 + (biome - 1) * (1 - 0.6 * s.day) * (1 - lift)
  // the twilight no longer thickens it: from a height, a dusk that did
  // turned everything past thirty metres into one mauve plane
  // From the air (levels/altitude.ts, world/farfield.ts): the camera is
  // above most of the haze, so the air thins (a longer e-folding distance),
  // and toward where the far field ends it takes all of the rest (the grade
  // shader's rim), on one curve that only ever rises with range. `alt` is
  // the camera's height over the ground under it, `reach` how far the far
  // field goes; `baseY` is kept for the signature and unused
  // From the air the curve is also allowed to finish: on the ground the air
  // is capped (max below) so a friendly day keeps its colour, and from a
  // hundred units up that cap left the hills a kilometre off as green and
  // sharp as the town below, ending on a hard line against the sky. Up
  // there distance should take things over steadily until the horizon is
  // air, so the ceiling rises toward one and the curve lengthens to match
  const ground = (300 * s.day + 90 * (1 - s.day)) * woods
  const dist = ground + (1600 * s.day + 700 * (1 - s.day) - ground) * lift
  air.start = 8 + 30 * lift
  air.dist = dist
  air.liftK = lift
  air.liftBase = baseY
  air.edge = lift > 0 && reach > 0 ? reach * 0.97 : 0
  const cap = 0.36 + 0.36 * dark - 0.08 * s.twilight
  air.max = (cap + (0.95 - cap) * lift) * out
  air.planes = 0
  // warm hazy air by day: the sky module's fog is a cool pale blue, which
  // reads as overcast once the grade has had it; nudged toward cream it
  // reads as a summer afternoon's haze instead
  // At night the sky module's fog is nearly black, and a haze of it turned
  // open country into a void. Brightened toward a moonlit blue it becomes a
  // glow on the horizon that trees, hills and roofs stand out against
  const warm = s.day * (1 - s.twilight)
  // squared, so it belongs to the night: through the afterglow a moonlit
  // brightening made the horizon a pale lavender slab the band drowned in
  const moon = dark * dark * out
  air.tint.setRGB(
    (1 + 0.07 * warm) * (1 + 3.4 * moon),
    (1 + 0.02 * warm) * (1 + 4.0 * moon),
    (1 - 0.08 * warm) * (1 + 4.8 * moon))
  air.sunDir.copy(sunDir)
  // the air glows warm toward a low sun, and hardly at all toward a high one
  // ...and toward a set one: at dusk the warmth is in the light and in the
  // sky's sunward side, while the air itself stays cool
  const glow = (0.12 * s.day + 0.5 * s.twilight) * out
  air.sunGlow.copy(sunColor).multiplyScalar(glow)
  // by day the sky keeps its own blue down to near the skyline; the pull
  // into the air is for dusk and night, when the two should be one
  // ...and from the air, where hills stand against the low sky, the low sky
  // is the same air the hills are going into, or every ridge ends on a line
  air.skyHorizon = (0.8 - 0.55 * warm + 0.55 * warm * lift) * out
  // the afterglow and the silhouettes against it: warm along the skyline
  // while the twilight lasts, and the air on things a shade darker than the
  // sky from dusk on, so a tower reads as a shape against the glow
  // a set amber rather than the sun's own colour, which by then is a
  // rose that the night grade pulled toward lavender
  air.duskBand.setRGB(1.0, 0.5, 0.2).multiplyScalar(1.3 * s.twilight * out)
  air.dim = 1 - 0.3 * (1 - s.day) * out
  air.skyReach = 0.14 + 0.1 * (1 - warm) + 0.12 * s.twilight + 0.1 * lift
  air.skyAll = (0.04 + 0.22 * dark) * out
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
  // the headlamp waits for real dark: through the dusk it would be a torch
  // shone into daylight, so it fades in over the last of the twilight
  const dark = Math.min(1, Math.max(0, (s.night * (1 - s.twilight) - 0.55) / 0.35))
  const h = HEAD_GAIN * dark * dark * (3 - 2 * dark)
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
