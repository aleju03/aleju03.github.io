import * as THREE from 'three'
import { BatchProxy } from '../sandbox/batch'
import { geometryFor, specOf, type ModelSpec, type PartSpec } from './models'
import { S, type RenderCreature } from './sim'

/*
  Drawing the creatures: parts as instances on the props' one material.

  Every part of every creature is a `BatchProxy` (sandbox/batch.ts) added to
  the sandbox's root, a cheap Object3D that draws nothing itself: the
  sandbox's own batcher, once a frame, groups them by geometry and writes
  their matrices into one InstancedMesh per shape. So a dozen pigs and a
  zombie are a few draws, they cast and receive shadows like any prop, they go
  through the pixel look like any prop, and **no shader program is linked for
  them that the crates had not already linked** (the instanced variant of the
  atlas material is compiled under the loading card with the sandbox). The
  hit flash is the proxy's `tint`, the same multiplier the physgun uses to
  flash what it froze.

  This module only animates. Where a creature is, how fast it is going, and
  whether it is hurt, dying or burning come from a `RenderCreature`, whoever
  simulated it (sim.ts on the host, net/remoteCreatures.ts everywhere else),
  so the same walk cycle, head turn and tumble play on every screen. Each
  creature keeps a little animation state of its own (the cycle's phase, the
  head's turn, how far it has fallen) keyed by id.

  - **Walk cycle.** Legs and arms swing about their pivot in proportion to the
    distance walked, so a pig at a trot swings fast and one shoved along
    swings with its speed, and the swing eases to nothing when it stops.
  - **The head** turns toward the nearest player within a few blocks and
    lowers to graze while a grazing kind idles.
  - **A hit** flashes the whole creature red for a fifth of a second; a
    burning one flickers orange; a creeper swells and blinks white as its
    fuse runs.
  - **Death** tips the body over onto its side and lets it sink and shrink
    away (a fallen mannequin lies on its back, and gets back up, reversing).
*/

const AXIS_Y = new THREE.Vector3(0, 1, 0)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)
const ONE = new THREE.Vector3(1, 1, 1)
const FLASH = new THREE.Color(1.9, 0.4, 0.38)
const FIRE_A = new THREE.Color(1.7, 0.8, 0.3)
const FIRE_B = new THREE.Color(1.3, 0.45, 0.2)
const WHITE = new THREE.Color(1.8, 1.8, 1.8)
/** mannequins' Sunday best */
const SUITS = ['#5a6f8f', '#8f5a5a', '#5f7f66', '#8f7f5a', '#6d5a8f', '#3f4f6a', '#a07068', '#7a8f9a']

interface Rig {
  spec: ModelSpec
  proxies: BatchProxy[]
  base: THREE.Color[]
  phase: number
  swing: number
  headYaw: number
  headPitch: number
  wing: number
  /** 0 upright .. 1 fallen, eased */
  fall: number
  seed: number
  scaleK: number
  vary: number
  dressed: THREE.Color | null
}

const hashOf = (id: number) => {
  let h = (id * 2654435761) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const wrap = (a: number) => {
  const t = Math.PI * 2
  a %= t
  if (a > Math.PI) a -= t
  else if (a < -Math.PI) a += t
  return a
}
const ease = (a: number, b: number, k: number) => a + (b - a) * k

export interface LookTarget {
  x: number
  y: number
  z: number
}

export interface CreatureView {
  /** pose every creature in the list, and retire the ones no longer in it */
  update: (list: readonly RenderCreature[], dt: number, time: number, looks: readonly LookTarget[]) => void
  /** how many creatures and parts are drawn */
  readonly stats: { creatures: number; parts: number }
  dispose: () => void
}

const q1 = new THREE.Quaternion()
const q2 = new THREE.Quaternion()
const qRoot = new THREE.Quaternion()
const m0 = new THREE.Matrix4()
const m1 = new THREE.Matrix4()
const m2 = new THREE.Matrix4()
const v0 = new THREE.Vector3()
const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()
const col = new THREE.Color()

export function createCreatureView(root: THREE.Object3D): CreatureView {
  const rigs = new Map<number, Rig>()
  const stats = { creatures: 0, parts: 0 }

  const build = (r: RenderCreature): Rig => {
    const spec = specOf(r.kind.id)
    const seed = hashOf(r.id)
    const proxies: BatchProxy[] = []
    const base: THREE.Color[] = []
    const dressed = r.kind.id === 'walker' ? new THREE.Color(SUITS[r.id % SUITS.length]) : null
    for (const p of spec.parts) {
      const proxy = new BatchProxy(geometryFor(p.geo))
      proxy.tint = new THREE.Color()
      proxy.name = `mob-${r.kind.id}`
      root.add(proxy)
      proxies.push(proxy)
      base.push(new THREE.Color(p.tint))
    }
    return {
      spec, proxies, base, phase: seed * 6, swing: 0, headYaw: 0, headPitch: 0, wing: 0, fall: 0, seed,
      scaleK: 1, vary: 0.94 + seed * 0.12, dressed,
    }
  }

  const retire = (rig: Rig) => {
    for (const p of rig.proxies) p.removeFromParent()
  }

  const tintOf = (rig: Rig, r: RenderCreature, index: number, part: PartSpec, out: THREE.Color, time: number) => {
    out.copy(rig.base[index])
    if (rig.dressed && (part.geo === 'mob_cloth')) {
      // legs and torso in the suit, arms a shade off it
      out.copy(rig.dressed)
      if (part.joint === 'leg') out.multiplyScalar(0.7)
      else if (part.joint === 'arm') out.multiplyScalar(0.9)
    }
    out.multiplyScalar(rig.vary)
    if (r.hurtT < 0.22) out.lerp(FLASH, 1 - r.hurtT / 0.22)
    else if (r.burning) out.lerp(Math.sin(time * 30 + rig.seed * 9) > 0 ? FIRE_A : FIRE_B, 0.55)
    if (r.kind.behaviour === 'creeper' && r.st === S.ACT && r.deadT < 0) {
      // the fuse: white blinks, quicker as it runs down
      const rate = 6 + r.stT * 10
      if (Math.sin(time * rate) > 0.2) out.lerp(WHITE, 0.6)
    }
  }

  return {
    stats,
    update: (list, dt, time, looks) => {
      let parts = 0
      const seen = new Set<number>()
      for (const r of list) {
        seen.add(r.id)
        let rig = rigs.get(r.id)
        if (!rig) {
          rig = build(r)
          rigs.set(r.id, rig)
        }
        const spec = rig.spec
        const dead = r.deadT >= 0
        // ---- walk cycle
        const moving = !dead && r.speed > 0.25
        rig.swing = ease(rig.swing, moving ? Math.min(1, 0.35 + r.speed * 0.18) : 0, Math.min(1, dt * 9))
        rig.phase += r.speed * dt * spec.stride
        // ---- the head: look at somebody near, graze when idle
        let ty = 0
        let tp = 0
        if (!dead) {
          let best = 14 * 14
          for (const l of looks) {
            const d = (l.x - r.x) ** 2 + (l.z - r.z) ** 2
            if (d < best) {
              best = d
              ty = Math.max(-1.1, Math.min(1.1, wrap(Math.atan2(l.z - r.z, l.x - r.x) - r.yaw)))
              // (the yaw convention: heading is atan2(z, x), the model's turn is its negative)
              ty = -ty
              tp = Math.max(-0.3, Math.min(0.35, Math.atan2(l.y + 3.5 - (r.y + r.kind.h), Math.sqrt(d))))
            }
          }
          if (spec.grazes && r.st === S.IDLE && ((time * 0.13 + rig.seed) % 1) > 0.62) {
            tp = -0.75
            ty *= 0.3
          }
          if (r.st === S.FLEE) tp = 0.12
        }
        const hk = Math.min(1, dt * 7)
        rig.headYaw = ease(rig.headYaw, ty, hk)
        rig.headPitch = ease(rig.headPitch, tp, hk)
        rig.wing = ease(rig.wing, moving && r.st === S.FLEE ? 1 : 0, Math.min(1, dt * 8))
        // ---- falling over and getting up
        let target = 0
        if (dead) {
          const revive = r.kind.revive
          target = revive && r.deadT > revive - 0.8 ? 0 : 1
        }
        rig.fall = ease(rig.fall, target, Math.min(1, dt * (dead ? 9 : 4)))
        // ---- the root
        const bob = spec.bob && moving ? Math.abs(Math.sin(rig.phase * 1.3)) * spec.bob : 0
        let scale = 1
        if (r.kind.behaviour === 'creeper' && r.st === S.ACT && !dead) scale = 1 + 0.32 * Math.min(1, r.stT / 1.5)
        let sink = 0
        if (dead && !r.kind.revive) {
          const t = Math.max(0, r.deadT - 0.9)
          scale *= Math.max(0.001, 1 - t / 0.7)
          sink = -t * 0.6
        }
        qRoot.setFromAxisAngle(AXIS_Y, -r.yaw)
        const lay = rig.fall * (Math.PI / 2)
        if (r.kind.behaviour === 'walker') q1.setFromAxisAngle(AXIS_Z, lay)
        else q1.setFromAxisAngle(AXIS_X, lay * (rig.seed < 0.5 ? 1 : -1))
        qRoot.multiply(q1)
        // a body lying down rests on its side: lift it by half its thickness
        const lift = rig.fall * r.kind.r * 0.9
        const arrow = r.kind.behaviour === 'arrow'
        if (arrow) {
          // pitched along its flight
          const sp = Math.max(0.001, Math.hypot(r.speed, r.vy))
          qRoot.setFromAxisAngle(AXIS_Y, -r.yaw)
          q1.setFromAxisAngle(AXIS_Z, Math.atan2(r.vy, Math.max(0.0001, r.speed || sp)))
          qRoot.multiply(q1)
        }
        v0.set(r.x, r.y + bob + lift + sink, r.z)
        m0.compose(v0, qRoot, v1.set(scale, scale, scale))
        for (let i = 0; i < spec.parts.length; i++) {
          const p = spec.parts[i]
          const proxy = rig.proxies[i]
          // joint rotation about the part's pivot
          q2.identity()
          switch (p.joint) {
            case 'leg':
              q2.setFromAxisAngle(AXIS_Z, Math.sin(rig.phase + (p.phase ?? 0)) * spec.swing * rig.swing)
              break
            case 'arm': {
              const rest = (p.rest ?? 0) * (r.st === S.ACT && spec.armsOut && r.kind.behaviour === 'skeleton' ? 7 : 1)
              q2.setFromAxisAngle(AXIS_Z, rest + Math.sin(rig.phase + (p.phase ?? 0)) * spec.swing * 0.5 * rig.swing)
              break
            }
            case 'head': {
              q1.setFromAxisAngle(AXIS_Y, rig.headYaw)
              q2.setFromAxisAngle(AXIS_Z, rig.headPitch)
              q2.premultiply(q1)
              break
            }
            case 'wing':
              q2.setFromAxisAngle(AXIS_X, (p.at[2] > 0 ? -1 : 1) * (0.25 + rig.wing * (0.9 + 0.5 * Math.sin(time * 40))))
              break
            default:
          }
          const at = p.at
          const c = p.center
          const pivot = p.joint === 'head' ? spec.headAt : at
          v1.set(pivot[0], pivot[1], pivot[2])
          m1.compose(v1, q2, ONE)
          // the head's attachments hang from the head pivot, so their own
          // offset from it is folded into the centre
          if (p.joint === 'head') {
            v2.set(at[0] - pivot[0] + (c?.[0] ?? 0), at[1] - pivot[1] + (c?.[1] ?? 0), at[2] - pivot[2] + (c?.[2] ?? 0))
          } else v2.set(c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0)
          m2.compose(v2, q1.identity(), v0.set(p.size[0], p.size[1], p.size[2]))
          m1.premultiply(m0).multiply(m2)
          m1.decompose(proxy.position, proxy.quaternion, proxy.scale)
          tintOf(rig, r, i, p, col, time)
          proxy.tint!.copy(col)
          proxy.visible = true
          parts++
        }
      }
      for (const [id, rig] of rigs) {
        if (seen.has(id)) continue
        retire(rig)
        rigs.delete(id)
      }
      stats.creatures = rigs.size
      stats.parts = parts
    },
    dispose: () => {
      for (const rig of rigs.values()) retire(rig)
      rigs.clear()
    },
  }
}
