import { useCallback, useEffect, useRef, useState } from 'react'
import { sounds } from '../sounds'
import { useLeaderboard } from './arcade'
import { GameShell, Led, XP_BTN } from './ui'

/*
  Tappy Plane for AlejOS. One toy biplane, one button. The art is Kenney's
  CC0 "Tappy Plane" kit (public/os/games/tappy, see NOTICE.txt): a parallax
  mountain backdrop, triangular rocks instead of pipes, sprite digits and
  medals, and a propeller that actually spins. The terrain changes season
  every dozen points — grass, then dirt, then snow, then ice — and the
  whole game lives on one canvas at a fixed logical size that scales to
  whatever the window gives it.
*/

const W = 360
const H = 480
const GROUND_SRC_W = 808
const GROUND_SRC_H = 71
const GROUND_SCALE = 0.72
const GROUND_W = GROUND_SRC_W * GROUND_SCALE
const GROUND_H = Math.round(GROUND_SRC_H * GROUND_SCALE)
const HORIZON = H - GROUND_H

// the kit backdrop is exactly our logical height, so it tiles the whole
// canvas at natural size and there is no seam against the sky
const BG_W = 800

const PLANE_X = W * 0.28
const PLANE_W = 44
const PLANE_H = 36
const HIT_R = 12 // a touch smaller than the drawing, so near misses feel fair

const GRAVITY = 1400
const FLAP_VY = -380
const MAX_FALL = 520

const ROCK_W = 64
const ROCK_TIP_HW = 5
const ROCK_BASE_HW = 28
const SPAWN_EVERY = 1.6
const GAP_START = 168
const GAP_MIN = 132
const SPEED_START = 130
const SPEED_MAX = 165

/** the terrain swaps to the next season every this many points */
const THEME_EVERY = 12
const THEMES = [
  { ground: 'groundGrass', rockUp: 'rockGrass', rockDown: 'rockGrassDown', tint: '' },
  { ground: 'groundDirt', rockUp: 'rock', rockDown: 'rockDown', tint: 'rgba(244,150,66,0.09)' },
  {
    ground: 'groundSnow',
    rockUp: 'rockSnow',
    rockDown: 'rockSnowDown',
    tint: 'rgba(255,255,255,0.22)',
  },
  {
    ground: 'groundIce',
    rockUp: 'rockIce',
    rockDown: 'rockIceDown',
    tint: 'rgba(110,165,220,0.16)',
  },
] as const

const MEDALS: Array<{ at: number; sprite: string }> = [
  { at: 40, sprite: 'medalGold' },
  { at: 25, sprite: 'medalSilver' },
  { at: 10, sprite: 'medalBronze' },
]

// ---------------------------------------------------------------- sprites

const SPRITE_NAMES = [
  'background',
  'groundGrass',
  'groundDirt',
  'groundSnow',
  'groundIce',
  'rockGrass',
  'rockGrassDown',
  'rock',
  'rockDown',
  'rockSnow',
  'rockSnowDown',
  'rockIce',
  'rockIceDown',
  'planeYellow1',
  'planeYellow2',
  'planeYellow3',
  'puffLarge',
  'puffSmall',
  'textGetReady',
  'textGameOver',
  'medalBronze',
  'medalSilver',
  'medalGold',
  'tap',
  ...Array.from({ length: 10 }, (_, i) => `number${i}`),
]

const sprites = new Map<string, HTMLImageElement>()
let spritesLoading = false
function loadSprites() {
  if (spritesLoading) return
  spritesLoading = true
  for (const name of SPRITE_NAMES) {
    const img = new Image()
    // a sprite that fails to load simply skips its draw; the game still runs
    img.onload = () => sprites.set(name, img)
    img.src = `/os/games/tappy/${name}.png`
  }
}

// ---------------------------------------------------------------- world

type Phase = 'ready' | 'flying' | 'paused' | 'dying' | 'dead'

interface Rock {
  x: number
  gapY: number
  gap: number
  theme: number
  passed: boolean
}

interface Puff {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
  big: boolean
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
  rocks: Rock[]
  puffs: Puff[]
  spawnIn: number
  score: number
  /** white impact flash, 1 at the hit and fading fast */
  flash: number
  newBest: boolean
  clouds: Cloud[]
  bgOff: number
  groundOff: number
  theme: number
  prevTheme: number
  /** 0..1 crossfade from prevTheme into theme */
  themeFade: number
  /** dying smoke trail metronome */
  smokeIn: number
}

function makeWorld(): World {
  return {
    phase: 'ready',
    t: 0,
    y: H * 0.44,
    vy: 0,
    rot: 0,
    rocks: [],
    puffs: [],
    spawnIn: 1.3,
    score: 0,
    flash: 0,
    newBest: false,
    clouds: Array.from({ length: 3 }, (_, i) => ({
      x: Math.random() * W,
      y: 30 + i * 36 + Math.random() * 14,
      s: 0.75 + Math.random() * 0.5,
      v: 7 + Math.random() * 8,
    })),
    bgOff: 0,
    groundOff: 0,
    theme: 0,
    prevTheme: 0,
    themeFade: 1,
    smokeIn: 0,
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const pad3 = (n: number) => String(clamp(n, 0, 999)).padStart(3, '0')

// the gap tightens and the world speeds up as the score climbs
const gapAt = (score: number) => GAP_START - (GAP_START - GAP_MIN) * Math.min(score / 25, 1)
const speedAt = (score: number) =>
  SPEED_START + (SPEED_MAX - SPEED_START) * Math.min(score / 30, 1)

/**
 * circle vs the triangular rock: the half-width tapers linearly from the
 * base to the tip, so the check reads the rock's width at the plane's own
 * height instead of treating the whole thing as a box
 */
function hitsRock(y: number, r: Rock): boolean {
  const dx = Math.abs(PLANE_X - (r.x + ROCK_W / 2))
  if (dx > ROCK_BASE_HW + HIT_R) return false
  const topSpan = r.gapY - r.gap / 2
  const botY = r.gapY + r.gap / 2
  if (topSpan > 1 && y - HIT_R < topSpan) {
    const at = clamp(y, 0, topSpan)
    const hw = ROCK_TIP_HW + (ROCK_BASE_HW - ROCK_TIP_HW) * ((topSpan - at) / topSpan)
    if (dx < hw + HIT_R * 0.75) return true
  }
  const botSpan = HORIZON - botY
  if (botSpan > 1 && y + HIT_R > botY) {
    const at = clamp(y, botY, HORIZON)
    const hw = ROCK_TIP_HW + (ROCK_BASE_HW - ROCK_TIP_HW) * ((at - botY) / botSpan)
    if (dx < hw + HIT_R * 0.75) return true
  }
  return false
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
    w.puffs.push({
      x: PLANE_X - PLANE_W * 0.45,
      y: w.y + 8,
      vx: -speedAt(w.score) * 0.5,
      vy: 26,
      age: 0,
      life: 0.55,
      big: false,
    })
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
    loadSprites()
    wrapRef.current?.focus()
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    const die = (w: World, cause: 'rock' | 'ground') => {
      sounds.thud()
      w.phase = 'dying'
      setPhaseUi('dying')
      w.flash = 1
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        w.puffs.push({
          x: PLANE_X + Math.cos(a) * 10,
          y: w.y + Math.sin(a) * 10,
          vx: Math.cos(a) * 46,
          vy: Math.sin(a) * 46,
          age: 0,
          life: 0.7,
          big: true,
        })
      }
      // a rock hit knocks the plane back before the tumble; the ground just stops it
      w.vy = cause === 'rock' ? -140 : 0
      const prev = bestRef.current
      w.newBest = w.score > 0 && (prev === null || w.score > prev)
      if (w.score > 0) void submitRef.current(w.score)
    }

    const stepPuffs = (w: World, dt: number) => {
      for (const p of w.puffs) {
        p.age += dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.vy -= 14 * dt
      }
      w.puffs = w.puffs.filter((p) => p.age < p.life)
    }

    const step = (dt: number) => {
      const w = worldRef.current
      w.t += dt
      if (w.themeFade < 1) w.themeFade = Math.min(1, w.themeFade + dt * 1.2)
      if (w.phase === 'ready' || w.phase === 'flying') {
        const speed = speedAt(w.score)
        w.groundOff += speed * dt
        w.bgOff += speed * 0.25 * dt
        for (const c of w.clouds) {
          c.x -= c.v * dt
          if (c.x < -70) {
            c.x = W + 60
            c.y = 24 + Math.random() * 90
          }
        }
      }
      stepPuffs(w, dt)
      if (w.phase === 'ready') {
        w.y = H * 0.44 + Math.sin(w.t * 3.2) * 6
        w.rot = 0
        return
      }
      if (w.phase === 'flying') {
        w.vy = Math.min(w.vy + GRAVITY * dt, MAX_FALL)
        w.y += w.vy * dt
        if (w.y < PLANE_H / 2) {
          w.y = PLANE_H / 2
          w.vy = 0
        }
        w.rot = clamp(w.vy * 0.0022, -0.34, 1.1)
        w.spawnIn -= dt
        if (w.spawnIn <= 0) {
          w.spawnIn += SPAWN_EVERY
          const gap = gapAt(w.score)
          const lo = gap / 2 + 52
          const hi = HORIZON - gap / 2 - 48
          w.rocks.push({
            x: W + ROCK_W,
            gapY: lo + Math.random() * (hi - lo),
            gap,
            theme: w.theme,
            passed: false,
          })
        }
        const speed = speedAt(w.score)
        for (const r of w.rocks) r.x -= speed * dt
        if (w.rocks.length > 0 && w.rocks[0].x < -ROCK_W - 8) w.rocks.shift()
        for (const r of w.rocks) {
          if (!r.passed && r.x + ROCK_W < PLANE_X) {
            r.passed = true
            w.score += 1
            setScoreUi(w.score)
            sounds.point()
            const season = Math.floor(w.score / THEME_EVERY) % THEMES.length
            if (season !== w.theme) {
              w.prevTheme = w.theme
              w.theme = season
              w.themeFade = 0
            }
          }
        }
        if (w.y + HIT_R >= HORIZON) {
          w.y = HORIZON - HIT_R
          die(w, 'ground')
          return
        }
        for (const r of w.rocks) {
          if (hitsRock(w.y, r)) {
            die(w, 'rock')
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
        w.smokeIn -= dt
        if (w.smokeIn <= 0) {
          w.smokeIn = 0.07
          w.puffs.push({
            x: PLANE_X + (Math.random() - 0.5) * 8,
            y: w.y - 6,
            vx: -20,
            vy: -30,
            age: 0,
            life: 0.5,
            big: false,
          })
        }
        if (w.y >= HORIZON - PLANE_H * 0.32) {
          w.y = HORIZON - PLANE_H * 0.32
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
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath()
      ctx.arc(0, 0, 16, 0, Math.PI * 2)
      ctx.arc(18, -7, 13, 0, Math.PI * 2)
      ctx.arc(34, 0, 15, 0, Math.PI * 2)
      ctx.arc(17, 6, 14, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    const drawBackdrop = (w: World) => {
      const bg = sprites.get('background')
      if (!bg) return
      const off = w.bgOff % BG_W
      for (let x = -off; x < W; x += BG_W) {
        ctx.drawImage(bg, x, 0, BG_W, H)
      }
    }

    const drawGroundLayer = (themeIdx: number, off: number) => {
      const img = sprites.get(THEMES[themeIdx].ground)
      if (!img) return
      const x0 = -(off % GROUND_W)
      for (let x = x0; x < W; x += GROUND_W) {
        ctx.drawImage(img, x, HORIZON, GROUND_W, GROUND_H)
      }
    }

    const drawRock = (r: Rock) => {
      const theme = THEMES[r.theme]
      const topSpan = r.gapY - r.gap / 2
      const botY = r.gapY + r.gap / 2
      const down = sprites.get(theme.rockDown)
      const up = sprites.get(theme.rockUp)
      if (down && topSpan > 1) ctx.drawImage(down, r.x, 0, ROCK_W, topSpan)
      if (up && HORIZON - botY > 1) ctx.drawImage(up, r.x, botY, ROCK_W, HORIZON - botY + 6)
    }

    const drawPuffs = (w: World) => {
      for (const p of w.puffs) {
        const img = sprites.get(p.big ? 'puffLarge' : 'puffSmall')
        if (!img) continue
        const k = p.age / p.life
        const s = (p.big ? 1 : 0.9) * (0.7 + k * 0.7)
        ctx.save()
        ctx.globalAlpha = 0.9 * (1 - k)
        ctx.drawImage(img, p.x - (img.width * s) / 2, p.y - (img.height * s) / 2, img.width * s, img.height * s)
        ctx.restore()
      }
    }

    const drawPlane = (w: World) => {
      const spinning = w.phase === 'ready' || w.phase === 'flying' || w.phase === 'paused'
      const frame = spinning ? (Math.floor(w.t * 16) % 3) + 1 : 3
      const img = sprites.get(`planeYellow${frame}`)
      if (!img) return
      ctx.save()
      ctx.translate(PLANE_X, w.y)
      ctx.rotate(w.rot)
      ctx.drawImage(img, -PLANE_W / 2, -PLANE_H / 2, PLANE_W, PLANE_H)
      ctx.restore()
    }

    /** the kit's outlined digits, proportional widths, centered on cx */
    const drawDigits = (value: number, cx: number, y: number, h: number) => {
      const chars = [...String(value)]
      const imgs = chars
        .map((ch) => sprites.get(`number${ch}`))
        .filter((i): i is HTMLImageElement => Boolean(i))
      if (imgs.length === 0) return
      const widths = imgs.map((img) => img.width * (h / img.height))
      const total = widths.reduce((a, b) => a + b, 0) + (imgs.length - 1) * 2
      let x = cx - total / 2
      imgs.forEach((img, i) => {
        ctx.drawImage(img, x, y, widths[i], h)
        x += widths[i] + 2
      })
    }

    const drawSprite = (name: string, cx: number, cy: number, width: number, pulse = 0) => {
      const img = sprites.get(name)
      if (!img) return
      const s = (width / img.width) * (1 + pulse)
      ctx.drawImage(img, cx - (img.width * s) / 2, cy - (img.height * s) / 2, img.width * s, img.height * s)
    }

    const centerText = (text: string, y: number, font: string, fill: string) => {
      ctx.font = font
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = fill
      ctx.fillText(text, W / 2, y)
    }

    const render = () => {
      const w = worldRef.current
      // the kit's own flat sky tone, so the tiled backdrop blends seamlessly
      ctx.fillStyle = '#d5edf7'
      ctx.fillRect(0, 0, W, H)
      drawBackdrop(w)
      for (const c of w.clouds) drawCloud(c)
      for (const r of w.rocks) drawRock(r)
      if (w.themeFade < 1) {
        drawGroundLayer(w.prevTheme, w.groundOff)
        ctx.save()
        ctx.globalAlpha = w.themeFade
        drawGroundLayer(w.theme, w.groundOff)
        ctx.restore()
      } else {
        drawGroundLayer(w.theme, w.groundOff)
      }
      // a whisper of seasonal light over the whole scene
      const prevTint = THEMES[w.prevTheme].tint
      const curTint = THEMES[w.theme].tint
      if (prevTint && w.themeFade < 1) {
        ctx.save()
        ctx.globalAlpha = 1 - w.themeFade
        ctx.fillStyle = prevTint
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
      }
      if (curTint) {
        ctx.save()
        ctx.globalAlpha = w.themeFade
        ctx.fillStyle = curTint
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
      }
      drawPuffs(w)
      drawPlane(w)

      if (w.phase === 'flying' || w.phase === 'dying') {
        drawDigits(w.score, W / 2, 26, 32)
      }

      if (w.phase === 'ready') {
        drawSprite('textGetReady', W / 2, H * 0.24, 250)
        drawSprite('tap', W / 2 - 64, H * 0.44, 44, Math.sin(w.t * 5) * 0.06)
        drawSprite('tap', W / 2 + 64, H * 0.44, 44, Math.sin(w.t * 5 + Math.PI) * 0.06)
        centerText('space or tap to climb', H * 0.56, `12px ${FONT}`, 'rgba(60,90,110,0.85)')
      }

      if (w.phase === 'dead') {
        drawSprite('textGameOver', W / 2, H * 0.2, 260)
        const medal = MEDALS.find((m) => w.score >= m.at)
        const cw = 244
        const ch = 118
        const cx = (W - cw) / 2
        const cy = H * 0.27
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
        const textX = medal ? cx + cw * 0.63 : W / 2
        if (medal) drawSprite(medal.sprite, cx + 62, cy + ch / 2, 76)
        const shownBest = w.newBest ? w.score : Math.max(bestRef.current ?? 0, 0)
        ctx.textAlign = 'center'
        ctx.font = `bold 12px ${FONT}`
        ctx.fillStyle = '#78716c'
        ctx.fillText('score', textX, cy + 24)
        drawDigits(w.score, textX, cy + 32, 26)
        ctx.font = `bold 12px ${FONT}`
        ctx.fillStyle = '#78716c'
        ctx.fillText('best', textX, cy + 78)
        drawDigits(shownBest, textX, cy + 86, 20)
        if (w.newBest) {
          centerText('new best!', cy + ch + 18, `bold 14px ${FONT}`, '#b45309')
        }
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

    // losing the page mid-run freezes the game instead of killing the plane;
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
      tabs={[{ id: 'flappy', label: 'Tappy Plane' }]}
      you={name}
      header={
        <>
          <span className="text-[11px] text-stone-500">score</span>
          <Led value={pad3(scoreUi)} label="Score" />
          <span className="ml-1 text-[11px] text-stone-500">best</span>
          <Led value={pad3(best ?? 0)} label="Best" />
        </>
      }
      hint="space or tap climbs"
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
            <div className="absolute inset-x-0 flex justify-center" style={{ top: '62%' }}>
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
