/*
  AlejOS sound effects, synthesized with WebAudio so we ship zero audio
  assets and nothing copyrighted. Everything is quiet, short, and built from
  the same few soft sine/triangle voices so the OS feels like one machine.
  The AudioContext is created lazily on the first user-gesture-driven call.
*/

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

interface Voice {
  freq: number
  /** seconds after now */
  at?: number
  dur?: number
  type?: OscillatorType
  gain?: number
  /** glide to this frequency over the note */
  to?: number
}

function play(voices: Voice[]) {
  const ac = audio()
  if (!ac) return
  const now = ac.currentTime
  for (const v of voices) {
    const at = now + (v.at ?? 0)
    const dur = v.dur ?? 0.18
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = v.type ?? 'sine'
    osc.frequency.setValueAtTime(v.freq, at)
    if (v.to) osc.frequency.exponentialRampToValueAtTime(v.to, at + dur)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(v.gain ?? 0.06, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0008, at + dur)
    osc.connect(gain).connect(ac.destination)
    osc.start(at)
    osc.stop(at + dur + 0.05)
  }
}

export const sounds = {
  /** warm ascending arpeggio with a pad underneath, our take on a boot chime */
  startup() {
    play([
      { freq: 164.81, dur: 1.6, type: 'triangle', gain: 0.035 }, // E3 pad
      { freq: 329.63, at: 0.0, dur: 0.5 }, // E4
      { freq: 493.88, at: 0.18, dur: 0.5 }, // B4
      { freq: 659.25, at: 0.36, dur: 0.6 }, // E5
      { freq: 830.61, at: 0.54, dur: 0.9, gain: 0.05 }, // G#5
    ])
  },
  shutdown() {
    play([
      { freq: 830.61, at: 0.0, dur: 0.4 },
      { freq: 659.25, at: 0.16, dur: 0.4 },
      { freq: 493.88, at: 0.32, dur: 0.5 },
      { freq: 329.63, at: 0.48, dur: 0.9, gain: 0.05 },
    ])
  },
  /** soft high tick for clicks and selections */
  click() {
    play([{ freq: 1400, dur: 0.05, gain: 0.035, to: 900 }])
  },
  open() {
    play([
      { freq: 440, dur: 0.1, gain: 0.045 },
      { freq: 660, at: 0.07, dur: 0.14, gain: 0.045 },
    ])
  },
  close() {
    play([
      { freq: 660, dur: 0.1, gain: 0.045 },
      { freq: 440, at: 0.07, dur: 0.14, gain: 0.045 },
    ])
  },
  error() {
    play([
      { freq: 220, dur: 0.22, type: 'square', gain: 0.025 },
      { freq: 233.08, dur: 0.22, type: 'square', gain: 0.025 },
    ])
  },
}
