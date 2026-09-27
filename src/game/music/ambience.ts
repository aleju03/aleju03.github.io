/*
  The world's room tone: what you hear between the pieces of music, and
  under them. Wind, leaves, surf, birds by day, crickets and the odd owl by
  night, each one a level that follows the place and the hour.

  Wind, leaves and surf are live filtered noise: one looping white-noise
  buffer feeding three filter-and-gain chains whose settings are eased every
  frame. The wind's gusts are a slow random walk, not a sine, because a
  periodic gust is heard as a machine within about three of them. The birds,
  crickets and owl are short buffers rendered once (`ambienceVoices.ts`) and
  scattered in time and across the stereo field, re-pitched a little each
  time so that ten calls from one voice sound like ten birds.

  The levels are a small table of plain facts about places: a forest has
  more birds than a desert, a town has fewer crickets than a meadow, height
  means wind, the Moon has no air and so has none of it. Indoors the whole
  chain goes through a lowpass, because walls pass the low end, and that one
  filter is also what water does to sound when the lens is under it.

  Math.random() is deliberate, as in core/sfx.ts: this is audio grain, not
  world state.
*/

import { renderBird, renderCricket, renderOwl } from './ambienceVoices'

export interface AmbienceInput {
  /** 'overworld', 'moon', 'backrooms', ... */
  level: string
  indoor: number
  day: number
  night: number
  twilight: number
  biome: string | null
  alt: number
  /** 0..1, how much of the view around is open water */
  shore: number
  underwater: boolean
}

/** per biome: [birds, crickets, leaves] */
const PLACE: Record<string, [number, number, number]> = {
  plains: [0.8, 1, 0.3],
  forest: [1, 0.7, 1],
  taiga: [0.6, 0.4, 0.8],
  jungle: [1, 0.9, 1],
  wetland: [0.9, 1, 0.5],
  savanna: [0.6, 0.9, 0.3],
  desert: [0.12, 0.35, 0],
  tundra: [0.15, 0.1, 0.1],
  snow: [0.05, 0, 0.05],
  rock: [0.25, 0.2, 0.1],
  beach: [0.4, 0.3, 0.1],
  ocean: [0.15, 0, 0],
  town: [0.45, 0.35, 0.25],
}

const ease = (cur: number, want: number, dt: number, tau: number) => cur + (want - cur) * (1 - Math.exp(-dt / tau))

export interface Ambience {
  update: (inp: AmbienceInput, dt: number) => void
  /** fade everything to silence (the walk is over) */
  hush: () => void
}

export function createAmbience(ctx: AudioContext, out: AudioNode): Ambience {
  const sr = ctx.sampleRate
  const noiseBuf = ctx.createBuffer(1, sr * 4, sr)
  const nd = noiseBuf.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1

  // walls and water: one lowpass over everything
  const muffle = ctx.createBiquadFilter()
  muffle.type = 'lowpass'
  muffle.frequency.value = 18000
  muffle.Q.value = 0.5
  const master = ctx.createGain()
  master.gain.value = 0
  master.connect(muffle).connect(out)

  const noiseChain = (type: BiquadFilterType, freq: number, q: number) => {
    const src = ctx.createBufferSource()
    src.buffer = noiseBuf
    src.loop = true
    // each chain reads the loop from its own point so they do not correlate
    src.start(0, Math.random() * 4)
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = ctx.createGain()
    g.gain.value = 0
    src.connect(f).connect(g).connect(master)
    return { f, g }
  }
  const wind = noiseChain('bandpass', 500, 0.7)
  const windLow = noiseChain('lowpass', 180, 0.7)
  const leaves = noiseChain('highpass', 3200, 0.5)
  const surf = noiseChain('lowpass', 700, 0.6)
  const surfHiss = noiseChain('bandpass', 2400, 0.4)

  const birds = [0, 1, 2, 3].flatMap((kind) => [0, 1, 2].map((seed) => {
    const data = renderBird(kind, seed, sr)
    const b = ctx.createBuffer(1, data.length, sr)
    b.getChannelData(0).set(data)
    return { kind, b }
  }))
  const crickets = [0, 1, 2].map((seed) => {
    const data = renderCricket(seed, sr)
    const b = ctx.createBuffer(1, data.length, sr)
    b.getChannelData(0).set(data)
    return b
  })
  const owlData = renderOwl(sr)
  const owl = ctx.createBuffer(1, owlData.length, sr)
  owl.getChannelData(0).set(owlData)

  const shot = (buf: AudioBuffer, when: number, gain: number, pan: number, rate: number) => {
    const s = ctx.createBufferSource()
    s.buffer = buf
    s.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = gain
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    s.connect(g).connect(p).connect(master)
    s.start(when)
  }

  let level = 0
  let gust = 0.5
  let gustWant = 0.5
  let gustClock = 0
  let swell = 0
  let swellClock = 0
  let birdClock = 1.5
  let owlClock = 25
  const cricketClock = [0.3, 0.7, 1.1]
  const cricketPeriod = crickets.map(() => 0.75 + Math.random() * 0.4)
  const cricketPan = [-0.6, 0.15, 0.7]
  let cur = { wind: 0, leaves: 0, surf: 0, birds: 0, crickets: 0 }
  let hushed = false

  return {
    update(inp, dt) {
      hushed = false
      const now = ctx.currentTime
      const air = inp.level === 'overworld'
      const place = PLACE[inp.biome ?? 'plains'] ?? PLACE.plains
      const outside = 1 - inp.indoor
      const high = Math.min(1, Math.max(0, inp.alt / 80))
      const want = {
        wind: air ? (0.2 + 0.12 * (1 - place[2]) + 0.6 * high) * (0.35 + 0.65 * outside) : 0,
        leaves: air ? place[2] * (1 - high) * outside * 0.5 : 0,
        surf: air ? inp.shore * (1 - high * 0.7) * (0.3 + 0.7 * outside) : 0,
        birds: air ? place[0] * Math.max(0, inp.day - 0.35) * (1 - high) * (0.25 + 0.75 * outside) : 0,
        crickets: air ? place[1] * Math.max(0, inp.night - 0.3) * (1 - high) * (0.3 + 0.7 * outside) : 0,
      }
      cur = {
        wind: ease(cur.wind, want.wind, dt, 2),
        leaves: ease(cur.leaves, want.leaves, dt, 2),
        surf: ease(cur.surf, want.surf, dt, 2),
        birds: ease(cur.birds, want.birds, dt, 3),
        crickets: ease(cur.crickets, want.crickets, dt, 3),
      }
      level = ease(level, air ? 1 : 0, dt, 0.8)
      master.gain.setTargetAtTime(level, now, 0.1)
      const cutoff = inp.underwater ? 380 : 18000 - 16800 * inp.indoor
      muffle.frequency.setTargetAtTime(cutoff, now, 0.15)

      // gusts: a random walk toward a new target every couple of seconds
      gustClock -= dt
      if (gustClock <= 0) {
        gustClock = 1.5 + Math.random() * 3
        gustWant = Math.min(1, Math.max(0.1, gustWant + (Math.random() - 0.5) * 0.7))
      }
      gust = ease(gust, gustWant, dt, 1.2)
      const w = cur.wind * (0.45 + 0.8 * gust)
      wind.g.gain.setTargetAtTime(w * 0.09, now, 0.12)
      wind.f.frequency.setTargetAtTime(320 + 520 * gust + 400 * high, now, 0.2)
      windLow.g.gain.setTargetAtTime(w * 0.12, now, 0.12)
      leaves.g.gain.setTargetAtTime(cur.leaves * gust * gust * 0.05, now, 0.1)

      // surf: a wave every six to ten seconds, rising slow and falling slower
      swellClock -= dt
      if (swellClock <= 0) {
        swellClock = 6 + Math.random() * 4
        swell = 1
      }
      swell = Math.max(0, swell - dt / 7)
      const wave = Math.sin(Math.PI * Math.min(1, (1 - swell) * 1.6)) ** 2
      surf.g.gain.setTargetAtTime(cur.surf * (0.25 + 0.75 * wave) * 0.16, now, 0.25)
      surfHiss.g.gain.setTargetAtTime(cur.surf * wave * wave * 0.035, now, 0.2)

      // birds: a call every one to five seconds, fewer as the day fades
      birdClock -= dt
      if (birdClock <= 0) {
        birdClock = (1 + Math.random() * 4) / Math.max(0.3, cur.birds + 0.01)
        if (cur.birds > 0.05) {
          const pick = birds[Math.floor(Math.random() * birds.length)]
          // doves are close-ish and low; songbirds anywhere in the trees
          const g = cur.birds * (pick.kind === 3 ? 0.05 : 0.025 + Math.random() * 0.035)
          const n = pick.kind === 1 && Math.random() < 0.4 ? 2 : 1
          for (let i = 0; i < n; i++) shot(pick.b, now + 0.05 + i * 0.5, g, (Math.random() * 2 - 1) * 0.85, 0.9 + Math.random() * 0.22)
        }
      }

      // crickets: each one keeps its own period, which is what makes a field
      // of them shimmer instead of tick
      if (cur.crickets > 0.03) {
        for (let i = 0; i < crickets.length; i++) {
          cricketClock[i] -= dt
          if (cricketClock[i] <= 0) {
            cricketClock[i] += cricketPeriod[i] * (0.97 + Math.random() * 0.06)
            if (cricketClock[i] < 0) cricketClock[i] = cricketPeriod[i]
            shot(crickets[i], now + 0.03, cur.crickets * 0.018, cricketPan[i], 0.98 + Math.random() * 0.04)
          }
        }
      }

      owlClock -= dt
      if (owlClock <= 0) {
        owlClock = 35 + Math.random() * 60
        if (cur.crickets > 0.2 && inp.biome !== 'town') shot(owl, now + 0.05, 0.035 * cur.crickets, Math.random() * 1.4 - 0.7, 0.95 + Math.random() * 0.1)
      }
    },
    hush() {
      if (hushed) return
      hushed = true
      level = 0
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.5)
    },
  }
}
