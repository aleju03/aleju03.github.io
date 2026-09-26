import * as THREE from 'three'
import { boom } from './impactSounds'
import type { Fx } from './fx'
import type { Impact, ImpactWatch } from '../player/impacts'
import type { PropId, Vec3Like } from './props'
import type { Sandbox } from './sandbox'

/*
  Explosions: `explode(point, power, radius)`, and everything a bang does.

  A blast is a radial impulse, a damage pass and a show. Every prop whose
  collider reaches into the ball is pushed away from the centre with an
  impulse that falls off with distance (`falloff`: full inside a fifth of the
  radius, easing to nothing at its edge) and is thrown upward as well as out,
  because a blast at ground level has nowhere to push but up and a barrel
  that only skids sideways reads as a shove, not a bang. The impulse is
  delivered off-centre, on the side facing the blast, so what flies also
  tumbles. How far a thing goes is its mass's business: the impulse is a
  number of kilogram-units-a-second, so a can is fired over the rooftops, a
  crate is thrown down the street, a fridge rocks and a container shrugs.
  A velocity cap (`MAX_DV`) stops the lightest things from leaving the
  planet.

  Walls shelter. Before pushing a prop the blast casts a ray at it through
  the world's own solids (never the props), and anything behind a building
  corner takes a quarter of it. A prop is not cover, which is Garry's Mod's
  rule too and the reason a barrel inside a crate pile throws the crates.

  Damage is the same falloff in the currency breakables.ts deals in (a
  change of velocity): crates within about half the radius come apart, and
  another explosive inside half its radius goes off after a beat, inside the
  whole of it catches light and goes a couple of seconds later. That is the
  whole chain reaction, and it needs no special case.

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

/** the impulse a power-1 blast gives at its centre, kg*u/s */
export const BLAST_IMPULSE = 1500
/** no blast changes a prop's velocity by more than this, u/s */
const MAX_DV = 55
/** the damage a power-1 blast deals at its centre, in breakables' u/s */
const BLAST_DAMAGE = 70
/** how much of a blast gets round a wall */
const SHELTER = 0.25

/** 1 inside a fifth of the radius, easing to 0 at it */
export const falloff = (d: number, radius: number) => {
  const t = Math.min(1, Math.max(0, (d - radius * 0.2) / (radius * 0.8)))
  return (1 - t) * (1 - t)
}

export const createExplosions = (
  sb: Sandbox,
  fx: Fx,
  damage: (id: PropId, amount: number, from: Vec3Like, blast: boolean) => void,
): Explosions => {
  const fns = new Set<(e: ExplosionEvent) => void>()
  const pos = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const imp = new THREE.Vector3()
  const at = new THREE.Vector3()
  const hitList: Array<{ id: PropId; f: number }> = []

  /** out and up: the offset's direction plus a lift, so a blast at ground
      level throws things into the air rather than along it */
  const push = (id: PropId, mass: number, reach: number, len: number, f: number) => {
    if (len < 1e-3) dir.set(0, 1, 0)
    else dir.multiplyScalar(1 / len)
    dir.y = Math.max(dir.y, 0) + 0.55
    dir.normalize()
    const j = Math.min(BLAST_IMPULSE * powerNow * f, MAX_DV * f * mass)
    imp.copy(dir).multiplyScalar(Math.max(j, 0))
    // off-centre, on the side facing the blast, so it tumbles as it goes
    at.copy(pos).addScaledVector(dir, -reach * 0.6)
    at.x += (Math.random() - 0.5) * reach
    at.z += (Math.random() - 0.5) * reach
    sb.wake(id)
    sb.applyImpulse(id, imp, at)
  }
  let powerNow = 1

  const explode = (c: Vec3Like, power = 1, radius = 16, source: PropId | null = null): ExplosionEvent => {
    const R = Math.max(1, radius)
    powerNow = power
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
        push(h.id, p.mass, reach, len, f)
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
