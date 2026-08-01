import type { Breakdown, Monitor } from './peeko'
import { countryName, flagFor, labelFor, rangeLabel, referrerLabel } from './peekoFeed'
import { BarList, Panel } from './peekoUi'
import type { BarRow } from './peekoUi'

/*
  The aggregate half of peeko: what the range added up to, once the live feed
  has stopped being the interesting part.

  Every list is the same shape — a label, a count, a share and a bar — because
  every one of them answers the same question about a different column, and
  giving each its own chart would be decoration. What differs is the
  vocabulary: nothing here shows a raw property value, because a top-N of
  "vsrg", "mineduel", "2048" is a list of ids, and the thing I actually want to
  know is that people play Rhythm Keys.

  All of it is one query type. peeko keeps the whole property bag unparsed, so
  ranking a new custom event is a row in BREAKDOWNS and a panel here, with no
  server change and no migration behind it.
*/

function rowsOf(
  breakdown: Breakdown | undefined,
  label: (value: string) => string = (v) => v,
  icon?: (value: string) => string,
): BarRow[] {
  return (breakdown?.rows ?? []).map((row) => ({
    label: label(row.value),
    count: row.count,
    icon: icon?.(row.value),
    // The raw value stays reachable, because a friendly name that turns out to
    // be wrong is worse than an id if you cannot see what it was built from.
    title: `${row.value} — ${row.count}`,
  }))
}

export function PeekoInsights({
  monitor,
  breakdowns,
  rangeHours,
}: {
  monitor: Monitor
  breakdowns: Record<string, Breakdown>
  rangeHours: number
}) {
  const range = rangeLabel(rangeHours)

  // The scroll spine reports one event per quarter, so this is a funnel and
  // has to stay in depth order; sorted by count it would just be a staircase
  // with no meaning in the sequence.
  const depth = [...(breakdowns['scroll_depth:depth']?.rows ?? [])]
    .sort((a, b) => Number(a.value) - Number(b.value))
    .map((row) => ({
      label: Number(row.value) >= 99 ? 'all the way down' : `${row.value}% down`,
      count: row.count,
    }))
  const readers = depth[0]?.count ?? 0

  const devices = monitor.devices
    .filter((d) => d.count > 0)
    .map((d) => ({
      label: d.kind === 'mobile' ? 'phone' : d.kind === 'desktop' ? 'computer' : 'unknown',
      count: d.count,
    }))

  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      <Panel title="Pages" hint={`pageviews, ${range}`}>
        <BarList
          rows={monitor.topPaths.map((p) => ({
            label: labelFor.page(p.path),
            count: p.count,
            note: labelFor.page(p.path) === p.path ? undefined : p.path,
            title: `${p.path} — ${p.count}`,
          }))}
          empty="No pageviews in this range."
        />
      </Panel>

      <Panel title="Where they are" hint={`visitors by country, ${range}`}>
        <BarList
          rows={monitor.topCountries.slice(0, 12).map((c) => ({
            label: countryName(c.country),
            icon: flagFor(c.country),
            count: c.count,
          }))}
          empty="No country resolved yet."
          tone="bg-emerald-600/20"
        />
      </Panel>

      <Panel title="How they got here" hint="visitors by referring site">
        <BarList
          rows={monitor.topReferrers.map((r) => ({
            label: referrerLabel(r.domain),
            count: r.count,
            title: `${r.domain} — ${r.count}`,
          }))}
          // peeko only rows a referrer it actually saw, so an empty list is
          // "everyone typed it in or came from a link with no referrer",
          // which on a portfolio is most of the traffic and not a fault.
          empty="Nobody arrived from another site. Direct visits are not listed here."
          tone="bg-violet-600/20"
        />
      </Panel>

      <Panel title="What they browsed on" hint={`visitors, ${range}`}>
        <BarList rows={devices} empty="No screen size reported." tone="bg-stone-500/20" />
      </Panel>

      <Panel title="Projects opened" hint="from the work grid and the modals">
        <BarList
          rows={rowsOf(breakdowns['project_view:slug'], labelFor.project)}
          empty="Nobody opened a project in this range."
          tone="bg-violet-600/20"
        />
      </Panel>

      <Panel title="How far they read" hint={`${readers ? `of ${readers} who got a quarter down` : 'the scroll spine'}`}>
        <BarList
          rows={depth}
          empty="Nobody scrolled far enough to report."
          tone="bg-blue-600/20"
          total={readers}
        />
      </Panel>

      <Panel title="Which rendering" hint="visitors, not pageviews">
        <BarList
          rows={rowsOf(breakdowns['$pageview:rendering'], labelFor.rendering)}
          empty="No pageviews in this range."
        />
      </Panel>

      <Panel title="The way into AlejOS" hint="boots from the portfolio page">
        <BarList
          rows={rowsOf(breakdowns['os_boot:via'], labelFor.boot)}
          // The three OS routes never fire os_boot — AlejOS boots those
          // itself, and their pageview above already says which door it was.
          empty="No boots from the page in this range."
          tone="bg-teal-600/20"
        />
      </Panel>

      <Panel title="Apps opened" hint="windows on the desktop">
        <BarList
          rows={rowsOf(breakdowns['app_open:app'], labelFor.app)}
          empty="Nobody opened anything in there."
          tone="bg-amber-600/20"
        />
      </Panel>

      <Panel title="Out in the world" hint="vehicles taken">
        <BarList
          rows={rowsOf(breakdowns['vehicle_entered:kind'], labelFor.vehicle)}
          empty="Nobody got into anything."
          tone="bg-emerald-600/20"
        />
      </Panel>

      <Panel title="Made themselves at home" hint="seats taken in the house">
        <BarList
          rows={rowsOf(breakdowns['house_sit:seat'])}
          empty="Nobody sat down."
          tone="bg-orange-600/20"
        />
      </Panel>

      <Panel title="On the telly" hint="channels turned on">
        <BarList
          rows={rowsOf(breakdowns['house_tv:channel'])}
          empty="The set stayed off."
          tone="bg-indigo-600/20"
        />
      </Panel>

      <Panel title="Signed in" hint="visitors reaching the desktop">
        <BarList
          rows={rowsOf(breakdowns['os_login:kind'], labelFor.login)}
          empty="Nobody got past the login screen."
          tone="bg-teal-600/20"
        />
      </Panel>

      <Panel title="Reached out" hint="clicks on a contact link">
        <BarList
          rows={rowsOf(breakdowns['contact_click:target'], labelFor.contact)}
          empty="Nobody clicked a contact link."
          tone="bg-rose-600/20"
        />
      </Panel>
    </div>
  )
}
