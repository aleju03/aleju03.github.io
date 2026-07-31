/*
  The cue table: what the site actually sounds like.

  Everything is written around E minor, the key AlejOS boots in (see the startup
  chime in os/sounds.ts), so walking the page and booting the machine belong to
  one piece of music rather than two. Cues are short, dry, and quiet; the bed is
  long, slow and quieter still.

  The bed has one hard constraint the short cues don't: it has to loop with no
  seam. A drone loops seamlessly only if every oscillator completes a whole
  number of cycles across the loop, so each pad frequency is snapped to a
  multiple of 1/LOOP Hz, and each amplitude curve completes an integer number
  of its own cycles too. That is also why there is no noise wash in the bed —
  a noise buffer cannot meet at its own ends, and the click at the loop point
  is exactly the kind of detail that reads as amateur.
*/

import { noise, renderCue, tone } from './synth'

export type CueName =
  | 'tick'
  | 'enter'
  | 'open'
  | 'close'
  | 'whoosh'
  | 'draw'
  | 'tear'
  | 'power'
  | 'boot'

/** the bed's loop length, in seconds */
const LOOP = 20

/** snap a frequency so it completes a whole number of cycles across the loop */
const seamless = (hz: number) => Math.round(hz * LOOP) / LOOP

/**
 * A pad voice: a constant drone whose level breathes on its own slow cycle.
 * `cycles` must be a whole number or the level jumps at the loop point.
 */
function pad(
  ctx: OfflineAudioContext,
  freq: number,
  level: number,
  cycles: number,
  phase: number,
  pan: number,
) {
  const osc = ctx.createOscillator()
  osc.type = 'triangle'
  osc.frequency.value = seamless(freq)

  const gain = ctx.createGain()
  // sampled rather than automated: setValueCurveAtTime guarantees the first and
  // last values are the ones we chose, which is what makes the seam disappear
  const steps = 512
  const curve = new Float32Array(steps + 1)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * (cycles * t + phase))
    curve[i] = level * (0.35 + 0.65 * swell)
  }
  gain.gain.setValueCurveAtTime(curve, 0, LOOP)

  const panner = ctx.createStereoPanner()
  panner.pan.value = pan
  osc.connect(gain).connect(panner).connect(ctx.destination)
  osc.start(0)
  osc.stop(LOOP)
}

/** the ambient bed — five voices of an E minor chord, breathing out of step */
export function renderBed(): Promise<string> {
  return renderCue(
    LOOP,
    (ctx) => {
      pad(ctx, 82.41, 0.05, 1, 0, -0.25) // E2
      pad(ctx, 123.47, 0.036, 2, 0.33, 0.3) // B2
      pad(ctx, 164.81, 0.03, 3, 0.66, -0.45) // E3
      pad(ctx, 196.0, 0.022, 2, 0.15, 0.5) // G3
      pad(ctx, 246.94, 0.016, 4, 0.5, 0) // B3
    },
    2,
  )
}

/** every short cue, keyed by name; each returns a fresh object URL */
export const CUES: Record<CueName, () => Promise<string>> = {
  /** the smallest possible acknowledgement: hovers and focus moves */
  tick: () => renderCue(0.1, (ctx) => tone(ctx, { freq: 1400, to: 900, dur: 0.05, gain: 0.03 })),

  /** a section arriving — a fifth, breathed rather than struck */
  enter: () =>
    renderCue(1.1, (ctx) => {
      tone(ctx, { freq: 329.63, dur: 0.9, type: 'triangle', gain: 0.022 })
      tone(ctx, { freq: 493.88, at: 0.06, dur: 0.85, type: 'sine', gain: 0.016 })
    }),

  open: () =>
    renderCue(0.35, (ctx) => {
      tone(ctx, { freq: 440, dur: 0.1, gain: 0.04 })
      tone(ctx, { freq: 659.25, at: 0.07, dur: 0.16, gain: 0.038 })
    }),

  close: () =>
    renderCue(0.35, (ctx) => {
      tone(ctx, { freq: 659.25, dur: 0.1, gain: 0.038 })
      tone(ctx, { freq: 440, at: 0.07, dur: 0.16, gain: 0.04 })
    }),

  /** the theme wipe: air moving across the screen */
  whoosh: () =>
    renderCue(0.6, (ctx) => {
      noise(ctx, { freq: 380, to: 2600, dur: 0.42, gain: 0.05, q: 0.8 })
      tone(ctx, { freq: 220, to: 480, dur: 0.34, type: 'sine', gain: 0.014 })
    }),

  /** the flight path's nib passing a waypoint */
  draw: () =>
    renderCue(0.3, (ctx) => {
      noise(ctx, { freq: 2200, to: 3600, dur: 0.16, gain: 0.022, q: 2.4 })
      tone(ctx, { freq: 987.77, dur: 0.12, gain: 0.018 })
    }),

  /** paper giving way: a wide dry rip with a little fibre crackle after it */
  tear: () =>
    renderCue(0.7, (ctx) => {
      noise(ctx, { freq: 1500, to: 260, dur: 0.34, gain: 0.075, q: 0.6 })
      noise(ctx, { at: 0.05, freq: 3200, to: 1400, dur: 0.2, gain: 0.03, q: 3 })
      for (let i = 0; i < 5; i++) {
        noise(ctx, { at: 0.22 + i * 0.055, freq: 2600, dur: 0.05, gain: 0.016, q: 4 })
      }
    }),

  /** a CRT waking: the degauss thunk, then the tube's hum coming up */
  power: () =>
    renderCue(1.3, (ctx) => {
      tone(ctx, { freq: 78, to: 46, dur: 0.42, type: 'triangle', gain: 0.09 })
      noise(ctx, { freq: 220, to: 90, dur: 0.3, gain: 0.045, q: 0.7 })
      // the 15.7kHz flyback whistle, an octave down so it reads without hurting
      tone(ctx, { freq: 3900, at: 0.18, dur: 0.9, type: 'sine', gain: 0.008 })
      tone(ctx, { freq: 120, at: 0.2, dur: 0.95, type: 'sine', gain: 0.02 })
    }),

  /** the warp into AlejOS: the boot chime's own intervals, taken at a run */
  boot: () =>
    renderCue(1.4, (ctx) => {
      tone(ctx, { freq: 164.81, dur: 1.2, type: 'triangle', gain: 0.03 })
      tone(ctx, { freq: 329.63, at: 0.0, dur: 0.34, gain: 0.05 })
      tone(ctx, { freq: 493.88, at: 0.12, dur: 0.34, gain: 0.05 })
      tone(ctx, { freq: 659.25, at: 0.24, dur: 0.4, gain: 0.05 })
      tone(ctx, { freq: 830.61, at: 0.36, dur: 0.7, gain: 0.045 })
      noise(ctx, { at: 0.0, freq: 600, to: 4200, dur: 0.5, gain: 0.03, q: 0.9 })
    }),
}
