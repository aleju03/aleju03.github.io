import { sharedAudio } from '../core/sfx'
import type { Surface } from './kinds'

/*
  What props sound like: a knock, a clang, a thud or a tink for every hit,
  a splinter, a shatter or a splat for every break, and the boom of every
  explosion. All of it synthesized per event with WebAudio, the way
  core/sfx.ts voices footsteps, and on the same lazy AudioContext
  (`sharedAudio`), so it is headless-safe (null without a window, and every
  call returns) and ships no bytes.

  Voices are modal. A struck object rings at a handful of frequencies that
  decay at their own rates, and the ratios between them are what the ear
  reads as the material: a wooden box has two low, heavily damped modes and a
  knock of noise; steel has inharmonic partials (1, 2.76, 5.4, 8.9: a free
  bar's) that ring for most of a second; an oil drum is a hollow low bong; a
  can or a sheet of tin is the same idea an octave and a half up and short;
  glass is three high partials and almost no body; a melon is a wet thud with
  no ring at all. Each surface in kinds.ts names one of these.

  Level is the blow and the thing. `strength` (0..1, from the change of
  velocity) sets the gain and the brightness; mass sets the pitch (a
  dumpster bongs an octave under a trash can) and how much there is of it.
  Distance to the ear attenuates, pans, delays (sound is slow: 800 units a
  second, so a barrel going off across the street is seen before it is
  heard) and muffles the booms. The levels are peak-matched against a grass
  footstep (0.033 peak) by rendering offline in headless Chrome (`npm run
  film -- props:sounds` prints the table): a light knock of anything lands
  at 0.01 to 0.05, level with a footstep; a crate hitting at full strength
  0.2, a drum 0.25, glass 0.07, a mattress 0.06; a break about 0.2; a barrel
  going off four units away about 0.6, before the bus's limiter, which is
  what keeps a chain of them from clipping.

  Pile-ups are rate-limited, because a collapsing stack reports forty impacts
  in a second and forty knocks on one frame is a burst of white noise: at most
  `VOICES` new voices per `WINDOW`, one per surface per `SAME_GAP`, and quiet
  ones yield to loud ones. Everything past the limit is dropped, not queued.
*/

export interface Ear {
  x: number
  y: number
  z: number
  /** the ear's right-hand direction, for panning; zero for none */
  rx: number
  rz: number
}

const ear: Ear = { x: 0, y: 0, z: 0, rx: 0, rz: 0 }
let earSet = false
let enabled = true

/** where the listener is and which way is right. CrtScene calls this once a
    frame with the camera; until it does, the sandbox's focus stands in */
export const setEar = (x: number, y: number, z: number, rx = 0, rz = 0) => {
  ear.x = x
  ear.y = y
  ear.z = z
  ear.rx = rx
  ear.rz = rz
  earSet = true
}
/** the facade's fallback: the walker or focus position, no panning */
export const setEarFallback = (x: number, y: number, z: number) => {
  if (earSet) return
  ear.x = x
  ear.y = y
  ear.z = z
}
/** mute every prop sound (the film harness does; it has nobody to hear) */
export const setPropSounds = (on: boolean) => {
  enabled = on
}

/* ------------------------------------------------------------ the bus -- */

let bus: GainNode | null = null
let busCtx: BaseAudioContext | null = null
let noiseBuf: AudioBuffer | null = null
/** set while measureSound renders one call offline */
let ctxOverride: OfflineAudioContext | null = null

const context = (): BaseAudioContext | null => {
  if (ctxOverride) return ctxOverride
  if (!enabled) return null
  const a = sharedAudio()
  if (!a) return null
  if (busCtx !== a) {
    busCtx = a
    // a gentle limiter under everything, so a chain reaction of twelve
    // barrels arrives as a wall of noise rather than as clipping
    const comp = a.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.knee.value = 8
    comp.ratio.value = 6
    comp.attack.value = 0.002
    comp.release.value = 0.2
    bus = a.createGain()
    bus.gain.value = 1
    bus.connect(comp).connect(a.destination)
    noiseBuf = null
  }
  return a
}

const noise = (a: BaseAudioContext) => {
  if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
    const len = a.sampleRate
    noiseBuf = a.createBuffer(1, len, a.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }
  return noiseBuf
}

/* ------------------------------------------------------- the voices -- */

/** one voice's output: gain, pan and (for far booms) a lowpass */
interface Out {
  a: BaseAudioContext
  node: AudioNode
  at: number
}

const burst = (o: Out, type: BiquadFilterType, freq: number, q: number, gain: number, dur: number, delay = 0, sweepTo = 0) => {
  const { a, at } = o
  const t = at + delay
  const src = a.createBufferSource()
  src.buffer = noise(a)
  src.loop = true
  const f = a.createBiquadFilter()
  f.type = type
  f.frequency.setValueAtTime(freq, t)
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur)
  f.Q.value = q
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(o.node)
  src.start(t, Math.random() * 0.6)
  src.stop(t + dur + 0.03)
}

/** a sine mode ringing down from `gain` over `dur` */
const mode = (o: Out, freq: number, gain: number, dur: number, delay = 0, drop = 1) => {
  const { a, at } = o
  const t = at + delay
  const osc = a.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, t)
  if (drop !== 1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * drop), t + dur)
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.003)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(g).connect(o.node)
  osc.start(t)
  osc.stop(t + dur + 0.03)
}

/** random ±cents, so no two hits are the same hit */
const jit = (k = 0.06) => 1 + (Math.random() * 2 - 1) * k

type Voice = (o: Out, s: number, p: number) => void

/* s is 0..1 how hard, p a pitch multiplier from mass. Gains are the voice's
   internal balance; `LEVEL` scales the whole surface */
const VOICES_BY: Record<Surface, Voice> = {
  wood: (o, s, p) => {
    burst(o, 'bandpass', 1100 * p * (0.8 + s * 0.5), 1.1, 0.5, 0.05)
    mode(o, 165 * p * jit(), 1, 0.13 + 0.05 * s, 0, 0.9)
    mode(o, 410 * p * jit(), 0.5, 0.07)
    mode(o, 820 * p * jit(), 0.22 * (0.4 + s), 0.04)
  },
  metal: (o, s, p) => {
    const f = 240 * p * jit(0.08)
    burst(o, 'highpass', 2400, 0.7, 0.45 * (0.3 + s), 0.03)
    mode(o, f, 0.55, 0.9)
    mode(o, f * 2.76, 0.42, 0.6)
    mode(o, f * 5.4, 0.28 * (0.3 + s), 0.35)
    mode(o, f * 8.93, 0.16 * s, 0.2)
    mode(o, 70 * p, 0.5, 0.12, 0, 0.7)
  },
  drum: (o, s, p) => {
    const f = 92 * p * jit(0.05)
    burst(o, 'bandpass', 420 * p, 0.9, 0.5, 0.07)
    mode(o, f, 1, 0.55, 0, 0.94)
    mode(o, f * 1.59, 0.6, 0.38)
    mode(o, f * 2.14, 0.42, 0.28)
    mode(o, f * 3.5, 0.25 * (0.3 + s), 0.18)
    burst(o, 'highpass', 2800, 0.7, 0.25 * s, 0.025)
  },
  sheet: (o, s, p) => {
    const f = 620 * p * jit(0.1)
    burst(o, 'highpass', 3200, 0.7, 0.5 * (0.4 + s), 0.035)
    mode(o, f, 0.6, 0.28)
    mode(o, f * 1.93, 0.42, 0.2)
    mode(o, f * 2.83, 0.3, 0.14)
    mode(o, f * 4.12, 0.2 * s, 0.09)
  },
  plastic: (o, s, p) => {
    burst(o, 'bandpass', 700 * p, 0.8, 0.6, 0.06)
    mode(o, 280 * p * jit(), 0.75, 0.07, 0, 0.85)
    mode(o, 690 * p * jit(), 0.3 * (0.5 + s), 0.035)
  },
  rubber: (o, s, p) => {
    mode(o, 120 * p * jit(), 1, 0.12, 0, 0.6)
    burst(o, 'lowpass', 500, 0.7, 0.35 * (0.4 + s), 0.05)
  },
  glass: (o, s, p) => {
    const f = 2500 * p * jit(0.12)
    burst(o, 'highpass', 4500, 0.7, 0.3 * (0.4 + s), 0.02)
    mode(o, f, 0.6, 0.16)
    mode(o, f * 1.58, 0.4, 0.11)
    mode(o, f * 2.43, 0.25, 0.07)
    mode(o, 300 * p, 0.2, 0.04)
  },
  melon: (o, s) => {
    mode(o, 130 * jit(), 1, 0.1, 0, 0.6)
    burst(o, 'lowpass', 420, 0.7, 0.6, 0.08)
    burst(o, 'bandpass', 950, 1.2, 0.3 * s, 0.04)
  },
  concrete: (o, s, p) => {
    burst(o, 'lowpass', 520 * p, 0.8, 0.8, 0.13)
    mode(o, 68 * p * jit(), 1, 0.16, 0, 0.7)
    burst(o, 'highpass', 2600, 0.7, 0.25 * s, 0.05, 0.005)
  },
  soft: (o, s) => {
    burst(o, 'lowpass', 280, 0.6, 0.9, 0.13)
    mode(o, 78 * jit(), 0.45 * (0.5 + s), 0.1, 0, 0.7)
  },
  ceramic: (o, s, p) => {
    const f = 540 * p * jit(0.06)
    burst(o, 'bandpass', 1800, 0.9, 0.4 * (0.4 + s), 0.03)
    mode(o, f, 0.7, 0.4)
    mode(o, f * 2.48, 0.4, 0.22)
    mode(o, f * 4.8, 0.2 * s, 0.1)
    mode(o, 90 * p, 0.6, 0.12, 0, 0.7)
  },
}

/* peak each surface lands at for a full-strength hit at arm's length */
const LEVEL: Record<Surface, number> = {
  wood: 0.2,
  metal: 0.13,
  drum: 0.22,
  sheet: 0.1,
  plastic: 0.22,
  rubber: 0.2,
  glass: 0.17,
  melon: 0.2,
  concrete: 0.24,
  soft: 0.18,
  ceramic: 0.13,
}

/* ------------------------------------------------------ rate limiting -- */

const VOICES = 7
const WINDOW = 0.09
const SAME_GAP = 0.025
const recent: number[] = []
const lastBy = new Map<string, number>()

const admit = (a: BaseAudioContext, key: string, loud: number) => {
  const now = a.currentTime
  while (recent.length && now - recent[0] > WINDOW) recent.shift()
  // a loud hit may take a slot from the budget's quiet end; a quiet one waits
  const budget = loud > 0.12 ? VOICES + 3 : VOICES
  if (recent.length >= budget) return false
  const last = lastBy.get(key) ?? -1
  if (now - last < SAME_GAP && loud < 0.15) return false
  recent.push(now)
  lastBy.set(key, now)
  return true
}

/* --------------------------------------------------------- placement -- */

/** gain and pan from the ear to a point; far sounds also arrive late */
const place = (a: BaseAudioContext, x: number, y: number, z: number, level: number, reach: number) => {
  const dx = x - ear.x
  const dy = y - ear.y
  const dz = z - ear.z
  const d = Math.hypot(dx, dy, dz)
  const g = level / (1 + (d / reach) ** 1.6)
  if (g < 0.003) return null
  const out = a.createGain()
  out.gain.value = g
  let head: AudioNode = out
  if (a.createStereoPanner && (ear.rx || ear.rz) && d > 0.5) {
    const pan = a.createStereoPanner()
    pan.pan.value = Math.max(-0.85, Math.min(0.85, ((dx * ear.rx + dz * ear.rz) / d) * 0.9))
    out.connect(pan)
    head = pan
  }
  return { out, head, d }
}

/* ------------------------------------------------------------ public -- */

/** a prop hit something. `strength` 0..1; mass in kg sets the pitch */
export const impactSound = (surface: Surface, strength: number, mass: number, x: number, y: number, z: number) => {
  const a = context()
  if (!a || !bus || strength <= 0.02) return
  const s = Math.min(1, strength)
  const size = Math.min(1.25, Math.max(0.35, 0.4 + 0.22 * Math.log10(Math.max(0.1, mass))))
  const loud = LEVEL[surface] * s ** 0.8 * size
  if (!admit(a, surface, loud)) return
  const pl = place(a, x, y, z, loud, 22)
  if (!pl) return
  pl.head.connect(bus)
  const p = Math.min(1.9, Math.max(0.45, 1.55 - 0.28 * Math.log10(Math.max(0.1, mass)))) * jit(0.04)
  VOICES_BY[surface]({ a, node: pl.out, at: a.currentTime + pl.d / 800 }, s, p)
}

/** a prop came apart */
export const breakSound = (surface: Surface, strength: number, x: number, y: number, z: number) => {
  const a = context()
  if (!a || !bus) return
  const s = Math.min(1, Math.max(0.3, strength))
  if (!admit(a, 'break:' + surface, 0.2)) return
  const pl = place(a, x, y, z, 0.26 * (0.6 + 0.4 * s), 26)
  if (!pl) return
  pl.head.connect(bus)
  const o: Out = { a, node: pl.out, at: a.currentTime + pl.d / 800 }
  if (surface === 'glass') {
    burst(o, 'highpass', 3200, 0.7, 0.55, 0.22)
    for (let i = 0; i < 12; i++) mode(o, 2200 + Math.random() * 4500, 0.28, 0.06 + Math.random() * 0.1, Math.random() * 0.32)
    mode(o, 520, 0.3, 0.05)
  } else if (surface === 'melon') {
    mode(o, 95, 1, 0.14, 0, 0.55)
    burst(o, 'lowpass', 800, 0.7, 0.9, 0.16)
    burst(o, 'bandpass', 1400, 1.1, 0.5, 0.2, 0.01, 280)
    for (let i = 0; i < 4; i++) burst(o, 'lowpass', 500, 0.7, 0.25, 0.04, 0.12 + Math.random() * 0.4)
  } else {
    // wood (and anything else): a crack, the splintering sweep, the thud of
    // the pieces letting go, and a patter of them landing
    burst(o, 'highpass', 2600, 0.7, 0.7, 0.045)
    burst(o, 'bandpass', 1600 + 900 * s, 1.3, 0.8, 0.26, 0.004, 240)
    mode(o, 140, 0.7, 0.18, 0.03, 0.7)
    for (let i = 0; i < 5; i++) {
      const t = 0.18 + Math.random() * 0.5
      burst(o, 'bandpass', 900 + Math.random() * 700, 1.2, 0.3, 0.04, t)
      mode(o, 180 + Math.random() * 160, 0.25, 0.06, t)
    }
  }
}

/** an explosion of `power` (1 is the red barrel) at a point */
export const boom = (power: number, x: number, y: number, z: number) => {
  const a = context()
  if (!a || !bus) return
  const k = Math.min(1.6, Math.max(0.3, power))
  // an explosion never yields to the budget, but a chain of them thins
  const now = a.currentTime
  if ((lastBy.get('boom') ?? -1) > now - 0.04) return
  lastBy.set('boom', now)
  const pl = place(a, x, y, z, 0.31 * Math.sqrt(k), 45)
  if (!pl) return
  // the further away, the less of the crack and the more of the rumble
  const lp = a.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = Math.max(700, 16000 / (1 + pl.d / 30))
  lp.Q.value = 0.5
  pl.head.connect(lp).connect(bus)
  const o: Out = { a, node: pl.out, at: now + pl.d / 800 }
  burst(o, 'highpass', 1400, 0.6, 0.7, 0.06)
  burst(o, 'lowpass', 3200, 0.6, 1, 1.5 * k, 0.002, 140)
  mode(o, 78, 1, 0.7 * k, 0, 0.38)
  mode(o, 46, 0.7, 0.9 * k, 0.01, 0.6)
  burst(o, 'bandpass', 190, 0.7, 0.4, 2.4 * k, 0.05)
  // debris pattering down afterwards
  for (let i = 0; i < 7; i++) {
    const t = 0.35 + Math.random() * 1.1
    burst(o, 'bandpass', 700 + Math.random() * 1500, 1.4, 0.12, 0.04, t)
  }
}

/** a fuse catching: a whoosh of gas lighting */
export const igniteSound = (x: number, y: number, z: number) => {
  const a = context()
  if (!a || !bus) return
  const pl = place(a, x, y, z, 0.16, 20)
  if (!pl) return
  pl.head.connect(bus)
  const o: Out = { a, node: pl.out, at: a.currentTime + pl.d / 800 }
  burst(o, 'bandpass', 500, 0.6, 0.8, 0.5, 0, 2200)
  burst(o, 'lowpass', 300, 0.7, 0.5, 0.35)
}

/* ---------------------------------------------------------- measuring -- */

/**
 * Render one sound into an offline context and report its peak and RMS, for
 * the peak-match (scripts/probe/film.ts's `soundLevels`). Browser only.
 */
export const measureSound = async (fn: () => void, seconds = 2.5) => {
  const off = new OfflineAudioContext(2, Math.round(44100 * seconds), 44100)
  const prevCtx = busCtx
  const prevBus = bus
  // route this module's voices into the offline context for one call
  busCtx = off
  bus = off.createGain()
  bus.connect(off.destination)
  const prevEnabled = enabled
  enabled = true
  recent.length = 0
  lastBy.clear()
  try {
    ctxOverride = off
    fn()
  } finally {
    ctxOverride = null
    enabled = prevEnabled
  }
  const buf = await off.startRendering()
  busCtx = prevCtx
  bus = prevBus
  noiseBuf = null
  let peak = 0
  let sum = 0
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i])
      if (v > peak) peak = v
      sum += v * v
    }
  }
  return { peak, rms: Math.sqrt(sum / (buf.length * buf.numberOfChannels)) }
}
