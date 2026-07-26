/*
  What the other people in the world are doing, reconstructed from a snapshot
  stream that arrives about fifteen times a second. React-free and
  renderer-free like the rest of the runtime: this module owns the state, and
  `net/avatars.ts` is the only thing that turns it into meshes.

  The whole problem is that frames come four times faster than packets, so
  playback runs deliberately in the past — about two server ticks behind — and
  every frame interpolates between the two snapshots that bracket that moment.
  Being late is what buys smoothness: extrapolating instead would guess, and a
  guess that is wrong at the exact instant someone stops walking drags their
  planted feet across the ground, which is the one artefact this body rig makes
  impossible to ignore.

  Playback is timed by local arrival, never by the server's clock. The `t` on
  a snapshot is only good for ordering — a visitor's machine may be minutes off
  UTC, and a clock-sync handshake would be a lot of protocol to buy nothing
  that arrival time does not already give.

  Three things it refuses to interpolate. A jump bigger than SNAP_DIST is a
  spawn or a level seam, not a sprint, so the buffer is thrown away and the
  body is placed; a player who stops sending simply holds their last pose
  rather than sliding onward forever; and a player absent from a snapshot is
  not gone but elsewhere — they stay in the roster, drop out of the live set,
  and snap when they come back.

  Velocity is not on the wire. It is read back out of the interpolation, which
  is both free and honest: the body rig leans into exactly the motion that is
  being drawn, so the lean can never disagree with the feet. `landing` is
  synthesised the same way, from the frame the grounded bit comes back with
  downward speed behind it, because a one-frame impulse sent as sampled state
  would fall between packets more often than it survived.
*/

import { POSE, type PlayerId, type PoseTuple, type RosterEntry } from './protocol'

interface Sample {
  /** local arrival time, ms */
  at: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  gait: number
  f: number
}

export interface RemotePlayer {
  readonly id: PlayerId
  name: string
  admin: boolean
  registered: boolean
  /** the 24-hex colour pack, or undefined for the default robot */
  look?: string
  /** in the local player's level, and therefore drawn */
  here: boolean
  // --- resolved by sample(), all world space, y is the soles
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  gait: number
  vx: number
  vy: number
  vz: number
  /** 0 standing .. 1 crouched, eased locally off the crouch bit */
  crouchK: number
  grounded: boolean
  run: boolean
  swimming: boolean
  speaking: boolean
  down: boolean
  /** downward speed a touchdown absorbed this frame, else 0 */
  landing: number
  /** the body was placed rather than moved this frame: spawn, seam, teleport */
  snapped: boolean
}

export interface RemoteWorld {
  /** our own id, once the server has named us */
  readonly you: PlayerId | null
  /** everyone the server has told us about, level notwithstanding */
  readonly roster: ReadonlyMap<PlayerId, RosterEntry>
  /** everyone standing in our level right now, us excluded */
  readonly players: ReadonlyMap<PlayerId, RemotePlayer>
  welcome: (you: PlayerId, tick: number, players: RosterEntry[]) => void
  enter: (player: RosterEntry) => void
  exit: (id: PlayerId) => void
  /** somebody renamed or repainted. Returns the roster entry that changed, or
      null for an id we have never heard of — `net/avatars.ts` needs to know
      whether there is a plate to repaint, and the caller needs to know
      whether the change was worth a line in the chat rail */
  identify: (id: PlayerId, change: { name?: string; look?: string }) => RosterEntry | null
  /** a snapshot landed; `now` is local time, not the server's */
  tick: (players: PoseTuple[], now: number) => void
  /** advance playback to this instant; call once per frame before drawing */
  sample: (now: number, dt: number) => void
  /** the socket dropped: forget everyone, keep nothing stale on screen */
  clear: () => void
}

/** playback lag, as a multiple of the server's snapshot period. Two ticks
    covers one dropped packet without the buffer running dry */
const DELAY_TICKS = 2
const DEFAULT_TICK_MS = 66
/** how far back the buffer is kept — enough to bracket the delay twice over */
const KEEP_MS = 600
/** a step this big in one snapshot is a teleport, not a sprint. The fastest
    thing a player can do is a sprint at ~14 u/s, i.e. ~1 unit per tick */
const SNAP_DIST = 20

const TAU = Math.PI * 2

/** shortest way round the circle, so a walker crossing north does not spin */
function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  else if (d < -Math.PI) d += TAU
  return a + d * k
}

function makePlayer(entry: RosterEntry): RemotePlayer {
  return {
    id: entry.id,
    name: entry.name,
    admin: entry.admin,
    registered: entry.registered,
    look: entry.look,
    here: false,
    x: 0, y: 0, z: 0,
    yaw: 0, pitch: 0, gait: 0,
    vx: 0, vy: 0, vz: 0,
    crouchK: 0,
    grounded: true,
    run: false,
    swimming: false,
    speaking: false,
    down: false,
    landing: 0,
    snapped: true,
  }
}

export function createRemoteWorld(): RemoteWorld {
  let you: PlayerId | null = null
  let tickMs = DEFAULT_TICK_MS
  const roster = new Map<PlayerId, RosterEntry>()
  const players = new Map<PlayerId, RemotePlayer>()
  const buffers = new Map<PlayerId, Sample[]>()
  // reused across ticks; the snapshot loop must not feed the GC
  const seen = new Set<PlayerId>()

  const forget = (id: PlayerId) => {
    players.delete(id)
    buffers.delete(id)
  }

  return {
    get you() {
      return you
    },
    get roster() {
      return roster
    },
    get players() {
      return players
    },

    welcome(id, tick, list) {
      you = id
      tickMs = tick > 0 ? tick : DEFAULT_TICK_MS
      roster.clear()
      players.clear()
      buffers.clear()
      for (const entry of list) roster.set(entry.id, entry)
    },

    enter(entry) {
      roster.set(entry.id, entry)
    },

    exit(id) {
      roster.delete(id)
      forget(id)
    },

    identify(id, change) {
      const entry = roster.get(id)
      if (!entry) return null
      if (change.name !== undefined) entry.name = change.name
      // an absent look is a real value here — "back to the default robot" —
      // so the key's presence decides, not its truthiness
      if ('look' in change) entry.look = change.look
      // the live player mirrors the roster; tick() copies these across every
      // snapshot anyway, but somebody standing still might not be in one for
      // a second and their plate should not wait for them to move
      const player = players.get(id)
      if (player) {
        player.name = entry.name
        player.look = entry.look
      }
      return entry
    },

    tick(list, now) {
      seen.clear()
      for (const [id, x, y, z, yaw, pitch, gait, f] of list) {
        if (id === you) continue
        seen.add(id)
        const entry = roster.get(id)
        // a snapshot can beat its own world-enter through the socket; the
        // roster fills in the name a moment later
        if (!entry) continue
        let player = players.get(id)
        if (!player) {
          player = makePlayer(entry)
          players.set(id, player)
          buffers.set(id, [])
        }
        player.name = entry.name
        player.admin = entry.admin
        player.registered = entry.registered
        player.look = entry.look
        const buf = buffers.get(id)!
        const last = buf[buf.length - 1]
        const jumped =
          last !== undefined &&
          Math.abs(x - last.x) + Math.abs(y - last.y) + Math.abs(z - last.z) > SNAP_DIST
        if (jumped) buf.length = 0
        buf.push({ at: now, x, y, z, yaw, pitch, gait, f })
        while (buf.length > 2 && now - buf[0].at > KEEP_MS) buf.shift()
      }
      // absent from a snapshot means "in another level", which is a departure
      // as far as anything drawn is concerned
      for (const id of players.keys()) {
        if (!seen.has(id)) forget(id)
      }
    },

    sample(now, dt) {
      const target = now - tickMs * DELAY_TICKS
      const ease = 1 - Math.exp(-10 * dt)
      for (const [id, player] of players) {
        const buf = buffers.get(id)
        if (!buf || buf.length === 0) continue

        // find the pair bracketing the playback instant; past the end of the
        // buffer we hold the newest sample rather than guessing onward
        let a = buf[0]
        let b = buf[0]
        for (let i = buf.length - 1; i >= 0; i--) {
          if (buf[i].at <= target) {
            a = buf[i]
            b = buf[i + 1] ?? buf[i]
            break
          }
          if (i === 0) {
            a = buf[0]
            b = buf[0]
          }
        }
        const span = b.at - a.at
        const k = span > 0 ? Math.min(1, Math.max(0, (target - a.at) / span)) : 0

        const wasHere = player.here
        player.here = true
        player.x = a.x + (b.x - a.x) * k
        player.y = a.y + (b.y - a.y) * k
        player.z = a.z + (b.z - a.z) * k
        player.yaw = lerpAngle(a.yaw, b.yaw, k)
        player.pitch = a.pitch + (b.pitch - a.pitch) * k
        player.gait = a.gait + (b.gait - a.gait) * k

        // velocity read back out of the same interpolation the body is drawn
        // from, so the lean can never disagree with the feet
        if (span > 0) {
          const inv = 1000 / span
          player.vx = (b.x - a.x) * inv
          player.vy = (b.y - a.y) * inv
          player.vz = (b.z - a.z) * inv
        } else {
          player.vx = player.vy = player.vz = 0
        }

        const f = b.f
        const wasGrounded = player.grounded
        player.grounded = (f & POSE.grounded) !== 0
        player.run = (f & POSE.run) !== 0
        player.swimming = (f & POSE.swimming) !== 0
        player.speaking = (f & POSE.speaking) !== 0
        player.down = (f & POSE.down) !== 0
        player.landing = !wasGrounded && player.grounded ? Math.max(0, -player.vy) : 0

        const crouchTo = (f & POSE.crouch) !== 0 ? 1 : 0
        player.crouchK = wasHere
          ? player.crouchK + (crouchTo - player.crouchK) * ease
          : crouchTo

        // first frame in view, or the buffer was thrown away by a teleport
        player.snapped = !wasHere || buf.length === 1
      }
    },

    clear() {
      you = null
      roster.clear()
      players.clear()
      buffers.clear()
    },
  }
}
