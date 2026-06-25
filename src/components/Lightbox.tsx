import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { XIcon } from '@phosphor-icons/react'
import { lockPageForOverlay } from '../overlay'

/**
 * Full-screen image viewer for inspecting dense screenshots (e.g. admin dashboards)
 * that are unreadable when shrunk into a gallery. Renders above any open modal; the
 * page lock is reference-counted, so nesting over the project modal is safe.
 */
export function Lightbox({
  src,
  alt,
  caption,
  closeLabel,
  onClose,
}: {
  src: string
  alt: string
  caption?: string
  closeLabel: string
  onClose: () => void
}) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus({ preventScroll: true })
    const unlock = lockPageForOverlay()
    return () => {
      unlock()
      previous?.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 p-4 outline-none sm:p-8"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <motion.div
        className="absolute inset-0 bg-stone-950/85 sm:backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        aria-hidden="true"
      />
      <motion.img
        src={src}
        alt={alt}
        decoding="async"
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduce ? 0.12 : 0.22, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[88dvh] max-w-[min(100%,90rem)] rounded-lg object-contain shadow-2xl shadow-stone-950/60"
      />
      {caption && (
        <p className="relative max-w-2xl text-center text-xs text-stone-300">{caption}</p>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="absolute top-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white/90 backdrop-blur transition hover:scale-105 hover:bg-white/20 active:scale-95"
      >
        <XIcon size={18} weight="bold" />
      </button>
    </div>,
    document.body,
  )
}
