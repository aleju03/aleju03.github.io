/*
  The crosshair: where a spawn lands, what `remove` and `freeze` mean by
  "the prop you are looking at", and where a grab beam starts.

  It is drawn to the same pixel grid as the world rather than as a vector
  sight, because the frame under it is a low-resolution picture scaled up
  nearest-neighbour, and a smooth hairline over chunky pixels reads as a
  sticker on the glass. So it is a 15-by-15 bitmap blown up by whole pixels
  (3 by default, about the world's own grain): four ticks and a centre dot,
  and round every lit cell a full cell of dark ink, the one-pixel outline the
  look gives every object, so it reads on snow, on asphalt, on a blue drum
  and against the sky alike. The middle is left open so what you aim at
  stays visible. When the aim is on something that can be picked up, pushed
  or spawned against, the ticks step out one cell and turn warm; the
  physgun's own states (holding, frozen) are two more entries in `TINT`.

  Pure presentation. What it is aimed at is decided by the scene (one
  sandbox raycast a frame, mirrored here only when it changes), and so is
  where it sits: dead centre in first person, and in third person wherever
  the head's gaze actually lands, which the scene projects and moves this
  with (see CrtScene's crosshair wrapper), hidden while that point is behind
  your own body, because the middle of a chase view is the back of your head
  and a mark drawn on it points at nothing.
*/

export type CrosshairAim = 'none' | 'prop' | 'held' | 'frozen'

const TINT: Record<CrosshairAim, string> = {
  none: '#fff3d6',
  prop: '#ffb24a',
  held: '#8fd6ff',
  frozen: '#86b8ff',
}
const INKED = 'rgba(22,16,10,0.88)'

const N = 15
const C = 7

/** the lit cells for one spread, as a set of `x,y` */
const litCells = (out: number) => {
  const lit = new Set<string>([`${C},${C}`])
  for (let i = 0; i < 3; i++) {
    const d = 3 + out + i
    lit.add(`${C},${C - d}`)
    lit.add(`${C},${C + d}`)
    lit.add(`${C - d},${C}`)
    lit.add(`${C + d},${C}`)
  }
  return lit
}

/** every cell touching a lit one (8 ways) that is not itself lit */
const rimCells = (lit: Set<string>) => {
  const rim = new Set<string>()
  for (const k of lit) {
    const [x, y] = k.split(',').map(Number)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = `${x + dx},${y + dy}`
        if (!lit.has(n)) rim.add(n)
      }
    }
  }
  return rim
}

const SHAPES = [0, 1].map((out) => {
  const lit = litCells(out)
  return { lit: [...lit], rim: [...rimCells(lit)] }
})

const cell = (k: string, fill: string) => {
  const [x, y] = k.split(',').map(Number)
  return <rect key={k} x={x} y={y} width={1} height={1} fill={fill} />
}

export default function Crosshair({ aim = 'none', scale = 3 }: { aim?: CrosshairAim; scale?: number }) {
  const shape = SHAPES[aim === 'none' ? 0 : 1]
  const size = N * scale
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${N} ${N}`}
      shapeRendering="crispEdges"
      className="pointer-events-none absolute top-1/2 left-1/2 z-10"
      // whole-pixel offsets: half of an odd size would put every cell edge
      // on a half pixel and smear the bitmap it is meant to be
      style={{ transform: `translate(${-Math.floor(size / 2)}px, ${-Math.floor(size / 2)}px)` }}
    >
      {shape.rim.map((k) => cell(k, INKED))}
      {shape.lit.map((k) => cell(k, TINT[aim]))}
    </svg>
  )
}
