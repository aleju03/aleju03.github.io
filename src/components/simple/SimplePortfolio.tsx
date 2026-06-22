import { useEffect } from 'react'
import { useI18n } from '../../i18n'
import { HOME_PATH, navigate } from '../../version'
import { OPEN_CHOOSER_EVENT } from '../../events'
import { MiniControls } from '../MiniControls'
import { Link } from './Link'
import { SimpleHome } from './SimpleHome'
import { SimpleProject } from './SimpleProject'

const BASE_TITLE = 'Alejandro Jiménez - Software Engineer'

export default function SimplePortfolio({ slug }: { slug: string | null }) {
  const { t, projects } = useI18n()
  const project = slug ? (projects.showcase.find((p) => p.slug === slug) ?? null) : null

  // an unknown /projects/<slug> bounces back to the overview
  useEffect(() => {
    if (slug && !project) navigate(HOME_PATH)
  }, [slug, project])

  // each page starts at the top and titles itself for shareable links
  useEffect(() => {
    window.scrollTo({ top: 0 })
    document.title = project ? `${project.name} — ${BASE_TITLE}` : BASE_TITLE
    return () => {
      document.title = BASE_TITLE
    }
  }, [slug, project])

  const openChooser = () => window.dispatchEvent(new Event(OPEN_CHOOSER_EVENT))

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-stone-200 dark:border-stone-800">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-5 py-4 sm:px-6">
          <Link
            to={HOME_PATH}
            aria-label={t.nav.backToTop}
            className="font-mono text-sm font-bold text-blue-600 dark:text-blue-400"
          >
            aj
          </Link>
          <MiniControls />
        </div>
      </header>

      <div className="flex-1">{project ? <SimpleProject project={project} /> : <SimpleHome />}</div>

      <footer className="border-t border-stone-200 dark:border-stone-800">
        <div className="mx-auto flex max-w-2xl flex-col gap-3 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <button
            type="button"
            onClick={openChooser}
            className="inline-flex items-center gap-1.5 self-start font-mono text-xs text-stone-500 underline decoration-stone-300 decoration-dotted underline-offset-4 transition-colors hover:text-stone-900 dark:decoration-stone-600 dark:hover:text-stone-100"
          >
            {t.simple.otherVersion} →
          </button>
          <p className="font-mono text-xs text-stone-400 dark:text-stone-500">{t.contact.footer}</p>
        </div>
      </footer>
    </div>
  )
}
