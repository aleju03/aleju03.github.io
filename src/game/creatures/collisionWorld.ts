import { blockedAt, supportY, type CollisionSet } from '../physics/collision'
import type { CreatureWorld, Resident } from './world'

/*
  A CreatureWorld for any level whose ground is a CollisionSet: a flat floor
  and the boxes standing on it (Nuketown's houses, fences, cars and
  mannequins). The level hands over its set and its floor height and says
  which creatures live there; the rest is the walker's own questions asked on
  a creature's behalf.

  Footing is `supportY` (the tallest standable top within a step's reach of
  the soles, else the floor) and then `blockedAt` for the body's height over
  it, so a creature stands on a kerb or a low box and is turned away by a wall
  or a car, exactly as the player is. Boxes are already grown by a shoulder's
  width for the walker, which is more than a creature's radius, so the centre
  point is the honest test. Bounds count: outside them is not a place.

  These maps have a sun and no dark (`light` says open sky, no torches), and
  no wild spawning: what lives there is its `residents`, put back if they go.
*/

export interface CollisionCreatureOpts {
  collision: CollisionSet
  /** the base floor, where no box stands */
  floorY: number
  fauna?: readonly string[]
  residents?: readonly Resident[]
  drops?: boolean
}

export const collisionCreatures = (o: CollisionCreatureOpts): CreatureWorld => {
  const { collision, floorY } = o
  return {
    fauna: o.fauna ?? [],
    drops: o.drops ?? false,
    residents: o.residents,
    footing: (x, z, fromY, f) => {
      const y = supportY(x, z, fromY + f.up, collision, floorY)
      if (y < fromY - f.down - 1e-4 || y > fromY + f.up + 1e-4) return null
      if (blockedAt(x, z, y + 0.05, y + f.h, collision, 0)) return null
      return { y, ground: 'street' }
    },
    spots: (x, z, out, h) => {
      out.length = 0
      const y = supportY(x, z, floorY + 0.6, collision, floorY)
      if (blockedAt(x, z, y + 0.05, y + h, collision, 0)) return 0
      out.push(y)
      return 1
    },
    light: (_x, _y, _z, out) => {
      out.sky = 1
      out.block = 0
      return out
    },
    exposed: () => true,
  }
}
