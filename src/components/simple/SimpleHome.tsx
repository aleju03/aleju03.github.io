import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  EnvelopeSimpleIcon,
  GithubLogoIcon,
  LinkedinLogoIcon,
} from '@phosphor-icons/react'
import { email, github, linkedin } from '../../data/projects'
import { SKILLS } from '../../data/skills'
import { STOPS, type Stop } from '../../data/experience'
import { useI18n } from '../../i18n'
import { projectPath } from '../../version'
import { LocalTime } from '../LocalTime'
import { linkifyBio } from '../linkifyBio'
import { Link } from './Link'

function SectionLabel({ children }: { children: string }) {
  return <h2 className="font-mono text-xs tracking-wide text-stone-500">{children}</h2>
}

/** compact version of the full site's experience tile */
function StopLogo({ logo }: { logo: Stop['logo'] }) {
  return (
    <div
      className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800 ${
        logo.tile === 'dark' ? 'bg-zinc-900 p-1.5' : logo.tile === 'light' ? 'bg-white p-1.5' : ''
      }`}
    >
      <img
        src={logo.src}
        alt={logo.alt}
        loading="lazy"
        className={
          logo.tile === 'full'
            ? 'h-full w-full object-cover'
            : 'max-h-full max-w-full object-contain'
        }
      />
    </div>
  )
}

const inlineLink =
  'inline-flex items-center gap-1.5 text-stone-600 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100'

export function SimpleHome() {
  const { language, t, projects } = useI18n()
  const moreProjects = [...projects.secondary, ...projects.more]

  return (
    <main className="mx-auto max-w-2xl px-5 pb-20 sm:px-6">
      {/* intro */}
      <header className="pt-12 sm:pt-16">
        <h1 className="text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl dark:text-stone-50">
          Alejandro Jiménez
        </h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-1.5 font-mono text-sm text-stone-500">
          <span>
            {t.simple.role} · {t.simple.location} ·
          </span>
          <LocalTime />
        </p>
        <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-stone-600 dark:text-stone-400">
          {t.about.paragraphs.map((paragraph) => (
            <p key={paragraph}>{linkifyBio(paragraph)}</p>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium">
          <a href={`mailto:${email}`} className={inlineLink}>
            <EnvelopeSimpleIcon size={15} weight="bold" />
            {email}
          </a>
          <a href={github} target="_blank" rel="noreferrer" className={inlineLink}>
            <GithubLogoIcon size={15} weight="bold" />
            GitHub
          </a>
          <a href={linkedin} target="_blank" rel="noreferrer" className={inlineLink}>
            <LinkedinLogoIcon size={15} weight="bold" />
            LinkedIn
          </a>
        </div>
      </header>

      {/* selected work */}
      <section className="mt-14">
        <SectionLabel>{t.sections.selectedWork}</SectionLabel>
        <ol className="mt-3">
          {projects.showcase.map((project) => (
            <li
              key={project.slug}
              className="border-t border-stone-200 py-5 dark:border-stone-800"
            >
              <div className="flex items-baseline justify-between gap-4">
                <Link
                  to={projectPath(project.slug)}
                  aria-label={`${t.simple.viewProject} ${project.name}`}
                  className="group inline-flex items-center gap-1.5 text-base font-semibold tracking-tight text-stone-900 transition-colors hover:text-blue-600 dark:text-stone-100 dark:hover:text-blue-400"
                >
                  {project.name}
                  <ArrowRightIcon
                    size={14}
                    weight="bold"
                    aria-hidden="true"
                    className="text-stone-400 transition-transform group-hover:translate-x-0.5 group-hover:text-blue-600 dark:group-hover:text-blue-400"
                  />
                </Link>
                {project.live && (
                  <a
                    href={project.live}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    {t.simple.live}
                    <ArrowUpRightIcon size={12} weight="bold" />
                  </a>
                )}
              </div>
              <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
                {project.description}
              </p>
              <p className="mt-2 font-mono text-xs text-stone-400 dark:text-stone-500">
                {project.tech.slice(0, 5).join(' · ')}
              </p>
            </li>
          ))}
        </ol>
        {/* the smaller stuff, as a single quiet line */}
        <div className="border-t border-stone-200 pt-5 dark:border-stone-800">
          <p className="font-mono text-xs leading-relaxed text-stone-400 dark:text-stone-500">
            {moreProjects.map((project, i) => (
              <span key={project.repo}>
                {i > 0 && <span className="text-stone-300 dark:text-stone-700"> · </span>}
                <a
                  href={project.repo}
                  target="_blank"
                  rel="noreferrer"
                  className="transition-colors hover:text-stone-700 dark:hover:text-stone-200"
                >
                  {project.name}
                </a>
              </span>
            ))}
            <span className="text-stone-300 dark:text-stone-700"> · </span>
            <a
              href={github}
              target="_blank"
              rel="noreferrer"
              className="text-stone-500 transition-colors hover:text-stone-800 dark:hover:text-stone-200"
            >
              {t.sections.allRepositories} ↗
            </a>
          </p>
        </div>
      </section>

      {/* experience */}
      <section className="mt-14">
        <SectionLabel>{t.sections.experience}</SectionLabel>
        <ol className="mt-3">
          {STOPS.map((stop) => {
            const localized = stop.translations?.[language] ?? stop
            return (
              <li
                key={stop.org}
                className="flex items-center gap-3.5 border-t border-stone-200 py-4 dark:border-stone-800"
              >
                <StopLogo logo={stop.logo} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                  <div className="min-w-0">
                    <a
                      href={stop.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group inline-flex items-center gap-1 text-sm font-semibold tracking-tight text-stone-900 transition-colors hover:text-blue-600 dark:text-stone-100 dark:hover:text-blue-400"
                    >
                      {stop.org}
                      <ArrowUpRightIcon
                        size={12}
                        weight="bold"
                        aria-hidden="true"
                        className="text-stone-400 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-400"
                      />
                    </a>
                    <p className="text-sm text-stone-600 dark:text-stone-400">{localized.role}</p>
                  </div>
                  <p className="shrink-0 font-mono text-xs text-stone-400 sm:text-right dark:text-stone-500">
                    {localized.period}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      {/* skills */}
      <section className="mt-14">
        <SectionLabel>{t.simple.skills}</SectionLabel>
        <p className="mt-3 font-mono text-sm leading-relaxed text-stone-500">
          {SKILLS.map((skill, i) => (
            <span key={skill.name}>
              {i > 0 && <span className="text-stone-300 dark:text-stone-700"> · </span>}
              <a
                href={skill.url}
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-stone-900 dark:hover:text-stone-100"
              >
                {skill.name}
              </a>
            </span>
          ))}
        </p>
      </section>
    </main>
  )
}
