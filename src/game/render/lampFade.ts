import { MAX_POOLS } from './shaders'

/*
  How a lamp pool comes and goes.

  The look shades only the nearest few lamps (MAX_POOLS), and which few is
  re-asked every few units of travel. A lamp joining that set used to arrive
  at full strength on the frame it joined, and one leaving it vanished, so
  walking through the house at night the rooms ahead lit up in steps and the
  street's pools blinked on at the edge of the set. The shader cannot fade
  what it is not told about, and it must not be told with a define (that is
  a relink mid-walk), so the fade is a weight per pool, a uniform like the
  rest (shaders.ts's `uPoolW`), and this is the bookkeeping behind it.

  Every lamp the scene wants lit gets a slot and a weight that climbs toward
  its target over a fraction of a second; a lamp that drops out of the
  wanted set keeps its slot while its weight falls, and only then gives it
  up. The target itself eases with distance for indoor lamps (a negative
  radius), so a pool across the house is already dim before it can be
  swapped out for a nearer one. Lamps are matched by position, which is
  exact: both the house's and the streets' come out of fixed tables.

  The caller asks for fewer lamps than there are slots (`WANT_MAX`), which
  leaves room for the ones still fading out. If it ever runs out anyway, the
  faintest of those goes first.
*/

/** how many lamps a caller should ask for, leaving slots to fade out in */
export const WANT_MAX = MAX_POOLS - 4
/** weight per second, both ways: about two thirds of a second end to end */
const RATE = 1.6
/** an indoor pool is full inside NEAR (the gather's storey-weighted
    distance) and gone by FAR */
const NEAR = 15
const FAR = 26

interface Slot {
  x: number
  y: number
  z: number
  r: number
  w: number
  wanted: boolean
}

export interface LampFader {
  /** the lamps that should be lit now: xyz per lamp and a radius per lamp
      (negative indoors), `count` of them, at most WANT_MAX */
  want: (xyz: Float32Array, radii: Float32Array, count: number) => void
  /** advance the fades by `dt` seconds for a lens at (px, py, pz) and write
      every lamp still showing into the out arrays; returns how many */
  step: (
    dt: number, px: number, py: number, pz: number,
    outXyz: Float32Array, outR: Float32Array, outW: Float32Array,
  ) => number
}

const smooth = (t: number) => t * t * (3 - 2 * t)

export const createLampFader = (): LampFader => {
  const slots: Slot[] = []

  const want = (xyz: Float32Array, radii: Float32Array, count: number) => {
    for (const s of slots) s.wanted = false
    const n = Math.min(count, WANT_MAX)
    for (let i = 0; i < n; i++) {
      const x = xyz[i * 3]
      const y = xyz[i * 3 + 1]
      const z = xyz[i * 3 + 2]
      let s = slots.find((o) => o.x === x && o.y === y && o.z === z)
      if (!s) {
        if (slots.length >= MAX_POOLS) {
          // full of lamps on their way out: the faintest goes now
          let k = -1
          for (let j = 0; j < slots.length; j++) {
            if (!slots[j].wanted && (k < 0 || slots[j].w < slots[k].w)) k = j
          }
          if (k < 0) continue
          slots.splice(k, 1)
        }
        s = { x, y, z, r: radii[i], w: 0, wanted: true }
        slots.push(s)
      }
      s.r = radii[i]
      s.wanted = true
    }
  }

  const step = (
    dt: number, px: number, py: number, pz: number,
    outXyz: Float32Array, outR: Float32Array, outW: Float32Array,
  ) => {
    const d = Math.min(Math.max(dt, 0), 0.1) * RATE
    let n = 0
    for (let i = slots.length - 1; i >= 0; i--) {
      const s = slots[i]
      let target = 0
      if (s.wanted) {
        if (s.r < 0) {
          // the same storey-weighted distance the house's gather sorts by
          const dist = Math.sqrt((s.x - px) ** 2 + (s.z - pz) ** 2 + 4 * (s.y - py) ** 2)
          target = 1 - smooth(Math.min(1, Math.max(0, (dist - NEAR) / (FAR - NEAR))))
        } else target = 1
      }
      s.w = s.w < target ? Math.min(target, s.w + d) : Math.max(target, s.w - d)
      if (!s.wanted && s.w <= 0) slots.splice(i, 1)
    }
    for (const s of slots) {
      if (s.w <= 0 || n >= MAX_POOLS) continue
      outXyz[n * 3] = s.x
      outXyz[n * 3 + 1] = s.y
      outXyz[n * 3 + 2] = s.z
      outR[n] = s.r
      outW[n] = smooth(s.w)
      n++
    }
    return n
  }

  return { want, step }
}
