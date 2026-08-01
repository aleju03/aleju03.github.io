import { useEffect, useRef, useState } from 'react'
import { sounds } from './sounds'
import { useOs } from './osContext'
import { MenuBar } from './ContextMenu'
import type { Menu } from './ContextMenu'
import { alertBox, openDialog } from './dialogs'
import { pickPath } from './FileDialog'
import { osDate } from './osYear'
import { baseName, createNode, getNode, parentPath, writeText } from './fs'

/*
  Notepad: opens .txt files from the filesystem and actually edits them.
  System files are read-only like the real OS would insist, so Save falls
  through to Save As. New files land wherever the picker is pointed and
  persist with the rest of the visitor's filesystem.

  It shares the shell's Open and Save As dialogs rather than owning a
  filename box, which is what makes "save this to the desktop, then drag it
  into a folder" one continuous action instead of two apps' opinions about
  where files are allowed to live. The unsaved-changes prompt is here for the
  same reason the delete confirmation is in Explorer: losing a paragraph
  silently is the one thing a text editor must not do.
*/

const DOCS = 'C:\\Documents'

/*
  Link detection. A bare-domain pattern with no allowlist turns about.txt,
  boot.ini and hal.dll into hyperlinks, and this filesystem is mostly those,
  so a domain with no scheme in front of it only counts when its ending is on
  this list. Anything with an explicit http(s):// is taken at its word.
*/
const BARE_TLDS = ['com', 'org', 'net', 'io', 'dev', 'app', 'me', 'co', 'gg', 'sh', 'xyz', 'es', 'cr']

const LINK_RE = new RegExp(
  [
    'https?:\\/\\/[^\\s<>()]+',
    '[\\w.+-]+@[\\w-]+\\.[a-z]{2,}',
    `(?:[\\w-]+\\.)+(?:${BARE_TLDS.join('|')})(?:\\/[^\\s<>()]*)?`,
  ].join('|'),
  'gi',
)

interface Run {
  text: string
  /** absent for ordinary prose */
  href?: string
}

/** split a line into prose and links, in order */
function linkify(text: string): Run[] {
  const runs: Run[] = []
  let at = 0
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0
    // sentence punctuation right after a link is punctuation, not address
    const hit = m[0].replace(/[.,;:!?'")\]]+$/, '')
    if (!hit) continue
    if (start > at) runs.push({ text: text.slice(at, start) })
    const href = /^https?:/i.test(hit)
      ? hit
      : hit.includes('@') && !hit.includes('/')
        ? `mailto:${hit}`
        : `https://${hit}`
    runs.push({ text: hit, href })
    at = start + hit.length
  }
  if (at < text.length) runs.push({ text: text.slice(at) })
  return runs
}

interface NotepadProps {
  path?: string
  setTitle: (t: string) => void
  close: () => void
}

export function NotepadApp({ path: initialPath, setTitle, close }: NotepadProps) {
  const [path, setPath] = useState(initialPath ?? null)
  const node = path ? getNode(path) : null
  const [text, setText] = useState(() => node?.content ?? '')
  const [dirty, setDirty] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [statusMsg, setStatusMsg] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const viewRef = useRef<HTMLPreElement>(null)
  const os = useOs()

  const readonly = Boolean(node?.system)
  const name = path ? baseName(path) : 'Untitled'

  useEffect(() => {
    setTitle(`${dirty ? '*' : ''}${name} - Notepad`)
  }, [name, dirty, setTitle])

  /** write to a path the picker handed back, creating the file if need be */
  const writeTo = (full: string): boolean => {
    const existing = getNode(full)
    if (existing) {
      const r = writeText(full, text)
      if (!r.ok) {
        void alertBox('Save As', r.error)
        return false
      }
    } else {
      const r = createNode(parentPath(full), { name: baseName(full), kind: 'text', content: text }, 'Save')
      if (!r.ok) {
        void alertBox('Save As', r.error)
        return false
      }
      full = `${parentPath(full)}\\${r.name}`
    }
    sounds.click()
    setPath(full)
    setDirty(false)
    setStatusMsg(`Saved to ${full}`)
    return true
  }

  const saveAs = async (): Promise<boolean> => {
    const full = await pickPath({
      mode: 'save',
      title: 'Save As',
      dir: path && !readonly ? parentPath(path) : DOCS,
      fileName: readonly ? `Copy of ${name}` : name === 'Untitled' ? 'untitled.txt' : name,
      accept: ['text'],
      typeLabel: 'Text Documents (*.txt)',
      extension: '.txt',
    })
    if (!full) return false
    return writeTo(full)
  }

  const save = async (): Promise<boolean> => {
    if (!path || readonly) return saveAs()
    const r = writeText(path, text)
    if (!r.ok) {
      void alertBox('Save', r.error)
      return false
    }
    sounds.click()
    setDirty(false)
    setStatusMsg('Saved.')
    return true
  }

  /** true when it is safe to throw the current buffer away */
  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true
    const answer = await openDialog({
      title: 'Notepad',
      icon: 'warn',
      message: `The text in ${name} has changed.\nDo you want to save the changes?`,
      buttons: [
        { label: 'Yes', value: 'yes', primary: true },
        { label: 'No', value: 'no' },
        { label: 'Cancel', value: 'cancel' },
      ],
    })
    if (answer === 'cancel' || answer === null) return false
    if (answer === 'no') return true
    return save()
  }

  const fileNew = async () => {
    if (!(await confirmDiscard())) return
    setPath(null)
    setText('')
    setDirty(false)
    setStatusMsg('')
  }

  const fileOpen = async () => {
    if (!(await confirmDiscard())) return
    const full = await pickPath({
      mode: 'open',
      title: 'Open',
      dir: path ? parentPath(path) : DOCS,
      accept: ['text'],
      typeLabel: 'Text Documents (*.txt)',
    })
    if (!full) return
    const opened = getNode(full)
    if (opened?.kind !== 'text') {
      void alertBox('Open', 'Notepad can only open text documents.', 'warn')
      return
    }
    sounds.open()
    setPath(full)
    setText(opened.content ?? '')
    setDirty(false)
    setStatusMsg('')
  }

  /** the rendered view is not an input, so Select All has to say so itself */
  const selectAll = () => {
    if (areaRef.current) {
      areaRef.current.select()
      return
    }
    const el = viewRef.current
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  /** F5, the shortcut nobody meant to press and everybody remembers */
  const stampTime = () => {
    const area = areaRef.current
    const now = osDate()
    const stamp = `${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${now.toLocaleDateString('en-US')}`
    if (!area) {
      setText((t) => t + stamp)
    } else {
      const { selectionStart: from, selectionEnd: to } = area
      setText((t) => t.slice(0, from) + stamp + t.slice(to))
    }
    setDirty(true)
  }

  const menus: Menu[] = [
    {
      title: 'File',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', onClick: () => void fileNew() },
        { label: 'Open…', shortcut: 'Ctrl+O', onClick: () => void fileOpen() },
        { label: 'Save', shortcut: 'Ctrl+S', onClick: () => void save() },
        { label: 'Save As…', onClick: () => void saveAs() },
        { divider: true },
        {
          label: 'Exit',
          onClick: () => {
            void confirmDiscard().then((ok) => ok && close())
          },
        },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Select All', shortcut: 'Ctrl+A', onClick: selectAll },
        { label: 'Time/Date', shortcut: 'F5', onClick: stampTime },
      ],
    },
    {
      title: 'Format',
      items: [{ label: 'Word Wrap', checked: wrap, onClick: () => setWrap((w) => !w) }],
    },
    {
      title: 'Help',
      items: [
        {
          label: 'About Notepad',
          onClick: () =>
            void alertBox(
              'About Notepad',
              'AlejOS Notepad. Files you save live in this browser, so they survive a reboot of the machine but not a different one.',
              'info',
            ),
        },
      ],
    },
  ]

  return (
    <div
      className="relative flex h-full flex-col"
      onKeyDown={(e) => {
        const ctrl = e.ctrlKey || e.metaKey
        const key = e.key.toLowerCase()
        if (ctrl && key === 's') {
          e.preventDefault()
          void save()
        }
        if (ctrl && key === 'o') {
          e.preventDefault()
          void fileOpen()
        }
        if (ctrl && key === 'n') {
          e.preventDefault()
          void fileNew()
        }
        // a textarea does this itself; the rendered view does not
        if (ctrl && key === 'a' && readonly) {
          e.preventDefault()
          selectAll()
        }
        if (e.key === 'F5') {
          e.preventDefault()
          stampTime()
        }
      }}
    >
      <MenuBar menus={menus} />

      {readonly ? (
        /*
          A read-only file cannot be typed into, so there is nothing for a
          textarea to do here — and a textarea cannot hold a hyperlink, which
          is the whole reason the links in these files used to sit on screen
          as raw percent-encoded addresses. The rendered view is only ever
          shown when editing is already impossible, and Save As turns the
          file into an ordinary editable one, which swaps the editor back in.
        */
        <pre
          ref={viewRef}
          tabIndex={0}
          data-no-focus-ring
          className={`min-h-0 flex-1 overflow-auto bg-white p-4 font-mono text-[13px] leading-relaxed text-stone-800 outline-none ${
            wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
          }`}
        >
          {linkify(text).map((run, i) =>
            run.href ? (
              <a
                key={i}
                href={run.href}
                onClick={(e) => {
                  e.preventDefault()
                  sounds.open()
                  // the machine has its own browser; mail leaves for the
                  // real mail client, since AlejOS has nowhere to put it
                  if (run.href?.startsWith('mailto:')) location.href = run.href
                  else os.openApp('browser', { url: run.href })
                }}
                className="text-blue-700 underline decoration-blue-700/40 underline-offset-2 hover:decoration-blue-700"
              >
                {run.text}
              </a>
            ) : (
              <span key={i}>{run.text}</span>
            ),
          )}
        </pre>
      ) : (
        <textarea
          ref={areaRef}
          value={text}
          data-no-focus-ring
          spellCheck={false}
          wrap={wrap ? 'soft' : 'off'}
          aria-label="Notepad text"
          onChange={(e) => {
            setText(e.target.value)
            setDirty(true)
            setStatusMsg('')
          }}
          className={`min-h-0 flex-1 resize-none bg-white p-4 font-mono text-[13px] leading-relaxed text-stone-800 outline-none ${
            wrap ? '' : 'overflow-x-auto whitespace-pre'
          }`}
        />
      )}

      <div className="flex items-center gap-2 border-t border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-500">
        <span className="truncate">
          {statusMsg ||
            (readonly ? 'Read-only file. Use File → Save As for a copy you can edit.' : ' ')}
        </span>
        <span className="ml-auto shrink-0">{text.length} chars</span>
      </div>
    </div>
  )
}
