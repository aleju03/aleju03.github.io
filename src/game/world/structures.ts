import { noStand } from '../physics/collision'
import { seeded } from '../core/rand'
import { SURF, type SurfaceId } from './surface'
import {
  BALL, BOX, CONE12, CYL12, DOME, GAMBREL, PRISM, SHED, TUBE12,
  aabb, box, panel, pick, put, shaft, strut, type BuildOut,
} from './kitbash'
import type { Landmark } from './landmarks'

/*
  The things landmarks.ts decided were there, actually built.

  Nine kits, one per LandmarkKind, all stamped into the same merged chunk soup
  the trees and the town go into, so a lighthouse costs its chunk nothing but
  the vertices it is made of. What they have in common with the town kits is
  the vocabulary (kitbash.ts) and nothing else: a town building answers to a
  street, a lot line and a district, and one of these answers to a hilltop.

  Two rules shape all of them.

  Facing is either free or cardinal, and which one it is depends on the shape.
  Collision out here is an axis-aligned box, so a barn parked at forty degrees
  is mostly invisible wall, exactly the way a car parked askew is. Anything
  rectangular therefore snaps its yaw to the nearest quarter turn, which still
  gives four distinct facings per site; anything round (a lighthouse, a silo, a
  mast, a stone circle) keeps the free yaw the site rolled, because its box
  was going to be a bad fit at any angle and a round thing has no bad one.

  And the silhouette is the deliverable. These exist to be seen from four
  hundred metres, so the masses, the roofline and the mast always build, and
  only the fittings, railings, rubble, guy wires, fence palings, small
  windows, are behind `out.detailed`. On the outer ring you get the shape and
  nothing else, which is all that survives the fog anyway.
*/

/* ----------------------------------------------------------------- paint -- */

const WHITE = '#ddd6c4'
const LAMP_RED = '#a83f34'
const TIMBER = '#6b5a44'
const DARKWOOD = '#4a3d2e'
const OLDSTONE = '#9a9184'
const METAL = '#5b6164'
const RUST = '#7a4f38'
const CONCRETE = '#8d887e'
const ROOF_DARK = '#3a352e'
/** the warm pane every lit opening out here shares */
const LIT = '#ffdca6'

/* ----------------------------------------------------------------- frame -- */

/**
 * A structure's own frame. `snap` quarter-turns the yaw for anything whose
 * collision box has to fit a rectangle; `u` runs across the front and `v` out
 * of it, the same convention the town kits use, so the two files read alike.
 */
const site = (lm: Landmark, snap: boolean) => {
  const face = snap ? Math.round(lm.face / (Math.PI / 2)) * (Math.PI / 2) : lm.face
  const fx = snap ? Math.round(Math.sin(face)) : Math.sin(face)
  const fz = snap ? Math.round(Math.cos(face)) : Math.cos(face)
  const rx = fz
  const rz = -fx
  const side = snap && fx !== 0
  return {
    face, fx, fz, rx, rz,
    x: (u: number, v: number) => lm.x + rx * u + fx * v,
    z: (u: number, v: number) => lm.z + rz * u + fz * v,
    /** the world x/z extents of a local (lu across, lv deep) footprint. Only
        meaningful on a snapped frame, which is the only kind that collides:
        an AABB cannot describe a rotated rectangle, which is the whole
        reason `snap` exists */
    ex: (lu: number, lv: number) => (side ? lv : lu),
    ez: (lu: number, lv: number) => (side ? lu : lv),
  }
}

type Site = ReturnType<typeof site>

/** a box in the structure's frame: `lu` across the front, `lv` deep, yawed
    onto the frame. On a snapped frame the yaw is a quarter turn and the
    result is exactly axis-aligned, which is what `solidL` then boxes */
const boxL = (
  out: BuildOut, s: Site, hex: string, u: number, v: number, cy: number,
  lu: number, h: number, lv: number, surf: SurfaceId = SURF.none,
) => box(out.solid, hex, s.x(u, v), cy, s.z(u, v), lu, h, lv, s.face, surf)

/** and its collision twin */
const solidL = (
  out: BuildOut, s: Site, u: number, v: number, lu: number, lv: number,
  y0: number, y1: number, stand = false, pad = 0,
) => {
  const b = aabb(s.x(u, v), y0, s.z(u, v),
    s.ex(lu, lv) / 2 + pad, y1, s.ez(lu, lv) / 2 + pad)
  out.boxes.push(stand ? b : noStand(b))
}

/** a wall quad whose outward local normal is (du, dv) */
const panelL = (
  out: BuildOut, s: Site, target: 'solid' | 'glass', hex: string,
  u: number, v: number, cy: number, w: number, h: number,
  du: number, dv: number, surf: SurfaceId = SURF.none,
) => panel(out[target], hex, s.x(u + du * 0.06, v + dv * 0.06), cy,
  s.z(u + du * 0.06, v + dv * 0.06), w, h,
  dv > 0 ? s.face : dv < 0 ? s.face + Math.PI
    : s.face + (du > 0 ? Math.PI / 2 : -Math.PI / 2), surf)

/** a small opening, dark by day and warm after dusk */
const port = (
  out: BuildOut, s: Site, u: number, v: number, cy: number,
  w: number, h: number, du: number, dv: number, lit: boolean,
) => {
  boxL(out, s, '#cfc7b4', u, v, cy, du ? 0.14 : w + 0.3, h + 0.3, du ? w + 0.3 : 0.14,
    SURF.plaster)
  panelL(out, s, 'solid', '#28323a', u + du * 0.05, v + dv * 0.05, cy, w, h, du, dv)
  if (lit) panelL(out, s, 'glass', LIT, u + du * 0.1, v + dv * 0.1, cy, w, h, du, dv)
}

/** posts and a top rail around a circle: a gallery, a tank catwalk, a well */
const railing = (
  out: BuildOut, cx: number, cy: number, cz: number, r: number, h: number,
  hex: string, n = 12,
) => {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    box(out.solid, hex, cx + Math.cos(a) * r, cy + h / 2, cz + Math.sin(a) * r,
      0.12, h, 0.12)
  }
  put(out.solid, TUBE12, hex, cx, cy + h, cz, 0, 0, 0, r * 2 + 0.12, 0.11, r * 2 + 0.12)
}

/* ------------------------------------------------------------ lighthouse -- */

/**
 * A banded tower on a headland with a lit lantern in the top of it and the
 * keeper's cottage tucked in behind. The one structure out here that is
 * legible at night from further away than it is by day, which is the whole
 * argument for building it: the emissive pass already exists for city
 * windows, and one glowing ring on a dark coast is worth more of it than a
 * whole block of offices.
 */
const lighthouse = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, false)
  const h = 22 + rng() * 12
  const r0 = 2.9
  const r1 = 1.75
  const bands = 6 + Math.floor(rng() * 3)
  const warm = rng() < 0.45

  // the plinth it is founded on, then the shaft in painted courses
  shaft(out.solid, '#6f6a61', lm.x, y - 1.2, lm.z, r0 * 1.34, 2.4, r0 * 1.2, 12, 0,
    SURF.paving)
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands
    const t1 = (i + 1) / bands
    shaft(out.solid, i % 2 ? (warm ? LAMP_RED : '#3f4a52') : WHITE,
      lm.x, y + 1.2 + t0 * h, lm.z,
      r0 + (r1 - r0) * t0, (h * (t1 - t0)) + 0.02, r0 + (r1 - r0) * t1, 12, 0,
      SURF.plaster)
  }
  const topY = y + 1.2 + h

  // the gallery: a corbel ring wider than the shaft, and the lantern above it
  shaft(out.solid, '#4a4640', lm.x, topY - 0.5, lm.z, r1 * 1.5, 0.7, r1 * 1.7, 12, 0,
    SURF.paving)
  shaft(out.solid, '#3a3f42', lm.x, topY + 0.2, lm.z, r1 * 0.98, 0.3, r1 * 0.98, 12)
  put(out.solid, TUBE12, '#2f3439', lm.x, topY + 1.9, lm.z, 0, 0, 0,
    r1 * 1.9, 3.0, r1 * 1.9)
  // the lamp itself, and the halo around it that the day cycle fades up
  put(out.glass, TUBE12, '#ffe9bd', lm.x, topY + 1.9, lm.z, 0, 0, 0,
    r1 * 1.82, 2.7, r1 * 1.82)
  put(out.glass, BALL, '#fff4d2', lm.x, topY + 1.9, lm.z, 0, 0, 0, 1.5, 1.5, 1.5)
  put(out.solid, CONE12, LAMP_RED, lm.x, topY + 4.4, lm.z, 0, 0, 0,
    r1 * 2.2, 1.9, r1 * 2.2, SURF.panel)
  put(out.solid, BALL, '#c8ac63', lm.x, topY + 5.5, lm.z, 0, 0, 0, 0.5, 0.5, 0.5)
  out.lamps.push({ x: lm.x, y: topY + 1.9, z: lm.z })

  if (out.detailed) {
    railing(out, lm.x, topY + 0.35, lm.z, r1 * 1.62, 1.0, '#3a3f42', 14)
    // a door at the foot, and two little ports up the stair
    port(out, s, 0, r0 * 0.92, y + 2.4, 1.5, 3.0, 0, 1, false)
    boxL(out, s, '#3a2c1e', 0, r0 * 0.98, y + 2.3, 1.4, 3.0, 0.18, SURF.plank)
    for (let i = 1; i <= 3; i++) {
      const a = i * 2.1
      const rr = r0 + (r1 - r0) * (i / 4)
      box(out.solid, '#28323a', lm.x + Math.cos(a) * rr, y + 1.2 + (i / 4) * h,
        lm.z + Math.sin(a) * rr, 0.8, 1.1, 0.8, a, SURF.plaster)
    }
  }
  out.boxes.push(noStand(aabb(lm.x, y - 2, lm.z, r0 * 1.18, topY, r0 * 1.18)))

  // the keeper's cottage, set back from the light and squared up to the world
  const c = site(lm, true)
  const cu = 7.5 * (rng() < 0.5 ? 1 : -1)
  const cv = -5.5
  const ch = 5.6
  boxL(out, c, WHITE, cu, cv, y + ch / 2 - 0.4, 8.4, ch + 0.8, 6.4, SURF.plaster)
  boxL(out, c, '#6f6a61', cu, cv, y + 0.35, 8.8, 0.9, 6.8, SURF.paving)
  put(out.solid, PRISM, '#54423a', c.x(cu, cv), y + ch - 0.05, c.z(cu, cv),
    0, c.face, 0, 9.0, 2.8, 6.9, SURF.shingle)
  boxL(out, c, '#41372f', cu + 2.6, cv - 1.6, y + ch + 3.2, 0.9, 3.4, 0.9, SURF.brick)
  if (out.detailed) {
    port(out, c, cu, cv + 3.3, y + 2.3, 1.5, 3.6, 0, 1, false)
    boxL(out, c, '#3d5342', cu, cv + 3.4, y + 2.2, 1.4, 3.4, 0.14, SURF.plank)
    port(out, c, cu - 2.8, cv + 3.3, y + 3.3, 1.4, 1.4, 0, 1, true)
    port(out, c, cu + 2.8, cv + 3.3, y + 3.3, 1.4, 1.4, 0, 1, rng() < 0.5)
    port(out, c, cu + 4.3, cv, y + 3.3, 1.3, 1.3, 1, 0, false)
    // the path from the cottage door to the tower foot
    boxL(out, c, '#9a948a', cu * 0.45, cv + 4.6, y + 0.05, Math.abs(cu) * 1.2, 0.1, 1.6,
      SURF.paving)
  }
  solidL(out, c, cu, cv, 8.4, 6.4, y - 2, y + ch, false, 0.2)
}

/* -------------------------------------------------------------- windmill -- */

/**
 * A tower mill: a whitewashed stone cone, a boat-shaped cap and four sails.
 * The sails are stamped where they were left rather than turning, because the
 * chunk soup is baked once and a moving one would have to be its own object
 * with its own draw call; what sells it instead is that the whole assembly is
 * canted to the yaw the site rolled, so no two mills on a plain are pointing
 * the same way and the field reads as weather rather than as a repeat.
 */
const windmill = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, false)
  const h = 11 + rng() * 4
  const r0 = 3.4
  const r1 = 2.3
  const body = rng() < 0.5 ? WHITE : '#9a9184'

  shaft(out.solid, '#6f6a61', lm.x, y - 0.8, lm.z, r0 * 1.2, 1.6, r0 * 1.12, 12, 0,
    SURF.paving)
  shaft(out.solid, body, lm.x, y + 0.8, lm.z, r0, h, r1, 12, 0, SURF.brick)
  // the stage: a working gallery a third of the way up, which is the detail
  // that stops the tower reading as a chimney
  const stageY = y + 0.8 + h * 0.42
  const stageR = r0 * 0.86
  shaft(out.solid, DARKWOOD, lm.x, stageY, lm.z, stageR + 0.9, 0.24, stageR + 0.9, 12, 0,
    SURF.plank)
  if (out.detailed) railing(out, lm.x, stageY + 0.24, lm.z, stageR + 0.75, 1.0, DARKWOOD)

  // the cap, and the wind shaft coming out of the front of it
  const capY = y + 0.8 + h
  put(out.solid, DOME, ROOF_DARK, lm.x, capY, lm.z, 0, 0, 0,
    r1 * 2.5, r1 * 2.4, r1 * 2.5, SURF.shingle)
  const hubOut = r1 * 1.15
  const hx = lm.x + s.fx * hubOut
  const hz = lm.z + s.fz * hubOut
  const hy = capY + r1 * 0.7
  put(out.solid, CYL12, DARKWOOD, hx, hy, hz, Math.PI / 2, s.face, 0, 0.9, 1.6, 0.9)

  // four sails: a spar out of the hub with slats laid across it
  const span = 6.5 + rng() * 1.8
  for (let k = 0; k < 4; k++) {
    const th = (k / 4) * Math.PI * 2 + 0.35
    const dx = s.rx * Math.sin(th)
    const dz = s.rz * Math.sin(th)
    const dy = Math.cos(th)
    put(out.solid, BOX, DARKWOOD, hx + dx * span * 0.5, hy + dy * span * 0.5,
      hz + dz * span * 0.5, 0, s.face, -th, 0.34, span, 0.7, SURF.plank)
    if (!out.detailed) continue
    for (let i = 2; i <= 8; i++) {
      const t = (i / 9) * span
      const w = 1.7 * (1 - i / 13)
      put(out.solid, BOX, i % 2 ? '#8d867a' : TIMBER,
        hx + dx * t, hy + dy * t, hz + dz * t,
        0, s.face, -th, w, 0.16, 0.42, SURF.plank)
    }
  }

  if (out.detailed) {
    port(out, s, 0, r0 * 0.94, y + 2.6, 1.6, 3.4, 0, 1, false)
    boxL(out, s, '#3a2c1e', 0, r0 * 1.0, y + 2.4, 1.5, 3.2, 0.16, SURF.plank)
    for (const a of [1.4, 3.6, 5.1]) {
      const rr = r0 * 0.94
      box(out.solid, '#28323a', lm.x + Math.cos(a) * rr, y + 6.4,
        lm.z + Math.sin(a) * rr, 0.9, 1.2, 0.9, a, SURF.plaster)
    }
  }
  out.boxes.push(noStand(aabb(lm.x, y - 2, lm.z, r0 * 1.1, capY, r0 * 1.1)))
}

/* ------------------------------------------------------------ farmstead -- */

/**
 * A barn, a silo, a farmhouse and a paddock fence around the lot. The barn
 * carries a gambrel because that profile alone says "farm" at a range where
 * nothing else here is resolvable, and the fence matters more than any of the
 * buildings: it is the thing that turns four objects standing near each other
 * into one place with an inside and an outside.
 */
const farm = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, true)
  const red = pick(['#8f4a3a', '#9c5342', '#7d3b30', '#6f5645'], rng())

  /* ---- the barn ---- */
  const bu = -6.5
  const bv = -3.0
  const bw = 15
  const bd = 10.5
  const bh = 6.6
  boxL(out, s, red, bu, bv, y + bh / 2 - 0.4, bw, bh + 0.8, bd, SURF.plank)
  boxL(out, s, '#6f6a61', bu, bv, y + 0.3, bw + 0.4, 0.8, bd + 0.4, SURF.paving)
  put(out.solid, GAMBREL, '#4e4a44', s.x(bu, bv), y + bh - 0.05, s.z(bu, bv),
    0, s.face, 0, bw * 1.05, bd * 0.52, bd * 1.08, SURF.shingle)
  // the cupola on the ridge, with a vent in it
  boxL(out, s, red, bu, bv, y + bh + bd * 0.52 + 0.7, 1.7, 1.6, 1.7, SURF.plank)
  put(out.solid, CONE12, '#4e4a44', s.x(bu, bv), y + bh + bd * 0.52 + 2.2, s.z(bu, bv),
    0, s.face, 0, 2.2, 1.1, 2.2, SURF.shingle)
  if (out.detailed) {
    // the big door, cross-braced, with the hayloft opening above it
    const dv = bd / 2 + 0.06
    boxL(out, s, '#e2dbc8', bu, bv + dv, y + 2.9, 6.4, 5.6, 0.2, SURF.plank)
    boxL(out, s, red, bu, bv + dv + 0.02, y + 2.9, 5.8, 5.0, 0.22, SURF.plank)
    for (const q of [-1, 1]) {
      put(out.solid, BOX, '#e2dbc8', s.x(bu, bv + dv + 0.1), y + 2.9, s.z(bu, bv + dv + 0.1),
        0, s.face, q * 0.72, 7.4, 0.24, 0.14, SURF.plank)
    }
    boxL(out, s, '#3a2c1e', bu, bv + dv, y + bh + 1.1, 2.4, 2.2, 0.2, SURF.plank)
    boxL(out, s, DARKWOOD, bu, bv + dv + 0.7, y + bh + 2.5, 0.28, 0.28, 1.6, SURF.plank)
    // trim boards down the corners, white on red, which is the whole look
    for (const q of [-1, 1]) {
      boxL(out, s, '#e2dbc8', bu + q * (bw / 2 - 0.15), bv, y + bh / 2, 0.3, bh, bd + 0.1,
        SURF.plank)
    }
    port(out, s, bu, bv - bd / 2 - 0.05, y + 3.4, 1.3, 1.3, 0, -1, rng() < 0.4)
  }
  solidL(out, s, bu, bv, bw, bd, y - 2, y + bh, false, 0.2)

  /* ---- the silo ---- */
  const su = 6.0
  const sv = -6.0
  const sh = 11 + rng() * 4
  const sr = 2.3
  shaft(out.solid, '#6f6a61', s.x(su, sv), y - 0.6, s.z(su, sv), sr * 1.18, 1.2, sr * 1.14,
    12, 0, SURF.paving)
  shaft(out.solid, '#a8a496', s.x(su, sv), y + 0.6, s.z(su, sv), sr, sh, sr, 12, 0,
    SURF.panel)
  put(out.solid, DOME, METAL, s.x(su, sv), y + 0.6 + sh, s.z(su, sv), 0, 0, 0,
    sr * 2.1, sr * 1.5, sr * 2.1, SURF.panel)
  if (out.detailed) {
    // the hoop bands and a ladder up the near side, which is what makes a
    // grey cylinder read as a grain silo rather than as a pipe
    for (let i = 1; i < 5; i++) {
      put(out.solid, TUBE12, '#8f8b80', s.x(su, sv), y + 0.6 + (i / 5) * sh, s.z(su, sv),
        0, 0, 0, sr * 2.06, 0.22, sr * 2.06, SURF.panel)
    }
    for (let i = 0; i < 12; i++) {
      boxL(out, s, METAL, su, sv + sr + 0.14, y + 1.2 + i * (sh / 12), 0.7, 0.1, 0.1)
    }
  }
  out.boxes.push(noStand(aabb(s.x(su, sv), y - 2, s.z(su, sv),
    sr + 0.15, y + 0.6 + sh, sr + 0.15)))

  /* ---- the farmhouse ---- */
  const hu = 8.5
  const hv = 8.0
  const fh = 6.4
  const wall = pick(['#c9c0ae', '#b8ad96', '#a89c86'], rng())
  boxL(out, s, wall, hu, hv, y + fh / 2 - 0.4, 9.0, fh + 0.8, 7.4, SURF.plaster)
  boxL(out, s, '#6f6a61', hu, hv, y + 0.3, 9.4, 0.8, 7.8, SURF.paving)
  put(out.solid, PRISM, '#4a3c33', s.x(hu, hv), y + fh - 0.05, s.z(hu, hv),
    0, s.face, 0, 9.4, 3.4, 7.8, SURF.shingle)
  boxL(out, s, '#41372f', hu + 3.0, hv - 2.0, y + fh + 3.6, 0.9, 3.2, 0.9, SURF.brick)
  if (out.detailed) {
    // a porch across the front, because a farmhouse always has one
    boxL(out, s, '#8b867c', hu, hv + 4.6, y + 0.2, 8.0, 0.4, 2.6, SURF.paving)
    boxL(out, s, '#4a3c33', hu, hv + 4.6, y + 5.4, 8.4, 0.26, 3.0, SURF.plank)
    for (const q of [-1, 1]) {
      boxL(out, s, '#cfc7b4', hu + q * 3.4, hv + 5.6, y + 2.8, 0.22, 5.2, 0.22)
    }
    solidL(out, s, hu, hv + 4.6, 8.0, 2.6, y - 1, y + 0.4, true)
    boxL(out, s, '#3d5342', hu, hv + 3.8, y + 2.5, 1.5, 4.6, 0.16, SURF.plank)
    port(out, s, hu - 3.0, hv + 3.75, y + 3.4, 1.5, 1.5, 0, 1, true)
    port(out, s, hu + 3.0, hv + 3.75, y + 3.4, 1.5, 1.5, 0, 1, rng() < 0.6)
    port(out, s, hu + 4.6, hv, y + 3.4, 1.4, 1.4, 1, 0, rng() < 0.4)
  }
  solidL(out, s, hu, hv, 9.0, 7.4, y - 2, y + fh, false, 0.2)

  /* ---- the paddock ---- */
  if (out.detailed) {
    const pu = 20
    const pv = 19
    // posts and two rails, with the gate left open on the front side
    const rail = (u0: number, v0: number, u1: number, v1: number) => {
      const n = Math.max(2, Math.round(Math.hypot(u1 - u0, v1 - v0) / 3))
      for (let i = 0; i <= n; i++) {
        const u = u0 + ((u1 - u0) * i) / n
        const v = v0 + ((v1 - v0) * i) / n
        if (v > pv - 0.5 && Math.abs(u) < 3.2) continue
        boxL(out, s, TIMBER, u, v, y + 0.85, 0.24, 1.7, 0.24, SURF.plank)
      }
      const mu = (u0 + u1) / 2
      const mv = (v0 + v1) / 2
      const lu = Math.abs(u1 - u0) + 0.2
      const lv = Math.abs(v1 - v0) + 0.2
      for (const rh of [0.62, 1.34]) {
        boxL(out, s, TIMBER, mu, mv, y + rh, Math.max(0.16, lu), 0.16, Math.max(0.16, lv),
          SURF.plank)
      }
      solidL(out, s, mu, mv, Math.max(0.3, lu), Math.max(0.3, lv), y - 1, y + 1.5,
        false, 0.05)
    }
    rail(-pu, -pv, pu, -pv)
    rail(-pu, pv, -3.4, pv)
    rail(3.4, pv, pu, pv)
    rail(-pu, -pv, -pu, pv)
    rail(pu, -pv, pu, pv)

    // hay bales, dropped where the baler left them
    for (let i = 0; i < 4; i++) {
      const u = -2 + rng() * 16
      const v = 2 + rng() * 12
      const a = rng() * Math.PI
      put(out.solid, CYL12, '#b8a768', s.x(u, v), y + 1.0, s.z(u, v),
        Math.PI / 2, a, 0, 2.0, 2.4, 2.0, SURF.plank)
      out.boxes.push(noStand(aabb(s.x(u, v), y - 1, s.z(u, v), 1.2, y + 2.0, 1.2)))
    }
    // and a trough by the barn
    boxL(out, s, '#6f6a61', bu + bw / 2 + 2.4, bv + 2, y + 0.55, 1.2, 1.1, 3.4,
      SURF.paving)
  }
}

/* ------------------------------------------------------------ radio mast -- */

/**
 * A guyed lattice mast on high ground: three legs in aviation bands, a
 * horizontal and a diagonal per stage, nine guys out to three anchors, and a
 * red beacon at the top and the waist. Three legs rather than four because
 * the AABB around a triangular mast is a better fit than around a square one
 * at a free yaw, and because it is a third fewer struts for a silhouette
 * nobody can tell apart at the distance this is built to be seen from.
 */
const mast = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, true)
  const h = 34 + rng() * 22
  const stages = 9
  const rBase = 2.1
  const rTop = 0.75
  const legR = (t: number) => rBase + (rTop - rBase) * t
  const legXZ = (i: number, t: number): [number, number] => {
    const a = (i / 3) * Math.PI * 2 + lm.face
    return [lm.x + Math.cos(a) * legR(t), lm.z + Math.sin(a) * legR(t)]
  }

  box(out.solid, CONCRETE, lm.x, y + 0.2, lm.z, rBase * 2.6, 0.5, rBase * 2.6, lm.face,
    SURF.paving)
  for (let k = 0; k < stages; k++) {
    const t0 = k / stages
    const t1 = (k + 1) / stages
    const y0 = y + 0.4 + t0 * h
    const y1 = y + 0.4 + t1 * h
    // aviation banding: the top third and every other stage under it
    const paint = k % 2 === 0 ? '#c0453a' : '#e0dcd2'
    for (let i = 0; i < 3; i++) {
      const [ax, az] = legXZ(i, t0)
      const [bx, bz] = legXZ(i, t1)
      strut(out.solid, paint, ax, y0, az, bx, y1, bz, 0.24, SURF.panel)
      if (!out.detailed) continue
      const [cx, cz] = legXZ((i + 1) % 3, t0)
      const [dx, dz] = legXZ((i + 1) % 3, t1)
      strut(out.solid, METAL, ax, y0, az, cx, y0, cz, 0.15)
      // the diagonal alternates hand per stage, which reads as a zigzag up
      // the mast instead of as a spiral
      if (k % 2) strut(out.solid, METAL, ax, y0, az, dx, y1, dz, 0.13)
      else strut(out.solid, METAL, cx, y0, cz, bx, y1, bz, 0.13)
    }
  }
  // the beacons, and the dish cluster at the waist
  for (const t of [1, 0.62]) {
    const by = y + 0.4 + t * h
    box(out.solid, '#5a1e1e', lm.x, by + 0.5, lm.z, 0.7, 1.0, 0.7)
    put(out.glass, BALL, '#ff5a4a', lm.x, by + 0.9, lm.z, 0, 0, 0, 1.1, 1.1, 1.1)
  }
  if (out.detailed) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + lm.face + 0.6
      const dy = y + 0.4 + h * (0.44 + i * 0.07)
      put(out.solid, CYL12, '#d8d2c4', lm.x + Math.cos(a) * (legR(0.5) + 0.9), dy,
        lm.z + Math.sin(a) * (legR(0.5) + 0.9), Math.PI / 2, a + Math.PI / 2, 0,
        1.9, 0.3, 1.9, SURF.panel)
    }
    // the guys: three anchors, three wires each
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + lm.face + Math.PI / 3
      const ax = lm.x + Math.cos(a) * 13
      const az = lm.z + Math.sin(a) * 13
      box(out.solid, CONCRETE, ax, y + 0.35, az, 1.2, 0.7, 1.2, a, SURF.paving)
      for (const t of [0.38, 0.66, 0.94]) {
        strut(out.solid, '#6a6f74', ax, y + 0.6, az,
          lm.x + Math.cos(a) * legR(t) * 0.6, y + 0.4 + t * h,
          lm.z + Math.sin(a) * legR(t) * 0.6, 0.09)
      }
    }
    // the equipment hut at the foot
    const hu = 5.5
    boxL(out, s, '#b0aca0', hu, 0, y + 1.6, 4.4, 3.2, 3.4, SURF.panel)
    put(out.solid, SHED, METAL, s.x(hu, 0), y + 3.2, s.z(hu, 0), 0, s.face, 0,
      4.7, 0.6, 3.7, SURF.panel)
    boxL(out, s, '#4a4640', hu, 1.75, y + 1.4, 1.2, 2.6, 0.14, SURF.panel)
    boxL(out, s, METAL, hu - 1.5, 1.75, y + 2.6, 1.0, 0.7, 0.14, SURF.panel)
    solidL(out, s, hu, 0, 4.4, 3.4, y - 1, y + 3.2, false, 0.15)
  }
  out.boxes.push(noStand(aabb(lm.x, y - 1, lm.z, rBase + 0.4, y + h, rBase + 0.4)))
}

/* ---------------------------------------------------------------- ruins -- */

/**
 * What is left of something: a rectangle of broken wall with the courses
 * stepping down toward the gaps, a doorway that still has its lintel, a
 * colonnade with most of its columns on the ground, and an altar in the
 * middle. Wall stubs under waist height register standable, because a ruin
 * you can climb about on is worth three you can only walk around.
 */
const ruins = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, true)
  const stone = rng() < 0.5 ? OLDSTONE : '#a89c86'
  const hu = 7 + rng() * 3
  const hv = 5.5 + rng() * 3

  /** one run of wall, broken into segments of falling height with gaps in it */
  const wall = (u0: number, v0: number, u1: number, v1: number, gate: boolean) => {
    const len = Math.hypot(u1 - u0, v1 - v0)
    const n = Math.max(3, Math.round(len / 1.9))
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n
      if (gate && Math.abs(t - 0.5) < 0.14) continue
      if (rng() < 0.22) continue
      const u = u0 + (u1 - u0) * t
      const v = v0 + (v1 - v0) * t
      // taller in the middle of a run, gnawed away toward the ends
      const k = 1 - Math.abs(t - 0.5) * 1.5
      const h = (0.7 + k * 3.4) * (0.7 + rng() * 0.6)
      const su = Math.abs(u1 - u0) / n + 0.7
      const sv = Math.abs(v1 - v0) / n + 0.7
      boxL(out, s, stone, u, v, y + h / 2, su, h, sv, SURF.brick)
      solidL(out, s, u, v, su, sv, y - 1, y + h, h < 1.7, 0.05)
    }
    if (!gate) return
    // the doorway that outlived the wall: two jambs and the lintel across
    const mu = (u0 + u1) / 2
    const mv = (v0 + v1) / 2
    const du = (u1 - u0) / len
    const dv = (v1 - v0) / len
    for (const q of [-1, 1]) {
      boxL(out, s, stone, mu + du * q * 1.5, mv + dv * q * 1.5, y + 2.4,
        Math.abs(du) * 1.1 + 0.9, 4.8, Math.abs(dv) * 1.1 + 0.9, SURF.brick)
      solidL(out, s, mu + du * q * 1.5, mv + dv * q * 1.5,
        Math.abs(du) * 1.1 + 0.9, Math.abs(dv) * 1.1 + 0.9, y - 1, y + 4.8)
    }
    boxL(out, s, stone, mu, mv, y + 5.3,
      Math.abs(du) * 4.4 + 1.0, 1.0, Math.abs(dv) * 4.4 + 1.0, SURF.brick)
  }
  wall(-hu, hv, hu, hv, true)
  wall(-hu, -hv, hu, -hv, false)
  wall(-hu, -hv, -hu, hv, false)
  wall(hu, -hv, hu, hv, rng() < 0.4)

  // the colonnade: a few still up, more of them in pieces on the floor
  for (let i = 0; i < 5; i++) {
    const u = -hu * 0.6 + (i / 4) * hu * 1.2
    const v = -hv * 0.45
    if (rng() < 0.45) {
      const ch = 3.4 + rng() * 2.6
      shaft(out.solid, stone, s.x(u, v), y, s.z(u, v), 0.62, ch, 0.55, 8, 0, SURF.paving)
      boxL(out, s, stone, u, v, y + ch + 0.2, 1.6, 0.4, 1.6, SURF.paving)
      out.boxes.push(noStand(aabb(s.x(u, v), y - 1, s.z(u, v), 0.75, y + ch, 0.75)))
      continue
    }
    if (!out.detailed) continue
    // toppled: two or three drums lying where they rolled
    const a = rng() * Math.PI
    for (let d = 0; d < 2 + Math.floor(rng() * 2); d++) {
      const ox = Math.cos(a) * d * 1.5 + (rng() - 0.5)
      const oz = Math.sin(a) * d * 1.5 + (rng() - 0.5)
      put(out.solid, CYL12, stone, s.x(u, v) + ox, y + 0.6, s.z(u, v) + oz,
        Math.PI / 2, a + (rng() - 0.5) * 0.4, 0, 1.2, 1.3, 1.2, SURF.paving)
    }
  }

  // the altar, which is also the one thing in here you are meant to stand on
  boxL(out, s, stone, 0, 0, y + 0.35, 3.2, 0.7, 2.2, SURF.paving)
  boxL(out, s, '#b5ac9b', 0, 0, y + 0.82, 3.6, 0.26, 2.6, SURF.paving)
  solidL(out, s, 0, 0, 3.6, 2.6, y - 1, y + 0.95, true)

  if (out.detailed) {
    // rubble, thickest where the walls came down
    for (let i = 0; i < 14; i++) {
      const u = (rng() - 0.5) * hu * 2.4
      const v = (rng() - 0.5) * hv * 2.4
      const r = 0.3 + rng() * 0.6
      put(out.solid, BOX, stone, s.x(u, v), y + r * 0.4, s.z(u, v),
        (rng() - 0.5) * 0.5, rng() * 3, (rng() - 0.5) * 0.5, r * 2, r, r * 1.6,
        SURF.paving)
    }
    // the floor it all stood on, still just about readable through the grass
    boxL(out, s, '#93897a', 0, 0, y + 0.03, hu * 1.8, 0.08, hv * 1.8, SURF.paving)
  }
}

/* ----------------------------------------------------------- water tower -- */

/**
 * Four splayed legs, cross braces, a riveted tank and a catwalk. Small, quick
 * and readable from a long way off, and the one landmark you can walk
 * underneath, which is worth more than it sounds: everything else out here is
 * something you walk around.
 */
const watertower = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const legH = 9 + rng() * 4
  const rBase = 3.6
  const rTop = 2.1
  const tankR = 3.0
  const tankH = 4.6 + rng() * 1.4
  const paint = pick(['#8d9a92', '#a8a08c', '#7d8a94', '#9a8f7d'], rng())

  const leg = (i: number, t: number): [number, number] => {
    const a = (i / 4) * Math.PI * 2 + lm.face + Math.PI / 4
    const r = rBase + (rTop - rBase) * t
    return [lm.x + Math.cos(a) * r, lm.z + Math.sin(a) * r]
  }
  for (let i = 0; i < 4; i++) {
    const [ax, az] = leg(i, 0)
    const [bx, bz] = leg(i, 1)
    strut(out.solid, METAL, ax, y, az, bx, y + legH, bz, 0.34, SURF.panel)
    box(out.solid, CONCRETE, ax, y + 0.25, az, 1.0, 0.6, 1.0, lm.face, SURF.paving)
    out.boxes.push(noStand(aabb((ax + bx) / 2, y - 1, (az + bz) / 2, 0.35, y + legH, 0.35)))
    if (!out.detailed) continue
    const [cx, cz] = leg((i + 1) % 4, 0)
    const [dx, dz] = leg((i + 1) % 4, 1)
    for (const t of [0.42, 0.84]) {
      const [px, pz] = leg(i, t)
      const [qx, qz] = leg((i + 1) % 4, t)
      strut(out.solid, METAL, px, y + legH * t, pz, qx, y + legH * t, qz, 0.16)
    }
    strut(out.solid, '#6a6f74', ax, y + 0.3, az, dx, y + legH * 0.84, dz, 0.11)
    strut(out.solid, '#6a6f74', cx, y + 0.3, cz, bx, y + legH * 0.84, bz, 0.11)
  }
  // the tank, its hoop bands, a conical roof and the downpipe
  shaft(out.solid, paint, lm.x, y + legH, lm.z, tankR, tankH, tankR, 12, 0, SURF.panel)
  put(out.solid, CONE12, RUST, lm.x, y + legH + tankH + 0.9, lm.z, 0, 0, 0,
    tankR * 2.1, 1.9, tankR * 2.1, SURF.panel)
  shaft(out.solid, METAL, lm.x, y + 0.2, lm.z, 0.28, legH, 0.28, 8)
  if (out.detailed) {
    for (const t of [0.25, 0.72]) {
      put(out.solid, TUBE12, '#6a6f74', lm.x, y + legH + tankH * t, lm.z, 0, 0, 0,
        tankR * 2.06, 0.24, tankR * 2.06, SURF.panel)
    }
    shaft(out.solid, METAL, lm.x, y + legH - 0.16, lm.z, tankR + 0.7, 0.16, tankR + 0.7,
      12, 0, SURF.panel)
    railing(out, lm.x, y + legH, lm.z, tankR + 0.55, 0.9, METAL, 14)
    // a ladder up one leg, and the town's name where a town would put it
    const [lx, lz] = leg(0, 0.5)
    for (let i = 0; i < 10; i++) {
      box(out.solid, '#6a6f74', lx, y + 0.8 + i * (legH / 11), lz, 0.7, 0.09, 0.09,
        lm.face)
    }
    put(out.solid, TUBE12, '#3f4a52', lm.x, y + legH + tankH * 0.5, lm.z, 0, 0, 0,
      tankR * 2.08, 1.4, tankR * 2.08, SURF.panel)
  }
  out.boxes.push(noStand(aabb(lm.x, y + legH - 0.5, lm.z,
    tankR + 0.8, y + legH + tankH + 2, tankR + 0.8)))
}

/* -------------------------------------------------------- standing stones -- */

/**
 * A ring of hewn stones with a couple of trilithons still standing and the
 * rest of the circle on its side. Cheap, silent and older than everything
 * around it, which is exactly the note the empty tundra needs: not a
 * building, just evidence.
 */
const stones = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const n = 9 + Math.floor(rng() * 5)
  const rad = 8.5 + rng() * 4
  const grey = pick(['#8d867a', '#7d786e', '#9a9184', '#84806f'], rng())

  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + lm.face
    const px = lm.x + Math.cos(a) * rad
    const pz = lm.z + Math.sin(a) * rad
    const fallen = rng() < 0.24
    // a megalith has to clear the eye line at 3.55 or the ring reads as
    // paving slabs somebody dropped, which is exactly how the first probe
    // shot of this came out against savanna scrub
    const w = 1.7 + rng() * 1.1
    const t = 0.75 + rng() * 0.4
    if (fallen) {
      const h = 3.4 + rng() * 2.0
      put(out.solid, BOX, grey, px, y + t * 0.5, pz,
        Math.PI / 2 + (rng() - 0.5) * 0.2, a + (rng() - 0.5) * 0.9, 0,
        w, h, t, SURF.paving)
      out.boxes.push(aabb(px, y - 1, pz, h * 0.5, y + t, h * 0.5))
      continue
    }
    const h = 4.0 + rng() * 2.4
    // canted a few degrees, because nothing that has stood for that long is
    // still plumb, and a ring of perfectly upright slabs reads as a fence
    put(out.solid, BOX, grey, px, y + h / 2 - 0.2, pz,
      (rng() - 0.5) * 0.14, a, (rng() - 0.5) * 0.14, w, h, t, SURF.paving)
    out.boxes.push(noStand(aabb(px, y - 1, pz, w * 0.6, y + h - 0.2, w * 0.6)))
    // every so often a pair holds a lintel up between them
    if (out.detailed && i % 4 === 0 && rng() < 0.7) {
      const a2 = ((i + 1) / n) * Math.PI * 2 + lm.face
      const qx = lm.x + Math.cos(a2) * rad
      const qz = lm.z + Math.sin(a2) * rad
      const span = Math.hypot(qx - px, qz - pz)
      put(out.solid, BOX, grey, (px + qx) / 2, y + h - 0.05, (pz + qz) / 2,
        0, Math.atan2(qx - px, qz - pz), 0, t * 1.1, 0.7, span + 1.2, SURF.paving)
    }
  }
  // the recumbent stone at the centre, flat enough to stand on
  put(out.solid, BOX, grey, lm.x, y + 0.3, lm.z, 0, lm.face + 0.3, 0,
    3.4, 0.6, 2.2, SURF.paving)
  out.boxes.push(aabb(lm.x, y - 1, lm.z, 1.8, y + 0.6, 1.4))
  if (out.detailed) {
    for (let i = 0; i < 8; i++) {
      const a = rng() * Math.PI * 2
      const r = rad * (0.3 + rng() * 0.9)
      const sc = 0.3 + rng() * 0.4
      put(out.solid, BOX, grey, lm.x + Math.cos(a) * r, y + sc * 0.35,
        lm.z + Math.sin(a) * r, (rng() - 0.5) * 0.4, rng() * 3, (rng() - 0.5) * 0.4,
        sc * 2, sc, sc * 1.5, SURF.paving)
    }
  }
}

/* ----------------------------------------------------------------- cabin -- */

/**
 * A log cabin with a stone chimney, a porch and one lit window. The walls are
 * real stacked logs rather than a box with a bark treatment on it, which
 * costs about forty cylinders and is the entire difference between a cabin
 * and a shed: what you read at ten paces is the notched ends sticking out
 * past the corners.
 */
const cabin = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, true)
  const hu = 4.4
  const hv = 3.6
  const courses = 8
  const logR = 0.42
  const wallH = courses * logR * 2
  const log = pick(['#6b5a44', '#75604a', '#5d4d3b'], rng())

  // A rubble footing, then the courses. All four walls get a log every
  // course: alternating which *pair* was laid, which is what a real cabin
  // does, left every other course of every wall missing, and from ten paces
  // that is not a notched corner, it is a wall you can see through. What
  // alternates instead is which pair runs long past the corner, which is the
  // part you actually read.
  boxL(out, s, '#6f6a61', 0, 0, y + 0.3, hu * 2 + 0.8, 0.6, hv * 2 + 0.8, SURF.paving)
  for (let i = 0; i < courses; i++) {
    const cy = y + 0.6 + logR + i * logR * 2
    const over = i % 2 ? 0.6 : 0.1
    const tone = i % 2 ? log : '#5f4f3c'
    for (const q of [-1, 1]) {
      put(out.solid, CYL12, tone, s.x(0, q * hv), cy, s.z(0, q * hv),
        Math.PI / 2, s.face + Math.PI / 2, 0,
        logR * 2, hu * 2 + over * 2, logR * 2, SURF.bark)
      put(out.solid, CYL12, tone, s.x(q * hu, 0), cy, s.z(q * hu, 0),
        Math.PI / 2, s.face, 0, logR * 2, hv * 2 + (0.7 - over) * 2, logR * 2,
        SURF.bark)
    }
  }
  // the gable ends filled in above the walls, and the roof over the lot
  const gY = y + 0.6 + wallH
  const rise = hv * 1.05
  boxL(out, s, log, 0, 0, gY + rise * 0.4, hu * 2 - 0.2, rise * 0.8, hv * 2 - 0.2,
    SURF.bark)
  put(out.solid, PRISM, ROOF_DARK, s.x(0, 0), gY - 0.1, s.z(0, 0),
    0, s.face + Math.PI / 2, 0, hv * 2.3, rise, hu * 2.4, SURF.plank)
  // a stone chimney climbing one flank, past the ridge
  const ch = (rng() < 0.5 ? 1 : -1) * (hu + 0.55)
  // a stack a fifth of the cabin's width reads as a tower bolted to the side
  // of it, which is what the first cut looked like at 1.6 by 1.9
  const stackTop = gY + rise + 1.3
  boxL(out, s, '#7d786e', ch, -hv * 0.3, (y + stackTop) / 2,
    1.2, stackTop - y, 1.5, SURF.brick)
  boxL(out, s, '#5f5b53', ch, -hv * 0.3, stackTop + 0.1, 1.5, 0.36, 1.8, SURF.paving)

  if (out.detailed) {
    // the porch: a deck you step onto, two posts and the roof reaching over
    boxL(out, s, DARKWOOD, 0, hv + 1.5, y + 0.7, hu * 2, 0.3, 3.0, SURF.plank)
    solidL(out, s, 0, hv + 1.5, hu * 2, 3.0, y - 1, y + 0.85, true)
    boxL(out, s, ROOF_DARK, 0, hv + 1.6, gY + 0.4, hu * 2.2, 0.24, 3.4, SURF.plank)
    for (const q of [-1, 1]) {
      boxL(out, s, log, q * (hu - 0.5), hv + 2.8, y + (gY + 0.4) / 2 + 0.42,
        0.34, gY - y - 0.4, 0.34, SURF.bark)
    }
    boxL(out, s, '#3a2c1e', 0, hv + 0.1, y + 3.1, 1.6, 4.4, 0.2, SURF.plank)
    port(out, s, -2.4, hv + 0.1, y + 3.6, 1.3, 1.3, 0, 1, true)
    port(out, s, 2.4, hv + 0.1, y + 3.6, 1.3, 1.3, 0, 1, rng() < 0.4)
    port(out, s, -hu - 0.1, 0, y + 3.6, 1.2, 1.2, -1, 0, false)
    out.lamps.push({ x: s.x(-2.4, hv + 1), y: y + 3.6, z: s.z(-2.4, hv + 1) })

    // a woodpile against the gable, and a fire ring out front
    const wu = (ch > 0 ? -1 : 1) * (hu + 1.1)
    for (let r = 0; r < 3; r++)
      for (let cN = 0; cN < 5; cN++) {
        if (rng() < 0.12) continue
        put(out.solid, CYL12, r % 2 ? '#8a7355' : TIMBER,
          s.x(wu, -hv + 0.5 + cN * 0.5), y + 0.9 + r * 0.48,
          s.z(wu, -hv + 0.5 + cN * 0.5),
          Math.PI / 2, s.face + Math.PI / 2, 0, 0.46, 2.2, 0.46, SURF.bark)
      }
    solidL(out, s, wu, -hv + 1.5, 2.4, 2.8, y - 1, y + 2.2, false, 0.1)

    const fu = -hu * 0.4
    const fv = hv + 6.5
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      put(out.solid, BOX, '#7d786e', s.x(fu + Math.cos(a) * 1.4, fv + Math.sin(a) * 1.4),
        y + 0.22, s.z(fu + Math.cos(a) * 1.4, fv + Math.sin(a) * 1.4),
        0, a, 0, 0.7, 0.45, 0.5, SURF.paving)
    }
    boxL(out, s, '#2e2620', fu, fv, y + 0.1, 2.4, 0.14, 2.4)
    put(out.glass, BALL, '#ff9a4a', s.x(fu, fv), y + 0.3, s.z(fu, fv), 0, 0, 0,
      1.5, 0.7, 1.5)
  }
  solidL(out, s, 0, 0, hu * 2 + 0.4, hv * 2 + 0.4, y - 2, gY, false, 0.1)
}

/* -------------------------------------------------------------- shipwreck -- */

/**
 * A hull on its side in the shallows. What reads as a wreck at a glance is
 * not a skeleton, it is a *hull with holes in it*, so this is built as a
 * surface: one `hull(t, side, k)` function gives every point on it, the
 * frames are struts up that surface and the planking is strakes running along
 * it, with the upper strakes of one flank simply left out where she stove in.
 * The first cut was a keel with ribs standing off it and three loose planks,
 * and it photographed as a pile of sticks in the sand.
 *
 * It grades nothing, because a beach flattened under a wreck reads as a car
 * park with a boat parked on it, so the frames take the sand as they find it.
 */
const wreck = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, true)
  const len = 21 + rng() * 9
  const beam = 6.4
  const ribH = 5.2
  /** how far she went over, as a sideways lean per unit of height */
  const heel = 0.3 + rng() * 0.26
  const timber = pick(['#5f5344', '#6b5a44', '#544a3e'], rng())
  const pale = '#6f6252'
  const dark = '#463c30'

  /** the keel: stern settled into the sand, bow lifted clear of it. It has to
      stay within about a unit of the ground the whole way, because everything
      else is measured up from it */
  const keelY = (t: number) => y - 0.35 + t * 1.7
  /** a point on the hull: `t` stern to bow, `q` the side, `k` up the frame.
      The flare is a quarter sine in `k`, so the sections leave the keel
      vertical and open out toward the sheer the way a real one does */
  const hull = (t: number, q: number, k: number) => {
    const taper = Math.sin(t * Math.PI) * 0.72 + 0.28
    const rise = ribH * taper * k
    const half = beam * 0.5 * taper * Math.sin(k * Math.PI * 0.5)
    const v = (t - 0.5) * len
    const u = q * half + heel * rise
    return [s.x(u, v), keelY(t) + rise, s.z(u, v)] as const
  }

  const N = 9
  for (let i = 0; i < N; i++) {
    const [ax, ay, az] = hull(i / N, 0, 0)
    const [bx, by, bz] = hull((i + 1) / N, 0, 0)
    strut(out.solid, dark, ax, ay, az, bx, by, bz, 1.1, SURF.plank)
    // walkable along the spine, which is the whole reason to put one of these
    // on a beach the player can reach
    out.boxes.push(aabb((ax + bx) / 2, y - 2, (az + bz) / 2,
      1.4, (ay + by) / 2 + 0.6, 1.4))
  }

  // the frames, two segments each so they curve out of the keel
  for (let i = 0; i <= N; i++) {
    const t = i / N
    if (t < 0.05 || t > 0.95) continue
    for (const q of [-1, 1]) {
      if (rng() < 0.1) continue
      for (const [k0, k1] of [[0, 0.5], [0.5, 1]]) {
        const [ax, ay, az] = hull(t, q, k0)
        const [bx, by, bz] = hull(t, q, k1)
        strut(out.solid, timber, ax, ay, az, bx, by, bz, 0.34, SURF.plank)
      }
    }
  }

  // the planking. Gaps between the strakes are not a budget compromise, they
  // are the look: a hull that has been open to the weather for decades has
  // lost every other board, and a solid one would read as a boat somebody
  // left rather than as a wreck
  const stove = 0.3 + rng() * 0.3
  for (const q of [-1, 1])
    for (const k of [0.15, 0.35, 0.55, 0.75, 0.95]) {
      for (let i = 0; i < N; i++) {
        const t0 = i / N
        const t1 = (i + 1) / N
        if (t0 < 0.04 || t1 > 0.96) continue
        // the flank she came down on keeps her planking; the other is open to
        // the sky amidships
        if (q > 0 && k > 0.3 && t0 > stove && t0 < stove + 0.36) continue
        if (rng() < 0.09) continue
        const [ax, ay, az] = hull(t0, q, k)
        const [bx, by, bz] = hull(t1, q, k)
        strut(out.solid, (i + Math.round(k * 10)) % 2 ? timber : pale,
          ax, ay, az, bx, by, bz, 0.6, SURF.plank)
      }
    }

  // the transom across the stern, and the stem post at the bow
  for (const k of [0.2, 0.5, 0.8]) {
    const [ax, ay, az] = hull(0.04, -1, k)
    const [bx, by, bz] = hull(0.04, 1, k)
    strut(out.solid, pale, ax, ay, az, bx, by, bz, 0.55, SURF.plank)
  }
  {
    const [ax, ay, az] = hull(0.99, 0, 0)
    const [bx, by, bz] = hull(0.92, 0, 1.15)
    strut(out.solid, dark, ax, ay, az, bx, by, bz, 0.7, SURF.plank)
  }

  // the mast: a stump still stepped on the keel, and the spar itself lying in
  // the sand off the bow where it came down
  const [mx, my, mz] = hull(0.62, 0, 0)
  strut(out.solid, dark, mx, my, mz,
    mx + s.rx * heel * 5.4, my + 6.4, mz + s.rz * heel * 5.4, 0.8, SURF.bark)
  const [fx0, , fz0] = hull(0.3, -1, 0.6)
  const fx1 = fx0 + s.rx * -9 + s.fx * -6
  const fz1 = fz0 + s.rz * -9 + s.fz * -6
  strut(out.solid, dark, fx0, y + 0.3, fz0, fx1, y - 0.4, fz1, 0.7, SURF.bark)
  out.boxes.push(noStand(aabb((fx0 + fx1) / 2, y - 2, (fz0 + fz1) / 2,
    4.0, y + 0.6, 4.0)))

  if (!out.detailed) return
  // planks washed up around her
  for (let i = 0; i < 9; i++) {
    const u = (rng() - 0.5) * 16
    const v = (rng() - 0.5) * (len + 10)
    put(out.solid, BOX, rng() < 0.5 ? timber : pale, s.x(u, v), y - 0.3,
      s.z(u, v), (rng() - 0.5) * 0.2, rng() * 3, (rng() - 0.5) * 0.3,
      0.45, 0.2, 2.0 + rng() * 2.4, SURF.plank)
  }
}


/* ----------------------------------------------------------------- front -- */

const KITS: Record<
  Landmark['kind'], (out: BuildOut, lm: Landmark, y: number, rng: () => number) => void
> = { lighthouse, windmill, farm, mast, ruins, watertower, stones, cabin, wreck }

/**
 * Build whatever landmarks.ts put here. `y` is the ground under the site,
 * which for everything but a wreck is the flat pad terrain.ts graded for it,
 * so a kit may treat it as level out to `lm.r` and does.
 */
export const buildLandmark = (out: BuildOut, lm: Landmark, y: number) => {
  KITS[lm.kind](out, lm, y, seeded(lm.seed))
}
