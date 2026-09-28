import { BLOCKS, textureIndex } from '../../sandbox/blocks'
import { BIOMES, CHUNK, H, type ChunkData } from './gen'

/*
  A chunk of blocks turned into two meshes: everything solid-looking (the
  cubes, the leaves and glass with their see-through pixels, the crossed
  cards of the plants, the torches, the lava) and the water.

  **Greedy.** Faces are only made where a block meets one that does not hide
  it, and each slice of the chunk merges its faces into the biggest
  rectangles that look the same: the same texture, the same tint, the same
  shading at all four corners and the same light. A flat sunny field is a
  handful of quads rather than a quad a block, and the texture repeats
  across a merged quad because its coordinates are in blocks and the
  material samples an array texture that wraps (material.ts). What is not
  a cube (a plant, a torch, a liquid that is flowing and so not level with
  its neighbours) is made cell by cell after.

  **Shading** is three things. Ambient occlusion at every vertex (each
  corner darkened by the blocks touching it, the classic three-neighbour
  rule, with the quad's diagonal flipped so the gradient runs the right
  way). Sky light, which is whether the block in front of the face sees the
  sky (the column's highest opaque block is below it), half-sees it (a
  neighbouring column's is), or is under ground, darker the deeper it is.
  Both are baked into the vertex colour with the biome's tint for grass and
  leaves. And block light, the game's own: every block that gives light (a
  torch 14, glowstone, lanterns and lava 15) floods it through everything
  that is not opaque, one level a block, across the chunk seams (the flood
  runs over the chunk and the eight round it); a face takes the level of the
  block in front of it. That one is not baked into the colour: it travels as
  its own byte and the material adds it as warm emitted light, strongest in
  the dark (material.ts), so a torch lights a cave by day and a whole
  hillside at night.

  **Liquids** have levels (sandbox/blocks.ts): a source or a falling column
  stands an eighth of a block under the surface and is meshed greedily like
  a cube; a flowing block is lower the further it has run, and the step down
  from one to the next is drawn as its own strip, so a spreading sheet of
  water is a staircase of thin slabs, as there.

  **The format** is small because the whole visible world is in it:
  positions and texture coordinates are 16-bit integers in sixteenths of
  a block (the mesh is scaled by B/16), normals are bytes, colour is three
  bytes (at half scale, so a tint can go over one), and four more bytes are
  the texture layer, the flags (glows, is a liquid, is flowing), the sky
  light and the block light: about twenty-two bytes a vertex. Sixteenths
  because that is one pixel of a painting: in eighths a torch's two-pixel
  stick (columns 7 and 8) rounded to columns 8 and 9, half of every face
  sampled the transparent column beside it and was discarded, and a torch
  drew as two thin splinters with a gap between them and its flame
  stretched a pixel too tall. Anything cut to the pixel (the torch, and
  whatever small shape comes next) needs the pixel to be representable.
*/

/* the region a chunk is meshed from: itself and the eight round it, which
   is exactly as far as a torch's light can reach into it */
const RW = CHUNK * 3
const RO = CHUNK
const RY = H + 2
const vox = new Uint8Array(RW * RW * RY)
const tops = new Int16Array(RW * RW)
const bl = new Uint8Array(RW * RW * RY)
let blUsed = false
const queue = new Int32Array(RW * RW * RY)
const SX = 1
const SZ = RW
const SYs = RW * RW
/** index in the region of chunk-local (x, y, z); x and z may run -16..31,
    y -1..H */
const ri = (x: number, y: number, z: number) => x + RO + (z + RO) * RW + (y + 1) * SYs

/* what each block does to the mesher, flattened for the inner loops */
const OPAQUE = new Uint8Array(256)
const CROSS = new Uint8Array(256)
const LIQUID = new Uint8Array(256)
const GLOW = new Uint8Array(256)
const TINT = new Uint8Array(256)
const EMIT = new Uint8Array(256)
const TORCH = new Uint8Array(256)
/** 1 water, 2 lava */
const FAM = new Uint8Array(256)
/** a liquid's level as drawn, 0 a source, 1..7 flowing, 8 falling */
const LVL = new Uint8Array(256)
/** cells the greedy pass leaves to the cell pass */
const SPECIAL = new Uint8Array(256)
/** texture layer per block and face: [top, side, bottom] */
const LAYER = new Uint8Array(256 * 3)
for (const b of BLOCKS) {
  OPAQUE[b.id] = b.opaque ? 1 : 0
  CROSS[b.id] = b.cross ? 1 : 0
  LIQUID[b.id] = b.liquid ? 1 : 0
  GLOW[b.id] = b.glow ? 1 : 0
  TINT[b.id] = b.tint === 'grass' ? 1 : b.tint === 'foliage' ? 2 : 0
  EMIT[b.id] = b.light ?? 0
  TORCH[b.id] = b.shape === 'torch' ? 1 : 0
  FAM[b.id] = b.fluid === 'water' ? 1 : b.fluid === 'lava' ? 2 : 0
  // lava's flowing levels run every other step of water's, as there
  LVL[b.id] = b.level === 8 ? 8 : b.fluid === 'lava' ? Math.min(7, (b.level ?? 0) * 2) : (b.level ?? 0)
  SPECIAL[b.id] = b.cross || b.shape === 'torch' || (b.liquid && LVL[b.id] >= 1 && LVL[b.id] <= 7) ? 1 : 0
  LAYER[b.id * 3] = textureIndex.get(b.top) ?? 0
  LAYER[b.id * 3 + 1] = textureIndex.get(b.side) ?? 0
  LAYER[b.id * 3 + 2] = textureIndex.get(b.bottom) ?? 0
}

/** the colours grass and leaves take in each biome: gen.ts's BIOMES (the
    real generator's own colours) as multipliers on the plains', which is
    what the textures are painted in. Linear, since that is where the vertex
    colour multiplies */
const lin = (hex: string, k: number) => Math.pow(((parseInt(hex.slice(1), 16) >> k) & 255) / 255, 2.2)
const tintsOf = (key: 'grass' | 'foliage') =>
  BIOMES.map((b) => {
    const ref = BIOMES[0][key]
    return [16, 8, 0].map((k) => lin(b[key], k) / lin(ref, k)) as [number, number, number]
  })
const GRASS_TINT = tintsOf('grass')
const FOLIAGE_TINT = tintsOf('foliage')
const WHITE: [number, number, number] = [1, 1, 1]

const AO = [0.5, 0.68, 0.84, 1]
/** sky light 0..15 to a brightness (material.ts undoes exactly this to find
    the albedo block light shines on: keep the two in step; held.ts lights
    the block in hand on it too) */
export const LIGHT = Array.from({ length: 16 }, (_, l) => 0.1 + 0.9 * Math.pow(l / 15, 1.5))

/** the flags byte */
const F_GLOW = 1
const F_LIQUID = 2
const F_FLOW = 4

export interface MeshArrays {
  position: Int16Array
  normal: Int8Array
  tex: Int16Array
  color: Uint8Array
  /** texture layer, flags, sky light, block light */
  blk: Uint8Array
  index: Uint16Array | Uint32Array
}

/** a growable vertex store, reused between chunks */
const makeStore = () => {
  let cap = 1 << 15
  let pos = new Int16Array(cap * 3)
  let nor = new Int8Array(cap * 3)
  let tex = new Int16Array(cap * 2)
  let col = new Uint8Array(cap * 3)
  let blk = new Uint8Array(cap * 4)
  let flips = new Uint8Array(cap / 4)
  let n = 0
  const grow = () => {
    cap *= 2
    const g = <T extends Int16Array | Int8Array | Uint8Array>(a: T, k: number): T => {
      const b = new (a.constructor as new (n: number) => T)(cap * k)
      b.set(a)
      return b
    }
    pos = g(pos, 3)
    nor = g(nor, 3)
    tex = g(tex, 2)
    col = g(col, 3)
    blk = g(blk, 4)
    const f = new Uint8Array(cap / 4)
    f.set(flips)
    flips = f
  }
  return {
    reset: () => {
      n = 0
    },
    vert: (
      x: number, y: number, z: number, nx: number, ny: number, nz: number,
      u: number, v: number, r: number, g: number, b: number,
      layer: number, flags: number, sky: number, block: number,
    ) => {
      if (n >= cap) grow()
      pos[n * 3] = Math.round(x * 16)
      pos[n * 3 + 1] = Math.round(y * 16)
      pos[n * 3 + 2] = Math.round(z * 16)
      nor[n * 3] = nx * 127
      nor[n * 3 + 1] = ny * 127
      nor[n * 3 + 2] = nz * 127
      tex[n * 2] = Math.round(u * 16)
      tex[n * 2 + 1] = Math.round(v * 16)
      // at half scale: a biome's tint may lift a channel over 1, and the
      // material doubles it back (material.ts)
      col[n * 3] = Math.min(255, Math.round(r * 127.5))
      col[n * 3 + 1] = Math.min(255, Math.round(g * 127.5))
      col[n * 3 + 2] = Math.min(255, Math.round(b * 127.5))
      blk[n * 4] = layer
      blk[n * 4 + 1] = flags
      blk[n * 4 + 2] = sky
      blk[n * 4 + 3] = block
      n++
    },
    /** the quad just finished takes the other diagonal */
    flip: (f: number) => {
      flips[(n >> 2) - 1] = f
    },
    /** the vertices so far and an index buffer of two triangles per quad */
    take: (): MeshArrays | null => {
      if (!n) return null
      const quads = n / 4
      const index = n > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6)
      for (let q = 0; q < quads; q++) {
        const a = q * 4
        const o = q * 6
        if (flips[q]) {
          index[o] = a + 1; index[o + 1] = a + 2; index[o + 2] = a + 3
          index[o + 3] = a + 1; index[o + 4] = a + 3; index[o + 5] = a
        } else {
          index[o] = a; index[o + 1] = a + 1; index[o + 2] = a + 2
          index[o + 3] = a; index[o + 4] = a + 2; index[o + 5] = a + 3
        }
      }
      return {
        position: pos.slice(0, n * 3), normal: nor.slice(0, n * 3), tex: tex.slice(0, n * 2),
        color: col.slice(0, n * 3), blk: blk.slice(0, n * 4), index,
      }
    },
  }
}
type Store = ReturnType<typeof makeStore>

const solidStore = makeStore()
const waterStore = makeStore()

/** how much sky the block at region (x, y, z) sees, 0..15 */
const skyAt = (x: number, y: number, z: number) => {
  const c = x + RO + (z + RO) * RW
  const t = tops[c]
  if (y > t) return 15
  // a neighbouring column open to the sky: the light spills in sideways
  const lo = Math.min(t, tops[c - 1], tops[c + 1], tops[c - RW], tops[c + RW])
  if (y > lo) return 12
  // in steps of three blocks, so a cave wall is a few big faces rather
  // than a stripe per block of depth
  return Math.max(2, 11 - Math.floor((lo - y) / 3) * 3)
}

/** flood the block light of every emitter in the region, one level a block
    through anything not opaque */
const floodLight = () => {
  let tail = 0
  for (let i = RW * RW; i < RW * RW * (H + 1); i++) {
    const e = EMIT[vox[i]]
    if (!e) continue
    bl[i] = e
    queue[tail++] = i
  }
  if (!tail) return false
  let head = 0
  while (head < tail) {
    const i = queue[head++]
    const l = bl[i] - 1
    if (l <= 0) continue
    const x = i % RW
    const z = Math.floor(i / RW) % RW
    const y = Math.floor(i / SYs)
    const spread = (j: number) => {
      if (bl[j] >= l || OPAQUE[vox[j]]) return
      bl[j] = l
      queue[tail++] = j
    }
    if (x > 0) spread(i - SX)
    if (x < RW - 1) spread(i + SX)
    if (z > 0) spread(i - SZ)
    if (z < RW - 1) spread(i + SZ)
    if (y > 1) spread(i - SYs)
    if (y < H) spread(i + SYs)
  }
  return true
}

/*
  The six directions: the axis the face looks along (0 x, 1 y, 2 z), its
  sign, and the two axes spanning the face. The texture's u runs to the
  right as the face is looked at from outside and its v runs down the
  painting, so a side face's v is -y
*/
interface Dir {
  d: number
  s: number
  u: number
  v: number
}
const DIRS: Dir[] = [
  { d: 0, s: 1, u: 2, v: 1 },
  { d: 0, s: -1, u: 2, v: 1 },
  { d: 1, s: 1, u: 0, v: 2 },
  { d: 1, s: -1, u: 0, v: 2 },
  { d: 2, s: 1, u: 0, v: 1 },
  { d: 2, s: -1, u: 0, v: 1 },
]
const DIM = [CHUNK, H, CHUNK]
/** a step along x, y and z in the region */
const STRIDE = [SX, SYs, SZ]

const mask = new Int32Array(CHUNK * H)
/** each mask cell's corner shading, beside the key */
const maskAO = new Uint8Array(CHUNK * H)

/**
 * Mesh a chunk. `neighbour(dx, dz)` hands back the chunks round it (dx, dz in
 * -1..1), which must exist: a face on the chunk's rim depends on the block
 * across the seam, its shading on the columns there, and its light on the
 * lamps up to fifteen blocks off. `far` is the far ring's cheap mesh: no
 * corner shading, no cave walls, no plants, no block light.
 */
export const meshChunk = (
  c: ChunkData,
  neighbour: (dx: number, dz: number) => ChunkData,
  far = false,
): { solid: MeshArrays | null; water: MeshArrays | null } => {
  // the region: this chunk and its eight neighbours, bedrock under the
  // floor and air over the roof
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const n = dx === 0 && dz === 0 ? c : neighbour(dx, dz)
      for (let z = 0; z < CHUNK; z++)
        for (let x = 0; x < CHUNK; x++) {
          const px = x + dx * CHUNK
          const pz = z + dz * CHUNK
          tops[px + RO + (pz + RO) * RW] = n.top[x + z * CHUNK]
          let o = ri(px, 0, pz)
          for (let y = 0, s = x + (z << 4); y < H; y++, s += 256, o += SYs) vox[o] = n.vox[s]
        }
    }
  vox.fill(11, 0, RW * RW)
  vox.fill(0, RW * RW * (H + 1))
  if (blUsed) bl.fill(0)
  blUsed = !far && floodLight()

  solidStore.reset()
  waterStore.reset()
  const at = [0, 0, 0]
  const nb = [0, 0, 0]

  for (const dir of DIRS) {
    const { d, s, u, v } = dir
    const du = DIM[u]
    const dv = DIM[v]
    const nrm = [0, 0, 0]
    nrm[d] = s
    for (let i = 0; i < DIM[d]; i++) {
      // build this slice's mask
      let any = false
      for (let b = 0; b < dv; b++)
        for (let a = 0; a < du; a++) {
          at[d] = i
          at[u] = a
          at[v] = b
          const id = vox[ri(at[0], at[1], at[2])]
          const m = a + b * du
          mask[m] = 0
          if (!id || SPECIAL[id]) continue
          nb[0] = at[0]
          nb[1] = at[1]
          nb[2] = at[2]
          nb[d] += s
          const n0 = ri(nb[0], nb[1], nb[2])
          const other = vox[n0]
          const liquid = LIQUID[id]
          if (liquid) {
            if (FAM[other] === FAM[id] || OPAQUE[other]) continue
          } else if (OPAQUE[other] || other === id) continue
          // the face's texture, light and corner shading
          const face = d === 1 ? (s > 0 ? 0 : 2) : 1
          const layer = LAYER[id * 3 + face]
          const light = skyAt(nb[0], nb[1], nb[2])
          const lamp = bl[n0]
          // far off, the inside of a cave is nothing anybody can see
          if (far && light < 9 && !GLOW[id]) continue
          let ao: number
          if (liquid) {
            // a liquid face whose top edge is the surface: lowered
            ao = FAM[vox[ri(at[0], at[1] + 1, at[2])]] === FAM[id] ? 0 : 1
          } else if (far) ao = 0xff
          else {
            ao = 0
            const su = STRIDE[u]
            const sv = STRIDE[v]
            // corners in (u, v) order: (-,-) (+,-) (+,+) (-,+)
            for (let k = 0; k < 4; k++) {
              const cu = k === 1 || k === 2 ? su : -su
              const cv = k >= 2 ? sv : -sv
              const s1 = OPAQUE[vox[n0 + cu]]
              const s2 = OPAQUE[vox[n0 + cv]]
              const cr = OPAQUE[vox[n0 + cu + cv]]
              const o = s1 && s2 ? 0 : 3 - (s1 + s2 + cr)
              ao |= o << (k * 2)
            }
          }
          const tint = TINT[id]
          const bio = tint ? c.biome[at[0] + (at[2] << 4)] : 0
          mask[m] = 1 + (layer | (light << 8) | (tint << 12) | (liquid << 14) | (GLOW[id] << 15) | (bio << 16) |
            (lamp << 21) | ((FAM[id] === 2 ? 1 : 0) << 25))
          maskAO[m] = ao
          any = true
        }
      if (!any) continue
      // merge
      for (let b = 0; b < dv; b++)
        for (let a = 0; a < du; ) {
          const m = a + b * du
          const key = mask[m]
          if (!key) {
            a++
            continue
          }
          const ao = maskAO[m]
          let w = 1
          while (a + w < du && mask[m + w] === key && maskAO[m + w] === ao) w++
          let h = 1
          grow: while (b + h < dv) {
            for (let k = 0; k < w; k++) {
              const mm = m + k + h * du
              if (mask[mm] !== key || maskAO[mm] !== ao) break grow
            }
            h++
          }
          for (let hh = 0; hh < h; hh++) for (let k = 0; k < w; k++) mask[m + k + hh * du] = 0
          emit(dir, nrm, i, a, b, w, h, key - 1, ao)
          a += w
        }
    }
  }

  // what is not a cube, cell by cell
  for (let y = 0; y < H; y++)
    for (let z = 0; z < CHUNK; z++)
      for (let x = 0; x < CHUNK; x++) {
        const i = ri(x, y, z)
        const id = vox[i]
        if (!id) continue
        if (CROSS[id]) {
          if (!far) plant(c, id, x, y, z, i)
        } else if (TORCH[id]) torch(id, x, y, z, i)
        else if (LIQUID[id]) liquid(id, x, y, z, i)
      }
  return { solid: solidStore.take(), water: waterStore.take() }
}

/* ------------------------------------------------------------ faces -- */

const corner = [0, 0, 0]
/** one merged face: its plane, its rectangle in the slice, and its look */
const emit = (dir: Dir, nrm: number[], i: number, a: number, b: number, w: number, h: number, key: number, ao: number) => {
  const { d, s, u, v } = dir
  const layer = key & 0xff
  const sky = (key >> 8) & 0xf
  const light = LIGHT[sky]
  const tint = (key >> 12) & 3
  const liquid = (key >> 14) & 1
  const glow = (key >> 15) & 1
  const bio = (key >> 16) & 31
  const lamp = (key >> 21) & 15
  const lava = (key >> 25) & 1
  const tc = tint === 1 ? GRASS_TINT[bio] : tint === 2 ? FOLIAGE_TINT[bio] : null
  // the grass block's sides keep their dirt: only its top is tinted
  const tr = tc && !(tint === 1 && d !== 1) ? tc : WHITE
  const store = liquid && !lava ? waterStore : solidStore
  const flags = (glow ? F_GLOW : 0) | (liquid ? F_LIQUID : 0)
  const plane = i + (s > 0 ? 1 : 0)
  // a liquid's surface sits an eighth of a block down
  const sink = liquid && d === 1 && s > 0 && ao === 1 ? 0.125 : 0
  const us = [a, a + w, a + w, a]
  const vs = [b, b, b + h, b + h]
  const aos = [0, 0, 0, 0]
  for (let k = 0; k < 4; k++) aos[k] = liquid ? 3 : (ao >> (k * 2)) & 3
  // counter-clockwise seen from outside: the (u, v) order is clockwise for
  // the directions whose u x v points against the normal
  const cross = (u === 2 && v === 1 ? -1 : u === 0 && v === 2 ? -1 : 1) * s
  const order = cross > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1]
  for (const k of order) {
    corner[d] = plane
    corner[u] = us[k]
    corner[v] = vs[k]
    let y = corner[1] - sink
    // a liquid side face's top edge comes down to the surface
    if (liquid && d !== 1 && ao === 1 && k >= 2) y -= 0.125
    const px = corner[0]
    const pz = corner[2]
    // texture: u to the right as the face is seen, v down the painting
    let tu: number
    let tv: number
    if (d === 1) {
      tu = px
      tv = s > 0 ? pz : -pz
    } else {
      // right = up x normal
      tu = d === 0 ? -s * pz : s * px
      tv = -y
    }
    const k2 = light * AO[aos[k]]
    store.vert(px, y, pz, nrm[0], nrm[1], nrm[2], tu, tv, tr[0] * k2, tr[1] * k2, tr[2] * k2, layer, flags, sky, lamp)
  }
  // the diagonal that keeps the shading smooth
  store.flip(aos[order[0]] + aos[order[2]] < aos[order[1]] + aos[order[3]] ? 1 : 0)
}

/** the six faces of a box, as a direction: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z */
const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
/**
 * One face of the box (x0..x1, y0..y1, z0..z1), counter-clockwise from
 * outside. Texture coordinates run from the world position (liquids, which
 * must line up with the greedy faces beside them) unless `uv` gives the
 * rectangle of the painting it shows (u0, v0 at its top left, u1, v1 at its
 * bottom right: a torch's stick)
 */
const boxFace = (
  st: Store, f: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  col: number[], layer: number, flags: number, sky: number, lamp: number, uv?: number[],
) => {
  const [nx, ny, nz] = NORMALS[f]
  let q: number[][]
  switch (f) {
    case 0: q = [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]; break
    case 1: q = [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]; break
    case 2: q = [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]; break
    case 3: q = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]; break
    case 4: q = [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]; break
    default: q = [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]
  }
  // the painting's corners, in the same order as the quad's
  const side = f !== 2 && f !== 3
  for (let k = 0; k < 4; k++) {
    const [px, py, pz] = q[k]
    let tu: number
    let tv: number
    if (uv) {
      if (side) {
        tu = k === 0 || k === 3 ? uv[0] : uv[2]
        tv = k < 2 ? uv[3] : uv[1]
      } else {
        tu = k === 0 || k === 3 ? uv[0] : uv[2]
        tv = (f === 2) === (k < 2) ? uv[3] : uv[1]
      }
    } else if (side) {
      tu = f === 0 ? -pz : f === 1 ? pz : f === 4 ? px : -px
      tv = -py
    } else {
      tu = px
      tv = f === 2 ? pz : -pz
    }
    st.vert(px, py, pz, nx, ny, nz, tu, tv, col[0], col[1], col[2], layer, flags, sky, lamp)
  }
  st.flip(0)
}

/** the plants: two crossed cards, each drawn from both sides */
const plant = (c: ChunkData, id: number, x: number, y: number, z: number, i: number) => {
  const sky = skyAt(x, y, z)
  const light = LIGHT[sky]
  const lamp = bl[i]
  const t = TINT[id] ? GRASS_TINT[c.biome[x + (z << 4)]] : WHITE
  const r = t[0] * light
  const g = t[1] * light
  const bb = t[2] * light
  const layer = LAYER[id * 3 + 1]
  const e = 0.15
  const cards = [
    [x + e, z + e, x + 1 - e, z + 1 - e],
    [x + e, z + 1 - e, x + 1 - e, z + e],
  ]
  for (const [ax, az, bx, bz] of cards) {
    for (const back of [0, 1]) {
      const [x0, z0, x1, z1] = back ? [bx, bz, ax, az] : [ax, az, bx, bz]
      solidStore.vert(x0, y, z0, 0, 1, 0, 0, 0, r, g, bb, layer, 0, sky, lamp)
      solidStore.vert(x1, y, z1, 0, 1, 0, 1, 0, r, g, bb, layer, 0, sky, lamp)
      solidStore.vert(x1, y + 1, z1, 0, 1, 0, 1, -1, r, g, bb, layer, 0, sky, lamp)
      solidStore.vert(x0, y + 1, z0, 0, 1, 0, 0, -1, r, g, bb, layer, 0, sky, lamp)
      solidStore.flip(0)
    }
  }
}

/** a torch: a two-pixel stick ten pixels tall, and its flame on top, lit */
const torch = (id: number, x: number, y: number, z: number, i: number) => {
  const sky = skyAt(x, y, z)
  const l = LIGHT[sky]
  const col = [l, l, l]
  const layer = LAYER[id * 3 + 1]
  const a = 7 / 16
  const b = 9 / 16
  for (let f = 0; f < 6; f++) {
    if (f === 2) continue
    boxFace(solidStore, f, x + a, y, z + a, x + b, y + 10 / 16, z + b, col, layer, 0, sky, bl[i], [a, 6 / 16, b, 1])
  }
  // the flame's sides are its three rows of the painting (the tip's lone
  // pixel leaves a notch); its top is the solid two by two under the tip,
  // or the cap would have a hole in it onto the culled inside
  for (let f = 0; f < 6; f++) {
    if (f === 3) continue
    const uv = f === 2 ? [a, 4 / 16, b, 6 / 16] : [a, 3 / 16, b, 6 / 16]
    boxFace(solidStore, f, x + a, y + 10 / 16, z + a, x + b, y + 13 / 16, z + b, col, layer, F_GLOW, sky, 15, uv)
  }
}

/** how high a liquid block's surface stands in its cell */
const heightAt = (i: number) => {
  const id = vox[i]
  if (FAM[vox[i + SYs]] === FAM[id]) return 1
  const l = LVL[id]
  return l === 0 || l === 8 ? 0.875 : Math.max(0.12, (8 - l) / 9)
}

/** a liquid's faces the greedy pass cannot make: a flowing block's own
    (its surface is lower than its neighbours'), and the step down from any
    liquid block to a lower one of the same liquid beside it */
const liquid = (id: number, x: number, y: number, z: number, i: number) => {
  const fam = FAM[id]
  const lava = fam === 2
  const st = lava ? solidStore : waterStore
  const flowing = SPECIAL[id] === 1
  const h = heightAt(i)
  const flags = F_LIQUID | (flowing ? F_FLOW : 0) | (lava ? F_GLOW : 0)
  const side = LAYER[id * 3 + 1]
  const topL = LAYER[id * 3]
  const HS = [SX, -SX, 0, 0, SZ, -SZ]
  for (const f of [0, 1, 4, 5]) {
    const j = i + HS[f]
    const other = vox[j]
    if (OPAQUE[other]) continue
    let lo = 0
    if (FAM[other] === fam) {
      lo = heightAt(j)
      if (lo >= h - 1e-3) continue
    } else if (!flowing) continue
    const sky = skyAt(x + (f === 0 ? 1 : f === 1 ? -1 : 0), y, z + (f === 4 ? 1 : f === 5 ? -1 : 0))
    const l = LIGHT[sky]
    boxFace(st, f, x, y + lo, z, x + 1, y + h, z + 1, [l, l, l], side, flags, sky, bl[j])
  }
  if (!flowing) return
  const up = vox[i + SYs]
  if (FAM[up] !== fam && !OPAQUE[up]) {
    const sky = skyAt(x, y + 1, z)
    const l = LIGHT[sky]
    boxFace(st, 2, x, y, z, x + 1, y + h, z + 1, [l, l, l], topL, flags, sky, bl[i + SYs])
  }
  const down = vox[i - SYs]
  if (FAM[down] !== fam && !OPAQUE[down]) {
    const sky = skyAt(x, y - 1, z)
    const l = LIGHT[sky]
    boxFace(st, 3, x, y, z, x + 1, y + h, z + 1, [l, l, l], topL, flags, sky, bl[i - SYs])
  }
}
