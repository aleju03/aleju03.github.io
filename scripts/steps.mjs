#!/usr/bin/env node
/*
  Listen to the footsteps without booting the site.

    npm run steps -- table                 peak/RMS per surface per set, beside the other game sounds
    npm run steps -- demo a b c            a walk per set: 4 s grass, 3 s wood, 3 s concrete, 3 s running on grass
    npm run steps -- demo a --out ~/x      ...somewhere else (default shots/steps), as MP3 and WAV
    npm run steps -- table --raw /tmp/s    also dump every take as raw stereo float32

  Renders offline in headless Chrome through the game's own entry points
  (scripts/probe/steps.ts), at the walk's own cadence: the stride clock in
  walkController.ts advances 0.55 strides per unit, so a 5.9 u/s walk steps
  3.25 times a second and a 9.4 u/s sprint 5.17. Ports come from PROBE_PORT /
  PROBE_CDP like the other harnesses, and it kills only what it spawned.
*/
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openProbe, waitFor } from './probe/cdp.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const words = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
const mode = words[0] ?? 'table'
const sets = words.slice(1).length ? words.slice(1) : ['a', 'b', 'c']
const outDir = resolve(flag('out', 'shots/steps'))
const rawDir = flag('raw', null)
const SR = 44100
const WALK = 5.9 * 0.55
const RUN = 9.4 * 0.55
const SURFACES = ['grass', 'wood', 'carpet', 'stone', 'asphalt', 'sand', 'snow', 'water', 'regolith']

const probe = await openProbe({
  port: Number(process.env.PROBE_PORT ?? 5179),
  cdp: Number(process.env.PROBE_CDP ?? 9341),
  page: 'scripts/probe/steps.html',
  ready: '!!window.__steps?.ready',
  width: 320,
  height: 200,
})

const take = async (seconds, events) => {
  await probe.send('Page.navigate', { url: `${probe.origin}/scripts/probe/steps.html` })
  await waitFor(() => probe.evaluate('!!window.__steps?.ready'), 160, 250, 'the probe page')
  const b64 = await probe.evaluate(`window.__steps.render(${seconds}, ${JSON.stringify(events)})`)
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

const stats = (x, i0 = 0, i1 = x.length / 2) => {
  let peak = 0
  let sum = 0
  for (let i = i0 * 2; i < i1 * 2; i++) {
    peak = Math.max(peak, Math.abs(x[i]))
    sum += x[i] * x[i]
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, (i1 - i0) * 2)) }
}
const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity).toFixed(1).padStart(6)

const wav = (x) => {
  const n = x.length
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(2, 22)
  b.writeUInt32LE(SR, 24)
  b.writeUInt32LE(SR * 4, 28)
  b.writeUInt16LE(4, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2)
  return b
}

try {
  if (mode === 'demo') {
    mkdirSync(outDir, { recursive: true })
    // the take is played at the game's own level, then lifted by a fixed
    // amount so a phone speaker can carry it; the same lift for every set,
    // so the files compare the way the sets do in game
    const lift = Number(flag('lift', 8))
    for (const set of sets) {
      const ev = [{ t: 0, fn: 'set', args: [set] }]
      let t = 0.3
      const walk = (surface, secs, rate, run) => {
        const end = t + secs
        for (; t < end; t += 1 / rate) ev.push({ t, fn: 'step', args: [surface, 1, run] })
      }
      walk('grass', 4, WALK, false)
      walk('wood', 3, WALK, false)
      walk('asphalt', 3, WALK, false)
      walk('grass', 3, RUN, true)
      const x = await take(t + 0.6, ev)
      const s = stats(x)
      const lifted = x.map((v) => v * lift)
      const base = join(outDir, `steps-${set}`)
      writeFileSync(`${base}.wav`, wav(lifted))
      spawnSync('ffmpeg', ['-v', 'quiet', '-y', '-i', `${base}.wav`, '-codec:a', 'libmp3lame', '-b:a', '128k', `${base}.mp3`])
      if (rawDir) writeFileSync(join(rawDir, `demo-${set}.f32`), Buffer.from(x.buffer))
      console.log(`demo ${set}  ${ev.length - 1} steps  peak ${db(s.peak)} dBFS in game, x${lift} in the file  ${base}.mp3`)
    }
  } else {
    if (rawDir) mkdirSync(rawDir, { recursive: true })
    // per set: every surface walked four steps and run two, a second apart
    // per surface, then a landing
    const WIN = 2.4
    for (const set of sets) {
      const ev = [{ t: 0, fn: 'set', args: [set] }]
      SURFACES.forEach((s, k) => {
        const t0 = 0.2 + k * WIN
        for (let i = 0; i < 4; i++) ev.push({ t: t0 + i * 0.31, fn: 'step', args: [s, 1, false] })
        for (let i = 0; i < 2; i++) ev.push({ t: t0 + 1.3 + i * 0.19, fn: 'step', args: [s, 1, true] })
        ev.push({ t: t0 + 1.8, fn: 'land', args: [s, 0.6] })
      })
      const x = await take(0.2 + SURFACES.length * WIN, ev)
      if (rawDir) writeFileSync(join(rawDir, `table-${set}.f32`), Buffer.from(x.buffer))
      for (let k = 0; k < SURFACES.length; k++) {
        const a = Math.round((0.2 + k * WIN) * SR)
        const walk = stats(x, a, a + Math.round(1.25 * SR))
        const run = stats(x, a + Math.round(1.3 * SR), a + Math.round(1.75 * SR))
        const land = stats(x, a + Math.round(1.8 * SR), a + Math.round(2.35 * SR))
        console.log(`set ${set}  ${SURFACES[k].padEnd(9)} walk peak ${db(walk.peak)} rms ${db(walk.rms)}   run peak ${db(run.peak)}   land peak ${db(land.peak)}`)
      }
    }
    const refs = [
      ['door opening', 'doorOpen', []],
      ['door closing', 'doorClose', []],
      ['door latch', 'latch', []],
      ['spawn pop (35 kg)', 'spawnPop', [35]],
      ['prop snap (hard)', 'propSnap', [1]],
      ['car door', 'carDoor', []],
      ['car impact (0.5)', 'carImpact', [0.5]],
      ['car horn', 'horn', []],
      ['car engine idling', 'engine', [1.2]],
    ]
    const WR = 1.6
    const x = await take(refs.length * WR, refs.map(([, fn, args], i) => ({ t: i * WR + 0.05, fn, args })))
    if (rawDir) writeFileSync(join(rawDir, 'refs.f32'), Buffer.from(x.buffer))
    refs.forEach(([what], i) => {
      const a = Math.round(i * WR * SR)
      const s = stats(x, a, a + Math.round(WR * SR))
      console.log(`ref    ${what.padEnd(20)} peak ${db(s.peak)}`)
    })
  }
  if (probe.errors.length) console.log(`page errors:\n  ${probe.errors.join('\n  ')}`)
} finally {
  probe.close()
}
