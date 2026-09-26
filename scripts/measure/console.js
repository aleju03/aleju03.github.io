/*
  `npm run measure -- console`: the console, the undo history, the shared
  rules and noclip, headless.

  Appended to measure.mjs's prelude like physics.js (THREE, terrainY, SEA_Y,
  buildChunk and the rest in scope). Every command in the registry is run
  against a real sandbox through a host made of stubs, the way CrtScene's
  host is made of the scene, and each claim the pieces make is checked:

    commands   every registered command runs without throwing, and the
               ones with a plain answer give it (spawn, undo, gravity, tp...)
    parse      typed arguments are refused before a handler sees them, and a
               typo gets a "did you mean"
    complete   names, kinds and places complete; aliases list their command
    history    undo pops the newest entry of its owner only; cleanup takes
               one owner's props or everyone's; a prop removed by other means
               leaves its entry; adopted gibs go with their parent's undo
    rules      offline a proposal applies at once; with a transport it is
               sent, applies nothing, and lands on `apply`
    noclip     flight climbs, crosses a wall with no collision, and toggling
               it off mid-air drops the walker onto the ground with the
               flight's momentum

  Prints one PASS/FAIL line per claim and exits non-zero on any FAIL.
*/
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { SCENARIOS } from '../../src/game/sandbox/scenarios.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { createWalkController } from '../../src/game/player/walkController.ts'
import {
  commandList, complete, createConsole, registerCommand, say,
} from '../../src/game/sandbox/commands.ts'
import { historyOf, LOCAL } from '../../src/game/sandbox/history.ts'
import { createWorldRules } from '../../src/game/sandbox/rules.ts'
import { BINDINGS, BOUND_CODES, keyHint } from '../../src/game/sandbox/bindings.ts'

let fails = 0
const check = (ok, what, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
}
const en = (lines) => lines.map((l) => say(l.text, 'en') + (l.right ? ` ${say(l.right, 'en')}` : ''))

const flat = SCENARIOS.find((s) => s.id === 'sandbox:stack').site()
const collision = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, [])
const sb = createSandbox({ collision, waterY: () => SEA_Y })
await sb.whenReady
const history = historyOf(sb)
const rules = createWorldRules()
rules.onChange((k, v) => {
  if (k === 'gravity') sb.gravity = -34 * v
  else sb.timescale = v
})
const EYE = 3.84
const gy = terrainY(flat.x, flat.z)
const me = { x: flat.x, y: gy, z: flat.z, yaw: 0, noclip: false, god: false, tod: null, fog: 1 }
let flung = null
const host = {
  sandbox: () => sb,
  history: () => history,
  rules,
  online: () => false,
  // standing at the site, looking north and a little down
  aim: () => ({
    origin: { x: me.x, y: me.y + EYE, z: me.z },
    dir: new THREE.Vector3(0, -0.35, -1).normalize(),
  }),
  here: () => ({ ...me }),
  teleport: (x, z, y) => Object.assign(me, { x, z, y: y ?? terrainY(x, z) }),
  home: () => ({ x: 0, z: 0 }),
  noclip: (on) => (on === undefined ? me.noclip : (me.noclip = on)),
  god: (on) => (on === undefined ? me.god : (me.god = on)),
  thirdPerson: (on) => Boolean(on),
  fling: (vx, vy, vz) => ((flung = [vx, vy, vz]), true),
  sit: () => false,
  time: (t) => (me.tod = t),
  fog: (k) => (me.fog = k),
  players: () => [{ id: 7, name: 'Sofia', x: 10, y: 5, z: 20 }],
  chat: () => false,
  tools: () => ['physgun'],
  give: (t) => t === 'physgun',
  clear: () => {},
}
const con = createConsole(host)
const run = async (line) => en(await con.run(line))
const settle = (s = 0.5) => {
  for (let i = 0; i < s * 60; i++) sb.tick({ dt: 1 / 60, active: true, focus: { x: me.x, y: me.y, z: me.z } })
}
settle(0.1)

/* ----------------------------------------------------------- commands -- */
{
  let out = await run('spawn crate 10')
  check(sb.count === 10 && /x10/.test(out.join()), 'spawn crate 10 makes ten crates', out.slice(1).join(' / '))
  settle(1)
  const ys = []
  sb.forEach((p) => ys.push(p.body.translation().y))
  check(Math.min(...ys) > gy - 1, 'the pile lands on the ground, not in it', `lowest ${(Math.min(...ys) - gy).toFixed(2)} over`)
  out = await run('undo')
  check(sb.count === 0 && /undone/.test(out.join()), 'undo takes all ten back in one press', out.slice(1).join())
  out = await run('undo')
  check(/nothing left/.test(out.join()), 'a second undo says there is nothing left')
  await run('gravity moon')
  check(Math.abs(rules.gravity - 0.17) < 1e-6 && Math.abs(sb.gravity + 34 * 0.17) < 1e-6, 'gravity moon reaches the sandbox')
  await run('sv_gravity 600')
  check(rules.gravity === 1, "sv_gravity 600 (Garry's Mod units) is normal gravity")
  await run('timescale 0.25')
  check(sb.timescale === 0.25, 'timescale 0.25 reaches the sandbox')
  await run('timescale 1')
  await run('time dusk')
  check(Math.abs(me.tod - 0.765) < 1e-6, 'time dusk pins the clock')
  await run('time 18:30')
  check(Math.abs(me.tod - 18.5 / 24) < 1e-6, 'time 18:30 pins the clock')
  await run('tp 100 -50')
  check(me.x === 100 && me.z === -50, 'tp x z moves the feet')
  await run('tp sof')
  check(me.x === 12.5 && me.z === 22.5, 'tp to a player by a prefix of the name lands beside them')
  out = await run('tp landmark:lighthouse')
  check(/landmark|lighthouse/i.test(out.join()) && me.x !== 12.5, 'tp landmark:lighthouse finds one', out.slice(1).join())
  out = await run('tp town:downtown')
  check(me.x !== 12.5, 'tp town:downtown finds a street', out.slice(1).join())
  Object.assign(me, { x: flat.x, z: flat.z, y: gy })
  await run('noclip')
  check(me.noclip === true, 'noclip toggles on')
  await run('fly')
  check(me.noclip === false, 'its alias toggles it off')
  await run('kill')
  check(flung && flung[1] > 0, 'kill throws the body')
  await run('spawn barrel 3')
  settle(0.5)
  out = await run('explode 2')
  check(/boom/.test(out.join()), 'explode throws what is near the crosshair', out.slice(1).join())
  await run('freezeall')
  let frozen = 0
  sb.forEach((p) => p.mode === 'frozen' && frozen++)
  check(frozen === 3, 'freezeall freezes all three barrels', `${frozen}`)
  await run('unfreezeall')
  frozen = 0
  sb.forEach((p) => p.mode === 'frozen' && frozen++)
  check(frozen === 0, 'unfreezeall lets them go')
  out = await run('cleanup')
  check(sb.count === 0, 'cleanup clears them', out.slice(1).join())
  out = await run('give physgun')
  check(/physgun/.test(out.join()), 'give hands over a tool the host offers')
  // and nothing in the registry throws, whatever it is given
  let broke = []
  for (const c of commandList()) {
    for (const line of [c.name, `${c.name} 1`, `${c.name} crate`]) {
      const o = await run(line)
      if (o.some((l) => /that broke/.test(l))) broke.push(`${line}: ${o.find((l) => /broke/.test(l))}`)
    }
  }
  sb.clear()
  check(broke.length === 0, `all ${commandList().length} commands run without throwing`, broke.join('; '))
}

/* -------------------------------------------------------------- parse -- */
{
  let out = await run('spawn crate lots')
  check(/has to be a number/.test(out.join()), 'a word where a number goes is refused')
  out = await run('spwan crate')
  check(/did you mean spawn/.test(out.join()), 'a typo gets a did-you-mean')
  out = await run('spawn crat')
  check(/did you mean crate/.test(out.join()), 'a misspelled kind gets one too')
  out = await run('/spawn')
  check(/usage/.test(out.join()), 'a missing argument prints the usage')
  // a second registration replaces the first: the explosion module's seam
  let replaced = false
  registerCommand({ name: 'explode', help: 'test', run: () => void (replaced = true) })
  await run('explode')
  check(replaced, 'registerCommand replaces a command by name (the explode seam)')
}

/* ----------------------------------------------------------- complete -- */
{
  const names = (l) => complete(l, host).suggestions.map((s) => say(s.label, 'en'))
  check(names('/sp').some((n) => n.startsWith('spawn')), 'a command name completes', names('/sp').join(', '))
  check(names('/spawn ').includes('crate'), 'a kind completes', names('/spawn ').join(', '))
  check(names('/tp landmark:w').includes('landmark:windmill'), 'a place completes', names('/tp landmark:w').join(', '))
  check(names('/tp so').includes('Sofia'), 'a player name completes')
  check(names('/sv_g').some((n) => n.startsWith('gravity')), 'an alias lists the command it stands for')
}

/* ------------------------------------------------------------ history -- */
{
  const A = 11
  const B = 12
  const at = (dx) => ({ x: flat.x + dx, y: gy + 3, z: flat.z })
  const a1 = sb.spawn('crate', at(0))
  const b1 = sb.spawn('ball', at(4))
  const a2 = sb.spawn('plank', at(8))
  history.record({ owner: A, label: 'crate', props: a1 })
  history.record({ owner: B, label: 'ball', props: b1 })
  history.record({ owner: A, label: 'plank', props: a2 })
  let e = history.undo(B)
  check(e?.label === 'ball' && !sb.get(b1) && sb.get(a2), "undo pops the owner's newest entry and nobody else's")
  // a gib adopted by its parent goes with the parent's undo
  const gib = sb.spawn('block', at(12))
  history.adopt(a2, [gib])
  e = history.undo(A)
  check(e?.label === 'plank' && !sb.get(gib), 'adopted gibs go with their parent')
  // removed by other means: the entry forgets it, and an empty entry goes
  sb.remove(a1)
  check(history.entries(A).length === 0, 'a prop removed elsewhere drops its empty entry')
  const c1 = sb.spawn('crate', at(0))
  const c2 = sb.spawn('crate', at(4))
  history.record({ owner: A, label: 'crate', props: c1 })
  history.record({ owner: B, label: 'crate', props: c2 })
  const n = history.cleanup(A)
  check(n === 1 && sb.get(c2) && !sb.get(c1), "cleanup takes one owner's props only")
  sb.spawn('cone', at(8)) // recorded by nobody: a scenario's
  history.cleanup('all')
  check(sb.count === 0, "cleanup all takes everyone's, and unrecorded props too")
  history.me = LOCAL
}

/* -------------------------------------------------------------- rules -- */
{
  const r = createWorldRules()
  let heard = null
  r.onChange((k, v) => (heard = [k, v]))
  check(r.propose('gravity', 0.5) === 'applied' && r.gravity === 0.5 && heard?.[1] === 0.5, 'offline a proposal applies at once')
  const sent = []
  r.transport = { rule: (k, v) => sent.push([k, v]), action: (a) => sent.push([a]) }
  const how = r.propose('timescale', 0.2)
  check(how === 'sent' && r.timescale === 1 && sent.length === 1, 'online it is sent and applies nothing')
  r.apply('timescale', 0.2)
  check(r.timescale === 0.2, 'and lands when the server announces it')
  let ran = false
  check(r.act('cleanup-all', () => (ran = true)) === 'sent' && !ran, 'cleanup of everyone is sent online, not run')
  check(r.propose('gravity', 99) === 'sent' && sent.at(-1)[1] === 4, 'a proposal is clamped before it leaves')
}

/* ------------------------------------------------------------- noclip -- */
{
  const cam = new THREE.PerspectiveCamera()
  const walk = createWalkController(cam, {
    eye: EYE, speed: 5.9, runSpeed: 9.4, crouchSpeed: 2.8, crouchDrop: 0.85,
    jumpV: 11.9, grav: 34, step: EYE * 0.12,
  })
  // a wall two units thick, ten tall, across the way north
  const x0 = flat.x
  const z0 = flat.z
  const wall = new THREE.Box3(new THREE.Vector3(x0 - 10, gy - 1, z0 - 12), new THREE.Vector3(x0 + 10, gy + 10, z0 - 10))
  const cs = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, [wall])
  const keys = new Set()
  let last
  const drive = (s) => {
    for (let i = 0; i < s * 60; i++) {
      last = walk.update({
        dt: 1 / 60, keys, frozen: false, groundY: 0, groundAt: terrainY, waterY: SEA_Y, collision: cs, fovBase: 70,
      })
    }
    return last
  }
  walk.spawnAt(x0, z0, 0, terrainY(x0, z0))
  walk.resetMotion()
  keys.add('KeyW')
  drive(3)
  check(cam.position.z > z0 - 10.5, 'walking, the wall stops you', `z ${(cam.position.z - z0).toFixed(1)}`)
  keys.clear()
  walk.noclip = true
  keys.add(BINDINGS.flyUp[0])
  drive(1)
  const up1 = walk.feetY - gy
  check(up1 > 10, 'noclip: space rises', `${up1.toFixed(1)} units in 1 s`)
  keys.clear()
  walk.pitch = -0.4
  keys.add('KeyW')
  const z1 = cam.position.z
  drive(1.5)
  check(cam.position.z < z0 - 14 && last.flying, 'noclip: w flies where you look, through the wall', `${(z1 - cam.position.z).toFixed(1)} units north`)
  const cruise = Math.hypot(last.vx, last.vy, last.vz)
  keys.add(BINDINGS.flyFast[0])
  drive(1)
  const fast = Math.hypot(last.vx, last.vy, last.vz)
  keys.delete(BINDINGS.flyFast[0])
  keys.add(BINDINGS.flySlow[0])
  drive(1)
  const slow = Math.hypot(last.vx, last.vy, last.vz)
  check(fast > cruise * 2.5 && slow < cruise * 0.4, `noclip: ${BINDINGS.flyFast[0]} fast, ${BINDINGS.flySlow[0]} slow`,
    `${slow.toFixed(1)} / ${cruise.toFixed(1)} / ${fast.toFixed(1)} u/s`)
  keys.clear()
  // let go: it coasts to a stop rather than stopping dead
  drive(0.1)
  const coast = Math.hypot(last.vx, last.vy, last.vz)
  drive(2)
  check(coast > 1 && Math.hypot(last.vx, last.vy, last.vz) < 0.2, 'noclip: letting go coasts, then stops', `${coast.toFixed(1)} u/s a tenth in`)
  // now off, mid-air with some drift: it falls, keeps the drift, and lands
  walk.pitch = 0
  keys.add(BINDINGS.flyUp[0])
  drive(2)
  keys.clear()
  keys.add('KeyW')
  drive(0.5)
  keys.clear()
  const vz0 = last.vz
  const high = walk.feetY - terrainY(cam.position.x, cam.position.z)
  walk.noclip = false
  drive(0.05)
  check(!last.flying && last.vz < -1 && Math.abs(last.vz - vz0) < 3, 'off mid-air: the flight becomes a fall with its drift', `vz ${vz0.toFixed(1)} -> ${last.vz.toFixed(1)}, ${high.toFixed(1)} up`)
  let landed = 0
  for (let i = 0; i < 400 && !landed; i++) {
    drive(1 / 60)
    if (last.landing > 0) landed = last.landing
  }
  const rest = walk.feetY - terrainY(cam.position.x, cam.position.z)
  check(landed > 0 && Math.abs(rest) < 0.3, 'and lands on the ground', `landing at ${landed.toFixed(1)} u/s, feet ${rest.toFixed(2)} off`)
}

/* ----------------------------------------------------------- bindings -- */
{
  const codes = Object.values(BINDINGS).flat()
  check(codes.every((c) => BOUND_CODES.has(c)), 'every bound code is tracked by the input service')
  check(keyHint('{noclip} fly · {camera} camera') === 'v fly · f5 camera', 'hints read their keys off the table', keyHint('{noclip} fly · {camera} camera'))
  check(keyHint('{jump} saltar', 'es') === 'espacio saltar', 'and name them in Spanish')
}

sb.dispose()
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
