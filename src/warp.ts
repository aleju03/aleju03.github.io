import { BOOT_OS_EVENT, OS_SCENE_READY_EVENT } from './events'

/*
  The trip between worlds: the page is switched off, and a computer is switched
  on in its place.

  This site is about a CRT. There is one lying in the corner of the machine act,
  you scroll it upright, it lights its tube, and clicking it takes you inside
  the thing. So the transition is the tube: the picture collapses to a hot
  scanline the way every monitor and television made before about 2006 did when
  you hit the switch, the line holds while the far side loads, and then it opens
  back out into AlejOS. Nothing about it is borrowed from anywhere else on the
  internet, which is the point, and nothing about it needs explaining to anyone
  who ever turned off a television.

  It replaced a wormhole: a hole torn open on the glass, a tunnel of rings and
  infalling specks, a second hole torn open at the far end. That was a good
  effect attached to the wrong site. It was sci-fi in a room full of beige
  plastic, it took a second and a half before the far side was even asked for,
  and it was drawn on a full-screen 2D canvas, per frame, on the same main
  thread that was about to spend four seconds building a 3D house.

  Which is the other half of why this shape and not another. Three things run
  during the trip, and all three are hostile to animation: the AlejOS chunk
  evaluates, three.js links its shaders, and the room builds its geometry. The
  main thread is simply gone for seconds at a time, in lumps of over a second.
  So NOTHING here is drawn per frame and nothing here is drawn on the main
  thread. The whole trip is four promoted layers moved by CSS transitions on
  transform and opacity, which the compositor runs by itself; the ride can hold
  for as long as the far side needs and the reveal cannot be stolen by the frame
  the far side happens to announce itself on. The old exit was measured landing
  inside a single 1233 ms stall, which is to say it was not seen at all.

  The layers are also built BEFORE the click, on the first sign the visitor is
  heading for the machine (`prepareWarp`, wired to hover and focus on the wreck
  and its button). Promoting a full-screen layer over a live WebGL page costs
  around a tenth of a second of raster the first time, and profiling the click
  found the main thread 74% idle through it: it is not script and no amount of
  care in the animation avoids it. It has to happen earlier or it happens on
  screen. A visitor who never hovers (tab and enter, or the paper plane being
  swallowed) pays it at the click, as before.

  BlockName registers the wreck's live glass rect, so the line collapses onto
  the exact screen you clicked and slides to the middle of the viewport while
  it waits, rather than appearing from nowhere.
*/

interface Mouth {
  x: number
  y: number
  r: number
}

let origin: (() => Mouth) | null = null
let running = false

/** BlockName tells the warp where the wreck's glass sits on the viewport */
export function provideWarpOrigin(fn: () => Mouth) {
  origin = fn
  return () => {
    if (origin === fn) origin = null
  }
}

/** the picture collapsing onto the line */
const CLOSE_MS = 380
/** the line drifting from the glass to the middle, under the wait */
const CENTRE_MS = 900
/** the ride never ends sooner than this, or the trip reads as a flicker */
const MIN_RIDE_MS = 700
/** and never later than this: a far side that never answers still gets shown */
const MAX_RIDE_MS = 12000
/** the line blooming back open onto the room */
const OPEN_MS = 520

const INK = '#0c0a09' // stone-950, same night the OS overlay sits on
const ACCENT = '96,165,250' // blue-400, the site's one accent
const FILAMENT = '#f5f5f4' // stone-100: a hot line is white, not blue

interface Cover {
  /** collapse the picture onto the line, over the glass at `at` */
  close: (at: Mouth) => void
  /** the tube holding: scanlines, a rolling bar, the line drifting to centre */
  hold: () => void
  /** the tube coming back on, onto whatever is behind */
  open: (done: () => void) => void
  remove: () => void
}

let prepared: Cover | null = null

/**
 * The four layers, built inert and effectively invisible so this can be called
 * long before it is used. Two solid-colour panes (which the compositor handles
 * almost for free), one thin filament, and one texture layer carrying the
 * scanlines, the rolling bar and the vignette as static backgrounds so that
 * moving them is a transform and never a repaint.
 */
function buildCover(): Cover {
  const H = () => window.innerHeight

  const layer = document.createElement('div')
  layer.setAttribute('aria-hidden', 'true')
  layer.dataset.alejosWarp = 'true'
  layer.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:71', 'overflow:hidden',
    'pointer-events:none', 'contain:strict',
  ].join(';')

  const style = document.createElement('style')
  style.textContent = `
    @keyframes alejos-warp-roll {
      0%   { transform:translate3d(0,110%,0) }
      100% { transform:translate3d(0,-110%,0) }
    }
    @keyframes alejos-warp-breathe {
      0%,100% { opacity:.85 }
      50%     { opacity:1 }
    }
  `
  layer.appendChild(style)

  // Each pane is a full-height sheet of ink parked off its own edge. Closing
  // means sliding them in until they meet on the line; opening means sliding
  // them back out. A solid-colour layer is the cheapest thing a compositor can
  // be asked to move, which is the entire reason the picture is "collapsed"
  // with two shutters rather than by scaling anything.
  const pane = (edge: 1 | -1) => {
    const el = document.createElement('div')
    el.style.cssText = [
      'position:absolute', 'left:0', 'right:0', 'top:0', 'height:100%',
      `background:${INK}`, 'will-change:transform',
      `transform:translate3d(0,${edge * 100}%,0)`,
    ].join(';')
    return el
  }
  const paneTop = pane(-1)
  const paneBottom = pane(1)
  layer.append(paneTop, paneBottom)

  // the dead tube's own texture, over the ink: scanlines, the corner falloff,
  // and one soft bar rolling up the screen the way a mistuned vertical hold
  // used to. All three are static paint; only the bar moves, and it moves by
  // transform
  const tube = document.createElement('div')
  tube.style.cssText = [
    'position:absolute', 'inset:0', 'opacity:0', 'overflow:hidden',
    'transition:opacity 260ms linear', 'will-change:opacity',
    'background:' +
      'repeating-linear-gradient(to bottom,rgba(231,229,228,.05) 0 1px,transparent 1px 3px),' +
      `radial-gradient(ellipse at center,rgba(${ACCENT},.05) 0%,rgba(0,0,0,0) 55%,rgba(0,0,0,.5) 100%)`,
  ].join(';')
  const bar = document.createElement('div')
  bar.style.cssText = [
    'position:absolute', 'left:0', 'right:0', 'top:0', 'height:22%',
    'will-change:transform',
    'background:linear-gradient(to bottom,rgba(245,245,244,0) 0%,rgba(245,245,244,.05) 45%,rgba(245,245,244,.09) 55%,rgba(245,245,244,0) 100%)',
    'animation:alejos-warp-roll 3.4s linear infinite',
    'animation-play-state:paused',
  ].join(';')
  tube.appendChild(bar)
  layer.appendChild(tube)

  // the filament: the whole picture, squeezed into two pixels
  const line = document.createElement('div')
  line.style.cssText = [
    'position:absolute', 'left:0', 'right:0', 'top:0', 'height:2px',
    'opacity:0', `background:${FILAMENT}`,
    `box-shadow:0 0 16px 2px rgba(${ACCENT},.8),0 0 52px 10px rgba(${ACCENT},.3)`,
    'will-change:transform,opacity',
  ].join(';')
  layer.appendChild(line)

  document.body.appendChild(layer)
  // one forced layout with nothing animating, so the promotion and first raster
  // of all four surfaces is paid here rather than on a frame anyone is watching
  void layer.offsetHeight

  let removed = false
  let y = 0

  return {
    close: (at) => {
      const h = H()
      y = Math.max(2, Math.min(h - 2, at.y))
      // the line starts the width of the glass you clicked and snaps out to the
      // full width as the shutters arrive: the picture is being squeezed out
      // sideways, not just covered up
      line.style.transition = 'none'
      line.style.transform = `translate3d(0,${y}px,0) scaleX(${Math.max(0.04, (at.r * 2) / window.innerWidth)})`
      line.style.opacity = '0'
      void line.offsetHeight
      line.style.transition = `transform ${CLOSE_MS}ms cubic-bezier(.6,0,.2,1),opacity 120ms linear`
      paneTop.style.transition = `transform ${CLOSE_MS}ms cubic-bezier(.6,0,.2,1)`
      paneBottom.style.transition = `transform ${CLOSE_MS}ms cubic-bezier(.6,0,.2,1)`
      requestAnimationFrame(() => {
        paneTop.style.transform = `translate3d(0,${y - h}px,0)`
        paneBottom.style.transform = `translate3d(0,${y}px,0)`
        line.style.transform = `translate3d(0,${y}px,0) scaleX(1)`
        line.style.opacity = '1'
      })
    },
    hold: () => {
      const h = H()
      tube.style.opacity = '1'
      bar.style.animationPlayState = 'running'
      line.style.animation = 'alejos-warp-breathe 1.3s ease-in-out infinite'
      // the picture settling into the middle of the tube while it warms, so the
      // opening is symmetric wherever on the page you clicked from
      y = h / 2
      line.style.transition = `transform ${CENTRE_MS}ms cubic-bezier(.33,1,.68,1)`
      paneTop.style.transition = `transform ${CENTRE_MS}ms cubic-bezier(.33,1,.68,1)`
      paneBottom.style.transition = `transform ${CENTRE_MS}ms cubic-bezier(.33,1,.68,1)`
      requestAnimationFrame(() => {
        paneTop.style.transform = `translate3d(0,${y - h}px,0)`
        paneBottom.style.transform = `translate3d(0,${y}px,0)`
        line.style.transform = `translate3d(0,${y}px,0) scaleX(1)`
      })
    },
    open: (done) => {
      const h = H()
      tube.style.opacity = '0'
      line.style.animation = 'none'
      line.style.opacity = '1'
      // a beat of full brightness before anything moves: the flyback kicking in
      window.setTimeout(() => {
        paneTop.style.transition = `transform ${OPEN_MS}ms cubic-bezier(.16,1,.3,1)`
        paneBottom.style.transition = `transform ${OPEN_MS}ms cubic-bezier(.16,1,.3,1)`
        line.style.transition = `transform ${OPEN_MS}ms cubic-bezier(.16,1,.3,1),opacity 320ms linear`
        paneTop.style.transform = `translate3d(0,${-h}px,0)`
        paneBottom.style.transform = `translate3d(0,${h}px,0)`
        // the filament blooming as it dies, the way the phosphor does
        line.style.transform = `translate3d(0,${y}px,0) scaleX(1) scaleY(5)`
        line.style.opacity = '0'
      }, 110)
      window.setTimeout(done, 110 + OPEN_MS + 60)
    },
    remove: () => {
      if (removed) return
      removed = true
      layer.remove()
    },
  }
}

/**
 * Build the trip's layers now, so the click doesn't have to. Idempotent and
 * safe to call on every hover; see the header for why this exists at all.
 */
export function prepareWarp(): void {
  if (prepared || running || typeof window === 'undefined') return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  prepared = buildCover()
}

export function warpToOs(detail?: { app?: string; via?: 'plane' }) {
  if (running) return
  const boot = () =>
    window.dispatchEvent(
      detail ? new CustomEvent(BOOT_OS_EVENT, { detail }) : new Event(BOOT_OS_EVENT),
    )
  // the whole point of the overlay is motion; without it, just flip over
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    boot()
    return
  }
  running = true
  const cover = prepared ?? buildCover()
  prepared = null

  // the glass you clicked, or the wreck's stage, or the middle of the screen
  const stage = document.getElementById('os-wreck')?.getBoundingClientRect()
  const at =
    origin?.() ??
    (stage
      ? { x: stage.left + stage.width * 0.36, y: stage.top + stage.height * 0.5, r: stage.width * 0.18 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2, r: 90 })

  cover.close(at)

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    cover.remove()
    running = false
  }

  let opened = false
  const open = () => {
    if (opened || finished) return
    opened = true
    window.removeEventListener(OS_SCENE_READY_EVENT, onReady)
    cover.open(finish)
  }
  // Timers, not rAF: nothing here is drawing, they only decide WHEN the far
  // side gets to arrive, and a timer that slips because the room is building is
  // a timer doing its job. What it starts runs on the compositor regardless.
  let rideStart = 0
  const onReady = () => {
    const waited = performance.now() - rideStart
    if (waited >= MIN_RIDE_MS) open()
    else window.setTimeout(open, MIN_RIDE_MS - waited)
  }
  window.addEventListener(OS_SCENE_READY_EVENT, onReady)

  // the far side is only asked for once the ink has met in the middle, so the
  // whole cold boot happens under a screen that is already black
  window.setTimeout(() => {
    cover.hold()
    rideStart = performance.now()
    window.setTimeout(open, MAX_RIDE_MS) // open() is idempotent; nothing to cancel
    requestAnimationFrame(() => {
      if (running) boot()
    })
  }, CLOSE_MS)
}
