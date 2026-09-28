import * as THREE from 'three'
import { CATALOGUE } from '../catalogue'
import { contraptionOf, type ConstraintType } from '../contraption/contraption'
import { KEY_PAIRS } from '../contraption/parts'
import { historyOf } from '../history'
import { KINDS } from '../kinds'
import type { PropId, Sandbox, Vec3Like } from '../sandbox'

/*
  Blueprints: a build as plain data, and the two verbs that make one.

  A blueprint is the props of a machine (kind, size, weight, whether it is
  frozen, and the settings a part carries) with their poses relative to an
  anchor, and the joints between them in the contraption's own local-frame
  format (`Constraint.frames`, the same seventeen numbers the network
  carries), so a joint never has to be re-derived from where two bodies
  happen to be: it is laid down exactly as it was made. Nothing in it names
  a Rapier body, a mesh or a world position, so it saves, travels and
  validates as JSON (code.ts) and any headless sandbox can paste it.

  The anchor is the middle of the build on the ground plane, and its floor:
  x and z are the centre of the props' bounds and y is the lowest point of any
  of them, so `at` in a paste is "stand this on that spot" and the ghost sits
  on what the crosshair is on. Rotating a paste is a turn about that anchor's
  vertical, which is why poses are stored unrotated (the world frame they
  were copied in) and the yaw is applied on the way out.

  Two verbs. `capture` reads a set of props (everything connected to one, or
  everything in a ball) and their joints out of a live sandbox. `place`
  spawns a blueprint through the ordinary spawn path and joins it, as ONE
  undo entry: the network layer sees plain spawns and joints and treats them
  as it treats any (so the server's per-owner cap, rate limit and
  protection ownership apply unchanged, and the local check below only
  spares a paste that could never fit from arriving in half).

  Headless and DOM-free like the rest of the runtime.
*/

/** the most props a blueprint holds, and joints (a rope-tangled build has
    more joints than props, never more than a few each) */
export const MAX_PROPS = 300
export const MAX_JOINTS = 1200
/** a joint's frames: anchorA(3) anchorB(3) frameB(4) axisA(3) axisB(3) length */
export const FRAME_LEN = 17
/** how many props one player may own on the server (server/src/props.js's
    PROP_CAP); set from the welcome if a room says otherwise */
let propCap = 150
export const setPropCap = (n: number) => {
  propCap = Math.max(1, Math.floor(n))
}
export const getPropCap = () => propCap

/** a build is set down this far over the surface it was aimed at and let
    fall: terrain is not flat under a big plate, and a body that starts a
    hair inside a slope is pushed out at several units a second */
export const DROP = 0.12

export const JOINT_TYPES: readonly ConstraintType[] = ['weld', 'axis', 'rope', 'nocollide']

export interface BpProp {
  kind: string
  scale: number
  /** kilograms, or 0 for the kind's own at that scale */
  mass: number
  frozen: boolean
  /** relative to the anchor, world frame at capture */
  pos: [number, number, number]
  quat: [number, number, number, number]
  /** a part's key pair (KEY_PAIRS index) and whether it is reversed; -1 none */
  keys: number
  flip: boolean
}
export interface BpJoint {
  type: ConstraintType
  /** indices into `props` */
  a: number
  b: number
  frames: number[]
}
export interface Blueprint {
  name: string
  props: BpProp[]
  joints: BpJoint[]
}

/** the kinds a blueprint may name: the catalogue's, which is what the server
    also knows how to relay */
export const isKnownKind = (id: string) => !!KINDS[id] && CATALOGUE.some((e) => e.id === id)

const r3 = (n: number) => Math.round(n * 1000) / 1000
const r4 = (n: number) => Math.round(n * 10000) / 10000

export type CaptureFail = 'empty' | 'toobig'
export type Captured = { ok: true; bp: Blueprint } | { ok: false; reason: CaptureFail }

/** every prop joined to `id` by any joint, itself included, in the order
    found (deterministic: the contraption's own insertion order) */
export const connectedTo = (sb: Sandbox, id: PropId): PropId[] => {
  const con = contraptionOf(sb)
  const out: PropId[] = [id]
  const seen = new Set<PropId>([id])
  for (let i = 0; i < out.length; i++) {
    for (const c of con.constraints(out[i])) {
      const o = c.a === out[i] ? c.b : c.a
      if (seen.has(o) || !sb.get(o)) continue
      seen.add(o)
      out.push(o)
    }
  }
  return out
}

/** every prop within `radius` of a point */
export const propsWithin = (sb: Sandbox, at: Vec3Like, radius: number): PropId[] => {
  const ids: PropId[] = []
  sb.queryBall(at, radius, (p) => ids.push(p.id))
  return ids.sort((a, b) => a - b)
}

export function capture(sb: Sandbox, ids: readonly PropId[], name = ''): Captured {
  const list = [...new Set(ids)].filter((id) => {
    const p = sb.get(id)
    return !!p && isKnownKind(p.kind.id)
  })
  if (!list.length) return { ok: false, reason: 'empty' }
  if (list.length > MAX_PROPS) return { ok: false, reason: 'toobig' }
  const con = contraptionOf(sb)
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const m = new THREE.Matrix4()
  const rows: Array<{ p: NonNullable<ReturnType<Sandbox['get']>>; x: number; y: number; z: number; q: THREE.Quaternion; low: number }> = []
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let floor = Infinity
  for (const id of list) {
    const p = sb.get(id)!
    sb.getTransform(id, pos, quat)
    m.makeRotationFromQuaternion(quat)
    const e = m.elements
    const ex = p.extents
    // the half height the rotated bounding box reaches down: |row y of R| . e
    const half = Math.abs(e[1]) * ex.x + Math.abs(e[5]) * ex.y + Math.abs(e[9]) * ex.z
    const hx = Math.abs(e[0]) * ex.x + Math.abs(e[4]) * ex.y + Math.abs(e[8]) * ex.z
    const hz = Math.abs(e[2]) * ex.x + Math.abs(e[6]) * ex.y + Math.abs(e[10]) * ex.z
    minX = Math.min(minX, pos.x - hx)
    maxX = Math.max(maxX, pos.x + hx)
    minZ = Math.min(minZ, pos.z - hz)
    maxZ = Math.max(maxZ, pos.z + hz)
    floor = Math.min(floor, pos.y - half)
    rows.push({ p, x: pos.x, y: pos.y, z: pos.z, q: quat.clone(), low: pos.y - half })
  }
  const ax = (minX + maxX) / 2
  const az = (minZ + maxZ) / 2
  const index = new Map<PropId, number>()
  const props: BpProp[] = rows.map((r, i) => {
    index.set(r.p.id, i)
    const st = con.part(r.p.id)
    const own = r.p.kind.mass * r.p.scale * r.p.scale * r.p.scale
    return {
      kind: r.p.kind.id,
      scale: r3(r.p.scale),
      mass: Math.abs(r.p.mass - own) > own * 0.01 + 1e-3 ? r3(r.p.mass) : 0,
      frozen: r.p.mode !== 'dynamic',
      pos: [r3(r.x - ax), r3(r.y - floor), r3(r.z - az)],
      quat: [r4(r.q.x), r4(r.q.y), r4(r.q.z), r4(r.q.w)],
      keys: st ? st.keys : -1,
      flip: st ? st.flip : false,
    }
  })
  const joints: BpJoint[] = []
  const seen = new Set<number>()
  for (const id of list) {
    for (const c of con.constraints(id)) {
      if (seen.has(c.id)) continue
      const a = index.get(c.a)
      const b = index.get(c.b)
      if (a === undefined || b === undefined) continue
      seen.add(c.id)
      if (joints.length < MAX_JOINTS) joints.push({ type: c.type, a, b, frames: c.frames.map(r4) })
    }
  }
  return { ok: true, bp: { name: name.trim().slice(0, 40), props, joints } }
}

export interface PlaceOpts {
  /** the anchor in the world: the floor under the middle of the build */
  at: Vec3Like
  /** a turn about the vertical, radians */
  yaw?: number
  /** how the entry reads on the undo list; defaults to the blueprint's name */
  label?: string
}
export type PlaceFail = 'empty' | 'toobig' | 'limit' | 'notready' | 'kind'
export type Placed = { ok: true; ids: PropId[]; joints: number } | { ok: false; reason: PlaceFail; room?: number }

/** how many more props this player can put into the world */
export const roomFor = (sb: Sandbox): number => {
  if (!sb.network?.online) return Infinity
  return Math.max(0, propCap - historyOf(sb).propsOf().length)
}

export function place(sb: Sandbox, bp: Blueprint, o: PlaceOpts): Placed {
  if (!bp.props.length) return { ok: false, reason: 'empty' }
  if (bp.props.length > MAX_PROPS) return { ok: false, reason: 'toobig' }
  if (!sb.ready) return { ok: false, reason: 'notready' }
  const room = roomFor(sb)
  if (bp.props.length > room) return { ok: false, reason: 'limit', room }
  if (bp.props.some((p) => !isKnownKind(p.kind))) return { ok: false, reason: 'kind' }
  const yaw = o.yaw ?? 0
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
  const v = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const con = contraptionOf(sb)
  const ids: PropId[] = []
  for (const p of bp.props) {
    v.set(p.pos[0], p.pos[1], p.pos[2]).applyQuaternion(qy)
    q.set(p.quat[0], p.quat[1], p.quat[2], p.quat[3]).premultiply(qy)
    const data = p.keys >= 0 ? { part: { keys: p.keys, flip: p.flip } } : undefined
    ids.push(sb.spawn(p.kind, { x: o.at.x + v.x, y: o.at.y + v.y + DROP, z: o.at.z + v.z }, {
      quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
      scale: p.scale,
      mass: p.mass > 0 ? p.mass : undefined,
      frozen: p.frozen,
      data,
    }))
  }
  let joints = 0
  for (const j of bp.joints) {
    if (con.add(j.type, ids[j.a], ids[j.b], { frames: j.frames })) joints++
  }
  const label = (o.label ?? bp.name) || ''
  historyOf(sb).record({
    label: label
      ? { en: `build "${label}" (${ids.length})`, es: `construcción "${label}" (${ids.length})` }
      : { en: `build (${ids.length} props)`, es: `construcción (${ids.length} objetos)` },
    props: ids,
  })
  return { ok: true, ids, joints }
}

/** a KEY_PAIRS index that is legal, or -1 */
export const legalKeys = (n: unknown): number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < KEY_PAIRS.length ? n : -1
