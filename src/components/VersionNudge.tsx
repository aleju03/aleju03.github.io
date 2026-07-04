import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRightIcon, XIcon } from '@phosphor-icons/react'
import { useI18n } from '../i18n'

// linger long enough to be read, then get out of the way on its own
const AUTO_HIDE_MS = 9000
// any real scroll means the visitor is exploring; stop floating over the content
const SCROLL_HIDE_PX = 160
// matches .nudge-out in index.css; a JS timer instead of animationend so the
// pill still unmounts under prefers-reduced-motion (where the animation is off)
const LEAVE_MS = 400

/**
 * The quiet replacement for gating first visits on the version chooser: the
 * full site loads directly and this single line floats over its bottom edge,
 * offering the short version. It fades away on its own (a few seconds, or as
 * soon as the visitor scrolls) and returns next visit; only the explicit ×
 * or picking a version anywhere ends it for good.
 */
export function VersionNudge({
  onAccept,
  onDismiss,
}: {
  onAccept: () => void
  onDismiss: () => void
}) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<'in' | 'leaving' | 'gone'>('in')
  // hold the auto-hide while the pointer or keyboard focus is on the pill,
  // so it can't vanish out from under a click
  const engaged = useRef(false)
  const leavePending = useRef(false)
  // set once the entrance finishes; leaving before that skips the exit
  // animation instead of flashing the pill in just to fade it out
  const shown = useRef(false)

  const leave = useCallback(() => {
    if (engaged.current) {
      leavePending.current = true
      return
    }
    leavePending.current = false
    setPhase((current) => (current !== 'gone' && shown.current ? 'leaving' : 'gone'))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(leave, AUTO_HIDE_MS)
    const onScroll = () => {
      if (window.scrollY > SCROLL_HIDE_PX) leave()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('scroll', onScroll)
    }
  }, [leave])

  useEffect(() => {
    if (phase !== 'leaving') return
    const timer = window.setTimeout(() => setPhase('gone'), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (phase === 'gone') return null

  const hold = () => {
    engaged.current = true
  }
  const release = () => {
    engaged.current = false
    if (leavePending.current) leave()
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom,0px))] z-30 flex justify-center px-5">
      <div
        onPointerEnter={hold}
        onPointerLeave={release}
        onFocusCapture={hold}
        onBlurCapture={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          release()
        }}
        onAnimationEnd={() => {
          shown.current = true
        }}
        className={`flex items-center gap-0.5 rounded-full border border-stone-200 bg-stone-50/90 py-1.5 pr-1.5 pl-4 shadow-sm backdrop-blur-sm dark:border-stone-800 dark:bg-stone-900/90 ${
          phase === 'leaving' ? 'nudge-out pointer-events-none' : 'nudge-in pointer-events-auto'
        }`}
      >
        <span className="font-mono text-xs text-stone-500 dark:text-stone-400">{t.nudge.lead}</span>
        <button
          type="button"
          onClick={onAccept}
          className="group flex items-center gap-1.5 rounded-full px-2 py-1 font-mono text-xs text-stone-700 underline decoration-stone-400 decoration-dotted underline-offset-4 transition-colors hover:text-teal-700 dark:text-stone-200 dark:decoration-stone-500 dark:hover:text-teal-400"
        >
          {t.versions.simple.title}
          <ArrowRightIcon
            size={11}
            weight="bold"
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5"
          />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t.nudge.dismiss}
          className="rounded-full p-1.5 text-stone-400 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-200"
        >
          <XIcon size={12} weight="bold" />
        </button>
      </div>
    </div>
  )
}
