/*
  Bumping into people, in numbers: `npm run measure -- bodies [section]`.

    street  the film's run (sandbox:bump) headless: four of the town's real
            pedestrians leaned on, charged, landed on and hopped into
    sweep   four hundred approaches at every speed and angle, with and
            without a hop, into a body that gives (a pedestrian) and one
            that does not (another player): the closest two bodies standing
            side by side ever get, and what each kind of approach came to
    cost    the contact pass with a full street and a full lobby around the
            walker, per call
    net     two players: the local walker sprinting and then leaning into a
            remote body played back by the real snapshot store, the shoves
            that produces, and the victim's own client taking them
    emotes  a remote player's emotes and point key through the real store
            and the real avatars: the copy dances on the dancer's beat,
            waves, points its arm where they pointed, and lets go of both
    reach   every emote and five points on every build, plain and in the
            beaver, cap and headset: the closest the drawn mitten and
            forearm (the skinned vertices themselves) ever come to the
            body's own surface, which must never be below zero

  Nothing here draws. The picture is `npm run film -- sandbox:bump`.
*/
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { SCENARIOS, stageScenario, advanceScenario } from '../../src/game/sandbox/scenarios.ts'
import '../../src/game/sandbox/bumpScenarios.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { createWalkController } from '../../src/game/player/walkController.ts'
import { bodyExtent, createBodyContact, CHARGE, TACKLE } from '../../src/game/player/bodyContact.ts'
import { buildPlayerBody } from '../../src/game/player/playerBody.ts'
import { createRemoteWorld } from '../../src/game/net/remotePlayers.ts'
import { createRemoteBumps, createShoveTaker } from '../../src/game/net/shove.ts'
import { createRemoteAvatars } from '../../src/game/net/avatars.ts'
import { EMOTES, packEmote } from '../../src/game/player/emotes.ts'
import { createSelfContact } from '../../src/game/player/selfContact.ts'
import { B, setBodyBuildSync } from '../../src/game/player/bodyShape.ts'
import { DEFAULT_LOOK } from '../../src/game/player/look.ts'

const only = process.argv[2]
const want = (s) => !only || only === s
const EYE = 3.84
const TUNE = { eye: EYE, speed: 5.9, runSpeed: 9.4, crouchSpeed: 2.8, crouchDrop: 0.85, jumpV: 11.9, grav: 34, step: EYE * 0.12 }
const open = () => makeCollisionSet({ minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 })
const f = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : String(n))

// one real body, for the sizes everything below collides at
const probe = buildPlayerBody(EYE, 34)
const EXT = bodyExtent(probe.group, { radius: 0, height: 0 })
console.log(`body     measured off the rig's mesh: radius ${f(EXT.radius, 2)}, height ${f(EXT.height, 2)} ` +
  `(contact at ${f(EXT.radius * 2, 2)} between centres)`)

/* ------------------------------------------------------------- street -- */
if (want('street')) {
  const s = SCENARIOS.find((o) => o.id === 'sandbox:bump')
  const sb = createSandbox({ collision: open(), walker: false })
  await sb.whenReady
  const c = stageScenario(s, sb)
  advanceScenario(s, c, s.duration)
  console.log(`street   at ${Math.round(c.x)},${Math.round(c.z)}: ${s.report(c)}`)
  console.log(`         state hash ${s.hash(c)} (the film prints the same one)`)
  sb.dispose()
}

/* -------------------------------------------------------------- sweep -- */
/*
  A walker and one body, over and over. The body is a plain Bumpable: a
  pedestrian takes half of every overlap and goes down when knocked; another
  player takes none and stays up (their own client decides that). The gap is
  measured the way the pass reports it: between two cylinders standing side
  by side, so a walker on top of a head is not counted as inside it.
*/
const makeSet = (gives) => {
  const b = { x: 0, z: 0, feetY: 0, down: false, knockedBy: 'none' }
  const set = {
    size: 1,
    b,
    peer: (i, out) => {
      if (b.down) return false
      out.x = b.x
      out.z = b.z
      out.feetY = b.feetY
      out.vx = 0
      out.vz = 0
      out.radius = EXT.radius
      out.height = EXT.height
      return true
    },
    nudge: (i, dx, dz) => {
      if (!gives) return false
      b.x += dx
      b.z += dz
      return true
    },
    hit: (i, bump) => {
      if (bump.kind === 'lean') return
      if (b.knockedBy === 'none') b.knockedBy = bump.kind
      if (gives) b.down = true
    },
  }
  return set
}

if (want('sweep')) {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const tally = {}
  let worst = Infinity
  let worstWhat = ''
  let frames = 0
  for (let trial = 0; trial < 400; trial++) {
    const gives = trial % 2 === 0
    const mode = ['crouch', 'walk', 'run'][trial % 3]
    const hop = trial % 5 === 1 ? 'near' : trial % 5 === 3 ? 'far' : null
    const set = makeSet(gives)
    const cam = new THREE.PerspectiveCamera()
    const walk = createWalkController(cam, TUNE)
    const a = rnd() * Math.PI * 2
    const d0 = 7 + rnd() * 4
    walk.spawnAt(Math.cos(a) * d0, Math.sin(a) * d0, 0, 0)
    const keys = new Set()
    const contact = createBodyContact()
    const me = { eye: cam.position, feetY: 0, vx: 0, vz: 0, vy: 0, grounded: true, radius: EXT.radius, height: EXT.height }
    const collision = open()
    // a little off dead centre, so glancing blows are in the sweep too
    const off = (rnd() - 0.5) * 2.2
    let jumped = false
    for (let i = 0; i < 180; i++) {
      const t = i / 60
      const tx = set.b.x + Math.sin(a) * off
      const tz = set.b.z - Math.cos(a) * off
      walk.yaw = Math.atan2(-(tx - cam.position.x), -(tz - cam.position.z))
      keys.clear()
      keys.add('KeyW')
      if (mode === 'run') keys.add('ShiftLeft')
      if (mode === 'crouch') keys.add('ControlLeft')
      const dist = Math.hypot(set.b.x - cam.position.x, set.b.z - cam.position.z)
      if (hop && !jumped && mode !== 'crouch' && dist < (hop === 'near' ? 3.3 : 4.6)) {
        keys.add('Space')
        jumped = true
      }
      const step = walk.update({ dt: 1 / 60, keys, frozen: false, groundY: 0, collision, fovBase: 60 })
      me.feetY = walk.feetY
      me.vx = step.vx
      me.vz = step.vz
      me.vy = step.vy
      me.grounded = step.grounded
      me.height = EXT.height * (1 - 0.25 * walk.crouchK)
      const r = contact.step({ me, push: walk.push, collision, stepUp: step.grounded ? TUNE.step : 0, sets: [set], now: t })
      frames++
      if (r.gap < worst) {
        worst = r.gap
        worstWhat = `${gives ? 'pedestrian' : 'player'} ${mode}${hop ? ' hop ' + hop : ''} at frame ${i}`
      }
      void t
    }
    const key = `${gives ? 'pedestrian' : 'player   '} ${mode.padEnd(6)} ${(hop ? 'hop ' + hop : 'on foot').padEnd(8)}`
    tally[key] ??= {}
    tally[key][set.b.knockedBy] = (tally[key][set.b.knockedBy] ?? 0) + 1
  }
  console.log(`sweep    400 approaches, ${frames} frames: closest two bodies side by side ever got ` +
    `${f(worst)} (${worst >= -0.01 ? 'no interpenetration' : '<-- INSIDE EACH OTHER'}; ${worstWhat})`)
  console.log(`         knock lines: ${CHARGE} u/s on the ground, ${TACKLE} in the air; walk 5.9, sprint 9.4`)
  for (const k of Object.keys(tally).sort()) {
    console.log(`         ${k}  ${Object.entries(tally[k]).map(([w, n]) => `${w === 'none' ? 'leaned only' : w} ${n}`).join(', ')}`)
  }
}

/* --------------------------------------------------------------- cost -- */
if (want('cost')) {
  // twelve people on a street and sixteen players, all within a few units
  const bodies = []
  for (let i = 0; i < 28; i++) {
    const a = i * 2.39996
    const r = 2.5 + (i % 7) * 1.3
    bodies.push({ x: Math.cos(a) * r, z: Math.sin(a) * r })
  }
  const setOf = (from, to, gives) => ({
    size: to - from,
    peer: (i, out) => {
      const b = bodies[from + i]
      out.x = b.x
      out.z = b.z
      out.feetY = 0
      out.vx = 0
      out.vz = 0
      out.radius = EXT.radius
      out.height = EXT.height
      return true
    },
    nudge: () => gives,
    hit: () => {},
  })
  const sets = [setOf(0, 12, true), setOf(12, 28, false)]
  const contact = createBodyContact()
  const eye = new THREE.Vector3()
  const me = { eye, feetY: 0, vx: 3, vz: 0, vy: 0, grounded: true, radius: EXT.radius, height: EXT.height }
  const collision = open()
  const input = { me, push: () => {}, collision, stepUp: 0.46, sets, now: 0 }
  const N = 20000
  let t0 = performance.now()
  for (let i = 0; i < N; i++) {
    eye.set(Math.sin(i * 0.01) * 6, EYE, Math.cos(i * 0.013) * 6)
    input.now = i / 60
    contact.step(input)
  }
  const crowded = ((performance.now() - t0) / N) * 1000
  // and the usual case: nobody within reach
  t0 = performance.now()
  for (let i = 0; i < N; i++) {
    eye.set(500 + i * 1e-3, EYE, 0)
    input.now = i / 60
    contact.step(input)
  }
  const clear = ((performance.now() - t0) / N) * 1000
  // allocation: a long run's heap should not climb
  const h0 = process.memoryUsage().heapUsed
  for (let i = 0; i < N; i++) {
    eye.set(Math.sin(i * 0.01) * 6, EYE, Math.cos(i * 0.013) * 6)
    input.now = i / 60
    contact.step(input)
  }
  const grew = (process.memoryUsage().heapUsed - h0) / 1024
  console.log(`cost     28 bodies around the walker (12 give, 16 do not): ${f(crowded, 2)} us a frame in the thick of them, ` +
    `${f(clear, 2)} us with nobody in reach; heap moved ${f(grew, 0)} kB over ${N} frames`)
}

/* ---------------------------------------------------------------- net -- */
/*
  Two players, played back the way the game plays them: the remote one is a
  RemoteWorld fed snapshots at 15 Hz and sampled every frame, and its body
  is a real rig. The local walker runs at them, then leans on them, and
  every shove that would go on the wire is handed straight to a second walk
  and rig standing in for the victim's own client.
*/
if (want('net')) {
  const world = createRemoteWorld()
  world.welcome(1, 66, [{ id: 2, name: 'them', admin: false, registered: false }])
  const theirRig = buildPlayerBody(EYE, 34)
  // the victim's side: its own walk and its own body
  const vCam = new THREE.PerspectiveCamera()
  const victim = createWalkController(vCam, TUNE)
  victim.spawnAt(0, -8, 0, 0)
  const vRig = buildPlayerBody(EYE, 34)
  const taker = createShoveTaker()
  let clock = 0
  const sent = []
  const effects = { stumble: 0, flop: 0, ignore: 0 }
  const v = new THREE.Vector3()
  const bumps = createRemoteBumps({
    world,
    rigOf: (id) => (id === 2 ? theirRig : null),
    seated: () => false,
    now: () => clock,
    send: (to, vx, vy, vz) => {
      sent.push([to, vx, vy, vz])
      v.set(vx, vy, vz)
      const fx = taker.take(v, clock, !vRig.down)
      effects[fx]++
      if (fx === 'flop') vRig.hit(v.clone().multiplyScalar(vRig.mass), new THREE.Vector3(vCam.position.x, 2.4, vCam.position.z))
      else if (fx === 'stumble') victim.push(v.x, 0, v.z)
    },
  })
  const cam = new THREE.PerspectiveCamera()
  const walk = createWalkController(cam, TUNE)
  walk.spawnAt(0, 4, 0, 0) // facing -Z, toward them
  const contact = createBodyContact()
  const me = { eye: cam.position, feetY: 0, vx: 0, vz: 0, vy: 0, grounded: true, radius: EXT.radius, height: EXT.height }
  const collision = open()
  const keys = new Set()
  const vEnv = { groundY: 0, collision }
  const vPose = { dt: 1 / 60, gait: 0, crouchK: 0, grounded: true, run: false, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1 }
  let worst = Infinity
  let lastSnap = -1
  let knockSends = 0
  let downAt = -1
  const phases = []
  for (let i = 0; i < 60 * 6; i++) {
    clock = i / 60
    const nowMs = clock * 1000
    // the victim's client: its walk, its body, and a snapshot every 66 ms
    // of where that walk is, with its down bit
    const vs = victim.update({ dt: 1 / 60, keys: new Set(), frozen: vRig.down, groundY: 0, collision, fovBase: 60 })
    vPose.vx = vs.vx
    vPose.vz = vs.vz
    vRig.update(vPose, vEnv)
    if (vRig.down && downAt < 0) downAt = clock
    if (vRig.ragdolling && vRig.settled && clock - downAt > 2.5) {
      vRig.getupSpot(v)
      victim.teleport(v.x, v.z, 0)
      vRig.group.position.set(v.x, 0, v.z)
      vRig.group.updateMatrixWorld(true)
      vRig.beginRecover()
    }
    if (!vRig.ragdolling) vRig.group.position.set(vCam.position.x, 0, vCam.position.z)
    if (nowMs - lastSnap >= 66) {
      lastSnap = nowMs
      const flags = 1 | (vRig.down ? 32 : 0)
      world.tick([[2, vCam.position.x, 0, vCam.position.z, 0, 0, 0, flags]], nowMs)
    }
    world.sample(nowMs, 1 / 60)
    // their body on this screen, drawn where the playback has them (what
    // net/avatars.ts does every frame), so its posed limbs are where seen
    const seen = world.players.get(2)
    if (seen && !seen.down) {
      theirRig.group.position.set(seen.x, seen.y, seen.z)
      vPose.vx = seen.vx
      vPose.vz = seen.vz
      theirRig.update(vPose, vEnv)
      theirRig.group.rotation.y = theirRig.facing + Math.PI
      theirRig.group.updateMatrixWorld(true)
    }
    bumps.refresh()
    // the local player: sprint at them for two seconds, then stand, then
    // walk into them and keep leaning
    keys.clear()
    const phase = clock < 2 ? 'sprint' : clock < 3 ? 'stand' : 'lean'
    if (phases[phases.length - 1] !== phase) phases.push(phase)
    const them = world.players.get(2)
    if (them && phase !== 'stand') {
      walk.yaw = Math.atan2(-(them.x - cam.position.x), -(them.z - cam.position.z))
      keys.add('KeyW')
      if (phase === 'sprint') keys.add('ShiftLeft')
    }
    const step = walk.update({ dt: 1 / 60, keys, frozen: false, groundY: 0, collision, fovBase: 60 })
    me.feetY = walk.feetY
    me.vx = step.vx
    me.vz = step.vz
    me.vy = step.vy
    me.grounded = step.grounded
    const before = sent.length
    const r = contact.step({ me, push: walk.push, collision, stepUp: step.grounded ? TUNE.step : 0, sets: [bumps], now: clock })
    for (let k = before; k < sent.length; k++) if (Math.hypot(sent[k][1], sent[k][3]) >= 6) knockSends++
    if (r.gap < worst) worst = r.gap
  }
  const leans = sent.length - knockSends
  console.log(`net      walker vs a remote player (snapshots at 15 Hz, played back two ticks late): ` +
    `closest ${f(worst)} (${worst >= -0.01 ? 'never inside them' : '<-- INSIDE THEM'})`)
  console.log(`         ${sent.length} shoves sent (${knockSends} knocks, ${leans} leans); the victim's client took ` +
    `${effects.flop} as a flop, ${effects.stumble} as a stumble, ignored ${effects.ignore}; ` +
    `victim went down at ${downAt < 0 ? 'never' : f(downAt, 2) + ' s'} and ended ${f(Math.hypot(vCam.position.x, vCam.position.z + 8), 1)} from where it stood`)
}

/* ------------------------------------------------------------- emotes -- */
/*
  What somebody else sees when a player emotes and points. The player's
  snapshots carry the packed emote (id and age) and the point direction in
  the tuple's optional tail, fed to the real store at 15 Hz with a little
  jitter; the real avatars draw them. The copy has to start the dance on the
  dancer's own beat (two ticks of playback late, no more), change to a wave
  when they do, hold its right arm along the direction they pointed, and
  let go of all of it when the stream does.
*/
if (want('emotes')) {
  // the name plates are canvases, and nothing here draws: a stub will do
  if (typeof document === 'undefined') {
    const ctx = new Proxy({}, {
      get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 40 }) : () => {}),
      set: (t, k, v) => ((t[k] = v), true),
    })
    globalThis.document = { createElement: () => ({ width: 1, height: 1, style: {}, getContext: () => ctx }) }
  }
  const idOf = (n) => EMOTES.find((e) => e.name === n).id
  const DANCE = idOf('dance')
  const WAVE = idOf('wave')
  const world = createRemoteWorld()
  world.welcome(1, 66, [{ id: 2, name: 'dancer', admin: false, registered: false }])
  const avatars = createRemoteAvatars(EYE, 34)
  const env = { groundAt: () => 0, collision: open(), eyePos: new THREE.Vector3(0, EYE, 6) }
  // the dancer's own timeline: nothing, a dance from 1 s, a wave from 3 s
  // with the arm pointing from 3.4 s, then neither from 5 s
  const PY = 0.9
  const PP = 0.35
  const tail = (t) => {
    const e = t >= 1 && t < 3 ? packEmote(DANCE, t - 1) : t >= 3 && t < 5 ? packEmote(WAVE, t - 3) : 0
    const pointing = t >= 3.4 && t < 5
    return pointing ? [e, PY, PP] : e ? [e] : []
  }
  const want3 = new THREE.Vector3(-Math.sin(PY) * Math.cos(PP), Math.sin(PP), -Math.cos(PY) * Math.cos(PP))
  const sh = new THREE.Vector3()
  const hand = new THREE.Vector3()
  const pointErr = (rig) => {
    rig.group.updateMatrixWorld(true)
    const si = rig.limbs.findIndex((l) => l.name === 'shoulderR')
    const hi = rig.limbs.findIndex((l) => l.name === 'handR')
    rig.limbPos(si, sh)
    rig.limbPos(hi, hand)
    return (hand.sub(sh).normalize().angleTo(want3) * 180) / Math.PI
  }
  const pelvisYs = []
  const report = []
  let nextSnap = 0
  let t = 0
  const dt = 1 / 60
  for (let i = 0; i < 60 * 6.2; i++) {
    t = i * dt
    const nowMs = t * 1000
    if (nowMs >= nextSnap) {
      world.tick([[2, 0, 0, -3, 0, 0, 0, 1, ...tail(t)]], nowMs)
      nextSnap += 66 + ((i * 7919) % 9) - 4
    }
    world.sample(nowMs, dt)
    avatars.update(world, dt, env)
    const rig = avatars.rigOf(2)
    if (!rig) continue
    if (t > 1.5 && t < 2.9) pelvisYs.push(rig.limbPos(0, sh).y)
    for (const at of [0.8, 2.5, 3.2, 4.6, 5.9]) {
      if (Math.abs(t - at) < dt / 2) {
        const name = EMOTES.find((e) => e.id === rig.acting)?.name ?? 'none'
        const own = at >= 1 && at < 3 ? at - 1 : at >= 3 && at < 5 ? at - 3 : 0
        report.push({ at, name, age: rig.actAge, own, point: pointErr(rig) })
      }
    }
  }
  const expect = { 0.8: 'none', 2.5: 'dance', 3.2: 'wave', 4.6: 'wave', 5.9: 'none' }
  let ok = true
  for (const r of report) {
    const lag = r.own - r.age
    const good = r.name === expect[r.at] && (r.name === 'none' || (lag > -0.02 && lag < 0.3))
    if (!good) ok = false
    console.log(`emotes   at ${f(r.at, 1)} s the copy is ${r.name.padEnd(5)}` +
      (r.name === 'none' ? '' : ` ${f(r.age, 2)} s in (the dancer ${f(r.own, 2)}, ${f(lag, 2)} behind)`) +
      `; right arm ${f(r.point, 1)} deg off the pointed direction${good ? '' : '  <-- WRONG'}`)
  }
  const at46 = report.find((r) => r.at === 4.6)
  if (!(at46 && at46.point < 12)) ok = false
  const bounce = Math.max(...pelvisYs) - Math.min(...pelvisYs)
  console.log(`         the copy's hips bounce ${f(bounce, 2)} units through the dance; pointing it held the arm within ` +
    `${f(at46?.point ?? NaN, 1)} deg of where the dancer pointed ${ok ? '(ok)' : '<-- FAILED'}`)
}

/* -------------------------------------------------------------- reach -- */
/*
  Mittens never inside the body wearing them. For each build, bare and in the
  beaver with a cap and a headset (the widest things worn near a face), every
  emote is played through from start to finish, and the point key is held at
  five directions (ahead, across the body, down at the feet, straight up and
  down across the belly, both as far across as a standing body lets the
  view turn before it pivots after it). Every few frames each driven arm's own skinned
  vertices (the forearm's and the mitten's, as drawn) are measured against the
  body's surface, bean and gear, with a fresh `selfContact`. The number is the
  worst over the whole emote, in design units; negative is a mitten through
  the body.
*/
if (want('reach')) {
  setBodyBuildSync(true)
  const BUILDS = ['bean', 'chubby', 'slim', 'tall', 'stubby']
  const pose = { dt: 1 / 60, gait: 0, crouchK: 0, grounded: true, run: false, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1 }
  const env = { groundY: 0, collision: open() }
  const HANDS = [[B.FARM_L, B.HAND_L], [B.FARM_R, B.HAND_R]]
  // (across is as far across as a standing body lets the view get before
  // it turns to face it: the lazy facing pivots past about 0.7)
  const POINTS = [['ahead', 0, -0.1], ['across', 0.7, -0.1], ['feet', 0.2, -1.2], ['up', 0, 1.3], ['belly', 0.7, -0.7]]
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  let worstAll = Infinity
  for (const dressed of [false, true]) {
    for (let b = 0; b < BUILDS.length; b++) {
      const look = dressed ? { ...DEFAULT_LOOK, hat: 1, build: b, costume: 5, phones: 1 } : { ...DEFAULT_LOOK, build: b }
      const row = []
      const run = (label, setup, frames, arms) => {
        // REACH_ONLY=build,dressed,label runs one case, for chasing one down
        if (process.env.REACH_ONLY && process.env.REACH_ONLY !== `${b},${dressed ? 1 : 0},${label}`) return
        const rig = buildPlayerBody(EYE, 34, look)
        rig.group.rotation.y = Math.PI
        const mesh = rig.group.children.find((c) => c.isSkinnedMesh)
        const contact = createSelfContact(rig.group, mesh, () => b)
        for (let i = 0; i < 30; i++) rig.update(pose, env)
        const p = { ...pose }
        setup(rig, p)
        // the driven arms' vertices, every third one
        const geo = mesh.geometry
        const si = geo.getAttribute('skinIndex')
        const sw = geo.getAttribute('skinWeight')
        const idx = []
        for (let i = 0; i < si.count; i += 3) {
          let bi = si.getX(i); let bw = sw.getX(i)
          if (sw.getY(i) > bw) { bi = si.getY(i); bw = sw.getY(i) }
          if (sw.getZ(i) > bw) { bi = si.getZ(i); bw = sw.getZ(i) }
          if (sw.getW(i) > bw) bi = si.getW(i)
          if (arms.some((a) => HANDS[a].includes(bi))) idx.push(i)
        }
        let worst = Infinity
        let at = 0
        for (let fr = 0; fr < frames; fr++) {
          rig.update(p, env)
          if (fr % 5 !== 4) continue
          // while the emote is on the body (a finished one's last frames are
          // the walk's own arms again, measured on their own below), and a
          // point once the arm has come up
          if (label === 'idle' ? false : label.startsWith('point') ? fr < 12 : rig.actWeight < 0.1) continue
          if (mesh.geometry !== geo) throw new Error('the body changed geometry mid-emote')
          rig.group.updateMatrixWorld(true)
          contact.pose()
          for (const i of idx) {
            const d = contact.distance(mesh.getVertexPosition(i, v), n)
            if (d < worst) {
              worst = d
              at = fr / 60
            }
          }
        }
        row.push([label, worst, at])
        if (label !== 'idle') worstAll = Math.min(worstAll, worst)
      }
      for (const e of EMOTES) {
        const arms = []
        run(e.name, (rig) => rig.act(e.id), Math.round((e.len || 3) * 60), [0, 1])
      }
      // the walk's own arms standing about, for comparison: not an emote's
      run('idle', () => {}, 120, [0, 1])
      for (const [label, yaw, pitch] of POINTS) {
        run(`point ${label}`, (rig, p) => { p.point = 1; p.pointYaw = yaw; p.pointPitch = pitch }, 60, [1])
      }
      console.log(`reach    ${(BUILDS[b] + (dressed ? ', beaver/cap/headset' : '')).padEnd(28)} ` +
        row.map(([l, w, t]) => `${l} ${f(w, 3)}${w < 0 && l !== 'idle' ? '@' + f(t, 2) + '!' : ''}`).join('  '))
    }
  }
  console.log(`         worst over everything: ${f(worstAll, 3)} ${worstAll >= 0 ? '(never inside the body)' : '<-- A MITTEN THROUGH THE BODY'}`)
}
