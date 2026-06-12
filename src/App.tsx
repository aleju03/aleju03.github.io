import { Suspense, lazy } from 'react'
import { Nav } from './components/Nav'
import { Progress } from './components/Progress'
import { CommandPalette } from './components/CommandPalette'
import { Hero } from './components/Hero'
import { WorkGrid } from './components/WorkGrid'
import { MoreProjects } from './components/MoreProjects'
import { Experience } from './components/Experience'
import { About } from './components/About'
import { Contact } from './components/Contact'

const Terminal = lazy(() => import('./components/Terminal').then((m) => ({ default: m.Terminal })))
const AlejOS = lazy(() => import('./components/os/AlejOS'))

function App() {
  return (
    <>
      <Progress />
      <Nav />
      <CommandPalette />
      <Suspense fallback={null}>
        <Terminal />
      </Suspense>
      <Suspense fallback={null}>
        <AlejOS />
      </Suspense>
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

export default App
