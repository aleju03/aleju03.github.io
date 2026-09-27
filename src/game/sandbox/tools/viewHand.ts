import * as THREE from 'three'
import { ellipsoid, roundCone, smin, surfaceNets, type Field } from '../../player/isoSurface'

/*
  The first-person mitten: the player's own hand closed round a gun's grip,
  and a stub of forearm leaving the bottom-right of the frame.

  It is drawn the way the body is drawn (`player/bodyShape.ts`), because it
  has to read as *that* body's hand and not as a prop: one signed distance
  field, polygonized once by `isoSurface.ts`, with normals off the field's
  gradient. The field is the body's own mitten vocabulary bent into a grip:
  a soft paddle for the palm wrapped round the handle, the same three short
  fat fingers (joined to each other with a plain minimum, so they stay three
  rolls rather than a slab, and to the palm with a narrow blend) curled
  across the front of the grip under the trigger guard, the thumb laid over
  the left side toward the barrel, and a tapering cone of forearm blended in
  at the wrist. The drawing before this was four icosahedra pushed into each
  other, which read up close as exactly that: a bunch of balls taped
  together. A field has no seams to hide, so the wrist and the thumb's root
  are fillets and nothing else.

  Coordinates are the viewmodel's gun space (origin at the grip, forward -z,
  up +y, model units), and the grip is the one both guns share: 0.08 wide,
  0.26 tall, leaning back at the bottom by 0.28 rad. The forearm is long
  enough to leave the frame at every fov the pause sheet allows, so its far
  end is never seen. Built once per viewmodel, in a few milliseconds, and
  shared by both guns' first-person copies.
*/

/** the grip both guns share: its centre and its long axis (up the handle) */
const GRIP_C = new THREE.Vector3(0, -0.1, 0.06)
const GRIP_UP = new THREE.Vector3(0, Math.cos(0.28), -Math.sin(0.28))
/** across the grip, toward its back (the palm's side) */
const GRIP_BACK = new THREE.Vector3(1, 0, 0).cross(GRIP_UP)
const RIGHT = new THREE.Vector3(1, 0, 0)

/** the hand's size against the grip. The bean's mittens are chunky, and a
    hand drawn to fit the handle snugly all but vanished behind the gun */
const K = 1.3

/** a point in the grip's frame, in hand units: `s` up the handle, `t` to
    the right, `u` back */
const at = (s: number, t: number, u: number) =>
  GRIP_C.clone().addScaledVector(GRIP_UP, s * K).addScaledVector(RIGHT, t * K).addScaledVector(GRIP_BACK, u * K)

/** grid step, model units: about twenty cells across the fist */
const STEP = 0.012

export const buildGripMitten = (): THREE.BufferGeometry => {
  const cone = (a: THREE.Vector3, b: THREE.Vector3, r1: number, r2: number) =>
    roundCone(a.x, a.y, a.z, b.x, b.y, b.z, r1 * K, r2 * K)
  // the palm: a paddle round the handle, set a little back and to the right
  // so the fingers stand proud of it in front and the thumb on the left
  const pc = at(-0.03, 0.012, 0.03)
  const palm = ellipsoid(pc.x, pc.y, pc.z, 0.08 * K, 0.1 * K, 0.085 * K, [
    RIGHT.x, RIGHT.y, RIGHT.z, GRIP_UP.x, GRIP_UP.y, GRIP_UP.z, GRIP_BACK.x, GRIP_BACK.y, GRIP_BACK.z,
  ])
  // three short fat fingers curled across the front, under the guard, each
  // a roll from the right-hand side round to the left, the lower ones a
  // little shorter
  const fingers = [0, 1, 2].map((i) => {
    const s = -0.012 - i * 0.056
    return cone(at(s, 0.05, -0.035), at(s - 0.006, -0.048 + i * 0.006, -0.03), 0.037, 0.034 - i * 0.002)
  })
  const [f0, f1, f2] = fingers
  // the thumb, up the left side from the back of the hand and forward
  // along the gun's flank toward the barrel, where the eye can see it
  const thumb = cone(at(0.03, -0.05, 0.06), at(0.1, -0.07, -0.05), 0.042, 0.036)
  // the forearm: from the heel of the hand, back and down and to the right,
  // out of the frame, swelling a little the way the body's arm cone does
  const w0 = at(-0.085, 0.02, 0.07)
  const dir = new THREE.Vector3(0.62, -0.52, 0.6).normalize()
  const w1 = w0.clone().addScaledVector(dir, 0.75)
  const arm = cone(w0, w1, 0.074, 0.105)
  // nothing of the hand reaches further than this from the palm's centre,
  // so most of the forearm's samples skip its five parts: a lower bound on
  // their distance is all the polygonizer needs out there
  const REACH = 0.2 * K
  const field: Field = (x, y, z) => {
    const a = arm(x, y, z)
    const dc = Math.hypot(x - pc.x, y - pc.y, z - pc.z) - REACH
    if (dc > a + 0.07) return a
    const hand = smin(
      smin(palm(x, y, z), thumb(x, y, z), 0.035),
      Math.min(f0(x, y, z), f1(x, y, z), f2(x, y, z)),
      0.032,
    )
    return smin(hand, a, 0.07)
  }
  const lo: [number, number, number] = [-0.22, Math.min(w1.y - 0.16, -0.36), -0.22]
  const hi: [number, number, number] = [Math.max(w1.x + 0.16, 0.2), 0.14, Math.max(w1.z + 0.16, 0.26)]
  const mesh = surfaceNets(field, lo, hi, STEP)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(mesh.nrm, 3))
  g.setIndex(new THREE.BufferAttribute(mesh.idx, 1))
  g.computeBoundingSphere()
  return g
}
