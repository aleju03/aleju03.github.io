import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CrownSimpleIcon, TrophyIcon, XIcon } from '@phosphor-icons/react'
import { sounds } from '../sounds'
import { arcadeConfigured, formatScore, useLeaderboard } from './arcade'
import type { GameId } from './arcade'

/*
  Shared chrome for the Games folder, in the same XP dialect Minesweeper
  speaks: stone-100 panels, inset white wells, LED counters in red mono on
  black. GameShell wraps a game in the standard frame — header strip with
  the game's own cluster plus a High Scores toggle, play area, footer hint —
  and ScoresPanel is the leaderboard overlay itself, usable on its own by
  games with custom layouts.
*/

export const XP_BTN =
  'cursor-pointer rounded-sm border border-stone-400 bg-stone-200 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50'
export const XP_WELL =
  'rounded-sm border border-stone-400 bg-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]'

/** the segment-display counter Minesweeper made the house style */
export function Led({ value, label }: { value: string; label: string }) {
  return (
    <span
      aria-label={label}
      className="rounded-sm bg-stone-900 px-1.5 py-0.5 font-mono text-sm font-bold tabular-nums text-red-500"
    >
      {value}
    </span>
  )
}

const MEDAL_ROWS = [
  'bg-amber-100/80 text-amber-900',
  'bg-stone-200/80 text-stone-700',
  'bg-orange-100/70 text-orange-900',
]

interface ScoresTab {
  id: GameId
  label: string
}

function Board({ game, you }: { game: GameId; you: string }) {
  const lb = useLeaderboard(game)
  const { refresh } = lb

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(id)
  }, [refresh])

  if (!arcadeConfigured()) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-xs text-stone-500">
          No score server on this build, so the board stays local.
        </p>
        {lb.best !== null && (
          <p className="text-xs text-stone-600">
            Your best in this browser: <b className="font-mono">{formatScore(game, lb.best)}</b>
          </p>
        )}
      </div>
    )
  }

  if (!lb.board) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="text-xs text-stone-500">
          {lb.status === 'offline'
            ? 'The score server is unreachable right now.'
            : 'Reaching the score server...'}
        </p>
      </div>
    )
  }

  return (
    <>
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {lb.board.top.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-stone-500">
            Nobody has set a score yet. The board is yours to open.
          </p>
        )}
        {lb.board.top.map((row, i) => {
          const mine = row.name === you
          return (
            <li
              key={`${row.name}-${i}`}
              className={`flex items-center gap-2 rounded-sm px-2 py-1 text-xs ${
                mine ? 'bg-blue-600/15 text-blue-900' : (MEDAL_ROWS[i] ?? 'text-stone-700')
              }`}
            >
              <span className="w-5 shrink-0 text-right font-mono text-stone-500">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {row.name}
                {mine && ' (you)'}
              </span>
              {row.admin && (
                <CrownSimpleIcon size={12} weight="fill" className="shrink-0 text-amber-600" />
              )}
              <span className="shrink-0 font-mono tabular-nums">{formatScore(game, row.score)}</span>
            </li>
          )
        })}
      </ol>
      <p className="border-t border-stone-300 px-3 py-1.5 text-[11px] text-stone-500">
        {lb.board.you
          ? `your best: ${formatScore(game, lb.board.you.score)} · rank #${lb.board.you.rank}`
          : lb.best !== null
            ? `your local best: ${formatScore(game, lb.best)} — play online to enter the board`
            : 'no score of yours on the board yet'}
      </p>
    </>
  )
}

export function ScoresPanel({
  tabs,
  you,
  onClose,
}: {
  /** one tab per board; a single-entry array means no tab strip */
  tabs: ScoresTab[]
  /** the current player's display name, to highlight their row */
  you: string
  onClose: () => void
}) {
  const [active, setActive] = useState<GameId>(tabs[0].id)
  const current = tabs.find((t) => t.id === active) ?? tabs[0]

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-stone-100/97 backdrop-blur-[1px]">
      <div className="flex items-center gap-2 border-b border-stone-300 bg-stone-200 px-3 py-1.5">
        <TrophyIcon size={14} weight="fill" className="text-amber-600" />
        <span className="text-xs font-semibold text-stone-700">High Scores</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close high scores"
          onClick={() => {
            sounds.click()
            onClose()
          }}
          className={`${XP_BTN} p-1`}
        >
          <XIcon size={12} weight="bold" className="text-stone-600" />
        </button>
      </div>
      {tabs.length > 1 && (
        <div className="flex gap-1 border-b border-stone-300 px-2 pt-1.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                sounds.click()
                setActive(t.id)
              }}
              className={`cursor-pointer rounded-t-sm border border-b-0 px-2.5 py-1 text-[11px] ${
                t.id === current.id
                  ? 'border-stone-400 bg-stone-100 font-semibold text-stone-800'
                  : 'border-stone-300 bg-stone-200 text-stone-500 hover:text-stone-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <Board key={current.id} game={current.id} you={you} />
    </div>
  )
}

interface GameShellProps {
  /** leaderboard tab(s); omit for games without a board */
  tabs?: ScoresTab[]
  /** the player's display name (useArcade().name / useLeaderboard().name) */
  you?: string
  /** the game's own header cluster: LEDs, face button, selects... */
  header?: ReactNode
  /** the footer strip, lowercase house style: "arrows steer · space pauses" */
  hint: string
  children: ReactNode
}

export function GameShell({ tabs, you, header, hint, children }: GameShellProps) {
  const [scoresOpen, setScoresOpen] = useState(false)
  return (
    <div className="flex h-full flex-col bg-stone-100">
      <div className="flex items-center gap-2 border-b border-stone-300 bg-stone-200 px-2 py-1.5">
        {header}
        <span className="flex-1" />
        {tabs && tabs.length > 0 && (
          <button
            type="button"
            aria-label="High scores"
            title="High scores"
            onClick={() => {
              sounds.click()
              setScoresOpen((o) => !o)
            }}
            className={`${XP_BTN} flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-stone-700`}
          >
            <TrophyIcon size={13} weight="fill" className="text-amber-600" />
            Scores
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* isolate caps the game's internal z-indexes so its overlays can
            never paint over the scores panel next door */}
        <div className="isolate h-full">{children}</div>
        {scoresOpen && tabs && (
          <ScoresPanel tabs={tabs} you={you ?? ''} onClose={() => setScoresOpen(false)} />
        )}
      </div>
      <p className="border-t border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-500">
        {hint}
      </p>
    </div>
  )
}
