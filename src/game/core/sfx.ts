/*
  One-shot movement and interaction sounds. Footsteps are a filtered noise
  scuff over a low heel thump, parameterized per surface so wood knocks,
  grass swishes and the backrooms carpet swallows the step — synthesized
  like sounds.ts and the backrooms hum, nothing shipped, nothing
  copyrighted. The house doors are the one exception on the whole site: a
  hinge is stick-slip friction, and the sawtooth-through-a-tremolo version
  of that (still below, and still what you hear on a cold load) never
  stopped sounding like a synthesizer imitating a door. So they play nine
  clips cut from CC BY recordings of four real doors — three voices each of
  swing open, swing shut and leaf seating — credited in
  public/os/sfx/LICENSE.md. Every clip is cut to start ON its onset and run
  about as long as the leaf takes to swing: a recording that opens with a
  quarter second of handle noise is heard as the game lagging, not as a
  door. They are fetched when this module loads and decoded against the
  first AudioContext, and every door sound falls back to its synthesized
  voice until its buffer is ready, so nothing is ever silent waiting on a
  download. Everything here is fire-and-forget — sources stop themselves,
  so there is nothing to dispose — and both the lazy AudioContext and the
  fetch guard `window`, keeping the game runtime headless-safe.
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
    if (pending.size) decodeClips(ac)
    return ac
  } catch {
    return null
  }
}

/** the same lazy context, for the browser-side audio that lives outside this
    module — proximity voice hangs its listener and its panners here rather
    than opening a second context, since a page only gets a handful. Returns
    null headless, exactly like every sound below. */
export const sharedAudio = audio

/* ---------------------------------------------------------- recorded -- */

type Clip = `door-${'open' | 'close' | 'latch'}-${1 | 2 | 3}`
/* three voices per event, cut from four different real doors. A clip is
   chosen per swing rather than per door: the same door heard twice running
   is the one repeat a player actually notices. The seat that lands half a
   second after a close borrows that close's voice, so the two halves of
   shutting a door stay one door. */
const OPENS: Clip[] = ['door-open-1', 'door-open-2', 'door-open-3']
const CLOSES: Clip[] = ['door-close-1', 'door-close-2', 'door-close-3']
const LATCHES: Clip[] = ['door-latch-1', 'door-latch-2', 'door-latch-3']
const CLIPS: Clip[] = [...OPENS, ...CLOSES, ...LATCHES]
let openVoice = 0
let closeVoice = 0
/** step 1 or 2 places on: random, but never the voice that just played */
const nextVoice = (last: number) => (last + 1 + Math.floor(Math.random() * 2)) % 3
/** downloaded but not yet decoded; an entry is dropped on its one attempt.
    A miss settles to null rather than rejecting: nothing handles these until
    the first sound, which may never come (the flat OS bezel plays none) */
const pending = new Map<Clip, Promise<ArrayBuffer | null>>()
const decoded = new Map<Clip, AudioBuffer>()

if (typeof window !== 'undefined') {
  for (const c of CLIPS) {
    pending.set(
      c,
      fetch(`/os/sfx/${c}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null),
    )
  }
}

/** decoding needs a context, which needs a first sound; every failure just
    leaves the clip out and the synthesized voice keeps the door audible */
const decodeClips = (a: AudioContext) => {
  for (const [clip, bytes] of pending) {
    pending.delete(clip)
    void bytes
      .then((b) => (b ? a.decodeAudioData(b) : null))
      .then((buf) => {
        if (buf) decoded.set(clip, buf)
      })
      .catch(() => {})
  }
}

/** play a recorded clip; false when its buffer isn't ready (or never will be) */
const sample = (a: AudioContext, clip: Clip, gain: number, rate: number) => {
  const buf = decoded.get(clip)
  if (!buf) return false
  const src = a.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = rate
  const g = a.createGain()
  g.gain.value = gain
  src.connect(g).connect(a.destination)
  src.start()
  return true
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

export type StepSurface =
  | 'wood' | 'stone' | 'grass' | 'carpet'
  | 'sand' | 'snow' | 'asphalt' | 'water'

/* per-surface voicing: bandpass center for the scuff, its width and length,
   and how much tonal knock rides underneath. The four outdoor surfaces came
   with the open world and are voiced against the original four rather than
   from scratch: sand is grass with the knock taken out and the scuff pushed
   down, snow is a shorter, duller sand (a squeak with no ring under it),
   asphalt is stone with the top end filed off, and water is a wide, wet
   splash — the widest bandpass here, and the only one whose scuff outweighs
   everything else in the mix. */
const STEP: Record<
  StepSurface,
  { bp: number; q: number; dur: number; scuff: number; knock: number; knockF: number }
> = {
  wood: { bp: 1300, q: 0.8, dur: 0.07, scuff: 0.028, knock: 0.05, knockF: 84 },
  stone: { bp: 2300, q: 1.2, dur: 0.05, scuff: 0.034, knock: 0.024, knockF: 105 },
  grass: { bp: 850, q: 0.5, dur: 0.11, scuff: 0.055, knock: 0.008, knockF: 66 },
  carpet: { bp: 520, q: 0.5, dur: 0.09, scuff: 0.022, knock: 0.026, knockF: 58 },
  sand: { bp: 720, q: 0.45, dur: 0.1, scuff: 0.046, knock: 0.004, knockF: 58 },
  snow: { bp: 600, q: 0.7, dur: 0.07, scuff: 0.038, knock: 0.006, knockF: 52 },
  asphalt: { bp: 1750, q: 1.0, dur: 0.055, scuff: 0.031, knock: 0.022, knockF: 96 },
  water: { bp: 1150, q: 0.32, dur: 0.16, scuff: 0.07, knock: 0.005, knockF: 48 },
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

/** the hinge working: the recorded swing, or the stick-slip judder below
    (gliding up opening and down shut) while that clip is still loading */
export const doorCreak = (opening: boolean) => {
  const a = audio()
  if (!a) return
  // a fresh voice each swing, plus a little rate jitter under it. The gains
  // are matched to the synthesized creak below, which was tuned against the
  // footsteps — a normalized clip runs ~4x hotter than anything else in this
  // mix and walks all over them
  if (opening) openVoice = nextVoice(openVoice)
  else closeVoice = nextVoice(closeVoice)
  if (
    sample(
      a,
      opening ? OPENS[openVoice] : CLOSES[closeVoice],
      opening ? 0.1 : 0.09,
      0.96 + Math.random() * 0.08,
    )
  )
    return
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

/** the leaf seating back into its frame: the recorded latch, or a wooden
    thud and a synthesized snap until it lands */
export const doorLatch = () => {
  const a = audio()
  if (!a) return
  // the same door that just swung shut, not a fourth one
  if (sample(a, LATCHES[closeVoice], 0.1, 0.97 + Math.random() * 0.06)) return
  const now = a.currentTime
  thump(a, now, 95, 0.05, 0.09)
  burst(a, now + 0.02, 'highpass', 2600, 0.7, 0.035, 0.025)
}
