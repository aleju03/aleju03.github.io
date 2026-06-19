import { Suspense, lazy, useEffect, useState } from 'react'
import { I18nProvider } from './i18n'
import { VersionChooser } from './components/VersionChooser'
import {
  matchProjectSlug,
  persistVersion,
  readInitialVersion,
  readQueryVersion,
  stripVersionParam,
  type PortfolioVersion,
} from './version'
import { NAVIGATE_EVENT, OPEN_CHOOSER_EVENT } from './events'

const FullPortfolio = lazy(() => import('./components/FullPortfolio'))
const SimplePortfolio = lazy(() => import('./components/simple/SimplePortfolio'))

// blank cream panel while a portfolio chunk loads, so there is no flash of the
// wrong color before the lazy bundle resolves
const fallback = <div className="min-h-dvh bg-stone-50 dark:bg-stone-950" />

function VersionRouter() {
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [version, setVersion] = useState<PortfolioVersion | null>(
    // a direct /projects/<slug> link is inherently the simple version, so the
    // "back to overview" link lands on the simple home instead of the chooser
    () => readInitialVersion() ?? (matchProjectSlug() ? 'simple' : null),
  )
  const [chooserOpen, setChooserOpen] = useState(false)

  // consume a ?v= deep link once: remember it, then tidy the address bar
  useEffect(() => {
    const queryVersion = readQueryVersion()
    if (queryVersion) {
      persistVersion(queryVersion)
      stripVersionParam()
    }
  }, [])

  // follow back/forward and in-app (pushState) navigation
  useEffect(() => {
    const sync = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', sync)
    window.addEventListener(NAVIGATE_EVENT, sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(NAVIGATE_EVENT, sync)
    }
  }, [])

  // re-open the chooser from anywhere (footer link, command palette)
  useEffect(() => {
    const open = () => setChooserOpen(true)
    window.addEventListener(OPEN_CHOOSER_EVENT, open)
    return () => window.removeEventListener(OPEN_CHOOSER_EVENT, open)
  }, [])

  const projectSlug = matchProjectSlug(pathname)
  const forceFull = pathname.startsWith('/alejOS')

  const choose = (next: PortfolioVersion) => {
    persistVersion(next)
    setVersion(next)
    setChooserOpen(false)
  }

  // /alejOS always boots the full site, skipping the chooser entirely
  if (forceFull) {
    return (
      <Suspense fallback={fallback}>
        <FullPortfolio />
      </Suspense>
    )
  }

  const showSimple = projectSlug !== null || version === 'simple'
  const showChooser = chooserOpen || (version === null && projectSlug === null)

  return (
    <>
      {showSimple ? (
        <Suspense fallback={fallback}>
          <SimplePortfolio slug={projectSlug} />
        </Suspense>
      ) : version === 'full' ? (
        <Suspense fallback={fallback}>
          <FullPortfolio />
        </Suspense>
      ) : null}
      {showChooser && (
        <VersionChooser
          current={version}
          onChoose={choose}
          onDismiss={version !== null ? () => setChooserOpen(false) : undefined}
        />
      )}
    </>
  )
}

function App() {
  return (
    <I18nProvider>
      <VersionRouter />
    </I18nProvider>
  )
}

export default App
