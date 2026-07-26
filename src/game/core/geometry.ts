import * as THREE from 'three'

/*
  Small geometry utilities shared by the level builders. The perf idiom they
  serve: merge or instance everything static per chunk/room so the GPU sees
  a handful of draw calls, not one per plank.
*/

/*
  createMeshBuilder() is the workhorse the open world is built through. A
  chunk's worth of trees, walls, kerbs and roof boxes is thousands of little
  primitives that must arrive as a handful of draw calls, and they don't all
  want the same colour — so instead of one InstancedMesh per shape per tint,
  every piece is stamped into one growing vertex soup with its colour written
  per vertex. One material with `vertexColors`, one draw call, any palette.

  It takes a source geometry, a transform, and a colour; it applies the
  transform to positions and the normal matrix to normals (so a non-uniformly
  scaled tree still shades correctly) and appends. Sources are cached kit
  geometries that are never disposed — only the built result is, which is what
  the chunk streamer hands to its disposer.
*/

/** how much of this piece bends in the wind. Merged geometry has lost its
    local space by the time it reaches the shader, so the weight is baked per
    vertex here: 0 at `base` (the anchored end, in world y) rising to 1 at
    `base + span`. Anything that shouldn't move omits it entirely. */
export interface SwaySpan {
  base: number
  span: number
}

/** darken/lighten a stamp along world y, on top of its flat colour. A canopy
    lit uniformly reads as a plastic bauble; the same canopy shaded from a dark
    underside up to a bright crown reads as foliage, and it costs one extra
    multiply per vertex at build time rather than anything at all per frame. */
export interface ShadeSpan {
  base: number
  span: number
  /** multiplier at `base` */
  lo: number
  /** multiplier at `base + span` */
  hi: number
}

export interface MeshBuilder {
  /** stamp `geo` transformed by `m`, painted `color` */
  add: (
    geo: THREE.BufferGeometry,
    m: THREE.Matrix4,
    color: THREE.Color,
    sway?: SwaySpan,
    shade?: ShadeSpan,
  ) => void
  /** a flat quad from four corners, wound a->b->c->d. Used where a stamped
      primitive can't follow the ground: roads, mostly, which have to reproduce
      the terrain triangles under them rather than float a slab over them */
  quad: (
    a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
    color: THREE.Color,
  ) => void
  /**
   * Which procedural surface treatment everything stamped from now on gets
   * (see world/surface.ts). It is builder state rather than an argument
   * because it changes once per wall, not once per box, and threading it
   * through every paintBox call site would be noise.
   */
  surface: number
  /** vertices accumulated so far; 0 means build() will return null */
  readonly count: number
  /** hand over the merged geometry, or null if nothing was ever added */
  build: () => THREE.BufferGeometry | null
}

/**
 * `withUV` carries the source geometry's uv channel through the merge. Only
 * the foliage-card builder wants it (its material samples a painted leaf
 * texture); everything else skips the attribute rather than paying two floats
 * a vertex for a channel its material never reads.
 */
export function createMeshBuilder(withUV = false): MeshBuilder {
  const pos: number[] = []
  const norm: number[] = []
  const col: number[] = []
  const sway: number[] = []
  const surf: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  const nm = new THREE.Matrix3()
  const v = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ad = new THREE.Vector3()
  const fn = new THREE.Vector3()

  const builder: MeshBuilder = {
    surface: 0,
    add(geo, m, color, swaySpan, shadeSpan) {
      const p = geo.getAttribute('position')
      const n = geo.getAttribute('normal')
      const srcUV = withUV ? geo.getAttribute('uv') : null
      const base = pos.length / 3
      nm.getNormalMatrix(m)
      for (let i = 0; i < p.count; i++) {
        if (withUV) {
          if (srcUV) uvs.push(srcUV.getX(i), srcUV.getY(i))
          else uvs.push(0, 0)
        }
        v.fromBufferAttribute(p, i).applyMatrix4(m)
        const wy = v.y
        pos.push(v.x, wy, v.z)
        sway.push(
          swaySpan && swaySpan.span > 0.001
            ? Math.min(1, Math.max(0, (wy - swaySpan.base) / swaySpan.span))
            : 0,
        )
        surf.push(builder.surface)
        if (n) {
          v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize()
          norm.push(v.x, v.y, v.z)
        } else {
          norm.push(0, 1, 0)
        }
        if (shadeSpan && shadeSpan.span > 0.001) {
          const t = Math.min(1, Math.max(0, (wy - shadeSpan.base) / shadeSpan.span))
          const k = shadeSpan.lo + (shadeSpan.hi - shadeSpan.lo) * t
          col.push(color.r * k, color.g * k, color.b * k)
        } else {
          col.push(color.r, color.g, color.b)
        }
      }
      const gi = geo.getIndex()
      if (gi) {
        for (let i = 0; i < gi.count; i++) idx.push(base + gi.getX(i))
      } else {
        for (let i = 0; i < p.count; i++) idx.push(base + i)
      }
    },
    quad(a, b, c, d, color) {
      const base = pos.length / 3
      fn.copy(ab.subVectors(b, a)).cross(ad.subVectors(d, a)).normalize()
      for (const p of [a, b, c, d]) {
        pos.push(p.x, p.y, p.z)
        norm.push(fn.x, fn.y, fn.z)
        col.push(color.r, color.g, color.b)
        sway.push(0)
        surf.push(builder.surface)
        if (withUV) uvs.push(0, 0)
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    },
    get count() {
      return pos.length / 3
    },
    build() {
      if (!pos.length) return null
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norm), 3))
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
      g.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(sway), 1))
      g.setAttribute('aSurf', new THREE.BufferAttribute(new Float32Array(surf), 1))
      if (withUV) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2))
      // an open-world chunk routinely clears 65k vertices, so the index has to
      // be 32-bit; a Uint16Array here silently wraps and shreds the mesh
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1))
      g.computeBoundingSphere()
      return g
    },
  }
  return builder
}

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
