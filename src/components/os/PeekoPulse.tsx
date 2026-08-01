import { useMemo, useState } from 'react'
import type { Monitor } from './peeko'
import { buildTicks, formatClock, rangeLabel } from './peekoFeed'
import { number } from './peekoStyle'
import { StatTile } from './peekoUi'

/*
  The strip at the top of peeko: who is on the site this second, what the range
  added up to behind them, and the shape of the traffic that produced it.

  The chart is the part that earns its space. A row of totals answers "how
  much" and nothing else; the same numbers laid out in time answer "when", and
  on a portfolio that is the interesting question — a Tuesday afternoon spike
  is somebody sharing a link, and a flat week is the site sitting there. Bars
  are stacked rather than paired: the pale part is every event, the solid part
  is the pageviews inside it, so the height is traffic and the fill is how much
  of it was people arriving somewhere new.

  Every clock label in here is built in the browser, from the epoch stamp on
  the bucket. Buckets are spaced evenly from the start of the range, so their
  own edges fall on arbitrary times; the tick marks are a separate overlay that
  snaps to round *local* times, which is what makes a spike placeable.
*/

function bucketWidthLabel(bucketMs: number): string {
  const minutes = Math.round(bucketMs / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export function PeekoPulse({
  monitor,
  rangeHours,
  onlineCountries,
}: {
  monitor: Monitor
  rangeHours: number
  onlineCountries: number
}) {
  const [hovered, setHovered] = useState<number | null>(null)

  // Held steady through a memo so the chart's own memos below do not see a
  // fresh array on every parent render (this one re-renders once a second).
  const timeline = useMemo(() => monitor.timeline ?? [], [monitor.timeline])
  const peak = useMemo(() => timeline.reduce((max, b) => Math.max(max, b.events), 0), [timeline])
  const startTs = timeline.length > 0 ? timeline[0].ts : 0
  const spanMs = monitor.bucketMs * Math.max(1, timeline.length)
  const ticks = useMemo(
    () => (timeline.length > 0 ? buildTicks(startTs, startTs + spanMs) : []),
    [timeline.length, startTs, spanMs],
  )

  const bounce =
    monitor.bounce.landers > 0
      ? Math.round((monitor.bounce.bounced / monitor.bounce.landers) * 100)
      : null
  const returning = monitor.visitors.total - monitor.visitors.fresh
  const live = monitor.overview.activeVisitors > 0
  const hoveredBucket = hovered == null ? undefined : timeline[hovered]
  const range = rangeLabel(rangeHours)

  return (
    <div className="rounded-sm border border-stone-300 bg-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]">
      <div className="flex gap-2 p-2">
        <StatTile
          label="Here now"
          accent={live}
          value={number.format(monitor.overview.activeVisitors)}
          hint={
            live
              ? onlineCountries > 0
                ? `from ${onlineCountries} ${onlineCountries === 1 ? 'country' : 'countries'}`
                : 'in the last 5 min'
              : 'nobody about'
          }
        />
        <StatTile
          label="Visitors"
          value={number.format(monitor.overview.uniqueVisitors)}
          hint={
            monitor.visitors.total > 0
              ? `${number.format(monitor.visitors.fresh)} new · ${number.format(Math.max(0, returning))} back again`
              : range
          }
        />
        <StatTile
          label="Pageviews"
          value={number.format(monitor.overview.pageviews)}
          hint={range}
        />
        <StatTile
          label="Events"
          value={number.format(monitor.overview.events)}
          hint={
            monitor.bots > 0
              ? `${number.format(monitor.bots)} bot ${monitor.bots === 1 ? 'hit' : 'hits'} filtered out`
              : range
          }
        />
        <StatTile
          label="Bounce"
          value={bounce == null ? '—' : `${bounce}%`}
          hint={
            monitor.bounce.landers > 0
              ? `${number.format(monitor.bounce.bounced)} of ${number.format(monitor.bounce.landers)} left after one page`
              : 'nobody landed on the front page'
          }
        />
      </div>

      <div className="border-t border-stone-200 px-2 pt-1.5 pb-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[10px]">
          <span className="font-semibold tracking-wide text-stone-500 uppercase">Traffic</span>
          <span className="flex items-center gap-2 text-stone-500">
            <span className="flex items-center gap-1">
              <span aria-hidden className="size-2 rounded-[1px] bg-blue-600" />
              pageviews
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden className="size-2 rounded-[1px] bg-blue-600/30" />
              everything else
            </span>
          </span>
          {/* Reading the hovered column out here beats a native tooltip: it
              arrives instantly and it never covers the bars it describes. */}
          <span className={`ml-auto truncate ${hoveredBucket ? 'text-stone-700' : 'text-stone-400'}`}>
            {hoveredBucket
              ? `${formatClock(hoveredBucket.ts, spanMs)} · ${number.format(hoveredBucket.events)} events · ${number.format(hoveredBucket.pageviews)} pageviews · ${number.format(hoveredBucket.visitors)} visitor${hoveredBucket.visitors === 1 ? '' : 's'}`
              : peak > 0
                ? `busiest ${bucketWidthLabel(monitor.bucketMs)}: ${number.format(peak)} events`
                : `nothing captured in ${range}`}
          </span>
        </div>

        <div
          className="relative mt-1.5 h-14 border-b border-stone-300"
          onMouseLeave={() => setHovered(null)}
        >
          <div
            className="flex h-full items-end gap-px"
            role="img"
            aria-label={`Traffic across ${range}`}
          >
            {timeline.map((bucket, i) => {
              const height =
                peak > 0 ? Math.max(bucket.events > 0 ? 4 : 1, Math.round((bucket.events / peak) * 100)) : 1
              const pageviewShare = bucket.events > 0 ? Math.min(1, bucket.pageviews / bucket.events) : 0
              return (
                <div
                  key={bucket.ts}
                  onMouseEnter={() => setHovered(i)}
                  // The column is a hover target the full height of the plot,
                  // but it only paints when it is the one being read. Tinted
                  // at rest, forty-eight of them fill the frame and the chart
                  // reads as bars pinned at the ceiling.
                  className={`relative h-full flex-1 rounded-[1px] transition-colors ${
                    hovered === i ? 'bg-stone-200' : 'bg-transparent'
                  }`}
                >
                  <div
                    className="absolute inset-x-0 bottom-0 rounded-[1px] bg-blue-600/30"
                    style={{ height: `${height}%` }}
                  >
                    <div
                      className="absolute inset-x-0 bottom-0 rounded-[1px] bg-blue-600"
                      style={{ height: `${Math.round(pageviewShare * 100)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          {ticks.map((tick) => (
            <span
              key={tick.ts}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-stone-400/25"
              style={{ left: `${tick.position * 100}%` }}
            />
          ))}
        </div>

        {/* Round local clock times, so a spike can be placed without hovering it. */}
        <div className="relative mt-1 h-3 font-mono text-[9px] text-stone-400">
          <span className="absolute top-0 left-0">
            {timeline.length > 0 ? formatClock(startTs, spanMs) : ''}
          </span>
          {ticks.map((tick) => (
            <span
              key={tick.ts}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${tick.position * 100}%` }}
            >
              {formatClock(tick.ts, spanMs)}
            </span>
          ))}
          <span className="absolute top-0 right-0">now</span>
        </div>
      </div>
    </div>
  )
}
