import type { ReactNode } from 'react'

/*
  The real Windows XP icons, extracted from a clean SP2 install (shell32,
  winmine, mspaint, msmsgs and friends) and shipped as PNGs with their
  original alpha shadows. Each icon comes in two sizes: the 48px art for
  desktop and Explorer, and the hand-pixelled 16px version XP used in title
  bars and sidebars — downscaling the 48px art there would turn it to mush.

  Lives in its own module because Explorer renders icons at module top level
  while apps.tsx (the registry) imports Explorer; defining this inside
  apps.tsx would make that cycle crash on load.
*/
export const XP_ICON_NAMES = [
  'my-computer',
  'folder',
  'folder-open',
  'text-file',
  'image-file',
  'url',
  'ie',
  'messenger',
  'notepad',
  'cmd',
  'minesweeper',
  'paint',
  'display',
  'recycle-empty',
  'recycle-full',
  'exit',
  'hard-drive',
  'floppy',
  'cd-drive',
] as const

export type XpIconName = (typeof XP_ICON_NAMES)[number]

const XP_ICON_PIXEL_SIZES = [16, 48] as const

export const XP_ICON_URLS = XP_ICON_NAMES.flatMap((name) =>
  XP_ICON_PIXEL_SIZES.map((size) => xpIconSrc(name, size)),
)

let preloadPromise: Promise<void> | null = null

export function xpIconSrc(name: XpIconName, size: number): string {
  return size <= 16 ? `/os/icons/${name}-16.png` : `/os/icons/${name}.png`
}

function loadAndDecodeImage(src: string): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve()

  return new Promise((resolve) => {
    const img = new Image()
    let settled = false

    const finish = (decode: boolean) => {
      if (settled) return
      settled = true

      if (!decode || img.naturalWidth === 0) {
        resolve()
        return
      }

      if (typeof img.decode !== 'function') {
        resolve()
        return
      }

      img.decode().catch(() => undefined).then(resolve)
    }

    img.decoding = 'async'
    img.onload = () => finish(true)
    img.onerror = () => finish(false)
    img.src = src

    if (img.complete) finish(true)
  })
}

export function preloadXpIcons(): Promise<void> {
  preloadPromise ??= Promise.all(XP_ICON_URLS.map(loadAndDecodeImage)).then(() => undefined)
  return preloadPromise
}

export function xpIcon(name: XpIconName, size: number): ReactNode {
  const src = xpIconSrc(name, size)
  return <img src={src} width={size} height={size} alt="" draggable={false} className="select-none" />
}
