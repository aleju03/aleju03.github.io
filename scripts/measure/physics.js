/*
  `npm run measure -- physics`: the sandbox's physics core, headless.

  Appended to measure.mjs's prelude (so THREE, buildChunk, MATS, terrainY and
  the rest are in scope) and bundled with the sandbox. Five sections, each a
  claim the sandbox makes and the number that holds it to it:

    ground     the heightfields agree with terrainY (the drawn mesh)
    cost       ms per frame with 50 / 200 / 500 props awake
    stack      a 10-high crate stack stands still for 30 s of sim time
    tunnel     fast things do not pass through thin things or the ground
    walker     the walk pushes a crate, is stopped by a block, stands on a
               stack and rides a moving plank
    float      each kind dropped into still water: waterline, attitude, and
               how long it takes to stop rolling
    scenarios  every registered scenario, run to its end, with its report
*/
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { SCENARIOS, stageScenario, advanceScenario } from '../../src/game/sandbox/scenarios.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { createWalkController } from '../../src/game/player/walkController.ts'

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
const newSandbox = (withSolids = true) => {
  const collision = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, [])
  const sb = createSandbox({ collision, waterY: () => SEA_Y, chunkSolids: withSolids ? chunkSolids : undefined })
  return { sb, collision }
}
const flat = SCENARIOS.find((s) => s.id === 'sandbox:stack').site()
const fy = terrainY(flat.x, flat.z)
console.log(`flat site ${Math.round(flat.x)},${Math.round(flat.z)}, slope ${slopeAt(flat.x, flat.z).toFixed(4)}`)
const pad = (s, n) => String(s).padEnd(n)
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

/* -------------------------------------------------------------- float -- */
if (want('float')) {
  // each kind dropped tilted into still open water, one at a time, and
  // watched for ten seconds: where it rides, how it lies, when it stops
  // rolling. "flat" is the angle from the nearest face-on orientation, so 0
  // is a crate riding level and 45 is one floating on an edge
  const sea = SCENARIOS.find((s) => s.id === 'sandbox:float').site()
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
    let lateSpin = 0
    let lateBob = 0
    let lastY = null
    for (let i = 0; i < 600; i++) {
      sb.tick({ dt: 1 / 60, active: true, focus })
      const w = p.body.angvel()
      const spin = Math.hypot(w.x, w.y, w.z)
      if (spin > 0.35) settled = (i + 1) / 60
      const y = p.body.translation().y
      if (process.env.DEBUG_FLOAT === kind && i % 20 === 0) {
        const v = p.body.linvel()
        const tt = p.body.translation()
        console.log(i, 'y', f(tt.y - SEA_Y, 2), 'w', f(w.x, 2), f(w.y, 2), f(w.z, 2), 'v', f(v.x, 2), f(v.y, 2), f(v.z, 2), 'damp', f(p.body.linearDamping(), 2), f(p.body.angularDamping(), 2), 'sleep', p.body.isSleeping())
      }
      if (i >= 360) {
        lateSpin = Math.max(lateSpin, spin)
        if (lastY !== null) lateBob = Math.max(lateBob, Math.abs(y - lastY) * 60)
      }
      lastY = y
    }
    const q = p.body.rotation()
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w)
    let flat = 90
    for (const ax of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
      const d = Math.abs(ax.applyQuaternion(quat).y)
      flat = Math.min(flat, Math.acos(Math.min(1, d)) * 180 / Math.PI)
    }
    const t = p.body.translation()
    const e = p.extents
    console.log(`float    ${pad(kind, 7)} centre ${f(t.y - SEA_Y, 2).padStart(6)} over the water ` +
      `(half-height ${f(e.y, 2)}), ${f(flat, 0).padStart(2)} deg off a face, stopped rolling at ${f(settled, 1)} s, ` +
      `after 6 s spin <= ${f(lateSpin, 2)} rad/s, bob <= ${f(lateBob, 2)} u/s`)
    sb.dispose()
  }
}

/* ---------------------------------------------------------- scenarios -- */
if (want('scenarios')) {
  for (const s of SCENARIOS) {
    const { sb } = newSandbox()
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
