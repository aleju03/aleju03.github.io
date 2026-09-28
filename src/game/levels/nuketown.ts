import * as THREE from 'three'
import { createMeshBuilder, type MeshBuilder } from '../core/geometry'
import { seeded } from '../core/rand'
import type { StepSurface } from '../core/sfx'
import { makeCollisionSet, noStand, type Solid } from '../physics/collision'
import type { SandboxGround } from '../sandbox/ground'
import { BALL, BARREL, BOX, CYL12, CYL8, PRISM, put, roofSolids, strut, taper } from '../world/kitbash'
import { SURF, type SurfaceId } from '../world/surface'
import { fbm, noise2 } from '../world/noise'
import { PREBORN, bakeBirth } from '../world/fade'
import { makeChunkMats } from '../world/streamer'
import { CEIL_H, UP } from './houseWorld'
import type { Level, LevelLightRig, LevelSpawn } from './types'

/*
  Nuketown: a 1950s cul-de-sac built on a nuclear test site in the desert,
  after the Black Ops map and made from nothing but stamped boxes. Two
  two-storey houses face each other across the street, one butter yellow and
  one teal, each with a garage, a porch, a fenced back yard and an interior
  you can walk through and up; a school bus is parked across the middle of
  the street, a camper trailer and a pickup stand in the lots at either end,
  and mannequins in their Sunday best stand about everywhere, waiting for
  the siren. Past the rocks round the block the desert runs out to mesas and
  a shot tower on the horizon.

  It is a map (levels/maps.ts): nobody downloads this module until they pick
  it, and CrtScene builds and warms it under the level cut's card. How it is
  made follows from that:

  - **It draws with the open world's own materials.** Every surface here is
    stamped into the chunk soup's vertex format (core/geometry.ts's builder:
    colour, `aSurf`, `aSway`, and an `aBirth` of PREBORN so it never fades)
    and drawn with a fresh `makeChunkMats().detail`, whose program key is the
    streamed chunks' own. So the siding is world/surface.ts's planks, the
    roofs its shingles, the street its asphalt, and arriving here links no
    program at all: the first visit costs a buffer upload, paid in one
    unculled draw under the card.
  - **Four draws.** What stands up (the houses, the bus, the fences, the
    people) casts and receives; the flat ground and the street only receive,
    because a plane in the sun's map is nothing but acne; the desert grid and
    the horizon (mesas, the tower, poles) neither cast nor are near enough to
    be in the map.
  - **The scale is the house's.** A storey is houseWorld's CEIL_H with its
    slab on top (UP), a door is 4.7 by 2.1, a stair is sixteen risers of 0.4
    over fifteen treads that overlap to the top of the flight, and walls
    collide as the house's do: a noStand box 0.4 either side of the plane,
    split only by openings that reach the floor, with a 0.2 shoulder at each
    jamb. Windows are real holes with a cross in them, so you can see out.
  - **Everything is point-symmetric** about the middle of the street: one
    side is built, then the same calls with the frame turned half round, so
    the two spawn ends are the same fight. Axis-aligned by construction, so
    every solid is an honest AABB (the collision rule in the root CLAUDE.md).
  - **It is far off in the scene** (NUKE_ORIGIN), past the far plane from
    home, like the Moon, and the outside world's sky follows the lens here
    with the Earth's ground put away (`setVenue('away')`). The level pins the
    clock to a desert morning and warms, hazes and bounces the light off the
    sand in `overrideLight`, and damps the sky light inside the houses the
    way the sky does in the real one.

  Built in the map's own coordinates about (0, 0) and moved to NUKE_ORIGIN
  at the end, geometry and boxes alike. Headless-safe: nothing here touches
  a renderer.
*/

/** where the map stands in the scene: far enough from the house, the fleet
    and the Moon that none of them is inside its far plane */
export const NUKE_ORIGIN = { x: -24000, z: 0 } as const
/** the playable rectangle, either side of the middle of the street */
const HALF_X = 71.5
const HALF_Z = 56.5
/** the house fronts' distance from the middle of the street */
const FRONT = 22
/** the street's half-width, and the sidewalk's outer edge */
const STREET = 8
const WALK = 11.5
/** a wall layer's thickness either side of its plane */
const T = 0.15

const PAL = {
  sand: '#c9a77a',
  lawn: '#7b9a4f',
  lawnDry: '#9aa25c',
  asphalt: '#4d4c4b',
  paint: '#d9b64a',
  concrete: '#aca699',
  trim: '#ede6d4',
  wood: '#8d5f3b',
  stair: '#6f5139',
  ceiling: '#e4dccb',
  garage: '#b3ab98',
  picket: '#ebe5d6',
  board: '#8b6d4d',
  rock: ['#a96f4b', '#bb835a', '#9a6446', '#c1906a', '#8e5d45'],
  mesa: ['#a4694b', '#b97f57', '#8f5b43'],
  steel: '#4c5055',
  tire: '#252322',
  glass: '#2e3a44',
  chrome: '#bdbab1',
  brick: '#8c4e3d',
}

interface HouseLook {
  siding: string
  roof: string
  door: string
  shutter: string
  garageDoor: string
  sofa: string
  bedspread: string
  living: string
  kitchen: string
  bedroom: string
  back: string
}

const YELLOW: HouseLook = {
  siding: '#dcc47d', roof: '#6b4f3d', door: '#9e4034', shutter: '#586b48', garageDoor: '#e3dcc6',
  sofa: '#5f9b94', bedspread: '#b86a78',
  living: '#c3a883', kitchen: '#d2c79e', bedroom: '#a9b8bd', back: '#caa9a3',
}
const TEAL: HouseLook = {
  siding: '#80b3a3', roof: '#4d5559', door: '#d6b560', shutter: '#3f5c69', garageDoor: '#dfe2d6',
  sofa: '#b0574a', bedspread: '#6d8fb3',
  living: '#b9b08f', kitchen: '#d7cfae', bedroom: '#c5a4a9', back: '#aab99b',
}

const DRESSES = ['#b25f7d', '#6d8fb3', '#d0a64f', '#7fa98e', '#b0574a', '#9b7fb0', '#d98f7a']
const SUITS = ['#4b5263', '#6c5a47', '#5a6552', '#3f4a5c', '#7a6f63']
const SKIN = '#d8cab4'

/** one stretch of floor and what a footstep on it sounds like */
interface Floor {
  x0: number
  x1: number
  z0: number
  z1: number
  y0: number
  y1: number
  s: StepSurface
}

interface Opening {
  a0: number
  a1: number
  y0: number
  y1: number
}

export interface NuketownOpts {
  parent: THREE.Object3D
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
  /** put the Earth's ground away while this map is live (outsideWorld's
      setVenue), and back when it is left */
  venue: (v: 'earth' | 'away') => void
  /** home's own per-frame life that carries on while you are here (doors
      easing, the backrooms' whisper), like the Moon keeps it */
  homeUpdate: (dt: number, p: THREE.Vector3) => void
}

export interface Nuketown {
  root: THREE.Group
  level: Level
}

const smooth01 = (t: number) => {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

export function buildNuketown(o: NuketownOpts): Nuketown {
  const props = createMeshBuilder()
  const flat = createMeshBuilder()
  const far = createMeshBuilder()
  const boxes: Solid[] = []
  const floors: Floor[] = []
  /** the houses' and garages' footprints, for the light indoors */
  const roofs: Array<{ x0: number; x1: number; z0: number; z1: number }> = []

  /* ---------------------------------------------------------- helpers -- */

  /** an axis-aligned box by its extents, in either order (a negative scale
      would turn the box inside out, and the far side of the street is built
      from the near side's numbers turned round) */
  const slab = (
    out: MeshBuilder, hex: string,
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    surf: SurfaceId = SURF.plaster,
  ) => put(out, BOX, hex, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 0, 0, 0,
    Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), surf)

  /** a collision box; noStand unless its top is somewhere to stand */
  const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, stand = false) => {
    const b = new THREE.Box3(
      new THREE.Vector3(Math.min(x0, x1), y0, Math.min(z0, z1)),
      new THREE.Vector3(Math.max(x0, x1), y1, Math.max(z0, z1)),
    ) as Solid
    boxes.push(stand ? b : noStand(b))
  }

  const floor = (x0: number, x1: number, z0: number, z1: number, s: StepSurface, y0 = -1, y1 = 99) =>
    floors.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), y0, y1, s })

  /**
   * A mannequin in its Sunday best: legs, a torso, arms hanging a little
   * out, a neck and a blank egg of a head, in a dress or a suit (and some of
   * the suits in a hat). Built in its own frame, facing +z, and turned to
   * `yaw`. A noStand box the height of a person: its top is a hat.
   */
  const mannequin = (x: number, y: number, z: number, yaw: number, seed: number) => {
    const r = seeded(seed * 7919 + 13)
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const at = (
      geo: THREE.BufferGeometry, hex: string,
      lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, rz = 0,
    ) => put(props, geo, hex, x + c * lx + s * lz, y + ly, z - s * lx + c * lz, 0, yaw, rz, sx, sy, sz, SURF.none)
    const dress = r() < 0.5
    const cloth = dress
      ? DRESSES[Math.floor(r() * DRESSES.length)]
      : SUITS[Math.floor(r() * SUITS.length)]
    const legs = dress ? SKIN : cloth
    at(CYL8, legs, -0.24, 0.85, 0, 0.34, 1.7, 0.34)
    at(CYL8, legs, 0.24, 0.85, 0, 0.34, 1.7, 0.34)
    at(BOX, '#2b2622', -0.24, 0.08, 0.1, 0.34, 0.16, 0.6)
    at(BOX, '#2b2622', 0.24, 0.08, 0.1, 0.34, 0.16, 0.6)
    if (dress) {
      // the skirt: a flared frustum from the waist to the knee
      at(taper(0.55, 12), cloth, 0, 1.72, 0, 1.7, 1.3, 1.7)
      at(BOX, cloth, 0, 2.5, 0, 0.9, 1.2, 0.5)
      at(BOX, '#ece6d8', 0, 3.02, 0.05, 0.96, 0.12, 0.56)
    } else {
      at(BOX, cloth, 0, 2.42, 0, 1.02, 1.3, 0.56)
      // shirt front and tie
      at(BOX, '#ebe6da', 0, 2.78, 0.27, 0.32, 0.56, 0.04)
      at(BOX, '#8a3a34', 0, 2.66, 0.3, 0.1, 0.5, 0.03)
    }
    at(CYL8, cloth, -0.66, 2.36, 0, 0.26, 1.3, 0.26, -0.12)
    at(CYL8, cloth, 0.66, 2.36, 0, 0.26, 1.3, 0.26, 0.12)
    at(BALL, SKIN, -0.74, 1.66, 0, 0.26, 0.3, 0.26)
    at(BALL, SKIN, 0.74, 1.66, 0, 0.26, 0.3, 0.26)
    at(CYL8, SKIN, 0, 3.17, 0, 0.26, 0.22, 0.26)
    // no face: a mannequin is an egg
    at(BALL, SKIN, 0, 3.52, 0, 0.56, 0.68, 0.6)
    const hat = r()
    if (!dress && hat < 0.5) {
      at(CYL12, '#3a3530', 0, 3.8, 0, 0.92, 0.05, 0.92)
      at(CYL12, '#3a3530', 0, 3.96, 0, 0.56, 0.3, 0.56)
    } else if (dress && hat < 0.35) {
      at(CYL12, cloth, 0, 3.86, -0.04, 0.5, 0.16, 0.5)
    }
    solid(x - 0.5, y, z - 0.5, x + 0.5, y + 3.9, z + 0.5)
  }

  /** a picket fence along a cardinal run: posts, two rails and pickets, and
      a vaultable box (a hop clears 1.7 in time, see src/game/CLAUDE.md) */
  const picket = (x0: number, z0: number, x1: number, z1: number) => {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0)
    const a0 = alongX ? Math.min(x0, x1) : Math.min(z0, z1)
    const a1 = alongX ? Math.max(x0, x1) : Math.max(z0, z1)
    const n = alongX ? z0 : x0
    const run = (p0: number, p1: number, y0: number, y1: number, n0: number, n1: number) =>
      alongX
        ? slab(props, PAL.picket, p0, y0, n + n0, p1, y1, n + n1, SURF.none)
        : slab(props, PAL.picket, n + n0, y0, p0, n + n1, y1, p1, SURF.none)
    run(a0, a1, 0.5, 0.62, -0.02, 0.06)
    run(a0, a1, 1.3, 1.42, -0.02, 0.06)
    for (let a = a0 + 0.12; a < a1 - 0.08; a += 0.46) run(a - 0.11, a + 0.11, 0.05, 1.85, -0.08, -0.02)
    for (let a = a0; a <= a1 + 0.01; a += Math.max(1, (a1 - a0) / Math.ceil((a1 - a0) / 3))) {
      run(a - 0.12, a + 0.12, 0, 2.0, -0.02, 0.2)
    }
    if (alongX) solid(a0, 0, n - 0.22, a1, 1.7, n + 0.22)
    else solid(n - 0.22, 0, a0, n + 0.22, 1.7, a1)
  }

  /** a board fence: a run of weathered planks between posts, the same
      vaultable height as the pickets */
  const boardFence = (x0: number, z0: number, x1: number, z1: number) => {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0)
    const a0 = alongX ? Math.min(x0, x1) : Math.min(z0, z1)
    const a1 = alongX ? Math.max(x0, x1) : Math.max(z0, z1)
    const n = alongX ? z0 : x0
    const run = (hex: string, p0: number, p1: number, y0: number, y1: number, n0: number, n1: number, surf: SurfaceId) =>
      alongX
        ? slab(props, hex, p0, y0, n + n0, p1, y1, n + n1, surf)
        : slab(props, hex, n + n0, y0, p0, n + n1, y1, p1, surf)
    run(PAL.board, a0, a1, 0.1, 1.95, -0.07, 0.07, SURF.plank)
    for (let a = a0; a <= a1 + 0.01; a += Math.max(1, (a1 - a0) / Math.ceil((a1 - a0) / 3.2))) {
      run('#6e5439', a - 0.14, a + 0.14, 0, 2.15, -0.14, 0.14, SURF.bark)
    }
    if (alongX) solid(a0, 0, n - 0.22, a1, 1.75, n + 0.22)
    else solid(n - 0.22, 0, a0, n + 0.22, 1.75, a1)
  }

  /* ----------------------------------------------------------- a house -- */

  /**
   * One house, garage, porch and yard, in its own frame: `u` along the
   * frontage and `v` back from the front wall, away from the street. `dir`
   * turns the whole frame half round for the far side of the street, which
   * keeps every box axis-aligned.
   */
  const raiseHouse = (dir: 1 | -1, hx: number, look: HouseLook, seed: number) => {
    const X = (u: number) => hx + dir * u
    const Z = (v: number) => dir * (FRONT + v)
    const rect = (u0: number, u1: number, v0: number, v1: number) => {
      const a = X(u0)
      const b = X(u1)
      const c = Z(v0)
      const d = Z(v1)
      return [Math.min(a, b), Math.max(a, b), Math.min(c, d), Math.max(c, d)] as const
    }
    const hb = (
      u0: number, u1: number, y0: number, y1: number, v0: number, v1: number,
      hex: string, surf: SurfaceId = SURF.plaster, out: MeshBuilder = props,
    ) => {
      const [x0, x1, z0, z1] = rect(u0, u1, v0, v1)
      slab(out, hex, x0, y0, z0, x1, y1, z1, surf)
    }
    const hs = (u0: number, u1: number, y0: number, y1: number, v0: number, v1: number, stand = false) => {
      const [x0, x1, z0, z1] = rect(u0, u1, v0, v1)
      solid(x0, y0, z0, x1, y1, z1, stand)
    }
    const hf = (u0: number, u1: number, v0: number, v1: number, s: StepSurface, y0 = -1, y1 = 99) => {
      const [x0, x1, z0, z1] = rect(u0, u1, v0, v1)
      floor(x0, x1, z0, z1, s, y0, y1)
    }
    /** a piece of furniture: drawn and solid; its top a floor unless not */
    const furn = (
      u0: number, u1: number, y0: number, y1: number, v0: number, v1: number,
      hex: string, stand = true, surf: SurfaceId = SURF.none,
    ) => {
      hb(u0, u1, y0, y1, v0, v1, hex, surf)
      hs(u0, u1, y0, y1, v0, v1, stand)
    }
    /** facing the street, as a yaw for something modelled facing +z */
    const streetYaw = dir > 0 ? Math.PI : 0
    const dummy = (u: number, y: number, v: number, turn: number, k: number) =>
      mannequin(X(u), y, Z(v), streetYaw + turn * dir, seed * 31 + k)

    /**
     * The white frame round an opening, proud of the siding: a head, two
     * jambs and, under a window, a sill the light catches; and in a
     * window's hole, a cross of glazing bars on the wall's own plane.
     */
    const trim = (axis: 'u' | 'v', at: number, out: 1 | -1, base: number, c: Opening, door: boolean, shutter?: string) => {
      const f0 = at + out * T
      const f1 = at + out * (T + 0.12)
      const tb = (pa0: number, pa1: number, py0: number, py1: number, m0: number, m1: number, hex = PAL.trim) => {
        const n0 = Math.min(m0, m1)
        const n1 = Math.max(m0, m1)
        if (axis === 'u') hb(pa0, pa1, base + py0, base + py1, n0, n1, hex, SURF.none)
        else hb(n0, n1, base + py0, base + py1, pa0, pa1, hex, SURF.none)
      }
      const w = 0.22
      tb(c.a0 - w, c.a1 + w, c.y1, c.y1 + w, f0, f1)
      tb(c.a0 - w, c.a0, door ? 0 : c.y0, c.y1, f0, f1)
      tb(c.a1, c.a1 + w, door ? 0 : c.y0, c.y1, f0, f1)
      if (door) return
      tb(c.a0 - w - 0.12, c.a1 + w + 0.12, c.y0 - 0.2, c.y0, f0, at + out * (T + 0.32))
      const am = (c.a0 + c.a1) / 2
      const ym = (c.y0 + c.y1) / 2
      tb(am - 0.05, am + 0.05, c.y0, c.y1, at - 0.05, at + 0.05)
      tb(c.a0, c.a1, ym - 0.05, ym + 0.05, at - 0.05, at + 0.05)
      if (shutter) {
        const sw = Math.min(1.1, (c.a1 - c.a0) * 0.42)
        tb(c.a0 - w - sw - 0.08, c.a0 - w - 0.08, c.y0, c.y1, f0, at + out * (T + 0.08), shutter)
        tb(c.a1 + w + 0.08, c.a1 + w + sw + 0.08, c.y0, c.y1, f0, at + out * (T + 0.08), shutter)
      }
    }

    /**
     * A wall plane at `at` (v = at for axis 'u', u = at for axis 'v'), from
     * a0 to a1, standing `hgt` from `base`, with rectangular holes. Cut
     * column by column between every edge a hole has, like the house's, in
     * two layers: siding outside (`out` is which side of the plane that is)
     * and paint in; a partition (`out` 0) is paint both sides. Collision
     * runs are split only by holes that reach the floor.
     */
    const wall = (
      axis: 'u' | 'v', at: number, a0: number, a1: number, base: number, hgt: number,
      out: 1 | -1 | 0, ext: string, int: string, cuts: Opening[] = [],
      o: { shutter?: string; leaf?: string } = {},
    ) => {
      const layer = (pa0: number, pa1: number, py0: number, py1: number, m0: number, m1: number, hex: string, surf: SurfaceId) => {
        const n0 = Math.min(m0, m1)
        const n1 = Math.max(m0, m1)
        if (axis === 'u') hb(pa0, pa1, base + py0, base + py1, n0, n1, hex, surf)
        else hb(n0, n1, base + py0, base + py1, pa0, pa1, hex, surf)
      }
      const piece = (pa0: number, pa1: number, py0: number, py1: number) => {
        if (pa1 - pa0 < 0.01 || py1 - py0 < 0.01) return
        if (out === 0) layer(pa0, pa1, py0, py1, at - T, at + T, int, SURF.plaster)
        else {
          layer(pa0, pa1, py0, py1, at, at + out * T, ext, SURF.plank)
          layer(pa0, pa1, py0, py1, at, at - out * T, int, SURF.plaster)
        }
      }
      const edges = [...new Set([a0, a1, ...cuts.flatMap((c) => [c.a0, c.a1])])]
        .filter((e) => e >= a0 && e <= a1)
        .sort((p, q) => p - q)
      for (let i = 0; i + 1 < edges.length; i++) {
        const a = edges[i]
        const b = edges[i + 1]
        const mid = (a + b) / 2
        const over = cuts.filter((c) => c.a0 < mid && c.a1 > mid).sort((p, q) => p.y0 - q.y0)
        let y = 0
        for (const c of over) {
          piece(a, b, y, c.y0)
          y = Math.max(y, c.y1)
        }
        piece(a, b, y, hgt)
      }
      const block = (c0: number, c1: number) => {
        if (c1 - c0 < 0.05) return
        if (axis === 'u') hs(c0 - 0.2, c1 + 0.2, base, base + hgt, at - 0.4, at + 0.4)
        else hs(at - 0.4, at + 0.4, base, base + hgt, c0 - 0.2, c1 + 0.2)
      }
      let cursor = a0
      for (const c of [...cuts].sort((p, q) => p.a0 - q.a0)) {
        const door = c.y0 <= 0.5
        if (out !== 0) trim(axis, at, out, base, c, door, door ? undefined : o.shutter)
        if (!door) continue
        block(cursor, c.a0)
        cursor = c.a1
        // the door stands open, swung in against the wall beside it
        if (o.leaf && out !== 0) {
          const w = c.a1 - c.a0
          layer(c.a0, c.a0 + 0.12, 0, c.y1 - 0.08, at - out * T, at - out * (T + w), o.leaf, SURF.none)
        }
      }
      block(cursor, a1)
    }

    const W = 8
    const D = 18
    const G1 = 17
    const GD = 13
    const DOOR = 4.7

    /* ---- the ground storey: living room at the front, kitchen behind */
    wall('u', 0, -W - T, W + T, 0, UP, -1, look.siding, look.living, [
      { a0: -3.8, a1: -1.7, y0: 0, y1: DOOR },
      { a0: 1, a1: 6, y0: 1.6, y1: 4.4 },
      { a0: -7.1, a1: -5.4, y0: 2.4, y1: 4.4 },
    ], { shutter: look.shutter, leaf: look.door })
    wall('u', D, -W - T, W + T, 0, UP, 1, look.siding, look.kitchen, [
      { a0: 2, a1: 4.1, y0: 0, y1: DOOR },
      { a0: -6, a1: -2.5, y0: 3.1, y1: 4.8 },
      { a0: 5.4, a1: 7.2, y0: 2.2, y1: 4.4 },
    ], { leaf: look.door })
    wall('v', -W, 0, 11, 0, UP, -1, look.siding, look.living)
    wall('v', -W, 11, D, 0, UP, -1, look.siding, look.kitchen, [{ a0: 13, a1: 16, y0: 2.2, y1: 4.4 }])
    // the garage's side of the house: the door through, and a kitchen
    // window past the garage's back wall
    wall('v', W, 0, 11, 0, UP, 1, look.siding, look.living, [{ a0: 7.9, a1: 9.9, y0: 0, y1: DOOR }], { leaf: '#8a6a4a' })
    wall('v', W, 11, D, 0, UP, 1, look.siding, look.kitchen, [{ a0: 14.5, a1: 17, y0: 2.2, y1: 4.4 }])
    wall('u', 11, -W + T, W - T, 0, CEIL_H, 0, look.living, look.living, [{ a0: 3.8, a1: 6, y0: 0, y1: DOOR }])

    /* ---- the upper storey: two bedrooms, the stairwell in the front one */
    wall('u', 0, -W - T, W + T, UP, CEIL_H, -1, look.siding, look.bedroom, [
      { a0: -6.5, a1: -3.5, y0: 1.8, y1: 4.4 },
      { a0: 1, a1: 5, y0: 1.8, y1: 4.4 },
    ], { shutter: look.shutter })
    wall('u', D, -W - T, W + T, UP, CEIL_H, 1, look.siding, look.back, [
      { a0: -2, a1: 2, y0: 1.8, y1: 4.4 },
      { a0: 4, a1: 7, y0: 1.8, y1: 4.4 },
    ])
    wall('v', -W, 0, 13, UP, CEIL_H, -1, look.siding, look.bedroom, [{ a0: 2.8, a1: 5.8, y0: 1.8, y1: 4.4 }])
    wall('v', -W, 13, D, UP, CEIL_H, -1, look.siding, look.back, [{ a0: 14, a1: 17, y0: 1.8, y1: 4.4 }])
    wall('v', W, 0, 13, UP, CEIL_H, 1, look.siding, look.bedroom, [{ a0: 3, a1: 7, y0: 1.8, y1: 4.4 }])
    wall('v', W, 13, D, UP, CEIL_H, 1, look.siding, look.back, [{ a0: 14.2, a1: 16.8, y0: 1.8, y1: 4.4 }])
    wall('u', 13, -W + T, W - T, UP, CEIL_H, 0, look.bedroom, look.bedroom, [{ a0: 2, a1: 4.2, y0: 0, y1: DOOR }])

    /* ---- floors, the slab between the storeys, the ceiling and the roof */
    hb(-W + T, W - T, 0, 0.12, T, D - T, PAL.wood, SURF.plank)
    hs(-W + T, W - T, 0, 0.12, T, D - T, true)
    hf(-W, W, 0, D, 'wood')
    const S0 = 2
    const S1 = 10.4
    const SU0 = -W + T
    const SU1 = -5.3
    // the slab, less the stairwell over the flight
    for (const [u0, u1, v0, v1] of [
      [-W + T, W - T, T, S0],
      [SU1, W - T, S0, S1],
      [-W + T, W - T, S1, D - T],
    ]) {
      hb(u0, u1, CEIL_H, CEIL_H + 0.28, v0, v1, PAL.ceiling)
      hb(u0, u1, CEIL_H + 0.28, UP, v0, v1, PAL.wood, SURF.plank)
      hs(u0, u1, CEIL_H, UP, v0, v1, true)
    }
    // the ceiling upstairs, which outside is the soffit under the eaves
    const EAVE = UP + CEIL_H
    hb(-W - 0.85, W + 0.85, EAVE - 0.14, EAVE + 0.06, -0.85, D + 0.85, PAL.trim)
    put(props, PRISM, look.roof, hx, EAVE + 0.06, Z(D / 2), 0, 0, 0, 2 * W + 1.9, 4.4, D + 2, SURF.shingle)
    roofSolids(boxes, PRISM, hx, EAVE + 0.06, Z(D / 2), 0, 2 * W + 1.9, 4.4, D + 2)
    // the chimney up the west gable
    hb(-W - 1.2, -W - T, 0, EAVE + 5.4, 7, 9, PAL.brick, SURF.brick)
    hb(-W - 1.35, -W - 0.05, EAVE + 5.4, EAVE + 5.7, 6.85, 9.15, PAL.concrete)
    hs(-W - 1.2, -W - T, 0, EAVE + 5.7, 7, 9)

    /* ---- the stairs: up the west wall from the front door, arriving on
       the landing at the head of the front bedroom */
    const STEPS = 15
    const RISE = UP / (STEPS + 1)
    const TREAD = (S1 - S0) / STEPS
    for (let k = 1; k <= STEPS; k++) {
      const top = k * RISE
      const v0 = S0 + (k - 1) * TREAD
      const v1 = v0 + TREAD
      hb(SU0, SU1, 0.12, top, v0, v1, PAL.stair)
      hb(SU0, SU1 + 0.06, top - 0.06, top + 0.02, v0 - 0.06, v1, PAL.wood, SURF.plank)
      // overlapping to the top of the flight, like the house's, so no seam
      // between two treads is a line a point-body can ride through the side
      hs(SU0, SU1, 0, top, v0, S1, true)
      hs(SU1 - 0.2, SU1 + 0.1, top, top + 2.4, v0, S1)
      hb(SU1 - 0.05, SU1 + 0.05, top, top + 2.3, (v0 + v1) / 2 - 0.05, (v0 + v1) / 2 + 0.05, PAL.trim, SURF.none)
    }
    hb(SU1 - 0.13, SU1 + 0.13, 0.12, 3.1, S0, S0 + 0.26, PAL.wood, SURF.none)
    strut(props, PAL.wood, X(SU1), 2.45 + RISE, Z(S0), X(SU1), UP + 2.45, Z(S1), 0.16, SURF.none)
    // the railing round the well upstairs, and its twin in the collision
    hb(SU1 - 0.08, SU1 + 0.08, UP + 2.35, UP + 2.55, S0, S1, PAL.wood, SURF.none)
    hb(SU0, SU1, UP + 2.35, UP + 2.55, S0 - 0.08, S0 + 0.08, PAL.wood, SURF.none)
    for (let v = S0 + 0.4; v < S1; v += 0.5) hb(SU1 - 0.05, SU1 + 0.05, UP, UP + 2.4, v - 0.05, v + 0.05, PAL.trim, SURF.none)
    for (let u = SU0 + 0.4; u < SU1; u += 0.5) hb(u - 0.05, u + 0.05, UP, UP + 2.4, S0 - 0.05, S0 + 0.05, PAL.trim, SURF.none)
    hs(SU1 - 0.2, SU1 + 0.1, UP, UP + 2.6, S0, S1)
    hs(SU0, SU1 + 0.1, UP, UP + 2.6, S0 - 0.15, S0 + 0.15)

    /* ---- the rooms, furnished like it is 1957 and nobody is home */
    // living: a sofa against the partition, a coffee table, a console set
    furn(-3, 2.5, 0.12, 1.5, 8.9, 10.5, look.sofa)
    hb(-3, 2.5, 1.5, 3.0, 9.9, 10.5, look.sofa, SURF.none)
    hs(-3, 2.5, 1.5, 3.0, 9.9, 10.5)
    furn(-3.35, -3, 0.12, 2.1, 8.9, 10.5, look.sofa)
    furn(2.5, 2.85, 0.12, 2.1, 8.9, 10.5, look.sofa)
    furn(-1.8, 1.4, 0.12, 1.3, 6.2, 7.4, PAL.wood, true, SURF.plank)
    hb(-3.6, 3.2, 0.12, 0.15, 4.6, 8.2, '#8e4b43', SURF.none)
    furn(6.0, 7.8, 0.12, 3.0, 2.6, 5.2, '#6d4b33')
    hb(5.94, 6.0, 1.1, 2.6, 3.0, 4.8, '#39433f', SURF.none)
    // kitchen: counters and a stove along the back, the icebox, a table
    furn(-7.8, -1.5, 0.12, 2.9, 16.2, D - T, '#e8e1d0')
    hb(-7.8, -1.4, 2.9, 3.06, 16.1, D - T, '#b44d40', SURF.none)
    hb(-7.8, -3.4, 4.5, 5.8, 16.9, D - T, '#e8e1d0', SURF.none)
    furn(-1.5, 0.5, 0.12, 2.9, 16.2, D - T, '#efe9dc')
    hb(-1.4, 0.4, 2.9, 2.96, 16.4, 17.6, '#2e2b29', SURF.none)
    furn(5.3, 7.8, 0.12, 5.4, 15.9, D - T, '#ebe6dc', false)
    hb(5.25, 5.3, 2.6, 4.4, 16.1, 16.3, PAL.chrome, SURF.none)
    furn(-3, 1, 0.12, 2.5, 12.8, 14.8, '#d5cebc')
    furn(-2.6, -1.4, 0.12, 1.5, 11.9, 12.6, '#b44d40')
    furn(-0.6, 0.6, 0.12, 1.5, 15.0, 15.7, '#b44d40')
    // upstairs: a bed under the east window, a dresser, and the back room's
    furn(3.4, W - T, UP, UP + 1.5, 2.6, 7.0, '#ece5d4')
    hb(3.4, 7.3, UP + 1.5, UP + 1.62, 2.6, 7.0, look.bedspread, SURF.none)
    hb(7.4, W - T, UP + 1.5, UP + 3.1, 2.6, 7.0, PAL.wood, SURF.none)
    hs(7.4, W - T, UP + 1.5, UP + 3.1, 2.6, 7.0)
    furn(-2.5, 1, UP, UP + 2.9, 11.9, 12.7, '#7a5234')
    furn(-W + T, -3.6, UP, UP + 1.5, 14.6, D - T, '#ece5d4')
    hb(-W + T, -3.9, UP + 1.5, UP + 1.62, 14.6, D - T - 0.9, look.bedspread, SURF.none)
    furn(3, 6.8, UP, UP + 2.5, 16.7, D - T, PAL.wood, true, SURF.plank)
    hb(4, 5.2, UP + 2.5, UP + 3.3, 16.9, 17.6, '#6f4d34', SURF.none)

    /* ---- the garage: open, its door rolled up under the ceiling */
    wall('v', G1, -T, GD + T, 0, CEIL_H, 1, look.siding, PAL.garage, [{ a0: 5, a1: 7.5, y0: 2.6, y1: 4.2 }])
    wall('u', GD, W + T, G1 + T, 0, CEIL_H, 1, look.siding, PAL.garage)
    wall('u', 0, W + T, G1 + T, 0, CEIL_H, -1, look.siding, PAL.garage, [{ a0: W + 0.7, a1: G1 - 0.6, y0: 0, y1: 5 }])
    hb(W + 0.7, G1 - 0.6, 5.05, 5.2, 0.3, 7.4, look.garageDoor, SURF.plank)
    hb(W + T, G1 - T, 0, 0.25, T, GD - T, PAL.concrete, SURF.paving)
    hs(W + T, G1 - T, 0, 0.25, T, GD - T, true)
    hf(W, G1, 0, GD, 'stone')
    hb(W + T, G1 + 0.7, CEIL_H - 0.14, CEIL_H + 0.02, -0.7, GD + 0.7, PAL.trim)
    const gx = X((W + G1) / 2 + 0.2)
    const gz = Z(GD / 2)
    put(props, PRISM, look.roof, gx, CEIL_H + 0.02, gz, 0, Math.PI / 2, 0, GD + 1.4, 2.6, G1 - W + 1.2, SURF.shingle)
    roofSolids(boxes, PRISM, gx, CEIL_H + 0.02, gz, Math.PI / 2, GD + 1.4, 2.6, G1 - W + 1.2)
    furn(W + 1, W + 6.2, 0.25, 2.8, GD - 1.5, GD - T, PAL.wood, true, SURF.plank)
    furn(G1 - 1.1, G1 - T, 0.25, 4.6, 2, 6.5, '#7b7d77', false)
    for (let k = 0; k < 3; k++) {
      put(props, CYL12, ['#9e4034', '#d8c07a', '#5f7d91'][k], X(W + 1.6 + k * 0.9), 3.15, Z(GD - 0.7), 0, 0, 0, 0.7, 0.7, 0.7, SURF.none)
    }

    /* ---- the porch, the front yard, the walk and the drive */
    hb(-8.4, 2.4, 0, 0.4, -3.2, -T, PAL.wood, SURF.plank)
    hs(-8.4, 2.4, 0, 0.4, -3.2, -T, true)
    hf(-8.4, 2.4, -3.2, 0, 'wood')
    hb(-8.7, 2.7, 5.2, 5.5, -3.6, -T, PAL.trim)
    hb(-8.75, 2.75, 5.5, 5.62, -3.65, -T, look.roof, SURF.shingle)
    hs(-8.7, 2.7, 5.2, 5.62, -3.6, -T, true)
    for (const u of [-8.1, -4.3, 2.1]) {
      hb(u - 0.15, u + 0.15, 0.4, 5.2, -3.15, -2.85, PAL.trim, SURF.none)
      hs(u - 0.15, u + 0.15, 0.4, 5.2, -3.15, -2.85)
    }
    hb(-8.1, -4.3, 1.55, 1.7, -3.08, -2.92, PAL.trim, SURF.none)
    for (let u = -7.7; u < -4.4; u += 0.45) hb(u - 0.05, u + 0.05, 0.4, 1.6, -3.04, -2.96, PAL.trim, SURF.none)
    hs(-8.1, -4.3, 0.4, 1.7, -3.2, -2.8)
    hb(-12, 8.45, -0.05, 0.06, -10.5, -T, PAL.lawn, SURF.none, flat)
    hf(-12, 8.45, -10.5, 0, 'grass')
    hb(-3.75, -1.75, 0, 0.22, -10.5, -3.2, PAL.concrete, SURF.paving, flat)
    hs(-3.75, -1.75, 0, 0.22, -10.5, -3.2, true)
    hf(-3.75, -1.75, -10.5, -3.2, 'stone')
    hb(8.45, 16.7, 0, 0.22, -10.5, -T, PAL.concrete, SURF.paving, flat)
    hs(8.45, 16.7, 0, 0.22, -10.5, -T, true)
    hf(8.45, 16.7, -10.5, 0, 'stone')
    // the front fence, the mailbox on its post, two clipped shrubs
    const fx = (u: number) => X(u)
    const fz = Z(-10.2)
    picket(fx(-12), fz, fx(-4.3), fz)
    picket(fx(-1.2), fz, fx(8.2), fz)
    hb(7.5, 7.7, 0.22, 2.5, -13.4, -13.2, '#6b5a4a', SURF.none)
    hb(7.25, 7.95, 2.5, 3.2, -13.9, -12.7, '#3d5d78', SURF.none)
    hs(7.4, 7.8, 0, 3.2, -13.9, -12.7)
    for (const u of [-10.3, 6.8]) {
      put(props, BALL, '#5c7a3f', X(u), 0.9, Z(-1.4), 0, 0, 0, 2.2, 1.9, 2.0, SURF.none)
      hs(u - 0.9, u + 0.9, 0, 1.6, -2.3, -0.5)
    }

    /* ---- the back yard: lawn in patches on the sand, a fence round it */
    hb(-11.8, 1.8, -0.05, 0.06, D + 0.4, 26, PAL.lawn, SURF.none, flat)
    hf(-11.8, 1.8, D + 0.4, 26, 'grass')
    hb(3, 18.6, -0.05, 0.05, 19.5, 31.4, PAL.lawnDry, SURF.none, flat)
    hf(3, 18.6, 19.5, 31.4, 'grass')
    hb(-11.8, -1, -0.05, 0.055, 27.2, 31.4, PAL.lawn, SURF.none, flat)
    hf(-11.8, -1, 27.2, 31.4, 'grass')
    hb(2, 4.1, 0, 0.3, D + T, D + 1.4, PAL.concrete, SURF.paving)
    hs(2, 4.1, 0, 0.3, D + T, D + 1.4, true)
    boardFence(X(-12), Z(31.8), X(19), Z(31.8))
    boardFence(X(-12), Z(-10.2), X(-12), Z(6))
    boardFence(X(-12), Z(9.5), X(-12), Z(31.8))
    boardFence(X(19), Z(-0.2), X(19), Z(22))
    boardFence(X(19), Z(25), X(19), Z(31.8))
    // a picnic table and its benches, and a washing line with the washing out
    furn(-1, 3.5, 0, 1.9, 23.2, 25.4, PAL.wood, true, SURF.plank)
    furn(-1, 3.5, 0, 1.1, 22.2, 22.8, PAL.wood, true, SURF.plank)
    furn(-1, 3.5, 0, 1.1, 25.8, 26.4, PAL.wood, true, SURF.plank)
    for (const u of [-9, 1]) {
      hb(u - 0.12, u + 0.12, 0, 5, 29 - 0.12, 29 + 0.12, '#7c7a74', SURF.none)
      hb(u - 0.12, u + 0.12, 4.8, 4.95, 28.2, 29.8, '#7c7a74', SURF.none)
      hs(u - 0.2, u + 0.2, 0, 5, 28.8, 29.2)
    }
    for (const dv of [-0.7, 0.7]) strut(props, '#dcd6c6', X(-9), 4.85, Z(29 + dv), X(1), 4.7, Z(29 + dv), 0.04, SURF.none)
    for (const [u, hex] of [[-7.5, '#e9e3d6'], [-5.2, '#c9798a'], [-2.6, '#e9e3d6'], [-0.4, '#86a7c2']] as const) {
      hb(u - 0.9, u + 0.9, 3.0, 4.8, 28.26, 28.32, hex, SURF.none)
    }

    /* ---- who is standing about */
    dummy(-6, 0.4, -1.6, 0.3, 1)
    dummy(3.5, 0.06, -6.5, -0.4, 2)
    dummy(12.5, 0.25, 8.5, 0.9, 3)
    dummy(2.6, 0.12, 14.4, 2.2, 4)
    dummy(-1.5, UP, 5.5, 0.1, 5)
    dummy(-4, 0.06, 23.5, 1.4, 6)
    dummy(12, 0.06, 27, -2.4, 7)

    roofs.push(
      (() => { const [x0, x1, z0, z1] = rect(-W, W, 0, D); return { x0, x1, z0, z1 } })(),
      (() => { const [x0, x1, z0, z1] = rect(W, G1, 0, GD); return { x0, x1, z0, z1 } })(),
    )
  }

  /* -------------------------------------------------------- the vehicles -- */

  /** the school bus, across the middle of the street, nose to +z */
  const bus = () => {
    const Y = '#d9a52c'
    const K = PAL.tire
    slab(props, K, -2.2, 0.6, -10, 2.2, 1.3, 8, SURF.none)
    slab(props, Y, -2.4, 1.3, -10.6, 2.4, 6.1, 8.2, SURF.none)
    slab(props, Y, -2.2, 6.1, -10.5, 2.2, 6.45, 8.1, SURF.none)
    slab(props, Y, -2.0, 1.3, 8.2, 2.0, 4.1, 11.3, SURF.none)
    slab(props, '#3a3836', -1.4, 1.6, 11.3, 1.4, 3.7, 11.36, SURF.none)
    slab(props, K, -2.5, 0.9, 11.3, 2.5, 1.5, 11.8, SURF.none)
    slab(props, K, -2.5, 0.9, -11.1, 2.5, 1.5, -10.6, SURF.none)
    // the black rub rails, and the glass: boxes through the body, so both
    // sides are drawn by one stamp
    for (const y of [1.9, 3.0, 3.72]) slab(props, K, -2.46, y - 0.09, -10.6, 2.46, y + 0.09, 8.2, SURF.none)
    for (let zc = -9.3; zc < 7; zc += 1.8) slab(props, PAL.glass, -2.45, 3.95, zc - 0.7, 2.45, 5.6, zc + 0.7, SURF.none)
    slab(props, PAL.glass, -2.1, 4.0, 8.18, 2.1, 5.8, 8.26, SURF.none)
    slab(props, PAL.glass, -1.6, 3.95, -10.66, 1.6, 5.6, -10.56, SURF.none)
    slab(props, PAL.glass, -2.48, 1.5, 6.6, -2.38, 5.6, 7.9, SURF.none)
    put(props, CYL8, '#b33b30', -2.62, 4.4, 5.6, 0, 0, Math.PI / 2, 0.95, 0.08, 0.95, SURF.none)
    for (const x of [-1.5, 1.5]) put(props, BALL, '#f1ead2', x, 3.2, 11.34, 0, 0, 0, 0.55, 0.55, 0.2, SURF.none)
    for (const z of [-6.5, 7.2]) {
      for (const x of [-2.2, 2.2]) {
        put(props, CYL12, K, x, 1.1, z, 0, 0, Math.PI / 2, 2.2, 0.8, 2.2, SURF.none)
        put(props, CYL12, '#9c988e', x + Math.sign(x) * 0.42, 1.1, z, 0, 0, Math.PI / 2, 0.9, 0.05, 0.9, SURF.none)
      }
    }
    solid(-2.5, 0, -11.1, 2.5, 6.45, 8.2, true)
    solid(-2.5, 0, 8.2, 2.5, 4.1, 11.8, true)
    floor(-2.5, 2.5, -11.1, 11.8, 'stone', 1, 99)
  }

  /** the camper trailer, cream over turquoise, on its jack */
  const camper = (cx: number, cz: number, face: 1 | -1) => {
    const CREAM = '#e8dfc7'
    const AQUA = '#6db0a7'
    slab(props, CREAM, cx - 6.5, 1.3, cz - 2.7, cx + 6.5, 5.2, cz + 2.7, SURF.none)
    slab(props, AQUA, cx - 6.55, 1.3, cz - 2.75, cx + 6.55, 2.6, cz + 2.75, SURF.none)
    put(props, BARREL, CREAM, cx, 5.2, cz, 0, 0, 0, 13, 0.8, 5.4, SURF.none)
    for (const e of [-1, 1]) put(props, CYL12, CREAM, cx + e * 6.5, 3.25, cz, 0, 0, 0, 2.4, 3.9, 5.4, SURF.none)
    for (const [a, b] of [[-5, -2], [1.5, 4.5]]) slab(props, PAL.glass, cx + a, 3.2, cz - 2.78, cx + b, 4.6, cz + 2.78, SURF.none)
    slab(props, '#4f8f87', cx - 0.8, 1.4, cz - face * 2.8, cx + 0.8, 4.9, cz - face * 2.72, SURF.none)
    for (const s of [-1, 1]) put(props, CYL12, PAL.tire, cx, 1.0, cz + s * 2.55, Math.PI / 2, 0, 0, 2, 0.5, 2, SURF.none)
    for (const s of [-1, 1]) strut(props, PAL.steel, cx + 7.4, 1.4, cz + s * 1.4, cx + 10, 1.1, cz, 0.18, SURF.none)
    slab(props, PAL.steel, cx + 9.8, 0, cz - 0.12, cx + 10.05, 1.2, cz + 0.12, SURF.none)
    solid(cx - 7.7, 0, cz - 2.8, cx + 7.7, 6.0, cz + 2.8, true)
    solid(cx + 7.7, 0, cz - 1.5, cx + 10.2, 1.4, cz + 1.5)
    floor(cx - 7.7, cx + 7.7, cz - 2.8, cz + 2.8, 'stone', 1, 99)
  }

  /** the pickup: faded red, nose to +x, its bed empty */
  const pickup = (cx: number, cz: number) => {
    const RED = '#9d4c3b'
    const K = PAL.tire
    slab(props, '#5a4a40', cx - 5.2, 1.4, cz - 2.1, cx - 0.4, 1.9, cz + 2.1, SURF.plank)
    for (const s of [-1, 1]) slab(props, RED, cx - 5.2, 1.4, cz + s * 2.05, cx - 0.4, 3.0, cz + s * 2.3, SURF.none)
    slab(props, RED, cx - 5.3, 1.4, cz - 2.3, cx - 5.05, 3.0, cz + 2.3, SURF.none)
    slab(props, RED, cx - 0.4, 1.4, cz - 2.3, cx + 2.8, 3.2, cz + 2.3, SURF.none)
    slab(props, RED, cx - 0.3, 3.2, cz - 2.1, cx + 2.4, 5.0, cz + 2.1, SURF.none)
    slab(props, PAL.glass, cx, 3.4, cz - 2.14, cx + 2.2, 4.7, cz + 2.14, SURF.none)
    slab(props, PAL.glass, cx + 2.36, 3.4, cz - 1.8, cx + 2.44, 4.7, cz + 1.8, SURF.none)
    slab(props, RED, cx + 2.8, 1.4, cz - 2.1, cx + 6.4, 3.1, cz + 2.1, SURF.none)
    slab(props, RED, cx + 3.4, 1.2, cz - 2.4, cx + 5.8, 2.4, cz + 2.4, SURF.none)
    slab(props, RED, cx - 4.4, 1.2, cz - 2.4, cx - 1.8, 2.4, cz + 2.4, SURF.none)
    slab(props, PAL.chrome, cx + 6.4, 1.6, cz - 1.6, cx + 6.5, 2.9, cz + 1.6, SURF.none)
    slab(props, PAL.chrome, cx + 6.4, 1.0, cz - 2.3, cx + 6.8, 1.5, cz + 2.3, SURF.none)
    for (const x of [cx + 4.6, cx - 3.1]) {
      for (const s of [-1, 1]) put(props, CYL12, K, x, 1.0, cz + s * 2.2, Math.PI / 2, 0, 0, 2.0, 0.6, 2.0, SURF.none)
    }
    solid(cx - 5.3, 0, cz - 2.4, cx + 2.8, 3.0, cz + 2.4, true)
    solid(cx - 0.4, 3.0, cz - 2.3, cx + 2.8, 5.0, cz + 2.3, true)
    solid(cx + 2.8, 0, cz - 2.4, cx + 6.8, 3.1, cz + 2.4, true)
    floor(cx - 5.3, cx + 6.8, cz - 2.4, cz + 2.4, 'stone', 1, 99)
  }

  /* ------------------------------------------------------ the two sides -- */

  const rng = seeded(0x4e554b45)

  /** one side of the street, the other being this turned half round */
  const raiseSide = (dir: 1 | -1) => {
    const P = (x: number) => dir * x
    // the sidewalk the length of the block, a kerb's height up
    slab(flat, PAL.concrete, -HALF_X - 6, 0, P(STREET), HALF_X + 6, 0.22, P(WALK), SURF.paving)
    solid(-HALF_X - 6, 0, P(STREET), HALF_X + 6, 0.22, P(WALK), true)
    floor(-HALF_X - 6, HALF_X + 6, P(STREET), P(WALK), 'stone')
    // the lot past the fences at either end: a crate or two, oil drums, a
    // shed, sandbags, a power pole, a hydrant
    const crate = (x: number, z: number, y: number, s: number) => {
      slab(props, '#8f6d45', x - s / 2, y, z - s / 2, x + s / 2, y + s, z + s / 2, SURF.plank)
      solid(x - s / 2, y, z - s / 2, x + s / 2, y + s, z + s / 2, true)
    }
    crate(P(-31), P(16.5), 0, 2.4)
    crate(P(-31.2), P(16.4), 2.4, 1.8)
    crate(P(-28.4), P(17.2), 0, 1.9)
    crate(P(30), P(47), 0, 2.4)
    for (const [dx, dz] of [[0, 0], [1.9, 0.4], [0.8, 1.8], [2.7, 2.1]]) {
      const x = P(58 + dx)
      const z = P(40 + dz)
      put(props, CYL12, dx > 2 ? '#7e3c30' : '#3f5a4a', x, 1.3, z, 0, 0, 0, 1.7, 2.6, 1.7, SURF.none)
      solid(x - 0.85, 0, z - 0.85, x + 0.85, 2.6, z + 0.85, true)
    }
    // the shed: plank walls, a tin roof, a door on the latch
    const sx = P(38)
    const sz = P(42)
    slab(props, '#8f7458', sx - 4, 0, sz - 3.5, sx + 4, 6, sz + 3.5, SURF.plank)
    put(props, PRISM, '#6f7478', sx, 6, sz, 0, 0, 0, 9, 2, 8, SURF.panel)
    roofSolids(boxes, PRISM, sx, 6, sz, 0, 9, 2, 8)
    slab(props, '#5a4633', sx - 1, 0, sz - dir * 3.56, sx + 1, 4.6, sz - dir * 3.5, SURF.plank)
    solid(sx - 4, 0, sz - 3.5, sx + 4, 6, sz + 3.5)
    // sandbags, stacked in a low wall a body can hop
    for (let k = 0; k < 7; k++) {
      for (let row = 0; row < 3; row++) {
        const x = P(-62 + k * 1.3 + (row % 2) * 0.65)
        put(props, BALL, row === 1 ? '#a89a76' : '#b5a680', x, 0.25 + row * 0.42, P(36), 0, 0, 0, 1.4, 0.55, 0.9, SURF.none)
      }
    }
    solid(P(-62.7), 0, P(35.4), P(-53.5), 1.35, P(36.6), true)
    // the power pole on the kerb and the hydrant
    const px = P(-22)
    const pz = P(12.6)
    put(props, CYL8, '#6b5540', px, 7, pz, 0, 0, 0, 0.5, 14, 0.5, SURF.bark)
    slab(props, '#6b5540', px - 2, 12.6, pz - 0.15, px + 2, 12.9, pz + 0.15, SURF.bark)
    solid(px - 0.3, 0, pz - 0.3, px + 0.3, 14, pz + 0.3)
    const hx = P(18)
    const hz = P(12.4)
    put(props, CYL12, '#b33b30', hx, 0.9, hz, 0, 0, 0, 0.6, 1.4, 0.6, SURF.none)
    put(props, BALL, '#b33b30', hx, 1.6, hz, 0, 0, 0, 0.62, 0.5, 0.62, SURF.none)
    solid(hx - 0.35, 0, hz - 0.35, hx + 0.35, 1.85, hz + 0.35)
  }

  raiseHouse(1, -12, YELLOW, 1)
  raiseHouse(-1, 12, TEAL, 2)
  raiseSide(1)
  raiseSide(-1)
  bus()
  camper(-46, 27, 1)
  pickup(46, -27)
  // people in the street, and one waiting for the bus
  mannequin(-6, 0.04, 4.5, Math.PI * 0.7, 91)
  mannequin(5.5, 0.04, -3.5, -Math.PI * 0.35, 92)
  mannequin(-3.4, 0.22, -9.6, Math.PI * 0.1, 93)
  mannequin(31, 0.22, 10.2, Math.PI * 1.1, 94)
  mannequin(-33, 0.22, -9.8, Math.PI * 0.05, 95)
  mannequin(-40, 0.02, 22, Math.PI * 0.6, 96)
  mannequin(42, 0.02, -21, -Math.PI * 0.4, 97)

  /* ----------------------------------------------------- the street -- */

  // the road runs on out of the gate at both ends, to the horizon
  flat.quad(
    new THREE.Vector3(-420, 0.03, -STREET), new THREE.Vector3(-420, 0.03, STREET),
    new THREE.Vector3(420, 0.03, STREET), new THREE.Vector3(420, 0.03, -STREET),
    new THREE.Color(PAL.asphalt),
  )
  floor(-HALF_X - 10, HALF_X + 10, -STREET, STREET, 'asphalt')
  for (let x = -414; x < 414; x += 7) slab(flat, PAL.paint, x, 0.03, -0.13, x + 3.4, 0.06, 0.13, SURF.none)

  /* ---------------------------------------------------- the perimeter -- */

  /*
    Rocks round the block, the test site's own outcrops, heaped higher than
    anybody hops, with a continuous noStand wall behind them for the walk and
    the props; across the road at each end a line of concrete barriers and a
    striped boom. The level's bounds clamp just inside all of it.
  */
  const rock = (x: number, z: number, k: number) => {
    const s = 2.5 + rng() * 3.5
    const h = 3 + rng() * 6.5
    const d = 2.5 + rng() * 2.5
    put(props, BALL, PAL.rock[k % PAL.rock.length], x, h * 0.3, z, rng() * 0.3, rng() * Math.PI, 0, s * 1.6, h, d * 1.6, SURF.none)
  }
  let rk = 0
  for (let x = -80; x <= 80; x += 3.2 + rng() * 1.6) {
    rock(x, 61 + rng() * 2, rk++)
    rock(-x, -61 - rng() * 2, rk++)
  }
  for (let z = -60; z <= 60; z += 3.2 + rng() * 1.6) {
    if (Math.abs(z) < WALK + 1.5) continue
    rock(77 + rng() * 2, z, rk++)
    rock(-77 - rng() * 2, -z, rk++)
  }
  for (const s of [-1, 1]) {
    solid(-80, -1, s * 57.8, 80, 14, s * 64)
    solid(s * 73.4, -1, -64, s * 80, 14, 64)
    // the barriers and the boom across the road
    for (let z = -WALK; z < WALK - 0.1; z += 3.8) {
      const x = s * 73.8
      slab(props, PAL.concrete, x - 0.65, 0, z + 0.1, x + 0.65, 0.5, z + 3.7, SURF.paving)
      slab(props, PAL.concrete, x - 0.32, 0.5, z + 0.1, x + 0.32, 1.7, z + 3.7, SURF.paving)
    }
    const bx = s * 72.6
    slab(props, '#d7d0bd', bx - 0.3, 0, WALK - 1.4, bx + 0.3, 3.2, WALK - 0.8, SURF.none)
    for (let k = 0; k < 8; k++) {
      const z = WALK - 1.4 - (k + 1) * 1.6
      slab(props, k % 2 ? '#e9e3d4' : '#b8392f', bx - 0.14, 2.6, z, bx + 0.14, 2.9, z + 1.6, SURF.none)
    }
    solid(bx - 0.4, 0, -WALK, bx + 0.4, 3.2, WALK)
    // the site's warning board by the gate
    const gx = s * 69
    const gz = s * -13.2
    slab(props, '#5d5a55', gx - 1.9, 0, gz - 0.12, gx - 1.6, 5.4, gz + 0.12, SURF.none)
    slab(props, '#5d5a55', gx + 1.6, 0, gz - 0.12, gx + 1.9, 5.4, gz + 0.12, SURF.none)
    slab(props, '#2f2c2a', gx - 2.3, 2.8, gz - 0.08, gx + 2.3, 5.4, gz + 0.08, SURF.none)
    slab(props, '#dcb63d', gx - 2.1, 3.0, gz - 0.12, gx + 2.1, 5.2, gz + 0.12, SURF.none)
    put(props, CYL12, '#2f2c2a', gx, 4.1, gz, Math.PI / 2, 0, 0, 1.3, 0.3, 1.3, SURF.none)
    solid(gx - 2.3, 0, gz - 0.3, gx + 2.3, 5.4, gz + 0.3)
  }

  /* ------------------------------------------------------ the desert -- */

  /*
    The ground: one grid 840 units across, flat inside the block and heaving
    into dunes past it, except along the road, which runs out flat through a
    cut. Built by hand rather than stamped, because it wants shared vertices
    (a smooth colour field and smooth dunes), in the same vertex format as the
    soup so it draws with the same material.
  */
  const N = 120
  const SIZE = 840
  const cell = SIZE / N
  const gPos = new Float32Array((N + 1) * (N + 1) * 3)
  const gCol = new Float32Array((N + 1) * (N + 1) * 3)
  const sandC = new THREE.Color(PAL.sand)
  const duneAt = (x: number, z: number) => {
    const d = Math.max(Math.abs(x) - 80, Math.abs(z) - 64, 0)
    if (d <= 0) return 0
    const t = Math.min(1, d / 70)
    const road = smooth01((Math.abs(z) - 18) / 26)
    return t * t * (2 + fbm(x / 60, z / 60, 0x6e75, 3) * 14) * road
  }
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = -SIZE / 2 + i * cell
      const z = -SIZE / 2 + j * cell
      const k = (j * (N + 1) + i) * 3
      gPos[k] = x
      gPos[k + 1] = duneAt(x, z)
      gPos[k + 2] = z
      const g = 0.9 + 0.12 * fbm(x / 45 + 3, z / 45 - 5, 0x6e76, 3) + (noise2(x / 9, z / 9, 0x6e77) - 0.5) * 0.06
      gCol[k] = sandC.r * g
      gCol[k + 1] = sandC.g * g
      gCol[k + 2] = sandC.b * g
    }
  }
  const gIdx: number[] = []
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i
      const b = a + 1
      const c = a + N + 1
      const d = c + 1
      gIdx.push(a, c, d, a, d, b)
    }
  }
  const groundGeo = new THREE.BufferGeometry()
  groundGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3))
  groundGeo.setAttribute('color', new THREE.BufferAttribute(gCol, 3))
  groundGeo.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array((N + 1) * (N + 1)), 1))
  groundGeo.setAttribute('aSurf', new THREE.BufferAttribute(new Float32Array((N + 1) * (N + 1)).fill(SURF.plaster), 1))
  groundGeo.setIndex(gIdx)
  groundGeo.computeVertexNormals()

  // the horizon: mesas, a shot tower, the poles along the road, scrub
  for (const [ang, dist, r, h] of [
    [0.25, 265, 38, 46], [0.9, 280, 26, 62], [1.55, 255, 44, 38], [2.3, 275, 30, 54],
    [3.05, 260, 40, 44], [3.8, 275, 34, 58], [4.5, 250, 46, 36], [5.3, 270, 28, 66],
  ]) {
    const x = Math.cos(ang) * dist
    const z = Math.sin(ang) * dist
    const yaw = rng() * Math.PI
    const ex = 0.8 + rng() * 0.5
    const ez = 0.8 + rng() * 0.5
    const band = (y0: number, hh: number, r0: number, r1: number, hex: string) =>
      put(far, taper(r1 / r0, 9), hex, x, y0 + hh / 2, z, 0, yaw, 0, 2 * r0 * ex, hh, 2 * r0 * ez, SURF.plaster)
    band(-2, h * 0.34, r * 1.35, r * 1.02, PAL.mesa[0])
    band(h * 0.34 - 2, h * 0.52, r * 1.02, r * 0.95, PAL.mesa[1])
    band(h * 0.86 - 2, h * 0.14, r * 0.95, r * 0.9, PAL.mesa[2])
  }
  {
    // the shot tower: four legs leaning in, braced, a cab on top
    const tx = 250
    const tz = -170
    const H = 72
    const b0 = 8
    const b1 = 2.6
    const leg = (sx: number, sz: number, t: number) => [tx + sx * (b0 + (b1 - b0) * t), H * t, tz + sz * (b0 + (b1 - b0) * t)] as const
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
    for (const [sx, sz] of corners) {
      const [x0, y0, z0] = leg(sx, sz, 0)
      const [x1, y1, z1] = leg(sx, sz, 1)
      strut(far, PAL.steel, x0, y0, z0, x1, y1, z1, 0.7, SURF.none)
    }
    for (let k = 0; k < 6; k++) {
      const t0 = k / 6
      const t1 = (k + 1) / 6
      for (let c = 0; c < 4; c++) {
        const [ax, az] = corners[c]
        const [bx, bz] = corners[(c + 1) % 4]
        const p = leg(ax, az, t0)
        const q = leg(bx, bz, t1)
        strut(far, PAL.steel, p[0], p[1], p[2], q[0], q[1], q[2], 0.3, SURF.none)
        const p2 = leg(ax, az, t1)
        const q2 = leg(bx, bz, t1)
        strut(far, PAL.steel, p2[0], p2[1], p2[2], q2[0], q2[1], q2[2], 0.3, SURF.none)
      }
    }
    slab(far, '#8b8f8a', tx - 4.5, H, tz - 4.5, tx + 4.5, H + 7, tz + 4.5, SURF.panel)
    slab(far, '#5e615f', tx - 5.2, H + 7, tz - 5.2, tx + 5.2, H + 7.8, tz + 5.2, SURF.none)
    strut(far, PAL.steel, tx, H + 7.8, tz, tx, H + 18, tz, 0.3, SURF.none)
  }
  for (const s of [-1, 1]) {
    for (let x = 95; x < 330; x += 34) {
      const px = s * x
      const pz = s * 14
      put(far, CYL8, '#6b5540', px, 7, pz, 0, 0, 0, 0.55, 14, 0.55, SURF.bark)
      slab(far, '#6b5540', px - 2.2, 12.4, pz - 0.15, px + 2.2, 12.8, pz + 0.15, SURF.bark)
      if (x + 34 < 330) {
        for (const dx of [-1.8, 1.8]) strut(far, '#2f2d2b', px + dx, 12.8, pz, px + s * 34 + dx, 12.8, pz, 0.06, SURF.none)
      }
    }
  }
  for (let k = 0; k < 90; k++) {
    const a = rng() * Math.PI * 2
    const d = 95 + rng() * 160
    const x = Math.cos(a) * d
    const z = Math.sin(a) * d
    if (Math.abs(z) < 20) continue
    const y = duneAt(x, z)
    if (rng() < 0.55) {
      const s = 1.2 + rng() * 3.5
      put(far, BALL, PAL.rock[k % PAL.rock.length], x, y + s * 0.2, z, 0, rng() * 3, 0, s * 1.7, s, s * 1.4, SURF.none)
    } else {
      put(far, BALL, '#8a7a4e', x, y + 0.6, z, 0, 0, 0, 1.8, 1.3, 1.8, SURF.none)
    }
  }

  /* ------------------------------------------------------ assembling -- */

  const root = new THREE.Group()
  root.name = 'nuketown'
  root.visible = false
  o.parent.add(root)
  // the open world's own chunk materials: same programs, so nothing links
  const mats = makeChunkMats(o.trackTexture, o.trackDisposable)
  const mesh = (g: THREE.BufferGeometry | null, cast: boolean, receive: boolean, name: string) => {
    if (!g) return
    if (!g.getAttribute('aBirth')) bakeBirth(g, PREBORN)
    g.translate(NUKE_ORIGIN.x, 0, NUKE_ORIGIN.z)
    g.computeBoundingSphere()
    o.trackDisposable(g)
    const m = new THREE.Mesh(g, mats.detail)
    m.castShadow = cast
    m.receiveShadow = receive
    m.name = name
    root.add(m)
  }
  mesh(props.build(), true, true, 'nuketown-props')
  mesh(flat.build(), false, true, 'nuketown-street')
  mesh(groundGeo, false, true, 'nuketown-ground')
  mesh(far.build(), false, false, 'nuketown-horizon')
  root.updateMatrixWorld(true)
  root.traverse((ob) => {
    ob.matrixAutoUpdate = false
  })

  for (const b of boxes) b.translate(new THREE.Vector3(NUKE_ORIGIN.x, 0, NUKE_ORIGIN.z))

  /* ------------------------------------------------------ the level -- */

  /** the spawns, spread over both ends of the street and facing into it.
      Two players arriving together are handed different ones where they
      can be, and the scene's slot scatter (net/spawn.ts) keeps any two on
      one point from standing up inside each other */
  const SPAWNS: LevelSpawn[] = [
    { x: -64, z: -3, yaw: -Math.PI / 2 },
    { x: -64, z: 4.5, yaw: -Math.PI / 2 },
    { x: -57, z: 20, yaw: -Math.PI * 0.6 },
    { x: -58, z: -19, yaw: -Math.PI * 0.4 },
    { x: 64, z: 3, yaw: Math.PI / 2 },
    { x: 64, z: -4.5, yaw: Math.PI / 2 },
    { x: 57, z: -20, yaw: Math.PI * 0.6 },
    { x: 58, z: 19, yaw: Math.PI * 0.4 },
  ].map((s) => ({ ...s, x: s.x + NUKE_ORIGIN.x, z: s.z + NUKE_ORIGIN.z }))
  const pickSpawn = seeded((Date.now() ^ 0x6e756b65) >>> 0)
  let lastSpawn = -1

  const FLAT: SandboxGround = { lattice: () => 0, heightAt: () => 0 }

  /** how far inside a roof the lens is, eased over the doorstep, as the
      sky does it at home: the sky light is damped indoors, where the roof
      would have kept it out */
  let indoor = 0
  const indoorAt = (x: number, z: number) => {
    const lx = x - NUKE_ORIGIN.x
    const lz = z - NUKE_ORIGIN.z
    let best = -Infinity
    for (const r of roofs) best = Math.max(best, Math.min(lx - r.x0, r.x1 - lx, lz - r.z0, r.z1 - lz))
    return smooth01(1 + best / 1.8)
  }

  const HAZE = new THREE.Color('#dcc9a6')
  const BOUNCE = new THREE.Color('#c29a6b')
  const SUN = new THREE.Color('#fff0d6')
  const overrideLight = (rig: LevelLightRig) => {
    rig.moon.intensity = 0
    rig.windowSpill.intensity = 0
    rig.setMoonPool(0)
    rig.sun.color.lerp(SUN, 0.4)
    rig.sun.intensity *= 1.15
    rig.hemi.groundColor.lerp(BOUNCE, 0.45)
    rig.hemi.intensity *= 1.1 * (1 - 0.55 * indoor)
    rig.fog.color.lerp(HAZE, 0.6)
    rig.fog.near = 110
    rig.fog.far = 520
    rig.bg.copy(rig.fog.color)
  }

  const level: Level = {
    id: 'nuketown',
    groundY: 0,
    collision: makeCollisionSet(
      {
        minX: NUKE_ORIGIN.x - HALF_X,
        maxX: NUKE_ORIGIN.x + HALF_X,
        minZ: NUKE_ORIGIN.z - HALF_Z,
        maxZ: NUKE_ORIGIN.z + HALF_Z,
      },
      boxes,
    ),
    get spawn() {
      let k = Math.floor(pickSpawn() * SPAWNS.length)
      if (k === lastSpawn) k = (k + 1 + Math.floor(pickSpawn() * (SPAWNS.length - 1))) % SPAWNS.length
      lastSpawn = k
      return SPAWNS[k]
    },
    enter: () => {
      root.visible = true
      o.venue('away')
    },
    leave: () => {
      root.visible = false
      o.venue('earth')
    },
    update: (dt, p) => {
      indoor = indoorAt(p.x, p.z)
      o.homeUpdate(dt, p)
    },
    seamTo: () => null,
    overrideLight,
    // a desert morning, all day: the sun two thirds of the way up
    timeOfDay: 0.4,
    gravity: 1,
    sandbox: { ground: FLAT },
    outdoors: true,
    air: true,
    surfaceAt: (x, z, feetY, wet) => {
      if (wet > 0.12) return 'water'
      const lx = x - NUKE_ORIGIN.x
      const lz = z - NUKE_ORIGIN.z
      for (const f of floors) {
        if (lx >= f.x0 && lx <= f.x1 && lz >= f.z0 && lz <= f.z1 && feetY >= f.y0 && feetY <= f.y1) return f.s
      }
      return feetY > 0.6 ? 'stone' : 'sand'
    },
  }

  return { root, level }
}
