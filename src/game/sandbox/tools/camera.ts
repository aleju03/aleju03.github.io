import type { ToolInput } from './types'

/*
  The camera: the last item of the tools column. Headless like the other
  tools: it reads a `ToolInput`, decides what the click meant and keeps the
  zoom, and leaves everything visible to the scene. It draws nothing itself:
  the viewfinder is a React overlay (components/os/PhotoCamera.tsx), the
  photograph is the scene's canvas copied right after the frame that was
  asked for (CrtScene, components/os/photoStore.ts), and the shutter is
  sfx.ts's.

  Left click asks for a photograph. It is a request, not a capture, because
  only the scene knows when a frame has been drawn: the tool counts requests
  and the scene takes them (`takeShot`) and copies the canvas straight after
  the render that follows, in the same task, which is the only moment a WebGL
  canvas still holds its picture without `preserveDrawingBuffer`. A photo is
  taken at most every SHOT_GAP seconds, so a held button is not a burst.

  Right click puts the camera to the eye: a hand-held zoom that eases to
  `level` times and back. While zoomed the wheel sets the level (1.5 to 6)
  instead of stepping to the next tool. `fov(base)` is the lens the scene
  should use this frame, eased, so zooming is a glide and not a cut.
*/

/** seconds between photographs */
export const SHOT_GAP = 0.8
export const ZOOM_MIN = 1.5
export const ZOOM_MAX = 6
export const ZOOM_DEFAULT = 3

export interface CameraTool {
  /** the zoom being eased toward: 1 or the level */
  readonly target: number
  /** the zoom right now, 1..ZOOM_MAX */
  readonly zoom: number
  /** the level right click zooms to */
  readonly level: number
  readonly zoomed: boolean
  /** photographs asked for and not yet taken */
  readonly pending: number
  /** one frame with the camera in hand */
  update: (input: ToolInput) => void
  /** the wheel, while zoomed: a notch changes the level. False when the
      camera does not want it (not zoomed) */
  wheel: (notches: number) => boolean
  /** advance the ease (the scene calls it once a frame, in or out of hand) */
  step: (dt: number) => void
  /** true once per request: the scene takes the photograph now */
  takeShot: () => boolean
  /** the camera was put away: the zoom lets go */
  cancel: () => void
  /** the lens for a base field of view, degrees */
  fov: (base: number) => number
  /** the total photographs taken (for the harness) */
  readonly taken: number
  onShot: (fn: () => void) => () => void
}

export function createCameraTool(): CameraTool {
  let zoomed = false
  let level = ZOOM_DEFAULT
  let zoom = 1
  let pending = 0
  let taken = 0
  let gap = 0
  let fireWas = false
  let altWas = false
  const shots = new Set<() => void>()

  return {
    get target() {
      return zoomed ? level : 1
    },
    get zoom() {
      return zoom
    },
    get level() {
      return level
    },
    get zoomed() {
      return zoomed
    },
    get pending() {
      return pending
    },
    get taken() {
      return taken
    },
    update: (input) => {
      if (input.fire && !fireWas && gap <= 0) {
        pending++
        gap = SHOT_GAP
        for (const fn of shots) fn()
      }
      if (input.alt && !altWas) zoomed = !zoomed
      fireWas = input.fire
      altWas = input.alt
    },
    wheel: (n) => {
      if (!zoomed || !n) return false
      level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level + (n > 0 ? -0.5 : 0.5)))
      return true
    },
    step: (dt) => {
      gap = Math.max(0, gap - dt)
      const want = zoomed ? level : 1
      // exponential ease, about a fifth of a second to settle
      zoom += (want - zoom) * (1 - Math.exp(-12 * Math.min(0.1, dt)))
      if (Math.abs(zoom - want) < 0.002) zoom = want
    },
    takeShot: () => {
      if (pending <= 0) return false
      pending = 0
      taken++
      return true
    },
    cancel: () => {
      zoomed = false
      pending = 0
      fireWas = altWas = false
    },
    fov: (base) => {
      if (zoom <= 1.001) return base
      const half = Math.tan((base * Math.PI) / 360)
      return (Math.atan(half / zoom) * 360) / Math.PI
    },
    onShot: (fn) => {
      shots.add(fn)
      return () => shots.delete(fn)
    },
  }
}
