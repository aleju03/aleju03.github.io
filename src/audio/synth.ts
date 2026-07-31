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
