import * as THREE from 'three'
import type { RingSpec } from './types'

/*
  The race's checkpoints, drawn: a glowing disc on the ground with a pale
  column of light standing on it, the next one bright and the one after it
  dim. Additive, unlit, one material: nothing here is lit, so no lamp
  entering range can relink it, and the look's outlines and posterize treat
  it as any other bright thing.

  **No program may link after arrival** (root CLAUDE.md), and this is a
  material the scene had no reason to know before a race. So the layer keeps
  one collapsed mesh of the same material in the tree from the moment it is
  built (scale 0, never culled, drawn every frame: the trick sandbox/batch.ts's
  `warmBatch` uses), which makes the first ordinary draw of the boot cover
  link it. A ring is then only a pooled mesh whose scale and position change.
  Both meshes are double sided because `side` is part of a program's key and
  the disc is seen from above and below.
*/

const MAX_RINGS = 4

export interface RingLayer {
  root: THREE.Group
  set: (rings: RingSpec[] | null, groundAt: (x: number, z: number) => number) => void
  update: (dt: number) => void
  dispose: () => void
}

export function createRingLayer(parent: THREE.Object3D): RingLayer {
  const root = new THREE.Group()
  root.name = 'race-rings'
  root.userData.dynamic = true
  const disc = new THREE.RingGeometry(0.82, 1, 48, 1)
  disc.rotateX(-Math.PI / 2)
  const column = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true)
  column.translate(0, 0.5, 0)
  const mat = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    })
  const bright = mat(0x66ffcc, 0.85)
  const dim = mat(0xffd15a, 0.35)
  const beamBright = mat(0x66ffcc, 0.22)
  const beamDim = mat(0xffd15a, 0.1)
  // the collapsed mesh that pays for the program at boot
  const warm = new THREE.Mesh(disc, bright)
  warm.scale.setScalar(0)
  warm.frustumCulled = false
  warm.name = 'race-ring-warm'
  root.add(warm)

  interface Slot { disc: THREE.Mesh; beam: THREE.Mesh; state: RingSpec['state'] | null }
  const slots: Slot[] = []
  for (let i = 0; i < MAX_RINGS; i++) {
    const d = new THREE.Mesh(disc, bright)
    const b = new THREE.Mesh(column, beamBright)
    d.visible = b.visible = false
    d.frustumCulled = b.frustumCulled = false
    d.renderOrder = b.renderOrder = 3
    root.add(d, b)
    slots.push({ disc: d, beam: b, state: null })
  }
  parent.add(root)
  let clock = 0

  return {
    root,
    set(rings, groundAt) {
      const list = rings ?? []
      slots.forEach((s, i) => {
        const r = list[i]
        if (!r || r.state === 'done') {
          s.disc.visible = s.beam.visible = false
          s.state = null
          return
        }
        const y = groundAt(r.x, r.z) + 0.15
        s.disc.position.set(r.x, y, r.z)
        s.beam.position.set(r.x, y, r.z)
        s.disc.userData.r = r.radius
        s.disc.scale.set(r.radius, 1, r.radius)
        s.beam.scale.set(r.radius * 0.9, r.state === 'next' ? 34 : 16, r.radius * 0.9)
        s.disc.material = r.state === 'next' ? bright : dim
        s.beam.material = r.state === 'next' ? beamBright : beamDim
        s.disc.visible = s.beam.visible = true
        s.state = r.state
      })
    },
    update(dt) {
      clock += dt
      for (const s of slots) {
        if (!s.state) continue
        const k = s.state === 'next' ? 1 + Math.sin(clock * 4) * 0.04 : 1
        const r = (s.disc.userData.r as number) * k
        s.disc.scale.set(r, 1, r)
      }
    },
    dispose() {
      root.removeFromParent()
      disc.dispose()
      column.dispose()
      for (const m of [bright, dim, beamBright, beamDim]) m.dispose()
    },
  }
}
