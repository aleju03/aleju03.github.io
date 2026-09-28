import * as THREE from 'three'
import { model, type V3 } from '../sandbox/art'
import './cells'

/*
  What every creature is made of: a short list of boxes.

  A creature is not a mesh, it is a list of `PartSpec`s, each a scaled unit
  box at a pivot in the creature's own frame (forward is +x, up is +y, +z is
  its left). The view (view.ts) turns each part into one instance of a shared
  geometry on the props' atlas material, so a whole farm is a handful of
  instanced draws and links no program that was not already linked for the
  crates.

  There are two families of geometry, both a unit cube, so a part's size is
  its instance scale and a hundred differently sized limbs share one draw:
  a **material box** (one atlas cell on all six faces; the tint per part makes
  it a pig's skin, a zombie's shirt or a skeleton's rib) and a **head** (a
  face on +x, a skin on the other five). Limbs hang from their pivot (the top
  of a leg is where it swings), which is why `center` is separate from `at`.

  Joints are the whole of the animation: `leg` and `arm` swing about the
  side axis with the walk cycle, `head` turns to look (and lowers to graze),
  `wing` flaps. A part that says `head` rides the head's turn, so a cow's
  horns and a sheep's cap of wool follow it.

  Sizes are world units, drawn to the kind table's `r` and `h` in kinds.ts:
  the person-sized ones stand about 4.3 tall against a walker's 4.4.
*/

export type Joint = 'leg' | 'arm' | 'head' | 'wing' | null

export interface PartSpec {
  /** a material cell ('mob_fur') or a head ('head:face_pig:mob_fur') */
  geo: string
  size: V3
  /** the pivot, in the body frame */
  at: V3
  /** from the pivot to the box's middle */
  center?: V3
  tint: string
  joint?: Joint
  /** where in the walk cycle a leg or arm is (radians) */
  phase?: number
  /** an arm's resting angle about the side axis, and a wing's spread */
  rest?: number
  /** does not follow the body's bob (the chicken's feet) */
  still?: boolean
}

export interface ModelSpec {
  parts: PartSpec[]
  /** where the head turns, for the look and the graze */
  headAt: V3
  /** the leg swing at a run, radians */
  swing: number
  /** radians of walk cycle per unit walked */
  stride: number
  /** a bob of the whole body while walking (the chicken) */
  bob?: number
  /** lowers its head to graze while idle */
  grazes?: boolean
  /** arms held out ahead (a zombie's) */
  armsOut?: boolean
}

const leg = (x: number, z: number, size: V3, y: number, tint: string, phase: number, cellName = 'mob_fur'): PartSpec => ({
  geo: cellName, size, at: [x, y, z], center: [0, -size[1] / 2, 0], tint, joint: 'leg', phase,
})
const headBox = (face: string, skin: string, size: V3, at: V3, tint = '#ffffff'): PartSpec => ({
  geo: `head:${face}:${skin}`, size, at, center: [size[0] * 0.45, 0, 0], tint, joint: 'head',
})
const onHead = (cell: string, size: V3, at: V3, center: V3, tint: string): PartSpec => ({
  geo: cell, size, at, center, tint, joint: 'head',
})
const quad = (x: number, legs: V3, y: number, tint: string, cellName = 'mob_fur'): PartSpec[] => [
  leg(x, 0.42, legs, y, tint, 0, cellName), leg(-x, -0.42, legs, y, tint, 0, cellName),
  leg(x, -0.42, legs, y, tint, Math.PI, cellName), leg(-x, 0.42, legs, y, tint, Math.PI, cellName),
]

const PIG = '#f0a8a2'
const SPECS: Record<string, ModelSpec> = {
  pig: {
    headAt: [1.0, 1.45, 0], swing: 0.75, stride: 2.4, grazes: true,
    parts: [
      { geo: 'mob_fur', size: [2.0, 1.1, 1.3], at: [0, 1.3, 0], tint: PIG },
      headBox('face_pig', 'mob_fur', [1.0, 1.0, 1.1], [1.0, 1.45, 0], PIG),
      ...quad(0.7, [0.5, 0.75, 0.5], 0.75, '#e69a94'),
    ],
  },
  cow: {
    headAt: [1.35, 2.3, 0], swing: 0.6, stride: 1.9, grazes: true,
    parts: [
      { geo: 'mob_patch', size: [2.7, 1.5, 1.5], at: [0, 1.85, 0], tint: '#ffffff' },
      headBox('face_cow', 'mob_fur', [1.15, 1.05, 1.2], [1.35, 2.3, 0], '#ffffff'),
      onHead('mob_bone', [0.2, 0.5, 0.2], [1.35, 2.3, 0], [0.45, 0.7, 0.56], '#e8e2d0'),
      onHead('mob_bone', [0.2, 0.5, 0.2], [1.35, 2.3, 0], [0.45, 0.7, -0.56], '#e8e2d0'),
      ...quad(0.85, [0.55, 1.1, 0.55], 1.1, '#cfc7bd'),
    ],
  },
  sheep: {
    headAt: [1.05, 2.05, 0], swing: 0.7, stride: 2.2, grazes: true,
    parts: [
      { geo: 'mob_wool', size: [2.0, 1.55, 1.6], at: [0, 1.7, 0], tint: '#ffffff' },
      headBox('face_sheep', 'mob_fur', [0.85, 0.9, 0.85], [1.05, 2.05, 0], '#ffffff'),
      onHead('mob_wool', [0.95, 0.4, 0.95], [1.05, 2.05, 0], [0.32, 0.5, 0], '#ffffff'),
      ...quad(0.6, [0.42, 0.95, 0.42], 0.95, '#b4aea2'),
    ],
  },
  chicken: {
    headAt: [0.5, 1.5, 0], swing: 0.9, stride: 5.5, bob: 0.06, grazes: true,
    parts: [
      { geo: 'mob_fur', size: [0.95, 0.8, 0.7], at: [0, 0.95, 0], tint: '#f6f4ee' },
      headBox('face_chicken', 'mob_fur', [0.45, 0.55, 0.4], [0.5, 1.5, 0], '#ffffff'),
      { geo: 'mob_fur', size: [0.5, 0.4, 0.08], at: [-0.05, 1.15, 0.36], center: [-0.1, -0.1, 0], tint: '#e6e2da', joint: 'wing', rest: 0 },
      { geo: 'mob_fur', size: [0.5, 0.4, 0.08], at: [-0.05, 1.15, -0.36], center: [-0.1, -0.1, 0], tint: '#e6e2da', joint: 'wing', rest: 0 },
      { geo: 'mob_fur', size: [0.3, 0.3, 0.2], at: [-0.5, 1.2, 0], center: [0, 0.1, 0], tint: '#efece4' },
      leg(0, 0.17, [0.12, 0.55, 0.12], 0.6, '#e8b030', 0),
      leg(0, -0.17, [0.12, 0.55, 0.12], 0.6, '#e8b030', Math.PI),
    ],
  },
  zombie: {
    headAt: [0, 3.4, 0], swing: 0.7, stride: 1.4, armsOut: true,
    parts: [
      leg(0, 0.36, [0.7, 1.9, 0.7], 1.9, '#3a4a86', 0, 'mob_cloth'),
      leg(0, -0.36, [0.7, 1.9, 0.7], 1.9, '#3a4a86', Math.PI, 'mob_cloth'),
      { geo: 'mob_cloth', size: [0.75, 1.5, 1.5], at: [0, 2.65, 0], tint: '#3f8f95' },
      { geo: 'mob_skin', size: [0.65, 1.6, 0.65], at: [0, 3.25, 1.08], center: [0, -0.8, 0], tint: '#8cb26c', joint: 'arm', phase: Math.PI, rest: 1.4 },
      { geo: 'mob_skin', size: [0.65, 1.6, 0.65], at: [0, 3.25, -1.08], center: [0, -0.8, 0], tint: '#8cb26c', joint: 'arm', phase: 0, rest: 1.4 },
      headBox('face_zombie', 'mob_skin', [1.15, 1.15, 1.15], [0, 3.4, 0], '#ffffff'),
    ],
  },
  creeper: {
    headAt: [0, 2.3, 0], swing: 0.6, stride: 2.2,
    parts: [
      ...quad(0.5, [0.7, 0.9, 0.7], 0.9, '#ffffff', 'mob_creeper').map((p) => ({ ...p, center: [0, -0.45, 0] as V3 })),
      { geo: 'mob_creeper', size: [0.9, 1.4, 1.4], at: [0, 1.6, 0], tint: '#ffffff' },
      headBox('face_creeper', 'mob_creeper', [1.2, 1.2, 1.2], [0, 2.3, 0], '#ffffff'),
    ],
  },
  skeleton: {
    headAt: [0, 3.3, 0], swing: 0.7, stride: 1.4, armsOut: true,
    parts: [
      leg(0, 0.28, [0.5, 1.9, 0.5], 1.9, '#ffffff', 0, 'mob_bone'),
      leg(0, -0.28, [0.5, 1.9, 0.5], 1.9, '#ffffff', Math.PI, 'mob_bone'),
      { geo: 'mob_bone', size: [0.55, 1.5, 1.2], at: [0, 2.65, 0], tint: '#f2efe6' },
      { geo: 'mob_bone', size: [0.45, 1.6, 0.45], at: [0, 3.25, 0.85], center: [0, -0.8, 0], tint: '#ffffff', joint: 'arm', phase: Math.PI, rest: 0.2 },
      { geo: 'mob_bone', size: [0.45, 1.6, 0.45], at: [0, 3.25, -0.85], center: [0, -0.8, 0], tint: '#ffffff', joint: 'arm', phase: 0, rest: 0.2 },
      headBox('face_skeleton', 'mob_bone', [1.1, 1.1, 1.1], [0, 3.3, 0], '#ffffff'),
    ],
  },
  arrow: {
    headAt: [0, 0, 0], swing: 0, stride: 0,
    parts: [
      { geo: 'mob_bone', size: [1.5, 0.12, 0.12], at: [0, 0, 0], tint: '#a8875a' },
      { geo: 'mob_bone', size: [0.3, 0.24, 0.24], at: [0.78, 0, 0], tint: '#8a8780' },
      { geo: 'mob_fur', size: [0.34, 0.3, 0.05], at: [-0.68, 0, 0], tint: '#f0efe8' },
    ],
  },
  walker: {
    headAt: [0, 3.1, 0], swing: 0.65, stride: 1.5,
    parts: [
      leg(0, 0.24, [0.45, 1.7, 0.45], 1.7, '#ffffff', 0, 'mob_cloth'),
      leg(0, -0.24, [0.45, 1.7, 0.45], 1.7, '#ffffff', Math.PI, 'mob_cloth'),
      { geo: 'mob_cloth', size: [0.55, 1.4, 1.05], at: [0, 2.4, 0], tint: '#ffffff' },
      { geo: 'mob_cloth', size: [0.35, 1.45, 0.35], at: [0, 3.05, 0.7], center: [0, -0.72, 0], tint: '#ffffff', joint: 'arm', phase: Math.PI, rest: 0 },
      { geo: 'mob_cloth', size: [0.35, 1.45, 0.35], at: [0, 3.05, -0.7], center: [0, -0.72, 0], tint: '#ffffff', joint: 'arm', phase: 0, rest: 0 },
      headBox('face_egg', 'mob_skin', [0.7, 0.85, 0.7], [0, 3.1, 0], '#ffffff'),
    ],
  },
}

export const specOf = (kindId: string): ModelSpec => SPECS[kindId] ?? SPECS.pig

/* ------------------------------------------------------- geometries -- */

const geos = new Map<string, THREE.BufferGeometry>()

/** the shared unit-cube geometry for a part's `geo` key (built on first use) */
export const geometryFor = (key: string): THREE.BufferGeometry => {
  let g = geos.get(key)
  if (g) return g
  if (key.startsWith('head:')) {
    const [, face, skin] = key.split(':')
    g = model().box([0, 0, 0], [1, 1, 1], { px: { cell: face }, all: { cell: skin } }).geometry()
  } else {
    g = model().box([0, 0, 0], [1, 1, 1], { cell: key }).geometry()
  }
  geos.set(key, g)
  return g
}

/** every geometry a spec set needs, built now (so the atlas packs and the
    buffers upload under the loading card rather than at the first spawn) */
export const warmGeometries = () => {
  for (const s of Object.values(SPECS)) for (const p of s.parts) geometryFor(p.geo)
}

export const disposeGeometries = () => {
  for (const g of geos.values()) g.dispose()
  geos.clear()
}
