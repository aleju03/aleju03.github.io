import { ArrowLeftIcon, ArrowUpRightIcon, GithubLogoIcon } from '@phosphor-icons/react'
import type { ShowcaseProject } from '../../data/projects'
import { useI18n } from '../../i18n'
import { HOME_PATH } from '../../version'
import { Link } from './Link'

function SectionLabel({ children }: { children: string }) {
  return <h2 className="font-mono text-xs tracking-wide text-stone-500">{children}</h2>
}

export function SimpleProject({ project }: { project: ShowcaseProject }) {
  const { t } = useI18n()
  const { story, learned, gallery } = project.details

  return (
    <main className="mx-auto max-w-2xl px-5 pb-20 sm:px-6">
      <div className="pt-10 sm:pt-12">
        <Link
          to={HOME_PATH}
          className="inline-flex items-center gap-1.5 font-mono text-xs text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-100"
        >
          <ArrowLeftIcon size={13} weight="bold" />
          {t.simple.back}
        </Link>
      </div>

      <article className="mt-8">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900 sm:text-3xl dark:text-stone-50">
          {project.name}
        </h1>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium">
          {project.live && (
            <a
              href={project.live}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {project.liveLabel ?? t.simple.live}
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
            {t.work.source}
          </a>
        </div>

        <p className="mt-4 font-mono text-xs leading-relaxed text-stone-400 dark:text-stone-500">
          {project.tech.join(' · ')}
        </p>

        {/* building it */}
        <section className="mt-10 flex flex-col gap-3">
          <SectionLabel>{t.modal.buildingIt}</SectionLabel>
          {story.map((paragraph) => (
            <p
              key={paragraph.slice(0, 32)}
              className="text-[15px] leading-relaxed text-stone-600 dark:text-stone-400"
            >
              {paragraph}
            </p>
          ))}
        </section>

        {/* screenshots */}
        <section className="mt-10 flex flex-col gap-6">
          {gallery.map((shot) => (
            <figure key={shot.src}>
              <div className="flex items-center justify-center rounded-xl border border-stone-200 bg-stone-100 p-3 dark:border-stone-800 dark:bg-stone-950/60">
                <img
                  src={shot.src}
                  alt={shot.alt}
                  loading="lazy"
                  decoding="async"
                  className="max-h-[70vh] max-w-full rounded-lg border border-stone-200 object-contain dark:border-stone-800"
                />
              </div>
              <figcaption className="mt-2 text-xs text-stone-500 dark:text-stone-400">
                {shot.caption}
              </figcaption>
            </figure>
          ))}
        </section>

        {/* what I learned */}
        <section className="mt-10 flex flex-col gap-3">
          <SectionLabel>{t.modal.learned}</SectionLabel>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[15px] leading-relaxed text-stone-600 marker:text-stone-400 dark:text-stone-400 dark:marker:text-stone-600">
            {learned.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <div className="mt-12 border-t border-stone-200 pt-6 dark:border-stone-800">
          <Link
            to={HOME_PATH}
            className="inline-flex items-center gap-1.5 font-mono text-xs text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-100"
          >
            <ArrowLeftIcon size={13} weight="bold" />
            {t.simple.back}
          </Link>
        </div>
      </article>
    </main>
  )
}
