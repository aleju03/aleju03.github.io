/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import { PlayIcon } from '@phosphor-icons/react'
import { alertBox, dialogButtonClass, openDialog } from './dialogs'
import { isAppId } from './apps'
import { getNode, resolvePath } from './fs'
import { sounds } from './sounds'

/*
  Start → Run. A one-line command box is a small thing to build and a large
  thing to find: it is the first place someone who used this OS for real will
  go looking, and it rewards them with the names they already know — mspaint,
  winmine, sol, iexplore, taskmgr, cmd. Anything that is not an alias is
  tried as a path and then as a URL, so "C:\Projects" and "github.com/aleju"
  both work in the same box.
*/

// the names people actually typed, mapped onto the apps this machine has
const ALIASES: Record<string, string> = {
  explorer: 'explorer',
  notepad: 'notepad',
  mspaint: 'paint',
  paint: 'paint',
  pbrush: 'paint',
  iexplore: 'browser',
  ie: 'browser',
  cmd: 'terminal',
  command: 'terminal',
  terminal: 'terminal',
  taskmgr: 'taskmgr',
  winmine: 'minesweeper',
  minesweeper: 'minesweeper',
  sol: 'solitaire',
  solitaire: 'solitaire',
  msmsgs: 'chat',
  chat: 'chat',
  control: 'display',
  desk: 'display',
  'desk.cpl': 'display',
  peeko: 'peeko',
}

const JOKES: Record<string, { title: string; body: string }> = {
  'format c:': {
    title: 'Format C:',
    body: 'Formatting the drive would take the whole portfolio with it, and I quite like the portfolio.',
  },
  regedit: {
    title: 'Registry Editor',
    body: 'There is no registry. There is a folder tree and a localStorage key, and you already have both.',
  },
  calc: {
    title: 'AlejOS',
    body: 'No calculator on this build. The machine can play Solitaire and paint, which was the priority.',
  },
}

export interface RunApi {
  openApp: (app: string, props?: Record<string, unknown>) => void
  openPath: (path: string) => void
}

function RunBody({ api, onDone }: { api: RunApi; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState('')

  const run = () => {
    const raw = value.trim()
    if (!raw) return
    const key = raw.toLowerCase().replace(/\.exe$/, '')

    const joke = JOKES[key]
    if (joke) {
      onDone(null)
      void alertBox(joke.title, joke.body, 'info')
      return
    }

    const alias = ALIASES[key]
    if (alias && isAppId(alias)) {
      onDone(null)
      api.openApp(alias)
      return
    }

    // a path, if the filesystem knows it
    const asPath = resolvePath(raw.replace(/\//g, '\\').replace(/\\+$/, ''))
    if (getNode(asPath)) {
      onDone(null)
      api.openPath(asPath)
      return
    }

    // anything with a dot and no spaces is worth trying as a URL
    if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(raw) || /^https?:\/\//i.test(raw)) {
      onDone(null)
      api.openApp('browser', { url: /^https?:/i.test(raw) ? raw : `https://${raw}` })
      return
    }

    sounds.error()
    void alertBox(
      'Run',
      `AlejOS cannot find '${raw}'. Check the spelling, or try one of: mspaint, notepad, sol, winmine, cmd, iexplore, taskmgr.`,
      'warn',
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-3 px-4 py-4">
        <PlayIcon size={30} weight="fill" className="mt-0.5 shrink-0 text-blue-600" />
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-relaxed text-stone-700">
            Type the name of a program, folder, document, or Internet resource, and AlejOS will open
            it for you.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <label className="shrink-0 text-xs text-stone-600" htmlFor="run-open">
              Open
            </label>
            <input
              id="run-open"
              autoFocus
              value={value}
              data-no-focus-ring
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  run()
                }
              }}
              className="min-w-0 flex-1 rounded-sm border border-stone-400 bg-white px-2 py-1 font-mono text-xs text-stone-800 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
            />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-stone-300 bg-stone-200 px-3 py-2">
        <button type="button" onClick={run} className={`${dialogButtonClass} font-medium`}>
          OK
        </button>
        <button type="button" onClick={() => onDone(null)} className={dialogButtonClass}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function showRunDialog(api: RunApi) {
  void openDialog({
    title: 'Run',
    width: 380,
    bare: true,
    body: (close) => <RunBody api={api} onDone={close} />,
  })
}
