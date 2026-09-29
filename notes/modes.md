# Rounds and modes

Goals for friends in the shared walk: a lobby, a countdown, a round, a
results sheet, and five games to play in it. The server owns every rule and
every clock; the client draws, holds the walker still where a game says so,
and reports the few things only it can see.

## What is complete and what is thin

| Mode | State |
| --- | --- |
| Deathmatch (teams or free for all) | complete: teams, no friendly fire, team yards, kill limit / time, respawn 3 s, scoreboard, results |
| Hide and seek | complete: frozen and blind seekers, server-gated, pistol or punch tag, infection, last hider wins |
| Prop hunt | complete, thinner on looks: disguise replicated and drawn as a batch proxy (no new program), hitbox is the prop's shape, sixty decoys, wrong-shot penalty, clean-up. The local prop does not see its own disguise (first person) |
| Race | complete for what the fleet allows. **The fleet has one car per room**, so on the home planet's streets racers take turns against the clock (a "time trial"), not a grid. In Cubeland everyone runs on foot at once. Boats and heli are not raced |
| Build contest | complete in flow (plots as claims, tour, votes, tally, plots released). The blocks people placed stay in the world after the round (no server-side clear of a region yet) |

## Module map

Server (`server/src/`, plain ESM)
- `rounds.js`: the engine, one per room (built in `buildRoom`, `room.rounds`).
  State machine, host and readiness, the participants, teams/roles as mode
  data, the wire, leavers, debug flag, timing knobs.
- `roundModes.js`: the mode table, one object per game (see its header for
  every hook). **A sixth mode is one entry here plus one in `defs.ts`.**
- `roundData.js`: numbers measured once from the client's level code
  (Nuketown's 317 clear spots, the street loop, the Cubeland flat plots).
- `health.js` (additive): `setGuard(fn)`, `setRespawn(level, ms|Infinity)`,
  `revive(ws)`. `weapons.js` (additive): the optional `rounds` getter
  (`mayShoot`, `playerHit`, `propHit`). `props.js` (additive): `spawnSystem`,
  `removeSystem`. `claims.js` (additive): `assign`, `free`.
- `index.js`: about twenty lines: build, tick, snapshot, left, moved, pose,
  the `world-round-cmd` case, three env knobs.

Client
- `game/net/roundProtocol.ts` (the wire), `game/net/remoteRounds.ts` (the
  store: phase, parts, obj, clock offset, events).
- `game/modes/defs.ts` (names, blurbs, rules, sides, roles, options,
  announcement words, in both languages), `types.ts` (ModeHost, ModeClient),
  `director.ts` (the one thing the scene talks to; disguises), one file per
  game (`deathmatch.ts`, `propHunt.ts`, `hideSeek.ts`, `race.ts`, `build.ts`),
  `ringLayer.ts` (the checkpoint rings).
- `components/os/PlayPanel.tsx` (the Play page on the pause sheet, and the
  compact strip on the map sheet), `RoundHud.tsx` (tape, countdown, role card,
  blindfold, held-Tab scoreboard, results sheet), `worldRound.ts` (the bridge
  the menus read), `roundText.ts` (menu/HUD strings, en+es).
- `game/sandbox/roundCommands.ts`: the `round` console verb (`round mode
  hide`, `round opt limit 10`, `round ready`, `round start`, `round stop`,
  `round debug`, `round join`).
- `CrtScene.tsx`: about a hundred lines, all in delimited blocks: the store,
  the director and its `ModeHost`, `roundsFrame` per frame, the HUD, four
  one-line gates (walk `frozen`, `toolsLive`, respawn spot, weapon hitboxes),
  the `__rounds` dev hook. `avatars.ts` (additive): `hidden(id)` and
  `tintOf(id)` (side colour on the name plate). `weapons.ts`: optional `r`/`h`
  on a target. `Level.teamSpawns` (types + Nuketown). `bindings.ts`: a
  left click for the disguise (Y is the camera's photo copy, and every letter is taken), `Tab` scoreboard, `1-5` votes.

## How a round runs

`lobby` (anyone ready; host picks game/map/options; all ready, or the host
presses Start with enough ready) -> `countdown` (participants get
`world-round-go` if they are on another map, the client runs its own
`goMap`; the countdown waits up to 30 s for arrivals and drops stragglers)
-> `playing` (the mode's `start`, pvp and the respawn rule set on the room's
health scope, the guard live) -> `results` (12 s) -> `lobby` (mode's
`cleanup`, pvp/respawn/guard state restored, counters reset). Everyone else
in the room is a spectator: immune, cannot fire, HUD says "watching".
`debug` (admin, or the host of a private room) lowers all minimums to 1.

## Rules that bite

- **Scope is `ws.world.level`.** A participant is only in the round while on
  the round's level; walking off it is leaving. The round's map change is the
  client's own `goMap`, so a private room can run a round on Nuketown while a
  third player stands in the house.
- **Time rides as ms-left plus the server's `now`.** Never compare a server
  time with `performance.now()` directly; use `state.untilAt(serverMs)`.
  `obj` keys ending in `At` are server times.
- **Damage goes through `health.hurt` only,** and the round's veto
  (`guard`) is what makes teams, spectators, props and tag work. A forced
  `kill` skips the guard, as it skips god mode.
- **Movement gating is the server walking a wanderer back with a `tp`** (the
  client also freezes itself with `frozen()` in the walk step). A client that
  ignores the freeze is corrected once a second.
- **Prop hunt disguises are batch proxies** parented to the live sandbox
  root, so they are instances of a batch that already exists. If a kind's
  mesh is not a proxy it is not drawn; never draw a plain mesh (a new
  program links at first sight). The rings (`ringLayer.ts`) keep a collapsed
  warm mesh of their material in the tree for the same reason.
- **Checkpoints are the server's call:** order, the position the server has
  watched (ring radius + 16), the claimed position, and a top speed (140 u/s
  car, 40 on foot). The client only says "I am inside ring i".
- **The plots are claims** (`claims.assign`, four 16x16 chunk columns each):
  the existing edit guard and the blue edge sparks do the marking and the
  refusing. `PLOT_FIELDS` in `roundData.js` are chunk-aligned flat fields
  probed with the level generator.
- **Everything is bounded:** 16 participants, ten commands a second, one
  round per room, decoys are 60 of the level's 2000 prop cap, memory dropped
  at `cleanup`.

## Wire

See `server/README.md` "Rounds" and `game/net/roundProtocol.ts`.
`world-round-cmd` (C to S); `world-round`, `world-round-go`, `world-round-tp`,
`world-round-ev`, `world-round-dg`, `world-round-no` (S to C).

## How to verify

- `cd server && npm test`: `rounds.mjs` (lobby, host powers, debug, mode
  switching), `roundsDeathmatch.mjs` (arrival, teams, friendly fire,
  respawn, spectators, mid-round join, kill limit, leavers, stop, empty
  room), `roundsModes.mjs` (hide and seek, prop hunt, race, build),
  `roundsDefs.mjs` (server table and client table agree), `roundsSocket.mjs`
  (a round over the wire). Fake sockets, fake clock, real health/props.
- `npm run drive -- rounds` (single client, offline): every game's HUD, the
  scoreboard and the results sheet from hand-fed state (shots `rounds-*`).
- `PROBE_PORT=5250 PROBE_CDP=9460 node scripts/rounds-drive.mjs [--only dm,hide,prop,race,build]`:
  two Chromes and a private relay play real rounds (shots in `shots/rounds`).
- `npm run drive -- links` must stay at zero after arrival.

## Placing a new checkpoint loop, a plot field or scatter spots

The numbers in `roundData.js` were probed in Node with `npm run measure --
eval <file>` (the harness imports the world): `roadAt(x, z, placeAt(x, z)).asphalt`
along candidate rectangles for the street loop; `columnAt` from
`levels/cubeland/gen.ts` for flat chunk rectangles; and Nuketown built
headless (`buildNuketown` with a stubbed `document.createElement`) and asked
`blockedAt` on a 6-unit lattice for the scatter spots.

## Not done / known imperfect

- The race on the streets is one car at a time (one fleet car per room).
- Build contest edits are not cleared afterwards.
- A spectator's HUD is the same tape with a "watching" line; there is no
  follow-cam.
- The death sheet still counts down three seconds for a player who is down for
  the round (prop hunt, eliminated); the round HUD says "Out" beside it.
- Team plates are tinted, but there is no outline or icon for colour-blind
  players beyond the name.
- Cubeland's terrain at a far plot field is generated a moment after the
  teleport lands (the walker settles on it).

## Integration with creatures (merge)

While a round is `playing`, the round's level holds its creatures peaceful:
`applyHealth` calls `creatures.hold(level)` and `releaseHealth` calls
`release(level)` (server/src/creatures.js), which restores whatever `/mobs
peaceful|hostile` had set before. A `war` typed mid-round is remembered and
takes effect afterwards. Nuketown's walkers are unaffected (they are not
hostile). Prop hunt refuses kinds in `NO_DISGUISE` (explosives, balloon, lamp,
sign, contraption parts; Cubeland's `block_*`), mirrored in `modes/defs.ts`
and compared by `test/roundsDefs.mjs`. The disguise is a left click, not `Y`.
