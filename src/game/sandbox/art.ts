import * as THREE from 'three'
import { TEXELS_PER_UNIT } from '../render/texel'

/*
  How every prop in the catalogue is drawn: one texture atlas, one material,
  and a small builder that stamps primitives into a merged geometry with the
  atlas mapped onto them.

  The catalogue is forty-odd props, and the rule it answers to is the boot
  cost one (nothing may link a shader mid-walk): so the whole of it, every
  crate, drum, sofa and gib, is drawn by exactly one `MeshStandardMaterial`
  with a colour map, an emissive map and a roughness map that are three
  layers of the same atlas. Spawning the fortieth kind costs a geometry
  upload and nothing else. The effects (explosions, splinters) add three
  more programs, all compiled under the cover with this one (see fx.ts).

  The atlas is a canvas painted at runtime, cell by cell, by small pixel-art
  painters (`Pen`), at the world's texel density: `TEXELS_PER_UNIT` (16), so
  a one-metre crate face is a 38-texel panel and the planks on it are the
  same size as the planks on a shopfront. Cells are declared by the modules
  that own the art (`cell()`), packed on first use, and looked up by name.
  Nearest magnification keeps each texel square up close, mipmaps keep it
  quiet far away (texel.ts). Cells carry a one-texel gutter of their own edge
  colour so a mip never bleeds a neighbour's colour across a seam.

  The builder (`model()`) is how a prop is shaped: boxes, cylinders, lathes,
  extruded profiles and ellipsoids, each placed with a position, a size and
  an Euler turn, each face painted with a cell and a tint (vertex colour,
  multiplied in). Faces can take a sub-rectangle of a cell, which is how a
  crate's gibs carry exactly the planks they were cut from, and `world: true`
  maps a cell at world scale instead of stretching it, so a small patch of
  painted steel covers a small face at the right density. Everything is
  merged into one BufferGeometry per model, so a prop is one draw.

  Headless, nothing here paints: the layout (which cell lands where) is pure
  arithmetic, and the canvas only exists once a material is asked for.
*/

export type V3 = [number, number, number]

/* ----------------------------------------------------------- the pen -- */

/** a tiny pixel-art brush over one cell of a 2D canvas, in cell texels */
export interface Pen {
  readonly w: number
  readonly h: number
  fill: (c: string) => void
  rect: (x: number, y: number, w: number, h: number, c: string) => void
  px: (x: number, y: number, c: string) => void
  /** a filled disc on the texel grid */
  disc: (cx: number, cy: number, r: number, c: string) => void
  /** a one-texel line (Bresenham) */
  line: (x0: number, y0: number, x1: number, y1: number, c: string) => void
  /** scatter single texels of `c` over a share of the cell */
  speckle: (c: string, share: number, seed: number, x?: number, y?: number, w?: number, h?: number) => void
  /** pixel-font text (3x5 or 5x7), top-left at x, y */
  text: (s: string, x: number, y: number, c: string, big?: boolean) => void
  /** the width a string takes in the font */
  measure: (s: string, big?: boolean) => number
  /** a filled polygon from texel points */
  poly: (pts: Array<[number, number]>, c: string) => void
}

/* A 3x5 and a 5x7 font, only the glyphs the catalogue paints. Each row is a
   bit string, most significant bit leftmost. */
const F3: Record<string, number[]> = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7],
  F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], K: [5, 5, 6, 5, 5],
  L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4],
  R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2],
  W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5], Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [6, 1, 2, 4, 7], '3': [6, 1, 2, 1, 6], '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 6, 1, 6], '6': [3, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 6],
  '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], '!': [2, 2, 2, 0, 2], ' ': [0, 0, 0, 0, 0], '/': [1, 1, 2, 4, 4],
  '^': [2, 7, 2, 2, 2],
}
const F5: Record<string, number[]> = {
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], C: [14, 17, 16, 16, 16, 17, 14], L: [16, 16, 16, 16, 16, 16, 31],
  A: [14, 17, 17, 31, 17, 17, 17], E: [31, 16, 16, 30, 16, 16, 31], X: [17, 17, 10, 4, 10, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], N: [17, 25, 21, 19, 17, 17, 17], ' ': [0, 0, 0, 0, 0, 0, 0],
  '!': [4, 4, 4, 4, 4, 0, 4], R: [30, 17, 17, 30, 20, 18, 17], G: [14, 17, 16, 23, 17, 17, 15],
  K: [17, 18, 20, 24, 20, 18, 17], D: [30, 17, 17, 17, 17, 17, 30], U: [17, 17, 17, 17, 17, 17, 14],
  M: [17, 27, 21, 21, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], F: [31, 16, 16, 30, 16, 16, 16],
  V: [17, 17, 17, 17, 17, 10, 4], Y: [17, 17, 10, 4, 4, 4, 4], H: [17, 17, 17, 31, 17, 17, 17],
  W: [17, 17, 17, 21, 21, 21, 10], Z: [31, 1, 2, 4, 8, 16, 31],
}

const makePen = (ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number): Pen => {
  const rect = (x: number, y: number, rw: number, rh: number, c: string) => {
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(w, Math.round(x + rw))
    const y1 = Math.min(h, Math.round(y + rh))
    if (x1 <= x0 || y1 <= y0) return
    ctx.fillStyle = c
    ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0)
  }
  const px = (x: number, y: number, c: string) => rect(x, y, 1, 1, c)
  const glyphs = (s: string, big: boolean) => [...s.toUpperCase()].map((ch) => (big ? F5 : F3)[ch] ?? (big ? F5 : F3)[' '])
  const pen: Pen = {
    w,
    h,
    fill: (c) => rect(0, 0, w, h, c),
    rect,
    px,
    disc: (cx, cy, r, c) => {
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const dx = x + 0.5 - cx
          const dy = y + 0.5 - cy
          if (dx * dx + dy * dy <= r * r) px(x, y, c)
        }
    },
    line: (x0, y0, x1, y1, c) => {
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1)
      const dx = Math.abs(x1 - x0)
      const dy = -Math.abs(y1 - y0)
      const sx = x0 < x1 ? 1 : -1
      const sy = y0 < y1 ? 1 : -1
      let err = dx + dy
      for (let i = 0; i < 4096; i++) {
        px(x0, y0, c)
        if (x0 === x1 && y0 === y1) break
        const e2 = 2 * err
        if (e2 >= dy) { err += dy; x0 += sx }
        if (e2 <= dx) { err += dx; y0 += sy }
      }
    },
    speckle: (c, share, seed, x = 0, y = 0, sw = w, sh = h) => {
      let s = (seed * 2654435761) >>> 0 || 1
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
      const n = Math.round(sw * sh * share)
      for (let i = 0; i < n; i++) px(x + Math.floor(rnd() * sw), y + Math.floor(rnd() * sh), c)
    },
    text: (s, x, y, c, big = false) => {
      const cw = big ? 5 : 3
      let cx = x
      for (const g of glyphs(s, big)) {
        g.forEach((row, ry) => {
          for (let bx = 0; bx < cw; bx++) if (row & (1 << (cw - 1 - bx))) px(cx + bx, y + ry, c)
        })
        cx += cw + 1
      }
    },
    measure: (s, big = false) => s.length * ((big ? 5 : 3) + 1) - 1,
    poly: (pts, c) => {
      // scanline fill at texel centres
      let y0 = Infinity
      let y1 = -Infinity
      for (const [, py] of pts) { y0 = Math.min(y0, py); y1 = Math.max(y1, py) }
      for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
        const yc = y + 0.5
        const xs: number[] = []
        for (let i = 0; i < pts.length; i++) {
          const [ax, ay] = pts[i]
          const [bx, by] = pts[(i + 1) % pts.length]
          if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax))
        }
        xs.sort((a, b) => a - b)
        for (let i = 0; i + 1 < xs.length; i += 2) {
          for (let x = Math.round(xs[i]); x < Math.round(xs[i + 1]); x++) px(x, y, c)
        }
      }
    },
  }
  return pen
}

/* --------------------------------------------------------- the atlas -- */

export interface CellSpec {
  /** texels */
  w: number
  h: number
  /** the colour layer */
  paint: (p: Pen) => void
  /** what glows (the emissive layer), black elsewhere */
  glow?: (p: Pen) => void
  /** 0..1, how matte (the roughness layer); 0.85 when omitted */
  rough?: number
}

interface Placed extends CellSpec {
  x: number
  y: number
}

/** the atlas is this wide; its height grows with what is declared */
const ATLAS_W = 1024
/** texels of gutter around every cell */
const GUTTER = 2
const specs = new Map<string, CellSpec>()
let placed: Map<string, Placed> | null = null
let atlasH = 0

/** declare a cell. Declare everything before the first model is built */
export const cell = (name: string, spec: CellSpec) => {
  if (placed) throw new Error(`cell "${name}" declared after the atlas was packed`)
  specs.set(name, spec)
}

/** a flat white cell every untextured face samples, tinted by vertex colour */
cell('white', { w: 4, h: 4, paint: (p) => p.fill('#ffffff') })
/** the same for things that should shine (enamel, glass, plastic) */
cell('gloss', { w: 4, h: 4, rough: 0.35, paint: (p) => p.fill('#ffffff') })
/** a flat white that glows: lamp heads, screens, fire in a model */
cell('lit', { w: 4, h: 4, paint: (p) => p.fill('#ffffff'), glow: (p) => p.fill('#ffffff') })

const layout = () => {
  if (placed) return placed
  placed = new Map()
  // shelf-pack, tallest first, so rows waste little
  const order = [...specs.entries()].sort((a, b) => b[1].h - a[1].h)
  let x = 0
  let y = 0
  let row = 0
  for (const [name, s] of order) {
    const w = s.w + GUTTER * 2
    const h = s.h + GUTTER * 2
    if (x + w > ATLAS_W) {
      x = 0
      y += row
      row = 0
    }
    placed.set(name, { ...s, x: x + GUTTER, y: y + GUTTER })
    x += w
    row = Math.max(row, h)
  }
  atlasH = 1 << Math.ceil(Math.log2(Math.max(16, y + row)))
  return placed
}

const cellOf = (name: string) => {
  const c = layout().get(name)
  if (!c) throw new Error(`no atlas cell "${name}"`)
  return c
}

/** a cell's rectangle in 0..1 atlas uv, with v up (three's convention) */
const cellUV = (name: string, sub?: readonly number[]) => {
  const c = cellOf(name)
  const [s0, t0, s1, t1] = sub ?? [0, 0, 1, 1]
  const u0 = (c.x + s0 * c.w) / ATLAS_W
  const u1 = (c.x + s1 * c.w) / ATLAS_W
  // canvas y runs down, uv v runs up
  const v0 = 1 - (c.y + (1 - t0) * c.h) / atlasH
  const v1 = 1 - (c.y + (1 - t1) * c.h) / atlasH
  return [u0, v0, u1, v1] as const
}

/** the uv of a cell's centre, for geometry that samples one flat colour */
export const cellCenter = (name: string): [number, number] => {
  const [u0, v0, u1, v1] = cellUV(name)
  return [(u0 + u1) / 2, (v0 + v1) / 2]
}

interface Layers {
  color: THREE.CanvasTexture
  glow: THREE.CanvasTexture
  rough: THREE.CanvasTexture
}
let layers: Layers | null = null

/** copy each cell's border outward into its gutter, so mips do not bleed */
const bleed = (ctx: CanvasRenderingContext2D, c: Placed) => {
  const g = GUTTER
  ctx.drawImage(ctx.canvas, c.x, c.y, c.w, 1, c.x, c.y - g, c.w, g)
  ctx.drawImage(ctx.canvas, c.x, c.y + c.h - 1, c.w, 1, c.x, c.y + c.h, c.w, g)
  ctx.drawImage(ctx.canvas, c.x, c.y - g, 1, c.h + 2 * g, c.x - g, c.y - g, g, c.h + 2 * g)
  ctx.drawImage(ctx.canvas, c.x + c.w - 1, c.y - g, 1, c.h + 2 * g, c.x + c.w, c.y - g, g, c.h + 2 * g)
}

const paintLayers = (): Layers => {
  const cells = layout()
  const mk = () => {
    const cv = document.createElement('canvas')
    cv.width = ATLAS_W
    cv.height = atlasH
    const ctx = cv.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, ATLAS_W, atlasH)
    return { cv, ctx }
  }
  const col = mk()
  const glow = mk()
  const rough = mk()
  for (const c of cells.values()) {
    c.paint(makePen(col.ctx, c.x, c.y, c.w, c.h))
    bleed(col.ctx, c)
    if (c.glow) {
      c.glow(makePen(glow.ctx, c.x, c.y, c.w, c.h))
      bleed(glow.ctx, c)
    }
    // three reads roughness from green; metalness (unused) from blue
    const r = Math.round((c.rough ?? 0.85) * 255)
    rough.ctx.fillStyle = `rgb(0,${r},0)`
    rough.ctx.fillRect(c.x - GUTTER, c.y - GUTTER, c.w + 2 * GUTTER, c.h + 2 * GUTTER)
  }
  const tex = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv)
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    t.magFilter = THREE.NearestFilter
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.generateMipmaps = true
    t.anisotropy = 1
    t.needsUpdate = true
    return t
  }
  return { color: tex(col.cv, true), glow: tex(glow.cv, true), rough: tex(rough.cv, false) }
}

/** the atlas as a canvas, for the thumbnail sheet and debugging */
export const atlasCanvas = () => {
  propMaterial()
  return (layers?.color.image as HTMLCanvasElement | undefined) ?? null
}

let material: THREE.MeshStandardMaterial | null = null

/** how hot the atlas's glow layer burns; HDR, because the look's ACES
    compresses whatever the material emits */
export const GLOW = 2.4

/**
 * The one material every prop, gib and placeholder draws with. Colour is the
 * atlas times the vertex colour. Headless (no document) it has no maps and
 * nobody draws it anyway.
 */
export const propMaterial = () => {
  if (material) return material
  const canPaint = typeof document !== 'undefined'
  if (canPaint) layers = paintLayers()
  material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: layers?.color ?? null,
    emissiveMap: layers?.glow ?? null,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: canPaint ? GLOW : 0,
    roughnessMap: layers?.rough ?? null,
    roughness: 1,
    metalness: 0,
  })
  material.name = 'sandbox-props'
  return material
}

/* ------------------------------------------------------- the builder -- */

export interface Paint {
  /** atlas cell; 'white' when omitted */
  cell?: string
  /** vertex colour multiplied in; white when omitted */
  tint?: string | THREE.Color
  /** a sub-rectangle of the cell, 0..1 (s0, t0, s1, t1), t up */
  sub?: readonly [number, number, number, number]
  /** map the cell at world density from its corner instead of stretching */
  world?: boolean
  /** turn the mapping a quarter (for a face whose u should run up) */
  turn?: boolean
}

export type Face = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz'
/** per face, with `side` covering the four vertical faces and `all` the rest */
export type BoxPaint = Paint | Partial<Record<Face | 'side' | 'all', Paint>>
/** a cylinder, lathe or prism: the wall and the two ends */
export type RoundPaint = Paint | { side?: Paint; top?: Paint; bottom?: Paint; all?: Paint }

const FACES: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz']
const isPaint = (p: unknown): p is Paint =>
  !p || typeof p !== 'object' || 'cell' in p || 'tint' in p || 'sub' in p || 'world' in p || 'turn' in p || Object.keys(p).length === 0

const faceOf = (bp: BoxPaint | undefined, f: Face): Paint => {
  if (!bp || isPaint(bp)) return (bp as Paint) ?? {}
  const m = bp as Partial<Record<Face | 'side' | 'all', Paint>>
  return m[f] ?? (f !== 'py' && f !== 'ny' ? m.side : undefined) ?? m.all ?? {}
}
const roundOf = (rp: RoundPaint | undefined, part: 'side' | 'top' | 'bottom'): Paint => {
  if (!rp || isPaint(rp)) return (rp as Paint) ?? {}
  const m = rp as { side?: Paint; top?: Paint; bottom?: Paint; all?: Paint }
  return m[part] ?? m.all ?? {}
}

const colorCache = new Map<string, THREE.Color>()
const tintOf = (t: Paint['tint']) => {
  if (!t) return WHITE
  if (typeof t !== 'string') return t
  let c = colorCache.get(t)
  if (!c) {
    c = new THREE.Color(t)
    colorCache.set(t, c)
  }
  return c
}
const WHITE = new THREE.Color(1, 1, 1)

export interface Model {
  /** a box centred at `at`, `size` full extents, turned by Euler `rot` */
  box: (at: V3, size: V3, paint?: BoxPaint, rot?: V3) => Model
  /** a cylinder along y centred at `at`: radius (or [bottom, top]), height */
  cyl: (at: V3, r: number | [number, number], h: number, paint?: RoundPaint, o?: { seg?: number; rot?: V3; open?: boolean; flat?: boolean; phase?: number }) => Model
  /** a surface of revolution about y from (radius, y) points, bottom up */
  lathe: (at: V3, pts: Array<[number, number]>, paint?: Paint, o?: { seg?: number; rot?: V3; phase?: number }) => Model
  /** a 2D profile in x/y extruded `depth` along z, centred */
  prism: (at: V3, profile: Array<[number, number]>, depth: number, paint?: RoundPaint, rot?: V3) => Model
  /** an ellipsoid; uv runs round (u) and pole to pole (v) */
  ball: (at: V3, radii: V3, paint?: Paint, o?: { w?: number; h?: number; rot?: V3 }) => Model
  /** any geometry with a 0..1 uv, transformed and painted with one paint */
  geo: (g: THREE.BufferGeometry, at: V3, scale: V3, paint?: Paint, rot?: V3) => Model
  readonly vertices: number
  /** the merged geometry */
  geometry: () => THREE.BufferGeometry
  /** ...on the shared material, casting and receiving shadows */
  mesh: () => THREE.Mesh
}

const tmpM = new THREE.Matrix4()
const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpV = new THREE.Vector3()
const tmpS = new THREE.Vector3()
const tmpN = new THREE.Matrix3()

const matrix = (at: V3, scale: V3, rot?: V3) => {
  tmpE.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0)
  tmpQ.setFromEuler(tmpE)
  return tmpM.compose(tmpV.set(at[0], at[1], at[2]), tmpQ, tmpS.set(scale[0], scale[1], scale[2]))
}

const unitBox = new THREE.BoxGeometry(1, 1, 1)

/** start a model. Everything added is merged into one geometry */
export const model = (): Model => {
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const v = new THREE.Vector3()

  /** append vertices [from, to) of `g` through `m`, uv remapped by `paint`.
      `span` is the face's size in world units, for world-density mapping */
  const put = (
    g: THREE.BufferGeometry, m: THREE.Matrix4, paint: Paint,
    from: number, to: number, span?: [number, number],
  ) => {
    const p = g.getAttribute('position')
    const n = g.getAttribute('normal')
    const t = g.getAttribute('uv')
    const base = pos.length / 3
    tmpN.getNormalMatrix(m)
    let sub = paint.sub
    if (paint.world && span) {
      const c = cellOf(paint.cell ?? 'white')
      const s = [Math.min(1, (span[0] * TEXELS_PER_UNIT) / c.w), Math.min(1, (span[1] * TEXELS_PER_UNIT) / c.h)]
      sub = [0, 0, s[0], s[1]]
    }
    const [u0, v0, u1, v1] = cellUV(paint.cell ?? 'white', sub)
    const c = tintOf(paint.tint)
    for (let i = from; i < to; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m)
      pos.push(v.x, v.y, v.z)
      v.fromBufferAttribute(n, i).applyMatrix3(tmpN).normalize()
      nor.push(v.x, v.y, v.z)
      let s = t ? t.getX(i) : 0
      let q = t ? t.getY(i) : 0
      if (paint.turn) [s, q] = [q, 1 - s]
      uv.push(u0 + (u1 - u0) * s, v0 + (v1 - v0) * q)
      col.push(c.r, c.g, c.b)
    }
    const gi = g.getIndex()
    if (gi) {
      // only the triangles whose vertices all fall in [from, to)
      for (let i = 0; i < gi.count; i += 3) {
        const a = gi.getX(i)
        if (a < from || a >= to) continue
        idx.push(base + a - from, base + gi.getX(i + 1) - from, base + gi.getX(i + 2) - from)
      }
    } else {
      for (let i = 0; i < to - from; i++) idx.push(base + i)
    }
  }

  /** a geometry's groups, each painted by `pick(groupIndex)` */
  const putGroups = (g: THREE.BufferGeometry, m: THREE.Matrix4, pick: (gi: number) => Paint, spans?: (gi: number) => [number, number]) => {
    // three's primitives are indexed and their groups index into the index
    // buffer; the vertex range of each group is contiguous for the ones used
    const gi = g.getIndex()!
    g.groups.forEach((grp, k) => {
      let lo = Infinity
      let hi = -Infinity
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        const a = gi.getX(i)
        lo = Math.min(lo, a)
        hi = Math.max(hi, a)
      }
      if (lo <= hi) put(g, m, pick(k), lo, hi + 1, spans?.(k))
    })
  }

  const cylCache = new Map<string, THREE.BufferGeometry>()

  const api: Model = {
    box(at, size, paint, rot) {
      const m = matrix(at, size, rot)
      putGroups(unitBox, m, (k) => faceOf(paint, FACES[k]), (k) => {
        const [sx, sy, sz] = size
        return k < 2 ? [sz, sy] : k < 4 ? [sx, sz] : [sx, sy]
      })
      return api
    },
    cyl(at, r, h, paint, o = {}) {
      const seg = o.seg ?? 12
      const [rb, rt] = typeof r === 'number' ? [r, r] : r
      const key = `${seg}:${rb === rt ? 1 : rt / rb}:${o.open ? 1 : 0}:${o.phase ?? 0}`
      let g = cylCache.get(key)
      if (!g) {
        g = new THREE.CylinderGeometry(rb === rt ? 1 : rt / rb, 1, 1, seg, 1, !!o.open, o.phase ?? 0)
        if (o.flat) g = g.toNonIndexed()
        cylCache.set(key, g)
      }
      const m = matrix(at, [rb, h, rb], o.rot)
      const circ = Math.PI * 2 * rb
      putGroups(g, m, (k) => roundOf(paint, k === 0 ? 'side' : k === 1 ? 'top' : 'bottom'), (k) =>
        k === 0 ? [circ, h] : [2 * rb, 2 * rb])
      return api
    },
    lathe(at, pts, paint, o = {}) {
      const g = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), o.seg ?? 12, o.phase ?? 0)
      put(g, matrix(at, [1, 1, 1], o.rot), paint ?? {}, 0, g.getAttribute('position').count)
      g.dispose()
      return api
    },
    prism(at, profile, depth, paint, rot) {
      const shape = new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x, y)))
      const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 })
      g.translate(0, 0, -depth / 2)
      // ExtrudeGeometry's uvs are in shape units: normalise them per group
      const t = g.getAttribute('uv')
      const p = g.getAttribute('position')
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (const [x, y] of profile) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
      const nonIdx = g.index ? g.toNonIndexed() : g
      const tt = nonIdx.getAttribute('uv')
      const pp = nonIdx.getAttribute('position')
      const nn = nonIdx.getAttribute('normal')
      for (let i = 0; i < tt.count; i++) {
        const nz = Math.abs(nn.getZ(i))
        if (nz > 0.5) tt.setXY(i, (pp.getX(i) - x0) / (x1 - x0 || 1), (pp.getY(i) - y0) / (y1 - y0 || 1))
        else tt.setXY(i, (pp.getZ(i) + depth / 2) / depth, (pp.getY(i) - y0) / (y1 - y0 || 1))
      }
      void t
      void p
      const m = matrix(at, [1, 1, 1], rot)
      // walls first (group 1 in ExtrudeGeometry is the side), caps (group 0)
      const caps = roundOf(paint, 'top')
      const side = roundOf(paint, 'side')
      nonIdx.groups.forEach((grp, k) => {
        put(nonIdx, m, k === 0 ? caps : side, grp.start, grp.start + grp.count, k === 0 ? [x1 - x0, y1 - y0] : [depth, y1 - y0])
      })
      g.dispose()
      if (nonIdx !== g) nonIdx.dispose()
      return api
    },
    ball(at, radii, paint, o = {}) {
      const g = new THREE.SphereGeometry(1, o.w ?? 12, o.h ?? 8)
      put(g, matrix(at, radii, o.rot), paint ?? {}, 0, g.getAttribute('position').count)
      g.dispose()
      return api
    },
    geo(g, at, scale, paint, rot) {
      put(g, matrix(at, scale, rot), paint ?? {}, 0, g.getAttribute('position').count)
      return api
    },
    get vertices() {
      return pos.length / 3
    },
    geometry() {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
      g.setIndex(idx)
      g.computeBoundingSphere()
      g.computeBoundingBox()
      return g
    },
    mesh() {
      const mesh = new THREE.Mesh(api.geometry(), propMaterial())
      mesh.castShadow = true
      mesh.receiveShadow = true
      return mesh
    },
  }
  return api
}

/* ---------------------------------------------------------- colour -- */

/** scale a hex colour's channels (multiplicative, see src/game/CLAUDE.md) */
export const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k))
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k))
  const b = Math.min(255, Math.round((n & 255) * k))
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}
