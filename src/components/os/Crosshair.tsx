/*
  The crosshair: where a spawn lands, what `remove` and `freeze` mean by
  "the prop you are looking at", and where a grab beam starts.

  It is drawn to the same pixel grid as the world rather than as a vector
  sight, because the frame under it is a low-resolution picture scaled up
  nearest-neighbour, and a smooth hairline over chunky pixels reads as a
  sticker on the glass. So it is a 13-by-13 bitmap, blown up by whole
  pixels: four cream ticks with a dark rim (it has to read over snow and
  over asphalt), a gap in the middle where the thing you are aiming at stays
  visible, and a centre dot. When the aim is on something that can be
  picked up, pushed or spawned against, the ticks step out one pixel and
  turn the pencil colour of the pause sheet's marker, which is the whole of
  its vocabulary: the physgun piece reads the same `aim` prop, and its own
  states (holding, frozen) are two more entries in `TINT`.

  Pure presentation. What it is aimed at is decided by the scene (one
  sandbox raycast a frame, mirrored here only when it changes).
*/
import { MARK } from './paper'

export type CrosshairAim = 'none' | 'prop' | 'held' | 'frozen'

const TINT: Record<CrosshairAim, string> = {
  none: '#f3ead6',
  prop: MARK,
  held: '#8fd0ff',
  frozen: '#7fb2ff',
}

/** the ticks, as (x, y, w, h) cells on a 13-grid, for the two spreads */
const TICKS = (out: number) => [
  [6, 1 - out, 1, 3],
  [6, 9 + out, 1, 3],
  [1 - out, 6, 3, 1],
  [9 + out, 6, 3, 1],
]

export default function Crosshair({ aim = 'none', scale = 2 }: { aim?: CrosshairAim; scale?: number }) {
  const on = aim !== 'none'
  const ticks = TICKS(on ? 1 : 0)
  const fill = TINT[aim]
  const size = 13 * scale
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="-1 -1 15 15"
      shapeRendering="crispEdges"
      className="pointer-events-none absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ transition: 'none' }}
    >
      {/* the rim: every cell grown by one, in dark ink */}
      {ticks.map(([x, y, w, h], i) => (
        <rect key={`r${i}`} x={x - 0.5} y={y - 0.5} width={w + 1} height={h + 1} fill="rgba(28,22,16,0.75)" />
      ))}
      <rect x={5.5} y={5.5} width={2} height={2} fill="rgba(28,22,16,0.75)" />
      {ticks.map(([x, y, w, h], i) => (
        <rect key={`t${i}`} x={x} y={y} width={w} height={h} fill={fill} />
      ))}
      <rect x={6} y={6} width={1} height={1} fill={fill} />
    </svg>
  )
}
