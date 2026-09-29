import * as THREE from 'three'
import { propMaterial } from '../art'
import { BatchProxy } from '../batch'
import { KINDS } from '../kinds'
import type { Blueprint } from './blueprint'

/*
  A blueprint's picture: the whole build drawn once, small, as pixel art, and
  handed back as a PNG data URL (a few kilobytes; the server keeps at most
  twenty).

  Drawn the way the spawn menu's icons are (sandbox/thumbnails.ts) and for the
  same reason: in a WebGL context of its own, made for the call and lost at
  the end of it, with a light rig that has nothing to do with the scene's, so
  the programs it links die with the context and the game's cache never hears
  of them. Each prop is placed at its blueprint pose with its kind's own
  geometry on the atlas material, the camera frames the bounding sphere from
  the three-quarter view the icons use, and the result is upscaled
  nearest-neighbour with a one-pixel ring round the silhouette.

  Browser only; anywhere else it resolves to null.
*/

const PIXELS = 56
const SIZE = 96

const geometries = (o: THREE.Object3D | undefined): THREE.BufferGeometry[] => {
  if (!o) return []
  if (o instanceof BatchProxy) return o.geo ? [o.geo] : []
  const out: THREE.BufferGeometry[] = []
  o.traverse((c) => {
    const m = c as THREE.Mesh
    if (m.isMesh) out.push(m.geometry as THREE.BufferGeometry)
  })
  return out
}

export async function blueprintThumb(bp: Blueprint): Promise<string | null> {
  if (typeof document === 'undefined') return null
  let renderer: THREE.WebGLRenderer | null = null
  try {
    const cv = document.createElement('canvas')
    cv.width = PIXELS
    cv.height = PIXELS
    renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.setSize(PIXELS, PIXELS, false)
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xe8eefc, 0x5a4a3a, 1.6))
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.4)
    sun.position.set(-3, 5, 4)
    scene.add(sun)
    const mat = propMaterial()
    const box = new THREE.Box3()
    const one = new THREE.Box3()
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const sc = new THREE.Vector3()
    for (const p of bp.props) {
      const template = KINDS[p.kind]?.mesh?.()
      for (const geo of geometries(template)) {
        const mesh = new THREE.Mesh(geo, mat)
        mesh.matrixAutoUpdate = false
        q.set(p.quat[0], p.quat[1], p.quat[2], p.quat[3])
        sc.setScalar(p.scale)
        mesh.matrix.compose(new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]), q, sc)
        scene.add(mesh)
        geo.computeBoundingBox()
        one.copy(geo.boundingBox!).applyMatrix4(m4.copy(mesh.matrix))
        box.union(one)
      }
    }
    if (box.isEmpty()) return null
    const sph = new THREE.Sphere()
    box.getBoundingSphere(sph)
    const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 2000)
    const d = (sph.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2))) * 1.04
    const dir = new THREE.Vector3(-0.62, 0.48, 0.62).normalize()
    cam.position.copy(sph.center).addScaledVector(dir, d)
    cam.lookAt(sph.center)
    cam.near = Math.max(0.01, d - sph.radius * 2)
    cam.far = d + sph.radius * 2
    cam.updateProjectionMatrix()
    renderer.render(scene, cam)
    return upscale(cv)
  } catch {
    return null
  } finally {
    if (renderer) {
      renderer.dispose()
      renderer.forceContextLoss()
    }
  }
}

/** nearest-neighbour upscale, hard alpha, a one-pixel dark ring round it */
const upscale = (src: HTMLCanvasElement): string => {
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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (solid(x, y)) continue
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) ring.push(x, y)
    }
  }
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
  out.width = SIZE
  out.height = SIZE
  const oc = out.getContext('2d')!
  oc.imageSmoothingEnabled = false
  oc.drawImage(tmp, 0, 0, SIZE, SIZE)
  return out.toDataURL('image/png')
}
