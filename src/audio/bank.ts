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

  There are also no longer cues on the scroll. There were two, `enter` and
  `draw`, one when a chapter arrived and one when its waypoint finished
  unfolding, and on a page with eleven chapters that is twenty-two sounds a
  visitor gets for the crime of reading downwards. Every one of them was
  unrequested, which is the distinction that actually governs this file: a
  sound the visitor caused is feedback and a sound the page decided to make at
  them is an interruption, and no amount of tasteful voicing converts the
  second into the first. The `power` cue survives as the single exception,
  because it scores a thing the visitor can see happening and it fires once
  per session. That is the budget for unrequested sound on this page: one.

  The voice is a struck wooden bar (`bar` in synth.ts), and the road to it is
  worth writing down, because two plausible-sounding rules turned out to be
  wrong. The bank began as bare sines and triangles from 440Hz to 1400Hz, which
  reads as an appliance: a clean tone in the octave the ear is most sensitive
  in is a smoke alarm, not an interface. The obvious correction is "interface
  sound should be an unpitched broadband transient", and that is the rule this
  file was rewritten to first. It is also wrong for THIS site, which is not
  trying to sound like a switch panel; what actually suited the page was warm,
  pitched and unhurried.

  What matters is not whether a cue has a pitch but whether that pitch HOLDS.
  A hit whose pitch glides as it decays is a water droplet, and a bank of those
  sounds like bubbles no matter how tastefully each one is voiced. That is a
  measurable property, not a matter of opinion: the sample this bank was very
  nearly built on sweeps up thirteen semitones in 106ms. So every cue here is
  a constant-pitch strike with inharmonic partials, and the notes are degrees
  of E minor, chosen for what they mean. Nothing shipped, nothing to credit.

  Loudness is declared here, once per cue, as a target peak that `renderCue`
  normalises to; the gains inside each cue are only its internal balance, and
  `loadSample` normalises shipped files to the same ladder so a downloaded clip
  cannot arrive four times hotter than a synthesized one. The ladder is
  deliberate and it is the whole mix: the tick is the quietest thing on the
  site, the two doors (open/close) sit a few dB over it, and the boot chime is
  the loudest thing the page ever does, because it is the one moment the
  visitor has asked to be somewhere else. These were measured at the master bus
  in a browser, not guessed: the previous set of hand-picked gains landed the
  whole bank between -22 and -31 dBFS, which is a mix you can only hear in
  headphones in a quiet room.

  SAMPLES is where recorded audio goes. A cue listed there plays the file; a
  cue that is not, or whose file is missing or undecodable, plays the
  synthesized voice below. Both paths land on the same PEAK, so swapping one
  cue over to a recording does not disturb the others, and the bank can be
  replaced a cue at a time rather than in one commit.
*/

// MARIMBA is `bar`'s default voice, so only the felt one is named here
import { bar, FELT, noise, renderCue, tone } from './synth'

/**
 * The notes the bank is allowed to use: E minor, the key AlejOS boots in.
 * Naming them keeps the cues readable as music (open answers close a third
 * below it) instead of as a list of frequencies nobody can check.
 */
const E3 = 164.81
const B3 = 246.94
const E4 = 329.63
const G4 = 392.0
const B4 = 493.88
const D5 = 587.33

export type CueName = 'tick' | 'open' | 'close' | 'whoosh' | 'power' | 'boot'

/**
 * The mix, as peak sample values. Multiply by index.ts's MASTER for what a
 * meter on the master bus reads: tick lands near -21 dBFS, boot near -10.
 */
export const PEAK: Record<CueName, number> = {
  tick: 0.1,
  open: 0.19,
  close: 0.19,
  whoosh: 0.17,
  power: 0.24,
  boot: 0.33,
}

/**
 * Recorded audio, per cue, served from public/audio. Everything here must be
 * CC0: this repository is public, and a CC0 file can sit in git with no
 * licence file, no attribution chain and no question about whether a clone of
 * the repo is a redistribution of somebody's sound library. Attribution
 * licences are fine for playback and awkward for source control, which is why
 * the game's CC BY doors carry public/os/sfx/LICENSE.md and these do not need
 * to.
 *
 * Provenance still gets written down in public/audio/CREDITS.md even for CC0,
 * because "where did this come from" is a question future-you will ask.
 */
export const SAMPLES: Partial<Record<CueName, string>> = {
  // tick: '/audio/tick.wav',
  // open: '/audio/open.wav',
  // close: '/audio/close.wav',
  // whoosh: '/audio/whoosh.wav',
  // power: '/audio/power.wav',
}
/** every short cue, keyed by name; each returns a fresh object URL */
export const CUES: Record<CueName, () => Promise<string>> = {
  /**
   * The smallest possible acknowledgement, now only for navigation.
   *
   * B4, the fifth. The note matters as much as the timbre here: the fifth is
   * the degree that does not resolve, so it says "you moved" without saying
   * "you arrived", which is the correct thing for a cue that fires on every
   * route change. Landing this one on the tonic made the site feel like it was
   * congratulating you for scrolling.
   */
  tick: () =>
    renderCue(0.45, (ctx) => bar(ctx, { freq: B4, decay: 0.2, gain: 0.09 }), {
      peak: PEAK.tick,
    }),

  /**
   * A dialog opening: one strike on G4, the minor third.
   *
   * This was an ascending fifth, two notes, and the pair below was the same
   * fifth reversed, which announced the INTERVAL rather than the event. It is
   * one strike now, and the pairing lives in the two notes instead: open sits
   * a third above close, unresolved, the way an opened thing is unfinished.
   */
  open: () =>
    renderCue(0.6, (ctx) => bar(ctx, { freq: G4, decay: 0.3, gain: 0.09 }), {
      peak: PEAK.open,
    }),

  /**
   * The same dialogs dismissing: the same bar, struck on E4.
   *
   * The tonic, which is why it reads as finished where `open` reads as
   * pending, and a little longer in the decay so the close is the heavier of
   * the two. Same instrument, one note lower: the pair is recognisably one
   * object rather than two sound effects.
   */
  close: () =>
    renderCue(0.7, (ctx) => bar(ctx, { freq: E4, decay: 0.34, gain: 0.09 }), {
      peak: PEAK.close,
    }),

  /**
   * The theme wipe: two strikes falling, D5 to G4.
   *
   * Falling, not rising. A rising figure is an anticipation gesture, it
   * promises that something else is about to happen, and nothing else happens:
   * the theme has already changed by the time the sound ends. The notes are
   * deliberately not open's or close's, because a toggle and a dialog are
   * different events and reusing the pitches makes them read as the same one.
   */
  whoosh: () =>
    renderCue(
      0.5,
      (ctx) => {
        bar(ctx, { freq: D5, decay: 0.28, gain: 0.075 })
        bar(ctx, { freq: G4, at: 0.09, decay: 0.28, gain: 0.07 })
      },
      { peak: PEAK.whoosh },
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
   *
   * A low fifth on the felt voice, E3 under B3, struck together and left to
   * ring for the best part of a second: the deepest and slowest thing the site
   * plays, which is the shape a tube coming up to temperature has. The mallet
   * is moved down to 500Hz because a bright contact click on a note this low
   * is the one detail that would give it away as a synthesizer.
   */
  power: () =>
    renderCue(
      1.4,
      (ctx) => {
        bar(ctx, { freq: E3, decay: 0.9, gain: 0.085, partials: FELT, mallet: 0.5, malletHz: 500 })
        bar(ctx, { freq: B3, decay: 0.7, gain: 0.042, partials: FELT, mallet: 0.2, malletHz: 500 })
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
