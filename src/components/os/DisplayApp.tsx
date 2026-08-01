import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { sounds } from './sounds'
import {
  WALLPAPERS,
  getWallpaperId,
  setWallpaper,
  subscribeWallpaper,
  wallpaperById,
} from './wallpapers'
import { DELAYS, SAVERS, getSaver, runSaver, setSaver, subscribeSaver } from './screensaver'
import type { SaverId } from './screensaver'

/*
  Display Properties: pick a wallpaper on a little preview monitor, then
  Apply/OK like it's 2003. Selection is local until applied so Cancel
  really cancels.

  The Screen Saver tab shares that monitor, and previews into it for real —
  the same runSaver the desktop uses, on a canvas the size of a postage
  stamp. A still thumbnail would have been half the code and none of the
  point: the reason this tab existed in the first place was to watch the
  thing move before committing to it.
*/

function thumbStyle(id: string): CSSProperties {
  const w = wallpaperById(id)
  return w.src
    ? { backgroundImage: `url(${w.src})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { backgroundColor: w.color }
}

const button =
  'cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-4 py-1 text-xs font-medium text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50 disabled:cursor-default disabled:opacity-50 disabled:hover:border-stone-400 disabled:hover:bg-stone-200'

const field =
  'cursor-pointer rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs text-stone-800 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)] hover:border-blue-600'

/** the beige monitor both tabs preview inside */
function PreviewMonitor({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center border-b border-stone-300 bg-stone-200/60 py-4">
      <div className="w-52">
        <div className="rounded-lg bg-stone-300 p-2 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_4px_10px_rgba(0,0,0,0.15)]">
          <div className="aspect-[4/3] w-full overflow-hidden rounded-sm border border-stone-400 bg-stone-950">
            {children}
          </div>
        </div>
        <div className="mx-auto h-2 w-10 bg-stone-300" />
        <div className="mx-auto h-1.5 w-20 rounded-sm bg-stone-300" />
      </div>
    </div>
  )
}

function SaverPreview({ id }: { id: SaverId }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current || id === 'none') return
    return runSaver(ref.current, id)
  }, [id])
  if (id === 'none') return <div className="size-full bg-stone-950" />
  return <canvas ref={ref} className="block size-full" />
}

export function DisplayApp({ close }: { close: () => void }) {
  const applied = useSyncExternalStore(subscribeWallpaper, getWallpaperId)
  const saver = useSyncExternalStore(subscribeSaver, getSaver)
  const [tab, setTab] = useState<'desktop' | 'saver'>('desktop')
  const [picked, setPicked] = useState(applied)

  const apply = () => {
    sounds.open()
    setWallpaper(picked)
  }

  return (
    <div className="flex h-full flex-col bg-stone-100">
      <div className="flex shrink-0 gap-1 border-b border-stone-300 bg-stone-200 px-2 pt-2">
        {(
          [
            ['desktop', 'Desktop'],
            ['saver', 'Screen Saver'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              sounds.click()
              setTab(id)
            }}
            className={`cursor-pointer rounded-t-sm border border-b-0 px-3 py-1 text-xs ${
              tab === id
                ? 'border-stone-300 bg-stone-100 text-stone-800'
                : 'border-transparent text-stone-500 hover:text-stone-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <PreviewMonitor>
        {tab === 'desktop' ? (
          <div className="size-full bg-cover bg-center" style={thumbStyle(picked)} />
        ) : (
          <SaverPreview id={saver.id} />
        )}
      </PreviewMonitor>

      {tab === 'desktop' ? (
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
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <label className="mb-1 block text-xs text-stone-600" htmlFor="saver-pick">
            Screen saver
          </label>
          <select
            id="saver-pick"
            value={saver.id}
            onChange={(e) => {
              sounds.click()
              setSaver({ id: e.target.value as SaverId })
            }}
            className={`${field} w-full appearance-none`}
          >
            {SAVERS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <div className="mt-3 flex items-center gap-2">
            <label className="text-xs text-stone-600" htmlFor="saver-wait">
              Wait
            </label>
            <select
              id="saver-wait"
              value={saver.delay}
              disabled={saver.id === 'none'}
              onChange={(e) => {
                sounds.click()
                setSaver({ delay: Number(e.target.value) })
              }}
              className={`${field} appearance-none disabled:cursor-default disabled:opacity-50`}
            >
              {DELAYS.map((d) => (
                <option key={d} value={d}>
                  {d} minutes
                </option>
              ))}
            </select>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            The saver takes over the screen when nobody touches the machine for that long. Move the
            mouse or press a key to come back. It stays off entirely if your system asks for reduced
            motion.
          </p>
        </div>
      )}

      <div className="flex shrink-0 justify-end gap-2 border-t border-stone-300 bg-stone-200 px-3 py-2">
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
