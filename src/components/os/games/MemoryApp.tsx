import { useEffect, useRef, useState } from 'react'
import { sounds } from '../sounds'
import { xpIcon } from '../xpIcon'
import type { XpIconName } from '../xpIcon'
import { formatScore, useLeaderboard } from './arcade'
import { GameShell, Led, XP_BTN } from './ui'

/*
  Memory for AlejOS. Ten pairs of the OS's own icons lie face down on a
  4x5 board. The clock starts on the first flip and stops on the last
  match, and the leaderboard keeps the fastest clears. Matches stay up
  with a little pop, misses flip back after a beat.
*/

const ICONS: XpIconName[] = [
  'my-computer',
  'folder',
  'ie',
  'messenger',
  'notepad',
  'cmd',
  'minesweeper',
  'paint',
  'display',
  'recycle-full',
]
const CARDS = ICONS.length * 2
const FLIP_BACK_MS = 700
const POP_MS = 300
const CLEAR_PANEL_MS = 600
const TICK_MS = 100

type Phase = 'idle' | 'playing' | 'cleared'

interface Result {
  ms: number
  moves: number
  improved: boolean
}

// the purity lint can't tell flip() only runs on click, so the clock
// read lives out here where it is unmistakably not render work
const now = () => performance.now()

/** fisher-yates over two copies of the icon set */
function shuffledDeck(): XpIconName[] {
  const deck = [...ICONS, ...ICONS]
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

export function MemoryApp() {
  const { name, best, submit } = useLeaderboard('memory')
  const [deck, setDeck] = useState<XpIconName[]>(shuffledDeck)
  const [matched, setMatched] = useState<boolean[]>(() => Array<boolean>(CARDS).fill(false))
  const [faceUp, setFaceUp] = useState<number[]>([])
  const [justMatched, setJustMatched] = useState<number[]>([])
  const [moves, setMoves] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<Result | null>(null)
  const startRef = useRef(0)
  const flipBackTimer = useRef<number | null>(null)
  const popTimer = useRef<number | null>(null)
  const panelTimer = useRef<number | null>(null)

  useEffect(() => {
    if (phase !== 'playing') return
    const id = window.setInterval(() => setElapsed(performance.now() - startRef.current), TICK_MS)
    return () => window.clearInterval(id)
  }, [phase])

  const clearTimers = () => {
    for (const t of [flipBackTimer, popTimer, panelTimer]) {
      if (t.current !== null) {
        window.clearTimeout(t.current)
        t.current = null
      }
    }
  }

  // no pending flip-back or panel timer may outlive the window
  useEffect(() => clearTimers, [])

  const flip = (i: number) => {
    // two cards up means the mismatch beat is still playing out
    if (matched[i] || faceUp.includes(i) || faceUp.length === 2) return
    sounds.click()
    if (phase === 'idle') {
      startRef.current = now()
      setPhase('playing')
    }
    if (faceUp.length === 0) {
      setFaceUp([i])
      return
    }
    const pair = [faceUp[0], i]
    const movesNow = moves + 1
    setMoves(movesNow)
    if (deck[pair[0]] !== deck[pair[1]]) {
      setFaceUp(pair)
      flipBackTimer.current = window.setTimeout(() => {
        flipBackTimer.current = null
        sounds.miss()
        setFaceUp([])
      }, FLIP_BACK_MS)
      return
    }
    const nextMatched = matched.slice()
    nextMatched[pair[0]] = true
    nextMatched[pair[1]] = true
    setMatched(nextMatched)
    setFaceUp([])
    setJustMatched(pair)
    sounds.point()
    if (popTimer.current !== null) window.clearTimeout(popTimer.current)
    popTimer.current = window.setTimeout(() => setJustMatched([]), POP_MS)
    if (nextMatched.every(Boolean)) {
      const ms = Math.round(now() - startRef.current)
      setElapsed(ms)
      setPhase('cleared')
      sounds.fanfare()
      const res: Result = { ms, moves: movesNow, improved: best === null || ms < best }
      void submit(ms)
      // let the last pair finish its flip before the panel covers it
      panelTimer.current = window.setTimeout(() => setResult(res), CLEAR_PANEL_MS)
    }
  }

  const newGame = () => {
    sounds.click()
    clearTimers()
    setDeck(shuffledDeck())
    setMatched(Array<boolean>(CARDS).fill(false))
    setFaceUp([])
    setJustMatched([])
    setMoves(0)
    setElapsed(0)
    setPhase('idle')
    setResult(null)
  }

  const header = (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-stone-500">time</span>
      <Led value={formatScore('memory', elapsed)} label="Time elapsed" />
      <span className="text-[10px] text-stone-500">moves</span>
      <Led value={String(Math.min(99, moves)).padStart(2, '0')} label="Moves" />
      <span className="text-[10px] text-stone-500">best</span>
      <Led value={best !== null ? formatScore('memory', best) : '--'} label="Personal best" />
      <button
        type="button"
        onClick={newGame}
        className={`${XP_BTN} ml-1 px-2 py-1 text-[11px] font-medium text-stone-700`}
      >
        new game
      </button>
    </div>
  )

  return (
    <GameShell
      tabs={[{ id: 'memory', label: 'Memory' }]}
      you={name}
      header={header}
      hint="flip two · pairs stay up"
    >
      <div className="grid h-full grid-cols-4 grid-rows-5 gap-2 p-3 select-none">
        {deck.map((icon, i) => {
          const up = matched[i] || faceUp.includes(i)
          const pop = justMatched.includes(i)
          return (
            <button
              key={i}
              type="button"
              aria-label={up ? `Card ${i + 1}, ${icon}` : `Card ${i + 1}, face down`}
              onClick={() => flip(i)}
              className={`relative [perspective:600px] ${up ? 'cursor-default' : 'cursor-pointer'}`}
            >
              <span
                className={`absolute inset-0 block transition-transform duration-200 [transform-style:preserve-3d] ${
                  pop
                    ? '[transform:rotateY(180deg)_scale(1.08)]'
                    : up
                      ? '[transform:rotateY(180deg)]'
                      : ''
                }`}
              >
                <span className="absolute inset-0 rounded-sm border border-blue-400 bg-gradient-to-br from-blue-600 to-blue-800 shadow-[0_1px_0_rgba(255,255,255,0.35)_inset] [backface-visibility:hidden]">
                  <span className="absolute inset-0 rounded-sm bg-[linear-gradient(135deg,rgba(255,255,255,0.2)_0%,rgba(255,255,255,0)_45%)]" />
                </span>
                <span className="absolute inset-0 flex items-center justify-center rounded-sm border border-stone-400 bg-stone-50 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)] [backface-visibility:hidden] [transform:rotateY(180deg)]">
                  {xpIcon(icon, 32)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      {result && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-stone-100/80 backdrop-blur-[1px]">
          <div className="w-52 overflow-hidden rounded-sm border border-stone-400 bg-stone-100 shadow-md">
            <div className="flex items-center gap-2 border-b border-stone-300 bg-stone-200 px-3 py-1.5">
              <span className="text-xs font-semibold text-stone-700">Board cleared</span>
            </div>
            <div className="flex flex-col items-center gap-0.5 px-4 py-3">
              <p className="font-mono text-xl font-bold tabular-nums text-stone-800">
                {formatScore('memory', result.ms)}
              </p>
              <p className="text-xs text-stone-500">{result.moves} moves</p>
              {result.improved && <p className="text-xs font-semibold text-blue-700">new best</p>}
            </div>
            <div className="flex justify-center border-t border-stone-300 bg-stone-200/60 px-3 py-2">
              <button
                type="button"
                onClick={newGame}
                className={`${XP_BTN} px-3 py-1 text-xs font-medium text-stone-700`}
              >
                new game
              </button>
            </div>
          </div>
        </div>
      )}
    </GameShell>
  )
}
