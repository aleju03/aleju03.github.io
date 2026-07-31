import type { Card, Suit } from './klondike'

/*
  The deck: where a card's picture comes from, and the twelve backs.

  The 52 faces are the real thing — Wine's `cards.dll` bitmaps, the same
  71x96 4-bit DIBs Windows drew Solitaire with, packed into one sprite sheet
  (see the LICENSE beside the file). They were drawn here as SVG first and it
  was not close: a court card is a dense little woodcut, and at a 47x76 panel
  any honest attempt at one reads as a doodle. A sheet is also cheaper than
  52 inline SVGs — one request, one decode, and a face costs a background
  offset rather than forty nodes.

  The backs stay procedural. Wine only carries two of them where Windows
  offered twelve, so the Deck dialog would have lost ten options to gain two
  crosshatches, and a flat repeating pattern is the one part of a deck that
  vector art wins outright.
*/

export const CARD_W = 71
export const CARD_H = 96
export const CARD_R = 5

/** the sheet is 13 ranks across by 4 suits down, in cards.dll's own order */
export const FACES_URL = '/os/games/cards/faces.png'
export const SUIT_ROW: Record<Suit, number> = { clubs: 0, diamonds: 1, hearts: 2, spades: 3 }

export const SUIT_NAME: Record<Suit, string> = {
  clubs: 'clubs',
  diamonds: 'diamonds',
  hearts: 'hearts',
  spades: 'spades',
}

export const RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const RANK_NAME = [
  '',
  'ace',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'jack',
  'queen',
  'king',
]

export const cardName = (card: Card) => `${RANK_NAME[card.rank]} of ${SUIT_NAME[card.suit]}`

/** the sheet's own <img>, held so the cascade can draw straight off it */
let faces: HTMLImageElement | null = null
export function loadFaces(): HTMLImageElement | null {
  if (faces || typeof Image === 'undefined') return faces
  const img = new Image()
  img.src = FACES_URL
  faces = img
  return faces
}

// ---------------------------------------------------------------- backs

/*
  Twelve backs, the same count the Deck dialog offered. Each is a ground
  colour plus one repeating figure, kept to a single <pattern> so a back
  costs one fill however many cards are showing it.
*/
export interface DeckBack {
  ground: string
  ink: string
  /** the pattern tile, in a 12x12 user-space box */
  tile: string
  size?: number
}

export const DECKS: DeckBack[] = [
  { ground: '#1e4fa1', ink: '#9fc0f0', tile: 'M0 6 L6 0 L12 6 L6 12 Z', size: 12 },
  { ground: '#a11e2c', ink: '#f0a8b0', tile: 'M0 6 L6 0 L12 6 L6 12 Z', size: 12 },
  { ground: '#1e4fa1', ink: '#8fb4ec', tile: 'M0 0 H12 M0 6 H12 M3 0 V12 M9 0 V12', size: 12 },
  { ground: '#166534', ink: '#86d9a4', tile: 'M6 1 L11 6 L6 11 L1 6 Z M6 4 L8 6 L6 8 L4 6 Z', size: 12 },
  { ground: '#7c2d12', ink: '#f0b98a', tile: 'M0 3 Q3 0 6 3 T12 3 M0 9 Q3 6 6 9 T12 9', size: 12 },
  { ground: '#3f2a6e', ink: '#c2aef2', tile: 'M6 0 L7.4 4.6 L12 6 L7.4 7.4 L6 12 L4.6 7.4 L0 6 L4.6 4.6 Z', size: 12 },
  { ground: '#0f5b66', ink: '#8fdbe4', tile: 'M0 0 H6 V6 H0 Z M6 6 H12 V12 H6 Z', size: 12 },
  { ground: '#9a3412', ink: '#fbd0a8', tile: 'M6 2 A4 4 0 1 1 5.9 2 M6 5 A1 1 0 1 1 5.9 5', size: 12 },
  { ground: '#334155', ink: '#a9bacd', tile: 'M2 2 H10 V10 H2 Z M0 0 H2 M10 0 H12 M0 12 H2 M10 12 H12', size: 12 },
  { ground: '#7f1d5c', ink: '#f0a8d8', tile: 'M6 6 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0 M0 6 H2 M10 6 H12 M6 0 V2 M6 10 V12', size: 12 },
  { ground: '#155e75', ink: '#a5e4f2', tile: 'M0 12 L12 0 M-3 3 L3 -3 M9 15 L15 9', size: 12 },
  { ground: '#4d7c0f', ink: '#d7f099', tile: 'M6 1 C9 4 9 8 6 11 C3 8 3 4 6 1 Z M1 6 C4 3 8 3 11 6 C8 9 4 9 1 6 Z', size: 12 },
]

// ---------------------------------------------------------------- canvas

/*
  The same card on a 2D context, for the win cascade, blitted straight out of
  the sheet. The cascade draws hundreds of cards a second into one canvas that
  is never cleared, so this has to be a copy and nothing else. A sheet that
  has not decoded yet simply draws nothing, which cannot happen in practice:
  you have to finish a game to see this, and the faces loaded on the deal.
*/
export function drawCardOnCanvas(ctx: CanvasRenderingContext2D, card: Card, x: number, y: number) {
  const sheet = loadFaces()
  if (!sheet?.complete || sheet.naturalWidth === 0) return
  ctx.drawImage(
    sheet,
    (card.rank - 1) * CARD_W,
    SUIT_ROW[card.suit] * CARD_H,
    CARD_W,
    CARD_H,
    x,
    y,
    CARD_W,
    CARD_H,
  )
}
