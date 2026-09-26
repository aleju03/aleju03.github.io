import * as THREE from 'three'
import { boom } from './impactSounds'
import type { Fx } from './fx'
import type { Impact, ImpactWatch } from '../player/impacts'
import type { PropId, Vec3Like } from './props'
import type { Sandbox } from './sandbox'

/*
  Explosions: `explode(point, power, radius)`, and everything a bang does.

  A blast is a throw, a damage pass and a show. Every prop whose collider
  reaches into the ball is thrown away from the centre and well up, tumbling
  end over end, with a speed that falls off with distance (`falloff`: full
  inside a fifth of the radius, easing to nothing at its edge) and with the
  square root of the mass (`blastThrow`): a barrel beside the bang goes about
  seven units up and lands a dozen away, a can goes over the rooftops, a
  fridge hops and a container shrugs. Blasts a beat apart redirect what is
  already flying more than they speed it up, so a chain of them does not
  stack a crate into orbit.

  Walls shelter. Before pushing a prop the blast casts a ray at it through
  the world's own solids (never the props), and anything behind a building
  corner takes a quarter of it. A prop is not cover, which is Garry's Mod's
  rule too and the reason a barrel inside a crate pile throws the crates.

  Damage is the same falloff in the currency breakables.ts deals in (a
  change of velocity), and breakables.ts decides what a blast does with it,
  which is almost never "now": an explosive right beside the bang blows a
  third of a second later, at the top of the arc it was thrown on, and one
  further out catches and sputters and goes wherever it lands; a crate is
  worn down and thrown whole, and it is the landing that may finish it. That
  is the whole chain reaction (several bangs from several places over a
  couple of seconds, with most of the crates left to play with), and it
  needs no special case.

  People are not props (the walker is a kinematic capsule and pedestrians
  are session rigs), so knocking them flat is the subscribers' job: every
  blast fires `onExplosion` with an `ExplosionEvent`, and `blastImpact` /
  `blastWatch` turn one into exactly what `PlayerRig.hit` and the town's
  `knockPeople` seam already take. Destruction subscribes to the same event
  to crack the buildings. The show (flash, fireball, sparks, smoke, dust
  ring, scorch) is fx.ts and the boom is impactSounds.ts; both are no-ops
  headless, and nothing else here touches a renderer.
*/

export interface ExplosionEvent {
  x: number
  y: number
  z: number
  /** 1 is the red barrel */
  power: number
  /** units */
  radius: number
  /** the prop that went off, if one did */
  source: PropId | null
  /** props it pushed */
  pushed: number
}

export interface Explosions {
  /** set one off. Returns what the subscribers were told */
  explode: (at: Vec3Like, power?: number, radius?: number, source?: PropId | null) => ExplosionEvent
  onExplosion: (fn: (e: ExplosionEvent) => void) => () => void
}

/** the throw a power-1 blast gives a `LAUNCH_MASS` prop at its centre, u/s:
    about ten units of height for a barrel beside it, which is well over the
    player's head (Garry's Mod throws barrels higher than the ragdolls), and
    back down within two seconds. Lighter things go faster (by the square root of the
    mass ratio, so a can is not fired into orbit), heavier ones slower */
export const BLAST_DV = 33
const LAUNCH_MASS = 30
/** no blast changes a prop's velocity by more than this, u/s */
const MAX_DV = 46
/** end-over-end spin at the centre of a power-1 blast, rad/s, for a prop
    thrown at the full `BLAST_DV` (scaled with the throw) */
const BLAST_SPIN = 9
/** the damage a power-1 blast deals at its centre, in breakables' u/s */
const BLAST_DAMAGE = 70
/** how much of a blast gets round a wall */
const SHELTER = 0.25

/** 1 inside a fifth of the radius, easing to 0 at it */
export const falloff = (d: number, radius: number) => {
  const t = Math.min(1, Math.max(0, (d - radius * 0.2) / (radius * 0.8)))
  return (1 - t) * (1 - t)
}

/** the speed a blast of falloff `f` throws a prop of `mass` at, u/s */
export const blastThrow = (mass: number, power: number, f: number) =>
  Math.min(MAX_DV, BLAST_DV * Math.sqrt(LAUNCH_MASS / Math.max(0.05, mass))) * Math.min(1.6, power) * f

export const createExplosions = (
  sb: Sandbox,
  fx: Fx,
  damage: (id: PropId, amount: number, from: Vec3Like, blast: boolean) => void,
): Explosions => {
  const fns = new Set<(e: ExplosionEvent) => void>()
  const pos = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const lin = new THREE.Vector3()
  const ang = new THREE.Vector3()
  const axis = new THREE.Vector3()
  const hitList: Array<{ id: PropId; f: number }> = []

  /*
    The throw is a change of velocity rather than an impulse, because what
    reads as a bang is the flight, and the flight wants to be the same
    story at every mass: out, and well up (a blast at ground level has
    nowhere to go but up, and the elevation never drops under about fifty
    degrees, so a barrel beside it is seen in the air over the fireball
    rather than skidding off along the street), with a tumble end over end
    about the axis across the throw, the way a drum cartwheels away in
    Garry's Mod. Spin is set, not left to an off-centre impulse: through a
    compound shape's inertia that was a lottery between a lazy wobble and a
    top.
  */
  const push = (id: PropId, mass: number, len: number, f: number, power: number) => {
    if (len < 1e-3) dir.set(0, 1, 0)
    else dir.multiplyScalar(1 / len)
    const h = Math.hypot(dir.x, dir.z)
    if (h > 1e-3) {
      dir.x /= h
      dir.z /= h
    } else {
      const a = sb.random() * Math.PI * 2
      dir.x = Math.cos(a)
      dir.z = Math.sin(a)
    }
    // elevation between 50 and 70 degrees, a little each way
    const up = 1.2 + Math.max(0, dir.y) + (sb.random() - 0.5) * 0.5
    dir.y = up
    dir.normalize()
    const dv = blastThrow(mass, power, f)
    if (!sb.getVelocity(id, lin, ang)) return
    // blasts a beat apart do not stack into a rocket: what is already
    // flying is redirected more than it is sped up, so the second barrel
    // of a chain throws the crate between them no higher than the first did
    const before = lin.length()
    lin.addScaledVector(dir, dv)
    const cap = Math.max(before, dv) * 1.15
    const now = lin.length()
    if (now > cap) lin.multiplyScalar(cap / now)
    // tumble away from the blast: about the horizontal axis across the
    // throw, plus some wobble so no two drums turn alike
    const spin = Math.min(14, BLAST_SPIN * (dv / BLAST_DV))
    axis.set(dir.z, 0, -dir.x)
    axis.x += (sb.random() - 0.5) * 0.8
    axis.y += (sb.random() - 0.5) * 0.8
    axis.z += (sb.random() - 0.5) * 0.8
    axis.normalize()
    ang.addScaledVector(axis, spin * (0.7 + sb.random() * 0.6))
    sb.wake(id)
    sb.setVelocity(id, lin, ang)
  }

  const explode = (c: Vec3Like, power = 1, radius = 16, source: PropId | null = null): ExplosionEvent => {
    const R = Math.max(1, radius)
    hitList.length = 0
    sb.queryBall(c, R, (p) => {
      if (p.id === source || p.mode === 'frozen') {
        // a frozen prop does not move, but it still burns and breaks
        if (p.id !== source) hitList.push({ id: p.id, f: -1 })
        return
      }
      hitList.push({ id: p.id, f: 0 })
    })
    let pushed = 0
    for (const h of hitList) {
      const p = sb.get(h.id)
      if (!p || !sb.getTransform(h.id, pos)) continue
      dir.set(pos.x - c.x, pos.y - c.y, pos.z - c.z)
      // measured to the near side of the prop, not its middle: a container
      // beside a barrel is hit by the whole bang, not by what reaches its
      // centre three metres further on
      const reach = Math.min(p.extents.x, p.extents.y, p.extents.z)
      const d = Math.max(0, dir.length() - reach)
      let f = falloff(d, R)
      if (f <= 0.001) continue
      const len = dir.length()
      if (len > 0.5) {
        const hit = sb.raycast(c, dir, len, { props: false, world: true })
        if (hit && !hit.ground && hit.distance < len - reach) f *= SHELTER
      }
      // pushed first and damaged after, so a crate the blast breaks hands
      // the blast's velocity on to its pieces
      if (h.f >= 0 && p.mode === 'dynamic') {
        push(h.id, p.mass, len, f, power)
        pushed++
      }
      damage(h.id, BLAST_DAMAGE * power * f, c, true)
    }
    fx.explosion(c, power, R)
    boom(power, c.x, c.y, c.z)
    const e: ExplosionEvent = { x: c.x, y: c.y, z: c.z, power, radius: R, source, pushed }
    for (const fn of fns) fn(e)
    return e
  }

  return {
    explode,
    onExplosion: (fn) => {
      fns.add(fn)
      return () => fns.delete(fn)
    },
  }
}

/* ---------------------------------------------------------- people -- */

/** the velocity a blast gives a body at the whole-body level, u/s at its
    centre, before falloff: enough to throw somebody standing beside a
    barrel a couple of car lengths, tumbling */
const BODY_DV = 26

/**
 * What a blast does to a body standing with its soles at `feet`: fills
 * `out` with the impulse and the point it lands on (exactly what
 * `PlayerRig.hit` takes) and returns false when the body is out of reach.
 */
export const blastImpact = (
  e: ExplosionEvent, feet: THREE.Vector3, height: number, mass: number, out: Impact,
): boolean => {
  const cy = feet.y + height * 0.45
  const dx = feet.x - e.x
  const dy = cy - e.y
  const dz = feet.z - e.z
  const d = Math.hypot(dx, dy, dz)
  const f = falloff(Math.max(0, d - 0.6), e.radius * 0.85)
  if (f < 0.04) return false
  const h = Math.hypot(dx, dz)
  // mostly outward, always up: a blast at your feet throws you in the air
  const ox = h > 1e-3 ? dx / h : 0
  const oz = h > 1e-3 ? dz / h : 0
  const up = 0.55 + 0.35 * f
  const k = BODY_DV * Math.min(1.6, e.power) * f * mass
  out.impulse.set(ox * k, up * k, oz * k)
  // on the near side, low: the legs go out from under
  out.point.set(feet.x - ox * 0.3, feet.y + height * 0.3, feet.z - oz * 0.3)
  return true
}

/**
 * A blast as an `ImpactWatch`, the shape the town's `knockPeople(watch)`
 * already takes for cars: every pedestrian in reach is struck once.
 */
export const blastWatch = (e: ExplosionEvent): ImpactWatch => ({
  track: () => {},
  strike: (_key, feet, height, mass, out) => blastImpact(e, feet, height, mass, out),
})
