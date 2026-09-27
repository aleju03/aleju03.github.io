/*
  The numbers of the way up, and the way to the Moon.

  Everything here is faked on purpose. The planet is an endless plane that
  never wraps, so "the Earth" seen from orbit is a globe drawn under the
  player and painted from the same fields the ground is built from, centred
  on where they are (world/globe.ts). Space is scaled down: the Earth's
  radius is forty thousand units, the Moon three hundred thousand away,
  and flight speeds up with height so the climb takes seconds rather than
  an afternoon. Nothing here needs float precision past a few hundred
  thousand units, which float32 holds to a centimetre, and three builds
  every model-view matrix in doubles on the CPU, so a camera up there does
  not shiver.

  The climb, in bands of height over the ground under the camera:

  - to CURVE_FROM (300, past the helicopter's thin-air ceiling) nothing
    changes: the view is today's, the far field flat.
  - CURVE_FROM..CURVE_TO the far field bends onto the planet's curve and
    the globe takes over past its rim. The bend ramps in rather than
    snapping, and the globe's radius follows it, so the two always meet.
  - THIN_FROM..THIN_TO the sky thins: the clouds go first (you climb
    through them), then the day dome to dark blue and black, the fog
    goes black, the look's air drains away and the stars come out in
    daylight (sky.ts, CrtScene's dressAir).
  - GROUND_FADE..GROUND_OFF the streamed ground dithers out over the globe
    under it, and above GROUND_OFF it is hidden and stops streaming, so an
    orbit costs a globe, a Moon and the sky and nothing else.

  The Moon is a real object once you are up there: when the climb passes
  MOON_ANCHOR it is pinned MOON_DIST away along the sky moon's bearing (or a
  bearing high in the sky, by day, when the sky's moon is set), and flying
  within MOON_SEAM of its surface cuts to the 'moon' level. Leaving the Moon
  upward past MOON_LEAVE cuts back to the overworld EARTH_RETURN over the
  point you climbed from. Pure numbers and no imports, like altitude.ts, so
  the room tier can hold them before the world has loaded.
*/

/** the globe's radius, world units: the curve the far field bends onto */
export const EARTH_R = 40000
/** the Moon's radius and its distance from where you anchored it: the size
    the sky's own moon disc is drawn at, at that distance */
export const MOON_R = 9000
export const MOON_DIST = 300000

export const CURVE_FROM = 300
export const CURVE_TO = 3000
export const THIN_FROM = 800
export const THIN_TO = 11000
export const GROUND_FADE = 12000
export const GROUND_OFF = 20000

/** the Moon is pinned once the climb passes this, and forgotten under the other */
export const MOON_ANCHOR = 3000
export const MOON_FORGET = 2000
/** how close to its surface flying cuts to the Moon, and how high off it back */
export const MOON_SEAM = 2600
export const MOON_LEAVE = 2400
/** how high over the ground you left from the way back arrives */
export const EARTH_RETURN = 40000

/** where the Moon level sits in the scene: far enough off that the house,
    the fleet and the overworld's props are past its far plane */
export const MOON_ORIGIN = { x: 0, z: 60000 }
/** the Moon's walkable square, either side of its origin */
export const MOON_WALK = 620
/** the Moon's own time of day: the sun a third of the way up, so the
    craters throw long shadows and the day never ends */
export const MOON_TOD = 0.31
/** where the Earth hangs in the Moon's sky (unit vector), and how far off it
    is drawn: the globe at MOON_DIST scaled into the far plane, which keeps
    its angular size and keeps the depth buffer honest. A third of the way
    up the sky opposite the Moon's sun, so what faces you is mostly its day
    side, a fat gibbous Earth, with the terminator and the lit towns along
    one edge */
export const EARTH_IN_MOON_SKY = (() => {
  const el = 0.6
  // sky.ts puts the sun at (cos a, sin a, 0.21) for a = (tod - 0.25) * 2pi
  const a = (MOON_TOD - 0.25) * Math.PI * 2
  const h = Math.hypot(Math.cos(a), 0.21)
  return { x: (-Math.cos(a) / h) * Math.cos(el), y: Math.sin(el), z: (-0.21 / h) * Math.cos(el) }
})()
export const EARTH_SKY_DIST = 9000
export const MOON_FAR = 26000

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 0 flat .. 1 the full curve: how far the far field is bent onto the globe */
export const curveK = (alt: number) => smooth(CURVE_FROM, CURVE_TO, alt)

/** 0 under the sky .. 1 in space: how much of the air is left below you */
export const spaceK = (alt: number) => smooth(THIN_FROM, THIN_TO, alt)

/** 1 the ground is drawn .. 0 only the globe is */
export const groundK = (alt: number) => 1 - smooth(GROUND_FADE, GROUND_OFF, alt)

/** the globe's radius for a curve: past the far field's rim the globe must
    continue the parabola the far field is bent to, and a gentler bend is a
    bigger sphere. Capped so a nearly flat bend is not a sphere the size of
    the solar system */
export const globeRadius = (k: number) => EARTH_R / Math.max(0.04, k)

/** how far a noclip flight's speed is multiplied `alt` units up: 1 on the
    ground and at a rooftop, and in proportion to height from there, so the
    climb to orbit is an exponential that takes seconds and a Moon a hundred
    and fifty thousand units off is a few seconds more. Near the Moon, pass
    the distance to its surface instead, or you arrive at orbital speed */
export const flyScale = (alt: number) => 1 + Math.max(0, alt - 60) / 120

/** the camera's near plane at this height: from high up nothing is within a
    unit of the lens, and a near plane of 0.1 there leaves the depth buffer too
    coarse to tell the globe from the sky it is drawn against */
export const nearFor = (alt: number) => (alt > 4000 ? 1 : 0.1)

/** the distance to the horizon of a sphere of radius `r` from `h` over it */
export const horizonDist = (r: number, h: number) => Math.sqrt(Math.max(0, 2 * r * h + h * h))
