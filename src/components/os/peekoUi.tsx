import { DeviceMobileIcon, MonitorIcon } from '@phosphor-icons/react'
import { countryName, flagFor } from './peekoFeed'
import { number, visitorColor } from './peekoStyle'
import type { FeedEvent } from './peeko'

/*
  The parts every peeko panel is built from: the stat tile, the ranked bar, the
  group box and the visitor chip. The colour tables they read are next door in
  peekoStyle.ts.

  Everything is in the desktop's own idiom — stone, one-pixel borders, inset
  wells, 10 and 11 pixel type — because this window sits next to Minesweeper.
*/

export function StatTile({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: string | null
  accent?: boolean
}) {
  return (
    <div
      className={`min-w-0 flex-1 rounded-sm border px-2.5 py-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] ${
        accent ? 'border-blue-300 bg-blue-50' : 'border-stone-300 bg-white'
      }`}
    >
      <p className="truncate text-[10px] tracking-wide text-stone-500 uppercase">{label}</p>
      <p
        className={`mt-0.5 text-xl leading-none font-semibold tabular-nums ${
          accent ? 'text-blue-800' : 'text-stone-800'
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 truncate text-[10px] text-stone-400">{hint}</p>}
    </div>
  )
}

/**
 * A titled group box, the way a control panel dialog does it: the caption sits
 * on the rule rather than above it, so a screenful of panels reads as one
 * dialog instead of eight stacked cards.
 */
export function Panel({
  title,
  hint,
  actions,
  children,
}: {
  title: string
  hint?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="min-w-0 rounded-sm border border-stone-300 bg-stone-50/80">
      <header className="flex items-center gap-2 border-b border-stone-300 bg-stone-200/60 px-2 py-1">
        <h3 className="text-[11px] font-semibold tracking-wide text-stone-600 uppercase">
          {title}
        </h3>
        {hint && <span className="min-w-0 truncate text-[10px] text-stone-500">{hint}</span>}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </header>
      <div className="p-1.5">{children}</div>
    </section>
  )
}

export interface BarRow {
  label: string
  count: number
  /** optional leading glyph, e.g. a country flag */
  icon?: string
  /** dim trailing context, e.g. what a raw slug actually is */
  note?: string
  title?: string
}

/*
  A ranked top-N. The fill sits behind the text rather than beside it — twelve
  two-line rows would not fit a window this size, and the label stays readable
  because the fill is a wash, not a block. `total`, when given, turns the count
  into a share as well, which is the difference between "42" and "42, which is
  most of them".
*/
export function BarList({
  rows,
  empty,
  tone = 'bg-blue-600/20',
  total,
}: {
  rows: BarRow[]
  empty: string
  tone?: string
  total?: number
}) {
  if (rows.length === 0) {
    return <p className="px-1 py-2 text-[11px] text-stone-400">{empty}</p>
  }
  const max = Math.max(...rows.map((r) => r.count), 1)
  const sum = total ?? rows.reduce((acc, r) => acc + r.count, 0)
  return (
    <ul className="space-y-[2px]">
      {rows.map((row) => (
        <li
          key={row.label}
          title={row.title ?? `${row.label} — ${number.format(row.count)}`}
          className="relative h-[22px] overflow-hidden rounded-sm border border-stone-300 bg-white"
        >
          <div
            aria-hidden
            className={`absolute inset-y-0 left-0 rounded-r-[4px] ${tone}`}
            style={{ width: `${Math.max(2, (row.count / max) * 100)}%` }}
          />
          <div className="relative flex h-full items-center justify-between gap-2 px-1.5">
            <span className="flex min-w-0 items-baseline gap-1.5 truncate text-[11px] text-stone-700">
              {row.icon && (
                <span aria-hidden className="shrink-0">
                  {row.icon}
                </span>
              )}
              <span className="truncate">{row.label}</span>
              {row.note && <span className="shrink-0 text-[10px] text-stone-400">{row.note}</span>}
            </span>
            <span className="flex shrink-0 items-baseline gap-1.5">
              {sum > 0 && (
                <span className="text-[10px] tabular-nums text-stone-400">
                  {Math.round((row.count / sum) * 100)}%
                </span>
              )}
              <span className="text-[11px] font-medium tabular-nums text-stone-600">
                {number.format(row.count)}
              </span>
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function DeviceIcon({ kind }: { kind: FeedEvent['deviceKind'] }) {
  if (kind === 'mobile') {
    return <DeviceMobileIcon size={11} className="shrink-0 text-stone-400" aria-label="On a phone" />
  }
  if (kind === 'desktop') {
    return <MonitorIcon size={11} className="shrink-0 text-stone-400" aria-label="On a computer" />
  }
  return <span className="size-[11px] shrink-0" aria-hidden />
}

export function Flag({ code }: { code: string | null }) {
  if (!code) return <span className="w-3.5 shrink-0" aria-hidden />
  return (
    <span className="shrink-0 text-[10px]" title={countryName(code)}>
      <span aria-hidden>{flagFor(code)}</span>
      <span className="sr-only">{countryName(code)}</span>
    </span>
  )
}

/** Who a row belongs to: colour, V-number, where they are, what they are on. */
export function VisitorChip({
  label,
  slot,
  country,
  deviceKind,
  viewerUsername,
}: {
  label: string
  slot: number
  country: string | null
  deviceKind: FeedEvent['deviceKind']
  viewerUsername: string | null
}) {
  const color = visitorColor(slot)
  return (
    <>
      <span className={`shrink-0 rounded-[2px] px-1 py-px font-mono text-[10px] font-semibold ${color.chip}`}>
        {label}
      </span>
      <Flag code={country} />
      <DeviceIcon kind={deviceKind} />
      {viewerUsername ? (
        <span
          className="min-w-0 truncate text-[10px] font-semibold text-blue-800"
          title={`signed into AlejOS as ${viewerUsername}`}
        >
          {viewerUsername}
        </span>
      ) : (
        // Almost everyone browses without ever logging in; naming that keeps
        // the column from reading as a field that failed to load.
        <span className="min-w-0 truncate text-[10px] text-stone-400" title="Never signed in">
          guest
        </span>
      )}
    </>
  )
}

/** The toolbar button, in the raised bevel every other AlejOS dialog uses. */
export function ToolButton({
  active,
  onClick,
  children,
  title,
  pressedLabel,
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
  /** an aria-pressed toggle rather than a plain button */
  pressedLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={pressedLabel}
      aria-pressed={pressedLabel != null ? Boolean(active) : undefined}
      className={`flex cursor-pointer items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] whitespace-nowrap transition ${
        active
          ? 'border-blue-700 bg-blue-600 text-white'
          : 'border-stone-400 bg-stone-200 text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600 hover:bg-stone-50'
      }`}
    >
      {children}
    </button>
  )
}

export function Empty({ text }: { text: string }) {
  return <p className="px-1 py-4 text-center text-[11px] text-stone-400">{text}</p>
}
