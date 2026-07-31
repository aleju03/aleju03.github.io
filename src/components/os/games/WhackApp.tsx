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

  All of the art is SVG built here, because the house rule is that nothing
  ships. What makes it read as a game rather than as nine dark ellipses on a
  green box is that it is drawn as an *object*: a fairground cabinet with a
  bolted frame, a lawn with its own blade pattern and mown stripes, and holes
  that are earth mounds with a lip and a shaft rather than filled circles.
  The same rule the CRT taught — a black rectangle is not a screen — is why a
  green rectangle is not a lawn.
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
@keyframes whack-pop {
  0% { transform: translateY(102%) scaleY(1) }
  70% { transform: translateY(0%) scaleY(1.06) }
  100% { transform: translateY(6%) scaleY(1) }
}
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
/* the ring of earth a surfacing mole kicks up, so a pop has weight */
@keyframes whack-dust {
  0% { transform: scale(0.35); opacity: 0.85 }
  100% { transform: scale(1.5); opacity: 0 }
}
@keyframes whack-pop-score {
  0% { transform: translateY(4px) scale(0.7); opacity: 0 }
  25% { transform: translateY(-4px) scale(1.1); opacity: 1 }
  100% { transform: translateY(-26px) scale(1); opacity: 0 }
}
@keyframes whack-sparkle { 0%, 100% { opacity: 0.15 } 50% { opacity: 0.9 } }
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

/** the fairground cabinet the lawn is sunk into, and the bolts holding it on */
const CABINET =
  'relative h-full rounded-md border border-[#5c1d10] bg-[linear-gradient(#c9553a,#a33a24_45%,#8c2e1b)] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_2px_6px_rgba(0,0,0,0.3)]'
const BOLT =
  'pointer-events-none absolute z-20 h-2 w-2 rounded-full bg-[radial-gradient(circle_at_32%_30%,#fde9c8,#a07a49_60%,#5c4222)] shadow-[0_1px_1px_rgba(0,0,0,0.45)]'
const SCRIM = 'absolute inset-0 z-30 flex items-center justify-center bg-emerald-950/50'
const PLACARD =
  'flex flex-col items-center gap-2 rounded-sm border border-stone-400 bg-stone-100 px-6 py-4 shadow-lg'

/*
  The critter, head and shoulders, framed so its paws land on the hole's lip.
  Flat fills plus one darker rim and no gradients, which is what keeps nine of
  them legible at 86 CSS px.
*/
function MoleSvg({ gold, hit }: { gold: boolean; hit: boolean }) {
  const fur = gold ? '#e0af45' : '#8b5c34'
  const furDark = gold ? '#a4761b' : '#5d3c25'
  const furLight = gold ? '#f3cd7c' : '#a6734a'
  const muzzle = gold ? '#fbe9bd' : '#d8b291'
  return (
    <svg
      viewBox="0 0 72 68"
      className="h-full w-full"
      style={gold ? { filter: 'drop-shadow(0 0 6px rgba(251,191,36,0.8))' } : undefined}
      aria-hidden="true"
    >
      {/* ears, behind the head so only their rims show */}
      <g fill={furDark}>
        <circle cx="15" cy="22" r="7" />
        <circle cx="57" cy="22" r="7" />
      </g>
      <g fill={furLight}>
        <circle cx="15" cy="22" r="3.4" />
        <circle cx="57" cy="22" r="3.4" />
      </g>
      {/* body: a bell that widens into the shoulders */}
      <path
        d="M7 68 V34 C7 17 18 7 36 7 C54 7 65 17 65 34 V68 Z"
        fill={fur}
        stroke={furDark}
        strokeWidth="2.4"
      />
      <path d="M17 22 C21 13 28 9.5 36 9.5 C44 9.5 51 13 55 22 Z" fill={furLight} opacity="0.55" />
      <path d="M36 40 C48 40 53 50 53 68 H19 C19 50 24 40 36 40 Z" fill={muzzle} opacity="0.85" />
      <ellipse cx="36" cy="40" rx="15" ry="11.5" fill={muzzle} />
      <ellipse cx="29.5" cy="41" rx="6" ry="5" fill="#fff" opacity="0.35" />
      <ellipse cx="42.5" cy="41" rx="6" ry="5" fill="#fff" opacity="0.35" />
      {hit ? (
        <g stroke="#2b1a10" strokeWidth="2.6" strokeLinecap="round">
          <path d="M20 24 L28 32 M28 24 L20 32" />
          <path d="M44 24 L52 32 M52 24 L44 32" />
        </g>
      ) : (
        <g>
          <ellipse cx="24" cy="28" rx="4.2" ry="4.6" fill="#2b1a10" />
          <ellipse cx="48" cy="28" rx="4.2" ry="4.6" fill="#2b1a10" />
          <circle cx="25.6" cy="26.4" r="1.5" fill="#fff" />
          <circle cx="49.6" cy="26.4" r="1.5" fill="#fff" />
        </g>
      )}
      {/* nose, and the buck teeth under it */}
      <path
        d="M36 30.5 C40.5 30.5 42.5 33 42.5 35 C42.5 37.6 39 39.5 36 39.5 C33 39.5 29.5 37.6 29.5 35 C29.5 33 31.5 30.5 36 30.5 Z"
        fill="#f0899f"
        stroke="#cf6a80"
        strokeWidth="1.2"
      />
      <circle cx="33.6" cy="34" r="1" fill="#a6455c" />
      <circle cx="38.4" cy="34" r="1" fill="#a6455c" />
      <path d="M36 39.5 V44" stroke="#b98a68" strokeWidth="1.2" strokeLinecap="round" />
      <g fill="#fff" stroke="#c9b49b" strokeWidth="0.8">
        <rect x="31.6" y="44" width="4.1" height="6" rx="1.4" />
        <rect x="36.3" y="44" width="4.1" height="6" rx="1.4" />
      </g>
      <g stroke={furDark} strokeWidth="1.1" opacity="0.6" strokeLinecap="round" fill="none">
        <path d="M22 38 C16 36.5 12 36 8 36.5" />
        <path d="M22 42 C16 42.5 12 43.5 9 45" />
        <path d="M50 38 C56 36.5 60 36 64 36.5" />
        <path d="M50 42 C56 42.5 60 43.5 63 45" />
      </g>
      {/* paws hooked over the rim, claws and all */}
      <g fill={muzzle} stroke={furDark} strokeWidth="1.8">
        <ellipse cx="13" cy="60" rx="8" ry="8.5" />
        <ellipse cx="59" cy="60" rx="8" ry="8.5" />
      </g>
      <g stroke={furDark} strokeWidth="1.2" strokeLinecap="round">
        <path d="M9.5 54 V58 M13 53.2 V57.6 M16.5 54 V58" />
        <path d="M55.5 54 V58 M59 53.2 V57.6 M62.5 54 V58" />
      </g>
      {gold && (
        <g>
          {/* the five-pointer wears a crown, so its worth is on the sprite */}
          <path
            d="M23 12 L27.5 17 L31 8 L36 15 L41 8 L44.5 17 L49 12 L47 22 H25 Z"
            fill="#ffd76a"
            stroke="#a4761b"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M58 8 L59.4 11.6 L63 13 L59.4 14.4 L58 18 L56.6 14.4 L53 13 L56.6 11.6 Z"
            fill="#fff"
            style={{ animation: 'whack-sparkle 1.1s ease-in-out infinite' }}
          />
        </g>
      )}
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

/*
  Every gradient, pattern and clip the field uses, mounted once. Nine holes
  each carrying their own <defs> would put nine copies of the same ids in the
  document; browsers resolve that to the first one and render fine, but it is
  invalid and it is nine times the parse. Everything below refers to it by id.
*/
function FieldDefs() {
  return (
    <svg className="absolute h-0 w-0" aria-hidden="true">
      <defs>
        <linearGradient id="whack-turf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7cc24a" />
          <stop offset="55%" stopColor="#4e9a34" />
          <stop offset="100%" stopColor="#2f6b23" />
        </linearGradient>
        <radialGradient id="whack-vignette" cx="0.5" cy="0.42" r="0.72">
          <stop offset="55%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#0d2a10" stopOpacity="0.45" />
        </radialGradient>
        <pattern id="whack-blades" width="14" height="14" patternUnits="userSpaceOnUse">
          <path
            d="M2 13 C2.4 9 3.6 7.4 5 6 M7 14 C7.6 10.5 8.4 9 10 7.6 M11.5 12 C12 9.4 12.6 8.4 13.6 7.2"
            stroke="#c9ee9a"
            strokeWidth="0.9"
            strokeLinecap="round"
            fill="none"
            opacity="0.3"
          />
        </pattern>
        <radialGradient id="whack-soil" cx="0.5" cy="0.34" r="0.62">
          <stop offset="0%" stopColor="#96663a" />
          <stop offset="100%" stopColor="#523618" />
        </radialGradient>
        <radialGradient id="whack-shaft" cx="0.5" cy="0.26" r="0.8">
          <stop offset="0%" stopColor="#33200f" />
          <stop offset="55%" stopColor="#150c05" />
          <stop offset="100%" stopColor="#000" />
        </radialGradient>
        {/* the near half of the mound, the part that occludes a rising mole */}
        <clipPath id="whack-lip" clipPathUnits="userSpaceOnUse">
          <rect x="0" y="26.5" width="120" height="30" />
        </clipPath>
      </defs>
    </svg>
  )
}

/*
  The lawn: one SVG behind the holes carrying the blade pattern, a sun-warmed
  top and a vignette, so the field has depth without nine more DOM layers. It
  never re-renders during a round.
*/
function LawnArt() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      preserveAspectRatio="none"
      viewBox="0 0 300 300"
      aria-hidden="true"
    >
      <rect width="300" height="300" fill="url(#whack-turf)" />
      <rect width="300" height="300" fill="url(#whack-blades)" />
      {/* mown stripes, the thing that says a groundsman was here */}
      <g fill="#ffffff" opacity="0.05">
        <rect x="0" y="0" width="300" height="34" />
        <rect x="0" y="68" width="300" height="34" />
        <rect x="0" y="136" width="300" height="34" />
        <rect x="0" y="204" width="300" height="34" />
        <rect x="0" y="272" width="300" height="28" />
      </g>
      <rect width="300" height="300" fill="url(#whack-vignette)" />
    </svg>
  )
}

/*
  A hole is an earth mound: soil thrown up around a shaft that darkens inward,
  with clods scattered into the grass. `lip` draws the identical geometry
  through a clip of its near half, so the piece that paints over a rising mole
  can never drift out of register with the piece behind it.
*/
function Mound({ lip = false }: { lip?: boolean }) {
  return (
    <svg viewBox="0 0 120 56" className="h-full w-full" aria-hidden="true">
      <g clipPath={lip ? 'url(#whack-lip)' : undefined}>
        <ellipse cx="60" cy="30" rx="59" ry="25" fill="#3f6f26" />
        <ellipse cx="60" cy="28" rx="57" ry="24" fill="url(#whack-soil)" />
        <g fill="#6f4a26" opacity="0.9">
          <ellipse cx="16" cy="36" rx="7" ry="3.2" />
          <ellipse cx="103" cy="35" rx="6" ry="2.8" />
          <ellipse cx="60" cy="48" rx="9" ry="3.4" />
          <ellipse cx="35" cy="46" rx="5" ry="2.4" />
          <ellipse cx="86" cy="47" rx="6" ry="2.6" />
        </g>
        <ellipse cx="60" cy="26.5" rx="45" ry="17.5" fill="url(#whack-shaft)" />
        {/* light catching the near lip, shadow rolling off the far one */}
        <path d="M17 24 A45 17.5 0 0 1 103 24" fill="none" stroke="#000" strokeWidth="3" opacity="0.35" />
        <path
          d="M17 30 A45 17.5 0 0 0 103 30"
          fill="none"
          stroke="#b3854c"
          strokeWidth="1.8"
          opacity="0.5"
        />
      </g>
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
        <FieldDefs />
        <div className={CABINET}>
          <span className={`${BOLT} top-1.5 left-1.5`} />
          <span className={`${BOLT} top-1.5 right-1.5`} />
          <span className={`${BOLT} bottom-1.5 left-1.5`} />
          <span className={`${BOLT} bottom-1.5 right-1.5`} />
          <div
            className="relative grid h-full touch-none grid-cols-3 grid-rows-3 overflow-hidden rounded-sm shadow-[inset_0_3px_10px_rgba(0,0,0,0.45)]"
            style={{ cursor: HAMMER_CURSOR }}
          >
            <LawnArt />
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
                <span className="absolute top-1 right-1.5 font-mono text-[10px] text-emerald-950/30">
                  {i + 1}
                </span>
                {/* the mound, far half */}
                <div className="absolute bottom-2 left-1/2 h-14 w-[120px] -translate-x-1/2">
                  <Mound />
                </div>
                {/* a mole rises in a clipped window whose floor is the shaft's midline */}
                <div className="absolute bottom-[35px] left-1/2 h-[88px] w-[86px] -translate-x-1/2 overflow-hidden">
                  {mole && (
                    <div
                      key={mole.seq}
                      className="absolute inset-x-0 bottom-0 h-[81px] origin-bottom"
                      style={{ animation: MOLE_ANIM[mole.state] }}
                    >
                      <MoleSvg gold={mole.kind === 'gold'} hit={mole.state === 'hit'} />
                    </div>
                  )}
                </div>
                {/* dust the pop kicks off the rim */}
                {mole?.state === 'up' && (
                  <div
                    key={`dust-${mole.seq}`}
                    className="pointer-events-none absolute bottom-[30px] left-1/2 h-6 w-[104px] -translate-x-1/2 rounded-[50%] border-[3px] border-[#c8a578]/70"
                    style={{ animation: 'whack-dust 380ms ease-out forwards' }}
                  />
                )}
                {mole?.state === 'hit' && (
                  <>
                    <div className="pointer-events-none absolute bottom-[96px] left-1/2 z-20 -translate-x-1/2">
                      <BonkStar />
                    </div>
                    <span
                      className={`pointer-events-none absolute bottom-[118px] left-1/2 z-20 -translate-x-1/2 font-mono text-sm font-bold [text-shadow:0_1px_0_rgba(0,0,0,0.55)] ${
                        mole.kind === 'gold' ? 'text-amber-300' : 'text-white'
                      }`}
                      style={{ animation: 'whack-pop-score 400ms ease-out forwards' }}
                    >
                      +{mole.kind === 'gold' ? GOLD_POINTS : 1}
                    </span>
                  </>
                )}
                {/* the near half of the same mound, over the mole, for depth */}
                <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 h-14 w-[120px] -translate-x-1/2">
                  <Mound lip />
                </div>
              </div>
            ))}

            {phase === 'idle' && (
              <div className={SCRIM}>
                <div className={PLACARD}>
                  <div className="h-14 w-14">
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
              <div className={SCRIM}>
                <p className="rounded-sm border border-stone-400 bg-stone-100 px-4 py-2 text-xs text-stone-600 shadow-md">
                  paused · click to resume
                </p>
              </div>
            )}

            {phase === 'over' && ended && (
              <div className={SCRIM}>
                <div className={PLACARD}>
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
      </div>
    </GameShell>
  )
}
