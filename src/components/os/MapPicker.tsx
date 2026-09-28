import { useEffect, useMemo, useState } from 'react'
import { menuTick } from '../../game/core/sfx'
import { MAPS, type MapId } from '../../game/levels/maps'
import { useI18n } from '../../i18n'
import { INK, INK_SOFT, MARK, PAPER, stockTexture } from './paper'

/*
  Where to? The map sheet, raised by the pause menu's "change map" in place
  of the pause sheet, with the world held still behind it and a print of
  each map pinned to it. Every walk starts at home, which is already built
  around you when you stand up, so nothing asks before that. Picking a map
  runs the level cut there (CrtScene's goMap), or, for the map you are
  already on, just lets go of the world, and so does esc.

  It is the pause sheet's stationery (paper.ts): a sheet of the same stock,
  a title in the display face, and each map a photo print with a white
  border, a caption pencilled under it and a pin, tipped a degree or two
  off square. The prints are our own renders of each map, shipped as small
  WebP files under public/os/maps/ (`picture` below), and ringed in the
  marker when hovered. The number keys pick one too.
*/

const pictureOf = (id: MapId) => `${import.meta.env.BASE_URL}os/maps/${id}.webp`

export interface MapPickerProps {
  /** the map the walker is standing in now */
  here: MapId
  onPick: (id: MapId) => void
}

export default function MapPicker({ here, onPick }: MapPickerProps) {
  const { t } = useI18n()
  const tp = t.pause
  const [hover, setHover] = useState<MapId | null>(null)
  const stock = useMemo(() => stockTexture({ base: PAPER, seed: 0x3a9d, grain: 0.8, flecks: 60, fleck: '90,80,60' }), [])
  // 1, 2, 3... pick; enter takes the one you are on
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key)
      if (n >= 1 && n <= MAPS.length) {
        e.preventDefault()
        menuTick('pick')
        onPick(MAPS[n - 1].id)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onPick(here)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [here, onPick])

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-auto bg-black/45 p-4 backdrop-blur-[2px]">
      <div
        className="relative w-full max-w-5xl px-6 pt-6 pb-5 sm:px-10 sm:pt-8"
        style={{
          backgroundImage: `url(${stock})`,
          backgroundColor: PAPER,
          boxShadow: '0 18px 40px rgba(0,0,0,0.45), 0 2px 4px rgba(0,0,0,0.3)',
          transform: 'rotate(-0.4deg)',
        }}
      >
        <h2 className="font-display text-[34px] leading-none uppercase sm:text-[44px]" style={{ color: INK }}>
          {tp.pickTitle}
        </h2>
        <p className="mt-2 font-mono text-[12px]" style={{ color: INK_SOFT }}>
          {tp.pickHint}
        </p>
        <div className="mt-6 grid grid-cols-1 gap-7 sm:grid-cols-3 sm:gap-6">
          {MAPS.map((m, i) => {
            const on = hover === m.id
            return (
              <button
                key={m.id}
                type="button"
                onMouseEnter={() => setHover(m.id)}
                onMouseLeave={() => setHover((h) => (h === m.id ? null : h))}
                onFocus={() => setHover(m.id)}
                onClick={() => {
                  menuTick('pick')
                  onPick(m.id)
                }}
                className="group relative bg-[#faf7ef] p-2 pb-3 text-left transition-transform duration-150 outline-none"
                style={{
                  transform: `rotate(${[-1.6, 0.9, -0.8][i % 3]}deg) translateY(${on ? -4 : 0}px)`,
                  boxShadow: on
                    ? `0 10px 18px rgba(40,30,20,0.35), 0 0 0 3px ${MARK}`
                    : '0 4px 9px rgba(40,30,20,0.28)',
                }}
              >
                {/* the pin */}
                <span
                  aria-hidden
                  className="absolute -top-2 left-1/2 h-3.5 w-3.5 -translate-x-1/2 rounded-full"
                  style={{ background: ['#c0705c', '#5f8fb0', '#c9a23a'][i % 3], boxShadow: '0 2px 2px rgba(0,0,0,0.35)' }}
                />
                <div className="relative aspect-[16/10] w-full overflow-hidden bg-stone-800">
                  <img
                    src={pictureOf(m.id)}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover"
                    style={{ imageRendering: 'pixelated' }}
                  />
                  {m.id === here && (
                    <span
                      className="absolute top-1.5 right-1.5 px-1.5 py-[1px] font-mono text-[10px]"
                      style={{ background: 'rgba(238,226,196,0.92)', color: INK, transform: 'rotate(2deg)' }}
                    >
                      {tp.mapHere}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-baseline gap-2 px-0.5">
                  <span className="font-mono text-[11px]" style={{ color: INK_SOFT }}>
                    {i + 1}
                  </span>
                  <span className="font-display text-[22px] leading-none uppercase" style={{ color: INK }}>
                    {tp.mapNames[m.id]}
                  </span>
                </div>
                <p className="mt-1 px-0.5 font-mono text-[11px] leading-snug" style={{ color: INK_SOFT }}>
                  {tp.mapBlurbs[m.id]}
                </p>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
