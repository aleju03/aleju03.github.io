import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BombIcon,
  CaretDownIcon,
  CheckIcon,
  FlagPennantIcon,
  SmileyIcon,
  SmileyWinkIcon,
  SmileyXEyesIcon,
} from '@phosphor-icons/react'
import { sounds } from './sounds'
import { GameShell, Led, XP_BTN } from './games/ui'
import { formatScore, useArcade, useLeaderboard } from './games/arcade'
import type { GameId } from './games/arcade'

/*
  Minesweeper for AlejOS, the full kit this time: the three classic boards
  behind a Game menu, chording on the numbers, and a shared best-time board
  per difficulty. Mines are placed after the first reveal (excluding that
  cell and its neighbors) so the opening click always lands on safe ground.
*/

interface Difficulty {
  id: GameId
  label: string
  cols: number
  rows: number
  mines: number
  /** cell edge in px; bigger boards get slightly smaller cells */
  cell: number
}

const DIFFS: Difficulty[] = [
  { id: 'mine-beginner', label: 'Beginner', cols: 9, rows: 9, mines: 10, cell: 28 },
  { id: 'mine-intermediate', label: 'Intermediate', cols: 16, rows: 16, mines: 40, cell: 24 },
  { id: 'mine-expert', label: 'Expert', cols: 30, rows: 16, mines: 99, cell: 22 },
]

const DIFF_KEY = 'alejos-minesweeper-diff'
const LONG_PRESS_MS = 400

const loadDiff = (): Difficulty => {
  try {
    const id = localStorage.getItem(DIFF_KEY)
    return DIFFS.find((d) => d.id === id) ?? DIFFS[0]
  } catch {
    return DIFFS[0]
  }
}

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

function neighborsOf(i: number, cols: number, rows: number): number[] {
  const row = Math.floor(i / cols)
  const col = i % cols
  const out: number[] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const r = row + dr
      const c = col + dc
      if (r >= 0 && r < rows && c >= 0 && c < cols) out.push(r * cols + c)
    }
  }
  return out
}

function freshGame(total: number): Game {
  return {
    mines: Array<boolean>(total).fill(false),
    counts: Array<number>(total).fill(0),
    revealed: Array<boolean>(total).fill(false),
    flagged: Array<boolean>(total).fill(false),
    status: 'idle',
    lostAt: -1,
  }
}

function placeMines(diff: Difficulty, safe: number): { mines: boolean[]; counts: number[] } {
  const total = diff.cols * diff.rows
  const banned = new Set([safe, ...neighborsOf(safe, diff.cols, diff.rows)])
  const pool: number[] = []
  for (let i = 0; i < total; i++) if (!banned.has(i)) pool.push(i)
  const mines = Array<boolean>(total).fill(false)
  for (let k = 0; k < diff.mines; k++) {
    const j = k + Math.floor(Math.random() * (pool.length - k))
    const tmp = pool[k]
    pool[k] = pool[j]
    pool[j] = tmp
    mines[pool[k]] = true
  }
  const counts = Array<number>(total).fill(0)
  for (let i = 0; i < total; i++) {
    if (mines[i]) continue
    counts[i] = neighborsOf(i, diff.cols, diff.rows).filter((n) => mines[n]).length
  }
  return { mines, counts }
}

/** breadth-first reveal that opens whole zero regions plus their border */
function flood(
  start: number,
  diff: Difficulty,
  mines: boolean[],
  counts: number[],
  revealed: boolean[],
): boolean[] {
  const next = revealed.slice()
  const queue = [start]
  next[start] = true
  while (queue.length > 0) {
    const i = queue.pop() as number
    if (counts[i] !== 0) continue
    for (const n of neighborsOf(i, diff.cols, diff.rows)) {
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

// the wall clock, hidden from the compiler so handlers may read it freely
const now = () => performance.now()

function Board({ diff }: { diff: Difficulty }) {
  const total = diff.cols * diff.rows
  const { best, submit } = useLeaderboard(diff.id)
  const [game, setGame] = useState<Game>(() => freshGame(total))
  const [seconds, setSeconds] = useState(0)
  const [result, setResult] = useState<{ ms: number; improved: boolean } | null>(null)
  const startAtRef = useRef(0)
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

  const finishWin = (state: Omit<Game, 'status' | 'lostAt'>) => {
    const ms = Math.max(1000, Math.round(now() - startAtRef.current))
    const improved = best === null || ms < best
    setResult({ ms, improved })
    setGame({ ...state, flagged: state.mines.slice(), status: 'won', lostAt: -1 })
    if (improved) sounds.fanfare()
    else sounds.open()
    void submit(ms)
  }

  /** open a set of cells at once; any mine among them ends the game there */
  const openCells = (cells: number[], base: Game) => {
    let { mines, counts } = base
    let status: Status = base.status
    if (status === 'idle') {
      ;({ mines, counts } = placeMines(diff, cells[0]))
      status = 'playing'
      startAtRef.current = now()
    }
    const hitMine = cells.find((i) => mines[i])
    if (hitMine !== undefined) {
      sounds.error()
      setGame({ ...base, mines, counts, status: 'lost', lostAt: hitMine })
      return
    }
    let revealed = base.revealed
    for (const i of cells) {
      if (!revealed[i]) revealed = flood(i, diff, mines, counts, revealed)
    }
    const opened = revealed.filter(Boolean).length
    if (opened === total - diff.mines) {
      finishWin({ mines, counts, revealed, flagged: base.flagged })
      return
    }
    setGame({ ...base, mines, counts, revealed, status })
  }

  const reveal = (i: number) => {
    if (over || game.flagged[i]) return
    if (game.revealed[i]) {
      // chording: a number with all its flags placed opens the rest around it
      if (game.counts[i] === 0) return
      const around = neighborsOf(i, diff.cols, diff.rows)
      const flags = around.filter((n) => game.flagged[n]).length
      if (flags !== game.counts[i]) return
      const targets = around.filter((n) => !game.flagged[n] && !game.revealed[n])
      if (targets.length > 0) openCells(targets, game)
      return
    }
    openCells([i], game)
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
    setGame(freshGame(total))
    setSeconds(0)
    setResult(null)
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

  const boardW = diff.cols * diff.cell

  return (
    <div className="flex h-full flex-col items-center gap-3 overflow-auto p-4 select-none">
      <div
        style={{ width: boardW }}
        className="flex min-w-56 items-center justify-between rounded-sm border border-stone-400 bg-white px-2 py-1.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
      >
        <Led label="Mines remaining" value={pad3(diff.mines - flagsUsed)} />
        <button
          type="button"
          aria-label="New game"
          onClick={reset}
          className={`${XP_BTN} flex size-8 items-center justify-center`}
        >
          {face}
        </button>
        <Led label="Seconds elapsed" value={pad3(seconds)} />
      </div>

      {game.status === 'won' && result && (
        <p className="text-xs text-stone-600">
          cleared in <b className="font-mono">{formatScore(diff.id, result.ms)}</b>
          {result.improved && <span className="text-amber-600"> · new best</span>}
        </p>
      )}

      <div
        className="grid touch-none border border-stone-400"
        style={{ gridTemplateColumns: `repeat(${diff.cols}, ${diff.cell}px)` }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {Array.from({ length: total }, (_, i) => {
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
              aria-label={`Cell ${Math.floor(i / diff.cols) + 1}, ${(i % diff.cols) + 1}`}
              style={{ width: diff.cell, height: diff.cell }}
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
              className={`flex items-center justify-center ${surface} ${
                !flat && !over ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              {content}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function MinesweeperApp() {
  const [diff, setDiff] = useState<Difficulty>(loadDiff)
  const [menuOpen, setMenuOpen] = useState(false)
  const { name } = useArcade()

  const pickDiff = (d: Difficulty) => {
    sounds.click()
    setMenuOpen(false)
    setDiff(d)
    try {
      localStorage.setItem(DIFF_KEY, d.id)
    } catch {
      /* storage unavailable; the pick still applies this session */
    }
  }

  return (
    <GameShell
      tabs={DIFFS.map((d) => ({ id: d.id, label: d.label }))}
      you={name}
      hint="left click reveal · right click flag · click a number to chord"
      header={
        <div className="relative flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              sounds.click()
              setMenuOpen((o) => !o)
            }}
            className={`${XP_BTN} flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-stone-700`}
          >
            Game
            <CaretDownIcon size={10} weight="bold" className="text-stone-500" />
          </button>
          {menuOpen && (
            <>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
              />
              <div className="absolute top-full left-0 z-20 mt-1 w-40 rounded-sm border border-stone-400 bg-stone-50 py-1 shadow-lg shadow-stone-950/20">
                {DIFFS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => pickDiff(d)}
                    className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs text-stone-700 hover:bg-blue-600/10"
                  >
                    <span className="w-3">
                      {d.id === diff.id && <CheckIcon size={12} weight="bold" />}
                    </span>
                    {d.label}
                    <span className="ml-auto font-mono text-[10px] text-stone-400">
                      {d.cols}x{d.rows}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <span className="text-[11px] text-stone-500">{diff.label}</span>
        </div>
      }
    >
      {/* a difficulty change is a whole new board, timers and all */}
      <Board key={diff.id} diff={diff} />
    </GameShell>
  )
}
