import * as THREE from 'three'
import { buildChunk, type Chunk } from '../../src/game/world/chunk'
import { makeChunkMats, waveHeightAt } from '../../src/game/world/streamer'
import { chunkX, chunkZ } from '../../src/game/world/grid'
import { SEA_Y } from '../../src/game/world/terrain'
import { tickWind } from '../../src/game/world/wind'
import { makeCollisionSet, type Solid } from '../../src/game/physics/collision'
import { createSandbox, type Sandbox } from '../../src/game/sandbox/sandbox'
import {
  SCENARIOS, advanceScenario, scenarioById, stageScenario, type Scenario, type ScenarioCtx,
} from '../../src/game/sandbox/scenarios'
import { dressLook, lightFor } from './probe'
import type { SkyState } from '../../src/game/levels/sky'
import { createPixelLook, type PixelLook } from '../../src/game/render/pixelLook'

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
  () => import('../../src/game/sandbox/tools/scenarios'),
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
}

export interface FilmResult {
  id: string
  title: string
  x: number
  z: number
  report: string
  /** milliseconds of sandbox tick per simulated frame, median */
  msPerFrame: number
  /** programs linked after the scene's warm-up: a tool whose first use
      links a shader shows up here, and it should be zero */
  links: number
  /** their names */
  linked: string
  frames: number
  /** the shot actually used, so a reframe can start from it */
  from: number[]
  to: number[]
  fov: number
}

let renderer: THREE.WebGLRenderer | null = null
/** programs linked since the last build's warm-up */
let links = 0
/** ...and what they were, by three's SHADER_NAME, so a stray link can be found */
let linked: string[] = []
/** the look's internal lines, for anything sized in pixels */
let lookLines = 540
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
  /** the scenario's render side, if it has one */
  pres: ReturnType<NonNullable<Scenario['present']>> | null
  /** last drawn time, for the render side's dt */
  drawnAt: number
}
let stage: Stage | null = null

export const list = async () => {
  for (const m of SCENARIO_MODULES) await m()
  return SCENARIOS.map((s) => ({ id: s.id, title: s.title }))
}

const teardown = () => {
  if (!stage) return
  stage.sb.dispose()
  for (const c of stage.chunks) for (const g of c.geos) g.dispose()
  stage = null
}

const build = async (spec: FilmSpec, w: number, h: number) => {
  for (const m of SCENARIO_MODULES) await m()
  const s = scenarioById(spec.id)
  if (!s) throw new Error(`no scenario "${spec.id}"; have ${SCENARIOS.map((o) => o.id).join(', ')}`)
  teardown()
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
  const pres = s.present ? s.present(c, scene, cam) : null
  stage = {
    s, c, sb, scene, cam, chunks, ticks: [], duration: spec.duration ?? s.duration, sky, pres, drawnAt: 0,
  }
  // link every program before the first still: an uncompiled material's
  // first draw can land a frame late, which films as props that are not
  // there yet (the game pays the same cost under its boot cover)
  if (renderer) await renderer.compileAsync(scene, cam)
  // the first frame: the ground and solids under the site are built here
  sb.tick({ dt: 0, active: true, focus: { x: c.x, y: c.y, z: c.z } })
  // ...and a render side's staged warm-up is drawn once and put away, the
  // way CrtScene's boot cover does it; links are counted from here on
  if (pres && renderer) {
    draw(renderer, stage)
    pres.warmed?.()
  }
  links = 0
  linked = []
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
  lookLines = lines || h
  // count every link, so a first use that compiles something is visible
  const gl = renderer.getContext()
  const link = gl.linkProgram.bind(gl)
  gl.linkProgram = (p: WebGLProgram) => {
    links++
    link(p)
    // three's SHADER_NAME, or else the uniforms the program declares
    const src = (gl.getAttachedShaders(p) ?? []).map((sh) => gl.getShaderSource(sh) ?? '').join('\n')
    const name = /#define SHADER_NAME ([^\s]+)/.exec(src)?.[1] ??
      [...src.matchAll(/uniform \S+ (u[A-Z]\w*)/g)].map((m) => m[1]).slice(0, 6).join(' ')
    linked.push(name)
  }
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
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setScissorTest(true)
  return renderer
}

const draw = (r: THREE.WebGLRenderer, st: Stage) => {
  if (look && !lookRaw) {
    // dressed per frame: the camera may have moved and the look may be new
    dressLook(look, st.scene, st.sky, st.cam, null)
    look.render(st.scene, st.cam)
  }
  else r.render(st.scene, st.cam)
}

/** the lens at time t */
const aimLens = (st: Stage, t: number) => {
  if (!st.s.lens) return
  const shot = st.s.lens(st.c, t)
  st.cam.position.set(...shot.from)
  st.cam.lookAt(shot.to[0], shot.to[1], shot.to[2])
  if (shot.fov && shot.fov !== st.cam.fov) {
    st.cam.fov = shot.fov
    st.cam.updateProjectionMatrix()
  }
  st.cam.updateMatrixWorld()
}

/** the moving camera and the render side, for a frame drawn at time t. A
    sheet's stills are seconds apart, and the render side is springs (a
    viewmodel's sway, a body's balance, a beam's whip) that a one-second
    step would throw anywhere, so it is walked there in 60 Hz steps with the
    lens moving under it, and only the last one is drawn */
const prep = (st: Stage, t: number) => {
  const from = st.drawnAt
  st.drawnAt = t
  if (st.pres) {
    const h = 1 / 60
    let at = from
    while (t - at > h * 1.5) {
      at += h
      aimLens(st, at)
      st.pres.frame(at, h, lookLines)
    }
    aimLens(st, t)
    st.pres.frame(t, Math.max(0, t - at), lookLines)
  } else aimLens(st, t)
}

const advance = (st: Stage, to: number) => {
  advanceScenario(st.s, st.c, to, (_t, dt, ms) => {
    tickWind(dt)
    st.ticks.push(ms)
  })
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
    prep(st, t)
    draw(r, st)
    label(col * tw + 8, row * th + th - 30, `t = ${t.toFixed(2)} s`)
    if (i === 0) label(col * tw + 8, row * th + 8, `${st.s.id}: ${st.s.title}`, true)
  }
  return {
    id: st.s.id,
    title: st.s.title,
    x: Math.round(st.c.x),
    z: Math.round(st.c.z),
    report: st.s.report ? st.s.report(st.c) : '',
    msPerFrame: median(st.ticks),
    frames: spec.frames,
    links,
    linked: linked.join(', '),
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
  prep(st, t)
  draw(renderer, st)
  labels.innerHTML = ''
  label(8, size.y - 30, `${st.s.id}  t = ${t.toFixed(2)} s`)
  vFrame++
  return true
}

export const videoReport = () =>
  stage ? (stage.s.report ? stage.s.report(stage.c) : '') : ''

/** programs linked since the warm-up of the current film */
export const videoLinks = () => links
