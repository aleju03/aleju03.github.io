/*
  The cue table: what the site actually sounds like.

  Everything is written around E minor, the key AlejOS boots in (see the startup
  chime in os/sounds.ts), so walking the page and booting the machine belong to
  one piece of music rather than two. Cues are short, dry and quiet.

  There is deliberately no ambient bed. There was one: five detuned pads
  breathing out of step on an E minor chord, engineered down to the last
  fraction of a hertz so it looped without a seam, and it was very good at
  being exactly the wrong thing. A sustained minor drone under a page is the
  sound design of a corridor you cannot get out of, and it read that way
  instantly. The visitor this site is written for is a stranger deciding
  whether to keep reading, so the score's job is to make the page feel
  RESPONSIVE, not to set an atmosphere they did not ask for. Silence until
  they touch something, then a small precise sound that says the thing they
  touched heard them. If an ambience ever comes back it has to earn its place
  against that, and it will not be a drone.

  Loudness is declared here, once per cue, as a target peak that `renderCue`
  normalises to; the gains inside each cue are only its internal balance. The
  ladder is deliberate and it is the whole mix: a hover tick is the quietest
  thing on the site, the two doors (open/close) sit a few dB over it, and the
  boot chime is the loudest thing the page ever does, because it is the one
  moment the visitor has asked to be somewhere else. These were measured at
  the master bus in a browser, not guessed: the previous set of hand-picked
  gains landed the whole bank between -22 and -31 dBFS, which is a mix you can
  only hear in headphones in a quiet room.
*/

import { noise, renderCue, tone } from './synth'

export type CueName =
  | 'tick'
  | 'enter'
  | 'open'
  | 'close'
  | 'whoosh'
  | 'draw'
  | 'power'
  | 'boot'

/**
 * The mix, as peak sample values. Multiply by index.ts's MASTER for what a
 * meter on the master bus reads: tick lands near -21 dBFS, boot near -10.
 */
const PEAK: Record<CueName, number> = {
  tick: 0.1,
  enter: 0.13,
  open: 0.19,
  close: 0.19,
  whoosh: 0.17,
  draw: 0.1,
  power: 0.24,
  boot: 0.33,
}
/** every short cue, keyed by name; each returns a fresh object URL */
export const CUES: Record<CueName, () => Promise<string>> = {
  /** the smallest possible acknowledgement: hovers and focus moves */
  tick: () =>
    renderCue(0.1, (ctx) => tone(ctx, { freq: 1400, to: 900, dur: 0.05, gain: 0.03 }), {
      peak: PEAK.tick,
    }),

  /** a section arriving: a fifth, breathed rather than struck */
  enter: () =>
    renderCue(
      1.1,
      (ctx) => {
        tone(ctx, { freq: 329.63, dur: 0.9, type: 'triangle', gain: 0.022 })
        tone(ctx, { freq: 493.88, at: 0.06, dur: 0.85, type: 'sine', gain: 0.016 })
      },
      { peak: PEAK.enter },
    ),

  open: () =>
    renderCue(
      0.35,
      (ctx) => {
        tone(ctx, { freq: 440, dur: 0.1, gain: 0.04 })
        tone(ctx, { freq: 659.25, at: 0.07, dur: 0.16, gain: 0.038 })
      },
      { peak: PEAK.open },
    ),

  close: () =>
    renderCue(
      0.35,
      (ctx) => {
        tone(ctx, { freq: 659.25, dur: 0.1, gain: 0.038 })
        tone(ctx, { freq: 440, at: 0.07, dur: 0.16, gain: 0.04 })
      },
      { peak: PEAK.close },
    ),

  /** the theme wipe: air moving across the screen */
  whoosh: () =>
    renderCue(
      0.6,
      (ctx) => {
        noise(ctx, { freq: 380, to: 2600, dur: 0.42, gain: 0.05, q: 0.8 })
        tone(ctx, { freq: 220, to: 480, dur: 0.34, type: 'sine', gain: 0.014 })
      },
      { peak: PEAK.whoosh },
    ),

  /** the flight path's nib passing a waypoint */
  draw: () =>
    renderCue(
      0.3,
      (ctx) => {
        noise(ctx, { freq: 2200, to: 3600, dur: 0.16, gain: 0.022, q: 2.4 })
        tone(ctx, { freq: 987.77, dur: 0.12, gain: 0.018 })
      },
      { peak: PEAK.draw },
    ),

  /**
   * A CRT waking: the degauss coil's shudder as the tube lights.
   *
   * This one fires from SCROLL POSITION, not from a click, which sets its
   * whole budget: an unrequested sound has to be felt rather than heard. An
   * earlier version voiced the flyback whistle as a 3.9kHz sine held for most
   * of a second at a gain of 0.008, and the number is a lie: hearing peaks
   * around 3-4kHz, so a "quiet" sustained tone up there is the loudest thing
   * on the page and reads as an appliance beeping at you. Nothing above the
   * bottom two octaves belongs in a cue the visitor did not ask for.
   */
  power: () =>
    renderCue(
      1.0,
      (ctx) => {
        tone(ctx, { freq: 84, to: 42, dur: 0.38, type: 'triangle', gain: 0.055 })
        noise(ctx, { freq: 190, to: 70, dur: 0.26, gain: 0.028, q: 0.6 })
        tone(ctx, { freq: 128, at: 0.06, dur: 0.5, type: 'sine', gain: 0.013 })
      },
      { peak: PEAK.power },
    ),

  /** the warp into AlejOS: the boot chime's own intervals, taken at a run */
  boot: () =>
    renderCue(
      1.4,
      (ctx) => {
        tone(ctx, { freq: 164.81, dur: 1.2, type: 'triangle', gain: 0.03 })
        tone(ctx, { freq: 329.63, at: 0.0, dur: 0.34, gain: 0.05 })
        tone(ctx, { freq: 493.88, at: 0.12, dur: 0.34, gain: 0.05 })
        tone(ctx, { freq: 659.25, at: 0.24, dur: 0.4, gain: 0.05 })
        tone(ctx, { freq: 830.61, at: 0.36, dur: 0.7, gain: 0.045 })
        noise(ctx, { at: 0.0, freq: 600, to: 4200, dur: 0.5, gain: 0.03, q: 0.9 })
      },
      { peak: PEAK.boot },
    ),
}
