/*
  A fleet with no machines in it.

  The three vehicles are the heaviest thing the runtime builds: three lofted
  procedural bodies with clearcoat paint and a painted env map, and about eight
  thousand lines of module behind them, and every one of them is parked
  OUTSIDE: the car at the kerb, the helicopter a block north, the boat two and
  a half kilometres west. None of that is reachable, or visible, from inside the
  house. So a boot that only builds the room should not pay for any of it.

  CrtScene touches the fleet in roughly thirty-five places, several of them in
  the per-frame tick, and sprinkling `fleet?.` through a hot loop in a file that
  size is how subtle bugs get in. A null object costs one module and leaves
  every one of those call sites reading exactly as it did: `all` is empty, so
  nothing is ever nearest; `riding` is null, so no branch that matters is taken;
  `tick` reports a frame in which nothing moved. `CrtScene` swaps the real
  registry in when the world attaches, and because the call sites close over the
  `fleet` BINDING rather than its value, they pick the real one up for free.

  Type-only imports on purpose: this module must not pull `registry.ts` (and
  through it car.ts, heli.ts and boat.ts) into the eager chunk, which is the
  entire point of it existing.
*/

import * as THREE from 'three'
import type { VehicleFleet, FleetStep } from './registry'

const STILL: FleetStep = {
  driving: null,
  riding: null,
  prompt: null,
  promptSeat: 0,
  moved: false,
  speed: 0,
  load: 0,
  altitude: 0,
  gear: 0,
  rpm: 0,
  boarding: false,
}

export function emptyFleet(): VehicleFleet {
  // a real (empty) group, so anything that parents to or hides the fleet root
  // works unchanged and the swap has nothing to re-wire
  const root = new THREE.Group()
  root.name = 'fleet:empty'

  return {
    root,
    all: [],
    driving: null,
    riding: null,
    seat: 0,
    cockpit: false,
    toggleView: () => {},
    turn: () => {},
    nearest: () => null,
    enter: () => {},
    takeSeat: () => {},
    leave: () => null,
    setNet: () => {},
    tick: () => STILL,
    spawnAll: () => {},
    // "there is nowhere for it to go" is exactly true with no world loaded,
    // and it is already the answer the caller knows how to show
    recall: () => false,
    placeFromNet: () => {},
    where: () => ({ dist: 0, bearing: 'N' }),
    setDay: () => {},
    setLightWarmup: () => {},
    setMuted: () => {},
    sleep: () => {},
    dispose: () => {},
  }
}
