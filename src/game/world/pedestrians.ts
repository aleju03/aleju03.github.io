import * as THREE from 'three'
import { seeded } from '../core/rand'
import {
  buildPlayerBody, type PlayerPose, type PlayerRig,
} from '../player/playerBody'
import {
  ACCENT_SWATCHES, GLOW_SWATCHES, SHELL_SWATCHES, TRIM_SWATCHES, type PlayerLook,
} from '../player/look'
import { blockedAt, makeCollisionSet, type Solid } from '../physics/collision'
import type { RagdollEnv } from '../player/ragdoll'
import { gfx } from './quality'
import { SEA_Y, terrainY } from './terrain'
import { ROAD_HALF, WALK_W, placeAt, roadAt } from './settlements'
import { inReserved } from './grid'

/*
  The other people: a handful of them walking the pavements of whatever town
  the player is standing in.

  This is world/fauna.ts's argument indoors of the treeline. A city with
  streets, kerbs, shopfronts and lit windows and nobody on the pavement does
  not read as empty, it reads as *evacuated*, which is a stronger and worse
  impression than a meadow with no deer.

  The thing that makes this cheap is that the body was already written twice
  over. A pedestrian is a `buildPlayerBody()` rig — the same articulated
  robot the player wears and the same one `net/avatars.ts` hangs on every
  remote player — fed the same `PlayerPose` struct, from a walk this module
  integrates instead of from a network snapshot. So there is no new asset, no
  new animation system and no new art direction: the people in the streets
  are the people in the streets, and a stranger cannot tell a scripted one
  from a real one until they fail to answer. Their looks are drawn from the
  same swatch palettes the pause screen offers, so the crowd is exactly as
  varied as the players are.

  It follows fauna.ts's rules, and for the same reasons: session state that
  never streams and never travels, a fixed pool re-cut beyond the fog, and no
  collision box of its own. It adds one of its own.

  **The pavement is the path.** There is no navmesh and there should not be
  one: `settlements.ts` already answers "is this the sidewalk slab" for any
  point in the world (`roadAt().walk`), which is a field, not a graph, so a
  pedestrian steers by *sampling* it — try the heading you are on, and if it
  is about to leave the slab, sweep for one that does not. That is a dozen
  cheap field lookups per person per second and it produces exactly what a
  walker does at a corner: carry on, or turn and carry on down the cross
  street. A graph would have to be built, kept in sync with a procedural
  street layout that is a pure function of position, and streamed. This does
  not.

  Two things bite, both learned in `net/avatars.ts` first. The rig's group
  origin is the *feet*, and its yaw runs a half turn off the facing it
  reports (`rotation.y = facing + PI`), so a body placed with the walker's
  own yaw walks backwards down the street. And these do not cast shadows,
  for avatars.ts's reason rather than fauna.ts's: an animal is out in a field
  on its own, while a crowd on a pavement is a dozen moving casters inside
  the one hand-managed map that everything else in town shares.
*/

export interface PedestrianHandles {
  /** advance the crowd; call once per rendered frame */
  update: (camPos: THREE.Vector3, dt: number) => void
}

interface BuildOpts {
  parent: THREE.Object3D
  /** the world's live solids. A pavement is not empty — it carries lamp
      posts, shopfronts and the corners of every building beside it — and a
      body that reads none of them walks through all of them */
  obstacles: Solid[]
  /** the ground the world is drawing, so a pedestrian on a graded street
      stands on the tarmac rather than on the terrain that was there first */
  groundAt: (x: number, z: number) => number
  /** where a re-cut puts one, as a range from the camera. Sized against the
      fog by default, which is wrong for a fifty-unit photograph: nothing but
      `scripts/shoot.mjs` should pass this */
  ring?: { near: number; spread: number }
  trackDisposable: (d: { dispose: () => void }) => void
}

/** the eye height everyone in this world is drawn to */
const EYE = 3.84
/** a comfortable pace, units/s. The walk's own is about 5.4, so a player
    overtakes the crowd rather than being paced by it */
const PACE = 2.6
/** how far out one is re-cut, and where it comes back. Tighter than the
    animals' because a town's fog is the same but its geometry is not: a
    person appearing 110 units down a straight street is visible, so they
    arrive round a corner's worth further out and near the edge of the haze */
const RECUT_FAR = 190
const RECUT_NEAR = 95
const RECUT_SPREAD = 45
/** past this there is no town under the camera and the crowd sleeps */
const IDLE_CHECK = 0.75

/** how tall a body the wall test asks about */
const BODY_H = 4.2

/** the middle of the sidewalk slab: kerb plus half the walkway */
const WALK_MID = ROAD_HALF + WALK_W * 0.5

/*
  Which way a heading points, and it is the walk's convention rather than the
  obvious one: yaw 0 faces -Z, so forward is (-sin, -cos). Everything about a
  body downstream assumes it — `walkController` derives its velocity this way,
  the rig reads `pose.vx/vz` to plant its feet, and `net/avatars.ts` draws the
  group at `facing + PI` because the robot is modelled facing +Z. Steer by
  (+sin, +cos) instead and every number still agrees with itself, the walk
  cycle still runs, and the body moonwalks down the street.
*/
const fwdX = (yaw: number) => -Math.sin(yaw)
const fwdZ = (yaw: number) => -Math.cos(yaw)

interface Person {
  rig: PlayerRig
  group: THREE.Group
  x: number
  z: number
  yaw: number
  /** 0..1 of PACE, so a stop is a stopped *gait* rather than a frozen rig */
  gait: number
  /** seconds until this one may consider turning again, so a body standing
      on a corner does not oscillate between two equally good headings */
  settle: number
  /** seconds paused, looking at a window */
  pause: number
  live: boolean
}

const swatch = <T,>(list: readonly T[], r: number) => list[Math.floor(r * list.length) % list.length]

export function buildPedestrians(opts: BuildOpts): PedestrianHandles {
  const { parent, groundAt, trackDisposable } = opts
  const near = opts.ring?.near ?? RECUT_NEAR
  const spread = opts.ring?.spread ?? RECUT_SPREAD

  const root = new THREE.Group()
  root.userData.dynamic = true
  parent.add(root)

  const rnd = seeded(0x51c3)
  const crowd: Person[] = []
  const pose: PlayerPose = {
    dt: 0, gait: 0, crouchK: 0, grounded: true, run: false,
    yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
  }
  // a pedestrian never ragdolls, so this is a formality the rig's contract
  // requires rather than anything that is ever consulted
  const env: RagdollEnv = {
    groundY: 0,
    collision: makeCollisionSet({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
  }

  const look = (): PlayerLook => ({
    shell: swatch(SHELL_SWATCHES, rnd()),
    trim: swatch(TRIM_SWATCHES, rnd()),
    accent: swatch(ACCENT_SWATCHES, rnd()),
    glow: swatch(GLOW_SWATCHES, rnd()),
  })

  /* the world's solids, wrapped for `blockedAt`. Infinite bounds: those are
     the walker's own clamp and mean nothing here, the same note debris.ts
     carries about the same array */
  const solids = makeCollisionSet(
    { minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9 },
    opts.obstacles,
  )

  /** is this a place a person may stand: on the slab, out of the road, on
      dry land, off the property, and not inside anything */
  const onWalk = (x: number, z: number) => {
    if (inReserved(x, z, 3)) return false
    const place = placeAt(x, z)
    if (!place.district) return false
    const road = roadAt(x, z, place)
    if (!road.walk || road.asphalt) return false
    const y = terrainY(x, z)
    if (y < SEA_Y + 0.4) return false
    // shoulder width, so a body sidles past a lamp post rather than through
    // it. The step-up allowance is the kerb: a pavement is a low slab and a
    // person standing on one must not read as standing inside it
    return !blockedAt(x, z, y, y + BODY_H, solids, 0.5)
  }

  /*
    Somewhere to start. The search is deliberately over *bearings from the
    camera* rather than over the street grid: the streets are a field, the
    walkable band is 1.5 units wide, and hunting for it by sampling a ring is
    both simpler and better behaved at a junction than solving for one.
  */
  const findSpot = (cx: number, cz: number) => {
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2
      const d = near + rnd() * spread
      const x0 = cx + Math.cos(a) * d
      const z0 = cz + Math.sin(a) * d
      const place = placeAt(x0, z0)
      if (!place.district) continue
      const road = roadAt(x0, z0, place)
      if (!road.axis) continue
      // step off the centreline onto one of the two pavements, which is one
      // move rather than a search: roadAt says which way the street runs and
      // where its middle is
      for (const side of [1, -1]) {
        const x = road.axis === 'x' ? x0 : road.line + side * WALK_MID
        const z = road.axis === 'x' ? road.line + side * WALK_MID : z0
        if (onWalk(x, z)) return { x, z, axis: road.axis }
      }
    }
    return null
  }

  /*
    Where the next step goes.

    Try straight on. If that leaves the slab, check whether what is in the
    way is the road itself — the pavement grid is continuous *except* across
    every junction, where seven units of tarmac cut it (measured: a block
    corner is six cells of walkable slab against five of asphalt), so a
    pedestrian who will not step off the kerb is a pedestrian confined to one
    block for the rest of their life. Looking CROSS_R ahead for the far kerb
    is what lets them cross, and crossing a street is most of what people on
    a street are seen doing.

    Failing that, sweep outward in both directions for the nearest heading
    that works, which at a corner is the cross street. Failing *that*, turn
    round — but only on a real dead end, never while `settle` is holding a
    turn just taken. That distinction is the whole difference between a crowd
    and a set of metronomes: the first version flipped 180 degrees whenever a
    fresh corner turn had not yet carried the body clear of the corner, so
    everyone paced back and forth over the same four units of pavement
    (measured: 2.3 u/s walked against 0.7 u/s of actual progress).
  */
  const CROSS_R = 9
  type Step = 'go' | 'hold' | 'dead'
  const steer = (p: Person, dt: number): Step => {
    const reach = Math.max(1.2, PACE * dt * 6)
    const at = (yaw: number, d: number) => ({ x: p.x + fwdX(yaw) * d, z: p.z + fwdZ(yaw) * d })
    const ahead = (yaw: number, d = reach) => {
      const q = at(yaw, d)
      return onWalk(q.x, q.z)
    }
    /*
      Already inside something — a shop door swung shut, a chunk rebuilt:
      keep walking rather than turning on the spot forever, or the body is
      stuck in a wall for the rest of its life.

      This asks `blockedAt` and not `onWalk`, which is the whole subtlety:
      `onWalk` is also false halfway across a road, and a body that treats
      *that* as being stuck stops steering and walks off across town.
    */
    const y = groundAt(p.x, p.z)
    if (blockedAt(p.x, p.z, y, y + BODY_H, solids, 0.5)) return 'go'
    if (ahead(p.yaw)) return 'go'
    // the kerb: step into the road only when there is a pavement on the
    // other side of it, and only straight across
    const near = at(p.yaw, reach)
    const place = placeAt(near.x, near.z)
    if (roadAt(near.x, near.z, place).asphalt && ahead(p.yaw, CROSS_R)) return 'go'
    if (p.settle > 0) return 'hold'
    for (let step = 1; step <= 8; step++) {
      const off = (step * Math.PI) / 8
      for (const dir of [1, -1]) {
        const yaw = p.yaw + off * dir
        if (!ahead(yaw)) continue
        p.yaw = yaw
        // a corner taken is a decision made: hold it for a moment so the
        // body does not shuffle between two headings on the same slab
        p.settle = 0.8
        return 'go'
      }
    }
    return 'dead'
  }

  const recut = (p: Person, cx: number, cz: number) => {
    const spot = findSpot(cx, cz)
    if (!spot) {
      p.live = false
      p.group.visible = false
      return false
    }
    p.x = spot.x
    p.z = spot.z
    // set off along the street rather than across it
    p.yaw = spot.axis === 'x'
      ? (rnd() < 0.5 ? Math.PI / 2 : -Math.PI / 2)
      : (rnd() < 0.5 ? 0 : Math.PI)
    p.gait = 1
    p.settle = 0
    p.pause = 0
    p.live = true
    p.rig.setLook(look())
    p.rig.face(p.yaw)
    p.group.position.set(p.x, groundAt(p.x, p.z), p.z)
    p.group.visible = true
    return true
  }

  for (let i = 0; i < gfx.pedestrians; i++) {
    const rig = buildPlayerBody(EYE, 34, look())
    rig.showHead(true)
    rig.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.castShadow = false
    })
    rig.group.visible = false
    root.add(rig.group)
    crowd.push({
      rig, group: rig.group, x: 0, z: 0, yaw: 0,
      gait: 0, settle: 0, pause: 0, live: false,
    })
  }

  /** seconds until the next attempt to place whoever has nowhere to be.
      Out in the countryside every one of them fails every frame, and
      `findSpot` is 26 tries at four field lookups each */
  let retryIn = 0

  const update = (camPos: THREE.Vector3, dt: number) => {
    if (!crowd.length) return
    retryIn -= dt
    const mayRetry = retryIn <= 0
    if (mayRetry) retryIn = IDLE_CHECK
    // no town under the camera means nobody is coming: skip the search
    // entirely rather than paying for it once per person
    const inTown = placeAt(camPos.x, camPos.z).district !== null

    for (const p of crowd) {
      if (!p.live) {
        if (mayRetry && inTown) recut(p, camPos.x, camPos.z)
        continue
      }
      const dx = p.x - camPos.x
      const dz = p.z - camPos.z
      if (dx * dx + dz * dz > RECUT_FAR * RECUT_FAR) {
        p.live = false
        p.group.visible = false
        if (inTown) recut(p, camPos.x, camPos.z)
        continue
      }

      /* ---- the walk ----------------------------------------------------- */
      p.settle = Math.max(0, p.settle - dt)
      if (p.pause > 0) {
        p.pause -= dt
        p.gait = Math.max(0, p.gait - dt * 4)
      } else {
        p.gait = Math.min(1, p.gait + dt * 3)
        // the occasional stop: somebody reading a shopfront, which is what
        // stops a pavement reading as a conveyor belt
        if (rnd() < dt * 0.04) p.pause = 2 + rnd() * 4
      }
      let speed = PACE * p.gait
      if (speed > 0.05) {
        const step = steer(p, dt)
        if (step === 'go') {
          p.x += fwdX(p.yaw) * speed * dt
          p.z += fwdZ(p.yaw) * speed * dt
        } else if (step === 'dead') {
          // nowhere to go: turn round on the spot
          p.yaw += Math.PI
          p.settle = 0.8
          speed = 0
        } else {
          // mid-corner, holding the heading just chosen: stand for a beat
          // rather than spinning, and let the gait fall with it
          speed = 0
          p.gait = Math.max(0, p.gait - dt * 3)
        }
      }

      /* ---- the body ------------------------------------------------------ */
      const y = groundAt(p.x, p.z)
      p.group.position.set(p.x, y, p.z)
      pose.dt = dt
      pose.gait = p.gait * 0.5 // PACE against the walk's own run cap
      pose.yaw = p.yaw
      pose.vx = fwdX(p.yaw) * speed
      pose.vz = fwdZ(p.yaw) * speed
      env.groundY = y
      p.rig.update(pose, env)
      p.group.rotation.y = p.rig.facing + Math.PI
    }
  }

  trackDisposable({
    dispose: () => {
      crowd.length = 0
      root.clear()
    },
  })

  return { update }
}
