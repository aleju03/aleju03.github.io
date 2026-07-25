/*
  One-shot movement and interaction sounds, synthesized like sounds.ts and
  the backrooms hum: nothing shipped, nothing copyrighted. Footsteps are a
  filtered noise scuff over a low heel thump, parameterized per surface so
  wood knocks, grass swishes and the backrooms carpet swallows the step;
  doors get a stick-slip hinge creak (a sawtooth juddered by a tremolo LFO)
  and a latch click when the leaf seats. Everything here is fire-and-forget
  — sources stop themselves, so there is nothing to dispose — and the lazy
  AudioContext guards `window`, keeping the game runtime headless-safe.
  Math.random() is deliberate: audio grain is cosmetic, not world state, so
  it stays outside the seeded determinism contract (core/rand.ts).
*/

let ac: AudioContext | null = null
let noiseBuf: AudioBuffer | null = null

const audio = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  try {
    ac ??= new AudioContext()
    if (ac.state === 'suspended') void ac.resume()
    return ac
  } catch {
    return null
  }
}

/** one second of shared white noise; bursts play random slices of it */
const noise = (a: AudioContext): AudioBuffer => {
  if (!noiseBuf) {
    const len = a.sampleRate
    noiseBuf = a.createBuffer(1, len, a.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }
  return noiseBuf
}

/** a filtered slice of noise with a fast attack and exponential decay */
const burst = (
  a: AudioContext,
  at: number,
  type: BiquadFilterType,
  freq: number,
  q: number,
  gain: number,
  dur: number,
) => {
  const src = a.createBufferSource()
  src.buffer = noise(a)
  src.loop = true
  const f = a.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(gain, at + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0004, at + dur)
  src.connect(f).connect(g).connect(a.destination)
  src.start(at, Math.random() * 0.6)
  src.stop(at + dur + 0.02)
}

/** a pitched-down sine knock: the body of a heel strike or a door seating */
const thump = (a: AudioContext, at: number, f0: number, gain: number, dur: number) => {
  const o = a.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(f0, at)
  o.frequency.exponentialRampToValueAtTime(Math.max(28, f0 * 0.55), at + dur)
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(gain, at + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0004, at + dur)
  o.connect(g).connect(a.destination)
  o.start(at)
  o.stop(at + dur + 0.02)
}

export type StepSurface = 'wood' | 'stone' | 'grass' | 'carpet'

/* per-surface voicing: bandpass center for the scuff, its width and length,
   and how much tonal knock rides underneath */
const STEP: Record<
  StepSurface,
  { bp: number; q: number; dur: number; scuff: number; knock: number; knockF: number }
> = {
  wood: { bp: 1300, q: 0.8, dur: 0.07, scuff: 0.028, knock: 0.05, knockF: 84 },
  stone: { bp: 2300, q: 1.2, dur: 0.05, scuff: 0.034, knock: 0.024, knockF: 105 },
  grass: { bp: 850, q: 0.5, dur: 0.11, scuff: 0.055, knock: 0.008, knockF: 66 },
  carpet: { bp: 520, q: 0.5, dur: 0.09, scuff: 0.022, knock: 0.026, knockF: 58 },
}

/** one sole landing; weight is the walk's gait (0..1), already crouch-scaled */
export const footstep = (surface: StepSurface, weight: number, run: boolean) => {
  if (weight <= 0.05) return
  const a = audio()
  if (!a) return
  const p = STEP[surface]
  const now = a.currentTime
  // every step lands a little different: gain and pitch jitter per strike
  const w = weight * (run ? 1.3 : 1) * (0.8 + Math.random() * 0.4)
  const pitch = 0.88 + Math.random() * 0.24
  burst(a, now, 'bandpass', p.bp * pitch, p.q, p.scuff * w, p.dur)
  thump(a, now, p.knockF * pitch, p.knock * w, 0.08)
}

/** a fall absorbed: k is 0..1 of how hard the touchdown hit */
export const landThump = (surface: StepSurface, k: number) => {
  const a = audio()
  if (!a) return
  const p = STEP[surface]
  const now = a.currentTime
  thump(a, now, p.knockF * 0.8, 0.03 + 0.08 * k, 0.13)
  burst(a, now, 'bandpass', p.bp * 0.8, p.q, p.scuff * (0.8 + k), p.dur * 1.4)
}

/** the hinge working: stick-slip judder, gliding up opening and down shut */
export const doorCreak = (opening: boolean) => {
  const a = audio()
  if (!a) return
  const now = a.currentTime
  // opening starts at the handle: the latch pulls back with a click
  if (opening) burst(a, now, 'highpass', 2200, 0.7, 0.03, 0.03)
  const at = now + (opening ? 0.08 : 0.03)
  const dur = opening ? 0.55 : 0.42
  const amp = opening ? 0.13 : 0.085
  const o = a.createOscillator()
  o.type = 'sawtooth'
  const f0 = 190 + Math.random() * 90
  o.frequency.setValueAtTime(f0, at)
  o.frequency.linearRampToValueAtTime(f0 * (opening ? 1.4 : 0.78), at + dur)
  // the bandpass rides just over the fundamental so the low harmonics pass;
  // parked far above it (the first cut of this sound) the sawtooth vanishes
  const bp = a.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = f0 * 2.6
  bp.Q.value = 1.4
  // the tremolo is the creak: it carves the sawtooth into stick-slip pulses
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(amp * 0.5, at + 0.06)
  g.gain.setValueAtTime(amp * 0.5, at + dur * 0.7)
  g.gain.exponentialRampToValueAtTime(0.0004, at + dur)
  const lfo = a.createOscillator()
  lfo.frequency.value = 9 + Math.random() * 6
  const lfoG = a.createGain()
  lfoG.gain.value = amp * 0.45
  lfo.connect(lfoG).connect(g.gain)
  o.connect(bp).connect(g).connect(a.destination)
  o.start(at)
  o.stop(at + dur + 0.02)
  lfo.start(at)
  lfo.stop(at + dur + 0.02)
}

/** the leaf seating back into its frame: a wooden thud, then the latch snap */
export const doorLatch = () => {
  const a = audio()
  if (!a) return
  const now = a.currentTime
  thump(a, now, 95, 0.05, 0.09)
  burst(a, now + 0.02, 'highpass', 2600, 0.7, 0.035, 0.025)
}
