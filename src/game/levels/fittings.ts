import * as THREE from 'three'
import { seeded } from '../core/rand'
import { propSnap } from '../core/sfx'

/*
  The furniture that works: every cupboard, drawer, wardrobe and appliance
  door in the house, on the same interact key as the room doors.

  The models already ship the parts. Nearly every GLB in public/os/models
  carries its leaves as separate nodes: `doorLeft`/`doorRight` on the
  fridge and the TV cabinet, a plain `door` on each kitchen carcass and the
  oven, `washerDoor`, `Closet_*Door`, `Desk_Drawer1..4`, all of them modelled shut and
  baked into the case's own coordinate frame. So a working door is not new
  geometry, it is a pivot: this module lifts the leaf node out of the model
  (`Group.attach`, which preserves its world transform), re-parents it under
  a group standing on its hinge line, and eases that group open the way
  houseWorld eases the room doors.

  Three things it has to solve that the room doors did not.

  **Which edge the hinge is on.** A leaf node has no pivot to read, since the
  transforms are identity and the geometry is baked in place, so the hinge
  is derived from the placed world box: the vertical edge further from the
  carcass's centre for a pair, an explicit side for a single leaf. The swing
  direction is then solved numerically rather than by enumerating facings,
  exactly as `world/shopDoors.ts` does: `k` is the sign of d(tip · facing)/dθ
  at rest, so the leaf always opens *outward* whatever the piece's yaw. An
  oven flap is the same solve rotated onto the lateral axis, and it needs no
  sign at all: for l = (fz, -fx) a positive angle always tips the top out and
  down, which is a door falling open.

  **What is behind it.** These carcasses are shells with no inside, so a door
  that opened onto the model alone would reveal the back of its own front
  panel. Each openable may declare a `cavity`, and this module builds one: a
  back-sided box (its near wall is front-facing from out here, so it culls
  and you look straight in), shelves, and a little stock. It stays hidden
  until the leaf actually moves, so a shut kitchen costs nothing.

  **Light, without a light.** An open fridge has to glow, and a real
  PointLight would change NUM_POINT_LIGHTS and relink every material in the
  room the first time somebody opened it, the trap CLAUDE.md names for the
  car's headlamps. So the interior is lit the way the house lights its
  ceiling domes: emissive materials, ramped with the door angle. Nothing
  joins the light rig, so nothing recompiles.

  No collision is registered. A leaf is thin, it stands open for a few
  seconds, and an AABB that appeared in front of the player mid-reach would
  shove them out of their own kitchen.
*/

/** how a leaf gets out of the way */
export type FittingMotion =
  /** side-hinged: swings about a vertical edge (cupboards, wardrobes) */
  | 'swing'
  /** bottom-hinged: drops forward about its own sill (the oven) */
  | 'drop'
  /** slides straight out along the piece's facing */
  | 'slide'

export interface CavitySpec {
  /** how far back the interior runs from the mouth */
  depth: number
  /** shelves inside, evenly spaced between floor and roof */
  shelves?: number
  /** items scattered over them */
  stock?: number
  /** interior shell colour */
  tint?: string
  /** brightness of the bulb that comes on with the door, 0..1 */
  lit?: number
  /** deterministic per piece, so a fridge is stocked the same every load */
  seed?: number
}

export interface FittingSpec {
  /** the leaf node, already placed in the world by houseWorld's `put` */
  node: THREE.Object3D
  /** what the prompt calls it: "the freezer", "the oven" */
  label: string
  /** the outward facing of the piece it belongs to: world, cardinal, unit */
  fx: number
  fz: number
  /** the whole piece's placed box; the auto hinge measures against it */
  piece: THREE.Box3
  motion?: FittingMotion
  /**
    Which side the hinge is on, seen from outside the piece. 'auto' takes the
    edge further from the carcass centre, which is right for a pair of doors
    and meaningless for a single one.
  */
  hinge?: 'auto' | 'left' | 'right'
  /** how far it opens: radians for a swing or drop, units for a slide */
  travel?: number
  cavity?: CavitySpec
}

/**
 * Which way a piece faces, read off its own leaves rather than declared.
 *
 * The GLBs come from three different exporters and disagree about which way
 * a model's front is; the one thing they all agree on is that a door is on
 * it. So the facing is the horizontal component of (mean leaf centre −
 * carcass centre), snapped to the nearest cardinal. Taking the *mean* is
 * what makes a pair work: the two leaves sit either side of the middle, so
 * their lateral offsets cancel and only the forward one survives.
 */
export const facingOf = (piece: THREE.Box3, leaves: THREE.Object3D[]) => {
  const mid = piece.getCenter(new THREE.Vector3())
  const sum = new THREE.Vector3()
  const b = new THREE.Box3()
  for (const leaf of leaves) {
    leaf.updateWorldMatrix(true, true)
    sum.add(b.setFromObject(leaf).getCenter(new THREE.Vector3()))
  }
  sum.divideScalar(Math.max(1, leaves.length)).sub(mid)
  return Math.abs(sum.x) > Math.abs(sum.z)
    ? { fx: Math.sign(sum.x) || 1, fz: 0 }
    : { fx: 0, fz: Math.sign(sum.z) || 1 }
}

export interface FittingPrompt {
  verb: 'open' | 'close'
  label: string
}

export interface FittingHandles {
  add: (spec: FittingSpec) => void
  /** ease every leaf toward its target; true while any of them is moving */
  update: (dt: number) => boolean
  /** the leaf within reach the player is looking at: verb and what it is */
  prompt: (p: THREE.Vector3, gaze: THREE.Vector3) => FittingPrompt | null
  /** work it. Returns false when nothing was in reach */
  use: (p: THREE.Vector3, gaze: THREE.Vector3) => boolean
  /** the pivots have to survive houseWorld's post-furnish matrix freeze */
  unfreeze: () => void
}

interface Opts {
  parent: THREE.Object3D
  trackDisposable: (d: { dispose: () => void }) => void
}

/** a quarter turn and a bit: far enough that the mouth reads as open */
const SWING = Math.PI * 0.55
/** an oven flap stops level, not past it */
const DROP = Math.PI * 0.47
/**
 * Reach: how far the player may *stand* from the piece, squared, measured on
 * the floor the way the room doors measure it. It is deliberately planar. A
 * cupboard door under a worktop sits a good 2.8 units below the eye, so a
 * straight-line reach generous enough to take in the bottom of the kitchen
 * run would be five units across the room at head height.
 */
const REACH2 = 3.0 * 3.0
/** and how far above or below the eye a handle may be and still be in reach */
const RISE = 3.3
/**
 * How far off the middle of the view a handle may sit and still be meant.
 * Loose, because this cone is measured in three dimensions and a base unit's
 * door is a good two and a half units below the eye: at a comfortable
 * standing distance a level gaze is already forty degrees off it.
 */
const AIM = 0.44

/** one emissive surface inside a cavity, and how it answers the door */
interface Glow {
  mat: THREE.MeshStandardMaterial
  base: number
  gain: number
}

interface Cavity {
  group: THREE.Group
  glows: Glow[]
}

interface Fitting {
  spec: FittingSpec
  pivot: THREE.Group
  /** where the pivot stands when shut; a slide travels from here */
  home: THREE.Vector3
  motion: FittingMotion
  /** rotation axis for a swing or drop, travel direction for a slide */
  axis: THREE.Vector3
  /** signed radians, or units, at fully open */
  travel: number
  /** where the geometry says this leaf is centred, shut */
  cx: number
  cy: number
  cz: number
  /** what the player aims at: that centre pushed out onto the piece's face,
      which is where the handle is and where a drawer buried in its carcass
      would otherwise lose every argument with the door under it */
  ax: number
  ay: number
  az: number
  /** 0 shut .. 1 open */
  open: number
  target: 0 | 1
  cavity: Cavity | null
}

export function buildFittings({ parent, trackDisposable }: Opts): FittingHandles {
  const group = new THREE.Group()
  group.userData.dynamic = true
  parent.add(group)
  const items: Fitting[] = []

  const box = new THREE.Box3()
  const size = new THREE.Vector3()
  const centre = new THREE.Vector3()
  const pieceMid = new THREE.Vector3()

  const add = (spec: FittingSpec) => {
    const motion = spec.motion ?? 'swing'
    const f = new THREE.Vector3(spec.fx, 0, spec.fz).normalize()
    // the lateral axis. Facing the piece from outside, the viewer's right is -l
    const l = new THREE.Vector3(f.z, 0, -f.x)

    spec.node.updateWorldMatrix(true, true)
    box.setFromObject(spec.node)
    box.getSize(size)
    box.getCenter(centre)
    spec.piece.getCenter(pieceMid)
    // the leaf's extents resolved onto the piece's own frame
    const spread = (v: THREE.Vector3) => Math.abs(size.x * v.x) + Math.abs(size.z * v.z)
    const wl = spread(l)
    const wf = spread(f)
    const pieceDepth =
      Math.abs((spec.piece.max.x - spec.piece.min.x) * f.x) +
      Math.abs((spec.piece.max.z - spec.piece.min.z) * f.z)

    // which vertical edge carries the hinge. A pair reads it off the piece:
    // each leaf hangs from the side it already sits nearer to
    const off = centre.clone().sub(pieceMid).dot(l)
    const side =
      spec.hinge === 'left' ? 1 : spec.hinge === 'right' ? -1 : Math.sign(off) || -1

    // the hinge line: the outer edge, at the back of the leaf so it clears
    // the carcass as it comes round
    const hinge =
      motion === 'drop'
        ? new THREE.Vector3(centre.x, box.min.y, centre.z).addScaledVector(f, -wf / 2)
        : centre
            .clone()
            .addScaledVector(l, side * (wl / 2))
            .addScaledVector(f, -wf / 2)

    const pivot = new THREE.Group()
    pivot.userData.dynamic = true
    pivot.position.copy(hinge)
    group.add(pivot)
    pivot.updateWorldMatrix(true, false)
    pivot.attach(spec.node) // keeps the leaf exactly where it was placed

    /*
      Which way it opens, solved rather than tabulated. Rotating a vector v
      about +Y by θ moves it at (v.z, 0, -v.x) per radian, so the sign that
      sends the leaf's free edge *outward* is sign(tip.z·fx - tip.x·fz).
    */
    let axis: THREE.Vector3
    let travel: number
    if (motion === 'swing') {
      const tip = l.clone().multiplyScalar(-side * wl)
      const k = Math.sign(tip.z * f.x - tip.x * f.z) || 1
      axis = new THREE.Vector3(0, 1, 0)
      travel = k * (spec.travel ?? SWING)
    } else if (motion === 'drop') {
      axis = l.clone()
      travel = spec.travel ?? DROP
    } else {
      axis = f.clone()
      // far enough out to be a drawer you could reach into, short enough
      // that it never clears its own runners
      travel = spec.travel ?? Math.max(0.3, pieceDepth * 0.55)
    }

    // the aim point: the leaf's centre slid forward onto the carcass's own
    // face (the support of the piece's box along f)
    const front = Math.max(
      f.x * spec.piece.min.x + f.z * spec.piece.min.z,
      f.x * spec.piece.max.x + f.z * spec.piece.max.z,
    )
    const aim = centre.clone().addScaledVector(f, front - (centre.x * f.x + centre.z * f.z))

    const fit: Fitting = {
      spec,
      pivot,
      home: hinge.clone(),
      motion,
      axis,
      travel,
      cx: centre.x,
      cy: centre.y,
      cz: centre.z,
      ax: aim.x,
      ay: aim.y,
      az: aim.z,
      open: 0,
      target: 0,
      cavity: null,
    }
    if (spec.cavity) fit.cavity = buildCavity(spec.cavity, fit, f, box, wl)
    items.push(fit)
  }

  /*
    The inside of a shell. The mouth sits on the leaf's own plane, inset so
    its rim hides behind the carcass front, and the box is BackSide: the near
    wall is front-facing from out here and culls, leaving you looking at the
    inside of the other five. Shelves span it, and the stock is boxes and
    cylinders rather than models, because at this scale a carton is a box.
  */
  const buildCavity = (
    c: CavitySpec,
    fit: Fitting,
    f: THREE.Vector3,
    leaf: THREE.Box3,
    wl: number,
  ): Cavity => {
    const rnd = seeded(c.seed ?? 1)
    const glows: Glow[] = []
    const g = new THREE.Group()
    g.visible = false

    const h = leaf.max.y - leaf.min.y
    const inset = 0.05
    const w = Math.max(0.12, wl - inset * 2)
    const hh = Math.max(0.12, h - inset * 2)
    const d = c.depth
    const tint = c.tint ?? '#d7d3c9'

    // local +z runs back into the piece: rotating +z by yaw must land on -f
    g.position.set(fit.cx, leaf.min.y + h / 2, fit.cz)
    g.rotation.y = Math.atan2(-f.x, -f.z)

    const surface = (colour: string, base: number, gain: number, side?: THREE.Side) => {
      const m = new THREE.MeshStandardMaterial({
        color: colour,
        emissive: colour,
        emissiveIntensity: base,
        roughness: 0.82,
        ...(side === undefined ? {} : { side }),
      })
      trackDisposable(m)
      glows.push({ mat: m, base, gain })
      return m
    }

    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(w, hh, d),
      surface(tint, 0.04, 0.55 * (c.lit ?? 0), THREE.BackSide),
    )
    shell.position.set(0, 0, d / 2)
    shell.castShadow = false
    g.add(shell)

    const shelfMat = surface(tint, 0.04, 0.5 * (c.lit ?? 0))
    const shelves = c.shelves ?? 0
    const decks: number[] = [-hh / 2 + 0.02] // the cavity floor is a shelf too
    const shelfGeo = new THREE.BoxGeometry(w * 0.97, 0.03, d * 0.9)
    trackDisposable(shelfGeo)
    for (let i = 1; i <= shelves; i++) {
      const y = -hh / 2 + (hh * i) / (shelves + 1)
      const s = new THREE.Mesh(shelfGeo, shelfMat)
      s.position.set(0, y, d / 2)
      s.castShadow = false
      g.add(s)
      decks.push(y + 0.02)
    }

    if (c.stock) {
      const boxGeo = new THREE.BoxGeometry(1, 1, 1)
      const jarGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8)
      trackDisposable(boxGeo)
      trackDisposable(jarGeo)
      const palette = ['#c9563f', '#dcc06a', '#7f9d5a', '#5d7fa8', '#e2ddd0', '#8c5a3c']
      for (let i = 0; i < c.stock; i++) {
        const deck = decks[Math.floor(rnd() * decks.length)]
        const jar = rnd() > 0.55
        const tall = (jar ? 0.2 : 0.13) + rnd() * 0.22
        const iw = 0.09 + rnd() * (jar ? 0.05 : 0.12)
        const item = new THREE.Mesh(
          jar ? jarGeo : boxGeo,
          surface(palette[Math.floor(rnd() * palette.length)], 0.03, 0.35 * (c.lit ?? 0)),
        )
        item.scale.set(iw, tall, jar ? iw : 0.09 + rnd() * 0.09)
        item.position.set(
          (rnd() - 0.5) * Math.max(0, w - iw * 2.2),
          deck + tall / 2,
          d * (0.3 + rnd() * 0.45),
        )
        item.rotation.y = rnd() * Math.PI
        item.castShadow = false
        g.add(item)
      }
    }

    // the bulb: a panel under the roof, dark until the door moves
    if (c.lit) {
      const lamp = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.55, 0.04, d * 0.3),
        surface('#fff3da', 0, 3.4 * c.lit),
      )
      lamp.position.set(0, hh / 2 - 0.05, d * 0.36)
      lamp.castShadow = false
      g.add(lamp)
    }

    group.add(g)
    return { group: g, glows }
  }

  const apply = (fit: Fitting) => {
    if (fit.motion === 'slide') {
      fit.pivot.position
        .copy(fit.home)
        .addScaledVector(fit.axis, fit.open * fit.travel)
      return
    }
    fit.pivot.quaternion.setFromAxisAngle(fit.axis, fit.open * fit.travel)
  }

  const update = (dt: number) => {
    let moving = false
    for (const fit of items) {
      if (fit.open === fit.target) continue
      const next = fit.open + (fit.target - fit.open) * (1 - Math.exp(-6.5 * dt))
      const settled = Math.abs(next - fit.target) < 0.004
      fit.open = settled ? fit.target : next
      apply(fit)
      moving = true
      // a leaf coming home is the audible full stop, the way a room door
      // latches; a cupboard only knocks
      if (settled && fit.target === 0) propSnap(0.3)
      const cav = fit.cavity
      if (cav) {
        cav.group.visible = fit.open > 0.015
        const k = Math.min(1, fit.open * 2.6)
        for (const glow of cav.glows) glow.mat.emissiveIntensity = glow.base + glow.gain * k
      }
    }
    return moving
  }

  /**
   * The leaf in reach the player is actually aiming at.
   *
   * The room doors test the gaze on the horizontal plane, because a doorway
   * fills the view and nothing else is ever inside one. A kitchen run is the
   * opposite case: a wall cupboard, a worktop drawer and the cupboard under
   * it stand in one column a metre wide, and the eye's *height* is the same
   * for all three however the player is looking. So the test here is the
   * full 3D gaze: the aim points sit on the carcass face, and the one
   * nearest the middle of the view wins.
   */
  const find = (p: THREE.Vector3, gaze: THREE.Vector3): Fitting | null => {
    let best: Fitting | null = null
    let bestScore = Infinity
    for (const fit of items) {
      const dx = fit.ax - p.x
      const dy = fit.ay - p.y
      const dz = fit.az - p.z
      if (dx * dx + dz * dz >= REACH2 || Math.abs(dy) > RISE) continue
      const dd = dx * dx + dy * dy + dz * dz
      const dist = Math.sqrt(dd) || 1e-4
      const aim = (dx * gaze.x + dy * gaze.y + dz * gaze.z) / dist
      if (aim < AIM) continue
      const score = dd * (1.8 - aim)
      if (score >= bestScore) continue
      bestScore = score
      best = fit
    }
    return best
  }

  const prompt = (p: THREE.Vector3, gaze: THREE.Vector3): FittingPrompt | null => {
    const fit = find(p, gaze)
    if (!fit) return null
    return { verb: fit.target === 0 ? 'open' : 'close', label: fit.spec.label }
  }

  const use = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    const fit = find(p, gaze)
    if (!fit) return false
    fit.target = fit.target === 0 ? 1 : 0
    if (fit.target === 1) {
      propSnap(0.12)
      if (fit.cavity) fit.cavity.group.visible = true
    }
    return true
  }

  const unfreeze = () => {
    for (const fit of items) {
      fit.pivot.matrixAutoUpdate = true
      fit.pivot.updateWorldMatrix(true, false)
    }
  }

  return { add, update, prompt, use, unfreeze }
}
