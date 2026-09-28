#!/usr/bin/env node
/*
  Listen to the car's engine without booting the site.

    npm run engine -- table                peak/RMS per engine set at idle, cruise and full throttle
    npm run engine -- demo a b c           idle 2 s, a rev to the redline and back over 4 s, a 3 s cruise
                                           and a pull through the gears, per set, as WAV
    npm run engine -- demo a --out ~/x     ...somewhere else (default shots/engine)
    npm run engine -- demo a --lift 4      lift the files by a fixed factor (default 4, the same for every set)
    npm run engine -- demo a --name today  file prefix instead of the set's letter

  Renders offline in headless Chrome through the voice the fleet builds
  (scripts/probe/engine.ts), one `set()` per ~60 Hz frame as the frame loop
  calls it. `rpm` idles at 0.13 because that is the floor car.ts reports
  (revShown = 0.13 + 0.87 * rev), and `load` is the planar speed fraction,
  which is what car.ts hands the voice. Ports come from PROBE_PORT /
  PROBE_CDP like the other harnesses, and it kills only what it spawned.
*/
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
const outDir = resolve(flag('out', 'shots/engine'))
const lift = Number(flag('lift', 4))
const prefix = flag('name', null)
const SR = 44100
const FPS = 60
const IDLE = 0.13

const probe = await openProbe({
  port: Number(process.env.PROBE_PORT ?? 5191),
  cdp: Number(process.env.PROBE_CDP ?? 9361),
  page: 'scripts/probe/engine.html',
  ready: '!!window.__engine?.ready',
  width: 320,
  height: 200,
})

const take = async (set, seconds, frames) => {
  await probe.send('Page.navigate', { url: `${probe.origin}/scripts/probe/engine.html` })
  await waitFor(() => probe.evaluate('!!window.__engine?.ready'), 160, 250, 'the probe page')
  const b64 = await probe.evaluate(`window.__engine.render(${JSON.stringify(set)}, ${seconds}, ${JSON.stringify(frames)})`)
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

/** frames for `secs` seconds of `fn(t) -> [rpm, load, speed, slip]` */
const plan = (secs, fn) => {
  const out = []
  for (let i = 0; i <= Math.round(secs * FPS); i++) {
    const t = i / FPS
    out.push([t, ...fn(t)])
  }
  return out
}

const hold = (rpm, load, speed) => () => [rpm, load, speed, 0]

/** idle to the redline and back, the way a blip on a free-revving engine goes */
const rev = (t) => {
  const k = t < 2 ? Math.sin((t / 2) * Math.PI * 0.5) : Math.cos(((t - 2) / 2) * Math.PI * 0.5)
  const r = IDLE + (1 - IDLE) * k
  return [r, 0.6 * k, 0.5 * k, 0]
}

/** a pull through the gears from a standstill and a lift-off coast, shaped
    like car.ts: the gear changes instantly and the throttle is cut for
    0.17 s, and the shown rev is damped at 22/s */
const pull = () => {
  const TOP = [11, 18, 26, 34, 42]
  let v = 0
  let g = 0
  let cut = 0
  let shown = IDLE
  const out = []
  for (let i = 0; i <= 10 * FPS; i++) {
    const t = i / FPS
    const dt = 1 / FPS
    const gas = t < 7
    if (gas && cut <= 0) v += (g < 2 ? 9 : 14 / (g + 1)) * dt * (1 - v / 42)
    else if (!gas) v = Math.max(0, v - 2.2 * dt)
    let rv = v / TOP[g] + (g === 0 && gas ? 0.22 * (1 - v / TOP[0]) : 0)
    if (gas && rv > 0.96 && g < TOP.length - 1) {
      g++
      cut = 0.17
      rv = v / TOP[g]
    }
    if (!gas && g > 1 && rv < 0.45) {
      g--
      rv = v / TOP[g]
    }
    cut -= dt
    const now = cut > 0 ? rv * 0.86 : rv
    shown += (IDLE + 0.87 * Math.min(1, now) - shown) * (1 - Math.exp(-22 * dt))
    out.push([t, shown, v / 40, v / 40, 0])
  }
  return out
}

const TAKES = {
  idle: [2.3, plan(2, hold(IDLE, 0, 0))],
  rev: [4.2, plan(4, rev)],
  cruise: [3.3, plan(3, hold(0.62, 0.6, 0.6))],
  drive: [10.2, pull()],
}

const stats = (x, t0, t1) => {
  let peak = 0
  let sum = 0
  const i0 = Math.round(t0 * SR)
  const i1 = Math.min(x.length / 2, Math.round(t1 * SR))
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
    for (const set of sets) {
      for (const [name, [secs, frames]] of Object.entries(TAKES)) {
        const x = await take(set, secs, frames)
        const s = stats(x, 0, secs)
        const file = join(outDir, `${prefix ?? set}-${name}.wav`)
        writeFileSync(file, wav(x.map((v) => v * lift)))
        console.log(`${(prefix ?? set).padEnd(6)} ${name.padEnd(7)} peak ${db(s.peak)}  rms ${db(s.rms)} dBFS in game  ${file}`)
      }
    }
  } else {
    // steady states, each read after the 0.25 s fade-in and a settle
    const STATES = [
      ['idle', hold(IDLE, 0, 0)],
      ['cruise', hold(0.62, 0.6, 0.6)],
      ['full', hold(0.95, 1, 1)],
    ]
    for (const set of sets) {
      const row = []
      for (const [name, fn] of STATES) {
        const x = await take(set, 2.5, plan(2.4, fn))
        const s = stats(x, 0.6, 2.4)
        row.push(`${name} peak ${db(s.peak)} rms ${db(s.rms)}`)
      }
      for (const name of ['rev', 'drive']) {
        const [secs, frames] = TAKES[name]
        const x = await take(set, secs, frames)
        row.push(`${name} peak ${db(x.reduce((m, v) => Math.max(m, Math.abs(v)), 0))}`)
      }
      console.log(`set ${set.padEnd(6)} ${row.join('   ')}`)
    }
  }
  if (probe.errors.length) console.log(`page errors:\n  ${probe.errors.join('\n  ')}`)
} finally {
  probe.close()
}
