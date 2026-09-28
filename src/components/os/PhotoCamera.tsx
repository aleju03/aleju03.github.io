import { useEffect, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../../i18n'
import { INK, INK_SOFT, MARK } from './paper'
import { photoStore, type PhotoNote } from './photoStore'

/*
  The camera's face: the viewfinder while it is in your hands, the flash when
  it goes off, the print that comes out of it and the strip of the last few.

  Everything is drawn as paper things laid over the walk, the way the
  console (a till receipt), the catalogue (a paper book) and the tool tags
  are: the viewfinder is four pencilled corner marks and a focus bracket
  drawn in ink over a cream halo (so they read on grass, asphalt and night
  alike), the print is a white-bordered instant photograph with a thick foot
  that pins itself to the corner of the screen at a slight tilt, and the
  buttons on the pause sheet's strip are luggage-tag labels.

  The print *develops*: it appears as a blown-out sepia wash and eases to the
  real picture over four seconds, on the compositor (only filter and opacity
  animate). It is what tells you the shutter fired and that the picture is
  safe; it lingers for a few seconds after the last shot and goes. While the
  game is paused the whole strip is up, with a save and a copy under each
  print, because the pointer is unlocked there and the buttons work; on foot
  the same two are keys (bindings.ts's photoSave and photoCopy, handled by
  CrtScene, which calls the same store).

  The picture itself is not taken here. The scene copies its canvas straight
  after the frame that follows the click (photoStore.ts explains why that has
  to be the same task), and this only shows what the store holds.
*/

/** how long the newest print stays up after the last shutter, ms */
const LINGER_MS = 6500
const DEVELOP_MS = 4000
const NOTE_MS = 2600

const NOTE_KEY: Record<PhotoNote, 'saved' | 'copied' | 'copyFailed' | 'nothing'> = {
  saved: 'saved', copied: 'copied', copyFailed: 'copyFailed', nothing: 'nothing',
}

/** the corner marks, ink over a cream halo */
function Brackets({ zoomed }: { zoomed: boolean }) {
  const line = (d: string, key: string) => (
    <g key={key}>
      <path d={d} stroke="rgba(246,236,208,0.9)" strokeWidth={7} fill="none" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <path d={d} stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </g>
  )
  // the frame is a 100 x 56 box (16:9) stretched over the screen
  const m = 6
  const a = 9
  return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" style={{ filter: 'url(#pc-rough)' }}>
      {[
        `M${m} ${m + a}V${m}H${m + a}`,
        `M${100 - m - a} ${m}H${100 - m}V${m + a}`,
        `M${m} ${56 - m - a}V${56 - m}H${m + a}`,
        `M${100 - m - a} ${56 - m}H${100 - m}V${56 - m - a}`,
      ].map((d, i) => line(d, `c${i}`))}
      {/* the focus bracket: closes in a little when zoomed */}
      {[
        'M46 25V23H48', 'M52 23H54V25', 'M46 31V33H48', 'M52 33H54V31',
      ].map((d, i) => line(d, `f${i}`))}
      <g opacity={zoomed ? 0.7 : 0.3}>
        <path d="M33.3 6V50M66.6 6V50M6 18.7H94M6 37.3H94" stroke={INK} strokeWidth={1} fill="none" strokeDasharray="4 8" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  )
}

const KEYFRAMES = `
@keyframes pc-flash { 0% { opacity: 0.9 } 100% { opacity: 0 } }
@keyframes pc-drop { 0% { transform: translateY(70px) rotate(-9deg); opacity: 0 } 100% { transform: translateY(0) rotate(-3.5deg); opacity: 1 } }
@keyframes pc-develop { 0% { filter: brightness(2.6) contrast(0.25) sepia(1) blur(4px); opacity: 0.55 } 55% { filter: brightness(1.5) contrast(0.7) sepia(0.7) blur(1.5px); opacity: 0.85 } 100% { filter: none; opacity: 1 } }
`

export default function PhotoCamera({ paused }: { paused: boolean }) {
  const { t } = useI18n()
  const words = t.sandbox.photo
  const s = useSyncExternalStore(photoStore.subscribe, photoStore.get)
  // the print and the note stay up for a while: the change whose display has
  // run out is set only from the timer, the way ToolSwitcher does it
  const [spentShutter, setSpentShutter] = useState(0)
  useEffect(() => {
    if (!s.shutters) return
    const n = s.shutters
    const id = window.setTimeout(() => setSpentShutter(n), LINGER_MS)
    return () => window.clearTimeout(id)
  }, [s.shutters])
  const [spentNote, setSpentNote] = useState(0)
  useEffect(() => {
    if (!s.note) return
    const n = s.note.n
    const id = window.setTimeout(() => setSpentNote(n), NOTE_MS)
    return () => window.clearTimeout(id)
  }, [s.note])
  const linger = s.shutters > 0 && spentShutter !== s.shutters

  const newest = s.photos[0]
  const showPrint = !!newest && linger
  const note = s.note && spentNote !== s.note.n ? words[NOTE_KEY[s.note.what]] : null

  return (
    <>
      <style>{KEYFRAMES}</style>
      <svg width="0" height="0" className="absolute">
        <defs>
          <filter id="pc-rough" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves={2} seed={11} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="1.1" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      {/* the viewfinder, only with the camera in hand and the game running */}
      {s.held && !paused && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[9] select-none">
          <Brackets zoomed={s.zoom > 1.05} />
          <div
            className="absolute top-[7%] left-[7.5%] px-2 py-[2px] font-mono text-[11px]"
            style={{
              color: INK,
              background: 'rgba(246,236,208,0.9)',
              boxShadow: '0 1px 3px rgba(40,30,18,0.35)',
              transform: 'rotate(-1deg)',
            }}
          >
            {words.zoom} ×{s.zoom.toFixed(1)}
          </div>
        </div>
      )}

      {/* the flash: a white wash that dies in a third of a second */}
      {s.shutters > 0 && s.held && (
        <div
          key={s.shutters}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[19] bg-white"
          style={{ animation: 'pc-flash 320ms ease-out forwards', opacity: 0 }}
        />
      )}

      {/* the print, pinned bottom left while it is fresh */}
      {showPrint && !paused && (
        <div
          key={newest.id}
          aria-hidden
          className="pointer-events-none absolute bottom-16 left-5 z-[12] select-none"
          style={{ animation: 'pc-drop 380ms cubic-bezier(.2,.9,.3,1) forwards', transform: 'rotate(-3.5deg)' }}
        >
          <Print url={newest.url} label={words.developing} develop />
          {note && <Note text={note} />}
        </div>
      )}
      {!showPrint && !paused && note && (
        <div aria-hidden className="pointer-events-none absolute bottom-16 left-5 z-[12] select-none">
          <Note text={note} />
        </div>
      )}

      {/* paused: the whole strip, with its buttons */}
      {paused && s.photos.length > 0 && (
        <div className="absolute bottom-6 left-6 z-[30] flex max-w-[calc(100vw-48px)] flex-wrap items-end gap-4">
          <span className="w-full font-mono text-[11px] tracking-wide" style={{ color: 'rgba(246,236,208,0.85)' }}>
            {words.gallery}
          </span>
          {s.photos.map((p, i) => (
            <div key={p.id} style={{ transform: `rotate(${(i % 2 ? 1 : -1) * (1.5 + (i % 3))}deg)` }}>
              <Print url={p.url} label={words.developing} width={132} />
              <div className="mt-1 flex justify-center gap-1.5">
                {[
                  [words.download, () => photoStore.save(p.id)],
                  [words.copy, () => void photoStore.copy(p.id)],
                ].map(([label, act]) => (
                  <button
                    key={label as string}
                    type="button"
                    onClick={act as () => void}
                    className="cursor-pointer px-2 py-[2px] font-mono text-[10px]"
                    style={{ color: INK, background: '#e9dab2', boxShadow: '0 1px 3px rgba(40,30,18,0.4)', border: `1px solid ${INK_SOFT}` }}
                  >
                    {label as string}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {note && <Note text={note} />}
        </div>
      )}
    </>
  )
}

function Note({ text }: { text: string }) {
  return (
    <div
      className="mt-1.5 inline-block px-2 py-[2px] font-mono text-[11px]"
      style={{ color: '#fff7e6', background: MARK, boxShadow: '0 1px 3px rgba(40,30,18,0.4)', transform: 'rotate(1deg)' }}
    >
      {text}
    </div>
  )
}

/** an instant print: white border, thick foot, the picture developing */
function Print({ url, label, width = 200, develop = false }: { url: string; label: string; width?: number; develop?: boolean }) {
  const h = Math.round((width * 9) / 16)
  return (
    <div
      className="relative"
      style={{
        width: width + 20,
        padding: '10px 10px 30px',
        background: '#f6f1e4',
        boxShadow: '0 4px 10px rgba(25,18,10,0.5), inset 0 0 0 1px rgba(90,70,40,0.15)',
      }}
    >
      <div className="relative overflow-hidden" style={{ width, height: h, background: '#2a2620' }}>
        {url ? (
          <img
            src={url}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
            style={{ imageRendering: 'pixelated', animation: develop ? `pc-develop ${DEVELOP_MS}ms ease-out forwards` : undefined }}
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center font-mono text-[10px]" style={{ color: '#b6a98c' }}>
            {label}
          </span>
        )}
      </div>
    </div>
  )
}
