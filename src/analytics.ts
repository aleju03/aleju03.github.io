import {
  BOOT_OS_EVENT,
  NAVIGATE_EVENT,
  OPEN_CHOOSER_EVENT,
  OPEN_PALETTE_EVENT,
  OPEN_TERMINAL_EVENT,
} from './events'
import { isOsPath } from './version'
import { onScrollFrame } from './scroll/progress'

/*
  Traffic capture, talking to the peeko store that lives in server/ (see
  server/src/analytics.js). This site is a static bundle on GitHub Pages, so
  the only thing it can do is describe what happened and post it; every
  decision about what to keep, and every read of the result, happens on the
  server behind an admin login.

  Shaped after PostHog's wire format because peeko is — an events array of
  {event, distinct_id, timestamp, properties}, with the properties peeko lifts
  into real columns spelled its way ($host, $pathname, $referring_domain,
  $screen_width, $viewport_width, viewer_username). Anything else rides along
  in the bag and comes back out through getBreakdown, which is how the custom
  events below (which project, which game, which way into the OS) stay
  queryable without the server knowing this site's schema.

  Three rules this module holds itself to:

  - Never break the page. Every entry point swallows its own errors; no
    network failure, blocked request or absent storage may surface.
  - Never block. Events queue and leave in one batch on an idle callback, and
    the queue is flushed with sendBeacon when the tab goes away, so a visitor
    who closes the tab still counts.
  - Never identify anyone. The visitor id is a random string in localStorage
    with no cookie and no fingerprint, the server keeps no IP, and the only
    name ever attached is a username someone typed into the AlejOS login
    themselves.

  No VITE_CHAT_URL at build time and the whole module folds to no-ops — the
  same deal chat, the arcade and the login screen already make.
*/

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined

/** wss://chat.example.com/ws -> https://chat.example.com/peeko/capture */
function captureUrl(): string | null {
  if (!CHAT_URL) return null
  try {
    const url = new URL(CHAT_URL)
    url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'
    url.pathname = '/peeko/capture'
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

const ENDPOINT = captureUrl()

const VISITOR_KEY = 'alejos-visitor'
const FLUSH_DELAY_MS = 2_000
const MAX_QUEUE = 20

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>

interface QueuedEvent {
  event: string
  distinct_id: string
  timestamp: string
  properties: Record<string, unknown>
}

let visitorId: string | null = null
let viewerUsername: string | null = null
let rendering: string | null = null
let queue: QueuedEvent[] = []
let flushTimer = 0

/**
 * A random per-browser id, so "unique visitors" means something without a
 * cookie banner. Regenerated freely: a visitor who clears storage is simply a
 * new visitor, which is the correct amount of tracking for a portfolio.
 */
function getVisitorId(): string {
  if (visitorId) return visitorId
  try {
    const stored = localStorage.getItem(VISITOR_KEY)
    if (stored) {
      visitorId = stored
      return stored
    }
  } catch {
    /* storage disabled — fall through to an in-memory id for this page life */
  }
  const fresh =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `v-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  visitorId = fresh
  try {
    localStorage.setItem(VISITOR_KEY, fresh)
  } catch {
    /* storage disabled — the id lasts until reload */
  }
  return fresh
}

/** the referring site, or null for direct traffic and same-site navigation */
function referringDomain(): string | null {
  try {
    if (!document.referrer) return null
    const host = new URL(document.referrer).hostname
    return host && host !== location.hostname ? host : null
  } catch {
    return null
  }
}

function baseProperties(): Record<string, unknown> {
  return {
    $host: location.host,
    $pathname: location.pathname,
    $referring_domain: referringDomain(),
    $screen_width: typeof screen !== 'undefined' ? screen.width : null,
    $viewport_width: window.innerWidth,
    viewer_username: viewerUsername,
    rendering,
  }
}

/**
 * The browser's IANA timezone, appended to the capture URL so the server can
 * resolve a country from it when nothing upstream sends a geo header.
 *
 * A query param specifically: sendBeacon cannot set headers, and a custom
 * header would make capture a preflighted request — an extra round trip on
 * every page for one string.
 */
function endpointWithZone(): string | null {
  if (!ENDPOINT) return null
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone ? `${ENDPOINT}?tz=${encodeURIComponent(zone)}` : ENDPOINT
  } catch {
    return ENDPOINT
  }
}

function send(body: string, beacon: boolean): void {
  const endpoint = endpointWithZone()
  if (!endpoint) return
  // text/plain keeps this a CORS-simple request: no preflight round trip on
  // every page, and sendBeacon can only send safelisted types anyway. peeko
  // parses the body as JSON regardless of what the header claims.
  const type = 'text/plain;charset=UTF-8'
  try {
    if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type }))
      return
    }
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
      keepalive: true,
      mode: 'cors',
      credentials: 'omit',
    }).catch(() => {})
  } catch {
    /* offline, blocked by an extension, quota — analytics never escalates */
  }
}

function flush(beacon = false): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = 0
  }
  if (queue.length === 0) return
  const batch = queue
  queue = []
  try {
    send(JSON.stringify({ batch }), beacon)
  } catch {
    /* serialization failed — drop it rather than retry forever */
  }
}

function scheduleFlush(): void {
  if (queue.length >= MAX_QUEUE) {
    flush()
    return
  }
  if (flushTimer) return
  flushTimer = window.setTimeout(flush, FLUSH_DELAY_MS)
}

/**
 * Record one event. Unknown property names are fine — they land in peeko's
 * props bag and come back through getBreakdown on the dashboard.
 */
export function track(event: string, props: AnalyticsProps = {}): void {
  if (!ENDPOINT) return
  try {
    queue.push({
      event,
      distinct_id: getVisitorId(),
      timestamp: new Date().toISOString(),
      properties: { ...baseProperties(), ...props },
    })
    scheduleFlush()
  } catch {
    /* never let instrumentation take the page down */
  }
}

let lastPath = ''

/**
 * A pageview for the SPA's current route. Deduped, because the version router
 * re-syncs on several events that do not always mean the path moved.
 */
export function pageview(props: AnalyticsProps = {}): void {
  const key = `${location.pathname}${location.search}`
  if (key === lastPath) return
  lastPath = key
  track('$pageview', props)
}

/**
 * Attach the AlejOS account to subsequent events. The server uses it to keep
 * my own visits out of the live feed; nobody else's name is ever attached
 * unless they typed it into the login screen themselves.
 */
export function setViewer(username: string | null): void {
  viewerUsername = username
}

/**
 * Which rendering of the site is on screen ('full', 'simple' or 'pc'). Rides
 * along on every event, so the dashboard can break any of them down by it.
 */
export function setRendering(name: string | null): void {
  rendering = name
}

let started = false

/**
 * Wire the things the site already announces to itself. events.ts is the
 * spine every far-apart component talks over, so subscribing here means the
 * palette, the terminal, the chooser and every route into the OS are all
 * instrumented without a single call site inside those components.
 */
export function startAnalytics(): void {
  if (started || !ENDPOINT) return
  started = true

  const detailOf = (e: Event) =>
    (e as CustomEvent<Record<string, unknown> | undefined>).detail ?? {}

  window.addEventListener(BOOT_OS_EVENT, (e) => {
    const detail = detailOf(e)
    track('os_boot', {
      // how they got in: the hero's paper plane, the palette, the terminal or
      // the contact section. The three OS routes never reach here — AlejOS
      // boots those itself, and their $pageview already says which door it was
      via: typeof detail.via === 'string' ? detail.via : 'other',
      flat: detail.flat === true,
      world: detail.world === true,
      app: typeof detail.app === 'string' ? detail.app : undefined,
    })
  })
  window.addEventListener(OPEN_PALETTE_EVENT, () => track('palette_open'))
  window.addEventListener(OPEN_TERMINAL_EVENT, () => track('terminal_open'))
  window.addEventListener(OPEN_CHOOSER_EVENT, () => track('chooser_open'))
  window.addEventListener(NAVIGATE_EVENT, () => pageview())
  window.addEventListener('popstate', () => pageview())

  // How far down the page people actually get: one event per quarter, each
  // reported once. Skipped on the OS routes, which have no page to scroll —
  // subscribing there would spin the scroll driver for nothing.
  if (!isOsPath()) {
    const marks = [0.25, 0.5, 0.75, 0.99]
    let reached = 0
    onScrollFrame(({ depth }) => {
      while (reached < marks.length && depth >= marks[reached]) {
        track('scroll_depth', { depth: Math.round(marks[reached] * 100) })
        reached++
      }
    })
  }

  // A tab being hidden is the last reliable moment to send: pagehide alone
  // misses the mobile case where the tab is backgrounded and then killed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true)
  })
  window.addEventListener('pagehide', () => flush(true))
}
