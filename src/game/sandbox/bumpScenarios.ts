import * as THREE from 'three'
import { defineScenario, type ScenarioCtx, type Shot } from './scenarios'
import { siteAvenue } from './propScenarios'
import { buildPedestrians, type PedestrianHandles } from '../world/pedestrians'
import { buildPlayerBody, type PlayerPose, type PlayerRig } from '../player/playerBody'
import { createWalkController, type WalkController, type WalkStep } from '../player/walkController'
import {
  bodyExtent, createBodyContact, type BodyContact, type BodyExtent, type Bumpable, type Bumper,
  type ContactReport, type ContactStep,
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
  /** which pedestrian, by staging order; -1 is "the nearest one lying down" */
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
  { who: 2, max: 2.6, jumpAt: 4.4 },
  { who: 3, max: 2, jumpAt: 3.2 },
  { who: -1, max: 1.6 },
]
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
    return { from: along(u - 12, -7, 9.5), to: along(u + 5, 1.5, 1.5), fov: 56 }
  },
  setup: (c) => {
    const scene = c.sb.root.parent
    const holder = new THREE.Group()
    if (scene) scene.add(holder)
    const F = [c.dx, c.dz] as const
    const R = [-c.dz, c.dx] as const
    const at = (u: number, l: number) => ({ x: c.x + F[0] * u + R[0] * l, z: c.z + F[1] * u + R[1] * l })
    // everyone faces back up the street, toward where the walker starts
    const back = Math.atan2(F[0], F[1])
    const spots = [at(7, 0), at(14, 7), at(23, 2), at(21, -5)]
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
    const collision = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 })
    const env: RagdollEnv = { groundY: c.y, groundAt: terrainY, collision }
    const ext: BodyExtent = { radius: 1, height: EYE }
    const run: Run = {
      walk, cam, keys: new Set(), body, peds, contact: createBodyContact(), collision,
      me: { eye: cam.position, feetY: 0, vx: 0, vz: 0, vy: 0, grounded: true, radius: 1, height: EYE },
      ext, t: 0, step: null, spots, memo: { gap: Infinity, leanT: 0, stomps: 0, bounce: 0, trampled: 0 },
      costs: [], how: [],
    }
    runs.set(c, run)
    const target = new THREE.Vector3()
    // the staged body's live position, standing or lying; -1 is whoever
    // is lying down nearest
    const aim = (who: number) => (who >= 0 ? (peerAt(run, who, target) ? target : null) : downedNear(run, target))
    // the crowd, watched: the same object the game hands the pass, with
    // each first knock written down on its way through
    const crowd = peds.bumpable
    const watched: Bumpable = {
      get size() {
        return crowd.size
      },
      peer: crowd.peer,
      nudge: crowd.nudge,
      hit: (i, b) => {
        if (b.kind !== 'lean' && !run.how[i]) run.how[i] = `${b.kind}@${run.t.toFixed(1)}s`
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
      const done = leg && (since > REST + leg.max || (leg.who >= 0 && run.how[leg.who]))
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
    })
  },
  report: (c) => {
    const r = runs.get(c)
    if (!r) return ''
    const s = [...r.costs].sort((a, b) => a - b)
    const med = s.length ? s[Math.floor(s.length / 2)] : 0
    const worst = s.length ? s[s.length - 1] : 0
    const p0 = new THREE.Vector3()
    const moved = peerAt(r, 0, p0) ? Math.hypot(p0.x - r.spots[0].x, p0.z - r.spots[0].z) : NaN
    const how = r.spots.map((_, i) => `#${i} ${r.how[i] ?? 'stood'}`).join(', ')
    return `min gap ${r.memo.gap.toFixed(3)} (under 0 is interpenetration), ${how}; ` +
      `leaned ${r.memo.leanT.toFixed(2)} s and pushed the first ${moved.toFixed(1)}, ` +
      `${r.peds.knocks} knocked flat (${r.memo.stomps} by a stomp, whose bounce peaked ${r.memo.bounce.toFixed(1)} over the road), ` +
      `${r.memo.trampled} trampled, ${r.peds.downed} still down; ` +
      `contact pass ${(med * 1000).toFixed(1)} us median, ${(worst * 1000).toFixed(0)} us worst`
  },
})

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
