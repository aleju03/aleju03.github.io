import { RECYCLE_BIN, baseName, canWriteTo, copyNode, moveNode, parentPath, removeNode } from './fs'

/*
  Shell drag and drop: the one store the desktop and every Explorer window
  share while an icon is in the air.

  It is a module store rather than props or context because the two ends of a
  drag are in different React subtrees — you pick a file up in an Explorer
  window and let go of it on the desktop behind that window — and neither one
  is an ancestor of the other. Only the shell (AlejOS) reads the whole state,
  to draw the ghost; a drop target reads nothing but whether the pointer is
  over it.

  Two things make this pointer events rather than HTML5 drag and drop. The
  desktop DOM is mapped onto a 3D CRT through a CSS3D transform, where the
  native drag image is drawn in untransformed viewport space and lands
  nowhere near the cursor; and the desktop icons already drag on pointer
  capture, so there was one gesture vocabulary to match. Under capture every
  move event goes to the element that started the drag, so the target under
  the cursor is found by hit-testing document.elementFromPoint for the nearest
  [data-drop-path] — which is why the ghost must never take pointer events.
*/

export interface DragState {
  /** full paths being dragged; empty when nothing is in the air */
  paths: string[]
  /** past the threshold: before that a drag is still just a click */
  active: boolean
  /** viewport px, converted to desktop-local by whoever draws the ghost */
  x: number
  y: number
  /** the [data-drop-path] under the pointer, or null over dead ground */
  over: string | null
  /** ctrl held: copy instead of move, like the real thing */
  copy: boolean
  /**
   * Should the shell draw a ghost under the cursor? A desktop icon lifts
   * itself and follows the pointer already, so a ghost on top of it would be
   * the same file drawn twice, half a centimetre apart.
   */
  ghost: boolean
}

const IDLE: DragState = {
  paths: [],
  active: false,
  x: 0,
  y: 0,
  over: null,
  copy: false,
  ghost: true,
}

let state = IDLE
const subs = new Set<() => void>()

function set(next: DragState) {
  state = next
  subs.forEach((fn) => fn())
}

export function subscribeDrag(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function getDrag(): DragState {
  return state
}

export function beginDrag(paths: string[], x: number, y: number, opts: { ghost?: boolean } = {}) {
  if (paths.length === 0) return
  set({ paths, active: true, x, y, over: null, copy: false, ghost: opts.ghost !== false })
}

export function updateDrag(x: number, y: number, over: string | null, copy: boolean) {
  if (!state.active) return
  if (state.x === x && state.y === y && state.over === over && state.copy === copy) return
  set({ ...state, x, y, over, copy })
}

export function endDrag() {
  if (state !== IDLE) set(IDLE)
}

/**
 * What is under the pointer right now. Targets opt in with data-drop-path;
 * a folder icon carries its own path, an Explorer body carries the folder it
 * is showing, and the Recycle Bin carries the bin.
 */
export function dropTargetAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY)
  const target = el?.closest<HTMLElement>('[data-drop-path]')
  return target?.dataset.dropPath ?? null
}

/** would this drop do anything? drives both the highlight and the cursor */
export function canDrop(paths: string[], target: string | null): boolean {
  if (!target || paths.length === 0) return false
  if (!canWriteTo(target)) return false
  return paths.some((p) => {
    // onto its own folder is a no-op, and onto itself is nonsense
    if (p === target) return false
    if (target !== RECYCLE_BIN && parentPath(p) === target) return false
    // a folder cannot swallow itself: target inside source, by path prefix
    return !target.toLowerCase().startsWith(`${p.toLowerCase()}\\`)
  })
}

export interface DropResult {
  done: number
  error?: string
}

/**
 * Run the drop. The Recycle Bin is the one target that is not a move: files
 * dropped on it are deleted, which is what removeNode already means, origin
 * stamp and all, so Restore keeps working on things that arrived by drag.
 */
export function performDrop(paths: string[], target: string, copy: boolean): DropResult {
  let done = 0
  let error: string | undefined
  for (const path of paths) {
    if (!canDrop([path], target)) continue
    const r =
      target === RECYCLE_BIN ? removeNode(path) : copy ? copyNode(path, target) : moveNode(path, target)
    if (r.ok) done++
    else error ??= r.error
  }
  return { done, error }
}

/** "3 items" / "readme.txt": what the ghost and the status line say */
export function dragLabel(paths: string[]): string {
  return paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`
}
