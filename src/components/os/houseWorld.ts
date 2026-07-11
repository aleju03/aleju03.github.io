import * as THREE from 'three'

/** anything with a .scene group — a GLTFLoader result or a slice of one */
export interface ModelLike {
  scene: THREE.Group
}

/*
  The rest of the house around the bedroom/office: hallway, bathroom, open
  living room + kitchen, and a fenced yard with a front gate onto the street.
  Everything past the fence — sky, sun and moon, the city, the neighborhood —
  lives in outsideWorld.ts; this module owns the property line inward.

  Two phases so the boot flow never waits on furniture:
  - buildHouse() is procedural architecture only (walls, floors, ceilings,
    windows, doors, lights, yard ground, sky). It runs synchronously with the
    core desk models, so the whole house is walkable immediately.
  - handles.furnish() attaches the ~35 downloaded GLBs (bed, sofa, kitchen
    run, fence, trees...) whenever they finish streaming in.

  Walls are built per room: every room lays down its own full perimeter with
  door/window holes cut out, and every solid segment registers a thick AABB
  obstacle (0.8 deep — a sprinting step is ~0.3, so nobody tunnels through a
  wall face). Doors are hinge pivots worked with the interact key: a closed
  one swings away from whichever side the player stands on, an open one pulls
  shut, and the doorway itself is an obstacle while the leaf is in the way.
  They cast no shadows so the baked maps stay valid.
*/

export interface HouseModels {
  [key: string]: ModelLike | undefined
}

export interface HouseHandles {
  root: THREE.Group
  /** door easing and firefly drift; call every roam frame */
  update: (dt: number) => void
  /** the door within reach the player is looking at: which verb to prompt */
  doorPrompt: (p: THREE.Vector3, gaze: THREE.Vector3) => 'open' | 'close' | null
  /** work that door; a closed leaf swings away from the player's side */
  useDoor: (p: THREE.Vector3, gaze: THREE.Vector3) => boolean
  /** 0 seated .. 1 walking: ramps every house light with the room rig */
  setRoamLight: (k: number) => void
  /** 0 night .. 1 day: fades fireflies and the curtained-window glow out */
  setDay: (day: number) => void
  /** mark the shadow maps near the player dirty (call only while moving) */
  flagShadows: (p: THREE.Vector3) => void
  /** shadow-casting lights owned by the house (for full re-bakes) */
  shadowLights: THREE.SpotLight[]
  /** attach the streamed furniture models; safe to call once, any time */
  furnish: (models: HouseModels) => void
}

interface BuildOpts {
  scene: THREE.Scene
  obstacles: THREE.Box3[]
  /** shared materials from the desk scene so the house matches it */
  darkWoodMat: THREE.MeshStandardMaterial
  windowGlassMat: THREE.MeshStandardMaterial
  /** the pendant-lamp model (a core one), cloned for the other ceilings */
  lamp: ModelLike
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

/* ---------------------------------------------------------------- plan --
   Bedroom (existing): x -7.6..7.6, z -1.75..10.5. Door in its north wall.
   Bath:  x -7.6..-2.4, z 10.5..16.6   (door from the hall's west end)
   Hall:  x -2.4..7.6,  z 10.5..14.0   (arch opening to the living room)
   Living+kitchen: x -7.6..7.6, z 14..24.5 minus the bath block corner.
   Yard: fenced x ±13.5 out to z 38.5; back door + porch on the north wall.
------------------------------------------------------------------------- */
export const CEIL_H = 6
export const HOUSE = { minX: -7.6, maxX: 7.6, minZ: -1.75, maxZ: 24.5 }
export const YARD = { minX: -13.5, maxX: 13.5, minZ: -4, maxZ: 38.5 }
/** gap in the front fence: the way out to the street */
export const GATE = { x0: -1.3, x1: 1.3 }
/** the backrooms seam: this span of the east living-room wall is dressed
    like wall but never blocks — walking into it noclips you into level 0
    (backrooms.ts owns everything past the paint) */
export const NOCLIP = { z0: 16.0, z1: 17.8 }
const BATH = { minX: -7.6, maxX: -2.4, minZ: 10.5, maxZ: 16.6 }
const HALL = { minX: BATH.maxX, maxX: 7.6, minZ: 10.5, maxZ: 14.0 }
const DOOR_H = 4.7
const BED_DOOR = { u0: 2.5, u1: 4.6 } // in the z=10.5 wall
const BATH_DOOR = { u0: 11.6, u1: 13.7 } // in the x=-3 wall
const ARCH = { u0: 0.0, u1: 3.4, h: 4.9 } // cased opening in the z=14 wall
const BACK_DOOR = { u0: -4.6, u1: -2.5 } // in the z=24.5 wall
const BACK_WIN = { u0: 2.3, u1: 6.1, y0: 2.5, y1: 4.7 }
const SINK_WIN = { u0: 20.5, u1: 22.1, y0: 2.9, y1: 4.3 }
const BATH_WIN = { u0: 12.5, u1: 13.7, y0: 3.3, y1: 4.5 }
const BEDROOM_WIN = { u0: 4.86, u1: 6.64, y0: 2.73, y1: 3.87 }

export const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}

/* ------------------------------------------------------- canvas textures */

export const canvasTexture = (
  size: [number, number],
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  repeat?: [number, number],
) => {
  const canvas = document.createElement('canvas')
  canvas.width = size[0]
  canvas.height = size[1]
  const ctx = canvas.getContext('2d')
  if (ctx) draw(ctx, size[0], size[1])
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(repeat[0], repeat[1])
  }
  tex.anisotropy = 4
  return tex
}

/** wood planks running along x; two palettes keep bedroom and living apart */
const makePlankTexture = (base: string, seam: string, seed: number) =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const rand = seeded(seed)
    ctx.fillStyle = base
    ctx.fillRect(0, 0, w, h)
    const rows = 4
    for (let r = 0; r < rows; r++) {
      const y = (r / rows) * h
      const shade = (rand() - 0.5) * 14
      ctx.fillStyle = `rgba(${shade > 0 ? '255,240,220' : '0,0,0'},${Math.abs(shade) / 160})`
      ctx.fillRect(0, y, w, h / rows)
      // grain strokes
      for (let i = 0; i < 26; i++) {
        ctx.strokeStyle = `rgba(0,0,0,${0.03 + rand() * 0.05})`
        ctx.lineWidth = 1
        const gy = y + rand() * (h / rows)
        ctx.beginPath()
        ctx.moveTo(0, gy)
        ctx.bezierCurveTo(w * 0.3, gy + (rand() - 0.5) * 3, w * 0.7, gy + (rand() - 0.5) * 3, w, gy)
        ctx.stroke()
      }
      // plank end seams, staggered per row
      ctx.fillStyle = seam
      ctx.fillRect(0, y, w, 2)
      const ends = 1 + Math.floor(rand() * 2)
      for (let e = 0; e < ends; e++) ctx.fillRect(rand() * w, y, 2, h / rows)
    }
  })

const makeTileTexture = () =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const rand = seeded(0x7e11)
    const n = 4
    const s = w / n
    for (let ty = 0; ty < n; ty++)
      for (let tx = 0; tx < n; tx++) {
        const v = 196 + Math.floor(rand() * 14)
        ctx.fillStyle = `rgb(${v - 14},${v - 6},${v - 8})`
        ctx.fillRect(tx * s, ty * s, s, s)
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(tx * s + 2, ty * s + 2, s - 4, s / 3)
      }
    ctx.strokeStyle = '#5a615c'
    ctx.lineWidth = 3
    for (let i = 0; i <= n; i++) {
      ctx.beginPath()
      ctx.moveTo(i * s, 0)
      ctx.lineTo(i * s, h)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, i * s)
      ctx.lineTo(w, i * s)
      ctx.stroke()
    }
  })

const makeGrassTexture = () =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const rand = seeded(0x97a55)
    ctx.fillStyle = '#233618'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 2600; i++) {
      const g = 52 + rand() * 46
      ctx.fillStyle = `rgba(${g * 0.55},${g},${g * 0.42},${0.25 + rand() * 0.5})`
      ctx.fillRect(rand() * w, rand() * h, 1 + (rand() < 0.2 ? 1 : 0), 1 + (rand() < 0.3 ? 1 : 0))
    }
    // worn patches
    for (let i = 0; i < 7; i++) {
      const grad = ctx.createRadialGradient(
        rand() * w, rand() * h, 2, rand() * w, rand() * h, 18 + rand() * 26)
      grad.addColorStop(0, 'rgba(52,48,26,0.16)')
      grad.addColorStop(1, 'rgba(52,48,26,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)
    }
  })

export const makeGlowTexture = (inner: string, outer: string) =>
  canvasTexture([128, 128], (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2)
    g.addColorStop(0, inner)
    g.addColorStop(1, outer)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })

const makeTuftTexture = () =>
  canvasTexture([64, 64], (ctx, w, h) => {
    const rand = seeded(0x9f01)
    ctx.clearRect(0, 0, w, h)
    for (let i = 0; i < 26; i++) {
      const x = 6 + rand() * (w - 12)
      const top = h * (0.12 + rand() * 0.3)
      const lean = (rand() - 0.5) * 14
      const g = 96 + rand() * 60
      ctx.strokeStyle = `rgba(${g * 0.5},${g},${g * 0.38},0.95)`
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(x, h)
      ctx.quadraticCurveTo(x + lean * 0.4, (h + top) / 2, x + lean, top)
      ctx.stroke()
    }
  })

/* --------------------------------------------------------------- helpers */

const tmpBox = new THREE.Box3()
const tmpVec = new THREE.Vector3()
// firefly frame temps, hoisted so the roam loop never allocates
const flyM = new THREE.Matrix4()
const flyQ = new THREE.Quaternion()
const flyS = new THREE.Vector3(1, 1, 1)

interface Door {
  pivot: THREE.Group
  axis: 'x' | 'z'
  /** the wall-plane coordinate; which side the player is on picks the swing */
  at: number
  /** hinge multiplier: the leaf runs along +u (1, hinge u0) or -u (-1, u1) */
  dir: 1 | -1
  cx: number
  cz: number
  /** how far the leaf swings, magnitude only; sign is chosen per use */
  swing: number
  angle: number
  target: number
  /** blocks the doorway while the leaf is in the way; emptied once clear */
  block: THREE.Box3
  closedMin: THREE.Vector3
  closedMax: THREE.Vector3
  solid: boolean
}

export function buildHouse(opts: BuildOpts): HouseHandles {
  const {
    scene, obstacles, darkWoodMat, windowGlassMat,
    lamp, trackTexture, trackDisposable,
  } = opts

  const root = new THREE.Group()
  scene.add(root)

  const track = (t: THREE.Texture) => {
    trackTexture(t)
    trackDisposable(t)
    return t
  }

  const wallMats = new Map<string, THREE.MeshStandardMaterial>()
  const wallMat = (color: string) => {
    let m = wallMats.get(color)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 1 })
      wallMats.set(color, m)
    }
    return m
  }
  const skirtMat = new THREE.MeshStandardMaterial({ color: '#241c14', roughness: 0.9 })
  const trimMat = darkWoodMat

  const doors: Door[] = []
  const bulbs: Array<{ mat: THREE.MeshStandardMaterial; on: number }> = []
  const lights: Array<{ light: THREE.Light; on: number }> = []
  const shadowLights: THREE.SpotLight[] = []

  /* ------------------------------------------------------------- walls -- */

  interface Cut {
    u0: number
    u1: number
    y0: number
    y1: number
  }
  /**
   * A wall plane at `axis`=const, spanning [u0,u1] along the other axis,
   * floor to CEIL_H, with rectangular holes. Emits visual segments, a
   * baseboard along solid floor spans, and one thick collision box per
   * solid floor span (cutouts that reach the floor become walk-through).
   */
  const wall = (
    axis: 'x' | 'z',
    at: number,
    u0: number,
    u1: number,
    facing: 1 | -1,
    color: string,
    cuts: Cut[] = [],
    o: { base?: boolean; obstacle?: boolean; h?: number } = {},
  ) => {
    const h = o.h ?? CEIL_H
    const mat = wallMat(color)
    const sorted = [...cuts].sort((a, b) => a.u0 - b.u0)
    const panel = (pu0: number, pu1: number, py0: number, py1: number) => {
      if (pu1 - pu0 < 0.01 || py1 - py0 < 0.01) return
      const m = new THREE.Mesh(new THREE.PlaneGeometry(pu1 - pu0, py1 - py0), mat)
      const uc = (pu0 + pu1) / 2
      const yc = (py0 + py1) / 2
      if (axis === 'x') {
        m.position.set(at + facing * 0.01, yc, uc)
        m.rotation.y = (facing * Math.PI) / 2
      } else {
        m.position.set(uc, yc, at + facing * 0.01)
        m.rotation.y = facing === 1 ? 0 : Math.PI
      }
      m.receiveShadow = true
      root.add(m)
    }
    const base = (bu0: number, bu1: number) => {
      if (o.base === false || bu1 - bu0 < 0.12) return
      const m = new THREE.Mesh(new THREE.BoxGeometry(bu1 - bu0, 0.17, 0.06), skirtMat)
      if (axis === 'x') {
        m.position.set(at + facing * 0.05, 0.085, (bu0 + bu1) / 2)
        m.rotation.y = Math.PI / 2
      } else {
        m.position.set((bu0 + bu1) / 2, 0.085, at + facing * 0.05)
      }
      m.receiveShadow = true
      root.add(m)
    }
    const block = (bu0: number, bu1: number) => {
      if (o.obstacle === false || bu1 - bu0 < 0.05) return
      obstacles.push(
        axis === 'x'
          ? new THREE.Box3(new THREE.Vector3(at - 0.4, 0, bu0), new THREE.Vector3(at + 0.4, h, bu1))
          : new THREE.Box3(new THREE.Vector3(bu0, 0, at - 0.4), new THREE.Vector3(bu1, h, at + 0.4)),
      )
    }
    let cursor = u0
    for (const c of sorted) {
      panel(cursor, c.u0, 0, h)
      base(cursor, c.u0)
      block(cursor, c.u0)
      panel(c.u0, c.u1, 0, c.y0)
      panel(c.u0, c.u1, c.y1, h)
      if (c.y0 > 0.5) {
        // window: wall below it still blocks and keeps its baseboard
        base(c.u0, c.u1)
        block(c.u0, c.u1)
      }
      cursor = c.u1
    }
    panel(cursor, u1, 0, h)
    base(cursor, u1)
    block(cursor, u1)
  }

  /* ------------------------------------------------- windows and doors -- */

  const windowUnit = (
    axis: 'x' | 'z',
    at: number,
    u0: number,
    u1: number,
    y0: number,
    y1: number,
    frosted = false,
  ) => {
    const g = new THREE.Group()
    const w = u1 - u0
    const h = y1 - y0
    const mat = frosted
      ? new THREE.MeshStandardMaterial({
          color: '#cfd8d2', roughness: 0.55, transparent: true, opacity: 0.62,
          emissive: new THREE.Color('#3a4450'), emissiveIntensity: 0.25,
          depthWrite: false, side: THREE.DoubleSide,
        })
      : windowGlassMat
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    pane.renderOrder = 8
    g.add(pane)
    const rails: Array<[number, number, number, number, number]> = [
      // w, h, x, y, z-out
      [w + 0.22, 0.11, 0, h / 2 + 0.05, 0.04],
      [w + 0.22, 0.13, 0, -h / 2 - 0.05, 0.05], // sill, a touch deeper
      [0.11, h + 0.22, -w / 2 - 0.05, 0, 0.04],
      [0.11, h + 0.22, w / 2 + 0.05, 0, 0.04],
      [0.07, h, 0, 0, 0.03],
      [w, 0.06, 0, 0, 0.03],
    ]
    rails.forEach(([rw, rh, x, y, d]) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(rw, rh, 0.08 + d), trimMat)
      rail.position.set(x, y, 0)
      rail.castShadow = false
      rail.receiveShadow = true
      g.add(rail)
    })
    const uc = (u0 + u1) / 2
    const yc = (y0 + y1) / 2
    if (axis === 'x') {
      g.position.set(at, yc, uc)
      g.rotation.y = Math.PI / 2
    } else {
      g.position.set(uc, yc, at)
    }
    root.add(g)
  }

  const doorUnit = (
    axis: 'x' | 'z',
    at: number,
    u0: number,
    u1: number,
    hinge: 'u0' | 'u1',
    swing: number,
    glass = false,
  ) => {
    const w = u1 - u0
    // jambs + header
    const jamb = (uc: number, jw: number, jh: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(jw, jh, 0.24), trimMat)
      if (axis === 'x') {
        m.position.set(at, y, uc)
        m.rotation.y = Math.PI / 2
      } else m.position.set(uc, y, at)
      m.castShadow = false
      m.receiveShadow = true
      root.add(m)
    }
    jamb(u0 - 0.05, 0.14, DOOR_H + 0.12, (DOOR_H + 0.12) / 2)
    jamb(u1 + 0.05, 0.14, DOOR_H + 0.12, (DOOR_H + 0.12) / 2)
    jamb((u0 + u1) / 2, w + 0.24, 0.16, DOOR_H + 0.1)

    const pivot = new THREE.Group()
    const hu = hinge === 'u0' ? u0 : u1
    const dir = hinge === 'u0' ? 1 : -1
    if (axis === 'x') pivot.position.set(at, 0, hu)
    else pivot.position.set(hu, 0, at)

    const slab = new THREE.Group()
    const slabMat = new THREE.MeshStandardMaterial({ color: '#4f3a26', roughness: 0.72 })
    trackDisposable(slabMat)
    // the leaf runs a touch wider and taller than the opening so it laps the
    // jambs and header when shut: no lit slivers around a closed door
    const leafW = w + 0.08
    const leafH = DOOR_H + 0.01
    if (glass) {
      // stile-and-rail glass door onto the porch
      const railH = 0.5
      const stileW = 0.24
      const parts: Array<[number, number, number, number]> = [
        [leafW, railH, 0, railH / 2 + 0.02],
        [leafW, railH * 1.6, 0, DOOR_H - railH * 0.8 - 0.05],
        [leafW, railH, 0, DOOR_H * 0.45],
        [stileW, leafH, -leafW / 2 + stileW / 2, leafH / 2],
        [stileW, leafH, leafW / 2 - stileW / 2, leafH / 2],
      ]
      parts.forEach(([pw, ph, x, y]) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, 0.09), slabMat)
        m.position.set(x, y, 0)
        m.castShadow = false
        slab.add(m)
      })
      const paneDefs: Array<[number, number]> = [
        [(railH + DOOR_H * 0.45) / 2 + 0.1, DOOR_H * 0.45 - railH - 0.1],
        [(DOOR_H * 0.45 + railH / 2 + DOOR_H - railH * 1.6) / 2, DOOR_H * 0.5 - railH * 1.55],
      ]
      paneDefs.forEach(([y, ph]) => {
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.5, ph), windowGlassMat)
        pane.position.set(0, y, 0)
        pane.renderOrder = 8
        slab.add(pane)
      })
    } else {
      const m = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, 0.09), slabMat)
      m.position.set(0, leafH / 2, 0)
      m.castShadow = false
      m.receiveShadow = true
      slab.add(m)
      // inset panels, front and back
      const panelMat = new THREE.MeshStandardMaterial({ color: '#453321', roughness: 0.78 })
      trackDisposable(panelMat)
      ;[0.052, -0.052].forEach((z) => {
        ;[1.35, 3.35].forEach((y) => {
          const p = new THREE.Mesh(new THREE.BoxGeometry(w - 0.6, 1.5, 0.02), panelMat)
          p.position.set(0, y, z)
          p.castShadow = false
          slab.add(p)
        })
      })
    }
    // handle both sides
    const handleMat = new THREE.MeshStandardMaterial({
      color: '#b8a26a', roughness: 0.35, metalness: 0.6,
    })
    trackDisposable(handleMat)
    ;[0.1, -0.1].forEach((z) => {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), handleMat)
      knob.position.set(dir * (w / 2 - 0.45), 2.2, z)
      knob.castShadow = false
      slab.add(knob)
    })
    // a real gap under the leaf, so it sweeps over rugs instead of through
    slab.position.set(dir * (w / 2), 0.055, 0)
    pivot.add(slab)
    // for x-walls the leaf's local +x must run along +z (hinge toward latch)
    pivot.rotation.y = axis === 'x' ? -Math.PI / 2 : 0
    pivot.userData.baseRotY = pivot.rotation.y
    pivot.userData.dynamic = true // survives the scene-wide matrix freeze
    root.add(pivot)
    const center = axis === 'x'
      ? { cx: at, cz: (u0 + u1) / 2 }
      : { cx: (u0 + u1) / 2, cz: at }
    // a shut door is a wall: block the doorway until the leaf swings clear
    const closedMin = axis === 'x'
      ? new THREE.Vector3(at - 0.35, 0, u0)
      : new THREE.Vector3(u0, 0, at - 0.35)
    const closedMax = axis === 'x'
      ? new THREE.Vector3(at + 0.35, CEIL_H, u1)
      : new THREE.Vector3(u1, CEIL_H, at + 0.35)
    const block = new THREE.Box3(closedMin.clone(), closedMax.clone())
    obstacles.push(block)
    doors.push({
      pivot, axis, at, dir, ...center, swing,
      angle: 0, target: 0, block, closedMin, closedMax, solid: true,
    })
  }

  /* ------------------------------------------------------- floor planes -- */

  const plankBedTex = track(makePlankTexture('#2a2018', '#1c150e', 0xbed0))
  const plankLivTex = track(makePlankTexture('#32261c', '#221912', 0x11f0))
  const tileTex = track(makeTileTexture())
  const grassTex = track(makeGrassTexture())

  const floorPlane = (
    x0: number, x1: number, z0: number, z1: number,
    tex: THREE.Texture, texScale: number, y = 0,
  ) => {
    const t = tex.clone()
    t.needsUpdate = true
    t.repeat.set((x1 - x0) / texScale, (z1 - z0) / texScale)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 4
    trackTexture(t)
    trackDisposable(t)
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.94, map: t })
    trackDisposable(mat)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat)
    m.rotation.x = -Math.PI / 2
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2)
    m.receiveShadow = true
    root.add(m)
    return m
  }

  const ceiling = (x0: number, x1: number, z0: number, z1: number, color: string) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(x1 - x0, z1 - z0),
      wallMat(color),
    )
    m.rotation.x = Math.PI / 2
    m.position.set((x0 + x1) / 2, CEIL_H, (z0 + z1) / 2)
    m.receiveShadow = true
    root.add(m)
  }

  /* ============================================================ INTERIOR */

  // -- bedroom shell (the desk scene's original room, now with a real door)
  wall('z', HOUSE.minZ, HOUSE.minX, HOUSE.maxX, 1, '#3d3328')
  wall('x', HOUSE.minX, HOUSE.minZ, 10.5, 1, '#4a3d30', [
    { u0: BEDROOM_WIN.u0, u1: BEDROOM_WIN.u1, y0: BEDROOM_WIN.y0, y1: BEDROOM_WIN.y1 },
  ])
  wall('x', HOUSE.maxX, HOUSE.minZ, 10.5, -1, '#4a3d30')
  wall('z', 10.5, HOUSE.minX, HOUSE.maxX, -1, '#50412f', [
    { u0: BED_DOOR.u0, u1: BED_DOOR.u1, y0: 0, y1: DOOR_H },
  ])
  floorPlane(HOUSE.minX, HOUSE.maxX, HOUSE.minZ, 10.5, plankBedTex, 3.4)
  ceiling(HOUSE.minX, HOUSE.maxX, HOUSE.minZ, 10.5, '#3a3129')
  windowUnit('x', HOUSE.minX + 0.045, BEDROOM_WIN.u0, BEDROOM_WIN.u1, BEDROOM_WIN.y0, BEDROOM_WIN.y1)

  // -- bath
  wall('z', BATH.minZ, BATH.minX, BATH.maxX, 1, '#565f56')
  wall('x', BATH.maxX, BATH.minZ, BATH.maxZ, -1, '#565f56', [
    { u0: BATH_DOOR.u0, u1: BATH_DOOR.u1, y0: 0, y1: DOOR_H },
  ])
  wall('z', BATH.maxZ, BATH.minX, BATH.maxX, -1, '#565f56')
  wall('x', BATH.minX, BATH.minZ, BATH.maxZ, 1, '#565f56', [
    { u0: BATH_WIN.u0, u1: BATH_WIN.u1, y0: BATH_WIN.y0, y1: BATH_WIN.y1 },
  ])
  floorPlane(BATH.minX, BATH.maxX, BATH.minZ, BATH.maxZ, tileTex, 2.3, 0.004)
  ceiling(BATH.minX, BATH.maxX, BATH.minZ, BATH.maxZ, '#3f4440')
  windowUnit('x', BATH.minX + 0.045, BATH_WIN.u0, BATH_WIN.u1, BATH_WIN.y0, BATH_WIN.y1, true)

  // -- hall
  wall('z', HALL.minZ, HALL.minX, HALL.maxX, 1, '#4a4034', [
    { u0: BED_DOOR.u0, u1: BED_DOOR.u1, y0: 0, y1: DOOR_H },
  ])
  wall('x', HALL.minX, HALL.minZ, HALL.maxZ, 1, '#4a4034', [
    { u0: BATH_DOOR.u0, u1: BATH_DOOR.u1, y0: 0, y1: DOOR_H },
  ])
  wall('x', HALL.maxX, HALL.minZ, HALL.maxZ, -1, '#4a4034')
  wall('z', HALL.maxZ, HALL.minX, HALL.maxX, -1, '#4a4034', [
    { u0: ARCH.u0, u1: ARCH.u1, y0: 0, y1: ARCH.h },
  ])
  floorPlane(HALL.minX, HALL.maxX, HALL.minZ, HALL.maxZ, plankBedTex, 3.4, 0.002)
  ceiling(HALL.minX, HALL.maxX, HALL.minZ, HALL.maxZ, '#3a3129')

  // -- living room + kitchen (L-shaped around the bath block)
  wall('z', 14, HALL.minX, HALL.maxX, 1, '#4d4136', [
    { u0: ARCH.u0, u1: ARCH.u1, y0: 0, y1: ARCH.h },
  ])
  wall('x', BATH.maxX, 14, BATH.maxZ, 1, '#4d4136')
  wall('z', BATH.maxZ, BATH.minX, BATH.maxX, 1, '#4d4136')
  wall('x', HOUSE.minX, BATH.maxZ, HOUSE.maxZ, 1, '#4d4136', [
    { u0: SINK_WIN.u0, u1: SINK_WIN.u1, y0: SINK_WIN.y0, y1: SINK_WIN.y1 },
  ])
  wall('z', HOUSE.maxZ, HOUSE.minX, HOUSE.maxX, -1, '#544636', [
    { u0: BACK_DOOR.u0, u1: BACK_DOOR.u1, y0: 0, y1: DOOR_H },
    { u0: BACK_WIN.u0, u1: BACK_WIN.u1, y0: BACK_WIN.y0, y1: BACK_WIN.y1 },
  ])
  wall('x', HOUSE.maxX, 14, HOUSE.maxZ, -1, '#4d4136', [
    // the backrooms seam: a full-height floor cut, so no panel and no
    // obstacle span it — the disguise below makes it read as wall anyway
    { u0: NOCLIP.z0, u1: NOCLIP.z1, y0: 0, y1: CEIL_H },
  ])
  floorPlane(HOUSE.minX, HOUSE.maxX, BATH.maxZ, HOUSE.maxZ, plankLivTex, 3.4)
  floorPlane(HALL.minX, HOUSE.maxX, 14, BATH.maxZ, plankLivTex, 3.4)
  ceiling(HOUSE.minX, HOUSE.maxX, BATH.maxZ, HOUSE.maxZ, '#3a332b')
  ceiling(HALL.minX, HOUSE.maxX, 14, BATH.maxZ, '#3a332b')
  windowUnit('x', HOUSE.minX + 0.045, SINK_WIN.u0, SINK_WIN.u1, SINK_WIN.y0, SINK_WIN.y1)
  windowUnit('z', HOUSE.maxZ - 0.045, BACK_WIN.u0, BACK_WIN.u1, BACK_WIN.y0, BACK_WIN.y1)

  // dress the backrooms seam as wall again: same paint, same baseboard,
  // recessed a couple of centimeters so it can't z-fight its neighbors —
  // the hairline shadow around it is the only visual tell (that, and the
  // damp stain backrooms.ts hangs on it)
  const slip = new THREE.Mesh(
    new THREE.PlaneGeometry(NOCLIP.z1 - NOCLIP.z0, CEIL_H), wallMat('#4d4136'))
  slip.position.set(HOUSE.maxX + 0.01, CEIL_H / 2, (NOCLIP.z0 + NOCLIP.z1) / 2)
  slip.rotation.y = -Math.PI / 2
  slip.receiveShadow = true
  root.add(slip)
  const slipBase = new THREE.Mesh(
    new THREE.BoxGeometry(NOCLIP.z1 - NOCLIP.z0, 0.17, 0.06), skirtMat)
  slipBase.position.set(HOUSE.maxX - 0.05, 0.085, (NOCLIP.z0 + NOCLIP.z1) / 2)
  slipBase.rotation.y = Math.PI / 2
  slipBase.receiveShadow = true
  root.add(slipBase)

  // arch casing between hall and living room
  ;[ARCH.u0 - 0.05, ARCH.u1 + 0.05].forEach((x) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.14, ARCH.h + 0.1, 0.3), trimMat)
    m.position.set(x, (ARCH.h + 0.1) / 2, 14)
    m.castShadow = false
    m.receiveShadow = true
    root.add(m)
  })
  const archHeader = new THREE.Mesh(
    new THREE.BoxGeometry(ARCH.u1 - ARCH.u0 + 0.24, 0.18, 0.3), trimMat)
  archHeader.position.set((ARCH.u0 + ARCH.u1) / 2, ARCH.h + 0.08, 14)
  archHeader.castShadow = false
  root.add(archHeader)

  // the bath block's two outside corners: the one-sided wall planes sit a
  // hair off the mathematical corner, so the bare edge shows a sliver of the
  // room behind it at grazing angles — a slim post seals each seam
  ;[
    [BATH.maxX, HALL.maxZ],
    [BATH.maxX, BATH.maxZ],
  ].forEach(([x, z]) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, CEIL_H, 0.18), wallMat('#4d4136'))
    post.position.set(x, CEIL_H / 2, z)
    post.castShadow = false
    post.receiveShadow = true
    root.add(post)
  })

  // -- doors; each swings away from whoever opens it, so no fixed side here
  doorUnit('z', 10.5, BED_DOOR.u0, BED_DOOR.u1, 'u1', Math.PI * 0.56)
  // the bath leaf stops shy of a right angle so it clears the pedestal sink
  doorUnit('x', BATH.maxX, BATH_DOOR.u0, BATH_DOOR.u1, 'u0', Math.PI * 0.44)
  doorUnit('z', HOUSE.maxZ, BACK_DOOR.u0, BACK_DOOR.u1, 'u0', Math.PI * 0.58, true)

  /* ============================================================ EXTERIOR */

  const facadeColor = '#3c3630'
  // back facade with matching holes, then plain sides and front
  wall('z', HOUSE.maxZ + 0.14, -7.74, 7.74, 1, facadeColor, [
    { u0: BACK_DOOR.u0, u1: BACK_DOOR.u1, y0: 0, y1: DOOR_H },
    { u0: BACK_WIN.u0, u1: BACK_WIN.u1, y0: BACK_WIN.y0, y1: BACK_WIN.y1 },
  ], { base: false, obstacle: false })
  wall('x', HOUSE.minX - 0.14, HOUSE.minZ - 0.14, HOUSE.maxZ + 0.14, -1, facadeColor, [
    { u0: BEDROOM_WIN.u0, u1: BEDROOM_WIN.u1, y0: BEDROOM_WIN.y0, y1: BEDROOM_WIN.y1 },
    { u0: BATH_WIN.u0, u1: BATH_WIN.u1, y0: BATH_WIN.y0, y1: BATH_WIN.y1 },
    { u0: SINK_WIN.u0, u1: SINK_WIN.u1, y0: SINK_WIN.y0, y1: SINK_WIN.y1 },
  ], { base: false, obstacle: false })
  wall('x', HOUSE.maxX + 0.14, HOUSE.minZ - 0.14, HOUSE.maxZ + 0.14, 1, facadeColor,
    [], { base: false, obstacle: false })
  wall('z', HOUSE.minZ - 0.14, -7.74, 7.74, -1, facadeColor, [], { base: false, obstacle: false })
  // fascia band ringing the roofline
  const fasciaMat = new THREE.MeshStandardMaterial({ color: '#2b241d', roughness: 0.9 })
  trackDisposable(fasciaMat)
  const fascia = (w: number, d: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.55, d), fasciaMat)
    m.position.set(x, CEIL_H + 0.24, z)
    m.castShadow = false
    root.add(m)
  }
  fascia(15.9, 0.5, 0, HOUSE.maxZ + 0.05)
  fascia(15.9, 0.5, 0, HOUSE.minZ - 0.05)
  fascia(0.5, HOUSE.maxZ - HOUSE.minZ + 0.6, HOUSE.minX - 0.05, (HOUSE.minZ + HOUSE.maxZ) / 2)
  fascia(0.5, HOUSE.maxZ - HOUSE.minZ + 0.6, HOUSE.maxX + 0.05, (HOUSE.minZ + HOUSE.maxZ) / 2)

  // -- ground: mowed lawn inside the property (the meadow beyond the fence
  // is outsideWorld's business now)
  const lawnMat = new THREE.MeshStandardMaterial({ roughness: 1, map: grassTex })
  trackDisposable(lawnMat)
  grassTex.repeat.set(9, 14)
  const lawn = new THREE.Mesh(
    new THREE.PlaneGeometry(YARD.maxX - YARD.minX, YARD.maxZ - YARD.minZ), lawnMat)
  lawn.rotation.x = -Math.PI / 2
  lawn.position.set(0, -0.02, (YARD.minZ + YARD.maxZ) / 2)
  lawn.receiveShadow = true
  root.add(lawn)

  // porch slab + stepping stones bending toward the bench corner
  const concreteMat = new THREE.MeshStandardMaterial({ color: '#565550', roughness: 0.9 })
  trackDisposable(concreteMat)
  const porch = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.12, 2.8), concreteMat)
  porch.position.set(-3.55, 0.06, HOUSE.maxZ + 1.45)
  porch.receiveShadow = true
  root.add(porch)
  const stoneGeo = new THREE.CylinderGeometry(0.62, 0.68, 0.09, 7)
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#4a4a46', roughness: 0.95 })
  trackDisposable(stoneMat)
  const stonePath: Array<[number, number]> = [
    [-2.1, 27.3], [-1.0, 28.4], [0.2, 29.3], [1.5, 30.1],
    [2.8, 30.9], [3.9, 31.9], [4.6, 33.1],
  ]
  const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, stonePath.length)
  const stoneM = new THREE.Matrix4()
  const stoneQ = new THREE.Quaternion()
  const stoneE = new THREE.Euler()
  stonePath.forEach(([x, z], i) => {
    stoneQ.setFromEuler(stoneE.set(0, (i * 1.7) % Math.PI, 0))
    stoneM.compose(tmpVec.set(x, 0.02, z), stoneQ, new THREE.Vector3(1, 1, 1).setScalar(0.9 + (i % 3) * 0.12))
    stones.setMatrixAt(i, stoneM)
  })
  stones.receiveShadow = true
  root.add(stones)

  /* ---------------------------------------------------- street face -- */

  // the front of the house is on the walk to the gate now, so it has to
  // read like a home from the road: a proper (never-opening) front door
  // and two curtained windows glowing from rooms the floor plan keeps to
  // itself — the oldest trick in the level-design book
  const frontZ = HOUSE.minZ - 0.14
  const frontDoorMat = new THREE.MeshStandardMaterial({ color: '#43301e', roughness: 0.7 })
  trackDisposable(frontDoorMat)
  const frontDoor = new THREE.Mesh(new THREE.BoxGeometry(2.1, DOOR_H, 0.14), frontDoorMat)
  frontDoor.position.set(0, DOOR_H / 2, frontZ - 0.06)
  frontDoor.castShadow = false
  frontDoor.receiveShadow = true
  root.add(frontDoor)
  ;[-1.12, 1.12].forEach((x) => {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.16, DOOR_H + 0.14, 0.22), trimMat)
    jamb.position.set(x, (DOOR_H + 0.14) / 2, frontZ - 0.04)
    jamb.castShadow = false
    root.add(jamb)
  })
  const frontHeader = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.18, 0.22), trimMat)
  frontHeader.position.set(0, DOOR_H + 0.1, frontZ - 0.04)
  frontHeader.castShadow = false
  root.add(frontHeader)
  const frontKnob = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 10, 8),
    new THREE.MeshStandardMaterial({ color: '#b8a26a', roughness: 0.35, metalness: 0.6 }),
  )
  trackDisposable(frontKnob.material as THREE.Material)
  frontKnob.position.set(0.72, 2.2, frontZ - 0.16)
  frontKnob.castShadow = false
  root.add(frontKnob)

  const curtainMats: THREE.MeshStandardMaterial[] = []
  const curtainWindow = (cx: number, y0: number, y1: number, w: number) => {
    const mat = new THREE.MeshStandardMaterial({
      color: '#4a3b28', roughness: 1,
      emissive: new THREE.Color('#ffc98a'), emissiveIntensity: 1.1,
    })
    trackDisposable(mat)
    curtainMats.push(mat)
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, y1 - y0), mat)
    pane.position.set(cx, (y0 + y1) / 2, frontZ - 0.02)
    pane.rotation.y = Math.PI
    root.add(pane)
    const rail = (rw: number, rh: number, x: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(rw, rh, 0.1), trimMat)
      m.position.set(x, y, frontZ - 0.05)
      m.castShadow = false
      root.add(m)
    }
    rail(w + 0.22, 0.11, cx, y1 + 0.05)
    rail(w + 0.22, 0.13, cx, y0 - 0.05)
    rail(0.11, y1 - y0 + 0.22, cx - w / 2 - 0.05, (y0 + y1) / 2)
    rail(0.11, y1 - y0 + 0.22, cx + w / 2 + 0.05, (y0 + y1) / 2)
    rail(0.07, y1 - y0, cx, (y0 + y1) / 2)
  }
  curtainWindow(-4.3, 2.5, 4.1, 1.8)
  curtainWindow(4.3, 2.5, 4.1, 1.8)

  // stoop + a straight concrete walk from the front door to the gate
  const stoop = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.16, 0.9), concreteMat)
  stoop.position.set(0, 0.08, HOUSE.minZ - 0.6)
  stoop.receiveShadow = true
  root.add(stoop)
  // spans the gap between the stoop's front edge (z -2.8) and the gate
  const frontWalk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.07, -2.8 - YARD.minZ), concreteMat)
  frontWalk.position.set(0, 0.035, (-2.8 + YARD.minZ) / 2)
  frontWalk.receiveShadow = true
  root.add(frontWalk)
  // gate posts cap the fence ends at the gap
  ;[GATE.x0 - 0.09, GATE.x1 + 0.09].forEach((x) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.1, 0.2), darkWoodMat)
    post.position.set(x, 1.05, YARD.minZ)
    post.castShadow = false
    root.add(post)
  })

  /* --------------------------------------------------------------- yard -- */

  // fence obstacles now; the picket meshes arrive with the furniture GLBs
  const fenceBlock = (x0: number, z0: number, x1: number, z1: number) =>
    obstacles.push(new THREE.Box3(
      new THREE.Vector3(Math.min(x0, x1) - 0.4, 0, Math.min(z0, z1) - 0.4),
      new THREE.Vector3(Math.max(x0, x1) + 0.4, 3, Math.max(z0, z1) + 0.4),
    ))
  fenceBlock(YARD.minX, YARD.minZ, YARD.minX, YARD.maxZ)
  fenceBlock(YARD.maxX, YARD.minZ, YARD.maxX, YARD.maxZ)
  fenceBlock(YARD.minX, YARD.maxZ, YARD.maxX, YARD.maxZ)
  fenceBlock(YARD.minX, HOUSE.maxZ, HOUSE.minX, HOUSE.maxZ)
  fenceBlock(HOUSE.maxX, HOUSE.maxZ, YARD.maxX, HOUSE.maxZ)
  // the front line blocks too now that the world continues past it — in two
  // pieces, leaving the gate gap open onto the street
  fenceBlock(YARD.minX, YARD.minZ, GATE.x0, YARD.minZ)
  fenceBlock(GATE.x1, YARD.minZ, YARD.maxX, YARD.minZ)

  // grass tufts: one instanced mesh of crossed alpha quads
  const tuftTex = track(makeTuftTexture())
  const tuftMat = new THREE.MeshStandardMaterial({
    map: tuftTex, alphaTest: 0.42, side: THREE.DoubleSide,
    color: '#88a068', roughness: 1,
  })
  trackDisposable(tuftMat)
  const tuftGeoA = new THREE.PlaneGeometry(1.05, 0.85)
  const tuftGeoB = tuftGeoA.clone().rotateY(Math.PI / 2)
  const tuftGeo = mergeGeoms(tuftGeoA, tuftGeoB)
  tuftGeo.translate(0, 0.4, 0)
  const tuftRand = seeded(0x9baf)
  const tuftMats: THREE.Matrix4[] = []
  const tuftSpot = (x: number, z: number) => {
    // keep tufts off the porch, path and fence line
    if (x > -5.6 && x < -1.5 && z < 27.4) return
    for (const [sx, sz] of stonePath) if ((x - sx) ** 2 + (z - sz) ** 2 < 1.2) return
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, tuftRand() * Math.PI, 0))
    const s = 0.7 + tuftRand() * 0.75
    tuftMats.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * (0.8 + tuftRand() * 0.5), s)))
  }
  for (let i = 0; i < 240; i++)
    tuftSpot(
      YARD.minX + 1 + tuftRand() * (YARD.maxX - YARD.minX - 2),
      HOUSE.maxZ + 0.8 + tuftRand() * (YARD.maxZ - HOUSE.maxZ - 1.6),
    )
  // the side strip the bedroom window looks onto
  for (let i = 0; i < 60; i++)
    tuftSpot(YARD.minX + 0.8 + tuftRand() * 4.6, -2 + tuftRand() * 24)
  // the east strip and the front yard, on the walk around to the gate
  for (let i = 0; i < 40; i++)
    tuftSpot(HOUSE.maxX + 0.7 + tuftRand() * 4.9, -2 + tuftRand() * 24)
  for (let i = 0; i < 36; i++) {
    const x = YARD.minX + 0.8 + tuftRand() * (YARD.maxX - YARD.minX - 1.6)
    if (Math.abs(x) < 1.4) continue // keep the front walk clear
    tuftSpot(x, YARD.minZ + 0.5 + tuftRand() * 1.4)
  }
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, tuftMats.length)
  tuftMats.forEach((m, i) => tufts.setMatrixAt(i, m))
  tufts.castShadow = false
  root.add(tufts)

  // fireflies: additive quads on gentle sine orbits
  const flyTex = track(makeGlowTexture('rgba(255,236,150,0.9)', 'rgba(255,200,80,0)'))
  const flyMat = new THREE.MeshBasicMaterial({
    map: flyTex, transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  })
  trackDisposable(flyMat)
  const flyRand = seeded(0xf17ef1)
  const flies = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.22, 0.22), flyMat, 24)
  const flyBase = Array.from({ length: flies.count }, () => ({
    x: -11 + flyRand() * 23,
    y: 0.7 + flyRand() * 2.2,
    z: HOUSE.maxZ + 2 + flyRand() * 11,
    p0: flyRand() * Math.PI * 2,
    p1: flyRand() * Math.PI * 2,
    r: 0.6 + flyRand() * 1.7,
    s: 0.35 + flyRand() * 0.5,
  }))
  // seed the instance matrices now: update() only runs while roaming, and
  // 24 quads left at the origin would glow under the desk during the intro
  {
    const seedM = new THREE.Matrix4()
    flyBase.forEach((b, i) => {
      seedM.setPosition(b.x, b.y, b.z)
      flies.setMatrixAt(i, seedM)
    })
  }
  flies.frustumCulled = false
  root.add(flies)
  let flyT = 0

  /* ------------------------------------------------------------- lights -- */

  const addLight = (light: THREE.Light, on: number) => {
    lights.push({ light, on })
    root.add(light)
    return light
  }
  const hallLight = addLight(new THREE.PointLight('#ffd9ae', 0, 9.5, 1.8), 8)
  hallLight.position.set(2.3, 5.1, 12.25)
  const bathLight = addLight(new THREE.PointLight('#dce8ff', 0, 8.5, 1.8), 7)
  bathLight.position.set(-5.0, 5.05, 13.55)
  const floorLampLight = addLight(new THREE.PointLight('#ffc98a', 0, 7, 1.7), 6)
  floorLampLight.position.set(7.0, 2.95, 21.2)
  const porchLight = addLight(new THREE.PointLight('#ffb869', 0, 10, 1.7), 6.5)
  porchLight.position.set(-2.0, 2.85, 25.75) // at the porch lantern's cage

  const livkPendant = new THREE.SpotLight('#ffd9ae', 0, 0, 1.08, 0.85, 1.5)
  livkPendant.position.set(3.8, 5.4, 18.4)
  livkPendant.target.position.set(3.8, 0, 18.4)
  livkPendant.castShadow = true
  livkPendant.shadow.mapSize.set(1024, 1024)
  livkPendant.shadow.bias = -0.00005
  livkPendant.shadow.normalBias = 0.03
  livkPendant.shadow.radius = 2
  livkPendant.shadow.blurSamples = 4
  livkPendant.shadow.camera.near = 0.5
  livkPendant.shadow.autoUpdate = false // baked like the bedroom rig
  root.add(livkPendant, livkPendant.target)
  lights.push({ light: livkPendant, on: 62 })
  shadowLights.push(livkPendant)

  // pendant fixtures over the living room and dining table (core lamp model)
  const hangLamp = (x: number, z: number, s: number) => {
    const fixture = lamp.scene.clone(true)
    fixture.scale.setScalar(s)
    fixture.position.set(x, CEIL_H, z)
    fixture.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      mats.forEach((m, i) => {
        const std = m as THREE.MeshStandardMaterial
        if (std.name === 'Light') {
          const own = std.clone()
          own.emissive = new THREE.Color('#ffe0b0')
          own.emissiveIntensity = 0
          trackDisposable(own)
          if (Array.isArray(mesh.material)) mesh.material[i] = own
          else mesh.material = own
          bulbs.push({ mat: own, on: 3.2 })
        }
      })
    })
    root.add(fixture)
  }
  hangLamp(3.8, 18.4, 1.6)
  hangLamp(-2.1, 19.8, 1.35)

  /* -------------------------------------------------------- framed art -- */

  const artLoader = new THREE.TextureLoader()
  const frameArt = (
    src: string, w: number, h: number,
    x: number, y: number, z: number, rotY: number,
  ) => {
    const g = new THREE.Group()
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.18, h + 0.18, 0.06), trimMat)
    frame.castShadow = false
    frame.receiveShadow = true
    g.add(frame)
    const matte = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.06, h + 0.06, 0.02),
      new THREE.MeshStandardMaterial({ color: '#d8cfc0', roughness: 0.9 }),
    )
    trackDisposable(matte.material as THREE.Material)
    matte.position.z = 0.026
    matte.castShadow = false
    g.add(matte)
    const artMat = new THREE.MeshStandardMaterial({ color: '#888', roughness: 0.86 })
    trackDisposable(artMat)
    const art = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.14, h - 0.14), artMat)
    art.position.z = 0.041
    g.add(art)
    artLoader.load(src, (t) => {
      t.colorSpace = THREE.SRGBColorSpace
      trackTexture(t)
      trackDisposable(t)
      artMat.map = t
      artMat.color.set('#fff')
      artMat.needsUpdate = true
      art.updateMatrixWorld(true)
    })
    g.position.set(x, y, z)
    g.rotation.y = rotY
    root.add(g)
  }
  // the hall gallery, and the OS wallpaper joke framed above the bed;
  // the trio sits inside the solid span between the arch casing (~3.52)
  // and the east-wall corner at 7.6 — frames are w+0.18 wide overall
  frameArt('/os/wallpapers/autumn.webp', 1.0, 0.75, 4.2, 3.35, 13.94, Math.PI)
  frameArt('/os/wallpapers/stonehenge.webp', 1.0, 0.75, 5.55, 3.35, 13.94, Math.PI)
  frameArt('/os/wallpapers/azul.webp', 1.0, 0.75, 6.9, 3.35, 13.94, Math.PI)
  frameArt('/os/wallpapers/bliss.webp', 2.2, 1.4, -5.7, 4.5, 10.44, Math.PI)

  /* ----------------------------------------------------------- furnish -- */

  interface Placement {
    box: THREE.Box3
  }
  const put = (
    gltf: ModelLike | undefined,
    s: number | [number, number, number],
    rotY: number,
    cx: number,
    cz: number,
    o: { pad?: number; y?: number; lift?: number; clone?: boolean } = {},
  ): Placement | null => {
    if (!gltf) return null
    const g = o.clone === false ? gltf.scene : gltf.scene.clone(true)
    if (Array.isArray(s)) g.scale.set(s[0], s[1], s[2])
    else g.scale.setScalar(s)
    g.rotation.y = rotY
    g.updateMatrixWorld(true)
    tmpBox.setFromObject(g)
    const c = tmpBox.getCenter(new THREE.Vector3())
    const y = o.y !== undefined ? o.y - tmpBox.min.y : -tmpBox.min.y + (o.lift ?? 0)
    g.position.set(g.position.x + cx - c.x, g.position.y + y, g.position.z + cz - c.z)
    g.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = false
      }
    })
    root.add(g)
    g.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(g)
    if (o.pad !== undefined) obstacles.push(box.clone().expandByScalar(o.pad))
    return { box }
  }

  /** clone every mesh of a GLB into instanced meshes at the given transforms */
  const instancedFromGLB = (gltf: ModelLike, placements: THREE.Matrix4[]) => {
    const src = gltf.scene
    src.updateMatrixWorld(true)
    src.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length)
      const m = new THREE.Matrix4()
      placements.forEach((p, i) => im.setMatrixAt(i, m.multiplyMatrices(p, mesh.matrixWorld)))
      im.castShadow = false
      im.receiveShadow = false
      root.add(im)
    })
  }

  let furnished = false

  const furnish = (models: HouseModels) => {
    if (furnished) return
    furnished = true
    const HPI = Math.PI / 2

    /* bedroom */
    // headboard to the hall wall, pillows beside the nightstand
    put(models.bed, 1.15, Math.PI, -5.72, 8.03, { pad: 0.12 })
    const nstand = put(models.nightstand, 1.63, Math.PI, -3.2, 9.62, { pad: 0.08 })
    if (nstand) {
      put(models.alarmclock, 2.3, Math.PI - 0.3, -3.32, 9.58, { y: nstand.box.max.y })
    }
    put(models.dresser, 1.08, -HPI, 6.86, 2.0, { pad: 0.1 })
    put(models.closet, 1.49, -HPI, 6.83, 9.3, { pad: 0.1 })
    put(models.curtains, 0.82, HPI, -7.38, 5.75, { y: 0.86 })
    put(models.officechair, 2.05, Math.PI - 0.03, -0.15, 3.05, { pad: 0.16 })

    /* bath: tub along the west wall, sink by the door, toilet on the far
       wall — respaced when the room grew, so nothing crowds anything */
    put(models.bathtub, 4.1, HPI, -6.35, 13.55, { pad: 0.08 })
    // both back up against their walls: bowl and basin open into the room
    put(models.toilet, 0.94, Math.PI, -4.05, 15.72, { pad: 0.08 })
    put(models.bathsink, 1.35, 0, -4.55, 11.14, { pad: 0.08 })
    put(models.towelrack, 1.8, -HPI, -2.62, 14.9, { y: 2.05 })
    put(models.toiletpaper, 1.4, -HPI, -2.6, 15.6, { y: 1.45 })

    /* hall */
    put(models.rug, [0.8, 1, 2.0], HPI, 2.2, 12.25, { y: 0.012 })
    const console_ = put(models.nightstand, 1.63, -HPI, 7.02, 12.3, { pad: 0.08 })
    if (console_ && models.plant) {
      put(models.plant, 0.62, 0.8, 7.02, 12.3, { y: console_.box.max.y })
    }

    /* living room */
    const cab = put(models.tvcabinet, 4.4, Math.PI, 5.75, 14.75, { pad: 0.1 })
    const tv = put(models.tv, 4.4, Math.PI, 5.7, 14.78, { y: cab ? cab.box.max.y : 1.37 })
    if (tv) {
      // little standby LED so the dead tube feels plugged in
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, 0.02),
        new THREE.MeshStandardMaterial({
          color: '#3a0d0d', emissive: '#ff3b30', emissiveIntensity: 1.6,
        }),
      )
      trackDisposable(led.material as THREE.Material)
      led.position.set(tv.box.max.x - 0.28, tv.box.min.y + 0.34, tv.box.max.z - 0.04)
      root.add(led)
    }
    put(models.roundrug, 1.6, 0, 4.9, 17.5, { y: 0.008 })
    put(models.sofa, 1.3, Math.PI, 4.6, 19.7, { pad: 0.14 })
    // reading corner under the yard window, angled at the television
    put(models.loveseat, 0.95, -HPI + 0.3, 5.0, 22.9, { pad: 0.12 })
    const ctable = put(models.coffeetable, 4.4, 0, 4.9, 17.15, { pad: 0.08 })
    put(models.bookcase, 1.31, -HPI, 7.12, 23.1, { pad: 0.1 })
    put(models.floorlamp, 4.4, 0, 7.05, 21.2, { pad: 0.08 })
    put(models.plant, 1.35, 2.6, -1.7, 15.0, { pad: 0.1 })

    /* dining: chairs tucked in facing the table, not fleeing it */
    put(models.diningtable, 3.6, 0, -2.1, 19.8, { pad: 0.1 })
    put(models.chair, 1.25, Math.PI, -2.9, 21.15, { pad: 0.05 })
    put(models.chair, 1.25, Math.PI + 0.12, -1.25, 21.15, { pad: 0.05 })
    put(models.chair, 1.25, 0.2, -2.05, 18.45, { pad: 0.05 })

    /* kitchen run along the west wall, fronts facing +x */
    put(models.kfridge, 4.4, -HPI, -6.55, 17.45, { pad: 0.08 })
    put(models.kstove, 4.4, -HPI, -6.5, 19.6, { pad: 0.08 })
    put(models.ksink, 4.4, -HPI, -6.5, 21.6, { pad: 0.08 })
    const kdrawer = put(models.kdrawer, 4.4, -HPI, -6.5, 23.55, { pad: 0.08 })
    // one upper over the stove, a low one over the drawer stack; the stretch
    // of wall over the sink stays clear for its window
    put(models.kupper, 4.4, -HPI, -7.02, 19.6, { y: 3.35 })
    put(models.kupperl, 4.4, -HPI, -7.05, 23.55, { y: 3.55 })
    if (kdrawer) {
      put(models.toaster, 4.4, -HPI + 0.2, -6.42, 23.3, { y: kdrawer.box.max.y })
    }
    const washer = put(models.washer, 4.4, 0, -1.5, 23.6, { pad: 0.08 })
    if (washer) {
      put(models.microwave, 4.4, 0, -1.5, 23.62, { y: washer.box.max.y })
    }
    if (ctable) {
      put(models.mug, 0.85, 1.2, 5.35, 16.95, { y: ctable.box.max.y })
    }

    /* ceiling domes (hall, bath, kitchen) */
    const dome = (x: number, z: number, s: number, warm: boolean) => {
      if (!models.ceilinglight) return
      const fixture = models.ceilinglight.scene.clone(true)
      fixture.scale.setScalar(s)
      fixture.position.set(x, CEIL_H, z)
      fixture.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mats.forEach((m, i) => {
          const std = m as THREE.MeshStandardMaterial
          if (std.name === 'Light') {
            const own = std.clone()
            own.emissive = new THREE.Color(warm ? '#ffe0b0' : '#dfe9ff')
            own.emissiveIntensity = 0
            trackDisposable(own)
            if (Array.isArray(mesh.material)) mesh.material[i] = own
            else mesh.material = own
            bulbs.push({ mat: own, on: 2.6 })
          }
        })
      })
      root.add(fixture)
    }
    dome(2.3, 12.25, 0.95, true)
    dome(-5.0, 13.55, 0.9, false)
    dome(-6.3, 20.5, 0.9, true)

    /* yard */
    if (models.fence) {
      models.fence.scene.updateMatrixWorld(true)
      tmpBox.setFromObject(models.fence.scene)
      const modLen = tmpBox.max.x - tmpBox.min.x
      const H = 1.9
      const mats: THREE.Matrix4[] = []
      const run = (x0: number, z0: number, x1: number, z1: number) => {
        const len = Math.hypot(x1 - x0, z1 - z0)
        const n = Math.max(1, Math.round(len / (modLen * H)))
        const seg = len / n
        const ang = Math.atan2(z1 - z0, x1 - x0)
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -ang, 0))
          mats.push(new THREE.Matrix4().compose(
            new THREE.Vector3(x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t),
            q,
            new THREE.Vector3((seg / modLen) * 1.0, H, H),
          ))
        }
      }
      run(YARD.minX, YARD.minZ, YARD.minX, YARD.maxZ)
      run(YARD.maxX, YARD.minZ, YARD.maxX, YARD.maxZ)
      run(YARD.minX, YARD.maxZ, YARD.maxX, YARD.maxZ)
      run(YARD.minX, HOUSE.maxZ, HOUSE.minX - 0.1, HOUSE.maxZ)
      run(HOUSE.maxX + 0.1, HOUSE.maxZ, YARD.maxX, HOUSE.maxZ)
      // front line parts at the gate
      run(YARD.minX, YARD.minZ, GATE.x0, YARD.minZ)
      run(GATE.x1, YARD.minZ, YARD.maxX, YARD.minZ)
      instancedFromGLB(models.fence, mats)
    }
    put(models.tree, 4.6, 0, -7.5, 33.0, { pad: -0.8 })
    put(models.tree, 3.1, 2.1, 10.8, 30.0, { pad: -0.55 })
    put(models.tree, 3.4, 0.8, -11.4, 6.5)
    put(models.bush, 1.35, 0.5, -11.8, 27.5)
    put(models.bush, 1.35, 2.2, 11.5, 36.5)
    put(models.bush, 1.35, 1.1, -11.0, 10.8)
    put(models.bushflower, 1.4, 0, 6.9, 33.6)
    put(models.bushflower, 1.4, 1.9, -10.9, 36.8)
    put(models.hedge, 1.0, 0, -6.5, 25.6, { pad: 0.06 })
    put(models.hedge, 1.0, 0, -0.55, 25.6, { pad: 0.06 })
    put(models.bench, 1.05, Math.PI * 1.5, 4.8, 34.6, { pad: 0.12 })
    const lanternGlow = (x: number, z: number, rotY: number, lit: boolean) => {
      const placed = put(models.lantern, 1.0, rotY, x, z, { pad: 0.05 })
      if (!placed) return
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 6),
        new THREE.MeshStandardMaterial({
          color: '#2c1c08', emissive: '#ffc069', emissiveIntensity: 0,
        }),
      )
      trackDisposable(bulb.material as THREE.Material)
      bulbs.push({ mat: bulb.material as THREE.MeshStandardMaterial, on: lit ? 3.4 : 2.2 })
      // the cage hangs from the arm, which points toward +z at rot 0
      const arm = new THREE.Vector3(0, 2.62, 1.05).applyEuler(new THREE.Euler(0, rotY, 0))
      bulb.position.set(x + arm.x, arm.y, z + arm.z)
      root.add(bulb)
    }
    lanternGlow(-0.95, 25.75, -Math.PI / 2, true) // arm reaches over the porch
    lanternGlow(6.6, 35.6, Math.PI + 0.6, false)

    // freeze everything that just landed; door pivots stay live
    root.updateMatrixWorld(true)
    root.traverse((o) => {
      o.matrixAutoUpdate = false
    })
    doors.forEach((d) => {
      d.pivot.matrixAutoUpdate = true
    })
  }

  /* ------------------------------------------------------------ runtime -- */

  // architecture is static from birth: freeze it, keep the pivots live
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    o.matrixAutoUpdate = false
  })
  doors.forEach((d) => {
    d.pivot.matrixAutoUpdate = true
  })

  const update = (dt: number) => {
    // doors ease toward wherever the interact key last put them
    for (const d of doors) {
      const next = d.angle + (d.target - d.angle) * (1 - Math.exp(-5.5 * dt))
      if (Math.abs(next - d.angle) > 0.00012) {
        d.angle = next
        d.pivot.rotation.y = (d.pivot.userData.baseRotY as number) + next
      }
      // the doorway stays solid until the leaf is well out of the way
      const solid = Math.abs(d.angle) < d.swing * 0.45
      if (solid !== d.solid) {
        d.solid = solid
        if (solid) d.block.set(d.closedMin, d.closedMax)
        else {
          d.block.min.set(0, 0, 0)
          d.block.max.set(0, 0, 0)
        }
      }
    }
    // fireflies
    flyT += dt
    for (let i = 0; i < flies.count; i++) {
      const b = flyBase[i]
      flyM.compose(
        tmpVec.set(
          b.x + Math.sin(flyT * b.s + b.p0) * b.r,
          b.y + Math.sin(flyT * b.s * 1.7 + b.p1) * 0.5,
          b.z + Math.cos(flyT * b.s * 0.8 + b.p0) * b.r,
        ),
        flyQ,
        flyS.setScalar(0.7 + 0.3 * Math.sin(flyT * 2.2 + b.p1)),
      )
      flies.setMatrixAt(i, flyM)
    }
    flies.instanceMatrix.needsUpdate = true
  }

  /** the closest door in reach; past arm's length it must be in view too */
  const findDoor = (p: THREE.Vector3, gaze: THREE.Vector3): Door | null => {
    let best: Door | null = null
    let bestD = 6.76 // 2.6 units of reach, squared
    const planarGaze = Math.hypot(gaze.x, gaze.z)
    for (const d of doors) {
      const dx = d.cx - p.x
      const dz = d.cz - p.z
      const dd = dx * dx + dz * dz
      if (dd >= bestD) continue
      if (dd > 1.44 && planarGaze > 0.001) {
        const facing = (gaze.x * dx + gaze.z * dz) / (Math.sqrt(dd) * planarGaze)
        if (facing < 0.35) continue
      }
      bestD = dd
      best = d
    }
    return best
  }

  const doorPrompt = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    const d = findDoor(p, gaze)
    return d ? (d.target === 0 ? ('open' as const) : ('close' as const)) : null
  }

  const useDoor = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    const d = findDoor(p, gaze)
    if (!d) return false
    if (d.target !== 0) {
      d.target = 0
    } else {
      // swing toward the far side of the wall from where the player stands;
      // which rotation sign that is depends on the wall axis and hinge side
      const side = (d.axis === 'z' ? p.z : p.x) < d.at ? 1 : -1
      d.target = (d.axis === 'z' ? -d.dir : d.dir) * side * d.swing
    }
    return true
  }

  const setRoamLight = (k: number) => {
    for (const { light, on } of lights) light.intensity = on * k
    for (const { mat, on } of bulbs) mat.emissiveIntensity = on * k
  }

  // daylight puts the fireflies to bed and washes out the curtain glow
  const setDay = (day: number) => {
    flyMat.opacity = Math.max(0, 1 - day * 1.6)
    const glow = 1.1 * (1 - day * 0.92)
    for (const m of curtainMats) {
      if (m.emissiveIntensity !== glow) m.emissiveIntensity = glow
    }
  }

  const flagShadows = (p: THREE.Vector3) => {
    // only the living-room pendant is house-owned; its wide cone reaches the
    // hall through the arch, so keep re-baking anywhere past the bedroom —
    // stopping early would strand a stale player shadow in the map
    if (p.z > 10.2 && p.z < HOUSE.maxZ + 3) livkPendant.shadow.needsUpdate = true
  }

  return {
    root, update, doorPrompt, useDoor,
    setRoamLight, setDay, flagShadows, shadowLights, furnish,
  }
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
