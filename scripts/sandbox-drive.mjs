#!/usr/bin/env node
/*
  Photograph the sandbox's own interface over the live game.

    npm run drive -- console          the receipt printer, open, mid-completion
    npm run drive -- menu             the catalogue opened with q, a plate ringed
    npm run drive -- noclip           a noclip flight: a first-person strip and a
                                      third-person strip of the float pose
    npm run drive -- links            shader links counted in the real game across
                                      a first spawn, a change of look (the
                                      beaver, a cap, the headset), a break, a
                                      fuse and a chain
                                      of bangs, and trips to Nuketown and
                                      Cubeland and back (loaded under the
                                      cut's card, looked round, blown up
                                      there) (must be 0; Cubeland's own
                                      programs, made under its card, are
                                      counted apart)
    npm run drive -- nuketown [--only a,b]
                                      the Nuketown map from its references'
                                      angles: both spawn ends, the loading
                                      screen's view down the street, each
                                      living room, the yellow house's front
                                      window and straight down from noclip
                                      (shots nuketown-*.png)
    npm run drive -- mapcards         the map sheet's pictures, each map with the
                                      HUD hidden (shots mapcard-*.png; see
                                      public/os/maps/README.md). Any run with
                                      --picker also shoots the sheet itself,
                                      which every walk now starts on
    npm run drive -- cubeland [--only a,b]
                                      Cubeland: the spawn from four headings
                                      and the air, a block broken and a tower
                                      placed, a blast, the physgun tearing a
                                      block out, a walk and a hop; links after
                                      arrival counted (must be 0)
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
    (private rooms have their own three-client harness: node scripts/rooms-drive.mjs)
    npm run drive -- perf             frame cost (cpu, gpu, draw calls,
                                      triangles) in the computer room, at
                                      the front gate by day and night, and
                                      downtown
    npm run drive -- rubble [--power 10] [--building x,z] [--tag t]
                                      a downtown mid-rise blown up from the
                                      middle of a face with /explode: frame
                                      cost, rubble bodies and links over the
                                      collapse, and a shot of the aftermath
                                      to ~/.cache/overhaul/lighter-rubble
                                      (--rubble-out <dir>)
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
    npm run drive -- viewmodel        the guns in hand: the tool gun's screen
                                      in two modes, the physgun's mitten, the
                                      tool gun from the chase camera, and the
                                      gun's frame-to-frame turn in the lens
                                      standing and walking; links counted
                                      (must be 0). Shots to ~/.cache/overhaul/
                                      viewmodel (--vm-out <dir>)
    npm run drive -- weapons          the weapons in hand: the pistol, the
                                      crossbow and the rocket launcher in
                                      first person, the launcher from the
                                      chase camera, a rocket in flight and a
                                      bolt stuck in the ground; links counted
                                      (must be 0). Shots to ~/.cache/overhaul/
                                      weapons (--weapons-out <dir>)
    npm run drive -- pause            the pause sheet on a town street: the
                                      wardrobe's snapshots, one hovered and
                                      tried on, and the settings page's
                                      pixel prints; links on the game's
                                      context counted (must be 0)
    npm run drive -- emotes           the emote wheel put up with b, every
                                      emote at its peak from the front and
                                      the side on the bean and on a chubby
                                      beaver in a cap and headset (contact
                                      sheets), and the point key aimed at a
                                      crate; links counted (must be 0).
                                      Shots to ~/.cache/overhaul/emotes
                                      (--emote-out)
    npm run drive -- health           hit points offline: /health, /hurt, /heal, /pvp
                                      and /kill answer what they must with no
                                      server, the bar and the death sheet stay
                                      away, and the hurt/died/respawn events
                                      driven by hand put up the bar, the
                                      killfeed and the sheet (shots health-*).
                                      The two-client drive is
                                      scripts/health-drive.mjs
    npm run drive -- rounds           the round's screens with no server: the store fed
                                      by hand, a shot of each game's HUD (countdown,
                                      deathmatch and its scoreboard, the seeker's
                                      blindfold, a disguised prop, the race, the
                                      build gallery) and the results sheet (shots
                                      rounds-*). The two-client drive over a real
                                      relay is scripts/rounds-drive.mjs
    npm run drive -- portal           the portal gun: taken from the catalogue's
                                      tools tab, a blue and an orange portal
                                      opened on two walls downtown and each
                                      looked through, the frame cost with a
                                      portal on screen (against the same view
                                      with its partner closed), a walk through,
                                      a fall into a floor portal flung out of
                                      the wall one (velocity in and out
                                      printed), a crate through the same pair;
                                      links counted from the catalogue on
                                      (must be 0). Shots to
                                      ~/.cache/overhaul/portal (--portal-out)
    npm run drive -- portalmoon       the Moon by portal, at night: blue on a
                                      wall downtown, orange fired at the Moon
                                      in the sky, the Moon looked at through
                                      blue (and its cost), walked through to
                                      the Moon, home looked at through the
                                      slab, and walked back; links counted
                                      (must be 0). Shots moon-* beside the
                                      portal ones
    npm run drive -- throw [--vehicle car,heli] [--at x,z]
                                      every machine taken as a prop and thrown
                                      at the ground at 20 to 900 u/s: must
                                      never go a unit under it or be rescued
    npm run drive -- moonfleet        the fleet on the Moon: the car ordered,
                                      driven over the craters (never under
                                      the ground), shot with the Earth in the
                                      sky, thrown on the physgun; the heli
                                      and the boat ordered; home, where the
                                      car is gone until ordered; links
                                      counted (must be 0)
    npm run drive -- roofs          flat and pitched roofs at home and
                                      downtown landed on from noclip, dropped
                                      and let go inside the building: the feet
                                      must end on the roof (shots roofs-*.png)
    npm run drive -- flycam           a third-person noclip flight, the body's
                                      height against the lens every frame:
                                      must never jump 0.1 in a frame
    npm run drive -- portalhouse      portals on a room door (swung with the
                                      portal riding it), the bed's mattress,
                                      the lawn (grass before and after its
                                      hole), and a catalogue portal panel
                                      carried on the physgun; shots house-*,
                                      grass-*, panel-* beside the others
    npm run drive -- portalgrab       the physgun through a portal pair (two
                                      panels face to face): a crate taken,
                                      swung and thrown through it, then your
                                      own body taken and pulled about and let
                                      go; positions and speeds printed (no NaN,
                                      capped). Shots grab-* beside the others
    npm run drive -- protection       ownership and anti-grief with two real clients
                                      on a private relay (scripts/protection-drive.mjs):
                                      a stranger's physgun denied (buzz, toast),
                                      a friend's allowed, unfriended, /share;
                                      in Cubeland a claim declines a stranger's
                                      dig, and with the client's guard lifted
                                      the server refuses it and the correction
                                      puts the block back; links counted (0).
                                      Shots protection-* (--out)
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
const VALUED = new Set(['--only', '--rubble-out', '--power', '--building', '--back', '--tag', '--emote-out', '--portal-out', '--parts-out', '--vm-out', '--out', '--at', '--fly-at', '--fly-yaw', '--yaw', '--frames', '--lang', '--cap', '--spots', '--vehicle'])
const wanted = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]))
if (has('help') || argv.includes('-h')) {
  // the header above is the help; print it rather than booting anything
  const src = (await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8')
  console.log(src.slice(src.indexOf('/*') + 2, src.indexOf('*/')).replace(/^\n/, ''))
  process.exit(0)
}
const WHAT = wanted.length ? wanted : ['console', 'menu', 'noclip']
// the ownership scenario needs a relay and two browsers of its own, so it
// runs as its own script before this one boots a single-client probe
if (WHAT.includes('protection')) {
  await import('./protection-drive.mjs')
  process.exit(0)
}
const OUT = resolve(flag('out', 'shots/sandbox'))
const W = 1280
const H = 800
const lang = flag('lang', 'en')
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// headless reports a coarse pointer and reduced motion, and either one boots
// the flat bezel instead of the 3D scene (see AlejOS.tsx's `fancy`)
const shim = `(() => {
  // Observe Escape before the game's capture handler consumes it on resume.
  window.addEventListener('keydown', (e) => {
    const S = window.__pauseFrames
    if (e.code === 'Escape' && S?.awaitingResume) {
      S.resumeAt = performance.now()
      S.awaitingResume = false
    }
  }, true)
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
  KeyG: ['g', 71], KeyF: ['f', 70], KeyB: ['b', 66],
  Digit1: ['1', 49], Digit2: ['2', 50], Digit3: ['3', 51], Digit4: ['4', 52], Digit5: ['5', 53],
  Digit6: ['6', 54], Digit7: ['7', 55], Digit8: ['8', 56], Digit9: ['9', 57],
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
  // a walk starts on the map sheet (MapPicker.tsx), with the world held
  // still: stay home (a scenario that wants another map goes there itself)
  await waitFor(
    () => evaluate(`!!window.__sandbox?.run && !!window.__sandboxWalk && !!window.__pickMap &&
      /where to|a dónde/i.test(document.body.innerText)`),
    360, 500, 'the walk, the sandbox and the map sheet',
  )
  if (has('picker')) await shot('map-picker')
  await evaluate('window.__pickMap("home"); true')
  await waitFor(() => evaluate('/wasd/.test(document.body.innerText)'), 60, 250, 'the walk')
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
  // the frame instrumentation perf and rubble share: rAF timed on the CPU
  // (and the GPU where the timer query exists), draws, triangles, program
  // switches, uploads and stalls counted off the context's own entry points
  const instrument = async () => {
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
  }
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
  const perf = async () => {
    console.log('perf')
    await instrument()
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
  /*
    A downtown building blown up from the middle of one face, timed in the
    real renderer: the console's `/explode <power>` aimed at the mid-height of
    the face toward the camera, then the frame cost over the collapse in
    windows (0-2, 2-5, 5-10, 10-15 s), with the rubble's bodies (alive and
    awake), how many the building was cut into, and the shader links over
    the whole collapse (must be 0). One shot of the aftermath at +15 s.
  */
  const rubble = async () => {
    console.log('rubble')
    const power = Number(flag('power', 10))
    const [bx, bz] = flag('building', '-137,-306').split(',').map(Number)
    const back = Number(flag('back', 55))
    const R_OUT = resolve(flag('rubble-out', join(process.env.HOME ?? '.', '.cache/overhaul/lighter-rubble')))
    mkdirSync(R_OUT, { recursive: true })
    await run('time 12:00')
    await goTo(`${bx - back} ${bz}`)
    await sleep(20000)
    await stand()
    await look(-Math.PI / 2, 0.1)
    await sleep(1500)
    await instrument()
    await evaluate(`(() => {
      window.__rLinks = 0
      for (const c of document.querySelectorAll('canvas')) {
        if (!c.width || c.__rLinkWrapped) continue
        const gl = c.getContext('webgl2')
        if (!gl) continue
        c.__rLinkWrapped = true
        const real = gl.linkProgram.bind(gl)
        gl.linkProgram = (p) => { window.__rLinks++; real(p) }
      }
      return true
    })()`)
    const state = () => evaluate(`(async () => {
      const m = await import('/src/game/sandbox/destruction.ts')
      const d = m.destructionOf(window.__sandbox)
      let n = 0, awake = 0, meshes = 0
      window.__sandbox.forEach((p) => {
        if (!p.data.rubble) return
        n++
        if (p.mode === 'dynamic' && !p.body.isSleeping()) awake++
        p.mesh?.traverse((o) => { if (o.isMesh && o.visible) meshes++ })
      })
      let pieces = 0, lifted = 0, opened = 0
      for (const st of d.ruins.near(${bx}, 0, ${bz}, 200)) {
        if (!st.open) continue
        opened++
        pieces += st.open.frac.pieces.length
        for (let i = 0; i < st.open.alive.length; i++) if (!st.open.alive[i]) lifted++
      }
      return { n, awake, meshes, pieces, lifted, opened, links: window.__rLinks }
    })()`)
    await measure('standing, before', 3)
    // the crosshair on the middle of the face toward us
    const aimed = await evaluate(`(async () => {
      const m = await import('/src/game/sandbox/destruction.ts')
      const d = m.destructionOf(window.__sandbox)
      const cam = window.__sandboxCamera.position
      const s = d.nearest({ x: ${bx}, y: cam.y, z: ${bz} }, 40)
      if (!s) return null
      const b = s.box
      const tx = b.min.x, ty = (s.rec.baseY + b.max.y) / 2, tz = (b.min.z + b.max.z) / 2
      const w = window.__sandboxWalk
      w.yaw = Math.atan2(-(tx - cam.x), -(tz - cam.z))
      w.pitch = Math.atan2(ty - cam.y, Math.hypot(tx - cam.x, tz - cam.z))
      return s.rec.id + ' ' + s.rec.kind
    })()`)
    console.log(`  aimed at ${aimed}`)
    await sleep(400)
    console.log(`  > explode ${power}: ${(await run(`explode ${power}`)).join(' / ')}`)
    await evaluate('window.__sandboxWalk.pitch = 0.1; true')
    const say = (label, st) => console.log(`  ${''.padEnd(26)} ${label}: ${st.n} rubble bodies (${st.awake} awake, ` +
      `${st.meshes} meshes); ${st.opened} building(s) opened, ${st.pieces} pieces, ${st.lifted} lifted; ${st.links} links`)
    for (const [a, b2] of [[0, 2], [2, 5], [5, 10], [10, 15]]) {
      await measure(`collapse ${a}-${b2} s`, b2 - a)
      say(`at ${b2} s`, await state())
    }
    const tag = flag('tag', 'now')
    const png = await probe.screenshot(W, H)
    const path = join(R_OUT, `rubble-${tag}.png`)
    writeFileSync(path, png)
    console.log(`  wrote ${path}`)
  }
  if (WHAT.includes('perf')) await perf()
  if (WHAT.includes('rubble')) await rubble()
  if (WHAT.some((w) => w !== 'perf' && w !== 'rubble')) {
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

  if (WHAT.includes('health')) {
    console.log('health')
    await look(null, -0.1)
    for (const l of ['health', 'hurt 20', 'heal', 'pvp on', 'kill']) {
      console.log(`  > ${l}: ${(await run(l)).join(' / ')}`)
      await sleep(200)
    }
    // the store, fed the server's own messages by hand
    await evaluate(`(() => { const h = window.__health, lv = window.__levels.current.id
      h.receive({ type: 'world-welcome', you: 1, tick: 66, slot: 0, players: [] })
      h.receive({ type: 'world-pvp', level: lv, on: true, by: 0 })
      h.receive({ type: 'world-hp', level: lv, rows: [[1, 42, 100, 0]] })
      h.receive({ type: 'world-death', level: lv, id: 7, by: 1, kind: 'rocket', sc: [[7, 0, 1, 0], [1, 1, 0, 1]] })
      h.receive({ type: 'world-death', level: lv, id: 1, by: 0, kind: 'lava', sc: [[1, 1, 1, 1]] })
      return true })()`)
    await sleep(600)
    await shot('health-down')
    await evaluate(`(() => { const h = window.__health, lv = window.__levels.current.id
      h.receive({ type: 'world-respawn', level: lv, id: 1 })
      h.receive({ type: 'world-hp', level: lv, rows: [[1, 100, 100, 2]] }); return true })()`)
    await sleep(600)
    await shot('health-back')
    await evaluate('window.__health.offline()')
  }

  if (WHAT.includes('rounds')) {
    // the round's screens with no server: the store fed the server's own
    // messages by hand, one state per game, and a shot of each HUD. The
    // two-client drive (real rounds over a real relay) is scripts/rounds-drive.mjs
    console.log('rounds')
    await look(null, -0.1)
    const feed = (msgs) => evaluate(`(() => { const r = window.__rounds.state; for (const m of ${JSON.stringify(msgs)}) r.receive(m); return true })()`)
    const st = (ph, mode, extra = {}) => ({
      type: 'world-round', v: 1, ph, mode, lv: 'nuketown', now: Date.now(), end: Date.now() + 60_000, host: 1,
      rd: [1, 2], p: [], obj: {}, ...extra,
    })
    await feed([{ type: 'world-welcome', you: 1, tick: 66, slot: 0, players: [{ id: 2, name: 'Ada' }, { id: 3, name: 'Bo' }] }])
    // deathmatch: the countdown, then play with a score line and the board held
    await feed([st('countdown', 'deathmatch', { end: Date.now() + 3200, p: [[1, 'a', '', 0, 0, 0, 0], [2, 'b', '', 0, 0, 0, 0], [3, 'b', '', 0, 0, 0, 0]] })])
    await sleep(500)
    await shot('rounds-countdown')
    await feed([st('playing', 'deathmatch', { end: Date.now() + 251_000, obj: { limit: 40, teams: true }, p: [[1, 'a', '', 7, 7, 3, 0], [2, 'b', '', 9, 9, 6, 0], [3, 'b', '', 4, 4, 5, 0]] })])
    await sleep(700)
    await shot('rounds-deathmatch')
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' })); true`)
    await sleep(400)
    await shot('rounds-scoreboard')
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' })); true`)
    // hide and seek: the seeker's blindfold, then a hider's view
    const seekAt = Date.now() + 20_000
    await feed([st('playing', 'hide', { end: Date.now() + 260_000, obj: { seekAt }, p: [[1, 'b', 'seeker', 0, 0, 0, 0], [2, 'a', 'hider', 0, 0, 0, 0], [3, 'a', 'hider', 0, 0, 0, 0]] })])
    await sleep(600)
    await shot('rounds-hide-seeker-blind')
    await feed([st('playing', 'hide', { end: Date.now() + 260_000, obj: { seekAt }, p: [[1, 'a', 'hider', 0, 0, 0, 0], [2, 'b', 'seeker', 0, 0, 0, 0], [3, 'a', 'hider', 0, 0, 0, 0]] })])
    await sleep(600)
    await shot('rounds-hide-hider')
    // prop hunt: a prop with a disguise on
    await feed([st('playing', 'prophunt', { end: Date.now() + 260_000, obj: { seekAt: Date.now() - 1000, decoys: 60 }, p: [[1, 'a', 'prop', 0, 0, 0, 0], [2, 'b', 'hunter', 3, 1, 0, 0], [3, 'a', 'prop', 0, 0, 0, 0]], dg: [[1, 'barrel']] })])
    await sleep(600)
    await shot('rounds-prophunt-prop')
    console.log('  race', await evaluate('window.__renderer.info.programs.length'))
    // the race on foot, and the gallery of the build contest
    await feed([st('playing', 'race', { lv: 'cubeland', end: Date.now() + 400_000, obj: { cps: [[10, 10, 8], [60, 10, 8], [60, 60, 8]], laps: 2, foot: 1, goAt: Date.now() - 2000, grid: [0, 0, 0] }, p: [[1, '', '', 0, 4, 0, 0], [2, '', '', 0, 6, 0, 0], [3, '', '', 0, 1, 0, 0]] })])
    console.log('  fed', await evaluate('window.__renderer.info.programs.length'))
    await sleep(600)
    console.log('  slept', await evaluate('window.__renderer.info.programs.length'))
    await shot('rounds-race')
    await feed([st('playing', 'build', { lv: 'cubeland', end: Date.now() + 100_000, obj: { theme: 3, stage: 'gallery', buildEndAt: Date.now() - 1000, plots: [[1, 0, 0], [2, 2, 0]], gal: { plot: 2, i: 1, n: 2, endAt: Date.now() + 14_000 } }, p: [[1, '', '', 0, 0, 0, 0], [2, '', '', 0, 0, 0, 0]] })])
    await sleep(600)
    await shot('rounds-build-gallery')
    // results: a team won
    await feed([st('results', 'deathmatch', { end: Date.now() + 9000, obj: { limit: 40, teams: true }, p: [[1, 'a', '', 7, 7, 3, 0], [2, 'b', '', 9, 9, 6, 0], [3, 'b', '', 4, 4, 5, 0]], res: { win: [2, 3], team: 'b', why: 'limit', rows: [[2, 'b', 9, 9, 6], [1, 'a', 7, 7, 3], [3, 'b', 4, 4, 5]] } })])
    await sleep(700)
    await shot('rounds-results')
    console.log(`  ${(await run('round')).join(' / ')}`)
    await evaluate('window.__rounds.state.offline()')
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
    // a change of look is a palette and a geometry swap, never a program:
    // the beaver, a cap and the headset put on in the chase view, where the
    // body is drawn whole
    await evaluate('window.__sandbox.console.host.thirdPerson(true)')
    await sleep(800)
    total += await phase('a new look (beaver, cap, headset)', `window.__sandboxRig.setLook({ shell: '#2f6fcf',
      trim: '#f2eee0', accent: '#2860c8', glow: '#1c1a20', hat: 1, costume: 5, build: 0, fur: 1, phones: 1 })`, 2500)
    await shot('links-look')
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    total += await phase('a crate broken (boards, dust)', `window.__sandbox.shatter(window.__ids[3])`, 1500)
    total += await phase('a fuse lit (sputter, burn fx)', `window.__sandbox.ignite(window.__ids[8])`, 1200)
    total += await phase('the chain (flash, jets, fire, smoke)', `window.__sandbox.damage(window.__ids[0], 1000)`, 600)
    await shot('links-chain')
    total += await phase('the chain, later bangs', '', 4400)
    total += await phase('after the dust settles', '', 3000)
    // the weapons: each drawn and fired once (a pistol round, a bolt, a
    // rocket down the street), on the programs the belt staged at boot
    const fireAt = (ms, slot) => `setTimeout(() => window.__tools.select(${slot}), ${ms});
      setTimeout(() => window.__input.keys.add('Mouse0'), ${ms + 700});
      setTimeout(() => window.__input.keys.delete('Mouse0'), ${ms + 900});`
    total += await phase('weapons drawn and fired', `${fireAt(0, 4)} ${fireAt(1300, 5)} ${fireAt(2600, 6)}
      setTimeout(() => window.__tools.select(0), 6500)`, 7000)
    // a map and back (levels/maps.ts): the module loads, builds and warms
    // under the cut's card, so the whole trip must link nothing
    total += await phase('map nuketown (loaded under the card)', `window.__sandbox.run('map nuketown')`, 7000)
    total += await phase('nuketown, looking round', `(() => { const w = window.__sandboxWalk; let k = 0;
      const id = setInterval(() => { w.yaw += 0.45; if (++k > 14) clearInterval(id) }, 140) })()`, 3000)
    total += await phase('nuketown, a crate and a barrel blown up', `{ ${ahead}
      const b = put('barrel_explosive', 12, 0); put('crate', 14, 2);
      setTimeout(() => window.__sandbox.damage(b, 1000), 400) }`, 3000)
    await shot('links-nuketown')
    // and Cubeland: its terrain is two programs of its own (the blocks and
    // the water) plus the outline and the block in hand, all paid under the
    // card; digging, placing, a blast and its loose blocks link nothing
    // (its own programs are made under the card, by design: counted apart)
    const underCard = await phase('map cubeland (loaded under the card)', `window.__sandbox.run('map cubeland')`, 11000)
    total += await phase('cubeland, looking round', `(() => { const w = window.__sandboxWalk; let k = 0;
      const id = setInterval(() => { w.yaw += 0.45; if (++k > 14) clearInterval(id) }, 140) })()`, 3000)
    total += await phase('cubeland, dug, built and blown up', `(() => {
      const L = window.__cubeland.level, cam = window.__sandboxCamera, w = window.__sandboxWalk
      w.pitch = -0.7
      setTimeout(() => {
        const f = { camera: cam, feetY: w.feetY, fire: false, alt: false, wheel: 0, dt: 0.016, active: true, firstPerson: true }
        L.hands.update(f); L.hands.update({ ...f, fire: true }); L.hands.update(f); L.hands.update({ ...f, alt: true })
        const p = cam.position; window.__sandbox.explode({ x: p.x, y: w.feetY - 1, z: p.z - 16 }, 1, 14)
      }, 500) })()`, 4000)
    await shot('links-cubeland')
    total += await phase('map home', `window.__sandbox.run('map home')`, 4000)
    total += await phase('home again, looking round', `(() => { const w = window.__sandboxWalk; let k = 0;
      const id = setInterval(() => { w.yaw += 0.45; if (++k > 14) clearInterval(id) }, 140) })()`, 3000)
    const names = await evaluate('window.__links')
    for (const n of names) console.log(`    linked ${n}`)
    const seen = await evaluate('[window.__wrapped, window.__booms, window.__breaks]')
    console.log(`  ${underCard} of Cubeland's own programs linked under its loading card (its terrain, water, outline, block in hand)`)
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

  if (WHAT.includes('emotes')) {
    /*
      The wheel is put up with a real b (it is a toggle) and its cursor set
      through `__emoteAim` (headless Chrome never gets the pointer lock that
      would carry the mouse to it); emotes are played with the number keys,
      one with a click. Each is photographed at its peak from the front and
      from the side, on the default bean and on the chubby build in the
      beaver, a cap and the headset (the widest things worn near a face), as
      two contact sheets per look (--emote-out, default
      ~/.cache/overhaul/emotes). The point key is a real f, aimed at a crate.
    */
    console.log('emotes')
    const EMOTE_OUT = resolve(flag('emote-out', join(process.env.HOME ?? '.', '.cache/overhaul/emotes')))
    mkdirSync(EMOTE_OUT, { recursive: true })
    const eshot = async (name) => {
      const path = join(EMOTE_OUT, `${name}.png`)
      writeFileSync(path, await probe.screenshot(W, H))
      console.log(`  wrote ${path}`)
      return path
    }
    await goTo(flag('at', '5654 -844').replace(',', ' '))
    await sleep(1500)
    await stand()
    await evaluate('window.__sandbox.console.host.thirdPerson(true)')
    const yaw0 = Number(flag('yaw', 0.6))
    await look(yaw0, -0.12)
    await sleep(1200)
    await evaluate(`(() => {
      window.__links = []
      for (const c of document.querySelectorAll('canvas')) {
        if (!c.width || c.__linkWrapped) continue
        const gl = c.getContext('webgl2')
        if (!gl) continue
        c.__linkWrapped = true
        const real = gl.linkProgram.bind(gl)
        gl.linkProgram = (p) => { window.__links.push(window.__phase || '?'); real(p) }
      }
      return true
    })()`)
    // the wheel's slices, clockwise from the top (player/emotes.ts's EMOTES),
    // and the moment each one is at its fullest
    const NAMES = ['wave', 'thumbs', 'clap', 'laugh', 'dance', 'joy', 'flex', 'facepalm', 'sit']
    const PEAK = { wave: 1.0, thumbs: 0.9, clap: 1.0, laugh: 0.9, dance: 1.2, joy: 0.5, flex: 1.2, facepalm: 1.3, sit: 1.5 }
    const aimAt = (name) => {
      const a = (NAMES.indexOf(name) / NAMES.length) * Math.PI * 2
      return [Math.sin(a) * 70, -Math.cos(a) * 70]
    }
    const setView = (yaw, pitch) =>
      evaluate(`(() => { const w = window.__sandboxWalk; w.yaw = ${yaw}; w.pitch = ${pitch}; return true })()`)
    // the wheel up, its arrow on this emote; then played with its number key
    // (or, with `click`, a click)
    const play = async (name, { shootWheel = false, click = false } = {}) => {
      await evaluate(`window.__phase = ${JSON.stringify(name)}; true`)
      await look(yaw0, -0.12)
      await sleep(700)
      await tap('KeyB')
      await sleep(250)
      const [x, y] = aimAt(name)
      await evaluate(`window.__emoteAim(${x}, ${y}); true`)
      await sleep(250)
      if (shootWheel) await eshot('wheel-open')
      const open = await evaluate('!!document.querySelector(".emote-wheel-in")')
      if (click) {
        await evaluate(`window.__input.keys.add('Mouse0'); true`)
        await sleep(90)
        await evaluate(`window.__input.keys.delete('Mouse0'); true`)
      } else await tap(`Digit${NAMES.indexOf(name) + 1}`, 60)
      const t0 = Date.now()
      await sleep(60)
      const on = await evaluate('window.__sandboxRig.acting')
      const still = await evaluate('!!document.querySelector(".emote-wheel-in")')
      console.log(`  ${name.padEnd(9)} wheel ${open ? 'up' : 'NOT UP'}, playing id ${on}, wheel ${still ? 'STILL UP' : 'put away'}`)
      return t0
    }
    const shots = {}
    const LOOKS = [
      ['bean', null],
      ['chubby', `{ shell: '#2f6fcf', trim: '#f2eee0', accent: '#2860c8', glow: '#1c1a20', hat: 1, costume: 5, build: 1, fur: 1, phones: 1 }`],
    ]
    for (const [lookName, lookJs] of LOOKS) {
      if (lookJs) {
        await evaluate(`window.__sandboxRig.setLook(${lookJs}); true`)
        await sleep(1500)
      }
      shots[lookName] = { front: [], side: [] }
      for (const name of NAMES) {
        const t0 = await play(name, { shootWheel: lookName === 'bean' && name === 'wave', click: name === 'clap' })
        // the front, square on (the body holds its facing while it emotes),
        // then the side a moment later
        await setView(yaw0 + Math.PI, name === 'sit' ? -0.42 : -0.26)
        await sleep(Math.max(0, PEAK[name] * 1000 - (Date.now() - t0)))
        shots[lookName].front.push(await eshot(`${lookName}-${name}-front`))
        await setView(yaw0 + Math.PI / 2, name === 'sit' ? -0.4 : -0.24)
        await sleep(250)
        shots[lookName].side.push(await eshot(`${lookName}-${name}-side`))
        // put the wheel up and away with b, which must play nothing
        await tap('KeyB')
        await sleep(150)
        await tap('KeyB')
        await sleep(100)
        if (NAMES.indexOf(name) === 0 && lookName === 'bean') {
          console.log(`  b twice: wheel ${await evaluate('!!document.querySelector(".emote-wheel-in")') ? 'STILL UP' : 'put away'}`)
        }
        // wait the emote out (the loops are let go through the hub)
        await tap('KeyB')
        await sleep(150)
        await evaluate('window.__emoteAim(0, 0); true')
        await evaluate(`window.__input.keys.add('Mouse0'); true`)
        await sleep(90)
        await evaluate(`window.__input.keys.delete('Mouse0'); true`)
        await sleep(500)
      }
      // two sheets per look: every emote from the front, and from the side,
      // cropped round the body
      for (const side of ['front', 'side']) {
        const sheet = join(EMOTE_OUT, `sheet-${lookName}-${side}.png`)
        // (appended rather than montaged: montage wants a font for labels
        // even when it is given none, and not every machine has one it finds)
        const row = (list) => ['(', ...list, '-crop', '560x620+360+170', '+repage', '+append', ')']
        const list = shots[lookName][side]
        const r = spawnSync('magick', [
          ...row(list.slice(0, 5)), ...row(list.slice(5)), '-background', '#222', '-append', sheet,
        ])
        if (r.status === 0) console.log(`  wrote ${sheet}`)
      }
    }
    console.log(`  after the hub the rig plays id ${await evaluate('window.__sandboxRig.acting')}`)
    await evaluate(`window.__sandboxRig.setLook({ shell: '#2f6fcf', trim: '#f2eee0', accent: '#2860c8', glow: '#1c1a20' }); true`)
    await sleep(1200)
    // the point: a crate off to the right, the camera turned onto it
    await evaluate(`window.__phase = 'point'; true`)
    await look(yaw0, -0.12)
    await sleep(600)
    // the body settles facing yaw0; the crate stands off to its right, and
    // the view is turned onto it by less than the angle that makes a
    // standing body pivot, so the arm is seen reaching out sideways
    await evaluate(`(() => { const sb = window.__sandbox, b = window.__sandboxRig.group.position, y = ${yaw0} - 0.62;
      const x = b.x - Math.sin(y) * 11, z = b.z - Math.cos(y) * 11;
      window.__pointCrate = [x, z]; sb.spawn('crate', { x, y: sb.restY('crate', x, z) + 0.3, z }); return true })()`)
    await sleep(1500)
    // the crosshair on the crate: the chase lens stands off to the right of
    // the head, so the view is turned a touch further left than the crate
    await evaluate(`(() => { const [x, z] = window.__pointCrate, c = window.__sandboxRig.group.position, w = window.__sandboxWalk;
      w.yaw = Math.atan2(-(x - c.x), -(z - c.z)) + 0.08; w.pitch = -0.16; return true })()`)
    await sleep(400)
    await down('KeyF')
    await sleep(800)
    await eshot('point')
    await up('KeyF')
    await sleep(400)
    // first person: the arm is outside the lens, so the crosshair carries the mark
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await sleep(900)
    await evaluate(`(() => { const [x, z] = window.__pointCrate, c = window.__sandboxCamera.position, w = window.__sandboxWalk;
      w.yaw = Math.atan2(-(x - c.x), -(z - c.z)); w.pitch = -0.2; return true })()`)
    await down('KeyF')
    await sleep(600)
    await eshot('point-first')
    await up('KeyF')
    const links = await evaluate('window.__links')
    console.log(`  ${links.length} programs linked through the wheel, the emotes and the point${
      links.length ? ': ' + links.join(', ') : ''}`)
    await run('cleanup')
  }

  if (WHAT.includes('viewmodel')) {
    /*
      The guns in your hand, framed on their own: the tool gun in first
      person in two modes (a short name and the longest), the physgun and
      its mitten, and the tool gun in the body's hands from the chase
      camera. Between the shots the first-person gun's turn relative to the
      lens is sampled every frame, standing still over a grazing view and
      then walking, and printed as degrees per frame (a gun that vibrates
      shows a big total against a small net). Shader links are counted from
      the first draw on (must be 0). Shots to ~/.cache/overhaul/viewmodel
      (--vm-out <dir>).
    */
    console.log('viewmodel')
    const VM_OUT = resolve(flag('vm-out', join(process.env.HOME ?? '.', '.cache/overhaul/viewmodel')))
    mkdirSync(VM_OUT, { recursive: true })
    const vmShot = async (name) => {
      const path = join(VM_OUT, `${name}.png`)
      writeFileSync(path, await probe.screenshot(W, H))
      console.log(`  wrote ${path}`)
    }
    await evaluate(`(() => { window.__vLinks = 0; for (const c of document.querySelectorAll('canvas')) {
      const gl = c.width && c.getContext('webgl2'); if (!gl || gl.__vWrapped) continue; gl.__vWrapped = true
      const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => { window.__vLinks++; real(p) } } return true })()`)
    const hold = (code, on) => evaluate(`(() => { const k = window.__input.keys; ${on ? `k.add('${code}')` : `k.delete('${code}')`}; return true })()`)
    // the gun's turn in the lens's frame, frame to frame, for `ms`
    const wobble = async (label, ms) => {
      const r = await evaluate(`new Promise((done) => {
        const vm = window.__tools.viewmodel, cam = window.__sandboxCamera
        const Q = cam.quaternion.constructor
        const rel = new Q(), last = new Q(), first = new Q(); let n = 0, sum = 0, max = 0, have = false
        const t0 = performance.now()
        const step = () => {
          rel.copy(cam.quaternion).invert().multiply(vm.fp.quaternion)
          if (have) { const d = rel.angleTo(last) * 180 / Math.PI; sum += d; max = Math.max(max, d); n++ } else first.copy(rel)
          last.copy(rel); have = true
          if (performance.now() - t0 < ${ms}) requestAnimationFrame(step)
          else done({ n, mean: sum / Math.max(1, n), max, total: sum, net: rel.angleTo(first) * 180 / Math.PI })
        }
        requestAnimationFrame(step)
      })`)
      console.log(`  ${label}: ${r.n} frames, mean ${r.mean.toFixed(3)} deg/frame, max ${r.max.toFixed(3)}, ` +
        `total ${r.total.toFixed(2)} deg against a net ${r.net.toFixed(2)}`)
    }
    await stand()
    await look(0.6, -0.12)
    await evaluate('window.__tools.select(2)')
    await evaluate(`window.__tools.toolgun.setMode('weld')`)
    await sleep(900)
    await vmShot('toolgun-weld')
    await wobble('tool gun, standing, grazing view', 1500)
    await hold('KeyW', true)
    await wobble('tool gun, walking', 1500)
    await hold('KeyW', false)
    await sleep(600)
    await evaluate(`window.__tools.toolgun.setMode('nocollide')`)
    await sleep(500)
    await vmShot('toolgun-nocollide')
    await evaluate('window.__tools.select(1)')
    await sleep(900)
    await vmShot('physgun')
    await wobble('physgun, standing, grazing view', 1500)
    await evaluate('window.__tools.select(2)')
    await evaluate(`window.__tools.toolgun.setMode('weld')`)
    await evaluate('window.__sandbox.console.host.thirdPerson(true)')
    // looking down, so the chase camera rises and sees over the shoulder
    await look(null, -0.55)
    await sleep(1200)
    await vmShot('toolgun-third')
    await look(null, -0.12)
    await sleep(800)
    // the chase camera sits right behind the body, which hides most of the
    // gun in its hands, so the body's copy is also shot from off its right
    // shoulder, level with the aim: one frame drawn through the look from a
    // borrowed lens, read back off the canvas in the same task, before the
    // loop draws over it
    const side = await evaluate(`(() => {
      const v = window.__tools.viewmodel, cam = window.__sandboxCamera, yaw = window.__sandboxWalk.yaw
      const p = v.tp.getWorldPosition(cam.position.clone())
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw)
      const c = cam.clone()
      c.position.set(p.x + rx * 3.6 - fx * 0.6, p.y + 1.4, p.z + rz * 3.6 - fz * 0.6)
      c.lookAt(p.x + fx * 0.3, p.y + 0.2, p.z + fz * 0.3)
      c.updateMatrixWorld()
      window.__look.render(window.__scene, c)
      return window.__renderer.domElement.toDataURL('image/png').split(',')[1]
    })()`)
    writeFileSync(join(VM_OUT, 'toolgun-third-side.png'), Buffer.from(side, 'base64'))
    console.log(`  wrote ${join(VM_OUT, 'toolgun-third-side.png')}`)
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await evaluate('window.__tools.select(0)')
    console.log(`  ${await evaluate('window.__vLinks')} programs linked across the viewmodel shots`)
  }

  if (WHAT.includes('weapons')) {
    /*
      The three weapons held in first person over a grazing view, the
      launcher from the chase camera, a rocket a moment after it left and a
      bolt stuck in the ground, with every shader link counted from the
      first draw on (must be 0). Shots to ~/.cache/overhaul/weapons
      (--weapons-out <dir>).
    */
    console.log('weapons')
    const WP_OUT = resolve(flag('weapons-out', join(process.env.HOME ?? '.', '.cache/overhaul/weapons')))
    mkdirSync(WP_OUT, { recursive: true })
    const wpShot = async (name) => {
      const path = join(WP_OUT, `${name}.png`)
      writeFileSync(path, await probe.screenshot(W, H))
      console.log(`  wrote ${path}`)
    }
    await evaluate(`(() => { window.__wLinks = 0; for (const c of document.querySelectorAll('canvas')) {
      const gl = c.width && c.getContext('webgl2'); if (!gl || gl.__wWrapped) continue; gl.__wWrapped = true
      const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => { window.__wLinks++; real(p) } } return true })()`)
    const trigger = async (ms = 200) => {
      await evaluate(`window.__input.keys.add('Mouse0'), true`)
      await sleep(ms)
      await evaluate(`window.__input.keys.delete('Mouse0'), true`)
    }
    await stand()
    await look(0.6, -0.12)
    for (const [slot, name] of [[4, 'pistol'], [5, 'crossbow'], [6, 'rocket']]) {
      await evaluate(`window.__tools.select(${slot})`)
      await sleep(1000)
      await wpShot(name)
    }
    // one frame drawn through the look from a lens borrowed off to the right
    // of `target` (a live object's position, read in the page), read back
    // off the canvas in the same task, before the loop draws over it
    const side = async (name, target, back = 3.6, lift = 1.4) => {
      const png = await evaluate(`(() => {
        const cam = window.__sandboxCamera, yaw = window.__sandboxWalk.yaw
        const p = (${target}).clone()
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw)
        const c = cam.clone()
        c.position.set(p.x + rx * ${back} - fx * 0.6, p.y + ${lift}, p.z + rz * ${back} - fz * 0.6)
        c.lookAt(p.x + fx * 0.3, p.y, p.z + fz * 0.3)
        c.updateMatrixWorld()
        window.__look.render(window.__scene, c)
        return window.__renderer.domElement.toDataURL('image/png').split(',')[1]
      })()`)
      const path = join(WP_OUT, `${name}.png`)
      writeFileSync(path, Buffer.from(png, 'base64'))
      console.log(`  wrote ${path}`)
    }
    // a rocket a moment after it left, climbing a little, and seen from
    // the side on the same frame
    await look(0.6, 0.06)
    await trigger()
    await sleep(300)
    await side('rocket-flight', 'window.__tools.weapons.projectiles[0]?.pos ?? cam.position', 5, 0.8)
    await sleep(2500)
    // a bolt into the ground a few steps ahead
    await evaluate('window.__tools.select(5)')
    await look(0.6, -0.55)
    await sleep(1200)
    await trigger()
    await sleep(900)
    await side('crossbow-stuck', 'window.__tools.weapons.stuck.at(-1)?.pos ?? cam.position', 3, 1.2)
    // the launcher in the body's hands, from off its right shoulder
    await evaluate('window.__tools.select(6)')
    await evaluate('window.__sandbox.console.host.thirdPerson(true)')
    await look(null, -0.12)
    await sleep(1400)
    await side('rocket-third', 'window.__tools.viewmodel.tp.getWorldPosition(cam.position.clone())')
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await evaluate('window.__tools.select(0)')
    // the voices' peaks at arm's length, against a crate hit hard, a crate
    // breaking and the barrel's boom, rendered offline through the props' bus
    const levels = await evaluate(`(async () => {
      const snd = await import('/src/game/sandbox/impactSounds.ts')
      const wsfx = (await import('/src/game/sandbox/tools/weaponSfx.ts')).createWeaponSfx()
      const ear = { x: 0, y: 0, z: 0 }
      const out = {}
      const at = { x: 0.5, y: 0, z: -1 }
      // (the walk moves the ear every frame, so it is put back for each one)
      const m = async (name, fn) => {
        const r = await snd.measureSound(() => { snd.setEar(0, 0, 0); fn() }, 2)
        out[name] = r.peak.toFixed(3)
      }
      await m('crate hit', () => snd.impactSound('wood', 1, 30, at.x, at.y, at.z))
      await m('crate break', () => snd.breakSound('wood', 1, at.x, at.y, at.z))
      await m('barrel boom', () => snd.boom(1, at.x, at.y, at.z))
      for (const w of ['pistol', 'crossbow', 'rocket']) await m(w, () => wsfx.play({ type: 'fire', w, mine: true, ...at }, ear))
      await m('bolt in', () => wsfx.play({ type: 'hit', w: 'crossbow', mine: true, what: 'world', surface: 'concrete', ...at }, ear))
      await m('reload', () => wsfx.play({ type: 'reload', w: 'pistol' }, ear))
      return out
    })()`)
    console.log(`  peaks: ${Object.entries(levels).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    const st = await evaluate('[window.__tools.weapons.stuck.length, window.__tools.weapons.projectiles.length]')
    console.log(`  ${st[0]} bolt(s) stuck, ${st[1]} shot(s) still in the air`)
    console.log(`  ${await evaluate('window.__wLinks')} programs linked across the weapons shots`)
  }

  if (WHAT.includes('nuketown')) {
    /*
      The map from the angles its references are taken from (map coordinates
      about the middle of the cul-de-sac, +x east down the street, +z south
      to the green house): each spawn end looking at its own house, straight
      down from noclip, the loading screen's view from the end of the street,
      each house's living room, and out of the yellow house's front bedroom
      window across the circle. `--only a,b` takes a subset by name.
    */
    console.log('nuketown')
    console.log(`  ${(await run('map nuketown')).join(' / ')}`)
    await sleep(7000)
    await stand()
    const O = -24000
    const only = flag('only', null)?.split(',')
    const at = async (name, x, z, yaw, pitch, y) => {
      if (only && !only.some((o) => name.includes(o))) return
      await evaluate(`window.__sandbox.console.host.teleport(${O + x}, ${z}, ${y ?? 'undefined'}, ${yaw})`)
      await sleep(1800)
      await look(yaw, pitch)
      await sleep(600)
      await shot(name)
    }
    await at('nuketown-north-spawn', -16, -94, Math.PI, -0.04)
    await at('nuketown-south-spawn', 2, 94, 0, -0.04)
    await at('nuketown-loading', 43.8, -6, 1.87, -0.02)
    await at('nuketown-green-front', 27, 13.6, 1.95, -0.02)
    await at('nuketown-yellow-front', 21, -13, 0.62, 0.06)
    await at('nuketown-inside-yellow', -4, -39, Math.PI - 0.5, -0.05)
    await at('nuketown-inside-green', -10, 39, -0.5, -0.05)
    await at('nuketown-yellow-window', 4, -33, Math.PI, -0.08, 6.6)
    /*
      --walk: the map's collision driven the way a player would, with W held:
      every spawn must let you walk off it, both houses' stairs (the one
      inside and the balcony's outside one) must carry you up to the upper
      floor, and the back fence must hold. Prints each result; anything
      wrong is flagged.
    */
    if (has('walk')) {
      const hold = async (x, z, yaw, ms, y) => {
        await evaluate(`window.__sandbox.console.host.teleport(${O + x}, ${z}, ${y ?? 'undefined'}, ${yaw})`)
        await sleep(1200)
        await look(yaw, 0)
        const a = await evaluate('[window.__sandboxCamera.position.x, window.__sandboxCamera.position.z, window.__sandboxWalk.feetY]')
        await down('KeyW')
        await sleep(ms)
        await up('KeyW')
        await sleep(500)
        const b = await evaluate('[window.__sandboxCamera.position.x, window.__sandboxCamera.position.z, window.__sandboxWalk.feetY]')
        return { moved: Math.hypot(b[0] - a[0], b[1] - a[1]), feet: b[2], x: b[0] - O, z: b[1] }
      }
      // nuketown.ts's SPAWNS: the north six, and the same turned half round
      const north = [[-28, -92, Math.PI + 0.15], [-16, -94, Math.PI + 0.05], [-4, -86, Math.PI - 0.05], [12, -84, Math.PI - 0.2], [-40, -80, Math.PI + 0.25], [-22, -80, Math.PI]]
      const all = [...north, ...north.map(([x, z, t]) => [-14 - x, -z, t - Math.PI])]
      // headless Chrome renders in software and the walk's step is clamped,
      // so how far a held W goes in a second is measured on open lawn first
      const cal = (await hold(-36, -60, Math.PI, 2000)).moved
      console.log(`  open lawn: ${cal.toFixed(1)} units in 2 s`)
      for (const [x, z, yaw] of all) {
        const r = await hold(x, z, yaw, 2000)
        console.log(`  spawn ${x},${z}: walked ${r.moved.toFixed(1)}${r.moved < cal * 0.6 ? '  <-- WRONG (stuck)' : ''}`)
      }
      // the stairs, both houses: inside from beside the front door, outside
      // from the yard up to the balcony (yellow is x = 4 - u, z = -(28 + v);
      // green is its half turn about (-7, 0))
      for (const [name, x, z, yaw] of [
        ['yellow inside stair', 14.2, -29.4, 0], ['green inside stair', -28.2, 29.4, Math.PI],
        ['yellow balcony stair', 6.3, -78, Math.PI], ['green balcony stair', -20.3, 78, 0],
      ]) {
        const r = await hold(x, z, yaw, Math.max(3200, (16 / Math.max(cal, 0.5)) * 2000))
        console.log(`  ${name}: feet at ${r.feet.toFixed(2)}${r.feet < 6 ? '  <-- WRONG (did not reach the upper floor)' : ''}`)
      }
      for (const [name, x, z, yaw, ok] of [
        ['north fence', -10, -96, 0, (r) => r.z > -100.5], ['south fence', -4, 96, Math.PI, (r) => r.z < 100.5],
        ['street end', 40, -4, -Math.PI / 2, (r) => r.x < 44.5],
      ]) {
        const r = await hold(x, z, yaw, 2500)
        console.log(`  ${name}: stopped at ${r.x.toFixed(1)}, ${r.z.toFixed(1)}${ok(r) ? '' : '  <-- WRONG (walked out)'}`)
      }
    }
    if (!only || only.includes('overhead')) {
      await run('noclip')
      await evaluate(`window.__sandbox.console.host.teleport(${O - 4}, 0, 205, 0)`)
      await look(0, -Math.PI / 2 + 0.002)
      // the console's receipt fades on its own; the walker's own body is
      // right under a lens looking straight down, so it is emptied for the
      // shot (by draw range, as the perf ablation does)
      await sleep(6000)
      await evaluate(`window.__hid = []; window.__scene.traverse((o) => { if (o.isSkinnedMesh && o.material.name === 'playerBody') {
        const g = o.geometry; if (window.__hid.some((h) => h[0] === g)) return
        window.__hid.push([g, g.drawRange.count]); g.setDrawRange(0, 0) } }); true`)
      await sleep(400)
      await shot('nuketown-overhead')
      await evaluate('for (const [g, n] of window.__hid) g.setDrawRange(0, n); true')
      await run('noclip')
    }
    console.log(`  ${(await run('map home')).join(' / ')}`)
    await sleep(3000)
  }

  if (WHAT.includes('mapcards')) {
    /*
      The pictures on the map sheet (MapPicker.tsx): each map from a spot
      that says what it is, with the page's own HUD hidden, written as
      shots/sandbox/mapcard-<id>*.png for scripts/map-cards.py to crop into
      public/os/maps/<id>.webp. A few candidates each; the script takes the
      ones named in it.
    */
    console.log('mapcards')
    const bare = (on) => evaluate(`(() => { let s = document.getElementById('__bare'); if (!s) { s = document.createElement('style'); s.id = '__bare'; document.head.appendChild(s) }
      s.textContent = ${on ? "'body * { visibility: hidden !important } canvas { visibility: visible !important }'" : "''"}; return true })()`)
    await run('time 0.42')
    // home: the house from the street, over the front gate
    for (const [n, x, z, y, yaw, pitch] of [['home-a', -6, -11, 7, 4.08, -0.12], ['home-b', -12, -16, 10, 4.2, -0.16], ['home-c', 2, -20, 9, 3.6, -0.14]]) {
      await run('noclip')
      await evaluate(`window.__sandbox.console.host.teleport(${x}, ${z}, ${y}, ${yaw}); true`)
      await look(yaw, pitch)
      await sleep(3500)
      await bare(true)
      await shot(`mapcard-${n}`)
      await bare(false)
      await run('noclip')
    }
    // nuketown: its loading screen's view down the street
    console.log(`  ${(await run('map nuketown')).join(' / ')}`)
    await sleep(8000)
    for (const [n, x, z, yaw, pitch] of [['nuketown-a', 43.8, -6, 1.87, -0.02], ['nuketown-b', 30, 16, 1.9, -0.05]]) {
      await evaluate(`window.__sandbox.console.host.teleport(${-24000 + x}, ${z}, undefined, ${yaw}); true`)
      await sleep(1500)
      await look(yaw, pitch)
      await sleep(800)
      await bare(true)
      await shot(`mapcard-${n}`)
      await bare(false)
    }
    // cubeland: over the spawn's woods toward whatever is past them
    console.log(`  ${(await run('map cubeland')).join(' / ')}`)
    await sleep(10000)
    await run('time 0.42')
    await run('noclip')
    // (the block in hand is drawn in the scene, not the page)
    await evaluate(`window.__scene.getObjectByName('cube-held').material.visible = false; true`)
    // (block coordinates: the snowy taiga off the spawn, and the badlands
    // against the desert, each from a little over the ground)
    for (const [n, bx, bz, up, yaw, pitch] of [['cubeland-a', -300, 200, 24, 0.4, -0.22], ['cubeland-b', 232, -190, 20, 2.6, -0.2], ['cubeland-c', 150, 20, 26, 0.3, -0.25]]) {
      await evaluate(`(() => { const C = window.__cubeland; let y = 0; for (let by = 95; by >= 0; by--) if (C.store.get(${bx}, by, ${bz})) { y = by * 2 + 2; break }
        window.__sandbox.console.host.teleport(${bx * 2 + 1}, ${-40000 + bz * 2 + 1}, y + ${up}, ${yaw}); return true })()`)
      await look(yaw, pitch)
      await sleep(12000)
      await bare(true)
      await shot(`mapcard-${n}`)
      await bare(false)
    }
    await run('noclip')
    console.log(`  ${(await run('map home')).join(' / ')}`)
    await sleep(3000)
  }

  if (WHAT.includes('cubeland')) {
    /*
      Cubeland: the spawn from four headings and from the air, then the
      hands (a block broken and a little tower placed, driven through the
      level's own hands with the lens as it is), a rocket's worth of blast
      in the ground ahead (blocks thrown as props), the physgun's grab
      tearing a block out, and the walk: a held W across open ground and a
      hop onto a block placed in the way. Links are counted from arrival.
    */
    console.log('cubeland')
    await evaluate(`(() => {
      const gl = [...document.querySelectorAll('canvas')].find((c) => c.width > 64 && c.getContext('webgl2')).getContext('webgl2')
      window.__cLinks = 0
      if (!gl.__cubeWrapped) { const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => { window.__cLinks++; return real(p) }; gl.__cubeWrapped = true }
      return true
    })()`)
    const t0 = Date.now()
    console.log(`  ${(await run('map cubeland')).join(' / ')}`)
    await sleep(9000)
    console.log(`  arrived in ~${((Date.now() - t0) / 1000).toFixed(1)} s, ${await evaluate('window.__cLinks')} programs linked on the way (under the card)`)
    await evaluate('window.__cLinks = 0; true')
    await stand()
    // the day runs off the wall clock there: pin it to mid-morning
    await run('time 0.4')
    const only = flag('only', null)?.split(',')
    const want = (n) => !only || only.some((o) => n.includes(o))
    const cube = (js) => evaluate(`(() => { const C = window.__cubeland, L = C.level, cam = window.__sandboxCamera, w = window.__sandboxWalk; ${js} })()`)
    for (const [n, yaw] of [['cube-north', 0], ['cube-west', Math.PI / 2], ['cube-south', Math.PI], ['cube-east', -Math.PI / 2]]) {
      if (!want(n)) continue
      await look(yaw, -0.08)
      await sleep(1500)
      await shot(n)
    }
    const stats = await cube(`let n = 0, t = 0; C.root.traverse((o) => { if (o.isMesh && o.name.startsWith('cube-') && o.geometry.index) { n++; t += o.geometry.index.count / 3 } }); return [n, t, L.collision.boxes.length, C.store.loaded]`)
    console.log(`  ${stats[0]} chunk meshes, ${Math.round(stats[1] / 1000)}k triangles, ${stats[2]} walker boxes, ${stats[3]} chunks in memory`)
    // a tour of the biomes, each from a little above its first column near
    // the middle (gen.ts's columnAt, probed offline: block coordinates)
    const TOUR = [
      ['flower-forest', 0, -32], ['ice-spikes', 4, 52], ['dark-forest', 8, -104], ['jungle', 36, -160], ['swamp', 4, -124],
      ['cherry', 144, 8], ['badlands', 220, -214], ['desert', 224, -200], ['mushroom', 172, -252], ['snowy-peaks', 212, 64],
      ['savanna', 240, -250], ['birch', -44, -110], ['taiga', 60, -64], ['snowy-taiga', -144, 72], ['windswept', 116, 120], ['ocean', 300, -210],
    ]
    if (TOUR.some(([n]) => want('biome-' + n))) {
      await run('noclip')
      for (const [n, bx, bz] of TOUR) {
        if (!want('biome-' + n)) continue
        await cube(`let y = 0; for (let by = 95; by >= 0; by--) if (C.store.get(${bx}, by, ${bz})) { y = by * 2 + 2; break }
          window.__sandbox.console.host.teleport(${bx * 2 + 1}, ${-40000 + bz * 2 + 1}, y + 14, 0.6); return true`)
        await look(0.6, -0.3)
        await sleep(3500)
        await shot('cube-biome-' + n)
      }
      await run('noclip')
    }
    // streaming: a jump to ground nothing has been meshed on, shot while
    // its chunks are still dissolving in, and again once the ring is full
    if (want('stream')) {
      await run('noclip')
      await cube(`let y = 0; for (let by = 95; by >= 0; by--) if (C.store.get(-300, by, 200)) { y = by * 2 + 2; break }
        window.__sandbox.console.host.teleport(-599, -40000 + 401, y + 30, 0.4); return true`)
      await look(0.4, -0.25)
      await sleep(1200)
      await shot('cube-streaming')
      const t1 = Date.now()
      let meshes = 0
      for (let k = 0; k < 40; k++) {
        await sleep(1000)
        const n = await cube(`let n = 0; C.root.traverse((o) => { if (o.name === 'cube-chunk') n++ }); return n`)
        if (n === meshes && k > 3) break
        meshes = n
      }
      const st = await cube(`let n = 0, t = 0; C.root.traverse((o) => { if (o.isMesh && o.name.startsWith('cube-') && o.geometry.index) { n++; t += o.geometry.index.count / 3 } }); return [n, t]`)
      console.log(`  the view filled in ~${((Date.now() - t1) / 1000).toFixed(0)} s (headless): ${st[0]} meshes, ${Math.round(st[1] / 1000)}k triangles`)
      await shot('cube-streamed')
      await run('noclip')
      await sleep(500)
    }
    if (want('aerial')) {
      await run('noclip')
      await cube('const s = L.spawn; window.__sandbox.console.host.teleport(s.x - 40, s.z + 40, s.y + 70, 0.8); return true')
      await look(0.8, -0.55)
      await sleep(4000)
      await shot('cube-aerial')
      await run('noclip')
      await sleep(500)
    }
    // light and liquid: torches round the spawn by night, a lava lake in a
    // cave, and water and lava poured out on the ground and left to run
    if (want('light') || want('fluid')) {
      const handsOnce = (kind) => cube(`const f = { camera: cam, feetY: w.feetY, fire: false, alt: false, wheel: 0, dt: 0.016, active: true, firstPerson: true };
        L.hands.choose('${kind}'); L.hands.update(f); L.hands.update({ ...f, alt: true }); L.hands.update(f); return true`)
      const count = (keys, r) => cube(`const s = L.spawn, bx = Math.floor(s.x / 2), bz = Math.floor((s.z + 40000) / 2), by = Math.round(s.y / 2);
        const ids = ${JSON.stringify(keys)}.map((k) => C.blockId(k)); let n = 0;
        for (let y = by - 4; y < by + 4; y++) for (let z = bz - ${r}; z <= bz + ${r}; z++) for (let x = bx - ${r}; x <= bx + ${r}; x++) if (ids.includes(C.store.get(x, y, z))) n++
        return n`)
      if (want('light')) {
        await run('time 0.97')
        await cube(`const s = L.spawn, bx = Math.floor(s.x / 2), bz = Math.floor((s.z + 40000) / 2), by = Math.round(s.y / 2);
          const T = C.blockId('torch'), G = C.blockId('glowstone'), J = C.blockId('jack_o_lantern');
          const at = (x, z, id) => { let y = by + 6; while (y > 1 && !C.store.get(x, y - 1, z)) y--; while (C.store.get(x, y, z) && y < 90) y++; C.net.apply([[x, y, z, id]], false) }
          at(bx - 4, bz - 6, T); at(bx + 4, bz - 6, T); at(bx, bz - 10, G); at(bx - 7, bz - 12, T); at(bx + 6, bz - 13, J); at(bx + 1, bz - 4, T)
          window.__sandbox.console.host.teleport(s.x, s.z + 6, s.y, 0); return true`)
        await sleep(2500)
        await look(0, -0.15)
        await sleep(800)
        await shot('cube-night')
        await run('time 0.4')
        // the nearest lava under the spawn, looked at from the cave beside it
        const lava = await cube(`const s = L.spawn, bx = Math.floor(s.x / 2), bz = Math.floor((s.z + 40000) / 2), Lv = C.blockId('lava');
          for (let r = 0; r < 120; r++) for (let z = bz - r; z <= bz + r; z++) for (let x = bx - r; x <= bx + r; x++) {
            if (Math.max(Math.abs(x - bx), Math.abs(z - bz)) !== r) continue
            for (let y = 3; y < 10; y++) if (C.store.get(x, y, z) === Lv && !C.store.get(x, y + 2, z) && !C.store.get(x, y + 3, z)) return [x, y, z]
          }
          return null`)
        if (lava) {
          await run('noclip')
          await cube(`window.__sandbox.console.host.teleport(${lava[0] * 2 + 1}, ${-40000 + lava[2] * 2 + 1 + 6}, ${lava[1] * 2 + 5}, 0); return true`)
          await look(0, -0.5)
          await sleep(3000)
          await shot('cube-lava')
          await run('noclip')
          console.log(`  a lava lake at block ${lava.join(',')}`)
        } else console.log('  no lava found near the spawn')
      }
      if (want('fluid')) {
        await cube('const s = L.spawn; window.__sandbox.console.host.teleport(s.x, s.z, s.y, 0); return true')
        await sleep(1200)
        await look(0, -0.9)
        await sleep(300)
        await handsOnce('block_water')
        await sleep(5000)
        const wet = await count(['water', 'water_1', 'water_2', 'water_3', 'water_4', 'water_5', 'water_6', 'water_7', 'water_8'], 10)
        console.log(`  a bucket of water poured: ${wet} water block(s) after 5 s`)
        await look(Math.PI / 2, -0.9)
        await sleep(300)
        await handsOnce('block_lava')
        await sleep(9000)
        const set = await count(['obsidian', 'cobblestone'], 10)
        const hot = await count(['lava', 'lava_1', 'lava_2', 'lava_3', 'lava_8'], 10)
        console.log(`  a bucket of lava beside it: ${hot} lava block(s), ${set} obsidian or cobblestone where they met`)
        await run('noclip')
        await cube('const s = L.spawn; window.__sandbox.console.host.teleport(s.x + 8, s.z + 10, s.y + 10, 0.6); return true')
        await look(0.6, -0.6)
        await sleep(1500)
        await shot('cube-fluids')
        await run('noclip')
      }
    }
    // back on the ground at the spawn, facing north, looking down at it
    await cube('const s = L.spawn; window.__sandbox.console.host.teleport(s.x, s.z, s.y, 0); return true')
    await sleep(1500)
    await stand()
    console.log(`  on foot: ${await evaluate('JSON.stringify({ noclip: window.__sandboxWalk.noclip, down: !!window.__sandboxRig.down, feet: window.__sandboxWalk.feetY })')}`)
    await evaluate('window.__tools.select(0); true')
    await look(0, -0.75)
    await sleep(600)
    // (armed with a frame of nothing held first: headless never holds the
    // pointer, so the walk's own frames hand the hands in as put away, and a
    // button already down when they come out is not a click)
    const handsAt = (fire, alt) => cube(`const f = { camera: cam, feetY: w.feetY, fire: false, alt: false, wheel: 0, dt: 0.016, active: true, firstPerson: true };
      L.hands.update(f); L.hands.update({ ...f, fire: ${fire}, alt: ${alt} }); return true`)
    const counts = () => cube(`let a = 0; for (const m of C.store.edits.values()) a += m.size; return a`)
    await handsAt(true, false)
    await sleep(100)
    await handsAt(false, false)
    console.log(`  a click broke ${await counts()} block(s)`)
    for (let k = 0; k < 4; k++) {
      await look(0, -0.62 + k * 0.08)
      await sleep(120)
      await handsAt(false, true)
      await sleep(80)
      await handsAt(false, false)
    }
    console.log(`  after placing, ${await counts()} block(s) changed`)
    // stepped back to see it
    const back = () => cube('const s = L.spawn; window.__sandbox.console.host.teleport(s.x + 3, s.z + 16, s.y + 8, 0); return true')
    await run('noclip')
    await back()
    await look(0, -0.3)
    await sleep(1200)
    await shot('cube-built')
    await run('noclip')
    await cube('const s = L.spawn; window.__sandbox.console.host.teleport(s.x, s.z, s.y, 0); return true')
    await sleep(1200)
    await look(0, -0.35)
    // a blast in the ground a few blocks ahead
    const props0 = await evaluate('window.__sandbox.count')
    await look(0, -0.35)
    await cube(`const d = new cam.position.constructor(); cam.getWorldDirection(d); d.y = 0; d.normalize();
      const x = cam.position.x + d.x * 14, z = cam.position.z + d.z * 14;
      let y = 0; for (let by = 95; by >= 0; by--) { if (L.collision && C.store.get(Math.floor((x - ${0}) / 2), by, Math.floor((z + 40000) / 2))) { y = by * 2 + 1; break } }
      window.__sandbox.explode({ x, y, z }, 1, 14); return true`)
    await run('noclip')
    await back()
    await look(0, -0.3)
    await sleep(900)
    await shot('cube-blast')
    await sleep(2500)
    const props1 = await evaluate('window.__sandbox.count')
    console.log(`  a rocket's blast: ${await counts()} block(s) changed, ${props1 - props0} loose block(s) thrown`)
    await shot('cube-after')
    await run('noclip')
    await cube('const s = L.spawn; window.__sandbox.console.host.teleport(s.x, s.z, s.y, 0); return true')
    await sleep(1200)
    await look(0, -0.75)
    // the physgun tears one out
    const took = await cube(`const d = new cam.position.constructor(); cam.getWorldDirection(d);
      const g = L.grab.pick(cam.position, d, 100); if (!g) return 'nothing under the beam';
      const p = L.grab.take(g.key, window.__sandbox); return p ? 'took ' + p.kind.id : 'refused'`)
    console.log(`  physgun on the ground: ${took}`)
    // the walk: open ground, then a block in the way
    await evaluate(`window.__sandbox.console.host.teleport(${'0'}, 0, undefined, 0); true`).catch(() => {})
    await cube('const s = L.spawn; window.__sandbox.console.host.teleport(s.x, s.z, s.y, Math.PI / 2); return true')
    await sleep(2500)
    await look(Math.PI / 2, 0)
    const pos = () => evaluate('[window.__sandboxCamera.position.x, window.__sandboxCamera.position.z, window.__sandboxWalk.feetY]')
    let a = await pos()
    await down('KeyW'); await sleep(2000); await up('KeyW'); await sleep(400)
    let b = await pos()
    console.log(`  held W for 2 s: ${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(1)} units, feet ${a[2].toFixed(2)} -> ${b[2].toFixed(2)}`)
    // a one-block step three blocks ahead of the spawn, walked into with
    // the jump held: the feet must end a block (2 units) up
    const step = await cube(`const s = L.spawn, bx = Math.floor(s.x / 2), bz = Math.floor((s.z + 40000) / 2), by = Math.round(s.y / 2);
      for (let k = 2; k < 9; k++) for (let dx = -2; dx <= 2; dx++) { C.net.apply([[bx + dx, by, bz - k, 1]], false); for (let h = 1; h < 4; h++) C.net.apply([[bx + dx, by + h, bz - k, 0]], false) }
      window.__sandbox.console.host.teleport(s.x, s.z, s.y, 0); return s.y`)
    await sleep(1500)
    await look(0, 0)
    a = await pos()
    await down('KeyW'); await down('Space')
    const trace = []
    for (let k = 0; k < 12; k++) { await sleep(200); trace.push((await pos())[2].toFixed(1)) }
    await up('Space'); await up('KeyW'); await sleep(1500)
    b = await pos()
    console.log(`    feet while held: ${trace.join(' ')}`)
    console.log(`  a one-block step, W and jump held: feet ${a[2].toFixed(2)} -> ${b[2].toFixed(2)}` +
      `${b[2] < step + 1.9 ? '  <-- WRONG (did not get up the step)' : ''}`)
    console.log(`  ${await evaluate('window.__cLinks')} programs linked in Cubeland after arrival (must be 0)`)
    console.log(`  ${(await run('map home')).join(' / ')}`)
    await sleep(3000)
  }

  if (WHAT.includes('pause')) {
    // the pause sheet: the wardrobe's snapshots, one tried on by hovering,
    // and the settings page's pixel prints, on a town street so the prints
    // have something to show. Headless Chrome never holds the pointer lock,
    // so the pause is the lock-loss event the real esc would raise. Links
    // are counted on the game's own context only (the preview's context is
    // opened after the wrap and is its own business): must be 0
    console.log('pause')
    await goTo(flag('at', '-32 -331').replace(',', ' '))
    await sleep(1500)
    await stand()
    await look(Number(flag('yaw', Math.PI)), -0.05)
    await sleep(1200)
    // Count frames that actually submit the game's WebGL work, excluding the
    // menu's independent wardrobe canvas and rAFs the limiter drops.
    await evaluate(`(() => {
      const gl = [...document.querySelectorAll('canvas')]
        .find((c) => c.width > 64 && c.getContext('webgl2')).getContext('webgl2')
      const S = window.__pauseFrames = { draws: 0, times: [], resumeAt: null, resumeMs: null }
      for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
        const real = gl[name].bind(gl)
        gl[name] = (...args) => { S.draws++; return real(...args) }
      }
      const raf = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (cb) => raf((t) => {
        const before = S.draws
        cb(t)
        if (S.draws !== before) {
          S.times.push(t)
          if (S.resumeAt !== null && S.resumeMs === null) S.resumeMs = performance.now() - S.resumeAt
        }
      })
      return true
    })()`)
    const frameRate = async () => {
      await evaluate('window.__pauseFrames.times = []; true')
      await sleep(2000)
      return evaluate(`(() => {
        const ts = window.__pauseFrames.times
        return ts.length > 1 ? (ts.length - 1) * 1000 / (ts.at(-1) - ts[0]) : 0
      })()`)
    }
    const liveFps = await frameRate()
    await evaluate(`(() => {
      window.__pauseLinks = 0
      for (const c of document.querySelectorAll('canvas')) {
        const gl = c.width && c.getContext('webgl2')
        if (!gl || c.__pauseWrapped) continue
        c.__pauseWrapped = true
        const real = gl.linkProgram.bind(gl)
        gl.linkProgram = (p) => { window.__pauseLinks++; real(p) }
      }
      document.dispatchEvent(new Event('pointerlockchange'))
      return true
    })()`)
    // every snapshot is one frame of the preview's loop, once its body
    // variant has been built in idle time
    await sleep(3500)
    const pausedFps = await frameRate()
    if (!(pausedFps > 0 && pausedFps <= 31)) {
      throw new Error('Paused game must render at most 30 FPS; got ' + pausedFps)
    }
    await shot('pause-wardrobe')
    const snaps = await evaluate(`[...document.querySelectorAll('button[title]')].length`)
    console.log(`  ${snaps} snapshots on the sheet`)
    // hover the fourth hat (the party hat): it is tried on the Polaroid
    const at = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button[title]')][3]
      const r = b.getBoundingClientRect()
      return [r.x + r.width / 2, r.y + r.height / 2]
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] })
    await sleep(900)
    await shot('pause-wardrobe-peek')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    // the sheet's own menu is the nav whose current row is marked
    await evaluate(`[...document.querySelectorAll('nav')].filter((n) => n.querySelector('button[aria-current]')).pop().querySelectorAll('button')[1].click()`)
    await sleep(1500)
    await shot('pause-settings')
    console.log(`  ${await evaluate('window.__pauseLinks')} programs linked on the game's context while paused`)
    await evaluate('window.__pauseFrames.awaitingResume = true; true')
    await tap('Escape')
    await sleep(400)
    const resumedFps = await frameRate()
    if (liveFps > 40 && resumedFps < liveFps * 0.8) {
      throw new Error('Resume did not restore live frame rate: ' + resumedFps + ' vs ' + liveFps)
    }
    const resumeMs = await evaluate('window.__pauseFrames.resumeMs')
    if (resumeMs === null || resumeMs > Math.max(100, 3000 / liveFps)) {
      throw new Error('First resumed frame was delayed: ' + resumeMs + ' ms')
    }
    console.log(`  render FPS: live ${liveFps.toFixed(1)}, paused ${pausedFps.toFixed(1)}, resumed ${resumedFps.toFixed(1)}`)
    console.log(`  first resumed frame: ${resumeMs.toFixed(1)} ms after Escape`)
  }

  if (WHAT.includes('portal') || WHAT.includes('portalmoon') || WHAT.includes('portalhouse')) {
    const moonTrip = WHAT.includes('portalmoon')
    const houseTrip = WHAT.includes('portalhouse')
    /*
      The portal gun in the real game (see the header). Walls are found by
      sweeping the view round and firing until a portal lands upright a
      sensible walk away, which is how a player finds one too.
    */
    console.log('portal')
    const P_OUT = resolve(flag('portal-out', join(process.env.HOME ?? '.', '.cache/overhaul/portal')))
    mkdirSync(P_OUT, { recursive: true })
    const pShot = async (name) => {
      const path = join(P_OUT, `${name}.png`)
      writeFileSync(path, await probe.screenshot(W, H))
      console.log(`  wrote ${path}`)
    }
    await evaluate(`(() => { window.__pLinks = []; for (const c of document.querySelectorAll('canvas')) {
      const gl = c.width && c.getContext('webgl2'); if (!gl || gl.__pWrapped) continue; gl.__pWrapped = true
      const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => {
        const src = (gl.getAttachedShaders(p) ?? []).map((sh) => gl.getShaderSource(sh) ?? '').join('\\n')
        const name = /#define SHADER_NAME ([^\\s]+)/.exec(src)?.[1] ?? /#define SHADER_TYPE ([^\\s]+)/.exec(src)?.[1] ?? 'raw'
        window.__pLinks.push((window.__pPhase || '?') + ' (' + name + ')'); real(p) } } return true })()`)
    const phase = (name) => evaluate(`window.__pPhase = ${JSON.stringify(name)}; true`)
    await phase(moonTrip ? 'setup (to the street, night)' : 'setup (to the street)')
    const hold = (code, on) => evaluate(`(() => { const k = window.__input.keys; ${on ? `k.add('${code}')` : `k.delete('${code}')`}; return true })()`)
    const click = async (code) => {
      await hold(code, true)
      await sleep(90)
      await hold(code, false)
      await sleep(260)
    }
    const portalAt = (c) => evaluate(`(() => { const p = window.__tools.portals.list[${c}]; return p ? { pos: p.pos.toArray(), n: p.n.toArray(), up: p.up.toArray() } : null })()`)
    const here = () => evaluate('window.__sandboxCamera.position.toArray()')
    const tpFeet = (x, z, y, yaw) => evaluate(`(window.__sandbox.console.host.teleport(${x}, ${z}, ${y}, ${yaw}), true)`)
    const f1 = (v) => v.map((n) => n.toFixed(1)).join(', ')
    /* The drawn surface, felt for independently of the gun: a ray-triangle
       test over every visible, non-instanced mesh under the house, the
       streamed ground and the Moon, in world space. `window.__drawnHit(o, d,
       max)` answers the distance to the nearest drawn facet (or -1). */
    await evaluate(`(() => {
      const V = window.__sandboxCamera.position.constructor
      const roots = () => [window.__house?.root, window.__scene.getObjectByName('earth-ground'), window.__outside.moonPortal.root()].filter(Boolean)
      const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true }
      const a = new V(), b = new V(), c = new V(), e1 = new V(), e2 = new V(), p = new V(), q = new V(), t0 = new V(), ctr = new V()
      window.__drawnHit = (o, d, max) => {
        let best = -1
        for (const r of roots()) r.traverse((m) => {
          if (!m.isMesh || m.isInstancedMesh || m.isSkinnedMesh || /^portal-(blue|orange)$/.test(m.name) || !shown(m)) return
          const g = m.geometry; if (!g.boundingSphere) g.computeBoundingSphere()
          ctr.copy(g.boundingSphere.center).applyMatrix4(m.matrixWorld)
          const rad = g.boundingSphere.radius * m.matrixWorld.getMaxScaleOnAxis()
          if (ctr.distanceTo(o) > rad + max) return
          const pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count
          for (let i = 0; i + 2 < n; i += 3) {
            a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld)
            if (a.distanceTo(o) > max + 40) continue
            b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(m.matrixWorld)
            c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(m.matrixWorld)
            e1.subVectors(b, a); e2.subVectors(c, a); p.crossVectors(d, e2)
            const det = e1.dot(p); if (Math.abs(det) < 1e-9) continue
            t0.subVectors(o, a); const u = t0.dot(p) / det; if (u < 0 || u > 1) continue
            q.crossVectors(t0, e1); const v = d.dot(q) / det; if (v < 0 || u + v > 1) continue
            const t = e2.dot(q) / det; if (t < 0 || t > max) continue
            if (best < 0 || t < best) best = t
          }
        })
        // the props are drawn from instanced batches: their collision boxes
        // are their shapes, and stand in for them here
        const ph = window.__sandbox.raycast(o, d, max, { props: true, world: false })
        if (ph && (best < 0 || ph.distance < best)) best = ph.distance
        return best
      }
      // the largest gap between a portal's rim (and middle) and the drawn
      // surface behind it, and how many samples found none
      window.__rimGap = (color) => {
        const P = window.__tools.portals.list[color]; if (!P) return null
        const right = new V().crossVectors(P.up, P.n), d = P.n.clone().negate(), HW = window.__tools.portals.hw, HH = window.__tools.portals.hh
        let worst = 0, miss = 0
        const pts = [[0, 0]]
        for (let i = 0; i < 12; i++) pts.push([Math.cos(i / 12 * Math.PI * 2) * 0.97, Math.sin(i / 12 * Math.PI * 2) * 0.97])
        for (const [x, y] of pts) {
          const o = P.pos.clone().addScaledVector(right, x * HW).addScaledVector(P.up, y * HH).addScaledVector(P.n, 0.5)
          const t = window.__drawnHit(o, d, 1.5)
          if (t < 0) { miss++; continue }
          worst = Math.max(worst, Math.abs(t - 0.5))
        }
        return { worst, miss }
      }
      return true
    })()`)
    const rim = async (color, label) => {
      const g = await evaluate(`window.__rimGap(${color})`)
      if (!g) return console.log(`  ${label}: no portal`)
      const ok = g.miss === 0 && g.worst < 0.05
      console.log(`  ${label}: rim-to-drawn-surface max ${g.worst.toFixed(3)} u, ${g.miss} of 13 samples on nothing${ok ? '' : '  <-- WRONG'}`)
    }
    /** a portal photographed side-on: the lens ~70 degrees off its normal,
        seven units out, so a portal standing off its surface shows the gap */
    const sideOn = async (color, name) => {
      const p = await evaluate(`(() => { const P = window.__tools.portals.list[${color}]; return P ? { pos: P.pos.toArray(), n: P.n.toArray(), up: P.up.toArray() } : null })()`)
      if (!p) return
      const floor = p.n[1] > 0.6
      // across the surface: for a wall, sideways; for a floor, along its up
      const r = floor ? p.up : [p.up[1] * p.n[2] - p.up[2] * p.n[1], 0, p.up[0] * p.n[1] - p.up[1] * p.n[0]]
      const el = (floor ? 20 : 20) * Math.PI / 180
      const off = [0, 1, 2].map((k) => p.n[k] * Math.sin(el) * 7 + r[k] * Math.cos(el) * 7)
      const x = p.pos[0] + off[0]
      const z = p.pos[2] + off[2]
      const gy = await evaluate(`window.__levels.current.groundYAt(${x}, ${z})`)
      await tpFeet(x, z, Math.max(gy, p.pos[1] + off[1] - 3.84) + 0.2, 0)
      await sleep(1400)
      const c = await here()
      await look(Math.atan2(-(p.pos[0] - c[0]), -(p.pos[2] - c[2])), Math.atan2(p.pos[1] - c[1], Math.hypot(p.pos[0] - c[0], p.pos[2] - c[2])))
      await sleep(900)
      await pShot(name)
    }

    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await goTo(houseTrip ? '5.5 -6' : flag('at', '-32 -331').replace(',', ' '))
    await sleep(6000)
    await phase(moonTrip ? 'setup (night falls)' : 'setup (morning)')
    await run(moonTrip ? 'time 22:30' : 'time 10:30')
    await sleep(1500)
    await phase('setup (standing)')
    await stand()
    await look(Math.PI / 2, -0.05)
    await sleep(800)

    // 1. the gun, out of the catalogue's tools tab
    await phase('catalogue')
    if (moonTrip || houseTrip) await evaluate(`(() => { window.__tools.give('portalgun'); window.__tools.select(3); return true })()`)
    else {
    await tap('KeyQ')
    await sleep(400)
    await waitFor(() => evaluate(`document.querySelectorAll('[data-kind] img').length > 4`), 60, 250, 'the catalogue icons')
    const tab = await evaluate(`(() => { const el = document.querySelector('[data-category="tools"]'); if (!el) return false; el.click(); return true })()`)
    if (!tab) console.log('  no tools section  <-- WRONG')
    await sleep(900)
    await pShot('1-catalogue-tools')
    await evaluate(`(() => { const el = document.querySelector('[data-kind="tool:portalgun"]'); el && el.click(); return !!el })()`)
    await sleep(500)
    await tap('Escape')
    await sleep(1200)
    }
    console.log(`  in hand: ${await evaluate('window.__tools.tool')}`)
    if (!moonTrip && !houseTrip) await pShot('2-gun-in-hand')

    if (houseTrip) {
      /* Portals on what the house and the sandbox are furnished with: a
         room door (then swung open with the portal riding it), the bed's
         mattress, a portal panel from the catalogue carried on the physgun
         with its portal riding it, and a floor portal on the lawn with the
         grass kept out of it (the same view with the holes cleared first,
         as the before) */
      await phase('house')
      const said = async (label, color) => {
        const ev = await evaluate('window.__pEv.splice(0).join(" ")')
        const p = await portalAt(color)
        console.log(`  ${label}: ${p ? `opened at ${f1(p.pos)} facing ${f1(p.n)}` : 'nothing opened'} (${ev || 'no event'})`)
        if (p) await rim(color, `  ${label}`)
        return p
      }
      const aimAt = async (x, y, z) => {
        const c = await here()
        await look(Math.atan2(-(x - c[0]), -(z - c[2])), Math.atan2(y - c[1], Math.hypot(x - c[0], z - c[2])))
        await sleep(300)
      }
      await evaluate(`window.__pEv = []; window.__tools.portals.on((e) => window.__pEv.push(e.type + ':' + e.color)); true`)
      // a room door, shut, shot square from five units off
      await evaluate('window.__house.resetDoors(); true')
      const leaves = await evaluate('window.__house.doorLeaves()')
      const UP = 6.4
      const door = leaves.find((d) => d.y > UP - 0.5) ?? leaves[0]
      if (!door) console.log('  no room door  <-- WRONG')
      else {
        // an 'x' door stands in a wall at x = at, its centre `cu` along z
        const nx = door.axis === 'x' ? 1 : 0
        const nz = door.axis === 'z' ? 1 : 0
        const cx = door.axis === 'x' ? door.at : door.cu
        const cz = door.axis === 'x' ? door.cu : door.at
        // from whichever side has a clear view of the leaf
        let side = 1
        for (const s of [1, -1]) {
          side = s
          await tpFeet(cx + nx * 4.5 * s, cz + nz * 4.5 * s, door.y + 0.05, 0)
          await sleep(1400)
          await aimAt(cx, door.y + 2.35, cz)
          const t = await evaluate(`(() => { const c = window.__sandboxCamera, d = c.getWorldDirection(c.position.clone()); const h = window.__portalHouseHit(c.position, d, 40); return h ? h.t : -1 })()`)
          if (Math.abs(t - 4.5) < 0.8) break
        }
        await click('Mouse0')
        console.log(`  (door ${JSON.stringify(door)}, lens at ${f1(await here())})`)
        const p = await said('a room door', 0)
        await pShot('house-1-door')
        if (p) {
          // swing it: the portal rides the leaf
          const c = await here()
          await evaluate(`(() => { const V = window.__sandboxCamera.position.constructor
            return window.__house.useDoor(new V(${c[0]}, ${c[1]}, ${c[2]}), new V(${cx - c[0]}, 0, ${cz - c[2]}).normalize()) })()`)
          await sleep(1600)
          const q = await portalAt(0)
          console.log(`  the door swung: the portal is at ${q ? `${f1(q.pos)} facing ${f1(q.n)}` : 'closed'} (side ${side})`)
          await pShot('house-2-door-swung')
          await evaluate('window.__house.resetDoors(); true')
        }
      }
      // the mattress on the kid's bed, from beside it, looking down
      const bx = -5.72
      const bz = 8.03
      await tpFeet(bx + 3.2, bz - 2.2, UP + 0.05, 0)
      await sleep(1400)
      await aimAt(bx, UP + 1.0, bz)
      console.log('  (the house ray: ' + await evaluate(`(() => { const c = window.__sandboxCamera, d = c.getWorldDirection(c.position.clone()); const h = window.__portalHouseHit(c.position, d, 40); if (!h) return 'none'
        const b = new (window.__sandboxCamera.position.constructor)(); const B = { min: b.clone().setScalar(1e9), max: b.clone().setScalar(-1e9) }
        h.object.geometry.computeBoundingBox(); const bb = h.object.geometry.boundingBox.clone().applyMatrix4(h.object.matrixWorld)
        return h.t.toFixed(2) + ' ' + h.normal.toArray().map((n) => n.toFixed(2)) + ' ' + (h.object.name || '?') + ' size ' + bb.getSize(b).toArray().map((n) => n.toFixed(2)) + (B ? '' : '') })()`) + ')')
      await click('Mouse2')
      await said("the kid's bed", 1)
      console.log('  (why: ' + await evaluate('window.__tools.portals.why') + ')')
      await pShot('house-3-bed')
      // outside: the lawn, the panel and the physgun
      await tpFeet(1.5, -7.5, 0.05, Math.PI)
      await sleep(2500)
      await look(Math.PI, -1.0)
      await click('Mouse0')
      const lawn = await said('the lawn', 0)
      if (lawn && lawn.n[1] > 0.6) {
        const holes = `(() => { const P = window.__tools.portals.list[0]; const r = P.up.clone().cross(P.n)
          window.__outside.groundHoles(P ? [{ c: P.pos, a: r.multiplyScalar(window.__tools.portals.hw), b: P.up.clone().multiplyScalar(window.__tools.portals.hh) }] : []); return true })()`
        await evaluate('window.__outside.groundHoles([]); true')
        await sleep(500)
        await pShot('grass-1-before-eye')
        await evaluate(holes)
        await sleep(500)
        await pShot('grass-2-after-eye')
        await evaluate('window.__sandbox.console.host.thirdPerson(true)')
        await look(Math.PI, -0.7)
        await sleep(1200)
        await evaluate('window.__outside.groundHoles([]); true')
        await sleep(400)
        await pShot('grass-3-before-third')
        await evaluate(holes)
        await sleep(400)
        await pShot('grass-4-after-third')
        await evaluate('window.__sandbox.console.host.thirdPerson(false)')
      }
      // a mattress from the catalogue, lying on the lawn, and the orange
      // portal on its top
      await tpFeet(4, -9, 0.05, 0)
      await sleep(1200)
      await evaluate(`(() => { const sb = window.__sandbox; const x = 4, z = -14; window.__mat = sb.spawn('mattress', { x, y: sb.restY('mattress', x, z) + 0.05, z }); return true })()`)
      await sleep(1500)
      const mat = await evaluate(`(() => { const v = window.__sandboxCamera.position.clone(); window.__sandbox.getTransform(window.__mat, v); return v.toArray() })()`)
      await aimAt(mat[0], mat[1] + 0.2, mat[2])
      await click('Mouse2')
      await said('a mattress (the catalogue one)', 1)
      console.log('  (why: ' + await evaluate('window.__tools.portals.why') + ')')
      await pShot('house-3b-mattress-prop')
      // the panel from the catalogue, set down facing us toward the street
      await look(0.6, -0.25)
      await sleep(400)
      await tap('KeyQ')
      await sleep(400)
      await waitFor(() => evaluate(`document.querySelectorAll('[data-kind] img').length > 4`), 60, 250, 'the catalogue icons')
      const got = await evaluate(`(() => { const el = document.querySelector('[data-kind="portal_panel"]'); el && el.click(); return !!el })()`)
      await sleep(600)
      await tap('Escape')
      await sleep(1000)
      const panel = await evaluate(`(() => { let q = null; window.__sandbox.forEach((p) => { if (p.kind.id === 'portal_panel') q = p }); if (!q) return null
        const v = window.__sandboxCamera.position.clone(); window.__sandbox.getTransform(q.id, v); return { id: q.id, at: v.toArray(), mode: q.mode } })()`)
      console.log(`  the panel: ${got ? '' : 'no plate  <-- WRONG '}${panel ? `at ${f1(panel.at)}, ${panel.mode}` : 'not spawned  <-- WRONG'}`)
      if (panel) {
        await aimAt(panel.at[0], panel.at[1], panel.at[2])
        await click('Mouse0')
        await said('the panel', 0)
        await pShot('panel-1-portal-on-it')
        // carried on the physgun, the portal riding it (and still see-through)
        await evaluate('window.__tools.select(1); true')
        await sleep(500)
        await aimAt(panel.at[0], panel.at[1], panel.at[2])
        await hold('Mouse0', true)
        await sleep(700)
        console.log('  (props ray: ' + await evaluate(`(() => { const c = window.__sandboxCamera, d = c.getWorldDirection(c.position.clone()); const h = window.__sandbox.raycast(c.position, d, 60, { props: true, world: false }); let pk = '?'; window.__sandbox.forEach((p) => { if (p.kind.id === 'portal_panel') pk = p.mode + (p.parked ? ' parked' : '') }); return (h ? h.distance.toFixed(2) + ' ' + (h.prop?.kind.id ?? 'no prop') : 'none') + ', panel ' + pk })()`) + ')')
        const held = await evaluate('window.__tools.physgun.holding')
        console.log('  (physgun: ' + await evaluate('window.__tools.tool + " " + window.__tools.physgun.view.mode') + ')')
        await evaluate('window.__sandboxWalk.yaw += 0.5; true')
        await sleep(900)
        console.log(`  the physgun ${held ? 'has' : 'did not take'} the panel`)
        const q = await portalAt(0)
        const pv = await evaluate('window.__tools.portalView.stats.passes')
        console.log(`  carried: the portal at ${q ? f1(q.pos) : 'closed'}, ${pv} live view(s) this frame`)
        await pShot('panel-2-carried')
        await hold('Mouse0', false)
        await evaluate('window.__tools.select(3); true')
      }
    } else {
    // 2. a wall for each colour
    await phase('open')
    await evaluate(`window.__pEv = []; window.__tools.portals.on((e) => window.__pEv.push(e.type + ':' + e.color + '@' + e.point.toArray().map((n) => n.toFixed(1)).join(','))); true`)
    // what a shot costs the frame it is fired on (the fit and its rays)
    await evaluate(`(() => { const P = window.__tools.portals, real = P.fire; window.__fireMs = []
      P.fire = (...a) => { const t = performance.now(); const r = real(...a); window.__fireMs.push(performance.now() - t); return r }; return true })()`)
    const findWall = async (color, avoid) => {
      const eye = await here()
      for (let k = 0; k < 24; k++) {
        const yaw = (k / 24) * Math.PI * 2
        await look(yaw, -0.03)
        await click(color ? 'Mouse2' : 'Mouse0')
        const p = await portalAt(color)
        if (has('debug')) console.log(`    ${color ? 'orange' : 'blue'} at yaw ${yaw.toFixed(2)}: ${p ? `${f1(p.pos)} n ${f1(p.n)}` : 'none'} ${await evaluate('window.__pEv.splice(0).join(" ")')}`)
        if (!p || Math.abs(p.n[1]) > 0.3) continue
        const d = Math.hypot(p.pos[0] - eye[0], p.pos[2] - eye[2])
        if (d < 6 || d > 90) continue
        if (avoid && (Math.hypot(p.pos[0] - avoid.pos[0], p.pos[2] - avoid.pos[2]) < 8 ||
          p.n[0] * avoid.n[0] + p.n[2] * avoid.n[2] > 0.3)) continue
        return p
      }
      return null
    }
    const blue = await findWall(0, null)
    const orange = blue && !moonTrip ? await findWall(1, blue) : null
    console.log(`  blue:   ${blue ? `${f1(blue.pos)}  facing ${f1(blue.n)}` : 'none  <-- WRONG'}`)
    if (!moonTrip) console.log(`  orange: ${orange ? `${f1(orange.pos)}  facing ${f1(orange.n)}` : 'none  <-- WRONG'}`)
    console.log('  a shot costs ' + await evaluate(`(() => { const v = window.__fireMs.slice().sort((a, b) => a - b); return v.length ? v[v.length >> 1].toFixed(1) + ' ms median, ' + v[v.length - 1].toFixed(1) + ' ms worst over ' + v.length : '-' })()`))
    // flush on what is drawn, and seen from the side
    await phase('flush')
    if (blue) await rim(0, 'blue')
    if (orange) await rim(1, 'orange')
    if (blue) await sideOn(0, 'side-blue')
    if (orange) await sideOn(1, 'side-orange')
    if (moonTrip && blue) {
      /* The Moon by portal: orange fired at the Moon in the night sky opens
         on the slab there; blue on its wall downtown is then looked
         through (the Moon's ground, the Earth low in its sky) and costed,
         walked through to the Moon, looked back through (the snapshot of
         the street), and walked back through home */
      await phase('moon: open')
      const md = await evaluate(`(() => { const v = window.__sandboxCamera.position.clone(); return window.__outside.moonPortal.skyMoon(v) ? v.toArray() : null })()`)
      if (!md) console.log('  no Moon in the sky  <-- WRONG')
      else {
        await look(Math.atan2(-md[0], -md[2]), Math.asin(md[1]))
        await sleep(400)
        await pShot('moon-0-aim')
        await click('Mouse2')
        const o = await evaluate(`(() => { const p = window.__tools.portals.list[1]; return p ? [p.level, p.site, p.ready] : null })()`)
        console.log(`  orange: ${o ? o.join(', ') : 'none  <-- WRONG'}`)
        const t0 = Date.now()
        await waitFor(() => evaluate('window.__tools.portals.list[1]?.ready'), 400, 100, 'the Moon made ready').catch(() => {})
        console.log(`  the far side ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
        const face = async (p, back, name) => {
          const x = p.pos[0] + p.n[0] * back
          const z = p.pos[2] + p.n[2] * back
          const gy = await evaluate(`window.__levels.current.groundYAt(${x}, ${z})`)
          await tpFeet(x, z, gy + 0.2, Math.atan2(p.n[0], p.n[2]))
          await sleep(1600)
          const c = await here()
          await look(Math.atan2(-(p.pos[0] - c[0]), -(p.pos[2] - c[2])), Math.atan2(p.pos[1] + 0.8 - c[1], back))
          await sleep(900)
          if (name) await pShot(name)
        }
        await phase('moon: look through')
        await face(blue, 7, 'moon-1-the-moon-through-blue')
        const cost = async (label) => {
          const r = await evaluate(`(async () => {
            const gl = window.__renderer.getContext()
            const raf = window.requestAnimationFrame
            const t = []; let passes = 0, n = 0
            window.requestAnimationFrame = (cb) => raf((ts) => {
              const t0 = performance.now(); cb(ts); gl.finish(); const dt = performance.now() - t0
              if (dt > 0.4) { t.push(dt); passes += window.__tools.portalView.stats.passes; n++ }
            })
            await new Promise((r) => setTimeout(r, 3000))
            window.requestAnimationFrame = raf
            t.sort((a, b) => a - b)
            return { mean: t.reduce((a, b) => a + b, 0) / Math.max(1, t.length), med: t[t.length >> 1] ?? 0, n: t.length, passes: passes / Math.max(1, n) }
          })()`)
          console.log(`  ${label.padEnd(34)} ${r.mean.toFixed(2)} ms mean, ${r.med.toFixed(2)} median over ${r.n} frames; ${r.passes.toFixed(2)} views/frame`)
          return r
        }
        const withMoon = await cost('the Moon through blue')
        await look(null, -1.2)
        await sleep(600)
        const without = await cost('same spot, looking down')
        console.log(`  the Moon's view costs ${(withMoon.mean - without.mean).toFixed(2)} ms a frame (mean)`)
        await face(blue, 5, null)
        await phase('moon: the trip')
        const n0 = await evaluate('window.__portalWalk.last.count')
        await hold('KeyW', true)
        await waitFor(() => evaluate(`window.__portalWalk.last.count > ${n0}`), 80, 100, 'into blue').catch(() => {})
        await hold('KeyW', false)
        await sleep(1500)
        const lv = await evaluate('window.__levels.current.id')
        const c = await here()
        console.log(`  through: level ${lv}, at ${f1(c)}`)
        await look(null, 0.12)
        await sleep(900)
        await pShot('moon-2-arrived')
        await rim(1, 'orange on the slab')
        await sideOn(1, 'moon-side-slab')
        // turned round: the slab, and home through it
        const sp = await evaluate(`(() => { const p = window.__tools.portals.list[1]; return { pos: p.pos.toArray(), n: p.n.toArray() } })()`)
        await face(sp, 8, 'moon-3-home-through-the-slab')
        console.log('  ' + await evaluate(`(() => { const s = window.__tools.portalView.stats; return 'moon side: ' + s.passes + ' live views' })()`))
        if (has('debug')) {
          const b64 = await evaluate(`(() => {
            const rt = window.__portalMoon.snapshot; if (!rt) return ''
            const r = window.__renderer, w = rt.width, h = rt.height, px = new Uint16Array(w * h * 4)
            r.readRenderTargetPixels(rt, 0, 0, w, h, px)
            const f = (u) => { const e = (u >> 10) & 31, m = u & 1023; const v = e === 0 ? m / 1024 * 2 ** -14 : e === 31 ? 65504 : (1 + m / 1024) * 2 ** (e - 15); return (u & 0x8000) ? -v : v }
            const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); const img = g.createImageData(w, h)
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = ((h - 1 - y) * w + x) * 4, j = (y * w + x) * 4
              for (let k = 0; k < 3; k++) img.data[j + k] = Math.min(255, Math.pow(Math.max(0, f(px[i + k])), 1 / 2.2) * 255 * 2)
              img.data[j + 3] = 255 }
            g.putImageData(img, 0, 0); return c.toDataURL('image/png').split(',')[1] })()`)
          if (b64) writeFileSync(join(P_OUT, 'debug-snapshot.png'), Buffer.from(b64, 'base64'))
          console.log('    snapshot: ' + await evaluate(`(() => {
            const rt = window.__portalMoon.snapshot; if (!rt) return 'none'
            const r = window.__renderer, w = rt.width, px = new Uint16Array(4)
            const probe = (x, y) => { r.readRenderTargetPixels(rt, x, y, 1, 1, px); return Array.from(px).map((v) => v.toString(16)).join('/') }
            const m = window.__scene.getObjectByName('portal-orange')?.material ?? window.__scene.getObjectByName('portal-blue')?.material
            const M = m.uniforms.uSnapM.value, V = window.__sandboxCamera.position.constructor
            const c = [[0, 0], [0.5, 0], [0, 0.5]].map(([x, y]) => { const e = M.elements
              const v = [x, y, 1, 1].map((_, r) => e[r] * x + e[4 + r] * y + e[8 + r] + e[12 + r])
              return (v[0] / v[3] * 0.5 + 0.5).toFixed(2) + ',' + (v[1] / v[3] * 0.5 + 0.5).toFixed(2) + ' w' + v[3].toExponential(1) })
            return 'centre ' + probe(w >> 1, w >> 1) + ' low ' + probe(w >> 1, w >> 3) + ' mode ' + m?.uniforms.uMode.value +
              ' uv ' + c.join('  ') + ' map ' + (m.uniforms.uMap.value === rt.texture) + ' res ' + m.uniforms.uRes.value.toArray()
          })()`))
        }
        await evaluate('window.__sandbox.console.host.thirdPerson(true)')
        await sleep(1200)
        await pShot('moon-3b-slab-third-person')
        await evaluate('window.__sandbox.console.host.thirdPerson(false)')
        await face(sp, 5, null)
        await phase('moon: home')
        const n1 = await evaluate('window.__portalWalk.last.count')
        await hold('KeyW', true)
        await waitFor(() => evaluate(`window.__portalWalk.last.count > ${n1}`), 80, 100, 'into orange').catch(() => {})
        await hold('KeyW', false)
        await sleep(1500)
        console.log(`  home: level ${await evaluate('window.__levels.current.id')}, at ${f1(await here())}`)
        await pShot('moon-4-home')

        /* Back to the Moon the same way, and there: a pair on the Moon's
           own ground seeing through each other, then a shot at the Earth
           hanging in the sky, which must open on the Earth (the garage door
           at home), walked through and back */
        await phase('moon: again')
        await face(blue, 5, null)
        const n2 = await evaluate('window.__portalWalk.last.count')
        await hold('KeyW', true)
        await waitFor(() => evaluate(`window.__portalWalk.last.count > ${n2}`), 80, 100, 'into blue again').catch(() => {})
        await hold('KeyW', false)
        await sleep(1500)
        console.log(`  back on the Moon: level ${await evaluate('window.__levels.current.id')}`)
        await phase('moon: a pair on the Moon')
        await evaluate('window.__tools.portals.close(); true')
        const mc = await here()
        await tpFeet(mc[0] - 14, mc[2], await evaluate(`window.__levels.current.groundYAt(${mc[0] - 14}, ${mc[2]})`) + 0.1, Math.PI / 2)
        await sleep(1200)
        // blue on the ground a few units ahead, orange further on
        await look(Math.PI / 2, -0.75)
        await click('Mouse0')
        await look(Math.PI / 2, -0.28)
        await click('Mouse2')
        const mp = await evaluate(`[0, 1].map((c) => { const p = window.__tools.portals.list[c]; return p ? [p.level, p.pos.toArray().map((n) => +n.toFixed(1)), p.n.toArray().map((n) => +n.toFixed(2))] : null })`)
        console.log(`  on the Moon's ground: blue ${JSON.stringify(mp[0])}, orange ${JSON.stringify(mp[1])}${mp[0] && mp[1] ? '' : '  (why: ' + await evaluate('window.__tools.portals.why') + ')'}`)
        if (mp[0] && mp[1]) {
          // look into blue from beside it: through it, up out of orange
          await look(Math.PI / 2, -0.95)
          await sleep(900)
          console.log(`  looking into blue: ${await evaluate('window.__tools.portalView.stats.passes')} live view(s)`)
          await pShot('moon-5-pair-on-the-moon')
          await evaluate('window.__sandbox.console.host.thirdPerson(true)')
          await look(Math.PI / 2, -0.5)
          await sleep(1200)
          await pShot('moon-5b-pair-on-the-moon-third')
          await evaluate('window.__sandbox.console.host.thirdPerson(false)')
        }
        await phase('moon: the Earth')
        const ed = await evaluate(`(() => { const v = window.__sandboxCamera.position.clone(); const r = window.__outside.moonPortal.skyEarth(v); return r > 0 ? v.toArray() : null })()`)
        if (!ed) console.log('  no Earth in the sky  <-- WRONG')
        else {
          await look(Math.atan2(-ed[0], -ed[2]), Math.asin(ed[1]))
          await sleep(500)
          await click('Mouse0')
          const eb = await evaluate('(() => { const p = window.__tools.portals.list[0]; return p ? [p.level, p.pos.toArray().map((n) => +n.toFixed(1))] : null })()')
          console.log(`  blue fired at the Earth: ${eb ? JSON.stringify(eb) : 'nothing  <-- WRONG'} (${await evaluate('window.__tools.portals.why')})`)
          const op = await evaluate(`(() => { const p = window.__tools.portals.list[1]; return p ? { pos: p.pos.toArray(), n: p.n.toArray() } : null })()`)
          if (eb && op) {
            // orange (on the Moon's ground) shows the Earth's snapshot
            await tpFeet(op.pos[0] - 5, op.pos[2] + 1, await evaluate(`window.__levels.current.groundYAt(${op.pos[0] - 5}, ${op.pos[2] + 1})`) + 0.1, 0)
            await sleep(1000)
            {
              const c = await here()
              await look(Math.atan2(-(op.pos[0] - c[0]), -(op.pos[2] - c[2])), Math.atan2(op.pos[1] - c[1], Math.hypot(op.pos[0] - c[0], op.pos[2] - c[2])))
            }
            await sleep(800)
            await pShot('moon-6-earth-through-orange')
            // and into it: a floor portal on the Moon, out of the garage door
            const n3 = await evaluate('window.__portalWalk.last.count')
            await tpFeet(op.pos[0], op.pos[2], op.pos[1] + 5, 0)
            await waitFor(() => evaluate(`window.__portalWalk.last.count > ${n3}`), 80, 100, 'into orange on the Moon').catch(() => {})
            await sleep(1600)
            console.log(`  through orange: level ${await evaluate('window.__levels.current.id')}, at ${f1(await here())}`)
            await look(Math.PI, 0.05)
            await sleep(900)
            await pShot('moon-7-out-of-the-garage-door')
          }
        }
      }
    }
    if (blue && orange) {
      // 3. each looked through from nine units out
      const faceIt = async (p, name, back = 9) => {
        const x = p.pos[0] + p.n[0] * back
        const z = p.pos[2] + p.n[2] * back
        const gy = await evaluate(`window.__levels.current.groundYAt(${x}, ${z})`)
        await tpFeet(x, z, gy + 0.2, Math.atan2(p.n[0], p.n[2]))
        await sleep(1600)
        const c = await here()
        await look(Math.atan2(-(p.pos[0] - c[0]), -(p.pos[2] - c[2])), Math.atan2(p.pos[1] - c[1], back))
        await sleep(900)
        if (name) await pShot(name)
      }
      await phase('look through')
      // from a slant first, which is where a portal floating off its wall
      // would show
      {
        const r = [blue.up[1] * blue.n[2] - blue.up[2] * blue.n[1], 0, blue.up[0] * blue.n[1] - blue.up[1] * blue.n[0]]
        const x = blue.pos[0] + blue.n[0] * 4 + r[0] * 5
        const z = blue.pos[2] + blue.n[2] * 4 + r[2] * 5
        const gy = await evaluate(`window.__levels.current.groundYAt(${x}, ${z})`)
        await tpFeet(x, z, gy + 0.2, 0)
        await sleep(1400)
        const c = await here()
        await look(Math.atan2(-(blue.pos[0] - c[0]), -(blue.pos[2] - c[2])), Math.atan2(blue.pos[1] - c[1], Math.hypot(blue.pos[0] - c[0], blue.pos[2] - c[2])))
        await sleep(900)
        await pShot('3a-blue-slant')
      }
      await faceIt(blue, '3-through-blue')
      /* the frame cost of that view: every animation frame's callback timed
         with a gl.finish() behind it, so the GPU's share is inside, with the
         views drawn and the pixels they covered; then the same view with the
         orange portal closed (so no pass), and orange put back */
      const frameCost = async (label) => {
        const r = await evaluate(`(async () => {
          const gl = window.__renderer.getContext()
          const raf = window.requestAnimationFrame
          const t = []; let passes = 0, px = 0, n = 0
          window.requestAnimationFrame = (cb) => raf((ts) => {
            const t0 = performance.now(); cb(ts); gl.finish(); const dt = performance.now() - t0
            if (dt > 0.4) { t.push(dt); const s = window.__tools.portalView.stats; passes += s.passes; px += s.pixels; n++ }
          })
          await new Promise((r) => setTimeout(r, 3000))
          window.requestAnimationFrame = raf
          t.sort((a, b) => a - b)
          const mean = t.reduce((a, b) => a + b, 0) / Math.max(1, t.length)
          return { n: t.length, mean, med: t[t.length >> 1] ?? 0, p95: t[Math.floor(t.length * 0.95)] ?? 0,
            passes: passes / Math.max(1, n), px: px / Math.max(1, n) }
        })()`)
        console.log(`  ${label.padEnd(34)} ${r.mean.toFixed(2)} ms mean, ${r.med.toFixed(2)} median, ${r.p95.toFixed(2)} p95 ` +
          `over ${r.n} frames; ${r.passes.toFixed(2)} views/frame covering ${Math.round(r.px)} px`)
        return r
      }
      const on = await frameCost('blue on screen, looked through')
      await evaluate('window.__keepOrange = window.__tools.portals.list[1]; window.__tools.portals.close(1); true')
      await sleep(500)
      const off = await frameCost('same view, orange closed')
      await evaluate(`(() => { const o = window.__keepOrange; window.__tools.portals.placeAt(1, o.level, o.pos, o.n, o.up, null, o.hosts); return true })()`)
      console.log(`  an on-screen portal costs ${(on.mean - off.mean).toFixed(2)} ms a frame (mean), ${(on.med - off.med).toFixed(2)} (median)`)
      await sleep(600)
      await faceIt(orange, '4-through-orange')

      // 4. walked through: into blue, out of orange
      await phase('walk through')
      await faceIt(blue, null, 6)
      const n0 = await evaluate('window.__portalWalk.last.count')
      await hold('KeyW', true)
      await waitFor(() => evaluate(`window.__portalWalk.last.count > ${n0}`), 60, 100, 'the walk through').catch(() => {})
      await sleep(250)
      await hold('KeyW', false)
      const w = await evaluate('(() => { const l = window.__portalWalk.last; return [l.vin.toArray(), l.vout.toArray(), l.count] })()')
      console.log(`  walked through: in ${f1(w[0])}  out ${f1(w[1])}  (${w[2] - n0} carries)`)
      await sleep(400)
      await pShot('5-walked-out-of-orange')

      // 5. the fling: blue moved onto the ground in front of orange's wall,
      // a drop from 30 up into it, out of orange's wall at speed
      await phase('fling')
      const ox = orange.pos[0] + orange.n[0] * 14
      const oz = orange.pos[2] + orange.n[2] * 14
      const og = await evaluate(`window.__levels.current.groundYAt(${ox}, ${oz})`)
      await tpFeet(ox, oz, og + 0.2, Math.atan2(orange.n[0], orange.n[2]))
      await sleep(1500)
      // blue on the ground a few units ahead, looking steeply down
      await look(Math.atan2(orange.n[0], orange.n[2]) + Math.PI, -1.05)
      await click('Mouse0')
      const floor = await portalAt(0)
      console.log(`  blue on the ground: ${floor ? `${f1(floor.pos)}  facing ${f1(floor.n)}` : 'none'}`)
      if (floor && floor.n[1] > 0.6) {
        await rim(0, 'blue on the ground')
        const back = await here()
        await sideOn(0, 'side-floor-blue')
        await tpFeet(back[0], back[2], back[1] - 3.84, 0)
        await sleep(800)
      }
      if (floor && floor.n[1] > 0.6) {
        const n1 = await evaluate('window.__portalWalk.last.count')
        await tpFeet(floor.pos[0], floor.pos[2], floor.pos[1] + 30, 0)
        await look(null, -1.3)
        await sleep(900)
        await pShot('6-falling-into-blue')
        await waitFor(() => evaluate(`window.__portalWalk.last.count > ${n1}`), 60, 50, 'the fall through').catch(() => {})
        const f = await evaluate('(() => { const l = window.__portalWalk.last; return [l.vin.toArray(), l.vout.toArray()] })()')
        const sp = (v) => Math.hypot(v[0], v[1], v[2]).toFixed(1)
        console.log(`  fling: in ${f1(f[0])} (${sp(f[0])} u/s)  out ${f1(f[1])} (${sp(f[1])} u/s)`)
        await look(null, 0)
        await sleep(250)
        await pShot('7-flung-out-of-orange')
        // where the flight came down, measured from the wall
        await sleep(2500)
        const land = await here()
        console.log(`  landed ${Math.hypot(land[0] - orange.pos[0], land[2] - orange.pos[2]).toFixed(1)} units out from the orange wall`)

        // 6. a crate through the same pair
        await phase('prop')
        await evaluate(`window.__propPass = 0; window.__tools.portals.on((e) => { if (e.type === 'pass' && e.prop >= 0) { window.__propPass++; window.__propOut = e.point.toArray() } }); true`)
        await tpFeet(orange.pos[0] + orange.n[0] * 12 + orange.up[0], orange.pos[2] + orange.n[2] * 12, og + 0.2, 0)
        await sleep(1200)
        const c2 = await here()
        await look(Math.atan2(-(orange.pos[0] - c2[0]), -(orange.pos[2] - c2[2])), 0.02)
        await evaluate(`(() => { const sb = window.__sandbox; window.__crate = sb.spawn('crate', { x: ${floor.pos[0]}, y: ${floor.pos[1] + 9}, z: ${floor.pos[2]} }); return true })()`)
        await waitFor(() => evaluate('window.__propPass > 0'), 60, 50, 'the crate through').catch(() => {})
        await sleep(160)
        await pShot('8-crate-out-of-orange')
        const cp = await evaluate(`(() => { const sb = window.__sandbox, v = window.__sandboxCamera.position.clone(); sb.getVelocity(window.__crate, v); const p = v.clone(); sb.getTransform(window.__crate, p); return [p.toArray(), v.toArray()] })()`)
        console.log(`  crate: ${await evaluate('window.__propPass')} pass(es), out at ${f1(cp[0])} moving ${f1(cp[1])}`)
      }
    }
    if (!moonTrip) {
      /* Two shots that must not open anything: a lamp post (its guard box
         is a collision face with a pole a few centimetres across drawn in
         it), and a collision face with nothing drawn behind it. Each must
         fizzle, or land on a real surface past it, flush */
      await phase('fizzles')
      await evaluate('window.__tools.portals.close(); window.__pEv.length = 0; true')
      const c0 = await here()
      const pole = await evaluate(`(() => { let best = null, bd = 1e9
        for (const b of window.__obstacles) { const w = b.max.x - b.min.x, d = b.max.z - b.min.z, h = b.max.y - b.min.y
          if (w > 0.9 || d > 0.9 || w < 0.05 || h < 4) continue
          const x = (b.min.x + b.max.x) / 2, z = (b.min.z + b.max.z) / 2, dd = Math.hypot(x - ${c0[0]}, z - ${c0[2]})
          if (dd < bd) { bd = dd; best = [x, b.min.y, z, b.max.y] } }
        return best })()`)
      const shootAt = async (tx, ty, tz, from, label) => {
        const gy = await evaluate(`window.__levels.current.groundYAt(${from[0]}, ${from[1]})`)
        await tpFeet(from[0], from[1], gy + 0.2, 0)
        await sleep(1200)
        const c = await here()
        await look(Math.atan2(-(tx - c[0]), -(tz - c[2])), Math.atan2(ty - c[1], Math.hypot(tx - c[0], tz - c[2])))
        await sleep(500)
        await evaluate('window.__tools.portals.close(); window.__pEv.length = 0; true')
        await click('Mouse0')
        const ev = await evaluate('window.__pEv.join(" ")')
        const p = await portalAt(0)
        if (!p) console.log(`  ${label}: ${/fizzle/.test(ev) ? 'fizzled' : 'nothing opened'} (${ev || 'no event'})`)
        else {
          const g = await evaluate('window.__rimGap(0)')
          const d = Math.hypot(p.pos[0] - tx, p.pos[2] - tz)
          console.log(`  ${label}: opened ${d.toFixed(1)} u from the aim point, rim gap ${g.worst.toFixed(3)}, ${g.miss} misses` +
            (g.miss === 0 && g.worst < 0.05 && d > 1 ? ' (a real surface behind it)' : '  <-- WRONG'))
        }
        await pShot(label.replace(/\W+/g, '-'))
      }
      if (!pole) console.log('  no lamp post near  <-- WRONG')
      else await shootAt(pole[0], pole[1] + 2.4, pole[2], [pole[0] + 5, pole[2] + 0.5], 'fizzle-lamp-post')
      // a box face with nothing drawn within three units behind it
      const empty = await evaluate(`(() => { const V = window.__sandboxCamera.position.constructor, c = window.__sandboxCamera.position
        const boxes = window.__obstacles.filter((b) => b.max.y - b.min.y > 2.5 && Math.hypot((b.min.x + b.max.x) / 2 - c.x, (b.min.z + b.max.z) / 2 - c.z) < 110)
        boxes.sort((a, b) => Math.hypot((a.min.x + a.max.x) / 2 - c.x, (a.min.z + a.max.z) / 2 - c.z) - Math.hypot((b.min.x + b.max.x) / 2 - c.x, (b.min.z + b.max.z) / 2 - c.z))
        for (const b of boxes.slice(0, 90)) {
          const w = b.max.x - b.min.x, d = b.max.z - b.min.z
          const faces = [[1, 0, b.max.x, (b.min.z + b.max.z) / 2, d], [-1, 0, b.min.x, (b.min.z + b.max.z) / 2, d], [0, 1, (b.min.x + b.max.x) / 2, b.max.z, w], [0, -1, (b.min.x + b.max.x) / 2, b.min.z, w]]
          for (const [nx, nz, fx, fz, span] of faces) {
            if (span < 3.2) continue
            const y = Math.min(b.min.y + 2.6, b.max.y - 0.5)
            const x = nx ? fx : fx, z = nz ? fz : fz
            const o = new V(x + nx * 0.5, y, z + nz * 0.5)
            if (window.__drawnHit(o, new V(-nx, 0, -nz), 3.5) >= 0) continue
            return { x, y, z, nx, nz }
          }
        }
        return null })()`)
      // and the spot the owner saw an orange portal hanging over the
      // pavement (before the fit answered to what is drawn), shot the same way
      await shootAt(-15.7, 2.0, -272.4, [-15.7, -281.4], 'fizzle-or-flush-old-floating-spot')
      if (!empty) console.log('  no empty collision face near (every box nearby has a drawn wall in it)')
      else await shootAt(empty.x, empty.y, empty.z, [empty.x + empty.nx * 7, empty.z + empty.nz * 7], 'fizzle-empty-box-face')
    }
    }
    const plinks = await evaluate('window.__pLinks')
    console.log(`  ${plinks.length} programs linked from the catalogue on${plinks.length ? ': ' + plinks.join(', ') : ''}`)
  }

  if (WHAT.includes('throw')) {
    /*
      A thrown machine must land on the ground and stay on top of it. Every
      machine (or --vehicle a,b) is recalled beside you, taken as a prop,
      stood eight units up in front of you and thrown at the ground at
      several speeds and angles, up to far faster than any flick; then its
      pose is sampled every frame for four seconds. It passes when the
      machine's origin (its wheels, skids or keel) never goes more than a
      unit under the drawn ground and the sandbox never had to lift it back
      out (a rescue is the tunnel happening and being hidden).
    */
    console.log('throw')
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await goTo(flag('at', '10 -11.2').replace(',', ' '))
    await sleep(1500)
    await stand()
    const ids = String(flag('vehicle', 'car,boat,heli,ship')).split(',')
    // speed u/s, degrees below the horizon
    const throws = [[20, 30], [60, 45], [150, 60], [300, 80], [600, 45], [900, 89]]
    let bad = 0
    for (const id of ids) {
      for (const [speed, deg] of throws) {
        const r = await evaluate(`(async () => {
          const ID = ${JSON.stringify(id)}
          const f = window.__fleet, sb = window.__sandbox, cam = window.__sandboxCamera.position
          const next = () => new Promise((res) => requestAnimationFrame(res))
          const v = f.all.find((m) => m.id === ID)
          f.recall(ID, cam, window.__fleetEnv())
          for (let i = 0; i < 20; i++) await next()
          const prop = f.take(ID, sb)
          if (!prop) return { err: 'not taken' }
          const yaw = window.__sandboxWalk.yaw
          const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
          const x = cam.x + fx * 14, z = cam.z + fz * 14
          sb.setTransform(prop.id, { x, y: sb.groundY(x, z) + 8, z })
          const a = ${deg} * Math.PI / 180
          sb.setVelocity(prop.id, { x: fx * Math.cos(a) * ${speed}, y: -Math.sin(a) * ${speed}, z: fz * Math.cos(a) * ${speed} },
            { x: 1.5, y: 0.5, z: -1 })
          let worst = Infinity, rescued = 0, gone = false, frames = 0
          const trace = []
          const t0 = performance.now()
          while (performance.now() - t0 < 4000) {
            await next()
            frames++
            const p = v.root.position
            const d = p.y - sb.groundY(p.x, p.z)
            if (d < worst) worst = d
            if (frames < 40 || frames % 10 === 0) {
              const q = sb.get(prop.id), lv = { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c } }
              if (q) sb.getVelocity(prop.id, lv)
              trace.push(frames + ': ' + [p.x, p.y, p.z, d, lv.y].map((n) => n.toFixed(2)).join(' ') + (q && q.lost ? ' lost' + q.lost : ''))
            }
            const q = sb.get(prop.id)
            if (q) rescued = Math.max(rescued, q.lost)
            else gone = true
          }
          const p = v.root.position
          return { worst, rescued, gone, frames, end: p.y - sb.groundY(p.x, p.z), trace }
        })()`)
        if (r.err) {
          console.log(`  ${id.padEnd(5)} ${r.err}`)
          bad++
          continue
        }
        const ok = r.worst > -1 && r.rescued === 0
        if (!ok) bad++
        if (!ok && has('trace')) console.log(r.trace.join('\n'))
        console.log(`  ${id.padEnd(5)} ${String(speed).padStart(4)} u/s at ${String(deg).padStart(2)} deg: ` +
          `deepest ${r.worst.toFixed(2)}, rests ${r.end.toFixed(2)} over the ground, ${r.rescued} rescues` +
          `${r.gone ? ', prop given up on' : ''} (${r.frames} frames)  ${ok ? 'ok' : 'FAIL'}`)
      }
    }
    console.log(`  ${bad === 0 ? 'PASS' : `FAIL: ${bad} throws went under the ground`}`)
    if (bad) process.exitCode = 1
  }

  if (WHAT.includes('moonfleet')) {
    /*
      The whole fleet on the Moon. Cut to the Moon, the car ordered from the
      catalogue to the crosshair, boarded and driven flat out over the
      craters (its height over the drawn ground printed every second: it
      must never go under), a chase shot mid-drive and one of it parked with
      the Earth in the sky; then taken on the physgun and thrown at the
      regolith, the helicopter and the boat ordered, and home to Earth, where
      the car must be gone until it is ordered again. Every shader link from
      the Moon on is counted (must be 0).
    */
    console.log('moonfleet')
    // every link from here on, and the draw that caused it
    await evaluate(`(() => { window.__mfLinks = 0; for (const c of document.querySelectorAll('canvas')) {
      const gl = c.width && c.getContext('webgl2'); if (!gl || gl.__mfWrapped) continue; gl.__mfWrapped = true
      const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => { window.__mfLinks++; real(p) } }
      const r = window.__renderer, draw = r.renderBufferDirect.bind(r)
      r.renderBufferDirect = (cam, scene, geo, mat, obj, grp) => { const n = window.__mfLinks; draw(cam, scene, geo, mat, obj, grp)
        if (window.__mfLinks > n) { let q = obj, path = []; while (q && path.length < 6) { path.push(q.name || q.type); q = q.parent }
          window.__mfWhat.push((window.__mfPhase || '') + ': ' + path.join('<') + ' as ' + mat.type) } }
      window.__mfWhat = []
      return true })()`)
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    // the painted Earth for the Moon's sky, as the portal gun prepares it
    // (a cut straight there never flew past it), then the cut
    await waitFor(() => evaluate(`(() => { const c = window.__sandboxCamera.position; return window.__outside.moonPortal.prepare(c.x, c.z, 40) })()`), 400, 50, 'the Earth globe')
    await evaluate(`window.__levels.goTo('moon')`)
    await waitFor(() => evaluate(`window.__levels.current.id === 'moon'`), 60, 250, 'the Moon')
    await sleep(5000)
    await stand()
    await evaluate('window.__mfLinks = 0; window.__mfWhat = []')
    const hold = (code, on) => evaluate(`(() => { const k = window.__input.keys; ${on ? `k.add('${code}')` : `k.delete('${code}')`}; return true })()`)
    const carAt = () => evaluate(`(() => { const v = window.__fleet.all.find((m) => m.id === 'car'), p = v.root.position
      const L = window.__levels.current
      return { x: p.x, y: p.y, z: p.z, up: p.y - (L.groundYAt ? L.groundYAt(p.x, p.z) : L.groundY), shown: v.root.visible, level: L.id } })()`)
    const orderIt = async (id) => {
      await tap('KeyQ')
      await sleep(400)
      await waitFor(() => evaluate(`document.querySelectorAll('[data-kind] img').length >= 4`), 60, 250, 'the catalogue icons')
      await evaluate(`(() => { const el = document.querySelector('[data-category="vehicles"]'); el && el.click(); return true })()`)
      await sleep(600)
      const ok = await evaluate(`(() => { const el = document.querySelector('[data-kind="fleet:${id}"]'); el && el.click(); return !!el })()`)
      await sleep(400)
      await tap('Escape')
      await sleep(1200)
      const r = await evaluate(`(() => { const v = window.__fleet.all.find((m) => m.id === '${id}'), p = v.root.position
        const c = window.__sandboxCamera.position, L = window.__levels.current
        return [p.x, p.y, p.z, p.y - L.groundYAt(p.x, p.z), Math.hypot(p.x - c.x, p.z - c.z), v.root.visible] })()`)
      console.log(`  ordered the ${id}${ok ? '' : ' (no plate!)'}: at ${r.slice(0, 3).map((n) => n.toFixed(1)).join(', ')}, ` +
        `${r[3].toFixed(2)} over the ground, ${r[4].toFixed(1)} from you, ${r[5] ? 'shown' : 'HIDDEN  <-- WRONG'}`)
      return r
    }
    // the heading with the most crater in it over the next 150 units: the
    // car is delivered side-on to you, so looking a quarter turn left of it
    // points the car's nose down it
    const crater = await evaluate(`(() => { const L = window.__levels.current, c = window.__sandboxCamera.position
      let best = 0, bestRange = -1
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2, fx = -Math.sin(a), fz = -Math.cos(a)
        let lo = Infinity, hi = -Infinity
        for (let d = 20; d <= 150; d += 5) { const g = L.groundYAt(c.x + fx * d, c.z + fz * d); lo = Math.min(lo, g); hi = Math.max(hi, g) }
        if (hi - lo > bestRange) { bestRange = hi - lo; best = a }
      }
      return [best, bestRange] })()`)
    console.log(`  the most crater: heading ${crater[0].toFixed(2)}, ${crater[1].toFixed(1)} units of relief`)
    await look(crater[0] + Math.PI / 2, -0.3)
    await evaluate(`window.__mfPhase = 'order car'`)
    const car0 = await orderIt('car')
    // beside the driver's door, and in
    const yaw0 = await evaluate(`window.__fleet.all.find((m) => m.id === 'car').yaw`)
    await run(`tp ${(car0[0] + Math.cos(yaw0) * 3.4).toFixed(1)} ${(car0[2] - Math.sin(yaw0) * 3.4).toFixed(1)}`)
    await sleep(1500)
    await tap('KeyE', 150)
    await sleep(1500)
    if (!(await evaluate(`window.__fleet.riding?.id === 'car'`))) console.log('  E did not board the car  <-- WRONG')
    // flat out for ten seconds, a bit of steering, sampled every 0.2 s
    await evaluate(`window.__mfPhase = 'drive'`)
    await hold('KeyW', true)
    let worst = Infinity, airborne = 0, maxUp = 0, gMin = Infinity, gMax = -Infinity, n = 0
    const t = Date.now()
    let shotTaken = false
    while (Date.now() - t < 10000) {
      await hold('KeyA', Date.now() - t > 4000 && Date.now() - t < 5500)
      const s = await evaluate(`(() => { const v = window.__fleet.all.find((m) => m.id === 'car'), p = v.root.position
        const L = window.__levels.current, c = Math.cos(v.yaw), sn = Math.sin(v.yaw)
        // the footprint: under it everywhere is under the ground, and a
        // pit smaller than the car under its middle is not
        let lo = Infinity
        for (const [lx, lz] of [[0, 0], [-1.6, -3.2], [1.6, -3.2], [-1.6, 3.2], [1.6, 3.2]])
          lo = Math.min(lo, L.groundYAt(p.x + lx * c + lz * sn, p.z - lx * sn + lz * c))
        return { x: p.x, y: p.y, z: p.z, up: p.y - lo } })()`)
      const g = s.y - s.up
      worst = Math.min(worst, s.up)
      maxUp = Math.max(maxUp, s.up)
      gMin = Math.min(gMin, g)
      gMax = Math.max(gMax, g)
      if (s.up > 0.8) airborne++
      n++
      if (n % 5 === 0) console.log(`    ${((Date.now() - t) / 1000).toFixed(1)} s  car ${s.x.toFixed(0)}, ${s.y.toFixed(1)}, ${s.z.toFixed(0)}  ${s.up.toFixed(2)} over the ground`)
      if (!shotTaken && Date.now() - t > 3000) {
        shotTaken = true
        await shot('moonfleet-driving')
      }
      await sleep(200)
    }
    await hold('KeyW', false)
    await hold('KeyA', false)
    console.log(`  drove over ground from ${gMin.toFixed(1)} to ${gMax.toFixed(1)}: lowest ${worst.toFixed(2)} over it, ` +
      `highest ${maxUp.toFixed(2)}, off the ground in ${airborne}/${n} samples  ${worst > -0.5 ? 'ok' : 'UNDER THE GROUND  <-- WRONG'}`)
    // stop, out, and stand off with the car between you and the Earth
    await hold('KeyS', true)
    await sleep(3000)
    await hold('KeyS', false)
    await tap('KeyE', 150)
    await sleep(1500)
    // then facing the Earth, the car ordered again onto the ground in front
    // (the drive ends wherever the craters left it, often down in a bowl)
    const earth = () => evaluate(`(() => { const e = window.__scene.getObjectByName('globe-earth'), c = window.__sandboxCamera.position
      const p = e.getWorldPosition(c.clone()).sub(c).normalize(); return [p.x, p.y, p.z] })()`)
    const ed = await earth()
    const earthYaw = Math.atan2(-ed[0], -ed[2])
    await look(earthYaw, -0.35)
    await orderIt('car')
    // pitched between the two, so the car and the Earth share the frame
    const toCar = await evaluate(`(() => { const p = window.__fleet.all.find((m) => m.id === 'car').root.position, c = window.__sandboxCamera.position
      const d = p.clone().sub(c); return [Math.atan2(-d.x, -d.z), Math.atan2(d.y + 1, Math.hypot(d.x, d.z))] })()`)
    await look(earthYaw, (toCar[1] + Math.asin(ed[1])) * 0.5)
    await sleep(600)
    await shot('moonfleet-parked-earth')
    // the physgun: taken and thrown at the regolith
    await evaluate(`window.__mfPhase = 'throw'`)
    let bad = 0
    for (const [speed, deg] of [[40, 30], [300, 70], [900, 89]]) {
      const r = await evaluate(`(async () => {
        const f = window.__fleet, sb = window.__sandbox, cam = window.__sandboxCamera.position
        const next = () => new Promise((res) => requestAnimationFrame(res))
        const v = f.all.find((m) => m.id === 'car')
        f.recall('car', cam, window.__fleetEnv())
        for (let i = 0; i < 20; i++) await next()
        const prop = f.take('car', sb)
        if (!prop) return { err: 'not taken' }
        const yaw = window.__sandboxWalk.yaw
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
        const x = cam.x + fx * 14, z = cam.z + fz * 14
        sb.setTransform(prop.id, { x, y: sb.groundY(x, z) + 8, z })
        const a = ${deg} * Math.PI / 180
        sb.setVelocity(prop.id, { x: fx * Math.cos(a) * ${speed}, y: -Math.sin(a) * ${speed}, z: fz * Math.cos(a) * ${speed} }, { x: 1.5, y: 0.5, z: -1 })
        let worst = Infinity, rescued = 0
        const t0 = performance.now()
        while (performance.now() - t0 < 6000) {
          await next()
          const p = v.root.position
          worst = Math.min(worst, p.y - sb.groundY(p.x, p.z))
          const q = sb.get(prop.id)
          if (q) rescued = Math.max(rescued, q.lost)
        }
        const p = v.root.position
        return { worst, rescued, end: p.y - window.__levels.current.groundYAt(p.x, p.z), carried: !!sb.get(prop.id) }
      })()`)
      if (r.err) { console.log(`  thrown: ${r.err}  <-- WRONG`); bad++; continue }
      const ok = r.worst > -1 && r.rescued === 0
      if (!ok) bad++
      console.log(`  car thrown at ${speed} u/s, ${deg} deg: deepest ${r.worst.toFixed(2)}, rests ${r.end.toFixed(2)} over the ground, ` +
        `${r.rescued} rescues, ${r.carried ? 'still a prop' : 'handed back'}  ${ok ? 'ok' : 'FAIL'}`)
    }
    await sleep(1500)
    await look(0, -0.3)
    await evaluate(`window.__mfPhase = 'heli boat'`)
    await orderIt('heli')
    await look(Math.PI / 2, -0.3)
    await orderIt('boat')
    await look(Math.PI * 0.25, -0.15)
    await sleep(500)
    await shot('moonfleet-heli-boat')
    const links = await evaluate('window.__mfLinks')
    // (and what linked, and on which draw)
    if (links) console.log('    ' + (await evaluate(`(window.__mfWhat || []).join('\\n    ')`)))
    // home: the car stays on the Moon
    await evaluate(`window.__levels.goTo('overworld')`)
    await waitFor(() => evaluate(`window.__levels.current.id === 'overworld'`), 60, 250, 'the Earth')
    await sleep(3000)
    const home = await carAt()
    console.log(`  back on Earth the car is ${home.shown ? 'SHOWN  <-- WRONG' : 'not here'} (left at ${home.x.toFixed(0)}, ${home.z.toFixed(0)})`)
    await look(0, -0.3)
    const again = await orderIt('car')
    console.log(`  ordered on Earth: ${again[5] && again[4] < 40 ? 'here' : 'NOT HERE  <-- WRONG'}`)
    console.log(`  shader links on the Moon: ${links}${links ? '  <-- WRONG' : ''}; throws ${bad ? 'FAIL' : 'ok'}`)
    if (bad || links) process.exitCode = 1
  }

  if (WHAT.includes('roofs')) {
    /*
      Flying up onto a building and letting go of noclip there, the way the
      owner wants to sit on the town. At home and downtown, roofs are picked
      off the live collision set by what they are (a flat roof: a standable
      top eight or more units over the ground; a pitched one: a roof slope,
      collision.ts's Ramp, including the house's own), and each is landed on
      twice: dropped from five units over it, and let go of with the feet a
      unit and a half *inside* the building (or, where the roof is over a room
      rather than a solid mass, a hand under its surface), which used to push
      the body out of the nearest wall and down to the street. It passes when, two
      seconds after v, the feet stand on the roof at that spot (within 0.35
      of its surface) every time. A third-person shot of each first landing
      goes to --out as roofs-*.png.
    */
    console.log('roofs')
    const host = 'window.__sandbox.console.host'
    let bad = 0
    const topFn = `const topAt = (b, x, z) => { const r = b.ramp; if (!r) return b.max.y;
      const t = r.axis === 'x' ? (x - b.min.x) / (b.max.x - b.min.x) : (z - b.min.z) / (b.max.z - b.min.z);
      return r.lo + (r.hi - r.lo) * Math.min(1, Math.max(0, t)) }`
    for (const [where, kinds] of [['10 -11.2', ['home', 'pitched', 'pitched']], [flag('fly-at', '-32 -331').replace(',', ' '), ['flat', 'low', 'pitched']]]) {
      await evaluate(`${host}.noclip(false)`)
      await goTo(where)
      await sleep(2500)
      await stand()
      // measured in first person: in third the lens is a boom away from the head
      await evaluate(`${host}.thirdPerson(false)`)
      const picks = await evaluate(`(() => {
        ${topFn}
        const L = window.__levels.current, c = window.__sandboxCamera.position
        const boxes = L.collision.boxes
        const g = (x, z) => L.groundYAt ? L.groundYAt(x, z) : 0
        const out = [], used = new Set()
        const kinds = ${JSON.stringify(kinds)}
        for (const kind of kinds) {
          let best = null, bestD = Infinity
          for (const b of boxes) {
            if (used.has(b) || b.hull || b.noStand || b.max.y <= b.min.y) continue
            const sx = b.max.x - b.min.x, sz = b.max.z - b.min.z
            const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2
            const d = Math.hypot(cx - c.x, cz - c.z)
            if (d > 110) continue
            if (kind === 'flat' || kind === 'low') {
              if (b.ramp || sx < 6 || sz < 6 || b.max.y - g(cx, cz) < 8) continue
            } else if (kind === 'home') {
              if (!b.ramp || Math.hypot(cx, cz - 11) > 16) continue
            } else if (!b.ramp || b.max.y - g(cx, cz) < 4 || Math.min(sx, sz) < 2 || Math.hypot(cx, cz - 11) < 30) continue
            // the tallest flat roof in reach and the lowest, the nearest slope
            const score = kind === 'flat' ? -b.max.y : kind === 'low' ? b.max.y : d
            if (score < bestD) { bestD = score; best = b }
          }
          if (!best) { out.push(null); continue }
          used.add(best)
          // a third of the way up a slope from its eave, or on a flat top the
          // first spot nothing stands over (a setback's terrace has the next
          // stage standing on most of it, a roof its bulkhead and tank)
          const r = best.ramp
          let x = (best.min.x + best.max.x) / 2, z = (best.min.z + best.max.z) / 2
          if (r) {
            const k = r.lo < r.hi ? 0.35 : 0.65
            if (r.axis === 'x') x = best.min.x + (best.max.x - best.min.x) * k
            else z = best.min.z + (best.max.z - best.min.z) * k
          } else {
            const covered = (px, pz) => boxes.some((o) => o !== best && o.max.y > o.min.y && !o.hull &&
              px > o.min.x - 1 && px < o.max.x + 1 && pz > o.min.z - 1 && pz < o.max.z + 1 &&
              topAt(o, px, pz) > best.max.y + 0.6 && o.min.y < best.max.y + 6)
            search: for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
              const px = best.min.x + 1.5 + (best.max.x - best.min.x - 3) * (i / 6)
              const pz = best.min.z + 1.5 + (best.max.z - best.min.z - 3) * (j / 6)
              if (!covered(px, pz)) { x = px; z = pz; break search }
            }
          }
          // what a landing there should stand on: the highest standable top
          // at the spot under the drop (a stage over the one picked, say)
          let top = topAt(best, x, z)
          for (const b of boxes) {
            if (b.hull || b.noStand || b.max.y <= b.min.y) continue
            if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue
            const t = topAt(b, x, z)
            if (t > top && t < top + 4.5) top = t
          }
          // is there solid building a unit and a half under the roof here, or
          // a room (a garage, a porch under its canopy)? Letting go in a room
          // rightly drops you into it, so there the test dips the feet just
          // under the roof's own surface instead
          const solid = boxes.some((b) => !b.hull && b.max.y > b.min.y && x > b.min.x && x < b.max.x &&
            z > b.min.z && z < b.max.z && b.min.y <= top - 1.5 && topAt(b, x, z) > top - 1.5)
          out.push({ kind, x, z, top, ground: g(x, z), dip: solid ? 1.5 : 0.2 })
        }
        return { picks: out, boxes: boxes.length, ramps: boxes.filter((b) => b.ramp).length }
      })()`)
      console.log(`  near ${where}: ${picks.boxes} boxes in the set, ${picks.ramps} of them roof slopes`)
      for (const p of picks.picks) {
        if (!p) {
          console.log('  (no roof of that kind in reach)')
          bad++
          continue
        }
        for (const [how, dy] of [['dropped from 5 over', 5], [`let go ${p.dip} inside`, -p.dip]]) {
          await evaluate(`${host}.noclip(true)`)
          await sleep(200)
          await evaluate(`${host}.teleport(${p.x}, ${p.z}, ${p.top + dy})`)
          await sleep(500)
          await evaluate(`${host}.noclip(false)`)
          await sleep(2000)
          const r = await evaluate(`(() => {
            ${topFn}
            const w = window.__sandboxWalk, c = window.__sandboxCamera.position
            const L = window.__levels.current
            let top = -Infinity
            for (const b of L.collision.boxes) {
              if (b.noStand || b.hull || b.max.y <= b.min.y) continue
              if (c.x < b.min.x || c.x > b.max.x || c.z < b.min.z || c.z > b.max.z) continue
              const t = topAt(b, c.x, c.z)
              if (t <= w.feetY + 0.6 && t > top) top = t
            }
            return { feet: w.feetY, top, moved: Math.hypot(c.x - ${p.x}, c.z - ${p.z}), noclip: w.noclip }
          })()`)
          const ok = Math.abs(r.feet - p.top) < 0.35 && r.moved < 1.5
          if (!ok) bad++
          if (!ok && has('debug')) {
            console.log(await evaluate(`(() => {
              const L = window.__levels.current, x = ${p.x}, z = ${p.z}
              return L.collision.boxes.filter((b) => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z)
                .map((b) => [b.min.y.toFixed(2), b.max.y.toFixed(2), b.noStand ? 'noStand' : '', b.ramp ? JSON.stringify(b.ramp) : '',
                  [b.min.x, b.max.x, b.min.z, b.max.z].map((n) => n.toFixed(1)).join(',')].join(' ')).join('\\n')
            })()`))
          }
          console.log(`  ${p.kind.padEnd(8)} roof ${(p.top - p.ground).toFixed(1).padStart(5)} over the ground, ` +
            `${how.padEnd(20)}: feet ${(r.feet - p.top >= 0 ? '+' : '') + (r.feet - p.top).toFixed(2)} ` +
            `from the roof, ${r.moved.toFixed(2)} from the spot  ${ok ? 'ok' : 'FAIL'}`)
          if (how.startsWith('dropped')) {
            await evaluate(`${host}.thirdPerson(true)`)
            await sleep(700)
            await shot(`roofs-${p.kind}-${Math.round(p.top - p.ground)}`)
            await evaluate(`${host}.thirdPerson(false)`)
            await sleep(300)
          }
        }
      }
    }
    await evaluate(`${host}.thirdPerson(false)`)
    console.log(`  ${bad === 0 ? 'PASS' : `FAIL: ${bad} landings did not end on the roof`}`)
    if (bad) process.exitCode = 1
  }

  if (WHAT.includes('flycam')) {
    /*
      A steady noclip flight in third person, measured rather than filmed:
      every rendered frame, the body's height against the lens's. A chase
      camera that follows the body smoothly keeps that gap steady (it may
      drift as the flight speeds up or slows, never jump), so the number is
      the biggest change in it from one frame to the next, per leg of the
      flight: straight up on space, up fast, a climb and a dive along the
      view, level cruise and straight down on c. It passes under a tenth of
      a unit a frame; the anchor that used to snap back to the head each
      time it trailed by 1.2 units moved it by a whole unit at a time.
    */
    console.log('flycam')
    await goTo(flag('fly-at', '-32 -331').replace(',', ' '))
    await sleep(1200)
    await stand()
    await evaluate('window.__sandbox.console.host.thirdPerson(true)')
    await look(Math.PI / 2, 0)
    await tap('KeyV')
    await sleep(400)
    const legs = [
      { label: 'space: straight up', keys: ['Space'], pitch: 0 },
      { label: 'shift + space: up fast', keys: ['Space', 'ShiftLeft'], pitch: 0 },
      { label: 'w: climb along the view', keys: ['KeyW'], pitch: 0.6 },
      { label: 'w: level cruise', keys: ['KeyW'], pitch: 0 },
      { label: 'shift + w: dive', keys: ['KeyW', 'ShiftLeft'], pitch: -0.5 },
      { label: 'c: straight down', keys: ['KeyC'], pitch: 0 },
    ]
    let bad = 0
    for (const leg of legs) {
      await look(null, leg.pitch)
      for (const k of leg.keys) await down(k)
      await sleep(500)
      const r = await evaluate(`(async () => {
        const cam = window.__sandboxCamera, body = window.__sandboxRig.group
        const next = () => new Promise((res) => requestAnimationFrame(res))
        const gaps = [], ys = []
        const t0 = performance.now()
        while (performance.now() - t0 < 1500) {
          await next()
          gaps.push(body.position.y - cam.position.y)
          ys.push(cam.position.y)
        }
        let worst = 0, n = 0
        for (let i = 1; i < gaps.length; i++) {
          const d = Math.abs(gaps[i] - gaps[i - 1])
          if (d > worst) worst = d
          if (d > 0.1) n++
        }
        const vy = (ys[ys.length - 1] - ys[0]) / 1.5
        return { worst, n, frames: gaps.length, vy, lo: Math.min(...gaps), hi: Math.max(...gaps) }
      })()`)
      for (const k of leg.keys) await up(k)
      const ok = r.worst < 0.1
      if (!ok) bad++
      console.log(`  ${leg.label.padEnd(26)} climbing ${r.vy.toFixed(1).padStart(6)} u/s: body-to-lens gap ` +
        `${r.lo.toFixed(2)}..${r.hi.toFixed(2)}, worst jump ${r.worst.toFixed(3)} a frame, ` +
        `${r.n}/${r.frames} frames over 0.1  ${ok ? 'ok' : 'FAIL'}`)
    }
    await tap('KeyV')
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    console.log(`  ${bad === 0 ? 'PASS' : `FAIL: ${bad} legs jumped`}`)
    if (bad) process.exitCode = 1
  }

  if (WHAT.includes('portalgrab')) {
    /*
      The physgun through a portal pair: two portal panels standing face to
      face fourteen units apart on open ground, a portal on each, the player
      between them facing the blue one (through it: the orange one's side,
      which is the player's own back). A crate standing behind the player is
      taken through the blue portal, swung and thrown; then the player's own
      body is taken the same way, pulled about by turning the view, and let
      go. Positions and speeds are printed; nothing may be NaN, and the
      body's speed stays under the self-throw cap (45 u/s).
    */
    console.log('portalgrab')
    const G_OUT = resolve(flag('portal-out', join(process.env.HOME ?? '.', '.cache/overhaul/portal')))
    mkdirSync(G_OUT, { recursive: true })
    const gShot = async (name) => {
      const path = join(G_OUT, `${name}.png`)
      writeFileSync(path, await probe.screenshot(W, H))
      console.log(`  wrote ${path}`)
    }
    await evaluate(`(() => { window.__gLinks = []; for (const c of document.querySelectorAll('canvas')) {
      const gl = c.width && c.getContext('webgl2'); if (!gl || gl.__gWrapped) continue; gl.__gWrapped = true
      const real = gl.linkProgram.bind(gl); gl.linkProgram = (p) => { window.__gLinks.push(1); real(p) } } return true })()`)
    const hold = (code, on) => evaluate(`(() => { const k = window.__input.keys; ${on ? `k.add('${code}')` : `k.delete('${code}')`}; return true })()`)
    const click = async (code) => {
      await hold(code, true)
      await sleep(90)
      await hold(code, false)
      await sleep(300)
    }
    const here = () => evaluate('window.__sandboxCamera.position.toArray()')
    const f1 = (v) => v.map((n) => (Number.isFinite(n) ? n.toFixed(1) : 'NaN')).join(', ')
    await evaluate('window.__sandbox.console.host.thirdPerson(false)')
    await stand()
    const c0 = await here()
    const x0 = c0[0]
    const z0 = c0[2]
    // the two panels, facing each other across the player
    await evaluate(`(() => { const sb = window.__sandbox, V = window.__sandboxCamera.position.constructor, Q = window.__sandboxCamera.quaternion.constructor
      const put = (z, yaw) => { const id = sb.spawn('portal_panel', { x: ${x0}, y: sb.groundY(${x0}, z) + 2.63, z }); sb.setTransform(id, new V(${x0}, sb.groundY(${x0}, z) + 2.63, z), new Q().setFromAxisAngle(new V(0, 1, 0), yaw)); sb.freeze(id); return id }
      window.__panA = put(${z0 - 8}, 0); window.__panB = put(${z0 + 8}, Math.PI); return true })()`)
    await sleep(800)
    await evaluate(`(() => { window.__tools.give('portalgun'); window.__tools.select(3); return true })()`)
    await look(0, 0)
    await sleep(500)
    await click('Mouse0')
    await look(Math.PI, 0)
    await sleep(500)
    await click('Mouse2')
    const pair = await evaluate(`[0, 1].map((c) => { const p = window.__tools.portals.list[c]; return p ? p.pos.toArray().map((n) => +n.toFixed(2)) : null })`)
    console.log(`  blue ${pair[0] ? f1(pair[0]) : 'none  <-- WRONG'}, orange ${pair[1] ? f1(pair[1]) : 'none  <-- WRONG'}`)
    if (!pair[0] || !pair[1]) {
      console.log('  (why: ' + await evaluate('window.__tools.portals.why') + ')')
    } else {
      // aim through the blue oval at a world point on the orange side
      const aimThrough = (x, y, z) => evaluate(`(() => { const P = window.__tools.portals, b = P.list[0], M = P.transform(b, new (window.__sandboxCamera.matrix.constructor)())
        const Mi = M.clone().invert(), c = window.__sandboxCamera.position
        const t = new (c.constructor)(${x}, ${y}, ${z}).applyMatrix4(Mi).sub(c)
        const w = window.__sandboxWalk; w.yaw = Math.atan2(-t.x, -t.z); w.pitch = Math.atan2(t.y, Math.hypot(t.x, t.z)); return true })()`)
      await evaluate('window.__tools.select(1); true')
      // 1. a crate behind the player, taken through the blue portal
      await evaluate(`(() => { const sb = window.__sandbox; window.__gcrate = sb.spawn('crate', { x: ${x0 + 1.2}, y: sb.restY('crate', ${x0 + 1.2}, ${z0 + 4}), z: ${z0 + 4} }); return true })()`)
      await sleep(1200)
      const cp = await evaluate(`(() => { const v = window.__sandboxCamera.position.clone(); window.__sandbox.getTransform(window.__gcrate, v); return v.toArray() })()`)
      await aimThrough(cp[0], cp[1], cp[2])
      await sleep(400)
      await hold('Mouse0', true)
      await sleep(600)
      const hc = await evaluate('[window.__tools.physgun.holding, window.__tools.physgun.prop?.id === window.__gcrate]')
      console.log(`  the crate through the portal: ${hc[1] ? 'held' : hc[0] ? 'held something else  <-- WRONG' : 'not held  <-- WRONG'}`)
      await evaluate('window.__sandboxWalk.pitch += 0.12; true')
      await sleep(500)
      await gShot('grab-1-crate-through-portal')
      // a flick and let go
      for (let i = 0; i < 4; i++) {
        await evaluate('window.__sandboxWalk.yaw += 0.07; true')
        await sleep(40)
      }
      await hold('Mouse0', false)
      await sleep(120)
      const cv = await evaluate(`(() => { const sb = window.__sandbox, v = window.__sandboxCamera.position.clone(), p = v.clone(); sb.getVelocity(window.__gcrate, v); sb.getTransform(window.__gcrate, p); return [p.toArray(), v.toArray()] })()`)
      console.log(`  thrown: crate at ${f1(cv[0])} moving ${f1(cv[1])} (${Math.hypot(...cv[1]).toFixed(1)} u/s)`)
      await sleep(1500)
      // 2. yourself: the chest, seen through the blue portal
      await evaluate('window.__sandbox.console.host.thirdPerson(false)')
      const chest = await evaluate(`(() => { const r = window.__sandboxRig, i = Math.max(0, r.limbs.findIndex((l) => l.name === 'chest')); return r.limbPos(i, window.__sandboxCamera.position.clone()).toArray() })()`)
      await aimThrough(chest[0], chest[1], chest[2])
      await sleep(300)
      await hold('Mouse0', true)
      await sleep(500)
      const self = await evaluate('window.__tools.physgun.holdsSelf')
      console.log(`  yourself through the portal: ${self ? 'held' : 'not held  <-- WRONG'}`)
      const track = async (label, ms) => {
        const out = []
        const t0 = Date.now()
        let last = null
        let maxV = 0
        let nan = false
        while (Date.now() - t0 < ms) {
          const p = await evaluate(`(() => { const r = window.__sandboxRig, i = Math.max(0, r.limbs.findIndex((l) => l.name === 'chest')); return [performance.now(), ...r.limbPos(i, window.__sandboxCamera.position.clone()).toArray()] })()`)
          if (p.some((n) => !Number.isFinite(n))) nan = true
          if (last) maxV = Math.max(maxV, Math.hypot(p[1] - last[1], p[2] - last[2], p[3] - last[3]) / Math.max(1e-3, (p[0] - last[0]) / 1000))
          last = p
          out.push(p)
          await sleep(60)
        }
        console.log(`  ${label}: chest ${f1(out[0].slice(1))} -> ${f1(out[out.length - 1].slice(1))}, top speed ${maxV.toFixed(1)} u/s${nan ? '  NaN <-- WRONG' : ''}`)
        return maxV
      }
      // pull: the view turns, the beam's far end moves, and so do you
      const pulling = (async () => {
        for (let i = 0; i < 10; i++) {
          await evaluate('window.__sandboxWalk.pitch += 0.03; window.__sandboxWalk.yaw += 0.02; true')
          await sleep(100)
        }
      })()
      const v1 = await track('pulled about', 1100)
      await pulling
      await gShot('grab-2-yourself-through-portal')
      // a flick and let go: thrown, capped
      for (let i = 0; i < 4; i++) {
        await evaluate('window.__sandboxWalk.yaw -= 0.1; true')
        await sleep(40)
      }
      await hold('Mouse0', false)
      const v2 = await track('thrown', 1500)
      console.log(`  ${Math.max(v1, v2) <= 46 ? 'speed capped' : 'speed over the cap  <-- WRONG'}; still held: ${await evaluate('window.__tools.physgun.holding')}`)
      // back on your feet
      await sleep(1500)
      await hold('KeyW', true)
      await sleep(400)
      await hold('KeyW', false)
      await sleep(1500)
      console.log(`  on your feet: ${!(await evaluate('window.__sandboxRig.down'))}, lens at ${f1(await here())}`)
      // 3. the car, parked behind you (on the orange side), taken through
      // the blue portal
      await evaluate(`(window.__sandbox.console.host.teleport(${x0}, ${z0}, undefined, 0), true)`)
      await sleep(1500)
      await evaluate(`(() => { const f = window.__fleet, V = window.__sandboxCamera.position.constructor; f.recall('car', new V(${x0}, 0, ${z0 + 4}), window.__fleetEnv())
        f.all.find((v) => v.id === 'car').placeAt(${x0}, ${z0 + 4}, Math.PI / 2, window.__fleetEnv()); return true })()`)
      await sleep(1500)
      const car = await evaluate(`window.__fleet.all.find((v) => v.id === 'car').root.position.toArray()`)
      await aimThrough(car[0], car[1] + 1.2, car[2])
      await sleep(300)
      await hold('Mouse0', true)
      await sleep(900)
      const hv = await evaluate(`(() => { const p = window.__tools.physgun.prop; return [window.__tools.physgun.holding, p?.data.vehicle ?? null] })()`)
      console.log(`  the car through the portal: ${hv[1] === 'car' ? 'held' : hv[0] ? 'held something else  <-- WRONG' : 'not held  <-- WRONG'} (car at ${f1(car)})`)
      await evaluate('window.__sandboxWalk.pitch += 0.1; true')
      await sleep(600)
      await gShot('grab-1b-car-through-portal')
      for (let i = 0; i < 4; i++) {
        await evaluate('window.__sandboxWalk.yaw += 0.06; true')
        await sleep(40)
      }
      await hold('Mouse0', false)
      await sleep(150)
      console.log(`  car let go at ${f1(await evaluate(`window.__fleet.all.find((v) => v.id === 'car').root.position.toArray()`))}`)
      await sleep(500)
    }
    console.log(`  ${(await evaluate('window.__gLinks')).length} programs linked`)
  }

  if (has('debug')) console.log((await evaluate('window.__log')).join('\n'))
  if (probe.errors.length) {
    console.log(`\npage errors (${probe.errors.length}):`)
    for (const e of probe.errors.slice(0, 10)) console.log(`  ${String(e).split('\n')[0]}`)
  }
} finally {
  probe.close()
}
