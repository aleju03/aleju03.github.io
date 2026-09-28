import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import type { ImpactWatch } from '../player/impacts'
import type { Bumpable } from '../player/bodyContact'
import type { GrabHandle } from '../world/pedestrians'
import { doorCreak, doorLatch, propSnap, type StepSurface } from '../core/sfx'
import { buildSky, type SkyFrame, type SkyState } from './sky'
import { YARD } from './houseWorld'
import { domeScaleFor, fogForAltitude, viewFarFor } from './altitude'
import type { LevelShift } from './types'
import type { SandboxGround } from '../sandbox/ground'
import {
  curveK, EARTH_IN_MOON_SKY, EARTH_R, EARTH_SKY_DIST, flyScale, globeRadius, GROUND_OFF, groundK,
  horizonDist, MOON_ANCHOR, MOON_DIST, MOON_FAR, MOON_FORGET, MOON_LEAVE, MOON_ORIGIN, MOON_R,
  MOON_SEAM, MOON_TOD, nearFor, spaceK, SWING_FROM, SWING_TO,
} from './space'

/*
  Everything past the property line: the sky above it (sky.ts) and the endless
  ground under it (src/game/world/*). This module is the seam between them and
  the one thing the scene talks to.

  It used to *be* the outside: a 104x82 rectangle of hand-placed street,
  seven shell houses, a meadow disc and three rings of fake towers on the
  horizon, with a hard clamp at the edge. All of that is gone. The ground is
  now chunk-streamed procedural terrain with biomes, water, roads and real
  cities you can walk into, and the only hand-authored thing left out here is
  the house's own property, which the world generator treats as a hole.

  Three jobs beyond composition:

  - **it decides whether the planet exists at all.** The sky is eager and the
    world is not. Most visitors come for the desktop on the CRT, and building
    an endless procedural planet (plus compiling its outdoor shader variants)
    before they can read the screen was seconds charged to a boot that never
    needed it. So `buildOutsideWorld` puts up the sky, a fog-bound ground plane
    and nothing else, and `attachWorld()` brings in `src/game/world/*` through a
    dynamic import the first time somebody actually opens the front door (or
    immediately, on the /world route). Everything world-shaped below reads
    through a mutable `w` handle that is null until then, which is what lets the
    levels, the walk and the chase boom hold references from the first frame.
  - it decides *when* the world streams. The backrooms are a hundred and
    twenty units below the overworld with their own coordinates, and a player
    wandering that maze would otherwise drag the overworld's chunk ring along
    behind them, rebuilding the surface around coordinates nobody is standing
    on. The level system calls setActive(false) on the way down.
  - it answers where the ground and the waterline are, which is the contract
    the walk, the ragdoll and the chase boom all read the world through.
  - **it is where the planet ends.** Climbing, the far field bends onto the
    planet's curve, the globe (world/globe.ts) takes over past its rim, the
    sky thins (sky.ts's `space`) and the streamed ground dithers out and
    stops streaming, all on levels/space.ts's bands of height. Past
    MOON_ANCHOR the Moon is pinned out there as a body you can fly to, in the
    space frame (see "the way up" below): the Earth and the Moon are drawn
    relative to you, and coming in to land the whole of space swings round
    you until the Moon is underfoot, with the Moon level's own ground riding
    on it, so `moonSeam` and `earthSeam` are seamless (a shift, no card). On
    the Moon (`setVenue('moon')`) this same module draws its sky: no ground
    of the Earth's, the Moon's terrain in its own coordinates and the globe's
    Moon past it, black air, and the Earth hung where it was when you came
    in. The portal gun reaches the same Moon a second way (`moonPortal`): a
    shot at the sky's Moon by night opens on a fixed spot there, whose
    ground and whose Earth this module makes ready a slice a frame, and the
    view through the pair dresses the scene as the Moon for the one pass
    (`dress`) and puts the night back after.
    On a map (`setVenue('away')`, levels/maps.ts) it draws the Earth's sky
    and nothing of its ground: the map stands far off in the scene with a
    ground of its own, and the sky goes on following the lens there.

  The one thing the room tier cannot skip is *something to see out of the
  windows*. Past the yard fence the streamed terrain is simply absent, which
  reads as a void where the ground should be rather than as distance, so the
  room tier lays one big plane at y=0 in the grass colour and lets the fog eat
  it, and hides it the moment real terrain arrives.
*/

/** how far off a felled prop's snap is still heard, units (full within 12) */
const SNAP_EARSHOT = 60

/** the lazily-loaded half: everything in src/game/world the room does not need */
type WorldModules = {
  globe: typeof import('../world/globe')
  moon: typeof import('./moon')
  streamer: typeof import('../world/streamer')
  wind: typeof import('../world/wind')
  terrain: typeof import('../world/terrain')
  birds: typeof import('../world/birds')
  fauna: typeof import('../world/fauna')
  pedestrians: typeof import('../world/pedestrians')
  debris: typeof import('../world/debris')
  shopDoors: typeof import('../world/shopDoors')
}

interface WorldParts {
  mods: WorldModules
  world: ReturnType<WorldModules['streamer']['buildWorld']>
  birds: ReturnType<WorldModules['birds']['buildBirds']>
  fauna: ReturnType<WorldModules['fauna']['buildFauna']>
  pedestrians: ReturnType<WorldModules['pedestrians']['buildPedestrians']>
  debris: ReturnType<WorldModules['debris']['buildDebris']>
  shopDoors: ReturnType<WorldModules['shopDoors']['buildShopDoors']>
  globes: ReturnType<WorldModules['globe']['buildGlobes']>
  moon: ReturnType<WorldModules['moon']['buildMoon']>
}

export type OutsideState = SkyState

/** where the sky is being drawn over (see setVenue) */
export type Venue = 'earth' | 'moon' | 'away'

export interface OutsideHandles {
  /** the sky and the streamed world, under one group the levels can hide */
  root: THREE.Group
  /** advance the cycle (wall clock), restyle the sky and stream the chunk
      ring around the camera; call once per rendered frame. todOverride pins
      the time of day for probes. */
  update: (camPos: THREE.Vector3, todOverride?: number) => OutsideState
  /** the height of the drawn ground anywhere in the world */
  groundYAt: (x: number, z: number) => number
  /** the waterline; ground below it is sea, lake or river bed */
  waterY: number
  /** what a footstep lands on out here */
  surfaceAt: (x: number, z: number) => StepSurface
  /** how far the drawn sea surface is displaced from `waterY` at a point,
      right now. A hull floated on the flat waterline sits inside the crests
      and under the troughs; this is the swell the water shader draws, so a
      boat rides the sea that is actually on screen */
  waveAt: (x: number, z: number) => number
  /** drop the water shader's splash rings at a point (nothing before the
      world attaches) */
  splash: (x: number, z: number) => void
  /** true while the property owns the ground under this point: the house
      answers for its own lawn, porch and paths */
  onProperty: (x: number, z: number) => boolean
  /** the sun, whose stable shadow program is warmed by one covered render;
      strength and map updates sleep independently indoors and at night */
  sun: THREE.DirectionalLight
  /** the shop door within reach the player is looking at, and its verb;
      same contract as the house's, so the scene can ask both in one breath */
  doorPrompt: (p: THREE.Vector3, gaze: THREE.Vector3) => 'open' | 'close' | null
  /** work that shop door */
  useDoor: (p: THREE.Vector3, gaze: THREE.Vector3) => boolean
  /** stop streaming while another level is live (see the header) */
  setActive: (on: boolean) => void
  /** build the ring around a point without waiting for the frame budget. The
      two inner rings always; `ms` milliseconds of the outer ones on top,
      which only a boot with a cover over it can afford to spend. A no-op
      until the world has been attached. */
  prime: (x: number, z: number, ms?: number) => void
  /** whether the procedural planet is loaded yet */
  hasWorld: () => boolean
  /** the collision boxes of a loaded chunk, whether or not the walker is
      near it; null for a chunk not built (or no world yet). The sandbox's
      props read the world's solids through this */
  chunkSolids: (cx: number, cz: number) => readonly Solid[] | null
  /** the buildings out here as destruction sees them (world/debris.ts's
      ruins), or null until the world is attached */
  ruins: () => import('../world/debris').Ruins | null
  /** ...and the props a car has knocked down, likewise */
  felling: () => import('../world/debris').Felling | null
  /** let the movers an impact watch is tracking knock the town's
      pedestrians over. A no-op until the world is attached */
  knockPeople: (watch: ImpactWatch) => void
  /** the sandbox's props against the crowd: shoved aside or bowled over
      (world/pedestrians.ts's `pressProps`) */
  pressPeople: (sb: import('../sandbox/sandbox').Sandbox) => void
  /** the town's pedestrians as bodies a grab beam can take by a limb
      (the physgun); empty until the world is attached */
  people: () => Iterable<{ key: string; rig: GrabHandle }>
  /** the town's pedestrians as bodies the walker bumps into
      (player/bodyContact.ts). One stable object, empty until the world is
      attached, so the walk frame can hold it from the first frame */
  crowd: Bumpable
  /** the nearest light fixtures out here, as xyz triples into `out`; 0 until
      the world is attached. For the look's lamp pools (render/atmosphere.ts) */
  nearLamps: (x: number, z: number, out: Float32Array, max: number) => number
  /** the biome under a point ('town' inside a settlement), or null in the
      room tier. The look thickens its air over woods and wetland and thins
      it over open country and down a street */
  biomeAt: (x: number, z: number) => string | null
  /** the camera's height over the ground at the last update, how far the
      far field reached past it, and the far plane that wants: the look's
      air and CrtScene's lens both read these. `space` is how much of the air
      is below you (0..1, levels/space.ts) and `fly` what noclip's speed is
      multiplied by at this height */
  readonly view: {
    readonly alt: number; readonly reach: number; readonly far: number
    readonly space: number; readonly fly: number
    /** how far the far field is bent onto the globe (0..1), and the near
        plane the lens wants at this height */
    readonly curve: number; readonly near: number
    /** the Moon's centre while it is pinned out there, else null, and how
        far off its surface you are (Infinity with no Moon) */
    readonly moon: THREE.Vector3 | null
    readonly surf: number
  }
  /** the overworld's seamless seams: onto the Moon once the approach has
      swung the frame all the way, and a re-base of the scene onto space
      after a trip (see the space frame) */
  moonSeam: (p: THREE.Vector3) => { to: string; shift: LevelShift } | null
  /** the Moon's seamless seam home: flying up off it */
  earthSeam: (p: THREE.Vector3) => { to: string; shift: LevelShift } | null
  /** which body the sky is drawn from. 'moon' draws the Moon's ground in its
      own coordinates, hides the Earth's and hangs the globe in the sky.
      'away' is a map (levels/maps.ts) standing somewhere else in the scene
      under the Earth's own sky: the sky goes on following the lens, and the
      Earth's ground is hidden and stops streaming */
  setVenue: (venue: Venue) => void
  /** the Moon's ground, for its level: the height, the lattice a sandbox
      stands on, the boulders' boxes, what a step lands on and the arrival */
  moon: {
    groundYAt: (x: number, z: number) => number
    ground: SandboxGround
    obstacles: Solid[]
    readonly spawn: { x: number; z: number; y: number; yaw: number }
  }
  /** the portal gun's way to the Moon (sandbox/tools/portalMoon.ts) */
  moonPortal: {
    /** the sky's Moon from the lens, when it is up over the Earth's ground
        at night (and the lens is not up in the sky, where it is a body) */
    skyMoon: (out: THREE.Vector3) => boolean
    /** the Moon's drawn ground, once the world is here: a portal there and
        the slab it stands on ride it */
    root: () => THREE.Object3D | null
    /** a slice of making the far side ready: the Moon's ground, and the
        Earth to hang in its sky, painted round (x, z). True once both are */
    prepare: (x: number, z: number, ms: number) => boolean
    /** a trip by portal arrives in this frame: the Earth hangs along
        `earthDir`, the Moon's own sun, nothing swung */
    land: (earthDir: THREE.Vector3) => void
    /** draw the scene as the Moon for one pass from `cam` (its ground where
        the level puts it, the Earth's hidden, the sun the Moon's, the Earth
        hung in its sky). Returns the undressing, or null when it cannot be
        done here (up in the sky, where the globes are the sky's own) */
    dress: (cam: THREE.Vector3) => (() => void) | null
    /** on the Moon: the Earth hanging in its sky, its direction into
        `out`, and its angular radius (0 when there is no Earth to aim at) */
    skyEarth: (out: THREE.Vector3) => number
    /** on the Moon, for one photograph of the Earth's side: its streamed
        ground shown and the Moon's put away. Returns the undressing */
    dressEarth: () => (() => void) | null
  }
  /** cut up to two ovals out of the grass and the wildflowers (open floor
      portals): centre and the two half-axes, world units. An empty list
      grows them back. A few uniforms, never a program */
  groundHoles: (holes: readonly { c: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3 }[]) => void
  /** the scene's sun and sky light, for the globes (they light themselves the
      way the ground under them is lit) */
  lightGlobes: (sun: THREE.Color, ambient: THREE.Color) => void
  /** show the globes out of sight for a covered compile (warmForRoam) */
  warmSpace: (on: boolean) => void
  /** fetch the world modules without building them; free to call early */
  preloadWorld: () => void
  /**
   * Load and build `src/game/world/*`, replacing the room tier's placeholder
   * ground. Idempotent and safe to call concurrently (every caller awaits the
   * same promise), so the front door, the /world route and any future entrance
   * can all just ask.
   */
  attachWorld: () => Promise<void>
}

interface BuildOpts {
  scene: THREE.Scene
  /** the shared obstacle list the house and desk already registered into;
      the world appends its own after theirs and truncates back on restream */
  obstacles: Solid[]
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

export function buildOutsideWorld(opts: BuildOpts): OutsideHandles {
  const { scene, obstacles, trackTexture, trackDisposable } = opts

  const root = new THREE.Group()
  scene.add(root)

  const sky = buildSky({ parent: root, trackTexture, trackDisposable })

  // everything that stands on the Earth's ground, so leaving it (orbit, the
  // Moon) is one flag
  const groundRoot = new THREE.Group()
  groundRoot.name = 'earth-ground'
  root.add(groundRoot)

  /*
    The room tier's stand-in for the planet: one plane at y=0 in the grass
    colour, wide enough to reach past the fog. Looking out of a window with no
    terrain built shows the background through the gap where the ground should
    be, which reads as a hole rather than as distance; this makes the gap
    read as "ground, receding into fog", which is what fog is for.

    UNLIT on purpose. As a Lambert surface it took part in the sun's shadow
    pass, and a plane this size inside that pass is nothing but shadow acne:
    horizontal bands out past the fence that re-shimmered every time the sun
    refreshed its hand-managed map, which reads as the whole outdoors flashing.
    A basic material cannot acne, cannot flicker with the light rig, and still
    takes the fog, which is the only thing this plane is actually for. It goes
    away the instant real terrain exists.
  */
  const placeholderGround = new THREE.Mesh(
    new THREE.PlaneGeometry(1200, 1200),
    new THREE.MeshBasicMaterial({ color: '#6f7d4a', fog: true }),
  )
  placeholderGround.castShadow = false
  placeholderGround.receiveShadow = false
  placeholderGround.rotation.x = -Math.PI / 2
  /*
    Under the yard, so the lawn wins. This has to be a real gap and it was not:
    both planes sat at -0.02, exactly coplanar, and two coplanar planes with
    `LessEqualDepth` do not resolve, they fight. Because they are tessellated
    completely differently (the lawn is one 42x58 quad, this is one 1200x1200
    quad) their interpolated depths disagree by a few ulps in a pattern that
    depends on where the camera is, so the ground outside the window swapped
    between the lawn's green and this one's olive in bands that moved on every
    frame the player did and froze the moment they stood still.

    A tenth of a unit is far more than the depth buffer needs to separate them
    at this range (precision here is about 1.5 mm at 50 units and 6 mm at 100),
    and far less than anyone can see as a step at the lawn's edge.
  */
  placeholderGround.position.y = -0.12
  placeholderGround.matrixAutoUpdate = false
  placeholderGround.updateMatrix()
  groundRoot.add(placeholderGround)
  trackDisposable(placeholderGround.geometry)
  trackDisposable(placeholderGround.material)

  /** null until attachWorld() resolves; everything world-shaped reads through it */
  let w: WorldParts | null = null
  let attaching: Promise<void> | null = null

  /**
   * Fetch and parse the world modules without building anything. Pure I/O, so
   * it can run while somebody is walking around the house without costing a
   * frame, which is the whole point: by the time they reach the front door the
   * download is already done and the covered wait is only the build and the
   * shader compile, not the network.
   */
  let modsPromise: Promise<WorldModules> | null = null
  const loadMods = () => {
    modsPromise ??= (async () => {
      const [globe, moon, streamer, terrain, birds, fauna, pedestrians, debris, shopDoors, wind] = await Promise.all([
        import('../world/globe'),
        import('./moon'),
        import('../world/streamer'),
        import('../world/terrain'),
        import('../world/birds'),
        import('../world/fauna'),
        import('../world/pedestrians'),
        import('../world/debris'),
        import('../world/shopDoors'),
        import('../world/wind'),
      ])
      return { globe, moon, streamer, terrain, birds, fauna, pedestrians, debris, shopDoors, wind }
    })()
    return modsPromise
  }

  const attachWorld = () => {
    attaching ??= (async () => {
      const mods = await loadMods()
      const {
        streamer, terrain, birds: birdsMod, fauna: faunaMod,
        pedestrians: pedMod, debris: debrisMod, shopDoors: shopDoorsMod,
      } = mods
      // the shops' hinged leaves: the streamer reports the near ring's door
      // specs, this manager owns the meshes, swing state and doorway blockers.
      // The sfx arrive here rather than inside the manager because core/sfx
      // fetches its clips at module load and world/* must stay headless-safe.
      const shopDoors = shopDoorsMod.buildShopDoors({
        parent: groundRoot,
        obstacles,
        sfx: { creak: doorCreak, latch: doorLatch },
        trackDisposable,
      })
      // ...and the same arrangement for the props a car can drive through: the
      // manager owns the flattened set and the flying bodies, the streamer tells
      // it about every chunk it builds, and the snap arrives as a callback for
      // the same headless reason the doors' creak does
      const debris = debrisMod.buildDebris({
        parent: groundRoot,
        obstacles,
        groundAt: terrain.terrainY,
        // the snap is not spatialised, so one down the street (somebody
        // else's car, net/remoteDamage.ts) is quieter by distance and one
        // past earshot is not heard at all
        onSnap: (hard, x, z) => {
          const d = Math.hypot(x - heard.x, z - heard.z)
          if (d < SNAP_EARSHOT) propSnap(hard * Math.min(1, (SNAP_EARSHOT - d) / (SNAP_EARSHOT - 12)))
        },
        trackDisposable,
      })
      debris.ruins.onSolids = () => world.resolid()
      // `rebuild`: forget what was broken, then build the ring again whole
      debris.ruins.reset = () => {
        debris.forget()
        world.rebuild()
      }
      const world = streamer.buildWorld({
        scene: groundRoot,
        obstacles,
        onNearDoors: shopDoors.sync,
        onChunk: (c) => debris.arm(c.smash),
        trackTexture,
        trackDisposable,
      })
      // the flocks are neither sky nor ground: they hang off this seam because
      // they need the sky's daylight and the world's terrain height, and because
      // they must sleep with the streamer when another level is live
      const birds = birdsMod.buildBirds({ parent: groundRoot, trackDisposable })
      /*
        ...and the same seam for what lives on the ground. Both hang here for
        the flocks' reason — they need the world's terrain height and they
        must sleep with the streamer when another level is live — and both
        are session state that never streams and never travels.

        The animals' models are the one download in `src/game/world`, and
        they are deliberately *not* awaited: opening a front door must not
        also wait on six GLBs, so the herd is built empty and populates
        itself when they land. The pedestrians need nothing but the rig the
        player is already wearing, so they are live immediately.
      */
      const fauna = faunaMod.buildFauna({ parent: groundRoot, obstacles, trackDisposable })
      void faunaMod.loadFaunaModels().then((m) => fauna.setModels(m))
      const pedestrians = pedMod.buildPedestrians({
        parent: groundRoot,
        obstacles,
        groundAt: terrain.terrainY,
        trackDisposable,
      })

      // the planet from above and the Moon (see the header). The Moon's own
      // ground is built on first arrival; its material's stand-in is in the
      // scene now, so the covered compile that follows links it
      const globes = mods.globe.buildGlobes({ parent: root, trackDisposable })
      const moonParts = mods.moon.buildMoon({ parent: root, obstacles: moonObstacles, trackDisposable })
      root.add(moonParts.warm)

      w = { mods, world, birds, fauna, pedestrians, debris, shopDoors, globes, moon: moonParts }
      placeholderGround.visible = false
    })()
    return attaching
  }

  let active = true
  /** where the last update's camera was: how far off a felled prop snaps */
  const heard = new THREE.Vector3()
  /** what the last update saw from the camera, for the look and the lens */
  const view = {
    alt: 0, reach: 0, far: viewFarFor(0), space: 0, fly: 1, curve: 0, near: 0.1,
    moon: null as THREE.Vector3 | null, surf: Infinity,
  }

  let lastT = 0
  const groundBase = new THREE.Color('#6f7d4a')
  const placeholderMat = placeholderGround.material as THREE.MeshBasicMaterial

  /* ---- the way up (levels/space.ts) ---- */
  let venue: Venue = 'earth'
  /** the Moon level's boxes: its CollisionSet wraps this array from the
      first frame, and the Moon fills it when it is built */
  const moonObstacles: Solid[] = []
  /*
    The space frame. Out there nothing is anchored to the scene: the Earth
    is drawn under you and the Moon is pinned where you pinned it, both in
    *space* coordinates, and drawn relative to you. `ps` is where you are in
    space; each frame it moves by however far the scene moved you, turned by
    `q`, the frame's turn about the lens. Far from the Moon `q` is nothing
    and space is the scene; coming in to land, it swings the whole of space
    round you until the Moon's landing site is straight underfoot, so "down"
    (the walk's gravity, the ship's lift) becomes the Moon's down without the
    player's up ever changing. Once it has swung all the way, the Moon's
    ground out there is the Moon level's ground moved by one offset, and the
    level cut is carrying you by that offset: no card, no pop.
  */
  const ps = new THREE.Vector3()
  const lastW = new THREE.Vector3(Number.NaN, 0, 0)
  const q = new THREE.Quaternion()
  const qInv = new THREE.Quaternion()
  const qAlign = new THREE.Quaternion()
  const ID = new THREE.Quaternion()
  const UP = new THREE.Vector3(0, 1, 0)
  /** the Moon out there, in space: pinned when the climb passes MOON_ANCHOR,
      its landing site facing you until the approach freezes it */
  const moonAt = { on: false, centre: new THREE.Vector3(), pole: new THREE.Vector3(), frozen: false }
  /** the frame the Moon level was entered in: the offset it was entered by,
      the turn, the sun there and the Earth's direction and distance */
  const landing = {
    shift: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    sun: new THREE.Vector3(0.6, 0.55, 0.3).normalize(),
    earthDir: new THREE.Vector3(EARTH_IN_MOON_SKY.x, EARTH_IN_MOON_SKY.y, EARTH_IN_MOON_SKY.z),
    earthDist: MOON_DIST,
    pole: new THREE.Vector2(),
    turned: false,
  }
  const sunDir = new THREE.Vector3()
  const sunS = new THREE.Vector3()
  const sunIdeal = new THREE.Vector3()
  const tmpDir = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  const centreW = new THREE.Vector3()
  const poleW = new THREE.Vector3()
  const rot = new THREE.Quaternion()
  const origin3 = new THREE.Vector3(MOON_ORIGIN.x, 0, MOON_ORIGIN.z)
  const poleXZ = new THREE.Vector2()
  const skyFrame: SkyFrame = { q, sun: sunS }
  /** how far the frame has swung onto the Moon, 0..1, and how far off its
      surface you are, as of the last update */
  let swing = 0
  let moonSurf = Infinity
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  /** pin the Moon along the sky moon's bearing if it is well up, and
      otherwise along a bearing high in the sky, so a daytime climb still has
      somewhere to go */
  const pinMoon = () => {
    const m = sky.moonDir(tmpDir)
    if (m.y < 0.35) {
      const h = Math.hypot(m.x, m.z) || 1
      m.set((m.x / h) * Math.cos(0.75), Math.sin(0.75), (m.z / h) * Math.cos(0.75))
    }
    moonAt.centre.copy(ps).addScaledVector(m, MOON_DIST)
    moonAt.pole.copy(m).negate()
    moonAt.frozen = false
    moonAt.on = true
  }
  /** the Moon's morning over the landing site: the sky's own sun, tipped to
      a third of the way up the landing site's sky, so wherever you come in
      you land in low, raking light */
  const idealSun = (pole: THREE.Vector3, real: THREE.Vector3, out: THREE.Vector3) => {
    tmp2.copy(real).addScaledVector(pole, -real.dot(pole))
    if (tmp2.lengthSq() < 1e-6) tmp2.set(1, 0, 0).addScaledVector(pole, -pole.x)
    tmp2.normalize()
    return out.copy(pole).multiplyScalar(Math.sin(0.6)).addScaledVector(tmp2, Math.cos(0.6)).normalize()
  }
  /** carry `ps` by however far the scene moved the lens, turned into space */
  const track = (camPos: THREE.Vector3, frame: THREE.Quaternion) => {
    if (!Number.isFinite(lastW.x)) ps.copy(camPos)
    else {
      tmp2.subVectors(camPos, lastW)
      // a teleport (the console, a sit-down) is not a flight: the frame is
      // re-based on it rather than carried a kilometre in one step
      if (tmp2.lengthSq() > 4e8) ps.copy(camPos)
      else ps.add(tmp2.applyQuaternion(qInv.copy(frame).invert()))
    }
    lastW.copy(camPos)
  }

  const moonGround = (x: number, z: number) => (w ? w.mods.moon.moonGroundY(x, z) : 0)
  /** the Moon's centre in the Moon level: its sphere runs through the
      landing site at y 0 */
  const moonCentreL = new THREE.Vector3(MOON_ORIGIN.x, -MOON_R, MOON_ORIGIN.z)

  const updateMoon = (camPos: THREE.Vector3, todOverride?: number) => {
    track(camPos, landing.q)
    skyFrame.q = landing.q
    skyFrame.sun = landing.sun
    const state = sky.update(camPos, todOverride ?? MOON_TOD, 1, false, 0, skyFrame)
    skyFrame.q = q
    skyFrame.sun = sunS
    // no air: nothing is the colour of distance and nothing fades into it,
    // and nothing fills a shadow in, so the sun is all the light there is
    // and it is harsh
    state.fogNear = 1e6
    state.fogFar = 2e6
    sky.sun.intensity *= 2.6
    groundRoot.visible = false
    const alt = camPos.y - moonGround(camPos.x, camPos.z)
    moonSurf = camPos.distanceTo(moonCentreL) - MOON_R
    view.alt = Math.max(0, alt)
    view.reach = 0
    view.far = MOON_FAR
    view.space = 1
    view.fly = flyScale(Math.max(0, moonSurf))
    view.moon = null
    view.surf = moonSurf
    view.curve = 0
    view.near = 0.1
    sky.setScale(domeScaleFor(MOON_FAR))
    if (w) {
      sunDir.subVectors(sky.sun.position, sky.sun.target.position).normalize()
      w.globes.setSun(sunDir, performance.now() / 1000)
      // the Moon past its drawn ground, and the Earth where it hung when you
      // came in, drawn nearer and smaller so it keeps its angular size
      // inside the far plane
      w.globes.moonAt(moonCentreL, MOON_R, ID, 1, w.mods.moon.MOON_PATCH * 0.94)
      w.globes.earthInSky(
        camPos, landing.earthDir, EARTH_SKY_DIST, (EARTH_R * EARTH_SKY_DIST) / landing.earthDist,
        landing.turned ? landing.q : undefined, landing.turned ? landing.pole : undefined,
      )
    }
    return state
  }

  const update = (camPos: THREE.Vector3, todOverride?: number) => {
    heard.copy(camPos)
    if (venue === 'moon') return updateMoon(camPos, todOverride)
    // (on a map the sky is the Earth's and nothing else of it is: no ring,
    // no far field, no Moon to pin)
    const live = active && !!w && venue === 'earth'
    if (live) track(camPos, q)
    else {
      ps.copy(camPos)
      lastW.copy(camPos)
    }
    // the height the whole climb keys off, over the ground under you in
    // space (the scene's own, until a trip to the Moon swings the frame)
    const alt = Math.max(0, ps.y - (w ? w.mods.terrain.terrainY(ps.x, ps.z) : 0))
    const space = live ? spaceK(alt) : 0
    // the Moon out there, pinned on the way up and let go on the way down,
    // and the frame swung onto it as you close in (see the space frame)
    if (live && !moonAt.on && alt > MOON_ANCHOR) pinMoon()
    else if (moonAt.on && alt < MOON_FORGET) moonAt.on = false
    swing = 0
    moonSurf = Infinity
    if (live && moonAt.on) {
      moonSurf = ps.distanceTo(moonAt.centre) - MOON_R
      // the landing site turns to face you until the frame has swung all the
      // way, and is fixed from there down, where the ground under you is
      // the ground you land on
      if (moonSurf > SWING_TO) {
        moonAt.pole.subVectors(ps, moonAt.centre).normalize()
        moonAt.frozen = false
      } else moonAt.frozen = true
      qAlign.setFromUnitVectors(moonAt.pole, UP)
      swing = smooth(SWING_FROM, SWING_TO, moonSurf) // 0 far .. 1 aligned
    }
    q.slerpQuaternions(ID, qAlign, swing)
    // the sun: the sky's own, eased toward the Moon's morning as you swing in
    sky.sunDir(sunS)
    if (swing > 0) {
      idealSun(moonAt.pole, sunS, sunIdeal)
      sunS.lerp(sunIdeal, swing).normalize()
    }
    // how far below level the planet's limb is from up here, so the sky's
    // horizon blend starts where the ground does (sky.ts's uHorizonDip)
    const kDip = live ? curveK(alt) : 0
    const dip = kDip > 0.04 ? Math.acos(globeRadius(kDip) / (globeRadius(kDip) + alt)) : 0
    const state = sky.update(camPos, todOverride, space, true, dip, swing > 0 ? skyFrame : null)
    view.alt = 0
    view.reach = 0
    view.far = viewFarFor(0)
    view.space = space
    view.fly = flyScale(alt)
    view.moon = null
    view.surf = Infinity
    view.curve = 0
    view.near = nearFor(alt)
    // (the sky follows the lens: see SkyHandles.setScale; reset here and
    // grown again below when the world reports a far field in view)
    if (!live) sky.setScale(1)
    // the stand-in is unlit, so nothing in the light rig darkens it at dusk;
    // track the day cycle by hand or it stays noon-bright under a night sky
    if (!w) placeholderMat.color.copy(groundBase).multiplyScalar(0.16 + 0.84 * state.day)
    if (live && w) {
      // the sky is the only thing here with a wall clock, so the wind takes
      // its delta from the same place rather than from the walk loop, which
      // does not run during the intro flight, when the world is still visible
      const now = performance.now()
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016
      lastT = now
      /*
        How high the camera is over the ground under it, which is a number the
        world never needed until something could fly. Three things read it:
        the grass field (a 60-unit disc of blades pinned under an aircraft is
        both wrong and expensive), the splash detector (which asks only whether
        the *ground* below is under water, and would otherwise stamp ripples on
        the sea from cruising height), and the ring radius.

        And the fog goes with the ring, because it always has: the note in
        sky.ts explains that a 240-unit far plane hides an edge that is never
        closer than 256. From the air both numbers have to grow together: fog
        alone would reveal the edge, a wider ring alone would be invisible
        behind the fog. The ramp tops out at 120 units up, past which the
        ground is more than half fog anyway and there is nothing left to see.

        From orbit (levels/space.ts) the ground dithers out over the globe and
        then is neither drawn nor streamed: a flight across the planet at
        orbital speed would otherwise have the streamer rebuilding a ring
        nobody can see.
      */
      const gk = groundK(alt)
      groundRoot.visible = gk > 0
      let reach = 0
      if (gk > 0) {
        w.world.update(camPos.x, camPos.z, dt, alt)
        w.shopDoors.update(dt)
        w.debris.update(dt)
        w.birds.update(camPos, dt, state.day, state.twilight)
        w.fauna.update(camPos, dt)
        w.pedestrians.update(camPos, dt)
        /*
          From the air the far field (world/farfield.ts) draws the planet past
          the ring, and the fog opens out to its rim; the look's air takes the
          same altitude and reach (see `view` below), so what was a white wall
          from a hundred units up is a town and its hills to the horizon.
        */
        reach = w.world.farReach(camPos.x, camPos.z)
      }
      const k = curveK(alt)
      w.world.setSpace(k / (2 * EARTH_R), camPos.x, camPos.z, gk)
      fogForAltitude(state, alt, reach)
      if (space > 0) {
        state.fogNear += (1e6 - state.fogNear) * space
        state.fogFar += (2e6 - state.fogFar) * space
      }
      // the globe: painted around you once you are above anything the
      // helicopter can reach (so a flight costs nothing), shown once the bend
      // has begun, and alone once the ground has gone. Its bake and the
      // Moon's ground share one small budget a frame
      const g = w.globes
      if (alt > 250) g.wantEarth(ps.x, ps.z)
      if (space > 0) g.wantMoon()
      let budget = alt > 250 ? 1.6 : 0
      if (moonAt.on && !w.moon.built && moonSurf < SWING_FROM * 1.5) {
        const t0 = performance.now()
        w.moon.build(1.6)
        budget -= performance.now() - t0
      }
      if (budget > 0) g.work(budget)
      sunDir.subVectors(sky.sun.position, sky.sun.target.position).normalize()
      g.setSun(sunDir, now / 1000)
      const curvR = globeRadius(k)
      let far = viewFarFor(alt, reach)
      if (k > 0.04) {
        poleXZ.set(ps.x, ps.z)
        g.earthBelow({
          cam: camPos,
          poleY: w.mods.terrain.SEA_Y,
          curvR,
          hole: gk >= 0.999 ? reach * 0.97 : 0,
          fade: smooth(0.04, 0.2, k),
          q,
          pole: poleXZ,
          alt: ps.y - w.mods.terrain.SEA_Y,
          offset: gk > 0,
          clouds: 1 - gk,
          rim: space,
          halo: space,
        })
        far = Math.max(far, horizonDist(curvR, alt) * 1.6)
      } else {
        g.hideEarth()
      }
      const moonRoot = w.moon.root
      if (moonAt.on) {
        // the Moon in the scene: its centre relative to you, turned by the
        // frame, and its landing site's frame (level axes) turned with it
        centreW.subVectors(moonAt.centre, ps).applyQuaternion(q).add(camPos)
        rot.copy(qAlign).invert().premultiply(q)
        const showGround = w.moon.built && moonSurf < SWING_FROM
        g.moonAt(centreW, MOON_R, rot, smooth(0.04, 0.2, space), showGround ? w.mods.moon.MOON_PATCH * 0.94 : 0)
        // ...and its drawn ground on it, a rigid copy of the Moon level's
        // (the same meshes), from well out: by the time you land it has been
        // under you all the way down
        moonRoot.visible = showGround
        if (showGround) {
          poleW.set(0, MOON_R, 0).applyQuaternion(rot).add(centreW)
          moonRoot.quaternion.copy(rot)
          moonRoot.position.copy(origin3).applyQuaternion(rot).negate().add(poleW)
          moonRoot.updateMatrixWorld(true)
        }
        const dMoon = camPos.distanceTo(centreW)
        far = Math.max(far, (dMoon + MOON_R) * 2)
        // near the Moon the speed is the Moon's business, or you arrive at
        // orbital speed and go straight through it
        view.fly = flyScale(Math.min(alt, Math.max(0, moonSurf)))
      } else {
        g.hideMoon()
        moonRoot.visible = false
      }
      // far from the Moon with the frame unswung, the scene and space agree
      // again (a way home re-bases them, see earthSeam's `rebase`)
      view.alt = alt
      view.reach = reach
      view.far = far
      view.curve = k
      view.moon = moonAt.on ? centreW : null
      view.surf = moonSurf
      sky.setScale(domeScaleFor(view.far))
      // windows and streetlamps come up with the dark; the water takes its
      // colour from the fog, which is most of what makes it read as water
      w.world.setNight(state.night)
      w.world.setWaterTint(state.fogColor, state.day)
    }
    return state
  }

  /* ---- the portal gun's Moon (see the header) ---- */
  const dressSun = new THREE.Vector3()
  const dressSave = {
    sunPos: new THREE.Vector3(), sunTarget: new THREE.Vector3(), sunI: 0, sunColor: new THREE.Color(),
    shadowI: 0, shadowNeeds: false, rootPos: new THREE.Vector3(), rootQ: new THREE.Quaternion(),
    rootShown: false, groundShown: true,
  }
  const MOON_SUN_COLOR = new THREE.Color('#fff2dc')
  const moonPortal: OutsideHandles['moonPortal'] = {
    skyEarth: (out) => {
      if (venue !== 'moon' || !w || !w.globes.earthReady) return 0
      out.copy(landing.earthDir).normalize()
      return Math.asin(Math.min(0.99, EARTH_R / landing.earthDist))
    },
    dressEarth: () => {
      if (venue !== 'moon' || !w) return null
      const root = w.moon.root
      const rootShown = root.visible
      const groundShown = groundRoot.visible
      root.visible = false
      groundRoot.visible = true
      return () => {
        root.visible = rootShown
        groundRoot.visible = groundShown
      }
    },
    skyMoon: (out) => {
      if (venue !== 'earth' || !w || moonAt.on || view.space > 0.12) return false
      sky.moonDir(out)
      // up, and clear of the skyline: the disc sits low for a while at dusk
      return out.y > 0.06
    },
    root: () => (w ? w.moon.root : null),
    prepare: (x, z, ms) => {
      if (!w) return false
      const t0 = performance.now()
      const ground = w.moon.build(ms)
      const g = w.globes
      g.wantEarth(x, z)
      g.wantMoon()
      const left = ms - (performance.now() - t0)
      if (left > 0) g.work(left)
      return ground && g.earthReady
    },
    land: (earthDir) => {
      landing.shift.set(0, 0, 0)
      landing.q.identity()
      landing.sun.set(0.6, 0.55, 0.3).normalize()
      landing.earthDir.copy(earthDir).normalize()
      landing.earthDist = MOON_DIST
      landing.turned = false
    },
    dress: (cam) => {
      if (!w || venue !== 'earth' || moonAt.on || view.curve > 0.04 || !w.moon.built || !w.globes.earthReady) return null
      const sun = sky.sun
      const root = w.moon.root
      const S = dressSave
      S.sunPos.copy(sun.position)
      S.sunTarget.copy(sun.target.position)
      S.sunI = sun.intensity
      S.sunColor.copy(sun.color)
      S.shadowI = sun.shadow.intensity
      S.shadowNeeds = sun.shadow.needsUpdate
      S.rootPos.copy(root.position)
      S.rootQ.copy(root.quaternion)
      S.rootShown = root.visible
      S.groundShown = groundRoot.visible
      // the Moon's ground where its level puts it, the Earth's put away
      root.position.set(0, 0, 0)
      root.quaternion.identity()
      root.updateMatrixWorld(true)
      root.visible = true
      groundRoot.visible = false
      // the Moon's sun, as its level lights it (updateMoon), and no shadow:
      // the map is the Earth's, and this pass must not redraw it
      dressSun.copy(landing.sun)
      sun.target.position.set(cam.x, cam.y, cam.z + 10)
      sun.position.copy(sun.target.position).addScaledVector(dressSun, 60)
      sun.target.updateMatrixWorld()
      sun.updateMatrixWorld()
      sun.intensity = 2.3 * 2.6
      sun.color.copy(MOON_SUN_COLOR)
      sun.shadow.intensity = 0
      sun.shadow.needsUpdate = false
      // and the Earth hung in its sky, nearer and smaller as updateMoon has
      // it, lit by the Moon's sun (its day side toward you) rather than by
      // the night the Earth's own sky is having
      w.globes.setSun(landing.sun, performance.now() / 1000)
      w.globes.earthInSky(cam, landing.earthDir, EARTH_SKY_DIST, (EARTH_R * EARTH_SKY_DIST) / landing.earthDist)
      return () => {
        if (!w) return
        sun.position.copy(S.sunPos)
        sun.target.position.copy(S.sunTarget)
        sun.target.updateMatrixWorld()
        sun.updateMatrixWorld()
        sun.intensity = S.sunI
        sun.color.copy(S.sunColor)
        sun.shadow.intensity = S.shadowI
        sun.shadow.needsUpdate = S.shadowNeeds
        root.position.copy(S.rootPos)
        root.quaternion.copy(S.rootQ)
        root.updateMatrixWorld(true)
        root.visible = S.rootShown
        groundRoot.visible = S.groundShown
        w.globes.hideEarth()
        // (sunDir still holds the direction the frame's update set)
        w.globes.setSun(sunDir, performance.now() / 1000)
      }
    },
  }

  const onProperty = (x: number, z: number) =>
    x > YARD.minX - 1 && x < YARD.maxX + 1 && z > YARD.minZ - 1 && z < YARD.maxZ + 1

  /*
    The room tier's answers. Every one of these is read through a closure rather
    than handed out as a value, because the levels, the walk, the ragdoll and
    the chase boom all capture them on the first frame and must keep working
    across the moment the world arrives.

    The house pad is authored flat at y=0 and the generator holds the terrain
    flat under it, so 0 is not a placeholder for the property; it is the same
    answer the world would give. Only past the fence do they diverge, and past
    the fence is exactly where you cannot go until the world is here.
  */
  return {
    root,
    update,
    groundYAt: (x, z) => (w ? w.mods.terrain.terrainY(x, z) : 0),
    // no sea in the room tier: put the waterline far below anything reachable
    // so the walk's "is the water over my chest" test can never fire
    get waterY() {
      return w ? w.mods.terrain.SEA_Y : -1e6
    },
    surfaceAt: (x, z) => (w ? w.mods.terrain.surfaceAt(x, z) : 'grass'),
    waveAt: (x, z) => (w ? w.mods.streamer.waveHeightAt(x, z) : 0),
    splash: (x, z) => w?.world.splash(x, z),
    onProperty,
    sun: sky.sun,
    doorPrompt: (p, gaze) => (w ? w.shopDoors.doorPrompt(p, gaze) : null),
    useDoor: (p, gaze) => (w ? w.shopDoors.useDoor(p, gaze) : false),
    setActive: (on) => {
      active = on
    },
    prime: (x, z, ms) => w?.world.prime(x, z, ms),
    hasWorld: () => w !== null,
    chunkSolids: (cx, cz) => (w ? w.world.solidsIn(cx, cz) : null),
    ruins: () => w?.debris.ruins ?? null,
    felling: () => w?.debris.felling ?? null,
    knockPeople: (watch) => w?.pedestrians.knock(watch),
    pressPeople: (sb) => w?.pedestrians.pressProps(sb),
    people: () => (w ? w.pedestrians.grabbable() : []),
    crowd: {
      get size() {
        return w ? w.pedestrians.bumpable.size : 0
      },
      peer: (i, out) => (w ? w.pedestrians.bumpable.peer(i, out) : false),
      nudge: (i, dx, dz) => (w ? w.pedestrians.bumpable.nudge(i, dx, dz) : false),
      hit: (i, b) => w?.pedestrians.bumpable.hit(i, b),
      trample: (x, z, y, vx, vz, r) => w?.pedestrians.bumpable.trample?.(x, z, y, vx, vz, r) ?? 0,
    },
    nearLamps: (x, z, out, max) => (w ? w.world.nearLamps(x, z, out, max) : 0),
    biomeAt: (x, z) => {
      if (!w || venue !== 'earth') return null
      const s = w.mods.terrain.sampleAt(x, z)
      return s.place.district ? 'town' : s.biome
    },
    preloadWorld: () => void loadMods(),
    view,
    attachWorld,
    moonSeam: (p) => {
      void p
      if (venue !== 'earth' || !w || !Number.isFinite(lastW.x)) return null
      // far from the Moon with the frame unswung, the scene is re-based onto
      // space (a way home from the Moon leaves them apart by the trip's
      // offset): you are carried to where space says you are, and nothing
      // anchored to the scene is in view up here to show it
      if (swing === 0 && ps.y - w.mods.terrain.terrainY(ps.x, ps.z) >= GROUND_OFF &&
        lastW.distanceToSquared(ps) > 1) {
        const shift = { x: ps.x - lastW.x, y: ps.y - lastW.y, z: ps.z - lastW.z }
        lastW.copy(ps)
        return { to: 'overworld', shift }
      }
      // landing: the frame has swung all the way, so the Moon out there is
      // the Moon level moved by one offset, and crossing is that offset
      if (!moonAt.on || swing < 0.999 || !w.moon.built || moonSurf > MOON_SEAM) return null
      landing.shift.subVectors(poleW, origin3)
      landing.q.copy(q)
      landing.sun.copy(sunS)
      landing.earthDir.set(0, -1, 0).applyQuaternion(q)
      landing.earthDist = Math.max(EARTH_R * 1.5, ps.y - w.mods.terrain.SEA_Y + EARTH_R)
      landing.pole.set(ps.x, ps.z)
      landing.turned = true
      lastW.sub(landing.shift)
      return { to: 'moon', shift: { x: -landing.shift.x, y: -landing.shift.y, z: -landing.shift.z } }
    },
    earthSeam: (p) => {
      void p
      if (venue !== 'moon' || !w) return null
      // up off it and away: back into the scene's frame by the same offset,
      // with the frame still swung, so nothing moves
      if (moonSurf < MOON_LEAVE) return null
      lastW.add(landing.shift)
      return { to: 'overworld', shift: { x: landing.shift.x, y: landing.shift.y, z: landing.shift.z } }
    },
    setVenue: (v) => {
      if (v === venue) return
      const was = venue
      venue = v
      // the ground goes with a map and comes back with the Earth; the next
      // live update settles its visibility for the altitude
      if (v === 'away') groundRoot.visible = false
      else if (was === 'away') groundRoot.visible = true
      if (!w) return
      const moonRoot = w.moon.root
      if (v === 'moon') {
        w.moon.ensureBuilt()
        // the Moon's own coordinates: its ground where the level says it is
        moonRoot.position.set(0, 0, 0)
        moonRoot.quaternion.identity()
        moonRoot.updateMatrixWorld(true)
        moonRoot.visible = true
        groundRoot.visible = false
      }
      // (back on the Earth side the Moon stays pinned where it was, and the
      // next update carries its ground out there again)
    },
    moon: {
      groundYAt: moonGround,
      ground: {
        lattice: (i, j) => (w ? w.mods.moon.moonLattice(i, j) : 0),
        heightAt: moonGround,
      },
      obstacles: moonObstacles,
      get spawn() {
        return { x: MOON_ORIGIN.x, z: MOON_ORIGIN.z, y: moonGround(MOON_ORIGIN.x, MOON_ORIGIN.z) + 2, yaw: 0 }
      },
    },
    warmSpace: (on) => w?.globes.warm(on),
    groundHoles: (holes) => w?.mods.wind.setGroundHoles(holes),
    moonPortal,
    lightGlobes: (sun, ambient) => w?.globes.setLights(sun, ambient),
  }
}
