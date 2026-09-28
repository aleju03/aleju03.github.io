import { noStand } from '../physics/collision'
import { seeded } from '../core/rand'
import { SURF, type SurfaceId } from './surface'
import {
  BALL, BOX, CONE12, CYL8, CYL12, DOME, GAMBREL, PRISM, SHED, TUBE12,
  aabb, box, fork, keepOut, nudge, panel, pick, put, roofSolids, shaft, strut, taper, type BuildOut,
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

/** a flat footprint the grass keeps out of, in the frame (snapped frames
    only, like `solidL`) */
const keepL = (out: BuildOut, s: Site, u: number, v: number, lu: number, lv: number) =>
  keepOut(out, s.x(u, v), s.z(u, v), s.ex(lu, lv) / 2, s.ez(lu, lv) / 2)

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
 * keeper's cottage tucked in behind, an oil store across the yard, a flag,
 * and a whitewashed wall closing the yard. The one structure out here that is
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
  // the gallery is a floor (the square inside its ring), the lantern a post
  // on it, and the lantern's cap a steep perch over that
  out.boxes.push(aabb(lm.x, y - 2, lm.z, r1 * 1.2, topY + 0.2, r1 * 1.2))
  out.boxes.push(noStand(aabb(lm.x, topY, lm.z, r1 * 0.7, topY + 3.4, r1 * 0.7)))
  roofSolids(out.boxes, PRISM, lm.x, topY + 3.45, lm.z, 0, 0.5, 1.9, r1 * 2.2)

  // the keeper's cottage, set back from the light and squared up to the world
  const c = site(lm, true)
  const cu = 7.5 * (rng() < 0.5 ? 1 : -1)
  const cv = -5.5
  const ch = 5.6
  boxL(out, c, WHITE, cu, cv, y + ch / 2 - 0.4, 8.4, ch + 0.8, 6.4, SURF.plaster)
  boxL(out, c, '#6f6a61', cu, cv, y + 0.35, 8.8, 0.9, 6.8, SURF.paving)
  put(out.solid, PRISM, '#54423a', c.x(cu, cv), y + ch - 0.05, c.z(cu, cv),
    0, c.face, 0, 9.0, 2.8, 6.9, SURF.shingle)
  roofSolids(out.boxes, PRISM, c.x(cu, cv), y + ch - 0.05, c.z(cu, cv), c.face, 9.0, 2.8, 6.9)
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
    keepL(out, c, cu * 0.45, cv + 4.6, Math.abs(cu) * 1.2, 1.8)
  }
  solidL(out, c, cu, cv, 8.4, 6.4, y - 2, y + ch, false, 0.2)

  // The station round them, which is what turns a tower and a house into a
  // light *station*: an oil store across the yard from the cottage, a flag
  // on a mast, and a low whitewashed wall closing the yard, with the cottage
  // itself standing in as the wall's back corner on its own side
  const side = Math.sign(cu)
  const ou = -side * 7.2
  const ov = -5.8
  boxL(out, c, WHITE, ou, ov, y + 1.6, 3.4, 3.6, 3.2, SURF.plaster)
  boxL(out, c, '#6f6a61', ou, ov, y + 0.25, 3.7, 0.5, 3.5, SURF.paving)
  put(out.solid, SHED, '#54423a', c.x(ou, ov), y + 3.35, c.z(ou, ov),
    0, c.face + Math.PI, 0, 3.9, 0.9, 3.7, SURF.shingle)
  roofSolids(out.boxes, SHED, c.x(ou, ov), y + 3.35, c.z(ou, ov), c.face + Math.PI, 3.9, 0.9, 3.7)
  solidL(out, c, ou, ov, 3.4, 3.2, y - 2, y + 3.35, false, 0.1)
  if (out.detailed) {
    const dr = fork(rng)
    port(out, c, ou, ov + 1.6, y + 1.5, 1.2, 2.5, 0, 1, false)
    boxL(out, c, '#3a2c1e', ou, ov + 1.66, y + 1.45, 1.1, 2.4, 0.12, SURF.plank)
    // a hood over the cottage door
    boxL(out, c, '#54423a', cu, cv + 3.9, y + 4.35, 2.6, 0.2, 1.3, SURF.plank)
    // the flag
    const fu = -side * 6.5
    const fv = 3.2
    shaft(out.solid, '#d8d2c4', c.x(fu, fv), y, c.z(fu, fv), 0.1, 9.5, 0.06, 6)
    boxL(out, c, dr() < 0.5 ? LAMP_RED : '#2f3b55', fu + 0.8, fv, y + 8.8, 1.5, 0.9, 0.05)
    out.boxes.push(noStand(aabb(c.x(fu, fv), y - 1, c.z(fu, fv), 0.2, y + 9.5, 0.2)))
    // the wall: along the front with a gate in it, down the open flank and
    // back to the oil store, and down the cottage's flank to its door
    const wall = (u0: number, v0: number, u1: number, v1: number) => {
      const lu = Math.abs(u1 - u0) + 0.5
      const lv = Math.abs(v1 - v0) + 0.5
      const mu = (u0 + u1) / 2
      const mv = (v0 + v1) / 2
      boxL(out, c, WHITE, mu, mv, y + 0.5, lu, 1.0, lv, SURF.plaster)
      boxL(out, c, '#b8b09e', mu, mv, y + 1.06, lu + 0.1, 0.12, lv + 0.1, SURF.paving)
      solidL(out, c, mu, mv, lu, lv, y - 1, y + 1.12, false, 0.05)
    }
    const fy = 6.5
    wall(-10.6, fy, -1.3, fy)
    wall(1.3, fy, 10.6, fy)
    wall(-side * 10.6, fy, -side * 10.6, ov)
    wall(side * 10.6, fy, side * 10.6, cv + 3.6)
    for (const q of [-1, 1]) {
      boxL(out, c, WHITE, q * 1.5, fy, y + 0.8, 0.8, 1.6, 0.8, SURF.plaster)
    }
  }
}

/* -------------------------------------------------------------- windmill -- */

/**
 * A tower mill, working. A tarred stone plinth under a whitewashed or bare
 * stone tower with a door, a lintel and a stone step at its foot and small
 * windows climbing it in a spiral, a grain store leaning on its back; a
 * reefing gallery round its waist on raking struts, where the miller stood
 * to set the cloth; and on top a boat-shaped cap on a curb, with the
 * windshaft coming out of the front of it and a fantail on a frame out the
 * back, the little wheel that turns the whole cap into the wind.
 *
 * The sails are the point of it and they are built the way real ones are:
 * two stocks through the poll end make four sails, each a whip with bars
 * across it and a hemlath along its outer edge, and on a mill that is
 * working the cloth is spread on two of them. They turn: the sails and the
 * poll end are stamped into the chunk's `rotor` builder rather than its
 * soup, which hangs them as one small mesh of their own spinning about the
 * windshaft (a draw and a quaternion a frame, for the one mill in sight),
 * each mill at its own pace off its site seed so two on a plain are never in
 * step. Where nothing ticks (no `rotor`), they are stamped into the soup at
 * the angle they stopped at.
 */
const windmill = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, false)
  const h = 12 + rng() * 4
  const r0 = 3.6
  const r1 = 2.4
  const body = rng() < 0.55 ? WHITE : '#9a9184'
  const stop = rng() * Math.PI / 2
  const clothOn = rng() < 0.7
  const dr = fork(rng)
  const rAt = (yy: number) => r0 + (r1 - r0) * Math.min(1, Math.max(0, (yy - y - 0.8) / h))

  // the plinth, tarred, and the tower on it
  shaft(out.solid, '#3f3a34', lm.x, y - 0.8, lm.z, r0 * 1.14, 2.2, r0 * 1.08, 12, 0, SURF.paving)
  shaft(out.solid, body, lm.x, y + 1.4, lm.z, r0 * 1.02, h - 0.6, r1, 12, 0, SURF.brick)
  const capY = y + 0.8 + h

  // the grain store leaning on its back: a lean-to under a monopitch
  const b = site(lm, true)
  const bu = 0
  const bv = -(r0 + 1.8)
  boxL(out, b, '#8a7a60', bu, bv, y + 2.0, 5.6, 4.0, 3.6, SURF.plank)
  put(out.solid, SHED, ROOF_DARK, b.x(bu, bv), y + 3.9, b.z(bu, bv), 0, b.face + Math.PI, 0,
    6.0, 1.6, 4.0, SURF.shingle)
  roofSolids(out.boxes, SHED, b.x(bu, bv), y + 3.9, b.z(bu, bv), b.face + Math.PI, 6.0, 1.6, 4.0)
  solidL(out, b, bu, bv, 5.6, 3.6, y - 1, y + 3.9, false, 0.1)

  // the reefing gallery on raking struts
  const stageY = y + 0.8 + h * 0.4
  const stageR = rAt(stageY) + 1.6
  shaft(out.solid, DARKWOOD, lm.x, stageY, lm.z, stageR, 0.26, stageR, 12, 0, SURF.plank)
  if (out.detailed) {
    railing(out, lm.x, stageY + 0.26, lm.z, stageR - 0.15, 1.1, DARKWOOD, 16)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2
      const rr = rAt(stageY - 2.6)
      strut(out.solid, DARKWOOD,
        lm.x + Math.cos(a) * rr, stageY - 2.6, lm.z + Math.sin(a) * rr,
        lm.x + Math.cos(a) * (stageR - 0.3), stageY, lm.z + Math.sin(a) * (stageR - 0.3), 0.2)
    }
  }

  // the cap: a curb ring, and the boat-shaped hood along the windshaft
  put(out.solid, TUBE12, DARKWOOD, lm.x, capY + 0.2, lm.z, 0, 0, 0, r1 * 2.3, 0.4, r1 * 2.3)
  put(out.solid, DOME, ROOF_DARK, lm.x - s.fx * 0.3, capY + 0.35, lm.z - s.fz * 0.3,
    0, s.face, 0, r1 * 2.2, r1 * 1.7, r1 * 3.1, SURF.shingle)
  put(out.solid, BALL, '#c8ac63', lm.x, capY + 0.35 + r1 * 1.7, lm.z, 0, 0, 0, 0.4, 0.4, 0.4)

  // the windshaft, tipped up a little, and the poll end on it
  const hubOut = r1 * 1.55
  const hx = lm.x + s.fx * hubOut
  const hz = lm.z + s.fz * hubOut
  const hy = capY + r1 * 0.75
  put(out.solid, CYL12, DARKWOOD, lm.x + s.fx * hubOut * 0.6, hy - 0.15, lm.z + s.fz * hubOut * 0.6,
    Math.PI / 2 - 0.12, s.face, 0, 0.8, hubOut * 1.3, 0.8)
  // the sails and the poll end turn together about the windshaft
  const rate = -(0.28 + ((lm.seed >>> 3) % 97) / 97 * 0.22)
  const sail = out.rotor?.(hx, hy, hz, s.fx, 0, s.fz, rate) ?? out.solid
  put(sail, BOX, '#3a322a', hx, hy, hz, 0, s.face, stop, 1.4, 1.4, 1.2)

  // the fantail out the back: a frame, and a six-bladed wheel on it
  const tx = lm.x - s.fx * (r1 * 2.2)
  const tz = lm.z - s.fz * (r1 * 2.2)
  const ty = capY + r1 * 1.1
  for (const q of [-1, 1]) {
    strut(out.solid, DARKWOOD, lm.x - s.fx * r1 * 0.9 + s.rx * q * 0.8, capY + 0.4,
      lm.z - s.fz * r1 * 0.9 + s.rz * q * 0.8, tx, ty, tz, 0.16)
  }
  if (out.detailed) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      put(out.solid, BOX, i % 2 ? '#d8cfb8' : TIMBER,
        tx + s.fx * Math.cos(a) * 0.7, ty + Math.sin(a) * 0.7, tz + s.fz * Math.cos(a) * 0.7,
        0, s.face + Math.PI / 2, Math.PI / 2 - a, 0.5, 1.4, 0.06)
    }
  }

  // the sails
  const L = Math.min(h - 1.5, 11.5)
  const sw = 2.3
  for (let k = 0; k < 4; k++) {
    const th = stop + (k / 4) * Math.PI * 2
    const dx = s.rx * Math.sin(th)
    const dz = s.rz * Math.sin(th)
    const dy = Math.cos(th)
    // across the sail, in its plane: the side the cloth is spread to
    const px = s.rx * Math.cos(th)
    const pz = s.rz * Math.cos(th)
    const py = -Math.sin(th)
    const at = (t: number, o: number, n = 0.2) => [
      hx + dx * t + px * o + s.fx * n, hy + dy * t + py * o, hz + dz * t + pz * o + s.fz * n,
    ] as const
    const [wx, wy, wz] = at(L / 2, 0)
    put(sail, BOX, DARKWOOD, wx, wy, wz, 0, s.face, -th, 0.36, L, 0.5, SURF.plank)
    const t0 = L * 0.22
    const [cx, cy, cz] = at((t0 + L) / 2, sw / 2 + 0.1, 0.12)
    if (clothOn && k % 2 === 0) {
      put(sail, BOX, '#d8cfb8', cx, cy, cz, 0, s.face, -th, sw, L - t0, 0.05)
    }
    if (!out.detailed) continue
    // the hemlath along the outer edge and the bars across
    const [ex, ey, ez] = at((t0 + L) / 2, sw + 0.1)
    put(sail, BOX, TIMBER, ex, ey, ez, 0, s.face, -th, 0.14, L - t0, 0.14, SURF.plank)
    for (let t = t0; t <= L + 1e-6; t += (L - t0) / 9) {
      const [bx, by, bz] = at(t, sw / 2 + 0.05)
      put(sail, BOX, TIMBER, bx, by, bz, 0, s.face, -th, sw + 0.2, 0.09, 0.1, SURF.plank)
    }
    // a leading board on the whip's other side
    const [lx, ly, lz] = at((t0 + L) / 2, -0.45)
    put(sail, BOX, TIMBER, lx, ly, lz, 0, s.face, -th, 0.5, L - t0, 0.06, SURF.plank)
  }

  if (out.detailed) {
    // the door at the foot, its step, and the windows climbing the tower
    port(out, s, 0, r0 * 0.96, y + 2.6, 1.7, 3.6, 0, 1, false)
    boxL(out, s, '#3a2c1e', 0, r0 * 1.02, y + 2.5, 1.6, 3.4, 0.16, SURF.plank)
    boxL(out, s, '#8b867c', 0, r0 + 0.9, y + 0.15, 2.8, 0.3, 1.4, SURF.paving)
    for (let i = 0; i < 5; i++) {
      const a = s.face + 1.1 + i * 1.35
      const wy = y + 4.2 + i * (h - 5) / 5
      if (Math.abs(wy - stageY) < 1.2) continue
      const rr = rAt(wy) + 0.02
      const nx = Math.sin(a)
      const nz = Math.cos(a)
      box(out.solid, '#d8d2c4', lm.x + nx * rr, wy, lm.z + nz * rr, 1.1, 1.5, 0.2, a, SURF.plaster)
      panel(out.solid, '#28323a', lm.x + nx * (rr + 0.12), wy, lm.z + nz * (rr + 0.12),
        0.8, 1.2, a)
      if (dr() < 0.4) {
        panel(out.glass, LIT, lm.x + nx * (rr + 0.16), wy, lm.z + nz * (rr + 0.16), 0.8, 1.2, a)
      }
    }
    // a spare millstone against the wall, and sacks by the door
    const ma = s.face + 0.7
    put(out.solid, CYL12, '#9a948a', lm.x + Math.sin(ma) * (r0 + 0.5), y + 1.3,
      lm.z + Math.cos(ma) * (r0 + 0.5), 0.2, ma, Math.PI / 2, 2.6, 0.5, 2.6, SURF.paving)
    for (let i = 0; i < 3; i++) {
      put(out.solid, BALL, '#b8a888', s.x(-1.9 - i * 0.7, r0 + 0.8), y + 0.45,
        s.z(-1.9 - i * 0.7, r0 + 0.8), 0, dr() * 3, 0, 0.8, 0.9, 0.7)
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
  roofSolids(out.boxes, GAMBREL, s.x(bu, bv), y + bh - 0.05, s.z(bu, bv), s.face,
    bw * 1.05, bd * 0.52, bd * 1.08)
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
  roofSolids(out.boxes, PRISM, s.x(hu, hv), y + fh - 0.05, s.z(hu, hv), s.face, 9.4, 3.4, 7.8)
  boxL(out, s, '#41372f', hu + 3.0, hv - 2.0, y + fh + 3.6, 0.9, 3.2, 0.9, SURF.brick)
  if (out.detailed) {
    // a porch across the front, because a farmhouse always has one
    boxL(out, s, '#8b867c', hu, hv + 4.6, y + 0.2, 8.0, 0.4, 2.6, SURF.paving)
    boxL(out, s, '#4a3c33', hu, hv + 4.6, y + 5.4, 8.4, 0.26, 3.0, SURF.plank)
    for (const q of [-1, 1]) {
      boxL(out, s, '#cfc7b4', hu + q * 3.4, hv + 5.6, y + 2.8, 0.22, 5.2, 0.22)
    }
    solidL(out, s, hu, hv + 4.6, 8.0, 2.6, y - 1, y + 0.4, true)
    keepL(out, s, hu, hv + 4.6, 8.2, 2.8)
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
    roofSolids(out.boxes, SHED, s.x(hu, 0), y + 3.2, s.z(hu, 0), s.face, 4.7, 0.6, 3.7)
    boxL(out, s, '#4a4640', hu, 1.75, y + 1.4, 1.2, 2.6, 0.14, SURF.panel)
    boxL(out, s, METAL, hu - 1.5, 1.75, y + 2.6, 1.0, 0.7, 0.14, SURF.panel)
    solidL(out, s, hu, 0, 4.4, 3.4, y - 1, y + 3.2, false, 0.15)
  }
  out.boxes.push(noStand(aabb(lm.x, y - 1, lm.z, rBase + 0.4, y + h, rBase + 0.4)))
}

/* ---------------------------------------------------------------- ruins -- */

/**
 * What is left of a church: the story a ruin needs is *what it was*, and a
 * rectangle of broken wall of even height never told it. So this is an abbey
 * with its roof gone. The west front still stands to its gable, a doorway at
 * the foot and a tall lancet over it you can see the sky through; the nave's
 * side walls run back from it as piers with the window openings between
 * them, falling away toward the east end where the apse is a ring of stubs;
 * a bell tower at one front corner has lost its top; the altar is where an
 * altar goes, at the far end under where the east window was; and a few
 * rafters still lean from the wall heads onto the floor, with ivy on the
 * stone and graves in the grass round it. Low stubs register standable,
 * because a ruin you can climb about on is worth three you can only walk
 * around.
 */
const ruins = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, true)
  const stone = rng() < 0.5 ? OLDSTONE : '#a89c86'
  const dark = '#7d766a'
  /** half the nave's width, and half its length */
  const hw = 4.2 + rng() * 1.0
  const hl = 6.4 + rng() * 1.6
  /** the whole plan is shifted forward so the apse fits the pad too */
  const vc = hw * 0.45
  const front = hl + vc
  const back = -hl + vc
  const wallH = 7.6 + rng() * 1.2
  const gable = rng() < 0.7
  const towerS = rng() < 0.5 ? 1 : -1
  const towerH = 10 + rng() * 3.5
  const dr = fork(rng)

  /** a standing piece of wall, collided as what it is */
  const piece = (u: number, v: number, lu: number, lv: number, y0: number, y1: number) => {
    boxL(out, s, stone, u, v, (y0 + y1) / 2, lu, y1 - y0, lv, SURF.brick)
    if (y0 < y + 0.5) solidL(out, s, u, v, lu, lv, y - 1, y1, y1 - y < 1.7, 0.05)
  }

  // the west front: two leaves of wall either side of a centre strip, which
  // holds the doorway, a lintel, a lancet opening and the gable over it all
  const t = 0.9
  const cw = 3.2
  for (const q of [-1, 1]) {
    piece(q * (hw + cw / 2) / 2, front, hw - cw / 2, t, y, y + wallH)
  }
  piece(0, front, cw, t, y + 4.6, y + 5.6)
  for (const q of [-1, 1]) piece(q * 1.15, front, 0.9, t, y + 5.6, y + wallH)
  if (gable) {
    put(out.solid, PRISM, stone, s.x(0, front), y + wallH, s.z(0, front),
      0, s.face, 0, hw * 2, hw * 0.95, t, SURF.brick)
    // a cross on the apex, the one thing that says what this was from afar
    boxL(out, s, dark, 0, front, y + wallH + hw * 0.95 + 0.8, 0.3, 1.6, 0.3)
    boxL(out, s, dark, 0, front, y + wallH + hw * 0.95 + 1.1, 1.1, 0.3, 0.3)
  } else {
    // ...or the gable is down, and the wall head steps where it broke
    piece(-hw * 0.5, front, hw, t, y + wallH, y + wallH + 1.4)
    piece(-hw * 0.7, front, hw * 0.5, t, y + wallH + 1.4, y + wallH + 2.3)
  }
  // the jambs of the door stand proud of the front, the way a portal does
  for (const q of [-1, 1]) {
    boxL(out, s, dark, q * 1.25, front + 0.55, y + 2.4, 0.6, 4.8, 0.3, SURF.brick)
  }

  // the side walls: a pier every bay with a low sill between, gnawed
  // lower toward the east, the odd bay gone altogether
  const bays = Math.max(3, Math.round((hl * 2) / 3.2))
  const bay = (hl * 2) / bays
  for (const q of [-1, 1]) {
    const u = q * hw
    for (let i = 0; i < bays; i++) {
      const v0 = front - i * bay
      const decay = 1 - (i / bays) * (0.55 + rng() * 0.3)
      if (i > 0 && rng() < 0.16) continue
      const ph = Math.max(1.0, wallH * decay * (0.8 + rng() * 0.3))
      piece(u, v0 - 0.55, t, 1.1, y, y + ph)
      // the sill, and the window's head where the pier is tall enough
      piece(u, v0 - bay / 2 - 0.3, t, bay - 1.1, y, y + 1.6 + rng() * 0.6)
      if (ph > 6.2) piece(u, v0 - bay / 2 - 0.3, t, bay - 1.1, y + 5.2, y + ph - 0.2)
    }
  }

  // the apse: a half ring of stubs round the east end
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI
    const u = Math.cos(a) * hw * 0.9
    const v = back - Math.sin(a) * hw * 0.9
    const ph = 0.9 + rng() * 2.6
    boxL(out, s, stone, u, v, y + ph / 2, 1.5, ph, 1.5, SURF.brick)
    solidL(out, s, u, v, 1.5, 1.5, y - 1, y + ph, ph < 1.7, 0.05)
  }

  // the tower at a front corner, its top broken off unevenly
  const tu = towerS * (hw + 1.6)
  const tv = front - 2.0
  boxL(out, s, stone, tu, tv, y + towerH / 2, 3.6, towerH, 3.6, SURF.brick)
  boxL(out, s, stone, tu - towerS * 0.8, tv + 0.6, y + towerH + 0.9, 2.0, 1.8, 2.4, SURF.brick)
  boxL(out, s, stone, tu + towerS * 0.9, tv - 0.9, y + towerH + 0.4, 1.8, 0.8, 1.8, SURF.brick)
  solidL(out, s, tu, tv, 3.6, 3.6, y - 1, y + towerH)

  // the altar at the east end, the one thing in here you are meant to stand on
  const av = back + 1.8
  boxL(out, s, stone, 0, av, y + 0.35, 3.2, 0.7, 2.0, SURF.paving)
  boxL(out, s, '#b5ac9b', 0, av, y + 0.82, 3.6, 0.26, 2.4, SURF.paving)
  solidL(out, s, 0, av, 3.6, 2.4, y - 1, y + 0.95, true)

  if (out.detailed) {
    // the belfry's slit windows, dark, and the lancet's frame over the door
    for (const q of [-1, 1]) {
      panelL(out, s, 'solid', '#28303a', tu, tv + 1.8, y + towerH - 2.4 - q * 2.5, 0.5, 1.8, 0, 1)
    }
    // the floor it all stood on, still just about readable through the grass,
    // with an aisle of paler slabs up the middle
    boxL(out, s, '#93897a', 0, vc, y + 0.03, hw * 2, 0.08, hl * 2, SURF.paving)
    boxL(out, s, '#a49a88', 0, vc, y + 0.06, 1.8, 0.08, hl * 2 - 1, SURF.paving)
    // rafters that came down with the roof, leaning from a wall head
    for (let i = 0; i < 3; i++) {
      if (dr() < 0.3) continue
      const q = dr() < 0.5 ? 1 : -1
      const v = front - (1.5 + dr() * (hl * 0.8))
      strut(out.solid, DARKWOOD,
        s.x(q * (hw - 0.6), v), y + 3.6 + dr() * 1.5, s.z(q * (hw - 0.6), v),
        s.x(-q * (hw * 0.2), v + (dr() - 0.5) * 2), y + 0.2, s.z(-q * (hw * 0.2), v),
        0.36)
    }
    // ivy climbing the stone in a few places
    for (let i = 0; i < 6; i++) {
      const q = dr() < 0.5 ? 1 : -1
      const v = front - dr() * hl * 1.6
      const ih = 1.5 + dr() * 3.5
      boxL(out, s, dr() < 0.5 ? '#48673a' : '#3d5a33', q * (hw + 0.5), v, y + ih / 2,
        0.12, ih, 1.2 + dr() * 1.6)
    }
    // rubble, thickest where the walls came down
    for (let i = 0; i < 12; i++) {
      const u = (dr() - 0.5) * hw * 2.6
      const v = vc + (dr() - 0.5) * hl * 2.4
      const r = 0.3 + dr() * 0.6
      put(out.solid, BOX, stone, s.x(u, v), y + r * 0.4, s.z(u, v),
        (dr() - 0.5) * 0.5, dr() * 3, (dr() - 0.5) * 0.5, r * 2, r, r * 1.6,
        SURF.paving)
    }
    // and the graves: a scatter of headstones in the grass, leaning
    for (let i = 0; i < 7; i++) {
      const q = dr() < 0.5 ? 1 : -1
      const u = q * (hw + 3 + dr() * 2.5)
      const v = vc + (dr() - 0.5) * hl * 1.6
      if (Math.abs(u - tu) < 3 && Math.abs(v - tv) < 3) continue
      const gh = 0.8 + dr() * 0.7
      put(out.solid, BOX, '#9a948a', s.x(u, v), y + gh / 2 - 0.1, s.z(u, v),
        (dr() - 0.5) * 0.3, s.face + Math.PI / 2 + (dr() - 0.5) * 0.3, 0,
        0.7, gh, 0.22, SURF.paving)
    }
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
 * A henge, four thousand years on. The outer circle was uprights capped by a
 * continuous ring of lintels; what is left is runs of it still capped where
 * neighbours both stand, stones leaning where the ground gave, stones flat on
 * their backs where it gave way, stumps where they were broken up for
 * building, and a lintel or two lying in the grass under the gap it fell
 * from. Inside, a horseshoe of great trilithons opens toward the heel stone
 * standing alone outside the ring on the same axis, with one of the three
 * down and its lintel beside it, and the altar stone flat in the middle.
 *
 * Every stone is its own grey, a few percent either way, with lichen on
 * some, and they taper, because a box of uniform colour at uniform height
 * reads as a fence and the one thing this has to read as is *old*. Cheap,
 * silent and older than everything around it: not a building, evidence.
 */
const stones = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const n = 14 + Math.floor(rng() * 5)
  const rad = 9 + rng() * 2.5
  const grey = pick(['#8d867a', '#7d786e', '#9a9184', '#84806f'], rng())
  const H = 5.6 + rng() * 0.6
  const dr = fork(rng)
  /** a slightly tapered block: sarsens were dressed, but never square */
  const TAPER = taper(0.82, 4)
  const stoneAt = (
    x: number, cy: number, z: number, rx: number, ry: number, rz: number,
    w: number, h: number, t: number, hex: string,
  ) => put(out.solid, TAPER, hex, x, cy, z, rx, ry + Math.PI / 4, rz, w * 1.414, h, t * 1.414,
    SURF.paving)

  type State = 'up' | 'lean' | 'down' | 'stump' | 'gone'
  const states: State[] = []
  for (let i = 0; i < n; i++) {
    const r = rng()
    states.push(r < 0.5 ? 'up' : r < 0.66 ? 'lean' : r < 0.8 ? 'down' : r < 0.92 ? 'stump' : 'gone')
  }
  const pos = (i: number) => {
    const a = (i / n) * Math.PI * 2 + lm.face
    return [lm.x + Math.cos(a) * rad, lm.z + Math.sin(a) * rad, a] as const
  }

  for (let i = 0; i < n; i++) {
    const [px, pz, a] = pos(i)
    const tone = nudge(grey, 0.88 + rng() * 0.24)
    const w = 2.0 + rng() * 0.6
    const t = 1.0 + rng() * 0.3
    // a stone's face is square to the ring: its width runs along the tangent
    const yaw = Math.PI / 2 - a
    const st = states[i]
    if (st === 'gone') continue
    if (st === 'stump') {
      const h = 0.8 + rng() * 1.0
      stoneAt(px, y + h / 2 - 0.2, pz, (rng() - 0.5) * 0.2, yaw, (rng() - 0.5) * 0.2, w, h, t, tone)
      out.boxes.push(aabb(px, y - 1, pz, w * 0.55, y + h - 0.2, w * 0.55))
      continue
    }
    if (st === 'down') {
      // flat on its back, fallen outward, its foot still by its socket
      const h = H + rng() * 0.6
      const ox = Math.cos(a) * (h / 2)
      const oz = Math.sin(a) * (h / 2)
      put(out.solid, BOX, tone, px + ox, y + t * 0.4, pz + oz,
        Math.PI / 2, yaw + (rng() - 0.5) * 0.3, 0, w, h, t, SURF.paving)
      out.boxes.push(aabb(px + ox, y - 1, pz + oz, h * 0.45, y + t * 0.8, h * 0.45))
      continue
    }
    const h = H + (rng() - 0.5) * 0.4
    // canted: a little if it stands, a lot if the ground under it gave
    const cant = st === 'lean' ? (0.22 + rng() * 0.25) * (rng() < 0.5 ? 1 : -1) : (rng() - 0.5) * 0.08
    stoneAt(px + Math.cos(a) * cant * h * 0.5, y + h / 2 - 0.3, pz + Math.sin(a) * cant * h * 0.5,
      cant, yaw, (rng() - 0.5) * 0.06, w, h, t, tone)
    out.boxes.push(noStand(aabb(px, y - 1, pz, w * 0.6, y + h - 0.3, w * 0.6)))
    if (out.detailed && dr() < 0.45) {
      // lichen, a pale crust on the weather side
      const lx = px - Math.cos(a) * (t * 0.52)
      const lz = pz - Math.sin(a) * (t * 0.52)
      box(out.solid, dr() < 0.5 ? '#a8ae84' : '#b8a86a', lx, y + 1.2 + dr() * (h - 2.4), lz,
        w * (0.3 + dr() * 0.3), 0.6 + dr() * 0.9, 0.06, yaw, SURF.none)
    }
  }

  // the lintels, wherever two neighbours both still stand upright; and under
  // one gap, the lintel that came down with it
  let fell = false
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const [px, pz] = pos(i)
    const [qx, qz] = pos(j)
    const span = Math.hypot(qx - px, qz - pz)
    const yawL = Math.atan2(qx - px, qz - pz)
    if (states[i] === 'up' && states[j] === 'up') {
      put(out.solid, BOX, nudge(grey, 0.92 + rng() * 0.12), (px + qx) / 2, y + H + 0.1,
        (pz + qz) / 2, 0, yawL, 0, 1.1, 0.9, span + 0.9, SURF.paving)
    } else if (!fell && (states[i] !== 'up' || states[j] !== 'up') && rng() < 0.4) {
      fell = true
      const [mx, mz] = [(px + qx) / 2, (pz + qz) / 2]
      const ix = lm.x + (mx - lm.x) * 0.8
      const iz = lm.z + (mz - lm.z) * 0.8
      put(out.solid, BOX, grey, ix, y + 0.35, iz, 0.08, yawL + 0.5, 0.1, 1.1, 0.9, span, SURF.paving)
      out.boxes.push(aabb(ix, y - 1, iz, span * 0.45, y + 0.8, span * 0.45))
    }
  }

  // the horseshoe of trilithons, opening toward the heel stone
  const tri = [-0.9, 0, 0.9]
  const downIdx = Math.floor(rng() * 3)
  for (let k = 0; k < tri.length; k++) {
    const a = lm.face + Math.PI + tri[k]
    const r = rad * 0.52
    const cx = lm.x + Math.cos(a) * r
    const cz = lm.z + Math.sin(a) * r
    const yaw = Math.PI / 2 - a
    const th = H + 1.8 + (k === 1 ? 1.2 : 0)
    const tx = -Math.sin(a)
    const tz = Math.cos(a)
    const tone = nudge(grey, 0.9 + rng() * 0.18)
    if (k === downIdx) {
      // one leg still up but leaning hard, the other and the lintel down
      stoneAt(cx - tx * 1.5, y + th / 2 - 0.4, cz - tz * 1.5, 0.35, yaw, 0.1, 2.2, th, 1.3, tone)
      out.boxes.push(noStand(aabb(cx - tx * 1.5, y - 1, cz - tz * 1.5, 1.4, y + th, 1.4)))
      put(out.solid, BOX, tone, cx + tx * 1.5 + Math.cos(a) * 2, y + 0.6, cz + tz * 1.5 + Math.sin(a) * 2,
        Math.PI / 2, yaw + 0.4, 0, 2.2, th, 1.3, SURF.paving)
      put(out.solid, BOX, tone, cx - Math.cos(a) * 2.5, y + 0.45, cz - Math.sin(a) * 2.5,
        0.1, yaw + 0.2, 0, 5.4, 1.0, 1.3, SURF.paving)
      out.boxes.push(aabb(cx + Math.cos(a) * 1.5, y - 1, cz + Math.sin(a) * 1.5, 3.4, y + 1.2, 3.4))
      continue
    }
    for (const q of [-1, 1]) {
      stoneAt(cx + tx * q * 1.5, y + th / 2 - 0.3, cz + tz * q * 1.5, (rng() - 0.5) * 0.06, yaw,
        (rng() - 0.5) * 0.06, 2.2, th, 1.3, tone)
      out.boxes.push(noStand(aabb(cx + tx * q * 1.5, y - 1, cz + tz * q * 1.5, 1.4, y + th, 1.4)))
    }
    put(out.solid, BOX, tone, cx, y + th - 0.1, cz, 0, yaw, 0, 5.6, 1.1, 1.4, SURF.paving)
  }

  // the heel stone, alone outside the ring on the axis, leaning in
  {
    const a = lm.face
    const r = rad + 6.5
    const hx = lm.x + Math.cos(a) * r
    const hz = lm.z + Math.sin(a) * r
    stoneAt(hx, y + 2.6, hz, -0.18, Math.PI / 2 - a, 0.05, 2.8, 5.6, 2.0, nudge(grey, 0.85))
    out.boxes.push(noStand(aabb(hx, y - 1, hz, 1.8, y + 5.2, 1.8)))
  }

  // the altar stone at the centre, flat enough to stand on
  put(out.solid, BOX, nudge(grey, 1.08), lm.x, y + 0.3, lm.z, 0, lm.face + 0.3, 0,
    3.8, 0.6, 1.6, SURF.paving)
  out.boxes.push(aabb(lm.x, y - 1, lm.z, 1.9, y + 0.6, 1.9))
  if (out.detailed) {
    for (let i = 0; i < 10; i++) {
      const a = dr() * Math.PI * 2
      const r = rad * (0.3 + dr() * 0.9)
      const sc = 0.3 + dr() * 0.4
      put(out.solid, BOX, grey, lm.x + Math.cos(a) * r, y + sc * 0.35,
        lm.z + Math.sin(a) * r, (dr() - 0.5) * 0.4, dr() * 3, (dr() - 0.5) * 0.4,
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
  // the gable ends filled in above the walls, as a prism tucked just inside
  // the roof: this was a box, and its top corners stood out through both
  // slopes as a second little roof sitting on the first
  const gY = y + 0.6 + wallH
  const rise = hv * 1.05
  put(out.solid, PRISM, log, s.x(0, 0), gY - 0.12, s.z(0, 0),
    0, s.face + Math.PI / 2, 0, hv * 2 - 0.2, rise * 0.94, hu * 2 - 0.2, SURF.bark)
  put(out.solid, PRISM, ROOF_DARK, s.x(0, 0), gY - 0.1, s.z(0, 0),
    0, s.face + Math.PI / 2, 0, hv * 2.3, rise, hu * 2.4, SURF.plank)
  roofSolids(out.boxes, PRISM, s.x(0, 0), gY - 0.1, s.z(0, 0), s.face + Math.PI / 2,
    hv * 2.3, rise, hu * 2.4)
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
    keepL(out, s, 0, hv + 1.5, hu * 2 + 0.2, 3.2)
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
 * A ship on her side on the beach. What reads as a wreck at a glance is a
 * *hull with holes in it*, so she is built as a surface: `hull(t, q, k)`
 * gives every point on it (stern to bow, which side, keel to sheer), laid
 * over about the keel by the angle she settled at, so one flank is in the
 * sand and the other faces the sky. The frames are struts up that surface and
 * the planking is strakes along it; the buried flank keeps its boards, the
 * one in the air is stove in amidships so her ribs show through, and a few
 * deck beams still cross her. Her mast is a stump stepped on the keel, snapped
 * off, with the rest of it and its yard lying in the sand on the side she went
 * down; the bowsprit is broken short, the rudder hangs off the sternpost,
 * and what she carried is strewn along the tide line: barrels, a crate, a
 * coil of rope, an anchor, loose planks.
 *
 * It grades nothing, because a beach flattened under a wreck reads as a car
 * park with a boat parked on it, so the frames take the sand as they find it.
 */
const wreck = (out: BuildOut, lm: Landmark, y: number, rng: () => number) => {
  const s = site(lm, true)
  const len = 22 + rng() * 9
  const beam = 7.2
  const ribH = 5.6
  /** how far over she lies, and which flank went into the sand */
  const roll = 0.8 + rng() * 0.35
  const lie = rng() < 0.5 ? 1 : -1
  const stove = 0.28 + rng() * 0.22
  const timber = pick(['#5f5344', '#6b5a44', '#544a3e'], rng())
  const pale = '#7a6c5a'
  const dark = '#463c30'
  const dr = fork(rng)
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)

  /** the keel: stern settled into the sand, bow lifted clear of it */
  const keelY = (t: number) => y - 0.25 + t * 1.5
  /** a point on the hull in the site's frame, before the site maps it */
  const local = (t: number, q: number, k: number) => {
    const taper = Math.sin(t * Math.PI) * 0.72 + 0.28
    // the sheer: bow and stern stand higher than the waist
    const sheer = (Math.abs(t - 0.5) * 2) ** 2 * 1.4
    const h0 = (ribH * taper + sheer) * k
    const u0 = q * beam * 0.5 * taper * Math.sin(k * Math.PI * 0.5)
    return {
      u: u0 * cr + lie * h0 * sr,
      h: h0 * cr - lie * u0 * sr,
      v: (t - 0.5) * len,
    }
  }
  const hull = (t: number, q: number, k: number) => {
    const p = local(t, q, k)
    return [s.x(p.u, p.v), keelY(t) + p.h, s.z(p.u, p.v)] as const
  }
  /** a timber between two hull points, left out if it is wholly in the sand */
  const member = (
    a: readonly [number, number, number], b: readonly [number, number, number],
    hex: string, t: number, across?: number,
  ) => {
    if (a[1] < y - 0.5 && b[1] < y - 0.5) return
    strut(out.solid, hex, a[0], a[1], a[2], b[0], b[1], b[2], t, SURF.plank, across ?? t)
  }

  const N = 10
  for (let i = 0; i < N; i++) {
    const a = hull(i / N, 0, 0)
    const b = hull((i + 1) / N, 0, 0)
    member(a, b, dark, 1.1)
    // walkable along the spine, which is the whole reason to put one of these
    // on a beach the player can reach
    out.boxes.push(aabb((a[0] + b[0]) / 2, y - 2, (a[2] + b[2]) / 2,
      1.4, (a[1] + b[1]) / 2 + 0.6, 1.4))
  }

  // the frames, three segments each so they curve out of the keel
  for (let i = 1; i < N; i++) {
    const t = i / N
    for (const q of [-1, 1]) {
      if (rng() < 0.08) continue
      for (const [k0, k1] of [[0, 0.4], [0.4, 0.75], [0.75, 1]]) {
        member(hull(t, q, k0), hull(t, q, k1), timber, 0.36)
      }
    }
  }

  // the planking: the flank in the sand keeps its boards; the one in the air
  // is stove in amidships and has lost every other board besides, which is
  // the look: a hull open to the weather for decades
  for (const q of [-1, 1])
    for (const k of [0.12, 0.3, 0.48, 0.66, 0.84, 0.98]) {
      for (let i = 0; i < N; i++) {
        const t0 = i / N
        const t1 = (i + 1) / N
        if (t0 < 0.03 || t1 > 0.97) continue
        const up = q === -lie
        if (up && k > 0.2 && t0 > stove && t0 < stove + 0.38) continue
        if (rng() < (up ? 0.22 : 0.06)) continue
        member(hull(t0, q, k), hull(t1, q, k), (i + Math.round(k * 10)) % 2 ? timber : pale,
          0.62, 0.62)
      }
    }
  // a few deck beams still spanning her, and a strip of the foredeck on them
  for (let i = 2; i < N - 1; i += 2) {
    if (rng() < 0.3) continue
    member(hull(i / N, -1, 0.96), hull(i / N, 1, 0.96), dark, 0.4)
  }
  for (const q of [-0.5, 0, 0.5]) {
    member(hull(0.72, q, 0.97), hull(0.92, q, 0.97), pale, 0.18, 1.1)
  }

  // the stern: a transom, the sternpost and the rudder hanging off it
  for (const k of [0.3, 0.6, 0.9]) member(hull(0.03, -1, k), hull(0.03, 1, k), pale, 0.55)
  member(hull(0.0, 0, 0), hull(0.02, 0, 1.1), dark, 0.6)
  {
    const a = hull(0.0, 0, 0.1)
    const b = hull(0.0, 0, 0.8)
    const back = -1.2
    strut(out.solid, dark, a[0] + s.fx * back, a[1], a[2] + s.fz * back,
      b[0] + s.fx * back, b[1], b[2] + s.fz * back, 0.3, SURF.plank, 1.8)
  }
  // the stem, and the bowsprit broken short
  member(hull(0.99, 0, 0), hull(0.94, 0, 1.2), dark, 0.7)
  {
    const [bx, by, bz] = hull(0.97, 0, 1.1)
    const e = local(0.97, 0, 1.1)
    strut(out.solid, dark, bx, by, bz, s.x(e.u, e.v + 5.5), keelY(0.97) + e.h + 1.6,
      s.z(e.u, e.v + 5.5), 0.45)
  }

  // the mast: a stump stepped on the keel, square to the deck she lies on,
  // snapped off; the rest of it and its yard lie in the sand on her low side
  const mt = 0.58
  const [mx, my, mz] = hull(mt, 0, 0)
  const mdir = local(mt, 0, 1)
  const md = Math.hypot(mdir.u, mdir.h)
  const ux = (mdir.u / md) * 7.2
  const uy = (mdir.h / md) * 7.2
  const topX = s.x(ux, (mt - 0.5) * len)
  const topZ = s.z(ux, (mt - 0.5) * len)
  strut(out.solid, dark, mx, my, mz, topX, my + uy, topZ, 0.8, SURF.bark)
  // the splintered top of the stump, two slivers at odd angles
  for (const q of [-1, 1]) {
    strut(out.solid, pale, topX, my + uy, topZ,
      topX + s.fx * q * 0.3 + s.rx * 0.2, my + uy + 1.1, topZ + s.fz * q * 0.3 + s.rz * 0.2, 0.22)
  }
  const fu = lie * (ribH * sr + 3.2)
  const fv0 = (mt - 0.5) * len
  const fx0 = s.x(fu, fv0)
  const fz0 = s.z(fu, fv0)
  const fx1 = s.x(fu + lie * 3.5, fv0 - 13)
  const fz1 = s.z(fu + lie * 3.5, fv0 - 13)
  strut(out.solid, dark, fx0, y + 0.35, fz0, fx1, y + 0.1, fz1, 0.7, SURF.bark)
  out.boxes.push(noStand(aabb((fx0 + fx1) / 2, y - 2, (fz0 + fz1) / 2,
    Math.abs(fx1 - fx0) / 2 + 0.5, y + 0.8, Math.abs(fz1 - fz0) / 2 + 0.5)))
  {
    const yu = fu + lie * 2.0
    const yv = fv0 - 6
    strut(out.solid, timber, s.x(yu - 4.5, yv - 0.8), y + 0.25, s.z(yu - 4.5, yv - 0.8),
      s.x(yu + 4.5, yv + 0.8), y + 0.3, s.z(yu + 4.5, yv + 0.8), 0.4, SURF.bark)
  }

  if (!out.detailed) return
  // what she carried, strewn along the tide line
  const side = -lie
  for (let i = 0; i < 4; i++) {
    const u = side * (4 + dr() * 5)
    const v = (dr() - 0.5) * len
    const upright = dr() < 0.5
    put(out.solid, CYL8, pick(['#6b5a44', '#5a4a38'], dr()), s.x(u, v), y + (upright ? 0.9 : 0.7),
      s.z(u, v), upright ? 0 : Math.PI / 2, dr() * 3, 0, 1.4, 1.8, 1.4, SURF.plank)
    out.boxes.push(noStand(aabb(s.x(u, v), y - 1, s.z(u, v), 0.8, y + 1.6, 0.8)))
  }
  {
    const u = side * 6.5
    const v = len * 0.3
    put(out.solid, BOX, '#6f6252', s.x(u, v), y + 0.6, s.z(u, v), 0.15, 0.6, 0.1,
      1.6, 1.3, 1.6, SURF.plank)
    put(out.solid, TUBE12, '#8a7a5a', s.x(u + 2.2, v - 1.5), y + 0.12, s.z(u + 2.2, v - 1.5),
      0, 0, 0, 1.8, 0.24, 1.8)
    put(out.solid, TUBE12, '#8a7a5a', s.x(u + 2.2, v - 1.5), y + 0.3, s.z(u + 2.2, v - 1.5),
      0, 0, 0, 1.4, 0.2, 1.4)
  }
  {
    // the anchor, half in the sand off the bow
    const ax = s.x(side * 3, len * 0.5 + 5)
    const az = s.z(side * 3, len * 0.5 + 5)
    const iron = '#3a3634'
    strut(out.solid, iron, ax, y - 0.3, az, ax + s.fx * 2.6, y + 1.8, az + s.fz * 2.6, 0.3)
    strut(out.solid, iron, ax - s.rx * 1.3, y + 0.4, az - s.rz * 1.3,
      ax + s.rx * 1.3, y + 0.4, az + s.rz * 1.3, 0.26)
    put(out.solid, TUBE12, iron, ax + s.fx * 2.9, y + 2.1, az + s.fz * 2.9,
      Math.PI / 2, s.face, 0, 0.7, 0.14, 0.7)
  }
  for (let i = 0; i < 9; i++) {
    const u = (dr() - 0.5) * 18
    const v = (dr() - 0.5) * (len + 10)
    put(out.solid, BOX, dr() < 0.5 ? timber : pale, s.x(u, v), y - 0.3,
      s.z(u, v), (dr() - 0.5) * 0.2, dr() * 3, (dr() - 0.5) * 0.3,
      0.45, 0.2, 2.0 + dr() * 2.4, SURF.plank)
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
