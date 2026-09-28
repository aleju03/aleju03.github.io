import * as THREE from 'three'
import type { HouseHandles } from './houseWorld'
import type { BackroomsHandles } from './backrooms'
import { BR } from './backrooms'
import type { OutsideHandles } from './outsideWorld'
import { makeCollisionSet } from '../physics/collision'
import type { Level } from './types'
import { MOON_LEAVE, MOON_ORIGIN, MOON_WALK } from './space'

/*
  The three levels the game ships today, adapted onto the Level contract:

  - 'overworld' — the house, the yard, and an endless procedural world past
    the fence. Its collision set is the shared obstacle list every builder
    registers into, which the chunk streamer keeps topped up with the solids
    of the nine chunks around the player. It has no bounds worth the name any
    more: the clamp is set a million units out purely as floating-point
    hygiene, because the thing that used to stop you at the edge of the
    neighbourhood was the point of this whole rewrite. Its floor is a
    function rather than a number (terrain), and it has a waterline, so the
    walk swims when the sea is over your chest.
  - 'backrooms' — level 0 behind the doctored wall span. It brings its own
    obstacle set (chunk-streamed), a flat floor far below the world, and a
    light override that kills the sky while you're down there.

  Depth alone doesn't separate them: the sky's domes and celestial bodies are
  drawn with fog off and frustum culling off, and the star dome's radius still
  swallows a camera 120 below. So level 0 hides the whole outside root while
  you're in it — otherwise every sight line that escapes the streamed chunk
  ring frames a rectangle of night sky in the fog. With the sky gone those
  pixels fall through to the scene background, which the light override has
  already pinned to the fog colour. Going down also stops the surface
  streaming: the maze wanders far enough that the overworld would otherwise
  keep rebuilding terrain around coordinates nobody is standing on.

  - 'moon': reached by flying at the Moon from orbit, and left by flying
    up off it (levels/space.ts has the numbers, outsideWorld.ts the seams).
    Its ground is levels/moon.ts's craters, its sky the same sky module with
    the air taken out and the globe hung in it, and it has a sandbox of its
    own standing on its own lattice, at a sixth of the gravity. It stands
    far off in the scene, so nothing of the overworld's is inside its far
    plane. It declares the fleet (a machine is in one level at a time, and
    ordering one pulls it here) but no crowd, no house and no air.

  All of them keep the house and the backrooms modules ticking every frame no
  matter which side you're on: doors keep easing shut upstairs while you're
  below, and the seam keeps whispering upstairs while you're not.
*/

/** which of these levels a point is in, for a machine somebody else is
    driving: the wire carries the fleet's poses with no level, and the Moon
    is a square of its own far off in the scene (space.ts). A point inside
    that square and under the height the Moon is left at is on the Moon;
    anything else is the overworld (a car driven 55 km out on Earth into the
    same square would read as lunar to everybody else, which nobody does) */
export const fleetLevelAt = (x: number, y: number, z: number) =>
  Math.abs(x - MOON_ORIGIN.x) <= MOON_WALK + 200 &&
  Math.abs(z - MOON_ORIGIN.z) <= MOON_WALK + 200 &&
  y < MOON_LEAVE + 1000
    ? 'moon'
    : 'overworld'

export function makeHomeLevels(
  house: HouseHandles,
  outside: OutsideHandles,
  backrooms: BackroomsHandles,
  sharedObstacles: THREE.Box3[],
): Level[] {
  const overworld: Level = {
    id: 'overworld',
    groundY: 0,
    // the terrain, which is also exactly 0 across the property: the house is
    // authored at y=0 and the generator holds a flat pad under it
    groundYAt: outside.groundYAt,
    // a GETTER, not a snapshot: the sea does not exist until the world is
    // attached (outsideWorld builds the room first and streams the planet in
    // on demand), and this level object is constructed on the first frame —
    // reading the value here would freeze the waterline at "no sea, ever"
    get waterY() {
      return outside.waterY
    },
    collision: makeCollisionSet(
      { minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 },
      sharedObstacles,
    ),
    // where the return trip stands you back up in the living room
    spawn: backrooms.exitSpot,
    enter: () => {
      outside.setActive(true)
    },
    leave: () => {},
    update: (dt, p) => {
      house.update(dt, p) // doors easing (clear of the player), fireflies drifting
      backrooms.update(dt, p, false) // the seam's whisper from below
    },
    // the backrooms' doctored wall, or the Moon from orbit
    seamTo: (p) => (backrooms.overEntry(p) ? { to: 'backrooms' } : outside.moonSeam(p)),
    // everything: the one level that has the lot
    gravity: 1,
    sandbox: {
      waterY: () => outside.waterY,
      waveAt: outside.waveAt,
      splash: outside.splash,
      chunkSolids: outside.chunkSolids,
      ruins: outside.ruins,
      felling: outside.felling,
    },
    vehicles: true,
    crowd: true,
    house: true,
    outdoors: true,
    air: true,
    // the property answers for its own lawn, porch and planks; the open
    // world for everything past the fence
    surfaceAt: (x, z, feetY, wet) =>
      wet > 0.12 ? 'water' : outside.onProperty(x, z) ? house.surfaceAt(x, z, feetY) : outside.surfaceAt(x, z),
  }

  const level0: Level = {
    id: 'backrooms',
    groundY: BR.y,
    // the drop ceiling is low enough to matter: without this a hop puts the
    // camera through the tiles
    ceilingY: BR.y + BR.h,
    // no edges down there; the cap is just floating-point hygiene
    collision: makeCollisionSet(
      { minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000 },
      backrooms.obstacles,
    ),
    spawn: BR.spawn,
    // the sky goes with the lights: hidden, its domes can't paint through
    // the gaps in the fog (and the surface stops costing draw calls)
    enter: () => {
      outside.root.visible = false
      outside.setActive(false)
      backrooms.enter()
    },
    leave: () => {
      backrooms.leave()
      outside.root.visible = true
      outside.setActive(true)
    },
    update: (dt, p) => {
      house.update(dt)
      backrooms.update(dt, p, true) // chunk streaming, flicker and hum
    },
    seamTo: (p) => (backrooms.overExit(p) ? { to: 'overworld' } : null),
    // carpet wall to wall, and nothing else: no props, no machines, no sky
    surfaceAt: () => 'carpet',
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

  const moon: Level = {
    id: 'moon',
    groundY: -1e5,
    groundYAt: outside.moon.groundYAt,
    // nothing is under the regolith but black sky: noclip rides over it
    noclipFloor: true,
    // the walkable square: past it the ground curves away into the horizon
    collision: makeCollisionSet(
      {
        minX: MOON_ORIGIN.x - MOON_WALK,
        maxX: MOON_ORIGIN.x + MOON_WALK,
        minZ: MOON_ORIGIN.z - MOON_WALK,
        maxZ: MOON_ORIGIN.z + MOON_WALK,
      },
      outside.moon.obstacles,
    ),
    get spawn() {
      return outside.moon.spawn
    },
    enter: () => {
      outside.setVenue('moon')
    },
    leave: () => {
      outside.setVenue('earth')
    },
    update: (dt, p) => {
      house.update(dt)
      backrooms.update(dt, p, false)
    },
    seamTo: (p) => outside.earthSeam(p),
    // a black sky lights nothing: the shadow side of a crater is dark, and
    // the house's moonlight and window spill are a world away
    overrideLight: (rig) => {
      rig.hemi.intensity *= 0.35
      rig.moon.intensity = 0
      rig.windowSpill.intensity = 0
      rig.setMoonPool(0)
    },
    gravity: 1 / 6,
    sandbox: { ground: outside.moon.ground },
    // the whole fleet, under a sixth of the gravity: the ship lands here,
    // and a car ordered here is a lunar rover (it floats over crater rims)
    vehicles: true,
    outdoors: true,
    surfaceAt: () => 'regolith',
    // regolith crunches underfoot, but a tyre on it wants to go:
    // sand's drag is wading pace, and a rover that crawls is no rover
    driveSurface: () => 'stone',
  }

  return [overworld, level0, moon]
}
