import * as THREE from 'three'

/*
  Small geometry utilities shared by the level builders. The perf idiom they
  serve: merge or instance everything static per chunk/room so the GPU sees
  a handful of draw calls, not one per plank.
*/

/** minimal two-geometry merge (positions/normals/uvs), avoids the utils dep */
export function mergeGeoms(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const out = new THREE.BufferGeometry()
  const attrs: Array<'position' | 'normal' | 'uv'> = ['position', 'normal', 'uv']
  for (const name of attrs) {
    const aa = a.getAttribute(name)
    const ba = b.getAttribute(name)
    const merged = new Float32Array(aa.array.length + ba.array.length)
    merged.set(aa.array as Float32Array, 0)
    merged.set(ba.array as Float32Array, aa.array.length)
    out.setAttribute(name, new THREE.BufferAttribute(merged, aa.itemSize))
  }
  const ai = a.getIndex()
  const bi = b.getIndex()
  if (ai && bi) {
    const offset = a.getAttribute('position').count
    const idx = new Uint16Array(ai.count + bi.count)
    idx.set(ai.array as unknown as Uint16Array, 0)
    for (let i = 0; i < bi.count; i++) idx[ai.count + i] = (bi.array[i] as number) + offset
    out.setIndex(new THREE.BufferAttribute(idx, 1))
  }
  return out
}
