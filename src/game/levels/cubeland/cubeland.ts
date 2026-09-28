import * as THREE from 'three'
import {
  AIR, B, BLOCKS, BLOCK_BY_KEY, COBBLE, GRAVEL, LAVA_FLOW, OBSIDIAN, SAND, STONE, TNT, WATER, WATER_FLOW,
  blockKind, blockOfKind, paintTexture, type BlockDef,
} from '../../sandbox/blocks'
import { KINDS } from '../../sandbox/kinds'
import { blastThrow } from '../../sandbox/explosion'
import { breakSound, impactSound } from '../../sandbox/impactSounds'
import type { Prop, Sandbox } from '../../sandbox/sandbox'
import { invalidateCollisionBoxes, makeCollisionSet, type Solid } from '../../physics/collision'
import type { StepSurface } from '../../core/sfx'
import { gfx } from '../../world/quality'
import type { HandsHud, Level, LevelLightRig, LevelSpawn } from '../types'
import { Biome, CHUNK, H, SEA, columnAt } from './gen'
import { meshChunk, type MeshArrays } from './mesher'
import { daylight, fadeClock, terrainMaterials } from './material'
import { createHeldItem } from './held'
import { PREBORN } from '../../world/fade'
import { CHUNK_W, chunkKey, createVoxelStore, isSolid, walkGrid, type VoxelStore } from './world'

/*
  Cubeland: a world of blocks, generated the way the famous one is and
  built for this sandbox, so you can dig it, build on it, and blow it up
  and pick the pieces up with the physgun.

  It is a map (levels/maps.ts), loaded under the level cut's card the first
  time somebody picks it, far off in the scene past everybody's far plane
  (CUBE_ORIGIN) with the Earth's ground put away. The world itself is
  cubeland/gen.ts (a pure function of the block coordinates), stored and
  edited by cubeland/world.ts, meshed by cubeland/mesher.ts and drawn with
  cubeland/material.ts; this module is the level: streaming, the hands, the
  blasts, the network's handle on the edits and what the scene reads.

  - **Streaming.** Chunks are meshed nearest first inside the tier's view
    distance (quality.ts's `cubeView`, up to the sky dome) under a few
    milliseconds a frame, and each one dissolves in over a second through
    the open world's own dither (world/fade.ts) rather than appearing. Only
    the near ring is meshed in full; past it a chunk is a far mesh with no
    corner shading, no cave walls and no plants, a ninth of the quads, and
    it is swapped for the full one as you come close. A chunk somebody just
    changed is rebuilt before anything else, the same frame, so a block
    breaks under the cursor rather than a beat later.
  - **Scale.** A block is two units (sandbox/blocks.ts's B), so the eye
    (3.84) is just under two blocks up and a two-high tunnel is walked
    through stooping by nothing. A hop has to clear one block with time to
    spare, so the jump here is a little stronger (`jump`), and a block
    overhead stops a hop (`ceilingAt`) rather than pushing the body out
    through the wall.
  - **Hands.** With slot 0 out, the block under the crosshair is outlined;
    left click breaks it (a thud and chips in its own colours), right click
    places the block in hand against the face you are looking at, and the
    wheel steps along the hotbar. Picking a block in the catalogue puts it
    in hand. Hold either button to keep going, as there. What is in hand is
    drawn in the lower right, bobbing with the step and swinging on every
    use, in the famous game's own pose (cubeland/held.ts).
  - **Blasts.** Any explosion in the sandbox (a rocket, a barrel, a lit TNT
    block) takes out a ball of blocks, softer ones further, bedrock and
    obsidian never, and throws a couple of dozen of them as real props, the
    catalogue's own block kinds, on the sandbox's budget for rubble: they
    tumble, stack and can be picked up. TNT caught in a blast is lit and
    thrown, so a stack of it goes off in a chain.
  - **The day** is twenty minutes, the real one's to the tick (`skyOf`):
    ten of daylight, a minute and a half of sunset, seven of night, a minute
    and a half of dawn, off the wall clock so every player shares it.
  - **Liquids flow** (see "liquids" below): water runs seven blocks and
    lava three, both pour down first and head for the nearest drop, two
    water sources make a third, and where they meet lava sets to obsidian
    or cobblestone. Buckets of either are in the catalogue. Lava lakes lie
    in the deepest caves, and lava burns up any prop that falls in.
  - **Light.** Torches, lanterns, glowstone, jack o'lanterns and lava give
    block light, flooded out by the mesher and added by the material as
    warm light that shows most at night and underground.
  - **Loose blocks.** The physgun tears a block out of the ground as a prop
    (the level's `grab`), sand and gravel with nothing under them fall as
    props and set back into the grid where they land, and flowers and tall
    grass go with the block they stood on.

  Headless-safe: nothing here touches a renderer, and with no sandbox the
  hands still dig.
*/

/** where the map stands in the scene */
export const CUBE_ORIGIN = { x: 0, z: -40000 } as const
/** chunks either side of the middle: 96 chunks, 1536 blocks across */
const WORLD_R = 48

const REACH = 10.5
const REPEAT = 0.2
/** blocks one blast may throw as props */
const DEBRIS_PER_BLAST = 26
const HOTBAR = ['grass', 'dirt', 'stone', 'cobblestone', 'planks', 'log', 'glass', 'torch', 'tnt']

export interface CubelandOpts {
  parent: THREE.Object3D
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
  venue: (v: 'earth' | 'away') => void
  homeUpdate: (dt: number, p: THREE.Vector3) => void
}

/** one block changed, as the wire carries it: block coordinates and the new id */
export type WireEdit = [number, number, number, number]

/** the network's handle on the blocks (see net/remoteBlocks.ts) */
export interface BlockNet {
  /** every edit made here (not the ones `apply` brought in), batched a frame */
  onLocal: (fn: (edits: WireEdit[], blast: boolean) => void) => () => void
  /** somebody else's edits; `blast` throws some of what they took out */
  apply: (edits: readonly WireEdit[], blast: boolean) => void
  /** every edit this session knows about, for a late arrival's catch-up */
  all: () => WireEdit[]
}

export interface Cubeland {
  root: THREE.Group
  level: Level
  store: VoxelStore
  net: BlockNet
  /** a block's id by its key (the harness counts blocks with it) */
  blockId: (key: string) => number
}

interface Drawn {
  solid: THREE.Mesh | null
  water: THREE.Mesh | null
  dirty: boolean
  /** meshed as the far ring is: no corner shading, no caves, no plants */
  far: boolean
}

/** chunks round the walker meshed in full; past this, the far ring's cheap
    mesh (a ninth of the quads), and back to full a chunk inside it */
const NEAR = 4.5
const FAR_AT = 6

/** a texture's average colour, linear, for the chips a broken block throws */
const chipColour = new Map<string, [number, number, number]>()
const colourOf = (tex: string) => {
  let c = chipColour.get(tex)
  if (c) return c
  const d = paintTexture(tex)
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue
    r += d[i]
    g += d[i + 1]
    b += d[i + 2]
    n++
  }
  const lin = (v: number) => Math.pow(v / Math.max(1, n) / 255, 2.2)
  c = [lin(r), lin(g), lin(b)]
  chipColour.set(tex, c)
  return c
}

export function buildCubeland(o: CubelandOpts): Cubeland {
  const store = createVoxelStore({ ox: CUBE_ORIGIN.x, oz: CUBE_ORIGIN.z, radius: WORLD_R })
  const mats = terrainMaterials()
  o.trackTexture(mats.texture)
  const root = new THREE.Group()
  root.name = 'cubeland'
  root.visible = false
  o.parent.add(root)
  const terrain = new THREE.Group()
  terrain.name = 'cubeland-terrain'
  root.add(terrain)

  const toBlock = (x: number, y: number, z: number, out: THREE.Vector3) =>
    out.set(Math.floor((x - CUBE_ORIGIN.x) / B), Math.floor(y / B), Math.floor((z - CUBE_ORIGIN.z) / B))
  const strikeAt = new THREE.Vector3()
  const blockAt = (x: number, y: number, z: number) =>
    store.get(Math.floor((x - CUBE_ORIGIN.x) / B), Math.floor(y / B), Math.floor((z - CUBE_ORIGIN.z) / B))
  /** a block's centre, world units */
  const centre = (bx: number, by: number, bz: number, out: THREE.Vector3) =>
    out.set(CUBE_ORIGIN.x + (bx + 0.5) * B, (by + 0.5) * B, CUBE_ORIGIN.z + (bz + 0.5) * B)

  /* ------------------------------------------------------------ meshes -- */

  const drawn = new Map<number, Drawn>()
  const geometry = (a: MeshArrays, birth: number) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('aBirth', new THREE.BufferAttribute(new Float32Array(a.position.length / 3).fill(birth), 1))
    g.setAttribute('position', new THREE.BufferAttribute(a.position, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3, true))
    g.setAttribute('aTex', new THREE.BufferAttribute(a.tex, 2))
    g.setAttribute('color', new THREE.BufferAttribute(a.color, 3, true))
    g.setAttribute('aBlk', new THREE.BufferAttribute(a.blk, 4))
    g.setIndex(new THREE.BufferAttribute(a.index, 1))
    g.computeBoundingSphere()
    return g
  }
  const placeMesh = (m: THREE.Mesh, cx: number, cz: number) => {
    m.position.set(CUBE_ORIGIN.x + cx * CHUNK_W, 0, CUBE_ORIGIN.z + cz * CHUNK_W)
    m.scale.setScalar(B / 16)
    m.updateMatrix()
    m.matrixAutoUpdate = false
    m.updateMatrixWorld(true)
  }
  const unmesh = (d: Drawn) => {
    for (const m of [d.solid, d.water]) {
      if (!m) continue
      m.geometry.dispose()
      m.removeFromParent()
    }
    d.solid = null
    d.water = null
  }
  const neighbourOf = (cx: number, cz: number) => (dx: number, dz: number) => store.chunk(cx + dx, cz + dz)
  /** (re)mesh a chunk. `fade` dissolves it in (a chunk arriving at the edge
      of the view); a chunk already on screen being re-meshed (an edit, a
      change of detail) and the ring primed under the card do not */
  const build = (cx: number, cz: number, far: boolean, fade: boolean) => {
    const k = chunkKey(cx, cz)
    let d = drawn.get(k)
    if (!d) drawn.set(k, (d = { solid: null, water: null, dirty: false, far }))
    unmesh(d)
    d.dirty = false
    d.far = far
    const birth = fade ? fadeClock.value : PREBORN
    const out = meshChunk(store.chunk(cx, cz), neighbourOf(cx, cz), far)
    if (out.solid) {
      const m = new THREE.Mesh(geometry(out.solid, birth), mats.solid)
      m.castShadow = true
      m.receiveShadow = true
      m.name = 'cube-chunk'
      placeMesh(m, cx, cz)
      terrain.add(m)
      d.solid = m
    }
    if (out.water) {
      const m = new THREE.Mesh(geometry(out.water, birth), mats.water)
      m.receiveShadow = true
      m.renderOrder = 1
      m.name = 'cube-water'
      placeMesh(m, cx, cz)
      terrain.add(m)
      d.water = m
    }
  }
  const markDirty = (cx: number, cz: number) => {
    const d = drawn.get(chunkKey(cx, cz))
    if (d) d.dirty = true
  }

  /* ---------------------------------------------------------- collision -- */

  const boxes: Solid[] = []
  const bounds = {
    minX: CUBE_ORIGIN.x - WORLD_R * CHUNK_W + 1,
    maxX: CUBE_ORIGIN.x + WORLD_R * CHUNK_W - 1,
    minZ: CUBE_ORIGIN.z - WORLD_R * CHUNK_W + 1,
    maxZ: CUBE_ORIGIN.z + WORLD_R * CHUNK_W - 1,
  }
  const collision = makeCollisionSet(bounds, boxes)
  // ...and the blocks themselves, which the walk sweeps through first
  collision.voxels = walkGrid(store)
  let boxAt = { cx: NaN, cz: NaN }
  let boxesStale = true
  const refreshBoxes = (cx: number, cz: number) => {
    if (!boxesStale && boxAt.cx === cx && boxAt.cz === cz) return
    boxesStale = false
    boxAt = { cx, cz }
    boxes.length = 0
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) if (store.inWorld(cx + dx, cz + dz)) boxes.push(...store.boxesOf(cx + dx, cz + dz))
    invalidateCollisionBoxes(boxes)
  }
  const chunkOf = (x: number) => Math.floor((x - CUBE_ORIGIN.x) / CHUNK_W)
  const chunkOfZ = (z: number) => Math.floor((z - CUBE_ORIGIN.z) / CHUNK_W)

  /* --------------------------------------------------------------- edits -- */

  let sb: Sandbox | null = null
  const localFns = new Set<(edits: WireEdit[], blast: boolean) => void>()
  let outbox: WireEdit[] = []
  let outboxBlast = false
  /** the one way a block changes: the store, the meshes, the boxes, and
      (unless it came off the wire) the outbox */
  const edit = (bx: number, by: number, bz: number, id: number, remote = false) => {
    const was = store.set(bx, by, bz, id)
    if (was < 0) return -1
    const cx = Math.floor(bx / CHUNK)
    const cz = Math.floor(bz / CHUNK)
    const lx = bx - cx * CHUNK
    const lz = bz - cz * CHUNK
    // the chunk, and any whose rim shading or faces this block touches
    for (let dz = lz === 0 ? -1 : 0; dz <= (lz === CHUNK - 1 ? 1 : 0); dz++)
      for (let dx = lx === 0 ? -1 : 0; dx <= (lx === CHUNK - 1 ? 1 : 0); dx++) markDirty(cx + dx, cz + dz)
    if (Math.abs(cx - boxAt.cx) <= 1 && Math.abs(cz - boxAt.cz) <= 1) boxesStale = true
    if (!remote) {
      outbox.push([bx, by, bz, id])
      // the liquids round a change are this client's to run (a peer's
      // changes arrive with their flow already worked out)
      wakeFluids(bx, by, bz)
    }
    return was
  }

  /* ------------------------------------------------------------- liquids -- */

  /*
    Water and lava flow the way they do there. A block of liquid is a
    source (level 0), a flowing block (1 to 7 for water, 1 to 3 for lava:
    lava runs a third as far), or a falling column (8). When anything next
    to a liquid changes, the liquid is scheduled for an update a game tick
    count later (5 ticks for water, 30 for lava, twenty ticks a second), and
    an update:

    - re-derives a flowing block's level from its neighbours (a falling one
      if the same liquid is on top of it, else one more than its lowest
      neighbour, else it dries up), and makes a new water source where two
      sources meet over something that holds them up, which is the endless
      water trick;
    - pours down first: into anything it can replace below it, as a falling
      column. A flowing block that can fall does not spread sideways, a
      source does both;
    - spreads sideways, one level thinner, only toward the nearest drop
      within four blocks (two for lava) if there is one, as there, else all
      round;
    - and where water and lava meet, lava becomes obsidian (a source) or
      cobblestone (flowing), and lava falling on water makes stone.

    Every change goes through `edit` like any other, so it is meshed,
    boxed, and sent: a peer sees the flow as edits and runs none of it.
  */
  const FAMILY = new Uint8Array(256)
  const LEVEL = new Uint8Array(256)
  for (const b of BLOCKS) {
    FAMILY[b.id] = b.fluid === 'water' ? 1 : b.fluid === 'lava' ? 2 : 0
    LEVEL[b.id] = b.level ?? 0
  }
  const MAX_RUN = [0, 7, 3]
  const TICKS = [0, 5, 30]
  const SEEK = [0, 4, 2]
  const idOf = (fam: number, level: number) => (fam === 1 ? WATER_FLOW[level] : LAVA_FLOW[level])
  /** ticks of simulated time here, twenty a second */
  let tick = 0
  const due = new Map<number, number>()
  const pack = (x: number, y: number, z: number) => ((x + 4096) * 8192 + (z + 4096)) * 128 + y
  const schedule = (x: number, y: number, z: number, fam: number) => {
    if (y < 0 || y >= H) return
    const k = pack(x, y, z)
    const at = tick + TICKS[fam]
    const was = due.get(k)
    if (was === undefined || was > at) due.set(k, at)
  }
  const NB6 = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]
  const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const wakeFluids = (x: number, y: number, z: number) => {
    const f = FAMILY[store.get(x, y, z)]
    if (f) schedule(x, y, z, f)
    for (const [dx, dy, dz] of NB6) {
      const g = FAMILY[store.get(x + dx, y + dy, z + dz)]
      if (g) schedule(x + dx, y + dy, z + dz, g)
    }
  }
  /** can a liquid of `fam` at `level` run into this block */
  const takes = (id: number, fam: number, level: number) => {
    if (id === AIR) return true
    const b = BLOCKS[id]
    if (b.cross || b.shape === 'torch') return true
    return FAMILY[id] === fam && LEVEL[id] !== 0 && LEVEL[id] !== 8 && LEVEL[id] > level
  }
  const fizz = (x: number, y: number, z: number) => {
    centre(x, y, z, tmp)
    sb?.fx.dust(tmp, 1.2)
    breakSound('glass', 0.3, tmp.x, tmp.y, tmp.z)
  }
  /** is there a drop within `n` blocks along the level, from (x, y, z),
      stepping only through blocks the liquid could run into */
  const dropIn = (x: number, y: number, z: number, first: number[], fam: number, n: number) => {
    let cx = x + first[0]
    let cz = z + first[1]
    for (let k = 1; k <= n; k++) {
      if (!takes(store.get(cx, y, cz), fam, 7)) return Infinity
      if (takes(store.get(cx, y - 1, cz), fam, 7) || FAMILY[store.get(cx, y - 1, cz)] === fam) return k
      cx += first[0]
      cz += first[1]
    }
    return Infinity
  }
  const flow = (x: number, y: number, z: number) => {
    const id = store.get(x, y, z)
    const fam = FAMILY[id]
    if (!fam) return
    let level = LEVEL[id]
    const other = fam === 1 ? 2 : 1
    // water met: lava sets
    if (fam === 2) {
      for (const [dx, dy, dz] of NB6) {
        if (dy < 0) continue
        if (FAMILY[store.get(x + dx, y + dy, z + dz)] === 1) {
          edit(x, y, z, level === 0 ? OBSIDIAN : COBBLE)
          fizz(x, y, z)
          return
        }
      }
    }
    // a flowing block finds its level again from what feeds it
    if (level !== 0) {
      let want: number
      if (FAMILY[store.get(x, y + 1, z)] === fam) want = 8
      else {
        let lo = 99
        let sources = 0
        for (const [dx, dz] of H4) {
          const n = store.get(x + dx, y, z + dz)
          if (FAMILY[n] !== fam) continue
          const l = LEVEL[n] === 8 ? 0 : LEVEL[n]
          if (LEVEL[n] === 0) sources++
          lo = Math.min(lo, l)
        }
        want = lo + 1
        const under = store.get(x, y - 1, z)
        if (fam === 1 && sources >= 2 && (isSolid(under) || (FAMILY[under] === 1 && LEVEL[under] === 0))) want = 0
      }
      if (want > MAX_RUN[fam] && want !== 8) {
        edit(x, y, z, AIR)
        return
      }
      if (want !== level) {
        edit(x, y, z, idOf(fam, want))
        level = want
      }
    }
    // down first
    const below = store.get(x, y - 1, z)
    let falls = false
    if (y > 0) {
      if (FAMILY[below] === other) {
        if (fam === 2) {
          edit(x, y - 1, z, STONE)
          fizz(x, y - 1, z)
        } else {
          edit(x, y - 1, z, LEVEL[below] === 0 ? OBSIDIAN : COBBLE)
          fizz(x, y - 1, z)
        }
      } else if (takes(below, fam, 0) || (FAMILY[below] === fam && LEVEL[below] !== 0 && LEVEL[below] !== 8)) {
        edit(x, y - 1, z, idOf(fam, 8))
        falls = true
      } else if (FAMILY[below] === fam) falls = LEVEL[below] !== 0
    }
    if (falls && level !== 0) return
    // then sideways, thinner, toward the nearest drop if there is one
    const next = level === 0 || level === 8 ? 1 : level + 1
    if (next > MAX_RUN[fam]) return
    // (a falling column spreads only where it lands)
    if (level === 8 && !isSolid(below) && FAMILY[below] !== fam) return
    let best = Infinity
    const dist = H4.map((d) => {
      const k = dropIn(x, y, z, d, fam, SEEK[fam])
      best = Math.min(best, k)
      return k
    })
    H4.forEach(([dx, dz], k) => {
      if (best !== Infinity && dist[k] !== best) return
      const nx = x + dx
      const nz = z + dz
      const n = store.get(nx, y, nz)
      if (FAMILY[n] === other) {
        edit(nx, y, nz, fam === 1 && LEVEL[n] === 0 ? OBSIDIAN : COBBLE)
        fizz(nx, y, nz)
      } else if (takes(n, fam, next)) edit(nx, y, nz, idOf(fam, next))
    })
  }
  /** run what is due, at most `cap` blocks a frame */
  const runFluids = (dt: number, cap: number) => {
    tick += dt * 20
    if (!due.size) return
    let n = 0
    const now: number[] = []
    for (const [k, at] of due) {
      if (at > tick) continue
      now.push(k)
      if (++n >= cap) break
    }
    for (const k of now) {
      due.delete(k)
      const y = k % 128
      const r = Math.floor(k / 128)
      flow(Math.floor(r / 8192) - 4096, y, (r % 8192) - 4096)
    }
  }

  const tmp = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  /** wake whatever props lie on or against a changed block */
  const wakeAround = (bx: number, by: number, bz: number) => {
    if (!sb) return
    const s = sb
    s.queryBall(centre(bx, by, bz, tmp), B * 1.3, (p) => s.wake(p.id))
  }

  /** props this level threw (blast debris, falling sand), oldest first */
  const debris: number[] = []
  const falling = new Map<number, { key: string; since: number }>()
  const spawnLoose = (b: BlockDef, bx: number, by: number, bz: number, vel?: THREE.Vector3, spin?: THREE.Vector3, gib = true) => {
    if (!sb || b.cross || b.liquid || !KINDS[blockKind(b)]) return -1
    centre(bx, by, bz, tmp2)
    const id = sb.spawn(blockKind(b), { x: tmp2.x, y: tmp2.y, z: tmp2.z }, {
      velocity: vel ? { x: vel.x, y: vel.y, z: vel.z } : undefined,
      angular: spin ? { x: spin.x, y: spin.y, z: spin.z } : undefined,
      data: gib ? { gib: true, cube: true } : { cube: true },
      phase: 0.15,
    })
    return id
  }
  const trimDebris = () => {
    const cap = gfx.rubble
    while (debris.length > cap && sb) {
      const id = debris.shift()!
      const p = sb.get(id)
      if (p && sb.getTransform(id, tmp)) sb.fx.dust(tmp, 1)
      sb.remove(id)
    }
  }

  /** what a removed block leaves hanging: plants go, sand and gravel fall */
  const unsupported = (bx: number, by: number, bz: number, remote: boolean) => {
    let y = by + 1
    for (let n = 0; n < 48 && y < H; n++, y++) {
      const id = store.get(bx, y, bz)
      const def = BLOCKS[id]
      if (def.cross) {
        edit(bx, y, bz, AIR, remote)
        return
      }
      if (id !== SAND && id !== GRAVEL) return
      edit(bx, y, bz, AIR, remote)
      if (remote) continue
      const pid = spawnLoose(def, bx, y, bz, undefined, undefined, false)
      if (pid >= 0) falling.set(pid, { key: def.key, since: 0 })
    }
  }

  /** a TNT block lit where it stands: it pops loose with its fuse burning,
      whether it was punched or shot */
  const lightTnt = (bx: number, by: number, bz: number) => {
    if (!sb) return
    edit(bx, by, bz, AIR)
    const pid = spawnLoose(BLOCKS[TNT], bx, by, bz, tmp.set(0, 5, 0), undefined, false)
    if (pid >= 0) sb.ignite(pid)
    unsupported(bx, by, bz, false)
    wakeAround(bx, by, bz)
  }

  const breakBlock = (bx: number, by: number, bz: number) => {
    const id = store.get(bx, by, bz)
    const def = BLOCKS[id]
    if (!id || def.liquid || def.hardness === Infinity) return false
    if (id === TNT && sb) {
      // punched TNT is lit, not broken
      lightTnt(bx, by, bz)
      return true
    }
    edit(bx, by, bz, AIR)
    centre(bx, by, bz, tmp)
    chips(def, tmp, 1)
    if (def.sound === 'glass') breakSound('glass', 0.6, tmp.x, tmp.y, tmp.z)
    else impactSound(def.sound, 0.75, def.mass, tmp.x, tmp.y, tmp.z)
    unsupported(bx, by, bz, false)
    wakeAround(bx, by, bz)
    return true
  }
  const chipVel = new THREE.Vector3()
  const chips = (def: BlockDef, at: THREE.Vector3, k: number) => {
    if (!sb) return
    const c = colourOf(def.side)
    chipVel.set(0, 3 * k, 0)
    sb.fx.rubble(at, chipVel, B * 0.7, c[0], c[1], c[2])
  }

  /* --------------------------------------------------------------- rays -- */

  interface Hit {
    x: number
    y: number
    z: number
    nx: number
    ny: number
    nz: number
    t: number
    id: number
  }
  const hit: Hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, t: 0, id: 0 }
  /** the first block (not air, not water) along a ray, within `max` units:
      a voxel walk, one block boundary at a time */
  const castBlocks = (eye: THREE.Vector3, dir: THREE.Vector3, max: number): Hit | null => {
    const px = (eye.x - CUBE_ORIGIN.x) / B
    const py = eye.y / B
    const pz = (eye.z - CUBE_ORIGIN.z) / B
    let x = Math.floor(px)
    let y = Math.floor(py)
    let z = Math.floor(pz)
    const sx = dir.x > 0 ? 1 : -1
    const sy = dir.y > 0 ? 1 : -1
    const sz = dir.z > 0 ? 1 : -1
    const tdx = Math.abs(1 / (dir.x || 1e-9))
    const tdy = Math.abs(1 / (dir.y || 1e-9))
    const tdz = Math.abs(1 / (dir.z || 1e-9))
    let tx = (sx > 0 ? x + 1 - px : px - x) * tdx
    let ty = (sy > 0 ? y + 1 - py : py - y) * tdy
    let tz = (sz > 0 ? z + 1 - pz : pz - z) * tdz
    const maxT = max / B
    let t = 0
    let nx = 0
    let ny = 0
    let nz = 0
    for (let n = 0; n < 64 && t <= maxT; n++) {
      if (y >= 0 && y < H) {
        const id = store.get(x, y, z)
        if (id && !BLOCKS[id].liquid) {
          hit.x = x; hit.y = y; hit.z = z
          hit.nx = nx; hit.ny = ny; hit.nz = nz
          hit.t = t * B
          hit.id = id
          return hit
        }
      }
      if (tx < ty && tx < tz) {
        t = tx; tx += tdx; x += sx; nx = -sx; ny = 0; nz = 0
      } else if (ty < tz) {
        t = ty; ty += tdy; y += sy; nx = 0; ny = -sy; nz = 0
      } else {
        t = tz; tz += tdz; z += sz; nx = 0; ny = 0; nz = -sz
      }
    }
    return null
  }

  /* -------------------------------------------------------------- hands -- */

  const hud: { kinds: string[]; sel: number } = { kinds: HOTBAR.map((k) => `block_${k}`), sel: 0 }
  const hudFns = new Set<(h: HandsHud) => void>()
  const tellHud = () => {
    const h = { kinds: [...hud.kinds], sel: hud.sel }
    for (const fn of hudFns) fn(h)
  }

  // the outline round the block under the crosshair
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(B + 0.04, B + 0.04, B + 0.04)),
    new THREE.LineBasicMaterial({ color: 0x14161a }),
  )
  outline.name = 'cube-outline'
  outline.userData.dynamic = true
  o.trackDisposable(outline.geometry)
  o.trackDisposable(outline.material as THREE.Material)
  root.add(outline)

  // the block in hand, drawn and moved as the famous game does it (held.ts)
  const held = createHeldItem({ store, blockOf: blockOfKind, trackDisposable: o.trackDisposable, first: hud.kinds[0] })
  root.add(held.mesh)
  let fireT = 0
  let altT = 0
  let fireWas = false
  let altWas = false
  let wasActive = false
  const dirTmp = new THREE.Vector3()

  const hands = {
    update: (f: import('../types').HandsFrame) => {
      const cam = f.camera
      if (!f.active) {
        outline.visible = false
        held.hide()
        wasActive = false
        fireWas = altWas = false
        return
      }
      // a click that brought the hands back (a pause, the catalogue) is not
      // a dig
      if (!wasActive) {
        fireWas = f.fire
        altWas = f.alt
      }
      wasActive = true
      if (f.wheel) {
        const n = hud.kinds.length
        hud.sel = (((hud.sel + Math.sign(f.wheel)) % n) + n) % n
        tellHud()
      }
      cam.getWorldDirection(dirTmp)
      const h = castBlocks(cam.position, dirTmp, REACH)
      if (h) {
        centre(h.x, h.y, h.z, outline.position)
        outline.updateMatrix()
        outline.updateMatrixWorld()
      }
      outline.visible = !!h
      // left: break
      fireT -= f.dt
      altT -= f.dt
      if (f.fire && h && (!fireWas || fireT <= 0)) {
        if (breakBlock(h.x, h.y, h.z)) held.swing()
        fireT = REPEAT
      }
      // (a punch at the air still swings, as there)
      else if (f.fire && !fireWas && !h) held.swing()
      // right: place against the face
      if (f.alt && h && (!altWas || altT <= 0)) {
        altT = REPEAT
        const def = blockOfKind(hud.kinds[hud.sel])
        if (def) {
          const onto = BLOCKS[h.id].cross
          const px = onto ? h.x : h.x + h.nx
          const py = onto ? h.y : h.y + h.ny
          const pz = onto ? h.z : h.z + h.nz
          const there = store.get(px, py, pz)
          const free = there === AIR || BLOCKS[there].liquid || BLOCKS[there].cross || BLOCKS[there].shape === 'torch'
          // never inside the body placing it
          const x0 = CUBE_ORIGIN.x + px * B
          const z0 = CUBE_ORIGIN.z + pz * B
          const r = 0.36
          const body = cam.position.x + r > x0 && cam.position.x - r < x0 + B &&
            cam.position.z + r > z0 && cam.position.z - r < z0 + B &&
            f.feetY < (py + 1) * B && cam.position.y + 0.2 > py * B
          if (free && py >= 0 && py < H && (!def.solid || !body)) {
            if (edit(px, py, pz, def.id) >= 0) {
              held.swing()
              centre(px, py, pz, tmp)
              impactSound(def.sound, 0.55, def.mass, tmp.x, tmp.y, tmp.z)
              wakeAround(px, py, pz)
            }
          }
        }
      }
      fireWas = f.fire
      altWas = f.alt
      // the block in hand, lower right, bobbing with the step, trailing a
      // turn and swinging on every use (held.ts)
      if (f.firstPerson) {
        toBlock(cam.position.x, cam.position.y, cam.position.z, tmp)
        held.update({
          camera: cam, dt: f.dt, kind: hud.kinds[hud.sel], bx: tmp.x, by: tmp.y, bz: tmp.z,
          gait: f.gait ?? 0, stride: f.stride ?? 0, grounded: f.grounded ?? true,
        })
      } else held.hide()
    },
    choose: (kind: string) => {
      const def = blockOfKind(kind)
      if (!def) return false
      const at = hud.kinds.indexOf(kind)
      if (at >= 0) hud.sel = at
      else hud.kinds[hud.sel] = kind
      tellHud()
      return true
    },
    subscribe: (fn: (h: HandsHud) => void) => {
      hudFns.add(fn)
      fn({ kinds: [...hud.kinds], sel: hud.sel })
      return () => hudFns.delete(fn)
    },
  }

  /* ------------------------------------------------------------- blasts -- */

  const blastDir = new THREE.Vector3()
  const blastSpin = new THREE.Vector3()
  const carve = (ex: number, ey: number, ez: number, power: number, radius: number) => {
    const rb = Math.min(6, Math.max(1.5, radius * Math.cbrt(power) * 0.2))
    toBlock(ex, ey, ez, tmp)
    const cx = tmp.x
    const cy = tmp.y
    const cz = tmp.z
    const bx0 = (ex - CUBE_ORIGIN.x) / B
    const by0 = ey / B
    const bz0 = (ez - CUBE_ORIGIN.z) / B
    const n = Math.ceil(rb)
    const gone: Array<{ x: number; y: number; z: number; def: BlockDef; f: number }> = []
    for (let dy = -n; dy <= n; dy++)
      for (let dz = -n; dz <= n; dz++)
        for (let dx = -n; dx <= n; dx++) {
          const x = cx + dx
          const y = cy + dy
          const z = cz + dz
          if (y < 0 || y >= H) continue
          const d = Math.hypot(x + 0.5 - bx0, y + 0.5 - by0, z + 0.5 - bz0)
          if (d > rb) continue
          const id = store.get(x, y, z)
          if (!id || BLOCKS[id].liquid) continue
          const def = BLOCKS[id]
          if (def.hardness === Infinity) continue
          const f = 1 - d / rb
          if (f + 0.35 * Math.random() < def.hardness * 0.7) continue
          gone.push({ x, y, z, def, f })
        }
    if (!gone.length) return
    for (const g of gone) edit(g.x, g.y, g.z, AIR)
    const throwShare = Math.min(1, DEBRIS_PER_BLAST / gone.length)
    let chipped = 0
    for (const g of gone) {
      centre(g.x, g.y, g.z, tmp)
      blastDir.set(tmp.x - ex, tmp.y - ey, tmp.z - ez)
      const len = blastDir.length() || 1
      blastDir.multiplyScalar(1 / len)
      blastDir.y = Math.abs(blastDir.y) + 0.9
      blastDir.normalize()
      if (g.def.id === TNT) {
        const pid = spawnLoose(g.def, g.x, g.y, g.z, blastDir.multiplyScalar(14), undefined, false)
        if (pid >= 0) sb?.ignite(pid)
        continue
      }
      if (g.def.cross) continue
      if (sb && Math.random() < throwShare) {
        const v = blastThrow(g.def.mass, power, 0.35 + 0.65 * g.f) * (0.7 + Math.random() * 0.5)
        blastSpin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(12)
        const pid = spawnLoose(g.def, g.x, g.y, g.z, blastDir.multiplyScalar(v), blastSpin)
        if (pid >= 0) debris.push(pid)
      } else if (chipped++ < 10) chips(g.def, tmp, 2.5)
    }
    for (const g of gone) unsupported(g.x, g.y, g.z, false)
    outboxBlast = true
    trimDebris()
  }

  /* --------------------------------------------------- falling sand -- */

  const settleFalling = (dt: number) => {
    if (!sb || !falling.size) return
    for (const [id, f] of falling) {
      const p = sb.get(id)
      if (!p) {
        falling.delete(id)
        continue
      }
      const still = p.body.isSleeping() || (p.body.linvel().y > -0.05 && Math.hypot(p.body.linvel().x, p.body.linvel().y, p.body.linvel().z) < 0.3)
      f.since = still ? f.since + dt : 0
      if (f.since < 0.25 && !p.body.isSleeping()) continue
      const t = p.body.translation()
      toBlock(t.x, t.y, t.z, tmp)
      const here = store.get(tmp.x, tmp.y, tmp.z)
      if (here === AIR || BLOCKS[here].liquid || BLOCKS[here].cross) {
        const def = BLOCK_BY_KEY.get(f.key)
        if (def) edit(tmp.x, tmp.y, tmp.z, def.id)
      }
      falling.delete(id)
      sb.remove(id)
    }
  }

  /* -------------------------------------------------------------- grab -- */

  const grab = {
    pick: (eye: THREE.Vector3, dir: THREE.Vector3, within: number) => {
      const h = castBlocks(eye, dir, Math.min(within, 60))
      if (!h) return null
      const def = BLOCKS[h.id]
      if (def.hardness === Infinity || def.cross || def.liquid) return null
      return { key: `blk:${h.x},${h.y},${h.z}`, t: h.t }
    },
    take: (key: string, s: Sandbox): Prop | null => {
      if (s !== sb || !key.startsWith('blk:')) return null
      const [x, y, z] = key.slice(4).split(',').map(Number)
      const id = store.get(x, y, z)
      const def = BLOCKS[id]
      if (!id || def.hardness === Infinity || def.cross || def.liquid) return null
      edit(x, y, z, AIR)
      centre(x, y, z, tmp)
      chips(def, tmp, 0.6)
      unsupported(x, y, z, false)
      wakeAround(x, y, z)
      // a catalogued block, so it is on the wire like anything spawned
      const pid = spawnLoose(def, x, y, z, undefined, undefined, false)
      return pid >= 0 ? s.get(pid) ?? null : null
    },
  }

  /* ---------------------------------------------------------- streaming -- */

  const view = () => gfx.cubeView
  let wanted: Array<[number, number]> = []
  let wantAt = { cx: NaN, cz: NaN, r: -1 }
  const rings = (cx: number, cz: number, r: number) => {
    const out: Array<[number, number, number]> = []
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dz)
        if (d > r + 0.5 || !store.inWorld(cx + dx, cz + dz)) continue
        out.push([cx + dx, cz + dz, d])
      }
    out.sort((a, b) => a[2] - b[2])
    return out.map(([x, z]) => [x, z] as [number, number])
  }
  /** mesh what is missing near (cx, cz), nearest first, for `budget` ms */
  const stream = (cx: number, cz: number, budget: number) => {
    const t0 = performance.now()
    const late = () => performance.now() - t0 > budget
    // what somebody just changed: close by at once, whatever it costs, so a
    // block breaks under the cursor; further off inside the budget
    for (const [k, d] of drawn) {
      if (!d.dirty) continue
      const kx = Math.floor(k / 65536) - 32768
      const kz = (k % 65536) - 32768
      if ((Math.abs(kx - cx) <= 2 && Math.abs(kz - cz) <= 2) || !late()) build(kx, kz, d.far, false)
    }
    const r = view()
    if (wantAt.cx !== cx || wantAt.cz !== cz || wantAt.r !== r) {
      wantAt = { cx, cz, r }
      wanted = rings(cx, cz, r)
      // what fell out of view
      for (const [k, d] of drawn) {
        const kx = Math.floor(k / 65536) - 32768
        const kz = (k % 65536) - 32768
        if (Math.hypot(kx - cx, kz - cz) > r + 1.5) {
          unmesh(d)
          drawn.delete(k)
        }
      }
      for (let kx = cx - r - 8; kx <= cx + r + 8; kx++)
        for (let kz = cz - r - 8; kz <= cz + r + 8; kz++) {
          if (Math.hypot(kx - cx, kz - cz) <= r + 3) continue
          if (store.peek(kx, kz)) store.drop(kx, kz)
        }
    }
    // nearest first: what is missing fades in; what has come inside the
    // near ring gets its full mesh, and what has left it the cheap one,
    // both swapped in place
    for (const [x, z] of wanted) {
      if (late()) break
      const d = drawn.get(chunkKey(x, z))
      const dist = Math.hypot(x - cx, z - cz)
      if (!d) build(x, z, dist > NEAR, true)
      else if (d.far && dist <= NEAR) build(x, z, false, false)
      else if (!d.far && dist > FAR_AT) build(x, z, true, false)
    }
    // the walker's boxes for the ring it may step into next, ahead of the
    // step (merging a chunk's is a few milliseconds; cached once made)
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if (late()) return
        if (store.inWorld(cx + dx, cz + dz)) store.boxesOf(cx + dx, cz + dz)
      }
  }

  /* ------------------------------------------------------------- spawn -- */

  /** the top of the ground in a column, from the blocks themselves */
  const surfaceY = (bx: number, bz: number) => {
    for (let y = H - 1; y >= 0; y--) if (isSolid(store.get(bx, y, bz))) return y + 1
    return 1
  }
  /** the default arrival: dry grass under open sky near the middle (not
      under a canopy, not on one), found once */
  const home = (() => {
    const c = { h: 0, biome: 0 as Biome }
    for (let r = 0; r < 400; r += 3)
      for (let a = 0; a < 16; a++) {
        const bx = Math.round(Math.cos((a / 16) * Math.PI * 2) * r)
        const bz = Math.round(Math.sin((a / 16) * Math.PI * 2) * r)
        columnAt(bx, bz, c)
        if (c.h > SEA + 2 && c.h < SEA + 22 && (c.biome === Biome.Plains || c.biome === Biome.Forest)) {
          // the blocks round it: grass underfoot and nothing overhead
          let open = surfaceY(bx, bz) === c.h + 1 && BLOCKS[store.get(bx, c.h, bz)].key === 'grass'
          for (let dz = -1; dz <= 1 && open; dz++)
            for (let dx = -1; dx <= 1 && open; dx++)
              for (let y = c.h + 1; y < c.h + 5; y++) if (isSolid(store.get(bx + dx, y, bz + dz))) open = false
          if (open) return { bx, bz }
        }
        if (r === 0) break
      }
    return { bx: 0, bz: 0 }
  })()
  const spawnFor = (): LevelSpawn => {
    const x = CUBE_ORIGIN.x + (home.bx + 0.5) * B
    const z = CUBE_ORIGIN.z + (home.bz + 0.5) * B
    return { x, z, yaw: 0, y: surfaceY(home.bx, home.bz) * B }
  }
  /** the ground round a point meshed and boxed, before anybody stands on it */
  const prime = (x: number, z: number, r: number) => {
    const cx = chunkOf(x)
    const cz = chunkOfZ(z)
    for (const [kx, kz] of rings(cx, cz, r)) if (!drawn.has(chunkKey(kx, kz))) build(kx, kz, Math.hypot(kx - cx, kz - cz) > NEAR, false)
    refreshBoxes(cx, cz)
  }
  {
    const s = spawnFor()
    prime(s.x, s.z, 6)
  }

  /* ---------------------------------------------------------------- day -- */

  /*
    The day is the real one's: twenty minutes, twenty ticks a second, 24000
    ticks, of which 0 is sunrise, 6000 noon, 12000 the start of sunset,
    13800 night, 18000 midnight and 22200 the start of sunrise. So ten
    minutes of full day, a minute and a half of sunset, seven of night and
    a minute and a half of dawn. The ticks are mapped piecewise onto the
    sky's clock (0.5 noon, its sunset band round 0.74 to 0.8, its dawn the
    mirror of it), and they run off the wall clock, so everybody standing in
    Cubeland is under the same sky without a word on the wire. The
    console's `time` still pins it.
  */
  const skyOf = (tick: number) => {
    const t = ((tick % 24000) + 24000) % 24000
    if (t < 12000) return 0.27 + (t / 12000) * 0.46
    if (t < 13800) return 0.73 + ((t - 12000) / 1800) * 0.07
    if (t < 22200) return (0.8 + ((t - 13800) / 8400) * 0.4) % 1
    return 0.2 + ((t - 22200) / 1800) * 0.07
  }
  /** ticks now: wall-clock time at twenty a second */
  const ticks = () => Date.now() / 50

  /* -------------------------------------------------------------- light -- */

  const overrideLight = (rig: LevelLightRig) => {
    const reach = view() * CHUNK_W
    rig.fog.near = Math.min(rig.fog.near, reach * 0.55)
    rig.fog.far = Math.min(rig.fog.far, reach)
    rig.moon.intensity *= 0.6
    rig.windowSpill.intensity = 0
    rig.setMoonPool(0)
    // block light shows most where the day does not reach (material.ts)
    daylight.value = rig.day
  }

  /* -------------------------------------------------------------- water -- */

  let waterNow: number | undefined
  const SEA_TOP = (SEA + 1) * B - 0.25
  /** the surface of whatever liquid the body is in (lava is swum through
      like water, slowly and badly), or undefined */
  const findWater = (p: THREE.Vector3, feetY: number) => {
    toBlock(p.x, feetY + 0.2, p.z, tmp)
    let y = tmp.y
    let fam = FAMILY[store.get(tmp.x, y, tmp.z)]
    if (!fam) {
      // wading: the water is at the eye, not the feet
      y = Math.floor(p.y / B)
      fam = FAMILY[store.get(tmp.x, y, tmp.z)]
      if (!fam) return undefined
    }
    while (y < H - 1 && FAMILY[store.get(tmp.x, y + 1, tmp.z)] === fam) y++
    const top = store.get(tmp.x, y, tmp.z)
    const lv = LEVEL[top]
    const h = lv === 0 || lv === 8 ? 0.875 : Math.max(0.12, (8 - (fam === 2 ? lv * 2 : lv)) / 9)
    return (y + h) * B - 0.1
  }

  /* ------------------------------------------------ what lava does to props -- */

  const inLava = new Map<number, number>()
  let lavaCheck = 0
  const burnProps = (dt: number) => {
    lavaCheck -= dt
    if (lavaCheck > 0 || !sb) return
    lavaCheck = 0.25
    const s2 = sb
    s2.forEach((p) => {
      if (!s2.getTransform(p.id, tmp)) return
      const id = blockAt(tmp.x, tmp.y - p.extents.y * 0.5, tmp.z)
      if (FAMILY[id] !== 2) {
        inLava.delete(p.id)
        return
      }
      const t = (inLava.get(p.id) ?? 0) + 0.25
      inLava.set(p.id, t)
      s2.fx.burn(tmp, 1)
      // a thing that goes off goes off; anything else is gone in a second
      if (p.kind.explodes) s2.ignite(p.id)
      else if (t >= 1) {
        s2.fx.dust(tmp, 1.2)
        breakSound('glass', 0.25, tmp.x, tmp.y, tmp.z)
        s2.remove(p.id)
        inLava.delete(p.id)
      }
    })
  }

  /* -------------------------------------------------------------- level -- */

  let sendIn = 0
  const level: Level = {
    id: 'cubeland',
    groundY: 0,
    collision,
    get spawn() {
      return spawnFor()
    },
    get waterY() {
      return waterNow
    },
    enter: () => {
      root.visible = true
      o.venue('away')
    },
    leave: () => {
      root.visible = false
      o.venue('earth')
      outline.visible = false
      held.hide()
    },
    update: (dt, p) => {
      const cx = chunkOf(p.x)
      const cz = chunkOfZ(p.z)
      fadeClock.value = performance.now() / 1000
      stream(cx, cz, 4)
      refreshBoxes(cx, cz)
      // (the lens is the walker's eye, 3.84 over the soles)
      waterNow = findWater(p, p.y - 3.84)
      settleFalling(dt)
      runFluids(dt, 400)
      burnProps(dt)
      // (at most ten sends a second: a flood makes an edit every tick)
      sendIn -= dt
      if (outbox.length && sendIn <= 0) {
        sendIn = 0.1
        const out = outbox
        const blast = outboxBlast
        outbox = []
        outboxBlast = false
        for (const fn of localFns) fn(out, blast)
      }
      o.homeUpdate(dt, p)
    },
    seamTo: () => null,
    overrideLight,
    get timeOfDay() {
      return skyOf(ticks())
    },
    gravity: 1,
    jump: 1.14,
    ceilingAt: (x, z, feetY) => {
      let lo = Infinity
      const y0 = Math.floor(feetY / B + 0.25)
      for (const [ox, oz] of [[-0.34, -0.34], [0.34, -0.34], [-0.34, 0.34], [0.34, 0.34]]) {
        const bx = Math.floor((x + ox - CUBE_ORIGIN.x) / B)
        const bz = Math.floor((z + oz - CUBE_ORIGIN.z) / B)
        for (let y = y0 + 1; y <= y0 + 4 && y < H; y++) {
          if (isSolid(store.get(bx, y, bz))) {
            lo = Math.min(lo, y * B)
            break
          }
        }
      }
      // nearly the whole crown over the blocks' underside: the walk keeps
      // its crown (0.4) under whatever this says, and at the full crown a
      // body two blocks tall could never hop onto a ledge in a room three
      // blocks high (the eye still stays a near plane clear of it)
      return lo + 0.38
    },
    sandbox: {
      ground: {
        lattice: () => 0,
        heightAt: () => 0,
        extra: (pw, x0, z0, x1, z1) => store.attachPhysics(pw, x0, z0, x1, z1),
      },
      waterY: () => SEA_TOP,
      waveAt: (x, z) => (blockAt(x, SEA * B + 1, z) === WATER ? 0 : -1e6),
      attach: (s) => {
        sb = s
        s.onExplosion((e) => {
          if (e.remote) return
          const lx = e.x - CUBE_ORIGIN.x
          const lz = e.z - CUBE_ORIGIN.z
          if (Math.abs(lx) > WORLD_R * CHUNK_W + 50 || Math.abs(lz) > WORLD_R * CHUNK_W + 50) return
          carve(e.x, e.y, e.z, e.power, e.radius)
        })
        // a bullet or a bolt into a TNT block lights it, as a punch does:
        // the block is the one just past the face the shot met
        s.onStrike((at, dir) => {
          const c = toBlock(at.x + dir.x * 0.05, at.y + dir.y * 0.05, at.z + dir.z * 0.05, strikeAt)
          if (store.get(c.x, c.y, c.z) === TNT) lightTnt(c.x, c.y, c.z)
        })
        s.onRemove((p) => {
          falling.delete(p.id)
          const i = debris.indexOf(p.id)
          if (i >= 0) debris.splice(i, 1)
        })
      },
    },
    outdoors: true,
    air: true,
    surfaceAt: (x, z, feetY, wet): StepSurface => {
      if (wet > 0.12) return 'water'
      let id = blockAt(x, feetY - 0.3, z)
      if (!id) {
        // on the rim of a block: whichever of the four under the soles is there
        for (const [ox, oz] of [[-0.4, 0], [0.4, 0], [0, -0.4], [0, 0.4]]) {
          id = blockAt(x + ox, feetY - 0.3, z + oz)
          if (id) break
        }
      }
      return id ? BLOCKS[id].step : 'stone'
    },
    hands,
    grab,
  }
  root.updateMatrixWorld(true)

  const net: BlockNet = {
    onLocal: (fn) => {
      localFns.add(fn)
      return () => localFns.delete(fn)
    },
    apply: (edits, blast) => {
      let thrown = 0
      for (const [x, y, z, id] of edits) {
        if (!BLOCKS[id]) continue
        const was = store.get(x, y, z)
        if (edit(x, y, z, id, true) < 0) continue
        // a blast somebody else set off: some of what it took out flies here too
        if (blast && id === AIR && sb && thrown < DEBRIS_PER_BLAST / 2) {
          const def = BLOCKS[was]
          centre(x, y, z, tmp)
          if (!def.cross && Math.random() < 0.4) {
            blastSpin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(10)
            const pid = spawnLoose(def, x, y, z, tmp2.set(Math.random() - 0.5, 1, Math.random() - 0.5).multiplyScalar(12), blastSpin)
            if (pid >= 0) {
              debris.push(pid)
              thrown++
            }
          } else chips(def, tmp, 2)
        }
        wakeAround(x, y, z)
      }
      trimDebris()
    },
    all: () => {
      const out: WireEdit[] = []
      for (const [k, m] of store.edits) {
        const cx = Math.floor(k / 65536) - 32768
        const cz = (k % 65536) - 32768
        for (const [i, id] of m) out.push([cx * CHUNK + (i & 15), i >> 8, cz * CHUNK + ((i >> 4) & 15), id])
      }
      return out
    },
  }

  return { root, level, store, net, blockId: (key) => BLOCK_BY_KEY.get(key)?.id ?? -1 }
}
