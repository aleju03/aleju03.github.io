/*
  The car's engine, rendered offline: scripts/engine.mjs drives this page.

  Same trick as steps.ts: one render per page load, `window.AudioContext`
  swapped for a single OfflineAudioContext so core/sfx.ts's shared context is
  the offline one, and every frame of a plan fired from a suspend at its own
  time (the offline clock only moves while it renders, so a `set()` issued
  there lands exactly where the game's frame loop would have put it). The
  voice is the one the fleet builds, `createVehicleVoice('car')`, straight
  into the destination with nothing in between, which is how the game mixes
  it, so a peak read here is a peak in the game.
*/
import * as sfx from '../../src/game/core/sfx'
import * as V from '../../src/game/vehicles/sfx'
import * as E from '../../src/game/vehicles/engine'

const SR = 44100
const Q = 128 / SR

/** one frame of the plan: seconds, then rpm, load, speed and slip as `set()` takes them */
export type Frame = [number, number, number, number, number]

/** render `frames` through the engine set `set`; base64 float32, stereo interleaved */
export const render = async (set: string, seconds: number, frames: Frame[]) => {
  const off = new OfflineAudioContext(2, Math.round(SR * seconds), SR)
  const resume = off.resume.bind(off)
  ;(off as unknown as { resume: () => Promise<void> }).resume = () => Promise.resolve()
  const W = window as unknown as { AudioContext: unknown }
  W.AudioContext = function () {
    return off
  } as unknown
  sfx.sharedAudio()
  // a word that is not a set leaves the stored one alone; b's recording is
  // decoded before the clock starts, so a take never hears set a standing
  // in for it
  if ((E.ENGINE_SETS as readonly string[]).includes(set)) E.setEngineSet(set as E.EngineSet, false)
  await E.preloadEngine()
  const v = V.createVehicleVoice('car')
  const byT = new Map<number, Frame>()
  for (const f of frames) byT.set(Math.round(f[0] / Q) * Q, f)
  const last = Math.max(...byT.keys())
  for (const [t, f] of byT) {
    void off.suspend(t).then(() => {
      try {
        if (t === 0) v.start()
        v.set(f[1], f[2], f[3], f[4])
        if (t === last) v.stop()
      } catch (err) {
        console.error(`frame ${t}: ${String(err)}`)
      }
      void resume()
    })
  }
  const buf = await off.startRendering()
  const L = buf.getChannelData(0)
  const R = buf.getChannelData(1)
  const out = new Float32Array(L.length * 2)
  for (let i = 0; i < L.length; i++) {
    out[2 * i] = L[i]
    out[2 * i + 1] = R[i]
  }
  const bytes = new Uint8Array(out.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
