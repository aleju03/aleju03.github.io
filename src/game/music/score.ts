/*
  The soundtrack as sheet music. Seven short pieces, one per mood the walk
  can be in, each written the way a small game score is written: a key, a
  tempo, an eight-bar theme composed by hand, the chords under it, a
  contrasting B progression, and an orchestration that says which recorded
  instrument plays what in which section. `composer.ts` turns one of these
  into notes (the themes verbatim, everything around them generated from
  the chords), and `index.ts` decides which piece the moment calls for.

  The themes are hand-written because generated melodies are the part of
  generative music that sounds generated. Everything a listener hums is in
  the strings below; the variety between plays is in the arrangement, the B
  section's melody and the counter-lines, which are all derived from these
  chords, so they cannot wander off the harmony.

  The harmonic language is the cozy-adventure one: major keys with lydian
  lifts (II major over a tonic pedal, the Ghibli and Zelda move), minor iv
  borrowed at cadences in the home piece, added ninths and major sevenths
  for warmth, and suspended dominants that lean rather than push. Tempos sit
  between a lullaby and a walking pace, because the player sets the pace and
  the music only has to keep them company.

  Notation. A theme is space-separated `note/beats` tokens (`F#5/1.5`, `r/1`
  a rest, beats default to 1). A progression is one string per bar; two
  chords in a bar split it evenly unless one says `:beats`. A layer's `in` is
  the sections it plays in: i intro, 1 2 3 the three A sections, b the B
  section, o the outro.
*/

import type { HitId, PitchedId } from './samples'

export type Mood = 'home' | 'field' | 'town' | 'night' | 'sea' | 'sky' | 'orbit'

/* ------------------------------------------------------------ theory -- */

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** 'F#5' → 78, 'Bb3' → 58 */
export const noteMidi = (s: string): number => {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s)
  if (!m) throw new Error(`bad note ${s}`)
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
}

const QUALITY: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m6: [0, 3, 7, 9],
  '6': [0, 4, 7, 9],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '7sus4': [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  '9': [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  'maj7#11': [0, 4, 7, 11, 18],
  dim: [0, 3, 6],
  m7b5: [0, 3, 6, 10],
}

export interface Chord {
  /** pitch class of the root, and of the bass (the slash note, else the root) */
  root: number
  bass: number
  /** intervals over the root, ascending: the voicing's raw material */
  ivs: number[]
  /** onset and length in beats, within the piece */
  t: number
  d: number
}

const parseChord = (s: string): Omit<Chord, 't' | 'd'> => {
  const [body, slash] = s.split('/')
  const m = /^([A-G])(#|b)?(.*)$/.exec(body)
  if (!m || !(m[3] in QUALITY)) throw new Error(`bad chord ${s}`)
  const root = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12
  let bass = root
  if (slash) {
    const b = /^([A-G])(#|b)?$/.exec(slash)
    if (!b) throw new Error(`bad bass ${s}`)
    bass = (PC[b[1]] + (b[2] === '#' ? 1 : b[2] === 'b' ? -1 : 0) + 12) % 12
  }
  return { root, bass, ivs: QUALITY[m[3]] }
}

/** a progression's bars as timed chords, starting at beat `t0` */
export const parseBars = (bars: readonly string[], meter: number, t0 = 0): Chord[] => {
  const out: Chord[] = []
  bars.forEach((bar, i) => {
    const parts = bar.trim().split(/\s+/)
    const given = parts.map((p) => (p.includes(':') ? Number(p.split(':')[1]) : 0))
    const free = parts.filter((_, j) => !given[j]).length
    const rest = meter - given.reduce((a, b) => a + b, 0)
    let t = t0 + i * meter
    for (let j = 0; j < parts.length; j++) {
      const d = given[j] || rest / free
      out.push({ ...parseChord(parts[j].split(':')[0]), t, d })
      t += d
    }
  })
  return out
}

export interface Note {
  t: number
  d: number
  midi: number
}

/** a theme string as timed notes (rests leave a gap), from beat `t0` */
export const parseLine = (line: string, t0 = 0): Note[] => {
  const out: Note[] = []
  let t = t0
  for (const tok of line.trim().split(/\s+/)) {
    const [n, b] = tok.split('/')
    const d = b === undefined ? 1 : Number(b)
    if (n !== 'r') out.push({ t, d, midi: noteMidi(n) })
    t += d
  }
  return out
}

/** the pitch classes a chord is made of */
export const chordPcs = (c: Chord) => c.ivs.map((iv) => (c.root + iv) % 12)

/* ------------------------------------------------------------ layers -- */

type Sections = string

/** one instrument's job in a piece. Ranges are MIDI numbers and bound
    every generated note; `vel` is 0..1 and the mixer's LEVELS make it loud */
export type Layer =
  /** the melody: the theme in A sections, a generated line in B. `oct`
      transposes it into the instrument's sweet spot */
  | { role: 'lead'; inst: PitchedId; in: Sections; vel: number; oct?: number }
  /** a slow line under the melody, from the chords' thirds and sevenths */
  | { role: 'counter'; inst: PitchedId; in: Sections; vel: number; lo: number; hi: number }
  /** [beat, degree, beats, accent]: R root, 3, 5, 8 octave, > a walk into
      the next chord's root */
  | { role: 'bass'; inst: PitchedId; in: Sections; vel: number; lo: number; hi: number; steps: [number, string, number, number?][] }
  /** a broken chord: `seq` indexes the voiced chord tones, one per `rate` beats */
  | { role: 'arp'; inst: PitchedId; in: Sections; vel: number; lo: number; hi: number; rate: number; seq: number[]; ring?: number }
  /** struck chords at the given beats of every bar */
  | { role: 'block'; inst: PitchedId; in: Sections; vel: number; lo: number; hi: number; voices: number; at: number[]; d: number }
  /** a sustained chord for each chord's whole length, voice-led */
  | { role: 'pad'; inst: PitchedId; in: Sections; vel: number; lo: number; hi: number; voices: number }
  /** unpitched: [beat, which hit, accent] */
  | { role: 'perc'; inst: HitId; in: Sections; vel: number; steps: [number, number, number][] }

export interface Piece {
  id: Mood
  title: string
  bpm: number
  /** beats per bar, in the unit the bpm counts (6/8 counts eighths) */
  meter: number
  /** 0 straight .. 0.33 hard swing, applied to off-beat halves */
  swing?: number
  /** tonic pitch class and the scale the generated lines keep to */
  key: number
  scale: number[]
  A: string[]
  B: string[]
  theme: string
  /** the chord the piece comes to rest on, held for two bars */
  end: string
  layers: Layer[]
  /** the forms a performance picks from */
  forms: string[]
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const LYDIAN = [0, 2, 4, 6, 7, 9, 11]

/*
  Each form is a string of sections. They run between about ninety seconds
  and three minutes, which is the length a piece in a game like this should
  be: long enough to be a piece, short enough to be over before it is
  wallpaper, and then the world gets to be quiet for a while.
*/

export const PIECES: Record<Mood, Piece> = {
  /* The house. A waltz on the upright with the soft felt of the pianist's
     left hand, a clarinet taking the tune the second time, violas under
     it. The minor iv in bar four (Bb to Bbm6) is the whole piece: that is
     the sound of a warm room when it is cold outside. */
  home: {
    id: 'home',
    title: 'The Warm Room',
    bpm: 76,
    meter: 3,
    key: 5,
    scale: MAJOR,
    A: ['Fmaj7', 'Am7', 'Bbmaj7', 'Bbm6', 'F/A', 'Dm7', 'Gm7', 'C7sus4'],
    B: ['Dm7', 'Am7', 'Bbmaj7', 'F', 'Gm7', 'Am7', 'Bbmaj7', 'C7sus4'],
    theme: 'A5 C6 E6 | E6/2 C6 | D6/1.5 C6/.5 A5 | Db6/2 Bb5 | A5 C6 F6 | E6/1.5 D6/.5 C6 | Bb5 A5 G5 | G5/3',
    end: 'Fmaj7',
    layers: [
      { role: 'bass', inst: 'piano', in: 'i123bo', vel: 0.5, lo: 41, hi: 55, steps: [[0, 'R', 2.5]] },
      { role: 'block', inst: 'piano', in: 'i123b', vel: 0.34, lo: 57, hi: 70, voices: 3, at: [1, 2], d: 0.9 },
      { role: 'lead', inst: 'piano', in: '13', vel: 0.62 },
      { role: 'lead', inst: 'clarinet', in: '2', vel: 0.55, oct: -1 },
      { role: 'lead', inst: 'glock', in: 'b', vel: 0.35, oct: 1 },
      { role: 'lead', inst: 'piano', in: 'o', vel: 0.5 },
      { role: 'pad', inst: 'violas', in: '2b', vel: 0.3, lo: 53, hi: 67, voices: 2 },
      { role: 'counter', inst: 'celli', in: '3', vel: 0.38, lo: 48, hi: 62 },
    ],
    forms: ['i123o', 'i12b3o', 'i1b3o', 'i12bo'],
  },

  /* Open country by day: the adventure one. D major with E major over a D
     pedal in bar two, which is the lydian lift that makes a horizon sound
     reachable. Harp and pizzicato celli keep walking under it, the flute
     states the tune, the ocarina answers it, the horn comes in for the
     last statement like the view from the top of the hill. */
  field: {
    id: 'field',
    title: 'Over the Next Hill',
    bpm: 100,
    meter: 4,
    key: 2,
    scale: MAJOR,
    A: ['D', 'E/D', 'Gmaj7', 'A', 'Bm7', 'Gmaj7', 'Em7', 'A7sus4:3 A:1'],
    B: ['Bm7', 'Gmaj7', 'D/F#', 'A', 'Bm7', 'Gmaj7', 'Em7', 'Asus4:2 A:2'],
    theme: 'F#5/1.5 A5/.5 D6 A5 | G#5/1.5 B5/.5 E6 B5 | D6/.5 C#6/.5 B5 F#5 G5/.5 A5/.5 | A5/3 r | F#5/1.5 A5/.5 B5 D6 | E6/1.5 D6/.5 B5 G5 | G5 F#5/.5 E5/.5 B5 G5 | A5/2 G5/.5 F#5/.5 E5',
    end: 'Dadd9',
    layers: [
      { role: 'bass', inst: 'celloPizz', in: 'i123bo', vel: 0.55, lo: 38, hi: 52, steps: [[0, 'R', 1], [2, '5', 1], [3, '>', 0.5, 0.7]] },
      { role: 'arp', inst: 'harp', in: 'i123bo', vel: 0.36, lo: 55, hi: 79, rate: 0.5, seq: [0, 1, 2, 3, 4, 3, 2, 1] },
      { role: 'lead', inst: 'flute', in: '1', vel: 0.6 },
      { role: 'lead', inst: 'ocarina', in: '2', vel: 0.62, oct: -1 },
      { role: 'lead', inst: 'oboe', in: 'b', vel: 0.55, oct: -1 },
      { role: 'lead', inst: 'flute', in: '3', vel: 0.62 },
      { role: 'lead', inst: 'glock', in: '3o', vel: 0.24, oct: 1 },
      { role: 'pad', inst: 'violins', in: '2b3', vel: 0.26, lo: 62, hi: 76, voices: 3 },
      { role: 'pad', inst: 'horn', in: '3', vel: 0.34, lo: 50, hi: 65, voices: 2 },
      { role: 'counter', inst: 'clarinet', in: 'b', vel: 0.34, lo: 55, hi: 67 },
      { role: 'perc', inst: 'shaker', in: '2b3', vel: 0.32, steps: [[0.5, 0, 0.8], [1.5, 1, 0.6], [2.5, 2, 0.8], [3.5, 3, 0.6]] },
      { role: 'perc', inst: 'timpani', in: '3', vel: 0.3, steps: [[0, 0, 1]] },
    ],
    forms: ['i12b3o', 'i1b3o', 'i123o', 'i12b3o'],
  },

  /* A town. Swung, bustling and a little silly: a staccato bassoon for a
     bass line, pizzicato violins on the off-beats, a marimba with the tune
     and a woodblock on two and four. The E7 in bar six is the wink. */
  town: {
    id: 'town',
    title: 'Corner Shop Shuffle',
    bpm: 112,
    meter: 4,
    swing: 0.28,
    key: 7,
    scale: MAJOR,
    A: ['G', 'Em7', 'Am7', 'D7', 'G', 'E7', 'Am7 D7', 'G'],
    B: ['Cmaj7', 'Bm7', 'Am7', 'D7', 'Cmaj7', 'Bm7 E7', 'Am7 D7', 'G'],
    theme: 'B4/.5 D5/.5 G5 F#5/.5 G5/.5 A5 | B5/1.5 G5/.5 E5/2 | C6/.5 B5/.5 A5/.5 G5/.5 E5 C5 | D5/.5 E5/.5 F#5/.5 A5/.5 C6/2 | B5/.5 A5/.5 G5 D5 G5 | G#5/1.5 B5/.5 D6/2 | C6/.5 B5/.5 A5 F#5/.5 E5/.5 D5 | G5/2 r/2',
    end: 'G6',
    layers: [
      { role: 'bass', inst: 'bassoon', in: 'i123bo', vel: 0.55, lo: 41, hi: 57, steps: [[0, 'R', 0.5], [1, '5', 0.5], [2, '8', 0.5], [3, '>', 0.5]] },
      { role: 'block', inst: 'vlnPizz', in: 'i123b', vel: 0.36, lo: 60, hi: 74, voices: 3, at: [1, 3], d: 0.4 },
      { role: 'lead', inst: 'marimba', in: '1', vel: 0.62 },
      { role: 'lead', inst: 'clarinet', in: '2', vel: 0.55 },
      { role: 'lead', inst: 'flute', in: 'b', vel: 0.55 },
      { role: 'lead', inst: 'marimba', in: '3', vel: 0.62 },
      { role: 'lead', inst: 'glock', in: '3', vel: 0.2, oct: 1 },
      { role: 'lead', inst: 'marimba', in: 'o', vel: 0.55 },
      { role: 'perc', inst: 'wood', in: '123b', vel: 0.3, steps: [[1, 0, 1], [3, 1, 1]] },
      { role: 'perc', inst: 'shaker', in: '2b3', vel: 0.26, steps: [[0.5, 0, 1], [1.5, 1, 0.7], [2.5, 2, 1], [3.5, 3, 0.7]] },
      { role: 'counter', inst: 'celli', in: 'b', vel: 0.3, lo: 45, hi: 59 },
    ],
    forms: ['i12b3o', 'i123o', 'i1b3o'],
  },

  /* Night. Slow, low and glowing: vibraphone broken chords, strings barely
     there, a clarinet in its dark register. E-flat with the A-flat lydian
     chord over an E-flat pedal, so it floats rather than resolves. */
  night: {
    id: 'night',
    title: 'Fireflies',
    bpm: 60,
    meter: 4,
    key: 3,
    scale: MAJOR,
    A: ['Ebmaj7', 'Abmaj7#11/Eb', 'Cm7', 'Abmaj7', 'Fm9', 'Bb7sus4', 'Ebmaj7', 'Bb7sus4'],
    B: ['Abmaj7', 'Gm7', 'Fm9', 'Ebmaj7', 'Abmaj7', 'Gm7', 'Fm9', 'Bb7sus4'],
    theme: 'G5/2 Bb5 D6 | C6/3 r | Eb6/1.5 D6/.5 Bb5/2 | C6/4 | Ab5/1.5 G5/.5 F5/2 | Eb5/2 F5/2 | G5 Bb5 Eb6/2 | D6/3 r',
    end: 'Ebmaj9',
    layers: [
      { role: 'bass', inst: 'celli', in: 'i123bo', vel: 0.34, lo: 39, hi: 51, steps: [[0, 'R', 4]] },
      { role: 'arp', inst: 'vibes', in: 'i123bo', vel: 0.34, lo: 55, hi: 77, rate: 1, seq: [0, 2, 1, 3] },
      { role: 'lead', inst: 'piano', in: '1', vel: 0.5 },
      { role: 'lead', inst: 'clarinet', in: '2', vel: 0.45, oct: -1 },
      { role: 'lead', inst: 'flute', in: 'b', vel: 0.42, oct: -1 },
      { role: 'lead', inst: 'piano', in: '3o', vel: 0.5 },
      { role: 'pad', inst: 'violins', in: '2b3', vel: 0.2, lo: 63, hi: 77, voices: 2 },
      { role: 'arp', inst: 'harp', in: '3', vel: 0.22, lo: 67, hi: 87, rate: 0.5, seq: [0, 1, 2, 3, 4, 3, 2, 1] },
    ],
    forms: ['i12b3o', 'i1b3o', 'i123o'],
  },

  /* On the water. A six-eight lilt that rocks like a hull: harp rolling
     eighths, pizzicato bass on the dotted beats, flute and oboe trading
     the tune, a shanty that has been to a nice café. */
  sea: {
    id: 'sea',
    title: 'Salt and Ribbons',
    bpm: 192,
    meter: 6,
    key: 9,
    scale: MAJOR,
    A: ['A', 'D', 'A', 'E', 'F#m', 'D', 'Bm7 E', 'A'],
    B: ['D', 'A/C#', 'Bm7', 'E', 'D', 'A/C#', 'Bm7', 'E7sus4:3 E7:3'],
    theme: 'E5/2 A5 C#6/2 B5 | A5/3 F#5/2 A5 | E6/2 C#6 A5/2 C#6 | B5/3 G#5/3 | A5/2 C#6 F#6/2 E6 | D6/2 C#6 A5/3 | B5/2 A5 G#5/2 B5 | A5/6',
    end: 'Aadd9',
    layers: [
      { role: 'bass', inst: 'celloPizz', in: 'i123bo', vel: 0.5, lo: 40, hi: 54, steps: [[0, 'R', 2], [3, '5', 2]] },
      { role: 'arp', inst: 'harp', in: 'i123bo', vel: 0.34, lo: 57, hi: 81, rate: 1, seq: [0, 2, 4, 5, 4, 2] },
      { role: 'lead', inst: 'flute', in: '1', vel: 0.58 },
      { role: 'lead', inst: 'oboe', in: '2', vel: 0.52, oct: -1 },
      { role: 'lead', inst: 'kalimba', in: 'b', vel: 0.55, oct: -1 },
      { role: 'lead', inst: 'flute', in: '3', vel: 0.6 },
      { role: 'lead', inst: 'harp', in: 'o', vel: 0.5 },
      { role: 'pad', inst: 'violas', in: '2b3', vel: 0.24, lo: 55, hi: 69, voices: 3 },
      { role: 'counter', inst: 'clarinet', in: '3', vel: 0.32, lo: 52, hi: 64 },
      { role: 'perc', inst: 'triangle', in: '3', vel: 0.16, steps: [[0, 0, 1]] },
    ],
    forms: ['i12b3o', 'i123o', 'i1b3o'],
  },

  /* In the air. C lydian, strings spread wide, the horn with the tune and
     harp sweeps under it: the sensation of the ground dropping away. */
  sky: {
    id: 'sky',
    title: 'Updraft',
    bpm: 84,
    meter: 4,
    key: 0,
    scale: LYDIAN,
    A: ['Cmaj7', 'D/C', 'Cmaj7', 'D/C', 'Am7', 'Bm7', 'Cmaj7', 'D'],
    B: ['Em7', 'D/F#', 'Gmaj7', 'Am7', 'Em7', 'D/F#', 'Cmaj7', 'Dsus4:2 D:2'],
    theme: 'E5 G5 B5/2 | A5/3 F#5 | G5 B5 E6/2 | D6/3 A5 | C6/2 B5 A5 | B5/2 F#5/2 | G5 E5 G5 B5 | A5/4',
    end: 'Cmaj7#11',
    layers: [
      { role: 'bass', inst: 'celli', in: 'i123bo', vel: 0.4, lo: 36, hi: 50, steps: [[0, 'R', 4]] },
      { role: 'pad', inst: 'violas', in: 'i123bo', vel: 0.3, lo: 52, hi: 66, voices: 3 },
      { role: 'pad', inst: 'violins', in: '2b3', vel: 0.26, lo: 67, hi: 83, voices: 2 },
      { role: 'arp', inst: 'harp', in: 'i123b', vel: 0.3, lo: 60, hi: 88, rate: 0.5, seq: [0, 1, 2, 3, 4, 5, 6, 5] },
      { role: 'lead', inst: 'horn', in: '1', vel: 0.55, oct: -2 },
      { role: 'lead', inst: 'flute', in: '2', vel: 0.58 },
      { role: 'lead', inst: 'oboe', in: 'b', vel: 0.52, oct: -1 },
      { role: 'lead', inst: 'horn', in: '3', vel: 0.62, oct: -2 },
      { role: 'lead', inst: 'glock', in: '3o', vel: 0.22, oct: 1 },
      { role: 'perc', inst: 'timpani', in: '13', vel: 0.28, steps: [[0, 0, 1]] },
    ],
    forms: ['i12b3o', 'i123o', 'i1b3o'],
  },

  /* Space, and the Moon. As slow as the score gets and nearly weightless:
     hand chimes with the tune, vibraphone and harp glinting, strings high
     and thin. E lydian over an E pedal, so nothing ever lands. */
  orbit: {
    id: 'orbit',
    title: 'Quiet Orbit',
    bpm: 54,
    meter: 4,
    key: 4,
    scale: MAJOR,
    A: ['Emaj7', 'F#/E', 'C#m7', 'Amaj7#11', 'Emaj7', 'F#/E', 'C#m7', 'Amaj7#11'],
    B: ['Amaj7', 'G#m7', 'F#m7', 'Emaj7', 'Amaj7', 'G#m7', 'F#m7', 'Bsus4'],
    theme: 'G#5/2 B5/2 | A#5/4 | G#5 E5 C#6/2 | B5/4 | E6/2 D#6/2 | C#6/4 | B5/2 G#5/2 | A#5/4',
    end: 'Emaj9',
    layers: [
      { role: 'bass', inst: 'celli', in: 'i123bo', vel: 0.3, lo: 40, hi: 52, steps: [[0, 'R', 4]] },
      { role: 'pad', inst: 'violins', in: 'i123bo', vel: 0.2, lo: 68, hi: 84, voices: 3 },
      { role: 'arp', inst: 'vibes', in: 'i123b', vel: 0.28, lo: 60, hi: 80, rate: 1, seq: [0, 2, 3, 1] },
      { role: 'arp', inst: 'harp', in: '2b3', vel: 0.2, lo: 72, hi: 91, rate: 0.5, seq: [0, 2, 1, 3, 2, 4, 3, 1] },
      { role: 'lead', inst: 'chimes', in: '1', vel: 0.5 },
      { role: 'lead', inst: 'flute', in: '2', vel: 0.45 },
      { role: 'lead', inst: 'vibes', in: 'b', vel: 0.5 },
      { role: 'lead', inst: 'chimes', in: '3o', vel: 0.5 },
    ],
    forms: ['i12b3o', 'i123o', 'i1b3o'],
  },
}
