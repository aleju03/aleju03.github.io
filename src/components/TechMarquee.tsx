/*
  A full-bleed band of oversized tool names drifting in opposite directions,
  sped up and dragged around by the page's scroll velocity.

  It is deliberately NOT the tools list. `ToolsGrid` is a real <dl> of real
  links grouped by category, and turning that into a moving rail would make a
  useful thing worse to use: you cannot click a chip that is sliding away, and
  the grouping carries meaning. So this is a separate, purely graphic band,
  aria-hidden, sitting under the list it decorates: the same words as type,
  moving, for the people who are looking rather than reading.

  The transform is written straight to the DOM from the shared scroll frame
  rather than through React state: a marquee that re-renders a component tree
  sixty times a second is the reason "just add a marquee" gets a reputation.
*/

import { useEffect, useRef } from 'react'
import { onScrollFrame } from '../scroll/progress'

const ROWS = [
  ['TypeScript', 'React', 'Node', 'Three.js', 'Postgres', 'Docker', 'Vite', 'Python'],
  ['Next.js', 'Tailwind', 'Flutter', 'Redis', 'FastAPI', 'SQLite', 'Unity', 'Expo'],
]

/** base drift in pixels per second, before scroll velocity is folded in */
const DRIFT = [26, -34]

function Row({ words, index }: { words: string[]; index: number }) {
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let offset = 0
    let width = 0
    const measure = () => {
      // the words are rendered twice; one copy's width is the wrap distance
      width = track.scrollWidth / 2
    }
    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(track)

    const off = onScrollFrame(({ velocity, dt }) => {
      if (width === 0) return
      // scrolling shoves the rails; they keep their own drift when you stop
      offset += (DRIFT[index] + velocity * (index === 0 ? 0.35 : -0.35)) * dt
      // wrap into [-width, 0) so the duplicated copy always covers the gap
      offset = ((offset % width) + width) % width
      track.style.transform = `translate3d(${-offset}px, 0, 0)`
    })

    return () => {
      off()
      resizeObserver.disconnect()
    }
  }, [index])

  return (
    <div className="overflow-hidden">
      <div ref={trackRef} className="flex w-max will-change-transform">
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0">
            {words.map((word) => (
              <span
                key={`${copy}-${word}`}
                className="font-display px-6 text-[clamp(2rem,6vw,4.5rem)] leading-none tracking-[-0.02em] whitespace-nowrap text-stone-200 dark:text-stone-800"
              >
                {word}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function TechMarquee() {
  return (
    <div aria-hidden className="flex select-none flex-col gap-2 py-4">
      {ROWS.map((words, i) => (
        <Row key={i} words={words} index={i} />
      ))}
    </div>
  )
}
