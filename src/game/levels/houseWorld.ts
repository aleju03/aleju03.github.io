import * as THREE from 'three'
import { seeded } from '../core/rand'
import { canvasTexture, makeGlowTexture } from '../core/textures'
import { noStand, padXZ } from '../physics/collision'
import { doorCreak, doorLatch, type StepSurface } from '../core/sfx'
import { applyFixedSurface, SURF, type SurfaceId } from '../world/surface'
import { buildKitTree } from '../world/treeMesh'
import { buildFittings, facingOf, type FittingHandles, type FittingSpec } from './fittings'
import type { SeatSpec } from '../player/seating'
import { texelate } from '../render/texel'
import { mergeGeoms } from '../core/geometry'

/** anything with a .scene group — a GLTFLoader result or a slice of one */
export interface ModelLike {
  scene: THREE.Group
}

/*
  The rest of the house around the computer room: a two-storey suburban
  family home of about 2005, with the kid's room (the desk scene, where every
  visit starts) upstairs at the front, a straight flight of stairs down to a
  foyer, the living room, the kitchen and dining, a half bath and laundry, an
  attached garage onto a driveway, and upstairs a full bath, a den, the
  master bedroom and a linen closet; a fenced yard with a front gate onto the
  street. The plan is drawn out room by room under "plan" below. Everything
  past the fence (sky, sun and moon, the city, the neighborhood) lives in
  outsideWorld.ts; this module owns the property line inward.

  Two storeys are the same helpers run twice: every wall, window, door, floor
  and ceiling measures its heights from the storey being built (`LV`), and
  the floor between them is one standable slab with the stairwell left open.
  The stairs are solid steps a riser inside the walk's own step height, so
  they are walked, not climbed, and a guard rides the flight's open side and
  the gallery over it so nobody steps off into the foyer.

  Two phases so the boot flow never waits on furniture:
  - buildHouse() is procedural architecture only (walls, floors, ceilings,
    windows, doors, lights, yard ground, sky). It runs synchronously with the
    core desk models, so the whole house is walkable immediately.
  - handles.furnish() attaches the ~35 downloaded GLBs (bed, sofa, kitchen
    run, fence, trees...) whenever they finish streaming in.

  Walls are built per room: every room lays down its own full perimeter with
  door/window holes cut out. Collision remains one continuous thick AABB
  through windows (glass is never a passage) and only splits at floor-height
  openings, whose ends overlap by a shoulder margin. The overlap matters: two
  boxes meeting at an exact edge leave a zero-width line a point-body can be
  resolved onto and then walk along through the wall. Doors are hinge pivots
  worked with the interact key: a closed one swings away from whichever side
  the player stands on, an open one pulls
  shut, and the doorway itself is an obstacle while the leaf is in the way.
  They cast no shadows so the baked maps stay valid. Working one creaks the
  hinge (core/sfx.ts) and a closing leaf clicks its latch home as it seats.

  The furniture works too, and none of that machinery is here. This module
  knows *which* pieces open, where their cushions are and where the
  television's glass ended up; the three things that make those facts do
  something live elsewhere, because none of them is about a house:

  - `levels/fittings.ts` hinges the leaves. Every openable is one line in
    `furnish` naming the GLB's own node ("doorLeft", "washerDoor") and what
    is behind it, and the module works out the hinge edge, the swing
    direction and the interior.
  - `player/seating.ts` owns sitting down. The seats are published as plain
    numbers (a cushion, a facing, a spot to stand up onto) and CrtScene hands
    them to the walk.
  - `components/os/houseTv.ts` owns the picture, because the picture is DOM.
    `screen` here is only the measured tube face.
*/

export interface HouseModels {
  [key: string]: ModelLike | undefined
}

/**
 * Where a picture goes on a piece of furniture: the television's tube face,
 * measured off the placed model. Deliberately a plain frame of reference
 * rather than anything renderer-shaped: what hangs on it is DOM, and DOM
 * belongs on the React side (`components/os/houseTv.ts`).
 */
export interface ScreenPlacement {
  centre: THREE.Vector3
  normal: THREE.Vector3
  right: THREE.Vector3
  up: THREE.Vector3
  width: number
  height: number
}

export interface HouseHandles {
  root: THREE.Group
  /** door easing, working furniture and firefly drift; call every roam frame */
  update: (dt: number) => void
  /** the door within reach the player is looking at: which verb to prompt */
  doorPrompt: (p: THREE.Vector3, gaze: THREE.Vector3) => 'open' | 'close' | null
  /** work that door; a closed leaf swings away from the player's side */
  useDoor: (p: THREE.Vector3, gaze: THREE.Vector3) => boolean
  /** the cupboard, drawer or appliance door being looked at */
  propPrompt: (
    p: THREE.Vector3,
    gaze: THREE.Vector3,
  ) => { verb: 'open' | 'close'; label: string } | null
  /** work it */
  useProp: (p: THREE.Vector3, gaze: THREE.Vector3) => boolean
  /** hang a leaf that belongs to somebody else's furniture on the same key
      (the desk in `deskRoom.ts` owns its own drawers) */
  addFitting: (spec: FittingSpec) => void
  /** every cushion in the house, published once the furniture lands */
  seats: SeatSpec[]
  /** the living-room television's tube face, once it has been placed */
  screen: ScreenPlacement | null
  /** what a footstep lands on here: plank floors inside the walls, the
      concrete porch slab, grass everywhere else on the property */
  surfaceAt: (x: number, z: number) => StepSurface
  /** 0 seated .. 1 walking: ramps every house light with the room rig */
  setRoamLight: (k: number) => void
  /** 0 night .. 1 day: fades fireflies and the curtained-window glow out */
  setDay: (day: number) => void
  /** mark the shadow maps near the player dirty (call only while moving) */
  flagShadows: (p: THREE.Vector3) => void
  /** shadow-casting lights owned by the house (for full re-bakes) */
  shadowLights: THREE.SpotLight[]
  /** attach the downloaded furniture models during the covered boot warm-up */
  furnish: (models: HouseModels) => void
}

interface BuildOpts {
  scene: THREE.Scene
  obstacles: THREE.Box3[]
  /** shared materials from the desk scene so the house matches it */
  darkWoodMat: THREE.MeshStandardMaterial
  windowGlassMat: THREE.MeshStandardMaterial
  /** the pendant-lamp model (a core one), cloned for the other ceilings */
  lamp: ModelLike
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

/* ---------------------------------------------------------------- plan --
   A family's house in 2005, two floors over the same footprint, with the
   kid's computer room upstairs at the front.

   Ground floor (y 0):
   Living: x -7.6..2.4, z -1.75..10.5  (the television and the sofa, a
                                        picture window onto the street and a
                                        cased opening onto the foyer)
   Foyer:  x 2.4..7.6,  z -1.75..10.5  (front door in the street wall, the
                                        stairs up the east wall, open north
                                        onto the hall)
   Bath:   x -7.6..-2.4, z 10.5..16.6  (half bath and the laundry)
   Hall:   x -2.4..7.6, z 10.5..14.0   (arch to the kitchen, a door east
                                        into the garage)
   Kitchen+dining: x -7.6..7.6, z 14..24.5 minus the bath block corner.
   Garage: x 7.6..13.0, z -1.75..14.0  (single storey, carriage doors onto
                                        the driveway)

   Upper floor (y UP):
   Computer room: x -7.6..3.4, z -1.75..10.5 (the desk scene: this is where
                                        everybody spawns)
   Gallery: x 3.4..5.2, z 2.1..10.5    (beside the stairwell, railed)
   Linen:  x 3.4..7.6, z -1.75..2.1    (a closet over the front door)
   Hall:   x -2.4..7.6, z 10.5..14.0   (the stairs arrive at its east end)
   Bath:   x -7.6..-2.4, z 10.5..16.6  (the full bathroom)
   Den:    x -7.6..0.4, z 14..24.5 minus the bath corner (the game room)
   Master: x 0.4..7.6, z 14..24.5

   Yard: fenced x ±13.5 out to z 38.5; back door + porch on the north wall.

   Two rules the plan keeps. Every opening on the outside of the building
   leads somewhere on the inside of it (the street facade once carried a
   door onto nothing and two curtains lit from inside a solid wall). And the
   computer room keeps the desk scene's own coordinates in x and z, one
   storey up: everything the camera cinematics measure off the desk moves by
   exactly UP in y and nothing else.
------------------------------------------------------------------------- */
/** a storey's clear height, floor to ceiling */
export const CEIL_H = 6
/** the floor between the storeys: its underside is the ground floor's
    ceiling, its top is the upper floor */
export const SLAB = 0.4
/** the upper floor's height */
export const UP = CEIL_H + SLAB
/** the main block, both storeys */
export const HOUSE = { minX: -7.6, maxX: 7.6, minZ: -1.75, maxZ: 24.5 }
/** the attached garage, ground floor only */
export const GARAGE = { minX: 7.6, maxX: 13.0, minZ: -1.75, maxZ: 14.0 }
/** everything with a roof over it: what is indoors, for the sky and the
    world-streaming backstop */
export const FOOTPRINT = [HOUSE, GARAGE] as const
/** how far inside the footprint (x, z) is: positive within it, negative
    outside, by the nearest wall of whichever block is deepest */
export const insideBy = (x: number, z: number) => {
  let best = -Infinity
  for (const r of FOOTPRINT) {
    const d = Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z)
    if (d > best) best = d
  }
  return best
}
export const YARD = { minX: -13.5, maxX: 13.5, minZ: -4, maxZ: 38.5 }
/** gap in the front fence: the way out to the street, lined up with the
    front door so the walk from one to the other is a straight line */
export const GATE = { x0: 4.2, x1: 6.8 }
/** ...and the driveway's, in front of the garage doors */
export const DRIVE = { x0: 7.9, x1: 12.7 }
/** the computer room's east partition, upstairs. Exported because the desk
    room hangs its bookshelf on it */
export const PART_X = 3.4
/** the ground floor's partition between the living room and the foyer */
const PART_G = 2.4
/** the stairs: a straight flight up the foyer's east wall, rising north and
    arriving on the upper hall. Sixteen risers of 0.4, which is inside the
    walk's step (a tenth and a bit of its eye height, 0.46), so the flight is
    walked rather than hopped, and the fifteenth tread is one riser under the
    upper floor */
export const STAIR = { x0: 5.2, x1: 7.6, z0: 2.1, z1: 10.5, steps: 15 }
const RISE = UP / (STAIR.steps + 1)
const TREAD = (STAIR.z1 - STAIR.z0) / STAIR.steps
/** the gallery's railing line over the stairwell, and the stair's open side */
const RAIL_X = STAIR.x0
/** picket height: what the instanced fence model is scaled to */
const FENCE_H = 1.9
/**
 * ...and how tall its collision box is, which is deliberately a little less.
 * A box stops blocking the moment the feet clear its top, so the vault window
 * is the time the hop spends above it — jumpV²/2·grav puts the apex at 2.08,
 * and against a 1.9 box that window is about a twentieth of a second, or two
 * handspans of travel: not enough to cross the box's own depth, so the fence
 * read as unjumpable even though the arc technically cleared it. At 1.7 the
 * window is a third of a second, which is a walkable metre. The other half of
 * the fix is the depth below: half the padding, half the distance to cross.
 */
const FENCE_BLOCK_H = 1.7
const FENCE_PAD = 0.22
/** the picket lines, x0 z0 x1 z1: the three sides of the yard, the front
    line in three pieces (the gate and the driveway are the gaps), and a
    cross run from the west side to the back corner. The east side needs
    none: the garage stands against that fence, so the side yard behind it
    is the back garden's */
const FENCE_RUNS: Array<[number, number, number, number]> = [
  [YARD.minX, YARD.minZ, YARD.minX, YARD.maxZ],
  [YARD.maxX, YARD.minZ, YARD.maxX, YARD.maxZ],
  [YARD.minX, YARD.maxZ, YARD.maxX, YARD.maxZ],
  [YARD.minX, HOUSE.maxZ, HOUSE.minX - 0.1, HOUSE.maxZ],
  [YARD.minX, YARD.minZ, GATE.x0, YARD.minZ],
  [GATE.x1, YARD.minZ, DRIVE.x0, YARD.minZ],
  [DRIVE.x1, YARD.minZ, YARD.maxX, YARD.minZ],
]
/** the backrooms seam: this span of the east living-room wall is dressed
    like wall but never blocks — walking into it noclips you into level 0
    (backrooms.ts owns everything past the paint) */
export const NOCLIP = { z0: 16.0, z1: 17.8 }
const BATH = { minX: -7.6, maxX: -2.4, minZ: 10.5, maxZ: 16.6 }
const HALL = { minX: BATH.maxX, maxX: 7.6, minZ: 10.5, maxZ: 14.0 }
const DOOR_H = 4.7
// Walk collision tracks the camera as a point; authored solids grow sideways
// by this much to represent its shoulders. Wall pieces need the same margin
// along their length, especially where a fixed jamb meets a dynamic door.
const WALL_SHOULDER = 0.2
// in the x=3.4 partition upstairs, spans z. At the gallery's north end, so
// the computer room opens where the stairs arrive, and the whole partition
// south of it stays free wall for the bookshelf and the wardrobe
const BED_DOOR = { u0: 8.15, u1: 10.25 }
const FRONT_DOOR = { u0: 4.45, u1: 6.55 } // in the z=-1.75 street wall
export const FRONT_DOOR_X = (FRONT_DOOR.u0 + FRONT_DOOR.u1) / 2
const BATH_DOOR = { u0: 11.6, u1: 13.7 } // in the x=-2.4 wall, both floors
const ARCH = { u0: 0.0, u1: 3.4, h: 4.9 } // cased opening in the z=14 wall
/** cased opening between the foyer and the living room, in x=PART_G */
const LIVING_ARCH = { u0: 3.0, u1: 7.2, h: 4.9 }
const BACK_DOOR = { u0: -4.6, u1: -2.5 } // in the z=24.5 wall
/** centre of the back door, the property's other way out */
export const BACK_DOOR_X = (BACK_DOOR.u0 + BACK_DOOR.u1) / 2
/** hall to garage, in the x=7.6 wall */
const GARAGE_IN = { u0: 11.3, u1: 13.4 }
/** the garage's carriage doors onto the driveway: two leaves, hinged at the
    outer jambs, in the garage's street wall */
export const GARAGE_DOOR = { u0: 8.2, u1: 12.4, h: 5.0 }
/** upstairs, off the gallery and the hall */
const LINEN_DOOR = { u0: 3.7, u1: 5.0 } // in the z=2.1 closet wall
const DEN_DOOR = { u0: -2.0, u1: -0.05 } // in the upper hall's z=14 wall
const MBR_DOOR = { u0: 1.0, u1: 3.1 } // likewise
/** where the living room's shadow-casting pendant hangs: over the coffee
    table, between the sofa and the television */
const LIVING_PENDANT = { x: -2.6, z: 6.3 }
/** the partition between the den and the master bedroom, upstairs */
const DEN_X = 0.4
const LINEN_Z = STAIR.z0
const BACK_WIN = { u0: 2.3, u1: 6.1, y0: 2.5, y1: 4.7 }
const SINK_WIN = { u0: 20.5, u1: 22.1, y0: 2.9, y1: 4.3 }
const BATH_WIN = { u0: 12.5, u1: 13.7, y0: 3.3, y1: 4.5 }
/** the west windows of the living room and, one floor up, the computer
    room, whose moonlight the desk scene's window spill is aimed through */
const BEDROOM_WIN = { u0: 4.86, u1: 6.64, y0: 2.73, y1: 3.87 }
/** the computer room's street window, over the living room's */
const FRONT_WIN = { u0: -5.7, u1: -3.5, y0: 2.5, y1: 4.15 }
/** the living room's picture window onto the street */
const LIVING_WIN = { u0: -5.9, u1: -1.3, y0: 1.5, y1: 4.4 }
/** and the foyer's: a narrow sidelight beside the front door */
const ENTRY_WIN = { u0: 3.6, u1: 4.15, y0: 1.4, y1: 4.3 }
/** upstairs: the den's two, the master's two, the hall's over the garage */
const DEN_WIN = { u0: -6.0, u1: -2.8, y0: 2.5, y1: 4.4 } // back wall
const DEN_WIN_W = { u0: 19.6, u1: 22.4, y0: 2.5, y1: 4.4 } // west wall
const MBR_WIN = { u0: 2.6, u1: 5.6, y0: 2.6, y1: 4.4 } // back wall
const MBR_WIN_E = { u0: 18.3, u1: 20.7, y0: 2.6, y1: 4.4 } // east wall
const HALL_WIN = { u0: 11.7, u1: 13.0, y0: 2.8, y1: 4.4 } // east wall
/** the garage's one window, on its east wall */
const GAR_WIN = { u0: 5.0, u1: 7.4, y0: 3.0, y1: 4.3 }
/** the roof: a gable over the main block, ridge running front to back, and
    a lower one over the garage */
const EAVE_Y = UP + CEIL_H
const RIDGE_Y = EAVE_Y + 5.2
const GARAGE_RIDGE_Y = CEIL_H + 1.9

/* ------------------------------------------------------- canvas textures */

/** wood planks running along x; two palettes keep bedroom and living apart */
const makePlankTexture = (base: string, seam: string, seed: number) =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const rand = seeded(seed)
    ctx.fillStyle = base
    ctx.fillRect(0, 0, w, h)
    const rows = 4
    for (let r = 0; r < rows; r++) {
      const y = (r / rows) * h
      const shade = (rand() - 0.5) * 14
      ctx.fillStyle = `rgba(${shade > 0 ? '255,240,220' : '0,0,0'},${Math.abs(shade) / 160})`
      ctx.fillRect(0, y, w, h / rows)
      // grain strokes
      for (let i = 0; i < 26; i++) {
        ctx.strokeStyle = `rgba(0,0,0,${0.03 + rand() * 0.05})`
        ctx.lineWidth = 1
        const gy = y + rand() * (h / rows)
        ctx.beginPath()
        ctx.moveTo(0, gy)
        ctx.bezierCurveTo(w * 0.3, gy + (rand() - 0.5) * 3, w * 0.7, gy + (rand() - 0.5) * 3, w, gy)
        ctx.stroke()
      }
      // plank end seams, staggered per row
      ctx.fillStyle = seam
      ctx.fillRect(0, y, w, 2)
      const ends = 1 + Math.floor(rand() * 2)
      for (let e = 0; e < ends; e++) ctx.fillRect(rand() * w, y, 2, h / rows)
    }
  })

const makeTileTexture = () =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const rand = seeded(0x7e11)
    const n = 4
    const s = w / n
    for (let ty = 0; ty < n; ty++)
      for (let tx = 0; tx < n; tx++) {
        const v = 196 + Math.floor(rand() * 14)
        ctx.fillStyle = `rgb(${v - 14},${v - 6},${v - 8})`
        ctx.fillRect(tx * s, ty * s, s, s)
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(tx * s + 2, ty * s + 2, s - 4, s / 3)
      }
    ctx.strokeStyle = '#5a615c'
    ctx.lineWidth = 3
    for (let i = 0; i <= n; i++) {
      ctx.beginPath()
      ctx.moveTo(i * s, 0)
      ctx.lineTo(i * s, h)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, i * s)
      ctx.lineTo(w, i * s)
      ctx.stroke()
    }
  })

const makeGrassTexture = () =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const rand = seeded(0x97a55)
    // tuned against the open world's lawns, not against midnight: this base
    // was #233618 when the site never saw daylight, then #3d5326, and both
    // read as a hole cut out of the bright suburb. It sits between the two
    // ground tints of the biome the home block actually lands in — *forest*,
    // per probing biomeAt over the yard, not plains — because the world's
    // grass field grows the yard's turf now and colours its blades off the
    // ground, so the soil under them has to be the same number
    ctx.fillStyle = '#44602f'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 2600; i++) {
      const g = 78 + rand() * 54
      ctx.fillStyle = `rgba(${g * 0.62},${g},${g * 0.42},${0.25 + rand() * 0.5})`
      ctx.fillRect(rand() * w, rand() * h, 1 + (rand() < 0.2 ? 1 : 0), 1 + (rand() < 0.3 ? 1 : 0))
    }
    // worn patches
    for (let i = 0; i < 7; i++) {
      const grad = ctx.createRadialGradient(
        rand() * w, rand() * h, 2, rand() * w, rand() * h, 18 + rand() * 26)
      grad.addColorStop(0, 'rgba(52,48,26,0.16)')
      grad.addColorStop(1, 'rgba(52,48,26,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)
    }
  })

/* --------------------------------------------------------------- helpers */

const tmpBox = new THREE.Box3()
const tmpVec = new THREE.Vector3()
// firefly frame temps, hoisted so the roam loop never allocates
const flyM = new THREE.Matrix4()
const flyQ = new THREE.Quaternion()
const flyS = new THREE.Vector3(1, 1, 1)

interface Door {
  pivot: THREE.Group
  axis: 'x' | 'z'
  /** the wall-plane coordinate; which side the player is on picks the swing */
  at: number
  /** hinge multiplier: the leaf runs along +u (1, hinge u0) or -u (-1, u1) */
  dir: 1 | -1
  cx: number
  cz: number
  /** the floor it stands on: a door is only in reach from its own storey,
      or the one over the front door would answer from the landing above */
  y: number
  /** how far the leaf swings, magnitude only; sign is chosen per use */
  swing: number
  angle: number
  target: number
  /** blocks the doorway while the leaf is in the way; emptied once clear */
  block: THREE.Box3
  closedMin: THREE.Vector3
  closedMax: THREE.Vector3
  solid: boolean
}

export function buildHouse(opts: BuildOpts): HouseHandles {
  const {
    scene, obstacles, darkWoodMat, windowGlassMat,
    lamp, trackTexture, trackDisposable,
  } = opts

  const root = new THREE.Group()
  scene.add(root)

  /** the working furniture: every cupboard, drawer and appliance door. Built
      up front and filled during furnish, because the leaves are model parts */
  const fittings: FittingHandles = buildFittings({ parent: root, trackDisposable })
  /** every cushion in the house, handed to the seating system after furnish */
  const seats: SeatSpec[] = []
  /** the television's tube face, once there is a television */
  let screen: ScreenPlacement | null = null

  const track = (t: THREE.Texture) => {
    trackTexture(t)
    trackDisposable(t)
    return t
  }

  /*
    Wall panels are PlaneGeometry cut to whatever span is left between the
    doors and windows, so their UVs run 0..1 across a piece that might be two
    units wide or twelve — a tiled canvas texture would stretch differently on
    every panel of the same wall. world/surface.ts solves that by working from
    world position instead of UVs, so the same procedural pass the city's
    brickwork uses gives these render and boards, and a panel's width stops
    mattering. Interiors get plaster; the outside gets siding.
  */
  const wallMats = new Map<string, THREE.MeshStandardMaterial>()
  const wallMat = (color: string, surf: SurfaceId = SURF.plaster) => {
    const key = `${color}|${surf}`
    let m = wallMats.get(key)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 1 })
      applyFixedSurface(m, surf)
      wallMats.set(key, m)
    }
    return m
  }
  const skirtMat = new THREE.MeshStandardMaterial({ color: '#241c14', roughness: 0.9 })
  const trimMat = darkWoodMat

  const doors: Door[] = []
  const bulbs: Array<{ mat: THREE.MeshStandardMaterial; on: number }> = []
  const lights: Array<{ light: THREE.Light; on: number }> = []
  const shadowLights: THREE.SpotLight[] = []

  /*
    The storey being built. Every helper below (walls, windows, doors, floors,
    ceilings) measures its heights from here, so the upper floor is the same
    calls again with LV set to UP rather than a second set of helpers.
  */
  let LV = 0

  /* ------------------------------------------------------------- walls -- */

  interface Cut {
    u0: number
    u1: number
    y0: number
    y1: number
  }
  /**
   * A wall plane at `axis`=const, spanning [u0,u1] along the other axis,
   * floor to CEIL_H, with rectangular holes. Emits visual segments, a
   * baseboard along solid floor spans, and thick collision boxes split only
   * by cuts that reach the floor. A window does not split collision: keeping
   * one box through its glass removes the exact AABB seams a point-body could
   * otherwise ride through. Walk-through cuts retain a small overlap at each
   * jamb to account for the player's shoulders.
   */
  const wall = (
    axis: 'x' | 'z',
    at: number,
    u0: number,
    u1: number,
    facing: 1 | -1,
    color: string,
    cuts: Cut[] = [],
    o: {
      base?: boolean; obstacle?: boolean; h?: number; surf?: SurfaceId
      /** the facade: seen from the street and the yard, so it throws the
          sun's shadow like the roof over it */
      cast?: boolean
    } = {},
  ) => {
    // a ground-floor wall runs up through the slab to the floor above, so
    // the stairwell, where both storeys are in view at once, shows no strip
    // of daylight between them; its top is hidden under the ceiling plane
    // everywhere else
    const h = o.h ?? (LV === 0 ? UP : CEIL_H)
    const lv = LV
    const mat = wallMat(color, o.surf)
    const sorted = [...cuts].sort((a, b) => a.u0 - b.u0)
    const panel = (pu0: number, pu1: number, py0: number, py1: number) => {
      if (pu1 - pu0 < 0.01 || py1 - py0 < 0.01) return
      const m = new THREE.Mesh(new THREE.PlaneGeometry(pu1 - pu0, py1 - py0), mat)
      const uc = (pu0 + pu1) / 2
      const yc = lv + (py0 + py1) / 2
      m.castShadow = !!o.cast
      if (axis === 'x') {
        m.position.set(at + facing * 0.01, yc, uc)
        m.rotation.y = (facing * Math.PI) / 2
      } else {
        m.position.set(uc, yc, at + facing * 0.01)
        m.rotation.y = facing === 1 ? 0 : Math.PI
      }
      m.receiveShadow = true
      root.add(m)
    }
    const base = (bu0: number, bu1: number) => {
      if (o.base === false || bu1 - bu0 < 0.12) return
      const m = new THREE.Mesh(new THREE.BoxGeometry(bu1 - bu0, 0.17, 0.06), skirtMat)
      if (axis === 'x') {
        m.position.set(at + facing * 0.05, lv + 0.085, (bu0 + bu1) / 2)
        m.rotation.y = Math.PI / 2
      } else {
        m.position.set((bu0 + bu1) / 2, lv + 0.085, at + facing * 0.05)
      }
      m.receiveShadow = true
      root.add(m)
    }
    const block = (bu0: number, bu1: number) => {
      if (o.obstacle === false || bu1 - bu0 < 0.05) return
      // noStand: the box is 0.8 deep around a paper-thin wall, so its top is
      // an invisible catwalk at the ceiling plane — and the furniture below
      // adds up to a ladder onto it
      obstacles.push(noStand(
        axis === 'x'
          ? new THREE.Box3(
              new THREE.Vector3(at - 0.4, lv, bu0 - WALL_SHOULDER),
              new THREE.Vector3(at + 0.4, lv + h, bu1 + WALL_SHOULDER),
            )
          : new THREE.Box3(
              new THREE.Vector3(bu0 - WALL_SHOULDER, lv, at - 0.4),
              new THREE.Vector3(bu1 + WALL_SHOULDER, lv + h, at + 0.4),
            ),
      ))
    }
    let cursor = u0
    for (const c of sorted) {
      panel(cursor, c.u0, 0, h)
      base(cursor, c.u0)
      panel(c.u0, c.u1, 0, c.y0)
      panel(c.u0, c.u1, c.y1, h)
      if (c.y0 > 0.5) {
        // window: wall below it still blocks and keeps its baseboard
        base(c.u0, c.u1)
      }
      cursor = c.u1
    }
    panel(cursor, u1, 0, h)
    base(cursor, u1)

    // Windows are visual cuts only. Build collision in long uninterrupted
    // runs and split it solely around an opening that actually reaches the
    // floor (door, arch, or the deliberate backrooms seam).
    let solidCursor = u0
    for (const c of sorted) {
      if (c.y0 > 0.5) continue
      block(solidCursor, c.u0)
      solidCursor = c.u1
    }
    block(solidCursor, u1)
  }

  /* ------------------------------------------------- windows and doors -- */

  const windowUnit = (
    axis: 'x' | 'z',
    at: number,
    u0: number,
    u1: number,
    y0: number,
    y1: number,
    frosted = false,
  ) => {
    const g = new THREE.Group()
    const w = u1 - u0
    const h = y1 - y0
    const mat = frosted
      ? new THREE.MeshStandardMaterial({
          color: '#cfd8d2', roughness: 0.55, transparent: true, opacity: 0.62,
          emissive: new THREE.Color('#3a4450'), emissiveIntensity: 0.25,
          depthWrite: false, side: THREE.DoubleSide,
        })
      : windowGlassMat
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    pane.renderOrder = 8
    g.add(pane)
    const rails: Array<[number, number, number, number, number]> = [
      // w, h, x, y, z-out
      [w + 0.22, 0.11, 0, h / 2 + 0.05, 0.04],
      [w + 0.22, 0.13, 0, -h / 2 - 0.05, 0.05], // sill, a touch deeper
      [0.11, h + 0.22, -w / 2 - 0.05, 0, 0.04],
      [0.11, h + 0.22, w / 2 + 0.05, 0, 0.04],
      [0.07, h, 0, 0, 0.03],
      [w, 0.06, 0, 0, 0.03],
    ]
    rails.forEach(([rw, rh, x, y, d]) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(rw, rh, 0.08 + d), trimMat)
      rail.position.set(x, y, 0)
      rail.castShadow = false
      rail.receiveShadow = true
      g.add(rail)
    })
    const uc = (u0 + u1) / 2
    const yc = LV + (y0 + y1) / 2
    if (axis === 'x') {
      g.position.set(at, yc, uc)
      g.rotation.y = Math.PI / 2
    } else {
      g.position.set(uc, yc, at)
    }
    root.add(g)
  }

  // one leaf material per look, shared by every door that wears it
  const leafMats = new Map<string, THREE.MeshStandardMaterial>()
  const leafMat = (color: string) => {
    let m = leafMats.get(color)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.74 })
      trackDisposable(m)
      leafMats.set(color, m)
    }
    return m
  }
  const handleMat = new THREE.MeshStandardMaterial({
    color: '#b8a26a', roughness: 0.35, metalness: 0.6,
  })
  trackDisposable(handleMat)

  const doorUnit = (
    axis: 'x' | 'z',
    at: number,
    u0: number,
    u1: number,
    hinge: 'u0' | 'u1',
    swing: number,
    o: {
      glass?: boolean
      /** opening height, when it is not a room door's */
      h?: number
      /** leaf colour and its inset panels' */
      color?: string
      panel?: string
      /** a pair of leaves shares one opening: draw only this leaf's outer
          jamb and its half of the header */
      pair?: boolean
    } = {},
  ) => {
    const w = u1 - u0
    const lv = LV
    const dh = o.h ?? DOOR_H
    // jambs + header
    const jamb = (uc: number, jw: number, jh: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(jw, jh, 0.24), trimMat)
      if (axis === 'x') {
        m.position.set(at, lv + y, uc)
        m.rotation.y = Math.PI / 2
      } else m.position.set(uc, lv + y, at)
      m.castShadow = false
      m.receiveShadow = true
      root.add(m)
    }
    if (!o.pair || hinge === 'u0') jamb(u0 - 0.05, 0.14, dh + 0.12, (dh + 0.12) / 2)
    if (!o.pair || hinge === 'u1') jamb(u1 + 0.05, 0.14, dh + 0.12, (dh + 0.12) / 2)
    jamb((u0 + u1) / 2, w + (o.pair ? 0.12 : 0.24), 0.16, dh + 0.1)

    const pivot = new THREE.Group()
    const hu = hinge === 'u0' ? u0 : u1
    const dir = hinge === 'u0' ? 1 : -1
    if (axis === 'x') pivot.position.set(at, lv, hu)
    else pivot.position.set(hu, lv, at)

    const slab = new THREE.Group()
    const slabMat = leafMat(o.color ?? '#4f3a26')
    // the leaf runs a touch wider and taller than the opening so it laps the
    // jambs and header when shut: no lit slivers around a closed door. A
    // pair meets in the middle, so each laps only its own outer edge
    const leafW = w + (o.pair ? 0.04 : 0.08)
    const leafH = dh + 0.01
    if (o.glass) {
      // stile-and-rail glass door onto the porch
      const railH = 0.5
      const stileW = 0.24
      const parts: Array<[number, number, number, number]> = [
        [leafW, railH, 0, railH / 2 + 0.02],
        [leafW, railH * 1.6, 0, dh - railH * 0.8 - 0.05],
        [leafW, railH, 0, dh * 0.45],
        [stileW, leafH, -leafW / 2 + stileW / 2, leafH / 2],
        [stileW, leafH, leafW / 2 - stileW / 2, leafH / 2],
      ]
      parts.forEach(([pw, ph, x, y]) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, 0.09), slabMat)
        m.position.set(x, y, 0)
        m.castShadow = false
        slab.add(m)
      })
      const paneDefs: Array<[number, number]> = [
        [(railH + dh * 0.45) / 2 + 0.1, dh * 0.45 - railH - 0.1],
        [(dh * 0.45 + railH / 2 + dh - railH * 1.6) / 2, dh * 0.5 - railH * 1.55],
      ]
      paneDefs.forEach(([y, ph]) => {
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.5, ph), windowGlassMat)
        pane.position.set(0, y, 0)
        pane.renderOrder = 8
        slab.add(pane)
      })
    } else {
      const m = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, 0.09), slabMat)
      m.position.set(0, leafH / 2, 0)
      m.castShadow = false
      m.receiveShadow = true
      slab.add(m)
      // inset panels, front and back, spaced to the leaf's height
      const panelMat = leafMat(o.panel ?? '#453321')
      const k = dh / DOOR_H
      ;[0.052, -0.052].forEach((z) => {
        ;[1.35 * k, 3.35 * k].forEach((y) => {
          const p = new THREE.Mesh(new THREE.BoxGeometry(w - 0.6, 1.5 * k, 0.02), panelMat)
          p.position.set(0, y, z)
          p.castShadow = false
          slab.add(p)
        })
      })
    }
    // handle both sides
    ;[0.1, -0.1].forEach((z) => {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), handleMat)
      knob.position.set(dir * (w / 2 - 0.45), 2.2, z)
      knob.castShadow = false
      slab.add(knob)
    })
    // a real gap under the leaf, so it sweeps over rugs instead of through
    slab.position.set(dir * (w / 2), 0.055, 0)
    pivot.add(slab)
    // for x-walls the leaf's local +x must run along +z (hinge toward latch)
    pivot.rotation.y = axis === 'x' ? -Math.PI / 2 : 0
    pivot.userData.baseRotY = pivot.rotation.y
    pivot.userData.dynamic = true // survives the scene-wide matrix freeze
    root.add(pivot)
    const center = axis === 'x'
      ? { cx: at, cz: (u0 + u1) / 2 }
      : { cx: (u0 + u1) / 2, cz: at }
    // a shut door is a wall: block the doorway until the leaf swings clear
    const closedMin = axis === 'x'
      ? new THREE.Vector3(at - 0.4, lv, u0 - WALL_SHOULDER)
      : new THREE.Vector3(u0 - WALL_SHOULDER, lv, at - 0.4)
    const closedMax = axis === 'x'
      ? new THREE.Vector3(at + 0.4, lv + CEIL_H, u1 + WALL_SHOULDER)
      : new THREE.Vector3(u1 + WALL_SHOULDER, lv + CEIL_H, at + 0.4)
    // a shut door reaches the ceiling like the wall it stands in: same deal,
    // its top is not a ledge (and it collapses to a point when it opens)
    const block = noStand(new THREE.Box3(closedMin.clone(), closedMax.clone()))
    obstacles.push(block)
    doors.push({
      pivot, axis, at, dir, ...center, y: lv, swing,
      angle: 0, target: 0, block, closedMin, closedMax, solid: true,
    })
  }

  /* ------------------------------------------------------- floor planes -- */

  const plankBedTex = track(texelate(makePlankTexture('#2a2018', '#1c150e', 0xbed0)))
  const plankLivTex = track(texelate(makePlankTexture('#32261c', '#221912', 0x11f0)))
  const tileTex = track(texelate(makeTileTexture()))
  const grassTex = track(texelate(makeGrassTexture()))

  const floorPlane = (
    x0: number, x1: number, z0: number, z1: number,
    tex: THREE.Texture, texScale: number, y = 0,
  ) => {
    const t = tex.clone()
    t.needsUpdate = true
    t.repeat.set((x1 - x0) / texScale, (z1 - z0) / texScale)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 4
    trackTexture(t)
    trackDisposable(t)
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.94, map: t })
    trackDisposable(mat)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat)
    m.rotation.x = -Math.PI / 2
    m.position.set((x0 + x1) / 2, LV + y, (z0 + z1) / 2)
    m.receiveShadow = true
    root.add(m)
    return m
  }

  /** the storey's ceiling, a plane and nothing else. What stops the chase
      boom above it is the slab of the floor over it (or, on the top storey,
      the attic volume under the roof), registered once for the whole plan
      rather than per room */
  const ceiling = (x0: number, x1: number, z0: number, z1: number, color: string) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(x1 - x0, z1 - z0),
      wallMat(color),
    )
    m.rotation.x = Math.PI / 2
    m.position.set((x0 + x1) / 2, LV + CEIL_H, (z0 + z1) / 2)
    m.receiveShadow = true
    root.add(m)
  }

  /** an invisible solid; `stand` makes its top a floor */
  const solid = (
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    stand = false,
  ) => {
    const b = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1))
    obstacles.push(stand ? b : noStand(b))
    return b
  }

  /**
   * Boxes merged into one mesh: `[w, h, d, x, y, z, rotX?, rotY?, rotZ?]`
   * each, world placed. The balusters, the treads and the trim of this house
   * are dozens of small parts in a handful of materials, and every one of
   * them is a draw call of its own unless it shares a buffer with its kind.
   */
  type Part = [number, number, number, number, number, number, number?, number?, number?]
  const mergeBoxes = (parts: Part[], mat: THREE.Material, cast = false) => {
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const s = new THREE.Vector3(1, 1, 1)
    let geo: THREE.BufferGeometry | null = null
    for (const [w, h, d, x, y, z, rx = 0, ry = 0, rz = 0] of parts) {
      const g = new THREE.BoxGeometry(w, h, d)
      g.applyMatrix4(m4.compose(tmpVec.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s))
      if (!geo) geo = g
      else {
        const merged = mergeGeoms(geo, g)
        geo.dispose()
        g.dispose()
        geo = merged
      }
    }
    if (!geo) return null
    trackDisposable(geo)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.castShadow = cast
    mesh.receiveShadow = true
    root.add(mesh)
    return mesh
  }

  /** a cased opening: two jambs and a header, in the plane of a wall */
  const casing = (axis: 'x' | 'z', at: number, u0: number, u1: number, h: number) => {
    const parts: Part[] = []
    for (const u of [u0 - 0.05, u1 + 0.05]) {
      parts.push(axis === 'x'
        ? [0.3, h + 0.1, 0.14, at, LV + (h + 0.1) / 2, u]
        : [0.14, h + 0.1, 0.3, u, LV + (h + 0.1) / 2, at])
    }
    parts.push(axis === 'x'
      ? [0.3, 0.18, u1 - u0 + 0.24, at, LV + h + 0.08, (u0 + u1) / 2]
      : [u1 - u0 + 0.24, 0.18, 0.3, (u0 + u1) / 2, LV + h + 0.08, at])
    mergeBoxes(parts, trimMat)
  }

  /** a wall's floor-to-head opening, as a cut */
  const opening = (d: { u0: number; u1: number }, h = DOOR_H): Cut => ({ u0: d.u0, u1: d.u1, y0: 0, y1: h })
  /** a window one storey up, as the facade sees it */
  const upper = (c: Cut): Cut => ({ u0: c.u0, u1: c.u1, y0: c.y0 + UP, y1: c.y1 + UP })
  /** the bath block's two outside corners: the one-sided wall planes sit a
      hair off the mathematical corner, so the bare edge shows a sliver of
      the room behind it at grazing angles; a slim post seals each seam */
  const cornerPosts = (color: string, pts: Array<[number, number]>) => {
    pts.forEach(([x, z]) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, CEIL_H, 0.18), wallMat(color))
      post.position.set(x, LV + CEIL_H / 2, z)
      post.castShadow = false
      post.receiveShadow = true
      root.add(post)
    })
  }

  const concreteMat = new THREE.MeshStandardMaterial({ color: '#565550', roughness: 0.9 })
  trackDisposable(concreteMat)

  /* ======================================================= GROUND FLOOR */

  LV = 0

  // -- the street wall: the living room's picture window, the foyer's
  // sidelight and the front door. Every hole in it has a room behind it
  wall('z', HOUSE.minZ, HOUSE.minX, HOUSE.maxX, 1, '#4f4234', [
    LIVING_WIN, ENTRY_WIN, opening(FRONT_DOOR),
  ])

  // -- living room: the old bedroom's footprint, less the foyer
  wall('x', HOUSE.minX, HOUSE.minZ, 10.5, 1, '#584839', [BEDROOM_WIN])
  wall('z', 10.5, HOUSE.minX, PART_G, -1, '#584839')
  // the partition, drawn from both sides; only the living room's face
  // registers the obstacle, or the opening would be blocked by the other
  // face's box
  wall('x', PART_G, HOUSE.minZ, 10.5, -1, '#584839', [opening(LIVING_ARCH, LIVING_ARCH.h)])
  wall('x', PART_G, HOUSE.minZ, 10.5, 1, '#4a4034', [opening(LIVING_ARCH, LIVING_ARCH.h)], { obstacle: false })
  casing('x', PART_G, LIVING_ARCH.u0, LIVING_ARCH.u1, LIVING_ARCH.h)
  floorPlane(HOUSE.minX, PART_G, HOUSE.minZ, 10.5, plankLivTex, 3.4)
  ceiling(HOUSE.minX, PART_G, HOUSE.minZ, 10.5, '#3d342b')
  windowUnit('x', HOUSE.minX + 0.045, BEDROOM_WIN.u0, BEDROOM_WIN.u1, BEDROOM_WIN.y0, BEDROOM_WIN.y1)
  windowUnit('z', HOUSE.minZ + 0.045, LIVING_WIN.u0, LIVING_WIN.u1, LIVING_WIN.y0, LIVING_WIN.y1)
  windowUnit('z', HOUSE.minZ + 0.045, ENTRY_WIN.u0, ENTRY_WIN.u1, ENTRY_WIN.y0, ENTRY_WIN.y1)

  // -- foyer: the stairs run up its east wall, and its north end is open to
  // the hall, so there is nothing else to build but the floor it shares.
  // Its ceiling stops at the stairwell, which is open to the roof
  wall('x', HOUSE.maxX, HOUSE.minZ, 10.5, -1, '#4a4034')
  floorPlane(PART_G, HOUSE.maxX, HOUSE.minZ, 10.5, plankBedTex, 3.4)
  ceiling(PART_G, STAIR.x0, HOUSE.minZ, 10.5, '#3a3129')
  ceiling(STAIR.x0, HOUSE.maxX, HOUSE.minZ, STAIR.z0, '#3a3129')

  // -- half bath and the laundry
  wall('z', BATH.minZ, BATH.minX, BATH.maxX, 1, '#5d665b')
  wall('x', BATH.maxX, BATH.minZ, BATH.maxZ, -1, '#5d665b', [opening(BATH_DOOR)])
  wall('z', BATH.maxZ, BATH.minX, BATH.maxX, -1, '#5d665b')
  wall('x', BATH.minX, BATH.minZ, BATH.maxZ, 1, '#5d665b', [BATH_WIN])
  floorPlane(BATH.minX, BATH.maxX, BATH.minZ, BATH.maxZ, tileTex, 2.3, 0.004)
  ceiling(BATH.minX, BATH.maxX, BATH.minZ, BATH.maxZ, '#3f4440')
  windowUnit('x', BATH.minX + 0.045, BATH_WIN.u0, BATH_WIN.u1, BATH_WIN.y0, BATH_WIN.y1, true)

  // -- hall: the foyer arrives at its east end, beside the back of the
  // stairs; the garage is through its east wall
  wall('z', HALL.minZ, HALL.minX, PART_G, 1, '#4a4034')
  wall('x', HALL.minX, HALL.minZ, HALL.maxZ, 1, '#4a4034', [opening(BATH_DOOR)])
  wall('x', HALL.maxX, HALL.minZ, HALL.maxZ, -1, '#4a4034', [opening(GARAGE_IN)])
  wall('z', HALL.maxZ, HALL.minX, HALL.maxX, -1, '#4a4034', [opening(ARCH, ARCH.h)])
  floorPlane(HALL.minX, HALL.maxX, HALL.minZ, HALL.maxZ, plankBedTex, 3.4, 0.002)
  ceiling(HALL.minX, HALL.maxX, HALL.minZ, HALL.maxZ, '#3a3129')

  // -- kitchen and dining (L-shaped around the bath block)
  wall('z', 14, HALL.minX, HALL.maxX, 1, '#554636', [opening(ARCH, ARCH.h)])
  wall('x', BATH.maxX, 14, BATH.maxZ, 1, '#554636')
  wall('z', BATH.maxZ, BATH.minX, BATH.maxX, 1, '#554636')
  wall('x', HOUSE.minX, BATH.maxZ, HOUSE.maxZ, 1, '#554636', [SINK_WIN])
  wall('z', HOUSE.maxZ, HOUSE.minX, HOUSE.maxX, -1, '#5a4b3a', [opening(BACK_DOOR), BACK_WIN])
  wall('x', HOUSE.maxX, 14, HOUSE.maxZ, -1, '#554636', [
    // the backrooms seam: a full-height floor cut, so no panel and no
    // obstacle span it; the disguise below makes it read as wall anyway
    { u0: NOCLIP.z0, u1: NOCLIP.z1, y0: 0, y1: UP },
  ])
  floorPlane(HOUSE.minX, HOUSE.maxX, BATH.maxZ, HOUSE.maxZ, plankLivTex, 3.4)
  floorPlane(HALL.minX, HOUSE.maxX, 14, BATH.maxZ, plankLivTex, 3.4)
  ceiling(HOUSE.minX, HOUSE.maxX, BATH.maxZ, HOUSE.maxZ, '#3a332b')
  ceiling(HALL.minX, HOUSE.maxX, 14, BATH.maxZ, '#3a332b')
  windowUnit('x', HOUSE.minX + 0.045, SINK_WIN.u0, SINK_WIN.u1, SINK_WIN.y0, SINK_WIN.y1)
  windowUnit('z', HOUSE.maxZ - 0.045, BACK_WIN.u0, BACK_WIN.u1, BACK_WIN.y0, BACK_WIN.y1)

  // dress the backrooms seam as wall again: same paint, same baseboard,
  // recessed a couple of centimeters so it can't z-fight its neighbors;
  // the hairline shadow around it is the only visual tell (that, and the
  // damp stain backrooms.ts hangs on it)
  const slip = new THREE.Mesh(
    new THREE.PlaneGeometry(NOCLIP.z1 - NOCLIP.z0, CEIL_H), wallMat('#554636'))
  slip.position.set(HOUSE.maxX + 0.01, CEIL_H / 2, (NOCLIP.z0 + NOCLIP.z1) / 2)
  slip.rotation.y = -Math.PI / 2
  slip.receiveShadow = true
  root.add(slip)
  const slipBase = new THREE.Mesh(
    new THREE.BoxGeometry(NOCLIP.z1 - NOCLIP.z0, 0.17, 0.06), skirtMat)
  slipBase.position.set(HOUSE.maxX - 0.05, 0.085, (NOCLIP.z0 + NOCLIP.z1) / 2)
  slipBase.rotation.y = Math.PI / 2
  slipBase.receiveShadow = true
  root.add(slipBase)

  casing('z', 14, ARCH.u0, ARCH.u1, ARCH.h)
  cornerPosts('#554636', [[BATH.maxX, HALL.maxZ], [BATH.maxX, BATH.maxZ]])

  // -- garage: bare paint on block, a concrete floor, one window. Its west
  // wall is the house's east facade, siding and all, which is what a
  // garage built onto a house looks like from inside it
  wall('z', GARAGE.minZ, GARAGE.minX, GARAGE.maxX, 1, '#7a7466', [
    opening(GARAGE_DOOR, GARAGE_DOOR.h),
  ], { h: CEIL_H })
  wall('x', GARAGE.maxX, GARAGE.minZ, GARAGE.maxZ, -1, '#7a7466', [GAR_WIN], { h: CEIL_H })
  wall('z', GARAGE.maxZ, GARAGE.minX, GARAGE.maxX, -1, '#7a7466', [], { h: CEIL_H })
  {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(GARAGE.maxX - GARAGE.minX, GARAGE.maxZ - GARAGE.minZ), concreteMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.set((GARAGE.minX + GARAGE.maxX) / 2, 0.004, (GARAGE.minZ + GARAGE.maxZ) / 2)
    floor.receiveShadow = true
    root.add(floor)
  }
  ceiling(GARAGE.minX, GARAGE.maxX, GARAGE.minZ, GARAGE.maxZ, '#57524a')
  windowUnit('x', GARAGE.maxX - 0.045, GAR_WIN.u0, GAR_WIN.u1, GAR_WIN.y0, GAR_WIN.y1)

  // -- ground-floor doors; each swings away from whoever opens it
  doorUnit('z', HOUSE.minZ, FRONT_DOOR.u0, FRONT_DOOR.u1, 'u0', Math.PI * 0.55, { color: '#5a2f24', panel: '#4a261d' })
  // the bath leaf stops shy of a right angle so it clears the pedestal sink
  doorUnit('x', BATH.maxX, BATH_DOOR.u0, BATH_DOOR.u1, 'u0', Math.PI * 0.44, { color: '#8a7b64', panel: '#7a6c57' })
  doorUnit('x', HALL.maxX, GARAGE_IN.u0, GARAGE_IN.u1, 'u0', Math.PI * 0.5, { color: '#8a7b64', panel: '#7a6c57' })
  doorUnit('z', HOUSE.maxZ, BACK_DOOR.u0, BACK_DOOR.u1, 'u0', Math.PI * 0.58, { glass: true })
  // the carriage pair onto the driveway: a leaf per jamb, meeting mid-span
  {
    const mid = (GARAGE_DOOR.u0 + GARAGE_DOOR.u1) / 2
    const look = { h: GARAGE_DOOR.h, color: '#c9c0ae', panel: '#b3aa98', pair: true }
    doorUnit('z', GARAGE.minZ, GARAGE_DOOR.u0, mid, 'u0', Math.PI * 0.5, look)
    doorUnit('z', GARAGE.minZ, mid, GARAGE_DOOR.u1, 'u1', Math.PI * 0.5, look)
  }

  /* ======================================================== UPPER FLOOR */

  LV = UP

  // -- the street wall: the computer room's window over the living room's;
  // the linen closet over the front door has none
  wall('z', HOUSE.minZ, HOUSE.minX, HOUSE.maxX, 1, '#3d3328', [FRONT_WIN])

  // -- the computer room: the desk scene's room, exactly where the bedroom
  // under it was, one storey up
  wall('x', HOUSE.minX, HOUSE.minZ, 10.5, 1, '#4a3d30', [BEDROOM_WIN])
  wall('z', 10.5, HOUSE.minX, PART_X, -1, '#50412f')
  wall('x', PART_X, HOUSE.minZ, 10.5, -1, '#50412f', [opening(BED_DOOR)])
  wall('x', PART_X, HOUSE.minZ, 10.5, 1, '#4a4034', [opening(BED_DOOR)], { obstacle: false })
  floorPlane(HOUSE.minX, PART_X, HOUSE.minZ, 10.5, plankBedTex, 3.4)
  ceiling(HOUSE.minX, PART_X, HOUSE.minZ, 10.5, '#3a3129')
  windowUnit('x', HOUSE.minX + 0.045, BEDROOM_WIN.u0, BEDROOM_WIN.u1, BEDROOM_WIN.y0, BEDROOM_WIN.y1)
  windowUnit('z', HOUSE.minZ + 0.045, FRONT_WIN.u0, FRONT_WIN.u1, FRONT_WIN.y0, FRONT_WIN.y1)

  // -- the linen closet over the front door, and the gallery beside the
  // stairwell. The closet's wall is the stairwell's south end, so it hangs
  // over the foot of the stairs; its gallery face registers the obstacle
  wall('z', LINEN_Z, PART_X, HOUSE.maxX, 1, '#4a4034', [opening(LINEN_DOOR)])
  wall('z', LINEN_Z, PART_X, HOUSE.maxX, -1, '#5e5445', [opening(LINEN_DOOR)], { obstacle: false })
  wall('x', HOUSE.maxX, HOUSE.minZ, 10.5, -1, '#4a4034')
  floorPlane(PART_X, HOUSE.maxX, HOUSE.minZ, LINEN_Z, plankBedTex, 3.4)
  floorPlane(PART_X, STAIR.x0, LINEN_Z, 10.5, plankLivTex, 3.4)
  ceiling(PART_X, HOUSE.maxX, HOUSE.minZ, 10.5, '#3a3129')

  // -- the upper hall: the stairs arrive at its east end
  wall('z', HALL.minZ, HALL.minX, PART_X, 1, '#4a4034')
  wall('x', HALL.minX, HALL.minZ, HALL.maxZ, 1, '#4a4034', [opening(BATH_DOOR)])
  wall('x', HALL.maxX, HALL.minZ, HALL.maxZ, -1, '#4a4034', [HALL_WIN])
  wall('z', HALL.maxZ, HALL.minX, HALL.maxX, -1, '#4a4034', [opening(DEN_DOOR), opening(MBR_DOOR)])
  floorPlane(HALL.minX, HALL.maxX, HALL.minZ, HALL.maxZ, plankLivTex, 3.4, 0.002)
  ceiling(HALL.minX, HALL.maxX, HALL.minZ, HALL.maxZ, '#3a3129')
  windowUnit('x', HALL.maxX - 0.045, HALL_WIN.u0, HALL_WIN.u1, HALL_WIN.y0, HALL_WIN.y1)

  // -- the full bathroom, over the half bath
  wall('z', BATH.minZ, BATH.minX, BATH.maxX, 1, '#5b6b70')
  wall('x', BATH.maxX, BATH.minZ, BATH.maxZ, -1, '#5b6b70', [opening(BATH_DOOR)])
  wall('z', BATH.maxZ, BATH.minX, BATH.maxX, -1, '#5b6b70')
  wall('x', BATH.minX, BATH.minZ, BATH.maxZ, 1, '#5b6b70', [BATH_WIN])
  floorPlane(BATH.minX, BATH.maxX, BATH.minZ, BATH.maxZ, tileTex, 2.3, 0.004)
  ceiling(BATH.minX, BATH.maxX, BATH.minZ, BATH.maxZ, '#3f4440')
  windowUnit('x', BATH.minX + 0.045, BATH_WIN.u0, BATH_WIN.u1, BATH_WIN.y0, BATH_WIN.y1, true)

  // -- the den (an L round the bathroom, like the kitchen under it) and the
  // master bedroom, either side of one partition
  wall('x', BATH.maxX, HALL.maxZ, BATH.maxZ, 1, '#4f4a3c')
  wall('z', BATH.maxZ, BATH.minX, BATH.maxX, 1, '#4f4a3c')
  wall('x', HOUSE.minX, BATH.maxZ, HOUSE.maxZ, 1, '#4f4a3c', [DEN_WIN_W])
  wall('z', HOUSE.maxZ, HOUSE.minX, HOUSE.maxX, -1, '#4f4a3c', [DEN_WIN, MBR_WIN])
  wall('x', DEN_X, HALL.maxZ, HOUSE.maxZ, -1, '#4f4a3c')
  wall('x', DEN_X, HALL.maxZ, HOUSE.maxZ, 1, '#5a4c44', [], { obstacle: false })
  wall('z', HALL.maxZ, HALL.minX, HALL.maxX, 1, '#5a4c44', [
    opening(DEN_DOOR), opening(MBR_DOOR),
  ], { obstacle: false })
  wall('x', HOUSE.maxX, HALL.maxZ, HOUSE.maxZ, -1, '#5a4c44', [MBR_WIN_E])
  floorPlane(HOUSE.minX, DEN_X, BATH.maxZ, HOUSE.maxZ, plankBedTex, 3.4)
  floorPlane(HALL.minX, DEN_X, HALL.maxZ, BATH.maxZ, plankBedTex, 3.4)
  floorPlane(DEN_X, HOUSE.maxX, HALL.maxZ, HOUSE.maxZ, plankLivTex, 3.4)
  ceiling(HOUSE.minX, DEN_X, BATH.maxZ, HOUSE.maxZ, '#3a332b')
  ceiling(HALL.minX, DEN_X, HALL.maxZ, BATH.maxZ, '#3a332b')
  ceiling(DEN_X, HOUSE.maxX, HALL.maxZ, HOUSE.maxZ, '#3a332b')
  windowUnit('x', HOUSE.minX + 0.045, DEN_WIN_W.u0, DEN_WIN_W.u1, DEN_WIN_W.y0, DEN_WIN_W.y1)
  windowUnit('z', HOUSE.maxZ - 0.045, DEN_WIN.u0, DEN_WIN.u1, DEN_WIN.y0, DEN_WIN.y1)
  windowUnit('z', HOUSE.maxZ - 0.045, MBR_WIN.u0, MBR_WIN.u1, MBR_WIN.y0, MBR_WIN.y1)
  windowUnit('x', HOUSE.maxX - 0.045, MBR_WIN_E.u0, MBR_WIN_E.u1, MBR_WIN_E.y0, MBR_WIN_E.y1)
  cornerPosts('#4f4a3c', [[BATH.maxX, HALL.maxZ], [BATH.maxX, BATH.maxZ]])

  // -- upstairs doors
  doorUnit('x', PART_X, BED_DOOR.u0, BED_DOOR.u1, 'u0', Math.PI * 0.52)
  doorUnit('x', BATH.maxX, BATH_DOOR.u0, BATH_DOOR.u1, 'u0', Math.PI * 0.44, { color: '#8a7b64', panel: '#7a6c57' })
  doorUnit('z', LINEN_Z, LINEN_DOOR.u0, LINEN_DOOR.u1, 'u0', Math.PI * 0.55, { color: '#8a7b64', panel: '#7a6c57' })
  doorUnit('z', HALL.maxZ, DEN_DOOR.u0, DEN_DOOR.u1, 'u0', Math.PI * 0.5)
  doorUnit('z', HALL.maxZ, MBR_DOOR.u0, MBR_DOOR.u1, 'u0', Math.PI * 0.5)

  LV = 0

  /* ============================================ BETWEEN AND ABOVE THEM */

  // The floor between the storeys, a standable slab over the whole plan
  // with the stairwell left open, and the attic over the top one. The slab
  // is what the ground floor's chase boom stops against now: it used to be
  // a thin noStand lid over every ceiling
  solid(HOUSE.minX, CEIL_H, 10.5, HOUSE.maxX, UP, HOUSE.maxZ, true)
  solid(HOUSE.minX, CEIL_H, HOUSE.minZ, STAIR.x0, UP, 10.5, true)
  solid(STAIR.x0, CEIL_H, HOUSE.minZ, HOUSE.maxX, UP, STAIR.z0, true)
  solid(HOUSE.minX - 0.8, EAVE_Y, HOUSE.minZ - 0.6, HOUSE.maxX + 0.8, RIDGE_Y, HOUSE.maxZ + 0.6)
  solid(GARAGE.minX, CEIL_H, GARAGE.minZ - 0.5, GARAGE.maxX + 0.6, GARAGE_RIDGE_Y, GARAGE.maxZ + 0.5)

  /*
    The stairs. Each step is a solid block from the floor to its tread, so
    the flight reads as a closed stair with a cupboard under it and the walk
    finds a standable top under every foot: a riser is RISE (0.4), inside the
    walk's own step, so it climbs as it would climb a kerb. The open side gets
    a guard a banister high over every tread, which is what stops a walker
    from stepping off the flight into the foyer; it rides the steps, so it is
    over the head of anyone passing underneath.
  */
  const STAIR_BODY = '#4a4034'
  {
    const body: Part[] = []
    const treads: Part[] = []
    const w = STAIR.x1 - STAIR.x0
    for (let k = 1; k <= STAIR.steps; k++) {
      const top = k * RISE
      const z0 = STAIR.z0 + (k - 1) * TREAD
      const z1 = z0 + TREAD
      body.push([w, top, TREAD, (STAIR.x0 + STAIR.x1) / 2, top / 2, (z0 + z1) / 2])
      // the tread laps its riser by a nosing, a value step darker than the
      // paint so each edge reads through the posterize
      treads.push([w + 0.06, 0.08, TREAD + 0.08, (STAIR.x0 + STAIR.x1) / 2 - 0.03, top - 0.03, (z0 + z1) / 2 - 0.04])
      // Each step's solid runs from its own nosing to the top of the flight,
      // so the boxes overlap rather than tile. Tiled, the seam between two
      // treads was a zero-width line a point-body resolved onto and then
      // walked along, straight through the side of the stairs from the
      // foyer; overlapped, every box a body can be inside is long in z, so
      // the way out is always sideways. The tallest top under a foot is
      // still that tread's own
      solid(STAIR.x0, 0, z0, STAIR.x1, top, STAIR.z1, true)
      solid(RAIL_X - 0.2, top, z0, RAIL_X + 0.1, top + 2.4, STAIR.z1)
    }
    mergeBoxes(body, wallMat(STAIR_BODY))
    mergeBoxes(treads, trimMat)

    // the banister: a newel at the foot, a rail up the pitch, a baluster a
    // tread; and the gallery's railing round the stairwell above
    const pitch = Math.atan2(RISE, TREAD)
    const railLen = Math.hypot(STAIR.z1 - STAIR.z0, STAIR.steps * RISE)
    const rails: Part[] = [
      [0.26, 3.0, 0.26, RAIL_X, 1.5, STAIR.z0 + 0.13],
      [0.14, 0.16, railLen, RAIL_X, 2.35 + (STAIR.steps * RISE) / 2, (STAIR.z0 + STAIR.z1) / 2, -pitch],
      // a stringer along the open side, so the flight has a line under it
      [0.08, 0.36, railLen, STAIR.x0 - 0.03, (STAIR.steps * RISE) / 2 - 0.05, (STAIR.z0 + STAIR.z1) / 2, -pitch],
    ]
    for (let k = 1; k <= STAIR.steps; k++) {
      const top = k * RISE
      const z = STAIR.z0 + (k - 0.5) * TREAD
      rails.push([0.07, 2.3, 0.07, RAIL_X, top + 1.15, z])
    }
    // gallery: a rail a hip high, balusters every half unit, a newel at
    // each end
    const gy = UP
    rails.push([0.14, 0.16, STAIR.z1 - STAIR.z0, RAIL_X, gy + 2.35, (STAIR.z0 + STAIR.z1) / 2])
    for (let z = STAIR.z0 + 0.35; z < STAIR.z1 - 0.1; z += 0.45) {
      rails.push([0.07, 2.3, 0.07, RAIL_X, gy + 1.15, z])
    }
    rails.push([0.24, 2.6, 0.24, RAIL_X, gy + 1.3, STAIR.z0 + 0.12])
    rails.push([0.24, 2.6, 0.24, RAIL_X, gy + 1.3, STAIR.z1 - 0.12])
    // the slab's cut edge round the stairwell, trimmed like a floor edge
    rails.push([0.16, SLAB + 0.12, STAIR.z1 - STAIR.z0, RAIL_X - 0.02, CEIL_H + SLAB / 2, (STAIR.z0 + STAIR.z1) / 2])
    rails.push([STAIR.x1 - STAIR.x0, SLAB + 0.12, 0.16, (STAIR.x0 + STAIR.x1) / 2, CEIL_H + SLAB / 2, STAIR.z0 + 0.02])
    mergeBoxes(rails, trimMat)
    // the gallery's guard: a hip-high rail is nothing to a hop, so the box is
    // taller than the hop's apex over the landing
    solid(RAIL_X - 0.2, UP, STAIR.z0, RAIL_X + 0.1, UP + 2.6, STAIR.z1)
  }

  /* ============================================================ EXTERIOR */

  const facadeColor = '#6f6252'
  const FACADE = { base: false, obstacle: false, surf: SURF.plank, h: EAVE_Y, cast: true } as const
  // both storeys at once: the holes of each floor, the upper ones lifted
  wall('z', HOUSE.maxZ + 0.14, HOUSE.minX - 0.14, HOUSE.maxX + 0.14, 1, facadeColor, [
    opening(BACK_DOOR), BACK_WIN, upper(DEN_WIN), upper(MBR_WIN),
  ], FACADE)
  wall('x', HOUSE.minX - 0.14, HOUSE.minZ - 0.14, HOUSE.maxZ + 0.14, -1, facadeColor, [
    BEDROOM_WIN, BATH_WIN, SINK_WIN, upper(BEDROOM_WIN), upper(BATH_WIN), upper(DEN_WIN_W),
  ], FACADE)
  // the east facade is also the garage's west wall, seen from inside it
  wall('x', HOUSE.maxX + 0.14, HOUSE.minZ - 0.14, HOUSE.maxZ + 0.14, 1, facadeColor, [
    opening(GARAGE_IN), upper(HALL_WIN), upper(MBR_WIN_E),
  ], FACADE)
  wall('z', HOUSE.minZ - 0.14, HOUSE.minX - 0.14, HOUSE.maxX + 0.14, -1, facadeColor, [
    LIVING_WIN, ENTRY_WIN, opening(FRONT_DOOR), upper(FRONT_WIN),
  ], FACADE)
  // the garage's own three
  const GFACADE = { ...FACADE, h: CEIL_H }
  wall('z', GARAGE.minZ - 0.14, HOUSE.maxX + 0.14, GARAGE.maxX + 0.14, -1, facadeColor, [
    opening(GARAGE_DOOR, GARAGE_DOOR.h),
  ], GFACADE)
  wall('x', GARAGE.maxX + 0.14, GARAGE.minZ - 0.14, GARAGE.maxZ + 0.14, 1, facadeColor, [GAR_WIN], GFACADE)
  wall('z', GARAGE.maxZ + 0.14, HOUSE.maxX + 0.14, GARAGE.maxX + 0.14, 1, facadeColor, [], GFACADE)

  /*
    Trim that says "two storeys" from the street: corner boards up every
    outside corner, a belly band where the floors meet, a fascia under the
    eaves. Each is a value step off the siding, so the posterize keeps them
    as lines rather than folding them into the wall.
  */
  const fasciaMat = new THREE.MeshStandardMaterial({ color: '#e8dcc4', roughness: 0.85 })
  trackDisposable(fasciaMat)
  {
    const L = HOUSE.minX - 0.2
    const R = HOUSE.maxX + 0.2
    const F = HOUSE.minZ - 0.2
    const B = HOUSE.maxZ + 0.2
    const W = R - L
    const D = B - F
    const trim: Part[] = [
      // corner boards
      [0.26, EAVE_Y, 0.26, L + 0.07, EAVE_Y / 2, F + 0.07],
      [0.26, EAVE_Y, 0.26, R - 0.07, EAVE_Y / 2, F + 0.07],
      [0.26, EAVE_Y, 0.26, L + 0.07, EAVE_Y / 2, B - 0.07],
      [0.26, EAVE_Y, 0.26, R - 0.07, EAVE_Y / 2, B - 0.07],
      [0.26, CEIL_H, 0.26, GARAGE.maxX + 0.2 - 0.07, CEIL_H / 2, GARAGE.minZ - 0.13],
      [0.26, CEIL_H, 0.26, GARAGE.maxX + 0.2 - 0.07, CEIL_H / 2, GARAGE.maxZ + 0.13],
      // belly band where the storeys meet
      [W, 0.34, 0.16, (L + R) / 2, UP - 0.1, F + 0.02],
      [W, 0.34, 0.16, (L + R) / 2, UP - 0.1, B - 0.02],
      [0.16, 0.34, D, L + 0.02, UP - 0.1, (F + B) / 2],
      [0.16, 0.34, D, R - 0.02, UP - 0.1, (F + B) / 2],
      // fascia under both eaves
      [0.22, 0.4, D + 1.0, L - 0.72, EAVE_Y - 0.62, (F + B) / 2],
      [0.22, 0.4, D + 1.0, R + 0.72, EAVE_Y - 0.62, (F + B) / 2],
      // the garage's eave, on its open east side
      [0.22, 0.34, GARAGE.maxZ - GARAGE.minZ + 1.2, GARAGE.maxX + 0.72, CEIL_H - 0.3, (GARAGE.minZ + GARAGE.maxZ) / 2],
    ]
    mergeBoxes(trim, fasciaMat)
  }

  /*
    The roof: a gable over the main block with its ridge running front to
    back, so the street sees a gable end (siding up to the peak, a vent in
    it), and a lower one over the garage the same way round. Shingles are
    the city's own surface treatment, computed from world position like the
    siding, so a roof plane needs no UVs.
  */
  const roofMat = new THREE.MeshStandardMaterial({ color: '#4d3f3a', roughness: 0.95 })
  applyFixedSurface(roofMat, SURF.shingle)
  trackDisposable(roofMat)
  const gableRoof = (
    cx: number, run: number, eaveY: number, ridgeY: number,
    z0: number, z1: number,
    /** which slopes, and how far past its wall each one overhangs */
    sides: Array<[1 | -1, number]>,
  ) => {
    const rise = ridgeY - eaveY
    const L = Math.hypot(run, rise)
    const pitch = Math.atan2(rise, run)
    const len = z1 - z0 + 1.0
    const thick = 0.32
    const parts: Part[] = []
    for (const [s, over] of sides) {
      const ls = L + over
      // from the ridge, down the slope by half the slab, then out along the
      // normal by half its thickness
      const dx = (s * run) / L
      const dy = -rise / L
      const nx = (s * rise) / L
      const ny = run / L
      parts.push([
        ls, thick, len,
        cx + dx * (ls / 2) + nx * (thick / 2),
        ridgeY + dy * (ls / 2) + ny * (thick / 2),
        (z0 + z1) / 2,
        0, 0, -s * pitch,
      ])
    }
    const roof = mergeBoxes(parts, roofMat, true)
    // the ridge cap closes the seam where the two slabs meet
    const cap = mergeBoxes([[0.5, 0.26, len + 0.04, cx, ridgeY + 0.3, (z0 + z1) / 2]], roofMat, true)
    // the gable ends: siding up to the peak, over the facade's own top
    const tri = new THREE.Shape()
    tri.moveTo(-run, 0)
    tri.lineTo(run, 0)
    tri.lineTo(0, rise)
    tri.closePath()
    const triGeo = new THREE.ShapeGeometry(tri)
    trackDisposable(triGeo)
    for (const [z, rot] of [[z0, Math.PI], [z1, 0]] as const) {
      const g = new THREE.Mesh(triGeo, wallMat(facadeColor, SURF.plank))
      g.position.set(cx, eaveY, z)
      g.rotation.y = rot
      g.castShadow = true
      g.receiveShadow = true
      root.add(g)
    }
    return [roof, cap]
  }
  gableRoof(0, HOUSE.maxX + 0.14, EAVE_Y, RIDGE_Y, HOUSE.minZ - 0.14, HOUSE.maxZ + 0.14, [[1, 0.75], [-1, 0.75]])
  // the garage's west slope dies into the house wall, so it has no overhang:
  // one would poke through the siding into the stairwell
  gableRoof(
    (HOUSE.maxX + GARAGE.maxX + 0.28) / 2, (GARAGE.maxX - HOUSE.maxX + 0.28) / 2,
    CEIL_H, GARAGE_RIDGE_Y, GARAGE.minZ - 0.14, GARAGE.maxZ + 0.14, [[1, 0.7], [-1, 0]],
  )
  // attic vents in both main gables, and a brick chimney through the west
  // slope: the two things that say "there is a house under this roof"
  {
    const ventMat = new THREE.MeshStandardMaterial({ color: '#2a241f', roughness: 0.9 })
    trackDisposable(ventMat)
    const vy = EAVE_Y + (RIDGE_Y - EAVE_Y) * 0.45
    mergeBoxes([
      [1.3, 1.0, 0.12, 0, vy, HOUSE.minZ - 0.2],
      [1.3, 1.0, 0.12, 0, vy, HOUSE.maxZ + 0.2],
    ], ventMat)
    const brick = new THREE.MeshStandardMaterial({ color: '#6e3b2e', roughness: 0.95 })
    applyFixedSurface(brick, SURF.brick)
    trackDisposable(brick)
    const chimney = mergeBoxes([
      [1.3, 5.2, 1.5, -4.2, RIDGE_Y - 1.4, 17.5],
      [1.5, 0.25, 1.7, -4.2, RIDGE_Y + 1.25, 17.5],
    ], brick, true)
    void chimney
  }

  // -- ground: mowed lawn inside the property (the meadow beyond the fence
  // is outsideWorld's business now)
  // It runs a few units past the fence on every side on purpose: the open
  // world's terrain mesh cuts a rectangular hole around the property (see
  // grid.ts's RESERVED) and drops whole quads, so its edge is ragged to
  // within half a cell. The lawn oversails that raggedness, and sits a
  // couple of centimetres under the interior floor so the two can't fight.
  const lawnMat = new THREE.MeshStandardMaterial({ roughness: 1, map: grassTex })
  trackDisposable(lawnMat)
  grassTex.repeat.set(9, 14)
  const LAWN = { minX: -21, maxX: 21, minZ: -12, maxZ: 46.5 }
  const lawn = new THREE.Mesh(
    new THREE.PlaneGeometry(LAWN.maxX - LAWN.minX, LAWN.maxZ - LAWN.minZ), lawnMat)
  lawn.rotation.x = -Math.PI / 2
  lawn.position.set(0, -0.02, (LAWN.minZ + LAWN.maxZ) / 2)
  lawn.receiveShadow = true
  root.add(lawn)

  // porch slab + stepping stones bending toward the bench corner
  const porch = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.12, 2.8), concreteMat)
  porch.position.set(-3.55, 0.06, HOUSE.maxZ + 1.45)
  porch.receiveShadow = true
  root.add(porch)
  const stoneGeo = new THREE.CylinderGeometry(0.62, 0.68, 0.09, 7)
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#4a4a46', roughness: 0.95 })
  trackDisposable(stoneMat)
  const stonePath: Array<[number, number]> = [
    [-2.1, 27.3], [-1.0, 28.4], [0.2, 29.3], [1.5, 30.1],
    [2.8, 30.9], [3.9, 31.9], [4.6, 33.1],
  ]
  const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, stonePath.length)
  const stoneM = new THREE.Matrix4()
  const stoneQ = new THREE.Quaternion()
  const stoneE = new THREE.Euler()
  stonePath.forEach(([x, z], i) => {
    stoneQ.setFromEuler(stoneE.set(0, (i * 1.7) % Math.PI, 0))
    stoneM.compose(tmpVec.set(x, 0.02, z), stoneQ, new THREE.Vector3(1, 1, 1).setScalar(0.9 + (i % 3) * 0.12))
    stones.setMatrixAt(i, stoneM)
  })
  stones.receiveShadow = true
  root.add(stones)

  /* ---------------------------------------------------- street face -- */

  // The doorstep, a canopy over it on two posts, the walk to the gate, and
  // the driveway from the garage doors to the pavement.
  const frontZ = HOUSE.minZ - 0.14
  const FRONT_CX = (FRONT_DOOR.u0 + FRONT_DOOR.u1) / 2
  const frontStep = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.16, 1.0), concreteMat)
  frontStep.position.set(FRONT_CX, 0.08, HOUSE.minZ - 0.62)
  frontStep.receiveShadow = true
  root.add(frontStep)
  // a slim canopy over the step, so the door reads as an entrance from the
  // road rather than as a hole. Its box is head height and above, so it is
  // never in a walk's way and needs no obstacle
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.22, 1.5), trimMat)
  canopy.position.set(FRONT_CX, DOOR_H + 0.6, HOUSE.minZ - 0.6)
  canopy.castShadow = false
  root.add(canopy)
  ;[FRONT_CX - 1.5, FRONT_CX + 1.5].forEach((x) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, DOOR_H + 0.5, 0.16), trimMat)
    post.position.set(x, (DOOR_H + 0.5) / 2, frontZ - 1.2)
    post.castShadow = false
    root.add(post)
    obstacles.push(noStand(new THREE.Box3(
      new THREE.Vector3(x - 0.22, 0, frontZ - 1.42),
      new THREE.Vector3(x + 0.22, DOOR_H + 0.5, frontZ - 0.98),
    )))
  })

  // a straight concrete walk from the doorstep to the gate, both now on the
  // same line: the reason the gate moved when the door became real
  const frontWalk = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.07, HOUSE.minZ - 1.12 - YARD.minZ), concreteMat)
  frontWalk.position.set(FRONT_CX, 0.035, (HOUSE.minZ - 1.12 + YARD.minZ) / 2)
  frontWalk.receiveShadow = true
  root.add(frontWalk)
  // the driveway, the garage doors' width, out through its gap in the fence
  const driveway = new THREE.Mesh(
    new THREE.BoxGeometry(DRIVE.x1 - DRIVE.x0, 0.06, HOUSE.minZ - 0.14 - (YARD.minZ - 0.3)), concreteMat)
  driveway.position.set((DRIVE.x0 + DRIVE.x1) / 2, 0.03, (HOUSE.minZ - 0.14 + YARD.minZ - 0.3) / 2)
  driveway.receiveShadow = true
  root.add(driveway)
  // posts cap the fence ends at both gaps
  mergeBoxes(
    [GATE.x0 - 0.09, GATE.x1 + 0.09, DRIVE.x0 - 0.09, DRIVE.x1 + 0.09]
      .map((x): Part => [0.2, 2.1, 0.2, x, 1.05, YARD.minZ]),
    darkWoodMat,
  )

  /* --------------------------------------------------------------- yard -- */

  // fence obstacles now; the picket meshes arrive with the furniture GLBs.
  // 0.4 out on each side of a picket line, and exactly as tall as the pickets
  // the furnish pass instances (FENCE_H): the box used to stand a metre over
  // them, which is why a fence you can see over could not be jumped. At this
  // height the walk's apex clears it, so the gate is the polite way out of
  // the yard rather than the only one. Still noStand — the top of a picket
  // line is not a walkway, and resolveXZ stops blocking the moment the feet
  // are above it, which is exactly the vault
  const fenceBlock = (x0: number, z0: number, x1: number, z1: number) =>
    obstacles.push(noStand(new THREE.Box3(
      new THREE.Vector3(Math.min(x0, x1) - FENCE_PAD, 0, Math.min(z0, z1) - FENCE_PAD),
      new THREE.Vector3(Math.max(x0, x1) + FENCE_PAD, FENCE_BLOCK_H, Math.max(z0, z1) + FENCE_PAD),
    )))
  for (const [x0, z0, x1, z1] of FENCE_RUNS) fenceBlock(x0, z0, x1, z1)

  // the turf itself is the world's grass field: grass.ts grows its blades
  // right through the fence line now (mown shorter inside it), mowing around
  // the hardscape via grid.ts's onHomeHardscape mirror of these slabs and
  // stones. The instanced tufts that used to live here read as a different,
  // darker plant than the field starting at the fence, and the seam ran
  // along the property line.

  // fireflies: additive quads on gentle sine orbits
  const flyTex = track(makeGlowTexture('rgba(255,236,150,0.9)', 'rgba(255,200,80,0)'))
  const flyMat = new THREE.MeshBasicMaterial({
    map: flyTex, transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  })
  trackDisposable(flyMat)
  const flyRand = seeded(0xf17ef1)
  const flies = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.22, 0.22), flyMat, 24)
  const flyBase = Array.from({ length: flies.count }, () => ({
    x: -11 + flyRand() * 23,
    y: 0.7 + flyRand() * 2.2,
    z: HOUSE.maxZ + 2 + flyRand() * 11,
    p0: flyRand() * Math.PI * 2,
    p1: flyRand() * Math.PI * 2,
    r: 0.6 + flyRand() * 1.7,
    s: 0.35 + flyRand() * 0.5,
  }))
  // seed the instance matrices now: update() only runs while roaming, and
  // 24 quads left at the origin would glow under the desk during the intro
  {
    const seedM = new THREE.Matrix4()
    flyBase.forEach((b, i) => {
      seedM.setPosition(b.x, b.y, b.z)
      flies.setMatrixAt(i, seedM)
    })
  }
  flies.frustumCulled = false
  root.add(flies)
  let flyT = 0

  /* ------------------------------------------------------------- lights -- */

  const addLight = (light: THREE.Light, on: number) => {
    lights.push({ light, on })
    root.add(light)
    return light
  }
  /*
    Six point lights for two storeys and nine rooms, deliberately: every
    one of them is a term in every lit material's program, and adding one
    is a relink of the lot. So they go where a lamp is actually on and
    somebody is likely to be standing, and the rest of the rooms get their
    glow from emissive bulbs and the look's lamp pools, which cost no
    program at all.
  */
  // the ground hall and the foot of the stairs
  const hallLight = addLight(new THREE.PointLight('#ffd9ae', 0, 9.5, 1.8), 8)
  hallLight.position.set(3.6, 5.1, 11.4)
  // the upstairs bathroom
  const bathLight = addLight(new THREE.PointLight('#dce8ff', 0, 8.5, 1.8), 7)
  bathLight.position.set(-5.0, UP + 5.05, 13.55)
  // the living room's floor lamp, beside the sofa
  const floorLampLight = addLight(new THREE.PointLight('#ffc98a', 0, 7, 1.7), 6)
  floorLampLight.position.set(0.75, 2.95, 4.2)
  const porchLight = addLight(new THREE.PointLight('#ffb869', 0, 10, 1.7), 6.5)
  porchLight.position.set(-2.0, 2.85, 25.75) // at the porch lantern's cage
  // the upper hall, which also spills down the stairwell
  const landingLight = addLight(new THREE.PointLight('#ffd9ae', 0, 9, 1.8), 6.5)
  landingLight.position.set(4.4, UP + 5.1, 11.8)
  // the kitchen, under its dome
  const kitchenLight = addLight(new THREE.PointLight('#ffe2b8', 0, 9, 1.8), 6.5)
  kitchenLight.position.set(-4.6, 5.1, 20.6)
  // the doorstep keeps a bulb under its canopy (and a pool on the step at
  // night) rather than a light of its own
  const STEP_BULB = new THREE.Vector3((FRONT_DOOR.u0 + FRONT_DOOR.u1) / 2, DOOR_H + 0.44, HOUSE.minZ - 0.6)
  {
    const mat = new THREE.MeshStandardMaterial({
      color: '#2c1c08', emissive: new THREE.Color('#ffc069'), emissiveIntensity: 0,
    })
    trackDisposable(mat)
    bulbs.push({ mat, on: 3.0 })
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), mat)
    bulb.position.copy(STEP_BULB)
    root.add(bulb)
  }

  const livkPendant = new THREE.SpotLight('#ffd9ae', 0, 0, 1.08, 0.85, 1.5)
  // over the coffee table in the living room: the one house light that
  // casts, because the sofa and the table are where shadows read
  livkPendant.position.set(LIVING_PENDANT.x, 5.4, LIVING_PENDANT.z)
  livkPendant.target.position.set(LIVING_PENDANT.x, 0, LIVING_PENDANT.z)
  livkPendant.castShadow = true
  livkPendant.shadow.mapSize.set(1024, 1024)
  livkPendant.shadow.bias = -0.00005
  livkPendant.shadow.normalBias = 0.03
  livkPendant.shadow.radius = 2
  livkPendant.shadow.blurSamples = 4
  livkPendant.shadow.camera.near = 0.5
  livkPendant.shadow.autoUpdate = false // baked like the bedroom rig
  root.add(livkPendant, livkPendant.target)
  lights.push({ light: livkPendant, on: 62 })
  shadowLights.push(livkPendant)

  // pendant fixtures over the living room and dining table (core lamp model)
  const hangLamp = (x: number, z: number, s: number, y = 0) => {
    const fixture = lamp.scene.clone(true)
    fixture.scale.setScalar(s)
    fixture.position.set(x, y + CEIL_H, z)
    fixture.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      mats.forEach((m, i) => {
        const std = m as THREE.MeshStandardMaterial
        if (std.name === 'Light') {
          const own = std.clone()
          own.emissive = new THREE.Color('#ffe0b0')
          own.emissiveIntensity = 0
          trackDisposable(own)
          if (Array.isArray(mesh.material)) mesh.material[i] = own
          else mesh.material = own
          bulbs.push({ mat: own, on: 3.2 })
        }
      })
    })
    root.add(fixture)
  }
  hangLamp(LIVING_PENDANT.x, LIVING_PENDANT.z, 1.6)
  hangLamp(-2.1, 19.8, 1.35)
  // the master bedroom's, over the foot of the bed
  hangLamp(4.6, 19.4, 1.35, UP)

  /* -------------------------------------------------------- framed art -- */

  const artLoader = new THREE.TextureLoader()
  const frameArt = (
    src: string, w: number, h: number,
    x: number, y: number, z: number, rotY: number,
  ) => {
    const g = new THREE.Group()
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.18, h + 0.18, 0.06), trimMat)
    frame.castShadow = false
    frame.receiveShadow = true
    g.add(frame)
    const matte = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.06, h + 0.06, 0.02),
      new THREE.MeshStandardMaterial({ color: '#d8cfc0', roughness: 0.9 }),
    )
    trackDisposable(matte.material as THREE.Material)
    matte.position.z = 0.026
    matte.castShadow = false
    g.add(matte)
    const artMat = new THREE.MeshStandardMaterial({ color: '#888', roughness: 0.86 })
    trackDisposable(artMat)
    const art = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.14, h - 0.14), artMat)
    art.position.z = 0.041
    g.add(art)
    artLoader.load(src, (t) => {
      t.colorSpace = THREE.SRGBColorSpace
      trackTexture(t)
      trackDisposable(t)
      artMat.map = t
      artMat.color.set('#fff')
      artMat.needsUpdate = true
      art.updateMatrixWorld(true)
    })
    g.position.set(x, y, z)
    g.rotation.y = rotY
    root.add(g)
  }
  // the ground hall's gallery, and the OS wallpaper joke framed above the
  // computer room's bed;
  // the trio sits inside the solid span between the arch casing (~3.52)
  // and the east-wall corner at 7.6 — frames are w+0.18 wide overall
  frameArt('/os/wallpapers/autumn.webp', 1.0, 0.75, 4.2, 3.35, 13.94, Math.PI)
  frameArt('/os/wallpapers/stonehenge.webp', 1.0, 0.75, 5.55, 3.35, 13.94, Math.PI)
  frameArt('/os/wallpapers/azul.webp', 1.0, 0.75, 6.9, 3.35, 13.94, Math.PI)
  frameArt('/os/wallpapers/bliss.webp', 2.2, 1.4, -5.7, UP + 4.5, 10.44, Math.PI)

  /* ----------------------------------------------------------- furnish -- */

  interface Placement {
    box: THREE.Box3
    /** the placed clone, so a caller can go looking for its working parts */
    group: THREE.Group
  }
  const put = (
    gltf: ModelLike | undefined,
    s: number | [number, number, number],
    rotY: number,
    cx: number,
    cz: number,
    o: {
      pad?: number
      /** absolute height of the piece's underside (a clock on a nightstand) */
      y?: number
      /** the storey it stands on, when it stands on a floor */
      floor?: number
      lift?: number
      clone?: boolean
      /** the top of this AABB is not somewhere anyone stands: taller than
          the player (wardrobes, the fridge), or foliage/a lampshade the box
          only approximates. Everything waist-high stays climbable on purpose */
      noStand?: boolean
      /** height of the surface you actually stand on, over this piece's own
          base, where that isn't the top of its bounding box. A sofa's AABB
          top is its backrest and a bed's is its headboard, so landing on one
          left you hovering a metre over the cushion. Measured off the GLBs by
          area of up-facing surface, not eyeballed. */
      top?: number
    } = {},
  ): Placement | null => {
    if (!gltf) return null
    const g = o.clone === false ? gltf.scene : gltf.scene.clone(true)
    if (Array.isArray(s)) g.scale.set(s[0], s[1], s[2])
    else g.scale.setScalar(s)
    g.rotation.y = rotY
    g.updateMatrixWorld(true)
    tmpBox.setFromObject(g)
    const c = tmpBox.getCenter(new THREE.Vector3())
    const y = o.y !== undefined
      ? o.y - tmpBox.min.y
      : (o.floor ?? 0) - tmpBox.min.y + (o.lift ?? 0)
    g.position.set(g.position.x + cx - c.x, g.position.y + y, g.position.z + cz - c.z)
    g.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = false
      }
    })
    root.add(g)
    g.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(g)
    // pad sideways only: the pad is shoulder room, and lifting the top would
    // leave the player hovering over every surface they climb onto
    if (o.pad !== undefined) {
      const solid = padXZ(box.clone(), o.pad)
      // one box can't be solid to the backrest and standable at the cushion,
      // so it becomes the cushion: still far taller than a step, so it blocks
      // a walk exactly as before, but a hop lands where a body would sit
      if (o.top !== undefined) solid.max.y = box.min.y + o.top
      obstacles.push(o.noStand ? noStand(solid) : solid)
    }
    return { box, group: g }
  }

  /*
    The working parts of a placed piece.

    Every leaf is registered against the *carcass* box, which is what tells
    `fittings.ts` which way the piece faces and where its front is, and the
    facing itself is read off the leaves rather than declared: these GLBs
    come from three exporters and disagree about which way a model's front
    is, but all of them put the doors on it.
  */
  const work = (
    piece: Placement | null,
    leaves: Record<string, Omit<FittingSpec, 'node' | 'fx' | 'fz' | 'piece'>>,
  ) => {
    if (!piece) return
    const names = Object.keys(leaves)
    const nodes = names.map((n) => piece.group.getObjectByName(n)).filter(Boolean)
    if (!nodes.length) return
    const f = facingOf(piece.box, nodes as THREE.Object3D[])
    for (const name of names) {
      const node = piece.group.getObjectByName(name)
      if (node) fittings.add({ node, piece: piece.box, ...f, ...leaves[name] })
    }
  }

  /*
    Where the television's picture goes.

    Not the model's UVs and not its bounding box: the tube face is a rounded
    rectangle recessed behind the bezel, and either of those would put the
    picture on the front of the *cabinet*. These are the numbers off tv.glb
    itself (the 'metal' primitive's front plane, which is the only flat
    light-grey face in the model and is exactly the glass), expressed in the
    model's own space and carried into the world by the placed matrix, so
    moving or re-scaling the set moves the picture with it.
  */
  const TUBE = { x0: -0.267, x1: -0.035, y0: 0.034, y1: 0.236, z: 0.0201 }
  const tubeFace = (g: THREE.Group): ScreenPlacement => {
    g.updateWorldMatrix(true, true)
    const at = (x: number, y: number) =>
      new THREE.Vector3(x, y, TUBE.z).applyMatrix4(g.matrixWorld)
    const bl = at(TUBE.x0, TUBE.y0)
    const br = at(TUBE.x1, TUBE.y0)
    const tl = at(TUBE.x0, TUBE.y1)
    const right = br.clone().sub(bl)
    const up = tl.clone().sub(bl)
    return {
      centre: bl.clone().addScaledVector(right, 0.5).addScaledVector(up, 0.5),
      // the model's front is its local -z; anything else and the picture
      // would be pointing into the wall behind the set
      normal: new THREE.Vector3(0, 0, -1).transformDirection(g.matrixWorld).normalize(),
      right: right.clone().normalize(),
      up: up.clone().normalize(),
      width: right.length(),
      height: up.length(),
    }
  }

  /** the two halves of a side-by-side fridge, told apart by width: the
      narrow one is the freezer, whichever way round the model is */
  const fridgeDoors = (piece: Placement | null) => {
    if (!piece) return
    const width = (n: string) => {
      const node = piece.group.getObjectByName(n)
      if (!node) return 0
      const b = new THREE.Box3().setFromObject(node)
      return Math.max(b.max.x - b.min.x, b.max.z - b.min.z)
    }
    const freezer = width('doorLeft') <= width('doorRight') ? 'doorLeft' : 'doorRight'
    const cold = { depth: 1.05, shelves: 3, stock: 9, lit: 1, tint: '#eceae3' }
    work(piece, {
      doorLeft: {
        label: freezer === 'doorLeft' ? 'the freezer' : 'the fridge',
        cavity: { ...cold, seed: 11, stock: freezer === 'doorLeft' ? 5 : 9 },
      },
      doorRight: {
        label: freezer === 'doorRight' ? 'the freezer' : 'the fridge',
        cavity: { ...cold, seed: 29, stock: freezer === 'doorRight' ? 5 : 9 },
      },
    })
  }

  /** clone every mesh of a GLB into instanced meshes at the given transforms */
  const instancedFromGLB = (gltf: ModelLike, placements: THREE.Matrix4[]) => {
    const src = gltf.scene
    src.updateMatrixWorld(true)
    src.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length)
      const m = new THREE.Matrix4()
      placements.forEach((p, i) => im.setMatrixAt(i, m.multiplyMatrices(p, mesh.matrixWorld)))
      im.castShadow = false
      im.receiveShadow = false
      root.add(im)
    })
  }

  let furnished = false

  const furnish = (models: HouseModels) => {
    if (furnished) return
    furnished = true
    const HPI = Math.PI / 2

    /* ------------------------------------------------ ground: living room --
       The television against the back wall, the sofa facing it across the
       coffee table with its back to the picture window, an armchair in the
       front corner angled at the set, the bookcase against the west wall
       past the side window, and the floor lamp at the sofa's end. The same
       set the back room used to hold, turned round to face the other way. */
    const cab = put(models.tvcabinet, 4.4, 0, -2.6, 9.88, { pad: 0.1 })
    work(cab, {
      doorLeft: { label: 'the cabinet', cavity: { depth: 0.8, shelves: 1, tint: '#4a3524' } },
      doorRight: { label: 'the cabinet', cavity: { depth: 0.8, shelves: 1, tint: '#4a3524' } },
    })
    const tv = put(models.tv, 4.4, 0, -2.65, 9.85, { y: cab ? cab.box.max.y : 1.37 })
    if (tv) {
      // little standby LED so the dead tube feels plugged in: on the front
      // of the set, which faces the room (-z)
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, 0.02),
        new THREE.MeshStandardMaterial({
          color: '#3a0d0d', emissive: '#ff3b30', emissiveIntensity: 1.6,
        }),
      )
      trackDisposable(led.material as THREE.Material)
      led.position.set(tv.box.min.x + 0.28, tv.box.min.y + 0.34, tv.box.min.z + 0.04)
      root.add(led)
      screen = tubeFace(tv.group)
    }
    put(models.roundrug, 1.6, 0, -2.6, 7.0, { y: 0.008 })
    const ctable = put(models.coffeetable, 4.4, 0, -2.6, 7.3, { pad: 0.08 })
    if (ctable) put(models.mug, 0.85, 1.2, -2.15, 7.1, { y: ctable.box.max.y })
    const sofa = put(models.sofa, 1.3, 0, -2.6, 4.93, { pad: 0.14, top: 1.0 }) // cushion, not the backrest (1.89)
    if (sofa) {
      // three cushions, two places worth sitting, both facing the television
      // across the coffee table. Standing up puts you behind the sofa, in
      // the strip of floor between it and the picture window
      const cushion = sofa.box.min.y + 1.0
      for (const x of [-3.2, -1.5]) {
        seats.push({
          label: 'the sofa',
          x, z: 5.03,
          cushionY: cushion,
          atTv: true,
          yaw: Math.PI, // the model is turned to face +z, and so is the set
          stand: { x, z: 2.9, y: sofa.box.min.y },
        })
      }
    }
    // the armchair in the street corner, turned toward the set
    const armchair = put(models.loveseat, 0.95, 0.38, -5.9, 1.6, { pad: 0.12, top: 1.24 })
    if (armchair) {
      seats.push({
        label: 'the armchair',
        atTv: true,
        x: -5.9, z: 1.6,
        cushionY: armchair.box.min.y + 1.24,
        yaw: 0.38 + Math.PI,
        stand: { x: -4.4, z: 3.45, y: armchair.box.min.y },
      })
    }
    const bookcase = put(models.bookcase, 1.31, HPI, -7.15, 8.6, { pad: 0.1, noStand: true })
    // the bookcase's lower compartments are modelled, so it needs no cavity
    work(bookcase, {
      BookCase_LeftDoor: { label: 'the bookcase' },
      BookCase_RightDoor: { label: 'the bookcase' },
    })
    put(models.floorlamp, 4.4, 0, 0.75, 4.2, { pad: 0.08, noStand: true })
    put(models.plant, 1.35, 2.6, 1.45, -0.8, { pad: 0.1, noStand: true })
    put(models.curtains, 0.82, HPI, -7.38, 5.75, { y: 0.86 })

    /* ------------------------------------------------ ground: foyer, hall --
       A phone table inside the door, a runner up to the stairs, a plant in
       the corner the door opens away from; the hall's console under its
       three frames */
    put(models.nightstand, 1.3, HPI, 3.15, 1.7, { pad: 0.08 })
    put(models.rug, [0.8, 1, 1.6], 0, 3.8, 5.6, { y: 0.012 })
    put(models.plant, 1.05, 2.2, 6.9, -1.0, { pad: 0.1, noStand: true })
    put(models.rug, [0.8, 1, 2.0], HPI, 2.2, 12.25, { y: 0.012 })
    const console_ = put(models.nightstand, 1.63, -HPI, 5.55, 13.2, { pad: 0.08 })
    if (console_ && models.plant) {
      put(models.plant, 0.62, 0.8, 5.55, 13.2, { y: console_.box.max.y })
    }

    /* ------------------------------------------ ground: half bath, laundry --
       sink by the door, toilet on the far wall, and the washer with the
       dryer stacked on it where the tub used to be (the tub is upstairs) */
    put(models.toilet, 0.94, Math.PI, -4.05, 15.72, { pad: 0.08, top: 0.88 })
    put(models.bathsink, 1.35, 0, -4.55, 11.14, { pad: 0.08, top: 1.64 })
    put(models.towelrack, 1.8, -HPI, -2.62, 14.9, { y: 2.05 })
    put(models.toiletpaper, 1.4, -HPI, -2.6, 15.6, { y: 1.45 })
    const washer = put(models.washer, 4.4, -HPI, -6.66, 14.8, { pad: 0.08 })
    work(washer, {
      washerDoor: { label: 'the washer', cavity: { depth: 0.85, tint: '#8d949a' } },
    })
    if (washer) {
      work(put(models.washer, 4.4, -HPI, -6.66, 14.8, { y: washer.box.max.y }), {
        washerDoor: { label: 'the dryer', cavity: { depth: 0.85, tint: '#8d949a' } },
      })
    }

    /* --------------------------------------------- ground: kitchen, dining --
       the dining table and its chairs, the reading corner in the far east
       corner, and the kitchen run along the west wall */
    put(models.diningtable, 3.6, 0, -2.1, 19.8, { pad: 0.1 })
    // these models face +z unturned, so a sitter faces rotY + π
    for (const [x, z, rotY] of [
      [-2.9, 21.15, Math.PI],
      [-1.25, 21.15, Math.PI + 0.12],
      [-2.05, 18.45, 0.2],
    ] as const) {
      const chair = put(models.chair, 1.25, rotY, x, z, { pad: 0.05, top: 0.96 })
      if (chair) {
        seats.push({
          label: 'the chair',
          x, z,
          cushionY: chair.box.min.y + 0.96,
          yaw: rotY + Math.PI,
          // a dining chair has clear floor behind it, so the default
          // stand-up spot (a step back out of the seat) is the right one
        })
      }
    }
    // reading corner under the yard window
    const reading = put(models.loveseat, 0.95, -HPI + 0.3, 5.0, 22.9, { pad: 0.12, top: 1.24 })
    if (reading) {
      seats.push({
        label: 'the armchair',
        x: 5.0, z: 22.9,
        cushionY: reading.box.min.y + 1.24,
        yaw: -HPI + 0.3 + Math.PI,
        stand: { x: 3.1, z: 22.4, y: reading.box.min.y },
      })
    }
    work(put(models.bookcase, 1.31, -HPI, 7.12, 23.1, { pad: 0.1, noStand: true }), {
      BookCase_LeftDoor: { label: 'the bookcase' },
      BookCase_RightDoor: { label: 'the bookcase' },
    })
    put(models.floorlamp, 4.4, 0, 7.05, 21.2, { pad: 0.08, noStand: true })
    put(models.plant, 1.35, 2.6, -1.7, 15.0, { pad: 0.1, noStand: true })

    /*
      Kitchen run along the west wall, fronts facing +x.

      The run is laid out from the bathroom's south wall northward and it is
      *tight*: four carcasses at the old scale measured 7.96 against the 7.9
      of wall they had to live on, and the difference came out of the fridge,
      which stood a third of a unit inside the bathroom. You could see the
      back of it from the tub, and once its doors worked you could swing one
      through the wall. These walls are single planes with no thickness, so
      "nearly flush" is not a thing here: anything over the line is in the
      next room. The whole run is 4.32 rather than 4.4 and butted end to end,
      which is what a kitchen looks like anyway, and it fits with room over.
    */
    const KIT = 4.32
    const cupboard = { depth: 0.95, shelves: 1, stock: 3, tint: '#cfc9bb' } as const
    fridgeDoors(put(models.kfridge, KIT, -HPI, -6.55, 17.74, { pad: 0.08, noStand: true }))
    work(put(models.kstove, KIT, -HPI, -6.5, 19.8, { pad: 0.08, top: 1.69 }), {
      door: {
        label: 'the oven',
        motion: 'drop',
        cavity: { depth: 1.0, shelves: 2, tint: '#241f1b' },
      },
    })
    // counter, not the tap
    work(put(models.ksink, KIT, -HPI, -6.5, 21.65, { pad: 0.08, top: 1.69 }), {
      door: { label: 'the cupboard', cavity: { ...cupboard, seed: 5 } },
    })
    const kdrawer = put(models.kdrawer, KIT, -HPI, -6.5, 23.51, { pad: 0.08, top: 1.69 })
    work(kdrawer, {
      door: { label: 'the cupboard', cavity: { ...cupboard, seed: 13 } },
      drawer: { label: 'the drawer', motion: 'slide' },
    })
    // one upper over the stove, a low one over the drawer stack; the stretch
    // of wall over the sink stays clear for its window
    work(put(models.kupper, KIT, -HPI, -7.02, 19.8, { y: 3.35 }), {
      door: { label: 'the cabinet', cavity: { depth: 0.7, shelves: 1, stock: 4, tint: '#cfc9bb', seed: 17 } },
    })
    work(put(models.kupperl, KIT, -HPI, -7.05, 23.51, { y: 3.55 }), {
      door: { label: 'the cabinet', cavity: { depth: 0.7, shelves: 1, stock: 3, tint: '#cfc9bb', seed: 23 } },
    })
    if (kdrawer) {
      put(models.toaster, 4.4, -HPI + 0.2, -6.42, 22.95, { y: kdrawer.box.max.y })
      put(models.microwave, 4.4, -HPI, -6.62, 23.95, { y: kdrawer.box.max.y })
    }

    /* --------------------------------------------- upstairs: computer room --
       The desk, its chair and everything dressed round the desk belong to
       deskRoom.ts and CrtScene; this is the rest of the kid's room: the bed
       with its headboard to the hall wall, the nightstand and its clock,
       the wardrobe on the partition, curtains on the west window */
    const bed = put(models.bed, 1.15, Math.PI, -5.72, 8.03, { floor: UP, pad: 0.12, top: 0.92 }) // comforter, not the headboard (1.79)
    if (bed) {
      // perched on the edge, facing the room rather than the wall
      seats.push({
        label: 'the bed',
        x: -4.5, z: 8.03,
        cushionY: bed.box.min.y + 0.92,
        yaw: -HPI,
        stand: { x: -3.1, z: 8.03, y: bed.box.min.y },
      })
    }
    const nstand = put(models.nightstand, 1.63, Math.PI, -3.2, 9.62, { floor: UP, pad: 0.08 })
    if (nstand) {
      put(models.alarmclock, 2.3, Math.PI - 0.3, -3.32, 9.58, { y: nstand.box.max.y })
    }
    const closet = put(models.closet, 1.49, -HPI, 2.62, 1.55, { floor: UP, pad: 0.1, noStand: true })
    work(closet, {
      Closet_LeftDoor: {
        label: 'the wardrobe',
        cavity: { depth: 1.5, shelves: 2, stock: 5, tint: '#6b5744', seed: 3 },
      },
      Closet_RightDoor: {
        label: 'the wardrobe',
        cavity: { depth: 1.5, shelves: 2, stock: 5, tint: '#6b5744', seed: 7 },
      },
    })
    put(models.curtains, 0.82, HPI, -7.38, 5.75, { y: UP + 0.86 })
    put(models.officechair, 2.05, Math.PI - 0.03, -0.15, 3.05, { floor: UP, pad: 0.16, top: 1.0 })

    /* ------------------------------------------------ upstairs: bathroom -- */
    put(models.bathtub, 4.1, HPI, -6.35, 13.55, { floor: UP, pad: 0.08 })
    put(models.toilet, 0.94, Math.PI, -4.05, 15.72, { floor: UP, pad: 0.08, top: 0.88 })
    put(models.bathsink, 1.35, 0, -4.55, 11.14, { floor: UP, pad: 0.08, top: 1.64 })
    put(models.towelrack, 1.8, -HPI, -2.62, 14.9, { y: UP + 2.05 })
    put(models.toiletpaper, 1.4, -HPI, -2.6, 15.6, { y: UP + 1.45 })

    /* ---------------------------------------------- upstairs: the master --
       the bed's headboard against the partition, a nightstand either side,
       the dresser under the back window, the wardrobe on the east wall */
    const mbed = put(models.bed, 1.15, HPI, 2.95, 19.5, { floor: UP, pad: 0.12, top: 0.92 })
    if (mbed) {
      seats.push({
        label: 'the bed',
        x: 3.4, z: 18.5,
        cushionY: mbed.box.min.y + 0.92,
        yaw: 0,
        stand: { x: 3.4, z: 16.8, y: mbed.box.min.y },
      })
    }
    const mstand = put(models.nightstand, 1.63, HPI, 1.25, 16.9, { floor: UP, pad: 0.08 })
    if (mstand) put(models.alarmclock, 2.3, HPI + 0.2, 1.3, 16.9, { y: mstand.box.max.y })
    put(models.nightstand, 1.63, HPI, 1.25, 22.1, { floor: UP, pad: 0.08 })
    put(models.dresser, 1.02, Math.PI, 4.0, 23.77, { floor: UP, pad: 0.1 })
    work(put(models.closet, 1.49, -HPI, 6.9, 15.9, { floor: UP, pad: 0.1, noStand: true }), {
      Closet_LeftDoor: {
        label: 'the wardrobe',
        cavity: { depth: 1.5, shelves: 2, stock: 5, tint: '#6b5744', seed: 31 },
      },
      Closet_RightDoor: {
        label: 'the wardrobe',
        cavity: { depth: 1.5, shelves: 2, stock: 5, tint: '#6b5744', seed: 37 },
      },
    })
    put(models.rug, [1.2, 1, 1.1], HPI, 4.6, 19.5, { y: UP + 0.012 })

    /* ------------------------------------------------- upstairs: the den --
       the second set: a cabinet and a television against the partition,
       a rug, and the old armchair facing it */
    const dcab = put(models.tvcabinet, 4.4, HPI, -0.22, 20.6, { floor: UP, pad: 0.1 })
    if (dcab) put(models.tv, 4.4, HPI, -0.2, 20.6, { y: dcab.box.max.y })
    put(models.roundrug, 1.6, 0, -3.2, 20.6, { y: UP + 0.008 })
    const dchair = put(models.loveseat, 0.95, HPI, -5.6, 20.6, { floor: UP, pad: 0.12, top: 1.24 })
    if (dchair) {
      seats.push({
        label: 'the armchair',
        x: -5.6, z: 20.6,
        cushionY: dchair.box.min.y + 1.24,
        yaw: -HPI,
        stand: { x: -3.9, z: 20.6, y: dchair.box.min.y },
      })
    }

    /* ceiling domes: both baths, both halls, the foyer, the kitchen, the
       linen closet, the den and the garage */
    const dome = (x: number, z: number, s: number, warm: boolean, y = 0) => {
      if (!models.ceilinglight) return
      const fixture = models.ceilinglight.scene.clone(true)
      fixture.scale.setScalar(s)
      fixture.position.set(x, y + CEIL_H, z)
      fixture.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mats.forEach((m, i) => {
          const std = m as THREE.MeshStandardMaterial
          if (std.name === 'Light') {
            const own = std.clone()
            own.emissive = new THREE.Color(warm ? '#ffe0b0' : '#dfe9ff')
            own.emissiveIntensity = 0
            trackDisposable(own)
            if (Array.isArray(mesh.material)) mesh.material[i] = own
            else mesh.material = own
            bulbs.push({ mat: own, on: 2.6 })
          }
        })
      })
      root.add(fixture)
    }
    dome(3.6, 12.2, 0.95, true)
    dome(-5.0, 13.55, 0.9, false)
    dome(-5.0, 13.55, 0.9, false, UP)
    dome(-4.6, 20.6, 0.9, true)
    dome(3.8, 5.0, 0.9, true) // foyer
    dome(4.4, 11.8, 0.9, true, UP) // upper hall
    dome(5.5, 0.2, 0.7, true, UP) // linen closet
    dome(-3.4, 20.6, 0.9, true, UP) // den
    dome(10.3, 6.0, 0.8, true) // garage

    /* yard */
    if (models.fence) {
      models.fence.scene.updateMatrixWorld(true)
      tmpBox.setFromObject(models.fence.scene)
      const modLen = tmpBox.max.x - tmpBox.min.x
      const H = FENCE_H
      const mats: THREE.Matrix4[] = []
      const run = (x0: number, z0: number, x1: number, z1: number) => {
        const len = Math.hypot(x1 - x0, z1 - z0)
        const n = Math.max(1, Math.round(len / (modLen * H)))
        const seg = len / n
        const ang = Math.atan2(z1 - z0, x1 - x0)
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -ang, 0))
          mats.push(new THREE.Matrix4().compose(
            new THREE.Vector3(x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t),
            q,
            new THREE.Vector3((seg / modLen) * 1.0, H, H),
          ))
        }
      }
      for (const [x0, z0, x1, z1] of FENCE_RUNS) run(x0, z0, x1, z1)
      instancedFromGLB(models.fence, mats)
    }
    // the yard's trees are the world's card-canopy kits now, not the CC GLB
    // model — one garden with two art styles of tree read as a seam, and the
    // seam ran along the fence
    const yardTree = (
      variant: number, scale: number, yaw: number, cx: number, cz: number,
    ) => {
      const t = buildKitTree('broadleaf', variant, scale, yaw, variant - 1)
      t.group.position.set(cx, -0.1, cz)
      t.group.updateMatrixWorld(true)
      root.add(t.group)
      for (const g of t.geos) trackDisposable(g)
      if (t.solid) {
        obstacles.push(noStand(new THREE.Box3(
          new THREE.Vector3(cx - t.solid.r, -0.4, cz - t.solid.r),
          new THREE.Vector3(cx + t.solid.r, t.solid.h, cz + t.solid.r),
        )))
      }
    }
    yardTree(0, 0.62, 0.4, -7.5, 33.0)
    yardTree(1, 0.5, 2.1, 10.8, 30.0)
    yardTree(2, 0.55, 0.8, -11.4, 6.5)
    // the shrub GLBs wrap a solid green core in alpha-BLEND leaf cards, and
    // GLTFLoader gives BLEND materials depthWrite:false — so triangle order,
    // not depth, decided what covered what, and the smooth core painted over
    // its own leafy shell as a green box inside every bush. Cutout alpha
    // writes depth and lets the cards occlude the core properly. Patched on
    // the source scene once: put()'s clones share these materials.
    for (const shrub of [models.bush, models.bushflower, models.hedge]) {
      shrub?.scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats as THREE.MeshStandardMaterial[]) {
          if (!m.transparent) continue
          m.transparent = false
          m.depthWrite = true
          m.alphaTest = 0.45
          m.needsUpdate = true
        }
      })
    }
    put(models.bush, 1.35, 0.5, -11.8, 27.5)
    put(models.bush, 1.35, 2.2, 11.5, 36.5)
    put(models.bush, 1.35, 1.1, -11.0, 10.8)
    put(models.bushflower, 1.4, 0, 6.9, 33.6)
    put(models.bushflower, 1.4, 1.9, -10.9, 36.8)
    put(models.hedge, 1.0, 0, -6.5, 25.6, { pad: 0.06, noStand: true })
    put(models.hedge, 1.0, 0, -0.55, 25.6, { pad: 0.06, noStand: true })
    put(models.bench, 1.05, Math.PI * 1.5, 4.8, 34.6, { pad: 0.12, top: 1.0 })
    const lanternGlow = (x: number, z: number, rotY: number, lit: boolean) => {
      const placed = put(models.lantern, 1.0, rotY, x, z, { pad: 0.05, noStand: true })
      if (!placed) return
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 6),
        new THREE.MeshStandardMaterial({
          color: '#2c1c08', emissive: '#ffc069', emissiveIntensity: 0,
        }),
      )
      trackDisposable(bulb.material as THREE.Material)
      bulbs.push({ mat: bulb.material as THREE.MeshStandardMaterial, on: lit ? 3.4 : 2.2 })
      // the cage hangs from the arm, which points toward +z at rot 0
      const arm = new THREE.Vector3(0, 2.62, 1.05).applyEuler(new THREE.Euler(0, rotY, 0))
      bulb.position.set(x + arm.x, arm.y, z + arm.z)
      root.add(bulb)
    }
    lanternGlow(-0.95, 25.75, -Math.PI / 2, true) // arm reaches over the porch
    lanternGlow(6.6, 35.6, Math.PI + 0.6, false)

    // freeze everything that just landed; door pivots stay live, and so do
    // the working furniture's: the freeze is a blanket traverse, so every
    // hinge in the house has to opt back out of it after the fact
    root.updateMatrixWorld(true)
    root.traverse((o) => {
      o.matrixAutoUpdate = false
    })
    doors.forEach((d) => {
      d.pivot.matrixAutoUpdate = true
    })
    fittings.unfreeze()
  }

  /* ------------------------------------------------------------ runtime -- */

  // architecture is static from birth: freeze it, keep the pivots live
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    o.matrixAutoUpdate = false
  })
  doors.forEach((d) => {
    d.pivot.matrixAutoUpdate = true
  })

  const update = (dt: number) => {
    // the working furniture eases on the same clock as the doors. The shadow
    // maps it dirties are re-baked by whoever pressed the key, not from here:
    // this runs inside a Level's update, which has no way to report back
    fittings.update(dt)
    // doors ease toward wherever the interact key last put them
    for (const d of doors) {
      const next = d.angle + (d.target - d.angle) * (1 - Math.exp(-5.5 * dt))
      // a closing leaf seating back into its frame is the audible full stop
      if (d.target === 0 && Math.abs(d.angle) > 0.02 && Math.abs(next) <= 0.02) doorLatch()
      if (Math.abs(next - d.angle) > 0.00012) {
        d.angle = next
        d.pivot.rotation.y = (d.pivot.userData.baseRotY as number) + next
      }
      // the doorway stays solid until the leaf is well out of the way
      const solid = Math.abs(d.angle) < d.swing * 0.45
      if (solid !== d.solid) {
        d.solid = solid
        if (solid) d.block.set(d.closedMin, d.closedMax)
        else {
          d.block.min.set(0, 0, 0)
          d.block.max.set(0, 0, 0)
        }
      }
    }
    // fireflies
    flyT += dt
    for (let i = 0; i < flies.count; i++) {
      const b = flyBase[i]
      flyM.compose(
        tmpVec.set(
          b.x + Math.sin(flyT * b.s + b.p0) * b.r,
          b.y + Math.sin(flyT * b.s * 1.7 + b.p1) * 0.5,
          b.z + Math.cos(flyT * b.s * 0.8 + b.p0) * b.r,
        ),
        flyQ,
        flyS.setScalar(0.7 + 0.3 * Math.sin(flyT * 2.2 + b.p1)),
      )
      flies.setMatrixAt(i, flyM)
    }
    flies.instanceMatrix.needsUpdate = true
  }

  /** the closest door in reach; past arm's length it must be in view too */
  const findDoor = (p: THREE.Vector3, gaze: THREE.Vector3): Door | null => {
    let best: Door | null = null
    let bestD = 6.76 // 2.6 units of reach, squared
    const planarGaze = Math.hypot(gaze.x, gaze.z)
    for (const d of doors) {
      // its own storey only: p is the eye, somewhere between the floor and
      // the ceiling of whichever storey the player is on
      if (p.y < d.y || p.y > d.y + CEIL_H + SLAB) continue
      const dx = d.cx - p.x
      const dz = d.cz - p.z
      const dd = dx * dx + dz * dz
      if (dd >= bestD) continue
      if (dd > 1.44 && planarGaze > 0.001) {
        const facing = (gaze.x * dx + gaze.z * dz) / (Math.sqrt(dd) * planarGaze)
        if (facing < 0.35) continue
      }
      bestD = dd
      best = d
    }
    return best
  }

  const doorPrompt = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    const d = findDoor(p, gaze)
    return d ? (d.target === 0 ? ('open' as const) : ('close' as const)) : null
  }

  const useDoor = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    const d = findDoor(p, gaze)
    if (!d) return false
    if (d.target !== 0) {
      d.target = 0
      doorCreak(false)
    } else {
      // swing toward the far side of the wall from where the player stands;
      // which rotation sign that is depends on the wall axis and hinge side
      const side = (d.axis === 'z' ? p.z : p.x) < d.at ? 1 : -1
      d.target = (d.axis === 'z' ? -d.dir : d.dir) * side * d.swing
      doorCreak(true)
    }
    return true
  }

  /** what a footstep lands on inside the property line: planks within the
      walls (both storeys), concrete in the garage, on the two slabs, the
      front walk and the driveway, grass elsewhere. Bounds mirror the meshes
      poured above, so moving one means moving both. Everything past the
      fence is the open world's answer to give. */
  const FRONT_CX_S = (FRONT_DOOR.u0 + FRONT_DOOR.u1) / 2
  const surfaceAt = (x: number, z: number): StepSurface => {
    if (x > HOUSE.minX && x < HOUSE.maxX && z > HOUSE.minZ && z < HOUSE.maxZ) return 'wood'
    if (x > GARAGE.minX && x < GARAGE.maxX && z > GARAGE.minZ && z < GARAGE.maxZ) return 'stone'
    // back porch slab
    if (x > -5.45 && x < -1.65 && z > HOUSE.maxZ && z < HOUSE.maxZ + 2.85) return 'stone'
    // doorstep and the walk down to the gate
    if (Math.abs(x - FRONT_CX_S) < 1.5 && z < HOUSE.minZ && z > HOUSE.minZ - 1.15) return 'stone'
    if (Math.abs(x - FRONT_CX_S) < 0.8 && z <= HOUSE.minZ - 1.12 && z > YARD.minZ) return 'stone'
    // the driveway
    if (x > DRIVE.x0 && x < DRIVE.x1 && z < GARAGE.minZ && z > YARD.minZ - 0.3) return 'stone'
    return 'grass'
  }

  const setRoamLight = (k: number) => {
    for (const { light, on } of lights) light.intensity = on * k
    for (const { mat, on } of bulbs) mat.emissiveIntensity = on * k
  }

  // daylight puts the fireflies to bed
  const setDay = (day: number) => {
    flyMat.opacity = Math.max(0, 1 - day * 1.6)
  }

  const flagShadows = (p: THREE.Vector3) => {
    // only the living-room pendant is house-owned, and its cone is the
    // living room's: re-bake while anybody moves on the ground floor at the
    // front of the house (through the opening, the foyer is in its reach)
    if (p.y < UP && p.x < STAIR.x0 + 1 && p.z < HALL.maxZ) livkPendant.shadow.needsUpdate = true
  }

  return {
    root, update, doorPrompt, useDoor, surfaceAt,
    setRoamLight, setDay, flagShadows, shadowLights, furnish,
    propPrompt: fittings.prompt,
    useProp: fittings.use,
    addFitting: fittings.add,
    seats,
    get screen() {
      return screen
    },
  }
}
