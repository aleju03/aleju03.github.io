/*
  Where the sound is attached to the site.

  This mirrors the trick analytics.ts already plays: events.ts is the spine
  every far-apart component talks over, so subscribing to it here scores the
  palette, the terminal, the chooser, navigation and every route into the OS
  without putting a single `cue(...)` call inside those components. Only the
  things with no window event behind them — the tear sheet, the machine act,
  the cursor — call `cue` directly, and there are three of those.

  Section arrivals are the one thing measured here rather than announced: an
  IntersectionObserver over the same `[data-station]` elements the flight path
  is built from, so the page's chapters and its score are keyed off one
  definition of where a chapter is.
*/

import {
  BOOT_OS_EVENT,
  NAVIGATE_EVENT,
  OPEN_CHOOSER_EVENT,
  OPEN_PALETTE_EVENT,
  OPEN_TERMINAL_EVENT,
} from '../events'
import { onThemeChange } from '../theme'
import { onScrollFrame } from '../scroll/progress'
import { measureStations, stationProgress, type StationId } from '../scroll/stations'
import { cue, soundEnabled, startAudio } from './index'

let wired = false

export function wireAudio(): void {
  if (wired || typeof window === 'undefined') return
  wired = true

  // browsers will not start audio before a gesture, so there is no point
  // loading Howler or building the bank until one arrives
  const first = () => {
    void startAudio()
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      window.removeEventListener(type, first)
    }
  }
  if (soundEnabled()) {
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(type, first, { passive: true })
    }
  }

  window.addEventListener(OPEN_PALETTE_EVENT, () => cue('open'))
  window.addEventListener(OPEN_TERMINAL_EVENT, () => cue('open'))
  window.addEventListener(OPEN_CHOOSER_EVENT, () => cue('open'))
  window.addEventListener(NAVIGATE_EVENT, () => cue('tick'))
  window.addEventListener(BOOT_OS_EVENT, () => cue('boot'))
  onThemeChange(() => cue('whoosh'))

  // one 'enter' the first time a chapter arrives, one 'draw' when its waypoint
  // finishes unfolding — the two beats the flight path itself plays
  const entered = new Set<StationId>()
  const drawn = new Set<StationId>()
  let stations = measureStations()
  let sinceMeasure = 0

  onScrollFrame(({ smoothY, viewportH, dt }) => {
    sinceMeasure += dt
    if (sinceMeasure > 1.5) {
      sinceMeasure = 0
      stations = measureStations()
    }
    for (const station of stations.list) {
      if (station.id === 'hero') continue
      const p = stationProgress(station, smoothY, viewportH)
      if (p > 0.05 && !entered.has(station.id)) {
        entered.add(station.id)
        cue('enter')
      }
      if (p > 0.9 && !drawn.has(station.id)) {
        drawn.add(station.id)
        cue('draw')
      }
    }
  })
}
