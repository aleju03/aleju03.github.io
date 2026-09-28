/*
 * Shared world damage, without sockets or React: what somebody broke is
 * broken for everyone on the level. The browser supplies the transport
 * (worldNet's `damage`), the scene attaches each level's destruction and
 * felling once they exist, and the sandbox's own slices drive the flush.
 *
 * Two things travel, for two different jobs (sandbox/destruction.ts's
 * header has the long form):
 *
 * - **The show.** A blow this client dealt to a building (a car through a
 *   wall, a thrown prop, a falling storey's rubble, the console) goes out as
 *   `world-damage` and every peer replays it through the same code, so they
 *   watch the same wall come down. Blasts are not sent this way, because the
 *   explosion already travels (remoteProps.ts) and lands in every peer's
 *   destruction like a local one, flagged `remote` so nothing re-reports it.
 *   A felled tree goes out as `world-fell` with the way it was hit, and is
 *   thrown from the same foot everywhere; its flight is each client's own.
 * - **The truth.** The piece keys every building has lost (`ruins.ruined`)
 *   and the ids of every felled prop. Every client reports what it has that
 *   the server has not (`world-ruin`, diffed at 10 Hz against what it last
 *   heard), the server keeps the union per level and passes on only what is
 *   new, and every client lifts what it is missing. A union is order-free
 *   and idempotent, so however two clients' physics disagreed about a
 *   collapse, they end with the same holes. On joining or changing level the
 *   server sends the whole union (`world-ruins`) and it is applied quietly:
 *   no boom, no rubble, the crater simply there, the way a chunk rebuilt
 *   after a ring exit comes back already ruined. Whatever this client broke
 *   before that (offline, or in a level the server has since forgotten) is
 *   reported straight back, so the union heals itself.
 */
import type { DamageRecord, Destruction } from '../sandbox/destruction'
import type { Sandbox } from '../sandbox/sandbox'
import type { Felling } from '../world/debris'
import type { DamageClientMessage, DamageServerMessage } from './damageProtocol'
import type { WorldServerMessage } from './protocol'

export interface DamageNetwork {
  /** a level's sandbox exists: `dmg` is its destruction (null where nothing
      comes apart) and `felling` its knocked-down props */
  attach: (level: string, sb: Sandbox, dmg: Destruction | null, felling: Felling | null) => void
  receive: (m: WorldServerMessage) => void
  setLevel: (name: string) => void
  offline: () => void
}

interface LevelState {
  dmg: Destruction | null
  felling: Felling | null
  /** a snapshot for this level has landed since we last arrived in it */
  ready: boolean
  /** the server's union as we last heard it, plus what we have sent */
  known: Map<string, Set<number>>
  felled: Set<string>
  /** the ruins' version at the last complete diff (-1: diff now) */
  version: number
  /** felled props still to be checked against the server's list */
  resync: boolean
  next: number
}

/** how often the ruins are diffed against the server's union, ms */
const FLUSH_MS = 100
/** buildings reported per flush: a join's catch-up is paced, not one burst */
const BUILDINGS_PER_FLUSH = 4
/** keys per message; the server accepts up to 1024 */
const KEYS_PER_MESSAGE = 512
/** felled props re-reported per flush after a snapshot */
const FELLED_PER_FLUSH = 20

const r2 = (v: number) => Math.round(v * 100) / 100

export function createDamageNetwork(send: (m: DamageClientMessage) => void, now = () => performance.now()): DamageNetwork {
  const levels = new Map<string, LevelState>()
  let you = 0
  let active = ''

  const state = (name: string): LevelState => {
    let l = levels.get(name)
    if (!l) {
      l = { dmg: null, felling: null, ready: false, known: new Map(), felled: new Set(), version: -1, resync: false, next: 0 }
      levels.set(name, l)
    }
    return l
  }
  const live = (name: string, l: LevelState) => !!you && active === name && l.ready

  /** lift whatever the server knows and this level does not */
  const catchUp = (l: LevelState, quiet: boolean) => {
    if (l.dmg) {
      const ruined = l.dmg.ruins.ruined
      for (const [b, keys] of l.known) {
        const have = ruined.get(b)
        const missing: number[] = []
        for (const k of keys) if (!have?.has(k)) missing.push(k)
        if (missing.length) l.dmg.absorb(b, missing, quiet)
      }
    }
    if (l.felling) {
      for (const id of l.felled) if (!l.felling.felled.has(id)) l.felling.fell(id, 0, 0, 0)
    }
  }

  const flush = (name: string, l: LevelState) => {
    const t = now()
    if (t < l.next || !live(name, l)) return
    l.next = t + FLUSH_MS
    const ruins = l.dmg?.ruins
    if (ruins && ruins.version !== l.version) {
      const version = ruins.version
      let sent = 0
      let done = true
      for (const [b, keys] of ruins.ruined) {
        let known = l.known.get(b)
        const fresh: number[] = []
        for (const k of keys) if (!known?.has(k)) fresh.push(k)
        if (!fresh.length) continue
        if (sent++ >= BUILDINGS_PER_FLUSH) {
          done = false
          break
        }
        if (!known) l.known.set(b, (known = new Set()))
        for (const k of fresh) known.add(k)
        for (let i = 0; i < fresh.length; i += KEYS_PER_MESSAGE) {
          send({ type: 'world-ruin', level: name, b, keys: fresh.slice(i, i + KEYS_PER_MESSAGE) })
        }
      }
      if (done) l.version = version
    }
    if (l.resync && l.felling) {
      let n = 0
      for (const id of l.felling.felled) {
        if (l.felled.has(id)) continue
        if (n++ >= FELLED_PER_FLUSH) return
        l.felled.add(id)
        // (no direction: to anybody watching it simply goes)
        send({ type: 'world-fell', level: name, id, dir: [0, 0], speed: 0 })
      }
      l.resync = false
    }
  }

  const toWire = (r: DamageRecord) => ({
    b: r.building,
    how: r.how === 'blast' ? 'impact' as const : r.how,
    at: [r2(r.x), r2(r.y), r2(r.z)],
    power: r2(r.power),
    radius: r2(r.radius),
    dir: [r2(r.dx), r2(r.dy), r2(r.dz)],
    k: r2(r.k),
    ram: r.ram,
    seed: r.seed,
  })

  const attach: DamageNetwork['attach'] = (name, sb, dmg, felling) => {
    const l = state(name)
    l.dmg = dmg
    l.felling = felling
    l.version = -1
    l.resync = true
    if (dmg) {
      dmg.onRecord = (r) => {
        if (r.how !== 'blast' && live(name, l)) send({ type: 'world-damage', level: name, ...toWire(r) })
      }
    }
    if (felling) {
      felling.onFell = (id, dx, dz, speed) => {
        if (!live(name, l)) return
        l.felled.add(id)
        send({ type: 'world-fell', level: name, id, dir: [r2(dx), r2(dz)], speed: r2(speed) })
      }
    }
    // whatever arrived before the world did lands now, as a late join would
    catchUp(l, true)
    sb.onAfterSlice(() => flush(name, l))
  }

  const receive = (m: DamageServerMessage) => {
    const l = state(m.level)
    switch (m.type) {
      case 'world-ruins':
        // (the level the server has us in, as the prop snapshot says too)
        active = m.level
        l.known = new Map(m.ruins.map(([b, keys]) => [b, new Set(keys)]))
        l.felled = new Set(m.felled)
        l.ready = true
        l.version = -1
        l.resync = true
        catchUp(l, true)
        break
      case 'world-ruin': {
        let known = l.known.get(m.b)
        if (!known) l.known.set(m.b, (known = new Set()))
        for (const k of m.keys) known.add(k)
        const have = l.dmg?.ruins.ruined.get(m.b)
        const missing = m.keys.filter((k) => !have?.has(k))
        if (missing.length) l.dmg?.absorb(m.b, missing, false)
        break
      }
      case 'world-fell':
        l.felled.add(m.id)
        l.felling?.fell(m.id, m.dir[0] ?? 0, m.dir[1] ?? 0, m.speed)
        break
      case 'world-damage':
        if (m.from === you || !l.dmg) break
        l.dmg.replay({
          building: m.b, how: m.how, x: m.at[0], y: m.at[1], z: m.at[2], power: m.power, radius: m.radius,
          dx: m.dir[0], dy: m.dir[1], dz: m.dir[2], k: m.k, ram: m.ram, seed: m.seed,
        })
        break
    }
  }

  return {
    attach,
    receive: (m) => {
      if (m.type === 'world-welcome') {
        you = m.you
        for (const l of levels.values()) l.ready = false
      } else if (m.type === 'world-ruins' || m.type === 'world-ruin' || m.type === 'world-fell' || m.type === 'world-damage') {
        receive(m)
      }
    },
    setLevel: (name) => {
      if (name === active) return
      active = name
      // the server answers the level change with that level's snapshot
      for (const l of levels.values()) l.ready = false
    },
    offline: () => {
      you = 0
      for (const l of levels.values()) l.ready = false
    },
  }
}
