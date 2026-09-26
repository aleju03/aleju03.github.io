import * as THREE from 'three'
import { CATALOGUE } from './catalogue'
import { KINDS } from './kinds'
import { BatchProxy } from './batch'
import { propMaterial } from './art'

/*
  Spawn-menu icons: each catalogue model drawn once, small, as pixel art.

  The spawn menu (S4's) wants a picture per prop, and the honest picture is
  the prop's own model on its own atlas. So this renders each one in a
  three-quarter view into a tiny target (`PIXELS` across, the same chunky
  grain the world is drawn at), upscales it nearest-neighbour and rings the
  silhouette with a one-pixel dark outline, which is the look's own rule for
  what separates a thing from its background.

  It runs in a WebGL context of its own, created for the call and lost at
  the end of it, on purpose. The icons' light rig has nothing in common with
  the scene's, so on the game's renderer every icon would link a program
  variant the boot cover never saw; in a private context the programs die
  with it and the game's cache never hears of them. The cost is one context
  and forty-one tiny draws, once, whenever the menu first opens (or at idle).

  Browser only; headless it returns an empty map.
*/

export interface Thumbnail {
  id: string
  canvas: HTMLCanvasElement
}

/** internal pixels across an icon: the grain it is drawn at */
const PIXELS = 44

/** the geometry a kind draws with, whether it is batched or not */
const geometryOf = (o: THREE.Object3D | undefined): THREE.BufferGeometry | null => {
  if (!o) return null
  if (o instanceof BatchProxy) return o.geo
  const m = o as THREE.Mesh
  return m.isMesh ? (m.geometry as THREE.BufferGeometry) : null
}

/**
 * Draw icons for `ids` (default: the whole catalogue) at `size` CSS pixels
 * square. Resolves to one canvas per id, in order.
 */
export const renderThumbnails = async (
  ids: string[] = CATALOGUE.map((e) => e.id),
  size = 96,
): Promise<Thumbnail[]> => {
  if (typeof document === 'undefined') return []
  const px = Math.max(16, Math.min(size, PIXELS))
  const cv = document.createElement('canvas')
  cv.width = px
  cv.height = px
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, alpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(px, px, false)
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xe8eefc, 0x5a4a3a, 1.6))
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4)
  sun.position.set(-3, 5, 4)
  scene.add(sun)
  const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 200)
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), propMaterial())
  scene.add(mesh)
  const box = new THREE.Box3()
  const sph = new THREE.Sphere()
  const out: Thumbnail[] = []
  for (const id of ids) {
    const k = KINDS[id]
    const geo = geometryOf(k?.mesh?.())
    if (!geo) continue
    mesh.geometry = geo
    geo.computeBoundingBox()
    box.copy(geo.boundingBox!)
    box.getBoundingSphere(sph)
    // three-quarter view from the front left and a little above, far enough
    // back that the bounding sphere fills most of the frame
    const d = sph.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 0.92
    const dir = new THREE.Vector3(-0.62, 0.48, 0.62).normalize()
    cam.position.copy(sph.center).addScaledVector(dir, d)
    cam.lookAt(sph.center)
    cam.near = Math.max(0.01, d - sph.radius * 2)
    cam.far = d + sph.radius * 2
    cam.updateProjectionMatrix()
    renderer.render(scene, cam)
    out.push({ id, canvas: upscale(cv, size) })
  }
  mesh.geometry = new THREE.BufferGeometry()
  renderer.dispose()
  renderer.forceContextLoss()
  return out
}

/** nearest-neighbour upscale with a one-pixel dark ring round the silhouette */
const upscale = (src: HTMLCanvasElement, size: number) => {
  const w = src.width
  const h = src.height
  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  const tc = tmp.getContext('2d')!
  tc.drawImage(src, 0, 0)
  const img = tc.getImageData(0, 0, w, h)
  const a = img.data
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && a[(y * w + x) * 4 + 3] > 128
  const ring: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (solid(x, y)) continue
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) ring.push(x, y)
    }
  // hard alpha: an icon is pixel art, and half-covered edge pixels are not
  for (let i = 3; i < a.length; i += 4) a[i] = a[i] > 128 ? 255 : 0
  for (let i = 0; i < ring.length; i += 2) {
    const o = (ring[i + 1] * w + ring[i]) * 4
    a[o] = 34
    a[o + 1] = 28
    a[o + 2] = 30
    a[o + 3] = 255
  }
  tc.putImageData(img, 0, 0)
  const out = document.createElement('canvas')
  out.width = size
  out.height = size
  const oc = out.getContext('2d')!
  oc.imageSmoothingEnabled = false
  oc.drawImage(tmp, 0, 0, size, size)
  return out
}
