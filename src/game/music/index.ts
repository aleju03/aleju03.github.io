/*
  The walk's soundtrack: which piece plays when, and the mixer it plays
  through. `score.ts` is the music, `composer.ts` arranges one performance
  of it, `sampler.ts` plays it on recorded instruments, `ambience.ts` is the
  world's own sound underneath. This module is the conductor over the four.

  The shape is the one open-world games settled on, and it is settled for a
  reason: **music comes and goes**. A piece plays (ninety seconds to three
  minutes), then the world is quiet for most of a minute with only the wind
  and the birds, then the next piece comes in chosen by where you are now. A
  score that never stops becomes wallpaper, and wallpaper is what makes a
  soundtrack annoying; the silences are what make the next entrance land.
  The portfolio page learned the same lesson from the other side (see
  `src/audio/`'s header: no ambient bed).

  What picks the piece is a *mood*, read every frame off plain facts the
  scene already has: the level, how far indoors, day and night, the biome,
  height, the machine you are in, the sea around you. Moods group into
  families (the house; the land by day and night; the sea; the sky; space),
  and the rule is that a change of family is worth interrupting for and a
  change within one is not. Walk out of the front door and the waltz fades
  over a few seconds and the open-country theme comes in; walk from a
  meadow into town and the meadow piece finishes, then the town gets the
  next one. Every mood has to hold for a few seconds before it counts, so
  pacing in a doorway does not restart anything.

  The mixer: each performance gets its own bus (so a fading piece and an
  arriving one never share a gain), each instrument a strip on it with a
  level, a place in the stereo field and a send into one shared convolution
  reverb, whose impulse response is rendered, not downloaded. Music and
  ambience have separate dials (the pause sheet's), and the whole thing runs
  through a gentle compressor so two loud chords on one beat do not clip.
  Pausing drops the music behind a lowpass rather than stopping it: a paused
  world that has gone silent reads as a crash.

  Headless-safe: nothing touches `window` until `updateMusic` is called with
  a context available, and the offline renderer takes any
  BaseAudioContext, which is how a probe renders a piece to a file.
*/

import { sharedAudio } from '../core/sfx'
import { createAmbience, type Ambience } from './ambience'
import { renderImpulse } from './ambienceVoices'
import { compose, type Performance } from './composer'
import { instrumentsReady, isPitched, loadInstruments, playHit, playNote } from './sampler'
import { PIECES, type Mood } from './score'
import type { HitId, PitchedId } from './samples'

export type { Mood } from './score'

/** [level, pan, reverb send] per instrument. The recordings are all matched
    to one loudness on the attack, so these are the orchestration's balance,
    measured at the bus rather than guessed (see scripts/music-render.mjs) */
const STRIP: Record<PitchedId | HitId, [number, number, number]> = {
  piano: [0.85, -0.08, 0.3],
  harp: [0.7, 0.3, 0.38],
  glock: [0.4, 0.25, 0.45],
  kalimba: [0.75, 0.12, 0.32],
  flute: [0.72, 0.05, 0.36],
  ocarina: [0.7, -0.05, 0.34],
  clarinet: [0.68, -0.18, 0.34],
  oboe: [0.62, 0.15, 0.34],
  bassoon: [0.75, -0.22, 0.22],
  vlnPizz: [0.6, 0.35, 0.28],
  celloPizz: [0.85, -0.25, 0.25],
  violins: [0.5, 0.32, 0.45],
  violas: [0.5, -0.12, 0.45],
  celli: [0.6, -0.3, 0.4],
  horn: [0.55, -0.2, 0.5],
  vibes: [0.62, 0.2, 0.4],
  marimba: [0.7, -0.05, 0.28],
  chimes: [0.55, 0, 0.55],
  shaker: [0.4, 0.38, 0.18],
  wood: [0.42, -0.32, 0.22],
  triangle: [0.3, 0.42, 0.45],
  timpani: [0.55, 0, 0.4],
}

/** the whole band's trim under the pause sheet's dial (1 = the dial's 100%) */
const MUSIC_GAIN = 0.55
const AMBIENCE_GAIN = 1

const FAMILY: Record<Mood, string> = {
  home: 'home', field: 'land', town: 'land', night: 'land', sea: 'sea', sky: 'sky', orbit: 'orbit',
}

export interface MusicInput {
  level: string
  indoor: number
  day: number
  night: number
  twilight: number
  biome: string | null
  alt: number
  /** how much of the air is below you (levels/space.ts) */
  space: number
  /** 'car' | 'boat' | 'heli' | 'ship' while in one */
  vehicle: string | null
  /** 0..1, open water around the player */
  shore: number
  underwater: boolean
  paused: boolean
  /** the pause sheet's dials, 0..2 */
  musicVol: number
  ambVol: number
  /** 0..1, something else in the room is playing (the television) */
  duck: number
}

/** which piece the moment calls for; null is silence (the backrooms have
    their own hum and deserve it) */
export function moodFor(i: MusicInput): Mood | null {
  if (i.level === 'backrooms') return null
  if (i.level === 'moon' || i.space > 0.35) return 'orbit'
  if (i.vehicle === 'heli' || i.vehicle === 'ship' || i.alt > 45) return 'sky'
  if (i.vehicle === 'boat' || (i.shore > 0.65 && (i.biome === 'ocean' || i.biome === 'beach'))) return 'sea'
  if (i.indoor > 0.5) return 'home'
  if (i.night > 0.6) return 'night'
  if (i.biome === 'town') return 'town'
  return 'field'
}

/* ------------------------------------------------------------ mixer -- */

interface Mixer {
  ctx: BaseAudioContext
  /** where every performance's bus lands: dry and into the reverb */
  musicIn: AudioNode
  reverbIn: AudioNode
  musicFilter: BiquadFilterNode
  musicGain: GainNode
  ambGain: GainNode
  out: AudioNode
}

const buildMixer = (ctx: BaseAudioContext, dest: AudioNode): Mixer => {
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -16
  comp.knee.value = 12
  comp.ratio.value = 3
  comp.attack.value = 0.01
  comp.release.value = 0.25
  comp.connect(dest)
  const musicGain = ctx.createGain()
  musicGain.gain.value = 0
  const musicFilter = ctx.createBiquadFilter()
  musicFilter.type = 'lowpass'
  musicFilter.frequency.value = 20000
  musicFilter.Q.value = 0.4
  musicFilter.connect(musicGain).connect(comp)
  const musicIn = ctx.createGain()
  musicIn.connect(musicFilter)
  const conv = ctx.createConvolver()
  const ir = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 2.8), ctx.sampleRate)
  ir.getChannelData(0).set(renderImpulse(ctx.sampleRate, 2.8, 0x51a7))
  ir.getChannelData(1).set(renderImpulse(ctx.sampleRate, 2.8, 0x9e3b))
  conv.buffer = ir
  const wet = ctx.createGain()
  wet.gain.value = 0.55
  const reverbIn = ctx.createGain()
  reverbIn.connect(conv).connect(wet).connect(musicFilter)
  const ambGain = ctx.createGain()
  ambGain.gain.value = 0
  ambGain.connect(comp)
  return { ctx, musicIn, reverbIn, musicFilter, musicGain, ambGain, out: comp }
}

/* --------------------------------------------------------- performer -- */

interface Live {
  perf: Performance
  bus: GainNode
  strips: Map<string, AudioNode>
  /** context time of beat 0 */
  t0: number
  next: number
  /** context time the last note has rung out by */
  end: number
}

const LOOKAHEAD = 0.6

const startLive = (mx: Mixer, perf: Performance, at: number): Live => {
  const { ctx } = mx
  const bus = ctx.createGain()
  bus.gain.value = 1
  const strips = new Map<string, AudioNode>()
  for (const id of perf.instruments) {
    const [level, pan, send] = STRIP[id]
    const g = ctx.createGain()
    g.gain.value = level
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    const s = ctx.createGain()
    s.gain.value = send
    g.connect(p).connect(bus)
    p.connect(s).connect(mx.reverbIn)
    strips.set(id, g)
  }
  bus.connect(mx.musicIn)
  return { perf, bus, strips, t0: at, next: 0, end: at + perf.beats * perf.spb + 6 }
}

/** schedule every note starting before `until` */
const pump = (mx: Mixer, live: Live, until: number) => {
  const { perf } = live
  const ev = perf.events
  while (live.next < ev.length) {
    const e = ev[live.next]
    const when = live.t0 + e.t * perf.spb
    if (when > until) break
    live.next++
    const dest = live.strips.get(e.inst)
    if (!dest) continue
    // a player, not a sequencer: a few milliseconds early or late, a few
    // percent louder or softer, and melodies sitting fractionally behind
    // the beat the way a relaxed player's do
    const jitter = (Math.random() - 0.5) * 0.016 + (e.lead ? 0.008 : 0)
    const t = Math.max(mx.ctx.currentTime, when + jitter)
    const vel = Math.min(1, e.vel * (0.93 + Math.random() * 0.14))
    if (e.hit) playHit(mx.ctx, dest, e.inst as HitId, e.midi, t, vel)
    else if (isPitched(e.inst)) {
      // a lead note leans into the next one: winds slur, they do not stop
      const d = (e.d + (e.lead ? 0.08 : 0)) * perf.spb
      playNote(mx.ctx, dest, e.inst, e.midi, t, { dur: d, vel, swell: e.inst === 'violins' || e.inst === 'violas' ? 0.35 : undefined })
    }
  }
}

const retire = (live: Live, at: number, fade: number) => {
  live.bus.gain.setTargetAtTime(0, at, fade / 4)
  live.next = live.perf.events.length
  const bus = live.bus
  setTimeout(() => bus.disconnect(), (fade * 1.6 + 1) * 1000)
}

/* --------------------------------------------------------- conductor -- */

let mx: Mixer | null = null
let amb: Ambience | null = null
let live: Live | null = null
let fading: Live | null = null
/** context time the next piece may start (the rest between pieces) */
let restUntil = 0
let loading: { perf: Performance; since: number } | null = null
let heard: Mood | null = null
let heardSince = 0
let moodNow: Mood | null = null
let lastFamily: string | null = null
let forced: Mood | null | 'off' = null
let ducking = 0

const rand = Math.random

const clock = () => mx?.ctx.currentTime ?? 0

/**
  Advance the soundtrack by a frame. Cheap when nothing changes: a few
  compares, a scheduled note or two, and five gain targets.
*/
export function updateMusic(inp: MusicInput, dt: number): void {
  // this runs inside the walk's frame; a soundtrack is never worth a frame
  // loop, so a fault here silences the music and leaves the game alone
  if (broken) return
  try {
    conduct(inp, dt)
  } catch (e) {
    broken = true
    console.error('music stopped:', e)
    try {
      stopMusic()
    } catch {
      /* already down */
    }
  }
}

let broken = false

const conduct = (inp: MusicInput, dt: number) => {
  if (!mx) {
    const ctx = sharedAudio()
    if (!ctx) return
    mx = buildMixer(ctx, ctx.destination)
    amb = createAmbience(ctx, mx.ambGain)
    restUntil = ctx.currentTime + 2.5
  }
  const ctx = mx.ctx
  const now = ctx.currentTime

  // the dials, the pause and the television
  ducking += (inp.duck - ducking) * Math.min(1, dt * 2)
  const vol = inp.musicVol * MUSIC_GAIN * (inp.paused ? 0.55 : 1) * (1 - 0.85 * ducking)
  mx.musicGain.gain.setTargetAtTime(vol, now, 0.25)
  mx.musicFilter.frequency.setTargetAtTime(inp.paused ? 900 : inp.underwater ? 1600 : 20000, now, 0.2)
  mx.ambGain.gain.setTargetAtTime(inp.ambVol * AMBIENCE_GAIN * (inp.paused ? 0.5 : 1), now, 0.25)
  amb?.update(inp, dt)

  // what the moment calls for, once it has held long enough to mean it
  const want = forced === 'off' ? null : forced ?? moodFor(inp)
  if (want !== heard) {
    heard = want
    heardSince = now
  }
  const family = want ? FAMILY[want] : null
  const hold = family !== (moodNow ? FAMILY[moodNow] : null) ? 2.5 : 8
  if (now - heardSince >= hold || forced !== null) moodNow = want

  // a change of family interrupts; within one the piece plays out
  const liveFamily = live ? FAMILY[live.perf.mood] : null
  if (live && (moodNow === null || FAMILY[moodNow] !== liveFamily)) {
    retire(live, now, 4)
    fading = live
    live = null
    restUntil = now + (moodNow ? 3 : 0)
  }
  if (loading && (moodNow === null || FAMILY[loading.perf.mood] !== FAMILY[moodNow])) loading = null

  if (live) {
    pump(mx, live, now + LOOKAHEAD)
    if (now > live.end) {
      live.bus.disconnect()
      live = null
      // the quiet between pieces: most of a minute, give or take
      restUntil = now + 30 + rand() * 50
    }
  } else if (moodNow) {
    // an arrival somewhere new is worth cutting a rest short for
    const fam = FAMILY[moodNow]
    if (fam !== lastFamily && lastFamily !== null) restUntil = Math.min(restUntil, now + 3)
    if (!loading && now > restUntil - 8) {
      const perf = compose(PIECES[moodNow], rand)
      loading = { perf, since: now }
      void loadInstruments(ctx, perf.instruments)
    }
    if (loading && now >= restUntil && (instrumentsReady(ctx, loading.perf.instruments) || now - loading.since > 20)) {
      live = startLive(mx, loading.perf, now + 0.15)
      lastFamily = FAMILY[loading.perf.mood]
      loading = null
      pump(mx, live, now + LOOKAHEAD)
    }
  }
  if (fading && now > fading.end) fading = null
}

/** leave the walk: everything fades out within a couple of seconds */
export function stopMusic(): void {
  if (!mx) return
  const now = mx.ctx.currentTime
  if (live) retire(live, now, 1.5)
  live = null
  loading = null
  amb?.hush()
  mx.musicGain.gain.setTargetAtTime(0, now, 0.4)
  mx.ambGain.gain.setTargetAtTime(0, now, 0.4)
  // sitting back down and standing up again starts a fresh set
  restUntil = now + 2.5
  heard = null
  moodNow = null
  lastFamily = null
}

/** for the console: what is playing, and what the conductor would pick */
export function musicNow(): { playing: string | null; mood: Mood | null; resting: number; loading: boolean } {
  const now = clock()
  return {
    playing: live ? `${live.perf.title} (${live.perf.mood}, ${live.perf.form})` : null,
    mood: moodNow,
    resting: live ? 0 : Math.max(0, restUntil - now),
    loading: !!loading,
  }
}

/** the console's lever: pin a mood, 'off' for silence, 'next' to skip the
    rest (or the rest of this piece), null to hand it back to the world */
export function forceMusic(m: Mood | 'off' | 'next' | null): void {
  if (m !== null && m !== 'off' && m !== 'next' && !(m in PIECES)) m = null
  const now = clock()
  if (m === 'next') {
    if (live && mx) {
      retire(live, now, 2)
      live = null
      restUntil = now + 2.5
    } else restUntil = now
    return
  }
  forced = m
  if (live && mx && (m === 'off' || (m && m !== live.perf.mood))) {
    retire(live, now, 2)
    live = null
    restUntil = now + 2.5
  }
  if (m && m !== 'off') restUntil = Math.min(restUntil, now + 2.5)
}

/** the probe's door: arrange a piece and render it into an offline context.
    Resolves with the rendered buffer; nothing here touches the live mixer */
export async function renderPiece(mood: Mood, seconds: number, seed = 1): Promise<AudioBuffer> {
  let s = seed >>> 0 || 1
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
  const perf = compose(PIECES[mood], r)
  const len = Math.min(seconds, perf.beats * perf.spb + 6)
  const ctx = new OfflineAudioContext(2, Math.ceil(44100 * len), 44100)
  const m = buildMixer(ctx, ctx.destination)
  m.musicGain.gain.value = MUSIC_GAIN
  await loadInstruments(ctx, perf.instruments)
  const l = startLive(m, perf, 0.05)
  pump(m, l, len)
  return ctx.startRendering()
}

export { compose } from './composer'
export { PIECES } from './score'
