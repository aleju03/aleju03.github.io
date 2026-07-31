/*
  The pause screen's paper stock and its palette.

  `PauseScreen.tsx` is not a HUD floating over the room, it is a sheet of
  paper pinned to the bedroom wall, so it needs to look like one, and this
  repo does not ship images (see CLAUDE.md: textures are drawn onto canvases
  at runtime, `game/core/textures.ts`). So the stock is a 256px canvas tile:
  per-pixel grain, a few soft blotches, and a scatter of darker flecks, tiled
  behind the sheet as a CSS background.

  Two things make it read as paper rather than as noise. **The grain is
  correlated, not per-pixel random**: a value-noise field at two octaves,
  which gives the cloudy unevenness of pressed pulp instead of television
  snow. And **everything wraps**: the noise lattice is periodic and the
  blotches are drawn nine times at every tile offset, so a tiled 256px square
  has no visible seam and no repeating landmark at low contrast.

  The palette lives here because the sheet and the things written on it are
  one object, and both `PauseScreen.tsx` and `WorldIdentity.tsx` need the same
  ink. That is also why it is not the site's stone scale: those tokens flip
  with the light/dark theme, and a piece of paper in a dark room does not. The
  marks drawn with this ink are components, so they live next door in
  `PaperMarks.tsx`; a module that exports both would break fast refresh.
*/

/** the stock: a warm cream, a shade toward manila */
export const PAPER = '#e8ddc4'
/** what is written on it */
export const INK = '#3b3226'
/** and what is written smaller */
export const INK_SOFT = '#8c7c64'
/** the one marker on the desk: the site's terracotta */
export const MARK = '#c0705c'

/** deterministic, so the same sheet comes back on every reload rather than a
    new one each time the menu opens */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

const SIZE = 256

/** one octave of periodic value noise, sampled with smoothstep interpolation
    so it wraps at `cells` and has no lattice edges inside the tile */
function noiseField(cells: number, rand: () => number) {
  const g = new Float32Array(cells * cells)
  for (let i = 0; i < g.length; i++) g[i] = rand()
  const at = (x: number, y: number) => g[(y % cells) * cells + (x % cells)]
  return (u: number, v: number) => {
    const x = u * cells
    const y = v * cells
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = at(x0, y0)
    const b = at(x0 + 1, y0)
    const c = at(x0, y0 + 1)
    const d = at(x0 + 1, y0 + 1)
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
  }
}

let cached: string | null = null

/** the tile, as a data URL. Built once per session, because a texture that
    re-rasterised on every pause would be the most expensive thing on a screen
    whose whole job is to be cheap */
export function paperTexture(): string {
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const g = canvas.getContext('2d')
  if (!g) return (cached = '')

  g.fillStyle = PAPER
  g.fillRect(0, 0, SIZE, SIZE)

  // the pulp: two octaves, low contrast. Anything stronger than a couple of
  // percent stops being paper and starts being camouflage
  const rand = lcg(0x9e3779b9)
  const coarse = noiseField(8, rand)
  const fine = noiseField(32, rand)
  const img = g.getImageData(0, 0, SIZE, SIZE)
  const px = img.data
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE
      const v = y / SIZE
      const n = (coarse(u, v) - 0.5) * 9 + (fine(u, v) - 0.5) * 5 + (rand() - 0.5) * 4
      const i = (y * SIZE + x) * 4
      px[i] = Math.min(255, Math.max(0, px[i] + n))
      px[i + 1] = Math.min(255, Math.max(0, px[i + 1] + n))
      px[i + 2] = Math.min(255, Math.max(0, px[i + 2] + n))
    }
  }
  g.putImageData(img, 0, 0)

  // flecks: the darker specks in cheap stock. Drawn nine times so the ones
  // near an edge continue onto the opposite one
  for (let i = 0; i < 90; i++) {
    const x = rand() * SIZE
    const y = rand() * SIZE
    const r = 0.4 + rand() * 0.9
    g.fillStyle = `rgba(90,74,52,${0.05 + rand() * 0.09})`
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        g.beginPath()
        g.arc(x + ox * SIZE, y + oy * SIZE, r, 0, Math.PI * 2)
        g.fill()
      }
    }
  }

  cached = canvas.toDataURL('image/png')
  return cached
}

/** a shape circled with the marker: four lopsided radii and a degree of tilt,
    which is as close to a hand as a border-radius gets */
export const CIRCLED = {
  border: `2px solid ${MARK}`,
  borderRadius: '46% 54% 49% 51% / 58% 42% 56% 44%',
  transform: 'rotate(-1.2deg)',
} as const
