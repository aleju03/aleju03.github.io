import * as THREE from 'three'
import { seeded } from '../core/rand'
import { createTumbler, type TumbleEnv, type Tumbler } from '../physics/tumble'
import type { Solid } from '../physics/collision'
import { PREBORN } from './fade'

/*
  What happens when a car drives through a tree.

  A chunk is one merged vertex soup per material (chunk.ts), which is what
  makes a forest three draw calls — and also what makes "remove that one
  tree" a question with no obvious answer. There is no object to hide: a pine
  is a run of vertices somewhere in the middle of a few thousand of them. So
  this module works in *spans*. The chunk builder reads its builders' vertex
  and index counters either side of every stamp it makes and hands over the
  ranges; breaking a prop then means copying that range out into a small
  standalone geometry, and collapsing the range it came from onto a single
  point so every triangle that used it is degenerate and rasterizes nothing.
  No rebuild, no index surgery, one partial buffer upload of a few hundred
  vertices — cheap enough to do at forty units a second.

  The debris that comes out is a rigid rod (physics/tumble.ts, which is the
  player's ragdoll with the skeleton taken out) with the copied geometry hung
  on it, thrown by whatever hit it. A trunk, a cactus and a lamp post are all
  axisymmetric sticks, so two particles and one distance constraint is the
  whole simulation, and the mesh follows by rotating +y onto the rod.

  Three policies worth naming:

  - **Session state, not world state.** The world is a pure function of
    coordinates, so a rebuilt chunk grows its trees back. The set of
    flattened props is kept here by a position-stable id and re-applied when
    a chunk is armed, exactly the way world/shopDoors.ts keeps a door you
    left ajar. A reload replants the forest.
  - **Debris collides with the world, not the other way round.** The rod is
    pushed out of the collision set but registers no box of its own, like the
    ragdoll. A felled trunk is scenery you drive over, and a box list that
    changes shape every frame is a cost the walk pays on every solid it
    scans.
  - **The pool is capped and the oldest goes first.** Fourteen bodies is more
    than anyone has on screen at once, and a session that flattens a forest
    must not accumulate a geometry per tree.

  The materials are the chunk's own, taken off the mesh the vertices came
  from, so nothing new is ever compiled — a program linked mid-drive is the
  one stall this scene cannot hide (see the root CLAUDE.md).
*/

/** which of a chunk's merged meshes a span lives in */
export type SmashLayer = 'detail' | 'leaf' | 'glass'

/** a stamp's footprint in one merged mesh: first vertex, vertex count, first
    index, index count. Contiguous because a stamp is a run of consecutive
    `MeshBuilder.add` calls into one builder */
export type Span = [number, number, number, number]

/** one prop a vehicle can knock out of the world */
export interface Smashable {
  /** position-stable across rebuilds: the chunk key and the prop's ordinal
      in the chunk's own build order, which is a pure function of (cx, cz) */
  id: string
  /** the solid standing for it, emptied when it goes */
  box: Solid
  /** closing speed that carries it away, units/s */
  limit: number
  /** the foot of it, world space: the debris' own origin and its pivot */
  x: number
  y: number
  z: number
  /** how thick it is at the foot — the collision cylinder's own radius */
  r: number
  /** ...and at the far end, which is what holds a felled body off the ground
      there: a crown props a trunk up at a real angle, a lamp head does not.
      The builder says, because only the builder knows which it made — measured
      off the geometry, a lamp's arm reads as two units of "crown". How *long*
      it is is measured, though (`measure`): a kit's nominal height is a
      keep-out figure and stands well over where the tree actually ends */
  rTop: number
  spans: Partial<Record<SmashLayer, Span>>
}

/** everything in one chunk that can be knocked down, plus the meshes their
    vertices live in. Built by chunk.ts, handed here once per chunk build */
export interface SmashSet {
  key: string
  meshes: Partial<Record<SmashLayer, THREE.Mesh>>
  props: Smashable[]
}

export interface DebrisHandles {
  /** a chunk has just been built: arm its props, and re-flatten anything
      this session already flattened there */
  arm: (set: SmashSet) => void
  /** advance every body still moving; call once per rendered frame */
  update: (dt: number) => void
  /** drop the lot (teardown) */
  clear: () => void
}

interface Opts {
  /** what the debris is parented to — the world root, not a chunk group:
      a body outlives the chunk it was cut out of */
  parent: THREE.Object3D
  /** the shared obstacle list the rod is pushed out of */
  obstacles: Solid[]
  groundAt: (x: number, z: number) => number
  /** the snap, as a callback: this module must stay importable headless and
      core/sfx reaches for an AudioContext at module load */
  onSnap?: (hard: number) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

/** how many bodies live at once; the oldest is retired to make room */
const POOL = 14
/** attributes carried across into a debris geometry. `aSway` is deliberately
    not one of them — wind bends what is rooted in the ground, and this no
    longer is, so it is rewritten to zero */
const CARRY = ['normal', 'color', 'aSurf', 'uv'] as const

const UP = new THREE.Vector3(0, 1, 0)

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

interface Body {
  group: THREE.Group
  geos: THREE.BufferGeometry[]
  rod: Tumbler
}

/**
 * Copy one span out of a merged geometry, re-based on the prop's own foot so
 * the result can be rotated about it.
 */
const cut = (
  src: THREE.BufferGeometry, span: Span, ox: number, oy: number, oz: number,
) => {
  const [v0, vn, i0, ic] = span
  const out = new THREE.BufferGeometry()
  const pos = src.getAttribute('position')
  const p = new Float32Array(vn * 3)
  for (let i = 0; i < vn; i++) {
    p[i * 3] = pos.getX(v0 + i) - ox
    p[i * 3 + 1] = pos.getY(v0 + i) - oy
    p[i * 3 + 2] = pos.getZ(v0 + i) - oz
  }
  out.setAttribute('position', new THREE.BufferAttribute(p, 3))
  for (const name of CARRY) {
    const a = src.getAttribute(name)
    if (!a) continue
    const n = a.itemSize
    const dst = new Float32Array(vn * n)
    for (let i = 0; i < vn; i++)
      for (let k = 0; k < n; k++) dst[i * n + k] = (a.array as ArrayLike<number>)[(v0 + i) * n + k]
    out.setAttribute(name, new THREE.BufferAttribute(dst, n))
  }
  out.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(vn), 1))
  // ...and it is not arriving, either: a chunk's dissolve-in (world/fade.ts)
  // is keyed on a birth stamp the shared material always reads, so debris
  // that skipped the attribute would be at the mercy of whatever the generic
  // vertex attribute happened to hold
  out.setAttribute(
    'aBirth', new THREE.BufferAttribute(new Float32Array(vn).fill(PREBORN), 1),
  )
  const idx = src.getIndex()
  if (idx) {
    const oi = new Uint32Array(ic)
    for (let i = 0; i < ic; i++) oi[i] = idx.getX(i0 + i) - v0
    out.setIndex(new THREE.BufferAttribute(oi, 1))
  }
  out.computeBoundingSphere()
  return out
}

/**
 * How long the thing that just broke actually is — read off the geometry
 * rather than taken from the kit, whose `height` is the keep-out figure the
 * scatterer uses and stands a couple of units over the crown. The rod has to
 * match what is drawn on it or a felled trunk floats.
 */
const measure = (geos: THREE.BufferGeometry[], rFoot: number) => {
  let h = 0
  for (const g of geos) {
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) h = Math.max(h, p.getY(i))
  }
  return Math.max(h, rFoot * 2)
}

/**
 * Collapse a span onto its own first vertex. Every triangle in it is now
 * degenerate, which draws nothing — and costs one partial upload rather than
 * a rebuilt index or a rebuilt chunk.
 */
const collapse = (src: THREE.BufferGeometry, span: Span) => {
  const [v0, vn] = span
  const pos = src.getAttribute('position') as THREE.BufferAttribute
  const a = pos.array as Float32Array
  const x = a[v0 * 3]
  const y = a[v0 * 3 + 1]
  const z = a[v0 * 3 + 2]
  for (let i = v0; i < v0 + vn; i++) {
    a[i * 3] = x
    a[i * 3 + 1] = y
    a[i * 3 + 2] = z
  }
  pos.addUpdateRange(v0 * 3, vn * 3)
  pos.needsUpdate = true
}

export function buildDebris(opts: Opts): DebrisHandles {
  const { parent, obstacles, groundAt, onSnap, trackDisposable } = opts

  const root = new THREE.Group()
  root.userData.dynamic = true
  parent.add(root)

  /** props already flattened this session, by id. A chunk rebuilt after a
      tier change or a trip out of the ring re-applies these on arm */
  const gone = new Set<string>()
  const bodies: Body[] = []
  const rnd = seeded(0x2b17)
  const env: TumbleEnv = {
    groundAt,
    // the same array the world streams into; bounds are the walker's clamp
    // and mean nothing to a flying trunk
    collision: { boxes: obstacles, bounds: { minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9 } },
  }

  const axis = new THREE.Vector3()

  const fit = (b: Body) => {
    axis.subVectors(b.rod.b, b.rod.a)
    const len = axis.length()
    if (len > 1e-4) {
      axis.multiplyScalar(1 / len)
      b.group.quaternion.setFromUnitVectors(UP, axis)
    }
    b.group.position.copy(b.rod.a)
  }

  const retire = (b: Body) => {
    root.remove(b.group)
    for (const g of b.geos) g.dispose()
  }

  /** lift a prop out of its chunk and throw it. The contact point the
      Breakable contract reports is not needed here — a prop pivots on the
      foot it was stamped at, wherever it was struck */
  const launch = (s: Smashable, set: SmashSet, dx: number, dz: number, speed: number) => {
    gone.add(s.id)
    s.box.breaks = undefined
    s.box.makeEmpty()

    /*
      Where the rod's near end goes, and it is not the foot of the prop.

      The ends are spheres of radius `r` to the tumbler, so an end sitting on
      the ground plane is an end already a radius deep in it — and the first
      substep resolves that by lifting it, which the distance constraint
      answers by shoving the far end up by half as much, every pass, forever.
      A felled broadleaf climbed fourteen units doing this. Starting the near
      end a radius up costs nothing because the geometry is re-based on the
      same point: the mesh still draws exactly where the tree grew.
    */
    const footY = Math.max(s.y, groundAt(s.x, s.z)) + s.r
    const group = new THREE.Group()
    group.userData.dynamic = true
    const geos: THREE.BufferGeometry[] = []
    for (const layer of Object.keys(s.spans) as SmashLayer[]) {
      const span = s.spans[layer]
      const mesh = set.meshes[layer]
      if (!span || !mesh) continue
      const geo = cut(mesh.geometry, span, s.x, footY, s.z)
      geos.push(geo)
      const m = new THREE.Mesh(geo, mesh.material)
      m.castShadow = mesh.castShadow
      m.receiveShadow = mesh.receiveShadow
      if (mesh.customDepthMaterial) m.customDepthMaterial = mesh.customDepthMaterial
      group.add(m)
      collapse(mesh.geometry, span)
    }
    if (!geos.length) return

    /*
      The throw. A car catches a trunk at bumper height, well under its
      centre, so the foot is shoved and the far end whips over the top of it
      — which is both what actually happens and the only launch that reads as
      a hit rather than as a plank sliding through the air. The tip therefore
      leaves faster than the foot and with a lift on it, and a little
      sideways scatter keeps two identical saplings from folding identically.

      Both ends get some of that lift, though, and the reason is the ground
      rather than the physics: a foot left on the surface is in contact from
      the first substep, and contact grip eats a planar throw almost
      instantly — the prop pivoted over its own stump and went nowhere. It
      has to leave the ground to travel.
    */
    const h = measure(geos, s.r)
    // ...and how much of it the hit is worth. Length stands in for mass here,
    // scaled off a lamp post: a four-unit cactus leaves like a football, a
    // fourteen-unit broadleaf topples and slides. Without the term the same
    // impact cartwheeled a mature tree twice across the road, which reads as
    // a prop with no weight in it rather than as a hard hit
    const heft = clamp(6 / h, 0.5, 1.3)
    const k = Math.min(speed, 34) * 0.5 * heft
    const sx = (rnd() - 0.5) * 0.35
    const sz = (rnd() - 0.5) * 0.35
    const va = new THREE.Vector3(dx * k * 0.55, k * 0.3, dz * k * 0.55)
    const vb = new THREE.Vector3(
      (dx + sx) * k * 1.3, k * (0.35 + rnd() * 0.2), (dz + sz) * k * 1.3,
    )
    const rod = createTumbler({
      a: new THREE.Vector3(s.x, footY, s.z),
      b: new THREE.Vector3(s.x, footY + h, s.z),
      ra: s.r,
      rb: s.rTop,
      va,
      vb,
    })
    const body: Body = { group, geos, rod }
    fit(body)
    root.add(group)
    bodies.push(body)
    if (bodies.length > POOL) retire(bodies.shift() as Body)
    onSnap?.(Math.min(1, speed / 26))
  }

  const handles: DebrisHandles = {
    arm: (set) => {
      for (const s of set.props) {
        if (gone.has(s.id)) {
          // it was flattened before this chunk was last rebuilt: put it back
          // the way the player left it, without the debris (which is still
          // lying where it fell, or has been retired out of the pool)
          s.box.makeEmpty()
          for (const layer of Object.keys(s.spans) as SmashLayer[]) {
            const span = s.spans[layer]
            const mesh = set.meshes[layer]
            if (span && mesh) collapse(mesh.geometry, span)
          }
          continue
        }
        s.box.breaks = {
          limit: s.limit,
          hit: (_x, _y, _z, dx, dz, speed) => launch(s, set, dx, dz, speed),
        }
      }
    },
    update: (dt) => {
      for (const b of bodies) {
        if (b.rod.asleep) continue
        b.rod.step(dt, env)
        fit(b)
      }
    },
    clear: () => {
      for (const b of bodies) retire(b)
      bodies.length = 0
    },
  }
  // every debris geometry is made at runtime, so the scene's disposer cannot
  // have been handed them at build time: it is handed the pool instead
  trackDisposable({ dispose: handles.clear })
  return handles
}
