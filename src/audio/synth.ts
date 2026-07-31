/*
  Every sound on this site is generated here, at runtime, and handed to Howler
  as a blob. Nothing audio is shipped.

  That is not a purity exercise: it is the same rule the rest of the repo runs
  on (textures are drawn onto canvases, the OS's sound effects are oscillators,
  see os/sounds.ts) and it means the site carries no licence obligations and no
  audio payload. Howler still does the job it is good at: the pool, sprites,
  fades, mute state, and the mobile unlock dance. It just gets object URLs from
  an OfflineAudioContext instead of files from a CDN.

  The voice is deliberately the same one AlejOS speaks in: soft sines and
  triangles, short, quiet, tuned around E. The page and the machine inside it
  should sound like one instrument, because narratively they are.

  Levels matter here. CLAUDE.md's note that normalized clips run ~4x hotter
  than this mix applies to synthesis too: every cue below is written to peak
  well under 1.0 and is checked against the others, because a single cue
  mastered louder than the rest is the thing that makes a site feel cheap.
*/

const SAMPLE_RATE = 44100

interface ToneSpec {
  freq: number
  /** seconds from the start of the cue */
  at?: number
  dur?: number
  type?: OscillatorType
  gain?: number
  /** glide to this frequency across the note */
  to?: number
  /** cents of detune, for the thickened pad voices */
  detune?: number
  pan?: number
}

interface NoiseSpec {
  at?: number
  dur?: number
  gain?: number
  /** band-pass centre; the sweep target if `to` is given */
  freq?: number
  to?: number
  q?: number
}

/** a destination that can also be panned, so cues can sit off-centre */
function sink(ctx: OfflineAudioContext, pan?: number): AudioNode {
  if (pan === undefined) return ctx.destination
  const panner = ctx.createStereoPanner()
  panner.pan.value = pan
  panner.connect(ctx.destination)
  return panner
}

export function tone(ctx: OfflineAudioContext, spec: ToneSpec) {
  const at = spec.at ?? 0
  const dur = spec.dur ?? 0.18
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = spec.type ?? 'sine'
  osc.frequency.setValueAtTime(spec.freq, at)
  if (spec.to) osc.frequency.exponentialRampToValueAtTime(spec.to, at + dur)
  if (spec.detune) osc.detune.value = spec.detune
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(spec.gain ?? 0.06, at + Math.min(0.02, dur * 0.25))
  gain.gain.exponentialRampToValueAtTime(0.0008, at + dur)
  osc.connect(gain).connect(sink(ctx, spec.pan))
  osc.start(at)
  osc.stop(at + dur + 0.02)
}

/** band-passed white noise: the texture behind whooshes, rips and tube hum */
export function noise(ctx: OfflineAudioContext, spec: NoiseSpec) {
  const at = spec.at ?? 0
  const dur = spec.dur ?? 0.2
  const frames = Math.max(1, Math.ceil(dur * SAMPLE_RATE))
  const buffer = ctx.createBuffer(1, frames, SAMPLE_RATE)
  const data = buffer.getChannelData(0)
  // a fixed LCG rather than Math.random: the same cue should render to the
  // same bytes on every load, so nothing about the mix drifts between visits
  let seed = 0x2f6e2b1
  for (let i = 0; i < frames; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    data[i] = (seed / 0xffffffff) * 2 - 1
  }
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.setValueAtTime(spec.freq ?? 1200, at)
  if (spec.to) band.frequency.exponentialRampToValueAtTime(spec.to, at + dur)
  band.Q.value = spec.q ?? 1.2
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(spec.gain ?? 0.05, at + Math.min(0.012, dur * 0.2))
  gain.gain.exponentialRampToValueAtTime(0.0008, at + dur)
  src.connect(band).connect(gain).connect(ctx.destination)
  src.start(at)
  src.stop(at + dur)
}

/**
 * Partial tables for `bar`: [frequency multiple, relative gain, decay multiple].
 *
 * The ratios are the whole trick. A real marimba bar is undercut on its
 * underside until its first overtone sits near FOUR times the fundamental
 * instead of two, and that single fact is most of why a marimba reads as a
 * struck wooden object while a 2:1 stack reads as a flute or an organ. Higher
 * partials also die faster than the fundamental, which is what the third
 * number is for: it is the decay of a thin bright mode against the body of the
 * note, and holding them all for the same time is what makes synthesized
 * percussion sound like a synthesizer.
 */
export const MARIMBA = [
  [1, 1, 1],
  [3.94, 0.3, 0.45],
  [9.2, 0.1, 0.22],
] as const
/** closer to harmonic and gentler on top: a muted piano rather than a bar */
export const FELT = [
  [1, 1, 1],
  [2.01, 0.34, 0.6],
  [3, 0.12, 0.35],
] as const

interface BarSpec {
  freq: number
  at?: number
  /** seconds for the fundamental to fall away; partials scale off this */
  decay?: number
  gain?: number
  partials?: readonly (readonly [number, number, number])[]
  /** the mallet's contact transient, as a fraction of `gain`; 0 for none */
  mallet?: number
  /** where the mallet's noise sits: lower is a softer, felt-wrapped head */
  malletHz?: number
}

/**
 * One struck bar: the site's voice for anything the visitor did.
 *
 * This exists because the bank's cues used to be bare sines and triangles
 * between 440Hz and 1400Hz, and a clean sine in the octave the ear is most
 * sensitive in is the timbre of a smoke alarm, not of an interface. The fix is
 * not "avoid pitch", though: a pitched sound with a CONSTANT pitch and a
 * couple of inharmonic partials is a wooden object being tapped, which is
 * exactly the register this page wants. What it must never do is glide. A hit
 * whose pitch sweeps as it decays is a water droplet, and once you have heard
 * one cue that way every cue in the bank sounds like a bubble.
 */
export function bar(ctx: OfflineAudioContext, spec: BarSpec) {
  const at = spec.at ?? 0
  const decay = spec.decay ?? 0.25
  const level = spec.gain ?? 0.09
  const partials = spec.partials ?? MARIMBA

  for (const [ratio, amp, dscale] of partials) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    // set, never ramped: see the note above about gliding
    osc.frequency.value = spec.freq * ratio
    const dur = decay * dscale
    gain.gain.setValueAtTime(0, at)
    // a strike, so the attack is a millisecond and a half rather than the 20ms
    // `tone` uses; any slower and the mallet reads as a swell
    gain.gain.linearRampToValueAtTime(level * amp, at + 0.0015)
    gain.gain.exponentialRampToValueAtTime(0.0008, at + dur)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + dur + 0.02)
  }

  const mallet = spec.mallet ?? 0.35
  if (mallet > 0) {
    // the contact itself: 20ms of noise, which is the difference between a bar
    // that was hit and a bar that faded up out of nothing
    noise(ctx, {
      at,
      dur: 0.02,
      freq: spec.malletHz ?? 1400,
      q: 0.7,
      gain: level * mallet,
    })
  }
}

/** 16-bit PCM WAV: the one container every browser decodes without a codec */
export function encodeWav(buffer: AudioBuffer, scale = 1): Blob {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const bytes = 44 + frames * channels * 2
  const out = new ArrayBuffer(bytes)
  const view = new DataView(out)

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, bytes - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header length
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true) // byte rate
  view.setUint16(32, channels * 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, frames * channels * 2, true)

  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, data[c][i] * scale))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([out], { type: 'audio/wav' })
}

/**
 * Renders one cue offline and returns an object URL Howler can load. The
 * rendering happens off the main thread, which is why cues are built lazily on
 * the visitor's first gesture rather than at import time.
 *
 * `peak` is the one number that decides whether a cue is heard at all, so it is
 * measured rather than hoped for: the cue is rendered, its true peak is read
 * back with peakOf, and the whole thing is scaled to land exactly on the
 * requested level. That separates the two jobs cleanly. A cue's `build` owns
 * the BALANCE between its own voices, in whatever gains read nicely; the peak
 * owns how loud the finished cue is against every other cue. Before this
 * existed the two were the same set of numbers, every cue was hand-gained to
 * "quiet", and the bank measured -22 to -31 dBFS at the master bus, which on
 * laptop speakers under a room is not quiet, it is off.
 */
export async function renderCue(
  seconds: number,
  build: (ctx: OfflineAudioContext) => void,
  opts: { channels?: number; peak?: number } = {},
): Promise<string> {
  const channels = opts.channels ?? 1
  const ctx = new OfflineAudioContext(channels, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE)
  build(ctx)
  const buffer = await ctx.startRendering()
  const measured = peakOf(buffer)
  const scale = opts.peak && measured > 1e-6 ? opts.peak / measured : 1
  return URL.createObjectURL(encodeWav(buffer, scale))
}

/**
 * Loads a shipped audio file and returns an object URL for it, normalised to
 * the same `peak` ladder every synthesized cue is measured against.
 *
 * This is the whole point of the function. A cue rendered here and a cue
 * downloaded from a library are not comparable objects: library files arrive
 * mastered near 0 dBFS, roughly four times hotter than this mix, so dropping
 * one in next to the synth bank does not add a sound, it adds a sound that
 * shouts over everything else. Decoding it, reading its true peak and
 * re-encoding it at the declared level means the mix table in bank.ts stays
 * the single place loudness is decided, no matter where the audio came from.
 *
 * Resolves null on any failure (missing file, format the browser will not
 * decode) so the caller can fall back to the synthesized voice: a cue with no
 * sample yet dropped in should sound like the old site, not like silence.
 */
export async function loadSample(url: string, peak?: number): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const bytes = await response.arrayBuffer()
    // OfflineAudioContext decodes without needing a user gesture, and its own
    // rate is irrelevant here: decodeAudioData resamples to it, which is fine
    // because everything else in this file already runs at SAMPLE_RATE
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
    const buffer = await ctx.decodeAudioData(bytes)
    const measured = peakOf(buffer)
    const scale = peak && measured > 1e-6 ? peak / measured : 1
    return URL.createObjectURL(encodeWav(buffer, scale))
  } catch {
    return null
  }
}

/** peak sample across every channel, used by the level check in the tests */
export function peakOf(buffer: AudioBuffer): number {
  let peak = 0
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i])
      if (v > peak) peak = v
    }
  }
  return peak
}
