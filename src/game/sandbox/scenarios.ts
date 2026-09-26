import { SEA_Y, sampleAt, slopeAt, terrainY } from '../world/terrain'
import { placeAt, roadAt } from '../world/settlements'
import { inReserved } from '../world/grid'
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
}

export interface Scenario {
  id: string
  title: string
  /** where: a point and a layout direction */
  site: () => { x: number; z: number; dx: number; dz: number }
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

/** a hillside with a steady fall over forty units */
export const siteHill = () => {
  let best: { x: number; z: number; dx: number; dz: number } | null = null
  spiral((x, z) => {
    if (inReserved(x, z, 40)) return false
    const s = sampleAt(x, z)
    if (s.place.district || s.height < SEA_Y + 6) return false
    // open ground: a roll through a forest is a roll into the first trunk
    if (s.biome !== 'plains' && s.biome !== 'savanna' && s.biome !== 'tundra' && s.biome !== 'desert') return false
    const gx = (terrainY(x + 2, z) - terrainY(x - 2, z)) / 4
    const gz = (terrainY(x, z + 2) - terrainY(x, z - 2)) / 4
    const g = Math.hypot(gx, gz)
    if (g < 0.3 || g > 0.5) return false
    const dx = -gx / g
    const dz = -gz / g
    // the fall must keep going the same way for the run of the roll
    for (let k = 1; k <= 5; k++) {
      const px = x + dx * k * 8
      const pz = z + dz * k * 8
      const hx = (terrainY(px + 2, pz) - terrainY(px - 2, pz)) / 4
      const hz = (terrainY(px, pz + 2) - terrainY(px, pz - 2)) / 4
      const along = -(hx * dx + hz * dz)
      if (along < 0.18 || terrainY(px, pz) < SEA_Y + 1) return false
    }
    best = { x, z, dx, dz }
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

const settle = (c: ScenarioCtx) => {
  // report helper: how many of the ids are asleep
  let asleep = 0
  for (const id of c.ids) {
    const p = c.sb.get(id)
    if (p && p.body.isSleeping()) asleep++
  }
  return asleep
}

defineScenario({
  id: 'sandbox:stack',
  title: 'a 3x5 tower of crates, shoved over by a plank',
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
    // a tower three crates wide and five high, lined along the layout axis,
    // spawned touching so it settles in a frame rather than falling into place
    const h = 2.4
    const yaw = Math.atan2(c.dx, c.dz)
    // stacked by hand, not by a grid: a few centimetres and a few degrees of
    // slop per crate, which is what lets a falling tower twist and come apart
    // the way a real one does instead of pivoting over as one perfect slab
    let seed = 11
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
    for (let row = 0; row < 5; row++)
      for (let col = -1; col <= 1; col++) {
        const px = c.x + c.dx * col * (h + 0.04) + rnd() * 0.12
        const pz = c.z + c.dz * col * (h + 0.04) + rnd() * 0.12
        const y = c.sb.restY('crate', c.x, c.z) + row * (h + 0.01)
        c.ids.push(c.sb.spawn('crate', { x: px, y, z: pz }, { yaw: yaw + rnd() * 0.12 }))
      }
    // the ram: a plank held level against the fourth row, the way a physgun
    // holds one, a little askew so it meets one end of the tower first, driven
    // through at a walking pace and then let go
    const nx = c.dz
    const nz = -c.dx
    const ry = c.sb.restY('crate', c.x, c.z) + 2.5 * h
    const ramYaw = yaw + 0.3
    const ram = c.sb.spawn('plank', { x: c.x - nx * 2.6, y: ry, z: c.z - nz * 2.6 }, {
      quaternion: { x: 0, y: Math.sin(ramYaw / 2), z: 0, w: Math.cos(ramYaw / 2) },
    })
    c.sb.setMode(ram, 'kinematic')
    c.memo.ram = ram
    c.memo.ry = ry
    c.memo.q = yaw
    let t = 0
    const off = c.sb.onBeforeSlice((dt) => {
      t += dt
      const p = c.sb.get(ram)
      if (!p) return off()
      const push = Math.max(0, Math.min(t - 1.2, 1.4))
      c.sb.moveKinematic(ram, { x: c.x - nx * (2.6 - push * 4.5), y: ry, z: c.z - nz * (2.6 - push * 4.5) })
      if (t > 2.7) {
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
  id: 'sandbox:roll',
  title: 'barrels rolling down a real hillside',
  site: siteHill,
  duration: 7,
  frames: 12,
  camera: (c) => {
    // side-on, looking across the fall line, a little down the slope
    const sx = -c.dz
    const sz = c.dx
    const mx = c.x + c.dx * 16
    const mz = c.z + c.dz * 16
    const gy = terrainY(mx, mz)
    // from whichever side of the fall line stands higher, so the lens looks
    // across the slope rather than up it from a ditch
    const side = terrainY(mx + sx * 24, mz + sz * 24) >= terrainY(mx - sx * 24, mz - sz * 24) ? 1 : -1
    const fx = mx + side * sx * 24 - c.dx * 4
    const fz = mz + side * sz * 24 - c.dz * 4
    return {
      from: [fx, Math.max(gy, terrainY(fx, fz)) + 9, fz],
      to: [mx + c.dx * 2, gy - 1, mz + c.dz * 2],
      fov: 60,
    }
  },
  setup: (c) => {
    const sx = -c.dz
    const sz = c.dx
    const q = lying(c.dx, c.dz)
    for (let i = -2; i <= 2; i++) {
      // staggered down the slope as well as across it, so they do not set off
      // as one rank
      const px = c.x + sx * i * 4.2 - c.dx * Math.abs(i) * 1.5
      const pz = c.z + sz * i * 4.2 - c.dz * Math.abs(i) * 1.5
      c.ids.push(c.sb.spawn('barrel', { x: px, y: c.sb.groundY(px, pz) + 1.2, z: pz }, { quaternion: q }))
    }
    // for contrast: crates slide and tumble, a ball bounds ahead
    for (const [k, kind] of [[-1, 'crate'], [1, 'crate'], [0, 'ball']] as const) {
      const px = c.x + sx * k * 5 - c.dx * 5
      const pz = c.z + sz * k * 5 - c.dz * 5
      c.ids.push(c.sb.spawn(kind, { x: px, y: c.sb.restY(kind, px, pz) + 0.5, z: pz }))
    }
    c.memo.x0 = c.x
    c.memo.z0 = c.z
  },
  report: (c) => {
    const d: string[] = []
    for (const id of c.ids.slice(0, 5)) {
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
  duration: 6,
  frames: 12,
  camera: (c) => ({
    // down the street itself: anything off its axis is inside a building
    from: [c.x + c.dx * 24 + c.dz * 2.5, c.y + 10, c.z + c.dz * 24 - c.dx * 2.5],
    to: [c.x, c.y + 2, c.z],
    fov: 50,
  }),
  setup: (c) => {
    // a loose column, staggered so they land over a second and a half rather
    // than as one block, with a little spin each so nothing lands flat
    let s = 7
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 40; i++) {
      const kind = MIX[i % MIX.length]
      const px = c.x + (rnd() - 0.5) * 7
      const pz = c.z + (rnd() - 0.5) * 7
      const y = c.y + 5 + i * 1.1
      const a = rnd() * Math.PI
      c.ids.push(c.sb.spawn(kind, { x: px, y, z: pz }, {
        quaternion: { x: Math.sin(a / 2) * 0.6, y: Math.sin(a / 2) * 0.8, z: 0, w: Math.cos(a / 2) },
        angular: { x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1 },
      }))
    }
  },
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
    return `${settle(c)}/40 asleep, ${up} still high, ${far} scattered past 20 units, ${40 - c.ids.filter((id) => c.sb.get(id)).length} lost`
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
    const bx = c.x - c.dx * 26
    const bz = c.z - c.dz * 26
    return {
      from: [bx - c.dz * 10, Math.max(SEA_Y, terrainY(bx, bz)) + 6, bz + c.dx * 10],
      to: [c.x, SEA_Y + 0.5, c.z],
      fov: 52,
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
    ids: [], memo: { t: 0 },
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
