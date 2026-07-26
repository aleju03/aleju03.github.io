import { sharedAudio } from '../core/sfx'

/*
  Engines.

  Everything else this project makes a noise with is a one-shot: a footstep, a
  door, a landing thump. They are fired and forgotten — core/sfx.ts says so in
  its header, and it is why nothing there has ever needed to be disposed. An
  engine is the opposite. It is a graph that runs for as long as you are
  sitting in the thing, it has to be modulated every frame, and if it is not
  explicitly torn down on the pause menu, the level cut, a tab-out and the
  scene unmount, it drones on underneath a page that has visibly stopped.

  So this module owns the first live node graphs in the runtime, and the
  discipline that goes with them: nodes are built on `start()` and destroyed on
  `stop()` (an OscillatorNode cannot be restarted, so there is nothing to keep
  anyway), every parameter change goes through `setTargetAtTime` rather than a
  bare assignment — a value written straight onto an AudioParam sixty times a
  second is a staircase, and a staircase in an audio signal is a buzz — and
  every voice hangs off one master gain that a single call can take to zero.

  The three voices are built out of the same three ideas in different
  proportions:

  - a **pitched core** at the firing frequency, from detuned sawtooth or
    square oscillators through a lowpass whose cutoff opens with load. That
    opening filter is what "under power" sounds like; without it, a throttle
    is just a pitch change and the engine sounds like a theremin.
  - a **noise bed** — intake, water rush, rotor wash — band-limited and
    scaled by speed.
  - for the helicopter, an **amplitude gate** at the blade-passage frequency.
    That slap is the entire identity of a rotorcraft, and it is not a filter
    effect: it is the gain being chopped a dozen-odd times a second. A plain
    sine LFO gives a soft wobble, so the modulator here is a custom
    PeriodicWave whose harmonics are stacked in phase, which makes a peaked
    pulse train — a thwop rather than a warble.

  Levels are deliberately low and matched against the footsteps in core/sfx.ts
  (scuffs peak around 0.055). An engine that runs continuously has to sit
  *under* the world, not over it, and the note in CLAUDE.md about normalised
  recordings running four times hotter than this mix applies twice over to
  something that never stops.

  Headless-safe throughout: `sharedAudio()` returns null with no `window`, and
  every method here becomes a no-op.
*/

export type VoiceKind = 'car' | 'boat' | 'heli'

export interface VehicleVoice {
  /** build the graph and fade in */
  start: () => void
  /** fade out and destroy it; safe to call twice */
  stop: () => void
  /**
   * One frame of state.
   * `rpm` 0..1 is the engine/rotor note, `load` 0..1 how hard it is working,
   * `speed` 0..1 of the vehicle's top speed, `slip` 0..1 for tyre howl.
   */
  set: (rpm: number, load: number, speed: number, slip: number) => void
  /**
   * Where this machine is, relative to the listener: right, up and *back*
   * along the camera's own axes, in world units. Somebody else's helicopter
   * has to be somewhere, and (0, 0, 0) — the default, and what the machine
   * you are sitting in passes — is the mix this module was tuned for.
   *
   * Deliberately not a PannerNode. A panner needs `ctx.listener` kept in step
   * with the camera, and the only thing that does that here is the proximity
   * voice mesh, which most visitors never switch on. Distance and a stereo
   * pan computed on the CPU need nothing but the numbers already in hand.
   */
  place: (right: number, up: number, back: number) => void
  /** silence without tearing down: the pause menu, a hidden tab */
  mute: (on: boolean) => void
  dispose: () => void
}

/** where the pitched core sits, and how the bed is voiced, per machine */
const SPEC = {
  car: {
    /** firing note at idle and at the redline, Hz */
    f0: 46, f1: 268,
    wave: 'sawtooth' as OscillatorType,
    /** lowpass cutoff, closed and wide open */
    lp0: 340, lp1: 2600,
    /** how loud the pitched core is, idling and flat out */
    core0: 0.016, core1: 0.05,
    /** the intake/exhaust noise bed */
    bed: 0.02, bedF: 420, bedQ: 0.8,
    /** roll/wind noise with speed */
    rush: 0.028, rushF: 900,
    /** detune spread in cents between the three oscillators */
    spread: 9,
    slap: 0,
  },
  boat: {
    // an outboard is a slower, fatter note than a car engine and most of what
    // you hear at speed is the hull, not the motor
    f0: 30, f1: 158,
    wave: 'square' as OscillatorType,
    lp0: 220, lp1: 1250,
    core0: 0.02, core1: 0.046,
    bed: 0.016, bedF: 300, bedQ: 0.7,
    rush: 0.055, rushF: 1500,
    spread: 14,
    slap: 0,
  },
  heli: {
    // the piston whine sits above the slap and carries the rev information
    f0: 70, f1: 300,
    wave: 'sawtooth' as OscillatorType,
    lp0: 500, lp1: 2100,
    core0: 0.01, core1: 0.03,
    bed: 0.05, bedF: 200, bedQ: 0.5,
    rush: 0.026, rushF: 2400,
    spread: 6,
    /** blade passage: two blades, so the slap runs at twice rotor speed.
        5 Hz on a lazy idle up to 19 at full song */
    slap: 1, slapF0: 4.5, slapF1: 19,
  },
} as const

let noiseBuf: AudioBuffer | null = null
const noise = (a: AudioContext) => {
  if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
    const len = a.sampleRate * 2
    noiseBuf = a.createBuffer(1, len, a.sampleRate)
    const d = noiseBuf.getChannelData(0)
    // audio grain is cosmetic, not world state, so it stays outside the
    // seeded-determinism contract — the same call core/sfx.ts makes
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }
  return noiseBuf
}

/** a modulator with its harmonics stacked in phase: a pulse, not a wobble */
let slapWave: PeriodicWave | null = null
const pulseWave = (a: AudioContext) => {
  if (!slapWave) {
    const real = new Float32Array([0, 1, 0.82, 0.6, 0.42, 0.28, 0.18, 0.1])
    const imag = new Float32Array(real.length)
    slapWave = a.createPeriodicWave(real, imag, { disableNormalization: false })
  }
  return slapWave
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t

export function createVehicleVoice(kind: VoiceKind): VehicleVoice {
  const spec = SPEC[kind]
  let a: AudioContext | null = null
  let master: GainNode | null = null
  let oscs: OscillatorNode[] = []
  let sources: AudioBufferSourceNode[] = []
  let core: GainNode | null = null
  let lp: BiquadFilterNode | null = null
  let bedGain: GainNode | null = null
  let rushGain: GainNode | null = null
  let howlGain: GainNode | null = null
  let slapLfo: OscillatorNode | null = null
  let slapDepth: GainNode | null = null
  let slapBias: ConstantSourceNode | null = null
  let pan: StereoPannerNode | null = null
  let running = false
  let muted = false
  /** 0..1 distance attenuation, and where in the stereo field. Kept outside
      the graph so `place()` can be called before `start()` and a machine that
      is already a hundred units away does not announce itself at full volume
      for the first frame */
  let far = 1
  let side = 0

  /** every parameter move is a short glide; a bare assignment per frame
      steps the signal and a stepped signal buzzes */
  const to = (p: AudioParam | undefined, v: number, tau = 0.06) => {
    if (!p || !a) return
    p.setTargetAtTime(v, a.currentTime, tau)
  }

  const teardown = () => {
    for (const o of oscs) {
      try {
        o.stop()
      } catch {
        /* already stopped */
      }
    }
    for (const s of sources) {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
    }
    try {
      slapBias?.stop()
    } catch {
      /* already stopped */
    }
    oscs = []
    sources = []
    master?.disconnect()
    master = null
    pan?.disconnect()
    pan = null
    core = null
    lp = null
    bedGain = null
    rushGain = null
    howlGain = null
    slapLfo = null
    slapDepth = null
    slapBias = null
  }

  const start = () => {
    if (running) return
    a = sharedAudio()
    if (!a) return
    running = true
    const now = a.currentTime

    master = a.createGain()
    master.gain.setValueAtTime(0.0001, now)
    master.gain.linearRampToValueAtTime(muted ? 0.0001 : far, now + 0.25)
    // the pan sits between the master and the speakers so `mute` still owns
    // one gain and one only. A machine at the listener's own position pans
    // dead centre, which is the graph this module has always been
    pan = a.createStereoPanner()
    pan.pan.setValueAtTime(side, now)
    master.connect(pan).connect(a.destination)

    // --- the pitched core: detuned oscillators through an opening lowpass ---
    lp = a.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(spec.lp0, now)
    lp.Q.value = 0.9
    core = a.createGain()
    core.gain.setValueAtTime(spec.core0, now)
    for (let i = 0; i < 3; i++) {
      const o = a.createOscillator()
      o.type = spec.wave
      o.frequency.setValueAtTime(spec.f0, now)
      o.detune.setValueAtTime((i - 1) * spec.spread, now)
      o.connect(lp)
      o.start(now)
      oscs.push(o)
    }
    // a sub an octave down gives the note a body the sawtooth alone has not
    const sub = a.createOscillator()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(spec.f0 * 0.5, now)
    const subG = a.createGain()
    subG.gain.value = 0.5
    sub.connect(subG).connect(lp)
    sub.start(now)
    oscs.push(sub)
    lp.connect(core)

    // --- the noise bed: intake, water, rotor wash ---
    const bedSrc = a.createBufferSource()
    bedSrc.buffer = noise(a)
    bedSrc.loop = true
    const bedF = a.createBiquadFilter()
    bedF.type = 'bandpass'
    bedF.frequency.value = spec.bedF
    bedF.Q.value = spec.bedQ
    bedGain = a.createGain()
    bedGain.gain.setValueAtTime(0.0001, now)
    bedSrc.connect(bedF).connect(bedGain)
    bedSrc.start(now, Math.random() * 1.5)
    sources.push(bedSrc)

    // --- the rush: road roar, hull wash, blade wind ---
    const rushSrc = a.createBufferSource()
    rushSrc.buffer = noise(a)
    rushSrc.loop = true
    const rushF = a.createBiquadFilter()
    rushF.type = kind === 'boat' ? 'bandpass' : 'lowpass'
    rushF.frequency.value = spec.rushF
    rushF.Q.value = 0.6
    rushGain = a.createGain()
    rushGain.gain.setValueAtTime(0.0001, now)
    rushSrc.connect(rushF).connect(rushGain)
    rushSrc.start(now, Math.random() * 1.5)
    sources.push(rushSrc)

    // --- tyre howl, car only, but harmless to build for all three ---
    const howlSrc = a.createBufferSource()
    howlSrc.buffer = noise(a)
    howlSrc.loop = true
    const howlF = a.createBiquadFilter()
    howlF.type = 'bandpass'
    howlF.frequency.value = 1500
    howlF.Q.value = 6
    howlGain = a.createGain()
    howlGain.gain.setValueAtTime(0.0001, now)
    howlSrc.connect(howlF).connect(howlGain)
    howlSrc.start(now, Math.random() * 1.5)
    sources.push(howlSrc)

    if (spec.slap) {
      /*
        The slap. Everything that should be chopped — the core, the bed, the
        rush — routes through one gain whose value is (bias + depth * pulse).
        A ConstantSourceNode supplies the bias because an AudioParam driven by
        a modulator ignores its own value entirely; without it the gate closes
        to silence between beats and the helicopter stutters rather than
        thumping.
      */
      const gate = a.createGain()
      gate.gain.value = 0
      slapBias = a.createConstantSource()
      slapBias.offset.setValueAtTime(0.62, now)
      slapBias.connect(gate.gain)
      slapBias.start(now)
      slapLfo = a.createOscillator()
      slapLfo.setPeriodicWave(pulseWave(a))
      slapLfo.frequency.setValueAtTime(spec.slapF0, now)
      slapDepth = a.createGain()
      slapDepth.gain.setValueAtTime(0.38, now)
      slapLfo.connect(slapDepth).connect(gate.gain)
      slapLfo.start(now)
      core.connect(gate)
      bedGain.connect(gate)
      rushGain.connect(gate)
      gate.connect(master)
    } else {
      core.connect(master)
      bedGain.connect(master)
      rushGain.connect(master)
    }
    howlGain.connect(master)
  }

  const stop = () => {
    if (!running || !a || !master) {
      running = false
      return
    }
    running = false
    const now = a.currentTime
    master.gain.cancelScheduledValues(now)
    master.gain.setValueAtTime(master.gain.value, now)
    master.gain.linearRampToValueAtTime(0.0001, now + 0.22)
    // hold the reference until the fade has actually played out, or the
    // graph is collected mid-ramp and the engine cuts rather than dies
    const dying = { oscs, sources, master, pan, bias: slapBias }
    oscs = []
    sources = []
    master = null
    pan = null
    slapBias = null
    setTimeout(() => {
      for (const o of dying.oscs) {
        try {
          o.stop()
        } catch {
          /* already stopped */
        }
      }
      for (const s of dying.sources) {
        try {
          s.stop()
        } catch {
          /* already stopped */
        }
      }
      try {
        dying.bias?.stop()
      } catch {
        /* already stopped */
      }
      dying.master?.disconnect()
      dying.pan?.disconnect()
    }, 320)
    core = null
    lp = null
    bedGain = null
    rushGain = null
    howlGain = null
    slapLfo = null
    slapDepth = null
  }

  return {
    start,
    stop,
    mute: (on) => {
      muted = on
      if (master && a) to(master.gain, on ? 0.0001 : far, 0.05)
    },
    place: (right, up, back) => {
      const d = Math.hypot(right, up, back)
      // inverse-square with a soft core, cut to nothing at the fog line: the
      // reference distance is about a car length, so sitting in the thing is
      // full volume and standing at its door is most of it
      const REF = 6
      const CUT = 220
      const raw = d > CUT ? 0 : 1 / (1 + (d / REF) * (d / REF))
      far = raw < 0.0001 ? 0.0001 : raw
      // and how far off the nose it is. Close up the pan collapses, because a
      // machine you are sitting in has no side of the head to be on
      side = d > 0.001 ? (right / d) * Math.min(1, d / 8) : 0
      if (!a) return
      if (master && !muted) to(master.gain, far, 0.08)
      to(pan?.pan, side, 0.08)
    },
    set: (rpm, load, speed, slip) => {
      if (!running || !a) return
      const r = rpm < 0 ? 0 : rpm > 1 ? 1 : rpm
      const l = load < 0 ? 0 : load > 1 ? 1 : load
      const s = speed < 0 ? 0 : speed > 1 ? 1 : speed
      const f = mix(spec.f0, spec.f1, r)
      for (let i = 0; i < oscs.length; i++) {
        // the last oscillator is the sub, an octave under the rest
        to(oscs[i].frequency, i === oscs.length - 1 ? f * 0.5 : f, 0.035)
      }
      // the filter opens with load, not with revs: that is the difference
      // between "revving" and "pulling"
      to(lp?.frequency, mix(spec.lp0, spec.lp1, 0.25 * r + 0.75 * l), 0.05)
      to(core?.gain, mix(spec.core0, spec.core1, 0.3 * r + 0.7 * l))
      to(bedGain?.gain, spec.bed * (0.35 + 0.65 * l))
      to(rushGain?.gain, spec.rush * s * s)
      to(howlGain?.gain, 0.04 * slip * slip)
      if (slapLfo) {
        to(slapLfo.frequency, mix(SPEC.heli.slapF0, SPEC.heli.slapF1, r), 0.12)
        // the slap deepens as the disc loads up; a spinning-down rotor goes
        // smooth and quiet rather than merely slower
        to(slapDepth?.gain, 0.16 + 0.3 * r)
      }
    },
    dispose: () => {
      running = false
      teardown()
    },
  }
}

/* ------------------------------------------------------------ one-shots -- */

/** a door pulled shut on a car: a damped body knock plus a latch click */
export const vehicleDoor = (open: boolean) => {
  const a = sharedAudio()
  if (!a) return
  const now = a.currentTime
  const o = a.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(open ? 130 : 96, now)
  o.frequency.exponentialRampToValueAtTime(52, now + 0.13)
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(open ? 0.045 : 0.062, now + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0004, now + 0.16)
  o.connect(g).connect(a.destination)
  o.start(now)
  o.stop(now + 0.18)
  const s = a.createBufferSource()
  s.buffer = noise(a)
  s.loop = true
  const f = a.createBiquadFilter()
  f.type = 'highpass'
  f.frequency.value = 2400
  const ng = a.createGain()
  ng.gain.setValueAtTime(0.0001, now + 0.01)
  ng.gain.exponentialRampToValueAtTime(0.03, now + 0.018)
  ng.gain.exponentialRampToValueAtTime(0.0004, now + 0.06)
  s.connect(f).connect(ng).connect(a.destination)
  s.start(now + 0.01, Math.random() * 1.4)
  s.stop(now + 0.09)
}

/** metal meeting something that will not move; k is 0..1 of how hard */
export const vehicleImpact = (k: number) => {
  const a = sharedAudio()
  if (!a || k <= 0.02) return
  const now = a.currentTime
  const w = Math.min(1, k)
  const s = a.createBufferSource()
  s.buffer = noise(a)
  s.loop = true
  const f = a.createBiquadFilter()
  f.type = 'bandpass'
  f.frequency.value = 320 + 900 * w
  f.Q.value = 0.7
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.02 + 0.075 * w, now + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0004, now + 0.14 + 0.12 * w)
  s.connect(f).connect(g).connect(a.destination)
  s.start(now, Math.random() * 1.4)
  s.stop(now + 0.32)
  const o = a.createOscillator()
  o.type = 'triangle'
  o.frequency.setValueAtTime(120 - 40 * w, now)
  o.frequency.exponentialRampToValueAtTime(44, now + 0.18)
  const og = a.createGain()
  og.gain.setValueAtTime(0.0001, now)
  og.gain.exponentialRampToValueAtTime(0.03 + 0.06 * w, now + 0.01)
  og.gain.exponentialRampToValueAtTime(0.0004, now + 0.22)
  o.connect(og).connect(a.destination)
  o.start(now)
  o.stop(now + 0.26)
}

/** a hull hitting water, or a wheel finding a puddle */
export const vehicleSplash = (k: number) => {
  const a = sharedAudio()
  if (!a || k <= 0.02) return
  const now = a.currentTime
  const w = Math.min(1, k)
  const s = a.createBufferSource()
  s.buffer = noise(a)
  s.loop = true
  const f = a.createBiquadFilter()
  f.type = 'bandpass'
  f.frequency.setValueAtTime(700, now)
  f.frequency.exponentialRampToValueAtTime(2400, now + 0.3)
  f.Q.value = 0.35
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.03 + 0.06 * w, now + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0004, now + 0.42)
  s.connect(f).connect(g).connect(a.destination)
  s.start(now, Math.random() * 1.4)
  s.stop(now + 0.5)
}

/** two tones a fifth apart, which is what a car horn actually is */
export const vehicleHorn = () => {
  const a = sharedAudio()
  if (!a) return
  const now = a.currentTime
  for (const [f, gain] of [[392, 0.03], [523, 0.024]] as const) {
    const o = a.createOscillator()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(f, now)
    const lp = a.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1800
    const g = a.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(gain, now + 0.012)
    g.gain.setValueAtTime(gain, now + 0.26)
    g.gain.exponentialRampToValueAtTime(0.0004, now + 0.34)
    o.connect(lp).connect(g).connect(a.destination)
    o.start(now)
    o.stop(now + 0.36)
  }
}
