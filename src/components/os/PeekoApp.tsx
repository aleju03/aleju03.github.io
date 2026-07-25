import { ArrowClockwiseIcon, EyeIcon } from '@phosphor-icons/react'
import { useOs } from './osContext'
import { RANGES, usePeeko } from './peeko'
import type { Breakdown, FeedEvent } from './peeko'
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

  Every list here is one series answering "how much", so they are all one hue:
  colour never carries meaning that the text beside it does not already say.
  The only exception is the connection dot, which comes with its word.
*/

const number = new Intl.NumberFormat()

// "CR" -> "Costa Rica". Built in, so no country-name table ships with this.
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()

/**
 * "CR" -> 🇨🇷. A flag emoji is just its two letters as regional indicator
 * symbols, so there is no image to ship. Windows has no flag glyphs and will
 * render the letters instead, which is why the code stays visible next to it
 * rather than being replaced by the flag.
 */
function flagFor(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return ''
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}

function countryName(code: string): string {
  try {
    return regionNames?.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-sm border border-stone-300 bg-white px-2.5 py-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]">
      <p className="truncate text-[10px] tracking-wide text-stone-500 uppercase">{label}</p>
      <p className="mt-0.5 text-xl leading-none font-semibold tabular-nums text-stone-800">
        {value}
      </p>
      {hint && <p className="mt-1 truncate text-[10px] text-stone-400">{hint}</p>}
    </div>
  )
}

interface BarRow {
  label: string
  count: number
  /** optional leading glyph, e.g. a country flag */
  icon?: string
}

/*
  A ranked top-N: magnitude for one series, so the bar is the only mark and it
  keeps a single hue. The fill sits behind the text rather than beside it —
  twelve two-line rows would not fit a window this size, and the label stays
  readable because the fill is a wash, not a block.
*/
function BarList({ rows, empty }: { rows: BarRow[]; empty: string }) {
  if (rows.length === 0) {
    return <p className="px-1 py-2 text-[11px] text-stone-400">{empty}</p>
  }
  const max = Math.max(...rows.map((r) => r.count), 1)
  return (
    <ul className="space-y-[2px]">
      {rows.map((row) => (
        <li
          key={row.label}
          title={`${row.label} — ${number.format(row.count)}`}
          className="relative h-[22px] overflow-hidden rounded-sm border border-stone-300 bg-white"
        >
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-r-[4px] bg-blue-600/20"
            style={{ width: `${Math.max(2, (row.count / max) * 100)}%` }}
          />
          <div className="relative flex h-full items-center justify-between gap-2 px-1.5">
            <span className="min-w-0 truncate text-[11px] text-stone-700">
              {row.icon && (
                <span aria-hidden className="mr-1.5">
                  {row.icon}
                </span>
              )}
              {row.label}
            </span>
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-stone-600">
              {number.format(row.count)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-stone-500 uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function fromBreakdown(breakdown: Breakdown | undefined): BarRow[] {
  return (breakdown?.rows ?? []).map((row) => ({ label: row.value, count: row.count }))
}

function LiveRow({ event }: { event: FeedEvent }) {
  const where = event.path ?? '—'
  return (
    <li className="flex items-baseline gap-2 border-b border-stone-200 px-1 py-[3px] last:border-b-0">
      <span className="shrink-0 text-[10px] tabular-nums text-stone-400">{event.timestamp}</span>
      <span
        className={`shrink-0 text-[10px] font-medium ${
          event.event === '$pageview' ? 'text-blue-700' : 'text-stone-600'
        }`}
      >
        {event.event === '$pageview' ? 'view' : event.event}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-stone-700" title={where}>
        {where}
      </span>
      <span className="shrink-0 text-[10px] text-stone-400">
        {event.country && (
          <span title={countryName(event.country)}>
            <span aria-hidden>{flagFor(event.country)}</span> {event.country}
            {event.deviceKind === 'unknown' ? '' : ' · '}
          </span>
        )}
        {event.deviceKind === 'unknown' ? null : event.deviceKind}
      </span>
    </li>
  )
}

export function PeekoApp() {
  const { session } = useOs()
  const peeko = usePeeko(session)
  const { monitor, breakdowns } = peeko

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

  const bounceRate =
    monitor && monitor.bounce.landers > 0
      ? Math.round((monitor.bounce.bounced / monitor.bounce.landers) * 100)
      : null

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
      <div className="flex items-center gap-2 border-b border-stone-300 bg-stone-200/70 px-2 py-1.5">
        <div className="flex items-center gap-1">
          {RANGES.map((range) => (
            <button
              key={range.hours}
              type="button"
              onClick={() => {
                sounds.click()
                peeko.setRange(range.hours)
              }}
              aria-pressed={peeko.rangeHours === range.hours}
              className={`cursor-pointer rounded-sm border px-2 py-0.5 text-[11px] transition ${
                peeko.rangeHours === range.hours
                  ? 'border-blue-700 bg-blue-600 text-white'
                  : 'border-stone-400 bg-stone-200 text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-stone-500">
          <span aria-hidden className={`size-2 rounded-full ${statusTone}`} />
          {statusLabel[peeko.status]}
        </span>
        <button
          type="button"
          onClick={() => {
            sounds.click()
            peeko.refresh()
          }}
          aria-label="Refresh"
          className="flex cursor-pointer items-center gap-1 rounded-sm border border-stone-400 bg-stone-200 px-2 py-0.5 text-[11px] text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
        >
          <ArrowClockwiseIcon size={11} weight="bold" className={peeko.loading ? 'animate-spin' : ''} />
          Refresh
        </button>
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
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {peeko.error && (
            <p className="mb-2 rounded-sm border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
              {peeko.error}
            </p>
          )}

          {/* the headline numbers: no plot, so no chart */}
          <div className="flex gap-2">
            <StatTile
              label="Visitors"
              value={number.format(monitor?.overview.uniqueVisitors ?? 0)}
              hint={`${number.format(monitor?.overview.activeVisitors ?? 0)} in the last 5 min`}
            />
            <StatTile
              label="Pageviews"
              value={number.format(monitor?.overview.pageviews ?? 0)}
            />
            <StatTile label="Events" value={number.format(monitor?.overview.events ?? 0)} />
            <StatTile
              label="Bounce"
              value={bounceRate === null ? '—' : `${bounceRate}%`}
              hint={
                monitor ? `${number.format(monitor.bounce.landers)} landed on /` : undefined
              }
            />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Panel title="Pages">
              <BarList
                rows={(monitor?.topPaths ?? []).map((p) => ({ label: p.path, count: p.count }))}
                empty="No pageviews in this range."
              />
            </Panel>

            <Panel title="Live">
              <ul className="max-h-52 overflow-y-auto rounded-sm border border-stone-300 bg-white">
                {peeko.live.length === 0 ? (
                  <li className="px-1.5 py-2 text-[11px] text-stone-400">
                    Waiting for something to happen.
                  </li>
                ) : (
                  peeko.live.map((event, i) => (
                    <LiveRow key={`${event.ts}-${event.distinctId}-${i}`} event={event} />
                  ))
                )}
              </ul>
            </Panel>

            <Panel title="Referrers">
              <BarList
                rows={(monitor?.topReferrers ?? []).map((r) => ({
                  label: r.domain,
                  count: r.count,
                }))}
                empty="Nobody linked here yet."
              />
            </Panel>

            <Panel title="Countries">
              <BarList
                rows={(monitor?.topCountries ?? []).map((c) => ({
                  label: countryName(c.country),
                  icon: flagFor(c.country),
                  count: c.count,
                }))}
                empty="No country data yet."
              />
            </Panel>

            <Panel title="Projects opened">
              <BarList
                rows={fromBreakdown(breakdowns['project_view:slug'])}
                empty="No project opened in this range."
              />
            </Panel>

            <Panel title="Desktop apps">
              <BarList
                rows={fromBreakdown(breakdowns['app_open:app'])}
                empty="Nobody opened anything in here."
              />
            </Panel>

            <Panel title="Way into the OS">
              <BarList
                rows={fromBreakdown(breakdowns['os_boot:via'])}
                empty="No boots in this range."
              />
            </Panel>

            <Panel title="Which rendering (visitors)">
              <BarList
                rows={fromBreakdown(breakdowns['$pageview:rendering'])}
                empty="No pageviews in this range."
              />
            </Panel>
          </div>
        </div>
      )}
    </div>
  )
}
