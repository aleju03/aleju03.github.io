import { Suspense, lazy, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { ArrowUpRightIcon, ArrowsOutSimpleIcon, GithubLogoIcon } from '@phosphor-icons/react'
import type { ShowcaseProject } from '../data/projects'
import { Reveal } from './Reveal'
import { TechList } from './TechList'
import { ZigzagDoodle } from './Doodles'
import { useI18n } from '../i18n'

const ProjectModal = lazy(() =>
  import('./ProjectModal').then((m) => ({ default: m.ProjectModal })),
)

const primedImages = new Set<string>()

function primeImage(src: string) {
  if (primedImages.has(src)) return
  primedImages.add(src)
  const img = new Image()
  img.decoding = 'async'
  img.src = src
}

function primeProject(project: ShowcaseProject) {
  project.details.gallery.slice(0, 2).forEach((shot) => primeImage(shot.src))
}

function WorkCard({
  project,
  onOpen,
  sourceLabel,
  detailsLabel,
  wide = false,
}: {
  project: ShowcaseProject
  onOpen: () => void
  sourceLabel: string
  detailsLabel: string
  wide?: boolean
}) {
  /* phone shots come in portrait, so a single one drowns in the 16:10 pane — fan out three instead */
  const phoneShots = project.imageKind === 'phone' ? project.details.gallery.slice(0, 3) : null
  return (
    <article
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`${detailsLabel} ${project.name}`}
      onClick={onOpen}
      onFocus={() => primeProject(project)}
      onPointerDown={() => primeProject(project)}
      onPointerEnter={() => primeProject(project)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen()
        }
      }}
      className={`group flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm transition duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-stone-900/10 dark:border-stone-800 dark:bg-stone-900 dark:hover:shadow-stone-950/45 ${wide ? 'md:flex-row' : ''}`}
    >
      <div
        className={`relative border-b border-stone-200 bg-stone-100 p-4 dark:border-stone-800 dark:bg-stone-950/60 ${wide ? 'md:flex md:w-[55%] md:shrink-0 md:items-center md:border-r md:border-b-0' : ''}`}
      >
        {/* whole thumbnail, never cropped */}
        <div className={`flex aspect-[16/10] w-full items-center justify-center ${phoneShots ? 'gap-3 sm:gap-4' : ''}`}>
          {phoneShots ? (
            phoneShots.map((shot, i) => (
              /* real iPhone frame (PommePlate, CC0) with the screen punched out;
                 the screenshot sits underneath, positioned on the screen cutout */
              <div
                key={shot.src}
                className={`relative h-full shrink-0 transition-transform duration-500 ease-out ${
                  i === 1
                    ? 'z-10 group-hover:scale-[1.04]'
                    : `translate-y-2 ${i === 0 ? '-rotate-2 group-hover:-rotate-1' : 'rotate-2 group-hover:rotate-1'} group-hover:scale-[1.02]`
                }`}
                style={{ aspectRatio: '1 / 2' }}
              >
                {/* contain instead of cover: aspect slack becomes black bars that
                    blend with the notch/bezel rather than cropping the UI */}
                <div
                  className="absolute flex items-center justify-center bg-black"
                  style={{ left: '6.71%', top: '3.09%', width: '86.73%', height: '93.94%' }}
                >
                  <img
                    src={shot.src}
                    alt={shot.alt}
                    decoding="async"
                    loading="lazy"
                    className="h-full w-full object-contain"
                  />
                </div>
                <img
                  src="/projects/iphone-frame.png"
                  alt=""
                  aria-hidden
                  decoding="async"
                  loading="lazy"
                  className="relative h-full w-full drop-shadow-md"
                />
              </div>
            ))
          ) : (
            <img
              src={project.image}
              alt={project.imageAlt}
              decoding="async"
              loading="lazy"
              className="max-h-full max-w-full rounded-lg border border-stone-200 object-contain transition-transform duration-500 ease-out group-hover:scale-[1.02] dark:border-stone-800"
            />
          )}
        </div>
        <span className="absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-white/85 text-stone-600 opacity-0 shadow-sm backdrop-blur transition duration-300 group-hover:opacity-100 dark:border-stone-700 dark:bg-stone-900/85 dark:text-stone-300">
          <ArrowsOutSimpleIcon size={15} weight="bold" />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-6">
        <h3 className="text-lg font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          {project.name}
        </h3>
        <p className="flex-1 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
          {project.description}
        </p>
        <TechList tech={project.tech} />
        <div className="mt-1 flex flex-wrap items-center gap-5 text-sm font-medium">
          {project.live && (
            <a
              href={project.live}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
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
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-200"
          >
            <GithubLogoIcon size={15} weight="bold" />
            {sourceLabel}
          </a>
        </div>
      </div>
    </article>
  )
}

export function WorkGrid() {
  const { projects, t } = useI18n()
  const [selected, setSelected] = useState<ShowcaseProject | null>(null)
  const [featured, ...rest] = projects.showcase
  const openProject = (project: ShowcaseProject) => {
    primeProject(project)
    setSelected(project)
  }

  return (
    <section id="work" className="scroll-mt-16 border-t border-stone-200 dark:border-stone-800">
      <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <div className="flex items-center gap-5 sm:gap-10">
            <h2 className="shrink-0 text-3xl font-semibold tracking-tighter text-stone-900 sm:text-4xl dark:text-stone-50">
              {t.sections.selectedWork}
            </h2>
            <ZigzagDoodle className="hidden min-w-0 flex-1 text-stone-800 sm:block dark:text-stone-200" />
            <ZigzagDoodle short className="min-w-0 flex-1 text-stone-800 sm:hidden dark:text-stone-200" />
          </div>
        </Reveal>
        <Reveal className="mt-12">
          <WorkCard
            project={featured}
            sourceLabel={t.work.source}
            detailsLabel={t.work.viewDetails}
            wide
            onOpen={() => openProject(featured)}
          />
        </Reveal>
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          {rest.map((project, i) => (
            <Reveal key={project.name} delay={(i % 2) * 0.08} className="h-full">
              <WorkCard
                project={project}
                sourceLabel={t.work.source}
                detailsLabel={t.work.viewDetails}
                onOpen={() => openProject(project)}
              />
            </Reveal>
          ))}
        </div>
      </div>
      <Suspense fallback={null}>
        <AnimatePresence>
          {selected && (
            <ProjectModal
              key={selected.name}
              project={selected}
              labels={t.modal}
              sourceLabel={t.work.source}
              onClose={() => setSelected(null)}
            />
          )}
        </AnimatePresence>
      </Suspense>
    </section>
  )
}
