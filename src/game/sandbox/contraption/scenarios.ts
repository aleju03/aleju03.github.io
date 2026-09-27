import * as THREE from 'three'
import { GRAVITY } from '../physics'
import { defineScenario, siteFlat, type Scenario, type ScenarioCtx, type Shot } from '../scenarios'
import { buildCar, buildHover, buildRocket, type Built } from './build'
import { contraptionOf, type Contraption } from './contraption'

/*
  Contraptions, scripted: a car built from parts driven round a field, a
  rocket lifting off, and a hovercraft flown at the Moon's gravity. Each one
  is built by build.ts (the tool gun's own placing and joining) and driven
  through the controller's `input()` with a key set, which is what the scene
  hands it every frame from the real keyboard, so what is filmed and what is
  measured is what a player gets.

    npm run film -- contraption:car      built, then driven: throttle, a right turn, the boost
    npm run film -- contraption:rocket   four thrusters under a beam: lift-off and climb
    npm run film -- contraption:moon     hoverballs up, thrusters on, at a sixth of the gravity
    npm run measure -- physics contraptions   the same three headless, with their numbers

  Each report says how fast it went, how high, and the worst a joint was
  seen to stretch (the distance between an axle's two anchors, which an
  exploding solver makes large long before anything is visibly wrong).
*/

interface Run {
  built: Built
  c: Contraption
  /** the worst joint stretch seen, units */
  stretch: number
  top: number
  apex: number
  start: THREE.Vector3
}
const runs = new WeakMap<ScenarioCtx, Run>()

const pos = new THREE.Vector3()
const q = new THREE.Quaternion()
const tmp = new THREE.Vector3()
const tmp2 = new THREE.Vector3()
const where = (c: ScenarioCtx, id: number, out = pos) => {
  c.sb.getTransform(id, out, q)
  return out
}

/** after every slice: the joint stretch, the top speed, the apex */
const watch = (c: ScenarioCtx, run: Run) => {
  const v = new THREE.Vector3()
  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion()
  c.sb.onAfterSlice(() => {
    for (const k of run.c.constraints()) {
      if (k.type !== 'weld' && k.type !== 'axis') continue
      if (!c.sb.getTransform(k.a, tmp, qa) || !c.sb.getTransform(k.b, tmp2, qb)) continue
      tmp.add(pos.copy(k.anchorA).applyQuaternion(qa))
      tmp2.add(pos.copy(k.anchorB).applyQuaternion(qb))
      run.stretch = Math.max(run.stretch, tmp.distanceTo(tmp2))
    }
    c.sb.getVelocity(run.built.chassis, v)
    run.top = Math.max(run.top, v.length())
    const at = where(c, run.built.chassis)
    run.apex = Math.max(run.apex, at.y - c.sb.groundY(at.x, at.z))
  })
}

const begin = (c: ScenarioCtx, built: Built) => {
  const run: Run = {
    built, c: contraptionOf(c.sb), stretch: 0, top: 0, apex: 0,
    start: where(c, built.chassis).clone(),
  }
  runs.set(c, run)
  watch(c, run)
  return run
}

const keys = (c: ScenarioCtx, codes: string[], seat = true) => {
  const run = runs.get(c)!
  run.c.input(new Set(codes), seat ? run.built.seat : null, Infinity)
}

/** a lens trailing the machine: behind and above it, looking past it */
const chase = (c: ScenarioCtx, back: number, height: number, fov = 55): Shot => {
  const run = runs.get(c)
  if (!run) return { from: [c.x + 20, c.y + 10, c.z + 20], to: [c.x, c.y, c.z], fov }
  const at = where(c, run.built.chassis).clone()
  c.sb.getVelocity(run.built.chassis, tmp)
  tmp.y = 0
  // trail the way it is going, or its own back when it is standing still
  if (tmp.lengthSq() < 4) tmp.set(0, 0, 1).applyQuaternion(q)
  else tmp.normalize().negate()
  return {
    from: [at.x + tmp.x * back + 6, at.y + height, at.z + tmp.z * back + 6],
    to: [at.x - tmp.x * 6, at.y + 1, at.z - tmp.z * 6],
    fov,
  }
}

/** the film's render side: the flames and the ropes, drawn every frame */
const present: Scenario['present'] = (c) => ({
  frame: (_t, dt) => contraptionOf(c.sb).present(dt),
})

const say = (run: Run, extra: string) =>
  `${extra}, top ${run.top.toFixed(1)} u/s, worst joint stretch ${run.stretch.toFixed(3)} u, ` +
  `${run.c.stats.constraints} constraints, ${run.c.stats.parts} parts`

defineScenario({
  id: 'contraption:car',
  title: 'a car built from parts: plate, four wheels on axes, a seat, two thrusters',
  site: siteFlat,
  duration: 8,
  frames: 8,
  camera: (c) => ({ from: [c.x + 16, c.y + 9, c.z + 16], to: [c.x, c.y + 1, c.z], fov: 55 }),
  lens: (c) => chase(c, 16, 8),
  present,
  setup: (c) => {
    begin(c, buildCar(c.sb, { x: c.x, y: c.y, z: c.z }, Math.atan2(-c.dx, -c.dz)))
  },
  events: [
    [0.8, (c) => keys(c, ['KeyW'])],
    [3.0, (c) => keys(c, ['KeyW', 'KeyD'])],
    [4.2, (c) => keys(c, ['KeyW', 'Space'])],
    [6.0, (c) => keys(c, ['KeyS'])],
    [7.0, (c) => keys(c, [])],
  ],
  report: (c) => {
    const run = runs.get(c)!
    const at = where(c, run.built.chassis)
    return say(run, `drove ${Math.hypot(at.x - run.start.x, at.z - run.start.z).toFixed(1)} u`)
  },
})

defineScenario({
  id: 'contraption:rocket',
  title: 'a rocket from parts: a beam on a plate, four thrusters under it',
  site: siteFlat,
  duration: 5,
  frames: 8,
  camera: (c) => ({ from: [c.x + 30, c.y + 8, c.z + 30], to: [c.x, c.y + 8, c.z], fov: 60 }),
  lens: (c) => {
    const run = runs.get(c)
    const y = run ? where(c, run.built.chassis).y : c.y
    return { from: [c.x + 34, c.y + 6 + (y - c.y) * 0.45, c.z + 34], to: [c.x, Math.max(c.y + 6, y + 3), c.z], fov: 60 }
  },
  present,
  setup: (c) => {
    begin(c, buildRocket(c.sb, { x: c.x, y: c.y, z: c.z }))
  },
  events: [
    [0.3, (c) => c.sb.unfreeze(runs.get(c)!.built.chassis)],
    [0.8, (c) => keys(c, ['KeyI'], false)],
  ],
  report: (c) => {
    const run = runs.get(c)!
    return say(run, `apex ${run.apex.toFixed(1)} u over the ground`)
  },
})

defineScenario({
  id: 'contraption:moon',
  title: 'a hovercraft at the Moon\'s gravity: hoverballs lift, thrusters push',
  site: siteFlat,
  duration: 7,
  frames: 8,
  camera: (c) => ({ from: [c.x + 20, c.y + 8, c.z + 20], to: [c.x, c.y + 2, c.z], fov: 55 }),
  lens: (c) => chase(c, 18, 9),
  present,
  setup: (c) => {
    // the Moon's own number: a level at a sixth of the gravity (levels/moon.ts)
    c.sb.gravity = -GRAVITY / 6
    begin(c, buildHover(c.sb, { x: c.x, y: c.y, z: c.z }, Math.atan2(-c.dx, -c.dz)))
  },
  events: [
    // u raises the hoverballs (their default pair), then i fires the thrusters
    [0.6, (c) => keys(c, ['KeyU'], false)],
    [2.2, (c) => keys(c, [], false)],
    [3.0, (c) => keys(c, ['KeyI'], false)],
    [5.5, (c) => keys(c, [], false)],
  ],
  report: (c) => {
    const run = runs.get(c)!
    const at = where(c, run.built.chassis)
    return say(run, `hovering ${(at.y - c.sb.groundY(at.x, at.z)).toFixed(1)} u up (apex ${run.apex.toFixed(1)}), ` +
      `flew ${Math.hypot(at.x - run.start.x, at.z - run.start.z).toFixed(1)} u`)
  },
})
