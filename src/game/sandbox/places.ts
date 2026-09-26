import type { BiomeId } from '../world/biomes'
import { landmarkAt, LANDMARK_CELL, type LandmarkKind } from '../world/landmarks'
import { placeAt, roadAt, type District } from '../world/settlements'
import { sampleAt, terrainY, SEA_Y } from '../world/terrain'

/*
  Where `tp` goes when it is given a name instead of coordinates.

  The same vocabulary the photo harness uses (`npm run shoot -- town:downtown`,
  `landmark:lighthouse`, `biome:wetland`), because the people typing it are
  the same people and one set of words is enough. The difference is where the
  search starts: the harness searches outward from the house so a picture is
  reproducible, and the console searches outward from wherever you are
  standing, because "take me to a lighthouse" means the nearest one.

  Every answer is a pure field search (the planet is a function of x and z),
  so nothing has to be loaded to find a place, and a place in another
  continent is found as easily as one down the road. What *is* worth care is
  where exactly you land:

  - a town: on the asphalt of a street in the right district, never on a
    block, where the odds of arriving inside a building are about even;
  - a landmark: a little way off its pad, facing it, so the lighthouse is in
    front of you rather than around you;
  - a biome: somewhere that is that biome and not a town, and above water.

  Dynamic-imported by the `tp` command, so none of this (it reaches the world
  generator) sits in the scene's eager chunk.
*/

export interface Found {
  x: number
  z: number
  /** the heading to arrive facing, compass yaw (0 looks down -z) */
  yaw?: number
  label: string
}

/** walk outward on a coarse spiral until a predicate holds */
const spiral = (
  x0: number, z0: number, ok: (x: number, z: number) => boolean, step: number, rings: number,
) => {
  if (ok(x0, z0)) return [x0, z0] as const
  for (let r = 1; r < rings; r++) {
    const n = r * 6
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = x0 + Math.cos(a) * r * step
      const z = z0 + Math.sin(a) * r * step
      if (ok(x, z)) return [x, z] as const
    }
  }
  return null
}

export const DISTRICTS: readonly District[] = ['downtown', 'midrise', 'suburb']
export const LANDMARKS: readonly LandmarkKind[] = [
  'lighthouse', 'windmill', 'farm', 'mast', 'ruins', 'watertower', 'stones', 'cabin', 'wreck',
]
export const BIOMES: readonly BiomeId[] = [
  'beach', 'plains', 'forest', 'taiga', 'tundra', 'snow', 'desert', 'savanna', 'jungle',
  'wetland', 'rock', 'ocean',
]

const faceFrom = (fromX: number, fromZ: number, toX: number, toZ: number) =>
  Math.atan2(-(toX - fromX), -(toZ - fromZ))

export const findTown = (district: District, x0: number, z0: number): Found | null => {
  // a coarse pass for the district, then a fine one for a street inside it
  const coarse = spiral(x0, z0, (x, z) => placeAt(x, z).district === district, 48, 140)
  if (!coarse) return null
  const street = spiral(coarse[0], coarse[1], (x, z) => {
    const p = placeAt(x, z)
    return p.district === district && roadAt(x, z, p).asphalt
  }, 4, 30)
  const [x, z] = street ?? coarse
  return { x, z, label: `town:${district}` }
}

export const findLandmark = (kind: LandmarkKind, x0: number, z0: number): Found | null => {
  // square rings of landmark cells around the one we are in (corners come up
  // twice, which costs a lookup and nothing else). One site per cell at most
  const c0 = Math.floor(x0 / LANDMARK_CELL)
  const d0 = Math.floor(z0 / LANDMARK_CELL)
  let best = null as { x: number; z: number; d: number } | null
  for (let r = 0; r < 60; r++) {
    for (let i = -r; i <= r; i++) {
      const cells = r === 0 ? [[0, 0]] : [[i, -r], [i, r], [-r, i], [r, i]]
      for (const [dc, dd] of cells) {
        const lm = landmarkAt((c0 + dc + 0.5) * LANDMARK_CELL, (d0 + dd + 0.5) * LANDMARK_CELL)
        if (!lm || lm.kind !== kind) continue
        const d = Math.hypot(lm.x - x0, lm.z - z0)
        if (!best || d < best.d) best = { x: lm.x, z: lm.z, d }
      }
    }
    // a site in the next ring can still be nearer than one in this ring's
    // corner, so finish one more ring before settling
    if (best && best.d < (r - 1) * LANDMARK_CELL) break
  }
  if (!best) return null
  // stand off the pad on the side we came from, looking at it
  const ang = Math.atan2(z0 - best.z, x0 - best.x)
  const off = 26
  let x = best.x + Math.cos(ang) * off
  let z = best.z + Math.sin(ang) * off
  // a shipwreck is on a beach and a lighthouse on a cliff: if the stand-off
  // is in the sea, walk round the pad until it is not
  for (let k = 0; k < 12 && terrainY(x, z) < SEA_Y + 0.4; k++) {
    const a = ang + ((k + 1) * Math.PI) / 6
    x = best.x + Math.cos(a) * off
    z = best.z + Math.sin(a) * off
  }
  return { x, z, yaw: faceFrom(x, z, best.x, best.z), label: `landmark:${kind}` }
}

export const findBiome = (biome: BiomeId, x0: number, z0: number): Found | null => {
  const hit = spiral(x0, z0, (x, z) => {
    const s = sampleAt(x, z)
    return s.biome === biome && !s.place.district && (biome === 'ocean' || terrainY(x, z) > SEA_Y + 0.5)
  }, 64, 160)
  if (!hit) return null
  return { x: hit[0], z: hit[1], label: `biome:${biome}` }
}

/** 'town:downtown', 'landmark:mast', 'biome:snow', or a bare kind/district/biome */
export const findPlace = (spec: string, x0: number, z0: number): Found | null => {
  const [head, tail] = spec.includes(':') ? spec.split(':', 2) : ['', spec]
  const want = tail.toLowerCase()
  if ((head === 'town' || !head) && (DISTRICTS as readonly string[]).includes(want)) {
    return findTown(want as District, x0, z0)
  }
  if (head === 'town' && !want) return findTown('downtown', x0, z0)
  if ((head === 'landmark' || !head) && (LANDMARKS as readonly string[]).includes(want)) {
    return findLandmark(want as LandmarkKind, x0, z0)
  }
  if ((head === 'biome' || !head) && (BIOMES as readonly string[]).includes(want)) {
    return findBiome(want as BiomeId, x0, z0)
  }
  return null
}
