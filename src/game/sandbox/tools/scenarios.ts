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

  Each scenario here is a `Script` (where the eye is, where it looks, which
  buttons are down, what the wheel and the mouse do) plus a setup that puts
  props in front of it. `gunScenario` turns one into a first-person film
  (the lens *is* the eye, so the viewmodel and the beam are exactly what a
  player sees) and, where asked, a third-person one (the same run watched
  over the shoulder of a real `buildPlayerBody()` holding the gun). The
  script drives the real tool belt through the same `ToolInput` record the
  keyboard fills in the game, one fixed slice at a time, so the physics
  filmed and the physics measured (`npm run measure -- physics scenarios`)
  are the same run.

    npm run film -- sandbox:physgun-swing           grab a crate, swing, turn, freeze
    npm run film -- sandbox:physgun-swing-3p        ...over the shoulder
    npm run film -- sandbox:physgun-heavy           the 900 kg block lagging a swing
    npm run film -- sandbox:physgun-throw           a barrel pushed off the beam into a wall
    npm run film -- sandbox:physgun-ragdoll         a body picked up by the head
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
const notchesAt = (times: number[], dir = 1) => (t0: number, t1: number) =>
  times.reduce((n, at) => n + (at > t0 && at <= t1 ? dir : 0), 0)

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
    fov: 74,
  }
}

/** over the right shoulder, pulled back far enough to see the gun, the beam
    and what it holds */
const tpLens = (c: ScenarioCtx, t: number): Shot => {
  const r = runs.get(c)!
  // the boom does not chase the swing; it keeps the scenario's heading so
  // the swing reads against a still frame
  void t
  const y0 = yawOf(c.dx, c.dz)
  const fx = -Math.sin(y0)
  const fz = -Math.cos(y0)
  const rx = -fz
  const rz = fx
  return {
    from: [r.eye.x - fx * 9 + rx * 4.5, r.eye.y + 2.2, r.eye.z - fz * 9 + rz * 4.5],
    to: [r.eye.x + fx * 7, r.eye.y + 0.5, r.eye.z + fz * 7],
    fov: 62,
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
    handIdx = body.limbs.findIndex((l) => (l as { name?: string }).name === 'handR')
  }
  // the covered compile and first draw, as the game's boot cover does it
  r.tb.stage(cam)
  if (body) body.group.visible = true
  return {
    frame: (t: number, dt: number, lines: number) => {
      const [yaw] = r.script.look(t)
      if (body) {
        body.group.position.set(r.eye.x, r.eye.y - EYE, r.eye.z)
        pose.dt = Math.max(dt, 1 / 60)
        pose.yaw = yaw
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
  /** also register a third-person angle */
  third?: boolean
}

const gunScenario = (g: GunScenario) => {
  for (const third of g.third ? [false, true] : [false]) {
    defineScenario({
      id: `sandbox:physgun-${g.name}${third ? '-3p' : ''}`,
      title: g.title + (third ? ', over the shoulder' : ''),
      site: siteFlat,
      duration: g.duration,
      frames: g.frames ?? 12,
      camera: (c) => ({ from: [c.x, c.y + EYE, c.z], to: [c.x + c.dx, c.y + EYE, c.z + c.dz], fov: 74 }),
      lens: third ? tpLens : fpLens,
      setup: g.setup,
      report: g.report,
      present: presentFor(third),
    })
  }
}

/* ------------------------------------------------------------ swing -- */

gunScenario({
  name: 'swing',
  title: 'grab a crate, swing it, turn it, snap it, freeze it in the air',
  duration: 8,
  third: true,
  setup: (c) => {
    const y0 = yawOf(c.dx, c.dz)
    const cx = c.x + c.dx * 9
    const cz = c.z + c.dz * 9
    const cy = c.sb.restY('crate', cx, cz)
    const id = c.sb.spawn('crate', { x: cx, y: cy, z: cz }, { yaw: y0 + 0.4 })
    c.ids.push(id)
    const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
    // aim a little off the crate's centre: the beam takes the point it hits
    const p0 = pitchTo(eye, cx, cy + 0.5, cz)
    const r = begin(c, {
      look: (t) => {
        const lift = ease(t, 0.35, 1.2)
        let yaw = y0 + 0.05
        let pitch = p0 + (0.14 - p0) * lift
        // one wide swing, left then right, eased in and out
        if (t > 1.3 && t < 3.5) {
          const s = (t - 1.3) / 2.2
          yaw += 1.05 * Math.sin(2 * Math.PI * s) * Math.sin(Math.PI * s)
          pitch += 0.12 * Math.sin(4 * Math.PI * s) * Math.sin(Math.PI * s)
        }
        // after the freeze, the view drifts off: the crate stays put
        yaw += 0.4 * ease(t, 6.4, 7.6)
        return [yaw, pitch]
      },
      fire: (t) => between(t, 0.3, 6.15),
      rotate: (t) => between(t, 4.1, 5.8),
      snap: (t) => between(t, 5.3, 5.8),
      turn: (t) => (t < 4.8 ? [260, 0] : [60, 210]),
      alt: (t) => between(t, 6.0, 6.1),
      wheel: notchesAt([3.55, 3.7, 3.85], -1),
    })
    // how fast the crate moved on the swing, and whether the freeze held
    c.sb.onAfterSlice(() => {
      const p = c.sb.get(id)
      if (!p) return
      const v = p.body.linvel()
      r.memo.top = Math.max(r.memo.top ?? 0, Math.hypot(v.x, v.y, v.z))
      if (r.t > 6.2 && r.memo.fx === undefined) {
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

/* ------------------------------------------------------------ heavy -- */

gunScenario({
  name: 'heavy',
  title: 'the 900 kg block on the beam: it lags the swing and swings past',
  duration: 7,
  setup: (c) => {
    const y0 = yawOf(c.dx, c.dz)
    const bx = c.x + c.dx * 9
    const bz = c.z + c.dz * 9
    const by = c.sb.restY('block', bx, bz)
    const id = c.sb.spawn('block', { x: bx, y: by, z: bz }, { yaw: y0 })
    c.ids.push(id)
    const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
    const p0 = pitchTo(eye, bx, by + 0.4, bz)
    const r = begin(c, {
      look: (t) => {
        const yaw = y0 + 0.9 * ease(t, 1.8, 2.3) - 1.5 * ease(t, 3.8, 4.3)
        return [yaw, p0 + (0.1 - p0) * ease(t, 0.4, 1.4)]
      },
      fire: (t) => between(t, 0.3, 5.9),
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

gunScenario({
  name: 'throw',
  title: 'a barrel shoved off the end of the beam into a pyramid of crates',
  duration: 5,
  third: true,
  setup: (c) => {
    const y0 = yawOf(c.dx, c.dz)
    const nx = c.dz
    const nz = -c.dx
    // the pyramid: three, two, one, twenty-four units out
    const h = 2.4
    const D = 24
    const wx = c.x + c.dx * D
    const wz = c.z + c.dz * D
    const base = c.sb.restY('crate', wx, wz)
    for (let row = 0; row < 3; row++)
      for (let k = 0; k < 3 - row; k++) {
        const col = k - (2 - row) / 2
        const x = wx + nx * col * (h + 0.05)
        const z = wz + nz * col * (h + 0.05)
        c.ids.push(c.sb.spawn('crate', { x, y: base + row * (h + 0.01), z }, { yaw: y0 }))
      }
    const bx = c.x + c.dx * 6 + nx * 1.5
    const bz = c.z + c.dz * 6 + nz * 1.5
    const barrel = c.sb.spawn('barrel', { x: bx, y: c.sb.restY('barrel', bx, bz), z: bz }, { yaw: y0 })
    const eye = new THREE.Vector3(c.x, c.y + EYE, c.z)
    // aimed at the middle row, a touch high for the drop
    const pAim = pitchTo(eye, wx, base + h * 1.1, wz) + 0.02
    const yB = Math.atan2(-(bx - c.x), -(bz - c.z))
    const pB = pitchTo(eye, bx, c.sb.restY('barrel', bx, bz) + 0.5, bz)
    const r = begin(c, {
      look: (t) => {
        const k = ease(t, 0.35, 1.2)
        return [yB + (y0 - yB) * k, pB + (pAim - pB) * k]
      },
      fire: (t) => between(t, 0.3, 1.66),
      // pulled in close, then shoved out hard: the scroll-throw
      wheel: (t0, t1) =>
        notchesAt([0.9, 1.0], -1)(t0, t1) + notchesAt([1.45, 1.47, 1.49, 1.51, 1.53, 1.55, 1.57, 1.59])(t0, t1),
    })
    c.memo.barrel = barrel
    c.sb.onAfterSlice(() => {
      const p = c.sb.get(barrel)
      if (!p) return
      const v = p.body.linvel()
      r.memo.top = Math.max(r.memo.top ?? 0, Math.hypot(v.x, v.y, v.z))
    })
  },
  report: (c) => {
    const r = runs.get(c)!
    let moved = 0
    for (let i = 0; i < c.ids.length; i++) {
      const p = c.sb.get(c.ids[i])
      if (!p) continue
      const row = i < 3 ? 0 : i < 5 ? 1 : 2
      const t = p.body.translation()
      const home = c.sb.restY('crate', t.x, t.z) + row * 2.4
      if (t.y < home - 0.6 || Math.hypot(t.x - (c.x + c.dx * 24), t.z - (c.z + c.dz * 24)) > 4.5) moved++
    }
    return `barrel left the beam at ${(r.memo.top ?? 0).toFixed(0)} u/s, ${moved}/${c.ids.length} crates knocked off the pyramid`
  },
})

/* ---------------------------------------------------------- ragdoll -- */

gunScenario({
  name: 'ragdoll',
  title: 'a body picked up by the head, swung, pinned in the air, let down',
  duration: 7.5,
  third: true,
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
    const head = rig.limbs.findIndex((l) => (l as { name?: string }).name === 'head')
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
