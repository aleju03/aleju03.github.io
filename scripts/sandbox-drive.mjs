#!/usr/bin/env node
/*
  Photograph the sandbox's own interface over the live game.

    npm run drive -- console          the receipt printer, open, mid-completion
    npm run drive -- menu             the catalogue held up with q, a plate ringed
    npm run drive -- noclip           a noclip flight: a first-person strip and a
                                      third-person strip of the float pose
    npm run drive -- links            shader links counted in the real game across
                                      a first spawn, a break, a fuse and a chain
                                      of bangs (must be 0)
    npm run drive                     the first three

  --at x,z | place       where the console and menu shots stand (5654,-844, the
                         physics harness's flat site, so nothing rolls away)
  --fly-at x,z | place   where the noclip films start (-32,-331: a street in
                         the home city's downtown, for rooftops to cross)
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

  Writes shots/sandbox/: console, console-tab, console-closed (the receipt
  over what it spawned, at the crosshair), menu, menu-page2, menu-category, menu-find,
  menu-after (the catalogue, then the orders standing in front of you), and
  noclip-first / noclip-third (labelled eight-frame strips). Ports come from PROBE_PORT / PROBE_CDP like the other
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
const VALUED = new Set(['--out', '--at', '--fly-at', '--fly-yaw', '--yaw', '--frames', '--lang'])
const wanted = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]))
if (has('help') || argv.includes('-h')) {
  // the header above is the help; print it rather than booting anything
  const src = (await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8')
  console.log(src.slice(src.indexOf('/*') + 2, src.indexOf('*/')).replace(/^\n/, ''))
  process.exit(0)
}
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
  // never photograph a heap: a ragdoll left over from a drop is stood up
  // by noclipping out of it (tp and noclip both stand the body up)
  const stand = async () => {
    if (await evaluate('!!window.__sandboxRig?.down')) {
      await run('noclip')
      await run('noclip')
      await sleep(600)
    }
  }
  // (and a few frames for the lens to follow before anything is aimed)
  const look = async (yaw, pitch) => {
    await evaluate(`(() => { const w = window.__sandboxWalk; ${yaw === null ? '' : `w.yaw = ${yaw};`} w.pitch = ${pitch} })()`)
    await sleep(400)
  }

  // first person, somewhere open: the harness's own countryside, or --at
  await evaluate('window.__sandbox.console.host.thirdPerson(false)')
  const AT = flag('at', '5654 -844').replace(',', ' ')
  // a teleport races the tail of /world's stand-up and can be undone by it,
  // so go until the lens is actually there
  const goTo = async (where) => {
    for (let i = 0; i < 8; i++) {
      const before = await evaluate('window.__sandboxCamera.position.toArray()')
      const out = await run(`tp ${where}`)
      await sleep(2500)
      const after = await evaluate('window.__sandboxCamera.position.toArray()')
      // arrived: moved a long way, or (already standing there, as a second
      // teleport to the same spot is) within a few units of a numeric target
      const xz = where.split(/[ ,]+/).map(Number)
      const near = xz.length === 2 && xz.every(Number.isFinite) && Math.hypot(after[0] - xz[0], after[2] - xz[1]) < 6
      if (near || Math.hypot(after[0] - before[0], after[2] - before[2]) > 20 || /\b0 u\b/.test(out.join())) {
        console.log(`  ${out.join(' / ')}`)
        return
      }
    }
    console.log(`  could not get to ${where}`)
  }
  await goTo(AT)
  await sleep(1000)
  await run('time 10:30')
  await stand()
  await look(Number(flag('yaw', 0.6)), 0)

  // a click at the centre of whatever matches `sel`
  const where = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  const clickOn = async (sel, move = true) => {
    const at = await where(sel)
    if (!at) return false
    if (move) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', clickCount: 1 })
    return true
  }
  const hover = async (sel) => {
    const at = await where(sel)
    if (at) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] })
  }

  if (WHAT.includes('console')) {
    console.log('console')
    // first person, looking a little down at open ground ahead: everything
    // the receipt confirms lands in frame, at the crosshair
    await look(null, -0.26)
    if (has('debug')) {
      console.log('    aim ' + await evaluate(`(() => { const h = window.__sandbox.console.host; const a = h.aim(); const hit = window.__sandbox.raycast(a.origin, a.dir, 200);
        const cam = window.__sandboxCamera; const w = window.__sandboxWalk; return JSON.stringify({ down: window.__sandboxRig.down, rag: window.__sandboxRig.ragdolling, paused: /PAUSED/.test(document.body.innerText), rot: [cam.rotation.x, cam.rotation.y, cam.rotation.z].map((v) => v.toFixed(2)), order: cam.rotation.order, parent: cam.parent && cam.parent.type, wp: w.pitch, wy: w.yaw, o: [a.origin.x, a.origin.y, a.origin.z].map(Math.round), d: [a.dir.x, a.dir.y, a.dir.z].map((v) => v.toFixed(2)), hit: hit && [hit.distance.toFixed(1), hit.ground, !!hit.solid, !!hit.prop] }) })()`))
    }
    for (const l of ['spawn crate 6', 'spawn barrel 3', 'gravity moon', 'spawn ball 4', 'undo', 'gravity 1', 'spawn crate lots', 'spawnn cone', 'spawn melon 3']) {
      console.log(`  > ${l}: ${(await run(l)).join(' / ')}`)
      if (has('debug')) {
        console.log('    ' + await evaluate(`(() => { const c = window.__sandboxCamera.position; const o = [];
          window.__sandbox.forEach((q) => { const t = q.body.translation(); o.push(q.kind.id + '@' + Math.round(Math.hypot(t.x - c.x, t.z - c.z))) });
          return 'cam ' + c.toArray().map(Math.round) + ' pitch ' + window.__sandboxWalk.pitch.toFixed(2) + ' ' + o.join(' ') })()`))
      }
      await sleep(250)
    }
    await sleep(2200)
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
    await sleep(500)
    // closed, the strip holds its last lines for a few seconds, and the
    // key hints come back on their tape
    await shot('console-closed')
    await run('cleanup')
    await sleep(300)
  }

  if (WHAT.includes('menu')) {
    console.log('menu')
    await stand()
    await look(null, -0.26)
    await down('KeyQ')
    // the icons are drawn the first time the book opens
    await waitFor(() => evaluate(`document.querySelectorAll('[data-kind] img').length > 4`), 60, 250, 'the catalogue icons')
    // order three things from their own sections, aiming a little left,
    // centre and right for each, the way you would
    const yaw0 = Number(flag('yaw', 0.6))
    for (const [id, cat, dy] of [['crate', 'wood', 0.2], ['barrel_explosive', 'explosive', 0], ['melon', 'food', -0.2]]) {
      await clickOn(`[data-category="${cat}"]`)
      await sleep(250)
      await look(yaw0 + dy, -0.26)
      await clickOn(`[data-kind="${id}"]`)
      await sleep(260)
    }
    await look(yaw0, -0.26)
    // then the front of the book: all of it, page one, with a cone just
    // ordered (its stamp still wet) and the pencil on the ball
    await clickOn('[data-category="*"]')
    await sleep(300)
    await look(yaw0 + 0.4, -0.26)
    await clickOn('[data-kind="cone"]')
    await hover('[data-kind="ball"]')
    await sleep(220)
    await shot('menu')
    console.log(`  ${await evaluate(`document.querySelectorAll('[data-kind]').length`)} plates on a page`)
    // lift the corner: the next page of all of it
    await clickOn('[data-turn="next"]')
    await sleep(300)
    await shot('menu-page2')
    // one category page
    await clickOn('[data-category="furniture"]')
    await sleep(350)
    await hover('[data-kind="tv"]')
    await sleep(250)
    await shot('menu-category')
    // the find line pins the book open: click it, let go of q, type
    if (await clickOn('input[placeholder]:not([type])')) {
      await sleep(150)
      await up('KeyQ')
      await sleep(300)
      await type(lang === 'es' ? 'barr' : 'bar')
      await sleep(300)
      await shot('menu-find')
      await look(yaw0 - 0.4, -0.26)
      await tap('Enter')
      await sleep(200)
      await tap('Escape')
    } else {
      await up('KeyQ')
    }
    // and what was ordered, standing where the crosshair was
    await look(yaw0 - 0.1, -0.2)
    await sleep(1400)
    await shot('menu-after')
    await run('cleanup')
    await sleep(300)
  }

  if (WHAT.includes('noclip')) {
    console.log('noclip')
    const frames = Number(flag('frames', 8))
    const film = async (name, third) => {
      await evaluate(`window.__sandbox.console.host.thirdPerson(${third})`)
      // over rooftops, the way noclip is mostly used
      await goTo(flag('fly-at', '-32 -331').replace(',', ' '))
      await sleep(1500)
      // down the street rather than into the tower beside it
      await look(Number(flag('fly-yaw', Math.PI / 2)), 0)
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
        { at: 4, keys: ['KeyW', 'ShiftLeft'], pitch: -0.18, label: 'shift: dive' },
        { at: 5, keys: ['KeyW'], pitch: -0.08, label: 'w: coast down' },
        { at: 6, keys: [], pitch: -0.1, label: 'let go: drift to a stop' },
        { at: 7, keys: [], pitch: -0.1, label: 'c down to the street, v: land' },
      ].slice(0, frames)
      let held = []
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i]
        for (const k of held) if (!p.keys.includes(k)) await up(k)
        for (const k of p.keys) if (!held.includes(k)) await down(k)
        held = p.keys
        await look(null, p.pitch)
        if (i === plan.length - 1) {
          // sink until the feet are a hop over whatever is below, then land
          await down('KeyC')
          await waitFor(() => evaluate(`(() => { const w = window.__sandboxWalk, c = window.__sandboxCamera.position;
            return w.feetY - window.__sandbox.groundY(c.x, c.z) < 1.2 })()`), 120, 50, 'the ground').catch(() => {})
          await up('KeyC')
          await tap('KeyV')
        }
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

  if (WHAT.includes('links')) {
    // the no-mid-walk-link rule, proved in the real game rather than the
    // film's probe page: count linkProgram on the scene's own context across
    // a first spawn of barrels and crates, a chain of bangs (flash, jets,
    // fireball, smoke, scorch), breaks, splinters and a fuse
    console.log('links')
    // on a town street, where the flash has walls to light and the fx the
    // same neighbours they have in the films (--at to put it elsewhere)
    await goTo(flag('at', '-32 -331').replace(',', ' '))
    await sleep(1500)
    await stand()
    // down the street (it runs along z there), not into a shopfront
    await look(Number(flag('yaw', Math.PI)), -0.1)
    await evaluate(`(() => {
      window.__links = []
      for (const c of document.querySelectorAll('canvas')) {
        if (!c.width || c.__linkWrapped) continue
        const gl = c.getContext('webgl2')
        if (!gl) continue
        c.__linkWrapped = true
        window.__wrapped = (window.__wrapped || 0) + 1
        const real = gl.linkProgram.bind(gl)
        gl.linkProgram = (p) => {
          const src = (gl.getAttachedShaders(p) ?? []).map((sh) => gl.getShaderSource(sh) ?? '').join('\\n')
          const name = /#define SHADER_NAME ([^\\s]+)/.exec(src)?.[1] ??
            [...src.matchAll(/uniform \\S+ (u[A-Z]\\w*)/g)].map((m) => m[1]).slice(0, 4).join(' ')
          window.__links.push((window.__phase || '?') + ': ' + (name || 'raw'))
          real(p)
        }
      }
      return true
    })()`)
    const phase = async (name, js, wait) => {
      await evaluate(`window.__phase = ${JSON.stringify(name)}; ${js}; true`)
      await sleep(wait)
      const n = await evaluate(`window.__links.filter((l) => l.startsWith(${JSON.stringify(name + ':')})).length`)
      console.log(`  ${name.padEnd(34)} ${n} programs linked`)
      return n
    }
    await evaluate(`window.__booms = 0; window.__breaks = 0;
      window.__sandbox.onExplosion(() => window.__booms++); window.__sandbox.onBreak(() => window.__breaks++); true`)
    let total = 0
    total += await phase('idle, standing', '', 2000)
    const ahead = `const sb = window.__sandbox, c = window.__sandboxCamera.position, y = window.__sandboxWalk.yaw;
      const fx = -Math.sin(y), fz = -Math.cos(y);
      const put = (k, d, s) => { const x = c.x + fx * d - fz * s, z = c.z + fz * d + fx * s; return sb.spawn(k, { x, y: sb.restY(k, x, z) + 0.3, z }) };`
    total += await phase('first spawn (barrels, crates, glass)', `${ahead}
      window.__ids = [put('barrel_explosive', 16, -3), put('barrel_explosive', 21, 1), put('barrel_explosive', 26, -2),
        put('crate', 18, 3), put('crate', 22, -4), put('crate_small', 24, 4), put('melon', 17, 5), put('bottle', 19, -5),
        put('gascan', 28, 2)]`, 1500)
    total += await phase('a crate broken (boards, dust)', `window.__sandbox.shatter(window.__ids[3])`, 1500)
    total += await phase('a fuse lit (sputter, burn fx)', `window.__sandbox.ignite(window.__ids[8])`, 1200)
    total += await phase('the chain (flash, jets, fire, smoke)', `window.__sandbox.damage(window.__ids[0], 1000)`, 600)
    await shot('links-chain')
    total += await phase('the chain, later bangs', '', 4400)
    total += await phase('after the dust settles', '', 3000)
    const names = await evaluate('window.__links')
    for (const n of names) console.log(`    linked ${n}`)
    const seen = await evaluate('[window.__wrapped, window.__booms, window.__breaks]')
    console.log(`  ${total} programs linked from the first spawn to the last bang ` +
      `(${seen[0]} WebGL context(s) watched, ${seen[1]} explosions, ${seen[2]} breaks)`)
    await run('cleanup')
  }

  if (has('debug')) console.log((await evaluate('window.__log')).join('\n'))
  if (probe.errors.length) {
    console.log(`\npage errors (${probe.errors.length}):`)
    for (const e of probe.errors.slice(0, 10)) console.log(`  ${String(e).split('\n')[0]}`)
  }
} finally {
  probe.close()
}
