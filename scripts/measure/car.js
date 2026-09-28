/* Hill starts through the real car: npm run measure -- car. */
// THREE comes from measure.mjs's prelude.
import { buildCar } from '../../src/game/vehicles/car.ts'
import { createVehicleMaterials } from '../../src/game/vehicles/materials.ts'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'

const materials = createVehicleMaterials({ texture: (t) => t, add: () => {} })
const car = buildCar({ mats: materials })
for (const [surface, degrees, reverse = false] of [
  ['asphalt', 0], ['grass', 0], ['grass', 15], ['grass', 25], ['grass', 30],
  ['grass', 35], ['grass', 45], ['grass', 25, true], ['sand', 0], ['snow', 0],
]) {
  const grade = Math.tan(degrees * Math.PI / 180)
  const keys = new Set()
  const env = {
    dt: 1 / 120, keys, frozen: false,
    groundAt: (_x, z) => -z * grade,
    surfaceAt: () => surface, waveAt: () => 0,
    collision: makeCollisionSet({ minX: -1e4, maxX: 1e4, minZ: -1e4, maxZ: 1e4 }),
  }
  car.placeAt(0, 0, reverse ? Math.PI : 0, env)
  const start = car.root.position.clone()
  for (let i = 0; i < 120 * 3; i++) car.update(env, false)
  const parkedDrift = Math.hypot(car.root.position.x - start.x, car.root.position.z - start.z)
  keys.add(reverse ? 'KeyS' : 'KeyW')
  let step
  let accelerationTime = 0
  for (let i = 0; i < 120 * 10; i++) {
    step = car.update(env, true)
    if (step.speed >= 30 && !accelerationTime) accelerationTime = (i + 1) / 120
    if (!Number.isFinite(car.root.position.x + car.root.position.y + car.root.position.z + step.speed)) {
      throw new Error('Non-finite car physics')
    }
  }
  const uphill = -car.root.position.z
  console.log(`${surface} ${degrees} deg${reverse ? ' reverse' : ''}: uphill ${uphill.toFixed(1)} units in 10 s, speed ${step.speed.toFixed(1)}, parked drift ${parkedDrift.toFixed(3)}`)
  if (parkedDrift > 0.01 || (degrees <= 35 && uphill < 35) || (degrees === 45 && uphill > 1)) {
    console.error('  FAIL: car must hold when parked, start uphill, and still refuse cliffs')
    process.exitCode = 1
  }
  if (surface === 'asphalt') {
    const topSpeed = step.speed
    const brakeFrom = car.root.position.z
    keys.clear()
    keys.add('KeyS')
    for (let i = 0; i < 120 * 5 && step.speed > 0.2; i++) step = car.update(env, true)
    const stopDistance = brakeFrom - car.root.position.z
    console.log(`  road: 0–30 in ${accelerationTime.toFixed(2)} s, top ${topSpeed.toFixed(1)}, braking distance ${stopDistance.toFixed(1)}`)
    if (topSpeed < 38 || topSpeed > 42 || stopDistance > 35 || step.speed > 0.2) {
      console.error('  FAIL: pulling power must preserve road-speed and braking limits')
      process.exitCode = 1
    }
  }
}
car.dispose()
materials.dispose()
