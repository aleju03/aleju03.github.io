import * as THREE from 'three'
import { cell, model, shade, type Model, type Pen, type V3 } from './art'

/*
  The catalogue's models: what every spawnable prop looks like, and the
  atlas cells they are painted with.

  Everything here is built for the pixel look (render/pixelLook.ts), which
  draws a few hundred lines, outlines silhouettes and creases from depth,
  and posterizes lightness into eighteen steps. So the rules are the look's:
  shapes are chunky and made of real parts with real depth between them (a
  crate's battens stand proud of its planks, a door's panels are raised, a
  tyre has a hole), because a detail that is only a colour change is not
  outlined and does not read; neighbouring parts differ by value, not only by
  hue; and the painted detail sits on the world's 16-texels-a-unit grid (the
  cells are sized to the faces they cover). Colours come from the grade's
  anchor families (brick, ochre, moss, teal, slate, plum) and are not pushed
  past the chroma the grade would cap anyway.

  Every model is centred on its body's origin, which is its collision
  shape's origin in catalogue.ts, and drawn in the orientation it rests in,
  so the transform the physics writes is the one the mesh wants. `DIMS`
  holds the numbers the two files must agree on.

  Breakables also describe their gibs here (`GIBS`): the pieces a prop comes
  apart into, each a small box with its own mesh cut from the same cells
  (a crate's plank halves carry exactly the planks they were), in the prop's
  local frame, so breakables.ts can place them where the prop was.
*/

/* ------------------------------------------------------------ palette -- */

export const PAL = {
  wood: '#b98a52',
  woodMid: '#9a6c3c',
  woodDark: '#6a4527',
  walnut: '#7a5234',
  nail: '#3a302a',
  red: '#a83a2c',
  redDark: '#74261e',
  blue: '#3e5d8c',
  blueDark: '#2b4266',
  moss: '#4f7a3a',
  mossDark: '#34522a',
  teal: '#2f7a72',
  orange: '#dd6a26',
  yellow: '#e2b43c',
  white: '#e9e5da',
  cream: '#e6dcc2',
  black: '#26262a',
  rubber: '#2e2d2c',
  steel: '#8d9096',
  steelDark: '#55585f',
  rust: '#8e4c2c',
  plum: '#77506d',
  concrete: '#a39f96',
  glass: '#3f6f45',
  beige: '#b9b19d',
}

/* -------------------------------------------------------------- cells -- */

const grain = (p: Pen, base: string, seed: number, rows = 4) => {
  p.fill(base)
  const dark = shade(base, 0.82)
  const light = shade(base, 1.1)
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  // streaks of grain running along u
  for (let i = 0; i < p.h * 1.3; i++) {
    const y = Math.floor(rnd() * p.h)
    const x = Math.floor(rnd() * p.w)
    const len = 3 + Math.floor(rnd() * 9)
    p.rect(x, y, len, 1, rnd() < 0.7 ? dark : light)
  }
  // a knot or two
  for (let k = 0; k < rows / 3; k++) {
    const x = 3 + Math.floor(rnd() * (p.w - 6))
    const y = 2 + Math.floor(rnd() * (p.h - 4))
    p.rect(x - 1, y, 3, 1, shade(base, 0.62))
    p.px(x, y - 1, shade(base, 0.72))
  }
}

/** planks running along u, `n` of them, with seams and nail heads */
const planks = (p: Pen, base: string, n: number, seed: number, nails = true) => {
  grain(p, base, seed, n)
  const ph = p.h / n
  for (let i = 1; i < n; i++) {
    const y = Math.round(i * ph)
    p.rect(0, y, p.w, 1, shade(base, 0.5))
    p.rect(0, y + 1, p.w, 1, shade(base, 1.08))
  }
  // alternate planks a shade apart, the way sawn boards never quite match
  for (let i = 0; i < n; i += 2) p.speckle(shade(base, 0.93), 0.35, seed + i, 0, Math.round(i * ph) + 2, p.w, Math.round(ph) - 2)
  if (nails) {
    for (let i = 0; i < n; i++) {
      const y = Math.round(i * ph + ph / 2)
      p.px(4, y, PAL.nail)
      p.px(p.w - 5, y, PAL.nail)
    }
  }
}

cell('wood', { w: 48, h: 48, paint: (p) => grain(p, PAL.wood, 7, 6) })
cell('crate_side', { w: 38, h: 38, paint: (p) => planks(p, PAL.wood, 4, 3) })
cell('crate_mark', {
  w: 38,
  h: 38,
  paint: (p) => {
    planks(p, PAL.wood, 4, 5)
    // a stencil: a boxed code and a pair of this-way-up arrows, a little
    // worn (every fourth texel of the ink skipped)
    const ink = shade(PAL.woodDark, 0.72)
    const t = 'AJ-03'
    const x0 = Math.round((p.w - p.measure(t)) / 2)
    p.rect(x0 - 2, 12, p.measure(t) + 4, 1, ink)
    p.rect(x0 - 2, 20, p.measure(t) + 4, 1, ink)
    p.text(t, x0, 14, ink)
    p.text('^^', Math.round(p.w / 2 - 3), 25, ink)
    p.speckle(PAL.wood, 0.02, 11, x0 - 2, 12, p.measure(t) + 4, 20)
  },
})
cell('crate_top', { w: 38, h: 38, paint: (p) => planks(p, shade(PAL.wood, 0.96), 3, 9) })

cell('steel', {
  w: 32,
  h: 32,
  rough: 0.55,
  paint: (p) => {
    p.fill(PAL.steel)
    p.speckle(shade(PAL.steel, 0.88), 0.2, 4)
    p.speckle(shade(PAL.steel, 1.12), 0.08, 5)
  },
})
cell('rust', {
  w: 32,
  h: 32,
  paint: (p) => {
    p.fill(PAL.rust)
    p.speckle(shade(PAL.rust, 0.78), 0.25, 6)
    p.speckle('#a8643a', 0.12, 7)
    p.speckle(shade(PAL.steelDark, 0.9), 0.05, 8)
  },
})
cell('galv', {
  w: 32,
  h: 32,
  rough: 0.5,
  paint: (p) => {
    // galvanised corrugation: light and dark ribs down the can
    p.fill('#9ea2a4')
    for (let x = 0; x < p.w; x += 4) {
      p.rect(x, 0, 1, p.h, '#c3c6c6')
      p.rect(x + 2, 0, 1, p.h, '#777c80')
    }
    p.speckle('#b0b4b5', 0.06, 9)
  },
})
cell('concrete', {
  w: 32,
  h: 32,
  paint: (p) => {
    p.fill(PAL.concrete)
    p.speckle(shade(PAL.concrete, 0.86), 0.22, 12)
    p.speckle(shade(PAL.concrete, 1.1), 0.1, 13)
    p.speckle(shade(PAL.concrete, 0.7), 0.03, 14)
  },
})
cell('rubber', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill(PAL.rubber)
    p.speckle(shade(PAL.rubber, 1.25), 0.1, 15)
  },
})
cell('fabric', {
  w: 32,
  h: 32,
  paint: (p) => {
    // a coarse weave: a checker of two values a step apart, a few slubs
    p.fill('#d8d2c8')
    for (let y = 0; y < p.h; y++) for (let x = (y & 1); x < p.w; x += 2) p.px(x, y, '#c4bdb2')
    p.speckle('#e6e1d8', 0.04, 16)
  },
})

/* the oil drum's wrap: blue paint, a white stencil twice round, scuffs */
const drumWrap = (p: Pen, paint: string, label: (p: Pen, x: number) => void) => {
  p.fill(paint)
  p.speckle(shade(paint, 0.85), 0.14, 21)
  // scuffs through to steel at the bottom edge
  p.speckle(PAL.steelDark, 0.2, 22, 0, p.h - 3, p.w, 3)
  p.speckle(PAL.steelDark, 0.06, 23, 0, 0, p.w, 3)
  label(p, 6)
  label(p, 6 + p.w / 2)
}
cell('drum_blue', {
  w: 72,
  h: 34,
  rough: 0.6,
  paint: (p) =>
    drumWrap(p, PAL.blue, (q, x) => {
      q.text('OIL', x + 7, 13, PAL.white, true)
      q.rect(x + 5, 22, 23, 1, PAL.white)
    }),
})
cell('drum_red', {
  w: 72,
  h: 34,
  rough: 0.6,
  paint: (p) =>
    drumWrap(p, PAL.red, (q, x) => {
      // a white label with a red hazard diamond and a flame in it
      q.rect(x - 2, 8, 34, 19, PAL.white)
      q.speckle('#cfc9bc', 0.1, 24, x - 2, 8, 34, 19)
      const cx = x + 8
      const cy = 17
      q.poly([[cx, cy - 8], [cx + 8, cy], [cx, cy + 8], [cx - 8, cy]], PAL.red)
      q.poly([[cx, cy - 6], [cx + 6, cy], [cx, cy + 6], [cx - 6, cy]], '#f1ece2')
      // the flame
      q.poly([[cx, cy - 4], [cx + 3, cy + 1], [cx + 1, cy + 3], [cx - 2, cy + 3], [cx - 3, cy + 1]], PAL.red)
      q.px(cx, cy + 1, '#f1ece2')
      q.text('FLAM', x + 18, 12, PAL.redDark)
      q.text('MABLE', x + 16, 19, PAL.redDark)
    }),
})
cell('drum_lid', {
  w: 24,
  h: 24,
  rough: 0.55,
  paint: (p) => {
    p.fill(PAL.steelDark)
    p.disc(12, 12, 11, PAL.steel)
    p.disc(12, 12, 9, shade(PAL.steel, 0.92))
    // two bungs, the pressed ring between them
    p.disc(6.5, 12, 2.2, PAL.steelDark)
    p.disc(17.5, 12, 1.6, PAL.steelDark)
    p.speckle(shade(PAL.steel, 0.78), 0.08, 25)
  },
})
cell('hazard', {
  w: 32,
  h: 8,
  paint: (p) => {
    p.fill(PAL.yellow)
    for (let x = -8; x < p.w + 8; x += 8) p.poly([[x, 8], [x + 4, 8], [x + 8, 0], [x + 4, 0]], PAL.black)
  },
})
cell('stripes_ow', {
  w: 48,
  h: 8,
  rough: 0.5,
  paint: (p) => {
    p.fill(PAL.white)
    for (let x = -8; x < p.w + 8; x += 12) p.poly([[x, 8], [x + 6, 8], [x + 12, 0], [x + 6, 0]], PAL.orange)
  },
})
cell('beachball', {
  w: 48,
  h: 24,
  rough: 0.3,
  paint: (p) => {
    const cols = [PAL.red, PAL.white, PAL.yellow, PAL.white, PAL.blue, PAL.white]
    for (let i = 0; i < 6; i++) p.rect(i * 8, 0, 8, p.h, cols[i])
    // white caps at the poles
    p.rect(0, 0, p.w, 3, PAL.white)
    p.rect(0, p.h - 3, p.w, 3, PAL.white)
  },
})
cell('melon', {
  w: 48,
  h: 24,
  rough: 0.5,
  paint: (p) => {
    p.fill('#86b35a')
    // eight dark jagged stripes running pole to pole, bold enough to
    // survive being a dozen pixels wide
    for (let i = 0; i < 8; i++) {
      const x0 = i * 6 + 2
      for (let y = 0; y < p.h; y++) {
        const wob = Math.round(Math.sin(y * 0.9 + i * 2.1) * 0.8)
        const wide = 3 + ((y * 7 + i * 3) % 5 === 0 ? 1 : 0)
        p.rect(x0 + wob, y, wide, 1, '#2d4f20')
      }
    }
    // the poles are dark all round
    p.rect(0, 0, p.w, 2, '#2d4f20')
    p.rect(0, p.h - 2, p.w, 2, '#2d4f20')
  },
})
cell('melon_flesh', {
  w: 16,
  h: 16,
  paint: (p) => {
    p.fill('#d84a45')
    p.rect(0, 0, p.w, 2, '#e6dfb8')
    p.rect(0, 0, p.w, 1, '#355a26')
    p.speckle('#1d1612', 0.05, 32, 0, 4, p.w, p.h - 4)
    p.speckle('#ea6a60', 0.1, 33, 0, 3, p.w, p.h - 3)
  },
})
cell('bottle', {
  w: 18,
  h: 16,
  rough: 0.2,
  paint: (p) => {
    p.fill('#3d7040')
    p.rect(0, 4, p.w, 7, '#e2d6b0')
    p.rect(0, 5, p.w, 1, PAL.red)
    p.text('ALE', 3, 6, PAL.redDark)
    p.rect(12, 0, 2, p.h, '#6fa06a')
  },
})
cell('can', {
  w: 16,
  h: 12,
  rough: 0.35,
  paint: (p) => {
    p.fill(PAL.red)
    p.rect(0, 0, p.w, 1, '#b8bbbd')
    p.rect(0, p.h - 1, p.w, 1, '#b8bbbd')
    for (let x = 0; x < p.w; x++) p.px(x, 6 + Math.round(Math.sin(x * 0.8) * 1.3), PAL.white)
    p.text('COLA', 0, 2, PAL.white)
  },
})
cell('can_top', {
  w: 8,
  h: 8,
  rough: 0.35,
  paint: (p) => {
    p.fill('#b8bbbd')
    p.disc(4, 4, 3, '#a2a5a8')
    p.rect(3, 2, 2, 3, '#7c8084')
  },
})
cell('mattress', {
  w: 64,
  h: 48,
  paint: (p) => {
    // ticking: blue stripes on off-white, and a grid of tufted buttons
    p.fill('#e4e0d4')
    for (let x = 1; x < p.w; x += 5) p.rect(x, 0, 2, p.h, '#8ea3c0')
    for (let y = 6; y < p.h; y += 12) for (let x = 6; x < p.w; x += 13) {
      p.rect(x, y, 2, 2, '#5c6f8c')
      p.px(x - 1, y - 1, '#c9c4b6')
    }
    p.rect(0, 0, p.w, 1, '#8b8578')
    p.rect(0, p.h - 1, p.w, 1, '#8b8578')
  },
})
cell('mattress_side', {
  w: 32,
  h: 8,
  paint: (p) => {
    p.fill('#e4e0d4')
    for (let x = 1; x < p.w; x += 5) p.rect(x, 0, 2, p.h, '#8ea3c0')
    p.rect(0, 0, p.w, 1, '#6f7b8c')
    p.rect(0, p.h - 1, p.w, 1, '#6f7b8c')
    // the air vent grommets
    p.rect(8, 3, 2, 2, '#9a9fa6')
    p.rect(22, 3, 2, 2, '#9a9fa6')
  },
})
cell('tv_screen', {
  w: 20,
  h: 16,
  rough: 0.15,
  paint: (p) => {
    p.fill('#1f2a2a')
    // the glass bulges: a pale reflection in the top-left corner
    p.rect(2, 2, 5, 1, '#55706a')
    p.rect(2, 3, 2, 2, '#55706a')
  },
  glow: (p) => {
    // colour bars, dimmed: a set left on in an empty street
    const bars = ['#6b6b6b', '#6b6a1f', '#1f6a6a', '#1f6a1f', '#6a1f6a', '#6a1f1f', '#1f1f6a']
    for (let i = 0; i < 7; i++) p.rect(1 + i * 2.6, 1, 3, 10, bars[i])
    p.rect(1, 11, 18, 3, '#141414')
    p.rect(3, 12, 5, 1, '#3a3a3a')
  },
})
cell('vend_front', {
  w: 36,
  h: 70,
  rough: 0.45,
  paint: (p) => {
    p.fill(PAL.blue)
    // the window: six shelves of cans behind glass
    p.rect(2, 4, 23, 50, '#1b2530')
    const canCols = [PAL.red, PAL.yellow, '#4f9a4a', PAL.white, PAL.orange, '#6f8fd0']
    for (let r = 0; r < 6; r++) {
      p.rect(3, 12 + r * 7, 21, 1, '#56606a')
      for (let c = 0; c < 5; c++) p.rect(4 + c * 4, 7 + r * 7, 3, 5, canCols[(r + c * 2) % 6])
    }
    // the panel: a sign, a coin slot, a column of buttons, the hatch
    p.rect(27, 4, 7, 9, PAL.white)
    p.text('A', 29, 6, PAL.red)
    p.rect(29, 16, 3, 4, PAL.black)
    for (let i = 0; i < 6; i++) p.rect(28, 23 + i * 4, 5, 2, i % 2 ? PAL.yellow : '#d2d6dc')
    p.rect(4, 58, 20, 7, PAL.black)
    p.rect(5, 59, 18, 1, '#3a4452')
    p.text('COLD', 5, 66 - 10, PAL.white)
  },
  glow: (p) => {
    p.rect(2, 4, 23, 50, '#34404c')
    const canCols = ['#6a2018', '#6a5010', '#1c4a1a', '#606060', '#6a3010', '#26386a']
    for (let r = 0; r < 6; r++) for (let c = 0; c < 5; c++) p.rect(4 + c * 4, 7 + r * 7, 3, 5, canCols[(r + c * 2) % 6])
    p.rect(27, 4, 7, 9, '#808080')
  },
})
cell('stop', {
  w: 24,
  h: 24,
  rough: 0.4,
  paint: (p) => {
    p.fill(PAL.white)
    const o = (r: number) => {
      const pts: Array<[number, number]> = []
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8
        pts.push([12 + Math.cos(a) * r, 12 + Math.sin(a) * r])
      }
      return pts
    }
    p.poly(o(12.6), PAL.white)
    p.poly(o(11), '#b8322a')
    p.text('STOP', 1, 9, PAL.white, true)
  },
})
cell('tyre', {
  w: 64,
  h: 16,
  paint: (p) => {
    p.fill(PAL.rubber)
    // the lathe's v runs across the profile: sidewall, tread, sidewall
    for (let x = 0; x < p.w; x += 4) {
      p.rect(x, 5, 2, 2, '#1c1b1b')
      p.rect(x + 2, 9, 2, 2, '#1c1b1b')
    }
    p.rect(0, 4, p.w, 1, '#3d3c3a')
    p.rect(0, 11, p.w, 1, '#3d3c3a')
    // raised lettering on the walls
    p.speckle('#4a4845', 0.1, 41, 0, 0, p.w, 3)
    p.speckle('#4a4845', 0.1, 42, 0, 13, p.w, 3)
  },
})
cell('rim', {
  w: 16,
  h: 16,
  rough: 0.4,
  paint: (p) => {
    p.fill('#3b3c40')
    p.disc(8, 8, 7.5, '#9ea3a8')
    p.disc(8, 8, 5.5, '#7e8388')
    p.disc(8, 8, 2.5, '#b4b8bc')
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2
      p.px(8 + Math.round(Math.cos(a) * 4), 8 + Math.round(Math.sin(a) * 4), '#3b3c40')
    }
  },
})
cell('saw', {
  w: 26,
  h: 26,
  rough: 0.35,
  paint: (p) => {
    p.fill('#b2b6ba')
    p.disc(13, 13, 12, '#b9bdc1')
    p.disc(13, 13, 9, '#a5a9ae')
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      p.line(13 + Math.cos(a) * 4, 13 + Math.sin(a) * 4, 13 + Math.cos(a) * 8, 13 + Math.sin(a) * 8, '#c9cdd1')
    }
    p.disc(13, 13, 3, PAL.steelDark)
    p.disc(13, 13, 1.5, '#1f1f22')
    p.text('ACME', 6, 17, '#6e7278')
  },
})
cell('jerry', {
  w: 14,
  h: 18,
  rough: 0.55,
  paint: (p) => {
    p.fill(PAL.red)
    // the pressed X that stiffens the side
    p.line(2, 2, 11, 15, '#c24a3a')
    p.line(3, 2, 12, 15, shade(PAL.red, 0.72))
    p.line(11, 2, 2, 15, '#c24a3a')
    p.line(12, 2, 3, 15, shade(PAL.red, 0.72))
    p.rect(0, 0, p.w, 1, shade(PAL.red, 0.7))
    p.rect(0, p.h - 1, p.w, 1, shade(PAL.red, 0.7))
  },
})
cell('propane', {
  w: 46,
  h: 20,
  rough: 0.35,
  paint: (p) => {
    p.fill('#dfe0da')
    p.speckle('#c9cac4', 0.08, 51)
    p.rect(4, 4, 18, 11, PAL.white)
    p.text('GAS', 6, 5, PAL.red)
    p.poly([[13, 10], [16, 13], [13, 16], [10, 13]], PAL.red)
    p.rect(0, 0, p.w, 1, '#9fa09a')
  },
})
cell('milkcrate', {
  w: 20,
  h: 14,
  rough: 0.45,
  paint: (p) => {
    p.fill(PAL.teal)
    for (let y = 2; y < p.h - 2; y += 4) for (let x = 2; x < p.w - 1; x += 4) p.rect(x, y, 2, 2, '#163c38')
    p.rect(0, 0, p.w, 1, shade(PAL.teal, 1.18))
  },
})
cell('dumpster', {
  w: 32,
  h: 32,
  rough: 0.7,
  paint: (p) => {
    p.fill(PAL.moss)
    p.speckle(PAL.mossDark, 0.18, 61)
    // rust weeping down from the seams
    for (let i = 0; i < 6; i++) {
      const x = (i * 11 + 3) % p.w
      p.rect(x, 0, 1, 5 + (i * 7) % 12, PAL.rust)
    }
    p.speckle(PAL.rust, 0.04, 62)
  },
})
cell('container', {
  w: 32,
  h: 32,
  rough: 0.7,
  paint: (p) => {
    p.fill('#a4502e')
    p.speckle('#8a4228', 0.2, 71)
    p.speckle('#6e3a26', 0.04, 72)
  },
})
cell('container_mark', {
  w: 96,
  h: 40,
  rough: 0.7,
  paint: (p) => {
    p.fill('#a4502e')
    p.speckle('#8a4228', 0.2, 73)
    // the line's name in big stencil letters, each font texel two by two
    const word = 'ALEJ'
    const letters: Record<string, number[]> = {
      A: [14, 17, 17, 31, 17, 17, 17], L: [16, 16, 16, 16, 16, 16, 31],
      E: [31, 16, 16, 30, 16, 16, 31], J: [7, 2, 2, 2, 2, 18, 12],
    }
    let x = 12
    for (const ch of word) {
      letters[ch].forEach((row, ry) => {
        for (let bx = 0; bx < 5; bx++) if (row & (1 << (4 - bx))) p.rect(x + bx * 3, 8 + ry * 3, 3, 3, '#e6ddc8')
      })
      x += 19
    }
    p.text('AJ 030319', 12, 32, '#e6ddc8')
  },
})
cell('engine', {
  w: 24,
  h: 24,
  paint: (p) => {
    p.fill('#4a4d52')
    p.speckle('#3a3c40', 0.2, 81)
    p.speckle('#5f6368', 0.1, 82)
  },
})
cell('pipe_end', {
  w: 10,
  h: 10,
  paint: (p) => {
    p.fill(PAL.rust)
    p.disc(5, 5, 3.4, '#1d1714')
  },
})
cell('door_panel', {
  w: 16,
  h: 32,
  paint: (p) => {
    grain(p, PAL.wood, 91, 5)
    // grain runs up a door's stiles: re-stripe vertically
    p.speckle(shade(PAL.wood, 0.85), 0.06, 92)
  },
})
cell('gib_edge', {
  w: 8,
  h: 8,
  paint: (p) => {
    // freshly split wood: pale, fibrous
    p.fill('#d8b07a')
    p.speckle('#c09060', 0.3, 93)
  },
})

/* ------------------------------------------------------------- dims -- */

/** numbers the collision shapes in catalogue.ts are built from */
export const DIMS = {
  crate: 1.2,
  crateSmall: 0.72,
  pallet: { hx: 1.43, hy: 0.17, hz: 1.19 },
  plank: { hx: 0.42, hy: 0.13, hz: 2.9 },
  drum: { r: 0.72, hh: 1.05 },
  trash: { r: 0.56, hh: 0.95 },
  saw: { r: 0.78, hh: 0.035 },
  pipe: { r: 0.26, hl: 3 },
  hydrant: { r: 0.3, base: 0.42, h: 2.1 },
  cone: { r: 0.55, hh: 0.8, foot: 0.6, footH: 0.12 },
  ball: 0.62,
  bucket: { rb: 0.38, rt: 0.5, hh: 0.5 },
  milk: { hx: 0.62, hy: 0.45, hz: 0.62, t: 0.06 },
  wheelie: { hx: 0.7, hy: 1.12, hz: 0.85 },
  chair: { seat: 1.1, back: 1.1, w: 1.0 },
  table: { hx: 1.8, hy: 0.9, hz: 1.1 },
  couch: { hx: 2.4, hy: 1.0, hz: 1.0 },
  bath: { hx: 2.0, hy: 0.7, hz: 0.9 },
  mattress: { hx: 2.3, hy: 0.25, hz: 1.6 },
  door: { hx: 1.05, hy: 2.45, hz: 0.07 },
  tv: { hx: 0.95, hy: 0.8, hz: 0.8 },
  melon: { rx: 0.55, ry: 0.5, rz: 0.72 },
  bottle: { r: 0.17, hh: 0.5 },
  can: { r: 0.19, hh: 0.29 },
  block: { hx: 1.45, hy: 0.7, hz: 0.7 },
  barrier: { hl: 3, h: 1.9 },
  cinder: { hx: 0.465, hy: 0.225, hz: 0.225 },
  sawhorse: { hx: 1.8, hy: 1.0, hz: 0.55 },
  girder: { hl: 4, hh: 0.42, hw: 0.32 },
  stop: { post: 2.1, plate: 0.72 },
  tyre: { r: 0.78, hh: 0.26 },
  engine: { hx: 1.0, hy: 0.8, hz: 0.7 },
  gascan: { hx: 0.42, hy: 0.56, hz: 0.19 },
  propane: { r: 0.45, hh: 0.95 },
  dumpster: { hx: 2.15, hy: 1.35, hz: 1.45 },
  fridge: { hx: 0.85, hy: 2.1, hz: 0.85 },
  vending: { hx: 1.15, hy: 2.2, hz: 1.0 },
  lamp: { h: 9.8 },
  container: { hx: 7.2, hy: 3.0, hz: 2.9 },
}

/* ------------------------------------------------------------ models -- */

const wood = (tint = '#ffffff') => ({ cell: 'wood', tint, world: true })
const flat = (tint: string, cellName = 'white') => ({ cell: cellName, tint })

/** a crate of half-size h: planked panels inside a proud frame of battens */
const crate = (h: number) => () => {
  const m = model()
  const t = Math.max(0.14, h * 0.18)
  const s = 2 * h - 0.04
  m.box([0, 0, 0], [s, s, s], {
    px: { cell: 'crate_side' }, nx: { cell: 'crate_side' },
    pz: { cell: 'crate_mark' }, nz: { cell: 'crate_mark' },
    py: { cell: 'crate_top' }, ny: { cell: 'crate_top' },
  })
  const frame = wood('#a88a70')
  const o = h - t / 2 + 0.02
  for (const x of [-1, 1]) for (const z of [-1, 1]) m.box([x * o, 0, z * o], [t, 2 * h + 0.02, t], frame)
  for (const y of [-1, 1]) {
    for (const x of [-1, 1]) m.box([x * o, y * o, 0], [t, t, 2 * h - 2 * t + 0.02], frame)
    for (const z of [-1, 1]) m.box([0, y * o, z * o], [2 * h - 2 * t + 0.02, t, t], frame)
  }
  // a diagonal brace across the two unmarked sides
  const d = Math.SQRT2 * (2 * h - 2 * t)
  for (const x of [-1, 1]) m.box([x * (h + 0.005), 0, 0], [t * 0.7, t * 0.9, d], frame, [Math.PI / 4, 0, 0])
  return m.mesh()
}

const drum = (cellName: string) => () => {
  const { r, hh } = DIMS.drum
  const m = model()
  m.cyl([0, 0, 0], r, 2 * hh - 0.16, { side: { cell: cellName }, top: { cell: 'drum_lid' }, bottom: { cell: 'drum_lid' } }, { seg: 14 })
  // the rolled chimes at each end stand proud, the lid sits inside them
  const chime = flat(PAL.steelDark, 'steel')
  for (const y of [-1, 1]) m.cyl([0, y * (hh - 0.06), 0], r + 0.03, 0.12, { side: chime, top: chime, bottom: chime }, { seg: 14, open: true })
  // two rolling hoops
  const hoop = cellName === 'drum_red' ? flat(shade(PAL.red, 0.8)) : flat(PAL.blueDark)
  for (const y of [-0.34, 0.34]) m.cyl([0, y * hh, 0], r + 0.05, 0.11, { side: hoop }, { seg: 14, open: true })
  // the bung
  m.cyl([r * 0.48, hh - 0.08, 0], 0.13, 0.08, flat(PAL.steelDark, 'steel'), { seg: 6 })
  return m.mesh()
}

const trashcan = () => {
  const { r, hh } = DIMS.trash
  const m = model()
  m.cyl([0, -0.06, 0], [r - 0.05, r], 2 * hh - 0.14, { side: { cell: 'galv' }, bottom: flat('#6f7478') }, { seg: 14 })
  // the lid: a shallow dome over a rim, a handle across the top
  m.lathe([0, hh - 0.14, 0], [[r + 0.06, 0], [r + 0.06, 0.07], [r * 0.8, 0.16], [r * 0.3, 0.22], [0.001, 0.23]], flat('#aeb2b4', 'steel'), { seg: 14 })
  m.box([0, hh + 0.14, 0], [0.5, 0.08, 0.1], flat('#6f7478', 'steel'))
  for (const x of [-0.22, 0.22]) m.box([x, hh + 0.1, 0], [0.06, 0.1, 0.1], flat('#6f7478', 'steel'))
  // side handles
  for (const x of [-1, 1]) m.box([x * (r + 0.04), hh * 0.55, 0], [0.08, 0.1, 0.42], flat('#6f7478', 'steel'))
  // ribs round the can
  for (const y of [-0.5, 0.15]) m.cyl([0, y * hh, 0], r + 0.02, 0.08, flat('#b7bbbc', 'steel'), { seg: 14, open: true })
  return m.mesh()
}

const sawblade = () => {
  const { r, hh } = DIMS.saw
  const m = model()
  const pts: Array<[number, number]> = []
  const teeth = 24
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2
    const a1 = ((i + 0.72) / teeth) * Math.PI * 2
    pts.push([Math.cos(a0) * (r - 0.1), Math.sin(a0) * (r - 0.1)])
    pts.push([Math.cos(a1) * r, Math.sin(a1) * r])
  }
  // a prism lies in x/y extruded along z; lay it flat
  m.prism([0, 0, 0], pts, 2 * hh, { top: { cell: 'saw' }, side: flat('#d0d4d8', 'steel') }, [Math.PI / 2, 0, 0])
  m.cyl([0, 0, 0], 0.2, 2 * hh + 0.06, { side: flat(PAL.steelDark), top: flat('#3b3d42'), bottom: flat('#3b3d42') }, { seg: 8 })
  return m.mesh()
}

/* a yellow gas main rather than a rusty one: rust brown on asphalt was the
   same band as the road, and at street distance the pipe was gone. Yellow
   with dark flanges and two bands of tape reads from any side at any range */
const pipe = () => {
  const { r, hl } = DIMS.pipe
  const m = model()
  const rot: V3 = [0, 0, Math.PI / 2]
  m.cyl([0, 0, 0], r, 2 * hl - 0.2, { side: flat('#e8b030', 'gloss'), top: { cell: 'pipe_end' }, bottom: { cell: 'pipe_end' } }, { seg: 10, rot })
  for (const x of [-1, 1]) {
    m.cyl([x * (hl - 0.07), 0, 0], r + 0.1, 0.14, { side: flat(PAL.steelDark, 'steel'), top: { cell: 'pipe_end' }, bottom: { cell: 'pipe_end' } }, { seg: 10, rot })
    // bolts round each flange
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      m.box([x * (hl - 0.2), Math.cos(a) * (r + 0.05), Math.sin(a) * (r + 0.05)], [0.1, 0.07, 0.07], flat(PAL.black))
    }
    m.cyl([x * hl * 0.45, 0, 0], r + 0.012, 0.24, flat(PAL.black), { seg: 10, rot })
  }
  return m.mesh()
}

const hydrant = () => {
  const { r, base, h } = DIMS.hydrant
  const m = model()
  const y0 = -h / 2
  const paint = flat(PAL.red, 'gloss')
  const dark = flat(PAL.redDark, 'gloss')
  m.cyl([0, y0 + 0.08, 0], base, 0.16, dark, { seg: 10 })
  // bolts round the flange
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    m.box([Math.cos(a) * (base - 0.06), y0 + 0.18, Math.sin(a) * (base - 0.06)], [0.08, 0.06, 0.08], flat(PAL.steelDark))
  }
  m.cyl([0, y0 + 0.16 + 0.65, 0], r, 1.3, paint, { seg: 10 })
  m.cyl([0, y0 + 1.48, 0], r + 0.05, 0.1, dark, { seg: 10 })
  // the bonnet and its pentagon nut
  m.lathe([0, y0 + 1.53, 0], [[r + 0.02, 0], [r, 0.12], [r * 0.7, 0.3], [0.001, 0.38]], paint, { seg: 10 })
  m.cyl([0, y0 + 1.95, 0], 0.1, 0.14, flat(PAL.steelDark), { seg: 5 })
  // two hose nozzles and the big pumper nozzle, with their caps
  for (const x of [-1, 1]) {
    m.cyl([x * (r + 0.13), y0 + 1.1, 0], 0.12, 0.26, paint, { seg: 8, rot: [0, 0, Math.PI / 2] })
    m.cyl([x * (r + 0.28), y0 + 1.1, 0], 0.14, 0.08, flat(PAL.yellow), { seg: 5, rot: [0, 0, Math.PI / 2] })
  }
  m.cyl([0, y0 + 0.95, r + 0.12], 0.17, 0.24, paint, { seg: 8, rot: [Math.PI / 2, 0, 0] })
  m.cyl([0, y0 + 0.95, r + 0.26], 0.19, 0.08, flat(PAL.yellow), { seg: 5, rot: [Math.PI / 2, 0, 0] })
  return m.mesh()
}

const cone = () => {
  const { r, hh, foot, footH } = DIMS.cone
  const m = model()
  const orange = flat(PAL.orange, 'gloss')
  m.cyl([0, 0, 0], [r, 0.07], 2 * hh, { side: orange, top: orange, bottom: orange }, { seg: 14 })
  // two reflective collars on the taper
  const at = (y: number) => r + (0.07 - r) * ((y + hh) / (2 * hh))
  for (const [y, hgt] of [[-0.1, 0.28], [0.36, 0.16]] as const) {
    m.cyl([0, y, 0], [at(y - hgt / 2) + 0.012, at(y + hgt / 2) + 0.012], hgt, flat(PAL.white, 'gloss'), { seg: 14, open: true })
  }
  // the square rubber foot with a lip
  m.box([0, -hh - footH / 2 + 0.01, 0], [2 * foot, footH, 2 * foot], flat(PAL.black, 'rubber'))
  m.box([0, -hh + 0.02, 0], [2 * r + 0.1, 0.06, 2 * r + 0.1], flat(PAL.black, 'rubber'))
  return m.mesh()
}

const beachball = () => {
  const m = model()
  m.ball([0, 0, 0], [DIMS.ball, DIMS.ball, DIMS.ball], { cell: 'beachball' }, { w: 12, h: 9 })
  // the valve
  m.cyl([0, DIMS.ball - 0.01, 0], 0.07, 0.06, flat(PAL.white), { seg: 6 })
  return m.mesh()
}

const bucket = () => {
  const { rb, rt, hh } = DIMS.bucket
  const m = model()
  const out = flat(PAL.yellow, 'gloss')
  // walls with a thickness: out and up the outside, over the lip, down inside
  m.lathe([0, 0, 0], [
    [0.001, -hh], [rb, -hh], [rt, hh - 0.06], [rt + 0.04, hh - 0.04], [rt + 0.03, hh],
    [rt - 0.04, hh], [rb - 0.04, -hh + 0.08], [0.001, -hh + 0.08],
  ], out, { seg: 14 })
  // the inside floor reads darker
  m.cyl([0, -hh + 0.085, 0], rb - 0.05, 0.01, flat(shade(PAL.yellow, 0.7)), { seg: 14 })
  // the wire handle, arched over the top
  const arc = new THREE.TorusGeometry(1, 0.05, 4, 10, Math.PI)
  m.geo(arc, [0, hh - 0.02, 0], [rt, rt * 1.1, 1], flat(PAL.steelDark), [0, 0, 0])
  arc.dispose()
  for (const x of [-1, 1]) m.box([x * (rt + 0.02), hh - 0.1, 0], [0.06, 0.14, 0.14], out)
  return m.mesh()
}

const milkcrate = () => {
  const { hx, hy, hz, t } = DIMS.milk
  const m = model()
  const side = { cell: 'milkcrate' }
  const edge = flat(shade(PAL.teal, 1.1))
  m.box([0, -hy + t / 2, 0], [2 * hx, t, 2 * hz], { py: { cell: 'milkcrate' }, ny: { cell: 'milkcrate' }, all: edge })
  for (const s of [-1, 1]) {
    m.box([s * (hx - t / 2), 0, 0], [t, 2 * hy, 2 * hz], { px: side, nx: side, all: edge })
    m.box([0, 0, s * (hz - t / 2)], [2 * hx - 2 * t, 2 * hy, t], { pz: side, nz: side, all: edge })
  }
  // the thick top rim and the hand holes
  for (const s of [-1, 1]) {
    m.box([s * (hx - 0.05), hy - 0.06, 0], [0.12, 0.12, 2 * hz], edge)
    m.box([0, hy - 0.06, s * (hz - 0.05)], [2 * hx, 0.12, 0.12], edge)
    m.box([s * (hx + 0.001), hy - 0.28, 0], [0.02, 0.14, 0.6], flat('#163c38'))
  }
  return m.mesh()
}

const lawnchair = () => {
  const m = model()
  const white = flat('#eeeae2', 'gloss')
  const shadeW = flat('#d4d0c6', 'gloss')
  // legs, splayed a little, floor at -1
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    m.box([x * 0.46, -0.52, z * 0.42], [0.13, 1.0, 0.13], shadeW, [z * 0.08, 0, -x * 0.08])
  }
  m.box([0, -0.02, 0.02], [1.08, 0.1, 0.98], white)
  // the back, leaning, with slots
  m.box([0, 0.5, -0.5], [1.02, 1.0, 0.08], white, [-0.16, 0, 0])
  for (const x of [-0.24, 0, 0.24]) m.box([x, 0.62, -0.53], [0.1, 0.5, 0.1], flat('#9c9890'), [-0.16, 0, 0])
  // arms
  for (const x of [-1, 1]) {
    m.box([x * 0.54, 0.32, -0.04], [0.1, 0.07, 0.86], white)
    m.box([x * 0.54, 0.15, 0.36], [0.09, 0.34, 0.09], shadeW)
  }
  return m.mesh()
}

const wheelie = () => {
  const { hx, hy, hz } = DIMS.wheelie
  const m = model()
  const green = flat(PAL.moss, 'gloss')
  const dark = flat(PAL.mossDark, 'gloss')
  // the tapered tub: a box whose bottom is pinched in
  const tub = new THREE.BoxGeometry(1, 1, 1)
  const p = tub.getAttribute('position')
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setXYZ(i, p.getX(i) * 0.84, p.getY(i), p.getZ(i) * 0.8)
  tub.computeVertexNormals()
  m.geo(tub, [0, -0.1, 0.02], [2 * hx - 0.06, 2 * hy - 0.24, 2 * hz - 0.12], green)
  tub.dispose()
  // the lid, overhanging, hinged at the back
  m.box([0, hy - 0.1, 0.02], [2 * hx, 0.12, 2 * hz - 0.02], dark)
  m.box([0, hy - 0.2, hz - 0.02], [2 * hx - 0.1, 0.12, 0.08], dark)
  // handle bar and wheels at the back
  m.box([0, hy - 0.28, -hz + 0.04], [2 * hx - 0.3, 0.1, 0.12], dark)
  for (const x of [-1, 1]) {
    m.cyl([x * (hx - 0.12), -hy + 0.26, -hz + 0.22], 0.26, 0.16, { side: flat(PAL.rubber), top: { cell: 'rim' }, bottom: { cell: 'rim' } }, { seg: 10, rot: [0, 0, Math.PI / 2] })
  }
  m.box([0, -hy + 0.26, -hz + 0.22], [2 * hx - 0.2, 0.08, 0.08], flat(PAL.steelDark))
  // a white number painted on the front
  m.box([0, 0.2, hz - 0.07], [0.5, 0.36, 0.02], flat('#dcdcd0'))
  return m.mesh()
}

/* the kitchen chair's parts, shared by the model and its gibs */
const CHAIR_PARTS: Array<{ at: V3; size: V3; rot?: V3 }> = [
  { at: [0, -0.06, 0], size: [1.0, 0.12, 1.0] },
  ...[-1, 1].flatMap((x) => [-1, 1].map((z) => ({ at: [x * 0.42, -0.62, z * 0.42] as V3, size: [0.12, 1.0, 0.12] as V3 }))),
  { at: [-0.42, 0.55, -0.44], size: [0.12, 1.1, 0.12] },
  { at: [0.42, 0.55, -0.44], size: [0.12, 1.1, 0.12] },
  { at: [0, 0.92, -0.44], size: [0.74, 0.26, 0.08] },
  { at: [0, 0.5, -0.44], size: [0.74, 0.1, 0.07] },
]
const chair = () => {
  const m = model()
  const w = wood('#b48a66')
  for (const p of CHAIR_PARTS) m.box(p.at, p.size, w, p.rot)
  // stretchers between the legs
  for (const z of [-1, 1]) m.box([0, -0.85, z * 0.42], [0.74, 0.07, 0.07], w)
  return m.mesh()
}

const table = () => {
  const { hx, hy, hz } = DIMS.table
  const m = model()
  const w = wood('#9a7456')
  m.box([0, hy - 0.08, 0], [2 * hx, 0.16, 2 * hz], w)
  // the apron under the top, set in from the edge
  for (const s of [-1, 1]) {
    m.box([0, hy - 0.27, s * (hz - 0.2)], [2 * hx - 0.4, 0.22, 0.08], w)
    m.box([s * (hx - 0.2), hy - 0.27, 0], [0.08, 0.22, 2 * hz - 0.4], w)
  }
  // turned legs: a square block top, a round taper below
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    m.box([x * (hx - 0.22), hy - 0.4, z * (hz - 0.22)], [0.2, 0.5, 0.2], w)
    m.cyl([x * (hx - 0.22), -0.36, z * (hz - 0.22)], [0.07, 0.1], 1.08, w, { seg: 8 })
  }
  return m.mesh()
}

const couch = () => {
  const { hx, hz } = DIMS.couch
  const m = model()
  const cloth = { cell: 'fabric', tint: '#9b6a8c', world: true }
  const deep = { cell: 'fabric', tint: '#7c5070', world: true }
  m.box([0, -0.52, 0], [2 * hx - 0.1, 0.72, 2 * hz], deep)
  // two seat cushions and two back cushions, each its own chunk
  for (const x of [-1, 1]) {
    m.box([x * 0.98, -0.02, 0.18], [1.94, 0.34, 1.56], cloth)
    m.box([x * 0.98, 0.52, -0.62], [1.94, 0.86, 0.44], cloth, [-0.12, 0, 0])
  }
  m.box([0, 0.12, -0.9], [2 * hx - 0.1, 1.5, 0.22], deep)
  // rolled arms
  for (const x of [-1, 1]) {
    m.box([x * (hx - 0.22), -0.2, 0], [0.44, 0.9, 2 * hz], deep)
    m.cyl([x * (hx - 0.22), 0.3, 0], 0.26, 2 * hz, { side: cloth, top: deep, bottom: deep }, { seg: 10, rot: [Math.PI / 2, 0, 0] })
  }
  for (const x of [-1, 1]) for (const z of [-1, 1]) m.box([x * (hx - 0.3), -0.94, z * (hz - 0.2)], [0.14, 0.12, 0.14], flat(PAL.woodDark))
  return m.mesh()
}

const bathtub = () => {
  const { hx, hy, hz } = DIMS.bath
  const m = model()
  const out = flat('#ece8dc', 'gloss')
  const inn = flat('#d9d6cc', 'gloss')
  const t = 0.12
  m.box([0, -hy + 0.3, 0], [2 * hx - 0.3, t, 2 * hz - 0.3], { py: inn, all: out })
  for (const s of [-1, 1]) {
    m.box([0, 0.04, s * (hz - t / 2 - 0.02)], [2 * hx - 0.14, 1.16, t], { pz: s > 0 ? out : inn, nz: s > 0 ? inn : out, all: out }, [s * -0.1, 0, 0])
    m.box([s * (hx - t / 2 - 0.02), 0.04, 0], [t, 1.16, 2 * hz - 0.2], { px: s > 0 ? out : inn, nx: s > 0 ? inn : out, all: out }, [0, 0, s * 0.16])
  }
  // the rolled rim, a tube all round
  for (const s of [-1, 1]) {
    m.cyl([0, hy - 0.06, s * (hz - 0.04)], 0.1, 2 * hx - 0.02, out, { seg: 8, rot: [0, 0, Math.PI / 2] })
    m.cyl([s * (hx - 0.04), hy - 0.06, 0], 0.1, 2 * hz - 0.02, out, { seg: 8, rot: [Math.PI / 2, 0, 0] })
  }
  // claw feet, and the taps at one end
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    m.lathe([x * (hx - 0.45), -hy, z * (hz - 0.3)], [[0.12, 0], [0.16, 0.05], [0.08, 0.2], [0.12, 0.34], [0.001, 0.36]], flat('#b89a4a', 'gloss'), { seg: 6 })
  }
  for (const z of [-0.2, 0.2]) m.cyl([hx - 0.22, hy + 0.12, z], 0.05, 0.3, flat('#c9ccd0', 'gloss'), { seg: 6 })
  m.box([hx - 0.3, hy + 0.26, 0], [0.34, 0.07, 0.07], flat('#c9ccd0', 'gloss'))
  m.cyl([-hx + 0.6, -hy + 0.37, 0], 0.1, 0.02, flat(PAL.steelDark), { seg: 8 })
  return m.mesh()
}

const mattress = () => {
  const { hx, hy, hz } = DIMS.mattress
  const m = model()
  m.box([0, 0, 0], [2 * hx, 2 * hy, 2 * hz], {
    py: { cell: 'mattress' }, ny: { cell: 'mattress' },
    side: { cell: 'mattress_side' },
  })
  // piping round the top and bottom edges
  for (const y of [-1, 1]) for (const s of [-1, 1]) {
    m.box([0, y * (hy - 0.02), s * hz], [2 * hx + 0.04, 0.05, 0.05], flat('#5c6f8c'))
    m.box([s * hx, y * (hy - 0.02), 0], [0.05, 0.05, 2 * hz], flat('#5c6f8c'))
  }
  return m.mesh()
}

const door = () => {
  const { hx, hy, hz } = DIMS.door
  const m = model()
  const w = wood('#c79766')
  m.box([0, 0, 0], [2 * hx, 2 * hy, 2 * hz], { side: w, py: w, ny: w, pz: { cell: 'door_panel', tint: '#c79766' }, nz: { cell: 'door_panel', tint: '#c79766' } })
  // four raised panels a side
  for (const s of [-1, 1]) for (const [px, py, sx, sy] of [[-0.38, 1.2, 0.58, 1.6], [0.38, 1.2, 0.58, 1.6], [-0.38, -1.05, 0.58, 1.9], [0.38, -1.05, 0.58, 1.9]]) {
    m.box([px, py, s * (hz + 0.02)], [sx, sy, 0.04], wood('#b5875a'))
  }
  // a knob each side, a lock plate, three hinges on the other edge
  for (const s of [-1, 1]) {
    m.box([hx - 0.26, -0.1, s * (hz + 0.02)], [0.12, 0.34, 0.03], flat('#b89a4a', 'gloss'))
    m.cyl([hx - 0.26, -0.1, s * (hz + 0.14)], 0.1, 0.12, flat('#c9a854', 'gloss'), { seg: 8, rot: [Math.PI / 2, 0, 0] })
  }
  for (const y of [-1.8, 0, 1.8]) m.box([-hx - 0.02, y, 0], [0.04, 0.34, 0.16], flat(PAL.steelDark))
  return m.mesh()
}

const tv = () => {
  const { hx, hy, hz } = DIMS.tv
  const m = model()
  const shell = flat(PAL.beige, 'gloss')
  const dark = flat('#3a3a3c')
  // a wood-veneer cabinet round the front and a charcoal plastic tube
  // housing behind it, as sets were: the beige housing that was here read
  // as a blank stone from three sides of four
  const veneer = { cell: 'wood', tint: '#8a5a38' }
  const backShell = flat('#4a4644')
  // the front bezel box and the tapered tube housing behind it
  m.box([0, 0, hz - 0.22], [2 * hx, 2 * hy, 0.44], { pz: dark, px: veneer, nx: veneer, py: veneer, all: shell })
  const back = new THREE.BoxGeometry(1, 1, 1)
  const p = back.getAttribute('position')
  // tapered to the sides and over the top, flat underneath: it sits on
  // the bottom of its case like a real set, not on its bezel
  for (let i = 0; i < p.count; i++) {
    if (p.getZ(i) < 0) p.setXYZ(i, p.getX(i) * 0.62, p.getY(i) > 0 ? p.getY(i) * 0.36 - 0.14 : p.getY(i), p.getZ(i))
  }
  back.computeVertexNormals()
  m.geo(back, [0, 0.02, -0.22], [2 * hx - 0.1, 2 * hy - 0.12, 1.16], backShell)
  back.dispose()
  // vent slots in the back and the aerial socket, the label plate
  for (let i = 0; i < 5; i++) m.box([-0.2 + i * 0.1, -0.3, -0.81], [0.05, 0.5, 0.02], flat(PAL.black))
  m.box([0.34, -0.18, -0.81], [0.22, 0.16, 0.02], flat(PAL.cream))
  m.cyl([0.34, -0.5, -0.82], 0.05, 0.06, flat('#c9ccd0', 'steel'), { seg: 6, rot: [Math.PI / 2, 0, 0] })
  // and a row of slots along each side of the cabinet
  for (const x of [-1, 1]) for (let i = 0; i < 4; i++) m.box([x * (hx + 0.005), -0.45 + i * 0.12, hz - 0.22], [0.02, 0.05, 0.3], flat(PAL.black))
  // the screen, set into the bezel, and the control strip beside it
  m.box([-0.2, 0.04, hz + 0.005], [1.34, 1.1, 0.04], { pz: { cell: 'tv_screen' }, all: dark })
  m.box([0.72, 0.04, hz + 0.005], [0.36, 1.2, 0.03], flat('#5a5854'))
  for (const y of [0.35, 0.02]) m.cyl([0.72, y, hz + 0.06], 0.1, 0.1, flat('#26262a'), { seg: 8, rot: [Math.PI / 2, 0, 0] })
  for (let i = 0; i < 4; i++) m.box([0.72, -0.3 - i * 0.08, hz + 0.03], [0.24, 0.03, 0.02], flat('#26262a'))
  // rabbit ears
  m.cyl([0, hy + 0.05, -0.2], 0.16, 0.1, dark, { seg: 8 })
  for (const s of [-1, 1]) m.cyl([s * 0.36, hy + 0.7, -0.2], 0.02, 1.4, flat('#c9ccd0'), { seg: 4, rot: [0, 0, -s * 0.55] })
  // feet
  for (const x of [-1, 1]) m.box([x * (hx * 0.62 - 0.12), -hy - 0.03, 0], [0.2, 0.06, 2 * hz - 0.2], dark)
  return m.mesh()
}

const melon = () => {
  const { rx, ry, rz } = DIMS.melon
  const m = model()
  // the sphere's poles lie along z, which is the way the stripes run
  m.ball([0, 0, 0], [rx, rz, ry], { cell: 'melon' }, { w: 16, h: 10, rot: [Math.PI / 2, 0, 0] })
  m.cyl([0, 0, rz + 0.02], 0.05, 0.08, flat('#6a5a30'), { seg: 5, rot: [Math.PI / 2, 0, 0] })
  return m.mesh()
}

const bottle = () => {
  const { r, hh } = DIMS.bottle
  const m = model()
  const glass = flat('#ffffff', 'bottle')
  m.cyl([0, -hh + 0.31, 0], r, 0.62, { side: glass, bottom: flat('#2a4a2c', 'gloss'), top: flat('#3d7040', 'gloss') }, { seg: 10 })
  m.lathe([0, -hh + 0.62, 0], [[r, 0], [r * 0.9, 0.08], [0.075, 0.2], [0.07, 0.34]], flat('#3d7040', 'gloss'), { seg: 10 })
  m.cyl([0, hh - 0.02, 0], 0.085, 0.07, flat('#c9a854', 'gloss'), { seg: 8 })
  return m.mesh()
}

const sodacan = () => {
  const { r, hh } = DIMS.can
  const m = model()
  m.cyl([0, 0, 0], r, 2 * hh - 0.04, { side: { cell: 'can' }, top: { cell: 'can_top' }, bottom: flat('#8e9296', 'gloss') }, { seg: 10 })
  m.cyl([0, hh - 0.01, 0], [r, r * 0.86], 0.03, flat('#b8bbbd', 'gloss'), { seg: 10 })
  return m.mesh()
}

const block = () => {
  const { hx, hy, hz } = DIMS.block
  const m = model()
  const c = { cell: 'concrete', world: true }
  m.box([0, -0.04, 0], [2 * hx, 2 * hy - 0.08, 2 * hz], c)
  // the chamfered top and two nubs that key into the block above
  m.box([0, hy - 0.06, 0], [2 * hx - 0.14, 0.12, 2 * hz - 0.14], { cell: 'concrete', world: true, tint: '#e8e6e0' })
  for (const x of [-1, 1]) {
    const eye = new THREE.TorusGeometry(0.17, 0.05, 5, 10)
    m.geo(eye, [x * hx * 0.5, hy + 0.12, 0], [1, 1, 1], flat(PAL.steelDark))
    eye.dispose()
  }
  for (const s of [-1, 1]) m.box([0, 0.05, s * (hz + 0.005)], [2 * hx * 0.8, 0.22, 0.02], flat(PAL.yellow))
  return m.mesh()
}

/** the jersey barrier's cross-section (z, y) */
export const BARRIER_PROFILE: Array<[number, number]> = [
  [-0.72, -0.95], [0.72, -0.95], [0.72, -0.72], [0.38, -0.46], [0.25, 0.95], [-0.25, 0.95], [-0.38, -0.46], [-0.72, -0.72],
]
const barrier = () => {
  const { hl } = DIMS.barrier
  const m = model()
  // the profile is drawn in x/y and extruded along z; turn it to run along x
  const prof = BARRIER_PROFILE.map(([z, y]) => [z, y] as [number, number])
  m.prism([0, 0, 0], prof, 2 * hl, { side: { cell: 'concrete', world: true }, top: { cell: 'concrete', world: true, tint: '#cfccc4' } }, [0, Math.PI / 2, 0])
  // the lifting slots at the foot and a pair of reflectors
  for (const x of [-1, 1]) {
    m.box([x * 1.6, -0.82, 0], [0.5, 0.2, 1.46], flat('#3a3936'))
    m.box([x * 1.2, 0.55, 0.3], [0.18, 0.18, 0.02], flat(PAL.yellow, 'gloss'), [0.07, 0, 0])
    m.box([x * 1.2, 0.55, -0.3], [0.18, 0.18, 0.02], flat(PAL.yellow, 'gloss'), [-0.07, 0, 0])
  }
  return m.mesh()
}

const cinder = () => {
  const { hx, hy, hz } = DIMS.cinder
  const m = model()
  const c = { cell: 'concrete', world: true, tint: '#b8b3a8' }
  // two cores straight through: the walls and webs between them are the block
  for (const s of [-1, 1]) m.box([0, 0, s * (hz - 0.045)], [2 * hx, 2 * hy, 0.09], c)
  for (const x of [-1, 0, 1]) m.box([x * (hx - 0.045), 0, 0], [0.09, 2 * hy, 2 * hz - 0.18], c)
  return m.mesh()
}

const sawhorse = () => {
  const { hx, hy, hz } = DIMS.sawhorse
  const m = model()
  const board = { pz: { cell: 'stripes_ow' }, nz: { cell: 'stripes_ow' }, all: flat(PAL.white) }
  m.box([0, hy - 0.3, 0], [2 * hx, 0.46, 0.08], board)
  m.box([0, -0.1, 0], [2 * hx - 0.5, 0.3, 0.07], board)
  // the A-frames: two legs an end, splayed front and back, with a foot bar
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) m.box([x * (hx - 0.3), -0.02, z * 0.28], [0.12, 1.96, 0.12], flat('#e9e5da'), [z * 0.27, 0, 0])
    m.box([x * (hx - 0.3), -hy + 0.06, 0], [0.16, 0.1, 2 * hz], flat(PAL.black, 'rubber'))
  }
  return m.mesh()
}

const girder = () => {
  const { hl, hh, hw } = DIMS.girder
  const m = model()
  // red-oxide primer: what structural steel looks like on a site, and
  // several bands off the asphalt, where rusty brown was the road's own
  const steel = flat('#d8683a')
  const edge = flat('#a8482a')
  for (const s of [-1, 1]) m.box([0, s * (hh - 0.06), 0], [2 * hl, 0.12, 2 * hw], { py: steel, ny: steel, all: edge })
  m.box([0, 0, 0], [2 * hl, 2 * hh - 0.24, 0.1], edge)
  // stiffeners every metre and a bit, and bolt holes in the flange ends
  for (let x = -hl + 0.5; x < hl; x += 1.5) for (const s of [-1, 1]) m.box([x, 0, s * 0.16], [0.06, 2 * hh - 0.24, 0.24], steel)
  for (const x of [-1, 1]) for (const z of [-1, 1]) m.box([x * (hl - 0.3), hh + 0.002, z * hw * 0.55], [0.1, 0.01, 0.1], flat(PAL.black))
  return m.mesh()
}

const stopsign = () => {
  const { post, plate } = DIMS.stop
  const m = model()
  // a square post with its punched holes, the plate on top
  m.box([0, -0.3, 0], [0.12, 2 * post, 0.12], { cell: 'steel', world: true, tint: '#b0b4b8' })
  for (let y = -2.2; y < 1.6; y += 0.3) m.box([0, y, 0.061], [0.04, 0.04, 0.005], flat(PAL.steelDark))
  const pts: Array<[number, number]> = []
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8
    pts.push([Math.cos(a) * plate, Math.sin(a) * plate])
  }
  m.prism([0, post - 0.3 + 0.1, 0.08], pts, 0.04, { top: { cell: 'stop' }, side: flat('#d0d2d4') })
  // a portable sign's rubber foot, which is what keeps it standing
  m.box([0, -post - 0.3 + 0.07, 0], [1.1, 0.14, 1.1], flat(PAL.rubber))
  m.box([0, -post - 0.3 + 0.19, 0], [0.34, 0.12, 0.34], flat(PAL.rubber))
  return m.mesh()
}

const tyre = () => {
  const { r, hh } = DIMS.tyre
  const m = model()
  // a real torus-ish profile with a hole through it: sidewall, shoulder, tread
  m.lathe([0, 0, 0], [
    [0.44, -0.2], [0.52, -hh], [0.7, -hh + 0.01], [r - 0.02, -0.19], [r, -0.1], [r, 0.1], [r - 0.02, 0.19],
    [0.7, hh - 0.01], [0.52, hh], [0.44, 0.2], [0.42, 0], [0.44, -0.2],
  ], { cell: 'tyre' }, { seg: 16 })
  return m.mesh()
}

const engine = () => {
  const { hx, hy, hz } = DIMS.engine
  const m = model()
  const iron = { cell: 'engine', world: true }
  m.box([0, -0.05, 0], [1.5, 1.0, 1.0], iron)
  // the two valve covers of a vee, the intake between, the sump below
  for (const s of [-1, 1]) m.box([0, 0.55, s * 0.3], [1.36, 0.22, 0.36], flat(PAL.red, 'gloss'), [s * 0.35, 0, 0])
  m.box([0, 0.58, 0], [1.1, 0.26, 0.3], flat('#8a8d92', 'steel'))
  m.cyl([0, 0.8, 0], 0.34, 0.16, { side: flat(PAL.black), top: flat('#3a3a3e') }, { seg: 10 })
  m.box([0, -0.66, 0], [1.3, 0.28, 0.8], flat('#3a3c40'))
  // manifolds down each side, pulleys on the front, a flywheel at the back
  for (const s of [-1, 1]) for (let i = -1; i <= 1; i++) m.box([i * 0.42, 0.12, s * 0.56], [0.16, 0.14, 0.14], { cell: 'rust', world: true })
  for (const [y, rr] of [[0.2, 0.22], [-0.2, 0.3]] as const) m.cyl([hx - 0.16, y, 0], rr, 0.1, { side: flat('#8a8d92', 'steel'), top: flat('#55585f') , bottom: flat('#55585f') }, { seg: 10, rot: [0, 0, Math.PI / 2] })
  m.cyl([-hx + 0.12, -0.1, 0], hy - 0.1, 0.12, { side: flat('#55585f', 'steel'), top: flat('#3a3c40'), bottom: flat('#3a3c40') }, { seg: 14, rot: [0, 0, Math.PI / 2] })
  void hz
  return m.mesh()
}

const gascan = () => {
  const { hx, hy, hz } = DIMS.gascan
  const m = model()
  const red = flat(PAL.red, 'gloss')
  m.box([0, -0.08, 0], [2 * hx, 2 * hy - 0.16, 2 * hz], { pz: { cell: 'jerry' }, nz: { cell: 'jerry' }, all: red })
  // three-bar handle across the top, the spout cap in the corner
  for (const x of [-0.24, 0, 0.24]) m.box([x, hy - 0.08, 0], [0.07, 0.18, 0.1], red)
  m.box([-0.04, hy - 0.01, 0], [0.62, 0.06, 0.12], red)
  m.cyl([hx - 0.14, hy - 0.08, 0], 0.1, 0.16, flat(PAL.steelDark, 'steel'), { seg: 8, rot: [0, 0, -0.35] })
  m.box([0, -hy + 0.06, 0], [2 * hx + 0.02, 0.1, 2 * hz + 0.02], flat(PAL.redDark))
  return m.mesh()
}

const propane = () => {
  const { r, hh } = DIMS.propane
  const m = model()
  const body = flat('#e8e9e2', 'gloss')
  m.cyl([0, -0.2, 0], r, 1.1, { side: { cell: 'propane' }, bottom: body }, { seg: 14 })
  m.lathe([0, 0.35, 0], [[r, 0], [r * 0.92, 0.18], [r * 0.6, 0.3], [0.001, 0.34]], body, { seg: 14 })
  // the foot ring and the guard collar round the valve
  m.cyl([0, -hh + 0.1, 0], r - 0.05, 0.2, flat('#b8b9b2', 'steel'), { seg: 14, open: true })
  m.cyl([0, hh - 0.14, 0], 0.26, 0.28, flat('#b8b9b2', 'steel'), { seg: 10, open: true })
  m.cyl([0, hh - 0.2, 0], 0.08, 0.2, flat('#c9a854', 'gloss'), { seg: 6 })
  m.box([0.1, hh - 0.1, 0], [0.2, 0.07, 0.07], flat('#3a6ab0'))
  return m.mesh()
}

const dumpster = () => {
  const { hx, hy, hz } = DIMS.dumpster
  const m = model()
  const paint = { cell: 'dumpster', world: true }
  const t = 0.12
  m.box([0, -hy + 0.25, 0], [2 * hx, t, 2 * hz], paint)
  for (const s of [-1, 1]) {
    m.box([0, 0.06, s * (hz - t / 2)], [2 * hx, 2 * hy - 0.3, t], paint)
    m.box([s * (hx - t / 2), 0.06, 0], [t, 2 * hy - 0.3, 2 * hz - 2 * t], paint)
    // the fork pockets
    m.box([s * (hx + 0.08), -0.2, 0], [0.16, 0.36, 2 * hz - 0.4], { cell: 'dumpster', world: true, tint: '#8a9a80' })
  }
  // a rolled top lip and ribs down the long sides
  for (const s of [-1, 1]) {
    m.box([0, hy - 0.12, s * (hz + 0.02)], [2 * hx + 0.04, 0.14, 0.14], { cell: 'dumpster', world: true, tint: '#8a9a80' })
    for (const x of [-1.2, 0, 1.2]) m.box([x, 0, s * (hz + 0.03)], [0.16, 2 * hy - 0.5, 0.08], { cell: 'dumpster', world: true, tint: '#8a9a80' })
  }
  // two black lids thrown back against the rear wall
  for (const x of [-1, 1]) m.box([x * hx * 0.5, hy + 0.35, -hz - 0.14], [hx - 0.06, 0.08, 1.0], flat('#2a2c2e', 'gloss'), [Math.PI / 2 - 0.25, 0, 0])
  for (const x of [-1, 1]) for (const z of [-1, 1]) m.cyl([x * (hx - 0.4), -hy + 0.1, z * (hz - 0.35)], 0.14, 0.12, flat(PAL.rubber), { seg: 8, rot: [0, 0, Math.PI / 2] })
  return m.mesh()
}

const fridge = () => {
  const { hx, hy, hz } = DIMS.fridge
  const m = model()
  const enamel = flat('#e8e2cc', 'gloss')
  const seam = flat('#4a4844')
  m.box([0, 0.06, -0.06], [2 * hx, 2 * hy - 0.12, 2 * hz - 0.12], enamel)
  // freezer door over fridge door, with a dark gap between
  m.box([0, hy - 0.72, hz - 0.06], [2 * hx, 1.3, 0.12], enamel)
  m.box([0, -0.66, hz - 0.06], [2 * hx, 2.66, 0.12], enamel)
  m.box([0, hy - 1.39, hz - 0.08], [2 * hx - 0.02, 0.04, 0.1], seam)
  for (const [y, hgt] of [[hy - 0.9, 0.6], [0.3, 1.0]] as const) m.box([hx - 0.2, y, hz + 0.06], [0.08, hgt, 0.08], flat('#c9ccd0', 'gloss'))
  m.box([0, -hy + 0.06, 0], [2 * hx - 0.1, 0.12, 2 * hz - 0.2], seam)
  // a round badge and a fridge magnet or two
  m.box([-0.4, hy - 0.4, hz + 0.01], [0.3, 0.1, 0.02], flat('#b8322a'))
  m.box([-0.3, 0.4, hz + 0.01], [0.16, 0.2, 0.02], flat(PAL.yellow))
  m.box([0.1, 0.1, hz + 0.01], [0.14, 0.14, 0.02], flat('#3e6fb0'))
  // from the side: the doors' edges stand off the cabinet on a dark gasket
  // line, the hinges are on show, and a chrome trim strip runs down each
  // flank at handle height, so a side view is still a fridge
  for (const x of [-1, 1]) {
    m.box([x * (hx + 0.005), 0.06, hz - 0.13], [0.02, 2 * hy - 0.24, 0.035], seam)
    for (const y of [hy - 0.1, hy - 1.39, -hy + 0.62]) m.box([x > 0 ? hx - 0.02 : -hx + 0.02, y, hz - 0.02], [0.06, 0.14, 0.18], flat('#c9ccd0', 'gloss'))
    for (const y of [-0.2, hy - 1.39]) m.box([x * (hx + 0.01), y, -0.06], [0.02, 0.1, 2 * hz - 0.3], flat(PAL.steel, 'gloss'))
    // a louvred vent low on each flank
    for (let i = 0; i < 4; i++) m.box([x * (hx + 0.01), -hy + 0.35 + i * 0.12, -0.3], [0.02, 0.05, 0.7], seam)
  }
  // the back: the black condenser grid and the compressor under it
  const coil = flat('#2e2d2c')
  for (let y = -hy + 1.0; y < hy - 0.3; y += 0.24) m.box([0, y, -hz - 0.04], [2 * hx - 0.36, 0.05, 0.05], coil)
  for (const x of [-1, 0, 1]) m.box([x * (hx - 0.3), 0.3, -hz - 0.07], [0.06, 2 * hy - 1.4, 0.05], coil)
  m.box([0.2, -hy + 0.45, -hz + 0.12], [0.9, 0.6, 0.3], coil)
  m.box([-0.5, -hy + 0.45, -hz - 0.01], [0.3, 0.4, 0.04], flat('#e8e2cc'))
  m.box([-0.5, -hy + 0.5, -hz - 0.03], [0.22, 0.08, 0.02], flat(PAL.black))
  return m.mesh()
}

const vending = () => {
  const { hx, hy, hz } = DIMS.vending
  const m = model()
  const body = flat(PAL.blue, 'gloss')
  m.box([0, 0, -0.04], [2 * hx, 2 * hy, 2 * hz - 0.08], { pz: { cell: 'vend_front' }, all: body })
  // the door frame stands proud around the front
  const frame = flat(PAL.blueDark, 'gloss')
  m.box([0, hy - 0.08, hz - 0.02], [2 * hx, 0.16, 0.1], frame)
  m.box([0, -hy + 0.08, hz - 0.02], [2 * hx, 0.16, 0.1], frame)
  for (const s of [-1, 1]) m.box([s * (hx - 0.05), 0, hz - 0.02], [0.1, 2 * hy, 0.1], frame)
  m.box([0.55, 0, hz - 0.02], [0.08, 2 * hy - 0.3, 0.08], frame)
  m.box([0, -hy - 0.04, 0], [2 * hx - 0.2, 0.08, 2 * hz - 0.3], flat(PAL.black))
  // the flanks are advertising, as they always are: a red band with the
  // white wave across it, and a can standing on it, so the machine reads
  // from the side as well as it does from the front
  for (const x of [-1, 1]) {
    const sx = x * (hx + 0.01)
    m.box([sx, 0.5, 0], [0.02, 1.6, 2 * hz - 0.3], flat(PAL.red, 'gloss'))
    m.box([sx + x * 0.005, 0.95, 0], [0.02, 0.16, 2 * hz - 0.3], flat(PAL.white))
    m.box([sx + x * 0.005, 0.05, 0], [0.02, 0.16, 2 * hz - 0.3], flat(PAL.white))
    m.box([sx + x * 0.01, 0.5, 0.15], [0.02, 0.9, 0.62], { px: { cell: 'can' }, nx: { cell: 'can' }, all: flat(PAL.red) })
    m.box([sx, hy - 0.5, 0], [0.02, 0.36, 2 * hz - 0.3], flat(PAL.white))
    m.box([sx + x * 0.005, hy - 0.5, 0], [0.02, 0.12, 2 * hz - 0.6], flat(PAL.red))
  }
  // the back: louvres, a service plate and the cord
  for (let i = 0; i < 6; i++) m.box([0, -hy + 0.5 + i * 0.16, -hz - 0.01], [1.4, 0.07, 0.02], flat(PAL.black))
  m.box([0, 0.9, -hz - 0.01], [1.2, 0.9, 0.02], flat('#c9ccd0', 'steel'))
  for (const x of [-1, 1]) for (const y of [-1, 1]) m.box([x * 0.52, 0.9 + y * 0.37, -hz - 0.03], [0.06, 0.06, 0.02], flat(PAL.black))
  m.box([0.8, -hy + 0.35, -hz - 0.04], [0.08, 0.7, 0.08], flat(PAL.black))
  return m.mesh()
}

const streetlamp = () => {
  const m = model()
  const y0 = -DIMS.lamp.h / 2
  const iron = flat('#3d4046', 'steel')
  m.cyl([0, y0 + 0.3, 0], [0.42, 0.3], 0.6, iron, { seg: 8 })
  m.cyl([0, y0 + 0.62, 0], 0.26, 0.12, iron, { seg: 8 })
  m.cyl([0, y0 + 0.6 + 4.5, 0], [0.16, 0.1], 9, iron, { seg: 8 })
  // the arm out to the head, and the head with its glowing lens
  m.box([0.8, y0 + 9.5, 0], [1.6, 0.12, 0.12], iron)
  m.box([0.45, y0 + 9.3, 0], [0.08, 0.5, 0.08], iron, [0, 0, 0.8])
  m.box([1.55, y0 + 9.45, 0], [1.0, 0.24, 0.52], { ny: flat('#ffe2a8', 'lit'), all: iron })
  return m.mesh()
}

const container = () => {
  const { hx, hy, hz } = DIMS.container
  const m = model()
  const paint = { cell: 'container', world: true }
  const rib = { cell: 'container', world: true, tint: '#c8b0a0' }
  m.box([0, 0, 0], [2 * hx - 0.1, 2 * hy - 0.2, 2 * hz - 0.1], {
    pz: { cell: 'container_mark', sub: [0, 0, 1, 1] }, all: paint,
  })
  // the corrugation, as real ribs so the outline pass draws every one
  for (let x = -hx + 0.5; x < hx - 0.3; x += 0.6) for (const s of [-1, 1]) {
    if (s > 0 && Math.abs(x) < 3.1 && x > -3.1) continue
    m.box([x, 0, s * (hz - 0.02)], [0.24, 2 * hy - 0.4, 0.08], rib)
  }
  // top and bottom rails, corner posts, corner castings
  for (const y of [-1, 1]) for (const z of [-1, 1]) m.box([0, y * (hy - 0.1), z * (hz - 0.08)], [2 * hx, 0.2, 0.18], rib)
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    m.box([x * (hx - 0.1), 0, z * (hz - 0.1)], [0.22, 2 * hy, 0.22], rib)
    for (const y of [-1, 1]) m.box([x * (hx - 0.1), y * (hy - 0.12), z * (hz - 0.1)], [0.3, 0.26, 0.3], flat('#3a3936'))
  }
  // the doors at +x: two leaves, four locking bars with their handles
  m.box([hx + 0.01, 0, 0], [0.06, 2 * hy - 0.5, 2 * hz - 0.4], { cell: 'container', world: true, tint: '#dcc0b0' })
  m.box([hx + 0.04, 0, 0], [0.04, 2 * hy - 0.5, 0.06], flat('#5a3020'))
  for (const z of [-2.1, -0.9, 0.9, 2.1]) {
    m.cyl([hx + 0.12, 0, z], 0.06, 2 * hy - 0.5, flat(PAL.steelDark, 'steel'), { seg: 6 })
    m.box([hx + 0.2, -0.5, z + 0.2], [0.06, 0.08, 0.4], flat(PAL.steelDark, 'steel'))
  }
  return m.mesh()
}

/* the pallet's boards, shared by the model and its gibs */
const palletParts = () => {
  const { hx, hy, hz } = DIMS.pallet
  const parts: Array<{ at: V3; size: V3; tint: string }> = []
  for (let i = 0; i < 7; i++) parts.push({ at: [-hx + 0.15 + i * ((2 * hx - 0.3) / 6), hy - 0.03, 0], size: [0.28, 0.06, 2 * hz], tint: '#d8c8a8' })
  for (const z of [-1, 0, 1]) parts.push({ at: [0, -0.02, z * (hz - 0.14)], size: [2 * hx, 2 * hy - 0.16, 0.28], tint: '#b09878' })
  for (const x of [-1, 0, 1]) parts.push({ at: [x * (hx - 0.15), -hy + 0.03, 0], size: [0.3, 0.06, 2 * hz], tint: '#c4b090' })
  return parts
}
const pallet = () => {
  const m = model()
  for (const p of palletParts()) m.box(p.at, p.size, wood(p.tint))
  return m.mesh()
}

const plank = () => {
  const { hx, hy, hz } = DIMS.plank
  const m = model()
  // fresh-sawn and pale, a band or two over any street or lawn it lies on,
  // with its end grain darker so the ends read as the ends
  m.box([0, 0, 0], [2 * hx, 2 * hy, 2 * hz], { ny: wood('#e8c088'), py: wood('#f2cc94'), pz: flat('#9a7048'), nz: flat('#9a7048'), side: wood('#d8ae78') })
  for (const z of [-1, 1]) for (const x of [-1, 1]) m.box([x * hx * 0.5, hy + 0.005, z * (hz - 0.35)], [0.08, 0.02, 0.08], flat(PAL.nail))
  // a stencilled grade mark near one end
  m.box([0, hy + 0.004, hz - 0.9], [0.4, 0.01, 0.3], flat('#3a5aa0'))
  return m.mesh()
}

export const MODELS: Record<string, () => THREE.Object3D> = {
  crate: crate(DIMS.crate),
  crate_small: crate(DIMS.crateSmall),
  pallet,
  plank,
  barrel: drum('drum_blue'),
  barrel_explosive: drum('drum_red'),
  trashcan,
  sawblade,
  pipe,
  hydrant,
  cone,
  ball: beachball,
  bucket,
  milk_crate: milkcrate,
  lawn_chair: lawnchair,
  wheelie_bin: wheelie,
  chair,
  table,
  couch,
  bathtub,
  mattress,
  door,
  tv,
  melon,
  bottle,
  soda_can: sodacan,
  block,
  barrier,
  cinder,
  sawhorse,
  girder,
  stop_sign: stopsign,
  tyre,
  engine,
  gascan,
  propane,
  dumpster,
  fridge,
  vending,
  streetlamp,
  container,
}

/* -------------------------------------------------------------- gibs -- */

export interface GibSpec {
  /** centre in the prop's local frame */
  at: V3
  rot?: V3
  /** half extents of its box */
  half: V3
  /** share of the prop's mass */
  share: number
  /** its mesh, drawn about its own centre; built once per spec and cloned */
  mesh: () => THREE.Object3D
}

const memo = <T,>(f: () => T) => {
  let v: T | undefined
  return () => (v ??= f())
}
const cloneOf = (f: () => THREE.Mesh) => {
  const m = memo(f)
  return () => m().clone()
}

/*
  A crate comes apart into its boards, not its panels. The first version
  split each side in two, and twelve door-sized halves is not what a crate
  does: it goes to planks and splinters. So every side is three boards laid
  the way its planks run, the middle one snapped short of its length, and
  the frame goes too: four corner posts and four rails. Thirty-two pieces,
  but only eight shapes, because a board is the same geometry on either
  side of the crate (painted on both faces, it is symmetric under the
  reflection) and one board's paint is one plank of the cell, whichever
  board it was. Eight shapes is eight instanced batches however many crates
  break at once.
*/
const crateGibs = (h: number): GibSpec[] => {
  const out: GibSpec[] = []
  const t = Math.max(0.1, h * 0.12)
  const s = 2 * h
  const w = s / 3
  // where the middle board snaps, along its length
  const SNAP = 0.42
  const edge = { cell: 'gib_edge' }
  const shapes = new Map<string, () => THREE.Object3D>()
  const board = (face: 'x' | 'y' | 'z', u0: number, u1: number) => {
    const key = `${face}${u0}${u1}`
    let mesh = shapes.get(key)
    if (!mesh) {
      const cellName = face === 'y' ? 'crate_top' : face === 'x' ? 'crate_side' : 'crate_mark'
      // one plank of the cell (the second of four), cut to the board's length
      const sub: [number, number, number, number] = face === 'y' ? [u0, 1 / 3, u1, 2 / 3] : [u0, 0.25, u1, 0.5]
      // a shade under the whole crate: the inside of a board is unweathered
      // but it lies in its own shadow, and a pale plank is a white card at a
      // distance
      const paint = { cell: cellName, sub, tint: '#cbb89c' }
      const len = s * (u1 - u0)
      mesh = cloneOf(() => {
        const m = model()
        if (face === 'y') m.box([0, 0, 0], [len, t, w], { py: { ...paint, turn: false }, ny: paint, all: edge })
        else if (face === 'x') m.box([0, 0, 0], [t, w, len], { px: paint, nx: paint, all: edge })
        else m.box([0, 0, 0], [len, w, t], { pz: paint, nz: paint, all: edge })
        return m.mesh()
      })
      shapes.set(key, mesh)
    }
    return mesh
  }
  const put = (face: 'x' | 'y' | 'z', sign: number, row: number, u0: number, u1: number) => {
    const o = sign * (h - t / 2)
    const across = -h + w * (row + 0.5)
    const along = -h + s * (u0 + u1) / 2
    const len = s * (u1 - u0)
    // x sides: boards along z, stacked in y. z sides: along x, stacked in y.
    // top and bottom: along x, side by side in z
    const at: V3 = face === 'x' ? [o, across, along] : face === 'y' ? [along, o, across] : [along, across, o]
    const half: V3 = face === 'x' ? [t / 2, w / 2, len / 2] : face === 'y' ? [len / 2, t / 2, w / 2] : [len / 2, w / 2, t / 2]
    out.push({ at, half, share: (1 / 30) * (u1 - u0) * 1.2, mesh: board(face, u0, u1) })
  }
  for (const f of ['x', 'y', 'z'] as const) {
    for (const sgn of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        if (row === 1) {
          put(f, sgn, row, 0, SNAP)
          put(f, sgn, row, SNAP, 1)
        } else put(f, sgn, row, 0, 1)
      }
    }
  }
  // the frame: corner posts and the top rails, in the batten's darker wood
  const frame = wood('#a88a70')
  const tb = Math.max(0.14, h * 0.18)
  const post = cloneOf(() => model().box([0, 0, 0], [tb, s * 0.96, tb], frame).mesh())
  const rail = cloneOf(() => model().box([0, 0, 0], [s - 2 * tb, tb, tb], frame).mesh())
  const o = h - tb / 2
  for (const x of [-1, 1]) for (const z of [-1, 1]) out.push({ at: [x * o, 0, z * o], half: [tb / 2, s * 0.48, tb / 2], share: 0.02, mesh: post })
  for (const z of [-1, 1]) out.push({ at: [0, o, z * o], half: [(s - 2 * tb) / 2, tb / 2, tb / 2], share: 0.015, mesh: rail })
  for (const x of [-1, 1]) out.push({ at: [x * o, -o, 0], rot: [0, Math.PI / 2, 0], half: [(s - 2 * tb) / 2, tb / 2, tb / 2], share: 0.015, mesh: rail })
  return out
}

const boxGib = (at: V3, size: V3, share: number, paint: Parameters<Model['box']>[2], rot?: V3): GibSpec => ({
  at,
  rot,
  half: [size[0] / 2, size[1] / 2, size[2] / 2],
  share,
  mesh: cloneOf(() => model().box([0, 0, 0], size, paint).mesh()),
})

const melonGibs = (): GibSpec[] => {
  const { rx, ry, rz } = DIMS.melon
  const out: GibSpec[] = []
  // chunks of rind, green out and red in, from all round the melon
  const rind = { py: { cell: 'melon', sub: [0.1, 0.2, 0.5, 0.8] as [number, number, number, number] }, all: { cell: 'melon_flesh' } }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const at: V3 = [Math.cos(a) * rx * 0.55, Math.sin(a) * ry * 0.55, (i % 2 ? 1 : -1) * rz * 0.35]
    const size: V3 = [0.42 + (i % 3) * 0.08, 0.2, 0.5 - (i % 2) * 0.1]
    out.push(boxGib(at, size, 0.14, rind, [0, 0, a - Math.PI / 2]))
  }
  return out
}

const bottleGibs = (): GibSpec[] => {
  const { r, hh } = DIMS.bottle
  const neck = memo(() => {
    const m = model()
    m.lathe([0, -0.18, 0], [[r * 0.8, 0], [0.075, 0.12], [0.07, 0.26]], flat('#3d7040', 'gloss'), { seg: 8 })
    m.cyl([0, 0.1, 0], 0.085, 0.07, flat('#c9a854', 'gloss'), { seg: 8 })
    return m.mesh()
  })
  const base = memo(() => {
    const m = model()
    m.cyl([0, 0, 0], r, 0.2, { side: flat('#3d7040', 'gloss'), bottom: flat('#2a4a2c', 'gloss'), top: flat('#1f3a22') }, { seg: 10, open: false })
    return m.mesh()
  })
  return [
    { at: [0, hh - 0.2, 0], half: [0.08, 0.18, 0.08], share: 0.3, mesh: () => neck().clone() },
    { at: [0, -hh + 0.1, 0], half: [r, 0.1, r], share: 0.4, mesh: () => base().clone() },
  ]
}

const palletGibs = (): GibSpec[] =>
  palletParts().map((p) => boxGib(p.at, p.size, 1 / 13, wood(p.tint)))

const plankGibs = (): GibSpec[] => {
  const { hx, hy, hz } = DIMS.plank
  return [-1, 1].map((s) => boxGib([0, 0, s * hz * 0.5], [2 * hx, 2 * hy, hz * 0.96], 0.5, { py: wood('#d4aa78'), ny: wood('#c9a070'), side: wood('#c49a68'), pz: { cell: 'gib_edge' }, nz: { cell: 'gib_edge' } }))
}

const chairGibs = (): GibSpec[] => CHAIR_PARTS.map((p) => boxGib(p.at, p.size, 1 / CHAIR_PARTS.length, wood('#b48a66'), p.rot))

/** what is left of something that went off: scorched shell and a lid */
const blastGibs = (id: 'barrel' | 'gascan' | 'propane'): GibSpec[] => {
  const burnt = '#5a3a30'
  const out: GibSpec[] = []
  if (id === 'barrel') {
    const { r, hh } = DIMS.drum
    out.push({
      at: [0, hh - 0.05, 0], half: [r, 0.05, r], share: 0.12,
      mesh: cloneOf(() => model().cyl([0, 0, 0], r + 0.03, 0.1, { side: flat('#3a3a3c'), top: { cell: 'drum_lid' }, bottom: flat(burnt) }, { seg: 14 }).mesh()),
    })
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2
      out.push(boxGib([Math.cos(a) * r * 0.7, (i - 1) * 0.5, Math.sin(a) * r * 0.7], [0.9, 0.7, 0.06], 0.2,
        { pz: { cell: 'drum_red', sub: [i / 3, 0.2, i / 3 + 0.25, 0.8], tint: '#8a7a70' }, all: flat(burnt) }, [0, -a + Math.PI / 2, 0.3 * (i - 1)]))
    }
  } else if (id === 'gascan') {
    for (const s of [-1, 1]) out.push(boxGib([0, s * 0.25, 0], [0.8, 0.5, 0.06], 0.4, { pz: { cell: 'jerry', tint: '#8a7a70' }, all: flat(burnt) }, [0, 0, s * 0.3]))
  } else {
    const { r, hh } = DIMS.propane
    out.push({
      at: [0, hh - 0.3, 0], half: [r * 0.8, 0.18, r * 0.8], share: 0.2,
      mesh: cloneOf(() => model().lathe([0, -0.17, 0], [[r, 0], [r * 0.92, 0.18], [r * 0.6, 0.3], [0.001, 0.34]], flat('#b8b9b2', 'gloss'), { seg: 12 }).mesh()),
    })
    for (let i = 0; i < 2; i++) out.push(boxGib([(i ? 1 : -1) * r * 0.6, -0.2, 0], [0.8, 0.9, 0.06], 0.3, { pz: { cell: 'propane', tint: '#8a8a80' }, all: flat(burnt) }, [0, i ? Math.PI / 2 : -Math.PI / 2, 0.4]))
  }
  return out
}

export const GIBS: Record<string, () => GibSpec[]> = {
  barrel_explosive: memo(() => blastGibs('barrel')),
  gascan: memo(() => blastGibs('gascan')),
  propane: memo(() => blastGibs('propane')),
  crate: memo(() => crateGibs(DIMS.crate)),
  crate_small: memo(() => crateGibs(DIMS.crateSmall)),
  pallet: memo(palletGibs),
  plank: memo(plankGibs),
  chair: memo(chairGibs),
  melon: memo(melonGibs),
  bottle: memo(bottleGibs),
}
