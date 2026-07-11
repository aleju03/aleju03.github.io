import * as THREE from 'three'
import type { HouseHandles } from './houseWorld'
import type { BackroomsHandles } from './backrooms'
import { BR } from './backrooms'
import { WORLD } from './outsideWorld'
import { makeCollisionSet } from '../physics/collision'
import type { Level } from './types'

/*
  The two levels the game ships today, adapted onto the Level contract:

  - 'overworld' — the house, the yard, the neighborhood. Its collision set
    is the shared obstacle list every builder registers into, bounded by
    the edge of the neighborhood (with shoulder room). Its spawn is the
    living-room spot the backrooms return you to.
  - 'backrooms' — level 0 behind the doctored wall span. It brings its own
    obstacle set (chunk-streamed), a floor far below the world, and a light
    override that kills the sky while you're down there.

  Both keep the house and the backrooms modules ticking every frame no
  matter which side you're on: doors keep easing shut upstairs while you're
  below, and the seam keeps whispering upstairs while you're not.
*/

export function makeHomeLevels(
  house: HouseHandles,
  backrooms: BackroomsHandles,
  sharedObstacles: THREE.Box3[],
): Level[] {
  const overworld: Level = {
    id: 'overworld',
    groundY: 0,
    // hard bounds are the edge of the neighborhood; the fences, walls and
    // everything else in between are obstacle boxes
    collision: makeCollisionSet(
      {
        minX: WORLD.minX + 0.55,
        maxX: WORLD.maxX - 0.55,
        minZ: WORLD.minZ + 0.55,
        maxZ: WORLD.maxZ - 0.55,
      },
      sharedObstacles,
    ),
    // where the return trip stands you back up in the living room
    spawn: backrooms.exitSpot,
    enter: () => {},
    leave: () => {},
    update: (dt, p) => {
      house.update(dt) // doors easing, fireflies drifting
      backrooms.update(dt, p, false) // the seam's whisper from below
    },
    seamTo: (p) => (backrooms.overEntry(p) ? { to: 'backrooms' } : null),
  }

  const level0: Level = {
    id: 'backrooms',
    groundY: BR.y,
    // no edges down there; the cap is just floating-point hygiene
    collision: makeCollisionSet(
      { minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000 },
      backrooms.obstacles,
    ),
    spawn: BR.spawn,
    enter: () => backrooms.enter(),
    leave: () => backrooms.leave(),
    update: (dt, p) => {
      house.update(dt)
      backrooms.update(dt, p, true) // chunk streaming, flicker and hum
    },
    seamTo: (p) => (backrooms.overExit(p) ? { to: 'overworld' } : null),
    // level 0 brings its own light rig (inside its root); kill the sky,
    // moon and window spills, pin the fog close and sour
    overrideLight: (rig) => {
      rig.hemi.intensity = 0
      rig.moon.intensity = 0
      rig.windowSpill.intensity = 0
      rig.setMoonPool(0)
      rig.fog.color.set(BR.fog)
      rig.fog.near = BR.fogNear
      rig.fog.far = BR.fogFar
      rig.bg.copy(rig.fog.color)
    },
  }

  return [overworld, level0]
}
