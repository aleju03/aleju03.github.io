import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/*
  The first-person body: a stubby little service robot built from rounded
  primitives right here, replacing the old skinned GLB. Owning the mesh means
  the head can stay on — the old model's goggle dome clipped the lens, so its
  head was collapsed to nothing and every shadow walked around decapitated.
  This one is proportioned so the head top rides just under and behind the
  camera instead. The walk is hand-animated off the same clock as the
  camera's footstep bob, so the legs scissor exactly in step with the view.
*/

export interface PlayerRig {
  group: THREE.Group
  /** drive the limbs each roam frame; bobT is the shared footstep clock,
      gait 0..1 blends idle into walk, crouchK 0..1 squashes the robot */
  update: (dt: number, bobT: number, gait: number, crouchK: number) => void
}

/** the eye height the proportions below were drawn for; the group scales
    itself so any actual camera height maps onto them */
const DESIGN_EYE = 3.5

export function buildPlayerBody(eye: number): PlayerRig {
  const group = new THREE.Group()
  group.userData.dynamic = true // never caught by the static matrix freeze

  // desk-peripheral palette: keycap cream, dark plastic, one rust accent
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#d9d4c9', roughness: 0.62 })
  const darkMat = new THREE.MeshStandardMaterial({
    color: '#2f3236', roughness: 0.55, metalness: 0.15,
  })
  const accentMat = new THREE.MeshStandardMaterial({ color: '#9d5542', roughness: 0.66 })
  const visorMat = new THREE.MeshStandardMaterial({
    color: '#12161a', roughness: 0.3, metalness: 0.2,
  })
  const eyeMat = new THREE.MeshStandardMaterial({
    color: '#0a0d10', emissive: new THREE.Color('#a9d7ff'),
    emissiveIntensity: 2.2, roughness: 0.4,
  })
  const tipMat = new THREE.MeshStandardMaterial({
    color: '#2c1c08', emissive: new THREE.Color('#ffb869'),
    emissiveIntensity: 1.6, roughness: 0.5,
  })

  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D) => {
    const m = new THREE.Mesh(geo, mat)
    m.castShadow = true
    m.frustumCulled = false // hugs the camera; culling would blink limbs out
    parent.add(m)
    return m
  }

  // torso: cream shell, dark belly screen, one status dot (faces +z)
  const torso = part(new RoundedBoxGeometry(1.1, 1.2, 0.72, 3, 0.18), bodyMat, group)
  torso.position.set(0, 1.62, 0)
  const belly = part(new RoundedBoxGeometry(0.5, 0.42, 0.1, 3, 0.06), visorMat, group)
  belly.position.set(0, 1.52, 0.33)
  const dot = part(new THREE.SphereGeometry(0.05, 10, 8), tipMat, group)
  dot.position.set(0.3, 1.98, 0.35)

  // arms swing from shoulder pivots; accent ball joints cover the seams
  const armGeo = new RoundedBoxGeometry(0.24, 0.9, 0.28, 3, 0.11)
  const handGeo = new THREE.SphereGeometry(0.15, 12, 10)
  const shoulderGeo = new THREE.SphereGeometry(0.17, 12, 10)
  const armPivot = (side: 1 | -1) => {
    const p = new THREE.Group()
    p.position.set(side * 0.66, 2.02, 0)
    part(shoulderGeo, accentMat, p)
    const arm = part(armGeo, darkMat, p)
    arm.position.set(side * 0.04, -0.46, 0)
    const hand = part(handGeo, bodyMat, p)
    hand.position.set(side * 0.04, -0.94, 0)
    group.add(p)
    return p
  }
  const armL = armPivot(1)
  const armR = armPivot(-1)

  // stubby legs from hip pivots, cream toe caps out front
  const legGeo = new RoundedBoxGeometry(0.36, 1.06, 0.44, 3, 0.13)
  const toeGeo = new RoundedBoxGeometry(0.38, 0.2, 0.52, 3, 0.08)
  const legPivot = (side: 1 | -1) => {
    const p = new THREE.Group()
    p.position.set(side * 0.28, 1.08, 0)
    const leg = part(legGeo, darkMat, p)
    leg.position.set(0, -0.56, 0)
    const toe = part(toeGeo, bodyMat, p)
    toe.position.set(0, -1.0, 0.08)
    group.add(p)
    return p
  }
  const legL = legPivot(1)
  const legR = legPivot(-1)

  // the head, on its own pivot for the idle bob; small and set back so it
  // stays out of the first-person frustum instead of being amputated
  const neck = part(new THREE.CylinderGeometry(0.13, 0.15, 0.18, 12), darkMat, group)
  neck.position.set(0, 2.28, -0.04)
  const headPivot = new THREE.Group()
  const HEAD_Y = 2.36
  headPivot.position.set(0, HEAD_Y, 0)
  const head = part(new RoundedBoxGeometry(0.8, 0.62, 0.7, 3, 0.17), bodyMat, headPivot)
  head.position.set(0, 0.33, -0.08)
  const visor = part(new RoundedBoxGeometry(0.56, 0.3, 0.12, 3, 0.06), visorMat, headPivot)
  visor.position.set(0, 0.36, 0.24)
  ;[0.14, -0.14].forEach((x) => {
    const eyeLight = part(new RoundedBoxGeometry(0.11, 0.15, 0.04, 2, 0.02), eyeMat, headPivot)
    eyeLight.position.set(x, 0.36, 0.295)
  })
  const earGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12)
  ;[1, -1].forEach((side) => {
    const ear = part(earGeo, darkMat, headPivot)
    ear.rotation.z = Math.PI / 2
    ear.position.set(side * 0.44, 0.36, -0.08)
  })
  const mast = part(new THREE.CylinderGeometry(0.028, 0.028, 0.3, 8), darkMat, headPivot)
  mast.position.set(0.18, 0.75, -0.22)
  const tip = part(new THREE.SphereGeometry(0.07, 10, 8), tipMat, headPivot)
  tip.position.set(0.18, 0.93, -0.22)
  group.add(headPivot)

  const S = eye / DESIGN_EYE
  group.scale.setScalar(S)

  let t = 0
  const update = (dt: number, bobT: number, gait: number, crouchK: number) => {
    t += dt
    // the camera bobs once per step and a leg cycle is two steps, so the
    // stride runs at half the bob frequency
    const stride = Math.sin(bobT * Math.PI) * 0.6 * gait
    const breathe = Math.sin(t * 1.9) * (1 - gait)
    legL.rotation.x = stride
    legR.rotation.x = -stride
    armL.rotation.x = -stride * 0.8
    armR.rotation.x = stride * 0.8
    armL.rotation.z = 0.06 + breathe * 0.03 // arms drift out on the inhale
    armR.rotation.z = -0.06 - breathe * 0.03
    headPivot.position.y = HEAD_Y + breathe * 0.02
    headPivot.rotation.x = 0.08 * gait // leans the gaze into the walk
    group.scale.y = S * (1 - 0.25 * crouchK) // squats along with the camera
  }

  return { group, update }
}
