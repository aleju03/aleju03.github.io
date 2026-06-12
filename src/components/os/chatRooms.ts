import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from './osContext'

/*
  Client for the AlejOS chat server v2 (server/ in this repo): registered
  users and public rooms instead of the old 1:1 messenger. Two entry points:

  - authRequest(): one-shot register/login over a short-lived socket, used
    by the boot login screen. Resolves with a token the server minted.
  - useRoomChat(): the live connection for the Chat Rooms app — join a room,
    stream messages, watch who is online and who is typing.

  No VITE_CHAT_URL at build time (or a dead server) degrades gracefully:
  login still offers Guest, and the chat app explains itself.
*/

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined

const NICK_KEY = 'alejos-nick'

export function chatEnabled(): boolean {
  return Boolean(CHAT_URL)
}

export interface RoomMessage {
  id: number | string
  from: string
  admin: boolean
  registered: boolean
  text: string
  at: number
  pending?: boolean
}

export interface RoomUser {
  name: string
  admin: boolean
  registered: boolean
}

export interface RoomInfo {
  id: string
  users: number
}

export type RoomStatus = 'connecting' | 'online' | 'offline'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------- auth

export type AuthResult =
  | { ok: true; token: string; name: string; admin: boolean }
  | { ok: false; error: string }

export function authRequest(
  kind: 'login' | 'register',
  username: string,
  password: string,
): Promise<AuthResult> {
  return new Promise((resolve) => {
    if (!CHAT_URL) {
      resolve({ ok: false, error: 'No account server is configured on this build.' })
      return
    }
    let settled = false
    const done = (result: AuthResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* already closed */
      }
      resolve(result)
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(CHAT_URL)
    } catch {
      resolve({ ok: false, error: 'Could not reach the account server.' })
      return
    }
    const timer = window.setTimeout(
      () => done({ ok: false, error: 'The account server timed out. Try again or enter as guest.' }),
      8000,
    )
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello' }))
      ws.send(JSON.stringify({ type: kind, username, password }))
    }
    ws.onmessage = (ev) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (data.type === 'auth-ok') {
        const user = data.user as { name: string; admin: boolean }
        done({ ok: true, token: String(data.token), name: user.name, admin: user.admin })
      } else if (data.type === 'error' && data.code !== 'bad_request') {
        done({
          ok: false,
          error: String(data.message ?? (data.code === 'rate' ? 'Too many attempts. Wait a bit.' : 'That did not work.')),
        })
      }
    }
    ws.onerror = () => done({ ok: false, error: 'Could not reach the account server.' })
    ws.onclose = () => done({ ok: false, error: 'Connection closed before the server answered.' })
  })
}

// ---------------------------------------------------------------- room chat

export function useRoomChat(session: Session, onIncoming?: () => void) {
  const [status, setStatus] = useState<RoomStatus>(CHAT_URL ? 'connecting' : 'offline')
  const [rooms, setRooms] = useState<RoomInfo[]>([])
  const [room, setRoom] = useState('general')
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [users, setUsers] = useState<RoomUser[]>([])
  const [typing, setTyping] = useState<string[]>([])
  const [me, setMe] = useState(session.name)
  const [notice, setNotice] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const roomRef = useRef(room)
  const meRef = useRef(me)
  const tmpRef = useRef(1)
  const typingTimersRef = useRef(new Map<string, number>())
  const lastTypingSentRef = useRef(0)
  const incomingRef = useRef(onIncoming)
  useEffect(() => {
    incomingRef.current = onIncoming
  })
  useEffect(() => {
    meRef.current = me
  }, [me])

  const sendRaw = useCallback((payload: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }, [])

  const markTyping = useCallback((from: string) => {
    if (from === meRef.current) return
    setTyping((prev) => (prev.includes(from) ? prev : [...prev, from]))
    const timers = typingTimersRef.current
    clearTimeout(timers.get(from))
    timers.set(
      from,
      window.setTimeout(() => {
        setTyping((prev) => prev.filter((n) => n !== from))
        timers.delete(from)
      }, 3000),
    )
  }, [])

  useEffect(() => {
    if (!CHAT_URL) return
    let disposed = false
    let retry = 0
    let reconnectTimer = 0
    const timers = typingTimersRef.current

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

      ws.onopen = () => {
        sendRaw({
          type: 'hello',
          token: session.token,
          nick: session.kind === 'guest' ? stored(NICK_KEY) ?? undefined : undefined,
        })
      }

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
            setStatus('online')
            setMe(String(data.you ?? session.name))
            setRooms((data.rooms as RoomInfo[]) ?? [])
            if (data.badToken) setNotice('Your saved login expired. Chatting as guest.')
            sendRaw({ type: 'join', room: roomRef.current })
            break
          }
          case 'rooms':
            setRooms((data.rooms as RoomInfo[]) ?? [])
            break
          case 'history':
            if (data.room === roomRef.current) {
              setMessages((data.messages as RoomMessage[]) ?? [])
              setTyping([])
            }
            break
          case 'users':
            if (data.room === roomRef.current) setUsers((data.users as RoomUser[]) ?? [])
            break
          case 'msg': {
            if (data.room !== roomRef.current) break
            const message = data.message as RoomMessage
            setTyping((prev) => prev.filter((n) => n !== message.from))
            setMessages((prev) =>
              prev.some((m) => m.id === message.id) ? prev : [...prev, message],
            )
            if (message.from !== meRef.current) incomingRef.current?.()
            break
          }
          case 'ack':
            setMessages((prev) =>
              prev.map((m) =>
                m.pending && m.id === data.tmp
                  ? { ...m, id: data.id as number, at: data.at as number, pending: false }
                  : m,
              ),
            )
            break
          case 'typing':
            if (data.room === roomRef.current) markTyping(String(data.from))
            break
          case 'nick-ok':
            setMe(String(data.name))
            store(NICK_KEY, String(data.name))
            setNotice('')
            break
          case 'error':
            if (data.code === 'rate') setNotice('Slow down a little.')
            else if (data.message) setNotice(String(data.message))
            break
        }
      }

      ws.onclose = () => {
        if (disposed) return
        wsRef.current = null
        setStatus('offline')
        setUsers([])
        retry += 1
        reconnectTimer = window.setTimeout(connect, Math.min(15000, 1500 * 2 ** Math.min(retry, 4)))
      }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      timers.forEach((t) => clearTimeout(t))
      timers.clear()
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [session.token, session.kind, session.name, sendRaw, markTyping])

  const joinRoom = useCallback(
    (id: string) => {
      if (id === roomRef.current) return
      roomRef.current = id
      setRoom(id)
      setMessages([])
      setUsers([])
      setTyping([])
      sendRaw({ type: 'join', room: id })
    },
    [sendRaw],
  )

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const tmp = `tmp-${tmpRef.current++}`
      setMessages((prev) => [
        ...prev,
        {
          id: tmp,
          from: meRef.current,
          admin: Boolean(session.admin),
          registered: session.kind === 'user',
          text: trimmed,
          at: Date.now(),
          pending: true,
        },
      ])
      sendRaw({ type: 'msg', room: roomRef.current, text: trimmed, tmp })
    },
    [sendRaw, session.kind, session.admin],
  )

  const sendTyping = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingSentRef.current < 1200) return
    lastTypingSentRef.current = now
    sendRaw({ type: 'typing', room: roomRef.current })
  }, [sendRaw])

  const setNick = useCallback(
    (name: string) => {
      const clean = name.trim().slice(0, 24)
      if (clean) sendRaw({ type: 'nick', name: clean })
    },
    [sendRaw],
  )

  return {
    enabled: chatEnabled(),
    status,
    rooms,
    room,
    messages,
    users,
    typing,
    me,
    notice,
    clearNotice: () => setNotice(''),
    joinRoom,
    send,
    sendTyping,
    setNick,
  }
}
