import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { ModelLike } from './houseWorld'
import { HOUSE } from './houseWorld'
import { addBoxFrom } from '../physics/collision'

/*
  The desk corner of the bedroom: the desk itself and everything dressed
  around it — the built-in-code keyboard (the GLB's own is a featureless
  slab), the mug, the plant, the rug, the bookshelf, the cork board, the
  low table, the paper stacks. Pure scene construction lifted out of the
  scene shell so CrtScene only keeps what genuinely needs the renderer
  (the tube, the glass punch-through, the lights, the cameras). Also the
  home of the shared wood/glass materials the house builder reuses so the
  rooms match the desk. The computer model itself stays with the scene —
  the screen mesh is the CSS3D anchor — but its slab keyboard and mouse
  are swapped for real ones here via swapPeripherals().
*/

export interface DeskRoomHandles {
  /** world-space height of the desk surface; the room is scaled around it */
  deskTop: number
  /** shared with buildHouse so the house matches the desk */
  darkWoodMat: THREE.MeshStandardMaterial
  windowGlassMat: THREE.MeshStandardMaterial
  /** hide the computer GLB's slab keyboard/mouse, seat real ones instead */
  swapPeripherals: (
    oldKeyboard: THREE.Mesh | null,
    oldMouse: THREE.Mesh | null,
    mouse: ModelLike,
  ) => void
}

interface BuildOpts {
  scene: THREE.Scene
  /** solids that should block the first-person walk register an AABB here */
  obstacles: THREE.Box3[]
  desk: ModelLike
  mug: ModelLike
  plant: ModelLike
}

export function buildDeskRoom({ scene, obstacles, desk, mug, plant }: BuildOpts): DeskRoomHandles {
  desk.scene.scale.setScalar(2.0)
  desk.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
  })
  scene.add(desk.scene)
  const deskTop = new THREE.Box3().setFromObject(desk.scene).max.y
  // the walkable strip the desk denies runs all the way back to the wall
  const deskBlock = new THREE.Box3().setFromObject(desk.scene).expandByScalar(0.35)
  deskBlock.min.z = -10
  obstacles.push(deskBlock)

  const makeBox = (w: number, h: number, d: number, material: THREE.Material, castShadow = true) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    mesh.castShadow = castShadow
    mesh.receiveShadow = true
    return mesh
  }
  const makeRounded = (
    w: number,
    h: number,
    d: number,
    radius: number,
    material: THREE.Material,
    castShadow = true,
  ) => {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, radius), material)
    mesh.castShadow = castShadow
    mesh.receiveShadow = true
    return mesh
  }

  const darkWoodMat = new THREE.MeshStandardMaterial({ color: '#332417', roughness: 0.84 })
  const warmWoodMat = new THREE.MeshStandardMaterial({ color: '#6a4a2f', roughness: 0.78 })
  const paperMat = new THREE.MeshStandardMaterial({ color: '#d8c7a7', roughness: 0.86 })
  const blackPlasticMat = new THREE.MeshStandardMaterial({
    color: '#17191b',
    roughness: 0.64,
    metalness: 0.05,
  })
  const keycapMat = new THREE.MeshStandardMaterial({ color: '#d9d4c9', roughness: 0.58 })
  const darkKeyMat = new THREE.MeshStandardMaterial({ color: '#3a3d40', roughness: 0.62 })
  const accentKeyMat = new THREE.MeshStandardMaterial({ color: '#9d5542', roughness: 0.66 })
  const rugMat = new THREE.MeshStandardMaterial({ color: '#56382e', roughness: 0.92 })
  const rugTrimMat = new THREE.MeshStandardMaterial({ color: '#b18b5b', roughness: 0.9 })
  const glassBlueMat = new THREE.MeshStandardMaterial({
    color: '#203654',
    roughness: 0.28,
    metalness: 0,
    emissive: new THREE.Color('#152944'),
    emissiveIntensity: 0.08,
  })
  const windowGlassMat = new THREE.MeshStandardMaterial({
    color: '#8fb4d8',
    roughness: 0.16,
    metalness: 0,
    emissive: new THREE.Color('#28415e'),
    emissiveIntensity: 0.18,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const bookMats = ['#b75b4e', '#4e6f8f', '#d0a64f', '#59784f', '#6c537b'].map(
    (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.78 }),
  )

  // a proper standalone model seated on the old slab's footprint
  const swapIn = (group: THREE.Group, old: THREE.Mesh | null, rotY: number, grow: number) => {
    if (!old) return
    const oldBox = new THREE.Box3().setFromObject(old)
    const oldSize = oldBox.getSize(new THREE.Vector3())
    old.visible = false
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3())
    group.scale.setScalar((grow * Math.max(oldSize.x, oldSize.z)) / Math.max(size.x, size.z))
    group.rotation.y = rotY
    group.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(group)
    const c = oldBox.getCenter(new THREE.Vector3())
    const nc = box.getCenter(new THREE.Vector3())
    group.position.set(c.x - nc.x, deskTop - box.min.y, c.z - nc.z)
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true
    })
    scene.add(group)
  }
  const buildKeyboard = (old: THREE.Mesh | null) => {
    if (!old) return
    const oldBox = new THREE.Box3().setFromObject(old)
    const oldSize = oldBox.getSize(new THREE.Vector3())
    const oldCenter = oldBox.getCenter(new THREE.Vector3())
    old.visible = false

    const width = oldSize.x * 1.12
    const depth = oldSize.z * 1.16
    const baseH = Math.max(0.07, Math.min(0.14, oldSize.y * 0.55))
    const keyH = baseH * 0.48
    const group = new THREE.Group()
    const base = makeRounded(width, baseH, depth, baseH * 0.45, blackPlasticMat)
    base.position.y = baseH / 2
    group.add(base)

    const padX = width * 0.08
    const padZ = depth * 0.15
    const stepX = (width - padX * 2) / 14
    const stepZ = (depth - padZ * 2) / 5
    const keyW = stepX * 0.78
    const keyD = stepZ * 0.64
    const rows = [
      { count: 14, shift: 0 },
      { count: 14, shift: 0.08 },
      { count: 13, shift: 0.22 },
      { count: 12, shift: 0.38 },
    ]
    const standardKeys: Array<[number, number, number]> = []
    rows.forEach((row, rowIndex) => {
      const startX = -((row.count - 1) * stepX) / 2 + row.shift * stepX
      const z = -depth / 2 + padZ + stepZ * (rowIndex + 0.5)
      for (let i = 0; i < row.count; i++) {
        standardKeys.push([startX + i * stepX, baseH + keyH / 2, z])
      }
    })
    const capGeo = new RoundedBoxGeometry(keyW, keyH, keyD, 3, Math.min(keyW, keyD) * 0.18)
    const capMesh = new THREE.InstancedMesh(capGeo, keycapMat, standardKeys.length)
    const capMatrix = new THREE.Matrix4()
    standardKeys.forEach(([x, y, z], i) => {
      capMatrix.makeTranslation(x, y, z)
      capMesh.setMatrixAt(i, capMatrix)
    })
    capMesh.instanceMatrix.needsUpdate = true
    capMesh.receiveShadow = true
    group.add(capMesh)

    const addKey = (x: number, z: number, w: number, material: THREE.Material, d = keyD) => {
      const key = makeRounded(w, keyH, d, Math.min(w, d) * 0.16, material, false)
      key.position.set(x, baseH + keyH / 2, z)
      group.add(key)
    }
    const bottomZ = -depth / 2 + padZ + stepZ * 4.45
    addKey(-width * 0.39, bottomZ, keyW * 1.25, darkKeyMat)
    addKey(-width * 0.27, bottomZ, keyW * 1.1, darkKeyMat)
    addKey(-width * 0.04, bottomZ, keyW * 4.1, keycapMat)
    addKey(width * 0.24, bottomZ, keyW * 1.2, darkKeyMat)
    addKey(width * 0.36, bottomZ, keyW * 1.2, darkKeyMat)
    addKey(-width * 0.45, -depth / 2 + padZ + stepZ * 0.5, keyW, accentKeyMat)

    const ledGeo = new THREE.SphereGeometry(Math.max(0.018, keyW * 0.1), 10, 6)
    ;[
      [-width * 0.39, -depth * 0.41],
      [-width * 0.34, -depth * 0.41],
    ].forEach(([x, z]) => {
      const led = new THREE.Mesh(ledGeo, glassBlueMat)
      led.position.set(x, baseH + keyH * 1.15, z)
      group.add(led)
    })

    group.position.set(oldCenter.x, deskTop + 0.008, oldCenter.z)
    group.updateMatrixWorld(true)
    scene.add(group)
  }

  mug.scene.scale.setScalar(0.85)
  mug.scene.position.set(-1.25, deskTop, 0.45)
  mug.scene.rotation.y = 2.4
  mug.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  scene.add(mug.scene)
  plant.scene.scale.setScalar(0.5)
  plant.scene.position.set(1.05, deskTop, 0.62)
  plant.scene.rotation.y = -0.6
  plant.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  scene.add(plant.scene)

  const rug = new THREE.Group()
  const rugBase = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 3.25), rugMat)
  rugBase.rotation.x = -Math.PI / 2
  rugBase.position.set(0.25, 0.012, 4.55)
  rugBase.receiveShadow = true
  rug.add(rugBase)
  const rugTrim = [
    [4.9, 0.025, 0.07, 0.25, 0.024, 2.95],
    [4.9, 0.025, 0.07, 0.25, 0.024, 6.15],
    [0.07, 0.025, 3.25, -2.2, 0.024, 4.55],
    [0.07, 0.025, 3.25, 2.7, 0.024, 4.55],
  ] as const
  rugTrim.forEach(([w, h, d, x, y, z]) => {
    const trim = makeBox(w, h, d, rugTrimMat, false)
    trim.position.set(x, y, z)
    rug.add(trim)
  })
  scene.add(rug)

  const shelf = new THREE.Group()
  const shelfHeights = [0.38, 0.88, 1.38, 1.88]
  const shelfParts = [
    makeBox(0.42, 2.35, 0.08, darkWoodMat),
    makeBox(0.42, 2.35, 0.08, darkWoodMat),
    makeBox(0.06, 2.35, 2.82, darkWoodMat),
  ]
  shelfParts[0].position.set(0, 1.18, -1.4)
  shelfParts[1].position.set(0, 1.18, 1.4)
  shelfParts[2].position.set(0.24, 1.18, 0)
  shelfParts.forEach((part) => shelf.add(part))
  shelfHeights.forEach((y) => {
    const board = makeBox(0.48, 0.08, 2.9, warmWoodMat)
    board.position.set(0, y, 0)
    shelf.add(board)
  })
  shelfHeights.slice(0, -1).forEach((y, row) => {
    for (let i = 0; i < 12; i++) {
      const bookH = 0.28 + ((i + row) % 5) * 0.035
      const book = makeBox(0.22, bookH, 0.055, bookMats[(i + row) % bookMats.length], false)
      book.position.set(-0.03, y + 0.06 + bookH / 2, -1.16 + i * 0.18)
      book.rotation.x = ((i % 3) - 1) * 0.035
      shelf.add(book)
    }
  })
  shelf.position.set(HOUSE.maxX - 0.38, 0, 6.45)
  scene.add(shelf)
  addBoxFrom(obstacles, shelf, 0.2)

  const cork = new THREE.Group()
  const corkMat = new THREE.MeshStandardMaterial({ color: '#6a432c', roughness: 0.92 })
  const pinMat = new THREE.MeshStandardMaterial({
    color: '#d3a34f',
    roughness: 0.38,
    metalness: 0.25,
  })
  const board = makeBox(2.5, 1.48, 0.04, corkMat, false)
  cork.add(board)
  ;[
    [2.66, 0.09, 0.08, 0, 0.78, 0.04],
    [2.66, 0.09, 0.08, 0, -0.78, 0.04],
    [0.09, 1.56, 0.08, -1.33, 0, 0.04],
    [0.09, 1.56, 0.08, 1.33, 0, 0.04],
  ].forEach(([w, h, d, x, y, z]) => {
    const rail = makeBox(w, h, d, darkWoodMat, false)
    rail.position.set(x, y, z)
    cork.add(rail)
  })
  const pinGeo = new THREE.SphereGeometry(0.035, 12, 8)
  const pinPoints: THREE.Vector3[] = []
  const notes: Array<{
    x: number
    y: number
    w: number
    h: number
    rot: number
    material: THREE.Material
  }> = [
    { x: -0.62, y: 0.3, w: 0.48, h: 0.36, rot: -0.06, material: paperMat },
    { x: 0.16, y: 0.34, w: 0.38, h: 0.5, rot: 0.035, material: bookMats[2] },
    { x: 0.72, y: -0.08, w: 0.5, h: 0.35, rot: -0.025, material: paperMat },
    { x: -0.12, y: -0.3, w: 0.6, h: 0.28, rot: 0.02, material: bookMats[1] },
  ]
  notes.forEach((noteDef) => {
    const note = makeBox(noteDef.w, noteDef.h, 0.03, noteDef.material, false)
    note.position.set(noteDef.x, noteDef.y, 0.06)
    note.rotation.z = noteDef.rot
    cork.add(note)
    const pin = new THREE.Mesh(pinGeo, pinMat)
    pin.position.set(noteDef.x - noteDef.w * 0.34, noteDef.y + noteDef.h * 0.34, 0.095)
    pin.castShadow = false
    pin.receiveShadow = true
    pinPoints.push(pin.position.clone())
    cork.add(pin)
  })
  const stringMat = new THREE.MeshStandardMaterial({ color: '#c28f5a', roughness: 0.72 })
  const addString = (a: THREE.Vector3, b: THREE.Vector3) => {
    const mid = a.clone().lerp(b, 0.5)
    mid.y -= 0.05
    const string = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, mid, b]), 8, 0.006, 4, false),
      stringMat,
    )
    string.castShadow = false
    cork.add(string)
  }
  addString(pinPoints[0], pinPoints[1])
  addString(pinPoints[1], pinPoints[3])
  // scooted toward the door: the bed's wall real estate is spoken for
  cork.position.set(0.2, 3.15, 10.5 - 0.045)
  cork.rotation.y = Math.PI
  scene.add(cork)

  const lowTable = new THREE.Group()
  const tableTop = makeBox(1.15, 0.12, 0.72, warmWoodMat)
  tableTop.position.y = 0.58
  lowTable.add(tableTop)
  ;[
    [-0.46, 0.28],
    [0.46, 0.28],
    [-0.46, -0.28],
    [0.46, -0.28],
  ].forEach(([x, z]) => {
    const leg = makeBox(0.08, 0.58, 0.08, darkWoodMat)
    leg.position.set(x, 0.29, z)
    lowTable.add(leg)
  })
  const stackA = makeBox(0.44, 0.055, 0.32, paperMat, false)
  stackA.position.set(-0.18, 0.68, -0.05)
  lowTable.add(stackA)
  const stackB = makeBox(0.39, 0.05, 0.28, bookMats[0], false)
  stackB.position.set(-0.16, 0.735, -0.03)
  lowTable.add(stackB)
  lowTable.position.set(HOUSE.minX + 1.05, 0, 3.2)
  lowTable.rotation.y = 0.15
  scene.add(lowTable)
  addBoxFrom(obstacles, lowTable, 0.18)

  const deskStack = new THREE.Group()
  let stackY = 0.012
  ;[
    [0.55, 0.055, 0.38, paperMat],
    [0.5, 0.05, 0.34, bookMats[3]],
    [0.45, 0.045, 0.32, bookMats[4]],
  ].forEach(([w, h, d, material]) => {
    const item = makeBox(w as number, h as number, d as number, material as THREE.Material, false)
    item.position.y = stackY + (h as number) / 2
    stackY += h as number
    deskStack.add(item)
  })
  deskStack.position.set(-1.55, deskTop, -0.42)
  deskStack.rotation.y = -0.18
  scene.add(deskStack)

  return {
    deskTop,
    darkWoodMat,
    windowGlassMat,
    swapPeripherals: (oldKeyboard, oldMouse, mouse) => {
      buildKeyboard(oldKeyboard)
      // The standalone mouse's button end is +Z; on the desk it should face
      // the monitor, which sits behind the keyboard on -Z.
      swapIn(mouse.scene, oldMouse, Math.PI, 1.0)
    },
  }
}
