/*
 * The creatures across two independent Chrome processes, one private Vite and
 * one private relay (the pattern of health-drive.mjs). Both walk into
 * Cubeland, A first:
 *
 *   host      A, the longest-present, simulates; B does not
 *   playback  a herd A places appears on B, moving, drawn from B's own store
 *   hit       B hurts a pig (the impact seam's own call, a pistol's numbers):
 *             the server relays it to A, A's pig loses hit points, and when it
 *             dies B hears it and gets its drops
 *   mob       a zombie A places beside B (at night) hurts B through the health
 *             system, the server's number (5), and shoves B
 *   switches  B is not allowed /mobs peaceful, A is, and B's hostiles go
 *   handoff   A goes home: B becomes the host and adopts the herd
 *
 * Ports come from PROBE_PORT (vite), PROBE_PORT+1 (relay) and PROBE_CDP (+1
 * for the second Chrome). Screenshots go to CREATURE_SHOTS (default
 * ./shots/creatures-mp). Both Chromes, Vite and the relay are killed on the
 * way out.
 *
 *   PROBE_PORT=5240 PROBE_CDP=9450 node scripts/creatures-drive.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { waitFor } from './probe/cdp.mjs'
const root = new URL('..', import.meta.url).pathname
const port = +(process.env.PROBE_PORT ?? 5240)
const relay = port + 1
const debug = +(process.env.PROBE_CDP ?? 9450)
const shots = process.env.CREATURE_SHOTS ?? join(root, 'shots/creatures-mp')
mkdirSync(shots, { recursive: true })
const temp = mkdtempSync(join(tmpdir(), 'creatures-drive-'))
const children = []
const sockets = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const launch = (cmd, args, options = {}) => {
  const c = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  children.push(c)
  c.stderr.on('data', (s) => { if (cmd === process.execPath) process.stderr.write(s) })
  return c
}
const shim = `(() => {
  const real = matchMedia.bind(window)
  window.matchMedia = q => /pointer:|hover:|prefers-reduced-motion/.test(q)
    ? { matches: /fine|hover:\\s*hover/.test(q), media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return false} } : real(q)
  localStorage.setItem('portfolio-language', 'en')
  localStorage.setItem('alejos-roam-prefs', JSON.stringify({cap: 60}))
})()`
async function chrome(i) {
  launch('google-chrome-stable', ['--headless=new', `--remote-debugging-port=${debug + i}`, '--use-angle=gl', '--enable-unsafe-swiftshader', '--window-size=960,640', '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--user-data-dir=${temp}/chrome-${i}`])
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debug + i}/json/list`)).json()).find(t => t.type === 'page'), 80, 250, 'chrome')
  const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let seq = 1
  const waiting = new Map(), errors = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description)
  }
  const send = (method, params = {}) => new Promise(r => { const id = seq++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description)
    return m.result?.result?.value
  }
  const shot = async name => {
    const m = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shots, `${name}.png`), Buffer.from(m.result.data, 'base64'))
    console.log(`  shot ${name}`)
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: shim })
  await send('Page.navigate', { url: `http://localhost:${port}/world` })
  await waitFor(() => evaluate('!!window.__sandbox?.ready && window.__sandbox.network?.online && !!window.__pickMap'), 480, 250, `sandbox ${i}`)
  console.log(`Chrome ${i} connected`)
  return { send, evaluate, errors, shot }
}
const run = (c, command) => c.evaluate(`__sandbox.run(${JSON.stringify(command)})`)
const D = (c, js) => c.evaluate(`(() => { const D = window.__creatures(); ${js} })()`)
const ahead = `const cam = window.__sandboxCamera, w = window.__sandboxWalk, ahead = (d, side = 0) => ({ x: cam.position.x - Math.sin(w.yaw) * d + Math.cos(w.yaw) * side, z: cam.position.z - Math.cos(w.yaw) * d - Math.sin(w.yaw) * side });`
try {
  launch(process.execPath, ['server/src/index.js'], { env: { ...process.env, ADMIN_TOKEN: 'creatures-test-secret', PORT: String(relay), DB_PATH: `${temp}/chat.db`, ALLOWED_ORIGINS: `http://localhost:${port}` } })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relay}/health`)).ok, 80, 100, 'relay')
  launch(process.execPath, ['--input-type=module', '-e', `const {createServer}=await import('vite');const s=await createServer({server:{port:${port},strictPort:true,hmr:false,watch:null}});await s.listen()`], { env: { ...process.env, VITE_CHAT_URL: `ws://127.0.0.1:${relay}/ws`, VITE_CACHE_DIR: `${root}/node_modules/.vite-creatures-${port}` } })
  await waitFor(async () => (await fetch(`http://localhost:${port}/world`)).ok, 80, 250, 'vite')
  const a = await chrome(0)
  const b = await chrome(1)
  // A goes first, so A is the longest-present in Cubeland
  await a.evaluate('window.__pickMap("cubeland"); true')
  await waitFor(() => a.evaluate('!!window.__creatures?.()'), 240, 500, 'A in Cubeland')
  await sleep(1500)
  await b.evaluate('window.__pickMap("cubeland"); true')
  await waitFor(() => b.evaluate('!!window.__creatures?.()'), 240, 500, 'B in Cubeland')
  await sleep(4000)
  await run(a, 'time 0.4'); await run(b, 'time 0.4')

  // ---- host: A, not B
  await waitFor(() => a.evaluate('window.__creatures().host === true'), 200, 300, 'A is the host')
  assert.equal(await b.evaluate('window.__creatures().host'), false, 'B is not the host')
  console.log('host: A simulates, B does not')

  // ---- playback: a herd A places is seen, drawn and moving on B
  await D(a, `D.sim.clear(); D.sim.configure({ enabled: false }); return true`)
  await b.evaluate('window.__sandboxWalk.yaw = 0; true')
  // put both on the same spot so the herd is near both
  const spot = await a.evaluate('(() => { const c = window.__sandboxCamera.position; return [c.x, c.z, window.__sandboxWalk.feetY] })()')
  const tpB = (x, z, y) => b.evaluate(`window.__sandbox.console.host.teleport(${x}, ${z}, ${y}, 0); true`)
  await tpB(spot[0], spot[1], spot[2] + 0.5)
  await sleep(2500)
  await D(a, `${ahead} let made = 0; for (const k of ['pig', 'pig', 'pig', 'pig', 'pig', 'cow', 'cow', 'sheep', 'sheep']) for (let t = 0; t < 60; t++) {
    const p = ahead(4 + Math.random() * 16, (Math.random() - 0.5) * 20); if (D.sim.spawn(k, p.x, p.z)) { made++; break } } return made`)
  try {
    await waitFor(() => b.evaluate('window.__creatures().count().passive >= 6'), 300, 300, 'B sees the herd')
  } catch (e) {
    console.log('A sees players', await a.evaluate('JSON.stringify([...__remote.players.values()].map((p) => [p.id, p.here]))'), 'A', await a.evaluate('JSON.stringify(window.__creatures().count())'), 'B', await b.evaluate('JSON.stringify(window.__creatures().count())'), 'B level', await b.evaluate('__levels.current.id'), 'A level', await a.evaluate('__levels.current.id'))
    throw e
  }
  const first = await b.evaluate('window.__creatures().rendered().map((r) => [r.id, r.x, r.z])')
  // (headless draws a frame or two a second: the host's clock is stepped by hand)
  await D(a, 'for (let i = 0; i < 240; i++) D.sim.update(1 / 30); return true')
  await sleep(4000)
  const second = await b.evaluate('window.__creatures().rendered().map((r) => [r.id, r.x, r.z])')
  const moved = second.filter(([id, x, z]) => { const f = first.find((r) => r[0] === id); return f && Math.hypot(f[1] - x, f[2] - z) > 0.3 }).length
  console.log(`playback: B sees ${second.length} creatures, ${moved} of them moved in 4 s; B draws ${await b.evaluate('window.__creatures().view.stats.parts')} parts`)
  assert.ok(second.length >= 6 && moved >= 2, 'the herd is drawn and moving on B')
  await a.evaluate('window.__sandboxWalk.yaw = 0; true')
  await a.shot('a-host-herd'); await b.shot('b-guest-herd')

  // ---- hit: B hurts a pig with the impact seam's own call (a pistol round)
  const hpSum = (c) => D(c, `let t = 0; for (const x of D.sim.creatures.values()) t += x.hp; return Math.round(t)`)
  const dropsBefore = await b.evaluate('(() => { let n = 0; __sandbox.forEach((p) => { if (p.data.mob) n++ }); return n })()')
  const before = await hpSum(a)
  const shoot = `const m = 60; D.knock({ track() {}, strike(key, feet, h, mass, out) { if (key.kind.id !== 'pig') return false; out.impulse.set(3.5 * mass, 4 * mass, 0); out.point.copy(feet); return true } }); return true`
  for (let i = 0; i < 3; i++) { await D(b, shoot); await sleep(300) }
  await waitFor(async () => (await hpSum(a)) < before, 200, 300, 'A applies B\'s hit')
  console.log(`hit: the host's herd lost ${before - await hpSum(a)} hit points to B's shots`)
  for (let i = 0; i < 30; i++) { await D(b, shoot); await sleep(120) }
  const mobs = (c) => c.evaluate('(() => { let n = 0; __sandbox.forEach((p) => { if (p.data.mob) n++ }); return n })()')
  try {
    await waitFor(async () => (await mobs(b)) > dropsBefore, 300, 300, 'B gets the drops of a kill')
  } catch (e) {
    console.log('drops: A', await mobs(a), 'B', await mobs(b), 'before', dropsBefore, 'A', await a.evaluate('JSON.stringify([...__creatures().sim.creatures.values()].map((c) => [c.kind.id, c.hp, c.st]))'), 'B', await b.evaluate('JSON.stringify(__creatures().count())'))
    throw e
  }
  console.log('hit: a pig died under B\'s shots; B has its drops')
  await b.shot('b-kill-drops')

  // ---- mob: a zombie hurts B through the health system (night, and no peace)
  await D(a, `D.sim.clear(); return true`)
  await run(a, 'time 0.97'); await run(b, 'time 0.97')
  // (apart from A, so the zombie's nearest person is B)
  await tpB(spot[0] + 40, spot[1], spot[2] + 30)
  await sleep(6000)
  const hp0 = await b.evaluate('__health.hp')
  const at = await b.evaluate('(() => { const c = window.__sandboxCamera.position; return [c.x, c.z] })()')
  await a.evaluate(`(() => { window.__atk = []; const S = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { if (typeof d === 'string' && d.includes('world-creature-attack')) window.__atk.push(d); return S.call(this, d) }; return true })()`)
  const placed = await D(a, `let ok = false; for (let t = 0; t < 60 && !ok; t++) ok = !!D.sim.spawn('zombie', ${at[0]} + (Math.random() - 0.5) * 8, ${at[1]} + (Math.random() - 0.5) * 8, { y: [...__remote.players.values()][0].y }); return ok`)
  console.log('mob: zombie placed', placed)
  // (the host's clock is stepped by hand: a second of it, then real time for the wire)
  for (let i = 0; i < 12 && (await b.evaluate('__health.hp')) >= hp0; i++) {
    await D(a, 'for (let k = 0; k < 40; k++) D.sim.update(1 / 30); return true')
    await sleep(900)
  }
  try {
    await waitFor(() => b.evaluate(`__health.hp < ${hp0}`), 100, 300, 'the zombie hurts B')
  } catch (e) {
    console.log('mob diag: attacks sent', await a.evaluate('window.__atk.length'), (await a.evaluate('window.__atk[0]')), 'zombies', await a.evaluate('JSON.stringify([...__creatures().sim.creatures.values()].map((c) => [c.kind.id, +c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1), c.st, c.hp]))'), 'B at', JSON.stringify(at), 'B now', await b.evaluate('JSON.stringify([__sandboxCamera.position.x, __sandboxCamera.position.z])'), 'A sees B', await a.evaluate('JSON.stringify([...__remote.players.values()].map((p) => [p.x, p.y, p.z]))'))
    throw e
  }

  const hp1 = await b.evaluate('__health.hp')
  console.log(`mob: B ${hp0} -> ${hp1} hp from a zombie (the server's 5 a blow)`)
  assert.ok((hp0 - hp1) % 5 < 0.6 || (hp0 - hp1) >= 5, 'a blow costs the server\'s number')
  await b.shot('b-zombie-hit')

  // ---- switches
  await D(a, `D.sim.clear(); D.sim.spawn('zombie', ${at[0]} + 40, ${at[1]}); return true`)
  await run(b, 'mobs peaceful')
  await sleep(600)
  assert.equal(await b.evaluate('window.__creatures().count().peaceful'), false, 'B (not first, not admin) cannot switch it')
  await run(a, 'mobs peaceful')
  await waitFor(() => b.evaluate('window.__creatures().count().peaceful === true'), 200, 300, 'peaceful reaches B')
  await waitFor(() => a.evaluate('window.__creatures().count().hostile === 0'), 200, 300, 'the hostiles go')
  console.log('switches: B refused, A\'s /mobs peaceful reaches B and clears the hostiles')
  await run(a, 'mobs hostile')
  await run(a, 'time 0.4'); await run(b, 'time 0.4')
  await D(a, `D.sim.configure({ enabled: true }); ${ahead} for (let i = 0; i < 4; i++) { const p = ahead(10 + i, (i - 2) * 3); D.sim.spawn('sheep', p.x, p.z) } return true`)
  await waitFor(() => b.evaluate('window.__creatures().count().passive >= 4'), 300, 300, 'B sees sheep again')

  // ---- handoff: A goes home, B takes over the herd
  const herd = await b.evaluate('window.__creatures().count().alive')
  await run(a, 'map home')
  await waitFor(() => b.evaluate('window.__creatures().host === true'), 240, 250, 'B becomes the host')
  await sleep(1500)
  const adopted = await b.evaluate('window.__creatures().sim.creatures.size')
  console.log(`handoff: B is the host and adopted ${adopted} of the ${herd} creatures it was watching`)
  assert.ok(adopted >= Math.min(herd, 4), 'the herd survives the handoff')
  await b.shot('b-new-host')
  for (const [i, c] of [a, b].entries()) if (c.errors.length) console.log(`Chrome ${i} errors:`, c.errors.slice(0, 3))
  console.log('creatures: two-client checks passed')
} catch (e) {
  console.error('FAIL', e)
  process.exitCode = 1
} finally {
  for (const s of sockets) try { s.close() } catch { /* gone */ }
  for (const c of children) try { c.kill('SIGKILL') } catch { /* gone */ }
}
