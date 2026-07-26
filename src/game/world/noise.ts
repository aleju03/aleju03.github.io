/*
  The world's randomness, hashed by position rather than streamed.

  core/rand.ts gives every other system a `seeded()` LCG: pull it in order and
  you get the same sequence back. That works when one builder owns one region
  and always walks it the same way — a chunk of backrooms, a yard's worth of
  grass tufts. It does not work for an endless world, because a stream's value
  depends on how many values were drawn before it, and out here the draw order
  is whatever the player's feet decided. Walk east then north and you'd get a
  different forest than walking north then east.

  So everything below is a pure function of coordinates. hash2() mixes an
  integer lattice point and a salt into 32 bits; value noise interpolates that
  lattice with a smoothstep; fbm stacks octaves. Nothing carries state, so a
  point queried from a chunk build, from a collision probe, or from the far LOD
  ring a minute later always answers the same. That is the property the save
  file and the multiplayer server will both need, and it costs nothing today.

  Frequencies are expressed in 1/world-units by the callers, so a "scale" of
  1/2600 means one feature per 2600 units. Everything returns 0..1 unless it
  says otherwise, which keeps the field algebra in terrain.ts readable.
*/

/** 32-bit integer hash of a lattice point. The multipliers are the usual
    large odd primes; the shift-xor rounds are what actually decorrelate
    neighbours, and without them a grid this regular shows visible banding. */
export const hash2 = (x: number, z: number, salt: number) => {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + (salt | 0)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** hashed lattice point as 0..1 */
export const rand2 = (x: number, z: number, salt: number) => hash2(x, z, salt) / 4294967296

/** hashed 0..1 from three ints — for "the 4th tree in cell (x,z)" style draws */
export const rand3 = (x: number, z: number, i: number, salt: number) =>
  hash2(x, Math.imul(z, 31) + i, salt) / 4294967296

const fade = (t: number) => t * t * (3 - 2 * t)

/** value noise on the unit lattice, smoothstep-interpolated. Cheaper than
    gradient noise and, once a few octaves are stacked, indistinguishable at
    the scale a walking player reads terrain at. */
export const noise2 = (x: number, z: number, salt: number) => {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const xf = fade(x - xi)
  const zf = fade(z - zi)
  const a = rand2(xi, zi, salt)
  const b = rand2(xi + 1, zi, salt)
  const c = rand2(xi, zi + 1, salt)
  const d = rand2(xi + 1, zi + 1, salt)
  const top = a + (b - a) * xf
  const bot = c + (d - c) * xf
  return top + (bot - top) * zf
}

/** stacked octaves, normalized back to 0..1 */
export const fbm = (
  x: number,
  z: number,
  salt: number,
  octaves = 4,
  gain = 0.5,
  lacunarity = 2,
) => {
  let sum = 0
  let amp = 1
  let norm = 0
  let fx = x
  let fz = z
  for (let i = 0; i < octaves; i++) {
    sum += noise2(fx, fz, salt + i * 1013) * amp
    norm += amp
    amp *= gain
    fx *= lacunarity
    fz *= lacunarity
  }
  return sum / norm
}

/** absolute-value noise folded to put a crease at every zero crossing: the
    standard way to get mountain ridges instead of rolling blobs. 0..1, and
    the high end is where the crest lines run. */
export const ridged = (x: number, z: number, salt: number, octaves = 4) => {
  let sum = 0
  let amp = 1
  let norm = 0
  let fx = x
  let fz = z
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(fx, fz, salt + i * 7717) * 2 - 1)
    sum += n * n * amp
    norm += amp
    amp *= 0.5
    fx *= 2.02
    fz *= 2.02
  }
  return sum / norm
}

/** offset the sample point by another noise field before reading it. Straight
    fbm looks like a contour map; warping it is what makes coastlines wander
    and river valleys meander instead of running in tidy circles. */
export const warped = (
  x: number,
  z: number,
  salt: number,
  strength: number,
  octaves = 4,
) => {
  const wx = noise2(x * 0.5 + 11.3, z * 0.5 - 7.1, salt ^ 0x51a3) - 0.5
  const wz = noise2(x * 0.5 - 3.7, z * 0.5 + 19.2, salt ^ 0x2c7f) - 0.5
  return fbm(x + wx * strength, z + wz * strength, salt, octaves)
}

/** signed distance-ish band around the 0.5 level set of a warped field, 1 on
    the line and falling to 0 at `width`. Rivers, seams, anything that should
    read as a thin winding line rather than a patch. */
export const vein = (
  x: number,
  z: number,
  salt: number,
  width: number,
  octaves = 3,
) => {
  const v = Math.abs(warped(x, z, salt, 0.7, octaves) - 0.5)
  if (v >= width) return 0
  const t = 1 - v / width
  return t * t * (3 - 2 * t)
}

export interface Site {
  /** cell coordinates the site belongs to (its identity) */
  cx: number
  cz: number
  /** world position, jittered inside the cell */
  x: number
  z: number
  /** the cell's own 0..1 roll, for whoever wants to rank it */
  roll: number
}

/** the jittered point owned by one cell of a `cell`-unit grid. One site per
    cell keeps lookups O(9) instead of O(world), which is what makes "is there
    a town near here" answerable per terrain vertex. */
export const siteOf = (cx: number, cz: number, cell: number, salt: number): Site => ({
  cx,
  cz,
  x: (cx + 0.5 + (rand2(cx, cz, salt) - 0.5) * 0.62) * cell,
  z: (cz + 0.5 + (rand2(cx, cz, salt ^ 0x9e37) - 0.5) * 0.62) * cell,
  roll: rand2(cx, cz, salt ^ 0x4f1b),
})

/** every site whose cell touches the 3x3 neighbourhood of (x, z) */
export const sitesNear = (x: number, z: number, cell: number, salt: number): Site[] => {
  const cx = Math.floor(x / cell)
  const cz = Math.floor(z / cell)
  const out: Site[] = []
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) out.push(siteOf(cx + dx, cz + dz, cell, salt))
  return out
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export const mix = (a: number, b: number, t: number) => a + (b - a) * t
