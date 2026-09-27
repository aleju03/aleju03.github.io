import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { EMOTES, WHEEL_DEAD, wheelSlice, type EmoteName } from '../../game/player/emotes'
import { INK, INK_SOFT, MARK, paperTexture } from './paper'

/*
  The emote wheel, which is a board game's spinner: a disc of the pause
  sheet's own card stock taped over the middle of the screen, nine doodles
  pencilled round its rim, a card arrow on a brass split pin in the middle,
  and the one you are pointing at circled with the same terracotta marker the
  pause sheet selects with. It had to be an object from this world rather
  than a radial menu from any shooter, and a spinner is the radial menu that
  existed first.

  It is only drawn. The walk holds the pointer, so the wheel has no cursor
  and nothing to click: CrtScene sends the mouse's movement here through
  `aim` while the key is held (the view stops turning while it does) and asks
  `wheelSlice` itself which emote to play when the key comes up. `aim` turns
  the arrow by writing its transform straight onto the element, and only a
  change of slice goes through React, so a mouse reporting at a thousand
  hertz costs one style write per event rather than a render.

  Every icon is hand-written SVG in a 48-unit box, drawn in the sheet's ink
  and roughened by the same feTurbulence trick the site's doodles use, so the
  lines wobble like a pencil's rather than sitting on the pixel grid.
*/

export interface EmoteWheelApi {
  /** the cursor's offset from the middle, screen pixels, +y down */
  aim: (x: number, y: number) => void
}

const R = 176 // the disc, in the drawing's units
const HUB = 50
const ICON_R = 116
const N = EMOTES.length

/** the disc's edge: a circle cut by hand with scissors, deterministic */
const edge = (() => {
  const pts: string[] = []
  const steps = 72
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    const r = R + Math.sin(a * 3 + 0.7) * 1.6 + Math.sin(a * 7 + 2.1) * 0.9 + Math.sin(a * 13) * 0.5
    pts.push(`${(Math.sin(a) * r).toFixed(1)},${(-Math.cos(a) * r).toFixed(1)}`)
  }
  return `M${pts.join('L')}Z`
})()

/** a pencilled spoke between two slices, bowed a little */
const spoke = (i: number) => {
  const a = ((i + 0.5) / N) * Math.PI * 2
  const bow = (i % 2 ? 1 : -1) * 2.2
  const x0 = Math.sin(a) * (HUB + 6)
  const y0 = -Math.cos(a) * (HUB + 6)
  const x1 = Math.sin(a) * (R - 14)
  const y1 = -Math.cos(a) * (R - 14)
  const mx = (x0 + x1) / 2 + Math.cos(a) * bow
  const my = (y0 + y1) / 2 + Math.sin(a) * bow
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`
}

/** the marker ring round the chosen doodle: one loop that overshoots its
    own start, the way a hand circles something */
const RING = 'M-30 -8C-32 -30 -6 -40 16 -35C36 -30 42 -8 36 12C29 33 2 40 -18 32C-34 25 -38 6 -33 -10C-30 -20 -22 -27 -12 -31'

const ink = { stroke: INK, strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const
const fillPaper = { ...ink, fill: '#f3ead6' } as const

/** the nine doodles, 48 units square, centred on (24, 24) */
function Icon({ name }: { name: EmoteName }) {
  switch (name) {
    case 'wave':
      return (
        <g {...ink}>
          {/* a raised mitten, thumb out, and the air it is moving */}
          <path {...fillPaper} d="M17 40c-3-6-4-14-3-21 1-5 4-8 8-8s8 3 9 8c1 6 0 14-3 21" />
          <path {...fillPaper} d="M14 26c-4-2-7-5-7-9 0-2 2-3 4-2 3 2 4 5 5 8" />
          <path d="M34 8c3 2 5 5 5 9M38 4c4 3 7 8 7 13M9 9C6 12 5 15 5 18" />
        </g>
      )
    case 'thumbs':
      return (
        <g {...ink}>
          {/* a mitten closed into a fist with the thumb straight up */}
          <path {...fillPaper} d="M13 26c0-4 3-6 7-6h12c4 0 7 3 7 7v6c0 5-4 8-9 8H20c-4 0-7-3-7-7z" />
          <path {...fillPaper} d="M22 21c-1-5 0-11 2-14 2-2 5-1 5 2 0 4-1 8-1 12" />
          <path d="M20 30h14M20 35h12" />
        </g>
      )
    case 'clap':
      return (
        <g {...ink}>
          {/* two mittens meeting, and the smack between them */}
          <path {...fillPaper} d="M10 42c-2-8-1-18 3-24 3-4 7-3 8 1l1 23" />
          <path {...fillPaper} d="M38 42c2-8 1-18-3-24-3-4-7-3-8 1l-1 23" />
          <path d="M24 8v5M16 10l2 4M32 10l-2 4" />
        </g>
      )
    case 'laugh':
      return (
        <g {...ink}>
          {/* a bean in stitches: eyes squeezed shut, mouth wide */}
          <path {...fillPaper} d="M9 30c0-12 6-22 15-22s15 10 15 22c0 7-6 12-15 12S9 37 9 30z" />
          <path d="M15 21l4 2-4 2M33 21l-4 2 4 2" />
          <path {...ink} fill={INK} d="M16 29c2 6 14 6 16 0z" />
          <path d="M40 10c2-1 3-1 4 0M42 15c1-1 3-1 4 0" strokeWidth={2} />
        </g>
      )
    case 'dance':
      return (
        <g {...ink}>
          {/* two beamed notes and a wiggle */}
          <path d="M16 36V14l20-5v22" />
          <path d="M16 18l20-5" />
          <ellipse {...ink} fill={INK} cx="12" cy="37" rx="5" ry="4" transform="rotate(-18 12 37)" />
          <ellipse {...ink} fill={INK} cx="32" cy="32" rx="5" ry="4" transform="rotate(-18 32 32)" />
          <path d="M4 12c2-2 3 2 5 0s3 2 5 0" strokeWidth={2} />
        </g>
      )
    case 'joy':
      return (
        <g {...ink}>
          {/* a bean off the ground with both arms up */}
          <path {...fillPaper} d="M16 30c0-9 3-16 8-16s8 7 8 16c0 5-3 8-8 8s-8-3-8-8z" />
          <path d="M17 22c-4-3-6-7-7-12M31 22c4-3 6-7 7-12" />
          <path d="M20 38l-1 3M28 38l1 3" />
          <path d="M8 46h10M30 46h10" strokeWidth={2} />
          <path d="M21 22h0M27 22h0" strokeWidth={3} />
        </g>
      )
    case 'flex':
      return (
        <g {...ink}>
          {/* an arm bent up, the muscle bulging */}
          <path {...fillPaper} d="M6 38c4-1 10-2 16-2 6 0 11-3 13-8 1-4 0-8-2-11l-3-6c-1-3 2-5 5-3 5 3 7 9 7 15 0 11-8 20-20 21-6 0-11 0-16-1z" />
          <path d="M22 30c1-5 5-8 9-8" />
          <path d="M14 18c1-2 3-3 5-2M9 22c0-2 1-3 3-3" strokeWidth={2} />
        </g>
      )
    case 'facepalm':
      return (
        <g {...ink}>
          {/* a head bowed into a mitten */}
          <path {...fillPaper} d="M8 30c0-12 7-21 16-21s16 9 16 21c0 7-7 11-16 11S8 37 8 30z" />
          <path {...fillPaper} d="M17 44c-1-8 0-15 4-19 3-3 8-3 10 0 2 3 1 8-2 11" />
          <path d="M31 22h5" />
        </g>
      )
    case 'sit':
      return (
        <g {...ink}>
          {/* a bean sat on the floor, legs out in front */}
          <path {...fillPaper} d="M10 34c0-10 3-20 9-20s9 8 9 18c0 5-4 8-9 8s-9-2-9-6z" />
          <path d="M26 36h14M25 32h13" />
          <path d="M12 30c-2 3-4 6-5 9" />
          <path d="M4 42h40" strokeWidth={2} />
          <path d="M22 22h0" strokeWidth={3} />
        </g>
      )
  }
}

export function EmoteWheel({
  labels,
  hub,
  ref,
}: {
  /** in EMOTES order */
  labels: readonly string[]
  /** what the middle says when the arrow rests on it */
  hub: string
  ref?: Ref<EmoteWheelApi>
}) {
  const [sel, setSel] = useState(-1)
  const selRef = useRef(-1)
  const arrow = useRef<SVGGElement>(null)
  const stock = useMemo(() => paperTexture(), [])

  useImperativeHandle(ref, () => ({
    aim: (x, y) => {
      const s = wheelSlice(x, y, WHEEL_DEAD)
      const el = arrow.current
      if (el) {
        const lift = Math.min(1, Math.hypot(x, y) / WHEEL_DEAD)
        // the card arrow swings to the cursor and sits up off the pin as it
        // leaves the hub
        el.style.transform = `rotate(${(Math.atan2(x, -y) * 180) / Math.PI}deg) scale(${0.72 + 0.28 * lift})`
      }
      if (s !== selRef.current) {
        selRef.current = s
        setSel(s)
      }
    },
  }), [])

  return (
    <div
      className="pointer-events-none absolute top-1/2 left-1/2 z-20 select-none"
      style={{ width: 400, height: 400, marginLeft: -200, marginTop: -200 }}
      aria-hidden
    >
      <svg
        viewBox="-200 -200 400 400"
        width={400}
        height={400}
        className="emote-wheel-in overflow-visible"
        style={{ filter: 'drop-shadow(0 6px 10px rgba(30,20,10,0.4))' }}
      >
        <defs>
          <pattern id="ew-stock" patternUnits="userSpaceOnUse" width="256" height="256" x="-128" y="-128">
            <image href={stock} width="256" height="256" />
          </pattern>
          <filter id="ew-rough" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves={2} seed={3} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
        <g transform="rotate(-2.5)">
          {/* the disc, cut from the sheet's stock, with a pencil line just
              inside its edge and round the hub */}
          <path d={edge} fill="url(#ew-stock)" stroke="rgba(90,70,45,0.35)" strokeWidth="1" />
          <g filter="url(#ew-rough)">
            <circle r={R - 9} fill="none" stroke={INK_SOFT} strokeWidth="1.4" strokeDasharray="520 6 300 9" />
            <circle r={HUB} fill="none" stroke={INK_SOFT} strokeWidth="1.4" />
            {EMOTES.map((_, i) => (
              <path key={i} d={spoke(i)} fill="none" stroke={INK_SOFT} strokeWidth="1.3" strokeLinecap="round" />
            ))}
          </g>
          {/* the doodles, each with its word pencilled underneath */}
          {EMOTES.map((e, i) => {
            const a = (i / N) * Math.PI * 2
            const x = Math.sin(a) * ICON_R
            const y = -Math.cos(a) * ICON_R
            const on = i === sel
            return (
              <g key={e.name} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
                <g filter="url(#ew-rough)" transform={`translate(-24 -30) ${on ? 'scale(1.08)' : ''}`}>
                  <Icon name={e.name} />
                </g>
                <text
                  y="31"
                  textAnchor="middle"
                  className="font-display"
                  style={{ fontSize: 13, fontWeight: on ? 600 : 500, fill: on ? INK : INK_SOFT, letterSpacing: 0.2 }}
                >
                  {labels[i]}
                </text>
                {on && (
                  <path
                    d={RING}
                    transform={`rotate(${(i * 47) % 360}) scale(1.28 1.18)`}
                    fill="none"
                    stroke={MARK}
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    opacity="0.9"
                    filter="url(#ew-rough)"
                  />
                )}
              </g>
            )
          })}
          {/* the hub's word, only while the arrow rests on it */}
          {sel < 0 && (
            <text y="36" textAnchor="middle" className="font-mono" style={{ fontSize: 10, fill: INK_SOFT }}>
              {hub}
            </text>
          )}
          {/* the card arrow on its split pin */}
          <g ref={arrow} style={{ transform: 'rotate(0deg) scale(0.72)', transition: 'transform 60ms linear' }}>
            <path
              d="M-7 6L-5 -30L-13 -30L0 -47L13 -30L5 -30L7 6Z"
              fill="#efe4cb"
              stroke={INK}
              strokeWidth="1.8"
              strokeLinejoin="round"
              filter="url(#ew-rough)"
            />
          </g>
          <circle r="8.5" fill="#b8903f" stroke="#6d5323" strokeWidth="1.4" />
          <circle r="5" fill="#d9b664" />
          <path d="M-4.5 0.5L4.5 -0.5" stroke="#6d5323" strokeWidth="1.6" strokeLinecap="round" />
        </g>
        {/* and the masking tape holding it up */}
        <g transform="translate(-8 -186) rotate(-4)">
          <path
            d="M-44 -11L-41 -13L42 -10L45 -12L43 11L45 13L-42 11L-45 12Z"
            fill="rgba(238,226,194,0.88)"
            stroke="rgba(120,100,70,0.25)"
            strokeWidth="0.8"
          />
        </g>
      </svg>
    </div>
  )
}

/**
  What the point key shows the one doing it. Their own arm is outside a
  first-person lens (a shoulder a body's height under the eye cannot reach
  into the frame), so the crosshair gets a little pencilled mitten beside it,
  its thumb up and its paddle aimed at the middle, for as long as the key is
  held: the same card and ink as the wheel, and gone when the key comes up.
*/
export function PointMark() {
  return (
    <svg
      viewBox="0 0 48 48"
      width={34}
      height={34}
      aria-hidden
      className="pointer-events-none absolute"
      style={{ left: 'calc(50% + 12px)', top: 'calc(50% + 8px)', filter: 'drop-shadow(0 1px 1.5px rgba(30,20,10,0.5))' }}
    >
      <defs>
        <filter id="pm-rough" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves={2} seed={5} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="1.8" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <g filter="url(#pm-rough)" {...ink} strokeWidth={2.6}>
        {/* a mitten held out flat, paddle aimed up and left at the crosshair */}
        <path {...fillPaper} d="M44 44L30 30c-3-3-4-7-2-10L10 6c-2-2 0-6 3-5l19 13c3-1 7 0 10 3l6 6" />
        <path {...fillPaper} d="M30 30c-4 1-8 0-9-3-1-2 1-4 3-3l5 2" />
      </g>
    </svg>
  )
}
