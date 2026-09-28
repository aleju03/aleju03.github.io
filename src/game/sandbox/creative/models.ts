import * as THREE from 'three'
import { model, propMaterial, type Paint } from '../art'
import { batchable } from '../batch'
import { BOARD, signGeometry } from './signs'

/*
  What the four creative props look like: a balloon, a floor lamp, a sign and
  a bundle of dynamite. Same rules as models.ts (chunky parts with real depth,
  the atlas's own cells, one merged geometry each, centred on the body's
  origin) and the same material, so none of them costs a program.

  The lamp and the sign each have more than one geometry, because their state
  is *which geometry the proxy draws* (batch.ts groups by geometry): the lamp
  has one with a burning bulb (the atlas's glowing `lit` cell) and one with a
  dead one, and the sign has one per text tile (signs.ts). `creative.ts` swaps
  the proxy's `geo`. The default `mesh()` of each kind is the lit lamp and the
  blank sign, which is also what the spawn menu's icons draw.

  The balloon is white gloss and the dynamite a red that paint tints, so a
  balloon's colour *is* its tint (tags.ts's paint index).
*/

const flat = (tint: string, cellName = 'white'): Paint => ({ cell: cellName, tint })

/* --------------------------------------------------------------- dims -- */

export const CDIMS = {
  balloon: { rx: 0.62, ry: 0.78, rz: 0.62, r: 0.7 },
  lamp: { rBase: 0.62, hBase: 0.18, hh: 1.8, shadeY: 1.4, bulbY: 1.0 },
  dynamite: { hx: 0.65, hy: 0.26, hz: 0.3 },
  sign: { post: 1.1, board: BOARD },
}

/* ------------------------------------------------------------ balloon -- */

const balloon = () => {
  const { rx, ry, rz } = CDIMS.balloon
  const m = model()
  m.ball([0, 0.1, 0], [rx, ry, rz], flat('#ffffff', 'gloss'), { w: 12, h: 9 })
  // the knot, and the ribbon hanging off it
  m.cyl([0, -ry + 0.02, 0], [0.09, 0.05], 0.16, flat('#ffffff', 'gloss'), { seg: 6 })
  m.box([0, -ry - 0.4, 0], [0.035, 0.85, 0.035], flat('#f4f0e8'))
  return m.mesh()
}

/* --------------------------------------------------------------- lamp -- */

const lampGeometry = (lit: boolean) => {
  const { rBase, hBase, shadeY, bulbY, hh } = CDIMS.lamp
  const iron = flat('#3d4046', 'gloss')
  const m = model()
  m.cyl([0, -hh + hBase / 2, 0], [rBase, rBase * 0.9], hBase, iron, { seg: 12 })
  m.cyl([0, -0.3, 0], 0.075, 2.9, iron, { seg: 8 })
  m.cyl([0, shadeY, 0], [0.64, 0.34], 0.8, flat('#e8dcc0'), { seg: 12 })
  // the shade's lip, so the outline pass draws its edge
  m.cyl([0, shadeY - 0.4, 0], [0.66, 0.66], 0.05, flat('#b9a983'), { seg: 12 })
  m.ball([0, bulbY, 0], [0.27, 0.27, 0.27], lit ? flat('#ffe6a8', 'lit') : flat('#cfc7b4'), { w: 8, h: 6 })
  return m.geometry()
}

let lampOn: THREE.BufferGeometry | null = null
let lampOff: THREE.BufferGeometry | null = null
export const lampGeometryOf = (on: boolean) =>
  on ? (lampOn ??= lampGeometry(true)) : (lampOff ??= lampGeometry(false))

const lamp = () => new THREE.Mesh(lampGeometryOf(true), propMaterial())

/* --------------------------------------------------------------- sign -- */

const sign = () => new THREE.Mesh(signGeometry(-1), propMaterial())

/* ----------------------------------------------------------- dynamite -- */

const dynamite = () => {
  const red = flat('#c23a2c')
  const dark = flat('#26262a')
  const m = model()
  const len = 1.3
  const rod = (y: number, z: number) => {
    m.cyl([0, y, z], 0.14, len, red, { seg: 8, rot: [0, 0, Math.PI / 2] })
    // the paper cap on each end
    for (const s of [-1, 1]) m.cyl([s * (len / 2 + 0.005), y, z], 0.115, 0.03, flat('#e8dcc0'), { seg: 8, rot: [0, 0, Math.PI / 2] })
  }
  rod(-0.11, -0.145)
  rod(-0.11, 0.145)
  rod(0.11, 0)
  // the tape round the middle, twice
  for (const x of [-0.3, 0.3]) m.box([x, 0, 0], [0.13, 0.66, 0.6], dark)
  // the fuse: a cord out of the top and a scorched tip
  m.box([0.05, 0.48, 0], [0.05, 0.4, 0.05], flat('#b9a983'))
  m.box([0.12, 0.7, 0], [0.16, 0.05, 0.05], flat('#b9a983'), [0, 0, 0.5])
  m.box([0.2, 0.74, 0], [0.09, 0.07, 0.07], flat('#3a302a'))
  return m.mesh()
}

/** the creative kinds' meshes, batched like every catalogue model */
export const CREATIVE_MODELS: Record<string, () => THREE.Object3D> = {
  balloon: () => batchable(balloon()),
  lamp: () => batchable(lamp()),
  sign: () => batchable(sign()),
  dynamite: () => batchable(dynamite()),
}
