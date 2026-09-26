import * as THREE from 'three'

/*
  Being run over, as a question the scene can ask once a frame.

  Anything that moves and has a footprint (the fleet today; a sandbox prop
  thrown across a street tomorrow) is a `Mover`. `track()` watches where each
  one is from frame to frame, which is the only honest source of its speed:
  a remote driver's car is placed, not integrated, and has no velocity of its
  own to ask for. `strike()` then answers for one body standing somewhere:
  is a mover's footprint, grown by a body's radius, over these feet, and is it
  closing on them fast enough to matter? If so it fills in an impulse and the
  point it lands on, which is exactly what `PlayerRig.hit` takes.

  The footprint is the mover's own oriented box (`size` around `root`, yawed),
  not its collision Solid, because a vehicle collapses its Solid to a point
  while somebody is in it, which is precisely when it is being driven into
  people. Each body gets a cooldown keyed by whatever object the caller
  passes (the rig itself does), so a car pushing through a heap delivers one
  blow rather than one per frame, which would launch it into orbit.

  Headless: plain numbers and Vector3s, no renderer, nothing from React.
*/

export interface Mover {
  root: THREE.Object3D
  /** heading; 0 faces -Z, the walk's convention */
  readonly yaw: number
  size: { halfX: number; halfZ: number; height: number }
}

export interface Impact {
  impulse: THREE.Vector3
  point: THREE.Vector3
}

export interface ImpactWatch {
  /** note where every mover is this frame; call once per frame */
  track: (movers: readonly Mover[], dt: number) => void
  /** a body with its soles at `feet`, `height` tall and `mass` heavy: is it
      being hit right now? Fills `out` and starts that body's cooldown */
  strike: (key: object, feet: THREE.Vector3, height: number, mass: number, out: Impact) => boolean
}

/** below this closing speed a mover nudges rather than bowls you over;
    the walker's own collision already handles a nudge */
const MIN_SPEED = 4.5
/** how far outside a footprint still counts: a body's own half-width */
const REACH = 0.9
/** one blow per body per this long */
const COOLDOWN = 0.6

export function createImpactWatch(): ImpactWatch {
  const seen = new Map<Mover, { x: number; y: number; z: number; vx: number; vy: number; vz: number }>()
  const cool = new WeakMap<object, number>()
  let clock = 0
  let live: readonly Mover[] = []

  return {
    track: (movers, dt) => {
      clock += dt
      live = movers
      if (dt <= 0) return
      for (const m of movers) {
        const p = m.root.position
        const s = seen.get(m)
        if (!s) {
          seen.set(m, { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0 })
          continue
        }
        // a teleport (a recall, a respawn) is not a speed
        const jump = Math.hypot(p.x - s.x, p.z - s.z) > 30 * dt + 2
        const k = jump ? 0 : 1 - Math.exp(-20 * dt)
        s.vx = jump ? 0 : s.vx + ((p.x - s.x) / dt - s.vx) * k
        s.vy = jump ? 0 : s.vy + ((p.y - s.y) / dt - s.vy) * k
        s.vz = jump ? 0 : s.vz + ((p.z - s.z) / dt - s.vz) * k
        s.x = p.x
        s.y = p.y
        s.z = p.z
      }
    },
    strike: (key, feet, height, mass, out) => {
      if ((cool.get(key) ?? -1) > clock) return false
      for (const m of live) {
        const s = seen.get(m)
        if (!s) continue
        const speed = Math.hypot(s.vx, s.vz)
        if (speed < MIN_SPEED) continue
        const p = m.root.position
        if (feet.y > p.y + m.size.height || feet.y + height < p.y - 0.5) continue
        // into the mover's frame: local (lx, lz) sits at
        // (x + lx cos + lz sin, z - lx sin + lz cos)
        const dx = feet.x - p.x
        const dz = feet.z - p.z
        const c = Math.cos(m.yaw)
        const sn = Math.sin(m.yaw)
        const lx = dx * c - dz * sn
        const lz = dx * sn + dz * c
        if (Math.abs(lx) > m.size.halfX + REACH || Math.abs(lz) > m.size.halfZ + REACH) continue
        // only a mover closing on the body hits it; one driving away from a
        // body it is touching is leaving, not striking
        const d = Math.hypot(dx, dz) || 1
        const closing = (s.vx * dx + s.vz * dz) / d
        if (closing < MIN_SPEED * 0.5) continue
        // thrown along the mover's travel a little faster than it was going,
        // and up, more the harder it was going: a bumper scoops
        out.impulse.set(s.vx * 1.15, 3 + speed * 0.35 + Math.max(0, s.vy), s.vz * 1.15).multiplyScalar(mass)
        out.point.set(feet.x - (dx / d) * 0.4, feet.y + Math.min(height * 0.35, 1.4), feet.z - (dz / d) * 0.4)
        cool.set(key, clock + COOLDOWN)
        return true
      }
      return false
    },
  }
}
