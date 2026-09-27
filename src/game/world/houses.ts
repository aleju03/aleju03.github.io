import * as THREE from 'three'
import { noStand } from '../physics/collision'
import { SURF, type SurfaceId } from './surface'
import {
  CONE4, CYL8, CYL12, GLASS_DARK, GLASS_LIT, HIP, PRISM, SHED, TUBE12,
  aabb, box, fork, frameOf, nudge, panel, pick, put, strut, type BuildOut, type Lot,
} from './kitbash'

/*
  What stands on a suburban lot.

  One entry point, `suburbHouse`, and eight plans behind it, because what
  breaks a street up is *plan*, not dressing: a cottage is small and steep and
  sits low, a ranch is wide and flat and mostly porch (or an L round a garage
  wing), a cape is a storey and a half with dormers in a steep side gable, a
  colonial is two symmetrical storeys with shutters and a portico (the owner's
  own house is one), a split-level is two halves half a storey apart with the
  garage under the high one, a townhouse is narrow and tall on a stoop, and a
  villa is pale and expensive. The rolls inside a plan only decide its
  dressing.

  Around the house is the lot, and the lot is most of what makes a street
  look lived in: `yard()` gives every plan the same second pass, a garage
  (attached, detached down a side drive, or none), a drive with sometimes a
  car on it, bins, a hoop, a fence or a hedge or nothing along the front, a
  mailbox, and behind the house a shed, a swing set, a trampoline or a patio.

  Paint comes in *schemes*, not independent picks: a body, a trim, a roof, a
  door and shutters that belong together (a white colonial with black
  shutters and a red door, sage siding with cream trim, red brick with navy),
  each nudged a few percent per house so no two on a street are the same
  swatch. Independent picks were how a street got a lilac house with an
  oxblood door under a green roof.

  Everything is written in the lot's own frame (kitbash.ts's `frameOf`): `u`
  runs along the frontage, `v` out toward the street, and the four cardinal
  facings fall out of two sign flips. `mir` flips `u` for half of them, which
  moves the garage, the chimney, the door offset and the wing all to the
  other end at once. The lot is the house's footprint: every plan builds to
  the frontage and depth it is handed (capped, so a very large lot gets a big
  house centred on it rather than a warehouse), picks itself by what fits,
  and lets its extras reach at most `room` past each flank, a few units past
  the front for the path, the fence and the mailbox, and one yard's depth
  behind. That contract is what lets the street layout hand this any size of
  lot at any of the four facings.

  Two measurements everything here is tuned against. The eye is at 3.84
  units (about 1.55 m, so a unit is about 0.4 m: a car is nine long, a door
  a little over five tall), so a door under about 4.7 reads as a dollhouse
  and a canopy under 5.5 is something the player walks into. And a solid
  registers one collision box per mass, `noStand` wherever the roof is above
  the box top, because otherwise the eave line is a ledge you can stand on
  and the roof is a wall you cannot. Anything low and flat (a drive, a path,
  a porch deck, a patio) also reports a footprint the grass keeps out of
  (world/interiors.ts), or blades half a metre tall grow straight up
  through it.
*/

/** the plans, in the order they are rolled */
export type HousePlan =
  | 'gabled' | 'cottage' | 'ranch' | 'townhouse' | 'villa' | 'colonial' | 'cape' | 'split'

/** a house's paint: body, trim, roof, door, shutters, and what the body is */
interface Scheme {
  body: string
  trim: string
  roof: string
  door: string
  shutter: string
  skin: SurfaceId
}

const S = (
  body: string, trim: string, roof: string, door: string, shutter: string,
  skin: SurfaceId = SURF.plank,
): Scheme => ({ body, trim, roof, door, shutter, skin })

/** the schemes a suburb is painted from: siding in most of them (the owner's
    own house is tan siding under a brown roof), brick in a few, render in
    the rest, and every one a set that belongs together */
const SCHEMES: Scheme[] = [
  S('#dcd8cc', '#f0ece2', '#3a3d40', '#7a2f28', '#2b2e30'),
  S('#8e9a7e', '#e8e2d0', '#4a3c33', '#3f3a34', '#4e5a45'),
  S('#d6c07e', '#f0ece2', '#4a4038', '#2f4a3a', '#3f5a48'),
  S('#7d8fa0', '#eeeae0', '#393b3e', '#8a3a30', '#2f3b4a'),
  S('#b8a47a', '#ece6d6', '#5a3a2e', '#4a3322', '#5a4636'),
  S('#8a4a3a', '#e6dcc4', '#3a3530', '#2f3b55', '#2b2e30', SURF.brick),
  S('#a8906c', '#e8e2d0', '#4a3c33', '#5a2e2a', '#4a3c33', SURF.brick),
  S('#9a9a94', '#f0ece2', '#343638', '#b8342a', '#3a3d40'),
  S('#d4cdbd', '#f4f0e6', '#6a3a2e', '#3a3129', '#4d5c52', SURF.plaster),
  S('#b08a80', '#ece6d6', '#3f3a34', '#2f3b4a', '#5a4a44'),
  S('#4f5f74', '#eeeae0', '#3a3d40', '#c9a24a', '#eeeae0'),
  S('#7a6a50', '#d8cfb8', '#3a3530', '#3a2c1e', '#4a3c2e'),
  S('#c9b9a0', '#f0ece2', '#4e3a30', '#2f3b55', '#6a4a3a', SURF.plaster),
  S('#9aa894', '#f4f0e6', '#3a3d40', '#6b2f2a', '#3a4a3a', SURF.brick),
]

/** what a window box is planted with */
const BLOOMS = ['#b8474a', '#d88a3a', '#c9a2c8', '#e0d060', '#d8d8d0']
/** what is parked in a drive */
const CAR_PAINT = ['#8a2a24', '#2f4a6a', '#c8c4b8', '#3a3d40', '#6a7a4a', '#b8a060', '#5a5f66']


/**
 * Everything a plan needs to stamp itself: the lot's frame with `mir` already
 * folded in, the scheme it drew, the room its extras may use, and local-space
 * verbs for a box, a collision box, a wall quad, a roof and a grass keep-out.
 * Written once here because eight plans otherwise write the same frame maths
 * and some of them get it wrong.
 */
const context = (out: BuildOut, lot: Lot) => {
  const { rng } = lot
  const f = frameOf(lot)
  const mir = rng() < 0.5 ? 1 : -1
  const base = pick(SCHEMES, rng())
  const k = 0.93 + rng() * 0.14
  const scheme: Scheme = { ...base, body: nudge(base.body, k), roof: nudge(base.roof, 0.95 + rng() * 0.1) }
  /** the eave board: in the trim colour on most houses, dark on the rest */
  const fascia = rng() < 0.7 ? scheme.trim : '#38322b'
  /** how far anything may reach past either flank of the footprint */
  const room = Math.min(7, Math.max(2.5, f.hu * 0.75))
  /** the rolls only a detailed build makes (window lights, fences, clutter),
      off their own stream so the outer ring and the near one agree about
      everything that shows as a shape (kitbash.ts's `fork`) */
  const dr = fork(rng)
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

  /** a footprint the grass and the scatter keep out of */
  const keep = (u: number, v: number, lu: number, lv: number) => {
    const x = wx(u, v)
    const z = wz(u, v)
    const hx = f.ex(lu, lv) / 2
    const hz = f.ez(lu, lv) / 2
    out.interiors.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz })
  }

  /** the yaw of a wall whose outward local normal is (du, dv) */
  const yawOf = (du: number, dv: number) =>
    dv > 0 ? lot.face
      : dv < 0 ? lot.face + Math.PI
        : lot.face + (du * mir > 0 ? Math.PI / 2 : -Math.PI / 2)

  /** a roof shape seated with its eaves at `eaveY`. `cross` turns the ridge
      ninety degrees, so a gable end faces the street instead of a long slope */
  const roof = (
    geo: THREE.BufferGeometry, hex: string,
    u: number, v: number, eaveY: number,
    lu: number, rise: number, lv: number, cross = false,
  ) => put(out.solid, geo, hex, wx(u, v), eaveY, wz(u, v),
    0, lot.face + (cross ? Math.PI / 2 : 0), 0,
    cross ? lv : lu, rise, cross ? lu : lv, SURF.shingle)

  /** a primitive in lot-local space with a local yaw on top of the lot's */
  const place = (
    geo: THREE.BufferGeometry, hex: string, u: number, cy: number, v: number,
    rx: number, ry: number, rz: number, sx: number, sy: number, sz: number,
    surf: SurfaceId = SURF.none,
  ) => put(out.solid, geo, hex, wx(u, v), cy, wz(u, v), rx, lot.face + ry * mir, rz,
    sx, sy, sz, surf)

  return {
    out, lot, rng, dr, f, mir, scheme, fascia, room,
    wx, wz, b, solid, keep, yawOf, roof, place,
  }
}

type Ctx = ReturnType<typeof context>

/**
 * What a plan tells the yard about the house it built: its footprint, where
 * the front door is, which flank is free for a drive, and whether it already
 * has a garage (and where that garage's door is) or wants the yard to roll one.
 */
interface Home {
  y: number
  /** half-width and half-depth of everything the plan put down */
  hu: number
  hv: number
  doorU: number
  /** the flank a drive and garage go on, +1 or -1 in local u */
  side: number
  /** a garage door the plan built itself, local u and the v of its face */
  garage?: { u: number; v: number; w: number }
  /** no drive, no garage: a townhouse meets the pavement on its stoop */
  bare?: boolean
}

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
  c.b(c.scheme.trim, u, v, cy, flank ? 0.16 : w + 0.4, h + 0.4, flank ? w + 0.4 : 0.16,
    SURF.plaster)
  const yaw = c.yawOf(du, dv)
  panel(c.out.solid, GLASS_DARK,
    c.wx(u + du * 0.1, v + dv * 0.1), cy, c.wz(u + du * 0.1, v + dv * 0.1),
    w, h, yaw)
  // a muntin down the middle, because a single dark pane reads as a hole
  c.b(c.scheme.trim, u + du * 0.1, v + dv * 0.1, cy, flank ? 0.04 : 0.1, h, flank ? 0.1 : 0.04)
  if (c.dr() < litRate) {
    panel(c.out.glass, GLASS_LIT,
      c.wx(u + du * 0.14, v + dv * 0.14), cy, c.wz(u + du * 0.14, v + dv * 0.14),
      w, h, yaw)
  }
  if (!shutters) return
  // louvred boards either side, standing a little proud of the frame, in the
  // scheme's shutter colour
  for (const s of [-1, 1]) {
    const o = (w / 2 + 0.3) * s
    c.b(c.scheme.shutter, u + (flank ? 0 : o), v + (flank ? o : 0), cy,
      flank ? 0.1 : 0.5, h + 0.3, flank ? 0.5 : 0.1, SURF.plank)
  }
}

/** the front door: a surround, a leaf, a knob, and the path out to the kerb
    edge of the front yard */
const frontDoor = (c: Ctx, u: number, hv: number, y: number, h = 5.2, pathTo = hv + 5) => {
  c.b(c.scheme.trim, u, hv + 0.06, y + h / 2, 2.3, h + 0.2, 0.18, SURF.plaster)
  panel(c.out.solid, c.scheme.door, c.wx(u, hv + 0.18), y + h / 2 - 0.12, c.wz(u, hv + 0.18),
    1.9, h - 0.3, c.yawOf(0, 1), SURF.plank)
  c.b('#c8ac63', u + 0.68, hv + 0.24, y + 2.3, 0.14, 0.14, 0.1)
  const len = pathTo - hv
  if (len > 0.4) {
    c.b('#8b867c', u, hv + len / 2 + 0.2, c.lot.baseY + 0.05, 1.5, 0.1, len, SURF.paving)
    c.keep(u, hv + len / 2 + 0.2, 1.7, len)
  }
}

/** a chimney stack, rising from `fromY` to clear of the ridge */
const chimney = (c: Ctx, u: number, v: number, fromY: number, topY: number, w = 0.9) => {
  c.b('#41372f', u, v, (fromY + topY) / 2, w, topY - fromY, w, SURF.brick)
  c.b('#4c4740', u, v, topY + 0.14, w + 0.2, 0.28, w + 0.2, SURF.paving)
}

/** a kerbside mailbox on a post, flag up or down: the smallest thing on a
    street and the one that says *someone gets letters here* */
const mailbox = (c: Ctx, u: number, v: number, y: number) => {
  const paint = pick(['#3a3a3a', '#2f3b55', '#6b2f2a', '#d8d2c4', '#3f5242'], c.dr())
  c.b('#4a3d30', u, v, y + 1.2, 0.26, 2.4, 0.26, SURF.plank)
  c.b(paint, u, v, y + 2.65, 0.8, 0.8, 1.5)
  c.b('#b8342a', u + 0.44, v + 0.3, y + (c.dr() < 0.5 ? 3.1 : 2.7), 0.06, 0.6, 0.2)
  c.solid(u, v, 0.8, 1.5, y - 1, y + 3.05, false, 0.05)
}

/**
 * Along the front of the lot: a hedge, a picket fence, a low garden wall, a
 * split-rail fence, or nothing (an open lawn is as American a front as any).
 * All under 1.2 tall and thin, so the hop arc clears them with time to spare.
 * `gap` keeps the path and the drive open.
 */
const frontage = (c: Ctx, hu: number, hv: number, y: number, gaps: Array<[number, number]>) => {
  const r = c.dr()
  const v = hv + 3.2
  const span = hu * 2 + 1.0
  const open = (u: number) => gaps.some(([a, b]) => u > a - 0.2 && u < b + 0.2)
  /** the runs of the line between the gaps, each built by `run` */
  const runs = (step: number, run: (u0: number, u1: number) => void) => {
    let start: number | null = null
    for (let u = -span / 2; u <= span / 2 + 1e-6; u += step) {
      if (open(u)) {
        if (start !== null && u - step - start > 0.4) run(start, u - step)
        start = null
      } else if (start === null) start = u
    }
    if (start !== null && span / 2 - start > 0.4) run(start, span / 2)
  }
  if (r < 0.2) {
    runs(0.5, (a, b) => {
      c.b('#3d5230', (a + b) / 2, v, y + 0.55, b - a, 1.1, 0.9)
      c.solid((a + b) / 2, v, b - a, 0.9, y - 1, y + 1.1, false, 0.05)
    })
  } else if (r < 0.4) {
    runs(0.44, (a, b) => {
      const m = (a + b) / 2
      c.b('#e4dccb', m, v, y + 0.42, b - a, 0.09, 0.1, SURF.plank)
      c.b('#e4dccb', m, v, y + 0.94, b - a, 0.09, 0.1, SURF.plank)
      for (let u = a; u <= b + 1e-6; u += 0.44) {
        c.b('#ece6d6', u, v, y + 0.62, 0.16, 1.24, 0.14, SURF.plank)
      }
      c.solid(m, v, b - a, 0.34, y - 1, y + 1.1, false, 0.05)
    })
  } else if (r < 0.52) {
    runs(0.5, (a, b) => {
      const m = (a + b) / 2
      c.b('#8d8578', m, v, y + 0.5, b - a, 1.0, 0.44, SURF.brick)
      c.b('#a09789', m, v, y + 1.06, b - a + 0.1, 0.12, 0.58, SURF.paving)
      c.solid(m, v, b - a, 0.58, y - 1, y + 1.12, false, 0.05)
    })
  } else if (r < 0.64) {
    runs(0.5, (a, b) => {
      const m = (a + b) / 2
      for (const hy of [0.5, 1.0]) c.b('#7a6450', m, v, y + hy, b - a, 0.14, 0.14, SURF.plank)
      for (let u = a; u <= b + 1e-6; u += 3.0) c.b('#6a5645', u, v, y + 0.6, 0.24, 1.2, 0.24, SURF.bark)
      c.solid(m, v, b - a, 0.3, y - 1, y + 1.1, false, 0.05)
    })
  }
}

/** a bay pushed out of the ground floor under its own little hip, glazed on
    its three faces: one mass and one roof, and the single change that most
    breaks the flat front of a workhorse house */
const bayWindow = (c: Ctx, u: number, hv: number, y: number, litRate: number) => {
  const bw = 3.4
  const bd = 1.15
  const v = hv + bd / 2
  c.b('#57514a', u, v, y + 0.4, bw + 0.2, 0.8, bd + 0.1, SURF.paving)
  c.b(c.scheme.body, u, v, y + 2.4, bw, 3.9, bd, c.scheme.skin)
  c.roof(HIP, c.scheme.roof, u, v, y + 4.3, bw + 0.4, 0.95, bd + 0.5)
  c.b(c.fascia, u, v, y + 4.32, bw + 0.4, 0.2, bd + 0.5, SURF.plank)
  c.solid(u, v, bw, bd, y - 1, y + 4.4, false, 0.1)
  if (!c.out.detailed) return
  window_(c, u, hv + bd, y + 2.8, 2.2, 1.9, 0, 1, litRate)
  for (const s of [-1, 1]) window_(c, u + s * (bw / 2), v, y + 2.8, 0.6, 1.9, s, 0, litRate)
}

/** a planter under a front window, and what is growing in it */
const windowBox = (c: Ctx, u: number, v: number, sillY: number, w: number) => {
  c.b('#5a4636', u, v + 0.22, sillY - 0.2, w + 0.2, 0.36, 0.42, SURF.plank)
  c.b(pick(BLOOMS, c.dr()), u, v + 0.24, sillY + 0.04, w, 0.2, 0.34)
}

/**
 * A dormer in a roof's front slope, seated so its face stands just proud of
 * the slope and its back is buried in it. `slopeAt(v)` is the roof's height
 * over the eave at depth `v`, which is what lets one routine seat a dormer in
 * any pitch rather than in the one pitch it was tuned against.
 */
const dormer = (
  c: Ctx, u: number, dv: number, eaveY: number, slopeAt: (v: number) => number,
  litRate: number, w = 2.0,
) => {
  const dd = 2.2
  const dy = eaveY + slopeAt(dv + dd / 2) - 0.5
  c.b(c.scheme.body, u, dv, dy + 0.9, w, 1.8, dd, c.scheme.skin)
  c.roof(PRISM, c.scheme.roof, u, dv, dy + 1.8, w + 0.4, 1.0, dd + 0.3, true)
  if (c.out.detailed) window_(c, u, dv + dd / 2 + 0.02, dy + 0.95, w * 0.55, 1.0, 0, 1, litRate)
}

type PorchKind = 'none' | 'hood' | 'stoop' | 'portico' | 'veranda' | 'wrap'

/**
 * The front porch, in the five kinds a street has: a gabled hood on brackets
 * over a stoop, a bare stoop, a portico (a pediment on columns, the
 * colonial's), a veranda the width of the front on posts under a shed roof,
 * and a wraparound that turns the corner down one flank. Everything clears
 * the door, and therefore anyone under it: canopies start at 5.6.
 */
const porch = (
  c: Ctx, kind: PorchKind, u: number, hv: number, y: number, hu: number, side: number,
) => {
  if (kind === 'none' || !c.out.detailed) return
  const { trim, roof } = c.scheme
  if (kind === 'hood' || kind === 'stoop') {
    c.b('#8b867c', u, hv + 0.9, y + 0.25, 3.2, 0.5, 1.8, SURF.paving)
    c.solid(u, hv + 0.9, 3.2, 1.8, y - 1, y + 0.5, true)
    c.keep(u, hv + 0.9, 3.4, 2.0)
    if (kind === 'stoop') return
    c.roof(PRISM, roof, u, hv + 0.8, y + 5.8, 3.2, 1.2, 1.9, true)
    c.b(c.fascia, u, hv + 0.8, y + 5.72, 3.2, 0.16, 1.9, SURF.plank)
    for (const s of [-1, 1]) {
      strut(c.out.solid, trim, c.wx(u + s * 1.35, hv + 0.1), y + 4.9, c.wz(u + s * 1.35, hv + 0.1),
        c.wx(u + s * 1.35, hv + 1.2), y + 5.75, c.wz(u + s * 1.35, hv + 1.2), 0.16)
    }
    return
  }
  if (kind === 'portico') {
    c.b('#9a948a', u, hv + 1.4, y + 0.3, 5.0, 0.6, 2.8, SURF.paving)
    c.solid(u, hv + 1.4, 5.0, 2.8, y - 1, y + 0.6, true)
    c.keep(u, hv + 1.4, 5.2, 3.0)
    for (const s of [-1, 1]) {
      c.place(CYL12, trim, u + s * 1.9, y + 0.6 + 2.6, hv + 2.4, 0, 0, 0, 0.5, 5.2, 0.5)
    }
    c.b(trim, u, hv + 1.4, y + 6.0, 4.8, 0.6, 2.8, SURF.plaster)
    c.roof(PRISM, roof, u, hv + 1.4, y + 6.28, 5.2, 1.5, 3.2, true)
    return
  }
  // a veranda, and on a wraparound, the same again down one flank
  const pw = hu * 2 - 0.4
  const deck = (du: number, dv: number, lu: number, lv: number) => {
    c.b('#6f5a45', du, dv, y + 0.3, lu, 0.6, lv, SURF.plank)
    c.solid(du, dv, lu, lv, y - 1, y + 0.6, true)
    c.keep(du, dv, lu + 0.2, lv + 0.2)
  }
  const posts = (u0: number, v0: number, u1: number, v1: number, n: number) => {
    for (let i = 0; i <= n; i++) {
      const t = i / n
      c.b(trim, u0 + (u1 - u0) * t, v0 + (v1 - v0) * t, y + 3.3, 0.3, 5.4, 0.3)
    }
  }
  deck(0, hv + 1.6, pw, 3.2)
  posts(-pw / 2 + 0.2, hv + 3.0, pw / 2 - 0.2, hv + 3.0, Math.max(2, Math.round(pw / 3.2)))
  c.place(SHED, roof, 0, y + 5.9, hv + 1.7, 0, Math.PI, 0, pw + 0.4, 0.8, 3.6, SURF.shingle)
  c.b(c.fascia, 0, hv + 3.45, y + 5.95, pw + 0.4, 0.22, 0.12, SURF.plank)
  // a rail between the posts, open at the steps
  for (const s of [-1, 1]) {
    const a = s > 0 ? u + 1.4 : -pw / 2 + 0.2
    const b = s > 0 ? pw / 2 - 0.2 : u - 1.4
    if (b - a < 0.6) continue
    c.b(trim, (a + b) / 2, hv + 3.0, y + 1.7, b - a, 0.12, 0.12, SURF.plank)
    c.b(trim, (a + b) / 2, hv + 3.0, y + 1.0, b - a, 0.08, 0.08, SURF.plank)
  }
  if (kind === 'wrap') {
    // the flank run starts at the front deck's outer edge and runs back
    // most of the way down the side
    const fu = side * (hu + 1.6)
    const fl = hv * 1.6 + 3.2
    const fv = hv + 3.2 - fl / 2
    deck(fu, fv, 3.2, fl)
    posts(fu + side * 1.4, hv + 3.0, fu + side * 1.4, hv + 3.4 - fl, Math.max(1, Math.round(fl / 3.2)))
    c.place(SHED, roof, fu, y + 5.9, fv, 0, -side * Math.PI / 2, 0, fl + 0.2, 0.8, 3.6, SURF.shingle)
  }
}

/* ---------------------------------------------------------------- yard -- */

/** a garage with its door to the street and a gable over it: attached to a
    flank, or standing on its own at the end of a side drive */
const garageBox = (c: Ctx, u: number, v: number, y: number, gw: number, gd: number) => {
  const gh = 5.9
  const { body, skin, roof, trim } = c.scheme
  c.b(body, u, v, y + gh / 2 - 0.5, gw, gh + 1, gd, skin)
  c.b('#57514a', u, v, y + 0.3, gw + 0.3, 0.8, gd + 0.3, SURF.paving)
  c.roof(PRISM, roof, u, v, y + gh - 0.05, gw + 0.6, Math.min(3.2, gw * 0.42), gd + 0.5, true)
  c.b(c.fascia, u, v, y + gh - 0.04, gw + 0.6, 0.3, gd + 0.5, SURF.plank)
  c.solid(u, v, gw, gd, y - 2, y + gh, false, 0.2)
  if (!c.out.detailed) return
  const dw = Math.min(gw - 1.2, 6.2)
  c.b(trim, u, v + gd / 2 + 0.05, y + 2.45, dw + 0.5, 5.0, 0.12, SURF.plaster)
  panel(c.out.solid, pick(['#e8e4da', '#cfc8b8', '#8a8478'], c.dr()),
    c.wx(u, v + gd / 2 + 0.14), y + 2.3, c.wz(u, v + gd / 2 + 0.14), dw, 4.6, c.yawOf(0, 1),
    SURF.plank)
}

/** a parked car, nine units long and four wide like the one in the fleet,
    nose to the street; a body, a glasshouse, a roof and four wheels */
const car = (c: Ctx, u: number, v: number, y: number) => {
  const paint = pick(CAR_PAINT, c.dr())
  c.b(paint, u, v, y + 1.35, 4.2, 1.6, 9.0, SURF.panel)
  c.b('#2a3036', u, v - 0.6, y + 2.75, 3.7, 1.3, 4.6)
  c.b(paint, u, v - 0.6, y + 3.45, 3.8, 0.16, 4.3, SURF.panel)
  for (const a of [-1, 1])
    for (const bq of [-1, 1]) {
      c.place(CYL8, '#1e1f21', u + a * 2.0, y + 0.8, v + bq * 2.9, 0, 0, Math.PI / 2,
        1.6, 0.6, 1.6)
    }
  c.b('#e8e0c0', u - 1.4, v + 4.52, y + 1.6, 0.7, 0.35, 0.06)
  c.b('#e8e0c0', u + 1.4, v + 4.52, y + 1.6, 0.7, 0.35, 0.06)
  c.solid(u, v, 4.2, 9.0, y - 1, y + 3.5, false, 0.05)
}

/** two wheelie bins by the drive */
const bins = (c: Ctx, u: number, v: number, y: number) => {
  const cols = ['#3a5a3a', '#2f3b55', '#4a4a4a', '#6a5a2a']
  for (const s of [-1, 1]) {
    const col = pick(cols, c.dr())
    c.b(col, u + s * 0.9, v, y + 1.3, 1.5, 2.6, 1.5, SURF.panel)
    c.b(col, u + s * 0.9, v + 0.1, y + 2.7, 1.6, 0.2, 1.7, SURF.panel)
  }
  c.solid(u, v, 3.4, 1.7, y - 1, y + 2.8, false, 0.05)
}

/** a swing set: two A-frames, a top bar, and two seats on their chains */
const swingSet = (c: Ctx, u: number, v: number, y: number) => {
  const frame = pick(['#6a8a9a', '#a8483a', '#4a6a4a', '#8a7a5a'], c.dr())
  const top = y + 5.4
  for (const s of [-1, 1]) {
    for (const q of [-1, 1]) {
      strut(c.out.solid, frame, c.wx(u + s * 2.6, v + q * 1.6), y, c.wz(u + s * 2.6, v + q * 1.6),
        c.wx(u + s * 2.6, v), top, c.wz(u + s * 2.6, v), 0.22)
    }
    c.solid(u + s * 2.6, v, 0.4, 3.4, y - 1, top, false)
  }
  c.b(frame, u, v, top, 5.6, 0.24, 0.24)
  for (const s of [-1, 1]) {
    const su = u + s * 1.2
    for (const e of [-1, 1]) c.b('#9a9a94', su + e * 0.45, v, y + 3.35, 0.05, 4.0, 0.05)
    c.b('#3a3a3a', su, v, y + 1.3, 1.1, 0.12, 0.5)
  }
}

/** a round trampoline: a padded rim on short legs and the dark mat in it.
    Its top is a real surface: you can stand on it, you just cannot bounce */
const trampoline = (c: Ctx, u: number, v: number, y: number) => {
  const r = 2.6
  const rim = pick(['#2f5a8a', '#3a7a4a', '#8a3a3a'], c.dr())
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4
    c.b('#8a8e90', u + Math.cos(a) * r * 0.85, v + Math.sin(a) * r * 0.85, y + 0.8,
      0.16, 1.6, 0.16)
  }
  c.place(TUBE12, rim, u, y + 1.62, v, 0, 0, 0, r * 2, 0.3, r * 2)
  c.place(CYL12, '#1e1f21', u, y + 1.55, v, 0, 0, 0, r * 1.9, 0.06, r * 1.9)
  c.solid(u, v, r * 1.6, r * 1.6, y - 1, y + 1.7, true)
}

/** a basketball hoop on a post at the head of the drive */
const hoop = (c: Ctx, u: number, v: number, y: number) => {
  c.place(CYL8, '#3a3d40', u, y + 4.2, v, 0, 0, 0, 0.3, 8.4, 0.3)
  c.b('#e8e4da', u, v - 0.6, y + 8.2, 2.8, 1.8, 0.12)
  c.b('#c85a2a', u, v - 1.2, y + 7.6, 0.9, 0.06, 0.9)
  c.solid(u, v, 0.4, 0.4, y - 1, y + 8.4, false, 0.1)
}

/** a back-garden shed, which is most of what makes a rear elevation read as
    lived in rather than as the blank side of a box */
const gardenShed = (c: Ctx, u: number, v: number, y: number) => {
  c.b('#6b5a44', u, v, y + 1.7, 3.4, 3.4, 2.8, SURF.plank)
  c.roof(PRISM, '#3d3a33', u, v, y + 3.4, 3.8, 1.3, 3.2)
  panel(c.out.solid, '#4a3d30', c.wx(u, v + 1.42), y + 1.5, c.wz(u, v + 1.42),
    1.3, 2.8, c.yawOf(0, 1), SURF.plank)
  c.solid(u, v, 3.4, 2.8, y - 1, y + 3.4, false, 0.1)
}

/**
 * The second pass every plan gets: the garage (the plan's own, or rolled
 * here as attached, detached at the end of a side drive, or none), the drive
 * with sometimes a car, bins and a hoop on it, the front path's fence line
 * and mailbox, and the back garden. Garages are silhouette and roll from the
 * lot's stream; everything else is dressing and rolls from the fork.
 */
const yard = (c: Ctx, h: Home) => {
  const { rng, dr, out } = c
  const { y, hu, hv, side } = h
  const front = hv + 5
  let driveU: number | null = null
  let driveFrom = 0
  if (h.garage) {
    driveU = h.garage.u
    driveFrom = h.garage.v
  } else if (!h.bare) {
    const r = rng()
    if (r < 0.4 && c.room >= 3.2) {
      const gw = Math.min(6.8, Math.max(5.0, c.room * 1.6))
      const gd = Math.min(hv * 1.7, 10)
      const gu = side * (hu + gw / 2 - 0.05)
      garageBox(c, gu, hv - gd / 2 - 0.8, y, gw, gd)
      driveU = gu
      driveFrom = hv - 0.8
    } else if (r < 0.62 && c.room >= 3.6) {
      // detached, at the back, down a drive along the flank
      const gw = 6.4
      const gd = 7.0
      const gu = side * (hu + 2.9)
      const gv = -(hv + gd / 2 + 1.2)
      garageBox(c, gu, gv, y, gw, gd)
      driveU = gu
      driveFrom = gv + gd / 2
    } else if (r < 0.8) {
      // no garage, a drive to park on beside the house
      driveU = side * (hu + 2.9)
      driveFrom = -hv * 0.4
    }
  }

  const gaps: Array<[number, number]> = [[h.doorU - 1.0, h.doorU + 1.0]]
  if (driveU !== null) {
    const dw = 5.4
    const len = front - driveFrom
    if (out.detailed) {
      c.b('#83807a', driveU, driveFrom + len / 2, y + 0.04, dw, 0.09, len, SURF.paving)
    }
    c.keep(driveU, driveFrom + len / 2, dw + 0.4, len)
    gaps.push([driveU - dw / 2, driveU + dw / 2])
    if (out.detailed) {
      // a car on it, if there is a car's length of drive inside the lot's
      // own front line: the pavement starts not far past it
      const lo = driveFrom + 4.8
      const hi = hv - 2.2
      if (hi >= lo && dr() < 0.55) car(c, driveU, lo + dr() * (hi - lo), y)
      if (dr() < 0.6) bins(c, driveU + side * (dw / 2 + 1.9), hv + 1.6, y)
      if (h.garage === undefined && driveFrom > 0 && dr() < 0.2) {
        hoop(c, driveU + side * (dw / 2 + 0.4), driveFrom + 0.6, y)
      }
    }
  }
  if (!out.detailed) return

  frontage(c, hu, hv, y, gaps)
  if (dr() < 0.7) mailbox(c, driveU !== null ? driveU - side * 3.6 : h.doorU - 2.6, front - 1.0, y)

  // the back garden: at most two things, one each side of the middle
  const back = -(hv + 4.2)
  const slots = [-1, 1].map((s) => s * Math.max(2.8, hu * 0.55))
  const things: Array<(u: number) => void> = []
  if (dr() < 0.4) things.push((u) => gardenShed(c, u, back + 0.6, y))
  if (dr() < 0.3) things.push((u) => swingSet(c, u, back - 0.6, y))
  if (dr() < 0.22) things.push((u) => trampoline(c, u, back - 0.8, y))
  if (dr() < 0.3) {
    things.push((u) => {
      c.b('#9a948a', u, -hv - 2.0, y + 0.06, 5.0, 0.12, 3.6, SURF.paving)
      c.keep(u, -hv - 2.0, 5.2, 3.8)
    })
  }
  // a detached garage owns the back of its own side, so only the far side
  // is left for the garden
  const detached = !h.garage && driveU !== null && driveFrom < -hv
  if (detached) {
    if (things.length) things[0](-side * Math.abs(slots[0]))
  } else {
    for (let i = 0; i < Math.min(2, things.length); i++) things[i](slots[i])
  }
}

/* ---------------------------------------------------------------- plans -- */

/** the house's own half-extents on this lot: its frontage and depth, capped
    so a very big lot gets a big house centred on it rather than a warehouse */
const dims = (c: Ctx, kHu = 1, kHv = 1, maxHu = 11, maxHv = 9) => ({
  hu: Math.min(c.f.hu * kHu, maxHu),
  hv: Math.min(c.f.hv * kHv, maxHv),
})

/**
 * The workhorse: siding, brick or render under a gable or a hip, one or two
 * storeys, and about a third of the time a cross wing projecting toward the
 * street with its own gable end, which makes it an L. It rolls its pitch, a
 * bay window beside the door, dormers in a single storey's front slope and a
 * porch of any kind.
 */
const gabled = (c: Ctx): Home => {
  const { lot, rng, dr, out, scheme } = c
  const y = lot.baseY
  const two = rng() < 0.38
  const h = two
    ? Math.max(9.6, Math.min(lot.height * 1.35, 10.8))
    : Math.max(6.2, Math.min(lot.height, 7.4))
  const litRate = 0.35 + dr() * 0.5
  const { hu: HU, hv } = dims(c)
  const wing = rng() < 0.36 && HU > 5.4
  const wu = wing ? HU * 0.42 : 0
  const hu = HU - wu
  const cu = wing ? wu : 0
  const { body, skin, roof: roofC } = scheme

  c.b(body, cu, 0, y + h / 2 - 0.6, hu * 2, h + 1.2, hv * 2, skin)
  c.b('#57514a', cu, 0, y + 0.35, hu * 2 + 0.34, 0.9, hv * 2 + 0.34, SURF.paving)
  if (two) c.b(c.fascia, cu, 0, y + h * 0.52, hu * 2 + 0.16, 0.32, hv * 2 + 0.16, SURF.plank)

  const rise = (2.2 + Math.min(hu, hv) * 0.26) * (0.8 + rng() * 0.55)
  const roll = rng()
  const cross = hv > hu
  let ridgeY: number
  if (roll < 0.55) {
    c.roof(PRISM, roofC, cu, 0, y + h - 0.05, hu * 2.14, rise * 1.15, hv * 2.14, cross)
    ridgeY = y + h + rise * 1.15
  } else if (roll < 0.85) {
    c.roof(HIP, roofC, cu, 0, y + h - 0.05, hu * 2.14, rise, hv * 2.14, cross)
    ridgeY = y + h + rise
  } else {
    put(out.solid, CONE4, roofC, c.wx(cu, 0), y + h + rise / 2 - 0.05, c.wz(cu, 0),
      0, lot.face, 0, hu * 2.12, rise, hv * 2.12, SURF.shingle)
    ridgeY = y + h + rise
  }
  c.b(c.fascia, cu, 0, y + h - 0.04, hu * 2.14, 0.34, hv * 2.14, SURF.plank)

  if (wing) {
    const wh = Math.min(h - 0.6, two ? 8.8 : h)
    const wl = hv * 1.32
    c.b(body, -hu, hv * 0.34, y + wh / 2 - 0.6, wu * 2, wh + 1.2, wl, skin)
    c.b('#57514a', -hu, hv * 0.34, y + 0.35, wu * 2 + 0.3, 0.9, wl + 0.3, SURF.paving)
    c.roof(PRISM, roofC, -hu, hv * 0.34, y + wh - 0.05, wu * 2.16, 1.9 + wu * 0.3, wl * 1.08, true)
    c.b(c.fascia, -hu, hv * 0.34, y + wh - 0.04, wu * 2.16, 0.34, wl * 1.06, SURF.plank)
    c.solid(-hu, hv * 0.34, wu * 2, wl, y - 2, y + wh, false, 0.2)
  }

  const doorU = cu + (rng() - 0.5) * hu * 0.5
  const bayS = doorU > cu ? -1 : 1
  const bayU = doorU + bayS * hu * 0.62
  const bay = rng() < 0.45 && hu > 3.8 && Math.abs(bayU - cu) < hu - 2.0
  if (bay) bayWindow(c, bayU, hv, y, litRate)
  const dormers = !two && roll < 0.55 && !cross && hu > 4 ? (rng() < 0.5 ? 1 : 2) : 0
  if (dormers) {
    const R = rise * 1.15
    const run = hv * 1.07
    const us = dormers === 1 ? [cu] : [cu - hu * 0.45, cu + hu * 0.45]
    for (const u of us) dormer(c, u, hv * 0.3, y + h - 0.05, (v) => R * (1 - v / run), litRate)
  }
  const porchR = rng()
  const kind: PorchKind = bay && Math.abs(bayU - doorU) < 4.5
    ? (porchR < 0.5 ? 'hood' : 'stoop')
    : porchR < 0.25 ? 'hood' : porchR < 0.45 ? 'veranda' : porchR < 0.55 && !wing ? 'wrap'
      : porchR < 0.75 ? 'stoop' : 'none'
  if (rng() < 0.5) chimney(c, cu + hu * 0.5, -hv * 0.4, y + h, ridgeY + 1.4)

  if (out.detailed) {
    const lift = kind === 'veranda' || kind === 'wrap' ? 0.6 : kind === 'none' ? 0 : 0.5
    frontDoor(c, doorU, hv, y + lift)
    const boxes = dr() < 0.4
    const rows = two ? [3.3, h * 0.52 + 2.7] : [3.3]
    for (const [ri, wy] of rows.map((v, i) => [i, v] as const)) {
      for (const s of [-1, 1]) {
        const u = doorU + s * hu * 0.62
        if (Math.abs(u - cu) > hu - 1.4) continue
        if (ri === 0 && bay && s === bayS) continue
        if (ri === 0 || dr() < 0.85) {
          window_(c, u, hv, y + wy, 1.7, 1.5, 0, 1, litRate, skin !== SURF.brick && dr() < 0.4)
          if (boxes && ri === 0) windowBox(c, u, hv, y + wy - 0.95, 1.7)
        }
      }
      window_(c, cu + hu, 0, y + wy, 1.5, 1.4, 1, 0, litRate)
      window_(c, cu - hu, 0, y + wy, 1.5, 1.4, -1, 0, litRate)
      window_(c, cu, -hv, y + wy, 1.6, 1.4, 0, -1, litRate * 0.6)
    }
    if (wing) window_(c, -hu, hv * 1.0, y + 3.3, 1.6, 1.5, 0, 1, litRate)
  }
  porch(c, kind, doorU, hv, y, hu, doorU > cu ? 1 : -1)

  c.solid(cu, 0, hu * 2, hv * 2, y - 2, y + h, false, 0.3)
  return { y, hu: HU, hv, doorU, side: wing ? 1 : (doorU > cu ? -1 : 1) }
}

/**
 * The owner's own house, near enough: two full storeys, symmetrical, a side
 * gable, a centre door under a portico or a porch, windows in bays of three
 * or five with shutters on every one, and a chimney on a gable end. Half the
 * time a one-storey wing on one flank (a sunroom or the garage) stops it
 * reading as a box with a lid.
 */
const colonial = (c: Ctx): Home => {
  const { lot, rng, dr, out, scheme } = c
  const y = lot.baseY
  const { hu, hv } = dims(c, 0.92, 0.86)
  const h = 10.2
  const { body, skin, roof: roofC } = scheme
  const litRate = 0.3 + dr() * 0.5

  c.b(body, 0, 0, y + h / 2 - 0.6, hu * 2, h + 1.2, hv * 2, skin)
  c.b('#57514a', 0, 0, y + 0.35, hu * 2 + 0.34, 0.9, hv * 2 + 0.34, SURF.paving)
  c.b(c.scheme.trim, 0, 0, y + h * 0.5, hu * 2 + 0.16, 0.3, hv * 2 + 0.16, SURF.plank)
  const rise = hv * (0.62 + rng() * 0.2)
  c.roof(PRISM, roofC, 0, 0, y + h - 0.05, hu * 2 + 0.8, rise, hv * 2.16)
  c.b(c.fascia, 0, 0, y + h - 0.04, hu * 2 + 0.8, 0.34, hv * 2.16, SURF.plank)
  // corner boards, the white stripes that frame a sided house
  if (skin === SURF.plank) {
    for (const a of [-1, 1])
      for (const q of [-1, 1]) c.b(c.scheme.trim, a * hu, q * hv, y + h / 2, 0.34, h, 0.34)
  }
  const chimS = rng() < 0.5 ? 1 : -1
  if (rng() < 0.75) {
    c.b('#6e4a3a', chimS * (hu + 0.45), -hv * 0.1, y + (h + rise + 1.4) / 2, 1.2, h + rise + 1.4,
      1.8, SURF.brick)
  }
  const wingR = rng()
  const wingS = -chimS
  let garage: Home['garage']
  if (wingR < 0.5 && c.room >= 3) {
    const ww = Math.min(6.4, c.room * 1.6)
    const wd = hv * 1.5
    const wu = wingS * (hu + ww / 2 - 0.05)
    const isGarage = wingR < 0.3
    c.b(body, wu, -hv * 0.2, y + 2.7, ww, 6.4, wd, skin)
    c.roof(PRISM, roofC, wu, -hv * 0.2, y + 5.85, ww + 0.5, 2.2, wd + 0.5, true)
    c.b(c.fascia, wu, -hv * 0.2, y + 5.87, ww + 0.5, 0.3, wd + 0.5, SURF.plank)
    c.solid(wu, -hv * 0.2, ww, wd, y - 2, y + 5.9, false, 0.2)
    if (isGarage) {
      if (out.detailed) {
        panel(out.solid, '#e8e4da', c.wx(wu, -hv * 0.2 + wd / 2 + 0.08), y + 2.3,
          c.wz(wu, -hv * 0.2 + wd / 2 + 0.08), ww - 1.4, 4.6, c.yawOf(0, 1), SURF.plank)
      }
      garage = { u: wu, v: -hv * 0.2 + wd / 2, w: ww }
    } else if (out.detailed) {
      for (const s of [-1, 1]) {
        window_(c, wu + s * ww * 0.22, -hv * 0.2 + wd / 2, y + 3.0, ww * 0.34, 2.8, 0, 1, litRate)
      }
    }
  }
  const kind: PorchKind = rng() < 0.55 ? 'portico' : rng() < 0.6 ? 'veranda' : 'hood'

  if (out.detailed) {
    frontDoor(c, 0, hv, y + 0.5, 5.4)
    // a fanlight over the door
    panel(out.glass, GLASS_LIT, c.wx(0, hv + 0.2), y + 6.35, c.wz(0, hv + 0.2), 1.9, 0.5, c.yawOf(0, 1))
    const bays = hu > 6 ? 5 : 3
    const xs = Array.from({ length: bays }, (_, i) => (i / (bays - 1) - 0.5) * hu * 1.5)
    for (const u of xs) {
      if (Math.abs(u) > 0.5) window_(c, u, hv, y + 3.4, 1.5, 2.2, 0, 1, litRate, true)
      window_(c, u, hv, y + h * 0.5 + 2.6, 1.5, 2.0, 0, 1, litRate, true)
    }
    for (const s of [-1, 1]) {
      window_(c, s * hu, hv * 0.35, y + 3.4, 1.4, 2.0, s, 0, litRate)
      window_(c, s * hu, -hv * 0.35, y + h * 0.5 + 2.6, 1.4, 1.8, s, 0, litRate)
      window_(c, s * hu * 0.45, -hv, y + 3.4, 1.4, 2.0, 0, -1, litRate * 0.6)
    }
    // a lunette in the gable end
    for (const s of [-1, 1]) {
      window_(c, s * hu, 0, y + h + rise * 0.35, 0.9, 0.9, s, 0, litRate * 0.3)
    }
  }
  porch(c, kind, 0, hv, y, hu, chimS)

  c.solid(0, 0, hu * 2, hv * 2, y - 2, y + h, false, 0.3)
  return { y, hu, hv, doorU: 0, side: wingS, garage }
}

/**
 * A cape: a storey and a half, the steepest side gable on the street with
 * two or three dormers in its front slope, a centre door under a little
 * gabled hood, shutters, and a low eave you could almost touch. Small,
 * which is the point: it is the house a street of two-storeys needs between
 * them. Sometimes a breezeway runs from one flank to a garage.
 */
const cape = (c: Ctx): Home => {
  const { lot, rng, dr, out, scheme } = c
  const y = lot.baseY
  const { hu, hv } = dims(c, 0.9, 0.84)
  const h = 5.8
  const { body, skin, roof: roofC } = scheme
  const litRate = 0.35 + dr() * 0.45
  const rise = hv * 1.05 + 1.2

  c.b(body, 0, 0, y + h / 2 - 0.6, hu * 2, h + 1.2, hv * 2, skin)
  c.b('#57514a', 0, 0, y + 0.35, hu * 2 + 0.34, 0.9, hv * 2 + 0.34, SURF.paving)
  c.roof(PRISM, roofC, 0, 0, y + h - 0.05, hu * 2 + 0.6, rise, hv * 2.2)
  c.b(c.fascia, 0, 0, y + h - 0.04, hu * 2 + 0.6, 0.3, hv * 2.2, SURF.plank)
  const n = hu > 5.2 && rng() < 0.6 ? 3 : 2
  const run = hv * 1.1
  const us = n === 2 ? [-hu * 0.45, hu * 0.45] : [-hu * 0.6, 0, hu * 0.6]
  for (const u of us) dormer(c, u, hv * 0.28, y + h - 0.05, (v) => rise * (1 - v / run), litRate, 2.2)
  const stackS = rng() < 0.5 ? 1 : -1
  chimney(c, stackS * hu * 0.55, -hv * 0.1, y + h, y + h + rise + 1.0, 1.2)

  let garage: Home['garage']
  if (rng() < 0.35 && c.room >= 4) {
    // a breezeway, and a garage at the end of it
    const bw = 3.0
    c.b(body, -stackS * (hu + bw / 2), -hv * 0.3, y + 2.4, bw, 4.8, hv * 1.0, skin)
    c.roof(SHED, roofC, -stackS * (hu + bw / 2), -hv * 0.3, y + 4.75, bw + 0.3, 0.8, hv * 1.1)
    c.solid(-stackS * (hu + bw / 2), -hv * 0.3, bw, hv, y - 2, y + 4.8, false, 0.1)
    const gw = Math.min(6.2, c.room * 1.5)
    const gu = -stackS * (hu + bw + gw / 2)
    garageBox(c, gu, -hv * 0.2, y, gw, hv * 1.5)
    garage = { u: gu, v: -hv * 0.2 + hv * 0.75, w: gw }
  }

  if (out.detailed) {
    frontDoor(c, 0, hv, y + 0.5, 5.0)
    for (const s of [-1, 1]) {
      window_(c, s * hu * 0.55, hv, y + 3.2, 1.5, 1.9, 0, 1, litRate, true)
      window_(c, s * hu, 0, y + 3.2, 1.4, 1.7, s, 0, litRate)
      window_(c, s * hu, 0, y + h + rise * 0.4, 1.0, 1.1, s, 0, litRate * 0.5)
    }
    window_(c, 0, -hv, y + 3.2, 2.2, 1.6, 0, -1, litRate * 0.6)
  }
  porch(c, dr() < 0.7 ? 'hood' : 'stoop', 0, hv, y, hu, stackS)

  c.solid(0, 0, hu * 2, hv * 2, y - 2, y + h, false, 0.3)
  return { y, hu, hv, doorU: 0, side: -stackS, garage }
}

/**
 * A split-level: two halves half a storey apart. The low half is one storey
 * under a roof running along the street, with the front door reached up a
 * couple of steps; the high half is a storey and a half taller with its
 * gable end to the street and the garage under it. It is the one plan whose
 * roofline steps, which a street of eaves at one height badly needs.
 */
const split = (c: Ctx): Home => {
  const { lot, rng, dr, out, scheme } = c
  const y = lot.baseY
  const { hu, hv } = dims(c, 1, 0.86)
  const { body, skin, roof: roofC } = scheme
  const litRate = 0.3 + dr() * 0.5
  const hs = rng() < 0.5 ? 1 : -1
  // the high half's width, and the low half's
  const hw = hu * 0.9
  const lw = hu * 2 - hw
  const hc = hs * (hu - hw / 2)
  const lc = -hs * (hu - lw / 2)
  const lowH = 6.0
  const highH = 9.4
  const lower = rng() < 0.5 ? 'brick' : 'same'
  const lowerSkin = lower === 'brick' ? SURF.brick : skin
  const lowerCol = lower === 'brick' ? '#7a4a3a' : body

  // the low half, pushed back a little
  c.b(body, lc, -hv * 0.1, y + lowH / 2 - 0.6, lw, lowH + 1.2, hv * 1.8, skin)
  c.roof(PRISM, roofC, lc, -hv * 0.1, y + lowH - 0.05, lw + 0.8, 2.2 + hv * 0.2, hv * 2.0)
  c.b(c.fascia, lc, -hv * 0.1, y + lowH - 0.04, lw + 0.8, 0.3, hv * 2.0, SURF.plank)
  c.solid(lc, -hv * 0.1, lw, hv * 1.8, y - 2, y + lowH, false, 0.2)
  // the high half, its lower storey in brick more often than not
  c.b(lowerCol, hc, 0, y + 2.0, hw, 5.2, hv * 2, lowerSkin)
  c.b(body, hc, 0, y + 4.4 + (highH - 4.4) / 2, hw, highH - 4.4 + 0.1, hv * 2, skin)
  c.b(c.fascia, hc, 0, y + 4.45, hw + 0.2, 0.26, hv * 2 + 0.2, SURF.plank)
  c.roof(PRISM, roofC, hc, 0, y + highH - 0.05, hw + 0.6, 2.4 + hw * 0.22, hv * 2.2, true)
  c.b(c.fascia, hc, 0, y + highH - 0.04, hw + 0.6, 0.3, hv * 2.2, SURF.plank)
  c.solid(hc, 0, hw, hv * 2, y - 2, y + highH, false, 0.3)
  if (rng() < 0.5) chimney(c, lc - hs * lw * 0.25, -hv * 0.5, y + lowH, y + lowH + 4.2)

  if (out.detailed) {
    // the garage door under the high half
    const gw = Math.min(hw - 1.2, 6.0)
    c.b(c.scheme.trim, hc, hv + 0.05, y + 2.45, gw + 0.5, 5.0, 0.12, SURF.plaster)
    panel(out.solid, '#e8e4da', c.wx(hc, hv + 0.14), y + 2.3, c.wz(hc, hv + 0.14), gw, 4.6,
      c.yawOf(0, 1), SURF.plank)
    window_(c, hc, hv, y + 6.9, Math.min(3.2, hw * 0.5), 1.8, 0, 1, litRate)
    // the door up two steps in the low half, and its picture window
    const du = lc + hs * lw * 0.3
    frontDoor(c, du, hv * 0.8, y + 0.8, 5.0)
    for (let i = 0; i < 2; i++) {
      c.b('#8b867c', du, hv * 0.8 + 0.5 + i * 0.6, y + 0.4 - i * 0.2, 2.6, 0.8 - i * 0.4, 0.6, SURF.paving)
    }
    c.solid(du, hv * 0.8 + 0.8, 2.6, 1.2, y - 1, y + 0.8, true)
    c.keep(du, hv * 0.8 + 0.8, 2.8, 1.4)
    window_(c, lc - hs * lw * 0.15, hv * 0.8, y + 3.3, Math.min(3.6, lw * 0.4), 2.0, 0, 1, litRate)
    window_(c, lc - hs * lw / 2, -hv * 0.1, y + 3.3, 1.5, 1.6, -hs, 0, litRate)
    window_(c, hc + hs * hw / 2, 0, y + 6.9, 1.5, 1.6, hs, 0, litRate)
    window_(c, lc, -hv, y + 3.3, 1.8, 1.6, 0, -1, litRate * 0.6)
  }
  return { y, hu, hv, doorU: lc + hs * lw * 0.3, side: hs, garage: { u: hc, v: hv, w: hw } }
}

/**
 * Small, steep and old: a stone base course, a roof pitched near forty-five
 * degrees with two dormers punched through the front slope, an external
 * chimney climbing one flank, and shutters on everything. It is the plan that
 * makes a street have a *before* on it.
 */
const cottage = (c: Ctx): Home => {
  const { lot, rng, dr, out, scheme } = c
  const y = lot.baseY
  const { hu, hv } = dims(c, 0.86, 0.86, 6.5, 6)
  const h = 6.2
  const { body, roof: roofC } = scheme
  const litRate = 0.4 + dr() * 0.4
  const rise = Math.min(hu, hv) * 1.02 + 1.4
  const cross = hv > hu

  c.b('#6d675c', 0, 0, y + 0.9, hu * 2 + 0.28, 2.4, hv * 2 + 0.28, SURF.brick)
  c.b(body, 0, 0, y + h / 2 + 0.6, hu * 2, h, hv * 2, SURF.plaster)
  c.roof(PRISM, roofC, 0, 0, y + h - 0.05, hu * 2.2, rise, hv * 2.2, cross)
  c.b(c.fascia, 0, 0, y + h - 0.06, hu * 2.2, 0.3, hv * 2.2, SURF.plank)
  const stack = (hu + 0.5) * (rng() < 0.5 ? 1 : -1)
  // the stack clears the ridge by a hand, not by a storey: the first cut ran
  // it two units past the ridge and it read as a factory chimney
  c.b('#6d675c', stack, -hv * 0.2, y + (h + rise + 1.2) / 2, 1.2, h + rise + 1.2, 1.4, SURF.brick)
  c.b('#4c4740', stack, -hv * 0.2, y + h + rise + 1.35, 1.5, 0.3, 1.7, SURF.paving)
  if (!cross) {
    const run = hv * 1.1
    for (const s of [-1, 1]) {
      dormer(c, s * hu * 0.5, hv * 0.34, y + h - 0.05, (v) => rise * (1 - v / run), litRate)
    }
  }

  if (out.detailed) {
    frontDoor(c, 0, hv, y, 4.9)
    const boxes = dr() < 0.55
    for (const s of [-1, 1]) {
      window_(c, s * hu * 0.62, hv, y + 3.1, 1.4, 1.4, 0, 1, litRate, true)
      if (boxes) windowBox(c, s * hu * 0.62, hv, y + 2.2, 1.4)
    }
    window_(c, hu, hv * 0.3, y + 3.1, 1.3, 1.3, 1, 0, litRate)
    window_(c, -hu, hv * 0.3, y + 3.1, 1.3, 1.3, -1, 0, litRate)
    window_(c, 0, -hv, y + 3.1, 1.4, 1.3, 0, -1, litRate * 0.5)
  }
  porch(c, dr() < 0.5 ? 'hood' : 'none', 0, hv, y, hu, 1)

  c.solid(0, 0, hu * 2 + 0.3, hv * 2 + 0.3, y - 2, y + h + 0.6, false, 0.25)
  return { y, hu, hv, doorU: 0, side: -Math.sign(stack) }
}

/**
 * Wide, low and mostly porch: one storey under a shallow hip with a deep
 * overhang and a veranda along the front. Half of them are an L, the garage
 * wing pushed forward at one end under its own gable end, which is the
 * shape half the ranches ever built actually have; the rest take a carport
 * or leave the garage to the yard.
 */
const ranch = (c: Ctx): Home => {
  const { lot, rng, dr, out, scheme } = c
  const y = lot.baseY
  const { hu, hv: HV } = dims(c, 1, 1, 13, 8)
  const hv = HV * 0.78
  const h = 5.6
  const { body, skin, roof: roofC } = scheme
  const litRate = 0.3 + dr() * 0.45
  const ell = rng() < 0.5 && hu > 6
  const es = rng() < 0.5 ? 1 : -1
  const ew = ell ? Math.min(7, hu * 0.7) : 0
  const mu = ell ? -es * ew / 2 : 0
  const mhu = hu - ew / 2

  c.b(body, mu, -hv * 0.1, y + h / 2 - 0.5, mhu * 2, h + 1, hv * 2, skin)
  c.b('#57514a', mu, -hv * 0.1, y + 0.3, mhu * 2 + 0.3, 0.8, hv * 2 + 0.3, SURF.paving)
  const rise = 1.5 + Math.min(mhu, hv) * 0.2
  c.roof(HIP, roofC, mu, -hv * 0.1, y + h - 0.05, mhu * 2 + 1.2, rise, hv * 2.5)
  c.b(c.fascia, mu, -hv * 0.1, y + h - 0.06, mhu * 2 + 1.2, 0.36, hv * 2.5, SURF.plank)
  c.solid(mu, -hv * 0.1, mhu * 2, hv * 2, y - 2, y + h, false, 0.3)

  let garage: Home['garage']
  if (ell) {
    // the garage wing, pushed forward, its gable end to the street
    const eu = es * (hu - ew / 2)
    const el = hv * 2.6
    const ev = -hv * 1.1 + el / 2
    c.b(body, eu, ev, y + h / 2 - 0.5, ew, h + 1, el, skin)
    c.roof(PRISM, roofC, eu, ev, y + h - 0.05, ew + 0.8, 2.4 + ew * 0.15, el + 0.6, true)
    c.b(c.fascia, eu, ev, y + h - 0.06, ew + 0.8, 0.3, el + 0.6, SURF.plank)
    c.solid(eu, ev, ew, el, y - 2, y + h, false, 0.3)
    if (out.detailed) {
      c.b(c.scheme.trim, eu, ev + el / 2 + 0.05, y + 2.45, ew - 0.9, 5.0, 0.12, SURF.plaster)
      panel(out.solid, '#e8e4da', c.wx(eu, ev + el / 2 + 0.14), y + 2.3,
        c.wz(eu, ev + el / 2 + 0.14), ew - 1.4, 4.6, c.yawOf(0, 1), SURF.plank)
    }
    garage = { u: eu, v: ev + el / 2, w: ew }
  }
  if (rng() < 0.45) chimney(c, mu + mhu * 0.5, -hv * 0.5, y + h, y + h + rise + 1.2)

  const doorU = mu + mhu * 0.2 * (ell ? es : 1)
  if (out.detailed) {
    frontDoor(c, doorU, hv * 0.9, y + 0.6)
    window_(c, mu - mhu * 0.42 * (ell ? es : 1), hv * 0.9, y + 3.3, 3.4, 1.9, 0, 1, litRate)
    if (!ell) window_(c, hu * 0.68, hv * 0.9, y + 3.3, 1.4, 1.4, 0, 1, litRate)
    window_(c, mu - (ell ? es : 1) * mhu, -hv * 0.2, y + 3.3, 1.6, 1.4, -(ell ? es : 1), 0, litRate)
    window_(c, mu, -hv * 1.1, y + 3.3, 2.0, 1.4, 0, -1, litRate * 0.6)
  }
  // the veranda along the part of the front the wing leaves
  if (out.detailed) {
    const pw = mhu * 1.9
    c.b('#8b867c', mu, hv * 0.9 + 1.5, y + 0.3, pw, 0.6, 3.0, SURF.paving)
    c.solid(mu, hv * 0.9 + 1.5, pw, 3.0, y - 1, y + 0.6, true)
    c.keep(mu, hv * 0.9 + 1.5, pw + 0.2, 3.2)
    c.b(roofC, mu, hv * 0.9 + 1.6, y + 5.9, pw + 0.2, 0.26, 3.4, SURF.plank)
    const posts = Math.max(2, Math.round(mhu / 2.6))
    for (let i = 0; i <= posts; i++) {
      const u = mu + (i / posts - 0.5) * (pw - 0.3)
      c.b(c.scheme.trim, u, hv * 0.9 + 2.8, y + 3.2, 0.26, 5.4, 0.26)
    }
    if (!ell && dr() < 0.5) {
      // a carport at the free end: posts and a flat deck
      const s = -Math.sign(doorU || 1)
      const cu = s * (hu + 2.6)
      c.b(roofC, cu, hv * 0.2, y + 5.6, 5.4, 0.3, hv * 2.3, SURF.plank)
      for (const q of [-1, 1]) c.b(c.scheme.trim, cu + s * 2.2, hv * 0.2 + q * hv, y + 2.8, 0.26, 5.6, 0.26)
      c.solid(cu, hv * 0.2, 5.4, hv * 2.3, y + 5.6, y + 5.9)
      garage = { u: cu, v: hv * 0.2 + hv, w: 5 }
    }
  }
  return { y, hu, hv: HV, doorU, side: ell ? es : 1, garage }
}

/**
 * Narrow frontage, three storeys, flat roof behind a cornice, and a raised
 * stoop with cheek walls out to the pavement. Built in brick, always, and
 * sized so that three of them along one block edge read as a terrace.
 */
const townhouse = (c: Ctx): Home => {
  const { lot, rng, dr, out, scheme } = c
  const y = lot.baseY
  const hu = Math.min(c.f.hu * 0.62, 5)
  const hv = Math.min(c.f.hv, 9)
  const storeys = rng() < 0.4 ? 2 : 3
  const h = 1.4 + storeys * 4.4
  const body = scheme.skin === SURF.brick ? scheme.body : nudge('#7a4a3a', 0.9 + rng() * 0.25)
  const litRate = 0.35 + dr() * 0.45
  const floorY = y + 1.4

  c.b(body, 0, 0, y + h / 2 - 0.6, hu * 2, h + 1.2, hv * 2, SURF.brick)
  c.b('#585349', 0, 0, y + 0.8, hu * 2 + 0.3, 1.8, hv * 2 + 0.3, SURF.paving)
  c.b('#4c4740', 0, 0, y + h + 0.1, hu * 2 + 0.7, 0.5, hv * 2 + 0.7, SURF.paving)
  c.b(body, 0, 0, y + h + 0.85, hu * 2 + 0.2, 1.0, hv * 2 + 0.2, SURF.brick)
  if (rng() < 0.6) c.b('#41372f', hu * 0.5, -hv * 0.4, y + h + 1.9, 0.8, 2.6, 0.8, SURF.brick)

  if (out.detailed) {
    const treads = 4
    for (let i = 1; i <= treads; i++) {
      const top = y + (i * 1.4) / treads
      c.b('#8b867c', 0, hv + (treads - i + 0.5) * 0.5, (y - 0.4 + top) / 2,
        2.8, top - y + 0.4, 0.5, SURF.paving)
      c.solid(0, hv + (treads - i + 0.5) * 0.5, 2.8, 0.5, y - 1, top, true)
    }
    c.keep(0, hv + 1.1, 3.6, 2.4)
    for (const s of [-1, 1]) c.b('#6f695f', s * 1.6, hv + 1.1, y + 0.9, 0.36, 1.8, 2.6, SURF.paving)
    frontDoor(c, 0, hv, floorY, 4.7, hv + 2.2)
    for (let s = 0; s < storeys; s++) {
      const wy = floorY + 2.5 + s * 4.4
      for (const u of [-hu * 0.5, hu * 0.5]) {
        if (s === 0 && Math.abs(u) < 1.6) continue
        window_(c, u, hv, wy, 1.3, 2.4, 0, 1, litRate)
        c.b('#6f695f', u, hv + 0.04, wy + 1.55, 1.9, 0.26, 0.26, SURF.paving)
      }
      window_(c, 0, -hv, wy, 1.4, 2.2, 0, -1, litRate * 0.5)
    }
  }

  c.solid(0, 0, hu * 2, hv * 2, y - 2, y + h + 1.4, false, 0.25)
  return { y, hu, hv, doorU: 0, side: 1, bare: true }
}

/**
 * The expensive one: two rendered storeys, a shallow hip with a wide
 * overhang, a first-floor balcony over the entrance on columns, and a
 * pergola off one flank. Pale, so it stands out of a street of sidings and
 * bricks the way the real thing does.
 */
const villa = (c: Ctx): Home => {
  const { lot, rng, dr, out, scheme } = c
  const y = lot.baseY
  const { hu, hv: HV } = dims(c)
  const hv = HV * 0.9
  const h = 9.8
  const body = scheme.skin === SURF.plaster ? scheme.body : nudge('#d4cdbd', 0.95 + rng() * 0.08)
  const roofC = scheme.skin === SURF.plaster ? scheme.roof : '#6a3a2e'
  const litRate = 0.3 + dr() * 0.4

  c.b(body, 0, 0, y + h / 2 - 0.5, hu * 2, h + 1, hv * 2, SURF.plaster)
  c.b('#8d8578', 0, 0, y + 0.3, hu * 2 + 0.36, 0.8, hv * 2 + 0.36, SURF.paving)
  c.b('#b7ae9c', 0, 0, y + h * 0.5, hu * 2 + 0.14, 0.26, hv * 2 + 0.14, SURF.paving)
  const flat = rng() < 0.3
  if (flat) {
    c.b('#b7ae9c', 0, 0, y + h + 0.35, hu * 2 + 0.5, 0.7, hv * 2 + 0.5, SURF.paving)
  } else {
    const rise = 1.4 + Math.min(hu, hv) * 0.16
    c.roof(HIP, roofC, 0, 0, y + h - 0.05, hu * 2.26, rise, hv * 2.26)
    c.b('#8f877a', 0, 0, y + h - 0.06, hu * 2.26, 0.3, hv * 2.26, SURF.plank)
  }

  if (out.detailed) {
    frontDoor(c, 0, hv, y, 5.0)
    c.b('#c6bda9', 0, hv + 1.0, y + 5.6, 5.4, 0.34, 2.4, SURF.paving)
    for (const s of [-1, 1]) c.b('#cfc7b4', s * 2.4, hv + 1.6, y + 2.8, 0.34, 5.6, 0.34, SURF.plaster)
    for (let u = -2.5; u <= 2.5; u += 0.42) c.b('#d6cfbd', u, hv + 2.06, y + 6.3, 0.14, 1.1, 0.14)
    c.b('#d6cfbd', 0, hv + 2.06, y + 6.92, 5.3, 0.16, 0.3, SURF.paving)
    c.solid(0, hv + 1.0, 5.4, 2.4, y - 1, y + 5.94)
    for (const s of [-1, 1]) {
      window_(c, s * hu * 0.6, hv, y + 3.2, 1.5, 2.6, 0, 1, litRate)
      window_(c, s * hu * 0.6, hv, y + 7.6, 1.5, 1.7, 0, 1, litRate)
      window_(c, s * hu, hv * 0.3, y + 3.2, 1.5, 2.4, s, 0, litRate)
      window_(c, s * hu, -hv * 0.4, y + 7.6, 1.4, 1.6, s, 0, litRate)
    }
    window_(c, 0, -hv, y + 3.2, 2.2, 2.2, 0, -1, litRate * 0.6)
    if (dr() < 0.5) {
      const s = dr() < 0.5 ? 1 : -1
      const pu = s * (hu + 2.4)
      c.b('#a49a86', pu, 0, y + 0.06, 4.4, 0.12, hv * 1.6, SURF.paving)
      c.keep(pu, 0, 4.6, hv * 1.6 + 0.2)
      for (const a of [-1, 1])
        for (const b2 of [-1, 1]) c.b('#cfc7b4', pu + a * 1.9, b2 * hv * 0.7, y + 2.8, 0.24, 5.6, 0.24)
      for (let v = -hv * 0.72; v <= hv * 0.72; v += 0.62) {
        c.b('#cfc7b4', pu, v, y + 5.7, 4.6, 0.14, 0.14, SURF.plank)
      }
    }
  }

  c.solid(0, 0, hu * 2, hv * 2, y - 2, y + h, false, 0.3)
  return { y, hu, hv: HV, doorU: 0, side: rng() < 0.5 ? 1 : -1 }
}

/* ------------------------------------------------------------ the front -- */

/** which plans fit a footprint this many units across (half-frontage `hu`)
    and deep (`hv`), each with its weight in the roll */
const fits = (hu: number, hv: number): Array<[HousePlan, number]> => {
  if (hu < 3.4) return [['townhouse', 1]]
  const wide = hu > hv * 1.12
  const list: Array<[HousePlan, number]> = [
    ['gabled', 3], ['cottage', hu < 6.5 ? 1.4 : 0.4],
  ]
  if (hu >= 4.2) list.push(['cape', 1.6], ['colonial', hv >= 3.6 ? 2 : 0.5])
  if (hu >= 4.8) list.push(['split', 1.2], ['villa', 0.7])
  if (hu >= 4.4) list.push(['ranch', wide ? 2.2 : 0.8])
  if (!wide && hu < 5.2) list.push(['townhouse', 0.9])
  return list
}

/**
 * A house on a lot. The plan is rolled from those that fit the lot's own
 * frontage and depth, then the plan builds itself to that footprint and the
 * yard dresses what is round it.
 */
export const suburbHouse = (out: BuildOut, lot: Lot) => {
  const c = context(out, lot)
  const list = fits(c.f.hu, c.f.hv)
  const total = list.reduce((a, [, w]) => a + w, 0)
  let r = lot.rng() * total
  let plan: HousePlan = list[0][0]
  for (const [p, w] of list) {
    if ((r -= w) <= 0) { plan = p; break }
  }
  const home = (() => {
    switch (plan) {
      case 'cottage': return cottage(c)
      case 'ranch': return ranch(c)
      case 'townhouse': return townhouse(c)
      case 'villa': return villa(c)
      case 'colonial': return colonial(c)
      case 'cape': return cape(c)
      case 'split': return split(c)
      default: return gabled(c)
    }
  })()
  yard(c, home)
}
