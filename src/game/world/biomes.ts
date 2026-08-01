import type { StepSurface } from '../core/sfx'

/*
  What grows where. land.ts hands over a height, a slope, a temperature and a
  moisture; this module turns that quadruple into a biome, and a biome into a
  palette and a scatter list.

  The classifier is a Whittaker diagram with three overrides in front of it.
  Water and its shoreline come first, because they are decided by height
  alone. Bare rock comes next, because a slope steep enough to shed soil is
  bare whatever the weather says. Permanent snow comes last of the overrides,
  by temperature, which is how a peak on the equator still wears a cap — the
  altitude lapse in land.ts has already made the summit cold by the time the
  question is asked here.

  Colours are per-vertex, not per-texture: the terrain mesh carries one
  grayscale detail map and tints it with vertex colour, so a biome boundary
  needs no splat map and no shader — adjacent vertices in different biomes
  interpolate across the triangle between them and the transition blends for
  free. Each biome carries two tints and a fine noise picks between them, so
  a meadow reads as mottled rather than as a painted plane.

  Densities are expected counts per chunk (64x64 units). They are the honest
  tuning knob in this file: a forest at 120 trees a chunk is a forest you push
  through, at 40 it is parkland. Scatter never spawns inside a road corridor
  or on the reserved property, so those numbers are upper bounds.
*/

export type BiomeId =
  | 'ocean'
  | 'beach'
  | 'plains'
  | 'forest'
  | 'taiga'
  | 'tundra'
  | 'snow'
  | 'desert'
  | 'savanna'
  | 'jungle'
  | 'wetland'
  | 'rock'

export type PropKind =
  | 'broadleaf'
  | 'birch'
  | 'pine'
  | 'palm'
  | 'acacia'
  | 'deadtree'
  | 'cactus'
  | 'bush'
  | 'shrub'
  | 'rock'
  | 'boulder'
  | 'reed'
  | 'tuft'

export interface Scatter {
  kind: PropKind
  /** expected instances per 64x64 chunk */
  per: number
  /** uniform scale range */
  scale: [number, number]
}

export interface Biome {
  id: BiomeId
  /** the two ground tints a fine noise mixes between */
  tint: [string, string]
  /** what props.ts paints its kits with here: trunk, foliage, and the third
      colour that does duty as birch bark, stone, sand and dead wood */
  pal: { bark: string; leaf: string; accent: string }
  surface: StepSurface
  /** trees and anything else that wants a collision box */
  flora: Scatter[]
  /** ground cover: no collision, merged into one draw per chunk */
  cover: Scatter[]
}

const B = (
  id: BiomeId,
  tint: [string, string],
  pal: Biome['pal'],
  surface: StepSurface,
  flora: Scatter[],
  cover: Scatter[],
): Biome => ({ id, tint, pal, surface, flora, cover })

const BARK = '#4a3826'
const STONE = '#7b756c'

export const BIOMES: Record<BiomeId, Biome> = {
  ocean: B('ocean', ['#3f4a4a', '#4d5647'],
    { bark: BARK, leaf: '#4c6b5a', accent: '#8d8467' }, 'sand', [], []),

  beach: B('beach', ['#c2b183', '#ab9a70'],
    { bark: '#6b563a', leaf: '#6f8f4d', accent: '#b5a687' }, 'sand', [
      { kind: 'palm', per: 2.5, scale: [0.85, 1.15] },
    ], [
      { kind: 'rock', per: 5, scale: [0.5, 1.1] },
    ]),

  plains: B('plains', ['#5f7440', '#728245'],
    { bark: BARK, leaf: '#5c7a37', accent: '#8f9b7a' }, 'grass', [
      { kind: 'broadleaf', per: 5, scale: [0.85, 1.15] },
      { kind: 'bush', per: 7, scale: [0.7, 1.2] },
    ], [
      { kind: 'tuft', per: 145, scale: [0.7, 1.5] },
      { kind: 'rock', per: 3, scale: [0.4, 0.9] },
    ]),

  forest: B('forest', ['#3f5a30', '#4a6533'],
    { bark: BARK, leaf: '#3e6b2c', accent: '#c8c6bb' }, 'grass', [
      { kind: 'broadleaf', per: 40, scale: [0.8, 1.15] },
      { kind: 'birch', per: 18, scale: [0.85, 1.1] },
      { kind: 'bush', per: 18, scale: [0.7, 1.25] },
    ], [
      { kind: 'tuft', per: 112, scale: [0.6, 1.2] },
      { kind: 'shrub', per: 22, scale: [0.6, 1.1] },
    ]),

  taiga: B('taiga', ['#42553f', '#4d5c46'],
    { bark: '#3d2f22', leaf: '#2f5340', accent: '#8a8478' }, 'grass', [
      { kind: 'pine', per: 36, scale: [0.8, 1.2] },
      { kind: 'shrub', per: 12, scale: [0.6, 1.0] },
    ], [
      { kind: 'tuft', per: 44, scale: [0.5, 1.0] },
      { kind: 'rock', per: 8, scale: [0.5, 1.2] },
    ]),

  tundra: B('tundra', ['#6d7263', '#7d8070'],
    { bark: '#4b4438', leaf: '#6a7355', accent: STONE }, 'grass', [
      { kind: 'shrub', per: 9, scale: [0.5, 0.9] },
    ], [
      { kind: 'rock', per: 16, scale: [0.4, 1.3] },
      { kind: 'tuft', per: 26, scale: [0.4, 0.8] },
    ]),

  snow: B('snow', ['#d9dfe4', '#c3ccd4'],
    { bark: '#4a4038', leaf: '#37523f', accent: '#aeb6bd' }, 'snow', [
      { kind: 'pine', per: 7, scale: [0.75, 1.05] },
    ], [
      { kind: 'rock', per: 10, scale: [0.5, 1.4] },
    ]),

  desert: B('desert', ['#c9ae76', '#b89a62'],
    { bark: '#7a6242', leaf: '#5f7a44', accent: '#b09b6e' }, 'sand', [
      { kind: 'cactus', per: 6, scale: [0.8, 1.5] },
      { kind: 'deadtree', per: 1.6, scale: [0.85, 1.1] },
    ], [
      { kind: 'rock', per: 9, scale: [0.4, 1.2] },
      { kind: 'shrub', per: 5, scale: [0.5, 0.9] },
    ]),

  savanna: B('savanna', ['#8d8b4d', '#9c9455'],
    { bark: '#5d4a2f', leaf: '#6d7a3c', accent: '#a09468' }, 'grass', [
      { kind: 'acacia', per: 7, scale: [0.9, 1.2] },
      { kind: 'shrub', per: 10, scale: [0.6, 1.1] },
    ], [
      { kind: 'tuft', per: 118, scale: [0.8, 1.7] },
      { kind: 'rock', per: 4, scale: [0.4, 1.0] },
    ]),

  jungle: B('jungle', ['#2f5227', '#3a5f2b'],
    { bark: '#42341f', leaf: '#2c5c22', accent: '#7d8f5a' }, 'grass', [
      { kind: 'broadleaf', per: 48, scale: [0.95, 1.3] },
      { kind: 'palm', per: 18, scale: [0.9, 1.2] },
      { kind: 'bush', per: 30, scale: [0.9, 1.6] },
    ], [
      { kind: 'tuft', per: 145, scale: [0.9, 1.8] },
      { kind: 'shrub', per: 34, scale: [0.8, 1.5] },
    ]),

  wetland: B('wetland', ['#4a5a38', '#556340'],
    { bark: '#4a4232', leaf: '#5b7040', accent: '#8a8a6d' }, 'grass', [
      { kind: 'deadtree', per: 6, scale: [0.85, 1.15] },
      { kind: 'bush', per: 14, scale: [0.7, 1.2] },
    ], [
      { kind: 'reed', per: 180, scale: [0.8, 1.6] },
      { kind: 'tuft', per: 56, scale: [0.7, 1.3] },
    ]),

  rock: B('rock', ['#6b665f', '#7a746b'],
    { bark: '#544e46', leaf: '#5f6b52', accent: STONE }, 'stone', [], [
      { kind: 'boulder', per: 13, scale: [0.7, 1.9] },
      { kind: 'rock', per: 22, scale: [0.5, 1.5] },
    ]),
}

/** the ground a town paves over its biome with; kept out of BIOMES because
    it is never chosen by climate, only imposed by settlements.ts */
export const URBAN_TINT: [string, string] = ['#6a6a63', '#75746c']

/**
 * The biome at a point. `slope` is |grad h| (rise over run), `temp` and
 * `moist` are 0..1 from land.ts, `depth` is height above the waterline.
 */
export const classify = (
  depth: number,
  slope: number,
  temp: number,
  moist: number,
): BiomeId => {
  if (depth < 0) return 'ocean'
  // a shoreline only where the ground is gentle: a cliff into the sea is rock
  if (depth < 2.6 && slope < 0.5) return temp < 0.2 ? 'snow' : 'beach'
  if (slope > 0.62) return 'rock'
  if (temp < 0.14) return 'snow'
  if (temp < 0.3) return moist > 0.44 ? 'taiga' : 'tundra'
  if (temp < 0.58) return moist < 0.32 ? 'plains' : moist < 0.68 ? 'forest' : 'wetland'
  return moist < 0.27 ? 'desert' : moist < 0.52 ? 'savanna' : 'jungle'
}
