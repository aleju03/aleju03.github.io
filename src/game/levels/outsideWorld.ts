import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import { doorCreak, doorLatch, propSnap, type StepSurface } from '../core/sfx'
import { buildSky, type SkyState } from './sky'
import { YARD } from './houseWorld'

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

  The one thing the room tier cannot skip is *something to see out of the
  windows*. Past the yard fence the streamed terrain is simply absent, which
  reads as a void where the ground should be rather than as distance, so the
  room tier lays one big plane at y=0 in the grass colour and lets the fog eat
  it, and hides it the moment real terrain arrives.
*/

/** the lazily-loaded half: everything in src/game/world the room does not need */
type WorldModules = {
  streamer: typeof import('../world/streamer')
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
}

export type OutsideState = SkyState

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
  root.add(placeholderGround)
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
      const [streamer, terrain, birds, fauna, pedestrians, debris, shopDoors] = await Promise.all([
        import('../world/streamer'),
        import('../world/terrain'),
        import('../world/birds'),
        import('../world/fauna'),
        import('../world/pedestrians'),
        import('../world/debris'),
        import('../world/shopDoors'),
      ])
      return { streamer, terrain, birds, fauna, pedestrians, debris, shopDoors }
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
        parent: root,
        obstacles,
        sfx: { creak: doorCreak, latch: doorLatch },
        trackDisposable,
      })
      // ...and the same arrangement for the props a car can drive through: the
      // manager owns the flattened set and the flying bodies, the streamer tells
      // it about every chunk it builds, and the snap arrives as a callback for
      // the same headless reason the doors' creak does
      const debris = debrisMod.buildDebris({
        parent: root,
        obstacles,
        groundAt: terrain.terrainY,
        onSnap: propSnap,
        trackDisposable,
      })
      const world = streamer.buildWorld({
        scene: root,
        obstacles,
        onNearDoors: shopDoors.sync,
        onChunk: (c) => debris.arm(c.smash),
        trackTexture,
        trackDisposable,
      })
      // the flocks are neither sky nor ground: they hang off this seam because
      // they need the sky's daylight and the world's terrain height, and because
      // they must sleep with the streamer when another level is live
      const birds = birdsMod.buildBirds({ parent: root, trackDisposable })
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
      const fauna = faunaMod.buildFauna({ parent: root, obstacles, trackDisposable })
      void faunaMod.loadFaunaModels().then((m) => fauna.setModels(m))
      const pedestrians = pedMod.buildPedestrians({
        parent: root,
        obstacles,
        groundAt: terrain.terrainY,
        trackDisposable,
      })

      w = { mods, world, birds, fauna, pedestrians, debris, shopDoors }
      placeholderGround.visible = false
    })()
    return attaching
  }

  let active = true

  let lastT = 0
  const groundBase = new THREE.Color('#6f7d4a')
  const placeholderMat = placeholderGround.material as THREE.MeshBasicMaterial

  const update = (camPos: THREE.Vector3, todOverride?: number) => {
    const state = sky.update(camPos, todOverride)
    // the stand-in is unlit, so nothing in the light rig darkens it at dusk;
    // track the day cycle by hand or it stays noon-bright under a night sky
    if (!w) placeholderMat.color.copy(groundBase).multiplyScalar(0.16 + 0.84 * state.day)
    if (active && w) {
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
      */
      const alt = Math.max(0, camPos.y - w.mods.terrain.terrainY(camPos.x, camPos.z))
      w.world.update(camPos.x, camPos.z, dt, alt)
      w.shopDoors.update(dt)
      w.debris.update(dt)
      w.birds.update(camPos, dt, state.day, state.twilight)
      w.fauna.update(camPos, dt)
      w.pedestrians.update(camPos, dt)
      if (alt > 20) {
        const k = Math.min(1, (alt - 20) / 100)
        state.fogNear *= 1 + k * 0.5
        state.fogFar *= 1 + k * 0.55
      }
      // windows and streetlamps come up with the dark; the water takes its
      // colour from the fog, which is most of what makes it read as water
      w.world.setNight(state.night)
      w.world.setWaterTint(state.fogColor, state.day)
    }
    return state
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
    onProperty,
    sun: sky.sun,
    doorPrompt: (p, gaze) => (w ? w.shopDoors.doorPrompt(p, gaze) : null),
    useDoor: (p, gaze) => (w ? w.shopDoors.useDoor(p, gaze) : false),
    setActive: (on) => {
      active = on
    },
    prime: (x, z, ms) => w?.world.prime(x, z, ms),
    hasWorld: () => w !== null,
    preloadWorld: () => void loadMods(),
    attachWorld,
  }
}
