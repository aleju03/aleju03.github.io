import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import type { StepSurface } from '../core/sfx'
import { buildSky, type SkyState } from './sky'
import { buildBirds } from '../world/birds'
import { buildWorld, waveHeightAt } from '../world/streamer'
import { SEA_Y, surfaceAt as worldSurfaceAt, terrainY } from '../world/terrain'
import { YARD } from './houseWorld'

/*
  Everything past the property line: the sky above it (sky.ts) and the endless
  ground under it (src/game/world/*). This module is the seam between them and
  the one thing the scene talks to.

  It used to *be* the outside — a 104x82 rectangle of hand-placed street,
  seven shell houses, a meadow disc and three rings of fake towers on the
  horizon, with a hard clamp at the edge. All of that is gone. The ground is
  now chunk-streamed procedural terrain with biomes, water, roads and real
  cities you can walk into, and the only hand-authored thing left out here is
  the house's own property, which the world generator treats as a hole.

  Two jobs beyond composition:

  - it decides *when* the world streams. The backrooms are a hundred and
    twenty units below the overworld with their own coordinates, and a player
    wandering that maze would otherwise drag the overworld's chunk ring along
    behind them, rebuilding the surface around coordinates nobody is standing
    on. The level system calls setActive(false) on the way down.
  - it answers where the ground and the waterline are, which is the contract
    the walk, the ragdoll and the chase boom all read the world through.
*/

export type OutsideState = SkyState

export interface OutsideHandles {
  /** the sky and the streamed world, under one group the levels can hide */
  root: THREE.Group
  /** advance the cycle (wall clock), restyle the sky and stream the chunk
      ring around the camera; call once per rendered frame. todOverride pins
      the time of day for probes. */
  update: (camPos: THREE.Vector3, todOverride?: number) => OutsideState
  /** the height of the drawn ground anywhere in the world */
  groundYAt: (x: number, z: number) => number
  /** the waterline; ground below it is sea, lake or river bed */
  waterY: number
  /** what a footstep lands on out here */
  surfaceAt: (x: number, z: number) => StepSurface
  /** how far the drawn sea surface is displaced from `waterY` at a point,
      right now. A hull floated on the flat waterline sits inside the crests
      and under the troughs; this is the swell the water shader draws, so a
      boat rides the sea that is actually on screen */
  waveAt: (x: number, z: number) => number
  /** true while the property owns the ground under this point — the house
      answers for its own lawn, porch and paths */
  onProperty: (x: number, z: number) => boolean
  /** the sun, whose stable shadow program is warmed by one covered render;
      strength and map updates sleep independently indoors and at night */
  sun: THREE.DirectionalLight
  /** stop streaming while another level is live (see the header) */
  setActive: (on: boolean) => void
  /** build the ring around a point without waiting for the frame budget. The
      two inner rings always; `ms` milliseconds of the outer ones on top,
      which only a boot with a cover over it can afford to spend */
  prime: (x: number, z: number, ms?: number) => void
}

interface BuildOpts {
  scene: THREE.Scene
  /** the shared obstacle list the house and desk already registered into;
      the world appends its own after theirs and truncates back on restream */
  obstacles: Solid[]
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

export function buildOutsideWorld(opts: BuildOpts): OutsideHandles {
  const { scene, obstacles, trackTexture, trackDisposable } = opts

  const root = new THREE.Group()
  scene.add(root)

  const sky = buildSky({ parent: root, trackTexture, trackDisposable })
  const world = buildWorld({ scene: root, obstacles, trackTexture, trackDisposable })
  // the flocks are neither sky nor ground: they hang off this seam because
  // they need the sky's daylight and the world's terrain height, and because
  // they must sleep with the streamer when another level is live
  const birds = buildBirds({ parent: root, trackDisposable })

  let active = true

  let lastT = 0
  const update = (camPos: THREE.Vector3, todOverride?: number) => {
    const state = sky.update(camPos, todOverride)
    if (active) {
      // the sky is the only thing here with a wall clock, so the wind takes
      // its delta from the same place rather than from the walk loop — which
      // does not run during the intro flight, when the world is still visible
      const now = performance.now()
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016
      lastT = now
      /*
        How high the camera is over the ground under it, which is a number the
        world never needed until something could fly. Three things read it:
        the grass field (a 60-unit disc of blades pinned under an aircraft is
        both wrong and expensive), the splash detector (which asks only whether
        the *ground* below is under water, and would otherwise stamp ripples on
        the sea from cruising height), and the ring radius.

        And the fog goes with the ring, because it always has: the note in
        sky.ts explains that a 240-unit far plane hides an edge that is never
        closer than 256. From the air both numbers have to grow together — fog
        alone would reveal the edge, a wider ring alone would be invisible
        behind the fog. The ramp tops out at 120 units up, past which the
        ground is more than half fog anyway and there is nothing left to see.
      */
      const alt = Math.max(0, camPos.y - terrainY(camPos.x, camPos.z))
      world.update(camPos.x, camPos.z, dt, alt)
      birds.update(camPos, dt, state.day, state.twilight)
      if (alt > 20) {
        const k = Math.min(1, (alt - 20) / 100)
        state.fogNear *= 1 + k * 0.5
        state.fogFar *= 1 + k * 0.55
      }
      // windows and streetlamps come up with the dark; the water takes its
      // colour from the fog, which is most of what makes it read as water
      world.setNight(state.night)
      world.setWaterTint(state.fogColor, state.day)
    }
    return state
  }

  const onProperty = (x: number, z: number) =>
    x > YARD.minX - 1 && x < YARD.maxX + 1 && z > YARD.minZ - 1 && z < YARD.maxZ + 1

  return {
    root,
    update,
    groundYAt: terrainY,
    waterY: SEA_Y,
    surfaceAt: worldSurfaceAt,
    waveAt: waveHeightAt,
    onProperty,
    sun: sky.sun,
    setActive: (on) => {
      active = on
    },
    prime: world.prime,
  }
}
