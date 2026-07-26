import { clamp01, mix, noise2, smoothstep } from './noise'
import {
  elevationAt, moistureAt, riverAt, temperatureAt, terraceAt, SEA_Y,
} from './land'
import { placeAt, roadAt, type Place, type Road } from './settlements'
import { GRID, OFF_X, OFF_Z, RESERVED } from './grid'
import { BIOMES, URBAN_TINT, classify, type BiomeId } from './biomes'
import type { StepSurface } from '../core/sfx'

/*
  The finished ground: land.ts's planet with everything human graded into it,
  and the one place that answers "how high is the world here" for both the
  mesh and the player's feet.

  Three gradings sit on top of the raw elevation, in this order:

  - a settlement flattens its footprint onto a terrace, easing back into the
    landscape across its outer fifth. Towns are built on flat ground because
    towns are always built on flat ground.
  - a road corridor flattens across its width. In town it grades onto the same
    terrace as everything else; out in the country it grades onto the ground
    along its own centreline, so a lane rides the hills lengthways while
    staying level underfoot — which is what a graded road actually is, and it
    means road geometry never has to reconcile a cross-slope.
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
  let h = elevationAt(x, z)
  const place = placeAt(x, z)
  if (place.grade > 0) h = mix(h, place.padY, place.grade)
  const road = roadAt(x, z, place)
  if (road.grade > 0) {
    // in town the road joins the terrace; in the country it grades onto its
    // own centreline, one extra elevation probe and no cross-slope
    const target = place.district
      ? place.padY
      : road.axis === 'x'
        ? elevationAt(x, road.line)
        : elevationAt(road.line, z)
    // ...but a road only cuts so deep. Unbounded, a spine crossing a ridge
    // excavated a slot canyon with vertical thirty-unit banks; past this
    // depth the corridor gives up grading and the lane simply climbs the
    // hill, steep but honest
    const cut = smoothstep(22, 9, Math.abs(h - target))
    h = mix(h, target, road.grade * cut)
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
