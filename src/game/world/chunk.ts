import * as THREE from 'three'
import { createMeshBuilder, type MeshBuilder } from '../core/geometry'
import { seeded } from '../core/rand'
import { noStand, type Solid } from '../physics/collision'
import { hash2, mix, rand3 } from './noise'
import {
  CHUNK, GRID, OFF_X, OFF_Z, RESERVED, inReserved, inYard, originX, originZ,
} from './grid'
import { SEA_Y, latticeGround, latticeHeight, terrainY } from './terrain'
import {
  placeAt, roadAt, pavedAt, buildingHeightAt, blockInset, ROAD_HALF, WALK_W, CURB_H,
} from './settlements'
import { BIOMES, type BiomeId, type PropKind } from './biomes'
import {
  SNAP, VARIANTS, kitsFor, stampKit, variantFor, type Kit, type Palette,
} from './props'
import { SURF } from './surface'
import {
  BLOCK_KIND_FOR, BLOCK_KIND_RATE, KIND_FOR, chapel, midriseBlock, mixedUse,
  parkingDeck, roundTower, shopFront, slabTower, tower, warehouse,
  type BuildKind, type BuildOut, type Lot,
} from './buildings'
import { suburbHouse } from './houses'
import { landmarkIn } from './landmarks'
import { buildLandmark } from './structures'
import { bakeBirth, PREBORN } from './fade'
import type { InteriorRect } from './interiors'
import type { ShopDoorSpec } from './shopDoors'
import type { SmashLayer, Smashable, SmashSet, Span } from './debris'

/*
  One 64-unit block of world, built from nothing but its own coordinates.

  A chunk is assembled in six passes — ground, water, streets, buildings,
  landmarks, scatter — and every one of them is a pure function of (cx, cz),
  so a chunk rebuilt an hour later from the other side of the map is identical
  to the bit. That is the property that lets the streamer throw chunks away the
  moment they leave the ring instead of keeping a world in memory.

  The buildings pass is a town's business and stops at the town limit
  (settlements.ts decides where that is). The landmarks pass is the opposite:
  it only ever fires outside one, and it is what stops the ninety-odd percent
  of the world that is countryside from being landform and trees and nothing
  else. world/landmarks.ts sites them, world/structures.ts builds them.

  Everything static merges into three geometries: ground (its own material,
  because it is the only thing that wants a tiling detail map), opaque detail
  (trees, kerbs, walls, roofs — one draw), and glass (every lit window and
  bulb in the block, one emissive draw that the day cycle fades). A dense
  forest block is therefore three draw calls, not two hundred.

  Level of detail is by ring, and it is about props rather than ground: the
  terrain mesh is only 289 vertices, so every chunk in the ring gets a full
  one and no seam or T-junction can ever open. What thins out with distance is
  cover (grass, reeds — invisible past a fog length anyway), then flora, and
  collision boxes are generated for every chunk that has flora but only handed
  to the collision set for the nine around the player.

  The property at the origin is a hole in all of it: the ground mesh skips its
  quads and nothing scatters or builds inside it, because the house, its lawn
  and its fence were authored by hand and this module is not allowed an
  opinion about them.
*/

export type Tier = 'full' | 'flora' | 'bare'

export interface ChunkMats {
  ground: THREE.Material
  detail: THREE.Material
  glass: THREE.Material
  water: THREE.Material
  /** foliage cards: alpha-tested painted leaf texture, UV-carrying builder */
  leaf: THREE.Material
  /** the cards' shadow-pass material, honouring the same alpha test */
  leafDepth: THREE.Material
}

export interface Chunk {
  cx: number
  cz: number
  tier: Tier
  group: THREE.Group
  /** everything this chunk owns and must dispose */
  geos: THREE.BufferGeometry[]
  /** solids, whether or not they are currently in the live collision set */
  boxes: Solid[]
  /** interior lamp spots the streamer may choose to light */
  lamps: Array<{ x: number; y: number; z: number }>
  /** walk-in footprints for the interiors registry (see world/interiors.ts) */
  interiors: InteriorRect[]
  /** hinged shop-door leaves the near ring should animate (world/shopDoors.ts) */
  doors: ShopDoorSpec[]
  /** the props a vehicle can knock out of this chunk, and where their
      vertices sit in its merged meshes (world/debris.ts) */
  smash: SmashSet
}

/**
 * The span a stamp just occupied in a builder, measured either side of it —
 * the whole trick behind breaking one prop out of a merged chunk. A stamp is
 * a run of consecutive `add` calls into one builder, so its vertices and its
 * indices are both contiguous, and two counters read before and after are the
 * only bookkeeping the chunk has to keep.
 */
const spanFrom = (b: MeshBuilder, v0: number, i0: number): Span | undefined =>
  b.count > v0 ? [v0, b.count - v0, i0, b.indexCount - i0] : undefined

/** ...and the same for a stamp that went into two builders at once (a tree:
    trunk into the soup, foliage cards into the UV-carrying one) */
const spansFrom = (
  parts: Array<[SmashLayer, MeshBuilder, number, number]>,
): Smashable['spans'] => {
  const out: Smashable['spans'] = {}
  for (const [layer, b, v0, i0] of parts) {
    const s = spanFrom(b, v0, i0)
    if (s) out[layer] = s
  }
  return out
}

const VERTS = CHUNK / GRID + 1 // 17

const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpP = new THREE.Vector3()
const tmpS = new THREE.Vector3()
const BOX = new THREE.BoxGeometry(1, 1, 1)
/** unit hex posts, height 1 centred on the origin: the tapered one is the
    streetlight's mast, the parallel and open-ended one the segments of its arm
    (their ends are buried in each other). Six sides is all a 0.25-wide pole
    needs to stop reading as a plank when you walk past it. */
const POST = new THREE.CylinderGeometry(0.38, 0.5, 1, 6)
const TUBE = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true)

/** how tall the mast stands; the arm crosses over it a little higher */
const LAMP_H = 6.1
const lampM = new THREE.Matrix4()
const lampRoot = new THREE.Matrix4()

/**
 * One streetlight: a tapered mast on a plinth, a gooseneck arm and a cobra
 * head whose lens goes into the glass builder, so it lights with the windows
 * at dusk.
 *
 * It is built in local space — mast on the origin, arm reaching +x — and the
 * whole thing yawed onto the kerb, which is what keeps every piece welded to
 * the one before it. The first cut was three axis-aligned boxes offset by
 * hand, and every offset forgot that a box's position is its *centre*, so the
 * arm started 0.28 clear of the mast and the lamp 0.13 past the end of the
 * arm: a streetlight was three separate objects floating in a line.
 *
 * The arm is five samples of a quadratic Bezier from (0, H-0.25) through
 * (0, H+0.55) to (REACH, H+0.55). Both control legs are axis-aligned, so the
 * curve leaves the mast dead vertical and arrives dead level over the road —
 * no seam at either joint, whatever the segment count.
 */
const streetLamp = (
  out: MeshBuilder, glass: MeshBuilder, poleC: THREE.Color, bulbC: THREE.Color,
  x: number, y: number, z: number, yaw: number,
) => {
  lampRoot.compose(tmpP.set(x, y, z), tmpQ.setFromEuler(tmpE.set(0, yaw, 0)), tmpS.set(1, 1, 1))
  /** a piece in the lamp's own plane: `roll` tilts it about z, out of vertical */
  const part = (
    target: MeshBuilder, geo: THREE.BufferGeometry, hex: THREE.Color,
    px: number, py: number, sx: number, sy: number, sz: number, roll = 0,
  ) => {
    lampM.compose(
      tmpP.set(px, py, 0), tmpQ.setFromEuler(tmpE.set(0, 0, roll)), tmpS.set(sx, sy, sz),
    )
    target.add(geo, lampM.premultiply(lampRoot), hex)
  }

  const H = LAMP_H
  /** how far over the road the head hangs, from a mast on the far pavement */
  const REACH = 2.0
  part(out, POST, poleC, 0, 0.24, 0.46, 0.48, 0.46)
  part(out, POST, poleC, 0, H / 2 + 0.2, 0.25, H - 0.4, 0.25)

  let px = 0
  let py = H - 0.25
  for (let i = 1; i <= 5; i++) {
    const t = i / 5
    const u = 1 - t
    const qx = t * t * REACH
    const qy = u * u * (H - 0.25) + 2 * u * t * (H + 0.55) + t * t * (H + 0.55)
    const dx = qx - px
    const dy = qy - py
    const len = Math.hypot(dx, dy)
    // a tube's long axis is y, so the roll that lays it along the segment is
    // measured from straight up: rolling by t sends +y to (-sin t, cos t)
    part(out, TUBE, poleC, px + dx / 2, py + dy / 2,
      0.17, len + 0.06, 0.17, Math.atan2(-dx, dy))
    px = qx
    py = qy
  }

  // the housing swallows the end of the arm, and the lens hangs a finger's
  // width below it — the only part of the lamp that is meant to be seen lit
  const tilt = -0.09
  part(out, BOX, poleC, REACH + 0.16, py - 0.06, 1.0, 0.3, 0.44, tilt)
  part(glass, BOX, bulbC, REACH + 0.2, py - 0.22, 0.72, 0.1, 0.32, tilt)
}

/* ---------------------------------------------------------------- ground */

interface Ground {
  geo: THREE.BufferGeometry | null
  /** heights at the chunk's lattice, row-major, VERTS x VERTS */
  h: Float32Array
  /** biome per lattice point, same layout */
  biome: BiomeId[]
  /** does any of it sit under the waterline */
  wet: boolean
}

/**
 * The terrain mesh. Vertices come from terrain.ts's shared lattice, so the
 * edge a chunk shares with its neighbour is computed from the same cached
 * numbers and the two can never disagree by a float.
 */
const buildGround = (cx: number, cz: number): Ground => {
  // lattice index of this chunk's minimum corner. Chunk origins are whole
  // multiples of GRID from the lattice origin by construction (CHUNK is 16
  // cells), which is what lets neighbours share an edge exactly
  const baseI = (cx * CHUNK) / GRID
  const baseJ = (cz * CHUNK) / GRID

  const n = VERTS * VERTS
  const h = new Float32Array(n)
  const biome: BiomeId[] = new Array(n)
  const pos = new Float32Array(n * 3)
  const nor = new Float32Array(n * 3)
  const colArr = new Float32Array(n * 3)
  const uv = new Float32Array(n * 2)
  let wet = false

  for (let j = 0; j < VERTS; j++)
    for (let i = 0; i < VERTS; i++) {
      const y = latticeHeight(baseI + i, baseJ + j)
      h[j * VERTS + i] = y
      if (y < SEA_Y + 0.15) wet = true
    }

  for (let j = 0; j < VERTS; j++)
    for (let i = 0; i < VERTS; i++) {
      const k = j * VERTS + i
      const wx = originX(cx) + i * GRID
      const wz = originZ(cz) + j * GRID
      const y = h[k]
      pos[k * 3] = wx
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = wz
      // central differences off the lattice, reaching into the neighbouring
      // chunk at the edges so normals match across the seam
      const hx0 = i > 0 ? h[k - 1] : latticeHeight(baseI - 1, baseJ + j)
      const hx1 = i < VERTS - 1 ? h[k + 1] : latticeHeight(baseI + VERTS, baseJ + j)
      const hz0 = j > 0 ? h[k - VERTS] : latticeHeight(baseI + i, baseJ - 1)
      const hz1 = j < VERTS - 1 ? h[k + VERTS] : latticeHeight(baseI + i, baseJ + VERTS)
      tmpP.set(-(hx1 - hx0) / (2 * GRID), 1, -(hz1 - hz0) / (2 * GRID)).normalize()
      nor[k * 3] = tmpP.x
      nor[k * 3 + 1] = tmpP.y
      nor[k * 3 + 2] = tmpP.z
      // colour and biome come from the shared lattice sample — the same one
      // the grass field interpolates, which is the whole contract: a blade
      // and the soil it grows from can only match if they are literally the
      // same number. The paved fade, urban tint and straw drifts all live in
      // latticeGround now.
      const g = latticeGround(baseI + i, baseJ + j)
      biome[k] = g.biome
      colArr[k * 3] = g.r
      colArr[k * 3 + 1] = g.g
      colArr[k * 3 + 2] = g.b
      uv[k * 2] = wx / 9
      uv[k * 2 + 1] = wz / 9
    }

  // indices, skipping the quads that fall on the authored property
  const idx: number[] = []
  for (let j = 0; j < VERTS - 1; j++)
    for (let i = 0; i < VERTS - 1; i++) {
      const mx = originX(cx) + (i + 0.5) * GRID
      const mz = originZ(cz) + (j + 0.5) * GRID
      if (inReserved(mx, mz)) continue
      const a = j * VERTS + i
      const b = a + 1
      const c = a + VERTS
      const d = c + 1
      // the diagonal terrain.ts's terrainY interpolates along: a -> d
      idx.push(a, c, d, a, d, b)
    }
  if (!idx.length) return { geo: null, h, biome, wet }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  return { geo, h, biome, wet }
}

/* ---------------------------------------------------------------- roads */

const rq0 = new THREE.Vector3()
const rq1 = new THREE.Vector3()
const rq2 = new THREE.Vector3()
const rq3 = new THREE.Vector3()

/**
 * The two street borders this chunk is responsible for: the one along its
 * minimum x and the one along its minimum z. Each border is owned by exactly
 * one of the chunks that touches it, which is what keeps two chunks from
 * laying the same asphalt twice and z-fighting over it. The north-south strip
 * yields the crossroads square to the east-west one for the same reason.
 *
 * The deck is a quad strip that samples the terrain at its own corners rather
 * than a row of flat boxes, and that is the whole difference between a road
 * and a road with teeth. A box is level; the ground under it is a lattice
 * interpolated linearly between vertices four units apart, so on any road that
 * follows a hill lengthways the terrain crossed the slab somewhere in the
 * middle of every segment and a zigzag of grass triangles came up through the
 * asphalt. Following the same lattice the terrain does removes the failure
 * mode instead of tuning it, and costs a fifth of the vertices the boxes did.
 */
const buildRoads = (
  cx: number, cz: number, out: MeshBuilder, glass: MeshBuilder, detailed: boolean,
  smash: Smashable[],
): Solid[] => {
  const ox = originX(cx)
  const oz = originZ(cz)
  const asphaltC = new THREE.Color('#2b2d31')
  const walkC = new THREE.Color('#6b6b64')
  const curbC = new THREE.Color('#7a786f')
  const lineC = new THREE.Color('#a89a6b')
  const poleC = new THREE.Color('#22262a')
  const bulbC = new THREE.Color('#ffd9a0')
  /** how far the deck floats over the ground it copies. Enough to beat depth
      precision at the far end of the ring, small enough to never show a lip */
  const LIFT = 0.05
  /** the lamp posts, handed back so the caller can register them *after* it
      has taken its building-footprint snapshot: a mast is solid enough to walk
      into, but it is not a footprint the scatterer should clear three units of
      grass around */
  const poles: Solid[] = []

  /** is the street arm reaching away from junction node (nx, nz) along
      `axis` in direction `sgn` actually paved just past the node? Probed a
      step along the arm's own centreline — far enough out that the crossing
      street can't claim the asphalt bit for it. With segments dropping out of
      the lattice, the four arms of a node answer independently now. */
  const armAlive = (axis: 'x' | 'z', nx: number, nz: number, sgn: number) => {
    const px = axis === 'x' ? nx + sgn * (ROAD_HALF + 1.5) : nx
    const pz = axis === 'x' ? nz : nz + sgn * (ROAD_HALF + 1.5)
    return roadAt(px, pz, placeAt(px, pz)).asphalt
  }

  /** one street between two junction nodes, `along` = the axis it runs down.
      The span passed in is node centre to node centre; how far the deck
      actually reaches at each end depends on who else is alive at the node —
      the crossroads square goes to the east-west street when there is one,
      and a street whose continuation dropped out squares off its own end. */
  const strip = (along: 'x' | 'z', line: number, n0: number, n1: number) => {
    const mid = (n0 + n1) / 2
    const probe = along === 'x' ? { x: mid, z: line } : { x: line, z: mid }
    const place = placeAt(probe.x, probe.z)
    const road = roadAt(probe.x, probe.z, place)
    if (!road.asphalt || road.grade < 0.35) return
    let from = n0
    let to = n1
    if (along === 'x') {
      // this east-west strip owns its junction squares — but only where its
      // western/eastern continuations exist to paint their halves; a dead
      // arm's half of the square is annexed so a through road never shows a
      // bitten corner at a junction it sails past
      if (!armAlive('x', n0, line, -1)) from = n0 - ROAD_HALF
      if (!armAlive('x', n1, line, 1)) to = n1 + ROAD_HALF
    } else {
      // the north-south strip yields the square to the east-west pair when
      // either of them survives; when both dropped, it paints the square
      // itself and the road runs straight through
      if (armAlive('x', line, n0, 1) || armAlive('x', line, n0, -1)) from = n0 + ROAD_HALF
    }
    const steps = Math.ceil((to - from) / GRID)
    const seg = (to - from) / steps

    // where a live perpendicular street crosses, its asphalt owns the ground:
    // pavement, kerbs, dashes and lamps all stop at its edge. Without this
    // every junction wore a raised sidewalk bar straight across the mouth of
    // the crossing road, kerb face and all. Either side of the crossing may
    // be the live one, so both are asked.
    const off = along === 'x' ? OFF_X : OFF_Z
    const j0 = Math.round((n0 - off) / CHUNK) * CHUNK + off
    const blocked: Array<[number, number]> = []
    for (const jl of [j0, j0 + CHUNK]) {
      for (const sgn of [1, -1]) {
        const px = along === 'x' ? jl : line + sgn * (ROAD_HALF + WALK_W + 1.4)
        const pz = along === 'x' ? line + sgn * (ROAD_HALF + WALK_W + 1.4) : jl
        const pRoad = roadAt(px, pz, placeAt(px, pz))
        if (pRoad.asphalt) {
          blocked.push([jl - ROAD_HALF, jl + ROAD_HALF])
          break
        }
      }
    }
    /** [a, b] minus every blocked interval */
    const clip = (a: number, b: number): Array<[number, number]> => {
      let list: Array<[number, number]> = [[a, b]]
      for (const [b0, b1] of blocked) {
        const next: Array<[number, number]> = []
        for (const [s0, s1] of list) {
          if (s1 <= b0 || s0 >= b1) {
            next.push([s0, s1])
            continue
          }
          if (s0 < b0) next.push([s0, b0])
          if (s1 > b1) next.push([b1, s1])
        }
        list = next
      }
      return list
    }
    const inBlocked = (s: number, pad: number) =>
      blocked.some(([b0, b1]) => s > b0 - pad && s < b1 + pad)

    /** a point in road space: `s` along the centreline, `off` across it */
    const at = (s: number, off: number, lift: number, v: THREE.Vector3) => {
      const px = along === 'x' ? s : line + off
      const pz = along === 'x' ? line + off : s
      return v.set(px, terrainY(px, pz) + lift, pz)
    }
    /**
     * `a` to `b`, cut wherever `origin + k * GRID` falls strictly between
     * them, ordered from a to b.
     *
     * The deck does not sit on the ground, it *copies* it: flat panels
     * re-sampling terrainY at their corners, floated LIFT over it. A panel
     * that spans a crease in the mesh it is copying is a chord across that
     * crease, and wherever the crease is convex the ground comes up through
     * the asphalt. It did, on 2% of every deck out here, worst case 0.83 units
     * proud — a green wedge lying across the tarmac.
     *
     * The ground creases on three families of lines, and a panel has to be cut
     * on all three. Two are the lattice axes, which is what this does: a
     * centreline always lands on one and the deck used to span the full
     * 6.4-unit width in a single quad, so the crease ran down the middle of
     * the road, and `strip` annexes junction squares by shifting from/to a
     * ROAD_HALF, which turns 16 steps of GRID into 17 of 3.95 and leaves every
     * corner on the strip half a cell off the lattice. The third is the
     * diagonal each cell is split on (see `fan`).
     *
     * Raising LIFT is not the lever. It would need seventeen times the
     * clearance, and that reads as a lip at the kerb.
     */
    const span = (origin: number, a: number, b: number) => {
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const inner: number[] = []
      for (let k = Math.ceil((lo - origin) / GRID); origin + k * GRID < hi - 1e-6; k++) {
        const v = origin + k * GRID
        if (v > lo + 1e-6) inner.push(v)
      }
      if (a > b) inner.reverse()
      return [a, ...inner, b]
    }
    /** the lattice origins of the two road-space axes, in world coordinates */
    const sOrigin = along === 'x' ? OFF_X : OFF_Z
    const oOrigin = along === 'x' ? OFF_Z : OFF_X
    /** a road-space point in world (x, z) */
    const world = (s: number, w: number): [number, number] =>
      along === 'x' ? [s, w] : [w, s]
    /**
     * How far a world point is past its own cell's diagonal.
     *
     * buildGround splits every cell `a -> d`, from (i, j) to (i+1, j+1), so
     * the third family of creases runs at 45 degrees: (x - OFF_X) - (z -
     * OFF_Z) = k * GRID. It is the one direction `span` cannot cut, because a
     * rectangle cut by a diagonal is not made of rectangles — which is what
     * `out.tri` is for. Left uncut it was the whole of the remainder: a
     * saddle-shaped cell has the deck's diagonal and the ground's crossing,
     * and the ground wins over half of it.
     */
    const acrossDiag = (x: number, z: number, k: number) =>
      (x - OFF_X) - (z - OFF_Z) - k * GRID
    const lay = (p: [number, number], lift: number, v: THREE.Vector3) =>
      v.set(p[0], terrainY(p[0], p[1]) + lift, p[1])
    /**
     * A convex world-space polygon, laid on the ground facing up.
     *
     * Every piece that gets here lies inside a single ground triangle, so any
     * triangulation of it samples the same plane and quads are free: they go
     * out two at a time, which is what keeps the whole of this from costing
     * half again as many vertices as the single quad it replaced.
     */
    const fan = (poly: Array<[number, number]>, lift: number, c: THREE.Color) => {
      const n = poly.length
      if (n < 3) return
      // one winding test for the polygon; the pieces of it all inherit it
      const [p, q, r] = poly
      const ny = (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1])
      // clipping leaves slivers where an edge grazes the diagonal; they are
      // worth nothing and their normals are noise
      if (Math.abs(ny) < 1e-9) return
      const o = ny > 0 ? poly : [poly[0], ...poly.slice(1).reverse()]
      let i = 1
      for (; i + 2 < n; i += 2) {
        lay(o[0], lift, rq0)
        lay(o[i], lift, rq1)
        lay(o[i + 1], lift, rq2)
        lay(o[i + 2], lift, rq3)
        out.quad(rq0, rq1, rq2, rq3, c)
      }
      if (i + 1 < n) {
        lay(o[0], lift, rq0)
        lay(o[i], lift, rq1)
        lay(o[i + 1], lift, rq2)
        out.tri(rq0, rq1, rq2, c)
      }
    }
    /** one flat panel, already inside a lattice cell, split on its diagonal */
    const panel = (
      s0: number, s1: number, w0: number, w1: number, lift: number, c: THREE.Color,
    ) => {
      const rect: Array<[number, number]> = [
        world(s0, w0), world(s0, w1), world(s1, w1), world(s1, w0),
      ]
      // which cell this is, and therefore which diagonal crosses it
      const [mx, mz] = world((s0 + s1) / 2, (w0 + w1) / 2)
      const k = Math.floor((mx - OFF_X) / GRID) - Math.floor((mz - OFF_Z) / GRID)
      const d = rect.map(([x, z]) => acrossDiag(x, z, k))
      if (d.every((v) => v >= -1e-6) || d.every((v) => v <= 1e-6)) {
        fan(rect, lift, c)
        return
      }
      // Sutherland-Hodgman, one half-plane at a time; a rectangle cut by a
      // diagonal comes back as a triangle and a quad, or a triangle and a
      // pentagon, so both sides go out as fans
      for (const sign of [1, -1]) {
        const half: Array<[number, number]> = []
        for (let i = 0; i < rect.length; i++) {
          const a = rect[i]
          const b = rect[(i + 1) % rect.length]
          const fa = sign * d[i]
          const fb = sign * d[(i + 1) % rect.length]
          if (fa >= -1e-9) half.push(a)
          if ((fa > 1e-9 && fb < -1e-9) || (fa < -1e-9 && fb > 1e-9)) {
            const t = fa / (fa - fb)
            half.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
          }
        }
        if (half.length >= 3) fan(half, lift, c)
      }
    }
    /** an upward-facing run of the deck, cut on every crease it crosses */
    const deck = (
      s0: number, s1: number, o0: number, o1: number, lift: number, c: THREE.Color,
    ) => {
      const ss = span(sOrigin, s0, s1)
      // the cross span arrives in road space; the lattice is in world space
      const os = span(oOrigin, line + o0, line + o1)
      for (let i = 0; i + 1 < ss.length; i++)
        for (let j = 0; j + 1 < os.length; j++)
          panel(ss[i], ss[i + 1], os[j], os[j + 1], lift, c)
    }
    /**
     * A vertical face at `off`, looking toward `outward` in road space. Cut
     * the same way: its top and bottom edges follow the ground too, so a kerb
     * spanning a crease has the same wedge coming through its face. It is a
     * line rather than a rectangle, so the diagonals it crosses are just
     * another arithmetic progression of step GRID — the one the cell
     * diagonals cut out of this line — and `span` can do it.
     */
    const riser = (
      s0: number, s1: number, off: number, y0: number, y1: number,
      outward: number, c: THREE.Color,
    ) => {
      const fixed = line + off
      const ss = span(sOrigin, s0, s1)
      // solve (x - OFF_X) - (z - OFF_Z) = k * GRID for whichever of the two
      // this face runs along; either way it comes out as a step of GRID
      const dOrigin = along === 'x'
        ? OFF_X + (fixed - OFF_Z)
        : OFF_Z + (fixed - OFF_X)
      const cut: number[] = []
      for (let i = 0; i + 1 < ss.length; i++)
        cut.push(...span(dOrigin, ss[i], ss[i + 1]).slice(0, -1))
      cut.push(ss[ss.length - 1])
      for (let i = 0; i + 1 < cut.length; i++) {
        const flip = (along === 'x') !== (outward > 0)
        const [b0, b1] = flip ? [cut[i + 1], cut[i]] : [cut[i], cut[i + 1]]
        at(b0, off, y0, rq0)
        at(b1, off, y0, rq1)
        at(b1, off, y1, rq2)
        at(b0, off, y1, rq3)
        out.quad(rq0, rq1, rq2, rq3, c)
      }
    }

    for (let s = 0; s < steps; s++) {
      const a = from + s * seg
      const b = a + seg
      // a segment whose road has faded — usually into ground too steep to
      // pave — builds nothing: the lane gives out at the foot of the hill
      // instead of climbing the scarp like a ramp nailed to it
      const smx = along === 'x' ? a + seg / 2 : line
      const smz = along === 'x' ? line : a + seg / 2
      const segRoad = roadAt(smx, smz, placeAt(smx, smz))
      if (!segRoad.asphalt || segRoad.grade < 0.35) continue
      out.surface = SURF.asphalt
      deck(a, b, -ROAD_HALF, ROAD_HALF, LIFT, asphaltC)
      out.surface = SURF.paving
      for (const sgn of [-1, 1]) {
        for (const [c0, c1] of clip(a, b)) {
          deck(c0, c1, sgn * ROAD_HALF, sgn * (ROAD_HALF + WALK_W), CURB_H, walkC)
          // the kerb's visible face looks back at the road it holds up
          riser(c0, c1, sgn * ROAD_HALF, LIFT, CURB_H, -sgn, curbC)
        }
      }
      out.surface = SURF.none
      if (!detailed) continue
      // dashed centre line on every other segment, kept out of junctions
      if (s % 2 === 0 && !inBlocked((a + b) / 2, seg * 0.6)) {
        deck(a + seg * 0.22, b - seg * 0.22, -0.11, 0.11, LIFT + 0.012, lineC)
      }
      // a lamp every fourth segment, alternating shoulders — but never on
      // the property's frontage, where the grid would otherwise plant one
      // squarely between the gate and the front door
      if (s % 4 === 1) {
        const sgn = s % 8 === 1 ? 1 : -1
        const lampOff = ROAD_HALF + WALK_W * 0.75
        const lx = along === 'x' ? a + seg * 0.5 : line + sgn * lampOff
        const lz = along === 'x' ? line + sgn * lampOff : a + seg * 0.5
        if (inReserved(lx, lz, 8)) continue
        if (inBlocked(a + seg * 0.5, 2)) continue
        const y = terrainY(lx, lz)
        // the arm has to reach back over the road, so the mast is yawed to put
        // its local +x on the cross axis pointing at the centreline
        const yaw = along === 'x' ? (sgn * Math.PI) / 2 : sgn > 0 ? Math.PI : 0
        const dv = out.count
        const di = out.indexCount
        const gv = glass.count
        const gi = glass.indexCount
        streetLamp(out, glass, poleC, bulbC, lx, y, lz, yaw)
        // 0.4 is the plinth (0.23) plus the shoulder margin every solid
        // registered through addBoxFrom() gets and this one, built by hand,
        // was going without: at the plinth's own width a walker stops with
        // their centre on the edge of it and their shoulders inside the mast
        const box = noStand(new THREE.Box3(
          new THREE.Vector3(lx - 0.4, y - 1, lz - 0.4),
          new THREE.Vector3(lx + 0.4, y + LAMP_H, lz + 0.4),
        )) as Solid
        poles.push(box)
        // a mast is a thin steel tube on a bolted plinth: the one thing out
        // here that goes over at a speed you reach on the street it stands on
        smash.push({
          id: `${cx},${cz}:L${along}${s}`,
          box,
          limit: 13,
          x: lx,
          y,
          z: lz,
          r: 0.22,
          // the head end is an arm and a housing, not a crown: a downed mast
          // lies on the road with the arm sticking out sideways
          rTop: 0.35,
          spans: spansFrom([
            ['detail', out, dv, di],
            ['glass', glass, gv, gi],
          ]),
        })
      }
    }
  }
  strip('z', ox, oz, oz + CHUNK)
  strip('x', oz, ox, ox + CHUNK)
  return poles
}

/* ------------------------------------------------------------ buildings */

/**
 * Plant one kit instance: stamp it, register the collision cylinder its kit
 * asks for, and — where the kind is one a vehicle can flatten (props.ts's
 * SNAP) — record the span it just occupied so world/debris.ts can lift it
 * back out. Both places that plant a tree go through here, because the three
 * steps have to agree about the same position and scale and did not when
 * they were written out twice.
 */
const plant = (
  out: MeshBuilder, cards: MeshBuilder, kit: Kit, kind: PropKind, pal: Palette,
  px: number, py: number, pz: number, sc: number, yaw: number, jitter: number,
  boxes: Solid[] | null, smash: Smashable[] | null, id: string,
) => {
  const dv = out.count
  const di = out.indexCount
  const cv = cards.count
  const ci = cards.indexCount
  stampKit(out, cards, kit, pal, px, py - 0.15, pz, sc, yaw, jitter)
  if (!boxes || !kit.solid) return
  const rr = kit.solid.r * sc
  const box = noStand(new THREE.Box3(
    new THREE.Vector3(px - rr, py - 0.4, pz - rr),
    new THREE.Vector3(px + rr, py + kit.solid.h * sc, pz + rr),
  )) as Solid
  boxes.push(box)
  const limit = SNAP[kind]
  if (!smash || limit === undefined) return
  smash.push({
    id,
    box,
    // a bigger tree of the same kind is a bigger tree to hit
    limit: limit * (0.7 + sc * 0.3),
    x: px,
    y: py - 0.15,
    z: pz,
    r: rr,
    // a kit with foliage cards has a crown, and a felled trunk lies on it
    // rather than on the ground; a cactus or a dead tree lies flat
    rTop: kit.parts.some((p) => p.slot === 'card') ? rr * 2.2 : rr,
    spans: spansFrom([
      ['detail', out, dv, di],
      ['leaf', cards, cv, ci],
    ]),
  })
}

const buildBlock = (
  cx: number, cz: number, out: BuildOut, ground: Ground, leaves: MeshBuilder,
) => {
  const ox = originX(cx)
  const oz = originZ(cz)
  const midX = ox + CHUNK / 2
  const midZ = oz + CHUNK / 2
  const place = placeAt(midX, midZ)
  if (!place.district) return
  const rng = seeded(hash2(cx, cz, 0x2f61))
  const inner = CHUNK - blockInset * 2
  const lo = ox + blockInset
  const lz = oz + blockInset

  // the occasional block stays green. A grid where every cell is buildings
  // is what "copy-paste city" means from the pavement; a park every seventh
  // block or so is the cheapest way to make the rest read as chosen. The
  // trees are stamped here rather than left to the scatterer because town
  // scatter is thinned by pavedAt — a park is *deliberately* planted.
  if (place.district !== 'downtown' && rng() < (place.district === 'suburb' ? 0.13 : 0.1)) {
    const kinds: PropKind[] = ['broadleaf', 'broadleaf', 'birch', 'bush']
    const n = 7 + Math.floor(rng() * 5)
    for (let i = 0; i < n; i++) {
      const px = lo + rng() * inner
      const pz = lz + rng() * inner
      if (inReserved(px, pz, 4)) continue
      const py = terrainY(px, pz)
      if (py < SEA_Y + 0.5) continue
      const road = roadAt(px, pz, place)
      if (road.dist < ROAD_HALF + WALK_W + 1.5) continue
      const li = Math.min(VERTS - 1, Math.max(0, Math.round((px - ox) / GRID)))
      const lj = Math.min(VERTS - 1, Math.max(0, Math.round((pz - oz) / GRID)))
      const pal = paletteFor(ground.biome[lj * VERTS + li])
      const kind = kinds[Math.floor(rng() * kinds.length)]
      const kit = kitsFor(kind)[Math.floor(rng() * VARIANTS)]
      const sc = 0.9 + rng() * 0.4
      plant(out.solid, leaves, kit, kind, pal, px, py, pz, sc,
        rng() * Math.PI * 2, rng() * 2 - 1,
        out.boxes, out.smash, `${cx},${cz}:P${i}`)
    }
    return
  }

  const height = buildingHeightAt(place)

  /** the ground a footprint has to sit on: its lowest corner, so no building
      floats on the high side of a graded slope, and its highest, so an
      enterable interior can grade a floor above the dirt. `fine` samples the
      inside of the footprint too rather than only the corners: the terrain
      lattice has a vertex every 4 units, and a hump between two corners once
      stood 0.22 proud of a floor set by corners alone. */
  const groundUnder = (bx: number, bz: number, w: number, d: number, fine: boolean) => {
    let baseY = Infinity
    let topY = -Infinity
    const nu = fine ? Math.max(2, Math.ceil(w / 2.5)) : 1
    const nv = fine ? Math.max(2, Math.ceil(d / 2.5)) : 1
    for (let i = 0; i <= nu; i++)
      for (let j = 0; j <= nv; j++) {
        const cy = terrainY(bx - w / 2 + (w * i) / nu, bz - d / 2 + (d * j) / nv)
        baseY = Math.min(baseY, cy)
        topY = Math.max(topY, cy)
      }
    return [baseY, topY] as const
  }

  /** which way a footprint fronts: at the nearest street, which out here is
      always a chunk border and therefore always a cardinal */
  const facing = (bx: number, bz: number) => {
    const dxEdge = Math.min(bx - ox, ox + CHUNK - bx)
    const dzEdge = Math.min(bz - oz, oz + CHUNK - bz)
    return dzEdge < dxEdge
      ? (bz - oz < oz + CHUNK - bz ? Math.PI : 0)
      : (bx - ox < ox + CHUNK - bx ? -Math.PI / 2 : Math.PI / 2)
  }

  const clearOfHome = (bx: number, bz: number, w: number, d: number) =>
    !(bx - w / 2 < RESERVED.maxX + 4 && bx + w / 2 > RESERVED.minX - 4 &&
      bz - d / 2 < RESERVED.maxZ + 4 && bz + d / 2 > RESERVED.minZ - 4)

  const raise = (kind: BuildKind, lot: Lot) => {
    switch (kind) {
      case 'tower': tower(out, lot); break
      case 'slab': slabTower(out, lot); break
      case 'round': roundTower(out, lot); break
      case 'midrise': midriseBlock(out, lot); break
      case 'mixed': mixedUse(out, lot); break
      case 'shop': shopFront(out, lot); break
      case 'warehouse': warehouse(out, lot); break
      case 'chapel': chapel(out, lot); break
      case 'parking': parkingDeck(out, lot); break
      default: suburbHouse(out, lot)
    }
  }

  // ...and the occasional block is one thing rather than nine. A warehouse
  // wants a run, a chapel wants a yard and a deck wants a footprint, so none
  // of the three fits on a share of a block; putting them on whole ones is
  // also the cheapest way to stop a district reading as one kit at a dozen
  // heights, which no amount of extra rolls inside that kit ever fixes
  if (rng() < BLOCK_KIND_RATE(place.district)) {
    const kind = BLOCK_KIND_FOR(place.district, rng())
    const w = inner * (0.7 + rng() * 0.18)
    const d = inner * (0.7 + rng() * 0.18)
    const bx = ox + CHUNK / 2 + (rng() - 0.5) * 3
    const bz = oz + CHUNK / 2 + (rng() - 0.5) * 3
    if (clearOfHome(bx, bz, w, d)) {
      const [baseY, topY] = groundUnder(bx, bz, w, d, false)
      // a block-scale shell carries a deeper plinth than a lot-scale one, so
      // it takes a bumpier site before the ground starts eating it
      if (baseY >= SEA_Y + 1 && topY - baseY <= 3.0) {
        raise(kind, {
          x: bx, z: bz, w, d, baseY, topY, height, face: facing(bx, bz), rng,
        })
        return
      }
    }
  }

  // how the block is carved up: one big footprint downtown, a courtyard of
  // four in the mid-rise, a street of nine in the suburbs
  const n = place.district === 'downtown' ? (rng() < 0.55 ? 1 : 2)
    : place.district === 'midrise' ? 2 : 3
  const cell = inner / n

  for (let gz = 0; gz < n; gz++)
    for (let gx = 0; gx < n; gx++) {
      // the suburb keeps its middle empty: back gardens, not another house
      if (n === 3 && gx === 1 && gz === 1) continue
      const roll = rng()
      if (place.district === 'suburb' && roll > 0.86) continue
      const fill = place.district === 'downtown' ? 0.86 : place.district === 'midrise' ? 0.8 : 0.62
      const w = cell * fill * (0.85 + rng() * 0.3)
      const d = cell * fill * (0.85 + rng() * 0.3)
      const bx = lo + (gx + 0.5) * cell + (rng() - 0.5) * cell * 0.12
      const bz = lz + (gz + 0.5) * cell + (rng() - 0.5) * cell * 0.12
      if (!clearOfHome(bx, bz, w, d)) continue
      // no building at all where the corners disagree by more than the plinth
      // can hide. The rim of a town is only half-graded now that the hills
      // start there, and a house sunk to its windowsills reads as the ground
      // eating it
      let kind = KIND_FOR(place.district, roll)
      const [baseY, topY] = groundUnder(bx, bz, w, d, kind === 'shop')
      if (baseY < SEA_Y + 1) continue
      if (topY - baseY > 2.2) continue

      // an enterable shop grades its floor up to the *highest* ground under
      // it and meets the street with a stoop; past a shin-and-a-bit of spread
      // the stoop turns into a staircase, so the lot builds a shell instead
      if (kind === 'shop' && topY - baseY > 1.2) {
        kind = place.district === 'midrise' ? 'midrise' : 'house'
      }
      raise(kind, {
        x: bx, z: bz, w, d, baseY, topY,
        height: height * (0.7 + rng() * 0.6), face: facing(bx, bz), rng,
      })
    }
}

/**
 * The one thing this chunk might have standing in the open country: a
 * lighthouse, a barn, a ring of stones (world/landmarks.ts decides, and
 * world/structures.ts builds). At most one per chunk by construction, since
 * the site grid is 400 units and its jitter keeps two sites 180 apart.
 *
 * The ground is read at the site rather than over the footprint, because
 * everything except a shipwreck stands on a pad terrain.ts has already
 * levelled out to `lm.r`, so the one sample is the whole footprint.
 */
const buildLandmarks = (cx: number, cz: number, out: BuildOut) => {
  const lm = landmarkIn(cx, cz)
  if (!lm || inReserved(lm.x, lm.z, 40)) return null
  buildLandmark(out, lm, terrainY(lm.x, lm.z))
  return lm
}

/* -------------------------------------------------------------- scatter */

const PAL_CACHE = new Map<BiomeId, Palette>()
const paletteFor = (b: BiomeId): Palette => {
  let p = PAL_CACHE.get(b)
  if (!p) {
    const src = BIOMES[b].pal
    p = {
      bark: new THREE.Color(src.bark),
      leaf: new THREE.Color(src.leaf),
      accent: new THREE.Color(src.accent),
    }
    PAL_CACHE.set(b, p)
  }
  return p
}

/** trunks stay this far clear of a building's footprint. A broadleaf crown is
    about three units across and sits at seven up, which is exactly the height
    of a suburb roof — clear the footprint by less than this and the canopy
    grows through the tiles. Ground cover has no such problem and uses half. */
const BUILD_CLEAR = 3.0

/** is this point inside (or too near) something already built here */
const insideBuilt = (built: Solid[], x: number, z: number, pad: number) => {
  for (const b of built) {
    if (x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad) {
      return true
    }
  }
  return false
}

/**
 * Trees, rocks and grass. Density comes from whichever biome actually sits
 * under each candidate point, not from one biome per chunk, so a chunk
 * straddling a treeline thins out across itself instead of picking a side.
 * Candidates are hashed positions rejected against water, roads, the
 * buildings already standing in this chunk and the reserved property — which
 * is why the `per` counts in biomes.ts are upper bounds rather than promises.
 * (Slope needs no test of its own: land steep enough to shed soil classifies
 * as 'rock' in biomes.ts, and rock grows nothing.)
 */
const scatter = (
  cx: number, cz: number, ground: Ground, built: Solid[],
  out: MeshBuilder, cardsOut: MeshBuilder, boxes: Solid[] | null,
  smash: Smashable[] | null, cover: boolean,
) => {
  const ox = originX(cx)
  const oz = originZ(cz)
  // which biomes this chunk actually contains, and in what proportion
  const share = new Map<BiomeId, number>()
  for (const b of ground.biome) share.set(b, (share.get(b) ?? 0) + 1)
  const total = ground.biome.length

  let seq = 0
  for (const [biome, count] of share) {
    const def = BIOMES[biome]
    const frac = count / total
    const pal = paletteFor(biome)
    const table = cover ? def.cover : def.flora
    for (const s of table) {
      const want = Math.round(s.per * frac)
      for (let i = 0; i < want; i++) {
        const id = seq++
        const px = ox + rand3(cx, cz, id * 3 + 1, 0x51a7) * CHUNK
        const pz = oz + rand3(cx, cz, id * 3 + 2, 0x51a7) * CHUNK
        // solids respect the whole reserved margin; walk-through cover only
        // the fence itself, so the strip around the yard isn't bald felt
        if (cover ? inYard(px, pz, 1) : inReserved(px, pz, 2)) continue
        const y = terrainY(px, pz)
        if (y < SEA_Y + 0.4) continue
        // the biome under this exact point has to be the one we drew from,
        // or a desert's cacti drift into the forest next door
        const li = Math.min(VERTS - 1, Math.max(0, Math.round((px - ox) / GRID)))
        const lj = Math.min(VERTS - 1, Math.max(0, Math.round((pz - oz) / GRID)))
        if (ground.biome[lj * VERTS + li] !== biome) continue
        if (insideBuilt(built, px, pz, cover ? BUILD_CLEAR * 0.5 : BUILD_CLEAR)) continue
        const place = placeAt(px, pz)
        const road = roadAt(px, pz, place)
        if (road.dist < ROAD_HALF + WALK_W + 1.2) continue
        // town ground is mown, paved or built on — but a suburb is gardens, so
        // it keeps most of its planting and only the core strips out. Anything
        // still standing on paving is culled outright rather than thinned
        const paved = pavedAt(place, road)
        if (paved > 0.5) continue
        if (place.district && rand3(cx, cz, id, 0x77b3) > 1 - paved) continue
        const r = rand3(cx, cz, id * 3 + 3, 0x51a7)
        const kits = kitsFor(s.kind)
        const kit = kits[variantFor(s.kind, cx * 977 + id, cz, i)]
        const sc = mix(s.scale[0], s.scale[1], r)
        plant(out, cardsOut, kit, s.kind, pal, px, y, pz, sc,
          rand3(cx, cz, id * 3 + 4, 0x51a7) * Math.PI * 2, r * 2 - 1,
          boxes, smash, `${cx},${cz}:S${id}`)
      }
    }
  }
}

/* ----------------------------------------------------------------- build */

/**
 * How a chunk announces itself (world/fade.ts). `at` is the wind clock's now;
 * `from` — set on a tier upgrade — is the tier already on screen, and gates
 * the fade to the slices that tier didn't have: fading a whole replacement
 * would blink roads and trees the player was already looking at.
 */
export interface ChunkFade {
  at: number
  from?: Tier
}

export const buildChunk = (
  cx: number, cz: number, tier: Tier, mats: ChunkMats, fade?: ChunkFade,
): Chunk => {
  const group = new THREE.Group()
  const geos: THREE.BufferGeometry[] = []
  const boxes: Solid[] = []
  const lamps: Array<{ x: number; y: number; z: number }> = []

  // birth stamps per slice: the base (ground, water, roads, buildings, glass)
  // fades only on a brand-new chunk, flora only when the old tier had none,
  // and cover — which only 'full' builds — is new whenever anything fades
  const at = fade?.at ?? PREBORN
  const baseBirth = fade?.from === undefined ? at : PREBORN
  const floraBirth = fade?.from !== 'flora' ? at : PREBORN

  const ground = buildGround(cx, cz)
  if (ground.geo) {
    geos.push(ground.geo)
    bakeBirth(ground.geo, baseBirth)
    const m = new THREE.Mesh(ground.geo, mats.ground)
    m.receiveShadow = true
    group.add(m)
  }

  if (ground.wet) {
    // subdivided, and each vertex carries how deep the water is under it.
    // That one baked attribute is what buys a shoreline: the material fades
    // to clear and foams where the depth goes to nothing, instead of ending
    // in the hard straight line a flat quad would draw across the beach
    const n = 8
    const g = new THREE.PlaneGeometry(CHUNK, CHUNK, n, n)
    g.rotateX(-Math.PI / 2)
    g.translate(originX(cx) + CHUNK / 2, SEA_Y, originZ(cz) + CHUNK / 2)
    const wp = g.getAttribute('position')
    const depth = new Float32Array(wp.count)
    for (let i = 0; i < wp.count; i++) {
      depth[i] = SEA_Y - terrainY(wp.getX(i), wp.getZ(i))
    }
    g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1))
    bakeBirth(g, baseBirth)
    geos.push(g)
    const m = new THREE.Mesh(g, mats.water)
    m.renderOrder = 1
    group.add(m)
  }

  const detail = createMeshBuilder()
  const glass = createMeshBuilder()
  const leaves = createMeshBuilder(true)
  const interiors: InteriorRect[] = []
  const doors: ShopDoorSpec[] = []
  const props: Smashable[] = []
  const out: BuildOut = {
    solid: detail, glass, boxes, lamps, interiors, doors, smash: props,
    detailed: tier !== 'bare',
  }

  const poles = buildRoads(cx, cz, detail, glass, out.detailed, props)
  buildBlock(cx, cz, out, ground, leaves)
  const landmark = buildLandmarks(cx, cz, out)
  // everything in `boxes` at this point is a building — the roads register
  // theirs separately and the scatter has not run yet — so this is the
  // footprint list the scatterer needs to keep trees out of people's living
  // rooms. The lamp posts join afterwards: they collide, but clearing three
  // units of flora around each one would leave a bald ring down every verge
  const built = boxes.slice()
  // ...and an enterable interior is a footprint with no box over most of it
  // (its walls register individually so the doorway stays open), so it joins
  // the scatter's keep-out list as a phantom: never collided with, only read
  // for its x/z extents here
  for (const r of interiors) {
    built.push(new THREE.Box3(
      new THREE.Vector3(r.minX, 0, r.minZ), new THREE.Vector3(r.maxX, 0, r.maxZ),
    ))
  }
  // ...and a landmark clears its whole pad rather than just the boxes it
  // registered. A ring of standing stones is nine thin solids with the site
  // wide open between them, and a forest growing up through the middle of it
  // is the difference between a monument and a clearing that happens to have
  // rocks in it. Same phantom trick as an interior: never collided with, read
  // only for its extents
  if (landmark) {
    built.push(new THREE.Box3(
      new THREE.Vector3(landmark.x - landmark.r, 0, landmark.z - landmark.r),
      new THREE.Vector3(landmark.x + landmark.r, 0, landmark.z + landmark.r),
    ))
  }
  for (const p of poles) boxes.push(p)
  // the builders' vertex counts, snapshotted between passes, are what turn
  // one merged soup into separately-born slices for the fade attribute
  const dFlora = detail.count
  const lFlora = leaves.count
  if (tier !== 'bare') scatter(cx, cz, ground, built, detail, leaves, boxes, props, false)
  const dCover = detail.count
  const lCover = leaves.count
  if (tier === 'full') scatter(cx, cz, ground, built, detail, leaves, null, null, true)

  /** base up to `m1`, flora up to `m2`, cover after — each at its own birth */
  const slicedBirth = (g: THREE.BufferGeometry, m1: number, m2: number) => {
    const a = new Float32Array(g.getAttribute('position').count)
    a.fill(baseBirth, 0, m1)
    a.fill(floraBirth, m1, m2)
    a.fill(at, m2)
    g.setAttribute('aBirth', new THREE.BufferAttribute(a, 1))
  }

  const smash: SmashSet = { key: `${cx},${cz}`, meshes: {}, props }
  const dg = detail.build()
  if (dg) {
    geos.push(dg)
    slicedBirth(dg, dFlora, dCover)
    const dm = new THREE.Mesh(dg, mats.detail)
    dm.castShadow = true
    dm.receiveShadow = true
    group.add(dm)
    smash.meshes.detail = dm
  }
  const lg = leaves.build()
  if (lg) {
    geos.push(lg)
    slicedBirth(lg, lFlora, lCover)
    const lm = new THREE.Mesh(lg, mats.leaf)
    lm.castShadow = true
    lm.receiveShadow = true
    // the depth pass must respect the leaf alpha or every crown casts the
    // shadow of a solid card deck
    lm.customDepthMaterial = mats.leafDepth
    group.add(lm)
    smash.meshes.leaf = lm
  }
  const gg = glass.build()
  if (gg) {
    geos.push(gg)
    bakeBirth(gg, baseBirth)
    const m = new THREE.Mesh(gg, mats.glass)
    m.renderOrder = 2
    group.add(m)
    smash.meshes.glass = m
  }

  group.updateMatrixWorld(true)
  group.traverse((o) => {
    o.matrixAutoUpdate = false
  })
  // door ids are position-stable across rebuilds, so the session's open/shut
  // state survives a tier change or a ring exit and return
  doors.forEach((d, i) => {
    d.id = `${cx},${cz}:${i}`
  })
  return { cx, cz, tier, group, geos, boxes, lamps, interiors, doors, smash }
}

/**
 * What a chunk builds, by its Chebyshev distance from the player's chunk.
 * The boundaries are picked against the fog rather than against a vertex
 * budget: ground cover stops at 1 (64 units, and grass is unreadable past a
 * few of those), flora stops at 3 (192 units, where daylight fog has taken
 * about 95% of it, so the treeline never visibly pops in), and the outer ring
 * keeps only what you read at that range — landform, water and skyline.
 */
export const tierFor = (dist: number): Tier =>
  dist <= 1 ? 'full' : dist <= 3 ? 'flora' : 'bare'
