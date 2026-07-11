import type * as THREE from 'three'
import type { Level, LevelSpawn } from './types'

/*
  Which level is live, and the noclip cut that moves the player between
  them. The cut is a little state machine run once per walk frame: the
  moment a seam trips, movement freezes and the blackout card snaps up
  (fast cover); under the cover the worlds swap (leave/enter, collision
  set, spawn) at SWAP_MS; the card starts its slow fade at FADE_MS and the
  machine retires at DONE_MS. The scene owns the card itself and anything
  renderer-side (shadow re-bakes) through the callbacks. reset() is the
  no-ceremony path home — sitting down or leaving the room mid-level snaps
  straight back to the home level's spawn with no cut.
*/

const SWAP_MS = 220
const FADE_MS = 560
const DONE_MS = 1300

export interface LevelSystemOpts {
  levels: Level[]
  /** id of the level the player starts (and force-returns) in */
  home: string
  /** raise/drop the blackout card; fast=true is the snap up, false the fade */
  onCover: (on: boolean) => void
  /** a seam just tripped (play the cut's sound, halt planar velocity) */
  onCutStart: () => void
  /** the worlds swapped under the cover: place the player at `spawn`
      (the seam's own arrival point, or the level's default), re-bake shadows */
  onSwapped: (level: Level, spawn: LevelSpawn, from: Level) => void
}

export interface LevelSystem {
  readonly current: Level
  /** a cut is in flight: movement is frozen */
  readonly frozen: boolean
  /** seam check + cut state machine; call once per walk frame.
      live = first-person controls are up (no seams during the stand glide) */
  tick: (now: number, p: THREE.Vector3, live: boolean) => void
  /** snap back to the home level with no cut; returns it if a move happened */
  reset: () => Level | null
}

export function createLevelSystem(opts: LevelSystemOpts): LevelSystem {
  const byId = new Map(opts.levels.map((l) => [l.id, l]))
  const home = byId.get(opts.home)
  if (!home) throw new Error(`unknown home level ${opts.home}`)
  let current = home
  let cut: {
    t0: number
    to: Level
    spawn: LevelSpawn
    swapped: boolean
    fading: boolean
  } | null = null

  return {
    get current() {
      return current
    },
    get frozen() {
      return cut !== null
    },
    tick: (now, p, live) => {
      if (cut) {
        const t = now - cut.t0
        if (!cut.swapped && t >= SWAP_MS) {
          cut.swapped = true
          current.leave()
          const from = current
          current = cut.to
          current.enter()
          opts.onSwapped(current, cut.spawn, from)
        }
        if (cut.swapped && !cut.fading && t >= FADE_MS) {
          cut.fading = true
          opts.onCover(false)
        }
        if (t >= DONE_MS) cut = null
        return
      }
      if (!live) return
      const seam = current.seamTo(p)
      if (seam) {
        const to = byId.get(seam.to)
        if (!to) return
        cut = { t0: now, to, spawn: seam.spawn ?? to.spawn, swapped: false, fading: false }
        opts.onCover(true)
        opts.onCutStart()
      }
    },
    reset: () => {
      cut = null
      if (current === home) return null
      current.leave()
      current = home
      return current
    },
  }
}
