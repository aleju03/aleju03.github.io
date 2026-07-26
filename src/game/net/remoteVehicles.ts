/*
  The fleet, shared. Where `remotePlayers.ts` reconstructs the other people,
  this reconstructs the other people's machines — and the two are deliberately
  the same instrument, because the artefact they exist to avoid is the same
  one. Playback runs about two server ticks in the past and interpolates
  between the snapshots that bracket that instant; extrapolating instead would
  guess, and a guess that is wrong the moment a car stops is a car that slides
  a metre past the kerb and comes back.

  What is different is that a vehicle has an owner. Every machine is in one of
  three states on any given client:

  - **mine** — I am holding its wheel. My own physics runs it, its transform
    goes on the wire, and the rows that come back are ignored (they are my own
    voice, two ticks stale).
  - **theirs** — somebody else is driving. My physics must not touch it: the
    integrator would fight the network for the same six numbers and lose in a
    visible way. It is placed where the rows say and animated off the motion
    they imply.
  - **nobody's** — parked. There is nothing to interpolate, so each client
    settles it on its own springs from wherever it was last seen. That is not
    a fudge: a parked machine is not moving, and two clients agreeing to
    within a spring's worth of pitch on a slope is agreement.

  The handoff between the last two is the interesting edge, and it belongs to
  the registry rather than here — this module only says *who* owns what.

  Seats are not interpolated, buffered or timed. They are six small integers
  that the server resends in full on every change, and the last table to
  arrive is the truth.
*/

import {
  SEAT_DRIVER,
  SEAT_PASSENGER,
  WIRE_VEHICLES,
  type PlayerId,
  type SeatTuple,
  type VehicleTuple,
  type WireVehicle,
} from './protocol'

/** playback lag and buffer depth: the same numbers, for the same reason, as
    the ones in remotePlayers.ts. A vehicle and its driver's body have to be
    late by exactly the same amount or the driver rides beside their car */
const DELAY_TICKS = 2
const DEFAULT_TICK_MS = 66
const KEEP_MS = 600
/** a jump this big in one snapshot is a recall or a fresh join, not driving.
    The helicopter tops out near 75 u/s, i.e. five units in a tick */
const SNAP_DIST = 60

const TAU = Math.PI * 2

interface Sample {
  at: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
}

export interface RemoteVehicle {
  readonly id: WireVehicle
  /** true once the server has ever told us anything about this machine */
  known: boolean
  /** who is in it; 0 is an empty chair */
  driver: PlayerId | 0
  passenger: PlayerId | 0
  /** somebody else has the wheel: the local sim must keep its hands off */
  netDriven: boolean
  // --- resolved by sample(), world space
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  /** read back out of the interpolation, like RemotePlayer's — the wheels and
      the wake are animated from the motion actually being drawn */
  vx: number
  vy: number
  vz: number
  /** placed rather than moved this frame: a join, a recall, a teleport */
  snapped: boolean
}

export interface RemoteFleet {
  readonly vehicles: readonly RemoteVehicle[]
  /** our own id, so "driven by someone else" can be told from "driven by me" */
  setSelf: (you: PlayerId | null) => void
  /** the whole seat table, as the server last sent it */
  seats: (list: SeatTuple[]) => void
  /** a snapshot landed; `now` is local time, never the server's */
  tick: (list: VehicleTuple[], now: number) => void
  /** the initial catch-up in world-welcome: place, do not interpolate */
  place: (list: VehicleTuple[]) => void
  /** advance playback to this instant; once a frame, before drawing */
  sample: (now: number) => void
  /** which chair this player is in, or null. Used to seat their avatar */
  seatOf: (id: PlayerId) => { vehicle: WireVehicle; index: number; seat: number } | null
  /** the machine and chair we ourselves hold, or null */
  readonly mine: { vehicle: WireVehicle; index: number; seat: number } | null
  /** the socket dropped: forget it all rather than driving ghosts around */
  clear: () => void
  /** playback delay, so the caller can keep the tick period in one place */
  setTick: (ms: number) => void
}

/** shortest way round the circle — a machine crossing north must not spin */
function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  else if (d < -Math.PI) d += TAU
  return a + d * k
}

function makeVehicle(id: WireVehicle): RemoteVehicle {
  return {
    id,
    known: false,
    driver: 0,
    passenger: 0,
    netDriven: false,
    x: 0, y: 0, z: 0,
    yaw: 0, pitch: 0, roll: 0,
    vx: 0, vy: 0, vz: 0,
    snapped: true,
  }
}

export function createRemoteFleet(): RemoteFleet {
  let you: PlayerId | null = null
  let tickMs = DEFAULT_TICK_MS
  const vehicles = WIRE_VEHICLES.map(makeVehicle)
  const buffers: Sample[][] = WIRE_VEHICLES.map(() => [])

  const syncOwners = () => {
    for (const v of vehicles) v.netDriven = v.driver !== 0 && v.driver !== you
  }

  /** drop a machine's history. Called when it changes hands, because the
      samples either side of the handoff describe two different régimes and
      interpolating across the seam drags the machine between them */
  const forget = (i: number) => {
    buffers[i].length = 0
    vehicles[i].vx = vehicles[i].vy = vehicles[i].vz = 0
    vehicles[i].snapped = true
  }

  const put = (i: number, t: VehicleTuple) => {
    const v = vehicles[i]
    v.known = true
    v.x = t[1]
    v.y = t[2]
    v.z = t[3]
    v.yaw = t[4]
    v.pitch = t[5]
    v.roll = t[6]
    v.vx = v.vy = v.vz = 0
    v.snapped = true
  }

  return {
    get vehicles() {
      return vehicles
    },

    get mine() {
      if (you === null) return null
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i]
        if (v.driver === you) return { vehicle: v.id, index: i, seat: SEAT_DRIVER }
        if (v.passenger === you) return { vehicle: v.id, index: i, seat: SEAT_PASSENGER }
      }
      return null
    },

    setSelf(id) {
      you = id
      syncOwners()
    },

    setTick(ms) {
      tickMs = ms > 0 ? ms : DEFAULT_TICK_MS
    },

    seats(list) {
      for (const [vid, driver, passenger] of list) {
        const v = vehicles[vid]
        if (!v) continue
        const handover = v.driver !== driver
        v.driver = driver
        v.passenger = passenger
        if (handover) forget(vid)
      }
      syncOwners()
    },

    tick(list, now) {
      for (const t of list) {
        const i = t[0]
        const v = vehicles[i]
        if (!v) continue
        v.known = true
        // our own machine's rows are our own voice coming back two ticks
        // late, and a parked one is settled by local physics; neither is
        // something to play back
        if (!v.netDriven) continue
        const buf = buffers[i]
        const last = buf[buf.length - 1]
        const jumped =
          last !== undefined &&
          Math.abs(t[1] - last.x) + Math.abs(t[2] - last.y) + Math.abs(t[3] - last.z) > SNAP_DIST
        if (jumped) buf.length = 0
        buf.push({ at: now, x: t[1], y: t[2], z: t[3], yaw: t[4], pitch: t[5], roll: t[6] })
        while (buf.length > 2 && now - buf[0].at > KEEP_MS) buf.shift()
      }
    },

    place(list) {
      for (const t of list) {
        if (vehicles[t[0]]) put(t[0], t)
      }
    },

    sample(now) {
      const target = now - tickMs * DELAY_TICKS
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i]
        if (!v.netDriven) continue
        const buf = buffers[i]
        if (buf.length === 0) continue

        // the pair bracketing the playback instant; past the newest sample we
        // hold it rather than guessing the machine onward into a hedge
        let a = buf[0]
        let b = buf[0]
        for (let j = buf.length - 1; j >= 0; j--) {
          if (buf[j].at <= target) {
            a = buf[j]
            b = buf[j + 1] ?? buf[j]
            break
          }
          if (j === 0) {
            a = buf[0]
            b = buf[0]
          }
        }
        const span = b.at - a.at
        const k = span > 0 ? Math.min(1, Math.max(0, (target - a.at) / span)) : 0

        v.x = a.x + (b.x - a.x) * k
        v.y = a.y + (b.y - a.y) * k
        v.z = a.z + (b.z - a.z) * k
        v.yaw = lerpAngle(a.yaw, b.yaw, k)
        v.pitch = lerpAngle(a.pitch, b.pitch, k)
        v.roll = lerpAngle(a.roll, b.roll, k)
        if (span > 0) {
          const inv = 1000 / span
          v.vx = (b.x - a.x) * inv
          v.vy = (b.y - a.y) * inv
          v.vz = (b.z - a.z) * inv
        } else {
          v.vx = v.vy = v.vz = 0
        }
        v.snapped = buf.length === 1
      }
    },

    seatOf(id) {
      if (!id) return null
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i]
        if (v.driver === id) return { vehicle: v.id, index: i, seat: SEAT_DRIVER }
        if (v.passenger === id) return { vehicle: v.id, index: i, seat: SEAT_PASSENGER }
      }
      return null
    },

    clear() {
      you = null
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i]
        v.known = false
        v.driver = 0
        v.passenger = 0
        v.netDriven = false
        forget(i)
      }
    },
  }
}
