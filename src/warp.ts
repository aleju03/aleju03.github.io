import { BOOT_OS_EVENT } from './events'

/*
  The trip between worlds. Clicking the wreck (or letting it swallow the
  paper plane) doesn't hard-cut into AlejOS: a wormhole opens OUT of the
  dead glass and eats the page. It's a fullscreen 2D canvas anchored on the
  wreck's screen, inked in the site's stone palette with the contrail's
  blue as the accent, and it plays in two acts. First the mouth: a hole
  pops open to about the size of the glass and holds there while a shock
  ring bursts off it and outer rings fall back in — unmistakably the PC's
  doing. Then the tear: a crisp circular front (the theme toggle's wipe,
  with teeth) accelerates over the still-visible page until it has
  consumed the whole viewport. The boot event fires under the black, and
  the canvas thins away over the POST screen that is already running.

  BlockName owns the wreck's 3D layout, so it registers a provider for the
  glass's live viewport spot and size; anyone can then call warpToOs() and
  the hole opens exactly where the plane gets pulled in. Without the
  provider (or the 3D scene) the wreck's stage element anchors it instead.
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

const MOUTH_S = 0.45 // the hole popping open to glass size and holding
const TEAR_S = 0.6 // the front sweeping out to consume the page
const COVER_S = MOUTH_S + TEAR_S
const HOLD_S = 0.2 // black held while the OS mounts under the cover
const FADE_S = 0.7 // rings thinning away over the POST screen

const INK = '#0c0a09' // stone-950, same night the OS overlay sits on
const STONE = '168,162,158' // stone-400
const ACCENT = '96,165,250' // blue-400, the plane's contrail blue

export function warpToOs(detail?: { app?: string }) {
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
  const cv = document.createElement('canvas')
  const ctx = cv.getContext('2d')
  if (!ctx) {
    boot()
    return
  }
  running = true
  const W = window.innerWidth
  const H = window.innerHeight
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  cv.width = Math.round(W * dpr)
  cv.height = Math.round(H * dpr)
  cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:70;pointer-events:none'
  cv.setAttribute('aria-hidden', 'true')
  ctx.scale(dpr, dpr)
  document.body.appendChild(cv)

  const stage = document.getElementById('os-wreck')?.getBoundingClientRect()
  const o =
    origin?.() ??
    (stage
      ? { x: stage.left + stage.width * 0.36, y: stage.top + stage.height * 0.5, r: stage.width * 0.18 }
      : { x: W / 2, y: H / 2, r: 60 })
  const mouthR = Math.min(Math.max(o.r, 30), 130)
  // the front must reach the farthest viewport corner to consume everything
  const maxR = Math.hypot(Math.max(o.x, W - o.x), Math.max(o.y, H - o.y)) * 1.06
  // stray matter caught in the pull: each speck loops from the rim down to
  // the center of the tunnel, swirling tighter the closer it gets
  const specks = Array.from({ length: 70 }, () => ({
    ang: Math.random() * Math.PI * 2,
    r: Math.random(),
    fall: 0.35 + Math.random() * 0.5,
    swirl: 0.4 + Math.random() * 1.2,
    blue: Math.random() < 0.22,
  }))

  const t0 = performance.now()
  let booted = false
  const circle = (r: number) => {
    ctx.beginPath()
    ctx.arc(o.x, o.y, r, 0, Math.PI * 2)
  }
  const frame = (now: number) => {
    const t = (now - t0) / 1000
    if (t >= COVER_S + HOLD_S + FADE_S) {
      cv.remove()
      running = false
      return
    }
    ctx.clearRect(0, 0, W, H)
    const p = Math.min(1, t / COVER_S)
    if (p >= 1 && !booted) {
      // the page is gone; boot the machine under the black and let the
      // fade below reveal the POST already in progress
      booted = true
      boot()
    }
    const fade = Math.min(1, Math.max(0, (t - COVER_S - HOLD_S) / FADE_S))
    cv.style.opacity = String(1 - fade * fade)

    // act one: the mouth pops open to the glass size and holds; act two:
    // the tear, a cubic ramp from glass size to the whole viewport. The
    // page stays untouched outside the front — the consuming reads like
    // the theme toggle's wipe, not a fade
    const discR =
      t < MOUTH_S
        ? Math.max(6, mouthR * (1 - Math.pow(1 - t / MOUTH_S, 3)))
        : mouthR + (maxR - mouthR) * Math.pow(Math.min(1, (t - MOUTH_S) / TEAR_S), 3)

    // the hole itself: hard-edged ink, a crisp front eating the page
    ctx.fillStyle = INK
    circle(discR)
    ctx.fill()

    // everything below lives inside the hole
    ctx.save()
    circle(discR)
    ctx.clip()
    // tunnel rings falling toward the center; the pow spacing fakes depth
    for (let i = 0; i < 16; i++) {
      const ph = (((i / 16 - t * 0.5) % 1) + 1) % 1
      const r = discR * Math.pow(ph, 2.3)
      if (r < 2) continue
      const a = (1 - ph) * 0.3
      ctx.strokeStyle = i % 5 === 0 ? `rgba(${ACCENT},${a})` : `rgba(${STONE},${a * 0.7})`
      ctx.lineWidth = 1 + (1 - ph) * 1.6
      circle(r)
      ctx.stroke()
    }
    // the infalling specks, drawn as short streaks pointing down the drain
    ctx.lineWidth = 1.1
    for (const s of specks) {
      const ph = (((s.r - t * s.fall) % 1) + 1) % 1
      const r = discR * Math.pow(ph, 1.7)
      const ang = s.ang + t * s.swirl + (1 - ph) * 2.2
      const a = (1 - ph) * 0.55
      ctx.strokeStyle = s.blue ? `rgba(${ACCENT},${a})` : `rgba(214,211,209,${a * 0.6})`
      ctx.beginPath()
      ctx.moveTo(o.x + Math.cos(ang) * r, o.y + Math.sin(ang) * r)
      ctx.lineTo(o.x + Math.cos(ang - 0.06) * (r * 1.08 + 6), o.y + Math.sin(ang - 0.06) * (r * 1.08 + 6))
      ctx.stroke()
    }
    ctx.restore()

    // outer rings falling INTO the hole, hugging its edge however big it
    // is — the page-side tell that the monitor is doing the pulling
    if (t > 0.16 && p < 1) {
      ctx.lineWidth = 1.1
      for (let i = 0; i < 3; i++) {
        const c = (((t * 0.85 + i / 3) % 1) + 1) % 1
        const a = Math.sin(c * Math.PI) * 0.28
        ctx.strokeStyle = i % 2 ? `rgba(${STONE},${a})` : `rgba(${ACCENT},${a})`
        circle(discR + mouthR * 2.4 * (1 - c))
        ctx.stroke()
      }
    }
    // the shock ring of the mouth bursting open, flung off the glass
    if (t < 0.32) {
      const s = t / 0.32
      ctx.strokeStyle = `rgba(${ACCENT},${(1 - s) * 0.55})`
      ctx.lineWidth = 0.5 + 2.5 * (1 - s)
      circle(mouthR * (0.3 + 2.4 * s))
      ctx.stroke()
    }
    // a thin blue line rides the front while it still has page to eat
    if (p < 1) {
      ctx.strokeStyle = `rgba(${ACCENT},${0.5 * (1 - p * 0.5)})`
      ctx.lineWidth = 1.5
      circle(discR)
      ctx.stroke()
    }
    // the first spark: the dead glass lights up before anything moves
    if (t < 0.2) {
      const a = (1 - t / 0.2) * 0.45
      const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, mouthR * 1.4)
      g.addColorStop(0, `rgba(${ACCENT},${a})`)
      g.addColorStop(1, `rgba(${ACCENT},0)`)
      ctx.fillStyle = g
      circle(mouthR * 1.4)
      ctx.fill()
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
