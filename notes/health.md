# Health, damage, death and respawn

Server-authoritative hit points for the shared walk, and the foundation for
competitive modes, lava, creatures and Cubeland survival. The server owns
every number; clients render, react and report only what they alone know
(a landing speed) or ask for the console's verbs for themselves.

## Module map

- `server/src/health.js` (new): the model. One instance in `index.js`
  (`worldHealth`), dispatch for `world-fall` / `world-health-cmd`, a tick call in
  `worldTick`, `snapshot/left/moved/pose` one-liners at join, leave, level
  change and every pose report. `weapons.js` gets an optional `health`
  (drops shots from the dead, records shot credits, calls `health.hit`);
  `props.js` gets an optional `onBlast` callback after a validated
  `world-prop-explosion`.
- `src/game/net/healthProtocol.ts` (new, in the `protocol.ts` unions): wire types.
- `src/game/player/health.ts` (new, React-free): the client's view. Own and
  remote hit points, pvp flag, killfeed, scoreboard, `flash`, `low`, a
  `respawnIn()` countdown, and events (`hurt`, `died`, `respawn`, `pvp`,
  `kill`, `refused`).
- `src/game/player/healthSfx.ts` (new): hurt / death / respawn synths. Peak
  gains 0.03 to 0.09, i.e. with the landing thump and spawn pop, under a door.
- `src/components/os/HealthHud.tsx` (new): bar (bottom centre, masking tape,
  hand-drawn heart, only when pvp is on or you have been hurt), red vignette
  flash (CSS animation, re-keyed per hit), low-health breathing vignette,
  killfeed (ticket stubs, top right under the fps tape), pvp note, and the
  death sheet with the countdown.
- `src/game/net/avatars.ts`: a health pip under a hurt remote player's plate
  (`AvatarEnv.hpOf`; nine shared textures, no new program).
- `src/game/sandbox/healthCommands.ts` (new; `SandboxHost.health` added to
  `commands.ts`): `/health` (`/hp`), `/hurt n`, `/heal`, `/pvp on|off`, `/kill`
  (online: a real knock-out; offline: the old fall-in-a-heap), and `/god`
  with fresh help. `god` now also tells the server; the local `godMode` in
  CrtScene is the same variable as before.
- `CrtScene.tsx`: about 90 lines: create the store, feed it messages, report
  hard landings, keep the body down while dead, `health.on` for the death
  flop / respawn teleport / sounds, `<HealthHud/>`, `__health` dev hook.
- `src/i18n.tsx`: `sandbox.health` in both languages.

## The API other server modules call

```js
const health = createHealth({ players, send })   // index.js: `worldHealth`
health.hurt(ws, amount, { by, kind })   // the one entry point (alias: damage)
health.heal(ws, amount)
health.kill(ws, { by, kind })           // bypasses god and protection
health.setPvp(scope, on, { sticky, by })
health.isPvp(scope)
health.stats(scope)                     // [{ id, kills, deaths, score, hp, dead }]
health.hpOf(ws), health.isDead(ws)
health.onDeath(({ victim, killer, kind, scope }) => ...)   // returns unsubscribe
health.onRespawn((ws) => ({ x, z }) | undefined)           // a mode picks spawn spots
health.reset(scope)                     // zero the counters, everyone whole and alive
```

- `scope` is `ws.world.level`, whatever string that is (rooms compose for free).
  A scope that empties is forgotten (pvp resets to off) unless pinned with
  `setPvp(scope, on, { sticky: true })`.
- `by` is a player id or 0. `kind` is a lowercase tag (`/^[a-z][a-z0-9_]{0,15}$/`;
  anything else becomes `env`). The client phrases `pistol crossbow rocket blast
  fall lava fire mob crash kill hurt env`; other tags show as "out". Add a
  line to `sandbox.health.kinds` in both languages for a new kind.
- Rules inside `damage`: dead, god-mode and spawn-protected players take nothing
  (`kind: 'kill'` alone bypasses); `by` set to another player only lands when the
  scope's pvp is on; `by` 0 or oneself always lands. Score is +1 per kill, -1 for
  `/kill` and `/hurt` deaths. A death sends `world-death` (killfeed + the changed
  score rows), then `onDeath` listeners run.
- Environment hooks need nothing more than `health.hurt(ws, 15 * dt, { kind: 'lava' })`
  from a tick; hit points are floats server-side and rounded on the wire, and
  rows are coalesced per world tick, so a per-tick trickle is cheap.
  Continuous sources should still be capped at their own tick rate.
- Creatures: attack with `health.hurt(victimWs, 8, { by: 0, kind: 'mob' })`.
- Modes: `health.setPvp(scope, true, { sticky: true })`, `onRespawn` for spawn
  points, `stats(scope)` for the scoreboard, `reset(scope)` between rounds.

## Rooms

Merged: `room.health = createHealth({ players, send })` is built in `buildRoom`
beside weapons (which receive it) and props (whose `onBlast` closes over the
room), so pvp, the counters, the killfeed and respawn timers are per room.
`tick` runs for every room in `worldTick`; `snapshot`, `left`, `moved` and
`pose` go through the joining player's `room`, and `world-fall` /
`world-health-cmd` through `roomOf(ws)`. Scope stays `ws.world.level` inside
the room. `server/test/health.mjs`'s `healthRoomsSmoke` proves the isolation.

## Rules that bite

- **The client never says how much.** Pistol 12 / crossbow 45 (x1.5 above 3.4
  units over the feet), and a blast is derived from the relay's own validated
  position, power and radius. A hit needs a shot of that weapon within the last
  8 s to have paid for it; credits are spent even with pvp off so free-play
  shots cannot be banked for a fight. Firing ends spawn protection.
- **Free-play weapons are unchanged**: with pvp off a `world-shot-hit` on a player
  still shoves them, exactly as before, and hurts nobody.
- **Blasts**: other players are hurt only in pvp AND only if the caster fired a
  rocket in the last 8 s or the blast is from a prop (a barrel). The console's
  free `explode` throws props and hurts no one. Self blast is half damage, pvp
  only (rocket jumping stays free otherwise). Max 90 x sqrt(power) clamped
  to 0.3..1.2, to `min(radius, 24)` units, linear falloff, from the body centre.
- **Falls**: the client reports `step.landing` when over 30 u/s and outside
  noclip / god; the server clamps it to `sqrt(2 g drop) * 1.15 + 3` where `drop`
  is the height it saw over the current pose in the last 20 s (`pose(ws)` runs
  in `handleWorldMove`), ignores flyers, and charges 3 hp per u/s above 32.
  A 55-unit drop (landing 61 u/s) cost 46 hp in the two-client drive (the server caps it to the drop it saw); a claimed 60 u/s with no seen
  drop does nothing.
- **A dead body stays a heap**: CrtScene gates `wantsUp` and `standNow` on
  `health.dead`. Death leaves any vehicle, seat and noclip, then `rig.flop`s the
  body away from the killer. The respawn walks to the front path (a level with a
  house) or `level.spawn`, scattered by `scatterSpawn`, unless the server named a spot.
- **Dead players do not shoot**: `weapons.js` drops their shots, and the client's
  tool belt is already holstered while `rig.down`.
- **Cheats vs fights**: `heal` and `god` are refused while pvp is on unless admin;
  turning pvp on drops everyone's god. Anyone may toggle pvp (announced to the
  level with who did it); a stricter policy (admin only, mode-owned) is one
  line in `handle` for `pvp`.
- **No shader work**: the HUD is DOM, the pip is a sprite reusing the plate's
  mapped-sprite program with shared textures. Vehicle collision damage is NOT
  done (see below).

## Wire

See `server/README.md` "Health, death and respawn" and `healthProtocol.ts`.
`world-fall`, `world-health-cmd` (C to S); `world-hp`, `world-death`,
`world-respawn`, `world-pvp`, `world-scores`, `world-health-no` (S to C).

## How to verify

- `cd server && npm test` runs `test/health.mjs` (pvp gate, damage and headshot
  numbers, unbacked hits, death credit and counters, respawn and protection,
  free vs rocket blasts and falloff, fall sanity, cheat refusal, level isolation).
- `PROBE_PORT=5200 PROBE_CDP=9410 node scripts/health-drive.mjs`: two Chromes
  and a private relay; A shoots B with the real pistol path. Screenshots in
  `shots/health` (or `HEALTH_SHOTS`).
- `npm run drive -- health` (single client, offline): the console verbs say
  what they must and the HUD stays away.

## Not done / known imperfect

- Vehicle collision damage: not built. The hook is ready (`world-fall` is the
  shape: a client-reported speed the server clamps); it needs the fleet's
  impact speed reported from `registry.ts` and a `kind: 'crash'` charge.
- Offline (no server) there are no hit points: `/hurt` and `/heal` say so, and
  `/kill` falls back to the old flop.
- `world-hp` for other players is only sent for changes, so a player who healed
  while you were in another level shows as whole after `newLevel()` clears the
  cache; this is the intent, but a hurt player you meet on arrival is listed by
  the join snapshot only if they are below max.
