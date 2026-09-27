/*
  Plays the score on recorded instruments. Each instrument is a handful of
  real notes (`samples.ts`, built by scripts/music-samples.py from two CC0
  Versilian Studios libraries), and any other pitch is the nearest recording
  played a little faster or slower, which is what every sampler does,
  hardware or software, and inaudible within a couple of semitones. The
  tuning each recording was measured at rides in the manifest, so a harp
  string that was eleven cents flat in the studio is not eleven cents flat
  here.

  Nothing is fetched until a performance asks for an instrument, and
  nothing waits on a fetch: a note whose sample has not arrived is simply
  not played, and the performer delays a piece's start until its instruments
  are in rather than starting it with holes. Decoding is per context, so the
  same module drives the live AudioContext and a probe's
  OfflineAudioContext.

  Two kinds of note. Struck and plucked things (piano, harp, mallets,
  pizzicato) ring out on their own and are only damped when the score says
  so; bowed and blown things (strings, winds, horn) hold for the written
  length and then release, and a note written longer than its recording is
  carried by a second, crossfaded copy of the sustain.

  MP3 because it is the one lossy format every browser decodes; the encoder
  pads the front with silence, so each buffer's real onset is found once by
  scanning for the first sample above the noise, and playback starts there.
*/

import { HITS, PITCHED, type HitId, type PitchedId } from './samples'

const BASE = '/os/music'

interface Loaded {
  buf: AudioBuffer
  /** seconds of encoder padding before the note starts */
  onset: number
}

type Store = Map<string, Loaded | null>
const stores = new WeakMap<BaseAudioContext, { done: Store; pending: Map<string, Promise<void>> }>()

const storeOf = (ctx: BaseAudioContext) => {
  let s = stores.get(ctx)
  if (!s) stores.set(ctx, (s = { done: new Map(), pending: new Map() }))
  return s
}

const findOnset = (buf: AudioBuffer) => {
  const x = buf.getChannelData(0)
  let peak = 0
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]))
  const th = peak * 0.01
  let i = 0
  while (i < x.length && Math.abs(x[i]) < th) i++
  return Math.max(0, i - Math.floor(0.002 * buf.sampleRate)) / buf.sampleRate
}

const fetchOne = (ctx: BaseAudioContext, key: string, url: string): Promise<void> => {
  const s = storeOf(ctx)
  const had = s.pending.get(key)
  if (had) return had
  const p = fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((data) => ctx.decodeAudioData(data))
    .then((buf) => {
      s.done.set(key, { buf, onset: findOnset(buf) })
    })
    .catch(() => {
      // a missing note is a gap in one chord, not a reason to stop the music
      s.done.set(key, null)
    })
  s.pending.set(key, p)
  return p
}

export const isPitched = (id: string): id is PitchedId => id in PITCHED

/** fetch and decode every recording of these instruments; resolves when all
    have landed or failed */
export function loadInstruments(ctx: BaseAudioContext, ids: Iterable<PitchedId | HitId>): Promise<void> {
  const jobs: Promise<void>[] = []
  for (const id of ids) {
    if (isPitched(id)) {
      for (const n of PITCHED[id].notes) jobs.push(fetchOne(ctx, `${id}:${n}`, `${BASE}/${id}/${n}.mp3`))
    } else {
      for (let i = 0; i < HITS[id].hits; i++) jobs.push(fetchOne(ctx, `${id}:${i}`, `${BASE}/${id}/${i}.mp3`))
    }
  }
  return Promise.all(jobs).then(() => undefined)
}

/** whether every recording of these instruments has been dealt with */
export function instrumentsReady(ctx: BaseAudioContext, ids: Iterable<PitchedId | HitId>): boolean {
  const done = storeOf(ctx).done
  for (const id of ids) {
    const keys = isPitched(id)
      ? PITCHED[id].notes.map((n) => `${id}:${n}`)
      : Array.from({ length: HITS[id].hits }, (_, i) => `${id}:${i}`)
    for (const k of keys) if (!done.has(k)) return false
  }
  return true
}

/** how each instrument behaves once struck */
const SUSTAINED = new Set<PitchedId>(['flute', 'ocarina', 'clarinet', 'oboe', 'violins', 'violas', 'celli', 'horn'])
/** seconds a released note takes to die away */
const RELEASE: Partial<Record<PitchedId, number>> = {
  flute: 0.25, ocarina: 0.25, clarinet: 0.3, oboe: 0.25, horn: 0.45,
  violins: 0.7, violas: 0.7, celli: 0.7, piano: 0.9, vibes: 1.2,
}
/** struck voices the score damps at the written length (plus this much
    ring, which is the sustain pedal); the rest ring for their recording */
const DAMPED: Partial<Record<PitchedId, number>> = { piano: 0.55, vibes: 0.8, marimba: 0.3 }

/** the recording nearest a pitch, preferring the one below on a tie */
const nearest = (id: PitchedId, midi: number) => {
  const { notes, cents } = PITCHED[id]
  let k = 0
  for (let i = 1; i < notes.length; i++) {
    if (Math.abs(notes[i] - midi) < Math.abs(notes[k] - midi)) k = i
  }
  return { note: notes[k], cents: cents[k] }
}

export interface NoteOpts {
  /** beats of the note, already in seconds */
  dur: number
  /** 0..1 */
  vel: number
  /** seconds for a sustained note to swell in, over the recording's own attack */
  swell?: number
}

/** schedule one pitched note into `dest`. Returns false if its sample is
    not in yet (the note is skipped) */
export function playNote(ctx: BaseAudioContext, dest: AudioNode, id: PitchedId, midi: number, when: number, o: NoteOpts): boolean {
  const { note, cents } = nearest(id, midi)
  const got = storeOf(ctx).done.get(`${id}:${note}`)
  if (!got) return false
  const rate = 2 ** ((midi - note - cents / 100) / 12)
  const g = ctx.createGain()
  // loudness grows faster than linearly with how hard a note is played
  const peak = o.vel ** 1.5
  const src = ctx.createBufferSource()
  src.buffer = got.buf
  src.playbackRate.value = rate
  src.connect(g).connect(dest)
  const room = (got.buf.duration - got.onset) / rate
  if (o.swell) {
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(peak, when + o.swell)
  } else {
    g.gain.setValueAtTime(peak, when)
  }
  src.start(when, got.onset)
  let end: number
  if (SUSTAINED.has(id)) {
    const rel = RELEASE[id] ?? 0.3
    end = when + o.dur
    // written longer than the recording holds: carry it on a second copy
    // of the sustain, crossfaded in before the first one fades out
    if (o.dur > room * 0.7) {
      const x = ctx.createBufferSource()
      x.buffer = got.buf
      x.playbackRate.value = rate
      const xg = ctx.createGain()
      const at = when + room * 0.5
      xg.gain.setValueAtTime(0, at)
      xg.gain.linearRampToValueAtTime(peak, at + 0.6)
      g.gain.setValueAtTime(peak, at)
      g.gain.linearRampToValueAtTime(0, at + 0.6)
      x.connect(xg).connect(dest)
      x.start(at, got.onset + 0.6)
      xg.gain.setTargetAtTime(0, end, rel / 4)
      x.stop(end + rel * 1.5)
      src.stop(at + 0.7)
      return true
    }
    g.gain.setTargetAtTime(0, end, rel / 4)
    src.stop(Math.min(when + room, end + rel * 1.5))
    return true
  }
  const ring = DAMPED[id]
  if (ring !== undefined) {
    end = when + o.dur + ring
    const rel = RELEASE[id] ?? 0.4
    if (end < when + room) {
      g.gain.setTargetAtTime(0, end, rel / 4)
      src.stop(end + rel * 1.5)
    }
  }
  return true
}

/** schedule one unpitched hit */
export function playHit(ctx: BaseAudioContext, dest: AudioNode, id: HitId, index: number, when: number, vel: number): boolean {
  const got = storeOf(ctx).done.get(`${id}:${index % HITS[id].hits}`)
  if (!got) return false
  const src = ctx.createBufferSource()
  src.buffer = got.buf
  // a hair of pitch spread, so a repeated shaker is not a machine
  src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.04
  const g = ctx.createGain()
  g.gain.value = vel ** 1.5
  src.connect(g).connect(dest)
  src.start(when, got.onset)
  return true
}
