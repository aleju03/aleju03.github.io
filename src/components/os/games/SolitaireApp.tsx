import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { sounds } from '../sounds'
import { useLeaderboard } from './arcade'
import { ScoresPanel, XP_BTN } from './ui'
import { CardBack, CardFace, DeckDefs } from './cards'
import { CARD_H, CARD_W, DECKS, drawCardOnCanvas } from './deck'
import {
  canAutoFinish,
  deal,
  drawFromStock,
  foundationFor,
  grabSize,
  move,
  nextAutoMove,
  passLimit,
  timeBonus,
  timePenalty,
} from './klondike'
import type { Board, Card, GameState, PileRef, ScoreMode } from './klondike'

/*
  Solitaire, rebuilt the way Windows XP shipped it: green baize, a menu bar
  with Game and Help, Deal/Undo/Deck/Options, two sunken status panels
  keeping Score and Time, and the cascade of cards bouncing down the table
  when you win. `klondike.ts` owns the rules and `cards.tsx` owns the deck;
  this file is the table, the hand and the dialogs.

  The layout is XP's own: 71x96 cards on a fixed 570px board that is centred
  rather than stretched, because the pile spacing is part of how the game
  reads. One thing is deliberately not 1:1 — a tableau pile that would
  outgrow the window tightens its fan instead of running off the bottom,
  since a window here can be a third the size of an XP desktop and a clipped
  king is unplayable.

  The hand is a pointer-capture drag, not HTML drag-and-drop, for the reason
  the rest of AlejOS avoids it: the drag image is not ours to style and touch
  never fires it. A drop is scored by overlap area against the pile
  rectangles rather than by nearest centre, which is what goes wrong exactly
  when two fanned piles sit close together.
*/

const GAP = 12
const BOARD_W = CARD_W * 7 + GAP * 6
const PAD = 12
const TOP_Y = PAD
const TABLE_Y = TOP_Y + CARD_H + 24
const FAN_DOWN = 7 // face-down cards in a tableau pile only peek
const FAN_UP = 19
const WASTE_FAN = 14

const colX = (i: number) => PAD + i * (CARD_W + GAP)

type Menu = 'game' | 'help' | null

interface Options {
  drawThree: boolean
  scoring: ScoreMode
  timed: boolean
  statusBar: boolean
  outline: boolean
}

const DEFAULT_OPTIONS: Options = {
  drawThree: true,
  scoring: 'standard',
  timed: true,
  statusBar: true,
  outline: false,
}

const OPTS_KEY = 'alejos-solitaire-options'
const DECK_KEY = 'alejos-solitaire-deck'

function readOptions(): Options {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTS_KEY) ?? 'null') as Partial<Options> | null
    return raw ? { ...DEFAULT_OPTIONS, ...raw } : DEFAULT_OPTIONS
  } catch {
    return DEFAULT_OPTIONS
  }
}

function readDeck(): number {
  try {
    const n = Number(localStorage.getItem(DECK_KEY))
    return Number.isInteger(n) && n >= 0 && n < DECKS.length ? n : 0
  } catch {
    return 0
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable; the session keeps the value in memory */
  }
}

// ---------------------------------------------------------------- layout

/** where a pile sits on the board, and how its cards fan out from there */
interface Slot {
  ref: PileRef
  x: number
  y: number
  /** vertical step between cards; the waste steps sideways instead */
  fanUp: number
  fanDown: number
  fanX: number
}

const slot = (ref: PileRef, x: number, y: number, extra?: Partial<Slot>): Slot => ({
  ref,
  x,
  y,
  fanUp: 0,
  fanDown: 0,
  fanX: 0,
  ...extra,
})

function layout(board: Board, boardH: number): Slot[] {
  const slots: Slot[] = [
    slot({ kind: 'stock', index: 0 }, colX(0), TOP_Y),
    slot({ kind: 'waste', index: 0 }, colX(1), TOP_Y, { fanX: WASTE_FAN }),
  ]
  for (let i = 0; i < 4; i++) slots.push(slot({ kind: 'foundation', index: i }, colX(3 + i), TOP_Y))

  const room = Math.max(CARD_H, boardH - TABLE_Y - PAD)
  for (let i = 0; i < 7; i++) {
    const pile = board.tableau[i]
    const down = pile.filter((c) => !c.up).length
    const up = pile.length - down
    const steps = Math.max(1, down + Math.max(0, up - 1))
    const natural = down * FAN_DOWN + Math.max(0, up - 1) * FAN_UP
    // tighten the fan rather than run off the bottom of a small window
    const squeeze = natural + CARD_H > room ? (room - CARD_H) / steps : null
    slots.push(
      slot({ kind: 'tableau', index: i }, colX(i), TABLE_Y, {
        fanUp: squeeze === null ? FAN_UP : Math.max(6, squeeze),
        fanDown: squeeze === null ? FAN_DOWN : Math.max(2, squeeze * 0.4),
      }),
    )
  }
  return slots
}

/** the first card of the waste that is actually shown; only three ever are */
const wasteFrom = (pile: Card[]) => Math.max(0, pile.length - 3)

/** the offset of card `i` within its pile, in board pixels */
function cardOffset(s: Slot, pile: Card[], i: number): { dx: number; dy: number } {
  if (s.ref.kind === 'waste') return { dx: Math.max(0, i - wasteFrom(pile)) * s.fanX, dy: 0 }
  if (s.ref.kind !== 'tableau') return { dx: 0, dy: 0 }
  let dy = 0
  for (let k = 0; k < i; k++) dy += pile[k].up ? s.fanUp : s.fanDown
  return { dx: 0, dy }
}

const pileOf = (board: Board, ref: PileRef): Card[] =>
  ref.kind === 'stock'
    ? board.stock
    : ref.kind === 'waste'
      ? board.waste
      : ref.kind === 'foundation'
        ? board.foundations[ref.index]
        : board.tableau[ref.index]

// ---------------------------------------------------------------- cascade

interface Faller {
  card: Card
  x: number
  y: number
  vx: number
  vy: number
}

/*
  The bit everybody remembers. Cards leave the foundations one at a time and
  bounce off the bottom of the table, and the canvas is never cleared, so
  each one paints a solid trail of itself across the baize. That "never
  cleared" is the whole effect: clear the frame and it is just cards falling.
*/
function useCascade(active: boolean, board: Board) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    // taken off the foundations from the kings down, a few frames apart
    const queue: { card: Card; x: number }[] = []
    for (let rank = 13; rank >= 1; rank--) {
      for (let f = 0; f < 4; f++) {
        const card = board.foundations[f][rank - 1]
        if (card) queue.push({ card, x: colX(3 + f) })
      }
    }
    const live: Faller[] = []
    let next = 0
    let raf = 0
    let ticks = 0

    const tick = () => {
      ticks += 1
      if (ticks % 4 === 0 && next < queue.length) {
        const q = queue[next++]
        live.push({
          card: q.card,
          x: q.x,
          y: TOP_Y,
          vx: (Math.random() < 0.5 ? -1 : 1) * (1.6 + Math.random() * 4.4),
          vy: -(1 + Math.random() * 3),
        })
      }
      for (let i = live.length - 1; i >= 0; i--) {
        const f = live[i]
        f.vy += 0.32
        f.x += f.vx
        f.y += f.vy
        if (f.y + CARD_H > h) {
          f.y = h - CARD_H
          f.vy = -f.vy * 0.82
          // a card that has stopped bouncing is spent, not parked on the felt
          if (Math.abs(f.vy) < 1.6) {
            live.splice(i, 1)
            continue
          }
        }
        if (f.x < -CARD_W || f.x > w) {
          live.splice(i, 1)
          continue
        }
        drawCardOnCanvas(ctx, f.card, Math.round(f.x), Math.round(f.y))
      }
      if (next < queue.length || live.length > 0) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, board])

  return canvasRef
}

// ---------------------------------------------------------------- chrome

const SUNKEN = 'border border-stone-400 bg-stone-100 shadow-[inset_1px_1px_0_rgba(0,0,0,0.15)]'

function MenuButton({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={`cursor-pointer px-2.5 py-0.5 text-xs ${
          open ? 'bg-blue-700 text-white' : 'text-stone-700 hover:bg-blue-600/10'
        }`}
      >
        {label}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-40 min-w-44 border border-stone-400 bg-stone-100 py-1 shadow-lg">
          {children}
        </div>
      )}
    </div>
  )
}

function MenuRow({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string
  hint?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-6 px-4 py-1 text-left text-xs ${
        disabled
          ? 'cursor-default text-stone-400'
          : 'cursor-pointer text-stone-700 hover:bg-blue-700 hover:text-white'
      }`}
    >
      <span className="flex-1">{label}</span>
      {hint && <span className="opacity-70">{hint}</span>}
    </button>
  )
}

function Dialog({
  title,
  wide,
  onClose,
  children,
}: {
  title: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-stone-950/25 p-3">
      <div
        className={`max-h-full w-full overflow-y-auto rounded-t-md border border-stone-400 bg-stone-200 shadow-xl ${
          wide ? 'max-w-lg' : 'max-w-sm'
        }`}
      >
        <div className="flex items-center justify-between rounded-t-[3px] bg-[linear-gradient(#3f7fd8,#1f56b0)] px-2.5 py-1">
          <span className="text-xs font-semibold text-white">{title}</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="cursor-pointer rounded-sm border border-red-900/40 bg-[#d05a45] px-1.5 text-[11px] leading-4 font-bold text-white"
          >
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

const Radio = ({
  name,
  checked,
  onChange,
  children,
}: {
  name: string
  checked: boolean
  onChange: () => void
  children: ReactNode
}) => (
  <label className="flex cursor-pointer items-center gap-2 text-xs text-stone-700">
    <input
      type="radio"
      name={name}
      checked={checked}
      onChange={onChange}
      className="cursor-pointer"
    />
    {children}
  </label>
)

const Check = ({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: () => void
  children: ReactNode
}) => (
  <label className="flex cursor-pointer items-center gap-2 text-xs text-stone-700">
    <input type="checkbox" checked={checked} onChange={onChange} className="cursor-pointer" />
    {children}
  </label>
)

// ---------------------------------------------------------------- the app

interface DragState {
  cards: Card[]
  from: PileRef
  /** pointer offset inside the grabbed card, in board pixels */
  grabX: number
  grabY: number
  x: number
  y: number
  /** a press that never travelled is a click, not a hand */
  moved: boolean
}

export function SolitaireApp({ close }: { close: () => void }) {
  const { name, best, submit } = useLeaderboard('solitaire')
  const [options, setOptions] = useState<Options>(readOptions)
  const [deck, setDeck] = useState<number>(readDeck)
  const [game, setGame] = useState<GameState>(() => deal(readOptions().scoring, null))
  const [undo, setUndo] = useState<GameState | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [started, setStarted] = useState(false)
  const [menu, setMenu] = useState<Menu>(null)
  const [dialog, setDialog] = useState<'deck' | 'options' | 'about' | 'won' | null>(null)
  const [scoresOpen, setScoresOpen] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [boardH, setBoardH] = useState(520)
  const [finalScore, setFinalScore] = useState<{ score: number; bonus: number } | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const wonRef = useRef(false)
  const submitRef = useRef(submit)
  useEffect(() => {
    submitRef.current = submit
  }, [submit])

  const slots = useMemo(() => layout(game.board, boardH), [game.board, boardH])
  const slotFor = useCallback(
    (ref: PileRef) => slots.find((s) => s.ref.kind === ref.kind && s.ref.index === ref.index)!,
    [slots],
  )
  const cascadeRef = useCascade(game.won, game.board)

  useEffect(() => {
    const el = tableRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBoardH(el.clientHeight))
    ro.observe(el)
    setBoardH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // the clock only runs on a timed game, and only once a card has moved
  useEffect(() => {
    if (!options.timed || !started || game.won) return
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [options.timed, started, game.won])

  const penalty = options.timed ? timePenalty(options.scoring, seconds) : 0
  const shownScore =
    options.scoring === 'vegas' ? game.score : Math.max(0, game.score - penalty)

  const newDeal = useCallback((opts: Options) => {
    wonRef.current = false
    setGame(deal(opts.scoring, null))
    setUndo(null)
    setSeconds(0)
    setStarted(false)
    setFinalScore(null)
    setDialog(null)
    sounds.open()
  }, [])

  /** one level of undo, exactly as the original offered */
  const commit = useCallback((prev: GameState, next: GameState) => {
    setUndo(prev)
    setGame(next)
    setStarted(true)
  }, [])

  const tryMove = useCallback(
    (from: PileRef, to: PileRef, count: number) => {
      const next = move(game, options.scoring, from, to, count)
      if (!next) return false
      commit(game, next)
      sounds.click()
      return true
    },
    [game, options.scoring, commit],
  )

  const onStock = () => {
    if (game.won) return
    const next = drawFromStock(game, options.scoring, options.drawThree ? 3 : 1)
    if (!next) {
      sounds.error()
      return
    }
    commit(game, next)
    sounds.blip()
  }

  const sendToFoundation = useCallback(
    (ref: PileRef, cardIndex: number) => {
      const pile = pileOf(game.board, ref)
      if (cardIndex !== pile.length - 1) return false
      const card = pile[cardIndex]
      if (!card?.up) return false
      const target = foundationFor(game.board, card)
      if (target === null) return false
      return tryMove(ref, { kind: 'foundation', index: target }, 1)
    },
    [game.board, tryMove],
  )

  // once the hand is decided, walk the rest up rather than make you click it out
  useEffect(() => {
    if (game.won || !canAutoFinish(game.board)) return
    const id = window.setTimeout(() => {
      const step = nextAutoMove(game.board)
      if (!step) return
      const next = move(game, options.scoring, step.from, { kind: 'foundation', index: step.to }, 1)
      if (!next) return
      setGame(next)
      setUndo(null)
      sounds.click()
    }, 90)
    return () => window.clearTimeout(id)
  }, [game, options.scoring])

  // the win: bank the bonus once, then let the cascade run before the dialog
  useEffect(() => {
    if (!game.won || wonRef.current) return
    wonRef.current = true
    const bonus = options.timed ? timeBonus(options.scoring, Math.max(1, seconds)) : 0
    const total = Math.max(0, game.score - penalty + bonus)
    setFinalScore({ score: total, bonus })
    sounds.fanfare()
    if (options.scoring === 'standard' && total > 0) void submitRef.current(total)
    const id = window.setTimeout(() => setDialog('won'), 4500)
    return () => window.clearTimeout(id)
  }, [game.won, game.score, options.timed, options.scoring, penalty, seconds])

  const doUndo = () => {
    if (!undo) return
    setGame(undo)
    setUndo(null)
    sounds.close()
  }

  // ------------------------------------------------------------ the hand

  const boardPoint = (e: React.PointerEvent) => {
    const rect = boardRef.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }

  const onCardDown = (e: React.PointerEvent, ref: PileRef, cardIndex: number) => {
    if (game.won || dialog) return
    const count = grabSize(game.board, ref, cardIndex)
    if (count === 0) return
    e.preventDefault()
    const pile = pileOf(game.board, ref)
    const s = slotFor(ref)
    const off = cardOffset(s, pile, cardIndex)
    const p = boardPoint(e)
    const next: DragState = {
      cards: pile.slice(cardIndex),
      from: ref,
      grabX: p.x - (s.x + off.dx),
      grabY: p.y - (s.y + off.dy),
      x: p.x,
      y: p.y,
      moved: false,
    }
    dragRef.current = next
    setDrag(next)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const p = boardPoint(e)
    const moved = d.moved || Math.abs(p.x - d.x) > 3 || Math.abs(p.y - d.y) > 3
    const next = { ...d, x: p.x, y: p.y, moved }
    dragRef.current = next
    setDrag(next)
  }

  /** the pile whose rectangle the dragged card overlaps most, if any */
  const dropTarget = (d: DragState): PileRef | null => {
    const cx = d.x - d.grabX
    const cy = d.y - d.grabY
    let bestRef: PileRef | null = null
    let bestArea = 0
    for (const s of slots) {
      if (s.ref.kind === 'stock' || s.ref.kind === 'waste') continue
      const pile = pileOf(game.board, s.ref)
      const off = pile.length > 0 ? cardOffset(s, pile, pile.length - 1) : { dx: 0, dy: 0 }
      const tx = s.x + off.dx
      const ty = s.y + off.dy
      const ox = Math.min(cx + CARD_W, tx + CARD_W) - Math.max(cx, tx)
      const oy = Math.min(cy + CARD_H, ty + CARD_H) - Math.max(cy, ty)
      if (ox <= 0 || oy <= 0) continue
      if (ox * oy > bestArea) {
        bestArea = ox * oy
        bestRef = s.ref
      }
    }
    return bestRef
  }

  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    setDrag(null)
    // a press that never travelled was a click; the double-click handler owns it
    if (!d || !d.moved) return
    const target = dropTarget(d)
    if (!target || !tryMove(d.from, target, d.cards.length)) sounds.miss()
  }

  // F2 deals and Ctrl+Z undoes, but only while this window holds focus
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault()
      newDeal(options)
    } else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      doUndo()
    }
  }

  // ------------------------------------------------------------ rendering

  const isInHand = (ref: PileRef, index: number) =>
    drag !== null &&
    drag.moved &&
    drag.from.kind === ref.kind &&
    drag.from.index === ref.index &&
    index >= pileOf(game.board, ref).length - drag.cards.length

  const renderCard = (card: Card, s: Slot, pile: Card[], i: number) => {
    const off = cardOffset(s, pile, i)
    const grabbable = grabSize(game.board, s.ref, i) > 0
    return (
      <div
        key={card.id}
        onPointerDown={(e) => onCardDown(e, s.ref, i)}
        onDoubleClick={() => {
          if (card.up && !sendToFoundation(s.ref, i)) sounds.miss()
        }}
        className={`absolute ${grabbable ? 'cursor-grab' : 'cursor-default'} ${
          isInHand(s.ref, i) ? 'opacity-0' : ''
        }`}
        style={{
          left: s.x + off.dx,
          top: s.y + off.dy,
          width: CARD_W,
          height: CARD_H,
          filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.35))',
        }}
      >
        {card.up ? <CardFace card={card} /> : <CardBack deck={deck} />}
      </div>
    )
  }

  const stockDead =
    game.board.stock.length === 0 &&
    (game.board.waste.length === 0 || game.passes >= passLimit(options.scoring, options.drawThree))

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={() => rootRef.current?.focus()}
      className="flex h-full flex-col bg-stone-200 outline-none select-none"
    >
      <DeckDefs />

      <div className="flex shrink-0 items-center border-b border-stone-300 bg-stone-200">
        <MenuButton
          label="Game"
          open={menu === 'game'}
          onToggle={() => setMenu(menu === 'game' ? null : 'game')}
        >
          <div onClick={() => setMenu(null)}>
            <MenuRow label="Deal" hint="F2" onClick={() => newDeal(options)} />
            <MenuRow label="Undo" hint="Ctrl+Z" disabled={!undo} onClick={doUndo} />
            <div className="my-1 border-t border-stone-300" />
            <MenuRow label="Deck..." onClick={() => setDialog('deck')} />
            <MenuRow label="Options..." onClick={() => setDialog('options')} />
            <div className="my-1 border-t border-stone-300" />
            <MenuRow label="High Scores" onClick={() => setScoresOpen(true)} />
            <div className="my-1 border-t border-stone-300" />
            <MenuRow label="Exit" onClick={close} />
          </div>
        </MenuButton>
        <MenuButton
          label="Help"
          open={menu === 'help'}
          onToggle={() => setMenu(menu === 'help' ? null : 'help')}
        >
          <div onClick={() => setMenu(null)}>
            <MenuRow label="About Solitaire" onClick={() => setDialog('about')} />
          </div>
        </MenuButton>
      </div>

      <div
        ref={tableRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-[#0a7d34]"
        onPointerDown={() => setMenu(null)}
      >
        <div className="absolute inset-0 flex justify-center overflow-hidden">
          <div
            ref={boardRef}
            className="relative touch-none"
            style={{ width: BOARD_W + PAD * 2 }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {slots.map((s) => (
              <div
                key={`${s.ref.kind}-${s.ref.index}`}
                className="absolute rounded-[5px] border border-white/35"
                style={{ left: s.x, top: s.y, width: CARD_W, height: CARD_H }}
              >
                {s.ref.kind === 'foundation' && (
                  <span className="absolute inset-0 flex items-center justify-center font-serif text-2xl text-white/25">
                    A
                  </span>
                )}
              </div>
            ))}

            {/* the stock: a click turns cards, an empty one turns the waste back */}
            <button
              type="button"
              aria-label="Stock"
              onClick={onStock}
              className="absolute cursor-pointer rounded-[5px]"
              style={{ left: colX(0), top: TOP_Y, width: CARD_W, height: CARD_H }}
            >
              {game.board.stock.length > 0 ? (
                <CardBack deck={deck} />
              ) : (
                <span
                  className={`flex h-full w-full items-center justify-center rounded-[5px] border text-3xl ${
                    stockDead ? 'border-white/20 text-white/20' : 'border-white/45 text-white/55'
                  }`}
                >
                  ↻
                </span>
              )}
            </button>

            {slots.map((s) => {
              if (s.ref.kind === 'stock') return null
              const pile = pileOf(game.board, s.ref)
              const from = s.ref.kind === 'waste' ? wasteFrom(pile) : 0
              return pile.slice(from).map((card, k) => renderCard(card, s, pile, from + k))
            })}

            {drag?.moved &&
              drag.cards.map((card, i) => (
                <div
                  key={card.id}
                  className="pointer-events-none absolute z-30"
                  style={{
                    left: drag.x - drag.grabX,
                    top: drag.y - drag.grabY + i * FAN_UP,
                    width: CARD_W,
                    height: CARD_H,
                    filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.45))',
                  }}
                >
                  {options.outline ? (
                    <div className="h-full w-full rounded-[5px] border-2 border-white/80" />
                  ) : (
                    <CardFace card={card} />
                  )}
                </div>
              ))}

            {game.won && (
              <canvas
                ref={cascadeRef}
                width={BOARD_W + PAD * 2}
                height={Math.max(200, boardH)}
                className="pointer-events-none absolute inset-0 z-20"
              />
            )}
          </div>
        </div>

        {scoresOpen && (
          <ScoresPanel
            tabs={[{ id: 'solitaire', label: 'Solitaire' }]}
            you={name}
            onClose={() => setScoresOpen(false)}
          />
        )}

        {dialog === 'deck' && (
          <Dialog title="Select Card Back" wide onClose={() => setDialog(null)}>
            <div className="grid grid-cols-6 gap-2">
              {DECKS.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`Card back ${i + 1}`}
                  onClick={() => {
                    sounds.click()
                    setDeck(i)
                    store(DECK_KEY, i)
                  }}
                  className={`cursor-pointer rounded-sm p-0.5 ${
                    deck === i ? 'bg-blue-600' : 'hover:bg-blue-600/25'
                  }`}
                >
                  <CardBack deck={i} />
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className={`${XP_BTN} px-5 py-1 text-xs text-stone-700`}
              >
                OK
              </button>
            </div>
          </Dialog>
        )}

        {dialog === 'options' && (
          <OptionsDialog
            options={options}
            onCancel={() => setDialog(null)}
            onApply={(next) => {
              const redeal = next.scoring !== options.scoring || next.drawThree !== options.drawThree
              setOptions(next)
              store(OPTS_KEY, next)
              setDialog(null)
              if (redeal) newDeal(next)
            }}
          />
        )}

        {dialog === 'about' && (
          <Dialog title="About Solitaire" onClose={() => setDialog(null)}>
            <p className="text-xs leading-relaxed text-stone-700">
              Solitaire for AlejOS. Klondike, dealt from a deck that does not exist as a file:
              every card here is vector art built at runtime, like everything else on this
              desktop. Deal with F2, undo with Ctrl+Z, double-click a card to send it home.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className={`${XP_BTN} px-5 py-1 text-xs text-stone-700`}
              >
                OK
              </button>
            </div>
          </Dialog>
        )}

        {dialog === 'won' && finalScore && (
          <Dialog title="Congratulations" onClose={() => setDialog(null)}>
            <p className="text-xs text-stone-700">You won.</p>
            <p className="mt-2 font-mono text-2xl font-bold text-stone-800">{finalScore.score}</p>
            {finalScore.bonus > 0 && (
              <p className="mt-1 text-[11px] text-stone-500">
                including a {finalScore.bonus} point bonus for finishing in {seconds}s
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className={`${XP_BTN} px-4 py-1 text-xs text-stone-700`}
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => newDeal(options)}
                className={`${XP_BTN} px-4 py-1 text-xs font-medium text-stone-700`}
              >
                Deal again
              </button>
            </div>
          </Dialog>
        )}
      </div>

      {options.statusBar && (
        <div className="flex shrink-0 items-center gap-2 border-t border-stone-300 bg-stone-200 px-2 py-1 text-[11px] text-stone-600">
          <span className="flex-1 truncate">{best === null ? '' : `best ${best}`}</span>
          <span className={`${SUNKEN} px-2 py-0.5 tabular-nums`}>
            Score: {options.scoring === 'none' ? '—' : shownScore}
          </span>
          <span className={`${SUNKEN} px-2 py-0.5 tabular-nums`}>
            Time: {options.timed ? seconds : '—'}
          </span>
        </div>
      )}
    </div>
  )
}

function OptionsDialog({
  options,
  onApply,
  onCancel,
}: {
  options: Options
  onApply: (next: Options) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(options)
  const set = <K extends keyof Options>(key: K, value: Options[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  return (
    <Dialog title="Options" onClose={onCancel}>
      <div className="grid grid-cols-2 gap-3">
        <fieldset className="rounded-sm border border-stone-400 p-3">
          <legend className="px-1 text-[11px] font-semibold text-stone-600">Draw</legend>
          <div className="flex flex-col gap-1.5">
            <Radio
              name="sol-draw"
              checked={!draft.drawThree}
              onChange={() => set('drawThree', false)}
            >
              Draw one
            </Radio>
            <Radio name="sol-draw" checked={draft.drawThree} onChange={() => set('drawThree', true)}>
              Draw three
            </Radio>
          </div>
        </fieldset>
        <fieldset className="rounded-sm border border-stone-400 p-3">
          <legend className="px-1 text-[11px] font-semibold text-stone-600">Scoring</legend>
          <div className="flex flex-col gap-1.5">
            <Radio
              name="sol-score"
              checked={draft.scoring === 'standard'}
              onChange={() => set('scoring', 'standard')}
            >
              Standard
            </Radio>
            <Radio
              name="sol-score"
              checked={draft.scoring === 'vegas'}
              onChange={() => set('scoring', 'vegas')}
            >
              Vegas
            </Radio>
            <Radio
              name="sol-score"
              checked={draft.scoring === 'none'}
              onChange={() => set('scoring', 'none')}
            >
              None
            </Radio>
          </div>
        </fieldset>
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        <Check checked={draft.timed} onChange={() => set('timed', !draft.timed)}>
          Timed game
        </Check>
        <Check checked={draft.statusBar} onChange={() => set('statusBar', !draft.statusBar)}>
          Status bar
        </Check>
        <Check checked={draft.outline} onChange={() => set('outline', !draft.outline)}>
          Outline dragging
        </Check>
      </div>
      <p className="mt-3 text-[11px] text-stone-500">
        Changing the draw or the scoring starts a new hand.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={`${XP_BTN} px-4 py-1 text-xs text-stone-700`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onApply(draft)}
          className={`${XP_BTN} px-5 py-1 text-xs font-medium text-stone-700`}
        >
          OK
        </button>
      </div>
    </Dialog>
  )
}
