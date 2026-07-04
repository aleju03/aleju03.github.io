import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useOs } from '../osContext'
import type { Session } from '../osContext'

/*
  The arcade wire. One shared WebSocket to the chat server carries everything
  the Games folder needs: leaderboard reads and writes, and the Mine Duel
  protocol. It connects on demand when the first game window wants it,
  identifies with the same token/nick the chat uses (so scores carry your
  chat name), and reference-counts subscribers so it hangs up a little after
  the last game window closes.

  No VITE_CHAT_URL at build time (or a dead server) degrades gracefully:
  scores fall back to localStorage personal bests, and every game keeps
  working — the boards just explain that they are offline.
*/

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined
const NICK_KEY = 'alejos-nick' // shared with the chat app, one identity
const BEST_KEY = 'alejos-arcade-best'
const IDLE_CLOSE_MS = 30_000
const REQUEST_TIMEOUT_MS = 8_000

export function arcadeConfigured(): boolean {
  return Boolean(CHAT_URL)
}

/** every leaderboard the server accepts, with how it sorts and displays */
export const GAME_META: Record<string, { order: 'asc' | 'desc'; unit: 'pts' | 'ms' | 'wins' }> = {
  pong: { order: 'desc', unit: 'pts' },
  snake: { order: 'desc', unit: 'pts' },
  memory: { order: 'asc', unit: 'ms' },
  '2048': { order: 'desc', unit: 'pts' },
  whack: { order: 'desc', unit: 'pts' },
  flappy: { order: 'desc', unit: 'pts' },
  'vsrg-badapple': { order: 'desc', unit: 'pts' },
  'vsrg-madeoffire': { order: 'desc', unit: 'pts' },
  'vsrg-freedomdive': { order: 'desc', unit: 'pts' },
  'mine-beginner': { order: 'asc', unit: 'ms' },
  'mine-intermediate': { order: 'asc', unit: 'ms' },
  'mine-expert': { order: 'asc', unit: 'ms' },
  duel: { order: 'desc', unit: 'wins' },
}

export type GameId = keyof typeof GAME_META

export interface ScoreRow {
  name: string
  registered: boolean
  admin: boolean
  score: number
  at: number
}

export interface ScoreBoard {
  top: ScoreRow[]
  you: { score: number; rank: number } | null
}

export interface SubmitResult {
  best: number
  improved: boolean
  rank: number
}

export function formatScore(game: GameId, score: number): string {
  if (GAME_META[game].unit !== 'ms') return String(score)
  const total = Math.round(score / 100) / 10
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return m > 0 ? `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}` : `${s.toFixed(1)}s`
}

// ---------------------------------------------------------------- local bests

function readBests(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') out[k] = v
    return out
  } catch {
    return {}
  }
}

export function localBest(game: GameId): number | null {
  return readBests()[game] ?? null
}

/** remember the best locally regardless of the server; returns the new best */
export function rememberBest(game: GameId, score: number): number {
  const bests = readBests()
  const prev = bests[game]
  const better =
    prev === undefined || (GAME_META[game].order === 'asc' ? score < prev : score > prev)
  if (better) {
    bests[game] = score
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(bests))
    } catch {
      /* storage unavailable; the session still has the value in memory */
    }
  }
  return better ? score : (prev as number)
}

// ---------------------------------------------------------------- connection

export type ArcadeStatus = 'connecting' | 'online' | 'offline'
type DuelListener = (msg: Record<string, unknown>) => void
type Resolver<T> = { resolve: (value: T | null) => void; timer: number }

let ws: WebSocket | null = null
let ready = false // hello-ok received on the current socket
let refs = 0
let retry = 0
let reconnectTimer = 0
let idleTimer = 0
let status: ArcadeStatus = arcadeConfigured() ? 'connecting' : 'offline'
let helloSession: Pick<Session, 'token' | 'kind'> | null = null
const statusSubs = new Set<() => void>()
const duelSubs = new Set<DuelListener>()
const pendingTop = new Map<string, Resolver<ScoreBoard>[]>()
const pendingSubmit = new Map<string, Resolver<SubmitResult>[]>()
const sendQueue: object[] = []

function setStatus(next: ArcadeStatus) {
  if (status === next) return
  status = next
  statusSubs.forEach((fn) => fn())
}

function flushPending() {
  for (const list of [...pendingTop.values(), ...pendingSubmit.values()]) {
    for (const p of list) {
      clearTimeout(p.timer)
      p.resolve(null)
    }
  }
  pendingTop.clear()
  pendingSubmit.clear()
}

function takeResolver<T>(map: Map<string, Resolver<T>[]>, game: string): Resolver<T> | null {
  const list = map.get(game)
  const next = list?.shift() ?? null
  if (list && list.length === 0) map.delete(game)
  if (next) clearTimeout(next.timer)
  return next
}

function sendRaw(payload: object) {
  if (ws && ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  else sendQueue.push(payload)
}

function onMessage(ev: MessageEvent) {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(String(ev.data)) as Record<string, unknown>
  } catch {
    return
  }
  const type = String(data.type ?? '')
  if (type === 'hello-ok') {
    retry = 0
    ready = true
    setStatus('online')
    while (sendQueue.length > 0) sendRaw(sendQueue.shift() as object)
    return
  }
  if (type === 'score-top') {
    takeResolver(pendingTop, String(data.game))?.resolve({
      top: (data.top as ScoreRow[]) ?? [],
      you: (data.you as ScoreBoard['you']) ?? null,
    })
    return
  }
  if (type === 'score-ok') {
    takeResolver(pendingSubmit, String(data.game))?.resolve({
      best: Number(data.best),
      improved: Boolean(data.improved),
      rank: Number(data.rank),
    })
    return
  }
  if (type.startsWith('duel-')) {
    duelSubs.forEach((fn) => fn(data))
  }
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function connect() {
  if (!CHAT_URL || ws || refs === 0) return
  setStatus('connecting')
  let socket: WebSocket
  try {
    socket = new WebSocket(CHAT_URL)
  } catch {
    setStatus('offline')
    return
  }
  ws = socket
  ready = false
  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        type: 'hello',
        token: helloSession?.token,
        nick: helloSession?.kind === 'guest' ? (stored(NICK_KEY) ?? undefined) : undefined,
      }),
    )
  }
  socket.onmessage = onMessage
  socket.onerror = () => socket.close()
  socket.onclose = () => {
    if (ws !== socket) return
    ws = null
    ready = false
    flushPending()
    setStatus('offline')
    if (refs > 0) {
      retry += 1
      reconnectTimer = window.setTimeout(connect, Math.min(15000, 1500 * 2 ** Math.min(retry, 4)))
    }
  }
}

function acquire(session: Session) {
  refs += 1
  helloSession = { token: session.token, kind: session.kind }
  clearTimeout(idleTimer)
  clearTimeout(reconnectTimer)
  if (!ws) connect()
}

function release() {
  refs = Math.max(0, refs - 1)
  if (refs > 0) return
  clearTimeout(reconnectTimer)
  // hang up a little later, so closing one game and opening the next
  // doesn't cycle the socket
  idleTimer = window.setTimeout(() => {
    if (refs === 0) {
      ws?.close()
      ws = null
      ready = false
    }
  }, IDLE_CLOSE_MS)
}

function request<T>(
  map: Map<string, Resolver<T>[]>,
  game: string,
  payload: object,
): Promise<T | null> {
  if (!CHAT_URL) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      const list = map.get(game)
      const i = list?.findIndex((p) => p.timer === timer) ?? -1
      if (list && i >= 0) list.splice(i, 1)
      resolve(null)
    }, REQUEST_TIMEOUT_MS)
    const list = map.get(game) ?? []
    list.push({ resolve, timer })
    map.set(game, list)
    sendRaw(payload)
  })
}

// ---------------------------------------------------------------- hooks

/** hold the arcade connection open while the calling window lives */
export function useArcade() {
  const os = useOs()
  const { session } = os
  useEffect(() => {
    acquire(session)
    return release
  }, [session])
  const online = useSyncExternalStore(
    (fn) => {
      statusSubs.add(fn)
      return () => statusSubs.delete(fn)
    },
    () => status,
  )
  return { status: online, name: session.name, session }
}

/** everything a game needs to keep score: local best + the shared board */
export function useLeaderboard(game: GameId) {
  const { status, name } = useArcade()
  const [best, setBest] = useState<number | null>(() => localBest(game))
  const [board, setBoard] = useState<ScoreBoard | null>(null)
  const [rank, setRank] = useState<number | null>(null)
  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
    },
    [],
  )

  const refresh = useCallback(async () => {
    const top = await request(pendingTop, game, { type: 'score-top', game })
    if (!aliveRef.current) return
    if (top) {
      setBoard(top)
      if (top.you) {
        setRank(top.you.rank)
        setBest((prev) => {
          const order = GAME_META[game].order
          if (prev === null) return top.you!.score
          return order === 'asc' ? Math.min(prev, top.you!.score) : Math.max(prev, top.you!.score)
        })
      }
    }
  }, [game])

  const submit = useCallback(
    async (score: number) => {
      setBest(rememberBest(game, score))
      const r = await request(pendingSubmit, game, { type: 'score-submit', game, score })
      if (r && aliveRef.current) {
        setBest((prev) => (prev === null ? r.best : prev))
        setRank(r.rank)
      }
      return r
    },
    [game],
  )

  return { status, name, best, rank, board, refresh, submit }
}

// ---------------------------------------------------------------- mine duel

/** raw duel channel: subscribe to duel-* messages and send duel commands */
export function useDuelChannel(onMessage: DuelListener) {
  const { status, name, session } = useArcade()
  const cbRef = useRef(onMessage)
  useEffect(() => {
    cbRef.current = onMessage
  })
  useEffect(() => {
    const fn: DuelListener = (msg) => cbRef.current(msg)
    duelSubs.add(fn)
    return () => {
      duelSubs.delete(fn)
      // walking away from the duel window concedes cleanly
      sendRaw({ type: 'duel-leave' })
    }
  }, [])
  const send = useCallback((payload: object) => sendRaw(payload), [])
  return { status, name, session, send }
}
