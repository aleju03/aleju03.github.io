/*
  `npm run measure -- weapons`: the weapons (sandbox/tools/weapons.ts),
  headless, on a real sandbox with no renderer and no network. A pistol
  round pushes and chips a crate and a few break it; a bolt sticks in a
  prop and rides it when the prop moves; a rocket at the ground goes off
  through `sb.explode` where it lands (past the chunks Rapier mirrors, on
  the drawn ground); a rocket at the sky goes off at the end of its range.
  Prints one PASS/FAIL line per claim and exits non-zero on any FAIL.
*/
import { createSandbox, KINDS } from '../../src/game/sandbox/sandbox.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { createWeapons } from '../../src/game/sandbox/tools/weapons.ts'
import { emptyInput } from '../../src/game/sandbox/tools/types.ts'

let fails = 0
const check = (ok, what, detail = '') => { if (!ok) fails++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + what + (detail ? '  (' + detail + ')' : '')) }
const collision = makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, [])
const sb = createSandbox({ collision, waterY: () => -1000 })
await sb.whenReady
const X = 5000, Z = 3000
const gy = sb.groundY(X, Z)
const solid = Object.values(KINDS).find((k) => !k.breaks && !k.explodes && k.mass > 20 && k.mass < 200)
const crate = sb.spawn('crate', { x: X, y: sb.restY('crate', X, Z - 12), z: Z - 12 })
const block = sb.spawn(solid.id, { x: X + 8, y: sb.restY(solid.id, X + 8, Z - 12), z: Z - 12 })
for (let i = 0; i < 120; i++) sb.tick({ dt: 1 / 60, active: true, focus: { x: X, y: gy, z: Z } })
const events = []
const booms = []
sb.onExplosion((e) => booms.push(e))
const w = createWeapons({ sb: () => sb })
w.on((e) => events.push(e))
const input = emptyInput({ eye: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), yaw: 0 })
const aimAt = (id) => {
  const p = new THREE.Vector3(); sb.getTransform(id, p)
  input.aim.eye.set(X, gy + 3.84, Z)
  input.aim.dir.copy(p).sub(input.aim.eye).normalize()
}
const run = (secs, fire, which) => {
  for (let t = 0; t < secs; t += 1 / 60) {
    input.dt = 1 / 60
    input.fire = fire && t < 0.05
    w.update(input, which, null)
    sb.tick({ dt: 1 / 60, active: true, focus: { x: X, y: gy, z: Z } })
    w.step(1 / 60)
  }
}
aimAt(crate)
const v = new THREE.Vector3()
run(0.02, true, 'pistol')
sb.getVelocity(crate, v)
check(events.some((e) => e.type === 'hit' && e.what === 'prop'), 'a pistol round hits the crate')
check(v.length() > 0.2, 'and pushes it', v.length().toFixed(2) + ' u/s')
check(!events.some((e) => e.type === 'reload' || e.type === 'empty'), 'the pistol never reloads')
run(1, false, 'pistol')
for (let i = 0; i < 5 && sb.get(crate); i++) { aimAt(crate); run(0.3, true, 'pistol') }
check(!sb.get(crate), 'a few rounds break a crate')
aimAt(block)
run(1.5, true, 'crossbow')
check(w.stuck.length === 1 && w.stuck[0].prop === block, 'a bolt sticks in a prop', w.stuck.length + ' stuck')
const before = w.stuck[0]?.pos.clone()
sb.setTransform(block, { x: X + 8, y: gy + 6, z: Z - 12 })
run(0.05, false, 'crossbow')
check(before && w.stuck[0].pos.y > before.y + 2, 'and follows the prop', before ? (w.stuck[0].pos.y - before.y).toFixed(2) : '')
input.aim.eye.set(X, gy + 3.84, Z)
input.aim.dir.set(0, -0.4, -1).normalize()
run(0.02, true, 'rocket')
check(w.projectiles.length === 1, 'a rocket is in the air')
run(1.5, false, 'rocket')
check(booms.length === 1, 'and goes off on the ground', booms.length + ' explosion(s)')
const under = booms[0] ? sb.groundY(booms[0].x, booms[0].z) : 0
check(booms[0] && Math.abs(booms[0].y - under) < 1.5, 'where it landed', booms[0] ? (booms[0].y - under).toFixed(2) + ' over the ground' : '')
check(w.loaded('rocket') === 1, 'reloaded')
input.aim.dir.set(0, 1, 0)
run(0.02, true, 'rocket')
run(8, false, 'rocket')
check(booms.length === 2 && booms[1].y > gy + 300, 'a rocket at nothing goes off at its range', booms[1] ? (booms[1].y - gy).toFixed(0) : '')
console.log(fails ? fails + ' FAILED' : 'all passed')
if (fails) process.exitCode = 1
