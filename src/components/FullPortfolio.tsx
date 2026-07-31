import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Nav } from './Nav'
import { Progress } from './Progress'
import { CommandPalette } from './CommandPalette'
import { Cursor } from './Cursor'
import { Hero } from './Hero'
import { WorkGrid } from './WorkGrid'
import { MoreProjects } from './MoreProjects'
import { Experience } from './Experience'
import { About } from './About'
import { Machine } from './Machine'
import { Contact } from './Contact'
import { BOOT_OS_EVENT, OPEN_TERMINAL_EVENT } from '../events'
import { isOsPath, isPcPath } from '../version'
import { wireAudio } from '../audio/wire'

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
  // both entrances that mount the site behind the OS pre-activate the loader;
  // /pc never gets here (App renders AlejOS on its own for that one)
  const [bootRequest, setBootRequest] = useState<{ detail?: unknown } | null>(() =>
    isOsPath() && !isPcPath() ? {} : null,
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
  // the score attaches to the events spine, not to components; it waits for a
  // gesture before it loads Howler or renders a single sample
  useEffect(wireAudio, [])

  return (
    <>
      <Progress />
      <Nav />
      <CommandPalette />
      <Cursor />
      <TerminalLoader />
      <AlejOSLoader />
      <main>
        <Hero />
        <WorkGrid />
        <MoreProjects />
        <Experience />
        <About />
        <Machine />
      </main>
      <Contact />
    </>
  )
}
