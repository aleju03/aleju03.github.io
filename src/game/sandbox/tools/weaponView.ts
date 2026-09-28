import * as THREE from 'three'
import type { Viewmodel } from './viewmodel'
import { glowWorldMaterial, poseWeapon } from './viewmodel'
import type { WeaponModel } from './weaponModels'
import type { WeaponId, Weapons } from './weapons'

/*
  What the weapons put in the world, drawn: rockets in flight, bolts in
  flight and stuck where they landed, the pistol's tracers, and the guns in
  other players' hands. `weapons.ts` owns every one of those as plain
  numbers; this module only places meshes on them once a frame.

  **No new programs.** Every mesh here is on the viewmodel's own materials
  (the body's copy, with the depth squeeze off: `Viewmodel.worldMats`) or on
  a glowing material built by `glowWorldMaterial`, which is the same
  program as the guns' glowing core with another colour. The belt stages
  one of everything in front of the boot camera with the guns, so the first
  rocket of a walk uploads nothing and links nothing.

  **Pools, not allocation.** A fixed ring of rockets, bolts and tracers is
  built at construction and hidden; a frame shows as many as are live. A
  rocket is a slate body with an ochre nose, four dark fins and a hot tail
  (the flame and smoke behind it are fx.ts's thruster, laid by weapons.ts);
  a bolt is a steel shaft with dark fletching and a hot tip, drawn a little
  longer than it is so it reads at a distance; a tracer is a thin glowing
  streak a few units long running from the muzzle to the hit.

  **Other people's guns** are a copy of the body's model per player who is
  holding one (`Viewmodel.buildRemote`), placed between their two hands the
  way the local body's copy is (viewmodel.ts), and aimed along their look.
  The scene says where the hands are (`hands`), and whether that body is
  drawn at all; a copy nobody is holding is hidden and kept for reuse.
*/

const ROCKETS = 8
const BOLTS = 40
const TRACERS = 24
/** a tracer's length, and how fast it runs */
const STREAK = 5

export interface RemoteHands {
  /** the body's right and left hands and its aim (unit), world; false when
      the body is not drawn standing (culled, down, seated) */
  (id: number, handR: THREE.Vector3, handL: THREE.Vector3, aim: THREE.Vector3): boolean
}

export interface WeaponView {
  readonly root: THREE.Group
  /** place everything for this frame */
  update: (dt: number, hands: RemoteHands | null) => void
  /** where a remote player's gun is drawn: its muzzle, world */
  muzzleOf: (id: number, out: THREE.Vector3) => boolean
  /** a remote player fired: kick and flash their copy */
  remoteShot: (id: number, w: WeaponId) => void
  stage: (camera: THREE.Camera) => void
  unstage: () => void
  dispose: () => void
}

export function createWeaponView(parent: THREE.Object3D, weapons: Weapons, vm: Viewmodel): WeaponView {
  const root = new THREE.Group()
  root.name = 'weapons'
  root.userData.dynamic = true
  parent.add(root)
  const mats = vm.worldMats
  const g = vm.geos
  const tracerMat = glowWorldMaterial(new THREE.Color(3.6, 2.9, 1.1))
  const own: THREE.Material[] = [tracerMat]

  const part = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, into: THREE.Object3D) => {
    const mesh = new THREE.Mesh(geo, m)
    mesh.position.set(x, y, z)
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.frustumCulled = false
    into.add(mesh)
    return mesh
  }

  // a rocket, forward -z, world units
  const rockets: THREE.Group[] = []
  for (let i = 0; i < ROCKETS; i++) {
    const r = new THREE.Group()
    part(g.drum(0.13, 0.8, 8), mats.slate, 0, 0, 0, r)
    part(g.drum(0.001, 0.36, 8, 0.13), mats.ochre, 0, 0, -0.58, r)
    part(g.drum(0.135, 0.08, 8), mats.dark, 0, 0, -0.25, r)
    for (let k = 0; k < 4; k++) {
      const fin = part(g.box(0.46, 0.03, 0.24), mats.dark, 0, 0, 0.3, r)
      fin.rotation.z = (k / 4) * Math.PI
    }
    part(g.drum(0.1, 0.12, 8, 0.06), mats.hot, 0, 0, 0.46, r)
    r.visible = false
    root.add(r)
    rockets.push(r)
  }
  // a bolt, forward -z, its tip at the origin's -z end
  const bolts: THREE.Group[] = []
  for (let i = 0; i < BOLTS; i++) {
    const b = new THREE.Group()
    part(g.box(0.07, 0.07, 1.5), mats.steel, 0, 0, 0.75, b)
    for (const a of [0, Math.PI / 2]) {
      const fl = part(g.box(0.24, 0.02, 0.28), mats.dark, 0, 0, 1.36, b)
      fl.rotation.z = a
    }
    part(g.drum(0.001, 0.22, 6, 0.07), mats.hot, 0, 0, -0.1, b)
    b.visible = false
    root.add(b)
    bolts.push(b)
  }
  const tracers: THREE.Mesh[] = []
  for (let i = 0; i < TRACERS; i++) {
    const t = part(g.box(1, 1, 1), tracerMat, 0, 0, 0, root)
    t.visible = false
    tracers.push(t)
  }

  /* other players' guns */
  interface Held {
    w: WeaponId
    model: WeaponModel
    flash: number
    kick: number
    loaded: number
  }
  const held = new Map<number, Held>()
  const spare: Held[] = []
  const handR = new THREE.Vector3()
  const handL = new THREE.Vector3()
  const aim = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const origin = new THREE.Vector3()
  const m4 = new THREE.Matrix4()
  const fwd = new THREE.Vector3()
  const mid = new THREE.Vector3()

  const copyFor = (id: number, w: WeaponId): Held => {
    let h = held.get(id)
    if (h && h.w === w) return h
    if (h) {
      h.model.root.visible = false
      spare.push(h)
      held.delete(id)
    }
    const si = spare.findIndex((s) => s.w === w)
    if (si >= 0) h = spare.splice(si, 1)[0]
    else {
      h = { w, model: vm.buildRemote(w), flash: 0, kick: 0, loaded: 1 }
      h.model.root.userData.dynamic = true
      root.add(h.model.root)
    }
    held.set(id, h)
    return h
  }

  const update: WeaponView['update'] = (dt, hands) => {
    // rockets and bolts in flight
    let ri = 0
    let bi = 0
    for (const p of weapons.projectiles) {
      const obj = p.w === 'rocket' ? rockets[ri++] : bolts[bi++]
      if (!obj) continue
      obj.visible = true
      obj.position.copy(p.pos).add(p.off)
      fwd.copy(p.vel)
      if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1)
      obj.quaternion.setFromUnitVectors(Z_BACK, fwd.normalize())
    }
    for (const s of weapons.stuck) {
      const obj = bolts[bi++]
      if (!obj) break
      obj.visible = true
      obj.position.copy(s.pos)
      obj.quaternion.copy(s.quat)
    }
    for (; ri < ROCKETS; ri++) rockets[ri].visible = false
    for (; bi < BOLTS; bi++) bolts[bi].visible = false
    // tracers: a streak running from the muzzle to the hit
    let ti = 0
    for (const t of weapons.tracers) {
      const mesh = tracers[ti++]
      if (!mesh) break
      const len = t.from.distanceTo(t.to)
      const k = t.age / t.life
      const head = Math.min(len, k * len + STREAK * 0.5)
      const tail = Math.max(0, head - STREAK)
      fwd.copy(t.to).sub(t.from)
      if (len < 1e-4) {
        mesh.visible = false
        continue
      }
      fwd.multiplyScalar(1 / len)
      mesh.visible = true
      mesh.position.copy(t.from).addScaledVector(fwd, (head + tail) / 2)
      mesh.quaternion.setFromUnitVectors(Z_BACK, fwd)
      mesh.scale.set(0.06, 0.06, Math.max(0.05, head - tail))
    }
    for (; ti < TRACERS; ti++) tracers[ti].visible = false

    // the guns in other people's hands
    for (const [id, w] of weapons.wields) copyFor(id, w)
    for (const [id, h] of held) {
      if (weapons.wields.get(id) !== h.w) {
        h.model.root.visible = false
        held.delete(id)
        spare.push(h)
        continue
      }
      const shown = !!hands && hands(id, handR, handL, aim)
      h.model.root.visible = shown
      if (!shown) continue
      h.flash = Math.max(0, h.flash - dt)
      h.kick = Math.max(0, h.kick - dt * 5)
      h.loaded = Math.min(1, h.loaded + dt / (h.w === 'pistol' ? 0.14 : h.w === 'crossbow' ? 1.15 : 1.25))
      poseWeapon(h.w, h.model, h.loaded, h.w === 'pistol' ? h.kick * 0.09 : 0, h.flash > 0)
      mid.copy(handR).lerp(handL, 0.35)
      h.model.root.position.copy(mid).addScaledVector(aim, -h.kick * 0.25)
      m4.lookAt(origin, aim, up)
      h.model.root.quaternion.setFromRotationMatrix(m4)
    }
    for (const s of spare) s.model.root.visible = false
  }

  let staged = false
  return {
    root,
    update,
    muzzleOf: (id, out) => {
      const h = held.get(id)
      if (!h || !h.model.root.visible) return false
      h.model.root.updateMatrixWorld(true)
      h.model.muzzle.getWorldPosition(out)
      return true
    },
    remoteShot: (id, w) => {
      const h = held.get(id)
      if (!h || h.w !== w) return
      h.flash = 0.06
      h.kick = 1
      h.loaded = 0
    },
    stage: (camera) => {
      staged = true
      camera.updateMatrixWorld()
      const at = (obj: THREE.Object3D, x: number) => {
        obj.visible = true
        obj.position.set(x, -0.5, -6).applyMatrix4(camera.matrixWorld)
      }
      at(rockets[0], -1.5)
      at(bolts[0], 0)
      at(tracers[0], 1.5)
    },
    unstage: () => {
      if (!staged) return
      staged = false
      rockets[0].visible = false
      bolts[0].visible = false
      tracers[0].visible = false
    },
    dispose: () => {
      root.removeFromParent()
      for (const m of own) m.dispose()
    },
  }
}

/** the models' forward is -z */
const Z_BACK = new THREE.Vector3(0, 0, -1)
