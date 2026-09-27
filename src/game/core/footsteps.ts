import type { StepSurface } from './sfx'

/*
  Footsteps: three voicings of one sole landing, and the switch between them.

  The first footsteps here were a bandpassed white-noise scuff over a sine
  thump at 58 to 105 Hz, and measured offline they were two different sounds
  depending on what you listened on. On anything with a woofer the house
  floors were a sub-bass "boop" (98% of the energy under 200 Hz) and the lawn
  a hiss (centroid 1.7 kHz, a spectral flatness of 0.65, an eighth of the
  energy over 4 kHz); on a laptop or a phone the thump is below what the
  speaker can play at all, so indoors went nearly silent and outdoors was
  only the hiss. A-weighted, the surfaces spread over 18 dB, the water
  splash loudest at -43 dBA, louder than a prop snapping. And every step was
  the same step: one fixed 6 ms envelope and a pitch that wandered about a
  semitone, three and a quarter times a second walking and five running
  (that cadence is the stride clock the legs scissor to, so it stays).

  So a step here is voiced the way a soft sole actually lands, as two
  layers: a **body**, noise through a wide band a few hundred hertz up (the
  "pat", where a small speaker still plays it) plus a short low sine under
  it for the weight a woofer can add, and a **surface** layer on top, which
  is what tells you where you are: grains of rustle on grass, a hollow
  three-mode knock on the plank floors, a dry heel tick on concrete, a
  crunch of many tiny grains on sand and snow, a splash and a bubble in
  water, a muffled puff of dust on the Moon. Each surface keeps a few
  pre-drawn variants (grain timings, pitch, length, balance, how late the
  surface follows the heel) played round-robin without repeating the last,
  with a little pitch and gain jitter on top, and the feet alternate: the
  left lands a touch lower, a touch heavier and a touch left of centre.
  Envelopes open on a linear ramp of a few milliseconds rather than an
  exponential one, which is the difference between a pat and a click.

  The three sets:

  - **a**, the refined synthesis above. Nothing shipped.
  - **b**, recorded: Kenney's CC0 "Impact Sounds" footsteps (grass, wood,
    carpet, concrete, snow), trimmed, level-matched and packed into one
    sprite, public/os/sfx/steps.mp3, credited in public/os/sfx/LICENSE.md.
    Sand, asphalt and the Moon borrow the nearest recording re-pitched and
    filtered; water has no recording and keeps set a's splash. The sprite is
    fetched only the first time set b plays a step, and set a speaks for it
    until it has decoded, the same fallback the door clips use in sfx.ts.
  - **c**, the bean: a soft rubbery pat, a sine that drops about six
    semitones in 35 ms (a squish), with a faint overtone and a puff of
    noise at the contact, over a quieter copy of set a's surface layer. It
    is the character's own sound (a jelly bean with round rubber feet) more
    than the ground's.

  All three go through one lowpass at 6 kHz per context, so nothing in any
  set can hiss, and their levels are set against each other and against the
  rest of the game's one-shots by rendering offline (`npm run steps --
  table`). The switch is `setStepSet`, persisted in localStorage and reached
  from the sandbox console's hidden `steps` command.

  Set a is the default. By the numbers all three now sit where they should
  (every surface within a few dB of -56 dBA, nothing over 4 kHz), and a is
  the one with the least to wear on you over minutes of walking: a soft
  onset (b's recordings open on a heel transient under a millisecond), the
  widest step-to-step variation (a 3 semitone spread in brightness against
  c's one, and c is a pitched tone, which a repeated sound makes into a
  tune), and no download.

  Headless-safe: nothing here runs until a caller hands it an AudioContext,
  and the one storage read is guarded. Math.random() is deliberate, as in
  sfx.ts: audio grain is cosmetic, not world state.
*/

export type StepSet = 'a' | 'b' | 'c'
export const STEP_SETS: readonly StepSet[] = ['a', 'b', 'c']
export const DEFAULT_STEP_SET: StepSet = 'a'
const STORE = 'alejos-steps'

const stored = (): StepSet => {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORE)
    return v === 'a' || v === 'b' || v === 'c' ? v : DEFAULT_STEP_SET
  } catch {
    return DEFAULT_STEP_SET
  }
}
let current: StepSet = stored()

/** which set is playing */
export const stepSet = () => current
/** switch sets; `persist` keeps the choice across loads */
export const setStepSet = (s: StepSet, persist = true) => {
  current = s
  if (!persist) return
  try {
    if (typeof localStorage !== 'undefined') {
      if (s === DEFAULT_STEP_SET) localStorage.removeItem(STORE)
      else localStorage.setItem(STORE, s)
    }
  } catch {
    /* private mode: the switch still holds for the session */
  }
}

/* ---------------------------------------------------------------- bus -- */

interface Bus {
  a: BaseAudioContext
  out: AudioNode
  noise: AudioBuffer
}
const buses = new WeakMap<BaseAudioContext, Bus>()

/** one lowpass per context that every step goes through, and a second of
    pink noise (warmer than white: equal energy per octave, so the slices a
    bandpass takes out of it are not all fizz) */
const busFor = (a: BaseAudioContext): Bus => {
  let b = buses.get(a)
  if (b) return b
  const lp = a.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 6000
  lp.Q.value = 0.5
  lp.connect(a.destination)
  const noise = a.createBuffer(1, a.sampleRate, a.sampleRate)
  const d = noise.getChannelData(0)
  // Paul Kellet's economy pink filter
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2
  }
  b = { a, out: lp, noise }
  buses.set(a, b)
  return b
}

/** a step's own strip: its level and which side of centre the foot is on */
const strip = (b: Bus, gain: number, pan: number): AudioNode => {
  const g = b.a.createGain()
  g.gain.value = gain
  const p = b.a.createStereoPanner()
  p.pan.value = pan
  g.connect(p).connect(b.out)
  return g
}

/** a linear-attack, exponential-release envelope on a fresh gain node */
const envelope = (b: Bus, at: number, peak: number, attack: number, dur: number) => {
  const g = b.a.createGain()
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(peak, at + attack)
  // five time constants in `dur`: -43 dB by the time the source stops
  g.gain.setTargetAtTime(0, at + attack, dur / 5)
  return g
}

interface Hiss {
  type: BiquadFilterType
  f: number
  q: number
  gain: number
  attack: number
  dur: number
  /** the filter's frequency at the end, as a multiple of `f` */
  sweep?: number
}

/** a slice of pink noise through one filter, under an envelope */
const hiss = (b: Bus, to: AudioNode, at: number, h: Hiss) => {
  const src = b.a.createBufferSource()
  src.buffer = b.noise
  src.loop = true
  const f = b.a.createBiquadFilter()
  f.type = h.type
  f.frequency.setValueAtTime(h.f, at)
  if (h.sweep) f.frequency.exponentialRampToValueAtTime(h.f * h.sweep, at + h.attack + h.dur)
  f.Q.value = h.q
  src.connect(f).connect(envelope(b, at, h.gain, h.attack, h.dur)).connect(to)
  src.start(at, Math.random() * 0.9)
  src.stop(at + h.attack + h.dur + 0.02)
}

interface Tone {
  f: number
  /** where the pitch ends, as a multiple of `f` (1 holds it) */
  to: number
  /** how long the glide takes */
  glide: number
  gain: number
  attack: number
  dur: number
}

/** a sine under an envelope, gliding from f to f * to */
const tone = (b: Bus, to: AudioNode, at: number, t: Tone) => {
  const o = b.a.createOscillator()
  o.frequency.setValueAtTime(t.f, at)
  if (t.to !== 1) o.frequency.exponentialRampToValueAtTime(t.f * t.to, at + t.glide)
  o.connect(envelope(b, at, t.gain, t.attack, t.dur)).connect(to)
  o.start(at)
  o.stop(at + t.attack + t.dur + 0.02)
}

/* ------------------------------------------------------------- voices -- */

/** grains of rustle or crunch: many tiny noise bursts scattered in time */
interface Grains {
  n: number
  spread: number
  f: number
  q: number
  gain: number
  dur: number
}

/** one surface's recipe for set a; the fields that are absent are layers
    this surface does not have */
interface Recipe {
  /** the pat: noise through a wide band a few hundred hertz up, where a
      small speaker still plays it */
  body: { f: number; gain: number; attack: number; dur: number }
  /** the weight under it, for whoever has a woofer */
  thud: { f: number; gain: number; dur: number }
  /** a resonant knock: [frequency, gain, decay] per mode */
  modes?: Array<[number, number, number]>
  /** a heel tick or a sole scuff: bandpassed noise */
  tick?: Hiss
  grains?: Grains
  /** a pitched bubble, rising (water) */
  bubble?: Tone
}

const R = (body: Recipe['body'], thud: Recipe['thud'], rest: Omit<Recipe, 'body' | 'thud'> = {}): Recipe => ({
  body,
  thud,
  ...rest,
})

const RECIPES: Record<StepSurface, Recipe> = {
  grass: R({ f: 380, gain: 1.5, attack: 0.006, dur: 0.075 }, { f: 118, gain: 0.16, dur: 0.06 }, {
    tick: { type: 'bandpass', f: 1150, q: 0.8, gain: 0.22, attack: 0.018, dur: 0.07 },
    grains: { n: 5, spread: 0.07, f: 2300, q: 1.3, gain: 0.3, dur: 0.012 },
  }),
  wood: R({ f: 430, gain: 1.1, attack: 0.004, dur: 0.045 }, { f: 96, gain: 0.16, dur: 0.07 }, {
    modes: [[196, 0.4, 0.085], [452, 0.42, 0.05], [1030, 0.1, 0.025]],
    tick: { type: 'bandpass', f: 1900, q: 1.1, gain: 0.12, attack: 0.002, dur: 0.012 },
  }),
  carpet: R({ f: 300, gain: 1.6, attack: 0.008, dur: 0.06 }, { f: 104, gain: 0.14, dur: 0.055 }, {
    tick: { type: 'bandpass', f: 880, q: 0.7, gain: 0.18, attack: 0.012, dur: 0.05 },
  }),
  stone: R({ f: 520, gain: 1.1, attack: 0.003, dur: 0.035 }, { f: 142, gain: 0.14, dur: 0.04 }, {
    tick: { type: 'bandpass', f: 2900, q: 1.5, gain: 0.22, attack: 0.001, dur: 0.012 },
    grains: { n: 2, spread: 0.03, f: 2100, q: 1.2, gain: 0.12, dur: 0.01 },
  }),
  asphalt: R({ f: 460, gain: 1.2, attack: 0.004, dur: 0.04 }, { f: 132, gain: 0.14, dur: 0.045 }, {
    tick: { type: 'bandpass', f: 2200, q: 1.2, gain: 0.16, attack: 0.001, dur: 0.012 },
    grains: { n: 3, spread: 0.045, f: 1600, q: 1, gain: 0.16, dur: 0.012 },
  }),
  sand: R({ f: 340, gain: 1.3, attack: 0.008, dur: 0.08 }, { f: 100, gain: 0.13, dur: 0.06 }, {
    grains: { n: 9, spread: 0.09, f: 1500, q: 0.9, gain: 0.26, dur: 0.01 },
  }),
  snow: R({ f: 300, gain: 1.1, attack: 0.01, dur: 0.08 }, { f: 92, gain: 0.12, dur: 0.06 }, {
    grains: { n: 8, spread: 0.1, f: 1850, q: 2.4, gain: 0.32, dur: 0.014 },
  }),
  water: R({ f: 420, gain: 0.9, attack: 0.01, dur: 0.09 }, { f: 90, gain: 0.1, dur: 0.07 }, {
    tick: { type: 'bandpass', f: 720, q: 0.8, gain: 0.7, attack: 0.014, dur: 0.13, sweep: 1.6 },
    bubble: { f: 360, to: 1.7, glide: 0.045, gain: 0.12, attack: 0.004, dur: 0.05 },
    grains: { n: 4, spread: 0.16, f: 2000, q: 3, gain: 0.1, dur: 0.02 },
  }),
  // low gravity lands slowly and the suit hears it through the boot: long,
  // low and muffled, with a puff of dust rather than a crunch
  regolith: R({ f: 240, gain: 1.6, attack: 0.014, dur: 0.13 }, { f: 78, gain: 0.18, dur: 0.12 }, {
    grains: { n: 6, spread: 0.12, f: 850, q: 0.8, gain: 0.2, dur: 0.022 },
  }),
}

/** one pre-drawn take of a surface: where the grains fall and how it is
    balanced. Drawn once per surface per set, then round-robined */
interface Variant {
  pitch: number
  body: number
  tex: number
  /** how long it rings, as a multiple */
  len: number
  /** how far set c's squish bends, as a multiple */
  bend: number
  /** how late the surface lands after the body: heel, then the rest */
  lag: number
  grains: Array<{ dt: number; f: number; g: number; d: number }>
}
const VARIANTS = 4
const drawVariant = (r: Recipe): Variant => {
  const grains: Variant['grains'] = []
  if (r.grains) {
    for (let i = 0; i < r.grains.n; i++) {
      grains.push({
        // bunched toward the start: the sole settles, it does not keep on
        dt: r.grains.spread * Math.pow(Math.random(), 1.6),
        f: r.grains.f * (0.75 + Math.random() * 0.5),
        g: r.grains.gain * (0.4 + Math.random() * 0.6),
        d: r.grains.dur * (0.6 + Math.random() * 0.8),
      })
    }
  }
  return {
    pitch: 0.93 + Math.random() * 0.14,
    body: 0.85 + Math.random() * 0.3,
    tex: 0.7 + Math.random() * 0.6,
    len: 0.8 + Math.random() * 0.4,
    bend: 0.8 + Math.random() * 0.4,
    lag: Math.random() * 0.014,
    grains,
  }
}
const variants = new Map<string, Variant[]>()
const lastVariant = new Map<string, number>()
/** a variant of this surface for this set, never the one that just played */
const nextVariant = (set: StepSet, s: StepSurface): Variant => {
  const key = `${set}:${s}`
  let vs = variants.get(key)
  if (!vs) {
    vs = Array.from({ length: VARIANTS }, () => drawVariant(RECIPES[s]))
    variants.set(key, vs)
  }
  const last = lastVariant.get(key) ?? -1
  let i = Math.floor(Math.random() * (VARIANTS - 1))
  if (i >= last && last >= 0) i++
  lastVariant.set(key, i)
  return vs[i]
}

/** which foot is landing: the left is a hair lower, heavier and left */
let left = false
interface Foot {
  pitch: number
  gain: number
  pan: number
}
const nextFoot = (): Foot => {
  left = !left
  return {
    pitch: (left ? 0.975 : 1.025) * (0.97 + Math.random() * 0.06),
    gain: (left ? 1 : 0.9) * (0.88 + Math.random() * 0.24),
    pan: (left ? -0.1 : 0.1) + (Math.random() - 0.5) * 0.04,
  }
}

/**
 * Set a's surface layer: everything but the body. Set c lays a quieter copy
 * of it under its own squish, and set b uses it for the one surface it has
 * no recording of.
 */
const surfaceLayer = (b: Bus, to: AudioNode, at: number, r: Recipe, v: Variant, p: number, k: number, len: number) => {
  if (r.modes) {
    for (const [f, g, d] of r.modes) {
      tone(b, to, at, { f: f * p, to: 1, glide: 0, gain: g * k, attack: 0.002, dur: d * len })
    }
  }
  if (r.tick) hiss(b, to, at, { ...r.tick, f: r.tick.f * p, gain: r.tick.gain * k, dur: r.tick.dur * len })
  for (const gr of v.grains) {
    hiss(b, to, at + gr.dt * len, { type: 'bandpass', f: gr.f * p, q: r.grains!.q, gain: gr.g * k, attack: 0.001, dur: gr.d })
  }
  if (r.bubble) tone(b, to, at + 0.02, { ...r.bubble, f: r.bubble.f * p, gain: r.bubble.gain * k })
}

/** set a: the body and the surface layer, at full strength */
const voiceA = (b: Bus, to: AudioNode, at: number, s: StepSurface, w: number, run: boolean, land: number, fp: number) => {
  const r = RECIPES[s]
  const v = nextVariant('a', s)
  const p = v.pitch * fp
  // a landing is longer, heavier and lower; a run is a hair shorter so a
  // five-a-second cadence does not smear into one continuous scuff
  const len = (land > 0 ? 1.5 + 0.5 * land : run ? 0.85 : 1) * v.len
  const heavy = land > 0 ? 1.6 + 1.4 * land : 1
  hiss(b, to, at, {
    type: 'bandpass',
    f: r.body.f * p * (land > 0 ? 0.85 : 1),
    q: 0.9,
    gain: r.body.gain * v.body * heavy,
    attack: r.body.attack,
    dur: r.body.dur * len,
  })
  tone(b, to, at, { f: r.thud.f * p, to: 0.7, glide: r.thud.dur * len, gain: r.thud.gain * heavy, attack: 0.005, dur: r.thud.dur * len })
  // soft steps have less crunch in them than hard ones
  surfaceLayer(b, to, at + v.lag, r, v, p, v.tex * Math.pow(w, 0.5) * (land > 0 ? 1 + land : 1), len)
}

/* the bean's squish: a base pitch per surface, how far it drops, and how
   long; harder floors ring a little higher, soft ground a little lower */
const SQUISH: Record<StepSurface, { f: number; from: number; glide: number; dur: number }> = {
  grass: { f: 262, from: 1.45, glide: 0.035, dur: 0.07 },
  wood: { f: 290, from: 1.42, glide: 0.03, dur: 0.065 },
  carpet: { f: 236, from: 1.4, glide: 0.035, dur: 0.07 },
  stone: { f: 310, from: 1.4, glide: 0.028, dur: 0.06 },
  asphalt: { f: 295, from: 1.4, glide: 0.03, dur: 0.06 },
  sand: { f: 250, from: 1.45, glide: 0.04, dur: 0.075 },
  snow: { f: 255, from: 1.4, glide: 0.035, dur: 0.07 },
  // a bloop: the only one that rises, as a bubble does
  water: { f: 330, from: 0.72, glide: 0.05, dur: 0.08 },
  // the Moon: a slow, low boing
  regolith: { f: 190, from: 1.55, glide: 0.08, dur: 0.15 },
}

/** set c: a rubbery pat, then a quieter copy of set a's surface */
const voiceC = (b: Bus, to: AudioNode, at: number, s: StepSurface, w: number, run: boolean, land: number, fp: number) => {
  const q = SQUISH[s]
  const v = nextVariant('c', s)
  const p = v.pitch * fp
  const len = (land > 0 ? 1.4 + 0.6 * land : run ? 0.85 : 1) * v.len
  const heavy = land > 0 ? 1.5 + 1.2 * land : 1
  // a landing squashes further, so it starts higher and falls further
  const from = 1 + (q.from - 1) * v.bend * (land > 0 ? 1.3 + 0.3 * land : 1)
  const f = q.f * p * (land > 0 ? 0.8 : 1)
  tone(b, to, at, { f: f * from, to: 1 / from, glide: q.glide * len, gain: 0.5 * v.body * heavy, attack: 0.004, dur: q.dur * len })
  // the overtone that makes it rubber rather than a sine, and what a phone
  // speaker actually plays of it
  tone(b, to, at, { f: f * from * 2.3, to: 1 / from, glide: q.glide * len, gain: 0.2 * heavy, attack: 0.003, dur: q.dur * 0.55 * len })
  // the contact itself: a puff of noise, so it is a pat and not a note
  hiss(b, to, at, { type: 'bandpass', f: 700 * p, q: 0.8, gain: 0.8 * heavy, attack: 0.002, dur: 0.024 * len })
  surfaceLayer(b, to, at + v.lag, RECIPES[s], nextVariant('a', s), p, 0.5 * v.tex * Math.pow(w, 0.5), len)
}

/* ----------------------------------------------------------- recorded -- */

/* the sprite: every clip in its own slot, SLOT seconds apart, starting
   LEAD seconds into it (a hair of pre-roll before the onset, so no attack
   is ever clipped). The order is the order they were packed in */
const SLOT = 0.25
const LEAD = 0.01
/** how far ahead of its onset each clip was cut */
const PRE = 0.002
const CLIPS = {
  grass: [0, 5],
  wood: [5, 5],
  carpet: [10, 3],
  concrete: [13, 5],
  snow: [18, 5],
} as const
type ClipSet = keyof typeof CLIPS

/* per surface: which recordings, re-pitched how far, filtered how dark,
   and a level. Sand is snow's crunch pitched up and dulled (drier and
   finer), asphalt concrete's scuff pitched down, the Moon snow's crunch
   slowed and muffled. Water has no recording: set a's splash plays */
const TAKES: Record<Exclude<StepSurface, 'water'>, { clips: ClipSet; rate: number; lp: number; gain: number; dur: number }> = {
  grass: { clips: 'grass', rate: 1, lp: 6000, gain: 1, dur: 0.2 },
  wood: { clips: 'wood', rate: 1, lp: 6000, gain: 1, dur: 0.12 },
  carpet: { clips: 'carpet', rate: 1, lp: 6000, gain: 1, dur: 0.12 },
  stone: { clips: 'concrete', rate: 1.04, lp: 6000, gain: 1, dur: 0.12 },
  asphalt: { clips: 'concrete', rate: 0.94, lp: 3200, gain: 1, dur: 0.12 },
  sand: { clips: 'snow', rate: 1.18, lp: 2600, gain: 1, dur: 0.22 },
  snow: { clips: 'snow', rate: 1, lp: 6000, gain: 1, dur: 0.22 },
  regolith: { clips: 'snow', rate: 0.72, lp: 900, gain: 1.3, dur: 0.22 },
}

let sprite: AudioBuffer | null = null
/** how late the decoder put the first onset (an MP3 decoder may or may not
    strip the encoder's priming samples, so it is measured, not assumed) */
let spriteShift = 0
let loading: Promise<void> | null = null

/** fetch and decode the recorded set against this context, once; settles
    either way, and a failure just leaves set a speaking for set b */
export const preloadSteps = (a: BaseAudioContext): Promise<void> => {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return Promise.resolve()
  loading ??= fetch('/os/sfx/steps.mp3')
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((bytes) => (bytes ? a.decodeAudioData(bytes) : null))
    .then((buf) => {
      if (!buf) return
      const d = buf.getChannelData(0)
      const lim = Math.min(d.length, Math.round(buf.sampleRate * SLOT))
      let i = 0
      while (i < lim && Math.abs(d[i]) < 0.02) i++
      spriteShift = i < lim ? Math.max(-LEAD, Math.min(0.08, i / buf.sampleRate - LEAD - PRE)) : 0
      sprite = buf
    })
    .catch(() => {})
  return loading
}

const lastClip = new Map<ClipSet, number>()
/** how hard set a's knock sits over the recorded planks */
const WOOD_KNOCK = 1.2

/** set b: a recording, or false when it is not decoded yet */
const voiceB = (b: Bus, to: AudioNode, at: number, s: StepSurface, w: number, run: boolean, land: number, fp: number) => {
  if (s === 'water') {
    voiceA(b, to, at, s, w, run, land, fp)
    return true
  }
  if (!sprite) {
    void preloadSteps(b.a)
    return false
  }
  const t = TAKES[s]
  const [first, n] = CLIPS[t.clips]
  const last = lastClip.get(t.clips) ?? -1
  let i = Math.floor(Math.random() * (n - 1))
  if (i >= last && last >= 0) i++
  lastClip.set(t.clips, i)
  const src = b.a.createBufferSource()
  src.buffer = sprite
  src.playbackRate.value = t.rate * fp * (land > 0 ? 0.88 : 1)
  const lp = b.a.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = t.lp
  lp.Q.value = 0.5
  // a ramp in over the pre-roll and 2.5 ms past it: the grass and concrete
  // takes open on a heel transient under a millisecond long, which is a
  // click at five steps a second
  const g = b.a.createGain()
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(t.gain * (land > 0 ? 1.6 + 1.2 * land : 1), at + PRE + 0.0025)
  src.connect(lp).connect(g).connect(to)
  const off = (first + i) * SLOT + LEAD + spriteShift
  // never past the slot: the next clip starts there
  src.start(at, Math.max(0, off), Math.min(SLOT - LEAD - spriteShift, (run ? 0.8 : 1) * t.dur * (land > 0 ? 1.4 : 1)))
  // the recorded planks are a thud under 250 Hz (a centroid of 107 Hz), which
  // a phone or laptop speaker cannot play at all, so set a's hollow knock
  // rides on top of them
  if (s === 'wood') surfaceLayer(b, to, at, RECIPES.wood, nextVariant('a', 'wood'), fp, WOOD_KNOCK, 1)
  // a landing gets set a's weight under it: the recordings are single steps
  if (land > 0) tone(b, to, at, { f: RECIPES[s].thud.f, to: 0.7, glide: 0.12, gain: 0.5 * land, attack: 0.005, dur: 0.12 })
  return true
}

/* -------------------------------------------------------------- level -- */

/* each set's level, and per surface a trim, both measured offline (`npm run
   steps -- table` and an A-weighted level per step) so that every floor in
   every set lands within about a decibel of -56 dBA on the walk, carpet,
   snow and the Moon a shade under. That is seven decibels under the old
   grass step and thirteen under the old water hiss, and some 15 dB of peak
   under a door or a prop landing, which is where something that happens
   three times a second belongs. The gains inside the voices are only each
   layer's balance against the others */
const LEVEL: Record<StepSet, number> = { a: 0.03, b: 0.03, c: 0.03 }
const TRIM: Record<StepSet, Record<StepSurface, number>> = {
  a: { grass: 1.51, wood: 1.23, carpet: 1.17, stone: 1.88, asphalt: 1.72, sand: 1.64, snow: 2.34, water: 1.46, regolith: 1.43 },
  b: { grass: 1.36, wood: 0.96, carpet: 1.0, stone: 1.72, asphalt: 1.73, sand: 1.66, snow: 1.58, water: 1.55, regolith: 1.31 },
  c: { grass: 1.02, wood: 1.05, carpet: 0.99, stone: 0.98, asphalt: 1.12, sand: 1.17, snow: 1.01, water: 1.24, regolith: 1.3 },
}
const level = (set: StepSet, s: StepSurface) => LEVEL[set] * TRIM[set][s]

const play = (a: BaseAudioContext, s: StepSurface, w: number, run: boolean, land: number) => {
  const b = busFor(a)
  const foot = nextFoot()
  const set = current
  const k = (land > 0 ? 1 : w * (run ? 1.12 : 1)) * foot.gain
  const at = a.currentTime + 0.002
  const to = strip(b, level(set, s) * k, foot.pan)
  if (set === 'b' && voiceB(b, to, at, s, w, run, land, foot.pitch)) return
  if (set === 'c') voiceC(b, to, at, s, w, run, land, foot.pitch)
  else {
    // set b falls back to set a, at set a's level, while the sprite loads
    if (set === 'b') (to as GainNode).gain.value = level('a', s) * k
    voiceA(b, to, at, s, w, run, land, foot.pitch)
  }
}

/** one sole landing, `weight` the gait (0..1, already crouch-scaled) */
export const playStep = (a: BaseAudioContext, s: StepSurface, weight: number, run: boolean) =>
  play(a, s, Math.min(1, Math.pow(weight, 0.9)), run, 0)

/** a fall absorbed: `k` is 0..1 of how hard the touchdown hit */
export const playLand = (a: BaseAudioContext, s: StepSurface, k: number) =>
  play(a, s, 1, false, Math.max(0.05, Math.min(1, k)))
