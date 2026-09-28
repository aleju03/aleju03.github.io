import * as THREE from 'three'
import type { Vehicle } from './types'

/*
  The catalogue's plates for the fleet: each machine drawn once, three
  quarters from the front and a little above, into a small transparent
  canvas, the way sandbox/thumbnails.ts draws the props. The machines are
  cloned (the clone shares their geometry and materials), so the live ones
  are never moved, and the drawing happens in a renderer of its own that is
  thrown away after, so nothing here compiles into the scene's context.
  Browser only: with no document there is nothing to draw on.
*/

export const renderFleetThumbs = async (fleet: readonly Vehicle[], size = 96): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  if (typeof document === 'undefined' || !fleet.length) return out
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, alpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(size, size, false)
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xe8eefc, 0x5a4a3a, 1.8))
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6)
  sun.position.set(-3, 5, 4)
  scene.add(sun)
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 400)
  const box = new THREE.Box3()
  const sph = new THREE.Sphere()
  for (const v of fleet) {
    const copy = v.root.clone(true)
    copy.position.set(0, 0, 0)
    copy.rotation.set(0, 0, 0)
    // nobody aboard, and no lights: a plate is the machine alone
    copy.traverse((o) => {
      if ((o as THREE.Light).isLight || (o as THREE.SkinnedMesh).isSkinnedMesh) o.visible = false
    })
    scene.add(copy)
    copy.updateMatrixWorld(true)
    box.setFromObject(copy, true)
    box.getBoundingSphere(sph)
    const d = (sph.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2))) * 0.98
    const dir = new THREE.Vector3(-0.62, 0.42, -0.66).normalize()
    cam.position.copy(sph.center).addScaledVector(dir, d)
    cam.lookAt(sph.center)
    cam.near = Math.max(0.05, d - sph.radius * 2)
    cam.far = d + sph.radius * 2
    cam.updateProjectionMatrix()
    renderer.render(scene, cam)
    out.set(`fleet:${v.id}`, cv.toDataURL('image/png'))
    scene.remove(copy)
    // yield between plates, so four machines are not one long frame
    await new Promise((r) => setTimeout(r, 0))
  }
  renderer.dispose()
  renderer.forceContextLoss()
  return out
}
