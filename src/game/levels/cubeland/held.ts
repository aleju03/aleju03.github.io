import * as THREE from 'three'
import { BLOCKS, paintTexture, textureIndex, type BlockDef } from '../../sandbox/blocks'
import { PREBORN } from '../../world/fade'
import { CHUNK, H, idx } from './gen'
import { heldMaterial } from './material'
import { LIGHT } from './mesher'
import type { VoxelStore } from './world'

/*
  What Cubeland's bare hands hold, in first person: the block (or the item)
  in the lower right of the view, drawn and moved the way the famous game
  draws and moves it.

  **Laid out in that game's own numbers.** Its hand is a pose in view units
  where a block is one unit: the item 0.56 right, 0.52 down and 0.72 ahead of
  the eye, a block turned 45 degrees about the vertical and scaled to 0.4
  (here a little smaller and higher, see `BLOCK_POSE`), so that from above
  and to the left of it you see its top and two sides, and an
  item (a torch, a bucket) as its flat painting at 0.68, stood on edge and
  leant over. Those numbers are used as they are, through two scales: the
  whole pose shrunk about the eye (`SCALE`, which no screen can see, only the
  near plane can), and its sideways and vertical offsets stretched by the
  ratio of this lens's half-angle tangent to that game's 70 degrees, which is
  how it holds the item the same size in the same corner at any fov and
  while a sprint widens the lens.

  **Drawn as the ground is.** The geometry is the mesher's vertex format and
  the material is the terrain's own shader over the same array texture
  (material.ts's `heldMaterial`), so a grass block in hand has the ground's
  grass top, its dirt sides and its bottom, painted to the pixel, and see-
  through pixels are cut as they are in the ground (a glass block shows its
  inner faces through its gaps). It is lit like the ground under your feet:
  every face takes the sun and the sky as a top face would, times a fixed
  shade per face (top full, the side to the eye's left a step down, the one
  to its right two, the underside half), times the sky light where the eye
  is, with the block light of the nearest lamp added as the terrain adds it.
  So it dims walking into a cave and warms beside a torch, and its three
  faces keep their order whichever way you face. Glowing blocks and a
  torch's flame are lit by the glow flag, as there. Its depth is squeezed to
  the front of the range, like the gun's, so it is never inside a wall.

  **Items** (anything that is not a cube: the torch and the two buckets)
  are the painting with thickness, the way the game draws an item: a quad
  front and back for each solid pixel and an edge wherever a solid pixel
  meets an empty one, each at the pixel's own colour, so the outline pass
  sees a sixteenth of a block of depth all round it. The buckets' paintings
  exist only for this (sandbox/blocks.ts's `bucket_*`); the flowers and the
  tall grass never reach the hands (they are not in the catalogue).

  **Motion**, all of it the game's own, per tick turned into per second:
  - the walk bob, the figure eight the item traces while you walk: across on
    sin(phase) and down on -|cos(phase)|, with a small roll and nod, scaled
    by how fast you go and eased in and out (0.4 a tick) so it settles when
    you stop. The phase is the walk's own step clock (walkController's
    `stride`), a half turn to a step and offset so the item bottoms out on
    the same frame a footstep sounds;
  - the lag when you turn: the item is aimed at where the view was a moment
    ago (a pitch and yaw chasing the real ones at half the gap a tick) and
    turned a tenth of the gap, so it trails a turn and swings back;
  - the swing on every break or place: six ticks of the arm's arc down and
    in and back, restarted only past its middle, as there;
  - the change of item: the old one sinks out of the frame, the new one
    rises into it.

  Headless-safe: plain geometry and matrices; nothing here touches a
  renderer, and the light is read straight out of the voxel store.
*/

const DEG = Math.PI / 180
/** the lens the game's hand was laid out through */
const REF_TAN = Math.tan(35 * DEG)
/** view units (a block is one) to world units, about the eye: at 0.6 the
    nearest corner of a swinging block stays well clear of the near plane */
const SCALE = 0.6
/** the swing: six ticks */
const SWING_S = 0.3
/** how fast the item sinks out and rises in, of its travel a second */
const EQUIP_RATE = 8
/** a tick of the game's easing, as a rate: `1 - k ** (dt * 20)` */
const tickEase = (k: number, dt: number) => 1 - Math.pow(k, dt * 20)

/** the display poses: a block turned to show three faces, an item on edge.
    The item's is the game's to the number. The block's is its turn with the
    block a touch smaller (0.36 for 0.4) and lifted up and in by 0.06: at
    the game's own numbers the cube's centre sits on the bottom edge of the
    frame and its front corner lands just off it (and, on a 16:9 screen, off
    the right edge too), so all you see is a big rhombus of top face; this
    way the front edge and both sides come into the corner */
const BLOCK_POSE = new THREE.Matrix4().compose(
  new THREE.Vector3(-0.06, 0.06, 0),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 45 * DEG, 0, 'XYZ')),
  new THREE.Vector3(0.36, 0.36, 0.36),
)
const ITEM_POSE = new THREE.Matrix4().compose(
  new THREE.Vector3(1.13 / 16, 3.2 / 16, 1.13 / 16),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -90 * DEG, 25 * DEG, 'XYZ')),
  new THREE.Vector3(0.68, 0.68, 0.68),
)

/** the painting a kind is held as when it is an item, not a cube */
const itemPainting = (def: BlockDef): string | null =>
  def.shape === 'torch' ? def.side : def.liquid ? `bucket_${def.fluid}` : null

/* ------------------------------------------------------------- geometry -- */

interface Held {
  geo: THREE.BufferGeometry
  /** each vertex's colour before the sky light, at the mesher's half scale */
  base: Float32Array
  item: boolean
}

const builder = () => {
  const pos: number[] = []
  const nor: number[] = []
  const tex: number[] = []
  const col: number[] = []
  const blk: number[] = []
  const index: number[] = []
  /** a quad, corners counter-clockwise from outside; `uv` per corner in
      0..1 of the painting, v down it */
  const quad = (c: number[][], n: readonly number[], uv: number[][], shade: number, layer: number, glow: boolean) => {
    const b = pos.length / 3
    for (let k = 0; k < 4; k++) {
      pos.push(c[k][0], c[k][1], c[k][2])
      nor.push(n[0], n[1], n[2])
      tex.push(uv[k][0] * 16, uv[k][1] * 16)
      col.push(shade * 0.5, shade * 0.5, shade * 0.5)
      blk.push(layer, glow ? 1 : 0, 15, 0)
    }
    index.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  const take = (item: boolean): Held => {
    const g = new THREE.BufferGeometry()
    const n = pos.length / 3
    const base = new Float32Array(col)
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
    g.setAttribute('aTex', new THREE.Float32BufferAttribute(tex, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    g.setAttribute('aBlk', new THREE.Float32BufferAttribute(blk, 4))
    g.setAttribute('aBirth', new THREE.Float32BufferAttribute(new Float32Array(n).fill(PREBORN), 1))
    g.setIndex(index)
    g.computeBoundingSphere()
    return { geo: g, base, item }
  }
  return { quad, take }
}

/* a cube's six faces: the normal, the face's right and up as seen from
   outside (right x up = normal), which painting, and the shade it is held
   in. Turned 45 degrees in the hand, -x is the side on the eye's left and
   +z the one on its right */
const FACES: ReadonlyArray<{ n: readonly number[]; r: readonly number[]; u: readonly number[]; tex: 'top' | 'side' | 'bottom'; shade: number }> = [
  { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1], tex: 'top', shade: 1 },
  { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1], tex: 'bottom', shade: 0.5 },
  { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0], tex: 'side', shade: 0.8 },
  { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], tex: 'side', shade: 0.62 },
  { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0], tex: 'side', shade: 0.62 },
  { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0], tex: 'side', shade: 0.8 },
]
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
const FACE_UV = [[0, 1], [1, 1], [1, 0], [0, 0]]

/** a block: a unit cube round the origin, each face its own painting */
const cube = (def: BlockDef): Held => {
  const b = builder()
  const glow = !!def.glow
  for (const f of FACES) {
    const layer = textureIndex.get(def[f.tex]) ?? 0
    const c = CORNERS.map(([i, j]) => [0, 1, 2].map((a) => f.n[a] * 0.5 + f.r[a] * 0.5 * i + f.u[a] * 0.5 * j))
    b.quad(c, f.n, FACE_UV, f.shade, layer, glow)
    // see-through pixels (glass, leaves) show the far faces from inside
    if (!def.opaque) {
      const inside = [c[1], c[0], c[3], c[2]]
      b.quad(inside, f.n.map((v) => -v), [FACE_UV[1], FACE_UV[0], FACE_UV[3], FACE_UV[2]], f.shade * 0.7, layer, glow)
    }
  }
  return b.take(false)
}

/** an item: its painting a sixteenth of a block thick, pixel by pixel */
const item = (def: BlockDef, name: string): Held => {
  const b = builder()
  const d = paintTexture(name)
  const layer = textureIndex.get(name) ?? 0
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < 16 && y < 16 && d[(y * 16 + x) * 4 + 3] >= 128
  const t = 1 / 32
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      if (!solid(x, y)) continue
      const i = (y * 16 + x) * 4
      const [r, g, bl] = [d[i], d[i + 1], d[i + 2]]
      // what is light: a torch's flame, a lava bucket's lava
      const glow = def.fluid === 'lava' ? r - bl > 120 : def.shape === 'torch' ? r + g >= 330 : !!def.glow
      // one texel's centre on every corner: the pixel, whatever the filter
      const uv = [(x + 0.5) / 16, (y + 0.5) / 16]
      const uvs = [uv, uv, uv, uv]
      const x0 = x / 16 - 0.5
      const x1 = x0 + 1 / 16
      const y1 = 0.5 - y / 16
      const y0 = y1 - 1 / 16
      b.quad([[x0, y0, t], [x1, y0, t], [x1, y1, t], [x0, y1, t]], [0, 0, 1], uvs, 0.95, layer, glow)
      b.quad([[x1, y0, -t], [x0, y0, -t], [x0, y1, -t], [x1, y1, -t]], [0, 0, -1], uvs, 0.7, layer, glow)
      if (!solid(x - 1, y)) b.quad([[x0, y0, -t], [x0, y0, t], [x0, y1, t], [x0, y1, -t]], [-1, 0, 0], uvs, 0.75, layer, glow)
      if (!solid(x + 1, y)) b.quad([[x1, y0, t], [x1, y0, -t], [x1, y1, -t], [x1, y1, t]], [1, 0, 0], uvs, 0.75, layer, glow)
      if (!solid(x, y - 1)) b.quad([[x0, y1, t], [x1, y1, t], [x1, y1, -t], [x0, y1, -t]], [0, 1, 0], uvs, 1, layer, glow)
      if (!solid(x, y + 1)) b.quad([[x0, y0, -t], [x1, y0, -t], [x1, y0, t], [x0, y0, t]], [0, -1, 0], uvs, 0.55, layer, glow)
    }
  return b.take(true)
}

/* ---------------------------------------------------------------- light -- */

const EMIT = new Uint8Array(256)
for (const b of BLOCKS) EMIT[b.id] = b.light ?? 0
/** how far a lamp is looked for (its level falls one a block, so one
    further off adds a few levels at most, which the terrain's curve makes
    all but nothing) */
const LAMP_R = 10

/** the sky light the eye's cell sees, by the mesher's rule (mesher.ts's
    `skyAt`): open sky, sky spilling in from a neighbouring column, or under
    ground, darker every three blocks down */
const skyAt = (store: VoxelStore, bx: number, by: number, bz: number) => {
  const top = (x: number, z: number) => {
    const cx = Math.floor(x / CHUNK)
    const cz = Math.floor(z / CHUNK)
    return store.chunk(cx, cz).top[x - cx * CHUNK + (z - cz * CHUNK) * CHUNK]
  }
  const t = top(bx, bz)
  if (by > t) return 15
  const lo = Math.min(t, top(bx - 1, bz), top(bx + 1, bz), top(bx, bz - 1), top(bx, bz + 1))
  if (by > lo) return 12
  return Math.max(2, 11 - Math.floor((lo - by) / 3) * 3)
}

/** the block light at the eye's cell: the brightest lamp near it, less a
    level a block of the way there. Straight through walls, unlike the
    mesher's flood, which a hand held beside a wall never notices */
const lampAt = (store: VoxelStore, bx: number, by: number, bz: number) => {
  let best = 0
  const y0 = Math.max(0, by - LAMP_R)
  const y1 = Math.min(H - 1, by + LAMP_R)
  for (let cz = Math.floor((bz - LAMP_R) / CHUNK); cz <= Math.floor((bz + LAMP_R) / CHUNK); cz++)
    for (let cx = Math.floor((bx - LAMP_R) / CHUNK); cx <= Math.floor((bx + LAMP_R) / CHUNK); cx++) {
      const c = store.peek(cx, cz)
      if (!c) continue
      const lx0 = Math.max(0, bx - LAMP_R - cx * CHUNK)
      const lx1 = Math.min(CHUNK - 1, bx + LAMP_R - cx * CHUNK)
      const lz0 = Math.max(0, bz - LAMP_R - cz * CHUNK)
      const lz1 = Math.min(CHUNK - 1, bz + LAMP_R - cz * CHUNK)
      for (let y = y0; y <= y1; y++)
        for (let z = lz0; z <= lz1; z++)
          for (let x = lx0; x <= lx1; x++) {
            const e = EMIT[c.vox[idx(x, y, z)]]
            if (e <= best) continue
            const l = e - Math.abs(cx * CHUNK + x - bx) - Math.abs(y - by) - Math.abs(cz * CHUNK + z - bz)
            if (l > best) best = l
          }
    }
  return best
}

/* ----------------------------------------------------------------- hand -- */

export interface HeldFrame {
  camera: THREE.PerspectiveCamera
  dt: number
  /** the kind in hand (`block_<key>`) */
  kind: string
  /** the block the eye is in, for its light */
  bx: number
  by: number
  bz: number
  /** 0..1 of the walk's speed; the walk's step clock (a footstep at .75);
      on the ground (see HandsFrame) */
  gait: number
  stride: number
  grounded: boolean
}

export interface HeldItem {
  mesh: THREE.Mesh
  update: (f: HeldFrame) => void
  /** a break or a place: the arm's arc */
  swing: () => void
  /** out of sight; it rises back in the next time it is shown */
  hide: () => void
}

export function createHeldItem(o: {
  store: VoxelStore
  blockOf: (kind: string) => BlockDef | undefined
  trackDisposable: (d: { dispose: () => void }) => void
  /** what is in hand to begin with: its geometry is on the mesh from the
      start, so the map's covered compile and first draw see the real thing */
  first: string
}): HeldItem {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), heldMaterial())
  mesh.name = 'cube-held'
  mesh.userData.dynamic = true
  mesh.matrixAutoUpdate = false
  mesh.frustumCulled = false
  mesh.castShadow = false
  // (in the sun's shadow where the eye is, as the ground there is)
  mesh.receiveShadow = true

  const built = new Map<string, Held | null>()
  const heldOf = (kind: string): Held | null => {
    if (built.has(kind)) return built.get(kind) ?? null
    const def = o.blockOf(kind)
    const name = def && itemPainting(def)
    const h = !def ? null : name ? item(def, name) : cube(def)
    if (h) o.trackDisposable(h.geo)
    built.set(kind, h)
    return h
  }

  let shown = ''
  let cur: Held | null = null
  const firstGeo = heldOf(o.first)
  if (firstGeo) mesh.geometry = firstGeo.geo
  /** 0 up in the hand .. 1 sunk out of the frame */
  let equip = 1
  /** the swing, 0..1, and whether one is running */
  let swingP = 0
  let swinging = false
  let bob = 0
  let lagYaw = 0
  let lagPitch = 0
  let hasLag = false
  // the light at the eye, re-read when the eye changes block or now and then
  let sky = -1
  let lamp = -1
  let lightKey = NaN
  let lightIn = 0
  const lit = { sky: 15, lamp: 0 }

  const applyLight = () => {
    if (!cur) return
    const col = cur.geo.getAttribute('color') as THREE.BufferAttribute
    const blk = cur.geo.getAttribute('aBlk') as THREE.BufferAttribute
    const k = LIGHT[lit.sky]
    const c = col.array as Float32Array
    for (let i = 0; i < c.length; i++) c[i] = cur.base[i] * k
    const a = blk.array as Float32Array
    for (let v = 0; v < blk.count; v++) {
      a[v * 4 + 2] = lit.sky
      a[v * 4 + 3] = lit.lamp
    }
    col.needsUpdate = true
    blk.needsUpdate = true
    sky = lit.sky
    lamp = lit.lamp
  }

  const eul = new THREE.Euler()
  const M = new THREE.Matrix4()
  const T = new THREE.Matrix4()
  const inv = new THREE.Matrix4()
  const ONE = new THREE.Vector3(1, 1, 1)

  const update = (f: HeldFrame) => {
    const dt = Math.max(0, Math.min(0.05, f.dt))
    const cam = f.camera

    // the item: the old one sinks out, the new one is swapped in and rises
    if (f.kind !== shown) {
      equip = Math.min(1, equip + dt * EQUIP_RATE)
      if (equip >= 1 || !cur) {
        shown = f.kind
        cur = heldOf(f.kind)
        if (cur) mesh.geometry = cur.geo
        sky = -1
      }
    } else equip = Math.max(0, equip - dt * EQUIP_RATE)
    mesh.visible = !!cur
    if (!cur) return

    // the light where the eye is
    lightIn -= dt
    const key = (f.bx * 4096 + f.bz) * 128 + f.by
    if (key !== lightKey || lightIn <= 0) {
      lightKey = key
      lightIn = 0.25
      lit.sky = f.by >= H ? 15 : f.by < 0 ? 2 : skyAt(o.store, f.bx, f.by, f.bz)
      lit.lamp = lampAt(o.store, f.bx, f.by, f.bz)
    }
    if (lit.sky !== sky || lit.lamp !== lamp) applyLight()

    // the swing
    if (swinging) {
      swingP += dt / SWING_S
      if (swingP >= 1) {
        swingP = 0
        swinging = false
      }
    }
    // the bob: its size eased toward the walk's, its phase the step clock
    // (a half turn a step, bottoming out at the footfall, which is .75)
    bob += ((f.grounded ? 0.1 * Math.min(1, f.gait) : 0) - bob) * tickEase(0.6, dt)
    const ph = -Math.PI * (f.stride + 0.25)
    // the lag: a view chasing the real one at half the gap a tick
    eul.setFromQuaternion(cam.quaternion, 'YXZ')
    if (!hasLag) {
      lagYaw = eul.y
      lagPitch = eul.x
      hasLag = true
    }
    let dYaw = eul.y - lagYaw
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw))
    const dPitch = eul.x - lagPitch
    const ease = tickEase(0.5, dt)
    lagYaw += dYaw * ease
    lagPitch += dPitch * ease

    // the pose, outermost first: the lens, the fov, the bob, the lag, the
    // swing's reach, the hand, the swing's turn, the display pose
    const k = Math.tan((cam.fov * DEG) / 2) / REF_TAN
    M.compose(cam.position, cam.quaternion, ONE)
    M.multiply(T.makeScale(SCALE * k, SCALE * k, SCALE))
    M.multiply(T.makeTranslation(Math.sin(ph) * bob * 0.5, -Math.abs(Math.cos(ph) * bob), 0))
    M.multiply(T.makeRotationZ(Math.sin(ph) * bob * 3 * DEG))
    M.multiply(T.makeRotationX(Math.abs(Math.cos(ph - 0.2) * bob) * 5 * DEG))
    M.multiply(T.makeRotationX(-(eul.x - lagPitch) * 0.1))
    M.multiply(T.makeRotationY(-(eul.y - lagYaw) * 0.1))
    const p = swingP
    const sq = Math.sqrt(p)
    const arc = Math.sin(sq * Math.PI)
    M.multiply(T.makeTranslation(-0.4 * arc, 0.2 * Math.sin(sq * Math.PI * 2), -0.2 * Math.sin(p * Math.PI)))
    M.multiply(T.makeTranslation(0.56, -0.52 - 0.6 * equip, -0.72))
    M.multiply(T.makeRotationY((45 - 20 * Math.sin(p * p * Math.PI)) * DEG))
    M.multiply(T.makeRotationZ(-20 * arc * DEG))
    M.multiply(T.makeRotationX(-80 * arc * DEG))
    M.multiply(T.makeRotationY(-45 * DEG))
    M.multiply(cur.item ? ITEM_POSE : BLOCK_POSE)
    mesh.matrixWorld.copy(M)
    if (mesh.parent) mesh.matrix.copy(inv.copy(mesh.parent.matrixWorld).invert().multiply(M))
    else mesh.matrix.copy(M)
  }

  return {
    mesh,
    update,
    swing: () => {
      // as there: a click mid-swing only restarts it past its middle
      if (!swinging || swingP >= 0.5) {
        swingP = 0
        swinging = true
      }
    },
    hide: () => {
      mesh.visible = false
      equip = 1
      hasLag = false
      swinging = false
      swingP = 0
    },
  }
}
