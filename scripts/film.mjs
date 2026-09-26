#!/usr/bin/env node
/*
  Film the sandbox's physics without booting the site.

    npm run film -- sandbox:stack
    npm run film -- sandbox:*                     every scenario, one sheet each
    npm run film -- sandbox:roll --video          ...and an MP4 of it
    npm run film -- sandbox:float --gif --frames 16
    npm run film -- --list
    npm run film -- props:turntable               every catalogue model, four ways round
    npm run film -- props:thumbs                  the spawn menu's icons on one sheet
    npm run film -- props:sounds                  every prop sound's peak, beside a footstep
    npm run film -- props:links                   shader links on first spawn (must be 0)

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
const VALUED = new Set([
  'frames', 'tile', 'cols', 'fps', 'size', 'tod', 'duration', 'rings', 'out',
  'start', 'from', 'to', 'yaw', 'dist', 'height', 'fov', 'angles', 'icon',
])
const targets = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') && VALUED.has(argv[i - 1].slice(2))))

if (argv.includes('--help') || argv.includes('-h') || (!targets.length && !has('list'))) {
  console.log(`
usage: npm run film -- <scenario...> [options]

scenarios
  sandbox:stack  sandbox:roll  sandbox:pile  sandbox:float  (--list for all)
  sandbox:*      every registered scenario, one sheet each
  props:turntable  props:thumbs  props:sounds  props:links   (the catalogue)

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
  --start <s>      first still's time (e.g. --start 5 --duration 7 --frames 11
                   is 0.2 s apart from 5 to 7)

camera (every run prints the shot it used, so start from that)
  --from x,y,z     put the lens here...
  --to x,y,z       ...looking at this
  --yaw <rad>      or orbit the scenario's target: bearing (0 = +x)
  --dist <n>       distance from the target
  --height <n>     height over the target
  --fov <deg>      lens
  --rings <n>      chunk rings built around the site (default 2)
  --nobatch        draw every prop as its own mesh (to measure the batching)
  --angles <n>     props:turntable bearings per model  (default 4)
  --icon <px>      props:thumbs icon size             (default 96)
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

/* the catalogue's own views (film.ts's turntable, thumbs, sounds, links) */
const propTargets = targets.filter((t) => t.startsWith('props:'))
if (propTargets.length) mkdirSync(outDir, { recursive: true })
for (const t of propTargets) {
  const what = t.slice(6)
  const t0 = Date.now()
  try {
    if (what === 'turntable') {
      const [w, h] = String(flag('tile', '280x220')).split('x').map(Number)
      const c = Number(flag('cols', 8))
      const r = await probe.evaluate(`window.__film.turntable(${JSON.stringify({ angles: Number(flag('angles', 4)), tile: [w, h], cols: c, ...(flag('tod', null) !== null ? { tod: Number(flag('tod')) } : {}) })})`)
      const out = join(outDir, 'props-turntable.png')
      writeFileSync(out, await probe.screenshot(r.width, r.height))
      console.log(`props:turntable  ${r.models} models, ${r.tiles} tiles  ${out}  (${Date.now() - t0} ms)`)
    } else if (what === 'thumbs') {
      const size = Number(flag('icon', 96))
      const r = await probe.evaluate(`window.__film.thumbs(${size}, ${Number(flag('cols', 9))})`)
      const out = join(outDir, 'props-thumbs.png')
      writeFileSync(out, await probe.screenshot(r.width, r.height))
      console.log(`props:thumbs     ${r.icons} icons drawn in ${r.ms} ms  ${out}`)
    } else if (what === 'sounds') {
      const rows = await probe.evaluate('window.__film.sounds()')
      for (const r of rows) console.log(`props:sounds     ${r.what.padEnd(34)} peak ${r.peak.toFixed(3)}  rms ${r.rms.toFixed(4)}`)
    } else if (what === 'links') {
      const r = await probe.evaluate('window.__film.links()')
      console.log(`props:links      linkProgram calls: ${r.atBoot} compiling the scene under the "cover", ` +
        `${r.afterSpawn} spawning all ${''}kinds, ${r.afterBreakAndBlast} breaking them and a blast (${r.programs} programs)`)
      for (const f of r.fresh) console.log(`                 linked late: ${f}`)
    } else {
      console.log(`${t}: unknown (turntable, thumbs, sounds, links)`)
    }
  } catch (e) {
    console.log(`${t}: ${e.message}`)
  }
}

const known = await probe.evaluate('window.__film.list()')
if (has('list')) {
  for (const s of known) console.log(`${s.id.padEnd(22)} ${s.title}`)
  if (!targets.length) {
    probe.close()
    process.exit(0)
  }
}
const ids = targets.filter((t) => !t.startsWith('props:')).flatMap((t) =>
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
    nobatch: argv.includes('--nobatch'),
    ...(flag('tod', null) !== null ? { tod: Number(flag('tod')) } : {}),
    ...(flag('duration', null) !== null ? { duration: Number(flag('duration')) } : {}),
    ...(flag('start', null) !== null ? { start: Number(flag('start')) } : {}),
    ...(flag('from', null) !== null ? { from: String(flag('from')).split(',').map(Number) } : {}),
    ...(flag('to', null) !== null ? { to: String(flag('to')).split(',').map(Number) } : {}),
    ...(flag('yaw', null) !== null ? { yaw: Number(flag('yaw')) } : {}),
    ...(flag('dist', null) !== null ? { dist: Number(flag('dist')) } : {}),
    ...(flag('height', null) !== null ? { height: Number(flag('height')) } : {}),
    ...(flag('fov', null) !== null ? { fov: Number(flag('fov')) } : {}),
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
  console.log(`${''.padEnd(16)} ${res.msPerFrame.toFixed(2)} ms/frame of sandbox tick (median), ` +
    `${res.links} programs linked after warm-up${res.links ? ` (${res.linked})` : ''}  ` +
    `${sheetPath}  (${Date.now() - t0} ms)`)
  console.log(`${''.padEnd(16)} last still: ${res.calls} draw calls, ${res.triangles} triangles, ` +
    `${res.drawMs.toFixed(2)} ms to draw through the look (median of 5, finished)`)
  console.log(`${''.padEnd(16)} shot: --from ${res.from.join(',')} --to ${res.to.join(',')} --fov ${res.fov}`)

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
    const vl = await probe.evaluate('window.__film.videoLinks()')
    console.log(`${''.padEnd(16)} ${v.frames} frames at ${fps} fps, ${vl} programs linked after warm-up -> ${outs.join(', ')}`)
  }
}

if (probe.errors.length) {
  console.log('\npage errors:')
  for (const e of probe.errors.slice(0, 6)) console.log('  ' + e)
}
probe.close()
process.exit(failed || probe.errors.length ? 1 : 0)
