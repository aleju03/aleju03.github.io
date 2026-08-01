/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { InfoIcon, QuestionIcon, WarningIcon, XCircleIcon } from '@phosphor-icons/react'
import { sounds } from './sounds'

/*
  The AlejOS dialog box. Before this every failure in the shell was a sentence
  in Explorer's status bar, which is the least OS-like place a refusal can
  land: you drag a file somewhere it cannot go, nothing visibly happens, and
  the explanation is six lines below where you were looking. A real machine
  stops you with a box that has a title, an icon and a button you have to
  press, so this is that box.

  It is a module store with a promise per dialog, so any code anywhere —
  including plain functions with no component around them — can await an
  answer:  if (await confirmBox(...)) removeNode(path).  The layer renders
  inside the desktop, so on the 3D CRT the dialogs are on the tube with
  everything else rather than floating over the room.

  Custom bodies (the properties sheet, Run, the file picker) pass an element
  through `body`, not inline JSX with hooks in it: the layer calls that
  function during its own render, so anything with state has to be a real
  component element for the hooks to belong to something.
*/

export type DialogIcon = 'info' | 'warn' | 'error' | 'question'

export interface DialogButton {
  label: string
  /** what the promise resolves to */
  value: string
  /** the default: focused on open, fired by Enter */
  primary?: boolean
}

export interface DialogSpec {
  title: string
  icon?: DialogIcon
  message?: ReactNode
  buttons?: DialogButton[]
  /** custom body; call close() to resolve and dismiss */
  body?: (close: (value: string | null) => void) => ReactNode
  /** custom bodies with their own footer opt out of the button row */
  bare?: boolean
  width?: number
}

interface OpenDialog {
  id: number
  spec: DialogSpec
  resolve: (value: string | null) => void
}

let stack: OpenDialog[] = []
let nextId = 1
const subs = new Set<() => void>()

function set(next: OpenDialog[]) {
  stack = next
  subs.forEach((fn) => fn())
}

function subscribeDialogs(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

function getDialogs(): OpenDialog[] {
  return stack
}

/** Escape closes with null; every button resolves with its own value */
export function openDialog(spec: DialogSpec): Promise<string | null> {
  return new Promise((resolve) => {
    set([...stack, { id: nextId++, spec, resolve }])
  })
}

export function alertBox(title: string, message: ReactNode, icon: DialogIcon = 'error') {
  return openDialog({ title, message, icon }).then(() => undefined)
}

export function confirmBox(
  title: string,
  message: ReactNode,
  opts: { icon?: DialogIcon; yes?: string; no?: string } = {},
): Promise<boolean> {
  return openDialog({
    title,
    message,
    icon: opts.icon ?? 'question',
    buttons: [
      { label: opts.yes ?? 'Yes', value: 'yes', primary: true },
      { label: opts.no ?? 'No', value: 'no' },
    ],
  }).then((v) => v === 'yes')
}

/** close everything: the machine is shutting down or logging off */
export function closeAllDialogs() {
  const open = stack
  set([])
  open.forEach((d) => d.resolve(null))
}

const GLYPHS: Record<DialogIcon, ReactNode> = {
  info: <InfoIcon size={30} weight="fill" className="text-blue-600" />,
  warn: <WarningIcon size={30} weight="fill" className="text-amber-500" />,
  error: <XCircleIcon size={30} weight="fill" className="text-red-600" />,
  question: <QuestionIcon size={30} weight="fill" className="text-blue-600" />,
}

export const dialogButtonClass =
  'min-w-[76px] cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-3 py-1 text-xs text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50 disabled:cursor-default disabled:opacity-50 disabled:hover:border-stone-400 disabled:hover:bg-stone-200'

function DialogBox({ dialog, onDone }: { dialog: OpenDialog; onDone: (v: string | null) => void }) {
  const { spec } = dialog
  const buttons = spec.buttons ?? [{ label: 'OK', value: 'ok', primary: true }]
  const ref = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{ px: number; py: number; x: number; y: number; scale: number } | null>(null)
  // null until dragged: an undragged dialog is centred by the layout, which
  // is also what keeps it centred if the CRT resizes under it
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (spec.icon === 'error') sounds.error()
    else sounds.open()
    primaryRef.current?.focus()
  }, [spec.icon])

  const startDrag = (e: React.PointerEvent) => {
    const el = ref.current
    const surface = el?.offsetParent as HTMLElement | null
    if (!el || !surface) return
    const rect = el.getBoundingClientRect()
    const host = surface.getBoundingClientRect()
    // the 3D CRT scales the screen DOM, so client px are not desktop px
    const scale = host.width / surface.clientWidth || 1
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      x: (rect.left - host.left) / scale,
      y: (rect.top - host.top) / scale,
      scale,
    }
    setPos({ x: (rect.left - host.left) / scale, y: (rect.top - host.top) / scale })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setPos({
      x: d.x + (e.clientX - d.px) / d.scale,
      y: Math.max(0, d.y + (e.clientY - d.py) / d.scale),
    })
  }
  const endDrag = () => {
    dragRef.current = null
  }

  const press = (value: string | null) => {
    sounds.click()
    onDone(value)
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
      role="dialog"
      aria-modal="true"
      aria-label={spec.title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          press(null)
        }
        if (e.key === 'Enter' && !spec.bare && !(e.target as HTMLElement).closest('textarea')) {
          e.preventDefault()
          press(buttons.find((b) => b.primary)?.value ?? buttons[0].value)
        }
      }}
      style={{
        width: spec.width ?? 330,
        ...(pos
          ? { left: pos.x, top: pos.y }
          : { left: '50%', top: '42%', transform: 'translate(-50%, -50%)' }),
      }}
      className="pointer-events-auto absolute flex max-h-full flex-col overflow-hidden rounded-lg border border-blue-800 bg-stone-100 shadow-2xl shadow-stone-950/60"
    >
      <header
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex h-8 shrink-0 cursor-grab touch-none items-center gap-2 bg-gradient-to-b from-blue-600 to-blue-700 px-2.5 select-none active:cursor-grabbing"
      >
        <h2 className="flex-1 truncate text-xs font-semibold text-white">{spec.title}</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={() => press(null)}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex size-5 cursor-pointer items-center justify-center rounded-[4px] border border-white/70 bg-[radial-gradient(circle_at_30%_25%,#f4ab90_0%,#e0563a_50%,#a92c10_100%)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.55)] hover:brightness-115"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M2.8 2.8 L9.2 9.2 M9.2 2.8 L2.8 9.2"
              stroke="white"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      {spec.body ? (
        <div className="flex min-h-0 flex-1 flex-col">{spec.body(onDone)}</div>
      ) : (
        <div className="flex items-start gap-3 px-4 py-4">
          {spec.icon && <span className="mt-0.5 shrink-0">{GLYPHS[spec.icon]}</span>}
          <div className="min-w-0 text-xs leading-relaxed text-stone-700">{spec.message}</div>
        </div>
      )}

      {!spec.bare && (
        <div className="flex shrink-0 justify-end gap-2 border-t border-stone-300 bg-stone-200 px-3 py-2">
          {buttons.map((b) => (
            <button
              key={b.value}
              type="button"
              ref={b.primary ? primaryRef : undefined}
              onClick={() => press(b.value)}
              className={`${dialogButtonClass} ${b.primary ? 'font-medium' : ''}`}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  )
}

/** mounted once by the desktop; every openDialog call lands here */
export function DialogLayer() {
  const open = useSyncExternalStore(subscribeDialogs, getDialogs)
  if (open.length === 0) return null
  const settle = (d: OpenDialog, value: string | null) => {
    set(stack.filter((x) => x.id !== d.id))
    d.resolve(value)
  }
  return (
    <div className="absolute inset-0 z-[4600] bg-stone-950/15">
      <AnimatePresence>
        {open.map((d) => (
          <DialogBox key={d.id} dialog={d} onDone={(v) => settle(d, v)} />
        ))}
      </AnimatePresence>
    </div>
  )
}
