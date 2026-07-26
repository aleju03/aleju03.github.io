import { Color } from 'three'
import { clamp01, mix, noise2, smoothstep } from './noise'
import {
  elevationAt, moistureAt, riverAt, temperatureAt, terraceAt, SEA_Y,
} from './land'
import {
  pavedAt, placeAt, roadAt, townGradedHeight, type Place, type Road,
} from './settlements'
import { GRID, OFF_X, OFF_Z, RESERVED } from './grid'
import { BIOMES, URBAN_TINT, classify, type BiomeId } from './biomes'
import type { StepSurface } from '../core/sfx'

/*
  The finished ground: land.ts's planet with everything human graded into it,
  and the one place that answers "how high is the world here" for both the
  mesh and the player's feet.

  Three gradings sit on top of the raw elevation, in this order:

  - a settlement flattens its footprint onto a terrace, easing back into the
    landscape past the built rim (settlements.ts's townGradedHeight — the run
    of the bank stretches with its rise, so a town against a mountain meets it
    as a mountainside, not a quarry face). Towns are built on flat ground
    because towns are always built on flat ground.
  - a road corridor flattens across its width, onto the graded ground along
    its own centreline — the same skirt-bent profile the terrain has — so one
    continuous grade runs from the town shelf into the countryside and a lane
    rides the hills lengthways while staying level underfoot. The bank either
    side runs longer the deeper the corridor cuts, which is what keeps a
    hillside cutting from standing as a 70-degree wall over the shoulder.
  - the property is pinned dead flat at y=0 with a short apron around it. The
    house is authored at y=0 and its doorstep is not negotiable; the home
    town's terrace is 0 for the same reason, so the apron has almost nothing
    left to do except cover the reserved margin.

  terrainY() is the other half of the contract. The mesh is a lattice of
  GRID-unit cells split corner to corner, and a player standing on a hillside
  has to stand on the triangle that was drawn, not on the smooth field it
  approximates — the two differ by up to a third of a unit, which is a visible
  hover or a visible sink. So terrainY reproduces the mesh exactly: the same
  lattice, the same diagonal, the same barycentric interpolation the GPU does.
  Chunk meshes call latticeHeight for their vertices and get the same cached
  values, so shared edges between neighbouring chunks are identical to the bit
  and no crack can open between them.
*/

export { SEA_Y }

/** how far past the reserved property the ground is held flat before the
    world is allowed to have opinions again */
const APRON = 26

/** the pitch of a road's cut-and-fill bank, rise per unit (~29 degrees) */
const BATTER = 0.55
/** where a road's earthwork must be fully released. Kept under half a chunk:
    roadAt only ever sees the nearest lattice line, so an earthwork reaching
    past the midline between two streets would be cut off mid-bank by the
    nearest-line flip — probed at an 11-unit cliff hiding exactly there. */
const REACH = 30

export interface Surface {
  height: number
  biome: BiomeId
  place: Place
  road: Road
}

/* ------------------------------------------------------- graded height -- */

/** the final ground height at any point — the number everything else means
    when it says "the ground". Not cheap; prefer latticeHeight/terrainY. */
export const heightAt = (x: number, z: number) => {
  const place = placeAt(x, z)
  let h = townGradedHeight(place, elevationAt(x, z))
  const road = roadAt(x, z, place)
  if (road.axis) {
    const deep = place.town !== null && place.d < 0.8
    // one street's earthwork: pull the ground toward the road's level — the
    // graded ground along its own centreline, which the town skirt has
    // already bent onto the shelf, so one continuous profile runs from the
    // middle of town into the open country — by at most the offset that can
    // still be released back to the hillside at the batter pitch within the
    // corridor's reach. min(need, slack) is the whole shape: a level bench
    // where the slack exceeds the need, a bank at the batter past it,
    // nothing at all by REACH, and every slope it can produce is bounded at
    // natural-plus-batter by construction. An earlier version shaped the
    // bank with a smoothstep whose width came from the pointwise cut depth,
    // and on a mountainside the falloff's edge receded faster than the
    // walker climbed toward it: a 70-degree wall out in the grass, which is
    // the quarry face this formulation exists to prevent.
    const earthwork = (axis: 'x' | 'z', line: number, dist: number, live: number, end: number) => {
      const target = deep
        ? place.padY
        : axis === 'x'
          ? townGradedHeight(placeAt(x, line), elevationAt(x, line))
          : townGradedHeight(placeAt(line, z), elevationAt(line, z))
      const want = target - h
      // the run left to release in: sideways to the corridor's reach, or
      // along the line to where the street's live run stops (RoadArm.end)
      const slack = BATTER * Math.max(0, Math.min(REACH - dist, end))
      const mag = Math.min(Math.abs(want), slack)
      if (mag > 0) h += (want > 0 ? mag : -mag) * live
    }
    // both streets shape the ground, in fixed axis order — never "nearest
    // first", which flips along the block corner's diagonal (Road.other)
    const arms: Array<[('x' | 'z'), number, number, number, number]> = [
      [road.axis, road.line, road.dist, road.live, road.end],
    ]
    if (road.other) {
      arms.push([road.other.axis, road.other.line, road.other.dist, road.other.live, road.other.end])
    }
    if (arms.length === 2 && arms[0][0] === 'z') arms.reverse()
    for (const [axis, line, dist, live, end] of arms) earthwork(axis, line, dist, live, end)
  }
  // the authored property, and a short apron so the lawn doesn't meet a bank
  const dx = Math.max(RESERVED.minX - x, x - RESERVED.maxX, 0)
  const dz = Math.max(RESERVED.minZ - z, z - RESERVED.maxZ, 0)
  const pad = 1 - smoothstep(0, APRON, Math.hypot(dx, dz))
  return pad > 0 ? mix(h, 0, pad) : h
}

/* --------------------------------------------------- the drawn surface -- */

/** heights at lattice points, shared by the mesh builders and the collision
    probe. Keyed on integer lattice coordinates, so the two can never disagree
    about where the ground is. Cleared wholesale when it outgrows a ring's
    worth of vertices — the world is a pure function, so a cold cache costs
    time and nothing else. */
const latticeCache = new Map<number, number>()
const CACHE_CAP = 120000

export const latticeHeight = (i: number, j: number) => {
  // pack two signed 21-bit lattice coords into one number key: cheaper than a
  // template string by enough to matter at a few thousand lookups a frame
  const key = (i + 1048576) * 2097152 + (j + 1048576)
  const hit = latticeCache.get(key)
  if (hit !== undefined) return hit
  const h = heightAt(OFF_X + i * GRID, OFF_Z + j * GRID)
  if (latticeCache.size > CACHE_CAP) latticeCache.clear()
  latticeCache.set(key, h)
  return h
}

/**
 * The height of the *drawn* ground: the same lattice, diagonal and
 * interpolation the terrain mesh is built from. This is what the player
 * stands on.
 */
export const terrainY = (x: number, z: number) => {
  const fx = (x - OFF_X) / GRID
  const fz = (z - OFF_Z) / GRID
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  const u = fx - i
  const v = fz - j
  const h00 = latticeHeight(i, j)
  const h11 = latticeHeight(i + 1, j + 1)
  // cells split from (0,0) to (1,1); which side of that diagonal decides
  // which triangle's plane is underfoot
  if (v < u) {
    const h10 = latticeHeight(i + 1, j)
    return h00 + (h10 - h00) * u + (h11 - h10) * v
  }
  const h01 = latticeHeight(i, j + 1)
  return h00 + (h11 - h01) * u + (h01 - h00) * v
}

/** |grad h| off the drawn surface, for biome classification and for deciding
    what is too steep to build or scatter on */
export const slopeAt = (x: number, z: number) => {
  const d = GRID
  const gx = (terrainY(x + d, z) - terrainY(x - d, z)) / (2 * d)
  const gz = (terrainY(x, z + d) - terrainY(x, z - d)) / (2 * d)
  return Math.hypot(gx, gz)
}

/* --------------------------------------------------------------- biome -- */

/** the biome at a point. `slope` is passed in because chunk builders already
    have it from their own height grid for free, and recomputing it here would
    triple the cost of colouring a mesh. */
const S_EDGE = 0x3b8d

export const biomeAt = (x: number, z: number, height: number, slope: number): BiomeId => {
  const depth = height - SEA_Y
  // A hard classifier draws hard edges, and a forest that stops along a clean
  // geometric curve is the tell that a table decided it rather than a place.
  // Jittering the climate by a high-frequency wobble before the thresholds
  // are applied breaks that line into an interlocking, ragged margin — the
  // two biomes finger into each other the way real ones do — for two extra
  // noise lookups and no blending machinery at all.
  const edge = (noise2(x * 0.031, z * 0.031, S_EDGE) - 0.5) * 0.055
  const edge2 = (noise2(x * 0.017 + 31, z * 0.017 - 12, S_EDGE ^ 0x55) - 0.5) * 0.05
  const temp = temperatureAt(x, z, height) + edge
  const moist = moistureAt(x, z, height) + edge2
  return classify(depth, slope, temp, moist)
}

const S_TINT = 0x7c31
const tintMix = (x: number, z: number) =>
  clamp01(noise2(x * 0.035, z * 0.035, S_TINT) * 1.25 - 0.12)

/** the two tints to blend, and how far between them, for a ground vertex.
    Paved ground overrides the biome: a street is a street in any climate. */
export const tintAt = (
  x: number,
  z: number,
  biome: BiomeId,
  paved: number,
): [string, string, number] => {
  if (paved > 0.5) return [URBAN_TINT[0], URBAN_TINT[1], tintMix(x, z)]
  return [BIOMES[biome].tint[0], BIOMES[biome].tint[1], tintMix(x, z)]
}

/* ------------------------------------------------ the drawn ground colour -- */

/*
  The colour half of the terrainY contract. The ground mesh carries one colour
  per lattice vertex and the GPU blends it across each triangle, which means
  the colour the player actually sees at (x, z) is not tintAt(x, z) — it is
  the interpolation of the four surrounding lattice samples, and near a paved
  street the urban grey visibly bleeds four units into the verge. Everything
  that wants to *match* the ground (the grass field, above all) therefore has
  to sample the drawn colour, not the ideal field: latticeGround is the cached
  per-vertex sample the chunk mesh itself is built from, and groundColorAt
  interpolates it with the same diagonal and barycentric weights terrainY uses
  for height. One function feeding both is what makes a blade of grass and the
  soil under it the same colour by construction — they disagreed by formula
  before, and every lawn read as bright litter scattered on darker felt.

  The sun-dried straw drifts live here too, on the grassy biomes' bare ground
  as well as in the blades (one low-frequency noise, squared so only its
  crests bleach — the environmental patch value from cortiz2894's GrassField,
  sampled CPU-side per vertex): a meadow's mottle has to be *in the ground*
  for the grass growing out of it to look rooted rather than sprayed on.
*/

export interface GroundSample {
  r: number
  g: number
  b: number
  /** how paved the town has this lattice point, 0..1 (pavedAt) */
  paved: number
  biome: BiomeId
}

const S_PATCH = 0x77aa
const gc = new Color()
const gc2 = new Color()
const PAVED_GREY = new Color('#6f6f66')
const STRAW = new Color('#a89a58')

const groundCache = new Map<number, GroundSample>()
const GROUND_CACHE_CAP = 40000

/** the ground vertex at lattice point (i, j): colour, pavedness, biome —
    exactly what the chunk mesh bakes there, cached like latticeHeight */
export const latticeGround = (i: number, j: number): GroundSample => {
  const key = (i + 1048576) * 2097152 + (j + 1048576)
  const hit = groundCache.get(key)
  if (hit !== undefined) return hit
  const x = OFF_X + i * GRID
  const z = OFF_Z + j * GRID
  const y = latticeHeight(i, j)
  const slope = Math.hypot(
    (latticeHeight(i + 1, j) - latticeHeight(i - 1, j)) / (2 * GRID),
    (latticeHeight(i, j + 1) - latticeHeight(i, j - 1)) / (2 * GRID),
  )
  const biome = biomeAt(x, z, y, slope)
  const place = placeAt(x, z)
  const paved = pavedAt(place, roadAt(x, z, place))
  const [a, b, t] = tintAt(x, z, biome, paved)
  gc.set(a).lerp(gc2.set(b), t)
  if (paved > 0 && paved < 1) gc.lerp(PAVED_GREY, paved * 0.5)
  if (paved <= 0 && BIOMES[biome].surface === 'grass') {
    const patch = noise2(x * 0.041, z * 0.041, S_PATCH)
    gc.lerp(STRAW, patch * patch * 0.5)
  }
  const out: GroundSample = { r: gc.r, g: gc.g, b: gc.b, paved, biome }
  if (groundCache.size > GROUND_CACHE_CAP) groundCache.clear()
  groundCache.set(key, out)
  return out
}

/**
 * The colour of the *drawn* ground at (x, z), written into `out` (linear,
 * before the ground material's detail map). Same lattice, same diagonal, same
 * barycentric weights as terrainY, so this is the pixel the terrain renders —
 * gradient bleed near pavement and biome edges included. Returns the equally
 * interpolated pavedness, which is the number that says how concrete the
 * ground *looks* here rather than how paved the town records it.
 */
export const groundColorAt = (
  x: number,
  z: number,
  out: { r: number; g: number; b: number },
): number => {
  const fx = (x - OFF_X) / GRID
  const fz = (z - OFF_Z) / GRID
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  const u = fx - i
  const v = fz - j
  const g00 = latticeGround(i, j)
  const g11 = latticeGround(i + 1, j + 1)
  if (v < u) {
    const g10 = latticeGround(i + 1, j)
    out.r = g00.r + (g10.r - g00.r) * u + (g11.r - g10.r) * v
    out.g = g00.g + (g10.g - g00.g) * u + (g11.g - g10.g) * v
    out.b = g00.b + (g10.b - g00.b) * u + (g11.b - g10.b) * v
    return g00.paved + (g10.paved - g00.paved) * u + (g11.paved - g10.paved) * v
  }
  const g01 = latticeGround(i, j + 1)
  out.r = g00.r + (g11.r - g01.r) * u + (g01.r - g00.r) * v
  out.g = g00.g + (g11.g - g01.g) * u + (g01.g - g00.g) * v
  out.b = g00.b + (g11.b - g01.b) * u + (g01.b - g00.b) * v
  return g00.paved + (g11.paved - g01.paved) * u + (g01.paved - g00.paved) * v
}

/* ------------------------------------------------------------- surface -- */

/** everything a caller usually wants at once. One place lookup, reused. */
export const sampleAt = (x: number, z: number): Surface => {
  const height = terrainY(x, z)
  const place = placeAt(x, z)
  return {
    height,
    place,
    road: roadAt(x, z, place),
    biome: biomeAt(x, z, height, slopeAt(x, z)),
  }
}

/** what a footstep lands on out here. The house owns the property line
    inward; this answers for everywhere else. */
export const surfaceAt = (x: number, z: number): StepSurface => {
  const place = placeAt(x, z)
  const road = roadAt(x, z, place)
  if (road.asphalt) return 'asphalt'
  if (road.walk) return 'stone'
  const h = terrainY(x, z)
  if (h < SEA_Y) return 'water'
  return BIOMES[biomeAt(x, z, h, slopeAt(x, z))].surface
}

/** is this point in open water deep enough to swim in, rather than a puddle
    on a riverbank */
export const waterDepthAt = (x: number, z: number) => Math.max(0, SEA_Y - terrainY(x, z))

/** how much of a river runs through here, for the reed/bank dressing */
export const riverK = riverAt

/** the smooth continental terrace, re-exported so chunk builders can size a
    town's ground without importing land.ts directly */
export const terraceHeight = terraceAt
