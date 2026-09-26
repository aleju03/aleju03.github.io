import * as THREE from 'three'
import type { Solid } from '../physics/collision'
import { rearmRuins, type Opened, type Ruins, type Standing } from '../world/debris'
import {
  breakDecor, chipFrags, cornerPoints, fractureStructure, fragsToGeometry, hullPoints, massOf, shatterFrags,
  unsupported, type Frag, type Piece, type StructureRec,
} from '../world/fracture'
import { gfx } from '../world/quality'
import { msg, registerCommand, type CommandCtx } from './commands'
import { falloff } from './explosion'
import { historyOf, type HistoryEntry } from './history'
import { rumble } from './impactSounds'
import { registerKind, type ShapeSpec } from './kinds'
import type { ImpactEvent, Prop, PropId, Sandbox, Vec3Like } from './sandbox'

/*
  Destruction: buildings that come apart into rubble you can keep playing
  with. The geometry half is world/fracture.ts (a building rebuilt as pieces,
  and the support graph over them) and the bookkeeping half is world/debris.ts's
  ruins (which pieces are gone, by a position-stable id, and the span-lifting
  that takes a piece out of the merged soup). This module is the physics and
  the show: what breaks, what falls, when, and what it does when it lands.

  Damage arrives four ways and is dealt the same way: a blast (`onExplosion`),
  a prop or a piece of rubble hitting a wall hard (`onImpact` against a solid
  the ruins own), a car driving through (the ruins' `onHit`, which the car's
  breakable-solid path calls), and the console (`damage`, `collapse`). Every
  piece has a health against its building's grade (render and timber, brick,
  a framed tower); a blow that takes it to nothing lifts it out and throws it.

  Then the building is asked whether it still stands, two ways:

  - **A storey fails** when the walls left in it carry less than a share of
    what they did (`FAIL`). Everything above it lets go at once as one rigid
    *cluster*, resting on whatever walls of that storey are left, and those
    are crushed one after another, nearest the damage first, over up to a
    couple of seconds (`HOLD`). So a charge at one corner takes that corner's
    support first and the building leans into the hole and topples over the
    far walls like a felled tree; charges all round drop it straight down.
  - **Anything else not held up** (fracture.ts's `unsupported`: resting on
    nothing, or hanging off more bays than its kind can span) drops as the
    connected lumps it is in, lowest first, a beat apart.

  A falling lump breaks when it lands. Clusters split into storeys, storeys
  into their four walls and a floor, walls into panels, and panels into
  Voronoi shards with capped, coloured break faces (fracture.ts's
  `shatterFrags`), each level on its own impact, so a tower that hits the
  street breaks up storey by storey as it goes down rather than bursting
  into gravel on the first frame. Rubble that hits what is still standing
  damages it, which is how a collapse walks down a building and why a toppled
  tower takes the corner shop with it.

  Every lump is a real prop (a kind registered here, a hull collider, the
  chunk's own material, so no new program is ever linked), which is what the
  physgun, undo and the network already speak. The budget is the tier's
  `gfx.rubble` of lumps *awake*: past it the oldest settled ones are damped
  and put to sleep (a sleeping hull costs the solver nothing, and stays
  rubble the physgun can pick up), breaking up stops at the coarser level,
  and past four times it the oldest small ones go in a puff of dust. Rubble
  that crawls is put to sleep, and a piece the heap presses into the street
  is put back on it and pinned (a heightfield has no thickness).
  Small shards shrink away after `SHARD_LIFE`, like gibs; anything big stays,
  which is what makes the ruin somewhere you can walk into.

  What a destruction *is* stays plain data for the shared world: a building
  id, a point, a power, a radius, a direction and a seed per event (`log`),
  and the set of piece keys each building has lost (the ruins' `ruined`). The
  wire is not built; the record it would carry is.
*/

/* ------------------------------------------------------------ the kinds -- */

registerKind({
  id: 'rubble',
  label: 'rubble',
  shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 },
  mass: 200,
  friction: 0.95,
  restitution: 0.03,
  density: 2.3,
  linearDamping: 0.12,
  angularDamping: 0.6,
  surface: 'concrete',
})
registerKind({
  id: 'rubble_wood',
  label: 'timber rubble',
  shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 },
  mass: 90,
  friction: 0.9,
  restitution: 0.05,
  density: 1.4,
  linearDamping: 0.12,
  angularDamping: 0.6,
  surface: 'wood',
})

/* ------------------------------------------------------------ the knobs -- */

/** damage (explosion.ts's units: 70 at the heart of a barrel) that takes a
    piece of each grade to nothing */
const RESIST = [20, 38, 62]
/** a storey fails when its walls carry less than this share of what they did */
const FAIL = [0.66, 0.6, 0.55]
/** how far each grade may bridge a hole (a share of fracture.ts's REACH):
    render and timber bridges nothing (a wall over a hole comes down with
    it, a roof hangs one bay at most), a framed tower spans two */
const SPAN = [0.34, 1, 1]
/** seconds over which the last walls of a failing storey give, nearest the
    damage first: the hinge a felled building turns on */
const HOLD = [0.7, 1.3, 2.1]
/** kilograms per cubic unit of material (a unit is 0.42 m): render and
    timber, brick, concrete */
const DENSITY = [70, 150, 170]
/** the change of velocity that breaks a lump of each level when it lands:
    cluster, storey, side, piece; a shard never breaks again. A cluster is
    the whole building over a failed storey, and it is tough on purpose: it
    must survive its own corner hitting the street while it leans, or a
    felled tower pancakes where it stood instead of going over */
const BREAK_DV = [13, 7, 8, 11]
/** a piece smaller than this is not shattered further (cubic units) */
const SHATTER_MIN = 2.2
/** seconds a small shard lies about before it shrinks away */
const SHARD_LIFE = 14
const SHARD_VOL = 0.9
/** how much a slice may do of the three expensive things: taking a
    building apart (triangles of fracture work, about 3 ms), making rubble
    bodies and breaking landed lumps. Counted in work rather than time so a
    destruction comes out the same on every machine */
const OPEN_SLICE_WORK = 900
const SPAWNS_PER_SLICE = 12
const BREAKS_PER_SLICE = 6
/** a prop's impulse (kg*u/s) per unit of damage against a wall */
const IMPULSE_PER_DAMAGE = 380

/* ------------------------------------------------------------ the record -- */

/** one thing that happened to a building, as plain data: what a peer would
    need to replay it (the pieces it lifts follow from it deterministically) */
export interface DamageRecord {
  seq: number
  building: string
  how: 'blast' | 'impact' | 'vehicle' | 'command' | 'collapse'
  x: number
  y: number
  z: number
  /** damage at the centre, explosion.ts's units */
  power: number
  radius: number
  /** which way it was travelling (vehicles, props), unit, or zero */
  dx: number
  dy: number
  dz: number
  seed: number
  /** simulation time */
  t: number
}

export interface Destruction {
  /** damage every building within `radius` of a point; returns pieces broken */
  damageAt: (at: Vec3Like, power: number, radius: number, how?: DamageRecord['how'], dir?: Vec3Like) => number
  /** bring a building down from its ground storey. `from` is where the
      failure starts (it leans that way); omitted, it drops straight down */
  collapse: (s: Standing, from?: Vec3Like) => boolean
  /** the building nearest a point, within `r` */
  nearest: (at: Vec3Like, r: number) => Standing | null
  /** everything that has happened, oldest first */
  readonly log: readonly DamageRecord[]
  readonly stats: {
    lumps: number
    awake: number
    frozen: number
    buildings: number
    /** the most one slice has spent taking a building apart, ms, and the
        last slice's own work */
    openMs: number
    sliceMs: number
    /** rubble the sandbox took away itself (fell out of the world, undo) */
    lost: number
    /** the furthest any whole cluster has leaned from upright, degrees */
    lean: number
  }
  readonly ruins: Ruins
  dispose: () => void
}

/* ------------------------------------------------------------ internals -- */

interface Wreck {
  s: Standing
  o: Opened
  pieces: Piece[]
  hp: Float32Array
  /** wall volume per storey bin when it was opened */
  cap0: Float32Array
  failed: Uint8Array
  grade: number
  kindId: string
  dens: number
}

/** 0 cluster, 1 storey, 2 side, 3 piece, 4 shard */
type Level = 0 | 1 | 2 | 3 | 4

interface Lump {
  id: PropId
  w: Wreck
  level: Level
  /** piece indices (levels 0-3) */
  pieces: number[]
  /** a shard's own fragments */
  frags: Frag[] | null
  /** the rest-frame point the body's origin stands for */
  rc: THREE.Vector3
  vol: number
  born: number
  ev: Ev
  /** shrinking away: seconds into it, or -1 */
  going: number
  /** one of the great sections a tall building shears into as it falls:
      it breaks up when it lands rather than crushing down storey by storey */
  section?: boolean
  /** consecutive checks it has been crawling; see the settle pass */
  slow: number
  /** given the late-heap damping (see the settle pass) */
  damped?: boolean
  mesh: THREE.Object3D | null
}

/** an event's undo bookkeeping */
interface Ev {
  rec: DamageRecord
  w: Wreck[]
  /** pieces it lifted, per wreck */
  lifted: Map<Wreck, number[]>
  entry: HistoryEntry | null
  live: Set<PropId>
  dead: boolean
}

interface Job {
  t: number
  /** the event it belongs to (an undone event's jobs are dropped) */
  ev: Ev | null
  fn: () => void
}

const tmpV = new THREE.Vector3()

/** a hull needs thickness in all three axes or Rapier gives up on it (and
    no more than that: padded any fatter, siblings are born overlapping and
    fire each other across the street) */
const thicken = (pts: number[], min = 0.15) => {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < pts.length; i += 3) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i])
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1])
    z0 = Math.min(z0, pts[i + 2]); z1 = Math.max(z1, pts[i + 2])
  }
  const n = pts.length
  const pad = (axis: number, lo: number, hi: number) => {
    if (hi - lo >= min) return
    const d = (min - (hi - lo)) / 2
    for (let i = 0; i < n; i += 3) {
      const p = [pts[i], pts[i + 1], pts[i + 2]]
      p[axis] = lo - d
      pts.push(p[0], p[1], p[2])
      p[axis] = hi + d
      pts.push(p[0], p[1], p[2])
    }
  }
  pad(0, x0, x1)
  pad(1, y0, y1)
  pad(2, z0, z1)
  return pts
}

/** keep a hull's point count in reason: every fourth point past a few hundred */
const thin = (pts: number[], max = 360) => {
  const n = pts.length / 3
  if (n <= max) return pts
  const step = Math.ceil(n / max)
  const out: number[] = []
  for (let i = 0; i < n; i += step) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])
  return out
}

/** the mean colour of a piece's outside, for its dust and its bits */
const tintOf = (pieces: Piece[], out: [number, number, number]) => {
  let r = 0, g = 0, b = 0, n = 0
  for (const pc of pieces) {
    for (const f of pc.frags) {
      if (f.glass) continue
      for (let i = 0; i < f.c.length; i += 27) {
        r += f.c[i]; g += f.c[i + 1]; b += f.c[i + 2]; n++
      }
    }
  }
  if (!n) return out
  out[0] = r / n
  out[1] = g / n
  out[2] = b / n
  return out
}

/** a wall that carries something: a shop's shelving is a wall to the
    fracture and holds up nothing, and must not count toward the storey */
const bears = (pc: Piece) => pc.kind === 'wall' && pc.over.length > 0

/* ------------------------------------------------------------ the thing -- */

const attached = new WeakMap<Sandbox, Destruction>()

/** the destruction attached to a sandbox, if any (the console, scenarios) */
export const destructionOf = (sb: Sandbox) => attached.get(sb) ?? null

export const attachDestruction = (sb: Sandbox, ruins: Ruins): Destruction => {
  const had = attached.get(sb)
  if (had) return had

  // everything the simulation chooses is drawn from the sandbox's own seeded
  // stream, so a scenario comes out the same twice, a replay draws the same
  // numbers and the state hash stays honest. The shards' cuts are seeded
  // from the event and the piece (fracture.ts's shatterFrags)
  const rnd = sb.random
  const wrecks = new Map<string, Wreck>()
  const lumps = new Map<PropId, Lump>()
  const jobs: Job[] = []
  const log: DamageRecord[] = []
  let now = 0
  let seq = 1
  const stats = { lumps: 0, awake: 0, frozen: 0, buildings: 0, openMs: 0, sliceMs: 0, lost: 0, lean: 0 }
  const breakQueue: Array<{ L: Lump; e: ImpactEvent; at?: number }> = []
  const nearList: Standing[] = []
  const tint: [number, number, number] = [0.5, 0.48, 0.44]

  /* -------------------------------------------------------- wrecks -- */

  const wreckOf = (s: Standing): Wreck | null => {
    const have = wrecks.get(s.rec.id)
    if (have && have.s === s) return have
    const t0 = performance.now()
    const o = ruins.open(s)
    stats.openMs = Math.max(stats.openMs, performance.now() - t0)
    if (!o) return null
    const pieces = o.frac.pieces
    const cap0 = new Float32Array(o.frac.ny)
    for (const pc of pieces) if (bears(pc)) cap0[pc.iy] += pc.vol
    const grade = Math.max(0, Math.min(2, s.rec.grade))
    const w: Wreck = {
      s, o, pieces,
      hp: new Float32Array(pieces.length).fill(1),
      cap0,
      failed: new Uint8Array(o.frac.ny),
      grade,
      kindId: grade === 0 ? 'rubble_wood' : 'rubble',
      dens: DENSITY[grade],
    }
    // a piece already gone (a chunk re-armed a ruin) starts gone
    for (let i = 0; i < pieces.length; i++) if (!o.alive[i]) w.hp[i] = 0
    wrecks.set(s.rec.id, w)
    stats.buildings = wrecks.size
    return w
  }

  const wallVol = (w: Wreck, iy: number) => {
    let v = 0
    const a = w.o.alive
    for (let i = 0; i < w.pieces.length; i++) {
      const pc = w.pieces[i]
      if (a[i] && pc.iy === iy && bears(pc)) v += pc.vol
    }
    return v
  }

  /* --------------------------------------------------------- events -- */

  const newEvent = (rec: Omit<DamageRecord, 'seq' | 't'>): Ev => {
    const r: DamageRecord = { ...rec, seq: seq++, t: now }
    log.push(r)
    if (log.length > 400) log.shift()
    return { rec: r, w: [], lifted: new Map(), entry: null, live: new Set(), dead: false }
  }

  const history = () => historyOf(sb)

  const undoEvent = (ev: Ev) => {
    ev.dead = true
    for (const [w, list] of ev.lifted) {
      if (!ruins.get(w.s.rec.id)) continue
      ruins.restore(w.o, list)
      for (const i of list) w.hp[i] = 1
      // a storey that had failed stands again if its walls do
      for (let iy = 0; iy < w.failed.length; iy++) {
        if (w.failed[iy] && wallVol(w, iy) >= w.cap0[iy] * FAIL[w.grade]) w.failed[iy] = 0
      }
    }
    sb.solidsChanged()
  }

  /** a lump joins its event's undo entry */
  const own = (ev: Ev, id: PropId) => {
    ev.live.add(id)
    const h = history()
    if (!ev.entry) {
      const label = ev.rec.how === 'collapse' || ev.rec.how === 'command'
        ? { en: 'demolition', es: 'demolición' } : { en: 'rubble', es: 'escombros' }
      ev.entry = h.record({ label, props: id, undo: () => undoEvent(ev) })
      return
    }
    h.attach(ev.entry, [id])
  }

  const noteLift = (ev: Ev, w: Wreck, list: number[]) => {
    let l = ev.lifted.get(w)
    if (!l) ev.lifted.set(w, (l = []))
    l.push(...list)
    if (!ev.entry) {
      // an event that throws nothing still has something to undo
      ev.entry = history().record({
        label: { en: 'demolition', es: 'demolición' }, undo: () => undoEvent(ev),
      })
    }
  }

  const later = (dt: number, ev: Ev, fn: () => void) => {
    jobs.push({ t: now + dt, ev, fn })
  }

  /* ---------------------------------------------------------- lumps -- */

  const levelOf = (w: Wreck, list: number[]): Level => {
    if (list.length === 1) return 3
    let iy = -1
    let face = -1
    let multiY = false
    let multiF = false
    for (const i of list) {
      const pc = w.pieces[i]
      if (iy < 0) iy = pc.iy
      else if (pc.iy !== iy) multiY = true
      const f = pc.key % 6
      if (face < 0) face = f
      else if (f !== face) multiF = true
    }
    return multiY ? 0 : multiF ? 1 : 2
  }

  const meshFor = (w: Wreck, frags: Frag[], rc: THREE.Vector3) => {
    const like = w.o.mesh
    if (!like || !sb.root.parent) return null
    const geo = fragsToGeometry(frags)
    const m = new THREE.Mesh(geo, like.material)
    m.castShadow = like.castShadow
    m.receiveShadow = like.receiveShadow
    if (like.customDepthMaterial) m.customDepthMaterial = like.customDepthMaterial
    // the geometry stays in rest-world coordinates (so the surface pass keeps
    // brick on brick as it tumbles) and is moved onto the body's origin here
    m.position.set(-rc.x, -rc.y, -rc.z)
    const g = new THREE.Group()
    g.add(m)
    g.userData.dispose = () => geo.dispose()
    return g
  }

  interface Pose {
    pos: THREE.Vector3
    quat: THREE.Quaternion
    rc: THREE.Vector3
    vel: THREE.Vector3
    ang: THREE.Vector3
  }

  /** where a part of something moving is, and how fast that point moves */
  const poseOf = (parent: Pose | null, rc: THREE.Vector3) => {
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const vel = new THREE.Vector3()
    const av = new THREE.Vector3()
    if (!parent) {
      pos.copy(rc)
      return { pos, quat, vel, ang: av }
    }
    pos.copy(rc).sub(parent.rc).applyQuaternion(parent.quat).add(parent.pos)
    quat.copy(parent.quat)
    // v + w x r, r from the parent's origin to this part's
    tmpV.subVectors(pos, parent.pos)
    vel.copy(parent.ang).cross(tmpV).add(parent.vel)
    av.copy(parent.ang)
    return { pos, quat, vel, ang: av }
  }

  const spawnLump = (
    w: Wreck, ev: Ev, level: Level, list: number[], frags: Frag[] | null,
    parent: Pose | null, push: THREE.Vector3 | null, spin: number, _parentId?: PropId,
    /** born this far from where it stood (a piece a ram is already inside) */
    ahead?: THREE.Vector3 | null,
    /** drawn but not collided with: rebar and splinters out of the break */
    decor?: Frag[],
  ): PropId | null => {
    const pieceObjs = list.map((i) => w.pieces[i])
    const all: Frag[] = frags ?? pieceObjs.flatMap((pc) => pc.frags)
    const m = massOf(all)
    if (m.box.isEmpty()) return null
    const rc = m.center
    let points: number[]
    // a cluster or a storey is hulled off its pieces' boxes (cheap, and the
    // hull of a storey is its box anyway); a side of one is hulled off its
    // real surface, because two sides' boxes overlap at every corner and
    // siblings born overlapping are fired apart
    if (level <= 1) points = cornerPoints(pieceObjs, rc)
    // not decimated below a few thousand points: a parent hulled off a
    // sample of its points is smaller than it looks, rubble settles into the
    // difference, and the children it breaks into (hulled off all of theirs)
    // are born inside that rubble and fire it across the street
    else points = thin(hullPoints(all, rc), 3000)
    thicken(points)
    const shape: ShapeSpec = { type: 'hull', points }
    // capped both ways: a sixty-tonne storey resting on a hundred-kilo shard
    // is a mass ratio the solver cannot hold. It presses the shard straight
    // through the heightfield it is lying on (a tower lost forty pieces
    // through the street that way) or, pinched against it, fires it off at
    // hundreds of units a second; under about twenty to one it does neither. Weight still reads as weight:
    // everything falls at the same speed, and the damage a lump deals is
    // capped well under what either number would give
    const mass = Math.min(2500, Math.max(150, m.vol * w.dens))
    const p = poseOf(parent, rc)
    if (ahead) p.pos.add(ahead)
    if (!parent) {
      // a ground-floor piece reaches below the drawn ground (a building's
      // footing is sunk into its lot), and a body born under a heightfield
      // falls out of the world: lift it clear
      const g = sb.groundY(p.pos.x, p.pos.z)
      const foot = p.pos.y - (rc.y - m.box.min.y)
      if (foot < g + 0.05) p.pos.y += g + 0.05 - foot
    }
    if (push) p.vel.add(push)
    if (spin) {
      p.ang.x += (rnd() - 0.5) * spin
      p.ang.y += (rnd() - 0.5) * spin * 0.5
      p.ang.z += (rnd() - 0.5) * spin
    }
    const drawn = all.filter((f) => !f.glass)
    const mesh = meshFor(w, decor?.length ? drawn.concat(decor) : drawn, rc)
    const id = sb.spawn(w.kindId, p.pos, {
      quaternion: p.quat, velocity: p.vel, angular: p.ang, shape, mass, mesh,
      data: { rubble: true, building: w.s.rec.id, level },
    })
    made++
    const L: Lump = {
      id, w, level, pieces: list, frags, rc: rc.clone(), vol: m.vol, born: now, ev, going: -1, mesh, slow: 0,
    }
    lumps.set(id, L)
    own(ev, id)
    return id
  }

  const poseOfLump = (L: Lump): Pose | null => {
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    if (!sb.getTransform(L.id, pos, quat)) return null
    const vel = new THREE.Vector3()
    const av = new THREE.Vector3()
    sb.getVelocity(L.id, vel, av)
    return { pos, quat, rc: L.rc, vel, ang: av }
  }

  /** the connected components of a set of pieces, over the support graph */
  const components = (w: Wreck, list: number[]) => {
    const inSet = new Set(list)
    const seen = new Set<number>()
    const out: number[][] = []
    for (const i of list) {
      if (seen.has(i)) continue
      const comp: number[] = []
      const stack = [i]
      seen.add(i)
      while (stack.length) {
        const j = stack.pop() as number
        comp.push(j)
        const pc = w.pieces[j]
        for (const k of pc.under) if (inSet.has(k) && !seen.has(k)) { seen.add(k); stack.push(k) }
        for (const k of pc.over) if (inSet.has(k) && !seen.has(k)) { seen.add(k); stack.push(k) }
        for (const k of pc.side) if (inSet.has(k) && !seen.has(k)) { seen.add(k); stack.push(k) }
      }
      out.push(comp)
    }
    return out
  }

  const budget = () => Math.max(40, gfx.rubble)
  const frozenCount = () => {
    let n = 0
    for (const L of lumps.values()) if (sb.get(L.id)?.mode === 'frozen') n++
    return n
  }

  /** make room for `n` more moving lumps: weld the oldest settled ones where
      they lie, and past the hard cap let the oldest go in a puff */
  const makeRoom = (n: number) => {
    const cap = budget()
    if (lumps.size + n <= cap) return true
    // what costs the solver is what is awake: a heap of a thousand sleeping
    // hulls is free. So nothing is welded to the world any more (the physgun
    // could not pick up what the budget had frozen); the oldest settled ones
    // are simply damped and put to sleep, and they stay rubble you can kick
    let moving = 0
    for (const L of lumps.values()) {
      const p = sb.get(L.id)
      if (p && p.mode === 'dynamic' && !p.body.isSleeping()) moving++
    }
    if (moving + n <= cap) return true
    for (const L of lumps.values()) {
      if (moving + n <= cap * 0.85) break
      const p = sb.get(L.id)
      if (!p || p.mode !== 'dynamic' || p.body.isSleeping() || now - L.born < 1.5) continue
      if (!sb.getVelocity(L.id, vIn) || vIn.lengthSq() > 4) continue
      rest(p.body)
      moving--
    }
    let staying = 0
    for (const L of lumps.values()) if (L.going < 0) staying++
    if (staying + n > cap * 4) {
      // oldest first (the map keeps spawn order), and never the big ones
      for (const L of lumps.values()) {
        if (staying + n <= cap * 3.5) break
        if (L.going >= 0 || L.vol > 40) continue
        L.going = 0
        staying--
      }
    }
    return moving + n <= cap * 1.15
  }

  /** damped hard and put to sleep: a neighbour still creeping wakes it, and a
      heavily damped body stops again at once, which is what lets a whole
      heap's island go quiet */
  const rest = (body: Prop['body']) => {
    body.setLinearDamping(2)
    body.setAngularDamping(3)
    body.sleep()
  }

  /** a piece or a shard of it leaves the building */
  /** a piece as it leaves: corners knocked off and, out of the break,
      rebar or splinters */
  const brokenPiece = (w: Wreck, i: number, seed: number) => {
    const pc = w.pieces[i]
    const frags = chipFrags(pc.frags, seed, pc.vol > 6 ? 3 : 2)
    const decor = breakDecor(frags, seed ^ 0x9e37, w.grade, pc.vol > 6 ? 3 : 2)
    return { frags, decor }
  }

  /** bodies waiting to be made: a blast lifts every piece it breaks at once
      (they vanish from the building on the frame it goes off), but making
      forty hulls is spread over the next few slices, under the fireball */
  const spawns: Array<() => void> = []

  const throwPieces = (
    w: Wreck, ev: Ev, list: number[], vel: THREE.Vector3, energy: number, ahead: THREE.Vector3 | null = null,
    /** the height a ram struck at: what was over it drops out in front
        instead of going with it */
    ramY?: number,
  ) => {
    const off = ahead ? ahead.clone() : null
    for (const i of list) {
      const pc = w.pieces[i]
      const big = pc.vol >= SHATTER_MIN * (ramY !== undefined ? 0.5 : 1) && energy > 1.4 && makeRoom(3)
      tintOf([pc], tint)
      const seed = (pc.key * 2654435761 + ev.rec.seed) >>> 0
      // every choice is drawn now, in order, so the stream stays the same
      // however the making is spread across slices
      const kicks: THREE.Vector3[] = []
      const n = big ? (ramY !== undefined ? (pc.vol > 6 ? 6 : 5) : pc.vol > 8 ? 4 : 3) : 1
      for (let k = 0; k < n; k++) {
        kicks.push(big
          ? new THREE.Vector3(vel.x + (rnd() - 0.5) * 4, vel.y + rnd() * 3, vel.z + (rnd() - 0.5) * 4)
          : new THREE.Vector3(vel.x + (rnd() - 0.5) * 2, vel.y + rnd() * 1.5, vel.z + (rnd() - 0.5) * 2))
      }
      const deco = rnd()
      spawns.push(() => {
        if (big) {
          const shards = shatterFrags(pc.frags, seed, n)
          shards.forEach((sh, k) => {
            const decor = deco < 0.6 ? breakDecor(sh, seed + k * 7919, w.grade, 1 + (k & 1)) : undefined
            let kick = kicks[k % kicks.length]
            let born = off
            if (ramY !== undefined) {
              // over the ram: it drops out onto the pavement in front
              const top = massOf(sh).box
              if ((top.min.y + top.max.y) / 2 > ramY + 1.4) {
                kick = kick.clone().multiplyScalar(-0.12)
                kick.y = 1 + rnd() * 2
                born = null
              }
            }
            spawnLump(w, ev, 4, [i], sh, null, kick, 3, undefined, born, decor)
          })
        } else {
          const bp = brokenPiece(w, i, seed)
          spawnLump(w, ev, 3, [i], bp.frags, null, kicks[0], energy > 1 ? 2 : 0.6, undefined, off, bp.decor)
        }
      })
      if (pc.g) sb.fx.debris('glass', pc.center, vel, Math.min(3, (pc.max.x - pc.min.x + pc.max.z - pc.min.z) / 3))
      sb.fx.rubble(pc.center, vel, Math.min(4, Math.cbrt(pc.vol) * 1.4), tint[0], tint[1], tint[2])
    }
    // a ram's pieces are made at once: it is moving through where they go
    if (ahead) flushSpawns(Infinity)
  }

  /** make queued bodies until about `n` have been made this slice (a thunk
      is one piece, which may be six shards) */
  const flushSpawns = (n: number) => {
    const until = made + n
    while (spawns.length && made < until) spawns.shift()!()
  }
  let made = 0

  /* ------------------------------------------------------ structure -- */

  /** the building has changed: does it still stand? */
  const settle = (w: Wreck, ev: Ev, from: THREE.Vector3) => {
    const a = w.o.alive
    // a storey that has lost too much of its walls takes everything over it
    for (let iy = 0; iy < w.failed.length; iy++) {
      if (w.failed[iy] || w.cap0[iy] <= 0) continue
      if (wallVol(w, iy) >= w.cap0[iy] * FAIL[w.grade]) continue
      failStorey(w, ev, iy, from)
      break
    }
    // ...and whatever is left hanging drops, lowest first
    const loose = unsupported(w.pieces, (i) => a[i] === 1, SPAN[w.grade])
    if (!loose.length) return
    ruins.lift(w.o, loose)
    noteLift(ev, w, loose)
    const comps = components(w, loose)
    comps.sort((x, y) => w.pieces[x[0]].min.y - w.pieces[y[0]].min.y)
    comps.forEach((comp, k) => {
      const lv = levelOf(w, comp)
      spawnLump(w, ev, lv, comp, null, null, null, lv >= 3 ? 0.4 : 0)
      if (k === 0) {
        const pc = w.pieces[comp[0]]
        tintOf([pc], tint)
        sb.fx.plume(pc.center, Math.min(8, pc.max.x - pc.min.x + 2), tint[0] * 1.1, tint[1] * 1.08, tint[2] * 1.05)
      }
    })
  }

  const failStorey = (w: Wreck, ev: Ev, iy: number, from: THREE.Vector3) => {
    for (let k = iy; k < w.failed.length; k++) w.failed[k] = 1
    const a = w.o.alive
    const above: number[] = []
    const rest: number[] = []
    for (let i = 0; i < w.pieces.length; i++) {
      if (!a[i]) continue
      const pc = w.pieces[i]
      if (pc.iy > iy) above.push(i)
      else if (pc.iy === iy && pc.kind !== 'floor') rest.push(i)
    }
    const frac = w.o.frac
    const cx = (frac.min.x + frac.max.x) / 2
    const cz = (frac.min.z + frac.max.z) / 2
    const width = Math.max(frac.max.x - frac.min.x, frac.max.z - frac.min.z)
    // which way it goes is where the storey's missing walls are, not where
    // the last blow happened to land: a row of charges along one face fails
    // the storey on whichever charge tips it, and that one may be at a corner
    let hx = 0
    let hz = 0
    let hv = 0
    for (let i = 0; i < w.pieces.length; i++) {
      const pc = w.pieces[i]
      if (a[i] || pc.iy !== iy || !bears(pc)) continue
      hx += pc.center.x * pc.vol
      hz += pc.center.z * pc.vol
      hv += pc.vol
    }
    if (hv > 0 && ev.rec.how !== 'collapse') from = new THREE.Vector3(hx / hv, from.y, hz / hv)
    const dx = from.x - cx
    const dz = from.z - cz
    const off = Math.hypot(dx, dz)
    const lean = off > width * 0.12
    // the load comes off as rigid clusters, resting on what is left below.
    // A failure on one side has already let that side sag by the time the
    // rest of the storey knows about it, so the cluster is born turning into
    // the hole (the top moving toward the damage, about the far walls): a
    // felled building goes over rather than sitting down on its own rubble
    const tall = lean && frac.max.y - frac.min.y > 24
    if (above.length) {
      ruins.lift(w.o, above)
      noteLift(ev, w, above)
      if (tall) sections(w, ev, above, iy, dx / off, dz / off)
      else {
        const tip = lean ? new THREE.Vector3(dz / off, 0, -dx / off).multiplyScalar(0.35) : null
        for (const comp of components(w, above)) {
          const id = spawnLump(w, ev, levelOf(w, comp), comp, null, null, null, 0)
          if (id !== null && tip) sb.setVelocity(id, undefined, tip)
        }
      }
    }
    // the rest of the storey buckles, nearest the damage first. A failure
    // with no side to it (a command, or charges all round) is a drop
    const hold = HOLD[w.grade] * (0.6 + 0.4 * Math.min(1, (frac.max.y - frac.min.y) / 40))
    let maxD = 1e-3
    const dist = rest.map((i) => {
      const pc = w.pieces[i]
      const d = lean ? Math.hypot(pc.center.x - from.x, pc.center.z - from.z) : 0
      maxD = Math.max(maxD, d)
      return d
    })
    rest.forEach((i, k) => {
      const t = tall ? 0.05 + 0.55 * (dist[k] / maxD) + rnd() * 0.1
        : lean ? 0.12 + hold * 1.5 * (dist[k] / maxD) ** 1.6 : 0.1 + rnd() * 0.25
      later(t, ev, () => crush(w, ev, i))
    })
    // dust out of the base all round, and the groan of it going
    const y = w.o.frac.y0 + iy * frac.binH + 0.5
    tintOf(rest.map((i) => w.pieces[i]).concat(above.slice(0, 8).map((i) => w.pieces[i])), tint)
    const ring = Math.max(4, Math.round(width / 5))
    for (let k = 0; k < ring; k++) {
      const ang0 = (k / ring) * Math.PI * 2
      const rx = (frac.max.x - frac.min.x) / 2 + 0.5
      const rz = (frac.max.z - frac.min.z) / 2 + 0.5
      const at = new THREE.Vector3(cx + Math.cos(ang0) * rx, y, cz + Math.sin(ang0) * rz)
      const [r, g, b] = tint
      later(0.05 + rnd() * 0.3, ev, () => sb.fx.plume(at, width * 0.35, r * 1.15, g * 1.12, b * 1.08))
    }
    rumble(Math.min(1, 0.35 + (frac.max.y - frac.min.y) / 50), cx, y, cz)
  }

  /**
   * A tall building that loses one side of a storey does not sit down on it:
   * it goes over, and on the way it comes apart into a few great sections
   * that each swing out on their own arc. The load above the failed storey
   * is cut into three or four bands of storeys, each born turning about the
   * hinge line along the foot of the far wall (the top moving toward the
   * damage), the upper ones a little faster than the lower, so the stack
   * shears apart at its joints as it falls instead of toppling as one stick.
   */
  const sections = (w: Wreck, ev: Ev, above: number[], iy: number, ux: number, uz: number) => {
    const frac = w.o.frac
    const bins = [...new Set(above.map((i) => w.pieces[i].iy))].sort((a, b) => a - b)
    const K = Math.max(2, Math.min(4, Math.round(bins.length / 1.5)))
    const per = Math.ceil(bins.length / K)
    const hx = (frac.max.x - frac.min.x) / 2
    const hz = (frac.max.z - frac.min.z) / 2
    const half = Math.abs(ux) * hx + Math.abs(uz) * hz
    const pivot = new THREE.Vector3(
      (frac.min.x + frac.max.x) / 2 - ux * half,
      frac.y0 + (iy + 1) * frac.binH - 0.5,
      (frac.min.z + frac.max.z) / 2 - uz * half,
    )
    const axis = new THREE.Vector3(uz, 0, -ux)
    const pos = new THREE.Vector3()
    const om = new THREE.Vector3()
    const vel = new THREE.Vector3()
    for (let k = 0; k * per < bins.length; k++) {
      const band = new Set(bins.slice(k * per, (k + 1) * per))
      const group = above.filter((i) => band.has(w.pieces[i].iy))
      if (!group.length) continue
      const id = spawnLump(w, ev, levelOf(w, group), group, null, null, null, 0)
      const L = id !== null ? lumps.get(id) : undefined
      if (!L || !sb.getTransform(L.id, pos)) continue
      L.section = true
      om.copy(axis).multiplyScalar(0.5 * (1 + 0.35 * k))
      vel.subVectors(pos, pivot)
      vel.crossVectors(om, vel)
      sb.setVelocity(L.id, vel, om)
    }
  }

  const crush = (w: Wreck, ev: Ev, i: number) => {
    if (!w.o.alive[i]) return
    const pc = w.pieces[i]
    ruins.lift(w.o, [i])
    noteLift(ev, w, [i])
    w.hp[i] = 0
    // it bursts out from under the weight. Most of a crushed wall is dust
    // and gravel, not a panel: a wall that left as a whole slab would stand
    // there on its edge holding the load up as well as it did before
    const frac = w.o.frac
    const ox = pc.center.x - (frac.min.x + frac.max.x) / 2
    const oz = pc.center.z - (frac.min.z + frac.max.z) / 2
    const ol = Math.hypot(ox, oz) || 1
    const v = new THREE.Vector3((ox / ol) * 5, 1, (oz / ol) * 5)
    tintOf([pc], tint)
    if (rnd() < 0.35 && makeRoom(3)) throwPieces(w, ev, [i], v, 2)
    else {
      const size = Math.min(5, Math.cbrt(pc.vol) * 1.6)
      sb.fx.rubble(pc.center, v, size, tint[0], tint[1], tint[2])
      tmpV.set(pc.center.x, pc.min.y + 0.6, pc.center.z)
      sb.fx.rubble(tmpV, v, size, tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8)
      if (pc.g) sb.fx.debris('glass', pc.center, v, 2)
    }
    sb.fx.plume({ x: pc.center.x, y: pc.min.y + 0.5, z: pc.center.z }, Math.min(8, pc.max.y - pc.min.y + 2),
      tint[0], tint[1], tint[2])
    settle(w, ev, pc.center)
  }

  /* --------------------------------------------------------- damage -- */

  const reach = (pc: Piece, x: number, y: number, z: number) => {
    const dx = Math.max(pc.min.x - x, 0, x - pc.max.x)
    const dy = Math.max(pc.min.y - y, 0, y - pc.max.y)
    const dz = Math.max(pc.min.z - z, 0, z - pc.max.z)
    return Math.hypot(dx, dy, dz)
  }

  /** deal damage to one building; returns the pieces it broke */
  const hurt = (
    s: Standing, ev: Ev, at: THREE.Vector3, power: number, radius: number,
    dir: THREE.Vector3 | null, throwK: number, carried = false,
  ) => {
    // a building too far or too strong to lose a single piece is left
    // closed: opening one is the expensive part
    const R0 = RESIST[Math.max(0, Math.min(2, s.rec.grade))]
    const b = s.box
    const d0 = Math.hypot(
      Math.max(b.min.x - at.x, 0, at.x - b.max.x),
      Math.max(b.min.y - at.y, 0, at.y - b.max.y),
      Math.max(b.min.z - at.z, 0, at.z - b.max.z))
    if (!s.open && power * falloff(d0, radius) < R0 * 0.5) return 0
    // A blast does not need an answer this slice: the building is taken apart
    // a few milliseconds a frame (the fireball covers the wait) and the blow
    // is dealt when it is ready. A ram does: it is already inside the wall
    if (!s.open && !carried) {
      let job = opening.get(s)
      if (!job) opening.set(s, (job = { it: ruins.opening(s, OPEN_SLICE_WORK), then: [] }))
      const a2 = at.clone()
      const d2 = dir?.clone() ?? null
      job.then.push(() => void hurt(s, ev, a2, power, radius, d2, throwK, carried))
      return 0
    }
    const w = wreckOf(s)
    if (!w) return 0
    const a = w.o.alive
    const broke: number[] = []
    for (let i = 0; i < w.pieces.length; i++) {
      if (!a[i]) continue
      const pc = w.pieces[i]
      const d = reach(pc, at.x, at.y, at.z)
      if (d > radius) continue
      const dmg = power * falloff(d, radius)
      const r = RESIST[w.grade] * (pc.kind === 'floor' ? 1.4 : 1)
      if (dmg < r * 0.15) continue
      w.hp[i] -= dmg / r
      if (w.hp[i] <= 0) broke.push(i)
    }
    if (!broke.length) return 0
    if (!ev.w.includes(w)) ev.w.push(w)
    ruins.lift(w.o, broke)
    noteLift(ev, w, broke)
    makeRoom(broke.length)
    for (const i of broke) {
      const pc = w.pieces[i]
      const v = new THREE.Vector3()
      if (dir) v.copy(dir)
      else {
        v.subVectors(pc.center, at)
        v.y = Math.max(v.y, 0) + v.length() * 0.35
        v.normalize()
      }
      const over = Math.min(4, -w.hp[i] + 1)
      // a piece a ram carries leaves ahead of it, a little faster than it
      // came (or the ram runs into what it just broke and bounces off);
      // one a blast throws goes as hard as the blast was over its strength
      v.multiplyScalar(carried ? throwK * (1.1 + 0.25 * rnd()) : throwK * Math.min(2.2, 0.6 + 0.5 * over))
      // what a ram broke is born clear of it: the ram is already some way
      // into the wall, and a piece born inside it is shoved back into its
      // face by the solver, which stops a tonne of concrete dead
      // Most of what a ram goes through is gravel by the time it is through:
      // a wall's worth of slabs flung ahead of it into a shallow shop comes
      // straight back off the shelving into its face, and a tonne of
      // concrete stops against a heap it made itself
      if (carried && rnd() < 0.3) {
        tintOf([pc], tint)
        sb.fx.rubble(pc.center, v, Math.min(5, Math.cbrt(pc.vol) * 1.6), tint[0], tint[1], tint[2])
        if (pc.g) sb.fx.debris('glass', pc.center, v, 2.5)
        continue
      }
      throwPieces(w, ev, [i], v, over, carried && dir ? tmpA.copy(dir).setLength(1.4) : null, carried ? at.y : undefined)
    }
    tintOf(broke.map((i) => w.pieces[i]), tint)
    // a ram's hole is a burst of gravel, not a cloud: a little dust low down
    sb.fx.plume(carried ? { x: at.x, y: at.y - 1, z: at.z } : at,
      carried ? 1.5 : Math.min(6, 2 + broke.length * 0.5), tint[0] * 1.15, tint[1] * 1.12, tint[2] * 1.08)
    if (broke.length > 2) rumble(Math.min(1, broke.length / 14), at.x, at.y, at.z)
    settle(w, ev, at)
    sb.solidsChanged()
    return broke.length
  }

  const damageAt: Destruction['damageAt'] = (at, power, radius, how = 'command', dir) => {
    const p = new THREE.Vector3(at.x, at.y, at.z)
    const d = dir ? new THREE.Vector3(dir.x, dir.y, dir.z) : null
    let n = 0
    for (const s of ruins.near(p.x, p.y, p.z, radius, nearList).slice()) {
      const ev = newEvent({
        building: s.rec.id, how, x: p.x, y: p.y, z: p.z, power, radius,
        dx: d?.x ?? 0, dy: d?.y ?? 0, dz: d?.z ?? 0, seed: (rnd() * 0x7fffffff) | 0,
      })
      const speed = d ? d.length() : 0
      if (d && speed > 1e-3) d.multiplyScalar(1 / speed)
      n += hurt(s, ev, p, power, radius, d, how === 'blast' ? 9 : Math.max(4, speed * 0.55))
    }
    return n
  }

  const collapse: Destruction['collapse'] = (s, from) => {
    const w = wreckOf(s)
    if (!w) return false
    const frac = w.o.frac
    const f = from
      ? new THREE.Vector3(from.x, from.y, from.z)
      : new THREE.Vector3((frac.min.x + frac.max.x) / 2, frac.y0, (frac.min.z + frac.max.z) / 2)
    const ev = newEvent({
      building: s.rec.id, how: 'collapse', x: f.x, y: f.y, z: f.z, power: 0, radius: 0,
      dx: 0, dy: 0, dz: 0, seed: (rnd() * 0x7fffffff) | 0,
    })
    ev.w.push(w)
    // the lowest storey with walls in it lets go
    let iy = 0
    while (iy < w.cap0.length && w.cap0[iy] <= 0) iy++
    if (iy >= w.cap0.length || w.failed[iy]) return false
    failStorey(w, ev, iy, f)
    sb.solidsChanged()
    return true
  }

  const nearest: Destruction['nearest'] = (at, r) => {
    let best: Standing | null = null
    let bd = Infinity
    for (const s of ruins.near(at.x, at.y, at.z, r, nearList)) {
      const b = s.box
      const d = Math.hypot(
        Math.max(b.min.x - at.x, 0, at.x - b.max.x),
        Math.max(b.min.y - at.y, 0, at.y - b.max.y),
        Math.max(b.min.z - at.z, 0, at.z - b.max.z))
      if (d < bd) {
        bd = d
        best = s
      }
    }
    return best
  }

  /* -------------------------------------------------------- breaking -- */

  const breakLump = (L: Lump, e: ImpactEvent) => {
    if (!lumps.has(L.id)) return
    const pose = poseOfLump(L)
    if (!pose) return
    const w = L.w
    let groups: number[][] | null = null
    let childLevel: Level = 4
    if (L.level === 0 && !L.section && pancake(L, pose, e)) return
    if (L.level === 0) {
      // storeys
      const by = new Map<number, number[]>()
      for (const i of L.pieces) {
        const k = w.pieces[i].iy
        let g = by.get(k)
        if (!g) by.set(k, (g = []))
        g.push(i)
      }
      groups = [...by.values()]
      childLevel = 1
    } else if (L.level === 1) {
      // walls by side, the floor, the roof
      const by = new Map<number, number[]>()
      for (const i of L.pieces) {
        const k = w.pieces[i].key % 6
        let g = by.get(k)
        if (!g) by.set(k, (g = []))
        g.push(i)
      }
      groups = [...by.values()]
      childLevel = 2
    } else if (L.level === 2) {
      groups = L.pieces.map((i) => [i])
      childLevel = 3
    }
    if (groups && groups.length > 1) {
      if (!makeRoom(groups.length)) return
      for (const g of groups) {
        const lv = childLevel === 1 || childLevel === 2 ? (g.length === 1 ? 3 : levelOf(w, g)) : childLevel
        const bp = lv === 3 ? brokenPiece(w, g[0], (w.pieces[g[0]].key * 2654435761 + L.ev.rec.seed) >>> 0) : null
        const id = spawnLump(w, L.ev, lv as Level, g, bp?.frags ?? null, pose, null, 0.8, L.id, null, bp?.decor)
        // a part still moving hard after the whole has been stopped (the top
        // of a falling tower, which swept the widest arc) is stopped in its
        // turn by the same ground on the same slice, and breaks again
        const child = id !== null ? lumps.get(id) : undefined
        if (child && child.level < 4 && sb.getVelocity(child.id, vIn) && vIn.length() > BREAK_DV[child.level] * 1.2) {
          breakQueue.push({ L: child, e: { ...e, speed: vIn.length() }, at: now })
        }
      }
    } else if (L.level <= 2 && groups && groups.length === 1) {
      // one group only: skip straight down a level next time
      L.level = (L.level + 1) as Level
      return
    } else if (L.level === 3) {
      const pc = w.pieces[L.pieces[0]]
      if (pc.vol < SHATTER_MIN || !makeRoom(3)) return
      const shards = shatterFrags(pc.frags, (pc.key * 2654435761 + L.ev.rec.seed) >>> 0, pc.vol > 8 ? 4 : 3)
      if (shards.length < 2) return
      for (const sh of shards) spawnLump(w, L.ev, 4, L.pieces, sh, pose, null, 1.5, L.id)
    } else return
    // the break itself: dust where it hit, bits, a groan for the big ones
    tintOf(L.pieces.slice(0, 6).map((i) => w.pieces[i]), tint)
    const size = Math.cbrt(L.vol)
    const at = { x: e.x, y: e.y, z: e.z }
    sb.fx.plume(at, Math.min(12, size * 1.2), tint[0] * 1.15, tint[1] * 1.12, tint[2] * 1.08)
    sb.fx.rubble(at, pose.vel, Math.min(5, size), tint[0], tint[1], tint[2])
    if (L.level <= 1) rumble(Math.min(1, L.vol / 600), e.x, e.y, e.z)
    removeLump(L)
  }

  /**
   * A cluster that lands still standing more or less upright does not burst
   * into storeys (a stack of storey boxes is as stable as the building was):
   * its lowest storey is crushed to dust and gravel under the rest, which
   * carries on as one cluster, drops that storey's height and lands again.
   * That is the progressive collapse, storey by storey, each with its own
   * burst of dust, until one storey is left or the thing has leaned too far
   * to be standing on anything, when it breaks up the ordinary way.
   */
  const pancake = (L: Lump, pose: Pose, e: ImpactEvent) => {
    tmpA.set(0, 1, 0).applyQuaternion(pose.quat)
    if (tmpA.y < Math.cos((28 * Math.PI) / 180)) return false
    const w = L.w
    let lo = Infinity
    let hi = -Infinity
    for (const i of L.pieces) {
      lo = Math.min(lo, w.pieces[i].iy)
      hi = Math.max(hi, w.pieces[i].iy)
    }
    if (hi <= lo) return false
    const crushed: number[] = []
    const rest: number[] = []
    for (const i of L.pieces) (w.pieces[i].iy === lo ? crushed : rest).push(i)
    // the rest carries on, having spent some of its fall on what it crushed,
    // and a lean it has picked up grows: the crushed storey gave first on
    // the side it was leaning toward
    pose.vel.multiplyScalar(0.35)
    const lean = Math.acos(Math.min(1, tmpA.y))
    if (lean > 0.1) {
      const axis = new THREE.Vector3(tmpA.z, 0, -tmpA.x).normalize()
      pose.ang.addScaledVector(axis, 0.25 + lean * 0.6)
    }
    const next = spawnLump(w, L.ev, 0, rest, null, pose, null, 0, L.id)
    if (next !== null) {
      // and keeps leaning the way it was going
      sb.setVelocity(next, undefined, pose.ang)
    }
    // the storey it landed on: mostly dust and gravel, a few slabs thrown out
    tintOf(crushed.slice(0, 8).map((i) => w.pieces[i]), tint)
    const out = new THREE.Vector3()
    const at = new THREE.Vector3()
    for (const i of crushed) {
      const pc = w.pieces[i]
      at.copy(pc.center).sub(L.rc).applyQuaternion(pose.quat).add(pose.pos)
      out.set(at.x - pose.pos.x, 0, at.z - pose.pos.z).setLength(6)
      out.y = 2
      if (pc.kind === 'wall' && rnd() < 0.3 && makeRoom(1)) {
        spawnLump(w, L.ev, 3, [i], null, pose, out, 1.5, L.id)
      } else {
        sb.fx.rubble(at, out, Math.min(4, Math.cbrt(pc.vol) * 1.4), tint[0], tint[1], tint[2])
      }
    }
    const f = w.o.frac
    const width = Math.max(f.max.x - f.min.x, f.max.z - f.min.z)
    const ring = Math.max(4, Math.round(width / 4))
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2
      sb.fx.plume({ x: e.x + Math.cos(a) * width * 0.5, y: e.y + 0.5, z: e.z + Math.sin(a) * width * 0.5 },
        width * 0.4, tint[0], tint[1], tint[2])
    }
    rumble(Math.min(1, L.vol / 500), e.x, e.y, e.z)
    removeLump(L)
    return true
  }

  const removeLump = (L: Lump) => {
    lumps.delete(L.id)
    L.ev.live.delete(L.id)
    sb.remove(L.id)
  }

  /* ------------------------------------------------------ the hooks -- */

  const offImpact = sb.onImpact((e) => {
    const L = lumps.get(e.id)
    if (L) {
      // a collapse is over some seconds after it began: from then on only a
      // real blow breaks rubble, not the heap shuffling itself
      // (a thrown slab still breaks against a wall; a slab the solver
      // pinched in the heap at twenty units a second does not)
      const late = now - L.born > 6 ? 4 : now - L.ev.rec.t > 7 || now - L.born > 4 ? 2.5 : 1
      // and a panel shatters on its landing or not at all
      if (L.level === 3 && now - L.born > 3) return
      const dv = (L.section ? 5 : BREAK_DV[L.level]) * late
      if (L.level < 4 && e.speed > dv && now - L.born > 0.08 && !breakQueue.some((q) => q.L === L)) {
        breakQueue.push({ L, e, at: now })
      }
    }
    // anything heavy hitting a building's solid damages it: a thrown block,
    // a falling storey, the car's hull when it is a prop
    if (e.with === "solid" && e.solid && e.speed > 6) {
      const own = ruins.owner(e.solid)
      if (!own) return
      // rubble smaller than a wall section does not bring the next building
      // down, or one tower takes the whole of downtown with it
      const lump = lumps.get(e.id)
      if (lump && lump.level > (lump.w.s === own.s ? 2 : 1)) return
      // ...and only while it is falling: a slab come to rest against the
      // building next door, rocking in the heap, chewed it down knock by
      // knock for as long as the film ran
      if (lump && now - lump.born > 3.5) return
      const R = RESIST[Math.max(0, Math.min(2, own.s.rec.grade))]
      // a thrown prop hits with all the momentum it had, not with whatever
      // share of it the first slice of contact took off (a broadside that
      // meets the stall riser first reports a third of its speed)
      let impulse = e.impulse
      if (!lump) {
        const v = e.prop.body.linvel()
        impulse = Math.max(impulse, e.prop.mass * (Math.hypot(v.x, v.y, v.z) + e.speed) * 0.8)
      }
      const dmg = Math.min(impulse / IMPULSE_PER_DAMAGE, R * 4)
      // a knock that could not break a piece in two blows is only a knock:
      // rubble settling against a wall must not chip the town down
      if (dmg < R * 0.5) return
      impacts.push({ s: own.s, e, dmg })
    }
  })
  const impacts: Array<{ s: Standing; e: ImpactEvent; dmg: number }> = []
  /** buildings being taken apart a slice at a time, and the blows waiting
      on each */
  const opening = new Map<Standing, { it: Generator<void, Opened | null, void>; then: Array<() => void> }>()
  /** props that have just broken through a wall and are still going */
  const rams = new Map<PropId, { s: Standing; dmg: number; r: number; until: number; speed: number; dir: THREE.Vector3 }>()

  const offBlast = sb.onExplosion((e) => {
    damageAt(e, 70 * e.power, e.radius * 0.8, 'blast')
  })

  const offRemove = sb.onRemove((p: Prop) => {
    const L = lumps.get(p.id)
    if (!L) return
    stats.lost++
    lumps.delete(p.id)
    L.ev.live.delete(p.id)
    L.mesh?.userData.dispose?.()
  })

  const vIn = new THREE.Vector3()
  let settleClock = 0
  let aheadClock = 0
  const tmpA = new THREE.Vector3()
  const tmpQ = new THREE.Quaternion()
  const tmpB = new THREE.Vector3()
  const vPre = new THREE.Vector3()
  const offSlice = sb.onAfterSlice((h) => {
    const t0 = performance.now()
    now += h
    // A heavy thing flying at a building that has not been opened yet: open
    // it now, a slice at a time, so that by the time it arrives the pieces
    // are there to be broken and the hit costs nothing. Checked every few
    // slices along each fast prop's own line
    if ((aheadClock += h) >= 0.05) {
      aheadClock = 0
      sb.forEach((p) => {
        // (a carried prop counts: the physgun and a scenario's ram hold what
        // they throw kinematic until the moment they let go)
        if (p.mode === 'frozen' || p.mass < 150 || lumps.has(p.id) || p.body.isSleeping()) return
        const v = p.body.linvel()
        const sp = Math.hypot(v.x, v.y, v.z)
        if (sp < 12) return
        const t = p.body.translation()
        const hit = sb.raycast(t, v, sp * 1.2 + Math.max(p.extents.x, p.extents.z), { props: false, world: true })
        const own = hit?.solid ? ruins.owner(hit.solid) : null
        if (own && !own.s.open && !opening.has(own.s)) {
          opening.set(own.s, { it: ruins.opening(own.s, OPEN_SLICE_WORK), then: [] })
        }
      })
    }
    // buildings being opened: a few milliseconds of cutting a slice, then
    // the blows that were waiting on them
    for (const [st, job] of opening) {
      const t1 = performance.now()
      const r = job.it.next()
      stats.openMs = Math.max(stats.openMs, performance.now() - t1)
      if (r.done) {
        opening.delete(st)
        // the blows that waited, a slice apart: eight charges dealt in one
        // slice is eight settles and a storey's worth of rubble at once
        if (r.value) job.then.forEach((fn, k) => jobs.push({ t: now + k / 60, ev: null, fn }))
        sb.solidsChanged()
      }
      // one building's work a slice
      break
    }
    // prop and rubble impacts on what still stands
    while (impacts.length) {
      const { s, e, dmg } = impacts.shift()!
      const p = sb.get(e.id)
      if (!p) continue
      sb.getVelocity(e.id, vIn)
      const ev = newEvent({
        building: s.rec.id, how: 'impact', x: e.x, y: e.y, z: e.z, power: dmg, radius: 0,
        dx: vIn.x, dy: vIn.y, dz: vIn.z, seed: (rnd() * 0x7fffffff) | 0,
      })
      // as wide as what hit: a barrier broadside takes a bay, a brick a hole
      const r = Math.min(5, Math.max(1.4, Math.max(p.extents.x, p.extents.y, p.extents.z) * 1.15))
      // the face it struck, pointing into the solid, and so the velocity it
      // had before the bounce the slice already gave it
      const b = e.solid!
      const cx = (b.min.x + b.max.x) / 2
      const cz = (b.min.z + b.max.z) / 2
      const nx = Math.abs(e.x - cx) / (b.max.x - b.min.x + 1e-3) > Math.abs(e.z - cz) / (b.max.z - b.min.z + 1e-3)
        ? -Math.sign(e.x - cx) : 0
      const nz = nx === 0 ? -Math.sign(e.z - cz) : 0
      vPre.set(vIn.x + nx * e.speed, vIn.y, vIn.z + nz * e.speed)
      // rubble landing on a building waits for it to be opened like a blast
      // does; a thrown prop is a ram and cannot (see `ahead` below)
      const ram = !lumps.has(e.id)
      const broke = hurt(s, ev, tmpV.set(e.x, e.y, e.z), dmg, r, vPre.lengthSq() > 1 ? vPre.clone() : null, 1, ram)
      // a prop that went *through* keeps most of its way: what it hit gave
      if (broke && !lumps.has(e.id)) {
        sb.setVelocity(e.id, vPre.multiplyScalar(0.72))
        rams.set(e.id, { s, dmg, r, until: now + 0.6, speed: vPre.length(), dir: vPre.clone().normalize() })
      }
    }
    // ...and goes on through: whatever of the building is in front of it
    // this slice is hit too, without waiting for an impact the prop layer
    // rate-limits to one in ninety milliseconds (a shop's back room of
    // shelving otherwise stops a tonne of concrete on the second thing it
    // meets)
    for (const [id, ram] of rams) {
      const p = sb.get(id)
      if (!p || now > ram.until || !ram.s.open || !sb.getTransform(id, tmpA)) {
        rams.delete(id)
        continue
      }
      sb.getVelocity(id, vIn)
      const along = vIn.dot(ram.dir)
      tmpA.addScaledVector(ram.dir, Math.max(p.extents.x, p.extents.z) * 0.8)
      const ev = newEvent({
        building: ram.s.rec.id, how: 'impact', x: tmpA.x, y: tmpA.y, z: tmpA.z, power: ram.dmg, radius: ram.r,
        dx: ram.dir.x, dy: ram.dir.y, dz: ram.dir.z, seed: (rnd() * 0x7fffffff) | 0,
      })
      const broke = hurt(ram.s, ev, tmpA.clone(), ram.dmg, ram.r, ram.dir.clone().multiplyScalar(ram.speed), 1, true)
      if (broke) {
        ram.speed *= 0.85
        ram.dmg *= 0.85
        if (along < ram.speed) sb.setVelocity(id, vIn.addScaledVector(ram.dir, ram.speed - along))
      } else {
        log.pop()
        seq--
        if (along < ram.speed * 0.3) rams.delete(id)
      }
    }
    // lumps that landed hard, as many as the slice's budget runs to (a
    // tower landing breaks a hundred things at once, and a lump that waits a
    // slice to come apart is not a lump anyone can see waiting)
    const made0 = made
    for (let k = 0; breakQueue.length && k < BREAKS_PER_SLICE && made - made0 < SPAWNS_PER_SLICE; k++) {
      const { L, e, at } = breakQueue.shift()!
      // a break is the landing, or it is nothing: one that waited behind a
      // tower's worth of others is a lump already lying in the heap
      if (at !== undefined && now - at > 0.35) {
        k--
        continue
      }
      breakLump(L, e)
    }
    flushSpawns(SPAWNS_PER_SLICE)
    // the timetable
    if (jobs.length) {
      jobs.sort((a, b) => a.t - b.t)
      let k = 0
      while (k < jobs.length && jobs[k].t <= now) k++
      const due = jobs.splice(0, k)
      for (const j of due) if (!j.ev?.dead) j.fn()
      if (due.length) sb.solidsChanged()
    }
    // small shards age out, and anything the budget let go shrinks away
    let stalled: Lump | null = null
    for (const L of lumps.values()) {
      if (L.level === 0 && sb.getTransform(L.id, tmpA, tmpQ)) {
        const up = tmpA.set(0, 1, 0).applyQuaternion(tmpQ).y
        const deg = (Math.acos(Math.min(1, up)) * 180) / Math.PI
        stats.lean = Math.max(stats.lean, deg)
        // a cluster that has come to rest leaning is not at rest: it is
        // standing on the heap of its own crushed storey, which gives next
        if (!L.section && deg > 6 && now - L.born > 0.6 && sb.getVelocity(L.id, vIn, tmpB) && vIn.length() < 1.5 && tmpB.length() < 0.25) {
          stalled = L
        }
      }
      // Nothing storey-sized lies about intact: a whole section or storey of
      // a building that has come to rest on the rubble goes to pieces under
      // its own weight (a five-storey box sitting on the heap with its
      // window grid unmarked is the one thing a collapse never leaves)
      if (!stalled && L.level <= 1 && (L.section || L.level === 1) && L.vol > 60 && now - L.born > 1 &&
        now - L.ev.rec.t < 7 &&
        sb.getVelocity(L.id, vIn, tmpB) && vIn.length() < 2.5 && tmpB.length() < 0.6) {
        stalled = L
      }
      // a piece born brushing a box it could not be carved out of is shoved
      // out by the solver; nothing that young has a reason to be that fast
      // (and nothing in a collapse is ever faster than a tower's top falling
      // its own height: a shard doing more has been pinched by the solver)
      const cap = now - L.born < 0.4 ? 48 : 70
      if (sb.getVelocity(L.id, vIn) && vIn.lengthSq() > cap * cap) {
        vIn.setLength(cap)
        sb.setVelocity(L.id, vIn)
      }
      if (L.going < 0 && L.level === 4 && L.vol < SHARD_VOL && now - L.born > SHARD_LIFE) L.going = 0
      if (L.going < 0) continue
      L.going += h
      const k = 1 - L.going / 0.6
      if (L.mesh) L.mesh.scale.setScalar(Math.max(0.01, k))
      if (k <= 0) removeLump(L)
    }
    // Rubble is put to sleep once it is only crawling. Rapier sleeps a body
    // whose whole island is still, and a heap of a hundred hulls is one
    // island in which something is always creeping a millimetre, so the
    // heap never sleeps and costs a full solve every slice for as long as it
    // lies there. Anything that has crawled for most of a second is done
    if ((settleClock += h) >= 0.25) {
      settleClock = 0
      // A piece the heap has pressed into the street is put back on it and
      // pinned there. A heightfield has no
      // thickness, so under a pile of slabs a shard is squeezed through it,
      // and lifted back out it is only squeezed through again, for ever (or
      // until the props' rescue gives up and deletes it). The physgun can
      // still pull it free
      for (const L of lumps.values()) {
        if (!sb.getTransform(L.id, tmpA)) continue
        const p = sb.get(L.id)
        if (!p || p.mode !== 'dynamic') continue
        const g = sb.groundY(tmpA.x, tmpA.z)
        // (its middle under the street by more than half its thickness:
        // one merely lying bedded in the rubble's own dust is left alone)
        if (tmpA.y + Math.min(p.extents.x, p.extents.y, p.extents.z) * 0.5 < g - 0.1) {
          // back up to lie on it, and pinned there
          tmpA.y = g + Math.min(p.extents.x, p.extents.y, p.extents.z)
          sb.setTransform(L.id, tmpA)
          sb.setVelocity(L.id, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
          sb.freeze(L.id)
        }
      }
      for (const L of lumps.values()) {
        const p = sb.get(L.id)
        if (!p || p.mode !== 'dynamic' || p.body.isSleeping() || now - L.born < 1) continue
        sb.getVelocity(L.id, vIn, tmpB)
        if (vIn.lengthSq() < 2 * 2 && tmpB.lengthSq() < 1.2 * 1.2) L.slow++
        else L.slow = 0
        if (L.slow >= 2 || (now - L.born > 7 && vIn.lengthSq() < 6 * 6)) rest(p.body)
        else if (now - L.born > 5 && !L.damped) {
          // Five seconds on, a collapse is over and what is still moving is
          // the solver arguing inside the heap (a shard pinched between a
          // slab and the street is fired off at thirty units a second, lands
          // on the heap and is pinched again). Thicken the air for it: it
          // comes to rest in a second instead of dancing for a minute
          L.damped = true
          p.body.setLinearDamping(1.2)
          p.body.setAngularDamping(2)
        }
      }
    }
    if (stalled) {
      const pose = poseOfLump(stalled)
      if (pose) {
        const low = pose.pos.clone()
        low.y = sb.groundY(low.x, low.z) + 0.5
        const e = { x: low.x, y: low.y, z: low.z, speed: 0 } as ImpactEvent
        if (stalled.section || stalled.level === 1 || !pancake(stalled, pose, e)) breakLump(stalled, e)
      }
    }
    stats.sliceMs = performance.now() - t0
  })

  // a car through a wall: the ruins' breakable-solid hook
  ruins.onHit = (s, _piece, x, y, z, dx, dz, speed) => {
    damageAt({ x, y, z }, Math.min(3, speed / 12) * RESIST[Math.max(0, Math.min(2, s.rec.grade))] * 1.3,
      3.2, 'vehicle', { x: dx * speed, y: 0.15 * speed, z: dz * speed })
  }
  rearm()

  const d: Destruction = {
    damageAt,
    collapse,
    nearest,
    get log() {
      return log
    },
    get stats() {
      let awake = 0
      for (const L of lumps.values()) {
        const p = sb.get(L.id)
        if (p && p.mode === 'dynamic' && !p.body.isSleeping()) awake++
      }
      stats.lumps = lumps.size
      stats.awake = awake
      stats.frozen = frozenCount()
      return stats
    },
    ruins,
    dispose: () => {
      offImpact()
      offBlast()
      offRemove()
      offSlice()
      ruins.onHit = null
      rearm()
      attached.delete(sb)
    },
  }
  function rearm() {
    rearmRuins(ruins)
  }
  // The cutting, shattering and chipping are cold code until the first
  // building comes down, and V8 compiles them on first use: the first blast
  // in a session cost six milliseconds more than every later one. Run them
  // once on a small wall now, while the world is attaching under the cover
  {
    const g = new THREE.BoxGeometry(6, 4, 0.6, 2, 2, 1).toNonIndexed()
    const p = Array.from(g.getAttribute('position').array as Float32Array)
    const wall: Frag = {
      p, n: Array.from(g.getAttribute('normal').array as Float32Array), c: p.map(() => 0.5),
      surf: 2, closed: true, core: [0.3, 0.3, 0.3], face: 0, glass: false,
    }
    g.dispose()
    for (let k = 0; k < 6; k++) {
      for (const sh of shatterFrags([wall], k + 1, 4)) breakDecor(chipFrags(sh, k + 7, 2), k, k % 3, 2)
    }
    // ...and a whole fracture of a two-storey block, which is the rest of it
    const block = new THREE.BoxGeometry(14, 10, 12, 3, 3, 3).translate(0, 5, 0).toNonIndexed()
    block.setAttribute('color', new THREE.BufferAttribute(new Float32Array(block.getAttribute('position').count * 3).fill(0.5), 3))
    const n = block.getAttribute('position').count
    const warmRec: StructureRec = {
      id: 'warm', kind: 'midrise', baseY: 0, storeyH: 4.6, grade: 1,
      det: [0, n, 0, 0], gl: null, marks: new Int32Array([0, 0]), gmarks: new Int32Array(0), boxes: [],
    }
    fractureStructure(warmRec, block, null)?.detail?.dispose()
    block.dispose()
  }
  attached.set(sb, d)
  return d
}

/* ----------------------------------------------------------- commands -- */

/** the building the console means: the one under the crosshair, else the
    nearest to the typist */
const target = (ctx: CommandCtx, sb: Sandbox, dmg: Destruction) => {
  const a = ctx.host.aim?.()
  if (a) {
    const hit = sb.raycast(a.origin, a.dir, 400, { props: false, world: true })
    if (hit?.solid) {
      const own = dmg.ruins.owner(hit.solid as Solid)
      if (own) return { s: own.s, at: hit.point }
    }
    if (hit) {
      const s = dmg.nearest(hit.point, 12)
      if (s) return { s, at: hit.point }
    }
  }
  const me = ctx.host.here?.()
  if (me) {
    const s = dmg.nearest(me, 60)
    if (s) return { s, at: new THREE.Vector3(me.x, me.y, me.z) }
  }
  return null
}

const needDestruction = (ctx: CommandCtx) => {
  const sb = ctx.needSandbox()
  const dmg = destructionOf(sb)
  if (!dmg) ctx.fail(msg('nothing out here can be knocked down yet', 'todavía no se puede derribar nada aquí'))
  return { sb, dmg: dmg! }
}

registerCommand({
  name: 'collapse',
  aliases: ['demolish'],
  args: [{ name: 'side', type: 'choice', optional: true, choices: ['near', 'far', 'left', 'right', 'down'] }],
  help: msg(
    'bring down the building you are looking at: its ground floor gives, and it falls toward the side you name (down drops it straight)',
    'derriba el edificio que estás mirando: cede la planta baja y cae hacia el lado que digas (down lo deja caer recto)'),
  run: (ctx) => {
    const { sb, dmg } = needDestruction(ctx)
    const t = target(ctx, sb, dmg)
    if (!t) return ctx.fail(msg('look at a building first', 'apunta a un edificio primero'))
    const b = t.s.box
    const c = b.getCenter(new THREE.Vector3())
    const side = ctx.args[0] ?? 'near'
    let from: THREE.Vector3 | undefined
    if (side !== 'down') {
      const me = ctx.host.here?.() ?? { x: t.at.x, z: t.at.z }
      let dx = me.x - c.x
      let dz = me.z - c.z
      const l = Math.hypot(dx, dz) || 1
      dx /= l
      dz /= l
      if (side === 'far') { dx = -dx; dz = -dz }
      if (side === 'left' || side === 'right') {
        const s = side === 'left' ? 1 : -1
        const ox = dx
        dx = -dz * s
        dz = ox * s
      }
      const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2
      from = new THREE.Vector3(c.x + dx * r, b.min.y, c.z + dz * r)
    }
    if (!dmg.collapse(t.s, from)) return ctx.fail(msg('that one is already down', 'ese ya está en el suelo'))
    ctx.ok(msg('timber!', '¡cuidado, que cae!'))
  },
})

registerCommand({
  name: 'damage',
  aliases: ['wreck'],
  args: [{ name: 'power', type: 'number', optional: true }],
  help: msg(
    'knock a hole in whatever wall you are looking at (power 1 is a barrel going off against it)',
    'abre un boquete en la pared que estás mirando (potencia 1 es un barril que explota contra ella)'),
  run: (ctx) => {
    const { sb, dmg } = needDestruction(ctx)
    const a = ctx.host.aim?.()
    if (!a) return ctx.fail(msg('look at a wall first', 'apunta a una pared primero'))
    const hit = sb.raycast(a.origin, a.dir, 300, { props: false, world: true })
    if (!hit || hit.ground) return ctx.fail(msg('look at a wall first', 'apunta a una pared primero'))
    const power = Math.max(0.1, Math.min(20, ctx.args[0] ? Number(ctx.args[0]) : 1))
    const n = dmg.damageAt(hit.point, 70 * power, 5 + 4 * Math.sqrt(power), 'command',
      { x: a.dir.x * 8, y: a.dir.y * 8, z: a.dir.z * 8 })
    if (!n) return ctx.fail(msg('it held', 'aguantó'))
    ctx.ok(msg(`${n} ${n === 1 ? 'piece' : 'pieces'} knocked out`, `${n} ${n === 1 ? 'pedazo arrancado' : 'pedazos arrancados'}`))
  },
})

export type { Standing, Ruins }
