import { useEffect, useState, type ReactNode } from 'react'
import { menuTick } from '../../game/core/sfx'
import { LEVEL_NAMES, MODE_DEFS, MODE_LIST, refusal, type ModeDef } from '../../game/modes/defs'
import type { RoundModeId } from '../../game/net/roundProtocol'
import { CIRCLED, INK, INK_SOFT, MARK } from './paper'
import { Note, Rule } from './PaperMarks'
import { useRoundText } from './roundText'
import { useWorldRound } from './worldRound'

/*
  The play page: pick a game, press ready, start it. It is written on the
  same paper as the pause sheet and the map sheet it appears on (paper.ts's
  ink, a circled choice, pencilled notes), in two sizes: the full page under
  "Play" on the pause sheet, with a picture, a blurb and the rules of each
  game, and a compact strip under the room strip on the map sheet, so the
  host of a private room can choose a game before anyone has walked anywhere.

  It owns no state of the round. It draws the store the scene bound
  (worldRound.ts) and sends commands; the server decides whether they take,
  and a refusal comes back as a pencilled line under the buttons for a few
  seconds. It stops key events at itself, like the room strip: the map sheet
  answers to number keys and enter.
*/

/** a pencil picture per game, 48 units square, drawn in the sheet's ink */
function Picture({ id }: { id: RoundModeId }) {
  const s = { fill: 'none', stroke: INK, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  return (
    <svg aria-hidden viewBox="0 0 48 48" width="46" height="46" className="shrink-0">
      {id === 'deathmatch' && (
        <>
          <circle cx="24" cy="24" r="13" {...s} />
          <path d="M24 5v10M24 33v10M5 24h10M33 24h10" {...s} />
          <circle cx="24" cy="24" r="2" fill={MARK} stroke="none" />
        </>
      )}
      {id === 'prophunt' && (
        <>
          <path d="M14 12c0-3 20-3 20 0v26c0 3-20 3-20 0z" {...s} />
          <path d="M14 20c6 2 14 2 20 0M14 30c6 2 14 2 20 0" {...s} />
          <circle cx="20" cy="25" r="1.6" fill={INK} stroke="none" />
          <circle cx="28" cy="25" r="1.6" fill={INK} stroke="none" />
        </>
      )}
      {id === 'hide' && (
        <>
          <path d="M5 24c6-9 12-13 19-13s13 4 19 13c-6 9-12 13-19 13S11 33 5 24z" {...s} />
          <circle cx="24" cy="24" r="6" {...s} />
          <circle cx="24" cy="24" r="2" fill={MARK} stroke="none" />
        </>
      )}
      {id === 'race' && (
        <>
          <path d="M10 42V8" {...s} />
          <path d="M10 9h26l-5 7 5 7H10" {...s} />
          <path d="M16 9v14M22 9v7M28 16v7M22 16v7" {...s} strokeWidth="1.1" />
          <ellipse cx="28" cy="40" rx="12" ry="3.4" {...s} />
        </>
      )}
      {id === 'build' && (
        <>
          <path d="M6 40h36M8 40V29h13v11M21 40V29h13v11M14 29V18h13v11" {...s} />
          <path d="M27 18l7-7 7 7v11" {...s} />
          <path d="M11 24l3-3" {...s} strokeWidth="1.1" />
        </>
      )}
    </svg>
  )
}

function Choice({ on, disabled, onClick, children, big }: {
  on: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; big?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      onClick={() => {
        menuTick('pick')
        onClick()
      }}
      className={`font-display relative px-1 py-0.5 uppercase disabled:opacity-40 ${big ? 'text-[21px]' : 'text-[18px]'}`}
      style={{ color: on ? INK : INK_SOFT }}
    >
      {children}
      <span
        aria-hidden
        className={`absolute -inset-x-2.5 -inset-y-1 transition-opacity ${on ? 'opacity-100' : 'opacity-0'}`}
        style={CIRCLED}
      />
    </button>
  )
}

export default function PlayPanel({ compact = false }: { compact?: boolean }) {
  const { tr, lang } = useRoundText()
  const { bridge } = useWorldRound()
  const [note, setNote] = useState<string | null>(null)
  const state = bridge?.state ?? null

  useEffect(() => {
    if (!state) return
    return state.on((e) => {
      if (e.type === 'no') setNote(refusal(e.cmd, e.reason, e.need, lang))
    })
  }, [state, lang])
  useEffect(() => {
    if (note === null) return
    const id = window.setTimeout(() => setNote(null), 4200)
    return () => window.clearTimeout(id)
  }, [note])

  if (!bridge || !state) {
    return compact ? null : (
      <p><Note>{tr('offline')}</Note></p>
    )
  }

  const def: ModeDef = MODE_DEFS[state.mode]
  const lobby = state.phase === 'lobby'
  const host = state.isHost
  const me = state.you
  const iAmReady = state.ready.has(me)
  const here = bridge.headcount()
  const canStart = host && lobby
  const send = bridge.send
  const cmd = (m: Parameters<typeof send>[0]) => send(m)
  const modeName = (m: ModeDef) => m.name[lang]
  const levelName = (l: string) => (LEVEL_NAMES[l] ?? { en: l, es: l })[lang]
  const optValue = (key: string) => state.opt[key]

  const options = def.options.map((o) => {
    const v = optValue(o.key)
    if (o.kind === 'bool') {
      return (
        <span key={o.key} className="flex items-center gap-2">
          <span className="font-mono text-[12px]" style={{ color: INK_SOFT }}>{o.label[lang]}</span>
          <Choice on={v === true} disabled={!host || !lobby} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'opt', key: o.key, value: v !== true })}>
            {v === true ? tr('optOn') : tr('optOff')}
          </Choice>
        </span>
      )
    }
    return (
      <span key={o.key} className="flex items-center gap-2">
        <span className="font-mono text-[12px]" style={{ color: INK_SOFT }}>{o.label[lang]}</span>
        {o.choices?.map((c) => (
          <Choice key={c.value} on={v === c.value} disabled={!host || !lobby} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'opt', key: o.key, value: c.value })}>
            {c.label[lang]}
          </Choice>
        ))}
      </span>
    )
  })

  const levels = def.levels.length > 1 && (
    <span className="flex items-center gap-2">
      <span className="font-mono text-[12px]" style={{ color: INK_SOFT }}>{tr('map')}</span>
      {def.levels.map((l) => (
        <Choice key={l} on={state.level === l} disabled={!host || !lobby} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'mode', mode: def.id, level: l })}>
          {levelName(l)}
        </Choice>
      ))}
    </span>
  )

  const actions = (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {lobby ? (
        <>
          <Choice big on={iAmReady} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'ready', on: !iAmReady })}>
            {iAmReady ? tr('ready') : tr('notReady')}
          </Choice>
          {canStart && (
            <Choice big on={false} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'start' })}>
              {tr('start')}
            </Choice>
          )}
          <span className="font-mono text-[12px]" style={{ color: INK_SOFT }}>
            {tr('readyCount', { a: state.ready.size, b: here })}
          </span>
        </>
      ) : (
        <>
          <span className="font-mono text-[12px]" style={{ color: INK }}>
            {tr('roundOn')}: {modeName(def)} · {state.inRound ? tr('yourPlace') : tr('notInIt')}
          </span>
          {state.phase === 'playing' && !state.mine && def.id === 'deathmatch' && (
            <Choice big on={false} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'join' })}>{tr('join')}</Choice>
          )}
          {(host || bridge.isAdmin()) && (
            <Choice big on={false} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'stop' })}>{tr('stop')}</Choice>
          )}
        </>
      )}
      {lobby && (host || bridge.isAdmin()) && (
        <span className="flex items-center gap-2" title={tr('debugHint')}>
          <Choice on={state.debug} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'debug', on: !state.debug })}>{tr('debug')}</Choice>
        </span>
      )}
    </div>
  )

  const hostLine = (
    <p className="font-mono text-[12px]" style={{ color: INK_SOFT }}>
      {host ? tr('youHost') : tr('hostNote', { name: bridge.nameOf(state.host) })} · {tr('inRoom', { n: here })}
      {lobby && !host ? ` · ${tr('hostOnly')}` : ''}
    </p>
  )

  const msg = note && (
    <p className="font-mono text-[12px]" style={{ color: MARK }}>{note}</p>
  )

  if (compact) {
    return (
      <div onKeyDown={(e) => e.stopPropagation()} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="font-display text-[21px] uppercase" style={{ color: INK }}>{tr('rounds')}</span>
          {MODE_LIST.map((m) => (
            <Choice key={m.id} on={state.mode === m.id} disabled={!host || !lobby} onClick={() => cmd({ type: 'world-round-cmd', cmd: 'mode', mode: m.id })}>
              {modeName(m)}
            </Choice>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {levels}
          {options}
        </div>
        {actions}
        {hostLine}
        {msg}
      </div>
    )
  }

  return (
    <div onKeyDown={(e) => e.stopPropagation()} className="flex flex-col gap-4">
      {hostLine}
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {MODE_LIST.map((m, i) => {
          const on = state.mode === m.id
          return (
            <button
              key={m.id}
              type="button"
              disabled={!host || !lobby}
              onClick={() => {
                menuTick('pick')
                cmd({ type: 'world-round-cmd', cmd: 'mode', mode: m.id })
              }}
              className="relative flex items-start gap-3 px-2 py-1.5 text-left disabled:cursor-default"
              style={{ transform: `rotate(${[-0.5, 0.4, -0.3, 0.5, -0.4][i % 5]}deg)` }}
            >
              <Picture id={m.id} />
              <span className="flex min-w-0 flex-col">
                <span className="font-display text-[22px] leading-none uppercase" style={{ color: on ? INK : INK_SOFT }}>
                  {modeName(m)}
                </span>
                <span className="mt-1 font-mono text-[11px] leading-snug" style={{ color: INK_SOFT }}>{m.blurb[lang]}</span>
                <span className="mt-1 font-mono text-[10px]" style={{ color: INK_SOFT }}>
                  {tr('minPlayers', { n: m.min })} · {tr('maxPlayers', { n: m.max })} · {m.levels.map(levelName).join(' / ')}
                </span>
              </span>
              <span
                aria-hidden
                className={`pointer-events-none absolute -inset-1 transition-opacity ${on ? 'opacity-100' : 'opacity-0'}`}
                style={CIRCLED}
              />
            </button>
          )
        })}
      </div>
      <Rule className="w-40" color={`${INK}66`} />
      <div className="flex flex-col gap-3">
        <p className="font-mono text-[12px] leading-relaxed" style={{ color: INK }}>{def.rules[lang]}</p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {levels}
          {options}
        </div>
        {actions}
        <p><Note>{lobby ? tr('allReady') : tr('backSoon')}</Note></p>
        {msg}
      </div>
    </div>
  )
}
