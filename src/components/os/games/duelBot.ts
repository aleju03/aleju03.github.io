/*
  A local Mine Duel opponent. This engine mirrors the server's match engine
  (server/src/index.js) rule for rule and speaks the same wire protocol —
  duel-start, duel-planted, duel-phase, duel-dug, duel-over, duel-rematch —
  so MineDuelApp runs the exact same reducer whether the opponent is a
  visitor over the WebSocket or the bot living in this file.

  The bot plays the way a decent human does. It memorizes its own five
  mines, reads every revealed number, subtracts what its own mines
  contribute to it, and digs the tile it believes is safest. A pinch of
  randomness and the occasional gamble keep it beatable.
*/

const SIZE = 10
const CELLS = SIZE * SIZE
const MINES = 5
const LIVES = 2
const PLANT_MS = 45_000
const TURN_MS = 20_000

export const BOT_PLAYER = { name: 'digby', registered: false, admin: false, bot: true }

type Listener = (msg: Record<string, unknown>) => void

export interface LocalDuel {
  send(payload: Record<string, unknown>): void
  dispose(): void
}

function neighbors(i: number): number[] {
  const row = Math.floor(i / SIZE)
  const col = i % SIZE
  const out: number[] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const r = row + dr
      const c = col + dc
      if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) out.push(r * SIZE + c)
    }
  }
  return out
}

function shuffled(): number[] {
  const pool = Array.from({ length: CELLS }, (_, i) => i)
  for (let k = pool.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1))
    ;[pool[k], pool[j]] = [pool[j], pool[k]]
  }
  return pool
}

const touching = (a: number, b: number) => a === b || neighbors(a).includes(b)

/** scattered mines make quieter numbers, which is the sneakier burial */
function botPlant(): Set<number> {
  const order = shuffled()
  const picks: number[] = []
  for (const c of order) {
    if (picks.length >= MINES) break
    if (picks.some((p) => touching(p, c))) continue
    picks.push(c)
  }
  for (const c of order) {
    if (picks.length >= MINES) break
    if (!picks.includes(c)) picks.push(c)
  }
  return new Set(picks)
}

interface Match {
  phase: 'plant' | 'dig' | 'over'
  mines: [Set<number>, Set<number>] // seat 0 the human, seat 1 the bot
  planted: [boolean, boolean]
  revealed: Map<number, number>
  exploded: Set<number>
  lives: [number, number]
  turn: 0 | 1
  deadline: number
  rematch: [boolean, boolean]
}

export function createBotDuel(playerName: string, listener: Listener): LocalDuel {
  let disposed = false
  const timers = new Set<number>()
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.delete(id)
      if (!disposed) fn()
    }, ms)
    timers.add(id)
  }
  const emit = (msg: Record<string, unknown>) => later(() => listener(msg), 0)

  let match: Match
  let phaseTimer = 0
  const clearPhaseTimer = () => {
    window.clearTimeout(phaseTimer)
    timers.delete(phaseTimer)
  }
  const phaseLater = (fn: () => void, ms: number) => {
    clearPhaseTimer()
    phaseTimer = window.setTimeout(() => {
      timers.delete(phaseTimer)
      if (!disposed) fn()
    }, ms)
    timers.add(phaseTimer)
  }

  /*
    The bot's read of the board. Every revealed number counts both players'
    mines; the bot knows its own, so the remainder is yours. Constraints
    that resolve to zero mark provably safe tiles, everything else raises a
    per-tile suspicion, and unconstrained tiles carry the base rate of your
    mines still unaccounted for.
  */
  const botPick = (): number => {
    const own = match.mines[1]
    const hidden: number[] = []
    for (let i = 0; i < CELLS; i++) {
      if (!match.revealed.has(i) && !match.exploded.has(i)) hidden.push(i)
    }
    const options = hidden.filter((c) => !own.has(c))
    if (options.length === 0) return hidden[Math.floor(Math.random() * hidden.length)]
    const explodedYours = [...match.exploded].filter((c) => !own.has(c)).length
    const prior = Math.max(0, MINES - explodedYours) / options.length
    const danger = new Map(options.map((c) => [c, prior]))
    const safe = new Set<number>()
    for (const [r, count] of match.revealed) {
      const ns = neighbors(r)
      const ownAdj = ns.filter((n) => own.has(n)).length
      const explodedAdj = ns.filter((n) => match.exploded.has(n) && !own.has(n)).length
      const rest = Math.max(0, count - ownAdj - explodedAdj)
      const unknown = ns.filter((n) => danger.has(n))
      if (unknown.length === 0) continue
      if (rest === 0) unknown.forEach((n) => safe.add(n))
      else {
        const p = Math.min(1, rest / unknown.length)
        unknown.forEach((n) => danger.set(n, Math.max(danger.get(n) as number, p)))
      }
    }
    safe.forEach((c) => danger.set(c, 0))
    const ranked = [...options].sort(
      (a, b) => (danger.get(a) as number) - (danger.get(b) as number),
    )
    const best = danger.get(ranked[0]) as number
    // usually the near-best tile; now and then a wider gamble, so a sharp
    // player can outread it
    const slack = Math.random() < 0.15 ? 0.2 : 0.04
    const pool = ranked.filter((c) => (danger.get(c) as number) <= best + slack)
    return pool[Math.floor(Math.random() * pool.length)]
  }

  const scheduleBotDig = () => {
    phaseLater(() => digCell(1, botPick(), false), 700 + Math.random() * 1500)
  }

  const scheduleAutoDig = () => {
    phaseLater(() => {
      const hidden: number[] = []
      for (let i = 0; i < CELLS; i++) {
        if (!match.revealed.has(i) && !match.exploded.has(i)) hidden.push(i)
      }
      if (hidden.length === 0) return
      digCell(match.turn, hidden[Math.floor(Math.random() * hidden.length)], true)
    }, Math.max(0, match.deadline - Date.now()))
  }

  const afterTurnChange = () => {
    if (match.turn === 1) scheduleBotDig()
    else scheduleAutoDig()
  }

  const beginDig = () => {
    match.phase = 'dig'
    match.turn = Math.random() < 0.5 ? 0 : 1
    match.deadline = Date.now() + TURN_MS
    emit({ type: 'duel-phase', phase: 'dig', turn: match.turn, deadline: match.deadline })
    afterTurnChange()
  }

  const maybeBeginDig = () => {
    if (match.planted[0] && match.planted[1]) beginDig()
  }

  const minedCellCount = () => new Set([...match.mines[0], ...match.mines[1]]).size

  const finish = (winner: number, reason: string) => {
    clearPhaseTimer()
    match.phase = 'over'
    emit({
      type: 'duel-over',
      winner,
      reason,
      lives: match.lives,
      mines: [[...match.mines[0]], [...match.mines[1]]],
    })
    // the bot is always up for another round
    later(() => {
      if (match.phase !== 'over' || match.rematch[1]) return
      match.rematch[1] = true
      emit({ type: 'duel-rematch', seat: 1 })
      if (match.rematch[0]) startMatch()
    }, 1400)
  }

  const digCell = (seat: 0 | 1, cell: number, auto: boolean) => {
    clearPhaseTimer()
    const hits = (match.mines[0].has(cell) ? 1 : 0) + (match.mines[1].has(cell) ? 1 : 0)
    let count: number | null = null
    if (hits > 0) {
      match.exploded.add(cell)
      match.lives[seat] -= 1
    } else {
      count = 0
      for (const n of neighbors(cell)) {
        if (match.mines[0].has(n)) count += 1
        if (match.mines[1].has(n)) count += 1
      }
      match.revealed.set(cell, count)
    }
    match.turn = seat === 0 ? 1 : 0
    match.deadline = Date.now() + TURN_MS
    emit({
      type: 'duel-dug',
      cell,
      by: seat,
      auto,
      mine: hits > 0,
      count,
      lives: [...match.lives],
      turn: match.turn,
      deadline: match.deadline,
    })
    if (match.lives[seat] <= 0) {
      finish(seat === 0 ? 1 : 0, 'lives')
      return
    }
    if (match.revealed.size >= CELLS - minedCellCount()) {
      const [la, lb] = match.lives
      finish(la === lb ? -1 : la > lb ? 0 : 1, 'board')
      return
    }
    afterTurnChange()
  }

  const startMatch = () => {
    match = {
      phase: 'plant',
      mines: [new Set(), new Set()],
      planted: [false, false],
      revealed: new Map(),
      exploded: new Set(),
      lives: [LIVES, LIVES],
      turn: 0,
      deadline: Date.now() + PLANT_MS,
      rematch: [false, false],
    }
    emit({
      type: 'duel-start',
      seat: 0,
      players: [
        { name: playerName, registered: false, admin: false },
        { ...BOT_PLAYER },
      ],
      size: SIZE,
      mines: MINES,
      lives: LIVES,
      phase: 'plant',
      deadline: match.deadline,
      bot: true,
    })
    // the bot ponders its burial for a moment, like anyone would
    later(() => {
      if (match.phase !== 'plant' || match.planted[1]) return
      match.mines[1] = botPlant()
      match.planted[1] = true
      emit({ type: 'duel-planted', seat: 1 })
      maybeBeginDig()
    }, 1200 + Math.random() * 1800)
    // the plant clock buries for the human if it runs out, same as online
    phaseLater(() => {
      if (match.phase !== 'plant') return
      if (!match.planted[1]) {
        match.mines[1] = botPlant()
        match.planted[1] = true
        emit({ type: 'duel-planted', seat: 1 })
      }
      if (!match.planted[0]) {
        match.mines[0] = new Set(shuffled().slice(0, MINES))
        match.planted[0] = true
        emit({ type: 'duel-planted', seat: 0, auto: true, cells: [...match.mines[0]] })
      }
      beginDig()
    }, PLANT_MS)
  }

  startMatch()

  return {
    send(payload) {
      if (disposed) return
      const type = String(payload.type ?? '')
      if (type === 'duel-plant') {
        if (match.phase !== 'plant' || match.planted[0]) return
        const cells = Array.isArray(payload.cells) ? (payload.cells as number[]) : []
        const set = new Set(cells.filter((c) => Number.isInteger(c) && c >= 0 && c < CELLS))
        if (set.size !== MINES) return
        match.mines[0] = set
        match.planted[0] = true
        emit({ type: 'duel-planted', seat: 0 })
        maybeBeginDig()
        return
      }
      if (type === 'duel-dig') {
        if (match.phase !== 'dig' || match.turn !== 0) return
        const cell = Number(payload.cell)
        if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return
        if (match.revealed.has(cell) || match.exploded.has(cell)) return
        digCell(0, cell, false)
        return
      }
      if (type === 'duel-rematch') {
        if (match.phase !== 'over' || match.rematch[0]) return
        match.rematch[0] = true
        if (match.rematch[1]) startMatch()
        return
      }
      if (type === 'duel-leave') {
        if (match.phase !== 'over') finish(1, 'forfeit')
      }
    },
    dispose() {
      disposed = true
      for (const id of timers) window.clearTimeout(id)
      timers.clear()
    },
  }
}
