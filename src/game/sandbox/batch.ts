import * as THREE from 'three'
import { propMaterial } from './art'

/*
  Props drawn by the hundred: one instanced draw per shape, not one per prop.

  Every catalogue model is one merged geometry on the one atlas material
  (art.ts), so three hundred crates, drums and melons differ only in their
  transforms, which is exactly what an InstancedMesh is for. A prop's `mesh`
  is therefore a `BatchProxy`: an ordinary Object3D that the physics writes
  its pose into (and anything else may move, scale, hide or tint) but that
  draws nothing itself. Once a frame `sync` walks the sandbox root, groups
  the proxies by geometry and writes their matrices into one InstancedMesh
  per geometry, so the cost of a street full of props is the kinds in view,
  plus the same again for the shadow pass, whatever the count. Gibs are
  proxies too (each piece shape is a geometry), so a broken crate's thirty-
  two boards and battens are instances of eight batches, not 32 draws.

  Colour is per instance: a proxy's `tint` (a THREE.Color, null for none)
  multiplies the atlas, which is how a physgun can flash what it froze
  without a second material. Every batch carries an instance colour
  attribute from birth, so there is only ever one program variant: the one
  the warm batch (below) links under the boot cover.

  The batches never cull (the instances move, and a bounding sphere over a
  moving crowd costs more to keep than the draw it would save) and grow by
  doubling, which swaps the InstancedMesh for a bigger one on the same
  geometry and material: a new buffer, never a new program.
*/

/** an Object3D standing in for one instance of a shared geometry */
export class BatchProxy extends THREE.Object3D {
  geo: THREE.BufferGeometry | null
  /** multiplies the atlas for this instance; null draws it as painted */
  tint: THREE.Color | null = null
  readonly isBatchProxy = true

  constructor(geo: THREE.BufferGeometry | null = null) {
    super()
    this.geo = geo
  }

  copy(source: this, recursive?: boolean) {
    super.copy(source, recursive)
    this.geo = source.geo
    this.tint = source.tint ? source.tint.clone() : null
    return this
  }
}

/** turn a template Mesh on the atlas material into a proxy of its geometry.
    Anything else (a group, a custom material) is returned as it is and
    drawn the ordinary way */
export const batchable = (o: THREE.Object3D): THREE.Object3D => {
  const m = o as THREE.Mesh
  if (!batching || !m.isMesh || m.material !== propMaterial() || m.children.length) return o
  const p = new BatchProxy(m.geometry)
  p.position.copy(m.position)
  p.quaternion.copy(m.quaternion)
  p.scale.copy(m.scale)
  p.name = m.name
  return p
}

interface Batch {
  im: THREE.InstancedMesh
  cap: number
  /** instances written this sync */
  n: number
}

export interface Batcher {
  /** write every proxy under `root` into its batch; once a frame */
  sync: () => void
  /** the batches, for a covered compile and the harness */
  readonly group: THREE.Group
  readonly stats: { batches: number; instances: number }
  dispose: () => void
}

const WHITE = new THREE.Color(1, 1, 1)

export const createBatcher = (root: THREE.Object3D): Batcher => {
  const group = new THREE.Group()
  group.name = 'sandbox-batches'
  root.add(group)
  const batches = new Map<THREE.BufferGeometry, Batch>()
  const stats = { batches: 0, instances: 0 }

  const make = (geo: THREE.BufferGeometry, cap: number): Batch => {
    const im = new THREE.InstancedMesh(geo, propMaterial(), cap)
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3)
    im.instanceColor.setUsage(THREE.DynamicDrawUsage)
    im.count = 0
    im.frustumCulled = false
    im.castShadow = true
    im.receiveShadow = true
    im.userData.dynamic = true
    group.add(im)
    return { im, cap, n: 0 }
  }

  const grow = (b: Batch, need: number) => {
    let cap = b.cap
    while (cap < need) cap *= 2
    const nb = make(b.im.geometry, cap)
    b.im.removeFromParent()
    b.im.dispose()
    b.im = nb.im
    b.cap = cap
  }

  const sync = () => {
    for (const b of batches.values()) b.n = 0
    let total = 0
    for (const o of root.children) {
      const p = o as BatchProxy
      if (!p.isBatchProxy || !p.visible || !p.geo) continue
      let b = batches.get(p.geo)
      if (!b) {
        b = make(p.geo, 16)
        batches.set(p.geo, b)
      }
      if (b.n >= b.cap) grow(b, b.n + 1)
      if (p.matrixAutoUpdate) p.updateMatrix()
      b.im.setMatrixAt(b.n, p.matrix)
      b.im.setColorAt(b.n, p.tint ?? WHITE)
      b.n++
      total++
    }
    for (const b of batches.values()) {
      if (b.im.count !== b.n || b.n) {
        b.im.count = b.n
        b.im.instanceMatrix.needsUpdate = true
        b.im.instanceColor!.needsUpdate = true
      }
      b.im.visible = b.n > 0
    }
    stats.batches = batches.size
    stats.instances = total
  }

  return {
    sync,
    group,
    stats,
    dispose: () => {
      for (const b of batches.values()) b.im.dispose()
      batches.clear()
      group.removeFromParent()
    },
  }
}

/**
 * A batch with nothing in it, never culled, on the prop material: what the
 * sandbox hangs in the scene at creation so the instanced variant of the
 * material (main pass and shadow depth) is linked under the boot cover with
 * everything else, not on the first spawn.
 */
export const warmBatch = () => {
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.001, 0.001, 0.001), propMaterial(), 1)
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3).fill(1), 3)
  // one instance collapsed to nothing, drawn every frame by every pass
  // (a draw of twelve degenerate triangles), so whichever pass first renders
  // with it links its program while the cover is still up
  im.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0))
  im.frustumCulled = false
  im.castShadow = true
  im.receiveShadow = true
  im.name = 'sandbox-warm-batch'
  return im
}

let batching = true
/** draw props as plain meshes instead (the film harness's `--nobatch`, to
    measure what the batches save). Takes effect for kinds drawn after it */
export const setBatching = (on: boolean) => {
  batching = on
}
