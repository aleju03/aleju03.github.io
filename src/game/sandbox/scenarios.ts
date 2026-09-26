import { SEA_Y, sampleAt, slopeAt, terrainY } from '../world/terrain'
import { placeAt, roadAt } from '../world/settlements'
import { chunkX, chunkZ, inReserved } from '../world/grid'
import { buildChunk, type ChunkMats } from '../world/chunk'
import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import type { Sandbox } from './sandbox'
import type { PropId } from './props'

/*
  Scripted physics, for looking at and for measuring.

  A scenario is a place, a setup, a camera and a clock: find somewhere in the
  real world that suits it (a hillside, a street, the sea), spawn props into
  it, poke them at chosen moments, and say how it went in numbers. The film
  harness (`npm run film -- sandbox:stack`) renders one as a labelled
  contact sheet or a video through the game's real materials; the measure
  harness (`npm run measure -- physics`) runs the same setups headless. One
  definition feeding both is the point: the picture a critic judges and the
  numbers a builder trusts come from the same code path.

  Adding one is a `defineScenario()` call. Other sandbox systems add theirs
  from their own modules (the physgun's grab-and-throw, destruction's tower
  coming down) and import this file for the registry; the harness imports
  every module named in its SCENARIO_MODULES list, so a new scenario file is
  one line there.

  Sites are found by walking out from the house on a deterministic spiral and
  testing the world's own fields, so the same scenario always lands in the
  same place and two runs of it are comparable frame for frame.
*/

export interface ScenarioCtx {
  sb: Sandbox
  /** the site, on the drawn ground */
  x: number
  y: number
  z: number
  /** unit direction the scenario is laid out along (downhill, out to sea...) */
  dx: number
  dz: number
  /** whatever the setup wants to remember for the timed steps and report */
  ids: PropId[]
  memo: Record<string, number>
}

export interface Shot {
  from: [number, number, number]
  to: [number, number, number]
  fov?: number
  /** the film may swing the lens round the target (same distance and
      height) to the nearest bearing whose view of it no building or crown
      blocks: for sites picked out of a town, where a fixed bearing is a
      photograph of the neighbour's roof */
  clear?: boolean
}

export interface Scenario {
  id: string
  title: string
  /** where: a point and a layout direction, plus anything the camera or
      setup wants to know about the place (copied into `memo`) */
  site: () => { x: number; z: number; dx: number; dz: number; memo?: Record<string, number> }
  camera: (c: ScenarioCtx) => Shot
  /** seconds of simulation the film covers */
  duration: number
  /** stills in the contact sheet */
  frames?: number
  /** time of day for the film, 0..1 */
  tod?: number
  setup: (c: ScenarioCtx) => void
  /** things that happen at a time, in seconds */
  events?: Array<[number, (c: ScenarioCtx) => void]>
  /** one line of numbers about how it went */
  report?: (c: ScenarioCtx) => string
  /** a moving camera: where the lens is at simulated time t. Overrides
      `camera` frame by frame (a first-person physgun film) */
  lens?: (c: ScenarioCtx, t: number) => Shot
  /** the render side of a scenario: things drawn in the scene that are not
      props (a viewmodel, a beam, a body). Called once by the film with the
      scene and camera; `frame` runs before every drawn frame, and `warmed`
      once the film has compiled and first-drawn the scene, so staged
      warm-up objects can be put away. Never called headless */
  present?: (c: ScenarioCtx, scene: import('three').Scene, cam: import('three').PerspectiveCamera) => {
    frame: (t: number, dt: number, lines: number) => void
    warmed?: () => void
    /** a first-person film's crosshair state (Crosshair.tsx's vocabulary);
        the film draws the crosshair over each frame when this is given */
    aim?: () => 'none' | 'prop' | 'held' | 'frozen'
  }
  /** people standing about (world x/z and a heading), for scenarios about
      what happens to them: the film stands a `buildPlayerBody()` rig on each
      and lets the sandbox's blasts knock it flat. Headless runs ignore it */
  bodies?: (c: ScenarioCtx) => Array<{ x: number; z: number; yaw: number }>
}

export const SCENARIOS: Scenario[] = []

export const defineScenario = (s: Scenario) => {
  const i = SCENARIOS.findIndex((o) => o.id === s.id)
  if (i >= 0) SCENARIOS[i] = s
  else SCENARIOS.push(s)
  return s
}

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id)

/* -------------------------------------------------------------- sites -- */

const spiral = (ok: (x: number, z: number) => boolean, from: [number, number] = [0, -300], step = 40) => {
  for (let r = 0; r < 220; r++) {
    const n = Math.max(1, r * 6)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = from[0] + Math.cos(a) * r * step
      const z = from[1] + Math.sin(a) * r * step
      if (ok(x, z)) return [x, z] as const
    }
  }
  return from
}

/** flat, open, dry grass with no town: the flatgrass of this world */
export const siteFlat = () => {
  const [x, z] = spiral((x, z) => {
    if (inReserved(x, z, 40)) return false
    const s = sampleAt(x, z)
    if (s.place.district || s.height < SEA_Y + 3) return false
    if (s.biome !== 'plains' && s.biome !== 'savanna') return false
    // properly flat, not merely gentle: a ten-high stack on a 2% slope leans
    // half a unit at the top, which is physics, and reads as a wobbly solver
    for (const [ox, oz] of [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10], [20, 0], [-20, 0]]) {
      if (slopeAt(x + ox, z + oz) > 0.012) return false
    }
    return true
  })
  return { x, z, dx: 1, dz: 0 }
}

/*
  What stands on a patch of the world, for sites that need open ground. The
  world's solids only exist once a chunk is built, so this builds it (with
  stand-in materials, geometry thrown away at once) and keeps the boxes.
  Sites are searched once per run, so a handful of chunk builds is the cost.
*/
const solidCache = new Map<string, Solid[]>()
let standIn: ChunkMats | null = null
export const solidsIn = (cx: number, cz: number) => {
  const k = `${cx},${cz}`
  let boxes = solidCache.get(k)
  if (!boxes) {
    const m = () => new THREE.MeshBasicMaterial()
    standIn ??= { ground: m(), detail: m(), glass: m(), water: m(), leaf: m(), leafDepth: m() }
    const ch = buildChunk(cx, cz, 'full', standIn)
    for (const g of ch.geos) g.dispose()
    boxes = ch.boxes
    solidCache.set(k, boxes)
  }
  return boxes
}
/** is a rectangle in a frame laid along (dx, dz) empty of solids? `a` runs
    along the direction, `b` across it (to its left, (-dz, dx)) */
export const clearOf = (
  x: number, z: number, dx: number, dz: number, a0: number, a1: number, b0: number, b1: number,
) => {
  const sx = -dz
  const sz = dx
  const corners = [[a0, b0], [a0, b1], [a1, b0], [a1, b1]].map(([a, b]) => [
    x + dx * a + sx * b, z + dz * a + sz * b,
  ])
  const minX = Math.min(...corners.map((c) => c[0]))
  const maxX = Math.max(...corners.map((c) => c[0]))
  const minZ = Math.min(...corners.map((c) => c[1]))
  const maxZ = Math.max(...corners.map((c) => c[1]))
  for (let cz = chunkZ(minZ); cz <= chunkZ(maxZ); cz++)
    for (let cx = chunkX(minX); cx <= chunkX(maxX); cx++)
      for (const b of solidsIn(cx, cz)) {
        const bx = (b.min.x + b.max.x) / 2 - x
        const bz = (b.min.z + b.max.z) / 2 - z
        const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2
        const a = bx * dx + bz * dz
        const bb = bx * sx + bz * sz
        if (a > a0 - r && a < a1 + r && bb > b0 - r && bb < b1 + r) return false
      }
  return true
}

/** a hillside with a steady fall over forty units, and nothing on it: no
    tree in the run and none between the run and where the camera stands */
export const siteHill = () => {
  let best: { x: number; z: number; dx: number; dz: number; memo: Record<string, number> } | null = null
  spiral((x, z) => {
    if (inReserved(x, z, 40)) return false
    const s = sampleAt(x, z)
    // no biome gate: a clear run is what matters, and clearOf below asks the
    // chunk's own solids for it. (Steep open grass is rare in this world;
    // gated on biome as well, eight kilometres of search found two hills)
    if (s.place.district || s.height < SEA_Y + 6) return false
    if (roadAt(x, z, s.place).grade > 0) return false
    const gx = (terrainY(x + 2, z) - terrainY(x - 2, z)) / 4
    const gz = (terrainY(x, z + 2) - terrainY(x, z - 2)) / 4
    const g = Math.hypot(gx, gz)
    if (g < 0.24 || g > 0.5) return false
    const dx = -gx / g
    const dz = -gz / g
    // the fall must keep going the same way for the run of the roll
    for (let k = 1; k <= 5; k++) {
      const px = x + dx * k * 8
      const pz = z + dz * k * 8
      const hx = (terrainY(px + 2, pz) - terrainY(px - 2, pz)) / 4
      const hz = (terrainY(px, pz + 2) - terrainY(px, pz - 2)) / 4
      const along = -(hx * dx + hz * dz)
      if (along < 0.14 || terrainY(px, pz) < SEA_Y + 1) return false
    }
    // the run itself, eleven either side, and a strip out to one side for the
    // lens, whichever side is open
    if (!clearOf(x, z, dx, dz, -6, 40, -11, 11)) return false
    const side = clearOf(x, z, dx, dz, 8, 28, 11, 27) ? 1 : clearOf(x, z, dx, dz, 8, 28, -27, -11) ? -1 : 0
    if (!side) return false
    best = { x, z, dx, dz, memo: { side } }
    return true
  }, [200, -200], 36)
  return best ?? { x: 0, z: -300, dx: 1, dz: 0 }
}

/** a town street, on the asphalt, clear of junctions */
export const siteStreet = () => {
  const [x, z] = spiral((x, z) => {
    if (inReserved(x, z, 30)) return false
    const place = placeAt(x, z)
    if (place.district !== 'midrise' && place.district !== 'downtown') return false
    const r = roadAt(x, z, place)
    if (!r.asphalt || r.junction || r.dist > 1) return false
    return slopeAt(x, z) < 0.05
  }, [0, -340], 12)
  const r = roadAt(x, z, placeAt(x, z))
  // snap onto the centreline and lay out along the street
  return r.axis === 'x'
    ? { x, z: r.line, dx: 1, dz: 0 }
    : { x: r.line, z, dx: 0, dz: 1 }
}

/** open water a few strides off a shore, with the shore to stand on */
export const siteSea = () => {
  let best = { x: 0, z: 0, dx: 1, dz: 0 }
  spiral((x, z) => {
    if (terrainY(x, z) > SEA_Y - 3.5) return false
    // a shore within 40 units, which is where the camera stands
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2
      const dx = Math.cos(ang)
      const dz = Math.sin(ang)
      for (const d of [20, 28, 36]) {
        const gy = terrainY(x + dx * d, z + dz * d)
        if (gy > SEA_Y + 0.6 && gy < SEA_Y + 8) {
          // lay out *away* from the shore
          best = { x, z, dx: -dx, dz: -dz }
          return true
        }
      }
    }
    return false
  }, [0, 0], 48)
  return best
}

/* ---------------------------------------------------------- the stock -- */

const MIX = ['crate', 'barrel', 'ball', 'plank', 'cone', 'crate', 'barrel', 'block']

/** a quaternion turning local +y onto the horizontal (dx, dz) axis's normal,
    i.e. a cylinder lying on its side with its axis along (-dz, dx) */
const lying = (dx: number, dz: number) => {
  // rotate +y down onto the axis a = (-dz, 0, dx): about the axis a x y
  const ax = -dz
  const az = dx
  // rotation of 90 degrees about (az, 0, -ax) normalised... +y -> a
  const kx = az
  const kz = -ax
  const l = Math.hypot(kx, kz) || 1
  const s = Math.SQRT1_2
  return { x: (kx / l) * s, y: 0, z: (kz / l) * s, w: s }
}

/** how far the stack's ram is turned off square to the tower, radians: it
    meets the columns a seventh of a second apart, so they twist and come
    apart as they go over instead of falling as one wall */
const RAM_SKEW = 0.4
/** how fast it is swung through, u/s: under a crate's breaking speed, so
    the crates it meets are knocked out whole rather than shattered in place */
const RAM_SPEED = 24
/** and where, over the bottom crate's centre: 3.6 is the seam between the
    second and third rows, a third of the way up. Round four swung through
    the base (0), and the twelve crates above dropped a floor together and
    stood for half a second as one welded wall before hinging over; hit at
    the seam, the top of the tower is knocked off its own lower half, the
    columns shear apart and the top comes down on the base. Measured by
    `measure physics fall` over heights 0 to 6 and speeds 18 and 24: half
    the seams open in 1.53 s from the base, 0.2 s from here */
const RAM_HEIGHT = 3.6
/** when it sets off, seconds: the tower is spawned touching and has settled
    in a tenth of that, and the film had a second of nothing at its start */
const RAM_AT = 0.3

/** the roll's lens, beside the drums at `along` down the slope and
    `across` it, looking a little ahead of them */
const rollShot = (c: ScenarioCtx, along: number, across: number): Shot => {
  const side = c.memo.side ?? 1
  const sx = -c.dz * side
  const sz = c.dx * side
  const mx = c.x + c.dx * (along + 2) - c.dz * across
  const mz = c.z + c.dz * (along + 2) + c.dx * across
  const gy = terrainY(mx, mz)
  // at the bottom of the hill the town begins, and a lens standing in a
  // house films its wall: step in closer (or out) to the first clear spot
  let fx = mx + sx * 17 - c.dx * 3
  let fz = mz + sz * 17 - c.dz * 3
  for (const d of [17, 12, 22, 8]) {
    const x = mx + sx * d - c.dx * 3
    const z = mz + sz * d - c.dz * 3
    if (clearOf(x, z, 1, 0, -2, 2, -2, 2)) {
      fx = x
      fz = z
      break
    }
  }
  return { from: [fx, Math.max(gy, terrainY(fx, fz)) + 5.5, fz], to: [mx, gy + 0.5, mz], fov: 58 }
}

const settle = (c: ScenarioCtx) => {
  // report helper: how many of the ids are asleep
  let asleep = 0
  for (const id of c.ids) {
    const p = c.sb.get(id)
    if (p && p.body.isSleeping()) asleep++
  }
  return asleep
}

/**
 * A tower of crates three wide and five high, lined along the layout axis
 * and stacked by hand (see inside), its fifteen ids pushed onto `c.ids` in
 * row order, bottom row first. Shared by every scenario that knocks one
 * down, so the stack being judged is the same stack whatever hits it.
 */
export const crateTower = (c: ScenarioCtx) => {
  // a tower three crates wide and five high, lined along the layout axis,
  // spawned touching so it settles in a frame rather than falling into place
  const h = 2.4
  const yaw = Math.atan2(c.dx, c.dz)
  // stacked by hand, not by a grid: a few centimetres and a few degrees of
  // slop per crate, no two packed the same (a crate's weight varies by a
  // third either way) and no two quite the same size (each is 0.9 to 1.06
  // of the kind, and a column stands as tall as its own crates make it).
  // Identical crates in a perfect grid get identical impulses, so whole
  // rows fell as one piece; and with the size slop gone too, the twelve
  // crates above the base stood for half a second as one welded wall with
  // no seam opening, then went over as a hinged chain. With rows that do
  // not line up, every crate rests on one neighbour and leans on the next
  // at a different height, and the seams open as it falls
  let seed = 11
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
  const half = h / 2
  const pitch = h * 1.06 + 0.05
  const tops = [-1, 0, 1].map((col) => c.sb.groundY(c.x + c.dx * col * pitch, c.z + c.dz * col * pitch))
  for (let row = 0; row < 5; row++)
    for (let col = -1; col <= 1; col++) {
      const k = 0.98 + rnd() * 0.16
      const px = c.x + c.dx * col * pitch + rnd() * 0.16
      const pz = c.z + c.dz * col * pitch + rnd() * 0.16
      const y = tops[col + 1] + half * k + 0.01
      tops[col + 1] = y + half * k
      c.ids.push(c.sb.spawn('crate', { x: px, y, z: pz }, {
        yaw: yaw + rnd() * 0.16, scale: k, mass: 35 * k * k * k * (1 + rnd() * 0.7),
      }))
    }
}

defineScenario({
  id: 'sandbox:stack',
  title: 'a 3x5 tower of crates, a girder rammed through it a third of the way up',
  site: siteFlat,
  duration: 6,
  frames: 12,
  camera: (c) => {
    // three-quarters on, so the tower falls across the frame
    const nx = c.dz
    const nz = -c.dx
    return {
      from: [c.x + c.dx * 22 - nx * 20, c.y + 9, c.z + c.dz * 22 - nz * 20],
      to: [c.x + nx * 3, c.y + 4.5, c.z + nz * 3],
      fov: 50,
    }
  },
  setup: (c) => {
    crateTower(c)
    // the ram: a steel girder held level and turned off square, swung
    // through the tower a third of the way up (RAM_HEIGHT), then let go.
    // Leaning on the tower slowly only ever pivoted it over whole; round
    // three's plank, slanted, was a wedge that lifted the crates it slid
    // under, and shorter than the tower is wide, so one column was never
    // touched; a ram that shattered the base just dropped the tower a floor;
    // and one that kicked the base out whole dropped it as a welded wall.
    // The girder is longer than the tower, level and flat-faced
    const nx = c.dz
    const nz = -c.dx
    const ry = c.sb.restY('crate', c.x, c.z) + RAM_HEIGHT
    // local x (the girder's length) onto the tower's row, plus the skew
    const ramYaw = Math.atan2(-c.dz, c.dx) + RAM_SKEW
    const back = 7
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ramYaw)
    const ram = c.sb.spawn('girder', { x: c.x - nx * back, y: ry, z: c.z - nz * back }, {
      quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
    })
    c.sb.setMode(ram, 'kinematic')
    let t = 0
    const off = c.sb.onBeforeSlice((dt) => {
      t += dt
      if (!c.sb.get(ram)) return off()
      const d = back - Math.max(0, Math.min(t - RAM_AT, 15 / RAM_SPEED)) * RAM_SPEED
      c.sb.moveKinematic(ram, { x: c.x - nx * d, y: ry, z: c.z - nz * d }, q)
      if (t > RAM_AT + 15 / RAM_SPEED) {
        c.sb.setMode(ram, 'dynamic')
        off()
      }
    })
  },
  report: (c) => {
    let fallen = 0
    const base = c.sb.restY('crate', c.x, c.z)
    for (let i = 0; i < 15; i++) {
      const p = c.sb.get(c.ids[i])
      if (!p) continue
      const t = p.body.translation()
      const row = Math.floor(i / 3)
      if (t.y < base + row * 2.4 - 1) fallen++
    }
    return `${fallen}/15 crates came down, ${settle(c)}/${c.ids.length} asleep`
  },
})

defineScenario({
  id: 'sandbox:topple',
  title: 'the same crate tower, a drum thrown into the foot of one end',
  site: siteFlat,
  duration: 5,
  frames: 12,
  camera: (c) => {
    // side-on to the tower's face, so a column leaning out of it shows
    // whether its crates keep their faces flush or slide off each other
    const nx = c.dz
    const nz = -c.dx
    return {
      from: [c.x - nx * 26 + c.dx * 4, c.y + 6, c.z - nz * 26 + c.dz * 4],
      to: [c.x, c.y + 4.5, c.z],
      fov: 50,
    }
  },
  // a second, different blow to the same stack, so nothing about the way a
  // stack comes apart can have been tuned to one ram: a 28 kg drum, thrown
  // hard and low into the end column's bottom crate, the way a player
  // throws one off the physgun. The column above loses its footing on one
  // side and leans out over the gap, and the question is what its crates
  // do while it leans
  setup: (c) => crateTower(c),
  events: [[0.3, (c) => {
    const nx = c.dz
    const nz = -c.dx
    const pitch = 2.4 * 1.06 + 0.05
    // the end column, its bottom crate's height, from twelve units off
    const tx = c.x - c.dx * pitch
    const tz = c.z - c.dz * pitch
    const y = c.sb.restY('crate', tx, tz)
    const q = lying(c.dx, c.dz)
    c.ids.push(c.sb.spawn('barrel', { x: tx - nx * 12, y, z: tz - nz * 12 }, {
      quaternion: q,
      velocity: { x: nx * 60, y: 1, z: nz * 60 },
      angular: { x: c.dx * 3, y: 0, z: c.dz * 3 },
    }))
  }]],
  report: (c) => {
    let fallen = 0
    const base = c.sb.restY('crate', c.x, c.z)
    for (let i = 0; i < 15; i++) {
      const p = c.sb.get(c.ids[i])
      if (!p) {
        fallen++
        continue
      }
      if (p.body.translation().y < base + Math.floor(i / 3) * 2.4 - 1) fallen++
    }
    return `${fallen}/15 crates came down, ${settle(c)}/${c.ids.length} asleep`
  },
})

defineScenario({
  id: 'sandbox:roll',
  title: 'barrels rolling down a real hillside',
  site: siteHill,
  duration: 4.5,
  frames: 12,
  // side-on across the fall line, from the side the site found open,
  // riding down the slope with the drums. The first framing stood 27 units
  // off and ten up, and a drum was a ten-pixel speck; this one is close
  // enough to see a drum turn over and hop, and it follows where the drums
  // are on average both down the slope and across it, so they stay in it
  camera: (c) => rollShot(c, 8, 0),
  lens: (c) => {
    let along = 0
    let across = 0
    let n = 0
    for (const id of c.ids.slice(0, 4)) {
      const p = c.sb.get(id)
      if (!p) continue
      const q = p.body.translation()
      along += (q.x - c.x) * c.dx + (q.z - c.z) * c.dz
      across += (q.x - c.x) * -c.dz + (q.z - c.z) * c.dx
      n++
    }
    return rollShot(c, Math.max(8, n ? along / n : 8), n ? across / n : 0)
  },
  setup: (c) => {
    const sx = -c.dz
    const sz = c.dx
    const q = lying(c.dx, c.dz)
    // a nudge downhill, and the spin that goes with rolling at that speed:
    // w = (up x d) v / r, about the drum's own axis
    const v = 2.5
    const spin = { x: (c.dz * v) / 0.72, y: 0, z: (-c.dx * v) / 0.72 }
    for (let i = 0; i < 4; i++) {
      // a loose diagonal: six units apart across the slope (a drum is 2.1
      // long, so they cannot meet end to end and roll as one) and three down
      const k = i - 1.5
      const px = c.x + sx * k * 6 + c.dx * i * 3
      const pz = c.z + sz * k * 6 + c.dz * i * 3
      c.ids.push(c.sb.spawn('barrel', { x: px, y: c.sb.groundY(px, pz) + 0.76, z: pz }, {
        quaternion: q,
        velocity: { x: c.dx * v, y: 0, z: c.dz * v },
        angular: spin,
      }))
    }
    // for contrast: a crate slides and tumbles, a ball bounds ahead
    for (const [k, kind] of [[-1, 'crate'], [1, 'ball']] as const) {
      const px = c.x + sx * k * 9 - c.dx * 4
      const pz = c.z + sz * k * 9 - c.dz * 4
      c.ids.push(c.sb.spawn(kind, { x: px, y: c.sb.restY(kind, px, pz) + 0.5, z: pz }))
    }
  },
  report: (c) => {
    const d: string[] = []
    for (const id of c.ids.slice(0, 4)) {
      const p = c.sb.get(id)
      if (!p) {
        d.push('gone')
        continue
      }
      const t = p.body.translation()
      d.push(((t.x - c.x) * c.dx + (t.z - c.z) * c.dz).toFixed(0))
    }
    return `barrels travelled ${d.join(', ')} units downhill`
  },
})

defineScenario({
  id: 'sandbox:pile',
  title: 'forty mixed props dropped on a street',
  site: siteStreet,
  // poured until 3.6 s, splinters still settling into the gaps until nearly
  // 8, and the heap asleep at 8.7 (`measure physics rest`, on this street):
  // the film ends with it at rest, not while it is still settling
  duration: 11,
  frames: 12,
  camera: (c) => ({
    // down the street itself: anything off its axis is inside a building
    from: [c.x + c.dx * 24 + c.dz * 2.5, c.y + 10, c.z + c.dz * 24 - c.dx * 2.5],
    to: [c.x, c.y + 2, c.z],
    fov: 50,
  }),
  setup: (c) => {
    c.memo.seed = 7
    // broken is not lost: a crate a 900 kg block lands on is crushed, which
    // is the right answer, and the report says which it was
    c.memo.broke = 0
    c.sb.onBreak((e) => {
      if (c.ids.includes(e.id)) c.memo.broke++
    })
  },
  // a loose column poured in over three and a half seconds rather than
  // stacked in the air, with a little spin each so nothing lands flat. It
  // used to be stacked: forty props one above the next, the top one 49 units
  // up, and once crates and planks could break the top half of the column
  // arrived at 40-57 u/s and a pile of forty lost six to splinters. Poured
  // from eight units over whatever is already there, each lands at about
  // the speed of a crate knocked off a stack
  events: Array.from({ length: 40 }, (_, i): [number, (c: ScenarioCtx) => void] => [0.02 + i * 0.09, (c) => {
    let s = c.memo.seed
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    const kind = MIX[i % MIX.length]
    const px = c.x + (rnd() - 0.5) * 7
    const pz = c.z + (rnd() - 0.5) * 7
    const a = rnd() * Math.PI
    const q = { x: Math.sin(a / 2) * 0.6, y: Math.sin(a / 2) * 0.8, z: 0, w: Math.cos(a / 2) }
    const w = { x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1 }
    c.memo.seed = s
    let top = c.y
    c.sb.queryBall({ x: px, y: c.y + 6, z: pz }, 6, (p) => {
      const t = p.body.translation()
      top = Math.max(top, t.y + p.extents.y)
    })
    c.ids.push(c.sb.spawn(kind, { x: px, y: top + 8, z: pz }, { quaternion: q, angular: w }))
  }]),
  report: (c) => {
    let up = 0
    let far = 0
    for (const id of c.ids) {
      const p = c.sb.get(id)
      if (!p) continue
      const t = p.body.translation()
      if (t.y > c.y + 12) up++
      if (Math.hypot(t.x - c.x, t.z - c.z) > 20) far++
    }
    const gone = 40 - c.ids.filter((id) => c.sb.get(id)).length
    return `${settle(c)}/40 asleep, ${up} still high, ${far} scattered past 20 units, ` +
      `${c.memo.broke} crushed to splinters, ${gone - c.memo.broke} lost`
  },
})

defineScenario({
  id: 'sandbox:float',
  title: 'props thrown into the sea',
  site: siteSea,
  duration: 8,
  frames: 12,
  camera: (c) => {
    // on the shore, looking out
    const bx = c.x - c.dx * 17
    const bz = c.z - c.dz * 17
    return {
      from: [bx - c.dz * 6, Math.max(SEA_Y, terrainY(bx, bz)) + 4.5, bz + c.dx * 6],
      to: [c.x, SEA_Y + 0.3, c.z],
      fov: 46,
    }
  },
  setup: (c) => {
    const kinds = ['crate', 'barrel', 'ball', 'plank', 'crate', 'barrel', 'block', 'cone', 'ball', 'plank']
    kinds.forEach((kind, i) => {
      const a = (i / kinds.length) * Math.PI * 2
      const px = c.x + Math.cos(a) * 6
      const pz = c.z + Math.sin(a) * 6
      c.ids.push(c.sb.spawn(kind, { x: px, y: SEA_Y + 5 + (i % 3) * 2.5, z: pz }, {
        yaw: a,
        angular: { x: (i % 2) - 0.5, y: 0.3, z: 0.4 },
      }))
    })
  },
  report: (c) => {
    const rows: string[] = []
    for (const id of c.ids) {
      const p = c.sb.get(id)
      if (!p) continue
      rows.push(`${p.kind.id} ${(p.body.translation().y - SEA_Y).toFixed(1)}`)
    }
    return `height over the waterline: ${rows.join(', ')}`
  },
})

/* ---------------------------------------------------------- the runner -- */

/** find the site, build the context and run the setup */
export const stageScenario = (s: Scenario, sb: Sandbox): ScenarioCtx => {
  const site = s.site()
  const c: ScenarioCtx = {
    sb, x: site.x, y: terrainY(site.x, site.z), z: site.z, dx: site.dx, dz: site.dz,
    ids: [], memo: { ...(site.memo ?? {}), t: 0 },
  }
  s.setup(c)
  return c
}

/**
 * Advance a staged scenario to simulated time `to`, one 60 Hz frame at a
 * time, firing its events as their moment passes. `onFrame` runs after every
 * frame with that frame's tick cost (the film harness moves the water's
 * clock with it, and keeps the costs).
 */
export const advanceScenario = (
  s: Scenario, c: ScenarioCtx, to: number, onFrame?: (t: number, dt: number, ms: number) => void,
) => {
  const dt = 1 / 60
  const focus = { x: c.x, y: c.y, z: c.z }
  while (c.memo.t < to - 1e-9) {
    const t0 = c.memo.t
    const t1 = t0 + dt
    for (const [at, fn] of s.events ?? []) if (at > t0 && at <= t1) fn(c)
    const r = c.sb.tick({ dt, active: true, focus })
    c.memo.t = t1
    onFrame?.(t1, dt, r.ms)
  }
}
