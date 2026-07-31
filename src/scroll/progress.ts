/*
  One scroll driver for the whole page.

  Everything that reacts to scroll (the 3D flight path, the tools marquee, the
  audio cues) reads from this single rAF loop instead of attaching its own
  `scroll` listener. Scroll events fire at unpredictable rates and land outside
  the frame, so per-listener smoothing would drift out of step; one loop keeps
  the DOM and the WebGL world describing the same moment.

  Nothing here hijacks scrolling. The page scrolls natively: anchor links,
  keyboard paging, `scroll-mt-16` and the paper plane's own `window.scrollTo`
  follow all keep working. What's smoothed is the *response*: `smoothY` chases
  the real offset with a frame-rate-independent lerp, so the 3D world has
  inertia while the DOM stays exactly where the browser put it.

  The loop idles when nobody is subscribed and stops entirely once AlejOS
  covers the page, the same pause contract HeroScene and BlockName already
  honour through `src/overlay.ts`.
*/

import { onOverlayChange, pageIsCovered } from '../overlay'

/**
 * How fast a smoothed value chases its target, in e-folds per second. Exported
 * because BlockName's render loop smooths the scroll itself rather than paying
 * for a second rAF loop to be told; sharing the constant is what keeps the
 * 3D world and the DOM consumers describing the same moment.
 */
export const SCROLL_EASE = 12

/** the fastest scroll we are willing to report, in CSS pixels per second */
export const MAX_VELOCITY = 4000

const clampVelocity = (v: number) =>
  v > MAX_VELOCITY ? MAX_VELOCITY : v < -MAX_VELOCITY ? -MAX_VELOCITY : v

/** frame-rate independent exponential approach; same feel at 60Hz and 144Hz */
export function approach(current: number, target: number, dt: number, rate = SCROLL_EASE): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

export interface ScrollFrame {
  /** the browser's real scroll offset this frame */
  scrollY: number
  /** the eased offset: what the 3D world should follow */
  smoothY: number
  /** signed CSS pixels per second, smoothed; positive means scrolling down */
  velocity: number
  /** seconds since the previous frame, clamped against tab-switch spikes */
  dt: number
  viewportH: number
  docHeight: number
  /** 0..1 through the scrollable range */
  depth: number
}

type Listener = (frame: ScrollFrame) => void

const listeners = new Set<Listener>()

let raf = 0
let last = 0
let smoothY = 0
let velocity = 0
let primed = false
let reduce = false

function prime() {
  if (primed) return
  primed = true
  reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  smoothY = window.scrollY
  onOverlayChange(() => {
    if (pageIsCovered()) stop()
    else start()
  })
}

function frame(): ScrollFrame {
  const scrollY = window.scrollY
  const viewportH = window.innerHeight
  const docHeight = document.documentElement.scrollHeight
  const range = Math.max(1, docHeight - viewportH)
  return {
    scrollY,
    smoothY,
    velocity,
    dt: 0,
    viewportH,
    docHeight,
    depth: Math.min(1, Math.max(0, scrollY / range)),
  }
}

function tick(now: number) {
  raf = 0
  if (listeners.size === 0 || pageIsCovered()) return

  // a backgrounded tab hands back a huge first delta; clamp so the lerp can't
  // teleport and the velocity can't spike into a bogus marquee lurch
  const dt = last === 0 ? 1 / 60 : Math.min(0.05, (now - last) / 1000)
  last = now

  const scrollY = window.scrollY
  const previous = smoothY
  if (reduce) {
    smoothY = scrollY
  } else {
    smoothY = approach(smoothY, scrollY, dt)
  }
  // A jump (an anchor link, scrollIntoView, restoring a deep scroll position)
  // moves thousands of pixels in one frame, which as a raw derivative is tens of
  // thousands of px/s. Consumers treat velocity as a physical force (the tube's
  // vertical hold slips on it, the marquee is dragged by it), so an unclamped
  // spike is not a big number, it is every consumer pinned at its limit for a
  // second. Clamp to something a hand could actually produce.
  const instant = clampVelocity((smoothY - previous) / dt)
  velocity = approach(velocity, instant, dt, 8)
  if (Math.abs(velocity) < 0.5) velocity = 0

  const f = frame()
  f.dt = dt
  for (const listener of listeners) listener(f)

  raf = requestAnimationFrame(tick)
}

function start() {
  if (raf !== 0 || listeners.size === 0 || pageIsCovered()) return
  last = 0
  raf = requestAnimationFrame(tick)
}

function stop() {
  cancelAnimationFrame(raf)
  raf = 0
}

/**
 * Subscribe to the scroll frame. Returns an unsubscribe; the loop stops on its
 * own once the last listener leaves.
 */
export function onScrollFrame(listener: Listener): () => void {
  prime()
  listeners.add(listener)
  listener(frame())
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

/** the eased offset, for one-off reads outside the loop */
export function smoothScrollY(): number {
  prime()
  return smoothY
}
