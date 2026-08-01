/*
  AlejOS sound effects, synthesized with WebAudio so we ship zero audio
  assets and nothing copyrighted. Everything is quiet, short, and built from
  the same few soft sine/triangle voices so the OS feels like one machine.
  The AudioContext is created lazily on the first user-gesture-driven call.

  The tray's speaker owns the master level, which is why it is a multiplier
  applied at play() rather than a number baked into each cue: the gains
  inside a cue are its internal balance between voices, and scaling them
  individually would change the shape of the sound instead of its loudness.
*/

let ctx: AudioContext | null = null

// --- master volume, driven by the tray speaker -----------------------------

const VOL_KEY = 'alejos-volume'
const volSubs = new Set<() => void>()

function readVolume(): { level: number; muted: boolean } {
  try {
    const raw = localStorage.getItem(VOL_KEY)
    if (raw) {
      const v = JSON.parse(raw) as { level?: unknown; muted?: unknown }
      return {
        level: typeof v.level === 'number' ? Math.min(1, Math.max(0, v.level)) : 0.7,
        muted: v.muted === true,
      }
    }
  } catch {
    /* storage unavailable or corrupt: fall through to the default */
  }
  return { level: 0.7, muted: false }
}

let master = readVolume()

export function getVolume(): number {
  return master.level
}

export function isMuted(): boolean {
  return master.muted
}

export function subscribeVolume(fn: () => void): () => void {
  volSubs.add(fn)
  return () => volSubs.delete(fn)
}

function commitVolume() {
  try {
    localStorage.setItem(VOL_KEY, JSON.stringify(master))
  } catch {
    /* storage unavailable; the session still works in memory */
  }
  volSubs.forEach((fn) => fn())
}

export function setVolume(level: number) {
  const next = Math.min(1, Math.max(0, level))
  if (next === master.level && !master.muted) return
  // dragging the slider off zero is also how you unmute, like the real tray
  master = { level: next, muted: next === 0 ? master.muted : false }
  commitVolume()
}

export function setMuted(muted: boolean) {
  if (muted === master.muted) return
  master = { ...master, muted }
  commitVolume()
}

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
  if (master.muted || master.level === 0) return
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
    const peak = (v.gain ?? 0.06) * master.level
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(peak * 0.013, at + dur)
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
  /** incoming chat message: soft double blip, MSN energy without the sample */
  message() {
    play([
      { freq: 880, dur: 0.09, gain: 0.05 },
      { freq: 1108.73, at: 0.1, dur: 0.16, gain: 0.05 },
    ])
  },
  error() {
    play([
      { freq: 220, dur: 0.22, type: 'square', gain: 0.025 },
      { freq: 233.08, dur: 0.22, type: 'square', gain: 0.025 },
    ])
  },
  // --- the arcade voices, shared by everything in the Games folder ---
  /** short hop/flap/bounce blip */
  blip() {
    play([{ freq: 520, dur: 0.07, type: 'triangle', gain: 0.05, to: 780 }])
  },
  /** a point scored: quick bright pair */
  point() {
    play([
      { freq: 880, dur: 0.06, gain: 0.045 },
      { freq: 1318.51, at: 0.05, dur: 0.1, gain: 0.045 },
    ])
  },
  /** low impact for hits, merges and landings */
  thud() {
    play([{ freq: 160, dur: 0.1, type: 'triangle', gain: 0.06, to: 70 }])
  },
  /** something went wrong in a game (a crash, a miss), softer than error() */
  miss() {
    play([{ freq: 330, dur: 0.16, type: 'triangle', gain: 0.045, to: 165 }])
  },
  /** a whole game won: small rising fanfare from the boot chime's family */
  fanfare() {
    play([
      { freq: 523.25, dur: 0.14, gain: 0.05 },
      { freq: 659.25, at: 0.11, dur: 0.14, gain: 0.05 },
      { freq: 783.99, at: 0.22, dur: 0.2, gain: 0.05 },
      { freq: 1046.5, at: 0.34, dur: 0.4, gain: 0.055 },
    ])
  },
}
