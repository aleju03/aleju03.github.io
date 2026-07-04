import { BOOT_OS_EVENT, OS_SCENE_READY_EVENT } from './events'

/*
  The trip between worlds. Clicking the wreck (or letting it swallow the
  paper plane) doesn't hard-cut into AlejOS: a wormhole opens OUT of the
  dead glass and eats the page. It's a fullscreen 2D canvas anchored on the
  wreck's screen, inked in the site's stone palette with the contrail's
  blue as the accent, and it plays in three acts. First the mouth: a hole
  pops open to about the size of the glass and holds there while a shock
  ring bursts off it and outer rings fall back in — unmistakably the PC's
  doing. Then the tear: a crisp circular front (the theme toggle's wipe,
  with teeth) accelerates over the still-visible page until it has consumed
  the whole viewport. Then the ride: the boot event fires under the black
  and the tunnel keeps streaming past, picking up speed, for as long as the
  far side needs to raise its first frame — the 3D room builds its whole
  house under this cover. When the scene announces itself (or immediately
  after the minimum ride, if it was already up), the exit tears open FROM
  the machine's spot in the room and slings you out in front of it.

  BlockName owns the wreck's 3D layout, so it registers a provider for the
  glass's live viewport spot and size; anyone can then call warpToOs() and
  the hole opens exactly where the plane gets pulled in. Without the
  provider (or the 3D scene) the wreck's stage element anchors it instead.
  The exit anchor arrives on OS_SCENE_READY_EVENT: CrtScene projects its
  glass to viewport pixels, the flat bezel just says "center".
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
// the ride lasts at least this long past the cover, so the trip always
// reads as a trip even when the far side was ready before we left
const MIN_RIDE_S = 0.75
// and never longer than this: a scene that never answers still gets revealed
const MAX_RIDE_S = 12
const EXIT_S = 0.85 // the far mouth opening onto the room

const INK = '#0c0a09' // stone-950, same night the OS overlay sits on
const STONE = '168,162,158' // stone-400
const ACCENT = '96,165,250' // blue-400, the plane's contrail blue

export function warpToOs(detail?: { app?: string }) {
  if (running) return
  // the ride hides the heavy lifting: start pulling the OS chunk now, and
  // the 3D scene too on the screens that will actually mount it, so the
  // tunnel only has to cover the models, not the code
  void import('./components/os/AlejOS')
  if (
    window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    window.innerWidth >= 640
  ) {
    void import('./components/os/CrtScene')
  }
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

  // the far side fills these in: its first rendered frame says "open here"
  let sceneReady = false
  let exit: Mouth | null = null
  const onReady = (e: Event) => {
    sceneReady = true
    const d = (e as CustomEvent<Partial<Mouth> | undefined>).detail
    if (d && typeof d.x === 'number' && typeof d.y === 'number') {
      exit = { x: d.x, y: d.y, r: typeof d.r === 'number' ? d.r : 60 }
    }
  }
  window.addEventListener(OS_SCENE_READY_EVENT, onReady)

  const t0 = performance.now()
  let last = t0
  let booted = false
  let travel = 0 // tunnel distance, integrated so the ride can accelerate
  let exitAt: number | null = null // ride time when the far mouth opened
  const circle = (x: number, y: number, r: number) => {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
  }
  const finish = () => {
    cv.remove()
    window.removeEventListener(OS_SCENE_READY_EVENT, onReady)
    running = false
  }
  const frame = (now: number) => {
    const t = (now - t0) / 1000
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const p = Math.min(1, t / COVER_S)
    if (p >= 1 && !booted) {
      // the page is gone; boot the machine under the black and let the far
      // side build its scene in peace behind the tunnel
      booted = true
      boot()
    }
    // the ride ends when the far side has a frame up (never before the
    // minimum, never after the bail cap)
    if (exitAt === null && t >= COVER_S + MIN_RIDE_S && (sceneReady || t >= COVER_S + MAX_RIDE_S)) {
      exitAt = t
    }
    const q = exitAt === null ? 0 : Math.min(1, (t - exitAt) / EXIT_S)
    if (q >= 1) {
      finish()
      return
    }
    // cruise builds after the tear; the opening exit slings you out faster
    const cruise = Math.min(1, Math.max(0, (t - COVER_S) / 0.9))
    travel += dt * (0.5 + cruise * 1.0 + q * 1.6)

    ctx.clearRect(0, 0, W, H)

    // act one: the mouth pops open to the glass size and holds; act two:
    // the tear, a cubic ramp from glass size to the whole viewport. The
    // page stays untouched outside the front — the consuming reads like
    // the theme toggle's wipe, not a fade
    const discR =
      t < MOUTH_S
        ? Math.max(6, mouthR * (1 - Math.pow(1 - t / MOUTH_S, 3)))
        : mouthR + (maxR - mouthR) * Math.pow(Math.min(1, (t - MOUTH_S) / TEAR_S), 3)

    // the exit: a hole cut out of the ink, anchored on the machine in the
    // room (or dead center when the far side is the flat bezel)
    const ex = exit ?? { x: W / 2, y: H / 2, r: 60 }
    const exitMaxR = Math.hypot(Math.max(ex.x, W - ex.x), Math.max(ex.y, H - ex.y)) * 1.06
    const holeR = q > 0 ? exitMaxR * Math.pow(q, 2.4) : 0

    // the cover: hard-edged ink with the far mouth cut out of it
    ctx.fillStyle = INK
    ctx.beginPath()
    ctx.arc(o.x, o.y, discR, 0, Math.PI * 2)
    if (holeR > 0) ctx.arc(ex.x, ex.y, holeR, 0, Math.PI * 2)
    ctx.fill('evenodd')

    // everything below lives inside the ink, never over the opened room
    ctx.save()
    ctx.beginPath()
    ctx.arc(o.x, o.y, discR, 0, Math.PI * 2)
    if (holeR > 0) ctx.arc(ex.x, ex.y, holeR, 0, Math.PI * 2)
    ctx.clip('evenodd')
    // tunnel rings falling toward the center; the pow spacing fakes depth
    for (let i = 0; i < 16; i++) {
      const ph = (((i / 16 - travel) % 1) + 1) % 1
      const r = discR * Math.pow(ph, 2.3)
      if (r < 2) continue
      const a = (1 - ph) * 0.3 * (1 - q)
      ctx.strokeStyle = i % 5 === 0 ? `rgba(${ACCENT},${a})` : `rgba(${STONE},${a * 0.7})`
      ctx.lineWidth = 1 + (1 - ph) * 1.6
      circle(o.x, o.y, r)
      ctx.stroke()
    }
    // the infalling specks, drawn as short streaks pointing down the drain
    ctx.lineWidth = 1.1
    for (const s of specks) {
      const ph = (((s.r - travel * s.fall * 2) % 1) + 1) % 1
      const ang = s.ang + travel * s.swirl * 2 + (1 - ph) * 2.2
      const r = discR * Math.pow(ph, 1.7)
      const a = (1 - ph) * 0.55 * (1 - q)
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
        circle(o.x, o.y, discR + mouthR * 2.4 * (1 - c))
        ctx.stroke()
      }
    }
    // the shock ring of the mouth bursting open, flung off the glass
    if (t < 0.32) {
      const s = t / 0.32
      ctx.strokeStyle = `rgba(${ACCENT},${(1 - s) * 0.55})`
      ctx.lineWidth = 0.5 + 2.5 * (1 - s)
      circle(o.x, o.y, mouthR * (0.3 + 2.4 * s))
      ctx.stroke()
    }
    // a thin blue line rides the entry front while it still has page to eat
    if (p < 1) {
      ctx.strokeStyle = `rgba(${ACCENT},${0.5 * (1 - p * 0.5)})`
      ctx.lineWidth = 1.5
      circle(o.x, o.y, discR)
      ctx.stroke()
    }
    // the first spark: the dead glass lights up before anything moves
    if (t < 0.2) {
      const a = (1 - t / 0.2) * 0.45
      const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, mouthR * 1.4)
      g.addColorStop(0, `rgba(${ACCENT},${a})`)
      g.addColorStop(1, `rgba(${ACCENT},0)`)
      ctx.fillStyle = g
      circle(o.x, o.y, mouthR * 1.4)
      ctx.fill()
    }
    // the far side breaking open: a flash where the tunnel gives way, then
    // a blue front riding the growing mouth — the entry tear, mirrored
    if (exitAt !== null) {
      const f = Math.min(1, (t - exitAt) / 0.3)
      if (f < 1) {
        const a = (1 - f) * 0.5
        const g = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, Math.max(ex.r, 50) * 2.2)
        g.addColorStop(0, `rgba(${ACCENT},${a})`)
        g.addColorStop(1, `rgba(${ACCENT},0)`)
        ctx.fillStyle = g
        circle(ex.x, ex.y, Math.max(ex.r, 50) * 2.2)
        ctx.fill()
      }
      if (holeR > 0) {
        ctx.strokeStyle = `rgba(${ACCENT},${0.6 * (1 - q)})`
        ctx.lineWidth = 1.5 + 2 * (1 - q)
        circle(ex.x, ex.y, holeR)
        ctx.stroke()
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
