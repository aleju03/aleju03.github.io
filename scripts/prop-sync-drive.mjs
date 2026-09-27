/*
 * Two independent Chrome processes in the real world, one private Vite and
 * one private relay. CDP drives the public sandbox facade. All processes
 * and ports belong to this probe; it never touches the visitor's dev server.
 * Also records JSON wire bytes separately for props and presence.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { waitFor } from './probe/cdp.mjs'
const root = new URL('..', import.meta.url).pathname
const port = +(process.env.PROP_PORT ?? 5194)
const relay = +(process.env.PROP_RELAY ?? 8794)
const debug = +(process.env.PROP_CDP ?? 9394)
const temp = mkdtempSync(join(tmpdir(), 'prop-sync-'))
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
  window.__wire = { out:0, in:0, propOut:0, propIn:0, propFramedOut:0, propFramedIn:0, events:[], sent:[] }
  window.__propLinks=0
  for(const C of [window.WebGLRenderingContext,window.WebGL2RenderingContext]) {
    if(!C)continue;const link=C.prototype.linkProgram
    C.prototype.linkProgram=function(...a){window.__propLinks++;return link.apply(this,a)}
  }
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(...args) { super(...args); this.addEventListener('message', e => {
      const m = JSON.parse(e.data), w = window.__wire
      w.in += e.data.length
      if(m.type?.startsWith('world-prop-')) { w.propIn += e.data.length; w.propFramedIn += e.data.length + (e.data.length < 126 ? 2 : e.data.length < 65536 ? 4 : 10); w.events.push(m); if(w.events.length>1000) w.events.shift() }
    }) }
    send(s) { const w=window.__wire; w.out+=s.length; if(s.includes('world-prop-')) {w.propOut+=s.length;w.propFramedOut+=s.length+4+(s.length<126?2:s.length<65536?4:10);w.sent.push(JSON.parse(s));if(w.sent.length>1000)w.sent.shift()}; super.send(s) }
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
  const send = (method, params = {}) => new Promise(r => { const id = seq++; waiting.set(id, r); ws.send(JSON.stringify({id,method,params})) })
  const evaluate = async expression => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description)
    return m.result?.result?.value
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: shim })
  await send('Page.navigate', { url: `http://localhost:${port}/world` })
  await waitFor(() => evaluate('!!window.__sandbox?.ready && window.__sandbox.network?.online'), 360, 250, `sandbox ${i}`)
  console.log(`Chrome ${i} connected`)
  return { send, evaluate, errors }
}
const state = c => c.evaluate(`(() => {const a=[]; __sandbox.forEach(p=>{if(p.data.net) a.push({id:p.id,net:p.data.net,owner:p.data.owner,kind:p.kind.id,mode:p.mode,at:p.body.translation(),authority:__sandbox.isAuthority(p.id)})});return a})()`)
const find = async (c, id) => (await state(c)).find(p => p.net === id)
const run = (c, command) => c.evaluate(`__sandbox.run(${JSON.stringify(command)})`)
try {
  launch(process.execPath, ['server/src/index.js'], { env: { ...process.env, ADMIN_TOKEN: 'prop-test-secret', PORT: String(relay), DB_PATH: `${temp}/chat.db`, ALLOWED_ORIGINS: `http://localhost:${port}` } })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relay}/health`)).ok, 80, 100, 'relay')
  launch(process.execPath, ['--input-type=module', '-e', `const {createServer}=await import('vite');const s=await createServer({server:{port:${port},strictPort:true,hmr:false,watch:null}});await s.listen()`], { env: { ...process.env, VITE_CHAT_URL: `ws://127.0.0.1:${relay}/ws`, VITE_CACHE_DIR: `${root}/node_modules/.vite-prop-sync-${port}` } })
  await waitFor(async () => (await fetch(`http://localhost:${port}/world`)).ok, 80, 250, 'vite')
  const a = await chrome(0), b = await chrome(1)
  await run(a, 'tp -32 -331'); await run(b, 'tp -28 -331')
  await sleep(1500)
  for(const c of [a,b])await c.evaluate('__propLinks=0')
  const id = await a.evaluate(`(() => {const s=__sandbox; return s.spawn('crate',{x:-32,y:s.restY('crate',-32,-326),z:-326},{frozen:true})})()`)
  const first = await waitFor(async () => (await state(a)).find(p => p.id === id), 80, 100, 'spawn ack')
  const remote = await waitFor(() => find(b, first.net), 80, 100, 'remote crate')
  assert.ok(Math.hypot(first.at.x-remote.at.x,first.at.y-remote.at.y,first.at.z-remote.at.z)<0.03)
  console.log('spawn positions', first.at, remote.at)
  await a.evaluate(`__sandbox.unfreeze(${id}); __sandbox.setVelocity(${id},{x:3,y:6,z:0})`)
  await sleep(4500)
  const landedA = await find(a, first.net), landedB = await find(b, first.net)
  assert.ok(landedA && landedB, 'crate survives throw')
  console.log('throw end positions A/B', landedA.at, landedB.at)
  assert.ok(Math.hypot(landedA.at.x-landedB.at.x,landedA.at.y-landedB.at.y,landedA.at.z-landedB.at.z)<0.15)
  await b.evaluate(`(async()=>{
    const {createPhysgun}=await import('/src/game/sandbox/tools/physgun.ts')
    const {emptyInput}=await import('/src/game/sandbox/tools/types.ts')
    const Vector3=__sandboxCamera.position.constructor
    const p=__sandbox.get(${remote.id}).body.translation()
    window.__gun=createPhysgun({sb:__sandbox})
    window.__gunInput=emptyInput({eye:new Vector3(p.x,p.y+2,p.z+8),dir:new Vector3(0,-2,-8).normalize(),yaw:0})
    __gunInput.dt=1/60;__gunInput.fire=true
    window.__gunTimer=setInterval(()=>__gun.update(__gunInput),16)
  })()`)
  await waitFor(async () => (await find(b, first.net))?.authority, 100, 80, 'claim transfer')
  await waitFor(() => b.evaluate(`__gun.hold.kind==='prop'`),80,80,'physgun grip')
  assert.equal((await find(a, first.net)).authority, false)
  await b.evaluate('__gunInput.aim.eye.y += 4')
  await sleep(900)
  console.log('B physgun carrying; A/B positions', (await find(a, first.net)).at, (await find(b, first.net)).at)
  await b.evaluate('clearInterval(__gunTimer); __gun.release(false); __gun.dispose()')
  await a.evaluate(`(async()=>{const {contraptionOf}=await import('/src/game/sandbox/contraption/contraption.ts'); const s=__sandbox,c=contraptionOf(s);window.__parts=[s.spawn('plate_s',{x:-23,y:10,z:-323},{frozen:true}),s.spawn('beam_s',{x:-23,y:11,z:-323},{frozen:true})]; c.add('weld',...__parts);})()`)
  await waitFor(() => b.evaluate(`import('/src/game/sandbox/contraption/contraption.ts').then(m=>m.contraptionOf(__sandbox).stats.constraints===1)`), 100, 80, 'weld')
  console.log('welded contraption replicated')
  const bomb = await a.evaluate(`__sandbox.spawn('barrel_explosive',{x:-36,y:12,z:-326},{frozen:true})`)
  const explosive = await waitFor(async () => (await state(a)).find(p=>p.id===bomb), 80, 100, 'bomb')
  await waitFor(() => find(b,explosive.net), 80,100,'remote bomb')
  await a.evaluate(`__sandbox.damage(${bomb},1000)`)
  await waitFor(async () => !(await find(b,explosive.net)), 80,100,'remote break')
  assert.ok(await b.evaluate(`__wire.events.some(m=>m.type==='world-prop-explosion')`))
  console.log('explosive removed and explosion received on both clients')
  const firstLinks=await Promise.all([a.evaluate('__propLinks'),b.evaluate('__propLinks')])
  assert.deepEqual(firstLinks,[0,0]);console.log('local and remote shader links',firstLinks)
  // Rejoin in the same second process, with a new socket identity and a full snapshot.
  await b.evaluate('delete window.__sandbox')
  await b.send('Page.reload')
  await waitFor(() => b.evaluate('!!window.__sandbox?.ready && __sandbox.network?.online'), 360,250,'late join')
  await sleep(500)
  await b.evaluate('__propLinks=0')
  assert.equal((await state(b)).length,(await state(a)).length)
  assert.ok(await b.evaluate(`import('/src/game/sandbox/contraption/contraption.ts').then(m=>m.contraptionOf(__sandbox).stats.constraints===1)`))
  console.log('late join reconstructs props and joint')
  const own = await b.evaluate(`__sandbox.spawn('barrel',{x:-21,y:12,z:-320},{frozen:true})`)
  const bOwn = await waitFor(async () => (await state(b)).find(p=>p.id===own),80,100,'B spawn')
  await run(a,'cleanup')
  await waitFor(async () => (await state(b)).every(p=>p.owner!==first.owner),80,100,'cleanup')
  assert.ok(await find(b,bOwn.net))
  console.log('cleanup removes A props and preserves B props')
  await run(b,'cleanup')
  // 100 from each owner stays under the cap. Ten are moved repeatedly.
  for (const [side,c] of [a,b].entries()) {
    await c.evaluate(`(() => {const s=__sandbox;for(let i=0;i<100;i++)s.spawn('barrel',{x:-50+${side*40}+(i%10)*3,y:30,z:-350+Math.floor(i/10)*3},{frozen:true})})()`)
    await sleep(1400)
  }
  await waitFor(async()=> (await state(a)).length===200,100,100,'200 props')
  const measure = async () => {
    const start = await Promise.all([a.evaluate('__wire'),b.evaluate('__wire')])
    const at=Date.now(); await sleep(4000); const seconds=(Date.now()-at)/1000
    const end=await Promise.all([a.evaluate('__wire'),b.evaluate('__wire')])
    return end.map((e,i)=>Object.fromEntries(['out','in','propOut','propIn','propFramedOut','propFramedIn'].map(k=>[k,Math.round((e[k]-start[i][k])/seconds)])))
  }
  const quiet = await measure()
  console.log('200 resting props, bytes/s A/B', quiet)
  assert.ok(quiet.every(c => c.propOut === 0 && c.propIn === 0), 'resting props send no traffic')
  await a.evaluate(`(() => {const s=__sandbox,ids=[];s.forEach(p=>{if(p.data.net&&s.isAuthority(p.id)&&ids.length<10)ids.push(p.id)});for(const id of ids)s.unfreeze(id);let t=0; window.__moving=setInterval(()=>{t+=0.07;for(let i=0;i<ids.length;i++)s.setVelocity(ids[i],{x:1+Math.sin(t+i),y:0,z:0})},70)})()`)
  console.log('190 resting + 10 moving props, bytes/s A/B',await measure())
  await a.evaluate('clearInterval(__moving)')
  assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[])
  assert.deepEqual(await Promise.all([a.evaluate('__propLinks'),b.evaluate('__propLinks')]),[0,0])
  console.log('two-process browser checks passed')
} finally {
  for(const s of sockets)s.close()
  for(const p of children.reverse())p.kill('SIGTERM')
  await sleep(500)
  rmSync(temp,{recursive:true,force:true})
}
