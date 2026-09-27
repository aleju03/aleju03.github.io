import * as THREE from 'three'
import { createMeshBuilder, type MeshBuilder } from '../core/geometry'
import { seeded } from '../core/rand'
import { noStand } from '../physics/collision'

/*
  The clutter that makes the house somebody's: a family's things in about
  2005, kitbashed out of boxes, cylinders and the odd torus, because at the
  look's few hundred lines a poster is three rectangles and a bicycle is two
  rings and a stick.

  Everything here is stamped into two merged buffers, not placed as objects.
  One is lit, flat vertex colour through a single MeshStandardMaterial; the
  other is light itself (lamp shades, standby lights, the router's front)
  through a single unlit material whose colours run past 1 so the look's ACES
  reads them as glowing. Two programs and two draw calls for the whole lot,
  compiled at boot with the rest of the room, which is the only way a house
  this full stays inside the room's shader budget: a material per prop would
  be a program per prop, linked the first time somebody turned round.

  Three things are not in the soup, each for a reason:
  - the router's LEDs blink, so each is a tiny mesh of its own sharing the
    glow material, toggled visible (visibility never relinks anything);
  - the fridge's magnets and calendar ride the fridge door, so houseWorld
    asks for them as a mesh and hangs it on the door's own node;
  - the lamps. A lamp here is its fixture plus a pool of light in the look
    (render/pixelLook.ts), not a light in the scene: another PointLight
    would be another term in every lit program in the house. `lamps` lists
    every pool as x, y, z and radius, the radius negative to mark it as an
    indoor lamp, whose pool reaches the floor under it at any height rather
    than only five to nine units down like a streetlamp's (the look's shader
    reads the sign).

  Solids: anything big enough to walk into registers a box, standable when
  its top is somewhere to stand (a workbench, a stack of boxes) and noStand
  when it is not (a coat on a hook, a bicycle).
*/

export interface PropsHandles {
  /** the lamp pools: x, y, z, radius per lamp; see the header */
  lamps: Float32Array
  lampCount: number
  /** blink the router */
  update: (dt: number) => void
  /** the fridge door's magnets, a paper calendar and a drawing: a mesh laid
      on a door whose front is the +x face of `front`, for the caller to hang
      on the door's own node */
  fridgeFront: (front: THREE.Box3) => THREE.Mesh | null
}

interface Opts {
  root: THREE.Group
  obstacles: THREE.Box3[]
  /** the upper floor's height */
  up: number
  trackDisposable: (d: { dispose: () => void }) => void
}

const UNIT = new THREE.BoxGeometry(1, 1, 1)
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12)
const BALL = new THREE.SphereGeometry(0.5, 12, 8)
const RING = new THREE.TorusGeometry(0.5, 0.05, 6, 20)

export function buildHouseProps({ root, obstacles, up, trackDisposable }: Opts): PropsHandles {
  const lit = createMeshBuilder()
  const glow = createMeshBuilder()
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const v = new THREE.Vector3()
  const s = new THREE.Vector3()
  const colors = new Map<string, THREE.Color>()
  const col = (hex: string, k = 1) => {
    const key = `${hex}*${k}`
    let c = colors.get(key)
    if (!c) {
      c = new THREE.Color(hex).multiplyScalar(k)
      colors.set(key, c)
    }
    return c
  }

  /** a primitive, centred at (x, y, z), sized (w, h, d), turned (rx, ry, rz) */
  const stamp = (
    b: MeshBuilder, geo: THREE.BufferGeometry, color: THREE.Color,
    w: number, h: number, d: number, x: number, y: number, z: number,
    ry = 0, rx = 0, rz = 0,
  ) => {
    m4.compose(v.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz, 'YXZ')), s.set(w, h, d))
    b.add(geo, m4, color)
  }
  /** a box standing on y0 */
  const box = (
    hex: string, w: number, h: number, d: number,
    x: number, y0: number, z: number, ry = 0, rx = 0, rz = 0,
  ) => stamp(lit, UNIT, col(hex), w, h, d, x, y0 + h / 2, z, ry, rx, rz)
  const cyl = (hex: string, r: number, h: number, x: number, y0: number, z: number, rx = 0, rz = 0) =>
    stamp(lit, CYL, col(hex), r * 2, h, r * 2, x, y0 + h / 2, z, 0, rx, rz)
  const ball = (hex: string, w: number, h: number, d: number, x: number, y0: number, z: number) =>
    stamp(lit, BALL, col(hex), w, h, d, x, y0 + h / 2, z)
  /** something that shines: `k` is how far past white it is pushed */
  const shine = (
    hex: string, k: number, w: number, h: number, d: number,
    x: number, y0: number, z: number, ry = 0,
  ) => stamp(glow, UNIT, col(hex, k), w, h, d, x, y0 + h / 2, z, ry)

  const solid = (
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, stand = true,
  ) => {
    const b = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1))
    obstacles.push(stand ? b : noStand(b))
  }

  /** a flat thing hung on a wall: `n` is the wall's inward normal axis and
      sign ('x+' is a wall at constant x facing +x), `u` its position along
      the wall, `y` its centre height */
  type Face = 'x+' | 'x-' | 'z+' | 'z-'
  const onWall = (
    face: Face, at: number, u: number, y: number,
    w: number, h: number, out: number, hex: string, depth = 0.04,
  ) => {
    const sgn = face.endsWith('+') ? 1 : -1
    const c = at + sgn * (out + depth / 2)
    if (face[0] === 'x') stamp(lit, UNIT, col(hex), depth, h, w, c, y, u)
    else stamp(lit, UNIT, col(hex), w, h, depth, u, y, c)
  }
  /** a poster: a ground, a shape, a title bar, a strip of small print */
  const poster = (
    face: Face, at: number, u: number, y: number, w: number, h: number,
    ground: string, shape: string, title: string, round = false,
  ) => {
    onWall(face, at, u, y, w, h, 0.01, ground, 0.02)
    const sgn = face.endsWith('+') ? 1 : -1
    if (round) {
      const c = at + sgn * 0.035
      const r = Math.min(w, h) * 0.3
      if (face[0] === 'x') stamp(lit, CYL, col(shape), r * 2, 0.02, r * 2, c, y + h * 0.08, u, 0, 0, Math.PI / 2)
      else stamp(lit, CYL, col(shape), r * 2, 0.02, r * 2, u, y + h * 0.08, c, 0, Math.PI / 2)
    } else {
      onWall(face, at, u, y + h * 0.08, w * 0.62, h * 0.5, 0.03, shape, 0.01)
    }
    onWall(face, at, u, y - h * 0.34, w * 0.8, h * 0.12, 0.03, title, 0.01)
    onWall(face, at, u, y + h * 0.4, w * 0.5, h * 0.05, 0.03, title, 0.01)
  }
  /** a framed photo */
  const photo = (face: Face, at: number, u: number, y: number, w: number, h: number, hex: string) => {
    // each layer stands proud of the one behind it, or the frame box
    // swallows the mat and the picture and hangs a dark tile on the wall
    onWall(face, at, u, y, w + 0.12, h + 0.12, 0.005, '#3b2a1c', 0.03)
    onWall(face, at, u, y, w, h, 0.035, '#e6dcc6', 0.02)
    onWall(face, at, u, y - h * 0.05, w * 0.8, h * 0.7, 0.055, hex, 0.01)
  }

  const lamps: number[] = []
  /** an indoor pool: its lens, and how far across it lights */
  const pool = (x: number, y: number, z: number, r: number) => lamps.push(x, y, z, -r)

  const rand = seeded(0x2005)

  /* ============================================================ GROUND */

  /* -- living room: the entertainment wall. Tower speakers either side of
     the cabinet, a shelf of tapes and DVDs, the VCR on the cabinet top, a
     few frames over the set; magazines and the remote on the coffee table */
  const CAB_TOP = 1.36
  for (const x of [-4.95, 0.95]) {
    box('#2a2624', 0.62, 2.5, 0.62, x, 0, 9.95)
    // two drivers and a tweeter on the face toward the room (-z)
    cyl('#141312', 0.22, 0.04, x, 0.75, 9.63, Math.PI / 2)
    cyl('#141312', 0.22, 0.04, x, 1.35, 9.63, Math.PI / 2)
    cyl('#6b6660', 0.09, 0.04, x, 2.0, 9.63, Math.PI / 2)
    solid(x - 0.4, 0, 9.55, x + 0.4, 2.5, 10.35, false)
  }
  {
    // the tape shelf: an open box with three boards, spines along each
    const x = -0.25
    const z = 9.95
    box('#3d2b1d', 1.0, 0.06, 0.7, x, 0, z)
    box('#3d2b1d', 1.0, 0.06, 0.7, x, 1.74, z)
    box('#3d2b1d', 0.06, 1.8, 0.7, x - 0.47, 0, z)
    box('#3d2b1d', 0.06, 1.8, 0.7, x + 0.47, 0, z)
    box('#35261a', 1.0, 1.8, 0.04, x, 0, z + 0.33)
    for (const y of [0.06, 0.62, 1.18]) {
      box('#3d2b1d', 0.9, 0.05, 0.66, x, y, z)
      let u = x - 0.4
      while (u < x + 0.38) {
        const vhs = rand() < 0.55
        const t = vhs ? 0.11 : 0.07
        const hh = vhs ? 0.42 : 0.38
        const spine = vhs
          ? ['#1c1c1e', '#1c1c1e', '#2b2e3a'][Math.floor(rand() * 3)]
          : ['#2a5c9c', '#9c2a2a', '#d9d4c7', '#2e7a4a', '#c79a2a'][Math.floor(rand() * 5)]
        box(spine, t, hh, 0.52, u + t / 2, y + 0.05, z - 0.02)
        if (vhs) box('#e8e2d2', t + 0.005, 0.12, 0.3, u + t / 2, y + 0.2, z - 0.02)
        u += t + 0.012
      }
    }
    solid(x - 0.55, 0, z - 0.4, x + 0.55, 1.8, z + 0.4)
  }
  // the VCR, and a DVD player on it, on the cabinet beside the set
  box('#2b2a28', 0.95, 0.2, 0.75, -1.3, CAB_TOP, 9.85)
  box('#3a3937', 0.9, 0.14, 0.7, -1.3, CAB_TOP + 0.2, 9.85)
  box('#101010', 0.5, 0.05, 0.02, -1.3, CAB_TOP + 0.07, 9.47)
  shine('#39ff7a', 3, 0.14, 0.04, 0.02, -1.05, CAB_TOP + 0.08, 9.46)
  shine('#ff5a3a', 3, 0.04, 0.03, 0.02, -1.6, CAB_TOP + 0.25, 9.49)
  // three frames over the set
  photo('z-', 10.5, -4.0, 4.2, 0.7, 0.9, '#6b8fb0')
  photo('z-', 10.5, -2.65, 4.4, 1.1, 0.8, '#b08a5c')
  photo('z-', 10.5, -1.3, 4.2, 0.7, 0.9, '#8aa06b')
  // the coffee table's top: a stack of magazines, the remote, a TV guide
  {
    const top = 1.01
    box('#c43b3b', 0.7, 0.03, 0.9, -3.3, top, 7.2, 0.2)
    box('#e2d24a', 0.7, 0.03, 0.9, -3.28, top + 0.03, 7.25, -0.1)
    box('#3b6fb0', 0.66, 0.03, 0.86, -3.3, top + 0.06, 7.18, 0.35)
    box('#1c1c1e', 0.16, 0.05, 0.55, -2.1, top, 7.5, 0.6)
    box('#dcd6c8', 0.5, 0.02, 0.7, -1.6, top, 6.9, -0.3)
  }
  // a cushion knocked askew at the sofa's far end
  box('#c9a15a', 0.8, 0.8, 0.25, -4.6, 1.0, 4.4, 0.3, -0.25, 0)
  // the living-room lamps
  pool(-2.6, 5.4, 6.3, 4.4)
  pool(0.75, 3.6, 4.2, 3.0)

  /* -- foyer: coats on hooks by the door, the shoe pile under them, a mat,
     the cordless phone on its table */
  {
    const x = 2.4
    box('#3b2a1c', 0.08, 0.14, 2.0, x + 0.04, 3.9, -0.3)
    const coats: Array<[number, string, number]> = [
      [-1.0, '#23324d', 1.9], [-0.45, '#8c2f28', 1.6], [0.1, '#b89b6a', 2.1], [0.6, '#3f5a3a', 1.4],
    ]
    for (const [z, hex, h] of coats) {
      box('#8a7a5c', 0.06, 0.1, 0.06, x + 0.1, 3.85, z)
      box(hex, 0.3, h, 0.62, x + 0.2, 3.95 - h, z, 0, 0, 0.03)
    }
    solid(x, 1.9, -1.4, x + 0.45, 4.0, 1.0, false)
    for (let i = 0; i < 7; i++) {
      const hex = ['#2a2522', '#e8e4dc', '#6a3b24', '#c33', '#2c3e6b'][i % 5]
      box(hex, 0.28, 0.18, 0.62, x + 0.35 + rand() * 0.7, 0, -1.3 + i * 0.26, rand() * 1.6 - 0.8)
    }
    box('#6a4a34', 2.1, 0.02, 1.3, 5.5, 0, -0.95)
    box('#8a6a4c', 1.7, 0.021, 0.9, 5.5, 0, -0.95)
    // the phone table's top is at 1.08
    box('#d8d2c4', 0.42, 0.1, 0.32, 3.15, 1.08, 1.8, 0.3)
    box('#2a2a2c', 0.14, 0.09, 0.46, 3.18, 1.16, 1.76, 0.3)
    shine('#57ff8a', 3, 0.05, 0.03, 0.03, 3.0, 1.12, 1.92)
    box('#e8dcc0', 0.3, 0.02, 0.22, 3.1, 1.08, 1.35, -0.2)
  }
  pool(3.8, 5.6, 5.0, 3.4)
  pool(3.6, 5.6, 12.2, 3.0)

  /* -- kitchen: the wall phone with its coiled cord, the fruit bowl on the
     dining table, a dish rack and the paper towels on the counter */
  {
    const z = 14.0
    const x = -1.2
    box('#e2dccc', 0.46, 0.8, 0.16, x, 3.1, z + 0.08)
    box('#d8d2c2', 0.16, 0.72, 0.14, x - 0.12, 3.14, z + 0.2)
    // the cord: a helix hanging from the handset's foot, stretched longer
    // than any cord needed to be
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 90; i++) {
      const t = i / 90
      const a = t * Math.PI * 2 * 14
      pts.push(new THREE.Vector3(x - 0.12 + Math.cos(a) * 0.05, 3.1 - t * 1.4, z + 0.26 + Math.sin(a) * 0.05))
    }
    const cord = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 180, 0.014, 4, false)
    lit.add(cord, m4.identity(), col('#d8d2c2'))
    cord.dispose()
  }
  {
    const top = 1.71
    cyl('#d8cfb8', 0.42, 0.18, -2.1, top, 19.8)
    ball('#e8892b', 0.28, 0.28, 0.28, -2.2, top + 0.1, 19.72)
    ball('#c8322a', 0.26, 0.26, 0.26, -1.95, top + 0.12, 19.9)
    ball('#e2c93a', 0.34, 0.2, 0.22, -2.05, top + 0.2, 19.66)
    box('#e6e0d0', 0.62, 0.02, 0.45, -3.0, top, 20.4, 0.1)
    box('#e6e0d0', 0.62, 0.02, 0.45, -1.2, top, 19.2, -0.2)
  }
  {
    // the counter run's top is at 1.69; the sink sits mid-run at z 21.65
    const top = 1.69
    box('#b8bcc0', 0.62, 0.3, 0.8, -6.35, top, 22.35)
    for (let i = 0; i < 4; i++) box('#e8e6e0', 0.05, 0.42, 0.42, -6.35, top + 0.08, 22.08 + i * 0.16, 0, 0, 0.15)
    cyl('#6a6660', 0.05, 0.5, -6.6, top, 20.75)
    cyl('#f2f0ea', 0.16, 0.42, -6.6, top + 0.04, 20.75)
  }
  pool(-4.6, 5.6, 20.6, 4.2)
  pool(-2.1, 5.2, 19.8, 3.4)

  /* -- half bath and laundry: the basket, the mat */
  box('#9ab8c8', 0.9, 0.62, 0.62, -5.2, 0, 13.2)
  box('#e4dccc', 0.7, 0.2, 0.46, -5.2, 0.62, 13.2, 0.2)
  box('#b84a4a', 0.4, 0.14, 0.3, -5.05, 0.8, 13.1, 0.8)
  solid(-5.7, 0, 12.85, -4.7, 0.85, 13.55)
  box('#6e8a7a', 1.0, 0.02, 1.4, -4.4, 0, 14.2)
  pool(-5.0, 5.6, 13.55, 2.8)

  /* -- garage: the workbench and its pegboard on the back wall, cardboard
     boxes along the east wall, a bicycle leaning by the window, metal
     shelving with paint cans, an oil stain, a basketball hoop outside */
  {
    // east of the hall door's swing, which sweeps two units into the garage
    const z = 14.0
    const x = 11.1
    box('#7a5a3a', 3.6, 0.14, 1.4, x, 1.76, z - 0.75)
    for (const [dx, dz] of [[-1.7, -0.1], [1.7, -0.1], [-1.7, -1.35], [1.7, -1.35]]) {
      box('#4a3a2a', 0.12, 1.76, 0.12, x + dx, 0, z + dz)
    }
    box('#6a4a2e', 3.5, 0.08, 1.25, x, 0.5, z - 0.75)
    box('#b89a6a', 3.4, 1.8, 0.05, x, 2.3, z - 0.05)
    // the tools on it: silhouettes
    box('#2a2a2c', 0.08, 0.7, 0.04, x - 1.4, 2.9, z - 0.1)
    box('#2a2a2c', 0.4, 0.12, 0.04, x - 1.4, 3.55, z - 0.1)
    box('#8a8e92', 0.9, 0.35, 0.03, x - 0.6, 3.2, z - 0.1, 0, 0, 0.2)
    box('#c43b2a', 0.1, 0.6, 0.04, x + 0.1, 2.9, z - 0.1)
    box('#2a2a2c', 0.5, 0.1, 0.04, x + 0.7, 3.4, z - 0.1)
    box('#e2b43a', 0.3, 0.3, 0.04, x + 1.3, 3.0, z - 0.1)
    box('#3a3a3c', 0.3, 0.28, 0.4, x + 1.3, 1.9, z - 0.8)
    box('#5a5a5c', 0.5, 0.26, 0.3, x - 1.2, 1.9, z - 0.7, 0.4)
    solid(x - 1.85, 0, z - 1.5, x + 1.85, 1.9, z)
  }
  {
    const x = 12.5
    const stack: Array<[number, number, number, number, number]> = [
      // w, h, d, z, y0
      [0.9, 0.8, 1.1, 9.2, 0], [0.9, 0.7, 1.0, 10.4, 0], [0.8, 0.6, 0.9, 9.3, 0.8],
      [0.9, 0.9, 1.1, 11.6, 0], [0.7, 0.5, 0.8, 11.5, 0.9],
    ]
    for (const [w, h, d, z, y0] of stack) {
      box('#b08a5a', w, h, d, x - (0.9 - w) / 2, y0, z, (rand() - 0.5) * 0.12)
      box('#d8c49a', w + 0.01, 0.06, 0.12, x - (0.9 - w) / 2, y0 + h - 0.02, z)
    }
    solid(x - 0.5, 0, 8.6, 13.0, 1.4, 12.2)
  }
  {
    // the bike: two rings, a frame, a seat, bars; leant on the east wall
    const x = 12.55
    const lean = 0.12
    for (const z of [3.1, 5.3]) {
      stamp(lit, RING, col('#1a1a1a'), 1.3, 1.3, 1.0, x, 0.66, z, Math.PI / 2, 0, lean)
      stamp(lit, CYL, col('#9a9a9a'), 0.1, 0.12, 0.1, x, 0.66, z, 0, Math.PI / 2)
    }
    const frame = '#2b5c9c'
    stamp(lit, UNIT, col(frame), 0.07, 0.07, 2.0, x - 0.08, 1.35, 4.2, 0, 0, lean)
    stamp(lit, UNIT, col(frame), 0.07, 1.0, 0.07, x - 0.05, 1.0, 4.6, 0, -0.45, lean)
    stamp(lit, UNIT, col(frame), 0.07, 1.0, 0.07, x - 0.05, 1.0, 3.6, 0, 0.55, lean)
    stamp(lit, UNIT, col('#1a1a1a'), 0.16, 0.08, 0.4, x - 0.12, 1.62, 4.75, 0, 0, lean)
    stamp(lit, UNIT, col('#6a6a6a'), 0.9, 0.06, 0.06, x - 0.14, 1.7, 3.25, 0, 0, lean)
    solid(x - 0.35, 0, 2.4, 13.0, 1.8, 6.0, false)
  }
  {
    const x = 8.05
    for (const y of [0, 1.1, 2.2, 3.3]) box('#8a8e92', 0.8, 0.06, 2.6, x, y + 0.2, 4.0)
    for (const dz of [-1.25, 1.25]) {
      box('#6a6e72', 0.06, 3.6, 0.06, x - 0.37, 0, 4.0 + dz)
      box('#6a6e72', 0.06, 3.6, 0.06, x + 0.37, 0, 4.0 + dz)
    }
    for (let i = 0; i < 9; i++) {
      const y = [0.26, 1.36, 2.46][i % 3]
      const hex = ['#c9c2b0', '#6b8fb0', '#c43b3b', '#e2c93a'][Math.floor(rand() * 4)]
      cyl(hex, 0.17, 0.4, x + (rand() - 0.5) * 0.3, y, 3.0 + Math.floor(i / 3) * 0.95)
    }
    solid(x - 0.45, 0, 2.6, x + 0.45, 3.6, 5.4, false)
  }
  box('#2a2622', 1.6, 0.01, 1.1, 10.4, 0, 5.5, 0.4)
  {
    // the hoop over the carriage doors, on the gable
    const z = -2.3
    box('#e8e4dc', 1.9, 1.2, 0.08, 10.4, 6.45, z)
    box('#c43b2a', 0.64, 0.46, 0.02, 10.4, 6.6, z - 0.05)
    box('#3a3a3a', 0.12, 0.12, 0.5, 10.4, 6.5, z - 0.28)
    stamp(lit, RING, col('#e0672a'), 0.8, 0.8, 1.2, 10.4, 6.5, z - 0.8, 0, Math.PI / 2)
  }
  pool(10.3, 5.6, 6.0, 4.2)

  /* -- the doorstep, the mailbox by the gate, the bins behind the garage */
  lamps.push(5.5, 5.14, -2.35, 3.0) // outdoors: a streetlamp's band
  {
    const x = 3.4
    const z = -3.55
    box('#e8e4dc', 0.14, 2.3, 0.14, x, 0, z)
    box('#2a3a5a', 0.45, 0.5, 0.8, x, 2.3, z)
    box('#c43b2a', 0.04, 0.35, 0.08, x + 0.25, 2.55, z + 0.2)
    solid(x - 0.2, 0, z - 0.45, x + 0.2, 2.8, z + 0.45, false)
  }
  for (const [x, z, hex] of [[12.3, 15.4, '#2e5a3a'], [12.3, 16.6, '#2a3a5a']] as const) {
    box(hex, 0.9, 2.0, 0.95, x, 0, z)
    box(hex, 0.95, 0.12, 1.0, x, 2.0, z)
    solid(x - 0.5, 0, z - 0.5, x + 0.5, 2.12, z + 0.5)
  }

  /* ============================================================= UPPER */

  const U = up

  /* -- the computer room: posters, the CD tower with the modem on it, the
     speakers either side of the monitor with the sub on the floor, the desk
     lamp, and the mess: a throw kicked off the bed, clothes, a backpack */
  poster('x+', -7.6, 3.0, U + 3.6, 1.25, 1.75, '#1c2a4a', '#e8c23a', '#e8e2d2', true)
  poster('x-', 3.4, 3.8, U + 3.5, 1.3, 1.8, '#8c1f2a', '#1a1a1a', '#e8e2d2')
  poster('z+', -1.75, -2.65, U + 3.9, 1.0, 1.4, '#2e6a4a', '#e8e2d2', '#1a1a1a', true)
  poster('z+', -1.75, 2.55, U + 3.7, 1.1, 1.5, '#3a2a5c', '#e06a2a', '#e8e2d2')
  {
    // the CD tower, a column of jewel cases
    const x = 2.55
    const z = -1.25
    box('#1c1c1e', 0.5, 2.2, 0.45, x, U, z)
    for (let i = 0; i < 22; i++) {
      const hex = ['#d8d4cc', '#2a5c9c', '#9c2a2a', '#e2c93a', '#2e7a4a', '#6a3b8c'][Math.floor(rand() * 6)]
      box(hex, 0.42, 0.075, 0.03, x, U + 0.12 + i * 0.09, z + 0.23)
    }
    solid(x - 0.3, U, z - 0.3, x + 0.3, U + 2.2, z + 0.3, false)
    // the cable modem on top, its lights on the front
    box('#2a2c30', 0.46, 0.34, 0.36, x, U + 2.2, z)
  }
  // the speakers flank the monitor on the desk; the sub sits on the floor
  const DESK = U + 1.844
  for (const x of [-1.12, 1.45]) {
    box('#2a2826', 0.3, 0.52, 0.32, x, DESK, -0.7)
    cyl('#141312', 0.1, 0.03, x, DESK + 0.12, -0.53, Math.PI / 2)
    cyl('#6b6660', 0.05, 0.03, x, DESK + 0.36, -0.53, Math.PI / 2)
  }
  box('#2a2826', 0.85, 0.95, 0.85, -2.4, U, -1.15)
  cyl('#141312', 0.28, 0.04, -2.4, U + 0.22, -0.72, Math.PI / 2)
  solid(-2.9, U, -1.65, -1.9, U + 0.95, -0.65)
  {
    // the desk lamp, a gooseneck bent over the keyboard
    const x = 1.62
    const z = 0.1
    cyl('#2a2826', 0.16, 0.06, x, DESK, z)
    stamp(lit, UNIT, col('#2a2826'), 0.05, 0.7, 0.05, x, DESK + 0.38, z, 0, 0, 0.35)
    stamp(lit, UNIT, col('#2a2826'), 0.05, 0.5, 0.05, x - 0.3, DESK + 0.78, z, 0, 0, 1.2)
    shine('#ffd68a', 2.2, 0.26, 0.12, 0.26, x - 0.5, DESK + 0.62, z)
    box('#3a3634', 0.32, 0.16, 0.32, x - 0.5, DESK + 0.72, z)
  }
  pool(1.1, DESK + 0.9, 0.1, 2.4)
  // the throw, kicked half off the bed; a pillow gone astray
  box('#3b5c8c', 1.9, 0.14, 1.5, -5.2, U + 0.9, 7.0, 0.4, 0, 0.12)
  box('#3b5c8c', 0.12, 0.8, 1.2, -4.2, U + 0.2, 6.8, 0.4, 0, -0.2)
  box('#e8e4dc', 0.9, 0.3, 0.6, -4.7, U + 0.95, 9.1, 0.9, 0.2, 0)
  // clothes on the floor, a backpack against the wall
  for (let i = 0; i < 5; i++) {
    const hex = ['#2a3a5c', '#e8e4dc', '#8a2a2a', '#3a3a3a', '#6a7a5a'][i]
    box(hex, 0.6 + rand() * 0.3, 0.1, 0.5 + rand() * 0.3, -3.6 + rand() * 0.7, U + i * 0.06, 5.0 + rand() * 0.6, rand() * 3)
  }
  box('#c43b2a', 0.7, 0.9, 0.4, -1.6, U, 10.2, 0.1)
  box('#2a2a2c', 0.5, 0.35, 0.1, -1.6, U + 0.2, 9.98, 0.1)
  // a game controller and a can on the low table by the window
  box('#2a2a2c', 0.36, 0.08, 0.22, -6.4, U + 0.64, 3.5, 0.5)
  cyl('#c43b2a', 0.07, 0.25, -6.3, U + 0.64, 2.95)
  pool(0, U + 5.4, 4.4, 4.0)

  /* -- the upper hall and the linen closet */
  photo('z+', 10.5, -1.2, U + 3.4, 0.8, 1.0, '#a07a5a')
  photo('z+', 10.5, 0.3, U + 3.6, 0.7, 0.7, '#6a8fa0')
  photo('z+', 10.5, 1.8, U + 3.4, 0.8, 1.0, '#8a9a6a')
  {
    // shelves along the street wall, towels folded on them
    for (const y of [1.2, 2.4, 3.6]) {
      box('#d8d0bc', 3.4, 0.07, 0.8, 5.6, U + y, -1.3)
      let x = 4.1
      while (x < 7.2) {
        const w = 0.55 + rand() * 0.2
        const hex = ['#e8e4dc', '#9ab8c8', '#c9a0a0', '#b8c8a0', '#e8d8a8'][Math.floor(rand() * 5)]
        const n = 2 + Math.floor(rand() * 3)
        for (let k = 0; k < n; k++) box(hex, w, 0.12, 0.6, x + w / 2, U + y + 0.07 + k * 0.12, -1.3, (rand() - 0.5) * 0.1)
        x += w + 0.15
      }
    }
    for (const x of [3.95, 7.25]) box('#c8c0ac', 0.06, 4.0, 0.8, x, U, -1.3)
    solid(3.9, U, -1.75, 7.3, U + 4.0, -0.85, false)
    // the vacuum, standing in the corner
    box('#6a2a2a', 0.5, 0.5, 0.35, 7.1, U, 1.5)
    box('#3a3a3a', 0.06, 2.2, 0.06, 7.1, U + 0.5, 1.4)
  }
  pool(4.4, U + 5.6, 11.8, 3.4)
  pool(5.5, U + 5.6, 0.2, 2.2)

  /* -- the full bath: the medicine cabinet over the sink, the shower
     curtain on its rod over the tub, a mat */
  box('#d8d4cc', 1.3, 1.6, 0.22, -4.55, U + 2.7, 10.61)
  box('#9fb4bc', 1.1, 1.36, 0.02, -4.55, U + 2.82, 10.73)
  box('#b8bcc0', 0.05, 0.05, 4.9, -5.3, U + 5.3, 13.55)
  box('#a8c8d8', 0.04, 3.4, 2.4, -5.3, U + 1.9, 12.4)
  box('#8ab0c4', 0.05, 3.4, 0.12, -5.3, U + 1.9, 13.55)
  box('#c8b87a', 1.0, 0.02, 1.5, -4.5, U, 13.6)
  pool(-5.0, U + 5.6, 13.55, 2.8)

  /* -- the master bedroom: reading lamps on both nightstands, books, the
     little television on the dresser, the hamper */
  for (const z of [16.9, 22.1]) {
    const top = U + 1.35
    cyl('#c9b89a', 0.14, 0.5, 1.15, top, z - 0.2)
    shine('#ffd9a0', 1.6, 0.5, 0.42, 0.5, 1.15, top + 0.5, z - 0.2)
    box('#6a3b2a', 0.4, 0.1, 0.55, 1.35, top, z + 0.3, 0.3)
    pool(1.15, top + 0.9, z - 0.2, 2.4)
  }
  {
    const top = U + 1.6
    box('#3a3834', 1.2, 1.0, 1.0, 4.4, top, 23.7)
    box('#1a2024', 0.9, 0.7, 0.02, 4.4, top + 0.15, 23.19)
    box('#e8e0cc', 0.25, 0.4, 0.25, 2.7, top, 23.7)
    box('#9c2a2a', 0.5, 0.08, 0.7, 5.6, top, 23.6, 0.2)
  }
  box('#b89a6a', 0.75, 1.1, 0.75, 6.95, U, 17.75)
  box('#e8e4dc', 0.6, 0.2, 0.5, 6.95, U + 1.05, 17.7, 0.4, 0, 0.2)
  solid(6.5, U, 17.3, 7.4, U + 1.2, 18.2)
  pool(4.6, U + 5.4, 19.4, 4.0)

  /* -- the den: beanbags on the rug, the console under the second set, its
     controllers on the floor, a shelf of game boxes, a poster */
  for (const [x, z, hex] of [[-2.8, 19.4, '#8c2a2a'], [-2.6, 21.9, '#2a3a6a']] as const) {
    ball(hex, 1.6, 0.95, 1.5, x, U, z)
    ball(hex, 1.2, 0.5, 0.5, x - 0.35, U + 0.55, z)
    solid(x - 0.75, U, z - 0.7, x + 0.75, U + 0.7, z + 0.7)
  }
  {
    const top = U + 1.36
    box('#1c1c1e', 0.65, 0.16, 0.9, -0.2, top, 21.95)
    shine('#3a8aff', 3, 0.02, 0.03, 0.08, -0.53, top + 0.06, 21.7)
    box('#2a2a2c', 0.36, 0.08, 0.22, -1.6, U, 20.2, 1.2)
    box('#2a2a2c', 0.36, 0.08, 0.22, -1.9, U, 21.3, 2.0)
    box('#1c1c1e', 0.02, 0.02, 1.2, -1.0, U + 0.01, 20.6, 0.4)
  }
  {
    // the game shelf against the west wall, boxes on edge
    const x = -7.25
    const z = 17.9
    box('#4a3a2a', 0.6, 0.06, 2.0, x, U, z)
    for (const y of [0.7, 1.4, 2.1, 2.8]) box('#4a3a2a', 0.6, 0.06, 2.0, x, U + y, z)
    box('#3d2f22', 0.6, 2.9, 0.06, x, U, z - 0.97)
    box('#3d2f22', 0.6, 2.9, 0.06, x, U, z + 0.97)
    for (const y of [0.06, 0.76, 1.46, 2.16]) {
      let u = z - 0.9
      while (u < z + 0.85) {
        const hex = ['#1c1c1e', '#2a5c9c', '#9c2a2a', '#e8e2d2', '#2e7a4a', '#e2c93a'][Math.floor(rand() * 6)]
        box(hex, 0.45, 0.55, 0.06, x + 0.05, U + y, u + 0.03)
        u += 0.09
      }
    }
    solid(x - 0.35, U, z - 1.05, x + 0.35, U + 2.95, z + 1.05, false)
  }
  poster('z-', 24.5, -1.4, U + 3.6, 1.2, 1.7, '#1a1a1a', '#e03a3a', '#e8e2d2', true)
  pool(-3.4, U + 5.6, 20.6, 3.8)

  /* ------------------------------------------------------------ build -- */

  const litMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 })
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })
  trackDisposable(litMat)
  trackDisposable(glowMat)
  const add = (b: MeshBuilder, mat: THREE.Material, shadows: boolean) => {
    const g = b.build()
    if (!g) return
    trackDisposable(g)
    const mesh = new THREE.Mesh(g, mat)
    mesh.castShadow = shadows
    mesh.receiveShadow = shadows
    root.add(mesh)
  }
  add(lit, litMat, true)
  add(glow, glowMat, false)

  // the router's lights: separate so they can blink, sharing the glow
  const leds: Array<{ mesh: THREE.Mesh; rate: number; phase: number; duty: number }> = []
  {
    const x = 2.55
    const z = -1.25 + 0.185
    const hexes = ['#57ff8a', '#57ff8a', '#ffb13a', '#57ff8a']
    hexes.forEach((hex, i) => {
      const b = createMeshBuilder()
      stamp(b, UNIT, col(hex, 3), 0.045, 0.035, 0.02, x - 0.15 + i * 0.1, U + 2.42, z)
      const g = b.build()
      if (!g) return
      trackDisposable(g)
      const mesh = new THREE.Mesh(g, glowMat)
      root.add(mesh)
      // power steady, the rest flickering at their own traffic
      leds.push({ mesh, rate: i === 0 ? 0 : 3 + i * 2.3, phase: i * 1.7, duty: 0.55 })
    })
  }
  let t = 0
  const update = (dt: number) => {
    t += dt
    for (const l of leds) {
      if (!l.rate) continue
      const on = Math.sin(t * l.rate + l.phase) + Math.sin(t * l.rate * 2.7 + l.phase * 3) * 0.5 > -0.4
      if (l.mesh.visible !== on) l.mesh.visible = on
    }
  }

  const fridgeFront = (front: THREE.Box3) => {
    const b = createMeshBuilder()
    const x = front.max.x + 0.012
    const y0 = front.min.y
    const h = front.max.y - y0
    const zc = (front.min.z + front.max.z) / 2
    const w = front.max.z - front.min.z
    const at = (hex: string, ww: number, hh: number, u: number, v: number, d = 0.02, rz = 0) =>
      stamp(b, UNIT, col(hex), d, hh, ww, x + d / 2, y0 + h * v, zc + w * u, 0, rz)
    // the paper calendar, a month on a picture
    at('#f2eee4', 0.55, 0.8, -0.05, 0.62)
    at('#3b6fb0', 0.5, 0.3, -0.05, 0.72, 0.024)
    at('#c43b3b', 0.5, 0.05, -0.05, 0.57, 0.024)
    // a drawing, a photo, a takeout menu, magnets
    at('#fbf7e8', 0.42, 0.34, 0.22, 0.46, 0.02, 0.1)
    at('#e2c93a', 0.14, 0.12, 0.18, 0.49, 0.026)
    at('#3a8a4a', 0.2, 0.06, 0.25, 0.42, 0.026)
    at('#e8e2d2', 0.3, 0.4, -0.25, 0.4, 0.02, -0.06)
    at('#b08a5c', 0.24, 0.3, -0.25, 0.41, 0.024, -0.06)
    at('#f4f0e6', 0.3, 0.55, 0.2, 0.75, 0.02, 0.04)
    for (const [u, v, hex] of [
      [-0.2, 0.83, '#c43b3b'], [0.1, 0.8, '#2a5c9c'], [0.28, 0.6, '#e2c93a'],
      [-0.33, 0.55, '#3a8a4a'], [0.05, 0.33, '#e06a2a'], [0.25, 0.3, '#8a3bb0'],
    ] as const) at(hex, 0.08, 0.08, u, v, 0.04)
    const g = b.build()
    if (!g) return null
    trackDisposable(g)
    return new THREE.Mesh(g, litMat)
  }

  return { lamps: new Float32Array(lamps), lampCount: lamps.length / 4, update, fridgeFront }
}
