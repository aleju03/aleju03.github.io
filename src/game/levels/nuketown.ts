import * as THREE from 'three'
import { createMeshBuilder, type MeshBuilder } from '../core/geometry'
import { seeded } from '../core/rand'
import type { StepSurface } from '../core/sfx'
import { makeCollisionSet, noStand, type Solid } from '../physics/collision'
import type { SandboxGround } from '../sandbox/ground'
import { BALL, BARREL, BOX, CYL12, CYL8, HIP, PRISM, put, roofSolids, strut, taper } from '../world/kitbash'
import { SURF, type SurfaceId } from '../world/surface'
import { fbm, noise2 } from '../world/noise'
import { PREBORN, bakeBirth } from '../world/fade'
import { makeChunkMats } from '../world/streamer'
import { CEIL_H, UP } from './houseWorld'
import type { Level, LevelLightRig, LevelSpawn } from './types'

/*
  Nuketown: the Black Ops map, a 1950s cul-de-sac built on a nuclear test site
  in the Nevada desert, made from nothing but stamped boxes. It is laid out
  off the real map's top-down render (the numbers below are its pixels at
  0.55 units each, which makes its school bus ten and a half metres long at
  the walker's scale):

  - **A cul-de-sac, not a through street.** The middle is a turning circle
    with a ring of paving slabs round it. The street arrives from the east as
    a short stub between lawn strips and sidewalks, where a jeep is parked
    across it; a concrete lane leaves the circle west-south-west for the
    neighbour's house.
  - **Two houses face each other across the circle, north and south**, so
    the map's long axis, spawn to spawn, runs *through* them. The yellow one
    (No. 11, WOODS) stands north with its garage to the west, the green one
    (No. 13, MASON) south with its garage to the east: the same house turned
    half round about a point a little west of the circle, which is why the
    yellow porch nearly touches the ring and the green one has a lawn in
    front. Each is a front-gabled two-storey block with a one-storey
    two-bay garage beside it, a porch, a living room at the front, a
    checkered kitchen behind it, a stair up to two bedrooms, and a back
    bedroom opening onto a wooden balcony with an outside stair down into
    the back yard, where that side spawns.
  - **The two vehicles in the circle are both parked facing out**, a few
    degrees off the axis: a flat-fronted transit school bus in the south-east
    half with its nose in the stub, and a long moving van in the north half
    with its tail at the circle's west edge and its ramp down among the
    crates it is unloading. Angled things register a
    staircase of boxes along their length (`framed().solid`), which at those
    angles is within a hand of the paint.
  - **The dressing that makes it Nuketown**: the "Welcome to NUKETOWN,
    population 01" board between stone pillars at the circle's south-west
    edge, the clock tower in the desert behind it, mannequins in their Sunday
    best everywhere, mailboxes with the families' names, a white picket fence
    along the stub, power poles, the neighbours' houses past the fence and
    military vehicles down the street, rugged ranges and a mesa or two on the
    horizon. Lettering is a pixel font stamped as boxes.

  It is a map (levels/maps.ts): nobody downloads this module until they pick
  it, and CrtScene builds and warms it under the level cut's card. How it is
  made follows from that:

  - **It draws with the open world's own materials.** Every surface here is
    stamped into the chunk soup's vertex format (core/geometry.ts's builder:
    colour, `aSurf`, `aSway`, and an `aBirth` of PREBORN so it never fades)
    and drawn with a fresh `makeChunkMats().detail`, whose program key is the
    streamed chunks' own. So the siding is world/surface.ts's planks, the
    roofs its shingles, the circle its asphalt, and arriving here links no
    program at all: the first visit costs a buffer upload, paid in one
    unculled draw under the card.
  - **Four draws.** What stands up (the houses, the vehicles, the fences, the
    people, the neighbours) casts and receives; the flat ground (lawn,
    drives, the circle) only receives, because a plane in the sun's map is
    nothing but acne; the desert grid and the horizon (ranges, the tower,
    poles) neither cast nor are near enough to be in the map. The ground's
    layers stand a few hundredths apart (lawn, drives, asphalt, then kerbed
    slabs) so none of them fights another for depth.
  - **The scale is the house's.** A storey is houseWorld's CEIL_H with its
    slab on top (UP), a door is 4.7 by 2.2, a stair is sixteen risers of 0.4
    over fifteen treads that overlap to the top of the flight, and walls
    collide as the house's do: a noStand box 0.4 either side of the plane,
    split only by openings that reach the floor, with a 0.2 shoulder at each
    jamb. Windows are real holes with a cross in them, so you can see out,
    and the upper front ones are low enough to fight from.
  - **The edge** is the block's board fence and the stub's pickets, with a
    continuous noStand wall behind them for the walk and the props; the
    level's bounds are the rectangle round all of it.
  - **It is far off in the scene** (NUKE_ORIGIN), past the far plane from
    home, like the Moon, and the outside world's sky follows the lens here
    with the Earth's ground put away (`setVenue('away')`). The level pins the
    clock to a desert morning and warms, hazes and bounces the light off the
    sand in `overrideLight`, and damps the sky light inside the houses the
    way the sky does in the real one.

  Built in the map's own coordinates about the middle of the circle (+x
  east down the street, +z south to the green house) and moved to
  NUKE_ORIGIN at the end, geometry and boxes alike. Headless-safe: nothing
  here touches a renderer.
*/

/** where the map stands in the scene: far enough from the house, the fleet
    and the Moon that none of them is inside its far plane */
export const NUKE_ORIGIN = { x: -24000, z: 0 } as const

/** the playable ground: the yellow house's block, the band across the
    middle that holds the circle and the stub, and the green house's block */
const YARD_N = { x0: -46, x1: 22, z0: -100, z1: -16 }
const MID = { x0: -52, x1: 44, z0: -16, z1: 20 }
const YARD_S = { x0: -36, x1: 32, z0: 20, z1: 100 }
/** the circle: asphalt out to R_ROAD, then a ring of paving slabs */
const R_ROAD = 18
const R_RING = 22.5
/** the stub of the street: asphalt between these, then a lawn strip and a
    sidewalk either side */
const STUB_N = -8
const STUB_S = 9
/** the house fronts' distance either side of the circle */
const FRONT = 28
/** the houses are one house turned half round about (SYM_X, 0); each main
    block's centre is HOUSE_X either side of it */
const SYM_X = -7
const HOUSE_X = 11
/** a wall layer's thickness either side of its plane */
const T = 0.15
/** the ground's layers, bottom to top */
const Y_LAWN = 0.06
const Y_DRIVE = 0.1
const Y_ROAD = 0.14
const Y_WALK = 0.18

const PAL = {
  sand: '#c9a77a',
  lawn: '#6f9a45',
  lawnFar: '#6a8d45',
  asphalt: '#4f4e4c',
  concrete: '#b8b3a8',
  slab: '#c3beb2',
  trim: '#f1eee6',
  wood: '#8d5f3b',
  deck: '#9a6a44',
  stair: '#6f5139',
  ceiling: '#e6dfcf',
  garage: '#c9c3b3',
  picket: '#efece3',
  board: '#b08a61',
  boardPost: '#8b6b4a',
  stone: '#8f8677',
  hedge: '#4f6f36',
  rock: ['#a96f4b', '#bb835a', '#9a6446', '#c1906a', '#8e5d45'],
  range: ['#8a664c', '#7c5b44', '#936d52', '#72523e'],
  mesa: ['#a4694b', '#b97f57', '#8f5b43'],
  steel: '#4c5055',
  tire: '#232120',
  glass: '#2e3a44',
  chrome: '#c4c1b8',
  brick: '#8c4e3d',
  signRed: '#8e2f25',
  signInk: '#dfe5e3',
}

interface HouseLook {
  /** the clapboard both houses are mostly sided in */
  siding: string
  /** the colour that names the house: its lower storey and a band upstairs */
  accent: string
  roof: string
  door: string
  shutter: string
  garageDoor: string
  sofa: string
  rug: string
  bedspread: string
  living: string
  kitchen: string
  bedroom: string
  back: string
  carpet: string
  car: string
  name: string
}

const YELLOW: HouseLook = {
  siding: '#ece7da', accent: '#e4bd55', roof: '#7a7f84', door: '#9e4034', shutter: '#f3f0e8', garageDoor: '#ecebe4',
  sofa: '#5f9b94', rug: '#d8b54c', bedspread: '#b86a78',
  living: '#d9c79a', kitchen: '#e2dcc2', bedroom: '#b6c3c4', back: '#d3b4ab', carpet: '#b89a5a',
  car: '#d6c48f', name: 'WOODS',
}
const GREEN: HouseLook = {
  siding: '#e4e7e3', accent: '#45c29b', roof: '#7c8186', door: '#5b3a2e', shutter: '#f3f0e8', garageDoor: '#e9ebe6',
  sofa: '#b0574a', rug: '#6f8ea0', bedspread: '#6d8fb3',
  living: '#aec4c0', kitchen: '#dfe0d2', bedroom: '#c5a4a9', back: '#b5c2a3', carpet: '#6f8894',
  car: '#9fbaa4', name: 'MASON',
}

const DRESSES = ['#b25f7d', '#6d8fb3', '#d0a64f', '#7fa98e', '#b0574a', '#9b7fb0', '#d98f7a']
const SUITS = ['#4b5263', '#6c5a47', '#5a6552', '#3f4a5c', '#7a6f63']
const SKIN = '#d8cab4'

/** a 3-to-5-wide pixel font, rows top down, for the handful of words the map
    has painted on it */
const GLYPHS: Record<string, string[]> = {
  A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'],
  B: ['XX.', 'X.X', 'XX.', 'X.X', 'XX.'],
  C: ['XXX', 'X..', 'X..', 'X..', 'XXX'],
  D: ['XX.', 'X.X', 'X.X', 'X.X', 'XX.'],
  E: ['XXX', 'X..', 'XX.', 'X..', 'XXX'],
  G: ['XXX', 'X..', 'X.X', 'X.X', 'XXX'],
  H: ['X.X', 'X.X', 'XXX', 'X.X', 'X.X'],
  I: ['XXX', '.X.', '.X.', '.X.', 'XXX'],
  K: ['X.X', 'X.X', 'XX.', 'X.X', 'X.X'],
  L: ['X..', 'X..', 'X..', 'X..', 'XXX'],
  M: ['X...X', 'XX.XX', 'X.X.X', 'X...X', 'X...X'],
  N: ['X..X', 'XX.X', 'X.XX', 'X..X', 'X..X'],
  O: ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  P: ['XXX', 'X.X', 'XXX', 'X..', 'X..'],
  R: ['XX.', 'X.X', 'XX.', 'X.X', 'X.X'],
  S: ['XXX', 'X..', 'XXX', '..X', 'XXX'],
  T: ['XXX', '.X.', '.X.', '.X.', '.X.'],
  U: ['X.X', 'X.X', 'X.X', 'X.X', 'XXX'],
  V: ['X.X', 'X.X', 'X.X', 'X.X', '.X.'],
  W: ['X...X', 'X...X', 'X.X.X', 'X.X.X', '.X.X.'],
  Y: ['X.X', 'X.X', '.X.', '.X.', '.X.'],
  '0': ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  '1': ['.X.', 'XX.', '.X.', '.X.', 'XXX'],
  ' ': ['..', '..', '..', '..', '..'],
}

/** a word's width in font pixels, one blank column between letters */
const textCols = (text: string) =>
  [...text].reduce((w, ch, i) => w + (GLYPHS[ch]?.[0].length ?? 3) + (i ? 1 : 0), 0)

/**
 * Lay `text` out on a plane: `emit(a0, a1, y0, y1)` is called once per run of
 * lit pixels in a row (a along the line, y up), `px` wide each, starting at
 * `a0` with the top of the capitals at `yTop`. Runs, not pixels, so a word is
 * a few dozen boxes rather than a hundred.
 */
const pixelText = (
  text: string, px: number, a0: number, yTop: number,
  emit: (a0: number, a1: number, y0: number, y1: number) => void,
) => {
  let col = 0
  for (const ch of text) {
    const g = GLYPHS[ch] ?? GLYPHS[' ']
    g.forEach((row, r) => {
      let c = 0
      while (c < row.length) {
        if (row[c] !== 'X') {
          c++
          continue
        }
        let e = c
        while (e < row.length && row[e] === 'X') e++
        emit(a0 + (col + c) * px, a0 + (col + e) * px, yTop - (r + 1) * px, yTop - r * px)
        c = e
      }
    })
    col += g[0].length + 1
  }
}

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

/** a patch of a wall's outside painted in the house's colour, in the wall's
    own frame (a along it, y up from its base) */
interface Band {
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

const inRect = (r: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number) =>
  x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1

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

  /** a flat convex polygon on the ground at height `y`, wound to face up */
  const ground = (out: MeshBuilder, pts: Array<[number, number]>, y: number, hex: string, surf: SurfaceId) => {
    const col = new THREE.Color(hex)
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
    const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length
    const c = new THREE.Vector3(cx, y, cz)
    out.surface = surf
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const up = (a[1] - cz) * (b[0] - cx) - (a[0] - cx) * (b[1] - cz)
      const va = new THREE.Vector3(a[0], y, a[1])
      const vb = new THREE.Vector3(b[0], y, b[1])
      if (up > 0) out.tri(c, va, vb, col)
      else out.tri(c, vb, va, col)
    }
    out.surface = SURF.none
  }

  /**
   * A frame turned `yaw` about a point on the ground, for the things that
   * are not square to the street: the vehicles, the sign, a car on the lane.
   * Local +x maps to (cos yaw, -sin yaw), which for anything modelled nose to
   * +x is its heading. `solid` cuts a local rectangle into slices along its
   * long side and registers each slice's axis-aligned bounds, a staircase
   * that hugs the paint to within a slice's width times the sine of the
   * angle (the root CLAUDE.md's rule is that only a square box may register
   * one AABB; this is several square ones).
   */
  const framed = (cx: number, cz: number, yaw: number) => {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const wx = (lx: number, lz: number) => cx + c * lx + s * lz
    const wz = (lx: number, lz: number) => cz - s * lx + c * lz
    return {
      wx,
      wz,
      box: (
        out: MeshBuilder, hex: string,
        x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
        surf: SurfaceId = SURF.none,
      ) => put(out, BOX, hex, wx((x0 + x1) / 2, (z0 + z1) / 2), (y0 + y1) / 2, wz((x0 + x1) / 2, (z0 + z1) / 2),
        0, yaw, 0, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), surf),
      put: (
        out: MeshBuilder, geo: THREE.BufferGeometry, hex: string,
        lx: number, y: number, lz: number, rx: number, ry: number, rz: number,
        sx: number, sy: number, sz: number, surf: SurfaceId = SURF.none,
      ) => put(out, geo, hex, wx(lx, lz), y, wz(lx, lz), rx, yaw + ry, rz, sx, sy, sz, surf),
      strut: (
        out: MeshBuilder, hex: string,
        x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
        t: number, across = t,
      ) => strut(out, hex, wx(x0, z0), y0, wz(x0, z0), wx(x1, z1), y1, wz(x1, z1), t, SURF.none, across),
      solid: (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, stand = false, step = 2.4) => {
        const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0)
        const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0)
        const n = Math.max(1, Math.ceil(len / step))
        for (let i = 0; i < n; i++) {
          const t0 = i / n
          const t1 = (i + 1) / n
          const corners = alongX
            ? [[x0 + (x1 - x0) * t0, z0], [x0 + (x1 - x0) * t1, z0], [x0 + (x1 - x0) * t0, z1], [x0 + (x1 - x0) * t1, z1]]
            : [[x0, z0 + (z1 - z0) * t0], [x1, z0 + (z1 - z0) * t0], [x0, z0 + (z1 - z0) * t1], [x1, z0 + (z1 - z0) * t1]]
          const xs = corners.map(([lx, lz]) => wx(lx, lz))
          const zs = corners.map(([lx, lz]) => wz(lx, lz))
          solid(Math.min(...xs), y0, Math.min(...zs), Math.max(...xs), y1, Math.max(...zs), stand)
        }
      },
    }
  }

  /** a wheel, its axle along the frame's local z */
  const wheel = (f: ReturnType<typeof framed>, x: number, y: number, z: number, d: number, w: number) => {
    f.put(props, CYL12, PAL.tire, x, y, z, Math.PI / 2, 0, 0, d, w, d)
    f.put(props, CYL12, '#9c988e', x, y, z + Math.sign(z) * (w / 2 + 0.02), Math.PI / 2, 0, 0, d * 0.42, 0.05, d * 0.42)
  }

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
      a vaultable box (a hop clears 1.7 in time, see src/game/CLAUDE.md)
      unless the perimeter wall behind it already stands there */
  const picket = (x0: number, z0: number, x1: number, z1: number, collide = true) => {
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
    for (let a = a0 + 0.12; a < a1 - 0.08; a += 0.46) {
      run(a - 0.11, a + 0.11, 0.05, 1.85, -0.08, -0.02)
      // the pointed top, a smaller block on each picket
      run(a - 0.06, a + 0.06, 1.85, 2.0, -0.08, -0.02)
    }
    for (let a = a0; a <= a1 + 0.01; a += Math.max(1, (a1 - a0) / Math.ceil((a1 - a0) / 3))) {
      run(a - 0.12, a + 0.12, 0, 2.0, -0.02, 0.2)
    }
    if (!collide) return
    if (alongX) solid(a0, 0, n - 0.22, a1, 1.7, n + 0.22)
    else solid(n - 0.22, 0, a0, n + 0.22, 1.7, a1)
  }

  /** a board fence: weathered planks between posts, drawn only; the block's
      edge is walled behind it (see the perimeter) */
  const boardFence = (x0: number, z0: number, x1: number, z1: number, out: MeshBuilder = props, h = 3.4) => {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0)
    const a0 = alongX ? Math.min(x0, x1) : Math.min(z0, z1)
    const a1 = alongX ? Math.max(x0, x1) : Math.max(z0, z1)
    const n = alongX ? z0 : x0
    const run = (hex: string, p0: number, p1: number, y0: number, y1: number, n0: number, n1: number, surf: SurfaceId) =>
      alongX
        ? slab(out, hex, p0, y0, n + n0, p1, y1, n + n1, surf)
        : slab(out, hex, n + n0, y0, p0, n + n1, y1, p1, surf)
    run(PAL.board, a0, a1, 0.1, h, -0.07, 0.07, SURF.plank)
    run(PAL.boardPost, a0, a1, h - 0.4, h - 0.2, -0.12, 0.12, SURF.none)
    for (let a = a0; a <= a1 + 0.01; a += Math.max(1, (a1 - a0) / Math.ceil((a1 - a0) / 4))) {
      run(PAL.boardPost, a - 0.16, a + 0.16, 0, h + 0.15, -0.16, 0.16, SURF.bark)
    }
  }

  /* ----------------------------------------------------------- a house -- */

  /**
   * One house, garage, porch, balcony and yard, in its own frame: `u` along
   * the frontage and `v` back from the front wall, away from the circle.
   * `dir` turns the whole frame half round for the other side, which keeps
   * every box axis-aligned; the garage is on the +u side.
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
    /** facing the circle, as a yaw for something modelled facing +z */
    const streetYaw = dir > 0 ? Math.PI : 0
    const dummy = (u: number, y: number, v: number, turn: number, k: number) =>
      mannequin(X(u), y, Z(v), streetYaw + turn * dir, seed * 31 + k)
    /** the house frame as a turned frame, for the car and the lettering */
    const local = (u: number, v: number, yaw: number) => framed(X(u), Z(v), yaw)

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
     * column by column between every edge a hole or a band has, in two
     * layers: siding outside (`out` is which side of the plane that is,
     * painted `accent` inside the bands) and paint in; a partition (`out` 0)
     * is paint both sides. Collision runs are split only by holes that reach
     * the floor.
     */
    const wall = (
      axis: 'u' | 'v', at: number, a0: number, a1: number, base: number, hgt: number,
      out: 1 | -1 | 0, ext: string, int: string, cuts: Opening[] = [],
      o: { shutter?: string; leaf?: string; bands?: Band[] } = {},
    ) => {
      const bands = o.bands ?? []
      const layer = (pa0: number, pa1: number, py0: number, py1: number, m0: number, m1: number, hex: string, surf: SurfaceId) => {
        const n0 = Math.min(m0, m1)
        const n1 = Math.max(m0, m1)
        if (axis === 'u') hb(pa0, pa1, base + py0, base + py1, n0, n1, hex, surf)
        else hb(n0, n1, base + py0, base + py1, pa0, pa1, hex, surf)
      }
      const outside = (pa0: number, pa1: number, py0: number, py1: number) => {
        const ys = [...new Set([py0, py1, ...bands.flatMap((b) => [b.y0, b.y1])])]
          .filter((y) => y >= py0 && y <= py1)
          .sort((p, q) => p - q)
        const am = (pa0 + pa1) / 2
        for (let i = 0; i + 1 < ys.length; i++) {
          const y0 = ys[i]
          const y1 = ys[i + 1]
          if (y1 - y0 < 0.01) continue
          const ym = (y0 + y1) / 2
          const hit = bands.some((b) => am > b.a0 && am < b.a1 && ym > b.y0 && ym < b.y1)
          layer(pa0, pa1, y0, y1, at, at + out * T, hit ? look.accent : ext, SURF.plank)
        }
      }
      const piece = (pa0: number, pa1: number, py0: number, py1: number) => {
        if (pa1 - pa0 < 0.01 || py1 - py0 < 0.01) return
        if (out === 0) layer(pa0, pa1, py0, py1, at - T, at + T, int, SURF.plaster)
        else {
          outside(pa0, pa1, py0, py1)
          layer(pa0, pa1, py0, py1, at, at - out * T, int, SURF.plaster)
        }
      }
      const edges = [...new Set([a0, a1, ...cuts.flatMap((c) => [c.a0, c.a1]), ...bands.flatMap((b) => [b.a0, b.a1])])]
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

    const door = (a0: number, a1: number): Opening => ({ a0, a1, y0: 0, y1: DOOR })
    const win = (a0: number, a1: number, y0: number, y1: number): Opening => ({ a0, a1, y0, y1 })

    /** half the main block's width, its depth, the garage's far side and
        depth, a door's height */
    const W = 12
    const D = 34
    const G1 = 30
    const GD = 22
    const DOOR = 4.7
    const EAVE = UP + CEIL_H
    /** the house's colour on the ground storey, all the way round but for
        the front door's half of the front, and in a band upstairs */
    const lower: Band[] = [{ a0: -99, a1: 99, y0: 1.4, y1: UP }]

    /* ---- the ground storey: living room at the front, kitchen behind */
    wall('u', 0, -W - T, W + T, 0, UP, -1, look.siding, look.living, [
      door(-7, -4.8),
      win(-11, -8.6, 1.8, 4.6),
      win(2, 8.5, 1.8, 4.6),
    ], { shutter: look.shutter, leaf: look.door, bands: [{ a0: -0.6, a1: W + T, y0: 1.4, y1: UP }] })
    wall('u', D, -W - T, W + T, 0, UP, 1, look.siding, look.kitchen, [
      door(3, 5.2),
      win(-9, -5, 3.1, 4.6),
      win(7, 9.8, 2.4, 4.4),
    ], { leaf: look.door, bands: lower })
    wall('v', -W, 0, 14, 0, UP, -1, look.siding, look.living, [], { bands: lower })
    wall('v', -W, 14, D, 0, UP, -1, look.siding, look.kitchen,
      [door(15.8, 18), win(24, 29, 2.4, 4.4)], { leaf: look.door, bands: lower })
    // the garage's side of the house: the door through, and a kitchen
    // window past the garage's back wall
    wall('v', W, 0, 14, 0, UP, 1, look.siding, look.living, [door(9, 11.2)], { leaf: '#8a6a4a', bands: lower })
    wall('v', W, 14, D, 0, UP, 1, look.siding, look.kitchen, [win(25, 29, 2.4, 4.4)], { bands: lower })
    wall('u', 14, -W + T, W - T, 0, CEIL_H, 0, look.living, look.living, [door(1, 3.2)])

    /* ---- the upper storey: the front bedroom with the stairwell and the
       two big windows everyone fights from, the back room onto the balcony */
    const upBand: Band[] = [{ a0: 3.2, a1: W + T, y0: 0.8, y1: 4.8 }]
    wall('u', 0, -W - T, W + T, UP, CEIL_H, -1, look.siding, look.bedroom, [
      win(-2.9, 1.9, 1.1, 4.4),
      win(-11, -7.4, 1.1, 4.4),
    ], { shutter: look.shutter, bands: upBand })
    wall('u', D, -W - T, W + T, UP, CEIL_H, 1, look.siding, look.back, [
      door(-8, -5.8),
      win(3, 7.5, 1.4, 4.4),
    ], { leaf: look.door, bands: [{ a0: 0, a1: W + T, y0: 0.8, y1: 4.8 }] })
    wall('v', -W, 0, 15, UP, CEIL_H, -1, look.siding, look.bedroom, [win(4, 8, 1.4, 4.4)], { bands: [{ a0: 9, a1: 15, y0: 0.8, y1: 4.8 }] })
    wall('v', -W, 15, D, UP, CEIL_H, -1, look.siding, look.back, [win(22, 27, 1.4, 4.4)])
    wall('v', W, 0, 15, UP, CEIL_H, 1, look.siding, look.bedroom, [win(4, 8, 2.4, 4.4)])
    wall('v', W, 15, D, UP, CEIL_H, 1, look.siding, look.back, [win(23, 28, 1.8, 4.4)])
    wall('u', 15, -W + T, W - T, UP, CEIL_H, 0, look.bedroom, look.bedroom, [door(-5, -2.8)])

    /* ---- floors, the slab between the storeys, the ceiling and the roof */
    hb(-W + T, W - T, 0, 0.12, T, D - T, PAL.wood, SURF.plank)
    hs(-W + T, W - T, 0, 0.12, T, D - T, true)
    hf(-W, W, 0, 14, 'wood')
    hf(-W, W, 14, D, 'stone')
    // the living room's rug and the kitchen's black-and-white check
    hb(-4.6, 4.6, 0.12, 0.15, 3.4, 11.2, look.rug, SURF.none)
    for (let u = -W + T, i = 0; u < W - T - 0.01; u += 1.95, i++) {
      for (let v = 14 + T, j = 0; v < D - T - 0.01; v += 1.95, j++) {
        hb(u, Math.min(u + 1.95, W - T), 0.12, 0.14, v, Math.min(v + 1.95, D - T), (i + j) % 2 ? '#26272a' : '#ecebe6', SURF.none)
      }
    }
    const S0 = 2
    const S1 = 10.4
    const SU0 = -W + T
    const SU1 = -8.6
    // the slab, less the stairwell over the flight
    for (const [u0, u1, v0, v1] of [
      [-W + T, W - T, T, S0],
      [SU1, W - T, S0, S1],
      [-W + T, W - T, S1, D - T],
    ]) {
      hb(u0, u1, CEIL_H, CEIL_H + 0.28, v0, v1, PAL.ceiling)
      hb(u0, u1, CEIL_H + 0.28, UP, v0, v1, look.carpet, SURF.none)
      hs(u0, u1, CEIL_H, UP, v0, v1, true)
    }
    hf(-W, W, 0, D, 'carpet', UP - 0.5, UP + 3)
    // the ceiling upstairs, which outside is the soffit under the eaves
    hb(-W - 1.1, W + 1.1, EAVE - 0.14, EAVE + 0.06, -1.1, D + 1.1, PAL.trim)
    /*
      A front gable: the ridge runs back from the street, so the triangle of
      siding faces the circle. The slopes are two thin slabs rather than a
      PRISM, whose own closed ends would hang a grey triangle over the
      overhang; the gable itself is a PRISM in siding tucked under them at
      the wall line, and white bargeboards finish the edges.
    */
    const HSPAN = W + 1.1
    const RISE = 4.2
    const PITCH = Math.atan2(RISE, HSPAN)
    const SLOPE = Math.hypot(HSPAN, RISE)
    for (const s of [-1, 1]) {
      const cx = X(s * HSPAN / 2)
      const rz = -Math.sign(cx - hx) * PITCH
      const y = EAVE + 0.06 + RISE / 2 + 0.12
      put(props, BOX, look.roof, cx, y, Z(D / 2), 0, 0, rz, SLOPE + 0.1, 0.26, D + 2.2, SURF.shingle)
      for (const v of [-1.1, D + 1.1]) {
        put(props, BOX, PAL.trim, cx, y - 0.05, Z(v), 0, 0, rz, SLOPE + 0.1, 0.5, 0.18, SURF.none)
      }
    }
    put(props, PRISM, look.siding, hx, EAVE + 0.06, Z(D / 2), 0, Math.PI / 2, 0,
      D, RISE * (W + T) / HSPAN, 2 * (W + T), SURF.plank)
    roofSolids(boxes, PRISM, hx, EAVE + 0.06, Z(D / 2), Math.PI / 2, D + 2.2, RISE + 0.25, 2 * HSPAN)
    // the gable's vent, front and back
    for (const v of [-0.06, D + 0.06]) hb(-1, 1, EAVE + 1.1, EAVE + 1.9, v - 0.08, v + 0.08, PAL.trim, SURF.plank)
    // the chimney up through the back of the roof
    hb(-8, -6, EAVE - 0.5, EAVE + RISE + 1.6, 24, 26, PAL.stone, SURF.brick)
    hb(-8.15, -5.85, EAVE + RISE + 1.6, EAVE + RISE + 1.85, 23.85, 26.15, PAL.concrete)
    hs(-8, -6, EAVE, EAVE + RISE + 1.85, 24, 26)

    /* ---- the stairs: up the far wall from beside the front door, arriving
       on the landing at the head of the front bedroom */
    const STEPS = 15
    const STEP = UP / (STEPS + 1)
    const TREAD = (S1 - S0) / STEPS
    for (let k = 1; k <= STEPS; k++) {
      const top = k * STEP
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
    strut(props, PAL.wood, X(SU1), 2.45 + STEP, Z(S0), X(SU1), UP + 2.45, Z(S1), 0.16, SURF.none)
    // the railing round the well upstairs, and its twin in the collision
    hb(SU1 - 0.08, SU1 + 0.08, UP + 2.35, UP + 2.55, S0, S1, PAL.wood, SURF.none)
    hb(SU0, SU1, UP + 2.35, UP + 2.55, S0 - 0.08, S0 + 0.08, PAL.wood, SURF.none)
    for (let v = S0 + 0.4; v < S1; v += 0.5) hb(SU1 - 0.05, SU1 + 0.05, UP, UP + 2.4, v - 0.05, v + 0.05, PAL.trim, SURF.none)
    for (let u = SU0 + 0.4; u < SU1; u += 0.5) hb(u - 0.05, u + 0.05, UP, UP + 2.4, S0 - 0.05, S0 + 0.05, PAL.trim, SURF.none)
    hs(SU1 - 0.2, SU1 + 0.1, UP, UP + 2.6, S0, S1)
    hs(SU0, SU1 + 0.1, UP, UP + 2.6, S0 - 0.15, S0 + 0.15)

    /* ---- the rooms, furnished like it is 1957 and nobody is home */
    // living: a sofa with its back to the kitchen, a coffee table, the
    // television against the garage wall, an armchair and a standard lamp
    // (short of the kitchen door, which opens behind its right arm)
    furn(-5.6, 0.2, 0.12, 1.5, 11.6, 13.4, look.sofa)
    hb(-5.6, 0.2, 1.5, 3.0, 12.8, 13.4, look.sofa, SURF.none)
    hs(-5.6, 0.2, 1.5, 3.0, 12.8, 13.4)
    furn(-4.2, -1, 0.12, 1.3, 7.6, 9.2, PAL.wood, true, SURF.plank)
    furn(9.6, W - T, 0.12, 3.0, 3.4, 7.4, '#6d4b33')
    hb(9.54, 9.6, 1.2, 2.7, 3.9, 6.9, '#39433f', SURF.none)
    furn(5.2, 7.6, 0.12, 1.6, 9.8, 12.4, look.sofa)
    hb(5.2, 7.6, 1.6, 3.1, 11.8, 12.4, look.sofa, SURF.none)
    hs(5.2, 7.6, 1.6, 3.1, 11.8, 12.4)
    hb(-6.6, -6.4, 0.12, 4.6, 12.4, 12.6, '#3a3530', SURF.none)
    put(props, taper(0.6, 8), '#efe3c2', X(-6.5), 4.9, Z(12.5), 0, 0, 0, 1.1, 0.8, 1.1, SURF.none)
    hs(-6.9, -6.1, 0.12, 5.3, 12.1, 12.9)
    // kitchen: counters and a stove along the back, the icebox, a table
    furn(-W + T, -2.2, 0.12, 2.9, D - 2, D - T, '#e8e1d0')
    hb(-W + T, -2.1, 2.9, 3.06, D - 2.1, D - T, '#b44d40', SURF.none)
    hb(-W + T, -4.2, 5.0, 6.0, D - 1.3, D - T, '#e8e1d0', SURF.none)
    furn(-2.2, 0.2, 0.12, 2.9, D - 2, D - T, '#efe9dc')
    hb(-2.1, 0.1, 2.9, 2.96, D - 1.8, D - 0.4, '#2e2b29', SURF.none)
    furn(9.8, W - T, 0.12, 5.4, D - 2.4, D - T, '#ebe6dc', false)
    hb(9.75, 9.8, 2.6, 4.4, D - 2.2, D - 2, PAL.chrome, SURF.none)
    furn(-3.2, 1.2, 0.12, 2.5, 21, 24, '#d5cebc')
    for (const [u0, v0] of [[-4.6, 21.8], [1.6, 21.8], [-1.6, 19.6], [-1.6, 24.4]]) {
      furn(u0, u0 + 1.2, 0.12, 1.5, v0, v0 + 1.2, '#b44d40')
    }
    // upstairs: the bed under the side window, a dresser, and in the back
    // room a bunk bed and a desk
    furn(7.4, W - T, UP, UP + 1.5, 3, 8.6, '#ece5d4')
    hb(7.4, W - T - 0.1, UP + 1.5, UP + 1.62, 3, 7.6, look.bedspread, SURF.none)
    hb(W - T - 0.5, W - T, UP + 1.5, UP + 3.2, 3, 8.6, PAL.wood, SURF.none)
    hs(W - T - 0.5, W - T, UP + 1.5, UP + 3.2, 3, 8.6)
    furn(2, 6, UP, UP + 2.8, 13.4, 14.8, '#7a5234')
    furn(-W + T, -7.8, UP, UP + 1.4, 24, 30, '#ece5d4')
    hb(-W + T, -7.8, UP + 1.4, UP + 1.5, 24.2, 29.8, look.bedspread, SURF.none)
    for (const v of [24.1, 29.9]) hb(-8.1, -7.8, UP, UP + 5.4, v - 0.15, v + 0.15, PAL.wood, SURF.none)
    hb(-W + T, -7.8, UP + 3.6, UP + 4.1, 24, 30, '#ece5d4', SURF.none)
    hb(-W + T, -7.9, UP + 4.1, UP + 4.2, 24.2, 29.8, '#6d8fb3', SURF.none)
    hs(-W + T, -7.8, UP + 1.4, UP + 5.4, 24, 30)
    furn(6, 10, UP, UP + 2.5, D - 1.6, D - T, PAL.wood, true, SURF.plank)
    furn(-1, 2, UP, UP + 1.3, 17, 18.6, '#8e4b43')

    /* ---- the garage: two bays, one open with its door rolled up under the
       ceiling and one shut */
    const BAY_A = { a0: 13.4, a1: 20.6 }
    const BAY_B = { a0: 22, a1: 29.2 }
    const GH = 4.9
    wall('v', G1, -T, GD + T, 0, CEIL_H, 1, look.siding, PAL.garage, [win(8, 12, 2.4, 4.2)])
    wall('u', GD, W + T, G1 + T, 0, CEIL_H, 1, look.siding, PAL.garage, [door(23, 25.2)], { leaf: '#8a6a4a' })
    wall('u', 0, W + T, G1 + T, 0, CEIL_H, -1, look.siding, PAL.garage, [
      { ...BAY_A, y0: 0, y1: GH },
      { ...BAY_B, y0: 0, y1: GH },
    ])
    hb(BAY_A.a0, BAY_A.a1, GH + 0.05, GH + 0.2, 0.3, 7.4, look.garageDoor, SURF.plank)
    // the shut door: panels, and a row of little windows across the top
    hb(BAY_B.a0, BAY_B.a1, 0.05, GH, -0.06, 0.06, look.garageDoor, SURF.plank)
    for (let k = 0; k < 5; k++) {
      const a = BAY_B.a0 + 0.5 + k * 1.3
      hb(a, a + 0.9, GH - 1.3, GH - 0.7, -0.1, -0.05, PAL.glass, SURF.none)
    }
    hs(BAY_B.a0, BAY_B.a1, 0, GH, -0.3, 0.3)
    hb(W + T, G1 - T, 0, 0.25, T, GD - T, PAL.concrete, SURF.paving)
    hs(W + T, G1 - T, 0, 0.25, T, GD - T, true)
    hf(W, G1, 0, GD, 'stone')
    hb(W + T, G1 + 0.8, CEIL_H - 0.14, CEIL_H + 0.02, -0.8, GD + 0.8, PAL.trim)
    // its roof runs along the street, eaves front and back
    const GSPAN = GD / 2 + 0.8
    const GRISE = 2.3
    const GPITCH = Math.atan2(GRISE, GSPAN)
    const GSLOPE = Math.hypot(GSPAN, GRISE)
    const gx = X((W + G1 + 0.8) / 2)
    for (const s of [-1, 1]) {
      const cz = Z(GD / 2 + s * GSPAN / 2)
      const rx = Math.sign(cz - Z(GD / 2)) * GPITCH
      put(props, BOX, look.roof, gx, CEIL_H + 0.02 + GRISE / 2 + 0.12, cz, rx, 0, 0, G1 - W + 0.8, 0.26, GSLOPE + 0.1, SURF.shingle)
    }
    put(props, PRISM, look.siding, X((W + G1) / 2), CEIL_H + 0.02, Z(GD / 2), 0, 0, 0,
      G1 - W, GRISE * (GD / 2 + T) / GSPAN, GD + 2 * T, SURF.plank)
    roofSolids(boxes, PRISM, gx, CEIL_H + 0.02, Z(GD / 2), 0, G1 - W + 0.8, GRISE + 0.25, 2 * GSPAN)
    // a bench and the shelves, paint cans, a tyre
    furn(W + 1, W + 7, 0.25, 2.8, GD - 1.6, GD - T, PAL.wood, true, SURF.plank)
    furn(G1 - 1.2, G1 - T, 0.25, 4.6, 13, 20, '#7b7d77', false)
    for (let k = 0; k < 3; k++) {
      put(props, CYL12, ['#9e4034', '#d8c07a', '#5f7d91'][k], X(W + 1.6 + k * 0.9), 3.15, Z(GD - 0.7), 0, 0, 0, 0.7, 0.7, 0.7, SURF.none)
    }
    put(props, CYL12, PAL.tire, X(G1 - 2), 0.6, Z(8), Math.PI / 2, 0, 0, 1.9, 0.6, 1.9, SURF.none)

    /* ---- the porch, the planters, the walk and the drive */
    // the stoop, its flat canopy and the white lattice screen beside it
    hb(-8.2, -3.6, 0, 0.45, -3, -T, PAL.concrete, SURF.paving)
    hs(-8.2, -3.6, 0, 0.45, -3, -T, true)
    hf(-8.2, -3.6, -3, 0, 'stone')
    hb(-8.6, -2.6, 5.0, 5.25, -3.4, -T, PAL.trim)
    hs(-8.6, -2.6, 5.0, 5.25, -3.4, -T, true)
    hb(-3.05, -2.75, 0.45, 5.0, -3.3, -3.0, PAL.trim, SURF.none)
    hb(-3.05, -2.75, 0.45, 5.0, -0.5, -T, PAL.trim, SURF.none)
    for (let k = -3; k <= 5; k++) {
      const y0 = 0.6 + k * 0.62
      strut(props, PAL.trim, X(-2.9), Math.max(0.6, y0), Z(-3.0 + Math.max(0, 0.6 - y0)),
        X(-2.9), Math.min(4.9, y0 + 2.5), Z(-0.5 - Math.max(0, y0 + 2.5 - 4.9)), 0.07, SURF.none)
      strut(props, PAL.trim, X(-2.9), Math.max(0.6, y0), Z(-0.5 - Math.max(0, 0.6 - y0)),
        X(-2.9), Math.min(4.9, y0 + 2.5), Z(-3.0 + Math.max(0, y0 + 2.5 - 4.9)), 0.07, SURF.none)
    }
    hs(-3.1, -2.7, 0, 5.0, -3.3, -T)
    // the fieldstone planters along the front, the house's skirt
    for (const [u0, u1] of [[-W - 0.2, -8.5], [-2.6, W + 0.2]]) {
      hb(u0, u1, 0, 1.4, -1.4, -T, PAL.stone, SURF.brick)
      hs(u0, u1, 0, 1.4, -1.4, -T, true)
      for (let u = u0 + 0.9; u < u1 - 0.5; u += 1.6) {
        put(props, BALL, '#55763f', X(u), 1.6, Z(-0.8), 0, 0, 0, 1.3, 0.9, 1.0, SURF.none)
      }
    }
    // the walk from the stoop, and the drive down to the circle
    hb(-7.3, -4.5, Y_DRIVE - 0.06, Y_DRIVE, -16, -3, PAL.slab, SURF.paving, flat)
    hf(-7.3, -4.5, -16, -3, 'stone')
    hb(13, 29.4, Y_DRIVE - 0.06, Y_DRIVE, -22, -T, PAL.slab, SURF.paving, flat)
    hf(13, 29.4, -22, 0, 'stone')
    // the family's car, nose to the street, in front of the shut bay
    {
      const f = local(25.6, -7, dir > 0 ? Math.PI / 2 : -Math.PI / 2)
      sedan(f, look.car)
    }
    // the mailbox at the kerb, with the name on it
    {
      const mu = 11.4
      const mv = -7.5
      hb(mu - 0.12, mu + 0.12, 0, 3.0, mv - 0.12, mv + 0.12, '#5d5750', SURF.none)
      hb(mu - 0.45, mu + 0.45, 3.0, 3.8, mv - 0.9, mv + 0.9, '#23252a', SURF.none)
      put(props, BARREL, '#23252a', X(mu), 3.8, Z(mv), 0, Math.PI / 2, 0, 1.8, 0.3, 0.9, SURF.none)
      hb(mu + 0.45, mu + 0.52, 3.3, 4.6, mv + 0.2, mv + 0.4, '#c23b30', SURF.none)
      hs(mu - 0.5, mu + 0.5, 0, 4.1, mv - 0.9, mv + 0.9)
      // the name down the side that faces the drive, in yellow
      const f = local(mu + 0.47, mv, dir > 0 ? Math.PI / 2 : -Math.PI / 2)
      const px = 0.1
      const w = textCols(look.name) * px
      pixelText(look.name, px, -w / 2, 3.55, (a0, a1, y0, y1) =>
        f.box(props, '#e0b43c', a0, y0, -0.03, a1, y1, 0.03))
    }
    // two clipped shrubs by the drive, and down the side a stone-edged bed
    // and the firewood
    for (const u of [12.4, 30.2]) {
      put(props, BALL, '#4d6d38', X(u), 1.0, Z(-1.2), 0, 0, 0, 1.8, 2.0, 1.8, SURF.none)
      hs(u - 0.8, u + 0.8, 0, 1.8, -2, -0.4)
    }
    hb(31.5, 34.5, 0, 0.5, 8, 20, PAL.stone, SURF.brick)
    hs(31.5, 34.5, 0, 0.5, 8, 20, true)
    for (let v = 8.8; v < 19.5; v += 1.4) {
      put(props, BALL, ['#c7505a', '#e0c24f', '#e8e2da'][Math.floor(v) % 3], X(33), 0.8, Z(v), 0, 0, 0, 0.9, 0.7, 0.9, SURF.none)
    }
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 6; k++) {
        put(props, CYL8, row % 2 ? '#8a6a48' : '#7a5a3c', X(31.2 + (k % 2) * 0.6 + row * 0.02), 0.35 + row * 0.62, Z(0.8 + k * 0.9 + (row % 2) * 0.3),
          Math.PI / 2, 0, 0, 0.6, 2.4, 0.6, SURF.bark)
      }
    }
    hs(30.6, 32.6, 0, 2.6, 0.4, 6.4, true)

    /* ---- the back: a stoop off the kitchen, and the balcony off the back
       bedroom with its outside stair down into the yard */
    hb(2.6, 5.6, 0, 0.4, D + T, D + 1.6, PAL.concrete, SURF.paving)
    hs(2.6, 5.6, 0, 0.4, D + T, D + 1.6, true)
    const B0 = -12.6
    const B1 = 0.6
    const BV = D + 6
    hb(B0, B1, UP - 0.4, UP, D + T, BV, PAL.deck, SURF.plank)
    hs(B0, B1, UP - 0.4, UP, D + T, BV, true)
    hf(B0, B1, D, BV, 'wood', UP - 1, UP + 3)
    for (const u of [B0 + 0.25, -6, B1 - 0.25]) {
      hb(u - 0.2, u + 0.2, 0, UP - 0.4, BV - 0.45, BV - 0.05, PAL.stair, SURF.bark)
      hs(u - 0.2, u + 0.2, 0, UP - 0.4, BV - 0.45, BV - 0.05)
    }
    hb(B0, B1, UP - 0.9, UP - 0.4, BV - 0.45, BV - 0.05, PAL.stair, SURF.plank)
    // the railing: along the outer edge up to the stair head, and both ends
    const rail = (u0: number, u1: number, v0: number, v1: number) => {
      hb(u0, u1, UP + 2.3, UP + 2.5, v0, v1, PAL.deck, SURF.none)
      const alongU = Math.abs(u1 - u0) > Math.abs(v1 - v0)
      const a0 = alongU ? u0 : v0
      const a1 = alongU ? u1 : v1
      for (let a = a0 + 0.3; a < a1; a += 0.55) {
        if (alongU) hb(a - 0.06, a + 0.06, UP, UP + 2.3, (v0 + v1) / 2 - 0.06, (v0 + v1) / 2 + 0.06, PAL.deck, SURF.none)
        else hb((u0 + u1) / 2 - 0.06, (u0 + u1) / 2 + 0.06, UP, UP + 2.3, a - 0.06, a + 0.06, PAL.deck, SURF.none)
      }
      hs(u0, u1, UP, UP + 2.6, v0, v1)
    }
    rail(B0, -4.2, BV - 0.2, BV)
    rail(B0, B0 + 0.2, D + T, BV)
    rail(B1 - 0.2, B1, D + T, BV)
    const XU0 = -4
    const XU1 = -0.6
    for (let k = 1; k <= STEPS; k++) {
      const top = k * STEP
      const v0 = BV + (STEPS - k) * TREAD
      const v1 = v0 + TREAD
      hb(XU0, XU1, top - 0.12, top, v0, v1 + 0.04, PAL.deck, SURF.plank)
      hs(XU0, XU1, 0, top, BV, v1, true)
      for (const u of [XU0 - 0.12, XU1 + 0.12]) hs(u - 0.12, u + 0.12, top, top + 2.6, v0, v1)
    }
    for (const u of [XU0 - 0.12, XU1 + 0.12]) {
      strut(props, PAL.stair, X(u), UP - 0.2, Z(BV), X(u), 0, Z(BV + STEPS * TREAD), 0.24, SURF.none, 0.3)
      strut(props, PAL.deck, X(u), UP + 2.4, Z(BV), X(u), 2.4, Z(BV + STEPS * TREAD), 0.14, SURF.none)
      hb(u - 0.1, u + 0.1, 0, 2.5, BV + STEPS * TREAD - 0.2, BV + STEPS * TREAD, PAL.stair, SURF.none)
    }
    hf(XU0, XU1, BV, BV + STEPS * TREAD, 'wood', 0.2, UP)

    /* ---- the back yard: a shed and a vegetable patch against the back
       fence, a sandbox in the far corner, a picnic table, the washing out,
       a doghouse and the barbecue */
    {
      const [v0, v1] = [61, 69]
      hb(0, 12, 0, 5.4, v0, v1, '#9b7b5b', SURF.plank)
      hs(0, 12, 0, 5.4, v0, v1)
      hb(4.8, 7.2, 0, 4.4, v0 - 0.06, v0, '#6b5540', SURF.plank)
      put(props, PRISM, '#6f7478', X(6), 5.4, Z(65), 0, 0, 0, 13, 2.2, 9.4, SURF.shingle)
      roofSolids(boxes, PRISM, X(6), 5.4, Z(65), 0, 13, 2.2, 9.4)
      // the vegetable patch: dark earth in rows behind a little fence
      hb(-16, -4, 0, 0.25, 60, 70.5, '#5a4332', SURF.none)
      for (let u = -15; u < -4.5; u += 1.6) {
        for (let v = 61; v < 70; v += 1.3) put(props, BALL, '#4f7a3a', X(u), 0.55, Z(v), 0, 0, 0, 0.8, 0.6, 0.8, SURF.none)
      }
      const fz = (v: number) => Z(v)
      picket(X(-16.3), fz(59.6), X(-3.7), fz(59.6))
      picket(X(-16.3), fz(59.6), X(-16.3), fz(71.5))
      picket(X(-3.7), fz(59.6), X(-3.7), fz(64))
    }
    {
      // the sandbox, its boards a place to stand
      const [u0, u1, v0, v1] = [38, 46, 58, 66]
      hb(u0, u1, 0, 0.3, v0, v1, '#dcc89a', SURF.none)
      for (const [a0, a1, b0, b1] of [[u0, u1, v0, v0 + 0.4], [u0, u1, v1 - 0.4, v1], [u0, u0 + 0.4, v0, v1], [u1 - 0.4, u1, v0, v1]]) {
        hb(a0, a1, 0, 0.7, b0, b1, PAL.wood, SURF.plank)
        hs(a0, a1, 0, 0.7, b0, b1, true)
      }
      put(props, taper(0.8, 8), '#c9453a', X(41), 0.6, Z(61), 0, 0, 0, 0.8, 0.7, 0.8, SURF.none)
    }
    furn(30, 35, 0, 1.9, 44, 47.5, PAL.wood, true, SURF.plank)
    furn(30, 35, 0, 1.1, 42.8, 43.4, PAL.wood, true, SURF.plank)
    furn(30, 35, 0, 1.1, 48.1, 48.7, PAL.wood, true, SURF.plank)
    for (const u of [-17, 1]) {
      hb(u - 0.12, u + 0.12, 0, 5, 54 - 0.12, 54 + 0.12, '#7c7a74', SURF.none)
      hb(u - 0.12, u + 0.12, 4.8, 4.95, 53.2, 54.8, '#7c7a74', SURF.none)
      hs(u - 0.2, u + 0.2, 0, 5, 53.8, 54.2)
    }
    for (const dv of [-0.7, 0.7]) strut(props, '#dcd6c6', X(-17), 4.85, Z(54 + dv), X(1), 4.7, Z(54 + dv), 0.04, SURF.none)
    for (const [u, hex] of [[-14.5, '#e9e3d6'], [-11.2, '#c9798a'], [-7.6, '#e9e3d6'], [-3.8, '#86a7c2']] as const) {
      hb(u - 0.9, u + 0.9, 3.0, 4.8, 53.26, 53.32, hex, SURF.none)
    }
    {
      // the doghouse
      hb(40, 44, 0, 2.6, 36, 40, '#a4462f', SURF.plank)
      put(props, PRISM, '#5c4a3b', X(42), 2.6, Z(38), 0, 0, 0, 4.6, 1.4, 4.6, SURF.shingle)
      hb(41.3, 42.7, 0, 1.8, 35.94, 36, '#231d18', SURF.none)
      hs(40, 44, 0, 4.0, 36, 40)
    }
    // the barbecue by the back stoop
    put(props, BALL, '#2b2826', X(8.6), 2.4, Z(D + 4.6), 0, 0, 0, 1.6, 1.2, 1.6, SURF.none)
    for (const du of [-0.5, 0.5]) hb(8.6 + du - 0.06, 8.6 + du + 0.06, 0, 2.2, D + 4.54, D + 4.66, '#2b2826', SURF.none)
    hs(7.8, 9.4, 0, 3.0, D + 3.8, D + 5.4)

    /* ---- who is standing about */
    dummy(-5.9, 0.45, -1.8, 0.2, 1)
    dummy(17, 0.25, 3.5, -0.5, 2)
    dummy(6, 0.12, 5.6, 2.6, 3)
    dummy(-5, 0.12, 27, 1.2, 4)
    dummy(-9.2, UP, 2.4, 0, 5)
    dummy(-10, UP, D + 3.6, Math.PI, 6)
    dummy(22, 0.03, 55, 2.9, 7)
    dummy(36, 0.03, 12, 1.0, 8)

    roofs.push(
      (() => { const [x0, x1, z0, z1] = rect(-W, W, 0, D); return { x0, x1, z0, z1 } })(),
      (() => { const [x0, x1, z0, z1] = rect(W, G1, 0, GD); return { x0, x1, z0, z1 } })(),
    )
  }

  /* -------------------------------------------------------- the vehicles -- */

  /** a 1950s sedan in its frame (nose to +x): a long low body with fins, a
      two-tone roof, chrome at both ends */
  function sedan(f: ReturnType<typeof framed>, hex: string) {
    f.box(props, hex, -5.6, 0.8, -2.2, 5.6, 2.3, 2.2)
    f.box(props, hex, -2.6, 2.3, -1.9, 2.2, 3.1, 1.9)
    f.box(props, '#ece9df', -2.4, 3.1, -1.75, 2.0, 3.9, 1.75)
    f.box(props, PAL.glass, -2.4, 2.45, -1.95, 2.0, 3.6, 1.95)
    f.box(props, PAL.glass, 2.0, 2.45, -1.6, 2.4, 3.5, 1.6)
    for (const s of [-1, 1]) f.box(props, hex, -5.8, 2.2, s * 1.85, -4.2, 2.75, s * 2.15)
    f.box(props, PAL.chrome, 5.6, 0.9, -2.25, 5.95, 1.5, 2.25)
    f.box(props, PAL.chrome, -5.95, 0.9, -2.25, -5.6, 1.5, 2.25)
    f.box(props, '#3a3836', 5.58, 1.6, -1.3, 5.64, 2.1, 1.3)
    for (const s of [-1, 1]) {
      f.put(props, BALL, '#f1ead2', 5.55, 1.9, s * 1.7, 0, 0, 0, 0.5, 0.5, 0.25)
      f.put(props, BALL, '#b33b30', -5.6, 2.1, s * 1.9, 0, 0, 0, 0.4, 0.4, 0.25)
      wheel(f, 3.6, 0.8, s * 2.0, 1.6, 0.6)
      wheel(f, -3.6, 0.8, s * 2.0, 1.6, 0.6)
    }
    f.solid(-5.95, 5.95, -2.25, 2.25, 0, 3.9, true)
  }

  /**
   * The school bus: a flat-fronted transit bus, the kind with the door
   * beside the driver and the engine under the floor, yellow with a white
   * roof and black rub stripes, in the south-east half of the circle with its
   * nose in the street and its east end a little north of its west.
   */
  const bus = () => {
    const f = framed(15, 4, 0.21)
    const Y = '#dca92c'
    const K = '#1f1d1b'
    f.box(props, K, -11.2, 0.9, -2.75, 11.2, 1.55, 2.75)
    f.box(props, Y, -11.5, 1.5, -2.9, 11.5, 5.75, 2.9)
    f.put(props, BARREL, '#ece8dc', 0, 5.72, 0, 0, 0, 0, 23, 0.72, 5.8)
    // the stripes and the windows: boxes through the body, so both sides
    // are drawn by one stamp
    for (const y of [2.35, 3.1, 3.62]) f.box(props, K, -11.56, y - 0.09, -2.96, 11.56, y + 0.09, 2.96)
    for (let x = -10.2; x < 7.6; x += 2.2) f.box(props, PAL.glass, x, 3.85, -2.95, x + 1.75, 5.35, 2.95)
    // the door, front right, glass to the floor
    f.box(props, PAL.glass, 8.4, 1.75, 2.88, 10.6, 5.35, 2.96)
    f.box(props, K, 9.47, 1.75, 2.9, 9.53, 5.35, 2.98)
    // the split windscreen, the destination board and SCHOOL BUS over it
    for (const s of [-1, 1]) f.box(props, PAL.glass, 11.46, 3.55, s * 0.12, 11.56, 5.25, s * 2.55)
    f.box(props, K, 11.47, 3.55, -0.12, 11.57, 5.3, 0.12)
    const px = 0.1
    const w = textCols('SCHOOL BUS') * px
    pixelText('SCHOOL BUS', px, -w / 2, 5.73, (a0, a1, y0, y1) =>
      f.box(props, K, 11.52, y0, -a1, 11.6, y1, -a0))
    // the rear: the emergency door's window and the engine grille
    f.box(props, PAL.glass, -11.58, 3.5, -1.1, -11.46, 5.25, 1.1)
    f.box(props, '#8e6a1f', -11.58, 1.8, -1.6, -11.46, 2.9, 1.6)
    // lamps: red high at all four corners, headlights low
    for (const s of [-1, 1]) {
      for (const x of [11.48, -11.48]) f.put(props, BALL, '#c2372c', x, 5.45, s * 2.35, 0, 0, 0, 0.36, 0.36, 0.36)
      f.put(props, BALL, '#f1ead2', 11.5, 2.05, s * 2.1, 0, 0, 0, 0.62, 0.62, 0.3)
    }
    f.box(props, K, 11.5, 0.95, -2.8, 11.85, 1.55, 2.8)
    f.box(props, K, -11.85, 0.95, -2.8, -11.5, 1.55, 2.8)
    // the stop arm folded against the driver's side
    f.put(props, CYL8, '#b33b30', 8.9, 4.2, -3.0, Math.PI / 2, 0, 0, 0.95, 0.08, 0.95)
    for (const x of [7.4, -6.3]) {
      for (const s of [-1, 1]) wheel(f, x, 1.15, s * 2.55, 2.3, 0.9)
    }
    f.solid(-11.85, 11.85, -2.95, 2.95, 0, 6.44, true)
    floor(3, 27, -1, 9, 'stone', 1, 99)
  }

  /**
   * The moving van: a long aluminium box with a red band, its back doors
   * swung open and a plank ramp down to the ground at the circle's west
   * edge, and a red bonneted cab at the east end with a chrome grille, in
   * the north half of the circle, parallel to the bus.
   */
  const truck = () => {
    const f = framed(-4, -8, 0.14)
    const RED = '#7c2420'
    const BOXC = '#e3ded1'
    f.box(props, '#2a2826', -15, 1.2, -2.4, 14.4, 1.9, 2.4)
    f.box(props, BOXC, -15, 1.9, -3, 5.5, 9.0, 3, SURF.panel)
    f.put(props, BARREL, BOXC, -4.75, 8.98, 0, 0, 0, 0, 20.5, 0.45, 6)
    f.box(props, '#8f2d26', -15.05, 1.9, -3.05, 5.55, 3.0, 3.05)
    f.box(props, '#8f2d26', -15.05, 7.6, -3.05, 5.55, 7.95, 3.05)
    // the name down both sides, and the open side hatch facing the bus
    const px = 0.34
    const w = textCols('MOVING') * px
    for (const s of [-1, 1]) {
      pixelText('MOVING', px, -4.75 - w / 2, 6.6, (a0, a1, y0, y1) =>
        f.box(props, '#8f2d26', s > 0 ? a0 : -9.5 - a1, y0, s * 3.0, s > 0 ? a1 : -9.5 - a0, y1, s * 3.06))
    }
    f.box(props, '#231f1c', -3.2, 3.1, 2.98, 1.6, 7.4, 3.07)
    f.box(props, '#8a6444', -3.2, 1.9, 2.4, 1.6, 2.2, 3.3)
    f.box(props, BOXC, 1.6, 3.1, 3.05, 1.75, 7.4, 5.4, SURF.panel)
    // the back: dark inside, both leaves swung round flat against the sides
    f.box(props, '#231f1c', -15.08, 2.0, -2.8, -15.0, 8.8, 2.8)
    for (const s of [-1, 1]) f.box(props, BOXC, -15, 2.0, s * 3.05, -12.2, 8.8, s * 3.18, SURF.panel)
    f.strut(props, '#8a6444', -15, 1.95, 0, -21.5, 0.12, 0, 0.18, 3.4)
    // the cab and its bonnet, fenders, grille, bumper and lamps
    f.box(props, RED, 5.8, 1.9, -2.6, 10.8, 7.5, 2.6)
    f.box(props, PAL.glass, 10.76, 5.1, -2.3, 10.86, 7.1, 2.3)
    f.box(props, PAL.glass, 7.2, 5.1, -2.65, 10.4, 7.1, 2.65)
    f.box(props, RED, 10.8, 2.1, -1.9, 14.6, 5.1, 1.9)
    for (const s of [-1, 1]) f.box(props, RED, 10.6, 1.6, s * 1.9, 14.3, 3.3, s * 2.8)
    f.box(props, PAL.chrome, 14.6, 2.2, -1.5, 14.9, 5.0, 1.5)
    for (let z = -1.2; z <= 1.21; z += 0.4) f.box(props, '#3a3836', 14.9, 2.4, z - 0.07, 14.95, 4.8, z + 0.07)
    f.box(props, PAL.chrome, 14.6, 1.2, -2.8, 15.2, 1.85, 2.8)
    for (const s of [-1, 1]) {
      f.put(props, BALL, '#f1ead2', 14.3, 3.7, s * 2.35, 0, 0, 0, 0.8, 0.8, 0.4)
      wheel(f, 12.5, 1.3, s * 2.4, 2.6, 1.0)
      wheel(f, -8, 1.3, s * 2.4, 2.6, 1.2)
      wheel(f, -11, 1.3, s * 2.4, 2.6, 1.2)
    }
    f.put(props, CYL8, PAL.chrome, 5.6, 7.2, -2.75, 0, 0, 0, 0.35, 5.2, 0.35)
    f.solid(-15.2, 5.6, -3.1, 3.1, 0, 9.4, true)
    f.solid(5.6, 10.9, -2.8, 2.8, 0, 7.5, true)
    f.solid(10.9, 15.2, -2.8, 2.8, 0, 5.1, true)
    f.solid(1.5, 1.9, 3.0, 5.4, 3.1, 7.4)
    // moving day: crates by the foot of the ramp
    for (const [x, z, y, s] of [[-25, -1.2, 0, 2.2], [-25.1, -1.1, 2.2, 1.6], [-22.8, -8, 0, 1.9]] as const) {
      slab(props, '#8f6d45', x - s / 2, y, z - s / 2, x + s / 2, y + s, z + s / 2, SURF.plank)
      solid(x - s / 2, y, z - s / 2, x + s / 2, y + s, z + s / 2, true)
    }
  }

  /** an army jeep in its frame, nose to +x: open, a folding windscreen,
      a roll bar over the seats and the spare on the back */
  const jeep = (cx: number, cz: number, yaw: number) => {
    const f = framed(cx, cz, yaw)
    const OD = '#4e5a3c'
    // the tub: a floor, the sides and the tail, open on top
    f.box(props, OD, -4.2, 1.2, -1.9, 2.2, 1.7, 1.9)
    for (const s of [-1, 1]) f.box(props, OD, -4.2, 1.7, s * 1.72, 2.2, 3.0, s * 1.9)
    f.box(props, OD, -4.2, 1.7, -1.9, -4.0, 3.0, 1.9)
    f.box(props, OD, 1.9, 1.7, -1.9, 2.2, 3.0, 1.9)
    // the seats, the wheel, the bonnet and its slotted grille
    for (const s of [-1, 1]) {
      f.box(props, '#3a3a30', -0.2, 1.7, s * 0.25, 0.9, 2.4, s * 1.5)
      f.box(props, '#3a3a30', -0.3, 2.4, s * 0.25, -0.1, 3.5, s * 1.5)
    }
    f.box(props, '#3a3a30', -3.8, 1.7, -1.5, -1.8, 2.4, 1.5)
    f.put(props, CYL12, '#232320', 1.4, 3.1, -0.85, 0, 0, Math.PI / 2 - 0.5, 0.8, 0.08, 0.8)
    f.box(props, OD, 2.2, 1.4, -1.5, 4.2, 2.9, 1.5)
    for (const s of [-1, 1]) f.box(props, OD, 1.8, 1.4, s * 1.5, 4.3, 2.3, s * 2.05)
    f.box(props, '#2c3024', 4.18, 1.6, -1.1, 4.26, 2.7, 1.1)
    for (let z = -0.8; z <= 0.81; z += 0.4) f.box(props, OD, 4.2, 1.7, z - 0.08, 4.3, 2.6, z + 0.08)
    // the windscreen in its frame, and the roll bar
    f.box(props, OD, 2.1, 3.0, -1.8, 2.3, 4.4, -1.6)
    f.box(props, OD, 2.1, 3.0, 1.6, 2.3, 4.4, 1.8)
    f.box(props, OD, 2.1, 4.25, -1.8, 2.3, 4.45, 1.8)
    f.box(props, PAL.glass, 2.16, 3.1, -1.6, 2.24, 4.25, 1.6)
    for (const s of [-1, 1]) {
      f.strut(props, '#3f4832', -2.2, 3.0, s * 1.75, -1.6, 5.0, s * 1.75, 0.16)
      f.strut(props, '#3f4832', -1.6, 5.0, s * 1.75, 1.2, 4.6, s * 1.75, 0.14)
    }
    f.box(props, '#3f4832', -1.7, 4.9, -1.75, -1.5, 5.1, 1.75)
    f.put(props, CYL12, PAL.tire, -4.5, 2.4, 0, 0, 0, Math.PI / 2, 1.9, 0.55, 1.9)
    for (const x of [2.8, -2.8]) {
      for (const s of [-1, 1]) wheel(f, x, 0.95, s * 1.9, 1.9, 0.7)
    }
    f.solid(-4.8, 4.3, -2.05, 2.05, 0, 3.0, true)
    f.solid(-2.3, -1.5, -1.9, 1.9, 3.0, 5.1)
  }

  /* --------------------------------------------------- the two houses -- */

  raiseHouse(-1, SYM_X + HOUSE_X, YELLOW, 1)
  raiseHouse(1, SYM_X - HOUSE_X, GREEN, 2)
  bus()
  truck()
  jeep(36, 2, Math.PI / 2)
  {
    // a neighbour's car on the lane, nose to the circle
    const f = framed(-37, 10.5, 0.26)
    sedan(f, '#c79a58')
  }

  /* --------------------------------------------------------- the ground -- */

  // the lawn over the whole playable block, and the neighbours' lots
  for (const r of [YARD_N, MID, YARD_S]) {
    slab(flat, PAL.lawn, r.x0 - 1, Y_LAWN - 0.08, r.z0 - 1, r.x1 + 1, Y_LAWN, r.z1 + 1, SURF.none)
  }
  for (const [x0, x1, z0, z1] of [[-106, -52, -44, 44], [22, 140, -74, -16], [32, 140, 20, 76]]) {
    slab(flat, PAL.lawnFar, x0, -0.05, z0, x1, 0.03, z1, SURF.none)
  }
  // the circle: asphalt, and the ring of slabs round it, left open where the
  // street comes in
  {
    const N = 64
    const disk: Array<[number, number]> = []
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2
      disk.push([Math.cos(a) * R_ROAD, Math.sin(a) * R_ROAD])
    }
    ground(flat, disk, Y_ROAD, PAL.asphalt, SURF.asphalt)
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2
      const a1 = ((i + 1) / N) * Math.PI * 2
      const am = (a0 + a1) / 2
      const zm = Math.sin(am) * R_RING
      if (Math.cos(am) > 0 && zm > STUB_N - 1 && zm < STUB_S + 1) continue
      const p = (r: number, a: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r]
      ground(flat, [p(R_ROAD + 0.5, a0), p(R_RING, a0), p(R_RING, a1), p(R_ROAD + 0.5, a1)], Y_WALK, PAL.slab, SURF.paving)
      // the kerb, a shade darker, round the inside
      ground(flat, [p(R_ROAD, a0), p(R_ROAD + 0.5, a0), p(R_ROAD + 0.5, a1), p(R_ROAD, a1)], Y_WALK, '#a39e93', SURF.none)
    }
  }
  // the stub of the street, running on out of bounds to the horizon, its
  // lawn strips and sidewalks
  slab(flat, PAL.asphalt, 12, Y_ROAD - 0.08, STUB_N, 420, Y_ROAD, STUB_S, SURF.asphalt)
  for (const [z0, z1] of [[-14.5, -10.5], [12, 16]]) {
    slab(flat, PAL.slab, 19.5, Y_WALK - 0.1, z0, 150, Y_WALK, z1, SURF.paving)
    floor(19.5, 150, z0, z1, 'stone')
  }
  // the lane: pale concrete off the circle to the neighbour's porch
  {
    const a: [number, number] = [-15, 4.8]
    const b: [number, number] = [-60, 16.8]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const nx = -(b[1] - a[1]) / len * 5.5
    const nz = (b[0] - a[0]) / len * 5.5
    ground(flat, [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]],
      Y_DRIVE, PAL.slab, SURF.paving)
  }

  /* ----------------------------------------- the street and its dressing -- */

  /*
    The sign: "Welcome to NUKETOWN, population 01" in white on a red board
    between two stone pillars with balls on top, a trefoil and a fallout
    shelter plate under it, at the south-west edge of the circle and turned
    to face the end of the street, which is where the loading screen stands.
  */
  {
    const f = framed(-19, 15.8, 1.97)
    for (const s of [-1, 1]) {
      const x = s * 4.5
      f.box(props, '#b5aea0', x - 0.65, 0, -0.65, x + 0.65, 7.2, 0.65, SURF.brick)
      f.box(props, '#a39c8f', x - 0.85, 7.2, -0.85, x + 0.85, 7.55, 0.85)
      f.put(props, BALL, '#b5aea0', x, 8.1, 0, 0, 0, 0, 1.0, 1.0, 1.0)
      f.box(props, '#a39c8f', x - 0.85, 0, -0.85, x + 0.85, 0.5, 0.85)
      f.solid(x - 0.85, x + 0.85, -0.85, 0.85, 0, 8.6)
    }
    f.box(props, PAL.signRed, -3.85, 2.2, -0.14, 3.85, 6.9, 0.14)
    f.box(props, '#c9c2b4', -3.95, 6.9, -0.2, 3.95, 7.08, 0.2)
    f.box(props, '#c9c2b4', -3.95, 2.02, -0.2, 3.95, 2.2, 0.2)
    f.box(props, PAL.signRed, -3.85, 0.5, -0.12, 3.85, 2.02, 0.12)
    f.solid(-3.95, 3.95, -0.25, 0.25, 0, 7.1)
    const ink = (hex: string, z: number) => (a0: number, a1: number, y0: number, y1: number) =>
      f.box(props, hex, a0, y0, z, a1, y1, z + 0.06)
    const line = (text: string, px: number, yTop: number, a0?: number) =>
      pixelText(text, px, a0 ?? -textCols(text) * px / 2, yTop, ink(PAL.signInk, 0.14))
    line('WELCOME TO', 0.1, 6.65, -3.4)
    line('NUKETOWN', 0.185, 5.8)
    line('POPULATION', 0.085, 3.55, -3.3)
    // the flip counter: two black cards
    for (const [k, ch] of [[0, '0'], [1, '1']] as const) {
      const a = 0.35 + k * 1.1
      f.box(props, '#1d1c1b', a, 2.45, 0.14, a + 0.95, 3.85, 0.22)
      pixelText(ch, 0.16, a + 0.23, 3.55, ink('#eeeae0', 0.22))
    }
    // under the board: the civil defence badges, the trefoil and the
    // shelter plate's hazard stripes
    f.box(props, '#3f63a8', -3.4, 0.8, 0.12, -2.4, 1.75, 0.16)
    f.put(props, CYL12, '#d9b43a', 1.2, 1.26, 0.13, Math.PI / 2, 0, 0, 1.0, 0.06, 1.0)
    for (const a of [0, 2.09, 4.19]) {
      f.box(props, '#1d1c1b', 1.2 + Math.cos(a + 1.57) * 0.24 - 0.13, 1.26 + Math.sin(a + 1.57) * 0.24 - 0.13, 0.16,
        1.2 + Math.cos(a + 1.57) * 0.24 + 0.13, 1.26 + Math.sin(a + 1.57) * 0.24 + 0.13, 0.19)
    }
    f.box(props, '#1d1c1b', 2.1, 0.8, 0.12, 3.6, 1.75, 0.16)
    for (let k = 0; k < 4; k++) f.box(props, '#d9b43a', 2.2 + k * 0.36, 0.9, 0.16, 2.4 + k * 0.36, 1.25, 0.19)
    for (const x of [-1.4, -0.4]) f.put(props, CYL12, '#2f4f86', x, 1.28, 0.13, Math.PI / 2, 0, 0, 0.7, 0.05, 0.7)
  }
  // the street lamps on the north side, the power poles and their wires on
  // the south, a hydrant, and the street sign at the corner
  for (const [x, z] of [[34, -12.8], [-30, -13]] as const) {
    put(props, CYL8, '#d8d4c8', x, 4.5, z, 0, 0, 0, 0.4, 9, 0.4, SURF.none)
    put(props, taper(0.4, 8), '#e9e5da', x, 9.6, z, 0, 0, 0, 1.2, 1.4, 1.2, SURF.none)
    put(props, BALL, '#d8d4c8', x, 10.5, z, 0, 0, 0, 0.5, 0.5, 0.5, SURF.none)
    solid(x - 0.35, 0, z - 0.35, x + 0.35, 10.6, z + 0.35)
  }
  const poles: Array<[number, number]> = [[18, 17.4], [52, 17.4], [86, 17.4], [120, 17.4], [-44, -13.8]]
  for (const [x, z] of poles) {
    put(props, CYL8, '#6b5540', x, 8, z, 0, 0, 0, 0.55, 16, 0.55, SURF.bark)
    slab(props, '#6b5540', x - 2.2, 14.4, z - 0.15, x + 2.2, 14.7, z + 0.15, SURF.bark)
    for (const dx of [-1.8, 1.8]) put(props, CYL8, '#d9d5c9', x + dx, 14.95, z, 0, 0, 0, 0.18, 0.4, 0.18, SURF.none)
    solid(x - 0.35, 0, z - 0.35, x + 0.35, 16, z + 0.35)
  }
  for (let i = 0; i + 1 < 4; i++) {
    for (const dx of [-1.8, 1.8]) strut(props, '#2f2d2b', poles[i][0] + dx, 15.1, poles[i][1], poles[i + 1][0] + dx, 15.1, poles[i + 1][1], 0.06, SURF.none)
  }
  // a drop from the first pole to each house
  strut(props, '#2f2d2b', 18, 15.1, 17.4, SYM_X - HOUSE_X + 12, 11.5, FRONT + 0.2, 0.05, SURF.none)
  strut(props, '#2f2d2b', -44, 15.1, -13.8, SYM_X + HOUSE_X + 12, 11.5, -FRONT - 0.2, 0.05, SURF.none)
  {
    const [hx, hz] = [26, 13.4]
    put(props, CYL12, '#b33b30', hx, 1.05, hz, 0, 0, 0, 0.6, 1.5, 0.6, SURF.none)
    put(props, BALL, '#b33b30', hx, 1.8, hz, 0, 0, 0, 0.62, 0.5, 0.62, SURF.none)
    slab(props, '#b33b30', hx - 0.55, 1.0, hz - 0.12, hx + 0.55, 1.25, hz + 0.12, SURF.none)
    solid(hx - 0.35, 0, hz - 0.35, hx + 0.35, 2.05, hz + 0.35)
  }
  {
    // Latchkey Rd and Trinity Ave, one blade each way
    const [sx, sz] = [30.5, 14.6]
    put(props, CYL8, '#3b3d3a', sx, 3.6, sz, 0, 0, 0, 0.22, 7.2, 0.22, SURF.none)
    solid(sx - 0.25, 0, sz - 0.25, sx + 0.25, 7.6, sz + 0.25)
    const blade = (yaw: number, y: number, text: string) => {
      const f = framed(sx, sz, yaw)
      f.box(props, '#2f6a45', -3.2, y, -0.06, 0.2, y + 0.7, 0.06)
      pixelText(text, 0.09, -3.05, y + 0.57, (a0, a1, y0, y1) => f.box(props, '#e8ebe6', a0, y0, 0.06, a1, y1, 0.1))
    }
    blade(0, 7.0, 'LATCHKEY RD')
    blade(Math.PI / 2, 6.1, 'TRINITY AVE')
  }
  // people in the street: by the sign, round the circle, one waiting at the bus
  mannequin(-16.5, Y_WALK, 12.5, Math.PI * 0.8, 91)
  mannequin(21, Y_ROAD, 8, Math.PI * 0.35, 92)
  mannequin(8, Y_WALK, -19.6, Math.PI * 0.1, 93)
  mannequin(-9, Y_LAWN, 19.5, Math.PI * 1.1, 94)
  mannequin(-21, Y_LAWN, 1.2, -Math.PI * 0.35, 95)
  mannequin(30, Y_ROAD, -4, -Math.PI * 0.55, 96)
  mannequin(27, Y_WALK, 13.2, Math.PI * 0.9, 97)
  mannequin(-38, Y_LAWN, -6, Math.PI * 0.4, 98)
  // the road closed past the jeep, and more of the army down the street
  for (const z of [-5.5, 0.5, 6.5]) {
    for (const s of [-1, 1]) strut(props, '#dcd6c6', 46.5 + s * 0.8, 0, z - 1.2, 46.5, 2.6, z - 1.2, 0.14, SURF.none)
    for (const s of [-1, 1]) strut(props, '#dcd6c6', 46.5 + s * 0.8, 0, z + 1.2, 46.5, 2.6, z + 1.2, 0.14, SURF.none)
    for (let k = 0; k < 4; k++) {
      slab(props, k % 2 ? '#e9e3d4' : '#b8392f', 46.4, 2.4, z - 1.5 + k * 0.75, 46.6, 2.9, z - 1.5 + (k + 1) * 0.75, SURF.none)
    }
  }
  jeep(60, -2.5, 0.3)
  jeep(74, 4, -0.2)
  {
    // an army truck with its canvas back
    const f = framed(98, -1, 0.05)
    f.box(props, '#4a5539', -7, 1.2, -2.8, 3, 3.4, 2.8)
    f.box(props, '#5e6649', -7, 3.4, -2.7, 3, 7.2, 2.7)
    f.box(props, '#4a5539', 3, 1.2, -2.5, 7.8, 5.6, 2.5)
    f.box(props, PAL.glass, 6.5, 4.1, -2.2, 7.85, 5.3, 2.2)
    for (const x of [5.6, -2.5, -5.2]) {
      for (const s of [-1, 1]) wheel(f, x, 1.2, s * 2.4, 2.4, 1.0)
    }
  }

  /* ----------------------------------------------------- the neighbours -- */

  /** a one-storey neighbour past the fence: walls, a hipped roof, a door
      and windows on the face toward the street, maybe a garage door */
  const neighbour = (
    x0: number, x1: number, z0: number, z1: number,
    wallHex: string, roofHex: string, face: 'n' | 's' | 'e', garage?: string,
  ) => {
    const H = 6.8
    slab(props, wallHex, x0, 0, z0, x1, H, z1, SURF.plank)
    slab(props, PAL.trim, x0 - 1, H - 0.2, z0 - 1, x1 + 1, H, z1 + 1, SURF.none)
    put(props, HIP, roofHex, (x0 + x1) / 2, H, (z0 + z1) / 2, 0, 0, 0, x1 - x0 + 2, 5.2, z1 - z0 + 2, SURF.shingle)
    const along = face === 'e' ? [z0, z1] : [x0, x1]
    const at = face === 'n' ? z0 : face === 's' ? z1 : x1
    const out = face === 'n' ? -1 : 1
    const len = along[1] - along[0]
    const pane = (a0: number, a1: number, y0: number, y1: number, hex: string) =>
      face === 'e'
        ? slab(props, hex, at, y0, a0, at + out * 0.12, y1, a1, SURF.none)
        : slab(props, hex, a0, y0, at, a1, y1, at + out * 0.12, SURF.none)
    for (let k = 0; k < 3; k++) {
      const a = along[0] + len * (0.12 + k * 0.2)
      pane(a, a + len * 0.12, 2, 4.6, PAL.glass)
    }
    pane(along[0] + len * 0.72, along[0] + len * 0.72 + 2.3, 0, 4.7, '#6b4a36')
    if (garage) pane(along[1] - len * 0.02 - 8, along[1] - len * 0.02, 0, 4.9, garage)
  }
  neighbour(-98, -60, -30, 26, '#d9aaa6', '#6f7378', 'e')
  neighbour(30, 68, -64, -28, '#e3e1da', '#74797d', 's', '#3fbf9a')
  neighbour(40, 80, 32, 70, '#d4a2a0', '#6a5240', 'n')
  neighbour(88, 120, -64, -30, '#e7c3b1', '#72767a', 's', '#ecebe4')
  neighbour(92, 126, 32, 68, '#8fb3cf', '#6f7378', 'n')
  // the neighbour's porch where the lane ends, behind a low hedge
  slab(props, PAL.concrete, -60, 0, 8, -56.5, 0.45, 20, SURF.paving)
  for (let z = -15; z <= 19; z += 2.2) {
    if (z > 7 && z < 19) continue
    put(props, BALL, PAL.hedge, -53.5, 1.1, z, 0, 0, 0, 2.4, 2.2, 2.4, SURF.none)
  }

  /* ---------------------------------------------------- the perimeter -- */

  /*
    The block's edge: the board fence round the yards and the pickets along
    the stub, and behind all of it one continuous noStand wall, taller than
    anybody hops or builds, that the walk and the props both meet. The end
    of the street is open to look down and walled all the same, and the lane
    runs on into the neighbour's yard past its hedge.
  */
  const EDGE: Array<[number, number, number, number, 'board' | 'picket' | 'open']> = [
    [YARD_N.x0, YARD_N.z0, YARD_N.x1, YARD_N.z0, 'board'],
    [YARD_N.x1, YARD_N.z0, YARD_N.x1, MID.z0, 'board'],
    [YARD_N.x1, MID.z0, MID.x1, MID.z0, 'picket'],
    [MID.x1, MID.z0, MID.x1, MID.z1, 'open'],
    [MID.x1, MID.z1, YARD_S.x1, MID.z1, 'picket'],
    [YARD_S.x1, YARD_S.z0, YARD_S.x1, YARD_S.z1, 'board'],
    [YARD_S.x0, YARD_S.z1, YARD_S.x1, YARD_S.z1, 'board'],
    [YARD_S.x0, MID.z1, YARD_S.x0, YARD_S.z1, 'board'],
    [MID.x0, MID.z1, YARD_S.x0, MID.z1, 'board'],
    [MID.x0, MID.z0, MID.x0, MID.z1, 'open'],
    [MID.x0, MID.z0, YARD_N.x0, MID.z0, 'board'],
    [YARD_N.x0, YARD_N.z0, YARD_N.x0, MID.z0, 'board'],
  ]
  const cx = (MID.x0 + MID.x1) / 2
  for (const [x0, z0, x1, z1, kind] of EDGE) {
    if (kind === 'board') boardFence(x0, z0, x1, z1)
    if (kind === 'picket') picket(x0, z0 + (z0 < 0 ? 0.4 : -0.4), x1, z1 + (z1 < 0 ? 0.4 : -0.4), false)
    // the wall on the outside of the line
    if (z0 === z1) {
      const s = z0 < 0 ? -1 : 1
      solid(Math.min(x0, x1) - 1, -1, z0, Math.max(x0, x1) + 1, 16, z0 + s * 1.2)
    } else {
      const s = x0 < cx ? -1 : 1
      solid(x0, -1, Math.min(z0, z1) - 1, x0 + s * 1.2, 16, Math.max(z0, z1) + 1)
    }
  }
  // a hedge behind the stub's south pickets, as in front of the green house
  slab(props, PAL.hedge, 13, 0, MID.z1 - 2.1, 31.5, 1.6, MID.z1 - 0.9, SURF.none)
  for (let x = 13.8; x < 31.2; x += 1.6) put(props, BALL, PAL.hedge, x, 1.55, MID.z1 - 1.5, 0, 0, 0, 1.7, 0.6, 1.3, SURF.none)
  solid(13, 0, MID.z1 - 2.1, 31.5, 1.7, MID.z1 - 0.9)
  // and the neighbours' own fences, drawn only
  boardFence(-106, -44, -52, -44, far)
  boardFence(-106, 44, -36, 44, far)
  boardFence(-106, -44, -106, 44, far)
  boardFence(22, -74, 140, -74, far)
  boardFence(32, 76, 140, 76, far)

  /* ------------------------------------------------------ the desert -- */

  /*
    The ground: one grid 840 units across, flat under the neighbourhood and
    heaving into dunes past it, except along the street, which runs out flat
    to the east through a cut. Built by hand rather than stamped, because it
    wants shared vertices (a smooth colour field and smooth dunes), in the
    same vertex format as the soup so it draws with the same material.
  */
  const N = 120
  const SIZE = 840
  const cell = SIZE / N
  const gPos = new Float32Array((N + 1) * (N + 1) * 3)
  const gCol = new Float32Array((N + 1) * (N + 1) * 3)
  const sandC = new THREE.Color(PAL.sand)
  const rng = seeded(0x4e554b45)
  const duneAt = (x: number, z: number) => {
    const d = Math.max(Math.abs(x - 17) - 128, Math.abs(z) - 118, 0)
    if (d <= 0) return 0
    const t = Math.min(1, d / 70)
    const road = x > 0 ? smooth01((Math.abs(z - 0.5) - 16) / 26) : 1
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

  // the horizon: rugged brown ranges all round, two mesas among them
  for (const [ang, dist, spread] of [
    [0.35, 290, 0.5], [1.2, 300, 0.45], [2.0, 285, 0.5], [2.85, 305, 0.4],
    [3.6, 290, 0.5], [4.4, 300, 0.45], [5.25, 295, 0.5],
  ]) {
    const peaks = 5 + Math.floor(rng() * 3)
    for (let k = 0; k < peaks; k++) {
      const a = ang + (k / (peaks - 1) - 0.5) * spread + (rng() - 0.5) * 0.05
      const d = dist + (rng() - 0.5) * 40
      const r = 40 + rng() * 36
      const h = 30 + rng() * 44
      put(far, taper(0.16 + rng() * 0.18, 7), PAL.range[k % PAL.range.length], Math.cos(a) * d, h / 2 - 3, Math.sin(a) * d,
        0, rng() * Math.PI, 0, r * 2 * (1 + rng() * 0.6), h, r * 2, SURF.plaster)
    }
  }
  for (const [ang, dist, r, h] of [[1.62, 250, 40, 40], [4.85, 255, 34, 48]]) {
    const x = Math.cos(ang) * dist
    const z = Math.sin(ang) * dist
    const band = (y0: number, hh: number, r0: number, r1: number, hex: string) =>
      put(far, taper(r1 / r0, 9), hex, x, y0 + hh / 2, z, 0, rng() * Math.PI, 0, 2 * r0, hh, 2 * r0, SURF.plaster)
    band(-2, h * 0.34, r * 1.35, r * 1.02, PAL.mesa[0])
    band(h * 0.34 - 2, h * 0.52, r * 1.02, r * 0.95, PAL.mesa[1])
    band(h * 0.86 - 2, h * 0.14, r * 0.95, r * 0.9, PAL.mesa[2])
  }
  {
    /*
      The clock tower: four legs leaning in, braced, a railed platform and
      the big round clock on top, standing in the desert south-west, where
      it rises straight behind the sign from the end of the street.
    */
    const tx = -150
    const tz = 80
    const H = 44
    const b0 = 5.5
    const b1 = 1.8
    const leg = (sx: number, sz: number, t: number) => [tx + sx * (b0 + (b1 - b0) * t), H * t, tz + sz * (b0 + (b1 - b0) * t)] as const
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
    for (const [sx, sz] of corners) {
      const [x0, y0, z0] = leg(sx, sz, 0)
      const [x1, y1, z1] = leg(sx, sz, 1)
      strut(far, PAL.steel, x0, y0, z0, x1, y1, z1, 0.6, SURF.none)
    }
    for (let k = 0; k < 5; k++) {
      const t0 = k / 5
      const t1 = (k + 1) / 5
      for (let c = 0; c < 4; c++) {
        const [ax, az] = corners[c]
        const [bx, bz] = corners[(c + 1) % 4]
        const p = leg(ax, az, t0)
        const q = leg(bx, bz, t1)
        strut(far, PAL.steel, p[0], p[1], p[2], q[0], q[1], q[2], 0.26, SURF.none)
        const p2 = leg(ax, az, t1)
        const q2 = leg(bx, bz, t1)
        strut(far, PAL.steel, p2[0], p2[1], p2[2], q2[0], q2[1], q2[2], 0.26, SURF.none)
      }
    }
    slab(far, '#6e6b66', tx - 3.4, H, tz - 3.4, tx + 3.4, H + 0.5, tz + 3.4, SURF.none)
    const f = framed(tx, tz, 2.02)
    f.put(far, CYL12, '#55524d', 0, H + 8.6, 0, Math.PI / 2, 0, 0, 16.6, 1.0, 16.6)
    f.put(far, CYL12, '#ebe6d8', 0, H + 8.6, 0.3, Math.PI / 2, 0, 0, 15, 0.9, 15)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2
      f.box(far, '#2d2b28', Math.cos(a) * 6.2 - 0.3, H + 8.6 + Math.sin(a) * 6.2 - 0.3, 0.75, Math.cos(a) * 6.2 + 0.3, H + 8.6 + Math.sin(a) * 6.2 + 0.3, 0.85)
    }
    // three minutes to midnight
    f.strut(far, '#2d2b28', 0, H + 8.6, 0.9, -0.9, H + 13.6, 0.9, 0.45)
    f.strut(far, '#2d2b28', 0, H + 8.6, 0.95, -0.4, H + 12.0, 0.95, 0.6)
    for (const s of [-1, 1]) f.strut(far, PAL.steel, s * 2, H + 0.5, 0, s * 1.2, H + 1.4, 0, 0.4)
  }
  {
    // a tall radio mast far off to the north-west
    const [mx, mz, H] = [-150, -225, 110]
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      strut(far, '#8a4f3a', mx + sx * 3.5, 0, mz + sz * 3.5, mx + sx * 0.8, H, mz + sz * 0.8, 0.5, SURF.none)
    }
    for (let y = 8; y < H; y += 10) {
      const k = 3.5 - (2.7 * y) / H
      strut(far, '#8a4f3a', mx - k, y, mz - k, mx + k, y + 10, mz + k, 0.25, SURF.none)
      strut(far, '#8a4f3a', mx + k, y, mz - k, mx - k, y + 10, mz + k, 0.25, SURF.none)
    }
  }
  // the poles on down the street, and scrub and boulders on the sand
  for (let x = 154; x < 330; x += 34) {
    put(far, CYL8, '#6b5540', x, 8, 17.4, 0, 0, 0, 0.55, 16, 0.55, SURF.bark)
    slab(far, '#6b5540', x - 2.2, 14.4, 17.25, x + 2.2, 14.7, 17.55, SURF.bark)
    if (x + 34 < 330) for (const dx of [-1.8, 1.8]) strut(far, '#2f2d2b', x + dx, 15.1, 17.4, x + 34 + dx, 15.1, 17.4, 0.06, SURF.none)
  }
  strut(far, '#2f2d2b', 118.2, 15.1, 17.4, 152.2, 15.1, 17.4, 0.06, SURF.none)
  strut(far, '#2f2d2b', 121.8, 15.1, 17.4, 155.8, 15.1, 17.4, 0.06, SURF.none)
  for (let k = 0; k < 110; k++) {
    const a = rng() * Math.PI * 2
    const d = 130 + rng() * 140
    const x = 17 + Math.cos(a) * d
    const z = Math.sin(a) * d
    if (x > 0 && Math.abs(z) < 22) continue
    if (Math.abs(x - 17) < 135 && Math.abs(z) < 122) continue
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

  /** the spawns: each side in its own back yard, facing its house, the way
      the two teams start. Two players arriving together are handed
      different ones where they can be, and the scene's slot scatter
      (net/spawn.ts) keeps any two on one point from standing up inside
      each other. The south six are the north six turned half round */
  const NORTH: Array<[number, number, number]> = [
    [-28, -92, 0.15], [-16, -94, 0.05], [-4, -86, -0.05], [12, -84, -0.2], [-40, -80, 0.25], [-22, -80, 0],
  ]
  const SPAWNS: LevelSpawn[] = [
    ...NORTH.map(([x, z, t]) => ({ x, z, yaw: Math.PI + t })),
    ...NORTH.map(([x, z, t]) => ({ x: 2 * SYM_X - x, z: -z, yaw: t })),
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
        minX: NUKE_ORIGIN.x + MID.x0,
        maxX: NUKE_ORIGIN.x + MID.x1,
        minZ: NUKE_ORIGIN.z + YARD_N.z0,
        maxZ: NUKE_ORIGIN.z + YARD_S.z1,
      },
      boxes,
    ),
    get spawn() {
      let k = Math.floor(pickSpawn() * SPAWNS.length)
      if (k === lastSpawn) k = (k + 1 + Math.floor(pickSpawn() * (SPAWNS.length - 1))) % SPAWNS.length
      lastSpawn = k
      return SPAWNS[k]
    },
    // the north yard's six and the south yard's six, one side each
    teamSpawns: [SPAWNS.slice(0, NORTH.length), SPAWNS.slice(NORTH.length)],
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
      if (feetY > 0.6) return 'stone'
      const r = Math.hypot(lx, lz)
      if (r < R_ROAD || (lx > 0 && lx < 60 && lz > STUB_N && lz < STUB_S)) return 'asphalt'
      if (r < R_RING) return 'stone'
      return inRect(YARD_N, lx, lz) || inRect(MID, lx, lz) || inRect(YARD_S, lx, lz) ? 'grass' : 'sand'
    },
  }

  return { root, level }
}
