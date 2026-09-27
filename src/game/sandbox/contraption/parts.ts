import * as THREE from 'three'
import { cell, model, type Paint } from '../art'
import { batchable } from '../batch'
import { CATALOGUE, CATEGORIES } from '../catalogue'
import { registerKind, type PropKind, type ShapeSpec } from '../kinds'

/*
  The contraption parts: what a player builds a vehicle out of.

  Garry's Mod's building kit reduced to the pieces that make a machine go:
  plates and beams to make a chassis, a wheel, a thruster, a hoverball and a
  seat to drive the thing from. They are ordinary props in every respect (one
  kind each in the kind table, drawn on the one atlas material through the
  batches, undone with Z, held by the physgun), listed in the spawn menu
  under their own "parts" section, and what makes them parts is only the
  `PARTS` record below, which `contraption.ts` reads to decide what each one
  does every slice. So a plate is a prop the tool gun can weld, and a
  thruster is a prop the tool gun can weld that also pushes.

  Each kind's geometry answers to how the part is *mounted*, which is what
  the tool gun's snap reads (contraption.ts's `snapOnto`):
    - a thruster is a cylinder along its local y, the nozzle at -y; it
      pushes toward +y, so it is mounted nozzle-out and pushes the thing it
      is stuck to;
    - a wheel's axle is its local x, and the tool gun lines that axle up
      with the face it is put on;
    - a hoverball is a ball, mounted by its surface;
    - a seat faces its local -z (the walk's own "forward" at yaw 0), its
      cushion top at `SEAT_TOP` over its origin, and is mounted by its floor.

  Keys. Every powered part carries a *pair* of keys (forward and back, up and
  down) out of `KEY_PAIRS`, laid out on the right hand's letter block the way
  a numpad is laid out, with the numpad itself as an alias: u i o over
  j k l is 7 8 9 over 4 5 6. Thrusters default to i/k (numpad 8/5),
  hoverballs to u/j (7/4) and wheels to the arrow keys, and the tool gun's
  key mode cycles a part through the pairs. None of these codes is bound to
  anything else (bindings.ts lists them as `partKeys`, which is also what
  makes the input service track them).

  The masses are close to each other on purpose: a joint between two bodies
  one of which is a hundred times the other is where an iterative solver
  starts to shake, so every part weighs between 5 and 50 kg. Everything
  floats (a density under one), because a raft is the second thing
  everybody builds.
*/

export type PartType = 'thruster' | 'wheel' | 'hoverball' | 'seat' | 'plate'

export interface PartSpec {
  type: PartType
  /** the pair a new one starts on (KEY_PAIRS index); unpowered parts none */
  keys: number
}

/** a key pair: `a` is forward / up / fire, `b` is back / down / reverse */
export interface KeyPair {
  a: readonly string[]
  b: readonly string[]
  /** how the tool gun's screen and the hint tape write it */
  label: string
}

export const KEY_PAIRS: readonly KeyPair[] = [
  { a: ['KeyI', 'Numpad8'], b: ['KeyK', 'Numpad5'], label: 'i/k' },
  { a: ['KeyU', 'Numpad7'], b: ['KeyJ', 'Numpad4'], label: 'u/j' },
  { a: ['KeyO', 'Numpad9'], b: ['KeyL', 'Numpad6'], label: 'o/l' },
  { a: ['ArrowUp'], b: ['ArrowDown'], label: 'up/dn' },
  { a: ['ArrowRight'], b: ['ArrowLeft'], label: 'rt/lt' },
]

/** every code a part can answer to, for the key table */
export const PART_CODES: readonly string[] = [...new Set(KEY_PAIRS.flatMap((p) => [...p.a, ...p.b]))]

/** kind id -> what it is as a part */
export const PARTS: Record<string, PartSpec> = {}

/* ----------------------------------------------------------- numbers -- */

export const THRUSTER = { r: 0.45, hh: 0.7 }
export const WHEEL = { r: 1.2, hh: 0.4 }
export const HOVER_R = 0.6
/** the seat's cushion top over its origin, and its floor under it */
export const SEAT_TOP = 0.12
export const SEAT_FLOOR = 0.12

/* ------------------------------------------------------------- cells -- */

// the thruster's throat and the hoverball's band: glowing, so they read at
// night and through the look's grade, in their own colours (the atlas's
// `lit` cell glows white whatever it is tinted)
cell('part_nozzle', {
  w: 4, h: 4,
  paint: (p) => p.fill('#ff9a3a'),
  glow: (p) => p.fill('#ff7a1a'),
})
cell('part_hover', {
  w: 8, h: 4,
  paint: (p) => {
    p.fill('#5fd8ff')
    p.rect(0, 0, 8, 1, '#2a6f8a')
    p.rect(0, 3, 8, 1, '#2a6f8a')
  },
  glow: (p) => {
    p.fill('#000000')
    p.rect(0, 1, 8, 2, '#46c8ff')
  },
})
// a riveted panel, mapped at world density so a big plate and a small one
// carry the same size of rivet
cell('part_plate', {
  w: 32, h: 32,
  rough: 0.5,
  paint: (p) => {
    p.fill('#8e959c')
    p.speckle('#7f868d', 0.18, 91)
    p.speckle('#a3aab0', 0.06, 92)
    p.rect(0, 0, 32, 1, '#6c737a')
    p.rect(0, 0, 1, 32, '#6c737a')
    for (const x of [3, 28]) for (const y of [3, 28]) p.rect(x, y, 2, 2, '#b8bec4')
  },
})

/* ------------------------------------------------------------ models -- */

const flat = (tint: string, c = 'white'): Paint => ({ cell: c, tint })
const STEEL = flat('#9aa1a8', 'steel')
const DARK = flat('#3a3e45', 'steel')
const HAZARD: Paint = { cell: 'hazard' }
/** a quarter turn about z: something built along y now lies along x */
const TO_X: [number, number, number] = [0, 0, Math.PI / 2]

const plateModel = (hx: number, hy: number, hz: number) => () => {
  const m = model()
  m.box([0, 0, 0], [hx * 2, hy * 2, hz * 2], {
    py: { cell: 'part_plate', world: true },
    ny: { cell: 'part_plate', world: true },
    side: flat('#6f767d', 'steel'),
  })
  return m.mesh()
}

const beamModel = (h: number, len: number) => () => {
  const m = model()
  // a yellow-painted box girder with dark end caps
  m.box([0, 0, 0], [h * 2, h * 2, len * 2 - 0.08], { side: flat('#d8a531', 'steel'), py: flat('#e2b344', 'steel'), ny: flat('#b88a22', 'steel') })
  for (const s of [-1, 1]) m.box([0, 0, s * (len - 0.04)], [h * 2, h * 2, 0.08], DARK)
  return m.mesh()
}

const thrusterModel = () => {
  const { r, hh } = THRUSTER
  const m = model()
  // the can, a hazard band round it, a cap at the top
  m.cyl([0, 0.12, 0], r * 0.92, hh * 2 - 0.5, { side: STEEL, top: DARK, bottom: DARK }, { seg: 10 })
  m.cyl([0, 0.35, 0], r * 0.95, 0.22, { side: HAZARD }, { seg: 10, open: true })
  m.cyl([0, hh - 0.06, 0], r, 0.12, { side: DARK, top: DARK, bottom: DARK }, { seg: 10 })
  // the bell, flaring down to the nozzle, and the glowing throat inside it
  m.lathe([0, -hh, 0], [[r, 0], [r * 0.82, 0.12], [r * 0.5, 0.3], [r * 0.46, 0.34]], flat('#2c2f35', 'steel'), { seg: 10 })
  m.cyl([0, -hh + 0.08, 0], r * 0.7, 0.04, { top: { cell: 'part_nozzle' }, bottom: { cell: 'part_nozzle' }, side: { cell: 'part_nozzle' } }, { seg: 10 })
  return m.mesh()
}

const wheelModel = () => {
  const { r, hh } = WHEEL
  const m = model()
  // a fat tyre on a steel rim, built about y and laid onto the x axle
  m.lathe([0, 0, 0], [
    [0.72, -hh * 0.8], [0.8, -hh], [r - 0.12, -hh], [r - 0.02, -hh * 0.6], [r, -hh * 0.2], [r, hh * 0.2],
    [r - 0.02, hh * 0.6], [r - 0.12, hh], [0.8, hh], [0.72, hh * 0.8], [0.7, 0], [0.72, -hh * 0.8],
  ], { cell: 'tyre' }, { seg: 16, rot: TO_X })
  m.cyl([0, 0, 0], 0.74, hh * 1.6, { side: STEEL, top: { cell: 'rim' }, bottom: { cell: 'rim' } }, { seg: 12, rot: TO_X })
  // the hub the axle goes through
  m.cyl([0, 0, 0], 0.2, hh * 2.1, { side: DARK, top: flat('#c08a2e'), bottom: flat('#c08a2e') }, { seg: 8, rot: TO_X })
  return m.mesh()
}

const hoverModel = () => {
  const m = model()
  m.ball([0, 0, 0], [HOVER_R, HOVER_R, HOVER_R], flat('#4a5058', 'steel'), { w: 12, h: 8 })
  // the glowing equator, and a darker cap on each pole
  m.cyl([0, 0, 0], HOVER_R * 1.03, 0.2, { side: { cell: 'part_hover' } }, { seg: 12, open: true })
  for (const s of [-1, 1]) m.cyl([0, s * HOVER_R * 0.86, 0], 0.26, 0.1, { side: DARK, top: DARK, bottom: DARK }, { seg: 8 })
  return m.mesh()
}

const seatModel = () => {
  const m = model()
  const cloth: Paint = { cell: 'fabric', tint: '#b8433a' }
  // floor plate, cushion, backrest (behind: +z), and the frame
  m.box([0, -0.06, 0], [1.9, 0.12, 1.8], DARK)
  m.box([0, 0.06, -0.05], [1.7, 0.14, 1.5], cloth)
  m.box([0, 0.8, 0.76], [1.7, 1.4, 0.2], cloth, [-0.08, 0, 0])
  for (const s of [-1, 1]) m.box([s * 0.9, 0.3, 0.1], [0.1, 0.5, 1.5], STEEL)
  return m.mesh()
}

/* -------------------------------------------------------- the kinds -- */

const box = (hx: number, hy: number, hz: number) => ({ type: 'box' as const, hx, hy, hz })
const LIE_X: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]

type Def = Omit<PropKind, 'id' | 'label' | 'mesh'> & { en: string; es: string; part: PartType; keys?: number; draw: () => THREE.Object3D }

const def = (id: string, d: Def) => {
  const { en, es, part, keys, draw, ...k } = d
  registerKind({ id, label: en.toLowerCase(), mesh: () => batchable(draw()), ...k })
  // the catalogue's own list, under the parts tab (see CATEGORIES below)
  CATALOGUE.push({ id, category: 'parts', name: { en, es } })
  PARTS[id] = { type: part, keys: keys ?? -1 }
}

// the spawn menu's section for them; appended here so the list of what can
// be built stays in the module that builds it
if (!CATEGORIES.some((c) => c.id === 'parts')) {
  CATEGORIES.push({ id: 'parts', name: { en: 'Parts', es: 'Piezas' } })
}

const plate = (id: string, en: string, es: string, hx: number, hy: number, hz: number, mass: number) =>
  def(id, {
    en, es, part: 'plate', draw: plateModel(hx, hy, hz),
    shape: box(hx, hy, hz), mass, friction: 0.7, restitution: 0.08, density: 0.6, surface: 'sheet',
  })
plate('plate_s', 'Small plate', 'Placa chica', 1.2, 0.1, 1.2, 8)
plate('plate_m', 'Square plate', 'Placa cuadrada', 2.4, 0.1, 2.4, 22)
plate('plate_l', 'Chassis plate', 'Placa de chasis', 2.4, 0.12, 4.8, 45)

const beam = (id: string, en: string, es: string, len: number, mass: number) =>
  def(id, {
    en, es, part: 'plate', draw: beamModel(0.25, len),
    shape: box(0.25, 0.25, len), mass, friction: 0.6, restitution: 0.08, density: 0.6, surface: 'metal',
    angularDamping: 0.2,
  })
beam('beam_s', 'Short beam', 'Viga corta', 2.4, 8)
beam('beam_l', 'Long beam', 'Viga larga', 4.8, 16)

def('thruster', {
  en: 'Thruster', es: 'Propulsor', part: 'thruster', keys: 0, draw: thrusterModel,
  shape: { type: 'cylinder', r: THRUSTER.r, hh: THRUSTER.hh } satisfies ShapeSpec,
  mass: 6, friction: 0.5, restitution: 0.1, density: 0.9, surface: 'metal',
})
def('wheel', {
  en: 'Wheel', es: 'Rueda', part: 'wheel', keys: 3, draw: wheelModel,
  shape: { type: 'compound', parts: [{ shape: { type: 'cylinder', r: WHEEL.r, hh: WHEEL.hh }, rot: LIE_X }] },
  // grippy rubber, and very little rolling loss: a car should coast
  mass: 12, friction: 1.25, restitution: 0.12, density: 0.5, rolling: 0.012, angularDamping: 0.05,
  surface: 'rubber',
})
def('hoverball', {
  en: 'Hoverball', es: 'Bola flotante', part: 'hoverball', keys: 1, draw: hoverModel,
  shape: { type: 'ball', r: HOVER_R }, mass: 5, friction: 0.5, restitution: 0.2, density: 0.5, surface: 'metal',
  rolling: 0.05,
})
def('seat', {
  en: 'Seat', es: 'Asiento', part: 'seat', draw: seatModel,
  shape: {
    type: 'compound',
    parts: [
      { shape: box(0.95, 0.12, 0.9) },
      { shape: box(0.85, 0.7, 0.1), at: [0, 0.8, 0.76] },
    ],
  },
  mass: 14, friction: 0.7, restitution: 0.1, density: 0.5, surface: 'soft',
})

/** what a kind is as a part, or null for an ordinary prop */
export const partOf = (kindId: string): PartSpec | null => PARTS[kindId] ?? null
