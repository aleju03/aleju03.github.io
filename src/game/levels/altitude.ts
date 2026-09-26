/*
  What changes about the view when the camera leaves the ground.

  Everything out here was tuned for an eye 3.84 units up: a fog that ends
  just short of the streamed ring, an air that layers a street into planes,
  a far plane that clears the sky dome. From a helicopter, or from noclip,
  the same numbers draw a white wall: the ring is 384 units across and the
  fog has to hide its edge, so from 120 up most of the frame is haze.

  This module is the one place that says how the view opens with height,
  so the game (outsideWorld.ts, CrtScene) and the harness (scripts/probe)
  answer it the same way. It takes plain numbers and returns plain numbers,
  and imports nothing, so the room tier can call it before the world has
  loaded.
*/

/** camera height over the ground under it, never negative */
export const altitudeOf = (camY: number, groundY: number) => Math.max(0, camY - groundY)

/** 0 on the ground .. 1 from about a hundred units up: how far the view has
    opened. Starts at twenty, which a jump, a hill or a car roof never reach */
export const altitudeK = (alt: number) => Math.min(1, Math.max(0, (alt - 20) / 100))

/**
 * Stretch the scene fog for a camera `alt` units over the ground. The
 * ground-level numbers are the sky's; this only ever lengthens them.
 *
 * `reach` is how far the far field (world/farfield.ts) covers the ground
 * past the camera without a gap. With it, the fog opens out to the far
 * field's rim and the look's air (render/atmosphere.ts, which takes the same
 * altitude) does the layering, height-aware, instead of a wall at 380 units.
 * Without it (the far field not built yet) the old ramp stands, which only
 * has to hide the edge of the widened chunk ring.
 */
export const fogForAltitude = (
  fog: { fogNear: number; fogFar: number }, alt: number, reach = 0,
) => {
  const k = altitudeK(alt)
  if (k <= 0) return
  if (reach <= 0) {
    fog.fogNear *= 1 + k * 0.5
    fog.fogFar *= 1 + k * 0.55
    return
  }
  // opens early: at 40 up a third of the way, most of it by 80
  const e = Math.pow(k, 0.6)
  fog.fogNear += (reach * 0.35 - fog.fogNear) * e
  fog.fogFar += (reach * 1.2 - fog.fogFar) * e
}

/** the camera's far plane at this height. It must clear the sky dome's
    radius outright (see the root CLAUDE.md), which 900 does; from the air it
    must also clear the far field's rim, corners included */
export const viewFarFor = (alt: number, reach = 0) =>
  reach > 0 && altitudeK(alt) > 0 ? Math.max(900, reach * 1.8) : 900

/** the sky dome's scale for a far plane: its outermost shell (430 units at
    scale 1) just inside the plane, never smaller than it was built */
export const domeScaleFor = (far: number) => Math.max(1, (far * 0.92) / 430)
