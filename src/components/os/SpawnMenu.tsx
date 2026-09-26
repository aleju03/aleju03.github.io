import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import type { PropKind } from '../../game/sandbox/kinds'
import type { SpawnCategory, SpawnEntry } from '../../game/sandbox/spawnlist'
import { MARK, stockTexture } from './paper'
import { keyHint } from '../../game/sandbox/bindings'
import { labelIn, type Label } from '../../game/sandbox/history'

/*
  The spawn menu is a mail-order catalogue.

  Hold Q and a catalogue comes up in your hands, open at its spread: the left
  page is the contents (every category with a dotted leader running out to its
  page number, the way the front of a real catalogue reads) and your order
  slip, a pink carbon copy of what you have spawned, newest first; the right
  page is the category you are on, laid out as product plates. Each plate is
  the prop's own model drawn as a pixel-art icon (the props piece's
  `sandbox/thumbnails.ts`), its catalogue number, its name, and the small
  print a catalogue would give it, which here is the physics' own numbers:
  how heavy it is and whether it floats, breaks or blows up. Hovering a plate
  rings it in pencil, which is what you do to a catalogue when you want
  something; clicking it rubber-stamps SENT in the plate's corner and the
  thing lands where you were looking. Let go of Q and the catalogue goes
  away.

  It is a thing and not a panel: a paper catalogue with a red card cover
  showing round its edges, the page stacks thickening towards the fore-edges,
  two staples in the fold, the bottom corner of the right page curling up,
  and the whole book tipped back a few degrees and a degree off square, the
  way one is held open in front of you.

  It is Garry's Mod's Q menu in everything that matters: a grid of every prop
  by category, one click to spawn at the crosshair, the undo list beside it.
  What it is not is a grey panel of tabs and scroll bars, because nothing in
  this world is made of those.

  The data comes from `sandbox/catalogue.ts` (the one list of what can be
  spawned), read through `sandbox/spawnlist.ts` into a small source object
  the scene hands over once the world has loaded; until then the catalogue
  says it is on its way. Every string is in both
  languages, and the paper and inks are literal hex like the pause sheet's.
*/

const PAGE = '#efe8d8'
const INK = '#26211a'
const INK_SOFT = '#81745f'
/** the catalogue's own spot colour: mastheads, numbers, the stamp */
const RED = '#c2412c'
const SLIP = '#f1d3c9'
/** the page stack's edges, alternating so the lines read as sheets */
const EDGE_A = '#e4dbc6'
const EDGE_B = '#c9bda3'

export interface CatalogueSource {
  entries: () => SpawnEntry[]
  categories: (entries: SpawnEntry[]) => SpawnCategory[]
  kind: (id: string) => PropKind | undefined
  note: (k: PropKind, lang: 'en' | 'es') => string
  /** every plate's picture, drawn once (thumbnails.ts), by id */
  thumbs: () => Promise<Map<string, string>>
}

export interface OrderLine {
  seq: number
  label: Label
  kind?: string
}

export interface SpawnMenuProps {
  open: boolean
  source: CatalogueSource | null
  orders: OrderLine[]
  onSpawn: (id: string) => void
  /** the find line has the keyboard: the catalogue stays up without q, and
      the walk stops reading keys, until it lets go */
  onPin: (pinned: boolean) => void
  /** esc from the find line */
  onClose: () => void
}

const ALL = '*'

/** a pencil ring, drawn rather than bordered: two passes that do not meet */
function Ring() {
  return (
    <svg aria-hidden viewBox="0 0 200 200" preserveAspectRatio="none" className="pointer-events-none absolute -top-1 -left-1.5 h-[calc(100%+8px)] w-[calc(100%+12px)]">
      <path
        d="M46 7C96 1 150 3 178 10c16 8 17 52 16 92-1 44-2 76-14 86-34 9-110 9-160 3C6 184 4 140 5 98 6 56 6 22 22 12c18-8 52-9 88-8"
        fill="none"
        stroke={MARK}
        strokeWidth="3.2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export default function SpawnMenu({ open, source, orders, onSpawn, onPin, onClose }: SpawnMenuProps) {
  const { language, t } = useI18n()
  const s = t.sandbox.menu
  const [cat, setCat] = useState(ALL)
  const [stamped, setStamped] = useState<{ id: string; n: number } | null>(null)
  /** the plate the pencil is over. State rather than :hover, which a
      coarse-pointer media query (and a headless drive) would switch off */
  const [ringed, setRinged] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [finding, setFinding] = useState(false)
  const [pics, setPics] = useState<Map<string, string> | null>(null)
  // the icons are drawn the first time the book is opened, in a context of
  // their own (thumbnails.ts), and kept for the session
  useEffect(() => {
    if (!open || !source || pics) return
    let live = true
    void source.thumbs().then((m) => live && setPics(m))
    return () => {
      live = false
    }
  }, [open, source, pics])
  const findRef = useRef<HTMLInputElement>(null)
  const pageStock = useMemo(
    () => stockTexture({ base: PAGE, seed: 0xca7a1, grain: 0.7, flecks: 50, fleck: '90,80,60' }),
    [],
  )
  const slipStock = useMemo(
    () => stockTexture({ base: SLIP, seed: 0x5119, grain: 0.6, flecks: 20, fleck: '120,60,50' }),
    [],
  )
  // read on every open, so a catalogue registered mid-session shows up
  const entries = useMemo(() => (open && source ? source.entries() : []), [open, source])
  const cats = useMemo(() => (source ? source.categories(entries) : []), [source, entries])
  if (!open) return null

  const current = cat === ALL || cats.some((c) => c.id === cat) ? cat : ALL
  const catName = (c: SpawnCategory) => (language === 'es' ? c.labelEs : c.label)
  // a search reads the whole catalogue, whatever page it is open at, in
  // both languages, so "barril" finds the drum with the menu in English
  const q = query.trim().toLowerCase()
  const catOf = (id: string) => cats.find((c) => c.id === id)
  const shown = q
    ? entries.filter((e) =>
        [e.id, e.label, e.labelEs ?? '', catOf(e.category)?.label ?? '', catOf(e.category)?.labelEs ?? '']
          .some((w) => w.toLowerCase().includes(q)))
    : current === ALL ? entries : entries.filter((e) => e.category === current)
  const title = q ? `${s.find} "${query.trim()}"` : current === ALL ? s.everything : catName(catOf(current)!)
  // page numbers: the contents is page 1, every category a page after it
  const pageOf = (id: string) => (id === ALL ? 2 : 3 + cats.findIndex((c) => c.id === id))

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/15"
      style={{ perspective: 1500 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <style>{`
        @keyframes cat-up { from { transform: translateY(60px) rotateX(24deg) rotate(1.4deg); opacity: 0 } to { transform: rotateX(8deg) rotate(-1.2deg); opacity: 1 } }
        @keyframes cat-page { from { transform: translateX(10px); opacity: 0 } to { transform: none; opacity: 1 } }
        @keyframes cat-stamp { 0% { transform: scale(1.8) rotate(12deg); opacity: 0 } 16% { transform: scale(1) rotate(12deg); opacity: 0.9 } 80% { opacity: 0.9 } 100% { transform: scale(1) rotate(12deg); opacity: 0 } }
      `}</style>
      <div
        className="pointer-events-auto relative flex select-none"
        style={{
          width: 'min(960px, 92vw)',
          height: 'min(600px, 84vh)',
          transform: 'rotateX(8deg) rotate(-1.2deg)',
          transformOrigin: '50% 100%',
          animation: 'cat-up 190ms cubic-bezier(.2,.9,.3,1.15)',
          filter: 'drop-shadow(0 22px 26px rgba(0,0,0,0.5))',
          color: INK,
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* the red card cover, a few millimetres proud of the pages all round */}
        <div
          aria-hidden
          className="absolute -inset-x-[9px] -top-[7px] -bottom-[11px]"
          style={{
            background: 'linear-gradient(90deg, #8f2f20, #a8392a 48%, #7a2619 50%, #a8392a 52%, #8f2f20)',
            borderRadius: '8px',
            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)',
          }}
        />
        {/* ---- the left page: masthead, contents, order slip ---- */}
        <section
          className="relative flex w-[34%] flex-col rounded-l-[5px] px-7 pt-6 pb-5"
          style={{
            backgroundColor: PAGE,
            backgroundImage: `linear-gradient(90deg, rgba(0,0,0,0) 72%, rgba(60,40,20,0.1) 88%, rgba(50,32,16,0.3)), url(${pageStock})`,
            // the page stack under this one, thickening towards the fore-edge
            boxShadow: `-1px 1px 0 ${EDGE_A}, -2px 2px 0 ${EDGE_B}, -3px 3px 0 ${EDGE_A}, -4px 4px 0 ${EDGE_B}, -5px 5px 0 ${EDGE_A}`,
          }}
        >
          <h2 className="font-display text-[40px] leading-[0.9] font-semibold tracking-tight" style={{ color: RED }}>
            {s.title}
          </h2>
          <div aria-hidden className="mt-2 border-t-[3px] border-b" style={{ borderColor: INK, height: 5 }} />
          <p className="mt-2 font-mono text-[11px] leading-snug" style={{ color: INK_SOFT }}>
            {s.lead}
          </p>
          <h3 className="font-display mt-4 text-[13px] font-semibold tracking-[0.18em] uppercase">{s.contents}</h3>
          <ul className="mt-1">
            {[{ id: ALL, label: s.everything, labelEs: s.everything }, ...cats].map((c) => {
              const on = !q && current === c.id
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    data-category={c.id}
                    // a click must not take focus off the find line, whose
                    // blur is what lets the catalogue close
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      setCat(c.id)
                      setQuery('')
                    }}
                    className="group relative flex w-full items-baseline gap-1.5 py-[2px] text-left"
                  >
                    <span
                      aria-hidden
                      className={`absolute -inset-x-2 inset-y-0 -z-0 transition-opacity ${on ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'}`}
                      style={{ background: `${MARK}55`, borderRadius: '9px 13px 8px 15px', transform: 'rotate(-0.7deg)' }}
                    />
                    <span className="font-display relative text-[16px] leading-tight font-medium">
                      {c.id === ALL ? c.label : catName(c)}
                    </span>
                    <span aria-hidden className="relative mx-1 flex-1 translate-y-[-4px] border-b-2 border-dotted" style={{ borderColor: `${INK}55` }} />
                    <span className="relative font-mono text-[12px] tabular-nums" style={{ color: RED }}>
                      {pageOf(c.id)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {/* the find line: pencilled on the page. Focusing it pins the
              catalogue open, so q can be let go of and the name typed */}
          <label className="mt-3 mb-3 flex items-baseline gap-2 font-mono text-[12px]">
            <span className="font-display text-[13px] font-semibold tracking-[0.18em] uppercase">{s.find}</span>
            <input
              ref={findRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => {
                setFinding(true)
                onPin(true)
              }}
              onBlur={() => {
                setFinding(false)
                onPin(false)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setQuery('')
                  findRef.current?.blur()
                  onClose()
                } else if (e.key === 'Enter' && shown.length) {
                  // enter orders the first thing on the page
                  e.preventDefault()
                  onSpawn(shown[0].id)
                  setStamped((p) => ({ id: shown[0].id, n: (p?.n ?? 0) + 1 }))
                }
              }}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              placeholder={s.findHint}
              className="min-w-0 flex-1 border-b-2 border-dotted bg-transparent px-0.5 pb-0.5 placeholder:italic"
              style={{ borderColor: `${INK}55`, color: INK, outline: 'none', caretColor: RED }}
            />
          </label>
          {/* the order slip: a carbon copy of what you have had delivered */}
          <div
            className="mt-auto -mr-2 px-4 pt-3 pb-3"
            style={{
              backgroundColor: SLIP,
              backgroundImage: `url(${slipStock})`,
              transform: 'rotate(1.6deg)',
              boxShadow: '0 2px 5px rgba(60,30,20,0.18)',
              borderTop: `2px dashed ${INK}33`,
            }}
          >
            <p className="font-display text-[12px] font-semibold tracking-[0.16em] uppercase" style={{ color: RED }}>
              {s.orders}
            </p>
            {orders.length === 0 ? (
              <p className="mt-1 font-mono text-[11px] italic" style={{ color: INK_SOFT }}>{s.ordersEmpty}</p>
            ) : (
              <ol className="mt-1 space-y-px font-mono text-[11px]">
                {orders.slice(0, 5).map((o, i) => (
                  <li key={o.seq} className="flex gap-2" style={{ opacity: 1 - i * 0.14 }}>
                    <span className="tabular-nums" style={{ color: INK_SOFT }}>{String(o.seq).padStart(3, '0')}</span>
                    <span className="truncate">{labelIn(o.label, language)}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-1.5 font-mono text-[10px]" style={{ color: INK_SOFT }}>{keyHint(s.undoHint, language)}</p>
          </div>
        </section>

        {/* the gutter: the two pages fold into it, stapled twice */}
        <div aria-hidden className="relative w-[4px]" style={{ background: 'linear-gradient(90deg, rgba(40,25,10,0.45), rgba(40,25,10,0.12))' }}>
          {['28%', '70%'].map((top) => (
            <span
              key={top}
              className="absolute left-1/2 h-[26px] w-[5px] -translate-x-1/2 rounded-[2px]"
              style={{
                top,
                background: 'linear-gradient(90deg, #8d8f93, #e4e6e8 45%, #9fa2a6)',
                boxShadow: '0 1px 1px rgba(0,0,0,0.45)',
              }}
            />
          ))}
        </div>

        {/* ---- the right page: the plates ---- */}
        <section
          className="relative flex flex-1 flex-col rounded-r-[5px] px-7 pt-6 pb-4"
          style={{
            backgroundColor: PAGE,
            backgroundImage: `linear-gradient(90deg, rgba(50,32,16,0.3), rgba(60,40,20,0.1) 5%, rgba(0,0,0,0) 16%), url(${pageStock})`,
            boxShadow: `1px 1px 0 ${EDGE_A}, 2px 2px 0 ${EDGE_B}, 3px 3px 0 ${EDGE_A}, 4px 4px 0 ${EDGE_B}, 5px 5px 0 ${EDGE_A}`,
          }}
        >
          {/* the curl: the corner turned up towards you, its pale underside
              over the next sheet down, which is a shade darker */}
          <span
            aria-hidden
            className="pointer-events-none absolute right-0 bottom-0 size-[34px]"
            style={{
              background:
                'linear-gradient(135deg, rgba(0,0,0,0) 49%, rgba(40,25,10,0.28) 50%, rgba(0,0,0,0) 56%), ' +
                'linear-gradient(315deg, #ddd2bb 0 49%, rgba(0,0,0,0) 50%), ' +
                'linear-gradient(135deg, #d6c9ae, #ece3cf 26%, #f7f1e4 49%, rgba(0,0,0,0) 50%)',
            }}
          />
          <div className="flex items-baseline gap-3">
            <h3 className="font-display text-[26px] leading-none font-semibold">{title}</h3>
            <span className="font-mono text-[11px]" style={{ color: INK_SOFT }}>
              {shown.length}
            </span>
          </div>
          <div aria-hidden className="mt-2 border-t" style={{ borderColor: INK }} />
          {!source ? (
            <p className="mt-10 max-w-[28ch] font-mono text-[13px] leading-relaxed" style={{ color: INK_SOFT }}>
              {s.loading}
            </p>
          ) : (
            <div
              key={q ? `?${q}` : current}
              className="-mx-2 mt-3 grid flex-1 content-start gap-x-3 gap-y-2 overflow-y-auto px-2 pb-2"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))',
                animation: 'cat-page 160ms ease-out',
                scrollbarWidth: 'none',
              }}
            >
              {shown.length === 0 && (
                <p className="col-span-full mt-6 font-mono text-[13px] italic" style={{ color: INK_SOFT }}>
                  {s.noMatch}
                </p>
              )}
              {shown.map((e) => {
                const k = source.kind(e.id)
                const n = entries.indexOf(e) + 1
                const pic = pics?.get(e.id)
                const name = language === 'es' ? e.labelEs : e.label
                const note = k ? source.note(k, language) : ''
                return (
                  <button
                    key={e.id}
                    data-kind={e.id}
                    type="button"
                    onClick={() => {
                      onSpawn(e.id)
                      setStamped((p) => ({ id: e.id, n: (p?.n ?? 0) + 1 }))
                    }}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onPointerEnter={() => setRinged(e.id)}
                    onPointerLeave={() => setRinged((r) => (r === e.id ? null : r))}
                    className="group relative flex flex-col items-center px-1 pt-1.5 pb-2 text-center"
                  >
                    {ringed === e.id && <Ring />}
                    {pic ? (
                      <img
                        src={pic}
                        alt=""
                        draggable={false}
                        className="size-[84px] transition-transform duration-150 group-active:translate-y-0.5"
                        style={{ imageRendering: 'pixelated', transform: ringed === e.id ? 'translateY(-2px)' : undefined }}
                      />
                    ) : (
                      <span className="size-[84px]" />
                    )}
                    <span className="font-mono text-[10px] tabular-nums" style={{ color: RED }}>
                      {s.no} {String(n).padStart(2, '0')}
                    </span>
                    <span className="font-display text-[14px] leading-tight font-semibold">{name}</span>
                    <span className="font-mono text-[10.5px]" style={{ color: INK_SOFT }}>{note}</span>
                    {stamped?.id === e.id && (
                      <span
                        key={stamped.n}
                        aria-hidden
                        // in the plate's top corner, clear of the picture and
                        // the words, the way a clerk stamps the margin
                        className="font-display pointer-events-none absolute -top-1 -right-1 rounded-[3px] border-2 px-1 text-[10px] leading-[1.35] font-bold tracking-[0.1em] whitespace-nowrap uppercase"
                        style={{ color: RED, borderColor: RED, animation: 'cat-stamp 1100ms ease-out forwards', mixBlendMode: 'multiply' }}
                      >
                        {s.sent}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <div className="mt-1 flex items-baseline justify-between pr-9 font-mono text-[10px]" style={{ color: INK_SOFT }}>
            <span>{finding ? s.closeFinding : keyHint(s.close, language)}</span>
            <span>
              {s.page} {pageOf(current)}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}
