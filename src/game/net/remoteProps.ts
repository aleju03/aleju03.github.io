/*
 * Shared sandbox bodies, without sockets or React. One store spans the
 * scene's level sandboxes. The browser supplies transport and arrivals;
 * sandbox ticks supply the clock. Owners may edit, authorities simulate,
 * and all other copies are kinematic playback two ticks behind.
 *
 * Local ids never travel as identities. A spawn nonce maps the optimistic
 * body to the server id; pending spawns remain kinematic until accepted.
 * Claims stop the old simulator and acknowledge its final pose and velocity
 * before the server enables the next. Break debris is cosmetic, using the
 * existing particle pools rather than another set of network rigid bodies.
 * A peer's blast is replayed here flagged `remote`: it pushes the bodies
 * this client simulates and cracks the buildings it has (remoteDamage.ts
 * keeps those agreeing), and it is never sent back.
 */
import * as THREE from 'three'
import type { Sandbox, Prop } from '../sandbox/sandbox'
import { catalogueEntry } from '../sandbox/catalogue'
import { contraptionOf } from '../sandbox/contraption/contraption'
import { breakSound } from '../sandbox/impactSounds'
import type { NetProp, NetJoint, PropPose, PropClientMessage, PropServerMessage } from './propProtocol'
import type { WorldServerMessage } from './protocol'

interface Body {
  net: NetProp
  local: number
  samples: Array<{ at: number; row: PropPose }>
  last: string
  meta: string
}
interface LevelState {
  name: string
  sb: Sandbox | null
  ready: boolean
  bodies: Map<number, Body>
  local: Map<number, Body>
  pending: Map<number, { row: PropPose; removed: boolean }>
  joints: Map<number, number>
  jointSent: Set<number>
  queue: PropServerMessage[]
  next: number
  applying: boolean
  claims: Map<number, number>
  acknowledgements: PropPose[]
  kicks: Map<number, { x: number; y: number; z: number }>
}
export interface PropNetwork {
  attach: (sb: Sandbox, level: string) => void
  receive: (m: WorldServerMessage) => void
  offline: () => void
  setLevel: (name: string) => void
}
const position = (r: PropPose) => ({ x: r[2] / 100, y: r[3] / 100, z: r[4] / 100 })
const rotation = (r: PropPose) => new THREE.Quaternion(r[5] / 10000, r[6] / 10000, r[7] / 10000, r[8] / 10000).normalize()
const velocity = (r: PropPose, offset: number) => ({ x: (r[offset] ?? 0) / 100, y: (r[offset + 1] ?? 0) / 100, z: (r[offset + 2] ?? 0) / 100 })
const pack = (p: Prop, id: number, epoch: number, tail = false): PropPose => {
  const t = p.body.translation(), q = p.body.rotation()
  const r = [id, epoch, ...[t.x, t.y, t.z].map((v) => Math.round(v * 100)),
    ...[q.x, q.y, q.z, q.w].map((v) => Math.round(v * 10000)),
    (p.mode === 'frozen' ? 1 : 0) | (p.body.isSleeping() || p.parked ? 2 : 0) | (p.data.netTeleport ? 4 : 0)]
  if (tail) {
    const v = p.body.linvel(), w = p.body.angvel()
    r.push(...[v.x, v.y, v.z, w.x, w.y, w.z].map((n) => Math.round(n * 100)))
  }
  return r
}

export function createPropNetwork(send: (m: PropClientMessage) => void, notify: (en: string, es: string) => void = () => {}, now = () => performance.now()): PropNetwork {
  const levels = new Map<string, LevelState>()
  let you = 0
  let active = ''
  let delay = 132
  const state = (name: string): LevelState => {
    let l = levels.get(name)
    if (!l) {
      l = { name, sb: null, ready: false, bodies: new Map(), local: new Map(), pending: new Map(), joints: new Map(), jointSent: new Set(), queue: [], next: 0, applying: false, claims: new Map(), acknowledgements: [], kicks: new Map() }
      levels.set(name, l)
    }
    return l
  }
  const apply = (l: LevelState, fn: () => void) => {
    const was = l.applying
    l.applying = true
    try { fn() } finally { l.applying = was }
  }
  const authority = (l: LevelState, id: number) => {
    if (l.applying) return true
    const b = l.local.get(id)
    if (b) return !!you && active === l.name && l.ready && b.net.authority === you && !b.net.transfer
    return !l.pending.has(id)
  }
  const place = (sb: Sandbox, b: Body, r: PropPose) => {
    sb.setTransform(b.local, position(r), rotation(r))
    sb.setVelocity(b.local, velocity(r, 10), velocity(r, 13))
  }
  const adopt = (l: LevelState, n: NetProp, nonce?: number) => {
    const sb = l.sb!
    let b = l.bodies.get(n.id)
    const pending = n.owner === you && nonce !== undefined ? l.pending.get(nonce) : undefined
    const wasMine = b?.net.authority === you && !b?.net.transfer
    const changedAuthority = !b || b.net.authority !== n.authority || b.net.epoch !== n.epoch || !!b.net.transfer !== !!n.transfer
    let ack: PropPose | null = null
    if (b && n.transfer?.waiting === you && wasMine) {
      const p = sb.get(b.local)
      ack = p ? pack(p, n.id, n.epoch, true) : n.pose
    }
    if (!b) {
      let id: number
      if (pending && sb.get(nonce!)) id = nonce!
      else id = sb.spawn(n.kind, position(n.pose), { scale: n.scale, mass: n.mass, quaternion: rotation(n.pose), data: { net: true } })
      b = { net: n, local: id, samples: [], last: '', meta: '' }
      l.bodies.set(n.id, b); l.local.set(id, b)
      if (nonce !== undefined && pending) l.pending.delete(nonce)
    }
    b.net = n
    const p = sb.get(b.local)
    if (!p) {
      if (ack) l.acknowledgements.push(ack)
      return
    }
    p.data.net = n.id
    p.data.owner = n.owner
    const mine = n.authority === you && !n.transfer
    if (changedAuthority) {
      // The revoke acknowledges the actual final state, not the older server
      // row. Everyone freezes while that last state crosses the wire.
      place(sb, b, ack ?? n.pose)
      sb.setMode(b.local, mine ? (n.pose[9] & 1 ? 'frozen' : 'dynamic') : 'kinematic')
      if (mine) {
        if (pending) sb.setVelocity(b.local, velocity(pending.row, 10), velocity(pending.row, 13))
        else sb.setVelocity(b.local, velocity(n.pose, 10), velocity(n.pose, 13))
        if (n.pose[9] & 2) p.body.sleep()
        const kick = l.kicks.get(b.local)
        if (kick) { sb.applyImpulse(b.local, kick); l.kicks.delete(b.local) }
        b.last = ''; b.meta = ''
      }
      b.samples = [{ at: now() - delay, row: ack ?? n.pose }]
    }
    const part = contraptionOf(sb).part(b.local)
    if (part && n.part && !wasMine) {
      part.keys = n.part[0]; part.flip = !!n.part[1]; part.target = n.part[2]; part.fire = n.part[3]
    }
    if (n.life && !wasMine) {
      const life = (p.data.life ??= {}) as Record<string, number>
      ;[life.hp, life.fuse, life.boom, life.lit] = n.life
    }
    if (ack) l.acknowledgements.push(ack)
    if (pending?.removed) send({ type: 'world-prop-remove', level: active, id: n.id })
  }
  const joint = (l: LevelState, j: NetJoint, nonce?: number) => {
    if (l.joints.has(j.id)) return
    const sb = l.sb!, c = contraptionOf(sb)
    const a = l.bodies.get(j.a), b = l.bodies.get(j.b)
    if (!a || !b) return
    const existing = nonce !== undefined && a.net.owner === you ? c.constraints().find((r) => r.id === nonce && r.a === a.local && r.b === b.local) : undefined
    const r = existing ?? c.add(j.kind, a.local, b.local, { frames: j.frames })
    if (r) { l.joints.set(j.id, r.id); l.jointSent.add(r.id) }
  }
  const receive = (m: PropServerMessage) => {
    const l = state(m.level)
    if (!l.sb?.ready) { l.queue.push(m); return }
    const sb = l.sb
    apply(l, () => {
      switch (m.type) {
        case 'world-prop-snapshot':
          active = m.level
          for (const id of l.pending.keys()) sb.remove(id)
          l.pending.clear()
          for (const b of l.bodies.values()) sb.remove(b.local)
          l.bodies.clear(); l.local.clear(); l.joints.clear(); l.jointSent.clear()
          l.ready = true
          for (const p of m.props) adopt(l, p)
          for (const j of m.joints) joint(l, j)
          break
        case 'world-prop-spawn': adopt(l, m.prop, m.nonce); break
        case 'world-prop-state': for (const p of m.props) adopt(l, p); break
        case 'world-prop-move':
          for (const row of m.rows) {
            const b = l.bodies.get(row[0])
            if (!b || row[1] !== b.net.epoch || b.net.transfer) continue
            b.net.pose = row
            if (b.net.authority === you) continue
            if (row[9] & 4) { b.samples = []; place(sb, b, row) }
            b.samples.push({ at: now() - (row[9] & 4 ? delay : 0), row })
            if (b.samples.length > 12) b.samples.shift()
          }
          break
        case 'world-prop-remove':
          for (const id of m.ids) {
            const b = l.bodies.get(id)
            if (!b) continue
            sb.remove(b.local); l.local.delete(b.local); l.bodies.delete(id)
            l.claims.delete(b.local); l.kicks.delete(b.local)
          }
          break
        case 'world-prop-hit': {
          const b = l.bodies.get(m.id)
          if (b?.net.authority === you && !b.net.transfer) {
            l.applying = false
            try {
              if (m.ignite) sb.ignite(b.local)
              else sb.damage(b.local, m.amount)
            } finally { l.applying = true }
          }
          break
        }
        case 'world-prop-break': {
          const b = l.bodies.get(m.id), p = b && sb.get(b.local)
          if (p && b) {
            const t = p.body.translation()
            if (m.how === 'break') {
              breakSound(p.kind.surface ?? 'wood', 1, t.x, t.y, t.z)
              sb.fx.debris(p.kind.surface === 'glass' ? 'glass' : 'wood', t, { x: 0, y: 0, z: 0 }, p.extents.length())
            }
            sb.remove(b.local)
          }
          break
        }
        case 'world-prop-explosion':
          if (m.from !== you) {
            // Applying effects does not grant authority over remote props.
            l.applying = false
            replaying = true
            try { sb.explode({ x: m.at[0], y: m.at[1], z: m.at[2] }, m.power, m.radius, true) }
            finally { replaying = false; l.applying = true }
          }
          break
        case 'world-prop-joint': joint(l, m.joint, m.nonce); break
        case 'world-prop-unjoint': {
          const id = l.joints.get(m.id)
          if (id !== undefined) contraptionOf(sb).remove(id)
          l.joints.delete(m.id)
          break
        }
        case 'world-prop-denied':
          if (m.op === 'world-prop-spawn' && m.nonce !== undefined) { sb.remove(m.nonce); l.pending.delete(m.nonce) }
          if (m.reason === 'admin') notify('Only the admin can clean up other players. Cleanup all also works when you are alone.', 'Solo el administrador puede limpiar lo de otros. Cleanup all también funciona cuando estás a solas.')
          else if (m.reason === 'limit') notify('Prop limit reached (150 per player). Clean up some of your stuff first.', 'Límite de objetos alcanzado (150 por jugador). Limpia algunas de tus cosas primero.')
          else if (m.reason === 'name') notify('No props found for that player.', 'No se encontraron objetos de ese jugador.')
          break
      }
    })
    if (l.acknowledgements.length) send({ type: 'world-prop-ack', level: m.level, rows: l.acknowledgements.splice(0) })
  }
  let replaying = false
  const attach = (sb: Sandbox, name: string) => {
    const l = state(name)
    l.sb = sb
    const c = contraptionOf(sb)
    const spawn = (p: Prop) => {
      if (l.applying || !you || active !== name || !l.ready || p.data.net || l.pending.has(p.id) || p.data.gib || !catalogueEntry(p.kind.id)) return
      const row = pack(p, 0, 1, true)
      l.pending.set(p.id, { row, removed: false })
      send({ type: 'world-prop-spawn', level: name, nonce: p.id, kind: p.kind.id, scale: p.scale, mass: p.mass, pose: row })
      sb.setMode(p.id, 'kinematic')
    }
    const claim = (id: number, reason: 'hand' | 'seat' | 'keys' | 'collision', source?: number) => {
      const b = l.local.get(id)
      if (!b) return !l.pending.has(id)
      if (!you || active !== name) return false
      if (b.net.authority === you && b.net.lock === reason && !b.net.transfer) return true
      if (now() >= (l.claims.get(id) ?? 0)) {
        send({ type: 'world-prop-claim', level: name, id: b.net.id, reason, source })
        l.claims.set(id, now() + 300)
      }
      return b.net.authority === you && !b.net.transfer && (reason === 'collision' || !!b.net.lock)
    }
    const tmp = new THREE.Vector3(), q = new THREE.Quaternion()
    sb.network = {
      authority: (id) => authority(l, id),
      get online() { return !!you && l.ready && active === name },
      owns: (id) => l.applying || (l.local.has(id) ? l.local.get(id)!.net.owner === you : true),
      claim,
      release: (id) => {
        const b = l.local.get(id)
        if (b?.net.authority === you && b.net.lock) send({ type: 'world-prop-claim', level: name, id: b.net.id, reason: 'release' })
      },
      cleanup: (target) => send({ type: 'world-prop-cleanup', level: name, target }),
      hit: (id, amount, ignite = false) => {
        const b = l.local.get(id)
        if (b && you && active === name) send({ type: 'world-prop-hit', level: name, id: b.net.id, amount, ignite })
      },
      remove: (id) => {
        if (l.applying) return true
        if (l.pending.has(id)) { l.pending.get(id)!.removed = true; return false }
        const b = l.local.get(id)
        if (!b) return true
        if (sb.get(id)?.data.breaking && authority(l, id)) return true
        if (b.net.owner === you) send({ type: 'world-prop-remove', level: name, id: b.net.id })
        return false
      },
      frame: () => {
        if (!you || active !== name || !l.ready) return
        const time = now(), at = time - delay
        for (const b of l.bodies.values()) {
          if (authority(l, b.local)) continue
          const p = sb.get(b.local)
          if (!p) continue
          sb.setMode(p.id, 'kinematic')
          const samples = b.samples
          while (samples.length > 2 && samples[1].at <= at) samples.shift()
          const a = samples[0], z = samples[1] ?? a
          if (!a) continue
          const k = z.at === a.at ? 1 : Math.max(0, Math.min(1, (at - a.at) / (z.at - a.at)))
          tmp.copy(position(a.row)).lerp(position(z.row), k)
          q.copy(rotation(a.row)).slerp(rotation(z.row), k)
          // Place directly as well as the kinematic target: no second Rapier
          // interpolation and no simulated velocity from a delayed teleport.
          sb.setTransform(p.id, tmp, q)
          sb.moveKinematic(p.id, tmp, q)
        }
        if (time < l.next) return
        l.next = time + 1000 / 15
        sb.forEach(spawn)
        const rows: PropPose[] = []
        for (const b of l.bodies.values()) {
          if (!authority(l, b.local)) continue
          const p = sb.get(b.local)
          if (!p) continue
          const row = pack(p, b.net.id, b.net.epoch)
          const signature = row.join(',')
          if (signature !== b.last) { rows.push(row); b.last = signature; delete p.data.netTeleport }
          const st = c.part(p.id)
          const part = st ? [st.keys, +st.flip, Math.round(st.target * 100) / 100, Math.round(st.fire * 10) / 10] : null
          const life = p.data.life as { hp: number; fuse: number; boom: number; lit: number } | undefined
          // Fuse countdown rides at 5 Hz, never for an untouched prop.
          const lifeRow = life ? [life.hp, life.fuse, life.boom, life.lit].map((v) => Math.round(v * 5) / 5) : null
          const meta = JSON.stringify([part, lifeRow])
          if (meta !== b.meta && (part || lifeRow)) {
            send({ type: 'world-prop-meta', level: name, id: b.net.id, epoch: b.net.epoch, part, life: lifeRow })
          }
          b.meta = meta
        }
        if (rows.length) send({ type: 'world-prop-move', level: name, rows })
        for (const r of c.constraints()) {
          if (l.jointSent.has(r.id)) continue
          const a = l.local.get(r.a), b = l.local.get(r.b)
          if (!a || !b || a.net.owner !== you || b.net.owner !== you || !authority(l, r.a) || !authority(l, r.b)) continue
          send({ type: 'world-prop-joint', level: name, id: a.net.id, b: b.net.id, kind: r.type, frames: r.frames, nonce: r.id })
          l.jointSent.add(r.id)
        }
        const present = new Set(c.constraints().map((r) => r.id))
        for (const id of l.jointSent) if (!present.has(id)) l.jointSent.delete(id)
        for (const [net, local] of l.joints) {
          if (!present.has(local)) { send({ type: 'world-prop-unjoint', level: name, id: net }); l.joints.delete(net) }
        }
      },
    }
    sb.onSpawn(spawn)
    sb.onBreak((e) => {
      if (l.applying) return
      const b = l.local.get(e.id)
      if (b && authority(l, e.id)) send({ type: 'world-prop-break', level: name, id: b.net.id, epoch: b.net.epoch, how: e.how })
    })
    sb.onExplosion((e) => {
      if (l.applying || replaying || e.remote || !you || active !== name) return
      const b = e.source === null ? undefined : l.local.get(e.source)
      send({ type: 'world-prop-explosion', level: name, id: b?.net.id, epoch: b?.net.epoch, at: [e.x, e.y, e.z], power: e.power, radius: e.radius })
    })
    sb.onImpact((e) => {
      if (e.other && e.speed > 2 && authority(l, e.id)) {
        const b = l.local.get(e.id)
        if (b?.net.owner === you && !authority(l, e.other.id)) {
          const a = e.prop.body.translation(), z = e.other.body.translation()
          const direction = new THREE.Vector3(z.x - a.x, z.y - a.y, z.z - a.z).normalize()
          direction.multiplyScalar(Math.min(e.impulse, e.other.mass * 40))
          l.kicks.set(e.other.id, { x: direction.x, y: direction.y, z: direction.z })
          // The hit can precede the next periodic row. Publish the now-awake
          // source before asking the referee to validate this collision.
          send({ type: 'world-prop-move', level: name, rows: [pack(e.prop, b.net.id, b.net.epoch)] })
          claim(e.other.id, 'collision', b.net.id)
        }
      }
    })
    void sb.whenReady.then(() => { for (const m of l.queue.splice(0)) receive(m) })
  }
  return {
    attach,
    setLevel: (name) => {
      active = name
      for (const l of levels.values()) if (l.name !== name) {
        for (const b of l.bodies.values()) l.sb?.setMode(b.local, 'kinematic')
      }
    },
    receive: (m) => {
      if (m.type === 'world-welcome') { you = m.you; delay = m.tick * 2 }
      else if (m.type.startsWith('world-prop-')) receive(m as PropServerMessage)
    },
    offline: () => {
      you = 0
      for (const l of levels.values()) {
        l.ready = false
        for (const b of l.bodies.values()) l.sb?.setMode(b.local, 'kinematic')
      }
    },
  }
}
