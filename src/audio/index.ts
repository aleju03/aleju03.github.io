/*
  The site's sound, played through Howler.

  Howler earns its place here for the unglamorous parts: one master bus, a
  playback pool so a fast hover can't stack forty AudioBufferSourceNodes, real
  fades, and the mobile unlock dance that every hand-rolled WebAudio layer gets
  wrong the first time. What it plays is `bank.ts` — object URLs rendered in an
  OfflineAudioContext at runtime, so nothing audio ships with the site.

  Both Howler and the bank load lazily, on the visitor's first gesture. That is
  not only a bundle decision: browsers refuse to start audio before a gesture
  anyway, so there is nothing to gain by paying for the library during the load
  that actually matters.

  Two mute rules that are easy to get wrong and loud when you do. Reduced
  motion means silence, full stop — someone who has asked the machine to calm
  down has not asked for an ambient soundtrack. And the bed stops dead when
  AlejOS covers the page, because the OS has its own synthesized voice and two
  scores playing at once is just noise.
*/

import type { Howl } from 'howler'
import { onOverlayChange, pageIsCovered } from '../overlay'
import { track } from '../analytics'
import { CUES, renderBed, type CueName } from './bank'

const STORAGE_KEY = 'sound'
/**
 * The master level, set by measurement rather than taste. os/sounds.ts plays
 * straight into the destination at gains around 0.05, so that is the house
 * level this site already speaks at. The bank renders at peaks of 0.024–0.087,
 * and 0.85 lands them on top of the OS's cues instead of half a fader below —
 * a page that is audibly quieter than the machine inside it sounds broken.
 */
const MASTER = 0.85
/** the bed sits well under the cues; it is a room tone, not a track */
const BED_LEVEL = 0.5

type Listener = (enabled: boolean) => void

const listeners = new Set<Listener>()
const sounds = new Map<CueName, Howl>()

let enabled = false
let starting = false
let ready = false
let bed: Howl | null = null
let howler: typeof import('howler') | null = null

function prefersQuiet() {
  return (
    typeof window === 'undefined' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function stored(): boolean | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? null : raw === 'on'
  } catch {
    return null
  }
}

/**
 * The visitor's answer, or ours. The default is on — the bed still waits for a
 * gesture before it can make a sound — but an explicit "off" always wins, and
 * reduced motion overrides both.
 */
export function soundEnabled(): boolean {
  if (prefersQuiet()) return false
  return stored() ?? true
}

export function onSoundChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce() {
  for (const listener of listeners) listener(enabled)
}

/**
 * Builds the bank and starts the bed. Safe to call repeatedly; only the first
 * call does the work. Must be called from a user gesture.
 */
export async function startAudio(): Promise<void> {
  if (starting || ready || !soundEnabled()) return
  starting = true
  enabled = true
  announce()

  try {
    howler = await import('howler')
    howler.Howler.volume(MASTER)

    // the short cues first: they are what an impatient visitor triggers, and
    // they are cheap next to twenty seconds of stereo pad
    const names = Object.keys(CUES) as CueName[]
    await Promise.all(
      names.map(async (name) => {
        const src = await CUES[name]()
        sounds.set(name, new howler!.Howl({ src: [src], format: ['wav'], preload: true }))
      }),
    )
    ready = true

    const bedSrc = await renderBed()
    bed = new howler.Howl({ src: [bedSrc], format: ['wav'], loop: true, volume: 0 })
    resumeBed()
  } catch {
    // audio is decoration; a browser that refuses any part of this just stays
    // quiet rather than taking the page down with it
    ready = false
  } finally {
    starting = false
  }
}

function resumeBed() {
  if (!bed || !enabled || pageIsCovered()) return
  if (!bed.playing()) bed.play()
  bed.fade(bed.volume(), BED_LEVEL, 2400)
}

function pauseBed() {
  if (!bed || !bed.playing()) return
  bed.fade(bed.volume(), 0, 600)
  // let the fade finish before the transport stops, or it clicks
  setTimeout(() => {
    if (!enabled || pageIsCovered()) bed?.pause()
  }, 650)
}

/** Play a cue. A no-op before the bank is built or while sound is off. */
export function cue(name: CueName): void {
  if (!enabled || !ready || pageIsCovered()) return
  sounds.get(name)?.play()
}

export function setSoundEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    /* private mode: the choice just won't survive the session */
  }
  track('sound_toggle', { on: next })
  enabled = next && !prefersQuiet()
  announce()
  if (enabled) {
    if (ready) resumeBed()
    else void startAudio()
  } else {
    pauseBed()
    howler?.Howler.stop()
  }
}

if (typeof window !== 'undefined') {
  // AlejOS speaks for itself once it is up; the page's bed gets out of the way
  onOverlayChange(() => {
    if (pageIsCovered()) pauseBed()
    else resumeBed()
  })
}
