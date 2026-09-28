/*
  The ambience's voices, as arithmetic: birdsong, crickets, an owl, and the
  impulse response the score's reverb is convolved with. The music itself is
  played by recorded instruments (`music/sampler.ts`), because a synthesized
  flute is a synthesizer however carefully it is built; these are the sounds
  where synthesis is honestly as good as a recording and costs no download.
  A bird is a sine gliding through a pitch contour, which is what a syrinx
  does; a cricket is a few pulses of a four-and-a-half kilohertz carrier;
  wind and surf are filtered noise and live as live nodes in `ambience.ts`.
  Pure maths over a sample rate, no AudioContext here, so it runs in Node.
*/

const normalise = (out: Float32Array) => {
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] /= peak
  return out
}

/** a small LCG so a voice renders the same way twice; the variety between
    notes comes from the pitch, not from the dice */
const lcg = (seed: number) => {
  let s = seed >>> 0 || 1
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

/** one bird call, peak 1. Four species' worth of shapes, told apart by `kind`:
    0 a two-note "tee-oo", 1 a quick run of chips, 2 a trill, 3 a dove's
    low coo. Each is a sine gliding through a pitch contour, which is what a
    syrinx does, and the variety within a species is `seed` */
export function renderBird(kind: number, seed: number, sr: number): Float32Array {
  const rand = lcg(seed * 2654435761 + kind)
  // a contour is a list of [duration s, from Hz, to Hz, gap after s]
  const notes: [number, number, number, number][] = []
  const base = 2600 + rand() * 1600
  if (kind === 0) {
    notes.push([0.11, base * 1.15, base * 1.25, 0.05], [0.18, base * 1.0, base * 0.72, 0])
  } else if (kind === 1) {
    const n = 3 + Math.floor(rand() * 4)
    for (let i = 0; i < n; i++) notes.push([0.035, base * 1.3, base * 0.95, 0.045 + rand() * 0.02])
  } else if (kind === 2) {
    const n = 8 + Math.floor(rand() * 8)
    for (let i = 0; i < n; i++) notes.push([0.022, base * 0.9, base * 1.1, 0.012])
    notes.push([0.14, base * 1.2, base * 0.8, 0])
  } else {
    const low = 480 + rand() * 80
    notes.push([0.35, low * 0.94, low, 0.08], [0.55, low, low * 0.9, 0.12], [0.3, low * 0.95, low * 0.9, 0])
  }
  let total = 0
  for (const [d, , , g] of notes) total += d + g
  const out = new Float32Array(Math.floor((total + 0.05) * sr))
  let i = 0
  let ph = 0
  for (const [d, f0, f1, g] of notes) {
    const len = Math.floor(d * sr)
    for (let j = 0; j < len; j++, i++) {
      const t = j / len
      // an exponential glide and a sine-shaped swell: no clicks at either end
      const fr = f0 * (f1 / f0) ** t
      ph += (2 * Math.PI * fr) / sr
      const env = Math.sin(Math.PI * t) ** (kind === 3 ? 1.5 : 0.8)
      // a touch of the second harmonic, strongest on the dove
      out[i] = env * (Math.sin(ph) + (kind === 3 ? 0.25 : 0.08) * Math.sin(2 * ph))
    }
    i += Math.floor(g * sr)
  }
  return normalise(out)
}

/** one cricket chirp: three to four pulses of a ~4.5 kHz carrier */
export function renderCricket(seed: number, sr: number): Float32Array {
  const rand = lcg(seed * 40503 + 17)
  const fr = 4200 + rand() * 700
  const pulses = 3 + Math.floor(rand() * 2)
  const pulse = 0.014
  const gap = 0.018
  const out = new Float32Array(Math.floor((pulses * (pulse + gap) + 0.02) * sr))
  for (let p = 0; p < pulses; p++) {
    const o = Math.floor(p * (pulse + gap) * sr)
    const len = Math.floor(pulse * sr)
    for (let j = 0; j < len; j++) {
      const t = j / len
      out[o + j] = Math.sin((2 * Math.PI * fr * (o + j)) / sr) * Math.sin(Math.PI * t) ** 2
    }
  }
  return normalise(out)
}

/** an owl's two soft hoots, for the night: rare, low and far away */
export function renderOwl(sr: number): Float32Array {
  const hoot = (len: number, f: number) => {
    const a = new Float32Array(Math.floor(len * sr))
    let ph = 0
    for (let i = 0; i < a.length; i++) {
      const t = i / a.length
      ph += (2 * Math.PI * f * (1 - 0.06 * t)) / sr
      a[i] = Math.sin(Math.PI * t) ** 1.6 * (Math.sin(ph) + 0.12 * Math.sin(2 * ph))
    }
    return a
  }
  const one = hoot(0.28, 395)
  const two = hoot(0.55, 380)
  const out = new Float32Array(one.length + Math.floor(0.22 * sr) + two.length)
  out.set(one, 0)
  out.set(two, one.length + Math.floor(0.22 * sr))
  return normalise(out)
}

/** the reverb's impulse response, per channel: decaying noise that darkens
    as it goes, the way a room's high end dies first */
export function renderImpulse(sr: number, seconds: number, seed: number): Float32Array {
  const rand = lcg(seed)
  const len = Math.floor(seconds * sr)
  const out = new Float32Array(len)
  const pre = Math.floor(0.012 * sr)
  let lp = 0
  for (let i = pre; i < len; i++) {
    const t = (i - pre) / sr
    const k = 0.9 * Math.exp(-t / (seconds * 0.35)) + 0.06
    lp += k * (rand() * 2 - 1 - lp)
    out[i] = lp * Math.exp((-6.9 * t) / seconds)
  }
  return normalise(out)
}
