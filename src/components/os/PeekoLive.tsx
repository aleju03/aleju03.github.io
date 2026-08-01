import { useMemo, useState } from 'react'
import { ListBulletsIcon, SquaresFourIcon } from '@phosphor-icons/react'
import type { FeedEvent } from './peeko'
import type { Session } from './peekoFeed'
import {
  ACTIVITY_KINDS,
  activityText,
  countryName,
  describeEvent,
  flagFor,
  formatAgo,
  formatDuration,
  formatExact,
} from './peekoFeed'
import type { ActivityKind } from './peekoFeed'
import { KIND_STYLES, number, visitorColor } from './peekoStyle'
import { Empty, Panel, VisitorChip } from './peekoUi'

/*
  The live half of peeko: who is on the site at this second, and the running
  commentary of everything that has happened in the range behind them.

  It reads two ways on purpose. **Stream** interleaves every visitor, so the
  window reads like a ticker of the site as a whole. **Sessions** folds the
  same rows back per person, so one visit can be followed end to end — which
  route they came in on, what they opened, whether they ever found the door
  into AlejOS. The stream answers "what is happening"; the sessions answer
  "what was that one person doing", and neither substitutes for the other.

  Nothing here shows a wall clock. Rows carry an age, which is the same number
  in every timezone on earth; the exact local time is one hover away on every
  one of them, formatted in the browser and therefore in the reader's own zone.
*/

const CARD_LIMIT = 9
const TRAIL_LENGTH = 3
const PAGE_SIZE = 120
/** rows younger than this get a wash, so an arrival catches the eye */
const FRESH_MS = 5_000

export function PeekoLive({
  sessions,
  countries,
  country,
  onCountry,
  now,
  loading,
  truncated,
}: {
  sessions: Session[]
  countries: { country: string; count: number }[]
  country: string | null
  onCountry: (next: string | null) => void
  now: number
  loading: boolean
  truncated: boolean
}) {
  const [mode, setMode] = useState<'stream' | 'sessions'>('stream')
  const [kinds, setKinds] = useState<Set<ActivityKind>>(new Set())
  const [limit, setLimit] = useState(PAGE_SIZE)

  // Narrowing the view starts it from the top again rather than a hundred rows
  // deep in a list that just got shorter. The two local controls reset as they
  // are pressed; the country comes down as a prop, so it is adjusted during
  // render (the documented alternative to an effect that only calls setState).
  const [lastCountry, setLastCountry] = useState(country)
  if (country !== lastCountry) {
    setLastCountry(country)
    setLimit(PAGE_SIZE)
  }
  const narrow = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    setLimit(PAGE_SIZE)
  }

  const online = useMemo(() => sessions.filter((s) => s.online), [sessions])
  const rows = useMemo(() => sessions.flatMap((s) => s.events).sort((a, b) => b.ts - a.ts), [sessions])
  const slotOf = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of sessions) map.set(s.distinctId, s.slot)
    return map
  }, [sessions])

  const kindCounts = useMemo(() => {
    const counts = new Map<ActivityKind, number>()
    for (const row of rows) {
      const kind = describeEvent(row).kind
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    return counts
  }, [rows])

  const shownRows = useMemo(
    () => (kinds.size === 0 ? rows : rows.filter((r) => kinds.has(describeEvent(r).kind))),
    [rows, kinds],
  )
  const shownSessions = useMemo(() => {
    if (kinds.size === 0) return sessions
    return sessions
      .map((s) => ({ ...s, events: s.events.filter((r) => kinds.has(describeEvent(r).kind)) }))
      .filter((s) => s.events.length > 0)
  }, [sessions, kinds])

  const setModeNarrowed = narrow(setMode)
  const toggleKind = narrow((kind: ActivityKind) =>
    setKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    }),
  )

  const where = country ? ` in ${countryName(country)}` : ''

  return (
    <div className="space-y-2">
      <Panel
        title="Right now"
        hint={
          online.length > 0
            ? `${online.length} ${online.length === 1 ? 'person' : 'people'} active in the last 5 minutes`
            : 'nobody active in the last 5 minutes'
        }
      >
        {online.length === 0 ? (
          <LastSeen session={sessions[0]} now={now} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {online.slice(0, CARD_LIMIT).map((session) => (
                <VisitorCard key={session.distinctId} session={session} now={now} />
              ))}
            </div>
            {online.length > CARD_LIMIT && (
              <p className="mt-1.5 text-center text-[10px] text-stone-400">
                and {online.length - CARD_LIMIT} more online
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel
        title="Activity"
        hint={
          loading
            ? 'loading…'
            : `${truncated ? 'last ' : ''}${number.format(rows.length)} event${rows.length === 1 ? '' : 's'}${where} from ${number.format(sessions.length)} visitor${sessions.length === 1 ? '' : 's'}`
        }
        actions={
          <>
            <div className="flex overflow-hidden rounded-sm border border-stone-400">
              <ModeButton
                active={mode === 'stream'}
                onClick={() => setModeNarrowed('stream')}
                icon={<ListBulletsIcon size={11} />}
                label="Stream"
              />
              <ModeButton
                active={mode === 'sessions'}
                onClick={() => setModeNarrowed('sessions')}
                icon={<SquaresFourIcon size={11} />}
                label="Sessions"
              />
            </div>
            <select
              value={country ?? ''}
              onChange={(e) => onCountry(e.target.value || null)}
              aria-label="Filter by country"
              className="max-w-[150px] cursor-pointer rounded-sm border border-stone-400 bg-white px-1 py-0.5 text-[11px] text-stone-700"
            >
              <option value="">All countries</option>
              {countries.map((c) => (
                <option key={c.country} value={c.country}>
                  {flagFor(c.country)} {countryName(c.country)} ({c.count})
                </option>
              ))}
            </select>
          </>
        }
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          <FilterChip
            active={kinds.size === 0}
            onClick={() => narrow(setKinds)(new Set())}
            label="Everything"
            count={rows.length}
          />
          {ACTIVITY_KINDS.map((kind) => {
            const count = kindCounts.get(kind) ?? 0
            if (count === 0) return null
            const style = KIND_STYLES[kind]
            const Icon = style.icon
            return (
              <FilterChip
                key={kind}
                active={kinds.has(kind)}
                onClick={() => toggleKind(kind)}
                label={style.label}
                count={count}
                icon={<Icon size={11} className={style.text} />}
              />
            )
          })}
        </div>

        {mode === 'stream' ? (
          <StreamRows rows={shownRows} slotOf={slotOf} now={now} limit={limit} onMore={() => setLimit((v) => v + PAGE_SIZE)} />
        ) : (
          <SessionRows sessions={shownSessions} now={now} limit={limit} onMore={() => setLimit((v) => v + PAGE_SIZE)} />
        )}
      </Panel>
    </div>
  )
}

function LastSeen({ session, now }: { session: Session | undefined; now: number }) {
  return (
    <div className="rounded-sm border border-dashed border-stone-300 bg-white/60 px-3 py-5 text-center">
      <p className="text-[11px] text-stone-500">Nobody on the site right now.</p>
      {session && (
        <p className="mt-1 text-[10px] text-stone-400" title={formatExact(session.lastTs)}>
          The last visitor was here {formatAgo(now - session.lastTs)} ago.
        </p>
      )}
    </div>
  )
}

/*
  One card per person on the site: what they are doing at this second, how long
  they have been around, and the last few steps that got them there. The point
  is peripheral awareness — nothing here should need a click.
*/
function VisitorCard({ session, now }: { session: Session; now: number }) {
  const color = visitorColor(session.slot)
  const [current, ...rest] = session.events
  if (!current) return null
  const activity = describeEvent(current)
  const style = KIND_STYLES[activity.kind]
  const Icon = style.icon
  const trail = rest.slice(0, TRAIL_LENGTH)
  const earlier = Math.max(0, session.events.length - 1 - trail.length)

  return (
    <div className="relative overflow-hidden rounded-sm border border-stone-300 bg-white">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${color.dot}`} />
      <div className="pl-[3px]">
        <div
          className="flex items-center gap-1.5 border-b border-stone-200 px-1.5 py-1"
          title={`visitor id ${session.distinctId}`}
        >
          <VisitorChip
            label={session.label}
            slot={session.slot}
            country={session.country}
            deviceKind={session.deviceKind}
            viewerUsername={session.viewerUsername}
          />
          <span
            className="ml-auto shrink-0 font-mono text-[10px] text-stone-400"
            title="from their first event in this range to their last"
          >
            {formatDuration(session.durationMs)}
          </span>
        </div>

        <div className="px-1.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className={`inline-flex size-4 items-center justify-center rounded-[2px] ${style.chip}`}>
              <Icon size={10} className={style.text} aria-hidden />
            </span>
            <span className={`text-[10px] font-semibold tracking-wide uppercase ${style.text}`}>
              {activity.verb}
            </span>
            <span
              className="ml-auto shrink-0 font-mono text-[10px] text-stone-400"
              title={formatExact(current.ts)}
            >
              {formatAgo(now - current.ts)}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug font-medium text-stone-800">
            {activity.subject}
          </p>
          {activity.detail && (
            <p className="truncate text-[10px] text-stone-400">{activity.detail}</p>
          )}
        </div>

        {trail.length > 0 && (
          <div className="border-t border-stone-200 px-1.5 py-1">
            {trail.map((row, i) => {
              const step = describeEvent(row)
              return (
                <div key={`${row.ts}-${i}`} className="flex items-center gap-1.5 py-px text-[10px]">
                  <span aria-hidden className={`size-1 shrink-0 rounded-full ${KIND_STYLES[step.kind].bar}`} />
                  <span className="truncate text-stone-500" title={activityText(step)}>
                    {step.verb} <span className="text-stone-700">{step.subject}</span>
                  </span>
                  <span
                    className="ml-auto shrink-0 font-mono text-stone-400"
                    title={formatExact(row.ts)}
                  >
                    {formatAgo(now - row.ts)}
                  </span>
                </div>
              )
            })}
            {(earlier > 0 || session.referrer) && (
              <p className="mt-0.5 flex items-center gap-2 text-[9px] text-stone-400">
                {earlier > 0 && <span>{earlier} earlier</span>}
                {session.referrer && <span className="truncate">came from {session.referrer}</span>}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StreamRows({
  rows,
  slotOf,
  now,
  limit,
  onMore,
}: {
  rows: FeedEvent[]
  slotOf: Map<string, number>
  now: number
  limit: number
  onMore: () => void
}) {
  if (rows.length === 0) return <Empty text="Nothing matches that filter in this range." />
  const shown = rows.slice(0, limit)
  return (
    <>
      <ul className="max-h-[320px] overflow-y-auto rounded-sm border border-stone-300 bg-white">
        {shown.map((row, i) => (
          <StreamRow
            key={`${row.ts}-${row.distinctId}-${i}`}
            row={row}
            slot={slotOf.get(row.distinctId) ?? 0}
            now={now}
          />
        ))}
      </ul>
      <ShowMore remaining={rows.length - shown.length} onMore={onMore} />
    </>
  )
}

function StreamRow({ row, slot, now }: { row: FeedEvent; slot: number; now: number }) {
  const activity = describeEvent(row)
  const style = KIND_STYLES[activity.kind]
  const Icon = style.icon
  const color = visitorColor(slot)
  const fresh = now - row.ts < FRESH_MS

  return (
    <li
      className={`flex items-center gap-1.5 border-b border-stone-100 px-1.5 py-[3px] last:border-b-0 ${
        fresh ? 'bg-blue-50' : ''
      }`}
      title={activityText(activity)}
    >
      <span aria-hidden className={`h-3 w-[2px] shrink-0 rounded-full ${color.dot}`} />
      <span
        className="flex w-[132px] shrink-0 items-center gap-1 overflow-hidden"
        title={`visitor id ${row.distinctId}`}
      >
        <VisitorChip
          label={`V${slot + 1}`}
          slot={slot}
          country={row.country}
          deviceKind={row.deviceKind}
          viewerUsername={row.viewerUsername}
        />
      </span>
      <Icon size={11} className={`shrink-0 ${style.text}`} aria-hidden />
      <span className={`shrink-0 text-[11px] font-medium ${style.text}`}>{activity.verb}</span>
      <span className="truncate text-[11px] text-stone-800">{activity.subject}</span>
      {activity.detail && (
        <span className="hidden truncate text-[10px] text-stone-400 sm:inline">{activity.detail}</span>
      )}
      <span
        className="ml-auto w-11 shrink-0 text-right font-mono text-[10px] text-stone-400"
        title={formatExact(row.ts)}
      >
        {formatAgo(now - row.ts)}
      </span>
    </li>
  )
}

function SessionRows({
  sessions,
  now,
  limit,
  onMore,
}: {
  sessions: Session[]
  now: number
  limit: number
  onMore: () => void
}) {
  // A lone visitor opens expanded; with several, everything starts folded.
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  if (sessions.length === 0) return <Empty text="Nothing matches that filter in this range." />
  const defaultOpen = sessions.length === 1
  const shown = sessions.slice(0, limit)

  const toggle = (id: string) =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <div className="max-h-[320px] space-y-1 overflow-y-auto rounded-sm border border-stone-300 bg-white p-1">
        {shown.map((session) => {
          const open = toggled.has(session.distinctId) !== defaultOpen
          const color = visitorColor(session.slot)
          const activity = describeEvent(session.events[0])
          const style = KIND_STYLES[activity.kind]
          const Icon = style.icon
          return (
            <div key={session.distinctId} className="overflow-hidden rounded-sm border border-stone-200">
              <button
                type="button"
                onClick={() => toggle(session.distinctId)}
                title={`visitor id ${session.distinctId}`}
                className="flex w-full cursor-pointer items-center gap-1.5 bg-stone-50 px-1.5 py-1 text-left hover:bg-blue-50"
              >
                <span aria-hidden className={`h-4 w-[2px] shrink-0 rounded-full ${color.dot}`} />
                <span className="flex w-[132px] shrink-0 items-center gap-1 overflow-hidden">
                  <VisitorChip
                    label={session.label}
                    slot={session.slot}
                    country={session.country}
                    deviceKind={session.deviceKind}
                    viewerUsername={session.viewerUsername}
                  />
                </span>
                {session.online && (
                  <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold tracking-wide text-green-700 uppercase">
                    <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-green-600" />
                    live
                  </span>
                )}
                <Icon size={11} className={`shrink-0 ${style.text}`} aria-hidden />
                <span className={`shrink-0 text-[11px] font-medium ${style.text}`}>{activity.verb}</span>
                <span className="truncate text-[11px] text-stone-800">{activity.subject}</span>
                <span className="ml-auto shrink-0 text-[10px] text-stone-400">
                  {number.format(session.events.length)} step{session.events.length === 1 ? '' : 's'}
                </span>
                <span
                  className="w-11 shrink-0 text-right font-mono text-[10px] text-stone-400"
                  title="how long they stayed"
                >
                  {formatDuration(session.durationMs)}
                </span>
              </button>
              {open && (
                <div className="border-t border-stone-200 bg-white py-0.5">
                  {session.referrer && (
                    <p className="px-1.5 py-0.5 pl-7 text-[10px] text-stone-400">
                      arrived from <span className="text-stone-600">{session.referrer}</span>
                    </p>
                  )}
                  {session.events.map((row, i) => {
                    const step = describeEvent(row)
                    const stepStyle = KIND_STYLES[step.kind]
                    return (
                      <div
                        key={`${row.ts}-${i}`}
                        className="flex items-center gap-1.5 py-[2px] pr-1.5 pl-7 text-[10px]"
                      >
                        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${stepStyle.bar}`} />
                        <span className={`shrink-0 font-medium ${stepStyle.text}`}>{step.verb}</span>
                        <span className="truncate text-stone-700">{step.subject}</span>
                        {step.detail && <span className="truncate text-stone-400">{step.detail}</span>}
                        <span
                          className="ml-auto shrink-0 font-mono text-stone-400"
                          title={formatExact(row.ts)}
                        >
                          {formatAgo(now - row.ts)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <ShowMore remaining={sessions.length - shown.length} onMore={onMore} />
    </>
  )
}

function ShowMore({ remaining, onMore }: { remaining: number; onMore: () => void }) {
  if (remaining <= 0) return null
  return (
    <button
      type="button"
      onClick={onMore}
      className="mt-1 w-full cursor-pointer rounded-sm border border-stone-400 bg-stone-200 py-1 text-[10px] font-medium text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600 hover:bg-stone-50"
    >
      Show more · {number.format(remaining)} hidden
    </button>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex cursor-pointer items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium transition ${
        active ? 'bg-blue-600 text-white' : 'bg-stone-200 text-stone-600 hover:bg-stone-50'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex cursor-pointer items-center gap-1 rounded-sm border px-1.5 py-px text-[10px] transition ${
        active
          ? 'border-blue-700 bg-blue-600/10 text-blue-900'
          : 'border-stone-300 bg-white text-stone-600 hover:border-blue-600'
      }`}
    >
      {icon}
      {label}
      <span className="font-mono text-stone-400">{number.format(count)}</span>
    </button>
  )
}
