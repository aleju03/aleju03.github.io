import { cell, model } from './art'
import { batchable } from './batch'
import { CATALOGUE, CATEGORIES } from './catalogue'
import { registerKind, type Surface } from './kinds'
import type { StepSurface } from '../core/sfx'

/*
  The blocks: every kind of cube Cubeland (levels/cubeland/) is built from,
  as one table the voxel world, the catalogue and the props all read.

  A block is a number in a chunk's byte array, and this is what the number
  means: what its six faces are painted with, whether it is solid to a walker
  and a prop, whether it hides the face of whatever is next to it (a leaf
  and a pane of glass do not), whether it is drawn as two crossed cards (the
  flowers and the tall grass), how hard it is for a blast to take, and what
  it sounds like underfoot and when it lands. Air is 0 and water is the one
  liquid.

  The faces are 16 by 16 pixel paintings, drawn here by small painters into
  plain RGBA buffers (`paintTexture`), so they need no canvas and paint the
  same in Node as in a browser. They are drawn twice from the same buffers:
  the voxel world stacks them into one array texture for its terrain
  material (cubeland/material.ts), and this module declares each one as a
  cell of the props' atlas (art.ts), which is how a block knocked loose by a
  rocket or pulled out by the physgun is an ordinary prop on the one prop
  material, instanced like a crate, with no new program anywhere. On the
  atlas a see-through pixel is painted solid (a leaf's gaps in its own dark
  green, glass's in a pale blue), because the prop material has no alpha
  test and a loose block is a cube whatever its pattern.

  Each catalogued block is a prop kind (`block_<key>`) in the catalogue's
  Blocks tab: spawned anywhere it is a cube that falls and stacks, and in
  Cubeland picking one puts it in your hand to build with instead. Imported
  by sandbox.ts after the catalogue, so the cells are declared before the
  atlas is packed.
*/

/** world units per block: the walker's eye (3.84) is just under two of
    them, as a player's is in the game this is a love letter to */
export const B = 2

export type Tint = 'grass' | 'foliage' | 'none'

export interface BlockDef {
  id: number
  key: string
  name: { en: string; es: string }
  /** texture names for the top, the four sides and the bottom */
  top: string
  side: string
  bottom: string
  /** blocks a walker and a prop */
  solid: boolean
  /** hides the faces of the blocks against it */
  opaque: boolean
  /** drawn as two crossed cards, not a cube */
  cross?: boolean
  liquid?: boolean
  /** glows (the terrain's emissive, in the look's HDR) */
  glow?: number
  /** tinted by the biome it grows in: the grass tops, the leaves */
  tint?: Tint
  /** what a blast has to get through: 0 goes to any blast, 1 to a close
      one, Infinity to nothing */
  hardness: number
  step: StepSurface
  sound: Surface
  /** a loose one's mass, kg: game numbers, not a cubic metre of rock, so a
      rocket still throws stone */
  mass: number
  /** relative to water */
  density: number
  /** in the catalogue's Blocks tab */
  catalogue: boolean
  /** goes off rather than breaks (the TNT) */
  explosive?: boolean
}

type Def = Omit<BlockDef, 'id' | 'key' | 'top' | 'side' | 'bottom' | 'catalogue'> & {
  tex: string | { top: string; side: string; bottom?: string }
  catalogue?: boolean
}

export const BLOCKS: BlockDef[] = []
export const BLOCK_BY_KEY = new Map<string, BlockDef>()

const add = (key: string, d: Def) => {
  const { tex, catalogue = true, ...rest } = d
  const t = typeof tex === 'string' ? { top: tex, side: tex, bottom: tex } : { bottom: tex.top, ...tex }
  const def: BlockDef = { ...rest, id: BLOCKS.length, key, top: t.top, side: t.side, bottom: t.bottom ?? t.top, catalogue }
  BLOCKS.push(def)
  BLOCK_BY_KEY.set(key, def)
  return def.id
}

const earth = { solid: true, opaque: true, step: 'stone' as StepSurface, sound: 'concrete' as Surface, density: 2 }
const wood = { solid: true, opaque: true, step: 'wood' as StepSurface, sound: 'wood' as Surface, density: 0.6, hardness: 0.35, mass: 30 }
const leaf = { solid: true, opaque: false, tint: 'foliage' as Tint, step: 'grass' as StepSurface, sound: 'soft' as Surface, density: 0.3, hardness: 0, mass: 5 }
const wool = { solid: true, opaque: true, step: 'carpet' as StepSurface, sound: 'soft' as Surface, density: 0.4, hardness: 0.1, mass: 10 }
const plant = { solid: false, opaque: false, cross: true, step: 'grass' as StepSurface, sound: 'soft' as Surface, density: 0.3, hardness: 0, mass: 1, catalogue: false }

/* The ids are what a chunk stores and what travels on the wire, so they are
   append-only: a new block goes at the end */
export const AIR = add('air', { name: { en: 'Air', es: 'Aire' }, tex: 'stone', solid: false, opaque: false, hardness: 0, step: 'stone', sound: 'soft', mass: 0, density: 0, catalogue: false })
export const STONE = add('stone', { ...earth, name: { en: 'Stone', es: 'Piedra' }, tex: 'stone', hardness: 0.6, mass: 90 })
export const GRASS = add('grass', { ...earth, name: { en: 'Grass block', es: 'Bloque de césped' }, tex: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, tint: 'grass', step: 'grass', sound: 'soft', hardness: 0.25, mass: 60 })
export const DIRT = add('dirt', { ...earth, name: { en: 'Dirt', es: 'Tierra' }, tex: 'dirt', step: 'grass', sound: 'soft', hardness: 0.25, mass: 60 })
export const COBBLE = add('cobblestone', { ...earth, name: { en: 'Cobblestone', es: 'Adoquín' }, tex: 'cobblestone', hardness: 0.6, mass: 90 })
export const PLANKS = add('planks', { ...wood, name: { en: 'Oak planks', es: 'Tablones de roble' }, tex: 'planks' })
export const LOG = add('log', { ...wood, name: { en: 'Oak log', es: 'Tronco de roble' }, tex: { top: 'log_top', side: 'log_side' }, hardness: 0.4, mass: 40 })
export const LEAVES = add('leaves', { ...leaf, name: { en: 'Oak leaves', es: 'Hojas de roble' }, tex: 'leaves' })
export const SAND = add('sand', { ...earth, name: { en: 'Sand', es: 'Arena' }, tex: 'sand', step: 'sand', sound: 'soft', hardness: 0.2, mass: 60 })
export const GRAVEL = add('gravel', { ...earth, name: { en: 'Gravel', es: 'Grava' }, tex: 'gravel', step: 'sand', hardness: 0.25, mass: 70 })
export const WATER = add('water', { name: { en: 'Water', es: 'Agua' }, tex: 'water', solid: false, opaque: false, liquid: true, hardness: Infinity, step: 'water', sound: 'soft', mass: 0, density: 1, catalogue: false })
export const BEDROCK = add('bedrock', { ...earth, name: { en: 'Bedrock', es: 'Roca madre' }, tex: 'bedrock', hardness: Infinity, mass: 300, catalogue: false })
export const COAL = add('coal_ore', { ...earth, name: { en: 'Coal ore', es: 'Mena de carbón' }, tex: 'coal_ore', hardness: 0.6, mass: 90 })
export const IRON = add('iron_ore', { ...earth, name: { en: 'Iron ore', es: 'Mena de hierro' }, tex: 'iron_ore', hardness: 0.65, mass: 110 })
export const GOLD = add('gold_ore', { ...earth, name: { en: 'Gold ore', es: 'Mena de oro' }, tex: 'gold_ore', hardness: 0.65, mass: 120 })
export const DIAMOND = add('diamond_ore', { ...earth, name: { en: 'Diamond ore', es: 'Mena de diamante' }, tex: 'diamond_ore', hardness: 0.7, mass: 110 })
export const GLASS = add('glass', { name: { en: 'Glass', es: 'Vidrio' }, tex: 'glass', solid: true, opaque: false, hardness: 0, step: 'stone', sound: 'glass', mass: 20, density: 2 })
export const BRICKS = add('bricks', { ...earth, name: { en: 'Bricks', es: 'Ladrillos' }, tex: 'bricks', hardness: 0.6, mass: 80 })
export const SNOWY_GRASS = add('snowy_grass', { ...earth, name: { en: 'Snowy grass', es: 'Césped nevado' }, tex: { top: 'snow', side: 'snow_side', bottom: 'dirt' }, step: 'snow', sound: 'soft', hardness: 0.25, mass: 60 })
export const SNOW = add('snow', { ...earth, name: { en: 'Snow', es: 'Nieve' }, tex: 'snow', step: 'snow', sound: 'soft', hardness: 0.1, mass: 20, density: 0.5 })
export const ICE = add('ice', { ...earth, name: { en: 'Ice', es: 'Hielo' }, tex: 'ice', step: 'stone', sound: 'glass', hardness: 0.2, mass: 40, density: 0.9 })
export const SANDSTONE = add('sandstone', { ...earth, name: { en: 'Sandstone', es: 'Arenisca' }, tex: { top: 'sandstone_top', side: 'sandstone_side' }, step: 'sand', hardness: 0.45, mass: 80 })
export const BIRCH_LOG = add('birch_log', { ...wood, name: { en: 'Birch log', es: 'Tronco de abedul' }, tex: { top: 'birch_top', side: 'birch_side' }, hardness: 0.4, mass: 40 })
export const BIRCH_LEAVES = add('birch_leaves', { ...leaf, name: { en: 'Birch leaves', es: 'Hojas de abedul' }, tex: 'birch_leaves', tint: 'none' })
export const SPRUCE_LOG = add('spruce_log', { ...wood, name: { en: 'Spruce log', es: 'Tronco de abeto' }, tex: { top: 'spruce_top', side: 'spruce_side' }, hardness: 0.4, mass: 40 })
export const SPRUCE_LEAVES = add('spruce_leaves', { ...leaf, name: { en: 'Spruce leaves', es: 'Hojas de abeto' }, tex: 'spruce_leaves', tint: 'none' })
export const CACTUS = add('cactus', { name: { en: 'Cactus', es: 'Cactus' }, tex: { top: 'cactus_top', side: 'cactus_side' }, solid: true, opaque: true, hardness: 0, step: 'grass', sound: 'soft', mass: 15, density: 0.8 })
export const TNT = add('tnt', { name: { en: 'TNT', es: 'TNT' }, tex: { top: 'tnt_top', side: 'tnt_side', bottom: 'tnt_bottom' }, solid: true, opaque: true, hardness: 0, step: 'grass', sound: 'wood', mass: 25, density: 0.8, explosive: true })
export const GLOWSTONE = add('glowstone', { ...earth, name: { en: 'Glowstone', es: 'Piedra luminosa' }, tex: 'glowstone', glow: 1.6, sound: 'glass', hardness: 0.1, mass: 40 })
export const OBSIDIAN = add('obsidian', { ...earth, name: { en: 'Obsidian', es: 'Obsidiana' }, tex: 'obsidian', hardness: Infinity, mass: 200, density: 2.4 })
export const STONE_BRICKS = add('stone_bricks', { ...earth, name: { en: 'Stone bricks', es: 'Ladrillos de piedra' }, tex: 'stone_bricks', hardness: 0.65, mass: 90 })
export const MOSSY = add('mossy_cobblestone', { ...earth, name: { en: 'Mossy cobblestone', es: 'Adoquín musgoso' }, tex: 'mossy_cobblestone', hardness: 0.6, mass: 90 })
export const BOOKSHELF = add('bookshelf', { ...wood, name: { en: 'Bookshelf', es: 'Librero' }, tex: { top: 'planks', side: 'bookshelf' } })
export const PUMPKIN = add('pumpkin', { ...wood, name: { en: 'Pumpkin', es: 'Calabaza' }, tex: { top: 'pumpkin_top', side: 'pumpkin_side' }, sound: 'melon', step: 'grass', hardness: 0.1, mass: 20, density: 0.7 })
const WOOLS: Array<[string, string, string, string]> = [
  ['white', 'White wool', 'Lana blanca', '#e6e6e0'],
  ['red', 'Red wool', 'Lana roja', '#a8322c'],
  ['orange', 'Orange wool', 'Lana naranja', '#dc7a2c'],
  ['yellow', 'Yellow wool', 'Lana amarilla', '#e3c43a'],
  ['lime', 'Lime wool', 'Lana lima', '#78b930'],
  ['green', 'Green wool', 'Lana verde', '#4a6a24'],
  ['cyan', 'Cyan wool', 'Lana cian', '#2a8a93'],
  ['blue', 'Blue wool', 'Lana azul', '#3a4aa0'],
  ['purple', 'Purple wool', 'Lana morada', '#7c3aa8'],
  ['black', 'Black wool', 'Lana negra', '#242228'],
]
export const WOOL0 = BLOCKS.length
for (const [k, en, es] of WOOLS) add(`wool_${k}`, { ...wool, name: { en, es }, tex: `wool_${k}` })
export const TALL_GRASS = add('tall_grass', { ...plant, name: { en: 'Tall grass', es: 'Hierba alta' }, tex: 'tall_grass', tint: 'grass' })
export const POPPY = add('poppy', { ...plant, name: { en: 'Poppy', es: 'Amapola' }, tex: 'poppy' })
export const DANDELION = add('dandelion', { ...plant, name: { en: 'Dandelion', es: 'Diente de león' }, tex: 'dandelion' })
export const DEAD_BUSH = add('dead_bush', { ...plant, name: { en: 'Dead bush', es: 'Arbusto seco' }, tex: 'dead_bush', step: 'sand' })
export const SPRUCE_PLANKS = add('spruce_planks', { ...wood, name: { en: 'Spruce planks', es: 'Tablones de abeto' }, tex: 'spruce_planks' })
export const BIRCH_PLANKS = add('birch_planks', { ...wood, name: { en: 'Birch planks', es: 'Tablones de abedul' }, tex: 'birch_planks' })
/* the biomes' own woods, grounds and plants */
export const JUNGLE_LOG = add('jungle_log', { ...wood, name: { en: 'Jungle log', es: 'Tronco de jungla' }, tex: { top: 'jungle_top', side: 'jungle_side' }, hardness: 0.4, mass: 40 })
export const JUNGLE_LEAVES = add('jungle_leaves', { ...leaf, name: { en: 'Jungle leaves', es: 'Hojas de jungla' }, tex: 'jungle_leaves' })
export const ACACIA_LOG = add('acacia_log', { ...wood, name: { en: 'Acacia log', es: 'Tronco de acacia' }, tex: { top: 'acacia_top', side: 'acacia_side' }, hardness: 0.4, mass: 40 })
export const ACACIA_LEAVES = add('acacia_leaves', { ...leaf, name: { en: 'Acacia leaves', es: 'Hojas de acacia' }, tex: 'acacia_leaves' })
export const DARK_LOG = add('dark_oak_log', { ...wood, name: { en: 'Dark oak log', es: 'Tronco de roble oscuro' }, tex: { top: 'dark_top', side: 'dark_side' }, hardness: 0.4, mass: 40 })
export const DARK_LEAVES = add('dark_oak_leaves', { ...leaf, name: { en: 'Dark oak leaves', es: 'Hojas de roble oscuro' }, tex: 'dark_leaves' })
export const CHERRY_LOG = add('cherry_log', { ...wood, name: { en: 'Cherry log', es: 'Tronco de cerezo' }, tex: { top: 'cherry_top', side: 'cherry_side' }, hardness: 0.4, mass: 40 })
export const CHERRY_LEAVES = add('cherry_leaves', { ...leaf, name: { en: 'Cherry leaves', es: 'Hojas de cerezo' }, tex: 'cherry_leaves', tint: 'none' })
export const MYCELIUM = add('mycelium', { ...earth, name: { en: 'Mycelium', es: 'Micelio' }, tex: { top: 'mycelium_top', side: 'mycelium_side', bottom: 'dirt' }, step: 'grass', sound: 'soft', hardness: 0.25, mass: 60 })
export const RED_CAP = add('red_mushroom_block', { ...wood, name: { en: 'Red mushroom block', es: 'Bloque de champiñón rojo' }, tex: 'red_cap', sound: 'soft', step: 'carpet', hardness: 0.1, mass: 15 })
export const BROWN_CAP = add('brown_mushroom_block', { ...wood, name: { en: 'Brown mushroom block', es: 'Bloque de champiñón marrón' }, tex: 'brown_cap', sound: 'soft', step: 'carpet', hardness: 0.1, mass: 15 })
export const STEM = add('mushroom_stem', { ...wood, name: { en: 'Mushroom stem', es: 'Tallo de champiñón' }, tex: 'stem', sound: 'soft', step: 'carpet', hardness: 0.1, mass: 15 })
export const RED_SAND = add('red_sand', { ...earth, name: { en: 'Red sand', es: 'Arena roja' }, tex: 'red_sand', step: 'sand', sound: 'soft', hardness: 0.2, mass: 60 })
export const TERRACOTTA = add('terracotta', { ...earth, name: { en: 'Terracotta', es: 'Terracota' }, tex: 'terracotta', hardness: 0.5, mass: 80 })
export const TERRA_ORANGE = add('terracotta_orange', { ...earth, name: { en: 'Orange terracotta', es: 'Terracota naranja' }, tex: 'terracotta_orange', hardness: 0.5, mass: 80 })
export const TERRA_YELLOW = add('terracotta_yellow', { ...earth, name: { en: 'Yellow terracotta', es: 'Terracota amarilla' }, tex: 'terracotta_yellow', hardness: 0.5, mass: 80 })
export const TERRA_WHITE = add('terracotta_white', { ...earth, name: { en: 'White terracotta', es: 'Terracota blanca' }, tex: 'terracotta_white', hardness: 0.5, mass: 80 })
export const TERRA_RED = add('terracotta_red', { ...earth, name: { en: 'Red terracotta', es: 'Terracota roja' }, tex: 'terracotta_red', hardness: 0.5, mass: 80 })
export const TERRA_BROWN = add('terracotta_brown', { ...earth, name: { en: 'Brown terracotta', es: 'Terracota marrón' }, tex: 'terracotta_brown', hardness: 0.5, mass: 80 })
export const PACKED_ICE = add('packed_ice', { ...earth, name: { en: 'Packed ice', es: 'Hielo compacto' }, tex: 'packed_ice', step: 'stone', sound: 'glass', hardness: 0.3, mass: 60, density: 0.9 })
export const PODZOL = add('podzol', { ...earth, name: { en: 'Podzol', es: 'Podsol' }, tex: { top: 'podzol_top', side: 'podzol_side', bottom: 'dirt' }, step: 'grass', sound: 'soft', hardness: 0.25, mass: 60 })
export const CLAY = add('clay', { ...earth, name: { en: 'Clay', es: 'Arcilla' }, tex: 'clay', step: 'sand', sound: 'soft', hardness: 0.25, mass: 60 })
export const FERN = add('fern', { ...plant, name: { en: 'Fern', es: 'Helecho' }, tex: 'fern', tint: 'grass' })
export const RED_MUSHROOM = add('red_mushroom', { ...plant, name: { en: 'Red mushroom', es: 'Champiñón rojo' }, tex: 'red_mushroom' })
export const BROWN_MUSHROOM = add('brown_mushroom', { ...plant, name: { en: 'Brown mushroom', es: 'Champiñón marrón' }, tex: 'brown_mushroom' })
export const BLUE_ORCHID = add('blue_orchid', { ...plant, name: { en: 'Blue orchid', es: 'Orquídea azul' }, tex: 'blue_orchid' })
export const SUGAR_CANE = add('sugar_cane', { ...plant, name: { en: 'Sugar cane', es: 'Caña de azúcar' }, tex: 'sugar_cane' })
export const CORNFLOWER = add('cornflower', { ...plant, name: { en: 'Cornflower', es: 'Aciano' }, tex: 'cornflower' })
export const OXEYE = add('oxeye_daisy', { ...plant, name: { en: 'Oxeye daisy', es: 'Margarita' }, tex: 'oxeye' })
export const ACACIA_PLANKS = add('acacia_planks', { ...wood, name: { en: 'Acacia planks', es: 'Tablones de acacia' }, tex: 'acacia_planks' })
export const JUNGLE_PLANKS = add('jungle_planks', { ...wood, name: { en: 'Jungle planks', es: 'Tablones de jungla' }, tex: 'jungle_planks' })
export const DARK_PLANKS = add('dark_oak_planks', { ...wood, name: { en: 'Dark oak planks', es: 'Tablones de roble oscuro' }, tex: 'dark_planks' })
export const CHERRY_PLANKS = add('cherry_planks', { ...wood, name: { en: 'Cherry planks', es: 'Tablones de cerezo' }, tex: 'cherry_planks' })

export const blockKind = (b: BlockDef) => `block_${b.key}`
/** the block a prop kind is, if it is one */
export const blockOfKind = (kind: string): BlockDef | undefined =>
  kind.startsWith('block_') ? BLOCK_BY_KEY.get(kind.slice(6)) : undefined

/* ------------------------------------------------------------ painting -- */

export const TEX_SIZE = 16

/** a 16x16 RGBA buffer and the brushes the painters use on it */
interface Px {
  data: Uint8ClampedArray
  rnd: () => number
  set: (x: number, y: number, c: number, a?: number) => void
  get: (x: number, y: number) => number
  /** every pixel from a list of colours, weighted toward the first */
  noise: (cols: number[], weights?: number[]) => void
  speck: (c: number, share: number) => void
  rect: (x: number, y: number, w: number, h: number, c: number) => void
  clear: () => void
  /** scale a pixel's colour, multiplicatively */
  shade: (x: number, y: number, k: number) => void
}

const hex = (s: string) => parseInt(s.slice(1), 16)
const scaleC = (c: number, k: number) => {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k))
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k))
  const b = Math.min(255, Math.round((c & 255) * k))
  return (r << 16) | (g << 8) | b
}

const makePx = (seed: number): Px => {
  const data = new Uint8ClampedArray(TEX_SIZE * TEX_SIZE * 4)
  let s = seed >>> 0 || 1
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const set = (x: number, y: number, c: number, a = 255) => {
    if (x < 0 || y < 0 || x >= TEX_SIZE || y >= TEX_SIZE) return
    const i = (y * TEX_SIZE + x) * 4
    data[i] = (c >> 16) & 255
    data[i + 1] = (c >> 8) & 255
    data[i + 2] = c & 255
    data[i + 3] = a
  }
  const get = (x: number, y: number) => {
    const i = (((y + TEX_SIZE) % TEX_SIZE) * TEX_SIZE + ((x + TEX_SIZE) % TEX_SIZE)) * 4
    return (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
  }
  const px: Px = {
    data,
    rnd,
    set,
    get,
    noise: (cols, weights) => {
      const w = weights ?? cols.map((_, i) => (i === 0 ? 3 : 1))
      const total = w.reduce((a, b) => a + b, 0)
      for (let y = 0; y < TEX_SIZE; y++)
        for (let x = 0; x < TEX_SIZE; x++) {
          let r = rnd() * total
          let k = 0
          while (k < cols.length - 1 && r >= w[k]) r -= w[k++]
          set(x, y, cols[k])
        }
    },
    speck: (c, share) => {
      const n = Math.round(TEX_SIZE * TEX_SIZE * share)
      for (let i = 0; i < n; i++) set(Math.floor(rnd() * TEX_SIZE), Math.floor(rnd() * TEX_SIZE), c)
    },
    rect: (x, y, w, h, c) => {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c)
    },
    clear: () => data.fill(0),
    shade: (x, y, k) => {
      const i = (y * TEX_SIZE + x) * 4
      if (data[i + 3] === 0) return
      set(x, y, scaleC(get(x, y), k), data[i + 3])
    },
  }
  return px
}

const C = {
  stone: [0x7f7f7f, 0x757575, 0x8a8a8a, 0x6c6c6c],
  dirt: [0x866043, 0x79553a, 0x94694a, 0x6b4a31],
  grass: [0x6a9e3c, 0x5f9234, 0x77aa45, 0x568a2e],
  sand: [0xdcd39f, 0xd2c892, 0xe4dcab, 0xc9be88],
}

/** a cobble-like pattern: lumps with dark seams between them */
const lumps = (p: Px, cols: number[], seam: number, seeds = 9) => {
  const pts = Array.from({ length: seeds }, () => [p.rnd() * TEX_SIZE, p.rnd() * TEX_SIZE, Math.floor(p.rnd() * cols.length)])
  const owner = (x: number, y: number) => {
    let best = Infinity
    let second = Infinity
    let who = 0
    pts.forEach(([sx, sy], i) => {
      // wrapped, so the pattern tiles
      const dx = Math.min(Math.abs(x - sx), TEX_SIZE - Math.abs(x - sx))
      const dy = Math.min(Math.abs(y - sy), TEX_SIZE - Math.abs(y - sy))
      const d = dx * dx + dy * dy
      if (d < best) {
        second = best
        best = d
        who = i
      } else if (d < second) second = d
    })
    return { who, edge: Math.sqrt(second) - Math.sqrt(best) }
  }
  for (let y = 0; y < TEX_SIZE; y++)
    for (let x = 0; x < TEX_SIZE; x++) {
      const o = owner(x + 0.5, y + 0.5)
      if (o.edge < 1.1) p.set(x, y, seam)
      else {
        const base = cols[pts[o.who][2]]
        p.set(x, y, scaleC(base, 0.92 + p.rnd() * 0.16 + (o.edge > 3 ? 0.06 : 0)))
      }
    }
}

const ore = (p: Px, spot: number[], blobs = 5) => {
  PAINTERS.stone(p)
  for (let k = 0; k < blobs; k++) {
    const cx = 2 + Math.floor(p.rnd() * 12)
    const cy = 2 + Math.floor(p.rnd() * 12)
    const n = 2 + Math.floor(p.rnd() * 3)
    for (let i = 0; i < n; i++) {
      const x = cx + Math.floor(p.rnd() * 3) - 1
      const y = cy + Math.floor(p.rnd() * 3) - 1
      p.set(x, y, spot[i % spot.length])
      p.set(x + 1, y, spot[(i + 1) % spot.length])
    }
  }
}

/** a side of dirt with a band of `top` colours over it, ragged underneath */
const toppedSide = (p: Px, top: number[], depth: number) => {
  PAINTERS.dirt(p)
  for (let x = 0; x < TEX_SIZE; x++) {
    const d = depth + (p.rnd() < 0.5 ? 1 : 0) + (p.rnd() < 0.2 ? 1 : 0)
    for (let y = 0; y < d; y++) p.set(x, y, top[Math.floor(p.rnd() * top.length)])
  }
}

const planks = (p: Px, base: number[], seam: number) => {
  p.noise(base)
  for (let y = 0; y < TEX_SIZE; y += 4) {
    for (let x = 0; x < TEX_SIZE; x++) p.set(x, y + 3, seam)
    const cut = (y * 5 + 3) % TEX_SIZE
    for (let j = 0; j < 3; j++) p.set(cut, y + j, seam)
    // the grain: a darker run along each board
    const gy = y + 1 + Math.floor(p.rnd() * 2)
    for (let x = 0; x < TEX_SIZE; x++) if (p.rnd() < 0.35) p.shade(x, gy, 0.9)
  }
}

const bark = (p: Px, cols: number[], dark: number) => {
  for (let x = 0; x < TEX_SIZE; x++) {
    const col = cols[Math.floor(p.rnd() * cols.length)]
    for (let y = 0; y < TEX_SIZE; y++) p.set(x, y, p.rnd() < 0.18 ? scaleC(col, 0.9) : col)
  }
  for (let k = 0; k < 7; k++) {
    const x = Math.floor(p.rnd() * TEX_SIZE)
    const y0 = Math.floor(p.rnd() * TEX_SIZE)
    const len = 3 + Math.floor(p.rnd() * 6)
    for (let y = 0; y < len; y++) p.set(x, (y0 + y) % TEX_SIZE, dark)
  }
}

const rings = (p: Px, barkCol: number, a: number, b: number) => {
  for (let y = 0; y < TEX_SIZE; y++)
    for (let x = 0; x < TEX_SIZE; x++) {
      const dx = x - 7.5
      const dy = y - 7.5
      const r = Math.max(Math.abs(dx), Math.abs(dy))
      if (r > 6.6) p.set(x, y, scaleC(barkCol, 0.9 + p.rnd() * 0.2))
      else p.set(x, y, Math.floor(r) % 2 ? a : b)
    }
}

/** foliage with holes in it (alpha 0), dark underneath and lit on top */
const foliage = (p: Px, cols: number[], holes: number) => {
  p.noise(cols)
  for (let y = 0; y < TEX_SIZE; y++)
    for (let x = 0; x < TEX_SIZE; x++) if (p.rnd() < holes) p.set(x, y, 0, 0)
}

const wools: Record<string, (p: Px) => void> = {}
for (const [k, , , col] of WOOLS) {
  const c = hex(col)
  wools[`wool_${k}`] = (p) => {
    p.noise([c, scaleC(c, 0.92), scaleC(c, 1.06)], [5, 2, 2])
    // the knit: a faint diagonal
    for (let y = 0; y < TEX_SIZE; y++) for (let x = 0; x < TEX_SIZE; x++) if ((x + y * 3) % 7 === 0) p.shade(x, y, 0.9)
  }
}

const PAINTERS: Record<string, (p: Px) => void> = {
  stone: (p) => {
    p.noise(C.stone, [6, 3, 3, 1])
    for (let k = 0; k < 5; k++) {
      const x = Math.floor(p.rnd() * 14)
      const y = Math.floor(p.rnd() * 16)
      p.set(x, y, 0x656565)
      p.set(x + 1, y, 0x6a6a6a)
    }
  },
  cobblestone: (p) => lumps(p, [0x8c8c8c, 0x7a7a7a, 0x9b9b9b, 0x707070], 0x4d4d4d, 10),
  mossy_cobblestone: (p) => {
    lumps(p, [0x8c8c8c, 0x7a7a7a, 0x9b9b9b, 0x707070], 0x4d4d4d, 10)
    for (let k = 0; k < 5; k++) {
      const cx = p.rnd() * 16
      const cy = p.rnd() * 16
      const r = 1.5 + p.rnd() * 2.5
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          if ((x - cx) ** 2 + (y - cy) ** 2 < r * r && p.rnd() < 0.8) p.set(x, y, p.rnd() < 0.5 ? 0x5a7a34 : 0x4b6a2c)
    }
  },
  stone_bricks: (p) => {
    p.noise([0x7c7c7c, 0x747474, 0x858585], [4, 2, 2])
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const row = Math.floor(y / 8)
      const off = row % 2 ? 4 : 0
      if (y % 8 === 7 || (x + off) % 8 === 7) p.set(x, y, 0x575757)
      else if (y % 8 === 0 || (x + off) % 8 === 0) p.shade(x, y, 1.12)
    }
  },
  dirt: (p) => p.noise(C.dirt, [5, 3, 2, 1]),
  grass_top: (p) => {
    p.noise(C.grass, [4, 3, 2, 2])
    p.speck(0x4f7f2a, 0.06)
  },
  grass_side: (p) => toppedSide(p, [0x6a9e3c, 0x5f9234, 0x77aa45], 3),
  snow: (p) => p.noise([0xf1f5f7, 0xe6ecef, 0xfbfdfe], [5, 2, 2]),
  snow_side: (p) => toppedSide(p, [0xf1f5f7, 0xe6ecef, 0xfbfdfe], 4),
  sand: (p) => p.noise(C.sand, [5, 3, 2, 1]),
  gravel: (p) => lumps(p, [0x8a8581, 0x756f6b, 0x9d9794, 0x6a5f58, 0x857b70], 0x5a5553, 16),
  bedrock: (p) => p.noise([0x565656, 0x2e2e2e, 0x777777, 0x1f1f1f], [3, 3, 2, 2]),
  coal_ore: (p) => ore(p, [0x2b2b2b, 0x3a3a3a, 0x222222]),
  iron_ore: (p) => ore(p, [0xd8b293, 0xc49a78, 0xe8c9ad]),
  gold_ore: (p) => ore(p, [0xf7e04a, 0xd9b52c, 0xfff49a], 4),
  diamond_ore: (p) => ore(p, [0x5de0e6, 0x3fb6c0, 0xb5fbff], 4),
  log_side: (p) => bark(p, [0x6b5033, 0x5e4630, 0x755939], 0x3e2d1c),
  log_top: (p) => rings(p, 0x6b5033, 0xb08c5a, 0x9c7b4d),
  birch_side: (p) => {
    p.noise([0xdcd9d0, 0xd0cdc3, 0xe8e6de], [5, 2, 2])
    for (let k = 0; k < 8; k++) {
      const y = Math.floor(p.rnd() * 16)
      const x0 = Math.floor(p.rnd() * 16)
      const len = 2 + Math.floor(p.rnd() * 4)
      for (let x = 0; x < len; x++) p.set((x0 + x) % 16, y, 0x2f2c28)
    }
  },
  birch_top: (p) => rings(p, 0xdcd9d0, 0xc9b48a, 0xb9a47a),
  spruce_side: (p) => bark(p, [0x3d2c1a, 0x46331e, 0x352615], 0x221810),
  spruce_top: (p) => rings(p, 0x3d2c1a, 0x8a6a42, 0x7a5c38),
  planks: (p) => planks(p, [0xa4824f, 0x9a7849, 0xae8b56], 0x6f5532),
  spruce_planks: (p) => planks(p, [0x6d5031, 0x654a2d, 0x755736], 0x46321d),
  birch_planks: (p) => planks(p, [0xd4c38a, 0xcbb981, 0xdccb93], 0xa18f5d),
  leaves: (p) => foliage(p, [0x4f8a2b, 0x3f7322, 0x5e9a36, 0x35651d], 0.22),
  birch_leaves: (p) => foliage(p, [0x76a24a, 0x64903d, 0x85b058, 0x587f34], 0.22),
  spruce_leaves: (p) => foliage(p, [0x3a5a38, 0x30502f, 0x456a43, 0x2a4428], 0.18),
  water: (p) => {
    p.noise([0x3b6ed8, 0x3565cc, 0x4478e0], [5, 2, 2])
    for (let k = 0; k < 6; k++) {
      const y = Math.floor(p.rnd() * 16)
      const x0 = Math.floor(p.rnd() * 16)
      for (let x = 0; x < 4; x++) p.set((x0 + x) % 16, y, 0x6f9cf0)
    }
  },
  glass: (p) => {
    p.clear()
    for (let i = 0; i < 16; i++) {
      p.set(i, 0, 0xdcecf2)
      p.set(i, 15, 0xb8ccd4)
      p.set(0, i, 0xdcecf2)
      p.set(15, i, 0xb8ccd4)
    }
    for (let k = 0; k < 3; k++) p.set(3 + k, 5 - k, 0xf2fbff)
    for (let k = 0; k < 2; k++) p.set(11 + k, 12 - k, 0xf2fbff)
  },
  bricks: (p) => {
    p.noise([0x975848, 0x8b4f40, 0xa3614f], [4, 2, 2])
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const row = Math.floor(y / 4)
      const off = row % 2 ? 4 : 0
      if (y % 4 === 3 || (x + off) % 8 === 7) p.set(x, y, 0xb9b1a7)
    }
  },
  ice: (p) => {
    p.noise([0x8fb6f0, 0x84acea, 0x9cc0f5], [5, 2, 2])
    for (let k = 0; k < 3; k++) {
      const x0 = Math.floor(p.rnd() * 12)
      const y0 = Math.floor(p.rnd() * 12)
      for (let i = 0; i < 4; i++) p.set(x0 + i, y0 + i, 0xc9e0ff)
    }
  },
  sandstone_side: (p) => {
    p.noise([0xd8cc94, 0xcfc28a, 0xe0d59f], [5, 2, 2])
    for (let x = 0; x < 16; x++) {
      p.set(x, 3, 0xc2b47c)
      p.set(x, 11, 0xc2b47c)
      p.set(x, 12, 0xe8dfad)
    }
  },
  sandstone_top: (p) => p.noise([0xe0d6a0, 0xd8cc94, 0xe8dfad], [5, 2, 2]),
  cactus_side: (p) => {
    p.noise([0x2f7d2f, 0x286e28, 0x378a36], [5, 2, 2])
    for (let y = 0; y < 16; y++) {
      p.set(0, y, 0x1f5a20)
      p.set(15, y, 0x1f5a20)
      if (y % 4 === 1) {
        p.set(4, y, 0xdcd9b0)
        p.set(11, y + 2, 0xdcd9b0)
      }
      p.set(7, y, 0x44983f)
    }
  },
  cactus_top: (p) => rings(p, 0x1f5a20, 0x3f8f3a, 0x357f31),
  tnt_side: (p) => {
    p.noise([0xc03a2c, 0xb03427, 0xcc4535], [5, 2, 2])
    for (let x = 0; x < 16; x++) {
      if (x % 4 === 3) for (let y = 0; y < 16; y++) p.shade(x, y, 0.82)
      for (let y = 5; y < 11; y++) p.set(x, y, 0xe8e4dc)
    }
    // TNT, in three letters of a 3x4 pixel font
    const glyph = ['XXX', '.X.', '.X.', '.X.']
    const n = ['X..X', 'XX.X', 'X.XX', 'X..X']
    const draw = (g: string[], x0: number) =>
      g.forEach((row, j) => [...row].forEach((c, i) => c === 'X' && p.set(x0 + i, 6 + j, 0x2a2a2a)))
    draw(glyph, 1)
    draw(n, 6)
    draw(glyph, 12)
  },
  tnt_top: (p) => {
    p.noise([0xc03a2c, 0xb03427], [3, 1])
    p.rect(5, 5, 6, 6, 0xd8d0c0)
    p.rect(7, 7, 2, 2, 0x3a3a3a)
  },
  tnt_bottom: (p) => p.noise([0xc03a2c, 0xa83022], [3, 2]),
  glowstone: (p) => {
    p.noise([0xf0c064, 0xd99a3c, 0xfbe19a, 0xb07a30], [4, 3, 3, 1])
    lumps(p, [0xf2c46a, 0xfbe2a0, 0xe0a848], 0x9a6a28, 7)
  },
  obsidian: (p) => {
    p.noise([0x14101f, 0x1b1530, 0x0e0b16, 0x2c2145], [5, 3, 2, 1])
  },
  bookshelf: (p) => {
    planks(p, [0xa4824f, 0x9a7849, 0xae8b56], 0x6f5532)
    const spines = [0x8a2a24, 0x2a4a8a, 0x3a6a2a, 0x7a5a1a, 0x5a2a6a, 0xa8a090]
    for (const y0 of [1, 9]) {
      p.rect(0, y0, 16, 6, 0x3a2a18)
      let x = 1
      while (x < 15) {
        const w = 1 + Math.floor(p.rnd() * 2)
        const h = 4 + Math.floor(p.rnd() * 2)
        p.rect(x, y0 + 6 - h, w, h, spines[Math.floor(p.rnd() * spines.length)])
        x += w + (p.rnd() < 0.2 ? 1 : 0)
      }
    }
  },
  pumpkin_side: (p) => {
    p.noise([0xd8801e, 0xc9731a, 0xe38c28], [5, 2, 2])
    for (const x of [1, 5, 10, 14]) for (let y = 0; y < 16; y++) p.shade(x, y, 0.8)
  },
  pumpkin_top: (p) => {
    p.noise([0xd8801e, 0xc9731a], [3, 1])
    p.rect(6, 6, 4, 4, 0x6a5a1a)
    p.rect(7, 7, 2, 2, 0x4a3a10)
  },
  tall_grass: (p) => {
    p.clear()
    for (let k = 0; k < 9; k++) {
      let x = 1 + Math.floor(p.rnd() * 14)
      const h = 6 + Math.floor(p.rnd() * 9)
      const col = [0x5f9234, 0x6a9e3c, 0x4f822a][k % 3]
      for (let y = 15; y > 15 - h; y--) {
        p.set(x, y, col)
        if (p.rnd() < 0.2) x += p.rnd() < 0.5 ? -1 : 1
      }
    }
  },
  poppy: (p) => {
    p.clear()
    for (let y = 7; y < 16; y++) p.set(7, y, 0x3f7a26)
    p.set(6, 11, 0x3f7a26)
    p.set(5, 10, 0x3f7a26)
    p.rect(5, 3, 5, 4, 0xc8241e)
    p.rect(6, 2, 3, 6, 0xc8241e)
    p.set(7, 4, 0x2a1a10)
    p.set(6, 3, 0xe04a3a)
  },
  dandelion: (p) => {
    p.clear()
    for (let y = 8; y < 16; y++) p.set(7, y, 0x4a8a2a)
    p.set(8, 12, 0x4a8a2a)
    p.set(9, 11, 0x4a8a2a)
    p.rect(6, 5, 3, 3, 0xf2d21c)
    p.set(7, 4, 0xf2d21c)
    p.set(5, 6, 0xf2d21c)
    p.set(9, 6, 0xf2d21c)
    p.set(7, 6, 0xfbe86a)
  },
  dead_bush: (p) => {
    p.clear()
    const twig = (x: number, y: number, dx: number, n: number) => {
      for (let i = 0; i < n; i++) {
        p.set(x, y, 0x7a5a30)
        y--
        if (i % 2) x += dx
      }
    }
    twig(7, 15, 0, 5)
    twig(7, 11, -1, 6)
    twig(8, 11, 1, 6)
    twig(7, 13, 1, 5)
    twig(7, 12, -1, 4)
  },
  jungle_side: (p) => {
    bark(p, [0x5a4424, 0x6a5230, 0x4e3a1e], 0x3a2a14)
    for (let k = 0; k < 6; k++) p.set(Math.floor(p.rnd() * 16), Math.floor(p.rnd() * 16), 0x4f6a24)
  },
  jungle_top: (p) => rings(p, 0x5a4424, 0xb08c5a, 0x9a764a),
  jungle_leaves: (p) => foliage(p, [0x3a8a1e, 0x2e7a16, 0x48a02a, 0x256812], 0.16),
  acacia_side: (p) => bark(p, [0x6a6258, 0x5e564c, 0x756c60], 0x4a433a),
  acacia_top: (p) => rings(p, 0x6a6258, 0xba6a36, 0xa65c2c),
  acacia_leaves: (p) => foliage(p, [0x6a8a26, 0x5a7a1e, 0x7a9a30, 0x4e6a18], 0.24),
  dark_side: (p) => bark(p, [0x3c2c18, 0x46341e, 0x322412], 0x20160a),
  dark_top: (p) => rings(p, 0x3c2c18, 0x5a4428, 0x4c3820),
  dark_leaves: (p) => foliage(p, [0x3f6a22, 0x345c1c, 0x4a7a2a, 0x2a4c16], 0.14),
  cherry_side: (p) => bark(p, [0x3a2230, 0x452a38, 0x301c28], 0x22121c),
  cherry_top: (p) => rings(p, 0x3a2230, 0xd8a8a8, 0xc89898),
  cherry_leaves: (p) => {
    foliage(p, [0xe8a6c8, 0xf2bcd8, 0xd890b8, 0xfbd0e4], 0.2)
    p.speck(0xfbe6f0, 0.04)
  },
  mycelium_top: (p) => {
    p.noise([0x6f6269, 0x7a6c74, 0x65585e, 0x8a7a82], [4, 3, 2, 1])
    p.speck(0xa89aa2, 0.05)
  },
  mycelium_side: (p) => toppedSide(p, [0x6f6269, 0x7a6c74, 0x65585e], 3),
  red_cap: (p) => {
    p.noise([0xb8261e, 0xa82018, 0xc4302a], [4, 2, 2])
    for (let k = 0; k < 5; k++) {
      const x = 1 + Math.floor(p.rnd() * 13)
      const y = 1 + Math.floor(p.rnd() * 13)
      p.rect(x, y, 2, 2, 0xe8e0d0)
      p.set(x + 2, y, 0xe8e0d0)
    }
  },
  brown_cap: (p) => {
    p.noise([0x8c6a4c, 0x7e5e42, 0x9a7858], [4, 2, 2])
    p.speck(0x6a4e34, 0.08)
  },
  stem: (p) => {
    p.noise([0xd8d0bc, 0xcfc6b0, 0xe2dac8], [4, 2, 2])
    for (let y = 0; y < 16; y++) if (y % 5 === 2) for (let x = 0; x < 16; x++) if (p.rnd() < 0.5) p.shade(x, y, 0.92)
  },
  red_sand: (p) => p.noise([0xb85a24, 0xa8501e, 0xc4642a, 0x9c4a1a], [5, 3, 2, 1]),
  terracotta: (p) => p.noise([0x985e44, 0x8e5840, 0xa2654a], [5, 2, 2]),
  terracotta_orange: (p) => p.noise([0xa15326, 0x974d22, 0xab5a2c], [5, 2, 2]),
  terracotta_yellow: (p) => p.noise([0xba8524, 0xae7c20, 0xc48e2c], [5, 2, 2]),
  terracotta_white: (p) => p.noise([0xd1b2a1, 0xc6a896, 0xdabbaa], [5, 2, 2]),
  terracotta_red: (p) => p.noise([0x8f3d2e, 0x853628, 0x994434], [5, 2, 2]),
  terracotta_brown: (p) => p.noise([0x4d3324, 0x452d20, 0x553a2a], [5, 2, 2]),
  packed_ice: (p) => {
    p.noise([0x8db0e8, 0x82a6e0, 0x98baf0], [5, 2, 2])
    for (let k = 0; k < 4; k++) {
      const x0 = Math.floor(p.rnd() * 14)
      const y0 = Math.floor(p.rnd() * 14)
      for (let i = 0; i < 3; i++) p.set(x0 + i, y0 + (i & 1), 0xb8d0f8)
    }
  },
  podzol_top: (p) => {
    p.noise([0x5e4222, 0x6a4a28, 0x523a1c, 0x7a5a30], [4, 3, 2, 1])
    p.speck(0x3a2a14, 0.06)
  },
  podzol_side: (p) => toppedSide(p, [0x5e4222, 0x6a4a28, 0x523a1c], 2),
  clay: (p) => p.noise([0xa0a6b4, 0x979dab, 0xa9afbd], [5, 2, 2]),
  fern: (p) => {
    p.clear()
    for (const [x0, lean] of [[4, -1], [8, 0], [11, 1]]) {
      for (let y = 15; y > 4; y--) {
        const x = x0 + Math.round(((15 - y) / 11) * lean * 2)
        p.set(x, y, 0x5f9234)
        if (y % 2 === 0) {
          p.set(x - 1, y, 0x6a9e3c)
          p.set(x + 1, y, 0x6a9e3c)
        }
      }
    }
  },
  red_mushroom: (p) => {
    p.clear()
    p.rect(7, 10, 2, 6, 0xd8d0bc)
    p.rect(4, 6, 8, 4, 0xc0281e)
    p.rect(5, 5, 6, 1, 0xc0281e)
    p.set(6, 7, 0xf0e8e0)
    p.set(9, 6, 0xf0e8e0)
  },
  brown_mushroom: (p) => {
    p.clear()
    p.rect(7, 11, 2, 5, 0xd8d0bc)
    p.rect(4, 8, 8, 3, 0x9a7456)
    p.rect(5, 7, 6, 1, 0x9a7456)
  },
  blue_orchid: (p) => {
    p.clear()
    for (let y = 7; y < 16; y++) p.set(8, y, 0x3a7a2a)
    p.set(7, 12, 0x3a7a2a)
    p.set(9, 10, 0x3a7a2a)
    p.rect(6, 4, 2, 2, 0x2aa8e0)
    p.rect(9, 3, 2, 2, 0x2aa8e0)
    p.rect(7, 6, 3, 2, 0x44bcf0)
  },
  sugar_cane: (p) => {
    p.clear()
    for (const x of [4, 8, 11]) for (let y = 0; y < 16; y++) {
      p.set(x, y, y % 5 === 0 ? 0x8ac25a : 0x9ad26a)
      p.set(x + 1, y, 0x7ab04a)
    }
  },
  cornflower: (p) => {
    p.clear()
    for (let y = 8; y < 16; y++) p.set(7, y, 0x3a7a2a)
    p.rect(6, 5, 3, 3, 0x4a6ad8)
    p.set(7, 4, 0x4a6ad8)
    p.set(5, 6, 0x4a6ad8)
    p.set(9, 6, 0x4a6ad8)
    p.set(7, 6, 0x2a3a88)
  },
  oxeye: (p) => {
    p.clear()
    for (let y = 8; y < 16; y++) p.set(7, y, 0x3a7a2a)
    p.rect(5, 4, 5, 5, 0xf2f2ec)
    p.set(5, 4, 0, 0)
    p.set(9, 4, 0, 0)
    p.set(5, 8, 0, 0)
    p.set(9, 8, 0, 0)
    p.rect(7, 6, 1, 1, 0xe8c030)
  },
  acacia_planks: (p) => planks(p, [0xa85a32, 0x9c522c, 0xb46238], 0x70381c),
  jungle_planks: (p) => planks(p, [0xa0724c, 0x966a46, 0xaa7a52], 0x6a4a2c),
  dark_planks: (p) => planks(p, [0x4a3220, 0x422c1c, 0x523826], 0x2a1c10),
  cherry_planks: (p) => planks(p, [0xe2b0a8, 0xd8a69e, 0xeabab2], 0xa8746c),
  ...wools,
}

/** every texture name, in a fixed order: a layer of the terrain's array
    texture is its index here */
export const TEXTURES: readonly string[] = Object.keys(PAINTERS)
export const textureIndex = new Map(TEXTURES.map((n, i) => [n, i]))

const strHash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const painted = new Map<string, Uint8ClampedArray>()
/** a texture's pixels, RGBA rows top down, painted once */
export const paintTexture = (name: string): Uint8ClampedArray => {
  let d = painted.get(name)
  if (d) return d
  const p = makePx(strHash(name))
  ;(PAINTERS[name] ?? PAINTERS.stone)(p)
  d = p.data
  painted.set(name, d)
  return d
}

/** what shows through a see-through pixel on a loose block */
const BACKING: Record<string, number> = {
  leaves: 0x2c521a, birch_leaves: 0x4a6a2e, spruce_leaves: 0x1f361d, glass: 0xa9c8d2,
  jungle_leaves: 0x1c4a0c, acacia_leaves: 0x3a4a10, dark_leaves: 0x1c3a0e, cherry_leaves: 0xb07090,
  tall_grass: 0x4f822a, poppy: 0x3f7a26, dandelion: 0x4a8a2a, dead_bush: 0x7a5a30,
}

/* ---------------------------------------------------------- the props -- */

const cellName = (tex: string) => `blk_${tex}`
for (const name of TEXTURES) {
  cell(cellName(name), {
    w: TEX_SIZE,
    h: TEX_SIZE,
    rough: name === 'glass' || name === 'ice' ? 0.35 : 0.92,
    paint: (pen) => {
      const d = paintTexture(name)
      const back = BACKING[name] ?? 0x000000
      const css = (c: number) => `#${(c | 0x1000000).toString(16).slice(1)}`
      for (let y = 0; y < TEX_SIZE; y++)
        for (let x = 0; x < TEX_SIZE; x++) {
          const i = (y * TEX_SIZE + x) * 4
          const c = d[i + 3] < 128 ? back : (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]
          pen.px(x, y, css(c))
        }
    },
    glow: name === 'glowstone' ? (pen) => pen.fill('#b07830') : undefined,
  })
}

/** the tint a loose block keeps from the biome it grew in: a middling one */
const PROP_TINT: Record<Tint, string | undefined> = { grass: '#e6f0d8', foliage: '#e6f0d8', none: undefined }

if (!CATEGORIES.some((c) => c.id === 'blocks')) {
  CATEGORIES.push({ id: 'blocks', name: { en: 'Blocks', es: 'Bloques' } })
}

for (const b of BLOCKS) {
  if (b.id === AIR || b.liquid || b.cross) continue
  const tint = b.tint ? PROP_TINT[b.tint] : undefined
  const draw = () =>
    model()
      .box([0, 0, 0], [B, B, B], {
        py: { cell: cellName(b.top), tint: b.tint === 'grass' || b.tint === 'foliage' ? tint : undefined },
        ny: { cell: cellName(b.bottom) },
        side: { cell: cellName(b.side), tint: b.tint === 'foliage' ? tint : undefined },
      })
      .mesh()
  const h = B / 2 - 0.01
  registerKind({
    id: blockKind(b),
    label: b.name.en.toLowerCase(),
    shape: { type: 'box', hx: h, hy: h, hz: h },
    mass: b.mass,
    friction: 0.7,
    restitution: 0.05,
    density: b.density,
    linearDamping: 0.05,
    angularDamping: 0.4,
    surface: b.sound,
    explodes: b.explosive ? { power: 1.6, radius: 18, speed: 40 } : undefined,
    mesh: () => batchable(draw()),
  })
  if (b.catalogue) CATALOGUE.push({ id: blockKind(b), category: 'blocks', name: b.name })
}
