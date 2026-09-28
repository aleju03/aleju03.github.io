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

  The fleet and sandbox are stateful exceptions: machines and props remain
  where players leave them. The server arbitrates seats and prop claims,
  while one client simulates each machine or connected contraption. Prop
  records and compact movement batches live in propProtocol.ts; the same
  server and frontend release must understand both halves of the wire.
  What players break is the third: the planet itself still never travels,
  but the ids of the buildings' lost pieces and of the felled trees do,
  kept by the server as a union per level (damageProtocol.ts).
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
  /** noclip: floating, no ground under the pose. Without it a flyer reads
      as someone frozen at the top of a jump */
  fly: 64,
  /** hanging off somebody's physgun (net/grab.ts). While it is set the
      position is the ragdoll's chest, and everyone else's copy of the body
      is pulled along it instead of tumbling on its own */
  held: 128,
} as const

/** [id, x, y, z, yaw, pitch, gait, poseBits, emote?, pointYaw?, pointPitch?]
    y is the soles, not the eye.

    The tail is optional and only as long as it has to be: an emote rides as
    one integer (`player/emotes.ts`'s `packEmote`: the id and how long it has
    been playing, so a late arrival sees the same beat), present when either
    an emote is playing or the player is pointing; the point is a world
    direction from the right shoulder, present only while pointing. A tuple
    of eight is somebody doing neither, which is also everything an older
    server sends */
export type PoseTuple = [
  PlayerId,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number?,
  number?,
  number?,
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
export const WIRE_VEHICLES = ['car', 'boat', 'heli', 'ship'] as const
export type WireVehicle = (typeof WIRE_VEHICLES)[number]

/** the chair with the controls, and the one without */
export const SEAT_DRIVER = 0
export const SEAT_PASSENGER = 1
export const SEAT_COUNT = 2

/** [vid, x, y, z, yaw, pitch, roll] — the machine's own frame, not its
    driver's. Pitch and roll travel because a car leaning into a corner and a
    banking helicopter are most of what a vehicle looks like from outside */
export type VehicleTuple = [number, number, number, number, number, number, number]

/** [vid, driverId, passengerId, handId]; 0 is an empty chair (or empty
    hands), since ids start at 1. The hand is whoever has an *empty* machine
    on their physgun, or is letting one settle after it: its authority, the
    way a driver is, and the server keeps the two apart. The whole table is
    resent on any change: it is a dozen numbers, and a per-seat delta would
    be more protocol than the thing it describes */
export type SeatTuple = [number, PlayerId, PlayerId, PlayerId]

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

/** the physgun claim on a machine lost: somebody is sitting in it, or
    somebody else already has it */
export interface WorldHoldDenied {
  type: 'world-hold-denied'
  v: number
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

/** somebody bumped into us hard enough to matter. The velocity is theirs
    to propose and ours to apply: `net/shove.ts`'s taker decides whether it
    is a stumble, a flop or nothing (seated, flying, just knocked down). The
    server only forwards it when the two are standing near each other */
export interface WorldShove {
  type: 'world-shove'
  from: PlayerId
  vx: number
  vy: number
  vz: number
}

/** somebody has us on the end of a physgun. `hold` streams at about the
    snapshot rate with where the grabbed limb should be; `freeze` pins it
    there; `release` lets go with the throw's velocity. Ours to apply, and
    `net/grab.ts`'s taker caps it and times it out */
export type GrabPhase = 'hold' | 'freeze' | 'release'
export interface WorldGrab {
  type: 'world-grab'
  from: PlayerId
  phase: GrabPhase
  limb: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

/** the admin brought us to them: where to stand, already spaced off them
    and anybody else brought in the same breath. Our own client moves us,
    the same honesty as a shove */
export interface WorldBring {
  type: 'world-bring'
  from: PlayerId
  x: number
  y: number
  z: number
}

export type WorldServerMessage =
  | import('./effectProtocol').EffectServerMessage
  | import('./propProtocol').PropServerMessage
  | import('./damageProtocol').DamageServerMessage
  | import('./weaponProtocol').WeaponServerMessage
  | WorldShove
  | WorldBring
  | WorldGrab
  | WorldWelcome
  | WorldEnter
  | WorldExit
  | WorldTick
  | WorldChat
  | WorldSignal
  | WorldSeats
  | WorldSeatDenied
  | WorldHoldDenied
  | WorldName
  | WorldLook

// ---------------------------------------------------------------- client -> server

/** the WebRTC handshake, relayed verbatim. The server never looks inside */
export type VoiceSignal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

export type WorldClientMessage =
  | import('./effectProtocol').EffectClientMessage
  | import('./propProtocol').PropClientMessage
  | import('./damageProtocol').DamageClientMessage
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
      /** the emote playing, packed (see PoseTuple); omitted is none */
      e?: number
      /** where the right arm points, a world yaw and pitch; both omitted
          when it is not pointing */
      py?: number
      pp?: number
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
  /** take an empty machine on my physgun, or let it go. Answered by a
      world-seats naming me as its hand, or a world-hold-denied */
  | { type: 'world-hold'; v: number; on: boolean }
  /** where the machine I am driving now is. Ignored from anyone who is not
      its driver, which is the whole of the server's opinion about physics */
  /** I bumped into this player: here is the velocity it should take.
      Relayed to them alone, clamped, rate-limited, and dropped unless the
      two of us are within WORLD_SHOVE_REACH of each other and on foot */
  | { type: 'world-shove'; to: PlayerId; vx: number; vy: number; vz: number }
  /** admin only: bring this player (or everyone on my level) to me */
  | { type: 'world-bring'; to: PlayerId | 'all' }
  /** my physgun has this player by `limb`: see WorldGrab. Relayed to them
      alone while the two of us are within the beam's reach and they are on
      foot; a release is always relayed, and its velocity is clamped */
  | {
      type: 'world-grab'
      to: PlayerId
      phase: GrabPhase
      limb: number
      x: number
      y: number
      z: number
      vx: number
      vy: number
      vz: number
    }
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
  fly?: boolean
  held?: boolean
}): number {
  return (
    (o.grounded ? POSE.grounded : 0) |
    (o.run ? POSE.run : 0) |
    (o.crouch ? POSE.crouch : 0) |
    (o.swimming ? POSE.swimming : 0) |
    (o.speaking ? POSE.speaking : 0) |
    (o.down ? POSE.down : 0) |
    (o.fly ? POSE.fly : 0) |
    (o.held ? POSE.held : 0)
  )
}
