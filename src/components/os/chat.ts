import { useCallback, useEffect, useRef, useState } from 'react'

/*
  WebSocket client for the Messenger app. Talks to the self-hosted chat
  server (server/ in this repo) running on the VPS; VITE_CHAT_URL points at
  its /ws endpoint at build time. One hook serves both roles: visitors chat
  with Alejandro, and Alejandro himself unlocks admin mode (/admin <token>)
  to read and reply from the same window. No URL configured or server down
  degrades to 'unavailable' and the app falls back to plain email.
*/

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined

const ID_KEY = 'alejos-msgr-id'
const NAME_KEY = 'alejos-msgr-name'
const ADMIN_KEY = 'alejos-msgr-admin'

export type Role = 'visitor' | 'admin'
export type ChatStatus = 'connecting' | 'online' | 'away' | 'unavailable'

export interface ChatMessage {
  id: number | string
  sender: 'visitor' | 'admin'
  text: string
  at: number
  pending?: boolean
}

export interface Convo {
  id: string
  name: string
  lastText: string
  lastAt: number
  count: number
}

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

function visitorId(): string {
  let id = stored(ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    store(ID_KEY, id)
  }
  return id
}

export function chatEnabled(): boolean {
  return Boolean(CHAT_URL)
}

export function useChat(onIncoming?: () => void) {
  const [role, setRole] = useState<Role>(() => (stored(ADMIN_KEY) ? 'admin' : 'visitor'))
  const [status, setStatus] = useState<ChatStatus>(CHAT_URL ? 'connecting' : 'unavailable')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [convos, setConvos] = useState<Convo[]>([])
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [activeConvo, setActiveConvo] = useState<string | null>(null)
  const [adminMessages, setAdminMessages] = useState<ChatMessage[]>([])
  const [peerTyping, setPeerTyping] = useState(false)
  const [name, setNameState] = useState(() => stored(NAME_KEY) ?? '')

  const wsRef = useRef<WebSocket | null>(null)
  const tmpRef = useRef(1)
  const activeRef = useRef<string | null>(null)
  const typingResetRef = useRef(0)
  const lastTypingSentRef = useRef(0)
  const incomingRef = useRef(onIncoming)
  useEffect(() => {
    incomingRef.current = onIncoming
  })

  const sendRaw = useCallback((payload: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }, [])

  const markPeerTyping = useCallback(() => {
    setPeerTyping(true)
    clearTimeout(typingResetRef.current)
    typingResetRef.current = window.setTimeout(() => setPeerTyping(false), 3000)
  }, [])

  useEffect(() => {
    if (!CHAT_URL) return
    let disposed = false
    let retry = 0
    let reconnectTimer = 0

    const connect = () => {
      setStatus('connecting')
      let ws: WebSocket
      try {
        ws = new WebSocket(CHAT_URL)
      } catch {
        setStatus('unavailable')
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        if (role === 'admin') {
          sendRaw({ type: 'hello', role: 'admin', token: stored(ADMIN_KEY) })
        } else {
          sendRaw({ type: 'hello', role: 'visitor', id: visitorId(), name: stored(NAME_KEY) ?? undefined })
        }
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
            if (role === 'admin') setStatus('online')
            else {
              const presence = data.presence as { online: boolean } | undefined
              setStatus(presence?.online ? 'online' : 'away')
            }
            break
          }
          case 'presence':
            if (role === 'visitor') setStatus(data.online ? 'online' : 'away')
            break
          case 'history': {
            const list = (data.messages as ChatMessage[]) ?? []
            if (role === 'admin') {
              if (data.convo === activeRef.current) setAdminMessages(list)
            } else {
              setMessages(list)
            }
            break
          }
          case 'convos':
            setConvos((data.convos as Convo[]) ?? [])
            break
          case 'msg': {
            const message = data.message as ChatMessage
            setPeerTyping(false)
            if (role === 'admin') {
              const convoId = data.convo as string
              setConvos((prev) => {
                const rest = prev.filter((c) => c.id !== convoId)
                const found = prev.find((c) => c.id === convoId)
                const updated: Convo = {
                  id: convoId,
                  name: (data.name as string) ?? found?.name ?? '',
                  lastText: message.text,
                  lastAt: message.at,
                  count: (found?.count ?? 0) + 1,
                }
                return [updated, ...rest]
              })
              if (convoId === activeRef.current) {
                setAdminMessages((prev) =>
                  prev.some((m) => m.id === message.id) ? prev : [...prev, message],
                )
              }
              if (message.sender === 'visitor') {
                if (convoId !== activeRef.current) {
                  setUnread((prev) => ({ ...prev, [convoId]: (prev[convoId] ?? 0) + 1 }))
                }
                incomingRef.current?.()
              }
            } else {
              setMessages((prev) => [...prev, message])
              incomingRef.current?.()
            }
            break
          }
          case 'ack': {
            const tmp = data.tmp
            setMessages((prev) =>
              prev.map((m) =>
                m.pending && m.id === tmp
                  ? { ...m, id: data.id as number, at: data.at as number, pending: false }
                  : m,
              ),
            )
            break
          }
          case 'typing':
            if (role === 'admin') {
              if (data.convo === activeRef.current) markPeerTyping()
            } else {
              markPeerTyping()
            }
            break
          case 'error':
            if (data.code === 'auth') {
              store(ADMIN_KEY, null)
              setRole('visitor')
            }
            break
        }
      }

      ws.onclose = () => {
        if (disposed) return
        wsRef.current = null
        setStatus('unavailable')
        retry += 1
        reconnectTimer = window.setTimeout(connect, Math.min(15000, 1500 * 2 ** Math.min(retry, 4)))
      }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      clearTimeout(typingResetRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [role, sendRaw, markPeerTyping])

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (role === 'admin') {
        if (activeRef.current) sendRaw({ type: 'reply', to: activeRef.current, text: trimmed })
        return
      }
      const tmp = `tmp-${tmpRef.current++}`
      setMessages((prev) => [
        ...prev,
        { id: tmp, sender: 'visitor', text: trimmed, at: Date.now(), pending: true },
      ])
      sendRaw({ type: 'msg', text: trimmed, tmp })
    },
    [role, sendRaw],
  )

  const sendTyping = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingSentRef.current < 1200) return
    lastTypingSentRef.current = now
    if (role === 'admin') {
      if (activeRef.current) sendRaw({ type: 'typing', to: activeRef.current })
    } else {
      sendRaw({ type: 'typing' })
    }
  }, [role, sendRaw])

  const setName = useCallback(
    (value: string) => {
      const clean = value.trim().slice(0, 40)
      setNameState(clean)
      store(NAME_KEY, clean || null)
      if (clean) sendRaw({ type: 'name', name: clean })
    },
    [sendRaw],
  )

  const openConvo = useCallback(
    (id: string) => {
      activeRef.current = id
      setActiveConvo(id)
      setAdminMessages([])
      setPeerTyping(false)
      setUnread((prev) => ({ ...prev, [id]: 0 }))
      sendRaw({ type: 'open', id })
    },
    [sendRaw],
  )

  const loginAdmin = useCallback((token: string) => {
    store(ADMIN_KEY, token.trim())
    activeRef.current = null
    setActiveConvo(null)
    setAdminMessages([])
    setRole('admin')
  }, [])

  const logoutAdmin = useCallback(() => {
    store(ADMIN_KEY, null)
    activeRef.current = null
    setActiveConvo(null)
    setAdminMessages([])
    setConvos([])
    setRole('visitor')
  }, [])

  return {
    enabled: chatEnabled(),
    role,
    status,
    messages,
    convos,
    unread,
    activeConvo,
    adminMessages,
    peerTyping,
    name,
    send,
    sendTyping,
    setName,
    openConvo,
    loginAdmin,
    logoutAdmin,
  }
}
