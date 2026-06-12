import { ArrowUpRightIcon } from '@phosphor-icons/react'
import { github } from '../data/projects'
import { Reveal } from './Reveal'
import { TechList } from './TechList'
import { BlocksDoodle } from './Doodles'
import { useI18n } from '../i18n'

export function MoreProjects() {
  const { projects, t } = useI18n()

  return (
    <section className="border-t border-stone-200 dark:border-stone-800">
      <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <div className="flex items-end justify-between gap-6">
            <h2 className="text-3xl font-semibold tracking-tighter text-stone-900 sm:text-4xl dark:text-stone-50">
              {t.sections.moreProjects}
            </h2>
            <BlocksDoodle className="-mb-2 w-24 shrink-0 text-stone-800 sm:w-28 dark:text-stone-200" />
          </div>
        </Reveal>

        <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {projects.secondary.map((project, i) => (
            <Reveal key={project.name} delay={i * 0.08} className="h-full">
              <a
                href={project.repo}
                target="_blank"
                rel="noreferrer"
                className="group flex h-full gap-5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-stone-900/10 dark:border-stone-800 dark:bg-stone-900 dark:hover:shadow-stone-950/45"
              >
                <div
                  className={`flex w-28 shrink-0 items-center justify-center self-stretch rounded-lg p-3 sm:w-32 ${
                    project.tile === 'dark' ? 'bg-zinc-900' : 'bg-stone-100 dark:bg-stone-800'
                  }`}
                >
                  <img
                    src={project.image}
                    alt={project.imageAlt}
                    loading="lazy"
                    className="max-h-14 w-auto max-w-full object-contain"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-semibold tracking-tight text-stone-900 dark:text-stone-100">
                      {project.name}
                    </h3>
                    <ArrowUpRightIcon
                      size={15}
                      weight="bold"
                      className="mt-1 shrink-0 text-stone-400 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-400"
                    />
                  </div>
                  <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-400">
                    {project.description}
                  </p>
                  <TechList tech={project.tech} />
                </div>
              </a>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-12">
          <ul className="divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {projects.more.map((project) => (
              <li key={project.name}>
                <a
                  href={project.repo}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-center justify-between gap-4 py-4"
                >
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="font-medium text-stone-800 transition-colors group-hover:text-blue-600 dark:text-stone-200 dark:group-hover:text-blue-400">
                      {project.name}
                    </span>
                    <span className="text-sm text-stone-500">{project.description}</span>
                  </div>
                  <ArrowUpRightIcon
                    size={15}
                    weight="bold"
                    className="shrink-0 text-stone-400 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-400"
                  />
                </a>
              </li>
            ))}
          </ul>
          <a
            href={github}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-200"
          >
            {t.sections.allRepositories}
            <ArrowUpRightIcon size={13} weight="bold" />
          </a>
        </Reveal>
      </div>
    </section>
  )
}
