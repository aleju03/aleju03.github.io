import { CATALOGUE, type Category, type Names } from '../catalogue'
import { registerKind, type PropKind, type ShapeSpec } from '../kinds'
import { BOARD } from './signs'
import { CDIMS, CREATIVE_MODELS } from './models'

/*
  The creative props' physics and their place in the menu: a balloon, a lamp,
  a sign and a stick of dynamite, registered into the kind table beside the
  forty-two of catalogue.ts (which they follow: this module is imported after
  it, from creative.ts).

  What they do beyond being rigid bodies is creative.ts's business: the
  balloon's lift, the lamp's switch and pool, the sign's tile, the dynamite's
  five-second fuse (breakables.ts already knows fuses; the kind only says how
  long). The numbers here are the bodies: a balloon is a light ball that pops
  at a change of velocity of 9 u/s, a lamp a weighted base under a pole and a
  shade so it stands, a sign a board on two posts, a bundle of dynamite a
  small box that blows harder than a barrel.
*/

type Def = Omit<PropKind, 'id' | 'label' | 'mesh'> & { category: Category; name: Names }

const def = (id: string, d: Def) => {
  const { category, name, ...k } = d
  registerKind({ id, label: name.en.toLowerCase(), mesh: CREATIVE_MODELS[id], ...k })
  CATALOGUE.push({ id, category, name })
}

def('balloon', {
  category: 'fun',
  name: { en: 'Balloon', es: 'Globo' },
  shape: { type: 'ball', r: CDIMS.balloon.r },
  mass: 1.5,
  friction: 0.3,
  restitution: 0.45,
  // helium is creative.ts's force; in the sea it simply floats
  density: 0.05,
  linearDamping: 0.5,
  angularDamping: 1.6,
  surface: 'rubber',
  breaks: { speed: 9 },
})

const L = CDIMS.lamp
def('lamp', {
  category: 'fun',
  name: { en: 'Lamp', es: 'Lámpara' },
  shape: {
    type: 'compound',
    parts: [
      { shape: { type: 'cylinder', r: L.rBase, hh: L.hBase / 2 }, at: [0, -L.hh + L.hBase / 2, 0], w: 7 },
      { shape: { type: 'box', hx: 0.08, hy: 1.45, hz: 0.08 }, at: [0, -0.3, 0] },
      { shape: { type: 'cylinder', r: 0.5, hh: 0.4 }, at: [0, L.shadeY, 0] },
    ],
  } satisfies ShapeSpec,
  mass: 6,
  friction: 0.5,
  restitution: 0.12,
  density: 0.5,
  surface: 'metal',
})

const B = BOARD
def('sign', {
  category: 'fun',
  name: { en: 'Sign', es: 'Letrero' },
  shape: {
    type: 'compound',
    parts: [
      { shape: { type: 'box', hx: B.w / 2, hy: B.h / 2, hz: B.d / 2 }, at: [0, 0.72, 0] },
      { shape: { type: 'box', hx: 0.12, hy: CDIMS.sign.post / 2, hz: 0.1 }, at: [-(B.w / 2 - 0.5), -0.55, 0] },
      { shape: { type: 'box', hx: 0.12, hy: CDIMS.sign.post / 2, hz: 0.1 }, at: [B.w / 2 - 0.5, -0.55, 0] },
    ],
  } satisfies ShapeSpec,
  mass: 14,
  friction: 0.5,
  restitution: 0.15,
  density: 0.45,
  surface: 'wood',
})

const D = CDIMS.dynamite
def('dynamite', {
  category: 'explosive',
  name: { en: 'Dynamite', es: 'Dinamita' },
  shape: { type: 'box', hx: D.hx, hy: D.hy, hz: D.hz },
  mass: 1.8,
  friction: 0.6,
  restitution: 0.1,
  density: 0.9,
  surface: 'soft',
  // a barrel's threshold (a pistol shot lights it), a bigger bang, and a
  // fuse of a length you can run from
  explodes: { power: 2, radius: 21, speed: 56, fuse: 5 },
})
