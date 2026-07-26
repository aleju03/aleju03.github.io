import { sessionExpired } from './session'
import type { Session } from './osContext'
import {
  isWorldMessage,
  type PlayerId,
  type VoiceSignal,
  type WorldServerMessage,
} from '../../game/net/protocol'

/*
  The socket the 3D world's shared walk runs on — the fourth on this server,
  built to the same skeleton as arcade.ts and chatRooms.ts: one connection,
  `hello` first, exponential-backoff reconnect, and the `badToken` check that
  keeps the client from ever claiming an identity the server just refused.

  It lives out here rather than in src/game/ for the reason the runtime's
  README gives: the simulation has to keep running with no renderer and no
  browser (the eventual authoritative server is that same sim in Node), so
  anything that reaches for `import.meta.env` or a DOM WebSocket stays on this
  side of the line. What crosses back is plain data.

  Two things it owns beyond plumbing. It is the outbound throttle: the frame
  loop calls `move()` sixty times a second and this decides that fifteen of
  them are worth sending, and that a player who has not actually moved is
  worth one keepalive a second rather than fifteen identical packets. And it
  is where a reconnect is made invisible — the socket re-joins the world on
  its own, so a dropped wifi costs a few seconds of everyone else standing
  still, not a trip back to the desktop.
*/

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined

export type WorldStatus = 'offline' | 'connecting' | 'live'

export interface WorldNet {
  readonly status: WorldStatus
  /** the ICE servers the server handed over at join; the STUN/TURN set voice
      opens peers with. Empty until `world-welcome` lands */
  readonly ice: RTCIceServer[]
  /** report the local player's pose; call every frame, it throttles itself */
  move: (
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    gait: number,
    flags: number,
  ) => void
  /** the local player stepped through a level seam */
  setLevel: (level: string) => void
  chat: (text: string) => void
  signal: (to: PlayerId, data: VoiceSignal) => void
  /** ask for a chair. The answer arrives as a world-seats naming us, or a
      world-seat-denied; nobody sits down on the strength of the request */
  seat: (v: number, seat: number) => void
  /** give up whichever chair we hold */
  unseat: () => void
  /** where the machine we are driving is; throttled like `move` */
  vehicle: (
    v: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    roll: number,
  ) => void
  close: () => void
}

export interface WorldNetOpts {
  session: Session
  /** the level the player is standing in when the world is entered */
  level: string
  onStatus: (status: WorldStatus) => void
  onMessage: (msg: WorldServerMessage) => void
}

const SEND_HZ = 15
const SEND_MS = 1000 / SEND_HZ
/** a player standing perfectly still still says so this often, so a late
    joiner does not have to wait for them to move before they exist */
const IDLE_MS = 1000
/** below this nothing has visibly happened: half a centimetre and ~0.06° */
const MOVE_EPS = 0.005
const TURN_EPS = 0.001
const MAX_BACKOFF_MS = 15_000

export function worldConfigured() {
  return Boolean(CHAT_URL)
}

export function createWorldNet(opts: WorldNetOpts): WorldNet {
  let ws: WebSocket | null = null
  let status: WorldStatus = CHAT_URL ? 'connecting' : 'offline'
  let joined = false
  let closed = false
  let retry = 0
  let reconnectTimer = 0
  let level = opts.level
  let ice: RTCIceServer[] = []

  // last pose actually put on the wire, for the idle suppressor
  let lastSent = 0
  let sx = NaN
  let sy = NaN
  let sz = NaN
  let syaw = NaN
  let spitch = NaN
  let sgait = NaN
  let sflags = -1
  // and the same for the machine under us. A separate clock on purpose: the
  // drive frame reports both, and one shared throttle would drop every other
  // vehicle packet in favour of a pose that has not changed
  let lastVehicle = 0
  let vx = NaN
  let vy = NaN
  let vz = NaN
  let vyaw = NaN

  const setStatus = (next: WorldStatus) => {
    if (status === next) return
    status = next
    opts.onStatus(next)
  }

  const raw = (payload: object) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  /** anything that is only meaningful once we are actually in the world */
  const inWorld = (payload: object) => {
    if (joined) raw(payload)
  }

  const connect = () => {
    if (closed || !CHAT_URL) return
    setStatus('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(CHAT_URL)
    } catch {
      scheduleReconnect()
      return
    }
    ws = socket

    socket.onopen = () => {
      // guests offer whatever name the desktop remembers; an empty one is
      // left off entirely so the server names us rather than refusing it
      const stored =
        opts.session.kind === 'guest'
          ? (localStorage.getItem('alejos-nick') ?? opts.session.name)
          : ''
      raw({ type: 'hello', token: opts.session.token, nick: stored || undefined })
    }

    socket.onmessage = (ev) => {
      let data: { type?: string; badToken?: boolean } & Record<string, unknown>
      try {
        data = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (data.type === 'hello-ok') {
        // the rule the whole session module exists for: never keep walking
        // around under a name the server just told us it does not know
        if (data.badToken) sessionExpired()
        retry = 0
        joined = true
        // a reconnect re-enters the world by itself; the player never sees it
        raw({ type: 'world-join', level })
        // force the next move() and vehicle() through, whatever the idle
        // suppressors think: the server we are talking to may be a different
        // process than the one that heard the last one
        sflags = -1
        vx = NaN
        return
      }
      if (data.type === 'world-welcome') {
        // a TURN credential in here is short-lived, so it is re-read on every
        // reconnect rather than captured once
        const offered = (data as { ice?: RTCIceServer[] }).ice
        if (Array.isArray(offered)) ice = offered
        setStatus('live')
      }
      if (isWorldMessage(data.type)) opts.onMessage(data as unknown as WorldServerMessage)
    }

    socket.onerror = () => socket.close()

    socket.onclose = () => {
      if (ws === socket) ws = null
      joined = false
      setStatus('offline')
      scheduleReconnect()
    }
  }

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return
    const wait = Math.min(MAX_BACKOFF_MS, 1500 * 2 ** Math.min(retry, 4))
    retry += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0
      connect()
    }, wait)
  }

  if (CHAT_URL) connect()
  else queueMicrotask(() => opts.onStatus('offline'))

  return {
    get status() {
      return status
    },

    get ice() {
      return ice
    },

    move(x, y, z, yaw, pitch, gait, flags) {
      if (!joined) return
      const now = performance.now()
      if (now - lastSent < SEND_MS) return
      const still =
        Math.abs(x - sx) < MOVE_EPS &&
        Math.abs(y - sy) < MOVE_EPS &&
        Math.abs(z - sz) < MOVE_EPS &&
        Math.abs(yaw - syaw) < TURN_EPS &&
        Math.abs(pitch - spitch) < TURN_EPS &&
        Math.abs(gait - sgait) < MOVE_EPS &&
        flags === sflags
      if (still && now - lastSent < IDLE_MS) return
      lastSent = now
      sx = x
      sy = y
      sz = z
      syaw = yaw
      spitch = pitch
      sgait = gait
      sflags = flags
      raw({ type: 'world-move', x, y, z, yaw, pitch, gait, f: flags })
    },

    vehicle(v, x, y, z, yaw, pitch, roll) {
      if (!joined) return
      const now = performance.now()
      if (now - lastVehicle < SEND_MS) return
      // A parked machine with the engine running still has to say so — a late
      // arrival learns where it is from the welcome, but a machine that came
      // to rest between two of their snapshots would otherwise hold the last
      // *moving* pose on everyone else's screen
      const still =
        Math.abs(x - vx) < MOVE_EPS &&
        Math.abs(y - vy) < MOVE_EPS &&
        Math.abs(z - vz) < MOVE_EPS &&
        Math.abs(yaw - vyaw) < TURN_EPS
      if (still && now - lastVehicle < IDLE_MS) return
      lastVehicle = now
      vx = x
      vy = y
      vz = z
      vyaw = yaw
      raw({ type: 'world-vehicle', v, x, y, z, yaw, pitch, roll })
    },

    seat(v, which) {
      inWorld({ type: 'world-seat', v, seat: which })
    },

    unseat() {
      inWorld({ type: 'world-unseat' })
    },

    setLevel(next) {
      level = next
      inWorld({ type: 'world-level', level: next })
    },

    chat(text) {
      const trimmed = text.trim()
      if (trimmed) inWorld({ type: 'world-chat', text: trimmed })
    },

    signal(to, data) {
      inWorld({ type: 'world-signal', to, data })
    },

    close() {
      closed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      reconnectTimer = 0
      inWorld({ type: 'world-leave' })
      joined = false
      ws?.close()
      ws = null
      setStatus('offline')
    },
  }
}
