#!/usr/bin/env node
/*
  Photograph the sandbox's own interface over the live game.

    npm run drive -- console          the receipt printer, open, mid-completion
    npm run drive -- menu             the catalogue held up with q, a plate ringed
    npm run drive -- noclip           a noclip flight: a first-person strip and a
                                      third-person strip of the float pose
    npm run drive                     all three

  --at x,z | place       where the console and menu shots stand (280,480)
  --fly-at place         where the noclip films start (town:suburb)
  --lang es              the Spanish copy; --out <dir> (shots/sandbox)
  --debug                print pointer-lock changes and key presses, which is
                         how an esc that paused the game got caught

  Unlike `shoot` and `film`, which stage the world in a probe page, this boots
  the real site at /world (everything loaded, already standing) in headless
  Chrome and drives it the way a player would: real key events for t, enter,
  q, v and wasd, real mouse moves over the catalogue. The console is typed
  into through `window.__sandbox.run` (dev only) where the output is the
  point, and through key events where the typing is. Walk yaw and pitch go
  through `window.__sandboxWalk`, since headless Chrome is never granted the
  pointer lock that mouse-look needs.

  Writes shots/sandbox/<what>.png (and noclip-first.png / noclip-third.png as
  labelled strips). Ports come from PROBE_PORT / PROBE_CDP like the other
  harnesses, and it kills only what it spawned (scripts/probe/cdp.mjs).
*/
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openProbe, waitFor } from './probe/cdp.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const VALUED = new Set(['--out', '--at', '--fly-at', '--yaw', '--frames', '--lang'])
const wanted = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]))
const WHAT = wanted.length ? wanted : ['console', 'menu', 'noclip']
const OUT = resolve(flag('out', 'shots/sandbox'))
const W = 1280
const H = 800
const lang = flag('lang', 'en')
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// headless reports a coarse pointer and reduced motion, and either one boots
// the flat bezel instead of the 3D scene (see AlejOS.tsx's `fancy`)
const shim = `(() => {
  const real = window.matchMedia.bind(window)
  window.matchMedia = (q) => {
    const fake = (matches) => ({ matches, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false } })
    if (/hover:\\s*none|pointer:\\s*coarse/.test(q)) return fake(false)
    if (/hover:\\s*hover|pointer:\\s*fine/.test(q)) return fake(true)
    if (/prefers-reduced-motion/.test(q)) return fake(false)
    return real(q)
  }
  try { localStorage.setItem('portfolio-language', ${JSON.stringify(lang)}) } catch {}
})()`

const t0 = Date.now()
const probe = await openProbe({
  port: Number(process.env.PROBE_PORT ?? 5186),
  cdp: Number(process.env.PROBE_CDP ?? 9346),
  page: 'world',
  ready: 'document.readyState === "complete"',
  width: W,
  height: H,
  keep: has('keep'),
  before: async (send) => {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    await send('Page.addScriptToEvaluateOnNewDocument', { source: shim })
  },
})
const { send, evaluate } = probe

const CODES = {
  KeyQ: ['q', 81], KeyV: ['v', 86], KeyW: ['w', 87], KeyT: ['t', 84], KeyZ: ['z', 90],
  KeyC: ['c', 67], Enter: ['Enter', 13], Tab: ['Tab', 9], Space: [' ', 32],
  ShiftLeft: ['Shift', 16], Slash: ['/', 191], Escape: ['Escape', 27], F5: ['F5', 116],
}
const key = (type, code) => {
  const [k, vk] = CODES[code]
  return send('Input.dispatchKeyEvent', {
    type, code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    ...(type === 'keyDown' && k.length === 1 ? { text: k } : {}),
  })
}
const down = (code) => key('keyDown', code)
const up = (code) => key('keyUp', code)
// frame-edge detection needs the key held across at least one frame
const tap = async (code, ms = 120) => {
  await down(code)
  await sleep(ms)
  await up(code)
}
const type = async (text) => {
  for (const ch of text) {
    await send('Input.insertText', { text: ch })
    await sleep(35)
  }
}
const shot = async (name) => {
  const png = await probe.screenshot(W, H)
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, png)
  console.log(`  wrote ${path}`)
  return png
}

try {
  console.log('booting /world ...')
  await waitFor(
    () => evaluate(`!!window.__sandbox?.run && !!window.__sandboxWalk &&
      /wasd/.test(document.body.innerText)`),
    360, 500, 'the walk and the sandbox',
  )
  await evaluate('window.__sandbox.whenReady')
  if (has('debug')) {
    await evaluate(`window.__log = []; const L = (m) => window.__log.push(m + ' ' + (performance.now() | 0));
      document.addEventListener('pointerlockchange', () => L('lock ' + !!document.pointerLockElement));
      document.addEventListener('pointerlockerror', () => L('lockerror'));
      window.addEventListener('keydown', (e) => L('down ' + e.code), true); true`)
  }
  console.log(`  standing after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  // let the first rings stream in and the stand-up settle
  await sleep(4000)
  const run = (line) => evaluate(`window.__sandbox.run(${JSON.stringify(line)})`)
  const look = (yaw, pitch) =>
    evaluate(`(() => { const w = window.__sandboxWalk; ${yaw === null ? '' : `w.yaw = ${yaw};`} w.pitch = ${pitch} })()`)

  // first person, somewhere open: the harness's own countryside, or --at
  await evaluate('window.__sandbox.console.host.thirdPerson(false)')
  const AT = flag('at', '280 480').replace(',', ' ')
  console.log(`  ${(await run(`tp ${AT}`)).join(' / ')}`)
  await sleep(3500)
  await run('time 10:30')
  await look(Number(flag('yaw', 0.6)), 0)

  if (WHAT.includes('console')) {
    console.log('console')
    await look(null, -0.22)
    for (const l of ['spawn crate 6', 'spawn barrel 3', 'gravity moon', 'spawn ball 4', 'undo', 'gravity 1', 'spawn crate lots', 'spawnn cone']) {
      console.log(`  > ${l}: ${(await run(l)).join(' / ')}`)
      await sleep(250)
    }
    await sleep(1800)
    // then really type: enter opens the printer, and a half-typed command
    // shows the completion list pencilled over the line
    await tap('Enter')
    await sleep(400)
    await type('/tp landmark:')
    await sleep(500)
    await shot('console')
    await tap('Tab')
    await sleep(250)
    await shot('console-tab')
    await tap('Escape')
    await sleep(400)
    // closed, the strip holds its last lines for a few seconds
    await shot('console-closed')
    await run('cleanup')
  }

  if (WHAT.includes('menu')) {
    console.log('menu')
    await look(null, -0.3)
    await down('KeyQ')
    await sleep(600)
    // hover the second plate, click it (it stamps SENT and the prop lands),
    // then hover the third so the pencil ring shows
    const plates = await evaluate(`[...document.querySelectorAll('button')]
      .filter((b) => b.querySelector('img'))
      .map((b) => { const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })`)
    console.log(`  ${plates?.length ?? 0} plates`)
    if (plates?.length > 2) {
      const [cx, cy] = plates[1]
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
      await sleep(180)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: plates[2][0], y: plates[2][1] })
    }
    await sleep(250)
    await shot('menu')
    // the find line pins the book open: click it, let go of q, type
    const find = await evaluate(`(() => { const r = document.querySelector('input[placeholder]:not([type])')
      ?.getBoundingClientRect(); return r && r.top > 0 ? [r.x + 20, r.y + r.height / 2] : null })()`)
    if (find) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: find[0], y: find[1], button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: find[0], y: find[1], button: 'left', clickCount: 1 })
      await sleep(150)
      await up('KeyQ')
      await sleep(300)
      await type(lang === 'es' ? 'barr' : 'dru')
      await sleep(300)
      await shot('menu-find')
      await tap('Enter')
      await sleep(200)
      await tap('Escape')
    } else {
      await up('KeyQ')
    }
    await sleep(900)
    await shot('menu-after')
    await run('cleanup')
  }

  if (WHAT.includes('noclip')) {
    console.log('noclip')
    const frames = Number(flag('frames', 8))
    const film = async (name, third) => {
      await evaluate(`window.__sandbox.console.host.thirdPerson(${third})`)
      // over rooftops, the way noclip is mostly used
      console.log(`  ${(await run(`tp ${flag('fly-at', 'town:suburb')}`)).join(' / ')}`)
      await sleep(4000)
      await look(null, 0)
      await tap('KeyV')
      await sleep(300)
      const dir = mkdtempSync(join(tmpdir(), 'noclip-'))
      const labels = []
      // climb, level off over the fields, then a sprint dive
      const plan = [
        { at: 0, keys: ['Space'], pitch: 0.1, label: 'v, space: lift off' },
        { at: 1, keys: ['KeyW', 'Space'], pitch: 0.25, label: 'w + space: climb' },
        { at: 2, keys: ['KeyW'], pitch: 0, label: 'w: cruise' },
        { at: 3, keys: ['KeyW', 'ShiftLeft'], pitch: -0.05, label: 'shift: fast' },
        { at: 4, keys: ['KeyW', 'ShiftLeft'], pitch: -0.35, label: 'shift: dive' },
        { at: 5, keys: ['KeyW'], pitch: -0.2, label: 'w: coast down' },
        { at: 6, keys: [], pitch: -0.1, label: 'let go: drift to a stop' },
        { at: 7, keys: [], pitch: -0.3, label: 'v mid-air: drop (and flop)' },
      ].slice(0, frames)
      let held = []
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i]
        for (const k of held) if (!p.keys.includes(k)) await up(k)
        for (const k of p.keys) if (!held.includes(k)) await down(k)
        held = p.keys
        await look(null, p.pitch)
        if (i === plan.length - 1) await tap('KeyV')
        await sleep(i === plan.length - 1 ? 1600 : 1100)
        const f = join(dir, `${String(i).padStart(2, '0')}.png`)
        writeFileSync(f, await probe.screenshot(W, H))
        const pos = await evaluate(`(() => { const c = window.__sandboxCamera.position; return [c.x, c.y, c.z].map(Math.round) })()`)
        labels.push(`${p.label}  (${pos.join(', ')})`)
      }
      for (const k of held) await up(k)
      // a labelled 4-wide strip through ffmpeg
      const cols = 4
      const esc = (s) => s.replace(/[:\\']/g, (c) => `\\${c}`)
      const inputs = labels.flatMap((_, i) => ['-i', join(dir, `${String(i).padStart(2, '0')}.png`)])
      const scaled = labels.map((l, i) =>
        `[${i}:v]scale=640:400,drawbox=x=0:y=370:w=640:h=30:color=black@0.55:t=fill,drawtext=text='${esc(`${i + 1}. ${l}`)}':x=10:y=378:fontsize=15:fontcolor=white[v${i}]`)
      const layout = labels.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 400}`).join('|')
      const graph = `${scaled.join(';')};${labels.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${labels.length}:layout=${layout}`
      const out = join(OUT, `${name}.png`)
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-frames:v', '1', out])
      if (r.status !== 0) console.error(String(r.stderr))
      else console.log(`  wrote ${out}`)
      rmSync(dir, { recursive: true, force: true })
    }
    await film('noclip-first', false)
    await film('noclip-third', true)
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
  }

  if (has('debug')) console.log((await evaluate('window.__log')).join('\n'))
  if (probe.errors.length) {
    console.log(`\npage errors (${probe.errors.length}):`)
    for (const e of probe.errors.slice(0, 10)) console.log(`  ${String(e).split('\n')[0]}`)
  }
} finally {
  probe.close()
}
