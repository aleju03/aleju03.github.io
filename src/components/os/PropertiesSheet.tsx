/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { glyphFor } from './apps'
import { openDialog } from './dialogs'
import { xpIcon } from './xpIcon'
import {
  RECYCLE_BIN,
  baseName,
  formatBytes,
  getNode,
  kindLabel,
  listDir,
  parentPath,
  recycleBinCount,
  renameNode,
  statNode,
} from './fs'
import type { FsNode } from './fs'

/*
  The properties sheet: right-click anything, Properties, and get the box XP
  would have given you — icon, type, location, size in both units, the dates,
  and the attributes with read-only ticked and greyed on everything that
  ships with the OS. It is the cheapest thing in the shell that proves the
  filesystem underneath is real, because it is the one view that reports on a
  file instead of just listing it.

  The name field is live: renaming here goes through renameNode like every
  other rename, so it fails the same way on system files.
*/

const row = 'flex gap-3 py-[3px] text-xs'
const label = 'w-24 shrink-0 text-stone-500'
const value = 'min-w-0 flex-1 break-words text-stone-800'

function when(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function Sheet({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-stone-100">
      {/* the tab strip: one tab, but the sheet reads wrong without it */}
      <div className="flex shrink-0 gap-1 border-b border-stone-300 bg-stone-200 px-2 pt-2">
        <span className="rounded-t-sm border border-b-0 border-stone-300 bg-stone-100 px-3 py-1 text-xs text-stone-700">
          General
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
    </div>
  )
}

function FileProperties({ path, node }: { path: string; node: FsNode }) {
  const [name, setName] = useState(node.name)
  const [error, setError] = useState('')
  const stats = statNode(node)
  const isFolder = node.kind === 'folder'

  const commit = () => {
    const next = name.trim()
    if (!next || next === node.name) return
    const r = renameNode(path, next)
    if (r.ok) setError('')
    else {
      setError(r.error)
      setName(node.name)
    }
  }

  return (
    <Sheet>
      <div className="flex items-center gap-3 pb-3">
        <span className="shrink-0">{glyphFor(node, 34)}</span>
        <input
          value={name}
          readOnly={node.system}
          data-no-focus-ring
          aria-label="Name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className={`min-w-0 flex-1 rounded-sm border border-stone-400 px-2 py-1 text-xs text-stone-800 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)] ${
            node.system ? 'bg-stone-200' : 'bg-white'
          }`}
        />
      </div>
      <div className="border-t border-stone-300 py-2">
        <p className={row}>
          <span className={label}>Type</span>
          <span className={value}>{kindLabel(node)}</span>
        </p>
        <p className={row}>
          <span className={label}>Location</span>
          <span className={value}>{parentPath(path) || 'My Computer'}</span>
        </p>
        <p className={row}>
          <span className={label}>Size</span>
          <span className={value}>
            {formatBytes(stats.bytes)}
            {stats.bytes >= 1024 && (
              <span className="text-stone-500"> ({stats.bytes.toLocaleString()} bytes)</span>
            )}
          </span>
        </p>
        {isFolder && (
          <p className={row}>
            <span className={label}>Contains</span>
            <span className={value}>
              {stats.files} Files, {stats.folders} Folders
            </span>
          </p>
        )}
        {node.kind === 'shortcut' && (
          <p className={row}>
            <span className={label}>Target</span>
            <span className={`${value} font-mono`}>{node.target}</span>
          </p>
        )}
        {node.kind === 'link' && (
          <p className={row}>
            <span className={label}>URL</span>
            <span className={`${value} font-mono break-all`}>{node.url}</span>
          </p>
        )}
      </div>
      <div className="border-t border-stone-300 py-2">
        <p className={row}>
          <span className={label}>Modified</span>
          <span className={value}>{when(node.modified)}</span>
        </p>
      </div>
      <div className="border-t border-stone-300 pt-2">
        <p className={row}>
          <span className={label}>Attributes</span>
          <span className={`${value} flex gap-4`}>
            <label className="flex items-center gap-1.5 text-stone-700">
              <input type="checkbox" checked={Boolean(node.system)} disabled readOnly />
              Read-only
            </label>
            <label className="flex items-center gap-1.5 text-stone-400">
              <input type="checkbox" checked={false} disabled readOnly />
              Hidden
            </label>
          </span>
        </p>
        {node.system && (
          <p className="pt-1 text-[11px] text-stone-500">
            This item ships with AlejOS and cannot be changed.
          </p>
        )}
        {error && <p className="pt-1 text-[11px] text-red-700">{error}</p>}
      </div>
    </Sheet>
  )
}

function ComputerProperties({ user }: { user: string }) {
  const bin = recycleBinCount()
  return (
    <Sheet>
      <div className="flex items-center gap-3 pb-3">
        <span className="shrink-0">{xpIcon('my-computer', 34)}</span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-stone-800">AlejOS</p>
          <p className="text-[11px] text-stone-500">Version 5.1 (Build 2600.aju)</p>
        </div>
      </div>
      <div className="border-t border-stone-300 py-2">
        <p className={row}>
          <span className={label}>System</span>
          <span className={value}>AlejOS 5.1, Service Pack 2</span>
        </p>
        <p className={row}>
          <span className={label}>Registered to</span>
          <span className={value}>{user}</span>
        </p>
        <p className={row}>
          <span className={label}>Manufactured</span>
          <span className={value}>AJU Corporation</span>
        </p>
      </div>
      <div className="border-t border-stone-300 py-2">
        <p className={row}>
          <span className={label}>Computer</span>
          <span className={value}>AJU 700FD</span>
        </p>
        <p className={row}>
          <span className={label}>Processor</span>
          <span className={value}>1.40 GHz</span>
        </p>
        <p className={row}>
          <span className={label}>Memory</span>
          <span className={value}>512 MB of RAM</span>
        </p>
        <p className={row}>
          <span className={label}>Disk</span>
          <span className={value}>AlejOS (C:) · 4.2 GB free of 20.0 GB</span>
        </p>
        <p className={row}>
          <span className={label}>Recycle Bin</span>
          <span className={value}>
            {bin} item{bin === 1 ? '' : 's'}
          </span>
        </p>
      </div>
      <p className="border-t border-stone-300 pt-2 text-[11px] leading-relaxed text-stone-500">
        Everything on this machine is a browser tab. Files you make live in your own localStorage,
        never on a server.
      </p>
    </Sheet>
  )
}

function BinProperties() {
  const count = recycleBinCount()
  const bytes = listDir(RECYCLE_BIN).reduce((sum, n) => sum + statNode(n).bytes, 0)
  return (
    <Sheet>
      <div className="flex items-center gap-3 pb-3">
        <span className="shrink-0">{xpIcon(count > 0 ? 'recycle-full' : 'recycle-empty', 34)}</span>
        <p className="text-xs font-semibold text-stone-800">Recycle Bin</p>
      </div>
      <div className="border-t border-stone-300 py-2">
        <p className={row}>
          <span className={label}>Contains</span>
          <span className={value}>
            {count} item{count === 1 ? '' : 's'}
          </span>
        </p>
        <p className={row}>
          <span className={label}>Size</span>
          <span className={value}>{formatBytes(bytes)}</span>
        </p>
      </div>
      <p className="border-t border-stone-300 pt-2 text-[11px] leading-relaxed text-stone-500">
        Items are held here until you empty the bin. Anything that shipped with AlejOS cannot be
        deleted in the first place, so nothing in here is load-bearing.
      </p>
    </Sheet>
  )
}

/** Properties for any path, or for My Computer when the path is empty */
export function showProperties(path: string, user = 'guest') {
  if (!path) {
    void openDialog({
      title: 'System Properties',
      width: 400,
      body: () => <ComputerProperties user={user} />,
      buttons: [{ label: 'OK', value: 'ok', primary: true }],
    })
    return
  }
  if (path === RECYCLE_BIN) {
    void openDialog({
      title: 'Recycle Bin Properties',
      width: 400,
      body: () => <BinProperties />,
      buttons: [{ label: 'OK', value: 'ok', primary: true }],
    })
    return
  }
  const node = getNode(path)
  if (!node) return
  void openDialog({
    title: `${baseName(path)} Properties`,
    width: 400,
    body: () => <FileProperties path={path} node={node} />,
    buttons: [{ label: 'OK', value: 'ok', primary: true }],
  })
}
