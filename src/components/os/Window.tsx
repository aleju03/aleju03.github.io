import { useRef } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
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

  // the Luna title bar buttons: glossy blue rounded squares with a thin
  // light border, the close one in red, grayed out on inactive windows
  const xpBtn = (red = false) =>
    `flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border transition hover:brightness-115 active:brightness-90 ${
      red
        ? 'border-white/70 bg-[radial-gradient(circle_at_30%_25%,#f4ab90_0%,#e0563a_50%,#a92c10_100%)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.55),inset_0_-2px_3px_rgba(255,180,150,0.35)]'
        : 'border-white/70 bg-[radial-gradient(circle_at_30%_25%,#9fbbf2_0%,#4a78d8_52%,#2b55b6_100%)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.55),inset_0_-2px_3px_rgba(160,200,255,0.4)]'
    } ${active ? '' : 'opacity-70 saturate-[0.3]'}`

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
          className={xpBtn()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <rect x="2" y="8.5" width="6" height="2.5" fill="white" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={win.maximized ? 'Restore' : 'Maximize'}
          onClick={() => {
            sounds.click()
            onToggleMaximize()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={xpBtn()}
        >
          {win.maximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M4 1.5h6.5V8H8.5" fill="none" stroke="white" strokeWidth="1.3" />
              <rect x="4" y="1.5" width="6.5" height="1.8" fill="white" />
              <rect x="1.5" y="4.5" width="6" height="6" fill="none" stroke="white" strokeWidth="1.3" />
              <rect x="1.5" y="4.5" width="6" height="1.8" fill="white" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="white" strokeWidth="1.3" />
              <rect x="1.5" y="1.5" width="9" height="2.2" fill="white" />
            </svg>
          )}
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          className={xpBtn(true)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.8 2.8 L9.2 9.2 M9.2 2.8 L2.8 9.2" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
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
