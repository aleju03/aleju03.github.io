import { useEffect, useMemo, useState } from 'react'
import { keyHint } from '../../game/sandbox/bindings'
import type { HandsHud } from '../../game/levels/types'
import { useI18n } from '../../i18n'
import { INK, INK_SOFT, MARK, stockTexture } from './paper'

/*
  Cubeland's hotbar: nine blocks along the bottom of the screen while your
  bare hands are out, the one in hand picked out, its name for a moment
  after it changes.

  It is the famous hotbar's layout and this world's stationery: nine
  squares of card stuck to a strip of masking tape, each showing the
  block's own catalogue plate (sandbox/thumbnails.ts, drawn pixelated,
  nearest-neighbour, the way the look draws everything), the one in hand
  lifted and ringed in the terracotta marker the belt and the pause sheet
  select with. The name comes up on a scrap of tape over it and fades.

  Only drawn: the walk holds the pointer, so it takes no events. The level
  owns the hotbar (levels/cubeland/cubeland.ts's `hands`); the wheel steps
  it and a click in the catalogue fills the slot in hand.
*/

export interface BlockBarProps {
  hud: HandsHud
  /** the catalogue's plates, by kind */
  thumbs: Map<string, string> | null
  /** a kind's name in the reader's language */
  name: (kind: string) => string
}

const NAME_MS = 1600
const HINT_MS = 9000

export default function BlockBar({ hud, thumbs, name }: BlockBarProps) {
  const { language, t } = useI18n()
  const [hint, setHint] = useState(true)
  const tape = useMemo(() => stockTexture({ base: '#e6d8b4', seed: 0x7a9e, grain: 0.7, flecks: 30, fleck: '120,100,60' }), [])
  const kind = hud.kinds[hud.sel]
  // the name shows until its timer puts that very pick away; the one the bar
  // opened with never shows
  const pick = `${hud.sel}:${kind}`
  const [hiddenFor, setHiddenFor] = useState(pick)
  useEffect(() => {
    const id = window.setTimeout(() => setHiddenFor(pick), NAME_MS)
    return () => window.clearTimeout(id)
  }, [pick])
  const nameUp = hiddenFor !== pick
  useEffect(() => {
    const id = window.setTimeout(() => setHint(false), HINT_MS)
    return () => window.clearTimeout(id)
  }, [])
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex flex-col items-center gap-1.5 select-none">
      <div
        className="px-2.5 py-[1px] font-mono text-[12px] italic transition-opacity duration-300"
        style={{
          opacity: nameUp ? 1 : 0,
          color: INK,
          background: 'rgba(238,226,196,0.93)',
          transform: 'rotate(-1.2deg)',
          boxShadow: '0 1px 2px rgba(40,30,20,0.35)',
        }}
      >
        {kind ? name(kind) : ''}
      </div>
      <div
        className="flex items-end gap-[5px] px-2.5 py-1.5"
        style={{
          backgroundImage: `url(${tape})`,
          backgroundColor: '#e6d8b4',
          boxShadow: '0 2px 3px rgba(40,30,20,0.35)',
          clipPath: 'polygon(0.6% 6%, 99.4% 0, 100% 94%, 0 100%)',
          transform: 'rotate(0.4deg)',
        }}
      >
        {hud.kinds.map((k, i) => {
          const on = i === hud.sel
          const pic = thumbs?.get(k)
          return (
            <div
              key={i}
              className="relative flex h-11 w-11 items-center justify-center transition-transform duration-100"
              style={{
                background: on ? '#f4ecd8' : '#dccda6',
                transform: on ? 'translateY(-4px) rotate(-1.5deg)' : 'none',
                boxShadow: on ? '0 3px 4px rgba(40,30,20,0.35)' : 'inset 0 0 0 1px rgba(60,48,32,0.25)',
                outline: on ? `2.5px solid ${MARK}` : 'none',
                outlineOffset: -1,
              }}
            >
              {pic ? (
                <img src={pic} alt="" className="h-10 w-10" style={{ imageRendering: 'pixelated' }} draggable={false} />
              ) : (
                <span className="font-mono text-[9px]" style={{ color: INK_SOFT }}>{name(k).slice(0, 4)}</span>
              )}
              <span className="absolute top-0 left-[3px] font-mono text-[8px]" style={{ color: INK_SOFT }}>
                {i + 1}
              </span>
            </div>
          )
        })}
      </div>
      <p
        className="font-mono text-[10.5px] italic transition-opacity duration-700"
        style={{ opacity: hint ? 0.95 : 0, color: '#f2ead8', textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}
      >
        {keyHint(t.sandbox.blocks.hint, language)}
      </p>
    </div>
  )
}
