import { useEffect, useRef, useState } from 'react'
import { sounds } from '../sounds'
import { useLeaderboard } from './arcade'
import { GameShell, Led, XP_BTN } from './ui'

/*
  2048 for AlejOS. The canonical rules on a 4x4 board: everything slides,
  equal neighbors merge once per move, a fresh 2 (or sometimes 4) drops into
  an empty cell after every move that changed something. Tiles live as a
  keyed list of {id, row, col} and render as absolutely positioned divs, so
  a CSS transition on transform does the sliding; merge results pop and
  spawns scale in via two short keyframes that start after the slide lands.
*/

const SIZE = 4
const SLIDE_MS = 110
const LOCK_MS = 130

type Dir = 'up' | 'down' | 'left' | 'right'

interface Tile {
  id: number
  value: number
  row: number
  col: number
  /** result of a merge this move, pops once the slide lands */
  pop?: boolean
  /** freshly spawned, scales in */
  spawn?: boolean
  /** slid beneath a merge result, pruned after the animation */
  under?: boolean
}

interface GameState {
  tiles: Tile[]
  score: number
  over: boolean
  /** a 2048 tile exists (or existed) this run */
  won: boolean
  /** the win overlay was dismissed with keep going */
  keptGoing: boolean
}

let tileSeq = 1
const allocId = () => tileSeq++

/** the k-th cell of a line, walking in the direction tiles travel */
function cellAt(dir: Dir, line: number, k: number): [number, number] {
  switch (dir) {
    case 'left':
      return [line, k]
    case 'right':
      return [line, SIZE - 1 - k]
    case 'up':
      return [k, line]
    case 'down':
      return [SIZE - 1 - k, line]
  }
}

function liveGrid(tiles: Tile[]): (Tile | null)[][] {
  const grid: (Tile | null)[][] = Array.from({ length: SIZE }, () =>
    Array<Tile | null>(SIZE).fill(null),
  )
  for (const t of tiles) if (!t.under) grid[t.row][t.col] = t
  return grid
}

/** one move: slide every line toward dir, merging equal neighbors once */
function slide(
  tiles: Tile[],
  dir: Dir,
): { next: Tile[]; gained: number; moved: boolean; highest: number } {
  const grid = liveGrid(tiles)
  const next: Tile[] = []
  let gained = 0
  let moved = false
  let highest = 0

  for (let line = 0; line < SIZE; line++) {
    const cells: Tile[] = []
    for (let k = 0; k < SIZE; k++) {
      const [r, c] = cellAt(dir, line, k)
      const t = grid[r][c]
      if (t) cells.push(t)
    }
    let slot = 0
    let prev: Tile | null = null
    let prevMerged = false
    for (const t of cells) {
      if (prev && !prevMerged && prev.value === t.value) {
        // both originals slide under a doubled result on prev's cell
        prev.under = true
        next.push({ id: t.id, value: t.value, row: prev.row, col: prev.col, under: true })
        const result: Tile = {
          id: allocId(),
          value: t.value * 2,
          row: prev.row,
          col: prev.col,
          pop: true,
        }
        next.push(result)
        gained += result.value
        highest = Math.max(highest, result.value)
        moved = true
        prev = result
        prevMerged = true
      } else {
        const [r, c] = cellAt(dir, line, slot)
        slot += 1
        if (r !== t.row || c !== t.col) moved = true
        const placed: Tile = { id: t.id, value: t.value, row: r, col: c }
        next.push(placed)
        prev = placed
        prevMerged = false
      }
    }
  }
  return { next, gained, moved, highest }
}

function spawnTile(tiles: Tile[]): Tile[] {
  const taken = new Set(tiles.filter((t) => !t.under).map((t) => t.row * SIZE + t.col))
  const empty: number[] = []
  for (let i = 0; i < SIZE * SIZE; i++) if (!taken.has(i)) empty.push(i)
  if (empty.length === 0) return tiles
  const cell = empty[Math.floor(Math.random() * empty.length)]
  return [
    ...tiles,
    {
      id: allocId(),
      value: Math.random() < 0.9 ? 2 : 4,
      row: Math.floor(cell / SIZE),
      col: cell % SIZE,
      spawn: true,
    },
  ]
}

function anyMoveLeft(tiles: Tile[]): boolean {
  const grid = liveGrid(tiles)
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const t = grid[r][c]
      if (!t) return true
      if (c < SIZE - 1 && grid[r][c + 1]?.value === t.value) return true
      if (r < SIZE - 1 && grid[r + 1][c]?.value === t.value) return true
    }
  }
  return false
}

function newGame(): GameState {
  return { tiles: spawnTile(spawnTile([])), score: 0, over: false, won: false, keptGoing: false }
}

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  a: 'left',
  s: 'down',
  d: 'right',
}

/** the classic value ramp, retuned to the house stone/amber/orange/blue */
const TILE_STYLE: Record<number, string> = {
  2: 'bg-stone-200 text-stone-700',
  4: 'bg-stone-300 text-stone-700',
  8: 'bg-amber-200 text-amber-900',
  16: 'bg-amber-300 text-amber-950',
  32: 'bg-orange-300 text-orange-950',
  64: 'bg-orange-400 text-white',
  128: 'bg-blue-300 text-blue-950',
  256: 'bg-blue-400 text-white',
  512: 'bg-blue-500 text-white',
  1024: 'bg-blue-600 text-white',
  2048: 'bg-amber-400 text-amber-950 shadow-[0_0_14px_rgba(251,191,36,0.8)]',
}
const TILE_BEYOND = 'bg-stone-800 text-amber-300'

const TILE_CSS = `
@keyframes g2048-spawn { from { transform: scale(0.5); opacity: 0 } to { transform: scale(1); opacity: 1 } }
@keyframes g2048-pop { 0% { transform: scale(1) } 50% { transform: scale(1.15) } 100% { transform: scale(1) } }
`

const padScore = (n: number) => String(Math.max(0, n)).padStart(5, '0')

export function Game2048App() {
  const { name, best, submit } = useLeaderboard('2048')
  const [game, setGame] = useState<GameState>(newGame)
  const wrapRef = useRef<HTMLDivElement>(null)
  const lockRef = useRef(false)
  const pruneTimer = useRef(0)
  const submittedRef = useRef(false)
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    wrapRef.current?.focus()
    return () => window.clearTimeout(pruneTimer.current)
  }, [])

  const doMove = (dir: Dir) => {
    if (lockRef.current || game.over || (game.won && !game.keptGoing)) return
    const { next, gained, moved, highest } = slide(game.tiles, dir)
    if (!moved) return
    const tiles = spawnTile(next)
    const score = game.score + gained
    const wonNow = !game.won && highest >= 2048
    const over = !anyMoveLeft(tiles)

    if (wonNow) sounds.fanfare()
    else if (highest >= 128) sounds.point()
    else if (gained > 0) sounds.thud()
    if (over) sounds.miss()

    setGame({ tiles, score, over, won: game.won || wonNow, keptGoing: game.keptGoing })
    if (over && score > 0 && !submittedRef.current) {
      submittedRef.current = true
      void submit(score)
    }

    // hold input while the slide plays, then drop the tiles it buried
    lockRef.current = true
    window.clearTimeout(pruneTimer.current)
    pruneTimer.current = window.setTimeout(() => {
      lockRef.current = false
      setGame((g) => ({ ...g, tiles: g.tiles.filter((t) => !t.under) }))
    }, LOCK_MS)
  }

  const reset = () => {
    sounds.click()
    window.clearTimeout(pruneTimer.current)
    lockRef.current = false
    submittedRef.current = false
    setGame(newGame())
    wrapRef.current?.focus()
  }

  const keepGoing = () => {
    sounds.click()
    setGame((g) => ({ ...g, keptGoing: true }))
    wrapRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const dir = KEY_DIRS[e.key.length === 1 ? e.key.toLowerCase() : e.key]
    if (!dir) return
    e.preventDefault()
    doMove(dir)
  }

  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current
    touchStart.current = null
    if (!start) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return
    doMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'))
  }

  const shownBest = Math.max(best ?? 0, game.score)
  const sorted = [...game.tiles].sort((a, b) => a.id - b.id)

  return (
    <GameShell
      tabs={[{ id: '2048', label: '2048' }]}
      you={name}
      header={
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-stone-500">score</span>
          <Led value={padScore(game.score)} label="Score" />
          <span className="text-[10px] text-stone-500">best</span>
          <Led value={padScore(shownBest)} label="Best" />
          <button
            type="button"
            onClick={reset}
            className={`${XP_BTN} px-2 py-1 text-[11px] font-medium text-stone-700`}
          >
            new game
          </button>
        </div>
      }
      hint="arrows or swipe · join the numbers"
    >
      <div
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={() => wrapRef.current?.focus()}
        className="flex h-full items-center justify-center outline-none select-none"
      >
        <style>{TILE_CSS}</style>
        <div
          className="touch-none rounded-sm border border-stone-400 bg-stone-300 p-1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.15)]"
          style={{ width: 340, height: 340 }}
          onTouchStart={(e) => {
            const t = e.touches[0]
            touchStart.current = { x: t.clientX, y: t.clientY }
          }}
          onTouchEnd={onTouchEnd}
        >
          <div className="relative h-full w-full">
            {Array.from({ length: SIZE * SIZE }, (_, i) => (
              <div
                key={i}
                className="absolute p-1"
                style={{
                  width: '25%',
                  height: '25%',
                  left: `${(i % SIZE) * 25}%`,
                  top: `${Math.floor(i / SIZE) * 25}%`,
                }}
              >
                <div className="h-full w-full rounded-sm bg-stone-200/60 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]" />
              </div>
            ))}
            {sorted.map((t) => (
              <div
                key={t.id}
                className="absolute top-0 left-0 p-1 transition-transform ease-out"
                style={{
                  width: '25%',
                  height: '25%',
                  transform: `translate(${t.col * 100}%, ${t.row * 100}%)`,
                  transitionDuration: `${SLIDE_MS}ms`,
                }}
              >
                <div
                  className={`flex h-full w-full items-center justify-center rounded-sm font-mono font-bold ${
                    TILE_STYLE[t.value] ?? TILE_BEYOND
                  } ${t.value < 100 ? 'text-2xl' : t.value < 1000 ? 'text-xl' : 'text-lg'}`}
                  style={
                    t.pop
                      ? { animation: `g2048-pop 170ms ease-out ${SLIDE_MS}ms` }
                      : t.spawn
                        ? { animation: `g2048-spawn 150ms ease-out ${SLIDE_MS}ms backwards` }
                        : undefined
                  }
                >
                  {t.value}
                </div>
              </div>
            ))}
            {game.over && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-sm bg-stone-100/85">
                <p className="text-sm font-semibold text-stone-700">no moves left</p>
                <p className="font-mono text-xs text-stone-500">score {game.score}</p>
                <button
                  type="button"
                  onClick={reset}
                  className={`${XP_BTN} px-3 py-1.5 text-xs font-medium text-stone-700`}
                >
                  new game
                </button>
              </div>
            )}
            {game.won && !game.keptGoing && !game.over && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-sm bg-amber-100/85">
                <p className="text-sm font-semibold text-amber-900">you made 2048</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={keepGoing}
                    className={`${XP_BTN} px-3 py-1.5 text-xs font-medium text-stone-700`}
                  >
                    keep going
                  </button>
                  <button
                    type="button"
                    onClick={reset}
                    className={`${XP_BTN} px-3 py-1.5 text-xs font-medium text-stone-700`}
                  >
                    new game
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
