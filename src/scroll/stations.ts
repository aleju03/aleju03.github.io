/*
  The station registry: the shared answer to "where on the page is each section?".

  The flight path is a curve through the page, so it needs section positions in
  DOCUMENT pixels, the same space BlockName pins its 3D world to (see the
  `layout()` note there: origin at the viewport center at scroll 0, camera slid
  down by the live scroll offset). Sections opt in by marking an element
  `data-station="work"`; nothing here knows what a section is beyond that
  attribute, so adding a stop to the flight is one attribute in the JSX.

  Measuring is deliberately explicit rather than reactive. A ResizeObserver on
  <body> plus `resize` catches reflow, and `document.fonts.ready` catches the
  one that bites hardest: Clash Display swapping in under the section headings
  moves every station below it. Consumers subscribe and re-layout.

  React-free on purpose: the 3D side imports this directly, and it has to keep
  working if the runtime is ever driven without a DOM-heavy React tree above it.
*/

/** the flight's stops, in the order the curve threads them */
export const STATION_IDS = ['hero', 'work', 'more', 'experience', 'about', 'machine'] as const

export type StationId = (typeof STATION_IDS)[number]

export interface Station {
  id: StationId
  /** document-space top edge, in CSS pixels */
  top: number
  height: number
  /** document-space horizontal center, in CSS pixels */
  centerX: number
  width: number
  /**
   * Offset from `top` to the top of this section's chapter heading, or the
   * section's full height where it has none. The flight path is drawn OVER the
   * page, so it needs to know where the biggest type on the section begins: a
   * lane change that finishes a few pixels late drags a dashed blue line
   * across a 6rem display letter, which is the one place on the page where a
   * graze reads as a mistake rather than as art direction.
   */
  headTop: number
}

export interface StationMap {
  list: Station[]
  byId: Partial<Record<StationId, Station>>
  /** full document height at measure time, so consumers can normalize */
  docHeight: number
}

const EMPTY: StationMap = { list: [], byId: {}, docHeight: 0 }

function isStationId(value: string): value is StationId {
  return (STATION_IDS as readonly string[]).includes(value)
}

/**
 * Reads every `[data-station]` element into document space. Ordered by the
 * curve's own order, not DOM order, so a station that moves in the JSX can't
 * silently reroute the flight.
 */
export function measureStations(): StationMap {
  if (typeof document === 'undefined') return EMPTY
  const found = new Map<StationId, Station>()
  const scrollY = window.scrollY
  const scrollX = window.scrollX

  for (const el of document.querySelectorAll<HTMLElement>('[data-station]')) {
    const id = el.dataset.station
    if (!id || !isStationId(id) || found.has(id)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue // display:none, not laid out yet
    const head = el.querySelector<HTMLElement>('[data-station-head]')
    found.set(id, {
      id,
      top: r.top + scrollY,
      height: r.height,
      centerX: r.left + scrollX + r.width / 2,
      width: r.width,
      headTop: head ? head.getBoundingClientRect().top - r.top : r.height,
    })
  }

  const list = STATION_IDS.map((id) => found.get(id)).filter((s): s is Station => s !== undefined)
  const byId: Partial<Record<StationId, Station>> = {}
  for (const s of list) byId[s.id] = s
  return { list, byId, docHeight: document.documentElement.scrollHeight }
}

/**
 * Calls back whenever the measurements could have changed. Fires once
 * immediately so callers never have to prime themselves, and coalesces bursts
 * into one rAF so a resize drag doesn't remeasure per pixel.
 */
export function onStationsChange(listener: (stations: StationMap) => void): () => void {
  let raf = 0
  let disposed = false

  const emit = () => {
    raf = 0
    if (!disposed) listener(measureStations())
  }
  const schedule = () => {
    if (disposed || raf !== 0) return
    raf = requestAnimationFrame(emit)
  }

  listener(measureStations())

  const resizeObserver = new ResizeObserver(schedule)
  resizeObserver.observe(document.body)
  window.addEventListener('resize', schedule)
  // the display face swapping in relays every heading, and everything under it
  void document.fonts?.ready.then(schedule)
  // the hero's entrance animation settles over ~1.4s; BlockName re-measures on
  // the same beats for the same reason
  const settle = [600, 1400, 2600].map((ms) => setTimeout(schedule, ms))

  return () => {
    disposed = true
    cancelAnimationFrame(raf)
    resizeObserver.disconnect()
    window.removeEventListener('resize', schedule)
    settle.forEach(clearTimeout)
  }
}

/** 0 before the station reaches `startAt` of the viewport, 1 once it passes `endAt` */
export function stationProgress(
  station: Station,
  scrollY: number,
  viewportH: number,
  startAt = 0.9,
  endAt = 0.35,
): number {
  const start = station.top - viewportH * startAt
  const end = station.top - viewportH * endAt
  if (end <= start) return scrollY >= end ? 1 : 0
  return Math.min(1, Math.max(0, (scrollY - start) / (end - start)))
}
