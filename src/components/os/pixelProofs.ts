import { PIXEL_SIZES, type PixelSize } from './roamPrefs'

/*
  The pixel size, shown rather than named. "Small, medium, large" says
  nothing to somebody who has not already seen all three, so the pause
  sheet's settings page prints three proofs of the view standing behind it:
  one patch of the frame as it actually came out of the look at each size,
  cut from the game's own canvas and blown up three times so the step
  between them is obvious from arm's length.

  Which patch matters more than anything else here. The first cut was the
  middle of the frame, and the middle of a street is sky or asphalt, where
  every pixel size looks the same flat colour; the owner rightly called the
  prints no help. So the finest frame is searched for its busiest patch (the
  most places where neighbouring pixels differ: leaves, windows, a roofline
  at a slant), away from the bottom corners where the gun in hand would
  win every time, and all three sizes are cut from that same patch.

  They are real frames, not a simulation. Downsampling one captured frame
  would lie in both directions (a finer size than the one in force cannot be
  recovered from a coarser picture), so CrtScene answers a request by drawing
  the scene through the look once per size, copying the middle out of the
  canvas after each, and then drawing its normal frame over the top, all in
  one task, so nothing flashes. Changing the look's line count is a target
  resize and never a program (`pixelLook.ts`'s header), which is why this is
  safe to do mid-walk: it costs three extra renders on a frame the menu is
  already covering, once each time the page opens.

  The copy has to happen inside the task that drew the frame. A WebGL canvas
  without `preserveDrawingBuffer` is cleared once the browser has presented
  it, so a `drawImage` from anywhere else reads back nothing.
*/

/** one proof on the sheet, in CSS pixels */
export const PROOF_W = 176
export const PROOF_H = 96
/** how much bigger than on the screen: at 1 the difference between two
    sizes is a pixel or so and easy to miss, at 3 nobody misses it */
export const PROOF_MAG = 3

/** the grid the busiest-patch search reads the frame through */
const PROBE_W = 96
const PROBE_H = 54

/**
  The window of the frame (in canvas pixels, `w` x `h`) with the most going
  on in it: the frame shrunk to a small grid, the contrast of each cell with
  its right and lower neighbours summed over every window position, the
  bottom quarter (the gun, the hand, the hint tape) left out.
*/
const busiestPatch = (canvas: HTMLCanvasElement, w: number, h: number) => {
  const mid = { x: Math.round((canvas.width - w) / 2), y: Math.round((canvas.height - h) / 2) }
  const probe = document.createElement('canvas')
  probe.width = PROBE_W
  probe.height = PROBE_H
  const g = probe.getContext('2d', { willReadFrequently: true })
  if (!g) return mid
  g.drawImage(canvas, 0, 0, PROBE_W, PROBE_H)
  const px = g.getImageData(0, 0, PROBE_W, PROBE_H).data
  const lum = (i: number) => px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11
  const edge = new Float32Array(PROBE_W * PROBE_H)
  for (let y = 0; y < PROBE_H - 1; y++) {
    for (let x = 0; x < PROBE_W - 1; x++) {
      const i = (y * PROBE_W + x) * 4
      const c = lum(i)
      // counted, not summed: a patch busy everywhere (leaves, windows,
      // a roof's edge running at a slant) shows the steps between sizes,
      // while two hard vertical lines across flat colour barely change
      const e = Math.abs(c - lum(i + 4)) + Math.abs(c - lum(i + PROBE_W * 4))
      edge[y * PROBE_W + x] = e > 10 ? 1 + Math.min(1, e / 60) : 0
    }
  }
  const ww = Math.max(1, Math.round((w / canvas.width) * PROBE_W))
  const wh = Math.max(1, Math.round((h / canvas.height) * PROBE_H))
  const maxY = Math.floor(PROBE_H * 0.75) - wh
  let best = -1
  let bx = 0
  let by = 0
  for (let y = 0; y <= maxY; y += 2) {
    for (let x = 0; x + ww < PROBE_W; x += 2) {
      let sum = 0
      for (let yy = y; yy < y + wh; yy++) {
        for (let xx = x; xx < x + ww; xx++) sum += edge[yy * PROBE_W + xx]
      }
      // a nudge toward the middle, so a tie goes to where the eye already is
      const cx = (x + ww / 2) / PROBE_W - 0.5
      const cy = (y + wh / 2) / PROBE_H - 0.4
      sum *= 1 - 0.35 * (cx * cx + cy * cy)
      if (sum > best) {
        best = sum
        bx = x
        by = y
      }
    }
  }
  if (best <= 0) return mid
  return {
    x: Math.min(canvas.width - w, Math.round((bx / PROBE_W) * canvas.width)),
    y: Math.min(canvas.height - h, Math.round((by / PROBE_H) * canvas.height)),
  }
}

/** a crop per pixel size, as image URLs ready for an `<img>` */
export type PixelProofs = Record<PixelSize, string>

/**
  Draw the scene at each pixel size and cut the same patch of the canvas
  out after each: the busiest one in the finest frame, which is drawn first. `draw` renders one frame at the given size into the canvas;
  the caller restores its own size and redraws afterwards.
*/
export function snapPixelProofs(
  canvas: HTMLCanvasElement,
  draw: (size: PixelSize) => void,
): PixelProofs | null {
  // device pixels per CSS pixel, as this canvas is actually laid out
  const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
  const w = Math.max(1, Math.round((PROOF_W * dpr) / PROOF_MAG))
  const h = Math.max(1, Math.round((PROOF_H * dpr) / PROOF_MAG))
  if (canvas.width < w || canvas.height < h) return null
  let sx = Math.round((canvas.width - w) / 2)
  let sy = Math.round((canvas.height - h) / 2)
  let found = false
  const cut = document.createElement('canvas')
  cut.width = w
  cut.height = h
  const g = cut.getContext('2d')
  if (!g) return null
  const out = {} as PixelProofs
  for (const size of PIXEL_SIZES) {
    draw(size)
    if (!found) {
      // PIXEL_SIZES runs finest first, and the finest frame shows the
      // detail the coarser ones blur away
      found = true
      const at = busiestPatch(canvas, w, h)
      sx = at.x
      sy = at.y
    }
    g.clearRect(0, 0, w, h)
    g.drawImage(canvas, sx, sy, w, h, 0, 0, w, h)
    out[size] = cut.toDataURL()
  }
  return out
}
