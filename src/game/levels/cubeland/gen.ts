import {
  ACACIA_LEAVES, ACACIA_LOG, AIR, BEDROCK, BIRCH_LEAVES, BIRCH_LOG, BLOCKS, BLUE_ORCHID, BROWN_CAP, BROWN_MUSHROOM,
  CACTUS, CHERRY_LEAVES, CHERRY_LOG, CLAY, COAL, CORNFLOWER, DANDELION, DARK_LEAVES, DARK_LOG, DEAD_BUSH, DIAMOND,
  DIRT, FERN, GOLD, GRASS, GRAVEL, ICE, IRON, JUNGLE_LEAVES, LAVA, JUNGLE_LOG, LEAVES, LOG, MYCELIUM, OXEYE, PACKED_ICE,
  PODZOL, POPPY, RED_CAP, RED_MUSHROOM, RED_SAND, SAND, SANDSTONE, SNOW, SNOWY_GRASS, SPRUCE_LEAVES, SPRUCE_LOG,
  STEM, STONE, SUGAR_CANE, TALL_GRASS, TERRACOTTA, TERRA_BROWN, TERRA_ORANGE, TERRA_RED, TERRA_WHITE, TERRA_YELLOW,
  WATER,
} from '../../sandbox/blocks'
import { fbm, hash2, ridged, smoothstep, vein } from '../../world/noise'

/*
  Cubeland's ground: a world of blocks generated the way the game it is
  modelled on generates one, as a pure function of the block coordinates.
  Every chunk (16 by 16 columns, H blocks tall) is rebuilt identically
  whoever asks and in whatever order, which is what lets a chunk be thrown
  away and made again, and what lets two players stand in the same world
  with nothing but their edits on the wire.

  - **Height** is continents, hills and mountains stacked: a slow field
    decides land from sea (the coast is where it crosses SEA), a faster one
    rolls the land, and a ridged field lifts mountain ranges where a third,
    slower one says there are mountains. Rivers wind across the land where
    a warped field crosses its middle, cut down to below the sea, and the
    badlands are stepped into terraces.
  - **Biomes** are picked the way the real generator picks them, off
    temperature, humidity and a "weirdness" field that chooses the rare
    variants, with the height deciding coast, sea and peaks. Nearly all of
    the overworld's are here (`BIOMES`): plains, forest, flower forest,
    birch forest, dark forest, taiga, snowy taiga, snowy plains, ice spikes,
    desert, badlands, savanna, jungle, swamp, mushroom fields, cherry grove,
    windswept hills, snowy peaks, beach, stony shore, river, ocean and
    frozen ocean. Each has its own ground, its own trees and plants, and its
    own grass and leaf colour (mesher.ts reads `BIOMES` for the tints).
  - **Underground** is stone with ore in blobs (coal high, iron lower, gold
    and diamonds deep), bedrock at the floor, lava in the bottom of the
    deepest caves (under LAVA_Y), and caves: spaghetti tunnels
    where two 3D fields both cross their middle, sampled on a four-block
    world lattice and interpolated, so the caves are as pure a function of
    position as the rest.
  - **Trees** are decided per column and written wherever their blocks fall,
    so a tree whose trunk is in the next chunk still hangs its leaves over
    this one (`M` is how far a canopy may reach: the jungle giants' is the
    widest).
*/

/** blocks a side of a chunk, and blocks tall */
export const CHUNK = 16
export const H = 96
/** the sea's surface: water fills up to and including this layer */
export const SEA = 34
/** caves at or under this layer are full of lava */
export const LAVA_Y = 9

export const Biome = {
  Plains: 0, Forest: 1, Desert: 2, SnowyPlains: 3, Windswept: 4, Beach: 5, Ocean: 6,
  FlowerForest: 7, BirchForest: 8, DarkForest: 9, Taiga: 10, SnowyTaiga: 11, IceSpikes: 12,
  Badlands: 13, Savanna: 14, Jungle: 15, Swamp: 16, Mushroom: 17, Cherry: 18, SnowyPeaks: 19,
  StonyShore: 20, River: 21, FrozenOcean: 22, FrozenRiver: 23,
} as const
export type Biome = (typeof Biome)[keyof typeof Biome]

/** each biome's name and its grass and foliage colours (the real ones,
    which mesher.ts turns into tints against the plains') */
export const BIOMES: Array<{ en: string; es: string; grass: string; foliage: string }> = []
const bio = (id: Biome, en: string, es: string, grass: string, foliage: string) => {
  BIOMES[id] = { en, es, grass, foliage }
}
bio(Biome.Plains, 'Plains', 'Llanura', '#91bd59', '#77ab2f')
bio(Biome.Forest, 'Forest', 'Bosque', '#79c05a', '#59ae30')
bio(Biome.Desert, 'Desert', 'Desierto', '#bfb755', '#aea42a')
bio(Biome.SnowyPlains, 'Snowy plains', 'Llanura nevada', '#80b497', '#60a17b')
bio(Biome.Windswept, 'Windswept hills', 'Colinas ventosas', '#8ab689', '#6da36b')
bio(Biome.Beach, 'Beach', 'Playa', '#91bd59', '#77ab2f')
bio(Biome.Ocean, 'Ocean', 'Océano', '#8eb971', '#71a74d')
bio(Biome.FlowerForest, 'Flower forest', 'Bosque florido', '#79c05a', '#59ae30')
bio(Biome.BirchForest, 'Birch forest', 'Bosque de abedules', '#88bb67', '#6ba941')
bio(Biome.DarkForest, 'Dark forest', 'Bosque oscuro', '#507a32', '#3f7a21')
bio(Biome.Taiga, 'Taiga', 'Taiga', '#86b783', '#68a464')
bio(Biome.SnowyTaiga, 'Snowy taiga', 'Taiga nevada', '#80b497', '#60a17b')
bio(Biome.IceSpikes, 'Ice spikes', 'Picos de hielo', '#80b497', '#60a17b')
bio(Biome.Badlands, 'Badlands', 'Tierras baldías', '#90814d', '#9e814d')
bio(Biome.Savanna, 'Savanna', 'Sabana', '#bfb755', '#aea42a')
bio(Biome.Jungle, 'Jungle', 'Jungla', '#59c93c', '#30bb0b')
bio(Biome.Swamp, 'Swamp', 'Pantano', '#6a7039', '#6a7039')
bio(Biome.Mushroom, 'Mushroom fields', 'Campos de hongos', '#55c93f', '#2bbb0f')
bio(Biome.Cherry, 'Cherry grove', 'Cerezal', '#b6db61', '#b6db61')
bio(Biome.SnowyPeaks, 'Snowy peaks', 'Picos nevados', '#80b497', '#60a17b')
bio(Biome.StonyShore, 'Stony shore', 'Costa rocosa', '#8ab689', '#6da36b')
bio(Biome.River, 'River', 'Río', '#91bd59', '#77ab2f')
bio(Biome.FrozenOcean, 'Frozen ocean', 'Océano helado', '#80b497', '#60a17b')
bio(Biome.FrozenRiver, 'Frozen river', 'Río helado', '#80b497', '#60a17b')

export interface ChunkData {
  cx: number
  cz: number
  /** block ids, x fastest, then z, then y: idx = x + z*16 + y*256 */
  vox: Uint8Array
  /** the biome of each column (x + z*16) */
  biome: Uint8Array
  /** each column's highest block that shuts out the sky (for the light) */
  top: Int16Array
}

export const idx = (x: number, y: number, z: number) => x + (z << 4) + (y << 8)

const S = 0x5eedb10c

/* ------------------------------------------------------------ fields -- */

export interface Column {
  h: number
  biome: Biome
}

/** stretch a 0..1 fbm (which huddles round 0.5) to use the whole range */
const spread = (v: number, k = 2.6) => Math.min(1, Math.max(0, (v - 0.5) * k + 0.5))

/** the surface height (the top solid block's y) and biome of a column */
export const columnAt = (bx: number, bz: number, out: Column = { h: 0, biome: Biome.Plains }): Column => {
  const cont = fbm(bx / 520, bz / 520, S + 1, 5)
  const hills = fbm(bx / 70, bz / 70, S + 2, 4)
  const ridge = ridged(bx / 230, bz / 230, S + 3, 4)
  const mtn = smoothstep(0.54, 0.7, fbm(bx / 800 + 40, bz / 800 - 13, S + 4, 3))
  // (scaled to the world: it is 1536 blocks across, and every biome has
  // to fit in it a few times over; the thresholds below are the fields'
  // measured quantiles over it)
  const temp = spread(fbm(bx / 330 + 91, bz / 330 - 57, S + 5, 3), 1.9)
  const wet = spread(fbm(bx / 270 - 33, bz / 270 + 71, S + 6, 3), 1.9)
  const weird = spread(fbm(bx / 170 + 7, bz / 170 + 13, S + 8, 2), 2)
  const land = (cont - 0.43) * 80
  // flatter near the coast, rolling inland
  const inland = smoothstep(-2, 10, land)
  const peaks = mtn * ridge * ridge * 70 * inland
  let h = SEA + 1 + land + (hills - 0.5) * (6 + 16 * inland) + peaks
  // the swamps lie low and flat, a hand either side of the water
  const swampy = wet > 0.72 && temp > 0.52 && temp < 0.8 && peaks < 6
  if (swampy && h > SEA - 2) h = SEA + (h - SEA) * 0.18
  // the badlands step up in terraces
  const bad = temp > 0.9 && wet < 0.5 && weird > 0.55 && h > SEA + 1
  if (bad) h = SEA + 3 + Math.round(((h - SEA) * 1.5 + hills * 12) / 4) * 4 - (hills > 0.55 ? 2 : 0)
  // rivers: a winding line across the land, cut below the sea
  const river = h > SEA - 2 && peaks < 20 ? vein(bx / 380, bz / 380, S + 9, 0.035) : 0
  if (river > 0) h = h + (SEA - 2 - h) * Math.min(1, river * 1.6)
  h = Math.round(Math.max(6, Math.min(H - 10, h)))
  const cold = temp < 0.4
  let biome: Biome
  if (river > 0.35 && h <= SEA) biome = cold ? Biome.FrozenRiver : Biome.River
  else if (h < SEA - 1) biome = cold ? Biome.FrozenOcean : Biome.Ocean
  else if (h <= SEA + 1 && !swampy) biome = peaks > 4 ? Biome.StonyShore : cold ? Biome.SnowyPlains : Biome.Beach
  else if (h > SEA + 38 && mtn > 0.3) biome = Biome.SnowyPeaks
  else if (h > SEA + 22 && mtn > 0.3) biome = weird > 0.6 && !cold ? Biome.Cherry : Biome.Windswept
  else if (bad) biome = Biome.Badlands
  else if (swampy) biome = Biome.Swamp
  else if (weird > 0.93 && land < 12 && !cold) biome = Biome.Mushroom
  else if (cold) biome = weird > 0.78 ? Biome.IceSpikes : wet > 0.45 ? Biome.SnowyTaiga : Biome.SnowyPlains
  else if (temp < 0.52) biome = wet > 0.4 ? Biome.Taiga : Biome.Plains
  else if (temp < 0.8) {
    if (wet < 0.3) biome = Biome.Plains
    else if (wet < 0.48) biome = weird > 0.62 ? Biome.FlowerForest : Biome.Forest
    else if (wet < 0.6) biome = weird < 0.45 ? Biome.BirchForest : Biome.Forest
    else biome = Biome.DarkForest
  } else if (temp < 0.92) biome = wet < 0.4 ? Biome.Savanna : wet > 0.55 ? Biome.Jungle : Biome.Plains
  else biome = wet < 0.5 ? Biome.Desert : Biome.Jungle
  out.h = h
  out.biome = biome
  return out
}

/** 3D value noise on a lattice of `cell` blocks, 0..1 */
const hash3 = (x: number, y: number, z: number, salt: number) =>
  hash2(x, Math.imul(y, 73856093) ^ z, salt) / 4294967296
const fade = (t: number) => t * t * (3 - 2 * t)
const noise3 = (x: number, y: number, z: number, salt: number) => {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const xf = fade(x - xi)
  const yf = fade(y - yi)
  const zf = fade(z - zi)
  const l = (dy: number, dz: number) => {
    const a = hash3(xi, yi + dy, zi + dz, salt)
    const b = hash3(xi + 1, yi + dy, zi + dz, salt)
    return a + (b - a) * xf
  }
  const y0 = l(0, 0) + (l(0, 1) - l(0, 0)) * zf
  const y1 = l(1, 0) + (l(1, 1) - l(1, 0)) * zf
  return y0 + (y1 - y0) * yf
}

/** the cave fields at a point of the four-block world lattice: two tunnel
    fields and a cavern field. Sampled on the lattice and interpolated, so
    a chunk pays for 150 samples rather than for every block */
const CL = 4
const caveSample = (lx: number, ly: number, lz: number, out: Float32Array, o: number) => {
  const x = (lx * CL) / 22
  const y = (ly * CL) / 13
  const z = (lz * CL) / 22
  out[o] = noise3(x, y, z, S + 11) * 0.7 + noise3(x * 2.1, y * 2.1, z * 2.1, S + 12) * 0.3
  out[o + 1] = noise3(x, y, z, S + 13) * 0.7 + noise3(x * 2.1, y * 2.1, z * 2.1, S + 14) * 0.3
  out[o + 2] = noise3((lx * CL) / 30, (ly * CL) / 16, (lz * CL) / 30, S + 15)
}
const carved = (a: number, b: number, c: number, by: number) => {
  if (by < 2) return false
  const w = 0.05 + (by < 24 ? 0.015 : 0)
  if (Math.abs(a - 0.5) < w && Math.abs(b - 0.5) < w) return true
  return by < 30 && c > 0.76
}
const one = new Float32Array(3 * 8)
/** is this block carved out by a cave (the same answer a chunk's own
    lattice gives, asked for one block: a tree checks its footing with it) */
export const caveAt = (bx: number, by: number, bz: number) => {
  const lx = Math.floor(bx / CL)
  const ly = Math.floor(by / CL)
  const lz = Math.floor(bz / CL)
  for (let k = 0; k < 8; k++) caveSample(lx + (k & 1), ly + ((k >> 1) & 1), lz + (k >> 2), one, k * 3)
  const fx = bx / CL - lx
  const fy = by / CL - ly
  const fz = bz / CL - lz
  const v = [0, 0, 0]
  for (let f = 0; f < 3; f++) {
    const c = (k: number) => one[k * 3 + f]
    const x00 = c(0) + (c(1) - c(0)) * fx
    const x10 = c(2) + (c(3) - c(2)) * fx
    const x01 = c(4) + (c(5) - c(4)) * fx
    const x11 = c(6) + (c(7) - c(6)) * fx
    const y0 = x00 + (x10 - x00) * fy
    const y1 = x01 + (x11 - x01) * fy
    v[f] = y0 + (y1 - y0) * fz
  }
  return carved(v[0], v[1], v[2], by)
}

/* ------------------------------------------------------------ chunks -- */

/** the margin of columns round a chunk whose trees may reach into it */
const M = 6
const W = CHUNK + M * 2
const col: Column = { h: 0, biome: Biome.Plains }
const heights = new Int16Array(W * W)
const biomes = new Uint8Array(W * W)
const caveLattice = new Float32Array(5 * 5 * 25 * 3)

/** the badlands' stripes, the same at every height everywhere */
const BANDS = [
  TERRACOTTA, TERRA_ORANGE, TERRACOTTA, TERRA_YELLOW, TERRA_YELLOW, TERRACOTTA, TERRA_WHITE, TERRACOTTA,
  TERRA_RED, TERRA_RED, TERRACOTTA, TERRA_BROWN, TERRACOTTA, TERRA_ORANGE, TERRA_WHITE, TERRACOTTA,
]

const COLD = new Set<number>([
  Biome.SnowyPlains, Biome.SnowyTaiga, Biome.IceSpikes, Biome.FrozenOcean, Biome.FrozenRiver, Biome.SnowyPeaks,
])

/** build a chunk's blocks from scratch. Edits are laid over it by the
    caller (world.ts), never stored here */
export const generateChunk = (cx: number, cz: number): ChunkData => {
  const vox = new Uint8Array(CHUNK * CHUNK * H)
  const biome = new Uint8Array(CHUNK * CHUNK)
  const top = new Int16Array(CHUNK * CHUNK)
  const x0 = cx * CHUNK
  const z0 = cz * CHUNK
  for (let j = 0; j < W; j++)
    for (let i = 0; i < W; i++) {
      columnAt(x0 + i - M, z0 + j - M, col)
      heights[i + j * W] = col.h
      biomes[i + j * W] = col.biome
    }
  const hAt = (lx: number, lz: number) => heights[lx + M + (lz + M) * W]

  /* the caves' lattice over this chunk: (16/4+1) across, only as high as
     the ground goes (nothing is carved out of the sky) */
  const LX = CHUNK / CL + 1
  let maxH = 0
  for (let k = 0; k < W * W; k++) maxH = Math.max(maxH, heights[k])
  const LY = Math.min(H / CL, Math.ceil((maxH + 1) / CL)) + 1
  const lat = caveLattice
  for (let ly = 0; ly < LY; ly++)
    for (let lz = 0; lz < LX; lz++)
      for (let lx = 0; lx < LX; lx++) caveSample(x0 / CL + lx, ly, z0 / CL + lz, lat, ((ly * LX + lz) * LX + lx) * 3)
  const caveHere = (x: number, y: number, z: number) => {
    const lx = x >> 2
    const ly = y >> 2
    const lz = z >> 2
    const fx = (x & 3) / CL
    const fy = (y & 3) / CL
    const fz = (z & 3) / CL
    const base = ((ly * LX + lz) * LX + lx) * 3
    const sz = LX * 3
    const sy = LX * LX * 3
    const v = (f: number) => {
      const a0 = lat[base + f] + (lat[base + 3 + f] - lat[base + f]) * fx
      const a1 = lat[base + sz + f] + (lat[base + sz + 3 + f] - lat[base + sz + f]) * fx
      const b0 = lat[base + sy + f] + (lat[base + sy + 3 + f] - lat[base + sy + f]) * fx
      const b1 = lat[base + sy + sz + f] + (lat[base + sy + sz + 3 + f] - lat[base + sy + sz + f]) * fx
      const y0 = a0 + (a1 - a0) * fz
      const y1 = b0 + (b1 - b0) * fz
      return y0 + (y1 - y0) * fy
    }
    if (y < 2) return false
    // the cheap way round: most blocks fail the first tunnel field
    if (y < 30 && v(2) > 0.76) return true
    const w = 0.05 + (y < 24 ? 0.015 : 0)
    return Math.abs(v(0) - 0.5) < w && Math.abs(v(1) - 0.5) < w
  }

  /* the columns */
  for (let z = 0; z < CHUNK; z++)
    for (let x = 0; x < CHUNK; x++) {
      const bx = x0 + x
      const bz = z0 + z
      const h = hAt(x, z)
      const b = biomes[x + M + (z + M) * W] as Biome
      biome[x + z * CHUNK] = b
      const r = hash2(bx, bz, S + 20)
      const roll = (r >>> 0) / 4294967296
      // the soil: what the top few blocks are, by biome
      let surf: number = GRASS
      let under: number = DIRT
      let depth = 3 + (r & 1)
      let deep = STONE
      let banded = false
      switch (b) {
        case Biome.Desert:
          surf = SAND
          under = SAND
          deep = SANDSTONE
          depth = 4
          break
        case Biome.Badlands:
          surf = RED_SAND
          under = RED_SAND
          depth = 1 + (r & 1)
          banded = true
          break
        case Biome.Beach:
          surf = SAND
          under = SAND
          break
        case Biome.StonyShore:
          surf = roll < 0.3 ? GRAVEL : STONE
          under = STONE
          break
        case Biome.Ocean:
        case Biome.FrozenOcean:
          surf = roll < 0.25 ? GRAVEL : roll < 0.6 ? SAND : roll < 0.7 ? CLAY : DIRT
          under = surf === DIRT ? DIRT : SAND
          break
        case Biome.River:
        case Biome.FrozenRiver:
          surf = roll < 0.2 ? GRAVEL : roll < 0.4 ? CLAY : SAND
          under = SAND
          break
        case Biome.SnowyPlains:
        case Biome.SnowyTaiga:
          surf = SNOWY_GRASS
          break
        case Biome.IceSpikes:
          surf = SNOW
          under = roll < 0.5 ? SNOW : DIRT
          break
        case Biome.Mushroom:
          surf = MYCELIUM
          break
        case Biome.Taiga:
          surf = roll < 0.22 ? PODZOL : GRASS
          break
        case Biome.DarkForest:
          surf = roll < 0.06 ? PODZOL : GRASS
          break
        case Biome.Windswept:
          surf = h > SEA + 30 + (r & 3) ? (roll < 0.15 ? GRAVEL : STONE) : GRASS
          under = surf === GRASS ? DIRT : STONE
          depth = surf === GRASS ? 2 : 1
          break
        case Biome.SnowyPeaks:
          surf = SNOW
          under = roll < 0.4 ? SNOW : STONE
          depth = 2
          break
      }
      // grass never grows under water
      if (h < SEA && (surf === GRASS || surf === SNOWY_GRASS || surf === MYCELIUM || surf === PODZOL)) {
        surf = b === Biome.Swamp ? (roll < 0.5 ? CLAY : DIRT) : DIRT
      }
      const dry = h > SEA + 1
      for (let y = 0; y <= h; y++) {
        let k: number
        if (y === 0 || (y < 4 && ((hash2(bx, bz, S + 21 + y) >>> 0) % 4) < 4 - y)) k = BEDROCK
        else if (y === h) k = surf
        else if (y > h - depth) k = under
        else if (banded && y > h - 16 && y > SEA - 4) k = BANDS[y & 15]
        else if (y > h - depth - 3 && deep === SANDSTONE) k = SANDSTONE
        else k = STONE
        // a cave below LAVA_Y is a lake of lava, the way the deep ones were
        if (k !== BEDROCK && (dry ? y <= h : y < h - 3) && caveHere(x, y, z)) k = y <= LAVA_Y ? LAVA : AIR
        vox[idx(x, y, z)] = k
      }
      // the sea, frozen over where it is cold
      for (let y = h + 1; y <= SEA; y++) vox[idx(x, y, z)] = y === SEA && COLD.has(b) ? ICE : WATER
    }

  /* the ore: blobs seeded by the chunk, clipped to it, only into stone */
  const rng = seededRng(hash2(cx, cz, S + 30))
  const blobs: Array<[number, number, number, number]> = [
    // block, count, deepest-top y, size
    [COAL, 16, 80, 8],
    [IRON, 10, 56, 6],
    [GOLD, 3, 30, 5],
    [DIAMOND, 2, 15, 4],
  ]
  for (const [ore, count, maxY, size] of blobs) {
    for (let k = 0; k < count; k++) {
      let x = Math.floor(rng() * CHUNK)
      let y = 2 + Math.floor(rng() * (maxY - 2))
      let z = Math.floor(rng() * CHUNK)
      for (let s = 0; s < size; s++) {
        if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK && y > 0 && y < H) {
          const i = idx(x, y, z)
          if (vox[i] === STONE) vox[i] = ore
        }
        const d = Math.floor(rng() * 6)
        if (d === 0) x++
        else if (d === 1) x--
        else if (d === 2) y++
        else if (d === 3) y--
        else if (d === 4) z++
        else z--
      }
    }
  }

  /* the trees, big mushrooms and ice spikes, from every column that could
     reach in, and the plants on this chunk's own */
  const put = (x: number, y: number, z: number, k: number, over = false) => {
    if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK || y < 0 || y >= H) return
    const i = idx(x, y, z)
    const was = vox[i]
    if (over || was === AIR || BLOCKS[was].cross) vox[i] = k
  }
  /** a round layer of leaves (corners maybe clipped by `seed`) */
  const layer = (x: number, y: number, z: number, r: number, k: number, seed: number, clip = true) => {
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const corner = Math.abs(dx) === r && Math.abs(dz) === r
        if (corner && r > 0 && (clip || ((hash2(seed + dx, seed ^ dz, S + 44 + y) & 1) === 0))) continue
        if (r >= 3 && dx * dx + dz * dz > r * r + 1) continue
        put(x + dx, y, z + dz, k)
      }
  }
  const trunk = (x: number, y0: number, n: number, z: number, k: number, wide = false) => {
    for (let y = y0; y < y0 + n; y++) {
      put(x, y, z, k, true)
      if (wide) {
        put(x + 1, y, z, k, true)
        put(x, y, z + 1, k, true)
        put(x + 1, y, z + 1, k, true)
      }
    }
  }
  const oak = (x: number, h: number, z: number, t: number, logB: number, leafB: number, tall: number, wide = false) => {
    for (let y = tall - 2; y <= tall + 1; y++) {
      const r = y >= tall ? 1 : wide ? 3 : 2
      layer(x, h + y, z, r, leafB, t + y, y === tall + 1)
    }
    trunk(x, h + 1, tall, z, logB)
  }
  const spruce = (x: number, h: number, z: number, tall: number, snowy: boolean) => {
    let r = 1
    for (let y = tall + 1; y >= 2; y--) {
      layer(x, h + y, z, y === tall + 1 ? 0 : r, SPRUCE_LEAVES, x * 7 + z, true)
      if (snowy && y === tall + 1) put(x, h + y + 1, z, SPRUCE_LEAVES)
      r = r === 1 ? 2 : 1
    }
    trunk(x, h + 1, tall, z, SPRUCE_LOG)
  }
  const darkOak = (x: number, h: number, z: number, t: number) => {
    const tall = 6 + (t % 3)
    for (let y = tall - 2; y <= tall + 1; y++) {
      const r = y === tall + 1 ? 2 : 3
      for (let dz = -r; dz <= r + 1; dz++)
        for (let dx = -r; dx <= r + 1; dx++) {
          if ((dx < -r + 1 || dx > r) && (dz < -r + 1 || dz > r)) continue
          put(x + dx, h + y, z + dz, DARK_LEAVES)
        }
    }
    trunk(x, h + 1, tall, z, DARK_LOG, true)
  }
  const jungle = (x: number, h: number, z: number, t: number) => {
    const giant = t % 11 === 0
    const tall = giant ? 16 + (t % 7) : 6 + (t % 6)
    if (giant) {
      for (let y = tall - 3; y <= tall + 1; y++) layer(x, h + y, z, y > tall ? 3 : 5 - Math.max(0, y - tall + 2), JUNGLE_LEAVES, t + y, false)
      // a couple of side branches with their own tufts
      for (const [dx, dz, at] of [[3, 0, tall - 7], [-2, 2, tall - 10]]) {
        put(x + Math.sign(dx), h + at, z + Math.sign(dz), JUNGLE_LOG, true)
        layer(x + dx, h + at + 1, z + dz, 2, JUNGLE_LEAVES, t + at, false)
      }
    } else {
      for (let y = tall - 2; y <= tall + 1; y++) layer(x, h + y, z, y >= tall ? 1 : 2, JUNGLE_LEAVES, t + y, false)
    }
    trunk(x, h + 1, tall, z, JUNGLE_LOG, giant)
  }
  const bush = (x: number, h: number, z: number, t: number) => {
    put(x, h + 1, z, JUNGLE_LOG, true)
    layer(x, h + 1, z, 2, JUNGLE_LEAVES, t, false)
    layer(x, h + 2, z, 1, JUNGLE_LEAVES, t + 1, false)
  }
  const acacia = (x: number, h: number, z: number, t: number) => {
    const up = 3 + (t % 2)
    const dx = t & 2 ? 1 : -1
    const dz = t & 4 ? 1 : -1
    trunk(x, h + 1, up, z, ACACIA_LOG)
    // the bend: two blocks out on the diagonal, then the flat crown
    put(x + dx, h + up + 1, z + dz, ACACIA_LOG, true)
    put(x + 2 * dx, h + up + 2, z + 2 * dz, ACACIA_LOG, true)
    const cx2 = x + 2 * dx
    const cz2 = z + 2 * dz
    const cy = h + up + 3
    layer(cx2, cy, cz2, 3, ACACIA_LEAVES, t, true)
    layer(cx2, cy + 1, cz2, 1, ACACIA_LEAVES, t + 1, false)
    put(cx2, cy, cz2, ACACIA_LOG, true)
  }
  const cherry = (x: number, h: number, z: number, t: number) => {
    const tall = 5 + (t % 2)
    trunk(x, h + 1, tall, z, CHERRY_LOG)
    for (let y = tall - 1; y <= tall + 2; y++) layer(x, h + y, z, y === tall + 2 ? 2 : 3, CHERRY_LEAVES, t + y, false)
  }
  const bigMushroom = (x: number, h: number, z: number, t: number) => {
    const tall = 4 + (t % 3)
    const red = t & 1
    if (red) {
      for (let y = tall - 2; y <= tall; y++) {
        const r = y === tall ? 1 : 2
        for (let dz = -r; dz <= r; dz++)
          for (let dx = -r; dx <= r; dx++) {
            if (y < tall && Math.abs(dx) < r && Math.abs(dz) < r) continue
            if (Math.abs(dx) === r && Math.abs(dz) === r) continue
            put(x + dx, h + y + 1, z + dz, RED_CAP)
          }
      }
      put(x, h + tall + 1, z, RED_CAP)
    } else {
      layer(x, h + tall + 1, z, 3, BROWN_CAP, t, true)
    }
    trunk(x, h + 1, tall, z, STEM)
  }
  const iceSpike = (x: number, h: number, z: number, t: number) => {
    const tall = 5 + (t % 12) + (t % 5 === 0 ? 12 : 0)
    for (let y = 1; y <= tall; y++) {
      const r = y < tall * 0.3 ? 1 : 0
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (!(r && Math.abs(dx) + Math.abs(dz) === 2)) put(x + dx, h + y, z + dz, PACKED_ICE, true)
    }
  }

  for (let j = 0; j < W; j++)
    for (let i = 0; i < W; i++) {
      const bx = x0 + i - M
      const bz = z0 + j - M
      const h = heights[i + j * W]
      const b = biomes[i + j * W] as Biome
      if (h <= SEA || h >= H - 26) continue
      const roll = (hash2(bx, bz, S + 40) >>> 0) / 4294967296
      const lx = i - M
      const lz = j - M
      const chance =
        b === Biome.Forest ? 0.05 : b === Biome.FlowerForest ? 0.025 : b === Biome.BirchForest ? 0.045
        : b === Biome.DarkForest ? 0.075 : b === Biome.Taiga ? 0.05 : b === Biome.SnowyTaiga ? 0.04
        : b === Biome.SnowyPlains ? 0.003 : b === Biome.IceSpikes ? 0.006 : b === Biome.Plains ? 0.005
        : b === Biome.Desert ? 0.007 : b === Biome.Badlands ? 0.003 : b === Biome.Savanna ? 0.008
        : b === Biome.Jungle ? 0.09 : b === Biome.Swamp ? 0.014 : b === Biome.Mushroom ? 0.009
        : b === Biome.Cherry ? 0.018 : b === Biome.Windswept ? 0.006 : 0
      if (roll < chance && !caveAt(bx, h, bz) && !caveAt(bx, h - 1, bz)) {
        const t = hash2(bx, bz, S + 41)
        switch (b) {
          case Biome.Desert:
          case Biome.Badlands:
            for (let k = 1; k <= 1 + (t % 3); k++) put(lx, h + k, lz, CACTUS)
            break
          case Biome.IceSpikes:
            iceSpike(lx, h, lz, t)
            break
          case Biome.Taiga:
          case Biome.SnowyTaiga:
          case Biome.SnowyPlains:
            spruce(lx, h, lz, 6 + (t % 4), b !== Biome.Taiga)
            break
          case Biome.Windswept:
            if (t & 1) spruce(lx, h, lz, 5 + (t % 3), false)
            else oak(lx, h, lz, t, LOG, LEAVES, 4 + (t % 2))
            break
          case Biome.BirchForest:
            oak(lx, h, lz, t, BIRCH_LOG, BIRCH_LEAVES, 5 + (t % 3) + (t % 5 === 0 ? 3 : 0))
            break
          case Biome.DarkForest:
            if (t % 23 === 0) bigMushroom(lx, h, lz, t)
            else darkOak(lx, h, lz, t)
            break
          case Biome.Jungle:
            if (t % 3 === 0) bush(lx, h, lz, t)
            else jungle(lx, h, lz, t)
            break
          case Biome.Savanna:
            acacia(lx, h, lz, t)
            break
          case Biome.Swamp:
            oak(lx, h, lz, t, LOG, LEAVES, 5 + (t % 2), true)
            break
          case Biome.Mushroom:
            bigMushroom(lx, h, lz, t)
            break
          case Biome.Cherry:
            cherry(lx, h, lz, t)
            break
          default:
            if ((b === Biome.Forest || b === Biome.FlowerForest) && (t & 3) === 0) oak(lx, h, lz, t, BIRCH_LOG, BIRCH_LEAVES, 5 + (t % 3))
            else oak(lx, h, lz, t, LOG, LEAVES, 4 + (t % 3))
        }
        // no grass under a trunk
        if (lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK) {
          const g = idx(lx, h, lz)
          if (vox[g] === GRASS || vox[g] === SNOWY_GRASS || vox[g] === MYCELIUM) vox[g] = DIRT
        }
        continue
      }
      if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) continue
      const g = vox[idx(lx, h, lz)]
      if (vox[idx(lx, h + 1, lz)] !== AIR) continue
      const p = (hash2(bx, bz, S + 43) >>> 0) / 4294967296
      // sugar cane on the water's edge, on sand, grass or dirt
      if (h <= SEA + 1 && (g === SAND || g === GRASS || g === DIRT) && !COLD.has(b)) {
        const wet = hAt(lx + 1, lz) < SEA || hAt(lx - 1, lz) < SEA || hAt(lx, lz + 1) < SEA || hAt(lx, lz - 1) < SEA
        if (wet && p < 0.22) {
          for (let k = 1; k <= 1 + (hash2(bx, bz, S + 45) % 3); k++) put(lx, h + k, lz, SUGAR_CANE)
          continue
        }
      }
      const flower = () => [POPPY, DANDELION, OXEYE, CORNFLOWER][hash2(bx, bz, S + 46) & 3]
      if (g === GRASS) {
        switch (b) {
          case Biome.Plains:
            if (p < 0.18) put(lx, h + 1, lz, TALL_GRASS)
            else if (p < 0.2) put(lx, h + 1, lz, flower())
            break
          case Biome.FlowerForest:
            if (p < 0.28) put(lx, h + 1, lz, flower())
            else if (p < 0.33) put(lx, h + 1, lz, TALL_GRASS)
            break
          case Biome.Forest:
          case Biome.BirchForest:
          case Biome.Windswept:
          case Biome.Cherry:
            if (p < 0.08) put(lx, h + 1, lz, TALL_GRASS)
            else if (p < 0.09) put(lx, h + 1, lz, flower())
            break
          case Biome.DarkForest:
            if (p < 0.04) put(lx, h + 1, lz, TALL_GRASS)
            else if (p < 0.06) put(lx, h + 1, lz, p < 0.05 ? RED_MUSHROOM : BROWN_MUSHROOM)
            break
          case Biome.Taiga:
            if (p < 0.12) put(lx, h + 1, lz, FERN)
            else if (p < 0.16) put(lx, h + 1, lz, TALL_GRASS)
            else if (p < 0.165) put(lx, h + 1, lz, BROWN_MUSHROOM)
            break
          case Biome.Jungle:
            if (p < 0.2) put(lx, h + 1, lz, FERN)
            else if (p < 0.42) put(lx, h + 1, lz, TALL_GRASS)
            break
          case Biome.Savanna:
            if (p < 0.3) put(lx, h + 1, lz, TALL_GRASS)
            break
          case Biome.Swamp:
            if (p < 0.03) put(lx, h + 1, lz, BLUE_ORCHID)
            else if (p < 0.09) put(lx, h + 1, lz, TALL_GRASS)
            else if (p < 0.1) put(lx, h + 1, lz, BROWN_MUSHROOM)
            break
        }
      } else if (g === SNOWY_GRASS && b === Biome.SnowyTaiga && p < 0.04) put(lx, h + 1, lz, FERN)
      else if (g === MYCELIUM && p < 0.035) put(lx, h + 1, lz, p < 0.017 ? RED_MUSHROOM : BROWN_MUSHROOM)
      else if (g === PODZOL && p < 0.1) put(lx, h + 1, lz, FERN)
      else if ((g === SAND || g === RED_SAND) && (b === Biome.Desert || b === Biome.Badlands) && p < 0.008) put(lx, h + 1, lz, DEAD_BUSH)
    }

  for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) top[x + z * CHUNK] = scanTop(vox, x, z)
  return { cx, cz, vox, biome, top }
}

/** does a block shut out the sky: anything that hides its neighbour (so
    glass, leaves and water let the light down to what is under them) */
export const SKY_BLOCKING = new Uint8Array(256)
for (const b of BLOCKS) SKY_BLOCKING[b.id] = b.opaque ? 1 : 0

export const scanTop = (vox: Uint8Array, x: number, z: number) => {
  for (let y = H - 1; y >= 0; y--) if (SKY_BLOCKING[vox[idx(x, y, z)]]) return y
  return -1
}

const seededRng = (seed: number) => {
  let s = seed | 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
