import { sharedAudio } from '../../core/sfx'

/*
  The physgun's voice, synthesized like everything else in the runtime's
  sound (core/sfx.ts): nothing shipped, nothing decoded, headless-safe
  because the shared AudioContext is null in Node and every call below
  returns before touching it.

  Two kinds of sound. **The hum** is continuous while the beam holds
  something: a sawtooth fundamental through a low-pass, a detuned square an
  octave up and a vibrato'd sine above both, which together read as an
  electrical load rather than a musical note, with a thin band of noise on
  top for the crackle of the beam itself. Strain (0..1, how far the held
  thing is from where the beam wants it) pushes all three up by up to a
  fifth and opens the filter, so swinging something heavy *sounds* heavy.
  The voice is built on the first hold and then left running at zero gain
  (an oscillator cannot be restarted, and a silent one costs nothing).

  **The one-shots** are layered bursts: a grab is a crackle of noise pops
  over a zap swept downward, a release the same shorter, a freeze a low
  thump under a bright, icy ping (the "pop" of GMod's freeze), a thaw the
  ping swept the other way, and firing at nothing a thin fizz.

  Levels are matched against the footsteps and door sounds in core/sfx.ts
  (peaks of a few hundredths into the destination), not against a
  normalized file: the hum sits under a footstep, a grab lands about as hard
  as a landing thump.
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

export const env = (g: GainNode, at: number, peak: number, attack: number, dur: number) => {
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
}

export const pop = (a: AudioContext, at: number, type: BiquadFilterType, f: number, q: number, peak: number, dur: number) => {
  const s = a.createBufferSource()
  s.buffer = noise(a)
  s.loop = true
  const flt = a.createBiquadFilter()
  flt.type = type
  flt.frequency.value = f
  flt.Q.value = q
  const g = a.createGain()
  env(g, at, peak, 0.002, dur)
  s.connect(flt).connect(g).connect(a.destination)
  s.start(at, Math.random() * 0.8)
  s.stop(at + dur + 0.02)
}

export const sweep = (a: AudioContext, at: number, type: OscillatorType, f0: number, f1: number, peak: number, dur: number) => {
  const o = a.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, at)
  o.frequency.exponentialRampToValueAtTime(f1, at + dur)
  const g = a.createGain()
  env(g, at, peak, 0.004, dur)
  o.connect(g).connect(a.destination)
  o.start(at)
  o.stop(at + dur + 0.02)
}

/** a spray of small noise pops: the crackle of the beam catching */
export const crackle = (a: AudioContext, at: number, n: number, span: number, peak: number) => {
  for (let i = 0; i < n; i++) {
    const t = at + Math.random() * span
    pop(a, t, 'highpass', 2200 + Math.random() * 3000, 0.8, peak * (0.4 + Math.random() * 0.6), 0.012 + Math.random() * 0.02)
  }
}

export interface PhysgunSfx {
  /** the hum: on while holding, pitched by strain; call every frame */
  hum: (on: boolean, strain: number) => void
  grab: () => void
  release: (speed: number) => void
  freeze: () => void
  unfreeze: () => void
  miss: () => void
  /** refused: somebody else's prop. A short flat double buzz, a little lower and
      drier than the miss so the two never read as the same thing */
  deny: () => void
  dispose: () => void
}

export function createPhysgunSfx(): PhysgunSfx {
  let voice: {
    out: GainNode
    lp: BiquadFilterNode
    saw: OscillatorNode
    sq: OscillatorNode
    sine: OscillatorNode
    fizz: GainNode
  } | null = null
  let level = 0
  let lastStrain = 0

  const build = (a: AudioContext) => {
    const out = a.createGain()
    out.gain.value = 0
    out.connect(a.destination)
    const lp = a.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 520
    lp.Q.value = 3
    lp.connect(out)
    const saw = a.createOscillator()
    saw.type = 'sawtooth'
    saw.frequency.value = 58
    const sawG = a.createGain()
    sawG.gain.value = 0.5
    saw.connect(sawG).connect(lp)
    const sq = a.createOscillator()
    sq.type = 'square'
    sq.frequency.value = 117.4
    const sqG = a.createGain()
    sqG.gain.value = 0.18
    sq.connect(sqG).connect(lp)
    const sine = a.createOscillator()
    sine.type = 'sine'
    sine.frequency.value = 348
    const vib = a.createOscillator()
    vib.frequency.value = 6.2
    const vibG = a.createGain()
    vibG.gain.value = 9
    vib.connect(vibG).connect(sine.frequency)
    const sineG = a.createGain()
    sineG.gain.value = 0.22
    sine.connect(sineG).connect(out)
    // the beam's own crackle: band-limited noise, tremoloed
    const n = a.createBufferSource()
    n.buffer = noise(a)
    n.loop = true
    const bp = a.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 3200
    bp.Q.value = 1.2
    const fizz = a.createGain()
    fizz.gain.value = 0.05
    const trem = a.createOscillator()
    trem.frequency.value = 23
    const tremG = a.createGain()
    tremG.gain.value = 0.04
    trem.connect(tremG).connect(fizz.gain)
    n.connect(bp).connect(fizz).connect(out)
    for (const o of [saw, sq, sine, vib, trem]) o.start()
    n.start()
    voice = { out, lp, saw, sq, sine, fizz }
  }

  return {
    hum: (on, strain) => {
      if (!on && level === 0) return
      const a = sharedAudio()
      if (!a) return
      if (!voice) build(a)
      const v = voice!
      const t = a.currentTime
      const target = on ? 0.022 + 0.014 * strain : 0
      if (Math.abs(target - level) > 0.001 || Math.abs(strain - lastStrain) > 0.02) {
        level = target
        lastStrain = strain
        v.out.gain.setTargetAtTime(target, t, on ? 0.03 : 0.05)
        const k = 1 + 0.5 * strain
        v.saw.frequency.setTargetAtTime(58 * k, t, 0.05)
        v.sq.frequency.setTargetAtTime(117.4 * k, t, 0.05)
        v.sine.frequency.setTargetAtTime(348 * k, t, 0.05)
        v.lp.frequency.setTargetAtTime(520 + 1400 * strain, t, 0.05)
      }
      if (!on) level = 0
    },
    grab: () => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      crackle(a, t, 9, 0.14, 0.06)
      sweep(a, t, 'sawtooth', 1400, 260, 0.03, 0.12)
      sweep(a, t, 'sine', 180, 90, 0.05, 0.16)
    },
    release: (speed) => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      const k = Math.min(1, speed / 60)
      crackle(a, t, 4 + Math.round(4 * k), 0.08, 0.04 + 0.03 * k)
      sweep(a, t, 'sawtooth', 500, 1400 + 800 * k, 0.018 + 0.015 * k, 0.07)
    },
    freeze: () => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      sweep(a, t, 'sine', 170, 55, 0.08, 0.2)
      pop(a, t, 'highpass', 4000, 0.7, 0.05, 0.05)
      sweep(a, t + 0.005, 'triangle', 1760, 1320, 0.045, 0.32)
      sweep(a, t + 0.005, 'sine', 2640, 2100, 0.02, 0.22)
    },
    unfreeze: () => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      sweep(a, t, 'triangle', 1100, 1760, 0.035, 0.18)
      crackle(a, t, 5, 0.1, 0.035)
    },
    miss: () => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      pop(a, t, 'bandpass', 3000, 2, 0.03, 0.09)
      sweep(a, t, 'sawtooth', 900, 400, 0.012, 0.08)
    },
    deny: () => {
      const a = sharedAudio()
      if (!a) return
      const t = a.currentTime
      sweep(a, t, 'square', 150, 118, 0.016, 0.07)
      sweep(a, t + 0.085, 'square', 130, 96, 0.016, 0.09)
      pop(a, t, 'bandpass', 900, 1.5, 0.014, 0.05)
    },
    dispose: () => {
      if (voice) {
        voice.out.disconnect()
        for (const o of [voice.saw, voice.sq, voice.sine]) o.stop()
        voice = null
      }
    },
  }
}
