import type { Blueprint } from './blueprint'

/*
  The duplicator's clipboard and the seam to everything that persists.

  Two small pieces of module state, both plain data. The clipboard is the
  blueprint the tool gun's paste mode is holding (set by its copy mode, by
  `/load`, or by the builds panel's "take"), a subscribable one-slot store so
  the readout on the gun and the panel agree without either importing the
  other. The backend is what saves and publishes: the runtime cannot know
  about IndexedDB or a fetch (it stays headless), so the React side installs
  one (components/os/buildsStore.ts) and the console commands ask for it here.
  With none installed the commands say saving is unavailable and everything
  else still works.
*/

let held: Blueprint | null = null
const subs = new Set<() => void>()
export const clipboard = {
  get: (): Blueprint | null => held,
  set: (bp: Blueprint | null) => {
    held = bp
    for (const fn of subs) fn()
  },
  subscribe: (fn: () => void) => {
    subs.add(fn)
    return () => subs.delete(fn)
  },
}

export interface SlotInfo {
  name: string
  props: number
  at: number
  /** a small png data url, if one could be drawn */
  thumb: string | null
}
export type PublishResult = { ok: true } | { ok: false; reason: { en: string; es: string } }

export interface BuildsBackend {
  list: () => Promise<SlotInfo[]>
  /** false when it could not be kept (storage refused, too many slots) */
  save: (bp: Blueprint) => Promise<boolean>
  load: (name: string) => Promise<Blueprint | null>
  remove: (name: string) => Promise<boolean>
  publish: (name: string) => Promise<PublishResult>
  /** bring the panel up (`/builds`) */
  open?: () => void
}

/*
  A line for the player: what a copy, a paste or a save has to say (a build
  too big, no room under the prop cap, saved as NAME). The runtime does not
  know where it is printed; the scene subscribes and puts it in the feed.
*/
export interface BuildNotice {
  tone: 'ok' | 'err'
  en: string
  es: string
}
const listeners = new Set<(n: BuildNotice) => void>()
export const buildNotices = {
  emit: (n: BuildNotice) => {
    for (const fn of listeners) fn(n)
  },
  subscribe: (fn: (n: BuildNotice) => void) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

let backend: BuildsBackend | null = null
export const setBuildsBackend = (b: BuildsBackend | null) => {
  backend = b
}
export const buildsBackend = () => backend
