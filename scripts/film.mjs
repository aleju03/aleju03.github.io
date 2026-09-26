#!/usr/bin/env node
/*
  Film the sandbox's physics without booting the site.

    npm run film -- sandbox:stack
    npm run film -- sandbox:*                     every scenario, one sheet each
    npm run film -- sandbox:roll --video          ...and an MP4 of it
    npm run film -- sandbox:float --gif --frames 16
    npm run film -- --list

  Each scenario (src/game/sandbox/scenarios.ts) is staged in the real world
  through the real sandbox and the game's own chunk materials, simulated at
  the game's fixed 60 Hz, and photographed at `--frames` evenly spaced moments
  into one labelled contact sheet: shots/film/<id>.png. `--video` / `--gif`
  additionally capture every frame at `--fps` and hand them to ffmpeg:
  shots/film/<id>.mp4 / .gif. The scenario's report line (how many crates
  came down, how far the barrels rolled, what floats) is printed beside it, so
  the picture and the numbers arrive together.

  Ports come from PROBE_PORT / PROBE_CDP like scripts/shoot.mjs, and it kills
  only what it spawned (scripts/probe/cdp.mjs). Numbers without pictures are
  `npm run measure -- physics`.
*/
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openProbe } from './probe/cdp.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)
const VALUED = new Set(['frames', 'tile', 'cols', 'fps', 'size', 'tod', 'duration', 'rings', 'out'])
const targets = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') && VALUED.has(argv[i - 1].slice(2))))

if (argv.includes('--help') || argv.includes('-h') || (!targets.length && !has('list'))) {
  console.log(`
usage: npm run film -- <scenario...> [options]

scenarios
  sandbox:stack  sandbox:roll  sandbox:pile  sandbox:float  (--list for all)
  sandbox:*      every registered scenario, one sheet each

options
  --frames <n>     stills on the sheet            (default 12)
  --tile <WxH>     still size                     (default 640x400)
  --cols <n>       sheet columns                  (default 4)
  --video          also write an MP4 of the whole run
  --gif            also write a GIF (smaller, 15 fps unless --fps)
  --fps <n>        video frame rate               (default 30)
  --size <WxH>     video size                     (default 960x600)
  --tod <0..1>     time of day                    (default the scenario's)
  --duration <s>   override the scenario's length
  --rings <n>      chunk rings built around the site (default 2)
  --out <dir>      default shots/film
  --keep           leave chrome and vite running
`)
  process.exit(0)
}

const [tw, th] = String(flag('tile', '640x400')).split('x').map(Number)
const cols = Number(flag('cols', 4))
const frames = Number(flag('frames', 12))
const [vw, vh] = String(flag('size', '960x600')).split('x').map(Number)
const outDir = resolve(flag('out', 'shots/film'))
const gif = has('gif')
const video = has('video') || gif
const fps = Number(flag('fps', gif && !has('video') ? 15 : 30))
const rows = Math.ceil(frames / Math.min(cols, frames))

const probe = await openProbe({
  port: Number(process.env.PROBE_PORT ?? 5178),
  cdp: Number(process.env.PROBE_CDP ?? 9339),
  page: 'scripts/probe/film.html',
  ready: '!!window.__film?.ready',
  width: Math.max(tw * Math.min(cols, frames), vw),
  height: Math.max(th * rows, vh),
  keep: has('keep'),
})

const known = await probe.evaluate('window.__film.list()')
if (has('list')) {
  for (const s of known) console.log(`${s.id.padEnd(22)} ${s.title}`)
  if (!targets.length) {
    probe.close()
    process.exit(0)
  }
}
const ids = targets.flatMap((t) =>
  t.endsWith('*') ? known.filter((s) => s.id.startsWith(t.slice(0, -1))).map((s) => s.id) : [t])

mkdirSync(outDir, { recursive: true })
let failed = false
for (const id of ids) {
  const spec = {
    id,
    frames,
    tile: [tw, th],
    cols,
    rings: Number(flag('rings', 2)),
    raw: argv.includes('--raw'),
    ...(flag('tod', null) !== null ? { tod: Number(flag('tod')) } : {}),
    ...(flag('duration', null) !== null ? { duration: Number(flag('duration')) } : {}),
  }
  const t0 = Date.now()
  let res
  try {
    res = await probe.evaluate(`window.__film.sheet(${JSON.stringify(spec)})`)
  } catch (e) {
    console.log(`${id}: ${e.message}`)
    failed = true
    continue
  }
  const c = Math.min(cols, frames)
  const png = await probe.screenshot(tw * c, th * Math.ceil(frames / c))
  const name = id.replace(/[^a-z0-9]+/gi, '-')
  const sheetPath = join(outDir, `${name}.png`)
  writeFileSync(sheetPath, png)
  console.log(`${id.padEnd(16)} at ${res.x},${res.z}  ${res.report}`)
  console.log(`${''.padEnd(16)} ${res.msPerFrame.toFixed(2)} ms/frame of sandbox tick (median)  ` +
    `${sheetPath}  (${Date.now() - t0} ms)`)

  if (video) {
    const v = await probe.evaluate(
      `window.__film.videoStart(${JSON.stringify(spec)}, ${vw}, ${vh}, ${fps})`)
    const dir = mkdtempSync(join(tmpdir(), 'film-'))
    for (let i = 0; i < v.frames; i++) {
      await probe.evaluate('window.__film.videoFrame()')
      writeFileSync(join(dir, `${String(i).padStart(5, '0')}.png`), await probe.screenshot(vw, vh))
    }
    const outs = []
    if (has('video') || !gif) {
      const mp4 = join(outDir, `${name}.mp4`)
      const r = spawnSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, '%05d.png'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4,
      ], { stdio: 'inherit' })
      if (r.status === 0) outs.push(mp4)
      else failed = true
    }
    if (gif) {
      const out = join(outDir, `${name}.gif`)
      const r = spawnSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, '%05d.png'),
        '-vf', `fps=${fps},scale=${Math.min(vw, 640)}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
        out,
      ], { stdio: 'inherit' })
      if (r.status === 0) outs.push(out)
      else failed = true
    }
    rmSync(dir, { recursive: true, force: true })
    console.log(`${''.padEnd(16)} ${v.frames} frames at ${fps} fps -> ${outs.join(', ')}`)
  }
}

if (probe.errors.length) {
  console.log('\npage errors:')
  for (const e of probe.errors.slice(0, 6)) console.log('  ' + e)
}
probe.close()
process.exit(failed || probe.errors.length ? 1 : 0)
