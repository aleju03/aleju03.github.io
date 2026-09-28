import * as THREE from 'three'
import { createMeshBuilder, type MeshBuilder } from '../core/geometry'
import { noStand, type Solid } from '../physics/collision'
import { mix, rand2, rand3, smoothstep } from './noise'
import {
  CHUNK, GRID, inReserved, inYard, originX, originZ,
} from './grid'
import { SEA_Y, latticeGround, latticeHeight, terrainY } from './terrain'
import { placeAt, roadAt, pavedAt, townsNear, ROAD_HALF, WALK_W } from './settlements'
import { hit, liveOf, networkOf, parcelsInChunk, pieceNear, piecesIn, probe } from './streets'
import { buildStreetsSteps, makeLayer, type Layer } from './streetMesh'
import { lotStream, type Lot } from './kitbash'
import { BIOMES, type BiomeId, type PropKind } from './biomes'
import {
  SNAP, VARIANTS, kitsFor, stampKit, variantFor, type Kit, type Palette,
} from './props'
import { SURF } from './surface'
import { raiseKind, settleKind, type BuildKind, type BuildOut } from './buildings'
import { landmarkAt, landmarkIn, type Landmark } from './landmarks'
import { furnishPlaza, plazaInner } from './plaza'
import { buildLandmark } from './structures'
import { bakeBirth, PREBORN } from './fade'
import type { InteriorRect } from './interiors'
import type { ShopDoorSpec } from './shopDoors'
import type { SmashLayer, Smashable, SmashSet, Span } from './debris'
import { GRADE, STOREY, type StructureRec } from './fracture'

/*
  One 64-unit block of world, built from nothing but its own coordinates.

  A chunk is assembled in six passes — ground, water, streets, buildings,
  landmarks, scatter — and every one of them is a pure function of (cx, cz),
  so a chunk rebuilt an hour later from the other side of the map is identical
  to the bit. That is the property that lets the streamer throw chunks away the
  moment they leave the ring instead of keeping a world in memory.

  The streets and buildings passes are a town's business, and neither decides
  anything: the town's plan (world/streets.ts) says where its streets run and
  which lots it platted, once per town, and this chunk lays its own share of
  the streets (world/streetMesh.ts) and raises the lots whose centres fall in
  it. The chunk is a streaming unit, not a block; a street crosses it however
  it likes and a building may straddle its border. The landmarks pass is the opposite:
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
  /** every light fixture in the chunk (street lamps, belfries, shop and
      cabin lamps): where the look pools light at night */
  lamps: Array<{ x: number; y: number; z: number }>
  /** walk-in footprints for the interiors registry (see world/interiors.ts) */
  interiors: InteriorRect[]
  /** hinged shop-door leaves the near ring should animate (world/shopDoors.ts) */
  doors: ShopDoorSpec[]
  /** the props a vehicle can knock out of this chunk, and where their
      vertices sit in its merged meshes (world/debris.ts) */
  smash: SmashSet
  /** every building and landmark in it, recorded for destruction
      (world/fracture.ts, sandbox/destruction.ts) */
  structures: StructureRec[]
  /** parts that turn (a windmill's sails), each its own small mesh; the
      streamer sets their angle every frame off one clock (see `spin`) */
  spinners: Spinner[]
}

/** a turning part: its mesh, the axis it turns about and how fast */
export interface Spinner {
  mesh: THREE.Mesh
  axis: THREE.Vector3
  rate: number
}

/** the angle every spinner stands at is a pure function of one clock, so a
    rebuilt chunk's sails pick up exactly where they were */
export const spin = (s: Spinner, t: number) => {
  s.mesh.quaternion.setFromAxisAngle(s.axis, s.rate * t)
}

interface RotorSpec {
  b: MeshBuilder
  x: number
  y: number
  z: number
  axis: THREE.Vector3
  rate: number
  rec?: StructureRec
}
/** Recorder state belongs to its builder: suspended chunks may interleave. */
const rotorsByOut = new WeakMap<BuildOut, RotorSpec[]>()

/**
 * The street test a kit's `clear` asks (kitbash.ts's BuildOut): is a world
 * rectangle clear of the carriageway and the pavement of every street drawn
 * near (x, z)? Exact against the plan's own pieces rather than sampled, and
 * a piece counts only where it is live (roadAt's rule), so a street the
 * terrain faded out is not a wall to a garden fence.
 */
export const lotClear = (x: number, z: number) => {
  const nets = townsNear(x, z).map(networkOf)
  const pad = ROAD_HALF + WALK_W - 0.05
  return (x0: number, z0: number, x1: number, z1: number) => {
    for (const net of nets) {
      for (const p of piecesIn(net, x0 - pad, z0 - pad, x1 + pad, z1 + pad)) {
        if (!pieceNear(p, x0, z0, x1, z1, pad)) continue
        probe(p, (x0 + x1) / 2, (z0 + z1) / 2)
        if (liveOf(p, hit.t) > 0.3) return false
      }
    }
    return true
  }
}

/**
 * Stamp one building with the recorder running: its spans in both soups, the
 * start of every stamp inside them, and the boxes it registered. Two counter
 * reads either side and one push per stamp, which is the whole build-time
 * cost of making every building out here destructible.
 */
const recordStructure = (
  out: BuildOut, id: string, kind: string, baseY: number, stamp: () => void,
) => {
  const list = out.structures
  if (!list) {
    stamp()
    return
  }
  const dv = out.solid.count
  const di = out.solid.indexCount
  const gv = out.glass.count
  const gi = out.glass.indexCount
  const bn = out.boxes.length
  const rotorsMade = rotorsByOut.get(out)
  const rn = rotorsMade?.length ?? 0
  const md: number[] = []
  const mg: number[] = []
  out.solid.marks = md
  out.glass.marks = mg
  try {
    stamp()
  } finally {
    out.solid.marks = null
    out.glass.marks = null
  }
  list.push({
    id, kind, baseY,
    storeyH: STOREY[kind] ?? 5,
    grade: GRADE[kind] ?? 1,
    det: spanFrom(out.solid, dv, di) ?? null,
    gl: spanFrom(out.glass, gv, gi) ?? null,
    marks: Int32Array.from(md),
    gmarks: Int32Array.from(mg),
    boxes: out.boxes.slice(bn),
  })
  // its turning parts go when it is opened into pieces (debris.ts)
  if (rotorsMade) for (const r of rotorsMade.slice(rn)) r.rec = list[list.length - 1]
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

/** sand, snow, rock weights per biome for the ground shader; everything
    else is soil and grass. The seabed is sand, seen through the water */
const GROUND_KIND: Record<BiomeId, [number, number, number]> = {
  ocean: [0.8, 0, 0], beach: [1, 0, 0], desert: [1, 0, 0],
  snow: [0, 1, 0], rock: [0, 0, 1],
  plains: [0, 0, 0], forest: [0, 0, 0], taiga: [0, 0, 0], tundra: [0, 0, 0.3],
  savanna: [0, 0, 0], jungle: [0, 0, 0], wetland: [0, 0, 0],
}

/** how far under y=0 the property's ground is drawn: the house's floors,
    slabs and walks all stand on 0 */
const PROPERTY_SINK = 0.02

/**
 * The terrain mesh. Vertices come from terrain.ts's shared lattice, so the
 * edge a chunk shares with its neighbour is computed from the same cached
 * numbers and the two can never disagree by a float.
 */
function* buildGround(cx: number, cz: number): Generator<void, Ground, void> {
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
  // what the ground shader (groundLook.ts) draws each vertex as: how paved,
  // how sandy, how snowy, how rocky, and the unpaved colour under a verge
  const kind = new Float32Array(n * 4)
  const nat = new Float32Array(n * 4)
  let wet = false

  for (let j = 0; j < VERTS; j++) {
    yield
    for (let i = 0; i < VERTS; i++) {
      const y = latticeHeight(baseI + i, baseJ + j)
      h[j * VERTS + i] = y
      if (y < SEA_Y + 0.15) wet = true
    }
  }

  for (let j = 0; j < VERTS; j++) {
    yield
    for (let i = 0; i < VERTS; i++) {
      const k = j * VERTS + i
      const wx = originX(cx) + i * GRID
      const wz = originZ(cz) + j * GRID
      const y = h[k]
      pos[k * 3] = wx
      // the property's lawn is this same ground, drawn a hair under the
      // house's floors so the two cannot fight (see the indices below)
      pos[k * 3 + 1] = inReserved(wx, wz) ? y - PROPERTY_SINK : y
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
      const w = GROUND_KIND[g.biome]
      kind[k * 4] = g.paved
      kind[k * 4 + 1] = w[0]
      kind[k * 4 + 2] = w[1]
      kind[k * 4 + 3] = w[2]
      nat[k * 4] = g.nr
      nat[k * 4 + 1] = g.ng
      nat[k * 4 + 2] = g.nb
      nat[k * 4 + 3] = g.field
      uv[k * 2] = wx / 9
      uv[k * 2 + 1] = wz / 9
    }
  }

  // indices. The authored property used to be a hole here, filled by the
  // house's own lawn plane: a flat green texture that no amount of tuning
  // made read as the same ground as the verge a metre past the fence. So
  // the property is drawn by the same material off the same lattice as
  // everything else (its vertices sunk by PROPERTY_SINK), and the house's
  // lawn only stands in for it until the world is loaded
  const idx: number[] = []
  for (let j = 0; j < VERTS - 1; j++)
    for (let i = 0; i < VERTS - 1; i++) {
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
  geo.setAttribute('aGround', new THREE.BufferAttribute(kind, 4))
  geo.setAttribute('aTint', new THREE.BufferAttribute(nat, 4))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  return { geo, h, biome, wet }
}

/* ---------------------------------------------------------------- roads */

/**
 * The streets crossing this chunk (world/streetMesh.ts lays them off the
 * town's plan in streets.ts), plus the lamps, which are built here because a
 * lamp is also a solid and a thing a car can knock over. The poles come back
 * to the caller so it can register them *after* it has taken its building
 * footprint snapshot: a mast is solid enough to walk into, but it is not a
 * footprint the scatterer should clear three units of grass around.
 */
function* buildRoads(
  cx: number, cz: number, out: MeshBuilder, glass: MeshBuilder, detailed: boolean,
  smash: Smashable[], lamps: Array<{ x: number; y: number; z: number }>,
): Generator<void, Solid[], void> {
  const poleC = new THREE.Color('#22262a')
  const bulbC = new THREE.Color('#ffd9a0')
  const poles: Solid[] = []
  yield* buildStreetsSteps(cx, cz, out, detailed, (lx, y, lz, yaw, id) => {
    const dv = out.count
    const di = out.indexCount
    const gv = glass.count
    const gi = glass.indexCount
    streetLamp(out, glass, poleC, bulbC, lx, y, lz, yaw)
    // where the lens hangs, so the look can pool light under it at night
    // (render/pixelLook.ts): the arm's reach along the lamp's own +x
    lamps.push({ x: lx + Math.cos(yaw) * 2.2, y: y + LAMP_H + 0.3, z: lz - Math.sin(yaw) * 2.2 })
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
      id: `${cx},${cz}:L${id}`,
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
  })
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

/**
 * The town's lots that touch this chunk (streets.ts plats them along the
 * streets, once per town): the buildings whose footprint centre is in this
 * chunk, the parts of any park, plaza or car park that fall inside it, and a
 * keep-out rectangle for every other building touching it, which is handed
 * back so the scatterer keeps trees out of a neighbour's living room too. A
 * lot is no longer confined to a chunk, so a building can straddle a border;
 * the chunk its centre is in builds all of it.
 */
function* buildBlock(
  cx: number, cz: number, out: BuildOut, ground: Ground, leaves: MeshBuilder, layer: Layer,
): Generator<void, Solid[], void> {
  const ox = originX(cx)
  const oz = originZ(cz)
  const keep: Solid[] = []
  const inChunk = (x: number, z: number) => x >= ox && x < ox + CHUNK && z >= oz && z < oz + CHUNK

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

  // ids are the lot's own centre on a half-unit grid: a pure function of the
  // lot, and not of how many lots before it happened to build. The kit rolls
  // from its own stream seeded on that same centre (kitbash.ts's lotStream):
  // a kit draws more on a detailed build than on the outer ring (its window
  // lights, its dressing), so a shared stream meant promoting a chunk a tier
  // reshuffled every lot after the first, and the house you were walking
  // toward turned into a different house. The far field raises the same lot
  // off the same stream through the same kit (world/massing.ts), so from the
  // air it is that house too
  const raise = (kind: BuildKind, lot: Lot) => {
    const hx = Math.round(lot.x * 2)
    const hz = Math.round(lot.z * 2)
    out.clear = lotClear(lot.x, lot.z)
    recordStructure(out, `${cx},${cz}:B${hx},${hz}`, kind, lot.baseY,
      () => raiseKind(out, kind, lot))
    out.clear = undefined
  }

  /** trees on a jittered lattice through a rectangle, this chunk's share:
      a lattice in world space, so a park across a chunk border is one park */
  function* grove(
    x0: number, z0: number, x1: number, z1: number, step: number, rate: number,
    kinds: PropKind[], skip?: (x: number, z: number) => boolean,
  ): Generator<void, void, void> {
    const gx0 = Math.ceil(Math.max(x0, ox) / step)
    const gx1 = Math.floor(Math.min(x1, ox + CHUNK) / step)
    const gz0 = Math.ceil(Math.max(z0, oz) / step)
    const gz1 = Math.floor(Math.min(z1, oz + CHUNK) / step)
    for (let gz = gz0; gz <= gz1; gz++)
      for (let gx = gx0; gx <= gx1; gx++) {
        yield
        if (rand2(gx, gz, 0x3f19) > rate) continue
        const px = gx * step + (rand2(gx, gz, 0x1c55) - 0.5) * step * 0.7
        const pz = gz * step + (rand2(gx, gz, 0x6e21) - 0.5) * step * 0.7
        if (!inChunk(px, pz) || px < x0 + 2 || px > x1 - 2 || pz < z0 + 2 || pz > z1 - 2) continue
        if (inReserved(px, pz, 4) || skip?.(px, pz)) continue
        const py = terrainY(px, pz)
        if (py < SEA_Y + 0.5) continue
        const li = Math.min(VERTS - 1, Math.max(0, Math.round((px - ox) / GRID)))
        const lj = Math.min(VERTS - 1, Math.max(0, Math.round((pz - oz) / GRID)))
        const pal = paletteFor(ground.biome[lj * VERTS + li])
        const kind = kinds[Math.floor(rand2(gx, gz, 0x5a0b) * kinds.length)]
        const kit = kitsFor(kind)[Math.floor(rand2(gx, gz, 0x2e8d) * VARIANTS)]
        const sc = 0.9 + rand2(gx, gz, 0x7c31) * 0.4
        plant(out.solid, leaves, kit, kind, pal, px, py, pz, sc,
          rand2(gx, gz, 0x4411) * Math.PI * 2, rand2(gx, gz, 0x0d9e) * 2 - 1,
          out.boxes, out.smash, `${cx},${cz}:P${gx},${gz}`)
      }
  }

  const PLAZA = new THREE.Color('#8b877b')
  const STALL = new THREE.Color('#c9c4b4')
  const TARMAC = new THREE.Color('#303236')

  for (const t of townsNear(ox + CHUNK / 2, oz + CHUNK / 2)) {
    // a town's lots never reach past its rim
    if (Math.hypot(t.x - ox - CHUNK / 2, t.z - oz - CHUNK / 2) > t.radius * 1.35 + 100) continue
    for (const p of parcelsInChunk(t, cx, cz)) {
      yield
      if (p.use === 'park') {
        yield* grove(p.x0, p.z0, p.x1, p.z1, 11, 0.62, ['broadleaf', 'broadleaf', 'birch', 'bush'])
        continue
      }
      if (p.use === 'plaza') {
        // a paved square with its trees round the border, and the open
        // middle furnished (world/plaza.ts): fountain, benches, a market,
        // a café and planters
        layer.poly([p.x0, p.z0, p.x1, p.z0, p.x1, p.z1, p.x0, p.z1], 0.04, PLAZA, SURF.paving)
        const { hx, hz } = plazaInner(p)
        yield* grove(p.x0, p.z0, p.x1, p.z1, 7.5, 0.85, ['broadleaf'],
          (x, z) => Math.abs(x - p.x) < hx + 1 && Math.abs(z - p.z) < hz + 1)
        furnishPlaza(out, layer, p, inChunk)
        // the paving is laid, not graded, so pavedAt knows nothing of it:
        // without this the grass and the town's garden scatter grew
        // through the square
        out.interiors.push({ minX: p.x0, maxX: p.x1, minZ: p.z0, maxZ: p.z1 })
        continue
      }
      if (p.use === 'lot') {
        // a surface car park: tarmac to the footprint and a stall line every
        // three units across the frontage
        const x0 = p.x - p.w / 2
        const x1 = p.x + p.w / 2
        const z0 = p.z - p.d / 2
        const z1 = p.z + p.d / 2
        layer.poly([x0, z0, x1, z0, x1, z1, x0, z1], 0.035, TARMAC, SURF.asphalt)
        if (!out.detailed) continue
        const alongX = Math.abs(Math.cos(p.face)) > 0.5
        const span = alongX ? p.w : p.d
        const n = Math.floor(span / 3)
        for (let k = 1; k < n; k++) {
          const u = -span / 2 + (span / n) * k
          const stripe = alongX
            ? [p.x + u - 0.07, z0 + 1, p.x + u + 0.07, z0 + 1, p.x + u + 0.07, z1 - 1, p.x + u - 0.07, z1 - 1]
            : [x0 + 1, p.z + u - 0.07, x1 - 1, p.z + u - 0.07, x1 - 1, p.z + u + 0.07, x0 + 1, p.z + u + 0.07]
          layer.poly(stripe, 0.045, STALL)
        }
        continue
      }
      // a building: the chunk its centre is in raises it, every other chunk
      // it touches only keeps its trees off the footprint
      if (p.cx !== cx || p.cz !== cz) {
        keep.push(new THREE.Box3(
          new THREE.Vector3(p.x - p.w / 2, 0, p.z - p.d / 2),
          new THREE.Vector3(p.x + p.w / 2, 0, p.z + p.d / 2),
        ) as Solid)
        continue
      }
      const [baseY, topY] = groundUnder(p.x, p.z, p.w, p.d, p.kind === 'shop')
      if (baseY < SEA_Y + 1) continue
      // no building at all where the corners disagree by more than the plinth
      // can hide, and a shop on a slope builds a shell (buildings.ts's
      // settleKind, which the far field's impostors ask too). The rim of a
      // town is only half-graded now that the hills start there, and a house
      // sunk to its windowsills reads as the ground eating it
      const kind = settleKind(p.kind, p.district, baseY, topY)
      if (!kind) continue
      raise(kind, {
        x: p.x, z: p.z, w: p.w, d: p.d, baseY, topY, height: p.height, face: p.face,
        rng: lotStream(p.x, p.z),
      })
    }
  }
  return keep
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
  const y = terrainY(lm.x, lm.z)
  recordStructure(out, `${cx},${cz}:L`, lm.kind, y, () => buildLandmark(out, lm, y))
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
function* scatter(
  cx: number, cz: number, ground: Ground, built: Solid[],
  out: MeshBuilder, cardsOut: MeshBuilder, boxes: Solid[] | null,
  smash: Smashable[] | null, cover: boolean,
): Generator<void, void, void> {
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
        if (i % 8 === 0) yield
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
        // ...and a garden is not a wood: streets no longer come every 64
        // units, so a suburb has big back gardens far from any kerb, and the
        // biome's full density grew a forest in them. Trees thin with the
        // town, most in the middle, least toward the rim
        if (!cover && place.district &&
          rand3(cx, cz, id, 0x2c47) > mix(0.35, 0.7, smoothstep(0.55, 0.95, place.d))) continue
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

/** A partial build owns its geometry until completion. return() cancels it. */
export function* buildChunkSteps(
  cx: number, cz: number, tier: Tier, mats: ChunkMats, fade?: ChunkFade,
): Generator<void, Chunk, void> {
  const group = new THREE.Group()
  const geos: THREE.BufferGeometry[] = []
  let complete = false
  try {
    const boxes: Solid[] = []
    const lamps: Array<{ x: number; y: number; z: number }> = []

    // birth stamps per slice: the base (ground, water, roads, buildings, glass)
    // fades only on a brand-new chunk, flora only when the old tier had none,
    // and cover — which only 'full' builds — is new whenever anything fades
    const at = fade?.at ?? PREBORN
    const baseBirth = fade?.from === undefined ? at : PREBORN
    const floraBirth = fade?.from !== 'flora' ? at : PREBORN

    const ground = yield* buildGround(cx, cz)
    if (ground.geo) {
      geos.push(ground.geo)
      bakeBirth(ground.geo, baseBirth)
      const m = new THREE.Mesh(ground.geo, mats.ground)
      m.receiveShadow = true
      group.add(m)
    }

    yield
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
    const structures: StructureRec[] = []
    const rotors: RotorSpec[] = []
    const out: BuildOut = {
      solid: detail, glass, boxes, lamps, interiors, doors, smash: props, structures,
      detailed: tier !== 'bare',
      rotor: (x, y, z, ax, ay, az, rate) => {
        const b = createMeshBuilder()
        rotors.push({ b, x, y, z, axis: new THREE.Vector3(ax, ay, az).normalize(), rate })
        return b
      },
    }

    rotorsByOut.set(out, rotors)
    yield
    const poles = yield* buildRoads(cx, cz, detail, glass, out.detailed, props, lamps)
    const neighbours = yield* buildBlock(cx, cz, out, ground, leaves, makeLayer(cx, cz, detail))
    yield
    buildLandmarks(cx, cz, out)
    yield
    // everything in `boxes` at this point is a building — the roads register
    // theirs separately and the scatter has not run yet — so this is the
    // footprint list the scatterer needs to keep trees out of people's living
    // rooms. The lamp posts join afterwards: they collide, but clearing three
    // units of flora around each one would leave a bald ring down every verge
    const built = boxes.slice()
    // ...plus the buildings next door whose footprints reach into this chunk
    for (const b of neighbours) built.push(b)
    // ...and an enterable interior is a footprint with no box over most of it
    // (its walls register individually so the doorway stays open), so it joins
    // the scatter's keep-out list as a phantom: never collided with, only read
    // for its x/z extents here
    for (const r of interiors) {
      built.push(new THREE.Box3(
        new THREE.Vector3(r.minX, 0, r.minZ), new THREE.Vector3(r.maxX, 0, r.maxZ),
      ))
    }
    // ...and a landmark clears its whole graded pad, not just the boxes it
    // registered. A ring of standing stones is nine thin solids with the site
    // wide open between them, and a forest growing up through the middle of it
    // is the difference between a monument and a clearing that happens to have
    // rocks in it. Same phantom trick as an interior: never collided with, read
    // only for its extents. It is asked of every landmark whose pad could reach
    // this chunk, not only the one standing in it: a pad runs a good way past
    // its footprint, and the chunk next door used to grow a broadleaf up
    // through the edge of the ring
    const pads = new Set<Landmark>()
    const lx0 = originX(cx)
    const lz0 = originZ(cz)
    for (const [px, pz] of [[lx0, lz0], [lx0 + CHUNK, lz0], [lx0, lz0 + CHUNK], [lx0 + CHUNK, lz0 + CHUNK]]) {
      const l = landmarkAt(px, pz)
      if (l) pads.add(l)
    }
    for (const l of pads) {
      const r = Math.max(l.r, l.pad)
      built.push(new THREE.Box3(
        new THREE.Vector3(l.x - r, 0, l.z - r), new THREE.Vector3(l.x + r, 0, l.z + r),
      ))
    }
    for (const p of poles) boxes.push(p)
    // the builders' vertex counts, snapshotted between passes, are what turn
    // one merged soup into separately-born slices for the fade attribute
    const dFlora = detail.count
    const lFlora = leaves.count
    if (tier !== 'bare') yield* scatter(cx, cz, ground, built, detail, leaves, boxes, props, false)
    const dCover = detail.count
    const lCover = leaves.count
    if (tier === 'full') yield* scatter(cx, cz, ground, built, detail, leaves, null, null, true)

    /** base up to `m1`, flora up to `m2`, cover after — each at its own birth */
    const slicedBirth = (g: THREE.BufferGeometry, m1: number, m2: number) => {
      const a = new Float32Array(g.getAttribute('position').count)
      a.fill(baseBirth, 0, m1)
      a.fill(floraBirth, m1, m2)
      a.fill(at, m2)
      g.setAttribute('aBirth', new THREE.BufferAttribute(a, 1))
    }

    const smash: SmashSet = { key: `${cx},${cz}`, meshes: {}, props, structures, boxes, geos }
    yield
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
    yield
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
    yield
    const gg = glass.build()
    if (gg) {
      geos.push(gg)
      bakeBirth(gg, baseBirth)
      const m = new THREE.Mesh(gg, mats.glass)
      m.renderOrder = 2
      group.add(m)
      smash.meshes.glass = m
    }

    const spinners: Spinner[] = []
    for (const r of rotors) {
      yield
      const g = r.b.build()
      if (!g) continue
      // re-based on its pivot, so the mesh turns about its own origin
      g.translate(-r.x, -r.y, -r.z)
      g.computeBoundingSphere()
      geos.push(g)
      bakeBirth(g, baseBirth)
      const m = new THREE.Mesh(g, mats.detail)
      m.position.set(r.x, r.y, r.z)
      m.castShadow = true
      m.receiveShadow = true
      group.add(m)
      spinners.push({ mesh: m, axis: r.axis, rate: r.rate })
      if (r.rec) (r.rec.rotors ??= []).push(m)
    }

    group.updateMatrixWorld(true)
    group.traverse((o) => {
      o.matrixAutoUpdate = false
    })
    // ...all but what turns, which also opts out of the scene's own freeze
    for (const sp of spinners) {
      sp.mesh.matrixAutoUpdate = true
      sp.mesh.userData.dynamic = true
    }
    // door ids are position-stable across rebuilds, so the session's open/shut
    // state survives a tier change or a ring exit and return
    doors.forEach((d, i) => {
      d.id = `${cx},${cz}:${i}`
    })
    complete = true
    return { cx, cz, tier, group, geos, boxes, lamps, interiors, doors, smash, structures, spinners }
  } finally {
    if (!complete) for (const g of geos) g.dispose()
  }
}

/** Synchronous entry for covered boot, collision backstops and offline probes. */
export const buildChunk = (
  cx: number, cz: number, tier: Tier, mats: ChunkMats, fade?: ChunkFade,
): Chunk => {
  const steps = buildChunkSteps(cx, cz, tier, mats, fade)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
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
