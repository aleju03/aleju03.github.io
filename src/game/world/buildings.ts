import type { MeshBuilder } from '../core/geometry'
import { noStand } from '../physics/collision'
import type { District } from './settlements'
import type { InteriorRect } from './interiors'
import { SURF, type SurfaceId } from './surface'
import {
  BARREL, BODY, BOX, CONE4, CONE12, CYL12, GAMBREL, GLASS_DARK, PLANE, PRISM, TOWER,
  TUBE12, aabb, box, fork, keepOut, panel, pick, put, shaft, strut, type BuildOut, type Lot,
} from './kitbash'

export type { BuildOut, Lot } from './kitbash'

/*
  The town and the city: what stands inside a block once settlements.ts has
  decided the block is downtown, mid-rise or suburb. Houses are next door in
  houses.ts, because a suburb is a different design problem from a skyline.

  Everything is stamped through the same mesh builder as the trees, so a whole
  city block still costs one opaque draw call plus one for its glass. Windows
  go into that separate builder because they are the only thing out here that
  changes with the clock: one emissive material for the lot, faded up at dusk
  and killed at dawn, which is what makes a skyline read as inhabited without
  a single light source in the scene.

  Nine kits live here and only one of them has an inside. `shopFront` builds a
  real ground floor, four walls with a doorway facing the street, a raised
  plank floor the player actually stands on, shelving with goods, a counter,
  and registers its walls individually so the doorway is genuinely
  walk-through. Those are scattered a few to a town, and they exist because a
  city you can only walk *between* gets old faster than one you can
  occasionally walk *into*. The other eight are shells: solid masses with
  detail on the outside and one collision box around each.

  Three of the nine are block-scale rather than lot-scale, and the chunk
  builder hands them a whole block instead of carving it into lots: a
  warehouse, a chapel with its churchyard, and a parking deck. A city grid
  where every cell is the same kind of building at a different height is what
  "copy-paste" means from the pavement, and the fix is not more rolls inside
  one kit, it is occasionally putting something else there entirely.

  Everything sits on `baseY`, which the chunk builder resolves as the lowest
  ground under the footprint, and every kit extends its walls a little below
  that: the terrain under a 40-unit footprint is graded but not perfectly
  level, and a skirt is cheaper than conforming the geometry to the ground.
*/

/* ------------------------------------------------------- shared fittings -- */

/** how many window bays a wall of this length wants, and where each sits */
const bays = (span: number, pitch: number) => Math.max(2, Math.floor(span / pitch))

/** the four wall planes of an axis-aligned body, as grid() wants them */
const faces = (w: number, d: number) => [
  [0, d / 2 + 0.05, w, 0],
  [0, -d / 2 - 0.05, w, Math.PI],
  [w / 2 + 0.05, 0, d, Math.PI / 2],
  [-w / 2 - 0.05, 0, d, -Math.PI / 2],
] as const

/** a lancet: a tall opening with a rounded head, framed, dark by day and warm
    after dusk. The head is faked with a narrower topper rather than built as
    an arch, which at the distance a chapel window is read from is the same
    picture for a tenth of the vertices. */
const lancet = (
  out: BuildOut, x: number, y: number, z: number, w: number, h: number,
  yaw: number, nx: number, nz: number, lit: boolean,
) => {
  box(out.solid, '#d3ccbb', x, y, z, w + 0.34, h + 0.34, 0.18, yaw, SURF.plaster)
  box(out.solid, '#d3ccbb', x, y + h / 2 + 0.24, z, w * 0.6, 0.7, 0.18, yaw, SURF.plaster)
  panel(out.solid, '#28323c', x + nx * 0.11, y, z + nz * 0.11, w, h, yaw)
  panel(out.solid, '#28323c', x + nx * 0.11, y + h / 2 + 0.2, z + nz * 0.11,
    w * 0.52, 0.56, yaw)
  if (!lit) return
  panel(out.glass, '#ffd08a', x + nx * 0.15, y, z + nz * 0.15, w, h, yaw)
  panel(out.glass, '#ffd08a', x + nx * 0.15, y + h / 2 + 0.2, z + nz * 0.15,
    w * 0.52, 0.56, yaw)
}

/** the cardinal front of an axis-aligned body. The body is stamped
    axis-aligned, so its front is a *cardinal* and the wall stands a whole
    half-extent away along it. Reading that distance off `d` while the face
    pointed down x is what left a mid-rise entrance hanging in mid-air a metre
    clear of the brickwork, on a lot where w and d roll independently. */
const front = (lot: Lot) => {
  const fx = Math.round(Math.sin(lot.face))
  const fz = Math.round(Math.cos(lot.face))
  const wall = (fx ? lot.w : lot.d) / 2
  return {
    fx, fz, wall,
    /** a point on the front: `o` along the wall, `n` out from its face */
    x: (o: number, n: number) => lot.x + fx * (wall + n) + fz * o,
    z: (o: number, n: number) => lot.z + fz * (wall + n) - fx * o,
  }
}

/* ------------------------------------------------------ facade grammar -- */

/*
  What stops a block of flats reading as a perforated carton is not more
  windows, it is rhythm: panes grouped into pairs with a pier between the
  groups, a ground floor that is a different thing from the storeys over it,
  a top floor that is smaller again, and a line of stone at every sill that
  the eye reads as a storey without counting panes. These are the verbs for
  that. The one rule they keep is about cost: anything that reads on every
  face is *one* box wrapped round the body (a course is 24 vertices whether
  it is seen from one street or four), while anything only the front
  deserves (brackets, piers, a fire escape, frames round the panes) is
  stamped on the front and nowhere else.
*/

/** window centres along a wall `span` long: `group` 1 is an even run at
    `pitch`, 2 is pairs and 3 is triples, each group standing apart from the
    next by a pier a little wider than the pitch */
const rhythm = (span: number, pitch: number, group: 1 | 2 | 3): number[] => {
  const usable = span * 0.84
  if (group === 1) {
    const n = Math.max(2, Math.floor(span / pitch))
    return Array.from({ length: n }, (_, i) => ((i + 0.5) / n - 0.5) * usable)
  }
  const inner = pitch * 0.62
  const run = inner * (group - 1)
  const n = Math.max(1, Math.floor(usable / (run + pitch * 1.2)))
  const xs: number[] = []
  for (let g = 0; g < n; g++) {
    const gc = ((g + 0.5) / n - 0.5) * usable
    for (let j = 0; j < group; j++) xs.push(gc + (j - (group - 1) / 2) * inner)
  }
  return xs
}

/**
 * One storey of panes along one wall of an axis-aligned body (`nx, nz` from
 * `faces()`). The dark pane goes into the solid pass and a lit copy into the
 * glass pass on a roll, as everywhere else; `frame` puts a pale surround
 * behind the pane, four vertices a window and the difference between a sash
 * and a hole, so the callers only ask for it on the face that fronts the
 * street.
 */
const paneRow = (
  out: BuildOut, cx: number, cz: number, nx: number, nz: number, yaw: number,
  xs: number[], y: number, w: number, h: number, litRate: number, rng: () => number,
  frame?: string, skip?: (along: number) => boolean,
) => {
  const sx = Math.sign(nx)
  const sz = Math.sign(nz)
  for (const along of xs) {
    if (skip?.(along)) continue
    const ax = nx === 0 ? cx + along : cx + nx
    const az = nz === 0 ? cz + along : cz + nz
    if (frame) panel(out.solid, frame, ax - sx * 0.02, y, az - sz * 0.02, w + 0.5, h + 0.5, yaw)
    panel(out.solid, '#2a3138', ax, y, az, w, h, yaw)
    if (rng() < litRate) {
      panel(out.glass, '#ffcf82', ax + sx * 0.03, y, az + sz * 0.03, w, h, yaw)
    }
  }
}

/** a band of stone wrapped round all four faces of a body in one box. It is
    a whole box, not a ring, so the top course of a flat roof *is* the roof */
const course = (
  out: BuildOut, x: number, z: number, w: number, d: number,
  cy: number, h: number, proud: number, hex: string, surf: SurfaceId = SURF.paving,
) => box(out.solid, hex, x, cy, z, w + proud * 2, h, d + proud * 2, 0, surf)

/**
 * A timber water tank on a steel frame, the one object that says "city roof"
 * from any distance: four legs, a deck, a staved barrel and a conical lid,
 * with two hoops round it up close. It is a silhouette, so it builds on the
 * outer ring too.
 */
const waterTank = (
  out: BuildOut, x: number, y: number, z: number, r: number, rng: () => number,
) => {
  const legH = 2.4 + rng() * 1.2
  const staves = pick(['#7a5a3e', '#6b4f38', '#86694a', '#5f5347'], rng())
  const steel = '#3a3c3d'
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      box(out.solid, steel, x + sx * r * 0.7, y + legH / 2, z + sz * r * 0.7,
        0.24, legH, 0.24, 0, SURF.none)
    }
  box(out.solid, steel, x, y + legH, z, r * 2.1, 0.24, r * 2.1, 0, SURF.paving)
  const bh = r * 2.1
  shaft(out.solid, staves, x, y + legH + 0.12, z, r, bh, r * 0.96, 12, 0, SURF.plank)
  if (out.detailed) {
    for (const t of [0.28, 0.72]) {
      put(out.solid, TUBE12, steel, x, y + legH + 0.12 + bh * t, z, 0, 0, 0,
        r * 2.04, 0.16, r * 2.04)
    }
  }
  put(out.solid, CONE12, '#3b3834', x, y + legH + 0.12 + bh + 0.55, z, 0, 0, 0,
    r * 2.14, 1.1, r * 2.14, SURF.shingle)
}

/**
 * What stands on a flat roof: a stair bulkhead in one corner, often a water
 * tank in the other, and near enough to see, a few condenser units and an
 * aerial. Every one of them breaks the single straight line a flat-roofed
 * block otherwise draws against the sky, which is most of what made the
 * mid-rise ring read as a bar chart from the air. Kept a couple of units
 * inside the parapet so nothing overhangs the collision box. `rng` places
 * the silhouette and `dr` (a `fork` of it) the dressing, so the outer ring
 * and the near one agree about where the tank is.
 */
const rooftop = (
  out: BuildOut, x: number, z: number, w: number, d: number, top: number,
  rng: () => number, dr: () => number, tank: number,
) => {
  const hw = w / 2 - 2.2
  const hd = d / 2 - 2.2
  if (hw < 2 || hd < 2) return
  const sx = rng() < 0.5 ? 1 : -1
  const sz = rng() < 0.5 ? 1 : -1
  const bx = x + sx * (hw - 1.6)
  const bz = z + sz * (hd - 1.8)
  box(out.solid, '#5b564e', bx, top + 1.5, bz, 3.2, 3.0, 3.6, 0, SURF.plaster)
  box(out.solid, '#3f3b36', bx, top + 3.12, bz, 3.7, 0.26, 4.1, 0, SURF.paving)
  if (rng() < tank) {
    waterTank(out, x - sx * Math.max(0, hw - 2.2), top, z - sz * Math.max(0, hd - 2.2),
      1.35 + rng() * 0.4, rng)
  }
  if (!out.detailed) return
  const units = 1 + Math.floor(dr() * 3)
  for (let i = 0; i < units; i++) {
    const ux = x + (dr() - 0.5) * hw
    const uz = z + (dr() - 0.5) * hd
    box(out.solid, '#999c98', ux, top + 0.6, uz, 1.8, 1.2, 1.3, 0, SURF.panel)
    put(out.solid, PLANE, '#34383a', ux, top + 1.22, uz, -Math.PI / 2, 0, 0, 1.0, 1.0, 1)
  }
  if (dr() < 0.5) {
    const ax = x - sx * hw * 0.3
    const az = z + sz * hd * 0.5
    shaft(out.solid, '#55595c', ax, top, az, 0.09, 6.0, 0.05, 6)
    box(out.solid, '#55595c', ax, top + 4.9, az, 2.6, 0.08, 0.08, 0, SURF.none)
    box(out.solid, '#55595c', ax, top + 5.5, az, 1.7, 0.08, 0.08, 0, SURF.none)
  }
}

/**
 * The iron stair down a walk-up's face, in the face's own frame (`px, pz`
 * map `o` along the wall and `n` out of it, `fx` is the face normal's x):
 * a landing at every storey from the first, a rail round its outer edge and
 * a flight slanting up to the next, the flights zig-zagging as they climb.
 * It stops a storey up, the way the real ones do with the drop ladder hauled
 * in, so nothing in it hangs where a walker's head goes; one noStand box from
 * the first landing up keeps a jump from putting a head through it.
 */
const fireEscape = (
  out: BuildOut, px: (o: number, n: number) => number, pz: (o: number, n: number) => number,
  fx: number, o: number, y: number, storeys: number, sh: number, yaw: number,
) => {
  const iron = '#2c2e2f'
  const lw = 5.2
  const ld = 1.5
  for (let s = 1; s < storeys; s++) {
    const ly = y + s * sh + 0.25
    box(out.solid, iron, px(o, ld / 2), ly, pz(o, ld / 2), lw, 0.14, ld, yaw, SURF.none)
    // the outer rail as one sheet: at this scale a balustrade of bars and a
    // plate read the same, and the plate is one box
    box(out.solid, iron, px(o, ld - 0.04), ly + 0.55, pz(o, ld - 0.04), lw, 1.0, 0.06, yaw,
      SURF.none)
    for (const e of [-1, 1]) {
      box(out.solid, iron, px(o + e * (lw / 2 - 0.03), ld / 2), ly + 0.55,
        pz(o + e * (lw / 2 - 0.03), ld / 2), 0.06, 1.0, ld, yaw, SURF.none)
    }
    if (s < storeys - 1) {
      const dir = s % 2 === 0 ? 1 : -1
      const a = o - dir * (lw / 2 - 0.8)
      const b = o + dir * (lw / 2 - 0.8)
      strut(out.solid, iron,
        px(a, ld / 2), ly + 0.1, pz(a, ld / 2),
        px(b, ld / 2), ly + sh, pz(b, ld / 2),
        0.14, SURF.none, 1.0)
    }
  }
  const hx = fx ? ld / 2 : lw / 2
  const hz = fx ? lw / 2 : ld / 2
  out.boxes.push(noStand(aabb(px(o, ld / 2), y + sh, pz(o, ld / 2), hx, y + storeys * sh, hz)))
}

/**
 * The ground-floor entrance of a walk-up: a stone surround standing proud of
 * the band, two leaves and a mullion set into it, a lit transom over them
 * and a step down to the pavement. Nothing here reaches past +0.25 out of
 * the wall except the lintel, which is over head height: the block's
 * collision box is only that much wider than the body, and a door you can
 * put your arm through is worse than no door.
 */
const entrance = (out: BuildOut, lot: Lot, f: ReturnType<typeof front>, y: number) => {
  box(out.solid, '#4b463f', f.x(0, 0.02), y + 2.55, f.z(0, 0.02),
    4.4, 5.5, 0.44, lot.face, SURF.paving)
  for (const s of [-1, 1]) {
    panel(out.solid, '#2b2b2e', f.x(s * 0.76, 0.26), y + 2.28, f.z(s * 0.76, 0.26),
      1.36, 4.35, lot.face, SURF.plank)
  }
  box(out.solid, '#57524a', f.x(0, 0.14), y + 2.3, f.z(0, 0.14),
    0.16, 4.4, 0.3, lot.face)
  panel(out.solid, GLASS_DARK, f.x(0, 0.25), y + 4.75, f.z(0, 0.25), 3.1, 0.6, lot.face)
  panel(out.glass, '#ffe0ad', f.x(0, 0.28), y + 4.75, f.z(0, 0.28), 3.1, 0.6, lot.face)
  // the lintel stops short of 5.8: the first-floor windows start at 5.95
  box(out.solid, '#3f3a34', f.x(0, 0.12), y + 5.55, f.z(0, 0.12),
    5.0, 0.5, 0.64, lot.face, SURF.paving)
  const stepX = f.x(0, 0.8)
  const stepZ = f.z(0, 0.8)
  box(out.solid, '#8b867c', stepX, y + 0.09, stepZ, 4.4, 0.18, 1.6, lot.face, SURF.paving)
  keepOut(out, stepX, stepZ, f.fx ? 0.9 : 2.3, f.fx ? 2.3 : 0.9)
  out.boxes.push(aabb(stepX, y - 1, stepZ,
    f.fx ? 0.8 : 2.2, y + 0.18, f.fx ? 2.2 : 0.8))
}

/** the paint each hand of walk-up is built or rendered in */
const TENEMENT_BRICK = ['#7a4a3a', '#86523e', '#6e4636', '#7d5f4a', '#5f4a3e', '#8b6a50', '#704b40']
const DECO_RENDER = ['#c9c0ae', '#d4cdbd', '#bfb4a0', '#c8b89c', '#b9b8ad', '#cdbfa6']
const MODERN_RENDER = ['#9aa19a', '#a8a39a', '#8f9a9e', '#b0aa9c', '#9c948a', '#a39386']

/* --------------------------------------------------------- mid-rise ---- */

/**
 * A walk-up block, in one of three hands, because a mid-rise ring of one kit
 * at a dozen heights is the copy-paste city seen from the pavement:
 *
 * - **tenement**: brick, sash windows in pairs with pale frames on the
 *   street face, a stone course at every sill, a bracketed cornice, an iron
 *   fire escape zig-zagging down the front or a flank, and a water tank on
 *   the roof. The pre-war block every city has a thousand of.
 * - **deco**: pale render over a rusticated stone ground floor, piers
 *   running the height of the street face between the bays and standing
 *   clear of the parapet, a stepped centre over the entrance and a flat
 *   canopy on it.
 * - **modern**: a sixties block in render, a dark recessed ground floor,
 *   ribbon windows wrapped round every face, balconies staggered storey by
 *   storey on the street side and a deep flat roof slab.
 *
 * All three keep the same envelope (storeys of 4.6, one noStand box around
 * the body) because fracture.ts cuts a walk-up at that storey height.
 */
export const midriseBlock = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const w = lot.w
  const d = lot.d
  const sh = 4.6
  const storeys = Math.max(3, Math.round(lot.height / sh))
  const h = storeys * sh
  const y = lot.baseY
  const f = front(lot)
  const r = rng()
  const style = r < 0.44 ? 'tenement' : r < 0.72 ? 'deco' : 'modern'
  const dr = fork(rng)
  const litRate = 0.3 + dr() * 0.45
  const frontLen = f.fx ? d : w
  const isFront = (nx: number, nz: number) => Math.sign(nx) === f.fx && Math.sign(nz) === f.fz
  /** the height a storey's panes are centred on */
  const rowY = (s: number) => (s === 0 ? y + 3.4 : y + 2.3 + s * sh)
  /** the door keeps a clear bay on the street face's ground floor */
  const doorBay = (a: number) => Math.abs(a) < 2.9

  if (style === 'tenement') {
    const body = pick(TENEMENT_BRICK, rng())
    const stone = pick(['#8d8578', '#9a9384', '#7f786c'], rng())
    box(out.solid, body, lot.x, y + h / 2 - 0.8, lot.z, w, h + 1.6, d, 0, SURF.brick)
    course(out, lot.x, lot.z, w, d, y + 1.1, 2.4, 0.15, '#585349')
    // the cornice: a frieze, and a deep projecting lip over it
    course(out, lot.x, lot.z, w, d, y + h - 0.2, 1.0, 0.18, stone)
    course(out, lot.x, lot.z, w, d, y + h + 0.45, 0.5, 0.7, '#4c4740')
    if (out.detailed) {
      const group = dr() < 0.6 ? 2 : 1
      for (let s = 1; s < storeys; s++) {
        course(out, lot.x, lot.z, w, d, rowY(s) - 1.35, 0.2, 0.12, stone)
      }
      for (const [nx, nz, span, yaw] of faces(w, d)) {
        const fr = isFront(nx, nz)
        const xs = rhythm(span, 3.6, fr ? group : 1)
        for (let s = 0; s < storeys; s++) {
          const top = s === storeys - 1
          paneRow(out, lot.x, lot.z, nx, nz, yaw, xs, rowY(s) + (top ? -0.2 : 0),
            1.45, top ? 1.8 : 2.4, litRate, dr, fr ? '#d9d2c2' : undefined,
            s === 0 && fr ? doorBay : undefined)
        }
      }
      // brackets under the lip, on the street face only
      const nb = Math.max(4, Math.round(frontLen / 3))
      for (let i = 0; i <= nb; i++) {
        const o = (i / nb - 0.5) * (frontLen - 0.6)
        box(out.solid, '#4c4740', f.x(o, 0.3), y + h - 0.05, f.z(o, 0.3),
          0.34, 0.7, 0.6, lot.face, SURF.paving)
      }
      entrance(out, lot, f, y)
      if (dr() < 0.75) {
        if (frontLen > 14) {
          // on the front when it is wide enough to clear the door
          const o = (frontLen / 2 - 3.6) * (dr() < 0.5 ? 1 : -1)
          fireEscape(out, f.x, f.z, f.fx, o, y, storeys, sh, lot.face)
        } else {
          // ...otherwise down a flank, in that flank's own frame
          const side = dr() < 0.5 ? 1 : -1
          const gx = f.fz * side
          const gz = -f.fx * side
          const half = (gx ? w : d) / 2
          const px = (o: number, n: number) => lot.x + gx * (half + n) + gz * o
          const pz = (o: number, n: number) => lot.z + gz * (half + n) - gx * o
          fireEscape(out, px, pz, gx, (f.fx ? w : d) * 0.12, y, storeys, sh,
            Math.atan2(gx, gz))
        }
      }
    }
    rooftop(out, lot.x, lot.z, w, d, y + h + 0.7, rng, dr, 0.8)
  } else if (style === 'deco') {
    const body = pick(DECO_RENDER, rng())
    const stone = pick(['#77716a', '#6c675f', '#827a6d'], rng())
    box(out.solid, body, lot.x, y + h / 2 - 0.8, lot.z, w, h + 1.6, d, 0, SURF.plaster)
    // a rusticated ground floor the full storey tall, and a course over it
    course(out, lot.x, lot.z, w, d, y + sh / 2 - 0.5, sh + 1, 0.2, stone, SURF.brick)
    course(out, lot.x, lot.z, w, d, y + sh + 0.3, 0.5, 0.3, '#9c958a')
    course(out, lot.x, lot.z, w, d, y + h + 0.3, 0.6, 0.35, '#8f887c')
    // the stepped centre over the entrance: two tiers, each narrower
    for (const [k, rise] of [[0.44, 2.4], [0.2, 4.4]] as const) {
      const lx = f.fx ? 3.4 : frontLen * k
      const lz = f.fx ? frontLen * k : 3.4
      box(out.solid, body, f.x(0, -1.6), y + h + rise / 2, f.z(0, -1.6),
        lx, rise, lz, 0, SURF.plaster)
      box(out.solid, '#8f887c', f.x(0, -1.6), y + h + rise + 0.2, f.z(0, -1.6),
        lx + 0.4, 0.4, lz + 0.4, 0, SURF.paving)
    }
    if (out.detailed) {
      for (const [nx, nz, span, yaw] of faces(w, d)) {
        const fr = isFront(nx, nz)
        const xs = rhythm(span, fr ? 3.4 : 4.2, 1)
        // the ground floor's openings are wider and squat, a shop's; the
        // rustication stands proud of the render, so they sit on its face
        paneRow(out, lot.x + Math.sign(nx) * 0.2, lot.z + Math.sign(nz) * 0.2,
          nx, nz, yaw, xs, y + 2.8, 2.2, 2.2, litRate, dr,
          undefined, fr ? doorBay : undefined)
        for (let s = 1; s < storeys; s++) {
          paneRow(out, lot.x, lot.z, nx, nz, yaw, xs, rowY(s), 1.7, 2.6, litRate, dr)
        }
        if (!fr) continue
        // piers between the bays, standing clear of the parapet
        const pitch = xs.length > 1 ? xs[1] - xs[0] : span
        for (let i = 0; i <= xs.length; i++) {
          const o = i === xs.length ? xs[i - 1] + pitch / 2 : xs[i] - pitch / 2
          box(out.solid, body, f.x(o, 0.22), y + (sh + h + 1.4) / 2, f.z(o, 0.22),
            f.fx ? 0.44 : 0.7, h + 1.4 - sh, f.fx ? 0.7 : 0.44, 0, SURF.plaster)
        }
      }
      entrance(out, lot, f, y)
      // a flat canopy over the door, clear of anybody's head
      box(out.solid, '#3f3a34', f.x(0, 1.2), y + 5.95, f.z(0, 1.2),
        f.fx ? 2.6 : 6.0, 0.3, f.fx ? 6.0 : 2.6, 0, SURF.paving)
    }
    rooftop(out, lot.x, lot.z, w, d, y + h + 0.6, rng, dr, 0.3)
  } else {
    const body = pick(MODERN_RENDER, rng())
    box(out.solid, body, lot.x, y + h / 2 - 0.8, lot.z, w, h + 1.6, d, 0, SURF.plaster)
    // a dark recessed ground floor and the deep roof slab: the two lines a
    // sixties block is drawn with
    course(out, lot.x, lot.z, w, d, y + 2.1, 4.2, 0.06, '#3c4044', SURF.panel)
    course(out, lot.x, lot.z, w, d, y + h + 0.3, 0.6, 0.9, '#e2ddd2')
    if (out.detailed) {
      for (const [nx, nz, span, yaw] of faces(w, d)) {
        const sx = Math.sign(nx)
        const sz = Math.sign(nz)
        // ribbon glazing: one pane a storey, with a white spandrel over it
        for (let s = 1; s < storeys; s++) {
          const wy = rowY(s)
          panel(out.solid, '#2a3138', lot.x + nx, wy, lot.z + nz, span * 0.9, 1.9, yaw)
          if (dr() < litRate) {
            panel(out.glass, '#ffd291', lot.x + nx + sx * 0.03, wy, lot.z + nz + sz * 0.03,
              span * 0.9, 1.9, yaw)
          }
        }
        // the lobby glazing on the dark ground floor, lit all night
        panel(out.solid, '#243039', lot.x + nx + sx * 0.04, y + 2.3, lot.z + nz + sz * 0.04,
          span * 0.7, 3.0, yaw)
        panel(out.glass, '#ffe2ae', lot.x + nx + sx * 0.07, y + 2.3, lot.z + nz + sz * 0.07,
          span * 0.7, 3.0, yaw)
      }
      for (let s = 1; s < storeys; s++) {
        course(out, lot.x, lot.z, w, d, rowY(s) + 1.3, 0.5, 0.04, '#e2ddd2')
      }
      // balconies on the street face, staggered storey by storey so the
      // face reads as a pattern rather than as a stack of shelves
      const xs = rhythm(frontLen, 6.0, 1)
      for (let s = 1; s < storeys; s++) {
        for (let i = 0; i < xs.length; i++) {
          if ((i + s) % 2) continue
          const by = y + s * sh + 0.95
          box(out.solid, '#d8d2c6', f.x(xs[i], 0.7), by, f.z(xs[i], 0.7),
            f.fx ? 1.4 : 4.2, 0.24, f.fx ? 4.2 : 1.4, 0, SURF.paving)
          box(out.solid, '#6f7a7e', f.x(xs[i], 1.36), by + 0.6, f.z(xs[i], 1.36),
            f.fx ? 0.08 : 4.2, 1.0, f.fx ? 4.2 : 0.08, 0, SURF.panel)
        }
      }
      entrance(out, lot, f, y)
    }
    rooftop(out, lot.x, lot.z, w, d, y + h + 0.6, rng, dr, 0.15)
  }

  out.boxes.push(noStand(aabb(lot.x, y - 2, lot.z, w / 2 + 0.25, y + h + 0.7, d / 2 + 0.25)))
}

/** glyph-like marks on a sign board: a run of pale blocks of two sizes, so a
    fascia reads as lettered from across the street without a single letter */
const glyphs = (
  out: BuildOut, f: ReturnType<typeof front>, face: number, cy: number, n: number,
  len: number, dr: () => number,
) => {
  const ink = pick(['#e8e0c8', '#f0d890', '#d8e4e0'], dr())
  const count = Math.max(3, Math.min(9, Math.floor(len / 1.1)))
  const pitch = Math.min(1.05, len / count)
  for (let i = 0; i < count; i++) {
    if (dr() < 0.12) continue
    const o = (i - (count - 1) / 2) * pitch
    const tall = dr() < 0.3
    panel(out.solid, ink, f.x(o, n), cy + (tall ? 0.06 : 0), f.z(o, n),
      pitch * 0.62, tall ? 0.72 : 0.56, face)
  }
}

/**
 * The same envelope with its ground floor given over to trade: piers, a deep
 * glazed band with an awning, a lettered fascia and a blade sign over it,
 * flats in the storeys above with a cornice and a roof with things on it. It
 * is the single most common building in any real town centre and the
 * cheapest way to stop a mid-rise ring reading as housing blocks with
 * nothing to do between them.
 */
export const mixedUse = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const w = lot.w
  const d = lot.d
  const shopH = 6.6
  const storeys = Math.max(2, Math.round((lot.height - shopH) / 4.4))
  const h = shopH + storeys * 4.4
  const brick = rng() < 0.5
  const body = pick(brick ? TENEMENT_BRICK : DECO_RENDER, rng())
  const sign = pick(SIGNS, rng())
  const y = lot.baseY
  const dr = fork(rng)

  box(out.solid, body, lot.x, y + shopH + (h - shopH) / 2, lot.z,
    w, h - shopH + 0.4, d, 0, brick ? SURF.brick : SURF.plaster)
  // the retail base: a darker plinth the glazing is cut out of
  box(out.solid, '#4f4a43', lot.x, y + shopH / 2 - 0.5, lot.z,
    w, shopH + 1, d, 0, SURF.paving)
  course(out, lot.x, lot.z, w, d, y + h - 0.1, 0.9, 0.16, '#8d8578')
  course(out, lot.x, lot.z, w, d, y + h + 0.5, 0.6, 0.55, '#43403a')
  course(out, lot.x, lot.z, w, d, y + shopH + 0.2, 0.9, 0.2, '#5c574e')
  rooftop(out, lot.x, lot.z, w, d, y + h + 0.8, rng, dr, 0.55)

  if (out.detailed) {
    const f = front(lot)
    const frontLen = f.fx ? d : w
    const litRate = 0.35 + dr() * 0.4
    const group = dr() < 0.55 ? 2 : 1
    for (let s = 1; s < storeys; s++) {
      course(out, lot.x, lot.z, w, d, y + shopH + 1.3 + s * 4.4, 0.2, 0.1, '#8d8578')
    }
    for (const [nx, nz, span, yaw] of faces(w, d)) {
      const fr = Math.sign(nx) === f.fx && Math.sign(nz) === f.fz
      const xs = rhythm(span, 3.8, fr ? group : 1)
      for (let s = 0; s < storeys; s++) {
        const top = s === storeys - 1
        paneRow(out, lot.x, lot.z, nx, nz, yaw, xs, y + shopH + 2.6 + s * 4.4,
          1.6, top ? 1.7 : 2.2, litRate, dr, fr ? '#d9d2c2' : undefined)
      }
      // the shopfront band: wide panes between piers, warm at night on every
      // side, because a corner unit trades on both streets
      const n = bays(span, 6.2)
      for (let c = 0; c < n; c++) {
        const along = ((c + 0.5) / n - 0.5) * span * 0.9
        const ax = nx === 0 ? lot.x + along : lot.x + nx
        const az = nz === 0 ? lot.z + along : lot.z + nz
        const pw = (span * 0.9) / n - 0.9
        panel(out.solid, '#243039', ax, y + 3.3, az, pw, 3.6, yaw)
        panel(out.glass, '#ffe2ae', ax + (nx ? Math.sign(nx) * 0.04 : 0), y + 3.3,
          az + (nz ? Math.sign(nz) * 0.04 : 0), pw, 3.6, yaw)
      }
    }
    // the fascia with its lettering, and an awning over the entrance side
    box(out.solid, sign, f.x(0, 0.16), y + shopH - 0.7, f.z(0, 0.16),
      frontLen * 0.8, 1.1, 0.3, lot.face)
    glyphs(out, f, lot.face, y + shopH - 0.7, 0.33, frontLen * 0.62, dr)
    put(out.solid, BOX, sign, f.x(0, 0.9), y + 5.2, f.z(0, 0.9),
      0.42, lot.face, 0, frontLen * 0.66, 0.1, 1.9)
    // a blade sign on a bracket at one corner, the thing you see first
    // looking down a street rather than across it
    const bo = (frontLen / 2 - 0.9) * (dr() < 0.5 ? 1 : -1)
    const bladeC = pick(SIGNS, dr())
    box(out.solid, '#2c2e2f', f.x(bo, 0.8), y + shopH + 3.7, f.z(bo, 0.8),
      f.fx ? 1.6 : 0.1, 0.1, f.fx ? 0.1 : 1.6, 0, SURF.none)
    box(out.solid, bladeC, f.x(bo, 1.0), y + shopH + 2.5, f.z(bo, 1.0),
      f.fx ? 1.3 : 0.18, 2.2, f.fx ? 0.18 : 1.3, 0, SURF.none)
    // and the doorway into the flats above, beside the shop
    const o = frontLen * 0.34
    panel(out.solid, '#2b2b2e', f.x(o, 0.08), y + 2.4, f.z(o, 0.08), 1.9, 4.6, lot.face,
      SURF.plank)
    box(out.solid, '#8b867c', f.x(o, 0.7), y + 0.09, f.z(o, 0.7),
      2.6, 0.18, 1.3, lot.face, SURF.paving)
    keepOut(out, f.x(o, 0.7), f.z(o, 0.7), f.fx ? 0.75 : 1.4, f.fx ? 1.4 : 0.75)
  }

  out.boxes.push(noStand(aabb(lot.x, y - 2, lot.z, w / 2 + 0.3, y + h + 0.8, d / 2 + 0.3)))
}

/* ---------------------------------------------------------- block-scale -- */

/**
 * A shed the size of a block: corrugated walls, a barrel or gambrel or
 * shallow gable roof in metal grey, roller doors onto a concrete apron, a
 * loading dock you can climb onto, a clerestory strip under the eaves and
 * vent boxes on the ridge. The one building out here with no windows anybody
 * lives behind, which is exactly why a town needs a couple.
 */
export const warehouse = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const w = lot.w
  const d = lot.d
  const h = 9.2 + rng() * 3
  const body = pick(['#8a8f8c', '#7d8384', '#94907f', '#6f7a7c', '#9a9385'], rng())
  const metal = '#5b6164'
  const y = lot.baseY
  const f = front(lot)
  // the ridge runs the long way, so the gable ends are the short walls
  const long = w >= d
  const span = long ? d : w
  const run = long ? w : d

  box(out.solid, body, lot.x, y + h / 2 - 0.6, lot.z, w, h + 1.2, d, 0, SURF.panel)
  box(out.solid, '#4e4a44', lot.x, y + 0.5, lot.z, w + 0.3, 1.2, d + 0.3, 0, SURF.paving)

  const rise = span * (0.22 + rng() * 0.12)
  const roll = rng()
  const geo = roll < 0.4 ? BARREL : roll < 0.7 ? GAMBREL : PRISM
  put(out.solid, geo, metal, lot.x, y + h - 0.05, lot.z,
    0, long ? 0 : Math.PI / 2, 0, run * 1.04, rise, span * 1.06, SURF.panel)
  // vents along the ridge, which is most of what says "industrial" at range
  const vents = Math.max(2, Math.round(run / 9))
  for (let i = 0; i < vents; i++) {
    const t = ((i + 0.5) / vents - 0.5) * run * 0.8
    box(out.solid, '#4a4f52', lot.x + (long ? t : 0), y + h + rise * 0.92,
      lot.z + (long ? 0 : t), 1.3, 1.0, 1.3, 0, SURF.panel)
  }

  if (out.detailed) {
    // a clerestory strip under the eaves: the only daylight the floor gets,
    // and after dark the only sign that anything is running in there
    for (const [nx, nz, s, yaw] of faces(w, d)) {
      panel(out.solid, '#2b3339', lot.x + nx, y + h - 1.5, lot.z + nz, s * 0.82, 1.0, yaw)
      if (rng() < 0.5) {
        panel(out.glass, '#cfe3d6', lot.x + nx + Math.sign(nx) * 0.03, y + h - 1.5,
          lot.z + nz + Math.sign(nz) * 0.03, s * 0.82, 1.0, yaw)
      }
    }
    // roller doors and the apron they open onto
    const frontage = f.fx ? d : w
    for (const s of [-1, 1]) {
      const o = s * frontage * 0.24
      box(out.solid, '#4a4f52', f.x(o, 0.06), y + 2.9, f.z(o, 0.06),
        5.2, 5.8, 0.24, lot.face, SURF.panel)
      panel(out.solid, '#3a3f42', f.x(o, 0.2), y + 2.8, f.z(o, 0.2),
        4.6, 5.4, lot.face, SURF.panel)
    }
    box(out.solid, '#83807a', f.x(0, 4.5), y + 0.05, f.z(0, 4.5),
      frontage * 0.9, 0.12, 9.0, lot.face, SURF.paving)
    keepOut(out, f.x(0, 4.5), f.z(0, 4.5), f.fx ? 4.6 : frontage * 0.46, f.fx ? frontage * 0.46 : 4.6)
    // the dock: a ledge at truck-bed height with a step up onto it
    const dockX = f.x(frontage * 0.4, 1.3)
    const dockZ = f.z(frontage * 0.4, 1.3)
    box(out.solid, '#6f6a61', dockX, y + 0.6, dockZ, 5.0, 1.2, 2.6, lot.face, SURF.paving)
    out.boxes.push(aabb(dockX, y - 1, dockZ,
      f.fx ? 1.3 : 2.5, y + 1.2, f.fx ? 2.5 : 1.3))
    box(out.solid, '#8b867c', f.x(frontage * 0.4, 3.0), y + 0.3, f.z(frontage * 0.4, 3.0),
      5.0, 0.6, 1.2, lot.face, SURF.paving)
    out.boxes.push(aabb(f.x(frontage * 0.4, 3.0), y - 1, f.z(frontage * 0.4, 3.0),
      f.fx ? 0.6 : 2.5, y + 0.6, f.fx ? 2.5 : 0.6))
  }

  out.boxes.push(noStand(aabb(lot.x, y - 2, lot.z, w / 2 + 0.3, y + h, d / 2 + 0.3)))
}

/**
 * A chapel and its yard: a nave with its gable end to the street, a square
 * bell tower at the near corner under a spire, lancets down both flanks and a
 * rose window over the door. Every opening is glazed into the emissive pass,
 * so after dark this is the one building in a town that glows in a shape
 * rather than in a grid, and it is worth the extra kit for that alone.
 */
export const chapel = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const y = lot.baseY
  const f = front(lot)
  // the nave runs away from the street, so it wants the depth axis
  const naveW = Math.min(f.fx ? lot.d : lot.w, 16) * 0.62
  const naveL = Math.min(f.fx ? lot.w : lot.d, 40) * 0.78
  const h = 9.4
  const stone = pick(['#a49b88', '#9c968a', '#b0a692', '#8f8b80'], rng())
  const roofC = pick(['#4a4038', '#3f4a44', '#53433a'], rng())
  // in world axes: the nave's long axis lies along the facing direction
  const nw = f.fx ? naveL : naveW
  const nd = f.fx ? naveW : naveL
  /** how far along the facing the nave's west front stands, measured from the
      lot centre: back off the lot edge so the porch and the tower have
      somewhere to be. Everything on the front elevation is placed off this
      rather than off the lot's own edge, which is what the porch, the rose
      window and the tower all disagreed about the first time round. */
  const fw = f.wall - 1.6
  const nx_ = (o: number, n: number) => lot.x + f.fx * (fw + n) + f.fz * o
  const nz_ = (o: number, n: number) => lot.z + f.fz * (fw + n) - f.fx * o
  const cx = nx_(0, -naveL / 2)
  const cz = nz_(0, -naveL / 2)

  box(out.solid, stone, cx, y + h / 2 - 0.6, cz, nw, h + 1.2, nd, 0, SURF.brick)
  box(out.solid, '#7d766a', cx, y + 0.5, cz, nw + 0.4, 1.2, nd + 0.4, 0, SURF.paving)
  const rise = naveW * 0.62
  // PRISM's ridge runs along its own x and `put` scales before it rotates, so
  // a nave lying along world x wants no yaw at all: the quarter turn is what
  // the *other* facing needs, and having it the wrong way round laid the ridge
  // across the nave and left most of the roof off the building
  put(out.solid, PRISM, roofC, cx, y + h - 0.05, cz, 0, f.fx ? 0 : Math.PI / 2, 0,
    naveL * 1.04, rise, naveW * 1.14, SURF.shingle)
  out.boxes.push(noStand(aabb(cx, y - 2, cz, nw / 2 + 0.3, y + h, nd / 2 + 0.3)))

  // the tower, set at one end of the front elevation
  const side = rng() < 0.5 ? 1 : -1
  const tw = naveW * 0.46
  const th = h + 6.5 + rng() * 4
  const tx = nx_(side * (naveW / 2 + tw / 2 - 0.4), -tw / 2 + 0.4)
  const tz = nz_(side * (naveW / 2 + tw / 2 - 0.4), -tw / 2 + 0.4)
  box(out.solid, stone, tx, y + th / 2 - 0.6, tz, tw, th + 1.2, tw, 0, SURF.brick)
  box(out.solid, '#7d766a', tx, y + th + 0.3, tz, tw + 0.7, 0.6, tw + 0.7, SURF.paving)
  put(out.solid, CONE4, roofC, tx, y + th + 0.6 + tw * 0.9, tz,
    0, lot.face, 0, tw * 1.15, tw * 1.8, tw * 1.15, SURF.shingle)
  out.boxes.push(noStand(aabb(tx, y - 2, tz, tw / 2 + 0.25, y + th, tw / 2 + 0.25)))

  if (out.detailed) {
    // the belfry: dark louvred openings on all four sides, one lit lamp
    for (const [nx, nz, , yaw] of faces(tw, tw)) {
      panel(out.solid, '#2a2620', tx + nx, y + th - 2.6, tz + nz, tw * 0.42, 2.4, yaw)
    }
    put(out.glass, CYL12, '#ffdca6', tx, y + th - 2.6, tz, 0, 0, 0, 0.9, 0.9, 0.9)
    out.lamps.push({ x: tx, y: y + th - 2.6, z: tz })

    // lancets down the flanks, evenly spaced along the nave
    const n = Math.max(3, Math.round(naveL / 5))
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n - 0.5) * naveL * 0.86
      for (const s of [-1, 1]) {
        const wx = cx + (f.fx ? t : s * (naveW / 2 + 0.05))
        const wz = cz + (f.fx ? s * (naveW / 2 + 0.05) : t)
        const yaw = f.fx ? (s > 0 ? 0 : Math.PI) : (s > 0 ? Math.PI / 2 : -Math.PI / 2)
        lancet(out, wx, y + 4.6, wz, 1.2, 3.6, yaw,
          f.fx ? 0 : s, f.fx ? s : 0, rng() < 0.7)
      }
    }
    // the west front: a door under a rose window
    box(out.solid, '#7d766a', nx_(0, 0.06), y + 2.9, nz_(0, 0.06),
      3.4, 5.8, 0.5, lot.face, SURF.paving)
    panel(out.solid, '#3a2c1e', nx_(0, 0.34), y + 2.6, nz_(0, 0.34), 2.6, 5.0, lot.face,
      SURF.plank)
    put(out.solid, CYL12, '#2a323a', nx_(0, 0.2), y + 8.0, nz_(0, 0.2),
      Math.PI / 2, lot.face, 0, 2.6, 0.2, 2.6)
    put(out.glass, CYL12, '#ffcf82', nx_(0, 0.3), y + 8.0, nz_(0, 0.3),
      Math.PI / 2, lot.face, 0, 2.3, 0.1, 2.3)
    box(out.solid, '#8b867c', nx_(0, 2.4), y + 0.09, nz_(0, 2.4),
      4.0, 0.18, 4.4, lot.face, SURF.paving)
    keepOut(out, nx_(0, 2.4), nz_(0, 2.4), 2.3, 2.3)

    // the churchyard: a low wall around the lot and a scatter of headstones
    const yw = (f.fx ? lot.w : lot.d) / 2
    const yd = (f.fx ? lot.d : lot.w) / 2
    for (const [ox, oz, sw, sd] of [
      [0, yd, yw * 2, 0.5], [0, -yd, yw * 2, 0.5],
      [yw, 0, 0.5, yd * 2], [-yw, 0, 0.5, yd * 2],
    ] as const) {
      box(out.solid, '#8d8578', lot.x + ox, y + 0.55, lot.z + oz, sw, 1.1, sd, 0, SURF.brick)
      out.boxes.push(noStand(aabb(lot.x + ox, y - 1, lot.z + oz,
        sw / 2 + 0.05, y + 1.15, sd / 2 + 0.05)))
    }
    for (let i = 0; i < 9; i++) {
      const gx = lot.x + (rng() - 0.5) * yw * 1.7
      const gz = lot.z + (rng() - 0.5) * yd * 1.7
      if (Math.abs(gx - cx) < nw / 2 + 1.4 && Math.abs(gz - cz) < nd / 2 + 1.4) continue
      const gh = 0.8 + rng() * 0.7
      box(out.solid, '#9a948a', gx, y + gh / 2, gz, 0.7, gh, 0.22,
        rng() * 0.3 - 0.15, SURF.paving)
    }
  }
}

/**
 * A parking deck: open levels of slab and spandrel with the cars left out,
 * a solid stair core at one corner and a ramp climbing the flank. It is
 * mostly negative space, which is the point: a downtown of nothing but solid
 * towers has no depth to it, and the one structure you can see daylight
 * through gives the block behind it somewhere to be.
 */
export const parkingDeck = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const w = lot.w
  const d = lot.d
  const levels = 3 + Math.floor(rng() * 3)
  const lift = 3.6
  const y = lot.baseY
  const conc = '#8d887e'
  const dark = '#4a463f'

  // the plinth that carries the ground floor down to the dirt: the decks
  // above it are slabs, and a slab set at the lowest corner of a block-sized
  // footprint leaves daylight under three of its sides
  box(out.solid, '#6f6a61', lot.x, y - 0.4, lot.z, w + 0.4, 1.6, d + 0.4, 0, SURF.paving)
  for (let i = 0; i <= levels; i++) {
    const ly = y + i * lift
    // the deck slab, and above it the spandrel band that stops a car rolling
    box(out.solid, conc, lot.x, ly + 0.3, lot.z, w, 0.6, d, 0, SURF.paving)
    if (i < levels) {
      for (const [nx, nz, span] of faces(w, d)) {
        box(out.solid, conc, lot.x + nx, ly + 1.5, lot.z + nz,
          nx === 0 ? span : 0.4, 1.4, nz === 0 ? span : 0.4, 0, SURF.paving)
      }
      // and the dark behind the openings, so the deck is not see-through to
      // the street on the far side
      box(out.solid, dark, lot.x, ly + 2.1, lot.z,
        Math.max(2, w - 2.6), 2.6, Math.max(2, d - 2.6), 0, SURF.paving)
    }
  }
  // corner columns
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      box(out.solid, conc, lot.x + sx * (w / 2 - 0.5), y + (levels * lift) / 2,
        lot.z + sz * (d / 2 - 0.5), 1.0, levels * lift, 1.0, 0, SURF.paving)
    }
  // the stair core: the one solid mass, which is what gives the thing a front
  const cw = Math.min(6, w * 0.3)
  const cx = lot.x + (w / 2 - cw / 2) * (rng() < 0.5 ? 1 : -1)
  const cz = lot.z + (d / 2 - cw / 2) * (rng() < 0.5 ? 1 : -1)
  box(out.solid, '#7a756c', cx, y + (levels * lift + 2) / 2, cz,
    cw, levels * lift + 2, cw, 0, SURF.paving)
  if (out.detailed) {
    for (const [nx, nz, , yaw] of faces(cw, cw)) {
      for (let i = 0; i < levels; i++) {
        panel(out.solid, '#2a3138', cx + nx, y + 1.9 + i * lift, cz + nz, 1.1, 1.5, yaw)
        if (rng() < 0.5) {
          panel(out.glass, '#cfe0e6', cx + nx + Math.sign(nx) * 0.03,
            y + 1.9 + i * lift, cz + nz + Math.sign(nz) * 0.03, 1.1, 1.5, yaw)
        }
      }
    }
    const f = front(lot)
    box(out.solid, '#3f5a52', f.x(0, 0.1), y + 3.0, f.z(0, 0.1),
      (f.fx ? d : w) * 0.3, 1.2, 0.3, lot.face)
  }

  out.boxes.push(noStand(aabb(lot.x, y - 2, lot.z,
    w / 2 + 0.25, y + levels * lift + 2, d / 2 + 0.25)))
}

/* ------------------------------------------------------------ towers ---- */

/** the green of weathered copper, for the odd pyramid crown */
const COPPER = '#5b7a6c'

/**
 * A downtown tower: two or three setback stages so the silhouette has a
 * shoulder, standing on a lobby and finished with a crown. Setbacks stop a
 * skyline reading as a bar chart; the other three choices stop two towers
 * of the same height reading as one tower twice.
 *
 * - **The lobby** is a double-height glazed ground floor, lit all night.
 *   More than half the time it is an *arcade*: the glazing is set back
 *   behind a colonnade and the tower's first stage is carried over it on the
 *   columns, so the pavement runs in under the building. That one is
 *   collided as what it is (a core, a column each, and the mass above the
 *   arcade), not as a box round the footprint.
 * - **The skin** is one of three: a punched grid of paired windows (with a dark plant floor
 *   every ninth storey, the band real towers hide their machinery behind),
 *   piers (vertical fins between bays running the height of a stage, the
 *   glazing a dark strip between them), or bands (one ribbon of glass a
 *   storey, the curtain wall of a later decade).
 * - **The crown** is a copper or slate pyramid, a stepped top with a spire,
 *   a drum and needle, or a flat roof with its plant and bulkhead on show.
 */
export const tower = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const shade = pick(TOWER, rng())
  const stages = lot.height > 70 ? 3 : lot.height > 40 ? 2 : 1
  const y = lot.baseY
  const skin = rng()
  const crown = rng()
  const arcade = rng() < 0.6 && Math.min(lot.w, lot.d) > 16 && lot.height > 30
  const dr = fork(rng)
  const litRate = 0.22 + dr() * 0.4
  const lobbyH = 7.4
  let bottom = y
  let w = lot.w
  let d = lot.d
  const f = front(lot)

  for (let s = 0; s < stages; s++) {
    const share = s === stages - 1 ? 1 : 0.42 + rng() * 0.2
    const h = (lot.height - (bottom - y)) * share
    const ground = s === 0
    if (ground && arcade) {
      const inset = 3.2
      const cw = w - inset * 2
      const cd = d - inset * 2
      // the glazed core the arcade runs round, and the mass carried over it
      box(out.solid, '#3a4048', lot.x, y + lobbyH / 2 - 0.6, lot.z, cw, lobbyH + 1.2, cd, 0,
        SURF.panel)
      box(out.solid, shade, lot.x, y + (lobbyH + h) / 2, lot.z, w, h - lobbyH, d, 0,
        SURF.panel)
      out.boxes.push(noStand(aabb(lot.x, y - 2, lot.z, cw / 2 + 0.2, y + lobbyH, cd / 2 + 0.2)))
      out.boxes.push(noStand(aabb(lot.x, y + lobbyH, lot.z, w / 2 + 0.3, y + lot.height,
        d / 2 + 0.3)))
      // columns round the perimeter, one every six or seven units
      for (const [nx, nz, span] of faces(w, d)) {
        const n = Math.max(2, Math.round(span / 6.5))
        for (let i = 0; i <= n; i++) {
          // each corner belongs to the face that comes first round the
          // building, so it is stamped once
          if (nz === 0 && (i === 0 || i === n)) continue
          const t = (i / n - 0.5) * (span - 1.0)
          const px = lot.x + (nx === 0 ? t : Math.sign(nx) * (w / 2 - 0.5))
          const pz = lot.z + (nz === 0 ? t : Math.sign(nz) * (d / 2 - 0.5))
          box(out.solid, '#6a6f74', px, y + lobbyH / 2 - 0.3, pz, 0.9, lobbyH + 0.6, 0.9, 0,
            SURF.paving)
          out.boxes.push(noStand(aabb(px, y - 1, pz, 0.5, y + lobbyH, 0.5)))
        }
      }
      if (out.detailed) {
        for (const [nx, nz, span, yaw] of faces(cw, cd)) {
          const sx = Math.sign(nx)
          const sz = Math.sign(nz)
          panel(out.solid, '#243039', lot.x + nx, y + lobbyH / 2, lot.z + nz,
            span * 0.9, lobbyH - 1.4, yaw)
          panel(out.glass, '#ffe6b8', lot.x + nx + sx * 0.03, y + lobbyH / 2,
            lot.z + nz + sz * 0.03, span * 0.9, lobbyH - 1.4, yaw)
        }
      }
    } else {
      box(out.solid, shade, lot.x, bottom + h / 2 - 0.6, lot.z, w, h + 1.2, d, 0, SURF.panel)
      if (ground) {
        // a plinth the lobby glazing is set into
        course(out, lot.x, lot.z, w, d, y + lobbyH / 2 - 0.5, lobbyH + 1, 0.2, '#3f444a')
        if (out.detailed) {
          for (const [nx, nz, span, yaw] of faces(w, d)) {
            const sx = Math.sign(nx)
            const sz = Math.sign(nz)
            panel(out.solid, '#243039', lot.x + nx + sx * 0.2, y + lobbyH / 2,
              lot.z + nz + sz * 0.2, span * 0.8, lobbyH - 2.0, yaw)
            panel(out.glass, '#ffe6b8', lot.x + nx + sx * 0.23, y + lobbyH / 2,
              lot.z + nz + sz * 0.23, span * 0.8, lobbyH - 2.0, yaw)
          }
          // a canopy over the doors, over head height
          const frontLen = f.fx ? d : w
          box(out.solid, '#2f3338', f.x(0, 1.6), y + lobbyH - 1.0, f.z(0, 1.6),
            f.fx ? 3.2 : frontLen * 0.4, 0.4, f.fx ? frontLen * 0.4 : 3.2, 0, SURF.paving)
        }
      }
    }
    // the stage's cap: a thin lip, or on the odd tower a heavier cornice
    course(out, lot.x, lot.z, w, d, bottom + h + 0.3, 0.6, 0.3, '#3f444a')
    if (skin < 0.34 && s < stages - 1) {
      course(out, lot.x, lot.z, w, d, bottom + h - 0.9, 1.4, 0.12, '#4a5057')
    }

    if (out.detailed) {
      const y0 = (ground ? y + lobbyH : bottom) + 2.6
      const top = bottom + h - 1.4
      const storeys = Math.max(1, Math.floor((top - y0) / 5.4) + 1)
      for (const [nx, nz, span, yaw] of faces(w, d)) {
        const sx = Math.sign(nx)
        const sz = Math.sign(nz)
        if (skin < 0.34) {
          const xs = rhythm(span, 3.9, 2)
          for (let st = 0; st < storeys; st++) {
            const wy = y0 + st * 5.4
            if (wy > top) break
            // a plant floor every ninth storey: no panes, a louvred band
            if (st % 9 === 8) continue
            paneRow(out, lot.x, lot.z, nx, nz, yaw, xs, wy, 1.9, 2.4, litRate, dr)
          }
        } else if (skin < 0.67) {
          const xs = rhythm(span, 3.6, 1)
          const pitch = xs.length > 1 ? xs[1] - xs[0] : span
          const gh = top - y0 + 2.2
          for (const a of xs) {
            const ax = nx === 0 ? lot.x + a : lot.x + nx
            const az = nz === 0 ? lot.z + a : lot.z + nz
            panel(out.solid, '#28303a', ax, y0 - 1.1 + gh / 2, az, pitch * 0.62, gh, yaw)
            for (let st = 0; st < storeys; st++) {
              const wy = y0 + st * 5.4
              if (wy > top) break
              if (dr() < litRate) {
                panel(out.glass, '#ffd291', ax + sx * 0.03, wy, az + sz * 0.03,
                  pitch * 0.62, 2.4, yaw)
              }
            }
          }
          // the fins between bays, proud of the glazing
          for (let i = 0; i <= xs.length; i++) {
            const a = (i < xs.length ? xs[i] : xs[i - 1] + pitch) - pitch / 2
            box(out.solid, shade,
              lot.x + (nx === 0 ? a : nx + sx * 0.2), y0 - 1.1 + gh / 2,
              lot.z + (nz === 0 ? a : nz + sz * 0.2),
              0.5, gh, 0.5, 0, SURF.paving)
          }
        } else {
          for (let st = 0; st < storeys; st++) {
            const wy = y0 + st * 5.4
            if (wy > top) break
            panel(out.solid, '#28303a', lot.x + nx, wy, lot.z + nz, span * 0.94, 2.8, yaw)
            if (dr() < litRate) {
              panel(out.glass, '#ffd291', lot.x + nx + sx * 0.03, wy, lot.z + nz + sz * 0.03,
                span * 0.94, 2.8, yaw)
            }
          }
        }
      }
      if (skin < 0.34) {
        for (let st = 8; st < storeys; st += 9) {
          const wy = y0 + st * 5.4
          if (wy > top) break
          course(out, lot.x, lot.z, w, d, wy, 2.6, 0.08, '#3a3f45', SURF.panel)
        }
      }
    }
    bottom += h
    if (s < stages - 1) {
      w *= 0.74
      d *= 0.74
    }
  }

  // the crown, on the last stage's own footprint
  const top = bottom + 0.6
  const tall = lot.height > 60
  if (crown < 0.26) {
    const rise = Math.min(w, d) * 0.45 + 2
    put(out.solid, CONE4, pick([COPPER, '#3a3f45', '#4a4038'], rng()),
      lot.x, top + rise / 2, lot.z, 0, 0, 0, w * 1.04, rise, d * 1.04, SURF.shingle)
    if (tall) shaft(out.solid, '#6a6f74', lot.x, top + rise - 0.4, lot.z, 0.2, 8, 0.06, 6)
  } else if (crown < 0.5) {
    // stepped: two shrinking storeys and a spire
    let sw = w * 0.72
    let sd = d * 0.72
    let sy = top
    for (let i = 0; i < 2; i++) {
      const sh = 4.4 - i
      box(out.solid, shade, lot.x, sy + sh / 2, lot.z, sw, sh, sd, 0, SURF.panel)
      course(out, lot.x, lot.z, sw, sd, sy + sh + 0.2, 0.4, 0.2, '#3f444a')
      sy += sh + 0.4
      sw *= 0.66
      sd *= 0.66
    }
    shaft(out.solid, '#7a7f84', lot.x, sy, lot.z, Math.min(sw, sd) * 0.3, 10 + lot.height * 0.08,
      0.02, 8)
  } else if (crown < 0.68) {
    // a drum and a needle
    const r = Math.min(w, d) * 0.3
    shaft(out.solid, shade, lot.x, top, lot.z, r, 5, r * 0.92, 12, 0, SURF.panel)
    shaft(out.solid, '#3f444a', lot.x, top + 5, lot.z, r * 1.08, 0.6, r * 1.08, 12)
    put(out.solid, CONE12, '#6a6f74', lot.x, top + 5.6 + r * 1.6, lot.z, 0, 0, 0,
      r * 1.2, r * 3.2, r * 1.2, SURF.panel)
  } else {
    // flat, with the machinery on show
    box(out.solid, '#4a5054', lot.x, top + 2.2, lot.z, w * 0.46, 4.4, d * 0.4, 0, SURF.panel)
    rooftop(out, lot.x, lot.z, w, d, top, rng, dr, 0)
    if (tall) {
      shaft(out.solid, '#6a6f74', lot.x, top + 4.4, lot.z, 0.22, 9, 0.1, 6)
      box(out.solid, '#5a1e1e', lot.x, top + 13.6, lot.z, 0.7, 1.0, 0.7)
    }
  }

  if (!arcade) {
    out.boxes.push(noStand(aabb(lot.x, y - 2, lot.z,
      lot.w / 2 + 0.3, y + lot.height, lot.d / 2 + 0.3)))
  }
}

/**
 * A slab: one flat plate with vertical fins running the whole height of its
 * broad faces and ribbon glazing between them. No setbacks at all, which is
 * exactly the point: standing next to the stepped kind it reads as a
 * different decade rather than as the same tower at a different width.
 */
export const slabTower = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const shade = pick(TOWER, rng())
  const y = lot.baseY
  const thin = Math.min(lot.w, lot.d) * 0.62
  const wide = Math.max(lot.w, lot.d)
  const alongX = lot.w >= lot.d
  const w = alongX ? wide : thin
  const d = alongX ? thin : wide
  const h = lot.height
  const storeys = Math.max(4, Math.round(h / 4.4))
  const litRate = 0.2 + rng() * 0.4

  box(out.solid, shade, lot.x, y + h / 2 - 0.6, lot.z, w, h + 1.2, d, 0, SURF.panel)
  box(out.solid, '#3a3f45', lot.x, y + 2.2, lot.z, w + 0.5, 4.4, d + 0.5, 0, SURF.paving)
  box(out.solid, '#3f444a', lot.x, y + h + 0.5, lot.z, w + 0.7, 1.0, d + 0.7, 0, SURF.paving)
  // rooftop plant and a mast, which is what a flat top needs to not read as a
  // block that ran out of budget
  box(out.solid, '#4a5054', lot.x + (rng() - 0.5) * w * 0.3, y + h + 2.6,
    lot.z + (rng() - 0.5) * d * 0.3, w * 0.34, 3.2, d * 0.6, 0, SURF.panel)
  shaft(out.solid, '#6a6f74', lot.x, y + h + 4.2, lot.z, 0.22, 9, 0.1, 6)
  box(out.solid, '#5a1e1e', lot.x, y + h + 13.4, lot.z, 0.7, 1.0, 0.7)

  if (out.detailed) {
    const broad = alongX ? w : d
    const fins = Math.max(3, Math.round(broad / 3.4))
    // the lobby: glazing set into the dark plinth, lit all night, and a
    // canopy over the doors on whichever face meets the street
    const f = front(lot)
    for (const [nx, nz, span, yaw] of faces(w, d)) {
      const sx = Math.sign(nx)
      const sz = Math.sign(nz)
      panel(out.solid, '#243039', lot.x + nx + sx * 0.25, y + 2.3, lot.z + nz + sz * 0.25,
        span * 0.8, 3.2, yaw)
      panel(out.glass, '#ffe6b8', lot.x + nx + sx * 0.28, y + 2.3, lot.z + nz + sz * 0.28,
        span * 0.8, 3.2, yaw)
    }
    const fw = (f.fx ? d : w) / 2 + 0.25
    box(out.solid, '#2f3338', lot.x + f.fx * (fw + 1.4), y + 5.2, lot.z + f.fz * (fw + 1.4),
      f.fx ? 2.8 : Math.min(w, 9), 0.36, f.fx ? Math.min(d, 9) : 2.8, 0, SURF.paving)
    for (const [nx, nz, span, yaw] of faces(w, d)) {
      const isBroad = alongX ? nz !== 0 : nx !== 0
      if (isBroad) {
        // the fins stand 0.2 proud of the glass, which is what casts the
        // vertical shadow line that makes a slab read as ribbed rather than
        // striped
        for (let i = 0; i <= fins; i++) {
          const t = (i / fins - 0.5) * span
          box(out.solid, shade,
            lot.x + (nx === 0 ? t : nx + Math.sign(nx) * 0.15),
            y + h / 2,
            lot.z + (nz === 0 ? t : nz + Math.sign(nz) * 0.15),
            0.5, h, 0.5, 0, SURF.paving)
        }
      }
      // ribbon glazing: one long pane a storey instead of a grid of small
      // ones, which is both the right look for a slab and a tenth the quads
      for (let s = 1; s < storeys; s++) {
        const wy = y + 4.4 + s * 4.4
        if (wy > y + h - 2) break
        panel(out.solid, '#28303a', lot.x + nx, wy, lot.z + nz, span * 0.94, 2.6, yaw)
        if (rng() < litRate) {
          panel(out.glass, '#ffd291', lot.x + nx + Math.sign(nx) * 0.03, wy,
            lot.z + nz + Math.sign(nz) * 0.03, span * 0.94, 2.6, yaw)
        }
      }
    }
  }

  out.boxes.push(noStand(aabb(lot.x, y - 2, lot.z, w / 2 + 0.4, y + h, d / 2 + 0.4)))
}

/**
 * A round tower: courses of body and glazing stacked up a cylinder, capped
 * with a plant ring and a mast. The banding does the work a window grid does
 * on a rectangular tower for a fraction of the geometry, one open-ended tube
 * a storey rather than forty quads, and a curve in a skyline of boxes is
 * worth more than either.
 */
export const roundTower = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const shade = pick(TOWER, rng())
  const y = lot.baseY
  const r = Math.min(lot.w, lot.d) / 2
  const h = lot.height
  const storeys = Math.max(4, Math.round(h / 4.6))
  const lift = h / storeys
  const litRate = 0.25 + rng() * 0.4
  // a gentle batter: the top is a little narrower than the base, which is
  // what keeps a plain cylinder from reading as a pipe
  const taperK = 0.86

  shaft(out.solid, '#3f444a', lot.x, y - 1.2, lot.z, r * 1.06, 4.2, r * 1.04, 12, 0,
    SURF.paving)
  for (let s = 0; s < storeys; s++) {
    const t0 = s / storeys
    const t1 = (s + 1) / storeys
    const r0 = r * (1 - (1 - taperK) * t0)
    const r1 = r * (1 - (1 - taperK) * t1)
    const y0 = y + s * lift
    // body course, then the glazing band sunk very slightly inside it
    shaft(out.solid, shade, lot.x, y0, lot.z, r0, lift * 0.42,
      r0 + (r1 - r0) * 0.42, 12, 0, SURF.panel)
    const gr = r0 + (r1 - r0) * 0.42
    put(out.solid, TUBE12, '#28303a', lot.x, y0 + lift * 0.42 + lift * 0.29, lot.z,
      0, 0, 0, gr * 1.96, lift * 0.58, gr * 1.96)
    if (out.detailed && rng() < litRate) {
      put(out.glass, TUBE12, '#ffd291', lot.x, y0 + lift * 0.42 + lift * 0.29, lot.z,
        0, 0, 0, gr * 2.0, lift * 0.52, gr * 2.0)
    }
  }
  const rt = r * taperK
  shaft(out.solid, '#3f444a', lot.x, y + h, lot.z, rt * 1.1, 1.0, rt * 1.1, 12, 0,
    SURF.paving)
  shaft(out.solid, '#4a5054', lot.x, y + h + 1.0, lot.z, rt * 0.6, 2.6, rt * 0.5, 8, 0,
    SURF.panel)
  shaft(out.solid, '#6a6f74', lot.x, y + h + 3.6, lot.z, 0.2, 8, 0.09, 6)
  box(out.solid, '#5a1e1e', lot.x, y + h + 12.0, lot.z, 0.6, 0.9, 0.6)

  out.boxes.push(noStand(aabb(lot.x, y - 2, lot.z, r + 0.3, y + h, r + 0.3)))
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
 * wall registering its own collision box so the doorway, which faces the
 * street the lot faces rather than a fixed compass point, is genuinely
 * walk-through. Inside: shelf runs stocked with goods, a counter with a
 * worktop and a till, wall shelves, a rug and a hung ceiling light. Outside:
 * glazing with sills, a sign band, sometimes an awning, and a stoop of steps
 * up to the floor.
 *
 * The floor sits above `lot.topY`, the *highest* ground under the footprint,
 * because a slab at the lowest corner is a slab the terrain mesh (and the
 * grass field) pokes up through; it registers a standable box so the player
 * walks on planks, not on the dirt the slab hides. The stoop's treads each
 * rise less than the walk's step allowance, so entering is just walking.
 *
 * Everything is stamped axis-aligned (the collision model is AABBs), so
 * facing is resolved cardinally: `f` is the forward normal, `r` runs along
 * the front wall, and `boxL` maps shop-local (u along the front, v toward it)
 * into world space. The ceiling registers as an obstacle the same way the
 * house's does: the overworld has no level-wide ceiling, so without a slab up
 * there the third-person boom would rise straight through the roof.
 */
export const shopFront = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const W = Math.min(lot.w, 26)
  const D = Math.min(lot.d, 22)
  const body = pick(BODY, rng())
  const baseY = lot.baseY
  /** the sales floor: clear of the dirt everywhere in the footprint */
  const floorY = lot.topY + 0.22

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
    const b = aabb(wx(u, v), y0, wz(u, v),
      (fx !== 0 ? lv : lu) / 2 + pad, y1, (fx !== 0 ? lu : lv) / 2 + pad)
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
    out.boxes.push(noStand(aabb(lot.x, baseY - 2, lot.z,
      W / 2 + 0.2, floorY + SHOP_H, D / 2 + 0.2)))
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

  // ceiling slab doubling as the flat roof, with a light lining underneath:
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
  // the night-emissive glow, so by day the interior shows through from the
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
  // visibly different species, the tell that only one of them worked.
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
  // `rise` is measured to the footprint's lowest corner: the ground at the
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
    // sill trim outside, and the warm pane that comes up with the dusk:
    // by day it is invisible and the opening is simply open
    boxL(trimD, s * uGlass, halfV - 0.04, sillTop - 0.06, winW + 0.24, 0.14, 0.3)
    for (const f of [1, -1] as const) {
      panelL(out.glass, '#ffe2ae', s * uGlass, halfV - WALL_T / 2 + f * 0.02,
        (sillTop + winTop) / 2, winW, winTop - sillTop, f)
    }
  }
  const signC = pick(SIGNS, rng())
  boxL(signC, 0, halfV + 0.02, floorY + SHOP_H - 0.55, 2 * halfU * 0.82, 1.05, 0.28)
  if (rng() < 0.55) {
    // a canvas awning over the glazing, drooping toward the street
    put(out.solid, BOX, signC, wx(0, halfV + 0.62), floorY + 4.86, wz(0, halfV + 0.62),
      0.42, lot.face, 0, 2 * halfU * 0.88, 0.08, 1.6)
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
      boxL(pick(GOODS, rng()),
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
      boxL(pick(GOODS, rng()),
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

/* ------------------------------------------------------------- casting -- */

export type BuildKind =
  | 'house' | 'shop' | 'midrise' | 'mixed'
  | 'tower' | 'slab' | 'round'
  | 'warehouse' | 'chapel' | 'parking'

/** what goes on one lot of a subdivided block */
export const KIND_FOR = (district: District, roll: number): BuildKind =>
  district === 'downtown'
    ? roll < 0.3 ? 'slab' : roll < 0.44 ? 'round' : 'tower'
    : district === 'midrise'
      ? roll < 0.1 ? 'shop' : roll < 0.32 ? 'mixed' : 'midrise'
      : roll < 0.07 ? 'shop' : 'house'

/** ...and what the occasional whole block turns into instead of being carved
    into lots. These are the kits too big to sit on a share of a block: a
    warehouse needs a run, a chapel needs a yard, a deck needs a footprint */
export const BLOCK_KIND_FOR = (district: District, roll: number): BuildKind =>
  district === 'downtown'
    ? roll < 0.7 ? 'parking' : 'warehouse'
    : district === 'midrise'
      ? roll < 0.4 ? 'warehouse' : roll < 0.74 ? 'parking' : 'chapel'
      : roll < 0.62 ? 'chapel' : 'warehouse'

/** how often a block skips subdivision entirely and takes one of the above */
export const BLOCK_KIND_RATE = (district: District) =>
  district === 'downtown' ? 0.1 : district === 'midrise' ? 0.16 : 0.09

/** the three block-scale kits, so the chunk builder can ask whether the kind
    it rolled wants a whole block rather than a share of one */
export const isBlockKind = (k: BuildKind) =>
  k === 'warehouse' || k === 'chapel' || k === 'parking'
