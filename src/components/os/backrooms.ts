import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { canvasTexture, seeded, HOUSE, NOCLIP } from './houseWorld'

/*
  The backrooms. A span of the living room's east wall renders like wall but
  never got a collision box (houseWorld cuts the hole and dresses it over);
  walk into it and you noclip out of the house into level 0 — mono-yellow
  wallpaper, damp carpet, drop ceiling, fluorescent hum — built far below
  the neighborhood so the two worlds can never catch each other in a frame.

  The level is chunked and deterministic: each 40-unit chunk seeds its own
  RNG from its coordinates, partitions itself into rooms whose every wall
  keeps at least one doorway gap (and every chunk border keeps two or
  three), so the maze wanders forever without ever sealing anyone in. A 3x3
  ring of chunks streams around the player under fog that ends before the
  ring does. Same seed, same maze: the way home — a damp stain on the spawn
  alcove's back wall, twin to the one in the house — stays where it was.

  Everything is synthesized on the spot, in the house style: canvas
  textures, merged-box geometry, WebAudio hum (mains harmonics plus a
  bandpassed sizzle). No entities. No downloads. Just the yellow.
*/

export const BR = {
  /** floor elevation, far enough down that no light or frustum crosses over */
  y: -120,
  /** wall-to-ceiling height: office-low, oppressive under the house's 6 */
  h: 5.2,
  /** where the fall drops you: inside the spawn alcove, facing out (-x) */
  spawn: { x: 20.4, z: 20, yaw: Math.PI / 2 },
  /** the haze the corridors dissolve into, well inside the streamed ring */
  fog: '#3b331f',
  fogNear: 7,
  fogFar: 33,
}

const CELL = 4
const CELLS = 10
const CHUNK = CELL * CELLS
const TH = 0.35
/** world units of wall one wallpaper canvas spans before repeating */
const PAPER_W = 2.4
/** fluorescent panels at full burn */
const LIT = 2.7
/** the house-side seam, center of the doctored wall span */
const ENTRY = { x: HOUSE.maxX, z: (NOCLIP.z0 + NOCLIP.z1) / 2 }
/** the spawn alcove's back wall: looks solid, is the door home */
const EXIT_WALL = { x: 21.4, z0: 18.65, z1: 21.35 }

export interface BackroomsHandles {
  root: THREE.Group
  /** the level's own collision set; CrtScene swaps it in while inside */
  obstacles: THREE.Box3[]
  /** where the return trip stands you back up in the living room */
  exitSpot: { x: number; z: number; yaw: number }
  /** player crossed the house-side seam */
  overEntry: (p: THREE.Vector3) => boolean
  /** player walked into the alcove's stained wall */
  overExit: (p: THREE.Vector3) => boolean
  enter: () => void
  leave: () => void
  /** silence the hum entirely (sitting down, leaving the room) */
  sleep: () => void
  /** every roam frame: streams chunks and drives flicker + hum inside,
      whispers through the seam when the player is near it in the house */
  update: (dt: number, p: THREE.Vector3, inside: boolean) => void
  /** the floor giving out; play at the moment of the cut */
  noclipSound: () => void
}

interface BuildOpts {
  scene: THREE.Scene
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

/* ------------------------------------------------------- canvas textures */

const makePaperTexture = () =>
  canvasTexture(
    [256, 512],
    (ctx, w, h) => {
      const rand = seeded(0xbacc)
      ctx.fillStyle = '#c7ae62'
      ctx.fillRect(0, 0, w, h)
      // the two-tone stripe pairs
      for (let x = 0; x < w; x += 40) {
        ctx.fillStyle = 'rgba(120,96,40,0.28)'
        ctx.fillRect(x, 0, 7, h)
        ctx.fillRect(x + 12, 0, 3, h)
        ctx.fillStyle = 'rgba(255,240,180,0.12)'
        ctx.fillRect(x + 22, 0, 10, h)
      }
      // paper grain: fine vertical streaks, dark and light
      for (let i = 0; i < 340; i++) {
        const x = rand() * w
        const y0 = rand() * h
        ctx.strokeStyle = `rgba(${rand() < 0.5 ? '70,56,26' : '235,215,150'},${
          0.025 + rand() * 0.05
        })`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, y0)
        ctx.lineTo(x + (rand() - 0.5) * 3, y0 + 30 + rand() * 90)
        ctx.stroke()
      }
      // mottling
      for (let i = 0; i < 26; i++) {
        const x = rand() * w
        const y = rand() * h
        const r = 12 + rand() * 42
        const g = ctx.createRadialGradient(x, y, 1, x, y, r)
        g.addColorStop(0, `rgba(96,78,34,${0.03 + rand() * 0.05})`)
        g.addColorStop(1, 'rgba(96,78,34,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
      }
      // damp creeping up from the carpet
      const damp = ctx.createLinearGradient(0, h, 0, h * 0.78)
      damp.addColorStop(0, 'rgba(58,46,20,0.22)')
      damp.addColorStop(1, 'rgba(58,46,20,0)')
      ctx.fillStyle = damp
      ctx.fillRect(0, 0, w, h)
    },
    [1, 1],
  )

const makeCarpetTexture = () =>
  canvasTexture(
    [256, 256],
    (ctx, w, h) => {
      const rand = seeded(0xca93e7)
      ctx.fillStyle = '#7d6a3f'
      ctx.fillRect(0, 0, w, h)
      for (let i = 0; i < 9000; i++) {
        ctx.fillStyle =
          rand() < 0.5
            ? `rgba(48,38,16,${0.1 + rand() * 0.2})`
            : `rgba(178,152,88,${0.06 + rand() * 0.16})`
        ctx.fillRect(rand() * w, rand() * h, 1, 1)
      }
      // matted, trodden patches
      for (let i = 0; i < 12; i++) {
        const x = rand() * w
        const y = rand() * h
        const r = 14 + rand() * 36
        const g = ctx.createRadialGradient(x, y, 2, x, y, r)
        g.addColorStop(0, `rgba(52,42,18,${0.05 + rand() * 0.09})`)
        g.addColorStop(1, 'rgba(52,42,18,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
      }
    },
    [CHUNK / 2.5, CHUNK / 2.5],
  )

const makeCeilTexture = () =>
  canvasTexture(
    [256, 256],
    (ctx, w, h) => {
      const rand = seeded(0xce111)
      ctx.fillStyle = '#d6cfb6'
      ctx.fillRect(0, 0, w, h)
      // acoustic pinholes
      for (let i = 0; i < 1500; i++) {
        ctx.fillStyle = `rgba(96,88,64,${0.08 + rand() * 0.2})`
        ctx.fillRect(rand() * w, rand() * h, 1 + (rand() < 0.12 ? 1 : 0), 1)
      }
      // an old water ring or two
      for (let i = 0; i < 2; i++) {
        const x = rand() * w
        const y = rand() * h
        const r = 20 + rand() * 40
        const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r)
        g.addColorStop(0, 'rgba(150,132,84,0)')
        g.addColorStop(0.82, `rgba(150,132,84,${0.1 + rand() * 0.1})`)
        g.addColorStop(1, 'rgba(150,132,84,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
      }
      // the T-bar grid: one tile per repeat
      ctx.strokeStyle = '#9a9179'
      ctx.lineWidth = 6
      ctx.strokeRect(0, 0, w, h)
      ctx.strokeStyle = 'rgba(70,64,46,0.55)'
      ctx.lineWidth = 2
      ctx.strokeRect(3, 3, w - 6, h - 6)
    },
    [CHUNK / 2, CHUNK / 2],
  )

const makeStainTexture = () =>
  canvasTexture([128, 128], (ctx, w, h) => {
    const rand = seeded(0x57a1)
    ctx.clearRect(0, 0, w, h)
    for (let i = 0; i < 14; i++) {
      const x = w * (0.28 + rand() * 0.44)
      const y = h * (0.35 + rand() * 0.55) // heavier toward the floor
      const r = 8 + rand() * 34
      const g = ctx.createRadialGradient(x, y, 1, x, y, r)
      g.addColorStop(0, `rgba(62,50,24,${0.1 + rand() * 0.14})`)
      g.addColorStop(0.7, `rgba(74,60,30,${0.05 + rand() * 0.08})`)
      g.addColorStop(1, 'rgba(74,60,30,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
  })

/* ------------------------------------------------------------------ audio
   Synthesized like sounds.ts: nothing shipped, nothing copyrighted. The hum
   is the room tone of the whole level — mains harmonics under a bandpassed
   noise sizzle — running through one master gain the update loop eases
   around. It also leaks, very quietly, through the seam in the house. */

let ac: AudioContext | null = null
let humMaster: GainNode | null = null
let sizzle: GainNode | null = null
let humNodes: AudioScheduledSourceNode[] = []
let humLevel = 0
let sizzleLevel = 0.055

const audio = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  try {
    ac ??= new AudioContext()
    if (ac.state === 'suspended') void ac.resume()
    return ac
  } catch {
    return null
  }
}

const ensureHum = () => {
  if (humMaster) return
  const a = audio()
  if (!a) return
  const master = a.createGain()
  master.gain.value = 0
  master.connect(a.destination)
  // the ballast chord: stacked mains harmonics
  const voices: Array<[number, number]> = [
    [60, 0.5],
    [120, 1],
    [180, 0.4],
    [240, 0.28],
    [360, 0.12],
  ]
  let fundamental: GainNode | null = null
  for (const [f, g] of voices) {
    const o = a.createOscillator()
    o.type = 'sine'
    o.frequency.value = f
    const og = a.createGain()
    og.gain.value = g * 0.05
    o.connect(og).connect(master)
    o.start()
    humNodes.push(o)
    if (f === 120) fundamental = og
  }
  // a slow swell on the fundamental so the drone never quite sits still
  if (fundamental) {
    const lfo = a.createOscillator()
    lfo.frequency.value = 0.09
    const lfoG = a.createGain()
    lfoG.gain.value = 0.016
    lfo.connect(lfoG).connect(fundamental.gain)
    lfo.start()
    humNodes.push(lfo)
  }
  // the sizzle: looped noise squeezed through a high bandpass
  const len = a.sampleRate * 2
  const buf = a.createBuffer(1, len, a.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  const noise = a.createBufferSource()
  noise.buffer = buf
  noise.loop = true
  const bp = a.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 2900
  bp.Q.value = 0.8
  sizzle = a.createGain()
  sizzle.gain.value = sizzleLevel
  noise.connect(bp).connect(sizzle).connect(master)
  noise.start()
  humNodes.push(noise)
  humMaster = master
}

const humTo = (v: number) => {
  if (!humMaster) {
    if (v < 0.01) return
    ensureHum()
  }
  const m = humMaster
  if (!m || !ac || Math.abs(v - humLevel) < 0.004) return
  humLevel = v
  m.gain.setTargetAtTime(v, ac.currentTime, 0.4)
}

const setSizzle = (v: number) => {
  const s = sizzle
  if (!s || !ac || Math.abs(v - sizzleLevel) < 0.004) return
  sizzleLevel = v
  s.gain.setTargetAtTime(v, ac.currentTime, 0.045)
}

const stopAudio = () => {
  for (const n of humNodes) {
    try {
      n.stop()
    } catch {
      /* already stopped */
    }
  }
  humNodes = []
  humMaster?.disconnect()
  humMaster = null
  sizzle = null
  humLevel = 0
  sizzleLevel = 0.055
}

const noclipSound = () => {
  const a = audio()
  if (!a) return
  const now = a.currentTime
  // the floor giving out: a fast pitch drop under a burst of torn static
  const o = a.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(300, now)
  o.frequency.exponentialRampToValueAtTime(38, now + 0.6)
  const og = a.createGain()
  og.gain.setValueAtTime(0.0001, now)
  og.gain.exponentialRampToValueAtTime(0.09, now + 0.06)
  og.gain.exponentialRampToValueAtTime(0.0005, now + 0.75)
  o.connect(og).connect(a.destination)
  o.start(now)
  o.stop(now + 0.8)
  const len = Math.floor(a.sampleRate * 0.5)
  const buf = a.createBuffer(1, len, a.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
  const n = a.createBufferSource()
  n.buffer = buf
  const lp = a.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(2600, now)
  lp.frequency.exponentialRampToValueAtTime(160, now + 0.5)
  const ng = a.createGain()
  ng.gain.value = 0.05
  n.connect(lp).connect(ng).connect(a.destination)
  n.start(now)
}

const distantThud = () => {
  const a = audio()
  if (!a || humLevel < 0.1) return
  const now = a.currentTime
  // something far away settles; more felt than heard
  const f0 = 44 + Math.random() * 14
  const o = a.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(f0, now)
  o.frequency.exponentialRampToValueAtTime(f0 * 0.6, now + 1.6)
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.linearRampToValueAtTime(0.045, now + 0.5)
  g.gain.exponentialRampToValueAtTime(0.0004, now + 2.4)
  o.connect(g).connect(a.destination)
  o.start(now)
  o.stop(now + 2.6)
}

/* --------------------------------------------------------- deterministic
   layout: everything below derives from chunk coordinates alone, so any
   chunk rebuilds identical no matter when or from which side you arrive. */

interface Piece {
  x0: number
  z0: number
  x1: number
  z1: number
}

const hash2 = (a: number, b: number, salt: number) => {
  let h = ((a | 0) * 374761393 + (b | 0) * 668265263) ^ salt
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** solid spans of a wall run [a,b) in cells, minus 1+ doorway gaps — every
    wall stays passable, which is what keeps the whole maze connected */
const runWithDoors = (
  rng: () => number,
  a: number,
  b: number,
  doors: number,
): Array<[number, number]> => {
  const cuts: Array<[number, number]> = []
  for (let i = 0; i < doors; i++) {
    const w = 1 + (rng() < 0.3 ? 1 : 0)
    const room = b - a - w
    const at = a + (room > 0 ? Math.floor(rng() * (room + 1)) : 0)
    cuts.push([at, Math.min(b, at + w)])
  }
  cuts.sort((p, q) => p[0] - q[0])
  const spans: Array<[number, number]> = []
  let cur = a
  for (const [c0, c1] of cuts) {
    if (c0 > cur) spans.push([cur, c0])
    cur = Math.max(cur, c1)
  }
  if (cur < b) spans.push([cur, b])
  return spans
}

const chunkLayout = (cx: number, cz: number) => {
  const ox = cx * CHUNK
  const oz = cz * CHUNK
  const rng = seeded(hash2(cx, cz, 0x0b5b))
  const pieces: Piece[] = []
  const wallPiece = (axis: 'x' | 'z', line: number, c0: number, c1: number) => {
    if (c1 - c0 < 1) return
    pieces.push(
      axis === 'x'
        ? { x0: ox + line * CELL, z0: oz + c0 * CELL, x1: ox + line * CELL, z1: oz + c1 * CELL }
        : { x0: ox + c0 * CELL, z0: oz + line * CELL, x1: ox + c1 * CELL, z1: oz + line * CELL },
    )
  }
  // partition into rooms; every wall gets doorways, some become pure air
  // (the big empty halls), some rooms never split (the long sight lines)
  const split = (x0: number, z0: number, x1: number, z1: number, depth: number): void => {
    const w = x1 - x0
    const h = z1 - z0
    if (depth >= 3 || (w <= 3 && h <= 3) || rng() < 0.18) return
    const vert = w === h ? rng() < 0.5 : w > h
    if (vert) {
      const line = x0 + 2 + Math.floor(rng() * (w - 3))
      if (rng() > 0.16)
        for (const [c0, c1] of runWithDoors(rng, z0, z1, 1 + (rng() < 0.55 ? 1 : 0)))
          wallPiece('x', line, c0, c1)
      split(x0, z0, line, z1, depth + 1)
      split(line, z0, x1, z1, depth + 1)
    } else {
      const line = z0 + 2 + Math.floor(rng() * (h - 3))
      if (rng() > 0.16)
        for (const [c0, c1] of runWithDoors(rng, x0, x1, 1 + (rng() < 0.55 ? 1 : 0)))
          wallPiece('z', line, c0, c1)
      split(x0, z0, x1, line, depth + 1)
      split(x0, line, x1, z1, depth + 1)
    }
  }
  split(0, 0, CELLS, CELLS, 0)
  // owned borders: north (z=oz) and west (x=ox); the matching south and
  // east lines belong to the neighbors, so no seam is ever drawn twice
  const north = seeded(hash2(cx, cz, 0x7a11))
  if (north() > 0.35)
    for (const [c0, c1] of runWithDoors(north, 0, CELLS, 2 + (north() < 0.4 ? 1 : 0)))
      wallPiece('z', 0, c0, c1)
  const west = seeded(hash2(cx, cz, 0x3e57))
  if (west() > 0.35)
    for (const [c0, c1] of runWithDoors(west, 0, CELLS, 2 + (west() < 0.4 ? 1 : 0)))
      wallPiece('x', 0, c0, c1)
  // lone pillars in the open
  const pillars: Array<[number, number]> = []
  for (let gx = 0; gx < CELLS; gx++)
    for (let gz = 0; gz < CELLS; gz++)
      if (hash2(cx * CELLS + gx, cz * CELLS + gz, 0x9111) / 0x100000000 < 0.03)
        pillars.push([ox + (gx + 0.5) * CELL, oz + (gz + 0.5) * CELL])
  // the light grid, every third cell each way, with dead and dying spots
  const lit: Array<[number, number]> = []
  const flick: Array<[number, number]> = []
  for (let gx = 0; gx < CELLS; gx++)
    for (let gz = 0; gz < CELLS; gz++) {
      const wgx = cx * CELLS + gx
      const wgz = cz * CELLS + gz
      if (((wgx % 3) + 3) % 3 !== 1 || ((wgz % 3) + 3) % 3 !== 1) continue
      const k = hash2(wgx, wgz, 0xf1a7) / 0x100000000
      const at: [number, number] = [ox + (gx + 0.5) * CELL, oz + (gz + 0.5) * CELL]
      if (k < 0.09) continue // dead fixture: a dark gap in the rhythm
      if (k < 0.15) flick.push(at)
      else lit.push(at)
    }
  // the spawn chunk keeps a clearing for the arrival alcove
  if (cx === 0 && cz === 0) {
    const nearSpawn = (pc: Piece) => {
      const nx = Math.min(Math.max(BR.spawn.x, Math.min(pc.x0, pc.x1)), Math.max(pc.x0, pc.x1))
      const nz = Math.min(Math.max(BR.spawn.z, Math.min(pc.z0, pc.z1)), Math.max(pc.z0, pc.z1))
      return (nx - BR.spawn.x) ** 2 + (nz - BR.spawn.z) ** 2 < 30
    }
    const keepW = pieces.filter((pc) => !nearSpawn(pc))
    pieces.length = 0
    pieces.push(...keepW)
    const keepP = pillars.filter(
      ([x, z]) => (x - BR.spawn.x) ** 2 + (z - BR.spawn.z) ** 2 >= 30,
    )
    pillars.length = 0
    pillars.push(...keepP)
    // the alcove: two real walls; the back wall that only looks real is
    // built separately (no obstacle) so it can be walked through
    pieces.push({ x0: 19.4, z0: EXIT_WALL.z0, x1: 21.5, z1: EXIT_WALL.z0 })
    pieces.push({ x0: 19.4, z0: EXIT_WALL.z1, x1: 21.5, z1: EXIT_WALL.z1 })
  }
  return { pieces, pillars, lit, flick }
}

/* ------------------------------------------------------------- geometry */

/** a wall box with UVs in world units, so the paper never smears: long
    faces scale by length, end reveals by thickness, caps pinch to a texel */
const wallGeo = (len: number, depth: number) => {
  const g = new THREE.BoxGeometry(len, BR.h, depth)
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4) // px nx py ny pz nz, 4 verts each
    if (face === 4 || face === 5) uv.setX(i, (uv.getX(i) * len) / PAPER_W)
    else if (face === 0 || face === 1) uv.setX(i, (uv.getX(i) * depth) / PAPER_W)
    else uv.setXY(i, 0.02, 0.02)
  }
  return g
}

interface Chunk {
  group: THREE.Group
  geos: THREE.BufferGeometry[]
  boxes: THREE.Box3[]
  flick: Array<[number, number]>
}

/* ---------------------------------------------------------------- build */

export function buildBackrooms(opts: BuildOpts): BackroomsHandles {
  const { scene, trackTexture, trackDisposable } = opts
  const track = (t: THREE.Texture) => {
    trackTexture(t)
    trackDisposable(t)
    return t
  }

  const root = new THREE.Group()
  root.visible = false
  scene.add(root)

  // level 0 is lit like a spreadsheet: flat, even, shadowless
  root.add(new THREE.HemisphereLight('#ffedbc', '#96814f', 1.3))
  root.add(new THREE.AmbientLight('#cdb87f', 0.4))

  const paperTex = track(makePaperTexture())
  const carpetTex = track(makeCarpetTexture())
  const ceilTex = track(makeCeilTexture())
  const stainTex = track(makeStainTexture())

  const paperMat = new THREE.MeshStandardMaterial({ map: paperTex, roughness: 0.92 })
  const carpetMat = new THREE.MeshStandardMaterial({ map: carpetTex, roughness: 1 })
  const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.95 })
  const panelMat = new THREE.MeshStandardMaterial({
    color: '#cfc9b4',
    emissive: new THREE.Color('#fff1c4'),
    emissiveIntensity: LIT,
    roughness: 0.4,
  })
  const flickMat = panelMat.clone()
  const stainMat = new THREE.MeshStandardMaterial({
    map: stainTex,
    transparent: true,
    opacity: 0.75,
    roughness: 1,
    depthWrite: false,
  })
  const stainOutMat = stainMat.clone()
  stainOutMat.opacity = 1
  ;[paperMat, carpetMat, ceilMat, panelMat, flickMat, stainMat, stainOutMat].forEach((m) =>
    trackDisposable(m),
  )
  trackDisposable({ dispose: stopAudio })

  const floorGeo = new THREE.PlaneGeometry(CHUNK, CHUNK)
  const panelGeo = new THREE.BoxGeometry(1.2, 0.08, 2.4)
  const pillarGeo = wallGeo(1.15, 1.15)
  ;[floorGeo, panelGeo, pillarGeo].forEach((g) => trackDisposable(g))

  // the house-side tell: a damp stain on the doctored span (the paint and
  // baseboard disguise are houseWorld's), and — below — the hum leaking
  // through it whenever the walk passes close
  const houseStain = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.6), stainMat)
  trackDisposable(houseStain.geometry)
  houseStain.position.set(ENTRY.x + 0.002, 1.05, ENTRY.z)
  houseStain.rotation.y = -Math.PI / 2
  scene.add(houseStain)

  const obstacles: THREE.Box3[] = []
  const chunks = new Map<string, Chunk>()

  const buildChunk = (cx: number, cz: number): Chunk => {
    const { pieces, pillars, lit, flick } = chunkLayout(cx, cz)
    const group = new THREE.Group()
    const geos: THREE.BufferGeometry[] = []
    const boxes: THREE.Box3[] = []
    const midX = cx * CHUNK + CHUNK / 2
    const midZ = cz * CHUNK + CHUNK / 2

    const floor = new THREE.Mesh(floorGeo, carpetMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.set(midX, BR.y, midZ)
    group.add(floor)
    const ceil = new THREE.Mesh(floorGeo, ceilMat)
    ceil.rotation.x = Math.PI / 2
    ceil.position.set(midX, BR.y + BR.h, midZ)
    group.add(ceil)

    const wallParts: THREE.BufferGeometry[] = []
    for (const pc of pieces) {
      const alongX = pc.z0 === pc.z1
      const len = (alongX ? pc.x1 - pc.x0 : pc.z1 - pc.z0) + TH
      const g = wallGeo(len, TH)
      if (!alongX) g.rotateY(Math.PI / 2)
      g.translate((pc.x0 + pc.x1) / 2, BR.y + BR.h / 2, (pc.z0 + pc.z1) / 2)
      wallParts.push(g)
      boxes.push(
        alongX
          ? new THREE.Box3(
              new THREE.Vector3(pc.x0 - 0.18, BR.y, pc.z0 - 0.4),
              new THREE.Vector3(pc.x1 + 0.18, BR.y + BR.h, pc.z0 + 0.4),
            )
          : new THREE.Box3(
              new THREE.Vector3(pc.x0 - 0.4, BR.y, pc.z0 - 0.18),
              new THREE.Vector3(pc.x0 + 0.4, BR.y + BR.h, pc.z1 + 0.18),
            ),
      )
    }
    for (const [px, pz] of pillars) {
      wallParts.push(pillarGeo.clone().translate(px, BR.y + BR.h / 2, pz))
      boxes.push(
        new THREE.Box3(
          new THREE.Vector3(px - 0.75, BR.y, pz - 0.75),
          new THREE.Vector3(px + 0.75, BR.y + BR.h, pz + 0.75),
        ),
      )
    }
    if (wallParts.length) {
      const merged = mergeGeometries(wallParts)
      wallParts.forEach((g) => g.dispose())
      if (merged) {
        geos.push(merged)
        group.add(new THREE.Mesh(merged, paperMat))
      }
    }

    const mergePanels = (at: Array<[number, number]>) => {
      if (!at.length) return null
      const parts = at.map(([x, z]) => panelGeo.clone().translate(x, BR.y + BR.h - 0.05, z))
      const merged = mergeGeometries(parts)
      parts.forEach((g) => g.dispose())
      return merged
    }
    const litGeo = mergePanels(lit)
    if (litGeo) {
      geos.push(litGeo)
      group.add(new THREE.Mesh(litGeo, panelMat))
    }
    const flickGeo = mergePanels(flick)
    if (flickGeo) {
      geos.push(flickGeo)
      group.add(new THREE.Mesh(flickGeo, flickMat))
    }

    if (cx === 0 && cz === 0) {
      // the wall you fell out of: dressed like all the others, never solid
      const back = wallGeo(EXIT_WALL.z1 - EXIT_WALL.z0 + TH, TH)
      back.rotateY(Math.PI / 2)
      back.translate(EXIT_WALL.x, BR.y + BR.h / 2, (EXIT_WALL.z0 + EXIT_WALL.z1) / 2)
      geos.push(back)
      group.add(new THREE.Mesh(back, paperMat))
      // ...and the damp stain that marks it as the way home
      const sg = new THREE.PlaneGeometry(1.5, 1.8)
      geos.push(sg)
      const stain = new THREE.Mesh(sg, stainOutMat)
      stain.position.set(EXIT_WALL.x - TH / 2 - 0.012, BR.y + 1.15, (EXIT_WALL.z0 + EXIT_WALL.z1) / 2)
      stain.rotation.y = -Math.PI / 2
      group.add(stain)
    }

    root.add(group)
    group.updateMatrixWorld(true)
    group.traverse((o) => {
      o.matrixAutoUpdate = false
    })
    obstacles.push(...boxes)
    return { group, geos, boxes, flick }
  }

  let ccx = Number.POSITIVE_INFINITY
  let ccz = Number.POSITIVE_INFINITY
  const stream = (px: number, pz: number) => {
    const cx = Math.floor(px / CHUNK)
    const cz = Math.floor(pz / CHUNK)
    if (cx === ccx && cz === ccz) return
    ccx = cx
    ccz = cz
    const want = new Set<string>()
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) want.add(`${cx + dx},${cz + dz}`)
    for (const [key, c] of chunks) {
      if (want.has(key)) continue
      root.remove(c.group)
      for (const g of c.geos) g.dispose()
      for (const b of c.boxes) {
        const i = obstacles.indexOf(b)
        if (i >= 0) obstacles.splice(i, 1)
      }
      chunks.delete(key)
    }
    for (const key of want) {
      if (chunks.has(key)) continue
      const [x, z] = key.split(',').map(Number)
      chunks.set(key, buildChunk(x, z))
    }
  }

  /* --------------------------------------------------------- runtime -- */

  let flickClock = 0
  let burstEnd = -1
  let nextBurst = 4
  let thudIn = 30

  const update = (dt: number, p: THREE.Vector3, inside: boolean) => {
    if (!inside) {
      // the tell: put your ear to the stained wall and the level answers
      const d = Math.hypot(p.x - ENTRY.x, p.z - ENTRY.z)
      const g = Math.max(0, 1 - d / 4.2)
      if (g > 0.02 || humLevel > 0.02) humTo(g * 0.15)
      return
    }
    stream(p.x, p.z)
    humTo(0.8)
    // one shared clock drives every dying fixture; only ever one on screen
    flickClock += dt
    if (flickClock >= nextBurst) {
      burstEnd = flickClock + 0.12 + Math.random() * 0.5
      nextBurst = flickClock + 3.5 + Math.random() * 8
    }
    const inBurst = flickClock < burstEnd
    flickMat.emissiveIntensity = inBurst
      ? Math.sin(flickClock * 83) * Math.sin(flickClock * 47) > -0.2
        ? LIT
        : 0.22
      : LIT
    // the buzz swells only if a dying fixture is actually near the player
    let nearFlick = false
    if (inBurst) {
      outer: for (const c of chunks.values())
        for (const [fx, fz] of c.flick)
          if ((fx - p.x) ** 2 + (fz - p.z) ** 2 < 240) {
            nearFlick = true
            break outer
          }
    }
    setSizzle(inBurst && nearFlick ? 0.17 : 0.055)
    // and every so often, something far away settles
    thudIn -= dt
    if (thudIn <= 0) {
      thudIn = 25 + Math.random() * 45
      distantThud()
    }
  }

  const enter = () => {
    root.visible = true
    stream(BR.spawn.x, BR.spawn.z)
    ensureHum()
    humTo(0.8)
    thudIn = 18 + Math.random() * 25
  }

  const leave = () => {
    root.visible = false
  }

  const sleep = () => {
    humTo(0)
  }

  return {
    root,
    obstacles,
    exitSpot: { x: HOUSE.maxX - 0.75, z: ENTRY.z, yaw: Math.PI / 2 },
    overEntry: (p) =>
      p.x > HOUSE.maxX - 0.22 && p.z > NOCLIP.z0 + 0.08 && p.z < NOCLIP.z1 - 0.08,
    overExit: (p) =>
      p.x > EXIT_WALL.x - 0.4 && Math.abs(p.z - (EXIT_WALL.z0 + EXIT_WALL.z1) / 2) < 1.05,
    enter,
    leave,
    sleep,
    update,
    noclipSound,
  }
}
