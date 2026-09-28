import { BLOCKS, B, GRASS, MYCELIUM, PODZOL, RED_SAND, SAND, SANDSTONE, SNOW, SNOWY_GRASS, ICE, PACKED_ICE } from '../../sandbox/blocks'
import type { CreatureWorld, Footing, FootingOpts, Ground, LightAt } from '../../creatures/world'
import { CHUNK, H } from './gen'
import type { VoxelStore } from './world'

/*
  Cubeland's answer to "what is the ground, for a creature".

  Everything is read straight off the block store, so a creature on a hill
  three chunks from anyone asks about blocks the mesher may never have
  drawn, and a block somebody just broke or placed changes the answer at
  once. Nothing is cached: a column is a few reads and the simulation asks
  a few hundred a second.

  **Footing** is the block model's whole story. A body stands on the highest
  solid block it can reach: no higher than `up` above its soles (a wall
  taller than that is a wall), no lower than `down` below them (a cliff is a
  cliff), with the air above it free for its height and no liquid in it, since
  the animals here do not swim. The body's width is honoured by asking the
  four corners as well as the middle for anything solid inside its volume, so
  a pig does not stand with its shoulder in a wall.

  **Light** is the two numbers the mesher itself shades with: whether the
  block sees the sky (the chunk's `top`, the highest block that shuts it out,
  is below it) and the block light of torches, lanterns, glowstone and lava,
  which fall off by a level per block. The hour is applied by the caller.
  So a cave is dark at noon, a hillside is dark at night, and a torch you
  place keeps the dark from breeding things next to it.
*/

const isSolid = new Uint8Array(256)
const isLiquid = new Uint8Array(256)
const isLeaf = new Uint8Array(256)
const emit = new Uint8Array(256)
for (const b of BLOCKS) {
  isSolid[b.id] = b.solid ? 1 : 0
  isLiquid[b.id] = b.liquid ? 1 : 0
  isLeaf[b.id] = b.tint === 'foliage' && !b.opaque ? 1 : 0
  emit[b.id] = b.light ?? 0
}

const groundOf = (id: number): Ground => {
  if (id === GRASS || id === PODZOL || id === MYCELIUM) return 'grass'
  if (id === SAND || id === RED_SAND || id === SANDSTONE) return 'sand'
  if (id === SNOW || id === SNOWY_GRASS || id === ICE || id === PACKED_ICE) return 'snow'
  return 'stone'
}

export interface CubelandCreatureOpts {
  store: VoxelStore
  /** the map's origin in the scene (world units of block 0, 0) */
  ox: number
  oz: number
}

export const cubelandCreatures = ({ store, ox, oz }: CubelandCreatureOpts): CreatureWorld => {
  const get = (bx: number, by: number, bz: number) => (by < 0 ? 1 : by >= H ? 0 : store.get(bx, by, bz))
  const solid = (bx: number, by: number, bz: number) => isSolid[get(bx, by, bz)] === 1
  const toB = (v: number, o: number) => Math.floor((v - o) / B)

  /** is anything solid inside the body's volume at these columns */
  const roomFor = (bx: number, bz: number, y0: number, h: number, r: number, x: number, z: number, up: number) => {
    const yb0 = Math.floor((y0 + 0.05) / B)
    const yb1 = Math.floor((y0 + h - 0.05) / B)
    const s = Math.min(r * 0.85, B / 2 - 0.01)
    for (let yb = yb0; yb <= yb1; yb++) {
      if (isSolid[get(bx, yb, bz)]) return false
      if (yb === yb0 && isLiquid[get(bx, yb, bz)]) return false
    }
    // the corners: only worth asking when the body straddles a block edge, and
    // not for a ledge it could step onto (or it could never walk up to one:
    // its shoulder would be in the step before its middle was)
    const skip = Math.floor((up + 0.05) / B)
    for (const [dx, dz] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
      const cx = toB(x + dx, ox)
      const cz = toB(z + dz, oz)
      if (cx === bx && cz === bz) continue
      for (let yb = yb0 + skip; yb <= yb1; yb++) if (isSolid[get(cx, yb, cz)]) return false
    }
    return true
  }

  const footing: CreatureWorld['footing'] = (x, z, fromY, o: FootingOpts) => {
    const bx = toB(x, ox)
    const bz = toB(z, oz)
    if (!store.inWorld(Math.floor(bx / CHUNK), Math.floor(bz / CHUNK))) return null
    const top = fromY + o.up
    let yb = Math.floor((top + 1e-4) / B)
    if (yb >= H) yb = H - 1
    // a solid block whose top is beyond reach is a wall
    if (isSolid[get(bx, yb, bz)] && (yb + 1) * B > top + 1e-4) return null
    const low = Math.max(0, Math.floor((fromY - o.down - 1e-4) / B))
    while (yb >= low && !isSolid[get(bx, yb, bz)]) yb--
    if (yb < low) return null
    const y = (yb + 1) * B
    if (y > top + 1e-4 || y < fromY - o.down - 1e-4) return null
    if (isLiquid[get(bx, yb + 1, bz)] || isLiquid[get(bx, yb, bz)]) return null
    if (!roomFor(bx, bz, y, o.h, o.r, x, z, o.up)) return null
    return { y, ground: groundOf(get(bx, yb, bz)) } satisfies Footing
  }

  const spots: CreatureWorld['spots'] = (x, z, out, h) => {
    out.length = 0
    const bx = toB(x, ox)
    const bz = toB(z, oz)
    if (!store.inWorld(Math.floor(bx / CHUNK), Math.floor(bz / CHUNK))) return 0
    const need = Math.max(1, Math.ceil(h / B))
    let run = 0
    // scan from the top down: `run` counts the free blocks above the one we stand on
    for (let yb = H - 1; yb >= 1; yb--) {
      const id = get(bx, yb, bz)
      if (isSolid[id]) {
        if (run >= need && !isLeaf[id] && !isLiquid[get(bx, yb + 1, bz)]) {
          out.push((yb + 1) * B)
          if (out.length >= 8) break
        }
        run = 0
      } else if (isLiquid[id]) run = 0
      else run++
    }
    return out.length
  }

  const light: CreatureWorld['light'] = (x, y, z, out: LightAt) => {
    const bx = toB(x, ox)
    const bz = toB(z, oz)
    const by = Math.floor(y / B)
    const cx = Math.floor(bx / CHUNK)
    const cz = Math.floor(bz / CHUNK)
    const c = store.chunk(cx, cz)
    out.sky = by > c.top[(bx - cx * CHUNK) + (bz - cz * CHUNK) * CHUNK] ? 1 : 0
    let best = 0
    // torches, lanterns, glowstone and lava within reach: a level a block
    const R = 6
    for (let dy = -R; dy <= R; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
          if (d > R + 2) continue
          const e = emit[get(bx + dx, by + dy, bz + dz)]
          if (e - d > best) best = e - d
        }
      }
    }
    out.block = best / 15
    return out
  }

  const exposed: NonNullable<CreatureWorld['exposed']> = (x, y, z) => {
    const bx = toB(x, ox)
    const bz = toB(z, oz)
    const cx = Math.floor(bx / CHUNK)
    const cz = Math.floor(bz / CHUNK)
    const c = store.chunk(cx, cz)
    return Math.floor(y / B) > c.top[(bx - cx * CHUNK) + (bz - cz * CHUNK) * CHUNK]
  }

  const clearLine: NonNullable<CreatureWorld['clearLine']> = (x0, y0, z0, x1, y1, z1) => {
    const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
    const n = Math.max(1, Math.ceil(d / 1.0))
    for (let i = 1; i < n; i++) {
      const t = i / n
      if (solid(toB(x0 + (x1 - x0) * t, ox), Math.floor((y0 + (y1 - y0) * t) / B), toB(z0 + (z1 - z0) * t, oz))) return false
    }
    return true
  }

  return {
    fauna: ['pig', 'cow', 'sheep', 'chicken', 'zombie', 'creeper', 'skeleton'],
    drops: true,
    footing,
    spots,
    light,
    exposed,
    clearLine,
  }
}
