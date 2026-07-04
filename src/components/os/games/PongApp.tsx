import { useEffect, useRef, useState } from 'react'
import { sounds } from '../sounds'
import { useLeaderboard } from './arcade'
import { GameShell, Led, XP_BTN } from './ui'

/*
  Pong for AlejOS, survival flavored. You hold the left paddle against the
  machine: every ball past the CPU is a point, three balls past you and the
  run is over. The ball gains pace on each touch and the CPU reads returns
  better as your score climbs, so every run tightens until it snaps.
*/

const W = 640
const H = 400
const PAD_W = 10
const PAD_H = 64
const PAD_X = 24 // paddle inset from its wall
const BALL_R = 6
const PL_FACE = PAD_X + PAD_W + BALL_R // ball-center x when it kisses your paddle
const CPU_FACE = W - PAD_X - PAD_W - BALL_R
const BALL_SPEED = 300 // px/s at the first serve
const SERVE_SPEED_MAX = 480 // later serves start hotter, but not unfair
const BALL_SPEED_MAX = 780
const SPEEDUP = 1.04 // per paddle touch
const KEY_SPEED = PAD_H * 6.5 // keyboard travel in px/s
const MAX_BOUNCE = Math.PI / 3 // steepest angle off a paddle edge
const SERVE_DELAY = 0.9 // breath between a point and the next launch
const LIVES = 3
const STEP_MAX = 1 / 30 // clamp dt so a hitchy frame can't tunnel the ball

type Phase = 'ready' | 'serve' | 'play' | 'over'

interface Sim {
  phase: Phase
  paused: boolean
  /** seconds left before a queued serve launches */
  clock: number
  /** where the next serve goes; the loser of the last point receives */
  dir: 1 | -1
  py: number
  cy: number
  /** cpu aim error for the current return, re-rolled every time you hit */
  cerr: number
  bx: number
  by: number
  vx: number
  vy: number
  speed: number
  score: number
  lives: number
  improved: boolean
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// the cpu misjudges each return a little; the misjudgment shrinks with score
function aimError(score: number): number {
  return (Math.random() * 2 - 1) * Math.max(8, 46 - score * 1.5)
}

function cpuSpeed(score: number): number {
  return Math.min(440, 235 + score * 8)
}

function freshSim(): Sim {
  return {
    phase: 'ready',
    paused: false,
    clock: 0,
    dir: -1, // you receive the opening serve
    py: H / 2,
    cy: H / 2,
    cerr: 0,
    bx: W / 2,
    by: H / 2,
    vx: 0,
    vy: 0,
    speed: BALL_SPEED,
    score: 0,
    lives: LIVES,
    improved: false,
  }
}

function toServe(sim: Sim, dir: 1 | -1) {
  sim.phase = 'serve'
  sim.dir = dir
  sim.clock = SERVE_DELAY
  sim.bx = W / 2
  sim.by = H / 2
  sim.vx = 0
  sim.vy = 0
}

function launch(sim: Sim) {
  sim.speed = Math.min(SERVE_SPEED_MAX, BALL_SPEED + sim.score * 5)
  const a = (Math.random() * 2 - 1) * 0.45
  sim.vx = Math.cos(a) * sim.speed * sim.dir
  sim.vy = Math.sin(a) * sim.speed
  sim.cerr = aimError(sim.score)
  sim.phase = 'play'
}

export function PongApp() {
  const { name, best, submit } = useLeaderboard('pong')
  const [ui, setUi] = useState({ score: 0, lives: LIVES })
  const simRef = useRef<Sim>(freshSim())
  const keysRef = useRef({ up: false, down: false })
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // the rAF loop lives for the whole window; it reaches the latest submit
  // and best through refs instead of restarting on every render
  const submitRef = useRef(submit)
  const bestRef = useRef(best)
  useEffect(() => {
    submitRef.current = submit
    bestRef.current = best
  })

  useEffect(() => {
    wrapRef.current?.focus()
  }, [])

  // losing the window (blur, hidden tab, another app focused) freezes the
  // rally instead of letting the cpu farm your lives off-screen
  useEffect(() => {
    const pause = () => {
      keysRef.current.up = false
      keysRef.current.down = false
      const sim = simRef.current
      if (sim.phase === 'serve' || sim.phase === 'play') sim.paused = true
    }
    const onVis = () => {
      if (document.hidden) pause()
    }
    window.addEventListener('blur', pause)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('blur', pause)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const g = canvas.getContext('2d')
    if (!g) return

    const fit = () => {
      const rect = wrap.getBoundingClientRect()
      const scale = Math.min((rect.width - 24) / W, (rect.height - 24) / H)
      if (scale <= 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.style.width = `${Math.round(W * scale)}px`
      canvas.style.height = `${Math.round(H * scale)}px`
      canvas.width = Math.round(W * scale * dpr)
      canvas.height = Math.round(H * scale * dpr)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)
    fit()

    const movePaddles = (sim: Sim, dt: number) => {
      const keys = keysRef.current
      const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0)
      if (dy !== 0) sim.py = clamp(sim.py + dy * KEY_SPEED * dt, PAD_H / 2, H - PAD_H / 2)
      // the cpu chases only while the ball comes at it, otherwise re-centers
      const chasing = sim.phase === 'play' && sim.vx > 0
      const target = chasing ? clamp(sim.by + sim.cerr, PAD_H / 2, H - PAD_H / 2) : H / 2
      const most = cpuSpeed(sim.score) * dt
      sim.cy += clamp(target - sim.cy, -most, most)
    }

    const endRun = (sim: Sim) => {
      sim.phase = 'over'
      sim.improved = sim.score > 0 && sim.score > (bestRef.current ?? 0)
      if (sim.improved) sounds.fanfare()
      if (sim.score > 0) void submitRef.current(sim.score)
    }

    const step = (sim: Sim, dt: number) => {
      movePaddles(sim, dt)
      const px = sim.bx
      const py = sim.by
      sim.bx += sim.vx * dt
      sim.by += sim.vy * dt
      if (sim.by < BALL_R) {
        sim.by = BALL_R * 2 - sim.by
        sim.vy = Math.abs(sim.vy)
      } else if (sim.by > H - BALL_R) {
        sim.by = (H - BALL_R) * 2 - sim.by
        sim.vy = -Math.abs(sim.vy)
      }
      // swept face checks, so a hot ball can't jump through a paddle in one frame
      if (sim.vx < 0 && px >= PL_FACE && sim.bx < PL_FACE) {
        const t = (px - PL_FACE) / (px - sim.bx)
        const yAt = py + (sim.by - py) * t
        if (Math.abs(yAt - sim.py) <= PAD_H / 2 + BALL_R) {
          const rel = clamp((yAt - sim.py) / (PAD_H / 2 + BALL_R), -1, 1)
          const a = rel * MAX_BOUNCE
          sim.speed = Math.min(BALL_SPEED_MAX, sim.speed * SPEEDUP)
          sim.vx = Math.cos(a) * sim.speed
          sim.vy = Math.sin(a) * sim.speed
          sim.bx = PL_FACE
          sim.by = yAt
          sim.cerr = aimError(sim.score)
          sounds.blip()
        }
      } else if (sim.vx > 0 && px <= CPU_FACE && sim.bx > CPU_FACE) {
        const t = (CPU_FACE - px) / (sim.bx - px)
        const yAt = py + (sim.by - py) * t
        if (Math.abs(yAt - sim.cy) <= PAD_H / 2 + BALL_R) {
          const rel = clamp((yAt - sim.cy) / (PAD_H / 2 + BALL_R), -1, 1)
          const a = rel * MAX_BOUNCE
          sim.speed = Math.min(BALL_SPEED_MAX, sim.speed * SPEEDUP)
          sim.vx = -Math.cos(a) * sim.speed
          sim.vy = Math.sin(a) * sim.speed
          sim.bx = CPU_FACE
          sim.by = yAt
          sounds.blip()
        }
      }
      if (sim.bx > W + BALL_R * 4) {
        sim.score += 1
        sounds.point()
        toServe(sim, 1)
        setUi({ score: sim.score, lives: sim.lives })
      } else if (sim.bx < -BALL_R * 4) {
        sim.lives -= 1
        sounds.miss()
        if (sim.lives <= 0) endRun(sim)
        else toServe(sim, -1)
        setUi({ score: sim.score, lives: sim.lives })
      }
    }

    const label = (text: string, y: number, size: number, color: string) => {
      g.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`
      g.fillStyle = color
      g.fillText(text, W / 2, y)
    }

    const draw = (sim: Sim, now: number) => {
      g.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0)
      g.fillStyle = '#0c0a09'
      g.fillRect(0, 0, W, H)
      g.strokeStyle = 'rgba(231, 229, 228, 0.22)'
      g.lineWidth = 2
      g.setLineDash([8, 10])
      g.beginPath()
      g.moveTo(W / 2, 4)
      g.lineTo(W / 2, H - 4)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = '#e7e5e4'
      g.fillRect(PAD_X, sim.py - PAD_H / 2, PAD_W, PAD_H)
      g.fillRect(W - PAD_X - PAD_W, sim.cy - PAD_H / 2, PAD_W, PAD_H)
      if (sim.phase !== 'over') {
        g.save()
        g.shadowColor = 'rgba(250, 250, 249, 0.65)'
        g.shadowBlur = 12
        g.fillStyle = '#fafaf9'
        g.beginPath()
        g.arc(sim.bx, sim.by, BALL_R, 0, Math.PI * 2)
        g.fill()
        g.restore()
      }
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      if (sim.phase === 'ready') {
        const pulse = 0.55 + 0.2 * Math.sin(now / 450)
        label('click or press space to serve', H / 2 + 48, 14, `rgba(231, 229, 228, ${pulse})`)
      } else if (sim.paused) {
        g.fillStyle = 'rgba(12, 10, 9, 0.6)'
        g.fillRect(0, 0, W, H)
        label('paused', H / 2 - 14, 22, 'rgba(231, 229, 228, 0.95)')
        label('click or press space to resume', H / 2 + 18, 13, 'rgba(231, 229, 228, 0.65)')
      } else if (sim.phase === 'over') {
        g.fillStyle = 'rgba(12, 10, 9, 0.6)'
        g.fillRect(0, 0, W, H)
        label('game over', H / 2 - 46, 24, 'rgba(231, 229, 228, 0.95)')
        const points = sim.score === 1 ? '1 point' : `${sim.score} points`
        label(points, H / 2 - 12, 15, 'rgba(231, 229, 228, 0.85)')
        if (sim.improved) label('new personal best', H / 2 + 14, 13, 'rgba(252, 211, 77, 0.9)')
        label('click or press space for a new game', H / 2 + 46, 13, 'rgba(231, 229, 228, 0.6)')
      }
    }

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(STEP_MAX, (now - last) / 1000)
      last = now
      const sim = simRef.current
      if (!sim.paused) {
        if (sim.phase === 'ready' || sim.phase === 'serve') movePaddles(sim, dt)
        if (sim.phase === 'serve') {
          sim.clock -= dt
          if (sim.clock <= 0) launch(sim)
        } else if (sim.phase === 'play') {
          step(sim, dt)
        }
      }
      draw(sim, now)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  const action = () => {
    const sim = simRef.current
    if (sim.paused) {
      sim.paused = false
      return
    }
    if (sim.phase === 'ready') {
      toServe(sim, sim.dir)
      sim.clock = 0.5
      return
    }
    if (sim.phase === 'over') {
      const next = freshSim()
      toServe(next, -1)
      simRef.current = next
      setUi({ score: 0, lives: LIVES })
    }
  }

  const newGame = () => {
    sounds.click()
    simRef.current = freshSim()
    setUi({ score: 0, lives: LIVES })
    wrapRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      keysRef.current.up = true
      e.preventDefault()
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      keysRef.current.down = true
      e.preventDefault()
    } else if (k === ' ') {
      action()
      e.preventDefault()
    }
  }

  const onKeyUp = (e: React.KeyboardEvent) => {
    const k = e.key
    if (k === 'ArrowUp' || k === 'w' || k === 'W') keysRef.current.up = false
    else if (k === 'ArrowDown' || k === 's' || k === 'S') keysRef.current.down = false
  }

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.height === 0) return
    const y = ((e.clientY - rect.top) / rect.height) * H
    simRef.current.py = clamp(y, PAD_H / 2, H - PAD_H / 2)
  }

  return (
    <GameShell
      tabs={[{ id: 'pong', label: 'Pong' }]}
      you={name}
      header={
        <>
          <span className="flex items-center gap-1">
            <Led value={String(ui.score)} label="Points" />
            <span className="text-[10px] text-stone-500">pts</span>
          </span>
          <span className="flex items-center gap-1">
            <Led value={String(ui.lives)} label="Balls left" />
            <span className="text-[10px] text-stone-500">balls</span>
          </span>
          <span className="flex items-center gap-1">
            <Led value={String(best ?? 0)} label="Personal best" />
            <span className="text-[10px] text-stone-500">best</span>
          </span>
          <button
            type="button"
            onClick={newGame}
            className={`${XP_BTN} px-2 py-1 text-[11px] font-medium text-stone-700`}
          >
            New Game
          </button>
        </>
      }
      hint="mouse or w/s move · space serves · click to focus"
    >
      <div
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => {
          // a keyup we never hear (focus moved to another window) would leave
          // the paddle drifting forever
          keysRef.current.up = false
          keysRef.current.down = false
        }}
        onClick={() => {
          wrapRef.current?.focus()
          action()
        }}
        className="flex h-full items-center justify-center outline-none"
      >
        <canvas
          ref={canvasRef}
          aria-label="Pong court"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          className="touch-none rounded-sm"
        />
      </div>
    </GameShell>
  )
}
