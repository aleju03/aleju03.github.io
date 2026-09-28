import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

/*
  Noise suppression that is a neural network rather than a filter: RNNoise
  (xiph/rnnoise, BSD-3-Clause), compiled to WebAssembly and run in an
  AudioWorklet by @sapphi-red/web-noise-suppressor (MIT © 2022 sapphi-red).
  It is the open cousin of what Discord does with Krisp: it learns what a
  voice is and takes out fans, keyboards and room hiss between and under the
  words, where the browser's own `noiseSuppression` constraint is WebRTC's
  older spectral one and mostly just ducks steady hum.

  This module is imported dynamically by `proximityVoice` the first time a
  microphone is turned on, so nobody who never talks downloads it: about
  155 kB of wasm (the SIMD build where the browser has SIMD) plus the
  worklet script, fetched once and kept for the session. RNNoise works on
  48 kHz frames and nothing else, so `createDenoiser` answers null on a
  context at any other rate and the caller keeps the browser's suppression.
*/

let binary: Promise<ArrayBuffer> | null = null
const registered = new WeakSet<BaseAudioContext>()

/** a denoiser node on `ctx`, mono in and out, or null where it cannot run */
export async function createDenoiser(ctx: AudioContext): Promise<RnnoiseWorkletNode | null> {
  if (ctx.sampleRate !== 48000 || !ctx.audioWorklet) return null
  try {
    binary ??= loadRnnoise({ url: wasmUrl, simdUrl })
    const wasm = await binary
    if (!registered.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl)
      registered.add(ctx)
    }
    return new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasm })
  } catch {
    // a failed fetch is not remembered, so the next mic-on tries again
    binary = null
    return null
  }
}
