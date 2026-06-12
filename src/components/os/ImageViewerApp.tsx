import { useEffect, useState } from 'react'
import { sounds } from './sounds'
import { baseName, getNode } from './fs'
import { WALLPAPERS, setWallpaper } from './wallpapers'

/*
  Windows Picture and Fax Viewer, more or less: dark stage, the image fit to
  the window, name and natural size in the status bar. If the picture happens
  to be one of the registered wallpapers there is a one-click "Set as
  wallpaper", which is the kind of loop a real OS would let you close.
*/

interface ViewerProps {
  path?: string
  setTitle: (t: string) => void
}

export function ImageViewerApp({ path, setTitle }: ViewerProps) {
  const node = path ? getNode(path) : null
  const name = path ? baseName(path) : ''
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    setTitle(`${name || 'Image'} - Viewer`)
  }, [name, setTitle])

  if (!node?.src) {
    return (
      <div className="flex h-full items-center justify-center bg-stone-900">
        <p className="text-xs text-stone-500">This picture is missing.</p>
      </div>
    )
  }

  const wallpaper = WALLPAPERS.find((w) => w.src === node.src)

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-stone-900 p-3">
        <img
          src={node.src}
          alt={name}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="max-h-full max-w-full rounded-sm object-contain shadow-lg shadow-stone-950/60"
        />
      </div>
      <div className="flex items-center gap-3 border-t border-stone-300 bg-stone-200 px-3 py-1.5 text-xs text-stone-500">
        <span className="truncate">{name}</span>
        {size && (
          <span className="shrink-0 tabular-nums">
            {size.w} × {size.h}
          </span>
        )}
        {wallpaper && (
          <button
            type="button"
            onClick={() => {
              sounds.open()
              setWallpaper(wallpaper.id)
            }}
            className="ml-auto shrink-0 cursor-pointer rounded-sm border border-stone-400 bg-stone-100 px-2.5 py-0.5 text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
          >
            Set as wallpaper
          </button>
        )}
      </div>
    </div>
  )
}
