import { useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { sounds } from './sounds'
import {
  WALLPAPERS,
  getWallpaperId,
  setWallpaper,
  subscribeWallpaper,
  wallpaperById,
} from './wallpapers'

/*
  Display Properties: pick a wallpaper on a little preview monitor, then
  Apply/OK like it's 2003. Selection is local until applied so Cancel
  really cancels.
*/

function thumbStyle(id: string): CSSProperties {
  const w = wallpaperById(id)
  return w.src
    ? { backgroundImage: `url(${w.src})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { backgroundColor: w.color }
}

export function DisplayApp({ close }: { close: () => void }) {
  const applied = useSyncExternalStore(subscribeWallpaper, getWallpaperId)
  const [picked, setPicked] = useState(applied)

  const apply = () => {
    sounds.open()
    setWallpaper(picked)
  }

  const button =
    'cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-4 py-1 text-xs font-medium text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50 disabled:cursor-default disabled:opacity-50 disabled:hover:border-stone-400 disabled:hover:bg-stone-200'

  return (
    <div className="flex h-full flex-col bg-stone-100">
      {/* preview monitor */}
      <div className="flex justify-center border-b border-stone-300 bg-stone-200/60 py-4">
        <div className="w-52">
          <div className="rounded-lg bg-stone-300 p-2 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_4px_10px_rgba(0,0,0,0.15)]">
            <div
              className="aspect-[4/3] w-full rounded-sm border border-stone-400 bg-stone-950"
              style={thumbStyle(picked)}
            />
          </div>
          <div className="mx-auto h-2 w-10 bg-stone-300" />
          <div className="mx-auto h-1.5 w-20 rounded-sm bg-stone-300" />
        </div>
      </div>

      {/* wallpaper list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-2 text-xs text-stone-600">Wallpaper</p>
        <div className="grid grid-cols-3 gap-2">
          {WALLPAPERS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => {
                sounds.click()
                setPicked(w.id)
              }}
              className={`cursor-pointer rounded-sm border p-1 text-left transition ${
                picked === w.id
                  ? 'border-blue-600 bg-blue-600/10'
                  : 'border-stone-300 hover:border-stone-400'
              }`}
            >
              <span
                className="block aspect-[3/2] w-full rounded-[2px] border border-stone-300"
                style={thumbStyle(w.id)}
              />
              <span className="mt-1 block truncate text-[11px] text-stone-700">{w.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* dialog buttons */}
      <div className="flex justify-end gap-2 border-t border-stone-300 bg-stone-200 px-3 py-2">
        <button
          type="button"
          className={button}
          onClick={() => {
            apply()
            close()
          }}
        >
          OK
        </button>
        <button
          type="button"
          className={button}
          onClick={() => {
            sounds.click()
            close()
          }}
        >
          Cancel
        </button>
        <button type="button" className={button} disabled={picked === applied} onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  )
}
