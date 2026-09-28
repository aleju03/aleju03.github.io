/* Distance-based crowd animation: `npm run measure -- pedestrians`.
   Checks the real skeleton cadence, continuous movement, contact caches,
   and a grabbed body's full-rate physics without creating a renderer. */
import assert from 'node:assert/strict'
import { buildPedestrians } from '../../src/game/world/pedestrians.ts'
import { MAX_POINTS } from '../../src/game/player/bodyContact.ts'
import { setBodyBuildSync } from '../../src/game/player/bodyShape.ts'
import { roadAt as sidewalkRoadAt, placeAt as sidewalkPlaceAt, ROAD_HALF, WALK_W } from '../../src/game/world/settlements.ts'

setBodyBuildSync(true)
const disposables = []
const crowd = buildPedestrians({
  parent: new THREE.Group(), obstacles: [], groundAt: () => 0,
  trackDisposable: (d) => disposables.push(d),
})
const cam = new THREE.Vector3()
const dt = 1 / 120
const peer = {}
const bones = []
crowd.groupOf(0).traverse((o) => { if (o.isBone) bones.push(o) })
const stamp = () => bones.flatMap((b) => [
  ...b.position.toArray(), ...b.quaternion.toArray(), ...b.scale.toArray(),
]).join(',')
const staged = (distance, pause = 100) => {
  crowd.stage([{ x: distance, z: 0, yaw: 0, pause }])
  crowd.update(cam, dt)
}

for (const [distance, hz] of [[10, 120], [50, 30], [110, 20]]) {
  staged(distance)
  let previous = stamp()
  let changed = 0
  for (let i = 0; i < 240; i++) {
    crowd.update(cam, dt)
    const next = stamp()
    if (next !== previous) changed++
    previous = next
  }
  assert(Math.abs(changed - hz * 2) <= 2, `${distance} units: ${changed} poses over two seconds`)
  console.log(`cadence  ${distance} units: ${changed / 2} Hz`)
}

// Entering interaction range wakes a previously distant pose immediately.
staged(110)
crowd.update(cam, dt)
let previous = stamp()
cam.x = 105
crowd.update(cam, dt)
assert.notEqual(stamp(), previous, 'approach must update the pose on the first nearby frame')
cam.x = 0

// A shove/stagger moves at the simulation rate even outside animation range.
staged(110)
crowd.bumpable.hit(0, {
  kind: 'lean', vx: 2, vz: 0, fresh: false, nx: 1, nz: 0,
})
let lastX = 110
for (let i = 0; i < 20; i++) {
  crowd.update(cam, dt)
  assert(crowd.bumpable.peer(0, peer))
  assert(peer.x > lastX, 'stagger position must advance every frame')
  lastX = peer.x
}

// On-demand contact poses are fresh, and same-tick nudges translate cached
// points without reposing the body or retaining old world coordinates.
staged(110)
crowd.update(cam, dt)
const points = new Float32Array(MAX_POINTS * 4)
const after = new Float32Array(MAX_POINTS * 4)
const n = crowd.bumpable.points(0, points)
assert(n > 0)
assert(crowd.bumpable.nudge(0, 0.25, 0))
assert.equal(crowd.bumpable.points(0, after), n)
for (let i = 0; i < n * 4; i += 4) {
  assert(Math.abs(after[i] - points[i] - 0.25) < 1e-4)
  assert.equal(after[i + 1], points[i + 1])
}

// A long-distance physgun grab bypasses the standing pose scheduler.
staged(110)
const handle = [...crowd.grabbable()][0].rig
const target = handle.limbPos(0, new THREE.Vector3()).clone().add(new THREE.Vector3(0, 3, 0))
handle.grab(0, target)
assert.equal(crowd.downed, 1)
previous = stamp()
let movingFrames = 0
for (let i = 0; i < 30; i++) {
  crowd.update(cam, dt)
  const next = stamp()
  if (next !== previous) movingFrames++
  previous = next
}
assert.equal(movingFrames, 30, 'grabbed bodies must simulate on every frame')
handle.grab(0, null)
console.log('contacts continuous stagger, approach, cached shove points, and distant grab passed')

// The same walk produces exactly the same movement with close and far
// cameras. Only the skeleton's sampling rate is allowed to change.
const other = buildPedestrians({
  parent: new THREE.Group(), obstacles: [], groundAt: () => 0,
  trackDisposable: (d) => disposables.push(d),
})
const walking = buildPedestrians({
  parent: new THREE.Group(), obstacles: [], groundAt: () => 0,
  trackDisposable: (d) => disposables.push(d),
})
const street = sidewalkRoadAt(32, -285, sidewalkPlaceAt(32, -285))
const sx = street.footX - street.dirZ * (ROAD_HALF + WALK_W * 0.5)
const sz = street.footZ + street.dirX * (ROAD_HALF + WALK_W * 0.5)
const spots = [{ x: sx, z: sz, yaw: Math.atan2(-street.dirX, -street.dirZ) }]
walking.stage(spots)
other.stage(spots)
const closeCam = new THREE.Vector3(sx, 0, sz)
const farCam = new THREE.Vector3(sx + 110, 0, sz)
const closePeer = {}
const farPeer = {}
let travelled = 0
lastX = sx
let lastZ = sz
for (let i = 0; i < 600; i++) {
  walking.update(closeCam, dt)
  other.update(farCam, dt)
  assert(walking.bumpable.peer(0, closePeer))
  assert(other.bumpable.peer(0, farPeer))
  for (const key of ['x', 'z', 'feetY', 'vx', 'vz']) assert.equal(closePeer[key], farPeer[key])
  travelled += Math.hypot(closePeer.x - lastX, closePeer.z - lastZ)
  lastX = closePeer.x
  lastZ = closePeer.z
}
assert(travelled > 2, 'movement comparison must exercise a walking body')
console.log(`movement identical near/far simulation over five seconds (${travelled.toFixed(1)} units walked)`)

// A nine-body high-tier crowd is not required for meaningful comparisons:
// use the current tier's pool, keep simulation identical, and isolate body
// animation cost by pausing the crowd rather than sampling random roads.
for (const distance of [10, 50, 110]) {
  const samples = []
  for (let run = 0; run < 5; run++) {
    crowd.stage(Array.from({ length: crowd.bumpable.size }, (_, i) => ({
      x: distance, z: i * 2, yaw: 0, pause: 1000,
    })))
    for (let i = 0; i < 240; i++) crowd.update(cam, dt)
    const start = performance.now()
    for (let i = 0; i < 1200; i++) crowd.update(cam, dt)
    samples.push((performance.now() - start) / 1200)
  }
  samples.sort((a, b) => a - b)
  console.log(`cost     ${distance} units, ${crowd.bumpable.size} bodies: ${samples[2].toFixed(3)} ms/frame (median of five)`)
}
for (const d of disposables) d.dispose()
