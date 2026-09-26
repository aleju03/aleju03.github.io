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
 */
export const fogForAltitude = (fog: { fogNear: number; fogFar: number }, alt: number) => {
  const k = altitudeK(alt)
  if (k <= 0) return
  fog.fogNear *= 1 + k * 0.5
  fog.fogFar *= 1 + k * 0.55
}

/** the camera's far plane at this height. It must clear the sky dome's
    radius outright (see the root CLAUDE.md), which 900 does at any height */
export const viewFarFor = (alt: number) => {
  void alt
  return 900
}
