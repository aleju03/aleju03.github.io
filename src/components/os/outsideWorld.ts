import * as THREE from 'three'
import {
  HOUSE, YARD, GATE, canvasTexture, seeded, makeGlowTexture, mergeGeoms,
} from './houseWorld'
import type { HouseModels, ModelLike } from './houseWorld'

/*
  Everything past the property line, plus the sky above all of it:

  - A day/night cycle on the wall clock (a full day is DAY_LEN seconds,
    Minecraft-style). The sun and moon ride one orbit half a day apart; a
    painted day dome crossfades over the star dome, a twilight band flares
    at the horizon crossings, and update() hands the scene the fog range,
    fog color and hemisphere targets for the current moment. Boot always
    lands just after dusk, so the desk keeps its night mood — hang around
    and dawn comes to you.
  - The neighborhood: a quiet street along the front of the house with
    sidewalks, curbs and streetlamps (fake pooled light, the honest game
    trick), and shell houses — one instanced box + pyramid-roof kit with
    curtain-lit windows, nobody home.
  - The city, rebuilt as three depth rings of instanced towers that shade
    toward the horizon color the farther out they sit (manual atmospheric
    perspective — they ignore real fog so night can keep its crisp lit-up
    skyline), with lit windows that die at dawn and red beacons blinking
    on the tall roofs. A red-eye flight strobes across the sky on a slow
    circle.

  Nothing here casts or receives shadows: the baked interior maps stay
  valid, and the sun stays a shadowless key light damped indoors (the
  `indoor` factor) so it can't torch the bedroom through the walls.
*/

/** the walkable world; collide() clamps to this instead of the yard now */
export const WORLD = { minX: -52, maxX: 52, minZ: -30, maxZ: 52 }

const DAY_LEN = 480 // seconds per full in-world day
const START_TOD = 0.8 // 0 midnight .. 0.5 noon; 0.8 = just after dusk

export interface OutsideState {
  /** 0 night .. 1 day (smoothed on sun elevation) */
  day: number
  night: number
  /** peaks ~1 as the sun crosses the horizon, dawn and dusk */
  twilight: number
  /** sun elevation, -1..1 */
  sunEl: number
  /** 0 moon set .. 1 moon well up */
  moonUp: number
  /** 0 outside .. 1 fully inside the house shell */
  indoor: number
  fogNear: number
  fogFar: number
  fogColor: THREE.Color
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  /** multiply the roam hemisphere by this; >1 in daylight, eases indoors */
  dayBoost: number
}

export interface OutsideHandles {
  root: THREE.Group
  /** advance the cycle (wall clock) and restyle sky/city/lamps; call once
      per rendered frame. todOverride pins the time of day for probes. */
  update: (camPos: THREE.Vector3, todOverride?: number) => OutsideState
  /** attach the streamed models this module borrows (trees, bushes) */
  furnish: (models: HouseModels) => void
}

interface BuildOpts {
  scene: THREE.Scene
  obstacles: THREE.Box3[]
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth01 = (x: number) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

/* ------------------------------------------------------ canvas textures */

const makeStarTexture = () =>
  canvasTexture([1024, 512], (ctx, w, h) => {
    const rand = seeded(0x57a2)
    const sky = ctx.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#04070f')
    sky.addColorStop(0.55, '#070d1a')
    sky.addColorStop(0.8, '#0d1524')
    sky.addColorStop(0.92, '#1a2030')
    sky.addColorStop(1, '#241f23')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)
    // faint city glow bleeding up from the horizon band
    const glow = ctx.createLinearGradient(0, h * 0.78, 0, h)
    glow.addColorStop(0, 'rgba(220,150,80,0)')
    glow.addColorStop(1, 'rgba(220,150,80,0.14)')
    ctx.fillStyle = glow
    ctx.fillRect(0, h * 0.78, w, h * 0.22)
    for (let i = 0; i < 900; i++) {
      const y = rand() * h * 0.82
      const a = 0.25 + rand() * 0.65
      const big = rand() < 0.05
      ctx.fillStyle = `rgba(${big ? '255,246,220' : '224,236,255'},${a})`
      ctx.fillRect(rand() * w, y, big ? 2 : 1, big ? 2 : 1)
    }
  })

const makeDayTexture = () =>
  canvasTexture([1024, 512], (ctx, w, h) => {
    const rand = seeded(0xdaf)
    const sky = ctx.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#6f9fc9')
    sky.addColorStop(0.5, '#93b8d6')
    sky.addColorStop(0.78, '#bad2e0')
    sky.addColorStop(0.9, '#d9e6ea')
    sky.addColorStop(1, '#e4e9e2')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)
    // a few soft painted clouds drifting in the upper bands
    for (let i = 0; i < 14; i++) {
      const cx = rand() * w
      const cy = h * (0.12 + rand() * 0.42)
      const rx = 40 + rand() * 90
      for (let p = 0; p < 5; p++) {
        const g = ctx.createRadialGradient(
          cx + (rand() - 0.5) * rx * 1.4, cy + (rand() - 0.5) * rx * 0.3, 2,
          cx, cy, rx * (0.5 + rand() * 0.5))
        g.addColorStop(0, `rgba(244,248,250,${0.1 + rand() * 0.12})`)
        g.addColorStop(1, 'rgba(244,248,250,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
      }
    }
  })

const makeTwilightTexture = () =>
  canvasTexture([64, 128], (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(255,150,80,0)')
    g.addColorStop(0.62, 'rgba(255,145,72,0.18)')
    g.addColorStop(0.88, 'rgba(255,170,96,0.5)')
    g.addColorStop(1, 'rgba(255,196,120,0.62)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })

const makeMeadowTexture = () =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const rand = seeded(0x3ead0)
    ctx.fillStyle = '#26331d'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 2200; i++) {
      const g = 46 + rand() * 44
      ctx.fillStyle = `rgba(${g * 0.55},${g},${g * 0.4},${0.2 + rand() * 0.45})`
      ctx.fillRect(rand() * w, rand() * h, 1 + (rand() < 0.25 ? 1 : 0), 1)
    }
    // dry patches so the field reads wilder than the mowed yard
    for (let i = 0; i < 9; i++) {
      const grad = ctx.createRadialGradient(
        rand() * w, rand() * h, 2, rand() * w, rand() * h, 16 + rand() * 30)
      grad.addColorStop(0, 'rgba(96,84,46,0.14)')
      grad.addColorStop(1, 'rgba(96,84,46,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)
    }
  })

const makeAsphaltTexture = () =>
  canvasTexture([256, 128], (ctx, w, h) => {
    const rand = seeded(0xa5fa17)
    ctx.fillStyle = '#26282b'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 1500; i++) {
      const v = 30 + rand() * 34
      ctx.fillStyle = `rgba(${v},${v},${v + 3},${0.25 + rand() * 0.4})`
      ctx.fillRect(rand() * w, rand() * h, 1, 1)
    }
    // wheel-worn lanes, slightly darker
    ;[0.3, 0.7].forEach((band) => {
      const g = ctx.createLinearGradient(0, h * band - 12, 0, h * band + 12)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(0.5, 'rgba(0,0,0,0.18)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, h * band - 12, w, 24)
    })
    // dashed center line: the tile spans 4 world units along the street
    ctx.fillStyle = '#93865f'
    ctx.fillRect(w * 0.06, h / 2 - 2, w * 0.55, 4)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(w * 0.06, h / 2 + 1, w * 0.55, 1)
  }, [26, 1])

const makeSidewalkTexture = () =>
  canvasTexture([128, 128], (ctx, w, h) => {
    const rand = seeded(0x51de)
    ctx.fillStyle = '#63635d'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 900; i++) {
      const v = 86 + rand() * 26
      ctx.fillStyle = `rgba(${v},${v},${v - 4},${0.2 + rand() * 0.3})`
      ctx.fillRect(rand() * w, rand() * h, 1, 1)
    }
    // expansion joint on the tile seam
    ctx.fillStyle = 'rgba(20,20,18,0.55)'
    ctx.fillRect(0, 0, 3, h)
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(3, 0, 2, h)
  }, [52, 1])

/* ---------------------------------------------------------------- build */

export function buildOutsideWorld(opts: BuildOpts): OutsideHandles {
  const { scene, obstacles, trackTexture, trackDisposable } = opts

  const root = new THREE.Group()
  scene.add(root)

  const track = (t: THREE.Texture) => {
    trackTexture(t)
    trackDisposable(t)
    return t
  }
  const mat = <T extends THREE.Material>(m: T): T => {
    trackDisposable(m)
    return m
  }

  /* --------------------------------------------------------------- sky -- */

  const starMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeStarTexture()), side: THREE.BackSide, fog: false, depthWrite: false,
  }))
  const starDome = new THREE.Mesh(new THREE.SphereGeometry(230, 32, 16), starMat)
  starDome.renderOrder = -10
  starDome.frustumCulled = false
  root.add(starDome)

  const dayMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeDayTexture()), side: THREE.BackSide, fog: false,
    depthWrite: false, transparent: true, opacity: 0,
  }))
  const dayDome = new THREE.Mesh(new THREE.SphereGeometry(224, 32, 16), dayMat)
  dayDome.renderOrder = -9.8
  dayDome.frustumCulled = false
  root.add(dayDome)

  const twilightMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeTwilightTexture()), side: THREE.BackSide, fog: false,
    depthWrite: false, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending,
  }))
  const twilightBand = new THREE.Mesh(
    new THREE.CylinderGeometry(208, 208, 44, 48, 1, true), twilightMat)
  twilightBand.position.y = 14
  twilightBand.renderOrder = -9.6
  twilightBand.frustumCulled = false
  root.add(twilightBand)

  // sun: disc + warm halo riding one orbit; the moon rides it half a day out
  const sun = new THREE.Group()
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(8.5, 24),
    mat(new THREE.MeshBasicMaterial({ color: '#fff3c8', fog: false })),
  )
  const sunHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(52, 52),
    mat(new THREE.MeshBasicMaterial({
      map: track(makeGlowTexture('rgba(255,236,180,0.9)', 'rgba(255,210,140,0)')),
      transparent: true, opacity: 0.7, fog: false,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })),
  )
  sunHalo.position.z = -0.5
  sun.add(sunHalo, sunDisc)
  sun.renderOrder = -9.2
  sun.frustumCulled = false
  sun.userData.dynamic = true
  root.add(sun)

  const moon = new THREE.Group()
  const moonDisc = new THREE.Mesh(
    new THREE.CircleGeometry(6.2, 24),
    mat(new THREE.MeshBasicMaterial({ color: '#f2e9c9', fog: false })),
  )
  const moonHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 34),
    mat(new THREE.MeshBasicMaterial({
      map: track(makeGlowTexture('rgba(238,232,205,0.85)', 'rgba(238,232,205,0)')),
      transparent: true, opacity: 0.55, fog: false,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })),
  )
  moonHalo.position.z = -0.5
  moon.add(moonHalo, moonDisc)
  moon.renderOrder = -9.2
  moon.frustumCulled = false
  moon.userData.dynamic = true
  root.add(moon)

  // amber glow hugging the horizon behind the towers; a night-only thing
  const hazeMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeGlowTexture('rgba(230,150,70,0.35)', 'rgba(230,150,70,0)')),
    transparent: true, fog: false, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.BackSide,
  }))
  const haze = new THREE.Mesh(new THREE.CylinderGeometry(150, 150, 26, 48, 1, true), hazeMat)
  haze.position.y = 6
  haze.renderOrder = -9
  haze.frustumCulled = false
  root.add(haze)

  // the red-eye flight: one strobing spark on a slow, high circle
  const planeMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeGlowTexture('rgba(255,244,235,0.95)', 'rgba(255,180,150,0)')),
    transparent: true, opacity: 0, fog: false,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  const redEye = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), planeMat)
  redEye.renderOrder = -8.9
  redEye.frustumCulled = false
  redEye.userData.dynamic = true
  root.add(redEye)

  /* -------------------------------------------------------------- ground */

  const meadowTex = track(makeMeadowTexture())
  meadowTex.wrapS = meadowTex.wrapT = THREE.RepeatWrapping
  meadowTex.repeat.set(58, 58)
  const meadowMat = mat(new THREE.MeshStandardMaterial({ map: meadowTex, roughness: 1 }))
  const meadow = new THREE.Mesh(new THREE.CircleGeometry(240, 48), meadowMat)
  meadow.rotation.x = -Math.PI / 2
  meadow.position.y = -0.055
  root.add(meadow)

  /* -------------------------------------------------------------- street */

  const STREET = { z0: -14.4, z1: -8, x0: WORLD.minX, x1: WORLD.maxX }
  const asphaltMat = mat(new THREE.MeshStandardMaterial({
    map: track(makeAsphaltTexture()), roughness: 0.96,
  }))
  const street = new THREE.Mesh(
    new THREE.PlaneGeometry(STREET.x1 - STREET.x0, STREET.z1 - STREET.z0), asphaltMat)
  street.rotation.x = -Math.PI / 2
  street.position.set(0, 0.004, (STREET.z0 + STREET.z1) / 2)
  root.add(street)

  const sidewalkMat = mat(new THREE.MeshStandardMaterial({
    map: track(makeSidewalkTexture()), roughness: 0.95,
  }))
  const walkway = (zc: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(STREET.x1 - STREET.x0, 1.5), sidewalkMat)
    m.rotation.x = -Math.PI / 2
    m.position.set(0, 0.018, zc)
    root.add(m)
  }
  walkway(STREET.z1 + 0.75) // our side
  walkway(STREET.z0 - 0.75) // theirs

  const concreteMat = mat(new THREE.MeshStandardMaterial({ color: '#565550', roughness: 0.9 }))
  const curb = (zc: number) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(STREET.x1 - STREET.x0, 0.14, 0.26), concreteMat)
    m.position.set(0, 0.06, zc)
    root.add(m)
  }
  curb(STREET.z1 + 0.06)
  curb(STREET.z0 - 0.06)

  // connector from the yard gate down to the sidewalk
  const gateWalk = new THREE.Mesh(new THREE.PlaneGeometry(2.0, YARD.minZ - (STREET.z1 + 1.5)), concreteMat)
  gateWalk.rotation.x = -Math.PI / 2
  gateWalk.position.set((GATE.x0 + GATE.x1) / 2, 0.012, (YARD.minZ + STREET.z1 + 1.5) / 2)
  root.add(gateWalk)

  /* --------------------------------------------------------- streetlamps */

  const lampRand = seeded(0x1a3b)
  const lampDefs: Array<{ x: number; z: number; rotY: number }> = []
  for (let i = -3; i <= 3; i++) lampDefs.push({ x: i * 16, z: STREET.z1 + 0.7, rotY: Math.PI })
  for (let i = -2; i <= 2; i++) lampDefs.push({ x: i * 16 + 8, z: STREET.z0 - 0.7, rotY: 0 })

  const poleGeo = new THREE.CylinderGeometry(0.055, 0.09, 4.7, 8)
  poleGeo.translate(0, 2.35, 0)
  const armGeo = new THREE.BoxGeometry(0.1, 0.1, 0.95)
  armGeo.translate(0, 4.66, 0.42)
  const headGeo = new THREE.BoxGeometry(0.46, 0.13, 0.32)
  headGeo.translate(0, 4.62, 0.88)
  const lampGeo = mergeGeoms(mergeGeoms(poleGeo, armGeo), headGeo)
  const lampMetalMat = mat(new THREE.MeshStandardMaterial({
    color: '#22262a', roughness: 0.6, metalness: 0.35,
  }))
  const lampPoles = new THREE.InstancedMesh(lampGeo, lampMetalMat, lampDefs.length)

  const bulbMat = mat(new THREE.MeshStandardMaterial({
    color: '#3a2c14', emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 3.2,
    fog: false,
  }))
  const lampBulbs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.32, 0.07, 0.2), bulbMat, lampDefs.length)

  const glowQuadA = new THREE.PlaneGeometry(2.3, 2.3)
  const glowQuadB = glowQuadA.clone().rotateY(Math.PI / 2)
  const glowGeo = mergeGeoms(glowQuadA, glowQuadB)
  const lampGlowMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeGlowTexture('rgba(255,214,140,0.55)', 'rgba(255,190,100,0)')),
    transparent: true, opacity: 0.42, fog: false, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }))
  const lampGlows = new THREE.InstancedMesh(glowGeo, lampGlowMat, lampDefs.length)

  const poolGeo = new THREE.CircleGeometry(2.5, 20)
  poolGeo.rotateX(-Math.PI / 2)
  const lampPoolMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeGlowTexture('rgba(255,200,120,0.4)', 'rgba(255,190,100,0)')),
    transparent: true, opacity: 0.3, fog: false, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }))
  const lampPools = new THREE.InstancedMesh(poolGeo, lampPoolMat, lampDefs.length)
  lampPools.renderOrder = 2

  {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3(1, 1, 1)
    const off = new THREE.Vector3()
    lampDefs.forEach((d, i) => {
      q.setFromEuler(e.set(0, d.rotY, 0))
      m.compose(p.set(d.x, 0, d.z), q, s)
      lampPoles.setMatrixAt(i, m)
      off.set(0, 4.52, 0.88).applyQuaternion(q)
      m.compose(p.set(d.x + off.x, off.y, d.z + off.z), q, s)
      lampBulbs.setMatrixAt(i, m)
      m.compose(p.set(d.x + off.x, 4.35, d.z + off.z), q, s)
      lampGlows.setMatrixAt(i, m)
      off.set(0, 0, 1.15).applyQuaternion(q)
      const w = 0.9 + lampRand() * 0.25
      m.compose(p.set(d.x + off.x, 0.024, d.z + off.z), q, s.set(w, 1, w))
      lampPools.setMatrixAt(i, m)
      s.set(1, 1, 1)
      obstacles.push(new THREE.Box3(
        new THREE.Vector3(d.x - 0.24, 0, d.z - 0.24),
        new THREE.Vector3(d.x + 0.24, 5, d.z + 0.24),
      ))
    })
  }
  root.add(lampPoles, lampBulbs, lampGlows, lampPools)

  /* ------------------------------------------------------- shell houses */

  interface Shell {
    x: number
    z: number
    w: number
    d: number
    h: number
    /** which way the front (door) faces along z */
    face: 1 | -1
    body: string
    roof: string
  }
  const shells: Shell[] = [
    // across the street, fronts toward us
    { x: -38, z: -22.5, w: 11, d: 9.5, h: 5.6, face: 1, body: '#57503f', roof: '#3a332c' },
    { x: -21, z: -23.5, w: 12, d: 10, h: 6.3, face: 1, body: '#4b5250', roof: '#33393b' },
    { x: -4, z: -22, w: 10, d: 9, h: 5.2, face: 1, body: '#5c4a3a', roof: '#41372e' },
    { x: 13, z: -23, w: 12.5, d: 10, h: 6, face: 1, body: '#4f4437', roof: '#3a332c' },
    { x: 31, z: -22.5, w: 10.5, d: 9, h: 5.4, face: 1, body: '#565244', roof: '#33393b' },
    // our neighbors, either side of the yard
    { x: -30, z: 4, w: 11.5, d: 10.5, h: 5.8, face: -1, body: '#54493b', roof: '#3a332c' },
    { x: 30, z: 4, w: 11, d: 10, h: 5.6, face: -1, body: '#4a4a52', roof: '#41372e' },
  ]

  const shellRand = seeded(0x5e11)
  const bodyMat = mat(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95 }))
  const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bodyMat, shells.length)
  const roofMat = mat(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 }))
  const roofGeo = new THREE.ConeGeometry(0.78, 1, 4)
  roofGeo.rotateY(Math.PI / 4)
  const roofs = new THREE.InstancedMesh(roofGeo, roofMat, shells.length)
  const chimMat = mat(new THREE.MeshStandardMaterial({ color: '#41372f', roughness: 0.95 }))
  const chimneys = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 1.6, 0.55), chimMat, 4)

  const doorMat = mat(new THREE.MeshStandardMaterial({ color: '#33261a', roughness: 0.8 }))
  const doors = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 3.3), doorMat, shells.length)
  // two window populations: warm curtained ones that light at night, and
  // dark ones that stay asleep — half the street is home, half is out
  const winLitMat = mat(new THREE.MeshBasicMaterial({ color: '#ffd27d', fog: false }))
  const winDarkMat = mat(new THREE.MeshBasicMaterial({ color: '#1c242c' }))
  const litSlots: THREE.Matrix4[] = []
  const darkSlots: THREE.Matrix4[] = []

  {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    const color = new THREE.Color()
    let chim = 0
    shells.forEach((sh, i) => {
      q.identity()
      m.compose(p.set(sh.x, sh.h / 2, sh.z), q, s.set(sh.w, sh.h, sh.d))
      bodies.setMatrixAt(i, m)
      bodies.setColorAt(i, color.set(sh.body))
      // cone "radius" 0.78 puts the pyramid's half-side at 0.55×scale, a
      // modest eave past the 0.5×scale walls
      const roofH = 1.6 + sh.w * 0.14
      m.compose(p.set(sh.x, sh.h + roofH / 2 - 0.03, sh.z), q, s.set(sh.w, roofH, sh.d))
      roofs.setMatrixAt(i, m)
      roofs.setColorAt(i, color.set(sh.roof))
      if (chim < chimneys.count && shellRand() < 0.62) {
        m.compose(
          p.set(sh.x + sh.w * 0.24, sh.h + roofH * 0.55, sh.z - sh.face * sh.d * 0.18),
          q, s.set(1, 1, 1))
        chimneys.setMatrixAt(chim++, m)
      }
      const frontZ = sh.z + sh.face * (sh.d / 2 + 0.05)
      q.setFromEuler(e.set(0, sh.face === 1 ? 0 : Math.PI, 0))
      m.compose(p.set(sh.x + sh.w * 0.26, 1.65, frontZ), q, s.set(1, 1, 1))
      doors.setMatrixAt(i, m)
      // front windows keep left of the door; one or two more per gable side
      const winY = 2.6
      ;[-0.32, -0.04].forEach((fx) => {
        m.compose(p.set(sh.x + sh.w * fx, winY, frontZ), q, s.set(1.5, 1.25, 1))
        ;(shellRand() < 0.55 ? litSlots : darkSlots).push(m.clone())
      })
      ;[1, -1].forEach((sideDir) => {
        const n = shellRand() < 0.5 ? 1 : 2
        for (let wI = 0; wI < n; wI++) {
          q.setFromEuler(e.set(0, (Math.PI / 2) * sideDir, 0))
          m.compose(
            p.set(sh.x + sideDir * (sh.w / 2 + 0.05), winY,
              sh.z + (wI === 0 ? 1 : -1) * sh.d * 0.22),
            q, s.set(1.3, 1.15, 1))
          ;(shellRand() < 0.4 ? litSlots : darkSlots).push(m.clone())
        }
      })
      obstacles.push(new THREE.Box3(
        new THREE.Vector3(sh.x - sh.w / 2 - 0.3, 0, sh.z - sh.d / 2 - 0.3),
        new THREE.Vector3(sh.x + sh.w / 2 + 0.3, sh.h, sh.z + sh.d / 2 + 0.3),
      ))
    })
    chimneys.count = chim
  }
  const litWins = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), winLitMat, litSlots.length)
  litSlots.forEach((m, i) => litWins.setMatrixAt(i, m))
  const darkWins = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), winDarkMat, darkSlots.length)
  darkSlots.forEach((m, i) => darkWins.setMatrixAt(i, m))
  root.add(bodies, roofs, chimneys, doors, litWins, darkWins)

  /* ---------------------------------------------------------------- city */

  interface Layer {
    mesh: THREE.InstancedMesh
    mat: THREE.MeshBasicMaterial
    night: THREE.Color
    day: THREE.Color
    defs: Array<{ x: number; z: number; w: number; h: number; d: number; a: number }>
  }
  const cityRand = seeded(0xc17e)
  const beaconSpots: THREE.Vector3[] = []
  const makeLayer = (
    count: number, r0: number, r1: number,
    hBase: number, hVar: number, tallBonus: number,
    night: string, day: string, zBias: number,
  ): Layer => {
    const defs: Layer['defs'] = []
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (cityRand() - 0.5) * 0.07
      const r = r0 + cityRand() * (r1 - r0)
      const tall = cityRand() < 0.14
      const h = hBase + cityRand() * hVar + (tall ? tallBonus : 0)
      defs.push({
        x: Math.cos(a) * r,
        z: Math.sin(a) * r + zBias,
        w: 5 + cityRand() * 9,
        h,
        d: 5 + cityRand() * 8,
        a: -a + Math.PI / 2,
      })
      if (tall && beaconSpots.length < 9) {
        const d = defs[defs.length - 1]
        beaconSpots.push(new THREE.Vector3(d.x, d.h + 0.6, d.z))
      }
    }
    const layerMat = mat(new THREE.MeshBasicMaterial({ color: night, fog: false }))
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), layerMat, count)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    defs.forEach((t, i) => {
      q.setFromEuler(e.set(0, t.a, 0))
      m.compose(p.set(t.x, t.h / 2 - 0.2, t.z), q, s.set(t.w, t.h, t.d))
      mesh.setMatrixAt(i, m)
    })
    mesh.frustumCulled = false
    root.add(mesh)
    return {
      mesh, mat: layerMat,
      night: new THREE.Color(night), day: new THREE.Color(day), defs,
    }
  }
  // three depth rings; the far ones sit closer to the horizon color, which
  // is all "atmospheric perspective" really is
  const layers: Layer[] = [
    makeLayer(40, 82, 112, 10, 16, 26, '#0e1622', '#7e919f', 14),
    makeLayer(48, 122, 158, 13, 22, 30, '#0b111a', '#9dafbc', 18),
    makeLayer(54, 165, 205, 16, 26, 34, '#090d15', '#bccbd6', 22),
  ]

  // lit windows on the two nearer rings; they die out with the dawn
  const winMats: THREE.MeshBasicMaterial[] = []
  const addCityWindows = (layer: Layer, cap: number, baseOpacity: number) => {
    const winMat = mat(new THREE.MeshBasicMaterial({
      color: '#ffc96d', fog: false, transparent: true,
      opacity: baseOpacity, depthWrite: false,
    }))
    winMat.userData.base = baseOpacity
    winMats.push(winMat)
    const slots: Array<{ t: Layer['defs'][0]; lx: number; ly: number }> = []
    layer.defs.forEach((t) => {
      const cols = Math.max(2, Math.floor(t.w / 1.1))
      const rows = Math.max(3, Math.floor(t.h / 1.5))
      for (let cx = 0; cx < cols; cx++)
        for (let cy = 0; cy < rows; cy++) {
          if (cityRand() < 0.74) continue
          slots.push({
            t,
            lx: -t.w * 0.36 + (cx / Math.max(1, cols - 1)) * t.w * 0.72,
            ly: -t.h * 0.42 + (cy / Math.max(1, rows - 1)) * t.h * 0.84,
          })
        }
    })
    const wins = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1), winMat, Math.min(cap, slots.length))
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const off = new THREE.Vector3()
    for (let i = 0; i < wins.count; i++) {
      const { t, lx, ly } = slots[i]
      // push the quad just outside the tower face that looks at the house —
      // half a turn past the tower's own yaw, or the plane ends up on the
      // far face pointing away and the depth test erases the whole grid
      q.setFromEuler(e.set(0, t.a + Math.PI, 0))
      off.set(lx, 0, t.d / 2 + 0.08).applyQuaternion(q)
      m.compose(
        new THREE.Vector3(t.x + off.x, t.h / 2 - 0.2 + ly, t.z + off.z),
        q,
        new THREE.Vector3(0.34 + cityRand() * 0.2, 0.42 + cityRand() * 0.28, 1),
      )
      wins.setMatrixAt(i, m)
    }
    wins.frustumCulled = false
    // after the towers, so the depth-test keeps the lit windows on their faces
    wins.renderOrder = 1
    root.add(wins)
  }
  addCityWindows(layers[0], 480, 0.85)
  addCityWindows(layers[1], 320, 0.6)

  // red aviation beacons on the tall roofs, in three blink groups so the
  // skyline never pulses in unison
  const beaconMats: THREE.MeshBasicMaterial[] = []
  const beaconTex = track(makeGlowTexture('rgba(255,90,70,0.95)', 'rgba(255,60,50,0)'))
  for (let g = 0; g < 3; g++) {
    const bMat = mat(new THREE.MeshBasicMaterial({
      map: beaconTex, transparent: true, opacity: 0, fog: false,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }))
    beaconMats.push(bMat)
    const spots = beaconSpots.filter((_, i) => i % 3 === g)
    if (!spots.length) continue
    const beacons = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.6, 2.6), bMat, spots.length)
    const m = new THREE.Matrix4()
    spots.forEach((sp, i) => {
      m.makeRotationY((i + g) * 1.3)
      m.setPosition(sp)
      beacons.setMatrixAt(i, m)
    })
    beacons.frustumCulled = false
    beacons.renderOrder = 2
    root.add(beacons)
  }

  /* -------------------------------------------------------------- furnish */

  const instanced = (gltf: ModelLike, placements: THREE.Matrix4[]) => {
    const src = gltf.scene
    src.updateMatrixWorld(true)
    src.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length)
      const m = new THREE.Matrix4()
      placements.forEach((pl, i) => im.setMatrixAt(i, m.multiplyMatrices(pl, mesh.matrixWorld)))
      im.castShadow = false
      im.receiveShadow = false
      root.add(im)
      im.updateMatrixWorld(true)
      im.matrixAutoUpdate = false
    })
  }

  let furnished = false
  const furnish = (models: HouseModels) => {
    if (furnished) return
    furnished = true
    const treeRand = seeded(0x7ee5)
    const place = (x: number, z: number, s: number, block: boolean) => {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, treeRand() * Math.PI * 2, 0))
      if (block) {
        obstacles.push(new THREE.Box3(
          new THREE.Vector3(x - 0.55, 0, z - 0.55), new THREE.Vector3(x + 0.55, 5, z + 0.55)))
      }
      return new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * (0.9 + treeRand() * 0.25), s))
    }
    if (models.tree) {
      const mats: THREE.Matrix4[] = []
      // a loose grove past the back fence
      for (let i = 0; i < 7; i++)
        mats.push(place(-32 + treeRand() * 64, 41.5 + treeRand() * 8, 2.6 + treeRand() * 1.7, true))
      // flanking stands east and west of the block
      for (let i = 0; i < 5; i++)
        mats.push(place(36 + treeRand() * 12, -6 + treeRand() * 48, 2.4 + treeRand() * 1.9, true))
      for (let i = 0; i < 5; i++)
        mats.push(place(-48 + treeRand() * 12, -6 + treeRand() * 48, 2.4 + treeRand() * 1.9, true))
      // parkway trees dotted along the far sidewalk
      ;[-30, -13, 5, 22, 39].forEach((x) =>
        mats.push(place(x + (treeRand() - 0.5) * 3, -17.4, 2.1 + treeRand() * 0.9, true)))
      instanced(models.tree, mats)
    }
    if (models.bush) {
      const mats: THREE.Matrix4[] = []
      shells.forEach((sh) => {
        const frontZ = sh.z + sh.face * (sh.d / 2 + 1.0)
        mats.push(place(sh.x - sh.w * 0.32, frontZ, 1.1 + treeRand() * 0.5, false))
        if (treeRand() < 0.7) mats.push(place(sh.x + sh.w * 0.38, frontZ, 1.0 + treeRand() * 0.5, false))
      })
      instanced(models.bush, mats)
    }
  }

  /* -------------------------------------------------------------- sunlight */

  const sunLight = new THREE.DirectionalLight('#fff2dc', 0)
  sunLight.target.position.set(0, 0, 10)
  sunLight.userData.dynamic = true
  root.add(sunLight, sunLight.target)

  /* --------------------------------------------------------------- update */

  const state: OutsideState = {
    day: 0, night: 1, twilight: 0, sunEl: -1, moonUp: 1, indoor: 1,
    fogNear: 14, fogFar: 82,
    fogColor: new THREE.Color('#0a0908'),
    hemiSky: new THREE.Color('#5a6678'),
    hemiGround: new THREE.Color('#241d16'),
    dayBoost: 1,
  }
  const FOG_NIGHT = new THREE.Color('#0a0908')
  const FOG_DAY = new THREE.Color('#a9c0d4')
  const FOG_DUSK = new THREE.Color('#84573c')
  const DUSK_SIL = new THREE.Color('#7d5a48')
  const HEMI_SKY_NIGHT = new THREE.Color('#5a6678')
  const HEMI_SKY_DAY = new THREE.Color('#cfe2f2')
  const HEMI_GROUND_NIGHT = new THREE.Color('#241d16')
  const HEMI_GROUND_DAY = new THREE.Color('#5f6a52')
  const SUN_LOW = new THREE.Color('#ffb066')
  const SUN_HIGH = new THREE.Color('#fff2dc')
  const WIN_NIGHT = new THREE.Color('#ffd27d')
  const WIN_DAY = new THREE.Color('#31404c')
  const MEADOW_NIGHT = new THREE.Color('#9aa392')
  const MEADOW_DAY = new THREE.Color('#ffffff')

  const birth = performance.now()

  const update = (camPos: THREE.Vector3, todOverride?: number) => {
    const now = performance.now()
    const tod = todOverride !== undefined
      ? todOverride
      : (START_TOD + (now - birth) / (1000 * DAY_LEN)) % 1
    const a = (tod - 0.25) * Math.PI * 2
    const sunEl = Math.sin(a)
    const moonEl = -sunEl
    const day = smooth01((sunEl + 0.06) / 0.28)
    const night = 1 - day
    const twilight = Math.max(0, 1 - Math.abs(sunEl) / 0.26)
    const moonUp = smooth01(moonEl / 0.3)
    // how deep inside the house shell the camera is; damps the (shadowless)
    // sun and the daylight ambience so noon can't torch the interior
    const dxIn = Math.min(camPos.x - HOUSE.minX, HOUSE.maxX - camPos.x)
    const dzIn = Math.min(camPos.z - HOUSE.minZ, HOUSE.maxZ - camPos.z)
    const indoor = smooth01(Math.min(dxIn, dzIn) / 1.1)

    state.day = day
    state.night = night
    state.twilight = twilight
    state.sunEl = sunEl
    state.moonUp = moonUp
    state.indoor = indoor
    state.fogNear = 14 + day * 14
    state.fogFar = 82 + day * 210
    state.fogColor.lerpColors(FOG_NIGHT, FOG_DAY, day)
    if (twilight > 0.001) state.fogColor.lerp(FOG_DUSK, twilight * 0.45)
    state.hemiSky.lerpColors(HEMI_SKY_NIGHT, HEMI_SKY_DAY, day)
    state.hemiGround.lerpColors(HEMI_GROUND_NIGHT, HEMI_GROUND_DAY, day)
    state.dayBoost = 1 + 2.1 * day * (1 - 0.7 * indoor)

    // celestial bodies ride the orbit; each hides once it dips well under
    sun.visible = sunEl > -0.14
    if (sun.visible) {
      sun.position.set(Math.cos(a) * 200, sunEl * 200, 42)
      sun.lookAt(0, 2, 8)
    }
    moon.visible = moonEl > -0.14
    if (moon.visible) {
      moon.position.set(-Math.cos(a) * 200, moonEl * 200, 42)
      moon.lookAt(0, 2, 8)
    }
    sunLight.position.set(Math.cos(a) * 60, Math.max(0.02, sunEl) * 60, 12.6)
    sunLight.intensity = 2.3 * Math.pow(Math.max(0, sunEl), 0.65) * (1 - 0.88 * indoor)
    sunLight.color.lerpColors(SUN_LOW, SUN_HIGH, clamp01(sunEl * 1.6))

    dayMat.opacity = day
    twilightMat.opacity = twilight * 0.8
    hazeMat.opacity = night

    // city: silhouettes shade toward the sky with depth and daylight, and
    // warm up against the twilight band at dawn and dusk
    layers.forEach((l) => {
      l.mat.color.lerpColors(l.night, l.day, day)
      if (twilight > 0.001) l.mat.color.lerp(DUSK_SIL, twilight * 0.3)
    })
    winMats.forEach((w) => {
      w.opacity = (w.userData.base as number) * night
    })
    const t = now / 1000
    beaconMats.forEach((b, i) => {
      b.opacity = Math.pow(Math.max(0, Math.sin(t * 2.1 + i * 2.1)), 12) * 0.9
    })

    // streetlamps and the neighbors' curtains follow the dark
    bulbMat.emissiveIntensity = 3.2 * night
    lampGlowMat.opacity = 0.5 * night
    lampPoolMat.opacity = 0.4 * night
    winLitMat.color.lerpColors(WIN_NIGHT, WIN_DAY, day)
    meadowMat.color.lerpColors(MEADOW_NIGHT, MEADOW_DAY, day)

    // the red-eye, strobing through its slow circle
    const pa = t * 0.028
    redEye.position.set(Math.cos(pa) * 132, 106, Math.sin(pa) * 132 + 10)
    redEye.lookAt(0, 0, 8)
    planeMat.opacity =
      (0.08 + Math.pow(Math.max(0, Math.sin(t * 5.2)), 24) * 0.85) * (0.35 + 0.65 * night)

    return state
  }

  return { root, update, furnish }
}
