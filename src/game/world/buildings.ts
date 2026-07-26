import * as THREE from 'three'
import type { MeshBuilder } from '../core/geometry'
import { noStand, type Solid } from '../physics/collision'
import type { District } from './settlements'
import type { InteriorRect } from './interiors'
import type { ShopDoorSpec } from './shopDoors'
import type { Smashable } from './debris'
import { SURF, type SurfaceId } from './surface'

/*
  The built environment: what stands inside a block once settlements.ts has
  decided the block is downtown, mid-rise or suburb.

  Four kits, all stamped through the same mesh builder as the trees so a whole
  city block still costs one opaque draw call plus one for its glass. Windows
  go into a separate builder because they are the only thing out here that
  changes with the clock — one emissive material for the lot, faded up at dusk
  and killed at dawn, which is what makes a skyline read as inhabited without
  a single light source in the scene.

  Three of the kits are shells: solid boxes with detail on the outside and one
  collision box around them. The fourth is not. `shopFront` builds a real
  ground floor — four walls with a doorway facing the street, a raised plank
  floor the player actually stands on, shelving with goods, a counter — and
  registers its walls individually so the doorway is genuinely walk-through.
  Those are the ones with an actual inside, scattered a few to a town, and
  they exist because a city you can only walk *between* gets old faster than
  one you can occasionally walk *into*. The floor is graded to the *highest*
  ground under the footprint (terrain under a lot is never level, and a floor
  at the lowest corner is a floor the ground grows through) and meets the
  street with a stoop; the footprint reports itself to `out.interiors` so the
  grass field and the scatterer keep out of the sales floor.

  Everything sits on `baseY`, which the chunk builder resolves as the lowest
  ground under the footprint, and every kit extends its walls a little below
  that: the terrain under a 40-unit footprint is graded but not perfectly
  level, and a skirt is cheaper than conforming the geometry to the ground.
*/

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
      makes goes in here — a shopfront is not something you drive through —
      but the park trees a block plants instead of housing do */
  smash: Smashable[]
  /**
   * false on the outer ring, where a building is a silhouette on the skyline
   * and nothing more. Window grids are the single most expensive thing the
   * city builds — a downtown block runs to a couple of thousand quads — and
   * at four chunks out not one of them is resolvable. Bodies, roofs and
   * parapets still build, because those are the shape you actually read.
   */
  detailed: boolean
}

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

const BOX = new THREE.BoxGeometry(1, 1, 1)
const PLANE = new THREE.PlaneGeometry(1, 1)
const CONE4 = new THREE.ConeGeometry(0.707, 1, 4)
CONE4.rotateY(Math.PI / 4)

/** a unit gable prism: eaves at y=0, ridge along x at y=1, ends capped, no
    floor. Built face by face so each plane shades flat — a suburb where every
    roof is the same pyramid is most of what "copy-paste" means from the
    street, and this is the cheapest second silhouette there is. */
const PRISM = (() => {
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  const face = (pts: number[][], n: number[]) => {
    const base = pos.length / 3
    for (const p of pts) {
      pos.push(p[0], p[1], p[2])
      nor.push(n[0], n[1], n[2])
    }
    idx.push(base, base + 1, base + 2)
    if (pts.length === 4) idx.push(base, base + 2, base + 3)
  }
  const k = 1 / Math.hypot(0.5, 1)
  face([[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 1, 0]], [0, 0.5 * k, 1 * k])
  face([[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0]], [0, 0.5 * k, -1 * k])
  face([[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0]], [1, 0, 0])
  face([[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0]], [-1, 0, 0])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  g.setIndex(idx)
  return g
})()

const tmpM = new THREE.Matrix4()
const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpP = new THREE.Vector3()
const tmpS = new THREE.Vector3()
const col = new THREE.Color()

/** an axis-aligned box in world space, painted flat. `surf` picks which
    procedural treatment world/surface.ts gives it — that one float per stamp
    is the whole reason a wall out here is brickwork rather than a rectangle */
const box = (
  out: MeshBuilder,
  hex: string,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  yaw = 0,
  surf: SurfaceId = SURF.plaster,
) => {
  tmpQ.setFromEuler(tmpE.set(0, yaw, 0))
  tmpM.compose(tmpP.set(cx, cy, cz), tmpQ, tmpS.set(w, h, d))
  out.surface = surf
  out.add(BOX, tmpM, col.set(hex))
  out.surface = SURF.none
}

/** a wall-hugging quad, used for windows and doors */
const panel = (
  out: MeshBuilder,
  hex: string,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  yaw: number,
  surf: SurfaceId = SURF.none,
) => {
  tmpQ.setFromEuler(tmpE.set(0, yaw, 0))
  tmpM.compose(tmpP.set(cx, cy, cz), tmpQ, tmpS.set(w, h, 1))
  out.surface = surf
  out.add(PLANE, tmpM, col.set(hex))
  out.surface = SURF.none
}

// warm renders, sages, dusty blues, terracottas: a street stops reading as
// one house photocopied when the palette has actual hue in it, not six greys
const BODY = [
  '#6f6a5f', '#7b6f60', '#665f57', '#7a7268', '#5f6a6c', '#836f5c',
  '#8a6f52', '#75806a', '#697a85', '#93826b', '#7d666a', '#a08a67',
]
const ROOFS = ['#43392f', '#3a3f41', '#4a3c33', '#38342e', '#59362e', '#3c4a42']
const TOWER = ['#5a626b', '#4e555d', '#646a70', '#565e63', '#6a6f74']
/** what unlit window glass reads as by day: sky in a dark room */
const GLASS_DARK = '#2e3a44'

/* ------------------------------------------------------- suburb house -- */

/**
 * A house on a lot. The bones are always body + roof + door + windows, but
 * almost everything about them rolls: one or two storeys, gable or pyramid
 * or flat roof, brick or render, a porch, an attached garage, a hedge and a
 * front path. Six of one and half a dozen of the other is what a street of
 * these needs to stop reading as one house repeated. One collision box per
 * solid mass, noStand — the roofs are above the box tops.
 */
export const suburbHouse = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const w = lot.w
  const d = lot.d
  const two = rng() < 0.3
  const h = two
    ? Math.max(9.6, Math.min(lot.height * 1.35, 12.2))
    : Math.max(6.5, Math.min(lot.height, 8.8))
  const body = BODY[Math.floor(rng() * BODY.length)]
  const roof = ROOFS[Math.floor(rng() * ROOFS.length)]
  const trim = '#d8d2c4'
  const y = lot.baseY
  // about a third of a street is brick and the rest is rendered, which is
  // what stops a row of houses reading as one material repeated
  const skin = rng() < 0.34 ? SURF.brick : SURF.plaster
  const fwd = new THREE.Vector3(0, 0, d / 2 + 0.06).applyEuler(tmpE.set(0, lot.face, 0))
  const side = new THREE.Vector3(1, 0, 0).applyEuler(tmpE.set(0, lot.face, 0))
  // the unit forward normal. Offsets stamped along `fwd` itself scale with
  // the lot's depth — that bug put the glass pane in front of its frame on
  // deep lots and *inside* it on shallow ones, where the frame's own front
  // face won the depth test and the window rendered as a blank trim plate
  const ufx = fwd.x / (d / 2 + 0.06)
  const ufz = fwd.z / (d / 2 + 0.06)

  box(out.solid, body, lot.x, y + h / 2 - 0.6, lot.z, w, h + 1.2, d, lot.face, skin)
  // a plinth: houses meet the ground on something, and the shadow line under
  // it is most of what gives a flat facade a bottom
  box(out.solid, '#57514a', lot.x, y + 0.35, lot.z,
    w + 0.34, 0.9, d + 0.34, lot.face, SURF.paving)
  if (two) {
    // a floor band between the storeys, so "tall house" reads as two floors
    box(out.solid, '#4e4840', lot.x, y + h * 0.52, lot.z,
      w + 0.16, 0.32, d + 0.16, lot.face, SURF.plank)
  }

  // the roof: half the street gabled, most of the rest pyramids, the odd
  // flat parapet. Gable ridges run the house's long axis.
  const roofRoll = rng()
  const roofH = 2.2 + Math.min(w, d) * 0.13
  out.solid.surface = SURF.shingle
  if (roofRoll < 0.5) {
    const ridgeAlongW = w >= d
    tmpQ.setFromEuler(tmpE.set(0, lot.face + (ridgeAlongW ? 0 : Math.PI / 2), 0))
    tmpM.compose(
      tmpP.set(lot.x, y + h - 0.05, lot.z),
      tmpQ,
      tmpS.set((ridgeAlongW ? w : d) * 1.14, roofH * 1.15, (ridgeAlongW ? d : w) * 1.14),
    )
    out.solid.add(PRISM, tmpM, col.set(roof))
  } else if (roofRoll < 0.9) {
    tmpQ.setFromEuler(tmpE.set(0, lot.face, 0))
    tmpM.compose(
      tmpP.set(lot.x, y + h + roofH / 2 - 0.05, lot.z),
      tmpQ,
      tmpS.set(w * 1.12, roofH, d * 1.12),
    )
    out.solid.add(CONE4, tmpM, col.set(roof))
  } else {
    out.solid.surface = SURF.paving
    box(out.solid, '#4c4740', lot.x, y + h + 0.22, lot.z,
      w + 0.4, 0.5, d + 0.4, lot.face)
  }
  out.solid.surface = SURF.none
  // the eave the roof sits on, which reads as an overhang from the street
  box(out.solid, '#38322b', lot.x, y + h - 0.04, lot.z,
    w * 1.14, 0.34, d * 1.14, lot.face, SURF.plank)

  const doorOff = (rng() - 0.5) * w * 0.3
  const dx = lot.x + fwd.x + side.x * doorOff
  const dz = lot.z + fwd.z + side.z * doorOff

  if (out.detailed) {
    // front face: door plus a window either side of it, and an upper row on a
    // two-storey. Every window paints dark glass into the solid pass first —
    // the emissive copy in the glass pass is invisible by day, and a frame
    // with nothing in it read as a blank sheet of paper stuck to the wall.
    // the authored house's door stands 4.7; anything shorter out here reads
    // as a dollhouse next to a 3.55-unit eye line
    box(out.solid, trim, dx, y + 2.7, dz, 2.3, 5.4, 0.18, lot.face, SURF.plaster)
    panel(out.solid, '#33261a', dx + ufx * 0.12, y + 2.45, dz + ufz * 0.12,
      1.9, 4.9, lot.face, SURF.plank)
    const litRate = 0.35 + rng() * 0.5
    /** frame + always-dark glass + a sometimes-lit emissive copy. `nx, nz`
        must be the *unit* wall normal: the frame box is 0.16 deep, so the
        pane sits 0.10 out and the emissive copy 0.14 */
    const window_ = (wx: number, wz: number, wy: number, ww: number, wh: number, yaw: number,
      nx: number, nz: number) => {
      box(out.solid, trim, wx, wy, wz, ww + 0.4, wh + 0.4, 0.16, yaw, SURF.plaster)
      panel(out.solid, GLASS_DARK, wx + nx * 0.1, wy, wz + nz * 0.1, ww, wh, yaw)
      if (rng() < litRate) {
        panel(out.glass, '#ffd9a0', wx + nx * 0.14, wy, wz + nz * 0.14, ww, wh, yaw)
      }
    }
    const rows = two ? [3.3, h * 0.52 + 2.7] : [3.3]
    for (const [ri, wy] of rows.map((v, i) => [i, v] as const)) {
      for (const s of [-1, 1]) {
        const o = doorOff + s * w * 0.31
        if (Math.abs(o) > w * 0.42) continue
        if (ri === 0 || rng() < 0.85) {
          window_(lot.x + fwd.x + side.x * o, lot.z + fwd.z + side.z * o,
            y + wy, 1.7, 1.5, lot.face, ufx, ufz)
        }
      }
      // and one on each flank, so the house is not a facade with three blanks
      for (const s of [-1, 1]) {
        const off = new THREE.Vector3(s * (w / 2 + 0.06), 0, 0)
          .applyEuler(tmpE.set(0, lot.face, 0))
        window_(lot.x + off.x, lot.z + off.z, y + wy, 1.5, 1.4,
          lot.face + (s * Math.PI) / 2, off.x / (w / 2 + 0.06), off.z / (w / 2 + 0.06))
      }
    }

    // the front path, door to kerbward edge of the lot
    box(out.solid, '#8b867c', dx + fwd.x * 2.4 / (d / 2 + 0.06), y + 0.04,
      dz + fwd.z * 2.4 / (d / 2 + 0.06), 1.3, 0.09, 4.6, lot.face, SURF.paving)

    // a porch over the door, on posts
    if (rng() < 0.42) {
      const px = dx + fwd.x * 1.0 / (d / 2 + 0.06)
      const pz = dz + fwd.z * 1.0 / (d / 2 + 0.06)
      box(out.solid, '#5a5148', px, y + 0.22, pz, 4.0, 0.44, 2.2, lot.face, SURF.plank)
      // the canopy clears the door, and therefore anyone walking under it —
      // the first cut hung it at 3.35, squarely at forehead height
      box(out.solid, roof, px, y + 5.85, pz, 4.5, 0.24, 2.6, lot.face, SURF.plank)
      for (const s of [-1, 1]) {
        box(out.solid, trim,
          px + side.x * s * 1.8 + fwd.x * 0.8 / (d / 2 + 0.06),
          y + 3.1,
          pz + side.z * s * 1.8 + fwd.z * 0.8 / (d / 2 + 0.06),
          0.2, 5.3, 0.2, lot.face)
      }
    }

    // a hedge along part of the frontage
    if (rng() < 0.36) {
      const hs = rng() < 0.5 ? -1 : 1
      const hx = lot.x + fwd.x * (1 + 1.4 / (d / 2 + 0.06)) + side.x * hs * w * 0.3
      const hz = lot.z + fwd.z * (1 + 1.4 / (d / 2 + 0.06)) + side.z * hs * w * 0.3
      box(out.solid, '#3d5230', hx, y + 0.45, hz, w * 0.34, 0.9, 0.8, lot.face)
      // the box has to follow the yaw: faces are right angles, so the two
      // extents just swap axes with the house
      const hex = Math.abs(side.x) * w * 0.17 + Math.abs(fwd.x / (d / 2 + 0.06)) * 0.4
      const hez = Math.abs(side.z) * w * 0.17 + Math.abs(fwd.z / (d / 2 + 0.06)) * 0.4
      out.boxes.push(new THREE.Box3(
        new THREE.Vector3(hx - hex - 0.15, y - 1, hz - hez - 0.15),
        new THREE.Vector3(hx + hex + 0.15, y + 0.9, hz + hez + 0.15),
      ))
    }
  }

  // an attached garage on a wide enough lot: lower, flat-roofed, big door
  if (rng() < 0.4 && w > 9.5) {
    const gs = doorOff > 0 ? -1 : 1
    const gw = w * 0.44
    const gd = d * 0.78
    const gh = 4.9
    const gx = lot.x + side.x * gs * (w / 2 + gw / 2 - 0.15)
    const gz = lot.z + side.z * gs * (w / 2 + gw / 2 - 0.15)
    box(out.solid, body, gx, y + gh / 2 - 0.5, gz, gw, gh + 1, gd, lot.face, skin)
    box(out.solid, '#4c4740', gx, y + gh + 0.16, gz, gw + 0.3, 0.4, gd + 0.3, lot.face, SURF.paving)
    if (out.detailed) {
      panel(out.solid, '#4a4640',
        gx + fwd.x * (gd / 2 + 0.06) / (d / 2 + 0.06), y + 2.1,
        gz + fwd.z * (gd / 2 + 0.06) / (d / 2 + 0.06), gw * 0.66, 4.0, lot.face, SURF.plank)
    }
    const gex = Math.abs(side.x) * gw / 2 + Math.abs(fwd.x / (d / 2 + 0.06)) * gd / 2
    const gez = Math.abs(side.z) * gw / 2 + Math.abs(fwd.z / (d / 2 + 0.06)) * gd / 2
    out.boxes.push(noStand(new THREE.Box3(
      new THREE.Vector3(gx - gex - 0.25, y - 2, gz - gez - 0.25),
      new THREE.Vector3(gx + gex + 0.25, y + gh, gz + gez + 0.25),
    )))
  }

  if (rng() < 0.5) {
    box(out.solid, '#41372f', lot.x + w * 0.26, y + h + roofH * 0.5, lot.z - d * 0.2,
      0.7, 2.4, 0.7, 0, SURF.brick)
  }

  out.boxes.push(noStand(new THREE.Box3(
    new THREE.Vector3(lot.x - w / 2 - 0.3, y - 2, lot.z - d / 2 - 0.3),
    new THREE.Vector3(lot.x + w / 2 + 0.3, y + h, lot.z + d / 2 + 0.3),
  )))
}

/* --------------------------------------------------------- mid-rise ---- */

/**
 * A walk-up block: a body with a floor band every storey, a window grid on
 * the two long faces, a parapet and a roof box or two.
 */
export const midriseBlock = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const w = lot.w
  const d = lot.d
  const storeys = Math.max(3, Math.round(lot.height / 4.6))
  const h = storeys * 4.6
  const body = BODY[Math.floor(rng() * BODY.length)]
  const y = lot.baseY

  box(out.solid, body, lot.x, y + h / 2 - 0.8, lot.z, w, h + 1.6, d, 0, SURF.brick)
  // parapet: a slightly wider, darker lip so the roofline has an edge
  box(out.solid, '#4c4740', lot.x, y + h + 0.35, lot.z, w + 0.5, 0.7, d + 0.5, 0, SURF.paving)
  // and a stone band at street level, the way a walk-up always has
  box(out.solid, '#585349', lot.x, y + 1.1, lot.z, w + 0.3, 2.4, d + 0.3, 0, SURF.paving)
  if (rng() < 0.7) {
    box(out.solid, '#4c4740', lot.x + (rng() - 0.5) * w * 0.4, y + h + 1.9,
      lot.z + (rng() - 0.5) * d * 0.4, 3.4, 2.4, 3.0, 0, SURF.plaster)
  }

  if (out.detailed) {
    // the body is stamped axis-aligned, so its front is a *cardinal* and the
    // wall stands a whole half-extent away along it. Reading that distance off
    // `d` while the face pointed down x is what left the entrance hanging in
    // mid-air a metre clear of the brickwork, on a lot where w and d roll
    // independently
    const fx = Math.round(Math.sin(lot.face))
    const fz = Math.round(Math.cos(lot.face))
    const wall = (fx ? w : d) / 2
    /** a point on the front: `o` along the wall, `n` out from its face */
    const ex = (o: number, n: number) => lot.x + fx * (wall + n) + fz * o
    const ez = (o: number, n: number) => lot.z + fz * (wall + n) - fx * o

    // window grid on all four faces; the lit fraction is per-building so some
    // blocks are mostly home and some mostly out
    const litRate = 0.3 + rng() * 0.45
    for (const [nx, nz, span, yaw] of [
      [0, d / 2 + 0.05, w, 0],
      [0, -d / 2 - 0.05, w, Math.PI],
      [w / 2 + 0.05, 0, d, Math.PI / 2],
      [-w / 2 - 0.05, 0, d, -Math.PI / 2],
    ] as const) {
      const n = Math.max(2, Math.floor(span / 4.4))
      const front = Math.sign(nx) === fx && Math.sign(nz) === fz
      for (let s = 0; s < storeys; s++)
        for (let c = 0; c < n; c++) {
          const t = (c + 0.5) / n - 0.5
          const along = t * span * 0.86
          // the entrance owns the middle of the ground floor
          if (front && s === 0 && Math.abs(along) < 2.9) continue
          const ax = nx === 0 ? lot.x + along : lot.x + nx
          const az = nz === 0 ? lot.z + along : lot.z + nz
          // the ground-floor row clears the stone band rather than sitting on
          // its top edge: the band stands 0.15 proud of the wall, so a pane at
          // 2.3 was a window with its bottom half bricked up
          const wy = y + (s === 0 ? 3.4 : 2.3 + s * 4.6)
          // dark glass always, in the solid pass — a lit pane only *adds* the
          // emissive copy, so by day every window still reads as a window
          panel(out.solid, '#2a3138', ax, wy, az, 1.8, 1.9, yaw)
          if (rng() < litRate) {
            panel(out.glass, '#ffcf82', ax + (nx ? Math.sign(nx) * 0.03 : 0), wy,
              az + (nz ? Math.sign(nz) * 0.03 : 0), 1.8, 1.9, yaw)
          }
        }
    }

    // The ground-floor entrance: a stone surround standing proud of the band,
    // two leaves and a mullion set into it, a lit transom over them and a step
    // down to the pavement. Nothing here reaches past +0.25 out of the wall
    // except the lintel, which is over head height — the block's collision box
    // is only that much wider than the body, and a door you can put your arm
    // through is worse than no door.
    box(out.solid, '#4b463f', ex(0, 0.02), y + 2.55, ez(0, 0.02),
      4.4, 5.5, 0.44, lot.face, SURF.paving)
    for (const s of [-1, 1]) {
      panel(out.solid, '#2b2b2e', ex(s * 0.76, 0.26), y + 2.28, ez(s * 0.76, 0.26),
        1.36, 4.35, lot.face, SURF.plank)
    }
    box(out.solid, '#57524a', ex(0, 0.14), y + 2.3, ez(0, 0.14),
      0.16, 4.4, 0.3, lot.face)
    panel(out.solid, GLASS_DARK, ex(0, 0.25), y + 4.75, ez(0, 0.25), 3.1, 0.6, lot.face)
    panel(out.glass, '#ffe0ad', ex(0, 0.28), y + 4.75, ez(0, 0.28), 3.1, 0.6, lot.face)
    // the lintel stops short of 5.8: the first-floor windows start at 5.95
    box(out.solid, '#3f3a34', ex(0, 0.12), y + 5.55, ez(0, 0.12),
      5.0, 0.5, 0.64, lot.face, SURF.paving)

    const stepX = ex(0, 0.8)
    const stepZ = ez(0, 0.8)
    box(out.solid, '#8b867c', stepX, y + 0.09, stepZ, 4.4, 0.18, 1.6, lot.face, SURF.paving)
    const halfAlong = 2.2
    const halfOut = 0.8
    out.boxes.push(new THREE.Box3(
      new THREE.Vector3(
        stepX - (fx ? halfOut : halfAlong), y - 1, stepZ - (fx ? halfAlong : halfOut),
      ),
      new THREE.Vector3(
        stepX + (fx ? halfOut : halfAlong), y + 0.18, stepZ + (fx ? halfAlong : halfOut),
      ),
    ))
  }

  out.boxes.push(noStand(new THREE.Box3(
    new THREE.Vector3(lot.x - w / 2 - 0.25, y - 2, lot.z - d / 2 - 0.25),
    new THREE.Vector3(lot.x + w / 2 + 0.25, y + h + 0.7, lot.z + d / 2 + 0.25),
  )))
}

/* ------------------------------------------------------------ tower ---- */

/**
 * A downtown tower: two or three setback stages so the silhouette has a
 * shoulder, a window grid up every face, and a beacon box on top of the tall
 * ones. Setbacks are what stop a skyline reading as a bar chart.
 */
export const tower = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const shade = TOWER[Math.floor(rng() * TOWER.length)]
  const stages = lot.height > 70 ? 3 : lot.height > 40 ? 2 : 1
  const y = lot.baseY
  let bottom = y
  let w = lot.w
  let d = lot.d
  const litRate = 0.22 + rng() * 0.4

  for (let s = 0; s < stages; s++) {
    const share = s === stages - 1 ? 1 : 0.42 + rng() * 0.2
    const h = (lot.height - (bottom - y)) * share
    box(out.solid, shade, lot.x, bottom + h / 2 - 0.6, lot.z, w, h + 1.2, d, 0, SURF.panel)
    box(out.solid, '#3f444a', lot.x, bottom + h + 0.3, lot.z,
      w + 0.6, 0.6, d + 0.6, 0, SURF.paving)

    if (out.detailed) {
      const storeys = Math.max(2, Math.round(h / 5.4))
      for (const [nx, nz, span, yaw] of [
        [0, d / 2 + 0.05, w, 0],
        [0, -d / 2 - 0.05, w, Math.PI],
        [w / 2 + 0.05, 0, d, Math.PI / 2],
        [-w / 2 - 0.05, 0, d, -Math.PI / 2],
      ] as const) {
        const n = Math.max(2, Math.floor(span / 4.2))
        for (let st = 0; st < storeys; st++)
          for (let c = 0; c < n; c++) {
            const t = (c + 0.5) / n - 0.5
            const ax = nx === 0 ? lot.x + t * span * 0.88 : lot.x + nx
            const az = nz === 0 ? lot.z + t * span * 0.88 : lot.z + nz
            const wy = bottom + 2.6 + st * 5.4
            if (wy > bottom + h - 1.4) continue
            panel(out.solid, '#28303a', ax, wy, az, 1.9, 2.4, yaw)
            if (rng() < litRate) {
              panel(out.glass, '#ffd291', ax + (nx ? Math.sign(nx) * 0.03 : 0), wy,
                az + (nz ? Math.sign(nz) * 0.03 : 0), 1.9, 2.4, yaw)
            }
          }
      }
    }
    bottom += h
    w *= 0.74
    d *= 0.74
  }
  if (lot.height > 60) {
    box(out.solid, '#5a1e1e', lot.x, bottom + 1.2, lot.z, 1.2, 2.4, 1.2)
  }

  out.boxes.push(noStand(new THREE.Box3(
    new THREE.Vector3(lot.x - lot.w / 2 - 0.3, y - 2, lot.z - lot.d / 2 - 0.3),
    new THREE.Vector3(lot.x + lot.w / 2 + 0.3, y + lot.height, lot.z + lot.d / 2 + 0.3),
  )))
}

/* --------------------------------------------------- enterable shop ---- */

/** how wide the doorway gap is, and how tall the ground floor stands */
const DOOR_W = 3.4
const DOOR_H = 4.9
const SHOP_H = 6.4
const WALL_T = 0.5
/** what a shop sells: the crate/carton tints stacked on its shelving */
const GOODS = [
  '#a8524a', '#5a7a4e', '#c8a34e', '#5e6f9e', '#9e5e8a',
  '#c87d4e', '#6fa3a0', '#8a8a55', '#b0b0a8', '#7a4f38',
]
const SIGNS = ['#7d3f33', '#3f5a52', '#54486e', '#6e5a2e', '#33502e', '#5a3a4e']

/**
 * A building with an inside. Four walls around a raised plank floor, each
 * wall registering its own collision box so the doorway — which faces the
 * street the lot faces, not a fixed compass point — is genuinely
 * walk-through. Inside: shelf runs stocked with goods, a counter with a
 * worktop and a till, wall shelves, a rug and a hung ceiling light. Outside:
 * glazing with sills, a sign band, sometimes an awning, and a stoop of steps
 * up to the floor.
 *
 * The floor sits above `lot.topY` — the *highest* ground under the footprint
 * — because a slab at the lowest corner is a slab the terrain mesh (and the
 * grass field) pokes up through; it registers a standable box so the player
 * walks on planks, not on the dirt the slab hides. The stoop's treads each
 * rise less than the walk's step allowance, so entering is just walking.
 *
 * Everything is stamped axis-aligned (the collision model is AABBs), so
 * facing is resolved cardinally: `f` is the forward normal, `r` runs along
 * the front wall, and `boxL` maps shop-local (u along the front, v toward
 * it) into world space. The ceiling registers as an obstacle the same way
 * the house's does — the overworld has no level-wide ceiling, so without a
 * slab up there the third-person boom would rise straight through the roof.
 */
export const shopFront = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const W = Math.min(lot.w, 26)
  const D = Math.min(lot.d, 22)
  const body = BODY[Math.floor(rng() * BODY.length)]
  const baseY = lot.baseY
  /** the sales floor: clear of the dirt everywhere in the footprint */
  const floorY = lot.topY + 0.22

  // the body is stamped axis-aligned, so the front is a cardinal (see
  // midriseBlock's note on reading the wall distance off the wrong extent)
  const fx = Math.round(Math.sin(lot.face))
  const fz = Math.round(Math.cos(lot.face))
  const rx = fz
  const rz = -fx
  /** half-length of the front wall, and half-depth from centre to it */
  const halfU = (fx !== 0 ? D : W) / 2
  const halfV = (fx !== 0 ? W : D) / 2
  // half the shops are mirrored: same plan, counter and shelving swapped
  // side for side (the door hinge goes with them), which doubles the read
  // of variety for one sign flip in the frame mapping
  const mir = rng() < 0.5 ? 1 : -1
  const wx = (u: number, v: number) => lot.x + rx * u * mir + fx * v
  const wz = (u: number, v: number) => lot.z + rz * u * mir + fz * v
  /** a box in shop-local space: `lu` along the front wall, `lv` toward it */
  const boxL = (
    hex: string, u: number, v: number, cy: number,
    lu: number, h: number, lv: number, surf: SurfaceId = SURF.none,
  ) => {
    box(out.solid, hex, wx(u, v), cy, wz(u, v), fx !== 0 ? lv : lu, h, fx !== 0 ? lu : lv,
      0, surf)
  }
  /** its collision twin; `stand` marks the top as a real surface */
  const solidL = (
    u: number, v: number, lu: number, lv: number, y0: number, y1: number,
    stand = false, pad = 0,
  ) => {
    const hw = (fx !== 0 ? lv : lu) / 2 + pad
    const hd = (fx !== 0 ? lu : lv) / 2 + pad
    const b = new THREE.Box3(
      new THREE.Vector3(wx(u, v) - hw, y0, wz(u, v) - hd),
      new THREE.Vector3(wx(u, v) + hw, y1, wz(u, v) + hd),
    )
    out.boxes.push(stand ? b : noStand(b))
    return b
  }
  /** a wall-hugging quad; `facing` +1 looks out of the shop, -1 into it */
  const panelL = (
    target: MeshBuilder, hex: string, u: number, v: number, cy: number,
    lw: number, lh: number, facing: 1 | -1, surf: SurfaceId = SURF.none,
  ) => {
    panel(target, hex, wx(u, v), cy, wz(u, v), lw, lh,
      lot.face + (facing > 0 ? 0 : Math.PI), surf)
  }

  // on the outer ring it is a shed on the horizon: build the silhouette and
  // skip the interior nobody can see or reach from there. The chunk is rebuilt
  // when it promotes a tier, so walking toward it gets you the real thing
  if (!out.detailed) {
    const h = floorY + SHOP_H - baseY
    box(out.solid, body, lot.x, baseY + h / 2, lot.z, W, h, D, 0, SURF.plaster)
    out.boxes.push(noStand(new THREE.Box3(
      new THREE.Vector3(lot.x - W / 2 - 0.2, baseY - 2, lot.z - D / 2 - 0.2),
      new THREE.Vector3(lot.x + W / 2 + 0.2, floorY + SHOP_H, lot.z + D / 2 + 0.2),
    )))
    return
  }

  /* ---- floor, plinth, roof ---- */

  // the plinth carries the building down to the dirt on every side; the plank
  // slab rides on it and is the only part the player ever sees up close
  boxL('#57514a', 0, 0, (baseY - 0.6 + floorY) / 2,
    2 * halfU + 0.34, floorY - baseY + 0.6, 2 * halfV + 0.34, SURF.paving)
  boxL('#7a5f43', 0, 0, floorY - 0.04,
    2 * halfU - 2 * WALL_T + 0.3, 0.12, 2 * halfV - 2 * WALL_T + 0.3, SURF.plank)
  // the whole footprint is a floor: walking in, the player stands at floorY
  solidL(0, 0, 2 * halfU, 2 * halfV, baseY - 1, floorY, true)

  // ceiling slab doubling as the flat roof, with a light lining underneath —
  // the slab's own underside is roof-dark, and a dark ceiling swallowed the
  // whole room
  boxL('#4a463f', 0, 0, floorY + SHOP_H + 0.3,
    2 * halfU + 0.6, 0.6, 2 * halfV + 0.6, SURF.paving)
  boxL('#8d867a', 0, 0, floorY + SHOP_H - 0.05,
    2 * halfU - 2 * WALL_T + 0.2, 0.1, 2 * halfV - 2 * WALL_T + 0.2, SURF.plaster)
  solidL(0, 0, 2 * halfU + 0.6, 2 * halfV + 0.6,
    floorY + SHOP_H, floorY + SHOP_H + 0.6)

  /* ---- walls, doorway facing the street ---- */

  const wallL = (u: number, v: number, lu: number, lv: number) => {
    if (lu < 0.05 || lv < 0.05) return
    boxL(body, u, v, floorY + SHOP_H / 2, lu, SHOP_H, lv, SURF.plaster)
    solidL(u, v, lu, lv, floorY, floorY + SHOP_H, false, 0.15)
  }
  const gap = DOOR_W
  const segLen = halfU - gap / 2
  const vFront = halfV - WALL_T / 2
  // the display windows are real openings, not painted panes: piers either
  // side, a sill band below, a header band above, and nothing in the gap but
  // the night-emissive glow — so by day the interior shows through from the
  // street and the street shows through from inside. The sill is standable
  // (a determined hop puts you in the shop window, which is fine) and the
  // header is not.
  const winW = segLen * 0.72
  const pier = segLen * 0.14
  const sillTop = floorY + 1.45
  const winTop = floorY + 4.65
  for (const s of [-1, 1]) {
    const uWin = s * (gap / 2 + segLen / 2)
    wallL(s * (gap / 2 + pier / 2), vFront, pier, WALL_T)
    wallL(s * (halfU - pier / 2), vFront, pier, WALL_T)
    boxL(body, uWin, vFront, (floorY + sillTop) / 2, winW, sillTop - floorY,
      WALL_T, SURF.plaster)
    solidL(uWin, vFront, winW, WALL_T, floorY, sillTop, true, 0.15)
    boxL(body, uWin, vFront, (winTop + floorY + SHOP_H) / 2, winW,
      floorY + SHOP_H - winTop, WALL_T, SURF.plaster)
    solidL(uWin, vFront, winW, WALL_T, winTop, floorY + SHOP_H, false, 0.15)
  }
  // the header over the door, above head height so it blocks nothing
  boxL(body, 0, vFront,
    floorY + DOOR_H + 0.2 + (SHOP_H - DOOR_H - 0.2) / 2,
    gap, SHOP_H - DOOR_H - 0.2, WALL_T, SURF.plaster)
  wallL(0, -(halfV - WALL_T / 2), 2 * halfU, WALL_T)
  wallL(-(halfU - WALL_T / 2), 0, WALL_T, 2 * halfV)
  wallL(halfU - WALL_T / 2, 0, WALL_T, 2 * halfV)

  /* ---- the door ---- */

  // frame: jambs and a lintel standing proud of the wall on both sides
  const trimD = '#4a3d30'
  for (const s of [-1, 1]) {
    boxL(trimD, s * (gap / 2 + 0.1), halfV - WALL_T / 2, floorY + DOOR_H / 2,
      0.22, DOOR_H + 0.12, WALL_T + 0.16)
  }
  boxL(trimD, 0, halfV - WALL_T / 2, floorY + DOOR_H + 0.13,
    gap + 0.55, 0.3, WALL_T + 0.16)
  // both leaves are real hinged doors: the chunk stamps only the frame and
  // emits a spec per leaf, and world/shopDoors.ts owns everything that
  // swings. One leaf used to be baked shut into the merged mesh, and the
  // procedural plank pass plus the chunk material's tint made the twins
  // visibly different species — the tell that only one of them worked.
  const leafW = gap / 2 - 0.05
  for (const s of [-1, 1] as const) {
    const hingeU = s * (gap / 2 - 0.07)
    out.doors.push({
      id: '',
      x: wx(hingeU, halfV - WALL_T / 2),
      y: floorY,
      z: wz(hingeU, halfV - WALL_T / 2),
      dx: -s * rx * mir,
      dz: -s * rz * mir,
      fx,
      fz,
      leafW,
      leafH: DOOR_H - 0.1,
    })
  }

  /* ---- the stoop ---- */

  // treads down from the floor to the pavement, each rise under the walk's
  // step allowance so entering is just walking; none needed on flat ground.
  // `rise` is measured to the footprint's lowest corner — the ground at the
  // door may sit higher, which only buries the lower treads in the verge
  const rise = floorY - baseY
  const treads = Math.min(3, Math.max(0, Math.ceil(rise / 0.38) - 1))
  const TREAD = 0.62
  for (let i = 1; i <= treads; i++) {
    const top = floorY - (i * rise) / (treads + 1)
    boxL('#8b867c', 0, halfV + (i - 0.5) * TREAD, (baseY - 0.4 + top) / 2,
      gap + 1.0, top - baseY + 0.4, TREAD, SURF.paving)
    solidL(0, halfV + (i - 0.5) * TREAD, gap + 1.0, TREAD, baseY - 1, top, true)
  }

  /* ---- shopfront glazing, sign, awning ---- */

  const uGlass = gap / 2 + segLen / 2
  for (const s of [-1, 1]) {
    // sill trim outside, and the warm pane that comes up with the dusk —
    // by day it is invisible and the opening is simply open
    boxL(trimD, s * uGlass, halfV - 0.04, sillTop - 0.06, winW + 0.24, 0.14, 0.3)
    for (const f of [1, -1] as const) {
      panelL(out.glass, '#ffe2ae', s * uGlass, halfV - WALL_T / 2 + f * 0.02,
        (sillTop + winTop) / 2, winW, winTop - sillTop, f)
    }
  }
  const signC = SIGNS[Math.floor(rng() * SIGNS.length)]
  boxL(signC, 0, halfV + 0.02, floorY + SHOP_H - 0.55, 2 * halfU * 0.82, 1.05, 0.28)
  if (rng() < 0.55) {
    // a canvas awning over the glazing, drooping toward the street
    tmpQ.setFromEuler(tmpE.set(0.42, lot.face, 0, 'YXZ'))
    tmpM.compose(
      tmpP.set(wx(0, halfV + 0.62), floorY + 4.86, wz(0, halfV + 0.62)),
      tmpQ, tmpS.set(2 * halfU * 0.88, 0.08, 1.6),
    )
    out.solid.add(BOX, tmpM, col.set(signC))
    tmpE.order = 'XYZ'
  }

  /* ---- the interior ---- */

  // a rug at the entry
  boxL('#7a4030', 0, halfV - WALL_T - 1.35, floorY + 0.045, 2.4, 0.05, 1.5)

  /** a stack of goods on a surface: little cartons in the shop's palette */
  const goods = (u: number, v0: number, v1: number, top: number, big: number) => {
    for (let v = v0 + 0.45; v < v1 - 0.35; v += 0.85) {
      if (rng() > 0.72) continue
      const gw = (0.4 + rng() * 0.35) * big
      const gh = (0.32 + rng() * 0.38) * big
      const gd = (0.5 + rng() * 0.3) * big
      boxL(GOODS[Math.floor(rng() * GOODS.length)],
        u + (rng() - 0.5) * 0.3, v + (rng() - 0.5) * 0.2,
        top + gh / 2, gw, gh, gd)
    }
  }

  // gondola shelf runs: uprights, boards, stocked shelves. One along the
  // wall away from the counter; a second down the middle on a wide floor
  const vg0 = -halfV + WALL_T + 1.0
  const vg1 = halfV - WALL_T - 3.2
  const gondola = (uC: number) => {
    const len = vg1 - vg0
    if (len < 2.4) return
    const vc = (vg0 + vg1) / 2
    boxL('#4a3b2c', uC, vc, floorY + 0.15, 1.15, 0.3, len, SURF.plank)
    for (const e of [-1, 1]) {
      boxL('#5c4936', uC, vc + e * (len / 2 - 0.07), floorY + 1.28, 1.1, 2.55, 0.14,
        SURF.plank)
    }
    for (const h of [0.52, 1.34, 2.16]) {
      boxL('#6b5642', uC, vc, floorY + h, 1.05, 0.09, len - 0.2, SURF.plank)
      goods(uC, vg0, vg1, floorY + h + 0.045, 1)
    }
    solidL(uC, vc, 1.15, len, floorY, floorY + 2.6, false, 0.1)
  }
  const uShelf = -(halfU - WALL_T - 1.7)
  gondola(uShelf)
  if (halfU > 7.2) gondola(uShelf / 3)

  // the counter: base, overhanging worktop you can hop onto, and a till
  const clen = Math.min(2 * halfV * 0.42, 6)
  const uCnt = halfU - WALL_T - 1.55
  const vCnt = -halfV * 0.1
  boxL('#5d4630', uCnt, vCnt, floorY + 0.95, 1.0, 1.9, clen, SURF.plank)
  boxL('#8a7358', uCnt, vCnt, floorY + 1.96, 1.3, 0.12, clen + 0.25, SURF.plank)
  boxL('#33343a', uCnt, vCnt - clen / 2 + 0.6, floorY + 2.28, 0.55, 0.5, 0.45)
  solidL(uCnt, vCnt, 1.3, clen + 0.25, floorY, floorY + 2.02, true)

  // stock shelves on the back wall, with a keep-out so the body can't stand
  // inside the boards (they hang below head height)
  const bLen = Math.min(2 * halfU * 0.55, 8)
  for (const h of [2.3, 3.15]) {
    boxL('#6b5642', 0, -halfV + WALL_T + 0.35, floorY + h, bLen, 0.09, 0.6, SURF.plank)
    for (let u = -bLen / 2 + 0.5; u < bLen / 2 - 0.4; u += 0.9) {
      if (rng() > 0.6) continue
      const gh = 0.24 + rng() * 0.3
      boxL(GOODS[Math.floor(rng() * GOODS.length)],
        u + (rng() - 0.5) * 0.25, -halfV + WALL_T + 0.35,
        floorY + h + 0.045 + gh / 2, 0.34 + rng() * 0.28, gh, 0.4 + rng() * 0.15)
    }
  }
  solidL(0, -halfV + WALL_T + 0.35, bLen, 0.7, floorY + 2.25, floorY + 3.25)

  // a hung light: cord, shade, and a warm pane that comes up with the dusk
  boxL('#3a3630', 0, 0, floorY + SHOP_H - 0.25, 0.07, 0.5, 0.07)
  boxL('#e8e4da', 0, 0, floorY + SHOP_H - 0.55, 0.95, 0.14, 0.95)
  box(out.glass, '#ffe9bd', wx(0, 0), floorY + SHOP_H - 0.64, wz(0, 0), 0.8, 0.05, 0.8)

  out.lamps.push({ x: wx(0, 0), y: floorY + SHOP_H - 1.1, z: wz(0, 0) })

  /* ---- report the interior ---- */

  // the sales floor plus the stoop, so neither the scatterer nor the grass
  // field plants anything inside (or growing up through the treads)
  const rect = (u0: number, u1: number, v0: number, v1: number): InteriorRect => {
    const xs = [wx(u0, v0), wx(u1, v0), wx(u0, v1), wx(u1, v1)]
    const zs = [wz(u0, v0), wz(u1, v0), wz(u0, v1), wz(u1, v1)]
    return {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minZ: Math.min(...zs), maxZ: Math.max(...zs),
    }
  }
  out.interiors.push(rect(-halfU - 0.4, halfU + 0.4, -halfV - 0.4, halfV + 0.4))
  if (treads > 0) {
    out.interiors.push(
      rect(-(gap / 2 + 0.8), gap / 2 + 0.8, halfV, halfV + treads * TREAD + 0.3),
    )
  }
}

export const KIND_FOR = (district: District, roll: number) =>
  district === 'downtown'
    ? 'tower'
    : district === 'midrise'
      ? roll < 0.12 ? 'shop' : 'midrise'
      : roll < 0.07 ? 'shop' : 'house'
