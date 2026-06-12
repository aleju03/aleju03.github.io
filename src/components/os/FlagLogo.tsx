import { useId } from 'react'

/*
  The AJU flag: four glossy panes caught mid-wave, drawn by hand so
  it nods at a certain 2001 operating system without tracing it. The stroke
  matches each pane's fill purely to round the corners.
*/

const PANES = [
  { d: 'M 9,21 C 17,13 26,12 38,16 L 38,42 C 26,38 17,39 9,47 Z', from: '#f6693c', to: '#c52f0d' },
  { d: 'M 44,17 C 56,21 70,21 84,10 L 84,36 C 70,47 56,47 44,43 Z', from: '#a8db2c', to: '#5f9c0a' },
  { d: 'M 9,53 C 17,45 26,44 38,48 L 38,74 C 26,70 17,71 9,79 Z', from: '#52a0f5', to: '#1c54c0' },
  { d: 'M 44,49 C 56,53 70,53 84,42 L 84,68 C 70,79 56,79 44,75 Z', from: '#ffd84d', to: '#eda20a' },
]

export function FlagLogo({ size = 64, className }: { size?: number; className?: string }) {
  const id = useId()
  return (
    <svg
      width={size}
      height={(size * 84) / 96}
      viewBox="0 0 96 84"
      aria-hidden
      className={className}
    >
      <defs>
        {PANES.map((p, i) => (
          <linearGradient key={i} id={`${id}-${i}`} x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0" stopColor={p.from} />
            <stop offset="1" stopColor={p.to} />
          </linearGradient>
        ))}
      </defs>
      <g strokeLinejoin="round" strokeWidth={3}>
        {PANES.map((p, i) => (
          <path key={i} d={p.d} fill={`url(#${id}-${i})`} stroke={`url(#${id}-${i})`} />
        ))}
      </g>
    </svg>
  )
}
