import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from './osContext'
import { sessionExpired } from './session'

/*
  Client for the analytics half of the chat server (server/src/analytics.js).

  Every read here is admin-only, and the gate is entirely server-side: this
  opens an ordinary chat socket, says hello with the session token the login
  screen minted, and the server answers peeko-* messages only when that token
  resolved to the reserved account. Nothing in this file is a security
  boundary — hiding the app from the Start menu is a courtesy, and a visitor
  who calls these messages by hand gets `forbidden` back.

  Reads ride the WebSocket rather than peeko's own HTTP routes on purpose:
  those are gated by a bearer token, and a dashboard token in browser
  JavaScript is a published token. The socket is already authenticated, so it
  is the one place the browser can ask for numbers without holding a secret.

  The live ticker is the same subscription the server's SSE feed would give,
  pushed down the socket instead — pre-filtered server-side by the same rules
  the historical rollup uses, so the two never disagree.

  Two things this hook owns beyond fetching. It carries the **server's clock**
  next to every rollup, so the dashboard can age rows against the machine that
  stored them rather than against a laptop that might be a minute out. And it
  keeps the **live rows and the historical rows in one list**, deduplicated by
  visitor and timestamp, so an event that arrives on the socket does not blink
  out and reappear the next time the rollup lands.
*/

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined

/** How far back the merged feed reaches. The server sends fewer than this. */
const FEED_MAX = 500
const REFRESH_MS = 30_000

/**
 * What `FEED_LIMIT` is on the server (server/src/analytics.js). A rollup that
 * comes back exactly this long means the range held more than the feed can
 * carry, and the dashboard has to say "last N" rather than "N".
 */
export const SERVER_FEED_LIMIT = 400

export interface FeedEvent {
  /**
   * A clock label from the server, in whatever zone the VPS is configured
   * for. Nothing in the dashboard reads it: every time on screen is built
   * from `ts` in the browser instead. Kept on the type because it is on the
   * wire, and deleting a field peeko sends would be a lie about the protocol.
   */
  timestamp: string
  /** raw event time, epoch ms — this is what the UI actually uses */
  ts: number
  event: string
  path: string | null
  country: string | null
  referringDomain: string | null
  deviceKind: 'mobile' | 'desktop' | 'unknown'
  distinctId: string
  viewerUsername: string | null
  properties: Record<string, unknown>
}

export interface TimelineBucket {
  ts: number
  events: number
  pageviews: number
  visitors: number
}

export interface Monitor {
  rangeHours: number
  /** the country the feed was filtered to, echoed back, or null */
  country: string | null
  /** the server's clock at the moment it answered */
  now: number
  overview: {
    rangeHours: number
    activeVisitors: number
    pageviews: number
    uniqueVisitors: number
    events: number
  }
  topPaths: { path: string; count: number }[]
  topReferrers: { domain: string; count: number }[]
  topCountries: { country: string; count: number }[]
  bounce: { bounced: number; landers: number }
  recent: FeedEvent[]
  bucketMs: number
  timeline: TimelineBucket[]
  devices: { kind: string; count: number }[]
  visitors: { total: number; fresh: number }
  bots: number
}

export interface Breakdown {
  event: string | null
  prop: string
  rows: { value: string; count: number }[]
}

export type PeekoStatus = 'connecting' | 'online' | 'offline' | 'denied' | 'unavailable'

/*
  The ranges the dashboard offers, in hours. 30 days is the ceiling because
  peeko's read API clamps every query to 720 hours: a "90d" button would have
  answered with a month of data under a quarter's label.
*/
export const RANGES = [
  { hours: 1, label: '1h' },
  { hours: 24, label: '24h' },
  { hours: 24 * 7, label: '7d' },
  { hours: 24 * 30, label: '30d' },
] as const

/*
  The custom events this site emits, and the property worth ranking each one
  by. Adding a row here is the whole cost of putting a new `track()` call on
  the dashboard: peeko keeps the props bag unparsed, so there is no server
  change and no migration behind any of these.
*/
export interface BreakdownSpec {
  key: string
  event: string | null
  prop: string
  /** count visitors rather than events, where one person doing it twice is noise */
  distinct?: boolean
}

export const BREAKDOWNS: BreakdownSpec[] = [
  { key: 'projects', event: 'project_view', prop: 'slug' },
  { key: 'apps', event: 'app_open', prop: 'app' },
  { key: 'boots', event: 'os_boot', prop: 'via' },
  { key: 'rendering', event: '$pageview', prop: 'rendering', distinct: true },
  { key: 'depth', event: 'scroll_depth', prop: 'depth', distinct: true },
  { key: 'contact', event: 'contact_click', prop: 'target' },
  { key: 'vehicles', event: 'vehicle_entered', prop: 'kind' },
  { key: 'seats', event: 'house_sit', prop: 'seat' },
  { key: 'channels', event: 'house_tv', prop: 'channel' },
  { key: 'logins', event: 'os_login', prop: 'kind', distinct: true },
]

const RANGE_KEY = 'peeko-range'

function storedRange(): number {
  try {
    const raw = Number(localStorage.getItem(RANGE_KEY))
    if (RANGES.some((r) => r.hours === raw)) return raw
  } catch {
    /* storage disabled — the default range is fine */
  }
  return 24
}

/** newest first, one row per (visitor, moment, event) */
function mergeFeed(a: FeedEvent[], b: FeedEvent[]): FeedEvent[] {
  const seen = new Set<string>()
  const out: FeedEvent[] = []
  for (const row of [...a, ...b].sort((x, y) => y.ts - x.ts)) {
    const key = `${row.ts}|${row.distinctId}|${row.event}|${row.path ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
    if (out.length >= FEED_MAX) break
  }
  return out
}

export function usePeeko(session: Session) {
  const enabled = Boolean(CHAT_URL && session.admin && session.token)
  const [status, setStatus] = useState<PeekoStatus>(enabled ? 'connecting' : 'offline')
  const [monitor, setMonitor] = useState<Monitor | null>(null)
  const [feed, setFeed] = useState<FeedEvent[]>([])
  const [breakdowns, setBreakdowns] = useState<Record<string, Breakdown>>({})
  const [rangeHours, setRangeHours] = useState<number>(storedRange)
  const [country, setCountry] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(enabled)
  const [auto, setAuto] = useState(true)
  /** wall-clock ms to add to a local Date.now() to land on the server's clock */
  const [clockSkew, setClockSkew] = useState(0)
  const [fetchedAt, setFetchedAt] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  /*
    What the socket's own callbacks should ask for. It is a ref rather than a
    dependency because everything that reads it fires asynchronously — a
    reconnect finishing, the refresh interval, a live event arriving — and
    threading the current range through those would tear down and rebuild the
    WebSocket every time a button is pressed.
  */
  const queryRef = useRef({ hours: rangeHours, country })
  useEffect(() => {
    queryRef.current = { hours: rangeHours, country }
  }, [rangeHours, country])

  const sendRaw = useCallback((payload: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }, [])

  /** ask for everything the dashboard shows at the current range */
  const requestAll = useCallback(
    (hours: number, forCountry: string | null) => {
      setLoading(true)
      sendRaw({ type: 'peeko-monitor', rangeHours: hours, country: forCountry })
      // The custom events the site emits, read straight out of peeko's props
      // bag — this is the whole reason the engine stays schema-free.
      for (const spec of BREAKDOWNS) {
        sendRaw({
          type: 'peeko-breakdown',
          event: spec.event,
          prop: spec.prop,
          rangeHours: hours,
          distinct: spec.distinct === true,
        })
      }
    },
    [sendRaw],
  )

  useEffect(() => {
    if (!enabled || !CHAT_URL) return
    let disposed = false
    let retry = 0
    let reconnectTimer = 0

    const connect = () => {
      setStatus('connecting')
      let ws: WebSocket
      try {
        ws = new WebSocket(CHAT_URL)
      } catch {
        setStatus('offline')
        return
      }
      wsRef.current = ws

      ws.onopen = () => sendRaw({ type: 'hello', token: session.token })

      ws.onmessage = (ev) => {
        let data: Record<string, unknown>
        try {
          data = JSON.parse(String(ev.data))
        } catch {
          return
        }
        switch (data.type) {
          case 'hello-ok': {
            retry = 0
            // the token did not resolve to the admin account: the server will
            // refuse every read, so say so instead of spinning
            if (!(data.user as { admin?: boolean } | null)?.admin) {
              setStatus('denied')
              setLoading(false)
              // a rejected token means the whole saved session is stale, not
              // just this dashboard
              if (data.badToken) sessionExpired()
              return
            }
            setStatus('online')
            sendRaw({ type: 'peeko-live', on: true })
            requestAll(queryRef.current.hours, queryRef.current.country)
            break
          }
          case 'peeko-monitor': {
            const next = data as unknown as Monitor
            setMonitor(next)
            setLoading(false)
            setError('')
            setFetchedAt(Date.now())
            // Trust the server's clock over this one. Ages are the dashboard's
            // whole notion of time, and a laptop that woke from sleep a minute
            // behind would otherwise report every row as a minute younger.
            setClockSkew(next.now - Date.now())
            // The rollup is the source of truth for what happened; anything
            // the socket pushed since it was queried is folded back on top.
            // Rows that have since fallen out of the range go with it, or an
            // hour on a 1h view would keep accumulating events it no longer
            // covers and the count under "Activity" would drift past the range.
            const since = next.now - next.rangeHours * 60 * 60_000
            setFeed((prev) => mergeFeed(next.recent, prev.filter((row) => row.ts > since)))
            break
          }
          case 'peeko-breakdown': {
            const next = data as unknown as Breakdown
            setBreakdowns((prev) => ({ ...prev, [`${next.event ?? '*'}:${next.prop}`]: next }))
            break
          }
          case 'peeko-event': {
            const event = data.event as FeedEvent
            setFeed((prev) => {
              // A country filter is a server-side clause on the rollup, so the
              // live stream (which is unfiltered) has to respect it here or
              // the feed would fill with rows the header says are excluded.
              const filter = queryRef.current.country
              if (filter && event.country !== filter) return prev
              return mergeFeed([event], prev)
            })
            break
          }
          case 'error': {
            if (data.code === 'forbidden') {
              setStatus('denied')
            } else if (data.code === 'unavailable') {
              setStatus('unavailable')
              setError(String(data.message ?? ''))
            } else if (data.message) {
              setError(String(data.message))
            }
            setLoading(false)
            break
          }
        }
      }

      ws.onclose = () => {
        if (disposed) return
        wsRef.current = null
        setStatus((prev) => (prev === 'denied' || prev === 'unavailable' ? prev : 'offline'))
        retry += 1
        reconnectTimer = window.setTimeout(connect, Math.min(15000, 1500 * 2 ** Math.min(retry, 4)))
      }
      ws.onerror = () => ws.close()
    }

    connect()

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled, session.token, sendRaw, requestAll])

  // The live ticker keeps the feed current on its own; this is only so the
  // aggregates behind it do not go stale on a window left open all afternoon.
  useEffect(() => {
    if (!enabled || !auto) return
    const timer = window.setInterval(
      () => requestAll(queryRef.current.hours, queryRef.current.country),
      REFRESH_MS,
    )
    return () => window.clearInterval(timer)
  }, [enabled, auto, requestAll])

  /*
    Both of these move the ref by hand before asking. The effect above will get
    there on the next render, but the request goes out on this one, and a live
    event arriving in between has to be filtered against the country that is
    now selected rather than the one that just stopped being.
  */
  const setRange = useCallback(
    (hours: number) => {
      setRangeHours(hours)
      queryRef.current = { ...queryRef.current, hours }
      // A narrower range cannot show rows the wider one collected, and a wider
      // one is about to be answered in full, so the feed starts over either way.
      setFeed([])
      try {
        localStorage.setItem(RANGE_KEY, String(hours))
      } catch {
        /* storage disabled — the range lasts until this window closes */
      }
      requestAll(hours, queryRef.current.country)
    },
    [requestAll],
  )

  const selectCountry = useCallback(
    (next: string | null) => {
      setCountry(next)
      queryRef.current = { ...queryRef.current, country: next }
      setFeed([])
      requestAll(queryRef.current.hours, next)
    },
    [requestAll],
  )

  const refresh = useCallback(
    () => requestAll(queryRef.current.hours, queryRef.current.country),
    [requestAll],
  )

  return {
    configured: Boolean(CHAT_URL),
    enabled,
    status,
    monitor,
    feed,
    breakdowns,
    rangeHours,
    setRange,
    country,
    setCountry: selectCountry,
    refresh,
    loading,
    error,
    auto,
    setAuto,
    clockSkew,
    fetchedAt,
  }
}
