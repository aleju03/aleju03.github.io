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
import { lightFor } from './probe'
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
  // e.g. () => import('../../src/game/sandbox/physgunScenarios'),
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
  look?.setMood(sky.night * (1 - sky.twilight))
  const shot = s.camera(c)
  const cam = new THREE.PerspectiveCamera(shot.fov ?? 50, w / h, 0.2, 900)
  cam.position.set(...shot.from)
  cam.lookAt(new THREE.Vector3(...shot.to))
  stage = { s, c, sb, scene, cam, chunks, ticks: [], duration: spec.duration ?? s.duration }
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
  if (look && !lookRaw) look.render(st.scene, st.cam)
  else r.render(st.scene, st.cam)
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
  for (let i = 0; i < spec.frames; i++) {
    const t = (st.duration * i) / Math.max(1, spec.frames - 1)
    advance(st, t)
    const col = i % cols
    const row = Math.floor(i / cols)
    r.setViewport(col * tw, (rows - row - 1) * th, tw, th)
    r.setScissor(col * tw, (rows - row - 1) * th, tw, th)
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
