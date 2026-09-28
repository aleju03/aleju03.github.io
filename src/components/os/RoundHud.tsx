import { useEffect, useReducer, useState } from 'react'
import type { RoundState } from '../../game/net/remoteRounds'
import type { RoundDirector } from '../../game/modes/director'
import { MODE_DEFS, THEMES, clock, raceTime, roleDef, sideColor, sideName } from '../../game/modes/defs'
import { INK, INK_SOFT, MARK, PAPER } from './paper'
import { useRoundText, type RoundKey } from './roundText'

/*
  The round on screen, in the walk's tape-and-paper manner (HealthHud.tsx's
  masking tape, the pause sheet's stock). Everything here is DOM over the
  canvas and draws only what the round store and the director say; it owns no
  rules and no numbers.

  - **The tape** across the top: the game, the clock, the score line the mode
    keeps (kills per side, props left, your ring, the gallery's plot), and one
    line of objective under it.
  - **The countdown**: a big numeral in the middle for the last three seconds
    before play, "waiting" while someone is still arriving on the map, and a
    "GO" that lingers a moment.
  - **Your part**: a card at the start naming your side or role and what it
    is for, with the side's colour.
  - **The blindfold**: hunters and seekers are covered for the hiding time.
  - **The scoreboard**, held on Tab.
  - **The results sheet** with the winners, and a line of why.

  It redraws on the store's changes and on a 250 ms tick while a round is on
  (timers), and not at all in the lobby.
*/

const TAPE = 'linear-gradient(90deg, rgba(247,236,205,0.94), rgba(238,224,190,0.96))'
const CLIP = 'polygon(0 10%, 1.5% 0, 98.5% 5%, 100% 0, 99% 90%, 100% 100%, 1% 95%, 0 100%)'

const CSS = `
@keyframes rd-pop { 0% { opacity: 0; transform: scale(1.6) } 20% { opacity: 1 } 100% { opacity: 0.0; transform: scale(0.9) } }
@keyframes rd-in { 0% { opacity: 0; transform: translateY(-8px) } 100% { opacity: 1; transform: translateY(0) } }
`

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      className="px-4 py-2 font-mono"
      style={{ color: INK, background: TAPE, boxShadow: '0 1px 4px rgba(40,30,18,0.45)', clipPath: CLIP, ...style }}
    >
      {children}
    </div>
  )
}

export default function RoundHud({
  state,
  director,
  nameOf,
}: {
  state: RoundState
  director: RoundDirector
  nameOf: (id: number) => string
}) {
  const { tr, lang } = useRoundText()
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [board, setBoard] = useState(false)
  const [role, setRole] = useState<{ key: number; shown: number } | null>(null)

  useEffect(() => state.subscribe(redraw), [state])
  const active = state.phase !== 'lobby'
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(redraw, 250)
    return () => window.clearInterval(id)
  }, [active])
  // the scoreboard: held on Tab, swallowing the browser's own use of it
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Tab') return
      e.preventDefault()
      setBoard(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Tab') setBoard(false)
    }
    const blur = () => setBoard(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  // the role card, for a few seconds after the round starts for you
  useEffect(() => {
    return state.on((e) => {
      if (e.type === 'phase' && (e.to === 'countdown' || e.to === 'playing')) {
        setRole({ key: Date.now(), shown: Date.now() })
      }
    })
  }, [state])
  useEffect(() => {
    if (!role) return
    const id = window.setTimeout(() => setRole(null), 6500)
    return () => window.clearTimeout(id)
  }, [role])

  if (state.phase === 'lobby') return null
  const def = MODE_DEFS[state.mode]
  const mine = state.mine
  const left = state.leftMs()
  const teamed = def.sides.length > 0
  const side = (team: string) => ({ color: sideColor(state.mode, team) ?? INK, name: sideName(state.mode, team, lang) })
  const sum = (team: string, pick: (p: { a: number; score: number }) => number) =>
    state.parts.filter((p) => p.team === team).reduce((n, p) => n + pick(p), 0)

  const blind = director.blind()
  const objective = director.objective()
  const rd = mine ? roleDef(state.mode, mine.role) : null

  // ---- the tape's score line, per game
  let line: string | null = null
  if (state.mode === 'deathmatch') {
    const limit = state.num('limit')
    line = state.obj.teams === false
      ? `${lang === 'es' ? 'Límite' : 'Limit'} ${limit}`
      : `${side('a').name} ${sum('a', (p) => p.a)}  -  ${sum('b', (p) => p.a)} ${side('b').name}  (${limit})`
  } else if (state.mode === 'prophunt') {
    const alive = state.parts.filter((p) => p.role === 'prop' && !p.out).length
    line = `${tr('propsLeft')}: ${alive}`
  } else if (state.mode === 'hide') {
    line = `${tr('hidersLeft')}: ${state.parts.filter((p) => p.role === 'hider').length}`
  } else if (state.mode === 'race') {
    const order = [...state.parts].sort((x, y) => (y.b > 0 ? 1 : 0) - (x.b > 0 ? 1 : 0) || (x.b > 0 && y.b > 0 ? x.b - y.b : y.a - x.a))
    const pos = order.findIndex((p) => p.id === state.you) + 1
    const turn = state.num('turn')
    line = state.obj.foot === 1
      ? `${pos > 0 ? `${pos}/${order.length}` : ''}`
      : turn ? (turn === state.you ? tr('yourTurn') : tr('turnOf', { name: nameOf(turn) })) : ''
  } else if (state.mode === 'build') {
    const th = THEMES[state.num('theme')]
    line = `${tr('theme')}: ${th ? th[lang] : '?'}`
  }

  // ---- the middle of the screen
  let banner: string | null = null
  let bannerBig = false
  if (state.phase === 'countdown') {
    if (state.waiting) banner = tr('waiting')
    else if (left > 0 && left <= 3500) {
      banner = String(Math.max(1, Math.ceil(left / 1000)))
      bannerBig = true
    } else banner = tr('getReady')
  } else if (state.phase === 'playing') {
    const start = Math.max(0, state.result ? 0 : (def.id === 'race' && state.obj.goAt ? state.untilAt(state.num('goAt')) : 0))
    if (start > 0) {
      banner = start > 3000 ? tr('getReady') : String(Math.max(1, Math.ceil(start / 1000)))
      bannerBig = start <= 3000
    }
  }

  return (
    <>
      <style>{CSS}</style>

      {/* the tape */}
      <div className="pointer-events-none absolute top-3 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-1" style={{ transform: 'translateX(-50%) rotate(-0.4deg)' }}>
        <Card>
          <div className="flex items-baseline gap-4">
            <span className="font-display text-[19px] uppercase">{def.name[lang]}</span>
            <span className="text-[22px] tabular-nums">{state.phase === 'results' ? tr('results') : clock(left)}</span>
            {line && <span className="text-[13px]">{line}</span>}
          </div>
          {mine && rd && (
            <div className="mt-0.5 text-center text-[11px]" style={{ color: side(rd.team).color }}>
              {tr('youAre')} {rd.name[lang].toUpperCase()}
              {mine.out ? ` · ${tr('eliminated')}` : ''}
            </div>
          )}
          {mine && !rd && teamed && mine.team && (
            <div className="mt-0.5 text-center text-[11px]" style={{ color: side(mine.team).color }}>
              {side(mine.team).name.toUpperCase()}
            </div>
          )}
          {!mine && state.phase !== 'results' && (
            <div className="mt-0.5 text-center text-[11px]" style={{ color: INK_SOFT }}>{tr('spectate')}</div>
          )}
        </Card>
        {objective && mine && state.phase === 'playing' && (
          <Card style={{ padding: '3px 12px' }}>
            <span className="text-[11px]">{objective[lang]}</span>
          </Card>
        )}
        {state.mode === 'build' && state.phase === 'playing' && <BuildLine state={state} nameOf={nameOf} tr={tr} />}
        {state.debug && <span className="font-mono text-[10px]" style={{ color: MARK }}>debug</span>}
      </div>

      {/* the countdown / waiting */}
      {banner && (
        <div className="pointer-events-none absolute inset-x-0 top-[32%] z-20 flex justify-center">
          <span
            key={banner}
            className="font-display uppercase"
            style={{
              color: '#fff6dc',
              fontSize: bannerBig ? 120 : 34,
              textShadow: '0 3px 0 rgba(60,40,20,0.7), 0 0 30px rgba(0,0,0,0.6)',
              animation: bannerBig ? 'rd-pop 1s ease-out forwards' : 'rd-in 0.3s ease-out',
            }}
          >
            {banner}
          </span>
        </div>
      )}

      {/* your part, at the start */}
      {role && mine && state.phase !== 'results' && (
        <div className="pointer-events-none absolute inset-x-0 top-[52%] z-20 flex justify-center" style={{ animation: 'rd-in 0.4s ease-out' }}>
          <Card style={{ padding: '10px 22px', textAlign: 'center', maxWidth: 520 }}>
            <div className="font-display text-[28px] uppercase leading-none" style={{ color: rd ? side(rd.team).color : mine.team ? side(mine.team).color : INK }}>
              {rd ? rd.name[lang] : mine.team ? side(mine.team).name : def.name[lang]}
            </div>
            <div className="mt-1 text-[12px]">{rd ? rd.brief[lang] : def.blurb[lang]}</div>
          </Card>
        </div>
      )}

      {/* the blindfold */}
      {blind && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center" style={{ background: '#050403' }}>
          <span className="font-display text-[46px] uppercase" style={{ color: '#efe3c6' }}>{tr('blindTitle')}</span>
          <span className="mt-2 font-mono text-[14px]" style={{ color: '#a89878' }}>{tr('blindText')}</span>
          <span className="mt-4 font-display text-[64px] tabular-nums" style={{ color: '#efe3c6' }}>
            {clock(state.untilAt(state.num('seekAt')))}
          </span>
        </div>
      )}

      {(board || state.phase === 'results') && <Board state={state} nameOf={nameOf} tr={tr} lang={lang} results={state.phase === 'results'} />}
    </>
  )
}

function BuildLine({ state, nameOf, tr }: { state: RoundState; nameOf: (id: number) => string; tr: (k: RoundKey, v?: Record<string, string | number>) => string }) {
  const gal = state.obj.gal as { plot: number; i: number; n: number; endAt: number } | undefined
  const stage = state.obj.stage
  const text = stage === 'gallery' && gal
    ? `${tr('gallery')} ${gal.i + 1}/${gal.n}: ${tr('plotOf', { name: nameOf(gal.plot) })} · ${clock(state.untilAt(gal.endAt))}`
    : `${tr('building')} · ${clock(state.untilAt(state.num('buildEndAt')))}`
  return (
    <div className="px-3 py-[3px] font-mono text-[11px]" style={{ color: INK, background: TAPE, clipPath: CLIP }}>
      {text}
    </div>
  )
}

function Board({ state, nameOf, tr, lang, results }: {
  state: RoundState
  nameOf: (id: number) => string
  tr: (k: RoundKey, v?: Record<string, string | number>) => string
  lang: 'en' | 'es'
  results: boolean
}) {
  const def = MODE_DEFS[state.mode]
  const res = state.result
  const rows = results && res
    ? res.rows.map((r) => ({ id: r[0], team: r[1], score: r[2], a: r[3], b: r[4] }))
    : [...state.parts].sort((x, y) => y.score - x.score || y.a - x.a).map((p) => ({ id: p.id, team: p.team, score: p.score, a: p.a, b: p.b }))
  const cols: Record<string, [string, string]> = {
    deathmatch: [tr('kills'), tr('deaths')],
    prophunt: [tr('found'), tr('time2')],
    hide: [tr('tags'), tr('survived')],
    race: [tr('rings'), tr('time2')],
    build: [tr('marks'), ''],
  }
  const [ca, cb] = cols[state.mode]
  const fmtB = (b: number) => {
    if (state.mode === 'race') return b > 0 ? raceTime(b) : tr('dnf')
    if (state.mode === 'hide' || state.mode === 'prophunt') return b > 0 ? `${b}s` : '-'
    return b ? String(b) : cb ? '0' : ''
  }
  const winners = res?.win ?? []
  const iWon = winners.includes(state.you)
  const headline = !res
    ? tr('scoreboard')
    : winners.length === 0 && !res.team
      ? res.note === 'draw' || res.note === 'tie' ? tr('draw') : tr('nobody')
      : res.team
        ? `${sideName(state.mode, res.team, lang)}`
        : winners.map(nameOf).join(', ')
  const teamColour = res?.team ? sideColor(state.mode, res.team) : null
  return (
    <div className={`pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6 ${results ? '' : ''}`} style={results ? { background: 'radial-gradient(ellipse at 50% 45%, rgba(14,11,8,0.5), rgba(8,6,4,0.78))' } : undefined}>
      <div
        className="relative w-[min(34rem,100%)] px-8 py-6"
        style={{ background: PAPER, color: INK, boxShadow: '0 16px 36px rgba(0,0,0,0.55)', transform: 'rotate(-0.7deg)' }}
      >
        {results && res && (
          <div className="mb-3">
            <div className="font-mono text-[11px] uppercase" style={{ color: INK_SOFT }}>
              {def.name[lang]} · {tr(`why_${res.why}` as RoundKey)}
            </div>
            <div className="font-display text-[44px] leading-none uppercase" style={{ color: teamColour ?? INK }}>
              {winners.length > 0 || res.team ? `${headline}` : headline}
            </div>
            {winners.length > 0 && res.team && (
              <div className="font-mono text-[12px]" style={{ color: INK_SOFT }}>{winners.map(nameOf).join(', ')}</div>
            )}
            {state.mine && (
              <div className="mt-1 font-display text-[20px] uppercase" style={{ color: iWon ? MARK : INK_SOFT }}>
                {iWon ? tr('youWon') : tr('youLost')}
              </div>
            )}
          </div>
        )}
        {!results && <div className="mb-2 font-display text-[26px] uppercase">{headline}</div>}
        <table className="w-full font-mono text-[12px]">
          <thead>
            <tr style={{ color: INK_SOFT }}>
              <th className="text-left font-normal">{tr('player')}</th>
              <th className="text-right font-normal">{tr('score')}</th>
              <th className="text-right font-normal">{ca}</th>
              <th className="text-right font-normal">{cb}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const col = r.team ? sideColor(state.mode, r.team) : null
              const won = winners.includes(r.id)
              return (
                <tr key={r.id} style={{ fontWeight: r.id === state.you ? 700 : 400 }}>
                  <td className="py-[1px]">
                    {col && <span className="mr-2 inline-block size-2 rounded-full align-middle" style={{ background: col }} />}
                    {r.id === state.you ? `${nameOf(r.id)} *` : nameOf(r.id)}
                    {won && results ? ' ★' : ''}
                  </td>
                  <td className="text-right tabular-nums">{r.score}</td>
                  <td className="text-right tabular-nums">{state.mode === 'race' ? `${r.a}` : r.a}</td>
                  <td className="text-right tabular-nums">{fmtB(r.b)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {results ? <div className="mt-3 font-mono text-[11px]" style={{ color: INK_SOFT }}>{tr('backSoon')}</div> : <div className="mt-3 font-mono text-[11px]" style={{ color: INK_SOFT }}>{tr('hold')}</div>}
      </div>
    </div>
  )
}
