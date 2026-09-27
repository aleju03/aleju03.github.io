import { PIXEL_SIZES, type PixelSize } from './roamPrefs'

/*
  The pixel size, shown rather than named. "Small, medium, large" says
  nothing to somebody who has not already seen all three, so the pause
  sheet's settings page prints three proofs of the view standing behind it:
  the middle of the frame as it actually came out of the look at each size,
  cut from the game's own canvas and blown up twice so the step between them
  is obvious from arm's length.

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
    sizes is a pixel or so and easy to miss, at 2 nobody misses it */
export const PROOF_MAG = 2

/** a crop per pixel size, as image URLs ready for an `<img>` */
export type PixelProofs = Record<PixelSize, string>

/**
  Draw the scene at each pixel size and cut the middle of the canvas out
  after each. `draw` renders one frame at the given size into the canvas;
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
  const sx = Math.round((canvas.width - w) / 2)
  const sy = Math.round((canvas.height - h) / 2)
  const cut = document.createElement('canvas')
  cut.width = w
  cut.height = h
  const g = cut.getContext('2d')
  if (!g) return null
  const out = {} as PixelProofs
  for (const size of PIXEL_SIZES) {
    draw(size)
    g.clearRect(0, 0, w, h)
    g.drawImage(canvas, sx, sy, w, h, 0, 0, w, h)
    out[size] = cut.toDataURL()
  }
  return out
}
