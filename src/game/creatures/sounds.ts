import { burst, mode, placedVoice } from '../sandbox/impactSounds'
import type { Voice } from './kinds'

/*
  What the creatures sound like, synthesized like every other sound in the
  runtime and played through the props' own bus (impactSounds.ts's
  `placedVoice`): the same distance law, stereo placement, voice budget and
  limiter, so a farm full of pigs and a chain of barrels share one ceiling.

  A voice is a handful of sine modes with a pitch contour, plus a burst of
  filtered noise for the breath in it. Each is one shape and three moods
  (`idle`, `hurt`, `death`): a hurt cry is higher and shorter than an idle
  one, a death is lower and longer. Pitch takes a per-call jitter and a
  per-creature `pitch` multiplier so a herd is not a chorus of one animal.
  Levels are the same order as the weapons' (0.08 to 0.16 at arm's length),
  well under a barrel's boom, so a field of them does not drown the score.

  Headless-safe: with no audio context `placedVoice` answers null and every
  call returns.
*/

export type Mood = 'idle' | 'hurt' | 'death'

const jit = (k = 0.05) => 1 + (Math.random() * 2 - 1) * k

type Shape = (o: NonNullable<ReturnType<typeof placedVoice>>, mood: Mood, p: number) => void

const SHAPES: Record<Exclude<Voice, 'none'>, { level: number; reach: number; shape: Shape }> = {
  oink: {
    level: 0.13,
    reach: 26,
    shape: (o, mood, p) => {
      const f = 210 * p * jit()
      const n = mood === 'idle' ? 2 : mood === 'hurt' ? 3 : 1
      for (let i = 0; i < n; i++) {
        const t = i * 0.16
        mode(o, f * (mood === 'hurt' ? 1.5 : 1), 0.8, 0.13, t, 0.72)
        mode(o, f * 2.1, 0.35, 0.09, t, 0.8)
        burst(o, 'bandpass', 900 * p, 1.4, 0.3, 0.11, t)
      }
      if (mood === 'death') mode(o, f * 0.6, 0.7, 0.5, 0.1, 0.4)
    },
  },
  moo: {
    level: 0.16,
    reach: 40,
    shape: (o, mood, p) => {
      const f = (mood === 'hurt' ? 150 : 108) * p * jit()
      const d = mood === 'idle' ? 1.0 : mood === 'hurt' ? 0.5 : 1.3
      mode(o, f, 0.9, d, 0, mood === 'death' ? 0.55 : 0.85)
      mode(o, f * 2.02, 0.4, d * 0.8, 0.02, 0.9)
      mode(o, f * 3.01, 0.15, d * 0.5, 0.04, 0.9)
      burst(o, 'lowpass', 420, 0.7, 0.25, d * 0.9)
    },
  },
  baa: {
    level: 0.12,
    reach: 30,
    shape: (o, mood, p) => {
      const f = 330 * p * jit()
      const d = mood === 'idle' ? 0.55 : mood === 'hurt' ? 0.3 : 0.7
      // a wobble: two detuned modes beating against each other
      mode(o, f, 0.6, d, 0, mood === 'death' ? 0.6 : 0.92)
      mode(o, f * 1.045, 0.6, d, 0, 0.92)
      mode(o, f * 2.6, 0.25, d * 0.7)
      burst(o, 'bandpass', 1100 * p, 1.6, 0.35, d)
    },
  },
  cluck: {
    level: 0.09,
    reach: 20,
    shape: (o, mood, p) => {
      const n = mood === 'idle' ? 3 : mood === 'hurt' ? 4 : 2
      for (let i = 0; i < n; i++) {
        const t = i * 0.085
        mode(o, (mood === 'hurt' ? 900 : 640) * p * jit(0.1), 0.6, 0.06, t, 0.7)
        burst(o, 'bandpass', 1900 * p, 1.5, 0.4, 0.04, t)
      }
    },
  },
  groan: {
    level: 0.14,
    reach: 34,
    shape: (o, mood, p) => {
      const f = (mood === 'hurt' ? 120 : 86) * p * jit()
      const d = mood === 'idle' ? 1.0 : mood === 'hurt' ? 0.4 : 1.2
      mode(o, f, 0.9, d, 0, mood === 'idle' ? 1.25 : 0.55)
      mode(o, f * 2.5, 0.3, d * 0.8, 0.03, 0.7)
      burst(o, 'lowpass', 340, 0.9, 0.35, d)
      burst(o, 'bandpass', 620, 1.2, 0.18, d * 0.8, 0.05)
    },
  },
  hiss: {
    level: 0.13,
    reach: 28,
    shape: (o, mood) => {
      // the fuse: noise that swells rather than strikes, held for its length
      burst(o, 'highpass', 3600, 0.6, 0.6, mood === 'idle' ? 1.5 : 0.4, 0, 6500)
      burst(o, 'bandpass', 5200, 0.8, 0.35, mood === 'idle' ? 1.5 : 0.4, 0.05)
    },
  },
  rattle: {
    level: 0.11,
    reach: 30,
    shape: (o, mood, p) => {
      const n = mood === 'idle' ? 4 : mood === 'hurt' ? 3 : 6
      for (let i = 0; i < n; i++) {
        const t = i * 0.055 + Math.random() * 0.02
        burst(o, 'bandpass', 2600 * p * jit(0.15), 2, 0.5, 0.03, t)
        mode(o, 1400 * p * jit(0.12), 0.35, 0.04, t)
      }
    },
  },
}

const KEY: Record<Mood, string> = { idle: 'mob-idle', hurt: 'mob-hurt', death: 'mob-death' }

/** a creature's voice at a point. `pitch` is the animal's own (0.85 to 1.2) */
export const creatureVoice = (voice: Voice, mood: Mood, x: number, y: number, z: number, pitch = 1) => {
  if (voice === 'none') return
  const s = SHAPES[voice]
  const level = s.level * (mood === 'idle' ? 0.8 : 1)
  const o = placedVoice(`${KEY[mood]}:${voice}`, x, y, z, level, s.reach)
  if (o) s.shape(o, mood, pitch)
}

/** a bowstring and a shaft leaving it */
export const arrowShot = (x: number, y: number, z: number) => {
  const o = placedVoice('mob-arrow', x, y, z, 0.12, 30)
  if (!o) return
  mode(o, 260 * jit(), 0.8, 0.22, 0, 0.7)
  mode(o, 520 * jit(), 0.4, 0.14, 0, 0.75)
  burst(o, 'highpass', 3000, 0.7, 0.3, 0.05)
}

/** a shaft biting into something */
export const arrowThunk = (x: number, y: number, z: number) => {
  const o = placedVoice('mob-thunk', x, y, z, 0.1, 22)
  if (!o) return
  mode(o, 140 * jit(), 0.9, 0.09, 0, 0.6)
  burst(o, 'lowpass', 600, 0.8, 0.4, 0.06)
}

/** a creature struck: the dull knock of the blow itself */
export const creatureThump = (x: number, y: number, z: number, hard = 0.5) => {
  const o = placedVoice('mob-thump', x, y, z, 0.08 + 0.07 * hard, 20)
  if (!o) return
  mode(o, 96 * jit(), 0.9, 0.1, 0, 0.6)
  burst(o, 'lowpass', 500, 0.8, 0.5, 0.07)
}
