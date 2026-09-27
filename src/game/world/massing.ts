import * as THREE from 'three'
import type { MeshBuilder } from '../core/geometry'
import { raiseKind, type BuildKind } from './buildings'
import { BOX, PLANE, lotStream, type BuildOut, type Lot } from './kitbash'
import { SURF } from './surface'

/*
  A building's massing: what a lot looks like from far enough away that only
  its volumes read, taken from the kit itself rather than drawn a second time.

  The far field used to draw its town impostors from a table of its own: a box
  the lot's footprint and nominal height, in one of five greys per district.
  The kit on the same lot rolled its own paint, its own storey count and its
  own shape (a slab is two thirds of its lot wide, a round tower is a
  cylinder, a tower steps back twice and wears a crown), so every downtown
  swapped skyline as the chunk ring reached it: different towers, heights,
  shapes and colours in the same lots.

  So nothing here decides anything. `massOf` raises the lot through the same
  dispatch the chunk uses (buildings.ts's raiseKind), off the same stream
  (kitbash.ts's lotStream), at the outer ring's tier (`detailed` false), into
  a builder that records each stamp instead of copying its vertices, and then
  keeps only the stamps big enough to be seen from where an impostor is
  drawn: bodies, setbacks, roofs, plinths, a garage, a bulkhead. Windows,
  trim, fascias, masts and fences fall away by size, and a round tower's
  forty stacked courses are merged into the one drum they read as. The far
  field can simplify what it is handed; it cannot swap the building, because
  it never gets to choose one.
*/

/** one kept stamp: a cached unit geometry, where it went, and its paint */
export interface Stamp {
  geo: THREE.BufferGeometry
  m: THREE.Matrix4
  color: THREE.Color
  surf: number
  /** a wall that lives behind windows (a body, not a plinth or a roof) */
  body: boolean
}

/** a vertical run of courses of one round shaft, merged */
export interface Drum {
  x: number
  z: number
  y0: number
  y1: number
  r0: number
  r1: number
  color: THREE.Color
}

export interface Massing {
  stamps: Stamp[]
  drums: Drum[]
}

interface Rec {
  geo: THREE.BufferGeometry
  m: THREE.Matrix4
  color: THREE.Color
  surf: number
}

/** a MeshBuilder that keeps the stamp list and none of the vertices */
const recorder = (into: Rec[] | null): MeshBuilder => {
  const b: MeshBuilder = {
    surface: 0,
    count: 0,
    indexCount: 0,
    marks: null,
    add: (geo, m, color) => {
      if (into) into.push({ geo, m: m.clone(), color: color.clone(), surf: b.surface })
    },
    quad: () => {},
    tri: () => {},
    build: () => null,
  }
  return b
}

const sx = new THREE.Vector3()
const sy = new THREE.Vector3()
const sz = new THREE.Vector3()
const at = new THREE.Vector3()

const WALLS = new Set<number>([SURF.plaster, SURF.brick, SURF.panel, SURF.plank])

/**
 * The lot's massing, from its own kit. `minArea` is the smallest footprint
 * (in square units) a stamp keeps: a few for the nearest impostor ring, more
 * further out, where a bulkhead is under a pixel.
 */
export const massOf = (kind: BuildKind, lot: Omit<Lot, 'rng'>, minArea = 5): Massing => {
  const recs: Rec[] = []
  const out: BuildOut = {
    solid: recorder(recs),
    glass: recorder(null),
    boxes: [],
    lamps: [],
    interiors: [],
    doors: [],
    smash: [],
    detailed: false,
  }
  raiseKind(out, kind, { ...lot, rng: lotStream(lot.x, lot.z) })

  const stamps: Stamp[] = []
  const shafts: Array<Drum & { open: boolean; h: number }> = []
  for (const r of recs) {
    if (r.geo === PLANE) continue
    r.m.extractBasis(sx, sy, sz)
    const w = sx.length()
    const h = sy.length()
    const d = sz.length()
    const type = r.geo.type
    if (type === 'CylinderGeometry') {
      // a shaft standing upright and wide enough to be a building rather
      // than a mast, a leg or a water tank
      if (Math.abs(sy.y) < h * 0.99 || w < 4) continue
      const p = (r.geo as THREE.CylinderGeometry).parameters
      at.setFromMatrixPosition(r.m)
      shafts.push({
        x: at.x, z: at.z, y0: at.y - h / 2, y1: at.y + h / 2,
        r0: p.radiusBottom * w, r1: p.radiusTop * w, color: r.color,
        open: p.openEnded, h,
      })
      continue
    }
    if (r.geo === BOX) {
      // a box keeps if it stands up (a body, a setback, a bulkhead), if it is
      // a long wall (a deck's spandrel), or if it is a slab big enough to be
      // a floor of something (a parking deck's levels, a cornice round a
      // whole tower); a sill course, a fascia or a chimney does not
      const stands = h >= 1.2 && (Math.min(w, d) >= 1 ? w * d >= minArea : Math.max(w, d) >= 10)
      if (!stands && !(h < 1.2 && w * d >= minArea * 120)) continue
    } else if (w * d < minArea) continue
    stamps.push({
      ...r,
      body: r.geo === BOX && WALLS.has(r.surf) && h >= 4,
    })
  }
  return { stamps, drums: mergeDrums(shafts) }
}

/** stack coaxial shafts that touch into one drum, painted in whichever
    closed course covers the most of its height (the body, not the glazing
    band between two courses or the plinth under them) */
const mergeDrums = (list: Array<Drum & { open: boolean; h: number }>): Drum[] => {
  list.sort((a, b) => a.x - b.x || a.z - b.z || a.y0 - b.y0)
  const out: Drum[] = []
  let cur: (Drum & { paint: Map<string, [THREE.Color, number]> }) | null = null
  const finish = () => {
    if (!cur) return
    let best = -1
    for (const [c, n] of cur.paint.values()) if (n > best) { best = n; cur.color = c }
    out.push({ x: cur.x, z: cur.z, y0: cur.y0, y1: cur.y1, r0: cur.r0, r1: cur.r1, color: cur.color })
    cur = null
  }
  for (const s of list) {
    const joins = cur && Math.abs(s.x - cur.x) < 0.05 && Math.abs(s.z - cur.z) < 0.05 &&
      s.y0 <= cur.y1 + 0.3 && Math.abs(s.r0 - cur.r1) < cur.r1 * 0.2
    if (!joins) {
      finish()
      cur = { x: s.x, z: s.z, y0: s.y0, y1: s.y1, r0: s.r0, r1: s.r1, color: s.color, paint: new Map() }
    }
    const c = cur!
    if (s.y1 > c.y1) { c.y1 = s.y1; c.r1 = s.r1 }
    if (!s.open) {
      const k = s.color.getHexString()
      const e = c.paint.get(k)
      if (e) e[1] += s.h
      else c.paint.set(k, [s.color, s.h])
    }
  }
  finish()
  return out
}
