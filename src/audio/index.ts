/*
  The site's sound, played through Howler.

  Howler earns its place here for the unglamorous parts: one master bus, a
  playback pool so a fast hover can't stack forty AudioBufferSourceNodes, real
  fades, and the mobile unlock dance that every hand-rolled WebAudio layer gets
  wrong the first time. What it plays is `bank.ts`: object URLs rendered in an
  OfflineAudioContext at runtime, so nothing audio ships with the site.

  Both Howler and the bank load lazily, on the visitor's first gesture. That is
  not only a bundle decision: browsers refuse to start audio before a gesture
  anyway, so there is nothing to gain by paying for the library during the load
  that actually matters.

  Two mute rules that are easy to get wrong and loud when you do. Reduced
  motion means silence, full stop: someone who has asked the machine to calm
  down has not asked to be chimed at either. And nothing plays while AlejOS
  covers the page, because the OS has its own synthesized voice and two scores
  at once is just noise; `cue` checks that on every call rather than trusting
  callers to know whether they are buried.
*/

import type { Howl } from 'howler'
import { pageIsCovered } from '../overlay'
import { track } from '../analytics'
import { CUES, type CueName } from './bank'

const STORAGE_KEY = 'sound'
/**
 * Headroom, not a mix control. The mix itself is `bank.ts`'s per-cue peak
 * table, which renderCue normalises each cue to, so this exists only to leave
 * room for two cues landing on the same frame without either being clipped by
 * the 16-bit encode. Turning the site up or down means editing that table, not
 * this number: Howler clamps its global volume to 1, so there is no headroom
 * above here to find anyway. That is the trap the first version fell into, a
 * bank rendered so quietly that no value here could rescue it.
 */
const MASTER = 0.85

type Listener = (enabled: boolean) => void

const listeners = new Set<Listener>()
const sounds = new Map<CueName, Howl>()

let enabled = false
let starting = false
let ready = false
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
 * The visitor's answer, or ours. The default is on, which costs a first-time
 * visitor nothing, since the bank is not even built until they touch the page
 * and nothing plays until they touch something in particular. An explicit
 * "off" always wins, and reduced motion overrides both.
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
 * Builds the bank. Safe to call repeatedly; only the first call does the work.
 * Must be called from a user gesture.
 */
export async function startAudio(): Promise<void> {
  if (starting || ready || !soundEnabled()) return
  starting = true
  enabled = true
  announce()

  try {
    howler = await import('howler')
    howler.Howler.volume(MASTER)

    const names = Object.keys(CUES) as CueName[]
    await Promise.all(
      names.map(async (name) => {
        const src = await CUES[name]()
        sounds.set(name, new howler!.Howl({ src: [src], format: ['wav'], preload: true }))
      }),
    )
    ready = true
  } catch {
    // audio is decoration; a browser that refuses any part of this just stays
    // quiet rather than taking the page down with it
    ready = false
  } finally {
    starting = false
  }
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
    // turning sound ON has to make one, or the control reads as broken:
    // nothing else may happen for minutes
    if (ready) cue('open')
    else void startAudio().then(() => cue('open'))
  } else {
    howler?.Howler.stop()
  }
}
