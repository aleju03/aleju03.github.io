/*
  The walk's preferences: what they are, what they may be, and where they are
  kept between visits.

  They are read in two places that must not drift apart — CrtScene owns them
  and the pause screen edits them — so the shape, the defaults, the storage key
  and the validation live here rather than half in each. The frame limiter is
  the reason this became its own module: its dial has *detents*, and a list of
  detents that only the menu knows about is a list the loader will happily
  accept a value from between.

  Nothing in here touches the renderer or React; it is a record, a whitelist
  and a parser.
*/

/** the roam preferences the pause menu edits; the seated view stays fixed */
export interface RoamPrefs {
  fov: number
  sens: number
  third: boolean
  /** frames per second the walk is allowed to draw; 0 is uncapped */
  cap: number
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
const PREFS_DEFAULT: RoamPrefs = { fov: 60, sens: 1, third: false, cap: 160 }

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
      }
    }
  } catch {
    /* private mode, or something that is not our JSON: the defaults */
  }
  return { ...PREFS_DEFAULT }
}
