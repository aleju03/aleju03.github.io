/*
 * The client half of shared portals and double-jump clouds. Portal frames
 * live until replacement or departure, while a cloud is queued only long
 * enough to match the remote body's two-tick playback. The socket stays in
 * worldNet; this module works headless against plain callbacks and Portals.
 *
 * The gun edits only its local pair. Remote pairs enter the same portal
 * crossing, ray and prop-carry queries, with hosts reconstructed from local
 * collision boxes. Prop anchors use shared ids, never another client's
 * Rapier handles; moving house surfaces publish their fitted world frame.
 */
import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import type { Sandbox } from '../sandbox/sandbox'
import type { Portal, Portals, PortalColor } from '../sandbox/tools/portals'
import type { WorldServerMessage } from './protocol'
import type { EffectClientMessage, PortalWire, PortalPairWire } from './effectProtocol'

interface World {
  boxes: readonly Solid[]
  sb: Sandbox | null
}
export interface WorldEffects {
  attach: (portals: Portals) => void
  receive: (m: WorldServerMessage) => void
  tick: () => void
  airHop: (x: number, y: number, z: number) => void
  setLevel: (level: string) => void
  offline: () => void
  readonly clouds: number
}
const vec = (frame: number[], i: number) => new THREE.Vector3().fromArray(frame, i)
const frameOf = (p: Portal) => [...p.pos.toArray(), ...p.n.toArray(), ...p.up.toArray()].map(v => Math.round(v * 1000) / 1000)
const localFrame = (m: THREE.Matrix4) => {
  const e = m.elements
  return [e[12], e[13], e[14], e[8], e[9], e[10], e[4], e[5], e[6]].map(v => Math.round(v * 1000) / 1000)
}
const matrix = (f: number[]) => {
  const n = vec(f, 3).normalize(), up = vec(f, 6).normalize()
  return new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, n).normalize(), up, n).setPosition(vec(f, 0))
}

export function createWorldEffects(o: {
  send: (m: EffectClientMessage) => void
  world: (level: string) => World | null
  level: () => string
  cloud: (level: string, at: { x: number; y: number; z: number }) => void
  now?: () => number
}): WorldEffects {
  const now = o.now ?? (() => performance.now())
  let portals: Portals | null = null
  let you = 0, period = 66, next = 0, seq = 0, clouds = 0
  let level = ''
  const pairs = new Map<number, PortalPairWire>()
  const ownedAnchors = new Map<Portal, { prop: number; frame: number[]; world: number[] }>()
  const signatures = ['', '']
  const receivedHops = new Map<number, number>()
  const queue: Array<{ due: number; level: string; id: number; x: number; y: number; z: number }> = []

  const syncOwnedAnchors = () => {
    if (!portals) return
    for (const p of ownedAnchors.keys()) if (!portals.list.includes(p)) ownedAnchors.delete(p)
    for (const p of portals.list) {
      if (!p) continue
      let known = ownedAnchors.get(p)
      if (!known && p.anchor?.kind === 'prop') {
        const id = ownedAnchors.get(p)?.prop ?? p.anchor.sb.get(p.anchor.id)?.data.net
        if (typeof id === 'number') {
          known = { prop: id, frame: localFrame(p.anchor.local), world: frameOf(p) }
          ownedAnchors.set(p, known)
        }
      }
      if (!known) continue
      const sb = o.world(p.level)?.sb
      let local: number | null = null
      sb?.forEach((q) => { if (q.data.net === known.prop) local = q.id })
      if (sb && local !== null && p.level === level) {
        p.anchor = { kind: 'prop', sb, id: local, local: matrix(known.frame) }
        p.streamedFrame = null
        p.ready = true
      } else {
        p.streamedFrame = matrix(known.world)
        if (p.level === level) p.ready = false
      }
    }
  }
  const read = (p: Portal): PortalWire | null => {
    let anchor: PortalWire['anchor'] = null
    if (p.anchor?.kind === 'prop') {
      const id = ownedAnchors.get(p)?.prop ?? p.anchor.sb.get(p.anchor.id)?.data.net
      if (typeof id !== 'number') return null // the spawn acknowledgement comes first
      anchor = { prop: id, frame: localFrame(p.anchor.local) }
    }
    return { serial: p.serial, level: p.level, frame: frameOf(p), ground: p.ground,
      inset: p.inset, skin: p.skin, ready: p.ready, site: p.site === 'moon' || p.site === 'earth' ? p.site : null, anchor }
  }
  const place = (owner: number, color: PortalColor, data: PortalWire | null) => {
    if (!portals) return
    if (!data) { portals.setRemote(owner, color, null); return }
    const world = o.world(data.level)
    let anchor: Portal['anchor'] = null
    if (data.anchor && world?.sb?.ready) {
      const sb = world.sb
      let local: number | null = null
      sb.forEach((p) => { if (p.data.net === data.anchor!.prop) local = p.id })
      if (local !== null) anchor = { kind: 'prop', sb, id: local, local: matrix(data.anchor.frame) }
    }
    const old = portals.all.find(p => p?.owner === owner && p.color === color)
    // Anchor readiness is local: a snapshot can arrive before Rapier.
    const ready = data.ready && (!data.anchor || !!anchor || data.level !== level)
    portals.setRemote(owner, color, {
      serial: data.serial, level: data.level, pos: vec(data.frame, 0), n: vec(data.frame, 3).normalize(), up: vec(data.frame, 6).normalize(),
      ground: data.ground, inset: data.inset, skin: data.skin, ready, site: data.site,
      hosts: old?.hosts ?? [], anchor,
    })
  }
  const tick = () => {
    if (!portals) return
    const time = now()
    syncOwnedAnchors()
    // Re-resolve anchors and streamed collision hosts. A distant endpoint's
    // boxes may not exist until the player walks toward it.
    if (time >= next) {
      next = time + 100
      for (const { owner, portals: pair } of pairs.values()) {
        for (const color of [0, 1] as const) {
          const data = pair[color]
          const p = portals.all.find(p => p?.owner === owner && p.color === color)
          if (data?.anchor && !p?.anchor) place(owner, color, data)
        }
      }
      portals.follow()
      for (const p of portals.all) {
        if (!p?.owner || p.anchor?.kind === 'prop') continue
        const world = o.world(p.level)
        if (world) portals.hostsAt(p, world.boxes)
      }
      if (you) for (const color of [0, 1] as const) {
        const p = portals.list[color]
        const data = p ? read(p) : null
        if (p && !data) continue
        // Prop motion already travels through the prop stream. Keep a stable
        // fallback frame so it does not become a second transform stream.
        const signature = JSON.stringify(data?.anchor ? { ...data, frame: [] } : data)
        if (signature === signatures[color]) continue
        signatures[color] = signature
        o.send({ type: 'world-portal', color, portal: data })
      }
    }
    while (queue.length && queue[0].due <= time) {
      const e = queue.shift()!
      if (e.level !== level || time - e.due > 750) continue
      o.cloud(level, e); clouds++
    }
  }
  const receive: WorldEffects['receive'] = (m) => {
    if (m.type === 'world-welcome') { you = m.you; level = o.level(); period = m.tick; signatures.fill(''); return }
    if (m.type === 'world-prop-remove') {
      for (const p of portals?.list ?? []) {
        if (p && p.level === m.level && m.ids.includes(ownedAnchors.get(p)?.prop ?? -1)) portals?.close(p.color)
      }
      return
    }
    if (m.type === 'world-prop-snapshot' || m.type === 'world-prop-spawn') { syncOwnedAnchors(); return }
    if (m.type === 'world-exit') { pairs.delete(m.id); portals?.clearRemote(m.id); receivedHops.delete(m.id); return }
    if (m.type === 'world-portal-denied') {
      const p = portals?.list[m.color]
      if (p?.serial === m.serial) portals?.close(m.color)
      return
    }
    if (m.type === 'world-air-hop') {
      if (m.level !== level || m.id === you || m.seq <= (receivedHops.get(m.id) ?? 0)) return
      receivedHops.set(m.id, m.seq)
      if (queue.length >= 96) queue.shift()
      queue.push({ ...m, due: now() + period * 2 })
      return
    }
    if (m.type !== 'world-portals' && m.type !== 'world-portal') return
    if (m.level !== level) return
    if (m.type === 'world-portal' && m.owner === you) {
      for (const color of [0, 1] as const) {
        const p = portals?.list[color], data = m.portals[color]
        if (p && data?.anchor && p.serial === data.serial) {
          ownedAnchors.set(p, { ...data.anchor, world: data.frame })
        }
      }
      syncOwnedAnchors()
      portals?.follow()
      return
    }
    if (m.type === 'world-portals') {
      pairs.clear(); portals?.clearRemote()
      for (const pair of m.pairs) if (pair.owner !== you) pairs.set(pair.owner, pair)
    } else if (m.owner !== you) {
      if (m.portals.some(Boolean)) pairs.set(m.owner, m)
      else { pairs.delete(m.owner); portals?.clearRemote(m.owner) }
    }
    for (const { owner, portals: pair } of pairs.values()) {
      place(owner, 0, pair[0]); place(owner, 1, pair[1])
    }
    portals?.follow()
  }
  return {
    attach: (p) => {
      portals = p
      for (const { owner, portals: pair } of pairs.values()) {
        place(owner, 0, pair[0]); place(owner, 1, pair[1])
      }
    },
    receive,
    tick,
    airHop: (x, y, z) => { if (you) o.send({ type: 'world-air-hop', level, seq: ++seq, x, y, z }) },
    setLevel: (to) => { level = to; pairs.clear(); portals?.clearRemote(); queue.length = 0; next = 0; syncOwnedAnchors() },
    offline: () => {
      const wasLive = !!you
      you = 0; pairs.clear(); portals?.clearRemote(); receivedHops.clear(); queue.length = 0
      if (wasLive) portals?.close()
      ownedAnchors.clear()
    },
    get clouds() { return clouds },
  }
}
