import type { Bump, Bumpable, BodyExtent } from '../player/bodyContact'
import { bodyExtent, posedPoints } from '../player/bodyContact'
import type { PlayerId } from './protocol'
import type { RemoteWorld } from './remotePlayers'

/*
  Bumping into other players, honestly.

  Nobody moves anybody else's body. Positions are client-authoritative (the
  server relays them and nothing more), and a remote body on this screen is
  a playback running two server ticks in the past, so if this client pushed
  it, it would be arguing with that player's own client about where they
  are, and losing a frame later. So the deal is split in two, one half on
  each machine:

  - **Here**, a remote player is a `Bumpable` that refuses every nudge: the
    contact pass (`player/bodyContact.ts`) resolves the local walker out of
    their cylinder and never the other way round. They are a wall to us
    exactly as we are a wall to them on their screen, so two people walking
    into each other stop chest to chest on both.
  - **There**, anything harder than standing still is a `world-shove`: a
    velocity addressed to them, relayed by the server (which checks the two
    are actually near each other and rate-limits it), and applied by the
    victim's own client to itself through `createShoveTaker`. A lean arrives
    as a stumble, a few units a second that their walk bleeds away, so you
    can shoulder somebody along a pavement; a charge, a tackle or a stomp
    arrives past the flop line and knocks them into the same ragdoll a car
    does. Everyone else then sees them fall through the ordinary pose bits,
    the way any flop already travels.

  The victim is the judge of its own body: it ignores shoves while seated,
  flying, in god mode or already down, and a player who has just been
  knocked flat gets a few seconds of stumbles instead of a second flop, so
  two friends cannot pin a third to the floor.

  Headless: plain numbers and a clock passed in.
*/

/** a shove's velocity past this (planar) knocks the victim over; under it
    they stumble. A lean is capped well under it (bodyContact's STAGGER_MAX),
    a charge starts well over it (CHARGE times the throw) */
export const FLOP_PLANAR = 6
/** ...and so does being pushed down this hard: the stomp's signature */
export const FLOP_DOWN = -2
/** the most a shove can carry, planar and up, units/s. Mirrors
    WORLD_SHOVE_MAX in server/src/index.js, which clamps to it */
export const SHOVE_MAX = 24
/** after being knocked flat, how long every further shove is a stumble */
const GRACE = 3
/** a stumble never carries more than this, however it was sent */
const STUMBLE_MAX = 6

/** how often one player sends another a lean, and a knock. A held lean is a
    stream of small shoves; a knock is one, and the victim is down after it */
const LEAN_EVERY = 0.3
const KNOCK_EVERY = 0.7

type PosedRig = Parameters<typeof posedPoints>[0]

export interface RemoteBumps extends Bumpable {
  /** take this frame's roster; call once a frame after `sample` */
  refresh: () => void
}

export interface RemoteBumpOpts {
  world: RemoteWorld
  /** the body drawn for a player, whose mesh sizes their cylinder, or null
      before it has been spawned */
  rigOf: (id: PlayerId) => ({ group: import('three').Object3D } & Partial<PosedRig>) | null
  /** sitting in one of the fleet's chairs: not standing anywhere */
  seated: (id: PlayerId) => boolean
  /** put a shove on the wire */
  send: (to: PlayerId, vx: number, vy: number, vz: number) => void
  /** seconds */
  now: () => number
}

export function createRemoteBumps(o: RemoteBumpOpts): RemoteBumps {
  const ids: PlayerId[] = []
  const ext: BodyExtent = { radius: 0, height: 0 }
  const sent = new Map<PlayerId, number>()
  return {
    refresh: () => {
      ids.length = 0
      for (const id of o.world.players.keys()) ids.push(id)
      // forget anyone who has gone, or the map grows for a whole session
      if (sent.size > ids.length * 2 + 8) {
        for (const id of sent.keys()) if (!o.world.players.has(id)) sent.delete(id)
      }
    },
    get size() {
      return ids.length
    },
    peer: (i, out) => {
      const id = ids[i]
      const p = o.world.players.get(id)
      if (!p || !p.here || p.down || p.flying || o.seated(id)) return false
      const rig = o.rigOf(id)
      if (!rig) return false
      bodyExtent(rig.group, ext)
      out.x = p.x
      out.z = p.z
      out.feetY = p.y
      out.vx = p.vx
      out.vz = p.vz
      out.radius = ext.radius
      // a crouch folds the body about a quarter shorter
      out.height = ext.height * (1 - 0.25 * p.crouchK)
      return true
    },
    // their limbs as this screen draws them, so a lean or an arm reaching
    // out of their trunk is met where it is seen
    points: (i, out) => {
      const rig = o.rigOf(ids[i])
      return rig && 'limbPos' in rig ? posedPoints(rig as PosedRig, 0, 0, 0, out) : 0
    },
    // never: see the header
    nudge: () => false,
    hit: (i, b: Bump) => {
      const id = ids[i]
      const lean = b.kind === 'lean'
      if (lean && b.vx === 0 && b.vz === 0) return
      const t = o.now()
      if (t < (sent.get(id) ?? -Infinity)) return
      sent.set(id, t + (lean ? LEAN_EVERY : KNOCK_EVERY))
      o.send(id, b.vx, lean ? 0 : b.vy, b.vz)
    },
  }
}

export type ShoveEffect = 'ignore' | 'stumble' | 'flop'

export interface ShoveTaker {
  /**
   * A shove arrived for us. `able` is whether this body can be shoved at
   * all right now (on foot, not flying, not seated, not already down).
   * Returns what to do with it; the caller does it (a flop through the rig's
   * `hit`, a stumble through the walk's `push`) with the velocity `clamp`
   * leaves in `v`.
   */
  take: (v: { x: number; y: number; z: number }, now: number, able: boolean) => ShoveEffect
}

export function createShoveTaker(): ShoveTaker {
  let graceUntil = -Infinity
  return {
    take: (v, now, able) => {
      if (!able) return 'ignore'
      if (![v.x, v.y, v.z].every(Number.isFinite)) return 'ignore'
      const planar = Math.hypot(v.x, v.z)
      if (planar > SHOVE_MAX) {
        v.x *= SHOVE_MAX / planar
        v.z *= SHOVE_MAX / planar
      }
      v.y = Math.max(-SHOVE_MAX, Math.min(SHOVE_MAX, v.y))
      const hard = Math.hypot(v.x, v.z) >= FLOP_PLANAR || v.y <= FLOP_DOWN
      if (hard && now >= graceUntil) {
        graceUntil = now + GRACE
        return 'flop'
      }
      // a stumble: planar only, capped, whatever was sent
      const s = Math.hypot(v.x, v.z)
      if (s > STUMBLE_MAX) {
        v.x *= STUMBLE_MAX / s
        v.z *= STUMBLE_MAX / s
      }
      v.y = 0
      return s > 0.05 ? 'stumble' : 'ignore'
    },
  }
}
