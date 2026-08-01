import { useMemo, useState } from 'react'
import { ArrowClockwiseIcon, ChartBarIcon, EyeIcon, RadioIcon } from '@phosphor-icons/react'
import { useOs } from './osContext'
import { RANGES, SERVER_FEED_LIMIT, usePeeko } from './peeko'
import { buildSessions, formatAgo } from './peekoFeed'
import { PeekoInsights } from './PeekoInsights'
import { PeekoLive } from './PeekoLive'
import { PeekoPulse } from './PeekoPulse'
import { useTickingNow } from './peekoStyle'
import { ToolButton } from './peekoUi'
import { sounds } from './sounds'

/*
  peeko: the traffic dashboard, and the one app on this desktop that is not
  part of the portfolio. It only exists for me — the Start menu hides it from
  everyone else, and the server refuses every read to a socket that is not the
  admin, so hiding it is a courtesy rather than the lock (see peeko.ts).

  The engine behind it is my own: github.com/aleju03/peeko, a self-hosted
  analytics core on SQLite. The site posts events to it from analytics.ts, the
  rows live in their own Turso database, and this window is the read side —
  which is the whole point of an analytics core that ships no dashboard.

  Four files hang off this one, and the split is deliberate. `peeko.ts` is the
  socket and nothing else. `peekoFeed.ts` is the reading layer — the thing that
  turns a captured row into a sentence — and is React-free so it can be
  reasoned about on its own. `peekoUi.tsx` is the parts. The two panels are the
  window's two questions, and they are two questions rather than one screen
  because they are wanted at different times: **Live** is "who is here and what
  are they touching", which is what this window is open for most of the time,
  and **Insights** is "what did the week add up to", which is a thing you sit
  down to read.

  On time, which is the whole reason this window was rebuilt. **Nothing here
  ever displays a clock the server rendered.** peeko stamps every feed row with
  a label in the VPS's timezone, and reading that back on a laptop six hours
  west is how an evening visit came out saying 6am. Every time on screen is
  derived here, in the browser, from the epoch stamp on the event: mostly as an
  age, which is timezone-free, and where a wall clock is genuinely needed (the
  chart axis) through `Intl` with no zone argument, which resolves to the one
  the person reading it is actually in.
*/

type View = 'live' | 'insights'

export function PeekoApp() {
  const { session } = useOs()
  const peeko = usePeeko(session)
  const [view, setView] = useState<View>('live')
  const tick = useTickingNow()

  // Ages are measured against the server's clock, carried down with each
  // rollup. A laptop a minute behind would otherwise report every row as a
  // minute younger than it is, and on a five-minute "here now" window that is
  // a fifth of the answer.
  const now = tick + peeko.clockSkew

  const { monitor } = peeko
  // Sessions are rebuilt against a coarse clock: only the `online` flag
  // depends on `now` at all, so a per-second tick must not re-stitch the whole
  // feed sixty times a minute.
  const sessionClock = Math.floor(now / 15_000) * 15_000
  const sessions = useMemo(() => buildSessions(peeko.feed, sessionClock), [peeko.feed, sessionClock])
  const onlineCountries = useMemo(() => {
    const codes = new Set<string>()
    for (const s of sessions) if (s.online && s.country) codes.add(s.country)
    return codes.size
  }, [sessions])

  // the Start menu already hides this, but an app id is guessable and the
  // window should say something honest if it is opened another way
  if (!session.admin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-stone-100 p-6 text-center">
        <EyeIcon size={28} className="text-stone-400" />
        <p className="text-sm text-stone-600">Access is denied.</p>
        <p className="max-w-xs text-[11px] text-stone-500">
          Traffic for this site is only visible to the administrator account.
        </p>
      </div>
    )
  }

  const statusLabel: Record<typeof peeko.status, string> = {
    connecting: 'connecting',
    online: 'live',
    offline: 'reconnecting',
    denied: 'not authorised',
    unavailable: 'not configured',
  }
  const statusTone =
    peeko.status === 'online'
      ? 'bg-green-600'
      : peeko.status === 'connecting'
        ? 'bg-amber-500'
        : 'bg-stone-400'

  return (
    <div className="flex h-full flex-col bg-stone-100 text-stone-800">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-300 bg-stone-200/70 px-2 py-1.5">
        <div className="flex overflow-hidden rounded-sm border border-stone-400">
          <TabButton active={view === 'live'} onClick={() => setView('live')}>
            <RadioIcon size={11} weight="bold" />
            Live
          </TabButton>
          <TabButton active={view === 'insights'} onClick={() => setView('insights')}>
            <ChartBarIcon size={11} weight="bold" />
            Insights
          </TabButton>
        </div>

        <div className="flex items-center gap-1">
          {RANGES.map((range) => (
            <ToolButton
              key={range.hours}
              active={peeko.rangeHours === range.hours}
              onClick={() => {
                sounds.click()
                peeko.setRange(range.hours)
              }}
              pressedLabel={`Show ${range.label}`}
            >
              {range.label}
            </ToolButton>
          ))}
        </div>

        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-stone-500">
          <span aria-hidden className={`size-2 rounded-full ${statusTone}`} />
          {statusLabel[peeko.status]}
        </span>
        {peeko.fetchedAt > 0 && (
          <span
            className="text-[11px] text-stone-400"
            title="when the totals behind the feed were last queried"
          >
            {(() => {
              const ago = formatAgo(tick - peeko.fetchedAt)
              return ago === 'now' ? 'counted just now' : `counted ${ago} ago`
            })()}
          </span>
        )}
        <ToolButton
          active={peeko.auto}
          onClick={() => {
            sounds.click()
            peeko.setAuto(!peeko.auto)
          }}
          pressedLabel="Refresh the totals automatically"
          title="Re-query the totals every 30 seconds. The feed is live either way."
        >
          Auto
        </ToolButton>
        <ToolButton
          onClick={() => {
            sounds.click()
            peeko.refresh()
          }}
          title="Refresh now"
        >
          <ArrowClockwiseIcon size={11} weight="bold" className={peeko.loading ? 'animate-spin' : ''} />
          Refresh
        </ToolButton>
      </div>

      {peeko.status === 'unavailable' || !peeko.configured ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm text-stone-600">No analytics store is configured.</p>
          <p className="max-w-sm text-[11px] text-stone-500">
            This build has no server to read from. Set ANALYTICS_URL on the chat server and
            VITE_CHAT_URL at build time.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {peeko.error && (
            <p className="mb-2 rounded-sm border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
              {peeko.error}
            </p>
          )}

          {monitor ? (
            <div className="space-y-2">
              <PeekoPulse
                monitor={monitor}
                rangeHours={peeko.rangeHours}
                onlineCountries={onlineCountries}
              />
              {view === 'live' ? (
                <PeekoLive
                  sessions={sessions}
                  countries={monitor.topCountries}
                  country={peeko.country}
                  onCountry={peeko.setCountry}
                  now={now}
                  loading={peeko.loading}
                  truncated={monitor.recent.length >= SERVER_FEED_LIMIT}
                />
              ) : (
                <PeekoInsights
                  monitor={monitor}
                  breakdowns={peeko.breakdowns}
                  rangeHours={peeko.rangeHours}
                />
              )}
            </div>
          ) : (
            <p className="p-6 text-center text-[11px] text-stone-400">
              {peeko.status === 'denied' ? 'This account cannot read traffic.' : 'Asking the server…'}
            </p>
          )}
        </div>
      )}

      {/* status bar: the one line that says what timezone everything above is in */}
      <div className="flex items-center gap-3 border-t border-stone-300 bg-stone-200/70 px-2 py-1 text-[10px] text-stone-500">
        <span className="truncate">
          Times are yours: {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </span>
        <span className="ml-auto shrink-0">
          {monitor ? `${monitor.recent.length} rows in the window` : '—'}
        </span>
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={() => {
        sounds.click()
        onClick()
      }}
      aria-pressed={active}
      className={`flex cursor-pointer items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium transition ${
        active ? 'bg-blue-600 text-white' : 'bg-stone-200 text-stone-600 hover:bg-stone-50'
      }`}
    >
      {children}
    </button>
  )
}
