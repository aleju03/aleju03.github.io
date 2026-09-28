import { kindOf } from '../creatures/kinds'
import type { AdoptRow, RenderCreature } from '../creatures/sim'
import { S } from '../creatures/sim'
import { decodeRow, CREATURE_HZ, type CreatureRow, type CreatureServerMessage } from './creatureProtocol'

/*
  Creatures the host simulates, as everyone else sees them.

  The same deal as net/remotePlayers.ts, for the same reason: a snapshot
  arrives eight times a second, and extrapolating a stopping animal drags its
  planted feet across the ground, so playback runs a little behind (two
  snapshot periods) and interpolates between the two rows that bracket it.
  Nothing here simulates: no steering, no gravity, no collision. A row that
  is missing from the next snapshot is gone, exactly as the host's table
  says (the snapshot replaces, it does not merge).

  What a snapshot cannot say directly is worked out from how it changes, so
  the wire stays eight numbers a row: the walk cycle's speed is the distance
  covered between the rows, "hurt" is the flag rising, a death is the state
  going to 5, a fuse is a creeper's state going to act and a shot is an arrow
  appearing. Those become the same events the host's own simulation emits
  (`RemoteEvent`), so one director plays sounds for both. `poke` lets the
  client that just hit a creature flash it at once rather than a snapshot and
  a round trip later.

  Headless: plain numbers and a clock passed in. `rows()` hands the latest
  snapshot back as `AdoptRow`s, which is how a client that becomes the host
  takes the herd over instead of starting an empty world.
*/

const DELAY_MS = (2 / CREATURE_HZ) * 1000
const KEEP_MS = 1500
/** a step this big between rows is a respawn or a teleport, not a run */
const SNAP = 24

interface Sample {
  at: number
  x: number
  y: number
  z: number
  yaw: number
}

interface Remote {
  id: number
  kind: number
  samples: Sample[]
  hp: number
  st: number
  since: number
  hurtAt: number
  deadAt: number
  burning: boolean
  view: RenderCreature
  ax: number
  az: number
}

export type RemoteEvent =
  | { t: 'hurt'; r: RenderCreature }
  | { t: 'die-row'; r: RenderCreature }
  | { t: 'fuse'; r: RenderCreature }
  | { t: 'shoot'; r: RenderCreature }
  | { t: 'gone'; id: number }

export interface RemoteCreatures {
  /** a host snapshot landed; `now` is local time in ms */
  receive: (rows: readonly CreatureRow[], now: number) => void
  /** the interpolated draw list at `now` */
  sample: (now: number) => readonly RenderCreature[]
  on: (fn: (e: RemoteEvent) => void) => () => void
  /** flash this one now (we just hit it) */
  poke: (id: number, now: number) => void
  /** the last snapshot, as a host would adopt it */
  rows: () => AdoptRow[]
  /** nearest creature within `r` of a point, for the client's own aiming aids */
  get: (id: number) => RenderCreature | undefined
  /** where the shove-able bodies are, as last drawn (for the impact seam) */
  readonly views: ReadonlyMap<number, RenderCreature>
  clear: () => void
  readonly count: number
}

const wrap = (a: number) => {
  const t = Math.PI * 2
  a %= t
  if (a > Math.PI) a -= t
  else if (a < -Math.PI) a += t
  return a
}

export function createRemoteCreatures(): RemoteCreatures {
  const all = new Map<number, Remote>()
  const views = new Map<number, RenderCreature>()
  const fns = new Set<(e: RemoteEvent) => void>()
  const emit = (e: RemoteEvent) => {
    for (const fn of fns) fn(e)
  }
  const list: RenderCreature[] = []
  let last: ReturnType<typeof decodeRow>[] = []

  return {
    receive: (rows, now) => {
      last = rows.map(decodeRow)
      const seen = new Set<number>()
      for (const d of last) {
        const kind = kindOf(d.kind)
        if (!kind) continue
        seen.add(d.id)
        let r = all.get(d.id)
        if (!r) {
          const view: RenderCreature = {
            id: d.id, kind, x: d.x, y: d.y, z: d.z, yaw: d.yaw, speed: 0, st: d.st, stT: 0, hurtT: 99, deadT: -1,
            burning: d.burning, vy: 0,
          }
          r = { id: d.id, kind: d.kind, samples: [], hp: d.hp, st: d.st, since: now, hurtAt: -1e9, deadAt: -1, burning: false, view, ax: 0, az: 0 }
          all.set(d.id, r)
          views.set(d.id, view)
          if (kind.behaviour === 'arrow') emit({ t: 'shoot', r: view })
        }
        const prev = r.samples[r.samples.length - 1]
        if (prev && Math.hypot(d.x - prev.x, d.z - prev.z) > SNAP) r.samples.length = 0
        r.samples.push({ at: now, x: d.x, y: d.y, z: d.z, yaw: d.yaw })
        while (r.samples.length > 2 && now - r.samples[1].at > KEEP_MS) r.samples.shift()
        if (d.hurt && r.hp !== d.hp) {
          r.hurtAt = now
          emit({ t: 'hurt', r: r.view })
        }
        if (d.st !== r.st) {
          if (d.st === S.DEAD) {
            r.deadAt = now
            emit({ t: 'die-row', r: r.view })
          } else if (r.st === S.DEAD) r.deadAt = -1
          if (d.st === S.ACT && kind.behaviour === 'creeper') emit({ t: 'fuse', r: r.view })
          r.st = d.st
          r.since = now
        }
        r.hp = d.hp
        r.burning = d.burning
      }
      for (const [id, r] of all) {
        if (seen.has(id)) continue
        all.delete(id)
        views.delete(id)
        emit({ t: 'gone', id })
        void r
      }
    },
    sample: (now) => {
      list.length = 0
      const t = now - DELAY_MS
      for (const r of all.values()) {
        const s = r.samples
        if (!s.length) continue
        let a = s[0]
        let b = s[s.length - 1]
        for (let i = 0; i < s.length - 1; i++) {
          if (s[i].at <= t && s[i + 1].at >= t) {
            a = s[i]
            b = s[i + 1]
            break
          }
        }
        if (t <= s[0].at) b = a
        else if (t >= s[s.length - 1].at) a = b
        const span = b.at - a.at
        const k = span > 0 ? Math.min(1, Math.max(0, (t - a.at) / span)) : 1
        const v = r.view
        const nx = a.x + (b.x - a.x) * k
        const nz = a.z + (b.z - a.z) * k
        const ny = a.y + (b.y - a.y) * k
        const dtv = span > 0 ? span / 1000 : 0
        const sp = dtv > 0 ? Math.hypot(b.x - a.x, b.z - a.z) / dtv : 0
        // (a smoothed speed, so a stop between two rows is not a flicker)
        v.speed += (sp - v.speed) * 0.35
        v.vy = dtv > 0 ? (b.y - a.y) / dtv : 0
        v.x = nx
        v.y = ny
        v.z = nz
        v.yaw = a.yaw + wrap(b.yaw - a.yaw) * k
        v.st = r.st
        v.stT = Math.max(0, (now - r.since) / 1000)
        v.hurtT = (now - r.hurtAt) / 1000
        v.deadT = r.deadAt < 0 ? -1 : (now - r.deadAt) / 1000
        v.burning = r.burning
        list.push(v)
      }
      return list
    },
    on: (fn) => {
      fns.add(fn)
      return () => fns.delete(fn)
    },
    poke: (id, now) => {
      const r = all.get(id)
      if (r) r.hurtAt = now
    },
    rows: () => last.map((d) => ({ id: d.id, kind: d.kind, x: d.x, y: d.y, z: d.z, yaw: d.yaw, hp: d.hp, st: d.st })),
    get: (id) => views.get(id),
    views,
    clear: () => {
      all.clear()
      views.clear()
      last = []
    },
    get count() {
      return all.size
    },
  }
}

export type { CreatureServerMessage }
