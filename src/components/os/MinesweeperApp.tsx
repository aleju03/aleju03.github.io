import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BombIcon,
  FlagPennantIcon,
  SmileyIcon,
  SmileyWinkIcon,
  SmileyXEyesIcon,
} from '@phosphor-icons/react'
import { sounds } from './sounds'

/*
  Minesweeper for AlejOS. The classic beginner board, 9x9 with 10 mines.
  Mines are placed after the first reveal (excluding that cell and its
  neighbors) so the opening click always lands on safe ground.
*/

const COLS = 9
const ROWS = 9
const TOTAL = COLS * ROWS
const MINES = 10
const LONG_PRESS_MS = 400

type Status = 'idle' | 'playing' | 'won' | 'lost'

interface Game {
  mines: boolean[]
  counts: number[]
  revealed: boolean[]
  flagged: boolean[]
  status: Status
  /** index of the mine that ended the game, -1 otherwise */
  lostAt: number
}

function neighborsOf(i: number): number[] {
  const row = Math.floor(i / COLS)
  const col = i % COLS
  const out: number[] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const r = row + dr
      const c = col + dc
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) out.push(r * COLS + c)
    }
  }
  return out
}

function freshGame(): Game {
  return {
    mines: Array<boolean>(TOTAL).fill(false),
    counts: Array<number>(TOTAL).fill(0),
    revealed: Array<boolean>(TOTAL).fill(false),
    flagged: Array<boolean>(TOTAL).fill(false),
    status: 'idle',
    lostAt: -1,
  }
}

function placeMines(safe: number): { mines: boolean[]; counts: number[] } {
  const banned = new Set([safe, ...neighborsOf(safe)])
  const pool: number[] = []
  for (let i = 0; i < TOTAL; i++) if (!banned.has(i)) pool.push(i)
  const mines = Array<boolean>(TOTAL).fill(false)
  for (let k = 0; k < MINES; k++) {
    const j = k + Math.floor(Math.random() * (pool.length - k))
    const tmp = pool[k]
    pool[k] = pool[j]
    pool[j] = tmp
    mines[pool[k]] = true
  }
  const counts = Array<number>(TOTAL).fill(0)
  for (let i = 0; i < TOTAL; i++) {
    if (mines[i]) continue
    counts[i] = neighborsOf(i).filter((n) => mines[n]).length
  }
  return { mines, counts }
}

/** breadth-first reveal that opens whole zero regions plus their border */
function flood(start: number, mines: boolean[], counts: number[], revealed: boolean[]): boolean[] {
  const next = revealed.slice()
  const queue = [start]
  next[start] = true
  while (queue.length > 0) {
    const i = queue.pop() as number
    if (counts[i] !== 0) continue
    for (const n of neighborsOf(i)) {
      if (!next[n] && !mines[n]) {
        next[n] = true
        queue.push(n)
      }
    }
  }
  return next
}

const NUMBER_COLORS = [
  '',
  'text-blue-700',
  'text-green-700',
  'text-red-600',
  'text-indigo-800',
  'text-amber-800',
  'text-teal-700',
  'text-stone-800',
  'text-stone-500',
]

const pad3 = (n: number) => String(Math.max(0, Math.min(999, n))).padStart(3, '0')

export function MinesweeperApp() {
  const [game, setGame] = useState<Game>(freshGame)
  const [seconds, setSeconds] = useState(0)
  const pressTimer = useRef<number | null>(null)
  const suppressClick = useRef(false)

  const over = game.status === 'won' || game.status === 'lost'

  useEffect(() => {
    if (game.status !== 'playing') return
    const id = window.setInterval(() => setSeconds((s) => Math.min(999, s + 1)), 1000)
    return () => window.clearInterval(id)
  }, [game.status])

  // make sure a pending long-press timer never outlives the window
  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    },
    [],
  )

  const reveal = (i: number) => {
    if (over || game.flagged[i] || game.revealed[i]) return
    let { mines, counts } = game
    let status: Status = game.status
    if (status === 'idle') {
      ;({ mines, counts } = placeMines(i))
      status = 'playing'
    }
    if (mines[i]) {
      sounds.error()
      setGame({ ...game, mines, counts, status: 'lost', lostAt: i })
      return
    }
    const revealed = flood(i, mines, counts, game.revealed)
    const opened = revealed.filter(Boolean).length
    if (opened === TOTAL - MINES) {
      sounds.open()
      setGame({ mines, counts, revealed, flagged: mines.slice(), status: 'won', lostAt: -1 })
      return
    }
    setGame({ ...game, mines, counts, revealed, status })
  }

  const toggleFlag = (i: number) => {
    if (over || game.revealed[i]) return
    sounds.click()
    const flagged = game.flagged.slice()
    flagged[i] = !flagged[i]
    setGame({ ...game, flagged })
  }

  const reset = () => {
    sounds.click()
    setGame(freshGame())
    setSeconds(0)
  }

  const startPress = (i: number) => (e: React.PointerEvent) => {
    suppressClick.current = false
    if (e.pointerType === 'mouse') return
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      suppressClick.current = true
      toggleFlag(i)
    }, LONG_PRESS_MS)
  }

  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  const flagsUsed = game.flagged.filter(Boolean).length

  const face =
    game.status === 'lost' ? (
      <SmileyXEyesIcon size={20} weight="fill" className="text-blue-700" />
    ) : game.status === 'won' ? (
      <SmileyWinkIcon size={20} weight="fill" className="text-blue-700" />
    ) : (
      <SmileyIcon size={20} weight="fill" className="text-blue-700" />
    )

  return (
    <div className="flex h-full flex-col bg-stone-100">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4 select-none">
        <div className="flex w-[252px] items-center justify-between rounded-sm border border-stone-400 bg-white px-2 py-1.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]">
          <span
            aria-label="Mines remaining"
            className="rounded-sm bg-stone-900 px-1.5 py-0.5 font-mono text-sm font-bold text-red-500"
          >
            {pad3(MINES - flagsUsed)}
          </span>
          <button
            type="button"
            aria-label="New game"
            onClick={reset}
            className="flex size-8 cursor-pointer items-center justify-center rounded-sm border border-stone-400 bg-stone-200 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600"
          >
            {face}
          </button>
          <span
            aria-label="Seconds elapsed"
            className="rounded-sm bg-stone-900 px-1.5 py-0.5 font-mono text-sm font-bold text-red-500"
          >
            {pad3(seconds)}
          </span>
        </div>

        <div
          className="grid touch-none grid-cols-9 border border-stone-400"
          onContextMenu={(e) => e.preventDefault()}
        >
          {Array.from({ length: TOTAL }, (_, i) => {
            const isRevealed = game.revealed[i]
            const showMine = game.status === 'lost' && game.mines[i] && !game.flagged[i]
            const flat = isRevealed || showMine

            let content: ReactNode = null
            if (game.flagged[i] && !isRevealed) {
              content = <FlagPennantIcon size={14} weight="fill" className="text-red-600" />
            } else if (showMine) {
              content = <BombIcon size={14} weight="fill" className="text-stone-900" />
            } else if (isRevealed && game.counts[i] > 0) {
              content = (
                <span className={`font-mono text-[13px] font-bold ${NUMBER_COLORS[game.counts[i]]}`}>
                  {game.counts[i]}
                </span>
              )
            }

            const surface =
              game.lostAt === i
                ? 'border border-stone-300 bg-red-200'
                : flat
                  ? 'border border-stone-300 bg-stone-200'
                  : 'border-2 border-t-white border-l-white border-r-stone-500 border-b-stone-500 bg-stone-300'

            return (
              <button
                key={i}
                type="button"
                aria-label={`Cell ${Math.floor(i / COLS) + 1}, ${(i % COLS) + 1}`}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false
                    return
                  }
                  reveal(i)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (suppressClick.current) return
                  toggleFlag(i)
                }}
                onPointerDown={startPress(i)}
                onPointerMove={cancelPress}
                onPointerUp={cancelPress}
                onPointerCancel={cancelPress}
                className={`flex size-7 items-center justify-center ${surface} ${
                  !flat && !over ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                {content}
              </button>
            )
          })}
        </div>
      </div>
      <p className="border-t border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-500">
        left click reveal · right click flag
      </p>
    </div>
  )
}
