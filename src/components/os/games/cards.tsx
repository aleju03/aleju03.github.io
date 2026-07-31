import type { Card } from './klondike'
import {
  CARD_H,
  CARD_R,
  CARD_W,
  DECKS,
  FACES_URL,
  SUIT_ROW,
  cardName,
  loadFaces,
} from './deck'

/*
  The two sides of a card. The face is a window onto the sprite sheet, moved
  by a background offset; the back is drawn, because a repeating pattern is
  the one thing vector wins at and because Wine's deck only has two of them.
  See `deck.ts` for why the faces are a bitmap at all.
*/

/**
 * All twelve back patterns, mounted once by the app. A pattern lives in the
 * document, not in the SVG that uses it, so nineteen face-down cards showing
 * the same back share one definition instead of carrying nineteen copies of
 * the same id.
 */
export function DeckDefs() {
  return (
    <svg className="absolute h-0 w-0" aria-hidden="true">
      <defs>
        {DECKS.map((d, i) => (
          <pattern
            key={i}
            id={`sol-back-${i}`}
            width={d.size ?? 12}
            height={d.size ?? 12}
            patternUnits="userSpaceOnUse"
          >
            <path d={d.tile} fill="none" stroke={d.ink} strokeWidth="1.1" />
          </pattern>
        ))}
      </defs>
    </svg>
  )
}

/** the patterned reverse of a card */
export function CardBack({ deck }: { deck: number }) {
  const d = DECKS[deck % DECKS.length]
  return (
    <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`} className="h-full w-full" aria-hidden="true">
      <rect width={CARD_W} height={CARD_H} rx={CARD_R} fill="#fff" />
      <rect x="2" y="2" width={CARD_W - 4} height={CARD_H - 4} rx={CARD_R - 2} fill={d.ground} />
      <rect
        x="4.5"
        y="4.5"
        width={CARD_W - 9}
        height={CARD_H - 9}
        rx="3"
        fill={`url(#sol-back-${deck % DECKS.length})`}
        stroke={d.ink}
        strokeWidth="1"
        opacity="0.95"
      />
    </svg>
  )
}

/*
  The face. The sheet is at its native 71x96 and so is the board, so this is
  a 1:1 blit with no resampling; the card's own transparent corners come from
  the sheet's alpha, which is what lets the drop-shadow on the wrapper follow
  the rounded corner instead of boxing it.
*/
export function CardFace({ card }: { card: Card }) {
  loadFaces()
  return (
    <div
      role="img"
      aria-label={cardName(card)}
      className="h-full w-full"
      style={{
        backgroundImage: `url(${FACES_URL})`,
        backgroundPosition: `${-(card.rank - 1) * CARD_W}px ${-SUIT_ROW[card.suit] * CARD_H}px`,
        backgroundRepeat: 'no-repeat',
      }}
    />
  )
}
