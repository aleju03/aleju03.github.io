import * as THREE from 'three'
import { noStand, type HullStation, type Solid } from '../physics/collision'
import {
  V, at, capRing, createFacets, createPartBuilder, markDynamic, revolve, skinRings, tube,
  type Facets,
} from './parts'
import type { VehicleMaterials } from './materials'
import { axes, clamp, clearAt, damp, groundUnder, netMotion, sweepBody, type NetMotion } from './chassis'
import { flyScale, spaceK } from '../levels/space'
import type { DriveEnv, DriveStep, NetPose, Vehicle } from './types'

/*
  The ship: a two-seat snub runabout for getting off the planet, parked in
  the back garden. The brief was "a little spaceship, Star Wars inspired",
  so it borrows that family's vocabulary and none of its shapes: an
  off-white wedge of a hull with a blunt faceted nose, a bubble canopy over
  two seats side by side, stub wings carrying a pod engine each, a swept
  dorsal fin, red livery bands, and the hull broken up with greebles (vents,
  boxes, pipes, panel lines) the way a working machine's is. It is small:
  9.4 units nose to tail, 7.1 across the pods, a runabout, not a fighter.

  ------------------------------------------------------------------ the shape

  It is built the car's way (car.ts's header, parts.ts's `createFacets`):
  flat panels with creased normals, which is what reads through the pixel
  look. The fuselage is a table of stations, each a closed five-point half
  profile (belly, chine, beam, shoulder, crown), skinned cell by cell; the
  crown and shoulder cells over the cockpit are left open and a faceted
  glass canopy stands in the hole, with a trim lining inside the cockpit so
  the sides are not see-through from the seats. The engine pods are flat
  octagons, and their exhausts, the two ports in the tail and the thin
  strips round each nozzle are the glow: clones of the fleet's lamp
  material driven hot with the throttle (`glowMats`), never a light,
  because a light appearing in flight relinks every lit program in the
  scene. A clone of an existing material links nothing new either.

  ------------------------------------------------------------------ the flight

  One integrator, two regimes, blended by how much air is left under it
  (levels/space.ts's `spaceK` of the height over the ground, and none at all
  on a level that has no air, the Moon):

  - **In the air** it flies like a hovercraft with wings. Gravity is
    cancelled by a lift servo that holds the height when no vertical key is
    down, drag gives it a top speed (about 100 u/s, twice that on boost),
    sideways slip is bled off so it carves rather than skates, and the nose
    levels itself when R/F are let go. A/D yaw it and bank it into the turn.
  - **In space** it keeps its momentum: no drag, no levelling, and thrust is
    along the nose wherever the nose points, so it is a real 6-DOF coast with
    R/F pitching and Space/C translating along its own up. Shift is the
    boost in both.

  Thrust and the speed cap grow with height the same way the noclip flight
  does (`flyScale`), because space here is scaled down but not small: the
  Moon is three hundred thousand units off, and at the ground's speeds that
  is an hour. On the Moon the lift servo carries on under a sixth of the
  gravity, so it hovers and lands there the same way it does at home.

  The level cuts (Earth to Moon and back) are CrtScene's: while this
  machine is flown the level system is allowed to fire a seam, and the
  arrival places the ship where the seam lands (`warp`) with its rider still
  aboard. Nothing in here knows which level it is on beyond the air and the
  gravity its env says.
*/

const TAU = Math.PI * 2
const G = 34

/* ----------------------------------------------------------------- scale -- */

const SIZE = { halfX: 3.6, halfZ: 4.8, height: 3.9 }
/** the pods' centre, either side */
const POD_X = 3.0
const POD_Y = 1.65
const POD_R = 0.55
const POD_Z0 = -1.2
const POD_Z1 = 3.8

/* ------------------------------------------------------------- the hull -- */

interface Sect {
  z: number
  /** belly half-width and height */
  bw: number
  by: number
  /** chine, beam (widest) and shoulder half-widths and heights */
  cw: number
  cy: number
  hw: number
  hy: number
  sw: number
  sy: number
  /** crown height on the centreline */
  ty: number
}
const sect = (z: number, bw: number, by: number, cw: number, cy: number, hw: number, hy: number, sw: number, sy: number, ty: number): Sect =>
  ({ z, bw, by, cw, cy, hw, hy, sw, sy, ty })

/* Nose to tail: a blunt faceted nose, the cockpit (the open bay between
   the stations at -2.7 and 0.8), the widest body over the wing roots and a
   flat tail carrying the two thruster ports. */
const SECTIONS: Sect[] = [
  sect(-4.7, 0.18, 1.45, 0.3, 1.5, 0.36, 1.7, 0.24, 1.86, 1.9),
  sect(-4.1, 0.34, 1.12, 0.78, 1.18, 0.95, 1.66, 0.62, 2.12, 2.2),
  sect(-2.7, 0.42, 0.98, 1.12, 1.05, 1.36, 1.72, 1.08, 2.42, 2.62),
  sect(0.8, 0.46, 0.95, 1.2, 1.02, 1.46, 1.76, 1.16, 2.5, 2.74),
  sect(2.6, 0.46, 0.98, 1.18, 1.05, 1.42, 1.78, 1.1, 2.48, 2.7),
  sect(4.4, 0.38, 1.08, 0.98, 1.14, 1.2, 1.74, 0.92, 2.34, 2.5),
]
const COCKPIT_BAY = 2

const ringOf = (s: Sect) => {
  const half: Array<[number, number]> = [[s.bw, s.by], [s.cw, s.cy], [s.hw, s.hy], [s.sw, s.sy]]
  const r: THREE.Vector3[] = []
  for (const [x, y] of half) r.push(new THREE.Vector3(-x, y, s.z))
  r.push(new THREE.Vector3(0, s.ty, s.z))
  for (let i = half.length - 1; i >= 0; i--) r.push(new THREE.Vector3(half[i][0], half[i][1], s.z))
  return r
}
/** ring segment k's panel from the belly up on either side (-1 the belly) */
const panelOf = (k: number) => (k === 8 ? -1 : k < 4 ? k : 7 - k)

/* -------------------------------------------------------------- footprint -- */

/** the fuselage's own stations, and the wing and pods as a full-width band
    where they are: a walker meets the pods, not air beside the cabin */
const HULL: HullStation[] = [
  ...SECTIONS.map((s) => {
    const wing = s.z > POD_Z0 && s.z < POD_Z1
    return { z: s.z, hw: wing ? POD_X + POD_R : s.hw, top: s.z > -2.8 && s.z < 1 ? 3.7 : s.ty }
  }),
  { z: POD_Z0, hw: POD_X + POD_R, top: 2.8 },
  { z: POD_Z1, hw: POD_X + POD_R, top: 2.6 },
].sort((a, b) => a.z - b.z)

/* --------------------------------------------------------------- flight -- */

/** forward thrust, u/s^2, and what boost multiplies it by */
const FWD_A = 46
const BOOST = 2.1
/** vertical thrust along the ship's own up */
const VERT_A = 24
/** air drag per second at sea level: FWD_A / DRAG is the air top speed */
const DRAG = 0.45
/** how fast sideways slip is bled off in the air, per second */
const SLIP_BLEED = 2.6
/** the lift servo: vertical velocity toward zero when no key asks otherwise */
const HOLD = 3.2
const YAW_RATE = 1.35
const PITCH_RATE = 1.0
/** the nose may go this far up or down in the air, and this far in space */
const PITCH_AIR = 0.55
const PITCH_SPACE = 1.35
const BANK = 0.5
/** the cap, before flyScale grows it with height */
const TOP = 220
const SPOOL = 0.7

/** the seated faces, either side of the centreline */
const SEAT_X = 0.6
const SEAT_Y = 2.62
const SEAT_Z = -0.95
const SEAT_FIT = 0.84

/** a flat octagon pod along z, as rings for the facets */
const podRings = (x: number, y: number, r: number, zs: number[], rs: number[]) =>
  zs.map((z, i) => {
    const ring: THREE.Vector3[] = []
    for (let k = 0; k < 8; k++) {
      const a = Math.PI + Math.PI / 8 - (k / 8) * TAU
      ring.push(V(x + Math.cos(a) * r * rs[i], y + Math.sin(a) * r * rs[i], z))
    }
    return ring
  })

/** a flat plate: a box of facets from four top corners and a thickness */
const plate = (f: Facets, pts: THREE.Vector3[], thick: number, slot: 'paint' | 'paint2' | 'metal' | 'trim' | 'dark') => {
  const top = pts
  const bot = pts.map((p) => V(p.x, p.y - thick, p.z))
  const c = top.reduce((a, p) => a.add(p), V(0, 0, 0)).divideScalar(top.length)
  f.quadOut(top[0], top[1], top[2], top[3], slot, V(0, 1, 0))
  f.quadOut(bot[0], bot[1], bot[2], bot[3], slot, V(0, -1, 0))
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const mid = top[i].clone().add(top[j]).multiplyScalar(0.5).sub(c).setY(0)
    f.quadOut(top[i], top[j], bot[j], bot[i], slot, mid)
  }
}

export function buildShip(opts: { mats: VehicleMaterials }): Vehicle {
  const { mats } = opts
  const slots = mats.slots
  const owned: THREE.Material[] = []
  /** the engines' glow: the lamp material cloned and driven hot, so it
      shares the lamp's program and links nothing new */
  const glow = (base: string, hot: string) => {
    const m = (slots.lamp as THREE.MeshStandardMaterial).clone()
    m.color.set(base)
    m.emissive = new THREE.Color(hot)
    m.emissiveIntensity = 0.6
    owned.push(m)
    return m
  }
  const engineGlow = glow('#1c3a52', '#62d6ff')
  const navRed = glow('#3a0d0c', '#ff2a18')
  const navGreen = glow('#0c3a18', '#25ff6a')

  const b = createPartBuilder()
  const f = createFacets()

  /* --- the fuselage: panels by bay, the cockpit's crown left open ---------- */
  const rings = SECTIONS.map(ringOf)
  skinRings(f, rings, (s, k) => {
    const panel = panelOf(k)
    if (panel === -1) return 'trim'
    if (s === COCKPIT_BAY && panel >= 3) return null
    // the livery: red on the beam band aft of the cockpit and on the nose
    if (panel === 2 && (s >= 3 || s === 0)) return 'paint'
    if (panel === 0) return 'metal'
    return 'paint2'
  }, true)
  capRing(f, rings[0], -1, 'paint')
  capRing(f, rings[rings.length - 1], 1, 'trim')

  /* --- the canopy: a faceted bubble standing in the cockpit's hole --------- */
  {
    const a = SECTIONS[COCKPIT_BAY]
    const c = SECTIONS[COCKPIT_BAY + 1]
    const arch = (z: number, s: Sect, lift: number) => [
      V(-s.sw, s.sy, z), V(-s.sw * 0.84, s.sy + 0.8 * lift, z), V(-s.sw * 0.44, s.sy + 1.25 * lift, z),
      V(0, s.sy + 1.36 * lift, z), V(s.sw * 0.44, s.sy + 1.25 * lift, z), V(s.sw * 0.84, s.sy + 0.8 * lift, z), V(s.sw, s.sy, z),
    ]
    const mid = (t: number) => {
      const z = a.z + (c.z - a.z) * t
      const s: Sect = { ...a, z, sw: a.sw + (c.sw - a.sw) * t, sy: a.sy + (c.sy - a.sy) * t }
      return s
    }
    const can = [arch(a.z, a, 0.08), arch(mid(0.3).z, mid(0.3), 1), arch(mid(0.78).z, mid(0.78), 1), arch(c.z, c, 0.12)]
    skinRings(f, can, () => 'glass')
    // the frame: a hoop at the windscreen's top edge, and a spine
    b.add(tube(can[1], 0.05, 5), 'dark')
    b.add(tube(can[2], 0.05, 5), 'dark')
    b.add(tube([can[0][3], can[1][3], can[2][3], can[3][3]], 0.045, 5), 'dark')
    // the cockpit's inside: a floor, the side linings, the dash and the
    // rear bulkhead, since from the seats the hull is seen from behind
    const zf = a.z + 0.05
    const zr = c.z - 0.05
    f.quadOut(V(-1.15, 1.35, zf), V(1.15, 1.35, zf), V(1.15, 1.35, zr), V(-1.15, 1.35, zr), 'trim', V(0, 1, 0))
    for (const side of [-1, 1]) {
      f.quadOut(V(side * 1.25, 1.35, zf), V(side * 1.25, 1.35, zr), V(side * 1.05, a.sy - 0.02, zr), V(side * 1.0, a.sy - 0.02, zf), 'trim', V(-side, 0, 0))
    }
    f.quadOut(V(-1.2, 1.35, zf), V(1.2, 1.35, zf), V(1.0, a.sy, zf), V(-1.0, a.sy, zf), 'dark', V(0, 0, 1))
    f.quadOut(V(-1.2, 1.35, zr), V(1.2, 1.35, zr), V(1.08, c.sy, zr), V(-1.08, c.sy, zr), 'trim', V(0, 0, -1))
    // seats, and the dash's instrument strip
    b.both(() => {
      b.add(new THREE.BoxGeometry(0.72, 0.2, 0.8), 'seat', at(SEAT_X, 1.55, -0.55))
      b.add(new THREE.BoxGeometry(0.7, 0.95, 0.18), 'seat', at(SEAT_X, 2.05, -0.1, 0.18))
    })
    b.add(new THREE.BoxGeometry(1.6, 0.26, 0.5), 'trim', at(0, 2.1, a.z + 0.3, -0.5))
    b.add(new THREE.BoxGeometry(1.2, 0.1, 0.06), 'lamp', at(0, 2.23, a.z + 0.16, -0.5))
  }

  /* --- wings and pods -------------------------------------------------------- */
  for (const side of [-1, 1]) {
    const sx = (x: number) => side * x
    // a stub wing from the beam to the pod, swept, thin, with a red tip band
    plate(f, [V(sx(1.3), 1.72, -0.6), V(sx(POD_X - 0.35), 1.72, 0.4), V(sx(POD_X - 0.35), 1.72, 3.2), V(sx(1.3), 1.72, 3.6)], 0.16, 'paint2')
    plate(f, [V(sx(POD_X - 0.9), 1.735, 0.25), V(sx(POD_X - 0.35), 1.735, 0.4), V(sx(POD_X - 0.35), 1.735, 3.2), V(sx(POD_X - 0.9), 1.735, 3.25)], 0.02, 'paint')
    // the pod: a flat octagon, fat amidships, necked to a nozzle
    const pod = podRings(sx(POD_X), POD_Y, POD_R, [POD_Z0, POD_Z0 + 0.5, 1.2, POD_Z1 - 0.7, POD_Z1], [0.55, 1, 1, 0.92, 0.78])
    skinRings(f, pod, (_s, k) => (k === 2 || k === 1 ? 'paint' : 'paint2'), true)
    capRing(f, pod[0], -1, 'metal')
    // the nozzle: a dark ring standing proud of the pod's tail, and the
    // glow disc inside it
    const nz = podRings(sx(POD_X), POD_Y, POD_R, [POD_Z1, POD_Z1 + 0.35], [0.82, 0.74])
    skinRings(f, nz, () => 'dark', true)
    // a cannon along each pod's outboard flank, reaching past the nose:
    // the one piece of hardware that says what family this machine is from
    b.add(tube([V(sx(POD_X + 0.42), POD_Y + 0.12, 1.4), V(sx(POD_X + 0.42), POD_Y + 0.12, -3.1)], 0.075, 6), 'metal')
    b.add(tube([V(sx(POD_X + 0.42), POD_Y + 0.12, -3.1), V(sx(POD_X + 0.42), POD_Y + 0.12, -3.4)], 0.11, 6, { caps: true }), 'dark')
    b.add(new THREE.BoxGeometry(0.22, 0.26, 0.9), 'metal', at(sx(POD_X + 0.42), POD_Y + 0.12, 0.9))
    // panel lines round the pod, fore and aft of the livery band
    for (const z of [0.1, 2.3]) {
      const ring = podRings(sx(POD_X), POD_Y, POD_R * 1.012, [z - 0.04, z + 0.04], [1, 1])
      skinRings(f, ring, () => 'dark', true)
    }
    // an intake grille on each pod's nose and a fin on its outboard side
    f.quadOut(V(sx(POD_X - 0.3), POD_Y - 0.2, POD_Z0 + 0.3), V(sx(POD_X + 0.3), POD_Y - 0.2, POD_Z0 + 0.3), V(sx(POD_X + 0.3), POD_Y + 0.2, POD_Z0 + 0.3), V(sx(POD_X - 0.3), POD_Y + 0.2, POD_Z0 + 0.3), 'dark', V(0, 0, -1))
    plate(f, [V(sx(POD_X + 0.45), POD_Y + 0.55, 1.6), V(sx(POD_X + 0.95), POD_Y + 0.8, 2.9), V(sx(POD_X + 0.95), POD_Y + 0.8, 3.4), V(sx(POD_X + 0.45), POD_Y + 0.55, 3.5)], 0.08, 'paint2')
  }

  /* --- the dorsal fin and the greebles ------------------------------------- */
  {
    const fin = [V(0, 2.7, 1.9), V(0, 4.0, 3.5), V(0, 4.0, 4.1), V(0, 2.5, 4.35)]
    for (const side of [-1, 1]) {
      f.quadOut(...(fin.map((p) => V(side * 0.09, p.y, p.z)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]), 'paint2', V(side, 0, 0))
    }
    f.quadOut(V(-0.09, 4.0, 3.5), V(0.09, 4.0, 3.5), V(0.09, 4.0, 4.1), V(-0.09, 4.0, 4.1), 'paint', V(0, 1, 0))
    f.quadOut(V(-0.09, 2.7, 1.9), V(0.09, 2.7, 1.9), V(0.09, 4.0, 3.5), V(-0.09, 4.0, 3.5), 'paint2', V(0, 0.8, -1))
  }
  // vents, boxes and conduit on the hull's back: what makes a machine look
  // like it does something, and at this size a handful of flat chips
  const chip = (w: number, h: number, d: number, slot: 'metal' | 'dark' | 'trim', x: number, y: number, z: number) =>
    b.add(new THREE.BoxGeometry(w, h, d), slot, at(x, y, z))
  b.both(() => {
    chip(0.42, 0.14, 0.7, 'metal', 0.55, 2.74, 1.5)
    chip(0.3, 0.1, 0.3, 'dark', 0.62, 2.72, 2.5)
    chip(0.5, 0.12, 0.26, 'metal', 0.5, 2.66, 3.4)
    chip(0.06, 0.3, 1.8, 'dark', 1.47, 1.72, 2.1)
    chip(0.3, 0.3, 0.5, 'metal', 1.3, 1.25, -3.4)
    b.add(tube([V(0.95, 2.62, 1.0), V(1.05, 2.4, 2.4), V(1.02, 2.3, 3.9)], 0.05, 5), 'metal')
  })
  // the two thruster ports in the flat tail, dark bezels with the glow in them
  for (const x of [-0.55, 0.55]) {
    b.add(revolve([[0.34, 0], [0.34, 0.12], [0.26, 0.14]], 8), 'dark', at(x, 1.75, SECTIONS[5].z, Math.PI / 2))
  }
  f.flush(b)

  /* --- landing gear: a nose leg and two mains, folded away in flight -------- */
  const gear = new THREE.Group()
  gear.name = 'gear'
  {
    const gb = createPartBuilder()
    const legs: Array<[number, number]> = [[0, -3.3], [-1.05, 2.2], [1.05, 2.2]]
    for (const [x, z] of legs) {
      gb.add(tube([V(x, 1.0, z), V(x * 1.1, 0.12, z)], 0.08, 6), 'metal')
      gb.add(revolve([[0.32, 0], [0.3, 0.1], [0, 0.12]], 8), 'dark', at(x * 1.1, 0.0, z))
    }
    gear.add(gb.build(slots, { name: 'legs' }))
  }

  const shell = b.build(slots, { cast: true, receive: true, name: 'shell' })

  /* --- the glow: exhausts, ports and nav lights, each its own material ------- */
  const glowGroup = new THREE.Group()
  {
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, mat: THREE.Matrix4) => {
      const pb = createPartBuilder()
      pb.add(geo, 'lamp', mat)
      glowGroup.add(pb.build({ lamp: m }, { cast: false }))
    }
    const disc = (r: number) => revolve([[r, 0], [r * 0.6, 0.06], [0, 0.08]], 12)
    for (const side of [-1, 1]) {
      add(disc(POD_R * 0.68), engineGlow, at(side * POD_X, POD_Y, POD_Z1 + 0.3, Math.PI / 2))
    }
    for (const x of [-0.55, 0.55]) add(disc(0.26), engineGlow, at(x, 1.75, SECTIONS[5].z + 0.1, Math.PI / 2))
    const lens = () => revolve([[0.03, 0], [0.1, 0.06], [0.1, 0.14], [0, 0.18]], 8)
    add(lens(), navRed, at(-(POD_X + 0.95), POD_Y + 0.8, 3.0, 0, 0, Math.PI / 2))
    add(lens(), navGreen, at(POD_X + 0.95, POD_Y + 0.8, 3.0, 0, 0, -Math.PI / 2))
  }

  const root = new THREE.Group()
  root.name = 'ship'
  root.add(shell, gear, glowGroup)
  const driverSeat = new THREE.Group()
  driverSeat.name = 'driverSeat'
  driverSeat.position.set(-SEAT_X, SEAT_Y, SEAT_Z)
  driverSeat.userData.fit = SEAT_FIT
  root.add(driverSeat)
  const passengerSeat = new THREE.Group()
  passengerSeat.name = 'passengerSeat'
  passengerSeat.position.set(SEAT_X, SEAT_Y, SEAT_Z)
  passengerSeat.userData.fit = SEAT_FIT
  root.add(passengerSeat)
  markDynamic(root)

  /* ------------------------------------------------------------- the sim -- */

  const pos = root.position
  const vel = new THREE.Vector3()
  let yaw = 0
  let pitch = 0
  let roll = 0
  let spool = 0
  let running = false
  let landed = true
  let gearOut = 1
  let night = 0
  let throttleK = 0
  const solid = noStand(new THREE.Box3()) as Solid
  const fwd = new THREE.Vector3()
  const upV = new THREE.Vector3()
  const eul = new THREE.Euler(0, 0, 0, 'YXZ')
  const q = new THREE.Quaternion()

  const step: DriveStep = {
    speed: 0, planar: 0, load: 0, rpm: 0, gear: 0, grounded: true, vy: 0,
    altitude: 0, slip: 0, braking: 0, surface: 'grass', impact: 0, moved: false,
  }

  const restUnder = (env: DriveEnv) => {
    let g = groundUnder(pos.x, pos.z, pos.y + 1.0, env)
    if (env.waterY !== undefined && g < env.waterY) g = env.waterY + env.waveAt(pos.x, pos.z)
    return g
  }

  const fitSolid = () => {
    const c = Math.abs(Math.cos(yaw))
    const s = Math.abs(Math.sin(yaw))
    const ex = SIZE.halfX * c + SIZE.halfZ * s
    const ez = SIZE.halfX * s + SIZE.halfZ * c
    solid.min.set(pos.x - ex, pos.y + 0.1, pos.z - ez)
    solid.max.set(pos.x + ex, pos.y + SIZE.height, pos.z + ez)
  }

  const writeTransform = () => {
    root.rotation.set(pitch, yaw, roll, 'YXZ')
    gear.scale.set(1, 0.15 + 0.85 * gearOut, 1)
    gear.position.y = 1.0 * (1 - gearOut) * 0.85
    engineGlow.emissiveIntensity = 0.25 + spool * (1.2 + throttleK * 5.5) + night * 0.4
  }

  const update = (env: DriveEnv, driven: boolean): DriveStep => {
    const dt = env.dt
    const k = axes(env.keys, env.frozen || !driven)
    const live = driven && !env.frozen
    const pIn = live ? (env.keys.has('KeyR') ? 1 : 0) - (env.keys.has('KeyF') ? 1 : 0) : 0
    spool = running ? Math.min(1, spool + dt * SPOOL) : Math.max(0, spool - dt * SPOOL * 0.6)

    const rest = restUnder(env)
    const alt = pos.y - rest
    // how much air there is: none on a level without it, thinning with height
    const air = env.air === false ? 0 : 1 - spaceK(alt)
    const gShare = env.gravity ?? 1
    const g = G * gShare * (env.air === false ? 1 : air)
    const scale = flyScale(Math.max(0, alt))
    const boost = k.boost ? BOOST : 1

    /* attitude: yaw on A/D, pitch on R/F; in the air the nose levels itself
       and the machine banks into a turn, in space it holds what it is given */
    const yawIn = -k.side
    yaw += yawIn * YAW_RATE * spool * dt
    const pMax = PITCH_AIR + (PITCH_SPACE - PITCH_AIR) * (1 - air)
    if (pIn !== 0) pitch = clamp(pitch + pIn * PITCH_RATE * spool * dt, -pMax, pMax)
    else if (air > 0.05 || landed) pitch = damp(pitch, 0, 1.6 * Math.max(air, landed ? 1 : 0), dt)
    pitch = clamp(pitch, -pMax, pMax)
    roll = damp(roll, landed ? 0 : yawIn * BANK * air, 3, dt)

    eul.set(pitch, yaw, roll, 'YXZ')
    q.setFromEuler(eul)
    fwd.set(0, 0, -1).applyQuaternion(q)
    upV.set(0, 1, 0).applyQuaternion(q)

    /* thrust */
    throttleK = damp(throttleK, Math.abs(k.fwd) * boost * 0.5 + (k.up || k.down ? 0.25 : 0), 5, dt)
    const push = k.fwd * FWD_A * boost * spool * scale
    vel.addScaledVector(fwd, push * dt)
    const vertIn = (k.up ? 1 : 0) - (k.down ? 1 : 0)
    if (vertIn !== 0) {
      // up is the ship's own up in space and the world's in the air
      const ux = upV.x * (1 - air)
      const uy = upV.y * (1 - air) + air
      const uz = upV.z * (1 - air)
      const a = vertIn * VERT_A * boost * spool * scale
      vel.x += ux * a * dt
      vel.y += uy * a * dt
      vel.z += uz * a * dt
    }
    // gravity, and the lift that cancels it while the engines are up: with
    // no vertical key the servo holds the height, which is the hover
    vel.y -= g * dt
    if (spool > 0.05 && !landed) {
      vel.y += g * spool * dt
      if (vertIn === 0 && (air > 0.02 || env.air === false)) vel.y = damp(vel.y, 0, HOLD * spool, dt)
    }
    // the air: drag, and the slip bled off so it carves
    if (air > 0) {
      const d = Math.exp(-DRAG * air * dt)
      vel.multiplyScalar(d)
      const side = vel.x * Math.cos(yaw) - vel.z * Math.sin(yaw)
      const bleed = side * (1 - Math.exp(-SLIP_BLEED * air * dt))
      vel.x -= Math.cos(yaw) * bleed
      vel.z += Math.sin(yaw) * bleed
    }
    const cap = TOP * scale * (k.boost ? BOOST : 1)
    if (vel.lengthSq() > cap * cap) vel.setLength(cap)

    /* contact */
    if (landed) {
      const fr = Math.exp(-6 * dt)
      vel.x *= fr
      vel.z *= fr
      if (vel.y < 0) vel.y = 0
    }
    pos.addScaledVector(vel, dt)
    let impact = 0
    const restNow = restUnder(env)
    if (pos.y <= restNow) {
      if (!landed) impact = Math.max(0, -vel.y)
      pos.y = restNow
      if (vel.y < 0) vel.y = 0
      landed = true
    } else if (pos.y > restNow + 0.08) landed = false
    // lift off: a touch of up (or thrust while spooled) unsticks it
    if (landed && spool > 0.6 && vertIn > 0) {
      landed = false
      pos.y = restNow + 0.1
    }
    // the hull sweeps the world near the ground; in the sky there is nothing
    if (alt < 60) {
      const hit = sweepBody(pos, yaw, SIZE.halfX * 0.8, SIZE.halfZ, pos.y + 0.3, pos.y + 3.2, env.collision)
      if (hit.depth > 0) {
        pos.x += hit.push.x
        pos.z += hit.push.z
        const len = Math.hypot(hit.push.x, hit.push.z)
        if (len > 1e-6) {
          const nx = hit.push.x / len
          const nz = hit.push.z / len
          const into = vel.x * nx + vel.z * nz
          if (into < 0) {
            impact = Math.max(impact, -into)
            vel.x -= nx * into
            vel.z -= nz * into
          }
        }
      }
    }
    gearOut = damp(gearOut, alt < 6 || landed ? 1 : 0, 2.5, dt)

    writeTransform()
    fitSolid()

    const planar = Math.hypot(vel.x, vel.z)
    const speed = vel.length()
    step.speed = vel.dot(fwd)
    step.planar = planar
    step.load = clamp(speed / (TOP * scale), 0, 1)
    step.rpm = spool * (0.35 + 0.65 * clamp(throttleK, 0, 1))
    step.gear = 0
    step.grounded = landed
    step.vy = vel.y
    step.altitude = Math.max(0, pos.y - restNow)
    step.slip = 0
    step.braking = 0
    step.surface = env.surfaceAt(pos.x, pos.z)
    step.impact = impact
    step.moved = speed > 0.02
    return step
  }

  /* ------------------------------------------------------------ net drive -- */

  const netM: NetMotion = { f: 0, planar: 0, yawRate: 0 }
  let netYaw = 0
  const netStep = (env: DriveEnv, p: NetPose): DriveStep => {
    const dt = env.dt
    if (p.snapped) netYaw = p.yaw
    netMotion(p, netYaw, dt, netM)
    netYaw = p.yaw
    pos.set(p.x, p.y, p.z)
    yaw = p.yaw
    pitch = p.pitch
    roll = p.roll
    vel.set(p.vx, p.vy, p.vz)
    spool = Math.min(1, spool + dt * SPOOL)
    throttleK = damp(throttleK, clamp(vel.length() / TOP, 0, 1), 4, dt)
    const rest = restUnder(env)
    landed = pos.y - rest < 0.3
    gearOut = damp(gearOut, pos.y - rest < 6 ? 1 : 0, 2.5, dt)
    writeTransform()
    fitSolid()
    step.speed = netM.f
    step.planar = netM.planar
    step.load = clamp(vel.length() / TOP, 0, 1)
    step.rpm = spool * 0.6
    step.grounded = landed
    step.vy = p.vy
    step.altitude = Math.max(0, pos.y - rest)
    step.surface = env.surfaceAt(pos.x, pos.z)
    step.impact = 0
    step.moved = netM.planar > 0.02 || Math.abs(p.vy) > 0.02
    return step
  }

  const placeAt = (x: number, z: number, hdg: number, env: DriveEnv) => {
    pos.set(x, env.groundAt(x, z), z)
    yaw = hdg
    pitch = 0
    roll = 0
    vel.set(0, 0, 0)
    spool = 0
    running = false
    pos.y = restUnder(env)
    landed = true
    gearOut = 1
    writeTransform()
    fitSolid()
  }

  const exitSpot = (out: THREE.Vector3, env: DriveEnv) => {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    // out past the pods on either side, or off the nose
    for (const [lx, lz] of [[-(SIZE.halfX + 1.4), -1], [SIZE.halfX + 1.4, -1], [0, -(SIZE.halfZ + 1.6)], [-(SIZE.halfX + 3), -1]]) {
      const wx = pos.x + lx * c + lz * s
      const wz = pos.z - lx * s + lz * c
      const gy = groundUnder(wx, wz, pos.y + 1.2, env)
      if (Math.abs(gy - pos.y) < 3 && clearAt(wx, wz, 0.8, gy, gy + 4, env.collision)) {
        out.set(wx, gy, wz)
        return gy
      }
    }
    out.set(pos.x - (SIZE.halfX + 1.4) * c, pos.y, pos.z + (SIZE.halfX + 1.4) * s)
    return pos.y
  }

  return {
    id: 'ship',
    label: 'ship',
    verb: 'fly',
    root,
    driverSeat,
    passengerSeat,
    view: {
      back: 16,
      up: 5,
      stretch: 5,
      fov: 62,
      anchor: new THREE.Vector3(0, 2.4, 0.5),
      eye: new THREE.Vector3(-SEAT_X, SEAT_Y, SEAT_Z - 0.2),
      eye2: new THREE.Vector3(SEAT_X, SEAT_Y, SEAT_Z - 0.2),
      // it goes fast enough that a lagging boom loses it: smooth the boom
      // in the ship's frame rather than the world's
      rigid: true,
    },
    size: SIZE,
    hull: HULL,
    get yaw() {
      return yaw
    },
    get pitch() {
      return pitch
    },
    get roll() {
      return roll
    },
    solid,
    reach: 5.2,
    carry: { mass: 280, density: 0.6, bottom: 0.02 },
    spacecraft: true,
    placeAt,
    warp: (x, y, z, hdg) => {
      pos.set(x, y, z)
      yaw = hdg
      pitch = 0
      roll = 0
      vel.set(0, 0, 0)
      landed = false
      gearOut = 0
      writeTransform()
      fitSolid()
    },
    mount: () => {
      running = true
    },
    dismount: () => {
      running = false
    },
    exitSpot,
    update,
    netStep,
    setDay: (_d, n) => {
      night = n
      navRed.emissiveIntensity = 0.4 + n * 2.4
      navGreen.emissiveIntensity = 0.4 + n * 2.4
    },
    dispose: () => {
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) m.geometry.dispose()
      })
      for (const m of owned) m.dispose()
      owned.length = 0
    },
  }
}
