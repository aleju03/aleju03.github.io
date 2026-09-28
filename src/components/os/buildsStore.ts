import type { Session } from './osContext'
import {
  buildNotices, clipboard, setBuildsBackend,
  type BuildsBackend, type PublishResult, type SlotInfo,
} from '../../game/sandbox/blueprint/clipboard'
import type { Blueprint } from '../../game/sandbox/blueprint/blueprint'

/*
  Everything the builds book remembers and everything it asks the server.

  Three things live here, all on the React side because they reach for
  IndexedDB, the DOM and `fetch` (the runtime stays headless):

  **The local slots.** Named blueprints, up to fifty, kept as their share
  code (the same text you would paste to a friend, so what is stored, what
  is shared and what the server keeps are one format) beside a small picture
  and the prop count. Storage is IndexedDB, falling back to localStorage,
  falling back to memory for the length of the visit: every read and write is
  in a try, a private window or a blocked-storage browser simply has slots
  that last until the tab closes, and nothing else changes. The list is a
  subscribable snapshot so the panel and the console commands agree.

  **The gallery.** The public list of published builds is REST on the chat
  server (`server/src/builds.js`), derived from `VITE_CHAT_URL` like the
  analytics endpoint, so with no server configured the gallery is simply
  absent and everything local still works. Browsing needs no account;
  publishing and deleting carry the session's token as a bearer.

  **The seams to the scene.** `bind` is how CrtScene hands over the two
  things only it can do (put a blueprint down where the crosshair is, bring
  the book up), and `notices` re-exports the game's line to the player. The
  blueprint modules themselves (the share code, the thumbnail renderer) are
  imported on first use, so the eager scene chunk does not carry the kind
  table.
*/

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined
const MAX_SLOTS = 50

/** the gallery's base URL, or null when there is no server */
const galleryBase = (): string | null => {
  if (!CHAT_URL) return null
  try {
    const url = new URL(CHAT_URL)
    url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'
    url.pathname = '/builds'
    url.search = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}
export const galleryAvailable = () => galleryBase() !== null

/* ------------------------------------------------------------- storage -- */

interface Row {
  name: string
  code: string
  thumb: string | null
  props: number
  at: number
}
interface Kv {
  all: () => Promise<Row[]>
  put: (row: Row) => Promise<void>
  del: (name: string) => Promise<void>
}

const idbKv = (): Promise<Kv> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no idb'))
    const open = indexedDB.open('alejos-builds', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('slots', { keyPath: 'name' })
    open.onerror = () => reject(open.error ?? new Error('idb'))
    open.onblocked = () => reject(new Error('idb blocked'))
    open.onsuccess = () => {
      const db = open.result
      const run = <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) =>
        new Promise<T>((res, rej) => {
          const tx = db.transaction('slots', mode)
          const req = f(tx.objectStore('slots'))
          tx.oncomplete = () => res(req.result)
          tx.onerror = tx.onabort = () => rej(tx.error ?? new Error('idb tx'))
        })
      resolve({
        all: () => run('readonly', (s) => s.getAll() as IDBRequest<Row[]>),
        put: async (row) => void (await run('readwrite', (s) => s.put(row))),
        del: async (name) => void (await run('readwrite', (s) => s.delete(name))),
      })
    }
  })

const LS_KEY = 'alejos-builds'
const lsKv = (): Kv => {
  const read = (): Row[] => {
    const raw = localStorage.getItem(LS_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v : []
  }
  // proves it works before it is chosen (quota, blocked storage)
  localStorage.setItem(LS_KEY + '-probe', '1')
  localStorage.removeItem(LS_KEY + '-probe')
  return {
    all: async () => read(),
    put: async (row) => localStorage.setItem(LS_KEY, JSON.stringify([...read().filter((r) => r.name !== row.name), row])),
    del: async (name) => localStorage.setItem(LS_KEY, JSON.stringify(read().filter((r) => r.name !== name))),
  }
}

const memKv = (): Kv => {
  const m = new Map<string, Row>()
  return {
    all: async () => [...m.values()],
    put: async (row) => void m.set(row.name, row),
    del: async (name) => void m.delete(name),
  }
}

let kvPromise: Promise<Kv> | null = null
const kv = (): Promise<Kv> =>
  (kvPromise ??= idbKv().catch(() => {
    try {
      return lsKv()
    } catch {
      return memKv()
    }
  }))

/* --------------------------------------------------------------- state -- */

interface Bound {
  session: () => Session | null | undefined
  /** set a blueprint down where the crosshair is (scene) */
  paste: (bp: Blueprint) => boolean
  /** bring the book up on its builds tab (scene) */
  open: () => void
}
let bound: Bound | null = null

let slotList: SlotInfo[] = []
let loaded = false
let tabRequests = 0
const subs = new Set<() => void>()
const emit = () => {
  for (const f of subs) f()
}
const info = (r: Row): SlotInfo => ({ name: r.name, props: r.props, at: r.at, thumb: r.thumb })

const refresh = async (): Promise<SlotInfo[]> => {
  try {
    const rows = await (await kv()).all()
    slotList = rows.sort((a, b) => b.at - a.at).map(info)
  } catch {
    /* keep what we have */
  }
  loaded = true
  emit()
  return slotList
}

const codeMod = () => import('../../game/sandbox/blueprint/code')

const note = (tone: 'ok' | 'err', en: string, es: string) => buildNotices.emit({ tone, en, es })

/* ------------------------------------------------------------ the slots -- */

export const errorText = (code: string): { en: string; es: string } => {
  switch (code) {
    case 'empty': return { en: 'paste a code first', es: 'pega un código primero' }
    case 'prefix': return { en: 'that is not a build code (it starts BP1.)', es: 'eso no es un código de construcción (empieza con BP1.)' }
    case 'toolong': case 'toobig': return { en: 'that code is too big', es: 'ese código es demasiado grande' }
    case 'base64': case 'inflate': case 'json': case 'shape': return { en: 'that code is damaged', es: 'ese código está dañado' }
    case 'version': return { en: 'that code is from a newer version', es: 'ese código es de una versión más nueva' }
    case 'kind': return { en: 'it uses a prop this version does not have', es: 'usa un objeto que esta versión no tiene' }
    case 'props': return { en: 'a build holds 1 to 300 props', es: 'una construcción tiene de 1 a 300 objetos' }
    case 'joints': case 'number': return { en: 'that code has values out of range', es: 'ese código tiene valores fuera de rango' }
    case 'login': return { en: 'log in with an account to publish', es: 'inicia sesión con una cuenta para publicar' }
    case 'rate': return { en: 'slow down, try again in a minute', es: 'más despacio, prueba en un minuto' }
    case 'limit': return { en: 'you already have 20 published builds', es: 'ya tienes 20 construcciones publicadas' }
    case 'name': return { en: 'give it a name', es: 'ponle un nombre' }
    case 'code': return { en: 'the server did not accept that build', es: 'el servidor no aceptó esa construcción' }
    case 'thumb': return { en: 'the picture was too big', es: 'la imagen era demasiado grande' }
    case 'too_large': return { en: 'that build is too big to publish', es: 'esa construcción es demasiado grande para publicar' }
    case 'forbidden': return { en: 'that one is not yours', es: 'esa no es tuya' }
    case 'not_found': return { en: 'it is gone', es: 'ya no existe' }
    case 'offline': return { en: 'the gallery is not reachable', es: 'no se puede llegar a la galería' }
    default: return { en: 'that did not work', es: 'eso no funcionó' }
  }
}

const save = async (bp: Blueprint, thumb?: string | null): Promise<boolean> => {
  try {
    const { encodeBlueprint, cleanName } = await codeMod()
    const name = cleanName(bp.name)
    if (!name) return false
    const store = await kv()
    const rows = await store.all()
    if (!rows.some((r) => r.name === name) && rows.length >= MAX_SLOTS) return false
    let pic = thumb
    if (pic === undefined) {
      try {
        pic = await (await import('../../game/sandbox/blueprint/thumb')).blueprintThumb(bp)
      } catch {
        pic = null
      }
    }
    await store.put({ name, code: await encodeBlueprint({ ...bp, name }), thumb: pic ?? null, props: bp.props.length, at: Date.now() })
    await refresh()
    return true
  } catch {
    return false
  }
}

const load = async (name: string): Promise<Blueprint | null> => {
  try {
    const row = (await (await kv()).all()).find((r) => r.name === name)
    if (!row) return null
    const { decodeBlueprint } = await codeMod()
    const bp = await decodeBlueprint(row.code)
    return { ...bp, name: row.name }
  } catch {
    return null
  }
}

const remove = async (name: string): Promise<boolean> => {
  try {
    const store = await kv()
    if (!(await store.all()).some((r) => r.name === name)) return false
    await store.del(name)
    await refresh()
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------- gallery -- */

export interface GalleryEntry {
  id: number
  name: string
  author: string
  props: number
  spawns: number
  at: number
  thumb: string
}
export interface GalleryPage {
  builds: GalleryEntry[]
  total: number
  page: number
  size: number
}
type Failure = { ok: false; error: string }

const call = async <T,>(path: string, init?: RequestInit): Promise<({ ok: true } & T) | Failure> => {
  const base = galleryBase()
  if (!base) return { ok: false, error: 'offline' }
  try {
    const res = await fetch(base + path, init)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: typeof body.error === 'string' ? body.error : 'offline' }
    return { ok: true, ...body }
  } catch {
    return { ok: false, error: 'offline' }
  }
}
const auth = (): HeadersInit => {
  const s = bound?.session()
  return s?.kind === 'user' && s.token ? { authorization: `Bearer ${s.token}` } : {}
}

export const gallery = {
  list: (sort: 'new' | 'top', page: number) =>
    call<GalleryPage>(`?sort=${sort}&page=${page}`),
  /** the build with its code, decoded */
  pull: async (id: number): Promise<{ ok: true; bp: Blueprint; code: string } | Failure> => {
    const r = await call<{ code: string; name: string }>(`/${id}`)
    if (!r.ok) return r
    try {
      const { decodeBlueprint } = await codeMod()
      const bp = await decodeBlueprint(r.code)
      return { ok: true, bp: { ...bp, name: r.name }, code: r.code }
    } catch (e) {
      return { ok: false, error: (e as { code?: string }).code ?? 'shape' }
    }
  },
  remove: (id: number) => call<{ ok: true }>(`/${id}`, { method: 'DELETE', headers: auth() }),
  /** may this session delete this entry */
  mayDelete: (e: GalleryEntry) => {
    const s = bound?.session()
    return s?.kind === 'user' && (!!s.admin || s.name.toLowerCase() === e.author)
  },
  canPublish: () => {
    const s = bound?.session()
    return s?.kind === 'user' && !!s.token
  },
}

const publish = async (name: string): Promise<PublishResult> => {
  if (!galleryAvailable()) return { ok: false, reason: errorText('offline') }
  if (!gallery.canPublish()) return { ok: false, reason: errorText('login') }
  const row = (await (await kv()).all()).find((r) => r.name === name)
  if (!row) return { ok: false, reason: { en: `no build called "${name}"`, es: `no hay construcción llamada "${name}"` } }
  const r = await call<{ id: number }>('', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify({ name: row.name, code: row.code, thumb: row.thumb ?? '' }),
  })
  return r.ok ? { ok: true } : { ok: false, reason: errorText(r.error) }
}

/* -------------------------------------------------------------- the api -- */

export const builds = {
  bind: (b: Bound) => {
    bound = b
  },
  subscribe: (f: () => void) => {
    subs.add(f)
    return () => subs.delete(f)
  },
  /** the current slots (empty until `refresh` has landed once) */
  slots: (): readonly SlotInfo[] => slotList,
  loaded: () => loaded,
  refresh,
  save,
  load,
  remove,
  publish,
  /** put a saved build in the clipboard, for the tool gun's paste mode */
  take: async (name: string) => {
    const bp = await load(name)
    if (!bp) return false
    clipboard.set(bp)
    note('ok', `"${name}" is in your hands: tool gun, paste mode`, `"${name}" está en tus manos: pistola, modo pegar`)
    return true
  },
  /** put a saved build down where the crosshair is */
  spawn: async (name: string) => {
    const bp = await load(name)
    if (!bp) return false
    clipboard.set(bp)
    return bound?.paste(bp) ?? false
  },
  spawnBlueprint: (bp: Blueprint) => {
    clipboard.set(bp)
    return bound?.paste(bp) ?? false
  },
  takeBlueprint: (bp: Blueprint) => clipboard.set(bp),
  /** a slot's share code */
  code: async (name: string): Promise<string | null> => {
    try {
      return (await (await kv()).all()).find((r) => r.name === name)?.code ?? null
    } catch {
      return null
    }
  },
  /** the clipboard's share code */
  clipboardCode: async (): Promise<string | null> => {
    const bp = clipboard.get()
    if (!bp) return null
    return (await codeMod()).encodeBlueprint(bp)
  },
  /** a pasted code to a blueprint, or the reason it is refused */
  parse: async (text: string): Promise<{ ok: true; bp: Blueprint } | Failure> => {
    try {
      return { ok: true, bp: await (await codeMod()).decodeBlueprint(text) }
    } catch (e) {
      return { ok: false, error: (e as { code?: string }).code ?? 'shape' }
    }
  },
  /** the book asks to be brought up on this tab */
  showTab: () => {
    tabRequests++
    emit()
    bound?.open()
  },
  tabRequests: () => tabRequests,
  note,
}

const backend: BuildsBackend = {
  list: () => refresh(),
  save: (bp) => save(bp),
  load,
  remove,
  publish,
  open: () => builds.showTab(),
}
setBuildsBackend(backend)
