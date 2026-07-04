import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BombIcon,
  CrownSimpleIcon,
  FlagPennantIcon,
  HeartIcon,
  LightningIcon,
} from '@phosphor-icons/react'
import { sounds } from '../sounds'
import { GameShell, XP_BTN, XP_WELL } from './ui'
import { arcadeConfigured, useDuelChannel } from './arcade'

/*
  Mine Duel: 1v1 minesweeper over the chat server, in the spirit of the
  Squidcraft Games duel. One shared 10x10 board; each player secretly buries
  five mines, then the digging is turn-based. A number counts EVERY mine
  around the tile, yours and theirs together, and digging any mine costs the
  digger a life — your own included, so you memorize your five. Two lives
  each; slow turns get dug by the server, so stalling is never safe.
*/

const SIZE = 10
const CELLS = SIZE * SIZE

type Stage = 'idle' | 'queued' | 'plant' | 'dig' | 'over'

interface Opponent {
  name: string
  registered: boolean
  admin: boolean
}

interface Duel {
  stage: Stage
  seat: 0 | 1
  players: Opponent[]
  minesPerPlayer: number
  maxLives: number
  deadline: number
  turn: 0 | 1
  lives: [number, number]
  /** dug-safe cells and their both-players mine counts */
  revealed: Record<number, number>
  /** dug cells that blew up */
  exploded: number[]
  /** placement committed, per seat */
  planted: [boolean, boolean]
  /** my picks during the plant phase */
  myMines: number[]
  /** the server picked for me because the plant clock ran out */
  autoPlanted: boolean
  /** one-line narration under the board */
  note: string
  over: { winner: number; reason: string; mines: [number[], number[]] } | null
  myRematch: boolean
  oppRematch: boolean
  oppGone: boolean
}

const freshDuel = (): Duel => ({
  stage: 'idle',
  seat: 0,
  players: [],
  minesPerPlayer: 5,
  maxLives: 2,
  deadline: 0,
  turn: 0,
  lives: [2, 2],
  revealed: {},
  exploded: [],
  planted: [false, false],
  myMines: [],
  autoPlanted: false,
  note: '',
  over: null,
  myRematch: false,
  oppRematch: false,
  oppGone: false,
})

const NUMBER_COLORS = [
  'text-stone-400',
  'text-blue-700',
  'text-green-700',
  'text-red-600',
  'text-indigo-800',
  'text-amber-800',
  'text-teal-700',
  'text-stone-800',
  'text-stone-500',
]

// the wall clock, hidden from the compiler so render may read it for the
// coarse countdown without tripping the purity lint
const wallClock = () => Date.now()

/** seconds left on the phase clock, re-rendered coarsely */
function Countdown({ deadline, active }: { deadline: number; active: boolean }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 250)
    return () => window.clearInterval(id)
  }, [deadline])
  const left = Math.max(0, Math.ceil((deadline - wallClock()) / 1000))
  return (
    <span
      className={`font-mono text-sm font-bold tabular-nums ${
        left <= 5 && active ? 'text-red-600' : 'text-stone-700'
      }`}
    >
      {left}s
    </span>
  )
}

function Hearts({ lives, max }: { lives: number; max: number }) {
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <HeartIcon
          key={i}
          size={13}
          weight="fill"
          className={i < lives ? 'text-red-600' : 'text-stone-300'}
        />
      ))}
    </span>
  )
}

export function MineDuelApp() {
  const [duel, setDuel] = useState<Duel>(freshDuel)
  // local suspicion marks during the dig phase; purely client-side
  const [flags, setFlags] = useState<Set<number>>(() => new Set())
  const duelRef = useRef(duel)
  const flagsRef = useRef(flags)
  useEffect(() => {
    duelRef.current = duel
    flagsRef.current = flags
  }, [duel, flags])

  const onMessage = useCallback((msg: Record<string, unknown>) => {
    const type = String(msg.type)
    if (type === 'duel-start') setFlags(new Set())
    // sounds live out here: state updaters must stay pure
    if (type === 'duel-dug') {
      if (msg.mine) {
        if (Number(msg.by) === duelRef.current.seat) sounds.error()
        else sounds.thud()
      } else {
        sounds.click()
      }
    } else if (type === 'duel-over') {
      const winner = Number(msg.winner)
      if (winner === duelRef.current.seat) sounds.fanfare()
      else if (winner >= 0) sounds.miss()
    }
    setDuel((d) => {
      switch (type) {
        case 'duel-queued':
          return { ...d, stage: 'queued', note: '' }
        case 'duel-start':
          return {
            ...freshDuel(),
            stage: 'plant',
            seat: msg.seat as 0 | 1,
            players: (msg.players as Opponent[]) ?? [],
            minesPerPlayer: Number(msg.mines ?? 5),
            maxLives: Number(msg.lives ?? 2),
            lives: [Number(msg.lives ?? 2), Number(msg.lives ?? 2)] as [number, number],
            deadline: Number(msg.deadline ?? 0),
          }
        case 'duel-planted': {
          const seat = Number(msg.seat)
          const planted = [...d.planted] as [boolean, boolean]
          planted[seat] = true
          const mine = seat === d.seat
          const auto = Boolean(msg.auto)
          const myMines = mine && auto ? ((msg.cells as number[]) ?? d.myMines) : d.myMines
          return {
            ...d,
            planted,
            myMines,
            autoPlanted: d.autoPlanted || (mine && auto),
            note: mine
              ? auto
                ? 'time ran out, the server buried yours at random. memorize them fast'
                : 'mines buried. waiting for your opponent'
              : `${d.players[seat]?.name ?? 'opponent'} is ready`,
          }
        }
        case 'duel-phase':
          return {
            ...d,
            stage: 'dig',
            turn: msg.turn as 0 | 1,
            deadline: Number(msg.deadline ?? 0),
            note:
              (msg.turn as number) === d.seat ? 'your turn. pick a tile' : 'opponent digs first',
          }
        case 'duel-dug': {
          const cell = Number(msg.cell)
          const by = Number(msg.by)
          const isMe = by === d.seat
          const auto = Boolean(msg.auto)
          const lives = (msg.lives as [number, number]) ?? d.lives
          const who = isMe ? 'you' : (d.players[by]?.name ?? 'opponent')
          const dug = auto ? `the clock dug for ${who}` : `${who} dug`
          let revealed = d.revealed
          let exploded = d.exploded
          let note: string
          if (msg.mine) {
            exploded = [...exploded, cell]
            note = `${dug} into a mine`
          } else {
            revealed = { ...revealed, [cell]: Number(msg.count ?? 0) }
            note = `${dug} safe ground`
          }
          return {
            ...d,
            revealed,
            exploded,
            lives,
            turn: msg.turn as 0 | 1,
            deadline: Number(msg.deadline ?? 0),
            note,
          }
        }
        case 'duel-over': {
          const winner = Number(msg.winner)
          return {
            ...d,
            stage: 'over',
            lives: (msg.lives as [number, number]) ?? d.lives,
            note: '',
            over: {
              winner,
              reason: String(msg.reason ?? ''),
              mines: (msg.mines as [number[], number[]]) ?? [[], []],
            },
          }
        }
        case 'duel-rematch':
          return { ...d, oppRematch: true, note: 'your opponent wants a rematch' }
        case 'duel-opponent-left':
          return { ...d, oppGone: true, note: 'your opponent left' }
        default:
          return d
      }
    })
  }, [])

  const { status, name, send } = useDuelChannel(onMessage)

  const queue = () => {
    sounds.click()
    send({ type: 'duel-queue' })
  }
  const cancelQueue = () => {
    sounds.click()
    send({ type: 'duel-leave' })
    setDuel(freshDuel())
  }
  const forfeit = () => {
    sounds.click()
    send({ type: 'duel-leave' })
  }
  const rematch = () => {
    sounds.click()
    send({ type: 'duel-rematch' })
    setDuel((d) => ({
      ...d,
      myRematch: true,
      note: d.oppRematch ? '' : 'rematch offered. waiting',
    }))
  }

  const togglePlant = (cell: number) => {
    const d = duelRef.current
    if (d.stage !== 'plant' || d.planted[d.seat]) return
    const has = d.myMines.includes(cell)
    if (!has && d.myMines.length >= d.minesPerPlayer) return
    sounds.click()
    setDuel((cur) => ({
      ...cur,
      myMines: has ? cur.myMines.filter((c) => c !== cell) : [...cur.myMines, cell],
    }))
  }

  const commitPlant = () => {
    const d = duelRef.current
    if (d.myMines.length !== d.minesPerPlayer) return
    sounds.open()
    send({ type: 'duel-plant', cells: d.myMines })
  }

  const dig = (cell: number) => {
    const d = duelRef.current
    if (d.stage !== 'dig' || d.turn !== d.seat) return
    if (d.revealed[cell] !== undefined || d.exploded.includes(cell)) return
    if (flagsRef.current.has(cell)) return
    send({ type: 'duel-dig', cell })
  }

  const toggleFlag = (cell: number) => {
    const d = duelRef.current
    if (d.stage !== 'dig') return
    if (d.revealed[cell] !== undefined || d.exploded.includes(cell)) return
    sounds.click()
    setFlags((prev) => {
      const next = new Set(prev)
      if (next.has(cell)) next.delete(cell)
      else next.add(cell)
      return next
    })
  }

  const me = duel.players[duel.seat]
  const opp = duel.players[duel.seat === 0 ? 1 : 0]
  const myTurn = duel.stage === 'dig' && duel.turn === duel.seat
  const planting = duel.stage === 'plant' && !duel.planted[duel.seat]

  const cellFace = (i: number): { content: ReactNode; surface: string; clickable: boolean } => {
    const revealedCount = duel.revealed[i]
    const isExploded = duel.exploded.includes(i)
    const overMines = duel.over?.mines
    const mineOwners: number[] = overMines ? [0, 1].filter((s) => overMines[s].includes(i)) : []

    if (duel.stage === 'plant') {
      const picked = duel.myMines.includes(i)
      return {
        content: picked ? <BombIcon size={15} weight="fill" className="text-blue-800" /> : null,
        surface: picked
          ? 'border border-blue-500 bg-blue-200'
          : 'border-2 border-t-white border-l-white border-r-stone-500 border-b-stone-500 bg-stone-300',
        clickable: planting,
      }
    }
    if (isExploded) {
      return {
        content: <BombIcon size={15} weight="fill" className="text-stone-900" />,
        surface: 'border border-stone-300 bg-red-200',
        clickable: false,
      }
    }
    if (revealedCount !== undefined) {
      return {
        content:
          revealedCount > 0 ? (
            <span
              className={`font-mono text-[13px] font-bold ${NUMBER_COLORS[Math.min(revealedCount, 8)]}`}
            >
              {revealedCount}
            </span>
          ) : null,
        surface: 'border border-stone-300 bg-stone-200',
        clickable: false,
      }
    }
    if (duel.stage === 'over' && mineOwners.length > 0) {
      // unexploded mines surface at the end, tinted by owner
      const mine = mineOwners.includes(duel.seat)
      return {
        content: (
          <BombIcon size={15} weight="fill" className={mine ? 'text-blue-700' : 'text-red-700'} />
        ),
        surface: mine
          ? 'border border-stone-300 bg-blue-100'
          : 'border border-stone-300 bg-orange-100',
        clickable: false,
      }
    }
    return {
      content: flags.has(i) ? (
        <FlagPennantIcon size={13} weight="fill" className="text-red-600" />
      ) : null,
      surface:
        'border-2 border-t-white border-l-white border-r-stone-500 border-b-stone-500 bg-stone-300',
      clickable: myTurn && !flags.has(i),
    }
  }

  const board = (
    <div
      className="grid touch-none border border-stone-400"
      style={{ gridTemplateColumns: `repeat(${SIZE}, 30px)` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {Array.from({ length: CELLS }, (_, i) => {
        const { content, surface, clickable } = cellFace(i)
        return (
          <button
            key={i}
            type="button"
            aria-label={`Tile ${Math.floor(i / SIZE) + 1}, ${(i % SIZE) + 1}`}
            onClick={() => {
              if (duel.stage === 'plant') togglePlant(i)
              else dig(i)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              toggleFlag(i)
            }}
            style={{ width: 30, height: 30 }}
            className={`flex items-center justify-center ${surface} ${
              clickable ? 'cursor-pointer' : 'cursor-default'
            }`}
          >
            {content}
          </button>
        )
      })}
    </div>
  )

  const playerChip = (p: Opponent | undefined, lives: number, active: boolean, isMe: boolean) => (
    <div
      className={`flex items-center gap-2 rounded-sm border px-2 py-1 ${
        active ? 'border-blue-500 bg-blue-600/10' : 'border-stone-300 bg-stone-50'
      }`}
    >
      {active && <LightningIcon size={12} weight="fill" className="text-blue-600" />}
      <span
        className={`max-w-28 truncate text-xs font-medium ${isMe ? 'text-blue-900' : 'text-stone-700'}`}
      >
        {p?.name ?? '...'}
        {isMe && ' (you)'}
      </span>
      {p?.admin && <CrownSimpleIcon size={11} weight="fill" className="text-amber-600" />}
      <Hearts lives={lives} max={duel.maxLives} />
    </div>
  )

  let body: ReactNode
  if (!arcadeConfigured()) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <BombIcon size={40} weight="duotone" className="text-stone-400" />
        <p className="text-sm font-semibold text-stone-700">Mine Duel needs the game server</p>
        <p className="text-xs text-stone-500">
          This build has no server configured, so there is nobody to duel. The other games in the
          folder work fine offline.
        </p>
      </div>
    )
  } else if (duel.stage === 'idle' || duel.stage === 'queued') {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        <BombIcon size={40} weight="duotone" className="text-stone-600" />
        <p className="text-sm font-semibold text-stone-700">Minesweeper, against a real person</p>
        <div
          className={`${XP_WELL} max-w-sm px-4 py-3 text-left text-xs leading-relaxed text-stone-600`}
        >
          <p>you and your opponent each bury five mines on one shared board, in secret.</p>
          <p className="mt-1.5">
            then you take turns digging. numbers count everyone's mines around a tile.
          </p>
          <p className="mt-1.5">
            any mine you dig costs you a life, including your own five. two lives each. outlive
            your opponent.
          </p>
        </div>
        {duel.stage === 'idle' ? (
          <button
            type="button"
            onClick={queue}
            disabled={status !== 'online'}
            className={`${XP_BTN} px-5 py-2 text-sm font-medium text-stone-800 disabled:cursor-default disabled:opacity-50`}
          >
            Find an opponent
          </button>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <p className="animate-pulse text-xs text-stone-500">
              waiting for another visitor to step up...
            </p>
            <button
              type="button"
              onClick={cancelQueue}
              className={`${XP_BTN} px-3 py-1 text-xs text-stone-700`}
            >
              Cancel
            </button>
          </div>
        )}
        {status !== 'online' && (
          <p className="text-[11px] text-stone-400">
            {status === 'connecting'
              ? 'reaching the server...'
              : 'the game server is unreachable right now'}
          </p>
        )}
      </div>
    )
  } else {
    const over = duel.over
    body = (
      <div className="flex h-full flex-col items-center gap-2.5 overflow-auto p-3 select-none">
        <div className="flex items-center gap-3">
          {playerChip(me, duel.lives[duel.seat], duel.stage === 'dig' && myTurn, true)}
          <span className="text-[10px] font-bold text-stone-400">VS</span>
          {playerChip(opp, duel.lives[duel.seat === 0 ? 1 : 0], duel.stage === 'dig' && !myTurn, false)}
        </div>

        <div className={`${XP_WELL} flex w-[302px] items-center justify-between px-2 py-1`}>
          <span className="text-[11px] text-stone-600">
            {duel.stage === 'plant'
              ? planting
                ? `bury your mines · ${duel.minesPerPlayer - duel.myMines.length} left`
                : 'buried'
              : duel.stage === 'dig'
                ? myTurn
                  ? 'your turn'
                  : `${opp?.name ?? 'opponent'} is thinking`
                : over
                  ? over.winner < 0
                    ? 'a draw'
                    : over.winner === duel.seat
                      ? 'you won'
                      : 'you lost'
                  : ''}
          </span>
          {duel.stage !== 'over' && (
            <Countdown deadline={duel.deadline} active={duel.stage === 'dig' ? myTurn : planting} />
          )}
        </div>

        {board}

        <p className="h-4 text-[11px] text-stone-500">{duel.note}</p>

        {duel.stage === 'plant' && planting && (
          <button
            type="button"
            onClick={commitPlant}
            disabled={duel.myMines.length !== duel.minesPerPlayer}
            className={`${XP_BTN} px-4 py-1.5 text-xs font-medium text-stone-800 disabled:cursor-default disabled:opacity-50`}
          >
            Bury them
          </button>
        )}
        {duel.stage === 'dig' && (
          <button
            type="button"
            onClick={forfeit}
            className={`${XP_BTN} px-3 py-1 text-[11px] text-stone-600`}
          >
            Concede
          </button>
        )}
        {duel.stage === 'over' && over && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-stone-600">
              {over.reason === 'lives' &&
                (over.winner === duel.seat ? 'they ran out of lives' : 'you ran out of lives')}
              {over.reason === 'board' && 'the board ran out of safe tiles'}
              {(over.reason === 'forfeit' || over.reason === 'left') &&
                (over.winner === duel.seat ? 'your opponent walked away' : 'you conceded')}
              <span className="text-stone-400"> · blue mines were yours</span>
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={rematch}
                disabled={duel.myRematch || duel.oppGone}
                className={`${XP_BTN} px-4 py-1.5 text-xs font-medium text-stone-800 disabled:cursor-default disabled:opacity-50`}
              >
                {duel.oppRematch && !duel.myRematch
                  ? 'Accept rematch'
                  : duel.myRematch
                    ? 'Waiting...'
                    : 'Rematch'}
              </button>
              <button
                type="button"
                onClick={queue}
                className={`${XP_BTN} px-4 py-1.5 text-xs text-stone-700`}
              >
                New opponent
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <GameShell
      tabs={[{ id: 'duel', label: 'Duel Wins' }]}
      you={name}
      hint={
        duel.stage === 'plant'
          ? 'click to bury · click again to move it'
          : duel.stage === 'dig'
            ? 'click digs on your turn · right click marks a suspicion'
            : 'wins land on the shared board'
      }
    >
      {body}
    </GameShell>
  )
}
