# Ownership, prop protection and anti-grief

## What it is

Strangers share the sandbox and Cubeland, so by default a thing belongs to
whoever made it.

- **Props.** Only the owner, the owner's friends and admins may grab a prop
  with the physgun (which is also how it is frozen or unfrozen), weld, rope or
  axis it with the tool gun, remove it, or drive its parts (keys). Everyone
  can still bump props with their body, blast them, hit them, walk on them.
  Refusals are a typed `world-prop-denied {reason:'protected', id, owner}`.
  The client also asks its mirror first, so the tools refuse without a round
  trip: the physgun and tool gun emit a `deny` event (a short flat double
  buzz, `sfx.deny`, and the beam's miss flash) and a quiet feed line "that
  belongs to NAME" (throttled to one per 1.5 s so a held trigger does not
  spam).
- **Switches.** `/protect on|off` (default ON in every scope; the scope's first
  player, or an admin, only). `/share [all]` and `/unshare [all]` open the prop
  you look at, or all of yours, to everyone. Kinds `ball cone melon soda_can
  bottle` spawn already shared (`OPEN_KINDS` in props.js).
- **Friends.** `/friend NAME`, `/unfriend NAME`, `/friends`. One-way grants
  ("NAME may use my things"), at most 32. Registered accounts persist the list
  in SQLite (`world_friends`); guests keep it for the session. Also toggles in
  the pause sheet's people page (a "friend" ring per person, and the
  protection row).
- **Cubeland claims.** `/claim`, `/unclaim`, `/claims`: one 16x16 chunk column
  (full height), at most 4 per owner. Only the owner, friends and admins can
  break, place or blast there. The client declines a local edit before making
  it (toast "that chunk belongs to NAME"), the server refuses whatever
  arrives anyway and answers `world-block-refused`, and the client reverts.
  Walking in shows "claimed by NAME" (or "your claim") once, and blue sparks
  run along the nearest claimed edge within 12 units (the existing `fx.zap`,
  so no new program). Blasts skip cells the blast's owner may not edit.
- **Griefing limits.** 150 props per owner (400 in a private room), spawn token
  bucket (burst 100, 30 a second), `cleanup` only touches your identity's
  props (`all` and names are admin), departed owners' props wait 5 minutes and
  are removed (an account's next socket adopts them back), claims of a departed
  owner likewise.
- **Votes and admin tools.** `/votekick NAME` opens a 20 s vote any member
  answers with `/yes` `/no`; passes with `max(3, floor(voters/2)+1)` yes among
  everyone but the accused (so at least four in the room), ends early when it
  cannot pass; a pass bans the player from the scope for 10 minutes. Admins:
  `/kick NAME`, `/mute NAME [minutes]`, `/unmute NAME`. A muted player cannot
  `world-chat` (error `muted`) or relay `world-signal`. Admins cannot be voted
  out or muted.

## Module map

Server (all plain ESM, bounded, rate limited)
- `server/src/protection.js`: identity (`u:name` / `s:n`), friends, the
  protection switch, mutes, kick bans, the vote. `granted`, `enabled`, `cap`
  are what `props.js` asks.
- `server/src/claims.js`: chunk claims and `check(ws, bx, bz)`.
- `server/src/worldSocial.js`: builds both over a `players` map. A factory so a
  room builds its own (see "Merging with rooms").
- `server/src/props.js`: `access` option; `may`, `refuse`, the owner key per
  prop (a WeakMap, never sent), `share`, caps, spawn bucket, orphans and
  `sweep()`.
- `server/src/worldBlocks.js`: `claims` option; refuses and corrects.
- `server/src/index.js`: `world_friends` table, `friendStore`, `worldSocial`,
  `socialOf(ws)`, join/leave/level hooks, the `world-social` and
  `world-prop-share` cases, mute checks in chat and signal, the 5 s sweep.
- Tests: `server/test/protection.mjs` (run from smoke.mjs after props): a unit
  half on fake sockets and a fake clock, a socket half on the real server.

Client
- `src/game/net/socialProtocol.ts`: the wire (ops, notice codes).
- `src/game/net/remoteSocial.ts`: the headless mirror (`may`, `claimAt`,
  `blocked`, `describe` for the bilingual notices).
- `src/game/net/remoteProps.ts`: `PropGuard` (4th argument), `mayUse`, `share`,
  `network.may/denied/share`; the joint broadcast now carries `from` so a
  friend's weld is matched to its sender, not by owner.
- `src/game/net/remoteBlocks.ts`: `world-block-refused` -> `net.revert`.
- `src/game/levels/cubeland/cubeland.ts`: `BlockNet.setClaims/revert/chunkAt`,
  `locked()` in `edit`, break, place, carve and grab; `claimCue`.
  `world.ts`: `store.forget`.
- `src/game/sandbox/socialCommands.ts`: the console commands.
- `src/game/sandbox/tools/{physgun,toolgun,toolbelt,sfx,types}.ts`: `deny`.
- `src/components/os/CrtScene.tsx`: builds the mirror, feeds it, words the
  notices in the chat rail, handles `world-kicked` (leaves the world, keeps
  the walk running alone), `host.social`, dev hook `window.__social`.
- `PauseScreen.tsx` + `i18n.tsx` (`pause.protectLabel` ... `friendHint`).

## Rules that bite

- **The client is a mirror, the server the authority.** `may` reads the last
  `world-social` state (the world ids whose owners granted me, plus the
  switch). A stale mirror only costs a refusal round trip; never trust it.
- **Owner identity is not the world id.** A prop's owner id dies with the
  socket; its `ownerKey` (account or socket) survives, which is how the same
  account on two tabs is one owner and how adoption after a rejoin works.
- **Protection off is free for all**, including remove and weld, not just
  grab. (Before this, removal and welds were owner-only in every world.)
- **Corrections need the server's value.** The server stores only deltas over
  generated terrain, so `world-block-refused` carries `-1` for "generated"
  and the client regenerates that chunk cell (`generateChunk`) and `forget`s
  its stored edit, or the catch-up list would keep offering the ghost.
- **Local fluids and falling blocks** run on every client and are declined
  by the same `edit` guard at a claim boundary; the owner's client runs them
  inside and sends the result. Water will not cross into a stranger's claim
  from a stranger's client.
- The vote counts everyone in the scope but the accused, so a room of three
  cannot vote (min three voters, one is the accused).
- Mute is per scope instance (per room with rooms), not global.

## Wire

See `server/README.md`, "Ownership, friends, claims, votes". New messages:
`world-social` (both ways), `world-social-note`, `world-claims`,
`world-kicked`, `world-block-refused`, `world-prop-share`; changed:
`world-prop-denied` (`protected`, `id`, `owner`, `cap`), `world-prop-joint`
(`from`), `NetProp.share`.

## Merging with rooms (the lead)

The rooms branch builds every world module per room in `buildRoom`. Here:
- In `buildRoom(room)`, before the props:
  `room.social = createWorldSocial({ players, send, name: displayName, eject: leaveWorld, store: friendStore, isPrivate: () => !room.isPublic })`,
  then `createPropRegistry({ ..., access: room.social.protection })` and
  `createWorldBlocks({ ..., claims: room.social.claims })`. Delete the
  file-scope `worldSocial` and make `socialOf = (ws) => ws.world.room.social`
  (in `handleWorldJoin` the room is chosen before the ban check, so use the
  room you are about to enter; in `leaveWorld` capture `const room = w.room`
  before `ws.world = null`).
- `friendStore` stays at file scope (the database's, an account's list follows
  it into every room).
- The 5 s interval must sweep every room: loop `worldRooms` calling
  `room.props.sweep()` and `room.social.claims.tick()`.
- `world-social` dispatch: `roomOf(ws)?.social...` for `claim/unclaim` ->
  `.claims.handle`, else `.protection.handle`; `world-prop-share` joins the
  `roomOf(ws)?.props.handle` list.
- Mute checks (`handleWorldChat`, `handleWorldSignal`) use the sender's room.
- The socket-half of `protection.mjs` uses level names that no other test uses.
  `server/test/smoke.mjs` `nextOf` now looks through 400 messages instead of 40
  (the per-join social messages pushed a step past 40 once ticks buffered).

## Verify

- `cd server && npm test` (step "protection": owner vs stranger vs friend vs
  admin, share, switch, caps 150/400, spawn rate, orphans and adoption,
  friend cap, vote pass/fail/timeout/min voters/admin, mute, kick, claims with
  corrections, stored friends across a reconnect).
- `npm run drive -- protection` (two Chromes and a private relay:
  `scripts/protection-drive.mjs`): a stranger's physgun denied (no hold, one
  buzz, the toast), a friend's allowed, unfriended and shared; in Cubeland a
  claim declines a stranger's dig, an unguarded dig is refused by the server
  and corrected, a friend's dig reaches the owner. Shots
  `shots/sandbox/protection-*.png`.
- `npx tsc -b`, `npx eslint .`, `npm run build`.

## Not done

- Vehicles and the world's seats are untouched (they are not props); public
  vehicles stay public.
- Voice mute only stops the WebRTC handshake relay; an already connected
  mesh keeps hearing until a reconnect.
- Claims are per scope and in memory (not in SQLite); friends are the only
  persisted piece.
- No UI to list or answer a vote except the console commands and the chat rail.
