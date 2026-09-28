/*
  The walk's preferences: what they are, what they may be, and where they are
  kept between visits.

  They are read in two places that must not drift apart — CrtScene owns them
  and the pause screen edits them — so the shape, the defaults, the storage key
  and the validation live here rather than half in each. The frame limiter is
  the reason this became its own module: its dial has *detents*, and a list of
  detents that only the menu knows about is a list the loader will happily
  accept a value from between.

  Three of them are graphics knobs and they are deliberately different in
  kind, because the renderer is. `pixels` is taste: how big a pixel of the
  pixel-art look (`game/render/pixelLook.ts`) is, live. `scale` is cost: a
  multiplier on the look's internal resolution, which is also the ceiling
  the adaptive governor sheds from, and it is live too, because it is one
  target size. `detail` is not: `world/quality.ts`
  is baked into merged chunk geometry, two grass lattices and one #define in
  the sky shader at construction time, so choosing it is a statement about the
  next load. The menu is the one place that difference is visible, so the menu
  is where it has to be said out loud rather than papered over.

  The music and ambience dials ride here for the same reason: the pause
  sheet moves them and `game/music` reads them every frame. The two voice
  dials, and the voice filter beside them, are here for the
  same reason the rest is: the pause sheet moves them and `proximityVoice`
  reads them off the live record every frame, and neither of those two
  modules is a place for a third copy of what a sane volume is. The filter is
  whitelisted against `voiceFilters.ts`'s own list, like `detail` is.

  Nothing in here touches the renderer or React; it is a record, a whitelist
  and a parser.
*/

import type { GfxTier } from '../../game/world/quality'
import { VOICE_FILTERS, type VoiceFilter } from './voiceFilters'

/**
  What the visitor may say about `world/quality.ts`'s tier. 'auto' trusts the
  GPU sniff, which is a regex over a driver string and is wrong in both
  directions on real hardware; the other two overrule it. Three words rather
  than a slider, because there are exactly two tuned tier records and inventing
  a third stop nobody has measured is how a menu starts lying.
*/
export const DETAILS = ['auto', 'lean', 'full'] as const
export type Detail = (typeof DETAILS)[number]

/** the tier a choice asks for, given what the sniff came back with */
export const detailTier = (detail: Detail, auto: GfxTier): GfxTier =>
  detail === 'auto' ? auto : detail === 'full' ? 'high' : 'medium'

/** how far the render-scale dial may pull the look's internal resolution
    down. It only sheds: 1 is the lines the pixel size asks for, and the
    bottom is where a picture is still a picture rather than a mosaic */
export const SCALE_MIN = 0.5
export const SCALE_MAX = 1

/**
  How big a pixel of the look is, as three words rather than a number,
  because what matters is the feel and the device-pixel size falls out of the
  screen: at "medium" a 1080p panel is an exact 2x and a 1440p one an exact
  3x. Each is a multiplier on the tier's `pixelLines`. The pause sheet deals
  them out as three prints of the live view (`pixelProofs.ts`), named
  chunky, classic and fine, biggest pixel first.
*/
export const PIXEL_SIZES = ['small', 'medium', 'large'] as const
export type PixelSize = (typeof PIXEL_SIZES)[number]
export const PIXEL_LINES_K: Record<PixelSize, number> = { small: 1.4, medium: 1, large: 0.7 }

/** how far either voice dial may be pushed. Unity is already a working level
    (`proximityVoice` carries its own makeup gain under the dial and a limiter
    after it), so the range is there for a quiet microphone or a loud room */
export const VOL_MIN = 0
export const VOL_MAX = 2

/** the roam preferences the pause menu edits; the seated view stays fixed */
export interface RoamPrefs {
  fov: number
  sens: number
  third: boolean
  /** how hot your own microphone goes out to everyone else */
  micVol: number
  /** and how loud everyone else comes back. Not per person: the mesh is
      proximity-mixed, so the useful knob is the whole room's */
  voiceVol: number
  /** which microphone and which speaker, by the browser's device id; ''
      is the system default. A device that has gone away since falls back
      to the default rather than failing (`proximityVoice`) */
  micDevice: string
  outDevice: string
  /** the soundtrack (game/music), and the world's own sound under it */
  musicVol: number
  ambVol: number
  /** what everybody else hears you through: none, or one of the silly ones.
      Applied on the sending side, live */
  voiceFx: VoiceFilter
  /** frames per second the walk is allowed to draw; 0 is uncapped */
  cap: number
  /** how much world to build: the tier override, applied on the next load */
  detail: Detail
  /** multiplier on the look's internal resolution, and the ceiling the
      adaptive governor sheds from. Live */
  scale: number
  /** how chunky the pixel art is. Live */
  pixels: PixelSize
  /** the frames-a-second strip taped to the top right corner of the walk */
  fps: boolean
}

/**
  The detents on the frame limiter, in dial order, with 0 ("no limit") at the
  far end. A list rather than a range because the useful values are a handful
  of panel rates and their halves, and a slider that can land on 137 is a
  slider that will.
*/
export const FPS_CAPS = [30, 45, 60, 75, 90, 120, 144, 160, 200, 240, 0]
export const fpsCapLabel = (cap: number) => (cap === 0 ? 'no limit' : `${cap} fps`)

/**
  The frame limiter ships *on*, at 120, rather than uncapped or at the panel's
  own rate. This scene will happily draw as many frames as a card will give it,
  and on a fast one that means a room and a planet rendered three hundred times
  a second so that a browser tab can run hot enough to hear; "the panel's own
  rate" is no answer either, because the owner's is 360. It was 160 until the
  fans on an RTX 4070 said otherwise: measured at the front gate, 160 kept the
  main thread about 32% busy and 120 about 24%, for motion nobody on a 60 or
  120 panel could tell apart. The dial is there for anyone who disagrees in
  either direction.
*/
export const PREFS_KEY = 'alejos-roam-prefs'
/** which default the stored cap was written under. The whole prefs object is
    saved on any change, so a stored 160 is usually the old default riding
    along rather than a choice; it is moved to 120 once, and a 160 picked after
    that stays picked */
const CAP_DEFAULT_KEY = 'alejos-roam-cap-default'
const OLD_CAP_DEFAULT = 160
const PREFS_DEFAULT: RoamPrefs = {
  fov: 60, sens: 1, third: false, cap: 120, detail: 'auto', scale: 1,
  pixels: 'medium', micVol: 1, voiceVol: 1, micDevice: '', outDevice: '', musicVol: 1, ambVol: 1, voiceFx: 'none',
  fps: false,
}

/** a stored volume, which may be a 0 somebody meant: `Number(x) || d` would
    quietly turn a muted dial back up on the next visit */
const vol = (raw: unknown, fallback: number) => {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(VOL_MAX, Math.max(VOL_MIN, n)) : fallback
}

export const loadPrefs = (): RoamPrefs => {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    const capUnder = localStorage.getItem(CAP_DEFAULT_KEY)
    localStorage.setItem(CAP_DEFAULT_KEY, String(PREFS_DEFAULT.cap))
    if (raw) {
      const p = JSON.parse(raw) as Partial<Record<keyof RoamPrefs, unknown>>
      if (capUnder === null && Number(p.cap) === OLD_CAP_DEFAULT) p.cap = PREFS_DEFAULT.cap
      return {
        fov: Math.min(80, Math.max(30, Number(p.fov) || PREFS_DEFAULT.fov)),
        sens: Math.min(3, Math.max(0.3, Number(p.sens) || PREFS_DEFAULT.sens)),
        third: p.third === true,
        micVol: vol(p.micVol, PREFS_DEFAULT.micVol),
        voiceVol: vol(p.voiceVol, PREFS_DEFAULT.voiceVol),
        micDevice: typeof p.micDevice === 'string' ? p.micDevice.slice(0, 200) : '',
        outDevice: typeof p.outDevice === 'string' ? p.outDevice.slice(0, 200) : '',
        musicVol: vol(p.musicVol, PREFS_DEFAULT.musicVol),
        ambVol: vol(p.ambVol, PREFS_DEFAULT.ambVol),
        voiceFx: VOICE_FILTERS.includes(p.voiceFx as VoiceFilter)
          ? (p.voiceFx as VoiceFilter)
          : PREFS_DEFAULT.voiceFx,
        // a stored cap is checked against the detents rather than clamped to
        // their range: both ends are meaningful values, and anything in
        // between is a bead pointing at no tick at all
        cap: FPS_CAPS.includes(Number(p.cap)) ? Number(p.cap) : PREFS_DEFAULT.cap,
        // likewise a whitelist, not a cast: an unknown word here would be
        // carried all the way to a tier lookup that has no entry for it
        detail: DETAILS.includes(p.detail as Detail)
          ? (p.detail as Detail)
          : PREFS_DEFAULT.detail,
        scale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(p.scale) || PREFS_DEFAULT.scale)),
        pixels: PIXEL_SIZES.includes(p.pixels as PixelSize)
          ? (p.pixels as PixelSize)
          : PREFS_DEFAULT.pixels,
        fps: p.fps === true,
      }
    }
  } catch {
    /* private mode, or something that is not our JSON: the defaults */
  }
  return { ...PREFS_DEFAULT }
}
