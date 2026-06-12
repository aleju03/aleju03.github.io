import { useEffect, useRef, useState } from 'react'
import { sounds } from './sounds'
import { baseName, createTextFile, getNode, parentPath, writeText } from './fs'

/*
  Notepad: opens .txt files from the filesystem and actually edits them.
  System files are read-only like the real OS would insist, so Save offers
  Save As into C:\Documents instead. New files land there too and persist
  with the rest of the visitor's filesystem.
*/

const DOCS = 'C:\\Documents'

interface NotepadProps {
  path?: string
  setTitle: (t: string) => void
}

export function NotepadApp({ path: initialPath, setTitle }: NotepadProps) {
  const [path, setPath] = useState(initialPath ?? null)
  const node = path ? getNode(path) : null
  const [text, setText] = useState(() => node?.content ?? '')
  const [dirty, setDirty] = useState(false)
  const [fileMenu, setFileMenu] = useState(false)
  const [saveAs, setSaveAs] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const readonly = Boolean(node?.system)
  const name = path ? baseName(path) : 'Untitled'

  useEffect(() => {
    setTitle(`${dirty ? '*' : ''}${name} - Notepad`)
  }, [name, dirty, setTitle])

  const doSaveAs = (wanted: string) => {
    const clean = wanted.trim()
    if (!clean) return
    const fileName = clean.toLowerCase().endsWith('.txt') ? clean : `${clean}.txt`
    const dir = path && !readonly ? parentPath(path) : DOCS
    const r = createTextFile(dir, fileName, text)
    if (!r.ok) {
      sounds.error()
      setStatusMsg(r.error)
      return
    }
    sounds.click()
    setPath(`${dir}\\${r.name}`)
    setDirty(false)
    setSaveAs(false)
    setStatusMsg(`Saved to ${dir}\\${r.name}`)
  }

  const save = () => {
    setFileMenu(false)
    if (!path || readonly) {
      setSaveAs(true)
      return
    }
    const r = writeText(path, text)
    if (!r.ok) {
      sounds.error()
      setStatusMsg(r.error)
      return
    }
    sounds.click()
    setDirty(false)
    setStatusMsg('Saved.')
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          save()
        }
      }}
    >
      {/* menu bar */}
      <div className="relative flex gap-1 border-b border-stone-300 bg-stone-200 px-2 py-1 text-xs text-stone-600 select-none">
        <button
          type="button"
          onClick={() => setFileMenu((o) => !o)}
          className={`cursor-pointer rounded-sm px-2 py-0.5 ${
            fileMenu ? 'bg-blue-600/15' : 'hover:bg-blue-600/10'
          }`}
        >
          File
        </button>
        {(['Edit', 'Format', 'Help'] as const).map((m) => (
          <span key={m} className="px-2 py-0.5 text-stone-400">
            {m}
          </span>
        ))}
        {fileMenu && (
          <>
            <button
              type="button"
              aria-label="Close menu"
              className="fixed inset-0 z-10 cursor-default"
              onClick={() => setFileMenu(false)}
            />
            <ul className="absolute top-full left-2 z-20 w-44 rounded-md border border-stone-300 bg-stone-50 py-1 shadow-xl shadow-stone-950/30">
              {[
                {
                  label: 'New',
                  run: () => {
                    setPath(null)
                    setText('')
                    setDirty(false)
                    setStatusMsg('')
                  },
                },
                { label: 'Save', run: save, hint: 'Ctrl+S' },
                { label: 'Save As…', run: () => setSaveAs(true) },
              ].map((item) => (
                <li key={item.label}>
                  <button
                    type="button"
                    onClick={() => {
                      setFileMenu(false)
                      item.run()
                    }}
                    className="flex w-full cursor-pointer items-center px-3 py-1.5 text-left text-xs text-stone-700 hover:bg-blue-600/10"
                  >
                    <span className="flex-1">{item.label}</span>
                    {item.hint && <span className="text-stone-400">{item.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <textarea
        ref={areaRef}
        value={text}
        data-no-focus-ring
        spellCheck={false}
        aria-label="Notepad text"
        onChange={(e) => {
          setText(e.target.value)
          setDirty(true)
          setStatusMsg('')
        }}
        className="min-h-0 flex-1 resize-none bg-white p-4 font-mono text-[13px] leading-relaxed text-stone-800 outline-none"
      />

      <div className="flex items-center gap-2 border-t border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-500">
        <span className="truncate">
          {statusMsg || (readonly ? 'Read-only file. Use File → Save As to keep a copy.' : ' ')}
        </span>
        <span className="ml-auto shrink-0">{text.length} chars</span>
      </div>

      {/* save-as mini dialog */}
      {saveAs && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-stone-950/20">
          <form
            className="w-64 rounded-md border border-stone-400 bg-stone-100 p-3 shadow-xl"
            onSubmit={(e) => {
              e.preventDefault()
              doSaveAs(String(new FormData(e.currentTarget).get('fname') ?? ''))
            }}
          >
            <p className="mb-2 text-xs font-medium text-stone-700">Save As</p>
            <input
              name="fname"
              autoFocus
              data-no-focus-ring
              defaultValue={readonly ? `Copy of ${name}` : name === 'Untitled' ? 'untitled.txt' : name}
              aria-label="File name"
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs text-stone-800 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
            />
            <p className="mt-1.5 text-[11px] text-stone-500">
              Saves into {path && !readonly ? parentPath(path) : DOCS}
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="submit"
                className="cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-3 py-1 text-xs font-medium text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setSaveAs(false)}
                className="cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-3 py-1 text-xs text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
