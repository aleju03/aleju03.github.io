import * as THREE from 'three'
import { historyOf } from '../history'
import type { PropId, Sandbox, Vec3Like } from '../sandbox'
import { contraptionOf } from './contraption'
import { WHEEL } from './parts'

/*
  Three machines built by script, the way a player builds them with the tool
  gun: spawn a frozen chassis, set each part down on the face it goes on
  (`snapOnto`, the tool gun's own placing), join it there (`add`, the tool
  gun's own weld and axis), and let the chassis go. Nothing here is a
  shortcut the tool does not take, which is the point: the films, the
  headless measure and the drive harness all exercise the same two calls a
  click does.

    buildCar     a chassis plate on four wheels, a seat, two thrusters at
                 the back: sit in it and WASD drives, space boosts
    buildRocket  a long beam standing on a small plate with four thrusters
                 under it, all on the thrusters' default key (i)
    buildHover   a square plate on four hoverballs with a seat and two
                 thrusters: the thing to fly on the Moon

  Each is one undo entry (Z takes the whole machine back) and returns its
  ids. The frame is the walk's: yaw 0 builds it facing -Z.
*/

export interface Built {
  ids: PropId[]
  chassis: PropId
  seat: PropId | null
  wheels: PropId[]
  thrusters: PropId[]
  hoverballs: PropId[]
}

const frame = (yaw: number) => ({
  f: new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)),
  r: new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
  up: new THREE.Vector3(0, 1, 0),
})

const record = (sb: Sandbox, b: Built, en: string, es: string) => {
  historyOf(sb).record({ label: { en, es }, props: b.ids })
  return b
}

/** set a freshly spawned part on a face and join it there */
const mount = (
  sb: Sandbox, kind: string, base: PropId, at: THREE.Vector3, n: THREE.Vector3,
  how: 'weld' | 'axis', view?: THREE.Vector3,
): PropId => {
  const c = contraptionOf(sb)
  const id = sb.spawn(kind, { x: at.x + n.x * 2, y: at.y + n.y * 2, z: at.z + n.z * 2 })
  c.snapOnto(id, at, n, view)
  c.add(how, id, base, { forward: view })
  return id
}

export const buildCar = (sb: Sandbox, at: Vec3Like, yaw = 0): Built => {
  const { f, r, up } = frame(yaw)
  const gy = sb.groundY(at.x, at.z)
  const C = new THREE.Vector3(at.x, gy + WHEEL.r + 0.25, at.z)
  const chassis = sb.spawn('plate_l', C, { yaw, frozen: true })
  const b: Built = { ids: [chassis], chassis, seat: null, wheels: [], thrusters: [], hoverballs: [] }
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      p.copy(C).addScaledVector(r, sx * 2.4).addScaledVector(f, sz * 3.2)
      n.copy(r).multiplyScalar(sx)
      b.wheels.push(mount(sb, 'wheel', chassis, p, n, 'axis', f))
    }
  }
  p.copy(C).addScaledVector(up, 0.12).addScaledVector(f, -0.8)
  b.seat = mount(sb, 'seat', chassis, p, up, 'weld', f)
  for (const sx of [-1, 1]) {
    p.copy(C).addScaledVector(f, -4.8).addScaledVector(r, sx * 1.3)
    n.copy(f).negate()
    b.thrusters.push(mount(sb, 'thruster', chassis, p, n, 'weld'))
  }
  b.ids.push(...b.wheels, b.seat, ...b.thrusters)
  sb.unfreeze(chassis)
  return record(sb, b, 'parts car', 'auto de piezas')
}

export const buildRocket = (sb: Sandbox, at: Vec3Like, yaw = 0): Built => {
  const { f, r, up } = frame(yaw)
  const gy = sb.groundY(at.x, at.z)
  // the base plate, high enough for four thrusters to stand under it
  const B = new THREE.Vector3(at.x, gy + 1.4 + 0.1 + 0.1, at.z)
  const base = sb.spawn('plate_s', B, { yaw, frozen: true })
  const b: Built = { ids: [base], chassis: base, seat: null, wheels: [], thrusters: [], hoverballs: [] }
  // the body: a long beam stood on end in the middle of the plate
  const q = new THREE.Quaternion().setFromAxisAngle(up, yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2))
  const body = sb.spawn('beam_l', { x: B.x, y: B.y + 0.1 + 4.8, z: B.z }, { quaternion: q })
  contraptionOf(sb).add('weld', body, base)
  const p = new THREE.Vector3()
  const down = new THREE.Vector3(0, -1, 0)
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    p.copy(B).addScaledVector(up, -0.1).addScaledVector(r, sx * 0.62).addScaledVector(f, sz * 0.62)
    b.thrusters.push(mount(sb, 'thruster', base, p, down, 'weld'))
  }
  b.ids.push(body, ...b.thrusters)
  return record(sb, b, 'parts rocket', 'cohete de piezas')
}

export const buildHover = (sb: Sandbox, at: Vec3Like, yaw = 0): Built => {
  const { f, r, up } = frame(yaw)
  const gy = sb.groundY(at.x, at.z)
  const C = new THREE.Vector3(at.x, gy + 1.2 + 0.1 + 0.15, at.z)
  const deck = sb.spawn('plate_m', C, { yaw, frozen: true })
  const b: Built = { ids: [deck], chassis: deck, seat: null, wheels: [], thrusters: [], hoverballs: [] }
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  const down = new THREE.Vector3(0, -1, 0)
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    p.copy(C).addScaledVector(up, -0.1).addScaledVector(r, sx * 1.7).addScaledVector(f, sz * 1.7)
    b.hoverballs.push(mount(sb, 'hoverball', deck, p, down, 'weld'))
  }
  p.copy(C).addScaledVector(up, 0.1)
  b.seat = mount(sb, 'seat', deck, p, up, 'weld', f)
  for (const sx of [-1, 1]) {
    p.copy(C).addScaledVector(f, -2.4).addScaledVector(r, sx * 1.2)
    n.copy(f).negate()
    b.thrusters.push(mount(sb, 'thruster', deck, p, n, 'weld'))
  }
  b.ids.push(...b.hoverballs, b.seat, ...b.thrusters)
  sb.unfreeze(deck)
  return record(sb, b, 'parts hovercraft', 'aerodeslizador de piezas')
}
