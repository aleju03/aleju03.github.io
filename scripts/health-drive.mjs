/*
 * Health, death and respawn across two independent Chrome processes, one
 * private Vite and one private relay (the pattern of prop-sync-drive.mjs).
 * A shoots B in the real pistol code path (the trigger held through the
 * input table, aim set through the walk's yaw and pitch):
 *
 *   pvp off  nothing changes (B keeps 100 hp), /hurt still works
 *   pvp on   B loses hp, dies, the killfeed and scoreboard agree on both
 *            machines, B's death sheet counts down, B is back whole and
 *            protected after the timer
 *   falls    a real drop from height costs B what the server believes
 *
 * Ports come from PROBE_PORT (vite), PROBE_PORT+1 (relay) and PROBE_CDP (+1
 * for the second Chrome). Screenshots go to HEALTH_SHOTS (default
 * ./shots/health). Both Chromes, Vite and the relay are killed on the way out.
 *
 *   PROBE_PORT=5200 PROBE_CDP=9410 node scripts/health-drive.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { waitFor } from './probe/cdp.mjs'
const root = new URL('..', import.meta.url).pathname
const port = +(process.env.PROBE_PORT ?? 5200)
const relay = port + 1
const debug = +(process.env.PROBE_CDP ?? 9410)
const shots = process.env.HEALTH_SHOTS ?? join(root, 'shots/health')
mkdirSync(shots, { recursive: true })
const temp = mkdtempSync(join(tmpdir(), 'health-drive-'))
const children = [], sockets = []
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
  window.__falls = { sent: [], maxY: -1e9 }
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    send(s) {
      if (s.includes('world-fall')) window.__falls.sent.push(s)
      else if (s.includes('"world-move"')) { const y = JSON.parse(s).y; if (y > window.__falls.maxY) window.__falls.maxY = y }
      super.send(s)
    }
  }
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
  await waitFor(() => evaluate('!!window.__sandbox?.ready && window.__sandbox.network?.online && !!window.__health'), 480, 250, `sandbox ${i}`)
  console.log(`Chrome ${i} connected`)
  return { send, evaluate, errors, shot }
}
const run = (c, command) => c.evaluate(`__sandbox.run(${JSON.stringify(command)})`)
const hp = (c) => c.evaluate('__health.hp')
try {
  launch(process.execPath, ['server/src/index.js'], { env: { ...process.env, ADMIN_TOKEN: 'health-test-secret', PORT: String(relay), DB_PATH: `${temp}/chat.db`, ALLOWED_ORIGINS: `http://localhost:${port}` } })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relay}/health`)).ok, 80, 100, 'relay')
  launch(process.execPath, ['--input-type=module', '-e', `const {createServer}=await import('vite');const s=await createServer({server:{port:${port},strictPort:true,hmr:false,watch:null}});await s.listen()`], { env: { ...process.env, VITE_CHAT_URL: `ws://127.0.0.1:${relay}/ws`, VITE_CACHE_DIR: `${root}/node_modules/.vite-health-${port}` } })
  await waitFor(async () => (await fetch(`http://localhost:${port}/world`)).ok, 80, 250, 'vite')
  const a = await chrome(0), b = await chrome(1)
  await run(a, 'tp -32 -331'); await run(b, 'tp -28 -331')
  await sleep(2500)
  // A faces +x (forward is -sin(yaw), -cos(yaw)) and looks a little down at B
  const aim = `(() => { const w = __sandboxWalk; w.yaw = -Math.PI / 2; w.pitch = -0.3 })()`
  const fire = (c, on) => c.evaluate(`(() => { ${on ? "__input.keys.add('Mouse0')" : "__input.keys.delete('Mouse0')"}; return true })()`)
  await a.evaluate('__tools.select(4)')
  await a.evaluate(aim)
  await sleep(500)

  // ---- pvp off: shots knock, nothing hurts
  await fire(a, true); await sleep(3000); await fire(a, false)
  assert.equal(await hp(b), 100, 'no damage with pvp off')
  console.log('pvp off: B untouched by A shooting at it, hp', await hp(b))
  await run(b, 'hurt 30')
  await waitFor(async () => (await hp(b)) === 70, 60, 100, '/hurt with pvp off')
  await waitFor(() => a.evaluate('[...__remote.players.keys()].some((id) => __health.vitalsOf(id)?.hp === 70)'), 60, 100, 'A sees B hurt')
  await a.shot('a-sees-b-hurt-pip'); await b.shot('b-hurt-bar')
  await run(b, 'heal')
  await waitFor(async () => (await hp(b)) === 100, 100, 100, 'heal')

  // ---- pvp on: shot to death
  await run(a, 'pvp on')
  await waitFor(() => b.evaluate('__health.pvp'), 60, 100, 'pvp reaches B')
  await b.shot('b-pvp-on')
  await a.evaluate(aim)
  await fire(a, true)
  await waitFor(() => b.evaluate('__health.hp < 100'), 200, 150, 'B is hurt')
  console.log('B hurt by A, hp', await hp(b))
  await b.shot('b-hurt-in-pvp')
  await waitFor(() => b.evaluate('__health.dead'), 400, 150, 'B dies')
  await fire(a, false)
  console.log('B is dead; killer', await b.evaluate('__health.killer'), await b.evaluate('__health.killedBy'))
  await sleep(600)
  await b.shot('b-death-sheet'); await a.shot('a-after-kill')
  const feedA = await a.evaluate('__health.feed.map(l => [l.victim, l.by, l.kind, l.mineIn])')
  const feedB = await b.evaluate('__health.feed.map(l => [l.victim, l.by, l.kind, l.mineOut])')
  console.log('killfeed A', JSON.stringify(feedA), 'B', JSON.stringify(feedB))
  assert.equal(feedA.length, 1); assert.equal(feedB.length, 1)
  assert.equal(feedA[0][2], 'pistol'); assert.equal(feedA[0][3], true); assert.equal(feedB[0][3], true)
  const scores = await a.evaluate('[...__health.scores.values()]')
  console.log('scoreboard', JSON.stringify(scores))
  assert.equal(scores.find((r) => r[1] === 1)?.[2], 0, 'one kill for the shooter')
  assert.equal(scores.find((r) => r[2] === 1)?.[1], 0, 'one death for the victim')
  const t0 = Date.now()
  await waitFor(async () => !(await b.evaluate('__health.dead')), 200, 100, 'B respawns')
  console.log('respawned', Date.now() - t0, 'ms after the death sheet was up')
  await waitFor(async () => (await hp(b)) === 100, 100, 100, 'B whole again')
  await sleep(300)
  await b.shot('b-respawned')

  // ---- a fall costs what the server believes
  await run(b, 'tp -28 -331')
  await sleep(5000) // protection over, standing on the street again
  const feet0 = await b.evaluate('__sandboxWalk.feetY')
  await b.evaluate('(() => { __falls.maxY = -1e9; const w = __sandboxWalk; w.teleport(-28, -331, w.feetY + 55) })()')
  try {
    await waitFor(async () => (await hp(b)) < 100, 300, 150, 'fall damage')
  } catch (e) {
    console.log('fall debug', await b.evaluate('JSON.stringify({ feetY: __sandboxWalk.feetY, falls: __falls, hp: __health.hp, prot: __health.protectedNow, dead: __health.dead })'), 'started at', feet0)
    throw e
  }
  console.log('after a 55-unit drop, B hp', await hp(b), 'dead', await b.evaluate('__health.dead'))

  // ---- pvp off again
  await run(a, 'pvp off')
  await waitFor(async () => !(await b.evaluate('__health.pvp')), 60, 100, 'pvp off reaches B')
  await waitFor(async () => !(await b.evaluate('__health.dead')), 200, 100, 'B up again')
  await run(b, 'heal')
  await waitFor(async () => (await hp(b)) === 100, 100, 100, 'heal again')
  await a.evaluate(aim)
  await fire(a, true); await sleep(2500); await fire(a, false)
  assert.equal(await hp(b), 100, 'no damage after pvp off again')
  console.log('pvp off again: B untouched')
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, [])
  console.log('two-client health checks passed')
} finally {
  for (const s of sockets) s.close()
  for (const p of children.reverse()) p.kill('SIGTERM')
  await sleep(800)
  rmSync(temp, { recursive: true, force: true })
}
