/*
  The walk's preferences: what they are, what they may be, and where they are
  kept between visits.

  They are read in two places that must not drift apart — CrtScene owns them
  and the pause screen edits them — so the shape, the defaults, the storage key
  and the validation live here rather than half in each. The frame limiter is
  the reason this became its own module: its dial has *detents*, and a list of
  detents that only the menu knows about is a list the loader will happily
  accept a value from between.

  Two of them are graphics knobs and they are deliberately different in kind,
  because the renderer is. `scale` is live: it is one number on the renderer
  and moving it repaints the next frame. `detail` is not: `world/quality.ts`
  is baked into merged chunk geometry, two grass lattices and one #define in
  the sky shader at construction time, so choosing it is a statement about the
  next load. The menu is the one place that difference is visible, so the menu
  is where it has to be said out loud rather than papered over.

  Nothing in here touches the renderer or React; it is a record, a whitelist
  and a parser.
*/

import type { GfxTier } from '../../game/world/quality'

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

/** how far the render-scale dial may pull the renderer's pixel ratio down.
    It only sheds: 1 is the panel's own ratio (itself already capped at 2, past
    which the returns vanish and the cost keeps squaring), and the bottom is
    where a 1x screen still reads as a picture rather than as a mosaic */
export const SCALE_MIN = 0.5
export const SCALE_MAX = 1

/** the roam preferences the pause menu edits; the seated view stays fixed */
export interface RoamPrefs {
  fov: number
  sens: number
  third: boolean
  /** frames per second the walk is allowed to draw; 0 is uncapped */
  cap: number
  /** how much world to build: the tier override, applied on the next load */
  detail: Detail
  /** multiplier on the renderer's pixel ratio, and the ceiling the adaptive
      governor sheds from. Live */
  scale: number
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
  The frame limiter ships *on*, at 160, rather than uncapped or at the panel's
  own rate. This scene will happily draw as many frames as a card will give it,
  and on a fast one that means a room and a planet rendered three hundred times
  a second so that a browser tab can run hot enough to hear. 160 is above every
  common panel rate the walk is likely to be watched on except 240, so the
  default costs nobody a frame they could see, and the dial is there for anyone
  who disagrees in either direction.
*/
export const PREFS_KEY = 'alejos-roam-prefs'
const PREFS_DEFAULT: RoamPrefs = {
  fov: 60, sens: 1, third: false, cap: 160, detail: 'auto', scale: 1,
}

export const loadPrefs = (): RoamPrefs => {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Record<keyof RoamPrefs, unknown>>
      return {
        fov: Math.min(80, Math.max(30, Number(p.fov) || PREFS_DEFAULT.fov)),
        sens: Math.min(3, Math.max(0.3, Number(p.sens) || PREFS_DEFAULT.sens)),
        third: p.third === true,
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
      }
    }
  } catch {
    /* private mode, or something that is not our JSON: the defaults */
  }
  return { ...PREFS_DEFAULT }
}
