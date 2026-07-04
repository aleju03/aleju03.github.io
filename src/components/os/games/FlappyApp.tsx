import { useCallback, useEffect, useRef, useState } from 'react'
import { sounds } from '../sounds'
import { useLeaderboard } from './arcade'
import { GameShell, Led, XP_BTN } from './ui'

/*
  Flappy for AlejOS. One bird, one button, and a scrolling slice of the
  Bliss wallpaper: blue sky, drifting clouds, rolling hills and a grass
  strip. The whole game lives on one canvas at a fixed logical size and
  scales to whatever the window gives it.
*/

const W = 360
const H = 480
const GROUND_H = 56
const HORIZON = H - GROUND_H

const BIRD_X = W * 0.28
const BIRD_R = 12
const HIT_R = 9.5 // a touch smaller than the drawing, so near misses feel fair

const GRAVITY = 1400
const FLAP_VY = -380
const MAX_FALL = 520

const PIPE_W = 52
const LIP_H = 20
const PIPE_EVERY = 1.5
const GAP_START = 150
const GAP_MIN = 118
const SPEED_START = 130
const SPEED_MAX = 160

type Phase = 'ready' | 'flying' | 'paused' | 'dying' | 'dead'

interface Pipe {
  x: number
  gapY: number
  gap: number
  passed: boolean
}

interface Cloud {
  x: number
  y: number
  s: number
  v: number
}

interface World {
  phase: Phase
  t: number
  y: number
  vy: number
  rot: number
  pipes: Pipe[]
  spawnIn: number
  score: number
  /** white impact flash, 1 at the hit and fading fast */
  flash: number
  newBest: boolean
  clouds: Cloud[]
  hillOff: number
  groundOff: number
}

function makeWorld(): World {
  return {
    phase: 'ready',
    t: 0,
    y: H * 0.44,
    vy: 0,
    rot: 0,
    pipes: [],
    spawnIn: 1.3,
    score: 0,
    flash: 0,
    newBest: false,
    clouds: Array.from({ length: 3 }, (_, i) => ({
      x: Math.random() * W,
      y: 36 + i * 40 + Math.random() * 16,
      s: 0.75 + Math.random() * 0.5,
      v: 7 + Math.random() * 8,
    })),
    hillOff: 0,
    groundOff: 0,
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const pad3 = (n: number) => String(clamp(n, 0, 999)).padStart(3, '0')

// the gap tightens and the world speeds up as the score climbs
const gapAt = (score: number) => GAP_START - (GAP_START - GAP_MIN) * Math.min(score / 25, 1)
const speedAt = (score: number) =>
  SPEED_START + (SPEED_MAX - SPEED_START) * Math.min(score / 30, 1)

function hitsRect(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const nx = clamp(cx, rx, rx + rw)
  const ny = clamp(cy, ry, ry + rh)
  const dx = cx - nx
  const dy = cy - ny
  return dx * dx + dy * dy < r * r
}

const FONT = '"Trebuchet MS", Verdana, sans-serif'

export function FlappyApp() {
  const { name, best, submit } = useLeaderboard('flappy')
  const [scoreUi, setScoreUi] = useState(0)
  const [phaseUi, setPhaseUi] = useState<Phase>('ready')
  const [view, setView] = useState({ w: W, h: H })

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const worldRef = useRef<World>(makeWorld())
  const bestRef = useRef(best)
  const submitRef = useRef(submit)

  useEffect(() => {
    bestRef.current = best
  }, [best])
  useEffect(() => {
    submitRef.current = submit
  }, [submit])

  const flap = useCallback(() => {
    const w = worldRef.current
    if (w.phase !== 'ready' && w.phase !== 'flying' && w.phase !== 'paused') return
    if (w.phase !== 'flying') {
      w.phase = 'flying'
      setPhaseUi('flying')
    }
    w.vy = FLAP_VY
    sounds.blip()
  }, [])

  const pauseRun = useCallback(() => {
    const w = worldRef.current
    if (w.phase !== 'flying') return
    w.phase = 'paused'
    setPhaseUi('paused')
  }, [])

  const restart = () => {
    sounds.click()
    worldRef.current = makeWorld()
    setScoreUi(0)
    setPhaseUi('ready')
    wrapRef.current?.focus()
  }

  useEffect(() => {
    wrapRef.current?.focus()
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    const die = (w: World, cause: 'pipe' | 'ground') => {
      sounds.thud()
      w.phase = 'dying'
      setPhaseUi('dying')
      w.flash = 1
      // a pipe hit pops the bird back before the tumble; the ground just stops it
      w.vy = cause === 'pipe' ? -140 : 0
      const prev = bestRef.current
      w.newBest = w.score > 0 && (prev === null || w.score > prev)
      if (w.score > 0) void submitRef.current(w.score)
    }

    const step = (dt: number) => {
      const w = worldRef.current
      w.t += dt
      if (w.phase === 'ready' || w.phase === 'flying') {
        const speed = speedAt(w.score)
        w.groundOff += speed * dt
        w.hillOff += speed * 0.3 * dt
        for (const c of w.clouds) {
          c.x -= c.v * dt
          if (c.x < -70) {
            c.x = W + 60
            c.y = 30 + Math.random() * 110
          }
        }
      }
      if (w.phase === 'ready') {
        w.y = H * 0.44 + Math.sin(w.t * 3.2) * 6
        w.rot = 0
        return
      }
      if (w.phase === 'flying') {
        w.vy = Math.min(w.vy + GRAVITY * dt, MAX_FALL)
        w.y += w.vy * dt
        if (w.y < BIRD_R) {
          w.y = BIRD_R
          w.vy = 0
        }
        w.rot = clamp(w.vy * 0.0024, -0.38, 1.25)
        w.spawnIn -= dt
        if (w.spawnIn <= 0) {
          w.spawnIn += PIPE_EVERY
          const gap = gapAt(w.score)
          const lo = gap / 2 + 34
          const hi = HORIZON - gap / 2 - 30
          w.pipes.push({ x: W + PIPE_W, gapY: lo + Math.random() * (hi - lo), gap, passed: false })
        }
        const speed = speedAt(w.score)
        for (const p of w.pipes) p.x -= speed * dt
        if (w.pipes.length > 0 && w.pipes[0].x < -PIPE_W - 8) w.pipes.shift()
        for (const p of w.pipes) {
          if (!p.passed && p.x + PIPE_W < BIRD_X) {
            p.passed = true
            w.score += 1
            setScoreUi(w.score)
            sounds.point()
          }
        }
        if (w.y + HIT_R >= HORIZON) {
          w.y = HORIZON - HIT_R
          die(w, 'ground')
          return
        }
        for (const p of w.pipes) {
          const topH = p.gapY - p.gap / 2
          const botY = p.gapY + p.gap / 2
          if (
            hitsRect(BIRD_X, w.y, HIT_R, p.x, 0, PIPE_W, topH) ||
            hitsRect(BIRD_X, w.y, HIT_R, p.x, botY, PIPE_W, H - botY)
          ) {
            die(w, 'pipe')
            return
          }
        }
        return
      }
      if (w.phase === 'dying') {
        w.flash = Math.max(0, w.flash - dt * 10)
        w.vy = Math.min(w.vy + GRAVITY * dt, MAX_FALL * 1.15)
        w.y += w.vy * dt
        w.rot = Math.min(w.rot + dt * 6, Math.PI / 2)
        if (w.y >= HORIZON - BIRD_R * 0.6) {
          w.y = HORIZON - BIRD_R * 0.6
          w.phase = 'dead'
          setPhaseUi('dead')
          if (w.newBest) sounds.fanfare()
        }
        return
      }
      if (w.phase === 'dead') w.flash = Math.max(0, w.flash - dt * 10)
    }

    const drawCloud = (c: Cloud) => {
      ctx.save()
      ctx.translate(c.x, c.y)
      ctx.scale(c.s, c.s)
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.beginPath()
      ctx.arc(0, 0, 16, 0, Math.PI * 2)
      ctx.arc(18, -7, 13, 0, Math.PI * 2)
      ctx.arc(34, 0, 15, 0, Math.PI * 2)
      ctx.arc(17, 6, 14, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    const drawHills = (off: number, base: number, amp: number, wl: number, color: string) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(0, HORIZON)
      for (let x = 0; x <= W; x += 6) {
        const y =
          base +
          Math.sin((x + off) / wl) * amp +
          Math.sin((x + off) / (wl * 0.41) + 1.7) * amp * 0.35
        ctx.lineTo(x, y)
      }
      ctx.lineTo(W, HORIZON)
      ctx.closePath()
      ctx.fill()
    }

    const pipeGrad = (x: number, width: number) => {
      const g = ctx.createLinearGradient(x, 0, x + width, 0)
      g.addColorStop(0, '#2e7d24')
      g.addColorStop(0.22, '#8fd45f')
      g.addColorStop(0.5, '#57ad3c')
      g.addColorStop(1, '#245a1b')
      return g
    }

    const drawPipe = (p: Pipe) => {
      const topH = p.gapY - p.gap / 2
      const botY = p.gapY + p.gap / 2
      ctx.fillStyle = pipeGrad(p.x, PIPE_W)
      ctx.fillRect(p.x, 0, PIPE_W, topH - LIP_H)
      ctx.fillRect(p.x, botY + LIP_H, PIPE_W, H - botY - LIP_H)
      ctx.fillStyle = pipeGrad(p.x - 4, PIPE_W + 8)
      ctx.fillRect(p.x - 4, topH - LIP_H, PIPE_W + 8, LIP_H)
      ctx.fillRect(p.x - 4, botY, PIPE_W + 8, LIP_H)
      ctx.strokeStyle = 'rgba(20,50,14,0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(p.x - 3.5, topH - LIP_H + 0.5, PIPE_W + 7, LIP_H - 1)
      ctx.strokeRect(p.x - 3.5, botY + 0.5, PIPE_W + 7, LIP_H - 1)
    }

    const drawBird = (w: World) => {
      const flapping = w.phase === 'ready' || w.phase === 'flying' || w.phase === 'paused'
      const wingUp = flapping && Math.floor(w.t / (w.phase === 'flying' ? 0.11 : 0.22)) % 2 === 0
      ctx.save()
      ctx.translate(BIRD_X, w.y)
      ctx.rotate(w.rot)
      ctx.fillStyle = '#f6c81c'
      ctx.beginPath()
      ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fdf0cd'
      ctx.beginPath()
      ctx.arc(3, 4.5, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#e0a90c'
      ctx.beginPath()
      ctx.ellipse(-4, wingUp ? -3 : 3, 6.5, 4, wingUp ? -0.5 : 0.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#f0821e'
      ctx.beginPath()
      ctx.moveTo(9, -2)
      ctx.lineTo(17, 0.5)
      ctx.lineTo(9, 3.5)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(5, -4, 3.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#232323'
      ctx.beginPath()
      ctx.arc(6.2, -4, 1.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    const centerText = (text: string, y: number, font: string, fill: string, halo = false) => {
      ctx.font = font
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      if (halo) {
        ctx.strokeStyle = 'rgba(30,70,110,0.55)'
        ctx.lineWidth = 3
        ctx.strokeText(text, W / 2, y)
      }
      ctx.fillStyle = fill
      ctx.fillText(text, W / 2, y)
    }

    const render = () => {
      const w = worldRef.current
      const sky = ctx.createLinearGradient(0, 0, 0, HORIZON)
      sky.addColorStop(0, '#3d84d4')
      sky.addColorStop(0.55, '#7db8e8')
      sky.addColorStop(1, '#cbe6f5')
      ctx.fillStyle = sky
      ctx.fillRect(0, 0, W, H)
      for (const c of w.clouds) drawCloud(c)
      drawHills(w.hillOff * 0.55, HORIZON - 30, 15, 92, '#8cbf68')
      drawHills(w.hillOff, HORIZON - 12, 11, 57, '#639e3d')
      for (const p of w.pipes) drawPipe(p)
      ctx.fillStyle = '#549632'
      ctx.fillRect(0, HORIZON, W, GROUND_H)
      ctx.fillStyle = 'rgba(0,0,0,0.08)'
      for (let x = -(w.groundOff % 44) - 44; x < W; x += 44) {
        ctx.beginPath()
        ctx.moveTo(x, HORIZON)
        ctx.lineTo(x + 22, HORIZON)
        ctx.lineTo(x + 12, H)
        ctx.lineTo(x - 10, H)
        ctx.closePath()
        ctx.fill()
      }
      ctx.fillStyle = '#79c14b'
      ctx.fillRect(0, HORIZON, W, 4)
      ctx.fillStyle = 'rgba(31,74,18,0.55)'
      ctx.fillRect(0, HORIZON + 4, W, 1.5)
      drawBird(w)

      if (w.phase === 'ready') {
        centerText('get ready', H * 0.27, `bold 22px ${FONT}`, '#ffffff', true)
        centerText(
          'space or tap to flap',
          H * 0.27 + 26,
          `12px ${FONT}`,
          'rgba(255,255,255,0.95)',
          true,
        )
      }

      if (w.phase === 'dead') {
        const cw = 232
        const ch = w.newBest ? 148 : 124
        const cx = (W - cw) / 2
        const cy = H * 0.26
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.25)'
        ctx.shadowBlur = 10
        ctx.shadowOffsetY = 3
        ctx.fillStyle = '#f5f5f4'
        ctx.beginPath()
        ctx.roundRect(cx, cy, cw, ch, 6)
        ctx.fill()
        ctx.restore()
        ctx.strokeStyle = '#a8a29e'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1, 6)
        ctx.stroke()
        const shownBest = w.newBest ? w.score : Math.max(bestRef.current ?? 0, 0)
        centerText('game over', cy + 32, `bold 20px ${FONT}`, '#44403c')
        centerText(`score ${w.score}`, cy + 62, `14px ${FONT}`, '#57534e')
        centerText(`best ${shownBest}`, cy + 84, `14px ${FONT}`, '#57534e')
        if (w.newBest) centerText('new best!', cy + 114, `bold 14px ${FONT}`, '#b45309')
      }

      if (w.phase === 'paused') {
        ctx.fillStyle = 'rgba(28,25,23,0.4)'
        ctx.fillRect(0, 0, W, H)
        centerText('paused', H * 0.42, `bold 20px ${FONT}`, '#ffffff')
        centerText(
          'space or tap to resume',
          H * 0.42 + 26,
          `12px ${FONT}`,
          'rgba(255,255,255,0.9)',
        )
      }

      if (w.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${(0.85 * w.flash).toFixed(3)})`
        ctx.fillRect(0, 0, W, H)
      }
    }

    const fit = () => {
      const scale = Math.max(
        0.4,
        Math.min((wrap.clientWidth - 12) / W, (wrap.clientHeight - 12) / H),
      )
      const cssW = Math.floor(W * scale)
      const cssH = Math.floor(H * scale)
      setView({ w: cssW, h: cssH })
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(cssW * dpr))
      canvas.height = Math.max(1, Math.round(cssH * dpr))
      ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0)
      render()
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)

    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30)
      last = now
      step(dt)
      render()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    // losing the page mid-run freezes the game instead of killing the bird;
    // render once synchronously because rAF stops while the tab is hidden
    const onWindowBlur = () => {
      pauseRun()
      render()
    }
    const onVisibility = () => {
      if (document.hidden) {
        pauseRun()
        render()
      }
    }
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pauseRun])

  return (
    <GameShell
      tabs={[{ id: 'flappy', label: 'Flappy' }]}
      you={name}
      header={
        <>
          <span className="text-[11px] text-stone-500">score</span>
          <Led value={pad3(scoreUi)} label="Score" />
          <span className="ml-1 text-[11px] text-stone-500">best</span>
          <Led value={pad3(best ?? 0)} label="Best" />
        </>
      }
      hint="space or tap flaps"
    >
      <div
        ref={wrapRef}
        tabIndex={0}
        className="flex h-full items-center justify-center p-1.5 outline-none select-none"
        onBlur={pauseRun}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!e.repeat) flap()
          }
        }}
      >
        <div
          className="relative overflow-hidden rounded-sm ring-1 ring-stone-400"
          style={{ width: view.w, height: view.h }}
        >
          <canvas
            ref={canvasRef}
            className="block h-full w-full touch-none"
            onPointerDown={() => {
              wrapRef.current?.focus()
              flap()
            }}
          />
          {phaseUi === 'dead' && (
            <div className="absolute inset-x-0 flex justify-center" style={{ top: '60%' }}>
              <button
                type="button"
                onClick={restart}
                className={`${XP_BTN} px-4 py-1.5 text-xs font-medium text-stone-700`}
              >
                Play again
              </button>
            </div>
          )}
        </div>
      </div>
    </GameShell>
  )
}
