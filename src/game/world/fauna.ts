import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { seeded } from '../core/rand'
import { gfx } from './quality'
import { SEA_Y, biomeAt, slopeAt, terrainY } from './terrain'
import { placeAt, roadAt } from './settlements'
import { inReserved } from './grid'
import { makeCollisionSet, type Solid } from '../physics/collision'
import type { BiomeId } from './biomes'

/*
  The animals: a small herd of them wherever the player happens to be
  standing, grazing, wandering and bolting when something comes at them.

  This is world/birds.ts's argument at ground level. A meadow with nothing
  moving in it reads as a diorama however well the grass is drawn, and the
  fix is the same shape: a fixed-size pool of creatures that lives around the
  camera, re-cut beyond the fog whenever the player outruns it, so there is
  always something out there and never one that pops in at arm's length.

  Four rules shape it, and three of them are the ones birds and the fleet
  already follow.

  - **Session state, not world state.** Nothing is written into a chunk and
    nothing streams. An animal is a position, a heading and a state machine;
    a rebuilt chunk knows nothing about it, a reload re-cuts the whole herd
    somewhere new, and none of it travels over the wire. The multiplayer walk
    therefore sees *different* animals on each machine, which is the honest
    trade: agreeing on them would mean the server simulating them, and a
    grazing deer is not worth a second authority.

  - **The species is chosen by the ground it is standing on**, out of the
    table below, the same way the flora scatter picks a kit. That is the
    whole of the biome logic: a wolf belongs to the taiga because the taiga's
    row says so, and nothing else in here knows what a taiga is.

  - **Nothing collides with them, but they collide with the world.** The
    first half is birds' and felled debris' policy and it stands: the
    collision set is a flat array every walker and every vehicle scans, and a
    dozen boxes rewritten per frame is a cost the whole world would pay to
    stop the player walking through a deer. What sells them instead is that
    they *react* — anything inside FLEE_R sends them running, so you never
    get to stand still inside one.

    The second half was missing and is not optional. An animal that reads no
    solids walks through walls, and it turns out that is the *visible* half
    of the same policy: a deer standing with its head inside a shopfront is
    the single thing that gives the whole herd away, where a player clipping
    a deer's flank reads as a game being generous. So a step that would take
    the body into a solid turns instead (`stepInto`), and it is cheap because
    it is not per frame: an animal moves two units a second, so probing every
    PROBE_EVERY-th frame, staggered across the herd and re-asked whenever the
    heading changes, costs one pass per animal per fifth of a second.

    The shape of that test is the part worth keeping. It is a **segment**
    clipped against each box, not a point in front of the nose and not a row
    of points along the step, because both of those tunnel and the world is
    full of things they tunnel through: a garden hedge is a box forty units
    long and one thick, and a house wall is thinner still. The point version
    walked deer into the same two hedges ten times in four minutes while
    reporting clear at 1.9 and 2.4 units and "38.6-unit solid" at half a
    unit. The sampled version fixed the hedges and lost the walls. There is
    no spacing that is always small enough — so, slabs.

  - **The rig is somebody else's.** These are the only downloaded models in
    the open world (CC0, credited in public/os/models/animals/LICENSE.md);
    everything about loading them belongs to the caller, because this module
    has to keep importing cleanly in Node like the rest of `src/game/world`.
    It is handed parsed GLTF scenes and clips and does the rest. Until they
    arrive the herd simply does not exist, which is also what keeps them off
    the critical path of opening the front door.

  One note on shadows. These *do* cast, unlike remote players, because the
  sun's hand-managed map is already re-flagged about ten times a second while
  the world is live (CrtScene's followSunShadow), so an animal's shadow costs
  nothing extra and lags by a tenth of a second at walking pace. A deer with
  no shadow floats over the grass; that reads far worse than a shadow a
  handspan behind the feet.
*/

/** the six species that cover every biome. Keys are the GLB basenames */
export type Species =
  | 'deer' | 'fox' | 'wolf' | 'horse' | 'cow' | 'alpaca'

/** one parsed model: the scene to clone and the clips to play off it */
export interface FaunaModel {
  scene: THREE.Object3D
  clips: THREE.AnimationClip[]
}

export type FaunaModels = Partial<Record<Species, FaunaModel>>

export interface FaunaHandles {
  /** advance the herd; call once per rendered frame */
  update: (camPos: THREE.Vector3, dt: number) => void
  /** the models finished downloading: build the pool. Safe to call once */
  setModels: (models: FaunaModels) => void
}

interface BuildOpts {
  parent: THREE.Object3D
  /** the world's live solids — the same array the streamer maintains and the
      walk is pushed out of. Read only, and only to refuse a step */
  obstacles: Solid[]
  trackDisposable: (d: { dispose: () => void }) => void
  /** where a re-cut puts one, as a range from the camera. The default is
      sized against the fog — far enough that the cut is never seen, near
      enough that the arrival fades up out of the haze — which is exactly
      wrong for `scripts/shoot.mjs`, whose whole frame is fifty units wide.
      Nothing but the probe should pass this. */
  ring?: { near: number; spread: number }
}

/*
  What lives where, and how big it is.

  The pack is drawn at roughly 2.2x this world's scale — a fox out of the box
  stands 2.69 units tall against a 3.84 eye height, which is a fox the size of
  a pony. Every scale here is that model's own height divided into the real
  animal's, measured against the walk's eye line (1 unit is about 0.44 m).
  Speeds are units/s: a deer ambles at 2 and bolts at 11, and the walk's own
  run is about 9, so nothing here can be casually chased down except a cow.
*/
interface Kind {
  scale: number
  /** wander speed, and the speed it leaves at */
  walk: number
  flee: number
  /** how much of its time it spends with its head down */
  graze: number
  /** half its length, scaled — how far ahead of its own origin the nose is,
      and therefore how far ahead the wall test has to look. Testing the
      origin alone lets a deer bury its head and shoulders in a shopfront
      before anything notices, which is exactly what it looked like */
  r: number
}

const KINDS: Record<Species, Kind> = {
  deer: { scale: 0.85, walk: 2.0, flee: 11, graze: 0.45, r: 1.9 },
  fox: { scale: 0.37, walk: 2.4, flee: 10, graze: 0.2, r: 1.05 },
  wolf: { scale: 0.5, walk: 2.2, flee: 8, graze: 0.15, r: 1.1 },
  horse: { scale: 0.9, walk: 2.2, flee: 12, graze: 0.5, r: 2.0 },
  cow: { scale: 0.74, walk: 1.2, flee: 5, graze: 0.65, r: 3.0 },
  alpaca: { scale: 0.62, walk: 1.6, flee: 7, graze: 0.5, r: 1.4 },
}

/** one or two species per biome, in the order they are drawn from. Every
    biome that grows anything at all has something living on it; `rock` gets
    the alpaca because a mountain should not be empty, and the sea gets
    nothing because none of these swim */
const BY_BIOME: Record<BiomeId, Species[]> = {
  plains: ['deer', 'horse'],
  forest: ['deer', 'fox'],
  taiga: ['wolf', 'deer'],
  tundra: ['alpaca', 'wolf'],
  snow: ['wolf', 'alpaca'],
  desert: ['horse'],
  savanna: ['horse', 'cow'],
  jungle: ['deer', 'fox'],
  wetland: ['deer', 'cow'],
  beach: ['fox'],
  rock: ['alpaca'],
  ocean: [],
}

/** how far one may fall behind before it is re-cut somewhere ahead. Same
    reasoning as the flocks': the cut is past the daylight fog (240) so it
    is never seen, and the new spot is inside it so the arrival fades up out
    of the haze rather than appearing */
const RECUT_FAR = 300
const RECUT_NEAR = 110
const RECUT_SPREAD = 60

/** inside this, an animal has noticed you and is leaving */
const FLEE_R = 14
const FLEE_R2 = FLEE_R * FLEE_R
/** ...and it keeps going until this much further out */
const CALM_R2 = 34 * 34

/** ground steeper than this is not somewhere a cow stands */
const MAX_SLOPE = 0.62

/** frames between wall probes, staggered across the herd. At 2 units/s a
    fifth of a second is a quarter unit of travel, and the probe looks a
    whole body-length ahead, so nothing reaches a wall between two asks */
const PROBE_EVERY = 12
/** how tall a body the probe asks about. Every animal here is under this,
    and a single figure keeps a cow from being refused a doorway a deer
    would take — neither of them is going through a doorway anyway */
const BODY_H = 3.2

type State = 'idle' | 'graze' | 'walk' | 'flee'

interface Animal {
  species: Species
  group: THREE.Group
  mixer: THREE.AnimationMixer
  actions: Partial<Record<string, THREE.AnimationAction>>
  playing: string
  x: number
  z: number
  y: number
  /** heading it faces, and the one it is turning toward */
  yaw: number
  wantYaw: number
  state: State
  /** seconds left in the current state */
  timer: number
  speed: number
  /** the last answer the wall probe gave, how many frames until it is asked
      again, and the heading it was asked about — see PROBE_EVERY */
  walled: boolean
  probeIn: number
  probeYaw: number
}

/** the clip names the pruned GLBs carry (see the LICENSE note beside them) */
const CLIP = { idle: 'Idle', walk: 'Walk', run: 'Gallop', graze: 'Eating' }

/*
  A heading here is (+sin, +cos), which is a group's own +Z — and that is NOT
  the walk's convention, which faces -Z and is what `pedestrians.ts` uses.

  The difference is the models. All six of these are authored nose-forward
  along +Z (measured off their neck and tail bones), so an animal placed at
  `rotation.y = yaw` and moved along (+sin, +cos) walks the way it is looking.
  The robot rig is authored the other way round, which is why every body in
  this repo is drawn at `facing + PI`. Reconcile them and one of the two
  moonwalks; the only thing that matters is that each module says which it is.
*/

export function buildFauna(opts: BuildOpts): FaunaHandles {
  const { parent, trackDisposable } = opts
  const near = opts.ring?.near ?? RECUT_NEAR
  const spread = opts.ring?.spread ?? RECUT_SPREAD

  const root = new THREE.Group()
  root.userData.dynamic = true
  parent.add(root)

  const rnd = seeded(0x3f0d)
  const herd: Animal[] = []
  let models: FaunaModels | null = null

  /*
    The world's solids, wrapped so `blockedAt` can be asked about them. The
    bounds are deliberately infinite: they are the walker's own clamp and
    mean nothing to an animal, exactly as debris.ts says of the same array.
    It is the live array rather than a copy, because the streamer rewrites
    it on every border crossing.
  */
  const solids = makeCollisionSet(
    { minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9 },
    opts.obstacles,
  )

  /**
   * The first solid a step from (x0, z0) to (x1, z1) would pass through,
   * ignoring `skip` — the one the body is already standing in.
   *
   * A *segment* test, not a sample of its far end, and not a row of samples
   * along it either. Both of those tunnel: a single point two units in front
   * of an animal's nose steps clean over anything thinner than two units and
   * lands on the far side reporting clear, which is how deer walked into the
   * same garden hedges (boxes forty units long and one thick) ten times in
   * four minutes. Stepping the samples fixes the hedges and then loses the
   * house walls, which are thinner still. There is no sample spacing that is
   * always small enough, so this is the standard slab clip against each box:
   * exact at any thickness, one pass over the list, and cheaper than the
   * five-point version it replaces.
   */
  const stepInto = (
    x0: number, z0: number, x1: number, z1: number, y: number, skip: Solid | null,
  ): Solid | null => {
    const footY = y + 0.4
    const headY = y + BODY_H
    const dx = x1 - x0
    const dz = z1 - z0
    for (const b of solids.boxes) {
      if (b === skip) continue
      if (b.max.y <= footY || b.min.y >= headY) continue
      let t0 = 0
      let t1 = 1
      let hit = true
      // one slab per axis; a zero-length component is inside-or-out outright
      for (let axis = 0; axis < 2 && hit; axis++) {
        const d = axis === 0 ? dx : dz
        const p0 = axis === 0 ? x0 : z0
        const lo = axis === 0 ? b.min.x : b.min.z
        const hi = axis === 0 ? b.max.x : b.max.z
        if (Math.abs(d) < 1e-9) {
          if (p0 <= lo || p0 >= hi) hit = false
          continue
        }
        let ta = (lo - p0) / d
        let tb = (hi - p0) / d
        if (ta > tb) { const s = ta; ta = tb; tb = s }
        if (ta > t0) t0 = ta
        if (tb < t1) t1 = tb
        if (t0 > t1) hit = false
      }
      if (hit) return b
    }
    return null
  }

  /**
   * Which solid a body standing here would be inside, or null. `x`/`z` is
   * where the *nose* would be, which the caller works out from its own `r`.
   *
   * It returns the box rather than a boolean, and that is the whole of the
   * unstick rule. An animal already inside something has to be allowed to
   * keep walking or it turns on the spot forever, half in a wall — but
   * "already inside something" must mean *this* something. The first version
   * asked a yes/no question, so a deer standing in a bush's collision
   * cylinder was exempt from every wall in the world, and it strolled into a
   * suburb house ten times in four minutes at an ordinary walking pace. Same
   * box, keep going; different box, that is a wall.
   */
  const solidAt = (x: number, z: number, y: number): Solid | null => {
    const footY = y + 0.4
    const headY = y + BODY_H
    for (const b of solids.boxes) {
      if (b.max.y <= footY || b.min.y >= headY) continue
      if (x <= b.min.x || x >= b.max.x || z <= b.min.z || z >= b.max.z) continue
      return b
    }
    return null
  }

  /*
    Somewhere to stand: a point at a given range and bearing that is dry
    land, off the roads, off the property and not on a cliff — plus the
    species the ground there implies. Sampling is what makes this cheap:
    a handful of tries per re-cut, a few times a minute, against fields that
    are pure functions of (x, z).
  */
  const findSpot = (cx: number, cz: number, near: number, spread: number) => {
    for (let i = 0; i < 12; i++) {
      const a = rnd() * Math.PI * 2
      const d = near + rnd() * spread
      const x = cx + Math.cos(a) * d
      const z = cz + Math.sin(a) * d
      const y = terrainY(x, z)
      if (y < SEA_Y + 0.6) continue
      if (inReserved(x, z, 6)) continue
      if (slopeAt(x, z) > MAX_SLOPE) continue
      const place = placeAt(x, z)
      // a deer in the middle of a downtown junction is a bug, not a joke:
      // stay a full corridor off the tarmac wherever there is any
      if (roadAt(x, z, place).dist < 9) continue
      const species = BY_BIOME[biomeAt(x, z, y, slopeAt(x, z))]
      if (!species?.length) continue
      const pick = species[Math.floor(rnd() * species.length)]
      if (!models?.[pick]) continue
      // ...and not inside a building, a fence or a tree. A re-cut lands
      // wherever the ring happens to point, which in a suburb is as often a
      // living room as a lawn
      const k = KINDS[pick]
      if (solidAt(x, z, y)) continue
      if (solidAt(x + k.r, z, y) || solidAt(x - k.r, z, y)) continue
      if (solidAt(x, z + k.r, y) || solidAt(x, z - k.r, y)) continue
      return { x, z, y, species: pick }
    }
    return null
  }

  /** crossfade to a clip; the mixer owns the blend so this is idempotent */
  const play = (a: Animal, name: string) => {
    if (a.playing === name) return
    const next = a.actions[name]
    if (!next) return
    const prev = a.actions[a.playing]
    next.reset().fadeIn(0.25).play()
    prev?.fadeOut(0.25)
    a.playing = name
  }

  /** put one somewhere new, as a fresh species, and re-hang its clips */
  const recut = (a: Animal, cx: number, cz: number, near: number, spread: number) => {
    const spot = findSpot(cx, cz, near, spread)
    if (!spot) return false
    if (spot.species !== a.species) {
      // a different animal is a different rig, so the group's contents are
      // rebuilt rather than retinted. Cheap and rare: a few times a minute
      // at a walk, and never while anything can see it happen
      dispose(a)
      build(a, spot.species)
    }
    a.x = spot.x
    a.z = spot.z
    a.y = spot.y
    a.yaw = a.wantYaw = rnd() * Math.PI * 2
    a.state = 'idle'
    a.timer = rnd() * 3
    a.speed = 0
    a.walled = false
    // stagger the herd's probes across the frames rather than firing all
    // fourteen on the same one
    a.probeIn = Math.floor(rnd() * PROBE_EVERY)
    a.group.position.set(a.x, a.y, a.z)
    a.group.rotation.y = a.yaw
    a.group.visible = true
    return true
  }

  const dispose = (a: Animal) => {
    a.mixer.stopAllAction()
    a.group.clear()
    a.actions = {}
    a.playing = ''
  }

  /** hang a species' rig and clips on an animal's group */
  const build = (a: Animal, species: Species) => {
    const model = models?.[species]
    if (!model) return
    const body = cloneSkinned(model.scene)
    const k = KINDS[species]
    body.scale.setScalar(k.scale)
    body.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      // a skinned mesh's bounds are its bind pose, which a gallop leaves;
      // the group is small and always near the camera, so cull by the group
      m.frustumCulled = false
    })
    a.group.add(body)
    a.species = species
    a.mixer = new THREE.AnimationMixer(body)
    a.actions = {}
    for (const [key, name] of Object.entries(CLIP)) {
      const clip = model.clips.find((c) => c.name === name)
      if (clip) a.actions[key] = a.mixer.clipAction(clip)
    }
    a.playing = ''
    play(a, 'idle')
  }

  /*
    What it does next. Every animal picks one of three things to do for a few
    seconds and then picks again: stand, graze, or amble to a new heading.
    The weighting is the species' own `graze`, which is the whole personality
    budget — a cow with its head down two thirds of the time and a fox that
    almost never stops moving read as different creatures without either of
    them having a behaviour tree.
  */
  const choose = (a: Animal) => {
    const k = KINDS[a.species]
    // a new state is a new heading, and the wall probe's held answer is
    // about the old one. Grazing is what makes this bite: an animal that
    // was turned away by a hedge stops next to it, and when it sets off
    // again a stale "clear" buys it a fifth of a second of blind walking —
    // which is a quarter of a unit, and it was standing a handspan away
    a.probeIn = 0
    const r = rnd()
    if (r < k.graze) {
      a.state = 'graze'
      a.timer = 3 + rnd() * 6
      a.speed = 0
      play(a, 'graze')
    } else if (r < k.graze + 0.25) {
      a.state = 'idle'
      a.timer = 2 + rnd() * 4
      a.speed = 0
      play(a, 'idle')
    } else {
      a.state = 'walk'
      a.timer = 3 + rnd() * 7
      a.speed = k.walk * (0.8 + rnd() * 0.4)
      a.wantYaw = a.yaw + (rnd() - 0.5) * 2.4
      play(a, 'walk')
    }
  }

  const setModels = (m: FaunaModels) => {
    if (models) return
    models = m
    const want = gfx.fauna
    for (let i = 0; i < want; i++) {
      const a: Animal = {
        species: 'deer',
        group: new THREE.Group(),
        mixer: null as unknown as THREE.AnimationMixer,
        actions: {},
        playing: '',
        x: 0, z: 0, y: 0, yaw: 0, wantYaw: 0,
        state: 'idle', timer: 0, speed: 0,
        walled: false, probeIn: 0, probeYaw: 0,
      }
      a.group.userData.dynamic = true
      a.group.visible = false
      root.add(a.group)
      build(a, 'deer')
      herd.push(a)
    }
  }

  /** how many re-cuts one frame may pay for. A player teleporting (or a
      helicopter crossing a biome at 60 u/s) can strand the whole herd at
      once, and twelve rig rebuilds in one frame is a visible hitch */
  const RECUT_PER_FRAME = 2

  const update = (camPos: THREE.Vector3, dt: number) => {
    if (!models || !herd.length) return
    let recuts = 0
    for (const a of herd) {
      if (!a.group.visible) {
        // never placed, or its last re-cut found nowhere to stand
        if (recuts < RECUT_PER_FRAME && recut(a, camPos.x, camPos.z, near, spread)) {
          recuts++
        }
        continue
      }
      const dx = a.x - camPos.x
      const dz = a.z - camPos.z
      const d2 = dx * dx + dz * dz
      if (d2 > RECUT_FAR * RECUT_FAR) {
        a.group.visible = false
        if (recuts < RECUT_PER_FRAME && recut(a, camPos.x, camPos.z, near, spread)) {
          recuts++
        }
        continue
      }

      /* ---- what it is doing ------------------------------------------- */
      if (d2 < FLEE_R2 && a.state !== 'flee') {
        a.state = 'flee'
        a.probeIn = 0
        a.timer = 2.5 + rnd() * 2.5
        a.speed = KINDS[a.species].flee
        // straight away from whatever came at it, give or take
        a.wantYaw = Math.atan2(dx, dz) + (rnd() - 0.5) * 0.7
        play(a, 'run')
      } else {
        a.timer -= dt
        if (a.state === 'flee') {
          // it stops when it has put some ground between the two of you,
          // not merely when the timer runs out, or a walker following at
          // the same speed watches it change its mind and stand still
          if (a.timer <= 0 && d2 > CALM_R2) choose(a)
        } else if (a.timer <= 0) {
          choose(a)
        }
      }

      /* ---- where that puts it ------------------------------------------ */
      let turn = a.wantYaw - a.yaw
      while (turn > Math.PI) turn -= Math.PI * 2
      while (turn < -Math.PI) turn += Math.PI * 2
      a.yaw += turn * Math.min(1, dt * (a.state === 'flee' ? 4 : 2))
      if (a.speed > 0) {
        const nx = a.x + Math.sin(a.yaw) * a.speed * dt
        const nz = a.z + Math.cos(a.yaw) * a.speed * dt
        const ny = terrainY(nx, nz)
        /*
          It will not walk into the sea, into a wall of hillside, across the
          property line or out onto a street: it turns away and keeps going.

          The road test is the one that is not obvious, and it is here
          because the spawn test alone was not enough — a deer placed nine
          units off the tarmac wanders onto it within the minute, and grazing
          in the middle of a junction is the single thing that would give the
          whole herd away. Fleeing animals are exempt on purpose: bolting
          across a road is what actually happens, and a deer that stops dead
          at the kerb with a car behind it reads as a wall, not as an animal.
        */
        /*
          The wall probe is the one part of this that is not per frame. It
          looks a body-length past where the step lands — the nose, not the
          origin — and its answer is held for PROBE_EVERY frames, which at a
          graze is a quarter of a unit of travel. A fleeing animal is not
          exempt from this one: bolting through a wall is worse than bolting
          across a road, not better.
        */
        /*
          A held answer is about the heading it was asked about, and a body
          turning through a wall between two asks is how the last three
          animals in a thousand still ended up inside one: the probe said
          "clear" along a bearing the animal had left by the time it walked.
          So the hold is broken by a big enough turn as well as by time.
        */
        let turned = a.yaw - a.probeYaw
        while (turned > Math.PI) turned -= Math.PI * 2
        while (turned < -Math.PI) turned += Math.PI * 2
        if (a.probeIn > 0 && Math.abs(turned) < 0.25) {
          a.probeIn--
        } else {
          a.probeYaw = a.yaw
          a.probeIn = PROBE_EVERY
          const k = KINDS[a.species]
          const reach = k.r + a.speed * (PROBE_EVERY / 60)
          // the whole step, nose included, against everything except what it
          // is already standing in — so a body that has somehow ended up
          // inside a solid can walk out of *that* one without being handed
          // a licence to walk into everything else
          const here = solidAt(a.x, a.z, a.y)
          a.walled = stepInto(
            a.x, a.z,
            nx + Math.sin(a.yaw) * reach, nz + Math.cos(a.yaw) * reach,
            ny, here,
          ) !== null
        }
        const blocked = a.walled
          || ny < SEA_Y + 0.4
          || slopeAt(nx, nz) > MAX_SLOPE
          || inReserved(nx, nz, 4)
          || (a.state !== 'flee' && roadAt(nx, nz, placeAt(nx, nz)).dist < 7)
        if (blocked) {
          a.wantYaw = a.yaw + 1.6 + rnd()
          // it has a new heading now, so last frame's answer is about a
          // direction it is no longer going: ask again straight away
          a.probeIn = 0
        } else {
          a.x = nx
          a.z = nz
          a.y = ny
        }
      }
      a.group.position.set(a.x, a.y, a.z)
      a.group.rotation.y = a.yaw
      a.mixer.update(dt)
    }
  }

  trackDisposable({
    dispose: () => {
      for (const a of herd) dispose(a)
      herd.length = 0
      root.clear()
    },
  })

  return { update, setModels }
}

/** the model files this module wants, as basenames under the animals folder.
    Exported so the loader and the table here can never disagree about the
    set, and so a species added to KINDS is one edit rather than two */
export const SPECIES_FILES = Object.keys(KINDS) as Species[]

/**
 * Fetch and parse the herd's models.
 *
 * Deliberately not awaited by anything that gates a frame. Six GLBs are
 * about 700 kB over the wire, which is a fifth of what opening the front
 * door already costs and is *not* worth adding to it: the world comes up
 * without animals and they walk into it when they arrive. A species that
 * fails to download is simply one the table never picks.
 *
 * The import is dynamic because `three/addons` is a real chunk and this
 * module has to stay importable from a Node probe, where there is nothing
 * to fetch from.
 */
export const loadFaunaModels = async (base = '/os/models/animals'): Promise<FaunaModels> => {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const loader = new GLTFLoader()
  const out: FaunaModels = {}
  await Promise.all(SPECIES_FILES.map(async (species) => {
    try {
      const gltf = await loader.loadAsync(`${base}/${species}.glb`)
      out[species] = { scene: gltf.scene, clips: gltf.animations }
    } catch {
      /* one animal short is not a reason to have none */
    }
  }))
  return out
}
