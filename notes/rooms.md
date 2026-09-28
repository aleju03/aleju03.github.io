# Rooms (private lobbies for the shared world)

## What it is

The walk used to have one shared world per level. Now it has one per
(room, level). The default room, `public`, is the world exactly as it was;
anyone can also make a private room (a 6-character code, e.g. `8V5CV5`) and
send an invite link (`/world?room=CODE`). Only people in a room see each
other, chat, hear each other's voice handshake, and share props, blocks,
damage, portals, shots and the four vehicles.

## Design decision (differs from the brief's recommendation, on purpose)

The brief suggested making `ws.world.level` a composite `room|level` string
translated at the wire. That was not done. Instead **each room gets its own
`players` map and its own instance of every server module**. Every module
already scopes itself by filtering `players` on `ws.world.level`; handing it a
room-sized map is the whole of the isolation. Consequences: `level` stays the
plain level id everywhere (wire, modules, tests), nothing had to be translated
in nested payloads (portal pairs name a level inside the message, the effects
module compares against literal `'overworld'`/`'moon'`), the existing tests
were untouched, and a module cannot leak across rooms because it was never
handed anyone from another room.

## Module map

Server
- `server/src/worldRooms.js`: room registry (caps, grace, code validation,
  limiter helper). Public room built at boot, never dies.
- `server/src/index.js`: `buildRoom(room)` creates the per-room module set
  (props, effects, damage, blocks, weapons, fleet). `roomOf(ws)` dispatches.
  `worldBroadcast(room, ...)`, `worldTick` (loops rooms), `openRoom`
  (find/create + rate limits), `handleWorldJoin/leaveWorld`.
- Env: `WORLD_MAX_ROOMS` (200), `WORLD_ROOM_MAX_PLAYERS` (16),
  `WORLD_ROOM_GRACE_MS` (30000). Public cap stays 32; `WORLD_MAX_TOTAL` 320.
- Tests: `server/test/worldRooms.mjs` (run from smoke.mjs, step "0").

Client
- `src/components/os/worldRoom.ts`: the store (wanted room, create flag, live
  room, last error), `?room=` parsing, code minting, invite URL.
- `src/components/os/worldNet.ts`: join carries the room (read on every join,
  so reconnect rejoins the same room); a refusal while a join is pending calls
  `failRoom` (falls back to public); a welcome without `room` when a private
  room was asked for is treated as a refusal (old server).
- `src/components/os/RoomStrip.tsx`: the paper strip (public / new private room
  / code field / copy invite link / new code / back to public). Used on
  `MapPicker.tsx` and `PauseScreen.tsx`.
- `src/components/os/RoomChip.tsx`: HUD chip, only when live in a private room.
- `CrtScene.tsx` (small): subscribes to the store; on a change of wanted room
  it does `leaveWorld(); joinWorld()` (the same teardown as sitting down and
  standing up, so no state is half-stale, voice peers included); renders the
  chip. `roomRestartRef` + `joinedRoom` are the only new state.
- `protocol.ts`: `world-join` gains `room?`/`create?`, `world-welcome` gains
  `room?`.
- i18n: `pause.room.*` in both languages.

## Rules that bite

- **Any new server world module must be created inside `buildRoom` and
  dispatched with `roomOf(ws)?.x.handle(...)`.** A module created at file scope
  with the global `worldPlayers` is shared by every room. (Merging: other
  agents' modules that were added as `createFoo({ players: worldPlayers, ... })`
  must be moved into `buildRoom` and their `foo.handle` dispatch changed to
  `roomOf(ws)?.foo.handle`; their `snapshot/left/leave` calls in
  `handleWorldJoin/leaveWorld/handleWorldLevel` become `room.foo.*`.)
- `ws.room` on the server is the unrelated *chat* room; the world's is
  `ws.world.room` (an object).
- Rooms are chosen after the join already happened: CrtScene joins at
  stand-up (harnesses wait for `network.online` before `__pickMap`, so
  deferring would break them). A room picked on the sheet is a re-join, so
  the public world briefly sees "x is here / x left" for someone who goes
  private from the sheet. A `?room=` link joins directly with no public flash.
- Link and created rooms join with `create:true` (invites survive the room
  being forgotten); a hand-typed code joins with `create:false` so a typo is
  `room_unknown`, not a fresh empty room. Once welcomed, a room is
  reopenable on reconnect.
- The URL bar is not rewritten; sharing is the copy-link button.

## Wire

See `server/README.md` "World rooms". Errors: `room_unknown`, `room_full`,
`room_limit`, `rate`, `bad_request` (malformed code).

## Verify

- `cd server && npm test`: step 0 proves isolation of roster, ticks, chat,
  signals, props, damage, seats; late joiner gets the room's snapshots; join
  errors; grace-window rejoin keeps props; room dies when empty and is reborn
  clean; per-socket creation limit.
- `node scripts/rooms-drive.mjs [--shots dir]` (PROBE_PORT/PROBE_RELAY/PROBE_CDP):
  three headless Chromes and a private relay: A+B via invite link see each
  other and C (public) sees nobody; a crate spawned in the room never reaches
  C; leave to public; refused code falls back; create + join by code.
