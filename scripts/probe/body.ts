import * as THREE from 'three'
import { buildChunk, type Chunk } from '../../src/game/world/chunk'
import { makeChunkMats } from '../../src/game/world/streamer'
import { chunkX, chunkZ } from '../../src/game/world/grid'
import { biomeAt, slopeAt, terrainY } from '../../src/game/world/terrain'
import { landmarkAt } from '../../src/game/world/landmarks'
import { placeAt, roadAt } from '../../src/game/world/settlements'
import { makeCollisionSet, type Solid } from '../../src/game/physics/collision'
import {
  CABIN_FIT, DESIGN_EYE, DESIGN_LENS, buildPlayerBody, type PlayerPose, type PlayerRig,
} from '../../src/game/player/playerBody'
import type { RagdollEnv } from '../../src/game/player/ragdoll'
import { setBodyBuildSync } from '../../src/game/player/bodyShape'
import { DEFAULT_LOOK, type PlayerLook } from '../../src/game/player/look'
import { createVehicleMaterials } from '../../src/game/vehicles/materials'
import { buildCar } from '../../src/game/vehicles/car'
import { buildHeli } from '../../src/game/vehicles/heli'
import { buildBoat } from '../../src/game/vehicles/boat'
import { buildShip } from '../../src/game/vehicles/ship'
import { dressLook, lightFor } from './probe'
import type { SkyState } from '../../src/game/levels/sky'
import { createPixelLook, type PixelLook } from '../../src/game/render/pixelLook'
import { buildSky } from '../../src/game/levels/sky'
import { buildMoon, moonGroundY } from '../../src/game/levels/moon'
import { buildGlobes } from '../../src/game/world/globe'
import { domeScaleFor } from '../../src/game/levels/altitude'
import {
  EARTH_IN_MOON_SKY, EARTH_R, EARTH_SKY_DIST, MOON_DIST, MOON_FAR, MOON_ORIGIN, MOON_TOD,
} from '../../src/game/levels/space'
import { HELMET_HAT, SPACESUIT } from '../../src/game/player/look'

/*
  The player character, photographed and filmed without booting the site.

    npm run shoot -- body:lineup          six looks, front, back and a pose row
    npm run shoot -- body:motion          filmstrips: walk, run, jump, big fall,
                                          knocked flat, getting up, idle
    npm run shoot -- body:strip:ragdoll   one of those strips on its own
    npm run shoot -- body:fp              what the first-person lens sees of
                                          your own body, looking down
    npm run shoot -- body:size            how big a bean is: beside a house
                                          doorway in a storey-high wall, under
                                          the lens line, beside the old eye-scaled size
    npm run shoot -- body:astronaut       the spacesuit and helmet in three
                                          colourings, front, back and close
    npm run shoot -- body:moon            astronauts on the Moon, the Earth
                                          hanging in its sky
    npm run shoot -- body:seat            seated in the car, the boat and the
                                          helicopter's real seat nodes
    npm run shoot -- body:car [--tod 0.9] the car alone, five ways round, two
                                          aboard; at night, lamps and beams on
    ... --pixel 3                          render at a third of the resolution,
                                          posterized and dithered, upscaled
                                          nearest: roughly the look the game is
                                          moving to, to judge silhouettes at it

  Everything here is the real module: the bodies are `buildPlayerBody()`,
  driven through `update()` with the same PlayerPose struct the scene feeds
  it, frame by frame at 60 Hz from a scripted walker (a few lines of
  integration standing in for walkController, which needs a camera and keys).
  The ground, light and fog are the world's (`makeChunkMats` chunks at a
  town street, `lightFor`'s pinned day cycle), for the reason the probe gives:
  a hand-rolled scene flatters or slanders whatever is standing in it. The
  motion is simulated once, in order, and each frame of a strip is drawn at
  the moment the clock crosses it, so what a strip shows is what a player
  would have seen at those instants, springs and ragdoll included.
*/

export interface BodySpec {
  targets: Array<{ kind: string; arg?: string }>
  tile: [number, number]
  cols: number
  tod: number
  /** 1 (the default) draws through the game's own look at an exact 2x;
      N > 1 draws the look at 1/N of the tile height instead */
  pixel: number
  /** skip the look: the renderer's own ACES frame */
  raw?: boolean
  lines?: number
}

/* ------------------------------------------------------------- the site -- */

/** a straight, flat, empty bit of street near the house, so feet, shadows
    and a tumble all read against asphalt rather than into grass */
const findSite = () => {
  for (let r = 0; r < 200; r++) {
    const n = Math.max(1, r * 6)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = Math.cos(a) * r * 16
      const z = -340 + Math.sin(a) * r * 16
      const ok = (px: number, pz: number) => {
        const place = placeAt(px, pz)
        return place.district !== null && roadAt(px, pz, place).asphalt && slopeAt(px, pz) < 0.04
      }
      if (ok(x, z) && ok(x + 14, z) && ok(x - 14, z) && ok(x, z + 3) && ok(x, z - 3)) return { x, z }
    }
  }
  return { x: 0, z: -340 }
}
let site: { x: number; z: number } | null = null

interface Stage {
  scene: THREE.Scene
  chunks: Chunk[]
  env: RagdollEnv
  gy: number
  x: number
  z: number
  /** the sky's state at this stage's moment, for dressing the look */
  sky: SkyState
}

let mats: ReturnType<typeof makeChunkMats> | null = null
const stage = (tod: number, at?: { x: number; z: number }): Stage => {
  site ??= findSite()
  const { x, z } = at ?? site
  mats ??= makeChunkMats(() => {}, () => {})
  const scene = new THREE.Scene()
  const gy = terrainY(x, z)
  const sky = lightFor(scene, tod, new THREE.Vector3(x, gy, z))
  const chunks: Chunk[] = []
  const boxes: Solid[] = []
  const c0 = chunkX(x)
  const d0 = chunkZ(z)
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const c = buildChunk(c0 + dx, d0 + dz, 'full', mats)
      c.group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true }
      })
      chunks.push(c)
      for (const b of c.boxes) boxes.push(b)
      scene.add(c.group)
    }
  const env: RagdollEnv = {
    groundY: gy,
    groundAt: terrainY,
    collision: makeCollisionSet({ minX: -1e5, maxX: 1e5, minZ: -1e5, maxZ: 1e5 }, boxes),
  }
  lastStage = { scene, chunks, env, gy, x, z, sky }
  return lastStage
}
/** the stage the current run built, which is what its snapshots draw */
let lastStage: Stage | null = null

/* ------------------------------------------------------------- a walker -- */

const EYE = 3.84
const GRAV = 34
const WALK = 5.9
const RUN = 9.4
const JUMP_V = 11.9

/** yaw 0 faces -Z; forward is (-sin, -cos), the walk's own convention */
interface Actor {
  rig: PlayerRig
  pose: PlayerPose
  x: number
  z: number
  y: number
  vx: number
  vz: number
  vy: number
  grounded: boolean
}

const actor = (st: Stage, look: PlayerLook, x: number, z: number, yaw: number): Actor => {
  const rig = buildPlayerBody(EYE, GRAV, look)
  st.scene.add(rig.group)
  const y = terrainY(x, z)
  rig.face(yaw)
  const pose: PlayerPose = {
    dt: 1 / 60, gait: 0, crouchK: 0, grounded: true, run: false,
    yaw, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
  }
  const a: Actor = { rig, pose, x, z, y, vx: 0, vz: 0, vy: 0, grounded: true }
  place(a)
  return a
}

const place = (a: Actor) => {
  if (!a.rig.ragdolling) {
    a.rig.group.position.set(a.x, a.y, a.z)
    a.rig.group.rotation.y = a.rig.facing + Math.PI
  }
}

/** one 60 Hz tick of a scripted walker: accelerate toward a planar speed
    along the yaw, fall under gravity, land on the terrain */
const tick = (
  a: Actor, env: RagdollEnv,
  o: { speed?: number; run?: boolean; jump?: boolean; crouch?: number; dt?: number } = {},
) => {
  const dt = o.dt ?? 1 / 60
  const speed = o.speed ?? 0
  const yaw = a.pose.yaw
  const tx = -Math.sin(yaw) * speed
  const tz = -Math.cos(yaw) * speed
  const k = 1 - Math.exp(-(a.grounded ? 12 : 2) * dt)
  a.vx += (tx - a.vx) * k
  a.vz += (tz - a.vz) * k
  a.pose.landing = 0
  if (!a.rig.down) {
    if (o.jump && a.grounded) {
      a.vy = JUMP_V
      a.grounded = false
    }
    a.x += a.vx * dt
    a.z += a.vz * dt
    if (!a.grounded) {
      a.vy -= GRAV * dt
      a.y += a.vy * dt
      const floor = terrainY(a.x, a.z)
      if (a.y <= floor) {
        a.pose.landing = -a.vy
        a.y = floor
        a.vy = 0
        a.grounded = true
      }
    } else {
      a.y = terrainY(a.x, a.z)
    }
  }
  const cap = o.run ? RUN : WALK
  a.pose.dt = dt
  a.pose.gait = Math.min(1, Math.hypot(a.vx, a.vz) / cap)
  a.pose.run = !!o.run
  a.pose.crouchK = o.crouch ?? 0
  a.pose.grounded = a.grounded
  a.pose.vx = a.vx
  a.pose.vz = a.vz
  a.pose.vy = a.vy
  place(a)
  env.groundY = terrainY(a.x, a.z)
  a.rig.update(a.pose, env)
}

/** stand a downed body back up where it lies, the way CrtScene does */
const getUp = (a: Actor) => {
  const p = a.rig.getupSpot(new THREE.Vector3())
  a.x = p.x
  a.z = p.z
  a.y = terrainY(p.x, p.z)
  a.vx = a.vz = a.vy = 0
  a.grounded = true
  a.rig.group.position.set(a.x, a.y, a.z)
  a.rig.group.rotation.y = a.rig.facing + Math.PI
  a.rig.group.updateMatrixWorld(true)
  a.rig.beginRecover()
}

/* -------------------------------------------------------------- the looks -- */

/** six people who could plausibly meet in the street: the default, and five
    drawn from look.ts's own palettes */
const LOOKS: PlayerLook[] = [
  DEFAULT_LOOK,
  { shell: '#e0a21a', trim: '#8a4fc8', accent: '#2860c8', glow: '#1c1a20', hat: 2, costume: 3, build: 1 },
  { shell: '#3f9a38', trim: '#d2452c', accent: '#f0e8e0', glow: '#1c1a20', hat: 3, costume: 2, build: 2 },
  { shell: '#d9508f', trim: '#2f6fcc', accent: '#e8b818', glow: '#2b3a50', hat: 4, costume: 1, build: 3 },
  { shell: '#8a4fc8', trim: '#f2eee0', accent: '#e86810', glow: '#1c1a20', hat: 7, costume: 0, build: 4 },
  { shell: '#d2452f', trim: '#f2eee0', accent: '#1c1c20', glow: '#1c1a20', hat: 1, costume: 2, build: 1 },
]

/* -------------------------------------------------------------- the tiles -- */

/** one tile's worth of a camera, looking at a point from a bearing */
const camAt = (
  tw: number, th: number, at: THREE.Vector3, bearing: number, dist: number, up: number, fov = 34,
) => {
  const cam = new THREE.PerspectiveCamera(fov, tw / th, 0.1, 900)
  cam.position.set(at.x + Math.sin(bearing) * dist, at.y + up, at.z + Math.cos(bearing) * dist)
  cam.lookAt(at)
  return cam
}

/** a whole scene is re-rendered per frame of a strip, so a strip is a
    list of (scene, camera) snapshots taken while the sim runs. Scenes are
    shared across a strip; each snapshot renders the moment it is taken */
type Snap = (label: string, cam: THREE.PerspectiveCamera) => void

const lineup = (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  const yaw = 0 // facing -Z; the camera stands on -Z looking back at them
  const people = LOOKS.map((look, i) => actor(st, look, st.x + (i - 2.5) * 3.8, st.z, yaw))
  // a few seconds of standing about, so every spring has settled into its
  // idle and the glances and blinks are wherever they happen to be
  for (let f = 0; f < 150; f++) for (const p of people) tick(p, st.env)
  const mid = new THREE.Vector3(st.x, st.gy + 2.3, st.z)
  // the facing yaw 0 looks toward -Z, so the front is seen from -Z
  snap('front', camAt(tw, th, mid, Math.PI + 0.12, 27, 1.6))
  snap('three-quarter back', camAt(tw, th, mid, 0.45, 15, 9))
  for (const p of people) {
    st.scene.remove(p.rig.group)
  }

  // the pose row: the same body mid-action
  const poses = [
    { look: LOOKS[0], run: 'wave' },
    { look: LOOKS[1], run: 'crouch' },
    { look: LOOKS[2], run: 'jump' },
    { look: LOOKS[3], run: 'sprint' },
    { look: LOOKS[4], run: 'heap' },
    { look: LOOKS[5], run: 'stretch' },
  ]
  const row = poses.map((p, i) => ({ ...p, a: actor(st, p.look, st.x + (i - 2.5) * 3.6, st.z, yaw + (i % 2 ? 0.5 : -0.4)) }))
  for (let f = 0; f < 240; f++) {
    for (const r of row) {
      const t = f / 60
      if (r.run === 'wave' && f === 180) r.a.rig.emote('look')
      if (r.run === 'stretch' && f === 150) r.a.rig.emote('bounce')
      if (r.run === 'crouch') tick(r.a, st.env, { crouch: Math.min(1, t * 3) })
      else if (r.run === 'jump') tick(r.a, st.env, { jump: f === 222, speed: 0 })
      else if (r.run === 'sprint') {
        // run on the spot: a treadmill, the body is put back each frame
        const x0 = r.a.x
        const z0 = r.a.z
        tick(r.a, st.env, { speed: RUN, run: true })
        if (f < 239) {
          r.a.x = x0
          r.a.z = z0
        }
      } else if (r.run === 'heap') {
        if (f === 120) r.a.rig.flop(3, 5, -2)
        tick(r.a, st.env)
      } else tick(r.a, st.env)
    }
  }
  snap('poses', camAt(tw, th, new THREE.Vector3(st.x, st.gy + 2, st.z), Math.PI + 0.12, 29, 2.2))
}

/** How big a bean is. A doorway as the house draws them (2.1 wide, 4.7 high),
    a thin line at the walker's lens (3.84) and one at the storey's ceiling
    (6), the body as it is built now beside it, a second one of the same
    size, and the size it was built at when it was scaled onto its painted
    eyes rather than its crown, greyed back */
const size = (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  const gy = st.gy
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, color: string) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }))
    m.position.set(x, y, z)
    m.castShadow = true
    st.scene.add(m)
  }
  // the door: a wall with a 2.1 x 4.7 hole in it, 6 high like a storey
  const dx = st.x + 1.5
  add(3, 6, 0.3, dx - 1.05 - 1.5, gy + 3, st.z + 1.2, "#b8b2a4")
  add(3, 6, 0.3, dx + 1.05 + 1.5, gy + 3, st.z + 1.2, "#b8b2a4")
  add(2.1, 6 - 4.7, 0.3, dx, gy + 4.7 + (6 - 4.7) / 2, st.z + 1.2, "#b8b2a4")
  // the lens line
  add(14, 0.04, 0.04, st.x, gy + 3.84, st.z + 1.0, '#e8402a')
  const now = actor(st, LOOKS[0], st.x - 1.8, st.z, 0)
  const two = actor(st, LOOKS[2], dx, st.z + 1.2, 0)
  const old = buildPlayerBody(3.84 * (DESIGN_LENS / DESIGN_EYE), GRAV, LOOKS[3])
  st.scene.add(old.group)
  const was = { rig: old, pose: { ...now.pose }, x: st.x - 5.4, z: st.z, y: gy, vx: 0, vz: 0, vy: 0, grounded: true }
  old.face(0)
  for (let f = 0; f < 120; f++) {
    tick(now, st.env)
    tick(two, st.env)
    tick(was, st.env)
  }
  const at = new THREE.Vector3(st.x - 1, gy + 2.6, st.z)
  snap('size: old scale, now, now in a 4.7 door; red = lens 3.84', camAt(tw, th, at, Math.PI - 0.25, 17, 0.6, 34))
}

/** the astronaut in three colourings: body (the patch and the flag),
    detail (stripes, rings, cuffs) and hat (the helmet's trim) all differ */
const ASTRONAUTS: PlayerLook[] = [
  { shell: '#2f6fcf', trim: '#d2452c', accent: '#c84028', glow: '#1c1a20', hat: HELMET_HAT, costume: SPACESUIT, build: 0 },
  { shell: '#d9508f', trim: '#2f6fcc', accent: '#2860c8', glow: '#2b3a50', hat: HELMET_HAT, costume: SPACESUIT, build: 1 },
  { shell: '#3f9a38', trim: '#e0a218', accent: '#e8b818', glow: '#1c1a20', hat: HELMET_HAT, costume: SPACESUIT, build: 2 },
]
const astronaut = (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  const people = ASTRONAUTS.map((l, i) => actor(st, l, st.x + (i - 1) * 3.4, st.z, 0))
  for (let f = 0; f < 150; f++) for (const p of people) tick(p, st.env)
  const mid = new THREE.Vector3(st.x, st.gy + 1.9, st.z)
  const shoot = (label: string, cam: THREE.PerspectiveCamera) => {
    if (look) dressLook(look, st.scene, st.sky, cam, 'town', [], false)
    snap(label, cam)
  }
  shoot('astronauts, front', camAt(tw, th, mid, Math.PI + 0.1, 15, 1.2))
  shoot('astronauts, back', camAt(tw, th, mid, 0.5, 14, 3))
  shoot('astronaut, close', camAt(tw, th, new THREE.Vector3(st.x - 3.4, st.gy + 2.4, st.z), Math.PI + 0.35, 6.5, 0.6, 34))
}

/** astronauts on the Moon: its own ground, a black sky, the harsh sun and
    the Earth hung where the Moon level hangs it */
const moonShot = (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  const scene = new THREE.Scene()
  const noop = () => {}
  const moon = buildMoon({ parent: scene, obstacles: [], trackDisposable: noop })
  moon.ensureBuilt()
  moon.root.visible = true
  const x = MOON_ORIGIN.x + 6
  const z = MOON_ORIGIN.z + 4
  const gy = moonGroundY(x, z)
  const camPos = new THREE.Vector3(x, gy + 2, z)
  const sky = buildSky({ parent: scene, trackTexture: noop, trackDisposable: noop })
  sky.setScale(domeScaleFor(MOON_FAR))
  const st = sky.update(camPos, MOON_TOD, 1, false)
  st.fogNear = 1e6
  st.fogFar = 2e6
  sky.sun.intensity *= 2.6
  sky.sun.shadow.needsUpdate = true
  const hemi = new THREE.HemisphereLight(st.hemiSky, st.hemiGround, 0.35)
  scene.add(hemi)
  scene.background = new THREE.Color('#000000')
  const globes = buildGlobes({ parent: scene, trackDisposable: noop })
  const earthDir = new THREE.Vector3(EARTH_IN_MOON_SKY.x, EARTH_IN_MOON_SKY.y, EARTH_IN_MOON_SKY.z)
  globes.wantEarth(0, 0)
  for (let i = 0; i < 400 && !globes.earthReady; i++) globes.work(50)
  const sunDir = new THREE.Vector3().subVectors(sky.sun.position, sky.sun.target.position).normalize()
  globes.setSun(sunDir, 0)
  globes.hideMoon()
  const env: RagdollEnv = {
    groundY: gy,
    groundAt: moonGroundY,
    collision: makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }),
  }
  // the lens looks up at them against the Earth: stand them between the
  // camera and the Earth's bearing
  const toEarth = Math.atan2(earthDir.x, earthDir.z)
  const rigs = ASTRONAUTS.map((l, i) => {
    const rig = buildPlayerBody(EYE, GRAV / 6, l)
    scene.add(rig.group)
    const side = (i - 1) * 3.2
    const px = x + Math.cos(toEarth) * side
    const pz = z - Math.sin(toEarth) * side
    // facing the lens, their backs to the Earth
    rig.face(Math.atan2(Math.sin(toEarth), Math.cos(toEarth)) - (i - 1) * 0.35)
    rig.group.position.set(px, moonGroundY(px, pz), pz)
    rig.group.rotation.y = rig.facing + Math.PI
    return rig
  })
  const pose: PlayerPose = {
    dt: 1 / 60, gait: 0, crouchK: 0, grounded: true, run: false, yaw: 0, pitch: 0,
    vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
  }
  for (let f = 0; f < 150; f++) {
    for (const r of rigs) {
      pose.yaw = r.facing
      env.groundY = r.group.position.y
      r.update(pose, env)
    }
  }
  const cam = new THREE.PerspectiveCamera(46, tw / th, 0.1, MOON_FAR)
  cam.position.set(x - Math.sin(toEarth) * 11, gy + 1.1, z - Math.cos(toEarth) * 11)
  cam.lookAt(x + Math.sin(toEarth) * 8, gy + 5.2, z + Math.cos(toEarth) * 8)
  cam.updateMatrixWorld()
  globes.earthInSky(cam.position, earthDir, EARTH_SKY_DIST, (EARTH_R * EARTH_SKY_DIST) / MOON_DIST)
  sky.update(cam.position, MOON_TOD, 1, false)
  scene.background = new THREE.Color('#000000')
  scene.fog = null
  lastStage = { scene, chunks: [], env, gy, x, z, sky: st }
  if (look) dressLook(look, scene, st, cam, null, [], false)
  snap('astronauts on the Moon', cam)
}

/** one body, close: front, three-quarter, side and back, where a face,
    the headband and the colour blocks can actually be judged */
const closeup = (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  const a = actor(st, LOOKS[0], st.x, st.z, 0)
  for (let f = 0; f < 90; f++) tick(a, st.env)
  // framed on the chest, far enough back that the crown and the face are
  // in every tile (it used to crop the face off the top of the front one)
  const at = new THREE.Vector3(st.x, st.gy + 2.2, st.z)
  for (const [label, b] of [['front', Math.PI], ['three-quarter', Math.PI - 0.7], ['side', -Math.PI / 2], ['back', 0.35]] as const) {
    snap(label, camAt(tw, th, at, b, 11, 0.9, 32))
  }
}

/** the actions a filmstrip can show. Each runs a scripted walker and calls
    `frame` at the instants it wants photographed */
const ACTIONS: Record<string, {
  frames: number[]
  run: (a: Actor, st: Stage, f: number) => void
  /** where the camera stands: bearing, distance, height over the chest */
  cam?: [number, number, number]
}> = {
  // accelerate from standing into a walk; frames through two strides
  walk: {
    frames: [0.2, 0.62, 0.72, 0.82, 0.92, 1.02, 1.12, 1.22],
    run: (a, st) => tick(a, st.env, { speed: WALK }),
  },
  run: {
    frames: [0.25, 0.7, 0.77, 0.84, 0.91, 0.98, 1.05, 1.12],
    run: (a, st) => tick(a, st.env, { speed: RUN, run: true }),
  },
  // the same run from dead side-on, a full cycle (two steps) at the run's
  // own cadence: where the arm swing and the legs can be read against each
  // other
  runside: {
    frames: [0.8, 0.835, 0.87, 0.905, 0.94, 0.975, 1.01, 1.045],
    cam: [0, 8.5, -0.7],
    run: (a, st) => tick(a, st.env, { speed: RUN, run: true }),
  },
  // walk and run from straight behind, the chase camera's own view: where a
  // side-to-side rock of the head reads as a metronome
  walkback: {
    frames: [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15],
    cam: [-Math.PI / 2, 8, 0.6],
    run: (a, st) => tick(a, st.env, { speed: WALK }),
  },
  runback: {
    frames: [0.8, 0.835, 0.87, 0.905, 0.94, 0.975, 1.01, 1.045],
    cam: [-Math.PI / 2, 8, 0.6],
    run: (a, st) => tick(a, st.env, { speed: RUN, run: true }),
  },
  // a full run swerving hard left: the bank, the lean and what the arms do
  // with a yaw rate on them
  turn: {
    frames: [0.5, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.45],
    cam: [Math.PI - 0.2, 12, 3],
    run: (a, st, f) => {
      if (f > 36 && f < 80) a.pose.yaw += 3 / 60
      tick(a, st.env, { speed: RUN, run: true })
    },
  },
  // a standing hop and the landing, then the settle
  jump: {
    frames: [0.5, 0.52, 0.64, 0.8, 0.98, 1.14, 1.24, 1.4],
    run: (a, st, f) => tick(a, st.env, { jump: f === 30 }),
  },
  // walking off a nine-unit drop: the reach on the fall, the squash, the
  // wobble back up
  land: {
    frames: [0.3, 0.55, 0.72, 0.76, 0.82, 0.92, 1.05, 1.3],
    run: (a, st, f) => {
      if (f === 0) {
        a.y += 6.5
        a.grounded = false
        a.vy = 0
      }
      tick(a, st.env, { speed: f < 20 ? WALK : 2 })
    },
  },
  // walking along and hit side-on at the hip by something the size of a car
  // doing forty: the hit is `rig.hit`, exactly what a vehicle impact calls
  ragdoll: {
    frames: [0.3, 0.4, 0.52, 0.68, 0.9, 1.3, 2.0, 3.0],
    run: (a, st, f) => {
      if (f === 18) {
        a.rig.group.updateMatrixWorld(true)
        const hip = a.rig.limbPos(0, new THREE.Vector3())
        a.rig.hit(new THREE.Vector3(0, 4, 11).multiplyScalar(a.rig.mass), hip.add(new THREE.Vector3(0, 0.3, -0.5)))
      }
      tick(a, st.env, { speed: f < 18 ? WALK : 0 })
    },
  },
  // a sprinting body clipped hard by something big, seen from above so the
  // splay of the heap it lands in can be judged: arms and legs flung out
  splay: {
    frames: [0.34, 0.45, 0.58, 0.72, 0.9, 1.3, 2.0, 3.0],
    cam: [Math.PI - 0.35, 10, 8.5],
    run: (a, st, f) => {
      if (f === 20) {
        a.rig.group.updateMatrixWorld(true)
        const chest = a.rig.limbPos(1, new THREE.Vector3())
        a.rig.hit(new THREE.Vector3(12, 9, 5).multiplyScalar(a.rig.mass), chest.add(new THREE.Vector3(-0.5, -0.3, 0.3)))
      }
      tick(a, st.env, { speed: f < 20 ? RUN : 0, run: true })
    },
  },
  // a heap getting up: knocked down, left to settle, then the recovery
  recover: {
    frames: [1.9, 2.05, 2.2, 2.35, 2.5, 2.65, 2.85, 3.2],
    run: (a, st, f) => {
      if (f === 5) a.rig.flop(1, 7, 4)
      if (f === 110) getUp(a)
      tick(a, st.env)
    },
  },
  // standing about: breathing, blinking, glancing, and the fidgets
  idle: {
    frames: [0.6, 1.2, 1.9, 2.6, 3.3, 4.2, 5.1, 6.0],
    run: (a, st, f) => {
      if (f === 60) a.rig.emote('bounce')
      if (f === 240) a.rig.emote('look')
      tick(a, st.env)
    },
  },
}

const strip = (spec: BodySpec, name: string, snap: Snap) => {
  const act = ACTIONS[name]
  if (!act) throw new Error(`no body strip "${name}"; try ${Object.keys(ACTIONS).join(', ')}`)
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  // travel along +x: yaw -PI/2 faces +x in the walk's convention
  const a = actor(st, LOOKS[0], st.x - 8, st.z, -Math.PI / 2)
  const end = act.frames[act.frames.length - 1]
  let next = 0
  const chest = new THREE.Vector3()
  for (let f = 0; next < act.frames.length && f < 60 * (end + 1); f++) {
    act.run(a, st, f)
    const t = (f + 1) / 60
    while (next < act.frames.length && t >= act.frames[next] - 1e-6) {
      if (a.rig.down) a.rig.focus(chest)
      // on the ground's height, not the body's: a camera that rides up with a
      // jump films a jump as nothing happening
      else chest.set(a.x, terrainY(a.x, a.z) + 2.6, a.z)
      chest.y = Math.max(chest.y, a.y + 1.6)
      const [b, d, u] = act.cam ?? [Math.PI - 0.5, 11, 1.6]
      snap(`${name} ${act.frames[next].toFixed(2)}s`, camAt(tw, th, chest, b, d, u, 38))
      next++
    }
  }
}

/** what the first-person lens sees of your own body, placed exactly as
    CrtScene's `poseBody` places it: trailing the lens by BODY_BACK, sliding
    further back as the pitch goes down */
const BODY_BACK = 0.62
const firstPerson = (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  for (const [pitch, speed] of [[-0.35, 0], [-0.8, 0], [-1.3, 0], [-0.8, WALK]] as const) {
    const a = actor(st, LOOKS[0], st.x, st.z, 0)
    a.pose.show = 0
    const cam = new THREE.PerspectiveCamera(75, tw / th, 0.05, 900)
    for (let f = 0; f < 90; f++) {
      const down = Math.max(0, -pitch) / 1.35
      const back = BODY_BACK + 0.55 * down * down
      a.pose.pitch = pitch
      tick(a, st.env, { speed })
      // the lens is where the walker's head is; the body trails behind it,
      // so from the body the lens is `back` further along the facing (-Z)
      cam.position.set(a.x, a.y + EYE, a.z - back)
    }
    cam.rotation.order = 'YXZ'
    cam.rotation.set(pitch, 0, 0)
    snap(`fp pitch ${pitch}${speed ? ' walking' : ''}`, cam)
    if (pitch === -1.3) {
      // the same body as the lens draws it, seen from outside: what is kept
      // of it under the first-person cut, and the cap over the cut
      snap('fp body from outside', camAt(tw, th, new THREE.Vector3(a.x, a.y + 2.4, a.z), Math.PI - 0.9, 7, 3, 40))
    }
    st.scene.remove(a.rig.group)
  }
}

/** seated in each machine's real seat node, from outside and from the side */
const seats = (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  const vmats = createVehicleMaterials({ texture: (t) => t, add: (d) => d })
  const builders = [buildCar, buildBoat, buildHeli] as const
  builders.forEach((build, i) => {
    const v = build({ mats: vmats })
    const x = st.x + (i - 1) * 16
    v.root.position.set(x, terrainY(x, st.z) + (i === 1 ? 0.9 : 0), st.z)
    v.root.rotation.y = Math.PI / 2
    st.scene.add(v.root)
    for (const [seat, look] of [[v.driverSeat, LOOKS[0]], [v.passengerSeat, LOOKS[1]]] as const) {
      const rig = buildPlayerBody(EYE, GRAV, look)
      rig.sit(seat.userData.fit ?? CABIN_FIT, seat === v.passengerSeat)
      seat.add(rig.group)
      rig.group.position.set(0, 0, 0)
      rig.group.rotation.set(0, Math.PI, 0)
    }
    v.root.updateMatrixWorld(true)
    const at = new THREE.Vector3(x, st.gy + 2.2, st.z)
    snap(`${v.id} side`, camAt(tw, th, at, Math.PI / 2 + 1.25, 13, 3.5))
    snap(`${v.id} low`, camAt(tw, th, at, Math.PI + 0.15, 11, -0.6))
    // and with the machine hidden, the pose alone, where its seat put it
    v.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) o.visible = false
    })
    snap(`${v.id} bare`, camAt(tw, th, at, Math.PI / 2 + 1.25, 13, 3.5))
    st.scene.remove(v.root)
  })
}

/*
  A machine on its own (body:car, body:heli, body:boat), the way somebody
  meets it: three-quarter front, side,
  three-quarter rear and a low front, with two beans in its seats, lit for
  the stage's moment. At night the machine is told it is night, so the lamps
  and both headlamp beams are on, and the look is dressed for the dark.
*/
/** open plains outside any town, flat and dry, with nothing within a
    helicopter's length: the machines are judged on their own, not against
    a street's houses, which in a town fill every tile's foreground */
let machineSite: { x: number; z: number } | null = null
const openSite = () => {
  for (let r = 1; r < 400; r++) {
    const n = r * 6
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = 300 + Math.cos(a) * r * 20
      const z = 300 + Math.sin(a) * r * 20
      const ok = (px: number, pz: number) =>
        placeAt(px, pz).district === null && slopeAt(px, pz) < 0.05 && terrainY(px, pz) > 2 &&
        biomeAt(px, pz, terrainY(px, pz), slopeAt(px, pz)) === 'plains' && !landmarkAt(px, pz)
      let all = true
      for (const [dx, dz] of [[0, 0], [30, 0], [-30, 0], [0, 30], [0, -30], [21, 21], [-21, -21], [21, -21], [-21, 21]]) {
        if (!ok(x + dx, z + dz)) { all = false; break }
      }
      if (all) return { x, z }
    }
  }
  return { x: 300, z: 300 }
}
const machine = (build: typeof buildCar, empty = false) => (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  machineSite ??= openSite()
  const st = stage(spec.tod, machineSite)
  const vmats = createVehicleMaterials({ texture: (t) => t, add: (d) => d })
  const v = build({ mats: vmats })
  // stood on its lowest point: a boat's origin is its waterline, so on the
  // grass it would sit with its keel in the ground
  v.root.updateMatrixWorld(true)
  const low = Math.min(0, new THREE.Box3().setFromObject(v.root).min.y)
  v.root.position.set(st.x, terrainY(st.x, st.z) - low, st.z)
  // nose toward -x, so bearings below read as: pi/2 is the right flank
  v.root.rotation.y = Math.PI / 2
  st.scene.add(v.root)
  vmats.setDay(st.sky.day, st.sky.night, st.sky.fogColor, st.sky.sunEl)
  v.setDay?.(st.sky.day, st.sky.night)
  const riders: THREE.Object3D[] = []
  for (const [seat, lk] of [[v.driverSeat, LOOKS[0]], [v.passengerSeat, LOOKS[1]]] as const) {
    if (empty) break
    const rig = buildPlayerBody(EYE, GRAV, lk)
    rig.sit(seat.userData.fit ?? CABIN_FIT, seat === v.passengerSeat)
    seat.add(rig.group)
    rig.group.position.set(0, 0, 0)
    rig.group.rotation.set(0, Math.PI, 0)
    riders.push(rig.group)
  }
  v.root.updateMatrixWorld(true)
  // how the riders fit, in the car's own heights: the skinned extent of the
  // seated body, crown (hat included) to the seat of the pants
  const fit = riders.map((g) => {
    const bx = new THREE.Box3().setFromObject(g, true)
    const y0 = v.root.position.y + low
    return `${(bx.min.y - y0).toFixed(2)}..${(bx.max.y - y0).toFixed(2)}`
  }).join(', ')
  // framed off the machine's own size, so a helicopter fits its tiles too
  const k = Math.max(1, v.size.halfZ / 4.5)
  const at = new THREE.Vector3(st.x, st.gy + Math.max(1.4, v.size.height * 0.42), st.z)
  const shots: Array<[string, number, number, number, number]> = [
    ['three-quarter front', -Math.PI / 2 + 0.75, 15 * k, 4.5 * k, 34],
    ['side', Math.PI, 16 * k, 2.6 * k, 34],
    ['three-quarter rear', Math.PI / 2 + 0.8, 15 * k, 4.5 * k, 34],
    ['low front', -Math.PI / 2 - 0.35, 12 * k, 0.6, 34],
    ['seated, from above', Math.PI - 0.5, 9 * k, 6.5 * k, 40],
  ]
  for (const [label, bearing, dist, up, fov] of shots) {
    const cam = camAt(tw, th, at, bearing, dist, up, fov)
    if (look) dressLook(look, st.scene, st.sky, cam, 'town', [], false)
    snap(label === 'side' ? `${v.id} side (riders span y ${fit})` : `${v.id} ${label}`, cam)
  }
  st.scene.remove(v.root)
}

/** every headgear, one each, close, on a spread of builds, outfits and
    colours: the wardrobe in one sheet */
const WARDROBE: PlayerLook[] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((hat) => ({
  shell: ['#2f6fcf', '#d2452f', '#3f9a38', '#e0a21a', '#8a4fc8', '#d9508f', '#1f9a8a', '#e8e2d2', '#2f6fcf'][hat],
  trim: ['#f2eee0', '#f2eee0', '#e0a218', '#2f6fcc', '#1c1c20', '#3f9a38', '#d2452c', '#8a4fc8', '#d2452c'][hat],
  accent: ['#c84028', '#1c1c20', '#f0e8e0', '#e86810', '#e8b818', '#2860c8', '#c84028', '#e86810', '#c84028'][hat],
  glow: ['#1c1a20', '#1c1a20', '#2b3a50', '#1c1a20', '#4a2e20', '#1c1a20', '#f4f1e0', '#1c1a20', '#1c1a20'][hat],
  hat,
  costume: [0, 2, 1, 0, 3, 0, 1, 2, 4][hat],
  build: [0, 1, 2, 3, 4, 0, 1, 2, 0][hat],
}))
const wardrobe = (spec: BodySpec, snap: Snap) => {
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  for (const look of WARDROBE) {
    const a = actor(st, look, st.x, st.z, 0)
    for (let f = 0; f < 200; f++) tick(a, st.env)
    snap(`hat ${look.hat} build ${look.build} outfit ${look.costume}`,
      camAt(tw, th, new THREE.Vector3(st.x, st.gy + 2.9, st.z), Math.PI - 0.55, 10, 1.4, 34))
    st.scene.remove(a.rig.group)
  }
}

/*
  Where the skin folds: a posed body with every triangle that faces against
  its own skinned vertex normals painted red over it (the same test
  `npm run measure -- body folds` counts). A number says how many; this says
  whether they are out on the flank where anyone would see them or buried
  inside a crease where nobody can.
*/
const foldOverlay = (rig: PlayerRig): THREE.Mesh => {
  let mesh: THREE.SkinnedMesh | null = null
  rig.group.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh })
  const m = mesh!
  rig.group.updateMatrixWorld(true)
  m.skeleton.update()
  const g = m.geometry
  const P = g.getAttribute('position')
  const N = g.getAttribute('normal')
  const SI = g.getAttribute('skinIndex')
  const SW = g.getAttribute('skinWeight')
  const I = g.getIndex()!
  const live: THREE.Vector3[] = []
  const liveN: THREE.Vector3[] = []
  const bm = m.skeleton.boneMatrices!
  const rot = m.skeleton.bones.map((_, b) => {
    const e = bm.subarray(b * 16, b * 16 + 16)
    return new THREE.Matrix3().set(e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10])
  })
  for (let i = 0; i < P.count; i++) {
    live.push(m.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(P, i)).applyMatrix4(m.matrixWorld))
    const n = new THREE.Vector3()
    for (let k = 0; k < 4; k++) {
      const w = SW.getComponent(i, k)
      if (w) n.addScaledVector(new THREE.Vector3().fromBufferAttribute(N, i).applyMatrix3(rot[SI.getComponent(i, k)]), w)
    }
    liveN.push(n)
  }
  const out: number[] = []
  const u = new THREE.Vector3()
  const w = new THREE.Vector3()
  for (let t = 0; t < I.count; t += 3) {
    const [a, b, c] = [I.getX(t), I.getX(t + 1), I.getX(t + 2)]
    u.subVectors(live[b], live[a])
    w.subVectors(live[c], live[a])
    const n = u.clone().cross(w)
    const s = liveN[a].clone().add(liveN[b]).add(liveN[c])
    if (n.lengthSq() < 1e-14 || n.normalize().dot(s.normalize()) > -0.3) continue
    for (const q of [a, b, c]) out.push(live[q].x, live[q].y, live[q].z)
  }
  const og = new THREE.BufferGeometry()
  og.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
  const om = new THREE.Mesh(og, new THREE.MeshBasicMaterial({ color: 0xff1030, side: THREE.DoubleSide, depthTest: false }))
  om.renderOrder = 10
  return om
}
const FOLD_SHOTS: Array<[string, number]> = [
  ['idle', 310], ['walk', 12], ['run', 8], ['crouch', 40], ['stretch', 54], ['ragdoll', 34], ['splay', 70], ['recover', 54],
]
const folds = (spec: BodySpec, snap: Snap, who = 0) => {
  const [tw, th] = spec.tile
  const st = stage(spec.tod)
  for (const [name, at] of FOLD_SHOTS) {
    const a = actor(st, LOOKS[who] ?? LOOKS[0], st.x - 8, st.z, -Math.PI / 2)
    for (let f = 0; f <= at; f++) {
      if (name === 'crouch') tick(a, st.env, { crouch: 1 })
      else if (name === 'stretch') {
        if (f === 10) a.rig.emote('stretch')
        tick(a, st.env)
      } else ACTIONS[name].run(a, st, f)
    }
    const ov = foldOverlay(a.rig)
    st.scene.add(ov)
    const c = new THREE.Vector3()
    if (a.rig.down) a.rig.focus(c)
    else c.set(a.x, a.y + 2.2, a.z)
    snap(`${name} @${at}: ${ov.geometry.getAttribute('position').count / 3} folded`, camAt(tw, th, c, Math.PI - 0.6, 8, 1.2, 36))
    st.scene.remove(ov)
    st.scene.remove(a.rig.group)
  }
}

/* -------------------------------------------------------------- shooting -- */

let renderer: THREE.WebGLRenderer | null = null
let look: PixelLook | null = null

export const shootBody = (spec: BodySpec) => {
  // every body here is photographed finished, never in a stand-in variant
  setBodyBuildSync(true)
  const canvas = document.getElementById('c') as HTMLCanvasElement
  const [tw, th] = spec.tile
  // collect the snapshots first: each renders straight away, into its slot
  const labels: string[] = []
  const cols = spec.cols
  // an upper bound on the tile count, so the canvas is sized before drawing
  const count = spec.targets.reduce((n, t) => {
    const a = t.arg ?? ''
    if (a === 'lineup') return n + 3
    if (a === 'closeup') return n + 4
    if (a === 'size') return n + 1
    if (a === 'astronaut') return n + 3
    if (a === 'moon') return n + 1
    if (a === 'motion') return n + 8 * Object.keys(ACTIONS).length
    if (a.startsWith('strip')) return n + 8
    if (a === 'fp') return n + 5
    if (a === 'seat') return n + 9
    if (/^(car|heli|boat|ship)(-empty)?$/.test(a)) return n + 5
    if (a.startsWith('folds')) return n + FOLD_SHOTS.length
    if (a === 'wardrobe') return n + WARDROBE.length
    return n
  }, 0)
  const motionOnly = spec.targets.every((t) => t.arg === 'motion' || t.arg?.startsWith('strip'))
  const perRow = motionOnly ? 8 : cols
  const rows = Math.ceil(count / perRow)
  canvas.width = tw * perRow
  canvas.height = th * rows
  look?.dispose()
  look = null
  renderer?.dispose()
  // the game's own post pass, as the shoot uses: a body judged at full
  // resolution is judged in a look nobody will ever see it in
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !!spec.raw })
  renderer.setPixelRatio(1)
  renderer.setSize(canvas.width, canvas.height, false)
  if (spec.raw) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
  } else {
    look = createPixelLook(renderer)
    look.knobs.lines = spec.lines || Math.round(th / Math.max(2, spec.pixel || 2))
  }
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  let slot = 0
  const warmed = new WeakSet<THREE.Scene>()
  const snap = (sc: THREE.Scene) => (label: string, cam: THREE.PerspectiveCamera) => {
    const r = renderer!
    const col = slot % perRow
    const row = Math.floor(slot / perRow)
    const px = col * tw
    const py = canvas.height - (row + 1) * th
    // the sun's shadow follows whatever is being looked at
    sc.traverse((o) => {
      const l = o as THREE.DirectionalLight
      if (l.isDirectionalLight && l.castShadow) {
        const tgt = new THREE.Vector3()
        cam.getWorldDirection(tgt)
        const focus = cam.position.clone().addScaledVector(tgt, 10)
        const off = l.position.clone().sub(l.target.position)
        l.target.position.copy(focus)
        l.position.copy(focus).add(off)
        l.target.updateMatrixWorld()
        l.shadow.camera.left = -25; l.shadow.camera.right = 25
        l.shadow.camera.top = 25; l.shadow.camera.bottom = -25
        l.shadow.camera.updateProjectionMatrix()
      }
    })
    sc.updateMatrixWorld(true)
    // a stage's first draw compiles its programs and uploads its buffers;
    // pay that into one pixel first, so the first tile is not the one that
    // shows the street half-built
    if (!warmed.has(sc)) {
      warmed.add(sc)
      r.setScissorTest(true)
      r.setViewport(0, 0, 1, 1)
      r.setScissor(0, 0, 1, 1)
      r.render(sc, cam)
    }
    r.setScissorTest(true)
    r.setViewport(px, py, tw, th)
    r.setScissor(px, py, tw, th)
    if (look) look.render(sc, cam)
    else r.render(sc, cam)
    labels.push(label)
    slot++
  }
  for (const t of spec.targets) {
    const a = t.arg ?? ''
    // every run builds its own stage; a snap draws whichever was built last
    const run = (fn: (sp: BodySpec, s: Snap) => void) =>
      fn(spec, (label, cam) => snap(lastStage!.scene)(label, cam))
    if (a === 'lineup') run(lineup)
    else if (a === 'closeup') run(closeup)
    else if (a === 'size') run(size)
    else if (a === 'astronaut') run(astronaut)
    else if (a === 'moon') run(moonShot)
    else if (a === 'motion') for (const n of Object.keys(ACTIONS)) run((sp, s) => strip(sp, n, s))
    else if (a.startsWith('strip:')) run((sp, s) => strip(sp, a.slice(6), s))
    else if (a === 'fp') run(firstPerson)
    else if (a === 'seat') run(seats)
    else if (/^(car|heli|boat|ship)(-empty)?$/.test(a)) {
      const which = a.replace('-empty', '')
      const build = which === 'car' ? buildCar : which === 'heli' ? buildHeli : which === 'boat' ? buildBoat : buildShip
      run(machine(build, a.endsWith('-empty')))
    }
    else if (a === 'wardrobe') run(wardrobe)
    else if (a.startsWith('folds')) run((sp, sn) => folds(sp, sn, Number(a.split(':')[1] ?? 0)))
    else throw new Error(`unknown body target "${a}"`)
  }
  return { labels, width: canvas.width, height: canvas.height, cols: perRow }
}
