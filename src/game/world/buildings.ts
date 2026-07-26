import * as THREE from 'three'
import type { MeshBuilder } from '../core/geometry'
import { noStand, type Solid } from '../physics/collision'
import type { District } from './settlements'
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
  ground floor — four walls with a gap for the door, a floor, a ceiling, a
  counter and shelves — and registers its walls individually so the doorway is
  walk-through. Those are the ones with a lit interior and an actual inside,
  scattered a few to a town, and they exist because a city you can only walk
  *between* gets old faster than one you can occasionally walk *into*.

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
  /** ground the building stands on */
  baseY: number
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
const SHOP_H = 6.4
const WALL_T = 0.5

/**
 * A building with an inside. Four walls, each registering its own collision
 * box, with the front wall split around a doorway so the gap is genuinely
 * walk-through; a floor slab, a ceiling slab that doubles as the roof, a
 * service counter, two shelf runs, and a lamp.
 *
 * The ceiling registers as an obstacle the same way the house's does — the
 * overworld has no level-wide ceiling (half of it is sky), so without a slab
 * up there the third-person boom would rise straight through the roof.
 */
export const shopFront = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const w = Math.min(lot.w, 26)
  const d = Math.min(lot.d, 22)
  const y = lot.baseY
  const body = BODY[Math.floor(rng() * BODY.length)]
  const x0 = lot.x - w / 2
  const x1 = lot.x + w / 2
  const z0 = lot.z - d / 2
  const z1 = lot.z + d / 2

  // on the outer ring it is a shed on the horizon: build the silhouette and
  // skip the interior nobody can see or reach from there. The chunk is rebuilt
  // when it promotes a tier, so walking toward it gets you the real thing
  if (!out.detailed) {
    box(out.solid, body, lot.x, y + SHOP_H / 2, lot.z, w, SHOP_H, d, 0, SURF.plaster)
    out.boxes.push(noStand(new THREE.Box3(
      new THREE.Vector3(x0 - 0.2, y - 2, z0 - 0.2),
      new THREE.Vector3(x1 + 0.2, y + SHOP_H, z1 + 0.2),
    )))
    return
  }

  // floor and ceiling
  box(out.solid, '#6a6660', lot.x, y - 0.15, lot.z, w, 0.3, d, 0, SURF.paving)
  box(out.solid, '#4a463f', lot.x, y + SHOP_H + 0.3, lot.z,
    w + 0.6, 0.6, d + 0.6, 0, SURF.paving)
  out.boxes.push(noStand(new THREE.Box3(
    new THREE.Vector3(x0 - 0.3, y + SHOP_H, z0 - 0.3),
    new THREE.Vector3(x1 + 0.3, y + SHOP_H + 0.6, z1 + 0.3),
  )))

  /** a wall segment plus its collision box */
  const wall = (ax: number, az: number, ww: number, dd: number) => {
    if (ww < 0.05 || dd < 0.05) return
    box(out.solid, body, ax, y + SHOP_H / 2, az, ww, SHOP_H, dd, 0, SURF.plaster)
    out.boxes.push(noStand(new THREE.Box3(
      new THREE.Vector3(ax - ww / 2 - 0.15, y, az - dd / 2 - 0.15),
      new THREE.Vector3(ax + ww / 2 + 0.15, y + SHOP_H, az + dd / 2 + 0.15),
    )))
  }
  // front wall (+z), split around the doorway
  const gap = DOOR_W
  const leftW = (w - gap) / 2
  wall(x0 + leftW / 2, z1 - WALL_T / 2, leftW, WALL_T)
  wall(x1 - leftW / 2, z1 - WALL_T / 2, leftW, WALL_T)
  // the header over the door, above head height so it blocks nothing
  box(out.solid, body, lot.x, y + SHOP_H - 0.8, z1 - WALL_T / 2, gap, 1.6, WALL_T, 0, SURF.plaster)
  wall(lot.x, z0 + WALL_T / 2, w, WALL_T)
  wall(x0 + WALL_T / 2, lot.z, WALL_T, d)
  wall(x1 - WALL_T / 2, lot.z, WALL_T, d)

  // shopfront glazing either side of the door, and a sign band over it
  for (const s of [-1, 1]) {
    panel(out.solid, GLASS_DARK, lot.x + s * (gap / 2 + leftW / 2), y + 3.2, z1 + 0.06,
      leftW * 0.72, 3.0, 0)
    panel(out.glass, '#ffe2ae', lot.x + s * (gap / 2 + leftW / 2), y + 3.2, z1 + 0.09,
      leftW * 0.72, 3.0, 0)
  }
  box(out.solid, '#7d3f33', lot.x, y + SHOP_H - 0.4, z1 + 0.2, w * 0.8, 1.1, 0.25, 0, SURF.none)

  // a counter you can walk around and hop onto, and two shelf runs
  const counter = new THREE.Box3(
    new THREE.Vector3(x0 + 2.0, y, lot.z - 2.4),
    new THREE.Vector3(x0 + 2.0 + w * 0.42, y + 2.1, lot.z - 1.2),
  )
  box(out.solid, '#5d4630',
    (counter.min.x + counter.max.x) / 2, y + 1.05, (counter.min.z + counter.max.z) / 2,
    counter.max.x - counter.min.x, 2.1, counter.max.z - counter.min.z, 0, SURF.plank)
  out.boxes.push(counter)
  for (const s of [-1, 1]) {
    const sx = lot.x + s * (w / 2 - 2.6)
    const sz = z0 + d * 0.34
    box(out.solid, '#6b5a44', sx, y + 1.6, sz, 1.6, 3.2, d * 0.42, 0, SURF.plank)
    out.boxes.push(noStand(new THREE.Box3(
      new THREE.Vector3(sx - 0.95, y, sz - d * 0.22),
      new THREE.Vector3(sx + 0.95, y + 3.2, sz + d * 0.22),
    )))
  }

  out.lamps.push({ x: lot.x, y: y + SHOP_H - 1.1, z: lot.z })
}

export const KIND_FOR = (district: District, roll: number) =>
  district === 'downtown'
    ? 'tower'
    : district === 'midrise'
      ? roll < 0.12 ? 'shop' : 'midrise'
      : roll < 0.07 ? 'shop' : 'house'
