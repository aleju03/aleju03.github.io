import * as THREE from 'three'
import {
  AIR, B, BLOCKS, BLOCK_BY_KEY, GRAVEL, SAND, TNT, WATER, blockKind, blockOfKind, paintTexture,
  type BlockDef,
} from '../../sandbox/blocks'
import { propMaterial } from '../../sandbox/art'
import { KINDS } from '../../sandbox/kinds'
import { blastThrow } from '../../sandbox/explosion'
import { breakSound, impactSound } from '../../sandbox/impactSounds'
import type { Prop, Sandbox } from '../../sandbox/sandbox'
import type { BatchProxy } from '../../sandbox/batch'
import { invalidateCollisionBoxes, makeCollisionSet, type Solid } from '../../physics/collision'
import type { StepSurface } from '../../core/sfx'
import { gfx } from '../../world/quality'
import type { HandsHud, Level, LevelLightRig, LevelSpawn } from '../types'
import { Biome, CHUNK, H, SEA, columnAt } from './gen'
import { meshChunk, type MeshArrays } from './mesher'
import { terrainMaterials } from './material'
import { CHUNK_W, chunkKey, createVoxelStore, isSolid, type VoxelStore } from './world'

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
    distance (quality.ts's `cubeView`) under a few milliseconds a frame, and
    a chunk somebody just changed is rebuilt before anything else, the same
    frame, so a block breaks under the cursor rather than a beat later. The
    fog closes at the edge of what is meshed, the way it does there.
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
    in hand. Hold either button to keep going, as there.
  - **Blasts.** Any explosion in the sandbox (a rocket, a barrel, a lit TNT
    block) takes out a ball of blocks, softer ones further, bedrock and
    obsidian never, and throws a couple of dozen of them as real props, the
    catalogue's own block kinds, on the sandbox's budget for rubble: they
    tumble, stack and can be picked up. TNT caught in a blast is lit and
    thrown, so a stack of it goes off in a chain.
  - **The day** is twenty minutes, the real one's to the tick (`skyOf`):
    ten of daylight, a minute and a half of sunset, seven of night, a minute
    and a half of dawn, off the wall clock so every player shares it.
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
const HOTBAR = ['grass', 'dirt', 'stone', 'cobblestone', 'planks', 'log', 'glass', 'bricks', 'tnt']

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
}

interface Drawn {
  solid: THREE.Mesh | null
  water: THREE.Mesh | null
  dirty: boolean
}

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
  const blockAt = (x: number, y: number, z: number) =>
    store.get(Math.floor((x - CUBE_ORIGIN.x) / B), Math.floor(y / B), Math.floor((z - CUBE_ORIGIN.z) / B))
  /** a block's centre, world units */
  const centre = (bx: number, by: number, bz: number, out: THREE.Vector3) =>
    out.set(CUBE_ORIGIN.x + (bx + 0.5) * B, (by + 0.5) * B, CUBE_ORIGIN.z + (bz + 0.5) * B)

  /* ------------------------------------------------------------ meshes -- */

  const drawn = new Map<number, Drawn>()
  const geometry = (a: MeshArrays) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(a.position, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3, true))
    g.setAttribute('aTex', new THREE.BufferAttribute(a.tex, 2))
    g.setAttribute('color', new THREE.BufferAttribute(a.color, 3, true))
    g.setAttribute('aBlk', new THREE.BufferAttribute(a.blk, 2))
    g.setIndex(new THREE.BufferAttribute(a.index, 1))
    g.computeBoundingSphere()
    return g
  }
  const placeMesh = (m: THREE.Mesh, cx: number, cz: number) => {
    m.position.set(CUBE_ORIGIN.x + cx * CHUNK_W, 0, CUBE_ORIGIN.z + cz * CHUNK_W)
    m.scale.setScalar(B / 8)
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
  const build = (cx: number, cz: number) => {
    const k = chunkKey(cx, cz)
    let d = drawn.get(k)
    if (!d) drawn.set(k, (d = { solid: null, water: null, dirty: false }))
    unmesh(d)
    d.dirty = false
    const out = meshChunk(store.chunk(cx, cz), neighbourOf(cx, cz))
    if (out.solid) {
      const m = new THREE.Mesh(geometry(out.solid), mats.solid)
      m.castShadow = true
      m.receiveShadow = true
      m.name = 'cube-chunk'
      placeMesh(m, cx, cz)
      terrain.add(m)
      d.solid = m
    }
    if (out.water) {
      const m = new THREE.Mesh(geometry(out.water), mats.water)
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
    if (!remote) outbox.push([bx, by, bz, id])
    return was
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

  const breakBlock = (bx: number, by: number, bz: number) => {
    const id = store.get(bx, by, bz)
    const def = BLOCKS[id]
    if (!id || def.liquid || def.hardness === Infinity) return false
    if (id === TNT && sb) {
      // punched TNT is lit, not broken
      edit(bx, by, bz, AIR)
      const pid = spawnLoose(def, bx, by, bz, tmp.set(0, 5, 0), undefined, false)
      if (pid >= 0) sb.ignite(pid)
      unsupported(bx, by, bz, false)
      wakeAround(bx, by, bz)
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
        if (id && id !== WATER) {
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

  // the block in hand, drawn in front of everything like the viewmodel is
  // (its depth squeezed toward the near plane, see tools/viewmodel.ts)
  const heldMat = propMaterial().clone()
  heldMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n  gl_Position.z = -gl_Position.w + (gl_Position.z + gl_Position.w) * 0.25;',
    )
  }
  heldMat.customProgramCacheKey = () => 'cube-held'
  o.trackDisposable(heldMat)
  const held = new THREE.Mesh(new THREE.BufferGeometry(), heldMat)
  held.name = 'cube-held'
  held.userData.dynamic = true
  held.frustumCulled = false
  held.castShadow = false
  root.add(held)
  let heldKind = ''
  const heldGeo = (kind: string) => {
    const k = KINDS[kind]
    const m = k?.mesh?.() as (BatchProxy & THREE.Mesh) | undefined
    return m ? ((m as BatchProxy).geo ?? (m as THREE.Mesh).geometry ?? null) : null
  }
  const setHeld = (kind: string) => {
    if (kind === heldKind) return
    heldKind = kind
    const g = heldGeo(kind)
    if (g) held.geometry = g
  }
  setHeld(hud.kinds[0])
  let swing = 0
  let fireT = 0
  let altT = 0
  let fireWas = false
  let altWas = false
  let wasActive = false
  const qTmp = new THREE.Quaternion()
  const eTmp = new THREE.Euler()
  const dirTmp = new THREE.Vector3()

  const hands = {
    update: (f: import('../types').HandsFrame) => {
      const cam = f.camera
      if (!f.active) {
        outline.visible = false
        held.visible = false
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
        if (breakBlock(h.x, h.y, h.z)) swing = 1
        fireT = REPEAT
      }
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
          const free = there === AIR || there === WATER || BLOCKS[there].cross
          // never inside the body placing it
          const x0 = CUBE_ORIGIN.x + px * B
          const z0 = CUBE_ORIGIN.z + pz * B
          const r = 0.36
          const body = cam.position.x + r > x0 && cam.position.x - r < x0 + B &&
            cam.position.z + r > z0 && cam.position.z - r < z0 + B &&
            f.feetY < (py + 1) * B && cam.position.y + 0.2 > py * B
          if (free && !body && py >= 0 && py < H && (!def.solid || !body)) {
            if (edit(px, py, pz, def.id) >= 0) {
              swing = 1
              centre(px, py, pz, tmp)
              impactSound(def.sound, 0.55, def.mass, tmp.x, tmp.y, tmp.z)
              wakeAround(px, py, pz)
            }
          }
        }
      }
      fireWas = f.fire
      altWas = f.alt
      // the block in hand, bottom right, swinging down on every use
      setHeld(hud.kinds[hud.sel])
      held.visible = f.firstPerson
      if (held.visible) {
        swing = Math.max(0, swing - f.dt * 5)
        const s = Math.sin(swing * Math.PI)
        // sized off the lens, so it sits in the same corner at any fov
        const d = 0.5
        const k = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * d
        tmp.set(0.58 * k * cam.aspect, -0.6 * k - s * 0.12 * k, -d + s * 0.06).applyQuaternion(cam.quaternion).add(cam.position)
        held.position.copy(tmp)
        eTmp.set(-0.2 - s * 0.7, 0.62, 0.06)
        qTmp.setFromEuler(eTmp)
        held.quaternion.copy(cam.quaternion).multiply(qTmp)
        held.scale.setScalar(0.17 * k)
        held.updateMatrix()
        held.updateMatrixWorld()
      }
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
          if (!id || id === WATER) continue
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
      if (here === AIR || here === WATER || BLOCKS[here].cross) {
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
    // what somebody just changed, first and whole
    let rebuilt = 0
    for (const [k, d] of drawn) {
      if (!d.dirty) continue
      const kx = Math.floor(k / 65536) - 32768
      const kz = (k % 65536) - 32768
      if (Math.abs(kx - cx) <= 2 && Math.abs(kz - cz) <= 2 || rebuilt < 2 || performance.now() - t0 < budget) {
        build(kx, kz)
        rebuilt++
      }
    }
    const r = view()
    if (wantAt.cx !== cx || wantAt.cz !== cz || wantAt.r !== r) {
      wantAt = { cx, cz, r }
      wanted = rings(cx, cz, r)
      // what fell out of view
      for (const [k, d] of drawn) {
        const kx = Math.floor(k / 65536) - 32768
        const kz = (k % 65536) - 32768
        if (Math.hypot(kx - cx, kz - cz) > r + 2) {
          unmesh(d)
          drawn.delete(k)
        }
      }
      for (let kx = cx - r - 8; kx <= cx + r + 8; kx++)
        for (let kz = cz - r - 8; kz <= cz + r + 8; kz++) {
          if (Math.hypot(kx - cx, kz - cz) <= r + 4) continue
          if (store.peek(kx, kz)) store.drop(kx, kz)
        }
    }
    for (const [x, z] of wanted) {
      if (performance.now() - t0 > budget) break
      if (drawn.has(chunkKey(x, z))) continue
      build(x, z)
    }
    // the walker's boxes for the ring it may step into next, ahead of the
    // step (merging a chunk's is a few milliseconds; cached once made)
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if (performance.now() - t0 > budget) return
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
    for (const [kx, kz] of rings(cx, cz, r)) if (!drawn.has(chunkKey(kx, kz))) build(kx, kz)
    refreshBoxes(cx, cz)
  }
  {
    const s = spawnFor()
    prime(s.x, s.z, 3)
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
  }

  /* -------------------------------------------------------------- water -- */

  let waterNow: number | undefined
  const SEA_TOP = (SEA + 1) * B - 0.25
  const findWater = (p: THREE.Vector3, feetY: number) => {
    toBlock(p.x, feetY + 0.2, p.z, tmp)
    let y = tmp.y
    if (store.get(tmp.x, y, tmp.z) !== WATER) {
      // wading: the water is at the eye, not the feet
      if (store.get(tmp.x, Math.floor(p.y / B), tmp.z) !== WATER) return undefined
      y = Math.floor(p.y / B)
    }
    while (y < H - 1 && store.get(tmp.x, y + 1, tmp.z) === WATER) y++
    return (y + 1) * B - 0.25
  }

  /* -------------------------------------------------------------- level -- */

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
      held.visible = false
    },
    update: (dt, p) => {
      const cx = chunkOf(p.x)
      const cz = chunkOfZ(p.z)
      stream(cx, cz, 3.5)
      refreshBoxes(cx, cz)
      // (the lens is the walker's eye, 3.84 over the soles)
      waterNow = findWater(p, p.y - 3.84)
      settleFalling(dt)
      if (outbox.length) {
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

  return { root, level, store, net }
}
