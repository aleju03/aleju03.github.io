import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MusicNotesIcon, PlayIcon } from '@phosphor-icons/react'
import { sounds } from '../sounds'
import { GameShell, Led, XP_BTN, XP_WELL } from './ui'
import { formatScore, localBest, useArcade, useLeaderboard } from './arcade'
import type { GameId } from './arcade'

/*
  Rhythm Keys, the Games folder's four-lane note game. Everything is
  synthesized inside this file: three fixed tracks whose note patterns come
  from a seeded generator (every visitor plays the exact same notes, so the
  boards stay fair), a WebAudio backing band fed by a lookahead scheduler,
  and melody keysounds that only ring out when the player actually hits a
  note, the way the 2000s arcade machines wired it. A full clean run plays
  the complete song. The judgment clock is the AudioContext itself, so the
  audio and the timing can never drift apart.
*/

// ---------------------------------------------------------------- tuning

/** judgment windows in seconds, symmetric around each note */
const PERFECT = 0.045
const GREAT = 0.09

const LANE_KEYS = ['D', 'F', 'J', 'K']
const LANE_CODE: Record<string, number | undefined> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 }

const SPEEDS = { slow: 280, normal: 400, fast: 540 } as const
type SpeedId = keyof typeof SPEEDS
const SPEED_IDS = ['slow', 'normal', 'fast'] as const
const SPEED_KEY = 'alejos-vsrg-speed'

function readSpeed(): SpeedId {
  try {
    const s = localStorage.getItem(SPEED_KEY)
    if (s === 'slow' || s === 'normal' || s === 'fast') return s
  } catch {
    /* storage unavailable, fall through to the default */
  }
  return 'normal'
}

function storeSpeed(s: SpeedId) {
  try {
    localStorage.setItem(SPEED_KEY, s)
  } catch {
    /* fine without persistence */
  }
}

// ---------------------------------------------------------------- prng

/** mulberry32: tiny, fast, and identical on every machine for a given seed */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- music theory

/** natural minor, the whole game lives in one key per track */
const SCALE = [0, 2, 3, 5, 7, 8, 10]

/** the i - VI - III - VII loop, one chord per bar, endlessly cycling */
const PROG = [
  { semis: 0, minor: true },
  { semis: 8, minor: false },
  { semis: 3, minor: false },
  { semis: 10, minor: false },
]

/** scale degree of each chord root, used to anchor the melody per bar */
const CHORD_ROOT_DEG = [0, 5, 2, 6]

function midiToFreq(m: number): number {
  return 440 * 2 ** ((m - 69) / 12)
}

function degreeToMidi(root: number, deg: number): number {
  return root + 12 * Math.floor(deg / 7) + SCALE[((deg % 7) + 7) % 7]
}

// ---------------------------------------------------------------- tracks

type Archetype = 'rest' | 'calm' | 'stairs' | 'burst' | 'chords' | 'stream' | 'jacks'

interface TrackDef {
  id: GameId
  label: string
  blurb: string
  stars: number
  bpm: number
  bars: number
  /** fixed literal seed so the chart is identical for everyone */
  seed: number
  /** midi note of the scale root, the bottom of the melody's range */
  root: number
  /** how full the plain eighth-note bars are */
  calmDensity: number
  /** whether stair patterns may run on sixteenths */
  sixteenthStairs: boolean
  weights: [Archetype, number][]
}

const TRACKS: TrackDef[] = [
  {
    id: 'vsrg-boot',
    label: 'Boot',
    blurb: 'steady and warm, with room to breathe',
    stars: 1,
    bpm: 90,
    bars: 22,
    seed: 0xb001,
    root: 57,
    calmDensity: 0.7,
    sixteenthStairs: false,
    weights: [
      ['calm', 6],
      ['stairs', 2],
      ['rest', 2],
    ],
  },
  {
    id: 'vsrg-dialup',
    label: 'Dial-Up',
    blurb: 'quick bursts over a rolling beat',
    stars: 2,
    bpm: 120,
    bars: 37,
    seed: 0xd1a1,
    root: 52,
    calmDensity: 0.75,
    sixteenthStairs: false,
    weights: [
      ['calm', 3],
      ['burst', 4],
      ['stairs', 2],
      ['chords', 2],
      ['rest', 1],
    ],
  },
  {
    id: 'vsrg-overclock',
    label: 'Overclock',
    blurb: 'runs hot, dense and relentless',
    stars: 3,
    bpm: 150,
    bars: 56,
    seed: 0x0c8a,
    root: 50,
    calmDensity: 0.8,
    sixteenthStairs: true,
    weights: [
      ['stream', 5],
      ['stairs', 3],
      ['chords', 3],
      ['burst', 2],
      ['jacks', 2],
      ['rest', 1],
    ],
  },
]

function trackSeconds(track: TrackDef): number {
  return (track.bars * 4 * 60) / track.bpm
}

function fmtDur(track: TrackDef): string {
  const s = Math.round(trackSeconds(track))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------- chart generation

interface ChartNote {
  /** seconds from song start */
  t: number
  lane: number
  /** the melody pitch this note plays when hit */
  midi: number
}

/*
  charts are built bar by bar. each bar of 16 sixteenths gets a pattern
  archetype drawn from the track's weights, and the melody walks a contour
  (mostly steps to neighboring scale degrees) whose direction also drags the
  lane choice, so runs feel like runs instead of white noise. every bar
  starts by re-anchoring the melody on the current chord's root, which keeps
  the keysounds agreeing with the backing band.
*/
function generateChart(track: TrackDef): ChartNote[] {
  const rand = mulberry32(track.seed)
  const spb = 60 / track.bpm
  const sixteenth = spb / 4
  // same-lane spacing: an eighth apart normally, a sixteenth inside a jack
  const minGap = spb / 2 - 1e-4
  const jackGap = spb / 4 - 1e-4
  const laneLast = [-Infinity, -Infinity, -Infinity, -Infinity]
  const notes: ChartNote[] = []
  let degree = 7
  let lane = 1

  const totalWeight = track.weights.reduce((sum, [, w]) => sum + w, 0)
  const pickArchetype = (): Archetype => {
    let r = rand() * totalWeight
    for (const [a, w] of track.weights) {
      r -= w
      if (r <= 0) return a
    }
    return track.weights[0][0]
  }

  const emit = (t: number, l: number, midi: number) => {
    notes.push({ t, lane: l, midi })
    laneLast[l] = t
  }

  const pickLane = (t: number, want: number, gap: number): number => {
    const cands = [0, 1, 2, 3]
      .map((l) => ({ l, d: Math.abs(l - want) + rand() * 0.4 }))
      .sort((a, b) => a.d - b.d)
    for (const c of cands) {
      if (t - laneLast[c.l] >= gap) return c.l
    }
    return -1
  }

  const stepDegree = (): number => {
    const r = rand()
    const delta =
      r < 0.3 ? -1 : r < 0.6 ? 1 : r < 0.72 ? -2 : r < 0.84 ? 2 : r < 0.92 ? 0 : r < 0.96 ? 3 : -3
    degree = Math.max(0, Math.min(13, degree + delta))
    return delta
  }

  // one melodic note: walk the contour, drift the lane the same direction
  const contourNote = (t: number): ChartNote | null => {
    const delta = stepDegree()
    let want = lane + Math.sign(delta)
    if (delta === 0 && rand() < 0.5) want = lane + (rand() < 0.5 ? 1 : -1)
    if (Math.abs(delta) >= 2 && rand() < 0.45) want += Math.sign(delta)
    // reflect off the walls instead of clamping so we never camp an edge
    if (want < 0) want = -want - 1
    if (want > 3) want = 7 - want
    const l = pickLane(t, Math.max(0, Math.min(3, want)), minGap)
    if (l < 0) return null
    lane = l
    emit(t, l, degreeToMidi(track.root, degree))
    return notes[notes.length - 1]
  }

  // a second note under the melody, preferring the other hand for comfort
  const addChordTone = (t: number, mel: ChartNote, chordIdx: number) => {
    const pref = mel.lane <= 1 ? [2, 3, mel.lane === 0 ? 1 : 0] : [1, 0, mel.lane === 2 ? 3 : 2]
    let pick = -1
    for (const c of pref) {
      if (t - laneLast[c] >= minGap) {
        pick = c
        break
      }
    }
    if (pick < 0) return
    let midi = track.root + PROG[chordIdx].semis
    while (midi >= mel.midi) midi -= 12
    while (midi < track.root - 12) midi += 12
    if (midi >= mel.midi) return
    emit(t, pick, midi)
  }

  for (let bar = 0; bar < track.bars; bar++) {
    const barT = bar * 4 * spb
    const chordIdx = bar % 4

    // land each bar on its chord so the hit melody agrees with the backing
    const anchor = CHORD_ROOT_DEG[chordIdx]
    degree = Math.abs(anchor - degree) <= Math.abs(anchor + 7 - degree) ? anchor : anchor + 7

    if (bar === track.bars - 1) {
      // resolve home on a single closing note
      degree = degree >= 4 ? 7 : 0
      const l = pickLane(barT, lane, minGap)
      if (l >= 0) emit(barT, l, degreeToMidi(track.root, degree))
      continue
    }

    const arch: Archetype = bar === 0 ? 'rest' : pickArchetype()

    switch (arch) {
      case 'rest': {
        contourNote(barT)
        if (rand() < 0.6) contourNote(barT + 8 * sixteenth)
        break
      }
      case 'calm': {
        for (let p = 0; p < 16; p += 2) {
          if (p !== 0 && rand() > track.calmDensity) continue
          contourNote(barT + p * sixteenth)
        }
        break
      }
      case 'stairs': {
        const stepN = track.sixteenthStairs && rand() < 0.7 ? 1 : 2
        let dir = rand() < 0.5 ? 1 : -1
        let l = dir > 0 ? 0 : 3
        for (let p = 0; p < 16; p += stepN) {
          const t = barT + p * sixteenth
          degree = Math.max(0, Math.min(13, degree + dir))
          if (t - laneLast[l] >= minGap) {
            emit(t, l, degreeToMidi(track.root, degree))
            lane = l
          }
          l += dir
          if (l > 3) {
            l = 2
            dir = -1
          } else if (l < 0) {
            l = 1
            dir = 1
          }
        }
        break
      }
      case 'burst': {
        const burstAt = 4 + 2 * Math.floor(rand() * 5)
        for (let p = 0; p < 16; p++) {
          const t = barT + p * sixteenth
          if (p >= burstAt && p < burstAt + 4) {
            contourNote(t)
            continue
          }
          if (p % 2 !== 0) continue
          if (p !== 0 && rand() > 0.65) continue
          contourNote(t)
        }
        break
      }
      case 'chords': {
        const every = track.stars >= 3 ? 4 : 8
        for (let p = 0; p < 16; p += 2) {
          const t = barT + p * sixteenth
          if (p % every === 0) {
            const mel = contourNote(t)
            if (mel) addChordTone(t, mel, chordIdx)
          } else if (rand() < 0.45) {
            contourNote(t)
          }
        }
        break
      }
      case 'stream': {
        for (let p = 0; p < 16; p++) {
          // tiny gaps off the downbeats so the stream can breathe
          if (p % 4 !== 0 && rand() < 0.12) continue
          contourNote(barT + p * sixteenth)
        }
        break
      }
      case 'jacks': {
        let prevJack = -1
        for (const p of [0, 4, 8, 12]) {
          const t = barT + p * sixteenth
          const cands = [0, 1, 2, 3].filter((l) => l !== prevJack && t - laneLast[l] >= minGap)
          if (cands.length > 0) {
            const l = cands[Math.floor(rand() * cands.length)]
            stepDegree()
            // a jack repeats its pitch too, one key hammering one sound
            const midi = degreeToMidi(track.root, degree)
            emit(t, l, midi)
            const t2 = t + sixteenth
            if (t2 - laneLast[l] >= jackGap) emit(t2, l, midi)
            lane = l
            prevJack = l
          }
          if (rand() < 0.4) contourNote(t + 2 * sixteenth)
        }
        break
      }
    }
  }

  notes.sort((a, b) => a.t - b.t || a.lane - b.lane)
  return notes
}

// ---------------------------------------------------------------- audio engine

interface BackingEvent {
  t: number
  kind: 'tick' | 'kick' | 'hat' | 'bass' | 'pad'
  midi?: number
  chord?: number
}

function buildBacking(track: TrackDef): BackingEvent[] {
  const spb = 60 / track.bpm
  const events: BackingEvent[] = []
  // count-in ticks land on the three beats before the song
  for (let k = 3; k >= 1; k--) {
    events.push({ t: -k * spb, kind: 'tick', midi: track.root + 24 + (k === 1 ? 7 : 0) })
  }
  let bassRoot = track.root - 24
  while (bassRoot < 31) bassRoot += 12
  for (let bar = 0; bar < track.bars; bar++) {
    const barT = bar * 4 * spb
    const chord = bar % 4
    events.push({ t: barT, kind: 'pad', chord })
    for (let b = 0; b < 4; b++) {
      const t = barT + b * spb
      events.push({ t, kind: 'kick' })
      events.push({ t: t + spb / 2, kind: 'hat' })
      events.push({ t, kind: 'bass', midi: bassRoot + PROG[chord].semis + (b === 3 ? 7 : 0) })
    }
  }
  // one last downbeat so the song lands instead of just stopping
  const endT = track.bars * 4 * spb
  events.push({ t: endT, kind: 'kick' })
  events.push({ t: endT, kind: 'pad', chord: 0 })
  events.push({ t: endT, kind: 'bass', midi: bassRoot })
  events.sort((a, b) => a.t - b.t)
  return events
}

// the game's own AudioContext, separate from the OS chrome sounds. lazy so
// it is only ever created from a user gesture, suspended when the window
// closes, revived when it reopens.
let sharedCtx: AudioContext | null = null

function getAudio(): AudioContext | null {
  try {
    if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext()
    if (sharedCtx.state === 'suspended') void sharedCtx.resume()
    return sharedCtx
  } catch {
    return null
  }
}

function suspendAudio() {
  if (sharedCtx && sharedCtx.state === 'running') void sharedCtx.suspend()
}

/*
  one engine per run. the backing band (kick, hats, bass, pads) is booked
  ahead of time by a lookahead scheduler: a 25ms interval that schedules
  everything inside a 120ms horizon, so tab jank never smears the beat.
  keysounds are different on purpose: they play the moment the player hits,
  which is what makes clean play sound like the finished song.
*/
class SongEngine {
  readonly ctx: AudioContext
  private master: GainNode
  private backing: GainNode
  private keys: GainNode
  private noise: AudioBuffer
  private events: BackingEvent[] = []
  private next = 0
  private timer = 0
  private padDur = 1
  private root = 57
  private songStart = 0

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    // a gentle compressor keeps chords from spiking above the OS's voice
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.knee.value = 24
    comp.ratio.value = 4
    comp.connect(ctx.destination)
    this.master = ctx.createGain()
    this.master.gain.value = 0.5
    this.master.connect(comp)
    this.backing = ctx.createGain()
    this.backing.connect(this.master)
    this.keys = ctx.createGain()
    this.keys.connect(this.master)
    // one short white-noise buffer feeds every hi-hat
    const len = Math.floor(ctx.sampleRate * 0.06)
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  }

  start(track: TrackDef) {
    const spb = 60 / track.bpm
    this.events = buildBacking(track)
    this.next = 0
    this.padDur = spb * 4
    this.root = track.root
    // the song begins exactly three beats after the anchor, one per count
    this.songStart = this.ctx.currentTime + 0.12 + 3 * spb
    this.timer = window.setInterval(() => this.pump(), 25)
    this.pump()
  }

  /** song time in seconds, negative during the count-in. this is the clock */
  now(): number {
    return this.ctx.currentTime - this.songStart
  }

  private pump() {
    const horizon = this.ctx.currentTime + 0.12
    while (this.next < this.events.length) {
      const ev = this.events[this.next]
      const at = this.songStart + ev.t
      if (at > horizon) break
      this.next += 1
      switch (ev.kind) {
        case 'tick':
          this.voice({ freq: midiToFreq(ev.midi ?? 81), at, dur: 0.09, type: 'sine', peak: 0.07 })
          break
        case 'kick':
          this.voice({ freq: 150, to: 50, at, dur: 0.13, type: 'sine', peak: 0.3, attack: 0.004 })
          break
        case 'hat':
          this.hat(at)
          break
        case 'bass':
          this.voice({
            freq: midiToFreq(ev.midi ?? 45),
            at,
            dur: 0.32,
            type: 'triangle',
            peak: 0.1,
          })
          break
        case 'pad':
          this.pad(ev.chord ?? 0, at)
          break
      }
    }
  }

  /** the keysound: fires the moment a note is judged as hit, never before */
  hit(midi: number) {
    const at = this.ctx.currentTime
    const f = midiToFreq(midi)
    this.voice({
      freq: f,
      at,
      dur: 0.34,
      type: 'triangle',
      peak: 0.16,
      attack: 0.004,
      dest: this.keys,
    })
    this.voice({
      freq: f * 2,
      at,
      dur: 0.14,
      type: 'square',
      peak: 0.025,
      attack: 0.004,
      dest: this.keys,
    })
  }

  /** stop scheduling and fade out; safe to call more than once */
  stop(release = 0.08) {
    window.clearInterval(this.timer)
    const master = this.master
    master.gain.setTargetAtTime(0, this.ctx.currentTime, release)
    window.setTimeout(() => master.disconnect(), 400 + release * 3000)
  }

  private voice(v: {
    freq: number
    at: number
    dur: number
    type: OscillatorType
    peak: number
    to?: number
    attack?: number
    dest?: GainNode
  }) {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = v.type
    osc.frequency.setValueAtTime(v.freq, v.at)
    if (v.to !== undefined) osc.frequency.exponentialRampToValueAtTime(v.to, v.at + v.dur)
    g.gain.setValueAtTime(0, v.at)
    g.gain.linearRampToValueAtTime(v.peak, v.at + (v.attack ?? 0.008))
    g.gain.exponentialRampToValueAtTime(0.0008, v.at + v.dur)
    osc.connect(g).connect(v.dest ?? this.backing)
    osc.start(v.at)
    osc.stop(v.at + v.dur + 0.05)
  }

  private hat(at: number) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const hp = this.ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 6500
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.055, at)
    g.gain.exponentialRampToValueAtTime(0.0008, at + 0.04)
    src.connect(hp).connect(g).connect(this.backing)
    src.start(at)
    src.stop(at + 0.06)
  }

  private pad(chordIdx: number, at: number) {
    const c = PROG[chordIdx]
    const base = this.root - 12 + c.semis
    const intervals = c.minor ? [0, 3, 7] : [0, 4, 7]
    for (let i = 0; i < intervals.length; i++) {
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = midiToFreq(base + intervals[i])
      // a few cents of detune keeps the pad from sounding like a test tone
      osc.detune.value = (i - 1) * 5
      const dur = this.padDur
      g.gain.setValueAtTime(0.0001, at)
      g.gain.linearRampToValueAtTime(0.02, at + 0.35)
      g.gain.setValueAtTime(0.02, at + dur - 0.3)
      g.gain.linearRampToValueAtTime(0.0001, at + dur)
      osc.connect(g).connect(this.backing)
      osc.start(at)
      osc.stop(at + dur + 0.05)
    }
  }
}

// ---------------------------------------------------------------- judgment

/** 0 pending, 1 perfect, 2 great, 3 miss */
type NoteState = 0 | 1 | 2 | 3

interface RunNote extends ChartNote {
  state: NoteState
}

interface Run {
  notes: RunNote[]
  /** per-lane note indices in time order, with a head pointer per lane */
  laneNotes: number[][]
  heads: number[]
  duration: number
  beat: number
  keysDown: boolean[]
  flashAt: number[]
  lastJudge: { kind: 1 | 2 | 3; at: number } | null
  errs: { ms: number; at: number }[]
  perfect: number
  great: number
  miss: number
  combo: number
  maxCombo: number
  errSum: number
  hitCount: number
  finished: boolean
}

interface Stats {
  score: number
  combo: number
  acc: number
}

interface RunResult {
  score: number
  acc: number
  maxCombo: number
  perfect: number
  great: number
  miss: number
  meanErr: number | null
  total: number
}

const START_STATS: Stats = { score: 0, combo: 0, acc: 100 }

/** anything more than the great window past due is gone; misses are silent */
function sweepMisses(run: Run, now: number): boolean {
  let missed = false
  for (let l = 0; l < 4; l++) {
    const q = run.laneNotes[l]
    let head = run.heads[l]
    while (head < q.length) {
      const n = run.notes[q[head]]
      if (n.state !== 0) {
        head += 1
        continue
      }
      if (n.t >= now - GREAT) break
      n.state = 3
      run.miss += 1
      run.combo = 0
      run.lastJudge = { kind: 3, at: now }
      missed = true
      head += 1
    }
    run.heads[l] = head
  }
  return missed
}

/** one note per keypress: the nearest pending note in the lane, or nothing */
function judgePress(run: Run, laneIdx: number, now: number): RunNote | null {
  const q = run.laneNotes[laneIdx]
  let best: RunNote | null = null
  let bestAbs = Number.POSITIVE_INFINITY
  for (let i = run.heads[laneIdx]; i < q.length; i++) {
    const n = run.notes[q[i]]
    if (n.state !== 0) continue
    const dt = now - n.t
    if (dt < -GREAT) break
    const abs = Math.abs(dt)
    if (abs < bestAbs) {
      bestAbs = abs
      best = n
    }
  }
  if (!best) return null
  const kind: 1 | 2 = bestAbs <= PERFECT ? 1 : 2
  best.state = kind
  if (kind === 1) run.perfect += 1
  else run.great += 1
  run.combo += 1
  if (run.combo > run.maxCombo) run.maxCombo = run.combo
  const err = (now - best.t) * 1000
  run.errSum += err
  run.hitCount += 1
  run.errs.push({ ms: err, at: now })
  if (run.errs.length > 20) run.errs.shift()
  run.lastJudge = { kind, at: now }
  run.flashAt[laneIdx] = now
  return best
}

function currentStats(run: Run): Stats {
  const judged = run.perfect + run.great + run.miss
  const weighted = run.perfect + run.great * 0.6
  return {
    score: Math.round((1_000_000 * weighted) / run.notes.length),
    combo: run.combo,
    acc: judged === 0 ? 100 : (100 * weighted) / judged,
  }
}

function buildResult(run: Run): RunResult {
  const weighted = run.perfect + run.great * 0.6
  return {
    score: Math.round((1_000_000 * weighted) / run.notes.length),
    acc: (100 * weighted) / run.notes.length,
    maxCombo: run.maxCombo,
    perfect: run.perfect,
    great: run.great,
    miss: run.miss,
    meanErr: run.hitCount > 0 ? run.errSum / run.hitCount : null,
    total: run.notes.length,
  }
}

// ---------------------------------------------------------------- painting

function drawNote(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  laneIdx: number,
) {
  // the classic scheme: stone-white outside, xp blue inside
  const inner = laneIdx === 1 || laneIdx === 2
  const grad = g.createLinearGradient(0, y, 0, y + h)
  if (inner) {
    grad.addColorStop(0, '#8db8f8')
    grad.addColorStop(0.45, '#3a72d4')
    grad.addColorStop(1, '#26509f')
  } else {
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(0.45, '#dbd8d3')
    grad.addColorStop(1, '#b6b1aa')
  }
  g.fillStyle = grad
  g.beginPath()
  g.roundRect(x, y, w, h, 3)
  g.fill()
  g.fillStyle = 'rgba(255,255,255,0.45)'
  g.beginPath()
  g.roundRect(x + 2, y + 1.5, w - 4, 3.5, 1.75)
  g.fill()
}

function drawReceptor(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  letter: string,
  pressed: boolean,
) {
  const grad = g.createLinearGradient(0, y, 0, y + h)
  if (pressed) {
    grad.addColorStop(0, '#9ec5fa')
    grad.addColorStop(1, '#3d74d8')
  } else {
    grad.addColorStop(0, '#3b64b4')
    grad.addColorStop(1, '#23408a')
  }
  g.fillStyle = grad
  g.beginPath()
  g.roundRect(x, y, w, h, 4)
  g.fill()
  g.strokeStyle = 'rgba(0,0,0,0.5)'
  g.lineWidth = 1
  g.stroke()
  // the xp bevel: a bright lip along the top edge
  g.fillStyle = pressed ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)'
  g.fillRect(x + 3, y + 2, w - 6, 2)
  g.fillStyle = pressed ? '#1e3a8a' : 'rgba(255,255,255,0.85)'
  g.font = 'bold 12px ui-monospace, monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(letter, x + w / 2, y + h / 2 + 1)
}

function drawFrame(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  run: Run,
  now: number,
  pxPerSec: number,
) {
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.fillStyle = '#101014'
  g.fillRect(0, 0, w, h)

  const laneW = Math.min(78, Math.floor((w - 40) / 4))
  const fieldW = laneW * 4
  const x0 = Math.round((w - fieldW) / 2)
  const receptorY = h - 78
  const noteH = 13

  // the playfield well and its lane separators
  g.fillStyle = '#17181d'
  g.fillRect(x0, 0, fieldW, h)
  g.strokeStyle = 'rgba(255,255,255,0.07)'
  g.lineWidth = 1
  for (let l = 0; l <= 4; l++) {
    const x = x0 + l * laneW + 0.5
    g.beginPath()
    g.moveTo(x, 0)
    g.lineTo(x, h)
    g.stroke()
  }

  // faint beat grid scrolling at note speed
  const tTop = now + (receptorY + noteH) / pxPerSec
  const tBottom = now - (h - receptorY) / pxPerSec
  for (let k = Math.ceil(tBottom / run.beat); k * run.beat <= tTop; k++) {
    const bt = k * run.beat
    if (bt < -3 * run.beat || bt > run.duration) continue
    const y = Math.round(receptorY - (bt - now) * pxPerSec)
    g.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)'
    g.fillRect(x0, y, fieldW, 1)
  }

  // lane flashes rising from the receptors on each hit
  for (let l = 0; l < 4; l++) {
    const age = now - run.flashAt[l]
    if (age < 0 || age > 0.18) continue
    const a = 0.3 * (1 - age / 0.18)
    const grad = g.createLinearGradient(0, receptorY, 0, receptorY - 150)
    grad.addColorStop(0, `rgba(147,197,253,${a.toFixed(3)})`)
    grad.addColorStop(1, 'rgba(147,197,253,0)')
    g.fillStyle = grad
    g.fillRect(x0 + l * laneW + 1, receptorY - 150, laneW - 2, 150)
  }

  // the judge line
  g.fillStyle = 'rgba(255,255,255,0.22)'
  g.fillRect(x0, receptorY, fieldW, 1)

  // notes, centered on their moment in time
  for (const n of run.notes) {
    if (n.t > tTop) break
    if (n.state !== 0) continue
    const y = receptorY - (n.t - now) * pxPerSec
    if (y < -noteH || y > h + noteH) continue
    drawNote(g, x0 + n.lane * laneW + 4, y - noteH / 2, laneW - 8, noteH, n.lane)
  }

  for (let l = 0; l < 4; l++) {
    drawReceptor(
      g,
      x0 + l * laneW + 3,
      receptorY - 14,
      laneW - 6,
      28,
      LANE_KEYS[l],
      run.keysDown[l],
    )
  }

  // the last judgment, popping briefly above the receptors
  if (run.lastJudge) {
    const age = now - run.lastJudge.at
    if (age >= 0 && age < 0.55) {
      const kind = run.lastJudge.kind
      const size = Math.round(16 * (1 + 0.25 * Math.exp(-age * 10)))
      g.globalAlpha = 1 - age / 0.55
      g.fillStyle = kind === 1 ? '#fbbf24' : kind === 2 ? '#93c5fd' : '#f87171'
      g.font = `bold ${size}px ui-monospace, monospace`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(kind === 1 ? 'PERFECT' : kind === 2 ? 'GREAT' : 'MISS', w / 2, receptorY - 64)
      g.globalAlpha = 1
    }
  }

  if (run.combo >= 2) {
    g.fillStyle = 'rgba(255,255,255,0.92)'
    g.font = 'bold 30px ui-monospace, monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(String(run.combo), w / 2, h * 0.28)
    g.fillStyle = 'rgba(255,255,255,0.4)'
    g.font = 'bold 10px ui-monospace, monospace'
    g.fillText('combo', w / 2, h * 0.28 + 22)
  }

  // hit-error ticks for the last twenty hits, early left and late right
  const ebW = 150
  const ebY = h - 34
  g.fillStyle = 'rgba(255,255,255,0.1)'
  g.fillRect(w / 2 - ebW / 2, ebY, ebW, 4)
  g.fillStyle = 'rgba(255,255,255,0.5)'
  g.fillRect(w / 2 - 1, ebY - 3, 2, 10)
  for (const e of run.errs) {
    const a = 1 - (now - e.at) / 5
    if (a <= 0) continue
    const x = w / 2 + (e.ms / (GREAT * 1000)) * (ebW / 2)
    g.globalAlpha = Math.min(1, a)
    g.fillStyle = Math.abs(e.ms) <= PERFECT * 1000 ? '#fbbf24' : '#93c5fd'
    g.fillRect(x - 1, ebY - 2, 2, 8)
  }
  g.globalAlpha = 1

  // thin song progress along the top
  const p = Math.max(0, Math.min(1, now / run.duration))
  g.fillStyle = '#3b82f6'
  g.fillRect(x0, 0, fieldW * p, 3)

  // count-in, one number per beat before the song
  if (now < 0) {
    const n = Math.min(3, Math.ceil(-now / run.beat))
    g.fillStyle = 'rgba(255,255,255,0.95)'
    g.font = 'bold 44px ui-monospace, monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(String(n), w / 2, h * 0.4)
    g.fillStyle = 'rgba(255,255,255,0.45)'
    g.font = '12px ui-monospace, monospace'
    g.fillText('get ready', w / 2, h * 0.4 + 34)
  }
}

// ---------------------------------------------------------------- gameplay

interface GameplayProps {
  track: TrackDef
  pxPerSec: number
  onStats: (s: Stats) => void
  onFinish: (r: RunResult) => void
  onQuit: () => void
}

const Gameplay = memo(function Gameplay({
  track,
  pxPerSec,
  onStats,
  onFinish,
  onQuit,
}: GameplayProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const runRef = useRef<Run | null>(null)
  const engineRef = useRef<SongEngine | null>(null)
  const pausedRef = useRef(false)
  const [paused, setPaused] = useState(false)
  const [noAudio, setNoAudio] = useState(false)

  // suspending the context freezes its clock, so a pause costs nothing:
  // judgment, notes and backing all wake up exactly where they stopped
  const doPause = useCallback(() => {
    const run = runRef.current
    const engine = engineRef.current
    if (!run || !engine || run.finished || pausedRef.current) return
    pausedRef.current = true
    run.keysDown.fill(false)
    setPaused(true)
    void engine.ctx.suspend()
  }, [])

  const resume = useCallback(() => {
    sounds.click()
    pausedRef.current = false
    setPaused(false)
    const engine = engineRef.current
    if (engine) void engine.ctx.resume()
    wrapRef.current?.focus()
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    const cv = canvasRef.current
    if (!wrap || !cv) return
    const g = cv.getContext('2d')
    const ac = getAudio()
    if (!g || !ac) {
      setNoAudio(true)
      return
    }

    const chart = generateChart(track)
    const spb = 60 / track.bpm
    const run: Run = {
      notes: chart.map((n) => ({ ...n, state: 0 })),
      laneNotes: [[], [], [], []],
      heads: [0, 0, 0, 0],
      duration: track.bars * 4 * spb,
      beat: spb,
      keysDown: [false, false, false, false],
      flashAt: [-1, -1, -1, -1],
      lastJudge: null,
      errs: [],
      perfect: 0,
      great: 0,
      miss: 0,
      combo: 0,
      maxCombo: 0,
      errSum: 0,
      hitCount: 0,
      finished: false,
    }
    run.notes.forEach((n, i) => run.laneNotes[n.lane].push(i))
    runRef.current = run

    const engine = new SongEngine(ac)
    engineRef.current = engine
    engine.start(track)

    const applySize = () => {
      const rect = wrap.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { w: rect.width, h: rect.height, dpr }
      cv.width = Math.max(1, Math.round(rect.width * dpr))
      cv.height = Math.max(1, Math.round(rect.height * dpr))
    }
    const ro = new ResizeObserver(applySize)
    ro.observe(wrap)
    applySize()

    let raf = 0
    const frame = () => {
      const now = engine.now()
      if (!pausedRef.current && !run.finished) {
        if (sweepMisses(run, now)) onStats(currentStats(run))
        if (now > run.duration + 1.2) {
          run.finished = true
          engine.stop(0.3)
          onFinish(buildResult(run))
          return
        }
      }
      const { w, h, dpr } = sizeRef.current
      if (w > 0 && h > 0) drawFrame(g, w, h, dpr, run, now, pxPerSec)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    wrap.focus()

    const onWinBlur = () => doPause()
    const onVis = () => {
      if (document.hidden) doPause()
    }
    window.addEventListener('blur', onWinBlur)
    document.addEventListener('visibilitychange', onVis)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('blur', onWinBlur)
      document.removeEventListener('visibilitychange', onVis)
      engine.stop()
      engineRef.current = null
      runRef.current = null
      // a run abandoned mid-pause must not leave the context asleep
      if (ac.state === 'suspended') void ac.resume()
    }
  }, [track, pxPerSec, onStats, onFinish, doPause])

  const handleKey = (e: KeyboardEvent<HTMLDivElement>, down: boolean) => {
    const laneIdx = LANE_CODE[e.code]
    if (laneIdx === undefined) return
    e.preventDefault()
    const run = runRef.current
    const engine = engineRef.current
    if (!run || !engine) return
    if (!down) {
      run.keysDown[laneIdx] = false
      return
    }
    if (e.repeat || run.finished || pausedRef.current) return
    run.keysDown[laneIdx] = true
    const now = engine.now()
    sweepMisses(run, now)
    const hit = judgePress(run, laneIdx, now)
    // the melody sounds when the player plays it; misses stay silent
    if (hit) engine.hit(hit.midi)
    onStats(currentStats(run))
  }

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={(e) => handleKey(e, true)}
      onKeyUp={(e) => handleKey(e, false)}
      onClick={() => wrapRef.current?.focus()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) doPause()
      }}
      className="relative h-full cursor-default outline-none"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <button
        type="button"
        onClick={() => {
          sounds.click()
          onQuit()
        }}
        className={`${XP_BTN} absolute top-2 right-2 px-2 py-0.5 text-[11px] font-medium text-stone-700`}
      >
        quit
      </button>
      {paused && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60">
          <p className="text-sm font-semibold text-white">paused</p>
          <button
            type="button"
            onClick={resume}
            className={`${XP_BTN} px-3 py-1 text-xs font-medium text-stone-700`}
          >
            keep playing
          </button>
        </div>
      )}
      {noAudio && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
          <p className="text-xs text-stone-200">
            The game keeps time by sound, and this browser will not start the audio.
          </p>
          <button
            type="button"
            onClick={() => {
              sounds.click()
              onQuit()
            }}
            className={`${XP_BTN} px-3 py-1 text-xs font-medium text-stone-700`}
          >
            back
          </button>
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------- results

const GRADE_COLOR: Record<string, string> = {
  S: 'text-amber-500',
  A: 'text-green-600',
  B: 'text-blue-600',
  C: 'text-stone-500',
  D: 'text-red-500',
}

function Results({
  track,
  result,
  onRetry,
  onSelect,
}: {
  track: TrackDef
  result: RunResult
  onRetry: () => void
  onSelect: () => void
}) {
  const { submit } = useLeaderboard(track.id)
  // decided once on mount, before submit() bumps the stored best
  const [newBest] = useState(() => {
    const prev = localBest(track.id)
    return result.score > 0 && (prev === null || result.score > prev)
  })
  const sent = useRef(false)

  useEffect(() => {
    if (sent.current || result.score <= 0) return
    sent.current = true
    if (newBest) sounds.fanfare()
    void submit(result.score)
  }, [newBest, result.score, submit])

  const grade =
    result.acc >= 95
      ? 'S'
      : result.acc >= 90
        ? 'A'
        : result.acc >= 80
          ? 'B'
          : result.acc >= 70
            ? 'C'
            : 'D'

  const rows: [string, string][] = [
    ['max combo', String(result.maxCombo)],
    ['perfect', String(result.perfect)],
    ['great', String(result.great)],
    ['miss', String(result.miss)],
    [
      'avg timing',
      result.meanErr === null
        ? 'no hits'
        : `${result.meanErr >= 0 ? '+' : ''}${result.meanErr.toFixed(1)} ms`,
    ],
  ]

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
      <p className="text-[11px] text-stone-500">
        {track.label} · {'★'.repeat(track.stars)}
      </p>
      <div className={`text-5xl leading-none font-bold ${GRADE_COLOR[grade]}`}>{grade}</div>
      <Led value={String(result.score).padStart(7, '0')} label="Final score" />
      {newBest && <p className="text-[11px] font-semibold text-amber-600">new personal best</p>}
      <div className={`${XP_WELL} w-60 px-3 py-2`}>
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between py-0.5 text-xs">
            <span className="text-stone-500">{k}</span>
            <span className="font-mono tabular-nums text-stone-800">{v}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onRetry}
          className={`${XP_BTN} px-4 py-1.5 text-xs font-medium text-stone-700`}
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onSelect}
          className={`${XP_BTN} px-4 py-1.5 text-xs font-medium text-stone-700`}
        >
          Track select
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- track select

function TrackSelect({
  speed,
  onSpeed,
  onPlay,
}: {
  speed: SpeedId
  onSpeed: (s: SpeedId) => void
  onPlay: (t: TrackDef) => void
}) {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <p className="text-xs text-stone-500">
        Notes fall down four lanes. Press the matching key as each one reaches the line, and every
        clean hit plays its piece of the melody.
      </p>
      {TRACKS.map((t) => {
        const best = localBest(t.id)
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onPlay(t)}
            className={`${XP_BTN} flex items-center gap-3 px-3 py-2 text-left`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-stone-800">{t.label}</span>
                <span className="text-[11px] tracking-wide text-amber-600">
                  {'★'.repeat(t.stars)}
                </span>
              </div>
              <p className="text-[11px] text-stone-500">{t.blurb}</p>
              <p className="font-mono text-[11px] tabular-nums text-stone-500">
                {t.bpm} bpm · {fmtDur(t)} ·{' '}
                {best !== null ? `best ${formatScore(t.id, best)}` : 'no score yet'}
              </p>
            </div>
            <PlayIcon size={16} weight="fill" className="shrink-0 text-blue-700" />
          </button>
        )
      })}
      <div className="mt-auto flex items-center gap-1.5 pt-1">
        <span className="text-[11px] text-stone-500">scroll speed</span>
        <span className="flex-1" />
        {SPEED_IDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSpeed(s)}
            className={
              s === speed
                ? 'cursor-pointer rounded-sm border border-blue-600 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-800'
                : `${XP_BTN} px-2 py-0.5 text-[11px] text-stone-600`
            }
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- app

type Screen =
  | { kind: 'select' }
  | { kind: 'play'; track: TrackDef; nonce: number }
  | { kind: 'result'; track: TrackDef; result: RunResult }

const TABS = TRACKS.map((t) => ({ id: t.id, label: t.label }))

export function VsrgApp() {
  const { name } = useArcade()
  const [screen, setScreen] = useState<Screen>({ kind: 'select' })
  const [speed, setSpeedState] = useState<SpeedId>(readSpeed)
  const [stats, setStats] = useState<Stats>(START_STATS)

  // the game's context naps when the window closes, ready for next time
  useEffect(() => suspendAudio, [])

  const onStats = useCallback((s: Stats) => setStats(s), [])

  const onFinish = useCallback((result: RunResult) => {
    setScreen((s) => (s.kind === 'play' ? { kind: 'result', track: s.track, result } : s))
  }, [])

  const onQuit = useCallback(() => {
    setScreen({ kind: 'select' })
  }, [])

  const startTrack = (track: TrackDef) => {
    sounds.click()
    setStats(START_STATS)
    setScreen({ kind: 'play', track, nonce: Date.now() })
  }

  const setSpeed = (s: SpeedId) => {
    sounds.click()
    setSpeedState(s)
    storeSpeed(s)
  }

  const header =
    screen.kind === 'play' ? (
      <div className="flex items-center gap-2">
        <Led value={String(stats.score).padStart(7, '0')} label="Score" />
        <Led value={String(stats.combo).padStart(3, '0')} label="Combo" />
        <span className="font-mono text-xs tabular-nums text-stone-600">
          {stats.acc.toFixed(1)}%
        </span>
      </div>
    ) : (
      <div className="flex items-center gap-1.5">
        <MusicNotesIcon size={14} weight="fill" className="text-blue-700" />
        <span className="text-xs font-semibold text-stone-700">Rhythm Keys</span>
      </div>
    )

  return (
    <GameShell tabs={TABS} you={name} header={header} hint="d f j k hit the notes as they land">
      {screen.kind === 'select' && (
        <TrackSelect speed={speed} onSpeed={setSpeed} onPlay={startTrack} />
      )}
      {screen.kind === 'play' && (
        <Gameplay
          key={screen.nonce}
          track={screen.track}
          pxPerSec={SPEEDS[speed]}
          onStats={onStats}
          onFinish={onFinish}
          onQuit={onQuit}
        />
      )}
      {screen.kind === 'result' && (
        <Results
          track={screen.track}
          result={screen.result}
          onRetry={() => startTrack(screen.track)}
          onSelect={() => {
            sounds.click()
            setScreen({ kind: 'select' })
          }}
        />
      )}
    </GameShell>
  )
}
