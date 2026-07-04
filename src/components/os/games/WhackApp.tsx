import { useCallback, useEffect, useRef, useState } from 'react'
import { sounds } from '../sounds'
import { useLeaderboard } from './arcade'
import { GameShell, Led, XP_BTN } from './ui'

/*
  Whack-a-mole for AlejOS. One 60 second round over a 3x3 field of holes.
  A single rAF loop owns all timing in "play milliseconds": pausing (window
  blur) just stops accumulating, so mole uptimes and the countdown freeze
  fairly and there is no timer drift to correct. Moles are hand-drawn SVG
  critters that rise inside a clipped window whose floor sits at the hole's
  midline; the hole's front lip is drawn on top so they really come out of
  the ground.
*/

const HOLES = 9
const ROUND_MS = 60_000
/** spawn cadence ramps from a stroll to a scramble across the round */
const SPAWN_START_MS = 900
const SPAWN_END_MS = 450
/** how long a mole stays surfaced, same ramp */
const UP_START_MS = 900
const UP_END_MS = 550
const GOLD_ODDS = 8 // 1 in 8 moles
const GOLD_UP_FACTOR = 0.65 // golden moles duck sooner
const GOLD_POINTS = 5
/** past this fraction of the round, spawns may come in pairs */
const DOUBLE_AFTER = 0.55
const DOUBLE_CHANCE = 0.3
const HIT_HOLD_MS = 300 // squash + star, then the hole stays locked
const HIT_LOCK_MS = 120
const DUCK_MS = 160
const REST_MS = 150 // a vacated hole sits empty at least this long
const MISS_THROTTLE_MS = 600

type Phase = 'idle' | 'playing' | 'paused' | 'over'

interface Mole {
  kind: 'normal' | 'gold'
  state: 'up' | 'hit' | 'ducking'
  /** render key, so a fresh mole restarts the pop animation */
  seq: number
}

interface HoleSlot {
  mole: Mole | null
  /** play-ms until the hole can host again (hit lock, duck, rest) */
  busyUntil: number
  /** play-ms when an unwhacked mole gives up and ducks */
  upUntil: number
}

const freshHoles = (): HoleSlot[] =>
  Array.from({ length: HOLES }, () => ({ mole: null, busyUntil: 0, upUntil: 0 }))

const now = () => performance.now()

const MOLE_CSS = `
@keyframes whack-pop { from { transform: translateY(102%) } to { transform: translateY(6%) } }
@keyframes whack-bonk {
  0% { transform: translateY(6%) scale(1, 1) }
  35% { transform: translateY(24%) scale(1.18, 0.5) }
  100% { transform: translateY(104%) scale(1.1, 0.6) }
}
@keyframes whack-duck { from { transform: translateY(6%) } to { transform: translateY(104%) } }
@keyframes whack-star {
  0% { transform: scale(0.4) rotate(-24deg); opacity: 0 }
  35% { transform: scale(1.15) rotate(6deg); opacity: 1 }
  100% { transform: scale(1); opacity: 0 }
}
`

const MOLE_ANIM: Record<Mole['state'], string> = {
  up: 'whack-pop 120ms ease-out forwards',
  hit: `whack-bonk ${HIT_HOLD_MS}ms ease-in forwards`,
  ducking: `whack-duck ${DUCK_MS}ms ease-in forwards`,
}

/** a tiny mallet as the field cursor, hotspot on the striking head */
const MALLET_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">' +
    '<g transform="rotate(38 15 15)">' +
    '<rect x="13" y="11" width="4" height="17" rx="1.5" fill="#b45309" stroke="#7c2d12" stroke-width="1.5"/>' +
    '<rect x="5" y="2" width="20" height="10" rx="2" fill="#a8a29e" stroke="#57534e" stroke-width="1.5"/>' +
    '</g></svg>',
)
const HAMMER_CURSOR = `url("data:image/svg+xml,${MALLET_SVG}") 20 9, pointer`

const pad3 = (n: number) => String(Math.max(0, Math.min(999, n))).padStart(3, '0')

function MoleSvg({ gold, hit }: { gold: boolean; hit: boolean }) {
  const fur = gold ? '#d9a441' : '#8a5a33'
  const furDark = gold ? '#a97e1f' : '#66422a'
  const belly = gold ? '#f2d488' : '#c99e6b'
  return (
    <svg
      viewBox="0 0 64 60"
      className="h-full w-full"
      style={gold ? { filter: 'drop-shadow(0 0 5px rgba(251,191,36,0.75))' } : undefined}
      aria-hidden="true"
    >
      <path
        d="M8 60 V28 C8 13 18 5 32 5 C46 5 56 13 56 28 V60 Z"
        fill={fur}
        stroke={furDark}
        strokeWidth="2"
      />
      <ellipse cx="32" cy="42" rx="13" ry="16" fill={belly} />
      {hit ? (
        <g stroke="#2a1c12" strokeWidth="2" strokeLinecap="round">
          <path d="M19 21 L25 27 M25 21 L19 27" />
          <path d="M39 21 L45 27 M45 21 L39 27" />
        </g>
      ) : (
        <g fill="#2a1c12">
          <circle cx="22" cy="24" r="2.6" />
          <circle cx="42" cy="24" r="2.6" />
        </g>
      )}
      <ellipse cx="32" cy="31" rx="4.5" ry="3.5" fill="#f2a0b5" stroke="#d97d98" strokeWidth="1" />
      <rect x="28.6" y="35" width="3.2" height="4.5" rx="1" fill="#fff" />
      <rect x="32.2" y="35" width="3.2" height="4.5" rx="1" fill="#fff" />
      <g stroke={furDark} strokeWidth="1" opacity="0.55" strokeLinecap="round">
        <path d="M24 31 L14 29 M24 34 L15 35" />
        <path d="M40 31 L50 29 M40 34 L49 35" />
      </g>
      <g fill={belly} stroke={furDark} strokeWidth="1.5">
        <ellipse cx="14" cy="53" rx="6.5" ry="7.5" />
        <ellipse cx="50" cy="53" rx="6.5" ry="7.5" />
      </g>
      <g stroke={furDark} strokeWidth="1" strokeLinecap="round">
        <path d="M12 47 L12 51 M16 47 L16 51" />
        <path d="M48 47 L48 51 M52 47 L52 51" />
      </g>
    </svg>
  )
}

function BonkStar() {
  return (
    <svg
      viewBox="0 0 40 40"
      className="h-9 w-9"
      style={{ animation: 'whack-star 300ms ease-out forwards' }}
      aria-hidden="true"
    >
      <path
        d="M20 2 L24.5 14 L37 14 L27 22 L31 35 L20 27.5 L9 35 L13 22 L3 14 L15.5 14 Z"
        fill="#fbbf24"
        stroke="#b45309"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function WhackApp() {
  const { name, best, submit } = useLeaderboard('whack')
  const [phase, setPhase] = useState<Phase>('idle')
  const [score, setScore] = useState(0)
  const [secs, setSecs] = useState(ROUND_MS / 1000)
  const [moles, setMoles] = useState<(Mole | null)[]>(() => Array<Mole | null>(HOLES).fill(null))
  const [ended, setEnded] = useState<{ score: number; improved: boolean } | null>(null)

  const phaseRef = useRef<Phase>('idle')
  const scoreRef = useRef(0)
  const bestRef = useRef(best)
  const holesRef = useRef<HoleSlot[]>(freshHoles())
  /** play-ms accumulated before the last resume */
  const playedRef = useRef(0)
  /** performance.now() at the last resume */
  const resumedAtRef = useRef(0)
  const nextSpawnRef = useRef(0)
  const lastMissRef = useRef(0)
  const seqRef = useRef(0)
  const fieldRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bestRef.current = best
  }, [best])

  useEffect(() => {
    fieldRef.current?.focus()
  }, [])

  const setPhaseBoth = (next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }

  const syncMoles = () => setMoles(holesRef.current.map((h) => h.mole))

  const spawn = useCallback((elapsed: number, t: number): boolean => {
    const open = holesRef.current.filter((h) => !h.mole && elapsed >= h.busyUntil)
    if (open.length === 0) return false
    const hole = open[Math.floor(Math.random() * open.length)]
    const gold = Math.random() < 1 / GOLD_ODDS
    const uptime = (UP_START_MS - (UP_START_MS - UP_END_MS) * t) * (gold ? GOLD_UP_FACTOR : 1)
    hole.mole = { kind: gold ? 'gold' : 'normal', state: 'up', seq: ++seqRef.current }
    hole.upUntil = elapsed + uptime
    sounds.blip()
    return true
  }, [])

  const finish = useCallback(() => {
    const finalScore = scoreRef.current
    const prev = bestRef.current
    const improved = finalScore > 0 && (prev === null || finalScore > prev)
    holesRef.current = freshHoles()
    setMoles(Array<Mole | null>(HOLES).fill(null))
    setSecs(0)
    setEnded({ score: finalScore, improved })
    phaseRef.current = 'over'
    setPhase('over')
    if (improved) sounds.fanfare()
    if (finalScore > 0) void submit(finalScore)
  }, [submit])

  // the round loop: countdown, mole lifetimes and the ramping spawner all
  // read the same play-ms clock, so pausing freezes everything at once
  useEffect(() => {
    if (phase !== 'playing') return
    let raf = 0
    const tick = () => {
      const elapsed = playedRef.current + performance.now() - resumedAtRef.current
      if (elapsed >= ROUND_MS) {
        finish()
        return
      }
      const remaining = Math.ceil((ROUND_MS - elapsed) / 1000)
      setSecs((s) => (s === remaining ? s : remaining))
      const t = elapsed / ROUND_MS
      let changed = false
      for (const hole of holesRef.current) {
        const m = hole.mole
        if (!m) continue
        if (m.state === 'up' && elapsed >= hole.upUntil) {
          hole.mole = { ...m, state: 'ducking' }
          hole.busyUntil = elapsed + DUCK_MS + REST_MS
          changed = true
          // an escape stings a little, but never spams
          if (elapsed - lastMissRef.current > MISS_THROTTLE_MS) {
            lastMissRef.current = elapsed
            sounds.miss()
          }
        } else if (m.state !== 'up' && elapsed >= hole.busyUntil) {
          hole.mole = null
          hole.busyUntil = elapsed + REST_MS
          changed = true
        }
      }
      if (elapsed >= nextSpawnRef.current) {
        const interval = SPAWN_START_MS - (SPAWN_START_MS - SPAWN_END_MS) * t
        nextSpawnRef.current = elapsed + interval * (0.85 + Math.random() * 0.3)
        changed = spawn(elapsed, t) || changed
        if (t > DOUBLE_AFTER && Math.random() < DOUBLE_CHANCE) changed = spawn(elapsed, t) || changed
      }
      if (changed) setMoles(holesRef.current.map((h) => h.mole))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, spawn, finish])

  // window blur banks the played time and freezes; focus resumes the clock
  useEffect(() => {
    const pause = () => {
      if (phaseRef.current !== 'playing') return
      playedRef.current += performance.now() - resumedAtRef.current
      phaseRef.current = 'paused'
      setPhase('paused')
    }
    const resume = () => {
      if (phaseRef.current !== 'paused') return
      resumedAtRef.current = performance.now()
      phaseRef.current = 'playing'
      setPhase('playing')
    }
    const onVisibility = () => {
      if (document.hidden) pause()
      else resume()
    }
    window.addEventListener('blur', pause)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', pause)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const start = () => {
    sounds.click()
    holesRef.current = freshHoles()
    scoreRef.current = 0
    setScore(0)
    setSecs(ROUND_MS / 1000)
    setEnded(null)
    setMoles(Array<Mole | null>(HOLES).fill(null))
    playedRef.current = 0
    resumedAtRef.current = now()
    nextSpawnRef.current = 600
    lastMissRef.current = 0
    setPhaseBoth('playing')
    fieldRef.current?.focus()
  }

  const resumeFromClick = () => {
    if (phaseRef.current !== 'paused') return
    resumedAtRef.current = now()
    setPhaseBoth('playing')
  }

  const whack = (i: number) => {
    if (phaseRef.current === 'paused') {
      resumeFromClick()
      return
    }
    if (phaseRef.current !== 'playing') return
    const hole = holesRef.current[i]
    const m = hole.mole
    if (!m || m.state !== 'up') return
    const elapsed = playedRef.current + now() - resumedAtRef.current
    hole.mole = { ...m, state: 'hit' }
    hole.busyUntil = elapsed + HIT_HOLD_MS + HIT_LOCK_MS
    scoreRef.current += m.kind === 'gold' ? GOLD_POINTS : 1
    setScore(scoreRef.current)
    sounds.thud()
    if (m.kind === 'gold') sounds.point()
    syncMoles()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.repeat) return
    const n = Number(e.key)
    if (!Number.isInteger(n) || n < 1 || n > 9) return
    e.preventDefault()
    whack(n - 1)
  }

  return (
    <GameShell
      tabs={[{ id: 'whack', label: 'Whack' }]}
      you={name}
      header={
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-stone-500">time</span>
          <Led value={`0:${String(secs).padStart(2, '0')}`} label="Time left" />
          <span className="text-[10px] text-stone-500">score</span>
          <Led value={pad3(score)} label="Score" />
          <span className="text-[10px] text-stone-500">best</span>
          <Led value={best === null ? '---' : pad3(best)} label="Personal best" />
        </div>
      }
      hint="pointer or keys 1-9 · golden moles pay five"
    >
      <div
        ref={fieldRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={() => {
          fieldRef.current?.focus()
          resumeFromClick()
        }}
        className="h-full p-2 outline-none select-none"
      >
        <style>{MOLE_CSS}</style>
        <div
          className="relative grid h-full touch-none grid-cols-3 grid-rows-3 rounded-md border border-emerald-900/50 bg-gradient-to-b from-emerald-500 to-emerald-700 p-1 shadow-[inset_0_2px_6px_rgba(0,0,0,0.25)]"
          style={{ cursor: HAMMER_CURSOR }}
        >
          {moles.map((mole, i) => (
            <div
              key={i}
              role="button"
              aria-label={`Hole ${i + 1}`}
              onPointerDown={(e) => {
                e.stopPropagation()
                fieldRef.current?.focus()
                whack(i)
              }}
              className="relative"
            >
              <span className="absolute top-1 right-1.5 font-mono text-[10px] text-emerald-950/35">
                {i + 1}
              </span>
              {/* the well */}
              <div className="absolute bottom-3 left-1/2 h-11 w-24 -translate-x-1/2 rounded-[50%] bg-[#5b3a1e] p-[5px] shadow-[0_1px_0_rgba(255,255,255,0.25)]">
                <div className="h-full w-full rounded-[50%] bg-stone-950 shadow-[inset_0_3px_4px_rgba(0,0,0,0.85)]" />
              </div>
              {/* the mole rises in a clipped window whose floor is the hole's midline */}
              <div className="absolute bottom-[34px] left-1/2 h-[76px] w-20 -translate-x-1/2 overflow-hidden">
                {mole && (
                  <div
                    key={mole.seq}
                    className="absolute inset-x-1 bottom-0 h-[70px] origin-bottom"
                    style={{ animation: MOLE_ANIM[mole.state] }}
                  >
                    <MoleSvg gold={mole.kind === 'gold'} hit={mole.state === 'hit'} />
                  </div>
                )}
              </div>
              {mole?.state === 'hit' && (
                <div className="pointer-events-none absolute bottom-[84px] left-1/2 z-20 -translate-x-1/2">
                  <BonkStar />
                </div>
              )}
              {/* front lip of the hole, drawn over the mole for depth */}
              <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 h-[22px] w-24 -translate-x-1/2 overflow-hidden">
                <div className="absolute -top-[22px] h-11 w-24 rounded-[50%] bg-[#5b3a1e] p-[5px]">
                  <div className="h-full w-full rounded-[50%] bg-stone-950 shadow-[inset_0_-2px_3px_rgba(255,255,255,0.08)]" />
                </div>
              </div>
            </div>
          ))}

          {phase === 'idle' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center rounded-md bg-emerald-950/45">
              <div className="flex flex-col items-center gap-2 rounded-sm border border-stone-400 bg-stone-100 px-6 py-4 shadow-md">
                <div className="h-12 w-12">
                  <MoleSvg gold={false} hit={false} />
                </div>
                <p className="text-sm font-semibold text-stone-700">whack-a-mole</p>
                <p className="text-xs text-stone-500">sixty seconds, whack whatever surfaces</p>
                <button
                  type="button"
                  onClick={start}
                  className={`${XP_BTN} mt-1 px-4 py-1.5 text-xs font-medium text-stone-700`}
                >
                  start
                </button>
              </div>
            </div>
          )}

          {phase === 'paused' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center rounded-md bg-emerald-950/45">
              <p className="rounded-sm border border-stone-400 bg-stone-100 px-4 py-2 text-xs text-stone-600 shadow-md">
                paused · click to resume
              </p>
            </div>
          )}

          {phase === 'over' && ended && (
            <div className="absolute inset-0 z-30 flex items-center justify-center rounded-md bg-emerald-950/45">
              <div className="flex flex-col items-center gap-2 rounded-sm border border-stone-400 bg-stone-100 px-6 py-4 shadow-md">
                <p className="text-xs text-stone-500">time is up</p>
                <p className="font-mono text-2xl font-bold text-stone-800">{ended.score}</p>
                {ended.improved && (
                  <p className="rounded-sm bg-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                    new best
                  </p>
                )}
                <button
                  type="button"
                  onClick={start}
                  className={`${XP_BTN} mt-1 px-4 py-1.5 text-xs font-medium text-stone-700`}
                >
                  play again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </GameShell>
  )
}
