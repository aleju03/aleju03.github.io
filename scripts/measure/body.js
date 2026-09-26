/*
  The player character, in numbers: `npm run measure -- body [section]`.

    variants  every (headgear, build) geometry: vertices, triangles, the
              cost of building it from nothing, anything non-finite, any
              triangle facing against its own normals, and whether the
              skin is closed (every edge shared by exactly two triangles)
    cost      one body: build time, draw calls, and a frame of walking,
              idling and ragdolling per rig
    folds     every filmstrip the shoot draws (walk, run, jump, land,
              ragdoll, splay, recover, idle, and a wave and a stretch),
              simulated headless at 60 Hz: on every frame, how many
              triangles of the posed skin face the opposite way to the same
              triangle in the bind pose (a fold, which is a hole you can see
              the inside of the body through) and how far the worst edge has
              stretched. One surface has to survive being thrown about
    lean      the body's pitch (pelvis to head, from upright) standing,
              walking and at a full run
    hooks     the sandbox hooks end to end: hit, grab and drag, settle, get up

  Nothing here draws. The pictures are `npm run shoot -- body:closeup` and
  friends (scripts/probe/body.ts).
*/
// THREE comes from measure.mjs's prelude
import { buildPlayerBody } from '../../src/game/player/playerBody.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { bodyGeometry, bodyField, timeVariant, HAT_COUNT, BUILD_COUNT } from '../../src/game/player/bodyShape.ts'

const only = process.argv[2]
const want = (s) => !only || only === s
const EYE = 3.84
const GRAV = 34
const env = { groundY: 0, collision: makeCollisionSet({ minX: -1e4, maxX: 1e4, minZ: -1e4, maxZ: 1e4 }) }
const poseOf = () => ({
  dt: 1 / 60, gait: 0, crouchK: 0, grounded: true, run: false, yaw: 0, pitch: 0,
  vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
})
const meshOf = (r) => {
  let m
  r.group.traverse((o) => { if (o.isSkinnedMesh) m = o })
  return m
}

/* ------------------------------------------------------------ variants -- */
if (want('variants')) {
  console.log('variants (headgear x build): verts, tris, ms to build from nothing')
  const names = ['band', 'cap', 'bucket', 'party', 'hardhat', 'bandana', 'none', 'hood']
  let worstMs = 0
  let allClosed = true
  for (let h = 0; h < HAT_COUNT; h++) {
    const row = []
    for (let b = 0; b < BUILD_COUNT; b++) {
      const g = bodyGeometry(h, b)
      const P = g.getAttribute('position'), N = g.getAttribute('normal'), I = g.getIndex()
      let bad = 0
      for (let i = 0; i < P.count * 3; i++) if (!Number.isFinite(P.array[i]) || !Number.isFinite(N.array[i])) bad++
      // closed: every undirected edge is used by exactly two triangles
      const edges = new Map()
      for (let t = 0; t < I.count; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = I.getX(t + e), c = I.getX(t + ((e + 1) % 3))
          const k = a < c ? a * 1e6 + c : c * 1e6 + a
          edges.set(k, (edges.get(k) ?? 0) + 1)
        }
      }
      let open = 0
      let over = 0
      for (const n of edges.values()) {
        if (n === 1) open++
        else if (n > 2) over++
      }
      // winding against the normals
      let against = 0
      const a = new THREE.Vector3(), u = new THREE.Vector3(), w = new THREE.Vector3(), n = new THREE.Vector3()
      for (let t = 0; t < I.count; t += 3) {
        const [i0, i1, i2] = [I.getX(t), I.getX(t + 1), I.getX(t + 2)]
        a.fromBufferAttribute(P, i0)
        u.fromBufferAttribute(P, i1).sub(a)
        w.fromBufferAttribute(P, i2).sub(a)
        const c = u.cross(w)
        if (c.lengthSq() < 1e-14) continue
        n.fromBufferAttribute(N, i0).add(a.fromBufferAttribute(N, i1)).add(a.fromBufferAttribute(N, i2))
        if (c.dot(n) < 0) against++
      }
      // twice, keep the faster: the first build of anything pays the JIT
      const ms = Math.min(timeVariant(h, b), timeVariant(h, b))
      worstMs = Math.max(worstMs, ms)
      if (open) allClosed = false
      row.push(`${P.count}v/${I.count / 3}t ${ms.toFixed(1)}ms` + (bad ? ` NONFINITE ${bad}` : '') +
        (open ? ` HOLES ${open}` : '') + (over ? ` nonmanifold ${over}` : '') + (against ? ` AGAINST ${against}` : ''))
    }
    console.log('  ' + names[h].padEnd(8) + row.join('  '))
  }
  console.log('  worst variant ' + worstMs.toFixed(1) + ' ms; ' + (allClosed ? 'every skin closed (no edge with one triangle)' : 'SOME SKINS HAVE HOLES'))
}

/* ---------------------------------------------------------------- cost -- */
if (want('cost')) {
  let t0 = performance.now()
  const rigs = []
  for (let i = 0; i < 20; i++) rigs.push(buildPlayerBody(EYE, GRAV))
  const build = (performance.now() - t0) / 20
  let meshes = 0, verts = 0, bones = 0
  const mats = new Set()
  rigs[1].group.traverse((o) => {
    if (o.isBone) bones++
    if (o.isMesh) { meshes++; verts += o.geometry.getAttribute('position').count; mats.add(o.material) }
  })
  console.log('cost: ' + build.toFixed(2) + ' ms/rig (geometry cached), ' + meshes + ' mesh (draw calls, x2 with a shadow), ' +
    mats.size + ' material, ' + verts + ' verts, ' + bones + ' bones')
  const pose = poseOf()
  pose.gait = 0.6
  pose.vz = -3
  for (const r of rigs) r.update(pose, env)
  const N = 600
  const tick = (label, mutate) => {
    const t = performance.now()
    for (let f = 0; f < N; f++) for (const r of rigs) {
      mutate(r, f)
      r.update(pose, env)
      r.group.updateMatrixWorld(true)
      meshOf(r).skeleton.update()
    }
    console.log('  ' + label.padEnd(10) + (((performance.now() - t) / N / rigs.length) * 1000).toFixed(1).padStart(7) + ' us/rig/frame')
  }
  tick('walk', (r) => { r.group.position.z -= 3 / 60 })
  pose.vz = 0
  pose.gait = 0
  tick('idle', () => {})
  for (const r of rigs) r.flop(4, 3, -2)
  tick('ragdoll', () => {})
}

/* --------------------------------------------------------------- folds -- */

/** a scripted walker, the probe's: accelerate along the yaw, fall, land */
const actor = (look) => {
  const rig = buildPlayerBody(EYE, GRAV, look)
  const a = { rig, pose: poseOf(), x: 0, z: 0, y: 0, vx: 0, vz: 0, vy: 0, grounded: true }
  a.pose.yaw = -Math.PI / 2
  rig.face(a.pose.yaw)
  return a
}
const tick = (a, o = {}) => {
  const dt = 1 / 60
  const speed = o.speed ?? 0
  const tx = -Math.sin(a.pose.yaw) * speed
  const tz = -Math.cos(a.pose.yaw) * speed
  const k = 1 - Math.exp(-(a.grounded ? 12 : 2) * dt)
  a.vx += (tx - a.vx) * k
  a.vz += (tz - a.vz) * k
  a.pose.landing = 0
  if (!a.rig.down) {
    if (o.jump && a.grounded) { a.vy = 11.9; a.grounded = false }
    a.x += a.vx * dt
    a.z += a.vz * dt
    if (!a.grounded) {
      a.vy -= GRAV * dt
      a.y += a.vy * dt
      if (a.y <= 0) { a.pose.landing = -a.vy; a.y = 0; a.vy = 0; a.grounded = true }
    }
  }
  const cap = o.run ? 9.4 : 5.9
  Object.assign(a.pose, {
    gait: Math.min(1, Math.hypot(a.vx, a.vz) / cap), run: !!o.run, crouchK: o.crouch ?? 0,
    grounded: a.grounded, vx: a.vx, vz: a.vz, vy: a.vy,
  })
  if (!a.rig.ragdolling) {
    a.rig.group.position.set(a.x, a.y, a.z)
    a.rig.group.rotation.y = a.rig.facing + Math.PI
  }
  a.rig.update(a.pose, env)
  a.rig.group.updateMatrixWorld(true)
}
const getUp = (a) => {
  const p = a.rig.getupSpot(new THREE.Vector3())
  a.x = p.x; a.z = p.z; a.y = 0; a.vx = a.vz = a.vy = 0; a.grounded = true
  a.rig.group.position.set(a.x, a.y, a.z)
  a.rig.group.rotation.y = a.rig.facing + Math.PI
  a.rig.group.updateMatrixWorld(true)
  a.rig.beginRecover()
}
/** the strips `shoot -- body:motion` draws, plus the emotes */
const ACTIONS = {
  walk: [90, (a) => tick(a, { speed: 5.9 })],
  run: [90, (a) => tick(a, { speed: 9.4, run: true })],
  jump: [90, (a, f) => tick(a, { jump: f === 30 })],
  land: [100, (a, f) => {
    if (f === 0) { a.y += 6.5; a.grounded = false; a.vy = 0 }
    tick(a, { speed: f < 20 ? 5.9 : 2 })
  }],
  ragdoll: [240, (a, f) => {
    if (f === 18) {
      const hip = a.rig.limbPos(0, new THREE.Vector3())
      a.rig.hit(new THREE.Vector3(0, 4, 11).multiplyScalar(a.rig.mass), hip.add(new THREE.Vector3(0, 0.3, -0.5)))
    }
    tick(a, { speed: f < 18 ? 5.9 : 0 })
  }],
  splay: [240, (a, f) => {
    if (f === 20) {
      const chest = a.rig.limbPos(1, new THREE.Vector3())
      a.rig.hit(new THREE.Vector3(12, 9, 5).multiplyScalar(a.rig.mass), chest.add(new THREE.Vector3(-0.5, -0.3, 0.3)))
    }
    tick(a, { speed: f < 20 ? 9.4 : 0, run: true })
  }],
  recover: [260, (a, f) => {
    if (f === 5) a.rig.flop(1, 7, 4)
    if (f === 110) getUp(a)
    tick(a)
  }],
  idle: [420, (a, f) => {
    if (f === 60) a.rig.emote('bounce')
    if (f === 240) a.rig.emote('look')
    tick(a)
  }],
  wave: [150, (a, f) => { if (f === 10) a.rig.emote('wave'); tick(a) }],
  stretch: [160, (a, f) => { if (f === 10) a.rig.emote('stretch'); tick(a) }],
  crouch: [60, (a) => tick(a, { crouch: 1 })],
}
if (want('folds')) {
  console.log('folds: triangles of the visible skin facing against their own skinned normals (worst frame), and the most any edge stretched')
  const looks = [undefined, { shell: '#e0a21a', trim: '#8a4fc8', accent: '#2860c8', glow: '#1c1a20', hat: 7, costume: 3, build: 1 }]
  let total = 0
  for (const look of looks) {
    for (const [name, [frames, run]] of Object.entries(ACTIONS)) {
      const a = actor(look)
      const mesh = meshOf(a.rig)
      const P = mesh.geometry.getAttribute('position')
      const I = mesh.geometry.getIndex()
      const Nrm = mesh.geometry.getAttribute('normal')
      const SI = mesh.geometry.getAttribute('skinIndex')
      const SW = mesh.geometry.getAttribute('skinWeight')
      const bind = new Float32Array(P.count * 3)
      bind.set(P.array)
      const live = new Float32Array(P.count * 3)
      const liveN = new Float32Array(P.count * 3)
      const v = new THREE.Vector3(), n3 = new THREE.Vector3(), acc3 = new THREE.Vector3()
      const m3 = new THREE.Matrix3()
      const boneN = mesh.skeleton.bones.map(() => new THREE.Matrix3())
      let worst = 0, worstAt = 0, stretch = 1, stretchAt = 0, worstEdge = ''
      const where = {}
      const u = new THREE.Vector3(), w = new THREE.Vector3(), nl = new THREE.Vector3()
      const minEdge = 0.03
      // triangles buried inside the body in the bind pose (the underside of
      // a hat, the inner face of a hood) are nobody's business
      const field = bodyField(look?.build ?? 0)
      const buried = new Uint8Array(I.count / 3)
      for (let t = 0; t < I.count; t += 3) {
        const q = [I.getX(t) * 3, I.getX(t + 1) * 3, I.getX(t + 2) * 3]
        const c = [0, 1, 2].map((k) => (bind[q[0] + k] + bind[q[1] + k] + bind[q[2] + k]) / 3)
        buried[t / 3] = field(c[0], c[1], c[2]) < -0.015 ? 1 : 0
      }
      for (let f = 0; f < frames; f++) {
        run(a, f)
        if (f % 2) continue
        mesh.skeleton.update()
        // each bone's rotation part, bind to live, for the vertex normals
        const bm = mesh.skeleton.boneMatrices
        boneN.forEach((m, b) => {
          const e = bm.subarray(b * 16, b * 16 + 16)
          m.set(e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10])
        })
        for (let i = 0; i < P.count; i++) {
          v.fromBufferAttribute(P, i)
          // applyBoneTransform answers in the mesh's own frame (three's
          // attached bind mode); the skinned normals below come out of the
          // bone matrices in world space, so bring the position there too
          mesh.applyBoneTransform(i, v).applyMatrix4(mesh.matrixWorld)
          live[i * 3] = v.x; live[i * 3 + 1] = v.y; live[i * 3 + 2] = v.z
          acc3.set(0, 0, 0)
          for (let k = 0; k < 4; k++) {
            const wk = SW.getComponent(i, k)
            if (!wk) continue
            n3.fromBufferAttribute(Nrm, i).applyMatrix3(m3.copy(boneN[SI.getComponent(i, k)]))
            acc3.addScaledVector(n3, wk)
          }
          liveN[i * 3] = acc3.x; liveN[i * 3 + 1] = acc3.y; liveN[i * 3 + 2] = acc3.z
        }
        let flips = 0
        const here = {}
        const sc = a.rig.group.scale.x
        for (let t = 0; t < I.count; t += 3) {
          const i0 = I.getX(t) * 3, i1 = I.getX(t + 1) * 3, i2 = I.getX(t + 2) * 3
          const lb = Math.hypot(bind[i1] - bind[i0], bind[i1 + 1] - bind[i0 + 1], bind[i1 + 2] - bind[i0 + 2])
          u.set(live[i1] - live[i0], live[i1 + 1] - live[i0 + 1], live[i1 + 2] - live[i0 + 2])
          w.set(live[i2] - live[i0], live[i2 + 1] - live[i0 + 1], live[i2 + 2] - live[i0 + 2])
          // skinned positions are world units; bind is design units
          const ll = u.length() / sc
          if (lb > minEdge && ll / lb > stretch) {
            stretch = ll / lb
            stretchAt = f
            if (process.env.WHERE) {
              const d = (q) => [0, 1, 2].map((k) => bind[q + k].toFixed(2)).join(',') + ' ' +
                [0, 1, 2, 3].map((k) => SI.getComponent(q / 3, k) + ':' + SW.getComponent(q / 3, k).toFixed(2)).join(' ')
              worstEdge = d(i0) + '  |  ' + d(i1)
            }
          }
          nl.crossVectors(u, w)
          if (nl.lengthSq() < 1e-12 || buried[t / 3]) continue
          // a fold: the skin faces against the way its own (skinned) vertex
          // normals say it should, which a rotation of the whole body cannot
          // cause and a crease or an inside-out patch always does
          const nx = liveN[i0] + liveN[i1] + liveN[i2]
          const ny = liveN[i0 + 1] + liveN[i1 + 1] + liveN[i2 + 1]
          const nz = liveN[i0 + 2] + liveN[i1 + 2] + liveN[i2 + 2]
          if ((nl.x * nx + nl.y * ny + nl.z * nz) / (nl.length() * Math.hypot(nx, ny, nz) || 1) < -0.3) {
            flips++
            const y = process.env.BONES
              ? 'r' + mesh.geometry.getAttribute('aRole').getX(i0 / 3) + ' ' + [0, 1, 2].map((k) => bind[i0 + k].toFixed(1)).join(',') + ' ' + [0, 1].map((k) => SI.getComponent(i0 / 3, k) + ':' + SW.getComponent(i0 / 3, k).toFixed(1)).join('/')
              : (Math.round(bind[i0 + 1] * 5) / 5).toFixed(1)
            here[y] = (here[y] ?? 0) + 1
          }
        }
        if (flips > worst) { worst = flips; worstAt = f; Object.assign(where, here) }
      }
      total += worst
      console.log('  ' + (look ? 'hood ' : 'band ') + name.padEnd(8) + String(worst).padStart(4) + ' flipped' +
        (worst ? ' (frame ' + worstAt + ', by bind height ' + JSON.stringify(where) + ')' : '') +
        ', edges up to ' + stretch.toFixed(2) + 'x (frame ' + stretchAt + ')' + (worstEdge ? '\n      ' + worstEdge : ''))
    }
  }
  console.log('  worst-frame flips summed over every strip: ' + total)
}

/* ---------------------------------------------------------------- lean -- */
if (want('lean')) {
  const r = buildPlayerBody(EYE, GRAV)
  const pose = poseOf()
  const mesh = meshOf(r)
  const pel = new THREE.Vector3(), hd = new THREE.Vector3()
  const out = []
  for (const [name, speed, run] of [['standing', 0, false], ['walking', 5.9, false], ['full run', 9.4, true]]) {
    r.reset()
    let vz = 0
    const s = []
    for (let f = 0; f < 240; f++) {
      vz += (-speed - vz) * (1 - Math.exp(-12 / 60))
      Object.assign(pose, { vz, run, gait: Math.min(1, Math.abs(vz) / (run ? 9.4 : 5.9)) })
      r.group.position.z += vz / 60
      r.group.rotation.y = r.facing + Math.PI
      r.update(pose, env)
      r.group.updateMatrixWorld(true)
      if (f < 120) continue
      mesh.skeleton.bones[0].getWorldPosition(pel)
      mesh.skeleton.bones[2].getWorldPosition(hd)
      hd.sub(pel)
      s.push((Math.atan2(-hd.z, hd.y) * 180) / Math.PI)
    }
    out.push(name + ' ' + (s.reduce((x, y) => x + y, 0) / s.length).toFixed(1) + ' deg (peak ' + Math.max(...s).toFixed(1) + ')')
  }
  console.log('lean, pelvis to head from upright: ' + out.join(', '))
}

/* --------------------------------------------------------------- hooks -- */
if (want('hooks')) {
  // knocked flat by an impulse at the hip, picked up by the left hand and
  // dragged, dropped, left to settle, and stood back up. Every limb must
  // stay finite and the body must end up standing
  const r = buildPlayerBody(EYE, GRAV)
  const pose = poseOf()
  const p = new THREE.Vector3()
  const step = (n) => { for (let i = 0; i < n; i++) { r.update(pose, env); r.group.updateMatrixWorld(true) } }
  const finite = () => r.limbs.every((l) => { r.limbPos(l.index, p); return Number.isFinite(p.x + p.y + p.z) })
  step(30)
  r.limbPos(0, p)
  r.hit(new THREE.Vector3(0, 5, 12).multiplyScalar(r.mass), p)
  step(60)
  const hand = r.limbs.find((l) => l.name === 'handL').index
  const target = r.limbPos(hand, new THREE.Vector3()).clone().add(new THREE.Vector3(0, 6, 0))
  r.grab(hand, target)
  for (let i = 0; i < 90; i++) { target.x += 0.05; step(1) }
  const held = r.limbPos(hand, new THREE.Vector3()).distanceTo(target)
  const heldSettled = r.settled
  r.grab(hand, null)
  let t = 0
  while (!r.settled && t < 600) { step(1); t++ }
  const settleS = t / 60
  r.getupSpot(p)
  r.group.position.set(p.x, 0, p.z)
  r.group.updateMatrixWorld(true)
  r.beginRecover()
  t = 0
  while (r.down && t < 300) { step(1); t++ }
  console.log('hooks: hit ok, held ' + held.toFixed(2) + ' units off the grab point' +
    (heldSettled ? ' (WRONG: a held body reported settled)' : '') +
    ', settled ' + settleS.toFixed(2) + ' s after release' + (settleS >= 10 ? ' (NEVER)' : '') +
    ', stood up in ' + (t / 60).toFixed(2) + ' s, limbs ' + (finite() ? 'finite' : 'NaN') + ', ' +
    (r.down ? 'STILL DOWN' : 'standing'))
}
