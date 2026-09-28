/*
 * Ownership and anti-grief with two real clients: two independent Chrome
 * processes in the real /world, one private Vite and one private relay (this
 * is what `npm run drive -- protection` runs; sandbox-drive.mjs hands over to
 * it before booting a probe of its own). Everything it starts is its own and
 * is killed at the end: ports come from PROBE_PORT (vite), PROBE_PORT + 1
 * (relay) and PROBE_CDP / PROBE_CDP + 1 (the two Chromes).
 *
 *   home      B, a stranger, aims the physgun at A's crate: denied (the
 *             gun's 'deny' event, no hold, the toast "that belongs to alpha").
 *             A befriends B: B's grab goes through and the crate is B's to
 *             move. A unfriends: denied again. A shares everything: allowed.
 *   cubeland  A claims the chunk both stand in. B's dig there is declined by
 *             the client (block unchanged, toast). With B's guard lifted so
 *             the edit is made and sent, the server refuses it and its
 *             correction puts the block back on B; A never saw it. A friends
 *             B and the same dig goes through and reaches A.
 *
 * Shots go to shots/sandbox (--out <dir>): protection-*.png.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { waitFor } from './probe/cdp.mjs'

const root = new URL('..', import.meta.url).pathname
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const port = +(process.env.PROBE_PORT ?? 5210)
const relay = port + 1
const debug = +(process.env.PROBE_CDP ?? 9420)
const OUT = resolve(flag('out', 'shots/sandbox'))
mkdirSync(OUT, { recursive: true })
const temp = mkdtempSync(join(tmpdir(), 'protection-drive-'))
const children = []
const sockets = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const launch = (cmd, args, options = {}) => {
  const c = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  children.push(c)
  c.stderr.on('data', (s) => { if (cmd === process.execPath) process.stderr.write(s) })
  return c
}
const shim = (nick) => `(() => {
  const real = matchMedia.bind(window)
  window.matchMedia = q => /pointer:|hover:|prefers-reduced-motion/.test(q)
    ? { matches: /fine|hover:\\s*hover/.test(q), media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return false} } : real(q)
  localStorage.setItem('portfolio-language', 'en')
  localStorage.setItem('alejos-nick', ${JSON.stringify(nick)})
  localStorage.setItem('alejos-roam-prefs', JSON.stringify({cap: 60}))
  window.__links = 0
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue
    const link = C.prototype.linkProgram
    C.prototype.linkProgram = function (...a) { window.__links++; return link.apply(this, a) }
  }
})()`

async function chrome(i, nick) {
  launch('google-chrome-stable', ['--headless=new', `--remote-debugging-port=${debug + i}`, '--use-angle=gl', '--enable-unsafe-swiftshader', '--window-size=960,640', '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--user-data-dir=${temp}/chrome-${i}`])
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debug + i}/json/list`)).json()).find((t) => t.type === 'page'), 80, 250, 'chrome')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  sockets.push(ws)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let seq = 1
  const waiting = new Map()
  const errors = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description)
  }
  const send = (method, params = {}) => new Promise((r) => { const id = seq++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description)
    return m.result?.result?.value
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: shim(nick) })
  await send('Page.navigate', { url: `http://localhost:${port}/world` })
  await waitFor(() => evaluate('!!window.__sandbox?.ready && window.__sandbox.network?.online && !!window.__pickMap'), 400, 250, `sandbox ${nick}`)
  await evaluate('window.__pickMap("home"); true')
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const path = join(OUT, `protection-${name}.png`)
    writeFileSync(path, Buffer.from(r.result.data, 'base64'))
    console.log(`  wrote ${path}`)
  }
  console.log(`${nick} connected`)
  return { send, evaluate, errors, shot, nick }
}

const run = (c, line) => c.evaluate(`__sandbox.run(${JSON.stringify(line)})`)
const feed = (c) => c.evaluate('document.body.innerText')

try {
  launch(process.execPath, ['server/src/index.js'], { env: { ...process.env, ADMIN_TOKEN: 'protection-test', PORT: String(relay), DB_PATH: `${temp}/chat.db`, ALLOWED_ORIGINS: `http://localhost:${port}` } })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relay}/health`)).ok, 80, 100, 'relay')
  launch(process.execPath, ['--input-type=module', '-e', `const {createServer}=await import('vite');const s=await createServer({server:{port:${port},strictPort:true,hmr:false,watch:null}});await s.listen()`], { env: { ...process.env, VITE_CHAT_URL: `ws://127.0.0.1:${relay}/ws`, VITE_CACHE_DIR: `${root}/node_modules/.vite-protection-${port}` } })
  await waitFor(async () => (await fetch(`http://localhost:${port}/world`)).ok, 80, 250, 'vite')
  const a = await chrome(0, 'alpha')
  const b = await chrome(1, 'bravo')
  await waitFor(() => a.evaluate('!!window.__social'), 40, 250, 'the social mirror')

  /* ------------------------------------------------------------- home -- */
  await run(a, 'tp -32 -331')
  await run(b, 'tp -28 -331')
  await sleep(1500)
  for (const c of [a, b]) await c.evaluate('__links = 0')
  const id = await a.evaluate(`(() => { const s = __sandbox; return s.spawn('crate', { x: -32, y: s.restY('crate', -32, -326), z: -326 }, { frozen: true }) })()`)
  const first = await waitFor(async () => (await a.evaluate(`(() => { const p = __sandbox.get(${id}); return p && typeof p.data.net === 'number' ? { net: p.data.net } : null })()`)), 80, 100, 'the crate is acknowledged')
  const remote = await waitFor(() => b.evaluate(`(() => { let f = null; __sandbox.forEach((p) => { if (p.data.net === ${first.net}) f = p.id }); return f })()`), 80, 100, 'the crate reaches B')
  assert.equal(await a.evaluate('__social.protect'), true, 'protection is on by default')
  // B's physgun, aimed at A's crate; its events are collected
  await b.evaluate(`(async () => {
    const { createPhysgun } = await import('/src/game/sandbox/tools/physgun.ts')
    const { emptyInput } = await import('/src/game/sandbox/tools/types.ts')
    const Vector3 = __sandboxCamera.position.constructor
    const p = __sandbox.get(${remote}).body.translation()
    window.__gun = createPhysgun({ sb: __sandbox })
    window.__events = []
    __gun.on((e) => __events.push(e.type))
    window.__gunInput = emptyInput({ eye: new Vector3(p.x, p.y + 2, p.z + 8), dir: new Vector3(0, -2, -8).normalize(), yaw: 0 })
    __gunInput.dt = 1 / 60
    window.__fire = (on) => { __gunInput.fire = on }
    window.__gunTimer = setInterval(() => __gun.update(__gunInput), 16)
  })()`)
  const fire = async (on) => b.evaluate(`__fire(${on})`)
  await fire(true)
  await waitFor(() => b.evaluate(`__events.includes('deny')`), 80, 100, 'the stranger is denied')
  assert.equal(await b.evaluate(`__gun.hold.kind`), 'none', 'a stranger holds nothing')
  await sleep(300)
  const denied = await b.evaluate(`__events.filter((e) => e === 'deny').length`)
  console.log(`stranger denied: ${denied} deny event(s) while the trigger was held (one per press, not per frame)`)
  assert.ok(denied <= 2, 'the buzz does not spam')
  assert.ok(/belongs to alpha/i.test(await feed(b)), 'the toast names the owner')
  await b.shot('denied')
  await fire(false)
  await sleep(300)

  await run(a, 'friend bravo')
  await fire(true)
  await waitFor(() => b.evaluate(`__gun.hold.kind === 'prop'`), 120, 100, 'the friend grabs it')
  console.log('friend allowed: B holds A\'s crate on the physgun')
  await b.evaluate('__gunInput.aim.eye.y += 3')
  await sleep(800)
  await b.shot('friend')
  await fire(false)
  await sleep(600)
  await run(a, 'unfriend bravo')
  await waitFor(() => b.evaluate(`__social.friends.length === 0 && true`), 40, 100, 'unfriended')
  await b.evaluate('__events.length = 0')
  await fire(true)
  await waitFor(() => b.evaluate(`__events.includes('deny')`), 80, 100, 'denied again after unfriending')
  await fire(false)
  console.log('unfriended: denied again')
  await run(a, 'share all')
  await sleep(600)
  await fire(true)
  await waitFor(() => b.evaluate(`__gun.hold.kind === 'prop'`), 120, 100, 'a shared prop is public')
  console.log('shared: a stranger may use it')
  await fire(false)
  await b.evaluate('clearInterval(__gunTimer); __gun.release(false); __gun.dispose()')
  await run(a, 'unshare all')

  /* --------------------------------------------------------- cubeland -- */
  console.log('to cubeland ...')
  await Promise.all([run(a, 'map cubeland'), run(b, 'map cubeland')])
  await Promise.all([a, b].map((c) => waitFor(() => c.evaluate('!!window.__cubeland && __cubeland.store.loaded > 4'), 160, 500, `cubeland ${c.nick}`)))
  await sleep(4000)
  // both stand in the middle of one chunk
  const centre = await a.evaluate(`(() => {
    const h = __sandbox.console.host, c = __cubeland.net.chunkAt(h.here().x, h.here().z)
    return { cx: c.cx, cz: c.cz, x: c.cx * 32 + 16, z: -40000 + c.cz * 32 + 16 }
  })()`)
  await a.evaluate(`__sandbox.console.host.teleport(${centre.x}, ${centre.z}, undefined, 0)`)
  await b.evaluate(`__sandbox.console.host.teleport(${centre.x + 3}, ${centre.z + 3}, undefined, 0)`)
  await sleep(2500)
  await run(a, 'claim')
  await waitFor(() => b.evaluate(`__social.claims.some((c) => c.cx === ${centre.cx} && c.cz === ${centre.cz} && !c.allowed)`), 80, 100, 'the claim reaches B')
  console.log(`claim of chunk ${centre.cx},${centre.cz} mirrored on B (not allowed for B)`)
  await sleep(1200)
  await a.shot('claim-owner')

  // the block under B's feet, and B looking straight at it
  const dig = (c, extra = '') => c.evaluate(`(() => {
    const C = window.__cubeland, w = window.__sandboxWalk, cam = window.__sandboxCamera
    w.pitch = -1.5
    const bx = Math.floor(cam.position.x / 2), bz = Math.floor((cam.position.z + 40000) / 2)
    let by = 95
    while (by > 0 && !C.store.get(bx, by, bz)) by--
    const before = C.store.get(bx, by, bz)
    ${extra}
    return { bx, by, bz, before }
  })()`)
  const press = (c) => c.evaluate(`(() => {
    const C = window.__cubeland, w = window.__sandboxWalk, cam = window.__sandboxCamera
    const f = { camera: cam, feetY: w.feetY, fire: false, alt: false, wheel: 0, dt: 0.016, active: true, firstPerson: true }
    C.level.hands.update(f); C.level.hands.update({ ...f, fire: true }); C.level.hands.update(f)
    return true
  })()`)
  const at = (c, t) => c.evaluate(`window.__cubeland.store.get(${t.bx}, ${t.by}, ${t.bz})`)

  // 1. the client declines
  const t1 = await dig(b)
  await sleep(500)
  await press(b)
  await sleep(1200)
  assert.equal(await at(b, t1), t1.before, 'the block is still there on B')
  assert.ok(/belongs to alpha/i.test(await feed(b)), 'the toast names the owner')
  console.log(`B's dig at ${t1.bx},${t1.by},${t1.bz} declined by the client`)
  await b.shot('claim-declined')

  // 2. the client's guard is lifted: the edit is made, sent, refused, and put back
  const t2 = await dig(b, `C.net.setClaims(null)`)
  await sleep(500)
  await press(b)
  const ghost = await at(b, t2)
  await waitFor(async () => (await at(b, t2)) === t2.before, 80, 100, 'the server\'s correction restores the block')
  console.log(`unguarded dig: B saw ${ghost === t2.before ? 'no change' : `block ${ghost}`} for a moment, then the correction put block ${t2.before} back`)
  assert.equal(await at(a, t2), t2.before, 'A never saw the edit')
  await b.shot('claim-corrected')

  // 3. a friend may build there
  await run(a, 'friend bravo')
  await waitFor(() => b.evaluate(`__social.claims.some((c) => c.cx === ${centre.cx} && c.cz === ${centre.cz} && c.allowed)`), 80, 100, 'B is allowed after the friend')
  // (B's guard was lifted for step 2 and the mirror allows it now: dig for real)
  const t3 = await dig(b)
  await sleep(500)
  await press(b)
  await waitFor(async () => (await at(a, t3)) !== t3.before, 80, 100, 'the friend\'s dig reaches A')
  console.log('friend dug in the claim; A sees it')
  await run(a, 'unclaim')
  await sleep(500)

  const links = await Promise.all([a.evaluate('__links'), b.evaluate('__links')])
  console.log('shader links since the crate spawned (cubeland builds under its card):', links)
  assert.deepEqual(a.errors, [])
  assert.deepEqual(b.errors, [])
  console.log('protection drive passed')
} finally {
  for (const s of sockets) s.close()
  for (const p of children.reverse()) p.kill('SIGTERM')
  await sleep(500)
  rmSync(temp, { recursive: true, force: true })
  rmSync(`${root}/node_modules/.vite-protection-${port}`, { recursive: true, force: true })
}
