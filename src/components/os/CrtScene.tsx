import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js'

/*
  The physical machine, for real this time: a WebGL night-desk scene and a
  CSS3D layer sharing one camera, so the live AlejOS DOM is mapped onto the
  monitor glass and stays fully interactive there. The glass mesh is drawn
  with a no-blending near-transparent material that punches a window through
  the WebGL canvas to the DOM behind it (the Henry Heffernan / ryOS-style
  trick). The camera pushes in on power-on, pulls back on shutdown, and while
  you use the OS nothing 3D renders at all: the loop is suspended and the
  screen is plain DOM. The desk lives in a small enclosed room: in roam mode
  you stand up from the chair and walk it first-person, WASD to move, mouse
  to look (pointer lock on click, drag works too), and an interact prompt at
  the machine sits you back down, booting it first if the tube is cold.

  Models are CC assets, see public/os/models/LICENSE.md (computer by Charlie
  CC BY 3.0, desk/mug/plant by Quaternius and Kenney CC0). If WebGL or the
  GLBs fail, onFail lets AlejOS fall back to the flat bezel mode.
*/

interface CrtSceneProps {
  /** true once the OS is shutting down: plays the camera pull-back */
  off: boolean
  /** standing up: the room is walkable first-person */
  roam: boolean
  /** roaming with the OS still running, so the tube stays lit and glowing */
  screenLive: boolean
  /** pressed the interact key at the machine: sit down (and boot if cold) */
  onInteract: () => void
  onFail: () => void
  children: ReactNode
}

const EASE = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const MODELS = [
  '/os/models/computer.glb',
  '/os/models/desk.glb',
  '/os/models/mug.glb',
  '/os/models/plant.glb',
  '/os/models/mouse.glb',
  '/os/models/lamp.glb',
  '/os/models/player.glb',
]
/** fraction of the viewport height the glass fills once parked */
const FILL = 0.86
const INTRO_S = 2.6
const WINDOW_CENTER_Y = 3.3
const WINDOW_CENTER_Z = 5.75
const WINDOW_HOLE_W = 1.78
const WINDOW_HOLE_H = 1.14

const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}

const makeExteriorTexture = () => {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const w = canvas.width
    const h = canvas.height
    const rand = seeded(0x51d3)
    const sky = ctx.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#071125')
    sky.addColorStop(0.46, '#172b49')
    sky.addColorStop(0.74, '#43516c')
    sky.addColorStop(1, '#1b2638')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)

    const moon = ctx.createRadialGradient(390, 58, 2, 390, 58, 72)
    moon.addColorStop(0, 'rgba(242,232,193,0.95)')
    moon.addColorStop(0.12, 'rgba(242,232,193,0.4)')
    moon.addColorStop(1, 'rgba(242,232,193,0)')
    ctx.fillStyle = moon
    ctx.fillRect(300, 0, 200, 150)
    ctx.fillStyle = 'rgba(245,236,207,0.8)'
    ctx.beginPath()
    ctx.arc(390, 58, 15, 0, Math.PI * 2)
    ctx.fill()

    for (let i = 0; i < 90; i++) {
      const x = rand() * w
      const y = rand() * h * 0.55
      const a = 0.18 + rand() * 0.62
      ctx.fillStyle = `rgba(224,236,255,${a})`
      ctx.fillRect(x, y, rand() < 0.08 ? 2 : 1, 1)
    }

    const drawRidge = (base: number, amp: number, color: string, points: number) => {
      ctx.beginPath()
      ctx.moveTo(0, h)
      ctx.lineTo(0, base)
      for (let i = 0; i <= points; i++) {
        const x = (i / points) * w
        const y =
          base -
          Math.sin(i * 0.85 + 0.6) * amp * 0.42 -
          rand() * amp
        ctx.lineTo(x, y)
      }
      ctx.lineTo(w, h)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }
    drawRidge(166, 23, '#1f3149', 14)
    drawRidge(184, 16, '#142338', 18)

    const glow = ctx.createLinearGradient(0, 122, 0, 224)
    glow.addColorStop(0, 'rgba(243,170,92,0)')
    glow.addColorStop(0.52, 'rgba(243,170,92,0.16)')
    glow.addColorStop(1, 'rgba(243,170,92,0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 122, w, 102)

    ctx.fillStyle = '#0b1525'
    for (let x = -10; x < w; x += 24 + rand() * 18) {
      const bw = 16 + rand() * 26
      const bh = 28 + rand() * 72
      ctx.fillRect(x, 198 - bh, bw, bh)
      if (rand() > 0.62) ctx.fillRect(x + bw * 0.4, 198 - bh - 12, bw * 0.2, 12)
      ctx.fillStyle = `rgba(246,205,128,${0.35 + rand() * 0.34})`
      for (let wx = x + 4; wx < x + bw - 3; wx += 7) {
        for (let wy = 198 - bh + 7; wy < 191; wy += 10) {
          if (rand() > 0.7) ctx.fillRect(wx, wy, 2, 3)
        }
      }
      ctx.fillStyle = '#0b1525'
    }

    ctx.fillStyle = '#0a1020'
    ctx.beginPath()
    ctx.moveTo(0, 207)
    ctx.bezierCurveTo(90, 202, 148, 217, 225, 209)
    ctx.bezierCurveTo(320, 197, 406, 213, 512, 203)
    ctx.lineTo(512, 256)
    ctx.lineTo(0, 256)
    ctx.closePath()
    ctx.fill()

    ctx.strokeStyle = 'rgba(141,172,211,0.23)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(36, 252)
    ctx.bezierCurveTo(155, 222, 307, 232, 484, 210)
    ctx.stroke()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

const makeMoonSpillTexture = () => {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.filter = 'blur(14px)'
    const wash = ctx.createRadialGradient(102, 58, 8, 108, 58, 112)
    wash.addColorStop(0, 'rgba(130,180,255,0.52)')
    wash.addColorStop(0.34, 'rgba(100,155,235,0.24)')
    wash.addColorStop(1, 'rgba(100,155,235,0)')
    ctx.fillStyle = wash
    ctx.fillRect(-24, -18, 300, 170)
    ctx.globalCompositeOperation = 'screen'
    ctx.fillStyle = 'rgba(150,198,255,0.18)'
    ctx.beginPath()
    ctx.moveTo(18, 34)
    ctx.lineTo(210, 8)
    ctx.lineTo(244, 30)
    ctx.lineTo(48, 76)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(4, 94)
    ctx.lineTo(192, 44)
    ctx.lineTo(236, 66)
    ctx.lineTo(42, 126)
    ctx.closePath()
    ctx.fill()
    ctx.filter = 'none'
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

const addExteriorWorld = (
  windowFrame: THREE.Group,
  trackDisposable: (disposable: { dispose: () => void }) => void,
  trackTexture: (texture: THREE.Texture) => void,
) => {
  const backdropTexture = makeExteriorTexture()
  trackDisposable(backdropTexture)
  trackTexture(backdropTexture)

  const backdropMat = new THREE.MeshBasicMaterial({
    map: backdropTexture,
    fog: false,
    side: THREE.FrontSide,
  })
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(7.8, 4.3), backdropMat)
  backdrop.position.set(0, 0.32, -5.8)
  backdrop.renderOrder = 1
  windowFrame.add(backdrop)

  const tmpMatrix = new THREE.Matrix4()
  const tmpPos = new THREE.Vector3()
  const tmpScale = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  const tmpEuler = new THREE.Euler()
  const setPlane = (
    mesh: THREE.InstancedMesh,
    i: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    rot = 0,
  ) => {
    tmpPos.set(x, y, z)
    tmpScale.set(sx, sy, 1)
    tmpQuat.setFromEuler(tmpEuler.set(0, 0, rot))
    mesh.setMatrixAt(i, tmpMatrix.compose(tmpPos, tmpQuat, tmpScale))
  }
  const setBox = (
    mesh: THREE.InstancedMesh,
    i: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rotY = 0,
  ) => {
    tmpPos.set(x, y, z)
    tmpScale.set(sx, sy, sz)
    tmpQuat.setFromEuler(tmpEuler.set(0, rotY, 0))
    mesh.setMatrixAt(i, tmpMatrix.compose(tmpPos, tmpQuat, tmpScale))
  }

  const rand = seeded(0xa11e)
  const planeGeo = new THREE.PlaneGeometry(1, 1)
  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const farMat = new THREE.MeshStandardMaterial({
    color: '#09182a',
    roughness: 0.9,
    emissive: '#050c16',
    emissiveIntensity: 0.45,
    fog: false,
  })
  const midMat = new THREE.MeshStandardMaterial({
    color: '#112b46',
    roughness: 0.86,
    emissive: '#081523',
    emissiveIntensity: 0.5,
    fog: false,
  })
  const buildingDefs: Array<{
    x: number
    y: number
    z: number
    w: number
    h: number
    d: number
    mat: 0 | 1 | 2
  }> = []

  for (let i = 0; i < 18; i++) {
    const z = -13 + rand() * 3.2
    const w = 0.65 + rand() * 1.05
    const h = 1.3 + rand() * 2.1
    buildingDefs.push({
      x: -7.2 + i * 0.84 + (rand() - 0.5) * 0.38,
      y: -0.72 + h / 2,
      z,
      w,
      h,
      d: 0.6 + rand() * 1.0,
      mat: 0,
    })
  }
  for (let i = 0; i < 12; i++) {
    const z = -8.4 + rand() * 1.8
    const w = 0.46 + rand() * 0.76
    const h = 0.95 + rand() * 1.75
    buildingDefs.push({
      x: -5 + i * 0.86 + (rand() - 0.5) * 0.25,
      y: -0.78 + h / 2,
      z,
      w,
      h,
      d: 0.5 + rand() * 0.85,
      mat: 1,
    })
  }
  const mats = [farMat, midMat]
  mats.forEach((mat, matIndex) => {
    const defs = buildingDefs.filter((b) => b.mat === matIndex)
    const buildings = new THREE.InstancedMesh(boxGeo, mat, defs.length)
    defs.forEach((b, i) => setBox(buildings, i, b.x, b.y, b.z, b.w, b.h, b.d, (rand() - 0.5) * 0.08))
    buildings.instanceMatrix.needsUpdate = true
    buildings.renderOrder = 2 + matIndex
    windowFrame.add(buildings)
  })

  const windowMat = new THREE.MeshBasicMaterial({
    color: '#ffc96d',
    fog: false,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  })
  const lightSlots: Array<{ x: number; y: number; z: number; sx: number; sy: number }> = []
  buildingDefs.forEach((b) => {
    const cols = Math.max(1, Math.floor(b.w / 0.12))
    const rows = Math.max(1, Math.floor(b.h / 0.16))
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        if (rand() < 0.62) continue
        lightSlots.push({
          x: b.x - b.w * 0.34 + (cols === 1 ? 0 : (cx / (cols - 1)) * b.w * 0.68),
          y: b.y - b.h * 0.38 + (rows === 1 ? 0 : (cy / (rows - 1)) * b.h * 0.7),
          z: b.z + b.d / 2 + 0.012,
          sx: 0.032 + rand() * 0.02,
          sy: 0.04 + rand() * 0.03,
        })
      }
    }
  })
  const lights = new THREE.InstancedMesh(planeGeo, windowMat, Math.min(150, lightSlots.length))
  for (let i = 0; i < lights.count; i++) {
    const light = lightSlots[i]
    setPlane(lights, i, light.x, light.y, light.z, light.sx, light.sy)
  }
  lights.instanceMatrix.needsUpdate = true
  lights.renderOrder = 6
  windowFrame.add(lights)

  windowFrame.traverse((o) => {
    if (o !== windowFrame) o.frustumCulled = false
  })
}

export default function CrtScene({
  off,
  roam,
  screenLive,
  onInteract,
  onFail,
  children,
}: CrtSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [screenEl, setScreenEl] = useState<HTMLDivElement | null>(null)
  const [intro, setIntro] = useState(true)
  // walking = first-person controls are live (the stand-up glide is done),
  // near = close enough to the machine for the interact prompt
  const [walking, setWalking] = useState(false)
  const [near, setNear] = useState(false)
  const [locked, setLocked] = useState(false)
  const outroRef = useRef<(() => void) | null>(null)
  const roamRef = useRef<((on: boolean) => void) | null>(null)
  const failRef = useRef(onFail)
  const interactRef = useRef(onInteract)
  const liveRef = useRef(screenLive)
  useEffect(() => {
    failRef.current = onFail
    interactRef.current = onInteract
    liveRef.current = screenLive
  })

  useEffect(() => {
    if (off) outroRef.current?.()
  }, [off])

  useEffect(() => {
    roamRef.current?.(roam)
  }, [roam])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false
    let raf = 0
    let webgl: THREE.WebGLRenderer | null = null
    let scene: THREE.Scene | null = null
    let cleanupDom: (() => void) | null = null
    const runtimeDisposables: Array<{ dispose: () => void }> = []
    const runtimeTextures: THREE.Texture[] = []

    const bail = setTimeout(() => {
      if (!webgl) failRef.current()
    }, 6000)

    const loader = new GLTFLoader()
    const load = (url: string) =>
      new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) =>
        loader.load(url, resolve, undefined, reject),
      )

    Promise.all(MODELS.map(load))
      .then(([computer, desk, mug, plant, mouse, lamp, player]) => {
        clearTimeout(bail)
        if (disposed) return

        const W = mount.clientWidth
        const H = mount.clientHeight
        webgl = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance',
        })
        const PR_CAP = Math.min(window.devicePixelRatio, 2)
        webgl.setPixelRatio(PR_CAP)
        webgl.setSize(W, H)
        webgl.shadowMap.enabled = true
        // PCFSoft is less prone to the blotchy VSM halos that show up around
        // thin desk legs and chair casters on the dark floor.
        webgl.shadowMap.type = THREE.PCFSoftShadowMap
        // the scene is static except the player body, so shadow maps are baked
        // once and re-rendered only on frames where a caster actually moved
        webgl.shadowMap.autoUpdate = false
        webgl.toneMapping = THREE.ACESFilmicToneMapping
        webgl.toneMappingExposure = 1.1
        webgl.domElement.style.position = 'absolute'
        webgl.domElement.style.inset = '0'
        webgl.domElement.style.pointerEvents = 'none'

        const css3d = new CSS3DRenderer()
        css3d.setSize(W, H)
        css3d.domElement.style.position = 'absolute'
        css3d.domElement.style.inset = '0'
        css3d.domElement.style.pointerEvents = 'none'

        // DOM order: CSS3D below, WebGL canvas above with a hole in the glass
        mount.appendChild(css3d.domElement)
        mount.appendChild(webgl.domElement)
        cleanupDom = () => {
          if (css3d.domElement.parentElement === mount) mount.removeChild(css3d.domElement)
          if (webgl && webgl.domElement.parentElement === mount) mount.removeChild(webgl.domElement)
        }

        scene = new THREE.Scene()
        scene.background = new THREE.Color('#0a0908')
        // gentle enough that the far corners of the room survive a walk-around
        scene.fog = new THREE.Fog('#0a0908', 10, 27)

        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(30, 30),
          new THREE.MeshStandardMaterial({ color: '#2a2018', roughness: 0.95 }),
        )
        floor.rotation.x = -Math.PI / 2
        floor.receiveShadow = true
        scene.add(floor)
        const wall = new THREE.Mesh(
          new THREE.PlaneGeometry(30, 12),
          new THREE.MeshStandardMaterial({ color: '#3d3328', roughness: 1 }),
        )
        wall.position.set(0, 6, -1.75)
        wall.receiveShadow = true
        scene.add(wall)

        // the rest of the shell, so standing up reveals a room and not a void
        const ROOM = { minX: -7.6, maxX: 7.6, minZ: -1.75, maxZ: 10.5, h: 6 }
        const shell = (
          w: number,
          h: number,
          pos: [number, number, number],
          rot: [number, number],
          color: string,
        ) => {
          const m = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            new THREE.MeshStandardMaterial({ color, roughness: 1 }),
          )
          m.position.set(...pos)
          m.rotation.set(rot[0], rot[1], 0)
          m.receiveShadow = true
          scene?.add(m)
        }
        const depth = ROOM.maxZ - ROOM.minZ
        const midZ = (ROOM.minZ + ROOM.maxZ) / 2
        const windowCut = {
          z0: WINDOW_CENTER_Z - WINDOW_HOLE_W / 2,
          z1: WINDOW_CENTER_Z + WINDOW_HOLE_W / 2,
          y0: WINDOW_CENTER_Y - WINDOW_HOLE_H / 2,
          y1: WINDOW_CENTER_Y + WINDOW_HOLE_H / 2,
        }
        const leftWall = (z0: number, z1: number, y0: number, y1: number) => {
          if (z1 <= z0 || y1 <= y0) return
          shell(z1 - z0, y1 - y0, [ROOM.minX, (y0 + y1) / 2, (z0 + z1) / 2], [0, Math.PI / 2], '#4a3d30')
        }
        leftWall(ROOM.minZ, ROOM.maxZ, 0, windowCut.y0)
        leftWall(ROOM.minZ, ROOM.maxZ, windowCut.y1, ROOM.h)
        leftWall(ROOM.minZ, windowCut.z0, windowCut.y0, windowCut.y1)
        leftWall(windowCut.z1, ROOM.maxZ, windowCut.y0, windowCut.y1)
        shell(depth, ROOM.h, [ROOM.maxX, ROOM.h / 2, midZ], [0, -Math.PI / 2], '#4a3d30')
        shell(ROOM.maxX - ROOM.minX, ROOM.h, [0, ROOM.h / 2, ROOM.maxZ], [0, Math.PI], '#50412f')
        shell(ROOM.maxX - ROOM.minX, depth, [0, ROOM.h, midZ], [Math.PI / 2, 0], '#3a3129')

        // skirting boards: bare planes meeting bare planes reads like a game
        // box, a dark baseboard line grounds every wall
        const skirtMat = new THREE.MeshStandardMaterial({ color: '#241c14', roughness: 0.9 })
        const skirt = (w: number, x: number, z: number, rotY: number) => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.17, 0.06), skirtMat)
          m.position.set(x, 0.085, z)
          m.rotation.y = rotY
          m.receiveShadow = true
          scene?.add(m)
        }
        skirt(ROOM.maxX - ROOM.minX, 0, ROOM.minZ + 0.035, 0)
        skirt(ROOM.maxX - ROOM.minX, 0, ROOM.maxZ - 0.035, 0)
        skirt(depth, ROOM.minX + 0.035, midZ, Math.PI / 2)
        skirt(depth, ROOM.maxX - 0.035, midZ, Math.PI / 2)

        // the pendant lamp the room light actually comes from; its bulb
        // material glows once the roam fill ramps in
        lamp.scene.scale.setScalar(1.6)
        lamp.scene.position.set(0, ROOM.h, 4.4)
        let bulbMat: THREE.MeshStandardMaterial | null = null
        lamp.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats) {
            const std = m as THREE.MeshStandardMaterial
            if (std.name === 'Light') {
              std.emissive = new THREE.Color('#ffe0b0')
              std.emissiveIntensity = 0
              bulbMat = std
            }
          }
        })
        scene.add(lamp.scene)

        desk.scene.scale.setScalar(2.0)
        desk.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true
            o.receiveShadow = true
          }
        })
        scene.add(desk.scene)
        const deskTop = new THREE.Box3().setFromObject(desk.scene).max.y
        // solids that should block the first-person walk register an AABB here
        const obstacles: THREE.Box3[] = []
        const addObstacleFrom = (obj: THREE.Object3D, pad = 0.2) => {
          obj.updateMatrixWorld(true)
          obstacles.push(new THREE.Box3().setFromObject(obj).expandByScalar(pad))
        }
        const makeBox = (
          w: number,
          h: number,
          d: number,
          material: THREE.Material,
          castShadow = true,
        ) => {
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
        const chairMat = new THREE.MeshStandardMaterial({ color: '#243139', roughness: 0.8 })
        const chairMetalMat = new THREE.MeshStandardMaterial({
          color: '#74716a',
          roughness: 0.35,
          metalness: 0.55,
        })
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

        computer.scene.scale.setScalar(16)
        computer.scene.position.set(0, deskTop, 0.05)
        let screenText: THREE.Mesh | null = null
        let screenGlass: THREE.Mesh | null = null
        let oldKeyboard: THREE.Mesh | null = null
        let oldMouse: THREE.Mesh | null = null
        computer.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.castShadow = true
          // cast only: receiving its own VSM shadow paints wavy acne over
          // the curved bezel, and nothing meaningful shadows the machine
          mesh.receiveShadow = false
          if (mesh.name === 'screen_text') screenText = mesh
          if (mesh.name === 'monitor_2') screenGlass = mesh
          if (mesh.name === 'keyboard') oldKeyboard = mesh
          if (mesh.name === 'mouse') oldMouse = mesh
        })
        scene.add(computer.scene)
        computer.scene.updateMatrixWorld(true)
        if (screenText) (screenText as THREE.Mesh).visible = false
        if (!screenGlass) throw new Error('screen mesh missing')
        const glass: THREE.Mesh = screenGlass

        // the keyboard and mouse baked into the computer model are featureless
        // slabs; swap each for a proper standalone model on the same footprint
        const swapIn = (group: THREE.Group, old: THREE.Mesh | null, rotY: number, grow: number) => {
          if (!old || !scene) return
          const oldBox = new THREE.Box3().setFromObject(old)
          const oldSize = oldBox.getSize(new THREE.Vector3())
          old.visible = false
          const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3())
          group.scale.setScalar(
            (grow * Math.max(oldSize.x, oldSize.z)) / Math.max(size.x, size.z),
          )
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
          if (!old || !scene) return
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

          const addKey = (
            x: number,
            z: number,
            w: number,
            material: THREE.Material,
            d = keyD,
          ) => {
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
        buildKeyboard(oldKeyboard)
        // The standalone mouse's button end is +Z; on the desk it should face
        // the monitor, which sits behind the keyboard on -Z.
        swapIn(mouse.scene, oldMouse, Math.PI, 1.0)

        // the punch-through: NoBlending writes a near-zero alpha straight into
        // the canvas, opening a tinted window onto the CSS3D layer behind
        glass.material = new THREE.MeshBasicMaterial({
          color: 0x000000,
          opacity: 0.07,
          blending: THREE.NoBlending,
          side: THREE.DoubleSide,
        })
        glass.castShadow = false

        // glass front center + facing direction, measured off the actual mesh
        // (the tube face is tilted slightly upward on its stand)
        const gBox = new THREE.Box3().setFromObject(glass)
        const gCenter = gBox.getCenter(new THREE.Vector3())
        const gSize = gBox.getSize(new THREE.Vector3())
        const ray = new THREE.Raycaster(
          gCenter.clone().add(new THREE.Vector3(0, 0, 2)),
          new THREE.Vector3(0, 0, -1),
        )
        const hit = ray.intersectObject(glass, false)[0]
        const normal = hit?.face
          ? hit.face.normal.clone().transformDirection(glass.matrixWorld).normalize()
          : new THREE.Vector3(0, 0, 1)
        const front = hit ? hit.point.clone() : gCenter.clone()

        // the screen DOM, sized so a parked camera shows it at ~1:1 device px
        const divH = Math.round(H * FILL)
        const divW = Math.round((divH * gSize.x) / gSize.y)
        const el = document.createElement('div')
        el.style.width = `${divW}px`
        el.style.height = `${divH}px`
        el.style.pointerEvents = 'auto'
        el.style.overflow = 'hidden'
        el.style.borderRadius = '10px'
        el.style.backgroundColor = '#0c0a09'
        const cssScene = new THREE.Scene()
        const cssObj = new CSS3DObject(el)
        cssObj.scale.setScalar(gSize.y / divH)
        cssObj.position.copy(front).add(normal.clone().multiplyScalar(0.002))
        cssObj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
        cssScene.add(cssObj)
        cssScene.updateMatrixWorld(true)
        cssObj.matrixAutoUpdate = false // the glass never moves, only the camera
        setScreenEl(el)

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

        const chair = new THREE.Group()
        const seat = makeRounded(1.22, 0.18, 1.02, 0.08, chairMat)
        seat.position.set(0, 0.78, 0)
        chair.add(seat)
        const back = makeRounded(1.2, 1.15, 0.16, 0.07, chairMat)
        back.position.set(0, 1.38, 0.55)
        back.rotation.x = -0.12
        chair.add(back)
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.72, 16), chairMetalMat)
        post.position.y = 0.4
        post.castShadow = true
        post.receiveShadow = true
        chair.add(post)
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2
          const leg = makeBox(0.68, 0.055, 0.085, chairMetalMat)
          leg.position.set(Math.cos(a) * 0.28, 0.14, Math.sin(a) * 0.28)
          leg.rotation.y = -a
          chair.add(leg)
          const caster = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 6), blackPlasticMat)
          caster.scale.y = 0.55
          caster.position.set(Math.cos(a) * 0.62, 0.08, Math.sin(a) * 0.62)
          caster.castShadow = true
          caster.receiveShadow = true
          chair.add(caster)
        }
        chair.position.set(-0.15, 0, 3.05)
        chair.rotation.y = -0.03
        scene.add(chair)
        addObstacleFrom(chair, 0.18)

        const windowFrame = new THREE.Group()
        const pane = makeBox(1.85, 1.22, 0.035, windowGlassMat, false)
        pane.renderOrder = 8
        windowFrame.add(pane)
        addExteriorWorld(
          windowFrame,
          (disposable) => runtimeDisposables.push(disposable),
          (texture) => runtimeTextures.push(texture),
        )
        ;[
          [2.03, 0.1, 0.08, 0, 0.66, 0.035],
          [2.03, 0.1, 0.08, 0, -0.66, 0.035],
          [0.1, 1.42, 0.08, -1.01, 0, 0.035],
          [0.1, 1.42, 0.08, 1.01, 0, 0.035],
          [0.08, 1.22, 0.07, 0, 0, 0.05],
          [1.85, 0.07, 0.07, 0, 0, 0.055],
        ].forEach(([w, h, d, x, y, z]) => {
          const rail = makeBox(w, h, d, darkWoodMat, false)
          rail.position.set(x, y, z)
          windowFrame.add(rail)
        })
        windowFrame.position.set(ROOM.minX + 0.045, WINDOW_CENTER_Y, WINDOW_CENTER_Z)
        windowFrame.rotation.y = Math.PI / 2
        scene.add(windowFrame)

        const moonSpillTexture = makeMoonSpillTexture()
        runtimeDisposables.push(moonSpillTexture)
        runtimeTextures.push(moonSpillTexture)
        const moonSpillMat = new THREE.MeshBasicMaterial({
          map: moonSpillTexture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          fog: false,
        })
        const moonPool = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 2.15), moonSpillMat)
        moonPool.rotation.x = -Math.PI / 2
        moonPool.rotation.z = -0.13
        moonPool.position.set(ROOM.minX + 2.72, 0.028, WINDOW_CENTER_Z + 0.03)
        moonPool.renderOrder = 12
        moonPool.frustumCulled = false
        scene.add(moonPool)
        const windowSpill = new THREE.SpotLight('#9dbfff', 0, 8, 0.6, 0.78, 1.6)
        windowSpill.position.set(ROOM.minX + 0.06, WINDOW_CENTER_Y + 0.08, WINDOW_CENTER_Z + 0.05)
        windowSpill.target.position.set(ROOM.minX + 4.6, 0.55, WINDOW_CENTER_Z - 0.22)
        const windowWash = new THREE.PointLight('#7faeff', 0, 5.5, 1.75)
        windowWash.position.set(ROOM.minX + 0.55, WINDOW_CENTER_Y - 0.05, WINDOW_CENTER_Z)
        scene.add(windowSpill, windowSpill.target, windowWash)

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
        shelf.position.set(ROOM.maxX - 0.38, 0, 6.45)
        scene.add(shelf)
        addObstacleFrom(shelf, 0.2)

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
        cork.position.set(-2.95, 3.15, ROOM.maxZ - 0.045)
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
        lowTable.position.set(ROOM.minX + 1.05, 0, 3.2)
        lowTable.rotation.y = 0.15
        scene.add(lowTable)
        addObstacleFrom(lowTable, 0.18)

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

        // seated, the desk spot is the whole show; walking wakes a real light
        // rig instead of the old flat hemisphere flood: a shadow-casting
        // pendant downlight pools on the floor, a small omni at the bulb
        // catches the ceiling, cool moonlight leans in from the window wall,
        // and just enough ambient keeps the corners legible
        const hemi = new THREE.HemisphereLight('#5a6678', '#241d16', 0.55)
        scene.add(hemi)
        const roomGlow = new THREE.PointLight('#8a7a64', 0, 0, 1.2)
        // parked just under the pendant's bulb so the light has a source
        roomGlow.position.set(0, 4.75, 4.4)
        scene.add(roomGlow)
        const pendant = new THREE.SpotLight('#ffd9ae', 0, 0, 1.05, 0.85, 1.5)
        pendant.position.set(0, 5.45, 4.4)
        pendant.target.position.set(0, 0, 4.4)
        pendant.castShadow = true
        pendant.shadow.mapSize.set(1024, 1024)
        pendant.shadow.bias = -0.00005
        pendant.shadow.normalBias = 0.025
        pendant.shadow.radius = 2
        pendant.shadow.blurSamples = 4
        pendant.shadow.camera.near = 0.5
        scene.add(pendant, pendant.target)
        const moon = new THREE.DirectionalLight('#8fa6d4', 0)
        moon.position.set(ROOM.minX - 4, 4.6, 5.5)
        moon.target.position.set(0, 0.6, 4.5)
        scene.add(moon, moon.target)
        const HEMI_SEATED = 0.55
        const HEMI_ROAM = 1.5
        const GLOW_ROAM = 7
        const PEND_ROAM = 75
        const MOON_ROAM = 0.8
        const WINDOW_SPILL_ROAM = 8
        const roomLight = (k: number) => {
          hemi.intensity = HEMI_SEATED + (HEMI_ROAM - HEMI_SEATED) * k
          roomGlow.intensity = GLOW_ROAM * k
          pendant.intensity = PEND_ROAM * k
          moon.intensity = MOON_ROAM * k
          windowSpill.intensity = WINDOW_SPILL_ROAM * (0.25 + k * 0.75)
          windowWash.intensity = 2.5 * (0.35 + k * 0.65)
          moonSpillMat.opacity = 0.13 * (0.45 + k * 0.7)
          if (bulbMat) bulbMat.emissiveIntensity = 3.5 * k
        }
        const key = new THREE.SpotLight('#ffd9a0', 60, 0, 0.55, 0.6, 1.6)
        key.position.set(-3.2, 5.2, 2.8)
        key.target.position.set(0.3, deskTop, 0)
        key.castShadow = true
        key.shadow.mapSize.set(2048, 2048)
        key.shadow.bias = -0.00005
        key.shadow.normalBias = 0.025
        key.shadow.radius = 2
        key.shadow.blurSamples = 4
        key.shadow.camera.near = 2
        scene.add(key, key.target)
        const rim = new THREE.DirectionalLight('#7e8ea8', 0.5)
        rim.position.set(2.5, 3, -2)
        scene.add(rim)
        // the tube's own spill onto keyboard and desk once it is awake
        const spill = new THREE.PointLight('#9db4e8', 0, 2.0, 1.8)
        spill.position.copy(front).add(new THREE.Vector3(0, -0.12, 0.75))
        scene.add(spill)

        // everything placed so far is furniture: bake world matrices once and
        // stop re-walking the whole static graph every frame (the player body
        // joins the scene later and keeps its auto-update)
        scene.updateMatrixWorld(true)
        scene.traverse((o) => {
          o.matrixAutoUpdate = false
        })

        const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 40)
        camera.rotation.order = 'YXZ' // yaw/pitch compose FPS-style while walking
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(38 / 2))
        const camStart = new THREE.Vector3(2.4, 2.9, 4.5)
        const camEndFor = (h: number) =>
          front.clone().add(normal.clone().multiplyScalar((gSize.y * h) / (divH * 2 * tanHalf)))
        let camEnd = camEndFor(H)
        // Warm every static shader/texture path now, so the first look toward
        // the window during roam does not hitch while the GPU compiles it.
        runtimeTextures.forEach((texture) => webgl?.initTexture(texture))
        webgl.compile(scene, camera)

        const render = () => {
          if (!webgl || !scene) return
          webgl.render(scene, camera)
          css3d.render(cssScene, camera)
        }

        // intro: drift, then push into the glass; afterwards the loop stops
        let parked = false
        let leaving = false
        const t0 = performance.now()
        const drifted = new THREE.Vector3()
        const introTick = () => {
          if (disposed) return
          const t = (performance.now() - t0) / 1000
          // tube wakes ~in sync with the BIOS flicker on the DOM screen
          spill.intensity = t < 0.45 ? 0 : t < 0.85 ? (Math.sin(t * 50) > -0.3 ? 0.9 : 0.2) : 1.0
          const zoom = Math.min(1, Math.max(0, (t - 0.9) / (INTRO_S - 0.9)))
          drifted.copy(camStart)
          drifted.x += Math.sin(t * 0.7) * 0.05
          drifted.y += Math.sin(t * 0.5) * 0.03
          camera.position.lerpVectors(drifted, camEnd, EASE(zoom))
          camera.lookAt(front)
          render()
          if (zoom >= 1) {
            parked = true
            setIntro(false)
            return // parked: stop rendering, the screen is live DOM now
          }
          raf = requestAnimationFrame(introTick)
        }
        webgl.shadowMap.needsUpdate = true // first bake; frozen from here on
        raf = requestAnimationFrame(introTick)

        outroRef.current = () => {
          leaving = true
          cancelAnimationFrame(raf)
          const o0 = performance.now()
          const from = camera.position.clone()
          const outroTick = () => {
            if (disposed) return
            const t = (performance.now() - o0) / 1000
            // hold on the dark glass briefly, then retreat into the room
            const back = Math.min(1, Math.max(0, (t - 0.8) / 1.3))
            spill.intensity = Math.max(0, 1 - back * 2)
            camera.position.lerpVectors(from, camStart, EASE(back))
            camera.lookAt(front)
            render()
            if (back < 1) raf = requestAnimationFrame(outroTick)
          }
          raf = requestAnimationFrame(outroTick)
        }

        // --- roam: stand up from the desk and walk the room first-person ----
        // WASD moves, the mouse looks (pointer lock on click, drag works too),
        // and an interact prompt at the machine sits you back down
        let roaming = false
        let fps = false // controls live, i.e. the stand-up glide has finished
        let nearNow = false
        let isLocked = false
        let yaw = 0
        let pitch = 0
        let lastT = 0
        let bobT = 0
        const keys = new Set<string>()
        const vel = new THREE.Vector3()
        const want = new THREE.Vector3()
        const gaze = new THREE.Vector3()
        const toScreen = new THREE.Vector3()
        const EYE = deskTop + 2.0 // standing eye height over this desk's scale
        const SPAWN = new THREE.Vector3(1.15, EYE, 2.55)
        const SPEED = 3.4
        const RUN_SPEED = 5.9
        const CROUCH_SPEED = 1.7
        const CROUCH_DROP = 0.85 // how far the eye sinks at full crouch
        const FOV = 38
        let crouchK = 0 // 0 standing .. 1 crouched, smoothed
        // adaptive resolution: if the walk can't hold frame rate, step the
        // pixel ratio down (never back up mid-roam, so it can't oscillate);
        // each roam and each sit-down restores full crispness
        let pr = PR_CAP
        let emaMs = 16
        let prWait = 1.5

        // the first-person body: Quaternius' little robot trailing the
        // camera, so looking down shows your own stubby legs (and one day,
        // other people's robots); the head is collapsed into the neck so the
        // goggle dome never clips the lens
        const body = player.scene
        const BODY_S = EYE / 4.3
        body.scale.setScalar(BODY_S) // head top floats just above the lens
        body.visible = false
        body.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true
            o.frustumCulled = false // skinned bounds lag the rig; never blink out
          }
        })
        body.getObjectByName('Head')?.scale.setScalar(0.001)
        scene.add(body)
        const mixer = new THREE.AnimationMixer(body)
        const clipOf = (suffix: string) => {
          const clip = player.animations.find((c) => c.name.endsWith(suffix))
          return clip ? mixer.clipAction(clip) : null
        }
        const idleAct = clipOf('Robot_Idle')
        const walkAct = clipOf('Robot_Walking')
        idleAct?.play()
        walkAct?.play()
        const BODY_BACK = 0.38 // eye sits ahead of the spine; keeps the chest out of frame
        // walkable area sits inside the shell with some shoulder room; every
        // solid in the room registers an AABB here, and a hit pushes you out
        // along whichever face is closest, so you slide naturally along edges
        const deskBlock = new THREE.Box3().setFromObject(desk.scene).expandByScalar(0.35)
        deskBlock.min.z = -10 // the desk strip runs all the way back to the wall
        obstacles.push(deskBlock)
        const collide = (p: THREE.Vector3) => {
          p.x = THREE.MathUtils.clamp(p.x, ROOM.minX + 0.5, ROOM.maxX - 0.5)
          p.z = THREE.MathUtils.clamp(p.z, -0.8, ROOM.maxZ - 0.5)
          for (const b of obstacles) {
            if (p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z) {
              const exitL = p.x - b.min.x
              const exitR = b.max.x - p.x
              const exitN = p.z - b.min.z
              const exitF = b.max.z - p.z
              const m = Math.min(exitL, exitR, exitN, exitF)
              if (m === exitL) p.x = b.min.x
              else if (m === exitR) p.x = b.max.x
              else if (m === exitN) p.z = b.min.z
              else p.z = b.max.z
            }
          }
        }

        const setCursor = (c: string) => {
          if (webgl) webgl.domElement.style.cursor = c
        }
        const lookAngles = (from: THREE.Vector3, target: THREE.Vector3) => {
          const dir = target.clone().sub(from).normalize()
          return {
            pitch: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)),
            yaw: Math.atan2(-dir.x, -dir.z),
          }
        }

        const walkTick = (now: number) => {
          if (disposed || !roaming) return
          const rawMs = now - lastT
          const dt = Math.min(0.05, rawMs / 1000)
          lastT = now
          // frame-time governor: a smoothed frame cost over ~22ms means the
          // GPU can't keep up at this resolution, so shed a pixel-ratio step
          emaMs = emaMs * 0.93 + Math.min(100, rawMs) * 0.07
          prWait -= rawMs / 1000
          if (prWait <= 0 && emaMs > 22 && pr > 1) {
            pr = Math.max(1, pr - 0.25)
            webgl?.setPixelRatio(pr)
            prWait = 1.2
          }
          const fwd =
            (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
            (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
          const side =
            (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
            (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
          // shift sprints, ctrl (or c) crouches; crouching wins the argument
          const duck =
            keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC')
          const run = !duck && (keys.has('ShiftLeft') || keys.has('ShiftRight'))
          const speed = duck ? CROUCH_SPEED : run ? RUN_SPEED : SPEED
          crouchK += ((duck ? 1 : 0) - crouchK) * (1 - Math.exp(-11 * dt))
          want.set(0, 0, 0)
          if (fwd || side) {
            want
              .set(
                -Math.sin(yaw) * fwd + Math.cos(yaw) * side,
                0,
                -Math.cos(yaw) * fwd - Math.sin(yaw) * side,
              )
              .normalize()
              .multiplyScalar(speed)
          }
          // ease the velocity so steps start and stop with a little weight
          vel.lerp(want, 1 - Math.exp(-10 * dt))
          camera.position.addScaledVector(vel, dt)
          collide(camera.position)
          // a faint footstep bob, scaled by how fast you actually move
          const planar = Math.hypot(vel.x, vel.z)
          bobT += planar * dt * 0.55
          const gait = Math.min(1, planar / speed)
          camera.position.y =
            EYE -
            crouchK * CROUCH_DROP +
            Math.sin(bobT * Math.PI * 2) * (run ? 0.038 : 0.028) * gait
          camera.rotation.x = pitch
          camera.rotation.y = yaw
          camera.rotation.z = 0
          // a sprint widens the lens a touch; the projection only re-bakes
          // on frames where the value actually moved
          const fovWant =
            FOV + 5 * Math.max(0, Math.min(1, (planar - SPEED) / (RUN_SPEED - SPEED)))
          if (Math.abs(camera.fov - fovWant) > 0.02) {
            camera.fov += (fovWant - camera.fov) * (1 - Math.exp(-8 * dt))
            camera.updateProjectionMatrix()
          }
          // the body plants its feet under the camera and faces the walk
          body.position.set(
            camera.position.x + Math.sin(yaw) * BODY_BACK,
            0,
            camera.position.z + Math.cos(yaw) * BODY_BACK,
          )
          body.rotation.y = yaw + Math.PI
          body.scale.y = BODY_S * (1 - 0.25 * crouchK) // the robot squats along
          idleAct?.setEffectiveWeight(1 - gait)
          walkAct?.setEffectiveWeight(gait)
          walkAct?.setEffectiveTimeScale(0.5 + gait * 0.7)
          mixer.update(dt)
          // the player is the only moving shadow caster: re-bake the maps
          // only while actually moving, they stay frozen the rest of the time
          if (webgl && (planar > 0.05 || Math.abs((duck ? 1 : 0) - crouchK) > 0.02))
            webgl.shadowMap.needsUpdate = true
          // close to the tube and facing it: offer the interact prompt
          toScreen.subVectors(gCenter, camera.position)
          const dist = toScreen.length()
          camera.getWorldDirection(gaze)
          const isNear = dist < 3.4 && gaze.dot(toScreen.normalize()) > 0.35
          if (isNear !== nearNow) {
            nearNow = isNear
            setNear(isNear)
          }
          render()
          raf = requestAnimationFrame(walkTick)
        }

        const startRoam = () => {
          if (!webgl || roaming) return
          roaming = true
          parked = false
          cancelAnimationFrame(raf)
          setIntro(false) // in case the intro flight was still going
          webgl.domElement.style.pointerEvents = 'auto'
          setCursor('grab')
          // with the OS still running the tube keeps spilling light
          spill.intensity = liveRef.current ? 1.0 : 0
          // fresh roam, fresh resolution budget
          pr = PR_CAP
          emaMs = 16
          prWait = 1.5
          webgl.setPixelRatio(pr)
          // push back from the desk and rise to standing height: kept short,
          // lingering here made standing up feel mushy
          const s0 = performance.now()
          const from = camera.position.clone()
          const standTick = () => {
            if (disposed || !roaming) return
            const t = Math.min(1, (performance.now() - s0) / 620)
            camera.position.lerpVectors(from, SPAWN, EASE(t))
            const aim = lookAngles(camera.position, front)
            camera.rotation.set(aim.pitch, aim.yaw, 0)
            roomLight(EASE(t))
            render()
            if (t >= 1) {
              // hand the camera to the FPS controls with the exact same yaw
              // and pitch used by the stand-up glide; no second-frame snap
              yaw = aim.yaw
              pitch = aim.pitch
              fps = true
              // the body materializes behind the lens, feet on the floor
              body.position.set(
                camera.position.x + Math.sin(yaw) * BODY_BACK,
                0,
                camera.position.z + Math.cos(yaw) * BODY_BACK,
              )
              body.rotation.y = yaw + Math.PI
              body.visible = true
              if (webgl) webgl.shadowMap.needsUpdate = true // the body just appeared
              // grab the mouse like a game; if the browser refuses (no fresh
              // gesture), the click-to-grab path below still gets you there
              try {
                const got = webgl?.domElement.requestPointerLock() as unknown
                ;(got as Promise<void> | undefined)?.catch?.(() => {})
              } catch {
                /* stay unlocked; clicking locks */
              }
              setWalking(true)
              lastT = performance.now()
              raf = requestAnimationFrame(walkTick)
              return
            }
            raf = requestAnimationFrame(standTick)
          }
          raf = requestAnimationFrame(standTick)
        }

        const stopRoam = () => {
          roaming = false
          fps = false
          keys.clear()
          vel.set(0, 0, 0)
          crouchK = 0
          body.visible = false
          body.scale.y = BODY_S
          if (webgl) {
            webgl.shadowMap.needsUpdate = true // bake the body's shadow away
            // sit back down at full resolution; the governor only runs walking
            pr = PR_CAP
            webgl.setPixelRatio(pr)
          }
          nearNow = false
          setWalking(false)
          setNear(false)
          if (document.pointerLockElement) document.exitPointerLock()
          if (webgl) {
            webgl.domElement.style.pointerEvents = 'none'
            setCursor('')
          }
        }

        // sit back down from wherever the walk left the camera; a live tube
        // skips the power-on flicker and just glides in
        const flyIn = (live: boolean) => {
          cancelAnimationFrame(raf)
          leaving = false
          const f0 = performance.now()
          const from = camera.position.clone()
          const lookFrom = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(3).add(from)
          const look = new THREE.Vector3()
          const fovFrom = camera.fov // a sprint into the chair leaves the lens wide
          // quick: a slow sink into the chair felt wrong every single time
          const delay = live ? 0.05 : 0.3
          const dur = live ? 0.8 : 1.35
          const flyTick = () => {
            if (disposed) return
            const t = (performance.now() - f0) / 1000
            // same flicker as the intro, in sync with the POST screen waking
            spill.intensity = live
              ? 1.0
              : t < 0.45
                ? 0
                : t < 0.85
                  ? Math.sin(t * 50) > -0.3
                    ? 0.9
                    : 0.2
                  : 1.0
            const zoom = Math.min(1, Math.max(0, (t - delay) / dur))
            camera.position.lerpVectors(from, camEnd, EASE(zoom))
            camera.lookAt(look.lerpVectors(lookFrom, front, EASE(zoom)))
            if (fovFrom !== FOV) {
              camera.fov = fovFrom + (FOV - fovFrom) * EASE(zoom)
              camera.updateProjectionMatrix()
            }
            roomLight(1 - EASE(zoom))
            render()
            if (zoom >= 1) {
              parked = true
              return // parked again: the screen is live DOM from here
            }
            raf = requestAnimationFrame(flyTick)
          }
          raf = requestAnimationFrame(flyTick)
        }

        roamRef.current = (on) => {
          if (on) startRoam()
          else if (roaming) {
            const live = liveRef.current
            stopRoam()
            flyIn(live)
          }
        }

        // mouse-look: pointer lock steers directly, an unlocked drag grabs
        // the world instead; a still click only (re)grabs the mouse — sitting
        // down is always deliberate, via E or the prompt button
        const MOVE_KEYS = new Set([
          'KeyW',
          'KeyA',
          'KeyS',
          'KeyD',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
        ])
        // sprint and crouch modifiers; c is a crouch alias for anyone wary of
        // the browser eating ctrl chords
        const MOD_KEYS = new Set([
          'ShiftLeft',
          'ShiftRight',
          'ControlLeft',
          'ControlRight',
          'KeyC',
        ])
        const turn = (dx: number, dy: number, sign: number) => {
          yaw += sign * dx * 0.0019
          pitch = THREE.MathUtils.clamp(pitch + sign * dy * 0.0019, -1.35, 1.35)
        }
        const onKeyDown = (e: KeyboardEvent) => {
          if (!roaming || !fps) return
          if (MOVE_KEYS.has(e.code)) {
            keys.add(e.code)
            e.preventDefault()
          } else if (MOD_KEYS.has(e.code)) {
            keys.add(e.code)
          } else if (e.code === 'KeyE' && nearNow) {
            e.preventDefault()
            interactRef.current()
          }
        }
        const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)
        // alt-tabbing away mid-stride must not leave a key latched down
        const onBlur = () => keys.clear()
        const onLockChange = () => {
          isLocked = document.pointerLockElement === webgl?.domElement
          setLocked(isLocked)
          setCursor(isLocked ? 'none' : 'grab')
        }
        let downPt: { moved: number } | null = null
        const onPtrDown = () => {
          if (!roaming || !fps) return
          downPt = { moved: 0 }
          if (!isLocked) setCursor('grabbing')
        }
        const onPtrMove = (e: PointerEvent) => {
          if (!roaming || !fps) return
          if (isLocked) {
            turn(e.movementX, e.movementY, -1)
          } else if (downPt) {
            turn(e.movementX, e.movementY, 1)
            downPt.moved += Math.hypot(e.movementX, e.movementY)
          }
        }
        const onPtrUp = () => {
          if (!roaming || !fps || !downPt) return
          const clicked = downPt.moved < 6
          downPt = null
          if (!isLocked) {
            setCursor('grab')
            if (clicked) webgl?.domElement.requestPointerLock()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        window.addEventListener('blur', onBlur)
        document.addEventListener('pointerlockchange', onLockChange)
        webgl.domElement.addEventListener('pointerdown', onPtrDown)
        webgl.domElement.addEventListener('pointermove', onPtrMove)
        webgl.domElement.addEventListener('pointerup', onPtrUp)

        const onResize = () => {
          if (!webgl) return
          const w = mount.clientWidth
          const h = mount.clientHeight
          webgl.setSize(w, h)
          css3d.setSize(w, h)
          camera.aspect = w / h
          camera.updateProjectionMatrix()
          camEnd = camEndFor(h)
          if (parked && !leaving) {
            camera.position.copy(camEnd)
            camera.lookAt(front)
          }
          render()
        }
        window.addEventListener('resize', onResize)
        const removeResize = () => window.removeEventListener('resize', onResize)
        const prevCleanup = cleanupDom
        cleanupDom = () => {
          removeResize()
          stopRoam()
          window.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('keyup', onKeyUp)
          window.removeEventListener('blur', onBlur)
          document.removeEventListener('pointerlockchange', onLockChange)
          webgl?.domElement.removeEventListener('pointerdown', onPtrDown)
          webgl?.domElement.removeEventListener('pointermove', onPtrMove)
          webgl?.domElement.removeEventListener('pointerup', onPtrUp)
          prevCleanup?.()
        }
      })
      .catch(() => {
        clearTimeout(bail)
        if (!disposed) failRef.current()
      })

    return () => {
      disposed = true
      clearTimeout(bail)
      cancelAnimationFrame(raf)
      outroRef.current = null
      roamRef.current = null
      if (scene) {
        scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.geometry.dispose()
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          mats.forEach((m) => m.dispose())
        })
      }
      webgl?.dispose()
      runtimeDisposables.forEach((d) => d.dispose())
      cleanupDom?.()
      setScreenEl(null)
    }
  }, [])

  return (
    <div ref={mountRef} className="absolute inset-0 overflow-hidden">
      {screenEl && createPortal(<>{children}</>, screenEl)}
      {/* photo-style falloff over the room */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.45))',
        }}
      />
      {intro && (
        <p className="pointer-events-none absolute right-5 bottom-4 font-mono text-[11px] text-stone-600">
          esc to skip
        </p>
      )}
      {roam && walking && (
        <p className="pointer-events-none absolute right-5 bottom-4 z-10 font-mono text-[11px] text-stone-500">
          {locked
            ? 'wasd move · shift run · ctrl crouch · esc frees the mouse'
            : 'wasd to move · click to grab the mouse · esc to leave'}
        </p>
      )}
      {roam && walking && locked && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 z-10 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-400/70"
        />
      )}
      {roam && walking && near && (
        <button
          type="button"
          onClick={() => onInteract()}
          className="absolute bottom-14 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-md border border-stone-700 bg-stone-950/80 px-3 py-1.5 font-mono text-[12px] text-stone-300 backdrop-blur-sm transition-colors hover:border-stone-500 hover:text-white"
        >
          <kbd className="mr-2 rounded border border-stone-600 bg-stone-800 px-1.5 py-0.5 text-[10px] text-stone-200">
            E
          </kbd>
          {screenLive ? 'sit back down' : 'power it on'}
        </button>
      )}
    </div>
  )
}
