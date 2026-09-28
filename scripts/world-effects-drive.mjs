/*
 * Portal and hop-effect integration with two independent Chrome processes,
 * one private Vite and one private relay. CDP drives the public sandbox facade. All processes
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
  window.__linkNames=[]
  window.__propLinks=0
  for(const C of [window.WebGLRenderingContext,window.WebGL2RenderingContext]) {
    if(!C)continue;const link=C.prototype.linkProgram
    C.prototype.linkProgram=function(...a){window.__propLinks++;window.__linkNames.push(this.getAttachedShaders(a[0]).map(s=>this.getShaderSource(s).match(/#define (SHADER_NAME|SHADER_TYPE|USE_[A-Z_]+|NUM_[A-Z_]+)[^\\n]*/g)));return link.apply(this,a)}
  }
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(...args) { super(...args); this.addEventListener('message', e => {
      const m = JSON.parse(e.data), w = window.__wire
      w.in += e.data.length
      if(/^world-(prop-|portal|air-hop)/.test(m.type ?? '')) { w.propIn += e.data.length; w.propFramedIn += e.data.length + (e.data.length < 126 ? 2 : e.data.length < 65536 ? 4 : 10); w.events.push(m); if(w.events.length>1000) w.events.shift() }
    }) }
    send(s) { const w=window.__wire; w.out+=s.length; if(/world-(prop-|portal|air-hop)/.test(s)) {w.propOut+=s.length;w.propFramedOut+=s.length+4+(s.length<126?2:s.length<65536?4:10);w.sent.push(JSON.parse(s));if(w.sent.length>1000)w.sent.shift()}; super.send(s) }
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
  // a walk starts on the map sheet (MapPicker.tsx): stay home
  await waitFor(() => evaluate('!!window.__pickMap'), 80, 250, `map sheet ${i}`)
  await evaluate('window.__pickMap("home"); true')
  console.log(`Chrome ${i} connected`)
  return { send, evaluate, errors }
}
try {
  launch(process.execPath, ['server/src/index.js'], { env: { ...process.env, ADMIN_TOKEN: 'prop-test-secret', PORT: String(relay), DB_PATH: `${temp}/chat.db`, ALLOWED_ORIGINS: `http://localhost:${port}` } })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relay}/health`)).ok, 80, 100, 'relay')
  launch(process.execPath, ['--input-type=module', '-e', `const {createServer}=await import('vite');const s=await createServer({server:{port:${port},strictPort:true,hmr:false,watch:null}});await s.listen()`], { env: { ...process.env, VITE_CHAT_URL: `ws://127.0.0.1:${relay}/ws`, VITE_CACHE_DIR: `${root}/node_modules/.vite-prop-sync-${port}` } })
  await waitFor(async () => (await fetch(`http://localhost:${port}/world`)).ok, 80, 250, 'vite')
  const a = await chrome(0), b = await chrome(1)
  const tp = (c,x,z,y=0.05,yaw=0) => c.evaluate(`__sandbox.console.host.teleport(${x},${z},${y},${yaw})`)
  const portals = c => c.evaluate(`__tools.portals.all.filter(Boolean).map(p=>({owner:p.owner,color:p.color,serial:p.serial,level:p.level,at:p.pos.toArray(),ready:p.ready,anchor:p.anchor?.kind}))`)
  const key = (c,code,down) => c.send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',code,key:code==='Space'?' ':'w',windowsVirtualKeyCode:code==='Space'?32:87})
  await tp(a,0,-7);await tp(b,4,-7);await sleep(2000)
  for(const c of [a,b])await c.evaluate('__propLinks=0;__linkNames=[]')
  await a.evaluate(`window.__panels=[__sandbox.spawn('portal_panel',{x:4,y:3,z:-14},{frozen:true}),__sandbox.spawn('portal_panel',{x:-5,y:3,z:-14},{frozen:true})]`)
  await waitFor(()=>a.evaluate('__panels.every(id=>typeof __sandbox.get(id)?.data.net === "number")'),80,100,'panels')
  await sleep(300)
  const shots=await a.evaluate(`(()=>{const V=__sandboxCamera.position.constructor,l=__levels.current,w={level:l.id,collision:l.collision,groundAt:l.groundYAt,groundY:l.groundY,sandbox:__sandbox};return [4,-5].map((x,color)=>__tools.portals.fire(color,new V(x,3,-6),new V(0,0,-1),w).ok)})()`)
  assert.deepEqual(shots,[true,true])
  await waitFor(async()=>(await portals(b)).filter(p=>p.owner>0).length===2,80,100,'remote pair')
  await waitFor(()=>b.evaluate('__tools.portalView.stats.passes>0'),80,100,'live remote portal view').catch(async e=>{console.log('DEBUG',await b.evaluate('({portals:__tools.portals.all.filter(Boolean).map(p=>({owner:p.owner,color:p.color,at:p.pos.toArray(),n:p.n.toArray(),ready:p.ready,partner:!!__tools.portals.partner(p)})),camera:__sandboxCamera.position.toArray(),rotation:__sandboxCamera.rotation.toArray(),stats:__tools.portalView.stats,meshes:__tools.portalView.root.children.map(m=>({name:m.name,visible:m.visible,mode:m.material?.uniforms?.uMode?.value}))})'));throw e})
  const owner=(await portals(b)).find(p=>p.owner>0).owner
  console.log('portal-gun shots replicated, remote live view rendered',await portals(b))
  const before=await b.evaluate('__portalWalk.last.count')
  await key(b,'KeyW',true)
  try { await waitFor(()=>b.evaluate(`__portalWalk.last.count>${before}`),70,100,'walking through remote portal') }
  finally {await key(b,'KeyW',false)}
  console.log('B walked through A portal',await b.evaluate('[__sandboxCamera.position.x,__sandboxWalk.feetY,__sandboxCamera.position.z]'))
  await tp(b,-12,-7);await sleep(500)
  const clouds=await a.evaluate('__worldEffects.clouds')
  await key(b,'Space',true);await sleep(90);await key(b,'Space',false);await sleep(100)
  await key(b,'Space',true);await sleep(90);await key(b,'Space',false)
  await waitFor(()=>a.evaluate(`__worldEffects.clouds>${clouds}`),60,100,'remote double jump cloud')
  assert.ok(await a.evaluate('__sandbox.stats.particles>0'))
  console.log('B double jump produced a visible cloud on A')
  await a.evaluate('__sandbox.setTransform(__panels[0],{x:7,y:3,z:-14})')
  await waitFor(async()=>Math.abs((await portals(b)).find(p=>p.owner===owner&&p.color===0).at[0]-7)<0.03,80,100,'moving portal panel')
  await b.evaluate(`(()=>{const V=__sandboxCamera.position.constructor;__tools.portals.placeAt(0,'overworld',new V(12,3,-14),new V(0,0,1),new V(0,1,0));return true})()`)
  await waitFor(async()=>(await portals(a)).some(p=>p.owner>0),80,100,'independent B pair')
  assert.equal((await portals(a)).filter(p=>p.owner===0).length,2)
  await a.evaluate('__sandbox.remove(__panels[1])')
  await waitFor(async()=>(await portals(b)).filter(p=>p.owner===owner).length===1,80,100,'anchor removal')
  console.log('moving anchors, independent owners and anchor removal passed')
  console.log('shader links',await Promise.all([a.evaluate('__propLinks'),b.evaluate('__propLinks')]),await b.evaluate('__linkNames'))
  assert.deepEqual(await Promise.all([a.evaluate('__propLinks'),b.evaluate('__propLinks')]),[0,0])
  await b.evaluate('delete window.__sandbox');await b.send('Page.reload')
  await waitFor(()=>b.evaluate('!!window.__sandbox?.ready && __sandbox.network?.online'),360,250,'late join')
  await waitFor(async()=>(await portals(b)).some(p=>p.owner===owner&&Math.abs(p.at[0]-7)<0.03),80,100,'late portal snapshot')
  assert.equal(await b.evaluate('__worldEffects.clouds'),0)
  await a.evaluate('__tools.portals.close()')
  await waitFor(async()=>(await portals(b)).every(p=>p.owner!==owner),80,100,'remote close')
  assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[])
  console.log('late join, remote close and no stale cloud replay: passed')
} finally {
  for(const s of sockets)s.close()
  for(const p of children.reverse())p.kill('SIGTERM')
  await sleep(500)
  rmSync(temp,{recursive:true,force:true})
}
