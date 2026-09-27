/*
  Voice filters: what your microphone sounds like to everybody else.

  The filter runs on the *sender's* side, in WebAudio, between the voice gate
  and the MediaStreamDestination whose track every peer connection carries.
  So a listener needs nothing to hear it: no protocol field, no second
  decoder, no agreement about what "robot" means. They receive an ordinary
  audio track that happens to be a robot.

  The shape is a fixed pair of nodes, `input` and `output`, with the chosen
  filter wired *between* them. Neither end ever changes, which is the whole
  trick: `proximityVoice` connects its gate to `input` and `output` to its
  limiter once, and switching filter mid-call is a crossfade and a rewire
  behind those two nodes, never a track swap or an SDP renegotiation. Chains
  are built the first time they are picked and kept, so flicking back and
  forth on the pause sheet builds nothing twice.

  The five, and what each is made of (zero downloaded assets, as usual):

  - **helium** and **giant**: a delay-line pitch shifter in an AudioWorklet
    (two read heads sliding through a 50 ms window at the pitch ratio,
    crossfaded on sin^2 windows that sum to one, so the seam where a head wraps
    is always silent). +7 and -6 semitones. The formants move with the pitch,
    which is exactly the cartoon we want.
  - **robot**: a short metallic comb, a 50 Hz ring modulator (a gain whose gain
    *is* an oscillator), then a light bitcrush in the same worklet module.
  - **radio**: a walkie-talkie. Band-limited to roughly 300-3000 Hz with two
    poles each side, driven into a tanh soft clip, and when the gate shuts a
    short burst of squelch noise is played through the same band, keyed off
    the gate `proximityVoice` already runs (`squelch()`).
  - **cave**: a convolution reverb on an impulse response generated here:
    decaying noise that darkens as it decays, over a few early reflections.

  **Loudness is measured, not hoped for.** Every filter changes level by a
  different amount (a ring modulator halves the RMS, a clipper raises it, a
  reverb adds a tail), so each carries a `MAKEUP` gain that brings its RMS
  back to what "none" measures for the same voice. Those numbers were read off
  an OfflineAudioContext render of a synthetic voice (a 150 Hz sawtooth
  through vowel formants with a syllable envelope), not picked by ear; if a
  chain changes, re-measure rather than nudge. The sender's limiter still sits
  after `output`, so a filter can never clip on the wire.
*/

export const VOICE_FILTERS = ['none', 'helium', 'giant', 'robot', 'radio', 'cave'] as const
export type VoiceFilter = (typeof VOICE_FILTERS)[number]

/** semitones for the two pitch filters */
const HELIUM_ST = 7
const GIANT_ST = -6

/** the per-filter gain that puts each chain's RMS back on "none"'s, measured
    offline (see the header). Re-measure if a chain changes */
const MAKEUP: Record<VoiceFilter, number> = {
  none: 1,
  helium: 1.106,
  giant: 1.105,
  robot: 1.508,
  radio: 0.394,
  cave: 1.114,
}

/** the crossfade when the filter changes under a live voice */
const SWAP_TC = 0.015

const WORKLET_SRC = `
class PitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }]
  }
  constructor() {
    super()
    this.size = 16384
    this.buf = new Float32Array(this.size)
    this.w = 0
    this.win = Math.round(sampleRate * 0.05)
    this.phase = 0
  }
  tap(p) {
    const d = p * this.win + 2
    let r = this.w - d
    while (r < 0) r += this.size
    const i = Math.floor(r)
    const f = r - i
    const a = this.buf[i]
    const b = this.buf[(i + 1) % this.size]
    const s = Math.sin(Math.PI * p)
    return (a + (b - a) * f) * s * s
  }
  process(inputs, outputs, params) {
    const out = outputs[0][0]
    if (!out) return true
    const inp = inputs[0] && inputs[0][0]
    const step = (1 - params.ratio[0]) / this.win
    for (let n = 0; n < out.length; n++) {
      this.buf[this.w] = inp ? inp[n] : 0
      let p = this.phase + step
      p -= Math.floor(p)
      this.phase = p
      const q = p + 0.5 >= 1 ? p - 0.5 : p + 0.5
      out[n] = this.tap(p) + this.tap(q)
      this.w = (this.w + 1) % this.size
    }
    return true
  }
}
class Crush extends AudioWorkletProcessor {
  constructor(o) {
    super()
    const po = (o && o.processorOptions) || {}
    this.step = 2 / Math.pow(2, po.bits || 6)
    this.hold = po.hold || 3
    this.n = 0
    this.v = 0
  }
  process(inputs, outputs) {
    const out = outputs[0][0]
    if (!out) return true
    const inp = inputs[0] && inputs[0][0]
    for (let i = 0; i < out.length; i++) {
      if (this.n++ % this.hold === 0) {
        const x = inp ? inp[i] : 0
        this.v = Math.round(x / this.step) * this.step
      }
      out[i] = this.v
    }
    return true
  }
}
registerProcessor('voice-pitch', PitchShift)
registerProcessor('voice-crush', Crush)
`

/** the worklet module, once per context: addModule on a context that already
    has it registered would throw on the second registerProcessor */
const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>()
const loadWorklet = (ctx: BaseAudioContext): Promise<boolean> => {
  let p = loaded.get(ctx)
  if (!p) {
    p = (async () => {
      if (!ctx.audioWorklet) return false
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
        return true
      } catch {
        return false
      } finally {
        URL.revokeObjectURL(url)
      }
    })()
    loaded.set(ctx, p)
  }
  return p
}

const needsWorklet = (f: VoiceFilter) => f === 'helium' || f === 'giant' || f === 'robot'

interface Chain {
  in: AudioNode
  /** the chain's own fader, which the swap crossfades */
  level: GainNode
}

const mono = { channelCount: 1, channelCountMode: 'explicit' as const }

const pitchChain = (ctx: BaseAudioContext, st: number): Chain => {
  const node = new AudioWorkletNode(ctx, 'voice-pitch', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    ...mono,
  })
  node.parameters.get('ratio')!.value = Math.pow(2, st / 12)
  const level = ctx.createGain()
  node.connect(level)
  return { in: node, level }
}

const robotChain = (ctx: BaseAudioContext): Chain => {
  const input = ctx.createGain()
  // a short comb for the tin can the voice is coming out of
  const comb = ctx.createDelay(0.05)
  comb.delayTime.value = 0.006
  const fb = ctx.createGain()
  fb.gain.value = 0.45
  const sum = ctx.createGain()
  input.connect(sum)
  sum.connect(comb)
  comb.connect(fb)
  fb.connect(sum)
  // the ring modulator: a gain whose gain is a 50 Hz sine, so out = in * sin
  const ring = ctx.createGain()
  ring.gain.value = 0
  const carrier = ctx.createOscillator()
  carrier.frequency.value = 50
  carrier.connect(ring.gain)
  carrier.start()
  sum.connect(ring)
  const crush = new AudioWorkletNode(ctx, 'voice-crush', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { bits: 6, hold: 3 },
    ...mono,
  })
  ring.connect(crush)
  const level = ctx.createGain()
  crush.connect(level)
  return { in: input, level }
}

const tanhCurve = (drive: number) => {
  const c = new Float32Array(new ArrayBuffer(1024 * 4))
  const k = Math.tanh(drive)
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1
    c[i] = Math.tanh(x * drive) / k
  }
  return c
}

interface RadioChain extends Chain {
  squelch: () => void
}

const radioChain = (ctx: BaseAudioContext): RadioChain => {
  const input = ctx.createGain()
  const band = (type: BiquadFilterType, f: number) => {
    const b = ctx.createBiquadFilter()
    b.type = type
    b.frequency.value = f
    b.Q.value = 0.7
    return b
  }
  const hp1 = band('highpass', 300)
  const hp2 = band('highpass', 300)
  const lp1 = band('lowpass', 3000)
  const lp2 = band('lowpass', 3000)
  const drive = ctx.createGain()
  drive.gain.value = 5
  const clip = ctx.createWaveShaper()
  clip.curve = tanhCurve(2)
  clip.oversample = '2x'
  const post = ctx.createGain()
  post.gain.value = 0.35
  input.connect(hp1).connect(hp2).connect(lp1).connect(lp2).connect(drive).connect(clip).connect(post)
  const level = ctx.createGain()
  post.connect(level)

  // the squelch tail: 180 ms of noise with a hard front and a quick fade,
  // generated once and replayed through the radio's own band, into the level
  const sr = ctx.sampleRate
  const len = Math.round(sr * 0.18)
  const noise = ctx.createBuffer(1, len, sr)
  const d = noise.getChannelData(0)
  let seed = 0x2f6e2b1
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const t = i / len
    d[i] = ((seed / 0xffffffff) * 2 - 1) * (t < 0.04 ? t / 0.04 : Math.pow(1 - t, 1.6)) * 0.9
  }
  const sqBand = band('bandpass', 1800)
  sqBand.Q.value = 0.9
  sqBand.connect(level)
  const squelch = () => {
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.connect(sqBand)
    src.start()
  }
  return { in: input, level, squelch }
}

/** a cave's impulse response: a few early reflections off near walls, then a
    noise tail that decays over ~2.5 s and darkens as it goes (a one-pole
    lowpass whose cutoff falls with time) */
const caveIR = (ctx: BaseAudioContext) => {
  const sr = ctx.sampleRate
  const len = Math.round(sr * 2.6)
  const ir = ctx.createBuffer(2, len, sr)
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch)
    let seed = 0x9e3779b1 ^ (ch * 0x51ed27)
    let lp = 0
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const t = i / sr
      const white = (seed / 0xffffffff) * 2 - 1
      const k = 0.5 * Math.exp(-t * 1.4) + 0.04
      lp += (white - lp) * k
      d[i] = lp * Math.exp(-t / 0.42) * (t < 0.02 ? t / 0.02 : 1)
    }
    for (const [ms, g] of [[11, 0.7], [23, -0.5], [37, 0.45], [53, -0.35], [71, 0.3]]) {
      const i = Math.round(((ms + ch * 3) / 1000) * sr)
      if (i < len) d[i] += g
    }
  }
  return ir
}

const caveChain = (ctx: BaseAudioContext): Chain => {
  const input = ctx.createGain()
  const level = ctx.createGain()
  const dry = ctx.createGain()
  dry.gain.value = 0.5
  input.connect(dry).connect(level)
  const conv = ctx.createConvolver()
  conv.buffer = caveIR(ctx)
  const wet = ctx.createGain()
  wet.gain.value = 1
  input.connect(conv).connect(wet).connect(level)
  return { in: input, level }
}

export interface VoiceFx {
  /** the gate lands here, for the life of the session */
  readonly input: GainNode
  /** and the send limiter (and the preview monitor) hang off here */
  readonly output: GainNode
  readonly filter: VoiceFilter
  /** switch, live: a crossfade behind fixed ends. A filter that needs the
      worklet module waits for it and then swaps; until then the previous
      chain keeps playing */
  set: (f: VoiceFilter) => void
  /** the gate just shut: the radio answers with its squelch, the rest ignore it */
  gateClosed: () => void
  /** resolves once the worklet module is loaded (or failed to) */
  readonly ready: Promise<boolean>
  dispose: () => void
}

export function createVoiceFx(ctx: BaseAudioContext, initial: VoiceFilter = 'none'): VoiceFx {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const chains = new Map<VoiceFilter, Chain | RadioChain>()
  const ready = loadWorklet(ctx)
  let workletOk = false
  let current: VoiceFilter | null = null
  let wanted: VoiceFilter = initial
  let disposed = false

  const build = (f: VoiceFilter): Chain => {
    let c = chains.get(f)
    if (c) return c
    if (f === 'helium') c = pitchChain(ctx, HELIUM_ST)
    else if (f === 'giant') c = pitchChain(ctx, GIANT_ST)
    else if (f === 'robot') c = robotChain(ctx)
    else if (f === 'radio') c = radioChain(ctx)
    else if (f === 'cave') c = caveChain(ctx)
    else {
      const g = ctx.createGain()
      c = { in: g, level: g }
    }
    c.level.gain.value = 0
    c.level.connect(output)
    chains.set(f, c)
    return c
  }

  const apply = () => {
    if (disposed) return
    let f = wanted
    if (needsWorklet(f) && !workletOk) f = 'none'
    if (f === current) return
    const t = ctx.currentTime
    const old = current !== null ? chains.get(current) : undefined
    const next = build(f)
    input.connect(next.in)
    next.level.gain.cancelScheduledValues(t)
    next.level.gain.setTargetAtTime(MAKEUP[f], t, SWAP_TC)
    const was = current
    current = f
    if (old) {
      old.level.gain.cancelScheduledValues(t)
      old.level.gain.setTargetAtTime(0, t, SWAP_TC)
      // unhook the old chain once it has faded, unless it came back meanwhile
      setTimeout(() => {
        if (current === was || disposed) return
        try {
          input.disconnect(old.in)
        } catch {
          /* already unhooked */
        }
      }, 150)
    }
  }

  void ready.then((ok) => {
    workletOk = ok
    apply()
  })
  apply()

  return {
    input,
    output,
    get filter() {
      return wanted
    },
    ready,
    set(f) {
      if (f === wanted) return
      wanted = f
      apply()
    },
    gateClosed() {
      if (current !== 'radio') return
      const c = chains.get('radio') as RadioChain | undefined
      c?.squelch()
    },
    dispose() {
      disposed = true
      input.disconnect()
      output.disconnect()
      for (const c of chains.values()) c.level.disconnect()
    },
  }
}
