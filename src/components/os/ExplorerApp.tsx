import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUUpLeftIcon,
  ArrowUpIcon,
} from '@phosphor-icons/react'
import { sounds } from './sounds'
import { useOs } from './osContext'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import {
  DESKTOP,
  MY_COMPUTER,
  RECYCLE_BIN,
  baseName,
  createFolder,
  createTextFile,
  emptyRecycleBin,
  getFsVersion,
  getNode,
  isRecycled,
  joinPath,
  listDir,
  parentPath,
  removeNode,
  renameNode,
  restoreNode,
  sortChildren,
  splitPath,
  subscribeFs,
} from './fs'
import type { FsNode } from './fs'
import { glyphFor } from './apps'
import { xpIcon } from './xpIcon'

/*
  File Explorer: a real navigable view over the AlejOS filesystem. Address
  bar you can type in, back/forward/up history, a quick-links sidebar, icon
  grid with inline rename, right-click menus on items and on the background,
  a My Computer drives view and the Recycle Bin. Folders open in place;
  files dispatch through os.openPath so the right app picks them up.
*/

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

const inset =
  'rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs text-stone-700 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]'

interface ExplorerProps {
  winId: string
  initialPath?: string
  setTitle: (t: string) => void
}

export function ExplorerApp({ initialPath, setTitle }: ExplorerProps) {
  const os = useOs()
  useSyncExternalStore(subscribeFs, getFsVersion)

  const [path, setPath] = useState(() => {
    const p = initialPath ?? MY_COMPUTER
    return p === MY_COMPUTER || getNode(p)?.kind === 'folder' ? p : MY_COMPUTER
  })
  const [back, setBack] = useState<string[]>([])
  const [fwd, setFwd] = useState<string[]>([])
  const [address, setAddress] = useState(() => displayPath(path))
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; item: FsNode | null } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const inBin = path === RECYCLE_BIN || isRecycled(path)
  const atComputer = path === MY_COMPUTER
  const items = atComputer ? [] : listDir(path)

  useEffect(() => {
    setTitle(path === MY_COMPUTER ? 'My Computer' : baseName(path) || path)
  }, [path, setTitle])

  const go = (to: string, fromHistory = false) => {
    if (to === path) return
    if (!fromHistory) {
      setBack((prev) => [...prev, path])
      setFwd([])
    }
    setPath(to)
    setAddress(displayPath(to))
    setSelected(null)
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
    const raw = address.trim().replace(/[\\/]+$/, '')
    const target =
      raw === '' || /^my computer$/i.test(raw)
        ? MY_COMPUTER
        : /^recycle bin$/i.test(raw)
          ? RECYCLE_BIN
          : raw
    if (target === MY_COMPUTER || getNode(target)?.kind === 'folder') {
      sounds.click()
      go(target)
      return
    }
    sounds.error()
    setStatus(`Cannot find "${raw}". Check the path and try again.`)
    setAddress(displayPath(path))
  }

  const openItem = (node: FsNode) => {
    if (inBin) return
    sounds.open()
    if (node.kind === 'folder') go(joinPath(path, node.name))
    else os.openPath(joinPath(path, node.name))
  }

  const report = (r: { ok: boolean; error?: string }) => {
    if (!r.ok) {
      sounds.error()
      setStatus(r.error ?? 'Something went wrong.')
    }
  }

  const itemMenu = (node: FsNode): MenuItem[] => {
    const full = joinPath(path, node.name)
    if (inBin) {
      return [
        { label: 'Restore', bold: true, onClick: () => report(restoreNode(full)) },
        { divider: true },
        { label: 'Delete', onClick: () => report(removeNode(full)) },
      ]
    }
    return [
      { label: 'Open', bold: true, onClick: () => openItem(node) },
      { divider: true },
      {
        label: 'Rename',
        disabled: node.system,
        onClick: () => setRenaming(node.name),
      },
      {
        label: 'Delete',
        disabled: node.system,
        onClick: () => report(removeNode(full)),
      },
    ]
  }

  const backgroundMenu = (): MenuItem[] => {
    if (atComputer) return [{ label: 'Refresh', onClick: () => sounds.click() }]
    if (path === RECYCLE_BIN) {
      return [
        {
          label: 'Empty Recycle Bin',
          disabled: items.length === 0,
          onClick: () => {
            sounds.close()
            emptyRecycleBin()
          },
        },
        { label: 'Refresh', onClick: () => sounds.click() },
      ]
    }
    return [
      {
        label: 'Arrange Icons By',
        sub: [
          { label: 'Name', onClick: () => sortChildren(path, 'name') },
          { label: 'Type', onClick: () => sortChildren(path, 'type') },
          { label: 'Modified', onClick: () => sortChildren(path, 'modified') },
        ],
      },
      { label: 'Refresh', onClick: () => sounds.click() },
      { divider: true },
      { label: 'Paste', disabled: true },
      { divider: true },
      {
        label: 'New',
        sub: [
          {
            label: 'Folder',
            onClick: () => {
              const r = createFolder(path)
              report(r)
              if (r.ok) setRenaming(r.name)
            },
          },
          {
            label: 'Text Document',
            onClick: () => {
              const r = createTextFile(path)
              report(r)
              if (r.ok) setRenaming(r.name)
            },
          },
        ],
      },
    ]
  }

  const commitRename = (node: FsNode, value: string) => {
    setRenaming(null)
    const next = value.trim()
    if (!next || next === node.name) return
    report(renameNode(joinPath(path, node.name), next))
  }

  const onBodyContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const body = bodyRef.current
    if (!body) return
    const rect = body.getBoundingClientRect()
    const itemEl = (e.target as HTMLElement).closest<HTMLElement>('[data-fs-item]')
    const node = itemEl ? items.find((n) => n.name === itemEl.dataset.fsItem) ?? null : null
    if (node) setSelected(node.name)
    setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, item: node })
  }

  const toolBtn =
    'flex size-7 cursor-pointer items-center justify-center rounded-sm text-stone-600 transition-colors hover:bg-stone-300/70 disabled:cursor-default disabled:text-stone-400 disabled:hover:bg-transparent'

  return (
    <div className="flex h-full flex-col bg-white">
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
        {/* quick links */}
        <nav className="hidden w-40 shrink-0 overflow-y-auto border-r border-stone-300 bg-stone-100 py-1.5 sm:block">
          {QUICK_LINKS.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => {
                sounds.click()
                go(q.path)
              }}
              className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs ${
                path === q.path
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
          className="relative min-w-0 flex-1 overflow-y-auto"
          onContextMenu={onBodyContextMenu}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) {
              setSelected(null)
              setMenu(null)
            }
          }}
        >
          {atComputer ? (
            <div className="flex flex-wrap content-start gap-1 p-3">
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
                      setStatus(`There is no disk in drive ${d.path}. Insert a disk and try again.`)
                    }
                  }}
                  onClick={() => {
                    sounds.click()
                    setSelected(d.path)
                  }}
                  className={`flex w-28 cursor-pointer flex-col items-center gap-1 rounded-md p-3 ${
                    selected === d.path ? 'bg-blue-600/15' : 'hover:bg-blue-600/5'
                  }`}
                >
                  <span className="text-stone-600">{d.icon}</span>
                  <span className="text-center text-xs text-stone-800">{d.name}</span>
                </button>
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="p-4 text-xs text-stone-400">This folder is empty.</p>
          ) : (
            <div className="flex flex-wrap content-start gap-1 p-3">
              {items.map((node) => (
                <div key={node.name} data-fs-item={node.name} className="w-24">
                  <button
                    type="button"
                    onClick={() => {
                      if (window.matchMedia('(hover: none)').matches) openItem(node)
                      else {
                        sounds.click()
                        setSelected(node.name)
                      }
                    }}
                    onDoubleClick={() => openItem(node)}
                    className={`flex w-full cursor-pointer flex-col items-center gap-1 rounded-md p-2 ${
                      selected === node.name ? 'bg-blue-600/15' : 'hover:bg-blue-600/5'
                    }`}
                  >
                    <span className="text-blue-700 [&_svg]:block">{glyphFor(node, 30)}</span>
                    {renaming === node.name ? (
                      <input
                        autoFocus
                        defaultValue={node.name}
                        data-no-focus-ring
                        aria-label="New name"
                        onFocus={(e) => e.currentTarget.select()}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(node, e.currentTarget.value)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={(e) => commitRename(node, e.target.value)}
                        className="w-full rounded-sm border border-blue-600 bg-white px-1 text-center text-xs text-stone-800"
                      />
                    ) : (
                      <span className="max-w-full break-words text-center text-xs leading-tight text-stone-800">
                        {node.name}
                      </span>
                    )}
                  </button>
                </div>
              ))}
            </div>
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
              : `${items.length} object${items.length === 1 ? '' : 's'}${
                  selected ? ` · ${selected}` : ''
                }`)}
        </span>
        {inBin && items.length > 0 && !status && (
          <button
            type="button"
            onClick={() => {
              sounds.close()
              emptyRecycleBin()
            }}
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
