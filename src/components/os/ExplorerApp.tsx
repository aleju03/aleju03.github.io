import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUUpLeftIcon,
  ArrowUpIcon,
  ListBulletsIcon,
  SquaresFourIcon,
  TableIcon,
} from '@phosphor-icons/react'
import { sounds } from './sounds'
import { useOs } from './osContext'
import { ContextMenu, MenuBar } from './ContextMenu'
import type { Menu, MenuItem } from './ContextMenu'
import { alertBox, confirmBox } from './dialogs'
import { showProperties } from './PropertiesSheet'
import {
  canPasteInto,
  clipCopy,
  clipCut,
  getClipboard,
  isCut,
  paste,
  subscribeClipboard,
} from './clipboard'
import {
  beginDrag,
  canDrop,
  dropTargetAt,
  endDrag,
  getDrag,
  performDrop,
  subscribeDrag,
  updateDrag,
} from './dnd'
import {
  DESKTOP,
  MY_COMPUTER,
  RECYCLE_BIN,
  baseName,
  canWriteTo,
  createFolder,
  createShortcut,
  createTextFile,
  emptyRecycleBin,
  formatBytes,
  getFsVersion,
  getNode,
  isRecycled,
  joinPath,
  kindLabel,
  listDir,
  parentPath,
  removeNode,
  renameNode,
  resolvePath,
  restoreNode,
  sortChildren,
  splitPath,
  statNode,
  subscribeFs,
  undoLabel,
  undoLast,
} from './fs'
import type { FsNode } from './fs'
import { glyphFor } from './apps'
import { xpIcon } from './xpIcon'

/*
  File Explorer: a real navigable view over the AlejOS filesystem. Address
  bar you can type in, back/forward/up history, a quick-links sidebar, three
  view modes with sortable Details columns, right-click menus on items and on
  the background, a My Computer drives view and the Recycle Bin. Folders open
  in place; files dispatch through os.openPath so the right app picks them up.

  It is also one half of the shell's file management, and the half that has
  to agree with the other. Selection, cut/copy/paste, drag and drop, F2,
  Delete and Properties all go through the same modules the desktop uses
  (clipboard.ts, dnd.ts, fs.ts), so a file cut in a window pastes on the
  desktop and a folder dragged out of one window lands in another. Anything
  that refuses now says so in a dialog rather than in the status bar, because
  a refusal six lines below where you were looking reads as nothing happening.
*/

type ViewMode = 'icons' | 'list' | 'details'
type SortKey = 'name' | 'size' | 'type' | 'modified'

const VIEW_KEY = 'alejos-explorer-view'

// the view mode is a preference, not window state: open a second window and
// it should look like the one you were just using
function loadView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    if (v === 'icons' || v === 'list' || v === 'details') return v
  } catch {
    /* storage unavailable */
  }
  return 'icons'
}

function saveView(v: ViewMode) {
  try {
    localStorage.setItem(VIEW_KEY, v)
  } catch {
    /* storage unavailable */
  }
}

const DRIVES = [
  { name: 'Local Disk (C:)', path: 'C:', icon: xpIcon('hard-drive', 34) },
  { name: '3½ Floppy (A:)', path: 'A:', icon: xpIcon('floppy', 34) },
  { name: 'CD Drive (D:)', path: 'D:', icon: xpIcon('cd-drive', 34) },
]

const QUICK_LINKS: { label: string; path: string; icon: ReactNode }[] = [
  { label: 'My Computer', path: MY_COMPUTER, icon: xpIcon('my-computer', 15) },
  { label: 'Local Disk (C:)', path: 'C:', icon: xpIcon('hard-drive', 15) },
  { label: 'Desktop', path: DESKTOP, icon: null },
  { label: 'Documents', path: 'C:\\Documents', icon: null },
  { label: 'Pictures', path: 'C:\\Pictures', icon: null },
  { label: 'Projects', path: 'C:\\Projects', icon: null },
  { label: 'Program Files', path: 'C:\\Program Files', icon: null },
  { label: 'Recycle Bin', path: RECYCLE_BIN, icon: xpIcon('recycle-empty', 15) },
]

function displayPath(path: string): string {
  if (path === MY_COMPUTER) return 'My Computer'
  return path === 'C:' ? 'C:\\' : path
}

function shortDate(ts: number): string {
  const d = new Date(ts)
  // hand-assembled rather than toLocaleString: the locale form puts a comma
  // and a space before the time and an AM/PM after it, which is two more
  // break opportunities than a column this narrow can afford
  const date = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time}`
}

const inset =
  'rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs text-stone-700 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]'

/*
  The icon view. Fixed-width cells in a wrapping flex row leave the tail of
  every row unused: at the default window the pane fits five 88px columns but
  not five 96px ones, so a whole column's worth of space sat empty on the
  right. auto-fill packs as many columns as the pane can actually hold and
  hands the slack to the cells, so the grid always reaches the far edge.
*/
const ICON_GRID =
  'grid content-start gap-1 p-3 [grid-template-columns:repeat(auto-fill,minmax(5.5rem,1fr))]'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface ExplorerProps {
  winId: string
  initialPath?: string
  setTitle: (t: string) => void
}

export function ExplorerApp({ initialPath, setTitle }: ExplorerProps) {
  const os = useOs()
  useSyncExternalStore(subscribeFs, getFsVersion)
  const clip = useSyncExternalStore(subscribeClipboard, getClipboard)
  const drag = useSyncExternalStore(subscribeDrag, getDrag)

  const [path, setPath] = useState(() => {
    const p = initialPath ?? MY_COMPUTER
    return p === MY_COMPUTER || getNode(p)?.kind === 'folder' ? p : MY_COMPUTER
  })
  const [back, setBack] = useState<string[]>([])
  const [fwd, setFwd] = useState<string[]>([])
  const [address, setAddress] = useState(() => displayPath(path))
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; item: FsNode | null } | null>(null)
  const [view, setView] = useState<ViewMode>(loadView)
  const [sort, setSort] = useState<{ by: SortKey; desc: boolean }>({ by: 'name', desc: false })
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<string | null>(null)
  const marqueeRef = useRef<{ x: number; y: number } | null>(null)
  // one drag gesture, shared by every item: which item started it, whether it
  // has passed the threshold, and the scale the CRT is drawing the screen at
  const dragRef = useRef<{ px: number; py: number; scale: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  const inBin = path === RECYCLE_BIN || isRecycled(path)
  const atComputer = path === MY_COMPUTER
  const raw = atComputer ? [] : listDir(path)
  const writable = !atComputer && canWriteTo(path)

  const items = [...raw].sort((a, b) => {
    if (view !== 'details') return 0
    const rank = (n: FsNode) => (n.kind === 'folder' ? 0 : 1)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    const dir = sort.desc ? -1 : 1
    switch (sort.by) {
      case 'size':
        return (statNode(a).bytes - statNode(b).bytes) * dir
      case 'type':
        return kindLabel(a).localeCompare(kindLabel(b)) * dir
      case 'modified':
        return (a.modified - b.modified) * dir
      default:
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir
    }
  })

  useEffect(() => {
    setTitle(path === MY_COMPUTER ? 'My Computer' : baseName(path) || path)
  }, [path, setTitle])

  const selPaths = [...selected].map((n) => joinPath(path, n))
  const selNodes = [...selected].map((n) => getNode(joinPath(path, n))).filter(Boolean) as FsNode[]
  const canActOnSelection = selNodes.length > 0 && selNodes.every((n) => !n.system)

  const go = (to: string, fromHistory = false) => {
    if (to === path) return
    if (!fromHistory) {
      setBack((prev) => [...prev, path])
      setFwd([])
    }
    setPath(to)
    setAddress(displayPath(to))
    setSelected(new Set())
    setRenaming(null)
    setMenu(null)
    setStatus('')
  }

  const goBack = () => {
    const to = back[back.length - 1]
    if (to === undefined) return
    setBack((prev) => prev.slice(0, -1))
    setFwd((prev) => [...prev, path])
    go(to, true)
  }

  const goForward = () => {
    const to = fwd[fwd.length - 1]
    if (to === undefined) return
    setFwd((prev) => prev.slice(0, -1))
    setBack((prev) => [...prev, path])
    go(to, true)
  }

  const goUp = () => {
    if (atComputer) return
    const segs = splitPath(path)
    go(segs.length <= 1 ? MY_COMPUTER : parentPath(path))
  }

  const submitAddress = () => {
    const clean = address.trim().replace(/[\\/]+$/, '')
    const target =
      clean === '' || /^my computer$/i.test(clean)
        ? MY_COMPUTER
        : /^recycle bin$/i.test(clean)
          ? RECYCLE_BIN
          : clean
    if (target === MY_COMPUTER || getNode(target)?.kind === 'folder') {
      sounds.click()
      go(target)
      return
    }
    sounds.error()
    void alertBox(
      'File Explorer',
      `Cannot find "${clean}". Check the spelling and try again.`,
      'warn',
    )
    setAddress(displayPath(path))
  }

  const openItem = (node: FsNode) => {
    if (inBin) {
      void alertBox(
        'Recycle Bin',
        `${node.name} is in the Recycle Bin. Restore it before you can open it.`,
        'info',
      )
      return
    }
    const full = joinPath(path, node.name)
    const resolved = resolvePath(full)
    sounds.open()
    if (getNode(resolved)?.kind === 'folder') go(resolved)
    else os.openPath(resolved)
  }

  const report = (r: { ok: boolean; error?: string }, title = 'File Explorer') => {
    if (!r.ok) {
      void alertBox(title, r.error ?? 'Something went wrong.')
      setStatus(r.error ?? '')
    }
    return r.ok
  }

  // ------------------------------------------------------------- selection

  const selectOnly = (name: string) => {
    anchorRef.current = name
    setSelected(new Set([name]))
  }

  const clickItem = (e: React.MouseEvent, node: FsNode) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    if (renaming) return
    if (window.matchMedia('(hover: none)').matches) {
      openItem(node)
      return
    }
    sounds.click()
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(node.name)) next.delete(node.name)
        else next.add(node.name)
        return next
      })
      anchorRef.current = node.name
      return
    }
    if (e.shiftKey && anchorRef.current) {
      const from = items.findIndex((n) => n.name === anchorRef.current)
      const to = items.findIndex((n) => n.name === node.name)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        setSelected(new Set(items.slice(lo, hi + 1).map((n) => n.name)))
        return
      }
    }
    selectOnly(node.name)
  }

  // --------------------------------------------------------------- actions

  const doDelete = async () => {
    if (selPaths.length === 0) return
    const blocked = selNodes.find((n) => n.system)
    if (blocked) {
      void alertBox(
        'Delete File',
        `${blocked.name} ships with AlejOS and cannot be deleted.`,
        'warn',
      )
      return
    }
    const what = selPaths.length === 1 ? `'${baseName(selPaths[0])}'` : `these ${selPaths.length} items`
    const ok = await confirmBox(
      inBin ? 'Delete File' : 'Confirm Delete',
      inBin
        ? `Are you sure you want to permanently delete ${what}?`
        : `Are you sure you want to send ${what} to the Recycle Bin?`,
      { icon: inBin ? 'warn' : 'question' },
    )
    if (!ok) return
    sounds.close()
    for (const p of selPaths) report(removeNode(p), 'Delete File')
    setSelected(new Set())
  }

  const doPaste = () => {
    const r = paste(path)
    if (r.error) void alertBox('Paste', r.error)
    else if (r.done) {
      sounds.open()
      setStatus(`Pasted ${r.done} item${r.done === 1 ? '' : 's'}.`)
    }
  }

  const doUndo = () => {
    const label = undoLast()
    if (label) {
      sounds.click()
      setStatus(`Undid ${label.toLowerCase()}.`)
    }
  }

  const commitRename = (node: FsNode, value: string) => {
    setRenaming(null)
    const next = value.trim()
    if (!next || next === node.name) return
    if (report(renameNode(joinPath(path, node.name), next), 'Rename')) {
      setSelected(new Set([next]))
    }
  }

  // ------------------------------------------------------------------ drag

  const localScale = () => {
    const el = bodyRef.current
    if (!el) return 1
    return el.getBoundingClientRect().width / el.offsetWidth || 1
  }

  const startItemDrag = (e: React.PointerEvent, node: FsNode) => {
    // whatever was clicked, the pane owns the keyboard from now on
    bodyRef.current?.focus({ preventScroll: true })
    if (renaming || e.button !== 0 || atComputer) return
    dragRef.current = { px: e.clientX, py: e.clientY, scale: localScale(), moved: false }
    // dragging something outside the selection makes it the selection first,
    // exactly like letting go and clicking it would have
    if (!selected.has(node.name)) selectOnly(node.name)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const moveItemDrag = (e: React.PointerEvent, node: FsNode) => {
    const d = dragRef.current
    if (!d) return
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.px, e.clientY - d.py) / d.scale < 5) return
      d.moved = true
      const names = selected.has(node.name) && selected.size > 0 ? [...selected] : [node.name]
      beginDrag(names.map((n) => joinPath(path, n)), e.clientX, e.clientY)
    }
    const over = dropTargetAt(e.clientX, e.clientY)
    updateDrag(e.clientX, e.clientY, over, e.ctrlKey)
  }

  const endItemDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d?.moved) return
    suppressClick.current = true
    const paths = getDrag().paths
    const target = dropTargetAt(e.clientX, e.clientY)
    endDrag()
    if (!target || !canDrop(paths, target)) return
    const r = performDrop(paths, target, e.ctrlKey)
    if (r.error) void alertBox('Move', r.error)
    else if (r.done) {
      sounds.open()
      setSelected(new Set())
      setStatus(
        `${e.ctrlKey ? 'Copied' : 'Moved'} ${r.done} item${r.done === 1 ? '' : 's'} to ${
          target === RECYCLE_BIN ? 'the Recycle Bin' : target
        }.`,
      )
    }
  }

  const cancelItemDrag = () => {
    if (dragRef.current?.moved) endDrag()
    dragRef.current = null
  }

  // hovering a folder while something is in the air
  const dropLit = (target: string) =>
    drag.active && drag.over === target && canDrop(drag.paths, target)

  // ------------------------------------------------------------- marquee

  const onBodyPointerDown = (e: React.PointerEvent) => {
    // the context menu renders inside this pane, so a press on one of its rows
    // must not read as a press on the empty background behind it
    if ((e.target as HTMLElement).closest('[data-fs-item], [data-menu]')) return
    bodyRef.current?.focus({ preventScroll: true })
    setSelected(new Set())
    setMenu(null)
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    const root = bodyRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const scale = localScale()
    marqueeRef.current = {
      x: (e.clientX - rect.left) / scale + root.scrollLeft,
      y: (e.clientY - rect.top) / scale + root.scrollTop,
    }
    root.setPointerCapture(e.pointerId)
  }

  const onBodyPointerMove = (e: React.PointerEvent) => {
    const origin = marqueeRef.current
    const root = bodyRef.current
    if (!origin || !root) return
    const rect = root.getBoundingClientRect()
    const scale = localScale()
    const cx = (e.clientX - rect.left) / scale + root.scrollLeft
    const cy = (e.clientY - rect.top) / scale + root.scrollTop
    const m: Rect = {
      x: Math.min(origin.x, cx),
      y: Math.min(origin.y, cy),
      w: Math.abs(cx - origin.x),
      h: Math.abs(cy - origin.y),
    }
    setMarquee(m)
    const hits = new Set<string>()
    root.querySelectorAll<HTMLElement>('[data-fs-item]').forEach((node) => {
      const r = node.getBoundingClientRect()
      const left = (r.left - rect.left) / scale + root.scrollLeft
      const top = (r.top - rect.top) / scale + root.scrollTop
      const w = r.width / scale
      const h = r.height / scale
      if (left < m.x + m.w && left + w > m.x && top < m.y + m.h && top + h > m.y) {
        hits.add(node.dataset.fsItem as string)
      }
    })
    setSelected(hits)
  }

  const endMarquee = () => {
    marqueeRef.current = null
    setMarquee(null)
  }

  // ------------------------------------------------------------------ menus

  const itemMenu = (node: FsNode): MenuItem[] => {
    const full = joinPath(path, node.name)
    if (inBin) {
      return [
        { label: 'Restore', bold: true, onClick: () => report(restoreNode(full)) },
        { divider: true },
        { label: 'Delete', onClick: () => void doDelete() },
        { divider: true },
        { label: 'Properties', onClick: () => showProperties(full, os.session.name) },
      ]
    }
    return [
      { label: 'Open', bold: true, onClick: () => openItem(node) },
      { divider: true },
      {
        label: 'Cut',
        shortcut: 'Ctrl+X',
        disabled: !canActOnSelection,
        onClick: () => clipCut(selPaths),
      },
      { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => clipCopy(selPaths) },
      {
        label: 'Create Shortcut',
        disabled: !writable,
        onClick: () => report(createShortcut(full, path), 'Create Shortcut'),
      },
      { divider: true },
      {
        label: 'Rename',
        shortcut: 'F2',
        disabled: node.system || selected.size > 1,
        onClick: () => setRenaming(node.name),
      },
      {
        label: 'Delete',
        shortcut: 'Del',
        disabled: !canActOnSelection,
        onClick: () => void doDelete(),
      },
      { divider: true },
      { label: 'Properties', onClick: () => showProperties(full, os.session.name) },
    ]
  }

  const newSubmenu = (): MenuItem[] => [
    {
      label: 'Folder',
      onClick: () => {
        const r = createFolder(path)
        if (report(r, 'New Folder') && r.ok) setRenaming(r.name)
      },
    },
    {
      label: 'Text Document',
      onClick: () => {
        const r = createTextFile(path)
        if (report(r, 'New Text Document') && r.ok) setRenaming(r.name)
      },
    },
  ]

  const backgroundMenu = (): MenuItem[] => {
    if (atComputer) {
      return [
        { label: 'Refresh', onClick: () => sounds.click() },
        { divider: true },
        { label: 'Properties', onClick: () => showProperties('', os.session.name) },
      ]
    }
    if (path === RECYCLE_BIN) {
      return [
        {
          label: 'Empty Recycle Bin',
          disabled: items.length === 0,
          onClick: () => void emptyBin(),
        },
        { label: 'Refresh', onClick: () => sounds.click() },
        { divider: true },
        { label: 'Properties', onClick: () => showProperties(RECYCLE_BIN, os.session.name) },
      ]
    }
    return [
      {
        label: 'View',
        sub: viewItems(),
      },
      {
        label: 'Arrange Icons By',
        sub: [
          { label: 'Name', onClick: () => sortChildren(path, 'name') },
          { label: 'Type', onClick: () => sortChildren(path, 'type') },
          { label: 'Modified', onClick: () => sortChildren(path, 'modified') },
        ],
      },
      { label: 'Refresh', shortcut: 'F5', onClick: () => sounds.click() },
      { divider: true },
      {
        label: 'Paste',
        shortcut: 'Ctrl+V',
        disabled: !canPasteInto(path),
        onClick: doPaste,
      },
      {
        label: undoLabel() ? `Undo ${undoLabel()}` : 'Undo',
        shortcut: 'Ctrl+Z',
        disabled: !undoLabel(),
        onClick: doUndo,
      },
      { divider: true },
      { label: 'New', disabled: !writable, sub: newSubmenu() },
      { divider: true },
      { label: 'Properties', onClick: () => showProperties(path, os.session.name) },
    ]
  }

  const viewItems = (): MenuItem[] =>
    (
      [
        ['icons', 'Icons'],
        ['list', 'List'],
        ['details', 'Details'],
      ] as const
    ).map(([mode, label]) => ({
      label,
      checked: view === mode,
      onClick: () => {
        setView(mode)
        saveView(mode)
      },
    }))

  const emptyBin = async () => {
    if (listDir(RECYCLE_BIN).length === 0) return
    const ok = await confirmBox(
      'Confirm Delete',
      'Are you sure you want to permanently delete everything in the Recycle Bin?',
      { icon: 'warn' },
    )
    if (!ok) return
    sounds.close()
    emptyRecycleBin()
  }

  const menus: Menu[] = [
    {
      title: 'File',
      items: [
        {
          label: 'Open',
          disabled: selected.size !== 1,
          onClick: () => {
            const node = items.find((n) => selected.has(n.name))
            if (node) openItem(node)
          },
        },
        { label: 'New', disabled: !writable, sub: newSubmenu() },
        { divider: true },
        {
          label: 'Rename',
          shortcut: 'F2',
          disabled: selected.size !== 1 || !canActOnSelection,
          onClick: () => setRenaming([...selected][0]),
        },
        { label: 'Delete', shortcut: 'Del', disabled: !canActOnSelection, onClick: () => void doDelete() },
        { divider: true },
        {
          label: 'Properties',
          onClick: () =>
            showProperties(selPaths.length === 1 ? selPaths[0] : path, os.session.name),
        },
      ],
    },
    {
      title: 'Edit',
      items: [
        {
          label: undoLabel() ? `Undo ${undoLabel()}` : 'Undo',
          shortcut: 'Ctrl+Z',
          disabled: !undoLabel(),
          onClick: doUndo,
        },
        { divider: true },
        {
          label: 'Cut',
          shortcut: 'Ctrl+X',
          disabled: !canActOnSelection,
          onClick: () => clipCut(selPaths),
        },
        { label: 'Copy', shortcut: 'Ctrl+C', disabled: selected.size === 0, onClick: () => clipCopy(selPaths) },
        { label: 'Paste', shortcut: 'Ctrl+V', disabled: !canPasteInto(path), onClick: doPaste },
        { divider: true },
        {
          label: 'Select All',
          shortcut: 'Ctrl+A',
          onClick: () => setSelected(new Set(items.map((n) => n.name))),
        },
        {
          label: 'Invert Selection',
          onClick: () => setSelected(new Set(items.filter((n) => !selected.has(n.name)).map((n) => n.name))),
        },
      ],
    },
    {
      title: 'View',
      items: [
        ...viewItems(),
        { divider: true },
        { label: 'Refresh', shortcut: 'F5', onClick: () => sounds.click() },
      ],
    },
    {
      title: 'Help',
      items: [
        {
          label: 'About File Explorer',
          onClick: () =>
            void alertBox(
              'About File Explorer',
              'AlejOS Explorer 5.1. Drag files between windows and the desktop, cut and paste them, drop them on the Recycle Bin. Everything you make is stored in your own browser.',
              'info',
            ),
        },
      ],
    },
  ]

  const onBodyContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const body = bodyRef.current
    if (!body) return
    const rect = body.getBoundingClientRect()
    const scale = localScale()
    const itemEl = (e.target as HTMLElement).closest<HTMLElement>('[data-fs-item]')
    const node = itemEl ? (items.find((n) => n.name === itemEl.dataset.fsItem) ?? null) : null
    if (node && !selected.has(node.name)) selectOnly(node.name)
    setMenu({
      x: (e.clientX - rect.left) / scale + body.scrollLeft,
      y: (e.clientY - rect.top) / scale + body.scrollTop,
      item: node,
    })
  }

  // --------------------------------------------------------------- keyboard

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming) return
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelected(new Set(items.map((n) => n.name)))
      return
    }
    if (ctrl && e.key.toLowerCase() === 'c' && selected.size) {
      e.preventDefault()
      clipCopy(selPaths)
      return
    }
    if (ctrl && e.key.toLowerCase() === 'x' && canActOnSelection) {
      e.preventDefault()
      clipCut(selPaths)
      return
    }
    if (ctrl && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      doPaste()
      return
    }
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      doUndo()
      return
    }
    if (e.key === 'F2' && selected.size === 1) {
      e.preventDefault()
      setRenaming([...selected][0])
      return
    }
    if (e.key === 'Delete' && selected.size) {
      e.preventDefault()
      void doDelete()
      return
    }
    if (e.key === 'Enter' && selected.size === 1) {
      e.preventDefault()
      const node = items.find((n) => selected.has(n.name))
      if (node) openItem(node)
      return
    }
    if (e.key === 'Backspace') {
      e.preventDefault()
      goUp()
    }
  }

  // ----------------------------------------------------------------- render

  const toolBtn =
    'flex size-7 cursor-pointer items-center justify-center rounded-sm text-stone-600 transition-colors hover:bg-stone-300/70 disabled:cursor-default disabled:text-stone-400 disabled:hover:bg-transparent'

  const rowTone = (node: FsNode) =>
    `${selected.has(node.name) ? 'bg-blue-600/15' : 'hover:bg-blue-600/5'} ${
      isCut(joinPath(path, node.name)) ? 'opacity-50' : ''
    } ${dropLit(joinPath(path, node.name)) ? 'ring-2 ring-blue-500 bg-blue-600/20' : ''}`

  // every item carries the same gesture set, whichever view is drawing it.
  // They are divs rather than buttons because a button cannot hold the rename
  // input or a table row, so the keyboard contract is rebuilt by hand: each
  // one is tabbable and answers Enter itself, and the pane behind them takes
  // focus on any press so Ctrl+C and Delete have somewhere to land.
  const itemBind = (node: FsNode) => ({
    'data-fs-item': node.name,
    role: 'button',
    tabIndex: 0,
    ...(node.kind === 'folder' ? { 'data-drop-path': joinPath(path, node.name) } : {}),
    onPointerDown: (e: React.PointerEvent) => startItemDrag(e, node),
    onPointerMove: (e: React.PointerEvent) => moveItemDrag(e, node),
    onPointerUp: endItemDrag,
    onPointerCancel: cancelItemDrag,
    onClick: (e: React.MouseEvent) => clickItem(e, node),
    onDoubleClick: () => openItem(node),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (renaming === node.name) return
      if (e.key === 'Enter') {
        // the pane also opens the selection on Enter; without this the two
        // would both fire and open the same folder twice
        e.stopPropagation()
        e.preventDefault()
        openItem(node)
      }
    },
  })

  const renameInput = (node: FsNode) => (
    <input
      autoFocus
      defaultValue={node.name}
      data-no-focus-ring
      aria-label="New name"
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commitRename(node, e.currentTarget.value)
        if (e.key === 'Escape') setRenaming(null)
      }}
      onBlur={(e) => commitRename(node, e.target.value)}
      className="w-full min-w-0 rounded-sm border border-blue-600 bg-white px-1 text-center text-xs text-stone-800"
    />
  )

  const sortHead = (key: SortKey, label: string, extra = '') => (
    <th className={`border-r border-stone-300 p-0 font-normal ${extra}`}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ by: key, desc: s.by === key ? !s.desc : false }))}
        className="flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-left text-xs text-stone-600 hover:bg-stone-300/60"
      >
        {label}
        {sort.by === key && <span className="text-[9px] text-stone-500">{sort.desc ? '▼' : '▲'}</span>}
      </button>
    </th>
  )

  const body = atComputer ? (
    <div className={ICON_GRID}>
      {DRIVES.map((d) => (
        <button
          key={d.path}
          type="button"
          onDoubleClick={() => {
            if (d.path === 'C:') {
              sounds.open()
              go('C:')
            } else {
              sounds.error()
              void alertBox(
                'File Explorer',
                `There is no disk in drive ${d.path}. Insert a disk and try again.`,
                'warn',
              )
            }
          }}
          onClick={() => {
            sounds.click()
            setSelected(new Set([d.path]))
          }}
          {...(d.path === 'C:' ? { 'data-drop-path': 'C:' } : {})}
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-md p-3 ${
            selected.has(d.path) ? 'bg-blue-600/15' : 'hover:bg-blue-600/5'
          }`}
        >
          <span className="text-stone-600">{d.icon}</span>
          <span className="text-center text-xs text-stone-800">{d.name}</span>
        </button>
      ))}
    </div>
  ) : items.length === 0 ? (
    <p className="p-4 text-xs text-stone-400">This folder is empty.</p>
  ) : view === 'details' ? (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 z-10 bg-stone-200">
        <tr className="border-b border-stone-300">
          {sortHead('name', 'Name')}
          {sortHead('size', 'Size', 'w-20')}
          {sortHead('type', 'Type', 'w-28')}
          {sortHead('modified', 'Date Modified', 'w-36')}
        </tr>
      </thead>
      <tbody>
        {items.map((node) => (
          <tr
            key={node.name}
            {...itemBind(node)}
            className={`cursor-pointer select-none ${rowTone(node)}`}
          >
            <td className="px-2 py-1">
              <span className="flex items-center gap-2">
                <span className="shrink-0 [&_img]:block">{glyphFor(node, 16)}</span>
                {renaming === node.name ? (
                  renameInput(node)
                ) : (
                  <span className="truncate text-stone-800">{node.name}</span>
                )}
              </span>
            </td>
            {/* the three trailing columns never wrap: "File Folder" broken over
                two lines doubles every row's height and reads as a bug */}
            <td className="px-2 py-1 text-right whitespace-nowrap text-stone-500 tabular-nums">
              {node.kind === 'folder' ? '' : formatBytes(statNode(node).bytes)}
            </td>
            <td className="truncate px-2 py-1 whitespace-nowrap text-stone-500">{kindLabel(node)}</td>
            <td className="px-2 py-1 whitespace-nowrap text-stone-500 tabular-nums">
              {shortDate(node.modified)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : view === 'list' ? (
    // XP's List view: small icons flowing down, then across
    <div className="p-2 [column-width:11rem] [column-gap:0.5rem]">
      {items.map((node) => (
        <div
          key={node.name}
          {...itemBind(node)}
          className={`flex cursor-pointer select-none items-center gap-2 rounded-sm px-1.5 py-1 ${rowTone(node)}`}
        >
          <span className="shrink-0 [&_img]:block">{glyphFor(node, 16)}</span>
          {renaming === node.name ? (
            renameInput(node)
          ) : (
            <span className="truncate text-xs text-stone-800">{node.name}</span>
          )}
        </div>
      ))}
    </div>
  ) : (
    <div className={ICON_GRID}>
      {items.map((node) => (
        <div
          key={node.name}
          {...itemBind(node)}
          className={`flex cursor-pointer select-none flex-col items-center gap-1 rounded-md p-2 ${rowTone(node)}`}
        >
          <span className="text-blue-700 [&_svg]:block [&_img]:block">{glyphFor(node, 30)}</span>
          {renaming === node.name ? (
            renameInput(node)
          ) : (
            <span className="max-w-full break-words text-center text-xs leading-tight text-stone-800">
              {node.name}
            </span>
          )}
        </div>
      ))}
    </div>
  )

  const selectedBytes = selNodes.reduce((sum, n) => sum + statNode(n).bytes, 0)

  return (
    <div className="flex h-full flex-col bg-white">
      <MenuBar menus={menus} />

      {/* toolbar + address */}
      <div className="flex items-center gap-1 border-b border-stone-300 bg-stone-200 px-2 py-1.5">
        <button
          type="button"
          aria-label="Back"
          className={toolBtn}
          disabled={back.length === 0}
          onClick={goBack}
        >
          <ArrowLeftIcon size={15} weight="bold" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          className={toolBtn}
          disabled={fwd.length === 0}
          onClick={goForward}
        >
          <ArrowRightIcon size={15} weight="bold" />
        </button>
        <button type="button" aria-label="Up" className={toolBtn} disabled={atComputer} onClick={goUp}>
          <ArrowUpIcon size={15} weight="bold" />
        </button>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-stone-300" />
        {(
          [
            ['icons', <SquaresFourIcon key="i" size={15} weight="bold" />],
            ['list', <ListBulletsIcon key="l" size={15} weight="bold" />],
            ['details', <TableIcon key="d" size={15} weight="bold" />],
          ] as const
        ).map(([mode, icon]) => (
          <button
            key={mode}
            type="button"
            aria-label={`${mode} view`}
            aria-pressed={view === mode}
            onClick={() => {
              sounds.click()
              setView(mode)
              saveView(mode)
            }}
            className={`${toolBtn} ${view === mode ? 'bg-stone-300/80 text-blue-800' : ''}`}
          >
            {icon}
          </button>
        ))}
        <span className="ml-1 text-xs text-stone-500">Address</span>
        <input
          value={address}
          data-no-focus-ring
          spellCheck={false}
          aria-label="Address"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAddress()
            if (e.key === 'Escape') setAddress(displayPath(path))
          }}
          className={`${inset} min-w-0 flex-1 font-mono`}
        />
        <button
          type="button"
          onClick={submitAddress}
          className="cursor-pointer rounded-sm border border-stone-400 bg-stone-100 px-2.5 py-1 text-xs text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
        >
          Go
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* quick links: also drop targets, so a file can be filed without
            navigating to where it is going */}
        <nav className="hidden w-40 shrink-0 overflow-y-auto border-r border-stone-300 bg-stone-100 py-1.5 sm:block">
          {QUICK_LINKS.map((q) => (
            <button
              key={q.label}
              type="button"
              {...(q.path !== MY_COMPUTER ? { 'data-drop-path': q.path } : {})}
              onClick={() => {
                sounds.click()
                go(q.path)
              }}
              className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs ${
                dropLit(q.path)
                  ? 'bg-blue-600/25 ring-1 ring-blue-500 ring-inset'
                  : path === q.path
                    ? 'bg-blue-600/10 font-medium text-blue-800'
                    : 'text-stone-600 hover:bg-blue-600/5'
              }`}
            >
              <span className="flex w-4 justify-center text-blue-700">
                {q.icon ?? glyphFor(getNode(q.path), 15)}
              </span>
              {q.label}
            </button>
          ))}
        </nav>

        {/* contents */}
        <div
          ref={bodyRef}
          tabIndex={-1}
          data-no-focus-ring
          {...(!atComputer ? { 'data-drop-path': path } : {})}
          className={`relative min-w-0 flex-1 overflow-auto outline-none ${
            dropLit(path) ? 'bg-blue-600/10 ring-2 ring-blue-500 ring-inset' : ''
          }`}
          onContextMenu={onBodyContextMenu}
          onKeyDown={onKeyDown}
          onPointerDown={onBodyPointerDown}
          onPointerMove={onBodyPointerMove}
          onPointerUp={endMarquee}
          onPointerCancel={endMarquee}
        >
          {body}

          {marquee && marquee.w + marquee.h > 4 && (
            <div
              aria-hidden
              className="pointer-events-none absolute border border-blue-500 bg-blue-600/20"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          )}

          {menu && (
            <ContextMenu
              items={menu.item ? itemMenu(menu.item) : backgroundMenu()}
              x={menu.x}
              y={menu.y}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
      </div>

      {/* status bar */}
      <div className="flex items-center gap-3 border-t border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-500">
        <span className="truncate">
          {status ||
            (atComputer
              ? '3 objects'
              : selected.size > 0
                ? `${selected.size} object${selected.size === 1 ? '' : 's'} selected${
                    selectedBytes ? ` · ${formatBytes(selectedBytes)}` : ''
                  }`
                : `${items.length} object${items.length === 1 ? '' : 's'}`)}
        </span>
        {clip.paths.length > 0 && !status && (
          <span className="hidden shrink-0 text-stone-400 sm:block">
            {clip.paths.length} on clipboard
          </span>
        )}
        {inBin && items.length > 0 && !status && (
          <button
            type="button"
            onClick={() => void emptyBin()}
            className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-stone-500 hover:text-stone-800"
          >
            <ArrowUUpLeftIcon size={11} /> Empty bin
          </button>
        )}
        <span className="ml-auto hidden shrink-0 sm:block">AlejOS (C:) · 4.2 GB free</span>
      </div>
    </div>
  )
}
