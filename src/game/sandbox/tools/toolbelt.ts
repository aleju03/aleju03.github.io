import * as THREE from 'three'
import type { Sandbox } from '../sandbox'
import { createBeam, type Beam } from './beam'
import { createPhysgun, type Physgun } from './physgun'
import { createPhysgunSfx, type PhysgunSfx } from './sfx'
import type { RigEntry, ToolInput } from './types'
import { createViewmodel, type Viewmodel } from './viewmodel'

/*
  The tool belt: which thing is in your hand, and the one object CrtScene
  talks to about any of them.

  Slots are GMod's: 1 is your hands (nothing drawn, E uses doors and seats
  the way it always has), 2 is the physgun, 3 is reserved for a toolgun. The
  wheel cycles slots while nothing is held, and belongs to the physgun's
  distance while something is. A slot with nothing in it is skipped.

  A frame is two calls, and the split is the same one the sandbox makes:
  `update(input)` before the sandbox ticks (it decides what the beam is
  pulling toward, so the slices that follow can pull), and `present(frame)`
  after the camera is final for the frame (third person has moved the lens
  by then), which places the gun, draws the beam from its muzzle to where
  the held thing is *drawn*, lights the halo and keeps the hum going.

  Headless, with no `parent`, it builds no meshes and no sound, and
  `present` only syncs the physgun's plain-data record: that is the belt the
  measure harness and a future authoritative server would run.

  Everything the beam's look needs to compile (the viewmodel's two programs,
  the ribbon, the sprites, the halo shell) is built here at construction and
  shown to a camera by `stage()` so it can be compiled and first-drawn under
  the boot cover; `unstage()` puts it all back.
*/

export type ToolId = 'hands' | 'physgun' | 'toolgun'
export const SLOTS: readonly (ToolId | null)[] = ['hands', 'physgun', null]

export interface ToolbeltOpts {
  sb: Sandbox
  /** where the gun and beam are drawn; omit headless */
  parent?: THREE.Object3D | null
  /** the bodies the beam can pick up by a limb */
  rigs?: () => Iterable<RigEntry>
  /** props welded to a prop (reload thaws them together) */
  linked?: (id: number) => Iterable<number>
  /** starting slot (0 hands) */
  slot?: number
  /** synthesize the physgun's sound (default: when drawn) */
  sound?: boolean
}

export interface ToolFrame {
  camera: THREE.PerspectiveCamera
  dt: number
  /** walk gait 0..1 and whether the feet are down, for the bob */
  gait: number
  grounded: boolean
  /** first person: the viewmodel; else the gun in the body's hand */
  firstPerson: boolean
  /** third person: the body's right hand, world */
  hand?: THREE.Vector3 | null
  /** the tool is usable at all this frame: on foot, in the sandbox's level,
      not sitting, not a heap on the floor */
  active: boolean
  /** the look's internal lines, for the beam's minimum width */
  lines: number
}

export interface Toolbelt {
  readonly slot: number
  readonly tool: ToolId
  select: (slot: number) => void
  cycle: (dir: number) => void
  readonly physgun: Physgun
  /** before the sandbox ticks. `active` false holsters whatever is held */
  update: (input: ToolInput, active: boolean) => void
  /** after the camera is final */
  present: (f: ToolFrame) => void
  /** put everything away at once, for a frame loop that stops presenting
      (climbing into a vehicle): drop what is held, hide the gun and beam,
      silence the hum. The next `present` brings them back */
  holster: () => void
  /** mouse-look belongs to the tool (E is turning a held prop) */
  readonly capturesLook: boolean
  /** E belongs to the tool (something is held), not to doors and seats */
  readonly capturesUse: boolean
  /** hand colour for the first-person mitten, off the body's look */
  setHandColor: (c: THREE.ColorRepresentation) => void
  /** the parts, for the covered compile */
  stage: (camera: THREE.Camera) => void
  unstage: () => void
  readonly beam: Beam | null
  readonly viewmodel: Viewmodel | null
  dispose: () => void
}

export function createToolbelt(o: ToolbeltOpts): Toolbelt {
  const physgun = createPhysgun({ sb: o.sb, rigs: o.rigs, linked: o.linked })
  const beam = o.parent ? createBeam(o.parent) : null
  const vm = o.parent ? createViewmodel(o.parent) : null
  const sfx: PhysgunSfx | null = (o.sound ?? !!o.parent) ? createPhysgunSfx() : null
  let slot = Math.max(0, Math.min(SLOTS.length - 1, o.slot ?? 0))
  if (!SLOTS[slot]) slot = 0
  let lastActive = true

  const muzzle = new THREE.Vector3()
  const forward = new THREE.Vector3()
  const flashAt = new THREE.Vector3()
  /** the holder's view direction as of the last update: the body's gun
      points along it in third person, not along the chase camera */
  const aimDir = new THREE.Vector3(0, 0, -1)

  const offEvents = physgun.on((e) => {
    switch (e.type) {
      case 'grab':
        sfx?.grab()
        vm?.kick(1)
        beam?.kick(1)
        break
      case 'release':
        sfx?.release(e.speed)
        vm?.kick(0.35)
        break
      case 'freeze': {
        sfx?.freeze()
        vm?.kick(0.7)
        flashAt.set(e.x, e.y, e.z)
        const p = e.prop >= 0 ? o.sb.get(e.prop) : undefined
        beam?.flash(p?.mesh ?? null, flashAt)
        break
      }
      case 'unfreeze': {
        sfx?.unfreeze()
        flashAt.set(e.x, e.y, e.z)
        const p = e.prop >= 0 ? o.sb.get(e.prop) : undefined
        if (p?.mesh) beam?.flash(p.mesh, flashAt)
        break
      }
      case 'miss':
        sfx?.miss()
        break
    }
  })

  const select = (s: number) => {
    if (s < 0 || s >= SLOTS.length || !SLOTS[s] || s === slot) return
    if (physgun.holding) physgun.release(false)
    slot = s
  }
  const cycle = (dir: number) => {
    for (let k = 1; k <= SLOTS.length; k++) {
      const s = (((slot + dir * k) % SLOTS.length) + SLOTS.length) % SLOTS.length
      if (SLOTS[s]) {
        select(s)
        return
      }
    }
  }

  const update = (input: ToolInput, active: boolean) => {
    aimDir.copy(input.aim.dir)
    if (!active) {
      if (physgun.holding) physgun.release(false)
      lastActive = false
      return
    }
    // a click that brought the tool back (a pause, a seat) is not a grab
    if (!lastActive && input.fire) input.fire = false
    lastActive = true
    if (!physgun.holding && input.wheel) {
      cycle(input.wheel > 0 ? 1 : -1)
      input.wheel = 0
    }
    if (SLOTS[slot] === 'physgun') physgun.update(input)
    else if (physgun.holding) physgun.release(false)
  }

  const present = (f: ToolFrame) => {
    if (vm) vm.root.visible = true
    if (beam) beam.root.visible = true
    physgun.sync()
    const shown = f.active && SLOTS[slot] === 'physgun'
    if (vm) {
      vm.update({
        camera: f.camera, dt: f.dt, gait: f.gait, grounded: f.grounded,
        holding: physgun.holding, strain: physgun.view.strain,
        firstPerson: f.firstPerson, hand: f.hand, aim: aimDir, shown,
      })
    }
    if (beam) {
      if (vm && shown) vm.muzzle(muzzle, forward)
      else {
        f.camera.getWorldDirection(forward)
        muzzle.copy(f.camera.position).addScaledVector(forward, 0.8)
      }
      beam.holdHalo(shown ? physgun.prop?.mesh ?? null : null)
      beam.update({
        muzzle, end: physgun.view.end, target: physgun.view.target, mode: shown ? physgun.view.mode : 'off',
        strain: physgun.view.strain, dt: f.dt, lines: f.lines, fov: f.camera.fov, camera: f.camera,
      })
    }
    sfx?.hum(shown && physgun.holding, physgun.view.strain)
  }

  return {
    get slot() {
      return slot
    },
    get tool() {
      return SLOTS[slot] ?? 'hands'
    },
    select,
    cycle,
    physgun,
    update,
    present,
    holster: () => {
      if (physgun.holding) physgun.release(false)
      if (vm) vm.root.visible = false
      if (beam) {
        beam.clear()
        beam.root.visible = false
      }
      sfx?.hum(false, 0)
      lastActive = false
    },
    get capturesLook() {
      return physgun.capturesLook
    },
    get capturesUse() {
      return physgun.holding
    },
    setHandColor: (c) => vm?.setHandColor(c),
    stage: (camera) => {
      vm?.stage(camera)
      beam?.stage(camera)
    },
    unstage: () => {
      vm?.unstage()
      beam?.unstage()
    },
    beam,
    viewmodel: vm,
    dispose: () => {
      offEvents()
      physgun.dispose()
      beam?.dispose()
      vm?.dispose()
      sfx?.dispose()
    },
  }
}
