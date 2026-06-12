import { useRef } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from '@phosphor-icons/react'
import { sounds } from './sounds'

/*
  One AlejOS window: dragged by the title bar, resized from the bottom-right
  corner, minimize/maximize/close in the corner. The parent owns all window
  state; this component just reports gestures back up.
*/

export interface WinState {
  id: string
  title: string
  icon: ReactNode
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized: boolean
  maximized: boolean
}

interface WindowProps {
  win: WinState
  active: boolean
  onFocus: () => void
  onClose: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onMove: (x: number, y: number) => void
  onResize: (w: number, h: number) => void
  children: ReactNode
}

export function Window({
  win,
  active,
  onFocus,
  onClose,
  onMinimize,
  onToggleMaximize,
  onMove,
  onResize,
  children,
}: WindowProps) {
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const sizeRef = useRef<{ px: number; py: number; w: number; h: number } | null>(null)

  const startDrag = (e: React.PointerEvent) => {
    if (win.maximized) return
    dragRef.current = { px: e.clientX, py: e.clientY, x: win.x, y: win.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    onMove(d.x + e.clientX - d.px, Math.max(0, d.y + e.clientY - d.py))
  }
  const endDrag = () => {
    dragRef.current = null
  }

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation()
    sizeRef.current = { px: e.clientX, py: e.clientY, w: win.w, h: win.h }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveResize = (e: React.PointerEvent) => {
    const s = sizeRef.current
    if (!s) return
    onResize(Math.max(320, s.w + e.clientX - s.px), Math.max(220, s.h + e.clientY - s.py))
  }
  const endResize = () => {
    sizeRef.current = null
  }

  const frame = win.maximized
    ? { left: 0, top: 0, width: '100%', height: '100%' }
    : { left: win.x, top: win.y, width: win.w, height: win.h }

  const buttonCls =
    'flex size-6 cursor-pointer items-center justify-center rounded-sm bg-white/15 text-white transition-colors hover:bg-white/30'

  return (
    <motion.section
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      aria-label={win.title}
      style={{ ...frame, zIndex: win.z, display: win.minimized ? 'none' : undefined }}
      className={`pointer-events-auto absolute flex flex-col overflow-hidden bg-stone-100 text-left shadow-2xl shadow-stone-950/50 ${
        win.maximized ? '' : 'rounded-lg'
      } ${active ? 'border border-blue-800' : 'border border-stone-400'}`}
      onPointerDown={onFocus}
    >
      <header
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onToggleMaximize}
        className={`flex h-9 shrink-0 touch-none items-center gap-2 px-2.5 select-none ${
          active
            ? 'bg-gradient-to-b from-blue-600 to-blue-700'
            : 'bg-gradient-to-b from-stone-500 to-stone-600'
        } ${win.maximized ? '' : 'cursor-grab active:cursor-grabbing'}`}
      >
        <span className="text-white [&_svg]:block">{win.icon}</span>
        <h2 className="flex-1 truncate text-xs font-semibold text-white">{win.title}</h2>
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => {
            sounds.click()
            onMinimize()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={buttonCls}
        >
          <MinusIcon size={12} weight="bold" />
        </button>
        <button
          type="button"
          aria-label={win.maximized ? 'Restore' : 'Maximize'}
          onClick={() => {
            sounds.click()
            onToggleMaximize()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={buttonCls}
        >
          {win.maximized ? <CopyIcon size={12} weight="bold" /> : <SquareIcon size={12} weight="bold" />}
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          className={`${buttonCls} hover:bg-stone-950/40`}
        >
          <XIcon size={12} weight="bold" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      {!win.maximized && (
        <div
          aria-hidden
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className="absolute right-0 bottom-0 size-4 cursor-se-resize touch-none"
        />
      )}
    </motion.section>
  )
}
