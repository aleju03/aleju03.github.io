/*
  Klondike, the rules only: no React, no DOM, no rendering. Windows'
  Solitaire is the specification here rather than "some patience game", so
  the things that are easy to get subtly wrong are the things spelled out —
  the deal, what may sit on what, how many passes the stock allows, and the
  Standard/Vegas score tables, which are not the tidy round numbers people
  remember (a card turned face up is worth five, a card pulled back off a
  foundation costs fifteen).

  A move is applied to a fresh Board and the old one is kept for Undo, which
  is why nothing here mutates: 52 cards is small enough that snapshotting is
  cheaper to reason about than an inverse-move log, and Windows only ever
  offered one level of undo anyway.
*/

export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
export const SUITS: readonly Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']

export interface Card {
  /** stable across a deal, so React keys survive a move */
  id: number
  /** 1 = ace ... 13 = king */
  rank: number
  suit: Suit
  up: boolean
}

export const isRed = (suit: Suit) => suit === 'hearts' || suit === 'diamonds'

/** where a card is, in the only vocabulary the board understands */
export type PileKind = 'stock' | 'waste' | 'foundation' | 'tableau'
export interface PileRef {
  kind: PileKind
  index: number
}

export interface Board {
  stock: Card[]
  waste: Card[]
  /** four, left to right; a pile is a same-suit run from the ace up */
  foundations: Card[][]
  /** seven, left to right; face-down cards first, then the visible build */
  tableau: Card[][]
}

export type ScoreMode = 'standard' | 'vegas' | 'none'

export interface GameState {
  board: Board
  score: number
  /** how many times the stock has been turned over, including the first deal */
  passes: number
  /** every foundation full */
  won: boolean
}

// ---------------------------------------------------------------- the deal

function shuffled(): Card[] {
  const deck: Card[] = []
  let id = 0
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) deck.push({ id: id++, rank, suit, up: false })
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

export function deal(mode: ScoreMode, carriedVegas: number | null): GameState {
  const deck = shuffled()
  const tableau: Card[][] = []
  for (let col = 0; col < 7; col++) {
    const pile = deck.splice(0, col + 1)
    pile[pile.length - 1].up = true
    tableau.push(pile)
  }
  return {
    board: { stock: deck, waste: [], foundations: [[], [], [], []], tableau },
    // Vegas buys the deck at a dollar a card and pays five a card back, which
    // is why a fresh Vegas hand opens at -52 rather than at zero
    score: mode === 'vegas' ? (carriedVegas ?? -52) : 0,
    passes: 1,
    won: false,
  }
}

// ---------------------------------------------------------------- the rules

/** a tableau build descends in rank and alternates colour; only a king starts one */
export function canDropOnTableau(card: Card, pile: Card[]): boolean {
  const top = pile[pile.length - 1]
  if (!top) return card.rank === 13
  return top.up && isRed(top.suit) !== isRed(card.suit) && card.rank === top.rank - 1
}

/** a foundation climbs one suit from the ace */
export function canDropOnFoundation(card: Card, pile: Card[]): boolean {
  const top = pile[pile.length - 1]
  return top ? top.suit === card.suit && card.rank === top.rank + 1 : card.rank === 1
}

/**
 * How many cards move when you pick this one up. Face-down cards are never
 * draggable, and only the top card of the waste or of a foundation is: a
 * tableau run below a face-up card is always a legal build by construction,
 * so the whole tail comes along.
 */
export function grabSize(board: Board, from: PileRef, cardIndex: number): number {
  if (from.kind === 'tableau') {
    const pile = board.tableau[from.index]
    if (!pile[cardIndex]?.up) return 0
    return pile.length - cardIndex
  }
  const pile = from.kind === 'waste' ? board.waste : board.foundations[from.index]
  return cardIndex === pile.length - 1 && pile.length > 0 ? 1 : 0
}

// ---------------------------------------------------------------- scoring

/** how many passes through the stock the rules allow before it stops turning */
export function passLimit(mode: ScoreMode, drawThree: boolean): number {
  if (mode !== 'vegas') return Infinity
  return drawThree ? 3 : 1
}

function scoreMove(
  mode: ScoreMode,
  from: PileKind,
  to: PileKind,
  turnedOver: boolean,
): number {
  if (mode === 'none') return 0
  if (mode === 'vegas') {
    // Vegas pays only for cards that reach a foundation, and takes it back
    if (to === 'foundation' && from !== 'foundation') return 5
    if (to !== 'foundation' && from === 'foundation') return -5
    return 0
  }
  let delta = 0
  if (to === 'foundation' && from !== 'foundation') delta += 10
  if (from === 'waste' && to === 'tableau') delta += 5
  if (from === 'foundation' && to === 'tableau') delta -= 15
  if (turnedOver) delta += 5
  return delta
}

/** the cost of turning the stock over again; Standard only, and never below zero */
function recycleCost(mode: ScoreMode, drawThree: boolean, score: number): number {
  if (mode !== 'standard') return 0
  const cost = drawThree ? 20 : 100
  return Math.min(cost, Math.max(0, score))
}

// ---------------------------------------------------------------- moves

const cloneBoard = (b: Board): Board => ({
  stock: [...b.stock],
  waste: [...b.waste],
  foundations: b.foundations.map((p) => [...p]),
  tableau: b.tableau.map((p) => [...p]),
})

const isWon = (b: Board) => b.foundations.every((p) => p.length === 13)

function takeFrom(board: Board, from: PileRef, count: number): Card[] {
  const pile =
    from.kind === 'waste'
      ? board.waste
      : from.kind === 'foundation'
        ? board.foundations[from.index]
        : board.tableau[from.index]
  return pile.splice(pile.length - count, count)
}

/**
 * Move `count` cards from one pile to another if the rules allow it, and
 * return the new state — or null, which the caller reads as "snap back".
 * Turning over the card a move uncovers happens here, because it is part of
 * the same move for both Undo and the score.
 */
export function move(
  state: GameState,
  mode: ScoreMode,
  from: PileRef,
  to: PileRef,
  count: number,
): GameState | null {
  if (from.kind === to.kind && from.index === to.index) return null
  if (count < 1) return null
  const board = cloneBoard(state.board)
  const source =
    from.kind === 'waste'
      ? board.waste
      : from.kind === 'foundation'
        ? board.foundations[from.index]
        : board.tableau[from.index]
  if (source.length < count) return null
  const head = source[source.length - count]

  if (to.kind === 'foundation') {
    if (count !== 1 || !canDropOnFoundation(head, board.foundations[to.index])) return null
  } else if (to.kind === 'tableau') {
    if (!canDropOnTableau(head, board.tableau[to.index])) return null
  } else {
    return null
  }

  const moved = takeFrom(board, from, count)
  if (to.kind === 'foundation') board.foundations[to.index].push(...moved)
  else board.tableau[to.index].push(...moved)

  // uncovering a face-down tableau card turns it, and that is worth points
  let turnedOver = false
  if (from.kind === 'tableau') {
    const rest = board.tableau[from.index]
    const top = rest[rest.length - 1]
    if (top && !top.up) {
      top.up = true
      turnedOver = true
    }
  }

  return {
    board,
    score: state.score + scoreMove(mode, from.kind, to.kind, turnedOver),
    passes: state.passes,
    won: isWon(board),
  }
}

/** the stock click: turn `drawCount` cards, or turn the waste back over */
export function drawFromStock(
  state: GameState,
  mode: ScoreMode,
  drawCount: number,
): GameState | null {
  const board = cloneBoard(state.board)
  if (board.stock.length > 0) {
    const taken = board.stock.splice(Math.max(0, board.stock.length - drawCount))
    // the stock is dealt off its top, so the last card taken lands face up first
    taken.reverse()
    for (const card of taken) {
      card.up = true
      board.waste.push(card)
    }
    return { ...state, board, won: isWon(board) }
  }
  if (board.waste.length === 0) return null
  if (state.passes >= passLimit(mode, drawCount > 1)) return null
  board.stock = board.waste.reverse().map((c) => ({ ...c, up: false }))
  board.waste = []
  return {
    board,
    score: state.score - recycleCost(mode, drawCount > 1, state.score),
    passes: state.passes + 1,
    won: false,
  }
}

/** the double-click: the first foundation this card is allowed on, if any */
export function foundationFor(board: Board, card: Card): number | null {
  for (let i = 0; i < 4; i++) if (canDropOnFoundation(card, board.foundations[i])) return i
  return null
}

/**
 * Whether the hand is decided: nothing face-down left and nothing waiting in
 * the stock, so every remaining card can be walked to a foundation. Windows
 * finishes those for you rather than making you click out a won game.
 */
export function canAutoFinish(board: Board): boolean {
  if (isWon(board)) return false
  if (board.stock.length > 0 || board.waste.length > 0) return false
  return board.tableau.every((pile) => pile.every((c) => c.up))
}

/** one step of that walk: the lowest card that can go up, or null when done */
export function nextAutoMove(board: Board): { from: PileRef; to: number } | null {
  let best: { from: PileRef; to: number; rank: number } | null = null
  for (let i = 0; i < 7; i++) {
    const pile = board.tableau[i]
    const top = pile[pile.length - 1]
    if (!top) continue
    const to = foundationFor(board, top)
    if (to === null) continue
    if (!best || top.rank < best.rank) best = { from: { kind: 'tableau', index: i }, to, rank: top.rank }
  }
  return best ? { from: best.from, to: best.to } : null
}

/** the timed game's running cost and the bonus a win pays out */
export function timePenalty(mode: ScoreMode, seconds: number): number {
  // two points every ten seconds, which is why a timed game drifts down
  return mode === 'standard' ? Math.floor(seconds / 10) * 2 : 0
}

export function timeBonus(mode: ScoreMode, seconds: number): number {
  if (mode !== 'standard' || seconds < 30) return 0
  return Math.floor(700_000 / seconds / 10) * 10
}
