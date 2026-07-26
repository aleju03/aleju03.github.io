import * as THREE from 'three'
import { createMeshBuilder, type MeshBuilder } from '../core/geometry'
import { seeded } from '../core/rand'
import { noStand, type Solid } from '../physics/collision'
import { hash2, mix, rand3 } from './noise'
import {
  CHUNK, GRID, OFF_X, OFF_Z, RESERVED, inReserved, inYard, originX, originZ,
} from './grid'
import { SEA_Y, biomeAt, latticeHeight, terrainY, tintAt } from './terrain'
import {
  placeAt, roadAt, pavedAt, buildingHeightAt, blockInset, ROAD_HALF, WALK_W, CURB_H,
} from './settlements'
import { BIOMES, type BiomeId, type PropKind } from './biomes'
import { VARIANTS, kitsFor, stampKit, variantFor, type Palette } from './props'
import { SURF } from './surface'
import {
  KIND_FOR, midriseBlock, shopFront, suburbHouse, tower, type BuildOut, type Lot,
} from './buildings'

/*
  One 64-unit block of world, built from nothing but its own coordinates.

  A chunk is assembled in five passes — ground, water, streets, buildings,
  scatter — and every one of them is a pure function of (cx, cz), so a chunk
  rebuilt an hour later from the other side of the map is identical to the bit.
  That is the property that lets the streamer throw chunks away the moment
  they leave the ring instead of keeping a world in memory.

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
}

const VERTS = CHUNK / GRID + 1 // 17

const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpP = new THREE.Vector3()
const tmpS = new THREE.Vector3()
const tmpC = new THREE.Color()
const tmpC2 = new THREE.Color()
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
      const slope = Math.hypot((hx1 - hx0) / (2 * GRID), (hz1 - hz0) / (2 * GRID))
      const b = biomeAt(wx, wz, y, slope)
      biome[k] = b
      const place = placeAt(wx, wz)
      const road = roadAt(wx, wz, place)
      // Paved wins over climate — but only where a town actually paves, and
      // it fades back to ground away from the kerb. The first cut gave every
      // district one flat 0.55, which crosses tintAt's threshold, so a whole
      // city including its suburbs came out as one grey concrete field with a
      // few tufts standing in it. A suburb is lawns; only the middle of a city
      // is a floor.
      const paved = pavedAt(place, road)
      const [a, c, t] = tintAt(wx, wz, b, paved)
      tmpC.set(a)
      tmpC2.set(c)
      tmpC.lerp(tmpC2, t)
      if (paved > 0 && paved < 1) tmpC.lerp(tmpC2.set('#6f6f66'), paved * 0.5)
      colArr[k * 3] = tmpC.r
      colArr[k * 3 + 1] = tmpC.g
      colArr[k * 3 + 2] = tmpC.b
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

  /** one street, `along` = the axis it runs down */
  const strip = (along: 'x' | 'z', line: number, from: number, to: number) => {
    const mid = (from + to) / 2
    const probe = along === 'x' ? { x: mid, z: line } : { x: line, z: mid }
    const place = placeAt(probe.x, probe.z)
    const road = roadAt(probe.x, probe.z, place)
    if (!road.asphalt || road.grade < 0.35) return
    const steps = Math.ceil((to - from) / GRID)
    const seg = (to - from) / steps

    // where a live perpendicular street crosses, its asphalt owns the ground:
    // pavement, kerbs, dashes and lamps all stop at its edge. Without this
    // every junction wore a raised sidewalk bar straight across the mouth of
    // the crossing road, kerb face and all.
    const off = along === 'x' ? OFF_X : OFF_Z
    const j0 = Math.round((from - off) / CHUNK) * CHUNK + off
    const blocked: Array<[number, number]> = []
    for (const jl of [j0, j0 + CHUNK]) {
      const px = along === 'x' ? jl : line + ROAD_HALF + WALK_W + 1.4
      const pz = along === 'x' ? line + ROAD_HALF + WALK_W + 1.4 : jl
      const pRoad = roadAt(px, pz, placeAt(px, pz))
      if (pRoad.asphalt) blocked.push([jl - ROAD_HALF, jl + ROAD_HALF])
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
    /** an upward-facing panel of the deck */
    const deck = (
      s0: number, s1: number, o0: number, o1: number, lift: number, c: THREE.Color,
    ) => {
      // winding runs the other way for a north-south street, because the
      // cross axis flips sign relative to the along axis
      const [a0, a1] = along === 'x' ? [o0, o1] : [o1, o0]
      at(s0, a0, lift, rq0)
      at(s0, a1, lift, rq1)
      at(s1, a1, lift, rq2)
      at(s1, a0, lift, rq3)
      out.quad(rq0, rq1, rq2, rq3, c)
    }
    /** a vertical face at `off`, looking toward `outward` in road space */
    const riser = (
      s0: number, s1: number, off: number, y0: number, y1: number,
      outward: number, c: THREE.Color,
    ) => {
      const flip = (along === 'x') !== (outward > 0)
      const [b0, b1] = flip ? [s1, s0] : [s0, s1]
      at(b0, off, y0, rq0)
      at(b1, off, y0, rq1)
      at(b1, off, y1, rq2)
      at(b0, off, y1, rq3)
      out.quad(rq0, rq1, rq2, rq3, c)
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
        streetLamp(out, glass, poleC, bulbC, lx, y, lz, yaw)
        poles.push(noStand(new THREE.Box3(
          new THREE.Vector3(lx - 0.22, y - 1, lz - 0.22),
          new THREE.Vector3(lx + 0.22, y + LAMP_H, lz + 0.22),
        )))
      }
    }
  }
  strip('z', ox, oz + ROAD_HALF, oz + CHUNK)
  strip('x', oz, ox, ox + CHUNK)
  return poles
}

/* ------------------------------------------------------------ buildings */

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
      stampKit(out.solid, leaves, kit, pal, px, py - 0.15, pz, sc,
        rng() * Math.PI * 2, rng() * 2 - 1)
      if (kit.solid) {
        const rr = kit.solid.r * sc
        out.boxes.push(noStand(new THREE.Box3(
          new THREE.Vector3(px - rr, py - 0.4, pz - rr),
          new THREE.Vector3(px + rr, py + kit.solid.h * sc, pz + rr),
        )))
      }
    }
    return
  }

  // how the block is carved up: one big footprint downtown, a courtyard of
  // four in the mid-rise, a street of nine in the suburbs
  const n = place.district === 'downtown' ? (rng() < 0.55 ? 1 : 2)
    : place.district === 'midrise' ? 2 : 3
  const cell = inner / n
  const height = buildingHeightAt(place)

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
      if (
        bx - w / 2 < RESERVED.maxX + 4 && bx + w / 2 > RESERVED.minX - 4 &&
        bz - d / 2 < RESERVED.maxZ + 4 && bz + d / 2 > RESERVED.minZ - 4
      ) continue
      // face the nearest street
      const dxEdge = Math.min(bx - ox, ox + CHUNK - bx)
      const dzEdge = Math.min(bz - oz, oz + CHUNK - bz)
      const face = dzEdge < dxEdge
        ? (bz - oz < oz + CHUNK - bz ? Math.PI : 0)
        : (bx - ox < ox + CHUNK - bx ? -Math.PI / 2 : Math.PI / 2)
      // the ground the footprint has to sit on: its lowest corner, so no
      // building floats on the high side of a graded slope — and no building
      // at all where the corners disagree by more than the plinth can hide.
      // The rim of a town is only half-graded now that the hills start there,
      // and a house sunk to its windowsills reads as the ground eating it.
      let baseY = Infinity
      let topY = -Infinity
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const cy = terrainY(bx + (sx * w) / 2, bz + (sz * d) / 2)
        baseY = Math.min(baseY, cy)
        topY = Math.max(topY, cy)
      }
      if (baseY < SEA_Y + 1) continue
      if (topY - baseY > 2.2) continue

      const lot: Lot = { x: bx, z: bz, w, d, baseY, height: height * (0.7 + rng() * 0.6), face, rng }
      switch (KIND_FOR(place.district, roll)) {
        case 'tower': tower(out, lot); break
        case 'midrise': midriseBlock(out, lot); break
        case 'shop': shopFront(out, lot); break
        default: suburbHouse(out, lot)
      }
    }
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
  out: MeshBuilder, cardsOut: MeshBuilder, boxes: Solid[] | null, cover: boolean,
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
        stampKit(out, cardsOut, kit, pal, px, y - 0.15, pz, sc,
          rand3(cx, cz, id * 3 + 4, 0x51a7) * Math.PI * 2, r * 2 - 1)
        if (boxes && kit.solid) {
          const rr = kit.solid.r * sc
          boxes.push(noStand(new THREE.Box3(
            new THREE.Vector3(px - rr, y - 0.4, pz - rr),
            new THREE.Vector3(px + rr, y + kit.solid.h * sc, pz + rr),
          )))
        }
      }
    }
  }
}

/* ----------------------------------------------------------------- build */

export const buildChunk = (
  cx: number, cz: number, tier: Tier, mats: ChunkMats,
): Chunk => {
  const group = new THREE.Group()
  const geos: THREE.BufferGeometry[] = []
  const boxes: Solid[] = []
  const lamps: Array<{ x: number; y: number; z: number }> = []

  const ground = buildGround(cx, cz)
  if (ground.geo) {
    geos.push(ground.geo)
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
    geos.push(g)
    const m = new THREE.Mesh(g, mats.water)
    m.renderOrder = 1
    group.add(m)
  }

  const detail = createMeshBuilder()
  const glass = createMeshBuilder()
  const leaves = createMeshBuilder(true)
  const out: BuildOut = { solid: detail, glass, boxes, lamps, detailed: tier !== 'bare' }

  const poles = buildRoads(cx, cz, detail, glass, out.detailed)
  buildBlock(cx, cz, out, ground, leaves)
  // everything in `boxes` at this point is a building — the roads register
  // theirs separately and the scatter has not run yet — so this is the
  // footprint list the scatterer needs to keep trees out of people's living
  // rooms. The lamp posts join afterwards: they collide, but clearing three
  // units of flora around each one would leave a bald ring down every verge
  const built = boxes.slice()
  for (const p of poles) boxes.push(p)
  if (tier !== 'bare') {
    scatter(cx, cz, ground, built, detail, leaves, boxes, false)
    if (tier === 'full') scatter(cx, cz, ground, built, detail, leaves, null, true)
  }

  const dg = detail.build()
  if (dg) {
    geos.push(dg)
    const dm = new THREE.Mesh(dg, mats.detail)
    dm.castShadow = true
    dm.receiveShadow = true
    group.add(dm)
  }
  const lg = leaves.build()
  if (lg) {
    geos.push(lg)
    const lm = new THREE.Mesh(lg, mats.leaf)
    lm.castShadow = true
    lm.receiveShadow = true
    // the depth pass must respect the leaf alpha or every crown casts the
    // shadow of a solid card deck
    lm.customDepthMaterial = mats.leafDepth
    group.add(lm)
  }
  const gg = glass.build()
  if (gg) {
    geos.push(gg)
    const m = new THREE.Mesh(gg, mats.glass)
    m.renderOrder = 2
    group.add(m)
  }

  group.updateMatrixWorld(true)
  group.traverse((o) => {
    o.matrixAutoUpdate = false
  })
  return { cx, cz, tier, group, geos, boxes, lamps }
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
