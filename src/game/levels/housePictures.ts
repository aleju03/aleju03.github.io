import * as THREE from 'three'
import { canvasTexture } from '../core/textures'
import { seeded } from '../core/rand'
import { texelate } from '../render/texel'

/*
  The pictures on the house's walls, painted: the family photos over the
  television and along the upper hall, a school portrait, a landscape, a
  framed certificate, the teen's posters (a band, a planet, a skater, a
  monster movie) and the den's arcade shooter, plus a crayon drawing and a
  dog snapshot for the fridge door.

  All of them share one canvas atlas and one material, so every picture in
  the house is a quad in one merged draw (the fridge's two ride its door as a
  second, small mesh on the same material). Each is painted at PX texels per
  world unit and texelated, so up close it is square pixels like everything
  else and at walking distance it averages down through its mipmaps. The
  look has a few hundred lines, so the paint is big shapes in flat colour
  separated by value: a person is a head, a shirt and two legs, a band is
  four silhouettes under two beams, and nothing depends on detail finer than
  a couple of texels. There is no text anywhere, because a word would need
  both languages; where a picture wants words (a certificate, a poster's
  title, a signature) it gets handwriting squiggles or a row of blocks.

  Usage is two steps, because the fridge's pictures are hung long after the
  walls: `place()` every picture first (it reserves a rect on the atlas and
  returns its UVs), then `paint()` once, which draws them all and returns
  the texture.
*/

/** texels per world unit on the atlas */
const PX = 40
const ATLAS = 512
const GAP = 4

export type PictureId =
  | 'school' | 'beach' | 'wedding' | 'birthday' | 'certificate' | 'lake'
  | 'space' | 'band' | 'skate' | 'monster' | 'arcade' | 'crayon' | 'dog'

/** where a picture landed on the atlas, in UV space (v up) */
export interface UvRect {
  u0: number
  v0: number
  u1: number
  v1: number
}

type Ctx = CanvasRenderingContext2D
type Paint = (c: Ctx, w: number, h: number, r: () => number) => void

/* ------------------------------------------------------------- the pen -- */

const rect = (c: Ctx, x: number, y: number, w: number, h: number, col: string) => {
  c.fillStyle = col
  c.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))
}
const disc = (c: Ctx, x: number, y: number, r: number, col: string) => {
  c.fillStyle = col
  c.beginPath()
  c.arc(x, y, Math.max(0.6, r), 0, Math.PI * 2)
  c.fill()
}
const poly = (c: Ctx, pts: number[], col: string) => {
  c.fillStyle = col
  c.beginPath()
  c.moveTo(pts[0], pts[1])
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1])
  c.closePath()
  c.fill()
}
const line = (c: Ctx, pts: number[], col: string, lw = 1) => {
  c.strokeStyle = col
  c.lineWidth = lw
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  c.moveTo(pts[0], pts[1])
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1])
  c.stroke()
}
/** bands of colour top to bottom: [colour, fraction of the height]... */
const bands = (c: Ctx, w: number, h: number, stops: Array<[string, number]>) => {
  let y = 0
  for (const [col, f] of stops) {
    rect(c, 0, y, w, h * f + 1, col)
    y += h * f
  }
}
/** handwriting: a wobbly line of loops, for words nobody has to read */
const scrawl = (c: Ctx, x0: number, x1: number, y: number, amp: number, col: string, r: () => number, lw = 1) => {
  const pts: number[] = []
  for (let x = x0; x <= x1; x += 1.5) {
    pts.push(x, y + Math.sin(x * 1.3 + r() * 0.8) * amp * (0.5 + r() * 0.6))
  }
  line(c, pts, col, lw)
}

/** a person standing, drawn from the feet up */
const person = (
  c: Ctx, x: number, foot: number, ht: number,
  shirt: string, legs: string, skin: string, hair: string,
) => {
  const hr = ht * 0.12
  const headY = foot - ht + hr
  const tw = ht * 0.34
  const hip = foot - ht * 0.44
  // legs, a hair apart
  const lw = tw * 0.42
  rect(c, x - tw / 2 + 0.5, hip, lw, foot - hip, legs)
  rect(c, x + tw / 2 - lw - 0.5, hip, lw, foot - hip, legs)
  // arms, then the body over their shoulders
  rect(c, x - tw / 2 - ht * 0.08, headY + hr * 1.3, ht * 0.09, ht * 0.34, skin)
  rect(c, x + tw / 2 - ht * 0.01, headY + hr * 1.3, ht * 0.09, ht * 0.34, skin)
  rect(c, x - tw / 2, headY + hr * 1.1, tw, hip - headY - hr * 1.1 + 1, shirt)
  disc(c, x, headY - hr * 0.2, hr * 1.02, hair)
  disc(c, x, headY + hr * 0.12, hr * 0.86, skin)
}

/* ------------------------------------------------------------ pictures -- */

const PAINT: Record<PictureId, Paint> = {
  /** a school portrait on the mottled blue studio backdrop */
  school: (c, w, h, r) => {
    rect(c, 0, 0, w, h, '#56708f')
    for (let i = 0; i < 40; i++) {
      disc(c, r() * w, r() * h, 2 + r() * 5, r() < 0.5 ? 'rgba(120,150,190,0.35)' : 'rgba(40,56,80,0.35)')
    }
    poly(c, [w * 0.08, h, w * 0.92, h, w * 0.74, h * 0.72, w * 0.26, h * 0.72], '#b23c34')
    poly(c, [w * 0.4, h * 0.72, w * 0.6, h * 0.72, w * 0.5, h * 0.84], '#ece6da')
    rect(c, w * 0.43, h * 0.6, w * 0.14, h * 0.14, '#d9a67e')
    disc(c, w * 0.5, h * 0.39, w * 0.25, '#3e2718')
    disc(c, w * 0.5, h * 0.46, w * 0.2, '#e0b08a')
    rect(c, w * 0.4, h * 0.45, 1.5, 1.5, '#3a2618')
    rect(c, w * 0.58, h * 0.45, 1.5, 1.5, '#3a2618')
    line(c, [w * 0.43, h * 0.53, w * 0.5, h * 0.555, w * 0.57, h * 0.53], '#b8705e', 1)
  },
  /** the family at the beach: sky, sea, sand, four of them and a parasol */
  beach: (c, w, h, r) => {
    bands(c, w, h, [['#7fb6d8', 0.26], ['#a9cfe2', 0.18], ['#2e78a2', 0.16], ['#e2c98e', 0.4]])
    disc(c, w * 0.82, h * 0.14, h * 0.08, '#fff0b4')
    for (let i = 0; i < 5; i++) rect(c, r() * w * 0.9, h * (0.47 + r() * 0.1), 4 + r() * 5, 1, '#d8ecf2')
    rect(c, w * 0.13, h * 0.42, 1.5, h * 0.46, '#5a4a3a')
    c.save()
    c.beginPath()
    c.arc(w * 0.135, h * 0.44, w * 0.12, Math.PI, 0)
    c.clip()
    for (let i = 0; i < 6; i++) rect(c, w * 0.015 + i * w * 0.04, h * 0.3, w * 0.04, h * 0.2, i % 2 ? '#f2eee4' : '#c8402f')
    c.restore()
    const foot = h * 0.9
    person(c, w * 0.36, foot, h * 0.52, '#2d5c93', '#2d5c93', '#d69f76', '#3a2618')
    person(c, w * 0.52, foot, h * 0.46, '#c8402f', '#d69f76', '#d69f76', '#6a4424')
    person(c, w * 0.66, foot, h * 0.33, '#e6b93a', '#2e7a4a', '#dca985', '#3a2618')
    person(c, w * 0.78, foot, h * 0.27, '#d86a9a', '#d86a9a', '#dca985', '#8a5a2a')
  },
  /** the parents' wedding, gone warm with age */
  wedding: (c, w, h) => {
    rect(c, 0, 0, w, h, '#b9a78a')
    disc(c, w * 0.5, h * 0.42, w * 0.55, '#cdbd9f')
    rect(c, 0, h * 0.86, w, h * 0.14, '#8e7c62')
    // him: a dark suit
    rect(c, w * 0.18, h * 0.38, w * 0.3, h * 0.6, '#262830')
    poly(c, [w * 0.27, h * 0.38, w * 0.39, h * 0.38, w * 0.33, h * 0.56], '#efe9dc')
    disc(c, w * 0.33, h * 0.28, w * 0.1, '#3a2618')
    disc(c, w * 0.33, h * 0.31, w * 0.085, '#d8a882')
    // her: the dress and a veil
    poly(c, [w * 0.58, h * 0.38, w * 0.74, h * 0.38, w * 0.9, h, w * 0.44, h], '#f4f1ea')
    disc(c, w * 0.66, h * 0.29, w * 0.1, '#6a4424')
    disc(c, w * 0.66, h * 0.32, w * 0.085, '#e0b08a')
    poly(c, [w * 0.6, h * 0.22, w * 0.76, h * 0.24, w * 0.84, h * 0.62, w * 0.72, h * 0.5], 'rgba(250,248,242,0.55)')
    disc(c, w * 0.56, h * 0.58, w * 0.06, '#b8323a')
    disc(c, w * 0.6, h * 0.61, w * 0.045, '#d8a040')
  },
  /** a birthday, flash-lit: the cake and its candles, party hats, balloons */
  birthday: (c, w, h) => {
    rect(c, 0, 0, w, h, '#3b2b25')
    rect(c, 0, h * 0.7, w, h * 0.3, '#8a5a36')
    const hats = ['#2d6fc0', '#e0b030', '#2e9a5a']
    ;[0.24, 0.5, 0.76].forEach((fx, i) => {
      const x = w * fx
      const y = h * (i === 1 ? 0.4 : 0.44)
      rect(c, x - w * 0.1, y + w * 0.08, w * 0.2, h * 0.3, ['#c8402f', '#f2eee4', '#7a4ab0'][i])
      disc(c, x, y, w * 0.09, '#e6b890')
      poly(c, [x - w * 0.07, y - w * 0.05, x + w * 0.07, y - w * 0.05, x, y - w * 0.26], hats[i])
      rect(c, x - 1, y - w * 0.18, 2, 2, '#f2eee4')
      rect(c, x - w * 0.035, y - 1, 2, 2, '#2a1a12')
      rect(c, x + w * 0.02, y - 1, 2, 2, '#2a1a12')
    })
    rect(c, w * 0.28, h * 0.62, w * 0.44, h * 0.16, '#f0e4d4')
    rect(c, w * 0.28, h * 0.62, w * 0.44, h * 0.04, '#d8648a')
    for (let i = 0; i < 5; i++) {
      const x = w * (0.33 + i * 0.085)
      rect(c, x, h * 0.55, 1.5, h * 0.07, '#8ac0e8')
      disc(c, x + 0.7, h * 0.535, 1.6, '#ffd070')
    }
    for (const [fx, fy, col] of [[0.1, 0.12, '#c8402f'], [0.88, 0.1, '#2d6fc0'], [0.92, 0.26, '#e0b030']] as const) {
      disc(c, w * fx, h * fy, w * 0.08, col)
      line(c, [w * fx, h * fy + w * 0.08, w * fx + 2, h * 0.4], '#d8d0c0', 0.8)
    }
  },
  /** a certificate: a border, a seal, and writing nobody needs to read */
  certificate: (c, w, h, r) => {
    rect(c, 0, 0, w, h, '#efe6cc')
    c.strokeStyle = '#2a4a7a'
    c.lineWidth = 1.5
    c.strokeRect(2.5, 2.5, w - 5, h - 5)
    c.lineWidth = 0.8
    c.strokeRect(5, 5, w - 10, h - 10)
    scrawl(c, w * 0.2, w * 0.8, h * 0.2, 2.2, '#1e3a66', r, 1.8)
    for (let i = 0; i < 3; i++) scrawl(c, w * 0.18, w * (0.82 - i * 0.06), h * (0.38 + i * 0.1), 1, '#5a4a3a', r, 0.8)
    disc(c, w * 0.26, h * 0.76, w * 0.1, '#c9a13a')
    disc(c, w * 0.26, h * 0.76, w * 0.06, '#e2c060')
    poly(c, [w * 0.2, h * 0.82, w * 0.24, h * 0.82, w * 0.2, h * 0.95], '#b8323a')
    poly(c, [w * 0.28, h * 0.82, w * 0.32, h * 0.82, w * 0.33, h * 0.95], '#b8323a')
    rect(c, w * 0.52, h * 0.82, w * 0.34, 1, '#5a4a3a')
    scrawl(c, w * 0.55, w * 0.82, h * 0.77, 2.5, '#1e3a66', r, 1)
  },
  /** a painted landscape: mountains, a lake, pines */
  lake: (c, w, h) => {
    bands(c, w, h, [['#8fb6d2', 0.18], ['#b4cad8', 0.14], ['#e2d2ae', 0.1], ['#4a7a9a', 0.58]])
    poly(c, [0, h * 0.44, w * 0.3, h * 0.16, w * 0.55, h * 0.4, w * 0.78, h * 0.2, w, h * 0.38, w, h * 0.44], '#6a7894')
    poly(c, [w * 0.22, h * 0.23, w * 0.3, h * 0.16, w * 0.37, h * 0.22], '#f2f0ea')
    poly(c, [w * 0.72, h * 0.25, w * 0.78, h * 0.2, w * 0.84, h * 0.25], '#f2f0ea')
    poly(c, [0, h * 0.44, w * 0.18, h * 0.32, w * 0.42, h * 0.44], '#44526c')
    rect(c, 0, h * 0.44, w, h * 0.03, '#56663a')
    for (let i = 0; i < 6; i++) rect(c, w * 0.3 + i * 5, h * (0.52 + i * 0.05), w * 0.3, 1, '#7aa4bc')
    for (const [fx, s] of [[0.06, 1], [0.16, 0.8], [0.88, 1.1], [0.97, 0.85]] as const) {
      const x = w * fx
      const base = h * 0.98
      const th = h * 0.5 * s
      rect(c, x - 1, base - th * 0.15, 2, th * 0.15, '#3a2a1c')
      for (let k = 0; k < 3; k++) {
        const y = base - th * (0.12 + k * 0.28)
        const hw = w * 0.1 * s * (1 - k * 0.25)
        poly(c, [x - hw, y, x + hw, y, x, y - th * 0.38], '#24402c')
      }
    }
    rect(c, 0, h * 0.94, w, h * 0.06, '#3a4a2a')
  },
  /** the planet poster: a ringed world in a starfield */
  space: (c, w, h, r) => {
    rect(c, 0, 0, w, h, '#0f1830')
    for (let i = 0; i < 70; i++) rect(c, r() * w, r() * h, 1, 1, r() < 0.2 ? '#ffe7a0' : '#e8ecf4')
    const cx = w * 0.5
    const cy = h * 0.42
    const R = w * 0.3
    c.save()
    c.translate(cx, cy)
    c.rotate(-0.35)
    c.strokeStyle = '#e8dcc0'
    c.lineWidth = 3
    c.beginPath()
    c.ellipse(0, 0, R * 1.7, R * 0.42, 0, Math.PI, Math.PI * 2)
    c.stroke()
    c.restore()
    disc(c, cx, cy, R, '#e0b448')
    c.save()
    c.beginPath()
    c.arc(cx, cy, R, 0, Math.PI * 2)
    c.clip()
    for (let i = 0; i < 4; i++) rect(c, cx - R, cy - R * 0.7 + i * R * 0.42, R * 2, R * 0.14, '#c08a34')
    disc(c, cx + R * 0.45, cy + R * 0.45, R * 0.9, 'rgba(10,16,40,0.35)')
    c.restore()
    c.save()
    c.translate(cx, cy)
    c.rotate(-0.35)
    c.strokeStyle = '#e8dcc0'
    c.lineWidth = 3
    c.beginPath()
    c.ellipse(0, 0, R * 1.7, R * 0.42, 0, 0, Math.PI)
    c.stroke()
    c.restore()
    disc(c, w * 0.2, h * 0.16, w * 0.05, '#b8bcc8')
    rect(c, w * 0.12, h * 0.8, w * 0.76, h * 0.07, '#e8ecf4')
    for (let i = 0; i < 6; i++) rect(c, w * (0.16 + i * 0.12), h * 0.91, w * 0.08, 2, '#6a7898')
  },
  /** the band poster: four silhouettes under two beams, a jagged logo */
  band: (c, w, h, r) => {
    rect(c, 0, 0, w, h, '#8c1f2a')
    poly(c, [w * 0.18, 0, w * 0.3, 0, w * 0.55, h * 0.8, w * 0.1, h * 0.8], 'rgba(255,214,110,0.28)')
    poly(c, [w * 0.7, 0, w * 0.82, 0, w * 0.9, h * 0.8, w * 0.45, h * 0.8], 'rgba(255,214,110,0.28)')
    // the logo: lightning-cut blocks across the top
    const L = '#ece2cc'
    poly(c, [w * 0.08, h * 0.06, w * 0.92, h * 0.04, w * 0.86, h * 0.1, w * 0.95, h * 0.1,
      w * 0.6, h * 0.18, w * 0.64, h * 0.13, w * 0.1, h * 0.16, w * 0.16, h * 0.11], L)
    const ink = '#141012'
    rect(c, 0, h * 0.8, w, h * 0.2, ink)
    // drums at the back
    disc(c, w * 0.5, h * 0.66, w * 0.12, ink)
    disc(c, w * 0.34, h * 0.56, w * 0.06, ink)
    disc(c, w * 0.66, h * 0.56, w * 0.06, ink)
    // singer at the mic, guitar and bass either side
    person(c, w * 0.5, h * 0.82, h * 0.34, ink, ink, ink, ink)
    rect(c, w * 0.62, h * 0.52, 1.5, h * 0.3, ink)
    person(c, w * 0.2, h * 0.82, h * 0.32, ink, ink, ink, ink)
    line(c, [w * 0.08, h * 0.7, w * 0.36, h * 0.6], ink, 2.5)
    poly(c, [w * 0.12, h * 0.66, w * 0.24, h * 0.64, w * 0.22, h * 0.74, w * 0.1, h * 0.74], ink)
    person(c, w * 0.8, h * 0.82, h * 0.33, ink, ink, ink, ink)
    line(c, [w * 0.66, h * 0.62, w * 0.95, h * 0.69], ink, 2.5)
    for (let i = 0; i < 3; i++) scrawl(c, w * 0.1, w * 0.9, h * (0.86 + i * 0.045), 0.7, '#b8a888', r, 0.8)
  },
  /** a skater over the lip of a ramp against a sunset */
  skate: (c, w, h) => {
    bands(c, w, h, [['#5c3a70', 0.18], ['#b8506a', 0.2], ['#e07a4a', 0.2], ['#f0b048', 0.42]])
    disc(c, w * 0.5, h * 0.66, w * 0.32, '#ffd878')
    rect(c, 0, h * 0.8, w, h * 0.2, '#1c1418')
    poly(c, [0, h * 0.8, 0, h * 0.62, w * 0.12, h * 0.7, w * 0.2, h * 0.8], '#1c1418')
    poly(c, [w, h * 0.8, w, h * 0.6, w * 0.88, h * 0.7, w * 0.8, h * 0.8], '#1c1418')
    const ink = '#1c1418'
    const x = w * 0.5
    const y = h * 0.34
    disc(c, x + w * 0.03, y - h * 0.09, w * 0.06, ink)
    poly(c, [x - w * 0.06, y - h * 0.04, x + w * 0.1, y - h * 0.06, x + w * 0.06, y + h * 0.08, x - w * 0.05, y + h * 0.07], ink)
    line(c, [x - w * 0.04, y - h * 0.03, x - w * 0.24, y - h * 0.1], ink, 2.5)
    line(c, [x + w * 0.08, y - h * 0.05, x + w * 0.26, y - h * 0.12], ink, 2.5)
    line(c, [x - w * 0.03, y + h * 0.07, x - w * 0.12, y + h * 0.14], ink, 3)
    line(c, [x + w * 0.05, y + h * 0.07, x + w * 0.1, y + h * 0.15], ink, 3)
    line(c, [x - w * 0.2, y + h * 0.13, x + w * 0.2, y + h * 0.19], ink, 3)
  },
  /** a monster movie: a city skyline and what is rising behind it */
  monster: (c, w, h, r) => {
    rect(c, 0, 0, w, h, '#33264f')
    disc(c, w * 0.78, h * 0.16, w * 0.1, '#e8dcc0')
    const M = '#e06a2a'
    poly(c, [w * 0.18, h, w * 0.26, h * 0.42, w * 0.34, h * 0.3, w * 0.44, h * 0.24, w * 0.6, h * 0.28,
      w * 0.7, h * 0.44, w * 0.8, h], M)
    for (let i = 0; i < 5; i++) {
      const x = w * (0.3 + i * 0.08)
      const y = h * (0.28 + Math.abs(i - 1.5) * 0.03)
      poly(c, [x - 3, y + 2, x + 3, y + 2, x, y - 6], M)
    }
    rect(c, w * 0.44, h * 0.32, 3, 2, '#fff26a')
    rect(c, w * 0.54, h * 0.32, 3, 2, '#fff26a')
    let x = 0
    while (x < w) {
      const bw = 5 + r() * 8
      const bh = h * (0.14 + r() * 0.22)
      rect(c, x, h - bh, bw, bh, '#120c1c')
      for (let k = 0; k < 6; k++) if (r() < 0.5) rect(c, x + 1 + r() * (bw - 2), h - bh + 2 + r() * (bh - 4), 1, 1, '#f0c850')
      x += bw
    }
    for (let i = 0; i < 5; i++) rect(c, w * (0.1 + i * 0.165), h * 0.05, w * 0.13, h * 0.07, '#ece2cc')
  },
  /** the den's arcade poster: ranks of invaders, a ship, a burst */
  arcade: (c, w, h, r) => {
    rect(c, 0, 0, w, h, '#121216')
    for (let i = 0; i < 50; i++) rect(c, r() * w, r() * h, 1, 1, '#8a8ea8')
    const SPRITE = ['00100100', '00111100', '01111110', '11011011', '11111111', '01000010', '10000001']
    const sp = Math.max(1, Math.floor(w / 36))
    const cols = ['#e04ac0', '#4ae07a', '#e0d04a']
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 4; k++) {
        const ox = w * 0.1 + k * (w * 0.21)
        const oy = h * 0.1 + row * h * 0.12
        SPRITE.forEach((bits, j) => {
          for (let b = 0; b < 8; b++) if (bits[b] === '1') rect(c, ox + b * sp, oy + j * sp, sp, sp, cols[row])
        })
      }
    }
    const sx = w * 0.46
    poly(c, [sx - w * 0.1, h * 0.86, sx + w * 0.1, h * 0.86, sx, h * 0.76], '#4ac8e0')
    rect(c, sx - 1, h * 0.52, 2, h * 0.22, '#f2f0ea')
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      line(c, [w * 0.7, h * 0.5, w * 0.7 + Math.cos(a) * w * 0.09, h * 0.5 + Math.sin(a) * w * 0.09], '#f08a2a', 2)
    }
    disc(c, w * 0.7, h * 0.5, w * 0.04, '#ffe070')
    c.strokeStyle = '#e03a3a'
    c.lineWidth = 2
    c.strokeRect(1, 1, w - 2, h - 2)
    rect(c, 0, h * 0.9, w, h * 0.1, '#e03a3a')
  },
  /** the kid's crayon drawing: house, sun, the family holding hands */
  crayon: (c, w, h, r) => {
    rect(c, 0, 0, w, h, '#fbf7e8')
    const zig = (x0: number, x1: number, y0: number, y1: number, col: string, step = 2.2) => {
      const pts: number[] = []
      let up = true
      for (let x = x0; x <= x1; x += step) {
        pts.push(x, up ? y0 + r() : y1 - r())
        up = !up
      }
      line(c, pts, col, 1.3)
    }
    zig(0, w, 0, h * 0.14, '#5a8ae0')
    zig(0, w, h * 0.84, h, '#3aa04a')
    disc(c, w * 0.86, h * 0.2, h * 0.1, '#f0c020')
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      line(c, [w * 0.86 + Math.cos(a) * h * 0.13, h * 0.2 + Math.sin(a) * h * 0.13,
        w * 0.86 + Math.cos(a) * h * 0.2, h * 0.2 + Math.sin(a) * h * 0.2], '#f0c020', 1.2)
    }
    zig(w * 0.1, w * 0.4, h * 0.46, h * 0.84, '#d8403a', 1.8)
    poly(c, [w * 0.06, h * 0.48, w * 0.44, h * 0.48, w * 0.25, h * 0.26], '#8a5a2a')
    rect(c, w * 0.22, h * 0.66, w * 0.07, h * 0.18, '#3a2a6a')
    const fam: Array<[number, number, string]> = [[0.54, 0.44, '#2d5cc0'], [0.66, 0.4, '#c040a0'], [0.76, 0.28, '#e07020'], [0.86, 0.24, '#3aa04a']]
    for (const [fx, sz, col] of fam) {
      const x = w * fx
      const foot = h * 0.84
      const top = foot - h * sz
      c.strokeStyle = col
      c.lineWidth = 1.1
      c.beginPath()
      c.arc(x, top + h * 0.05, h * 0.045, 0, Math.PI * 2)
      c.stroke()
      line(c, [x, top + h * 0.1, x, foot - h * sz * 0.4], col, 1.1)
      line(c, [x - 3, foot, x, foot - h * sz * 0.4, x + 3, foot], col, 1.1)
      line(c, [x - 5, top + h * 0.16, x + 5, top + h * 0.16], col, 1.1)
    }
  },
  /** a snapshot of the dog, white border and all */
  dog: (c, w, h) => {
    rect(c, 0, 0, w, h, '#f4f0e6')
    const x0 = 2
    const y0 = 2
    const iw = w - 4
    const ih = h - 7
    rect(c, x0, y0, iw, ih * 0.4, '#8fc0de')
    rect(c, x0, y0 + ih * 0.4, iw, ih * 0.6, '#5a9a44')
    const cx = x0 + iw * 0.5
    const cy = y0 + ih * 0.62
    c.fillStyle = '#9a6030'
    c.beginPath()
    c.ellipse(cx, cy, iw * 0.3, ih * 0.14, 0, 0, Math.PI * 2)
    c.fill()
    rect(c, cx - iw * 0.24, cy, 2, ih * 0.2, '#9a6030')
    rect(c, cx + iw * 0.2, cy, 2, ih * 0.2, '#9a6030')
    disc(c, cx + iw * 0.28, cy - ih * 0.14, iw * 0.14, '#9a6030')
    disc(c, cx + iw * 0.2, cy - ih * 0.13, iw * 0.07, '#5a3418')
    rect(c, cx + iw * 0.32, cy - ih * 0.17, 1.5, 1.5, '#1a1210')
    line(c, [cx - iw * 0.3, cy - 1, cx - iw * 0.42, cy - ih * 0.12], '#9a6030', 1.5)
  },
}

export interface PictureAtlas {
  /** reserve a picture `w` by `h` world units; returns where it lands */
  place: (id: PictureId, w: number, h: number) => UvRect
  /** paint everything placed, once, and hand back the texture */
  paint: () => THREE.CanvasTexture
}

export const createPictureAtlas = (): PictureAtlas => {
  const jobs: Array<{ id: PictureId; x: number; y: number; w: number; h: number }> = []
  let sx = 0
  let sy = 0
  let rowH = 0
  const place = (id: PictureId, w: number, h: number): UvRect => {
    const pw = Math.max(8, Math.round(w * PX))
    const ph = Math.max(8, Math.round(h * PX))
    if (sx + pw > ATLAS) {
      sx = 0
      sy += rowH + GAP
      rowH = 0
    }
    if (sy + ph > ATLAS) throw new Error('housePictures: the atlas is full')
    jobs.push({ id, x: sx, y: sy, w: pw, h: ph })
    const uv = { u0: sx / ATLAS, u1: (sx + pw) / ATLAS, v0: 1 - (sy + ph) / ATLAS, v1: 1 - sy / ATLAS }
    sx += pw + GAP
    rowH = Math.max(rowH, ph)
    return uv
  }
  const paint = () =>
    texelate(canvasTexture([ATLAS, ATLAS], (ctx) => {
      ctx.fillStyle = '#808080'
      ctx.fillRect(0, 0, ATLAS, ATLAS)
      jobs.forEach((j, i) => {
        ctx.save()
        ctx.translate(j.x, j.y)
        ctx.beginPath()
        ctx.rect(0, 0, j.w, j.h)
        ctx.clip()
        PAINT[j.id](ctx, j.w, j.h, seeded(0x5a11 + i * 977))
        ctx.restore()
      })
    }))
  return { place, paint }
}
