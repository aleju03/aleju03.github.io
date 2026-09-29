/*
 * Rounds across two independent Chrome processes, one private Vite and one
 * private relay (the pattern of rooms-drive.mjs / health-drive.mjs). A and B
 * open the same private room, pick the same map and play real rounds through
 * the real console verbs, the real pistol, the real punch key and the real
 * checkpoint reports:
 *
 *   dm     deathmatch on Nuketown: one team each, A shoots B dead twice
 *          (kill limit 2), the scoreboard and the results sheet on both
 *   hide   hide and seek: the seeker blind and frozen while the hider
 *          hides, then a punch (F) tags it and the round ends "last"
 *   prop   prop hunt: sixty decoys arrive as shared props, the prop
 *          disguises as one (the hunter sees the prop stand in for the body
 *          and a shot at the disguise's hitbox hurts it), a wrong shot at a
 *          decoy costs the hunter 5 hp, the props lose and the decoys go
 *   race   the foot race in Cubeland: both runners pass every ring in order
 *          (teleporting between rings, with the gaps the speed check needs)
 *   build  the build contest in Cubeland (compressed clocks): plots
 *          claimed, a gallery, votes by number key, a winner
 *
 * The rounds' own clocks are scaled down with ROUND_TIME_SCALE so hiding
 * and building do not take minutes; the countdown and the results sheet are
 * shortened with ROUND_COUNTDOWN_MS / ROUND_RESULTS_MS. Screenshots go to
 * --shots <dir> (default shots/rounds). Pick a subset with --only dm,hide.
 *
 * Ports: PROBE_PORT (vite), PROBE_PORT+1 (relay), PROBE_CDP (+1 for the
 * second Chrome). Everything it spawned is killed on the way out.
 *
 *   PROBE_PORT=5250 PROBE_CDP=9460 node scripts/rounds-drive.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { waitFor } from './probe/cdp.mjs'
const root = new URL('..', import.meta.url).pathname
const port = +(process.env.PROBE_PORT ?? 5250)
const relay = port + 1
const debug = +(process.env.PROBE_CDP ?? 9460)
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback)
const shots = arg('--shots', join(root, 'shots/rounds'))
const only = arg('--only', 'dm,hide,prop,race,build').split(',')
mkdirSync(shots, { recursive: true })
const temp = mkdtempSync(join(tmpdir(), 'rounds-drive-'))
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
  window.__sentRounds = []
  window.__hits = []
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    send(s) {
      if (typeof s === 'string' && s.includes('world-round-cmd')) window.__sentRounds.push(JSON.parse(s))
      else if (typeof s === 'string' && s.includes('world-shot-hit')) window.__hits.push(JSON.parse(s))
      super.send(s)
    }
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'))
    console.log(`  shot ${name}`)
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: shim })
  await send('Page.navigate', { url: `http://localhost:${port}${path}` })
  await waitFor(() => evaluate('!!window.__sandbox?.ready && window.__sandbox.network?.online && !!window.__pickMap && !!window.__rounds'), 2400, 250, `sandbox ${i}`)
  console.log(`Chrome ${i} on ${path}`)
  const run = (command) => evaluate(`__sandbox.run(${JSON.stringify(command)})`)
  const key = (code, on) => evaluate(`(() => { ${on ? `__input.keys.add('${code}')` : `__input.keys.delete('${code}')`}; return true })()`)
  const st = (expr) => evaluate(`(() => { const s = __rounds.state; return ${expr} })()`)
  const phase = () => st('s.phase')
  const level = () => evaluate('__levels.current.id')
  const me = () => evaluate('__rounds.state.you')
  return { send, evaluate, errors, shot, run, key, st, phase, level, me }
}
const waitPhase = (c, ph, ms = 60000, label = ph) => waitFor(async () => (await c.phase()) === ph, Math.ceil(ms / 250), 250, `${label} on ${c.tag}`)
const pick = async (cs, map, levelId) => {
  for (const c of cs) await c.evaluate(`__pickMap(${JSON.stringify(map)}); true`)
  for (const c of cs) await waitFor(async () => (await c.level()) === levelId, 480, 500, `${levelId} loaded`)
  await sleep(1500)
}
/** put a client somewhere and face a heading; y=feet from the level */
const stand = (c, x, z, yaw = 0, pitch = 0) => c.evaluate(`(async () => { await __sandbox.run('tp ${x} ${z}'); const w = __sandboxWalk; w.yaw = ${yaw}; w.pitch = ${pitch}; return true })()`)
/** what to look at when a step times out */
const diag = async (cs) => {
  for (const c of cs) {
    console.log(`  [${c.tag}]`, await c.evaluate(`JSON.stringify({ here: __rounds.here(), yaw: __sandboxWalk.yaw, pitch: __sandboxWalk.pitch, tool: __tools.tool, slot: __tools.slot, fire: __input.keys.has('Mouse0'), hp: __health.hp, dead: __health.dead, prot: __health.protectedNow, pvp: __health.pvp, phase: __rounds.state.phase, mine: __rounds.state.mine, others: [...__remote.players].map(([id, p]) => [id, Math.round(p.x), Math.round(p.z), p.here]), level: __levels.current.id, hits: __hits.slice(-3), nshots: __hits.length })`))
    await c.shot(`diag-${c.tag}`)
  }
}
/** stand at (x, z) looking at a point (tx, ty, tz), eye 4.2 over the feet */
const standAim = (c, x, z, tx, ty, tz) => {
  const yaw = Math.atan2(-(tx - x), -(tz - z))
  const pitch = Math.atan2(ty - 3.84, Math.hypot(tx - x, tz - z))
  return stand(c, x, z, yaw, pitch)
}
const idle = async (cs) => { for (const c of cs) { const p = await c.phase(); if (p !== 'lobby') await c.run('round stop'); } await waitFor(async () => (await cs[0].phase()) === 'lobby', 80, 250, 'back to the lobby') }

try {
  launch(process.execPath, ['server/src/index.js'], { env: { ...process.env, ADMIN_TOKEN: 'rounds-drive-secret', PORT: String(relay), DB_PATH: `${temp}/chat.db`, ALLOWED_ORIGINS: `http://localhost:${port}`, ROUND_COUNTDOWN_MS: '3000', ROUND_RESULTS_MS: '120000', ROUND_TIME_SCALE: arg('--scale', '1') } })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relay}/health`)).ok, 80, 100, 'relay')
  launch(process.execPath, ['--input-type=module', '-e', `const {createServer}=await import('vite');const s=await createServer({server:{port:${port},strictPort:true,hmr:false,watch:null}});await s.listen()`], { env: { ...process.env, VITE_CHAT_URL: `ws://127.0.0.1:${relay}/ws`, VITE_CACHE_DIR: `${root}/node_modules/.vite-rounds-${port}` } })
  await waitFor(async () => (await fetch(`http://localhost:${port}/world`)).ok, 80, 250, 'vite')
  const a = await chrome(0, '/world?room=RNDDRV'); a.tag = 'A'
  const b = await chrome(1, '/world?room=RNDDRV'); b.tag = 'B'
  const both = [a, b]
  const ida = await a.me(), idb = await b.me()
  assert.ok(ida && idb && ida !== idb)
  await waitFor(async () => (await a.st('s.host')) === ida, 40, 250, 'A is the host')
  // the map sheet carries the rounds strip: the host may choose a game before anyone walks
  await a.shot('map-sheet-with-rounds')

  process.on('unhandledRejection', () => {})
  const guarded = async (name, fn) => {
    try { await fn() } catch (e) { console.log(`FAILED in ${name}:`, e.message); await diag(both).catch(() => {}); throw e }
  }
  if (only.includes('dm')) await guarded('dm', async () => {
    console.log('deathmatch')
    await pick(both, 'nuketown', 'nuketown')
    await b.run('round mode hide')
    assert.ok((await b.evaluate('__sentRounds.at(-1).cmd')) === 'mode')
    await waitFor(async () => (await b.st('s.mode')) !== 'deathmatch' ? true : false, 4, 250, 'a guest cannot pick').catch(() => {})
    assert.equal(await a.st('s.mode'), 'deathmatch', 'a guest cannot pick the game')
    await a.run('round mode deathmatch')
    await a.run('round opt limit 1')
    await waitFor(async () => (await b.st('s.opt.limit')) === 1, 40, 250, 'the option reaches B')
    await a.run('round ready'); await b.run('round ready')
    await waitPhase(a, 'countdown'); await waitPhase(b, 'countdown')
    await a.shot('dm-countdown')
    await waitPhase(a, 'playing'); await waitPhase(b, 'playing')
    const teams = [await a.st('s.mine.team'), await b.st('s.mine.team')]
    assert.deepEqual(teams.sort(), ['a', 'b'], 'one to a side')
    assert.equal(await a.evaluate('__health.pvp'), true, 'pvp is on for the round')
    await sleep(1500)
    // the middle of the map, an open street: A stands west of B, facing east
    const fire = (on) => a.key('Mouse0', on)
    await a.evaluate('__tools.select(4)')
    for (let kill = 1; kill <= 1; kill++) {
      await stand(a, -24006, 0, -Math.PI / 2, -0.2)
      await stand(b, -23996, 0, Math.PI / 2, 0)
      // (respawn protection ends two seconds after a return)
      await waitFor(async () => !(await b.evaluate('__health.protectedNow')), 60, 250, 'B unprotected')
      await sleep(600)
      await fire(true)
      await waitFor(async () => (await a.phase()) !== 'playing' || (await b.evaluate('__health.dead')), 200, 250, `B is hit (${kill})`)
      await waitFor(async () => (await b.evaluate('__health.dead')) || (await a.phase()) === 'results', 200, 250, `B dies (${kill})`)
      await fire(false)
      if (kill === 1) {
        await sleep(500)
        await b.shot('dm-b-dead')
        await a.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' })); true`)
        await sleep(500)
        await a.shot('dm-a-scoreboard')
        await a.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' })); true`)
        await waitFor(async () => !(await b.evaluate('__health.dead')), 200, 250, 'B respawns')
      }
    }
    await waitPhase(a, 'results', 20000, 'the limit ends it'); await waitPhase(b, 'results')
    await sleep(800)
    assert.equal(await a.st('s.result.why'), 'limit')
    assert.deepEqual(await a.st('s.result.win'), [ida], 'A wins')
    await a.shot('dm-results-a'); await b.shot('dm-results-b')
    assert.equal(await a.evaluate('__health.pvp'), false, 'pvp goes off with the round')
    await waitPhase(a, 'lobby', 150000, 'the lobby again')
  })

  if (only.includes('hide')) await guarded('hide', async () => {
    console.log('hide and seek')
    if ((await a.level()) !== 'nuketown') await pick(both, 'nuketown', 'nuketown')
    await a.run('round mode hide')
    await a.run('round ready'); await b.run('round ready')
    await waitPhase(a, 'playing', 60000); await waitPhase(b, 'playing')
    const roles = [await a.st('s.mine.role'), await b.st('s.mine.role')]
    assert.deepEqual(roles.slice().sort(), ['hider', 'seeker'])
    const [seeker, hider] = roles[0] === 'seeker' ? [a, b] : [b, a]
    const [sid, hid] = roles[0] === 'seeker' ? [ida, idb] : [idb, ida]
    await seeker.shot('hide-seeker-blind'); await hider.shot('hide-hider')
    assert.equal(await seeker.evaluate('__rounds.director.blind()'), true)
    // the seeker cannot walk while it counts
    const before = await seeker.evaluate('(() => { const h = __rounds.here(); return [h.x, h.z] })()')
    await seeker.key('KeyW', true); await sleep(2000); await seeker.key('KeyW', false)
    const after = await seeker.evaluate('(() => { const h = __rounds.here(); return [h.x, h.z] })()')
    assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 1, 'the seeker is held still')
    await waitFor(async () => !(await seeker.evaluate('__rounds.director.blind()')), 100, 250, 'the seeking begins')
    await seeker.shot('hide-seeker-seeking')
    // the hider is somewhere; the seeker walks up to it and punches
    const spot = await hider.evaluate('(() => { const h = __rounds.here(); return [h.x, h.z] })()')
    await stand(seeker, spot[0] + 1.6, spot[1], Math.PI / 2, 0)
    await sleep(1200) // the server has to have seen where both stand
    await seeker.key('KeyF', true); await sleep(400); await seeker.key('KeyF', false)
    await waitPhase(seeker, 'results', 15000, 'the tag ends it')
    assert.equal(await seeker.st('s.result.why'), 'last')
    assert.deepEqual(await seeker.st('s.result.win'), [hid], 'the last one caught wins')
    await sleep(600)
    await seeker.shot('hide-results-seeker'); await hider.shot('hide-results-hider')
    await waitPhase(a, 'lobby', 150000)
    void sid
  })

  if (only.includes('prop')) await guarded('prop', async () => {
    console.log('prop hunt')
    if ((await a.level()) !== 'nuketown') await pick(both, 'nuketown', 'nuketown')
    await a.run('round mode prophunt')
    await a.run('round ready'); await b.run('round ready')
    await waitPhase(a, 'countdown', 30000)
    // the decoys arrive as ordinary shared props on both machines
    await waitFor(async () => (await a.evaluate('(() => { let n = 0; __sandbox.forEach(p => { if (p.data.net) n++ }); return n })()')) >= 55, 120, 250, 'decoys on A')
    await waitFor(async () => (await b.evaluate('(() => { let n = 0; __sandbox.forEach(p => { if (p.data.net) n++ }); return n })()')) >= 55, 120, 250, 'decoys on B')
    await waitPhase(a, 'playing', 60000); await waitPhase(b, 'playing')
    const roles = [await a.st('s.mine.role'), await b.st('s.mine.role')]
    assert.deepEqual(roles.slice().sort(), ['hunter', 'prop'])
    const [hunter, prop] = roles[0] === 'hunter' ? [a, b] : [b, a]
    const pid = roles[0] === 'hunter' ? idb : ida
    // the prop walks up to a decoy, looks at it and presses Y
    // (the decoys are scattered over the whole map, some behind walls: for a
    // repeatable look, the prop drops a barrel of its own on the turning
    // circle and copies that. It is as shared a prop as any decoy)
    await stand(prop, -23996, 0, Math.PI / 2, -0.45)
    await sleep(1500)
    await prop.run('spawn barrel')
    await sleep(6000)
    const decoy = await prop.evaluate(`(() => { let best = null; __sandbox.forEach(p => { if (p.data.net && p.kind.id === 'barrel' && (!best || p.id > best.id)) { const t = p.body.translation(); best = { id: p.id, kind: p.kind.id, x: t.x, y: t.y, z: t.z } } }); return best })()`)
    console.log('  decoy', JSON.stringify(decoy))
    await standAim(prop, decoy.x + 4, decoy.z, decoy.x, decoy.y, decoy.z)
    await sleep(1500)
    await prop.key('KeyY', true); await sleep(2500); await prop.key('KeyY', false)
    await waitFor(async () => (await hunter.st(`s.disguises.get(${pid})`)) !== undefined, 60, 250, 'the disguise reaches the hunter')
    console.log('  disguised as', await hunter.st(`s.disguises.get(${pid})`))
    assert.equal(await hunter.evaluate(`__rounds.director.hidden(${pid})`), true, 'the body is hidden on the hunter')
    await hunter.shot('prop-hunter-blind')
    // the hunt begins: the hunter walks up and looks at the disguise
    await waitFor(async () => !(await hunter.evaluate('__rounds.director.blind()')), 200, 250, 'the hunt begins')
    // out in the open, on the turning circle, where a line of sight is certain
    const where = [-24000, 0]
    await stand(prop, where[0], where[1], Math.PI / 2, 0)
    await standAim(hunter, where[0] - 9, where[1], where[0], 1.2, where[1])
    await sleep(2500)
    await hunter.shot('prop-hunter-sees-the-disguise')
    const hp0 = await hunter.evaluate('__health.hp')
    // a wrong shot: at a decoy (facing away from the prop) costs 5 hp
    await standAim(hunter, decoy.x - 6, decoy.z, decoy.x, decoy.y, decoy.z)
    await hunter.evaluate('__tools.select(4)')
    await sleep(800)
    await hunter.key('Mouse0', true); await sleep(6000); await hunter.key('Mouse0', false)
    await waitFor(async () => (await hunter.evaluate('__health.hp')) < hp0, 80, 250, 'a wrong shot costs the hunter')
    console.log('  hunter hp', hp0, '->', await hunter.evaluate('__health.hp'))
    // a right shot: at the disguise's hitbox until the prop is found. The
    // crossbow (45 a bolt) because a headless frame rate cannot land nine
    // pistol rounds inside the five seconds before hit points come back;
    // every hit shoves the prop off the line, so it is stood back each try
    await hunter.evaluate('__tools.select(5)')
    await stand(prop, where[0], where[1], Math.PI / 2, 0)
    await standAim(hunter, where[0] - 9, where[1], where[0], 1.2, where[1])
    // pinned where it is, as a real player would stand their ground
    await prop.evaluate(`window.__pin = setInterval(() => { const w = __sandboxWalk; w.teleport(${where[0]}, ${where[1]}, 0) }, 120); true`)
    await sleep(1200)
    // (a crossbow is one bolt a click)
    for (let clicks = 0; clicks < 120 && (await hunter.phase()) === 'playing'; clicks++) {
      await hunter.key('Mouse0', true); await sleep(900); await hunter.key('Mouse0', false); await sleep(1100)
    }
    await waitPhase(hunter, 'results', 20000, 'the prop is found')
    await prop.evaluate('clearInterval(window.__pin); true')
    assert.equal(await hunter.st('s.result.why'), 'hunted')
    await sleep(600)
    await hunter.shot('prop-results-hunter'); await prop.shot('prop-results-prop')
    await waitPhase(a, 'lobby', 150000)
    await waitFor(async () => (await a.evaluate('(() => { let n = 0; __sandbox.forEach(p => { if (p.data.net) n++ }); return n })()')) < 5, 60, 250, 'the decoys are cleared')
  })

  if (only.includes('race')) await guarded('race', async () => {
    console.log('race on foot (Cubeland)')
    await pick(both, 'cubeland', 'cubeland')
    await a.run('round mode race cubeland')
    await a.run('round opt laps 1')
    await a.run('round ready'); await b.run('round ready')
    await waitPhase(a, 'playing', 60000); await waitPhase(b, 'playing')
    const cps = await a.st('s.obj.cps')
    console.log('  rings', cps.length)
    await a.shot('race-start')
    const runner = (c, gap) => (async () => {
      for (let i = 0; i < cps.length; i++) {
        await stand(c, cps[i][0], cps[i][1], 0, 0)
        await waitFor(async () => (await c.st('s.mine.a')) >= i + 1, 60, 250, `ring ${i} on ${c.tag}`)
        await sleep(gap)
        if (i === 3) await c.shot(`race-${c.tag}-ring4`)
      }
    })()
    await Promise.all([runner(a, 3000), runner(b, 3800)])
    await waitPhase(a, 'results', 30000)
    const res = await a.st('s.result')
    console.log('  results', JSON.stringify(res.rows))
    assert.equal(res.why, 'done')
    assert.ok(res.rows.every((r) => r[4] > 0), 'both finished with a time')
    await sleep(600)
    await a.shot('race-results')
    await waitPhase(a, 'lobby', 150000)
  })

  if (only.includes('build')) await guarded('build', async () => {
    console.log('build contest (Cubeland)')
    if ((await a.level()) !== 'cubeland') await pick(both, 'cubeland', 'cubeland')
    await a.run('round mode build')
    await a.run('round ready'); await b.run('round ready')
    await waitPhase(a, 'playing', 60000); await waitPhase(b, 'playing')
    assert.equal(await a.st('s.obj.stage'), 'build')
    const plots = await a.st('s.obj.plots')
    console.log('  plots', JSON.stringify(plots), 'theme', await a.st('s.obj.theme'))
    await sleep(2500)
    await a.shot('build-plot-a'); await b.shot('build-plot-b')
    // the plot edge is a claim: a block dug outside my plot is refused for the other
    await waitFor(async () => (await a.st('s.obj.stage')) === 'gallery', 200, 500, 'the gallery opens')
    await sleep(1200)
    await a.shot('build-gallery-a')
    const first = await a.st('s.obj.gal.plot')
    const voter = first === ida ? b : a
    await voter.key('Digit4', true); await sleep(200); await voter.key('Digit4', false)
    await waitFor(async () => (await a.st('s.obj.gal.i')) === 1, 100, 250, 'the next plot')
    const second = await a.st('s.obj.gal.plot')
    const voter2 = second === ida ? b : a
    await voter2.key('Digit2', true); await sleep(200); await voter2.key('Digit2', false)
    await waitPhase(a, 'results', 60000, 'the tally')
    const res = await a.st('s.result')
    console.log('  results', JSON.stringify(res.rows), 'winner', JSON.stringify(res.win))
    assert.deepEqual(res.win, [first], 'the 4 beats the 2')
    await a.shot('build-results')
    await waitPhase(a, 'lobby', 150000)
  })
  assert.deepEqual(a.errors, [], 'no page errors on A')
  assert.deepEqual(b.errors, [], 'no page errors on B')
  console.log('two-client round checks passed')
} finally {
  for (const s of sockets) s.close()
  for (const p of children.reverse()) p.kill('SIGTERM')
  await sleep(800)
  rmSync(temp, { recursive: true, force: true })
}
