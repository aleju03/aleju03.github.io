# Creatures (living things to play with and against)

A reusable, React-free system for animals and monsters, first used in
Cubeland (pig, cow, sheep, chicken, zombie, creeper, skeleton) and, small, in
Nuketown (six mannequin walkers that fall over and get back up). One client
per scope simulates ("the host"); everyone else interpolates what it says;
the server designates the host, relays, and referees damage. Nothing is
downloaded: bodies are boxes on the props' atlas material, voices are
WebAudio.

## Module map

Runtime (`src/game/creatures/`, headless-safe except `view.ts`, `models.ts`,
`sounds.ts` which need three / audio and no-op without them)
- `kinds.ts`: the kind table (`KINDS`): id, append-only wire `index`, size,
  speed, health, mass, behaviour, voices, chatter, `drops` metadata (catalogue
  kind ids with counts, for a later survival mode; no inventory), `CAPS`.
- `world.ts`: the two seams. `CreatureWorld` (the level's half: `footing`,
  `spots`, `light`, `exposed`, `clearLine`, `fauna`, `drops`, `residents`) and
  `CreatureEnv` (the scene's half: `players`, `daylight`, `hurtPlayer`,
  `explode`). `canStand` helper.
- `sim.ts`: the simulation, fixed 1/30 s. Steering (wander, flee, chase, keep
  distance, loop following), the spawner (packs on grass by day in a ring of
  26 to 58 units, hostiles wherever the light is under 0.3), despawn ring,
  caps, damage in (`hit`, `blast`), damage out (`env.hurtPlayer`), events.
- `collisionWorld.ts`: `CreatureWorld` for any level whose ground is a
  `CollisionSet` (Nuketown): `supportY` + `blockedAt`.
- `models.ts` + `cells.ts`: the part lists per kind and the atlas cells (declared
  before the atlas packs: `sandbox.ts` imports `cells.ts`). `view.ts`: pose
  and tint per part; parts are `BatchProxy`s under `sb.root`, so the sandbox's
  batcher draws them as instances. `sounds.ts`: voices through
  `placedVoice` (the props' bus).
- `director.ts`: one per level with `Level.creatures`, made with its sandbox:
  sim + remote store + view + sounds + drops + the wire. The scene talks to
  this only.
- Level side: `levels/cubeland/creatures.ts` (block store answers),
  `levels/nuketown.ts` (`collisionCreatures` + the walkers' loops),
  `Level.creatures?: CreatureWorld` in `levels/types.ts`.
- Net: `net/creatureProtocol.ts` (wire types, row layout), `net/remoteCreatures.ts`
  (interpolating store).
- Console: `sandbox/creatureCommands.ts` (`/mobs on|off|clear|peaceful|hostile|count`,
  `/spawnmob KIND`), `SandboxHost.creatures`.
- Server: `server/src/creatures.js` (host, relay, bounded table, hit and attack
  validation), wired in `buildRoom`. Docs in `server/README.md`. Tests:
  `server/test/creatures.mjs` (in `npm test`), `node scripts/creatures-test.mjs`
  (sim and store, no browser).
- Scene (`CrtScene.tsx`, small additions): `creatureDirs`, `creatureRoute`,
  `creaturePlayers`, director made in `sandboxFor`, `update` before the
  sandbox tick, `knock` beside the crowd's, `host.creatures`, `__creatures`.

## How it works

- **Host.** Server: the longest-present player in room+level. Offline the local
  player is the host. A machine that becomes host adopts the herd it was
  watching (`sim.adopt(remote.rows())`). Snapshots go out at 8 Hz, only when
  someone else is in the level.
- **Rendering.** Every part is an instance of a unit-box geometry (a material
  cell or a head with its face) on the atlas material, so no new program links
  (`npm run drive -- links` counts). Walk cycle from distance walked, head
  turns to the nearest player within 14 units and lowers to graze, hit flash
  is the proxy tint, death tips the body over and shrinks it, a creeper swells
  and blinks. Going through the pixel look like any prop.
- **Damage in.** `director.knock(watch)` is the crowd's `ImpactWatch` seam:
  pistol, crossbow, cars all ask each creature what they ask a pedestrian; the
  shove they answer with is turned into damage (`(|dv|-2)*2.2`). Blasts:
  `sb.onExplosion`, applied by the host only (remote rockets arrive as the
  relay's replay, so nothing is counted twice). Props flying into creatures
  (the physgun as weapon) every 0.12 s. A non-host sends
  `world-creature-hit` and flashes the creature locally.
- **Damage out.** `env.hurtPlayer` becomes `world-creature-attack`; the server
  checks and applies `health.hurt(victim, n, {by: 0, kind: 'mob'})` with ITS
  number (melee 5, arrow 4, blast up to 45 falling off to 11 units) and
  sends the victim a knock. Offline it is a bare knockback (no hit points).
- **Creeper.** Within 6.5 units it hisses and swells for 1.5 s (walking away
  cancels), then `env.explode` (the level's own blast: Cubeland carves blocks
  through `sb.explode`) and the animals near feel it.
- **Skeleton.** Keeps 11 to 26 units away, strafes, and looses a slow arrow (a
  creature of kind `arrow`, visible to all, 34 u/s with a light gravity) every
  two to three seconds when it can see you.
- **Day and night.** Passive kinds spawn on grass by day with sky access;
  hostile ones where `max(block light, sky * daylight) < 0.3` (night on the
  surface, always in caves, never beside a torch). Zombies and skeletons
  standing under open sky in daylight burn (3 hp/s). The hour is the sky's own
  (`lastSky.day`), so the console's `time` pins it.
- **Drops.** A kill by a player leaves the kind's `drops` as catalogue props
  flagged `gib` (Cubeland's `drops: true`), swept up by the breakables.

## Rules that bite

- **Cells are declared before the atlas packs.** A new creature cell goes in
  `creatures/cells.ts`, which `sandbox.ts` imports. A new kind is a row in
  `kinds.ts` (append only), a spec in `models.ts`, and, if the server should
  accept it, `KIND_COUNT` in `server/src/creatures.js` (a test compares).
- **Anything world-shaped is read through the level's `footing`.** No
  `level.id ===` in the runtime. `footing` must return a fresh object.
- **The sim runs only on the host.** Never step it on a guest; a guest's
  `sim` is empty. Damage from an explosion is applied by the host only.
- **Children of the sandbox root are drawn only while their level is live**
  (`sb.root.visible`), and the director must `update` before `sandbox.tick`
  (the batcher writes matrices at the end of the tick).
- **Snapshot rows are eight integers; the kind index is the wire.** A guest's
  speed, head turn, fuse and arrow pitch are derived from how rows change.
- The server's `KIND_COUNT`, `K_ZOMBIE`, `K_CREEPER`, `K_ARROW` mirror the
  kind table's indices.

## Not done / known imperfect

- Creeper blasts farther than 170 units from the host's own pose are not
  relayed to others as an explosion (the propNet validation); the block edits
  still are.
- No baby animals, no breeding, no swimming (water columns are walls to
  everything), no inter-creature collision (a herd can overlap).
- Steering is local (feelers fanned round the goal), not pathfinding: a hostile below a cliff of two or more blocks stands at its foot.
- Guests see hits a snapshot late (the hit flash is local and immediate).
- The pig is pink whatever the biome; extras (polar bear and so on) not built.
- Survival inventory not built: `drops` is metadata plus gib props only.

## Verify

- `node scripts/creatures-test.mjs` (steering keeps to the floor, caps, day and
  night and cave rules, peaceful, despawn ring, zombie cooldown and burn,
  creeper fuse, skeleton arrows, hit/death/revive, the wire round trip).
- `cd server && npm test` (step 0b: host designation and handoff, relay,
  bounds, hit validation, attack validation through health, switches).
- `PROBE_PORT=5240 PROBE_CDP=9450 npm run drive -- creatures` (single client,
  shots `shots/creatures/creatures-*.png`, links counted).
- `PROBE_PORT=5240 PROBE_CDP=9450 node scripts/creatures-drive.mjs` (two Chromes
  and a private relay).
- `npm run drive -- links` must stay at 0.
