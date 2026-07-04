import { useCallback, useEffect, useRef, useState } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, CaretUpIcon } from '@phosphor-icons/react'
import { sounds } from '../sounds'
import { useLeaderboard } from './arcade'
import { GameShell, Led, XP_BTN } from './ui'

/*
  Snake for AlejOS. Nokia rules on a 20x20 court: walls kill, every apple
  grows the snake by one and nudges the pace up a notch each five apples.
  Movement is a fixed-step accumulator over requestAnimationFrame so the
  speed stays honest across refresh rates, and steering is a two-deep queue
  so quick corners land on the tick you meant.
*/

const N = 20
const BASE_RATE = 7.5 // cells per second at the start of a run
const RATE_STEP = 0.4 // added every five apples
const MAX_RATE = 14
const SWIPE_PX = 24
const FLASH_MS = 650 // how long the dead head blinks before the panel

type Phase = 'ready' | 'playing' | 'paused' | 'dying' | 'over'

interface Dir {
  x: number
  y: number
}

const UP: Dir = { x: 0, y: -1 }
const DOWN: Dir = { x: 0, y: 1 }
const LEFT: Dir = { x: -1, y: 0 }
const RIGHT: Dir = { x: 1, y: 0 }

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: UP,
  ArrowDown: DOWN,
  ArrowLeft: LEFT,
  ArrowRight: RIGHT,
  w: UP,
  a: LEFT,
  s: DOWN,
  d: RIGHT,
  W: UP,
  A: LEFT,
  S: DOWN,
  D: RIGHT,
}

interface Run {
  /** cell indices (y * N + x), head first */
  snake: number[]
  dir: Dir
  queue: Dir[]
  apple: number
  score: number
  acc: number
  phase: Phase
  /** performance.now() when the run ended, for the head flash */
  diedAt: number
  improved: boolean
}

const at = (x: number, y: number) => y * N + x

const rateFor = (score: number) =>
  Math.min(MAX_RATE, BASE_RATE + RATE_STEP * Math.floor(score / 5))

function spawnApple(snake: number[]): number {
  const taken = new Set(snake)
  const free: number[] = []
  for (let i = 0; i < N * N; i++) if (!taken.has(i)) free.push(i)
  if (free.length === 0) return -1
  return free[Math.floor(Math.random() * free.length)]
}

function freshRun(): Run {
  const mid = Math.floor(N / 2)
  const snake = [at(9, mid), at(8, mid), at(7, mid)]
  return {
    snake,
    dir: RIGHT,
    queue: [],
    apple: spawnApple(snake),
    score: 0,
    acc: 0,
    phase: 'ready',
    diedAt: 0,
    improved: false,
  }
}

/** greens for the body, brightest just behind the head, deep at the tail */
function bodyShade(t: number): string {
  const r = Math.round(86 + (36 - 86) * t)
  const g = Math.round(186 + (106 - 186) * t)
  const b = Math.round(104 + (58 - 104) * t)
  return `rgb(${r}, ${g}, ${b})`
}

const HEAD_COLOR = 'rgb(148, 230, 162)'
const COURT_BG = '#0b140e'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

const pad3 = (n: number) => String(Math.max(0, Math.min(999, n))).padStart(3, '0')

export function SnakeApp() {
  const { name, best, submit } = useLeaderboard('snake')
  const [score, setScore] = useState(0)
  const [phase, setPhase] = useState<Phase>('ready')
  const [coarse] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  )

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const runRef = useRef<Run>(freshRun())
  const sizeRef = useRef(0)
  const bestRef = useRef<number | null>(best)
  const swipeRef = useRef<{ id: number; x: number; y: number; used: boolean } | null>(null)

  useEffect(() => {
    bestRef.current = best
  }, [best])

  const applyPhase = useCallback((p: Phase) => {
    runRef.current.phase = p
    setPhase(p)
  }, [])

  const newGame = useCallback(() => {
    runRef.current = freshRun()
    setScore(0)
    setPhase('ready')
    wrapRef.current?.focus()
  }, [])

  const pushDir = useCallback(
    (d: Dir) => {
      const run = runRef.current
      if (run.phase === 'dying' || run.phase === 'over') return
      const last = run.queue.length > 0 ? run.queue[run.queue.length - 1] : run.dir
      if (d.x === -last.x && d.y === -last.y) return
      // pressing the facing direction still starts a fresh run
      if (run.phase === 'ready') applyPhase('playing')
      if (d.x === last.x && d.y === last.y) return
      if (run.queue.length < 2) run.queue.push(d)
    },
    [applyPhase],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    const dir = KEY_DIRS[e.key]
    if (dir) {
      e.preventDefault()
      pushDir(dir)
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      const p = runRef.current.phase
      if (p === 'over') newGame()
      else if (p === 'playing') applyPhase('paused')
      else if (p === 'paused') applyPhase('playing')
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    wrapRef.current?.focus()
    if (runRef.current.phase === 'paused') {
      applyPhase('playing')
      return
    }
    swipeRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, used: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const s = swipeRef.current
    if (!s || s.id !== e.pointerId || s.used) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return
    s.used = true
    pushDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP)
  }

  const onPointerEnd = (e: React.PointerEvent) => {
    if (swipeRef.current?.id === e.pointerId) swipeRef.current = null
  }

  // a run keeps moving while nobody is looking otherwise
  useEffect(() => {
    const auto = () => {
      if (runRef.current.phase === 'playing') applyPhase('paused')
    }
    const onVis = () => {
      if (document.hidden) auto()
    }
    window.addEventListener('blur', auto)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('blur', auto)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [applyPhase])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const g = canvas?.getContext('2d')
    if (!wrap || !canvas || !g) return

    wrap.focus()

    const ro = new ResizeObserver((entries) => {
      const box = entries[0].contentRect
      const size = Math.floor(Math.min(box.width, box.height))
      if (size <= 0) return
      sizeRef.current = size
      const dpr = window.devicePixelRatio || 1
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
      canvas.width = Math.max(1, Math.round(size * dpr))
      canvas.height = Math.max(1, Math.round(size * dpr))
    })
    ro.observe(wrap)

    const endRun = (run: Run) => {
      run.improved =
        run.score > 0 && (bestRef.current === null || run.score > bestRef.current)
      if (run.score > 0) void submit(run.score)
    }

    const die = (run: Run) => {
      endRun(run)
      run.phase = 'dying'
      run.diedAt = performance.now()
      setPhase('dying')
      sounds.miss()
    }

    const tick = () => {
      const run = runRef.current
      run.dir = run.queue.shift() ?? run.dir
      const head = run.snake[0]
      const hx = (head % N) + run.dir.x
      const hy = Math.floor(head / N) + run.dir.y
      if (hx < 0 || hx >= N || hy < 0 || hy >= N) {
        die(run)
        return
      }
      const next = at(hx, hy)
      const eats = next === run.apple
      // moving into the cell the tail is vacating is legal, classic rules
      const body = eats ? run.snake : run.snake.slice(0, -1)
      if (body.includes(next)) {
        die(run)
        return
      }
      run.snake = [next, ...body]
      if (eats) {
        run.score += 1
        setScore(run.score)
        sounds.point()
        run.apple = spawnApple(run.snake)
        if (run.apple === -1) {
          // the snake filled the whole court, which deserves the fanfare
          endRun(run)
          run.phase = 'over'
          setPhase('over')
          sounds.fanfare()
        }
      }
    }

    const draw = (now: number) => {
      const size = sizeRef.current
      if (size <= 0) return
      const run = runRef.current
      const cell = size / N
      g.setTransform(canvas.width / size, 0, 0, canvas.width / size, 0, 0)

      g.fillStyle = COURT_BG
      g.fillRect(0, 0, size, size)
      g.fillStyle = 'rgba(160, 220, 170, 0.04)'
      for (let y = 0; y < N; y++) {
        for (let x = (y % 2 === 0 ? 1 : 0); x < N; x += 2) {
          g.fillRect(x * cell, y * cell, cell, cell)
        }
      }

      if (run.apple >= 0) {
        const ax = (run.apple % N) * cell
        const ay = Math.floor(run.apple / N) * cell
        const pulse = 1 + 0.05 * Math.sin(now / 260)
        const w = cell * 0.64 * pulse
        g.fillStyle = '#d94f3d'
        g.beginPath()
        g.roundRect(ax + (cell - w) / 2, ay + (cell - w) / 2, w, w, cell * 0.2)
        g.fill()
        g.fillStyle = '#5cb85f'
        g.fillRect(ax + cell * 0.56, ay + cell * 0.08, cell * 0.2, cell * 0.2)
      }

      const pad = cell * 0.12
      const radius = cell * 0.28
      const len = run.snake.length
      const segRect = (i: number): [number, number] => {
        const c = run.snake[i]
        return [(c % N) * cell, Math.floor(c / N) * cell]
      }
      for (let i = len - 1; i >= 1; i--) {
        const t = len > 1 ? i / (len - 1) : 0
        g.fillStyle = bodyShade(t)
        const [x, y] = segRect(i)
        g.beginPath()
        g.roundRect(x + pad, y + pad, cell - pad * 2, cell - pad * 2, radius)
        g.fill()
        // bridge to the next segment toward the head so the body reads as one
        const [nx, ny] = segRect(i - 1)
        if (nx !== x) {
          g.fillRect(Math.min(x, nx) + cell - pad, y + pad, pad * 2, cell - pad * 2)
        } else if (ny !== y) {
          g.fillRect(x + pad, Math.min(y, ny) + cell - pad, cell - pad * 2, pad * 2)
        }
      }

      const [hxp, hyp] = segRect(0)
      const flashOn =
        run.phase === 'dying' && Math.floor((now - run.diedAt) / 90) % 2 === 0
      g.fillStyle = flashOn ? '#f4f4f2' : HEAD_COLOR
      g.beginPath()
      g.roundRect(hxp + pad * 0.6, hyp + pad * 0.6, cell - pad * 1.2, cell - pad * 1.2, radius)
      g.fill()
      if (run.phase !== 'dying' && run.phase !== 'over') {
        const cx = hxp + cell / 2
        const cy = hyp + cell / 2
        const fx = run.dir.x * cell * 0.16
        const fy = run.dir.y * cell * 0.16
        const sx = -run.dir.y * cell * 0.17
        const sy = run.dir.x * cell * 0.17
        g.fillStyle = COURT_BG
        g.beginPath()
        g.arc(cx + fx + sx, cy + fy + sy, cell * 0.08, 0, Math.PI * 2)
        g.arc(cx + fx - sx, cy + fy - sy, cell * 0.08, 0, Math.PI * 2)
        g.fill()
      }

      g.textAlign = 'center'
      g.textBaseline = 'middle'

      if (run.phase === 'ready') {
        g.fillStyle = 'rgba(190, 232, 200, 0.85)'
        g.font = `600 ${Math.max(11, Math.round(size * 0.042))}px ${MONO}`
        g.fillText(coarse ? 'swipe to start' : 'press an arrow to start', size / 2, size * 0.35)
      }

      if (run.phase === 'paused') {
        g.fillStyle = 'rgba(5, 11, 7, 0.55)'
        g.fillRect(0, 0, size, size)
        g.fillStyle = '#bfe8c8'
        g.font = `700 ${Math.max(14, Math.round(size * 0.06))}px ${MONO}`
        g.fillText('paused', size / 2, size * 0.44)
        g.fillStyle = 'rgba(191, 232, 200, 0.7)'
        g.font = `600 ${Math.max(10, Math.round(size * 0.036))}px ${MONO}`
        g.fillText('space or a tap resumes', size / 2, size * 0.53)
      }

      if (run.phase === 'over') {
        g.fillStyle = 'rgba(5, 11, 7, 0.55)'
        g.fillRect(0, 0, size, size)
        const pw = size * 0.72
        const ph = size * 0.4
        const px = (size - pw) / 2
        const py = size * 0.26
        g.fillStyle = '#0e1d13'
        g.strokeStyle = 'rgba(150, 215, 165, 0.45)'
        g.lineWidth = 1.5
        g.beginPath()
        g.roundRect(px, py, pw, ph, 8)
        g.fill()
        g.stroke()
        g.fillStyle = '#bfe8c8'
        g.font = `700 ${Math.max(14, Math.round(size * 0.055))}px ${MONO}`
        g.fillText('game over', size / 2, py + ph * 0.26)
        g.fillStyle = '#8fd39e'
        g.font = `600 ${Math.max(11, Math.round(size * 0.042))}px ${MONO}`
        g.fillText(`score ${run.score}`, size / 2, py + ph * 0.52)
        if (run.improved) {
          g.fillStyle = '#ffd47e'
          g.fillText('new best', size / 2, py + ph * 0.74)
        } else if (bestRef.current !== null) {
          g.fillStyle = 'rgba(143, 211, 158, 0.7)'
          g.fillText(`best ${bestRef.current}`, size / 2, py + ph * 0.74)
        }
      }
    }

    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      const run = runRef.current
      if (run.phase === 'playing') {
        run.acc += dt
        while (run.acc >= 1 / rateFor(run.score) && run.phase === 'playing') {
          run.acc -= 1 / rateFor(run.score)
          tick()
        }
      } else if (run.phase === 'dying' && now - run.diedAt >= FLASH_MS) {
        run.phase = 'over'
        setPhase('over')
        if (run.improved) sounds.fanfare()
      }
      draw(now)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [coarse, submit])

  const padBtn = (dir: Dir, PadIcon: Icon, label: string) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        pushDir(dir)
      }}
      className={`${XP_BTN} flex size-9 items-center justify-center`}
    >
      <PadIcon size={16} weight="bold" className="text-stone-600" />
    </button>
  )

  return (
    <GameShell
      tabs={[{ id: 'snake', label: 'Snake' }]}
      you={name}
      header={
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-stone-500">score</span>
          <Led value={pad3(score)} label="Score" />
          <Led value={`${(rateFor(score) / BASE_RATE).toFixed(1)}x`} label="Speed" />
          <span className="ml-1 text-[11px] text-stone-500">best</span>
          <Led value={best === null ? '---' : pad3(best)} label="Best" />
          <button
            type="button"
            onClick={() => {
              sounds.click()
              newGame()
            }}
            className={`${XP_BTN} ml-1 px-2 py-1 text-[11px] font-medium text-stone-700`}
          >
            New Game
          </button>
        </div>
      }
      hint={coarse ? 'swipe to steer · or use the pad' : 'arrows steer · space pauses'}
    >
      <div
        ref={wrapRef}
        tabIndex={0}
        role="application"
        aria-label="Snake board"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className="relative flex h-full touch-none items-center justify-center p-3 outline-none select-none"
      >
        <div className="relative">
          <canvas ref={canvasRef} className="block rounded-sm border border-stone-400" />
          {phase === 'over' && (
            <button
              type="button"
              onClick={() => {
                sounds.click()
                newGame()
              }}
              className={`${XP_BTN} absolute top-[72%] left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs font-medium text-stone-700`}
            >
              New Game
            </button>
          )}
        </div>
        {coarse && (
          <div className="absolute right-3 bottom-3 grid grid-cols-3 gap-1">
            <span />
            {padBtn(UP, CaretUpIcon, 'Steer up')}
            <span />
            {padBtn(LEFT, CaretLeftIcon, 'Steer left')}
            <span />
            {padBtn(RIGHT, CaretRightIcon, 'Steer right')}
            <span />
            {padBtn(DOWN, CaretDownIcon, 'Steer down')}
            <span />
          </div>
        )}
      </div>
    </GameShell>
  )
}
