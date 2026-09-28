import { useEffect, useReducer, useState } from 'react'
import type { HealthState } from '../../game/player/health'
import { useI18n } from '../../i18n'

/*
  Hit points, drawn as stationery like the rest of the walk's HUD: a strip of
  masking tape at the bottom with a hand-drawn heart and a pencilled bar on
  it, the killfeed as torn ticket stubs down the top-right corner (under the
  frame-counter tape), and, when you are down, a dimmed sheet with one
  ticket on it saying who knocked you out and when you are back.

  It draws only what the state (game/player/health.ts) says and owns no
  numbers. The bar is shown when something has made it worth showing (pvp on,
  or hurt, or dead) and put away otherwise, so free play looks exactly as it
  always did. The red flash of a hit is a CSS animation re-keyed by the
  `hurt` event, not a per-frame React state: the main thread here is
  sometimes blocked in lumps and an animation that lives on the compositor
  keeps its clock. The low-health breathing is the same trick.
*/

const INK = '#3a2f22'
const TAPE = 'linear-gradient(90deg, rgba(247,236,205,0.94), rgba(238,224,190,0.96))'

const CSS = `
@keyframes hp-flash { 0% { opacity: 0.95 } 100% { opacity: 0 } }
@keyframes hp-breathe { 0%,100% { opacity: 0.18 } 50% { opacity: 0.42 } }
@keyframes hp-in { 0% { opacity: 0; transform: translateY(-6px) rotate(var(--r)) } 100% { opacity: 1; transform: translateY(0) rotate(var(--r)) } }
`

/** a heart drawn like a pencil doodle: two lobes and a point, a wobbly outline */
function Heart({ fill }: { fill: string }) {
  return (
    <svg aria-hidden width="20" height="18" viewBox="0 0 20 18" className="shrink-0">
      <path
        d="M10 16.4 C3.2 11.6 1.2 8.6 1.7 5.6 C2.3 2.2 6.6 1.2 8.6 3.6 L10 5.1 L11.5 3.4 C13.6 1 17.9 2.3 18.3 5.7 C18.6 8.7 16.4 11.7 10 16.4 Z"
        fill={fill}
        stroke={INK}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M5 5.2 C5.4 4.4 6.3 4.1 7 4.4" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

const barColour = (share: number) => (share > 0.6 ? '#5c9b4a' : share > 0.3 ? '#d19a2e' : '#c24a3a')

export default function HealthHud({
  state,
  nameOf,
}: {
  state: HealthState
  nameOf: (id: number) => string
}) {
  const { t } = useI18n()
  const h = t.sandbox.health
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [flashKey, setFlashKey] = useState(0)
  const [pvpNote, setPvpNote] = useState<string | null>(null)

  useEffect(() => {
    const off = state.subscribe(redraw)
    const offEvents = state.on((e) => {
      if (e.type === 'hurt') setFlashKey((k) => k + 1)
      else if (e.type === 'died') setFlashKey((k) => k + 1)
      else if (e.type === 'pvp') {
        const who = e.by ? nameOf(e.by) : ''
        setPvpNote(
          e.by
            ? (e.on ? h.pvpBy : h.pvpOffBy).replace('{name}', who)
            : e.on ? h.pvpOn : h.pvpOff,
        )
      }
    })
    return () => {
      off()
      offEvents()
    }
  }, [state, nameOf, h])

  // the countdown and the feed's expiry need a clock; it only runs while
  // there is something on screen that depends on one
  const ticking = state.dead || state.feed.length > 0 || pvpNote !== null
  useEffect(() => {
    if (!ticking) return
    const id = window.setInterval(redraw, 200)
    return () => window.clearInterval(id)
  }, [ticking])
  useEffect(() => {
    if (pvpNote === null) return
    const id = window.setTimeout(() => setPvpNote(null), 3500)
    return () => window.clearTimeout(id)
  }, [pvpNote])

  const share = Math.max(0, Math.min(1, state.hp / state.max))
  const showBar = state.engaged && !state.dead
  const name = (id: number, mine: boolean) => (mine ? h.you : nameOf(id))
  const left = state.respawnIn()
  const kind = (k: string) => h.kinds[k] ?? h.kinds.env

  return (
    <>
      <style>{CSS}</style>
      {/* the red of a hit: an inset glow re-keyed on every blow */}
      {flashKey > 0 && (
        <div
          key={flashKey}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20"
          style={{
            boxShadow: 'inset 0 0 140px 40px rgba(200,30,20,0.75)',
            animation: 'hp-flash 0.7s ease-out forwards',
          }}
        />
      )}
      {state.low && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20"
          style={{
            boxShadow: 'inset 0 0 120px 20px rgba(170,20,16,0.8)',
            animation: 'hp-breathe 1.6s ease-in-out infinite',
          }}
        />
      )}

      {/* the bar */}
      {showBar && (
        <div
          className="pointer-events-none absolute bottom-11 z-20"
          style={{ left: "calc(50% + 100px)", transform: "translateX(-50%) rotate(-0.7deg)" }}
        >
          <div
            className="flex items-center gap-2 px-3 py-[5px] font-mono"
            style={{
              color: INK,
              background: TAPE,
              boxShadow: '0 1px 3px rgba(40,30,18,0.4)',
              clipPath: 'polygon(0 10%, 1.5% 0, 98.5% 5%, 100% 0, 99% 90%, 100% 100%, 1% 95%, 0 100%)',
            }}
          >
            <Heart fill={barColour(share)} />
            <div
              className="relative h-[9px] w-[130px] overflow-hidden"
              style={{ background: 'rgba(58,47,34,0.18)', border: `1px solid ${INK}`, borderRadius: 2 }}
            >
              <div
                className="h-full transition-[width] duration-150"
                style={{ width: `${share * 100}%`, background: barColour(share) }}
              />
              {/* pencil hatching over the fill, so it reads as drawn */}
              <div
                className="absolute inset-0"
                style={{
                  background: 'repeating-linear-gradient(115deg, rgba(58,47,34,0.16) 0 1px, transparent 1px 4px)',
                }}
              />
            </div>
            <span className="w-[26px] text-right text-[13px] font-semibold tabular-nums">{Math.ceil(state.hp)}</span>
            {state.protectedNow && <span className="text-[10px] italic" style={{ color: '#7a6a54' }}>{h.protectedTag}</span>}
          </div>
        </div>
      )}

      {pvpNote && (
        <p
          className="pointer-events-none absolute top-14 left-1/2 z-20 -translate-x-1/2 px-3 py-[3px] font-mono text-[12px]"
          style={{ color: INK, background: TAPE, boxShadow: '0 1px 3px rgba(40,30,18,0.35)', transform: 'translateX(-50%) rotate(0.6deg)' }}
        >
          {pvpNote}
        </p>
      )}

      {/* the killfeed: ticket stubs, newest at the bottom */}
      {state.feed.length > 0 && (
        <div className="pointer-events-none absolute top-12 right-4 z-20 flex flex-col items-end gap-1 font-mono">
          {state.feed.map((line, i) => {
            const rot = (i % 2 ? 1 : -1) * (0.6 + (line.key % 3) * 0.4)
            const mine = line.mineOut || line.mineIn
            return (
              <div
                key={line.key}
                className="flex items-center gap-1.5 px-2.5 py-[2px] text-[12px]"
                style={{
                  ['--r' as string]: `${rot}deg`,
                  animation: 'hp-in 0.25s ease-out both',
                  color: INK,
                  background: mine
                    ? 'linear-gradient(90deg, rgba(250,222,180,0.96), rgba(244,206,160,0.97))'
                    : TAPE,
                  boxShadow: '0 1px 2px rgba(60,44,26,0.35)',
                  clipPath: 'polygon(0 8%, 2% 0, 97% 6%, 100% 0, 99% 92%, 100% 100%, 3% 94%, 0 100%)',
                }}
              >
                {line.by !== 0 && line.by !== line.victim && (
                  <>
                    <span className={line.mineIn ? 'font-bold' : ''}>{name(line.by, line.mineIn)}</span>
                    <span className="text-[10px] italic" style={{ color: '#8a3a2a' }}>[{kind(line.kind)}]</span>
                  </>
                )}
                <span className={line.mineOut ? 'font-bold' : ''}>{name(line.victim, line.mineOut)}</span>
                {(line.by === 0 || line.by === line.victim) && (
                  <span className="text-[10px] italic" style={{ color: '#8a3a2a' }}>[{kind(line.kind)}]</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* down: a dimmed sheet and one ticket */}
      {state.dead && (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
          style={{ background: 'radial-gradient(ellipse at center, rgba(40,6,4,0.35), rgba(20,2,2,0.72))' }}
        >
          <div
            className="px-7 py-4 text-center font-mono"
            style={{
              color: INK,
              background: TAPE,
              boxShadow: '0 3px 10px rgba(0,0,0,0.5)',
              transform: 'rotate(-1.2deg)',
              clipPath: 'polygon(0 6%, 1% 0, 99% 4%, 100% 0, 99.4% 94%, 100% 100%, 1% 96%, 0 100%)',
            }}
          >
            <p className="text-[17px] font-semibold">
              {state.killer && state.killer !== 0
                ? h.knockedOutBy.replace('{name}', nameOf(state.killer))
                : (h.knockedOut[state.killedBy] ?? h.knockedOut.env)}
            </p>
            <p className="mt-1 text-[13px]" style={{ color: '#7a6a54' }}>
              {h.respawnIn.replace('{n}', String(left))}
            </p>
          </div>
        </div>
      )}
    </>
  )
}
