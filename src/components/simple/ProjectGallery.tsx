import { useEffect, useState } from 'react'
import { CaretLeftIcon, CaretRightIcon, MagnifyingGlassPlusIcon } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'
import type { GalleryImage, ShowcaseProject } from '../../data/projects'
import { useI18n } from '../../i18n'
import { Lightbox } from '../Lightbox'

// screen cutout of the iPhone frame PNG (matches WorkGrid's PommePlate frame)
const SCREEN = { left: '6.71%', top: '3.09%', width: '86.73%', height: '93.94%' }

const navButton =
  'absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-stone-200 bg-white/90 text-stone-600 shadow-sm backdrop-blur transition hover:scale-105 hover:text-stone-900 active:scale-95 dark:border-stone-700 dark:bg-stone-900/90 dark:text-stone-300 dark:hover:text-stone-100'

export function ProjectGallery({
  gallery,
  kind,
  className = 'mt-10',
}: {
  gallery: GalleryImage[]
  kind: ShowcaseProject['imageKind']
  className?: string
}) {
  const { t } = useI18n()
  const reduce = useReducedMotion()
  const [active, setActive] = useState(0)
  const [dir, setDir] = useState(0)
  const [zoomed, setZoomed] = useState(false)

  // preload every shot so swapping never flashes a blank frame
  useEffect(() => {
    for (const shot of gallery) {
      const img = new Image()
      img.src = shot.src
    }
  }, [gallery])

  if (gallery.length === 0) return null

  const count = gallery.length
  const shot = gallery[active]
  const isPhone = kind === 'phone'
  const multi = count > 1

  const paginate = (d: number) => {
    setDir(d)
    setActive((i) => (i + d + count) % count)
  }
  const jump = (i: number) => {
    if (i === active) return
    setDir(i > active ? 1 : -1)
    setActive(i)
  }

  const slide: Variants = {
    enter: (d: number) => ({ opacity: 0, x: reduce ? 0 : d >= 0 ? '8%' : '-8%' }),
    center: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: reduce ? 0 : d >= 0 ? '-8%' : '8%' }),
  }
  const transition = reduce
    ? { duration: 0.15 }
    : { x: { type: 'spring' as const, stiffness: 260, damping: 30 }, opacity: { duration: 0.22 } }

  // the swappable, draggable media — shared by the phone + wide layouts
  const media = (
    <motion.div
      className={`absolute inset-0 ${multi ? 'cursor-grab active:cursor-grabbing' : ''}`}
      drag={multi ? 'x' : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.12}
      onDragEnd={(_e, info) => {
        const power = info.offset.x + info.velocity.x * 0.25
        if (power < -50) paginate(1)
        else if (power > 50) paginate(-1)
      }}
    >
      <AnimatePresence custom={dir} initial={false}>
        <motion.img
          key={shot.src}
          src={shot.src}
          alt={shot.alt}
          loading="eager"
          decoding="async"
          draggable={false}
          custom={dir}
          variants={slide}
          initial="enter"
          animate="center"
          exit="exit"
          transition={transition}
          className={`absolute inset-0 h-full w-full select-none object-contain ${isPhone ? '' : 'p-3'}`}
        />
      </AnimatePresence>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={t.modal.expand}
        className="absolute top-2 right-2 z-10 flex h-8 w-8 cursor-zoom-in items-center justify-center rounded-full bg-stone-950/55 text-white opacity-70 backdrop-blur transition hover:scale-105 hover:opacity-100 active:scale-95"
      >
        <MagnifyingGlassPlusIcon size={15} weight="bold" />
      </button>
    </motion.div>
  )

  const arrows = multi && (
    <>
      <button
        type="button"
        onClick={() => paginate(-1)}
        aria-label={t.modal.prev}
        className={`${navButton} left-2`}
      >
        <CaretLeftIcon size={16} weight="bold" />
      </button>
      <button
        type="button"
        onClick={() => paginate(1)}
        aria-label={t.modal.next}
        className={`${navButton} right-2`}
      >
        <CaretRightIcon size={16} weight="bold" />
      </button>
    </>
  )

  return (
    <figure
      className={className}
      aria-roledescription="carousel"
      aria-label={t.modal.gallery}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          paginate(-1)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          paginate(1)
        }
      }}
    >
      {isPhone ? (
        <div className="relative">
          <div className="relative mx-auto aspect-[1/2] h-[min(64vh,520px)]">
            {/* screenshot rides under the frame, clipped to the screen cutout */}
            <div className="absolute overflow-hidden bg-black" style={SCREEN}>
              {media}
            </div>
            <img
              src="/projects/iphone-frame.png"
              alt=""
              aria-hidden
              decoding="async"
              className="pointer-events-none relative h-full w-full drop-shadow-md"
            />
          </div>
          {arrows}
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-xl border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-950/60">
          <div className="relative aspect-[16/10]">{media}</div>
          {arrows}
        </div>
      )}

      <figcaption className="mt-3 flex items-center justify-between gap-4 text-xs text-stone-500 dark:text-stone-400">
        <span className="min-w-0">{shot.caption}</span>
        {multi && (
          <span className="flex shrink-0 items-center gap-1.5">
            {gallery.map((g, i) => (
              <button
                key={g.src}
                type="button"
                onClick={() => jump(i)}
                aria-label={`${t.modal.screenshot} ${i + 1}`}
                aria-current={i === active}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === active
                    ? 'w-5 bg-stone-500 dark:bg-stone-300'
                    : 'w-1.5 bg-stone-300 hover:bg-stone-400 dark:bg-stone-700 dark:hover:bg-stone-600'
                }`}
              />
            ))}
          </span>
        )}
      </figcaption>

      {zoomed && (
        <Lightbox
          src={shot.src}
          alt={shot.alt}
          caption={shot.caption}
          closeLabel={t.modal.closeZoom}
          onClose={() => setZoomed(false)}
        />
      )}
    </figure>
  )
}
