import * as THREE from 'three'
import { noStand, type Solid } from '../physics/collision'

/*
  The shops' working doors.

  A chunk is one merged static mesh, so a door that swings cannot live in it:
  the chunk builder stamps the shut leaf, the jambs and the header, and emits
  a spec for the *hinged* leaf instead of geometry. This module owns the live
  leaves — spawned for the chunks whose collision is live (the streamer's
  near ring, reported through `sync`), eased toward their targets each frame,
  and despawned when their chunk leaves the ring. Which doors stand open is
  session state keyed by the door's id, so walking away and back does not
  reset a door you left ajar — the same policy as the fleet: nothing is
  written into the world, and a reload shuts every door.

  The interaction contract (doorPrompt/useDoor, reach + gaze, the swing
  easing and the collision box that empties once the leaf is out of the way)
  copies houseWorld's doors deliberately, so the two feel identical; the sfx
  arrive as callbacks because this module must stay importable headless and
  core/sfx fetches its clips at module load.

  The swing direction is solved numerically rather than by enumerating the
  four facings: `k` is the sign of d(tip · wallNormal)/dα at rest, so
  `target = -sideOut * k * swing` always sends the leaf away from whichever
  side of the wall the player stands on, whatever the shop's yaw or mirror.
*/

export interface ShopDoorSpec {
  id: string
  /** hinge position: world x/z, floor height y */
  x: number
  y: number
  z: number
  /** unit direction the closed leaf runs from the hinge, world xz */
  dx: number
  dz: number
  /** outward wall normal (cardinal) */
  fx: number
  fz: number
  leafW: number
  leafH: number
}

export interface ShopDoorHandles {
  /** the doors that should currently exist (the near ring's); diffed by id */
  sync: (specs: ShopDoorSpec[]) => void
  /** swing easing + latch sounds; call once per rendered frame */
  update: (dt: number) => void
  /** the door within reach the player is looking at: which verb to prompt */
  doorPrompt: (p: THREE.Vector3, gaze: THREE.Vector3) => 'open' | 'close' | null
  /** work that door; a closed leaf swings away from the player's side */
  useDoor: (p: THREE.Vector3, gaze: THREE.Vector3) => boolean
}

interface Opts {
  parent: THREE.Object3D
  /** the shared obstacle list; blocks are pushed on spawn, spliced on despawn */
  obstacles: Solid[]
  sfx: { creak: (opening: boolean) => void; latch: () => void }
  trackDisposable: (d: { dispose: () => void }) => void
}

/** how far a leaf swings; the doorway unblocks at 45% of this (house policy) */
const SWING = Math.PI * 0.52

interface LiveDoor {
  spec: ShopDoorSpec
  pivot: THREE.Group
  baseYaw: number
  /** sign of the tip's motion along the wall normal per positive radian */
  k: number
  /** leaf midpoint, for the reach test */
  cx: number
  cz: number
  angle: number
  target: number
  solid: boolean
  block: Solid
  closedMin: THREE.Vector3
  closedMax: THREE.Vector3
}

export function buildShopDoors({ parent, obstacles, sfx, trackDisposable }: Opts): ShopDoorHandles {
  const group = new THREE.Group()
  group.userData.dynamic = true
  parent.add(group)

  // the leaf is dressed geometrically — a slab with two raised darker panels
  // — rather than with the world's procedural plank pass: that pass reads
  // *world* position, so its grain would swim across a leaf mid-swing. Baked
  // boxes look the same at every angle, and both leaves of a pair are built
  // here so they are guaranteed to match (one used to be merged into the
  // chunk and read as a different species of door).
  const leafGeo = new THREE.BoxGeometry(1, 1, 1)
  const leafMat = new THREE.MeshStandardMaterial({ color: '#3a2c20', roughness: 0.9 })
  const panelMat = new THREE.MeshStandardMaterial({ color: '#2d2118', roughness: 0.95 })
  const knobMat = new THREE.MeshStandardMaterial({ color: '#c9a86a', roughness: 0.5 })
  trackDisposable(leafGeo)
  trackDisposable(leafMat)
  trackDisposable(panelMat)
  trackDisposable(knobMat)

  const live = new Map<string, LiveDoor>()
  /** swing state that survives a despawn: walking away must not shut doors */
  const remembered = new Map<string, { angle: number; target: number }>()

  const spawn = (spec: ShopDoorSpec) => {
    const pivot = new THREE.Group()
    pivot.userData.dynamic = true
    pivot.position.set(spec.x, spec.y, spec.z)
    // yaw that maps local +x onto the closed leaf's run
    const baseYaw = Math.atan2(-spec.dz, spec.dx)
    const leaf = new THREE.Mesh(leafGeo, leafMat)
    leaf.scale.set(spec.leafW, spec.leafH, 0.12)
    leaf.position.set(spec.leafW / 2, spec.leafH / 2, 0)
    leaf.receiveShadow = true
    pivot.add(leaf)
    // two raised panels, a lower and a taller upper, the way the era's shop
    // doors are; and the knob at the meeting edge
    const panelW = spec.leafW - 0.52
    for (const [py, ph] of [[1.25, 1.55], [3.3, 1.9]] as const) {
      const panel = new THREE.Mesh(leafGeo, panelMat)
      panel.scale.set(panelW, ph, 0.16)
      panel.position.set(spec.leafW / 2, py, 0)
      panel.receiveShadow = true
      pivot.add(panel)
    }
    const knob = new THREE.Mesh(leafGeo, knobMat)
    knob.scale.set(0.09, 0.09, 0.34)
    knob.position.set(spec.leafW - 0.28, 2.35, 0)
    pivot.add(knob)
    group.add(pivot)

    // the doorway blocker while the leaf is in the way (axis-aligned: the
    // walls are cardinal, so the closed leaf is too)
    const ex = Math.abs(spec.dx) * (spec.leafW / 2 + 0.12) + Math.abs(spec.fx) * 0.18
    const ez = Math.abs(spec.dz) * (spec.leafW / 2 + 0.12) + Math.abs(spec.fz) * 0.18
    const cx = spec.x + spec.dx * (spec.leafW / 2)
    const cz = spec.z + spec.dz * (spec.leafW / 2)
    const closedMin = new THREE.Vector3(cx - ex, spec.y, cz - ez)
    const closedMax = new THREE.Vector3(cx + ex, spec.y + spec.leafH, cz + ez)
    const block = noStand(new THREE.Box3(closedMin.clone(), closedMax.clone()))
    obstacles.push(block)

    const mem = remembered.get(spec.id)
    const d: LiveDoor = {
      spec,
      pivot,
      baseYaw,
      k: Math.sign(-Math.sin(baseYaw) * spec.fx - Math.cos(baseYaw) * spec.fz) || 1,
      cx,
      cz,
      angle: mem?.angle ?? 0,
      target: mem?.target ?? 0,
      solid: true,
      block,
      closedMin,
      closedMax,
    }
    pivot.rotation.y = baseYaw + d.angle
    applySolidity(d, Math.abs(d.angle) < SWING * 0.45)
    live.set(spec.id, d)
  }

  const applySolidity = (d: LiveDoor, solid: boolean) => {
    d.solid = solid
    if (solid) d.block.set(d.closedMin, d.closedMax)
    else {
      d.block.min.set(0, 0, 0)
      d.block.max.set(0, 0, 0)
    }
  }

  const despawn = (d: LiveDoor) => {
    remembered.set(d.spec.id, { angle: d.angle, target: d.target })
    group.remove(d.pivot)
    const i = obstacles.indexOf(d.block)
    if (i >= 0) obstacles.splice(i, 1)
    live.delete(d.spec.id)
  }

  const sync = (specs: ShopDoorSpec[]) => {
    const want = new Set<string>()
    for (const s of specs) {
      want.add(s.id)
      if (!live.has(s.id)) spawn(s)
    }
    for (const d of [...live.values()]) {
      if (!want.has(d.spec.id)) despawn(d)
    }
  }

  const update = (dt: number) => {
    for (const d of live.values()) {
      const next = d.angle + (d.target - d.angle) * (1 - Math.exp(-5.5 * dt))
      // a closing leaf seating back into its frame is the audible full stop
      if (d.target === 0 && Math.abs(d.angle) > 0.02 && Math.abs(next) <= 0.02) sfx.latch()
      if (Math.abs(next - d.angle) > 0.00012) {
        d.angle = next
        d.pivot.rotation.y = d.baseYaw + next
      }
      const solid = Math.abs(d.angle) < SWING * 0.45
      if (solid !== d.solid) applySolidity(d, solid)
    }
  }

  /** the closest door in reach; past arm's length it must be in view too */
  const findDoor = (p: THREE.Vector3, gaze: THREE.Vector3): LiveDoor | null => {
    let best: LiveDoor | null = null
    let bestD = 6.76 // 2.6 units of reach, squared
    const planarGaze = Math.hypot(gaze.x, gaze.z)
    for (const d of live.values()) {
      const dx = d.cx - p.x
      const dz = d.cz - p.z
      const dd = dx * dx + dz * dz
      if (dd >= bestD) continue
      if (dd > 1.44 && planarGaze > 0.001) {
        const facing = (gaze.x * dx + gaze.z * dz) / (Math.sqrt(dd) * planarGaze)
        if (facing < 0.35) continue
      }
      bestD = dd
      best = d
    }
    return best
  }

  const doorPrompt = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    const d = findDoor(p, gaze)
    return d ? (d.target === 0 ? ('open' as const) : ('close' as const)) : null
  }

  const useDoor = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    const d = findDoor(p, gaze)
    if (!d) return false
    if (d.target !== 0) {
      d.target = 0
      sfx.creak(false)
    } else {
      // swing away from whichever side of the wall the player stands on
      const sideOut =
        Math.sign((p.x - d.spec.x) * d.spec.fx + (p.z - d.spec.z) * d.spec.fz) || 1
      d.target = -sideOut * d.k * SWING
      sfx.creak(true)
    }
    return true
  }

  return { sync, update, doorPrompt, useDoor }
}
