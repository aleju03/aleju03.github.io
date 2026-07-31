import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { VehicleId } from '../../game/vehicles/types'
import WorldIdentity, { type WorldIdentityProps } from './WorldIdentity'
import { CIRCLED, INK, INK_SOFT, MARK, PAPER, paperTexture } from './paper'
import { Note, Rule } from './PaperMarks'
import { FPS_CAPS, fpsCapLabel, type RoamPrefs } from './roamPrefs'

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

  It is mounted from the first pause of the session onward and merely hidden
  in between, never unmounted: the character preview owns a second WebGL
  context, and creating one per press of escape would re-link its shaders
  every time. `active` narrows that further: the turntable only draws while
  its own page is the one showing.
*/

/** the fleet's compass rose, the same eight points `vehicles/registry.ts`
    rounds a bearing to, in the same clockwise order */
const COMPASS_DEG: Record<string, number> = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
}

/** somebody else out in the world, as this screen lists them: who they are,
    what colour they painted their shell, and where they were standing when
    the menu went up. No bearing means they are in another level, which for
    now is the backrooms */
export interface PersonWhere {
  id: number
  name: string
  admin: boolean
  shell: string
  dist?: number
  bearing?: string
}

type Page = 'character' | 'settings' | 'fleet' | 'people'

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
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string
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

/** the fleet's badges, drawn in the same pen as the rules */
function VehicleGlyph({ id }: { id: VehicleId }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-7 shrink-0"
      aria-hidden
      fill="none"
      stroke={INK}
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {id === 'car' && (
        <>
          <path d="M2 9.5h12M3 9.5 4.6 6h6.8L13 9.5v2.2H3z" />
          <circle cx="5.2" cy="11.7" r="1.2" />
          <circle cx="10.8" cy="11.7" r="1.2" />
        </>
      )}
      {id === 'boat' && (
        <>
          <path d="M2.5 10.5h11l-1.6 2.6H4.1z" />
          <path d="M8 10.5V3l4 4.5H8" />
        </>
      )}
      {id === 'heli' && (
        <>
          <path d="M2 4h12M8 4v1.8" />
          <path d="M4.6 5.8h5.2c1.6 0 2.6 1 2.6 2.3s-1 2.2-2.6 2.2H4.6c-1 0-1.6-.7-1.6-2.2s.6-2.3 1.6-2.3Z" />
          <path d="M12.4 8h2.2M5 12.3h4.5" />
        </>
      )}
    </svg>
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
  /** where the machines are, measured when the menu went up */
  fleet: Array<{ id: VehicleId; label: string; dist: number; bearing: string }>
  /** and everyone else out there, measured at the same moment */
  people: PersonWhere[]
  /** already at some wheel: recalling a machine from inside another one is a
      trick nobody asked for and the sim would have to answer for */
  driving: boolean
  onRecall: (id: VehicleId, label: string) => void
  identity: Omit<WorldIdentityProps, 'active'>
  onLeave?: () => void
  onResume: () => void
}

export default function PauseScreen({
  open,
  multiplayer,
  prefs,
  onPrefs,
  fleet,
  people,
  driving,
  onRecall,
  identity,
  onLeave,
  onResume,
}: PauseScreenProps) {
  const [page, setPage] = useState<Page>('character')
  const pages: Array<{ id: Page; label: string }> = [
    { id: 'character', label: 'character' },
    { id: 'settings', label: 'settings' },
    ...(fleet.length > 0 ? [{ id: 'fleet' as const, label: 'the fleet' }] : []),
    // only when there is a walk to share. Offline the page would be a page
    // about nobody, and the answer would never change
    ...(multiplayer ? [{ id: 'people' as const, label: 'who is here' }] : []),
  ]
  // drawn on the first pause and kept: see paper.ts
  const stock = useMemo(() => paperTexture(), [])

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
              paused
            </h2>
            <Rule className="mt-1 w-[86%]" />
          </div>
          {/* an engine stops and a world does not: with other people out
              there, saying "paused" without qualification is a lie */}
          <p className="mb-1.5 hidden sm:block">
            <Note>
              {multiplayer ? 'the world keeps going without you' : 'the world is holding still'}
            </Note>
          </p>
        </header>

        <div className="flex min-h-0 flex-col gap-8 overflow-y-auto sm:flex-row sm:gap-10">
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
            <Row label="resume" trailing={<Note>esc</Note>} onClick={onResume} />
            {onLeave && <Row label="leave" onClick={onLeave} />}
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

            {page === 'settings' && (
              <div className="flex max-w-lg flex-col gap-7">
                <div>
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="font-display text-[21px] uppercase" style={{ color: INK }}>
                      camera
                    </span>
                    <Note>v toggles</Note>
                  </div>
                  {/* two words; the one you are in is circled */}
                  <div className="mt-2 flex gap-7">
                    {([false, true] as const).map((third) => (
                      <button
                        key={String(third)}
                        type="button"
                        onClick={() => onPrefs((p) => ({ ...p, third }))}
                        aria-pressed={prefs.third === third}
                        className="font-display relative px-1 py-0.5 text-[22px] uppercase"
                        style={{ color: prefs.third === third ? INK : INK_SOFT }}
                      >
                        {third ? 'third person' : 'first person'}
                        <span
                          aria-hidden
                          className={`absolute -inset-x-2.5 -inset-y-1.5 transition-opacity ${
                            prefs.third === third ? 'opacity-100' : 'opacity-0'
                          }`}
                          style={CIRCLED}
                        />
                      </button>
                    ))}
                  </div>
                </div>

                <Dial
                  label="field of view"
                  value={prefs.fov}
                  min={30}
                  max={80}
                  step={1}
                  display={`${prefs.fov}°`}
                  onChange={(fov) => onPrefs((p) => ({ ...p, fov }))}
                />
                <Dial
                  label="mouse sensitivity"
                  value={prefs.sens}
                  min={0.3}
                  max={3}
                  step={0.05}
                  display={`${prefs.sens.toFixed(2)}×`}
                  onChange={(sens) => onPrefs((p) => ({ ...p, sens }))}
                />
                {/* the dial rides on the index, not the number: the values are
                    a list of detents and the spacing between them is not
                    linear (30 to 45 is the same throw as 200 to 240) */}
                <Dial
                  label="frame limit"
                  value={Math.max(0, FPS_CAPS.indexOf(prefs.cap))}
                  min={0}
                  max={FPS_CAPS.length - 1}
                  step={1}
                  display={fpsCapLabel(prefs.cap)}
                  onChange={(i) => onPrefs((p) => ({ ...p, cap: FPS_CAPS[i] ?? 0 }))}
                />
              </div>
            )}

            {/* where the machines are. A fixed fleet in an endless world needs
                this: the boat lives on a coast two and a half kilometres out,
                and without a bearing that is not a destination, it is a rumour.
                "call it over" is the way back from having stranded one: it
                puts the machine on the nearest place it can legally stand,
                which is why the boat refuses unless there is water in reach */}
            {page === 'fleet' && (
              <div className="max-w-lg">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-display text-[21px] uppercase" style={{ color: INK }}>
                    where they are
                  </span>
                  <Note>e to get in</Note>
                </div>
                <ul className="mt-3 flex flex-col">
                  {fleet.map((v) => (
                    <li key={v.id} className="flex items-center gap-4 py-3">
                      <VehicleGlyph id={v.id} />
                      <span className="min-w-0 flex-1">
                        <span
                          className="font-display block truncate text-[24px] uppercase"
                          style={{ color: INK }}
                        >
                          {v.label}
                        </span>
                        <Note>
                          {/* the sim's units are not metres; the same 0.48
                              scale the rest of the HUD reads distances in */}
                          {v.dist < 1000
                            ? `${Math.round(v.dist * 0.48)} m`
                            : `${(v.dist * 0.00048).toFixed(1)} km`}{' '}
                          {v.bearing}
                        </Note>
                      </span>
                      {/* a needle already turned: a bearing you have to
                          translate is a bearing you do not follow */}
                      <span
                        aria-hidden
                        className="grid size-8 shrink-0 place-items-center"
                        style={{ transform: `rotate(${COMPASS_DEG[v.bearing] ?? 0}deg)` }}
                      >
                        <svg viewBox="0 0 12 12" className="size-5">
                          <path d="M6 1.2 8.8 9 6 7.2 3.2 9Z" fill={MARK} />
                        </svg>
                      </span>
                      {v.dist > 80 && !driving && (
                        <button
                          type="button"
                          onClick={() => onRecall(v.id, v.label)}
                          className="font-display shrink-0 text-[17px] uppercase underline decoration-dotted underline-offset-4"
                          style={{ color: INK_SOFT }}
                        >
                          call it over
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* who else is out there. The roster is the server's, so this is
                the same list the chat rail and the plates over their heads
                are drawn from, and a name here is a name you can shout at.
                Somebody with no bearing is in another level, which for now
                means they found the backrooms */}
            {page === 'people' && (
              <div className="max-w-lg">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-display text-[21px] uppercase" style={{ color: INK }}>
                    out here with you
                  </span>
                  <Note>t to say something</Note>
                </div>
                {people.length === 0 ? (
                  <p className="mt-4 font-display text-[22px] uppercase" style={{ color: `${INK}55` }}>
                    nobody else, just now
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
                          <Note>somewhere else</Note>
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
            wasd move · space jump · shift run · ctrl crouch · x flop
            {multiplayer && ' · t chat · m mic'} · ↑↓ menu
          </Note>
        </p>
      </div>
    </div>
  )
}
