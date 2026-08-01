import { showcase } from '../../data/projects'
import type { FeedEvent } from './peeko'

/*
  peeko's reading layer: the half of the dashboard that turns a captured row
  into a sentence, and a pile of rows into visitors.

  It exists because the raw feed is unreadable. `$pageview /projects/aula` and
  `app_open {app:"vsrg"}` are what the wire carries, and a list of those is a
  log, not a dashboard — you have to already know the site's schema to read a
  single line of it. Every row here comes out as verb + subject + detail
  ("opened Rhythm Keys · in AlejOS"), which is the whole difference between
  glancing at the window and studying it.

  Two rules hold this file together.

  Nothing here formats an absolute time in anything but the reader's own
  timezone, and most of it does not format one at all. Rows age ("4m", "2h
  15m") rather than carrying a clock, because an age is the same number
  everywhere on earth. The one place a wall clock appears is the chart axis,
  where it is built from `Date` in the browser. The server's own label is
  deliberately ignored: it is rendered on a VPS in whatever zone that box is
  set to, which is how a midnight visit came back reading 6am.

  And it is React-free and DOM-free, so the sentences and the session stitching
  can be reasoned about (and asserted on) without mounting anything.
*/

export type ActivityKind =
  | 'visit'
  | 'project'
  | 'os'
  | 'app'
  | 'world'
  | 'contact'
  | 'signal'

export const ACTIVITY_KINDS: ActivityKind[] = [
  'visit',
  'project',
  'os',
  'app',
  'world',
  'contact',
  'signal',
]

export interface Activity {
  kind: ActivityKind
  /** "opened", "booted", "walked into" — the sentence's verb */
  verb: string
  /** the thing acted on; rendered bright */
  subject: string
  /** trailing context; rendered dim */
  detail: string | null
}

/*
  Slug -> the project's real name, straight out of the data module the pages
  are built from. A second table here would go stale the first time a project
  is renamed, and `projects.ts` is already in this chunk (the mail composer
  reads my address out of it), so this costs nothing.
*/
const PROJECT_NAMES = new Map(showcase.map((p) => [p.slug, p.name]))

/*
  App id -> what the Start menu calls it. Not read from `apps.tsx`, which
  imports this window's component: the cycle would resolve, but a registry
  importing its own contents' vocabulary is a trap for whoever adds the next
  app. Ids missing from here fall back to themselves, which for `snake` and
  `paint` is already the right answer.
*/
const APP_NAMES: Record<string, string> = {
  explorer: 'My Computer',
  notepad: 'Notepad',
  viewer: 'the image viewer',
  browser: 'Internet Explorer',
  chat: 'Chat Rooms',
  terminal: 'the terminal',
  minesweeper: 'Minesweeper',
  paint: 'Paint',
  display: 'Display Properties',
  peeko: 'peeko',
  pong: 'Pong',
  snake: 'Snake',
  memory: 'Memory Match',
  '2048': '2048',
  whack: 'Whack-a-Mole',
  flappy: 'Flappy',
  vsrg: 'Rhythm Keys',
  mineduel: 'Mine Duel',
  solitaire: 'Solitaire',
}

/*
  How they got into the OS, spelled the way the door reads from outside. `via`
  can also be 'other', which is deliberately absent: the boot happened, and
  there is nothing true to say about where from.
*/
const BOOT_DOORS: Record<string, string> = {
  plane: 'flew the paper plane in',
  palette: 'from the command palette',
  terminal: 'from the terminal',
  contact: 'from the contact section',
}

const RENDERING_NAMES: Record<string, string> = {
  full: 'the playground',
  simple: 'the plain résumé',
}

const VEHICLE_NAMES: Record<string, string> = {
  car: 'the car',
  boat: 'the boat',
  heli: 'the helicopter',
  helicopter: 'the helicopter',
}

const PAGE_NAMES: Record<string, string> = {
  '/': 'the front page',
  '/alejOS': 'AlejOS on the CRT',
  '/pc': 'the flat desktop',
  '/world': 'the open world',
  '/room': 'the open world',
}

function str(props: Record<string, unknown>, key: string): string | null {
  const value = props[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function num(props: Record<string, unknown>, key: string): number | null {
  const value = props[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function join(parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()))
  return kept.length > 0 ? kept.join(' · ') : null
}

function projectName(slug: string): string {
  return PROJECT_NAMES.get(slug) ?? slug.replace(/-/g, ' ')
}

/*
  The same vocabulary the feed sentences use, exposed one value at a time for
  the aggregate lists, which rank raw property values rather than whole events.
  A breakdown of `app_open` by `app` comes back as "vsrg", and a ranked list of
  ids is exactly as unreadable as a ranked list of anything else.
*/
export const labelFor = {
  project: projectName,
  app: (id: string) => APP_NAMES[id] ?? id,
  page: (path: string) =>
    path.startsWith('/projects/')
      ? projectName(decodeURIComponent(path.slice('/projects/'.length)))
      : (PAGE_NAMES[path] ?? path),
  rendering: (id: string) => RENDERING_NAMES[id] ?? id,
  vehicle: (id: string) => VEHICLE_NAMES[id] ?? id,
  boot: (via: string) =>
    ({
      plane: 'the paper plane',
      palette: 'the command palette',
      terminal: 'the terminal',
      contact: 'the contact section',
      other: 'somewhere else',
    })[via] ?? via,
  login: (kind: string) => (kind === 'user' ? 'with an account' : kind === 'guest' ? 'as a guest' : kind),
  contact: (target: string) =>
    ({ email: 'my email', github: 'GitHub', linkedin: 'LinkedIn' })[target] ?? target,
}

/** The rendering an event was captured under, as a phrase or nothing. */
function renderingDetail(props: Record<string, unknown>): string | null {
  const rendering = str(props, 'rendering')
  if (!rendering) return null
  return RENDERING_NAMES[rendering] ?? rendering
}

function describePageview(event: FeedEvent): Activity {
  const path = event.path ?? '/'

  if (path.startsWith('/projects/')) {
    const slug = decodeURIComponent(path.slice('/projects/'.length))
    return {
      kind: 'project',
      verb: 'read',
      subject: projectName(slug),
      detail: 'its own page',
    }
  }

  // The three OS routes are doors, not pages: arriving on one is the whole
  // event, and which one says how much of the machine they asked for.
  if (path === '/alejOS' || path === '/pc') {
    return {
      kind: 'os',
      verb: 'booted into',
      subject: PAGE_NAMES[path],
      detail: path === '/pc' ? 'no 3D at all' : 'the room only',
    }
  }
  if (path === '/world' || path === '/room') {
    return { kind: 'world', verb: 'walked into', subject: 'the open world', detail: 'straight in' }
  }

  const known = PAGE_NAMES[path]
  return {
    kind: 'visit',
    verb: known ? 'landed on' : 'visited',
    subject: known ?? path,
    detail: renderingDetail(event.properties),
  }
}

/**
 * One captured row as a sentence. Unknown events fall through to their own
 * name rather than being dropped, so instrumentation added later still shows
 * up in the feed on the day it ships, without a change here.
 */
export function describeEvent(event: FeedEvent): Activity {
  const props = event.properties ?? {}

  switch (event.event) {
    case '$pageview':
      return describePageview(event)

    case 'project_view': {
      const slug = str(props, 'slug')
      const source = str(props, 'source')
      return {
        kind: 'project',
        verb: 'opened',
        subject: slug ? projectName(slug) : 'a project',
        detail: source === 'grid' ? 'from the work grid' : source,
      }
    }

    case 'os_boot': {
      const door = BOOT_DOORS[str(props, 'via') ?? ''] ?? null
      const app = str(props, 'app')
      return {
        kind: 'os',
        verb: props.world === true ? 'went straight out to' : 'booted',
        subject: props.world === true ? 'the open world' : 'AlejOS',
        detail: join([
          door,
          props.flat === true ? 'without the 3D' : null,
          app ? `heading for ${APP_NAMES[app] ?? app}` : null,
        ]),
      }
    }

    case 'os_login':
      return {
        kind: 'os',
        verb: 'signed in',
        subject: props.admin === true ? 'as the admin' : str(props, 'kind') === 'user' ? 'with an account' : 'as a guest',
        detail: event.viewerUsername,
      }

    case 'app_open': {
      const app = str(props, 'app')
      return {
        kind: 'app',
        verb: 'opened',
        subject: app ? (APP_NAMES[app] ?? app) : 'an app',
        detail: 'on the desktop',
      }
    }

    case 'palette_open':
      return { kind: 'signal', verb: 'opened', subject: 'the command palette', detail: null }
    case 'terminal_open':
      return { kind: 'signal', verb: 'opened', subject: 'the terminal', detail: null }
    case 'chooser_open':
      return { kind: 'signal', verb: 'opened', subject: 'the version chooser', detail: null }

    case 'world_joined': {
      const players = num(props, 'players')
      return {
        kind: 'world',
        verb: 'joined',
        subject: 'the shared world',
        // The count includes them, so one player is nobody else out there.
        detail:
          players == null
            ? null
            : players <= 1
              ? 'alone out there'
              : `${players - 1} other${players - 1 === 1 ? '' : 's'} already walking`,
      }
    }

    case 'vehicle_entered': {
      const kind = str(props, 'kind')
      const seat = num(props, 'seat')
      return {
        kind: 'world',
        verb: 'got into',
        subject: kind ? (VEHICLE_NAMES[kind] ?? `the ${kind}`) : 'a vehicle',
        detail: seat == null ? null : seat === 0 ? 'driving' : 'riding along',
      }
    }

    case 'world_voice':
      return { kind: 'world', verb: 'opened', subject: 'their mic', detail: 'proximity voice' }

    case 'house_sit':
      return {
        kind: 'world',
        verb: 'sat down on',
        subject: str(props, 'seat') ?? 'the furniture',
        detail: null,
      }

    case 'house_tv':
      return {
        kind: 'world',
        verb: 'turned on',
        subject: 'the television',
        detail: str(props, 'channel'),
      }

    case 'contact_click': {
      const target = str(props, 'target')
      return {
        kind: 'contact',
        verb: 'clicked through to',
        subject: target === 'email' ? 'my email' : target === 'github' ? 'GitHub' : target === 'linkedin' ? 'LinkedIn' : (target ?? 'a contact link'),
        detail: null,
      }
    }

    case 'version_switch': {
      const to = str(props, 'to')
      const from = str(props, 'from')
      return {
        kind: 'signal',
        verb: 'switched to',
        subject: to ? (RENDERING_NAMES[to] ?? to) : 'another rendering',
        detail: from ? `was on ${RENDERING_NAMES[from] ?? from}` : null,
      }
    }

    case 'scroll_depth': {
      const depth = num(props, 'depth')
      return {
        kind: 'signal',
        verb: 'read down to',
        subject: depth == null ? 'the page' : `${depth}%`,
        // 99 is the last mark the scroll spine reports, so it means the footer.
        detail: depth != null && depth >= 99 ? 'all the way to the bottom' : null,
      }
    }

    case 'sound_toggle':
      return {
        kind: 'signal',
        verb: 'turned the sound',
        subject: props.on === true ? 'on' : 'off',
        detail: null,
      }

    case 'nudge_dismissed':
      return { kind: 'signal', verb: 'dismissed', subject: 'the version nudge', detail: null }

    default:
      // An event this file has never heard of. Say its name and where it
      // happened rather than pretending it did not arrive.
      return {
        kind: 'signal',
        verb: 'sent',
        subject: event.event,
        detail: event.path,
      }
  }
}

/** Flat text of a described row, for tooltips and the compact trail lines. */
export function activityText(activity: Activity): string {
  return join([`${activity.verb} ${activity.subject}`, activity.detail]) ?? activity.subject
}

/*
  A visitor counts as "here now" while their last event is inside this window.
  It is the same five minutes peeko's own activeVisitors uses, so the card
  count under "Right now" and the number in the stat tile above it can never
  disagree.
*/
export const ONLINE_WINDOW_MS = 5 * 60_000

export interface Session {
  distinctId: string
  /** arrival order; the UI derives a colour and a V-number from it */
  slot: number
  label: string
  country: string | null
  deviceKind: FeedEvent['deviceKind']
  viewerUsername: string | null
  referrer: string | null
  firstTs: number
  lastTs: number
  durationMs: number
  online: boolean
  /** newest first, matching the feed they came from */
  events: FeedEvent[]
}

/**
 * Fold the flat feed into one entry per visitor.
 *
 * Rows arrive newest-first and stay that way, so the sessions come out ordered
 * by most recent activity and each trail reads top-down from what they are
 * doing now back to how they arrived.
 */
export function buildSessions(rows: FeedEvent[], now: number): Session[] {
  const byVisitor = new Map<string, Session>()

  for (const row of rows) {
    const id = row.distinctId || 'unknown'
    let session = byVisitor.get(id)
    if (!session) {
      const slot = byVisitor.size
      session = {
        distinctId: id,
        slot,
        label: `V${slot + 1}`,
        country: row.country,
        deviceKind: row.deviceKind,
        viewerUsername: row.viewerUsername,
        referrer: null,
        firstTs: row.ts,
        lastTs: row.ts,
        durationMs: 0,
        online: false,
        events: [],
      }
      byVisitor.set(id, session)
    }
    // Fill the blanks from whichever row happens to carry them: a country
    // resolved from a timezone is on every row, but a device width is only on
    // rows captured after the page measured itself.
    if (!session.country && row.country) session.country = row.country
    if (session.deviceKind === 'unknown' && row.deviceKind !== 'unknown') {
      session.deviceKind = row.deviceKind
    }
    if (!session.viewerUsername && row.viewerUsername) session.viewerUsername = row.viewerUsername
    // Newest to oldest, so the last referrer seen is the one they came in on.
    if (row.referringDomain) session.referrer = row.referringDomain
    if (Number.isFinite(row.ts)) {
      if (row.ts > session.lastTs) session.lastTs = row.ts
      if (row.ts < session.firstTs) session.firstTs = row.ts
    }
    session.events.push(row)
  }

  return [...byVisitor.values()].map((session) => ({
    ...session,
    durationMs: Math.max(0, session.lastTs - session.firstTs),
    online: now - session.lastTs <= ONLINE_WINDOW_MS,
  }))
}

/** The selected range as a phrase a caption can end on. */
export function rangeLabel(hours: number): string {
  if (hours === 1) return 'the last hour'
  if (hours < 24) return `the last ${hours}h`
  if (hours === 24) return 'the last 24 hours'
  return `the last ${Math.round(hours / 24)} days`
}

/** Compact age for a feed row: "now", "42s", "7m", "3h 20m", "2d". */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 0) return 'now'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest ? `${hours}h ${rest}m` : `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

/** How long a visit lasted, which reads better spelled out than aged. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/**
 * A wall clock for one moment, in the reader's own zone.
 *
 * `Intl` with no locale and no timeZone is the point: it resolves both from
 * the browser, so this says 6am when it was 6am for whoever is looking at it.
 * Past about a day and a half, a time of day stops placing anything and the
 * date is what is wanted instead.
 */
export function formatClock(ts: number, spanMs = 0): string {
  const date = new Date(ts)
  if (spanMs > 36 * 60 * 60_000) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** The full local timestamp, for the tooltip behind an age. */
export function formatExact(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

/*
  Round wall-clock steps for the traffic axis. Buckets are spaced evenly from
  the start of the range, so their own edges land on arbitrary times like 11:27;
  ticks are a separate overlay that snaps to times a person recognises.
*/
const TICK_STEPS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
]

export interface TimelineTick {
  ts: number
  /** 0..1 across the plotted span, for absolute positioning */
  position: number
}

/**
 * Snap up to the next round step *in local time*, so hours land on the hour
 * and days land on local midnight whatever the reader's offset from UTC is.
 * Rounding the epoch directly would put the day ticks on UTC midnight, which
 * for most of the world is the middle of an afternoon.
 */
function ceilToLocalStep(ts: number, stepMs: number): number {
  const offsetMs = new Date(ts).getTimezoneOffset() * 60_000
  return Math.ceil((ts - offsetMs) / stepMs) * stepMs + offsetMs
}

export function buildTicks(startTs: number, endTs: number, maxTicks = 4): TimelineTick[] {
  const span = endTs - startTs
  if (!Number.isFinite(span) || span <= 0) return []
  const step = TICK_STEPS_MS.find((s) => span / s <= maxTicks) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]
  const ticks: TimelineTick[] = []
  for (let ts = ceilToLocalStep(startTs, step); ts < endTs; ts += step) {
    const position = (ts - startTs) / span
    // The two edges already carry the range's own start label and "now"; a
    // tick there prints the same clock twice.
    if (position < 0.06 || position > 0.88) continue
    ticks.push({ ts, position })
  }
  return ticks
}

const REFERRER_NAMES: Record<string, string> = {
  'google.com': 'Google',
  'www.google.com': 'Google',
  'duckduckgo.com': 'DuckDuckGo',
  'bing.com': 'Bing',
  'github.com': 'GitHub',
  'www.linkedin.com': 'LinkedIn',
  'linkedin.com': 'LinkedIn',
  'lnkd.in': 'LinkedIn',
  't.co': 'Twitter / X',
  'x.com': 'Twitter / X',
  'twitter.com': 'Twitter / X',
  'news.ycombinator.com': 'Hacker News',
  'reddit.com': 'Reddit',
  'www.reddit.com': 'Reddit',
  'old.reddit.com': 'Reddit',
  'discord.com': 'Discord',
  'youtube.com': 'YouTube',
  'www.youtube.com': 'YouTube',
}

export function referrerLabel(domain: string): string {
  return REFERRER_NAMES[domain] ?? domain.replace(/^www\./, '')
}

/** "CR" -> "Costa Rica", using the table the browser already ships. */
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()

export function countryName(code: string): string {
  try {
    return regionNames?.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

/**
 * "CR" -> 🇨🇷. A flag emoji is just its two letters as regional indicator
 * symbols, so there is no image to ship. Windows has no flag glyphs and will
 * render the letters instead, which is why the code stays visible next to it
 * rather than being replaced by the flag.
 */
export function flagFor(code: string | null): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return ''
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}
