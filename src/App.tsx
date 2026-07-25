import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { I18nProvider } from './i18n'
import { VersionChooser } from './components/VersionChooser'
import { VersionNudge } from './components/VersionNudge'
import {
  isPcPath,
  isRoomPath,
  matchProjectSlug,
  persistNudgeDismissed,
  persistVersion,
  readInitialVersion,
  readNudgeDismissed,
  readQueryVersion,
  stripVersionParam,
  type PortfolioVersion,
} from './version'
import { NAVIGATE_EVENT, OPEN_CHOOSER_EVENT } from './events'

const FullPortfolio = lazy(() => import('./components/FullPortfolio'))
const SimplePortfolio = lazy(() => import('./components/simple/SimplePortfolio'))
const AlejOS = lazy(() => import('./components/os/AlejOS'))

// blank cream panel while a portfolio chunk loads, so there is no flash of the
// wrong color before the lazy bundle resolves
const fallback = <div className="min-h-dvh bg-stone-50 dark:bg-stone-950" />
// the OS boots onto a dark screen from the first frame, cream would flash
const osFallback = <div className="min-h-dvh bg-stone-950" />
// module-level so its identity is stable: AlejOS re-runs its boot effect
// whenever this object changes
const PC_BOOT = { detail: { flat: true } }

function VersionRouter() {
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [version, setVersion] = useState<PortfolioVersion | null>(
    // a direct /projects/<slug> link is inherently the simple version, so the
    // "back to overview" link lands on the simple home instead of the chooser
    () => readInitialVersion() ?? (matchProjectSlug() ? 'simple' : null),
  )
  const [chooserOpen, setChooserOpen] = useState(false)
  const [nudgeDismissed, setNudgeDismissed] = useState(readNudgeDismissed)

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

  // open the chooser from anywhere (footer link, command palette)
  useEffect(() => {
    const open = () => setChooserOpen(true)
    window.addEventListener(OPEN_CHOOSER_EVENT, open)
    return () => window.removeEventListener(OPEN_CHOOSER_EVENT, open)
  }, [])

  // the /pc desktop powered off and pushed '/': re-read it and render the site
  // where the machine was. Stable identity — AlejOS keys effects off this.
  const leavePc = useCallback(() => setPathname(window.location.pathname), [])

  const projectSlug = matchProjectSlug(pathname)
  // /alejOS and /room both mount the real site behind the OS: powering off or
  // leaving the room drops you onto the portfolio where the machine was
  const forceFull = pathname.startsWith('/alejOS') || isRoomPath(pathname)
  const forcePc = isPcPath(pathname)

  const choose = (next: PortfolioVersion) => {
    persistVersion(next)
    setVersion(next)
    setChooserOpen(false)
  }

  const dismissNudge = () => {
    persistNudgeDismissed()
    setNudgeDismissed(true)
  }

  // /pc: the machine on its own. The portfolio never mounts behind it, so the
  // hero's 3D blocks stay unloaded, and AlejOS is asked for its flat bezel
  // instead of the CRT in the room — this route pulls in no three.js at all.
  // Powering off hands the URL back to '/', and re-reading it here swaps the
  // real site in without a reload.
  if (forcePc) {
    return (
      <Suspense fallback={osFallback}>
        <AlejOS initialBoot={PC_BOOT} onPowerOff={leavePc} />
      </Suspense>
    )
  }

  // /alejOS always boots the full site, with no nudge or chooser on top
  if (forceFull) {
    return (
      <Suspense fallback={fallback}>
        <FullPortfolio />
      </Suspense>
    )
  }

  // the full site is the default landing; no explicit choice just means the
  // résumé nudge floats over it until it's followed or waved away
  const showSimple = projectSlug !== null || version === 'simple'
  const showNudge = version === null && projectSlug === null && !nudgeDismissed

  return (
    <>
      {showSimple ? (
        <Suspense fallback={fallback}>
          <SimplePortfolio slug={projectSlug} />
        </Suspense>
      ) : (
        <Suspense fallback={fallback}>
          <FullPortfolio />
        </Suspense>
      )}
      {showNudge && <VersionNudge onAccept={() => choose('simple')} onDismiss={dismissNudge} />}
      {chooserOpen && (
        <VersionChooser
          current={showSimple ? 'simple' : 'full'}
          onChoose={choose}
          onDismiss={() => setChooserOpen(false)}
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
