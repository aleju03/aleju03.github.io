import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MusicNotesIcon, PlayIcon } from '@phosphor-icons/react'
import { sounds } from '../sounds'
import { GameShell, Led, XP_BTN, XP_WELL } from './ui'
import { formatScore, localBest, useArcade, useLeaderboard } from './arcade'
import type { GameId } from './arcade'

/*
  Rhythm Keys, the Games folder's note game. Six real songs with real
  community charts (public/os/games/vsrg, credits in NOTICE.txt): the mp3
  plays through WebAudio and the AudioContext is the judgment clock, so
  audio and timing can never drift apart. Charts were converted from
  osu!mania beatmaps by scripts/osu-chart.py; long notes became taps at
  their head, the game is tap-only on purpose. Long intros are skipped to
  two bars before the first note, and a count-in ticks the player in.

  It plays two key modes, four lanes and seven, and nothing in here is
  written for a particular one: the lane count is the track's, the playfield
  is laid out from it, and the run's per-lane arrays are sized by it. The
  one thing that is genuinely per-mode is the bindings, because four fingers
  and seven fingers do not want the same keys, so each mode keeps its own
  row and its own localStorage entry and the select screen shows whichever
  mode you are browsing.
*/

// ---------------------------------------------------------------- tuning

/** judgment windows in seconds, symmetric around each note */
const PERFECT = 0.045
const GREAT = 0.09

/** the key modes the game ships charts for */
const KEY_MODES = [4, 7] as const
type KeyMode = (typeof KEY_MODES)[number]

/*
  Lane keys are the player's, not mine. Bindings are KeyboardEvent.code —
  physical positions, so a chart plays the same on QWERTY, AZERTY or Dvorak —
  and the labels drawn on the receptors are derived from those codes rather
  than stored alongside them, so the two can never disagree. One row per key
  mode, stored apart: 4K's entry keeps its original name so nobody's existing
  bindings are lost.
*/
const KEYS_KEY: Record<KeyMode, string> = {
  4: 'alejos-vsrg-keys',
  7: 'alejos-vsrg-keys7',
}
const DEFAULT_KEYS: Record<KeyMode, string[]> = {
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  7: ['KeyA', 'KeyS', 'KeyD', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
}

function readKeys(mode: KeyMode): string[] {
  try {
    const raw = localStorage.getItem(KEYS_KEY[mode])
    if (raw) {
      const v: unknown = JSON.parse(raw)
      if (
        Array.isArray(v) &&
        v.length === mode &&
        v.every((c) => typeof c === 'string' && c.length > 0) &&
        new Set(v).size === mode
      ) {
        return v as string[]
      }
    }
  } catch {
    /* unreadable or unavailable — fall back to the defaults */
  }
  return [...DEFAULT_KEYS[mode]]
}

function readAllKeys(): Record<KeyMode, string[]> {
  return { 4: readKeys(4), 7: readKeys(7) }
}

function storeKeys(mode: KeyMode, codes: string[]) {
  try {
    localStorage.setItem(KEYS_KEY[mode], JSON.stringify(codes))
  } catch {
    /* storage unavailable — the binding lasts for this session */
  }
}

/** the key mode the select screen was last browsing */
const MODE_KEY = 'alejos-vsrg-mode'

function readMode(): KeyMode {
  try {
    const v = Number(localStorage.getItem(MODE_KEY))
    if (KEY_MODES.includes(v as KeyMode)) return v as KeyMode
  } catch {
    /* storage unavailable */
  }
  return 4
}

function storeMode(mode: KeyMode) {
  try {
    localStorage.setItem(MODE_KEY, String(mode))
  } catch {
    /* fine without persistence */
  }
}

const NAMED_KEYS: Record<string, string> = {
  Space: 'space',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  ControlLeft: 'ctrl',
  ControlRight: 'ctrl',
  AltLeft: 'alt',
  AltRight: 'alt',
  Tab: 'tab',
  Enter: 'enter',
  ArrowLeft: '\u2190',
  ArrowRight: '\u2192',
  ArrowUp: '\u2191',
  ArrowDown: '\u2193',
}

/** the short label a receptor wears, derived from the bound code */
function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `n${code.slice(6)}`
  return NAMED_KEYS[code] ?? code
}

/** keys that belong to the OS, never to a lane */
const RESERVED_KEYS = new Set(['Escape', 'F5', 'F11', 'F12'])

/**
 * osu!mania style scroll speed, 1..40. speed S means a note travels from
 * the top of the playfield to the judge line in 10/S seconds, so 20 shows
 * a note for half a second and 40 for a quarter
 */
const SPEED_MIN = 1
const SPEED_MAX = 40
const SPEED_DEFAULT = 20
const SPEED_KEY = 'alejos-vsrg-speed'
const SYNC_KEY = 'alejos-vsrg-sync'

function readSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY))
    if (Number.isFinite(v) && v >= SPEED_MIN && v <= SPEED_MAX) return Math.round(v)
  } catch {
    /* storage unavailable, fall through to the default */
  }
  return SPEED_DEFAULT
}

function storeSpeed(v: number) {
  try {
    localStorage.setItem(SPEED_KEY, String(v))
  } catch {
    /* fine without persistence */
  }
}

/** the player's audio sync nudge in ms; positive means notes judge later */
function readSync(): number {
  try {
    const v = Number(localStorage.getItem(SYNC_KEY))
    if (Number.isFinite(v)) return Math.max(-60, Math.min(60, Math.round(v)))
  } catch {
    /* storage unavailable */
  }
  return 0
}

function storeSync(v: number) {
  try {
    localStorage.setItem(SYNC_KEY, String(v))
  } catch {
    /* fine without persistence */
  }
}

// ---------------------------------------------------------------- tracks

interface TrackDef {
  id: GameId
  title: string
  artist: string
  /** the chart's own name and its mapper */
  credit: string
  blurb: string
  stars: number
  /** how many lanes this chart is written for */
  keys: KeyMode
  bpm: number
  seconds: number
  noteCount: number
  dir: string
}

const TRACKS: TrackDef[] = [
  {
    id: 'vsrg-badapple',
    title: 'Bad Apple!!',
    artist: 'Masayoshi Minoshima ft. nomico',
    credit: '[Normal] charted by salodtg',
    blurb: 'the one every rhythm game ends up with sooner or later',
    stars: 1,
    keys: 4,
    bpm: 138,
    seconds: 196,
    noteCount: 456,
    dir: 'badapple',
  },
  {
    id: 'vsrg-madeoffire',
    title: 'Made of Fire',
    artist: 'Niko',
    credit: "[Can't get a comfortable spot for my right hand] by Utiba",
    blurb: 'yes, that is the real difficulty name',
    stars: 2,
    keys: 4,
    bpm: 163,
    seconds: 78,
    noteCount: 928,
    dir: 'madeoffire',
  },
  {
    id: 'vsrg-freedomdive',
    title: 'FREEDOM DiVE',
    artist: 'xi',
    credit: "[C.Star's 4K Hyper] from Kuo Kyoka's set",
    blurb: 'the 222 bpm rite of passage, full length',
    stars: 3,
    keys: 4,
    bpm: 222,
    seconds: 257,
    noteCount: 2296,
    dir: 'freedomdive',
  },
  {
    id: 'vsrg-darkplace',
    title: 'Dark Place',
    artist: 'Toby Fox',
    credit: '[Normal] charted by Rinley',
    blurb: 'slow enough to work out where your thumb goes',
    stars: 1,
    keys: 7,
    bpm: 114,
    seconds: 59,
    noteCount: 133,
    dir: 'darkplace',
  },
  {
    id: 'vsrg-asiandistractive',
    title: 'AsiaN distractive',
    artist: 'Nekomata Gekidan',
    credit: "[Leni's Advanced] from _Stan's set",
    blurb: 'seven keys at a speed you can still think at',
    stars: 2,
    keys: 7,
    bpm: 157,
    seconds: 112,
    noteCount: 853,
    dir: 'asiandistractive',
  },
  {
    id: 'vsrg-quietusray',
    title: 'Quietus Ray',
    artist: 'xi',
    credit: "[Kyou's Another] from Kuo Kyoka's set",
    blurb: 'the one my hands give out on first',
    stars: 3,
    keys: 7,
    bpm: 200,
    seconds: 115,
    noteCount: 1247,
    dir: 'quietusray',
  },
]

function fmtDur(seconds: number): string {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------- song loading

interface ChartNote {
  /** seconds from audio start */
  t: number
  lane: number
}

interface SongData {
  notes: ChartNote[]
  bpm: number
  audio: ArrayBuffer
}

// compressed audio and parsed charts cache per track; decoded PCM does not,
// a three-minute song decodes to tens of megabytes
const songCache = new Map<string, Promise<Omit<SongData, 'audio'> & { raw: ArrayBuffer }>>()

function fetchSong(dir: string) {
  let cached = songCache.get(dir)
  if (!cached) {
    cached = (async () => {
      const base = `/os/games/vsrg/${dir}`
      const [chartRes, audioRes] = await Promise.all([
        fetch(`${base}/chart.json`),
        fetch(`${base}/song.mp3`),
      ])
      if (!chartRes.ok || !audioRes.ok) throw new Error('song fetch failed')
      const chart = (await chartRes.json()) as {
        bpm: number
        keys?: number
        notes: [number, number][]
      }
      const raw = await audioRes.arrayBuffer()
      const notes = chart.notes.map(([ms, lane]) => ({ t: ms / 1000, lane }))
      // charts predating the key-count field are all 4K
      return { notes, bpm: chart.bpm, keys: chart.keys ?? 4, raw }
    })()
    cached.catch(() => songCache.delete(dir))
    songCache.set(dir, cached)
  }
  return cached
}

// ---------------------------------------------------------------- audio engine

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
  one player per run. the song is a single BufferSource started a count-in
  after "now"; suspending the context freezes both the music and the clock,
  which is what makes pausing free. hits get a soft tick so play feels
  tactile without stepping on the song.
*/
class SongPlayer {
  readonly ctx: AudioContext
  /** where the chart clock starts: song time = ctx.currentTime - songStart */
  private songStart = 0
  private master: GainNode
  private ticks: GainNode
  private noise: AudioBuffer
  private source: AudioBufferSourceNode | null = null

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 20
    comp.ratio.value = 3
    comp.connect(ctx.destination)
    this.master = ctx.createGain()
    // real mp3s come in mastered loud; sit them well under the OS's voice
    this.master.gain.value = 0.3
    this.master.connect(comp)
    this.ticks = ctx.createGain()
    this.ticks.gain.value = 1
    this.ticks.connect(this.master)
    const len = Math.floor(ctx.sampleRate * 0.03)
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  }

  /**
   * begins the run: audio starts `lead` seconds from now at `skip` seconds
   * into the file, with count-in ticks on the three beats before it
   */
  start(buffer: AudioBuffer, skip: number, bpm: number) {
    const spb = 60 / bpm
    const lead = Math.max(3 * spb, 1.1) + 0.15
    const t0 = this.ctx.currentTime
    this.songStart = t0 + lead - skip
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.master)
    src.start(t0 + lead, skip)
    this.source = src
    for (let k = 3; k >= 1; k--) {
      this.tick(t0 + lead - k * spb, k === 1 ? 1320 : 880)
    }
  }

  /**
   * song time in seconds, negative-to-skip during the count-in. what the
   * player hears runs behind ctx.currentTime by the hardware output
   * latency, so judging against the raw clock reads every hit as late;
   * subtracting the reported latency lines the clock up with the ears
   */
  now(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number }
    const latency = ctx.outputLatency || ctx.baseLatency || 0
    return this.ctx.currentTime - this.songStart - latency
  }

  private tick(at: number, freq: number) {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(0.09, at + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0008, at + 0.09)
    osc.connect(g).connect(this.ticks)
    osc.start(at)
    osc.stop(at + 0.12)
  }

  /** the soft hit tick, fired the moment a note is judged as hit */
  hit() {
    const at = this.ctx.currentTime
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const hp = this.ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 3200
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.05, at)
    g.gain.exponentialRampToValueAtTime(0.0008, at + 0.025)
    src.connect(hp).connect(g).connect(this.ticks)
    src.start(at)
    src.stop(at + 0.03)
  }

  /** stop the music and fade out; safe to call more than once */
  stop(release = 0.15) {
    const master = this.master
    master.gain.setTargetAtTime(0, this.ctx.currentTime, release)
    const src = this.source
    this.source = null
    window.setTimeout(() => {
      try {
        src?.stop()
      } catch {
        /* already stopped */
      }
      master.disconnect()
    }, 400 + release * 3000)
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
  /** how many lanes this chart plays on; every per-lane array is this long */
  lanes: number
  /** per-lane note indices in time order, with a head pointer per lane */
  laneNotes: number[][]
  heads: number[]
  /** seconds into the audio where playback begins (long intros skipped) */
  skip: number
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
  for (let l = 0; l < run.lanes; l++) {
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

/*
  The classic mania colouring, read off the lane's distance from the edge
  rather than written out per key mode: white, blue, white, ... inwards, and
  an odd lane count puts an amber thumb key in the middle. That lands on
  white/blue/blue/white for 4K, which is what the game always looked like,
  and white/blue/white/amber/white/blue/white for 7K.
*/
type Tint = 'white' | 'blue' | 'amber'

function laneTint(laneIdx: number, lanes: number): Tint {
  if (lanes % 2 === 1 && laneIdx * 2 === lanes - 1) return 'amber'
  return Math.min(laneIdx, lanes - 1 - laneIdx) % 2 === 0 ? 'white' : 'blue'
}

const NOTE_FILL: Record<Tint, [string, string, string]> = {
  white: ['#ffffff', '#dbd8d3', '#a8a29b'],
  blue: ['#a9c8fa', '#3a72d4', '#1e4390'],
  amber: ['#fef0c7', '#eab308', '#a16207'],
}

const NOTE_EDGE: Record<Tint, string> = {
  white: 'rgba(50,46,40,0.55)',
  blue: 'rgba(9,25,60,0.65)',
  amber: 'rgba(69,45,4,0.6)',
}

function drawNote(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, tint: Tint) {
  const grad = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r)
  const [hi, mid, lo] = NOTE_FILL[tint]
  grad.addColorStop(0, hi)
  grad.addColorStop(0.55, mid)
  grad.addColorStop(1, lo)
  g.fillStyle = grad
  g.beginPath()
  g.arc(cx, cy, r, 0, Math.PI * 2)
  g.fill()
  g.strokeStyle = NOTE_EDGE[tint]
  g.lineWidth = 1.25
  g.stroke()
}

function drawReceptor(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  letter: string,
  pressed: boolean,
) {
  if (pressed) {
    const grad = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r)
    grad.addColorStop(0, '#bcd7fc')
    grad.addColorStop(1, '#3d74d8')
    g.fillStyle = grad
    g.beginPath()
    g.arc(cx, cy, r, 0, Math.PI * 2)
    g.fill()
  } else {
    g.fillStyle = 'rgba(30,48,96,0.55)'
    g.beginPath()
    g.arc(cx, cy, r, 0, Math.PI * 2)
    g.fill()
  }
  g.strokeStyle = pressed ? '#dbeafe' : 'rgba(148,178,235,0.8)'
  g.lineWidth = 2
  g.beginPath()
  g.arc(cx, cy, r - 1, 0, Math.PI * 2)
  g.stroke()
  g.fillStyle = pressed ? '#1e3a8a' : 'rgba(255,255,255,0.85)'
  // a spelled-out binding ("space", "shift") has to shrink to stay inside
  // the receptor; a one or two character one keeps the readable size
  g.font = `bold ${letter.length > 2 ? 9 : 12}px ui-monospace, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(letter, cx, cy + 1)
}

function drawFrame(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  run: Run,
  now: number,
  speed: number,
  labels: string[],
) {
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.fillStyle = '#101014'
  g.fillRect(0, 0, w, h)

  const lanes = run.lanes
  const laneW = Math.min(78, Math.floor((w - 40) / lanes))
  const fieldW = laneW * lanes
  const x0 = Math.round((w - fieldW) / 2)
  const receptorY = h - 78
  const noteR = Math.min(30, Math.floor(laneW * 0.4))
  // osu!mania speed: top of the field to the line in 10/speed seconds
  const pxPerSec = (receptorY * speed) / 10

  // the playfield well and its lane separators
  g.fillStyle = '#17181d'
  g.fillRect(x0, 0, fieldW, h)
  g.strokeStyle = 'rgba(255,255,255,0.07)'
  g.lineWidth = 1
  for (let l = 0; l <= lanes; l++) {
    const x = x0 + l * laneW + 0.5
    g.beginPath()
    g.moveTo(x, 0)
    g.lineTo(x, h)
    g.stroke()
  }

  // faint beat grid scrolling at note speed
  const tTop = now + (receptorY + noteR) / pxPerSec
  const tBottom = now - (h - receptorY) / pxPerSec
  for (let k = Math.ceil(tBottom / run.beat); k * run.beat <= tTop; k++) {
    const bt = k * run.beat
    if (bt < run.skip - 3 * run.beat || bt > run.duration) continue
    const y = Math.round(receptorY - (bt - now) * pxPerSec)
    g.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)'
    g.fillRect(x0, y, fieldW, 1)
  }

  // lane flashes rising from the receptors on each hit
  for (let l = 0; l < lanes; l++) {
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

  for (let l = 0; l < lanes; l++) {
    drawReceptor(g, x0 + l * laneW + laneW / 2, receptorY, noteR + 2, labels[l] ?? '', run.keysDown[l])
  }

  // notes, centered on their moment in time
  for (const n of run.notes) {
    if (n.t > tTop) break
    if (n.state !== 0) continue
    const y = receptorY - (n.t - now) * pxPerSec
    if (y < -noteR || y > h + noteR) continue
    drawNote(g, x0 + n.lane * laneW + laneW / 2, y, noteR, laneTint(n.lane, lanes))
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
  const p = Math.max(0, Math.min(1, (now - run.skip) / (run.duration - run.skip)))
  g.fillStyle = '#3b82f6'
  g.fillRect(x0, 0, fieldW * p, 3)

  // count-in, one number per beat before the music lands
  if (now < run.skip) {
    const n = Math.min(3, Math.ceil((run.skip - now) / run.beat))
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
  /** osu!mania style scroll speed, 1..40 */
  speed: number
  /** the player's sync nudge in ms; positive judges notes later */
  syncMs: number
  onStats: (s: Stats) => void
  onFinish: (r: RunResult) => void
  onQuit: () => void
  /** restart this chart from the top */
  onRetry: () => void
  /** one lane binding per lane of this track, as KeyboardEvent.code */
  keys: string[]
}

const Gameplay = memo(function Gameplay({
  track,
  speed,
  syncMs,
  onStats,
  onFinish,
  onQuit,
  onRetry,
  keys,
}: GameplayProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // read by the frame loop and the key handler, which both outlive a render
  const labelsRef = useRef<string[]>(keys.map(keyLabel))
  const laneOfRef = useRef<Map<string, number>>(new Map(keys.map((c, i) => [c, i])))
  useEffect(() => {
    labelsRef.current = keys.map(keyLabel)
    laneOfRef.current = new Map(keys.map((c, i) => [c, i]))
  }, [keys])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const runRef = useRef<Run | null>(null)
  const engineRef = useRef<SongPlayer | null>(null)
  const pausedRef = useRef(false)
  const [paused, setPaused] = useState(false)
  const [problem, setProblem] = useState<'audio' | 'load' | null>(null)
  const [loading, setLoading] = useState(true)

  // suspending the context freezes its clock, so a pause costs nothing:
  // judgment, notes and music all wake up exactly where they stopped
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
      setProblem('audio')
      setLoading(false)
      return
    }

    let alive = true
    let raf = 0
    let engine: SongPlayer | null = null
    const syncSec = syncMs / 1000

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

    void (async () => {
      let buffer: AudioBuffer
      let notes: ChartNote[]
      let bpm: number
      try {
        const song = await fetchSong(track.dir)
        // decodeAudioData detaches the buffer it is given, so decode a copy
        buffer = await ac.decodeAudioData(song.raw.slice(0))
        notes = song.notes
        bpm = song.bpm
      } catch {
        if (alive) {
          setProblem('load')
          setLoading(false)
        }
        return
      }
      if (!alive) return
      setLoading(false)

      const spb = 60 / bpm
      // long silent intros bore visitors: begin two bars before the action
      const skip = Math.max(0, notes[0].t - 8 * spb)
      // the track's declared key mode owns the layout and the bindings, so a
      // chart that disagreed with it gets folded into the lanes on screen
      const lanes = track.keys
      const run: Run = {
        notes: notes.map((n) => ({
          ...n,
          lane: Math.min(lanes - 1, Math.max(0, n.lane)),
          state: 0,
        })),
        lanes,
        laneNotes: Array.from({ length: lanes }, () => []),
        heads: new Array<number>(lanes).fill(0),
        skip,
        duration: notes[notes.length - 1].t + 1.2,
        beat: spb,
        keysDown: new Array<boolean>(lanes).fill(false),
        flashAt: new Array<number>(lanes).fill(-1),
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

      engine = new SongPlayer(ac)
      engineRef.current = engine
      engine.start(buffer, skip, bpm)

      const frame = () => {
        if (!engine) return
        const now = engine.now() - syncSec
        if (!pausedRef.current && !run.finished) {
          if (sweepMisses(run, now)) onStats(currentStats(run))
          if (now > run.duration + 0.8) {
            run.finished = true
            engine.stop(0.5)
            onFinish(buildResult(run))
            return
          }
        }
        const { w, h, dpr } = sizeRef.current
        if (w > 0 && h > 0) drawFrame(g, w, h, dpr, run, now, speed, labelsRef.current)
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
      wrap.focus()
    })()

    const onWinBlur = () => doPause()
    const onVis = () => {
      if (document.hidden) doPause()
    }
    window.addEventListener('blur', onWinBlur)
    document.addEventListener('visibilitychange', onVis)

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('blur', onWinBlur)
      document.removeEventListener('visibilitychange', onVis)
      engine?.stop()
      engineRef.current = null
      runRef.current = null
      // a run abandoned mid-pause must not leave the context asleep
      if (ac.state === 'suspended') void ac.resume()
    }
  }, [track, speed, syncMs, onStats, onFinish, doPause])

  const handleKey = (e: KeyboardEvent<HTMLDivElement>, down: boolean) => {
    // Escape belongs to the game while a run is up. Without stopping it here
    // it reaches AlejOS's window-level handler, which reads it as "back out"
    // and tears the whole desktop down mid-song.
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (!down) return
      if (pausedRef.current) resume()
      else doPause()
      return
    }
    // quick retry, osu! style: restart the chart from the top without going
    // back through song select
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault()
      e.stopPropagation()
      if (down && !e.repeat) onRetry()
      return
    }
    const laneIdx = laneOfRef.current.get(e.code)
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
    const now = engine.now() - syncMs / 1000
    sweepMisses(run, now)
    const hit = judgePress(run, laneIdx, now)
    if (hit) engine.hit()
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
      {loading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#101014]">
          <MusicNotesIcon size={28} weight="fill" className="animate-pulse text-blue-400" />
          <p className="text-xs text-stone-300">
            loading {track.title}
            <span className="animate-pulse">...</span>
          </p>
        </div>
      )}
      {paused && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60">
          <p className="text-sm font-semibold text-white">paused</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={resume}
              className={`${XP_BTN} px-3 py-1 text-xs font-medium text-stone-700`}
            >
              keep playing
            </button>
            <button
              type="button"
              onClick={() => {
                sounds.click()
                onRetry()
              }}
              className={`${XP_BTN} px-3 py-1 text-xs font-medium text-stone-700`}
            >
              retry
            </button>
          </div>
          <p className="text-[11px] text-white/60">esc resumes · r restarts</p>
        </div>
      )}
      {problem && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
          <p className="text-xs text-stone-200">
            {problem === 'audio'
              ? 'The game keeps time by sound, and this browser will not start the audio.'
              : 'The song did not load. Check the connection and try again.'}
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
        {track.title} · {'★'.repeat(track.stars)}
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
          Song select
        </button>
      </div>
    </div>
  )
}

/*
  Rebinding: click a lane, press a key. Listening on the window in capture
  means the press is caught before anything else can act on it — Escape backs
  out of the rebind instead of reaching the desktop, and binding a key that
  happens to be a lane key does not also play a note.
*/
function KeyBinds({
  mode,
  keys,
  onKeys,
}: {
  mode: KeyMode
  keys: string[]
  onKeys: (k: string[]) => void
}) {
  const [capturing, setCapturing] = useState<number | null>(null)

  useEffect(() => {
    if (capturing === null) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' || RESERVED_KEYS.has(e.key)) {
        setCapturing(null)
        return
      }
      const next = [...keys]
      // a code already used by another lane trades places with this one, so
      // there is never a chart you cannot finish because two lanes share a key
      const clash = next.indexOf(e.code)
      if (clash !== -1) next[clash] = next[capturing]
      next[capturing] = e.code
      onKeys(next)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, keys, onKeys])

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-stone-500">keys</span>
      {keys.map((code, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Lane ${i + 1} key, currently ${keyLabel(code)}`}
          onClick={() => {
            sounds.click()
            setCapturing(i)
          }}
          className={`${XP_BTN} min-w-7 px-1.5 py-0.5 font-mono text-[11px] ${
            capturing === i ? 'text-blue-700' : 'text-stone-700'
          }`}
        >
          {capturing === i ? '...' : keyLabel(code)}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          sounds.click()
          setCapturing(null)
          onKeys([...DEFAULT_KEYS[mode]])
        }}
        className={`${XP_BTN} px-1.5 py-0.5 text-[11px] text-stone-600`}
      >
        reset
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- track select

function TrackSelect({
  mode,
  onMode,
  speed,
  onSpeed,
  syncMs,
  onSync,
  onPlay,
  keys,
  onKeys,
}: {
  mode: KeyMode
  onMode: (m: KeyMode) => void
  speed: number
  onSpeed: (s: number) => void
  syncMs: number
  onSync: (v: number) => void
  onPlay: (t: TrackDef) => void
  keys: string[]
  onKeys: (k: string[]) => void
}) {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-stone-500">
          Notes fall down the lanes. Press the matching key as each one crosses the line. Real
          songs, real charts from the community.
        </p>
        <div className="flex shrink-0 gap-1">
          {KEY_MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mode}
              onClick={() => onMode(m)}
              className={`${XP_BTN} px-2 py-0.5 text-[11px] ${
                m === mode ? 'font-semibold text-blue-800' : 'text-stone-600'
              }`}
            >
              {m}K
            </button>
          ))}
        </div>
      </div>
      {TRACKS.filter((t) => t.keys === mode).map((t) => {
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
                <span className="text-sm font-semibold text-stone-800">{t.title}</span>
                <span className="text-[11px] tracking-wide text-amber-600">
                  {'★'.repeat(t.stars)}
                </span>
              </div>
              <p className="truncate text-[11px] text-stone-600">{t.artist}</p>
              <p className="truncate text-[11px] text-stone-500">
                {t.blurb} · {t.credit}
              </p>
              <p className="font-mono text-[11px] tabular-nums text-stone-500">
                {t.bpm} bpm · {fmtDur(t.seconds)} · {t.noteCount} notes ·{' '}
                {best !== null ? `best ${formatScore(t.id, best)}` : 'no score yet'}
              </p>
            </div>
            <PlayIcon size={16} weight="fill" className="shrink-0 text-blue-700" />
          </button>
        )
      })}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        <KeyBinds mode={mode} keys={keys} onKeys={onKeys} />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-stone-500">scroll speed</span>
        <button
          type="button"
          aria-label="Slower scroll"
          onClick={() => onSpeed(Math.max(SPEED_MIN, speed - 1))}
          className={`${XP_BTN} px-1.5 py-0.5 text-[11px] text-stone-600`}
        >
          -
        </button>
        <span className="w-6 text-center font-mono text-[11px] tabular-nums text-stone-700">
          {speed}
        </span>
        <button
          type="button"
          aria-label="Faster scroll"
          onClick={() => onSpeed(Math.min(SPEED_MAX, speed + 1))}
          className={`${XP_BTN} px-1.5 py-0.5 text-[11px] text-stone-600`}
        >
          +
        </button>
        <span className="flex-1" />
        <span className="text-[11px] text-stone-500" title="shift note timing to match your setup">
          sync
        </span>
        <button
          type="button"
          aria-label="Notes judge earlier"
          onClick={() => onSync(Math.max(-60, syncMs - 5))}
          className={`${XP_BTN} px-1.5 py-0.5 text-[11px] text-stone-600`}
        >
          -
        </button>
        <span className="w-11 text-center font-mono text-[11px] tabular-nums text-stone-600">
          {syncMs >= 0 ? '+' : ''}
          {syncMs} ms
        </span>
        <button
          type="button"
          aria-label="Notes judge later"
          onClick={() => onSync(Math.min(60, syncMs + 5))}
          className={`${XP_BTN} px-1.5 py-0.5 text-[11px] text-stone-600`}
        >
          +
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- app

type Screen =
  | { kind: 'select' }
  | { kind: 'play'; track: TrackDef; nonce: number }
  | { kind: 'result'; track: TrackDef; result: RunResult }

const TABS = TRACKS.map((t) => ({ id: t.id, label: t.title }))

export function VsrgApp() {
  const { name } = useArcade()
  const [screen, setScreen] = useState<Screen>({ kind: 'select' })
  const [speed, setSpeedState] = useState<number>(readSpeed)
  const [syncMs, setSyncState] = useState<number>(readSync)
  const [mode, setModeState] = useState<KeyMode>(readMode)
  // both rows live at once: the select screen shows the browsed mode's, and a
  // run takes the row belonging to the chart it is playing
  const [keys, setKeysState] = useState<Record<KeyMode, string[]>>(readAllKeys)
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

  const setSpeed = (s: number) => {
    sounds.click()
    setSpeedState(s)
    storeSpeed(s)
  }

  const setSync = (v: number) => {
    sounds.click()
    setSyncState(v)
    storeSync(v)
  }

  const setKeys = useCallback(
    (next: string[]) => {
      sounds.click()
      setKeysState((prev) => ({ ...prev, [mode]: next }))
      storeKeys(mode, next)
    },
    [mode],
  )

  const setMode = (m: KeyMode) => {
    sounds.click()
    setModeState(m)
    storeMode(m)
  }

  // retry restarts the same chart from the top; the nonce remounts Gameplay,
  // which is what actually rebuilds the run
  const retry = useCallback(() => {
    setScreen((s) =>
      s.kind === 'play' || s.kind === 'result'
        ? { kind: 'play', track: s.track, nonce: Date.now() }
        : s,
    )
    setStats(START_STATS)
  }, [])

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

  // the hint reads the row the player is about to use, or is using
  const hintKeys = keys[screen.kind === 'select' ? mode : screen.track.keys]

  return (
    <GameShell
      tabs={TABS}
      you={name}
      header={header}
      hint={`${hintKeys.map(keyLabel).join(' ')} hit the notes  ·  esc pauses  ·  r retries`}
    >
      {screen.kind === 'select' && (
        <TrackSelect
          mode={mode}
          onMode={setMode}
          speed={speed}
          onSpeed={setSpeed}
          syncMs={syncMs}
          onSync={setSync}
          onPlay={startTrack}
          keys={keys[mode]}
          onKeys={setKeys}
        />
      )}
      {screen.kind === 'play' && (
        <Gameplay
          key={screen.nonce}
          track={screen.track}
          speed={speed}
          syncMs={syncMs}
          onStats={onStats}
          onFinish={onFinish}
          onQuit={onQuit}
          onRetry={retry}
          keys={keys[screen.track.keys]}
        />
      )}
      {screen.kind === 'result' && (
        <Results
          track={screen.track}
          result={screen.result}
          onRetry={retry}
          onSelect={() => {
            sounds.click()
            setScreen({ kind: 'select' })
          }}
        />
      )}
    </GameShell>
  )
}
