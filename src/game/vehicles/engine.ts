/*
  The car's engine note: three voices to choose between by ear, behind the
  hidden console command `engine a|b|c`.

  The car used to sing through the same recipe as the boat and the heli,
  three detuned sawtooths and a sine sub through an opening lowpass. That is
  a synth pad. The detune beats against itself, which is the grating part,
  and a steady periodic tone has none of what makes an engine an engine: it
  is a train of separate exhaust pulses, each a little different from the
  last, grouped by the firing order, rung through a pipe and a muffler whose
  resonances stay put while the revs move, and rougher when it is pulling.
  So the car's core is built here and nowhere else, and the other machines
  keep theirs.

  - **a**, an inline four, synthesized. A seamless loop of whole engine
    cycles is rendered once in plain JS (no OfflineAudioContext, so it costs
    one synchronous ~10 ms the first time a car starts, and is cached for the
    session): every firing a short positive pressure pulse with a negative
    lobe behind it and a breath of noise, the four cylinders at slightly
    different strengths and timings, per-firing jitter in level and timing,
    a per-cycle wander, all rung through a small bank of fixed resonances
    (the pipe and the box). It is rendered at three firing rates and the
    nearest two are crossfaded by rpm, each repitched by `playbackRate`
    across at most a factor of about 2.3, so the resonances slide a little
    and never chipmunk. Each rate exists twice, smooth and rough (wider
    jitter, more noise, a soft clip), and the rough pair takes over with
    effort.
  - **b**, a recording: qubodup's CC BY loop of an Opel Astra 1.6 16V, a real
    four at about 2600 rpm, one 4-second loop repitched by rpm
    (public/os/sfx/engine.mp3, credited in public/os/sfx/LICENSE.md, 55 kB).
    The file carries a quarter second of the loop's own tail before it and
    head after it, and the source loops over the middle four seconds: MP3
    decoders disagree by a thousand-odd samples about where the audio starts,
    and with that padding any offset smaller than it still lands the loop
    points on continuous audio. It is fetched when the fleet builds a car
    voice with set b chosen (never awaited), decoded off to the side, and
    set a plays in its place until it has; if it arrives mid-drive the voice
    crossfades over to it.
  - **c**, a cross-plane V8, synthesized like a: eight firings a cycle, heard
    from one bank's tailpipe, so the near bank's four pulses land 270, 180,
    90 and 180 degrees apart and the far bank's come through the crossover
    softer. That uneven spacing is the burble. Lower, fatter resonances.

  What makes it sound like it is working rather than revving: car.ts does
  not report the throttle (its `load` is the planar speed fraction), so
  effort is read off the note itself. A rising rpm is pulling, a falling one
  above a fast idle is the engine being driven by the wheels, and the upshift
  dip car.ts puts into the note is the sharpest fall of all. Effort opens the
  lowpass, raises the level and crossfades to the rough loops; the fall
  (overrun) closes it down and fires crackle, short band-limited pops from a
  pre-rendered set at a rate that grows with the overrun, which is also what
  gives a shift its little bark.

  Levels are peak-matched against the old voice at idle, cruise and full
  throttle through the same destination (`npm run engine -- table`), and
  none is louder than it was. The intake bed, road rush and tyre howl stay in
  sfx.ts, on top of whichever core plays.

  Headless-safe: nothing runs until sfx.ts hands a context in, the fetch and
  the storage read are guarded, and the loops are plain Float32Arrays until
  an AudioBuffer is asked for. Math.random() is deliberate, as everywhere in
  the audio: grain is cosmetic, not world state.
*/

export type EngineSet = 'a' | 'b' | 'c'
export const ENGINE_SETS: readonly EngineSet[] = ['a', 'b', 'c']
export const DEFAULT_ENGINE_SET: EngineSet = 'b'
const STORE = 'alejos-engine'

const stored = (): EngineSet => {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORE)
    return v === 'a' || v === 'b' || v === 'c' ? v : DEFAULT_ENGINE_SET
  } catch {
    return DEFAULT_ENGINE_SET
  }
}
let current: EngineSet = stored()

/** which engine plays */
export const engineSet = () => current
/** switch engines; `persist` keeps the choice across loads. A car already
    running crossfades to the new one on its next frame */
export const setEngineSet = (s: EngineSet, persist = true) => {
  current = s
  if (s === 'b') void preloadEngine()
  if (!persist) return
  try {
    if (typeof localStorage !== 'undefined') {
      if (s === DEFAULT_ENGINE_SET) localStorage.removeItem(STORE)
      else localStorage.setItem(STORE, s)
    }
  } catch {
    /* private mode: the switch still holds for the session */
  }
}

/* -------------------------------------------------------------- tuning -- */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const mix = (a: number, b: number, t: number) => a + (b - a) * t

/** rpm as car.ts reports it idles at 0.13 (revShown = 0.13 + 0.87 * rev) */
const IDLE_RPM = 0.13

interface Synth {
  /** per firing slot of one engine cycle: level, and timing offset as a
      fraction of the mean firing interval */
  amp: number[]
  lean: number[]
  /** firing rate at idle and at the redline, Hz */
  f0: number
  f1: number
  /** firing rates the loops are rendered at */
  points: number[]
  /** the pipe and the box: [Hz, Q, gain] */
  formants: Array<[number, number, number]>
  /** the raw pulse through a lowpass, the thump under the resonances */
  thump: [number, number]
}

const INLINE_FOUR: Synth = {
  amp: [1, 0.88, 0.95, 0.84],
  lean: [0, 0.025, -0.012, 0.018],
  // 850 to 6800 rpm, two firings a revolution
  f0: 850 / 30,
  f1: 6800 / 30,
  points: [28, 64, 146],
  formants: [
    [105, 1.6, 1],
    [310, 2.6, 0.55],
    [820, 3.2, 0.22],
    [2100, 1.1, 0.08],
  ],
  thump: [420, 0.9],
}

// firing order 1-8-4-3-6-5-7-2, odd cylinders on the near bank:
// L R R L R L L R, so the near pipe's pulses sit at 0, 270, 450 and 540
// degrees of a 720 degree cycle
const CROSS_PLANE_V8: Synth = {
  amp: [1, 0.42, 0.46, 0.94, 0.4, 1.02, 0.9, 0.44],
  lean: [0, 0.03, -0.02, 0.01, 0.02, -0.015, 0.02, -0.01],
  // 700 to 6000 rpm, four firings a revolution
  f0: 700 / 15,
  f1: 6000 / 15,
  points: [46, 108, 250],
  formants: [
    [72, 1.4, 1],
    [185, 2.2, 0.6],
    [520, 3, 0.2],
    [1500, 1, 0.06],
  ],
  thump: [300, 1.1],
}

interface Tone {
  /** core gain idling, cruising and flat out (drive 0.14, 0.54 and 0.81,
      see `update`), measured rather than designed: a pulse train's peaks
      are its thumps, so a slow idle is peakier than a fast note at the same
      loudness, and the rough loops are denser than the smooth ones, so
      holding the old voice's peak *and* its RMS at all three points is not
      any one curve */
  level: [number, number, number]
  /** lowpass cutoff closed and wide open, Hz */
  lp0: number
  lp1: number
  /** overrun crackle level, 0 for none */
  pop: number
}

/* the levels, set by `npm run engine -- table` against the old voice: its
   peaks were -30.1 dBFS idling, -19.9 cruising and -17.0 flat out, with the
   bed, the rush and the howl on top of the core in both */
const TONE: Record<EngineSet, Tone> = {
  a: { level: [0.0266, 0.095, 0.147], lp0: 380, lp1: 3200, pop: 0.05 },
  b: { level: [0.046, 0.121, 0.168], lp0: 900, lp1: 6000, pop: 0.035 },
  c: { level: [0.03, 0.09, 0.147], lp0: 320, lp1: 2600, pop: 0.05 },
}
/** where `level` is pinned, as drive. Below idle the level falls away (an
    engine being driven by the wheels is quieter than one idling), and past
    full throttle it holds: pulling hard brightens and roughens the note
    without making it louder than the old voice ever was */
const LEVEL_AT = [0.14, 0.54, 0.81]
const levelAt = (t: Tone, d: number) => {
  const [i0, i1, i2] = LEVEL_AT
  const [l0, l1, l2] = t.level
  if (d <= i0) return l0 * (0.6 + (0.4 * Math.max(0, d)) / i0)
  if (d <= i1) return mix(l0, l1, (d - i0) / (i1 - i0))
  if (d <= i2) return mix(l1, l2, (d - i1) / (i2 - i1))
  return l2
}

/** the recording's own firing note, and how far it is repitched */
const REC_F = 87
const REC_RATE0 = 0.55
const REC_RATE1 = 2.3
const REC_PAD = 0.25
const REC_LOOP = 4

/* ------------------------------------------------------------- render -- */

const SRR = 22050
const LOOP_S = 2

/** an RBJ biquad over a circular buffer, run twice so the tail of the loop
    rings into its head and the seam is steady state */
const ring = (src: Float32Array, out: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number, g: number) => {
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  const L = src.length
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < L; i++) {
      const x = src[i]
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      if (pass) out[i] += g * y
    }
  }
}

const bandpass = (src: Float32Array, out: Float32Array, f: number, q: number, g: number) => {
  const w = (2 * Math.PI * f) / SRR
  const al = Math.sin(w) / (2 * q)
  const a0 = 1 + al
  ring(src, out, al / a0, 0, -al / a0, (-2 * Math.cos(w)) / a0, (1 - al) / a0, g)
}

const lowpass = (src: Float32Array, out: Float32Array, f: number, q: number, g: number) => {
  const w = (2 * Math.PI * f) / SRR
  const al = Math.sin(w) / (2 * q)
  const c = Math.cos(w)
  const a0 = 1 + al
  ring(src, out, (1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0, g)
}

const rnd = () => Math.random() * 2 - 1

/** one seamless loop of whole engine cycles at firing rate `fire` */
const renderLoop = (s: Synth, fire: number, rough: boolean): Float32Array => {
  const P = s.amp.length
  const cycles = Math.max(4, Math.round((LOOP_S * fire) / P))
  const n = cycles * P
  const L = Math.round((n * SRR) / fire)
  const T = L / n
  const ex = new Float32Array(L)
  const jA = rough ? 0.14 : 0.05
  const jT = rough ? 0.03 : 0.012
  const nz = rough ? 0.55 : 0.18
  const tau = ((rough ? 4.5 : 2.2) * SRR) / 1000
  const w1 = Math.max(3, Math.round(0.0016 * SRR))
  const w2 = Math.round(0.0035 * SRR)
  const at = (i: number) => ((i % L) + L) % L
  let wander = 1
  for (let k = 0; k < n; k++) {
    const slot = k % P
    if (slot === 0) wander = 1 + rnd() * (rough ? 0.08 : 0.03)
    const i0 = Math.round((k + s.lean[slot] + rnd() * jT) * T)
    const amp = s.amp[slot] * wander * (1 + rnd() * jA)
    for (let j = 0; j < w1; j++) ex[at(i0 + j)] += amp * Math.sin((Math.PI * j) / w1)
    for (let j = 0; j < w2; j++) ex[at(i0 + w1 + j)] -= amp * 0.35 * Math.sin((Math.PI * j) / w2)
    for (let j = 0; j < tau * 5; j++) ex[at(i0 + j)] += amp * nz * rnd() * Math.exp(-j / tau)
  }
  const out = new Float32Array(L)
  lowpass(ex, out, s.thump[0], 0.8, s.thump[1])
  for (const [f, q, g] of s.formants) bandpass(ex, out, f, q, g * (rough ? 1.25 : 1))
  // no DC, and a soft clip on the rough loop: grit, not level. The clip is
  // taken against the loop's own peak, or a fast loop (more pulses, more
  // energy) would be driven far harder than a slow one and turn to buzz
  let mean = 0
  for (let i = 0; i < L; i++) mean += out[i]
  mean /= L
  let peak = 0
  for (let i = 0; i < L; i++) peak = Math.max(peak, Math.abs(out[i] - mean))
  const DRIVE = 1.6
  const sat = Math.tanh(DRIVE)
  let sum = 0
  for (let i = 0; i < L; i++) {
    let v = (out[i] - mean) / peak
    if (rough) v = Math.tanh(v * DRIVE) / sat
    out[i] = v
    sum += v * v
  }
  // equal RMS across the set, so the crossfades move colour, not level
  const k = 0.25 / Math.sqrt(sum / L)
  for (let i = 0; i < L; i++) out[i] *= k
  return out
}

/** crackle: a burst of noise rung through a low resonance, 40 ms */
const renderPop = (f: number): Float32Array => {
  const L = Math.round(0.04 * SRR)
  const ex = new Float32Array(L)
  const tau = 0.004 * SRR
  for (let j = 0; j < L; j++) ex[j] = rnd() * Math.exp(-j / tau)
  const out = new Float32Array(L)
  bandpass(ex, out, f, 1.4, 1)
  // the two-pass ring would wrap the tail into the head; a pop is not a
  // loop, so fade the head in over a millisecond instead
  let peak = 0
  for (let i = 0; i < L; i++) peak = Math.max(peak, Math.abs(out[i]))
  const fin = Math.round(0.001 * SRR)
  for (let i = 0; i < L; i++) out[i] = (out[i] / peak) * Math.min(1, i / fin) * (1 - i / L)
  return out
}

interface Rendered {
  smooth: Float32Array[]
  rough: Float32Array[]
}
const rendered = new Map<Synth, Rendered>()
let pops: Float32Array[] | null = null

const loopsFor = (s: Synth) => {
  let r = rendered.get(s)
  if (!r) {
    r = { smooth: s.points.map((f) => renderLoop(s, f, false)), rough: s.points.map((f) => renderLoop(s, f, true)) }
    rendered.set(s, r)
  }
  return r
}

const toBuffer = (a: BaseAudioContext, d: Float32Array) => {
  const b = a.createBuffer(1, d.length, SRR)
  b.getChannelData(0).set(d)
  return b
}

/* ----------------------------------------------------------- recorded -- */

let recorded: AudioBuffer | null = null
let loading: Promise<void> | null = null

/** fetch and decode set b's loop, once; settles either way, and a failure
    just leaves set a speaking for it. Decoded against a context of its own,
    since an AudioBuffer plays in any context and this can then start before
    the game's has been made */
export const preloadEngine = (): Promise<void> => {
  if (typeof window === 'undefined' || typeof fetch === 'undefined' || typeof OfflineAudioContext === 'undefined') {
    return Promise.resolve()
  }
  loading ??= fetch('/os/sfx/engine.mp3')
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((bytes) => (bytes ? new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes) : null))
    .then((buf) => {
      if (buf && buf.duration >= REC_PAD * 2 + REC_LOOP) recorded = buf
    })
    .catch(() => {})
  return loading
}

/** what set actually plays right now: b is a until its loop has decoded */
export const engineVoice = (): EngineSet => (current === 'b' && !recorded ? 'a' : current)

/* ------------------------------------------------------------- voice -- */

export interface EngineCore {
  /** the set this core was built as */
  readonly set: EngineSet
  /** connect this to the voice's master */
  readonly out: GainNode
  /** one frame: rpm 0..1 as car.ts reports it, load 0..1 */
  update: (rpm: number, load: number) => void
  /** fade this core out over `fade` seconds and stop its sources after */
  release: (fade: number) => void
  /** stop every source at `when` (context time) */
  stopAt: (when: number) => void
}


/**
 * Build one engine core into `a`, fading in over `fadeIn` seconds (0 when the
 * voice's own master is already fading in).
 */
export function buildEngine(a: BaseAudioContext, set: EngineSet, fadeIn: number): EngineCore {
  const tone = TONE[set]
  const synth = set === 'c' ? CROSS_PLANE_V8 : INLINE_FOUR
  const now = a.currentTime
  const out = a.createGain()
  if (fadeIn > 0) {
    out.gain.setValueAtTime(0.0001, now)
    out.gain.linearRampToValueAtTime(1, now + fadeIn)
  }
  const lp = a.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(tone.lp0, now)
  lp.Q.value = 0.7
  const core = a.createGain()
  core.gain.setValueAtTime(tone.level[0], now)
  lp.connect(core).connect(out)
  const popBus = a.createGain()
  popBus.gain.value = 1
  popBus.connect(out)

  /** every looping source, with its gain and the firing rate it was made at */
  const layers: Array<{ src: AudioBufferSourceNode; gain: GainNode; at: number; rough: boolean }> = []
  const add = (buf: AudioBuffer, at: number, rough: boolean, off: number, loop?: [number, number]) => {
    const src = a.createBufferSource()
    src.buffer = buf
    src.loop = true
    if (loop) {
      src.loopStart = loop[0]
      src.loopEnd = loop[1]
    }
    const gain = a.createGain()
    gain.gain.setValueAtTime(0, now)
    src.connect(gain).connect(lp)
    src.start(now, off)
    layers.push({ src, gain, at, rough })
  }
  const rec = set === 'b' ? recorded : null
  // start somewhere different each time so two starts are not one take
  if (rec) add(rec, REC_F, false, REC_PAD + Math.random() * REC_LOOP, [REC_PAD, REC_PAD + REC_LOOP])
  else {
    /*
      Every loop starts on the same whole engine cycle, and stays there. The
      loops are whole cycles long, pulse 0 of each sits at its head, and
      each plays at f / (its own rate), so their rates keep one ratio
      through every glide and all six fire together for as long as they
      run. Started at independent random points, the crossfades (smooth to
      rough, one rate to the next) were two pulse trains a random fraction
      of a firing apart: a flam, the four heard as eight, and a level that
      swung by several dB with the draw.
    */
    const loops = loopsFor(synth)
    const P = synth.amp.length
    const cycles = (d: Float32Array, f: number) => Math.round((d.length * f) / (SRR * P))
    const least = Math.min(...synth.points.map((f, i) => cycles(loops.smooth[i], f)))
    const c = Math.floor(Math.random() * least)
    synth.points.forEach((f, i) => {
      const cycleS = (k: Float32Array) => k.length / SRR / cycles(k, f)
      add(toBuffer(a, loops.smooth[i]), f, false, c * cycleS(loops.smooth[i]))
      add(toBuffer(a, loops.rough[i]), f, true, c * cycleS(loops.rough[i]))
    })
  }
  if (!pops) pops = [150, 210, 290, 400].map(renderPop)
  const popBufs = pops.map((d) => toBuffer(a, d))

  let first = true
  let lastT = now
  let lastR = IDLE_RPM
  let slope = 0
  let effort = 0.2
  let alive = true

  const to = (p: AudioParam, v: number, tau = 0.05) => p.setTargetAtTime(v, a.currentTime, tau)

  const pop = (at: number, r: number, coast: number) => {
    const src = a.createBufferSource()
    src.buffer = popBufs[(Math.random() * popBufs.length) | 0]
    src.playbackRate.value = 0.8 + 0.5 * Math.random()
    const g = a.createGain()
    g.gain.value = tone.pop * (0.45 + 0.55 * Math.random()) * (0.4 + 0.6 * r) * (0.5 + 0.5 * coast)
    src.connect(g).connect(popBus)
    src.start(at)
    src.stop(at + 0.08)
  }

  return {
    set,
    out,
    update: (rpm, load) => {
      if (!alive) return
      const t = a.currentTime
      const r = clamp01(rpm)
      const l = clamp01(load)
      if (first) {
        first = false
        lastR = r
        lastT = t
      }
      const dt = Math.min(0.1, Math.max(1 / 480, t - lastT))
      const rate = (r - lastR) / dt
      lastT = t
      lastR = r
      slope += (rate - slope) * (1 - Math.exp(-dt / 0.09))
      // pulling: the note climbing. Overrun: the note falling off a fast
      // idle, the wheels driving the engine
      const push = clamp01(slope / 0.3)
      const coast = r > 0.28 ? clamp01(-slope / 0.12) : 0
      const want = clamp01(0.2 + 0.55 * l + 0.8 * push) * (1 - 0.85 * coast)
      effort += (want - effort) * (1 - Math.exp(-dt / 0.12))

      const rn = clamp01((r - IDLE_RPM) / (1 - IDLE_RPM))
      const drive = 0.3 * rn + 0.7 * effort
      to(core.gain, levelAt(tone, drive))
      to(lp.frequency, tone.lp0 * Math.pow(tone.lp1 / tone.lp0, drive))

      if (rec) {
        const L = layers[0]
        to(L.src.playbackRate, mix(REC_RATE0, REC_RATE1, rn), 0.03)
        to(L.gain.gain, 1, 0.03)
      } else {
        // the firing rate, then the two rendered rates either side of it,
        // crossfaded on a log scale with equal power
        const f = mix(synth.f0, synth.f1, rn)
        const P = synth.points
        let i = 0
        while (i < P.length - 2 && f > P[i + 1]) i++
        const u = clamp01(Math.log(f / P[i]) / Math.log(P[i + 1] / P[i]))
        const rough = clamp01((effort - 0.3) / 0.55)
        const rs = Math.sin((rough * Math.PI) / 2)
        const rc = Math.cos((rough * Math.PI) / 2)
        for (const L of layers) {
          const k = P.indexOf(L.at)
          const w = k === i ? Math.cos((u * Math.PI) / 2) : k === i + 1 ? Math.sin((u * Math.PI) / 2) : 0
          to(L.gain.gain, w * (L.rough ? rs : rc), 0.03)
          to(L.src.playbackRate, Math.min(4, Math.max(0.25, f / L.at)), 0.03)
        }
      }

      // crackle on the overrun, a few pops a second at most
      if (tone.pop > 0 && coast > 0.3 && Math.random() < 9 * coast * dt) pop(t + Math.random() * dt, r, coast)
    },
    release: (fade) => {
      if (!alive) return
      alive = false
      const t = a.currentTime
      out.gain.cancelScheduledValues(t)
      out.gain.setValueAtTime(out.gain.value, t)
      out.gain.linearRampToValueAtTime(0.0001, t + fade)
      for (const L of layers) {
        try {
          L.src.stop(t + fade + 0.05)
        } catch {
          /* already stopped */
        }
      }
      setTimeout(() => out.disconnect(), (fade + 0.2) * 1000)
    },
    stopAt: (when) => {
      alive = false
      for (const L of layers) {
        try {
          L.src.stop(Math.max(when, a.currentTime))
        } catch {
          /* already stopped */
        }
      }
    },
  }
}
