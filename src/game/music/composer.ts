/*
  Turns one piece of `score.ts` into one performance: a flat, time-sorted
  list of notes, in beats, for `index.ts` to schedule. Pure and React-free,
  deterministic for a given `rand`, so a probe in Node can print a
  performance and count what is in it.

  What is written is played as written: the themes note for note, the chords
  where the score puts them. What is generated is generated *from* that, the
  way an arranger works rather than the way a random walk does:

  - Pads and struck chords are voice-led: each chord keeps the thirds and
    sevenths that define it, and each voice moves to the nearest tone of the
    next chord (every assignment of voices is tried, there are at most 24),
    so a string section glides between chords instead of jumping in blocks.
  - The bass walks: roots and fifths where the score says, and a chromatic
    or scale step into the next chord's root where it says `>`.
  - The B section's melody borrows the theme's own bar rhythms, laid out as
    a small form (x x' y z), and picks pitches with two rules a first-year
    harmony student learns: chord tones on strong beats, scale tones between,
    stepwise by preference, arching toward a peak and landing on the chord at
    the cadence. Bars 5-6 restate bars 1-2 moved onto the new chords, which
    is what makes a generated line sound like it is *about* something.
  - The counter-line holds guide tones (thirds and sevenths) under the tune,
    stepping aside when the tune lands on the same pitch class.

  Velocity follows the form (the last A is the loudest, the outro the
  softest) and a gentle arch over each four-bar phrase; the performer in
  index.ts then humanizes timing and velocity by a few percent.
*/

import { chordPcs, noteMidi, parseBars, parseLine, type Chord, type Layer, type Mood, type Note, type Piece } from './score'
import type { HitId, PitchedId } from './samples'

export interface Ev {
  /** onset and length in beats */
  t: number
  d: number
  inst: PitchedId | HitId
  /** MIDI note for pitched instruments, the hit's index for unpitched */
  midi: number
  /** 0..1 */
  vel: number
  hit?: true
  /** a lead note: the performer gives it a touch of legato */
  lead?: true
}

export interface Performance {
  mood: Mood
  title: string
  form: string
  /** seconds per beat */
  spb: number
  /** where the last note starts, in beats; the piece is over a few beats later */
  beats: number
  events: Ev[]
  /** every instrument the performance uses, so they can be loaded first */
  instruments: Set<PitchedId | HitId>
}

const SECTION_DYN: Record<string, number> = { i: 0.82, '1': 0.92, '2': 1, b: 0.96, '3': 1.08, o: 0.8 }

const clampOct = (m: number, lo: number, hi: number) => {
  while (m < lo) m += 12
  while (m > hi) m -= 12
  return m
}

/** the instance of pitch class `pc` inside [lo, hi] nearest `near` */
const nearestPc = (pc: number, near: number, lo: number, hi: number) => {
  let best = Number.NaN
  for (let m = lo; m <= hi; m++) {
    if (((m % 12) + 12) % 12 !== pc) continue
    if (Number.isNaN(best) || Math.abs(m - near) < Math.abs(best - near)) best = m
  }
  return Number.isNaN(best) ? clampOct(pc + 60, lo, hi) : best
}

/** the pitch classes worth keeping when a chord has to fit in n voices:
    the third and the colour tones first, the fifth last */
const priority = (c: Chord): number[] => {
  const iv = c.ivs
  const order = [iv[1], iv[3], iv[4], iv[0], iv[2]].filter((x) => x !== undefined)
  const pcs: number[] = []
  for (const x of order) {
    const pc = (c.root + x) % 12
    if (!pcs.includes(pc)) pcs.push(pc)
  }
  return pcs
}

const permutations = (a: number[]): number[][] =>
  a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]))

/** n voices of chord c in [lo, hi], moved as little as possible from prev */
const voiceLead = (c: Chord, prev: number[] | null, n: number, lo: number, hi: number): number[] => {
  const pcs = priority(c).slice(0, n)
  while (pcs.length < n) pcs.push(pcs[pcs.length % Math.max(1, pcs.length)])
  if (!prev || prev.length !== n) {
    // close position from a little under the middle of the range
    let at = Math.round((lo + hi) / 2) - 5
    const out: number[] = []
    for (const pc of [...pcs].sort((a, b) => ((a - c.root + 12) % 12) - ((b - c.root + 12) % 12))) {
      const m = nearestPc(pc, at + 2, lo, hi)
      out.push(m)
      at = m + 1
    }
    return out.sort((a, b) => a - b)
  }
  let best: number[] = []
  let cost = Infinity
  for (const perm of permutations(pcs)) {
    const cand = perm.map((pc, i) => nearestPc(pc, prev[i], lo, hi))
    const sorted = [...cand].sort((a, b) => a - b)
    // unisons waste a voice; tiny penalty for them
    let k = cand.reduce((s, m, i) => s + Math.abs(m - prev[i]), 0)
    for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) k += 6
    if (k < cost) {
      cost = k
      best = sorted
    }
  }
  return best
}

/** chord tones from the root's lowest instance >= lo, ascending to hi */
const arpTones = (c: Chord, lo: number, hi: number): number[] => {
  const pcs = chordPcs(c)
  let start = lo
  while (((start % 12) + 12) % 12 !== c.root) start++
  const out: number[] = []
  for (let m = start; m <= hi; m++) if (pcs.includes(((m % 12) + 12) % 12)) out.push(m)
  return out.length ? out : [clampOct(c.root + 60, lo, hi)]
}

const chordAt = (chords: Chord[], t: number) => {
  for (let i = chords.length - 1; i >= 0; i--) if (chords[i].t <= t + 1e-6) return chords[i]
  return chords[0]
}

const inScale = (p: Piece, m: number) => p.scale.includes((((m - p.key) % 12) + 12) % 12)

/** a theme string without its bar lines */
const themeNotes = (p: Piece, t0: number): Note[] => parseLine(p.theme.replace(/\|/g, ' '), t0)

/** the theme's rhythm, one cell per bar: [offset in bar, beats, rest?] */
const themeCells = (p: Piece): [number, number, boolean][][] => {
  const cells: [number, number, boolean][][] = []
  for (const bar of p.theme.split('|')) {
    const cell: [number, number, boolean][] = []
    let t = 0
    for (const tok of bar.trim().split(/\s+/)) {
      const [n, b] = tok.split('/')
      const d = b === undefined ? 1 : Number(b)
      cell.push([t, d, n === 'r'])
      t += d
    }
    cells.push(cell)
  }
  return cells
}

/** the B section's melody (see the header) */
const bMelody = (p: Piece, chords: Chord[], t0: number, rand: () => number): Note[] => {
  const theme = themeNotes(p, 0)
  const lo = Math.min(...theme.map((n) => n.midi))
  const hi = Math.max(...theme.map((n) => n.midi))
  const mid = (lo + hi) / 2
  const cells = themeCells(p)
  // the longest-held bar is the cadence cell
  const cadence = cells.reduce((b, c, i) => (Math.max(...c.map((x) => x[1])) > Math.max(...cells[b].map((x) => x[1])) ? i : b), 0)
  const pickCell = () => cells[Math.floor(rand() * cells.length)]
  const x0 = pickCell()
  const x1 = pickCell()
  const y0 = pickCell()
  const y1 = pickCell()
  const z0 = pickCell()
  const plan = [x0, x1, y0, y1, x0, x1, z0, cells[cadence]]
  const strongAt = p.meter === 6 ? [0, 3] : p.meter === 4 ? [0, 2] : [0]
  const out: Note[] = []
  let prev = theme[0].midi
  const bars01: Note[] = []
  for (let bar = 0; bar < 8; bar++) {
    const barT = t0 + bar * p.meter
    const cell = plan[bar]
    const echo = bar === 4 || bar === 5
    cell.forEach(([off, d, rest], k) => {
      if (rest) return
      const t = barT + off
      const c = chordAt(chords, t)
      const pcs = chordPcs(c)
      const strong = strongAt.includes(off) || d >= 1.5
      const last = bar === 7 && k === cell.length - 1 - (cell[cell.length - 1][2] ? 1 : 0)
      let m: number
      if (echo && bars01.length) {
        // restate bars 1-2 on the new chords: same shape, snapped to fit
        // restate bars 1-2 on the new chords: the first note starts from
        // the chord, every later one keeps the interval the original moved by
        const src = bars01.find((n) => Math.abs(n.t - (t - 4 * p.meter)) < 1e-6)
        const i = src ? bars01.indexOf(src) : -1
        m = !src ? prev : i <= 0 ? src.midi : prev + (src.midi - bars01[i - 1].midi)
        m = Math.max(lo, Math.min(hi, m))
        m = strong
          ? nearestPc(pcs.reduce((b, pc) => (Math.abs(nearestPc(pc, m, lo, hi) - m) < Math.abs(nearestPc(b, m, lo, hi) - m) ? pc : b), pcs[0]), m, lo, hi)
          : snapScale(p, m, lo, hi)
      } else {
        const phase = (bar % 4 + off / p.meter) / 4
        const target = mid + (hi - lo) * 0.45 * Math.sin(Math.PI * phase) * (bar < 4 ? 0.8 : 1) - (hi - lo) * 0.15
        const pool: number[] = []
        for (let q = Math.max(lo, prev - 9); q <= Math.min(hi, prev + 9); q++) {
          const pc = ((q % 12) + 12) % 12
          if (last ? pc === c.root || pc === (c.root + c.ivs[1]) % 12 : strong ? pcs.includes(pc) : inScale(p, q)) pool.push(q)
        }
        if (!pool.length) pool.push(nearestPc(c.root, prev, lo, hi))
        const w = pool.map((q) => {
          const step = Math.abs(q - prev)
          const again = q === prev ? 0.35 : 1
          return again * Math.exp(-step / (strong ? 3.5 : 2)) * Math.exp(-Math.abs(q - target) / 4)
        })
        let r = rand() * w.reduce((a, b) => a + b, 0)
        let i = 0
        while (i < w.length - 1 && (r -= w[i]) > 0) i++
        m = pool[i]
      }
      const n = { t, d, midi: m }
      out.push(n)
      if (bar < 2) bars01.push({ t: t, d, midi: m })
      prev = m
    })
  }
  return out
}

const snapScale = (p: Piece, m: number, lo: number, hi: number) => {
  let q = Math.max(lo, Math.min(hi, m))
  for (let k = 0; k < 3 && !inScale(p, q); k++) q += q > (lo + hi) / 2 ? -1 : 1
  return q
}

/** guide tones under the melody, one per chord */
const counterLine = (chords: Chord[], melody: Note[], lo: number, hi: number): Note[] => {
  const out: Note[] = []
  let prev = Math.round((lo + hi) / 2)
  for (const c of chords) {
    const guides = [c.ivs[1], c.ivs[3] ?? c.ivs[2]].map((iv) => (c.root + iv) % 12)
    const clash = melody.find((n) => Math.abs(n.t - c.t) < 0.26)
    let pcs = guides
    if (clash) pcs = guides.filter((pc) => pc !== clash.midi % 12).concat(guides)
    const m = pcs
      .map((pc) => nearestPc(pc, prev, lo, hi))
      .reduce((b, x) => (Math.abs(x - prev) < Math.abs(b - prev) ? x : b))
    out.push({ t: c.t, d: c.d - 0.08, midi: m })
    prev = m
  }
  return out
}

export function compose(piece: Piece, rand: () => number): Performance {
  const form = piece.forms[Math.floor(rand() * piece.forms.length)]
  const events: Ev[] = []
  const instruments = new Set<PitchedId | HitId>()
  const M = piece.meter
  let t0 = 0
  const add = (e: Ev) => {
    events.push(e)
    instruments.add(e.inst)
  }
  const prevVoicing = new Map<Layer, number[]>()
  let bassPrev = 0
  let bLine: Note[] | null = null

  for (const sec of form) {
    const bars = sec === 'i' ? piece.A.slice(0, 2) : sec === 'b' ? piece.B : sec === 'o' ? [piece.end, piece.end] : piece.A
    const chords = parseBars(bars, M, t0)
    const len = bars.length * M
    const dyn = SECTION_DYN[sec] ?? 1
    const arch = (t: number) => 0.92 + 0.12 * Math.sin((Math.PI * (((t - t0) / M) % 4)) / 4)
    const outro = sec === 'o'
    // the melody for this section, if any lead plays it
    let melody: Note[] = []
    if (sec === 'b') melody = bLine ??= bMelody(piece, chords, t0, rand)
    else if ('123'.includes(sec)) melody = themeNotes(piece, t0)
    else if (outro) {
      const first = themeNotes(piece, 0)[0].midi
      const c = chords[0]
      melody = [{ t: t0, d: 2 * M - 0.5, midi: nearestPc((c.root + c.ivs[1]) % 12, first, first - 7, first + 7) }]
    }

    for (const L of piece.layers) {
      if (!L.in.includes(sec)) continue
      const v = L.vel * dyn
      switch (L.role) {
        case 'lead': {
          const sparse = L.inst === 'glock'
          for (const n of melody) {
            if (sparse && !outro && (n.d < 1 || (n.t - t0) % 1 !== 0)) continue
            add({ t: n.t, d: n.d, inst: L.inst, midi: n.midi + 12 * (L.oct ?? 0), vel: v * arch(n.t), lead: true })
          }
          break
        }
        case 'counter':
          for (const n of counterLine(chords, melody, L.lo, L.hi)) add({ t: n.t, d: n.d, inst: L.inst, midi: n.midi, vel: v * arch(n.t) })
          break
        case 'bass': {
          chords.forEach((c, ci) => {
            const next = chords[ci + 1] ?? chords[0]
            const barStart = t0 + Math.floor((c.t - t0) / M) * M
            for (let bar = barStart; bar < c.t + c.d - 1e-6; bar += M) {
              for (const [beat, deg, d, acc] of L.steps) {
                const t = bar + beat
                if (t < c.t - 1e-6 || t >= c.t + c.d - 1e-6) continue
                if (outro && t > t0) continue
                let pc = c.bass
                if (deg === '5') pc = (c.root + 7) % 12
                else if (deg === '3') pc = (c.root + c.ivs[1]) % 12
                let m = nearestPc(pc, bassPrev || (L.lo + L.hi) / 2, L.lo, L.hi)
                if (deg === '8') m = nearestPc(c.bass, (L.lo + L.hi) / 2, L.lo, L.hi - 12) + 12
                if (deg === '>') {
                  const target = nearestPc(next.bass, bassPrev || m, L.lo, L.hi)
                  const up = target + 2
                  m = inScale(piece, up) && rand() < 0.5 ? up : target - 1
                }
                const dd = outro ? 2 * M - 0.5 : Math.min(d, c.t + c.d - t)
                add({ t, d: dd, inst: L.inst, midi: m, vel: v * (acc ?? 1) * arch(t) })
                if (deg !== '>') bassPrev = m
              }
            }
          })
          break
        }
        case 'arp': {
          let k = 0
          for (const c of chords) {
            const tones = arpTones(c, L.lo, L.hi)
            for (let t = c.t; t < c.t + c.d - 1e-6; t += L.rate) {
              if (outro && t >= t0 + M) break
              const m = tones[L.seq[k % L.seq.length] % tones.length]
              const down = (t - t0) % M === 0
              add({ t, d: L.ring ?? L.rate * 2, inst: L.inst, midi: m, vel: v * (down ? 1.12 : 0.92) * arch(t) })
              k++
            }
          }
          if (outro) {
            // and one last high tone to ring out on
            const tones = arpTones(chords[0], L.lo, L.hi)
            add({ t: t0 + M, d: M, inst: L.inst, midi: tones[Math.min(tones.length - 1, 4)], vel: v * 0.9 })
          }
          break
        }
        case 'block': {
          let prev = prevVoicing.get(L) ?? null
          for (const c of chords) {
            const voicing = voiceLead(c, prev, L.voices, L.lo, L.hi)
            prev = voicing
            const barStart = t0 + Math.floor((c.t - t0) / M) * M
            for (let bar = barStart; bar < c.t + c.d - 1e-6; bar += M) {
              for (const at of L.at) {
                const t = bar + at
                if (t < c.t - 1e-6 || t >= c.t + c.d - 1e-6) continue
                // a chord is a strum, not a slab: the voices land a hair apart
                voicing.forEach((m, i) => add({ t: t + i * 0.012, d: L.d, inst: L.inst, midi: m, vel: v * arch(t) * (i === voicing.length - 1 ? 1.05 : 0.9) }))
              }
            }
          }
          prevVoicing.set(L, prev ?? [])
          break
        }
        case 'pad': {
          let prev = prevVoicing.get(L) ?? null
          for (const c of chords) {
            const voicing = voiceLead(c, prev, L.voices, L.lo, L.hi)
            // held tones are not re-bowed when the chord changes around them
            voicing.forEach((m) => add({ t: c.t, d: (outro ? 2 * M - 0.25 : c.d) + 0.12, inst: L.inst, midi: m, vel: v * arch(c.t) }))
            prev = voicing
            if (outro) break
          }
          prevVoicing.set(L, prev ?? [])
          break
        }
        case 'perc': {
          for (let bar = t0; bar < t0 + len; bar += M) {
            if (outro && bar > t0) break
            for (const [beat, which, acc] of L.steps) {
              if (outro && beat > 0) continue
              add({ t: bar + beat, d: 1, inst: L.inst, midi: which, vel: v * acc, hit: true })
            }
          }
          break
        }
      }
    }
    t0 += len
  }

  // swing the off-beat halves
  if (piece.swing) {
    for (const e of events) {
      const f = e.t % 1
      if (Math.abs(f - 0.5) < 0.02) e.t += piece.swing * 0.5
    }
  }
  events.sort((a, b) => a.t - b.t)
  return {
    mood: piece.id,
    title: piece.title,
    form,
    spb: 60 / piece.bpm,
    beats: t0,
    events,
    instruments,
  }
}

/** a probe's view of a piece: every bar of the theme adds up to the meter,
    every note parses, every chord parses. Empty when the score is sound */
export function checkPiece(p: Piece): string[] {
  const errs: string[] = []
  p.theme.split('|').forEach((bar, i) => {
    let t = 0
    for (const tok of bar.trim().split(/\s+/)) {
      const [n, b] = tok.split('/')
      try {
        if (n !== 'r') noteMidi(n)
      } catch {
        errs.push(`${p.id} bar ${i + 1}: bad note ${n}`)
      }
      t += b === undefined ? 1 : Number(b)
    }
    if (Math.abs(t - p.meter) > 1e-6) errs.push(`${p.id} bar ${i + 1}: ${t} beats, not ${p.meter}`)
  })
  if (p.theme.split('|').length !== p.A.length) errs.push(`${p.id}: theme has ${p.theme.split('|').length} bars, A has ${p.A.length}`)
  for (const bars of [p.A, p.B, [p.end]]) {
    try {
      parseBars(bars, p.meter)
    } catch (e) {
      errs.push(`${p.id}: ${(e as Error).message}`)
    }
  }
  return errs
}
