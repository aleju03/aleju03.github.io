#!/usr/bin/env node
/*
  Photograph the open world without booting the site.

    node scripts/shoot.mjs landmark:*
    node scripts/shoot.mjs biome:wetland --eye
    node scripts/shoot.mjs town:downtown town:suburb --tod 0.78
    node scripts/shoot.mjs 240,320 --pick 400,300

  It starts its own vite on a private port, drives headless Chrome over CDP,
  points scripts/probe/ at whatever you asked for, and writes a PNG. Several
  targets in one call render as one contact sheet, which is the whole reason
  this exists: nine procedural structures are one screenshot rather than nine,
  and one image per iteration is what keeps a visual check from turning into
  an afternoon.

  Two things it is careful about, both learned the hard way.

  It never touches a vite the user is already running. It takes its own port
  and kills only the PID it spawned, because :5173 belongs to whoever started
  it and `pkill vite` has taken somebody's dev server down before.

  And it renders through the game's real materials (world/streamer.ts's
  `makeChunkMats`), not a hand-rolled set. A probe with its own
  MeshStandardMaterials has no leaf alpha test and no surface pass, so every
  tree is a green slab and every wall a grey rectangle, and the resulting
  picture is indistinguishable from a regression that is not there.

  Numbers, as opposed to pictures, are scripts/measure.mjs.
*/
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// vite binds ::1 only on this box, so the dev server is addressed by name
// and chrome's debugger by v4 literal; mixing them up connects to nothing
const PORT = Number(process.env.PROBE_PORT ?? 5178)
const ORIGIN = `http://localhost:${process.env.PROBE_PORT ?? 5178}`
const CDP = Number(process.env.PROBE_CDP ?? 9339)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2)
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log(`
usage: node scripts/shoot.mjs <target...> [options]

targets
  <x>,<z>              a world position, e.g. 240,320
  home                 the authored property
  biome:<id>           nearest plains|forest|taiga|tundra|snow|desert|savanna|
                       jungle|wetland|rock|beach to the house
  town:<district>      nearest downtown|midrise|suburb
  landmark:<kind>      nearest lighthouse|windmill|farm|mast|ruins|watertower|
                       stones|cabin|wreck
  landmark:*           one of every landmark kind, as a contact sheet

options
  --out <path>         default shots/<first-target>.png
  --eye                a walker's eye line (3.55) looking level, instead of
                       the default three-quarter orbit. Use it to judge scale
  --dist <n>           orbit distance          (default 52)
  --height <n>         orbit height            (default 22)
  --yaw <rad>          bearing around the target (default 2.3)
  --tod <0..1>         0 midnight, 0.5 noon, 0.78 dusk (default 0.5)
  --tier <t>           full|flora|bare         (default full)
  --rings <n>          chunk rings per tile    (default 1, a 3x3)
  --tile <WxH>         tile size               (default 900x620)
  --cols <n>           contact-sheet columns   (default 3)
  --pick <x>,<y>       also raycast that pixel of tile 0 and print the hits
  --keep               leave chrome and vite running (for repeated shots)
`)
  process.exit(0)
}

const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

const targets = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
if (!targets.length) {
  console.error('no target given; try --help')
  process.exit(1)
}

const parseTarget = (s) => {
  if (s === 'home') return { kind: 'home' }
  const [head, arg] = s.split(':')
  if (arg !== undefined) return { kind: head, arg }
  const [x, z] = s.split(',').map(Number)
  if (Number.isFinite(x) && Number.isFinite(z)) return { kind: 'at', x, z }
  throw new Error(`cannot parse target "${s}"`)
}

const [tw, th] = String(flag('tile', '900x620')).split('x').map(Number)
const spec = {
  targets: targets.map(parseTarget),
  tile: [tw, th],
  cols: Number(flag('cols', 3)),
  dist: Number(flag('dist', 52)),
  height: Number(flag('height', 22)),
  eye: has('eye'),
  yaw: Number(flag('yaw', 2.3)),
  tod: Number(flag('tod', 0.5)),
  rings: Number(flag('rings', 1)),
  tier: String(flag('tier', 'full')),
}
const outPath = resolve(
  flag('out', `shots/${targets[0].replace(/[^a-z0-9]+/gi, '-')}.png`),
)

/* ----------------------------------------------------------------- vite */

// our own port, and we kill only what we spawned: :5173 belongs to whoever
// started it, and `pkill vite` has taken a real dev server down before
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
  detached: false,
})
let chrome = null
const shutdown = () => {
  if (has('keep')) return
  chrome?.kill()
  vite.kill()
}
process.on('exit', shutdown)
process.on('SIGINT', () => { shutdown(); process.exit(130) })

const waitFor = async (fn, tries, gap, what) => {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* not up yet */ }
    await sleep(gap)
  }
  throw new Error(`timed out waiting for ${what}`)
}

await waitFor(
  async () => (await fetch(`${ORIGIN}/scripts/probe/index.html`)).ok,
  60, 250, 'vite',
)

/* --------------------------------------------------------------- chrome */

chrome = spawn('google-chrome-stable', [
  '--headless=new',
  `--remote-debugging-port=${CDP}`,
  // the real GPU, not swiftshader: swiftshader renders this at under a frame
  // a second and distorts every ratio you might want to measure
  '--use-angle=gl',
  '--enable-unsafe-swiftshader',
  `--window-size=${tw * spec.cols},${th * 4}`,
  '--no-first-run',
  '--user-data-dir=/tmp/world-probe-chrome',
], { stdio: 'ignore' })

const page = await waitFor(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  return list.find((t) => t.type === 'page')
}, 60, 250, 'chrome')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    // the probe page has no favicon and never will; its 404 is not news
    const e = m.params.entry
    if (!/favicon/.test(`${e.url ?? ''} ${e.text}`)) errors.push(e.text)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    errors.push(d.exception?.description ?? d.text)
  }
}
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id
  pending.set(n, res)
  ws.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval threw')
  }
  return r.result?.result?.value
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url: `${ORIGIN}/scripts/probe/index.html` })
await waitFor(() => evaluate('!!window.__probe?.ready'), 120, 250, 'the probe page')

/* ----------------------------------------------------------------- shoot */

const t0 = Date.now()
const found = await evaluate(`JSON.stringify(window.__probe.shoot(${JSON.stringify(spec)}))`)
const rows = JSON.parse(found)
for (const r of rows) {
  console.log(
    `${String(r.label).padEnd(22)} ${String(r.x).padStart(7)},${String(r.z).padStart(7)}` +
    `  y ${String(r.y).padStart(7)}  ${r.biome.padEnd(8)}` +
    `${r.district ? ' ' + r.district : ''}  ${r.verts} verts`,
  )
}

const cols = Math.min(spec.cols, rows.length)
const rowsN = Math.ceil(rows.length / cols)
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: tw * cols, height: th * rowsN, scale: 1 },
})
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'))
console.log(`\n${outPath}  (${tw * cols}x${th * rowsN}, ${Date.now() - t0} ms)`)

const pixel = flag('pick', null)
if (pixel) {
  const [px, py] = String(pixel).split(',').map(Number)
  const hits = await evaluate(`JSON.stringify(window.__probe.pick(0, ${px}, ${py}))`)
  console.log(`\npick ${px},${py}:`)
  for (const h of JSON.parse(hits)) console.log('  ' + JSON.stringify(h))
}

if (errors.length) {
  console.log('\npage errors:')
  for (const e of errors.slice(0, 6)) console.log('  ' + e)
}

ws.close()
if (has('keep')) {
  console.log(`\nleft running: probe at ${ORIGIN}/scripts/probe/index.html`)
  process.exit(0)
}
process.exit(errors.length ? 1 : 0)
