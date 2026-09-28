import { cell, type Pen } from '../sandbox/art'

/*
  The creatures' atlas cells, declared before the prop atlas packs.

  Creatures are drawn on the props' one material (art.ts), as instances of a
  few shared box geometries (models.ts), so they add no shader program: what
  makes a pig a pig is these cells and a tint. The atlas packs on its first
  use, after which `cell()` refuses new names, so this module is imported by
  sandbox.ts beside the blocks' and the contraption parts', and nothing else
  may be relied on to run first.

  Two kinds of cell. **Materials** (`mob_fur`, `mob_wool`, `mob_cloth`, ...)
  are a little speckled texture in a light neutral, and a tint per part turns
  each into a kind's colour, so one geometry serves every animal's body.
  **Faces** are painted to be seen through that same tint (white), on the
  +x face of a kind's head geometry: 16 texels across a head that is about a
  metre and a half, so a texel is a chunky pixel and reads through the
  pixel look as a face and not as noise.

  Painted for the look, not against it (src/game/README.md, "The look"):
  neighbouring parts differ by more than a lightness band, faces are two or
  three flat values, and nothing depends on a hue the grade would pull
  elsewhere.
*/

const speck = (p: Pen, base: string, dark: string, light: string, seed: number, share = 0.16) => {
  p.fill(base)
  p.speckle(dark, share, seed)
  p.speckle(light, share * 0.6, seed + 11)
}

/* ---------------------------------------------------------- materials -- */

cell('mob_fur', { w: 16, h: 16, paint: (p) => speck(p, '#e6e2dc', '#c9c4bc', '#f6f3ee', 3) })
cell('mob_wool', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#eeebe2')
    for (let i = 0; i < 9; i++) p.disc(2 + ((i * 5) % 14), 2 + ((i * 7) % 14), 2.6, i % 2 ? '#dedacf' : '#f8f6ef')
    p.speckle('#cfcabd', 0.08, 5)
  },
})
cell('mob_patch', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#ece9e3')
    p.rect(0, 2, 6, 5, '#2c2828')
    p.rect(8, 0, 5, 4, '#2c2828')
    p.rect(9, 9, 7, 6, '#2c2828')
    p.rect(1, 11, 4, 4, '#2c2828')
    p.speckle('#d5d1c9', 0.1, 9)
  },
})
cell('mob_cloth', { w: 16, h: 16, paint: (p) => speck(p, '#dcdcdc', '#bdbdbd', '#f2f2f2', 13, 0.22) })
cell('mob_skin', { w: 16, h: 16, paint: (p) => speck(p, '#e0e0da', '#c4c4b8', '#f2f2ec', 17) })
cell('mob_creeper', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#6fb85a')
    for (let i = 0; i < 26; i++) p.rect((i * 7) % 15, (i * 11) % 15, 2, 2, i % 3 ? '#4f9a44' : '#8dd074')
  },
})
cell('mob_bone', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#dcd9ce')
    p.rect(0, 5, 16, 1, '#b9b5a8')
    p.rect(0, 11, 16, 1, '#b9b5a8')
    p.speckle('#f0eee6', 0.08, 21)
  },
})
cell('mob_beak', { w: 4, h: 4, paint: (p) => p.fill('#f0a020') })

/* -------------------------------------------------------------- faces -- */

const eyes = (p: Pen, y: number, c: string, sep = 6, size = 2) => {
  p.rect(8 - sep / 2 - size, y, size, size, c)
  p.rect(8 + sep / 2, y, size, size, c)
}

cell('face_pig', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#f2b0aa')
    p.speckle('#e29a94', 0.1, 31)
    eyes(p, 4, '#2a1a1a', 7)
    p.rect(5, 8, 6, 5, '#e08a86')
    p.rect(6, 10, 1, 2, '#7a3a3a')
    p.rect(9, 10, 1, 2, '#7a3a3a')
  },
})
cell('face_cow', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#3a3230')
    p.rect(0, 0, 5, 7, '#ece9e3')
    eyes(p, 5, '#ece9e3', 8)
    eyes(p, 6, '#1a1414', 8, 1)
    p.rect(4, 9, 8, 6, '#c9b6a0')
    p.rect(5, 11, 1, 2, '#3a3230')
    p.rect(10, 11, 1, 2, '#3a3230')
  },
})
cell('face_sheep', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#a09a90')
    p.speckle('#8c867c', 0.12, 41)
    eyes(p, 5, '#efece4', 7, 2)
    eyes(p, 6, '#141010', 7, 1)
    p.rect(6, 10, 4, 3, '#7a746a')
  },
})
cell('face_chicken', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#f2efe8')
    eyes(p, 5, '#141010', 8, 2)
    p.rect(5, 8, 6, 3, '#f0a020')
    p.rect(7, 11, 2, 3, '#d8402a')
  },
})
cell('face_zombie', {
  w: 16,
  h: 16,
  paint: (p) => {
    speck(p, '#7fa860', '#6a9150', '#93bd72', 51)
    p.rect(2, 5, 4, 3, '#1c2a24')
    p.rect(10, 5, 4, 3, '#1c2a24')
    p.rect(3, 6, 2, 2, '#0c1410')
    p.rect(11, 6, 2, 2, '#0c1410')
    p.rect(6, 9, 4, 2, '#5b7a45')
    p.rect(4, 11, 8, 2, '#2a3a2c')
  },
})
cell('face_creeper', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#6fb85a')
    for (let i = 0; i < 22; i++) p.rect((i * 5) % 15, (i * 9) % 15, 2, 2, i % 3 ? '#4f9a44' : '#8dd074')
    p.rect(3, 4, 4, 4, '#0e1a0e')
    p.rect(9, 4, 4, 4, '#0e1a0e')
    p.rect(6, 8, 4, 4, '#0e1a0e')
    p.rect(4, 10, 2, 4, '#0e1a0e')
    p.rect(10, 10, 2, 4, '#0e1a0e')
  },
})
cell('face_skeleton', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#d6d3c8')
    p.rect(2, 5, 4, 4, '#1c1a18')
    p.rect(10, 5, 4, 4, '#1c1a18')
    p.rect(7, 9, 2, 2, '#9a968a')
    p.rect(4, 12, 8, 2, '#1c1a18')
    for (let x = 5; x < 12; x += 2) p.rect(x, 12, 1, 2, '#d6d3c8')
  },
})
cell('face_egg', {
  w: 16,
  h: 16,
  paint: (p) => speck(p, '#e8dcc8', '#d6c8b0', '#f4ecdc', 61, 0.08),
})

/** the tints the models use, by name (a hex per part; the view scales them) */
export const TINT = {
  pig: '#f0a8a2',
  cowBody: '#ffffff',
  sheepLeg: '#b8b2a6',
  chicken: '#f6f4ee',
  chickenLeg: '#e8b030',
  zombieShirt: '#3f8f95',
  zombiePants: '#3a4a86',
  zombieSkin: '#8cb26c',
  bone: '#ffffff',
} as const
