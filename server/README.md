# AlejOS chat server

Self-hosted WebSocket server behind the AlejOS login screen, the Chat Rooms app and the Games folder. Visitors register real accounts (stored in SQLite, scrypt-hashed passwords) or chat as guests, then talk in shared rooms: `#general`, `#projects`, `#random`. Room history persists so late joiners see the conversation. The same socket carries the arcade: shared per-game leaderboards (one best row per player per game) and Mine Duel, a turn-based 1v1 minesweeper with server-side matchmaking and game logic. Plain Node 22 ESM, no build step; dependencies are `ws` and `better-sqlite3` only.

v2 replaced the old 1:1 messenger protocol entirely, so deploy the server and the frontend together.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `8787` | HTTP/WebSocket listen port |
| `ADMIN_TOKEN` | yes | none | The password for the reserved admin username. The server refuses to start without it |
| `ADMIN_USERNAME` | no | `aleju` | Reserved username; logging in with it + `ADMIN_TOKEN` grants the admin badge. Nobody can register or nick it |
| `ALLOWED_ORIGINS` | no | unset | Comma-separated list, e.g. `https://aleju.dev,http://localhost:4173`. If set, WebSocket upgrades with an Origin header not in the list are rejected |
| `DB_PATH` | no | `./data/chat.db` | SQLite database path. The parent directory is created if missing |
| `STUN_URLS` | no | two Google STUN servers | Comma-separated STUN servers handed to clients for proximity voice |
| `TURN_URLS` | no | unset | Comma-separated TURN servers, e.g. `turn:voice.example.com:3478`. Only needed for visitors whose NATs cannot be traversed directly; unset means voice is pure peer-to-peer |
| `TURN_SECRET` | no | unset | Shared secret for coturn's `use-auth-secret` scheme. Required alongside `TURN_URLS`; per-join credentials are minted from it so no static password reaches a browser |
| `TURN_TTL_S` | no | `3600` | How long a minted TURN credential stays valid |
| `ANALYTICS_URL` | no | unset | libsql URL for the peeko analytics store (`libsql://…turso.io` or `file:./data/analytics.db`). **Unset disables analytics entirely** |
| `ANALYTICS_AUTH_TOKEN` | no | unset | Turso database token; not needed for a `file:` URL |
| `ANALYTICS_RETENTION_DAYS` | no | `180` | Rows older than this are pruned hourly |
| `ANALYTICS_SITE_HOSTS` | no | unset | Comma-separated hosts that count as real traffic in the live feed, e.g. `aleju03.github.io`. Keeps localhost and preview deploys out |
| `ANALYTICS_TIME_ZONE` | no | `UTC` | IANA zone for the feed's clock labels |
| `WORLD_MAX_ROOMS` | no | `200` | Private world rooms alive at once (see "World rooms") |
| `WORLD_ROOM_MAX_PLAYERS` | no | `16` | Players per private room. The public room keeps its own cap (32) |
| `WORLD_ROOM_GRACE_MS` | no | `30000` | How long an empty private room lives before it is forgotten, props and all |
| `YT_SEARCH` | no | `on` | Set to `off` to unmount the browser's video search. Nothing else depends on it |

## Video search

`GET /yt/search?q=<words>` → `{results: [{id, title, author, length, views, thumb}]}`,
origin-checked against `ALLOWED_ORIGINS` and rate limited to 20 searches a
minute per IP. Identical queries are served from memory for half an hour, which
is the limit that actually matters: each miss is a ~1.2 MB fetch.

It exists for one window. AlejOS's Internet Explorer is an iframe, and
essentially the whole modern web sets `x-frame-options`, google, bing and
duckduckgo included, so a search box in there could only ever render a polite
refusal. YouTube is the exception in one direction: the site refuses frames but
`youtube-nocookie.com/embed` does not, so a *result* is playable in that window.
Getting the list of results is the part a browser cannot do (the Data API wants
a key that would ship in the bundle, and the old no-key `listType=search` embed
has been dead since ~2020), so this reads `ytInitialData` out of the results
page instead.

That makes it the one route here that depends on somebody else's HTML. It is
written to fail soft: the parser walks for `videoRenderer` nodes anywhere in the
tree rather than following a path, an unparseable page is an empty list rather
than a throw, and an empty list is never cached. `server/src/ytsearch.js` owns
it, and the smoke test checks the parse against a hand-built payload rather than
against YouTube.

## Analytics

Traffic capture runs on [peeko](https://github.com/aleju03/peeko), in its own
libsql/Turso database, never `chat.db`, since analytics rows are high-volume
and would bloat the file chat reads from. `server/src/analytics.js` owns it.

The split that matters is trust:

- **`POST /peeko/capture` is public.** Browsers post to it cross-origin from the
  static site, so it carries no token. A token shipped to a browser is not a
  token. It is origin-checked against `ALLOWED_ORIGINS`, rate limited per IP,
  and can only ever append events. This is the only analytics route served over
  HTTP; `/peeko/monitor`, `/peeko/live` and the ticket routes are deliberately
  **not** mounted.
- **Reads are admin-only and ride the WebSocket.** The socket already
  authenticated at login, so the dashboard asks over it instead of holding a
  bearer token of its own.

Analytics messages, same socket after `hello`, all refused with
`{type:'error', code:'forbidden'}` unless the session is the admin:

- `{type:'peeko-monitor', rangeHours, country?}` → `{type:'peeko-monitor', rangeHours, country, now, overview, topPaths, topReferrers, topCountries, bounce, recent, bucketMs, timeline, devices, visitors, bots}`. `country` filters the feed only (the aggregates stay whole-site); `now` is the server clock, which the dashboard ages rows against instead of the browser's
- `{type:'peeko-breakdown', event, prop, rangeHours, distinct?, limit?}` → `{type:'peeko-breakdown', event, prop, rows}`. Top-N of any property in the props bag, which is how the site's custom events (`project_view`, `app_open`, `os_boot`) are read
- `{type:'peeko-live', on}` → subscribes; each accepted event arrives as `{type:'peeko-event', event}`

`rangeHours` is clamped to **720** at both ends, because that is peeko's own
ceiling: asking for more would answer with 30 days of data under a longer
label.

A failing analytics store never takes chat down: a bad token or an unreachable
database logs and leaves `analytics` null, and the dashboard reports
`unavailable`.

**Country data.** An edge geo header (`cf-ipcountry`, `x-vercel-ip-country`, …)
wins whenever one is present. Behind a plain Caddy none is, so the browser
sends its IANA timezone as `?tz=` on the capture request and the server maps it
to a country with `src/timezones.js`, generated from the system tzdata by
`node scripts/gen-timezones.mjs`. It is a query param rather than a header or a
body field because it has to survive `sendBeacon` and must not turn capture
into a preflighted request. No IP database: a licensed file to keep updated, or
a third-party lookup in the capture path, is a lot of machinery for a flag on a
personal dashboard. Put Cloudflare in front and the header takes over with no
code change.

Two deliberate departures from peeko's defaults, both in `analytics.js`:
`feedExcludeRootPageview` is off (on this site `/` is the front page, not
landing-page noise), and the paths panel is built from `getBreakdown` on
`$pathname` rather than `getTopPaths`, which hardcodes `path != '/'`.

Three rollups have no peeko method behind them and are raw SQL on the same
libsql handle, in `analytics.js`'s `derived()`: the bucketed **timeline** the
traffic chart is drawn from (aligned to the start of the range, so the newest
column always ends at "now"), the **device split**, and **new vs returning**
visitors, plus a count of the bot rows every other number excludes. peeko is a
core rather than a dashboard on purpose; its read API covers what every site
wants, and the shape of the rest is the site's own business.

**No clock label ever leaves this server.** peeko stamps each feed row with a
`timestamp` in `ANALYTICS_TIME_ZONE`, and the dashboard ignores it: an evening
visit came back reading 6am because the label was rendered in the VPS's zone
and read six hours west of it. Every time on screen is derived in the browser
from the epoch `ts`. The option stays set so anything else reading this store
gets a sensible zone rather than UTC.

## Protocol sketch

Everything is JSON over `/ws`. First message must be `hello`:

- `{type:'hello', token?, nick?}` → `{type:'hello-ok', user|null, badToken, rooms, you}`
- `{type:'register', username, password}` / `{type:'login', username, password}` → `{type:'auth-ok', token, user}` or `{type:'error', code}`
- `{type:'nick', name}` (guests only; registered names are protected) → `nick-ok`
- `{type:'join', room}` → `{type:'history', room, messages}` plus `users`/`rooms` broadcasts
- `{type:'msg', room, text, tmp}` → `{type:'ack', tmp, id, at}`; everyone else in the room gets `{type:'msg', room, message}`
- `{type:'typing', room}` → forwarded to the room, throttled

Messages carry `{from, admin, registered, text, at}` so the client can render badges. Session tokens, the admin's included, expire after 90 days and are swept hourly.

The admin has no `users` row (it authenticates against `ADMIN_TOKEN`, not the database), so its sessions live in their own `admin_tokens` table. They used to be in-memory only, which meant **every restart silently downgraded a still-logged-in admin to a guest**: the browser kept a session localStorage said was valid, the server no longer knew the token, and everything that socket did afterwards, arcade scores especially, was recorded under a guest name while the desktop still said "administrator". Clients now treat `badToken` in `hello-ok` as "this session is over" and return to the login screen rather than acting as an anonymous guest under a signed-in name.

Arcade messages, same socket after `hello`:

- `{type:'score-submit', game, score}` → `{type:'score-ok', game, best, improved, rank}`. Games and their caps live in `GAMES`; time-based games sort ascending. The `duel` board rejects submits, because the match engine writes wins itself.
- `{type:'score-top', game}` → `{type:'score-top', game, top: [...25], you: {score, rank} | null}`
- `{type:'duel-queue'}` → `duel-queued`, then `duel-start {seat, players, size, mines, lives, deadline}` once paired
- `{type:'duel-plant', cells: [5 indices]}` during the blind phase → `duel-planted` per seat (with `auto: true` plus your cells if the 45s clock planted for you), then `duel-phase {turn, deadline}`
- `{type:'duel-dig', cell}` on your turn → `duel-dug {cell, by, mine, count, lives, turn, deadline}` to both; a 20s turn timeout digs a random tile for the staller. Numbers count both players' mines (duplicates included); any mine costs the digger a life, their own included
- `duel-over {winner, reason, lives, mines}` reveals both minefields; `{type:'duel-rematch'}` from both seats restarts, `{type:'duel-leave'}` forfeits

Open-world presence, same socket after `hello`. Unlike the duel this owns almost
no rules: the world is a pure function of coordinates on every client, so the
only thing that has to travel is who is where. Positions are
client-authoritative, for the same reason the score caps are loose.
`src/game/net/protocol.ts` is the typed specification this section implements,
the socket has no version negotiation, so the two ship together.

The *almost* is the fleet. Three machines with two chairs each are the one piece
of world state this process holds, because "who has the wheel" is the one
question two clients cannot answer between themselves. Even there the server
simulates nothing: it hands out chairs and relays the transform of whoever is
sitting in the driving one.

- `{type:'world-join', level, look?, room?, create?}` → `{type:'world-welcome', you, room, tick, players:[{id,name,admin,registered,look?}], vehicles?, seats?}`, and everyone else gets `{type:'world-enter', player}`. Capped at `WORLD_MAX_PLAYERS`; a full world answers `error/unavailable`. The two optional fields catch a late arrival up on the fleet, and are absent while it is untouched. Until somebody moves a machine, every client's own spawn agrees about where all three are
- `{type:'world-look', look}` → `{type:'world-look', id, look}` to everyone else. `look` is 24 hex characters, four packed colours from `src/game/player/look.ts`, and this process never parses it; it is stored on the socket and relayed, so a repaint survives walking out of the world and back in. A malformed one is a strike, not a silent drop, because only a hand-written client can send one. The join carries the same field so nobody is ever drawn in the wrong colours, not even for one tick
- `{type:'nick', name}` → `{type:'nick-ok', name}` to the sender **and** `{type:'world-name', id, name}` to everyone else in the world. Renaming is not a world message at all: it is the chat server's existing nick, because one socket carries one identity and the plate over your head, the chat rail and the arcade boards all have to agree on it. Registered users are refused, as they always were
- `{type:'world-move', x, y, z, yaw, pitch, gait, f, e?, py?, pp?}`. The hot path, ~15/s per client, dropped rather than punished above the rate cap. `y` is the soles, not the eye; `f` is a pose bitfield (grounded/run/crouch/swim/**speaking**/down) mirrored by `POSE` in protocol.ts. `e` is the emote playing, packed as one small integer the server only range-checks (id and age, `src/game/player/emotes.ts`); `py`/`pp` are where the right arm points (a world yaw and pitch), sent only while pointing
- `{type:'world-tick', t, players:[[id,x,y,z,yaw,pitch,gait,f,e?,py?,pp?], ...], vehicles?:[[v,x,y,z,yaw,pitch,roll], ...]}`. Broadcast every `WORLD_TICK_MS` while anything has changed, **grouped by level**, so a visitor in the backrooms never receives the overworld's crowd. Tuples rather than objects because a full lobby would otherwise spend more bytes on repeated key names than on positions. The list includes the recipient; clients filter themselves out. A player missing from it is not gone, they are somewhere else. The vehicle rows are *not* grouped by level, since three rows are cheaper than working out which level a parked car counts as being in, and a client applies only the ones somebody else is driving
- `{type:'world-level', level}`. Stepping through a level seam, which is what moves you between snapshot groups. It also gives up your seat: the fleet lives in one level
- `{type:'world-seat', v, seat}` → `{type:'world-seats', seats:[[v,driver,passenger,hand], ...]}` to everyone, or `{type:'world-seat-denied', v, seat}` to the loser of the race. `seat` 0 is the wheel, 1 the other chair, and `0` in the table means empty (ids start at 1). Taking a chair gives up the last one, which is also how you slide across into the driving seat. `{type:'world-unseat'}` gets out. Chairs are freed on a level change, on leaving the world and on a dropped socket. The machine stays where it was abandoned, only the seat is released
- `{type:'world-hold', v, on}`: take an *empty* machine on the physgun (`on: true`), or let it go. Granted when nobody is sitting in it and nobody else has it, and shown as the fourth number of that machine's row in `world-seats` (`[v, driver, passenger, hand]`); refused with `{type:'world-hold-denied', v}`. While you hold it, nobody can take a chair in it, and your `world-vehicle` rows are its transform. Freed like a chair: on letting go, a level change, leaving the world and a dropped socket
- `{type:'world-vehicle', v, x, y, z, yaw, pitch, roll}`. The driver's transform, same rate and same rate limiter as `world-move`. **Accepted only from the socket holding seat 0 of that machine** (or, for an empty one, its `hand`), which is the entirety of the server's opinion about vehicle physics. Everyone else's client plays it back two ticks late and interpolates, exactly like a walking body
- `{type:'world-bring', to}` (`to` a player id or `'all'`) → `{type:'world-bring', from, x, y, z}` to each player brought. Admin only; anyone else is dropped in silence. Only players on the admin's level are brought; the server spreads them in a ring behind the admin (`x, y, z` is where to stand, `y` the feet) and each client moves itself. Shares the shove's rate limit; a malformed `to` is a strike
- `{type:'world-shove', to, vx, vy, vz}` → `{type:'world-shove', from, vx, vy, vz}` to `to` alone. One walker bumped into another: a velocity the victim's own client applies to itself as a stumble or a flop (`src/game/net/shove.ts`), because nobody moves anybody else's body. Relayed only when the two last reported poses are within `WORLD_SHOVE_REACH` (12 units, lag included) in the same level, neither is seated in a machine or flying, and inside the rate limit (12 per 3 s); clamped to `WORLD_SHOVE_MAX` (24 u/s) and rounded. Everything else is dropped in silence; a non-numeric one is a strike
- `{type:'world-chat', text}` → `{type:'world-chat', id, name, admin, registered, text, at}` to everyone in the world. Not stored: this is shouting across a field, not a room with history
- `{type:'world-signal', to, data}` → `{type:'world-signal', from, data}`. The WebRTC offer/answer/ICE relay for proximity voice, forwarded verbatim between two peers in the same level. **No audio ever passes through this process**; peers talk browser to browser and the server only introduces them. A signal aimed at someone who just left or stepped through a seam is dropped in silence, because that race is one the caller already recovers from
- `world-exit {id}` on departure; a socket closing leaves the world as well as its chat room and any duel

### World rooms

The world is not one place any more: it is one place **per room**. `room` on
`world-join` is absent or `'public'` (the shared world, exactly as it always
was) or a code of 4-12 letters and digits, compared upper-case. Only the people
in a room see each other, chat, hear each other's voice handshake, share props,
blocks, damage, portals, weapons fire, and sit in the same four vehicles.

- `{type:'world-join', level, room:'AMBER7', create?:true}`: joins that room if it exists; with `create:true` makes it if it does not (creation is limited to 3 per socket per minute and 12 per address per 10 minutes, answered `error/rate`); without `create` an unknown code is `error/room_unknown` (unknown-code attempts are limited to 10 per address per minute, then `error/rate`, so a code is as private as it is hard to guess). A malformed code is a strike. `error/room_full` (private rooms hold `WORLD_ROOM_MAX_PLAYERS`, public holds `WORLD_MAX_PLAYERS`) and `error/room_limit` (`WORLD_MAX_ROOMS` alive) round it out. A refused join leaves the socket free to join again.
- `world-welcome.room` is always present: `'public'` or the code. To switch rooms a client sends `world-leave` and joins again (same socket, in order); everything else keeps its meaning, and `level` on the wire is always the plain level id.
- A private room forgets itself `WORLD_ROOM_GRACE_MS` after its last player leaves, with all of its props, ruins, blocks, portals and seat table. Inside that grace a dropped connection rejoins its own room as it was. Codes are minted by the client (six characters of an alphabet without lookalikes, ~887M codes), so the invite link exists before the socket does; the server only validates.

The isolation is structural, not a filter: `server/src/worldRooms.js` owns the
rooms, and `buildRoom` in `index.js` gives each one its **own** `players` map
and its own copy of every module (props, effects, damage, blocks, weapons, the
fleet). Each module already scoped itself by filtering `players` on
`ws.world.level`, so handing it a smaller map is the whole of the isolation and
nothing in a module knows rooms exist. The world tick, chat, signalling, shove,
grab, bring, look and name broadcasts are all per room (`worldBroadcast(room,
...)`, `room.players.get`). **A new world module must be created inside
`buildRoom` and dispatched through `roomOf(ws)`**, or it is global.

### Sandbox props

The relay keeps an in-memory registry per level, bounded to 150 props per
spawner across levels, 2,000 per level and 8,000 per process. There is no
persistence across server restarts. Catalogue kinds are allowlisted in
`src/props.js`; scale is clamped to 0.2..4 and mass to 0.05..20,000.
Kinds define colour, atlas material and collision shape on both clients.
The WebSocket frame ceiling is 256 KiB to accommodate batched handoffs;
individual chat, signalling and identity limits still apply.

Every message below includes `level`. Requests for a different level are
ignored. `id` is server assigned; `nonce` is a positive client-local spawn
or constraint id and is only used to match the acknowledgement. `epoch`
changes on every authority grant. Mutations are limited to 200/s per socket,
movement and handoff batches to 30/s each, and hits and blasts to 20/s each.
These are ceilings, not target send rates: clients batch motion at 15 Hz.

A pose row is `[id,epoch,x,y,z,qx,qy,qz,qw,flags]`. Positions are integer
centimetres, quaternions integer ten-thousandths, normalized by the server.
Flags: 1 frozen, 2 sleeping or parked, 4 teleport (snap rather than interpolate).
Spawn and handoff rows append `[vx,vy,vz,wx,wy,wz]`, scaled by 100. Ordinary
motion omits velocities. A final sleeping pose is sent once; unchanged props
produce no traffic. Other clients interpolate two ticks behind, never
extrapolate, and keep the Rapier body kinematic.

A prop record is `{id,owner,name,authority,epoch,kind,scale,mass,pose,lock,part,life,transfer?}`.
`owner` is the spawner's world-session id, separate from authority. `name` is
retained for admin cleanup after the spawner leaves. `lock` is null, `hand`,
`seat` or `keys`. `part` is null or `[keyPair,flip,targetHeight,fire]`;
`life` is null or `[health,fuseSeconds,detonationSeconds,initialFuseSeconds]`.
A pending `transfer` is `{to,lock,waiting}`, where `waiting` is the previous
authority until its acknowledgement arrives.

- C to S `world-prop-spawn {nonce,kind,scale,mass?,pose}`. The server assigns
  owner and initial authority from the socket, then sends everyone
  `world-prop-spawn {nonce,prop}`. A pending local body is kinematic until
  accepted. Arbitrary meshes, materials, hulls and data bags are not accepted.
- S to C `world-prop-snapshot {props,joints}` follows `world-welcome` and every
  `world-level`. It contains the complete current level, including sleeping
  props, original local constraint frames, part settings and fuse state.
- C to S and S to C `world-prop-move {rows}`. The server accepts only rows
  matching the sender's authority and epoch, coalesces dirty rows, then
  broadcasts one batch per changed level per world tick. No idle snapshots.
- C to S `world-prop-claim {id,reason,source?}`. Reasons: `hand`, `seat`,
  `keys`, `collision`, `release`. Hands and seats require reach (90 units,
  including lag); seats require a seat kind. Keys require the part's owner.
  Collision requires a moving, unfrozen source owned and simulated by the
  requester within 24 units of the target. Existing hand/seat/key locks
  cannot be stolen. Release clears the lock but retains the thrower's physics.
- S to C `world-prop-state {props}` announces claims and metadata. A claim
  covers the entire graph connected by welds, axes, ropes or no-collides.
  On transfer the server sets authority to zero and asks the previous
  simulator to stop through `transfer.waiting`. C to S `world-prop-ack {rows}`
  returns final poses and velocities in one batch. Only after every previous
  simulator acknowledges does the server grant the new epoch. Stale motion
  is rejected. An unresponsive simulator leaves a transfer frozen until its
  acknowledgement or disconnection, never with two active simulators.
- C to S `world-prop-meta {id,epoch,part,life}` updates part controls and
  health/fuses from the authority. Only the owner can change key bindings
  and flip; a driver can update motion-related part state. The result is a
  `world-prop-state`. Fuse countdowns are quantized to fifths of a second.
- C to S `world-prop-joint {id,b,kind,frames,nonce}` joins two props owned and
  simulated by the sender. `kind` is `weld`, `axis`, `rope`, or `nocollide`.
  `frames` is 17 numbers: anchor A (3), anchor B (3), relative frame B
  quaternion (4), local axis A (3), local axis B (3), rope length (1).
  S to C `world-prop-joint {joint:{id,a,b,kind,frames},nonce}` acknowledges it.
  C to S and S to C `world-prop-unjoint {id}` removes an owned constraint.
- C to S `world-prop-hit {id,amount,ignite}` requests damage or ignition on
  a nearby prop. The server clamps damage to 200 and forwards the same
  message to its authority only. That simulator decides whether it breaks.
- C to S `world-prop-break {id,epoch,how}` requires authority; `how` is
  `break` or `explode`. S to C `world-prop-break {id,how}` plays the effect,
  followed by the removal. Splinters use existing cosmetic particle pools
  on all clients, with no local colliders influencing shared bodies.
- C to S `world-prop-explosion {id?,epoch?,at:[x,y,z],power,radius}` requires
  source authority, or a free blast within 170 units of the caller (the
  console aims 150 out). Power is clamped to 0.1..10, radius to 1..60, the
  console's own range, so a peer's replay is the same blast. S to C
  `world-prop-explosion {from,at,power,radius}` plays the effect and lets each
  prop's authority apply its own impulse and damage, including chain fuses.
- C to S `world-prop-remove {id}` removes a prop the sender may use as its
  owner would (own, a friend's, shared, or protection off; see Ownership
  below). Undo uses this path. S to C `world-prop-remove {ids}` removes bodies and their
  incident constraints, also used for cleanup and breakage.
- C to S `world-prop-cleanup {target}`: `mine`, `all`, or a player name.
  Mine uses the server's ownership registry, independent of undo history.
  All requires admin or being the only player in this level. A name always
  requires admin, and matches stored spawner names case-insensitively.
- S to C `world-prop-denied {op,reason,nonce?,id?,owner?,cap?}` reports
  `admin`, `limit` (with the per-owner `cap`), `name`, `busy`, `reach`,
  `invalid`, `rate`, or `protected` (with the prop's `id` and its `owner`'s
  name). Spawn refusals remove the pending body; cleanup permission and cap
  refusals print English/Spanish messages in the console feed; `protected`
  is a quiet "that belongs to NAME" and the tool's denied buzz.

Leaving or changing levels retains props. The first remaining player in the
level becomes authority; with nobody left authority is zero and the last
pose stays parked. The first arrival takes over parked bodies. A departed
owner's props wait five minutes (an account's next socket adopts them back
by its identity; a guest's identity is its socket, so a guest's do not come
back) and are then removed, announced with an ordinary `world-prop-remove`.

### Ownership, friends, claims, votes

`src/protection.js`, `src/claims.js`, assembled per world by
`src/worldSocial.js` and consulted by `props.js` (`access`) and
`worldBlocks.js` (`claims`). Identity is the account (`u:name`) or, for a
guest, the socket (`s:n`). Everything is scoped by `ws.world.level`.

- Protection is on by default in every scope. Only the owner, the owner's
  friends, an admin, or anyone when the prop is `share`d (or a toy kind that
  starts open: ball, cone, melon, soda_can, bottle) may claim a prop for the
  hand, seat or keys, remove it, weld/rope/axis it (both ends), unweld it, or
  set its part keys. Bumping (`collision` claims), blasts and hits stay free.
  `/protect on|off` is C to S `world-social {op:'protect',on}`, accepted from
  the scope's first player (lowest world id) or an admin.
- C to S `world-prop-share {ids?,all?,on}` sets the flag on the sender's own
  props (an admin's on anyone's); a stranger's attempt is `protected`.
- Caps: 150 props per owner in a public world, 400 in a private one (the
  `isPrivate` callback), and a token bucket of 100 spawns refilling at 30 a
  second, answered `limit`/`rate`. `cleanup mine` removes the caller's
  identity's props, `all` needs an admin unless alone, a name needs an admin.
- C to S `world-social {op}`: `friend|unfriend {name}` (one-way grant, at most
  32, stored in `world_friends` for registered grantors and grantees, in
  memory for guests), `votekick {name}`, `vote {yes}`, `kick {name}` (admin),
  `mute {name,minutes?}` / `unmute {name}` (admin), `claim|unclaim {cx,cz}`.
  Rate limited at 24 per 5 seconds. S to C `world-social {protect,host,
  friends,grantedBy}` (personal, sent on any change) and
  `world-social-note {code,...}` (a code and numbers; the browser words them).
- Vote: one per scope, twenty seconds, opened by any member with at least
  three others present, needs `max(3, floor(voters/2)+1)` yes among everyone
  but the accused, and ends early when it can no longer pass. A pass is a
  ten-minute ban from the scope: S to C `world-kicked {level,until,by}` and
  the socket is removed from the world; a rejoin gets `world-kicked` again.
  Admins cannot be voted out and can `kick` (the same ban).
- Mute is timed (default 10 minutes, at most a day) and stops `world-chat`
  (`error muted`) and `world-signal` relays.
- Claims: a claim is one 16x16 block chunk column, full height, at most 4 per
  owner. S to C `world-claims {claims:[[cx,cz,owner,allowed,mine]]}` is
  personal. In `worldBlocks.js` an edit (or blast) in a claim its sender may
  not edit is dropped cell by cell, and the sender gets `world-block-refused
  {edits:[x,y,z,held]...,owner}` where `held` is the server's block there or
  -1 for the generated terrain, so the client puts it back. An owner who left
  keeps their claims five minutes.

Portals are outside this protocol. Same-level prop crossings already go
through the sandbox's transform setter and send the teleport flag, keeping
the same prop and group identity. A future portal protocol can store its
level, owner, surface and frame alongside this registry. Cross-level prop
migration would need a server-approved atomic move of a connected group
between registries, including ownership, joints and epochs.

### World damage

`src/worldDamage.js` keeps what each level has lost, as a union: for each
ruined building (its position-stable id, `cx,cz:Bhx,hz`), the fracture keys
of the pieces gone, and the ids of felled trees, cacti and lamp posts. It
holds no geometry and never interprets an id beyond its shape. Every client
reports what it has that the union lacks and receives only what is new, so
the order and number of reports do not matter and every client converges on
the same holes. Blows being watched are relayed and never stored. In memory
only: at most 256 ruined buildings per level (the oldest forgotten first),
4,096 piece keys per building and 4,096 felled props per level, and a level
nobody has been in for fifteen minutes is dropped. A client still holding a
forgotten ruin reports it again from its next snapshot.

- S to C `world-ruins {level,ruins:[[b,[keys]],...],felled:[ids]}` follows
  `world-welcome` and every `world-level`: the end state, applied without a
  sound or a body. Explosions are never replayed to a late arrival.
- C to S `world-ruin {level,b,keys}`: pieces this client has lifted. Keys are
  integers 0..2^31, at most 1,024 a message, 60 messages/s. S to C
  `world-ruin {level,b,keys}` to everyone else, with only the keys new to
  the union (nothing if none were).
- C to S `world-fell {level,id,dir:[dx,dz],speed}`, 40/s. Stored once; S to C
  the same to everyone else, `dir` normalised and `speed` clamped to 0..60
  (0, or no direction, means just take it out).
- C to S `world-damage {level,b,how,at:[x,y,z],power,radius,dir:[x,y,z],k,ram,seed}`,
  a blow a peer should replay: `how` is `impact`, `vehicle`, `command` or
  `collapse` (a blast travels as `world-prop-explosion`). Relayed within 200
  units of the sender's last pose, 60/s, with power clamped to 0..1500,
  radius 0..40, `dir` components ±200 and `k` 0..60. S to C adds `from`.

Ids must look like `cx,cz:` then a capital and digits, commas, colons or
minus signs. Keys and ids cannot be checked against the world here, so a
hand-written client could mark buildings broken; the caps bound what that
costs.

Cubeland's blocks (`worldBlocks.js`): the world is a pure function of block
coordinates on every client, so the server keeps only the last word on each
block somebody changed, per level. In memory: at most 250,000 blocks a level
(the oldest forgotten first), and a level nobody has been in for thirty
minutes is dropped.

- S to C `world-blockmap {level,edits:[x,y,z,id,...]}` follows `world-welcome`
  and every `world-level`, empty or not. A client hands back the edits it has
  that the map lacks only after this, so it never overwrites a newer block.
- C to S `world-blocks {level,edits:[x,y,z,id,...],blast}`: integers, x and z
  within ±800, y 0..95, id 0..255, at most 2,048 blocks a message, 30
  messages/s; one bad quadruple drops the message. Stored, and S to C the same
  to everyone else in the level with `from`. `blast` marks a blast's edits
  (peers throw some loose blocks of their own).


Voice needs a path between two browsers, and a minority of visitors, both ends
behind a symmetric NAT, have none that STUN can find. `TURN_URLS` + `TURN_SECRET`
add a relay for exactly those pairs; leave them unset and nothing changes, which
is the shipped default. Credentials are minted per join and expire after
`TURN_TTL_S`, using coturn's `use-auth-secret` scheme (username is the expiry,
password is its HMAC). A static credential in the frontend bundle would be a
public password for your relay's bandwidth. Any coturn-compatible provider works.
Note this is the one setting that puts audio through a server you pay for: only
the calls that cannot connect directly are relayed, but those are real bytes.

## Run locally

```sh
cd server
npm install
ADMIN_TOKEN=dev-secret npm start
```

Health check at `GET /health`, WebSocket endpoint at `/ws`. Run the smoke test with `npm test`.

## systemd unit

```ini
[Unit]
Description=AlejOS chat server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/portfolio-chat/src/index.js
WorkingDirectory=/opt/portfolio-chat
Environment=PORT=8787
Environment=ADMIN_TOKEN=change-me
Environment=ALLOWED_ORIGINS=https://aleju.dev
Environment=DB_PATH=/opt/portfolio-chat/data/chat.db
Environment=ANALYTICS_URL=libsql://your-db.turso.io
Environment=ANALYTICS_AUTH_TOKEN=change-me
Environment=ANALYTICS_SITE_HOSTS=aleju03.github.io
Restart=always
User=www-data
# Hard ceiling well above normal usage (~60MB); a runaway gets recycled.
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

## Caddy

```
chat.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## Frontend notes

The frontend needs `VITE_CHAT_URL=wss://chat.example.com/ws` at build time. Without it, the AlejOS login screen still offers Guest, the Chat Rooms app falls back to the mail composer, and analytics capture goes quiet, since `src/analytics.ts` derives its capture endpoint from the same variable (`wss://…/ws` → `https://…/peeko/capture`), so there is no second URL to configure.

To log in as admin, use the reserved username with `ADMIN_TOKEN` as the password on the AlejOS login screen. That session, and only that one, gets the **peeko** entry in the Start menu: the traffic dashboard.

### Portals and double-jump clouds

`src/worldEffects.js` owns at most one blue/orange pair per world socket.
Portals persist across level changes and are removed when their owner leaves
or disconnects. A prop's removal also closes portals anchored to it. The
server holds frames in memory, not rendered images or geometry.

- C to S `world-portal {color,portal}` places or updates colour 0 or 1;
  `portal:null` closes it. The owner is always the sending socket. A portal
  is `{serial,level,frame,ground,inset,skin,ready,site,anchor}`. `frame` is
  `[x,y,z,nx,ny,nz,ux,uy,uz]`, a position, outward normal and up vector.
  `serial` changes for a new placement. `site` is null, `moon` or `earth`.
  `anchor` is null or `{prop,frame}`, using a shared prop id and a frame in
  that body's coordinates. House surfaces publish their moving world frame.
- S to C `world-portal {level,owner,portals:[blue,orange]}` updates one pair.
  Only clients whose level touches the old or new pair receive it. Both
  endpoints are included so a cross-level portal has its destination frame.
  A pair no longer touching that recipient's level is sent as `[null,null]`.
- S to C `world-portals {level,pairs:[{owner,portals},...]}` is the full portal
  snapshot after joining or changing level. Hop effects are never replayed.
- S to C `world-portal-denied {color,serial}` rejects an invalid placement.
  The client closes only that attempted placement, not a newer shot.
- C to S `world-air-hop {level,seq,x,y,z}` reports the double-jump cloud at
  the player's feet. S to C adds `id`, derived from the socket, and sends to
  other players in the same level. It is not stored. Duplicate sequence
  numbers, positions more than 20 units from the last player pose, and
  more than three events per second are dropped. Clients delay the cloud
  by two ticks to match avatar playback and discard it after a level cut.

Portal requests are limited to 24/s, frames must be finite with independent
normal/up vectors, dimensions and offsets are clamped, and referenced props
must exist in that level. New ordinary placements must be within 440 units
of the player. Cross-level sky shots are restricted to the authored Moon
slab or garage-door site; existing endpoints can continue following their
surface after the owner crosses. Same-level prop anchors follow the normal
prop stream. For viewers in the other level, the server derives their world
frame from the stored prop transform and sends updates only when it changes.

### Weapons

`src/weapons.js` relays the three weapons (`src/game/sandbox/tools/weapons.ts`:
the pistol, the crossbow and the rocket launcher). Nothing is simulated
here: the shooter's own client resolves every shot and every hit, and the
server checks that each one is honest and sends it to the other players in
the shooter's level. `w` is 0 pistol, 1 crossbow, 2 rocket
(`WIRE_WEAPONS` in `src/game/net/weaponProtocol.ts`).

- C to S `world-shot {level,w,seq,o,d,len?}`: a shot fired from the eye `o`
  along the unit `d`; the pistol's carries `len`, how far its ray went, so
  everybody draws its tracer to the same point. S to C adds `id`. Dropped
  when the origin is more than 16 units from the shooter's last pose, `d`
  is not near unit length, the shooter is seated in a machine, or it is past
  10 pistol / 3 crossbow / 3 rocket shots a second.
- C to S `world-shot-hit {level,w,seq,at,d?,prop?,fr?,imp?,player?,v?}`:
  where the shooter decided shot `seq` landed. `prop` is a shared prop id,
  `fr` a stuck bolt's frame in that prop's space (`[x,y,z,qx,qy,qz,qw]`),
  `imp` the push (clamped to 2000) that the prop's authority applies.
  `player` is a player struck and `v` the velocity their own client applies
  to itself, like a `world-shove` (clamped to 24 u/s); `v` is left off when
  the victim is seated or flying, and the hit is dropped when the victim is
  not within 14 units of `at`. S to C adds `id`. Hits must land within the
  weapon's reach of the shooter (320 / 480 / 460 units) and are limited to
  14 a second. A rocket's explosion is not in here: it is the ordinary
  `world-prop-explosion`, the same message the `explode` command sends.
- C to S `world-wield {w}`: what the sender is holding, `-1` for anything
  that is not a weapon. Kept on the socket and relayed to the level as
  `{type:'world-wield',level,id,w}`; a shot also counts as holding that
  weapon. S to C `world-wields {level,wields:[[id,w],...]}` is the snapshot
  after joining or changing level, sent only when somebody holds one;
  walking into a level announces what you hold to it (and `-1` to the
  level you left).

A malformed number or array is a strike; everything else that fails a check
is dropped in silence, because shots are a stream.
