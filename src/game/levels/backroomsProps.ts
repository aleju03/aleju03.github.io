import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/*
  The stuff left behind in level 0. Canon is emphatic that the Lobby is
  empty — the emptiness is the horror — so this places very little: one to
  three pieces of furniture in a whole 40-unit chunk, nothing at all in the
  room you arrive in, and always the same pieces in the same places, seeded
  off the chunk's coordinates like everything else down here. What it does
  place is what the wikis agree is down there: overturned office chairs,
  broken desks (wearing the beige CRTs this site is already made of),
  filing cabinets, retail-stockroom cardboard and pallets, a dead vending
  machine, and the odd bottle of almond water. Wall outlets and the hole
  where a ceiling tile fell out are the cheap details that sell the rest.

  Placement obeys two rules that keep the maze walkable. Free-standing
  pieces demand a clear radius, so they land in the middle of open rooms
  (which is also where a lone chair looks the way the photographs do) and
  never in a doorway; anything big — cabinets, pallets, the vending machine
  — hugs a solid wall run, where it can't block a gap that isn't there.

  Everything is code-built boxes and cylinders carrying their color in the
  vertex stream, so a chunk's entire prop set merges into one draw call
  against one untextured material. Anything tall enough to stop a body
  hands back a collision box; anything you would step over (bottles,
  outlets, the ceiling hole) deliberately doesn't get one, because
  collision down here is x/z only and a knee-high box you can't walk
  through reads worse than one you walk into.

  Scale note: one unit is about half a metre (the eye rides at 3.5), so a
  chair stands ~1.9 units and a desk top sits at 1.5.
*/

/** the palette, warm enough to sit inside the level's mono-yellow light */
const C = {
  chair: '#2b2823',
  seat: '#39332a',
  desk: '#7c6a4c',
  metal: '#4b463d',
  cabinet: '#968b7c',
  crt: '#c6bb9e',
  screen: '#1c1b17',
  carton: '#8d7857',
  pallet: '#8a6c42',
  vending: '#4e5158',
  glass: '#24272e',
  bottle: '#d6dfd1',
  outlet: '#cabd97',
  // the plenum above a missing tile. Lit only by the hemisphere's ground
  // term, so it renders far darker than it reads here — but not black:
  // black up there looks like a rendering fault, not a missing tile
  hole: '#5a4a31',
}

/** paint a color into a geometry's vertex stream; one material for all props */
const tint = (g: THREE.BufferGeometry, hex: string) => {
  const c = new THREE.Color(hex)
  const n = g.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

const box = (w: number, h: number, d: number, hex: string) =>
  tint(new THREE.BoxGeometry(w, h, d), hex)
const tube = (r: number, h: number, hex: string, seg = 8) =>
  tint(new THREE.CylinderGeometry(r, r, h, seg), hex)
/** props are modelled standing on the origin, facing +z */
const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z)

/* ------------------------------------------------------------- the props */

/** the icon of the place: a five-star swivel chair, upright or on its side */
const officeChair = (rng: () => number) => {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 5; i++) {
    const spoke = at(box(0.66, 0.1, 0.17, C.chair), 0.33, 0.12, 0)
    spoke.rotateY((i / 5) * Math.PI * 2 + rng() * 0.3)
    parts.push(spoke)
  }
  parts.push(at(tube(0.09, 0.62, C.chair), 0, 0.48, 0))
  parts.push(at(box(1.02, 0.17, 0.98, C.seat), 0, 0.86, 0))
  parts.push(at(box(0.92, 1.02, 0.15, C.seat), 0, 1.45, -0.42))
  for (const s of [-1, 1]) parts.push(at(box(0.11, 0.1, 0.62, C.chair), s * 0.53, 1.07, -0.05))
  return parts
}

/** a beige CRT and its keyboard, the desk's whole reason for being here */
const terminal = () => [
  at(box(1.0, 0.16, 0.9, C.crt), 0, 1.6, -0.2),
  at(box(1.15, 1.0, 1.05, C.crt), 0, 2.14, -0.2),
  at(box(0.86, 0.68, 0.06, C.screen), 0, 2.22, 0.34),
  at(box(1.0, 0.09, 0.36, C.crt), 0.15, 1.57, 0.58),
]

const desk = (rng: () => number) => {
  const parts = [at(box(3.3, 0.16, 1.7, C.desk), 0, 1.44, 0)]
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      parts.push(at(box(0.14, 1.44, 0.14, C.metal), sx * 1.5, 0.72, sz * 0.72))
  // a modesty panel, so the silhouette still reads as a desk across a room
  parts.push(at(box(3.0, 0.72, 0.1, C.metal), 0, 1.02, -0.76))
  if (rng() < 0.65) parts.push(...terminal())
  return parts
}

/** stockroom cardboard: one to three boxes, stacked a little carelessly */
const cartons = (rng: () => number) => {
  const parts: THREE.BufferGeometry[] = []
  let y = 0
  const n = 1 + Math.floor(rng() * 3)
  for (let i = 0; i < n; i++) {
    const w = 1.0 + rng() * 0.5
    const h = 0.72 + rng() * 0.42
    const g = box(w, h, w * (0.8 + rng() * 0.4), C.carton)
    g.rotateY((rng() - 0.5) * 0.7)
    g.translate((rng() - 0.5) * 0.3, y + h / 2, (rng() - 0.5) * 0.3)
    parts.push(g)
    y += h
  }
  return parts
}

const cabinet = (rng: () => number) => {
  const parts = [at(box(1.2, 2.5, 1.4, C.cabinet), 0, 1.25, 0)]
  for (let i = 0; i < 3; i++) {
    parts.push(at(box(0.94, 0.05, 0.05, C.metal), 0, 0.5 + i * 0.74, 0.71))
    parts.push(at(box(1.1, 0.025, 0.02, C.metal), 0, 0.86 + i * 0.74, 0.71))
  }
  if (rng() < 0.4) parts.push(at(box(0.9, 0.05, 0.62, C.carton), 0.12, 2.53, -0.08))
  return parts
}

/** a pallet stood on its edge against the wall, leaning back a touch */
const pallet = () => {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 6; i++) parts.push(at(box(2.4, 0.16, 0.12, C.pallet), 0, 0.22 + i * 0.46, 0))
  for (const s of [-1, 0, 1]) parts.push(at(box(0.18, 2.5, 0.12, C.pallet), s * 1.0, 1.3, -0.11))
  const lean = new THREE.Matrix4().makeRotationX(-0.17)
  for (const p of parts) p.applyMatrix4(lean)
  return parts
}

/** dead vending machine: the only place almond water was ever stocked */
const vending = () => [
  at(box(2.0, 4.2, 1.5, C.vending), 0, 2.1, 0),
  at(box(1.32, 3.0, 0.08, C.glass), -0.26, 2.5, 0.76),
  at(box(0.46, 1.05, 0.06, C.metal), 0.7, 2.2, 0.76),
  at(box(1.7, 0.28, 0.12, C.metal), 0, 0.6, 0.76),
]

const bottle = () => [
  at(tube(0.13, 0.42, C.bottle, 7), 0, 0.21, 0),
  at(tube(0.06, 0.13, C.bottle, 6), 0, 0.48, 0),
]

/* ------------------------------------------------------------- placement */

export interface BackroomsPropsInput {
  /** the chunk's own RNG stream, seeded off its coordinates */
  rng: () => number
  /** chunk origin and span, world units */
  ox: number
  oz: number
  chunk: number
  floorY: number
  ceilY: number
  /** the chunk's solid wall runs; one axis of each is constant */
  pieces: ReadonlyArray<{ x0: number; z0: number; x1: number; z1: number }>
  /** wall thickness, so wall-huggers sit proud of the paper */
  wallTh: number
  /** solids already registered for this chunk — props keep out of them */
  solids: ReadonlyArray<THREE.Box3>
  /** a circle to leave completely alone (the arrival alcove) */
  keepClear?: { x: number; z: number; r: number }
}

export interface BackroomsProps {
  /** the whole chunk's props as one vertex-colored geometry (null if none) */
  geometry: THREE.BufferGeometry | null
  /** boxes for the pieces tall enough to stop a body */
  boxes: THREE.Box3[]
}

/** how far props stay inside their own chunk, so none straddle a seam */
const MARGIN = 3.5
/** shoulder room around a prop's true footprint, matching the wall boxes */
const PAD = 0.35

export function buildBackroomsProps(o: BackroomsPropsInput): BackroomsProps {
  const { rng, ox, oz, chunk, floorY, ceilY, pieces, wallTh, solids, keepClear } = o
  const parts: THREE.BufferGeometry[] = []
  const boxes: THREE.Box3[] = []
  const taken: THREE.Box3[] = [] // everything placed so far, solid or not

  const near = (list: ReadonlyArray<THREE.Box3>, x: number, z: number, r: number) =>
    list.some((b) => x > b.min.x - r && x < b.max.x + r && z > b.min.z - r && z < b.max.z + r)

  const room = (x: number, z: number, r: number, offWalls = true) => {
    if (keepClear && (x - keepClear.x) ** 2 + (z - keepClear.z) ** 2 < keepClear.r ** 2) return false
    if (offWalls && near(solids, x, z, r)) return false
    return !near(taken, x, z, r)
  }

  /** stamp a prop into the chunk: transform its parts, merge, keep its box */
  const drop = (
    local: THREE.BufferGeometry[],
    x: number,
    z: number,
    yaw: number,
    opt: { solid?: boolean; mark?: boolean; lift?: number; roll?: number } = {},
  ) => {
    const m = new THREE.Matrix4().makeRotationY(yaw)
    if (opt.roll) m.multiply(new THREE.Matrix4().makeRotationZ(opt.roll))
    m.premultiply(new THREE.Matrix4().makeTranslation(x, floorY + (opt.lift ?? 0), z))
    for (const g of local) g.applyMatrix4(m)
    const merged = mergeGeometries(local)
    for (const g of local) g.dispose()
    if (!merged) return
    parts.push(merged)
    merged.computeBoundingBox()
    const bb = merged.boundingBox
    if (!bb) return
    // the footprint the placer reserves spans the whole storey (it only ever
    // asks about x/z), but the solid stops at the prop's real top — that top
    // is a surface the player can hop onto, and a box stretched to the
    // ceiling would be an invisible pillar instead
    if (opt.mark !== false) {
      taken.push(new THREE.Box3(
        new THREE.Vector3(bb.min.x - PAD, floorY, bb.min.z - PAD),
        new THREE.Vector3(bb.max.x + PAD, ceilY, bb.max.z + PAD),
      ))
    }
    if (opt.solid) {
      boxes.push(new THREE.Box3(
        new THREE.Vector3(bb.min.x - PAD, floorY, bb.min.z - PAD),
        new THREE.Vector3(bb.max.x + PAD, bb.max.y, bb.max.z + PAD),
      ))
    }
  }

  /** an open spot with `clear` units of nothing around it, or null */
  const openSpot = (clear: number) => {
    for (let i = 0; i < 14; i++) {
      const x = ox + MARGIN + rng() * (chunk - 2 * MARGIN)
      const z = oz + MARGIN + rng() * (chunk - 2 * MARGIN)
      if (room(x, z, clear)) return { x, z }
    }
    return null
  }

  /** a spot flat against a wall run long enough to hide the prop's back.
      Clearance here only has to dodge *other* walls and props: the run it
      leans on is the whole point, so it is tested at arm's length. */
  const wallSpot = (minRun: number, depth: number) => {
    if (!pieces.length) return null
    for (let i = 0; i < 12; i++) {
      const p = pieces[Math.floor(rng() * pieces.length)]
      const alongX = p.z0 === p.z1
      const run = alongX ? p.x1 - p.x0 : p.z1 - p.z0
      if (run < minRun) continue
      const u = minRun / 2 + rng() * (run - minRun)
      const side = rng() < 0.5 ? 1 : -1
      const off = wallTh / 2 + depth
      const x = alongX ? p.x0 + u : p.x0 + side * off
      const z = alongX ? p.z0 + side * off : p.z0 + u
      if (x < ox + MARGIN || x > ox + chunk - MARGIN) continue
      if (z < oz + MARGIN || z > oz + chunk - MARGIN) continue
      if (!room(x, z, 0.45, false)) continue
      if (near(taken, x, z, depth + 0.8)) continue
      const yaw = alongX
        ? side > 0
          ? 0
          : Math.PI
        : side > 0
          ? Math.PI / 2
          : -Math.PI / 2
      return { x, z, yaw }
    }
    return null
  }

  // two to four free-standing pieces: the lonely stuff, out in the open.
  // Canon would say one; that reads as nothing at all through fog this
  // close, so the level errs a little toward being furnished
  const n = 2 + (rng() < 0.55 ? 1 : 0) + (rng() < 0.25 ? 1 : 0)
  for (let i = 0; i < n; i++) {
    const roll = rng()
    if (roll < 0.42) {
      const s = openSpot(2.4)
      if (!s) continue
      // half of them have been knocked over, which is how they always look
      const tipped = rng() < 0.45
      drop(officeChair(rng), s.x, s.z, rng() * Math.PI * 2, {
        solid: true,
        roll: tipped ? (rng() < 0.5 ? 1.42 : -1.42) : 0,
        lift: tipped ? 0.55 : 0,
      })
    } else if (roll < 0.72) {
      const s = openSpot(2.2)
      if (!s) continue
      drop(cartons(rng), s.x, s.z, rng() * Math.PI * 2, { solid: true })
    } else if (roll < 0.93) {
      const s = openSpot(3.2)
      if (!s) continue
      drop(desk(rng), s.x, s.z, rng() * Math.PI * 2, { solid: true })
    } else {
      const s = openSpot(1.2)
      if (!s) continue
      drop(bottle(), s.x, s.z, rng() * Math.PI * 2)
    }
  }

  // and one or two things shoved against a wall
  for (let i = 0; i < (rng() < 0.45 ? 2 : 1); i++) {
    const wall = rng()
    if (wall < 0.34) {
      const s = wallSpot(3.0, 0.75)
      if (s) drop(cabinet(rng), s.x, s.z, s.yaw, { solid: true })
    } else if (wall < 0.66) {
      const s = wallSpot(4.0, 0.45)
      if (s) drop(pallet(), s.x, s.z, s.yaw, { solid: true })
    } else if (wall < 0.78) {
      const s = wallSpot(5.0, 0.8)
      if (s) drop(vending(), s.x, s.z, s.yaw, { solid: true })
    }
  }

  // outlets: the detail canon never leaves out, and the cheapest one here
  const outlets = 1 + Math.floor(rng() * 3)
  for (let i = 0; i < outlets; i++) {
    const s = wallSpot(1.6, 0.02)
    if (s) drop([at(box(0.22, 0.32, 0.04, C.outlet), 0, 0.62, 0)], s.x, s.z, s.yaw, { mark: false })
  }

  // and now and then a tile is simply gone from the grid overhead. The
  // ceiling texture repeats every 2 units from the chunk corner, so the hole
  // snaps to that grid and lands inside one tile's T-bar frame
  if (rng() < 0.35) {
    const s = openSpot(1.6)
    if (s) {
      const tx = ox + Math.round((s.x - ox - 1) / 2) * 2 + 1
      const tz = oz + Math.round((s.z - oz - 1) / 2) * 2 + 1
      drop([at(box(1.9, 0.06, 1.9, C.hole), 0, 0, 0)], tx, tz, 0, {
        lift: ceilY - floorY - 0.05,
        mark: false,
      })
    }
  }

  const geometry = parts.length ? mergeGeometries(parts) : null
  for (const g of parts) g.dispose()
  return { geometry, boxes }
}
