import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { buildChunk, type Chunk } from '../../src/game/world/chunk'
import { buildWorld, makeChunkMats, tintWater } from '../../src/game/world/streamer'
import { chunkX, chunkZ } from '../../src/game/world/grid'
import { SEA_Y, sampleAt, terrainY } from '../../src/game/world/terrain'
import { landmarkIn, type LandmarkKind } from '../../src/game/world/landmarks'
import { placeAt, type District } from '../../src/game/world/settlements'
import { buildFauna, loadFaunaModels, type FaunaModels } from '../../src/game/world/fauna'
import { buildPedestrians } from '../../src/game/world/pedestrians'
import type { Solid } from '../../src/game/physics/collision'
import type { BiomeId } from '../../src/game/world/biomes'
import { buildSky } from '../../src/game/levels/sky'
import { buildHouse } from '../../src/game/levels/houseWorld'
import { buildGrass } from '../../src/game/world/grass'
import { createPixelLook, type PixelLook } from '../../src/game/render/pixelLook'
import {
  BIOME_AIR, airForSky, lightsForSky, nearestLamps,
} from '../../src/game/render/atmosphere'
import type { SkyState } from '../../src/game/levels/sky'
import { altitudeOf, domeScaleFor, fogForAltitude, viewFarFor } from '../../src/game/levels/altitude'
import { windUniforms } from '../../src/game/world/wind'
import { gfx } from '../../src/game/world/quality'

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

  The same rule covers the frame itself. Every tile is drawn through the
  game's own post pass (`render/pixelLook.ts`: the low internal resolution,
  outlines, grade and dithered posterize), under the game's own sky
  (`levels/sky.ts`, pinned at the asked-for `tod`, which also hands back the
  fog and the sun), over the game's own grass field. A shot without those is
  a picture of a different game; `raw` skips only the post pass, for a
  before and after of the look itself.

  Two things it deliberately does not have. There is no walker, no physics and
  no running clock: the light rig below is CrtScene's numbers pinned at
  whatever `tod` was asked for. And there is no streaming, just a fixed
  neighbourhood of chunks built once, because a probe that streams has the
  reused-renderer ghosting problem the notes warn about, where late-built
  chunk geometry draws nothing at all and impersonates whatever you just
  changed.
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
  /** skip the pixel look: the renderer's own ACES straight to the canvas,
      antialiased, the way every frame was drawn before render/ existed */
  raw?: boolean
  /** internal lines per tile for the look; 0 picks half the tile height,
      which is an exact 2x upscale */
  lines?: number
  /** overrides for the look's knobs (render/pixelLook.ts's LookKnobs), plus
      `day` / `night` objects overriding the grade presets (render/grade.ts).
      For tuning the look without an edit-reload cycle */
  look?: Record<string, unknown>
  /** altitudes: each target is shot from each of these heights over its
      ground, through the real streamer (see altTile). A row per target */
  alts?: number[]
  /** far-field rings for altitude tiles (world/quality.ts's farLevels);
      0 draws the world without one */
  farLevels?: number
  /** with `alts`: fly it instead of placing it (see climbRow). Seconds on
      the ground before take-off */
  climb?: number
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
  /** altitude tiles: meshes drawn (after frustum culling is not counted) */
  draws?: number
  /** altitude tiles: what the far field holds */
  far?: { tiles: number; verts: number; tris: number; pending: number; reach?: number; worstMs?: number; fog?: number[]; camFar?: number; alt?: number }
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

/** CrtScene's roam hemisphere: HEMI_ROAM scaled by the sky's own day boost,
    in the sky's own colours. The sun, the fog and the domes are the real
    sky module's, pinned at `tod`. */
const HEMI_ROAM = 1.5
const noop = () => {}

/** the sky the last lightFor built, for a climb that re-dresses it per frame */
let lastSky: ReturnType<typeof buildSky> | null = null
export const lightFor = (scene: THREE.Scene, tod: Tod, cam: THREE.Vector3, far = 900) => {
  const sky = buildSky({ parent: scene, trackTexture: noop, trackDisposable: noop })
  lastSky = sky
  sky.setScale(domeScaleFor(far))
  const st = sky.update(cam, tod)
  // sky.ts only asks for a sun map while the sun is strong enough to cast
  // one, and CrtScene bakes it once under the boot cover regardless. A still
  // frame has no boot: at dusk and at night the shadow sampler would have no
  // map behind it, and every lit draw fails validation and draws nothing
  sky.sun.shadow.needsUpdate = true
  const hemi = new THREE.HemisphereLight(st.hemiSky, st.hemiGround, HEMI_ROAM * st.dayBoost)
  scene.add(hemi)
  scene.fog = new THREE.Fog(st.fogColor.clone(), st.fogNear, st.fogFar)
  scene.background = st.fogColor.clone()
  return st
}

/** what the air thickens by under a point: 'town' in a settlement, the
    biome elsewhere, as outsideWorld's biomeAt answers it for the game */
const airGround = (x: number, z: number) => {
  const s = sampleAt(x, z)
  return s.place.district ? 'town' : s.biome
}

/**
 * Dress the look for a still frame the way CrtScene dresses it for a live
 * one: the grade's mood, the air's density for this moment and this ground,
 * the sun's glow, and the night's lamp pools and headlamp. `lamps` is a flat
 * xyz list of the fixtures in the tile (a chunk's `lamps`), nearest first
 * or not; the headlamp rides the camera, as the walker's own would.
 */
const lampPick = new Float32Array(16 * 3)
const lampD2 = new Float32Array(16)
const sunDir = new THREE.Vector3()
export const dressLook = (
  look: PixelLook, scene: THREE.Scene, st: SkyState, cam: THREE.Camera,
  biome: string | null, lamps: number[] = [], headlamp = true, alt = 0, reach = 0,
) => {
  look.setMood(st.night * (1 - st.twilight))
  let sun: THREE.DirectionalLight | null = null
  let hemi: THREE.HemisphereLight | null = null
  scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight && !sun) sun = o as THREE.DirectionalLight
    if ((o as THREE.HemisphereLight).isHemisphereLight && !hemi) hemi = o as THREE.HemisphereLight
  })
  const s = sun as THREE.DirectionalLight | null
  if (s) sunDir.subVectors(s.position, s.target.position).normalize()
  airForSky(
    look.air, st, BIOME_AIR[biome ?? ''] ?? 1, sunDir, s ? s.color : new THREE.Color(),
    alt, reach, SEA_Y,
  )
  cam.updateMatrixWorld()
  const cp = cam.getWorldPosition(new THREE.Vector3())
  const n = nearestLamps(cp.x, cp.z, lamps, lamps.length / 3, lampPick, 16, lampD2)
  const h = hemi as THREE.HemisphereLight | null
  const amb = h ? h.color.clone().multiplyScalar(h.intensity) : new THREE.Color(0.1, 0.1, 0.1)
  lightsForSky(look.lights, st, lampPick, n, amb)
  if (!headlamp) look.lights.head.on = false
  look.lights.head.pos.copy(cp)
  cam.getWorldDirection(look.lights.head.dir)
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
let look: PixelLook | null = null
/** the first GL error flagged straight after drawing a tile, this shot */
let lastGlError = ''
/** the built tiles of the last shot, so `pick` can raycast into them */
let tiles: Array<{ scene: THREE.Scene; cam: THREE.Camera; chunks: Chunk[] }> = []

const disposeTiles = () => {
  for (const t of tiles) for (const c of t.chunks) for (const g of c.geos) g.dispose()
  tiles = []
}

/*
  The view from the air: noclip, or the helicopter.

  Every other tile here is a fixed neighbourhood of chunks built once, which
  is honest at a walker's eye and a lie from a hundred units up, where what
  the frame is made of is the streamer's own decisions: how far the ring
  reaches at this height, which tier each ring gets, what stands past it,
  and how the fog and the air open up. So an altitude tile runs the real
  streamer (`buildWorld`) at the camera, primes the whole ring with no frame
  budget, settles every fade, and dresses the sky, the fog and the look
  through the same altitude module the game uses (levels/altitude.ts).

  The camera stands `alt` over the target's ground, backed off along the
  bearing and pitched down a fixed sixteen degrees: the horizon sits in the
  top quarter of the frame and the target in the lower third, which is how
  anybody actually flies in noclip.
*/
const ALT_PITCH = 0.28
const altTile = (
  spec: ShotSpec, x: number, z: number, label: string, alt: number,
  tw: number, th: number, index: number,
): ShotResult => {
  const r = renderer!
  const scene = new THREE.Scene()
  const gy = terrainY(x, z)
  const back = Math.max(10, alt / Math.tan(0.63))
  const cam = new THREE.PerspectiveCamera(58, tw / th, 0.2, 900)
  // a low camera downtown can land inside a tower: swing the bearing round
  // to the first one whose lens is in the open (the chunk under the lens is
  // built for its boxes and thrown away; the real ring is built below)
  const mats = makeChunkMats(noop, noop)
  let yaw = spec.yaw
  for (const off of [0, 1.05, -1.05, 2.1, -2.1, Math.PI]) {
    yaw = spec.yaw + off
    const px = x + Math.cos(yaw) * back
    const pz = z + Math.sin(yaw) * back
    const c = buildChunk(chunkX(px), chunkZ(pz), 'bare', mats)
    const p = new THREE.Vector3(px, gy + alt, pz)
    const inside = c.boxes.some((b) => b.clone().expandByScalar(2).containsPoint(p))
    for (const g of c.geos) g.dispose()
    if (!inside) break
  }
  cam.position.set(x + Math.cos(yaw) * back, gy + alt, z + Math.sin(yaw) * back)
  cam.lookAt(
    cam.position.x - Math.cos(yaw) * Math.cos(ALT_PITCH),
    cam.position.y - Math.sin(ALT_PITCH),
    cam.position.z - Math.sin(yaw) * Math.cos(ALT_PITCH),
  )
  const camAlt = altitudeOf(cam.position.y, terrainY(cam.position.x, cam.position.z))
  // --far 0 is the world as it was before the far field: the wide ring and
  // the old fog ramp, for a before and after
  const farWas = gfx.farLevels
  if (spec.farLevels !== undefined) gfx.farLevels = spec.farLevels
  const world = buildWorld({
    scene, obstacles: [], trackTexture: noop, trackDisposable: noop,
  })
  gfx.farLevels = farWas
  // the first update plans the far field and picks the ring for this height;
  // the far field is then built whole (a game spreads it over frames), the
  // ring re-picked now that it exists, and primed with no frame budget
  world.update(cam.position.x, cam.position.z, 1 / 60, camAlt)
  world.primeFar(cam.position.x, cam.position.z, camAlt, 1e5)
  world.update(cam.position.x, cam.position.z, 1 / 60, camAlt)
  world.prime(cam.position.x, cam.position.z, 1e9)
  // every chunk dissolves in over world/fade.ts's FADE_S from its birth
  // stamp; a still frame wants them all arrived, and the far field's mask
  // wants to know they have
  windUniforms.uTime.value += 30
  world.update(cam.position.x, cam.position.z, 0, camAlt)
  const reach = world.farReach(cam.position.x, cam.position.z)
  cam.far = viewFarFor(camAlt, reach)
  cam.updateProjectionMatrix()
  const st = lightFor(scene, spec.tod, cam.position, cam.far)
  fogForAltitude(st, camAlt, reach)
  const fog = scene.fog as THREE.Fog
  fog.near = st.fogNear
  fog.far = st.fogFar
  world.setNight(st.night)
  world.setWaterTint(st.fogColor, st.day)
  if (look) {
    const lampBuf = new Float32Array(16 * 3)
    const n = world.nearLamps(cam.position.x, cam.position.z, lampBuf, 16)
    dressLook(
      look, scene, st, cam, airGround(cam.position.x, cam.position.z),
      Array.from(lampBuf.subarray(0, n * 3)), false, camAlt, reach,
    )
  }
  tiles.push({ scene, cam, chunks: [] })
  if (look) look.render(scene, cam)
  else r.render(scene, cam)
  const err = r.getContext().getError()
  if (err && !lastGlError) lastGlError = `0x${err.toString(16)} on tile ${index} (${label})`
  const s = sampleAt(x, z)
  let verts = 0
  let draws = 0
  scene.traverseVisible((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    draws++
    verts += m.geometry.getAttribute('position')?.count ?? 0
  })
  return {
    label, x: Math.round(x), z: Math.round(z), y: Math.round(gy * 10) / 10,
    biome: s.biome, district: s.place.district, verts, draws,
    far: { ...world.farStats(), reach: Math.round(reach), fog: [Math.round(fog.near), Math.round(fog.far)], camFar: Math.round(cam.far), alt: Math.round(camAlt) },
  }
}

/*
  A climb, as the game plays it: one streamer, ticked a sixtieth of a second
  at a time under its real frame budget, with the wind clock (and so every
  chunk's fade) running. The camera stands at the target's eye line for
  `climb` seconds (the far field builds in the background there, the way it
  does while somebody walks), then rises at 30 u/s while drifting forward at
  20, and a frame is photographed as it passes each of `alts`. With
  `--climb 0` it takes off at once, which is the worst case: nothing past
  the ring is built yet, and the frames show what stands in meanwhile.
*/
const climbRow = (
  spec: ShotSpec, x: number, z: number, label: string,
  tw: number, th: number, row: number, canvasH: number,
): ShotResult[] => {
  const r = renderer!
  const scene = new THREE.Scene()
  const world = buildWorld({ scene, obstacles: [], trackTexture: noop, trackDisposable: noop })
  const cam = new THREE.PerspectiveCamera(58, tw / th, 0.2, 900)
  const yaw = spec.yaw
  const fx = -Math.cos(yaw)
  const fz = -Math.sin(yaw)
  let px = x
  let pz = z
  let alt = 3.84
  const dt = 1 / 60
  world.update(px, pz, dt, alt)
  world.prime(px, pz, 200)
  lightFor(scene, spec.tod, new THREE.Vector3(px, terrainY(px, pz) + alt, pz))
  const sky = lastSky!
  const out: ShotResult[] = []
  const alts = [...(spec.alts ?? [])].sort((a, b) => a - b)
  let next = 0
  let t = 0
  let worst = 0
  while (next < alts.length && t < 120) {
    const flying = t >= (spec.climb ?? 0)
    if (flying) {
      alt += 30 * dt
      px += fx * 20 * dt
      pz += fz * 20 * dt
    }
    const t0 = performance.now()
    world.update(px, pz, dt, alt)
    worst = Math.max(worst, performance.now() - t0)
    t += dt
    if (!flying || alt < alts[next]) continue
    const gy = terrainY(px, pz)
    cam.position.set(px, gy + alt, pz)
    cam.lookAt(px + fx * Math.cos(ALT_PITCH), gy + alt - Math.sin(ALT_PITCH), pz + fz * Math.cos(ALT_PITCH))
    const reach = world.farReach(px, pz)
    cam.far = viewFarFor(alt, reach)
    cam.updateProjectionMatrix()
    const st = sky.update(cam.position, spec.tod)
    sky.setScale(domeScaleFor(cam.far))
    sky.sun.shadow.needsUpdate = true
    fogForAltitude(st, alt, reach)
    const fog = scene.fog as THREE.Fog
    fog.near = st.fogNear
    fog.far = st.fogFar
    world.setNight(st.night)
    world.setWaterTint(st.fogColor, st.day)
    if (look) {
      dressLook(look, scene, st, cam, airGround(px, pz), [], false, alt, reach)
    }
    r.setViewport(next * tw, canvasH - (row + 1) * th, tw, th)
    r.setScissor(next * tw, canvasH - (row + 1) * th, tw, th)
    if (look) look.render(scene, cam)
    else r.render(scene, cam)
    tiles.push({ scene, cam, chunks: [] })
    const s = sampleAt(px, pz)
    out.push({
      label: `${label} climb @${alts[next]} t=${t.toFixed(1)}s`,
      x: Math.round(px), z: Math.round(pz), y: Math.round(gy),
      biome: s.biome, district: s.place.district, verts: 0,
      far: { ...world.farStats(), reach: Math.round(reach), worstMs: Math.round(worst * 10) / 10 },
    })
    next++
  }
  return out
}

export const shoot = (spec: ShotSpec): ShotResult[] => {
  const canvas = document.getElementById('c') as HTMLCanvasElement
  const list = spec.targets.length === 1 && spec.targets[0].kind === 'landmark'
    && spec.targets[0].arg === '*'
    ? resolveAllLandmarks()
    : spec.targets.map(resolve)
  const count = list.length * Math.max(1, spec.alts?.length ?? 0)
  const cols = spec.alts?.length ? spec.alts.length : Math.min(spec.cols, count)
  const rows = Math.ceil(count / cols)
  const [tw, th] = spec.tile
  canvas.width = tw * cols
  canvas.height = th * rows

  // a fresh renderer per shot, deliberately. A reused one ghosts late-built
  // chunk geometry: valid, raycastable, in the scene, and drawing nothing,
  // which impersonates exactly the feature you just changed
  look?.dispose()
  look = null
  renderer?.dispose()
  // antialiasing only for the raw frame: the look renders into its own
  // aliased target and would pay for a multisampled canvas it never uses
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !!spec.raw })
  renderer.setPixelRatio(1)
  renderer.setSize(canvas.width, canvas.height, false)
  if (spec.raw) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
  } else {
    look = createPixelLook(renderer)
    // what the tile is drawn at: an exact 2x unless asked otherwise
    look.knobs.lines = spec.lines || Math.round(th / 2)
    const { day, night, ...knobs } = (spec.look ?? {}) as {
      day?: Record<string, unknown>; night?: Record<string, unknown>
    }
    Object.assign(look.knobs, knobs)
    look.setGrade(day, night)
  }
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setScissorTest(true)

  disposeTiles()
  lastGlError = ''
  const keep: THREE.Texture[] = []
  const mats = makeChunkMats((t) => keep.push(t), () => {})
  // the streamer fades a chunk in over its baked birth stamp and holds the
  // glass at zero opacity by day; a still frame wants both settled
  ;(mats.glass as THREE.MeshBasicMaterial).opacity =
    spec.tod < 0.24 || spec.tod > 0.74 ? 1 : 0

  const out: ShotResult[] = []
  if (spec.alts?.length && spec.climb !== undefined) {
    list.forEach((t, row) => {
      out.push(...climbRow(spec, t.x, t.z, t.label, tw, th, row, canvas.height))
    })
    return out
  }
  if (spec.alts?.length) {
    // targets down the rows, altitudes across: `--alt 10,40,120,300` over
    // three places is one sheet a critic can read left to right as a climb
    let i = 0
    for (const t of list) {
      for (const alt of spec.alts) {
        const col = i % cols
        const row = Math.floor(i / cols)
        renderer.setViewport(col * tw, canvas.height - (row + 1) * th, tw, th)
        renderer.setScissor(col * tw, canvas.height - (row + 1) * th, tw, th)
        out.push(altTile(spec, t.x, t.z, `${t.label} @${alt}`, alt, tw, th, i))
        i++
      }
    }
    return out
  }
  for (let i = 0; i < list.length; i++) {
    const { x, z, label } = list[i]
    const scene = new THREE.Scene()
    const gy = terrainY(x, z)
    const c0 = chunkX(x)
    const d0 = chunkZ(z)
    const chunks: Chunk[] = []
    // the tile's own solids, so the crowd and the herd argue with the same
    // walls the shot is showing rather than walking through them
    const boxes: Solid[] = []
    let verts = 0
    // By water, one ring more: a sea is flat and open to the sky, so the
    // edge of a 3x3 is a hard line across it a hundred units off, where the
    // game's ring (and its fog) would carry it on to the horizon
    let rings = spec.rings
    for (let a = 0; a < 8 && rings === spec.rings; a++) {
      if (terrainY(x + Math.cos(a) * 90, z + Math.sin(a) * 90) < SEA_Y) rings = spec.rings + 2
    }
    for (let dz = -rings; dz <= rings; dz++)
      for (let dx = -rings; dx <= rings; dx++) {
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

    // The camera, placed after the chunks so it can see their solids. A
    // bearing whose lens lands inside a building, or whose view of the
    // target runs through one, is swapped for the nearest one that does not
    // (a suburb orbit used to photograph the inside of a wall). The yaw asked
    // for wins whenever it is clear, so a shot stays reproducible
    const cam = new THREE.PerspectiveCamera(spec.eye ? 58 : 42, tw / th, 0.2, 900)
    const aim = new THREE.Vector3()
    const place = (yaw: number) => {
      if (spec.eye) {
        cam.position.set(x, gy + 3.55, z)
        aim.set(x + Math.sin(yaw) * 20, gy + 2.0, z + Math.cos(yaw) * 20)
      } else {
        cam.position.set(
          x + Math.cos(yaw) * spec.dist, gy + spec.height, z + Math.sin(yaw) * spec.dist)
        aim.set(x, gy + spec.height * 0.32, z)
      }
    }
    const blocked = () => {
      const ray = new THREE.Ray(cam.position.clone(), aim.clone().sub(cam.position).normalize())
      // the eye line only needs its first stretch clear; an orbit needs the
      // whole way in to the target
      const reach = spec.eye ? 7 : cam.position.distanceTo(aim) - 4
      const hit = new THREE.Vector3()
      let n = 0
      for (const b of boxes) {
        if (b.containsPoint(cam.position)) n += 10
        else if (ray.intersectBox(b, hit) && hit.distanceTo(cam.position) < reach) n++
      }
      return n
    }
    let bestYaw = spec.yaw
    let best = Number.POSITIVE_INFINITY
    for (const off of [0, 1.05, -1.05, 2.1, -2.1, Math.PI]) {
      place(spec.yaw + off)
      const n = blocked()
      if (n < best) { best = n; bestYaw = spec.yaw + off }
      if (n === 0) break
    }
    place(bestYaw)
    cam.lookAt(aim)
    const sky = lightFor(scene, spec.tod, cam.position)
    tintWater(mats.water, sky.fogColor, sky.day)
    // the lattice is pinned under whatever it is updated at: the target, so
    // an orbit shot has turf where it is looking rather than under the lens
    buildGrass({ parent: scene, trackDisposable: noop }).update(x, z)

    // nothing generated stands on the property (grid.ts's RESERVED), so the
    // house has to be stood in it or `home` photographs an empty lawn. Architecture only: the furniture is ~35 downloaded GLBs,
    // and the lamp it clones onto each ceiling is an empty stand-in
    if (label === 'home') {
      const house = buildHouse({
        scene, obstacles: [],
        darkWoodMat: new THREE.MeshStandardMaterial({ color: '#3b2a1f', roughness: 0.7 }),
        windowGlassMat: new THREE.MeshStandardMaterial({
          color: '#9fb4c4', roughness: 0.1, transparent: true, opacity: 0.35,
        }),
        lamp: { scene: new THREE.Group() },
        trackTexture: noop, trackDisposable: noop,
      })
      house.setDay(sky.day)
      // the chunks drawn round it already carry the property's ground
      house.worldGround()
      // its spot lights hand-bake their maps (CrtScene does it under the
      // boot cover). A shadow sampler with no map behind it fails every lit
      // draw with INVALID_OPERATION, and the whole tile renders as fog
      for (const l of house.shadowLights) l.shadow.needsUpdate = true
      house.root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true }
      })
    }

    if (look) {
      const lamps: number[] = []
      for (const c of chunks) for (const l of c.lamps) lamps.push(l.x, l.y, l.z)
      // the headlamp is the walker's, so only an eye-line shot carries one
      dressLook(look, scene, sky, cam, airGround(cam.position.x, cam.position.z), lamps, spec.eye)
    }

    if (spec.props?.length) addProps(scene, x, z, spec.props)
    const life = spec.life ? addLife(scene, x, z, gy, spec.life, boxes) : null

    tiles.push({ scene, cam, chunks })

    const col = i % cols
    const row = Math.floor(i / cols)
    const px = col * tw
    const py = canvas.height - (row + 1) * th
    renderer.setViewport(px, py, tw, th)
    renderer.setScissor(px, py, tw, th)
    if (look) look.render(scene, cam)
    else renderer.render(scene, cam)
    const err = renderer.getContext().getError()
    if (err && !lastGlError) lastGlError = `0x${err.toString(16)} on tile ${i} (${label})`

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

/**
 * Frame cost of the last shot's first tile: `n` redraws of it, each forced
 * to finish with a one-pixel readback so the clock measures the GPU rather
 * than the command queue. Median milliseconds per frame, which is how the
 * look's fill saving and the cost of its passes are measured against --raw.
 */
export const bench = (n = 60) => {
  const t = tiles[0]
  if (!t || !renderer) return null
  const gl = renderer.getContext()
  const px = new Uint8Array(4)
  const draw = () => {
    if (look) look.render(t.scene, t.cam)
    else renderer!.render(t.scene, t.cam)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
  }
  for (let i = 0; i < 5; i++) draw()
  const ms: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    draw()
    ms.push(performance.now() - t0)
  }
  ms.sort((a, b) => a - b)
  return {
    median: Math.round(ms[n >> 1] * 100) / 100,
    p90: Math.round(ms[Math.floor(n * 0.9)] * 100) / 100,
    internal: look ? `${look.internal.w}x${look.internal.h}` : 'native',
  }
}

/** the GL error flag read straight after each tile of the last shot. A draw that fails validation
    (a shadow sampler with no map, a feedback loop) draws nothing and throws
    nothing, so the harness asks */
export const glError = () => lastGlError

/** the last shot's tiles, for poking at from the console over CDP */
export const lastTiles = () => ({ tiles, renderer, look })
