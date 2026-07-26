import * as THREE from 'three'
import { fitHull, makeHull, type Hull, type Solid } from '../physics/collision'
import { markDynamic } from './parts'
import { createVehicleMaterials, type VehicleMaterials } from './materials'
import { createVehicleEffects, type VehicleEffects } from './effects'
import { createDriveCam, type DriveCam } from './driveCam'
import {
  createVehicleVoice, vehicleDoor, vehicleHorn, vehicleImpact, vehicleSplash,
  type VehicleVoice,
} from './sfx'
import { clamp, clearAt, SURFACE_FEEL } from './chassis'
import { buildCar } from './car'
import { buildBoat } from './boat'
import { buildHeli } from './heli'
import type { DriveEnv, DriveStep, NetPose, Vehicle, VehicleId } from './types'

/*
  The fleet: three machines, where they live, and everything that has to
  happen around them that is not physics.

  This module is the seam between the vehicles and the scene, and it exists so
  that CrtScene's per-frame conductor gains one call rather than a subsystem.
  It owns:

  - **the fleet itself**, and their home coordinates. Those three points were
    measured against the generated world, not guessed — the same discipline
    land.ts's WORLD_X/Z were calibrated with. The car sits at the kerb outside
    the house on a street that is exactly where the porch was built to meet it;
    the helicopter sits one block north on the widest clear ground within two
    hundred units of the property (the neighbourhood has no field: the best
    clear radius anywhere near home is 11.3 units, which is why the machine is
    a two-seat piston helicopter with a 7.6-unit rotor and not anything
    larger); and the boat is 2.4 km west-north-west, because the nearest water
    on this continent deeper than a puddle is 1.8 km away and the nearest real
    coast is where it is. That distance is a feature. It gives the helicopter
    somewhere to go.

  - **the collision bookkeeping.** Each vehicle keeps one Solid in the shared
    obstacle list, re-fitted every frame, so a parked car is something you walk
    into and can climb onto. It carries the machine's `hull` — the oriented,
    tapering profile from collision.ts — and the box itself is only that
    hull's bounds, i.e. the broad phase. That distinction is the whole point:
    the box around a 9.4-unit car parked at forty-five degrees is nine and a
    half units wide, and walking the diagonal you met it two units off the
    paint, which reads as an invisible wall parked next to the car. The hull is
    what you actually bump into, so the collision follows the bodywork at any
    heading and the roof is standable where there is a roof rather than
    everywhere inside the bounds.

    The Solid of the vehicle currently being simulated is emptied first:
    `supportY` has no concept of an owner (collision.ts), so a car that could
    see its own box would find its own roof under its wheels and climb itself,
    once per frame, forever. Emptying the box is enough on its own — every
    test reaches the hull through the bounds, and an emptied Box3 fails them
    all.

  - **entering and leaving.** A prompt when you are close enough, a camera
    that blends rather than cuts, a driver figure that appears in the seat, a
    stand-down spot that is checked for being somewhere a person can actually
    be, and a refusal to let you step out of a helicopter that is fifty units
    up.

  - **the substep.** The walk loop's dt is clamped to 50 ms, and 50 ms of
    explicit Euler through a wheel spring stiff enough to hold a car up is not
    a suspension, it is an explosion. Everything here integrates in fixed
    1/120 s slices, which also means the machines feel identical on a 30 Hz
    laptop and a 144 Hz desktop — the thing a variable-dt vehicle never does.

  - **sound and dust**, which are per-vehicle in character and shared in
    machinery: one voice at a time (you can only be in one), one particle pool
    for all of them.

  - **who is in what.** Each machine seats two, and either chair can hold the
    local player or somebody else's avatar. Only the driver's chair carries
    the controls; the passenger gets the same lens and none of the input. The
    seats themselves are arbitrated by the server (`net/protocol.ts`), because
    two people reaching for the same door is the one question two browsers
    cannot settle between themselves — but *everything* below is written so
    that with no server at all it degrades to exactly the old single-player
    behaviour, which is also what happens when `VITE_CHAT_URL` is unset.

  A machine being driven from another browser is the one case where this
  module does not run physics. It cannot: the local integrator and the
  arriving transform would write the same six numbers every frame and the
  visible result is a car that shivers. So a net-driven entry is placed by
  `Vehicle.netStep` instead, which animates the cosmetics off the motion the
  interpolation implies. The handoff back, when the far side gets out, needs
  nothing at all: `netStep` leaves the machine's own state consistent, so
  local physics picks it up mid-roll and it coasts to a stop.

  A note on world state, because this codebase is otherwise strict about not
  having any: the fleet is **session state**, not world state, and that is
  still true with the server in the picture. The planet remains a pure
  function of coordinates; what the server holds is three transforms and six
  seats, which is the "store the diffs, not the world" save file the README
  describes, kept in memory for the length of a session rather than on disk.
  Nothing here is streamed and nothing is written into the world. With no
  server, or before anybody has driven anything, every client's own spawn
  puts all three machines on the same probed home spots and they agree.
*/

/** where each machine starts life. See the module header on the provenance
    of these numbers — they were probed, not chosen */
const HOME: Record<VehicleId, { x: number; z: number; yaw: number }> = {
  // the kerb outside the house. The street's asphalt runs z -14.4..-8.0 with
  // its centreline at -11.2; -9.9 parks the body on the property side of it,
  // nose east, clear of the front walk and the gate posts by three units
  car: { x: -4, z: -9.9, yaw: -Math.PI / 2 },
  // one block north, on the z = 52.8 street. Nothing generated stands within
  // 12 units and the yard fence is 11.3 away — the largest clear disc in the
  // neighbourhood, which is what sized the rotor
  heli: { x: -9, z: 50, yaw: -0.178 },
  // a coastal lagoon: 2.9 units of water under the keel and a shore about
  // twenty-five units off. Re-probed when the mountain retune lifted the
  // raw field — the old spot at (-2279, -614) kept half a unit of water
  boat: { x: -2170, z: -1080, yaw: -0.175 },
}

/** how long the camera takes to move from the player's eye into the seat */
const MOUNT_S = 0.55
/** fixed physics slice; see the header on why the frame's dt will not do */
const SUBSTEP = 1 / 120
const MAX_SUB = 8
/** parked machines further than this from the player are simply not ticked */
const SIM_RANGE = 300

export interface FleetEnvQueries {
  groundAt: (x: number, z: number) => number
  waterY?: number
  collision: DriveEnv['collision']
  surfaceAt: DriveEnv['surfaceAt']
  waveAt: DriveEnv['waveAt']
}

export interface FleetTickOpts {
  dt: number
  keys: ReadonlySet<string>
  /** a level cut or the pause menu: no input, but the world keeps settling */
  frozen: boolean
  env: FleetEnvQueries
  camera: THREE.PerspectiveCamera
  /** the player's own fov preference; the drive cam offsets from it */
  fovBase: number
  /** where the walker is, for prompts and for culling distant machines */
  playerPos: THREE.Vector3
  /** the overworld is live. Level 0 has no vehicles in it and never will */
  outdoors: boolean
}

export interface FleetStep {
  /** the machine whose controls the local player is holding, if any */
  driving: Vehicle | null
  /** the machine the local player is *in*, driving or not */
  riding: Vehicle | null
  /** a machine in reach of a walker, for the interact prompt. A machine with
      a driver in it still offers one — the other chair is the offer */
  prompt: Vehicle | null
  /** which chair the prompt would put them in */
  promptSeat: number
  /** something moved enough to be worth re-baking a shadow map over */
  moved: boolean
  /** the HUD's numbers, valid only while driving */
  speed: number
  load: number
  altitude: number
  gear: number
  rpm: number
  /** true while the mount blend is still running: hold the HUD back */
  boarding: boolean
}

/** where a dismount puts the walker */
export interface ExitPlace {
  x: number
  z: number
  feetY: number
  yaw: number
  pitch: number
}

/** what the local player is doing with a machine, and what everyone else is
    doing with the rest of the fleet. The scene owns the socket and hands this
    down every frame; the registry never talks to the network itself */
export interface FleetNetState {
  /** per wire-order vehicle: who has the wheel, from this client's point of
      view. `null` for "nobody, or me" — both mean local physics runs it */
  driven: Array<NetPose | null>
  /** per wire-order vehicle, per chair: taken by somebody who is not us. What
      the interact prompt reads, so a full car offers nothing and a car with a
      driver in it offers the other door */
  taken: Array<[boolean, boolean]>
}

export interface VehicleFleet {
  root: THREE.Group
  readonly all: Vehicle[]
  /** the machine whose controls we hold */
  readonly driving: Vehicle | null
  /** the machine we are sitting in, either chair */
  readonly riding: Vehicle | null
  /** 0 driver, 1 passenger; meaningless unless `riding` */
  readonly seat: number
  readonly cockpit: boolean
  /** flip the drive camera between chase and cockpit */
  toggleView: () => void
  /** mouse-look, same signature the walk controller takes. While driving the
      lens belongs to the boom, not to the suspended walker's head */
  turn: (dx: number, dy: number, sign: 1 | -1, sens: number) => void
  /** the machine a walker at `p` could get into, or null */
  nearest: (p: THREE.Vector3) => Vehicle | null
  /** climb in. `yaw`/`pitch` are the walker's, so the camera can blend;
      `seat` is 0 for the controls and 1 for the other chair */
  enter: (
    v: Vehicle,
    cam: THREE.PerspectiveCamera,
    yaw: number,
    pitch: number,
    seat?: number,
  ) => void
  /** slide across without getting out: the passenger of a machine whose
      driver just left takes the wheel where they sit */
  takeSeat: (seat: number) => void
  /** climb out; null means "not from here" (a helicopter in the air). A
      passenger may always get out — they are not the one flying it */
  leave: (env: FleetEnvQueries) => ExitPlace | null
  /** who is driving what, from the network. Call before `tick` */
  setNet: (state: FleetNetState | null) => void
  /** one frame. Call it whether or not anyone is driving */
  tick: (o: FleetTickOpts) => FleetStep
  /** put every machine on its home spot and settle it. Call once the world
      has been primed — before that, terrain is answered from an empty cache
      and the collision set has nothing in it */
  spawnAll: (env: FleetEnvQueries) => void
  /** bring a machine to the player. Returns false when there is nowhere for
      it to go — a boat with no water within reach, mostly */
  recall: (id: VehicleId, p: THREE.Vector3, env: FleetEnvQueries) => boolean
  /** put a machine where the server says it was left. Only ever called on
      joining: from then on a driven machine arrives frame by frame and a
      parked one is nobody's business but this client's */
  placeFromNet: (
    id: VehicleId,
    x: number,
    z: number,
    yaw: number,
    env: FleetEnvQueries,
  ) => void
  /** distance and compass bearing from a point, for the pause menu list */
  where: (id: VehicleId, p: THREE.Vector3) => { dist: number; bearing: string }
  /** the day cycle: headlamps, nav lights, reflections */
  setDay: (day: number, night: number, fog: THREE.Color, sunEl: number) => void
  /** expose renderer lights that normally appear only at a threshold, solely
      while CrtScene compiles that program layout behind the boot cover */
  setLightWarmup: (on: boolean) => void
  /** the pause menu is up, or the tab went away */
  setMuted: (on: boolean) => void
  /** everything stops (sitting back down, a level cut, unmount) */
  sleep: () => void
  dispose: () => void
}

interface Entry {
  v: Vehicle
  box: Solid
  /** the same object as `box.hull`, held here so fitBox writes it without an
      assertion. Its stations are the machine's own, padded once */
  hull: Hull
  /** the last step it reported, so the HUD and the effects can read it */
  step: DriveStep | null
  /** its own dust clock, so emitters run at a rate rather than per frame */
  emit: number
  /** somebody else's pose for this machine this frame, or null for "mine or
      nobody's". Written by setNet, read by tick, never kept */
  net: NetPose | null
  /** its engine is audible: either we are in it, or it is being driven past
      us. Held so start/stop happen on edges rather than every frame */
  voiced: boolean
}

interface BuildOpts {
  scene: THREE.Object3D
  /** the shared obstacle list every builder registers into */
  obstacles: Solid[]
  trackTexture: <T extends THREE.Texture>(t: T) => T
  trackDisposable: <D extends { dispose: () => void }>(d: D) => D
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/** shoulder margin, the x/z-only pad every other solid in the world gets at
    registration. Baked into the hull once rather than added per frame */
const PAD = 0.1
/** how far under the origin a machine's box reaches. Every one of them sits on
    its own frame's zero — wheels, skids, waterline — so this is a sill's worth
    of underside and nothing more */
const DROP = 0.2

export function buildFleet(opts: BuildOpts): VehicleFleet {
  const { scene, obstacles, trackTexture, trackDisposable } = opts

  const root = new THREE.Group()
  root.userData.dynamic = true
  // Every vehicle constructor starts at the local origin. The room camera also
  // starts there, so exposing the root before spawnAll() has assigned the home
  // transforms puts the whole fleet around the lens for the first boot frame.
  // Keeping the common parent hidden also makes a partial placement impossible:
  // all three machines appear together only after the world can support them.
  root.visible = false
  scene.add(root)

  const mats: VehicleMaterials = createVehicleMaterials({
    texture: trackTexture,
    add: trackDisposable,
  })
  const effects: VehicleEffects = createVehicleEffects({
    texture: trackTexture,
    add: trackDisposable,
  })
  root.add(effects.root)

  const cam: DriveCam = createDriveCam()
  const voices: Record<VehicleId, VehicleVoice> = {
    car: createVehicleVoice('car'),
    boat: createVehicleVoice('boat'),
    heli: createVehicleVoice('heli'),
  }

  const entries: Entry[] = []
  const byId = new Map<VehicleId, Entry>()
  for (const v of [buildCar({ mats }), buildBoat({ mats }), buildHeli({ mats })]) {
    root.add(v.root)
    const box = new THREE.Box3() as Solid
    const hull = makeHull(v.hull, PAD)
    box.hull = hull
    obstacles.push(box)
    const e: Entry = {
      v, box, hull, step: null, emit: 0,
      net: null, voiced: false,
    }
    entries.push(e)
    byId.set(v.id, e)
  }
  // belt and braces over each vehicle's own call: CrtScene freezes the whole
  // static scene graph once, per *object*, and a wheel that missed the flag is
  // a wheel that renders at the origin for the rest of the session
  markDynamic(root)

  /** the machine we are sitting in, and which chair. `active` being set does
      not imply we are driving it — `seat` says that */
  let active: Entry | null = null
  let seat = 0
  let mountT = 0
  const fromPos = new THREE.Vector3()
  const fromQuat = new THREE.Quaternion()
  const toPos = new THREE.Vector3()
  const toQuat = new THREE.Quaternion()
  let hornHeld = false

  /** the last thing the network said about the fleet, or null when there is
      no server in the picture at all — which is the single-player case and
      the one every default here falls back to */
  let netState: FleetNetState | null = null

  const env: DriveEnv = {
    dt: SUBSTEP,
    keys: new Set<string>(),
    frozen: false,
    groundAt: () => 0,
    collision: { boxes: [], bounds: { minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 } },
    surfaceAt: () => 'grass',
    waveAt: () => 0,
  }
  const fillEnv = (q: FleetEnvQueries) => {
    env.groundAt = q.groundAt
    env.waterY = q.waterY
    env.collision = q.collision
    env.surfaceAt = q.surfaceAt
    env.waveAt = q.waveAt
  }

  /** re-aim a machine's hull at where the machine now is. The fit itself lives
      in collision.ts with the type it fits; what used to be here was `size` run
      through an oriented-AABB formula, which is where the phantom wall
      alongside a diagonally parked car came from */
  const fitBox = (e: Entry) => {
    const p = e.v.root.position
    fitHull(e.hull, e.box, p.x, p.y, p.z, e.v.yaw, DROP)
  }

  /*
    One frame of a machine somebody else is driving.

    The physics is not merely skipped, it must not run: `Vehicle.netStep` is
    the whole tick, and it is handed the *frame's* dt rather than a substep,
    because there is nothing here to integrate stiffly — the springs already
    ran on the driver's machine and their product arrived on the wire.

    The box comes back afterwards like a parked machine's, and for a better
    reason: a car being driven past you is exactly the thing you should not be
    able to walk through.
  */
  const netStep = (e: Entry, dt: number, p: NetPose, q: FleetEnvQueries) => {
    e.box.makeEmpty()
    fillEnv(q)
    env.dt = dt
    const last = e.v.netStep(env, p)
    e.step = last
    if (e !== active) fitBox(e)
    return last
  }

  const step = (e: Entry, driven: boolean, dt: number, q: FleetEnvQueries) => {
    // its own box must not exist while it is asking the world what is under
    // it — see the header. Emptied, every test in collision.ts fails closed
    e.box.makeEmpty()
    fillEnv(q)
    let sub = Math.min(MAX_SUB, Math.max(1, Math.ceil(dt / SUBSTEP)))
    const h = dt / sub
    env.dt = h
    let last: DriveStep | null = null
    while (sub-- > 0) last = e.v.update(env, driven)
    e.step = last
    /*
      The box comes back only for a machine nobody is in.

      While you are driving, that box is your own body, and everything that
      reads the collision set would argue with it: the drive camera's boom
      samples down its ray through exactly the same test the walker uses, so
      the very first sample lands inside the car, `blocked` says yes, the boom
      clamps to zero, and the lens sits at the anchor looking out through the
      windscreen from a camera that is supposed to be eleven units behind.
      The symptom is a third-person view with no vehicle in it, which reads as
      the model having failed to load rather than as a collision bug.

      The test is "are we inside it", not "are we driving it": a passenger in
      a parked machine is just as inside it, and their boom is crushed by the
      same box for the same reason.
    */
    if (e !== active) fitBox(e)
    return last
  }

  /* ------------------------------------------------------------ effects -- */

  const dustColor = new THREE.Color()
  const FOAM = new THREE.Color('#dbeaee')
  const emitFor = (e: Entry, dt: number, q: FleetEnvQueries) => {
    const s = e.step
    if (!s) return
    const v = e.v
    const p = v.root.position
    const fx = -Math.sin(v.yaw)
    const fz = -Math.cos(v.yaw)
    const rx = -fz
    const rz = fx
    const feel = SURFACE_FEEL[s.surface]

    if (v.id === 'heli') {
      // downwash: a ring of dust thrown outward under the disc, and only
      // close enough to the ground for there to be anything to throw
      if (s.rpm > 0.35 && s.altitude < 9) {
        const k = s.rpm * (1 - s.altitude / 9)
        e.emit += dt * 90 * k
        while (e.emit > 1) {
          e.emit -= 1
          const a = (e.emit * 37.7 + performance.now() * 0.011) % (Math.PI * 2)
          const r = 2.5 + Math.random() * 5.5
          const gy = q.groundAt(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r)
          dustColor.setHex(feel.dust)
          effects.emit(
            p.x + Math.cos(a) * r, gy + 0.25, p.z + Math.sin(a) * r,
            Math.cos(a) * 9 * k, 1.2, Math.sin(a) * 9 * k,
            dustColor, 0.3 * k, 1.1, 3.4, 0.85, 2.4, 0.4,
          )
        }
      }
      return
    }

    if (v.id === 'boat') {
      if (!s.grounded || s.planar < 2) return
      // a wake is two things: foam thrown off the shoulders of the bow, and a
      // churned trail off the transom. Both scale with speed, and neither
      // exists at rest — which is why a stationary boat looks moored
      const k = clamp(s.planar / 34, 0, 1)
      e.emit += dt * (12 + 70 * k)
      while (e.emit > 1) {
        e.emit -= 1
        const side = Math.random() < 0.5 ? 1 : -1
        const bow = Math.random() < 0.55
        const along = bow ? -3.6 : 6.0
        const across = bow ? 1.5 * side : 1.1 * side
        const y = (q.waterY ?? p.y) + 0.1
        effects.emit(
          p.x + fx * along + rx * across,
          y,
          p.z + fz * along + rz * across,
          (bow ? rx * side * 3.5 : -fx * 4) * k + fx * s.planar * 0.15,
          0.6 + 1.6 * k,
          (bow ? rz * side * 3.5 : -fz * 4) * k + fz * s.planar * 0.15,
          FOAM, 0.24 + 0.4 * k, 0.7, 2.6 + 3 * k, 0.9 + 1.2 * k, 2.2, -0.5,
        )
      }
      return
    }

    // the car: dust and spray off the driven wheels, and more of it when the
    // tyres are not tracking
    const throwUp = feel.spray * (0.25 + s.slip * 1.2) * clamp(s.planar / 18, 0, 1)
    if (!s.grounded || throwUp < 0.02) return
    e.emit += dt * 70 * throwUp
    while (e.emit > 1) {
      e.emit -= 1
      const side = Math.random() < 0.5 ? 1 : -1
      const bx = p.x + fx * 2.6 + rx * 1.5 * side
      const bz = p.z + fz * 2.6 + rz * 1.5 * side
      dustColor.setHex(feel.dust)
      const wet = s.surface === 'water'
      effects.emit(
        bx, q.groundAt(bx, bz) + 0.3, bz,
        fx * (2 + 6 * throwUp) + rx * side * 2.2, 1.4 + 2.5 * throwUp, fz * (2 + 6 * throwUp) + rz * side * 2.2,
        wet ? FOAM : dustColor,
        (wet ? 0.35 : 0.26) * clamp(throwUp * 2, 0, 1),
        0.55, 2.4, 1.5, 1.9, wet ? -1.4 : 0.55,
      )
    }
  }

  /* -------------------------------------------------------------- mount -- */

  const enter = (
    v: Vehicle,
    camera: THREE.PerspectiveCamera,
    yaw: number,
    pitch: number,
    which = 0,
  ) => {
    const e = byId.get(v.id)
    if (!e || active) return
    active = e
    seat = which
    mountT = MOUNT_S
    fromPos.copy(camera.position)
    fromQuat.copy(camera.quaternion)
    // start the boom on the heading the walker was already facing and let it
    // swing round to the machine's, so climbing in is a movement rather than
    // a cut. The pitch is the walker's too, damped — nobody gets into a car
    // still staring at their own feet
    cam.reset(v, yaw)
    cam.seat = which
    cam.turn(0, (pitch * 0.5) / 0.0019, 1, 1)
    // only the driver starts the engine. A passenger boarding a cold machine
    // gets a cold machine, and boarding a running one changes nothing about
    // it — which is what makes the rotor keep turning while people swap seats
    if (which === 0) v.mount()
    vehicleDoor(true)
  }

  /** slide across inside the machine. The camera keeps its boom and its
      free-look — this is a change of chair, not a boarding — and the engine
      starts or stops as the controls change hands */
  const takeSeat = (which: number) => {
    if (!active || seat === which) return
    seat = which
    cam.seat = which
    if (which === 0) active.v.mount()
    else active.v.dismount()
  }

  const leave = (q: FleetEnvQueries): ExitPlace | null => {
    if (!active) return null
    const e = active
    const s = e.step
    // you may not step out of something that is flying — unless you are not
    // the one flying it, in which case it is the pilot's problem and stepping
    // out is still a bad idea, so it is refused for both chairs
    if (e.v.id === 'heli' && s && (!s.grounded || s.altitude > 1.2)) return null
    fillEnv(q)
    env.dt = SUBSTEP
    const out = new THREE.Vector3()
    e.box.makeEmpty()
    const feetY = e.v.exitSpot(out, env)
    fitBox(e)
    // a passenger getting out must not stop the engine under the driver
    if (seat === 0) e.v.dismount()
    vehicleDoor(false)
    active = null
    seat = 0
    mountT = 0
    return { x: out.x, z: out.z, feetY, yaw: cam.yaw, pitch: cam.pitch }
  }

  /* --------------------------------------------------------------- tick -- */

  const result: FleetStep = {
    driving: null, riding: null, prompt: null, promptSeat: 0, moved: false,
    speed: 0, load: 0, altitude: 0, gear: 0, rpm: 0, boarding: false,
  }

  /** the machine's position in the listener's own frame, for `voice.place` */
  const earTo = new THREE.Vector3()
  const camAxis = new THREE.Vector3()

  /** start, stop and place an engine. `inside` means the listener is sitting
      in it, which is the mix every one of these voices was tuned at */
  const voiceFor = (e: Entry, s: DriveStep, inside: boolean, cam3: THREE.Camera) => {
    const voice = voices[e.v.id]
    if (!e.voiced) {
      e.voiced = true
      voice.start()
    }
    if (inside) voice.place(0, 0, 0)
    else {
      earTo.copy(e.v.root.position).sub(cam3.position)
      const m = cam3.matrixWorld.elements
      const right = earTo.dot(camAxis.set(m[0], m[1], m[2]))
      const up = earTo.dot(camAxis.set(m[4], m[5], m[6]))
      const back = earTo.dot(camAxis.set(m[8], m[9], m[10]))
      voice.place(right, up, back)
    }
    voice.set(s.rpm, s.load, Math.abs(s.speed) / 40, s.slip)
  }

  const hush = (e: Entry) => {
    if (!e.voiced) return
    e.voiced = false
    voices[e.v.id].stop()
  }

  const tick = (o: FleetTickOpts): FleetStep => {
    const dt = Math.min(0.05, o.dt)
    root.visible = o.outdoors
    result.driving = null
    result.riding = null
    result.prompt = null
    result.promptSeat = 0
    result.moved = false
    result.speed = 0
    result.load = 0
    result.altitude = 0
    result.gear = 0
    result.rpm = 0
    result.boarding = mountT > 0

    if (!o.outdoors) {
      // level 0: the machines are still there, they are just not anywhere the
      // player can reach. Freeze them rather than paying for them
      for (const e of entries) hush(e)
      effects.update(dt)
      return result
    }

    // only the driver's keys reach a machine. A passenger holding W is a
    // passenger holding W
    env.keys = o.keys
    env.frozen = o.frozen

    for (const e of entries) {
      const inside = e === active
      const driven = inside && seat === 0
      const p = e.net
      // The range cull is about not paying to settle a parked machine nobody
      // is near. It must not apply to one somebody is *driving*: netStep is
      // a transform copy and a few cosmetics, it costs nothing, and skipping
      // it strands the machine at the range boundary on everyone else's
      // screen — a boat driven out along the coast simply stopping dead at
      // 300 units while its driver sails on.
      if (!inside && !p) {
        const d = e.v.root.position.distanceToSquared(o.playerPos)
        if (d > SIM_RANGE * SIM_RANGE) {
          // out of range: keep the box honest and stop paying for the rest
          fitBox(e)
          hush(e)
          continue
        }
      }
      let s: DriveStep | null
      if (p) {
        s = netStep(e, dt, p, o.env)
      } else {
        // The far side getting out needs no ceremony, and deliberately gets
        // none. `netStep` left the machine's own state consistent — position,
        // attitude, and the velocity the interpolation implied — so local
        // physics simply picks it up from there. A re-settle (`placeAt`) was
        // tried and is worse on both counts: it zeroes the velocity, so a
        // machine abandoned mid-drive stops dead in the air instead of
        // rolling to a halt, and on the helicopter it stops the rotor between
        // two frames rather than letting it wind down over its eight seconds.
        // The springs are the only thing genuinely out of date, and they
        // converge on their own inside a fifth of a second.
        s = step(e, driven, dt, o.env)
      }
      if (!s) continue
      if (driven) {
        result.moved = result.moved || s.moved
        result.speed = s.speed
        result.load = s.load
        result.altitude = s.altitude
        result.gear = s.gear
        result.rpm = s.rpm
        if (s.impact > 3) {
          if (s.surface === 'water') vehicleSplash(clamp(s.impact / 16, 0, 1))
          else vehicleImpact(clamp(s.impact / 22, 0, 1))
        }
      } else if (inside) {
        // riding along: the HUD is the driver's, but the machine's own
        // numbers still belong on it and the moving caster is still moving
        result.moved = result.moved || s.moved
        result.speed = s.speed
        result.load = s.load
        result.altitude = s.altitude
        result.gear = s.gear
        result.rpm = s.rpm
      }
      // an engine is running if somebody is at its controls — us, or a driver
      // on the wire. A parked machine is silent whoever is sitting in it
      if (driven || p) voiceFor(e, s, inside, o.camera)
      else hush(e)
      emitFor(e, dt, o.env)
    }
    effects.update(dt)

    if (active) {
      const v = active.v
      const s = active.step
      result.riding = v
      if (seat === 0) result.driving = v
      // the horn: x is free while driving (there is no ragdoll at the wheel).
      // The passenger gets it too — it is the one control in the cabin that
      // was never the driver's alone
      const hornNow = !o.frozen && o.keys.has('KeyX')
      if (hornNow && !hornHeld && v.id !== 'heli') vehicleHorn()
      hornHeld = hornNow
      if (s) {
        cam.apply(o.camera, dt, v, s, env, o.fovBase)
        if (mountT > 0) {
          // blend out of the walker's eye rather than cutting: the camera has
          // just travelled several units and a cut there reads as a glitch
          mountT = Math.max(0, mountT - dt)
          const k = 1 - mountT / MOUNT_S
          const ease = k * k * (3 - 2 * k)
          toPos.copy(o.camera.position)
          toQuat.copy(o.camera.quaternion)
          o.camera.position.lerpVectors(fromPos, toPos, ease)
          o.camera.quaternion.slerpQuaternions(fromQuat, toQuat, ease)
        }
      }
      return result
    }

    hornHeld = false
    const at = nearest(o.playerPos)
    result.prompt = at
    result.promptSeat = at ? freeSeat(byId.get(at.id)!) : 0
    return result
  }

  /** which chair this machine would put a walker in, or -1 if it is full.
      The wheel first: a machine with nobody in it is one you drive */
  const freeSeat = (e: Entry) => {
    const t = netState?.taken[entries.indexOf(e)]
    if (!t) return 0
    if (!t[0]) return 0
    if (!t[1]) return 1
    return -1
  }

  /*
    The prompt is about how far away you are standing, not how tall you are.

    `p` is the camera, so it arrives an eye-height above the ground, and a
    machine's origin sits on the ground — a straight distanceTo() therefore
    spends most of a short reach climbing the player. Standing at the car's
    driver's door the walker is 1.98 out (the hull pushes them there) and about
    3.6 up, which is 4.11 of 4.2: the prompt only appeared if you crouched,
    because crouching is what brought the eye down far enough. The boat and the
    helicopter hid it by reaching 5.
  */
  const nearest = (p: THREE.Vector3): Vehicle | null => {
    let best: Vehicle | null = null
    let bestD = Infinity
    for (const e of entries) {
      if (e === active) continue
      // a machine with both chairs full is scenery, however close you stand
      if (freeSeat(e) < 0) continue
      const q = e.v.root.position
      const d = Math.hypot(q.x - p.x, q.z - p.z)
      if (d < e.v.reach && d < bestD) {
        bestD = d
        best = e.v
      }
    }
    return best
  }

  /* ------------------------------------------------------------- recall -- */

  const spawnAll = (q: FleetEnvQueries) => {
    fillEnv(q)
    env.dt = SUBSTEP
    env.frozen = true
    for (const e of entries) {
      const h = HOME[e.v.id]
      e.box.makeEmpty()
      e.v.placeAt(h.x, h.z, h.yaw, env)
      // a few slices of settling so a machine is resting on its springs the
      // first time anyone lays eyes on it rather than dropping onto them
      for (let i = 0; i < 40; i++) e.v.update(env, false)
      fitBox(e)
    }
    root.visible = true
    env.frozen = false
  }

  const recall = (id: VehicleId, p: THREE.Vector3, q: FleetEnvQueries) => {
    const e = byId.get(id)
    // ...and you may not summon a machine out from under the person driving
    // it. It is theirs until they park it
    if (!e || e === active || e.net) return false
    fillEnv(q)
    env.dt = SUBSTEP
    e.box.makeEmpty()
    const needWater = id === 'boat'
    const clearR = e.v.size.halfZ + 1.5
    // spiral outward from the player: near enough to walk to, far enough not
    // to land on their head
    for (let ring = 0; ring < 9; ring++) {
      const r = 9 + ring * 7
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + ring * 0.37
        const x = p.x + Math.cos(a) * r
        const z = p.z + Math.sin(a) * r
        const g = q.groundAt(x, z)
        const deep = q.waterY !== undefined ? q.waterY - g : -1
        if (needWater ? deep < 1.6 : deep > 0.35) continue
        if (!clearAt(x, z, clearR, g, g + e.v.size.height, q.collision)) continue
        // ...and the ground it sits on has to be flat enough not to slide off
        const tilt = Math.max(
          Math.abs(q.groundAt(x + 3, z) - g), Math.abs(q.groundAt(x - 3, z) - g),
          Math.abs(q.groundAt(x, z + 3) - g), Math.abs(q.groundAt(x, z - 3) - g),
        )
        if (!needWater && tilt > 1.6) continue
        // face it back toward whoever called it
        const yaw = Math.atan2(-(p.x - x), -(p.z - z))
        e.v.placeAt(x, z, yaw, env)
        fitBox(e)
        return true
      }
    }
    fitBox(e)
    return false
  }

  const placeFromNet = (
    id: VehicleId,
    x: number,
    z: number,
    yaw: number,
    q: FleetEnvQueries,
  ) => {
    const e = byId.get(id)
    if (!e || e === active) return
    fillEnv(q)
    env.dt = SUBSTEP
    e.box.makeEmpty()
    e.v.placeAt(x, z, yaw, env)
    fitBox(e)
  }

  const where = (id: VehicleId, p: THREE.Vector3) => {
    const e = byId.get(id)
    if (!e) return { dist: 0, bearing: 'N' }
    const dx = e.v.root.position.x - p.x
    const dz = e.v.root.position.z - p.z
    // screen north is -z, and the compass runs clockwise from it
    const a = Math.atan2(dx, -dz)
    const i = (Math.round((a / (Math.PI * 2)) * 8) + 8) % 8
    return { dist: Math.hypot(dx, dz), bearing: COMPASS[i] }
  }

  /* ------------------------------------------------------------ upkeep -- */

  const sleep = () => {
    if (active) {
      if (seat === 0) active.v.dismount()
      active = null
      seat = 0
    }
    for (const e of entries) {
      e.voiced = false
      e.net = null
    }
    for (const k of Object.keys(voices) as VehicleId[]) voices[k].stop()
    netState = null
    effects.clear()
    mountT = 0
  }

  return {
    root,
    get all() {
      return entries.map((e) => e.v)
    },
    get driving() {
      return active && seat === 0 ? active.v : null
    },
    get riding() {
      return active ? active.v : null
    },
    get seat() {
      return seat
    },
    get cockpit() {
      return cam.cockpit
    },
    toggleView: () => {
      cam.cockpit = !cam.cockpit
    },
    turn: (dx, dy, sign, sens) => cam.turn(dx, dy, sign, sens),
    nearest,
    enter,
    takeSeat,
    leave,
    setNet: (state) => {
      netState = state
      for (let i = 0; i < entries.length; i++) {
        entries[i].net = state?.driven[i] ?? null
      }
    },
    tick,
    spawnAll,
    recall,
    placeFromNet,
    where,
    setDay: (day, night, fog, sunEl) => {
      mats.setDay(day, night, fog, sunEl)
      for (const e of entries) e.v.setDay?.(day, night)
    },
    setLightWarmup: (on) => {
      for (const e of entries) e.v.setLightWarmup?.(on)
    },
    setMuted: (on) => {
      for (const k of Object.keys(voices) as VehicleId[]) voices[k].mute(on)
    },
    sleep,
    dispose: () => {
      sleep()
      for (const k of Object.keys(voices) as VehicleId[]) voices[k].dispose()
      for (const e of entries) e.v.dispose()
      effects.dispose()
      mats.dispose()
    },
  }
}

/** put every machine back where it started; the scene calls this once the
    world is up, and again if the player ever asks for a clean slate */
export const homeSpots = HOME
