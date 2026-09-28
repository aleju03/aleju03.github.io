import { burst, impactSound, mode, placedVoice } from '../impactSounds'
import type { WeaponEvent } from './weapons'

/*
  The weapons' voices, synthesized like every other sound in the runtime and
  played through the props' own bus (impactSounds.ts's `placedVoice`): the
  same distance law, stereo placement, speed of sound and voice budget, and
  the same limiter, so somebody firing down the street is heard down the
  street and a gunfight next to a chain of barrels does not clip.

  **The pistol** is a crack (a burst of high noise a few hundredths long)
  over a short swept body and a low thump, with a tail of filtered noise for
  the report bouncing off whatever is round it, and the slide's clack
  behind it if it is your own. **The crossbow** is a twang: a string's
  three partials ringing down with a slight sag in pitch, a dry snap as the
  latch lets go and a thin whoosh of the bolt leaving. **The rocket** is
  the igniter's snap and the tube's low punch, then the motor: a roar that
  swells in and brightens for a tenth of a second and darkens as it gets
  away (`roar`, because `burst` strikes and a motor catching does not),
  with a rumble under it and a thin crackle on top. It was a thump under a
  hiss sweeping down, which read as gas escaping rather than as a rocket
  leaving. Impacts are the props' own surface voices (a pistol round on a
  crate sounds like wood being hit hard) plus, for the pistol on stone, a
  ricochet one time in four; a bolt going in is a thunk and the shaft
  buzzing. A rocket's bang is the explosion's own boom.

  Levels were measured against the mix, not against a normalized file
  (`npm run drive -- weapons` prints them, rendered offline through this
  bus at arm's length): a crate hit hard peaks at 0.18, a crate breaking at
  0.14 and a red barrel's boom at 0.58; the pistol sits a little over the
  crate (0.22), the crossbow a little under it (0.16), a bolt going in with
  it (0.15), the launch a touch under the pistol (0.22: its peak is lower,
  but it lasts a second where the pistol's crack lasts a twentieth), and your
  own reload clicks well under all of them (0.03).
*/

const jit = (k = 0.06) => 1 + (Math.random() * 2 - 1) * k

type Out = NonNullable<ReturnType<typeof placedVoice>>

/** a second of white noise per context, looped from a random offset */
const noiseFor = new WeakMap<BaseAudioContext, AudioBuffer>()
const noise = (a: BaseAudioContext) => {
  let b = noiseFor.get(a)
  if (!b) {
    b = a.createBuffer(1, a.sampleRate, a.sampleRate)
    const d = b.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    noiseFor.set(a, b)
  }
  return b
}

/**
 * Noise that swells in rather than striking: `burst` opens in 4 ms, which is
 * a hit, and a motor catching is not a hit. The filter's corner rides its own
 * envelope, up from `f0` to `f1` while the gain swells over `rise` and back
 * down to `f2` as it dies over `dur`, which is the "fwoosh" of something
 * getting away from you rather than a hiss of gas
 */
const roar = (
  o: Out, type: BiquadFilterType, q: number, gain: number,
  f0: number, f1: number, f2: number, rise: number, dur: number, delay = 0,
) => {
  const { a, at } = o
  const t = at + delay
  const src = a.createBufferSource()
  src.buffer = noise(a)
  src.loop = true
  const f = a.createBiquadFilter()
  f.type = type
  f.Q.value = q
  f.frequency.setValueAtTime(f0, t)
  f.frequency.exponentialRampToValueAtTime(f1, t + rise)
  f.frequency.exponentialRampToValueAtTime(f2, t + dur)
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + rise)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(o.node)
  src.start(t, Math.random() * 0.6)
  src.stop(t + dur + 0.03)
}

export interface WeaponSfx {
  play: (e: WeaponEvent, ear: { x: number; y: number; z: number }) => void
}

export function createWeaponSfx(): WeaponSfx {
  const shot = (w: string, x: number, y: number, z: number, mine: boolean) => {
    if (w === 'pistol') {
      const o = placedVoice('pistol', x, y, z, 0.18, 26)
      if (!o) return
      burst(o, 'highpass', 2200 * jit(), 0.7, 1, 0.05)
      burst(o, 'bandpass', 950 * jit(), 0.9, 0.75, 0.12, 0.002, 320)
      mode(o, 150 * jit(), 0.8, 0.11, 0, 0.5)
      burst(o, 'lowpass', 1700, 0.6, 0.22, 0.4, 0.025)
      if (mine) burst(o, 'bandpass', 3100, 2.2, 0.28, 0.022, 0.045)
    } else if (w === 'crossbow') {
      const o = placedVoice('crossbow', x, y, z, 0.12, 18)
      if (!o) return
      const f = 112 * jit(0.04)
      burst(o, 'bandpass', 1700, 1.2, 0.6, 0.04)
      mode(o, f, 1, 0.38, 0, 0.93)
      mode(o, f * 2.01, 0.5, 0.26, 0, 0.95)
      mode(o, f * 3.03, 0.3, 0.17)
      burst(o, 'highpass', 2800, 0.7, 0.3, 0.14, 0.01, 6200)
    } else {
      const o = placedVoice('rocket', x, y, z, 0.31, 30)
      if (!o) return
      // the igniter's snap, then the tube's low punch as the charge kicks
      burst(o, 'bandpass', 1500 * jit(), 1.4, 0.35, 0.025)
      mode(o, 96 * jit(), 0.8, 0.26, 0.004, 0.45)
      // the motor catching: a roar that swells in and brightens over the
      // first tenth of a second, then darkens and fades as it gets away
      roar(o, 'lowpass', 0.8, 0.9, 420, 2600 * jit(), 650, 0.07, 1.05, 0.01)
      // its body, the rumble under the roar, and a thin crackle riding on it
      roar(o, 'bandpass', 0.9, 0.55, 140, 230, 90, 0.05, 0.8, 0.01)
      roar(o, 'bandpass', 2.5, 0.12, 3800, 4400, 2200, 0.05, 0.5, 0.03)
    }
  }

  const hit = (e: Extract<WeaponEvent, { type: 'hit' }>) => {
    const { x, y, z } = e
    if (e.w === 'rocket') return
    if (e.what === 'water') {
      const o = placedVoice('splash', x, y, z, 0.12, 16)
      if (!o) return
      burst(o, 'lowpass', 1400, 0.7, 0.8, 0.18, 0, 500)
      mode(o, 420 * jit(), 0.3, 0.08, 0, 1.6)
      return
    }
    if (e.w === 'crossbow') {
      if (e.what === 'player' || e.what === 'person') {
        impactSound('soft', 1, 60, x, y, z)
        return
      }
      const o = placedVoice('bolt', x, y, z, 0.16, 18)
      if (!o) return
      burst(o, 'bandpass', 900 * jit(), 1, 0.7, 0.05)
      mode(o, 180 * jit(), 1, 0.12, 0, 0.7)
      // the shaft buzzing where it stuck
      mode(o, 245 * jit(), 0.35, 0.4, 0.01, 0.97)
      mode(o, 490 * jit(), 0.15, 0.25, 0.01)
      return
    }
    // a pistol round: the surface's own voice, hit hard and light
    const surface = (e.surface === 'water' ? 'soft' : e.surface) as Parameters<typeof impactSound>[0]
    impactSound(e.what === 'player' || e.what === 'person' ? 'soft' : surface || 'concrete', 0.7, 12, x, y, z)
    if ((e.what === 'world' || e.what === 'vehicle') && Math.random() < 0.25) {
      const o = placedVoice('ricochet', x, y, z, 0.07, 20)
      if (!o) return
      mode(o, 2700 * jit(0.15), 1, 0.28, 0.01, 0.62)
      burst(o, 'bandpass', 3400, 3, 0.4, 0.2, 0.01, 1900)
    }
  }

  return {
    play: (e, ear) => {
      if (e.type === 'fire') shot(e.w, e.x, e.y, e.z, e.mine)
      else if (e.type === 'hit') hit(e)
      else if (e.type === 'empty') {
        const o = placedVoice('dry', ear.x, ear.y, ear.z, 0.08, 10)
        if (o) burst(o, 'bandpass', 3600, 4, 0.8, 0.018)
      } else if (e.type === 'reload') {
        // a magazine out, one in, and the slide let go
        const o = placedVoice('reload', ear.x, ear.y, ear.z, 0.09, 10)
        if (!o) return
        burst(o, 'bandpass', 2400, 3, 0.7, 0.03, 0.05)
        burst(o, 'bandpass', 1800, 3, 0.8, 0.04, 0.55)
        mode(o, 320, 0.3, 0.05, 0.55)
        burst(o, 'bandpass', 3000, 2.5, 1, 0.035, 0.92)
      }
    },
  }
}
