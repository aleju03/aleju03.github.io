/*
 * The creative props' record over the wire, in two real browsers.
 *
 * Two independent Chrome processes stand in the real world (one private Vite,
 * one private relay; nothing here touches the visitor's dev server). A spawns
 * a crate, a lamp and a sign. B, a different player, paints A's crate, switches
 * A's lamp off and writes on A's sign: all three must show on A. Then B
 * reloads (a late joiner with a fresh socket identity) and must be handed all
 * three by the snapshot, drawn as they should be: the proxy's tint set, the
 * lamp on its dead-bulb geometry, the sign on a text tile. Shader links are
 * counted in both (must be 0) and shots of B's view go to --out.
 *
 *   PROP_PORT=5221 PROP_RELAY=8801 PROP_CDP=9431 node scripts/creative-sync-drive.mjs [--out dir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { waitFor } from './probe/cdp.mjs'
const root = new URL('..', import.meta.url).pathname
const argv = process.argv.slice(2)
const OUT = resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'shots/creative-sync')
mkdirSync(OUT, { recursive: true })
const port = +(process.env.PROP_PORT ?? 5221)
const relay = +(process.env.PROP_RELAY ?? 8801)
const debug = +(process.env.PROP_CDP ?? 9431)
const temp = mkdtempSync(join(tmpdir(), 'creative-sync-'))
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
  window.__propLinks = 0
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue; const link = C.prototype.linkProgram
    C.prototype.linkProgram = function (...a) {
      window.__propLinks++
      try {
        const src = (this.getAttachedShaders(a[0]) ?? []).map((sh) => this.getShaderSource(sh) ?? '').join('\\n')
        ;(window.__propLinkNames ??= []).push([...new Set(src.match(/#define (USE_\\w+|NUM_\\w+ \\d+|SHADOWMAP_TYPE_\\w+)/g) ?? [])].join(',').slice(0, 300))
      } catch { /* the name is a courtesy */ }
      return link.apply(this, a)
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
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: shim })
  await send('Page.navigate', { url: `http://localhost:${port}/world` })
  await waitFor(() => evaluate('!!window.__sandbox?.ready && window.__sandbox.network?.online && !!window.__creative'), 360, 250, `sandbox ${i}`)
  console.log(`Chrome ${i} connected`)
  return { send, evaluate, errors }
}
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  console.log(`  wrote ${join(OUT, `${name}.png`)}`)
}
/** every networked prop of a kind, as the page sees it */
const props = (c, kind) => c.evaluate(`(() => { const a = []; __sandbox.forEach((p) => { if (p.data.net && p.kind.id === ${JSON.stringify(kind)}) {
  const t = p.mesh?.tint; const cr = __creative()
  a.push({ id: p.id, net: p.data.net, tag: cr.rawTag(p.id), paint: cr.tagOf(p.id).paint, off: cr.tagOf(p.id).off, text: cr.tagOf(p.id).text,
    tint: t ? t.getHexString() : null, lampOn: p.data.lampOn ?? null, tile: p.data.signTile ?? null, x: p.body.translation().x })
} }); return a })()`)
const run = (c, command) => c.evaluate(`__sandbox.run(${JSON.stringify(command)})`)
try {
  launch(process.execPath, ['server/src/index.js'], { env: { ...process.env, ADMIN_TOKEN: 'prop-test-secret', PORT: String(relay), DB_PATH: `${temp}/chat.db`, ALLOWED_ORIGINS: `http://localhost:${port}` } })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relay}/health`)).ok, 80, 100, 'relay')
  launch(process.execPath, ['--input-type=module', '-e', `const {createServer}=await import('vite');const s=await createServer({server:{port:${port},strictPort:true,hmr:false,watch:null}});await s.listen()`], { env: { ...process.env, VITE_CHAT_URL: `ws://127.0.0.1:${relay}/ws`, VITE_CACHE_DIR: `${root}/node_modules/.vite-creative-sync-${port}` } })
  await waitFor(async () => (await fetch(`http://localhost:${port}/world`)).ok, 80, 250, 'vite')
  const a = await chrome(0), b = await chrome(1)
  await run(a, 'tp -32 -331'); await run(b, 'tp -30 -331')
  await sleep(2000)
  for (const c of [a, b]) await c.evaluate('__propLinks = 0; __propLinkNames = []')
  await a.evaluate(`(() => { const s = __sandbox; const put = (k, x) => s.spawn(k, { x, y: s.restY(k, x, -326), z: -326 }, { frozen: true })
    window.__mine = { crate: put('crate', -34), lamp: put('lamp', -31), sign: put('sign', -28) }; return true })()`)
  for (const kind of ['crate', 'lamp', 'sign']) await waitFor(async () => (await props(b, kind)).length === 1, 100, 100, `remote ${kind}`)
  console.log('A spawned a crate, a lamp and a sign; B has them')
  // B, another player, dresses A's props
  const [bCrate] = await props(b, 'crate'), [bLamp] = await props(b, 'lamp'), [bSign] = await props(b, 'sign')
  await b.evaluate(`(() => { const cr = __creative(); cr.paint(${bCrate.id}, 7); cr.use(${bLamp.id}); cr.write(${bSign.id}, 'Hello  from B!'); return true })()`)
  await waitFor(async () => {
    const [c] = await props(a, 'crate'), [l] = await props(a, 'lamp'), [s] = await props(a, 'sign')
    return c.paint === 7 && l.off && s.text === 'Hello from B!'
  }, 100, 100, 'B\'s edits on A')
  const [ac] = await props(a, 'crate'), [al] = await props(a, 'lamp'), [as] = await props(a, 'sign')
  console.log(`A sees: crate paint ${ac.paint} (tint ${ac.tint}), lamp off=${al.off} (lampOn ${al.lampOn}), sign "${as.text}" (tile ${as.tile})`)
  assert.ok(ac.tint, 'the painted crate is tinted on the owner')
  assert.equal(al.lampOn, false)
  assert.ok(as.tile >= 0, 'the sign has a text tile on the owner')
  // A answers: a later edit of its own is not overwritten by the old echo
  await a.evaluate(`(() => { const cr = __creative(); cr.paint(${ac.id}, 2); cr.paint(${ac.id}, 5); return true })()`)
  await waitFor(async () => (await props(b, 'crate'))[0].paint === 5, 100, 100, 'A\'s repaint on B')
  console.log('A repainted twice quickly; B ends on the second')
  // B reloads: a late joiner with a new socket identity
  await b.evaluate('delete window.__sandbox; delete window.__creative')
  await b.send('Page.reload')
  await waitFor(() => b.evaluate('!!window.__sandbox?.ready && __sandbox.network?.online && !!window.__creative'), 360, 250, 'late join')
  await sleep(1500)
  await b.evaluate('__propLinks = 0; __propLinkNames = []')
  const [lc] = await props(b, 'crate'), [ll] = await props(b, 'lamp'), [ls] = await props(b, 'sign')
  console.log(`late joiner sees: crate paint ${lc.paint} (tint ${lc.tint}), lamp off=${ll.off} (lampOn ${ll.lampOn}), sign "${ls.text}" (tile ${ls.tile})`)
  assert.equal(lc.paint, 5); assert.ok(lc.tint)
  assert.equal(ll.off, true); assert.equal(ll.lampOn, false)
  assert.equal(ls.text, 'Hello from B!'); assert.ok(ls.tile >= 0)
  // look at them from B: the crate, the lamp and the sign in a row
  await b.evaluate(`(() => { const w = __sandboxWalk; w.yaw = 0; w.pitch = -0.05; return true })()`)
  await run(b, 'tp -31 -318')
  await sleep(2500)
  await b.evaluate(`(() => { const w = __sandboxWalk; w.yaw = Math.PI; w.pitch = -0.1; return true })()`)
  await sleep(1500)
  await shot(b, 'late-joiner-view')
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, [])
  // Nothing of these props may link. A skinned rig (the wildlife or another
  // player's body, first drawn as it streams in) is not theirs and is
  // reported apart.
  const names = await Promise.all([a.evaluate('window.__propLinkNames ?? []'), b.evaluate('window.__propLinkNames ?? []')])
  const ours = names.map((l) => l.filter((n) => !n.includes('USE_SKINNING')))
  console.log('shader links after arrival, A/B (skinned rigs apart):', ours.map((l) => l.length), names.map((l, i) => l.length - ours[i].length))
  assert.deepEqual(ours, [[], []])
  console.log('creative two-process checks passed')
} finally {
  for (const s of sockets) s.close()
  for (const p of children.reverse()) p.kill('SIGTERM')
  await sleep(500)
  rmSync(temp, { recursive: true, force: true })
}
