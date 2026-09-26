import * as THREE from 'three'
import type { PropKind } from '../../game/sandbox/kinds'

/*
  The spawn menu's pictures: a prop kind drawn as a catalogue illustration,
  on a 2D canvas, from its own mesh.

  Why not a render. The obvious thumbnail is the prop's mesh rendered through
  the game's renderer into a target and read back, and it is the wrong trade
  twice over. A thumbnail scene has its own lights, so the prop material would
  be compiled in a new light configuration, which is a shader link in the
  middle of a walk the first time somebody holds Q (the thing the boot cover
  exists to prevent). And a photographed prop on a sheet of paper looks like
  a screenshot glued to a page, when what a mail-order catalogue has is a
  printed illustration: flat colour, a heavy ink line round the outside,
  shading done with a halftone screen.

  So this is a tiny software renderer, which a few hundred triangles do not
  need more than: every triangle of the kind's mesh is taken into a fixed
  three-quarter view, back faces culled, sorted far to near, and filled on a
  canvas with its own vertex colour lit in three flat bands. The silhouette is
  the same triangles stroked fat in ink underneath the fills, and the darkest
  band gets a dot screen laid over it. It works for any kind anybody
  registers, with no per-kind art, and a catalogue that ships its own picture
  (`SpawnEntry.thumb`) simply skips it.

  Cached per kind for the session; each costs a millisecond or two, once.
*/

const INK = '#2a231a'
const cache = new Map<string, string>()

/** the view: a quarter turn round and a look down onto the top, the angle a
    product is photographed from */
const VIEW = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.42, -0.72, 0, 'XYZ'))
/** light from the upper left, a little in front */
const LIGHT = new THREE.Vector3(-0.55, 0.75, 0.45).normalize()

let dots: CanvasPattern | null = null
const dotScreen = (g: CanvasRenderingContext2D) => {
  if (dots) return dots
  const c = document.createElement('canvas')
  c.width = c.height = 5
  const d = c.getContext('2d')!
  d.fillStyle = 'rgba(30,22,14,0.34)'
  d.beginPath()
  d.arc(2.5, 2.5, 1.05, 0, Math.PI * 2)
  d.fill()
  dots = g.createPattern(c, 'repeat')
  return dots
}

interface Tri {
  pts: [number, number, number, number, number, number]
  z: number
  fill: string
  band: number
}

/** a kind drawn as a catalogue illustration, as a data URL ('' if it has
    no mesh) */
export function sketchKind(kind: PropKind, size = 192): string {
  const hit = cache.get(kind.id)
  if (hit !== undefined) return hit
  const root = kind.mesh?.()
  if (!root) {
    cache.set(kind.id, '')
    return ''
  }
  root.updateMatrixWorld(true)
  const tris: Tri[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const n = new THREE.Vector3()
  const col = new THREE.Color()
  const tmp = new THREE.Color()
  const m = new THREE.Matrix4()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const g = mesh.geometry as THREE.BufferGeometry
    const pos = g.getAttribute('position')
    const colour = g.getAttribute('color')
    const index = g.getIndex()
    const base = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
    m.multiplyMatrices(VIEW, mesh.matrixWorld)
    const count = index ? index.count : pos.count
    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i
      const ib = index ? index.getX(i + 1) : i + 1
      const ic = index ? index.getX(i + 2) : i + 2
      a.fromBufferAttribute(pos, ia).applyMatrix4(m)
      b.fromBufferAttribute(pos, ib).applyMatrix4(m)
      c.fromBufferAttribute(pos, ic).applyMatrix4(m)
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a))
      const len = n.length()
      if (len < 1e-9) continue
      n.multiplyScalar(1 / len)
      if (n.z <= 0.02) continue // facing away (the viewer is at +z)
      if (colour) {
        col.setRGB(0, 0, 0)
        for (const k of [ia, ib, ic]) col.add(tmp.fromBufferAttribute(colour as THREE.BufferAttribute, k))
        col.multiplyScalar(1 / 3)
      } else {
        col.copy(base?.color ?? tmp.set('#999999'))
      }
      // three flat bands, like a two-pass print: lit, mid, and shade
      const lam = Math.max(0, n.dot(LIGHT))
      const band = lam > 0.62 ? 0 : lam > 0.28 ? 1 : 2
      col.multiplyScalar(band === 0 ? 1.08 : band === 1 ? 0.8 : 0.58)
      tris.push({
        // screen space: x right, y down
        pts: [a.x, -a.y, b.x, -b.y, c.x, -c.y],
        z: (a.z + b.z + c.z) / 3,
        fill: col.getStyle(),
        band,
      })
    }
    // not disposed: a kind may hand out one shared geometry, and this one
    // was never uploaded to the GPU anyway
  })
  if (!tris.length) {
    cache.set(kind.id, '')
    return ''
  }
  // fit: the projected bounds scaled into the frame with room for the line
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const t of tris) {
    for (let k = 0; k < 6; k += 2) {
      x0 = Math.min(x0, t.pts[k])
      x1 = Math.max(x1, t.pts[k])
      y0 = Math.min(y0, t.pts[k + 1])
      y1 = Math.max(y1, t.pts[k + 1])
    }
  }
  const span = Math.max(x1 - x0, y1 - y0)
  const scale = (size * 0.74) / span
  const ox = size / 2 - ((x0 + x1) / 2) * scale
  const oy = size * 0.47 - ((y0 + y1) / 2) * scale
  tris.sort((p, q) => p.z - q.z)

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')
  if (!g) return ''
  g.lineJoin = 'round'
  // the shadow it casts on the page: a soft ellipse under its lowest point
  const floor = oy + y1 * scale
  const shadow = g.createRadialGradient(size / 2, floor, 0, size / 2, floor, size * 0.36)
  shadow.addColorStop(0, 'rgba(40,30,20,0.22)')
  shadow.addColorStop(1, 'rgba(40,30,20,0)')
  g.save()
  g.translate(size / 2, floor)
  g.scale(1, 0.18)
  g.translate(-size / 2, -floor)
  g.fillStyle = shadow
  g.fillRect(0, floor - size * 0.4, size, size * 0.8)
  g.restore()
  const path = (t: Tri) => {
    g.beginPath()
    g.moveTo(ox + t.pts[0] * scale, oy + t.pts[1] * scale)
    g.lineTo(ox + t.pts[2] * scale, oy + t.pts[3] * scale)
    g.lineTo(ox + t.pts[4] * scale, oy + t.pts[5] * scale)
    g.closePath()
  }
  // the ink line: every visible triangle stroked fat, so only its outside
  // survives the fills drawn over it
  g.strokeStyle = INK
  g.fillStyle = INK
  g.lineWidth = size / 42
  for (const t of tris) {
    path(t)
    g.fill()
    g.stroke()
  }
  // the fills, each stroked thin in its own colour so seams do not show
  g.lineWidth = 0.9
  const screen = dotScreen(g)
  for (const t of tris) {
    path(t)
    g.fillStyle = t.fill
    g.strokeStyle = t.fill
    g.fill()
    g.stroke()
    if (t.band === 2 && screen) {
      g.fillStyle = screen
      g.fill()
    }
  }
  const url = canvas.toDataURL('image/png')
  cache.set(kind.id, url)
  return url
}
