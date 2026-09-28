import { sharedAudio } from '../../core/sfx'
import { crackle, pop, sweep } from './sfx'

/*
  The portal gun's voice, built from the physgun's own voices (sfx.ts's
  pops, sweeps and crackles) so the two guns sound like one family: a shot
  is a bright sine flicked up with a breath of noise, blue a fifth under
  orange so the two can be told apart by ear; an opening is a low swell
  under a shimmer; a fizzle is the shot collapsing into a dry crackle; and
  going through is a soft whoosh under a falling thump. Headless-safe like
  the rest: no AudioContext, no sound. Peaks sit with the physgun's grab.
*/

export interface PortalSfx {
  shot: (color: 0 | 1) => void
  open: (color: 0 | 1) => void
  fizzle: () => void
  pass: () => void
  close: () => void
}

export function createPortalSfx(): PortalSfx {
  return {
    shot: (color) => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      const f = color ? 660 : 440
      sweep(a, t, 'sine', f, f * 2.4, 0.05, 0.13)
      sweep(a, t, 'triangle', f * 0.5, f * 1.1, 0.025, 0.1)
      pop(a, t, 'bandpass', 2600, 1.4, 0.03, 0.08)
    },
    open: (color) => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      const f = color ? 150 : 110
      sweep(a, t, 'sine', f * 0.7, f, 0.07, 0.4)
      sweep(a, t + 0.02, 'triangle', f * 8, f * 6, 0.018, 0.35)
      crackle(a, t, 5, 0.18, 0.025)
    },
    fizzle: () => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      crackle(a, t, 8, 0.2, 0.04)
      sweep(a, t, 'sawtooth', 700, 180, 0.015, 0.2)
    },
    pass: () => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      pop(a, t, 'lowpass', 900, 0.7, 0.05, 0.28)
      sweep(a, t, 'sine', 220, 70, 0.05, 0.22)
    },
    close: () => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      sweep(a, t, 'sine', 300, 90, 0.04, 0.25)
      pop(a, t, 'bandpass', 1800, 1, 0.02, 0.12)
    },
  }
}
