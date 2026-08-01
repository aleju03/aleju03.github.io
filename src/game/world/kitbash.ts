import * as THREE from 'three'
import type { MeshBuilder } from '../core/geometry'
import type { Solid } from '../physics/collision'
import type { InteriorRect } from './interiors'
import type { ShopDoorSpec } from './shopDoors'
import type { Smashable } from './debris'
import { SURF, type SurfaceId } from './surface'

/*
  The vocabulary every built thing out here is stamped from.

  A chunk's whole built environment arrives as one merged, vertex-coloured
  soup (core/geometry.ts's MeshBuilder), so "building a house" means writing
  transformed copies of a handful of cached unit primitives into that soup.
  This module owns those primitives and the four or five verbs that place
  them, because two very different consumers need exactly the same ones:
  buildings.ts, which fills a town block, and structures.ts, which puts a
  lighthouse on a headland.

  Two rules govern what may live in here.

  Source geometry is cached forever and never disposed. Only the merged
  result a chunk hands back is, so a helper that built a fresh
  CylinderGeometry per call would leak one on every chunk rebuild, forever,
  for as long as the player keeps walking. Anything parameterised is
  therefore quantised and memoised: `taper()` keys its frustums on the radius
  ratio rounded to a 64th, which is finer than a wall you can see the join in.

  And the temporaries are private. Callers do their own vector maths with
  their own scratch objects, because the helpers here write to theirs
  mid-expression, and a shared THREE.Euler read after somebody else's `.set`
  is the kind of bug that shows up as one building in a hundred facing the
  wrong way.
*/

/** what a building kit fills in as it stamps itself into a chunk */
export interface BuildOut {
  /** opaque painted geometry */
  solid: MeshBuilder
  /** window quads, one emissive material, lit at night */
  glass: MeshBuilder
  /** collision, already noStand'd where the top is not a floor */
  boxes: Solid[]
  /** interiors that want a light; kept tiny, the streamer caps how many burn */
  lamps: Array<{ x: number; y: number; z: number }>
  /** walk-in footprints, for the interiors registry and the scatter keep-out */
  interiors: InteriorRect[]
  /** hinged leaves for world/shopDoors.ts; ids are assigned by the chunk */
  doors: ShopDoorSpec[]
  /** props a vehicle can knock down (world/debris.ts). Nothing a *building*
      makes goes in here, a shopfront is not something you drive through, but
      the park trees a block plants instead of housing do */
  smash: Smashable[]
  /**
   * false on the outer ring, where a building is a silhouette on the skyline
   * and nothing more. Window grids are the single most expensive thing the
   * city builds, a downtown block runs to a couple of thousand quads, and at
   * four chunks out not one of them is resolvable. Bodies, roofs and
   * parapets still build, because those are the shape you actually read.
   */
  detailed: boolean
}

/** a footprint to build on: where it is, how big, how tall it wants to be,
    and which way its front faces. `face` is always a cardinal out here (the
    chunk builder points a lot at the nearest street, and streets run along
    the chunk lattice), which is what lets a kit resolve its own frame into
    integers and register axis-aligned collision without trigonometry. */
export interface Lot {
  /** centre of the footprint */
  x: number
  z: number
  w: number
  d: number
  /** ground the building stands on: lowest corner of the footprint */
  baseY: number
  /** ...and the highest, so an interior can grade its floor above the dirt */
  topY: number
  /** how tall it wants to be */
  height: number
  /** which way the front faces: yaw in radians, 0 = facing +z */
  face: number
  rng: () => number
}

/**
 * A lot's own frame, resolved into integers. `u` runs along the frontage and
 * `v` out toward the street, so a kit is written once in plan view and the
 * four cardinal facings fall out of two sign flips. Reading a wall's distance
 * off `lot.d` while the front pointed down x is the bug this exists to make
 * unwritable: it once left a mid-rise entrance hanging a metre clear of the
 * brickwork on every lot whose width and depth rolled differently.
 */
export interface Frame {
  /** unit forward normal, out of the front wall */
  fx: number
  fz: number
  /** unit vector along the frontage, to the right of somebody facing out */
  rx: number
  rz: number
  /** half the frontage, and half the depth */
  hu: number
  hv: number
  /** world x/z of the local point (u along the frontage, v toward the street) */
  x: (u: number, v: number) => number
  z: (u: number, v: number) => number
  /** the world x/z extents of a local (lu along, lv deep) footprint */
  ex: (lu: number, lv: number) => number
  ez: (lu: number, lv: number) => number
}

export const frameOf = (lot: Lot): Frame => {
  const fx = Math.round(Math.sin(lot.face))
  const fz = Math.round(Math.cos(lot.face))
  const rx = fz
  const rz = -fx
  const side = fx !== 0
  return {
    fx, fz, rx, rz,
    hu: (side ? lot.d : lot.w) / 2,
    hv: (side ? lot.w : lot.d) / 2,
    x: (u, v) => lot.x + rx * u + fx * v,
    z: (u, v) => lot.z + rz * u + fz * v,
    ex: (lu, lv) => (side ? lv : lu),
    ez: (lu, lv) => (side ? lu : lv),
  }
}

/* ------------------------------------------------------------- the paint -- */

// warm renders, sages, dusty blues, terracottas: a street stops reading as
// one house photocopied when the palette has actual hue in it, not six greys
export const BODY = [
  '#6f6a5f', '#7b6f60', '#665f57', '#7a7268', '#5f6a6c', '#836f5c',
  '#8a6f52', '#75806a', '#697a85', '#93826b', '#7d666a', '#a08a67',
]
/** the paler end of the same idea, for anything rendered rather than built:
    a villa, a chapel, a lighthouse keeper's cottage */
export const LIME = ['#c9c0ae', '#d4cdbd', '#bfb8a8', '#cfc4ad', '#c2bcb2']
export const ROOFS = ['#43392f', '#3a3f41', '#4a3c33', '#38342e', '#59362e', '#3c4a42']
export const TOWER = ['#5a626b', '#4e555d', '#646a70', '#565e63', '#6a6f74']
/** window and door joinery */
export const TRIM = '#d8d2c4'
/** what unlit window glass reads as by day: sky in a dark room */
export const GLASS_DARK = '#2e3a44'
/** and what a lit one reads as after dusk */
export const GLASS_LIT = '#ffd9a0'

/** pick from a palette with one roll */
export const pick = <T>(list: T[], r: number) => list[Math.min(list.length - 1, Math.floor(r * list.length))]

/* ------------------------------------------------------- unit primitives -- */

export const BOX = new THREE.BoxGeometry(1, 1, 1)
export const PLANE = new THREE.PlaneGeometry(1, 1)

/** a four-sided pyramid, base at y=-0.5, apex at y=+0.5, corners squared up
    with the axes so it caps a rectangular plan */
export const CONE4 = new THREE.ConeGeometry(0.707, 1, 4)
CONE4.rotateY(Math.PI / 4)

/** a round spire: twelve sides is enough at the distance a roof cone is read
    from, and the flat shading gives it facets rather than a smooth taper */
export const CONE12 = new THREE.ConeGeometry(0.5, 1, 12)

/** a unit cylinder, radius 0.5, height 1, centred. Twelve sides for anything
    you walk up to (a lighthouse, a silo), eight for the rest */
export const CYL12 = new THREE.CylinderGeometry(0.5, 0.5, 1, 12)
export const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8)
/** ...and the same with no end caps, for a ring stacked on other rings */
export const TUBE12 = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, true)
/** and a hemisphere for a silo cap or a tank crown */
export const DOME = new THREE.SphereGeometry(0.5, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2)
export const BALL = new THREE.SphereGeometry(0.5, 10, 7)

/*
  The roof shapes. Every one of them puts its eaves at y=0 and its highest
  point at y=1, spans -0.5..0.5 in both ground axes, and carries no floor, so
  a caller scales by (width, rise, depth) and positions the eave line. Faces
  are built one at a time with their own normals rather than welded, because
  a roof plane that shades flat is most of what stops a suburb reading as one
  house photocopied down the street.
*/

const faceted = (build: (face: (pts: number[][]) => void) => void) => {
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const n = new THREE.Vector3()
  const face = (pts: number[][]) => {
    const base = pos.length / 3
    a.set(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2])
    b.set(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2])
    n.copy(a).cross(b).normalize()
    for (const p of pts) {
      pos.push(p[0], p[1], p[2])
      nor.push(n.x, n.y, n.z)
    }
    for (let i = 2; i < pts.length; i++) idx.push(base, base + i - 1, base + i)
  }
  build(face)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  g.setIndex(idx)
  return g
}

/** a gable prism: two slopes meeting at a ridge running along x, triangular
    ends capped */
export const PRISM = faceted((face) => {
  face([[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 1, 0]])
  face([[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0]])
  face([[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0]])
  face([[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0]])
})

/**
 * A hipped roof: the same ridge along x, but shortened to the middle half so
 * all four sides slope. It is the one silhouette a pyramid cannot give a
 * rectangular plan, and a street with both on it stops reading as a kit.
 */
export const HIP = faceted((face) => {
  const r = 0.24
  face([[-0.5, 0, 0.5], [0.5, 0, 0.5], [r, 1, 0], [-r, 1, 0]])
  face([[0.5, 0, -0.5], [-0.5, 0, -0.5], [-r, 1, 0], [r, 1, 0]])
  face([[0.5, 0, 0.5], [0.5, 0, -0.5], [r, 1, 0]])
  face([[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-r, 1, 0]])
})

/**
 * A gambrel: steep lower slopes, shallow upper ones, the barn roof. Its
 * profile is the whole reason a farmstead reads as a farmstead from a
 * kilometre away rather than as a shed with a red wall.
 */
export const GAMBREL = faceted((face) => {
  const bz = 0.3
  const by = 0.62
  face([[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, by, bz], [-0.5, by, bz]])
  face([[-0.5, by, bz], [0.5, by, bz], [0.5, 1, 0], [-0.5, 1, 0]])
  face([[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, by, -bz], [0.5, by, -bz]])
  face([[0.5, by, -bz], [-0.5, by, -bz], [-0.5, 1, 0], [0.5, 1, 0]])
  face([[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, by, -bz], [0.5, 1, 0], [0.5, by, bz]])
  face([[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, by, bz], [-0.5, 1, 0], [-0.5, by, -bz]])
})

/** a monopitch: eaves low at -z, ridge high at +z, with the tall wall at +z
    closed off. Lean-tos, carports, sheds, and the near-flat roofs a modern
    house wears */
export const SHED = faceted((face) => {
  face([[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5]])
  face([[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]])
  face([[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0.5]])
  face([[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5]])
})

/**
 * A barrel vault: a half cylinder lying along x, springing from y=0, its
 * semicircular ends capped and its underside left open because whatever it
 * roofs always closes it. Warehouses and hangars. Scaled to the same
 * eaves-at-0, crown-at-1 convention as the other roofs, which three's own
 * applyMatrix4 fixes the normals for.
 */
export const BARREL = (() => {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 14, 1, false, 0, Math.PI)
  g.rotateZ(Math.PI / 2)
  g.scale(1, 2, 1)
  return g
})()

/* ------------------------------------------------------- tapered barrels -- */

/*
  A lighthouse, a silo, a windmill and a water tower are all the same shape:
  a circular shaft whose top is narrower than its bottom. Three has no unit
  frustum, and building one per call would leak a geometry per chunk rebuild,
  so they are cached by their radius ratio quantised to a 64th, which is far
  finer than the join between two courses of masonry could ever show.
*/
const taperCache = new Map<number, THREE.CylinderGeometry>()

/** a unit frustum: bottom radius 0.5, top radius 0.5 * k, height 1, centred */
export const taper = (k: number, sides = 12) => {
  const q = Math.max(0, Math.min(128, Math.round(k * 64)))
  const key = q * 64 + sides
  let g = taperCache.get(key)
  if (!g) {
    g = new THREE.CylinderGeometry((q / 64) * 0.5, 0.5, 1, sides)
    taperCache.set(key, g)
  }
  return g
}

/* ----------------------------------------------------------------- verbs -- */

const m4 = new THREE.Matrix4()
const q4 = new THREE.Quaternion()
const e3 = new THREE.Euler()
const p3 = new THREE.Vector3()
const s3 = new THREE.Vector3()
const c3 = new THREE.Color()

/**
 * The general stamp: any cached geometry, placed by position, a YXZ euler and
 * a scale, painted flat and tagged with the procedural surface treatment
 * world/surface.ts should give it. Every other verb in this file is a
 * shorthand for one call to this.
 */
export const put = (
  out: MeshBuilder,
  geo: THREE.BufferGeometry,
  hex: string,
  px: number, py: number, pz: number,
  rx: number, ry: number, rz: number,
  sx: number, sy: number, sz: number,
  surf: SurfaceId = SURF.none,
) => {
  e3.set(rx, ry, rz, 'YXZ')
  q4.setFromEuler(e3)
  m4.compose(p3.set(px, py, pz), q4, s3.set(sx, sy, sz))
  out.surface = surf
  out.add(geo, m4, c3.set(hex))
  out.surface = SURF.none
}

/** an axis-aligned box in world space, painted flat. `surf` picks which
    procedural treatment world/surface.ts gives it: that one float per stamp
    is the whole reason a wall out here is brickwork rather than a rectangle */
export const box = (
  out: MeshBuilder, hex: string,
  cx: number, cy: number, cz: number,
  w: number, h: number, d: number,
  yaw = 0, surf: SurfaceId = SURF.plaster,
) => put(out, BOX, hex, cx, cy, cz, 0, yaw, 0, w, h, d, surf)

/** a wall-hugging quad, used for windows, doors and signs */
export const panel = (
  out: MeshBuilder, hex: string,
  cx: number, cy: number, cz: number,
  w: number, h: number, yaw: number, surf: SurfaceId = SURF.none,
) => put(out, PLANE, hex, cx, cy, cz, 0, yaw, 0, w, h, 1, surf)

/**
 * A round shaft standing on its base: `r0` at the bottom, `r1` at the top
 * (defaulting to a straight cylinder), `h` tall, with `cy` naming the
 * *bottom* rather than the centre, because every caller of this is stacking
 * courses up from a foundation and would otherwise add h/2 by hand each time.
 */
export const shaft = (
  out: MeshBuilder, hex: string,
  cx: number, cy: number, cz: number,
  r0: number, h: number, r1 = r0, sides = 12,
  yaw = 0, surf: SurfaceId = SURF.none,
) => put(out, taper(r1 / r0, sides), hex, cx, cy + h / 2, cz, 0, yaw, 0,
  r0 * 2, h, r0 * 2, surf)

/** a beam between two points in space, of square section `t`. Guy wires,
    braces, splayed legs, a fallen mast: anything whose two ends are known and
    whose angle is not. */
export const strut = (
  out: MeshBuilder, hex: string,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  t: number, surf: SurfaceId = SURF.none,
) => {
  const dx = x1 - x0
  const dy = y1 - y0
  const dz = z1 - z0
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-4) return
  // a box's long axis is y, so yaw the strut onto the xz bearing of the run
  // and pitch it down from vertical by the angle the run makes with up
  const yaw = Math.atan2(dx, dz)
  const pitch = Math.acos(Math.max(-1, Math.min(1, dy / len)))
  put(out, BOX, hex, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
    pitch, yaw, 0, t, len, t, surf)
}

/* ------------------------------------------------------------- collision -- */

/** an axis-aligned collision box from a centre and half-extents. Callers hand
    it to `noStand()` themselves where the top of the box is thin air. */
export const aabb = (
  cx: number, y0: number, cz: number, hx: number, y1: number, hz: number,
): Solid =>
  new THREE.Box3(
    new THREE.Vector3(cx - hx, y0, cz - hz),
    new THREE.Vector3(cx + hx, y1, cz + hz),
  )
