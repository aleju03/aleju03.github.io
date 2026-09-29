import type { ModeClient, ModeCtx, RingSpec } from './types'

/*
  The race, the client's half. The course is the server's (`obj.cps`: ordered
  [x, z, radius] rings; `laps`; `foot` on Cubeland, cars on the home planet's
  streets; `goAt` the gun; and for cars `turn`, whose go it is). This module
  draws the next rings, notices when the walker or the machine is inside the
  one it should go through next and says so (`cmd cp` with the running count),
  and holds the runners at the line until the gun.

  The server is the judge: it checks the ring against where it has watched
  the runner, the order, and that nobody covered the distance faster than a
  machine can, so a report that lies is simply not counted. This side never
  decides that a ring was passed; it only sees `mine.a` go up in the next
  state and plays the chime.

  **One car in the fleet**, so on the streets the racers take turns against
  the clock: the driver whose turn it is gets put on the grid by the server's
  tp, and this module orders the car and gets in (host.driveCar) while the
  eight-second wait runs. On foot (Cubeland) everyone runs at once and is
  held at the line until `goAt`.
*/

const SEND_GAP_MS = 450
/** a ring is a disc in the ground plane; height is generous (a car on a
    slope, a jump over a kerb) */
const REACH_Y = 14

export function createRace(c: ModeCtx): ModeClient {
  const s = c.store
  const cps = (): number[][] => (Array.isArray(s.obj.cps) ? (s.obj.cps as number[][]) : [])
  const foot = () => s.obj.foot === 1
  const laps = () => s.num('laps') || 1
  const driver = () => foot() || s.num('turn') === s.you
  let lastSent = 0
  let lastKey = ''
  let seenA = -1
  let carAt = 0
  let carTurn = -1
  const gun = () => s.localAt(s.num('goAt'))

  const ringsNow = (): RingSpec[] => {
    const list = cps()
    if (!list.length) return []
    const a = s.mine?.a ?? 0
    const total = list.length * laps()
    if (!driver()) return list.map(([x, z, r]) => ({ x, z, radius: r, state: 'later' as const }))
    if (a >= total) return []
    const k = a % list.length
    const nextK = (a + 1) % list.length
    const out: RingSpec[] = [{ x: list[k][0], z: list[k][1], radius: list[k][2], state: 'next' }]
    if (a + 1 < total) out.push({ x: list[nextK][0], z: list[nextK][1], radius: list[nextK][2], state: 'later' })
    return out
  }
  const draw = () => {
    const rings = ringsNow()
    const key = rings.map((r) => `${r.x},${r.z},${r.state}`).join('|')
    if (key === lastKey) return
    lastKey = key
    c.host.rings(rings)
  }

  return {
    enter() {
      seenA = -1
      lastKey = ''
      carTurn = -1
      draw()
    },
    leave() {
      c.host.rings(null)
      lastKey = ''
    },
    frozen: () => s.phase === 'countdown' || (foot() && s.phase === 'playing' && performance.now() < gun()),
    teleported() {
      // the server put the driver on the grid: bring the car to them
      if (!foot() && s.num('turn') === s.you && carTurn !== s.num('turn') + s.num('goAt')) {
        carTurn = s.num('turn') + s.num('goAt')
        carAt = performance.now() + 700
      }
    },
    tick() {
      if (s.phase !== 'playing') return
      draw()
      const mine = s.mine
      if (!mine) return
      if (seenA >= 0 && mine.a > seenA) c.host.cue(mine.a % Math.max(1, cps().length) === 0 ? 'lap' : 'ring')
      seenA = mine.a
      const now = performance.now()
      if (carAt && now >= carAt) {
        carAt = 0
        c.host.driveCar()
      }
      if (!driver() || mine.b > 0 || now < gun()) return
      const list = cps()
      if (!list.length || mine.a >= list.length * laps()) return
      const [x, z, r] = list[mine.a % list.length]
      const p = c.host.here()
      if (Math.hypot(p.x - x, p.z - z) <= r + 1 && Math.abs(p.y - c.host.groundAt(x, z)) < REACH_Y && now - lastSent > SEND_GAP_MS) {
        lastSent = now
        c.host.send({ type: 'world-round-cmd', cmd: 'cp', i: mine.a, x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 })
      }
    },
    objective() {
      const mine = s.mine
      const total = cps().length * laps()
      if (!mine) return null
      if (mine.b > 0) return { en: 'Finished. Watch the others.', es: 'Terminaste. Mira a los demás.' }
      if (!driver()) return { en: 'Wait for your turn', es: 'Espera tu turno' }
      const lap = Math.min(laps(), Math.floor(mine.a / Math.max(1, cps().length)) + 1)
      const ring = (mine.a % Math.max(1, cps().length)) + 1
      return {
        en: `Lap ${lap}/${laps()}, ring ${ring}/${cps().length} (${Math.min(mine.a, total)}/${total})`,
        es: `Vuelta ${lap}/${laps()}, aro ${ring}/${cps().length} (${Math.min(mine.a, total)}/${total})`,
      }
    },
  }
}
