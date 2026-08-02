/*
  How loud the computer is from where you are standing.

  The machine on the desk can be left playing something, a video in the
  browser's window, and then you stand up and walk off, and the sound has to
  come from *there* rather than from everywhere. That is the same problem the
  television one room over already has, and it has the same answer: the picture
  is a cross-origin iframe, so its audio never reaches an AudioContext we may
  touch and there is no PannerNode to hang it on. What is left is to set the
  player's own volume from the listener's distance and call it spatialisation.

  Three things this shape buys, and each of them is why it is a module store
  rather than a prop.

  **The walk and the desktop are separate worlds.** The distance is known by
  `walkTick` inside CrtScene's scene graph; the volume is applied by a React
  component inside the AlejOS DOM, which is a CSS3D element in that same scene
  and is not that component's descendant in any tree. One tiny store between
  them is how `dnd.ts` and `clipboard.ts` already cross the same gap.

  **The gain is quantised on the way in.** Every change is a `postMessage` into
  another origin's window, so a value that moved by a thousandth is a message
  nobody asked for; the step is coarse enough that a walking player sends a
  handful per second and fine enough that the fade reads as continuous.

  **The falloff is the room's, not the world's.** It reaches nothing at a
  distance a little past the house, so walking out of the front door leaves the
  music behind, and a machine left playing is never audible from a field.

  Anything in the OS with real audio should read this. Right now that is the
  browser's video embed and nothing else, because every other sound in AlejOS
  is a short synthesized cue that only ever plays while somebody is sitting at
  the keyboard.
*/

/** where the falloff starts, in world units from the glass */
const LOUD_AT = 2.2
/** and where it reaches silence: a bit past the walls of the house */
const QUIET_AT = 22
/** the coarsest step worth sending across an origin boundary */
const STEP = 0.05

let gain = 1
const subs = new Set<() => void>()

function publish(next: number) {
  const quantised = Math.round(next / STEP) * STEP
  if (quantised === gain) return
  gain = quantised
  for (const fn of subs) fn()
}

/**
 * The listener moved. Called once per rendered frame from the walk, with the
 * distance from the head to the screen glass.
 */
export function setPcListenerDistance(distance: number): void {
  const k = Math.max(0, Math.min(1, (QUIET_AT - distance) / (QUIET_AT - LOUD_AT)))
  // squared, like the television's: linear reads as "loud everywhere, then a
  // cliff", because loudness is not linear in distance
  publish(k * k)
}

/**
 * Back at the keyboard (or never having left it): the machine is right in
 * front of you, so it plays at whatever the tray speaker says and nothing
 * else. Sitting down has to call this, or the last distance of the walk is
 * left holding the volume down at a desk you are now sitting at.
 */
export function resetPcAudio(): void {
  publish(1)
}

export function getPcGain(): number {
  return gain
}

export function subscribePcGain(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}
