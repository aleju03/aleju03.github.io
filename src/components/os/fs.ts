import { showcase, secondary, more, github, linkedin, email } from '../../data/projects'
import { WALLPAPERS } from './wallpapers'

/*
  The AlejOS virtual filesystem. One in-memory tree rooted at C:\ (plus a
  Recycle Bin root) that every app shares: Explorer browses it, Notepad reads
  and writes it, Paint saves into it, the desktop renders C:\Desktop from it.
  System nodes are generated from the real portfolio data and are read-only,
  XP style ("Access is denied"). Anything the visitor creates is overlaid on
  top and persisted to localStorage, so their files survive a reboot.
  Components subscribe with useSyncExternalStore via subscribeFs/getFsVersion.
*/

export type FsKind = 'folder' | 'text' | 'image' | 'app' | 'link'

export interface FsNode {
  name: string
  kind: FsKind
  /** text file body */
  content?: string
  /** image source: a url or a data url for Paint saves */
  src?: string
  /** app shortcuts: which app to launch, with optional window props */
  app?: string
  appProps?: Record<string, unknown>
  /** links: destination url; embed means "open in the AlejOS browser" */
  url?: string
  embed?: boolean
  /** folders may carry a custom desktop icon (the Games folder's joystick) */
  icon?: string
  /** read-only: ships with the OS, cannot be renamed/deleted/edited */
  system?: boolean
  /** created by the visitor; these persist to localStorage */
  user?: boolean
  /** where a recycled node used to live, so Restore knows the way back */
  origin?: string
  modified: number
  children?: FsNode[]
}

export const DESKTOP = 'C:\\Desktop'
export const RECYCLE_BIN = 'Recycle Bin'
/** the My Computer drives view; not a real folder */
export const MY_COMPUTER = ''

// a believable install date for everything that ships with the OS
const SYSTEM_TIME = new Date('2003-04-21T09:03:00').getTime()

const folder = (name: string, children: FsNode[] = [], system = true): FsNode => ({
  name,
  kind: 'folder',
  system,
  modified: SYSTEM_TIME,
  children,
})

const text = (name: string, content: string): FsNode => ({
  name,
  kind: 'text',
  system: true,
  content,
  modified: SYSTEM_TIME,
})

const image = (name: string, src: string): FsNode => ({
  name,
  kind: 'image',
  system: true,
  src,
  modified: SYSTEM_TIME,
})

const appShortcut = (name: string, app: string, appProps?: Record<string, unknown>): FsNode => ({
  name,
  kind: 'app',
  system: true,
  app,
  appProps,
  modified: SYSTEM_TIME,
})

const link = (name: string, url: string, embed = false): FsNode => ({
  name,
  kind: 'link',
  system: true,
  url,
  embed,
  modified: SYSTEM_TIME,
})

// ---------------------------------------------------------------- system tree

const ABOUT_TXT = `Alejandro Jiménez
full-stack developer, Costa Rica

I build web apps end to end: React frontends, Node
backends, and the server they run on. I deploy on
Vercel for frontends and run my own server for the
always-on pieces.

stack
  react · typescript · node · python · docker · caddy

languages
  spanish (factory default) · english (fluent)

links
  github   → ${github}
  linkedin → ${linkedin}
  email    → ${email}
`

const README_TXT = `Welcome to AlejOS.

This whole machine is my portfolio. Some places worth
a double click:

  C:\\Projects        every project, with readme + links
  C:\\Pictures        wallpapers (and whatever you paint)
  C:\\Program Files   the installed software

You can create folders and text files of your own:
right-click the desktop and try New. They survive a
reboot; they live in your browser, not on my server.

- aleju
`

interface AnyProject {
  name: string
  description: string
  tech?: string[]
  live?: string
  liveLabel?: string
  repo: string
  image?: string
  imageAlt?: string
}

const allProjects: AnyProject[] = [...showcase, ...secondary, ...more]

// the Games folder ships on the desktop AND in Program Files, XP style;
// fresh arrays each call so no node ends up in the tree twice
const gameShortcuts = (): FsNode[] => [
  appShortcut('Minesweeper', 'minesweeper'),
  appShortcut('Mine Duel', 'mineduel'),
  appShortcut('Pong', 'pong'),
  appShortcut('Snake', 'snake'),
  appShortcut('Memory Match', 'memory'),
  appShortcut('2048', '2048'),
  appShortcut('Whack-A-Mole', 'whack'),
  appShortcut('Flappy Bird', 'flappy'),
  appShortcut('Rhythm Keys', 'vsrg'),
]

function projectFolder(p: AnyProject): FsNode {
  const children: FsNode[] = [
    text(
      'readme.txt',
      `${p.name}\n${'-'.repeat(p.name.length)}\n\n${p.description}\n${
        p.tech ? `\nbuilt with: ${p.tech.join(', ')}\n` : ''
      }\nlinks\n${p.live ? `  live   → ${p.live}\n` : ''}  source → ${p.repo}\n`,
    ),
  ]
  if (p.live) children.push(link(`${p.liveLabel ?? p.name} (live)`, p.live, true))
  // github refuses frames, but the AlejOS browser renders its own page for it
  children.push(link('source code', p.repo, true))
  if (p.image) children.push(image('screenshot.png', p.image))
  return folder(p.name, children)
}

function buildSystemTree(): FsNode {
  return folder('C:', [
    folder('Desktop', [
      appShortcut('My Projects', 'explorer', { path: 'C:\\Projects' }),
      appShortcut('Internet Explorer', 'browser'),
      appShortcut('Chat Rooms', 'chat'),
      text('about.txt', ABOUT_TXT),
      appShortcut('Terminal', 'terminal'),
      { ...folder('Games', gameShortcuts()), icon: 'games' },
      appShortcut('Paint', 'paint'),
    ]),
    folder('Documents', [text('about.txt', ABOUT_TXT), text('readme.txt', README_TXT)]),
    folder('Pictures', [
      folder(
        'Wallpapers',
        WALLPAPERS.filter((w) => w.src).map((w) => image(`${w.id}.webp`, w.src as string)),
      ),
    ]),
    folder('Projects', allProjects.map(projectFolder)),
    folder('Program Files', [
      appShortcut('File Explorer', 'explorer', { path: 'C:' }),
      appShortcut('Internet Explorer', 'browser'),
      appShortcut('Chat Rooms', 'chat'),
      appShortcut('Notepad', 'notepad'),
      appShortcut('Paint', 'paint'),
      { ...folder('Games', gameShortcuts()), icon: 'games' },
      appShortcut('Terminal', 'terminal'),
      appShortcut('Display Properties', 'display'),
    ]),
    folder('Windows', [
      folder('system32', [
        text('hal.dll', 'I am afraid I cannot let you open that.'),
        text('boot.ini', '[boot loader]\ntimeout=3\ndefault=C:\\AlejOS\n'),
      ]),
      text(
        'win.ini',
        '[fonts]\nclash-display=portfolio\n\n[easter]\neggs=plenty\n; you found one\n',
      ),
    ]),
  ])
}

// ---------------------------------------------------------------- store

const root = buildSystemTree()
const bin = folder(RECYCLE_BIN, [], false)
bin.system = false

let version = 0
const subs = new Set<() => void>()

function bump() {
  version += 1
  persist()
  subs.forEach((fn) => fn())
}

export function subscribeFs(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function getFsVersion(): number {
  return version
}

// ---------------------------------------------------------------- paths

export function splitPath(path: string): string[] {
  return path.split('\\').filter(Boolean)
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}\\${name}` : name
}

export function parentPath(path: string): string {
  const segs = splitPath(path)
  segs.pop()
  return segs.join('\\')
}

export function baseName(path: string): string {
  const segs = splitPath(path)
  return segs[segs.length - 1] ?? ''
}

function rootOf(path: string): FsNode | null {
  const segs = splitPath(path)
  if (segs[0] === 'C:') return root
  if (segs[0] === RECYCLE_BIN) return bin
  return null
}

export function getNode(path: string): FsNode | null {
  const segs = splitPath(path)
  let node = rootOf(path)
  if (!node) return null
  for (const seg of segs.slice(1)) {
    node = node.children?.find((c) => c.name.toLowerCase() === seg.toLowerCase()) ?? null
    if (!node) return null
  }
  return node
}

export function listDir(path: string): FsNode[] {
  return getNode(path)?.children ?? []
}

export function isRecycled(path: string): boolean {
  return splitPath(path)[0] === RECYCLE_BIN
}

// ---------------------------------------------------------------- mutations

const VALID_NAME = /^[^\\/:*?"<>|]{1,80}$/

function uniqueName(dir: FsNode, wanted: string): string {
  const taken = new Set((dir.children ?? []).map((c) => c.name.toLowerCase()))
  if (!taken.has(wanted.toLowerCase())) return wanted
  const dot = wanted.lastIndexOf('.')
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted
  const ext = dot > 0 ? wanted.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export type FsResult = { ok: true; name: string } | { ok: false; error: string }

function writableDir(dirPath: string): FsNode | { error: string } {
  const dir = getNode(dirPath)
  if (!dir || dir.kind !== 'folder') return { error: 'The path does not exist.' }
  return dir
}

export function createNode(
  dirPath: string,
  node: Omit<FsNode, 'modified' | 'user' | 'system'> & { modified?: number },
): FsResult {
  const dir = writableDir(dirPath)
  if ('error' in dir) return { ok: false, error: dir.error }
  if (!VALID_NAME.test(node.name)) return { ok: false, error: 'That name is not allowed.' }
  const name = uniqueName(dir, node.name)
  dir.children ??= []
  dir.children.push({ ...node, name, user: true, system: false, modified: Date.now() })
  bump()
  return { ok: true, name }
}

export function createFolder(dirPath: string, name = 'New Folder'): FsResult {
  return createNode(dirPath, { name, kind: 'folder', children: [] })
}

export function createTextFile(dirPath: string, name = 'New Text Document.txt', content = ''): FsResult {
  return createNode(dirPath, { name, kind: 'text', content })
}

export function writeText(path: string, content: string): FsResult {
  const node = getNode(path)
  if (!node || node.kind !== 'text') return { ok: false, error: 'The file does not exist.' }
  if (node.system) return { ok: false, error: 'Access is denied. The file is read-only.' }
  node.content = content
  node.modified = Date.now()
  bump()
  return { ok: true, name: node.name }
}

export function writeImage(path: string, src: string): FsResult {
  const node = getNode(path)
  if (!node || node.kind !== 'image') return { ok: false, error: 'The file does not exist.' }
  if (node.system) return { ok: false, error: 'Access is denied. The file is read-only.' }
  node.src = src
  node.modified = Date.now()
  bump()
  return { ok: true, name: node.name }
}

export function renameNode(path: string, newName: string): FsResult {
  const node = getNode(path)
  const dir = getNode(parentPath(path))
  if (!node || !dir) return { ok: false, error: 'The file does not exist.' }
  if (node.system) return { ok: false, error: 'Access is denied.' }
  if (!VALID_NAME.test(newName)) return { ok: false, error: 'That name is not allowed.' }
  if (newName === node.name) return { ok: true, name: newName }
  const clash = dir.children?.some(
    (c) => c !== node && c.name.toLowerCase() === newName.toLowerCase(),
  )
  if (clash) return { ok: false, error: 'A file with that name already exists.' }
  node.name = newName
  node.modified = Date.now()
  bump()
  return { ok: true, name: newName }
}

/** delete: user files move to the Recycle Bin; from the bin they are gone */
export function removeNode(path: string): FsResult {
  const node = getNode(path)
  const dir = getNode(parentPath(path))
  if (!node || !dir?.children) return { ok: false, error: 'The file does not exist.' }
  if (node.system) return { ok: false, error: 'Access is denied.' }
  dir.children = dir.children.filter((c) => c !== node)
  if (!isRecycled(path)) {
    bin.children ??= []
    const name = uniqueName(bin, node.name)
    bin.children.push({ ...node, name, origin: parentPath(path), modified: Date.now() })
  }
  bump()
  return { ok: true, name: node.name }
}

export function restoreNode(path: string): FsResult {
  const node = getNode(path)
  if (!node || !isRecycled(path)) return { ok: false, error: 'The file does not exist.' }
  const home = getNode(node.origin ?? '') ?? getNode(DESKTOP)
  if (!home || home.kind !== 'folder') return { ok: false, error: 'The original folder is gone.' }
  bin.children = (bin.children ?? []).filter((c) => c !== node)
  const rest = { ...node, name: uniqueName(home, node.name) }
  delete rest.origin
  home.children ??= []
  home.children.push(rest)
  bump()
  return { ok: true, name: node.name }
}

export function emptyRecycleBin() {
  if ((bin.children ?? []).length === 0) return
  bin.children = []
  bump()
}

export function recycleBinCount(): number {
  return bin.children?.length ?? 0
}

export function sortChildren(path: string, by: 'name' | 'type' | 'modified') {
  const dir = getNode(path)
  if (!dir?.children) return
  const rank = (n: FsNode) => (n.kind === 'folder' ? 0 : 1)
  dir.children.sort((a, b) => {
    if (by === 'type') {
      const k = a.kind.localeCompare(b.kind)
      if (k !== 0) return k
    }
    if (by === 'modified') {
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      return a.modified - b.modified
    }
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  bump()
}

// ---------------------------------------------------------------- persistence

const STORE_KEY = 'alejos-fs'

interface StoredEntry {
  /** parent directory path */
  dir: string
  node: FsNode
}

function collectUserNodes(node: FsNode, path: string, out: StoredEntry[]) {
  for (const child of node.children ?? []) {
    const childPath = joinPath(path, child.name)
    if (child.user) {
      // user subtrees are stored whole; everything inside them is user-made
      out.push({ dir: path, node: child })
    } else {
      collectUserNodes(child, childPath, out)
    }
  }
}

let persistReady = false

function persist() {
  if (!persistReady) return
  try {
    const entries: StoredEntry[] = []
    collectUserNodes(root, 'C:', entries)
    for (const child of bin.children ?? []) {
      entries.push({ dir: RECYCLE_BIN, node: child })
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(entries))
  } catch {
    /* storage unavailable or full; the session still works in memory */
  }
}

function hydrate() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const entries = JSON.parse(raw) as StoredEntry[]
      for (const entry of entries) {
        const dir = entry.dir === RECYCLE_BIN ? bin : getNode(entry.dir)
        if (!dir || dir.kind !== 'folder') continue
        if (!entry.node?.name || !VALID_NAME.test(entry.node.name)) continue
        dir.children ??= []
        if (dir.children.some((c) => c.name.toLowerCase() === entry.node.name.toLowerCase()))
          continue
        dir.children.push({ ...entry.node, user: true, system: false })
      }
    }
  } catch {
    /* corrupted store: start clean */
  }
  persistReady = true
}

hydrate()
