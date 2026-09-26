import * as THREE from 'three'
import { propMaterial as atlasMaterial } from './art'

/*
  What can be spawned: the kind table.

  A kind is everything the physics needs to know about a prop (its collision
  shape, mass, friction, bounce, how it floats) plus a function that draws it,
  plus the three things that make a prop a *thing* rather than a rigid body:
  what it sounds like when it hits something (`surface`), whether it comes
  apart (`breaks`) and whether it goes off (`explodes`). Adding one is one
  `registerKind()` call; the catalogue (catalogue.ts) registers the forty
  that ship, and destruction and the gibs register their own. Nothing else
  in the sandbox names a kind.

  Units: a unit is about 0.42 m (the eye is 3.84 up), so a one-metre crate is
  2.4 units a side. Mass is kilograms. `density` is relative to water and is
  the whole of the buoyancy model: under 1 floats, and how far under 1 says
  how high (a crate at 0.4 rides with 40% of itself under), over 1 sinks,
  slowed by drag. It is measured against the shape's bounding box, so a
  hollow thing (a bathtub, a drum) is given the density of the box it fills.

  Shapes are Rapier's primitives, chosen for how they roll rather than for
  how they look: a drum is a true cylinder so it rolls straight and rocks on
  its rim, a cone is a cone on a square foot so it topples and then rolls in
  circles about its tip, a chair is a compound of its seat, legs and back so
  it tips over a leg and a melon is a hull of an ellipsoid so it wobbles as
  it rolls. A compound part may carry a weight `w` (its mass share is its
  volume times `w`), which is how a street lamp's cast base holds it upright
  and a hydrant's flange keeps its centre of mass low.

  The meshes are drawn around the same centre the body uses, so the transform
  the physics writes is the transform the mesh wants. All of them share one
  material (`propMaterial`, from art.ts): one shader program for the whole
  catalogue, compiled under the boot cover (see sandbox.ts's warm mesh).
*/

type Part = Exclude<ShapeSpec, { type: 'compound' }>

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
        shape: Part
        at?: [number, number, number]
        /** quaternion xyzw */
        rot?: [number, number, number, number]
        /** mass weight: this part's share is its volume times w (default 1) */
        w?: number
      }>
    }

/** what a prop sounds like: impact sounds are voiced per surface */
export type Surface =
  | 'wood' | 'metal' | 'drum' | 'sheet' | 'plastic' | 'rubber'
  | 'glass' | 'melon' | 'concrete' | 'soft' | 'ceramic'

export interface BreakSpec {
  /** a change of velocity (u/s, its own or dealt it by what hit it) that
      breaks it in one blow. Smaller blows over half this chip away at it */
  speed: number
}

export interface ExplodeSpec {
  /** 1 is the red barrel */
  power: number
  /** units */
  radius: number
  /** a blow that sets it off at once; half this lights it instead */
  speed: number
}

export interface PropKind {
  id: string
  /** a plain English name; the catalogue carries both languages */
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
  /** how it sounds when it hits something; 'wood' when omitted */
  surface?: Surface
  /** comes apart into gibs (models.ts's GIBS) on a hard enough blow */
  breaks?: BreakSpec
  /** goes off on a hard blow, in a blast, or after burning a while */
  explodes?: ExplodeSpec
  /** draw it once, centred on the body's origin; each prop gets a clone that
      shares the geometry and material. Omitted, the prop has no mesh (which
      is what a headless run and a debris piece with its own mesh both want) */
  mesh?: () => THREE.Object3D
}

/** the one material every prop draws with (art.ts's atlas material) */
export const propMaterial = atlasMaterial

/* ------------------------------------------------------------ the table -- */

/** filled by catalogue.ts (and anything else that registers); sandbox.ts
    imports the catalogue, so any sandbox has the full table */
export const KINDS: Record<string, PropKind> = {}

/** add or replace a kind. Returns it, so a module can register and keep it */
export const registerKind = (k: PropKind) => {
  KINDS[k.id] = k
  return k
}

const tmpQ = new THREE.Quaternion()
const tmpV = new THREE.Vector3()

/** the local AABB half extents of a shape, for buoyancy samples, the rescue
    lift and the park test. Compound parts are measured turned */
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
        if (p.rot) {
          // the turned box's extent along each axis: |R| e
          tmpQ.set(p.rot[0], p.rot[1], p.rot[2], p.rot[3])
          const m = new THREE.Matrix4().makeRotationFromQuaternion(tmpQ).elements
          tmpV.set(
            Math.abs(m[0]) * e.x + Math.abs(m[4]) * e.y + Math.abs(m[8]) * e.z,
            Math.abs(m[1]) * e.x + Math.abs(m[5]) * e.y + Math.abs(m[9]) * e.z,
            Math.abs(m[2]) * e.x + Math.abs(m[6]) * e.y + Math.abs(m[10]) * e.z,
          )
          e.copy(tmpV)
        }
        const [ax, ay, az] = p.at ?? [0, 0, 0]
        out.x = Math.max(out.x, Math.abs(ax) + e.x)
        out.y = Math.max(out.y, Math.abs(ay) + e.y)
        out.z = Math.max(out.z, Math.abs(az) + e.z)
      }
      return out
    }
  }
}

/** the lowest point of a shape below its origin, upright: what `restY`
    wants (the extents are symmetric, a chair's legs are not) */
export const shapeBottom = (s: ShapeSpec): number => {
  if (s.type === 'hull') {
    let y = 0
    for (let i = 1; i < s.points.length; i += 3) y = Math.min(y, s.points[i])
    return -y
  }
  if (s.type !== 'compound') return shapeExtents(s).y
  let lo = 0
  const e = new THREE.Vector3()
  for (const p of s.parts) {
    shapeExtents({ type: 'compound', parts: [{ ...p, at: [0, 0, 0] }] }, e)
    const b = p.shape.type === 'hull' ? shapeBottom(p.shape) : e.y
    lo = Math.min(lo, (p.at?.[1] ?? 0) - b)
  }
  return -lo
}
