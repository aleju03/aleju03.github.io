/*
  The multiplayer wire format, and the only file that both ends of it agree
  on by hand. The server is plain JS with no build step (server/src/index.js,
  the "open world" section), so there is no shared module to import — these
  types are the specification and that section is the implementation. The
  socket has no version negotiation, so the two ship together, exactly like
  the chat and arcade protocols beside them.

  The shape is chosen around one fact: the world is a pure function of
  coordinates on every client, so nothing about the planet ever travels. What
  travels is who is here (a roster, changing rarely), where they are (a
  snapshot at ~15Hz, the only real traffic), what they said, and the WebRTC
  handshake that lets two browsers open a voice channel without the server
  ever carrying audio.

  Snapshots are tuples rather than objects because they are the hot path: a
  full lobby is 32 of them fifteen times a second, and `{"x":12.34,...}`
  spends more bytes on its own keys than on the position. Angles keep three
  decimals (a hair under a tenth of a degree), positions two (a centimetre) —
  both far finer than the interpolation that reads them.
*/

/** the id the server hands a socket for as long as it stays in the world.
    Unique per process lifetime, not stable across reconnects */
export type PlayerId = number

/** pose bits, mirrored by the W_* constants in server/src/index.js */
export const POSE = {
  grounded: 1,
  run: 2,
  crouch: 4,
  swimming: 8,
  /** voice activity: the speaker badge over the head reads this bit, not the
      audio, so a player too far away to hear still visibly says something */
  speaking: 16,
  /** ragdolled or getting back up */
  down: 32,
} as const

/** [id, x, y, z, yaw, pitch, gait, poseBits] — y is the soles, not the eye */
export type PoseTuple = [
  PlayerId,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

export interface RosterEntry {
  id: PlayerId
  name: string
  admin: boolean
  registered: boolean
}

// ---------------------------------------------------------------- server -> client

export interface WorldWelcome {
  type: 'world-welcome'
  you: PlayerId
  /** the server's snapshot period in ms; the interpolation delay is sized
      from it rather than from a constant that could drift out of step */
  tick: number
  /** the lowest slot number free when we arrived. `net/spawn.ts` turns it
      into an offset from the level's authored spawn, so two people standing
      up at once do not stand up inside each other. Slot 0 is the spot
      itself */
  slot: number
  /** where voice should look for a path to its peers. Always carries STUN;
      carries a TURN relay with a short-lived credential only when the server
      has one configured. Absent from older servers, which is why the client
      keeps its own STUN default */
  ice?: RTCIceServer[]
  players: RosterEntry[]
}

export interface WorldEnter {
  type: 'world-enter'
  player: RosterEntry
}

export interface WorldExit {
  type: 'world-exit'
  id: PlayerId
}

/** everyone standing in the recipient's level, including the recipient. A
    player missing from this list is not gone — they are somewhere else */
export interface WorldTick {
  type: 'world-tick'
  t: number
  players: PoseTuple[]
}

export interface WorldChat {
  type: 'world-chat'
  id: PlayerId
  name: string
  admin: boolean
  registered: boolean
  text: string
  at: number
}

export interface WorldSignal {
  type: 'world-signal'
  from: PlayerId
  data: VoiceSignal
}

export type WorldServerMessage =
  | WorldWelcome
  | WorldEnter
  | WorldExit
  | WorldTick
  | WorldChat
  | WorldSignal

// ---------------------------------------------------------------- client -> server

/** the WebRTC handshake, relayed verbatim. The server never looks inside */
export type VoiceSignal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

export type WorldClientMessage =
  | { type: 'world-join'; level: string }
  | { type: 'world-leave' }
  | {
      type: 'world-move'
      x: number
      y: number
      z: number
      yaw: number
      pitch: number
      gait: number
      f: number
    }
  | { type: 'world-level'; level: string }
  | { type: 'world-chat'; text: string }
  | { type: 'world-signal'; to: PlayerId; data: VoiceSignal }

/** matches WORLD_MAX_TEXT_LEN server-side; the input box stops here so a
    long line is trimmed while it is being typed rather than rejected after */
export const WORLD_MAX_TEXT_LEN = 200

export function isWorldMessage(type: unknown): type is WorldServerMessage['type'] {
  return typeof type === 'string' && type.startsWith('world-')
}

export function packPose(o: {
  grounded: boolean
  run: boolean
  crouch: boolean
  swimming: boolean
  speaking: boolean
  down: boolean
}): number {
  return (
    (o.grounded ? POSE.grounded : 0) |
    (o.run ? POSE.run : 0) |
    (o.crouch ? POSE.crouch : 0) |
    (o.swimming ? POSE.swimming : 0) |
    (o.speaking ? POSE.speaking : 0) |
    (o.down ? POSE.down : 0)
  )
}
