# Prop synchronization validation

Implementation: branch `prop-sync`, isolated worktree `/tmp/aleju-prop-sync`.
Started from `world-overhaul`, merged it before implementation and again
before the final verification. No pushes. The implementation does not edit
portal modules; the final merge includes the other agent's portal work.

## Protocol and authority

[The complete message names and JSON shapes are in README.md](README.md#sandbox-props).
All messages carry a level. The `world-prop-` family consists of `spawn`,
`snapshot`, `move`, `claim`, `ack`, `state`, `meta`, `joint`, `unjoint`, `hit`,
`break`, `explosion`, `remove`, `cleanup`, and `denied`.

Ownership grants editing, undo and cleanup. Authority grants simulation.
The spawner starts as authority. Physgun, driver-seat and keyed-part claims
are server arbitrated; collisions can transfer authority from the struck
prop to the moving prop's owner. Connected welds, axes, ropes and no-collides
transfer together. Revocation stops the previous simulator before its final
pose acknowledgement allows a new epoch to run. Other copies are kinematic
and interpolate two ticks behind. No extrapolation or parallel simulation.

The server retains props on departure. Another player in that level takes
authority, or the last poses park until somebody arrives. Ownership retains
the original world-session id. Reconnecting creates a new id; old props can
still be cleaned by the admin using the retained spawner name.

Limits: 150 props per spawner across levels, 2,000 per level, 8,000 globally.
Kinds, numbers, frames, reach, ownership, authority and epochs are validated.
Spawn nonces are idempotent. Mutation and movement budgets are separate.
State is in memory, with no database changes.

## Scope decisions

- Catalogue colour/material is defined by kind; remote props reuse the exact
  same atlas, geometry and batcher. Scale, mass, frozen state, constraints,
  part wiring, health and fuses travel.
- Online splinters are cosmetic particles on all peers. They do not have
  colliders, so local debris cannot alter shared physics. Offline gibs retain
  their existing simulation.
- Procedural building fracture and arbitrary custom rubble geometry remain
  local. This registry covers catalogue props and contraption parts; it does
  not replicate the planet's separate building damage registry.
- Portal pairs remain local. Same-level prop crossings keep the prop id and
  use a teleport flag to snap to the exit. The newly merged `portal_panel`
  is included in the allowlist. Future portal replication can reference the
  supporting prop id and portal frame. Cross-level prop travel would require
  an atomic server move of the connected group, joints and ownership between
  level registries.

## Verification

Passed after merging `world-overhaul`:

- `npx tsc -b`, ESLint on touched files, and `npm run build`.
- `cd server && npm test` on Node 22.23.2, including actual WebSocket tests for
  all message families, ownership, stale epochs, damage routing, clamps,
  cleanup permission, admin cleanup by name, caps, rate limits, idempotent
  spawns, level changes and late joins.
- `npm run measure -- prop-sync` in Node: actual Rapier and client stores
  against the registry, delayed spawn acknowledgement, no overlapping
  authorities, all four constraint types, group handoff, collision claim,
  remote ignition, seat-driven thrusters, owner key claims, cleanup, undo
  before acknowledgement, allowlist parity and zero resting traffic.
- `node scripts/prop-sync-drive.mjs`: two independent headless Chrome
  processes, one Vite on 5194, relay on 8794, CDP on 9394 and 9395. A's crate
  appears on B, is thrown, lands in agreement, and is picked up by B's actual
  physgun. The welded contraption, barrel explosion, late rejoin and cleanup
  all agree. B's own prop survives A's cleanup. No browser exceptions.
- `PROBE_PORT=5195 PROBE_CDP=9396 npm run drive -- links`: **0 programs linked**
  through spawn, look changes, breakage, fuse and explosion chain. The
  two-client test independently asserts **0 local and remote shader links**.

Thrown crate end positions, world units:

| Client | x | y | z |
| --- | ---: | ---: | ---: |
| A | -30.979525 | 0.243817 | -325.986938 |
| B | -30.980000 | 0.240000 | -325.990000 |

The difference is about 0.0049 units, within the centimetre quantization.
B's carrying pose trails B on A by the intended two-tick playback delay.

## Bandwidth

Four-second samples in the real two-process browser test. The resting case
has 100 frozen props from each player. Then ten of A's bodies are unfrozen
and kept awake and moving; the other 190 remain at rest. Spawn/snapshot
traffic is excluded from the measurement window.

| Case | A prop upload | Each client's prop download |
| --- | ---: | ---: |
| 200 resting | 0 B/s | 0 B/s |
| 190 resting, 10 moving, JSON payload | 5,840 B/s | 5,728 B/s |
| 190 resting, 10 moving, WebSocket framing included | 5,945 B/s | 5,780 B/s |

Framing includes client masks and frame length headers. TCP/IP and TLS are
excluded; this was a local unencrypted WebSocket. Small differences between
upload and download are expected from coalescing and sample boundaries.
Presence added roughly 239 B/s per receiving client during this run.
