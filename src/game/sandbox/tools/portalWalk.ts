import * as THREE from 'three'
import { supportY, type CollisionSet } from '../../physics/collision'
import { PORTAL_BODY_MID, type PortalCrossing, type Portals } from './portals'

/*
  The walker and the portals: the two calls the walk frame makes around its
  own step, so CrtScene's share is three lines and a callback.

  `before()` runs ahead of the walk's step. It marks the boxes under any
  open portal the body stands in front of (portals.ts's `aperture`), so this
  step's collision lets the body into the wall, and it remembers where the
  body's centre and eye were. `ground(level)` is the level's own ground with
  a hole cut in it wherever a floor portal lies on the terrain.

  `after(v)` runs once the step has moved the body. If the centre or the eye
  went through an open oval between the two, the body is carried out of the
  partner: its centre by the pair's transform, its gaze turned the same way
  and re-read as a yaw and a pitch (the walker never rolls), its velocity
  turned and handed to the walk as a fling, so the speed a fall brought in
  is the speed it leaves with. A wall exit stands the soles on whatever is
  under them rather than in it; a floor exit leaves them under the floor,
  over the hole, rising. A pair that spans two levels asks `changeLevel`
  first, which is the one place that can run a level change, and the new
  level's coordinates are the partner's own, so the transform needs no
  offset.

  Headless: it takes the walk, the eye and the level as plain interfaces.
*/

export interface PortalWalker {
  readonly feetY: number
  yaw: number
  pitch: number
  teleport: (x: number, z: number, feetY: number) => void
  fling: (vx: number, vy: number, vz: number) => void
}

export interface PortalWalkLevel {
  id: string
  collision: CollisionSet
  groundY: number
  groundYAt?: (x: number, z: number) => number
}

export interface PortalWalkEnv {
  portals: Portals
  walk: PortalWalker
  /** the lens: the walker's eye, read and written in place */
  eye: THREE.Vector3
  level: () => PortalWalkLevel
  /** the pair spans two levels: make `to` live now, seamlessly, or say no */
  changeLevel?: (to: string) => boolean
  /** after a carry: re-pose the body, drop the chase boom, play the sound */
  carried?: (c: PortalCrossing) => void
}

export interface PortalWalk {
  before: () => void
  /** the level's ground with the floor portals cut out of it, or the
      level's own function when none is open there */
  ground: (level: PortalWalkLevel) => ((x: number, z: number) => number) | undefined
  /** the walk's velocity this step; returns the crossing it carried */
  after: (vx: number, vy: number, vz: number) => PortalCrossing | null
  /** the last carry, for a harness: velocity in and out, and how many */
  readonly last: { vin: THREE.Vector3; vout: THREE.Vector3; from: number; to: number; count: number }
}

export function createPortalWalk(env: PortalWalkEnv): PortalWalk {
  const { portals, walk, eye } = env
  const prevC = new THREE.Vector3()
  const prevE = new THREE.Vector3()
  const curC = new THREE.Vector3()
  const M = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const t = new THREE.Vector3()
  const v = new THREE.Vector3()
  const d = new THREE.Vector3()
  let armed = false
  const last = { vin: new THREE.Vector3(), vout: new THREE.Vector3(), from: -1, to: -1, count: 0 }
  let holeLevel: PortalWalkLevel | null = null
  const holed = (x: number, z: number) => {
    const l = holeLevel!
    if (portals.hole(l.id, x, z)) return -1e6
    return l.groundYAt ? l.groundYAt(x, z) : l.groundY
  }

  return {
    last,
    before: () => {
      const l = env.level()
      prevC.set(eye.x, walk.feetY + PORTAL_BODY_MID, eye.z)
      prevE.copy(eye)
      armed = true
      portals.aperture(l.id, prevC)
    },
    ground: (l) => {
      if (!portals.anyIn(l.id)) return l.groundYAt
      holeLevel = l
      return holed
    },
    after: (vx, vy, vz) => {
      if (!armed) return null
      armed = false
      const l = env.level()
      if (!portals.anyIn(l.id)) return null
      curC.set(eye.x, walk.feetY + PORTAL_BODY_MID, eye.z)
      const c = portals.crossing(l.id, prevC, curC) ?? portals.crossing(l.id, prevE, eye)
      if (!c) return null
      const from = c.from
      const to = c.to
      portals.transform(from, M)
      M.decompose(t, q, s)
      // the gaze and the velocity, turned by the pair
      const cp = Math.cos(walk.pitch)
      d.set(-Math.sin(walk.yaw) * cp, Math.sin(walk.pitch), -Math.cos(walk.yaw) * cp).applyQuaternion(q)
      v.set(vx, vy, vz).applyQuaternion(q)
      curC.applyMatrix4(M)
      if (to.level !== from.level && !env.changeLevel?.(to.level)) return null
      const nl = env.level()
      let feet = curC.y - PORTAL_BODY_MID
      if (to.n.y < 0.45) {
        // out of a wall: on whatever is under the exit, never in it
        const floor = nl.groundYAt ? nl.groundYAt(curC.x, curC.z) : nl.groundY
        const under = supportY(curC.x, curC.z, feet + 0.6, nl.collision, floor)
        if (feet < under) feet = under
      }
      walk.teleport(curC.x, curC.z, feet)
      walk.yaw = Math.atan2(-d.x, -d.z)
      walk.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -1.35, 1.35)
      walk.fling(v.x, v.y, v.z)
      last.vin.set(vx, vy, vz)
      last.vout.copy(v)
      last.from = from.color
      last.to = to.color
      last.count++
      // the next step starts from here, and its collision knows the exit
      portals.aperture(nl.id, curC)
      env.carried?.(c)
      return c
    },
  }
}
