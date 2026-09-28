/*
 * Private rooms with three independent Chrome processes, one private Vite and
 * one private relay (same recipe as world-effects-drive.mjs / prop-sync-drive.mjs).
 *
 *   node scripts/rooms-drive.mjs [--shots <dir>]
 *
 * A and B open /world?room=TESTAB (an invite link, straight to the map sheet
 * in that room), C opens /world (public). Asserts, over the real game:
 *   - A and B see each other, C sees nobody, and neither of them sees C
 *   - a crate A spawns arrives on B and never on C
 *   - B leaves to public: B and C see each other, A is alone again, and B has
 *     lost A's crate (the public world has none)
 *   - a made-up code fails cleanly (the store reports it, B stays public)
 *   - B creates a private room on the sheet (a fresh code, invite link
 *     shaped right) and then joins A's code by hand: it finds A and the crate
 * Ports: PROBE_PORT (vite, default 5190), PROBE_RELAY (5191), PROBE_CDP (9400,
 * +1, +2). It kills only what it spawned.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { waitFor } from './probe/cdp.mjs'
const root = new URL('..', import.meta.url).pathname
const port = +(process.env.PROBE_PORT ?? 5190)
const relay = +(process.env.PROBE_RELAY ?? 5191)
const debug = +(process.env.PROBE_CDP ?? 9400)
const shotsAt = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null
const temp = mkdtempSync(join(tmpdir(), 'rooms-drive-'))
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
  window.__joins = []
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    send(s) { if (typeof s === 'string' && s.includes('"world-join"')) window.__joins.push(JSON.parse(s)); super.send(s) }
  }
})()`
async function chrome(i, path) {
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
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: shim })
  await send('Page.navigate', { url: `http://localhost:${port}${path}` })
  await waitFor(() => evaluate('!!window.__sandbox?.ready && window.__sandbox.network?.online && !!window.__pickMap'), 480, 250, `sandbox ${i}`)
  const shot = async (name) => {
    if (!shotsAt) return
    mkdirSync(shotsAt, { recursive: true })
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shotsAt, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  }
  const room = (fn) => evaluate(`import('/src/components/os/worldRoom.ts').then(m => (${fn})(m))`)
  console.log(`Chrome ${i} on ${path}`)
  return { send, evaluate, errors, shot, room }
}
const roster = c => c.evaluate('[...__remote.roster.keys()].sort()')
const props = c => c.evaluate('(() => { let n = 0; __sandbox.forEach(p => { if (p.data.net) n++ }); return n })()')
try {
  launch(process.execPath, ['server/src/index.js'], { env: { ...process.env, ADMIN_TOKEN: 'rooms-drive-secret', PORT: String(relay), DB_PATH: `${temp}/chat.db`, ALLOWED_ORIGINS: `http://localhost:${port}`, WORLD_ROOM_GRACE_MS: '60000' } })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relay}/health`)).ok, 80, 100, 'relay')
  launch(process.execPath, ['--input-type=module', '-e', `const {createServer}=await import('vite');const s=await createServer({server:{port:${port},strictPort:true,hmr:false,watch:null}});await s.listen()`], { env: { ...process.env, VITE_CHAT_URL: `ws://127.0.0.1:${relay}/ws`, VITE_CACHE_DIR: `${root}/node_modules/.vite-rooms-${port}` } })
  await waitFor(async () => (await fetch(`http://localhost:${port}/world`)).ok, 80, 250, 'vite')
  const a = await chrome(0, '/world?room=TESTAB')
  const b = await chrome(1, '/world?room=TESTAB')
  const c = await chrome(2, '/world')
  // the invite link went straight into the room: the join carried it
  assert.equal(await a.evaluate('__joins[0].room'), 'TESTAB')
  assert.equal(await c.evaluate('__joins[0].room ?? "public"'), 'public')
  await a.shot('rooms-a-invited-sheet')
  for (const x of [a, b, c]) await x.evaluate('__pickMap("home"); true')
  await sleep(1500)
  const [ra, rb, rc] = [await roster(a), await roster(b), await roster(c)]
  const [ida, idb, idc] = await Promise.all([a, b, c].map(x => x.evaluate('__remote.you')))
  assert.deepEqual(ra, [idb]); assert.deepEqual(rb, [ida]); assert.deepEqual(rc, [])
  console.log('roster: A sees B, B sees A, public sees nobody', { ida, idb, idc })
  assert.equal(await a.room('m => m.getRoomState().live'), 'TESTAB')
  assert.equal(await c.room('m => m.getRoomState().live'), 'public')
  // props stay in the room
  const crate = await a.evaluate(`(() => { const s = __sandbox; return s.spawn('crate', { x: -32, y: s.restY('crate', -32, -326), z: -326 }, { frozen: true }) })()`)
  await waitFor(async () => (await props(b)) === 1, 80, 150, 'crate on B')
  await sleep(800)
  assert.equal(await props(c), 0, 'the public world never sees the room crate')
  console.log('crate spawned by A arrived on B and not on C')
  // B leaves to public
  await b.room('m => m.leaveToPublic()')
  await waitFor(async () => (await roster(b)).length === 1 && (await roster(c)).length === 1, 120, 250, 'B joins public')
  assert.deepEqual(await roster(a), [], 'A is alone again')
  assert.equal(await props(b), 0, 'B left the crate in the room')
  console.log('B left to public: B and C see each other, A is alone, the crate stayed behind')
  // a made-up code fails cleanly and leaves B in public
  await b.room('m => m.joinRoomCode("NOSUCH")')
  await waitFor(() => b.room('m => m.getRoomState().error === "unknown"'), 120, 250, 'unknown code refused')
  assert.equal(await b.room('m => m.getRoomState().code'), null)
  await waitFor(async () => (await roster(b)).length === 1, 120, 250, 'B back in public after the refusal')
  console.log('a code nobody made was refused and B fell back to public')
  // B makes a room of its own (shows the invite), then joins A's by hand
  const mine = await b.room('m => m.createPrivateRoom()')
  assert.match(mine, /^[A-HJKMNP-Z2-9]{6}$/)
  await waitFor(() => b.room('m => m.getRoomState().live') .then(v => v === mine), 120, 250, 'B in its own room')
  assert.deepEqual(await roster(b), [])
  assert.equal(await b.room(`m => m.inviteUrl("${mine}")`), `http://localhost:${port}/world?room=${mine}`)
  await b.shot('rooms-b-own-room')
  await b.room('m => m.joinRoomCode("testab")')
  await waitFor(async () => (await roster(b)).includes(ida), 120, 250, 'B joins A by code')
  await waitFor(async () => (await props(b)) === 1, 120, 250, 'the crate is there again')
  assert.deepEqual(await roster(c), [], 'C never saw any of it: B is in the room, not public')
  console.log('B made its own room, then joined TESTAB by code: sees A and the crate; C alone in public')
  assert.deepEqual([a.errors, b.errors, c.errors], [[], [], []])
  console.log('rooms drive passed', crate === undefined ? '' : '')
} finally {
  for (const s of sockets) s.close()
  for (const p of children.reverse()) p.kill('SIGTERM')
  await sleep(500)
  rmSync(temp, { recursive: true, force: true })
}
