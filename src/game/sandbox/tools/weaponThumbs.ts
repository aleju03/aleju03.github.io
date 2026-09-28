/*
  The weapons' plates in the catalogue, drawn the way the portal gun's is
  (portalThumb.ts): a side view painted cell by cell on a 32-cell grid and
  blown up nearest-neighbour, so they sit among the props' pixel-art icons.
  The palette is the viewmodel's: pale steel over a dark frame and wooden
  grips for the pistol, a wooden stock and dark limbs with a hot bolt for
  the crossbow, a slate tube with ochre bands and a cream pad for the
  launcher. Every gun points left, as the portal gun does. DOM only, reached
  lazily by the catalogue.
*/

const INK: Record<string, string> = {
  s: '#b7bfca', S: '#7c8591', d: '#2a2f3a', w: '#8a5a34', W: '#6a4226', o: '#d09a3a', r: '#1e2128',
  h: '#ffb347', H: '#ff7a1a', c: '#e3dcc8', l: '#5a6478', L: '#48505f', g: '#6fd6ff',
}

/** . empty, s/S steel, d dark, w/W wood, o ochre, r rubber, h/H hot, c
    cream, l/L slate, g lens */
const ART: Record<'pistol' | 'crossbow' | 'rocket', readonly string[]> = {
  pistol: [
    '........o...............d.......',
    '.......sssssssssssssssssss......',
    '......dsssssssssssssssdssS......',
    '.......SSSSSSSSSSSSSSSSSSS......',
    '.........dddddddddddddddddd.....',
    '..............d...d..wwwwww.....',
    '..............d..d..wwWwww......',
    '..............dddd..wwWwww......',
    '...................wwWwww.......',
    '...................wwWwww.......',
    '..................wwwwww........',
    '..................dddddd........',
  ],
  crossbow: [
    '...dd...........................',
    '....dd.......SSSSSSSSS..........',
    '.....dd......g.d....d...........',
    '......dd........................',
    'Hhssssssssssssssssssssss........',
    '..dddddddddddddddddddddddd......',
    '......ddwwwwwwwwwwwwwwwwwwwww...',
    '......d.wwwwwwwwwwwwwwwwwwwwwwww',
    '.....dd.......d.d.rrr....wwwWWWw',
    '....dd........ddd.rrr......wwWWw',
    '...dd..............rrr..........',
    '..dd................rr..........',
  ],
  rocket: [
    '...............dd...............',
    '..............dddg..............',
    '.dddd..........d...............dd',
    'oddlllllllllllllllllllllllllllddd',
    'oodlloolloLLLLLLLLLLLLllllllllddd',
    'oddlllllllllllllllllllllllllllddd',
    '.dddd.......rrr.....dddcccc....dd',
    '............rrr.....dd.cccc......',
    '.............rr......rr..........',
    '.....................rr..........',
    '......................rr.........',
  ],
}

/** a weapon's plate as an image URL, `size` pixels square */
export const weaponThumb = (w: 'pistol' | 'crossbow' | 'rocket', size = 96): string => {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')
  if (!g) return ''
  g.imageSmoothingEnabled = false
  const k = size / 32
  const rows = ART[w]
  // centred on the grid, a little low, where the props' icons sit
  const oy = Math.round(k * (16 - rows.length / 2 + 2))
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    for (let x = 0; x < Math.min(32, row.length); x++) {
      const ink = INK[row[x]]
      if (!ink) continue
      g.fillStyle = ink
      g.fillRect(Math.floor(x * k), Math.floor(y * k) + oy, Math.ceil(k), Math.ceil(k))
    }
  }
  return c.toDataURL('image/png')
}
