#!/usr/bin/env node
/*
  Photograph the sandbox's own interface over the live game.

    npm run drive -- console          the receipt printer, open, mid-completion
    npm run drive -- menu             the catalogue opened with q, a plate ringed
    npm run drive -- noclip           a noclip flight: a first-person strip and a
                                      third-person strip of the float pose
    npm run drive -- links            shader links counted in the real game across
                                      a first spawn, a break, a fuse and a chain
                                      of bangs (must be 0)
    npm run drive -- space            the way up and to the Moon: the street's
                                      frame cost, a crate dropped from 20 up, a
                                      noclip climb shot at the stratosphere, the
                                      curve and orbit, the orbit's cost, a flight
                                      at the Moon to the level cut, its surface
                                      with the Earth in the sky, its cost, the
                                      same crate falling at a sixth of the
                                      gravity (timed against the street's), and
                                      up off it home. Every shader link from the
                                      street on is counted (must be 0). Eight
                                      shots to ~/.cache/overhaul/space
                                      (--space-out <dir>); --dump-globe stops at
                                      orbit and writes the globe's painted map
    npm run drive -- perf             frame cost (cpu, gpu, draw calls,
                                      triangles) in the computer room, at
                                      the front gate by day and night, and
                                      downtown
    npm run drive -- carry [--vehicle heli]
                                      the physgun on a parked machine: taken,
                                      lifted, turned, thrown, landed, handed
                                      back to its own physics (a strip)
    npm run drive -- ship             the ship: boarded in the back garden,
                                      flown out of the air, through the seam
                                      to the Moon, landed, and flown home
    npm run drive -- shipfly          the ship by mouse: turned, climbed to
                                      orbit, hands off (must hold), E out,
                                      and the unstuck command home
    npm run drive -- order            the catalogue's Vehicles section, and
                                      the car ordered to the crosshair
    npm run drive -- contraption      contraptions in the real game: the
                                      catalogue's parts tab, the tool gun
                                      welding a thruster on, a car built from
                                      parts sat in and driven, a rocket on
                                      its thrusters; links counted (must be
                                      0). Four shots to ~/.cache/overhaul/
                                      contraptions (--parts-out <dir>)
    npm run drive                     the first three

  --at x,z | place       where the console and menu shots stand (5654,-844, the
                         physics harness's flat site, so nothing rolls away)
  --fly-at x,z | place   where the noclip films start (-32,-331: a street in
                         the home city's downtown, for rooftops to cross)
  --cap n                the frame limiter for this run (roamPrefs' detents)
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
import { spawn, spawnSync } from 'node:child_process'
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
const VALUED = new Set(['--parts-out', '--out', '--at', '--fly-at', '--fly-yaw', '--yaw', '--frames', '--lang', '--cap', '--spots', '--vehicle'])
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
  // the profile outlives a run, so a cap one run set is cleared by the next
  try { ${flag('cap', null) === null ? `localStorage.removeItem('alejos-roam-prefs')`
    : `localStorage.setItem('alejos-roam-prefs', JSON.stringify({ cap: ${Number(flag('cap', 160))} }))`} } catch {}
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
  KeyE: ['e', 69],
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
  /*
    Frame cost at the three places the owner's fans were compared: the
    computer room (where /world stands up), the front gate looking at the car
    and the street, and downtown. Every drawn frame's rAF callback is timed on
    the CPU, and on the GPU through EXT_disjoint_timer_query_webgl2 when the
    context has it; draw calls, triangles and program switches are counted by
    wrapping the context's own entry points, so the numbers cover every pass
    the look makes, not just the scene's. Frames the limiter drops draw
    nothing and are not counted. Run it with
    PROBE_CHROME_ARGS="--disable-gpu-vsync --disable-frame-rate-limit" to let
    rAF outrun the panel, which is the only way the fps column says anything
    about a cap.
  */
  const perf = async () => {
    console.log('perf')
    await evaluate(`(() => {
      const c = [...document.querySelectorAll('canvas')].find((k) => k.width > 64 && k.getContext('webgl2'))
      const gl = c.getContext('webgl2')
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
      const S = window.__perf = { frames: [], calls: 0, tris: 0, progs: 0, ext: !!ext, on: false, open: [] }
      const wrap = (name, count, inst) => {
        const real = gl[name].bind(gl)
        gl[name] = (...a) => {
          S.calls++
          if (a[0] === gl.TRIANGLES) S.tris += (count(a) / 3) * (inst ? a[a.length - 1] : 1)
          return real(...a)
        }
      }
      wrap('drawElements', (a) => a[1])
      wrap('drawArrays', (a) => a[2])
      wrap('drawElementsInstanced', (a) => a[1], true)
      wrap('drawArraysInstanced', (a) => a[2], true)
      wrap('drawRangeElements', (a) => a[3])
      const use = gl.useProgram.bind(gl)
      gl.useProgram = (p) => { S.progs++; return use(p) }
      // uploads and stalls: bytes pushed through buffer and texture calls,
      // and any call that makes the CPU wait on the GPU
      S.up = 0; S.upN = 0; S.stall = 0
      const size = (v) => (v && v.byteLength !== undefined ? v.byteLength : v && v.width ? v.width * v.height * 4 : typeof v === 'number' ? v : 0)
      for (const name of ['bufferData', 'bufferSubData']) {
        const real = gl[name].bind(gl)
        gl[name] = (...a) => { S.upN++; S.up += size(a[name === 'bufferData' ? 1 : 2]); return real(...a) }
      }
      for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) {
        const real = gl[name].bind(gl)
        gl[name] = (...a) => { S.upN++; S.up += size(a[a.length - 1]) || size(a[a.length - 2]); return real(...a) }
      }
      for (const name of ['readPixels', 'getError', 'clientWaitSync', 'finish', 'getBufferSubData']) {
        const real = gl[name].bind(gl)
        gl[name] = (...a) => { S.stall++; return real(...a) }
      }
      const raf = window.requestAnimationFrame.bind(window)
      const poll = () => {
        S.open = S.open.filter((f) => {
          if (!gl.getQueryParameter(f.q, gl.QUERY_RESULT_AVAILABLE)) return true
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) f.gpu = gl.getQueryParameter(f.q, gl.QUERY_RESULT) / 1e6
          gl.deleteQuery(f.q)
          f.q = null
          return false
        })
      }
      window.requestAnimationFrame = (cb) => raf((t) => {
        if (!S.on) return cb(t)
        S.calls = 0; S.tris = 0; S.progs = 0; S.up = 0; S.upN = 0; S.stall = 0
        const q = ext && S.open.length < 8 ? gl.createQuery() : null
        if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
        const t0 = performance.now()
        try { cb(t) } finally {
          const cpu = performance.now() - t0
          if (q) gl.endQuery(ext.TIME_ELAPSED_EXT)
          if (S.calls > 0) {
            const f = { t, cpu, calls: S.calls, tris: S.tris, progs: S.progs, up: S.up, upN: S.upN, stall: S.stall, gpu: null, q }
            S.frames.push(f)
            if (q) S.open.push(f)
          } else if (q) gl.deleteQuery(q)
          if (ext) poll()
        }
      })
      return S.ext
    })()`).then((ok) => console.log(`  GPU timer query: ${ok ? 'yes' : 'no'}`))
    // and the card's own view: board power and utilisation, sampled by the
    // driver. Only comparable between runs made the same way: with vsync
    // off, headless Chrome's own compositor spins the card at full clock
    // whatever the page asks for, and the watts say more about that than
    // about the frame
    const smi = () => {
      const out = []
      let proc = null
      try {
        proc = spawn('nvidia-smi', ['--query-gpu=power.draw,utilization.gpu,clocks.gr', '--format=csv,noheader,nounits', '-lms', '250'])
        proc.stdout.on('data', (d) => {
          for (const line of String(d).trim().split('\n')) {
            const v = line.split(',').map(Number)
            if (v.length === 3 && v.every(Number.isFinite)) out.push(v)
          }
        })
        proc.on('error', () => {})
      } catch { /* no nvidia-smi: the column stays empty */ }
      return () => {
        proc?.kill()
        const k = out.slice(2)
        const avg = (i) => (k.length ? k.reduce((a, v) => a + v[i], 0) / k.length : null)
        return { watts: avg(0), util: avg(1), clock: avg(2) }
      }
    }
    const measure = async (label, secs = 5) => {
      await evaluate('window.__perf.frames = []; window.__perf.on = true; true')
      const stop = smi()
      await sleep(secs * 1000)
      const card = stop()
      const r = await evaluate(`(() => {
        const S = window.__perf; S.on = false
        const f = S.frames.slice(5)
        const med = (k) => { const v = f.map((x) => x[k]).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
        const p95 = (k) => { const v = f.map((x) => x[k]).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length * 0.95)] : null }
        const span = f.length > 1 ? (f[f.length - 1].t - f[0].t) / 1000 : 1
        const gpuSum = f.reduce((s, x) => s + (x.gpu ?? 0), 0)
        const gpuN = f.filter((x) => x.gpu !== null).length
        return { n: f.length, fps: (f.length - 1) / span, cpu: med('cpu'), cpu95: p95('cpu'), gpu: med('gpu'), gpu95: p95('gpu'),
          busy: gpuN ? (gpuSum / gpuN) * ((f.length - 1) / span) / 10 : null,
          calls: med('calls'), tris: med('tris'), progs: med('progs'),
          up: f.reduce((a, x) => a + x.up, 0) / Math.max(1, f.length), upN: f.reduce((a, x) => a + x.upN, 0) / Math.max(1, f.length),
          stall: f.reduce((a, x) => a + x.stall, 0) / Math.max(1, f.length) }
      })()`)
      const n = (v, d = 2) => (v === null || v === undefined ? '-' : v.toFixed(d))
      console.log(`  ${label.padEnd(26)} fps ${n(r.fps, 0).padStart(4)}  cpu ${n(r.cpu)} (p95 ${n(r.cpu95)}) ms  ` +
        `gpu ${n(r.gpu)} (p95 ${n(r.gpu95)}) ms  gpu busy ${n(r.busy, 0)}%  calls ${r.calls}  tris ${Math.round(r.tris / 1000)}k  program switches ${r.progs}  ` +
        `uploads ${n(r.upN, 1)}/frame ${n(r.up / 1024, 0)} kB  stalls ${n(r.stall, 1)}`)
      if (card.watts !== null) console.log(`  ${''.padEnd(26)} card: ${n(card.watts, 1)} W  util ${n(card.util, 0)}%  ${n(card.clock, 0)} MHz`)
      return r
    }
    /* --breakdown: what one frame drew, by the object that drew it. Every
       mesh in the scene gets an onBeforeRender and an onBeforeShadow hook
       for one frame, labelled by its nearest named ancestors, and the
       triangles are totted up per label and per pass. */
    const breakdown = async (label) => {
      if (!has('breakdown')) return
      const rows = await evaluate(`new Promise((done) => {
        const has = (f) => ${JSON.stringify(argv)}.includes('--' + f)
        const sc = window.__scene
        const tally = new Map()
        const name = (o) => {
          const parts = []
          for (let p = o; p && parts.length < 3; p = p.parent) if (p.name) parts.unshift(p.name)
          const m = Array.isArray(o.material) ? o.material[0] : o.material
          const kind = (m?.name || m?.type || '?') + (o.isInstancedMesh ? ' instanced' : '')
          // an unnamed chunk mesh is told apart by its size, so the same
          // draw across two frames still lands on one row
          return (parts.join('/') || o.type) + ' [' + kind + ']' + (parts.length ? '' : ' #' + (o.geometry?.attributes.position?.count ?? 0))
        }
        const tris = (o) => {
          const g = o.geometry
          if (!g) return 0
          const n = g.index ? g.index.count : g.attributes.position?.count ?? 0
          const d = g.drawRange && g.drawRange.count !== Infinity ? Math.min(n, g.drawRange.count) : n
          const inst = o.isInstancedMesh ? o.count : g.isInstancedBufferGeometry ? (g.instanceCount ?? 1) : 1
          return (d / 3) * inst
        }
        const hooked = []
        sc.traverse((o) => {
          if (!o.isMesh && !o.isPoints && !o.isLine) return
          // by the scene child it hangs off, so a frame is attributed to the
          // house, the world, the fleet, the people... as well as per mesh
          let top = o
          while (top.parent && top.parent !== sc) top = top.parent
          const key = has('byroot') ? (top.name || top.type) + ' (' + top.children.length + ')' : name(o)
          const b = o.onBeforeRender, s = o.onBeforeShadow
          o.onBeforeRender = function (...a) { const t = tally.get(key) ?? { main: 0, mainN: 0, shadow: 0, shadowN: 0 }; t.main += tris(o); t.mainN++; tally.set(key, t); return b.apply(this, a) }
          o.onBeforeShadow = function (...a) { const t = tally.get(key) ?? { main: 0, mainN: 0, shadow: 0, shadowN: 0 }; t.shadow += tris(o); t.shadowN++; tally.set(key, t); return s.apply(this, a) }
          hooked.push([o, b, s])
        })
        // two frames: the first may be one the limiter drops
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const [o, b, s] of hooked) { o.onBeforeRender = b; o.onBeforeShadow = s }
          done([...tally].map(([k, t]) => [k, t.main / 2, t.mainN / 2, t.shadow / 2, t.shadowN / 2])
            .sort((a, b) => (b[1] + b[3]) - (a[1] + a[3])).slice(0, 14))
        })))
      })`)
      console.log(`    ${label}: top drawers (per frame: main tris / draws, shadow tris / draws)`)
      for (const [k, m, mn, sh, shn] of rows) {
        console.log(`      ${k.slice(0, 64).padEnd(64)} ${String(Math.round(m / 1000)).padStart(5)}k / ${String(mn).padStart(3)}   ${String(Math.round(sh / 1000)).padStart(5)}k / ${String(shn).padStart(3)}`)
      }
    }
    /* --ablate: the same spot measured again with one family of drawers
       hidden at a time, which is how a frame's cost gets attributed on a
       card whose timer only sees the whole frame */
    const ablate = async (label) => {
      if (!has('ablate')) return
      const groups = {
        grass: `o.isInstancedMesh && o.geometry.attributes.position.count === 24`,
        'flowers': `o.isInstancedMesh && o.geometry.attributes.position.count === 8`,
        people: `o.isSkinnedMesh && o.material.name === 'playerBody'`,
        animals: `o.isSkinnedMesh && o.material.name !== 'playerBody'`,
        'the car': `(() => { for (let p = o; p; p = p.parent) if (p.name === 'car') return true; return false })()`,
      }
      for (const [g, test] of Object.entries(groups)) {
        // hidden by emptying the draw rather than by .visible, which the
        // world re-asserts every frame for some of these (grass.setVisible)
        await evaluate(`window.__hid = []; window.__scene.traverse((o) => { if ((o.isMesh || o.isPoints) && ${test}) {
          // clones share a geometry (the car's wheels), so each is taken once
          const g = o.geometry; if (window.__hid.some((h) => h[0] === g)) return
          window.__hid.push([g, g.drawRange.count]); g.setDrawRange(0, 0) } }); window.__hid.length`)
        await sleep(600)
        await measure(`${label} - ${g}`, 3)
        await evaluate(`for (const [g, n] of window.__hid) g.setDrawRange(0, n); true`)
      }
    }
    await run('time 12:00')
    await sleep(800)
    // --spots room,gate,downtown: which of them, in that order. The
    // headless GPU process degrades a minute or so into a session, so a
    // spot measured late in a long run reads slow; measure one at a time
    const SPOTS = flag('spots', 'room,gate,downtown').split(',')
    if (SPOTS.includes('room')) {
    // 1. the computer room, turned round from the desk to face the room
    const yaw0 = await evaluate('window.__sandboxWalk.yaw')
    await look(yaw0 + Math.PI, -0.15)
    // the first seconds after /world stands are still streaming the ring
    await sleep(6000)
    await measure('computer room')
    await breakdown('computer room')
    await ablate('room')
    if (has('shots')) await shot('perf-room')
    }
    if (SPOTS.includes('gate')) {
    // 2. the front gate, looking at the car at the kerb and the street
    await goTo('5.5 -2.6')
    await sleep(5000)
    await stand()
    await look(0.94, -0.12)
    await sleep(1500)
    await measure('front gate, car')
    await breakdown('front gate')
    await ablate('gate')
    if (has('shots')) await shot('perf-gate')
    await down('KeyW')
    await sleep(300)
    await measure('front gate, walking out', 2)
    await up('KeyW')
    await goTo('5.5 -2.6')
    await sleep(2500)
    await stand()
    await look(0.94, -0.12)
    await sleep(1000)
    await run('time 22:30')
    await sleep(2500)
    await measure('front gate, car, night')
    if (has('shots')) await shot('perf-gate-night')
    }
    await run('time 12:00')
    if (SPOTS.includes('downtown')) {
    // 3. downtown, down the street
    await goTo('-32 -331')
    // a teleport this far streams a whole new ring, which takes a while
    await sleep(20000)
    await stand()
    await look(Math.PI / 2, -0.05)
    await sleep(1500)
    await measure('downtown')
    // and moving, which is how anybody actually spends time out there: the
    // grass lattices scroll, chunks stream and the sun's map refreshes
    await down('KeyW')
    await sleep(500)
    await measure('downtown, walking', 4)
    await up('KeyW')
    if (has('long')) {
      for (let k = 0; k < 6; k++) {
        await measure(`downtown +${(k + 1) * 5} s`)
        if (has('shots')) await shot(`perf-downtown-${k}`)
      }
    }
    await breakdown('downtown')
    await ablate('downtown')
    }
    if (has('shots')) await shot('perf-downtown')
  }

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
  if (WHAT.includes('perf')) await perf()
  if (WHAT.some((w) => w !== 'perf')) {
    await goTo(AT)
    await sleep(1000)
  }
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
    // q is a toggle: a tap opens the book, a second tap or esc shuts it
    const isOpen = () => evaluate(`!!document.querySelector('[data-category]')`)
    const toggles = []
    for (const k of ['KeyQ', 'KeyQ', 'KeyQ', 'Escape']) {
      await tap(k)
      await sleep(250)
      toggles.push(await isOpen())
    }
    const togglesOk = toggles.join() === 'true,false,true,false'
    console.log(`  q, q, q, esc -> ${toggles.map((o) => (o ? 'open' : 'shut')).join(', ')}${togglesOk ? '' : '  <-- WRONG'}`)
    await sleep(200)
    await tap('KeyQ')
    await sleep(250)
    if (!(await isOpen())) console.log('  q after an esc close did not reopen the book  <-- WRONG')
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
    // the find line takes the keyboard: click it, type
    if (await clickOn('input[placeholder]:not([type])')) {
      await sleep(300)
      await type(lang === 'es' ? 'barr' : 'bar')
      await sleep(300)
      await shot('menu-find')
      await look(yaw0 - 0.4, -0.26)
      await tap('Enter')
      await sleep(200)
      await tap('Escape')
    } else {
      await tap('KeyQ')
    }
    await sleep(250)
    if (await isOpen()) console.log('  the book is still open after esc/q  <-- WRONG')
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

  if (WHAT.includes('space')) {
    console.log('space')
    const SPACE_OUT = resolve(flag('space-out', join(process.env.HOME ?? '.', '.cache/overhaul/space')))
    mkdirSync(SPACE_OUT, { recursive: true })
    const spaceShot = async (name) => {
      const path = join(SPACE_OUT, `${name}.png`)
      writeFileSync(path, await probe.screenshot(W, H))
      console.log(`  wrote ${path}`)
    }
    /* What a frame costs where the lens is now: the look's render with a
       gl.finish() behind it, so the GPU's share is inside the number, and
       the draw calls and triangles three reports for the same frames. The
       limiter is lifted for the window, since a capped loop measures the cap */
    const cost = async (label, ms = 2500) => {
      // a window with no frames in it (the loop stalled on something else)
      // is measured again rather than reported as free
      for (let i = 0; i < 3; i++) {
        const r = await costOnce(label, ms)
        if (!/over [0-9] frames|over [12][0-9] frames/.test(r)) return r
        await sleep(1500)
      }
      return costOnce(label, ms)
    }
    const costOnce = (label, ms) => evaluate(`(async () => {
      const look = window.__look
      const gl = document.querySelector('canvas').getContext('webgl2')
      const real = look.render
      const times = []
      const cpu = []
      let calls = 0, tris = 0
      // the whole frame too: every animation-frame callback timed end to end
      const realRaf = window.requestAnimationFrame
      window.requestAnimationFrame = (cb) => realRaf((t) => {
        const t0 = performance.now()
        cb(t)
        cpu.push(performance.now() - t0)
      })
      const info = window.__renderer?.info
      if (info) info.autoReset = false
      look.render = (s, c) => {
        info?.reset()
        const t = performance.now()
        real(s, c)
        gl.finish()
        times.push(performance.now() - t)
        if (info) { calls += info.render.calls; tris += info.render.triangles }
      }
      await new Promise((r) => setTimeout(r, ${ms}))
      look.render = real
      window.requestAnimationFrame = realRaf
      if (info) info.autoReset = true
      const frame = cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : 0
      times.sort((a, b) => a - b)
      const n = times.length || 1
      const mean = times.reduce((a, b) => a + b, 0) / n
      return ${JSON.stringify(label)}.padEnd(22) + ' frame ' + frame.toFixed(2) + ' ms, render ' + mean.toFixed(2) + ' ms mean, ' +
        times[Math.floor(n * 0.95)]?.toFixed(2) + ' ms p95 over ' + times.length + ' frames, ' +
        Math.round(calls / n) + ' draws, ' + Math.round(tris / n / 1000) + 'k tris'
    })()`)
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await goTo(flag('at', '-32 -331').replace(',', ' '))
    await sleep(1500)
    await run('time 10:30')
    await stand()
    await look(Number(flag('yaw', Math.PI)), 0.05)
    await sleep(1500)
    console.log('  ' + await cost('ground'))
    await spaceShot('1-ground')

    // every program linked from here to the end is a hitch in somebody's
    // flight: the climb, the orbit, the cut to the Moon and back must be 0
    await evaluate(`(() => {
      window.__spaceLinks = []
      const c = document.querySelector('canvas')
      const gl = c.getContext('webgl2')
      if (!c.__spaceWrapped) {
        c.__spaceWrapped = true
        const real = gl.linkProgram.bind(gl)
        gl.linkProgram = (p) => {
          window.__spaceLinks.push((window.__spacePhase || '?') + ' ' + performance.now().toFixed(0))
          real(p)
        }
      }
      return true
    })()`)
    const phase = (name) => evaluate(`window.__spacePhase = ${JSON.stringify(name)}; true`)
    const where = () => evaluate(`(() => { const c = window.__sandboxCamera.position, v = window.__outside.view;
      return { x: c.x, y: c.y, z: c.z, alt: v.alt, space: v.space, level: window.__levels.current.id,
        moon: v.moon ? [v.moon.x, v.moon.y, v.moon.z] : null, surf: v.surf } })()`)

    /* A crate dropped from a known height ahead, timed in the sandbox's own
       clock from release to its first touch of the ground, against
       sqrt(2h/g). The same drop on the street and on the Moon */
    const drop = (h) => evaluate(`(async () => {
      const sb = window.__sandbox, c = window.__sandboxCamera.position, yaw = window.__sandboxWalk.yaw
      const x = c.x - Math.sin(yaw) * 9, z = c.z - Math.cos(yaw) * 9
      const y = sb.restY('crate', x, z) + ${h}
      await sb.whenReady
      const t0 = sb.stats.time
      return await new Promise((res) => {
        let id = -1
        const off = sb.onImpact((e) => {
          if (e.id !== id || e.with === 'prop') return
          off()
          res({ t: sb.stats.time - t0, g: -sb.gravity, theory: Math.sqrt(2 * ${h} / -sb.gravity) })
        })
        id = sb.spawn('crate', { x, y, z })
        setTimeout(() => { off(); res({ t: -1, g: -sb.gravity, theory: 0 }) }, 15000)
      })
    })()`)
    const earthDrop = await drop(20)
    console.log(`  a crate from 20 up, street: ${earthDrop.t.toFixed(2)} s (g ${earthDrop.g.toFixed(1)}, sqrt(2h/g) ${earthDrop.theory.toFixed(2)} s)`)
    await run('cleanup')

    // up: noclip, and space + shift held, straight up (no W, so the gaze is
    // free to frame the shots)
    await phase('climb')
    await evaluate('window.__sandbox.console.host.noclip(true)')
    await look(null, -0.22)
    const climbTo = async (alt, name, pitch) => {
      await down('Space')
      await down('ShiftLeft')
      await waitFor(async () => (await where()).alt > alt, 400, 50, `${alt} up`)
      await up('Space')
      await up('ShiftLeft')
      await look(null, pitch)
      await sleep(1800)
      const w = await where()
      console.log(`  ${name}: ${Math.round(w.alt)} up, space ${w.space.toFixed(2)}`)
      await spaceShot(name)
    }
    const t1 = Date.now()
    await climbTo(5200, '2-stratosphere', -0.25)
    await climbTo(9000, '3-curve', -0.35)
    // the band where the streamed ground dithers out over the globe, looking
    // straight down at the seam, and what a frame costs there
    await climbTo(15500, '3b-fade', -1.3)
    console.log('  ' + await cost('fade band'))
    await climbTo(34000, '4-orbit', -1.05)
    console.log(`  street to orbit in ${((Date.now() - t1) / 1000).toFixed(1)} s, shots included`)
    if (has('dump-globe')) {
      // the Earth's painted map as it stands (world/globe.ts), rgb over the
      // towns' night glow, and stop there
      await sleep(4000)
      const b64 = await evaluate(`(() => {
        const m = window.__scene.getObjectByName('globe-earth').material.uniforms.uMap.value.image
        const c = document.createElement('canvas'); c.width = m.width; c.height = m.height * 2
        const g = c.getContext('2d'); const img = g.createImageData(m.width, m.height * 2)
        for (let i = 0; i < m.width * m.height; i++) {
          for (let k = 0; k < 3; k++) img.data[i * 4 + k] = m.data[i * 4 + k]
          img.data[i * 4 + 3] = 255
          const j = i + m.width * m.height
          img.data[j * 4] = img.data[j * 4 + 1] = img.data[j * 4 + 2] = m.data[i * 4 + 3]; img.data[j * 4 + 3] = 255
        }
        g.putImageData(img, 0, 0)
        return c.toDataURL('image/png').split(',')[1]
      })()`)
      writeFileSync(join(SPACE_OUT, 'globe-map.png'), Buffer.from(b64, 'base64'))
      console.log(`  wrote ${join(SPACE_OUT, 'globe-map.png')}`)
      probe.close()
      process.exit(0)
    }
    await sleep(2500)
    console.log('  ' + await cost('orbit'))
    // ...and flying across it flat out, which is what a flight is: the map
    // re-anchors and bakes under you the whole way
    await look(null, 0)
    await down('KeyW')
    await down('ShiftLeft')
    await sleep(600)
    console.log('  ' + await cost('orbit, flying'))
    await up('KeyW')
    await up('ShiftLeft')
    await sleep(1500)

    // at the Moon: aim at its centre and fly, shift held, until the cut.
    // The clock is let go first: the Moon keeps its own time of day
    await run('time')
    await phase('to the moon')
    const w0 = await where()
    if (!w0.moon) console.log('  no Moon pinned  <-- WRONG')
    else {
      const aim = async () => {
        const w = await where()
        if (!w.moon) return w
        const dx = w.moon[0] - w.x, dy = w.moon[1] - w.y, dz = w.moon[2] - w.z
        // never steeper than this: looking straight down, first person, you
        // look at your own body
        const pitch = Math.max(-0.95, Math.atan2(dy, Math.hypot(dx, dz)))
        await evaluate(`(() => { const k = window.__sandboxWalk; k.yaw = ${Math.atan2(-dx, -dz)}; k.pitch = ${pitch} })()`)
        return { ...w, d: Math.hypot(dx, dy, dz) }
      }
      /*
        The approach, with no cut: a strip of frames from well out to the
        ground, each labelled with the level it was drawn in. It must read
        as one flight, the level changing under it without a frame of black
      */
      const STRIP = resolve(flag('strip-out', join(process.env.HOME ?? '.', '.cache/overhaul/space2')))
      mkdirSync(STRIP, { recursive: true })
      const stripShot = async (name, w) => {
        const path = join(STRIP, `${name}.png`)
        writeFileSync(path, await probe.screenshot(W, H))
        console.log(`  strip ${name}: ${w.level}, ${Math.round(w.surf ?? -1)} off the Moon`)
      }
      await aim()
      await down('KeyW')
      await down('ShiftLeft')
      const marks = [[120000, 'a-120k'], [45000, 'b-45k'], [20000, 'c-20k'], [8000, 'd-8k'], [3400, 'e-3k']]
      let measured = false
      await waitFor(async () => {
        const w = await aim()
        if (!measured && w.surf < 30000) {
          measured = true
          await up('KeyW')
          await up('ShiftLeft')
          await sleep(800)
          console.log('  ' + await cost('approach'))
          await down('KeyW')
          await down('ShiftLeft')
        }
        while (marks.length && w.surf < marks[0][0]) {
          const [, name] = marks.shift()
          await stripShot(name, w)
        }
        return w.level === 'moon'
      }, 900, 60, 'the Moon, flown onto')
      await up('KeyW')
      await up('ShiftLeft')
      await phase('moon')
      await look(null, -0.35)
      await sleep(600)
      await stripShot('f-on-the-moon', await where())
      const m = await where()
      const mg = await evaluate(`window.__levels.current.groundYAt(${m.x}, ${m.z})`)
      console.log(`  on the Moon: ${Math.round(m.y - mg)} over its ground, at ${Math.round(m.x)}, ${Math.round(m.z)}`)
      // down to the surface in noclip, then drop the last hop and stand
      await look(null, -0.3)
      await down('KeyC')
      await waitFor(() => evaluate(`(() => { const k = window.__sandboxWalk, c = window.__sandboxCamera.position;
        return k.feetY - window.__levels.current.groundYAt(c.x, c.z) < 2 })()`), 400, 50, 'the regolith').catch(() => {})
      await up('KeyC')
      await evaluate('window.__sandbox.console.host.noclip(false)')
      await sleep(2500)
      await evaluate('window.__sandbox.console.host.thirdPerson(true)')
      // over the shoulder toward the Earth (the arrival faces it)
      await sleep(1500)
      await stripShot('g-standing', await where())
      // over the shoulder toward the Earth, wherever it hangs
      await evaluate(`(() => { const e = window.__scene.getObjectByName('globe-earth').position, c = window.__sandboxCamera.position
        const dx = e.x - c.x, dy = e.y - c.y, dz = e.z - c.z
        window.__sandboxWalk.yaw = Math.atan2(-dx, -dz); window.__sandboxWalk.pitch = Math.max(-0.2, Math.atan2(dy, Math.hypot(dx, dz)) - 0.35); return true })()`)
      await sleep(1500)
      await spaceShot('6-moon-surface')
      console.log('  ' + await cost('moon'))
      await evaluate('window.__sandbox.console.host.thirdPerson(false)')
      await look(null, 0.05)
      const moonDrop = await drop(20)
      console.log(`  a crate from 20 up, Moon:   ${moonDrop.t.toFixed(2)} s (g ${moonDrop.g.toFixed(1)}, sqrt(2h/g) ${moonDrop.theory.toFixed(2)} s)`)
      if (earthDrop.t > 0 && moonDrop.t > 0) {
        console.log(`  Moon fall / street fall = ${(moonDrop.t / earthDrop.t).toFixed(2)} (sqrt(6) = 2.45)`)
      }
      // a second crate, photographed on its way down
      await evaluate(`(() => { const sb = window.__sandbox, c = window.__sandboxCamera.position, yaw = window.__sandboxWalk.yaw
        const x = c.x - Math.sin(yaw) * 10, z = c.z - Math.cos(yaw) * 10
        sb.spawn('barrel', { x, y: sb.restY('barrel', x, z) + 14, z }); return true })()`)
      await sleep(1100)
      await spaceShot('7-moon-prop')
      // and home: straight up off the Moon, through the seam back onto the
      // Earth's side, and on until the frame has swung back and the Earth is
      // below again
      await phase('home')
      await evaluate('window.__sandbox.console.host.noclip(true)')
      await down('Space')
      await down('ShiftLeft')
      await waitFor(async () => (await where()).level === 'overworld', 600, 100, 'off the Moon').catch(() => {})
      await waitFor(async () => ((await where()).surf ?? 0) > 70000, 600, 100, 'clear of the Moon').catch(() => {})
      await up('Space')
      await up('ShiftLeft')
      await sleep(2500)
      const h = await where()
      console.log(`  home: level ${h.level}, ${Math.round(h.alt)} over the ground, ${Math.round(h.surf)} off the Moon`)
      await look(null, -1.4)
      await sleep(1500)
      await spaceShot('8-home-from-above')
    }
    const links = await evaluate('window.__spaceLinks')
    console.log(`  ${links.length} programs linked from the street to the Moon and back`)
    for (const l of links) console.log(`    linked during ${l}`)
  }

  if (WHAT.includes('carry')) {
    /*
      The physgun on a parked machine: stand on the street beside the car,
      take it with the beam, lift it, swing it, turn it over, throw it, and
      watch it land and hand itself back to its own suspension. A labelled
      eight-frame strip, plus the fleet's own account of each frame (who
      holds it, whether it is a prop, where it is). `--vehicle heli|boat|ship`
      takes another machine, recalled beside you first.
    */
    console.log('carry')
    const which = flag('vehicle', 'car')
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await goTo(flag('at', '10 -11.2').replace(',', ' '))
    await sleep(1500)
    await stand()
    const at = await evaluate('window.__sandboxCamera.position.toArray()')
    if (which !== 'car' || has('recall')) {
      await evaluate(`(() => { const f = window.__fleet; const env = window.__fleetEnv(); return f.recall(${JSON.stringify(which)}, window.__sandboxCamera.position, env) })()`)
      await sleep(1200)
    }
    const vpos = await evaluate(`window.__fleet.all.find((v) => v.id === ${JSON.stringify(which)}).root.position.toArray()`)
    // face the machine, a little down at its flank
    const dx = vpos[0] - at[0]
    const dz = vpos[2] - at[2]
    const yaw0 = Math.atan2(-dx, -dz)
    const pitch0 = Math.atan2(vpos[1] + 1.2 - at[1], Math.hypot(dx, dz))
    await evaluate('window.__tools.select(1)')
    await look(yaw0, pitch0)
    await sleep(600)
    const dir = mkdtempSync(join(tmpdir(), 'carry-'))
    const labels = []
    const report = () => evaluate(`(() => {
      const v = window.__fleet.all.find((m) => m.id === ${JSON.stringify(which)})
      const p = v.root.position, q = v.root.quaternion
      const u = { x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) }
      let prop = false
      window.__sandbox.forEach((q) => { if (q.data.vehicle === v.id) prop = true })
      return [p.x, p.y, p.z].map((n) => n.toFixed(1)).join(', ') + '  up ' + u.y.toFixed(2) +
        (window.__tools.physgun.holding ? '  held' : '') + (prop ? '  (a prop)' : '  (its own physics)')
    })()`)
    // after the throw the lens follows the machine, the way you would
    let follow = false
    const track = async () => {
      if (!follow) return
      const [c, v] = await evaluate(`[window.__sandboxCamera.position.toArray(), window.__fleet.all.find((m) => m.id === ${JSON.stringify(which)}).root.position.toArray()]`)
      const ddx = v[0] - c[0]
      const ddz = v[2] - c[2]
      const w = `window.__sandboxWalk.yaw = ${Math.atan2(-ddx, -ddz)}; window.__sandboxWalk.pitch = ${Math.atan2(v[1] + 1 - c[1], Math.hypot(ddx, ddz))}; true`
      await evaluate(w)
    }
    const frame = async (label, wait) => {
      for (let t = 0; t < wait; t += 150) {
        await sleep(Math.min(150, wait - t))
        await track()
      }
      const f = join(dir, `${String(labels.length).padStart(2, '0')}.png`)
      writeFileSync(f, await probe.screenshot(W, H))
      const r = await report()
      labels.push(label)
      console.log(`  ${label.padEnd(28)} ${r}`)
    }
    const trigger = (on) => evaluate(`(() => { const k = window.__input.keys; ${on ? "k.add('Mouse0')" : "k.delete('Mouse0')"}; return true })()`)
    // and no program may link for any of it
    await evaluate(`(() => { window.__carryLinks = 0; for (const c of document.querySelectorAll('canvas')) {
      const gl = c.width && c.getContext('webgl2'); if (!gl || gl.__carryWrapped) continue; gl.__carryWrapped = true
      const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => { window.__carryLinks++; real(p) } } return true })()`)
    await frame('the beam on the car', 200)
    await trigger(true)
    await frame('taken', 500)
    // lift: the view comes up, and the held distance with it
    for (let i = 1; i <= 10; i++) {
      await look(yaw0, pitch0 + i * 0.05)
      await sleep(60)
    }
    await frame('lifted', 900)
    // swing it round in front of you
    for (let i = 1; i <= 8; i++) {
      await look(yaw0 + i * 0.06, pitch0 + 0.5)
      await sleep(60)
    }
    await frame('swung round', 700)
    // a flick: swing the view hard and let go mid-swing
    // (up and away down the street, clear of the houses either side)
    for (let i = 1; i <= 6; i++) {
      await evaluate(`window.__sandboxWalk.yaw = ${yaw0 + 0.48 - i * 0.08}; window.__sandboxWalk.pitch = ${pitch0 + 0.5 + i * 0.07}; true`)
      await sleep(25)
    }
    await trigger(false)
    follow = true
    await frame('thrown', 250)
    await frame('landing', 900)
    await frame('tumbling to rest', 1800)
    await frame('come to rest', 3000)
    console.log(`  ${await evaluate('window.__carryLinks')} programs linked while carrying`)
    const cols = 4
    const esc = (t) => t.replace(/[:\\']/g, (c) => `\\${c}`)
    const inputs = labels.flatMap((_, i) => ['-i', join(dir, `${String(i).padStart(2, '0')}.png`)])
    const scaled = labels.map((l, i) =>
      `[${i}:v]scale=640:400,drawbox=x=0:y=370:w=640:h=30:color=black@0.55:t=fill,drawtext=text='${esc(`${i + 1}. ${l}`)}':x=10:y=378:fontsize=15:fontcolor=white[v${i}]`)
    const layout = labels.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 400}`).join('|')
    const graph = `${scaled.join(';')};${labels.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${labels.length}:layout=${layout}`
    const out = join(OUT, `carry-${which}.png`)
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-frames:v', '1', out])
    if (r.status !== 0) console.error(String(r.stderr))
    else console.log(`  wrote ${out}`)
    rmSync(dir, { recursive: true, force: true })
  }

  if (WHAT.includes('ship')) {
    /*
      The ship, end to end: parked in the back garden, boarded with E, flown
      up out of the air, carried through the seam to the Moon (warped to the
      seam's edge once the Moon is pinned, since steering there by keys is
      the player's job and not a harness's), landed on the regolith under a
      sixth of the gravity, and flown back up through the seam home. A
      labelled strip and the numbers per frame: level, where it is, height
      over the ground, speed, riding or not, program links.
    */
    console.log('ship')
    await evaluate(`(() => { window.__shipLinks = 0; for (const c of document.querySelectorAll('canvas')) {
      const gl = c.width && c.getContext('webgl2'); if (!gl || gl.__shipWrapped) continue; gl.__shipWrapped = true
      const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => { window.__shipLinks++; real(p) } } return true })()`)
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await run('time 11:00')
    await goTo('5.2 31.5')
    await sleep(1500)
    await stand()
    await look(Math.PI / 2, -0.2)
    const dir = mkdtempSync(join(tmpdir(), 'ship-'))
    const labels = []
    const state = () => evaluate(`(() => {
      const v = window.__fleet.all.find((m) => m.id === 'ship'), p = v.root.position
      const L = window.__levels.current
      const g = L.groundYAt ? L.groundYAt(p.x, p.z) : L.groundY
      return L.id + '  ' + [p.x, p.y, p.z].map((n) => n.toFixed(0)).join(', ') + '  ' + (p.y - g).toFixed(0) + ' up' +
        (window.__fleet.riding ? '  aboard' : '  parked') + '  links ' + window.__shipLinks
    })()`)
    const frame = async (label, wait = 0) => {
      await sleep(wait)
      const f = join(dir, `${String(labels.length).padStart(2, '0')}.png`)
      writeFileSync(f, await probe.screenshot(W, H))
      labels.push(label)
      console.log(`  ${label.padEnd(30)} ${await state()}`)
    }
    const hold = (code, on) => evaluate(`(() => { const k = window.__input.keys; ${on ? `k.add('${code}')` : `k.delete('${code}')`}; return true })()`)
    await frame('parked in the back garden', 300)
    await tap('KeyE', 150)
    await sleep(1500)
    if (!(await evaluate('!!window.__fleet.riding'))) console.log('  E did not board it  <-- WRONG')
    // lift off, then climb nose up on boost
    await hold('Space', true)
    await frame('lifting off', 2200)
    await hold('Space', false)
    await hold('KeyR', true)
    await sleep(900)
    await hold('KeyR', false)
    await hold('KeyW', true)
    await hold('ShiftLeft', true)
    await hold('Space', true)
    await frame('climbing out', 4000)
    // on up until the Moon is pinned (the climb past 3000)
    for (let i = 0; i < 40; i++) {
      if (await evaluate('!!window.__outside.view.moon')) break
      await sleep(500)
    }
    await frame('above the air', 1500)
    await hold('KeyW', false)
    await hold('ShiftLeft', false)
    await hold('Space', false)
    // to the seam's edge: just outside the Moon's cut radius, on the line to it
    await evaluate(`(() => { const m = window.__outside.view.moon; const p = window.__fleet.riding.root.position
      const d = m.clone().sub(p); const len = d.length(); d.normalize()
      const at = m.clone().addScaledVector(d, -(9000 + 2400))
      return window.__fleet.warpRiding(at.x, at.y, at.z, Math.atan2(-d.x, -d.z)) })()`)
    await frame('at the Moon', 2500)
    for (let i = 0; i < 30; i++) {
      if (await evaluate(`window.__levels.current.id === 'moon'`)) break
      await sleep(300)
    }
    await frame('arrived over the landing site', 2500)
    // down onto the regolith
    await hold('KeyC', true)
    for (let i = 0; i < 40; i++) {
      const up = await evaluate(`(() => { const p = window.__fleet.riding.root.position; const L = window.__levels.current; return p.y - L.groundYAt(p.x, p.z) })()`)
      if (up < 1) break
      await sleep(400)
    }
    await hold('KeyC', false)
    await frame('landed on the Moon', 1500)
    await look(null, 0)
    // and home: straight up past the seam
    await hold('Space', true)
    await hold('ShiftLeft', true)
    for (let i = 0; i < 60; i++) {
      if (await evaluate(`window.__levels.current.id === 'overworld'`)) break
      await sleep(400)
    }
    await hold('Space', false)
    await hold('ShiftLeft', false)
    await frame('back over the Earth', 2500)
    for (const k of ['KeyW', 'KeyR', 'KeyC', 'Space', 'ShiftLeft']) await hold(k, false)
    const cols = 4
    const esc = (t) => t.replace(/[:\\']/g, (c) => `\\${c}`)
    const inputs = labels.flatMap((_, i) => ['-i', join(dir, `${String(i).padStart(2, '0')}.png`)])
    const scaled = labels.map((l, i) =>
      `[${i}:v]scale=640:400,drawbox=x=0:y=370:w=640:h=30:color=black@0.55:t=fill,drawtext=text='${esc(`${i + 1}. ${l}`)}':x=10:y=378:fontsize=15:fontcolor=white[v${i}]`)
    const layout = labels.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 400}`).join('|')
    const graph = `${scaled.join(';')};${labels.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${labels.length}:layout=${layout}`
    const out = join(OUT, 'ship.png')
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-frames:v', '1', out])
    if (r.status !== 0) console.error(String(r.stderr))
    else console.log(`  wrote ${out}`)
    rmSync(dir, { recursive: true, force: true })
  }

  if (WHAT.includes('shipfly')) {
    /*
      The ship by mouse, and the ways out of it: boarded in the back garden,
      lifted, turned by the mouse (the drive camera's aim, fed here through
      the fleet's own `turn` since a headless page has no pointer lock) with
      W held, climbed out of the air, and then every key let go for ten
      seconds in orbit, where it must hold station rather than circle; then
      E, which must eject into a float from up there, and the console's
      `unstuck`, which must stand you at home on Earth. A strip and the
      numbers per frame.
    */
    console.log('shipfly')
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await run('time 11:00')
    await goTo('5.2 31.5')
    await sleep(1500)
    await stand()
    await look(Math.PI / 2, -0.2)
    const dir = mkdtempSync(join(tmpdir(), 'shipfly-'))
    const labels = []
    const state = () => evaluate(`(() => {
      const v = window.__fleet.all.find((m) => m.id === 'ship'), p = v.root.position
      const L = window.__levels.current, c = window.__sandboxCamera.position
      const g = L.groundYAt ? L.groundYAt(p.x, p.z) : L.groundY
      const me = window.__fleet.riding ? 'aboard' : (window.__sandboxWalk.noclip ? 'floating' : 'on foot')
      return 'ship ' + [p.x, p.y, p.z].map((n) => n.toFixed(0)).join(', ') + ' (' + (p.y - g).toFixed(0) + ' up, heading ' + v.yaw.toFixed(2) + ')  me ' + me +
        ' at ' + [c.x, c.y, c.z].map((n) => n.toFixed(0)).join(', ')
    })()`)
    const frame = async (label, wait = 0) => {
      await sleep(wait)
      const f = join(dir, `${String(labels.length).padStart(2, '0')}.png`)
      writeFileSync(f, await probe.screenshot(W, H))
      labels.push(label)
      console.log(`  ${label.padEnd(30)} ${await state()}`)
    }
    const hold = (code, on) => evaluate(`(() => { const k = window.__input.keys; ${on ? `k.add('${code}')` : `k.delete('${code}')`}; return true })()`)
    const mouse = (dx, dy) => evaluate(`window.__fleet.turn(${dx}, ${dy}, 1, 1)`)
    await tap('KeyE', 150)
    await sleep(1500)
    if (!(await evaluate('!!window.__fleet.riding'))) console.log('  E did not board it  <-- WRONG')
    await hold('Space', true)
    await sleep(1600)
    await hold('Space', false)
    await frame('lifted off, holding', 800)
    await hold('KeyW', true)
    for (let i = 0; i < 12; i++) {
      await mouse(-60, 0)
      await sleep(80)
    }
    await frame('mouse left, W: it turns in', 300)
    for (let i = 0; i < 24; i++) {
      await mouse(60, 0)
      await sleep(80)
    }
    await frame('mouse right: and back', 300)
    // up and out: the aim pitched high, boost
    for (let i = 0; i < 10; i++) await mouse(0, 50)
    await hold('ShiftLeft', true)
    for (let i = 0; i < 60; i++) {
      const up = await evaluate(`(() => { const p = window.__fleet.riding.root.position; return p.y - window.__levels.current.groundYAt(p.x, p.z) })()`)
      if (up > 14000) break
      await sleep(500)
    }
    await frame('climbed out of the air', 200)
    for (const k of ['KeyW', 'ShiftLeft', 'Space']) await hold(k, false)
    // hands off for ten seconds: it must hold station, not circle
    await sleep(2000)
    const a = await evaluate('window.__fleet.riding.root.position.toArray()')
    await sleep(10000)
    const b = await evaluate('window.__fleet.riding.root.position.toArray()')
    const drift = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    console.log(`  hands off for 10 s in orbit: moved ${drift.toFixed(1)} units${drift > 20 ? '  <-- WRONG' : ''}`)
    await frame('hands off: holding station', 0)
    await tap('KeyE', 150)
    await sleep(1200)
    const out = await evaluate('!window.__fleet.riding')
    console.log(`  E in orbit: ${out ? 'out, floating' : 'still aboard  <-- WRONG'}`)
    await frame('E: ejected, floating', 300)
    const said = await run('unstuck')
    console.log(`  > unstuck: ${said.join(' / ')}`)
    await sleep(3500)
    await look(0.94, -0.1)
    await frame('unstuck: on the path at home', 800)
    const home = await evaluate(`(() => { const c = window.__sandboxCamera.position; return [c.x, c.z, window.__sandboxWalk.noclip, window.__levels.current.id] })()`)
    const ok = Math.hypot(home[0] - 5.5, home[1] + 2.6) < 4 && !home[2]
    console.log(`  home: ${ok ? 'yes' : 'no  <-- WRONG'} (${home.join(', ')})`)
    const cols = 4
    const esc = (t) => t.replace(/[:\\']/g, (c) => `\\${c}`)
    const inputs = labels.flatMap((_, i) => ['-i', join(dir, `${String(i).padStart(2, '0')}.png`)])
    const scaled = labels.map((l, i) =>
      `[${i}:v]scale=640:400,drawbox=x=0:y=370:w=640:h=30:color=black@0.55:t=fill,drawtext=text='${esc(`${i + 1}. ${l}`)}':x=10:y=378:fontsize=15:fontcolor=white[v${i}]`)
    const layout = labels.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 400}`).join('|')
    const graph = `${scaled.join(';')};${labels.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${labels.length}:layout=${layout}`
    const outFile = join(OUT, 'shipfly.png')
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-frames:v', '1', outFile])
    if (r.status !== 0) console.error(String(r.stderr))
    else console.log(`  wrote ${outFile}`)
    rmSync(dir, { recursive: true, force: true })
  }

  if (WHAT.includes('order')) {
    /*
      The catalogue's Vehicles section, and an order from it: the book opened
      at the section, then the car ordered at the crosshair on the street in
      front of you, and the view of it delivered.
    */
    console.log('order')
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await run('time 11:00')
    await goTo('30 -14')
    await sleep(2000)
    await stand()
    await look(Math.PI / 2, -0.25)
    await tap('KeyQ')
    await sleep(400)
    await waitFor(() => evaluate(`document.querySelectorAll('[data-kind] img').length > 4`), 60, 250, 'the catalogue icons')
    const tab = await evaluate(`(() => { const el = document.querySelector('[data-category="vehicles"]'); if (!el) return false; el.click(); return true })()`)
    if (!tab) console.log('  no vehicles section  <-- WRONG')
    await sleep(900)
    await shot('order-catalogue')
    const before = await evaluate(`window.__fleet.all.find((v) => v.id === 'car').root.position.toArray()`)
    await evaluate(`(() => { const el = document.querySelector('[data-kind="fleet:car"]'); el && el.click(); return !!el })()`)
    await sleep(500)
    await tap('Escape')
    await sleep(1200)
    const after = await evaluate(`window.__fleet.all.find((v) => v.id === 'car').root.position.toArray()`)
    const c = await evaluate('window.__sandboxCamera.position.toArray()')
    console.log(`  car from ${before.map((n) => n.toFixed(0)).join(', ')} to ${after.map((n) => n.toFixed(0)).join(', ')}, ${Math.hypot(after[0] - c[0], after[2] - c[2]).toFixed(1)} from you`)
    await shot('order-car-delivered')
  }

  if (WHAT.includes('contraption')) {
    /*
      Contraptions in the real game: the catalogue open on its parts tab, the
      tool gun out welding a thruster onto a plate (the first click taken,
      its halo on the thruster), a car built from parts (build.ts, the tool
      gun's own placing and joining) sat in with E and driven with W and
      space, and a rocket lifting off on i. Every shader link from the first
      part spawned on is counted (must be 0). Four shots to
      ~/.cache/overhaul/contraptions (--parts-out <dir>).
    */
    console.log('contraption')
    const PARTS_OUT = resolve(flag('parts-out', join(process.env.HOME ?? '.', '.cache/overhaul/contraptions')))
    mkdirSync(PARTS_OUT, { recursive: true })
    const partShot = async (name) => {
      const path = join(PARTS_OUT, `${name}.png`)
      writeFileSync(path, await probe.screenshot(W, H))
      console.log(`  wrote ${path}`)
    }
    await evaluate(`(() => { window.__cLinks = []; for (const c of document.querySelectorAll('canvas')) {
      const gl = c.width && c.getContext('webgl2'); if (!gl || gl.__cWrapped) continue; gl.__cWrapped = true
      const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => { window.__cLinks.push(window.__cPhase || '?'); real(p) } } return true })()`)
    const phase = (name) => evaluate(`window.__cPhase = ${JSON.stringify(name)}; true`)
    const hold = (code, on) => evaluate(`(() => { const k = window.__input.keys; ${on ? `k.add('${code}')` : `k.delete('${code}')`}; return true })()`)
    const aimAt = async (x, y, z) => {
      await evaluate(`(() => { const c = window.__sandboxCamera.position, w = window.__sandboxWalk
        const dx = ${x} - c.x, dy = ${y} - c.y, dz = ${z} - c.z
        w.yaw = Math.atan2(-dx, -dz); w.pitch = Math.atan2(dy, Math.hypot(dx, dz)); return true })()`)
      await sleep(350)
    }
    const posOf = (id) => evaluate(`(() => { const p = window.__sandbox.get(${id}); if (!p) return null
      const t = p.body.translation(); return [t.x, t.y, t.z] })()`)
    await stand()
    await look(0.6, -0.2)
    // 1. the catalogue, open on the parts
    await phase('catalogue')
    await tap('KeyQ')
    await sleep(300)
    await waitFor(() => evaluate(`document.querySelectorAll('[data-kind] img').length > 4`), 60, 250, 'the catalogue icons')
    await clickOn('[data-category="parts"]')
    await sleep(400)
    await hover('[data-kind="thruster"]')
    await sleep(200)
    console.log(`  parts tab: ${await evaluate(`[...document.querySelectorAll('[data-kind]')].map((e) => e.dataset.kind).join(' ')`)}`)
    await partShot('menu-parts')
    await tap('Escape')
    await sleep(600)
    // 2. the tool gun: a plate and a thruster set down ahead, the thruster
    // clicked (the halo), then the plate's end: welded on, nozzle out
    await phase('tool gun')
    const yaw = await evaluate('window.__sandboxWalk.yaw')
    const ahead = `const sb = window.__sandbox, c = window.__sandboxCamera.position, y = ${yaw};
      const fx = -Math.sin(y), fz = -Math.cos(y);
      const put = (k, d, s, o) => { const x = c.x + fx * d - fz * s, z = c.z + fz * d + fx * s; return sb.spawn(k, { x, y: sb.restY(k, x, z) + 0.1, z }, { yaw: y, ...o }) };`
    const [plate, thr] = await evaluate(`(() => { ${ahead} return [put('plate_m', 9, 0, { frozen: true }), put('thruster', 7, -4)] })()`)
    await sleep(1200)
    await evaluate('window.__tools.select(2)')
    await sleep(500)
    let p = await posOf(thr)
    await aimAt(p[0], p[1], p[2])
    await hold('Mouse0', true)
    await sleep(150)
    await hold('Mouse0', false)
    await sleep(250)
    p = await posOf(plate)
    // the plate's near edge, on its top face: the thruster goes on standing up
    await aimAt(p[0] + Math.sin(yaw) * 1.2, p[1] + 0.1, p[2] + Math.cos(yaw) * 1.2)
    console.log(`  tool gun: ${await evaluate('window.__tools.toolgun.state')}, first pick ${await evaluate('window.__tools.toolgun.pending')}`)
    await partShot('toolgun')
    await hold('Mouse0', true)
    await sleep(150)
    await hold('Mouse0', false)
    await sleep(500)
    console.log(`  after the second click: ${await evaluate('window.__tools.contraption.stats.constraints')} constraint(s), ` +
      `thruster at ${(await posOf(thr)).map((n) => n.toFixed(1)).join(', ')}`)
    // 3. a car, built by script, sat in and driven
    await phase('car')
    await evaluate('window.__tools.select(0)')
    const car = await evaluate(`(async () => { ${ahead} const m = await window.__contraptionBuild()
      const x = c.x + fx * 14 + fz * 8, z = c.z + fz * 14 - fx * 8
      const b = m.buildCar(sb, { x, y: 0, z }, y); return b })()`)
    await sleep(1500)
    p = await posOf(car.seat)
    // walk up beside the seat so it is in reach, and look at it
    await run(`tp ${(p[0] + Math.cos(yaw) * 3.5).toFixed(2)} ${(p[2] - Math.sin(yaw) * 3.5).toFixed(2)}`)
    await sleep(900)
    await aimAt(p[0], p[1] + 0.3, p[2])
    await sleep(400)
    await tap('KeyE')
    await sleep(600)
    const seated = await evaluate(`/wasd drive|wasd conducir|stand up/.test(document.body.innerText)`)
    console.log(`  E on the seat: ${seated ? 'sitting in it' : 'NOT SEATED  <-- WRONG'}`)
    const eyeUp = await evaluate(`(() => { const c = window.__sandboxCamera.position; return c.y - window.__sandbox.groundY(c.x, c.z) })()`)
    console.log(`  the seated eye is ${eyeUp.toFixed(2)} u over the ground`)
    const start = await posOf(car.chassis)
    await hold('KeyW', true)
    await sleep(2200)
    await hold('Space', true)
    await sleep(900)
    await evaluate('window.__sandboxWalk.pitch = -0.05')
    await sleep(100)
    await partShot('drive')
    await hold('Space', false)
    await sleep(600)
    await hold('KeyW', false)
    const end = await posOf(car.chassis)
    console.log(`  drove ${Math.hypot(end[0] - start[0], end[2] - start[2]).toFixed(1)} u from the seat`)
    await sleep(1200)
    await tap('KeyE')
    await sleep(600)
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    // 4. a rocket, lifting off on its thrusters' own key
    await phase('rocket')
    await stand()
    const y2 = await evaluate('window.__sandboxWalk.yaw')
    const rocket = await evaluate(`(async () => { const sb = window.__sandbox, c = window.__sandboxCamera.position
      const m = await window.__contraptionBuild()
      const x = c.x - Math.sin(${y2}) * 26, z = c.z - Math.cos(${y2}) * 26
      return m.buildRocket(sb, { x, y: 0, z }) })()`)
    await sleep(1000)
    await evaluate(`window.__sandbox.unfreeze(${rocket.chassis})`)
    p = await posOf(rocket.chassis)
    await aimAt(p[0], p[1] + 6, p[2])
    await hold('KeyI', true)
    await sleep(1700)
    p = await posOf(rocket.chassis)
    await aimAt(p[0], p[1] + 2, p[2])
    await partShot('rocket')
    await sleep(800)
    await hold('KeyI', false)
    p = await posOf(rocket.chassis)
    console.log(`  rocket ${(p[1] - (await evaluate(`window.__sandbox.groundY(${p[0]}, ${p[2]})`))).toFixed(0)} u up after 2.5 s on i`)
    const links = await evaluate('window.__cLinks')
    console.log(`  ${links.length} programs linked from the catalogue to the rocket${links.length ? ': ' + links.join(', ') : ''}`)
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
