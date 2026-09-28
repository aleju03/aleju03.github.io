import * as THREE from 'three'
import { BatchProxy } from '../batch'
import { KINDS } from '../kinds'
import type { Sandbox, Vec3Like } from '../sandbox'
import { DROP, type Blueprint } from './blueprint'

/*
  The paste preview: the blueprint's props drawn where they would land.

  Not translucent, on purpose. A transparent copy of the prop material is a
  different shader program (three keys programs on `opaque`), and a program
  that first links when somebody picks up the duplicator is a hitch nobody
  can cover. So the ghost is made of the sandbox's own batch proxies, the
  same instanced draw and the same program every prop already uses, tinted:
  `BatchProxy.tint` multiplies the atlas per instance (that is how the
  physgun flashes what it froze), and a tint pushed past 1 in blue reads as
  a lit hologram through the pixel look's posterize. It pulses so it cannot
  be mistaken for a real build, and turns red when the paste would not fit.

  Kinds whose model is not a single batched mesh (a group of parts) are shown
  untinted; nothing in the catalogue's build kits is one today, but the ghost
  must not throw on a kind that becomes one.

  Proxies are direct children of the sandbox root, which is where the batcher
  looks; they carry `userData.dynamic` so the frozen-matrix pass leaves them
  alone. `dispose` takes them out, and the ghost never touches physics, so it
  cannot be raycast, collided with or networked.
*/

const GOOD = new THREE.Color(0.55, 1.05, 1.7)
const BAD = new THREE.Color(1.7, 0.45, 0.4)

export interface Ghost {
  /** put the ghost on `at` (the floor under its middle), turned by `yaw` */
  place: (at: Vec3Like, yaw: number, ok: boolean, time: number) => void
  hide: () => void
  dispose: () => void
}

export function createGhost(sb: Sandbox, bp: Blueprint): Ghost | null {
  // headless: nothing to draw with, and the kind meshes want a canvas
  if (typeof document === 'undefined') return null
  const parts: Array<{ obj: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion }> = []
  for (const p of bp.props) {
    const k = KINDS[p.kind]
    const template = k?.mesh?.()
    if (!template) continue
    const obj = template.clone()
    obj.userData.dynamic = true
    obj.userData.ghost = true
    obj.scale.multiplyScalar(p.scale)
    obj.visible = false
    sb.root.add(obj)
    parts.push({
      obj,
      pos: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]),
      quat: new THREE.Quaternion(p.quat[0], p.quat[1], p.quat[2], p.quat[3]),
    })
  }
  const qy = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const v = new THREE.Vector3()
  const tint = new THREE.Color()
  return {
    place: (at, yaw, ok, time) => {
      qy.setFromAxisAngle(up, yaw)
      tint.copy(ok ? GOOD : BAD).multiplyScalar(0.8 + 0.2 * Math.sin(time * 6))
      for (const g of parts) {
        v.copy(g.pos).applyQuaternion(qy)
        g.obj.position.set(at.x + v.x, at.y + v.y + DROP, at.z + v.z)
        g.obj.quaternion.copy(g.quat).premultiply(qy)
        g.obj.visible = true
        // one shared colour: the batcher reads it in the same frame
        if (g.obj instanceof BatchProxy) g.obj.tint = tint
      }
    },
    hide: () => {
      for (const g of parts) g.obj.visible = false
    },
    dispose: () => {
      for (const g of parts) g.obj.removeFromParent()
      parts.length = 0
    },
  }
}
