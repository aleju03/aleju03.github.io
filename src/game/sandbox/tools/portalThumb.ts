/*
  The portal gun's plate in the catalogue: a side view painted pixel by
  pixel on a 32-cell grid and blown up nearest-neighbour, so it sits among
  the props' own pixel-art icons (thumbnails.ts renders those from their
  models; a gun that only exists as a viewmodel has no model to stand on a
  turntable, so it is drawn instead). The palette is the viewmodel's: cream
  shell, slate receiver, dark claws, the chamber lit blue. DOM only, reached
  lazily by the catalogue.
*/

const CREAM = '#e3dcc8'
const CREAM_D = '#b9b19b'
const SLATE = '#5a6478'
const DARK = '#2a2f3a'
const RUBBER = '#1e2128'
const BLUE = '#6fd6ff'
const BLUE_D = '#2a8fd8'
const ORANGE = '#ffa24a'

/** each row a string of cells: . empty, c cream, s shade, l slate, d dark,
    r rubber, b blue, B deep blue, o orange */
const ART = [
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '.............ccccccccc..........',
  '...ddd......ccccccccccccc.......',
  '..dddddd.dddcccccccccccccs......',
  '.bddd..dddBBbbcccccccccccsd.....',
  '.b.....ddbbbbbbccccccccccssd....',
  '.......ddBbbbbBcccccccccsssdd...',
  '.bddd..ddbbbbbbcccccccccsssdd...',
  '..dddddd.dddlllllllllllllldd....',
  '...ddd......lllllllllllllld.....',
  '..............lll.rrrr..........',
  '..............dd..rrrr..........',
  '...................rrrr.........',
  '...................rrrr.........',
  '....................rrrr........',
  '....................rrrr........',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
]

const INK: Record<string, string> = {
  c: CREAM, s: CREAM_D, l: SLATE, d: DARK, r: RUBBER, b: BLUE, B: BLUE_D, o: ORANGE,
}

/** the plate's picture as an image URL, `size` pixels square */
export const portalGunThumb = (size = 96): string => {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')
  if (!g) return ''
  g.imageSmoothingEnabled = false
  const k = size / ART.length
  // centred a little lower than the grid, where the props' icons sit
  const oy = Math.round(k * 3)
  for (let y = 0; y < ART.length; y++) {
    const row = ART[y]
    for (let x = 0; x < row.length; x++) {
      const ink = INK[row[x]]
      if (!ink) continue
      g.fillStyle = ink
      g.fillRect(Math.floor(x * k), Math.floor(y * k) + oy, Math.ceil(k), Math.ceil(k))
    }
  }
  return c.toDataURL('image/png')
}
