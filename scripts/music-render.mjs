#!/usr/bin/env node
/*
  Render the game's soundtrack to files without booting the site.

    node scripts/music-render.mjs field            # one piece, seed 1
    node scripts/music-render.mjs '*' --seed 4     # all seven
    node scripts/music-render.mjs home --secs 40   # just the first 40 s

  Each piece is arranged by the real composer and played through the real
  mixer (samples, strips, reverb, compressor) into an OfflineAudioContext in
  headless Chrome, then written to shots/music/<mood>-<seed>.mp3 (and .wav),
  with its level printed. The level is the point: a mix is judged at the bus,
  in dBFS, not by reading gains in the source (the portfolio's cue bank once
  measured -22 to -31 dBFS while its source said "quiet").

  Same manners as scripts/shoot.mjs: its own vite port and its own Chrome
  profile, and it kills only what it spawned.
*/
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PORT = Number(process.env.MUSIC_PORT ?? 5181)
const ORIGIN = `http://localhost:${PORT}`
const CDP = Number(process.env.MUSIC_CDP ?? 9341)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MOODS = ['home', 'field', 'town', 'night', 'sea', 'sky', 'orbit']

const argv = process.argv.slice(2)
const flag = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const targets = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
if (!targets.length) {
  console.log('usage: node scripts/music-render.mjs <mood|*...> [--seed n] [--secs s]\n  moods: ' + MOODS.join(' '))
  process.exit(1)
}
const moods = targets.includes('*') ? MOODS : targets
const seed = Number(flag('seed', 1))
const secs = Number(flag('secs', 400))
const outDir = resolve('shots/music')
mkdirSync(outDir, { recursive: true })

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
let chrome = null
const shutdown = () => { chrome?.kill(); vite.kill() }
process.on('exit', shutdown)
process.on('SIGINT', () => { shutdown(); process.exit(130) })

const waitFor = async (fn, tries, gap, what) => {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v } catch { /* not yet */ }
    await sleep(gap)
  }
  throw new Error(`timed out waiting for ${what}`)
}
await waitFor(async () => (await fetch(`${ORIGIN}/scripts/probe/music.html`)).ok, 80, 250, 'vite')

chrome = spawn('google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run',
  `--user-data-dir=/tmp/music-probe-chrome-${CDP}`,
], { stdio: 'ignore' })
const page = await waitFor(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
  return list.find((t) => t.type === 'page')
}, 60, 250, 'chrome')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') console.error(m.params.exceptionDetails.exception?.description)
}
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id
  pending.set(n, res)
  ws.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval threw')
  return r.result?.result?.value
}
await send('Runtime.enable')
await send('Page.navigate', { url: `${ORIGIN}/scripts/probe/music.html` })
await sleep(800)

for (const mood of moods) {
  const t0 = Date.now()
  const info = await evaluate(`(async () => {
    const m = await import('/src/game/music/index.ts')
    const { compose, PIECES } = m
    const buf = await m.renderPiece(${JSON.stringify(mood)}, ${secs}, ${seed})
    const L = buf.getChannelData(0), R = buf.getChannelData(1)
    let peak = 0, sum = 0, loud = 0
    const sec = buf.sampleRate
    for (let s = 0; s < L.length; s += sec) {
      let acc = 0
      const e = Math.min(L.length, s + sec)
      for (let i = s; i < e; i++) {
        const a = Math.abs(L[i]), b = Math.abs(R[i])
        if (a > peak) peak = a
        if (b > peak) peak = b
        acc += L[i] * L[i] + R[i] * R[i]
      }
      sum += acc
      loud = Math.max(loud, Math.sqrt(acc / (2 * (e - s))))
    }
    // 16-bit stereo WAV, kept on the page and pulled in slices
    const n = L.length
    const dv = new DataView(new ArrayBuffer(44 + n * 4))
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt ')
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true)
    dv.setUint32(24, sec, true); dv.setUint32(28, sec * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true)
    w(36, 'data'); dv.setUint32(40, n * 4, true)
    for (let i = 0; i < n; i++) {
      dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true)
      dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true)
    }
    const bytes = new Uint8Array(dv.buffer)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    window.__wav = btoa(bin)
    const db = (x) => (20 * Math.log10(x + 1e-9)).toFixed(1)
    return { secs: (n / sec).toFixed(1), peak: db(peak), rms: db(Math.sqrt(sum / (2 * n))), loudest: db(loud), len: window.__wav.length }
  })()`)
  let b64 = ''
  for (let o = 0; o < info.len; o += 4_000_000) b64 += await evaluate(`window.__wav.slice(${o}, ${o + 4_000_000})`)
  const wav = `${outDir}/${mood}-${seed}.wav`
  writeFileSync(wav, Buffer.from(b64, 'base64'))
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-b:a', '192k', wav.replace(/\.wav$/, '.mp3')])
  console.log(`${mood.padEnd(6)} ${info.secs}s  peak ${info.peak} dBFS  rms ${info.rms}  loudest second ${info.loudest}  (${((Date.now() - t0) / 1000).toFixed(1)}s to render)  -> ${wav.replace(/\.wav$/, '.mp3')}`)
}
process.exit(0)
