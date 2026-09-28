/*
  The camera's photographs, held in memory.

  A small subscribable store (the same shape as sounds.ts and screensaver.ts:
  no global state library, `useSyncExternalStore` on the React side) between
  the scene, which takes the pictures, and PhotoCamera.tsx, which shows the
  viewfinder and the strip of the last few.

  **How a photograph is taken** is the one subtle thing here. The game draws
  through the pixel look into a WebGL canvas that is created without
  `preserveDrawingBuffer`, so the picture is only in it until the browser
  composites the frame; ask for it a task later and you get a blank
  rectangle. `capture` is therefore called by CrtScene straight after the
  render that follows the click, in the same task, and copies the canvas into
  a 2D canvas synchronously with `drawImage` (the canvas is not tainted, and
  nothing about the copy is asynchronous). That copy is then encoded to a PNG
  blob at leisure. Nothing needs `preserveDrawingBuffer`, which would cost the
  whole game a copy per frame. The HUD, the console and the viewfinder are DOM
  above the canvas, so they are not in the picture, and the first-person gun
  is not drawn while the camera is in hand.

  The last MAX photographs are kept as blobs behind object URLs (each dropped
  and revoked when it falls off the end). `save` and `copy` act on the newest:
  the pointer is locked on foot, so the strip's buttons only work on the pause
  sheet, and the keys (bindings.ts's photoSave and photoCopy) do the same
  thing from the walk.
*/

export interface Photo {
  id: number
  /** performance.now() when taken */
  at: number
  w: number
  h: number
  /** an object URL of the PNG, once encoded ('' until then) */
  url: string
  blob: Blob | null
  /** the PNG's size in bytes (0 until encoded) */
  bytes: number
}

export type PhotoNote = 'saved' | 'copied' | 'copyFailed' | 'nothing'

export interface PhotoState {
  /** the camera is in hand: the viewfinder is up */
  held: boolean
  /** the lens's zoom right now, 1 up */
  zoom: number
  photos: readonly Photo[]
  /** counts shutters, so the flash restarts on each */
  shutters: number
  /** the last thing save or copy said, and a serial to show it again */
  note: { what: PhotoNote; n: number } | null
}

/** photographs kept */
export const MAX_PHOTOS = 6

let state: PhotoState = { held: false, zoom: 1, photos: [], shutters: 0, note: null }
let noteN = 0
let seq = 0
const subs = new Set<() => void>()

const set = (patch: Partial<PhotoState>) => {
  state = { ...state, ...patch }
  for (const fn of subs) fn()
}

export const photoStore = {
  subscribe: (fn: () => void) => {
    subs.add(fn)
    return () => {
      subs.delete(fn)
    }
  },
  get: () => state,

  setHeld: (held: boolean) => {
    if (state.held !== held) set({ held })
  },
  setZoom: (zoom: number) => {
    // the readout shows tenths: no need to wake React for less
    if (Math.abs(zoom - state.zoom) >= 0.05 || (zoom === 1) !== (state.zoom === 1)) set({ zoom })
  },

  /**
   * Copy the canvas *now* (call it straight after the render, in the same
   * task) and encode it. Returns the photo at once; its `url` fills in when
   * the PNG is ready.
   */
  capture: (canvas: HTMLCanvasElement): Photo | null => {
    if (typeof document === 'undefined' || canvas.width < 2 || canvas.height < 2) return null
    const copy = document.createElement('canvas')
    copy.width = canvas.width
    copy.height = canvas.height
    const ctx = copy.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(canvas, 0, 0)
    const photo: Photo = { id: ++seq, at: performance.now(), w: copy.width, h: copy.height, url: '', blob: null, bytes: 0 }
    const photos = [photo, ...state.photos]
    for (const old of photos.splice(MAX_PHOTOS)) if (old.url) URL.revokeObjectURL(old.url)
    set({ photos, shutters: state.shutters + 1 })
    copy.toBlob((blob) => {
      if (!blob) return
      photo.blob = blob
      photo.bytes = blob.size
      photo.url = URL.createObjectURL(blob)
      // a photo that already fell off the end is not kept
      if (state.photos.includes(photo)) set({ photos: [...state.photos] })
      else URL.revokeObjectURL(photo.url)
    }, 'image/png')
    return photo
  },

  /** the PNG of a photograph (the newest by default), downloaded */
  save: (id?: number): boolean => {
    const p = state.photos.find((q) => q.blob && (id === undefined || q.id === id))
    if (!p?.url) {
      set({ note: { what: 'nothing', n: ++noteN } })
      return false
    }
    const a = document.createElement('a')
    a.href = p.url
    a.download = `alejos-photo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    set({ note: { what: 'saved', n: ++noteN } })
    return true
  },

  /** a photograph (the newest by default) on the clipboard as an image */
  copy: async (id?: number): Promise<boolean> => {
    const p = state.photos.find((q) => q.blob && (id === undefined || q.id === id))
    if (!p?.blob) {
      set({ note: { what: 'nothing', n: ++noteN } })
      return false
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': p.blob })])
      set({ note: { what: 'copied', n: ++noteN } })
      return true
    } catch {
      set({ note: { what: 'copyFailed', n: ++noteN } })
      return false
    }
  },

  /** forget them all (a harness, or leaving the world) */
  clear: () => {
    for (const p of state.photos) if (p.url) URL.revokeObjectURL(p.url)
    set({ photos: [] })
  },
}
