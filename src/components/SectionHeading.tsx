/*
  The chapter heading: a numbered, oversized display line whose characters are
  wiped up from behind a mask as the section scrolls in.

  The reveal is SCRUBBED, not triggered. `Reveal` (the site's older, quieter
  entrance) plays a fixed 600ms fade the moment a section crosses the viewport
  and is then done; this maps character offsets directly onto scroll position,
  so the type assembles under your thumb and runs backwards if you scroll back.
  That difference (motion you are driving rather than motion that happened at
  you) is most of what separates a portfolio from a piece of art direction.

  Accessibility comes first, not after: the real string sits in an sr-only span
  so the heading is one clean text node to a screen reader, and the split
  characters are aria-hidden decoration. Under reduced motion the whole
  apparatus collapses to a plain heading with no motion values allocated.
*/

import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react'

/** one character, wiped up from behind its own mask on a slice of the scroll */
function Char({
  char,
  progress,
  start,
  end,
}: {
  char: string
  progress: MotionValue<number>
  start: number
  end: number
}) {
  const y = useTransform(progress, [start, end], ['110%', '0%'])
  const opacity = useTransform(progress, [start, Math.min(1, start + (end - start) * 0.4)], [0, 1])
  return (
    <span className="inline-block overflow-hidden pb-[0.08em] align-bottom">
      <motion.span className="inline-block" style={{ y, opacity }}>
        {char}
      </motion.span>
    </span>
  )
}

/**
 * Words with the character offset each one starts at, so every character can be
 * given its own slice of the scroll without counting during render.
 */
function splitWords(text: string) {
  let offset = 0
  return text.split(' ').map((word) => {
    const chars = [...word]
    const entry = { chars, offset }
    offset += chars.length + 1 // the space counts, or the stagger jumps at word breaks
    return entry
  })
}

interface SectionHeadingProps {
  /** the chapter marker, e.g. "01", rendered in mono beside a rule */
  index?: string
  children: string
  /** the eyebrow line under the number, when the section wants one */
  eyebrow?: string
  className?: string
  as?: 'h2' | 'h1'
  /**
   * Drive the reveal from someone else's 0..1 instead of this heading's own
   * position. A heading inside a `position: sticky` stage holds a CONSTANT
   * viewport rect for as long as it is pinned, so self-scrubbing degenerates
   * to a frozen value and the characters never come out from behind their
   * masks; the machine act passes its runway's progress in for exactly that.
   */
  progress?: MotionValue<number>
}

export function SectionHeading({
  index,
  children,
  eyebrow,
  className = '',
  as: Tag = 'h2',
  progress,
}: SectionHeadingProps) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  // the heading finishes assembling while it is still in the upper half of the
  // viewport, so you read a settled line rather than one still moving
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start 0.95', 'start 0.4'],
  })
  const source = progress ?? scrollYProgress

  const words = splitWords(children)
  const total = Math.max(1, children.length)

  return (
    // declared, not sniffed: `stations.ts` measures this block so the flight
    // path knows where a chapter's type ends and can route its lane changes
    // clear of it. See the "no ink on the type" note in flightPath.ts.
    <div ref={ref} data-station-head className={className}>
      {(index || eyebrow) && (
        <div className="mb-5 flex items-center gap-4 font-mono text-xs tracking-[0.18em] text-stone-500 uppercase">
          {index && <span className="text-blue-600 dark:text-blue-400">{index}</span>}
          <span aria-hidden className="h-px flex-1 bg-stone-300 dark:bg-stone-700" />
          {eyebrow && <span>{eyebrow}</span>}
        </div>
      )}
      <Tag className="font-display text-[clamp(2.75rem,8.5vw,6.5rem)] leading-[0.92] tracking-[-0.03em] text-stone-900 dark:text-stone-50">
        <span className="sr-only">{children}</span>
        {reduce ? (
          <span aria-hidden>{children}</span>
        ) : (
          <span aria-hidden className="block">
            {words.map(({ chars, offset }, w) => (
              <span key={`w-${w}`}>
                <span className="inline-block whitespace-nowrap">
                  {chars.map((char, i) => {
                    // each character owns a slice of the scroll, so the line
                    // assembles left to right instead of arriving all at once
                    const start = ((offset + i) / total) * 0.55
                    return (
                      <Char
                        key={`${char}-${i}`}
                        char={char}
                        progress={source}
                        start={start}
                        end={start + 0.45}
                      />
                    )
                  })}
                </span>
                {w < words.length - 1 ? ' ' : null}
              </span>
            ))}
          </span>
        )}
      </Tag>
    </div>
  )
}
