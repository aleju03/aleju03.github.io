import type * as THREE from 'three'
import type { CollisionSet, HullStation, Solid } from '../physics/collision'
import type { StepSurface } from '../core/sfx'

/*
  The vehicle contract.

  A vehicle is the walk controller's opposite number: it takes the same key
  set and the same world (a ground function, a waterline, a CollisionSet) and
  writes a transform — except the transform belongs to the machine, and the
  camera hangs off it rather than sitting inside it. Everything the scene
  needs in order to drive one is here; everything about *how* a car corners or
  a rotor lifts stays inside car.ts / boat.ts / heli.ts.

  Three of them ship, one per medium, and the split is not decoration: the
  world is a continent with a sea on it and mountains behind, so a road
  machine, a hull and a rotorcraft each reach somewhere the other two cannot.
  The air vehicle is a helicopter rather than a fixed wing for exactly one
  reason — there are no runways out there. Anything that needs six hundred
  units of flat asphalt to get down again is a vehicle you use once.

  Every implementation must keep the runtime's two standing rules: no React,
  no DOM, and deterministic given its inputs. A vehicle is a small pure
  integrator with a mesh attached.

  Each one seats two, and the second chair is not decoration: the walk is
  shared, so a machine with one seat is a machine that splits a group up. The
  passenger has no controls — `netStep` is the other half of that story. A
  machine being driven from somebody else's browser must not integrate here,
  or the local physics and the arriving transform fight over the same six
  numbers every frame and the loser is whoever is watching. So a vehicle can
  be *told* where it is instead of working it out, and asked to animate its
  own cosmetics off the motion that implies.
*/

export type VehicleId = 'car' | 'boat' | 'heli'

/** the world one tick happens in — the same four questions the walk asks */
export interface DriveEnv {
  dt: number
  keys: ReadonlySet<string>
  /** a level cut, a pause menu, a mount animation: controls are ignored but
      the physics keeps settling, exactly like the walk's `frozen` */
  frozen: boolean
  /** height of the drawn ground anywhere in the world */
  groundAt: (x: number, z: number) => number
  /** the waterline, where the level has one */
  waterY?: number
  collision: CollisionSet
  /** what is underfoot: picks grip, rolling drag and the colour of the dust */
  surfaceAt: (x: number, z: number) => StepSurface
  /**
   * How far the drawn sea surface is displaced from `waterY` right here, this
   * instant. The water's swell lives in a vertex shader (streamer.ts), so a
   * hull that floats at the flat waterline sits inside the wave crests and
   * under the troughs — visibly, and worst exactly when the boat is the thing
   * you are looking at. This is that same function, evaluated on the CPU.
   * Levels without water hand back 0.
   */
  waveAt: (x: number, z: number) => number
}

/** what a tick did — read by the camera, the HUD, the sound and the effects.
    Implementations reuse one instance per vehicle; read it, don't keep it */
export interface DriveStep {
  /** speed along the heading, units/s, signed (negative is reverse) */
  speed: number
  /** planar speed regardless of direction, units/s */
  planar: number
  /** 0..1 of this vehicle's own top speed, for the HUD bar */
  load: number
  /** engine or rotor note, 0 idle .. 1 screaming. What the synth rides */
  rpm: number
  /** which gear a geared vehicle is in; 0 for everything else */
  gear: number
  /** touching the thing that holds it up (road, water, ground) */
  grounded: boolean
  /** vertical speed, units/s */
  vy: number
  /** clearance over the surface below, 0 while resting on it */
  altitude: number
  /** 0 tracking true .. 1 fully sideways. Tyres howl and the camera leans */
  slip: number
  /** 0..1, how hard the brakes are on: the tail lamps read this */
  braking: number
  /** the surface being travelled over right now */
  surface: StepSurface
  /** closing speed of any hard contact this tick, else 0 */
  impact: number
  /** worth re-baking a shadow map over */
  moved: boolean
}

/**
 * One frame of somebody else's driving, as it arrives off the wire.
 *
 * The transform is authoritative — it is the product of the driver's own
 * integrator, run at their frame rate on their machine — and the velocity is
 * read back out of the interpolation rather than sent, so what the wheels and
 * the wake are animated from is exactly the motion being drawn.
 */
export interface NetPose {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  vx: number
  vy: number
  vz: number
  /** the body was placed rather than moved: a join, a recall, a handover.
      Anything that eases (a rotor spinning up, a lamp fading) must jump */
  snapped: boolean
}

/** where the camera should sit for this vehicle, and how it should behave */
export interface DriveView {
  /** boom length behind the vehicle at rest, in units */
  back: number
  /** and how high above the anchor */
  up: number
  /** how much further back the boom stretches at top speed */
  stretch: number
  /** base field of view while driving; speed widens it on top */
  fov: number
  /** the anchor the boom swings around, in model space */
  anchor: THREE.Vector3
  /** the driver's eye, in model space, for the cockpit view */
  eye: THREE.Vector3
  /** and the passenger's, for the same view from the other chair */
  eye2: THREE.Vector3
}

export interface Vehicle {
  id: VehicleId
  /** what the HUD calls it */
  label: string
  /** the verb its interact prompt uses: "drive", "board", "fly" */
  verb: string
  /** everything that renders, one node the scene parents */
  root: THREE.Group
  /** the camera rules for this machine */
  view: DriveView
  /** local attachment for the live player rig while this machine is occupied.
      Its origin is the seated avatar's pelvis and it inherits every attitude
      transform the driver should ride (the car body, the boat hull, etc.) */
  driverSeat: THREE.Object3D
  /** the same, for the chair without the controls. Whoever is in it — a
      remote player's avatar or the local one — rides exactly the same
      attitude as the driver, which is the point of hanging both off the body
      rather than off the root */
  passengerSeat: THREE.Object3D
  /** the body's own extent, in model units: where the dust comes off, how far
      away a player has to stand to be put down clear of it, and the reach of
      the sweep each machine runs against the world. What the *player* collides
      with is `hull`, which is the same body described honestly */
  size: { halfX: number; halfZ: number; height: number }
  /** the footprint a walker meets, in this machine's own frame: stations fore
      to aft carrying the half-width and the standable height there. Lifted off
      the same section tables the body is lofted from, so it cannot drift from
      the paint — see collision.ts on why a moving solid needs one and nothing
      the world builds does. Static; the registry hangs it on the live Solid
      and rewrites only the transform */
  hull: HullStation[]
  /** heading in radians; 0 faces -Z, matching the walk controller's yaw */
  readonly yaw: number
  /** the other two attitude angles. They are read rather than taken off the
      scene graph because the three machines do not agree about where they
      live — the car's body carries them under a yawed root, the boat and the
      helicopter fold all three into one YXZ euler — and the network needs the
      numbers, not the arrangement */
  readonly pitch: number
  readonly roll: number
  /** the solid the player bumps into while nobody is driving. Collapsed to a
      point while occupied — you are inside it, and a box you are inside of
      pushes you out through the nearest wall */
  solid: Solid
  /** how close a walker must be to the door to be offered the prompt */
  reach: number
  /** put it down here and let it settle: spawn, or a recall from the menu */
  placeAt: (x: number, z: number, yaw: number, env: DriveEnv) => void
  /** the player just got in */
  mount: () => void
  /** ...and just got out */
  dismount: () => void
  /**
   * Where to stand the player down, in world space. It has to be a real
   * place: beside the machine, clear of its own box, on ground that exists.
   * Returns the feet height it chose alongside the point.
   */
  exitSpot: (out: THREE.Vector3, env: DriveEnv) => number
  /** one physics tick. `driven` false means it is parked and only settling */
  update: (env: DriveEnv, driven: boolean) => DriveStep
  /**
   * One frame of being driven from another browser. No integration happens:
   * the transform is copied in and everything the physics would have animated
   * — wheels, rotor, suspension, lamps — is derived from the implied motion
   * instead. The returned step is a real one, so the dust, the wake and the
   * engine note downstream of it need no idea which kind of frame it was.
   */
  netStep: (env: DriveEnv, p: NetPose) => DriveStep
  /** day cycle: headlamps, nav lights, instrument glow */
  setDay?: (day: number, night: number) => void
  /** Temporarily expose threshold-switched renderer lights so the scene can
      compile their lighting layout under its boot cover. Turning this back
      off restores the visibility dictated by the live day cycle. */
  setLightWarmup?: (on: boolean) => void
  dispose: () => void
}
