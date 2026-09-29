import * as THREE from 'three'
import { AIR, B, BEDROCK, BLOCKS } from '../../sandbox/blocks'
import type { Solid } from '../../physics/collision'
import type { VoxelGrid } from '../../physics/voxelSweep'
import type { PhysicsWorld, RCollider } from '../../sandbox/physics'
import { GROUPS } from '../../sandbox/physics'
import { CHUNK, H, generateChunk, idx, scanTop, type ChunkData } from './gen'

/*
  The blocks as data: which chunks exist, what has been changed in them, and
  the two shapes collision is made of.

  **Edits are the truth, chunks are a cache.** A chunk's blocks are
  gen.ts's pure function of its coordinates plus whatever has been broken or
  placed in it, and the edits are kept apart (a map per chunk of index to
  block) so a chunk dropped from memory far away is rebuilt exactly as it was
  left. The edits are also what travels between players.

  **The walker's boxes** (`boxesOf`) are the chunk's solid blocks merged into
  as few axis-aligned boxes as they fill, columns first, then rows, then
  slabs, grown a shoulder's width sideways like every other solid (the walk
  is a point), and flagged `walkOnly`: the sandbox's props meet the blocks
  through the voxel colliders instead, flush and without the shoulder. A
  column only stops where its blocks do, so every box's top is open air and
  every one is a floor. The same blocks are also handed to the walk as a
  grid (`walkGrid`), which it sweeps through before it asks the boxes
  anything, because a box push-out lets a fast enough tick through a hill
  (physics/voxelSweep.ts).

  **The props' colliders** are Rapier's own voxel shape, one per chunk, made
  when the sandbox's ground ring reaches the chunk and dropped when it
  leaves (`attachPhysics`). Only the blocks with an open face go in (a prop
  can never reach the inside of a hill), and `set` keeps each collider
  honest: a block taken out is taken out of its collider, and the blocks it
  was hiding are put in.
*/

export const CHUNK_W = CHUNK * B

export const chunkKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768)

const SOLID = new Uint8Array(256)
for (const b of BLOCKS) SOLID[b.id] = b.solid ? 1 : 0
export const isSolid = (id: number) => SOLID[id] === 1

export interface BlockEdit {
  x: number
  y: number
  z: number
  id: number
  was: number
}

export interface VoxelStore {
  /** world units of block (0, 0, 0)'s corner */
  readonly ox: number
  readonly oz: number
  /** chunks either side of the middle the world reaches */
  readonly radius: number
  inWorld: (cx: number, cz: number) => boolean
  /** a chunk's blocks, generated (and edited) now if need be */
  chunk: (cx: number, cz: number) => ChunkData
  peek: (cx: number, cz: number) => ChunkData | undefined
  /** forget a chunk's blocks (its edits are kept) */
  drop: (cx: number, cz: number) => void
  get: (bx: number, by: number, bz: number) => number
  /** change a block; returns what was there, or -1 when nothing changed */
  set: (bx: number, by: number, bz: number, id: number) => number
  onSet: (fn: (e: BlockEdit) => void) => () => void
  /** drop the stored edit at a block (it is generated terrain again once the
      caller has put the generated block back with `set`): a refused edit
      must not linger in the catch-up list */
  forget: (bx: number, by: number, bz: number) => void
  /** every edit, per chunk (index to block) */
  readonly edits: ReadonlyMap<number, ReadonlyMap<number, number>>
  /** the walker's boxes for a chunk, merged and padded (cached until it changes) */
  boxesOf: (cx: number, cz: number) => Solid[]
  /** the Rapier side: voxel colliders for the chunks under a world rectangle */
  attachPhysics: (pw: PhysicsWorld, x0: number, z0: number, x1: number, z1: number) => () => void
  /** is this collider one of the blocks' */
  ownsCollider: (c: RCollider) => boolean
  readonly loaded: number
}

/** the walker's shoulder: how far a box stands proud of the block */
const PAD = 0.42

/** the blocks as the walk's sweep reads them: the same solids as the boxes
    (a cell grown by the shoulder is a padded box), outside the world open
    air so a sweep never generates a chunk nobody will see, and below it
    bedrock */
export const walkGrid = (store: VoxelStore): VoxelGrid => ({
  size: B,
  ox: store.ox,
  oz: store.oz,
  half: PAD,
  solid: (bx, by, bz) =>
    by < 0 || (by < H && store.inWorld(Math.floor(bx / CHUNK), Math.floor(bz / CHUNK)) && SOLID[store.get(bx, by, bz)] === 1),
})

export const createVoxelStore = (o: { ox: number; oz: number; radius: number }): VoxelStore => {
  const chunks = new Map<number, ChunkData>()
  const edits = new Map<number, Map<number, number>>()
  const boxes = new Map<number, Solid[]>()
  const fns = new Set<(e: BlockEdit) => void>()
  const inWorld = (cx: number, cz: number) => Math.abs(cx + 0.5) < o.radius && Math.abs(cz + 0.5) < o.radius

  const chunk = (cx: number, cz: number) => {
    const k = chunkKey(cx, cz)
    let c = chunks.get(k)
    if (c) return c
    c = generateChunk(cx, cz)
    if (!inWorld(cx, cz)) c.vox.fill(0, CHUNK * CHUNK)
    const e = edits.get(k)
    if (e) {
      for (const [i, id] of e) c.vox[i] = id
      for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) c.top[x + z * CHUNK] = scanTop(c.vox, x, z)
    }
    chunks.set(k, c)
    return c
  }

  const get = (bx: number, by: number, bz: number) => {
    if (by < 0) return BEDROCK
    if (by >= H) return AIR
    const cx = Math.floor(bx / CHUNK)
    const cz = Math.floor(bz / CHUNK)
    return chunk(cx, cz).vox[idx(bx - cx * CHUNK, by, bz - cz * CHUNK)]
  }

  /* ---------------------------------------------------------- physics -- */

  interface Phys {
    col: RCollider
    refs: number
    cx: number
    cz: number
  }
  const phys = new Map<number, Phys>()
  const physHandles = new Set<number>()
  let physWorld: PhysicsWorld | null = null

  const open = (c: ChunkData, x: number, y: number, z: number) => {
    // a rim block is always put in: the next chunk's side of the seam may
    // be hollow, and it costs a few hundred voxels a chunk
    if (x === 0 || z === 0 || x === CHUNK - 1 || z === CHUNK - 1 || y === 0 || y === H - 1) return true
    const v = c.vox
    const i = idx(x, y, z)
    return !SOLID[v[i + 1]] || !SOLID[v[i - 1]] || !SOLID[v[i + 16]] || !SOLID[v[i - 16]] || !SOLID[v[i + 256]] || !SOLID[v[i - 256]]
  }

  const buildCollider = (pw: PhysicsWorld, cx: number, cz: number) => {
    const c = chunk(cx, cz)
    const coords: number[] = []
    for (let y = 0; y < H; y++)
      for (let z = 0; z < CHUNK; z++)
        for (let x = 0; x < CHUNK; x++) if (SOLID[c.vox[idx(x, y, z)]] && open(c, x, y, z)) coords.push(x, y, z)
    // never an empty shape (Rapier throws on one): a chunk of open air
    // keeps one voxel under the world
    if (!coords.length) coords.push(0, 0, 0)
    const desc = pw.R.ColliderDesc.voxels(new Int32Array(coords), { x: B, y: B, z: B })
      .setTranslation(o.ox + cx * CHUNK_W, 0, o.oz + cz * CHUNK_W)
      .setCollisionGroups(GROUPS.world)
      .setFriction(1.2)
      .setRestitution(0.05)
    const col = pw.world.createCollider(desc)
    physHandles.add(col.handle)
    return col
  }

  const attachPhysics = (pw: PhysicsWorld, x0: number, z0: number, x1: number, z1: number) => {
    physWorld = pw
    const cx0 = Math.floor((x0 - o.ox) / CHUNK_W)
    const cx1 = Math.floor((x1 - 1e-6 - o.ox) / CHUNK_W)
    const cz0 = Math.floor((z0 - o.oz) / CHUNK_W)
    const cz1 = Math.floor((z1 - 1e-6 - o.oz) / CHUNK_W)
    const held: number[] = []
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        if (!inWorld(cx, cz)) continue
        const k = chunkKey(cx, cz)
        let p = phys.get(k)
        if (!p) {
          p = { col: buildCollider(pw, cx, cz), refs: 0, cx, cz }
          phys.set(k, p)
        }
        p.refs++
        held.push(k)
      }
    return () => {
      for (const k of held) {
        const p = phys.get(k)
        if (!p || --p.refs > 0) continue
        physHandles.delete(p.col.handle)
        if (pw.world.getCollider(p.col.handle)) pw.world.removeCollider(p.col, false)
        phys.delete(k)
      }
    }
  }

  /** mirror one block's change into its chunk's collider */
  const physSet = (cx: number, cz: number, x: number, y: number, z: number) => {
    const p = phys.get(chunkKey(cx, cz))
    if (!p || !physWorld) return
    const c = chunk(cx, cz)
    const fill = (xx: number, yy: number, zz: number) => {
      if (xx < 0 || zz < 0 || xx >= CHUNK || zz >= CHUNK || yy < 0 || yy >= H) return
      const solid = SOLID[c.vox[idx(xx, yy, zz)]] === 1
      p.col.setVoxel(xx, yy, zz, solid && open(c, xx, yy, zz))
    }
    fill(x, y, z)
    fill(x + 1, y, z)
    fill(x - 1, y, z)
    fill(x, y + 1, z)
    fill(x, y - 1, z)
    fill(x, y, z + 1)
    fill(x, y, z - 1)
  }

  /* ------------------------------------------------------------ boxes -- */

  const seen = new Uint8Array(CHUNK * CHUNK * H)
  const boxesOf = (cx: number, cz: number): Solid[] => {
    const k = chunkKey(cx, cz)
    const have = boxes.get(k)
    if (have) return have
    const c = chunk(cx, cz)
    const v = c.vox
    seen.fill(0)
    const out: Solid[] = []
    const wx = o.ox + cx * CHUNK_W
    const wz = o.oz + cz * CHUNK_W
    const ok = (x: number, y: number, z: number) => {
      const i = idx(x, y, z)
      return SOLID[v[i]] === 1 && !seen[i]
    }
    for (let z = 0; z < CHUNK; z++)
      for (let x = 0; x < CHUNK; x++)
        for (let y = 0; y < H; y++) {
          if (!ok(x, y, z)) continue
          // up the column, then along x, then along z
          let y1 = y + 1
          while (y1 < H && ok(x, y1, z)) y1++
          let x1 = x + 1
          grow: while (x1 < CHUNK) {
            for (let yy = y; yy < y1; yy++) if (!ok(x1, yy, z)) break grow
            x1++
          }
          let z1 = z + 1
          grow2: while (z1 < CHUNK) {
            for (let xx = x; xx < x1; xx++) for (let yy = y; yy < y1; yy++) if (!ok(xx, yy, z1)) break grow2
            z1++
          }
          for (let zz = z; zz < z1; zz++) for (let xx = x; xx < x1; xx++) for (let yy = y; yy < y1; yy++) seen[idx(xx, yy, zz)] = 1
          const b = new THREE.Box3(
            new THREE.Vector3(wx + x * B - PAD, y * B, wz + z * B - PAD),
            new THREE.Vector3(wx + x1 * B + PAD, y1 * B, wz + z1 * B + PAD),
          ) as Solid
          b.walkOnly = true
          // every box's top is open air (a column only stops where the
          // blocks do), so every one is a floor
          out.push(b)
          y = y1 - 1
        }
    boxes.set(k, out)
    return out
  }

  const set = (bx: number, by: number, bz: number, id: number) => {
    if (by < 0 || by >= H) return -1
    const cx = Math.floor(bx / CHUNK)
    const cz = Math.floor(bz / CHUNK)
    if (!inWorld(cx, cz)) return -1
    const c = chunk(cx, cz)
    const x = bx - cx * CHUNK
    const z = bz - cz * CHUNK
    const i = idx(x, by, z)
    const was = c.vox[i]
    if (was === id) return -1
    c.vox[i] = id
    c.top[x + z * CHUNK] = scanTop(c.vox, x, z)
    const k = chunkKey(cx, cz)
    let e = edits.get(k)
    if (!e) edits.set(k, (e = new Map()))
    e.set(i, id)
    boxes.delete(k)
    physSet(cx, cz, x, by, z)
    // a block on a rim changes what is open across the seam
    if (x === 0) physSet(cx - 1, cz, CHUNK - 1, by, z)
    if (x === CHUNK - 1) physSet(cx + 1, cz, 0, by, z)
    if (z === 0) physSet(cx, cz - 1, x, by, CHUNK - 1)
    if (z === CHUNK - 1) physSet(cx, cz + 1, x, by, 0)
    const ev = { x: bx, y: by, z: bz, id, was }
    for (const fn of fns) fn(ev)
    return was
  }

  return {
    ox: o.ox,
    oz: o.oz,
    radius: o.radius,
    inWorld,
    chunk,
    peek: (cx, cz) => chunks.get(chunkKey(cx, cz)),
    drop: (cx, cz) => {
      const k = chunkKey(cx, cz)
      if (phys.has(k)) return
      chunks.delete(k)
      boxes.delete(k)
    },
    get,
    set,
    onSet: (fn) => {
      fns.add(fn)
      return () => fns.delete(fn)
    },
    forget: (bx, by, bz) => {
      const cx = Math.floor(bx / CHUNK)
      const cz = Math.floor(bz / CHUNK)
      const k = chunkKey(cx, cz)
      const e = edits.get(k)
      if (!e) return
      e.delete(idx(bx - cx * CHUNK, by, bz - cz * CHUNK))
      if (!e.size) edits.delete(k)
    },
    edits,
    boxesOf,
    attachPhysics,
    ownsCollider: (c) => physHandles.has(c.handle),
    get loaded() {
      return chunks.size
    },
  }
}
