import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from './osContext'

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
*/

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined

const LIVE_MAX = 60
const REFRESH_MS = 60_000

export interface FeedEvent {
  timestamp: string
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

export interface Monitor {
  rangeHours: number
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
}

export interface Breakdown {
  event: string | null
  prop: string
  rows: { value: string; count: number }[]
}

export type PeekoStatus = 'connecting' | 'online' | 'offline' | 'denied' | 'unavailable'

/** the ranges the dashboard offers, in hours */
export const RANGES = [
  { hours: 24, label: '24h' },
  { hours: 24 * 7, label: '7d' },
  { hours: 24 * 30, label: '30d' },
  { hours: 24 * 90, label: '90d' },
] as const

export function usePeeko(session: Session) {
  const enabled = Boolean(CHAT_URL && session.admin && session.token)
  const [status, setStatus] = useState<PeekoStatus>(enabled ? 'connecting' : 'offline')
  const [monitor, setMonitor] = useState<Monitor | null>(null)
  const [live, setLive] = useState<FeedEvent[]>([])
  const [breakdowns, setBreakdowns] = useState<Record<string, Breakdown>>({})
  const [rangeHours, setRangeHours] = useState<number>(24)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(enabled)

  const wsRef = useRef<WebSocket | null>(null)
  const rangeRef = useRef(rangeHours)

  const sendRaw = useCallback((payload: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }, [])

  /** ask for everything the dashboard shows at the current range */
  const requestAll = useCallback(
    (hours: number) => {
      setLoading(true)
      sendRaw({ type: 'peeko-monitor', rangeHours: hours })
      // the custom events the site emits, read straight out of peeko's props
      // bag — this is the whole reason the engine stays schema-free
      sendRaw({ type: 'peeko-breakdown', event: 'project_view', prop: 'slug', rangeHours: hours })
      sendRaw({ type: 'peeko-breakdown', event: 'app_open', prop: 'app', rangeHours: hours })
      sendRaw({ type: 'peeko-breakdown', event: 'os_boot', prop: 'via', rangeHours: hours })
      sendRaw({
        type: 'peeko-breakdown',
        event: '$pageview',
        prop: 'rendering',
        rangeHours: hours,
        distinct: true,
      })
    },
    [sendRaw],
  )

  useEffect(() => {
    if (!enabled || !CHAT_URL) return
    let disposed = false
    let retry = 0
    let reconnectTimer = 0
    let refreshTimer = 0

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
              return
            }
            setStatus('online')
            sendRaw({ type: 'peeko-live', on: true })
            requestAll(rangeRef.current)
            break
          }
          case 'peeko-monitor': {
            const next = data as unknown as Monitor
            setMonitor(next)
            setLoading(false)
            setError('')
            // seed the ticker from history so it is never blank on open
            setLive((prev) => (prev.length > 0 ? prev : next.recent.slice(0, LIVE_MAX)))
            break
          }
          case 'peeko-breakdown': {
            const next = data as unknown as Breakdown
            setBreakdowns((prev) => ({ ...prev, [`${next.event ?? '*'}:${next.prop}`]: next }))
            break
          }
          case 'peeko-event': {
            const event = data.event as FeedEvent
            setLive((prev) => [event, ...prev].slice(0, LIVE_MAX))
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
    // the live ticker keeps itself current; this is only so the aggregates do
    // not go stale on a window left open
    refreshTimer = window.setInterval(() => requestAll(rangeRef.current), REFRESH_MS)

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      clearInterval(refreshTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled, session.token, sendRaw, requestAll])

  const setRange = useCallback(
    (hours: number) => {
      rangeRef.current = hours
      setRangeHours(hours)
      requestAll(hours)
    },
    [requestAll],
  )

  const refresh = useCallback(() => requestAll(rangeRef.current), [requestAll])

  return {
    configured: Boolean(CHAT_URL),
    enabled,
    status,
    monitor,
    live,
    breakdowns,
    rangeHours,
    setRange,
    refresh,
    loading,
    error,
  }
}
