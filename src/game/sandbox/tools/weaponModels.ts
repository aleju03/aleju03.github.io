import * as THREE from 'three'
import type { Geos, Mats } from './viewmodel'

/*
  The three weapons as models: a pistol, a crossbow and a rocket launcher,
  built the way the physgun and the tool gun are (viewmodel.ts) and on the
  very same materials, so a new gun costs geometry and not one program.

  Every gun keeps the grip the others share (0.08 by 0.26 by 0.11, leaning
  back 0.28 rad at the origin, the trigger and guard in front of it),
  because the first-person mitten (viewHand.ts) is one surface closed round
  that grip and nothing else; the rest of each gun is laid out from there,
  forward along -z, a little over a unit long at most.

  They are drawn for the pixel look. Silhouettes and creases are what get
  inked, so each gun is chunky slabs and eight-sided drums with real steps
  between them, and its parts are told apart by value rather than hue: a
  pale steel slide over a dark frame, a cream shoulder pad on a slate tube,
  a warm wooden stock under a dark rail. The one thing that glows on each is
  the thing it shoots: the crossbow's bolt has a hot orange tip, the
  rocket's nose sits in the tube's mouth, and every muzzle carries a flash
  that is hidden until a shot.

  What moves is named, so the viewmodel can animate it without knowing the
  shapes: the pistol's `slide` kicks back on a shot and the `mag` drops out
  of the grip on a reload; the crossbow's `string` runs from the latch to
  the limbs when it looses and back while it is spanned, and its `bolt`
  rides the rail until then; the launcher's `round` (the rocket in the
  tube's mouth) is gone after a shot and slides back in over the reload.
  `flash` is the muzzle flash on all three.
*/

export type WeaponModelId = 'pistol' | 'crossbow' | 'rocket'

export interface WeaponModel {
  root: THREE.Group
  /** where the shot leaves, in the model's frame */
  muzzle: THREE.Object3D
  /** the muzzle flash, hidden until a shot */
  flash: THREE.Object3D
  /** pistol: the slide (z moves back); crossbow: the string's middle (z);
      rocket: the round in the tube (z and visibility) */
  action: THREE.Object3D
  /** its resting z, so the viewmodel can offset from it */
  actionZ: number
  /** pistol: the magazine (y drops on reload); crossbow: the bolt on the
      rail (hidden once loosed); rocket: null */
  extra: THREE.Object3D | null
  extraY: number
  /** crossbow: the string's two halves, which the viewmodel re-aims at the
      middle as it moves */
  strings?: [THREE.Mesh, THREE.Mesh]
  /** crossbow: where each half is tied to its limb */
  tips?: [THREE.Vector3, THREE.Vector3]
}

type Add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent?: THREE.Object3D) => THREE.Mesh

const adder = (root: THREE.Object3D): Add => (geo, m, x, y, z, parent = root) => {
  const mesh = new THREE.Mesh(geo, m)
  mesh.position.set(x, y, z)
  parent.add(mesh)
  return mesh
}

/** the grip every gun shares, the trigger and its guard, and the mitten */
const grip = (g: Geos, mats: Mats, add: Add, hand: THREE.BufferGeometry | null) => {
  const gr = add(g.box(0.08, 0.26, 0.11), mats.rubber, 0, -0.1, 0.06)
  gr.rotation.x = -0.28
  add(g.box(0.025, 0.06, 0.03), mats.dark, 0, -0.03, -0.05)
  add(g.box(0.03, 0.02, 0.14), mats.dark, 0, -0.07, -0.04)
  if (hand) add(hand, mats.hand, 0, 0, 0)
}

/** a flash at a muzzle: a glowing cross of two slabs and a core, hidden */
const flashAt = (g: Geos, mats: Mats, add: Add, root: THREE.Object3D, x: number, y: number, z: number, s: number) => {
  const f = new THREE.Group()
  f.position.set(x, y, z)
  root.add(f)
  add(g.box(0.22 * s, 0.05 * s, 0.05 * s), mats.flash, 0, 0, -0.02 * s, f)
  add(g.box(0.05 * s, 0.22 * s, 0.05 * s), mats.flash, 0, 0, -0.02 * s, f)
  const core = add(g.drum(0.07 * s, 0.2 * s, 6, 0.03 * s), mats.flash, 0, 0, -0.1 * s, f)
  core.rotation.z = Math.PI / 6
  f.visible = false
  return f
}

const done = (root: THREE.Group) => {
  root.traverse((o) => {
    o.castShadow = false
    o.receiveShadow = false
  })
  return root
}

/**
 * The pistol: a boxy slide in pale steel over a dark frame, a stubby barrel
 * proud of the slide, ochre sights and hammer, wooden grip panels, and a
 * magazine base under the grip.
 */
export const buildPistol = (g: Geos, mats: Mats, hand: THREE.BufferGeometry | null): WeaponModel => {
  const root = new THREE.Group()
  const add = adder(root)
  // the frame: a dark slab under the slide, reaching forward to a squared
  // dust cover, with the trigger guard's front post
  add(g.box(0.1, 0.07, 0.4), mats.dark, 0, 0.03, -0.12)
  add(g.box(0.03, 0.08, 0.03), mats.dark, 0, -0.03, -0.12)
  // the slide, which kicks back on a shot: pale steel with a dark top strip,
  // serrations as three dark ribs at the back, and the sights
  const slide = new THREE.Group()
  slide.position.set(0, 0, 0)
  root.add(slide)
  add(g.box(0.115, 0.1, 0.48), mats.steel, 0, 0.115, -0.14, slide)
  add(g.box(0.06, 0.02, 0.44), mats.dark, 0, 0.17, -0.14, slide)
  for (const z of [0.03, 0.055, 0.08]) add(g.box(0.12, 0.07, 0.012), mats.dark, 0, 0.12, z, slide)
  add(g.box(0.025, 0.035, 0.03), mats.ochre, 0, 0.185, -0.36, slide)
  add(g.box(0.07, 0.03, 0.03), mats.dark, 0, 0.18, 0.07, slide)
  // the ejection port, a dark notch on the right
  add(g.box(0.01, 0.045, 0.1), mats.dark, 0.06, 0.13, -0.08, slide)
  // the barrel's crown standing out of the slide's nose
  add(g.drum(0.035, 0.06, 8), mats.dark, 0, 0.11, -0.4)
  // the hammer, cocked back over the grip
  const hammer = add(g.box(0.03, 0.05, 0.035), mats.ochre, 0, 0.16, 0.12)
  hammer.rotation.x = 0.5
  // wooden grip panels either side of the rubber, and the magazine's base
  for (const sx of [-1, 1]) {
    const panel = add(g.box(0.012, 0.18, 0.08), mats.wood, sx * 0.046, -0.09, 0.07)
    panel.rotation.x = -0.28
  }
  const mag = new THREE.Group()
  root.add(mag)
  const base = add(g.box(0.09, 0.03, 0.12), mats.dark, 0, -0.235, 0.1, mag)
  base.rotation.x = -0.28
  grip(g, mats, add, hand)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.11, -0.44)
  root.add(muzzle)
  const flash = flashAt(g, mats, add, root, 0, 0.11, -0.46, 1)
  return { root: done(root), muzzle, flash, action: slide, actionZ: 0, extra: mag, extraY: 0 }
}

/**
 * The crossbow: a wooden stock with a dark rail along it, two swept limbs
 * of dark steel at the front with ochre tips, a cream string drawn back to
 * the latch, a steel scope with a glowing lens, and a bolt on the rail whose
 * tip glows hot.
 */
export const buildCrossbow = (g: Geos, mats: Mats, hand: THREE.BufferGeometry | null): WeaponModel => {
  const root = new THREE.Group()
  const add = adder(root)
  // the stock: a long wooden body from the shoulder to the prod, a butt
  // that drops behind the grip, and a dark rail along the top
  add(g.box(0.13, 0.12, 0.62), mats.wood, 0, 0.07, -0.2)
  const butt = add(g.box(0.11, 0.2, 0.26), mats.wood, 0, 0.0, 0.2)
  butt.rotation.x = 0.35
  add(g.box(0.06, 0.03, 0.72), mats.dark, 0, 0.145, -0.28)
  // the prod's block at the front, and the stirrup under it
  add(g.box(0.17, 0.12, 0.1), mats.dark, 0, 0.1, -0.58)
  add(g.box(0.14, 0.02, 0.1), mats.steel, 0, 0.03, -0.7)
  for (const sx of [-1, 1]) add(g.box(0.02, 0.1, 0.02), mats.steel, sx * 0.065, 0.07, -0.7)
  // the limbs: three segments a side, swept back and out from the prod,
  // each thinner than the last, with an ochre cap on the tip
  const tips: THREE.Vector3[] = []
  for (const sx of [-1, 1]) {
    let x = sx * 0.07
    let z = -0.6
    const segs = [
      { len: 0.16, a: 0.25, t: 0.05 },
      { len: 0.15, a: 0.5, t: 0.04 },
      { len: 0.12, a: 0.85, t: 0.032 },
    ]
    for (const s of segs) {
      // outward, and swept back by `a`
      const dx = Math.cos(s.a) * s.len * sx
      const dz = Math.sin(s.a) * s.len
      const seg = add(g.box(s.len, s.t, 0.045), mats.dark, x + dx / 2, 0.12, z + dz / 2)
      seg.rotation.y = -Math.atan2(dz, Math.abs(dx)) * sx
      x += dx
      z += dz
    }
    add(g.box(0.04, 0.05, 0.04), mats.ochre, x, 0.12, z)
    tips.push(new THREE.Vector3(x, 0.12, z))
  }
  // the string: the middle is a small cream block at the latch that the
  // viewmodel slides forward on a shot; each half is re-aimed at it
  const nock = new THREE.Group()
  nock.position.set(0, 0.155, -0.18)
  root.add(nock)
  add(g.box(0.035, 0.025, 0.025), mats.cream, 0, 0, 0, nock)
  const strings = [0, 1].map(() => add(g.box(1, 0.014, 0.014), mats.cream, 0, 0.155, 0)) as [THREE.Mesh, THREE.Mesh]
  // the latch it catches on
  add(g.box(0.05, 0.04, 0.04), mats.steel, 0, 0.16, -0.14)
  // the scope, on two rings over the stock
  add(g.drum(0.045, 0.3, 8), mats.steel, 0, 0.26, -0.18)
  add(g.drum(0.055, 0.05, 8), mats.dark, 0, 0.26, -0.34)
  add(g.drum(0.035, 0.012, 8), mats.lens, 0, 0.26, -0.365)
  for (const z of [-0.26, -0.1]) add(g.box(0.03, 0.08, 0.03), mats.dark, 0, 0.2, z)
  // the bolt on the rail: a steel shaft, dark fletching and a hot tip
  const bolt = new THREE.Group()
  bolt.position.set(0, 0.175, 0)
  root.add(bolt)
  add(g.box(0.018, 0.018, 0.56), mats.steel, 0, 0, -0.44, bolt)
  for (const a of [0, Math.PI / 2]) {
    const fl = add(g.box(0.055, 0.008, 0.08), mats.dark, 0, 0, -0.2, bolt)
    fl.rotation.z = a
  }
  add(g.drum(0.001, 0.07, 6, 0.022), mats.hot, 0, 0, -0.74, bolt)
  grip(g, mats, add, hand)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.175, -0.78)
  root.add(muzzle)
  const flash = flashAt(g, mats, add, root, 0, 0.175, -0.78, 0.4)
  return {
    root: done(root), muzzle, flash, action: nock, actionZ: nock.position.z, extra: bolt, extraY: bolt.position.y,
    strings, tips: [tips[0], tips[1]],
  }
}

/**
 * The rocket launcher: a slate tube carried over the grip, flared dark at
 * both ends, a cream shoulder pad, a front grip, a folding sight on the
 * left, a band of ochre hazard stripes, and the round's ochre nose sitting
 * in the tube's mouth while it is loaded.
 */
export const buildLauncher = (g: Geos, mats: Mats, hand: THREE.BufferGeometry | null): WeaponModel => {
  const root = new THREE.Group()
  const add = adder(root)
  const Y = 0.24
  // the tube, and a thicker dark sleeve over its middle
  add(g.drum(0.1, 1.05, 8), mats.slate, 0, Y, -0.2)
  add(g.drum(0.118, 0.34, 8), mats.dark, 0, Y, -0.08)
  // the mouth: a flared collar, and the venturi behind flaring the other way
  add(g.drum(0.135, 0.08, 8, 0.108), mats.dark, 0, Y, -0.73)
  add(g.drum(0.1, 0.1, 8, 0.13), mats.dark, 0, Y, 0.37)
  // hazard band: two ochre rings near the front
  for (const z of [-0.5, -0.58]) add(g.drum(0.106, 0.03, 8), mats.ochre, 0, Y, z)
  // the shoulder pad under the back of the tube
  add(g.box(0.13, 0.08, 0.2), mats.cream, 0, Y - 0.12, 0.2)
  // the body the grip hangs off, and a front grip under the tube
  add(g.box(0.1, 0.12, 0.26), mats.dark, 0, 0.08, -0.02)
  const fg = add(g.box(0.07, 0.18, 0.08), mats.rubber, 0, 0.07, -0.42)
  fg.rotation.x = -0.15
  // the sight: a steel post and a hooded glass on the left of the tube
  add(g.box(0.03, 0.12, 0.04), mats.steel, -0.13, Y + 0.05, -0.28)
  add(g.box(0.07, 0.07, 0.08), mats.dark, -0.13, Y + 0.13, -0.28)
  add(g.box(0.05, 0.045, 0.01), mats.lens, -0.13, Y + 0.13, -0.235)
  // the round: an ochre nose cone and a dark band, just proud of the mouth
  const round = new THREE.Group()
  round.position.set(0, Y, -0.76)
  root.add(round)
  add(g.drum(0.082, 0.06, 8), mats.dark, 0, 0, 0.03, round)
  add(g.drum(0.001, 0.2, 8, 0.082), mats.ochre, 0, 0, -0.1, round)
  grip(g, mats, add, hand)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, Y, -0.8)
  root.add(muzzle)
  const flash = flashAt(g, mats, add, root, 0, Y, 0.47, 1.1)
  // (the flash at the back: a launcher's blast leaves by the venturi)
  flash.rotation.y = Math.PI
  return { root: done(root), muzzle, flash, action: round, actionZ: round.position.z, extra: null, extraY: 0 }
}

export const buildWeapon = (id: WeaponModelId, g: Geos, mats: Mats, hand: THREE.BufferGeometry | null) =>
  id === 'pistol' ? buildPistol(g, mats, hand) : id === 'crossbow' ? buildCrossbow(g, mats, hand) : buildLauncher(g, mats, hand)

/** point a crossbow's two string halves from their limb tips to the nock */
const sa = new THREE.Vector3()
const sb = new THREE.Vector3()
export const aimStrings = (m: WeaponModel) => {
  if (!m.strings || !m.tips) return
  const nock = m.action.position
  for (let i = 0; i < 2; i++) {
    const s = m.strings[i]
    sa.copy(m.tips[i])
    sb.set(nock.x, nock.y, nock.z)
    s.position.copy(sa).add(sb).multiplyScalar(0.5)
    const len = sa.distanceTo(sb)
    s.scale.set(len, 1, 1)
    s.rotation.set(0, -Math.atan2(sb.z - sa.z, sb.x - sa.x), 0)
  }
}
