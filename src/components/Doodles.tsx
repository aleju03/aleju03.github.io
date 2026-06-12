/**
 * Hand-drawn brand doodles, same language as the generated webps in public/brand:
 * soft ink linework, flat warm fills, one cobalt accent. The feTurbulence filter
 * roughens the vectors so they read as marker strokes instead of geometry.
 */

interface DoodleProps {
  className?: string
}

function RoughFilter({ id, freq = 0.035, scale = 4 }: { id: string; freq?: number; scale?: number }) {
  return (
    <filter id={id} x="-8%" y="-15%" width="116%" height="130%">
      <feTurbulence type="fractalNoise" baseFrequency={freq} numOctaves={2} seed={7} result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale={scale} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  )
}

/** Four-pointed spark, like the sun in the contact illustration */
function Spark({ x, y, r }: { x: number; y: number; r: number }) {
  const d = `M ${x} ${y - r} C ${x + r * 0.14} ${y - r * 0.3} ${x + r * 0.3} ${y - r * 0.14} ${x + r} ${y} C ${x + r * 0.3} ${y + r * 0.14} ${x + r * 0.14} ${y + r * 0.3} ${x} ${y + r} C ${x - r * 0.14} ${y + r * 0.3} ${x - r * 0.3} ${y + r * 0.14} ${x - r} ${y} C ${x - r * 0.3} ${y - r * 0.14} ${x - r * 0.14} ${y - r * 0.3} ${x} ${y - r} Z`
  return <path d={d} className="fill-blue-600 dark:fill-blue-500" stroke="none" />
}

/** Wide zigzag divider with one loop and a cobalt spark at the end.
 *  `short` trims it to a few peaks so it fits next to headings on phones. */
export function ZigzagDoodle({ className, short = false }: DoodleProps & { short?: boolean }) {
  const id = short ? 'rough-zigzag-short' : 'rough-zigzag'
  return (
    <svg
      viewBox={short ? '600 0 600 150' : '0 0 1200 150'}
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <RoughFilter id={id} freq={0.009} scale={7} />
      </defs>
      <g
        filter={`url(#${id})`}
        stroke="currentColor"
        strokeWidth={short ? 6 : 4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {short ? (
          <path d="M 632 110 L 706 40 L 778 106 L 850 42 L 922 102 L 990 48 L 1056 92 L 1080 76" />
        ) : (
          <path d="M 30 88 L 105 42 L 180 112 L 262 32 L 338 104 L 400 52 L 440 96 C 458 112 478 108 490 94 C 506 76 498 50 476 52 C 452 54 446 86 466 98 C 480 106 502 100 518 86 L 560 44 L 632 110 L 706 40 L 778 106 L 850 42 L 922 102 L 990 48 L 1056 92 L 1080 76" />
        )}
      </g>
      <Spark x={1135} y={62} r={short ? 30 : 22} />
    </svg>
  )
}

/** Loose stack of toy blocks, one cobalt, one tumbling */
export function BlocksDoodle({ className }: DoodleProps) {
  return (
    <svg viewBox="0 0 240 240" fill="none" aria-hidden="true" className={className}>
      <defs>
        <RoughFilter id="rough-blocks" />
      </defs>
      <g
        filter="url(#rough-blocks)"
        stroke="currentColor"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* base cube */}
        <rect
          x={62}
          y={158}
          width={78}
          height={60}
          rx={5}
          transform="rotate(-1.5 101 188)"
          className="fill-stone-200 dark:fill-stone-800"
        />
        {/* middle cobalt block */}
        <rect
          x={74}
          y={114}
          width={60}
          height={44}
          rx={5}
          transform="rotate(2.5 104 136)"
          className="fill-blue-600 dark:fill-blue-500"
        />
        {/* triangle roof */}
        <path
          d="M 105 70 L 138 114 L 74 116 Z"
          className="fill-stone-200 dark:fill-stone-800"
        />
        {/* tumbling block */}
        <rect
          x={166}
          y={172}
          width={42}
          height={42}
          rx={5}
          transform="rotate(16 187 193)"
          className="fill-stone-200 dark:fill-stone-800"
        />
        {/* motion lines */}
        <path d="M 158 150 C 165 144 172 142 180 142" />
        <path d="M 148 166 C 153 161 158 159 164 158" />
        {/* ground line */}
        <path d="M 48 222 L 222 224" />
      </g>
    </svg>
  )
}

/** Dotted path winding up a hill to a cobalt flag */
export function FlagDoodle({ className }: DoodleProps) {
  return (
    <svg viewBox="0 0 240 240" fill="none" aria-hidden="true" className={className}>
      <defs>
        <RoughFilter id="rough-flag" />
      </defs>
      <g
        filter="url(#rough-flag)"
        stroke="currentColor"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* hill */}
        <path
          d="M 14 212 C 50 128 186 124 228 212"
          className="fill-stone-200 dark:fill-stone-800"
        />
        {/* winding dotted path */}
        <path
          d="M 30 222 C 74 212 58 190 94 180 C 126 172 102 160 122 150"
          strokeDasharray="0.5 12"
          strokeWidth={5.5}
        />
        {/* grass tuft on the lower right slope, clear of the flag */}
        <path d="M 178 190 C 180 184 180 180 179 176 M 187 191 C 190 186 191 182 192 179" />
        {/* flag pole */}
        <path d="M 126 144 L 128 84" />
      </g>
      {/* pennant, unfiltered so the cobalt stays crisp */}
      <path
        d="M 129 86 C 145 88 158 92 172 99 C 157 104 144 107 130 108 Z"
        className="fill-blue-600 dark:fill-blue-500"
        stroke="currentColor"
        strokeWidth={4}
        strokeLinejoin="round"
        filter="url(#rough-flag)"
      />
    </svg>
  )
}
