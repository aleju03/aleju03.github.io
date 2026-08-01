import { RECYCLE_BIN, canWriteTo, copyNode, moveNode, parentPath } from './fs'

/*
  The shell clipboard: Ctrl+C / Ctrl+X / Ctrl+V across the desktop and every
  Explorer window. A module store for the same reason the drag one is — you
  copy in one window and paste in another, and neither is the other's parent.

  Cut does not move anything when you press it. It marks the paths and waits,
  because a cut you never paste has to leave the file where it was, and
  because the marked icons render at half opacity until then, which is the
  whole feedback the gesture gets. The move happens on paste.
*/

export type ClipMode = 'copy' | 'cut'

export interface ClipState {
  paths: string[]
  mode: ClipMode
}

const EMPTY: ClipState = { paths: [], mode: 'copy' }

let state = EMPTY
const subs = new Set<() => void>()

function set(next: ClipState) {
  state = next
  subs.forEach((fn) => fn())
}

export function subscribeClipboard(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function getClipboard(): ClipState {
  return state
}

export function clipCopy(paths: string[]) {
  if (paths.length) set({ paths: [...paths], mode: 'copy' })
}

export function clipCut(paths: string[]) {
  if (paths.length) set({ paths: [...paths], mode: 'cut' })
}

export function clearClipboard() {
  if (state !== EMPTY) set(EMPTY)
}

/** is this path marked for a move? cut items dim until the paste lands */
export function isCut(path: string): boolean {
  return state.mode === 'cut' && state.paths.includes(path)
}

export function canPasteInto(dir: string): boolean {
  return state.paths.length > 0 && dir !== RECYCLE_BIN && canWriteTo(dir)
}

export interface PasteResult {
  done: number
  error?: string
}

export function paste(dir: string): PasteResult {
  if (!canPasteInto(dir)) return { done: 0 }
  let done = 0
  let error: string | undefined
  for (const path of state.paths) {
    // a cut pasted back into its own folder is a no-op, not an error
    if (state.mode === 'cut' && parentPath(path) === dir) continue
    const r = state.mode === 'cut' ? moveNode(path, dir) : copyNode(path, dir)
    if (r.ok) done++
    else error ??= r.error
  }
  // a cut is spent once it lands; a copy stays on the clipboard, XP style
  if (state.mode === 'cut' && done > 0) clearClipboard()
  return { done, error }
}
