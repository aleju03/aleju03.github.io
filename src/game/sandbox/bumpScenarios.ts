import * as THREE from 'three'
import { defineScenario, type ScenarioCtx, type Shot } from './scenarios'
import { siteAvenue } from './propScenarios'
import { buildPedestrians, type PedestrianHandles } from '../world/pedestrians'
import { buildPlayerBody, resetRigSerial, type PlayerPose, type PlayerRig } from '../player/playerBody'
import { createWalkController, type WalkController, type WalkStep } from '../player/walkController'
import {
  MAX_POINTS, bodyExtent, createBodyContact, posedPoints, type BodyContact, type BodyExtent, type Bumpable,
  type Bumper, type ContactReport, type ContactStep,
} from '../player/bodyContact'
import { makeCollisionSet, type CollisionSet } from '../physics/collision'
import type { RagdollEnv } from '../player/ragdoll'
import { terrainY } from '../world/terrain'

/*
  Bumping into people, filmed and measured: `npm run film -- sandbox:bump`
  and `npm run measure -- bodies`.

  One walker, the game's own walk controller and tune, driven by a script of
  keys down a town street where four of the town's real pedestrians
  (`world/pedestrians.ts`, staged with `stage()`) are standing about. It
  walks into the first and leans on it, sprints into the second, jumps and
  comes down on the third, hops into the fourth, and then walks back through
  whoever is lying in the road. Every contact goes through the same
  `player/bodyContact.ts` pass the game runs, one call per 60 Hz slice, and
  the report says what it came to: the smallest gap between two bodies
  while they were in contact (negative would be one inside the other), who
  went down and how, and what the pass cost.

  The walker is steered like a player would be: face whoever the current leg
  is about, hold W (and shift, for the charge), press space at a distance.
  Its targets are read live, because a body leaned on moves.
*/

const EYE = 3.84
/** CrtScene's walk tune, kept in step by hand: this is the walk under test */
const TUNE = {
  eye: EYE, speed: 5.9, runSpeed: 9.4, crouchSpeed: 2.8, crouchDrop: 0.85,
  jumpV: 11.9, grav: 34, step: EYE * 0.12,
}

interface Leg {
  /** which pedestrian, by staging order; -1 is "the nearest one lying down",
      -2 the crates */
  who: number
  /** the longest it lasts, seconds. A leg at somebody standing also ends
      the moment they go down */
  max: number
  run?: boolean
  /** press jump when the two centres are this close */
  jumpAt?: number
}

/** the choreography: one leg after another, a beat apart */
const LEGS: Leg[] = [
  { who: 0, max: 2.1 },
  { who: 1, max: 2, run: true },
  // up onto the crates, then off them onto a head: from flat ground a hop's
  // apex (2.08) never gets the soles over anybody's shoulders
  { who: -2, max: 2, jumpAt: 2.3 },
  { who: 2, max: 2, jumpAt: 6.3 },
  { who: 3, max: 2, jumpAt: 3.2 },
  { who: -1, max: 1.6 },
]
/** the crates' half size: the catalogue's small crate */
const CRATE = 0.72
/** the beat between legs, and before the first */
const REST = 0.35

interface Run {
  walk: WalkController
  cam: THREE.PerspectiveCamera
  keys: Set<string>
  body: PlayerRig
  peds: PedestrianHandles
  contact: BodyContact
  collision: CollisionSet
  me: Bumper
  ext: BodyExtent
  t: number
  step: WalkStep | null
  /** where each staged pedestrian is standing, for the script's aim */
  spots: { x: number; z: number }[]
  memo: Record<string, number>
  costs: number[]
  /** how each staged body first went down, and when */
  how: string[]
}

const runs = new WeakMap<ScenarioCtx, Run>()

/** the report's numbers, readable by a harness after the run */
export const bumpRun = (c: ScenarioCtx) => runs.get(c) ?? null

const pose: PlayerPose = {
  dt: 1 / 60, gait: 0, crouchK: 0, grounded: true, run: false,
  yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
}

defineScenario({
  id: 'sandbox:bump',
  title: 'walking into, charging, landing on and hopping into the town\'s pedestrians',
  site: siteAvenue,
  duration: 10,
  frames: 12,
  camera: (c) => ({
    from: [c.x - c.dx * 6 + c.dz * 14, c.y + 9, c.z - c.dz * 6 - c.dx * 14],
    to: [c.x + c.dx * 11, c.y + 2, c.z + c.dz * 11],
    fov: 55,
  }),
  // a chase lens that rides down the street with the walker, held to the
  // left half of the carriageway so the buildings never come between
  lens: (c): Shot => {
    const r = runs.get(c)
    const u = r ? (r.cam.position.x - c.x) * c.dx + (r.cam.position.z - c.z) * c.dz : 0
    const rx = -c.dz
    const rz = c.dx
    const along = (k: number, l: number, y: number): [number, number, number] =>
      [c.x + c.dx * k + rx * l, c.y + y, c.z + c.dz * k + rz * l]
    return { from: along(u - 12, -7, 9.5), to: along(u + 2, 1, 2), fov: 56 }
  },
  setup: (c) => {
    // the same bodies every staging: a film's stills and its video are two
    // stagings in one page, and each rig's idle is seeded by its serial
    resetRigSerial()
    const scene = c.sb.root.parent
    const holder = new THREE.Group()
    if (scene) scene.add(holder)
    const F = [c.dx, c.dz] as const
    const R = [-c.dz, c.dx] as const
    const at = (u: number, l: number) => ({ x: c.x + F[0] * u + R[0] * l, z: c.z + F[1] * u + R[1] * l })
    // everyone faces back up the street, toward where the walker starts
    const back = Math.atan2(F[0], F[1])
    const spots = [at(7, 0), at(14, 7), at(26.5, 2), at(24, -6)]
    // two small crates end to end along the street, frozen: something to
    // jump off. The walk meets them as one box, like any solid out here
    const crateAt = at(19, 2)
    const crateY = terrainY(crateAt.x, crateAt.z)
    for (const u of [-CRATE, CRATE]) {
      const x = crateAt.x + F[0] * u
      const z = crateAt.z + F[1] * u
      c.sb.spawn('crate_small', { x, y: crateY + CRATE, z }, { frozen: true })
    }
    const crateBox = new THREE.Box3(
      new THREE.Vector3(
        crateAt.x - (Math.abs(F[0]) * 2 + Math.abs(R[0])) * CRATE - 0.3,
        crateY - 1,
        crateAt.z - (Math.abs(F[1]) * 2 + Math.abs(R[1])) * CRATE - 0.3,
      ),
      new THREE.Vector3(
        crateAt.x + (Math.abs(F[0]) * 2 + Math.abs(R[0])) * CRATE + 0.3,
        crateY + CRATE * 2,
        crateAt.z + (Math.abs(F[1]) * 2 + Math.abs(R[1])) * CRATE + 0.3,
      ),
    )
    const peds = buildPedestrians({
      parent: holder,
      obstacles: [],
      groundAt: terrainY,
      trackDisposable: () => {},
    })
    peds.stage(spots.map((s) => ({ ...s, yaw: back, pause: 60 })))

    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 400)
    const walk = createWalkController(cam, TUNE)
    // yaw 0 faces -Z; face down the street
    walk.spawnAt(c.x, c.z, Math.atan2(-F[0], -F[1]), terrainY(c.x, c.z))
    const body = buildPlayerBody(EYE, 34)
    body.showHead(true)
    holder.add(body.group)
    body.face(walk.yaw)
    const collision = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, [crateBox])
    const env: RagdollEnv = { groundY: c.y, groundAt: terrainY, collision }
    const ext: BodyExtent = { radius: 1, height: EYE }
    const run: Run = {
      walk, cam, keys: new Set(), body, peds, contact: createBodyContact(), collision,
      me: {
        eye: cam.position, feetY: 0, vx: 0, vz: 0, vy: 0, grounded: true, radius: 1, height: EYE,
        pts: new Float32Array(MAX_POINTS * 4), npts: 0,
      },
      ext, t: 0, step: null, spots,
      memo: { gap: Infinity, leanT: 0, stomps: 0, bounce: 0, trampled: 0, sunk: 0, mesh: 0, meshAt: 0, recoil: 0 },
      costs: [], how: [],
    }
    runs.set(c, run)
    const target = new THREE.Vector3()
    // the staged body's live position, standing or lying; -1 is whoever
    // is lying down nearest
    const aim = (who: number) =>
      who >= 0 ? (peerAt(run, who, target) ? target : null)
        : who === -2 ? target.set(crateAt.x, 0, crateAt.z)
          : downedNear(run, target)
    // the crowd, watched: the same object the game hands the pass, with
    // each first knock written down on its way through
    const crowd = peds.bumpable
    const watched: Bumpable = {
      get size() {
        return crowd.size
      },
      peer: crowd.peer,
      points: crowd.points,
      nudge: crowd.nudge,
      hit: (i, b) => {
        if (b.kind !== 'lean' && !run.how[i]) {
          run.how[i] = `${b.kind}@${run.t.toFixed(1)}s`
          run.memo[`hitAt${i}`] = run.t
        }
        crowd.hit(i, b)
      },
      trample: crowd.trample,
    }
    const input: ContactStep = {
      me: run.me, push: walk.push, collision, stepUp: 0, sets: [watched], now: 0,
    }

    c.sb.onBeforeSlice((h) => {
      run.t += h
      const t = run.t
      const keys = run.keys
      keys.clear()
      // the script: rest, walk the leg, rest, the next one
      const legNo = run.memo.leg ?? 0
      const leg = LEGS[legNo] as Leg | undefined
      const since = t - (run.memo.legAt ?? 0)
      const onCrate = run.step?.grounded && walk.feetY > crateY + CRATE
      const done = leg && (
        since > REST + leg.max ||
        (leg.who >= 0 && run.how[leg.who]) ||
        (leg.who === -2 && onCrate && since > REST + 0.3)
      )
      if (done) {
        run.memo.leg = legNo + 1
        run.memo.legAt = t
      }
      if (leg && !done && since > REST) {
        // a trample walks straight on through: the heading is taken once,
        // at the body, and held past it
        const held = leg.who < 0 && run.memo.through !== undefined
        const to = held ? target : aim(leg.who)
        if (to) {
          const dx = to.x - cam.position.x
          const dz = to.z - cam.position.z
          if (held) walk.yaw = run.memo.through
          else walk.yaw = Math.atan2(-dx, -dz)
          if (leg.who < 0) run.memo.through = walk.yaw
          keys.add('KeyW')
          if (leg.run) keys.add('ShiftLeft')
          if (leg.jumpAt && Math.hypot(dx, dz) < leg.jumpAt && run.step?.grounded && !run.memo[`j${leg.who}`]) {
            keys.add('Space')
            run.memo[`j${leg.who}`] = 1
          }
        }
      }
      const step = walk.update({
        dt: h, keys, frozen: body.down, groundY: c.y, groundAt: terrainY, collision, fovBase: 60,
      })
      run.step = step
      // the contact pass, exactly as CrtScene runs it
      bodyExtent(body.group, ext)
      const me = run.me
      me.feetY = walk.feetY
      me.vx = step.vx
      me.vz = step.vz
      me.vy = step.vy
      me.grounded = step.grounded
      me.radius = ext.radius
      me.height = ext.height
      const t0 = performance.now()
      input.stepUp = step.grounded ? TUNE.step : 0
      input.now = t
      const rep: ContactReport = run.contact.step(input)
      run.costs.push(performance.now() - t0)
      if (rep.gap < run.memo.gap) run.memo.gap = rep.gap
      if (rep.sunk > run.memo.sunk) run.memo.sunk = rep.sunk
      // the rebound off a knock: how far the walker is carried back along
      // the line it came in on, over the next half second
      if (rep.knocks) {
        run.memo.kAt = t
        run.memo.kx = cam.position.x
        run.memo.kz = cam.position.z
        run.memo.kdx = -step.vx
        run.memo.kdz = -step.vz
      }
      if (t - (run.memo.kAt ?? -9) < 0.6) {
        const k = Math.hypot(run.memo.kdx, run.memo.kdz) || 1
        const back = ((cam.position.x - run.memo.kx) * run.memo.kdx + (cam.position.z - run.memo.kz) * run.memo.kdz) / k
        if (back > run.memo.recoil) run.memo.recoil = back
      }
      if (rep.leans) run.memo.leanT += h
      run.memo.stomps += rep.stomps
      run.memo.trampled += rep.trampled
      // how high a stomp throws the walker: the apex of the second
      // after it, over the ground
      if (rep.stomps) run.memo.stompAt = t
      if (t - (run.memo.stompAt ?? -9) < 1) {
        run.memo.bounce = Math.max(run.memo.bounce, walk.feetY - terrainY(cam.position.x, cam.position.z))
      }
      if (rep.knocks) run.memo[`knock@${t.toFixed(2)}`] = rep.knocks

      // the crowd's own tick, around the walker
      peds.update(cam.position, h)
      // and the walker's body, standing where the walk put it
      body.group.position.set(cam.position.x, walk.feetY, cam.position.z)
      pose.dt = h
      pose.gait = step.gait
      pose.grounded = step.grounded
      pose.run = step.run
      pose.yaw = walk.yaw
      pose.vx = step.vx
      pose.vz = step.vz
      pose.vy = step.vy
      pose.landing = step.landing
      env.groundY = terrainY(cam.position.x, cam.position.z)
      body.update(pose, env)
      body.group.rotation.y = body.facing + Math.PI
      body.group.updateMatrixWorld(true)
      me.npts = body.ragdolling || !me.pts ? 0 : posedPoints(body, cam.position.x, walk.feetY, cam.position.z, me.pts)
      // the honest number: the drawn meshes, posed, against each other's
      // trunk, while both are standing side by side
      // the pop: how far each victim's torso has gone a tenth of a second
      // after the blow (a knock that only topples reads as a hug)
      for (let i = 0; i < spots.length; i++) {
        const at = run.memo[`hitAt${i}`]
        if (at === undefined || run.memo[`pop${i}`] !== undefined) continue
        if (!peds.lying(i, target)) continue
        if (run.memo[`hx${i}`] === undefined) {
          run.memo[`hx${i}`] = target.x
          run.memo[`hy${i}`] = target.y
          run.memo[`hz${i}`] = target.z
        } else if (t - at >= 0.1) {
          run.memo[`pop${i}`] = Math.hypot(
            target.x - run.memo[`hx${i}`], target.y - run.memo[`hy${i}`], target.z - run.memo[`hz${i}`])
        }
      }
      const sunk = meshSunk(run)
      if (sunk > run.memo.mesh) {
        run.memo.mesh = sunk
        run.memo.meshAt = t
      }
    })
  },
  hash: (c) => bumpHash(c),
  report: (c) => {
    const r = runs.get(c)
    if (!r) return ''
    const s = [...r.costs].sort((a, b) => a - b)
    const med = s.length ? s[Math.floor(s.length / 2)] : 0
    const worst = s.length ? s[s.length - 1] : 0
    const p0 = new THREE.Vector3()
    const moved = peerAt(r, 0, p0) ? Math.hypot(p0.x - r.spots[0].x, p0.z - r.spots[0].z) : NaN
    const how = r.spots.map((_, i) => {
      const pop = r.memo[`pop${i}`]
      return `#${i} ${r.how[i] ?? 'stood'}${pop !== undefined ? ` (torso ${pop.toFixed(2)} in 0.1 s)` : ''}`
    }).join(', ')
    return `trunks ${r.memo.gap.toFixed(3)} apart at the closest, posed limbs at most ${r.memo.sunk.toFixed(2)} ` +
      `into a trunk, drawn mesh at most ${r.memo.mesh.toFixed(2)} into a trunk (at ${r.memo.meshAt.toFixed(2)} s); ${how}; ` +
      `rebound ${r.memo.recoil.toFixed(1)} off the charge; ` +
      `leaned ${r.memo.leanT.toFixed(2)} s and pushed the first ${moved.toFixed(1)}, ` +
      `${r.peds.knocks} knocked flat (${r.memo.stomps} by a stomp, whose bounce peaked ${r.memo.bounce.toFixed(1)} over the road), ` +
      `${r.memo.trampled} trampled, ${r.peds.downed} still down; ` +
      `contact pass ${(med * 1000).toFixed(1)} us median, ${(worst * 1000).toFixed(0)} us worst`
  },
})

/*
  How deep one drawn body gets into another. Every fourth vertex of the
  walker's skinned mesh, posed exactly as it will be drawn, against each
  standing pedestrian's trunk cylinder, and the same the other way round.
  A vertex of an arm hanging past a trunk is not inside anybody, so this is
  a trunk measure; what it catches is a head or a fist drawn inside a chest,
  which is what the circles alone missed.
*/
const vtx = new THREE.Vector3()
const skins = new WeakMap<THREE.Object3D, THREE.SkinnedMesh | null>()
const skinOf = (g: THREE.Object3D) => {
  let m = skins.get(g)
  if (m === undefined) {
    m = null
    g.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) m = o as THREE.SkinnedMesh
    })
    skins.set(g, m)
  }
  return m
}
const insideOf = (g: THREE.Object3D, cx: number, cz: number, feet: number, radius: number, height: number) => {
  const mesh = skinOf(g)
  if (!mesh) return 0
  const n = mesh.geometry.getAttribute('position').count
  let worst = 0
  for (let i = 0; i < n; i += 4) {
    mesh.getVertexPosition(i, vtx).applyMatrix4(mesh.matrixWorld)
    if (vtx.y < feet || vtx.y > feet + height) continue
    const pen = radius - Math.hypot(vtx.x - cx, vtx.z - cz)
    if (pen > worst) worst = pen
  }
  return worst
}
const standing = { x: 0, z: 0, feetY: 0, vx: 0, vz: 0, radius: 0, height: 0 }
const meshSunk = (r: Run) => {
  if (r.body.ragdolling) return 0
  let worst = 0
  for (let i = 0; i < r.spots.length; i++) {
    const g = r.peds.groupOf(i)
    if (!g || !r.peds.bumpable.peer(i, standing)) continue
    const d = Math.hypot(standing.x - r.cam.position.x, standing.z - r.cam.position.z)
    if (d > standing.radius + r.me.radius + 3) continue
    // on top of them is a stomp, not a body inside a body
    if (r.walk.feetY > standing.feetY + standing.height * 0.3) continue
    g.updateMatrixWorld(true)
    worst = Math.max(
      worst,
      insideOf(r.body.group, standing.x, standing.z, standing.feetY, standing.radius, standing.height),
      insideOf(g, r.cam.position.x, r.cam.position.z, r.walk.feetY, r.me.radius, r.me.height),
    )
  }
  return worst
}

/** FNV-1a over where everybody is, to the float: the film's state hash */
export const bumpHash = (c: ScenarioCtx) => {
  const r = runs.get(c)
  if (!r) return ''
  const v = new THREE.Vector3()
  const nums = [r.cam.position.x, r.walk.feetY, r.cam.position.z]
  for (let i = 0; i < r.spots.length; i++) {
    if (peerAt(r, i, v)) nums.push(v.x, v.y, v.z)
    else nums.push(NaN)
  }
  const f = new Float32Array(nums)
  const b = new Uint8Array(f.buffer)
  let h = 0x811c9dc5
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0') + '@' + r.t.toFixed(4)
}

/** a staged pedestrian's live position, standing or lying down */
const scratch = { x: 0, z: 0, feetY: 0, vx: 0, vz: 0, radius: 0, height: 0 }
const peerAt = (r: Run, i: number, out: THREE.Vector3) => {
  if (r.peds.bumpable.peer(i, scratch)) {
    out.set(scratch.x, scratch.feetY, scratch.z)
    return true
  }
  return r.peds.lying(i, out)
}

/** whoever is lying down nearest the walker */
const lyingAt = new THREE.Vector3()
const downedNear = (r: Run, out: THREE.Vector3) => {
  let best = Infinity
  for (let i = 0; i < r.spots.length; i++) {
    if (!r.peds.lying(i, lyingAt)) continue
    const d = Math.hypot(lyingAt.x - r.cam.position.x, lyingAt.z - r.cam.position.z)
    if (d < best) {
      best = d
      out.copy(lyingAt)
    }
  }
  return best < Infinity ? out : null
}
