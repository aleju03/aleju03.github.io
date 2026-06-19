import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { ArrowRightIcon } from '@phosphor-icons/react'
import { BlocksDoodle, PageDoodle } from './Doodles'
import { VERSIONS, type PortfolioVersion } from '../version'
import { useI18n } from '../i18n'
import { MiniControls } from './MiniControls'

// each option wears the site's own language: the toy-block doodle (the same
// blocks as the draggable 3D hero) for the full site, a marker-stroke résumé
// sheet for the quick read
const DOODLES: Record<PortfolioVersion, typeof BlocksDoodle> = {
  full: BlocksDoodle,
  simple: PageDoodle,
}

const serif: CSSProperties = {
  fontFamily: "Georgia, 'Times New Roman', Times, serif",
  fontStyle: 'italic',
}

/**
 * Full-screen first-visit picker. Dependency-light (no motion) since it sits in
 * the initial bundle ahead of either lazy portfolio. Reopened over an
 * already-chosen version, `onDismiss` lets the visitor keep it; the first visit
 * is a required choice (nothing underneath to reveal).
 */
export function VersionChooser({
  current,
  onChoose,
  onDismiss,
}: {
  current: PortfolioVersion | null
  onChoose: (version: PortfolioVersion) => void
  onDismiss?: () => void
}) {
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement>(null)
  // keep the latest onDismiss without re-subscribing the mount-once effect below
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  // scroll lock + focus hand-off + tab trap for the dialog's lifetime
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // hand focus to the dialog itself (ring suppressed) so screen readers
    // announce it and Tab walks the controls — without painting a focus ring
    // on a card, which would read as a bordered box on every load
    panelRef.current?.focus({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismissRef.current?.()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus({ preventScroll: true })
    }
  }, [])

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="chooser-greeting"
      aria-describedby="chooser-note"
      tabIndex={-1}
      data-no-focus-ring
      className="fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-stone-50 outline-none dark:bg-stone-950"
    >
      <div className="flex items-center justify-between px-5 py-4 sm:px-8 sm:py-6">
        <span className="font-mono text-sm font-bold text-blue-600 dark:text-blue-400">aj</span>
        <MiniControls />
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-5 pb-20 sm:px-8">
        <div className="chooser-in" style={{ animation: 'chooser-in 0.5s ease-out both' }}>
          <p
            id="chooser-greeting"
            style={serif}
            className="text-3xl leading-tight text-stone-900 sm:text-4xl dark:text-stone-50"
          >
            {t.chooser.greeting}
          </p>
          <p className="mt-3 text-stone-600 dark:text-stone-400">{t.chooser.lead}</p>

          <div className="mt-10 flex flex-col gap-1">
            {VERSIONS.map((version) => {
              const copy = t.versions[version.id]
              const Doodle = DOODLES[version.id]
              const isCurrent = version.id === current
              const isFull = version.id === 'full'
              return (
                <button
                  key={version.id}
                  type="button"
                  onClick={() => onChoose(version.id)}
                  style={{ '--accent': version.accent } as CSSProperties}
                  className="group flex items-center gap-4 rounded-2xl px-3 py-4 text-left transition-colors hover:bg-stone-100 sm:gap-5 sm:px-4 dark:hover:bg-stone-900"
                >
                  <Doodle className="h-16 w-16 shrink-0 text-stone-700 sm:h-20 sm:w-20 dark:text-stone-300" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span
                        className={
                          isFull
                            ? 'font-display text-xl font-semibold tracking-tight text-stone-900 transition-colors group-hover:text-(--accent) sm:text-2xl dark:text-stone-50'
                            : 'font-mono text-lg text-stone-900 transition-colors group-hover:text-(--accent) sm:text-xl dark:text-stone-100'
                        }
                      >
                        {copy.title}
                      </span>
                      {isCurrent && (
                        <span className="rounded-full border border-stone-300 px-2 py-0.5 font-mono text-[10px] text-stone-500 dark:border-stone-700 dark:text-stone-400">
                          {t.chooser.current}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-sm leading-relaxed text-stone-600 dark:text-stone-400">
                      {copy.blurb}
                    </span>
                  </span>
                  <ArrowRightIcon
                    size={18}
                    weight="bold"
                    aria-hidden="true"
                    className="shrink-0 text-stone-300 transition-all group-hover:translate-x-0.5 group-hover:text-(--accent) dark:text-stone-600"
                  />
                </button>
              )
            })}
          </div>

          <div className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-2 px-3 sm:px-4">
            <p id="chooser-note" className="font-mono text-xs text-stone-400 dark:text-stone-500">
              {t.chooser.note}
            </p>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="font-mono text-xs text-stone-500 underline decoration-stone-300 decoration-dotted underline-offset-4 transition-colors hover:text-stone-900 dark:decoration-stone-600 dark:hover:text-stone-100"
              >
                {t.chooser.keep}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
