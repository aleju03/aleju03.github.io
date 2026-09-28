import * as THREE from 'three'
import { seeded } from '../core/rand'
import {
  buildPlayerBody, type PlayerPose, type PlayerRig,
} from '../player/playerBody'
import {
  ACCENT_SWATCHES, BUILDS, COSTUMES, FUR_SWATCHES, GLOW_SWATCHES, HATS, PHONES, SHELL_SWATCHES, TRIM_SWATCHES,
  type PlayerLook,
} from '../player/look'
import { blockedAt, makeCollisionSet, type Solid } from '../physics/collision'
import type { RagdollEnv } from '../player/ragdoll'
import type { Impact, ImpactWatch } from '../player/impacts'
import {
  bodyExtent, posedPoints, MAX_POINTS, type BodyExtent, type Bumpable, type Bump,
} from '../player/bodyContact'
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

  **Bodies bump.** A pedestrian has no box in the level's collision (it
  moves, and a box the walk could stand on would be a ladder onto a head),
  but it is a `Bumpable` (`player/bodyContact.ts`): the walker's contact
  pass asks where each one is, shoves it half the overlap when it has room
  behind it, staggers it when leaned on hard, and knocks it into the same
  flop a car does when charged, tackled or landed on. A body lying in the
  road is trampled: walked through, it takes a kick. All of it is local
  session state, so this client is the authority and nothing travels.

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
  /** let anything the watch is tracking (a car, mostly) bowl people over.
      Call after the watch has been told where the movers are this frame */
  knock: (watch: ImpactWatch) => void
  /** everyone out on the pavement, as bodies a grab beam can take by a
      limb. Taking one knocks them flat the way a car does, so the crowd's
      own tick hands the body to the ragdoll and stands it up afterwards */
  grabbable: () => Iterable<{ key: string; rig: GrabHandle }>
  /** the crowd as bodies the walker bumps into (see the header) */
  bumpable: Bumpable
  /** put people exactly here, standing for `pause` seconds (a harness's
      way to stage a street; the game never calls it). The rest are parked */
  stage: (spots: readonly { x: number; z: number; yaw: number; pause?: number }[]) => void
  /** body i's rig group, for a harness measuring its drawn mesh */
  groupOf: (i: number) => THREE.Object3D | null
  /** the chest of body i if it is lying down, into `out`; false otherwise */
  lying: (i: number, out: THREE.Vector3) => boolean
  /** how many are knocked down right now, and how many times in all */
  readonly downed: number
  readonly knocks: number
}

/** the part of a rig a grab beam needs (the physgun's `GrabRig`) */
export interface GrabHandle {
  readonly limbs: readonly { radius: number }[]
  limbPos: (i: number, out: THREE.Vector3) => THREE.Vector3
  grab: (i: number, target: THREE.Vector3 | null, k?: number) => void
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
/** leaned into on the first frame of a bump: the step out of the walker's
    way, units/s, on top of the stagger back */
const SIDESTEP = 3
/** the touchdown slap: a knocked body lands limbs first and they bounce,
    one diagonal pair and then the other. Upward speed, units/s, given to
    the limb (the rest of the heap gets a quarter of it through rig.hit) */
const SLAP = 3.2
const SLAP_GAP = 0.14
/** how fast a stagger bleeds away, per second */
const STAGGER_GRIP = 4.5
/** a trample: the share of the walker's velocity a body lying underfoot is
    kicked with, the lift, and how often one body can be kicked. Mostly a
    jolt up: a walker wading through a heap used to push it along the road
    like a sledge, a kick every third of a second */
const TRAMPLE_K = 0.2
const TRAMPLE_UP = 2.4
const TRAMPLE_EVERY = 0.9

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
  /** knocked flat: the ragdoll's world while it lies there (the solids near
      where it fell, not the whole town's), and how long it has been down */
  down: RagdollEnv | null
  downFor: number
  /** the soles, and the walk's velocity this frame, for the contact pass */
  y: number
  vx: number
  vz: number
  /** a stagger from being leaned on: velocity that bleeds away, units/s */
  sx: number
  sz: number
  /** the cylinder it bumps as, measured off the rig (bodyContact.ts) */
  ext: BodyExtent
  /** seconds until a body lying down may be trampled again */
  kicked: number
  /** its posed limbs in world space, and the crowd tick they were read on
      (read on demand, once a tick, only for a body the walker is near) */
  pts: Float32Array
  npts: number
  ptsAt: number
  /** knocked into the air and not yet come down, and seconds until the
      second half of the touchdown's limb slap */
  airborne: boolean
  slapIn: number
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
  // walking, the rig only asks this for the floor under its feet; a body that
  // has been knocked down gets a world of its own (see `knock`)
  const env: RagdollEnv = {
    groundY: 0,
    collision: makeCollisionSet({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
  }

  const look = (): PlayerLook => ({
    shell: swatch(SHELL_SWATCHES, rnd()),
    trim: swatch(TRIM_SWATCHES, rnd()),
    accent: swatch(ACCENT_SWATCHES, rnd()),
    glow: swatch(GLOW_SWATCHES, rnd()),
    hat: Math.floor(rnd() * HATS.length) % HATS.length,
    costume: Math.floor(rnd() * COSTUMES.length) % COSTUMES.length,
    build: Math.floor(rnd() * BUILDS.length) % BUILDS.length,
    fur: Math.floor(rnd() * FUR_SWATCHES.length) % FUR_SWATCHES.length,
    // a headset on about one in five
    phones: rnd() < 0.2 ? 1 + (Math.floor(rnd() * (PHONES.length - 1)) % (PHONES.length - 1)) : 0,
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
    camera* rather than over the street plan: the streets are a field, the
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
      if (road.dist > 30) continue
      // step off the centreline onto one of the two pavements, which is one
      // move rather than a search: roadAt says which way the street runs and
      // where its middle is
      for (const side of [1, -1]) {
        const x = road.footX - road.dirZ * side * WALK_MID
        const z = road.footZ + road.dirX * side * WALK_MID
        if (onWalk(x, z)) return { x, z, dx: road.dirX, dz: road.dirZ }
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
    p.yaw = Math.atan2(-spot.dx, -spot.dz) + (rnd() < 0.5 ? 0 : Math.PI)
    p.gait = 1
    p.settle = 0
    p.pause = 0
    p.live = true
    // whoever was lying in the road back there is somebody new over here
    p.down = null
    p.sx = p.sz = 0
    p.rig.reset()
    p.rig.setLook(look())
    bodyExtent(p.group, p.ext)
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
      gait: 0, settle: 0, pause: 0, live: false, down: null, downFor: 0,
      y: 0, vx: 0, vz: 0, sx: 0, sz: 0, ext: { radius: 1, height: BODY_H }, kicked: 0,
      pts: new Float32Array(MAX_POINTS * 4), npts: 0, ptsAt: -1,
      airborne: false, slapIn: -1,
    })
  }

  /** seconds until the next attempt to place whoever has nowhere to be.
      Out in the countryside every one of them fails every frame, and
      `findSpot` is 26 tries at four field lookups each */
  let retryIn = 0

  /** the crowd's tick count, which is what a body's cached points are stamped with */
  let tick = 0
  const update = (camPos: THREE.Vector3, dt: number) => {
    tick++
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

      /* ---- knocked flat ------------------------------------------------- */
      // the ragdoll owns the body until it has settled a while, then they
      // stand up where they lie and carry on down the pavement from there
      if (p.down) {
        touchdown(p, dt)
        p.vx = p.vz = 0
        p.sx = p.sz = 0
        p.kicked = Math.max(0, p.kicked - dt)
        p.downFor += dt
        pose.dt = dt
        pose.gait = 0
        pose.vx = 0
        pose.vz = 0
        if (p.rig.ragdolling && p.rig.settled && p.downFor > 2.2) {
          p.rig.getupSpot(getup)
          p.x = getup.x
          p.z = getup.z
          p.group.position.set(p.x, groundAt(p.x, p.z), p.z)
          p.group.rotation.y = p.rig.facing + Math.PI
          p.group.updateMatrixWorld(true)
          p.rig.beginRecover()
        }
        if (!p.rig.ragdolling) {
          p.group.position.set(p.x, groundAt(p.x, p.z), p.z)
          p.group.rotation.y = p.rig.facing + Math.PI
        }
        p.down.groundY = groundAt(p.x, p.z)
        p.rig.update(pose, p.down)
        if (!p.rig.down) {
          p.down = null
          p.yaw = p.rig.facing
          p.pause = 1 + rnd() * 1.5 // a moment to collect themselves
        }
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
      // a stagger from being leaned on: carried back a step or two, the
      // walk held while it lasts, and never into a wall
      const staggered = p.sx !== 0 || p.sz !== 0
      if (staggered) {
        const nx = p.x + p.sx * dt
        const nz = p.z + p.sz * dt
        const ny = groundAt(nx, nz)
        if (!blockedAt(nx, nz, ny, ny + BODY_H, solids, 0.5)) {
          p.x = nx
          p.z = nz
        } else p.sx = p.sz = 0
        const k = Math.exp(-STAGGER_GRIP * dt)
        p.sx *= k
        p.sz *= k
        if (p.sx * p.sx + p.sz * p.sz < 0.04) p.sx = p.sz = 0
        speed = 0
        p.gait = Math.max(0, p.gait - dt * 4)
      }
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
      p.y = y
      p.vx = fwdX(p.yaw) * speed + p.sx
      p.vz = fwdZ(p.yaw) * speed + p.sz
      p.group.position.set(p.x, y, p.z)
      pose.dt = dt
      pose.gait = staggered ? Math.min(1, Math.hypot(p.sx, p.sz) / 5.9) : p.gait * 0.5 // PACE against the walk's own run cap
      pose.yaw = p.yaw
      pose.vx = p.vx
      pose.vz = p.vz
      env.groundY = y
      p.rig.update(pose, env)
      p.group.rotation.y = p.rig.facing + Math.PI
    }
  }

  const getup = new THREE.Vector3()
  const feet = new THREE.Vector3()
  const hit: Impact = { impulse: new THREE.Vector3(), point: new THREE.Vector3() }
  /** the solids within reach of a body lying at (x, z): the ragdoll tests
      every one of them every substep, and the town has thousands */
  const nearSolids = (x: number, z: number) => {
    const R = 14
    return opts.obstacles.filter(
      (b) => b.max.x > x - R && b.min.x < x + R && b.max.z > z - R && b.min.z < z + R,
    )
  }
  const downEnv = (p: Person): RagdollEnv => {
    const y = groundAt(p.x, p.z)
    return {
      groundY: y,
      groundAt,
      collision: makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, nearSolids(p.x, p.z)),
    }
  }
  // one handle per body, made once: a grab knocks them down first, so the
  // crowd's tick stops walking a body the ragdoll now owns
  const handles = crowd.map((p, i) => ({
    key: `ped${i}`,
    rig: {
      limbs: p.rig.limbs,
      limbPos: (k: number, out: THREE.Vector3) => p.rig.limbPos(k, out),
      grab: (k: number, target: THREE.Vector3 | null, stiff?: number) => {
        if (target && !p.down) p.down = downEnv(p)
        p.downFor = 0
        p.rig.grab(k, target, stiff)
      },
    },
  }))
  function* grabbable() {
    for (let i = 0; i < crowd.length; i++) if (crowd[i].live) yield handles[i]
  }

  let knocks = 0
  /** hand a body to its ragdoll, in a world of the solids near where it
      fell. Counts it once however many blows land on the heap after */
  const fell = (p: Person) => {
    if (!p.down) {
      p.down = downEnv(p)
      knocks++
      // thrown: its limbs slap the ground when it comes down
      p.airborne = true
    }
    p.downFor = 0
  }

  /** one diagonal pair of limbs bounced up off the ground */
  const limbAt = new THREE.Vector3()
  const slapped = [
    [limbIndex('handL'), limbIndex('footR')],
    [limbIndex('handR'), limbIndex('footL')],
  ]
  function limbIndex(name: string) {
    return crowd.length ? Math.max(0, crowd[0].rig.limbs.findIndex((l) => l.name === name)) : 0
  }
  const slap = (p: Person, pair: number) => {
    for (const i of slapped[pair]) {
      p.rig.limbPos(i, limbAt)
      hit.impulse.set((rnd() - 0.5) * 1.5, SLAP, (rnd() - 0.5) * 1.5).multiplyScalar(p.rig.mass * 0.55)
      p.rig.hit(hit.impulse, limbAt)
    }
  }
  /** a knocked body coming down: its limbs slap the ground and bounce */
  const touchdown = (p: Person, dt: number) => {
    if (p.slapIn >= 0) {
      p.slapIn -= dt
      if (p.slapIn < 0) slap(p, 1)
    }
    if (!p.airborne || !p.rig.ragdolling) return
    p.rig.focus(chest)
    if (chest.y - groundAt(chest.x, chest.z) > p.ext.height * 0.3) return
    p.airborne = false
    slap(p, 0)
    p.slapIn = SLAP_GAP
  }

  const knock = (watch: ImpactWatch) => {
    for (const p of crowd) {
      if (!p.live) continue
      feet.set(p.x, groundAt(p.x, p.z), p.z)
      if (!watch.strike(p.rig, feet, BODY_H, p.rig.mass, hit)) continue
      fell(p)
      p.rig.hit(hit.impulse, hit.point)
    }
  }

  /* ---- bumping into people (player/bodyContact.ts) ---------------------- */
  const chest = new THREE.Vector3()
  const bumpable: Bumpable = {
    get size() {
      return crowd.length
    },
    peer: (i, out) => {
      const p = crowd[i]
      if (!p.live || p.down) return false
      out.x = p.x
      out.z = p.z
      out.feetY = p.y
      out.vx = p.vx
      out.vz = p.vz
      out.radius = p.ext.radius
      out.height = p.ext.height
      return true
    },
    // shoved half the overlap, if there is room behind them: the same wall
    // test their own walk steers by, so a body is never pushed into a shop
    points: (i, out) => {
      const p = crowd[i]
      // read off the skeleton once a tick, relative to where the body
      // stands, so a shove since (which moves the body, not the bones)
      // carries them along
      const g = p.group.position
      if (p.ptsAt !== tick) {
        p.npts = posedPoints(p.rig, g.x, g.y, g.z, p.pts)
        p.ptsAt = tick
      }
      for (let k = 0; k < p.npts * 4; k += 4) {
        out[k] = p.pts[k] + g.x
        out[k + 1] = p.pts[k + 1] + g.y
        out[k + 2] = p.pts[k + 2] + g.z
        out[k + 3] = p.pts[k + 3]
      }
      return p.npts
    },
    nudge: (i, dx, dz) => {
      const p = crowd[i]
      const x = p.x + dx
      const z = p.z + dz
      const y = groundAt(x, z)
      if (blockedAt(x, z, y, y + BODY_H, solids, 0.5)) return false
      p.x = x
      p.z = z
      p.y = y
      p.group.position.set(x, y, z)
      return true
    },
    hit: (i: number, b: Bump) => {
      const p = crowd[i]
      if (b.kind === 'lean') {
        // leaned on: staggered back, and a moment's pause before they walk
        // on, turned a little off whoever is in the way
        if (b.vx !== 0 || b.vz !== 0) {
          p.sx = b.vx
          p.sz = b.vz
        }
        // bumped: and a step out of the walker's line, to whichever side of
        // it they already are, so the two part instead of clinging
        if (b.fresh) {
          const w = Math.hypot(b.wvx, b.wvz)
          if (w > 0.1) {
            const ux = b.wvx / w
            const uz = b.wvz / w
            // their offset from the walker, less its share along the walk
            let ox = -b.nx
            let oz = -b.nz
            const along = ox * ux + oz * uz
            ox -= ux * along
            oz -= uz * along
            const o = Math.hypot(ox, oz)
            if (o > 1e-3) {
              ox /= o
              oz /= o
            } else {
              ox = -uz
              oz = ux
            }
            p.sx += ox * SIDESTEP
            p.sz += oz * SIDESTEP
          }
        }
        if (p.pause <= 0) {
          p.pause = 0.4 + rnd() * 0.5
          const side = fwdX(p.yaw) * -b.nz + fwdZ(p.yaw) * b.nx >= 0 ? 1 : -1
          p.yaw += side * 0.5
          p.settle = 0.8
        }
        return
      }
      fell(p)
      hit.impulse.set(b.vx, b.vy, b.vz).multiplyScalar(p.rig.mass)
      hit.point.set(b.px, b.py, b.pz)
      p.rig.hit(hit.impulse, hit.point)
      p.airborne = b.kind !== 'stomp'
      if (b.kind === 'stomp') {
        // squashed: the hips driven down as well as the head, so the body
        // folds in place instead of tipping over backwards
        hit.impulse.set(0, b.vy * 0.8, 0).multiplyScalar(p.rig.mass)
        hit.point.set(p.x, p.y + p.ext.height * 0.35, p.z)
        p.rig.hit(hit.impulse, hit.point)
        slap(p, 0)
        p.slapIn = SLAP_GAP
      }
    },
    // walked through while lying there: a kick at the chest, along the walk
    trample: (x, z, feetY, vx, vz, radius) => {
      let n = 0
      for (const p of crowd) {
        if (!p.live || !p.down || !p.rig.ragdolling || p.kicked > 0) continue
        p.rig.focus(chest)
        const dx = chest.x - x
        const dz = chest.z - z
        const r = radius + 0.6
        if (dx * dx + dz * dz > r * r || chest.y > feetY + 1.5) continue
        p.kicked = TRAMPLE_EVERY
        p.downFor = Math.min(p.downFor, 1)
        hit.impulse.set(vx * TRAMPLE_K, TRAMPLE_UP, vz * TRAMPLE_K).multiplyScalar(p.rig.mass)
        hit.point.copy(chest)
        p.rig.hit(hit.impulse, hit.point)
        n++
      }
      return n
    },
  }

  const stage = (spots: readonly { x: number; z: number; yaw: number; pause?: number }[]) => {
    crowd.forEach((p, i) => {
      const s = spots[i]
      if (!s) {
        p.live = false
        p.group.visible = false
        return
      }
      p.x = s.x
      p.z = s.z
      p.y = groundAt(s.x, s.z)
      p.yaw = s.yaw
      p.gait = s.pause ? 0 : 1
      p.pause = s.pause ?? 0
      p.settle = 1
      p.live = true
      p.down = null
      p.sx = p.sz = 0
      p.rig.reset()
      p.rig.setLook(look())
      bodyExtent(p.group, p.ext)
      p.rig.face(s.yaw)
      p.group.position.set(s.x, p.y, s.z)
      p.group.rotation.y = p.rig.facing + Math.PI
      p.group.visible = true
    })
    // and nobody from the parked pool is re-cut into the staged street
    retryIn = 1e9
  }

  trackDisposable({
    dispose: () => {
      crowd.length = 0
      root.clear()
    },
  })

  return {
    update, knock, grabbable, bumpable, stage,
    groupOf: (i) => crowd[i]?.group ?? null,
    lying: (i, out) => {
      const p = crowd[i]
      if (!p || !p.live || !p.down) return false
      p.rig.focus(out)
      return true
    },
    get downed() {
      let n = 0
      for (const p of crowd) if (p.live && p.down) n++
      return n
    },
    get knocks() {
      return knocks
    },
  }
}
