import { BLOCKS, WATER, textureIndex } from '../../sandbox/blocks'
import { BIOMES, CHUNK, H, type ChunkData } from './gen'

/*
  A chunk of blocks turned into two meshes: everything solid-looking (the
  cubes, the leaves and glass with their see-through pixels, the crossed
  cards of the plants) and the water.

  **Greedy.** Faces are only made where a block meets one that does not hide
  it, and each slice of the chunk merges its faces into the biggest
  rectangles that look the same: the same texture, the same tint, the same
  shading at all four corners and the same light. A flat sunny field is a
  handful of quads rather than a quad a block, and the texture repeats
  across a merged quad because its coordinates are in blocks and the
  material samples an array texture that wraps (material.ts).

  **Shading** is the two things that make a block world read as one:
  ambient occlusion at every vertex (each corner darkened by the blocks
  touching it, the classic three-neighbour rule, with the quad's diagonal
  flipped so the gradient runs the right way) and sky light, which is
  whether the block in front of the face sees the sky (the column's highest
  opaque block is below it), half-sees it (a neighbouring column's is), or
  is under ground, darker the deeper it is, so a cave is dark and a hollow
  under a cliff is dim without any light in the scene. Both are baked into
  the vertex colour with the biome's tint for grass and leaves.

  **The format** is small because the whole visible world is in it:
  positions and texture coordinates are 16-bit integers in eighths of a
  block (the mesh is scaled by B/8), normals are bytes, colour is three
  bytes (at half scale, so a tint can go over one) and the texture layer
  and glow two more, about twenty bytes a vertex.
*/

const P = CHUNK + 2
const PY = H + 2
/** padded copy: the chunk and a one-block rim from its neighbours */
const pad = new Uint8Array(P * P * PY)
const tops = new Int16Array(P * P)
const pi = (x: number, y: number, z: number) => x + 1 + (z + 1) * P + (y + 1) * P * P

/* what each block does to the mesher, flattened for the inner loops */
const OPAQUE = new Uint8Array(256)
const CUBE = new Uint8Array(256)
const CROSS = new Uint8Array(256)
const LIQUID = new Uint8Array(256)
const GLOW = new Uint8Array(256)
const TINT = new Uint8Array(256)
/** texture layer per block and face: [top, side, bottom] */
const LAYER = new Uint8Array(256 * 3)
for (const b of BLOCKS) {
  OPAQUE[b.id] = b.opaque ? 1 : 0
  CROSS[b.id] = b.cross ? 1 : 0
  LIQUID[b.id] = b.liquid ? 1 : 0
  CUBE[b.id] = b.id !== 0 && !b.cross && !b.liquid ? 1 : 0
  GLOW[b.id] = b.glow ? 1 : 0
  TINT[b.id] = b.tint === 'grass' ? 1 : b.tint === 'foliage' ? 2 : 0
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

const AO = [0.5, 0.68, 0.84, 1]
/** sky light 0..15 to a brightness */
const LIGHT = Array.from({ length: 16 }, (_, l) => 0.1 + 0.9 * Math.pow(l / 15, 1.5))

export interface MeshArrays {
  position: Int16Array
  normal: Int8Array
  tex: Int16Array
  color: Uint8Array
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
  let blk = new Uint8Array(cap * 2)
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
    blk = g(blk, 2)
  }
  return {
    reset: () => {
      n = 0
    },
    get count() {
      return n
    },
    vert: (
      x: number, y: number, z: number, nx: number, ny: number, nz: number,
      u: number, v: number, r: number, g: number, b: number, layer: number, glow: number,
    ) => {
      if (n >= cap) grow()
      pos[n * 3] = Math.round(x * 8)
      pos[n * 3 + 1] = Math.round(y * 8)
      pos[n * 3 + 2] = Math.round(z * 8)
      nor[n * 3] = nx * 127
      nor[n * 3 + 1] = ny * 127
      nor[n * 3 + 2] = nz * 127
      tex[n * 2] = Math.round(u * 8)
      tex[n * 2 + 1] = Math.round(v * 8)
      // at half scale: a biome's tint may lift a channel over 1, and the
      // material doubles it back (material.ts)
      col[n * 3] = Math.min(255, Math.round(r * 127.5))
      col[n * 3 + 1] = Math.min(255, Math.round(g * 127.5))
      col[n * 3 + 2] = Math.min(255, Math.round(b * 127.5))
      blk[n * 2] = layer
      blk[n * 2 + 1] = glow
      n++
    },
    /** the vertices so far and an index buffer of two triangles per quad
        (`flips` says which quads take the other diagonal) */
    take: (flips: Uint8Array): MeshArrays | null => {
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
        color: col.slice(0, n * 3), blk: blk.slice(0, n * 2), index,
      }
    },
  }
}

const solidStore = makeStore()
const waterStore = makeStore()
let solidFlips = new Uint8Array(1 << 14)
let waterFlips = new Uint8Array(1 << 12)
let solidQuads = 0
let waterQuads = 0
const flip = (water: boolean, f: number) => {
  if (water) {
    if (waterQuads >= waterFlips.length) {
      const b = new Uint8Array(waterFlips.length * 2)
      b.set(waterFlips)
      waterFlips = b
    }
    waterFlips[waterQuads++] = f
  } else {
    if (solidQuads >= solidFlips.length) {
      const b = new Uint8Array(solidFlips.length * 2)
      b.set(solidFlips)
      solidFlips = b
    }
    solidFlips[solidQuads++] = f
  }
}

/** how bright the air block at padded (x, y, z) is, 0..15 */
const skyAt = (x: number, y: number, z: number) => {
  const t = tops[x + 1 + (z + 1) * P]
  if (y > t) return 15
  // a neighbouring column open to the sky: the light spills in sideways
  let lo = t
  if (x > -1) lo = Math.min(lo, tops[x + (z + 1) * P])
  if (x < CHUNK) lo = Math.min(lo, tops[x + 2 + (z + 1) * P])
  if (z > -1) lo = Math.min(lo, tops[x + 1 + z * P])
  if (z < CHUNK) lo = Math.min(lo, tops[x + 1 + (z + 2) * P])
  if (y > lo) return 12
  // in steps of three blocks, so a cave wall is a few big faces rather
  // than a stripe per block of depth
  const depth = Math.min(t, lo) - y
  return Math.max(2, 11 - Math.floor(depth / 3) * 3)
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
/** a step along x, y and z in the padded copy */
const STRIDE = [1, P * P, P]

const mask = new Int32Array(CHUNK * H)
/** each mask cell's corner shading and light, beside the key */
const maskAO = new Uint8Array(CHUNK * H)
const maskBio = new Uint8Array(CHUNK * H)

/**
 * Mesh a chunk. `neighbour(dx, dz)` hands back the chunks round it (dx, dz in
 * -1..1), which must exist: a face on the chunk's rim depends on the block
 * across the seam, and its shading on the columns there.
 */
export const meshChunk = (
  c: ChunkData,
  neighbour: (dx: number, dz: number) => ChunkData,
  far = false,
): { solid: MeshArrays | null; water: MeshArrays | null } => {
  // the padded copy
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const n = dx === 0 && dz === 0 ? c : neighbour(dx, dz)
      const xa = dx < 0 ? CHUNK - 1 : 0
      const xb = dx > 0 ? 0 : CHUNK - 1
      const za = dz < 0 ? CHUNK - 1 : 0
      const zb = dz > 0 ? 0 : CHUNK - 1
      for (let z = za; z <= zb; z++)
        for (let x = xa; x <= xb; x++) {
          const px = x + dx * CHUNK
          const pz = z + dz * CHUNK
          tops[px + 1 + (pz + 1) * P] = n.top[x + z * CHUNK]
          for (let y = 0; y < H; y++) pad[pi(px, y, pz)] = n.vox[x + (z << 4) + (y << 8)]
        }
    }
  // bedrock below the floor, air above the roof
  for (let z = -1; z <= CHUNK; z++)
    for (let x = -1; x <= CHUNK; x++) {
      pad[pi(x, -1, z)] = 11
      pad[pi(x, H, z)] = 0
    }

  solidStore.reset()
  waterStore.reset()
  solidQuads = 0
  waterQuads = 0
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
          const id = pad[pi(at[0], at[1], at[2])]
          const m = a + b * du
          mask[m] = 0
          if (!id || CROSS[id]) continue
          nb[0] = at[0]
          nb[1] = at[1]
          nb[2] = at[2]
          nb[d] += s
          const other = pad[pi(nb[0], nb[1], nb[2])]
          const liquid = LIQUID[id]
          if (liquid) {
            if (other === id || OPAQUE[other]) continue
          } else if (OPAQUE[other] || other === id) continue
          // the face's texture, light and corner shading
          const face = d === 1 ? (s > 0 ? 0 : 2) : 1
          const layer = LAYER[id * 3 + face]
          const light = skyAt(nb[0], nb[1], nb[2])
          // far off, the inside of a cave is nothing anybody can see
          if (far && light < 9) continue
          let ao: number
          if (far && !liquid) ao = 0xff
          else if (!liquid) {
            ao = 0
            const n0 = pi(nb[0], nb[1], nb[2])
            const su = STRIDE[u]
            const sv = STRIDE[v]
            // corners in (u, v) order: (-,-) (+,-) (+,+) (-,+)
            for (let k = 0; k < 4; k++) {
              const cu = k === 1 || k === 2 ? su : -su
              const cv = k >= 2 ? sv : -sv
              const s1 = OPAQUE[pad[n0 + cu]]
              const s2 = OPAQUE[pad[n0 + cv]]
              const cr = OPAQUE[pad[n0 + cu + cv]]
              const o = s1 && s2 ? 0 : 3 - (s1 + s2 + cr)
              ao |= o << (k * 2)
            }
          } else {
            // a water face whose top edge is the surface: lowered
            const up = pad[pi(at[0], at[1] + 1, at[2])]
            ao = up === WATER ? 0 : 1
          }
          const tint = TINT[id]
          const bio = tint ? c.biome[(d === 0 ? i : at[0]) + ((d === 2 ? i : at[2]) << 4)] : 0
          mask[m] = 1 + (layer | (light << 8) | (tint << 12) | (liquid << 14) | (GLOW[id] << 15) | (bio << 16))
          maskAO[m] = ao
          maskBio[m] = bio
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
          emit(dir, nrm, i, a, b, w, h, key - 1, ao, maskBio[m])
          a += w
        }
    }
  }

  // the plants: two crossed cards, each drawn from both sides (not far off,
  // where a meadow of them is a few pixels of noise)
  if (!far) for (let y = 0; y < H; y++)
    for (let z = 0; z < CHUNK; z++)
      for (let x = 0; x < CHUNK; x++) {
        const id = pad[pi(x, y, z)]
        if (!CROSS[id]) continue
        const light = LIGHT[skyAt(x, y, z)]
        const t = TINT[id] ? GRASS_TINT[c.biome[x + (z << 4)]] : [1, 1, 1]
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
          for (const side of [0, 1]) {
            const [x0, z0, x1, z1] = side ? [bx, bz, ax, az] : [ax, az, bx, bz]
            solidStore.vert(x0, y, z0, 0, 1, 0, 0, 0, r, g, bb, layer, 0)
            solidStore.vert(x1, y, z1, 0, 1, 0, 1, 0, r, g, bb, layer, 0)
            solidStore.vert(x1, y + 1, z1, 0, 1, 0, 1, -1, r, g, bb, layer, 0)
            solidStore.vert(x0, y + 1, z0, 0, 1, 0, 0, -1, r, g, bb, layer, 0)
            flip(false, 0)
          }
        }
      }
  return { solid: solidStore.take(solidFlips), water: waterStore.take(waterFlips) }
}

const corner = [0, 0, 0]
/** one merged face: its plane, its rectangle in the slice, and its look */
const emit = (dir: Dir, nrm: number[], i: number, a: number, b: number, w: number, h: number, key: number, ao: number, bio: number) => {
  const { d, s, u, v } = dir
  const layer = key & 0xff
  const light = LIGHT[(key >> 8) & 0xf]
  const tint = (key >> 12) & 3
  const liquid = (key >> 14) & 1
  const glow = (key >> 15) & 1
  const tc = tint === 1 ? GRASS_TINT[bio] : tint === 2 ? FOLIAGE_TINT[bio] : null
  // the grass block's sides keep their dirt: only its top is tinted
  const tr = tc && !(tint === 1 && d !== 1) ? tc : [1, 1, 1]
  const store = liquid ? waterStore : solidStore
  const plane = i + (s > 0 ? 1 : 0)
  // the water's surface sits an eighth of a block down
  const sink = liquid ? (d === 1 && s > 0 ? 0.125 : 0) : 0
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
    // a water side face's top edge comes down to the surface
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
    store.vert(px, y, pz, nrm[0], nrm[1], nrm[2], tu, tv, tr[0] * k2, tr[1] * k2, tr[2] * k2, layer, glow)
  }
  // the diagonal that keeps the shading smooth
  const a0 = aos[order[0]]
  const a1 = aos[order[1]]
  const a2 = aos[order[2]]
  const a3 = aos[order[3]]
  flip(!!liquid, a0 + a2 < a1 + a3 ? 1 : 0)
}
