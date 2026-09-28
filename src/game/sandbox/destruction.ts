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
  into their four walls and a floor, and walls into panels, each level on its
  own impact, so a tower that hits the street breaks up storey by storey as
  it goes down rather than bursting into gravel on the first frame. It stops
  there: a panel lands as the panel it is (one stood on its end in the heap
  is pushed over), and only a blast close by, or a big panel landing very
  hard, breaks one into Voronoi shards with capped, coloured break faces
  (fracture.ts's `shatterFrags`), two or three of them. What a blast only
  just reached leaves whole, and neighbouring pieces of one face leave
  together as one slab. How many pieces there are to begin with is
  fracture.ts's `PIECE_SCALE`; every one of these rules used to break a
  building into about three times the rubble, and the street was carpeted
  with it. Rubble that hits what is still standing damages it, which is how
  a collapse walks down a building and why a toppled tower takes the corner
  shop with it.

  Every lump is a real prop (a kind registered here, a hull collider, the
  chunk's own material, so no new program is ever linked), which is what the
  physgun, undo and the network already speak. The budget is the tier's
  `gfx.rubble` of lumps *awake*: past it the oldest settled ones are damped
  and put to sleep (a sleeping hull costs the solver nothing, and stays
  rubble the physgun can pick up), breaking up stops at the coarser level,
  and past one and a half times it (`KEEP`) the oldest small ones go in a
  puff of dust. Rubble that crawls is put to sleep, one still awake after
  that is frozen where it lies (and let go again if what it lay on leaves:
  `thaw`), and a piece the heap presses into the street is pinned there (a
  heightfield has no thickness).
  Small shards shrink away after `SHARD_LIFE`, like gibs; anything big stays,
  which is what makes the ruin somewhere you can walk into.

  What a destruction *is* stays plain data, and that is what the shared world
  carries (net/remoteDamage.ts). Two things travel. The *record* of each blow
  (`DamageRecord`: a building id, a point, a power, a radius, the throw and a
  seed) is how a peer who is watching sees the same show: it replays the blow
  through the same `hurt`, and the pieces a blow lifts, and the storeys that
  fail under them, follow from it deterministically. Blasts are not
  recorded on the wire, because the explosion itself already travels and
  lands here through `onExplosion` like a local one. The *truth* is the set
  of piece keys each building has lost (the ruins' `ruined`), which every
  client reports and the server keeps as a union, so whatever physics made
  two clients' collapses differ, the holes end up the same: `absorb` lifts
  what somebody else lost and this client has not, after a grace that lets
  the local replay get there first.

  A replayed event is `remote`, and a remote event is a show only: its
  rubble breaks up and settles as usual but damages no building (the peer
  who caused it reports what its own rubble broke), it is not recorded again
  and it is nobody's to undo. Online, undo takes rubble away but puts no
  wall back, because the hole is everyone's now.
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
const BREAK_DV = [13, 3, 8, 11]
/** rubble put to rest once moves no faster than this again unless a blast
    or a player moves it: what re-launched shards over the rooftops seconds
    after a collapse was the solver resolving overlaps inside the heap */
const SETTLED_CAP = 3
/** anything standing taller than this, and most of its own length upright
    (`UPRIGHT`), is a slab on its edge, and a slab on its edge in a heap goes
    over: a storey and a bit. (Pieces are two storeys tall on a mid-rise now,
    and one merely leaning on the heap is not standing) */
const TALL = 6
const UPRIGHT = 0.8
/** a piece smaller than this is not shattered further (cubic units) */
const SHATTER_MIN = 2.2
/** How much rubble there is is fracture.ts's PIECE_SCALE (how big the
    pieces are); these say how many bits a piece may still break into. A
    piece a blast throws shatters only where the blast was still strong
    (its falloff at the piece over `SHATTER_F`: further out it goes whole,
    chipped, and its neighbours on the same face with it as one slab), into
    two, or three when it is a big one (`SHARD_BIG`). A panel off a falling
    building splits in two only when it is that big and lands very hard.
    It was three or four each, everywhere, on the landing too, and that was
    most of what carpeted the street */
const SHATTER_F = 0.35
const SHARD_BIG = 60
const shardsOf = (vol: number) => (vol > SHARD_BIG ? 3 : 2)
/** a blast breaks a piece when it reaches into the piece's middle, not
    merely its nearest corner: this share of each half-extent counts. The
    pieces are big now (PIECE_SCALE), and measured from their edges a blast
    took twice the building the old small ones gave it; from half way in it
    takes about what it did */
const CORE = 0.5
/** seconds a small shard lies about before it shrinks away */
const SHARD_LIFE = 14
const SHARD_VOL = 0.9
/** rubble kept at once, as a multiple of the tier's awake budget: past it
    the oldest small lumps shrink away */
const KEEP = 1.5
/** how much a slice may do of the three expensive things: taking a
    building apart (triangles of fracture work, about 3 ms), making rubble
    bodies and breaking landed lumps. Counted in work rather than time so a
    destruction comes out the same on every machine */
const OPEN_SLICE_WORK = 900
const SPAWNS_PER_SLICE = 12
const BREAKS_PER_SLICE = 6
/** a prop's impulse (kg*u/s) per unit of damage against a wall */
const IMPULSE_PER_DAMAGE = 380
/** seconds a piece somebody else lost may stay standing here before it is
    simply taken out: long enough for the replayed blow's own slices and a
    failing storey's first crushes (`HOLD`) to lift it with the full show */
const ABSORB_GRACE = 1.2

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
  /** the direction `hurt` throws the pieces along (unit for a blast or a
      vehicle, a prop's own velocity for an impact), or zero for outward */
  dx: number
  dy: number
  dz: number
  /** the throw's scale, and whether it was a ram carrying on through: the
      rest of what `hurt` was called with, so a peer can call it again */
  k: number
  ram: boolean
  seed: number
  /** simulation time */
  t: number
}

export interface Destruction {
  /** damage every building within `radius` of a point; returns pieces broken.
      `remote` marks it as somebody else's blow being shown here */
  damageAt: (
    at: Vec3Like, power: number, radius: number, how?: DamageRecord['how'], dir?: Vec3Like, remote?: boolean,
  ) => number
  /** bring a building down from its ground storey. `from` is where the
      failure starts (it leans that way); omitted, it drops straight down */
  collapse: (s: Standing, from?: Vec3Like) => boolean
  /** the building nearest a point, within `r` */
  nearest: (at: Vec3Like, r: number) => Standing | null
  /** everything that has happened, oldest first */
  readonly log: readonly DamageRecord[]
  /** a blow this client dealt that a peer must replay to see it (not
      blasts, which travel as explosions): the shared world's hook */
  onRecord: ((r: DamageRecord) => void) | null
  /** show somebody else's blow: false when the building is not built here */
  replay: (r: Omit<DamageRecord, 'seq' | 't'>) => boolean
  /** somebody else's building lost these piece keys: remembered at once,
      and lifted from the building here (if it stands in a loaded chunk)
      after a grace for the local replay to get there first, or at once and
      without a sound or a body when `quiet` (a late join's catch-up) */
  absorb: (building: string, keys: readonly number[], quiet: boolean) => void
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
    /** the fastest anything already put to rest was found moving (and was
        caught), u/s */
    settledMax: number
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
  /** sim time it first touched the ground or the heap, or -1 */
  landed: number
  /** put to rest once: from then on it may not be flung (see SETTLED_CAP) */
  settled?: boolean
  /** when it was first put to rest */
  restAt?: number
  /** a piece a blow threw whole out of the wall (see throwPieces): it has
      broken once, and does not shatter again when it lands */
  thrown?: boolean
  /** when it was pushed over for standing on its end (see breakLump) */
  toppled?: number
  /** pinned in the street (see the settle pass): never thawed */
  pinned?: boolean
  /** when it was last thawed (see `thaw`) */
  woke?: number
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
  /** somebody else's blow, shown here (see the header) */
  remote: boolean
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
  const stats = { lumps: 0, awake: 0, frozen: 0, buildings: 0, openMs: 0, sliceMs: 0, lost: 0, lean: 0, settledMax: 0 }
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

  const newEvent = (rec: Omit<DamageRecord, 'seq' | 't'>, remote = false): Ev => {
    const r: DamageRecord = { ...rec, seq: seq++, t: now }
    log.push(r)
    if (log.length > 400) log.shift()
    return { rec: r, w: [], lifted: new Map(), entry: null, live: new Set(), dead: false, remote }
  }

  /** tell the shared world about a blow of ours (a blast travels as itself) */
  const announce = (ev: Ev) => {
    if (!ev.remote && ev.rec.how !== 'blast') d.onRecord?.(ev.rec)
  }

  const history = () => historyOf(sb)

  const undoEvent = (ev: Ev) => {
    ev.dead = true
    // online the hole is everyone's (the server keeps a union of what every
    // building lost), so undo clears the rubble and leaves the wall down
    if (sb.network?.online) return
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
    if (ev.remote) return
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
    if (!ev.entry && !ev.remote) {
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
      id, w, level, pieces: list, frags, rc: rc.clone(), vol: m.vol, born: now, ev, going: -1, mesh, slow: 0, landed: -1,
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
    if (staying + n > cap * KEEP) {
      // oldest first (the map keeps spawn order), and never the big ones
      for (const L of lumps.values()) {
        if (staying + n <= cap * KEEP * 0.85) break
        if (L.going >= 0 || L.vol > 40) continue
        L.going = 0
        staying--
      }
    }
    return moving + n <= cap * 1.15
  }

  /** how tall a lump stands right now: its local box turned by its pose */
  const standing = (L: Lump) => {
    const p = sb.get(L.id)
    if (!p || !sb.getTransform(L.id, tmpS, tmpSQ)) return 0
    const e = p.extents
    const m = tmpSM.makeRotationFromQuaternion(tmpSQ).elements
    return 2 * (Math.abs(m[1]) * e.x + Math.abs(m[5]) * e.y + Math.abs(m[9]) * e.z)
  }
  /** standing on its end (see TALL) */
  const upright = (L: Lump) => {
    const p = sb.get(L.id)
    if (!p) return false
    const h = standing(L)
    const e = p.extents
    // tall, stood on its long axis, and thin across some way: a slab or a
    // column (a block is a block whichever way up it lies)
    return h > TALL && h > UPRIGHT * 2 * Math.max(e.x, e.y, e.z) && 2 * Math.min(e.x, e.y, e.z) < 0.35 * h
  }
  const tmpS = new THREE.Vector3()
  const tmpSQ = new THREE.Quaternion()
  const tmpSM = new THREE.Matrix4()

  /** damped hard and put to sleep: a neighbour still creeping wakes it, and a
      heavily damped body stops again at once, which is what lets a whole
      heap's island go quiet */
  const rest = (body: Prop['body']) => {
    body.setLinearDamping(2)
    body.setAngularDamping(3)
    body.sleep()
    const L = lumps.get((body.userData as Prop).id)
    if (L && !L.settled) {
      L.settled = true
      L.restAt = now
    }
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
      const big = pc.vol >= SHATTER_MIN * (ramY !== undefined ? 0.5 : 1) && energy > (w.grade === 0 && ramY === undefined ? 2.5 : 1.4) && makeRoom(3)
      tintOf([pc], tint)
      const seed = (pc.key * 2654435761 + ev.rec.seed) >>> 0
      // every choice is drawn now, in order, so the stream stays the same
      // however the making is spread across slices
      const kicks: THREE.Vector3[] = []
      const n = big ? (ramY !== undefined ? (pc.vol > 6 ? 6 : 5) : shardsOf(pc.vol)) : 1
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
          const id = spawnLump(w, ev, 3, [i], bp.frags, null, kicks[0], energy > 1 ? 2 : 0.6, undefined, off, bp.decor)
          // it has broken once, out of the wall: it lands as it left
          const L = id !== null ? lumps.get(id) : undefined
          if (L) L.thrown = true
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

  /** the runs of one storey's face in a set of pieces: bonded side by side,
      same storey bin, same facing */
  const faceRuns = (w: Wreck, list: number[]) => {
    const inSet = new Set(list)
    const seen = new Set<number>()
    const out: number[][] = []
    for (const i of list) {
      if (seen.has(i)) continue
      const a = w.pieces[i]
      const run: number[] = []
      const stack = [i]
      seen.add(i)
      while (stack.length) {
        const j = stack.pop() as number
        run.push(j)
        for (const k of w.pieces[j].side) {
          const b = w.pieces[k]
          if (!inSet.has(k) || seen.has(k) || b.iy !== a.iy || b.key % 6 !== a.key % 6) continue
          seen.add(k)
          stack.push(k)
        }
      }
      out.push(run)
    }
    return out
  }

  /** a run of one face thrown as one slab (see hurt): chipped at its
      corners, rebar or splinters out of them, and whole when it lands */
  const throwSlab = (w: Wreck, ev: Ev, list: number[], at: THREE.Vector3, dir: THREE.Vector3 | null, throwK: number) => {
    const c = new THREE.Vector3()
    let vol = 0
    let over = 4
    for (const i of list) {
      const pc = w.pieces[i]
      c.addScaledVector(pc.center, pc.vol)
      vol += pc.vol
      over = Math.min(over, -w.hp[i] + 1)
    }
    c.multiplyScalar(1 / Math.max(1e-6, vol))
    const v = new THREE.Vector3()
    if (dir) v.copy(dir)
    else {
      v.subVectors(c, at)
      v.y = Math.max(v.y, 0) + v.length() * 0.35
      v.normalize()
    }
    v.multiplyScalar(throwK * Math.min(2.2, 0.6 + 0.5 * Math.max(1, over)))
    const seed = (w.pieces[list[0]].key * 2654435761 + ev.rec.seed) >>> 0
    for (const i of list) {
      const pc = w.pieces[i]
      tintOf([pc], tint)
      if (pc.g) sb.fx.debris('glass', pc.center, v, Math.min(3, (pc.max.x - pc.min.x + pc.max.z - pc.min.z) / 3))
      sb.fx.rubble(pc.center, v, Math.min(4, Math.cbrt(pc.vol) * 1.4), tint[0], tint[1], tint[2])
    }
    spawns.push(() => {
      const frags = chipFrags(list.flatMap((i) => w.pieces[i].frags), seed, 3)
      const decor = breakDecor(frags, seed ^ 0x9e37, w.grade, 3)
      const id = spawnLump(w, ev, levelOf(w, list), list, frags, null, v, 1, undefined, null, decor)
      const L = id !== null ? lumps.get(id) : undefined
      if (L) L.thrown = true
    })
  }

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
    lift(w.o, loose)
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
      lift(w.o, above)
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
    lift(w.o, [i])
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
    if (rnd() < 0.2 && makeRoom(3)) throwPieces(w, ev, [i], v, 2)
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

  /** from a point to a piece's box, or with `core` under 1 to that box
      shrunk about its middle to that share (see CORE) */
  const reach = (pc: Piece, x: number, y: number, z: number, core = 1) => {
    const k = (1 - core) / 2
    const ex = (pc.max.x - pc.min.x) * k
    const ey = (pc.max.y - pc.min.y) * k
    const ez = (pc.max.z - pc.min.z) * k
    const dx = Math.max(pc.min.x + ex - x, 0, x - pc.max.x + ex)
    const dy = Math.max(pc.min.y + ey - y, 0, y - pc.max.y + ey)
    const dz = Math.max(pc.min.z + ez - z, 0, z - pc.max.z + ez)
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
    // a blast (or the console's) is felt through a piece's middle; a ram or
    // a thrown prop hits the face it meets
    const area = ev.rec.how === 'blast' || ev.rec.how === 'command'
    const core = area ? CORE : 1
    const fall: number[] = []
    for (let i = 0; i < w.pieces.length; i++) {
      if (!a[i]) continue
      const pc = w.pieces[i]
      const d = reach(pc, at.x, at.y, at.z, core)
      if (d > radius) continue
      const f = falloff(d, radius)
      const dmg = power * f
      const r = RESIST[w.grade] * (pc.kind === 'floor' ? 1.4 : 1)
      if (dmg < r * 0.15) continue
      w.hp[i] -= dmg / r
      if (w.hp[i] <= 0) {
        broke.push(i)
        fall.push(f)
      }
    }
    if (!broke.length) return 0
    if (!ev.w.includes(w)) ev.w.push(w)
    lift(w.o, broke)
    noteLift(ev, w, broke)
    makeRoom(broke.length)
    // Out where a blast was weak (SHATTER_F), what it broke leaves as the
    // wall it was: neighbouring pieces of one storey's face go together as
    // one slab rather than as a spray of panels, so the far side of a
    // building a big blast only just reached is not thrown out pre-shattered
    const slabbed = new Set<number>()
    if (area) {
      const far: number[] = []
      broke.forEach((i, k) => {
        if (fall[k] < SHATTER_F) far.push(i)
      })
      for (const comp of faceRuns(w, far)) {
        if (comp.length < 2) continue
        for (const i of comp) slabbed.add(i)
        throwSlab(w, ev, comp, at, dir, throwK)
      }
    }
    for (let bi = 0; bi < broke.length; bi++) {
      const i = broke[bi]
      if (slabbed.has(i)) continue
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
      // out where the blast was weak, the piece goes whole (see SHATTER_F)
      const energy = area && fall[bi] < SHATTER_F ? Math.min(over, 1) : over
      throwPieces(w, ev, [i], v, energy, carried && dir ? tmpA.copy(dir).setLength(1.4) : null, carried ? at.y : undefined)
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

  const damageAt: Destruction['damageAt'] = (at, power, radius, how = 'command', dir, remote = false) => {
    const p = new THREE.Vector3(at.x, at.y, at.z)
    const d = dir ? new THREE.Vector3(dir.x, dir.y, dir.z) : null
    // (measured once: normalised inside the loop, every building after the
    // first was thrown at the minimum)
    const speed = d ? d.length() : 0
    if (d && speed > 1e-3) d.multiplyScalar(1 / speed)
    let n = 0
    for (const s of ruins.near(p.x, p.y, p.z, radius, nearList).slice()) {
      // render and timber is pushed over by a blast rather than fired across
      // the lot as confetti
      const blastK = s.rec.grade === 0 ? 5 : 9
      const k = how === 'blast' ? blastK : Math.max(4, speed * 0.55)
      const ev = newEvent({
        building: s.rec.id, how, x: p.x, y: p.y, z: p.z, power, radius,
        dx: d?.x ?? 0, dy: d?.y ?? 0, dz: d?.z ?? 0, k, ram: false, seed: (rnd() * 0x7fffffff) | 0,
      }, remote)
      n += hurt(s, ev, p, power, radius, d, k)
      announce(ev)
    }
    return n
  }

  const collapseFrom = (s: Standing, from: Vec3Like | undefined, remote: boolean, seed?: number) => {
    const w = wreckOf(s)
    if (!w) return false
    const frac = w.o.frac
    const f = from
      ? new THREE.Vector3(from.x, from.y, from.z)
      : new THREE.Vector3((frac.min.x + frac.max.x) / 2, frac.y0, (frac.min.z + frac.max.z) / 2)
    // the lowest storey with walls in it lets go
    let iy = 0
    while (iy < w.cap0.length && w.cap0[iy] <= 0) iy++
    if (iy >= w.cap0.length || w.failed[iy]) return false
    const ev = newEvent({
      building: s.rec.id, how: 'collapse', x: f.x, y: f.y, z: f.z, power: 0, radius: 0,
      dx: 0, dy: 0, dz: 0, k: 0, ram: false, seed: seed ?? (rnd() * 0x7fffffff) | 0,
    }, remote)
    ev.w.push(w)
    failStorey(w, ev, iy, f)
    sb.solidsChanged()
    announce(ev)
    return true
  }
  const collapse: Destruction['collapse'] = (s, from) => collapseFrom(s, from, false)

  const replay: Destruction['replay'] = (r) => {
    const s = ruins.get(r.building)
    if (!s) return false
    if (r.how === 'collapse') return collapseFrom(s, r, true, r.seed)
    const ev = newEvent({ ...r }, true)
    const dir = r.dx || r.dy || r.dz ? new THREE.Vector3(r.dx, r.dy, r.dz) : null
    hurt(s, ev, new THREE.Vector3(r.x, r.y, r.z), r.power, r.radius, dir, r.k, r.ram)
    return true
  }

  /* -------------------------------------------------- somebody else's -- */

  /** buildings with pieces somebody else lost, and when to catch them up */
  const absorbing: Array<{ t: number; id: string; quiet: boolean }> = []

  const absorb: Destruction['absorb'] = (id, keys, quiet) => {
    if (!keys.length) return
    ruins.mark(id, keys)
    absorbing.push({ t: now + (quiet ? 0 : ABSORB_GRACE), id, quiet })
  }

  /** lift whatever this building has lost elsewhere and still has here */
  const catchUp = (id: string, quiet: boolean) => {
    const s = ruins.get(id)
    const gone = ruins.ruined.get(id)
    // not built here: its chunk lifts the lot when it arms
    if (!s || !gone?.size) return
    if (!s.open) {
      // taken apart a slice at a time like any blow's building, then caught up
      let job = opening.get(s)
      if (!job) opening.set(s, (job = { it: ruins.opening(s, OPEN_SLICE_WORK), then: [] }))
      job.then.push(() => catchUp(id, quiet))
      return
    }
    const w = wreckOf(s)
    if (!w) return
    const list: number[] = []
    for (const key of gone) {
      const i = w.o.byKey.get(key)
      if (i !== undefined && w.o.alive[i]) list.push(i)
    }
    if (!list.length) return
    for (const i of list) w.hp[i] = 0
    lift(w.o, list)
    // a storey that has lost its walls has failed, as it did for whoever
    // brought it down, so a later blow here does not fail it a second time
    for (let iy = 0; iy < w.failed.length; iy++) {
      if (w.failed[iy] || w.cap0[iy] <= 0 || wallVol(w, iy) >= w.cap0[iy] * FAIL[w.grade]) continue
      for (let k = iy; k < w.failed.length; k++) w.failed[k] = 1
      break
    }
    if (!quiet) {
      // what the replay did not get to drops out where it stood
      const ev = newEvent({
        building: id, how: 'collapse', x: 0, y: 0, z: 0, power: 0, radius: 0,
        dx: 0, dy: 0, dz: 0, k: 0, ram: false, seed: (rnd() * 0x7fffffff) | 0,
      }, true)
      ev.w.push(w)
      makeRoom(list.length)
      const comps = components(w, list)
      comps.sort((x, y) => w.pieces[x[0]].min.y - w.pieces[y[0]].min.y)
      for (const comp of comps) spawnLump(w, ev, levelOf(w, comp), comp, null, null, null, 0.4)
      const pc = w.pieces[list[0]]
      tintOf(list.map((i) => w.pieces[i]), tint)
      sb.fx.plume(pc.center, Math.min(8, pc.max.x - pc.min.x + 2), tint[0] * 1.1, tint[1] * 1.08, tint[2] * 1.05)
    }
    sb.solidsChanged()
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

  /** `stalled`: it came to rest standing (or storey-sized) rather than
      landing, and goes over and to pieces under its own weight */
  const breakLump = (L: Lump, e: ImpactEvent, stalled = false) => {
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
      // A panel come to rest on its end is pushed over rather than broken:
      // a storey-high piece of wall stood up in the heap is the thing that
      // reads wrong, and lying down it is rubble. Only one that will not lie
      // down is broken
      if (stalled && L.toppled === undefined) {
        L.toppled = now
        const p = sb.get(L.id)
        if (!p) return
        // its thinnest local axis, flattened: it goes over that way
        const ex = p.extents
        tmpA.set(ex.x <= ex.y && ex.x <= ex.z ? 1 : 0, ex.y < ex.x && ex.y <= ex.z ? 1 : 0, ex.z < ex.x && ex.z < ex.y ? 1 : 0)
          .applyQuaternion(pose.quat)
        tmpA.y = 0
        if (tmpA.lengthSq() < 1e-4) tmpA.set(1, 0, 0)
        tmpA.normalize()
        if (rnd() < 0.5) tmpA.negate()
        // spun about up x n, its top goes toward n
        // (and the heap's thick air taken off it for the fall, or a slab put
        // to rest once turns a few degrees and stops)
        tmpB.set(tmpA.z, 0, -tmpA.x).multiplyScalar(2.4)
        L.settled = false
        L.restAt = undefined
        L.slow = 0
        L.damped = false
        L.landed = -1
        p.body.setLinearDamping(0.12)
        p.body.setAngularDamping(0.3)
        sb.setVelocity(L.id, { x: tmpA.x * 1.2, y: 0.5, z: tmpA.z * 1.2 }, tmpB)
        sb.wake(L.id)
        return
      }
      // A panel lands as the panel it is: only one that would not lie down,
      // or a big one off a falling building landing very hard, splits, and
      // in two (see SHARD_BIG)
      const split = stalled || (!L.thrown && pc.vol >= SHARD_BIG && e.speed >= BREAK_DV[3] * 2)
      if (!split || pc.vol < SHATTER_MIN || !makeRoom(2)) return
      const shards = shatterFrags(pc.frags, (pc.key * 2654435761 + L.ev.rec.seed) >>> 0, 2)
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
    const p = sb.get(L.id)
    if (p && sb.getTransform(L.id, tmpT)) thawOver(tmpT, p.extents)
    lumps.delete(L.id)
    L.ev.live.delete(L.id)
    sb.remove(L.id)
    // (the sandbox's removal only takes the mesh out of the scene: its
    // geometry is this lump's own, and every break used to leak one)
    L.mesh?.userData.dispose?.()
  }

  /** small shards age out, and anything the budget let go shrinks away */
  const age = (L: Lump, h: number) => {
    if (L.going < 0 && L.level === 4 && L.vol < SHARD_VOL && now - L.born > SHARD_LIFE) L.going = 0
    if (L.going < 0) return
    L.going += h
    const k = 1 - L.going / 0.6
    if (L.mesh) L.mesh.scale.setScalar(Math.max(0.01, k))
    if (k <= 0) removeLump(L)
  }

  /**
   * Something rubble may have been lying on has gone (a lump broke up or
   * shrank away, a piece left the building): anything frozen over that box
   * is let go, to fall onto whatever is under it now and be put to rest
   * again. Frozen rubble is a fixed body, and without this it would hang in
   * the air where its support was.
   */
  const thaw = (min: Vec3Like, max: Vec3Like) => {
    for (const L of lumps.values()) {
      if (L.pinned || L.going >= 0) continue
      const p = sb.get(L.id)
      if (!p || p.mode !== 'frozen' || p.data.handled || !sb.getTransform(L.id, tmpT)) continue
      const r = Math.max(p.extents.x, p.extents.y, p.extents.z) + 0.3
      if (tmpT.x < min.x - r || tmpT.x > max.x + r || tmpT.z < min.z - r || tmpT.z > max.z + r ||
        tmpT.y < min.y || tmpT.y > max.y + 2 * r) continue
      sb.unfreeze(L.id)
      sb.wake(L.id)
      // it falls as rubble does, not at the settled crawl, and is put to
      // rest again by the same rules once it has found its feet
      L.settled = false
      L.restAt = undefined
      L.landed = -1
      L.slow = 0
      L.woke = now
    }
  }
  const thawMin = new THREE.Vector3()
  const thawMax = new THREE.Vector3()
  const thawOver = (at: THREE.Vector3, e: Vec3Like) => {
    thawMin.set(at.x - e.x, at.y - e.y, at.z - e.z)
    thawMax.set(at.x + e.x, at.y + e.y, at.z + e.z)
    thaw(thawMin, thawMax)
  }
  const tmpT = new THREE.Vector3()

  /** pieces leave a building, and whatever lay on them is let go */
  const lift = (o: Opened, list: readonly number[]) => {
    ruins.lift(o, list)
    for (const i of list) thaw(o.frac.pieces[i].min, o.frac.pieces[i].max)
  }

  /* ------------------------------------------------------ the hooks -- */

  const offImpact = sb.onImpact((e) => {
    const L = lumps.get(e.id)
    if (L && L.landed < 0 && (e.with === 'ground' || e.with === 'prop' || e.with === 'solid')) {
      // first contact: the air thickens for it from here on, so it gives up
      // its energy in the heap instead of bouncing round it
      L.landed = now
      const p = e.prop
      if (!p.data.handled) {
        p.body.setLinearDamping(0.5)
        p.body.setAngularDamping(1.2)
      }
    }
    // a slab on its edge breaks on any real landing, a whole storey too
    // (what a blow threw out whole lands whole: see throwPieces, throwSlab)
    if (L && L.level < 4 && !L.thrown && !breakQueue.some((q) => q.L === L) && e.speed > 2.5 && now - L.born > 0.08 &&
      now - L.born < 8 && (L.level === 1 || upright(L))) {
      breakQueue.push({ L, e, at: now })
      return
    }
    if (L) {
      // a collapse is over some seconds after it began: from then on only a
      // real blow breaks rubble, not the heap shuffling itself
      // (a thrown slab still breaks against a wall; a slab the solver
      // pinched in the heap at twenty units a second does not)
      const late = now - L.born > 6 ? 4 : now - L.ev.rec.t > 7 || now - L.born > 4 ? 2.5 : 1
      // and a panel shatters on its landing or not at all
      if (L.level === 3 && now - L.born > 3) return
      const dv = (L.section ? 5 : BREAK_DV[L.level]) * late
      if (L.level < 4 && !L.thrown && e.speed > dv && now - L.born > 0.08 && !breakQueue.some((q) => q.L === L)) {
        breakQueue.push({ L, e, at: now })
      }
    }
    // anything heavy hitting a building's solid damages it: a thrown block,
    // a falling storey, the car's hull when it is a prop
    if (e.with === "solid" && e.solid && e.speed > 6) {
      const own = ruins.owner(e.solid)
      if (!own) return
      const lump = lumps.get(e.id)
      // somebody else's rubble is a show here: what it broke where it was
      // real arrives as that peer's own record. And a prop another client
      // simulates is that client's to hit things with
      if (lump ? lump.ev.remote : !sb.isAuthority(e.id)) return
      // rubble smaller than a wall section does not bring the next building
      // down, or one tower takes the whole of downtown with it
      // (nor does anything a blast threw out: that is the blast's damage)
      if (lump && (lump.thrown || lump.level > (lump.w.s === own.s ? 2 : 1))) return
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
  /** heavy things flying at a building, and their velocity each slice */
  const watch = new Set<PropId>()
  const flying = new Map<PropId, THREE.Vector3>()
  const offWatch = sb.onBeforeSlice(() => {
    for (const id of watch) {
      const p = sb.get(id)
      if (!p) {
        watch.delete(id)
        flying.delete(id)
        continue
      }
      const v = p.body.linvel()
      if (Math.hypot(v.x, v.y, v.z) < 4) {
        watch.delete(id)
        flying.delete(id)
        continue
      }
      let f = flying.get(id)
      if (!f) flying.set(id, (f = new THREE.Vector3()))
      f.set(v.x, v.y, v.z)
    }
  })
  const rams = new Map<PropId, { s: Standing; dmg: number; r: number; until: number; speed: number; dir: THREE.Vector3 }>()

  const offBlast = sb.onExplosion((e) => {
    // a blast may move settled rubble again: what it pushes is not the heap
    // arguing with itself
    for (const L of lumps.values()) {
      if (!L.settled || !sb.getTransform(L.id, tmpA)) continue
      const d = tmpA.distanceTo(tmpB.set(e.x, e.y, e.z))
      if (d >= e.radius) continue
      L.settled = false
      L.restAt = undefined
      L.landed = -1
      L.damped = false
      const p = sb.get(L.id)
      if (!p || p.data.handled) continue
      // rubble held where it lay is let go and thrown like any prop (the
      // blast itself skipped it, being frozen when it went off)
      p.body.setLinearDamping(0.12)
      p.body.setAngularDamping(0.6)
      if (p.mode === 'frozen') {
        sb.unfreeze(L.id)
        const k = 26 * Math.min(1.6, e.power) * falloff(d, e.radius)
        tmpA.sub(tmpB)
        tmpA.y = Math.max(tmpA.y, 0) + tmpA.length() * 0.5
        tmpA.setLength(k)
        sb.setVelocity(L.id, tmpA, { x: (rnd() - 0.5) * 6, y: (rnd() - 0.5) * 6, z: (rnd() - 0.5) * 6 })
      }
      sb.wake(L.id)
    }
    damageAt(e, 70 * e.power, e.radius * 0.8, 'blast', undefined, e.remote)
  })

  const offRemove = sb.onRemove((p: Prop) => {
    const L = lumps.get(p.id)
    if (!L) return
    stats.lost++
    lumps.delete(p.id)
    L.ev.live.delete(p.id)
    L.mesh?.userData.dispose?.()
    const t = p.body.translation()
    thawOver(tmpT.set(t.x, t.y, t.z), p.extents)
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
    // what somebody else's buildings lost, once the grace for our own
    // replay of it has run out
    for (let k = 0; k < absorbing.length;) {
      const a = absorbing[k]
      if (a.t > now) {
        k++
        continue
      }
      absorbing.splice(k, 1)
      catchUp(a.id, a.quiet)
    }
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
        if (own) watch.add(p.id)
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
      // better than the guess from the face: what it was doing the slice
      // before it hit, when it was one of the fast heavy things watched
      const before = flying.get(e.id)
      if (before) vPre.copy(before)
      // rubble landing on a building waits for it to be opened like a blast
      // does; a thrown prop is a ram and cannot (see `ahead` below)
      const ram = !lumps.has(e.id)
      const fly = vPre.lengthSq() > 1
      const ev = newEvent({
        building: s.rec.id, how: 'impact', x: e.x, y: e.y, z: e.z, power: dmg, radius: r,
        dx: fly ? vPre.x : 0, dy: fly ? vPre.y : 0, dz: fly ? vPre.z : 0, k: 1, ram, seed: (rnd() * 0x7fffffff) | 0,
      })
      const broke = hurt(s, ev, tmpV.set(e.x, e.y, e.z), dmg, r, fly ? vPre.clone() : null, 1, ram)
      announce(ev)
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
        dx: ram.dir.x * ram.speed, dy: ram.dir.y * ram.speed, dz: ram.dir.z * ram.speed, k: 1, ram: true,
        seed: (rnd() * 0x7fffffff) | 0,
      })
      const broke = hurt(ram.s, ev, tmpA.clone(), ram.dmg, ram.r, ram.dir.clone().multiplyScalar(ram.speed), 1, true)
      if (broke) {
        announce(ev)
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
      // frozen where it lies: nothing below is its business but its age
      if (sb.get(L.id)?.mode === 'frozen') {
        age(L, h)
        continue
      }
      // settled rubble stays down. Falling is not being flung: a piece
      // whose footing went (a slab slid off, a shard shrank away) drops at
      // the speed things drop, not at the settled crawl, which used to
      // lower it through the air like a lift
      if (L.settled && sb.getVelocity(L.id, vIn, tmpB)) {
        const fall = Math.min(0, vIn.y)
        vIn.y -= fall
        const sp = vIn.length()
        if (sp > SETTLED_CAP || tmpB.length() > 2) {
          const p = sb.get(L.id)
          if (p && !p.data.handled && p.mode === 'dynamic') {
            stats.settledMax = Math.max(stats.settledMax, sp)
            if (sp > SETTLED_CAP) vIn.setLength(SETTLED_CAP)
            if (tmpB.length() > 2) tmpB.setLength(2)
            vIn.y += fall
            sb.setVelocity(L.id, vIn, tmpB)
          }
        }
      }
      if (L.landed >= 0 && !L.damped && now - L.landed > 2) {
        // two seconds after it first touched down it is in the heap for good
        const p = sb.get(L.id)
        if (p && !p.data.handled && p.mode === 'dynamic') {
          L.damped = true
          p.body.setLinearDamping(1.2)
          p.body.setAngularDamping(2.5)
        }
      }
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
      // (a side is a slab, and a slab lying whole on the heap is rubble:
      // only a storey or more is a box that has no business being intact)
      if (!stalled && L.level <= 3 && (L.toppled === undefined || now - L.toppled > 1.5) &&
        ((L.level <= 1 && L.vol > 40) || upright(L)) &&
        now - L.born > 1 && now - L.born < 6 && !sb.get(L.id)?.data.handled &&
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
      age(L, h)
    }
    // Rubble is put to sleep once it is only crawling. Rapier sleeps a body
    // whose whole island is still, and a heap of a hundred hulls is one
    // island in which something is always creeping a millimetre, so the
    // heap never sleeps and costs a full solve every slice for as long as it
    // lies there. Anything that has crawled for most of a second is done
    if ((settleClock += h) >= 0.25) {
      settleClock = 0
      // A piece the heap has pressed into the street is pinned there. A heightfield has no
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
          // pinned where it is, half in the dirt. Never moved back up: a
          // piece teleported onto the heap is born inside its neighbours,
          // and that is what threw shards over the rooftops seconds after
          // the tower came down. One wholly under the street is gone
          sb.setVelocity(L.id, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
          if (tmpA.y + Math.max(p.extents.x, p.extents.y, p.extents.z) < g) {
            if (L.going < 0) L.going = 0
          } else sb.freeze(L.id)
          L.settled = true
          L.pinned = true
        }
      }
      for (const L of lumps.values()) {
        const p = sb.get(L.id)
        if (!p || p.mode !== 'dynamic' || now - L.born < 1) continue
        if (p.body.isSleeping()) {
          // asleep is at rest, however it got there
          if (!L.settled && !p.data.handled) {
            L.settled = true
            L.restAt = now
          }
          continue
        }
        sb.getVelocity(L.id, vIn, tmpB)
        if (vIn.lengthSq() < 2 * 2 && tmpB.lengthSq() < 1.2 * 1.2) L.slow++
        else L.slow = 0
        if (p.data.handled) continue
        // Put to rest a second and a half ago and still awake: it is jammed
        // (against a wall still standing, under a slab, in a knot of shards
        // the solver keeps prising apart at a fraction of a unit a second).
        // It is held where it lies, as the rubble of a real ruin would be;
        // the physgun can still pick it up
        // (at the settled cap or under it, and not falling)
        if (L.settled && L.restAt !== undefined && now - L.restAt > 1.5 && vIn.y > -1.5 &&
          vIn.lengthSq() < (SETTLED_CAP + 0.5) ** 2) {
          sb.setVelocity(L.id, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
          sb.freeze(L.id)
          continue
        }
        // two seconds in the heap is long enough for anything to have
        // found where it lies (and one let go again by `thaw` gets a second
        // to fall before the clock that was running on it applies)
        const inHeap = L.landed >= 0 && now - L.landed > 2
        const fresh = L.woke !== undefined && now - L.woke < 1
        // (never in the air: a body put to sleep falling hangs there)
        if (L.slow >= 2 || (!fresh && (now - L.born > 6 || inHeap) && vIn.y > -1.5 && vIn.lengthSq() < 6 * 6)) rest(p.body)
        else if (now - L.born > 5 && !L.damped && !p.data.handled) {
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
        if (stalled.level !== 0 || stalled.section || !pancake(stalled, pose, e)) breakLump(stalled, e, true)
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
    onRecord: null,
    replay,
    absorb,
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
      offWatch()
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
