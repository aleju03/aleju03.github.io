import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import {
  ArrowUpRightIcon,
  ChartLineUpIcon,
  GithubLogoIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { CSSProperties } from 'react'
import type { ShowcaseProject } from '../data/projects'
import { lockPageForOverlay } from '../overlay'
import { techBrands } from '../data/techBrands'

function TechBadge({ name }: { name: string }) {
  const brand = techBrands[name]
  const color = brand?.icon && !brand.mono ? `#${brand.icon.hex}` : 'currentColor'
  const className =
    'flex items-center gap-2 rounded-full border border-stone-200 bg-white py-1.5 pr-3.5 pl-2.5 text-sm text-stone-700 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:border-(--brand) hover:shadow-md focus:outline-none focus-visible:border-(--brand) focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300'
  const contents = (
    <>
      {brand?.icon ? (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 bg-(--brand)"
          style={{
            mask: `url(${brand.icon.src}) center / contain no-repeat`,
            WebkitMask: `url(${brand.icon.src}) center / contain no-repeat`,
          }}
        />
      ) : (
        <ChartLineUpIcon size={16} aria-hidden="true" />
      )}
      {name}
    </>
  )

  return (
    <li>
      {brand?.url ? (
        <a
          href={brand.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${name} website`}
          style={{ '--brand': color } as CSSProperties}
          className={className}
        >
          {contents}
        </a>
      ) : (
        <span style={{ '--brand': color } as CSSProperties} className={className}>
          {contents}
        </span>
      )}
    </li>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <h3 className="font-mono text-xs text-stone-500">{children}</h3>
}

export function ProjectModal({
  project,
  labels,
  sourceLabel,
  onClose,
}: {
  project: ShowcaseProject
  labels: {
    builtWith: string
    buildingIt: string
    learned: string
    close: string
    screenshot: string
  }
  sourceLabel: string
  onClose: () => void
}) {
  const reduce = useReducedMotion()
  const panelRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const { gallery, story, learned } = project.details
  const shot = gallery[active]

  // scroll lock + focus hand-off for the dialog's lifetime
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panelRef.current?.focus({ preventScroll: true })
    const unlock = lockPageForOverlay()
    return () => {
      unlock()
      previous?.focus({ preventScroll: true })
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !panelRef.current) return
    const focusables = panelRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      onKeyDown={handleKeyDown}
    >
      <motion.div
        className="absolute inset-0 bg-stone-950/55 sm:backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        style={{ willChange: 'opacity' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.div
        className="relative w-full max-w-3xl"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 28, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
        transition={{ duration: reduce ? 0.12 : 0.22, ease: [0.16, 1, 0.3, 1] }}
        style={{ willChange: 'transform, opacity' }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={project.name}
          tabIndex={-1}
          className="max-h-[88dvh] overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-2xl shadow-stone-950/30 outline-none dark:border-stone-800 dark:bg-stone-900 dark:shadow-stone-950/60"
        >
          {/* gallery */}
          <div className="border-b border-stone-200 bg-stone-100 p-4 dark:border-stone-800 dark:bg-stone-950/60">
            <div className="flex aspect-[16/10] items-center justify-center">
              <motion.img
                key={shot.src}
                src={shot.src}
                alt={shot.alt}
                decoding="async"
                loading="eager"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                className="max-h-full max-w-full rounded-lg border border-stone-200 object-contain dark:border-stone-800"
              />
            </div>
            <p className="mt-3 text-center text-xs text-stone-500 dark:text-stone-400">
              {shot.caption}
            </p>
            {gallery.length > 1 && (
              <div className="mt-3 flex justify-center gap-2 overflow-x-auto pb-1">
                {gallery.map((img, i) => (
                  <button
                    key={img.src}
                    type="button"
                    onClick={() => setActive(i)}
                    aria-label={`${labels.screenshot} ${i + 1}: ${img.alt}`}
                    aria-current={i === active}
                    className={`flex h-14 w-[5.5rem] shrink-0 items-center justify-center overflow-hidden rounded-md border transition ${
                      i === active
                        ? 'border-blue-500 opacity-100'
                        : 'border-stone-200 opacity-75 hover:opacity-100 dark:border-stone-800'
                    }`}
                  >
                    <img
                      src={img.src}
                      alt=""
                      decoding="async"
                      loading="lazy"
                      className="max-h-full max-w-full object-contain"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-7 p-6 sm:p-8">
            <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <h2 className="text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
                {project.name}
              </h2>
              <div className="flex flex-wrap items-center gap-5 text-sm font-medium">
                {project.live && (
                  <a
                    href={project.live}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    {project.liveLabel}
                    <ArrowUpRightIcon size={14} weight="bold" />
                  </a>
                )}
                <a
                  href={project.repo}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-200"
                >
                  <GithubLogoIcon size={15} weight="bold" />
                  {sourceLabel}
                </a>
              </div>
            </header>

            <section className="flex flex-col gap-2.5">
              <SectionLabel>{labels.builtWith}</SectionLabel>
              <ul className="flex flex-wrap gap-2">
                {project.tech.map((t) => (
                  <TechBadge key={t} name={t} />
                ))}
              </ul>
            </section>

            <section className="flex flex-col gap-2.5">
              <SectionLabel>{labels.buildingIt}</SectionLabel>
              {story.map((paragraph) => (
                <p
                  key={paragraph.slice(0, 32)}
                  className="text-sm leading-relaxed text-stone-600 dark:text-stone-400"
                >
                  {paragraph}
                </p>
              ))}
            </section>

            <section className="flex flex-col gap-2.5">
              <SectionLabel>{labels.learned}</SectionLabel>
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-stone-600 marker:text-stone-400 dark:text-stone-400 dark:marker:text-stone-600">
                {learned.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label={labels.close}
          className="absolute top-3 right-5 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-stone-200 bg-white/90 text-stone-600 shadow-sm transition hover:scale-105 hover:text-stone-900 active:scale-95 dark:border-stone-700 dark:bg-stone-900/90 dark:text-stone-300 dark:hover:text-stone-100 sm:backdrop-blur"
        >
          <XIcon size={18} weight="bold" />
        </button>
      </motion.div>
    </div>,
    document.body,
  )
}
