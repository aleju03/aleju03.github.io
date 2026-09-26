import * as THREE from 'three'
import { buildChunk, type Chunk } from '../../src/game/world/chunk'
import { makeChunkMats, waveHeightAt } from '../../src/game/world/streamer'
import { chunkX, chunkZ } from '../../src/game/world/grid'
import { SEA_Y, terrainY } from '../../src/game/world/terrain'
import { buildDebris } from '../../src/game/world/debris'
import { tickWind } from '../../src/game/world/wind'
import { makeCollisionSet, type Solid } from '../../src/game/physics/collision'
import { attachDestruction, createSandbox, type Sandbox } from '../../src/game/sandbox/sandbox'
import {
  SCENARIOS, advanceScenario, scenarioById, stageScenario, type Scenario, type ScenarioCtx,
} from '../../src/game/sandbox/scenarios'
import { dressLook, lightFor } from './probe'
import type { SkyState } from '../../src/game/levels/sky'
import { createPixelLook, type PixelLook } from '../../src/game/render/pixelLook'
import { setPropSounds } from '../../src/game/sandbox/impactSounds'
import { blastImpact } from '../../src/game/sandbox/explosion'
import { setBatching } from '../../src/game/sandbox/batch'
import { buildPlayerBody, type PlayerPose, type PlayerRig } from '../../src/game/player/playerBody'
import { randomLook } from '../../src/game/player/look'
import type { RagdollEnv } from '../../src/game/player/ragdoll'

// nobody is listening to a film: every impact would spin up a voice for nothing
setPropSounds(false)

/*
  Physics, filmed. The browser half of `npm run film` (scripts/film.mjs).

  It is the probe's recipe with a clock in it: a fixed neighbourhood of real
  chunks built through the game's own `makeChunkMats` (the rule in probe.ts's
  header applies here twice over, since a prop judged against grey slabs is
  judged against nothing), the probe's pinned light rig, and a live sandbox
  with the scenario staged in it. The sandbox is the real one, `createSandbox`
  with meshes, so what is filmed is exactly what the game runs, frame for
  frame: the same fixed 60 Hz slices, the same interpolation, the same water.

  Two ways out. `sheet` advances the scenario to N evenly spaced moments and
  draws each into its own tile of one canvas, labelled with its time, which is
  the contact sheet a critic reads at a glance. `videoStart`/`videoFrame` draw
  one full-size frame at a time for the node side to capture and hand to
  ffmpeg.

  Scenarios come from src/game/sandbox/scenarios.ts, plus whatever modules
  SCENARIO_MODULES imports for their side effect of registering more (the
  physgun's, destruction's). Adding a file there is how a new builder's
  scenario becomes filmable.
*/

/** modules that register scenarios when imported; one line per new file */
const SCENARIO_MODULES: Array<() => Promise<unknown>> = [
  () => import('../../src/game/sandbox/propScenarios'),
  () => import('../../src/game/sandbox/destructionScenarios'),
]

export interface FilmSpec {
  id: string
  /** stills on the sheet */
  frames: number
  tile: [number, number]
  cols: number
  /** overrides the scenario's own duration / time of day */
  duration?: number
  tod?: number
  /** chunk rings built around the site */
  rings: number
  /** skip the pixel look and draw the renderer's own ACES frame */
  raw?: boolean
  /** first still's time, seconds; the rest spread evenly to the end */
  start?: number
  /** reframe: absolute world points for the lens and its target... */
  from?: [number, number, number]
  to?: [number, number, number]
  /** ...or an orbit around the scenario's own target: bearing (radians,
      0 = +x), distance and height over the target. Any one of the three
      switches to the orbit; the others fall back to the default shot's */
  yaw?: number
  dist?: number
  height?: number
  fov?: number
  /** draw every prop as its own mesh instead of in instanced batches, to
      measure what the batching saves */
  nobatch?: boolean
}

export interface FilmResult {
  id: string
  title: string
  x: number
  z: number
  report: string
  /** milliseconds of sandbox tick per simulated frame, median */
  msPerFrame: number
  frames: number
  /** the shot actually used, so a reframe can start from it */
  from: number[]
  to: number[]
  fov: number
  /** what the last still cost to draw: draw calls, triangles, and the
      milliseconds of one look.render with a finish after it (median of 5) */
  calls: number
  triangles: number
  drawMs: number
}

let renderer: THREE.WebGLRenderer | null = null
/** the game's own post pass, so a film is judged through the real look */
let look: PixelLook | null = null
let lookRaw = false
interface Stage {
  s: Scenario
  c: ScenarioCtx
  sb: Sandbox
  scene: THREE.Scene
  cam: THREE.PerspectiveCamera
  chunks: Chunk[]
  ticks: number[]
  duration: number
  /** the pinned sky, which the look is dressed from every frame */
  sky: SkyState
  /** people standing about, for the blasts to knock over */
  bodies: Body[]
}

interface Body {
  rig: PlayerRig
  env: RagdollEnv
  down: boolean
}

const EYE = 3.84
const pose: PlayerPose = {
  dt: 1 / 60, gait: 0, crouchK: 0, grounded: true, run: false, yaw: 0, pitch: 0,
  vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
}
let stage: Stage | null = null

export const list = async () => {
  for (const m of SCENARIO_MODULES) await m()
  return SCENARIOS.map((s) => ({ id: s.id, title: s.title }))
}

const teardown = () => {
  if (!stage) return
  stage.sb.dispose()
  for (const b of stage.bodies) b.rig.group.removeFromParent()
  for (const c of stage.chunks) for (const g of c.geos) g.dispose()
  stage = null
}

const build = async (spec: FilmSpec, w: number, h: number) => {
  for (const m of SCENARIO_MODULES) await m()
  const s = scenarioById(spec.id)
  if (!s) throw new Error(`no scenario "${spec.id}"; have ${SCENARIOS.map((o) => o.id).join(', ')}`)
  teardown()
  setBatching(!spec.nobatch)
  const scene = new THREE.Scene()
  const mats = makeChunkMats(() => {}, () => {})
  const tod = spec.tod ?? s.tod ?? 0.42
  ;(mats.glass as THREE.MeshBasicMaterial).opacity = tod < 0.22 || tod > 0.78 ? 1 : 0

  // the site first, without a sandbox, so the chunks can be built around it
  const site = s.site()
  const c0 = chunkX(site.x)
  const d0 = chunkZ(site.z)
  const chunks: Chunk[] = []
  const byKey = new Map<string, Chunk>()
  const boxes: Solid[] = []
  for (let dz = -spec.rings; dz <= spec.rings; dz++)
    for (let dx = -spec.rings; dx <= spec.rings; dx++) {
      const ch = buildChunk(c0 + dx, d0 + dz, 'full', mats)
      ch.group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.castShadow = true
          m.receiveShadow = true
        }
      })
      chunks.push(ch)
      byKey.set(`${ch.cx},${ch.cz}`, ch)
      for (const b of ch.boxes) boxes.push(b)
      scene.add(ch.group)
    }
  const sb = createSandbox({
    parent: scene,
    collision: makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, []),
    waterY: () => SEA_Y,
    waveAt: waveHeightAt,
    chunkSolids: (cx, cz) => byKey.get(`${cx},${cz}`)?.boxes ?? null,
    walker: false,
  })
  await sb.whenReady
  // the buildings, as the game has them: the world's ruins over these chunks
  // and destruction attached to the sandbox, so a scenario can knock one down
  const debris = buildDebris({ parent: scene, obstacles: boxes, groundAt: terrainY, trackDisposable: () => {} })
  for (const ch of chunks) debris.arm(ch.smash)
  debris.ruins.onSolids = () => sb.solidsChanged()
  attachDestruction(sb, debris.ruins)
  const c = stageScenario(s, sb)
  const sky = lightFor(scene, tod, new THREE.Vector3(c.x, c.y, c.z))
  const shot = s.camera(c)
  const to = spec.to ?? shot.to
  let from = spec.from ?? shot.from
  if (!spec.from && (spec.yaw !== undefined || spec.dist !== undefined || spec.height !== undefined)) {
    // an orbit around the target, starting from wherever the default stood
    const dx = shot.from[0] - to[0]
    const dz = shot.from[2] - to[2]
    const yaw = spec.yaw ?? Math.atan2(dz, dx)
    const dist = spec.dist ?? Math.hypot(dx, dz)
    const height = spec.height ?? shot.from[1] - to[1]
    from = [to[0] + Math.cos(yaw) * dist, to[1] + height, to[2] + Math.sin(yaw) * dist]
  }
  const fov = spec.fov ?? shot.fov ?? 50
  const cam = new THREE.PerspectiveCamera(fov, w / h, 0.2, 900)
  cam.position.set(...from)
  cam.lookAt(new THREE.Vector3(...to))
  cam.userData.shot = { from: [...from], to: [...to], fov }
  // people: a real rig each, standing where the scenario says, knocked flat
  // by the sandbox's own blasts through the same maths the game uses
  const bodies: Body[] = []
  let lookSeed = 5
  const lookRnd = () => ((lookSeed = (lookSeed * 16807) % 2147483647) / 2147483647)
  for (const b of s.bodies?.(c) ?? []) {
    const rig = buildPlayerBody(EYE, 34, randomLook(lookRnd))
    const gy = sb.groundY(b.x, b.z)
    rig.group.position.set(b.x, gy, b.z)
    rig.face(b.yaw)
    rig.group.rotation.y = rig.facing + Math.PI
    scene.add(rig.group)
    const near = boxes.filter((q) => q.max.x > b.x - 16 && q.min.x < b.x + 16 && q.max.z > b.z - 16 && q.min.z < b.z + 16)
    bodies.push({
      rig,
      down: false,
      env: {
        groundY: gy,
        groundAt: sb.groundY,
        collision: makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, near),
      },
    })
  }
  const impact = { impulse: new THREE.Vector3(), point: new THREE.Vector3() }
  const feet = new THREE.Vector3()
  sb.onExplosion((e) => {
    for (const b of bodies) {
      b.rig.group.getWorldPosition(feet)
      if (b.down) b.rig.focus(feet)
      feet.y = sb.groundY(feet.x, feet.z)
      if (blastImpact(e, feet, EYE * 1.15, b.rig.mass, impact)) {
        b.rig.hit(impact.impulse, impact.point)
        b.down = true
      }
    }
  })
  stage = { s, c, sb, scene, cam, chunks, ticks: [], duration: spec.duration ?? s.duration, sky, bodies }
  // link every program before the first still: an uncompiled material's
  // first draw can land a frame late, which films as props that are not
  // there yet (the game pays the same cost under its boot cover)
  if (renderer) await renderer.compileAsync(scene, cam)
  // the first frame: the ground and solids under the site are built here
  sb.tick({ dt: 0, active: true, focus: { x: c.x, y: c.y, z: c.z } })
  return stage
}

const makeRenderer = (w: number, h: number, raw = false, lines = 0) => {
  const canvas = document.getElementById('c') as HTMLCanvasElement
  canvas.width = w
  canvas.height = h
  look?.dispose()
  look = null
  renderer?.dispose()
  lookRaw = raw
  renderer = new THREE.WebGLRenderer({ canvas, antialias: raw })
  renderer.setPixelRatio(1)
  renderer.setSize(w, h, false)
  if (raw) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
  } else {
    look = createPixelLook(renderer)
    // an exact 2x of whatever one frame is drawn at, as the shoot does
    look.knobs.lines = lines
  }
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setScissorTest(true)
  return renderer
}

const draw = (r: THREE.WebGLRenderer, st: Stage) => {
  if (look && !lookRaw) {
    // dressed per frame: the camera may have moved and the look may be new
    dressLook(look, st.scene, st.sky, st.cam, null)
    flash(st)
    look.render(st.scene, st.cam)
  }
  else r.render(st.scene, st.cam)
}

const advance = (st: Stage, to: number) => {
  advanceScenario(st.s, st.c, to, (_t, dt, ms) => {
    tickWind(dt)
    st.ticks.push(ms)
    pose.dt = dt
    for (const b of st.bodies) {
      if (!b.rig.ragdolling) b.rig.group.rotation.y = b.rig.facing + Math.PI
      b.rig.update(pose, b.env)
    }
  })
}

/** feed the look the blast's flash, as CrtScene does every frame */
const flash = (st: Stage) => {
  if (look) st.sb.fx.lightLook(look.lights)
}

const labels = document.getElementById('labels') as HTMLDivElement

const label = (x: number, y: number, text: string, big = false) => {
  const d = document.createElement('div')
  d.textContent = text
  d.style.cssText =
    `position:absolute;left:${x}px;top:${y}px;font:${big ? 600 : 500} ${big ? 15 : 13}px/1.2 ui-monospace,monospace;` +
    'color:#fff;background:rgba(0,0,0,.55);padding:3px 7px;border-radius:3px;white-space:nowrap'
  labels.appendChild(d)
}

const median = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

/** the scenario as a contact sheet: `frames` stills at even sim-time steps */
export const sheet = async (spec: FilmSpec): Promise<FilmResult> => {
  const [tw, th] = spec.tile
  const cols = Math.min(spec.cols, spec.frames)
  const rows = Math.ceil(spec.frames / cols)
  const r = makeRenderer(tw * cols, th * rows, !!spec.raw, Math.round(th / 2))
  const st = await build(spec, tw, th)
  labels.innerHTML = ''
  const t0 = Math.max(0, Math.min(st.duration, spec.start ?? 0))
  for (let i = 0; i < spec.frames; i++) {
    const t = t0 + ((st.duration - t0) * i) / Math.max(1, spec.frames - 1)
    advance(st, t)
    const col = i % cols
    const row = Math.floor(i / cols)
    r.setViewport(col * tw, (rows - row - 1) * th, tw, th)
    r.setScissor(col * tw, (rows - row - 1) * th, tw, th)
    draw(r, st)
    label(col * tw + 8, row * th + th - 30, `t = ${t.toFixed(2)} s`)
    if (i === 0) label(col * tw + 8, row * th + 8, `${st.s.id}: ${st.s.title}`, true)
  }
  // what the last still cost, drawn again five times with a finish after each
  const gl = r.getContext()
  const times: number[] = []
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now()
    draw(r, st)
    gl.finish()
    times.push(performance.now() - t0)
  }
  r.info.autoReset = false
  r.info.reset()
  const col = (spec.frames - 1) % cols
  const row = Math.floor((spec.frames - 1) / cols)
  r.setViewport(col * tw, (rows - row - 1) * th, tw, th)
  r.setScissor(col * tw, (rows - row - 1) * th, tw, th)
  draw(r, st)
  const calls = r.info.render.calls
  const triangles = r.info.render.triangles
  r.info.autoReset = true
  return {
    calls,
    triangles,
    drawMs: median(times),
    id: st.s.id,
    title: st.s.title,
    x: Math.round(st.c.x),
    z: Math.round(st.c.z),
    report: st.s.report ? st.s.report(st.c) : '',
    msPerFrame: median(st.ticks),
    frames: spec.frames,
    from: st.cam.userData.shot.from.map((n: number) => Math.round(n * 10) / 10),
    to: st.cam.userData.shot.to.map((n: number) => Math.round(n * 10) / 10),
    fov: st.cam.userData.shot.fov,
  }
}

let vFrame = 0
let vFps = 30

/** set up a scenario for frame-by-frame capture at `fps` */
export const videoStart = async (spec: FilmSpec, w: number, h: number, fps: number) => {
  makeRenderer(w, h, !!spec.raw, Math.round(h / 2))
  const st = await build(spec, w, h)
  labels.innerHTML = ''
  vFrame = 0
  vFps = fps
  return { frames: Math.round(st.duration * fps) + 1, id: st.s.id }
}

/** advance to the next video frame and draw it full size */
export const videoFrame = () => {
  const st = stage
  if (!st || !renderer) return false
  const t = vFrame / vFps
  advance(st, t)
  const size = renderer.getSize(new THREE.Vector2())
  renderer.setViewport(0, 0, size.x, size.y)
  renderer.setScissor(0, 0, size.x, size.y)
  draw(renderer, st)
  labels.innerHTML = ''
  label(8, size.y - 30, `${st.s.id}  t = ${t.toFixed(2)} s`)
  vFrame++
  return true
}

export const videoReport = () =>
  stage ? (stage.s.report ? stage.s.report(stage.c) : '') : ''

/* ------------------------------------------------------ the catalogue -- */

/*
  Four views of the catalogue that are not scenarios: a turntable sheet (each
  model standing on the showroom lot, frozen, seen from `angles` bearings),
  the spawn menu's icons as one contact sheet, the impact sounds' levels, and
  the proof that nothing links a shader on a first spawn.
*/

export interface TurntableSpec {
  ids?: string[]
  angles: number
  tile: [number, number]
  cols: number
  tod?: number
}

const kindIds = async () => {
  const { CATALOGUE } = await import('../../src/game/sandbox/catalogue')
  return CATALOGUE.map((e) => e.id)
}

/** each model, frozen on the lot, from `angles` bearings round it */
export const turntable = async (spec: TurntableSpec) => {
  const ids = spec.ids?.length ? spec.ids : await kindIds()
  const [tw, th] = spec.tile
  const cols = spec.cols
  const total = ids.length * spec.angles
  const rows = Math.ceil(total / cols)
  const r = makeRenderer(tw * cols, th * rows, false, Math.round(th / 2))
  const st = await build({ id: 'sandbox:showroom', frames: 1, tile: spec.tile, cols, rings: 1, tod: spec.tod }, tw, th)
  labels.innerHTML = ''
  const { KINDS, shapeExtents } = await import('../../src/game/sandbox/kinds')
  const e = new THREE.Vector3()
  let n = 0
  for (const id of ids) {
    const k = KINDS[id]
    shapeExtents(k.shape, e)
    const y = st.sb.restY(id, st.c.x, st.c.z)
    const pid = st.sb.spawn(id, { x: st.c.x, y, z: st.c.z }, { frozen: true })
    const rad = Math.max(e.length() * 0.92, 0.8)
    for (let a = 0; a < spec.angles; a++) {
      const yaw = (a / spec.angles) * Math.PI * 2 + 0.6
      st.sb.setTransform(pid, { x: st.c.x, y, z: st.c.z }, { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      st.sb.tick({ dt: 1 / 60, active: true, focus: { x: st.c.x, y: st.c.y, z: st.c.z } })
      // fit the bounding ball of the shape to the tile, three-quarters on
      st.cam.fov = 34
      st.cam.aspect = tw / th
      st.cam.updateProjectionMatrix()
      const half = THREE.MathUtils.degToRad(st.cam.fov / 2)
      const fit = Math.min(half, Math.atan(Math.tan(half) * st.cam.aspect))
      const d = (rad / Math.sin(fit)) * 1.2
      const cy = y
      st.cam.position.set(st.c.x - d * 0.66, cy + d * 0.34, st.c.z + d * 0.67)
      st.cam.lookAt(st.c.x, cy, st.c.z)
      const col = n % cols
      const row = Math.floor(n / cols)
      r.setViewport(col * tw, (rows - row - 1) * th, tw, th)
      r.setScissor(col * tw, (rows - row - 1) * th, tw, th)
      draw(r, st)
      if (a === 0) label(col * tw + 6, row * th + 6, id)
      n++
    }
    st.sb.remove(pid)
  }
  return { models: ids.length, tiles: n, width: tw * cols, height: th * rows }
}

/** the spawn menu's icons, as renderThumbnails draws them, on one sheet */
export const thumbs = async (size: number, cols: number) => {
  const { renderThumbnails } = await import('../../src/game/sandbox/thumbnails')
  const { CATALOGUE, CATEGORIES } = await import('../../src/game/sandbox/catalogue')
  const t0 = performance.now()
  const icons = await renderThumbnails(CATALOGUE.map((e) => e.id), size)
  const ms = performance.now() - t0
  const cellH = size + 34
  const rows = Math.ceil(icons.length / cols)
  const sheet = document.createElement('canvas')
  sheet.width = cols * size
  sheet.height = rows * cellH
  sheet.style.cssText = 'position:absolute;left:0;top:0;image-rendering:pixelated'
  const g = sheet.getContext('2d')!
  g.fillStyle = '#d9cfb8'
  g.fillRect(0, 0, sheet.width, sheet.height)
  icons.forEach((ic, i) => {
    const x = (i % cols) * size
    const y = Math.floor(i / cols) * cellH
    g.fillStyle = (Math.floor(i / cols) + i) % 2 ? '#cfc4aa' : '#d9cfb8'
    g.fillRect(x, y, size, cellH)
    g.drawImage(ic.canvas, x, y)
    const e = CATALOGUE.find((c) => c.id === ic.id)!
    const cat = CATEGORIES.find((c) => c.id === e.category)!
    g.fillStyle = '#2a2420'
    g.font = '600 11px ui-monospace, monospace'
    g.fillText(e.name.en, x + 4, y + size + 12, size - 8)
    g.fillStyle = '#6a5a48'
    g.font = '500 10px ui-monospace, monospace'
    g.fillText(`${e.name.es} / ${cat.name.en}`, x + 4, y + size + 26, size - 8)
  })
  document.body.appendChild(sheet)
  return { icons: icons.length, ms: Math.round(ms), width: sheet.width, height: sheet.height }
}

/** peak and RMS of every prop sound, rendered offline, beside a footstep */
export const sounds = async () => {
  const S = await import('../../src/game/sandbox/impactSounds')
  const out: Array<{ what: string; peak: number; rms: number }> = []
  const put = async (what: string, fn: () => void) => {
    const r = await S.measureSound(fn)
    out.push({ what, peak: Math.round(r.peak * 1000) / 1000, rms: Math.round(r.rms * 10000) / 10000 })
  }
  S.setEar(0, 0, 0)
  const surfaces = ['wood', 'metal', 'drum', 'sheet', 'plastic', 'rubber', 'glass', 'melon', 'concrete', 'soft', 'ceramic'] as const
  const masses: Record<string, number> = {
    wood: 35, metal: 90, drum: 28, sheet: 8, plastic: 3, rubber: 10, glass: 0.8, melon: 5, concrete: 16, soft: 18, ceramic: 110,
  }
  for (const s of surfaces) {
    for (const k of [0.15, 0.5, 1]) await put(`${s} hit ${k} (${masses[s]} kg)`, () => S.impactSound(s, k, masses[s], 2, 0, 0))
  }
  for (const s of ['wood', 'glass', 'melon'] as const) await put(`${s} break`, () => S.breakSound(s, 1, 2, 0, 0))
  await put('boom at 4 units', () => S.boom(1, 4, 0, 0))
  await put('boom at 30 units', () => S.boom(1, 30, 0, 0))
  await put('ignite', () => S.igniteSound(2, 0, 0))
  // the reference: core/sfx.ts's footstep, through the same offline render.
  // sfx.ts keeps the first context it is handed, so one reference per load
  const sfx = await import('../../src/game/core/sfx')
  const ref = async (what: string, fn: () => void) => {
    const off = new OfflineAudioContext(2, 44100 * 1, 44100)
    const W = window as unknown as { AudioContext: unknown }
    const prev = W.AudioContext
    W.AudioContext = function () { return off } as unknown
    try {
      fn()
    } finally {
      W.AudioContext = prev
    }
    const buf = await off.startRendering()
    let peak = 0
    let sum = 0
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c)
      for (let i = 0; i < d.length; i++) {
        peak = Math.max(peak, Math.abs(d[i]))
        sum += d[i] * d[i]
      }
    }
    out.push({ what, peak: Math.round(peak * 1000) / 1000, rms: Math.round(Math.sqrt(sum / (buf.length * 2)) * 10000) / 10000 })
  }
  await ref('footstep (grass, walk)', () => sfx.footstep('grass', 1, false))
  return out
}

/**
 * The boot-cost rule, checked: compile the showroom the way the game does
 * under its cover, draw a frame, then spawn one of every kind, break the
 * breakables and set off a barrel, counting linkProgram calls throughout.
 */
export const links = async () => {
  const r = makeRenderer(640, 400, false, 200)
  const gl = r.getContext() as WebGL2RenderingContext
  let n = 0
  const real = gl.linkProgram.bind(gl)
  gl.linkProgram = (p: WebGLProgram) => {
    n++
    real(p)
  }
  const st = await build({ id: 'sandbox:showroom', frames: 1, tile: [640, 400], cols: 1, rings: 1 }, 640, 400)
  // build() ran compileAsync; one real frame (and its shadow pass) as the
  // boot's covered warm-up does
  for (let i = 0; i < 2; i++) {
    st.sb.tick({ dt: 1 / 60, active: true, focus: { x: st.c.x, y: st.c.y, z: st.c.z } })
    draw(r, st)
  }
  const atBoot = n
  n = 0
  type Prog = { name: string; cacheKey: string }
  const progs = () => new Set(((r.info.programs ?? []) as unknown as Prog[]).map((p) => p.cacheKey))
  const before = progs()
  const ids = await kindIds()
  const spawned: number[] = []
  ids.forEach((id, i) => {
    const x = st.c.x + ((i % 7) - 3) * 4
    const z = st.c.z + (Math.floor(i / 7) - 3) * 4
    spawned.push(st.sb.spawn(id, { x, y: st.sb.restY(id, x, z) + 0.5, z }))
  })
  for (let i = 0; i < 20; i++) {
    st.sb.tick({ dt: 1 / 60, active: true, focus: { x: st.c.x, y: st.c.y, z: st.c.z } })
    draw(r, st)
  }
  const afterSpawn = n
  n = 0
  for (const id of spawned) st.sb.shatter(id)
  st.sb.explode({ x: st.c.x, y: st.c.y + 1, z: st.c.z }, 1, 16)
  for (let i = 0; i < 40; i++) {
    st.sb.tick({ dt: 1 / 60, active: true, focus: { x: st.c.x, y: st.c.y, z: st.c.z } })
    draw(r, st)
  }
  const fresh = ((r.info.programs ?? []) as unknown as Prog[])
    .filter((p) => !before.has(p.cacheKey)).map((p) => {
      const twin = ((r.info.programs ?? []) as unknown as Prog[]).find((q) => q.name === p.name && q.cacheKey !== p.cacheKey)
      if (!twin) return `${p.name}: no earlier program of this material`
      const a = twin.cacheKey.split(',')
      const b = p.cacheKey.split(',')
      const diff: string[] = []
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(`#${i} ${a[i]} -> ${b[i]}`)
      return `${p.name}: ${diff.join('  ')}`
    })
  return { atBoot, afterSpawn, afterBreakAndBlast: n, programs: r.info.programs?.length ?? -1, fresh }
}
