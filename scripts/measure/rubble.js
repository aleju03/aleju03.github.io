/*
  `npm run measure -- rubble`: what a blast into a downtown building costs.

  The same blow the console's `/explode` deals (sb.explode at a point half a
  unit off the wall, radius 16 x sqrt(power)), aimed at the middle of one face
  of a mid-rise and of a tower in the home city's downtown, at power 1 (a
  barrel) and power 10 (the console's most). Each case gets its own fresh
  neighbourhood, sandbox, ruins and destruction, and runs fifteen seconds of
  simulation at 60 Hz. What it prints, per case:

    pieces     how many the building(s) hit were cut into, and how many left
    lumps      rubble bodies made in all (by level: cluster, storey, side,
               piece, shard), the most alive at once, and alive at the end
    awake      rubble bodies awake at +2, +5, +10 and +15 s
    draws      rubble meshes (one draw each, and one more in the shadow
               pass) at the peak and at the end, and their triangles
    hull pts   the mean and the largest convex hull handed to Rapier
    frame ms   the sandbox's tick (physics, destruction and all) over the
               first five seconds and over the ten after, median / p95 /
               worst, and the share of it inside Rapier's step

  `npm run measure -- rubble 1,3,10` picks the powers; RUBBLE_SEQ=6 sets the
  blast off six times a second apart (rockets), RUBBLE_SECS the length, and
  RUBBLE_DEBUG=1 adds what is still awake at +10 s and how many bodies were
  made in each second. Headless, so draws are counted rather than timed;
  `npm run drive -- rubble` times the same blast in the real renderer.
*/
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { attachDestruction } from '../../src/game/sandbox/destruction.ts'
import { buildDebris } from '../../src/game/world/debris.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'

const f = (x, d = 2) => (x === undefined || x === null || !Number.isFinite(x) ? '-' : x.toFixed(d))
const CASES = [
  // [label, building id: its chunk and its lot]
  ['mid-rise', '-2,-5:B-272,-613'],
  ['tower', '-2,-5:B-235,-535'],
]
const POWERS = (process.argv[2] ?? '1,10').split(',').map(Number)
const SECS = Number(process.env.RUBBLE_SECS ?? 15)

for (const [label, id] of CASES) {
  for (const power of POWERS) {
    const [cxs, czs] = id.split(':')[0].split(',').map(Number)
    const chunks = new Map()
    const boxes = []
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const ch = buildChunk(cxs + dx, czs + dz, 'full', MATS)
      chunks.set(ch.cx + ',' + ch.cz, ch)
      for (const b of ch.boxes) boxes.push(b)
    }
    const collision = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, [])
    const sb = createSandbox({
      collision, waterY: () => SEA_Y, walker: false,
      chunkSolids: (cx, cz) => chunks.get(cx + ',' + cz)?.boxes ?? null,
    })
    await sb.whenReady
    // the chunk groups hang off a root, as the streamer's do, so rubble gets
    // meshes the way it does in the game
    const scene = new THREE.Group()
    for (const ch of chunks.values()) scene.add(ch.group)
    scene.add(sb.root)
    const debris = buildDebris({ parent: scene, obstacles: boxes, groundAt: terrainY, trackDisposable: () => {} })
    for (const ch of chunks.values()) debris.arm(ch.smash)
    debris.ruins.onSolids = () => sb.solidsChanged()
    const dmg = attachDestruction(sb, debris.ruins)
    const s = debris.ruins.get(id)
    if (!s) {
      console.log(`${label}: ${id} not found`)
      continue
    }
    const b = s.box
    const mid = b.getCenter(new THREE.Vector3())
    // the face toward the street's -x side, half way up, half a unit out
    const at = { x: b.min.x - 0.5, y: s.rec.baseY + (b.max.y - s.rec.baseY) * 0.5, z: mid.z }
    const focus = { x: at.x, y: at.y, z: at.z }
    sb.tick({ dt: 0, active: true, focus })
    // Rapier's own share of a slice
    const world = sb.physics.world
    const realStep = world.step.bind(world)
    let stepMs = 0
    world.step = (...a) => {
      const t0 = performance.now()
      const r = realStep(...a)
      stepMs += performance.now() - t0
      return r
    }
    const made = [0, 0, 0, 0, 0]
    let hullN = 0
    let hullSum = 0
    let hullMax = 0
    const bornAt = new Map()
    let simT = 0
    sb.onSpawn((p) => {
      if (!p.data.rubble) return
      bornAt.set(p.id, simT)
      made[p.data.level ?? 4]++
      const pts = p.colliders?.[0]?.shape?.vertices?.length
      if (pts) {
        hullN++
        hullSum += pts / 3
        hullMax = Math.max(hullMax, pts / 3)
      }
    })
    const rubble = () => {
      let meshes = 0
      let tris = 0
      let awake = 0
      let n = 0
      sb.forEach((p) => {
        if (!p.data.rubble) return
        n++
        if (p.mode === 'dynamic' && !p.body.isSleeping()) awake++
        p.mesh?.traverse((o) => {
          if (!o.isMesh || !o.visible) return
          meshes++
          tris += (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position').count) / 3
        })
      })
      return { n, meshes, tris, awake }
    }
    // RUBBLE_SEQ=n: n blasts into the same spot a second apart (rockets)
    const SEQ = Number(process.env.RUBBLE_SEQ ?? 1)
    sb.explode(at, power, 16 * Math.sqrt(power))
    const early = []
    const late = []
    const earlyStep = []
    const lateStep = []
    let peak = { n: 0, meshes: 0, tris: 0 }
    const awakeAt = []
    const marks = [2, 5, 10, 15, 20, 30].filter((m) => m <= SECS)
    for (let i = 1; i <= SECS * 60; i++) {
      if (i % 60 === 0 && i / 60 < SEQ) sb.explode(at, power, 16 * Math.sqrt(power))
      stepMs = 0
      simT = i / 60
      if (process.env.RUBBLE_DEBUG && i === 600) {
        const rows = []
        sb.forEach((p) => {
          if (!p.data.rubble || p.mode !== 'dynamic' || p.body.isSleeping()) return
          const v = p.body.linvel()
          rows.push(`L${p.data.level} age ${f(simT - bornAt.get(p.id), 1)} v ${f(Math.hypot(v.x, v.y, v.z), 2)} y ${f(p.body.translation().y - terrainY(p.body.translation().x, p.body.translation().z), 1)}`)
        })
        console.log('  awake at 10 s: ' + rows.slice(0, 40).join('; '))
      }
      const t0 = performance.now()
      sb.tick({ dt: 1 / 60, active: true, focus })
      const ms = performance.now() - t0
      ;(i <= 300 ? early : late).push(ms)
      ;(i <= 300 ? earlyStep : lateStep).push(stepMs)
      if (i % 15 === 0 || marks.includes(i / 60)) {
        const r = rubble()
        if (r.n > peak.n) peak = r
        if (marks.includes(i / 60)) awakeAt.push(`+${i / 60}s ${r.awake}`)
      }
    }
    if (process.env.RUBBLE_DEBUG) {
      const hist = new Array(SECS).fill(0)
      for (const t of bornAt.values()) hist[Math.min(SECS - 1, Math.floor(t))]++
      console.log('  made per second: ' + hist.join(' '))
    }
    const end = rubble()
    let pieces = 0
    let lifted = 0
    let opened = 0
    for (const st of debris.ruins.near(at.x, at.y, at.z, 200)) {
      if (!st.open) continue
      opened++
      pieces += st.open.frac.pieces.length
      for (let i = 0; i < st.open.alive.length; i++) if (!st.open.alive[i]) lifted++
    }
    const q = (v, k) => {
      const s2 = [...v].sort((x, y) => x - y)
      return s2[Math.min(s2.length - 1, Math.floor(s2.length * k))]
    }
    const sum = (v) => v.reduce((x, y) => x + y, 0)
    const total = made.reduce((x, y) => x + y, 0)
    console.log(`${label} power ${power}${SEQ > 1 ? ' x' + SEQ : ''}: ${opened} building(s) opened, ${pieces} pieces, ${lifted} lifted`)
    console.log(`  lumps made ${total} (cluster ${made[0]}, storey ${made[1]}, side ${made[2]}, piece ${made[3]}, shard ${made[4]}); ` +
      `most alive ${peak.n}, alive at end ${end.n} (${dmg.stats.frozen} frozen)`)
    console.log(`  awake ${awakeAt.join(', ')}`)
    console.log(`  draws: peak ${peak.meshes} meshes / ${Math.round(peak.tris / 1000)}k tris, end ${end.meshes} / ${Math.round(end.tris / 1000)}k tris` +
      `; hull points mean ${f(hullSum / Math.max(1, hullN), 0)}, max ${hullMax}`)
    console.log(`  frame ms 0-5 s: median ${f(q(early, 0.5))}, p95 ${f(q(early, 0.95))}, worst ${f(q(early, 1))}, ` +
      `rapier ${f(100 * sum(earlyStep) / Math.max(1e-6, sum(early)), 0)}%; ` +
      `5-${SECS} s: median ${f(q(late, 0.5))}, p95 ${f(q(late, 0.95))}, worst ${f(q(late, 1))}, ` +
      `rapier ${f(100 * sum(lateStep) / Math.max(1e-6, sum(late)), 0)}%`)
    dmg.dispose()
    sb.dispose()
    for (const ch of chunks.values()) for (const g of ch.geos) g.dispose()
  }
}
