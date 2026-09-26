/*
  `npm run measure -- physics`: the sandbox's physics core, headless.

  Appended to measure.mjs's prelude (so THREE, buildChunk, MATS, terrainY and
  the rest are in scope) and bundled with the sandbox. The sections, each a
  claim the sandbox makes and the number that holds it to it:

    ground     the heightfields agree with terrainY (the drawn mesh)
    cost       ms per frame with 50 / 200 / 500 props awake
    stack      a 10-high crate stack stands still for 30 s of sim time
    tunnel     fast things do not pass through thin things or the ground
    walker     the walk pushes a crate, is stopped by a block, stands on a
               stack and rides a moving plank
    rest       the forty-prop pile: when its last prop falls asleep
    determinism  every scenario twice, and on uneven frames: same hash?
    float      each kind dropped on the drawn swell: waterline, attitude,
               and whether it is still alive (heave, drift, turn, rock)
               without churning
    physgun    the beam's controller, per kind: settle time and overshoot
               after a sideways step, jitter held still, a flick's throw
               speed, a freeze that holds and a thaw that falls
    catalogue  every catalogue kind set down upright on flat ground: does it
               stay upright, how fast it sleeps, where its mass sits
    breaks     each breakable dropped from rising heights: the lowest fall
               that breaks it, and what it leaves
    blast      a row of red barrels set off at one end: how many go, how
               far a crate beside them flies, and that one out of reach sleeps
    scenarios  every registered scenario, run to its end, with its report
    destruction  the three demolitions (house, tower, wall) in the real
               chunks with their ruins armed: pieces down, rubble, and
               what a frame of the collapse costs (median, p95, worst)
*/
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { SCENARIOS, stageScenario, advanceScenario } from '../../src/game/sandbox/scenarios.ts'
import '../../src/game/sandbox/propScenarios.ts'
import '../../src/game/sandbox/destructionScenarios.ts'
import { attachDestruction } from '../../src/game/sandbox/destruction.ts'
import { historyOf } from '../../src/game/sandbox/history.ts'
import { buildDebris } from '../../src/game/world/debris.ts'
import { CATALOGUE } from '../../src/game/sandbox/catalogue.ts'
import { KINDS } from '../../src/game/sandbox/kinds.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { createWalkController } from '../../src/game/player/walkController.ts'
import { waveHeightAt } from '../../src/game/world/streamer.ts'
import { windUniforms, tickWind } from '../../src/game/world/wind.ts'
import { createPhysgun, tune } from '../../src/game/sandbox/tools/physgun.ts'
import { emptyInput } from '../../src/game/sandbox/tools/types.ts'
// the physgun's films register themselves as scenarios too
import '../../src/game/sandbox/tools/scenarios.ts'

const only = process.argv[2]
const want = (s) => !only || only === s

// the world's own solids, built on demand like the streamer would
const chunkCache = new Map()
const chunkSolids = (cx, cz) => {
  const k = cx + ',' + cz
  let c = chunkCache.get(k)
  if (!c) {
    c = buildChunk(cx, cz, 'full', MATS)
    for (const g of c.geos) g.dispose()
    chunkCache.set(k, c)
  }
  return c.boxes
}
// the drawn swell, on the same clock the film runs it on: the wave's time
// starts at zero with each sandbox and moves one slice per slice, so the sea
// here is the sea in the pictures, crest for crest
// `walker: false` is how the film stages a scenario (nobody walks in it),
// and it matters to the bit: the walker's kinematic capsule is one more
// body in the world, and a pile near where it waits settles differently
const newSandbox = (withSolids = true, walker = true) => {
  const collision = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, [])
  windUniforms.uTime.value = 0
  const sb = createSandbox({
    collision, waterY: () => SEA_Y, waveAt: waveHeightAt, chunkSolids: withSolids ? chunkSolids : undefined, walker,
  })
  sb.onAfterSlice((h) => tickWind(h))
  return { sb, collision }
}
const flat = SCENARIOS.find((s) => s.id === 'sandbox:stack').site()
const fy = terrainY(flat.x, flat.z)
console.log(`flat site ${Math.round(flat.x)},${Math.round(flat.z)}, slope ${slopeAt(flat.x, flat.z).toFixed(4)}`)
const pad = (s, n) => String(s).padEnd(n)
const DESTRUCTION = ['sandbox:demolish-house', 'sandbox:tower', 'sandbox:wall']
const f = (n, d = 3) => n.toFixed(d)

/* ------------------------------------------------------------- ground -- */
if (want('ground')) {
  // no solids, so every ray lands on a heightfield
  const { sb } = newSandbox(false)
  await sb.whenReady
  const R = sb.rapier
  let worst = 0
  let n = 0
  let seed = 99
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  // hills, the town, the coast: wherever the lattice is doing something
  for (const [x0, z0] of [[flat.x, flat.z], [200, -200], [0, -340], [-900, 400], [1500, 1200]]) {
    for (let i = 0; i < 400; i++) {
      const x = x0 + (rnd() - 0.5) * 120
      const z = z0 + (rnd() - 0.5) * 120
      // one real slice: Rapier's queries only see a new collider once the
      // broad phase has been stepped over it
      sb.tick({ dt: 1 / 60, active: true, focus: { x, y: 0, z } })
      const hit = sb.physics.world.castRay(new R.Ray({ x, y: 400, z }, { x: 0, y: -1, z: 0 }), 1000, true,
        undefined, (0xffff << 16) | 1)
      if (!hit) continue
      const y = 400 - hit.timeOfImpact
      worst = Math.max(worst, Math.abs(y - terrainY(x, z)))
      n++
    }
  }
  console.log(`ground   ${n} rays vs terrainY: worst disagreement ${worst.toExponential(2)} units ` +
    (worst < 1e-3 ? '(agrees)' : '<-- MISMATCH'))
  sb.dispose()
}

/* --------------------------------------------------------------- cost -- */
if (want('cost')) {
  // the solids under the field, built before anything is timed: in the game
  // they come from chunks the streamer built long ago, and here the first
  // touch of each one is a full buildChunk (5-20 ms) that would otherwise
  // land inside a "physics" frame. (The 50 ms first frame the first round
  // reported was something else, and real: V8 compiling Rapier's WASM on
  // its first step. physics.ts's warmUp pays it at load now; this frame 0
  // is the number that keeps it honest)
  for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
    chunkSolids(chunkX(flat.x) + dx, chunkZ(flat.z) + dz)
  }
  for (const count of [50, 200, 500]) {
    const { sb } = newSandbox()
    await sb.whenReady
    const kinds = ['crate', 'barrel', 'ball', 'plank', 'cone', 'crate', 'barrel', 'block']
    const focus = { x: flat.x, y: fy, z: flat.z }
    const side = Math.ceil(Math.sqrt(count / 4))
    for (let i = 0; i < count; i++) {
      const layer = Math.floor(i / (side * side))
      const j = i % (side * side)
      const x = flat.x + ((j % side) - side / 2) * 3.4
      const z = flat.z + (Math.floor(j / side) - side / 2) * 3.4
      sb.spawn(kinds[i % kinds.length], { x, y: fy + 3 + layer * 3.2, z }, { yaw: i })
    }
    // the ground and the solids under the pile are built on the first frame,
    // which is the streamer's cost in the game, not this one's
    sb.tick({ dt: 0, active: true, focus })
    // how much of a frame is Rapier's own step, as against this module
    const world = sb.physics.world
    const step = world.step.bind(world)
    let stepMs = 0
    world.step = (q) => {
      const t = performance.now()
      step(q)
      stepMs += performance.now() - t
    }
    // piling: the first two seconds, everything landing on everything
    const frames = []
    for (let i = 0; i < 120; i++) frames.push(sb.tick({ dt: 1 / 60, active: true, focus }).ms)
    const pile = frames.reduce((a, b) => a + b, 0) / frames.length
    const awakeAfter = sb.stats.awake
    // held awake: every body kept out of sleep, resting on each other, the
    // steady worst case of a pile being poked
    const held = []
    for (let i = 0; i < 120; i++) {
      sb.forEach((p) => p.body.wakeUp())
      held.push(sb.tick({ dt: 1 / 60, active: true, focus }).ms)
    }
    const hold = held.reduce((a, b) => a + b, 0) / held.length
    const stepShare = stepMs / (frames.length + held.length)
    const peak = Math.max(...frames, ...held)
    const at = [...frames, ...held].indexOf(peak)
    console.log(`cost     ${pad(count + ' props', 10)} piling ${f(pile, 2)} ms/frame, held awake ${f(hold, 2)} ms/frame, ` +
      `worst frame ${f(peak, 2)} (frame ${at}), Rapier's step ${f(stepShare, 2)} of it (awake after 2 s: ${awakeAfter})`)
    sb.dispose()
  }
}

/* -------------------------------------------------------------- stack -- */
if (want('stack')) {
  for (const hold of [false, true]) {
    const { sb } = newSandbox()
    await sb.whenReady
    const focus = { x: flat.x, y: fy, z: flat.z }
    const base = sb.restY('crate', flat.x, flat.z)
    const ids = []
    for (let i = 0; i < 10; i++) ids.push(sb.spawn('crate', { x: flat.x, y: base + i * 2.4, z: flat.z }))
    const top = sb.get(ids[9])
    // one second to settle onto the lattice (a heightfield is never quite a
    // plane, so the base tilts by a fraction of a degree), then 30 s watched
    for (let i = 0; i < 60; i++) sb.tick({ dt: 1 / 60, active: true, focus })
    const t0 = top.body.translation()
    let maxV = 0
    for (let i = 0; i < 60 * 30; i++) {
      if (hold) sb.forEach((p) => p.body.wakeUp())
      sb.tick({ dt: 1 / 60, active: true, focus })
      if (i > 30) for (const id of ids) {
        const v = sb.get(id).body.linvel()
        maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z))
      }
    }
    const t1 = top.body.translation()
    const drift = Math.hypot(t1.x - t0.x, t1.z - t0.z)
    const sag = t0.y - t1.y
    const asleep = ids.filter((id) => sb.get(id).body.isSleeping()).length
    // held awake is a stress the game never applies (a stack at rest sleeps),
    // so it is allowed a creep of two centimetres over the half minute
    const ok = drift < (hold ? 0.05 : 0.02) && maxV < 0.1
    console.log(`stack    10 crates, settled, then 30 s ${hold ? 'held awake' : 'sleeping on '}: top drifted ${f(drift, 4)} sideways, ` +
      `settled ${f(sag, 4)}, max speed ${f(maxV, 4)} u/s, ${asleep}/10 asleep ` + (ok ? '(still)' : '<-- MOVING'))
    sb.dispose()
  }
}

/* ------------------------------------------------------------- tunnel -- */
if (want('tunnel')) {
  const { sb } = newSandbox()
  await sb.whenReady
  const focus = { x: flat.x, y: fy, z: flat.z }
  // a crate or a plank that hits hard enough comes apart (breakables.ts):
  // that is the wall holding, and where the gibs ended up says so
  const broke = new Map()
  sb.onBreak((e) => broke.set(e.id, e))
  const run = (label, setup, ok) => {
    sb.clear()
    const c = setup()
    for (let i = 0; i < 90; i++) sb.tick({ dt: 1 / 60, active: true, focus })
    const pass = ok(c)
    console.log(`tunnel   ${pad(label, 52)} ${pass ? (broke.has(c) ? 'held (broke on it)' : 'held') : '<-- TUNNELLED'}`)
  }
  // a plank frozen upright as a 0.18-thick wall
  const wall = () => sb.spawn('plank', { x: flat.x + 10, y: fy + 3, z: flat.z }, {
    frozen: true, quaternion: { x: 0.5, y: 0.5, z: 0.5, w: 0.5 },
  })
  for (const [kind, speed] of [['crate', 150], ['ball', 200], ['plank', 150], ['cone', 180]]) {
    run(`${kind} at ${speed} u/s into a 0.18-thick frozen plank`, () => {
      wall()
      const q = kind === 'plank' ? { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } : undefined
      return sb.spawn(kind, { x: flat.x - 10, y: fy + 3, z: flat.z }, { velocity: { x: speed, y: 0, z: 0 }, quaternion: q })
    }, (id) => {
      const p = sb.get(id)
      if (!p) return !!broke.get(id) && broke.get(id).x < flat.x + 10
      return p.body.translation().x < flat.x + 10
    })
  }
  for (const kind of ['crate', 'ball', 'plank']) {
    run(`${kind} dropped at 250 u/s straight into the ground`, () =>
      sb.spawn(kind, { x: flat.x, y: fy + 30, z: flat.z }, { velocity: { x: 0, y: -250, z: 0 } }),
    (id) => {
      const p = sb.get(id)
      if (!p) return !!broke.get(id) && broke.get(id).y > fy - 0.5
      return p.body.translation().y > fy - 0.5
    })
  }
  sb.dispose()
}

/* ---------------------------------------------------------- catalogue -- */
if (want('catalogue')) {
  // each kind stood upright a hair over flat ground and watched for four
  // seconds: a well-made kind lands, stays the way up it was drawn, and sleeps
  const { sb } = newSandbox()
  await sb.whenReady
  const focus = { x: flat.x, y: fy, z: flat.z }
  const up = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const bad = []
  for (const e of CATALOGUE) {
    sb.clear()
    const y = sb.restY(e.id, flat.x, flat.z)
    const id = sb.spawn(e.id, { x: flat.x, y: y + 0.05, z: flat.z })
    const p = sb.get(id)
    let sleptAt = -1
    for (let i = 0; i < 240; i++) {
      sb.tick({ dt: 1 / 60, active: true, focus })
      if (sleptAt < 0 && p.body.isSleeping()) sleptAt = (i + 1) / 60
    }
    const r = p.body.rotation()
    q.set(r.x, r.y, r.z, r.w)
    up.set(0, 1, 0).applyQuaternion(q)
    const tilt = Math.acos(Math.min(1, up.y)) * 180 / Math.PI
    const t = p.body.translation()
    const com = p.body.localCom()
    const k = KINDS[e.id]
    // round things lying down turn about their own axis as they settle;
    // for those, "upright" is only whether they came to rest
    const round = e.id === 'pipe' || e.id === 'ball'
    const note = tilt > 5 && !round ? '  <-- FELL OVER'
      : sleptAt < 0 && round ? '  (still rolling down the site\'s slope)'
        : sleptAt < 0 ? '  <-- NEVER SLEPT' : ''
    if (note.startsWith('  (')) {
      console.log(`catalogue ${pad(e.id, 17)} ${pad(k.mass + ' kg', 8)} rolling at ${f(Math.hypot(p.body.linvel().x, p.body.linvel().z), 2)} u/s${note}`)
      continue
    }
    if (note) bad.push(e.id)
    console.log(`catalogue ${pad(e.id, 17)} ${pad(k.mass + ' kg', 8)} com y ${f(com.y, 2).padStart(5)}  ` +
      `tilt ${f(tilt, 1).padStart(4)} deg  sank ${f(y - t.y, 3)}  asleep at ${sleptAt < 0 ? '-' : f(sleptAt, 2)} s` +
      `  ${k.surface ?? 'wood'}${k.breaks ? ' breaks@' + k.breaks.speed : ''}${k.explodes ? ' explodes@' + k.explodes.speed : ''}${note}`)
  }
  console.log(`catalogue ${CATALOGUE.length} kinds, ${bad.length ? bad.join(', ') + ' misbehaved' : 'every one upright and asleep'}`)
  sb.dispose()
}

/* -------------------------------------------------------------- breaks -- */
if (want('breaks')) {
  const { sb } = newSandbox()
  await sb.whenReady
  const focus = { x: flat.x, y: fy, z: flat.z }
  let gibs = 0
  sb.onBreak((e) => (gibs = e.gibs.length))
  for (const e of CATALOGUE.filter((c) => KINDS[c.id].breaks)) {
    let at = -1
    let left = 0
    for (const h of [0.5, 1, 2, 3, 4, 6, 8, 10, 13, 16, 20, 25, 30, 40]) {
      sb.clear()
      gibs = 0
      const id = sb.spawn(e.id, { x: flat.x, y: sb.restY(e.id, flat.x, flat.z) + h, z: flat.z })
      for (let i = 0; i < 120; i++) sb.tick({ dt: 1 / 60, active: true, focus })
      if (!sb.get(id)) {
        at = h
        left = gibs
        break
      }
    }
    console.log(`breaks   ${pad(e.id, 12)} breaks at ${KINDS[e.id].breaks.speed} u/s: dropped from ${at < 0 ? 'over 40' : at} units it comes apart into ${left} pieces`)
  }
  sb.dispose()
}

/* --------------------------------------------------------------- blast -- */
if (want('blast')) {
  const { sb } = newSandbox()
  await sb.whenReady
  const focus = { x: flat.x, y: fy, z: flat.z }
  const barrels = []
  for (let k = 0; k < 6; k++) {
    const x = flat.x + k * 5.2
    barrels.push(sb.spawn('barrel_explosive', { x, y: sb.restY('barrel_explosive', x, flat.z), z: flat.z }))
  }
  const near = sb.spawn('crate', { x: flat.x + 2.6, y: sb.restY('crate', flat.x + 2.6, flat.z + 3.5), z: flat.z + 3.5 })
  const far = sb.spawn('crate', { x: flat.x - 30, y: sb.restY('crate', flat.x - 30, flat.z), z: flat.z })
  for (let i = 0; i < 60; i++) sb.tick({ dt: 1 / 60, active: true, focus })
  const booms = []
  let t = 0
  sb.onExplosion((e) => booms.push({ t, x: e.x, y: e.y - terrainY(e.x, e.z), z: e.z, pushed: e.pushed }))
  let nearTop = 0
  sb.damage(barrels[0], 1000)
  const ms = []
  for (let i = 0; i < 300; i++) {
    t = (i + 1) / 60
    ms.push(sb.tick({ dt: 1 / 60, active: true, focus }).ms)
    const p = sb.get(near)
    if (p) nearTop = Math.max(nearTop, p.body.translation().y - fy)
  }
  const farP = sb.get(far)
  ms.sort((a, b) => a - b)
  console.log(`blast    ${booms.length}/6 barrels went off in ${f(booms.length ? booms[booms.length - 1].t : 0, 2)} s ` +
    `(${booms.map((b) => f(b.t, 2) + ' s at ' + f(b.y, 1) + ' up').join(', ')}); the crate beside the first ${sb.get(near) ? 'survived' : 'broke'}, ` +
    `peak ${f(nearTop, 1)} units up; the one 30 units away ${farP && farP.body.isSleeping() ? 'slept through it' : 'moved'}; ` +
    `${sb.stats.gibs} gibs; worst tick ${f(ms[ms.length - 1], 2)} ms, median ${f(ms[ms.length >> 1], 2)}`)
  sb.dispose()
}

/* ------------------------------------------------------------- walker -- */
if (want('walker')) {
  const { sb, collision } = newSandbox()
  await sb.whenReady
  const cam = new THREE.PerspectiveCamera()
  const EYE = 3.84
  const walk = createWalkController(cam, {
    eye: EYE, speed: 5.9, runSpeed: 9.4, crouchSpeed: 2.8, crouchDrop: 0.85,
    jumpV: 11.9, grav: 34, step: EYE * 0.12,
  })
  const keys = new Set()
  const drive = (seconds) => {
    let last
    for (let i = 0; i < seconds * 60; i++) {
      last = walk.update({
        dt: 1 / 60, keys, frozen: false, groundY: 0, groundAt: terrainY, waterY: SEA_Y,
        collision, fovBase: 70,
      })
      sb.tick({
        dt: 1 / 60, active: true,
        walker: { eye: cam.position, feetY: walk.feetY, vx: last.vx, vz: last.vz, grounded: last.grounded, step: EYE * 0.12 },
      })
    }
    return last
  }
  const place = (x, z) => {
    walk.spawnAt(x, z, 0, terrainY(x, z))
    walk.resetMotion()
  }
  const at = (id) => sb.get(id).body.translation()
  // yaw 0 faces -z; walk north into each prop from 8 units south
  const x0 = flat.x
  const z0 = flat.z
  for (const kind of ['crate', 'barrel', 'block']) {
    sb.clear()
    const id = sb.spawn(kind, { x: x0, y: sb.restY(kind, x0, z0 - 6), z: z0 - 6 })
    drive(0.5)
    const before = at(id)
    const pz0 = cam.position.z
    place(x0, z0)
    keys.clear()
    keys.add('KeyW')
    drive(2.5)
    keys.clear()
    const after = at(id)
    const moved = Math.hypot(after.x - before.x, after.z - before.z)
    const inside = sb.get(id).body.translation()
    const gap = Math.hypot(cam.position.x - inside.x, cam.position.z - inside.z)
    console.log(`walker   walked 2.5 s into a ${pad(kind, 7)} (${sb.get(id).mass} kg): it moved ${f(moved, 2)} units, ` +
      `walker ended ${f(gap, 2)} from its centre${pz0 ? '' : ''}`)
  }
  // stand on a two-high stack, dropped onto it from above
  sb.clear()
  place(x0 + 20, z0)
  drive(0.2)
  const base = sb.restY('crate', x0, z0 - 4)
  sb.spawn('crate', { x: x0, y: base, z: z0 - 4 })
  const hi = sb.spawn('crate', { x: x0, y: base + 2.4, z: z0 - 4 })
  drive(1)
  const hi0 = at(hi)
  // dropped onto the top from above, the way a jump lands
  walk.teleport(x0, z0 - 4, terrainY(x0, z0 - 4) + 7)
  const st = drive(2)
  const hi1 = at(hi)
  console.log(`walker   dropped onto a two-crate stack: feet ${f(walk.feetY - (hi1.y + 1.2), 3)} from its top ` +
    `(${f(walk.feetY - terrainY(x0, z0 - 4), 2)} over the ground), grounded ${st.grounded}, ` +
    `the stack moved ${f(Math.hypot(hi1.x - hi0.x, hi1.y - hi0.y, hi1.z - hi0.z), 3)} under the landing`)
  // walk off it: the walker must step down, not hang in the air
  keys.add('KeyW')
  drive(1.5)
  keys.clear()
  drive(1)
  console.log(`walker   walked off the stack: feet ${f(walk.feetY - terrainY(cam.position.x, cam.position.z), 3)} over the ground`)
  // ride a plank being dragged sideways
  sb.clear()
  const pl = sb.spawn('plank', { x: x0, y: terrainY(x0, z0) + 0.2, z: z0 })
  drive(0.5)
  const pt = at(pl)
  walk.spawnAt(pt.x, pt.z, 0, pt.y + 0.09)
  walk.resetMotion()
  const rideStart = { x: cam.position.x, z: cam.position.z }
  sb.setMode(pl, 'kinematic')
  let t = 0
  const off = sb.onBeforeSlice((h) => {
    t += h
    sb.moveKinematic(pl, { x: pt.x + t * 3, y: pt.y, z: pt.z })
  })
  drive(2)
  off()
  const plEnd = at(pl)
  console.log(`walker   rode a plank dragged 6 units: walker moved ${f(cam.position.x - rideStart.x, 2)}, ` +
    `plank moved ${f(plEnd.x - pt.x, 2)}, feet ${f(walk.feetY - (plEnd.y + 0.09), 3)} over it`)
  sb.dispose()
}

/* -------------------------------------------------------------- sites -- */
if (want('sites')) {
  // where each scenario stages itself, and how long finding it took
  for (const s of SCENARIOS) {
    const t0 = performance.now()
    const site = s.site()
    console.log(`site     ${pad(s.id, 16)} ${Math.round(site.x)},${Math.round(site.z)}  facing ${f(site.dx, 2)},${f(site.dz, 2)}` +
      `  ${site.memo ? JSON.stringify(site.memo) : ''}  (${Math.round(performance.now() - t0)} ms)`)
  }
}

/* --------------------------------------------------------------- rest -- */
if (want('rest')) {
  // the pile, run long: when does the last prop fall asleep? Round two's
  // film had a barrel still spinning in place at 20 s with 7/40 awake.
  // Listed per kind (the last of each to sleep), and anything still awake at
  // the end with its speed and spin
  const s = SCENARIOS.find((o) => o.id === 'sandbox:pile')
  const { sb } = newSandbox()
  await sb.whenReady
  const c = stageScenario(s, sb)
  const lastOf = {}
  let allAt = null
  let quietAt = null
  const awakeAt = {}
  advanceScenario(s, c, 30, (t) => {
    let awake = 0
    sb.forEach((p) => {
      if (p.mode !== 'dynamic' || p.body.isSleeping()) return
      awake++
      lastOf[p.kind.id] = t
    })
    for (const k of [5, 10, 15, 20]) if (Math.abs(t - k) < 1e-6) awakeAt[k] = awake
    if (awake <= 2 && quietAt === null && t > 3) quietAt = t
    // the first moment the whole pile is still. (Broken crates' gibs are
    // cleared a few seconds later, and the pile shifts into the gaps they
    // leave and sleeps again; that is catalogue housekeeping, not a prop
    // that would not settle)
    if (awake === 0 && allAt === null) allAt = t
  })
  const rows = []
  sb.forEach((p) => {
    if (p.body.isSleeping() || p.mode !== 'dynamic') return
    const v = p.body.linvel()
    const w = p.body.angvel()
    rows.push(`${p.kind.id} v ${f(Math.hypot(v.x, v.y, v.z), 3)} w ${f(Math.hypot(w.x, w.y, w.z), 3)}`)
  })
  console.log(`rest     pile of 40: awake at 5/10/15/20 s ${[5, 10, 15, 20].map((k) => awakeAt[k]).join('/')}, ` +
    `2 or fewer awake from ${quietAt === null ? 'never' : f(quietAt, 2) + ' s'}, ` +
    `all asleep at ${allAt === null ? 'never <-- ' + rows.join('; ') : f(allAt, 2) + ' s'}` +
    (rows.length ? `, awake at 30 s <-- ${rows.join('; ')}` : ', all asleep at 30 s'))
  console.log(`         last awake by kind, gib clear-up included: ${Object.entries(lastOf).sort((a, b) => b[1] - a[1]).map(([k, t]) => `${k} ${f(t, 1)} s`).join(', ')}`)
  sb.dispose()
}

/* -------------------------------------------------------- determinism -- */
if (want('determinism')) {
  // every scenario, staged twice in this process on fresh sandboxes, must
  // end with the same state to the bit (sb.stateHash: every prop's pose and
  // velocity, and the clock). The hash is the same one `npm run film` prints
  // under each sheet, so a browser run can be held against this one too.
  // A third run feeds the same simulated time as uneven frames (a 144 Hz
  // panel with hitches): the slices are fixed, so only when they land
  // relative to the frames changes, and a scenario with no per-frame input
  // must still end identically
  for (const s of SCENARIOS) {
    const hashes = []
    for (let run = 0; run < 3; run++) {
      const { sb } = newSandbox(true, false)
      await sb.whenReady
      const c = stageScenario(s, sb)
      if (run < 2) advanceScenario(s, c, s.duration)
      else {
        const focus = { x: c.x, y: c.y, z: c.z }
        const end = Math.round(s.duration * 60)
        // a timed event is an input, and the claim is only that the same
        // inputs at the same slice give the same world: advanceScenario fires
        // one between frames, ahead of the slice that crosses its moment, so
        // this does too, and never lets a frame carry past that slice
        // (the slice is found on advanceScenario's own summed clock, so a
        // moment that lands on a boundary rounds the same way it does there)
        const sliceOf = (at) => {
          let t = 0
          for (let i = 0; ; i++) {
            const t1 = t + 1 / 60
            if (at > t && at <= t1) return i
            t = t1
            if (i > 1e6) return -1
          }
        }
        const due = (s.events ?? []).map(([at, fn]) => [sliceOf(at), fn])
        const fired = new Set()
        const pattern = [1 / 144, 1 / 144, 1 / 144, 1 / 30, 1 / 144, 1 / 90, 1 / 60]
        let k = 0
        for (;;) {
          const S = Math.round(sb.stats.time * 60)
          due.forEach(([n, fn], i) => {
            if (n <= S && !fired.has(i)) {
              fired.add(i)
              fn(c)
            }
          })
          if (S >= end) break
          const next = Math.min(end, ...due.filter((_, i) => !fired.has(i)).map(([n]) => n))
          // near a boundary that matters, one slice at a time, feeding
          // exactly what the accumulator still needs
          const dt = next - S <= 3 ? (1 - sb.physics.alpha) / 60 + 1e-12 : pattern[k++ % pattern.length]
          sb.tick({ dt, active: true, focus })
          c.memo.t = sb.stats.time
        }
      }
      hashes.push(sb.stateHash())
      sb.dispose()
    }
    const same = hashes[0] === hashes[1]
    const uneven = hashes[2] === hashes[0]
    console.log(`determ   ${pad(s.id, 16)} ${hashes[0]}  rerun ${same ? 'identical' : '<-- DIVERGED ' + hashes[1]}, ` +
      `uneven frames ${uneven ? 'identical' : '<-- differ ' + hashes[2]}`)
  }
}

/* -------------------------------------------------------------- float -- */
if (want('float')) {
  // each kind dropped tilted into open water on the drawn swell, one at a
  // time, and watched for fourteen seconds. The first line is how it rides:
  // its waterline, how it lies ("flat" is the angle from the nearest face-on
  // orientation, so 0 is a crate riding level and 45 one on an edge) and
  // when the tumbling of its fall stopped. The second is whether it is still
  // alive from 6 s on, which is where round two's props went dead: heave
  // (peak to peak), drift speed, how far it turned, how much it rocks, the
  // fastest it spun (churn) and whether it ever slept
  const sea = SCENARIOS.find((s) => s.id === 'sandbox:float').site()
  const upOf = (q) => {
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w)
    let best = 90
    let axis = null
    for (const ax of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
      const w = ax.clone().applyQuaternion(quat)
      const d = Math.acos(Math.min(1, Math.abs(w.y))) * 180 / Math.PI
      if (d < best) {
        best = d
        axis = w
      }
    }
    return { flat: best, axis }
  }
  for (const kind of ['crate', 'barrel', 'ball', 'plank', 'cone', 'block']) {
    const { sb } = newSandbox(false)
    await sb.whenReady
    const focus = { x: sea.x, y: SEA_Y, z: sea.z }
    const id = sb.spawn(kind, { x: sea.x, y: SEA_Y + 4, z: sea.z }, {
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0.3, 0.35)),
      angular: { x: 0.8, y: 0.4, z: -0.6 },
    })
    const p = sb.get(id)
    let settled = 0
    let churn = 0
    let yMin = Infinity
    let yMax = -Infinity
    let tiltMin = Infinity
    let tiltMax = -Infinity
    let turned = 0
    let lastYaw = null
    let slept = 0
    let x6 = 0
    let z6 = 0
    for (let i = 0; i < 60 * 14; i++) {
      sb.tick({ dt: 1 / 60, active: true, focus })
      const w = p.body.angvel()
      const spin = Math.hypot(w.x, w.y, w.z)
      if (spin > 0.6) settled = (i + 1) / 60
      const t = p.body.translation()
      if (i === 360) {
        x6 = t.x
        z6 = t.z
      }
      if (i >= 360) {
        churn = Math.max(churn, spin)
        yMin = Math.min(yMin, t.y)
        yMax = Math.max(yMax, t.y)
        const u = upOf(p.body.rotation())
        tiltMin = Math.min(tiltMin, u.flat)
        tiltMax = Math.max(tiltMax, u.flat)
        // heading: the body's local x (or z) carried into the world, flattened
        const q = p.body.rotation()
        const fx = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
        const yaw = Math.atan2(fx.z, fx.x)
        if (lastYaw !== null) {
          let d = yaw - lastYaw
          d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI
          turned += Math.abs(d)
        }
        lastYaw = yaw
        if (p.body.isSleeping()) slept++
      }
    }
    const t = p.body.translation()
    const { flat } = upOf(p.body.rotation())
    const e = p.extents
    const drift = Math.hypot(t.x - x6, t.z - z6) / 8
    const sunk = t.y < SEA_Y - e.y * 1.2
    console.log(`float    ${pad(kind, 7)} centre ${f(t.y - SEA_Y, 2).padStart(6)} over the water ` +
      `(half-height ${f(e.y, 2)}), ${f(flat, 0).padStart(2)} deg off a face, fall stopped tumbling at ${f(settled, 1)} s`)
    const alive = sunk || (yMax - yMin > 0.08 && drift > 0.1 && turned * 180 / Math.PI > 15 && slept === 0)
    console.log(`         ${pad('', 7)} 6-14 s: heave ${f(yMax - yMin, 2)} p-p, drift ${f(drift, 2)} u/s, ` +
      `turned ${f(turned * 180 / Math.PI, 0)} deg, rocks ${f(tiltMax - tiltMin, 1)} deg p-p, ` +
      `churn <= ${f(churn, 2)} rad/s, asleep ${slept} slices ` +
      (sunk ? '(sunk, rests on the bottom)' : alive && churn < 1.2 ? '(alive)' : churn >= 1.2 ? '<-- CHURNING' : '<-- DEAD'))
    sb.dispose()
  }
}

/* ---------------------------------------------------------- scenarios -- */
/* ------------------------------------------------------------ physgun -- */
if (want('physgun')) {
  const H = 1 / 60
  const onlyScn = process.env.SCN
  for (const kind of ['ball', 'cone', 'plank', 'barrel', 'crate', 'block']) {
    const { sb } = newSandbox()
    await sb.whenReady
    const x0 = flat.x
    const z0 = flat.z
    const focus = { x: x0, y: fy, z: z0 }
    const id = sb.spawn(kind, { x: x0, y: sb.restY(kind, x0, z0), z: z0 })
    for (let i = 0; i < 30; i++) sb.tick({ dt: H, active: true, focus })
    // the holder stands ten units south, looking north at the prop
    const eye = new THREE.Vector3(x0, fy + 3.84, z0 + 10)
    const dir = new THREE.Vector3()
    const aim = { eye, dir, yaw: 0 }
    const gun = createPhysgun({ sb })
    const inp = emptyInput(aim)
    inp.dt = H
    inp.fire = true
    let yaw = 0
    let pitch = 0
    const look = () => dir.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    const frame = () => {
      aim.yaw = yaw
      look()
      gun.update(inp)
      sb.tick({ dt: H, active: true, focus })
      gun.sync()
    }
    const t0 = sb.get(id).body.translation()
    pitch = Math.atan2(t0.y - eye.y, 10)
    frame()
    if (!gun.holding) {
      const rh = sb.raycast(eye, dir, 100)
      console.log(`physgun  ${pad(kind, 7)} NOT GRABBED (view ${gun.view.mode}, facade ray ${rh ? f(rh.distance, 2) + (rh.prop ? ' prop' : ' not a prop') : 'none'})`)
      sb.dispose()
      continue
    }
    // lift to eye height and let it settle
    for (let i = 0; i < 90; i++) {
      pitch += (0 - pitch) * 0.1
      frame()
    }
    for (let i = 0; i < 90; i++) frame()
    // the step: the aim swings six units sideways in a tenth of a second,
    // a quick hand rather than a teleport (a teleported target has an
    // infinite speed, and the feed-forward is for a hand's speed)
    const end = gun.view.end
    const start = end.clone()
    const yawTo = Math.atan2(6, gun.hold.dist)
    for (let i = 1; i <= 6; i++) {
      yaw = (yawTo * i) / 6
      frame()
    }
    const T = new THREE.Vector3(...gun.hold.target)
    const stepDir = T.clone().sub(start).setY(0).normalize()
    const stepLen = T.distanceTo(start)
    let settled = -1
    let over = 0
    for (let i = 0; i < 360; i++) {
      frame()
      const e = end.distanceTo(T)
      const past = end.clone().sub(T).dot(stepDir)
      over = Math.max(over, past)
      if (e < 0.05) {
        if (settled < 0) settled = i
      } else settled = -1
    }
    // held still: how much does it move
    const mean = new THREE.Vector3()
    const pts = []
    for (let i = 0; i < 180; i++) {
      frame()
      pts.push(end.clone())
      mean.add(end)
    }
    mean.divideScalar(pts.length)
    const jitter = Math.max(...pts.map((p) => p.distanceTo(mean)))
    // a flick: the view swings back at six radians a second for a fifth of a
    // second and the trigger lets go at the end of it
    let speed = 0
    const off = gun.on((e) => {
      if (e.type === 'release') speed = e.speed
    })
    for (let i = 0; i < 12; i++) {
      yaw -= 6 * H
      frame()
    }
    inp.fire = false
    frame()
    off()
    const tn = tune(sb.get(id).mass)
    console.log(`physgun  ${pad(kind, 7)} ${pad(sb.get(id).mass + ' kg', 7)} w ${f(tn.w, 1)} z ${f(tn.z, 2)}: ` +
      `${f(stepLen, 1)}-unit step settles (2 cm) in ${settled < 0 ? 'NEVER' : Math.round((settled + 1) * H * 1000) + ' ms'}, ` +
      `overshoot ${f((100 * over) / stepLen, 1)}%; held still 3 s: grab point wanders ${f(jitter * 1000, 3)} mu; ` +
      `flick throws at ${f(speed, 1)} u/s`)
    sb.dispose()
  }
  // freeze and thaw
  {
    const { sb } = newSandbox()
    await sb.whenReady
    const x0 = flat.x
    const z0 = flat.z
    const focus = { x: x0, y: fy, z: z0 }
    const id = sb.spawn('crate', { x: x0, y: sb.restY('crate', x0, z0), z: z0 })
    for (let i = 0; i < 30; i++) sb.tick({ dt: H, active: true, focus })
    const eye = new THREE.Vector3(x0, fy + 3.84, z0 + 10)
    const dir = new THREE.Vector3()
    const aim = { eye, dir, yaw: 0 }
    const gun = createPhysgun({ sb })
    const inp = emptyInput(aim)
    inp.dt = H
    inp.fire = true
    let pitch = Math.atan2(sb.get(id).body.translation().y - eye.y, 10)
    const frame = () => {
      dir.set(0, Math.sin(pitch), -Math.cos(pitch))
      gun.update(inp)
      sb.tick({ dt: H, active: true, focus })
      gun.sync()
    }
    frame()
    for (let i = 0; i < 90; i++) {
      pitch += (0.25 - pitch) * 0.1
      frame()
    }
    inp.alt = true
    frame()
    inp.alt = false
    inp.fire = false
    frame()
    const a = sb.get(id).body.translation()
    const y0 = a.y
    for (let i = 0; i < 120; i++) frame()
    const b = sb.get(id).body.translation()
    const drift = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    inp.reload = true
    frame()
    inp.reload = false
    for (let i = 0; i < 90; i++) frame()
    const c2 = sb.get(id).body.translation()
    console.log(`physgun  freeze: ${sb.get(id).mode === 'dynamic' ? 'thawed' : 'STILL FROZEN'} after reload; ` +
      `frozen ${f(y0 - fy, 1)} over the ground, drifted ${f(drift, 5)} in 2 s, fell ${f(y0 - c2.y, 1)} after the thaw`)
    sb.dispose()
  }
  // the films, headless, with their reports
  for (const s of SCENARIOS) {
    if (!s.id.startsWith('sandbox:physgun') || s.id.endsWith('-3p')) continue
    if (onlyScn && s.id !== onlyScn) continue
    const { sb } = newSandbox()
    await sb.whenReady
    const c = stageScenario(s, sb)
    if (onlyScn) {
      for (let t = 0.25; t <= s.duration; t += 0.25) {
        advanceScenario(s, c, t)
        const p = sb.get(process.env.PROP ? Number(process.env.PROP) : c.ids[0])
        const tr = p ? p.body.translation() : { x: 0, y: 0, z: 0 }
        console.log(`  t ${f(t, 2)} prop0 ${f(tr.x - c.x, 2)} ${f(tr.y - c.y, 2)} ${f(tr.z - c.z, 2)} ${p?.mode}`)
      }
    } else advanceScenario(s, c, s.duration)
    console.log(`film     ${pad(s.id, 24)} ${s.report ? s.report(c) : ''}`)
    sb.dispose()
  }
}

if (want('scenarios')) {
  for (const s of SCENARIOS) {
    if (DESTRUCTION.includes(s.id)) continue
    const { sb } = newSandbox(true, false)
    await sb.whenReady
    const c = stageScenario(s, sb)
    const ms = []
    advanceScenario(s, c, s.duration, (_t, _dt, m) => ms.push(m))
    // the median: the first frames build the world's solids here in Node,
    // which in the game is the streamer's cost, paid long before
    ms.sort((a, b) => a - b)
    console.log(`scenario ${pad(s.id, 16)} at ${Math.round(c.x)},${Math.round(c.z)}  ${s.report ? s.report(c) : ''}  ` +
      `(${f(ms[Math.floor(ms.length / 2)], 2)} ms/frame median)`)
    sb.dispose()
  }
}

/* -------------------------------------------------------- destruction -- */
if (want('destruction')) {
  for (const id of DESTRUCTION) {
    const s = SCENARIOS.find((o) => o.id === id)
    const site = s.site()
    // the neighbourhood, built for real and kept: the ruins read the merged
    // geometry to take a building apart
    const cx0 = Math.floor((site.x - originX(0)) / CHUNK)
    const cz0 = Math.floor((site.z - originZ(0)) / CHUNK)
    const chunks = new Map()
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const c = buildChunk(cx0 + dx, cz0 + dz, 'full', MATS)
      chunks.set((cx0 + dx) + ',' + (cz0 + dz), c)
    }
    const collision = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, [])
    const sb = createSandbox({
      collision, waterY: () => SEA_Y,
      // what the streamer has loaded and nothing else, as in the game: a
      // chunk built here on demand would be billed to the collapse
      chunkSolids: (cx, cz) => chunks.get(cx + ',' + cz)?.boxes ?? null,
    })
    await sb.whenReady
    const debris = buildDebris({ parent: new THREE.Group(), obstacles: [], groundAt: terrainY, trackDisposable: () => {} })
    for (const c of chunks.values()) debris.arm(c.smash)
    debris.ruins.onSolids = () => sb.solidsChanged()
    const dmg = attachDestruction(sb, debris.ruins)
    const c = stageScenario(s, sb)
    const ms = []
    let most = 0
    // DESTRUCTION_EXTRA=<s> runs on past the film's end, to watch it settle
    const extra = Number(process.env.DESTRUCTION_EXTRA ?? 0)
    const spikes = []
    advanceScenario(s, c, s.duration + extra, (t, _dt, m) => {
      ms.push(m)
      if (m > 20) spikes.push(`${f(t, 2)}s ${f(m, 0)}ms (open ${f(dmg.stats.openMs, 0)}, lumps ${dmg.stats.lumps})`)
      most = Math.max(most, dmg.stats.lumps)
    })
    ms.sort((a, b) => a - b)
    const q = (k) => ms[Math.min(ms.length - 1, Math.floor(ms.length * k))]
    console.log(`destruction ${pad(id, 22)} at ${Math.round(c.x)},${Math.round(c.z)}  ${s.report ? s.report(c) : ''}`)
    console.log(`            frame ms: median ${f(q(0.5), 2)}, p95 ${f(q(0.95), 2)}, worst ${f(ms[ms.length - 1], 2)}; ` +
      `most rubble at once ${most}; ${dmg.log.length} damage events`)
    // what is still moving at the end, by level, and how fast
    const lv = {}
    sb.forEach((p) => {
      if (!p.data.rubble || p.mode !== 'dynamic' || p.body.isSleeping()) return
      const v = p.body.linvel()
      const a = p.body.angvel()
      const k = lv[p.data.level] ??= { n: 0, v: 0, w: 0 }
      k.n++
      k.v = Math.max(k.v, Math.hypot(v.x, v.y, v.z))
      k.w = Math.max(k.w, Math.hypot(a.x, a.y, a.z))
    })
    if (spikes.length) console.log(`            spikes: ${spikes.slice(0, 8).join('; ')}`)
    console.log(`            buildings opened ${dmg.stats.buildings}; awake by level: ` +
      Object.entries(lv).map(([k, o]) => `L${k} ${o.n} (v<=${f(o.v, 2)} w<=${f(o.w, 2)})`).join(', '))
    // undo, as Z would: every entry the demolition made, newest first, and
    // the building must stand whole again with its rubble gone
    if (id === 'sandbox:demolish-house') {
      const h = historyOf(sb)
      let n = 0
      while (h.undo()) n++
      let alive = 0
      let total = 0
      for (const st of debris.ruins.near(c.x, c.y, c.z, 3)) {
        if (!st.open) continue
        total += st.open.alive.length
        for (let i = 0; i < st.open.alive.length; i++) alive += st.open.alive[i]
      }
      let rubble = 0
      sb.forEach((p) => { if (p.data.rubble) rubble++ })
      console.log(`            undo x${n}: ${alive}/${total} pieces standing again, ${rubble} rubble left`)
    }
    dmg.dispose()
    sb.dispose()
  }
}
