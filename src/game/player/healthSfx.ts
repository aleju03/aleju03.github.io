import { sharedAudio } from '../core/sfx'

/*
  The sounds of being hurt, synthesized like everything else in core/sfx.ts
  and deliberately quiet: a hit is a dull knock with a short falling grunt
  over it, death a longer falling tone that sinks, a respawn a soft rising
  two-note chime. Peak gains sit with the landing thump and the spawn pop
  (0.05-0.09), well under a door's 0.1 and under the footsteps, so a fight
  never drowns the score. They own a private noise buffer rather than
  reaching into sfx.ts's, whose burst/thump helpers are module-private.
  Fire-and-forget, headless-safe (no window, no sound).
*/

let noiseBuf: AudioBuffer | null = null
const noise = (a: AudioContext) => {
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return noiseBuf
}

const tone = (
  a: AudioContext, at: number, f0: number, f1: number, gain: number, dur: number, type: OscillatorType = 'sine',
) => {
  const o = a.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, at)
  o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), at + dur)
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(gain, at + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0004, at + dur)
  o.connect(g).connect(a.destination)
  o.start(at)
  o.stop(at + dur + 0.02)
}

const puff = (a: AudioContext, at: number, freq: number, gain: number, dur: number) => {
  const s = a.createBufferSource()
  s.buffer = noise(a)
  s.loop = true
  const f = a.createBiquadFilter()
  f.type = 'lowpass'
  f.frequency.value = freq
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(gain, at + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0004, at + dur)
  s.connect(f).connect(g).connect(a.destination)
  s.start(at, Math.random() * 0.6)
  s.stop(at + dur + 0.02)
}

/** `amount` in hit points: a graze is a tick, a heavy hit a knock and a grunt */
export const hurtSound = (amount: number) => {
  const a = sharedAudio()
  if (!a) return
  const now = a.currentTime
  const k = Math.min(1, Math.max(0, amount / 60))
  puff(a, now, 700 + 500 * (1 - k), 0.05 + 0.04 * k, 0.09)
  tone(a, now, 130, 62, 0.05 + 0.04 * k, 0.16)
  // a short falling grunt, a little different each time
  const r = 0.94 + Math.random() * 0.12
  tone(a, now + 0.01, (300 + 90 * (1 - k)) * r, 170 * r, 0.03 + 0.02 * k, 0.14, 'triangle')
}

export const deathSound = () => {
  const a = sharedAudio()
  if (!a) return
  const now = a.currentTime
  puff(a, now, 500, 0.08, 0.2)
  tone(a, now, 110, 44, 0.09, 0.42)
  tone(a, now + 0.02, 330, 96, 0.04, 0.9, 'triangle')
}

export const respawnSound = () => {
  const a = sharedAudio()
  if (!a) return
  const now = a.currentTime
  tone(a, now, 392, 392, 0.035, 0.22)
  tone(a, now + 0.11, 587, 587, 0.035, 0.34)
}
