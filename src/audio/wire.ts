/*
  Where the sound is attached to the site.

  This mirrors the trick analytics.ts already plays: events.ts is the spine
  every far-apart component talks over, so subscribing to it here scores the
  palette, the terminal, the chooser, navigation and every route into the OS
  without putting a single `cue(...)` call inside those components. Only the
  things with no window event behind them call `cue` directly: the machine act,
  the cursor, and the two dialogs, which do it from the same effect that takes
  the scroll lock so that Escape and a backdrop click are scored the same as
  the close button.

  Nothing here is wired to the scroll any more. Section arrivals used to be
  measured off the same `[data-station]` elements the flight path is built
  from, firing `enter` when a chapter crossed 5% and `draw` when its waypoint
  finished at 90%. It read beautifully in this file and it was, from the
  visitor's side, a page that made about twenty noises while they read it
  without ever being touched. The rule that replaced it is simple enough to
  check against any new cue: score what the visitor DID, never where they got
  to. Scrolling is not an action, it is the medium; a click, a key, a theme
  toggle, a route change are actions.

  The one deliberate exception lives outside this file, in Machine.tsx, where
  `power` fires once from scroll position because it scores a visible act. One
  is a flourish. Twenty-two is a mood, and not the intended one.
*/

import {
  BOOT_OS_EVENT,
  NAVIGATE_EVENT,
  OPEN_CHOOSER_EVENT,
  OPEN_PALETTE_EVENT,
  OPEN_TERMINAL_EVENT,
} from '../events'
import { onThemeChange } from '../theme'
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
}
