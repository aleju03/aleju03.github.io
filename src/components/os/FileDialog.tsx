/* eslint-disable react-refresh/only-export-components */
import { useState, useSyncExternalStore } from 'react'
import { ArrowUpIcon, FolderPlusIcon } from '@phosphor-icons/react'
import { glyphFor } from './apps'
import { confirmBox, dialogButtonClass, openDialog } from './dialogs'
import { sounds } from './sounds'
import {
  DESKTOP,
  canWriteTo,
  createFolder,
  getFsVersion,
  getNode,
  joinPath,
  listDir,
  parentPath,
  splitPath,
  subscribeFs,
} from './fs'
import type { FsKind } from './fs'

/*
  The common Open / Save As dialog, shared by Notepad and Paint the way a real
  shell shares one. Before it, Paint could only ever save to C:\Pictures and
  Notepad to C:\Documents, which is the tell that an app is faking a
  filesystem: the file exists but you were never allowed to say where it goes.
  With a picker, "paint something, save it to the desktop, drag it into a
  folder" is one continuous story, and that story is the whole point.

  It returns a path, not a file. Writing is the app's job, because Notepad
  writes text and Paint writes a data URL and neither belongs in here. Save
  mode does own the overwrite prompt, though — that question is about the
  filesystem, not about what is being written.
*/

export interface PickOptions {
  mode: 'open' | 'save'
  title?: string
  /** folder to start in */
  dir?: string
  /** proposed name, save mode only */
  fileName?: string
  /** kinds to show; folders always show */
  accept?: FsKind[]
  /** the "Files of type" line, e.g. "Text Documents (*.txt)" */
  typeLabel?: string
  /** appended when the typed name has no extension */
  extension?: string
}

const PLACES = [
  { label: 'Desktop', path: DESKTOP },
  { label: 'My Documents', path: 'C:\\Documents' },
  { label: 'My Pictures', path: 'C:\\Pictures' },
  { label: 'My Computer (C:)', path: 'C:' },
]

const inset =
  'rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs text-stone-800 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]'

function FilePicker({
  opts,
  onDone,
}: {
  opts: PickOptions
  onDone: (value: string | null) => void
}) {
  useSyncExternalStore(subscribeFs, getFsVersion)
  const [dir, setDir] = useState(() => {
    const start = opts.dir && getNode(opts.dir)?.kind === 'folder' ? opts.dir : DESKTOP
    return start
  })
  const [name, setName] = useState(opts.fileName ?? '')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')

  const saving = opts.mode === 'save'
  const accept = opts.accept
  const items = listDir(dir).filter(
    (n) => n.kind === 'folder' || !accept || accept.includes(n.kind),
  )

  const enter = (path: string) => {
    sounds.click()
    setDir(path)
    setSelected(null)
    setError('')
  }

  const choose = (fileName: string) => {
    const clean = fileName.trim()
    if (!clean) {
      setError('Type a file name.')
      return
    }
    const withExt =
      opts.extension && !/\.[a-z0-9]+$/i.test(clean) ? `${clean}${opts.extension}` : clean
    const full = joinPath(dir, withExt)
    if (saving) {
      if (!canWriteTo(dir)) {
        setError('That folder is read-only. Pick another one.')
        return
      }
      if (getNode(full)) {
        void confirmBox(
          'Save As',
          `${withExt} already exists.\nDo you want to replace it?`,
          { icon: 'warn' },
        ).then((yes) => {
          if (yes) onDone(full)
        })
        return
      }
      onDone(full)
      return
    }
    if (!getNode(full)) {
      setError(`Cannot find ${withExt}. Check the name and try again.`)
      return
    }
    onDone(full)
  }

  const activate = (itemName: string) => {
    const node = getNode(joinPath(dir, itemName))
    if (!node) return
    if (node.kind === 'folder') enter(joinPath(dir, itemName))
    else choose(itemName)
  }

  const up = splitPath(dir).length > 1 ? parentPath(dir) : null

  return (
    // a definite height, because the listing is the part that scrolls and a
    // content-sized dialog would grow with the folder instead
    <div style={{ height: 340 }} className="flex min-h-0 flex-1 flex-col bg-stone-100">
      {/* look in / save in */}
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-300 bg-stone-200 px-3 py-2">
        <span className="shrink-0 text-xs text-stone-600">{saving ? 'Save in' : 'Look in'}</span>
        <select
          value={PLACES.some((p) => p.path === dir) ? dir : '__here'}
          aria-label={saving ? 'Save in' : 'Look in'}
          onChange={(e) => e.target.value !== '__here' && enter(e.target.value)}
          className={`${inset} min-w-0 flex-1 cursor-pointer appearance-none hover:border-blue-600`}
        >
          {!PLACES.some((p) => p.path === dir) && (
            <option value="__here">{dir}</option>
          )}
          {PLACES.map((p) => (
            <option key={p.path} value={p.path}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Up one level"
          disabled={!up}
          onClick={() => up && enter(up)}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-stone-600 hover:bg-stone-300/70 disabled:cursor-default disabled:text-stone-400 disabled:hover:bg-transparent"
        >
          <ArrowUpIcon size={14} weight="bold" />
        </button>
        <button
          type="button"
          aria-label="New folder"
          disabled={!canWriteTo(dir)}
          onClick={() => {
            const r = createFolder(dir)
            if (r.ok) {
              sounds.click()
              setSelected(r.name)
            }
          }}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-stone-600 hover:bg-stone-300/70 disabled:cursor-default disabled:text-stone-400 disabled:hover:bg-transparent"
        >
          <FolderPlusIcon size={14} weight="bold" />
        </button>
      </div>

      {/* the listing */}
      <div className="m-3 min-h-0 flex-1 overflow-y-auto rounded-sm border border-stone-400 bg-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]">
        {items.length === 0 ? (
          <p className="p-3 text-xs text-stone-400">Nothing here that this app can open.</p>
        ) : (
          <ul className="py-1">
            {items.map((node) => (
              <li key={node.name}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(node.name)
                    if (node.kind !== 'folder') setName(node.name)
                  }}
                  onDoubleClick={() => activate(node.name)}
                  className={`flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-xs ${
                    selected === node.name ? 'bg-blue-600 text-white' : 'text-stone-800 hover:bg-blue-600/10'
                  }`}
                >
                  <span className="shrink-0 [&_img]:block">{glyphFor(node, 16)}</span>
                  <span className="truncate">{node.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* file name + type + buttons */}
      <div className="shrink-0 border-t border-stone-300 bg-stone-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-stone-600">File name</span>
          <input
            autoFocus
            value={saving ? name : (selected ?? name)}
            data-no-focus-ring
            spellCheck={false}
            aria-label="File name"
            onChange={(e) => {
              setName(e.target.value)
              setSelected(null)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const typed = saving ? name : (selected ?? name)
                const node = getNode(joinPath(dir, typed))
                if (node?.kind === 'folder') enter(joinPath(dir, typed))
                else choose(typed)
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            className={`${inset} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={() => choose(saving ? name : (selected ?? name))}
            className={`${dialogButtonClass} font-medium`}
          >
            {saving ? 'Save' : 'Open'}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-stone-600">Files of type</span>
          <span className={`${inset} min-w-0 flex-1 bg-stone-100 text-stone-500`}>
            {opts.typeLabel ?? 'All Files (*.*)'}
          </span>
          <button type="button" onClick={() => onDone(null)} className={dialogButtonClass}>
            Cancel
          </button>
        </div>
        {error && <p className="mt-1.5 text-[11px] text-red-700">{error}</p>}
      </div>
    </div>
  )
}

/** resolves with a full path, or null if the visitor backed out */
export function pickPath(opts: PickOptions): Promise<string | null> {
  return openDialog({
    title: opts.title ?? (opts.mode === 'save' ? 'Save As' : 'Open'),
    width: 460,
    bare: true,
    body: (close) => <FilePicker opts={opts} onDone={close} />,
  })
}
