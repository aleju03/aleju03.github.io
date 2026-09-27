import * as THREE from 'three'
import type { GrabRig, RigEntry } from '../sandbox/tools/types'
import type { GrabPhase, PlayerId } from './protocol'
import type { RemoteWorld } from './remotePlayers'

/*
  The physgun on another player, honestly.

  The same split as `net/shove.ts`, for the same reason: a remote body on this
  screen is a playback two server ticks in the past, and pinning it here would
  be arguing with its owner's client about where they are. So:

  - **The grabber** (`createRemoteGrabs`) offers every remote player on foot
    to the physgun as one more rig, through a thin `GrabRig` adapter over the
    body `avatars.ts` draws for them. The beam, its glow and its aim work
    unchanged. What the adapter adds is the wire: while the beam holds a limb
    it streams where that limb should be at ~20Hz (`world-grab` 'hold'), a
    freeze sends 'freeze', and letting go sends 'release' with the beam's
    velocity. And it pins its own copy of the body to the beam end as well,
    which is the prediction that keeps the hold from feeling a round trip
    late: the victim's own snapshots run well behind the beam, so while the
    hold lasts this screen shows the body where the victim is *about to be*,
    and once it is let go the local ragdoll finishes the flight and the get-up
    lands back on the victim's own stream (`avatars.ts`'s `claim`).
  - **The victim** (`createGrabTaker`) is the judge of its own body. It pins
    its own ragdoll's limb to the streamed point (the rig's ordinary
    `grab(i, target)`, so a standing body is knocked limp by it and dangles
    and flails like a pedestrian on the beam), eases that point between
    packets, and on release tops the body's own velocity up to the throw.
    It refuses while seated, flying, in god mode or mid-cut; it lets go of a
    hold that stops arriving for STALE seconds (a grabber who dropped off, a
    lost release); and no hold or freeze lasts more than CAP seconds, after
    which that grabber is ignored until they let go, so nobody can be pinned
    in the air for a whole session. Everyone else sees it through the
    victim's ordinary snapshots, which carry the chest while held and the
    `held` pose bit that tells their copies to follow it.

  Headless: plain numbers, a clock passed in, and three.js vectors.
*/

/** the most a throw carries, units/s. Mirrors WORLD_GRAB_THROW_MAX in
    server/src/index.js, which clamps to it */
export const THROW_MAX = 40
/** no hold or freeze lasts longer than this, seconds */
export const CAP = 8
/** a hold with no packet for this long has been let go, seconds */
export const STALE = 0.5
/** the grabber's stream rate, packets a second */
const SEND_HZ = 20
/** a limb pinned by the beam (the physgun's own RIG_K) */
const HOLD_K = 0.5
/** how far past the last packet the pin point is carried along, seconds */
const LEAD = 0.12
/** fastest a streamed point may be read as moving, units/s */
const MAX_POINT_SPEED = 80

/** the grabber's copies of the victim's own grab rig */
export const grabKey = (id: PlayerId) => `player:${id}`

/** a limb's velocity, differenced frame to frame and low-passed */
function limbVelocity() {
  const last = new THREE.Vector3()
  const cur = new THREE.Vector3()
  const v = new THREE.Vector3()
  let fresh = true
  return {
    v,
    reset: () => {
      fresh = true
      v.set(0, 0, 0)
    },
    track: (at: THREE.Vector3, dt: number) => {
      cur.copy(at)
      if (!fresh && dt > 0) {
        last.subVectors(cur, last).divideScalar(dt)
        v.lerp(last, 1 - Math.exp(-dt * 20))
      }
      fresh = false
      last.copy(cur)
    },
  }
}

/** a body that can be held: the player rig, or anything shaped like it */
export interface GrabBody {
  readonly limbs: readonly unknown[]
  limbPos: (i: number, out: THREE.Vector3) => THREE.Vector3
  grab: (i: number, target: THREE.Vector3 | null, k?: number) => void
  /** on a body that is already down, adds this velocity to all of it */
  flop: (vx: number, vy: number, vz: number) => void
}

/** hand a let-go body the rest of the throw its own momentum lacks */
function topUp(body: GrabBody, have: THREE.Vector3, want: THREE.Vector3, tmp: THREE.Vector3) {
  tmp.subVectors(want, have)
  if (tmp.length() > THROW_MAX) tmp.setLength(THROW_MAX)
  if (tmp.lengthSq() > 0.01) body.flop(tmp.x, tmp.y, tmp.z)
}

/* ------------------------------------------------------------ the victim -- */

export interface GrabMsg {
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

export interface GrabTaker {
  /** a world-grab arrived for us; `able` as for a shove, minus "already
      down" (a heap on the floor can be picked up) */
  take: (m: GrabMsg, now: number, able: boolean) => void
  /** once a frame: eases the pin, and lets go of a hold that went stale, ran
      past its cap or became impossible */
  tick: (now: number, dt: number, able: boolean) => void
  /** that player left the world: whatever they held is let go */
  drop: (from: PlayerId) => void
  /** somebody has us, by a hold or a freeze */
  readonly held: boolean
  /** who, or null */
  readonly by: PlayerId | null
}

export function createGrabTaker(body: GrabBody): GrabTaker {
  let from: PlayerId | null = null
  let limb = -1
  let frozen = false
  let start = 0
  let last = 0
  /** the last streamed point, its velocity, and the live point pinned to */
  const P = new THREE.Vector3()
  const V = new THREE.Vector3()
  const pin = new THREE.Vector3()
  const goal = new THREE.Vector3()
  const at = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const vel = limbVelocity()
  /** a grabber whose hold ran out, ignored until they let go or go quiet */
  let muted: PlayerId | null = null
  let mutedAt = 0

  const letGo = (thrown: THREE.Vector3 | null) => {
    if (from === null) return
    body.grab(limb, null)
    if (thrown) topUp(body, vel.v, thrown, tmp)
    from = null
    limb = -1
    frozen = false
  }

  return {
    take: (m, now, able) => {
      if (!Number.isInteger(m.limb) || m.limb < 0 || m.limb >= body.limbs.length) return
      if (![m.x, m.y, m.z].every(Number.isFinite)) return
      if (m.phase === 'release') {
        if (muted === m.from) muted = null
        if (m.from !== from) return
        const v = [m.vx, m.vy, m.vz].every(Number.isFinite) ? tmp.set(m.vx, m.vy, m.vz) : null
        letGo(v ? goal.copy(v) : null)
        return
      }
      if (muted === m.from) {
        mutedAt = now
        return
      }
      if (!able) {
        letGo(null)
        return
      }
      // first come: a second grabber waits for the first to let go
      if (from !== null && from !== m.from) return
      if (from === null) {
        from = m.from
        start = now
        limb = m.limb
        P.set(m.x, m.y, m.z)
        V.set(0, 0, 0)
        pin.copy(P)
        vel.reset()
      } else {
        if (m.limb !== limb) {
          body.grab(limb, null)
          limb = m.limb
        }
        const span = now - last
        if (span > 1e-3) {
          V.set(m.x - P.x, m.y - P.y, m.z - P.z).divideScalar(span)
          if (V.length() > MAX_POINT_SPEED) V.setLength(MAX_POINT_SPEED)
        }
        P.set(m.x, m.y, m.z)
      }
      last = now
      frozen = m.phase === 'freeze'
      if (frozen) {
        V.set(0, 0, 0)
        pin.copy(P)
      }
      body.grab(limb, pin, frozen ? 1 : HOLD_K)
    },
    tick: (now, dt, able) => {
      if (muted !== null && now - mutedAt > 1) muted = null
      if (from === null) return
      if (!able) {
        letGo(null)
        return
      }
      if (now - start > CAP) {
        muted = from
        mutedAt = now
        letGo(null)
        return
      }
      if (!frozen && now - last > STALE) {
        letGo(null)
        return
      }
      if (!frozen) {
        goal.copy(V).multiplyScalar(Math.min(LEAD, now - last)).add(P)
        pin.lerp(goal, 1 - Math.exp(-dt * 30))
      }
      body.limbPos(limb, at)
      vel.track(at, dt)
    },
    drop: (id) => {
      if (muted === id) muted = null
      if (from === id) letGo(null)
    },
    get held() {
      return from !== null
    },
    get by() {
      return from
    },
  }
}

/* ----------------------------------------------------------- the grabber -- */

/** the body avatars.ts draws for a remote player, as far as a grab needs it */
export interface RemoteBody extends GrabBody {
  group: THREE.Object3D
}

export interface RemoteGrabOpts {
  world: RemoteWorld
  rigOf: (id: PlayerId) => RemoteBody | null
  /** tell avatars.ts this client is pinning that body itself (on), or just
      let go of it (off), so it neither follows the victim's stream nor
      re-flops the body while the prediction is in charge */
  claim: (id: PlayerId, on: boolean) => void
  seated: (id: PlayerId) => boolean
  send: (
    to: PlayerId, phase: GrabPhase, limb: number,
    x: number, y: number, z: number, vx?: number, vy?: number, vz?: number,
  ) => void
  /** seconds */
  now: () => number
}

export interface RemoteGrabs {
  /** the physgun's candidates: every remote player on foot, in view */
  rigs: () => Iterable<RigEntry>
  /** once a frame: streams any live hold and runs out the caps */
  tick: (dt: number) => void
}

interface Adapter extends GrabRig {
  id: PlayerId
  state: 'none' | 'hold' | 'freeze'
  limb: number
  target: THREE.Vector3 | null
  start: number
  next: number
}

export function createRemoteGrabs(o: RemoteGrabOpts): RemoteGrabs {
  const adapters = new Map<PlayerId, Adapter>()
  const entries: RigEntry[] = []
  const at = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const vels = new Map<PlayerId, ReturnType<typeof limbVelocity>>()

  const holdable = (id: PlayerId) => {
    const p = o.world.players.get(id)
    return !!p && p.here && !p.flying && !o.seated(id) && !!o.rigOf(id)
  }

  const stop = (a: Adapter) => {
    const rig = o.rigOf(a.id)
    if (rig && a.limb >= 0) rig.grab(a.limb, null)
    a.state = 'none'
    a.target = null
    o.claim(a.id, false)
  }

  const adapterFor = (id: PlayerId): Adapter => {
    let a = adapters.get(id)
    if (a) return a
    const self: Adapter = {
      id,
      state: 'none',
      limb: -1,
      target: null,
      start: 0,
      next: 0,
      get limbs() {
        return (o.rigOf(id)?.limbs ?? []) as readonly { radius: number }[]
      },
      limbPos: (i, out) => {
        const rig = o.rigOf(id)
        return rig ? rig.limbPos(i, out) : out
      },
      grab: (i, target, k, v) => {
        const rig = o.rigOf(id)
        const now = o.now()
        if (!target) {
          if (self.state === 'none') return
          if (rig) {
            rig.limbPos(i, at)
            rig.grab(i, null)
            if (v) {
              const vel = vels.get(id)
              if (vel) topUp(rig, vel.v, tmp.copy(v).clampLength(0, THROW_MAX), at.clone())
            }
          } else at.set(0, 0, 0)
          o.send(id, 'release', i, at.x, at.y, at.z, v?.x ?? 0, v?.y ?? 0, v?.z ?? 0)
          self.state = 'none'
          self.target = null
          o.claim(id, false)
          return
        }
        if (!rig || !holdable(id)) return
        if (self.state === 'none') {
          self.start = now
          vels.get(id)?.reset()
        }
        const freeze = (k ?? 0) >= 1
        self.state = freeze ? 'freeze' : 'hold'
        self.limb = i
        self.target = target
        self.next = now
        o.claim(id, true)
        rig.grab(i, target, k)
        if (freeze) o.send(id, 'freeze', i, target.x, target.y, target.z)
      },
      alive: () => holdable(id) && (self.state === 'none' || o.now() - self.start <= CAP),
    }
    a = self
    adapters.set(id, a)
    vels.set(id, limbVelocity())
    return a
  }

  return {
    rigs: () => {
      entries.length = 0
      for (const [id, p] of o.world.players) {
        if (!holdable(id)) continue
        const rig = o.rigOf(id)
        if (!rig || !rig.group.visible || !p.here) continue
        entries.push({ key: grabKey(id), rig: adapterFor(id) })
      }
      return entries
    },
    tick: (dt) => {
      const now = o.now()
      for (const a of adapters.values()) {
        if (!o.world.players.has(a.id)) {
          // gone: their body is already despawned, so there is nothing to
          // unpin, only the bookkeeping
          adapters.delete(a.id)
          vels.delete(a.id)
          continue
        }
        if (a.state === 'none') continue
        // the victim lets go at the cap on their side; this copy does too,
        // and the physgun drops the hold on seeing `alive` go false
        if (!holdable(a.id) || now - a.start > CAP) {
          stop(a)
          continue
        }
        const rig = o.rigOf(a.id)
        if (rig) vels.get(a.id)?.track(rig.limbPos(a.limb, at), dt)
        if (a.state === 'hold' && a.target && now >= a.next) {
          a.next = now + 1 / SEND_HZ
          o.send(a.id, 'hold', a.limb, a.target.x, a.target.y, a.target.z)
        }
      }
    },
  }
}
