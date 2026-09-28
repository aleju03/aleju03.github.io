import { burst, mode, placedVoice } from '../impactSounds'

/*
  The creative props' sounds, synthesized on the props' own bus
  (impactSounds.ts's `placedVoice`, `burst`, `mode`): the same distance law,
  limiter and voice budget as a crate hitting the ground, and levels
  peak-matched against the same references (film's `props:sounds` table
  prints them: a light knock of anything lands at 0.01 to 0.05, a break at
  about 0.2). None of them is loud. They are all small, close things: a
  switch, a spray can, a chalk, a fuse counting down, a shutter, a squeak of
  latex.

  Headless-safe: `placedVoice` is null without a window and every call
  returns.
*/

/** a lamp's switch: a tiny click, a little higher going on */
export const lampClick = (x: number, y: number, z: number, on: boolean) => {
  const o = placedVoice('lamp', x, y, z, 0.1, 18)
  if (!o) return
  burst(o, 'bandpass', on ? 3200 : 2400, 1.6, 0.6, 0.012)
  mode(o, on ? 1900 : 1500, 0.5, 0.03)
  mode(o, on ? 560 : 420, 0.4, 0.05, 0.004, 0.8)
}

/** the paint can: a hiss of noise that rattles once at the start */
export const paintSpray = (x: number, y: number, z: number) => {
  const o = placedVoice('paint', x, y, z, 0.09, 20)
  if (!o) return
  mode(o, 2600, 0.18, 0.02)
  mode(o, 2300, 0.15, 0.02, 0.035)
  burst(o, 'bandpass', 5200, 0.8, 0.7, 0.22, 0.05, 3400)
  burst(o, 'highpass', 6500, 0.6, 0.25, 0.18, 0.06)
}

/** chalk on a board: three scratches */
export const signWrite = (x: number, y: number, z: number) => {
  const o = placedVoice('sign', x, y, z, 0.09, 20)
  if (!o) return
  for (let i = 0; i < 4; i++) {
    burst(o, 'bandpass', 2800 + Math.random() * 1600, 1.3, 0.55, 0.05 + Math.random() * 0.04, i * 0.085, 1600)
  }
  mode(o, 190, 0.3, 0.05)
}

/** a fuse counting down: one blip a second, higher and louder toward the end */
export const fuseTick = (x: number, y: number, z: number, urgency: number) => {
  const u = Math.max(0, Math.min(1, urgency))
  const o = placedVoice('fuse', x, y, z, 0.07 + 0.08 * u, 24)
  if (!o) return
  mode(o, 1050 + 900 * u, 0.9, 0.06)
  burst(o, 'bandpass', 3000, 1.2, 0.25, 0.015)
}

/** a shutter: two clicks a hair apart, the second lower */
export const shutter = (x: number, y: number, z: number) => {
  const o = placedVoice('shutter', x, y, z, 0.12, 30)
  if (!o) return
  burst(o, 'bandpass', 3400, 1.4, 0.7, 0.014)
  mode(o, 1200, 0.6, 0.03)
  burst(o, 'bandpass', 1800, 1.2, 0.6, 0.02, 0.07)
  mode(o, 520, 0.7, 0.05, 0.07, 0.7)
}

/** a balloon tied on: a squeak of rubber on a rope */
export const tieSqueak = (x: number, y: number, z: number) => {
  const o = placedVoice('tie', x, y, z, 0.08, 18)
  if (!o) return
  mode(o, 700, 0.45, 0.09, 0, 1.5)
  mode(o, 1400, 0.2, 0.07, 0.01, 1.4)
  burst(o, 'bandpass', 1800, 1.5, 0.15, 0.05)
}
