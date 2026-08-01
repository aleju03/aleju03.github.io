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

  Every mutation goes through here, which is also why the undo stack lives
  here rather than in the shell: dragging a file to the desktop, pasting a
  copy and pressing Delete are three call sites in two components, but they
  are one history. Each op records its own inverse as a thunk and pushes it,
  with recording switched off while an undo runs so undoing does not push a
  redo entry onto the same stack.
*/

export type FsKind = 'folder' | 'text' | 'image' | 'app' | 'link' | 'shortcut'

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
  /** shortcuts: the path they point at, wearing the target's icon */
  target?: string
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

/*
  Links as a person would type them into a text file: no scheme, no www, no
  trailing slash, and percent-escapes decoded back into the letters they
  stand for. The LinkedIn URL carries an accented surname, which reaches a
  plain-text file as "alejandro-jim%C3%A9nez-ulloa" and reads like a bug.
  Notepad turns whatever survives this back into a clickable link.
*/
function prettyUrl(url: string): string {
  let out = url
  try {
    out = decodeURIComponent(url)
  } catch {
    /* malformed escape: show it as it came */
  }
  return out.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}

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
  github   → ${prettyUrl(github)}
  linkedin → ${prettyUrl(linkedin)}
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
  appShortcut('Solitaire', 'solitaire'),
  appShortcut('Minesweeper', 'minesweeper'),
  appShortcut('Mine Duel', 'mineduel'),
  appShortcut('Pong', 'pong'),
  appShortcut('Snake', 'snake'),
  appShortcut('Memory Match', 'memory'),
  appShortcut('2048', '2048'),
  appShortcut('Whack-A-Mole', 'whack'),
  appShortcut('Tappy Plane', 'flappy'),
  appShortcut('Rhythm Keys', 'vsrg'),
]

function projectFolder(p: AnyProject): FsNode {
  const children: FsNode[] = [
    text(
      'readme.txt',
      `${p.name}\n${'-'.repeat(p.name.length)}\n\n${p.description}\n${
        p.tech ? `\nbuilt with: ${p.tech.join(', ')}\n` : ''
      }\nlinks\n${p.live ? `  live   → ${prettyUrl(p.live)}\n` : ''}  source → ${prettyUrl(p.repo)}\n`,
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

// ---------------------------------------------------------------- undo
// One history for the whole shell. Entries are inverse thunks, so an undo is
// just "run the other direction" through these same functions — which is why
// `recording` has to gate the push, or every undo would bury the entry it was
// undoing under a fresh one.

interface UndoEntry {
  /** completes "Undo ..." in the menus */
  label: string
  run: () => void
}

const undoStack: UndoEntry[] = []
const UNDO_DEPTH = 24
let recording = true

function record(label: string, run: () => void) {
  if (!recording) return
  undoStack.push({ label, run })
  if (undoStack.length > UNDO_DEPTH) undoStack.shift()
}

/** what the next undo would reverse ("Delete", "Move"), or null for nothing */
export function undoLabel(): string | null {
  return undoStack[undoStack.length - 1]?.label ?? null
}

export function undoLast(): string | null {
  const entry = undoStack.pop()
  if (!entry) return null
  recording = false
  try {
    entry.run()
  } finally {
    recording = true
  }
  return entry.label
}

/** lift a node straight out of its folder, with no trip through the bin */
function detach(dir: FsNode, node: FsNode) {
  dir.children = (dir.children ?? []).filter((c) => c !== node)
  bump()
}

export function createNode(
  dirPath: string,
  node: Omit<FsNode, 'modified' | 'user' | 'system'> & { modified?: number },
  undoLabelText = 'New',
): FsResult {
  const dir = writableDir(dirPath)
  if ('error' in dir) return { ok: false, error: dir.error }
  if (!VALID_NAME.test(node.name)) return { ok: false, error: 'That name is not allowed.' }
  const name = uniqueName(dir, node.name)
  dir.children ??= []
  const made: FsNode = { ...node, name, user: true, system: false, modified: Date.now() }
  dir.children.push(made)
  record(undoLabelText, () => detach(dir, made))
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
  const was = node.name
  node.name = newName
  node.modified = Date.now()
  record('Rename', () => {
    node.name = was
    bump()
  })
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
  if (isRecycled(path)) {
    // gone for good, so the only way back is the node we are still holding
    record('Delete', () => {
      bin.children ??= []
      bin.children.push(node)
      bump()
    })
  } else {
    bin.children ??= []
    const binned: FsNode = {
      ...node,
      name: uniqueName(bin, node.name),
      origin: parentPath(path),
      modified: Date.now(),
    }
    bin.children.push(binned)
    record('Delete', () => {
      bin.children = (bin.children ?? []).filter((c) => c !== binned)
      dir.children ??= []
      dir.children.push(node)
      bump()
    })
  }
  bump()
  return { ok: true, name: node.name }
}

/**
 * Move a node into another folder. The whole point of the drag: an icon
 * dropped somewhere else is this call, and so is a paste after a cut.
 * Refuses the two moves that would corrupt the tree — a folder into itself,
 * and a folder into its own descendant — because the tree is the store, so
 * either one detaches a subtree from the root and loses it.
 */
export function moveNode(path: string, toDir: string): FsResult {
  const node = getNode(path)
  const from = getNode(parentPath(path))
  if (!node || !from?.children) return { ok: false, error: 'The file does not exist.' }
  if (node.system) return { ok: false, error: 'Access is denied. That item ships with AlejOS.' }
  const dir = getNode(toDir)
  if (!dir || dir.kind !== 'folder') return { ok: false, error: 'The destination does not exist.' }
  if (dir === from) return { ok: true, name: node.name }
  if (dir === node || isInside(node, dir)) {
    return { ok: false, error: 'You cannot move a folder into itself.' }
  }
  if (dirIsProtected(toDir)) return { ok: false, error: 'Access is denied. That folder is read-only.' }
  const was = node.name
  const wasDir = parentPath(path)
  from.children = from.children.filter((c) => c !== node)
  node.name = uniqueName(dir, node.name)
  node.user = true
  node.modified = Date.now()
  dir.children ??= []
  dir.children.push(node)
  record('Move', () => {
    dir.children = (dir.children ?? []).filter((c) => c !== node)
    node.name = was
    const home = getNode(wasDir)
    if (home?.kind === 'folder') {
      home.children ??= []
      home.children.push(node)
    }
    bump()
  })
  bump()
  return { ok: true, name: node.name }
}

/** deep clone for copy/paste; the duplicate is the visitor's, so it persists */
function cloneNode(node: FsNode): FsNode {
  const copy: FsNode = { ...node, user: true, system: false, modified: Date.now() }
  delete copy.origin
  if (node.children) copy.children = node.children.map(cloneNode)
  return copy
}

export function copyNode(path: string, toDir: string): FsResult {
  const node = getNode(path)
  if (!node) return { ok: false, error: 'The file does not exist.' }
  const dir = getNode(toDir)
  if (!dir || dir.kind !== 'folder') return { ok: false, error: 'The destination does not exist.' }
  if (node.kind === 'folder' && (dir === node || isInside(node, dir))) {
    return { ok: false, error: 'You cannot copy a folder into itself.' }
  }
  if (dirIsProtected(toDir)) return { ok: false, error: 'Access is denied. That folder is read-only.' }
  const copy = cloneNode(node)
  // XP's own naming: a duplicate beside the original is "Copy of x", and only
  // then does the (2) counter take over
  const taken = new Set((dir.children ?? []).map((c) => c.name.toLowerCase()))
  copy.name = taken.has(node.name.toLowerCase())
    ? uniqueName(dir, `Copy of ${node.name}`)
    : node.name
  dir.children ??= []
  dir.children.push(copy)
  record('Copy', () => detach(dir, copy))
  bump()
  return { ok: true, name: copy.name }
}

/** a shortcut wears the target's icon and opens whatever the target opens */
export function createShortcut(targetPath: string, dirPath: string): FsResult {
  const node = getNode(targetPath)
  if (!node) return { ok: false, error: 'The file does not exist.' }
  const stem = node.name.replace(/\.[a-z0-9]+$/i, '')
  return createNode(
    dirPath,
    { name: `Shortcut to ${stem}`, kind: 'shortcut', target: targetPath },
    'Create Shortcut',
  )
}

/** follow a shortcut to the thing it points at; bounded, so a loop cannot hang */
export function resolvePath(path: string): string {
  let at = path
  for (let hop = 0; hop < 8; hop++) {
    const node = getNode(at)
    if (node?.kind !== 'shortcut' || !node.target) return at
    at = node.target
  }
  return at
}

/** is `dir` somewhere under `node`? guards the two moves that lose a subtree */
function isInside(node: FsNode, dir: FsNode): boolean {
  for (const child of node.children ?? []) {
    if (child === dir || isInside(child, dir)) return true
  }
  return false
}

/**
 * The generated tree is read-only, but its *folders* are not all the same:
 * C:\Pictures has always taken Paint saves, and C:\Documents takes Notepad's.
 * Everything else that ships with the OS refuses writes, so dropping a file
 * into C:\Windows\system32 fails the way it should.
 */
const WRITABLE_SYSTEM_DIRS = ['c:\\documents', 'c:\\pictures', 'c:\\desktop']

function dirIsProtected(dirPath: string): boolean {
  const dir = getNode(dirPath)
  if (!dir || !dir.system) return false
  return !WRITABLE_SYSTEM_DIRS.includes(dirPath.toLowerCase())
}

/** can this folder take a dropped or pasted item? */
export function canWriteTo(dirPath: string): boolean {
  if (dirPath === RECYCLE_BIN) return true
  const dir = getNode(dirPath)
  return dir?.kind === 'folder' && !dirIsProtected(dirPath)
}

// ---------------------------------------------------------------- properties

export interface FsStats {
  bytes: number
  files: number
  folders: number
}

/**
 * Size for the properties sheet. Text is its own length; an image is its data
 * URL decoded back to bytes (base64 carries 3 bytes per 4 characters), which
 * is the number a real Paint save would have written to disk.
 */
export function statNode(node: FsNode): FsStats {
  if (node.kind === 'folder') {
    const out: FsStats = { bytes: 0, files: 0, folders: 0 }
    for (const child of node.children ?? []) {
      const s = statNode(child)
      out.bytes += s.bytes
      out.files += child.kind === 'folder' ? s.files : s.files + 1
      out.folders += child.kind === 'folder' ? s.folders + 1 : s.folders
    }
    return out
  }
  if (node.kind === 'text') return { bytes: (node.content ?? '').length, files: 0, folders: 0 }
  if (node.kind === 'image' && node.src?.startsWith('data:')) {
    const b64 = node.src.slice(node.src.indexOf(',') + 1)
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
    return { bytes: Math.max(0, Math.floor((b64.length * 3) / 4) - pad), files: 0, folders: 0 }
  }
  // links, app shortcuts and the images that are really files on the server:
  // a plausible small size rather than a lie about zero
  return { bytes: node.kind === 'image' ? 0 : 512 + node.name.length * 2, files: 0, folders: 0 }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const KIND_LABELS: Record<FsKind, string> = {
  folder: 'File Folder',
  text: 'Text Document',
  image: 'Image File',
  app: 'Application',
  link: 'Internet Shortcut',
  shortcut: 'Shortcut',
}

export function kindLabel(node: FsNode): string {
  return KIND_LABELS[node.kind]
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
  record('Restore', () => {
    home.children = (home.children ?? []).filter((c) => c !== rest)
    bin.children ??= []
    bin.children.push(node)
    bump()
  })
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
