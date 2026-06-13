import { useId } from 'react'

/*
  The AlejOS mark: a custom A boot glyph. The geometry borrows the material
  language of CRT glass and early-2000s chrome, not any OS flag silhouette.
*/

const A_MARK =
  'M 10,77 L 37.2,11.2 C 39.3,6.3 43.1,4 48,4 C 52.9,4 56.8,6.3 58.7,11.2 L 86,77 H 68.4 L 62.6,62.3 H 33.3 L 27.5,77 Z M 39.1,48.7 H 56.8 L 47.9,25.5 Z'
const INNER_EDGE = 'M 39.1,48.7 H 56.8 L 47.9,25.5 Z'
const HIGHLIGHTS = [
  'M 20.3,69.5 L 41.1,16.1',
  'M 54.8,16.3 L 76.2,69.3',
  'M 35.7,58.4 H 60.2',
]

export function AlejLogo({
  size = 64,
  className,
  outlined = false,
}: {
  size?: number
  className?: string
  /** white halo + drop shadow, the way the mark sits on the start button */
  outlined?: boolean
}) {
  const id = useId()
  const compact = size <= 36

  return (
    <svg
      width={size}
      height={(size * 84) / 96}
      viewBox="0 0 96 84"
      aria-hidden
      className={className}
    >
      <defs>
        <linearGradient
          id={`${id}-chrome`}
          x1="17"
          y1="8"
          x2="82"
          y2="78"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.18" stopColor="#e0f9ff" />
          <stop offset="0.48" stopColor="#68c4fb" />
          <stop offset="0.78" stopColor="#236fd6" />
          <stop offset="1" stopColor="#12388f" />
        </linearGradient>
        <linearGradient id={`${id}-shade`} x1="48" y1="4" x2="48" y2="84" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.4" stopColor="#fff" stopOpacity="0.02" />
          <stop offset="0.68" stopColor="#00164e" stopOpacity="0.12" />
          <stop offset="1" stopColor="#00164e" stopOpacity="0.34" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <path d={A_MARK} fillRule="evenodd" />
        </clipPath>
      </defs>
      {outlined && (
        <g
          fill="#fff"
          stroke="#fff"
          strokeWidth={9}
          strokeLinejoin="round"
          style={{ filter: 'drop-shadow(1px 2px 1px rgba(0,0,0,0.42))' }}
        >
          <path d={A_MARK} fillRule="evenodd" />
        </g>
      )}
      <g
        fillRule="evenodd"
        strokeLinejoin="round"
        strokeWidth={2}
        style={{
          filter: outlined
            ? undefined
            : 'drop-shadow(0 2px 2px rgba(0,0,0,0.45)) drop-shadow(0 0 3px rgba(255,255,255,0.18))',
        }}
      >
        <path d={A_MARK} fill={`url(#${id}-chrome)`} stroke="#071d5f" strokeOpacity="0.45" />
        <path d={A_MARK} fill={`url(#${id}-shade)`} stroke="#fff" strokeOpacity="0.32" />
      </g>
      {!compact && (
        <path
          d={INNER_EDGE}
          fill="none"
          stroke="#061a55"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.2"
          opacity="0.36"
        />
      )}
      {!compact && (
        <g clipPath={`url(#${id}-clip)`}>
          {[16, 23, 30, 37, 44, 51, 58, 65, 72].map((y) => (
            <path
              key={y}
              d={`M 6 ${y} H 90`}
              stroke="#fff"
              strokeWidth="1"
              opacity={y < 38 ? 0.18 : 0.1}
            />
          ))}
        </g>
      )}
      {!compact && (
        <g fill="none" stroke="#fff" strokeLinecap="round" opacity="0.46">
          {HIGHLIGHTS.map((d, i) => (
            <path key={i} d={d} strokeWidth={i === 2 ? 3 : 4} />
          ))}
        </g>
      )}
    </svg>
  )
}
