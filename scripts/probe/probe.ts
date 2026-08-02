import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { buildChunk, type Chunk } from '../../src/game/world/chunk'
import { makeChunkMats } from '../../src/game/world/streamer'
import { chunkX, chunkZ } from '../../src/game/world/grid'
import { SEA_Y, sampleAt, terrainY } from '../../src/game/world/terrain'
import { landmarkIn, type LandmarkKind } from '../../src/game/world/landmarks'
import { placeAt, type District } from '../../src/game/world/settlements'
import { buildFauna, loadFaunaModels, type FaunaModels } from '../../src/game/world/fauna'
import { buildPedestrians } from '../../src/game/world/pedestrians'
import type { Solid } from '../../src/game/physics/collision'
import type { BiomeId } from '../../src/game/world/biomes'

/*
  The world, rendered off to one side so it can be photographed.

  This exists because `src/game/` is renderer-optional but not renderer-free:
  numbers you can get out of Node (see scripts/measure.mjs), but "does the new
  building kit look like a building" needs a camera, and booting the real site
  to get one costs a login, a boot sequence, a stand-up glide and a teleport,
  which is three or four minutes for one picture.

  This page is a scene, a camera and nothing else. Everything it draws it
  builds from `buildChunk` with the *real* materials out of `makeChunkMats`,
  which is the one rule that matters in here. A probe that hand-rolls its own
  MeshStandardMaterials leaves out the leaf texture's alpha test and the
  procedural surface pass, and then every tree renders as a green slab and
  every wall as a grey rectangle. One shot taken that way is indistinguishable
  from a real regression, and it cost most of a conversation.

  Two things it deliberately does not have. There is no walker, no physics and
  no day cycle: the light rig below is CrtScene's numbers pinned at whatever
  `tod` was asked for. And there is no streaming, just a fixed neighbourhood
  of chunks built once, because a probe that streams has the reused-renderer
  ghosting problem the notes warn about, where late-built chunk geometry draws
  nothing at all and impersonates whatever you just changed.
*/

export type Tod = number

export interface Target {
  /** what to look at */
  kind: 'at' | 'biome' | 'landmark' | 'town' | 'home'
  arg?: string
  x?: number
  z?: number
}

export interface ShotSpec {
  targets: Target[]
  /** tile size in pixels */
  tile: [number, number]
  /** columns; rows follow from the target count */
  cols: number
  /** how far the camera stands back, and how high. `eye` overrides both with
      a walker's own eye line, which is the only honest way to judge scale */
  dist: number
  height: number
  eye: boolean
  /** compass bearing of the camera around the target, in radians */
  yaw: number
  /** 0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk */
  tod: Tod
  /** chunk rings around each target; 1 is a 3x3, which reaches 96 units */
  rings: number
  /** 'full' | 'flora' | 'bare' */
  tier: 'full' | 'flora' | 'bare'
  /** GLBs to stand in the shot, for judging a candidate model against the
      world's own shading before any of it is wired into the runtime */
  props?: Prop[]
  /** seconds of fauna and pedestrians to simulate into the tile before the
      shutter opens. Both systems place themselves around the *camera* at a
      range sized for fog, so the probe shrinks that ring to the frame; what
      is photographed is otherwise the live system, wandering, grazing and
      following the pavement exactly as it does in the world */
  life?: number
}

export interface Prop {
  url: string
  /** offset from the target, in world units */
  dx: number
  dz: number
  /** heading in radians, and a uniform scale */
  yaw: number
  scale: number
  /** an animation clip to freeze, and where in it. A bind pose is not what
      the thing looks like in the world; a walk cycle at 0.4s is */
  clip?: string
  t: number
}

export interface ShotResult {
  label: string
  x: number
  z: number
  y: number
  biome: BiomeId
  district: District | null
  verts: number
  /** what `life` put in the tile, so an empty street is distinguishable
      from a street whose crowd all spawned behind the camera */
  animals?: number
  people?: number
}

/* ------------------------------------------------------------- searching -- */

/** walk outward on a coarse spiral until a predicate holds. Deterministic, so
    the same query always frames the same place and two runs are comparable */
const search = (
  from: [number, number], ok: (x: number, z: number) => boolean, step = 48,
) => {
  for (let r = 0; r < 260; r++) {
    const n = Math.max(1, r * 6)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = from[0] + Math.cos(a) * r * step
      const z = from[1] + Math.sin(a) * r * step
      if (ok(x, z)) return [x, z] as const
    }
  }
  return from
}

const resolve = (t: Target): { x: number; z: number; label: string } => {
  if (t.kind === 'home') return { x: 0, z: 34, label: 'home' }
  if (t.kind === 'at') return { x: t.x ?? 0, z: t.z ?? 0, label: `${t.x},${t.z}` }
  if (t.kind === 'biome') {
    const want = t.arg as BiomeId
    const [x, z] = search([0, -1200], (px, pz) => {
      const s = sampleAt(px, pz)
      return s.biome === want && !s.place.district
    })
    return { x, z, label: `biome:${want}` }
  }
  if (t.kind === 'town') {
    const want = t.arg as District
    const [x, z] = search([0, -340], (px, pz) => placeAt(px, pz).district === want, 24)
    return { x, z, label: `town:${want}` }
  }
  const want = t.arg as LandmarkKind
  const hit = landmarkRings((lm) => lm.kind === want, 1)[0]
  return hit ?? { x: 0, z: 0, label: `landmark:${want} NOT FOUND` }
}

/**
 * Landmarks nearest the house, in growing square rings around chunk (0, 0).
 *
 * Ring order, not row order, and that is not fussiness: scanning cz from
 * -180 upward finds whatever happens to be eleven kilometres south first, so
 * every tile of a `landmark:*` sheet came from the same distant latitude
 * band and none of them were anywhere you would actually walk.
 */
const landmarkRings = (
  ok: (lm: NonNullable<ReturnType<typeof landmarkIn>>) => boolean,
  limit: number,
) => {
  const out: Array<{ x: number; z: number; label: string }> = []
  const seen = new Set<LandmarkKind>()
  for (let r = 0; r < 200 && out.length < limit; r++) {
    for (let i = -r; i <= r && out.length < limit; i++)
      for (const [cx, cz] of (r === 0
        ? [[0, 0]]
        : [[i, -r], [i, r], [-r, i], [r, i]]) as Array<[number, number]>) {
        const lm = landmarkIn(cx, cz)
        if (!lm || seen.has(lm.kind) || !ok(lm)) continue
        seen.add(lm.kind)
        out.push({ x: lm.x, z: lm.z, label: `landmark:${lm.kind}` })
      }
  }
  return out
}

/** one of every landmark kind, each the nearest of its type. `landmark:*` */
const resolveAllLandmarks = () => landmarkRings(() => true, 9)

/* --------------------------------------------------------------- the rig -- */

/** CrtScene's own roam numbers, pinned at a time of day instead of animated.
    Copied rather than imported because sky.ts drives them off a live clock
    and a mounted scene graph; the constants are what matter here. */
const HEMI_SKY_DAY = new THREE.Color('#cfe2f2')
const HEMI_GROUND_DAY = new THREE.Color('#5f6a52')
const HEMI_SKY_NIGHT = new THREE.Color('#5a6678')
const HEMI_GROUND_NIGHT = new THREE.Color('#241d16')
const SUN_LOW = new THREE.Color('#ffb066')
const SUN_HIGH = new THREE.Color('#fff2dc')
const FOG_NIGHT = new THREE.Color('#0d1220')
const FOG_DAY = new THREE.Color('#a9c0d4')

const lightFor = (scene: THREE.Scene, tod: Tod, at: THREE.Vector3) => {
  // elevation of the sun over the horizon, 0 at dawn/dusk, 1 at noon
  const sunEl = Math.sin((tod - 0.25) * Math.PI * 2)
  const day = Math.max(0, Math.min(1, sunEl * 3))
  const dayBoost = 1 + 2.1 * day
  const hemi = new THREE.HemisphereLight(
    HEMI_SKY_NIGHT.clone().lerp(HEMI_SKY_DAY, day),
    HEMI_GROUND_NIGHT.clone().lerp(HEMI_GROUND_DAY, day),
    1.5 * dayBoost,
  )
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(
    SUN_LOW.clone().lerp(SUN_HIGH, Math.max(0, Math.min(1, sunEl * 1.6))),
    2.3 * Math.pow(Math.max(0, sunEl), 0.65),
  )
  const a = (tod - 0.25) * Math.PI * 2
  sun.position.set(at.x + Math.cos(a) * 60, at.y + Math.max(0.02, sunEl) * 60, at.z + 12.6)
  sun.target.position.copy(at)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.5
  const c = sun.shadow.camera
  c.left = -70; c.right = 70; c.top = 70; c.bottom = -70; c.near = 1; c.far = 220
  c.updateProjectionMatrix()
  scene.add(sun, sun.target)
  const fog = FOG_NIGHT.clone().lerp(FOG_DAY, day)
  scene.fog = new THREE.Fog(fog, 26 + day * 30, 176 + day * 64)
  scene.background = fog.clone().lerp(new THREE.Color('#ffffff'), 0.12)
}

/* ----------------------------------------------------------------- props -- */

/*
  A GLB standing on the terrain, so a candidate asset can be judged against
  the world's real light rig and fog rather than against a turntable render.

  Loading is a separate, awaited step because `shoot` is synchronous and its
  one job is to build and draw in a single frame. Clips are sampled rather
  than played: a still frame of a bind pose says nothing about whether a
  walk cycle reads at fifty metres.
*/
const loaded = new Map<string, THREE.Group>()

export const preload = async (urls: string[]) => {
  const loader = new GLTFLoader()
  const out: Record<string, { clips: string[]; verts: number; size: number[] }> = {}
  for (const url of urls) {
    const gltf = await loader.loadAsync(url)
    const root = gltf.scene
    root.animations = gltf.animations
    loaded.set(url, root)
    let verts = 0
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) verts += m.geometry.getAttribute('position').count
    })
    const box = new THREE.Box3().setFromObject(root)
    const s = box.getSize(new THREE.Vector3())
    out[url] = {
      clips: gltf.animations.map((a) => a.name),
      verts,
      size: [s.x, s.y, s.z].map((n) => Math.round(n * 100) / 100),
    }
  }
  return out
}

const addProps = (scene: THREE.Scene, x: number, z: number, props: Prop[]) => {
  for (const p of props) {
    const src = loaded.get(p.url)
    if (!src) continue
    const obj = cloneSkinned(src) as THREE.Group
    if (src.animations.length) {
      const clip = p.clip
        ? src.animations.find((a) => a.name.toLowerCase() === p.clip!.toLowerCase())
        : src.animations[0]
      if (clip) {
        const mixer = new THREE.AnimationMixer(obj)
        mixer.clipAction(clip).play()
        mixer.update(p.t)
      }
    }
    const px = x + p.dx
    const pz = z + p.dz
    obj.position.set(px, terrainY(px, pz), pz)
    obj.rotation.y = p.yaw
    obj.scale.setScalar(p.scale)
    obj.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true }
    })
    scene.add(obj)
  }
}

/* ------------------------------------------------------------------ life -- */

/*
  The things that move: world/fauna.ts and world/pedestrians.ts, built into
  the tile and ticked forward before the shutter opens.

  Neither is world state, so neither exists in a chunk and neither would ever
  appear in a shot taken the old way — which is precisely why they need to be
  photographable: a grazing animation and a walk cycle are the two things a
  number cannot tell you about. The simulation here is the real module, not a
  stand-in; only the spawn ring is shrunk, because both are sized so that a
  re-cut happens out where the fog hides it and this frame is fifty units
  wide.
*/
let faunaModels: FaunaModels | null = null

export const loadLife = async () => {
  faunaModels ??= await loadFaunaModels()
  return Object.keys(faunaModels)
}

const addLife = (
  scene: THREE.Scene, x: number, z: number, gy: number, seconds: number,
  obstacles: Solid[],
) => {
  const noop = () => {}
  const fauna = buildFauna({
    parent: scene, obstacles, trackDisposable: noop, ring: { near: 14, spread: 26 },
  })
  const faunaRoot = scene.children[scene.children.length - 1]
  if (faunaModels) fauna.setModels(faunaModels)
  const crowd = buildPedestrians({
    parent: scene,
    obstacles,
    groundAt: terrainY,
    trackDisposable: noop,
    ring: { near: 8, spread: 20 },
  })
  const crowdRoot = scene.children[scene.children.length - 1]
  // the camera stands at the target, so this is the pose everything places
  // itself against — including the flee radius, which is why the herd is
  // photographed a few seconds in rather than on its first frame
  const at = new THREE.Vector3(x, gy, z)
  const dt = 1 / 30
  for (let t = 0; t < seconds; t += dt) {
    fauna.update(at, dt)
    crowd.update(at, dt)
  }
  // each builder appends exactly one root to the scene, in this order, and
  // a live member of either is a visible child of it
  const live = (root: THREE.Object3D | undefined) =>
    root ? root.children.filter((c) => c.visible).length : 0
  return {
    animals: live(faunaRoot),
    people: live(crowdRoot),
  }
}

/* ---------------------------------------------------------------- shoot -- */

let renderer: THREE.WebGLRenderer | null = null
/** the built tiles of the last shot, so `pick` can raycast into them */
let tiles: Array<{ scene: THREE.Scene; cam: THREE.Camera; chunks: Chunk[] }> = []

const disposeTiles = () => {
  for (const t of tiles) for (const c of t.chunks) for (const g of c.geos) g.dispose()
  tiles = []
}

export const shoot = (spec: ShotSpec): ShotResult[] => {
  const canvas = document.getElementById('c') as HTMLCanvasElement
  const list = spec.targets.length === 1 && spec.targets[0].kind === 'landmark'
    && spec.targets[0].arg === '*'
    ? resolveAllLandmarks()
    : spec.targets.map(resolve)
  const cols = Math.min(spec.cols, list.length)
  const rows = Math.ceil(list.length / cols)
  const [tw, th] = spec.tile
  canvas.width = tw * cols
  canvas.height = th * rows

  // a fresh renderer per shot, deliberately. A reused one ghosts late-built
  // chunk geometry: valid, raycastable, in the scene, and drawing nothing,
  // which impersonates exactly the feature you just changed
  renderer?.dispose()
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(1)
  renderer.setSize(canvas.width, canvas.height, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setScissorTest(true)

  disposeTiles()
  const keep: THREE.Texture[] = []
  const mats = makeChunkMats((t) => keep.push(t), () => {})
  // the streamer fades a chunk in over its baked birth stamp and holds the
  // glass at zero opacity by day; a still frame wants both settled
  ;(mats.glass as THREE.MeshBasicMaterial).opacity =
    spec.tod < 0.22 || spec.tod > 0.78 ? 1 : 0

  const out: ShotResult[] = []
  for (let i = 0; i < list.length; i++) {
    const { x, z, label } = list[i]
    const scene = new THREE.Scene()
    const gy = terrainY(x, z)
    lightFor(scene, spec.tod, new THREE.Vector3(x, gy, z))

    const c0 = chunkX(x)
    const d0 = chunkZ(z)
    const chunks: Chunk[] = []
    // the tile's own solids, so the crowd and the herd argue with the same
    // walls the shot is showing rather than walking through them
    const boxes: Solid[] = []
    let verts = 0
    for (let dz = -spec.rings; dz <= spec.rings; dz++)
      for (let dx = -spec.rings; dx <= spec.rings; dx++) {
        const c = buildChunk(c0 + dx, d0 + dz, spec.tier, mats)
        c.group.traverse((o) => {
          const m = o as THREE.Mesh
          if (m.isMesh) { m.castShadow = true; m.receiveShadow = true }
        })
        chunks.push(c)
        for (const b of c.boxes) boxes.push(b)
        scene.add(c.group)
        for (const g of c.geos) verts += g.getAttribute('position').count
      }

    if (spec.props?.length) addProps(scene, x, z, spec.props)
    const life = spec.life ? addLife(scene, x, z, gy, spec.life, boxes) : null

    const cam = new THREE.PerspectiveCamera(spec.eye ? 58 : 42, tw / th, 0.2, 900)
    if (spec.eye) {
      cam.position.set(x, gy + 3.55, z)
      cam.lookAt(x + Math.sin(spec.yaw) * 20, gy + 2.0, z + Math.cos(spec.yaw) * 20)
    } else {
      cam.position.set(
        x + Math.cos(spec.yaw) * spec.dist, gy + spec.height,
        z + Math.sin(spec.yaw) * spec.dist)
      cam.lookAt(x, gy + spec.height * 0.32, z)
    }
    tiles.push({ scene, cam, chunks })

    const col = i % cols
    const row = Math.floor(i / cols)
    const px = col * tw
    const py = canvas.height - (row + 1) * th
    renderer.setViewport(px, py, tw, th)
    renderer.setScissor(px, py, tw, th)
    renderer.render(scene, cam)

    const s = sampleAt(x, z)
    out.push({
      label, x: Math.round(x), z: Math.round(z), y: Math.round(gy * 10) / 10,
      biome: s.biome, district: s.place.district,
      verts: Math.round(verts / chunks.length),
      animals: life?.animals,
      people: life?.people,
    })
  }
  return out
}

/**
 * What is under a pixel of the last shot. A screenshot tells you *that*
 * something is wrong; this tells you what, and for merged chunk geometry it
 * is the only handle there is, since every wall, kerb and trunk in a chunk is
 * one mesh that cannot be toggled or named.
 */
export const pick = (tile: number, px: number, py: number) => {
  const t = tiles[tile]
  if (!t) return { error: `no tile ${tile}` }
  const [tw, th] = [
    (document.getElementById('c') as HTMLCanvasElement).width / Math.max(1, tiles.length),
    (document.getElementById('c') as HTMLCanvasElement).height,
  ]
  const ray = new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2((px / tw) * 2 - 1, -(py / th) * 2 + 1), t.cam)
  const hits = ray.intersectObjects(t.scene.children, true).slice(0, 6)
  const col = new THREE.Color()
  return hits.map((h) => {
    const m = h.object as THREE.Mesh
    const g = m.geometry
    const attr = g.getAttribute('color')
    if (attr && h.face) col.fromBufferAttribute(attr as THREE.BufferAttribute, h.face.a)
    return {
      dist: Math.round(h.distance * 100) / 100,
      point: [h.point.x, h.point.y, h.point.z].map((n) => Math.round(n * 100) / 100),
      normal: h.face
        ? [h.face.normal.x, h.face.normal.y, h.face.normal.z].map((n) => Math.round(n * 100) / 100)
        : null,
      vertexColor: attr ? `#${col.getHexString()}` : null,
      material: (m.material as THREE.Material).type,
      aboveGround: Math.round((h.point.y - terrainY(h.point.x, h.point.z)) * 100) / 100,
      underwater: h.point.y < SEA_Y,
    }
  })
}
