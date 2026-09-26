import * as THREE from 'three'
import { createMeshBuilder } from '../core/geometry'

/*
  What can be spawned: the kind table.

  A kind is everything the physics needs to know about a prop (its collision
  shape, mass, friction, bounce, how it floats) plus a function that draws it.
  Adding one is one entry in `KINDS`, or one `registerKind()` call from a
  module that owns its own art (the prop catalogue, destruction's debris).
  Nothing else in the sandbox names a kind.

  The six below are placeholders with honest numbers, not art: they exist so
  that stacking, toppling, rolling and floating can be judged before the
  catalogue replaces the models. The numbers are what matter. A unit is about
  0.42 m (the eye is 3.84 up), so the crate is a one-metre wooden crate, the
  barrel a 200-litre drum lying about empty, the heavy block a jersey-barrier
  slab of concrete that a player cannot shove. Mass is kilograms. `density` is
  relative to water and is the whole of the buoyancy model: under 1 floats,
  and how far under 1 says how high (a crate at 0.5 rides with half of
  itself under), over 1 sinks, slowed by drag.

  Shapes are Rapier's primitives, chosen for how they roll rather than for
  how they look: the barrel is a true cylinder so it rolls straight and
  rocks on its rim, the ball a sphere, the cone a cone on a square foot (a
  compound) so it stands, topples and then rolls in circles about its tip the
  way a traffic cone does. The meshes are drawn around the same centre the
  body uses, so the transform the physics writes is the transform the mesh
  wants, with no offset to keep in step.

  Art is vertex-coloured merged geometry through one shared material
  (`propMaterial`), so every placeholder costs one shader program, compiled
  under the boot cover with the rest (see sandbox.ts's warm mesh).
*/

export type ShapeSpec =
  | { type: 'box'; hx: number; hy: number; hz: number }
  | { type: 'ball'; r: number }
  | { type: 'cylinder'; r: number; hh: number }
  | { type: 'cone'; r: number; hh: number }
  /** a convex hull of local points, flat xyz triples */
  | { type: 'hull'; points: number[] }
  | {
      type: 'compound'
      parts: Array<{
        shape: Exclude<ShapeSpec, { type: 'compound' }>
        at?: [number, number, number]
        /** quaternion xyzw */
        rot?: [number, number, number, number]
      }>
    }

export interface PropKind {
  id: string
  /** a plain English name; UI builders translate */
  label: string
  shape: ShapeSpec
  /** kilograms */
  mass: number
  friction: number
  restitution: number
  /** relative to water: under 1 floats, over 1 sinks */
  density: number
  linearDamping?: number
  angularDamping?: number
  /** a share of the mass carried as a point load at a local position (a
      crate's contents resting on its floor). It lowers the centre of mass
      without changing the shape, which is what lets a crate float level at
      half its depth: a uniform cube at that density is only stable resting
      on an edge, and floats like a diamond */
  ballast?: { share: number; at: [number, number, number] }
  /** rolling resistance, as a coefficient (0.01 a steel wheel on rail, 0.04
      a drum on asphalt). Rapier has none: a round thing on a 2% camber
      rolls forever, and a pile of drums and balls was still creeping at
      twenty seconds. Omit it for things that do not roll */
  rolling?: number
  /** draw it once, centred on the body's origin; each prop gets a clone that
      shares the geometry and material. Omitted, the prop has no mesh (which
      is what a headless run and a debris piece with its own mesh both want) */
  mesh?: () => THREE.Object3D
}

/* ------------------------------------------------------------ the look -- */

let material: THREE.MeshStandardMaterial | null = null
/** the one material every placeholder draws with. Colour is per vertex */
export const propMaterial = () => {
  material ??= new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0,
    flatShading: true,
  })
  return material
}

const box = new THREE.BoxGeometry(1, 1, 1)
const cyl = (n: number) => new THREE.CylinderGeometry(1, 1, 1, n, 1)
const cyl12 = cyl(12)
const cyl16 = cyl(16)
const col = (hex: string) => new THREE.Color(hex)
const m4 = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  )

const finish = (b: ReturnType<typeof createMeshBuilder>) => {
  const g = b.build()!
  // the builder bakes wind and surface attributes for the chunk material;
  // this material reads neither, so do not upload them
  g.deleteAttribute('aSway')
  g.deleteAttribute('aSurf')
  g.computeBoundingSphere()
  const mesh = new THREE.Mesh(g, propMaterial())
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** a slatted wooden crate: planked faces between a frame of battens */
const crateMesh = (h: number) => () => {
  const b = createMeshBuilder()
  const wood = col('#a8743e')
  const dark = col('#6b4424')
  const seam = col('#7d5430')
  b.add(box, m4(0, 0, 0, 2 * h - 0.04, 2 * h - 0.04, 2 * h - 0.04), wood)
  // plank seams across every face
  for (let k = -1; k <= 1; k += 2) {
    const s = k * h * 0.34
    for (const [ax, sign] of [[0, 1], [0, -1], [2, 1], [2, -1]] as const) {
      const o = sign * (h - 0.015)
      if (ax === 0) b.add(box, m4(o, s, 0, 0.02, 0.05, 2 * h - 0.3), seam)
      else b.add(box, m4(0, s, o, 2 * h - 0.3, 0.05, 0.02), seam)
    }
    b.add(box, m4(s, h - 0.015, 0, 0.05, 0.02, 2 * h - 0.3), seam)
    b.add(box, m4(s, -h + 0.015, 0, 0.05, 0.02, 2 * h - 0.3), seam)
  }
  // the frame: twelve battens standing a little proud of the planks
  const t = 0.22
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.add(box, m4(x * (h - t / 2 + 0.01), 0, z * (h - t / 2 + 0.01), t, 2 * h, t), dark)
  for (const y of [-1, 1]) {
    for (const x of [-1, 1]) b.add(box, m4(x * (h - t / 2 + 0.01), y * (h - t / 2 + 0.01), 0, t, t, 2 * h - 0.02), dark)
    for (const z of [-1, 1]) b.add(box, m4(0, y * (h - t / 2 + 0.01), z * (h - t / 2 + 0.01), 2 * h - 0.02, t, t), dark)
  }
  // one diagonal brace per side face, the crate's signature
  const d = Math.SQRT2 * (2 * h - 2 * t)
  for (const [x, z, ry] of [[h, 0, Math.PI / 2], [-h, 0, Math.PI / 2], [0, h, 0], [0, -h, 0]] as const) {
    b.add(box, m4(x * 1.004, 0, z * 1.004, d, t * 0.8, 0.05, 0, ry, Math.PI / 4), dark)
  }
  return finish(b)
}

/** an oil drum: painted shell, two rolling hoops, rolled rims, a bung */
const barrelMesh = (r: number, hh: number) => () => {
  const b = createMeshBuilder()
  const paint = col('#9c2a1f')
  const rib = col('#7a1f17')
  const rim = col('#5d5a55')
  const lid = col('#8a2419')
  b.add(cyl16, m4(0, 0, 0, r, 2 * hh - 0.08, r), paint)
  for (const y of [-hh * 0.34, hh * 0.34]) b.add(cyl16, m4(0, y, 0, r + 0.04, 0.12, r + 0.04), rib)
  for (const y of [-hh + 0.05, hh - 0.05]) b.add(cyl16, m4(0, y, 0, r + 0.02, 0.1, r + 0.02), rim)
  b.add(cyl16, m4(0, hh - 0.04, 0, r - 0.06, 0.02, r - 0.06), lid)
  b.add(cyl12, m4(r * 0.5, hh - 0.01, 0, 0.12, 0.05, 0.12), rim)
  // a pale band so a rolling drum visibly rolls
  b.add(box, m4(0, 0, r - 0.005, 0.5, 2 * hh * 0.5, 0.03), col('#e2d6b8'))
  return finish(b)
}

/** a big playground ball, panelled in two colours so its spin reads */
const ballMesh = (r: number) => () => {
  const b = createMeshBuilder()
  const g = new THREE.IcosahedronGeometry(1, 2).toNonIndexed()
  // colour faces by octant so the panels are big and the roll is legible
  const pos = g.getAttribute('position')
  const cA = col('#2f6fd6')
  const cB = col('#f2efe6')
  const one = new THREE.BufferGeometry()
  for (let i = 0; i < pos.count; i += 3) {
    const cx = pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)
    const cy = pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)
    const cz = pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)
    const odd = (cx > 0 ? 1 : 0) ^ (cy > 0 ? 1 : 0) ^ (cz > 0 ? 1 : 0)
    const tri = new Float32Array(9)
    for (let k = 0; k < 3; k++) {
      tri[k * 3] = pos.getX(i + k)
      tri[k * 3 + 1] = pos.getY(i + k)
      tri[k * 3 + 2] = pos.getZ(i + k)
    }
    one.setAttribute('position', new THREE.BufferAttribute(tri, 3))
    one.computeVertexNormals()
    b.add(one, m4(0, 0, 0, r, r, r), odd ? cA : cB)
  }
  return finish(b)
}

/** a sawn plank with its grain drawn as darker strips */
const plankMesh = (hx: number, hy: number, hz: number) => () => {
  const b = createMeshBuilder()
  b.add(box, m4(0, 0, 0, 2 * hx, 2 * hy, 2 * hz), col('#c69a62'))
  for (const z of [-0.45, 0.1, 0.5]) {
    b.add(box, m4(0, hy, z * hz, 2 * hx - 0.1, 0.012, 0.035), col('#a57a47'))
    b.add(box, m4(0, -hy, z * hz, 2 * hx - 0.1, 0.012, 0.035), col('#a57a47'))
  }
  for (const x of [-1, 1]) b.add(box, m4(x * (hx - 0.4), hy + 0.005, 0, 0.1, 0.015, 0.1), col('#555048'))
  return finish(b)
}

/** a traffic cone: orange body, reflective band, black square foot */
const coneMesh = (r: number, hh: number, foot: number, footH: number) => () => {
  const b = createMeshBuilder()
  const orange = col('#f06a1a')
  const white = col('#f4f1e8')
  const cone = new THREE.CylinderGeometry(0, 1, 1, 14, 1)
  const band = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true)
  b.add(cone, m4(0, 0, 0, r, 2 * hh, r), orange)
  // the band sits on the cone's own taper: radius at a height y is r(1/2 - y/2hh)
  const ry = (y: number) => r * (0.5 - y / (2 * hh))
  const y0 = hh * 0.05
  const y1 = hh * 0.4
  b.add(band, m4(0, (y0 + y1) / 2, 0, (ry(y0) + ry(y1)) / 2 + 0.012, y1 - y0, (ry(y0) + ry(y1)) / 2 + 0.012), white)
  b.add(box, m4(0, -hh - footH / 2 + 0.01, 0, 2 * foot, footH, 2 * foot), col('#222222'))
  return finish(b)
}

/** a slab of cast concrete with a chamfered top and two lifting eyes */
const blockMesh = (hx: number, hy: number, hz: number) => () => {
  const b = createMeshBuilder()
  const conc = col('#9a9790')
  const worn = col('#85827b')
  b.add(box, m4(0, -0.05, 0, 2 * hx, 2 * hy - 0.1, 2 * hz), conc)
  b.add(box, m4(0, hy - 0.06, 0, 2 * hx - 0.16, 0.12, 2 * hz - 0.16), worn)
  for (const x of [-1, 1]) {
    b.add(new THREE.TorusGeometry(0.16, 0.05, 6, 10), m4(x * hx * 0.55, hy + 0.1, 0, 1, 1, 1), col('#4a4843'))
  }
  // a stencilled stripe so its orientation reads when it tumbles
  b.add(box, m4(0, 0, hz + 0.005, 2 * hx * 0.8, 0.22, 0.02), col('#d8b62c'))
  b.add(box, m4(0, 0, -hz - 0.005, 2 * hx * 0.8, 0.22, 0.02), col('#d8b62c'))
  return finish(b)
}

/* ------------------------------------------------------------ the table -- */

const CRATE = 1.2
const BARREL_R = 0.72
const BARREL_HH = 1.05
const CONE_R = 0.55
const CONE_HH = 0.8
const CONE_FOOT = 0.6
const CONE_FOOT_H = 0.12

export const KINDS: Record<string, PropKind> = {
  crate: {
    id: 'crate',
    label: 'wooden crate',
    shape: { type: 'box', hx: CRATE, hy: CRATE, hz: CRATE },
    mass: 35,
    // wood on wood is ~0.4; at 0.65 a toppling tower held together like one
    // glued slab and landed as a raft, rather than coming apart as it fell
    friction: 0.42,
    restitution: 0.22,
    // wood crates ride about half under, and level: the load on the floor
    // puts the centre of mass a seventh of the side low, past the twelfth of
    // the side a cube at this draft needs to float flat rather than on an edge
    density: 0.5,
    ballast: { share: 0.35, at: [0, -CRATE * 0.85, 0] },
    mesh: crateMesh(CRATE),
  },
  barrel: {
    id: 'barrel',
    label: 'oil drum',
    shape: { type: 'cylinder', r: BARREL_R, hh: BARREL_HH },
    mass: 28,
    friction: 0.55,
    restitution: 0.18,
    density: 0.3,
    // steel on ground loses a little to rolling resistance; without it a drum
    // on the flat rolls to the horizon
    angularDamping: 0.25,
    rolling: 0.04,
    mesh: barrelMesh(BARREL_R, BARREL_HH),
  },
  ball: {
    id: 'ball',
    label: 'playground ball',
    shape: { type: 'ball', r: 0.62 },
    mass: 1.2,
    friction: 0.8,
    restitution: 0.72,
    density: 0.08,
    linearDamping: 0.08,
    angularDamping: 0.35,
    rolling: 0.05,
    mesh: ballMesh(0.62),
  },
  plank: {
    id: 'plank',
    label: 'plank',
    shape: { type: 'box', hx: 0.34, hy: 0.09, hz: 2.9 },
    mass: 12,
    friction: 0.7,
    restitution: 0.1,
    density: 0.55,
    mesh: plankMesh(0.34, 0.09, 2.9),
  },
  cone: {
    id: 'cone',
    label: 'traffic cone',
    shape: {
      type: 'compound',
      parts: [
        { shape: { type: 'cone', r: CONE_R, hh: CONE_HH } },
        {
          shape: { type: 'box', hx: CONE_FOOT, hy: CONE_FOOT_H / 2, hz: CONE_FOOT },
          at: [0, -CONE_HH - CONE_FOOT_H / 2, 0],
        },
      ],
    },
    mass: 3,
    friction: 0.85,
    restitution: 0.25,
    density: 1.3,
    rolling: 0.08,
    mesh: coneMesh(CONE_R, CONE_HH, CONE_FOOT, CONE_FOOT_H),
  },
  block: {
    id: 'block',
    label: 'concrete block',
    shape: { type: 'box', hx: 1.45, hy: 0.7, hz: 0.7 },
    mass: 900,
    friction: 0.9,
    restitution: 0.02,
    density: 2.4,
    mesh: blockMesh(1.45, 0.7, 0.7),
  },
}

/** add or replace a kind. Returns it, so a module can register and keep it */
export const registerKind = (k: PropKind) => {
  KINDS[k.id] = k
  return k
}

/** the local AABB half extents of a shape, for buoyancy samples, the rescue
    lift and the park test */
export const shapeExtents = (s: ShapeSpec, out = new THREE.Vector3()): THREE.Vector3 => {
  switch (s.type) {
    case 'box':
      return out.set(s.hx, s.hy, s.hz)
    case 'ball':
      return out.set(s.r, s.r, s.r)
    case 'cylinder':
    case 'cone':
      return out.set(s.r, s.hh, s.r)
    case 'hull': {
      let x = 0
      let y = 0
      let z = 0
      for (let i = 0; i < s.points.length; i += 3) {
        x = Math.max(x, Math.abs(s.points[i]))
        y = Math.max(y, Math.abs(s.points[i + 1]))
        z = Math.max(z, Math.abs(s.points[i + 2]))
      }
      return out.set(x, y, z)
    }
    case 'compound': {
      const e = new THREE.Vector3()
      out.set(0, 0, 0)
      for (const p of s.parts) {
        shapeExtents(p.shape, e)
        const [ax, ay, az] = p.at ?? [0, 0, 0]
        out.x = Math.max(out.x, Math.abs(ax) + e.x)
        out.y = Math.max(out.y, Math.abs(ay) + e.y)
        out.z = Math.max(out.z, Math.abs(az) + e.z)
      }
      return out
    }
  }
}
