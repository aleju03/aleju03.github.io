import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import type { PropKind } from '../../game/sandbox/kinds'
import type { SpawnCategory, SpawnEntry } from '../../game/sandbox/spawnlist'
import { MARK, stockTexture } from './paper'
import { keyHint } from '../../game/sandbox/bindings'
import { labelIn, type Label } from '../../game/sandbox/history'

/*
  The spawn menu is a mail-order catalogue.

  Hold Q and a catalogue comes up in your hands, open at a spread of product
  plates, two pages of them, dense the way a real one is (a whole small
  catalogue fits on one spread). The sections are index tabs standing up off
  the top edge, one per category, the way a trade catalogue is cut for
  thumbing, and the one you are in stands tallest; the masthead and a
  pencilled find line head the left page; your order slip, a pink carbon copy
  of what you have spawned, is paper-clipped to the bottom edge. Each plate is
  the prop's own model drawn as a pixel-art icon (the props piece's
  `sandbox/thumbnails.ts`), its catalogue number, its name, and the small
  print a catalogue would give it, which here is the physics' own numbers:
  how heavy it is and whether it floats, breaks or blows up. Hovering a plate
  rings it in pencil, which is what you do to a catalogue when you want
  something; clicking it rubber-stamps SENT across the corner of its picture
  and the thing lands where you were looking. Let go of Q and the catalogue
  goes away.

  It is a thing and not a panel: a paper catalogue with a red card cover
  showing round its edges, the page stacks thickening towards the fore-edges,
  two staples in the fold, the bottom corner of the right page curling up
  (lift it, or roll the wheel, for the next spread),
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
  onCleanup: () => void
  /** the find line has the keyboard: the catalogue stays up without q, and
      the walk stops reading keys, until it lets go */
  onPin: (pinned: boolean) => void
  /** esc from the find line */
  onClose: () => void
}

const ALL = '*'
/** plates across a page, and one plate's height (picture, number, name,
    small print). Rows are measured, so a short window gets shorter pages */
const COLS = 5
const PLATE_H = 96
const ROW_GAP = 4
/** the index tabs' paper, cycled: manila, pink, green, blue carbon */
const TAB_TINTS = ['#e8d9b0', '#efc9bd', '#cfe0bf', '#c9d8e6', '#e6d0e3', '#efe0a8']

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

export default function SpawnMenu({ open, source, orders, onSpawn, onCleanup, onPin, onClose }: SpawnMenuProps) {
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
  /** which spread of the current section is open, and how many rows of
      plates a page has room for */
  const [leaf, setLeaf] = useState(0)
  const [rows, setRows] = useState(4)
  const gridRef = useRef<HTMLDivElement>(null)
  const wheelAt = useRef(0)
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const fit = () => setRows(Math.max(1, Math.floor((el.clientHeight + ROW_GAP) / (PLATE_H + ROW_GAP))))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, source])
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
  // a search reads the whole catalogue, whatever section it is open at, in
  // both languages, so "barril" finds the drum with the menu in English
  const q = query.trim().toLowerCase()
  const catOf = (id: string) => cats.find((c) => c.id === id)
  const shown = q
    ? entries.filter((e) =>
        [e.id, e.label, e.labelEs ?? '', catOf(e.category)?.label ?? '', catOf(e.category)?.labelEs ?? '']
          .some((w) => w.toLowerCase().includes(q)))
    : current === ALL ? entries : entries.filter((e) => e.category === current)
  const title = q ? `${s.find} "${query.trim()}"` : current === ALL ? s.everything : catName(catOf(current)!)
  // paginated like a printed book, two pages to a spread: "all of it" runs
  // over as many spreads as it needs from page 1, and each category follows
  // on its own. A search is laid out on the "all of it" pages
  const perPage = COLS * rows
  const perSpread = perPage * 2
  const spreadsOf = (n: number) => Math.max(1, Math.ceil(n / perSpread))
  const sectionStart = (id: string) => {
    let p = 1
    if (id === ALL) return p
    p += spreadsOf(entries.length) * 2
    for (const c of cats) {
      if (c.id === id) return p
      p += spreadsOf(entries.filter((e) => e.category === c.id).length) * 2
    }
    return p
  }
  const spreads = spreadsOf(shown.length)
  const at = Math.min(leaf, spreads - 1)
  const onSpread = shown.slice(at * perSpread, (at + 1) * perSpread)
  const leftPlates = onSpread.slice(0, perPage)
  const rightPlates = onSpread.slice(perPage)
  const firstPage = sectionStart(q ? ALL : current) + at * 2
  const turn = (d: number) => setLeaf(Math.max(0, Math.min(spreads - 1, at + d)))
  const pick = (id: string) => {
    setCat(id)
    setQuery('')
    setLeaf(0)
  }

  const plate = (e: SpawnEntry) => {
    const k = source?.kind(e.id)
    const n = entries.indexOf(e) + 1
    const pic = pics?.get(e.id)
    const name = language === 'es' ? e.labelEs : e.label
    const note = k && source ? source.note(k, language) : ''
    return (
      <button
        key={e.id}
        data-kind={e.id}
        type="button"
        title={name}
        onClick={() => {
          onSpawn(e.id)
          setStamped((p) => ({ id: e.id, n: (p?.n ?? 0) + 1 }))
        }}
        onMouseDown={(ev) => ev.preventDefault()}
        onPointerEnter={() => setRinged(e.id)}
        onPointerLeave={() => setRinged((r) => (r === e.id ? null : r))}
        className="group relative flex h-full min-w-0 flex-col items-center px-0.5 pt-1 text-center"
      >
        {ringed === e.id && <Ring />}
        {/* the picture, and the stamp across its corner: the stamp is
            anchored to the picture, so it can only ever land on its plate */}
        <span className="relative">
          {pic ? (
            <img
              src={pic}
              alt=""
              draggable={false}
              className="size-[52px] group-active:translate-y-0.5"
              style={{ imageRendering: 'pixelated', transform: ringed === e.id ? 'translateY(-2px)' : undefined }}
            />
          ) : (
            <span className="block size-[52px]" />
          )}
          {stamped?.id === e.id && (
            <span
              key={stamped.n}
              aria-hidden
              onAnimationEnd={() => setStamped(null)}
              className="font-display pointer-events-none absolute right-[-14px] bottom-[2px] rounded-[3px] border-2 px-1 text-[9px] leading-[1.3] font-bold tracking-[0.1em] whitespace-nowrap uppercase"
              style={{ color: RED, borderColor: RED, animation: 'cat-stamp 1100ms ease-out forwards', mixBlendMode: 'multiply' }}
            >
              {s.sent}
            </span>
          )}
        </span>
        <span className="font-mono text-[8.5px] leading-none tabular-nums" style={{ color: RED }}>
          {s.no} {String(n).padStart(2, '0')}
        </span>
        <span className="font-display mt-0.5 w-full truncate text-[11.5px] leading-tight font-semibold">{name}</span>
        <span className="w-full truncate font-mono text-[8.5px] leading-tight" style={{ color: INK_SOFT }}>{note}</span>
      </button>
    )
  }

  const grid = (list: SpawnEntry[], ref?: typeof gridRef) => (
    <div ref={ref} className="mt-2 min-h-0 flex-1">
      <div
        key={`${q ? `?${q}` : current}:${at}`}
        className="grid h-full content-start gap-x-1 overflow-hidden"
        style={{
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          gridAutoRows: PLATE_H,
          rowGap: ROW_GAP,
          animation: 'cat-page 160ms ease-out',
        }}
        // a wheel over the pages leafs through them, one spread a notch
        onWheel={(ev) => {
          const now = performance.now()
          if (now - wheelAt.current < 220 || Math.abs(ev.deltaY) < 4) return
          wheelAt.current = now
          turn(ev.deltaY > 0 ? 1 : -1)
        }}
      >
        {list.map(plate)}
      </div>
    </div>
  )

  const pageBg = (fold: 'l' | 'r') => ({
    backgroundColor: PAGE,
    backgroundImage: fold === 'l'
      ? `linear-gradient(90deg, rgba(0,0,0,0) 80%, rgba(60,40,20,0.1) 92%, rgba(50,32,16,0.3)), url(${pageStock})`
      : `linear-gradient(90deg, rgba(50,32,16,0.3), rgba(60,40,20,0.1) 5%, rgba(0,0,0,0) 14%), url(${pageStock})`,
    // the page stack under this one, thickening towards the fore-edge
    boxShadow: fold === 'l'
      ? `-1px 1px 0 ${EDGE_A}, -2px 2px 0 ${EDGE_B}, -3px 3px 0 ${EDGE_A}, -4px 4px 0 ${EDGE_B}, -5px 5px 0 ${EDGE_A}`
      : `1px 1px 0 ${EDGE_A}, 2px 2px 0 ${EDGE_B}, 3px 3px 0 ${EDGE_A}, 4px 4px 0 ${EDGE_B}, 5px 5px 0 ${EDGE_A}`,
  })

  const tabs = [{ id: ALL, label: s.everything, labelEs: s.everything }, ...cats]
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/15"
      style={{ perspective: 1500 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <style>{`
        @keyframes cat-up { from { transform: translateY(60px) rotateX(24deg) rotate(1.4deg); opacity: 0 } to { transform: rotateX(8deg) rotate(-1.2deg); opacity: 1 } }
        @keyframes cat-page { from { transform: translateX(10px); opacity: 0 } to { transform: none; opacity: 1 } }
        @keyframes cat-stamp { 0% { transform: scale(1.8) rotate(-12deg); opacity: 0 } 16% { transform: scale(1) rotate(-12deg); opacity: 0.9 } 80% { opacity: 0.9 } 100% { transform: scale(1) rotate(-12deg); opacity: 0 } }
      `}</style>
      <div
        className="pointer-events-auto relative mt-2 flex select-none"
        style={{
          width: 'min(1080px, 94vw)',
          height: 'min(600px, 78vh)',
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

        {/* the index tabs, cut into the top edge: one per section, the open
            one standing tallest and in the page's own colour. Drawn after the
            cover so their feet overlap its edge rather than vanish under it */}
        <nav aria-label={s.contents} className="absolute -top-[35px] right-3 left-3 flex items-end gap-[3px]">
          {tabs.map((c, i) => {
            const on = !q && current === c.id
            return (
              <button
                key={c.id}
                type="button"
                data-category={c.id}
                // a click must not take focus off the find line, whose
                // blur is what lets the catalogue close
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => pick(c.id)}
                className="font-display min-w-0 flex-1 truncate self-end rounded-t-[7px] px-1.5 pt-[5px] text-left text-[12px] leading-none font-semibold"
                style={{
                  // the tab's foot tucks behind the cover's edge (7px), so the
                  // label sits in what stands above it
                  height: on ? 42 : 35,
                  alignSelf: 'flex-end',
                  background: on ? PAGE : TAB_TINTS[i % TAB_TINTS.length],
                  color: on ? RED : INK,
                  boxShadow: on ? 'none' : 'inset 0 -3px 4px -2px rgba(60,40,20,0.35)',
                }}
              >
                {c.id === ALL ? c.label : catName(c as SpawnCategory)}
              </button>
            )
          })}
        </nav>

        {/* ---- the left page: masthead, find line, plates ---- */}
        <section className="relative flex w-1/2 flex-col rounded-l-[5px] px-6 pt-4 pb-3" style={pageBg('l')}>
          <div className="flex items-end gap-4">
            <h2 className="font-display text-[30px] leading-[0.9] font-semibold tracking-tight" style={{ color: RED }}>
              {s.title}
            </h2>
            {/* the find line: pencilled on the page. Focusing it pins the
                catalogue open, so q can be let go of and the name typed */}
            <label className="mb-0.5 flex min-w-0 flex-1 items-baseline gap-2 font-mono text-[11px]">
              <span className="font-display text-[11px] font-semibold tracking-[0.16em] uppercase">{s.find}</span>
              <input
                ref={findRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setLeaf(0)
                }}
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
          </div>
          <div aria-hidden className="mt-2 border-t-[3px] border-b" style={{ borderColor: INK, height: 5 }} />
          {!source ? (
            <p className="mt-10 max-w-[28ch] font-mono text-[13px] leading-relaxed" style={{ color: INK_SOFT }}>
              {s.loading}
            </p>
          ) : shown.length === 0 ? (
            <p className="mt-6 flex-1 font-mono text-[13px] italic" style={{ color: INK_SOFT }}>{s.noMatch}</p>
          ) : (
            grid(leftPlates, gridRef)
          )}
          <div className="mt-1 flex items-baseline justify-end gap-3 pl-[200px] font-mono text-[9.5px]" style={{ color: INK_SOFT }}>
            <span className="truncate">{s.lead}</span>
            {at > 0 && (
              <button
                type="button"
                data-turn="back"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => turn(-1)}
                className="shrink-0 underline decoration-dotted underline-offset-2"
                style={{ color: RED }}
              >
                {s.back}
              </button>
            )}
            <span className="shrink-0">{firstPage}</span>
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

        {/* ---- the right page: the section's name and the rest of the plates ---- */}
        <section className="relative flex w-1/2 flex-col rounded-r-[5px] px-6 pt-4 pb-3" style={pageBg('r')}>
          {/* the curl: the corner turned up towards you, its pale underside
              over the next sheet down, which is a shade darker. With more
              spreads to come it is the way to them: lift it and the page turns */}
          <button
            type="button"
            data-turn="next"
            aria-label={s.next}
            disabled={at >= spreads - 1}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => turn(1)}
            className="absolute right-0 bottom-0 z-10 size-[34px] enabled:cursor-pointer"
            style={{
              background:
                'linear-gradient(135deg, rgba(0,0,0,0) 49%, rgba(40,25,10,0.28) 50%, rgba(0,0,0,0) 56%), ' +
                'linear-gradient(315deg, #ddd2bb 0 49%, rgba(0,0,0,0) 50%), ' +
                'linear-gradient(135deg, #d6c9ae, #ece3cf 26%, #f7f1e4 49%, rgba(0,0,0,0) 50%)',
              transform: at < spreads - 1 ? 'scale(1.35)' : undefined,
              transformOrigin: '100% 100%',
            }}
          />
          <div className="flex items-baseline gap-3">
            <h3 className="font-display truncate text-[24px] leading-none font-semibold">{title}</h3>
            <span className="shrink-0 font-mono text-[10.5px]" style={{ color: INK_SOFT }}>
              {spreads > 1
                ? `${at * perSpread + 1}-${at * perSpread + onSpread.length} / ${shown.length}`
                : shown.length}
            </span>
          </div>
          <div aria-hidden className="mt-2 border-t" style={{ borderColor: INK, height: 5 }} />
          {source ? grid(rightPlates) : <div className="flex-1" />}
          <div className="mt-1 flex items-baseline gap-3 pr-10 font-mono text-[9.5px]" style={{ color: INK_SOFT }}>
            <span>{finding ? s.closeFinding : keyHint(s.close, language)}</span>
            <span className="ml-auto">
              {at < spreads - 1 && <span className="mr-2 italic">{s.turn}</span>}
              {firstPage + 1}
            </span>
          </div>
        </section>

        {/* the order slip: a carbon copy of what you have had delivered,
            paper-clipped to the bottom edge of the book */}
        <div
          className="absolute -bottom-[62px] -left-12 z-20 w-[236px] px-3 pt-2 pb-2"
          style={{
            backgroundColor: SLIP,
            backgroundImage: `url(${slipStock})`,
            transform: 'rotate(-2.2deg)',
            boxShadow: '0 3px 6px rgba(40,20,10,0.35)',
            borderTop: `2px dashed ${INK}33`,
          }}
        >
          <span
            aria-hidden
            className="absolute -top-[14px] left-5 h-[26px] w-[10px] rounded-full border-2"
            style={{ borderColor: '#9da0a4', boxShadow: '0 1px 1px rgba(0,0,0,0.3)' }}
          />
          <p className="font-display text-[11px] font-semibold tracking-[0.16em] uppercase" style={{ color: RED }}>
            {s.orders}
          </p>
          {orders.length === 0 ? (
            <p className="font-mono text-[10.5px] italic" style={{ color: INK_SOFT }}>{s.ordersEmpty}</p>
          ) : (
            <ol className="space-y-px font-mono text-[10.5px]">
              {orders.slice(0, 3).map((o, i) => (
                <li key={o.seq} className="flex gap-2" style={{ opacity: 1 - i * 0.2 }}>
                  <span className="tabular-nums" style={{ color: INK_SOFT }}>{String(o.seq).padStart(3, '0')}</span>
                  <span className="truncate">{labelIn(o.label, language)}</span>
                </li>
              ))}
            </ol>
          )}
          <button type="button" onClick={onCleanup}
            className="mt-2 cursor-pointer border-b border-dashed bg-transparent px-1 font-mono text-[11px] italic hover:opacity-70 focus-visible:outline-dotted"
            style={{ color: RED, borderColor: RED, transform: 'rotate(-2deg)' }}>
            {s.cleanup}
          </button>
          <p className="mt-0.5 font-mono text-[9.5px]" style={{ color: INK_SOFT }}>{keyHint(s.undoHint, language)}</p>
        </div>
      </div>
    </div>
  )
}
