/*
  The screensaver, which is the single most "this is a whole machine" thing
  a desktop can do while nobody is touching it: leave AlejOS alone for a few
  minutes and the tube goes to stars.

  Drawn on a canvas at runtime like every other picture in this repo, so it
  ships no bytes. Two savers plus Off, picked in Display Properties, with the
  choice and the idle delay in localStorage next to the wallpaper.

  Three rules it has to keep. It only runs while the desktop is the thing on
  screen — never over the login screen, never while the visitor has stood up
  and walked off into the room, because the OS is not what they are looking
  at then. It stops itself the moment anything is pressed or moved, and the
  input that wakes it is swallowed rather than passed through, so dismissing
  it cannot also click whatever was underneath. And reduced-motion means it
  never starts at all: a full-screen animation is exactly what that setting
  is asking us not to do.
*/

export type SaverId = 'none' | 'starfield' | 'mystify'

export const SAVERS: { id: SaverId; name: string }[] = [
  { id: 'none', name: '(None)' },
  { id: 'starfield', name: 'Starfield' },
  { id: 'mystify', name: 'Mystify' },
]

export const DELAYS = [1, 3, 5, 10, 20] as const

const KEY = 'alejos-screensaver'

interface SaverPrefs {
  id: SaverId
  /** idle minutes before it takes over */
  delay: number
}

const DEFAULTS: SaverPrefs = { id: 'starfield', delay: 5 }

function read(): SaverPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<SaverPrefs>
      return {
        id: SAVERS.some((s) => s.id === v.id) ? (v.id as SaverId) : DEFAULTS.id,
        delay: DELAYS.includes(v.delay as (typeof DELAYS)[number]) ? (v.delay as number) : DEFAULTS.delay,
      }
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return DEFAULTS
}

let prefs = read()
const subs = new Set<() => void>()

export function getSaver(): SaverPrefs {
  return prefs
}

export function subscribeSaver(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function setSaver(next: Partial<SaverPrefs>) {
  prefs = { ...prefs, ...next }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* storage unavailable; the session still works in memory */
  }
  subs.forEach((fn) => fn())
}

// ---------------------------------------------------------------- the savers

interface Star {
  x: number
  y: number
  z: number
}

/**
 * Flying through stars. Each one is a point in front of the camera pushed
 * toward it every frame; the streak is the same point drawn at its previous
 * depth, which is cheaper and steadier than keeping a trail buffer.
 */
function starfield(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const stars: Star[] = Array.from({ length: 260 }, () => ({
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
    z: Math.random(),
  }))
  const speed = 0.0055
  return (dt: number) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    const cx = w / 2
    const cy = h / 2
    const scale = Math.min(w, h) * 0.9
    ctx.strokeStyle = '#fff'
    ctx.lineCap = 'round'
    for (const s of stars) {
      const wasZ = s.z
      s.z -= speed * dt
      if (s.z <= 0.02) {
        s.x = Math.random() * 2 - 1
        s.y = Math.random() * 2 - 1
        s.z = 1
        continue
      }
      const px = cx + (s.x / s.z) * scale * 0.35
      const py = cy + (s.y / s.z) * scale * 0.35
      const qx = cx + (s.x / wasZ) * scale * 0.35
      const qy = cy + (s.y / wasZ) * scale * 0.35
      if (px < -50 || px > w + 50 || py < -50 || py > h + 50) continue
      const near = 1 - s.z
      ctx.globalAlpha = Math.min(1, near * 1.4)
      ctx.lineWidth = Math.max(0.6, near * 2.6)
      ctx.beginPath()
      ctx.moveTo(qx, qy)
      ctx.lineTo(px, py)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
}

interface Corner {
  x: number
  y: number
  vx: number
  vy: number
}

/**
 * Mystify: a polygon whose corners bounce around the screen, redrawn every
 * frame over a slightly faded copy of the last one, so the trail is the
 * fade rather than a list of old polygons.
 */
function mystify(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const shape = (hue: number) => ({
    hue,
    corners: Array.from({ length: 4 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() * 2 - 1) * 0.12,
      vy: (Math.random() * 2 - 1) * 0.12,
    })) as Corner[],
  })
  const shapes = [shape(205), shape(280)]
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  let t = 0
  return (dt: number) => {
    t += dt
    // the fade IS the trail: full black would erase it, no clear would smear
    ctx.fillStyle = 'rgba(0,0,0,0.055)'
    ctx.fillRect(0, 0, w, h)
    ctx.lineWidth = 1.4
    for (const s of shapes) {
      for (const c of s.corners) {
        c.x += c.vx * dt
        c.y += c.vy * dt
        if (c.x < 0 || c.x > w) {
          c.vx *= -1
          c.x = Math.min(w, Math.max(0, c.x))
        }
        if (c.y < 0 || c.y > h) {
          c.vy *= -1
          c.y = Math.min(h, Math.max(0, c.y))
        }
      }
      ctx.strokeStyle = `hsl(${(s.hue + t * 0.02) % 360} 85% 62%)`
      ctx.beginPath()
      s.corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)))
      ctx.closePath()
      ctx.stroke()
    }
  }
}

/**
 * Start a saver on a canvas. Returns the stopper; the caller owns when it
 * runs, this only owns what it looks like.
 */
export function runSaver(canvas: HTMLCanvasElement, id: SaverId): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx || id === 'none') return () => undefined
  // the CRT draws the screen DOM at roughly 1:1, so device pixels here are
  // wasted work on a picture made of moving points
  const w = (canvas.width = canvas.clientWidth || 800)
  const h = (canvas.height = canvas.clientHeight || 600)
  const draw = id === 'mystify' ? mystify(ctx, w, h) : starfield(ctx, w, h)
  let raf = 0
  let last = performance.now()
  const tick = (now: number) => {
    // a tab that was in the background hands back a huge delta; clamping it
    // keeps the stars from jumping the whole field in one frame
    const dt = Math.min(64, now - last)
    last = now
    draw(dt)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}
