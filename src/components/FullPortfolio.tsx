import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Nav } from './Nav'
import { Progress } from './Progress'
import { CommandPalette } from './CommandPalette'
import { Hero } from './Hero'
import { WorkGrid } from './WorkGrid'
import { MoreProjects } from './MoreProjects'
import { Experience } from './Experience'
import { About } from './About'
import { Contact } from './Contact'
import { BOOT_OS_EVENT, OPEN_TERMINAL_EVENT } from '../events'

const Terminal = lazy(() => import('./Terminal').then((m) => ({ default: m.Terminal })))
const AlejOS = lazy(() => import('./os/AlejOS'))

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

export default function FullPortfolio() {
  return (
    <>
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
    </>
  )
}
