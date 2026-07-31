import type { ReactNode } from 'react'
import { INK, INK_SOFT } from './paper'

/*
  The two marks that show up all over the pause screen's sheet: the hand-drawn
  rule under a heading, and the pencil note beside it. They are here rather
  than in `paper.ts` because that module is where the palette and the canvas
  texture live, and a file that exports both components and constants loses
  fast refresh.
*/

/** a rule drawn by hand rather than a border: it stretches to whatever it is
    under, and it is never quite level */
export function Rule({ className = '', color = INK }: { className?: string; color?: string }) {
  return (
    <svg
      viewBox="0 0 300 8"
      preserveAspectRatio="none"
      aria-hidden
      className={`block h-[7px] w-full ${className}`}
    >
      <path
        d="M2 5.4c38-2.2 74 1.4 112-.4 40-1.9 82-2.6 122 .9 22 1.9 44 .4 62-1.2"
        fill="none"
        stroke={color}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** the small print on the sheet: pencil, not marker */
export function Note({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[11px]" style={{ color: INK_SOFT }}>
      {children}
    </span>
  )
}
