import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Nav } from './components/Nav'
import { Progress } from './components/Progress'
import { CommandPalette } from './components/CommandPalette'
import { Hero } from './components/Hero'
import { WorkGrid } from './components/WorkGrid'
import { MoreProjects } from './components/MoreProjects'
import { Experience } from './components/Experience'
import { About } from './components/About'
import { Contact } from './components/Contact'
import { I18nProvider } from './i18n'
import { BOOT_OS_EVENT, OPEN_TERMINAL_EVENT } from './events'

const Terminal = lazy(() => import('./components/Terminal').then((m) => ({ default: m.Terminal })))
const AlejOS = lazy(() => import('./components/os/AlejOS'))

function TerminalLoader() {
  const [active, setActive] = useState(false)
  const activeRef = useRef(false)

  useEffect(() => {
    const activate = () => {
      if (activeRef.current) return
      activeRef.current = true
      setActive(true)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        activate()
      }
    }

    window.addEventListener(OPEN_TERMINAL_EVENT, activate)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener(OPEN_TERMINAL_EVENT, activate)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  if (!active) return null

  return (
    <Suspense fallback={null}>
      <Terminal initialOpen />
    </Suspense>
  )
}

function AlejOSLoader() {
  const [bootRequest, setBootRequest] = useState<{ detail?: unknown } | null>(() =>
    window.location.pathname === '/alejOS' ? {} : null,
  )
  const active = bootRequest !== null
  const activeRef = useRef(active)

  useEffect(() => {
    const activate = (e: Event) => {
      if (activeRef.current) return
      activeRef.current = true
      setBootRequest({ detail: e instanceof CustomEvent ? e.detail : undefined })
    }

    window.addEventListener(BOOT_OS_EVENT, activate)
    return () => window.removeEventListener(BOOT_OS_EVENT, activate)
  }, [])

  if (!active) return null

  return (
    <Suspense fallback={null}>
      <AlejOS initialBoot={bootRequest} />
    </Suspense>
  )
}

function App() {
  return (
    <I18nProvider>
      <Progress />
      <Nav />
      <CommandPalette />
      <TerminalLoader />
      <AlejOSLoader />
      <main>
        <Hero />
        <WorkGrid />
        <MoreProjects />
        <Experience />
        <About />
      </main>
      <Contact />
    </I18nProvider>
  )
}

export default App
