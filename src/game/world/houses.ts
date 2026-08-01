import { noStand } from '../physics/collision'
import { SURF, type SurfaceId } from './surface'
import {
  BODY, CONE4, GLASS_DARK, GLASS_LIT, HIP, LIME, PRISM, ROOFS, SHED, TRIM,
  aabb, box, frameOf, panel, pick, put, type BuildOut, type Lot,
} from './kitbash'

/*
  What stands on a suburban lot.

  One entry point, `suburbHouse`, and five plans behind it. That split is the
  whole point of the module: the previous single kit rolled a dozen
  independent booleans (two storeys or one, gable or pyramid, porch or not,
  garage or not) and a street of them still read as one house wearing
  different hats, because every one of them was the same rectangle with the
  same eave line and the same three windows across the front. What actually
  breaks a street up is *plan*: a cottage is small and steep and sits low, a
  ranch is wide and flat and mostly porch, a townhouse is narrow and tall and
  meets the pavement on a stoop. So each of those is written out as its own
  kit, and the rolls inside a kit only decide its dressing.

  Everything is written in the lot's own frame (kitbash.ts's `frameOf`): `u`
  runs along the frontage, `v` out toward the street, and the four cardinal
  facings fall out of two sign flips. `mir` flips `u` for half of them, which
  doubles the read of variety for the cost of one multiply, since it moves the
  garage, the chimney, the door offset and the wing all to the other end at
  once.

  Two measurements everything here is tuned against. The eye is at 3.55 units,
  so a door under about 4.7 reads as a dollhouse and a canopy under 5.5 is
  something the player walks into. And a solid registers one collision box per
  mass, `noStand` wherever the roof is above the box top, because otherwise
  the eave line is a ledge you can stand on and the roof is a wall you cannot.
*/

/** the plans, in the order they are rolled */
export type HousePlan = 'gabled' | 'cottage' | 'ranch' | 'townhouse' | 'villa'

/** brick or render: about a third of a street is brick, which is what stops a
    row of houses reading as one material repeated */
const skinOf = (r: number): SurfaceId => (r < 0.34 ? SURF.brick : SURF.plaster)

/**
 * Everything a plan needs to stamp itself: the lot's frame with `mir` already
 * folded in, the paint it drew, and local-space verbs for a box, a collision
 * box, a wall quad and a roof. Written once here because five plans otherwise
 * write the same eight lines of frame maths and four of them get it wrong.
 */
const context = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const f = frameOf(lot)
  const mir = rng() < 0.5 ? 1 : -1
  const wx = (u: number, v: number) => f.x(u * mir, v)
  const wz = (u: number, v: number) => f.z(u * mir, v)

  /** a box in lot-local space: `lu` along the frontage, `lv` toward it */
  const b = (
    hex: string, u: number, v: number, cy: number,
    lu: number, h: number, lv: number, surf: SurfaceId = SURF.none,
  ) => box(out.solid, hex, wx(u, v), cy, wz(u, v),
    f.ex(lu, lv), h, f.ez(lu, lv), 0, surf)

  /** its collision twin; `stand` marks the top as a real surface */
  const solid = (
    u: number, v: number, lu: number, lv: number, y0: number, y1: number,
    stand = false, pad = 0,
  ) => {
    const s = aabb(wx(u, v), y0, wz(u, v),
      f.ex(lu, lv) / 2 + pad, y1, f.ez(lu, lv) / 2 + pad)
    out.boxes.push(stand ? s : noStand(s))
  }

  /** the yaw of a wall whose outward local normal is (du, dv) */
  const yawOf = (du: number, dv: number) =>
    dv > 0 ? lot.face
      : dv < 0 ? lot.face + Math.PI
        : lot.face + (du * mir > 0 ? Math.PI / 2 : -Math.PI / 2)

  /** a roof shape seated with its eaves at `eaveY`. `cross` turns the ridge
      ninety degrees, so a gable end faces the street instead of a long slope */
  const roof = (
    geo: Parameters<typeof put>[1], hex: string,
    u: number, v: number, eaveY: number,
    lu: number, rise: number, lv: number, cross = false,
  ) => put(out.solid, geo, hex, wx(u, v), eaveY, wz(u, v),
    0, lot.face + (cross ? Math.PI / 2 : 0), 0,
    cross ? lv : lu, rise, cross ? lu : lv, SURF.shingle)

  return { out, lot, rng, f, mir, wx, wz, b, solid, yawOf, roof }
}

type Ctx = ReturnType<typeof context>

/* ------------------------------------------------------------- fittings -- */

/**
 * Frame, always-dark glass, and a sometimes-lit emissive copy, on the wall
 * whose outward local normal is (du, dv). The dark pane goes into the solid
 * pass first: the emissive copy is invisible by day, and a frame with nothing
 * in it reads as a blank sheet of paper stuck to the wall.
 */
const window_ = (
  c: Ctx, u: number, v: number, cy: number, w: number, h: number,
  du: number, dv: number, litRate: number, shutters = false,
) => {
  const flank = du !== 0
  c.b(TRIM, u, v, cy, flank ? 0.16 : w + 0.4, h + 0.4, flank ? w + 0.4 : 0.16,
    SURF.plaster)
  const yaw = c.yawOf(du, dv)
  panel(c.out.solid, GLASS_DARK,
    c.wx(u + du * 0.1, v + dv * 0.1), cy, c.wz(u + du * 0.1, v + dv * 0.1),
    w, h, yaw)
  if (c.rng() < litRate) {
    panel(c.out.glass, GLASS_LIT,
      c.wx(u + du * 0.14, v + dv * 0.14), cy, c.wz(u + du * 0.14, v + dv * 0.14),
      w, h, yaw)
  }
  if (!shutters) return
  // louvred boards either side, standing a little proud of the frame
  for (const s of [-1, 1]) {
    const o = (w / 2 + 0.3) * s
    c.b('#4d5c52', u + (flank ? 0 : o), v + (flank ? o : 0), cy,
      flank ? 0.1 : 0.5, h + 0.3, flank ? 0.5 : 0.1, SURF.plank)
  }
}

/** the front door: a surround, a leaf, a threshold slab, and the path out to
    the kerbward edge of the lot */
const frontDoor = (
  c: Ctx, u: number, hv: number, y: number, hex = '#33261a', h = 5.2,
) => {
  c.b(TRIM, u, hv + 0.06, y + h / 2, 2.3, h + 0.2, 0.18, SURF.plaster)
  panel(c.out.solid, hex, c.wx(u, hv + 0.18), y + h / 2 - 0.12, c.wz(u, hv + 0.18),
    1.9, h - 0.3, c.yawOf(0, 1), SURF.plank)
  // a knob, because a plank with no ironwork on it reads as a panel
  c.b('#c8ac63', u + 0.68, hv + 0.24, y + 2.3, 0.14, 0.14, 0.1)
  c.b('#8b867c', u, hv + 2.7, y + 0.05, 1.3, 0.1, 4.6, SURF.paving)
}

/** a chimney stack, rising from `fromY` to clear of the ridge */
const chimney = (c: Ctx, u: number, v: number, fromY: number, topY: number) => {
  c.b('#41372f', u, v, (fromY + topY) / 2, 0.9, topY - fromY, 0.9, SURF.brick)
  c.b('#4c4740', u, v, topY + 0.14, 1.1, 0.28, 1.1, SURF.paving)
}

/** a low frontage boundary: hedge, picket fence or garden wall. Kept under
    1.2 tall and thin, so the hop arc clears it with time to spare */
const frontage = (c: Ctx, hu: number, hv: number, y: number) => {
  const r = c.rng()
  if (r > 0.62) return
  const span = hu * 1.5
  const v = hv + 3.2
  if (r < 0.22) {
    c.b('#3d5230', 0, v, y + 0.45, span, 0.9, 0.8)
    c.solid(0, v, span, 0.8, y - 1, y + 0.9, false, 0.1)
    return
  }
  if (r < 0.44) {
    // a picket run: rails plus a paling every 0.44, with a gap at the path
    c.b('#cfc7b4', 0, v, y + 0.42, span, 0.09, 0.1, SURF.plank)
    c.b('#cfc7b4', 0, v, y + 0.94, span, 0.09, 0.1, SURF.plank)
    for (let u = -span / 2 + 0.2; u <= span / 2 - 0.2; u += 0.44) {
      if (Math.abs(u) < 1.1) continue
      c.b('#ded6c2', u, v, y + 0.62, 0.16, 1.24, 0.14, SURF.plank)
    }
    c.solid(0, v, span, 0.34, y - 1, y + 1.1, false, 0.05)
    return
  }
  c.b('#8d8578', 0, v, y + 0.5, span, 1.0, 0.44, SURF.brick)
  c.b('#a09789', 0, v, y + 1.06, span, 0.12, 0.58, SURF.paving)
  c.solid(0, v, span, 0.58, y - 1, y + 1.12, false, 0.05)
}

/** a back-garden shed, which is most of what makes a rear elevation read as
    lived in rather than as the blank side of a box */
const gardenShed = (c: Ctx, hu: number, hv: number, y: number) => {
  if (c.rng() > 0.4) return
  const u = (hu - 1.6) * (c.rng() < 0.5 ? -1 : 1)
  const v = -(hv + 2.6)
  c.b('#6b5a44', u, v, y + 1.35, 2.6, 2.7, 2.2, SURF.plank)
  c.roof(SHED, '#3d3a33', u, v, y + 2.7, 2.9, 0.7, 2.5)
  panel(c.out.solid, '#4a3d30', c.wx(u, v - 1.12), y + 1.2, c.wz(u, v - 1.12),
    1.0, 2.1, c.yawOf(0, -1), SURF.plank)
  c.solid(u, v, 2.6, 2.2, y - 1, y + 2.7, false, 0.1)
}

/** an attached garage on a wide enough lot */
const garage = (c: Ctx, hu: number, hv: number, y: number, side: number) => {
  const gu = hu * 0.5
  const gv = hv * 0.74
  const gh = 4.9
  const u = side * (hu + gu - 0.15)
  const body = pick(BODY, c.rng())
  c.b(body, u, 0, y + gh / 2 - 0.5, gu * 2, gh + 1, gv * 2, SURF.plaster)
  c.b('#4c4740', u, 0, y + gh + 0.16, gu * 2 + 0.3, 0.4, gv * 2 + 0.3, SURF.paving)
  if (c.out.detailed) {
    panel(c.out.solid, '#4a4640', c.wx(u, gv + 0.06), y + 2.1, c.wz(u, gv + 0.06),
      gu * 1.4, 4.0, c.yawOf(0, 1), SURF.plank)
    // the drive, so the garage door does not open onto turf
    c.b('#83807a', u, gv + 3.0, y + 0.04, gu * 1.8, 0.09, 6.0, SURF.paving)
  }
  c.solid(u, 0, gu * 2, gv * 2, y - 2, y + gh, false, 0.25)
}

/* ---------------------------------------------------------------- plans -- */

/**
 * The workhorse: a rendered or brick box under a gable, a hip or the odd flat
 * parapet, one or two storeys, and about a third of the time a cross wing
 * projecting toward the street with its own gable end. That wing is the
 * cheapest silhouette this module has, one extra mass and one extra roof, and
 * it is what makes a run of these stop reading as a row of shoeboxes.
 */
const gabled = (c: Ctx) => {
  const { lot, rng, out } = c
  const y = lot.baseY
  const two = rng() < 0.34
  const h = two
    ? Math.max(9.6, Math.min(lot.height * 1.35, 12.2))
    : Math.max(6.5, Math.min(lot.height, 8.8))
  const body = pick(BODY, rng())
  const roofC = pick(ROOFS, rng())
  const skin = skinOf(rng())
  const litRate = 0.35 + rng() * 0.5
  const wing = rng() < 0.36 && c.f.hu > 5.4
  // the wing takes an end of the frontage; the main mass gives it up
  const wu = wing ? c.f.hu * 0.42 : 0
  const hu = c.f.hu - wu
  const hv = c.f.hv
  const cu = wing ? wu : 0

  c.b(body, cu, 0, y + h / 2 - 0.6, hu * 2, h + 1.2, hv * 2, skin)
  c.b('#57514a', cu, 0, y + 0.35, hu * 2 + 0.34, 0.9, hv * 2 + 0.34, SURF.paving)
  if (two) {
    c.b('#4e4840', cu, 0, y + h * 0.52, hu * 2 + 0.16, 0.32, hv * 2 + 0.16, SURF.plank)
  }

  const rise = 2.2 + Math.min(hu, hv) * 0.26
  const roll = rng()
  /** where the chimney has to clear: the top of whatever roof was rolled */
  let ridgeY: number
  if (roll < 0.52) {
    c.roof(PRISM, roofC, cu, 0, y + h - 0.05, hu * 2.14, rise * 1.15, hv * 2.14,
      hv > hu)
    ridgeY = y + h + rise * 1.15
  } else if (roll < 0.78) {
    c.roof(HIP, roofC, cu, 0, y + h - 0.05, hu * 2.14, rise, hv * 2.14, hv > hu)
    ridgeY = y + h + rise
  } else if (roll < 0.92) {
    put(out.solid, CONE4, roofC, c.wx(cu, 0), y + h + rise / 2 - 0.05, c.wz(cu, 0),
      0, lot.face, 0, hu * 2.12, rise, hv * 2.12, SURF.shingle)
    ridgeY = y + h + rise
  } else {
    c.b('#4c4740', cu, 0, y + h + 0.22, hu * 2 + 0.4, 0.5, hv * 2 + 0.4, SURF.paving)
    ridgeY = y + h + 0.5
  }
  c.b('#38322b', cu, 0, y + h - 0.04, hu * 2.14, 0.34, hv * 2.14, SURF.plank)

  if (wing) {
    const wh = Math.min(h - 0.6, two ? 8.8 : h)
    const wv = hv * 0.66
    const wRise = 1.9 + wu * 0.3
    c.b(body, -hu, hv * 0.34, y + wh / 2 - 0.6, wu * 2, wh + 1.2, wv * 2 + hv * 0.68, skin)
    c.b('#57514a', -hu, hv * 0.34, y + 0.35,
      wu * 2 + 0.3, 0.9, wv * 2 + hv * 0.68 + 0.3, SURF.paving)
    c.roof(PRISM, roofC, -hu, hv * 0.34, y + wh - 0.05,
      wu * 2.16, wRise, (wv * 2 + hv * 0.68) * 1.08, true)
    c.b('#38322b', -hu, hv * 0.34, y + wh - 0.04,
      wu * 2.16, 0.34, (wv * 2 + hv * 0.68) * 1.06, SURF.plank)
    c.solid(-hu, hv * 0.34, wu * 2, wv * 2 + hv * 0.68, y - 2, y + wh, false, 0.2)
  }

  const doorU = cu + (rng() - 0.5) * hu * 0.5
  if (out.detailed) {
    frontDoor(c, doorU, hv, y)
    const rows = two ? [3.3, h * 0.52 + 2.7] : [3.3]
    for (const [ri, wy] of rows.map((v, i) => [i, v] as const)) {
      for (const s of [-1, 1]) {
        const u = doorU + s * hu * 0.62
        if (Math.abs(u - cu) > hu - 1.4) continue
        if (ri === 0 || rng() < 0.85) {
          window_(c, u, hv, y + wy, 1.7, 1.5, 0, 1, litRate)
        }
      }
      // and one on each flank, so the house is not a facade with three blanks
      window_(c, cu + hu, 0, y + wy, 1.5, 1.4, 1, 0, litRate)
      window_(c, cu - hu, 0, y + wy, 1.5, 1.4, -1, 0, litRate)
      window_(c, cu, -hv, y + wy, 1.6, 1.4, 0, -1, litRate * 0.6)
    }
    if (wing) window_(c, -hu, hv * 1.02, y + 3.3, 1.6, 1.5, 0, 1, litRate)

    // a porch over the door, on posts. The canopy clears the door, and
    // therefore anyone walking under it: the first cut hung it at 3.35,
    // squarely at forehead height
    if (rng() < 0.42) {
      c.b('#5a5148', doorU, hv + 1.1, y + 0.22, 4.0, 0.44, 2.2, SURF.plank)
      c.b(roofC, doorU, hv + 1.1, y + 5.85, 4.5, 0.24, 2.6, SURF.plank)
      for (const s of [-1, 1]) {
        c.b(TRIM, doorU + s * 1.8, hv + 1.9, y + 3.1, 0.2, 5.3, 0.2)
      }
      c.solid(doorU, hv + 1.1, 4.0, 2.2, y - 1, y + 0.44, true)
    }
    frontage(c, hu, hv, y)
    gardenShed(c, hu, hv, y)
  }

  if (rng() < 0.4 && c.f.hu > 4.8) garage(c, hu, hv, y, doorU > cu ? -1 : 1)
  if (rng() < 0.5) chimney(c, cu + hu * 0.5, -hv * 0.4, y + h, ridgeY + 1.4)

  c.solid(cu, 0, hu * 2, hv * 2, y - 2, y + h, false, 0.3)
}

/**
 * Small, steep and old: a stone base course, a roof pitched near forty-five
 * degrees with two dormers punched through the front slope, an external
 * chimney climbing one flank, and shutters on everything. It is the plan that
 * makes a street have a *before* on it.
 */
const cottage = (c: Ctx) => {
  const { lot, rng, out } = c
  const y = lot.baseY
  const hu = c.f.hu * 0.86
  const hv = c.f.hv * 0.86
  const h = 6.2
  const body = pick(LIME, rng())
  const roofC = pick(ROOFS, rng())
  const litRate = 0.4 + rng() * 0.4
  const rise = Math.min(hu, hv) * 1.02 + 1.4
  const cross = hv > hu

  // a stone base course: the wall the damp got into, rendered over above it
  c.b('#6d675c', 0, 0, y + 0.9, hu * 2 + 0.28, 2.4, hv * 2 + 0.28, SURF.brick)
  c.b(body, 0, 0, y + h / 2 + 0.6, hu * 2, h, hv * 2, SURF.plaster)
  c.roof(PRISM, roofC, 0, 0, y + h - 0.05, hu * 2.2, rise, hv * 2.2, cross)
  c.b('#38322b', 0, 0, y + h - 0.06, hu * 2.2, 0.3, hv * 2.2, SURF.plank)

  const stack = (hu + 0.5) * (rng() < 0.5 ? 1 : -1)
  c.b('#6d675c', stack, -hv * 0.2, y + (h + rise + 2.4) / 2,
    1.5, h + rise + 2.4, 1.7, SURF.brick)
  c.b('#4c4740', stack, -hv * 0.2, y + h + rise + 2.6, 1.8, 0.3, 2.0, SURF.paving)

  if (out.detailed) {
    frontDoor(c, 0, hv, y, '#3d5342', 4.9)
    for (const s of [-1, 1]) {
      window_(c, s * hu * 0.62, hv, y + 3.1, 1.4, 1.4, 0, 1, litRate, true)
    }
    window_(c, hu, hv * 0.3, y + 3.1, 1.3, 1.3, 1, 0, litRate)
    window_(c, -hu, hv * 0.3, y + 3.1, 1.3, 1.3, -1, 0, litRate)
    window_(c, 0, -hv, y + 3.1, 1.4, 1.3, 0, -1, litRate * 0.5)

    // dormers: a little box pushed out of the front slope, gabled, with a
    // pane in it. Seated a third of the way up the pitch so the cheeks meet
    // roof rather than air
    if (!cross) {
      for (const s of [-1, 1]) {
        const du = s * hu * 0.5
        const dv = hv * 0.34
        const dy = y + h + rise * 0.3
        c.b(body, du, dv, dy + 0.9, 2.0, 1.8, 2.2, SURF.plaster)
        c.roof(PRISM, roofC, du, dv, dy + 1.8, 2.3, 1.0, 2.5, true)
        window_(c, du, dv + 1.05, dy + 0.95, 1.1, 1.0, 0, 1, litRate)
      }
    }
    frontage(c, hu, hv, y)
    gardenShed(c, hu, hv, y)
  }

  c.solid(0, 0, hu * 2 + 0.3, hv * 2 + 0.3, y - 2, y + h + 0.6, false, 0.25)
}

/**
 * Wide, low and mostly porch. One storey under a shallow hip with a deep
 * overhang, a veranda running the whole frontage on posts, and a carport at
 * one end instead of a garage. Its eave line sits at about four units, which
 * is a hand's width over the player's eye, so walking along one of these
 * actually feels like walking past a house rather than under a wall.
 */
const ranch = (c: Ctx) => {
  const { lot, rng, out } = c
  const y = lot.baseY
  const hu = c.f.hu
  const hv = c.f.hv * 0.78
  const h = 5.6
  const body = pick(BODY, rng())
  const roofC = pick(ROOFS, rng())
  const skin = skinOf(rng())
  const litRate = 0.3 + rng() * 0.45

  c.b(body, 0, -hv * 0.1, y + h / 2 - 0.5, hu * 2, h + 1, hv * 2, skin)
  c.b('#57514a', 0, -hv * 0.1, y + 0.3, hu * 2 + 0.3, 0.8, hv * 2 + 0.3, SURF.paving)
  const rise = 1.5 + Math.min(hu, hv) * 0.2
  c.roof(HIP, roofC, 0, -hv * 0.1, y + h - 0.05, hu * 2.3, rise, hv * 2.5)
  c.b('#38322b', 0, -hv * 0.1, y + h - 0.06, hu * 2.3, 0.36, hv * 2.5, SURF.plank)

  // the veranda: a slab you can step onto, posts, and its own low canopy
  const pv = hv * 0.9 + 1.5
  c.b('#8b867c', 0, pv, y + 0.18, hu * 1.9, 0.36, 3.0, SURF.paving)
  c.solid(0, pv, hu * 1.9, 3.0, y - 1, y + 0.36, true)
  if (out.detailed) {
    c.b(roofC, 0, pv, y + 5.9, hu * 2.0, 0.26, 3.4, SURF.plank)
    const posts = Math.max(2, Math.round(hu / 2.6))
    for (let i = 0; i <= posts; i++) {
      const u = (i / posts - 0.5) * hu * 1.86
      c.b(TRIM, u, pv + 1.3, y + 3.1, 0.22, 5.5, 0.22)
    }
    frontDoor(c, hu * 0.2, hv * 0.9, y + 0.36)
    // a picture window: the one wide pane a house like this always has
    window_(c, -hu * 0.42, hv * 0.9, y + 3.3, 3.4, 1.9, 0, 1, litRate)
    window_(c, hu * 0.68, hv * 0.9, y + 3.3, 1.4, 1.4, 0, 1, litRate)
    window_(c, hu, -hv * 0.2, y + 3.3, 1.6, 1.4, 1, 0, litRate)
    window_(c, -hu, -hv * 0.2, y + 3.3, 1.6, 1.4, -1, 0, litRate)
    window_(c, 0, -hv * 1.1, y + 3.3, 2.0, 1.4, 0, -1, litRate * 0.6)

    // the carport: two posts and a flat deck, open on three sides
    if (rng() < 0.55) {
      const s = rng() < 0.5 ? 1 : -1
      const cu = s * (hu + 2.6)
      c.b('#83807a', cu, hv * 0.2, y + 0.05, 5.0, 0.1, hv * 2.2, SURF.paving)
      c.b(roofC, cu, hv * 0.2, y + 5.2, 5.4, 0.3, hv * 2.3, SURF.plank)
      for (const q of [-1, 1]) {
        c.b(TRIM, cu + s * 2.2, hv * 0.2 + q * hv, y + 2.6, 0.24, 5.2, 0.24)
      }
      c.solid(cu, hv * 0.2, 5.4, hv * 2.3, y + 5.2, y + 5.5)
    }
    frontage(c, hu, hv, y)
    gardenShed(c, hu, hv, y)
  }
  if (rng() < 0.45) chimney(c, hu * 0.55, -hv * 0.5, y + h, y + h + rise + 1.2)

  c.solid(0, -hv * 0.1, hu * 2, hv * 2, y - 2, y + h, false, 0.3)
}

/**
 * Narrow frontage, three storeys, flat roof behind a cornice, and a raised
 * stoop with cheek walls out to the pavement. Built in brick, always, and
 * deliberately sized so that three of them landing along one block edge read
 * as a terrace rather than as three detached houses that happen to be thin.
 */
const townhouse = (c: Ctx) => {
  const { lot, rng, out } = c
  const y = lot.baseY
  const hu = c.f.hu * 0.62
  const hv = c.f.hv
  const storeys = rng() < 0.4 ? 2 : 3
  const h = 1.4 + storeys * 4.4
  const body = pick(BODY, rng())
  const litRate = 0.35 + rng() * 0.45
  const floorY = y + 1.4

  c.b(body, 0, 0, y + h / 2 - 0.6, hu * 2, h + 1.2, hv * 2, SURF.brick)
  // a stone base up to the first floor, the way a walk-up always has
  c.b('#585349', 0, 0, y + 0.8, hu * 2 + 0.3, 1.8, hv * 2 + 0.3, SURF.paving)
  // cornice and parapet: the roofline needs an edge or the box has no top
  c.b('#4c4740', 0, 0, y + h + 0.1, hu * 2 + 0.7, 0.5, hv * 2 + 0.7, SURF.paving)
  c.b(body, 0, 0, y + h + 0.85, hu * 2 + 0.2, 1.0, hv * 2 + 0.2, SURF.brick)
  if (rng() < 0.6) {
    c.b('#41372f', hu * 0.5, -hv * 0.4, y + h + 1.9, 0.8, 2.6, 0.8, SURF.brick)
  }

  if (out.detailed) {
    // the stoop: treads up to a door standing above the pavement, with cheeks
    const treads = 4
    for (let i = 1; i <= treads; i++) {
      const top = y + (i * 1.4) / treads
      c.b('#8b867c', 0, hv + (treads - i + 0.5) * 0.5, (y - 0.4 + top) / 2,
        2.8, top - y + 0.4, 0.5, SURF.paving)
      c.solid(0, hv + (treads - i + 0.5) * 0.5, 2.8, 0.5, y - 1, top, true)
    }
    for (const s of [-1, 1]) {
      c.b('#6f695f', s * 1.6, hv + 1.1, y + 0.9, 0.36, 1.8, 2.6, SURF.paving)
    }
    frontDoor(c, 0, hv, floorY, '#2f3a44', 4.7)
    for (let s = 0; s < storeys; s++) {
      const wy = floorY + 2.5 + s * 4.4
      for (const u of [-hu * 0.5, hu * 0.5]) {
        if (s === 0 && Math.abs(u) < 1.6) continue
        window_(c, u, hv, wy, 1.3, 2.4, 0, 1, litRate)
        // a stone lintel over each opening, which is the one detail that
        // separates a brick terrace from a brick box with holes in it
        c.b('#6f695f', u, hv + 0.04, wy + 1.55, 1.9, 0.26, 0.26, SURF.paving)
      }
      window_(c, 0, -hv, wy, 1.4, 2.2, 0, -1, litRate * 0.5)
    }
  }

  c.solid(0, 0, hu * 2, hv * 2, y - 2, y + h + 1.4, false, 0.25)
}

/**
 * The expensive one: two rendered storeys, a shallow hip with a wide
 * overhang, a first-floor balcony over the entrance on columns, and a
 * pergola off one flank. Pale, so it stands out of a street of renders and
 * bricks the way the real thing does.
 */
const villa = (c: Ctx) => {
  const { lot, rng, out } = c
  const y = lot.baseY
  const hu = c.f.hu
  const hv = c.f.hv * 0.9
  const h = 9.8
  const body = pick(LIME, rng())
  const roofC = pick(ROOFS, rng())
  const litRate = 0.3 + rng() * 0.4

  c.b(body, 0, 0, y + h / 2 - 0.5, hu * 2, h + 1, hv * 2, SURF.plaster)
  c.b('#8d8578', 0, 0, y + 0.3, hu * 2 + 0.36, 0.8, hv * 2 + 0.36, SURF.paving)
  c.b('#b7ae9c', 0, 0, y + h * 0.5, hu * 2 + 0.14, 0.26, hv * 2 + 0.14, SURF.paving)
  const flat = rng() < 0.35
  if (flat) {
    c.b('#b7ae9c', 0, 0, y + h + 0.35, hu * 2 + 0.5, 0.7, hv * 2 + 0.5, SURF.paving)
  } else {
    const rise = 1.4 + Math.min(hu, hv) * 0.16
    c.roof(HIP, roofC, 0, 0, y + h - 0.05, hu * 2.26, rise, hv * 2.26)
    c.b('#8f877a', 0, 0, y + h - 0.06, hu * 2.26, 0.3, hv * 2.26, SURF.plank)
  }

  if (out.detailed) {
    frontDoor(c, 0, hv, y, '#3a3129', 5.0)
    // the balcony: a slab on two columns, with a run of balusters on it
    c.b('#c6bda9', 0, hv + 1.0, y + 5.6, 5.4, 0.34, 2.4, SURF.paving)
    for (const s of [-1, 1]) {
      c.b('#cfc7b4', s * 2.4, hv + 1.6, y + 2.8, 0.34, 5.6, 0.34, SURF.plaster)
    }
    for (let u = -2.5; u <= 2.5; u += 0.42) {
      c.b('#d6cfbd', u, hv + 2.06, y + 6.3, 0.14, 1.1, 0.14)
    }
    c.b('#d6cfbd', 0, hv + 2.06, y + 6.92, 5.3, 0.16, 0.3, SURF.paving)
    c.solid(0, hv + 1.0, 5.4, 2.4, y - 1, y + 5.94)

    for (const s of [-1, 1]) {
      window_(c, s * hu * 0.6, hv, y + 3.2, 1.5, 2.6, 0, 1, litRate)
      window_(c, s * hu * 0.6, hv, y + 7.6, 1.5, 1.7, 0, 1, litRate)
      window_(c, s * hu, hv * 0.3, y + 3.2, 1.5, 2.4, s, 0, litRate)
      window_(c, s * hu, -hv * 0.4, y + 7.6, 1.4, 1.6, s, 0, litRate)
    }
    window_(c, 0, -hv, y + 3.2, 2.2, 2.2, 0, -1, litRate * 0.6)

    // a pergola off one flank: four posts and a run of cross beams, which
    // reads as a terrace for the price of nine boxes
    if (rng() < 0.5) {
      const s = rng() < 0.5 ? 1 : -1
      const pu = s * (hu + 2.4)
      c.b('#a49a86', pu, 0, y + 0.06, 4.4, 0.12, hv * 1.6, SURF.paving)
      for (const a of [-1, 1])
        for (const b2 of [-1, 1]) {
          c.b('#cfc7b4', pu + a * 1.9, b2 * hv * 0.7, y + 2.5, 0.24, 5.0, 0.24)
        }
      for (let v = -hv * 0.72; v <= hv * 0.72; v += 0.62) {
        c.b('#cfc7b4', pu, v, y + 5.1, 4.6, 0.14, 0.14, SURF.plank)
      }
    }
    frontage(c, hu, hv, y)
  }
  if (rng() < 0.4 && c.f.hu > 5) garage(c, hu, hv, y, rng() < 0.5 ? 1 : -1)

  c.solid(0, 0, hu * 2, hv * 2, y - 2, y + h, false, 0.3)
}

/* ------------------------------------------------------------ the front -- */

/**
 * A house on a lot. The plan is rolled first and everything else follows from
 * it: a narrow lot leans townhouse, a wide one leans ranch, and the odd
 * cottage or villa lands anywhere. Beyond the roll it is the plan's own
 * business, which is the whole reason they are written out separately.
 */
export const suburbHouse = (out: BuildOut, lot: Lot) => {
  const c = context(out, lot)
  const r = lot.rng()
  // the lot's own proportions get a vote, so a wide corner plot is not handed
  // a three-storey terrace and a slim infill is not handed a ranch
  const wide = c.f.hu > c.f.hv * 1.12
  const plan: HousePlan =
    r < 0.4 ? 'gabled'
      : r < 0.58 ? 'cottage'
        : r < 0.76 ? (wide ? 'ranch' : 'townhouse')
          : r < 0.9 ? (wide ? 'townhouse' : 'ranch')
            : 'villa'
  switch (plan) {
    case 'cottage': cottage(c); break
    case 'ranch': ranch(c); break
    case 'townhouse': townhouse(c); break
    case 'villa': villa(c); break
    default: gabled(c)
  }
}
