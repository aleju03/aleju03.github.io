/*
  AlejOS wallpaper registry + a tiny external store so the Display Properties
  app and the desktop can share the selection without prop drilling. Persisted
  in localStorage, read with useSyncExternalStore from AlejOS.
*/

export interface Wallpaper {
  id: string
  name: string
  /** image wallpapers */
  src?: string
  /** solid-color wallpapers, era classic */
  color?: string
}

export const WALLPAPERS: Wallpaper[] = [
  { id: 'daybreak', name: 'Daybreak', src: '/os/wallpaper.webp' },
  { id: 'hillside', name: 'Hillside', src: '/os/wallpapers/hillside.webp' },
  { id: 'dusk', name: 'Dusk', src: '/os/wallpapers/dusk.webp' },
  { id: 'night', name: 'Night', src: '/os/wallpapers/night.webp' },
  { id: 'teal', name: 'Classic Teal', color: '#1d7a74' },
]

const KEY = 'alejos-wallpaper'

function readStored(): string {
  try {
    const v = localStorage.getItem(KEY)
    if (v && WALLPAPERS.some((w) => w.id === v)) return v
  } catch {
    /* storage unavailable */
  }
  return WALLPAPERS[0].id
}

let current = readStored()
const subs = new Set<() => void>()

export function getWallpaperId(): string {
  return current
}

export function wallpaperById(id: string): Wallpaper {
  return WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0]
}

export function setWallpaper(id: string) {
  if (id === current || !WALLPAPERS.some((w) => w.id === id)) return
  current = id
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* storage unavailable */
  }
  subs.forEach((fn) => fn())
}

export function subscribeWallpaper(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}
