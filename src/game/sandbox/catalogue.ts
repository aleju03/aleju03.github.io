import { batchable } from './batch'
import { registerKind, type PropKind, type ShapeSpec } from './kinds'
import { BARRIER_PROFILE, DIMS, MODELS } from './models'

/*
  The spawnable prop catalogue: forty-one things to throw, stack and break,
  chosen for a suburban and downtown planet (a house, shops, roads) and for
  being fun in a physics sandbox, Garry's Mod's own list read through that
  world: crates of two sizes, pallets and planks, oil drums and the red
  explosive barrel, gas cans and a propane tank, traffic cones, sawhorses and
  jersey barriers, tyres and an engine block, kitchen chairs and a sofa, a
  bathtub, a fridge, a mattress, a CRT television, a vending machine, a
  dumpster, a shipping container, and watermelons.

  This module is the physics half and the menu half: every kind's collision
  shape, mass, friction, bounce, buoyancy, sound, and whether it breaks or
  explodes, registered into the kind table at import; plus `CATALOGUE`, what
  the spawn menu lists (id, category, names in English and Spanish). The
  models are in models.ts and share its `DIMS`, so the shape a prop collides
  with is built from the same numbers as the one it is drawn with.

  The numbers are honest where honesty is fun and generous where it is not.
  Masses are real (a fridge is 80 kg, a cast-iron bath 110, a jersey barrier
  over a tonne, a melon five), so the walker can shove a crate and not a
  dumpster, and a thrown can bounces off a car. Restitution is low for
  everything but rubber: real objects mostly thud. Densities are against the
  bounding box, so a bathtub floats like a boat, a container floats like a
  container, and a melon rides just awash.

  Consumers (S4's spawn menu, the console): read `CATALOGUE` and
  `CATEGORIES`, spawn with `sb.spawn(entry.id, at, { yaw })` at
  `sb.restY(entry.id, x, z)`, and draw icons with thumbnails.ts.
*/

export type Category =
  | 'wood' | 'metal' | 'plastic' | 'furniture' | 'food'
  | 'construction' | 'vehicle' | 'explosive' | 'big'

export interface Names {
  en: string
  es: string
}

export interface CatalogueEntry {
  id: string
  category: Category
  name: Names
}

export const CATEGORIES: Array<{ id: Category; name: Names }> = [
  { id: 'wood', name: { en: 'Wood', es: 'Madera' } },
  { id: 'metal', name: { en: 'Metal', es: 'Metal' } },
  { id: 'plastic', name: { en: 'Plastic', es: 'Plástico' } },
  { id: 'furniture', name: { en: 'Furniture', es: 'Muebles' } },
  { id: 'food', name: { en: 'Food', es: 'Comida' } },
  { id: 'construction', name: { en: 'Construction', es: 'Construcción' } },
  { id: 'vehicle', name: { en: 'Car parts', es: 'Autopartes' } },
  { id: 'explosive', name: { en: 'Explosives', es: 'Explosivos' } },
  { id: 'big', name: { en: 'Big stuff', es: 'Cosas grandes' } },
]

export const CATALOGUE: CatalogueEntry[] = []

type Def = Omit<PropKind, 'id' | 'label' | 'mesh'> & { category: Category; name: Names }

const def = (id: string, d: Def) => {
  const { category, name, ...k } = d
  const draw = MODELS[id]
  // each prop is a proxy into its kind's instanced batch (batch.ts)
  registerKind({ id, label: name.en.toLowerCase(), mesh: draw ? () => batchable(draw()) : undefined, ...k })
  CATALOGUE.push({ id, category, name })
}

/* ------------------------------------------------------------- shapes -- */

const box = (hx: number, hy: number, hz: number) => ({ type: 'box' as const, hx, hy, hz })
const cyl = (r: number, hh: number) => ({ type: 'cylinder' as const, r, hh })
type Parts = Extract<ShapeSpec, { type: 'compound' }>['parts']
const compound = (parts: Parts): ShapeSpec => ({ type: 'compound', parts })
/** a quarter turn about z: a y-axis cylinder lying along x */
const LIE_X: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]
const rotX = (a: number): [number, number, number, number] => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)]

const hull = (pts: Array<[number, number, number]>): ShapeSpec => ({ type: 'hull', points: pts.flat() })
const ring = (r: number, y: number, n: number, sx = 1, sz = 1) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return [Math.cos(a) * r * sx, y, Math.sin(a) * r * sz] as [number, number, number]
  })

const openBox = (hx: number, hy: number, hz: number, t: number, floorY = -hy + t / 2): ShapeSpec =>
  compound([
    { shape: box(hx, t / 2, hz), at: [0, floorY, 0] },
    { shape: box(t / 2, hy, hz), at: [-hx + t / 2, 0, 0] },
    { shape: box(t / 2, hy, hz), at: [hx - t / 2, 0, 0] },
    { shape: box(hx - t, hy, t / 2), at: [0, 0, -hz + t / 2] },
    { shape: box(hx - t, hy, t / 2), at: [0, 0, hz - t / 2] },
  ])

/* --------------------------------------------------------------- wood -- */

def('crate', {
  category: 'wood',
  name: { en: 'Wooden crate', es: 'Caja de madera' },
  shape: box(DIMS.crate, DIMS.crate, DIMS.crate),
  mass: 35,
  // wood on wood is ~0.4; at 0.65 a toppling tower held together like one
  // glued slab and landed as a raft, rather than coming apart as it fell
  friction: 0.42,
  restitution: 0.22,
  // wood crates ride about half under, and level: the load on the floor
  // puts the centre of mass a seventh of the side low, past the twelfth of
  // the side a cube at this draft needs to float flat rather than on an edge
  density: 0.5,
  ballast: { share: 0.35, at: [0, -DIMS.crate * 0.85, 0] },
  surface: 'wood',
  breaks: { speed: 30 },
})
def('crate_small', {
  category: 'wood',
  name: { en: 'Small crate', es: 'Caja pequeña' },
  shape: box(DIMS.crateSmall, DIMS.crateSmall, DIMS.crateSmall),
  mass: 12,
  friction: 0.42,
  restitution: 0.22,
  density: 0.5,
  ballast: { share: 0.35, at: [0, -DIMS.crateSmall * 0.85, 0] },
  surface: 'wood',
  breaks: { speed: 26 },
})
{
  const { hx, hy, hz } = DIMS.pallet
  def('pallet', {
    category: 'wood',
    name: { en: 'Pallet', es: 'Palé' },
    shape: compound([
      { shape: box(hx, 0.03, hz), at: [0, hy - 0.03, 0] },
      ...[-1, 0, 1].map((z) => ({ shape: box(hx, hy - 0.08, 0.14), at: [0, -0.02, z * (hz - 0.14)] as [number, number, number] })),
      ...[-1, 0, 1].map((x) => ({ shape: box(0.15, 0.03, hz), at: [x * (hx - 0.15), -hy + 0.03, 0] as [number, number, number] })),
    ]),
    mass: 20,
    friction: 0.6,
    restitution: 0.12,
    density: 0.45,
    surface: 'wood',
    breaks: { speed: 34 },
  })
}
def('plank', {
  category: 'wood',
  name: { en: 'Plank', es: 'Tablón' },
  shape: box(DIMS.plank.hx, DIMS.plank.hy, DIMS.plank.hz),
  mass: 12,
  friction: 0.7,
  restitution: 0.1,
  density: 0.55,
  surface: 'wood',
  breaks: { speed: 46 },
})

/* -------------------------------------------------------------- metal -- */

def('barrel', {
  category: 'metal',
  name: { en: 'Oil drum', es: 'Tambor de aceite' },
  shape: cyl(DIMS.drum.r, DIMS.drum.hh),
  mass: 28,
  friction: 0.55,
  restitution: 0.18,
  density: 0.3,
  // steel on ground loses a little to rolling resistance; without it a drum
  // on the flat rolls to the horizon
  angularDamping: 0.25,
  surface: 'drum',
})
def('trashcan', {
  category: 'metal',
  name: { en: 'Trash can', es: 'Bote de basura' },
  shape: compound([
    { shape: cyl(DIMS.trash.r, DIMS.trash.hh - 0.07), at: [0, -0.07, 0] },
    { shape: cyl(DIMS.trash.r + 0.06, 0.1), at: [0, DIMS.trash.hh - 0.06, 0] },
  ]),
  mass: 8,
  friction: 0.5,
  restitution: 0.2,
  density: 0.25,
  angularDamping: 0.3,
  surface: 'sheet',
})
def('sawblade', {
  category: 'metal',
  name: { en: 'Saw blade', es: 'Disco de sierra' },
  shape: cyl(DIMS.saw.r, DIMS.saw.hh + 0.01),
  mass: 4,
  friction: 0.3,
  restitution: 0.3,
  density: 7.8,
  angularDamping: 0.05,
  surface: 'sheet',
})
def('pipe', {
  category: 'metal',
  name: { en: 'Steel pipe', es: 'Tubo de acero' },
  shape: compound([{ shape: cyl(DIMS.pipe.r + 0.1, DIMS.pipe.hl), rot: LIE_X }]),
  mass: 18,
  friction: 0.5,
  restitution: 0.15,
  density: 2,
  angularDamping: 0.2,
  surface: 'metal',
})
{
  const y0 = -DIMS.hydrant.h / 2
  def('hydrant', {
    category: 'metal',
    name: { en: 'Fire hydrant', es: 'Hidrante' },
    shape: compound([
      // the flange carries most of the iron, which is what keeps one upright
      { shape: cyl(DIMS.hydrant.base, 0.08), at: [0, y0 + 0.08, 0], w: 4 },
      { shape: cyl(DIMS.hydrant.r + 0.02, 0.9), at: [0, y0 + 1.06, 0] },
      { shape: box(0.62, 0.14, 0.14), at: [0, y0 + 1.1, 0] },
      { shape: cyl(0.1, 0.1), at: [0, y0 + 1.95, 0] },
    ]),
    mass: 90,
    friction: 0.6,
    restitution: 0.08,
    density: 7,
    surface: 'metal',
  })
}

/* ------------------------------------------------------------ plastic -- */

def('cone', {
  category: 'plastic',
  name: { en: 'Traffic cone', es: 'Cono de tráfico' },
  shape: compound([
    { shape: { type: 'cone', r: DIMS.cone.r, hh: DIMS.cone.hh } },
    // the rubber foot is most of a cone's weight: why it stands back up
    { shape: box(DIMS.cone.foot, DIMS.cone.footH / 2, DIMS.cone.foot), at: [0, -DIMS.cone.hh - DIMS.cone.footH / 2, 0], w: 3 },
  ]),
  mass: 3,
  friction: 0.85,
  restitution: 0.25,
  density: 1.3,
  surface: 'plastic',
})
def('ball', {
  category: 'plastic',
  name: { en: 'Beach ball', es: 'Pelota de playa' },
  shape: { type: 'ball', r: DIMS.ball },
  mass: 1.2,
  friction: 0.8,
  restitution: 0.72,
  density: 0.08,
  linearDamping: 0.08,
  angularDamping: 0.35,
  surface: 'rubber',
})
def('bucket', {
  category: 'plastic',
  name: { en: 'Bucket', es: 'Cubeta' },
  shape: hull([...ring(DIMS.bucket.rb, -DIMS.bucket.hh, 10), ...ring(DIMS.bucket.rt + 0.03, DIMS.bucket.hh, 10)]),
  mass: 1.2,
  friction: 0.7,
  restitution: 0.25,
  density: 0.3,
  surface: 'plastic',
})
def('milk_crate', {
  category: 'plastic',
  name: { en: 'Milk crate', es: 'Caja de leche' },
  shape: openBox(DIMS.milk.hx, DIMS.milk.hy, DIMS.milk.hz, DIMS.milk.t * 2),
  mass: 1.5,
  friction: 0.6,
  restitution: 0.25,
  density: 0.35,
  surface: 'plastic',
})
def('lawn_chair', {
  category: 'plastic',
  name: { en: 'Lawn chair', es: 'Silla de jardín' },
  shape: compound([
    { shape: box(0.54, 0.05, 0.49), at: [0, -0.02, 0.02] },
    { shape: box(0.51, 0.5, 0.05), at: [0, 0.5, -0.5], rot: rotX(-0.16) },
    ...[-1, 1].flatMap((x) => [-1, 1].map((z) => ({ shape: box(0.07, 0.5, 0.07), at: [x * 0.46, -0.52, z * 0.42] as [number, number, number] }))),
  ]),
  mass: 2.5,
  friction: 0.6,
  restitution: 0.2,
  density: 0.2,
  surface: 'plastic',
})
{
  const { hx, hy, hz } = DIMS.wheelie
  def('wheelie_bin', {
    category: 'plastic',
    name: { en: 'Wheelie bin', es: 'Contenedor con ruedas' },
    shape: hull([
      [-hx * 0.84, -hy, -hz * 0.8], [hx * 0.84, -hy, -hz * 0.8], [-hx * 0.84, -hy, hz * 0.8], [hx * 0.84, -hy, hz * 0.8],
      [-hx, hy, -hz], [hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz],
    ]),
    mass: 14,
    friction: 0.55,
    restitution: 0.2,
    density: 0.3,
    surface: 'plastic',
  })
}

/* ---------------------------------------------------------- furniture -- */

def('chair', {
  category: 'furniture',
  name: { en: 'Kitchen chair', es: 'Silla de cocina' },
  shape: compound([
    { shape: box(0.5, 0.06, 0.5), at: [0, -0.06, 0] },
    ...[-1, 1].flatMap((x) => [-1, 1].map((z) => ({ shape: box(0.06, 0.5, 0.06), at: [x * 0.42, -0.62, z * 0.42] as [number, number, number] }))),
    { shape: box(0.48, 0.55, 0.06), at: [0, 0.55, -0.44] },
  ]),
  mass: 5,
  friction: 0.5,
  restitution: 0.15,
  density: 0.5,
  surface: 'wood',
  breaks: { speed: 28 },
})
{
  const { hx, hy, hz } = DIMS.table
  def('table', {
    category: 'furniture',
    name: { en: 'Table', es: 'Mesa' },
    shape: compound([
      { shape: box(hx, 0.08, hz), at: [0, hy - 0.08, 0] },
      ...[-1, 1].flatMap((x) => [-1, 1].map((z) => ({
        shape: box(0.1, hy - 0.08, 0.1), at: [x * (hx - 0.22), -0.08, z * (hz - 0.22)] as [number, number, number],
      }))),
    ]),
    mass: 22,
    friction: 0.5,
    restitution: 0.12,
    density: 0.6,
    surface: 'wood',
  })
}
{
  const { hx, hz } = DIMS.couch
  def('couch', {
    category: 'furniture',
    name: { en: 'Sofa', es: 'Sofá' },
    shape: compound([
      { shape: box(hx - 0.05, 0.53, hz), at: [0, -0.35, 0] },
      { shape: box(hx - 0.05, 0.75, 0.2), at: [0, 0.12, -0.8] },
      { shape: box(0.25, 0.6, hz), at: [-(hx - 0.22), -0.02, 0] },
      { shape: box(0.25, 0.6, hz), at: [hx - 0.22, -0.02, 0] },
    ]),
    mass: 55,
    friction: 0.8,
    restitution: 0.12,
    density: 0.5,
    surface: 'soft',
  })
}
{
  const { hx, hy, hz } = DIMS.bath
  def('bathtub', {
    category: 'furniture',
    name: { en: 'Bathtub', es: 'Bañera' },
    shape: compound([
      { shape: box(hx - 0.15, 0.06, hz - 0.15), at: [0, -hy + 0.3, 0] },
      { shape: box(hx, 0.6, 0.07), at: [0, 0.04, -(hz - 0.07)] },
      { shape: box(hx, 0.6, 0.07), at: [0, 0.04, hz - 0.07] },
      { shape: box(0.07, 0.6, hz), at: [-(hx - 0.07), 0.04, 0] },
      { shape: box(0.07, 0.6, hz), at: [hx - 0.07, 0.04, 0] },
      ...[-1, 1].flatMap((x) => [-1, 1].map((z) => ({ shape: box(0.12, 0.15, 0.12), at: [x * (hx - 0.45), -hy + 0.15, z * (hz - 0.3)] as [number, number, number] }))),
    ]),
    mass: 110,
    friction: 0.45,
    restitution: 0.1,
    density: 0.55,
    surface: 'ceramic',
  })
}
def('mattress', {
  category: 'furniture',
  name: { en: 'Mattress', es: 'Colchón' },
  shape: box(DIMS.mattress.hx, DIMS.mattress.hy, DIMS.mattress.hz),
  mass: 18,
  friction: 1,
  restitution: 0.45,
  density: 0.3,
  surface: 'soft',
})
def('door', {
  category: 'furniture',
  name: { en: 'Door', es: 'Puerta' },
  shape: box(DIMS.door.hx, DIMS.door.hy, DIMS.door.hz + 0.03),
  mass: 20,
  friction: 0.5,
  restitution: 0.12,
  density: 0.6,
  surface: 'wood',
})
{
  const { hx, hy, hz } = DIMS.tv
  def('tv', {
    category: 'furniture',
    name: { en: 'Old TV', es: 'Televisor viejo' },
    shape: hull([
      [-hx, -hy, hz], [hx, -hy, hz], [-hx, hy, hz], [hx, hy, hz],
      [-hx * 0.62, -hy * 0.66, -hz], [hx * 0.62, -hy * 0.66, -hz], [-hx * 0.62, hy * 0.66, -hz], [hx * 0.62, hy * 0.66, -hz],
    ]),
    mass: 25,
    friction: 0.5,
    restitution: 0.1,
    density: 0.7,
    surface: 'plastic',
  })
}

/* --------------------------------------------------------------- food -- */

{
  const { rx, ry, rz } = DIMS.melon
  const pts: Array<[number, number, number]> = []
  for (let j = 0; j <= 6; j++) {
    const v = (j / 6) * Math.PI
    const n = j === 0 || j === 6 ? 1 : 10
    for (let i = 0; i < n; i++) {
      const u = (i / n) * Math.PI * 2
      pts.push([Math.sin(v) * Math.cos(u) * rx, Math.sin(v) * Math.sin(u) * ry, Math.cos(v) * rz])
    }
  }
  def('melon', {
    category: 'food',
    name: { en: 'Watermelon', es: 'Sandía' },
    shape: hull(pts),
    mass: 5,
    friction: 0.6,
    restitution: 0.18,
    density: 0.95,
    angularDamping: 0.2,
    surface: 'melon',
    breaks: { speed: 17 },
  })
}
def('bottle', {
  category: 'food',
  name: { en: 'Glass bottle', es: 'Botella de vidrio' },
  shape: compound([
    { shape: cyl(DIMS.bottle.r, 0.31), at: [0, -DIMS.bottle.hh + 0.31, 0], w: 2 },
    { shape: cyl(0.08, 0.19), at: [0, DIMS.bottle.hh - 0.19, 0] },
  ]),
  mass: 0.8,
  friction: 0.4,
  restitution: 0.2,
  density: 0.5,
  surface: 'glass',
  breaks: { speed: 12 },
})
def('soda_can', {
  category: 'food',
  name: { en: 'Soda can', es: 'Lata de refresco' },
  shape: cyl(DIMS.can.r, DIMS.can.hh),
  mass: 0.35,
  friction: 0.5,
  restitution: 0.25,
  density: 1.05,
  angularDamping: 0.3,
  surface: 'sheet',
})

/* ------------------------------------------------------- construction -- */

def('block', {
  category: 'construction',
  name: { en: 'Concrete block', es: 'Bloque de concreto' },
  shape: box(DIMS.block.hx, DIMS.block.hy, DIMS.block.hz),
  mass: 900,
  friction: 0.9,
  restitution: 0.02,
  density: 2.4,
  surface: 'concrete',
})
def('barrier', {
  category: 'construction',
  name: { en: 'Jersey barrier', es: 'Barrera de concreto' },
  shape: hull(BARRIER_PROFILE.flatMap(([z, y]) => [[-DIMS.barrier.hl, y, z], [DIMS.barrier.hl, y, z]] as Array<[number, number, number]>)),
  mass: 1100,
  friction: 0.9,
  restitution: 0.02,
  density: 2.4,
  surface: 'concrete',
})
def('cinder', {
  category: 'construction',
  name: { en: 'Cinder block', es: 'Bloque de cemento' },
  shape: box(DIMS.cinder.hx, DIMS.cinder.hy, DIMS.cinder.hz),
  mass: 16,
  friction: 0.85,
  restitution: 0.05,
  density: 2,
  surface: 'concrete',
})
{
  const { hx, hy, hz } = DIMS.sawhorse
  const frame = (x: number): Parts[number] => ({
    shape: { type: 'hull', points: [[-0.08, hy, -0.08], [0.08, hy, -0.08], [-0.08, hy, 0.08], [0.08, hy, 0.08], [-0.08, -hy, -hz], [0.08, -hy, -hz], [-0.08, -hy, hz], [0.08, -hy, hz]].flat() },
    at: [x, 0, 0],
  })
  def('sawhorse', {
    category: 'construction',
    name: { en: 'Road barricade', es: 'Barricada' },
    shape: compound([
      { shape: box(hx, 0.23, 0.05), at: [0, hy - 0.3, 0] },
      { shape: box(hx - 0.25, 0.15, 0.05), at: [0, -0.1, 0] },
      frame(-(hx - 0.3)),
      frame(hx - 0.3),
    ]),
    mass: 9,
    friction: 0.6,
    restitution: 0.15,
    density: 0.5,
    surface: 'wood',
  })
}
{
  const { hl, hh, hw } = DIMS.girder
  def('girder', {
    category: 'construction',
    name: { en: 'Steel girder', es: 'Viga de acero' },
    shape: compound([
      { shape: box(hl, 0.04, hw), at: [0, hh - 0.04, 0] },
      { shape: box(hl, 0.04, hw), at: [0, -hh + 0.04, 0] },
      { shape: box(hl, hh - 0.08, 0.04) },
    ]),
    mass: 220,
    friction: 0.55,
    restitution: 0.08,
    density: 7.8,
    surface: 'metal',
  })
}
{
  const { post, plate } = DIMS.stop
  const oct: Array<[number, number, number]> = []
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8
    for (const z of [-0.02, 0.02]) oct.push([Math.cos(a) * plate, Math.sin(a) * plate, z])
  }
  def('stop_sign', {
    category: 'construction',
    name: { en: 'Stop sign', es: 'Señal de alto' },
    shape: compound([
      { shape: box(0.06, post, 0.06), at: [0, -0.3, 0] },
      { shape: { type: 'hull', points: oct.flat() }, at: [0, post - 0.2, 0.08] },
    ]),
    mass: 7,
    friction: 0.5,
    restitution: 0.2,
    density: 3,
    surface: 'sheet',
  })
}

/* ------------------------------------------------------------ vehicle -- */

def('tyre', {
  category: 'vehicle',
  name: { en: 'Tyre', es: 'Llanta' },
  shape: cyl(DIMS.tyre.r, DIMS.tyre.hh),
  mass: 10,
  friction: 1,
  restitution: 0.45,
  density: 0.5,
  angularDamping: 0.15,
  surface: 'rubber',
})
def('engine', {
  category: 'vehicle',
  name: { en: 'Engine block', es: 'Bloque de motor' },
  shape: box(0.95, 0.85, 0.62),
  mass: 150,
  friction: 0.6,
  restitution: 0.05,
  density: 5,
  surface: 'metal',
})

/* ---------------------------------------------------------- explosive -- */

def('barrel_explosive', {
  category: 'explosive',
  name: { en: 'Explosive barrel', es: 'Barril explosivo' },
  shape: cyl(DIMS.drum.r, DIMS.drum.hh),
  mass: 30,
  friction: 0.55,
  restitution: 0.18,
  density: 0.3,
  angularDamping: 0.25,
  surface: 'drum',
  explodes: { power: 1, radius: 16, speed: 56 },
})
def('gascan', {
  category: 'explosive',
  name: { en: 'Gas can', es: 'Bidón de gasolina' },
  shape: box(DIMS.gascan.hx, DIMS.gascan.hy, DIMS.gascan.hz),
  mass: 6,
  friction: 0.5,
  restitution: 0.2,
  density: 0.5,
  surface: 'sheet',
  explodes: { power: 0.6, radius: 11, speed: 50 },
})
def('propane', {
  category: 'explosive',
  name: { en: 'Propane tank', es: 'Tanque de propano' },
  shape: cyl(DIMS.propane.r, DIMS.propane.hh),
  mass: 14,
  friction: 0.5,
  restitution: 0.2,
  density: 0.4,
  angularDamping: 0.2,
  surface: 'metal',
  explodes: { power: 1.35, radius: 19, speed: 64 },
})

/* ---------------------------------------------------------------- big -- */

{
  const { hx, hy, hz } = DIMS.dumpster
  def('dumpster', {
    category: 'big',
    name: { en: 'Dumpster', es: 'Contenedor de basura' },
    shape: openBox(hx, hy - 0.15, hz, 0.24, -hy + 0.3),
    mass: 350,
    friction: 0.6,
    restitution: 0.05,
    density: 1.6,
    surface: 'metal',
  })
}
def('fridge', {
  category: 'big',
  name: { en: 'Fridge', es: 'Refrigerador' },
  shape: box(DIMS.fridge.hx, DIMS.fridge.hy, DIMS.fridge.hz),
  mass: 80,
  friction: 0.5,
  restitution: 0.06,
  density: 0.8,
  surface: 'sheet',
})
def('vending', {
  category: 'big',
  name: { en: 'Vending machine', es: 'Máquina expendedora' },
  shape: box(DIMS.vending.hx, DIMS.vending.hy, DIMS.vending.hz),
  mass: 350,
  friction: 0.6,
  restitution: 0.04,
  density: 1.2,
  surface: 'metal',
})
{
  const y0 = -DIMS.lamp.h / 2
  def('streetlamp', {
    category: 'big',
    name: { en: 'Street lamp', es: 'Farola' },
    shape: compound([
      // the cast base is most of the iron, so it stands until pushed hard
      { shape: cyl(0.42, 0.36), at: [0, y0 + 0.36, 0], w: 6 },
      { shape: cyl(0.15, 4.5), at: [0, y0 + 5.1, 0] },
      { shape: box(1.1, 0.16, 0.28), at: [1.1, y0 + 9.45, 0] },
    ]),
    mass: 140,
    friction: 0.6,
    restitution: 0.05,
    density: 3,
    surface: 'metal',
  })
}
def('container', {
  category: 'big',
  name: { en: 'Shipping container', es: 'Contenedor de carga' },
  shape: box(DIMS.container.hx, DIMS.container.hy, DIMS.container.hz),
  mass: 2300,
  friction: 0.6,
  restitution: 0.02,
  density: 0.5,
  surface: 'metal',
})

/* ------------------------------------------------------------- lookup -- */

export const catalogueEntry = (id: string) => CATALOGUE.find((e) => e.id === id)
export const inCategory = (c: Category) => CATALOGUE.filter((e) => e.category === c)
