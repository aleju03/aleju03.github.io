/*
  Deterministic randomness for the whole game. Every procedural system —
  canvas textures, chunk layouts, prop scatter — draws from seeded() streams
  instead of Math.random(), so a given seed always reproduces the same world.
  That determinism is what lets the backrooms stream chunks on demand, and
  it's the foundation any future procedural area (or multiplayer world
  agreement) builds on. Keep it that way: new systems take a seed, never
  reach for Math.random().
*/

/** LCG stream: identical sequence for an identical seed, cheap to fork */
export const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}
