import * as THREE from 'three'
import { makeCollisionSet } from '../../physics/collision'
import { buildPlayerBody, type PlayerPose, type PlayerRig } from '../../player/playerBody'
import type { RagdollEnv } from '../../player/ragdoll'
import { terrainY } from '../../world/terrain'
import { defineScenario, siteFlat, type ScenarioCtx, type Shot } from '../scenarios'
import { createToolbelt, type Toolbelt } from './toolbelt'
import { emptyInput, type RigEntry, type ToolInput } from './types'

/*
  The physgun, scripted: somebody standing on the flatgrass with the gun out,
  whose view and fingers are functions of time.

  Each scenario here is a `Script` (where the eye looks, which buttons are
  down, what the wheel and the mouse do) plus a setup that puts props in
  front of it. `gunScenario` turns one into a first-person film (the lens
  *is* the eye, so the viewmodel and the beam are exactly what a player
  sees) and a third-person one (the same run watched from beside a real
  `buildPlayerBody()` holding the gun out along its view). The script drives
  the real tool belt through the same `ToolInput` record the keyboard fills
  in the game, one fixed slice at a time, so the physics filmed and the
  physics measured (`npm run measure -- physics physgun`) are the same run.

    npm run film -- sandbox:physgun-swing       lift a crate and swing it round in an arc, freeze it mid-air
    npm run film -- sandbox:physgun-rotate      E + mouse turns it, Shift snaps it square, freeze, R drops it
    npm run film -- sandbox:physgun-heavy       the 900 kg block lagging a swing and sailing past
    npm run film -- sandbox:physgun-throw       a barrel flung off the beam into a stack of crates
    npm run film -- sandbox:physgun-ragdoll     a body picked up by the head, pinned in the air, let down
    ...each with a -3p twin, and `--video` for an MP4
*/

const EYE = 3.84

interface Script {
  /** heading and pitch at t (the walk's conventions: yaw 0 faces -Z) */
  look: (t: number) => [number, number]
  fire?: (t: number) => boolean
  alt?: (t: number) => boolean
  rotate?: (t: number) => boolean
  snap?: (t: number) => boolean
  reload?: (t: number) => boolean
  /** wheel notches landing in (t0, t1] */
  wheel?: (t0: number, t1: number) => number
  /** mouse, pixels per second, while rotating */
  turn?: (t: number) => [number, number]
}

interface Run {
  tb: Toolbelt
  eye: THREE.Vector3
  script: Script
  t: number
  /** the pedestrian, for the ragdoll film */
  rig: PlayerRig | null
  rigEnv: RagdollEnv | null
  memo: Record<string, number>
}

const runs = new WeakMap<ScenarioCtx, Run>()

const yawOf = (dx: number, dz: number) => Math.atan2(-dx, -dz)
const dirOf = (yaw: number, pitch: number, out: THREE.Vector3) =>
  out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
const pitchTo = (eye: THREE.Vector3, x: number, y: number, z: number) =>
  Math.atan2(y - eye.y, Math.hypot(x - eye.x, z - eye.z))
/** smoothstep between two times */
const ease = (t: number, t0: number, t1: number) => {
  const k = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))
  return k * k * (3 - 2 * k)
}
const between = (t: number, a: number, b: number) => t >= a && t < b

const standPose = (): PlayerPose => ({
  dt: 0, gait: 0, crouchK: 0, grounded: true, run: false,
  yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
})

/**
 * Start the belt and the script. The script's slice hook is registered
 * before the belt's own, so each slice sees this slice's buttons.
 */
const begin = (c: ScenarioCtx, script: Script, rigs?: () => Iterable<RigEntry>) => {
  const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
  const aim = { eye, dir: new THREE.Vector3(0, 0, -1), yaw: 0 }
  const input: ToolInput = emptyInput(aim)
  const run: Run = { tb: null as unknown as Toolbelt, eye, script, t: 0, rig: null, rigEnv: null, memo: {} }
  c.sb.onBeforeSlice((h) => {
    const t0 = run.t
    run.t += h
    const t = run.t
    const [yaw, pitch] = script.look(t)
    aim.yaw = yaw
    dirOf(yaw, pitch, aim.dir)
    input.dt = h
    input.fire = script.fire?.(t) ?? false
    input.alt = script.alt?.(t) ?? false
    input.rotate = script.rotate?.(t) ?? false
    input.snap = script.snap?.(t) ?? false
    input.reload = script.reload?.(t) ?? false
    input.wheel = script.wheel?.(t0, t) ?? 0
    const [lx, ly] = input.rotate && script.turn ? script.turn(t) : [0, 0]
    input.lookX = lx * h
    input.lookY = ly * h
    run.tb.update(input, true)
    // the pedestrian's ragdoll steps with the slices, like the world's would
    if (run.rig && run.rigEnv) {
      rigPose.dt = h
      run.rig.update(rigPose, run.rigEnv)
    }
  })
  run.tb = createToolbelt({ sb: c.sb, parent: c.sb.root.parent, slot: 1, rigs, sound: false })
  // headless there is no draw to sync after, so the record is kept current
  // off the slices (a film syncs again after each draw, which is harmless)
  c.sb.onAfterSlice(() => run.tb.physgun.sync())
  runs.set(c, run)
  return run
}
const rigPose = standPose()

/** where the first-person lens is at t */
const fpLens = (c: ScenarioCtx, t: number): Shot => {
  const r = runs.get(c)!
  const [yaw, pitch] = r.script.look(t)
  const d = dirOf(yaw, pitch, new THREE.Vector3())
  return {
    from: [r.eye.x, r.eye.y, r.eye.z],
    to: [r.eye.x + d.x * 10, r.eye.y + d.y * 10, r.eye.z + d.z * 10],
    // the walk's own default lens (roamPrefs)
    fov: 60,
  }
}

/** a still third-person camera, placed in the scenario's own frame: `back`
    behind the holder, `side` to the right (negative is left), `up` over the
    eye, looking at a point `ahead` along the heading and `lift` over the eye
    (and `across` to the right) */
interface TpFrame {
  back: number
  side: number
  up: number
  ahead: number
  lift: number
  across?: number
  fov?: number
}
const TP_DEFAULT: TpFrame = { back: 11, side: 6, up: 2.6, ahead: 8, lift: 0.8, fov: 58 }

const tpLens = (tp: TpFrame) => (c: ScenarioCtx): Shot => {
  const r = runs.get(c)!
  const y0 = yawOf(c.dx, c.dz)
  const fx = -Math.sin(y0)
  const fz = -Math.cos(y0)
  // the heading's right hand
  const rx = -fz
  const rz = fx
  const a = tp.across ?? 0
  return {
    from: [r.eye.x - fx * tp.back + rx * tp.side, r.eye.y + tp.up, r.eye.z - fz * tp.back + rz * tp.side],
    to: [r.eye.x + fx * tp.ahead + rx * a, r.eye.y + tp.lift, r.eye.z + fz * tp.ahead + rz * a],
    fov: tp.fov ?? 58,
  }
}

const presentFor = (third: boolean) => (c: ScenarioCtx, scene: THREE.Scene, cam: THREE.PerspectiveCamera) => {
  const r = runs.get(c)!
  let body: PlayerRig | null = null
  let handIdx = -1
  const hand = new THREE.Vector3()
  const pose = standPose()
  const env: RagdollEnv = { groundY: c.y, groundAt: terrainY, collision: makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }) }
  if (third) {
    body = buildPlayerBody(EYE, 34)
    scene.add(body.group)
    handIdx = body.limbs.findIndex((l) => l.name === 'handR')
    const [yaw] = r.script.look(0)
    body.face(yaw)
  }
  // the covered compile and first draw, as the game's boot cover does it
  r.tb.stage(cam)
  return {
    frame: (t: number, dt: number, lines: number) => {
      const [yaw, pitch] = r.script.look(t)
      if (body) {
        body.group.position.set(r.eye.x, r.eye.y - EYE, r.eye.z)
        pose.dt = Math.max(dt, 1 / 240)
        pose.yaw = yaw
        pose.pitch = pitch
        pose.aim = 1
        body.update(pose, env)
        body.group.rotation.y = body.facing + Math.PI
        body.group.updateMatrixWorld(true)
        if (handIdx >= 0) body.limbPos(handIdx, hand)
      }
      r.tb.present({
        camera: cam, dt, gait: 0, grounded: true, firstPerson: !third,
        hand: body ? hand : null, active: true, lines,
      })
    },
    warmed: () => r.tb.unstage(),
  }
}

interface GunScenario {
  name: string
  title: string
  duration: number
  frames?: number
  setup: (c: ScenarioCtx) => void
  report?: (c: ScenarioCtx) => string
  /** the third-person twin's camera */
  tp?: Partial<TpFrame>
}

const gunScenario = (g: GunScenario) => {
  for (const third of [false, true]) {
    defineScenario({
      id: `sandbox:physgun-${g.name}${third ? '-3p' : ''}`,
      title: g.title + (third ? ' (third person)' : ''),
      site: siteFlat,
      duration: g.duration,
      frames: g.frames ?? 12,
      camera: (c) => ({ from: [c.x, c.y + EYE, c.z], to: [c.x + c.dx, c.y + EYE, c.z + c.dz], fov: 74 }),
      lens: third ? tpLens({ ...TP_DEFAULT, ...g.tp }) : fpLens,
      setup: g.setup,
      report: g.report,
      present: presentFor(third),
    })
  }
}

/** the prop's speed, peak, while held */
const trackTop = (c: ScenarioCtx, r: Run, id: number) =>
  c.sb.onAfterSlice(() => {
    const p = c.sb.get(id)
    if (!p) return
    const v = p.body.linvel()
    r.memo.top = Math.max(r.memo.top ?? 0, Math.hypot(v.x, v.y, v.z))
  })

/* ------------------------------------------------------------ swing -- */

gunScenario({
  name: 'swing',
  title: 'lift a crate on the beam, swing it round in an arc, freeze it mid-air',
  duration: 6,
  tp: { back: 12, side: 7, up: 3.2, ahead: 6, lift: 1.2, fov: 62 },
  setup: (c) => {
    const y0 = yawOf(c.dx, c.dz)
    const D = 12
    const cx = c.x + c.dx * D
    const cz = c.z + c.dz * D
    const cy = c.sb.restY('crate', cx, cz)
    const id = c.sb.spawn('crate', { x: cx, y: cy, z: cz }, { yaw: y0 + 0.4 })
    c.ids.push(id)
    const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
    // aim at the crate's upper edge: the beam takes the point it hits, so
    // the crate hangs off the beam by that corner
    const p0 = pitchTo(eye, cx, cy + 0.7, cz)
    const r = begin(c, {
      look: (t) => {
        const lift = ease(t, 0.35, 1.1)
        let yaw = y0 + 0.02
        let pitch = p0 + (0.2 - p0) * lift
        // one big arc: round to the left, back across to the right, and
        // home, eased at the turns the way a hand swings a weight
        if (t > 1.2 && t < 4.2) {
          const s = (t - 1.2) / 3
          yaw += 1.2 * Math.sin(2 * Math.PI * s) * Math.pow(Math.sin(Math.PI * s), 0.7)
          pitch += 0.1 * Math.sin(4 * Math.PI * s) * Math.sin(Math.PI * s)
        }
        // after the freeze the view walks away: the crate stays in the air
        yaw -= 0.55 * ease(t, 4.7, 5.6)
        return [yaw, pitch]
      },
      fire: (t) => between(t, 0.3, 4.55),
      alt: (t) => between(t, 4.4, 4.5),
    })
    trackTop(c, r, id)
    c.sb.onAfterSlice(() => {
      const p = c.sb.get(id)
      if (!p) return
      if (r.t > 4.6 && r.memo.fx === undefined) {
        const tr = p.body.translation()
        r.memo.fx = tr.x
        r.memo.fy = tr.y
        r.memo.fz = tr.z
      }
      if (r.memo.fx !== undefined) {
        const tr = p.body.translation()
        r.memo.drift = Math.hypot(tr.x - r.memo.fx, tr.y - r.memo.fy, tr.z - r.memo.fz)
        r.memo.height = tr.y - c.y
      }
    })
  },
  report: (c) => {
    const r = runs.get(c)!
    const p = c.sb.get(c.ids[0])
    return `swing peaked at ${(r.memo.top ?? 0).toFixed(1)} u/s; frozen ${p?.mode === 'frozen' ? 'yes' : 'NO'} ` +
      `${(r.memo.height ?? 0).toFixed(1)} over the grass, drifted ${(r.memo.drift ?? 0).toFixed(4)} after the freeze`
  },
})

/* ----------------------------------------------------------- rotate -- */

gunScenario({
  name: 'rotate',
  title: 'E + mouse turns the held crate, Shift snaps it to the 45-degree grid, freeze, R lets it fall',
  duration: 7,
  tp: { back: 7, side: 7.5, up: 1.8, ahead: 5, lift: 0.6, across: 1, fov: 58 },
  setup: (c) => {
    const y0 = yawOf(c.dx, c.dz)
    const D = 8
    const cx = c.x + c.dx * D
    const cz = c.z + c.dz * D
    const cy = c.sb.restY('crate', cx, cz)
    const id = c.sb.spawn('crate', { x: cx, y: cy, z: cz }, { yaw: y0 + 0.2 })
    c.ids.push(id)
    const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
    const p0 = pitchTo(eye, cx, cy + 0.2, cz)
    const r = begin(c, {
      look: (t) => {
        const pitch = p0 + (0.06 - p0) * ease(t, 0.35, 1.1)
        // after the freeze the view looks off and comes back for the reload
        const yaw = y0 + 0.35 * ease(t, 4.6, 5.1) - 0.35 * ease(t, 5.4, 5.8)
        return [yaw, pitch]
      },
      fire: (t) => between(t, 0.3, 4.35),
      rotate: (t) => between(t, 1.3, 3.9),
      // a slow turn about the view's up, then a tip toward you, then Shift
      turn: (t) => (t < 2.3 ? [340, 0] : t < 3.1 ? [0, 260] : [90, -60]),
      snap: (t) => between(t, 3.3, 3.9),
      alt: (t) => between(t, 4.2, 4.3),
      reload: (t) => between(t, 5.9, 6.0),
    })
    c.sb.onAfterSlice(() => {
      const p = c.sb.get(id)
      if (!p) return
      if (r.t > 3.85 && r.memo.ex === undefined) {
        // how square the snap left it: its orientation in the heading's
        // frame, as yaw, pitch and roll, each against the 45-degree lattice
        const q = p.body.rotation()
        const rel = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -y0)
          .multiply(new THREE.Quaternion(q.x, q.y, q.z, q.w))
        const e = new THREE.Euler().setFromQuaternion(rel, 'YXZ')
        const s = Math.PI / 4
        const off = (a: number) => Math.abs(a - Math.round(a / s) * s)
        r.memo.ex = (Math.max(off(e.x), off(e.y), off(e.z)) * 180) / Math.PI
      }
      if (r.t > 4.4 && r.t < 5.8) r.memo.hang = p.body.translation().y - c.y
      if (r.t > 6.9) r.memo.end = p.body.translation().y - c.y
    })
  },
  report: (c) => {
    const r = runs.get(c)!
    return `snapped to within ${(r.memo.ex ?? -1).toFixed(2)} deg of the 45-degree lattice; hung frozen at ` +
      `${(r.memo.hang ?? 0).toFixed(1)}, ${(r.memo.end ?? 0).toFixed(1)} over the grass after R`
  },
})

/* ------------------------------------------------------------ heavy -- */

gunScenario({
  name: 'heavy',
  title: 'the 900 kg concrete block on the beam: it lags the swing and sails past',
  duration: 6,
  tp: { back: 12, side: 7, up: 3.2, ahead: 6, lift: 0.8, fov: 62 },
  setup: (c) => {
    const y0 = yawOf(c.dx, c.dz)
    const D = 10
    const bx = c.x + c.dx * D
    const bz = c.z + c.dz * D
    const by = c.sb.restY('block', bx, bz)
    const id = c.sb.spawn('block', { x: bx, y: by, z: bz }, { yaw: y0 + Math.PI / 2 })
    c.ids.push(id)
    const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
    const p0 = pitchTo(eye, bx, by + 0.4, bz)
    const r = begin(c, {
      look: (t) => {
        // a quick turn left, a hold, a quick turn right: the block trails
        // each one and swings past where the view stopped
        const yaw = y0 + 0.8 * ease(t, 1.7, 2.1) - 1.4 * ease(t, 3.3, 3.75)
        return [yaw, p0 + (0.08 - p0) * ease(t, 0.4, 1.3)]
      },
      fire: (t) => between(t, 0.3, 5.3),
    })
    c.sb.onAfterSlice(() => {
      const pg = r.tb.physgun
      if (!pg.holding) return
      r.memo.lag = Math.max(r.memo.lag ?? 0, pg.debug.err)
    })
  },
  report: (c) => {
    const r = runs.get(c)!
    return `the block trailed the beam by up to ${(r.memo.lag ?? 0).toFixed(1)} units`
  },
})

/* ------------------------------------------------------------ throw -- */

/** where the throw film stacked its crates */
const homes: Array<[number, number, number]> = []
const ROWS = 4
/** the throw's sweep starts here, and the trigger lets go this far into it */
const T0 = 1.9
// tuned headless (`npm run measure -- physics physgun`): the sweep's
// length, how far into it the trigger is let go, and how much it rises
const REL = 0.155
const SWEEP = 0.35
const LOFT = 0.3

gunScenario({
  name: 'throw',
  title: 'a barrel swung round on the beam and let go: it flies into a stack of crates',
  duration: 5,
  tp: { back: 13, side: -5, up: 6.5, ahead: 9, lift: -1, across: 3, fov: 68 },
  setup: (c) => {
    const y0 = yawOf(c.dx, c.dz)
    const nx = -c.dz
    const nz = c.dx
    // the stack, a tower of crates two wide and four high, well ahead and a
    // little right, where the barrel's arc lets go toward it
    const h = 2.42
    const D = 21
    const wx = c.x + c.dx * D + nx * 4
    const wz = c.z + c.dz * D + nz * 4
    const base = c.sb.restY('crate', wx, wz)
    homes.length = 0
    for (let row = 0; row < ROWS; row++)
      for (let k = 0; k < 2; k++) {
        const col = k - 0.5
        const x = wx + nx * col * (h + 0.04)
        const z = wz + nz * col * (h + 0.04)
        const y = base + row * (h + 0.01)
        c.ids.push(c.sb.spawn('crate', { x, y, z }, { yaw: y0 }))
        homes.push([x, y, z])
      }
    c.memo.wx = wx
    c.memo.wz = wz
    // the barrel stands off to the right, where the swing starts
    const bx = c.x + c.dx * 6 + nx * 4.5
    const bz = c.z + c.dz * 6 + nz * 4.5
    const by = c.sb.restY('barrel', bx, bz)
    const barrel = c.sb.spawn('barrel', { x: bx, y: by, z: bz }, { yaw: y0 })
    c.memo.barrel = barrel
    const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
    const yB = Math.atan2(-(bx - c.x), -(bz - c.z))
    const pB = pitchTo(eye, bx, by + 0.4, bz)
    // lifted and drawn round to the right, then a hard sweep back left that
    // ends looking at the stack, with the trigger let go while the barrel
    // is still out to the right and moving toward it: a throw leaves along
    // the swing's tangent, so it is let go a quarter turn early
    const yStack = Math.atan2(-(wx - c.x), -(wz - c.z))
    const yBack = y0 - 2.1
    const r = begin(c, {
      look: (t) => {
        const k1 = ease(t, 0.4, 1.5)
        let yaw = yB + (yBack - yB) * k1
        let pitch = pB + (0.1 - pB) * k1
        const k2 = ease(t, T0, T0 + SWEEP)
        yaw += (yStack - yBack) * k2
        pitch += (0.05 - 0.1) * k2 + LOFT * Math.sin(Math.PI * k2)
        return [yaw, pitch]
      },
      fire: (t) => between(t, 0.3, T0 + REL),
    })
    trackTop(c, r, barrel)
    // the barrel's closest pass to the stack's middle, and how high it was
    c.sb.onAfterSlice(() => {
      const p = c.sb.get(barrel)
      if (!p || r.t < T0) return
      const tr = p.body.translation()
      const d = Math.hypot(tr.x - wx, tr.z - wz)
      if (d < (r.memo.near ?? 1e9)) {
        r.memo.near = d
        r.memo.nearY = tr.y - base
        // which side it passed: + to the stack's right
        r.memo.nearS = (tr.x - wx) * nx + (tr.z - wz) * nz
      }
    })
    r.tb.physgun.on((e) => {
      if (e.type === 'release') r.memo.left = e.speed
    })
  },
  report: (c) => {
    const r = runs.get(c)!
    // a crate counts as knocked if it ended more than half its size from
    // where it was stacked
    let moved = 0
    const n = c.ids.length
    for (let i = 0; i < n; i++) {
      const p = c.sb.get(c.ids[i])
      if (!p) continue
      const t = p.body.translation()
      const [x, y, z] = homes[i]
      if (Math.hypot(t.x - x, t.y - y, t.z - z) > 1.2) moved++
    }
    return `barrel left the beam at ${(r.memo.left ?? 0).toFixed(0)} u/s (peak ${(r.memo.top ?? 0).toFixed(0)}), ` +
      `passed ${(r.memo.near ?? 0).toFixed(1)} from the stack's middle (${(r.memo.nearS ?? 0).toFixed(1)} across, ` +
      `${(r.memo.nearY ?? 0).toFixed(1)} up), ` +
      `${moved}/${n} crates knocked off the stack`
  },
})

/* ---------------------------------------------------------- ragdoll -- */

gunScenario({
  name: 'ragdoll',
  title: 'a body picked up by the head, swung, pinned in the air, let down',
  duration: 7.5,
  tp: { back: 10, side: 7, up: 3, ahead: 6, lift: 1, fov: 62 },
  setup: (c) => {
    const y0 = yawOf(c.dx, c.dz)
    const px = c.x + c.dx * 8
    const pz = c.z + c.dz * 8
    const rig = buildPlayerBody(EYE, 34)
    const gy = terrainY(px, pz)
    rig.group.position.set(px, gy, pz)
    rig.face(y0 + Math.PI)
    rig.group.rotation.y = rig.facing + Math.PI
    rig.group.updateMatrixWorld(true)
    rig.showHead(true)
    const scene = c.sb.root.parent
    if (scene) scene.add(rig.group)
    const env: RagdollEnv = {
      groundY: gy, groundAt: terrainY,
      collision: makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }),
    }
    // stand it for a beat, so the rig has a real pose to fall out of
    const pose = standPose()
    pose.dt = 1 / 60
    pose.yaw = y0 + Math.PI
    for (let i = 0; i < 30; i++) rig.update(pose, env)
    const head = rig.limbs.findIndex((l) => l.name === 'head')
    const hp = rig.limbPos(Math.max(0, head), new THREE.Vector3())
    const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
    const p0 = pitchTo(eye, hp.x, hp.y, hp.z)
    const yh = Math.atan2(-(hp.x - c.x), -(hp.z - c.z))
    const r = begin(c, {
      look: (t) => {
        let yaw = yh
        let pitch = p0 + (0.32 - p0) * ease(t, 0.45, 1.5)
        if (t > 1.7 && t < 3.9) {
          const s = (t - 1.7) / 2.2
          yaw += 0.8 * Math.sin(2 * Math.PI * s) * Math.sin(Math.PI * s)
        }
        pitch -= 0.1 * ease(t, 4.0, 4.3)
        return [yaw, pitch]
      },
      fire: (t) => between(t, 0.4, 4.6),
      alt: (t) => between(t, 4.45, 4.55),
      reload: (t) => between(t, 5.8, 5.9),
    }, () => [{ key: 'ped', rig }])
    r.rig = rig
    r.rigEnv = env
    c.sb.onAfterSlice(() => {
      if (head < 0) return
      rig.limbPos(head, hp)
      r.memo.top = Math.max(r.memo.top ?? 0, hp.y - gy)
      if (r.t > 4.6 && r.t < 5.7) r.memo.pinned = hp.y - gy
      if (r.t > 7) r.memo.end = hp.y - gy
    })
  },
  report: (c) => {
    const r = runs.get(c)!
    return `head lifted to ${(r.memo.top ?? 0).toFixed(1)} over the grass, pinned at ${(r.memo.pinned ?? 0).toFixed(1)}, ` +
      `${(r.memo.end ?? 0).toFixed(1)} after the thaw`
  },
})
