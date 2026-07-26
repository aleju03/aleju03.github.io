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

  The fleet is the one exception to "nothing about the planet travels", and it
  is not an exception at all: a car is not the planet. Where a chunk is a pure
  function of its coordinates, a machine is where somebody left it, so the
  three transforms and the six seats are the only world state this server has
  ever held. The shape follows the same rule as everything else here — the
  driver's client owns the physics and its transform is relayed; the server
  arbitrates *who* is driving and nothing else. It is the referee for the one
  question two clients cannot answer between themselves.
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
  /** how this player painted their robot: the 24-hex pack from
      `player/look.ts`. Absent from anyone who never opened the panel and from
      any older client, and absence means the default body — a look is never a
      reason for a body not to be drawn */
  look?: string
}

// ---------------------------------------------------------------- the fleet

/** the fleet in wire order. The *index* travels, not the name: three machines
    do not need their spelling repeated fifteen times a second, and the server
    (which knows nothing about what a helicopter is) only has to bounds-check
    a small integer. Mirrored by W_FLEET in server/src/index.js */
export const WIRE_VEHICLES = ['car', 'boat', 'heli'] as const
export type WireVehicle = (typeof WIRE_VEHICLES)[number]

/** the chair with the controls, and the one without */
export const SEAT_DRIVER = 0
export const SEAT_PASSENGER = 1
export const SEAT_COUNT = 2

/** [vid, x, y, z, yaw, pitch, roll] — the machine's own frame, not its
    driver's. Pitch and roll travel because a car leaning into a corner and a
    banking helicopter are most of what a vehicle looks like from outside */
export type VehicleTuple = [number, number, number, number, number, number, number]

/** [vid, driverId, passengerId]; 0 is an empty chair, since ids start at 1.
    The whole table is resent on any change — it is six numbers, and a
    per-seat delta would be more protocol than the thing it describes */
export type SeatTuple = [number, PlayerId, PlayerId]

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
  /** where the machines actually are, for a late arrival. Absent while the
      fleet is still untouched — until somebody drives one, every client's own
      spawn puts all three on the same probed home spots */
  vehicles?: VehicleTuple[]
  seats?: SeatTuple[]
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
  /** every machine the server has a transform for. A client only *applies* the
      rows of machines somebody else is driving — a parked one is settled by
      each client's own physics, and a driven one belongs to its driver */
  vehicles?: VehicleTuple[]
}

/** the seat table changed: somebody got in, got out, or dropped off the
    planet. Sent whole, and sent to everyone */
export interface WorldSeats {
  type: 'world-seats'
  seats: SeatTuple[]
}

/** the claim lost. Two people reaching for the same door is a race the server
    settles, and the loser has to be told rather than left holding a seat it
    does not have */
export interface WorldSeatDenied {
  type: 'world-seat-denied'
  v: number
  seat: number
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

/* Identity changes hands twice over, because a name and a look are the two
   halves of the same thing and they arrive by different routes. A name is
   already the chat server's business — it is the `nick` message every socket
   on this server understands — so the world does not re-own it; it only
   forwards the result to the people standing next to you. A look is nobody
   else's business, so the world owns it outright. Both are rare, both are
   sent whole, and both are relayed without the server understanding a byte
   of what they mean. */

/** somebody renamed themselves. The roster entry and the plate over their
    head both change; nothing else about them does */
export interface WorldName {
  type: 'world-name'
  id: PlayerId
  name: string
}

/** somebody repainted. `look` is a 24-hex pack, or absent for "back to the
    default robot" */
export interface WorldLook {
  type: 'world-look'
  id: PlayerId
  look?: string
}

export type WorldServerMessage =
  | WorldWelcome
  | WorldEnter
  | WorldExit
  | WorldTick
  | WorldChat
  | WorldSignal
  | WorldSeats
  | WorldSeatDenied
  | WorldName
  | WorldLook

// ---------------------------------------------------------------- client -> server

/** the WebRTC handshake, relayed verbatim. The server never looks inside */
export type VoiceSignal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

export type WorldClientMessage =
  /** `look` rides the join so a body is never drawn in the wrong colours even
      for the one tick between arriving and repainting */
  | { type: 'world-join'; level: string; look?: string }
  | { type: 'world-leave' }
  /** repainted. Answered by a world-look to everyone else and by nothing at
      all to us — the local body is already wearing it */
  | { type: 'world-look'; look: string }
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
  /** ask for a chair. Answered by a world-seats carrying your id, or by a
      world-seat-denied; the client does not sit down until one of them lands */
  | { type: 'world-seat'; v: number; seat: number }
  /** give up whichever chair I hold. Getting out, a level seam, sitting back
      down at the desk — all the same message */
  | { type: 'world-unseat' }
  /** where the machine I am driving now is. Ignored from anyone who is not
      its driver, which is the whole of the server's opinion about physics */
  | {
      type: 'world-vehicle'
      v: number
      x: number
      y: number
      z: number
      yaw: number
      pitch: number
      roll: number
    }

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
