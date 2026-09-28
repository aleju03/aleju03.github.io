import * as THREE from 'three'
import { cell, model, repaintCell, type Pen } from '../art'
import { signLines } from './tags'

/*
  Text on a sign without a new shader.

  A prop is an instance of a shared geometry on the one atlas material
  (art.ts), and a texture cannot differ per instance. So the signs cannot
  each carry their own canvas, and adding a material for them would link a
  program mid-walk. What differs per instance is *which geometry* the proxy
  draws (batch.ts groups proxies by geometry), and a geometry is only a
  rectangle of the atlas: so there is a small fixed pool of pre-declared
  atlas cells for text tiles (POOL of them, declared before the atlas packs),
  one board geometry per cell, and a sign whose text is set is handed a tile,
  the tile is painted with the text (art.ts's `repaintCell`: one cell of the
  colour layer, then the same texture re-uploaded) and the sign's proxy is
  pointed at that tile's geometry. Nothing links.

  Signs with the same text share a tile (reference counted), and a tile
  nobody uses is kept with its text painted until it is needed again, so
  retyping a sign back to what it said costs nothing. Past POOL different
  texts at once the extras show the blank board: a sign must never take
  another's words away. The pool is per page, not per level; each client
  hands out its own tiles, and only the text travels (tags.ts).

  The font is a 5x7 of its own (the catalogue's pen has 3x5 and a few 5x7
  capitals, not a whole alphabet): upper case, digits and the punctuation a
  sign wants, and the Spanish accents folded onto the letter under them except
  the enye and the two opening marks. Short text is drawn at double size.
*/

/** tiles in the pool: different texts that can be on screen at once */
export const POOL = 24
export const TILE_W = 128
export const TILE_H = 40
/** the board, world units (the tile's 3.2 : 1) */
export const BOARD = { w: 4.4, h: 1.375, d: 0.16 }

const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['#...#', '#...#', '#...#', '#####', '....#', '....#', '....#'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  ';': ['.....', '.##..', '.##..', '.....', '.##..', '..#..', '.#...'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '"': ['.#.#.', '.#.#.', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '*': ['.....', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '@': ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.####'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
  '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
  '$': ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '[': ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.'],
  ']': ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.'],
  '^': ['..#..', '.#.#.', '#...#', '.....', '.....', '.....', '.....'],
  '~': ['.....', '.##.#', '#.##.', '.....', '.....', '.....', '.....'],
  '|': ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  '{': ['..##.', '.#...', '.#...', '#....', '.#...', '.#...', '..##.'],
  '}': ['.##..', '...#.', '...#.', '....#', '...#.', '...#.', '.##..'],
  '`': ['.#...', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '\\': ['#....', '#....', '.#...', '..#..', '...#.', '....#', '....#'],
  Ñ: ['.#.#.', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  '¡': ['..#..', '.....', '..#..', '..#..', '..#..', '..#..', '..#..'],
  '¿': ['..#..', '.....', '..#..', '.#...', '#....', '#...#', '.###.'],
}

const glyphOf = (ch: string): string[] => {
  const up = ch.toUpperCase()
  return GLYPHS[up] ?? GLYPHS[up.normalize('NFD')[0]] ?? GLYPHS['?']
}

const INK = '#2b2019'
const BOARD_COLOR = '#ece2c6'
const EDGE = '#8a5f36'

/** the board itself: paper with a border, and faint rules where text goes */
const board = (p: Pen) => {
  p.fill(EDGE)
  p.rect(2, 2, p.w - 4, p.h - 4, BOARD_COLOR)
  p.rect(3, 3, p.w - 6, 1, '#f6efdc')
}

/** paint `text` on a tile, centred, double size when it is short */
const write = (p: Pen, text: string) => {
  board(p)
  if (!text) return
  const lines = signLines(text).filter(Boolean)
  const longest = Math.max(...lines.map((l) => l.length))
  const s = longest <= 10 ? 2 : 1
  const lineH = 7 * s
  const gap = s === 2 ? 3 : 4
  const total = lines.length * lineH + (lines.length - 1) * gap
  let y = Math.round((p.h - total) / 2)
  for (const line of lines) {
    const w = line.length * 6 * s - s
    let x = Math.round((p.w - w) / 2)
    for (const ch of line) {
      glyphOf(ch).forEach((row, ry) => {
        for (let bx = 0; bx < 5; bx++) if (row[bx] === '#') p.rect(x + bx * s, y + ry * s, s, s, INK)
      })
      x += 6 * s
    }
    y += lineH + gap
  }
}

/* ---------------------------------------------------------------- pool -- */

const tileName = (i: number) => (i < 0 ? 'sign_blank' : `sign_${i}`)
cell('sign_blank', { w: TILE_W, h: TILE_H, paint: (p) => board(p) })
for (let i = 0; i < POOL; i++) cell(tileName(i), { w: TILE_W, h: TILE_H, paint: (p) => board(p) })

/** what each tile has painted on it, and how many signs are showing it */
const painted: string[] = Array.from({ length: POOL }, () => '')
const users: number[] = Array.from({ length: POOL }, () => 0)
/** least recently freed first, so a tile that lately said something keeps it */
const freed: number[] = Array.from({ length: POOL }, (_, i) => i)

/** a tile for this text (-1: the blank board, for no text or a full pool).
    Every acquire is paid for with a `release` of the same text */
export const acquireTile = (text: string): number => {
  if (!text) return -1
  let i = painted.findIndex((t, k) => t === text && (users[k] > 0 || freed.includes(k)))
  if (i < 0) {
    const pick = freed.find((k) => users[k] === 0)
    if (pick === undefined) return -1
    i = pick
    painted[i] = text
    repaintCell(tileName(i), (p) => write(p, text))
  }
  users[i]++
  const at = freed.indexOf(i)
  if (at >= 0) freed.splice(at, 1)
  return i
}

export const releaseTile = (tile: number) => {
  if (tile < 0 || users[tile] <= 0) return
  if (--users[tile] === 0) freed.push(tile)
}

/** tiles in use and painted, for the harness */
export const tileStats = () => ({ used: users.filter((n) => n > 0).length, painted: painted.filter(Boolean).length })

/* ------------------------------------------------------------ geometry -- */

const geos = new Map<number, THREE.BufferGeometry>()

/** the sign's shape drawn with one tile on its face */
export const signGeometry = (tile: number): THREE.BufferGeometry => {
  let g = geos.get(tile)
  if (g) return g
  const { w, h, d } = BOARD
  const wood = { cell: 'white', tint: '#8a5f36' }
  const m = model()
  // the posts, then the board on them: the face towards +z carries the tile,
  // the back and the rim are painted wood
  for (const x of [-1, 1]) m.box([x * (w / 2 - 0.5), -0.55, 0], [0.24, 1.1, 0.2], wood)
  m.box([0, -1.0, 0], [w - 0.6, 0.2, 1.2], wood)
  m.box([0, 0.72 + 0.0, 0], [w, h, d], { pz: { cell: tileName(tile) }, all: { cell: 'white', tint: '#c9a874' } })
  g = m.geometry()
  geos.set(tile, g)
  return g
}
