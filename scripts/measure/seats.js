/*
  Who fits in the fleet: `npm run measure -- seats [car|boat|heli|ship]`.

  Every machine, both chairs, riders in the looks that stand tallest or sit
  widest (the party hat, the hard hat and the astronaut helmet, on the
  chubby build and the tall one), seated exactly the way the game seats
  them (`sit()` with the seat node's own `fit` and `room`) and ticked for a
  few seconds of the seated idle, lolling head and all. At three moments
  each, every vertex of the skinned body (headgear included, it is the same
  mesh) is tested for being *outside the machine*: a segment from the
  seat's eye to the vertex that crosses any of the machine's outer skins
  (paint, paint2, glass) means that bit of the rider is through the hull or
  the canopy. Printed per seat: the worst count of vertices out, how far out
  the worst one is, and where (seat-local x, y, z), so a clip is a number
  and a place rather than a squint at a screenshot.

  The eye is inside the body, so the test is honest for everything the
  segment from it reaches; interior furniture (seats, dash, tubs) is in
  other slots and not counted as a wall.
*/
// THREE comes from measure.mjs's prelude
import { buildPlayerBody, CABIN_FIT } from '../../src/game/player/playerBody.ts'
import { setBodyBuildSync } from '../../src/game/player/bodyShape.ts'
import { DEFAULT_LOOK } from '../../src/game/player/look.ts'
import { createVehicleMaterials } from '../../src/game/vehicles/materials.ts'
import { buildCar } from '../../src/game/vehicles/car.ts'
import { buildBoat } from '../../src/game/vehicles/boat.ts'
import { buildHeli } from '../../src/game/vehicles/heli.ts'
import { buildShip } from '../../src/game/vehicles/ship.ts'

setBodyBuildSync(true)
const only = process.argv[2]

/* `seats heights`: every headgear on every build, seated, with no machine:
   its extent in the seat's frame (the eye at the origin, +z behind, x to
   the rider's right as the seat faces), at the two folds the fleet uses.
   What a cabin has to hold */
if (only === 'heights') {
  const seat = new THREE.Group()
  const p = new THREE.Vector3()
  for (const fit of [1, 0.84, 0.8]) for (let hat = 0; hat < 9; hat++) {
    const row = []
    for (let build = 0; build < 5; build++) {
      const rig = buildPlayerBody(3.84, 34, { ...DEFAULT_LOOK, hat, build })
      rig.sit(fit, true)
      seat.add(rig.group)
      rig.group.rotation.set(0, Math.PI, 0)
      for (let f = 0; f < 30; f++) rig.seatedTick(1 / 60)
      seat.updateMatrixWorld(true)
      let mesh = null
      rig.group.traverse((o) => { if (o.isSkinnedMesh) mesh = o })
      const b = new THREE.Box3()
      const pos = mesh.geometry.getAttribute('position')
      for (let i = 0; i < pos.count; i += 3) { mesh.getVertexPosition(i, p); p.applyMatrix4(mesh.matrixWorld); b.expandByPoint(p) }
      row.push(`y${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)} x${b.min.x.toFixed(2)}..${b.max.x.toFixed(2)} z${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}`)
      seat.remove(rig.group)
    }
    console.log(`fit ${fit} hat ${hat}: ${row.join(' | ')}`)
  }
  process.exit(0)
}
const mats = createVehicleMaterials({ texture: (t) => t, add: (d) => d })
const SKINS = new Set([mats.slots.paint, mats.slots.paint2, mats.slots.glass])
const LOOKS = []
for (const [hat, name] of [[3, 'party hat'], [4, 'hard hat'], [8, 'helmet']]) {
  for (const [build, bname] of [[1, 'chubby'], [3, 'tall']]) {
    LOOKS.push({ look: { ...DEFAULT_LOOK, hat, build }, label: `${name}, ${bname}` })
  }
}
const ray = new THREE.Raycaster()
const eye = new THREE.Vector3()
const p = new THREE.Vector3()
const d = new THREE.Vector3()
const inv = new THREE.Matrix4()
let worstAll = 0

for (const [id, build] of [['car', buildCar], ['boat', buildBoat], ['heli', buildHeli], ['ship', buildShip]]) {
  if (only && only !== id) continue
  const v = build({ mats })
  v.root.updateMatrixWorld(true)
  const walls = []
  v.root.traverse((o) => {
    if (o.isMesh && !o.isSkinnedMesh && SKINS.has(o.material)) walls.push(o)
  })
  for (const [seat, passenger, sname] of [[v.driverSeat, false, 'driver'], [v.passengerSeat, true, 'passenger']]) {
    let worst = { n: 0, depth: 0, at: null, label: '' }
    for (const { look, label } of LOOKS) {
      const rig = buildPlayerBody(3.84, 34, look)
      rig.sit(seat.userData.fit ?? CABIN_FIT, passenger, seat.userData.room ?? null)
      seat.add(rig.group)
      rig.group.position.set(0, 0, 0)
      rig.group.rotation.set(0, Math.PI, 0)
      let mesh = null
      rig.group.traverse((o) => { if (o.isSkinnedMesh) mesh = o })
      for (let f = 0; f < 240; f++) {
        v.root.updateMatrixWorld(true)
        rig.seatedTick(1 / 60)
        if (f % 80 !== 79) continue
        rig.group.updateMatrixWorld(true)
        mesh.skeleton.update()
        seat.getWorldPosition(eye)
        inv.copy(seat.matrixWorld).invert()
        const pos = mesh.geometry.getAttribute('position')
        let n = 0
        for (let i = 0; i < pos.count; i += 2) {
          mesh.getVertexPosition(i, p)
          p.applyMatrix4(mesh.matrixWorld)
          d.subVectors(p, eye)
          const len = d.length()
          if (len < 1e-4) continue
          ray.set(eye, d.divideScalar(len))
          ray.far = len
          const hit = ray.intersectObjects(walls, false)[0]
          if (!hit) continue
          n++
          const depth = len - hit.distance
          if (depth > worst.depth) {
            worst.depth = depth
            worst.at = p.clone().applyMatrix4(inv)
            worst.label = label
          }
        }
        if (n > worst.n) worst.n = n
      }
      seat.remove(rig.group)
    }
    worstAll = Math.max(worstAll, worst.n)
    const at = worst.at ? `at ${worst.at.toArray().map((x) => x.toFixed(2)).join(', ')} (${worst.label})` : ''
    console.log(`${id.padEnd(5)} ${sname.padEnd(10)} ${String(worst.n).padStart(4)} vertices out, worst ${worst.depth.toFixed(2)} deep ${at}`)
  }
}
console.log(worstAll ? 'riders clip the fleet' : 'every rider fits')
if (worstAll) process.exitCode = 1
