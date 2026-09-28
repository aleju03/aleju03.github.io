import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import WorldIdentity, { type WorldIdentityProps } from './WorldIdentity'
import { CIRCLED, INK, INK_SOFT, MARK, PAPER, paperTexture } from './paper'
import { Note, Rule } from './PaperMarks'
import { keyHint } from '../../game/sandbox/bindings'
import { useI18n } from '../../i18n'
import {
  DETAILS, FPS_CAPS, PIXEL_SIZES, SCALE_MAX, SCALE_MIN, VOL_MAX, VOL_MIN,
  detailTier, type PixelSize, type RoamPrefs,
} from './roamPrefs'
import { PROOF_H, PROOF_W, type PixelProofs } from './pixelProofs'
import { VOICE_FILTERS, type VoiceFilter } from './voiceFilters'
import type { GfxTier } from '../../game/world/quality'

/*
  The pause screen is a sheet of paper pinned to the bedroom wall.

  Not a HUD, not a panel, not a dialog. Four earlier versions were all of
  those in turn and every one of them had the same problem: an orange accent,
  caps and a highlight bar is chrome that could be bolted onto any game. It
  had no author. The games this is aiming at do not do that. Their menus are
  made of objects from their own world, hand-made and slightly wrong, and this
  project already owns that language: the paper plane, the tearable band, the
  corkboard on the wall of the room you are standing in.

  So the world dims, and a piece of paper is taped and pinned over it, hanging
  about a degree off square. Everything is written on that one sheet, because
  a sheet of paper has no compartments to nest anything in.

  How it is built:

  - **The stock is drawn, not shipped** (`paper.ts`): a wrapping canvas tile
    of correlated grain and flecks, tiled behind the sheet, with the curl and
    the edge shading done in CSS gradients over the top.
  - **Ink is fixed, not themed.** The palette in `paper.ts` is literal hex,
    because the site's stone scale flips with light/dark mode and a piece of
    paper in a dark room does not.
  - **The lines are hand-drawn.** The rules under the headings and the swipe
    behind the selected row are authored SVG paths and lopsided radii, so
    nothing on the sheet is machine-straight except the type.
  - **You are a Polaroid** clipped to it. See `WorldIdentity.tsx`.
  - **The pixel size is three prints of your own view**, drawn by the game
    at each size the moment the settings page opens (`pixelProofs.ts`), and
    every graphics knob carries a pencilled line saying what it changes and
    what it costs. The three graphics knobs stay three different kinds of
    thing (see `roamPrefs.ts`): the pixels and the resolution are live, the
    detail lands on the next load and the sheet says so.

  It is mounted from the first pause of the session onward and merely hidden
  in between, never unmounted: the character preview owns a second WebGL
  context, and creating one per press of escape would re-link its shaders
  every time. `active` narrows that further: the turntable only draws while
  its own page is the one showing.
*/

/** the compass rose the people page's bearings use: the same eight points
    `vehicles/registry.ts` rounds a bearing to, in the same clockwise order */
const COMPASS_DEG: Record<string, number> = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
}

/** the pixel sizes as the sheet deals them out, biggest pixel first, so the
    row reads from coarse to fine; the words for them are in the dictionary
    in the same order */
const PIXEL_ORDER: readonly PixelSize[] = [...PIXEL_SIZES].reverse()

/** somebody else out in the world, as this screen lists them: who they are,
    what colour they painted their shell, and where they were standing when
    the menu went up. No bearing means they are in another level: the
    backrooms or the Moon */
export interface PersonWhere {
  id: number
  name: string
  admin: boolean
  shell: string
  dist?: number
  bearing?: string
}

type Page = 'character' | 'settings' | 'people'

/**
  A row of the menu. The selected one is swiped through with the marker: a
  rough band that overshoots the word at both ends, sits a little crooked, and
  lets the paper show through it.
*/
function Row({
  label,
  selected,
  trailing,
  onClick,
}: {
  label: string
  selected?: boolean
  trailing?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className="group font-display relative flex w-full items-center gap-3 py-1 text-left text-[26px] whitespace-nowrap uppercase transition-transform duration-150 hover:translate-x-1"
      style={{ color: selected ? INK : INK_SOFT }}
    >
      <span
        aria-hidden
        className={`absolute -inset-x-3 inset-y-[3px] -z-10 transition-opacity ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-30'
        }`}
        style={{
          background: `${MARK}66`,
          borderRadius: '10px 14px 9px 16px',
          transform: 'rotate(-0.5deg)',
        }}
      />
      <span
        aria-hidden
        className={`-mr-1 text-[18px] transition-opacity ${selected ? 'opacity-100' : 'opacity-0'}`}
        style={{ color: MARK }}
      >
        ▸
      </span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  )
}

/**
  The other kind of setting: a short list of words with the one in force
  circled in pencil, and a pencil note on the right for whatever the words
  cannot say themselves.

  Anything with two or three states is written out rather than dialled,
  because a slider that can only stop in three places is a slider pretending
  to be a choice, and because the words are the label — "third person" needs
  no caption and "70%" would.
*/
/** what a knob changes and what it costs, in plain words, pencilled under
    its name. Every graphics knob has one, because "render scale" and
    "detail" are words only somebody who wrote a renderer can read */
function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="mt-0.5 font-mono text-[11px] leading-snug" style={{ color: INK_SOFT }}>
      {children}
    </p>
  )
}

function Choice<T extends string>({
  label,
  note,
  hint,
  options,
  value,
  onPick,
}: {
  label: string
  note?: ReactNode
  hint?: string
  options: ReadonlyArray<{ id: T; label: string }>
  value: T
  onPick: (v: T) => void
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-display text-[21px] uppercase" style={{ color: INK }}>
          {label}
        </span>
        {note}
      </div>
      {hint && <Hint>{hint}</Hint>}
      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onPick(o.id)}
            aria-pressed={value === o.id}
            className="font-display relative px-1 py-0.5 text-[20px] uppercase"
            style={{ color: value === o.id ? INK : INK_SOFT }}
          >
            {o.label}
            <span
              aria-hidden
              className={`absolute -inset-x-2.5 -inset-y-1.5 transition-opacity ${
                value === o.id ? 'opacity-100' : 'opacity-0'
              }`}
              style={CIRCLED}
            />
          </button>
        ))}
      </div>
    </div>
  )
}

/**
  A setting, ruled across the sheet: the name on the left, the number written
  on the right, and a pencil line between them with a bead on it.

  The visible parts are plain divs and the real `<input type="range">` rides
  invisibly on top, which keeps dragging, arrow keys, focus and screen readers
  exactly as the browser implements them. `THUMB` is why the geometry is not a
  bare percentage: a native range insets its handle by half its width at both
  ends, so the fill and the bead are laid out in that same inset space or they
  drift apart at the extremes. The invisible thumb is sized in both engines
  too, so a click lands where the bead is drawn.
*/
const THUMB = 18
function Dial({
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
}) {
  const k = (value - min) / (max - min)
  const at = `calc(${k} * (100% - ${THUMB}px) + ${THUMB / 2}px)`
  return (
    <label className="group block">
      <div className="flex items-baseline justify-between gap-6">
        <span className="font-display text-[21px] uppercase" style={{ color: INK }}>
          {label}
        </span>
        <span className="font-display text-[24px] tabular-nums" style={{ color: INK }}>
          {display}
        </span>
      </div>
      {hint && <Hint>{hint}</Hint>}
      <div className="relative mt-1.5 flex h-5 items-center">
        {/* the ticks a ruled line would have been drawn against */}
        {[0, 25, 50, 75, 100].map((p) => (
          <span
            key={p}
            aria-hidden
            className="absolute h-2 w-px"
            style={{ left: `${p}%`, background: `${INK}33` }}
          />
        ))}
        <div
          aria-hidden
          className="absolute inset-x-0 h-[2px] rounded-full"
          style={{ background: `${INK}33` }}
        >
          <div className="h-full rounded-full" style={{ width: at, background: MARK }} />
        </div>
        <span
          aria-hidden
          className="absolute size-[15px] -translate-x-1/2 rounded-full transition-transform group-hover:scale-110"
          style={{ left: at, background: MARK, boxShadow: `0 1px 2px ${INK}66` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          // the OS shell and the roam input both listen at the window; while
          // this has focus the arrow keys belong to it
          onKeyDown={(e) => e.stopPropagation()}
          className="absolute inset-x-0 h-5 w-full cursor-pointer appearance-none bg-transparent opacity-0 [&::-moz-range-thumb]:size-[18px] [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:size-[18px] [&::-webkit-slider-thumb]:appearance-none"
        />
      </div>
    </label>
  )
}

/**
  The pixel size, dealt out as three prints of your own view: the middle of
  the frame behind the sheet, drawn at each size and blown up twice (see
  `pixelProofs.ts`, and CrtScene, which takes them). The word under each is
  its name and the one in force is ringed, like every other choice on the
  sheet; the prints only replace the guessing.

  Until the first set lands (the next drawn frame, normally) each print is
  a dark square with its name on it, so the row is usable before it is
  illustrated.
*/
function PixelPrints({
  label,
  hint,
  note,
  names,
  proofs,
  value,
  onPick,
}: {
  label: string
  hint: string
  note: string
  names: readonly string[]
  proofs: PixelProofs | null
  value: PixelSize
  onPick: (v: PixelSize) => void
}) {
  return (
    <div>
      <div className="flex items-baseline gap-4">
        <span className="font-display text-[21px] uppercase" style={{ color: INK }}>
          {label}
        </span>
        <span className="min-w-0 flex-1 font-mono text-[11px]" style={{ color: INK_SOFT }}>
          {hint}
        </span>
        <Note>{note}</Note>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-7 gap-y-3">
        {PIXEL_ORDER.map((size, i) => {
          const on = value === size
          return (
            <button
              key={size}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(size)}
              className="group relative flex cursor-pointer flex-col items-center gap-1.5"
            >
              <span
                className="block p-1 pb-1.5 transition-transform duration-150 group-hover:-translate-y-0.5"
                style={{
                  rotate: `${[-1.6, 0.9, -0.6][i] ?? 0}deg`,
                  background: 'linear-gradient(160deg, #fbf7ea, #efe7d3)',
                  boxShadow: '0 4px 9px rgba(30,20,10,0.4)',
                }}
              >
                <span
                  className="relative grid place-items-center overflow-hidden"
                  style={{ width: PROOF_W, height: PROOF_H, background: '#221c17' }}
                >
                  <span className="font-mono text-[10px]" style={{ color: '#a8977a' }}>
                    {names[i]}
                  </span>
                  {proofs && (
                    <img
                      alt=""
                      src={proofs[size]}
                      draggable={false}
                      className="absolute inset-0 h-full w-full"
                      // nearest neighbour, or the one thing this row exists
                      // to show is smoothed away by the browser
                      style={{ imageRendering: 'pixelated' }}
                    />
                  )}
                </span>
              </span>
              <span
                className="font-display relative px-1 text-[20px] uppercase"
                style={{ color: on ? INK : INK_SOFT }}
              >
                {names[i]}
              </span>
              <span
                aria-hidden
                className={`pointer-events-none absolute -inset-x-2 -inset-y-1.5 transition-opacity ${
                  on ? 'opacity-100' : 'opacity-0'
                }`}
                style={CIRCLED}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export interface PauseScreenProps {
  /** the menu is actually up. False keeps it mounted, and the character
      preview's WebGL context alive, while hiding it outright */
  open: boolean
  /** the walk is shared right now, which changes what a pause even means */
  multiplayer: boolean
  prefs: RoamPrefs
  onPrefs: (next: (p: RoamPrefs) => RoamPrefs) => void
  /** play your own filtered voice back to you for a few seconds; resolves
      when it has finished */
  onVoicePreview: () => Promise<void>
  /** the view behind the sheet, drawn once at each pixel size and cropped
      (pixelProofs.ts); null when nothing is drawing */
  onPixelProofs: () => Promise<PixelProofs | null>
  /** what the GPU sniff decided, and what the running world was actually
      built at; they differ exactly when `prefs.detail` has overruled the
      sniff. Null only before the renderer has classified, which cannot
      coincide with a pause */
  tier: { auto: GfxTier; built: GfxTier } | null
  /** and everyone else out there, measured at the same moment */
  people: PersonWhere[]
  identity: Omit<WorldIdentityProps, 'active'>
  onLeave?: () => void
  onResume: () => void
}

export default function PauseScreen({
  open,
  multiplayer,
  prefs,
  onPrefs,
  onVoicePreview,
  onPixelProofs,
  tier,
  people,
  identity,
  onLeave,
  onResume,
}: PauseScreenProps) {
  const { t, language } = useI18n()
  const [page, setPage] = useState<Page>('character')
  const [hearing, setHearing] = useState(false)
  const fxWords = VOICE_FILTERS.map((id, i) => ({ id, label: t.sandbox.voiceFx.names[i] }))
  const tp = t.pause
  const pages: Array<{ id: Page; label: string }> = [
    { id: 'character', label: tp.character },
    { id: 'settings', label: tp.settings },
    // only when there is a walk to share. Offline the page would be a page
    // about nobody, and the answer would never change
    ...(multiplayer ? [{ id: 'people' as const, label: tp.people }] : []),
  ]
  const cameras = [
    { id: 'first', label: tp.firstPerson },
    { id: 'third', label: tp.thirdPerson },
  ] as const
  const detailWords = DETAILS.map((id, i) => ({ id, label: tp.detailNames[i] }))
  const tierWord = (g: GfxTier) => tp.detailNames[DETAILS.indexOf(g === 'high' ? 'full' : 'lean')]
  // a dial at the bottom of its travel is off, and "0%" is a number
  // pretending that is a quantity
  const volWord = (v: number) => (v <= 0 ? tp.muted : `${Math.round(v * 100)}%`)

  // The pixel proofs, asked for whenever the settings page comes up and
  // again a moment after the resolution dial settles (it changes what every
  // size looks like, the pixel choice itself does not: each proof is drawn
  // at its own size). Kept between visits, so the prints are there at once
  // and are only ever replaced by newer ones
  const [proofs, setProofs] = useState<PixelProofs | null>(null)
  const proofsShowing = open && page === 'settings'
  const askProofs = useRef(onPixelProofs)
  useEffect(() => {
    askProofs.current = onPixelProofs
  })
  useEffect(() => {
    if (!proofsShowing) return
    let live = true
    const id = setTimeout(() => {
      void askProofs.current().then((next) => {
        if (live && next) setProofs(next)
      })
    }, 180)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [proofsShowing, prefs.scale])
  // drawn on the first pause and kept: see paper.ts
  const stock = useMemo(() => paperTexture(), [])

  /*
    The line beside "detail", which has three things to say and says exactly
    one of them.

    The tier is baked into merged chunk geometry, the two grass lattices and a
    #define in the sky shader, all at construction, so a choice that disagrees
    with the world standing outside is a *pending* choice and the sheet has to
    admit it rather than let somebody stare at the same grass wondering. When
    they do agree, the useful thing to print depends on which word is circled:
    under "auto" the interesting fact is what the sniff came back with, since
    that is invisible everywhere else and is the whole reason for overruling
    it; under an explicit word there is nothing left to disclose, so the line
    has nothing to add to the hint under the name, and says nothing.
  */
  const detailNote = !tier
    ? null
    : detailTier(prefs.detail, tier.auto) !== tier.built
      ? tp.nextLoad
      : prefs.detail === 'auto'
        ? tp.found.replace('{tier}', tierWord(tier.auto))
        : null

  // the arrows walk the menu, because a menu you can only mouse around is a
  // menu that forgot which device it is on. Escape stays CrtScene's (it is
  // what resumes), and anything typed into a field is that field's
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
      const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight'
      if (!back && !fwd) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.isContentEditable)) return
      e.preventDefault()
      const i = pages.findIndex((p) => p.id === page)
      setPage(pages[(i + (fwd ? 1 : pages.length - 1)) % pages.length].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div
      className={`absolute inset-0 z-20 items-center justify-center p-5 ${
        open ? 'flex' : 'hidden'
      }`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at 50% 45%, rgba(14,11,8,0.62), rgba(8,6,4,0.86))',
        }}
      />

      {/* the sheet. Off square, because nothing anybody ever pinned to a wall
          was not, and lit from the top-left like the rest of the room */}
      <div
        className="relative flex max-h-full w-[min(64rem,100%)] flex-col gap-5 px-9 py-8 sm:px-12"
        style={{
          transform: 'rotate(-0.9deg)',
          backgroundColor: PAPER,
          backgroundImage: `radial-gradient(120% 100% at 12% 0%, rgba(255,255,255,0.5), rgba(255,255,255,0) 55%), radial-gradient(90% 80% at 95% 100%, rgba(80,62,38,0.18), rgba(80,62,38,0) 60%), url(${stock})`,
          backgroundSize: 'auto, auto, 256px 256px',
          boxShadow:
            '0 18px 40px rgba(0,0,0,0.55), 0 2px 0 rgba(255,255,255,0.06) inset, 0 -14px 24px -18px rgba(60,44,26,0.7) inset',
        }}
      >
        {/* tape over the top-left corner, and a pin through the top-right */}
        <span
          aria-hidden
          className="pointer-events-none absolute -top-3 -left-7 h-6 w-24 rotate-[-40deg]"
          style={{
            background: 'linear-gradient(90deg, rgba(250,238,206,.5), rgba(244,230,196,.62))',
            boxShadow: '0 1px 3px rgba(60,44,26,0.22)',
          }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute -top-2.5 right-10 size-5 rounded-full"
          style={{
            background: `radial-gradient(circle at 34% 30%, #f0b3a0, ${MARK} 55%, #8c4a37)`,
            boxShadow: '0 3px 5px rgba(40,28,16,0.5)',
          }}
        />

        <header className="flex items-end gap-5">
          <div>
            <h2
              className="font-display text-[clamp(34px,4.4vw,52px)] leading-none uppercase"
              style={{ color: INK }}
            >
              {tp.paused}
            </h2>
            <Rule className="mt-1 w-[86%]" />
          </div>
          {/* an engine stops and a world does not: with other people out
              there, saying "paused" without qualification is a lie */}
          <p className="mb-1.5 hidden sm:block">
            <Note>
              {multiplayer ? tp.shared : tp.still}
            </Note>
          </p>
        </header>

        {/* Scrolls when a short window needs it, but never draws a bar: a bar
            takes its own width out of the columns, the widest option row then
            wraps onto one more line, and the taller page keeps the bar it
            caused. That loop had two stable states on a laptop, and whichever
            one the last relayout (a hover) landed in stuck. Sideways it never
            scrolls: the rows' hover nudge is not content */}
        <div className="flex min-h-0 flex-col gap-8 overflow-x-hidden overflow-y-auto [scrollbar-width:none] sm:flex-row sm:gap-10">
          <nav className="flex w-full shrink-0 flex-col gap-0.5 sm:w-44">
            {pages.map((p) => (
              <Row
                key={p.id}
                label={p.label}
                selected={page === p.id}
                onClick={() => setPage(p.id)}
              />
            ))}
            <Rule className="my-3 w-24" color={`${INK}66`} />
            <Row label={tp.resume} trailing={<Note>esc</Note>} onClick={onResume} />
            {onLeave && <Row label={tp.leave} onClick={onLeave} />}
          </nav>

          {/* the page. The character one is never unmounted, since its preview
              owns a WebGL context, so it is hidden rather than swapped out, and
              told to stop drawing while it is not the page showing. The floor
              under it is the tallest page's height, so the sheet does not
              change size every time somebody picks a different line */}
          <div className="min-h-0 min-w-0 flex-1 sm:min-h-[21rem]">
            <div className={page === 'character' ? 'block' : 'hidden'}>
              <WorldIdentity {...identity} active={open && page === 'character'} />
            </div>

            {/* The pixels across the top, because they are the knob people
                came looking for and the only one that is shown rather than
                described: three prints of the view behind the sheet, one per
                size. Under them two columns, and the split is the point: on
                the left the three knobs that cost something (how many lines
                are drawn, how much world is built, how many frames a second),
                on the right the three that are only about how it feels. Each
                graphics knob says in pencil under its name what it changes
                and what it costs, because "render scale" is a word only
                somebody who wrote a renderer can read. Voice runs across the
                bottom: a third kind of thing (how the world *sounds*), and
                only there at all when there is somebody in it to talk to. */}
            {page === 'settings' && (
              <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
                {/* how big a pixel of the pixel art is: taste, not cost,
                    and live, since it is only the size of a target */}
                <div className="sm:col-span-2">
                  <PixelPrints
                    label={tp.pixels}
                    hint={tp.pixelsHint}
                    note={tp.pixelProof}
                    names={tp.pixelNames}
                    proofs={proofs}
                    value={prefs.pixels}
                    onPick={(pixels) => onPrefs((p) => ({ ...p, pixels }))}
                  />
                </div>

                <div className="flex flex-col gap-5">
                  {/* ...and how much of that resolution to actually draw. The
                      opposite kind of knob from detail: one target size, live
                      on the next frame, and the ceiling the adaptive
                      governor sheds from */}
                  <Dial
                    label={tp.scale}
                    hint={tp.scaleHint}
                    value={prefs.scale}
                    min={SCALE_MIN}
                    max={SCALE_MAX}
                    step={0.05}
                    display={`${Math.round(prefs.scale * 100)}%`}
                    onChange={(v) =>
                      // off the dial these arrive as 0.6000000000000001, which
                      // is a number nobody wants written into localStorage
                      onPrefs((p) => ({ ...p, scale: Math.round(v * 100) / 100 }))
                    }
                  />
                  {/* how much world to build. See detailNote: this one is
                      baked at construction and cannot be honoured until the
                      next load, which the sheet says rather than hides */}
                  <Choice
                    label={tp.detail}
                    hint={tp.detailHint}
                    note={detailNote && <Note>{detailNote}</Note>}
                    options={detailWords}
                    value={prefs.detail}
                    onPick={(detail) => onPrefs((p) => ({ ...p, detail }))}
                  />
                  {/* the dial rides on the index, not the number: the values
                      are a list of detents and the spacing between them is not
                      linear (30 to 45 is the same throw as 200 to 240) */}
                  <Dial
                    label={tp.cap}
                    hint={tp.capHint}
                    value={Math.max(0, FPS_CAPS.indexOf(prefs.cap))}
                    min={0}
                    max={FPS_CAPS.length - 1}
                    step={1}
                    display={prefs.cap === 0 ? tp.noLimit : `${prefs.cap} fps`}
                    onChange={(i) => onPrefs((p) => ({ ...p, cap: FPS_CAPS[i] ?? 0 }))}
                  />
                </div>

                <div className="flex flex-col gap-5">
                  <Choice
                    label={tp.camera}
                    note={<Note>{tp.cameraToggle}</Note>}
                    options={cameras}
                    value={prefs.third ? 'third' : 'first'}
                    onPick={(v) => onPrefs((p) => ({ ...p, third: v === 'third' }))}
                  />
                  <Dial
                    label={tp.fov}
                    hint={tp.fovHint}
                    value={prefs.fov}
                    min={30}
                    max={80}
                    step={1}
                    display={`${prefs.fov}°`}
                    onChange={(fov) => onPrefs((p) => ({ ...p, fov }))}
                  />
                  <Dial
                    label={tp.sens}
                    hint={tp.sensHint}
                    value={prefs.sens}
                    min={0.3}
                    max={3}
                    step={0.05}
                    display={`${prefs.sens.toFixed(2)}×`}
                    onChange={(sens) => onPrefs((p) => ({ ...p, sens }))}
                  />
                </div>

                {/* The soundtrack and the world under it, apart, because
                    the useful answer to "too much music" is rarely "less
                    wind" (game/music) */}
                <div className="grid gap-x-10 gap-y-7 sm:col-span-2 sm:grid-cols-2">
                  <Dial
                    label={tp.music}
                    value={prefs.musicVol}
                    min={VOL_MIN}
                    max={VOL_MAX}
                    step={0.05}
                    display={volWord(prefs.musicVol)}
                    onChange={(v) =>
                      onPrefs((p) => ({ ...p, musicVol: Math.round(v * 100) / 100 }))
                    }
                  />
                  <Dial
                    label={tp.ambience}
                    hint={tp.ambienceHint}
                    value={prefs.ambVol}
                    min={VOL_MIN}
                    max={VOL_MAX}
                    step={0.05}
                    display={volWord(prefs.ambVol)}
                    onChange={(v) =>
                      onPrefs((p) => ({ ...p, ambVol: Math.round(v * 100) / 100 }))
                    }
                  />
                </div>

                {/* One dial per direction, and no per-person mixer: the mesh
                    is proximity-mixed, so whose voice is loud is already
                    answered by where they are standing. 100% is a working
                    level rather than a maximum, and the gain that makes it
                    one lives in `proximityVoice`, under a limiter */}
                {multiplayer && (
                  <div className="grid gap-x-10 gap-y-7 sm:col-span-2 sm:grid-cols-2">
                    <Dial
                      label={tp.mic}
                      value={prefs.micVol}
                      min={VOL_MIN}
                      max={VOL_MAX}
                      step={0.05}
                      display={volWord(prefs.micVol)}
                      onChange={(v) =>
                        onPrefs((p) => ({ ...p, micVol: Math.round(v * 100) / 100 }))
                      }
                    />
                    <Dial
                      label={tp.voices}
                      value={prefs.voiceVol}
                      min={VOL_MIN}
                      max={VOL_MAX}
                      step={0.05}
                      display={volWord(prefs.voiceVol)}
                      onChange={(v) =>
                        onPrefs((p) => ({ ...p, voiceVol: Math.round(v * 100) / 100 }))
                      }
                    />
                    {/* what everybody else hears you through. The filter is
                        applied on this machine before the voice leaves it
                        (`voiceFilters.ts`), so the only honest way to show it
                        is to play it back: the pencil note on the right is a
                        button that does, privately, for a few seconds */}
                    <div className="sm:col-span-2">
                      <Choice<VoiceFilter>
                        label={t.sandbox.voiceFx.label}
                        note={
                          <button
                            type="button"
                            disabled={hearing}
                            onClick={() => {
                              setHearing(true)
                              void onVoicePreview().finally(() => setHearing(false))
                            }}
                            className="underline decoration-dotted underline-offset-2 disabled:no-underline"
                          >
                            <Note>
                              {hearing ? t.sandbox.voiceFx.listening : `▸ ${t.sandbox.voiceFx.preview}`}
                            </Note>
                          </button>
                        }
                        options={fxWords}
                        value={prefs.voiceFx}
                        onPick={(voiceFx) => onPrefs((p) => ({ ...p, voiceFx }))}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* who else is out there. The roster is the server's, so this is
                the same list the chat rail and the plates over their heads
                are drawn from, and a name here is a name you can shout at.
                Somebody with no bearing is in another level: they found the
                backrooms, or flew to the Moon */}
            {page === 'people' && (
              <div className="max-w-lg">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-display text-[21px] uppercase" style={{ color: INK }}>
                    {tp.outHere}
                  </span>
                  <Note>{tp.sayHint}</Note>
                </div>
                {people.length === 0 ? (
                  <p className="mt-4 font-display text-[22px] uppercase" style={{ color: `${INK}55` }}>
                    {tp.nobody}
                  </p>
                ) : (
                  <ul className="mt-3 flex flex-col">
                    {people.map((p) => (
                      <li key={p.id} className="flex items-center gap-4 py-2.5">
                        {/* their own shell colour, in the same paint the
                            character page picks from */}
                        <span
                          aria-hidden
                          className="size-6 shrink-0"
                          style={{
                            backgroundColor: p.shell,
                            borderRadius: '50% 47% 53% 49% / 48% 52% 47% 53%',
                            boxShadow: `inset 0 -2px 3px rgba(0,0,0,0.16), 0 1px 2px ${INK}44`,
                          }}
                        />
                        <span
                          className="font-display min-w-0 flex-1 truncate text-[24px] uppercase"
                          style={{ color: p.admin ? MARK : INK }}
                        >
                          {p.name}
                        </span>
                        {p.dist === undefined || p.bearing === undefined ? (
                          <Note>{tp.elsewhere}</Note>
                        ) : (
                          <>
                            <Note>
                              {p.dist < 1000
                                ? `${Math.round(p.dist * 0.48)} m`
                                : `${(p.dist * 0.00048).toFixed(1)} km`}{' '}
                              {p.bearing}
                            </Note>
                            <span
                              aria-hidden
                              className="grid size-8 shrink-0 place-items-center"
                              style={{ transform: `rotate(${COMPASS_DEG[p.bearing] ?? 0}deg)` }}
                            >
                              <svg viewBox="0 0 12 12" className="size-5">
                                <path d="M6 1.2 8.8 9 6 7.2 3.2 9Z" fill={MARK} />
                              </svg>
                            </span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        {/* the footnote at the bottom of the page, in the walk HUD's own voice */}
        <p className="mt-auto">
          <Note>
            {keyHint(`${t.sandbox.hud.pauseNote}${multiplayer ? ` · ${t.sandbox.hud.voice}` : ''} · ${tp.menuKeys}`, language)}
          </Note>
        </p>
      </div>
    </div>
  )
}
