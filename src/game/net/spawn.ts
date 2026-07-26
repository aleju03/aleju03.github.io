/*
  Where the Nth person to arrive should stand.

  Every spawn in the game is a single authored point — you stand up out of the
  same desk chair, you land on the same tile of the backrooms — which is
  exactly right for one player and comic for two, who end up inside each
  other's ribcage until somebody walks off. The server hands each socket the
  lowest free slot number, and this turns that into an offset.

  The pattern is the sunflower one: turn by the golden angle each time and
  push out by the square root of the index. It spreads without banding — a
  fixed angular step lines everyone up on spokes, and a fixed radius packs
  them onto one ring that gets crowded at the eighth arrival. Slot 0 is
  deliberately the origin, so the first person in stands precisely where the
  single-player game always put them and nothing about the shot changes.

  The ideal spot is only a preference. Spawns here sit in a bedroom and in a
  corridor, so the offset is tried against the level's own collision and walked
  around the ring — then inward — until it finds floor. Failing everything it
  gives up and returns the authored point, which is no worse than before.
*/

/** ~137.5°: consecutive slots never line up on a spoke */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** how far slot 1 stands from slot 0. About one stride — close enough to read
    as "we spawned together", far enough not to overlap bodies */
const STEP = 1.25
/** past this the room runs out before the pattern does */
const MAX_RADIUS = 3.4
/** rotations tried at each radius before giving up on it */
const TRIES = 8

export interface SpawnSpot {
  x: number
  z: number
}

/**
 * Place slot `slot` near (x, z). `clear` decides whether a candidate is
 * standable — pass the level's collision test; pass `() => true` to take the
 * ideal spot unconditionally.
 */
export function scatterSpawn(
  x: number,
  z: number,
  slot: number,
  clear: (x: number, z: number) => boolean,
): SpawnSpot {
  if (slot <= 0) return { x, z }
  const wanted = Math.min(MAX_RADIUS, STEP * Math.sqrt(slot))
  const angle = slot * GOLDEN_ANGLE
  // ideal radius first, then progressively tighter rings: a crowded corner is
  // better than being turned away from the spawn entirely
  for (let r = wanted; r > 0.35; r *= 0.62) {
    for (let t = 0; t < TRIES; t++) {
      // half-step rotations, alternating sides, so the first retry is the
      // smallest deviation from where the pattern actually wanted to be
      const spin = ((t + 1) >> 1) * (t % 2 === 0 ? 1 : -1) * ((Math.PI * 2) / TRIES)
      const a = angle + spin
      const cx = x + Math.sin(a) * r
      const cz = z + Math.cos(a) * r
      if (clear(cx, cz)) return { x: cx, z: cz }
    }
  }
  return { x, z }
}
