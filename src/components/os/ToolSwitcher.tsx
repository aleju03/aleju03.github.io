import { useEffect, useMemo, useState } from 'react'
import { COLUMNS, SLOTS, type ToolId } from '../../game/sandbox/tools/slots'
import { useI18n } from '../../i18n'
import { INK, INK_SOFT, MARK, stockTexture } from './paper'

/*
  The tool switcher is a row of luggage tags hung from the top of the screen.

  It is Garry's Mod's weapon selection in everything that matters: one
  column per number key with the number at its head, the column you are in
  opened out to list what is kept under it, the thing in your hands picked
  out, and the other columns shrunk to their number and a small picture of
  their first item. What it is not is a stack of grey translucent boxes,
  because nothing in this world is made of those: the pause screen is a sheet
  taped to a wall, the console is a till receipt and the catalogue is a paper
  book, so the belt's index is three card tags on strings, each on its own
  stock (manila for the hands, blue carbon for the tools, pink for the
  weapons), their strings running up under a strip of masking tape along the
  top edge. The open tag lists its tools in pencil, each with a hand-drawn
  doodle in the emote wheel's ink and wobble, and the one in your hands is
  swiped with the same terracotta marker the pause sheet and the wheel
  select with.

  It comes down on every change of what is in your hands, whichever way it
  came (a number key, the wheel, `give`, the catalogue), and fades about a
  second and a half after the last one. The change counter `belt.n` is the
  whole trigger: CrtScene bumps it from the frame loop when the belt's slot
  moves, and plays the catalogue's pencil tap with it. `hidden` puts it
  away at once (paused, at a wheel or on a seat, the catalogue, the console
  or the emote wheel up); a change made while it is hidden (the catalogue
  handing over the portal gun) waits and shows when it is not. It is
  mounted for the whole walk so that clock survives the hiding.

  It is only drawn. The walk holds the pointer and the keys, so it takes
  neither: no pointer events, nothing focusable. Only opacity and transform
  animate: the row drops in and fades out, and the open tag swings on its
  string each time it changes (index.css's `tool-tag-swing`). The icons are
  hand-written SVG in a 48-unit box like the emote wheel's, rather than the
  catalogue's pixel thumbnails, which are renders of the 3D guns and belong
  to a printed plate, not a pencilled tag.
*/

export interface BeltState {
  /** the belt's slot (slots.ts's SLOTS) */
  slot: number
  /** the portal gun has been handed over, so the tools column lists it */
  portal: boolean
  /** bumped on every change; 0 is the start of the walk, shown to nobody */
  n: number
}

interface Props {
  belt: BeltState
  hidden: boolean
}

/** how long the tags stay down after the last change */
const HOLD_MS = 1500

/** each column's card, and how far its string drops, so the row is not ruled */
const STOCKS = [
  { base: '#e9dab2', seed: 0x51a7 },
  { base: '#cfdce8', seed: 0x7c33 },
  { base: '#efcfc2', seed: 0x2b91 },
] as const
const DROP = [16, 24, 12]
const TILT = [-2.2, 0, 1.8]

const ink = { stroke: INK, strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const
const card = { ...ink, fill: '#f3ead6' } as const
/** the coloured pencils: one touch of colour per tool, no more */
const BLUE = '#3f8fd0'
const ORANGE = '#e0802e'
const RED = '#c2412c'
const GREEN = '#5f9f6e'

/** the doodles, 48 units square, muzzles to the right */
function Doodle({ tool }: { tool: ToolId }) {
  switch (tool) {
    case 'hands':
      return (
        <g {...ink}>
          {/* an open hand, palm out: the thumb and four fingers drawn
              first, and the palm laid over their roots so no knuckle line
              crosses them. The thumb is a capsule, a thick ink stroke with a
              card-coloured one inside it */}
          <path d="M17 34L7.5 23.5" strokeWidth={8.4} />
          <path d="M17 34L7.5 23.5" stroke={card.fill} strokeWidth={3.4} />
          <rect {...card} x={13.5} y={12} width={5.6} height={18} rx={2.8} />
          <rect {...card} x={19.3} y={8.5} width={5.6} height={21} rx={2.8} />
          <rect {...card} x={25.1} y={10.5} width={5.6} height={19} rx={2.8} />
          <rect {...card} x={30.9} y={15} width={5.2} height={15} rx={2.6} />
          <path d="M13.5 25H36.1V33C36.1 39.5 32 43.5 26 43.5H23.5C17.5 43.5 13.5 39.5 13.5 33Z" fill={card.fill} stroke="none" />
          <path d="M13.5 25V33C13.5 39.5 17.5 43.5 23.5 43.5H26C32 43.5 36.1 39.5 36.1 33V25" />
        </g>
      )
    case 'physgun':
      return (
        <g {...ink}>
          {/* a stubby body, a grip, three claw prongs and the beam's spark */}
          <path {...card} d="M5 21h21l4-3h5v13h-5l-4-3H5z" />
          <path {...card} d="M11 28l-3 11h6l3-11" />
          <path d="M35 19l6-4M35 30l6 4M35 24.5h4" />
          <path d="M42 24.5h4M44 22v5" stroke={BLUE} strokeWidth={2.2} />
          <path d="M14 21v7" strokeWidth={1.6} />
        </g>
      )
    case 'toolgun':
      return (
        <g {...ink}>
          {/* a boxy body, the screen on top, a long thin barrel */}
          <path {...card} d="M5 24h27v9H5z" />
          <path {...card} d="M11 12h16v12H11z" />
          <path d="M14 16h7M14 20h10" stroke={GREEN} strokeWidth={1.8} />
          <path d="M32 28h11" />
          <path {...card} d="M9 33l-2 8h6l2-8" />
        </g>
      )
    case 'portalgun':
      return (
        <g {...ink}>
          {/* a rounded shell, the claws, a lit chamber in two colours */}
          <path {...card} d="M5 22c0-5 4-7 10-7h12c4 0 6 3 6 6v8c0 3-2 6-6 6H15c-6 0-10-3-10-7z" />
          <path d="M33 18l7-4M33 32l7 4M33 25h4" />
          <circle cx="23" cy="25" r="4" stroke={BLUE} strokeWidth={2.2} />
          <path d="M40 25c2-3 5-3 6 0" stroke={ORANGE} strokeWidth={2.2} />
          <path {...card} d="M12 35l-2 7h6l2-7" />
        </g>
      )
    case 'pistol':
      return (
        <g {...ink}>
          {/* a slide, a grip raked back, a trigger in its guard */}
          <path {...card} d="M6 15h33v8H6z" />
          <path {...card} d="M9 23l-3 16h8l3-12h5v-4" />
          <path d="M17 27c0 4 3 5 6 4M22 23v3" />
          <path d="M10 18h4M30 18h6" strokeWidth={1.6} />
        </g>
      )
    case 'camera':
      return (
        <g {...ink}>
          {/* a box body, the lens ringed twice, the flash bump and shutter */}
          <path {...card} d="M5 17h38v22H5z" />
          <path {...card} d="M15 17l3-6h12l3 6" />
          <circle cx="24" cy="28" r="7.5" />
          <circle cx="24" cy="28" r="3.6" stroke={BLUE} strokeWidth={2.2} />
          <path d="M9 22h4" stroke={RED} strokeWidth={2.4} />
          <path d="M37 21h3" strokeWidth={1.8} />
        </g>
      )
    case 'crossbow':
      return (
        <g {...ink}>
          {/* a stock, a bow across its nose, the string drawn, a bolt */}
          <path {...card} d="M4 23h28v5H4z" />
          <path d="M32 9c7 5 7 26 0 32" />
          <path d="M32 9L21 25.5L32 41" strokeWidth={1.4} />
          <path d="M18 25.5h27M45 25.5l-4-3M45 25.5l-4 3" stroke={RED} strokeWidth={2} />
          <path {...card} d="M9 28l-2 10h5l3-10" />
        </g>
      )
    case 'rocket':
      return (
        <g {...ink}>
          {/* a tube on the shoulder, a sight, a grip, the warhead's nose */}
          <path {...card} d="M3 19h35v10H3z" />
          <path {...card} d="M38 17h5v14h-5z" />
          <path d="M43 21.5c3 0 4 1.5 4 2.5s-1 2.5-4 2.5" stroke={RED} strokeWidth={2.2} />
          <path {...card} d="M17 19v-5h7v5" />
          <path {...card} d="M13 29l-2 9h6l2-9" />
        </g>
      )
  }
}

/** a doodle at some size, roughened with the shared pencil filter */
function Icon({ tool, size }: { tool: ToolId; size: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className="shrink-0 overflow-visible">
      <g filter="url(#ts-rough)">
        <Doodle tool={tool} />
      </g>
    </svg>
  )
}

/** the reinforcing ring round a tag's string hole */
function Eyelet() {
  return (
    <span
      className="absolute top-[7px] left-1/2 -ml-[6px] block h-3 w-3 rounded-full"
      style={{ background: 'rgba(40,30,20,0.55)', boxShadow: '0 0 0 2.5px #d9c48f, 0 0 0 3.2px rgba(90,70,40,0.35)' }}
    />
  )
}

/** one pass of a chisel-tip marker: a slanted start, a wavering top and
    bottom edge, and a dry, ragged tail where the tip lifted */
const SWIPE =
  'M7 9C40 5 90 7 150 6C170 5 186 6 194 8L197 13L193 17L198 22L194 27L197 32C170 35 120 34 70 35C45 35 20 36 3 34C5 26 4 17 7 9Z'

/** a tag's cut: the top corners clipped off, the way a luggage tag is */
const TAG_CLIP = 'polygon(12px 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%, 0 12px)'

export default function ToolSwitcher({ belt, hidden }: Props) {
  const { t } = useI18n()
  const words = t.sandbox.belt
  const stocks = useMemo(
    () => STOCKS.map((s) => stockTexture({ base: s.base, seed: s.seed, grain: 0.8, flecks: 40, fleck: '90,74,52' })),
    [],
  )
  // the change whose display has run out; the tags are down while the
  // latest change is not that one. Set only from the timer, so a change made
  // while hidden is still owed when the cover comes off
  const [spent, setSpent] = useState(0)
  useEffect(() => {
    if (hidden || belt.n === 0) return
    const n = belt.n
    const id = window.setTimeout(() => setSpent(n), HOLD_MS)
    return () => window.clearTimeout(id)
  }, [belt.n, hidden])
  const down = !hidden && belt.n > 0 && spent !== belt.n

  const carried = (s: number) => SLOTS[s] !== null && (SLOTS[s] !== 'portalgun' || belt.portal)
  const openCol = COLUMNS.findIndex((c) => c.includes(belt.slot))

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 left-1/2 z-20 -translate-x-1/2 select-none"
      style={{
        opacity: down ? 1 : 0,
        transform: down ? 'translateY(0)' : 'translateY(-18px)',
        transition: down
          ? 'opacity 110ms ease-out, transform 180ms ease-out'
          : 'opacity 420ms ease-in, transform 420ms ease-in',
      }}
    >
      {/* the pencil wobble every doodle is drawn through */}
      <svg width="0" height="0" className="absolute">
        <defs>
          <filter id="ts-rough" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves={2} seed={7} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="1.9" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <div className="relative flex items-start gap-3 px-6">
        {COLUMNS.map((col, c) => {
          const open = c === openCol
          const items = col.filter(carried)
          const first = SLOTS[col[0]]!
          return (
            <div
              // the open tag is re-hung on every change so its swing starts again
              key={open ? `open-${belt.n}` : `c${c}`}
              className={`relative flex flex-col items-center ${open ? 'tool-tag-swing' : ''}`}
              style={open ? undefined : { transform: `rotate(${TILT[c]}deg)`, transformOrigin: '50% 0' }}
            >
              {/* the string, down from under the tape to the tag's hole */}
              <span className="block w-[1.5px]" style={{ height: DROP[c] + 13, background: '#6d5c45', marginBottom: -13, zIndex: 1 }} />
              <div style={{ filter: 'drop-shadow(0 3px 4px rgba(25,18,10,0.45))' }}>
                <div
                  className="relative"
                  style={{
                    backgroundImage: `url(${stocks[c]})`,
                    backgroundColor: STOCKS[c].base,
                    clipPath: TAG_CLIP,
                    padding: open ? '24px 14px 12px' : '24px 8px 9px',
                    minWidth: open ? 150 : 46,
                  }}
                >
                  <Eyelet />
                  {open ? (
                    <>
                      <div className="flex items-baseline gap-2 border-b pb-1" style={{ borderColor: 'rgba(59,50,38,0.3)' }}>
                        <span className="font-display text-[26px] leading-none font-semibold" style={{ color: INK }}>{c + 1}</span>
                        <span className="font-mono text-[10px] tracking-wide" style={{ color: INK_SOFT }}>{words.columns[c]}</span>
                      </div>
                      <ul className="mt-1.5 flex flex-col gap-0.5">
                        {items.map((s) => {
                          const tool = SLOTS[s]!
                          const on = s === belt.slot
                          return (
                            <li key={tool} className="relative flex items-center gap-2 py-0.5 pr-1 whitespace-nowrap">
                              {on && (
                                // the marker's swipe, laid down behind the words
                                <svg
                                  viewBox="0 0 200 40"
                                  preserveAspectRatio="none"
                                  className="absolute -inset-x-2 inset-y-0 h-full w-[calc(100%+16px)]"
                                  style={{ opacity: 0.55, mixBlendMode: 'multiply', transform: 'rotate(-1.2deg)' }}
                                >
                                  <path d={SWIPE} fill={MARK} filter="url(#ts-rough)" />
                                </svg>
                              )}
                              <span className="relative flex items-center gap-2">
                                <Icon tool={tool} size={34} />
                                <span
                                  className="font-display text-[14px] leading-none"
                                  style={{ color: on ? INK : INK_SOFT, fontWeight: on ? 600 : 500 }}
                                >
                                  {words.names[tool]}
                                </span>
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="font-display text-[20px] leading-none font-semibold" style={{ color: INK }}>{c + 1}</span>
                      <span style={{ opacity: 0.75 }}>
                        <Icon tool={first} size={26} />
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {/* the masking tape the strings run up under */}
        <span
          className="absolute -top-1.5 left-0 h-[18px] w-full"
          style={{
            background: 'rgba(238,226,194,0.9)',
            boxShadow: '0 1px 2px rgba(40,30,20,0.25)',
            clipPath: 'polygon(0 12%, 2% 0, 98% 8%, 100% 0, 99% 88%, 100% 100%, 1% 92%, 0 100%)',
            transform: 'rotate(-0.6deg)',
            zIndex: 2,
          }}
        />
      </div>
    </div>
  )
}
