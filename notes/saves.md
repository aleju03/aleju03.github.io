# Blueprints: duplicating, saving, sharing, publishing, and a persistent Cubeland

## What it is

- **Duplicator.** The tool gun has two new modes after `remove` (r steps to them): **copy** and **paste**. Copy: left click a prop and it, plus everything joined to it (welds, axles, ropes, no-collides, so parts and seats come along), becomes a *blueprint* in the clipboard; right click copies just that prop. Paste: the clipboard hangs on the crosshair as a blue ghost (red when it would not fit under the prop cap); the wheel turns it 15 degrees a notch (shift: 45), E a quarter turn; left click places it as ONE undo entry; right click forgets it. The gun's little screen reads `PASTE / 12 PROPS`. Console: `/copy [radius]` (the machine you look at, or every prop within radius), `/paste`.
- **Slots and share codes.** Blueprints are kept locally in named slots (max 50) with a pixel thumbnail. `/save NAME` (the clipboard, or the machine you look at), `/load NAME` (takes it into the clipboard and sets it down at the crosshair), `/unsave NAME`, `/builds` (lists and opens the book), `/publish NAME`. A **share code** is `BP1.` + base64url(zlib-deflate(JSON)), a few hundred characters for a car.
- **The builds book.** The catalogue (Q) has a last index tab, **builds**, which swaps the plates for two pages (`components/os/BuildsPanel.tsx`): left, your slots (set down / take / code / publish / delete) and the pencilled save line naming whatever the tool gun copied; right, the share field (a slot's code appears in it, or paste a code and press import, copy code) and the public gallery (newest / most spawned, ten a page; set down, save, delete for the author or the admin). `/builds` opens it too. Chosen over a new key because B is the emote wheel and the catalogue already owns "things you can bring into the world"; text fields pin the catalogue open exactly as the find line does.
- **Published builds (server).** Accounts publish a slot; anyone (guests included) browses, previews the thumbnail, pulls it into their slots or sets it down. REST, not the socket: `server/README.md` "Published builds".
- **Persistent Cubeland.** The public room's block edits are written to SQLite (`world_blocks`) and reloaded at boot. `server/README.md` "Persisted Cubeland edits".

## Module map

Runtime (React-free, all under `src/game/sandbox/blueprint/`)
- `blueprint.ts`: the `Blueprint` type; `capture(sb, ids)` (poses relative to an anchor = centre of the bounds on the ground plane, y = the lowest point; joints in the contraption's own local-frame format, so nothing is re-derived); `place(sb, bp, {at, yaw})` (plain `sb.spawn` + `contraption.add(type, a, b, {frames})`, one `historyOf(sb).record`); `connectedTo`, `propsWithin`, `roomFor`, `setPropCap`, limits (`MAX_PROPS` 300, `MAX_JOINTS` 1200, `DROP` 0.12).
- `code.ts`: `encodeBlueprint` / `decodeBlueprint` (CompressionStream 'deflate' + base64url; code capped at 96 K chars, inflate capped at 1 MB and abandoned mid-stream, strict field-by-field validation with `BlueprintError.code`, unknown kinds rejected, numbers clamped to the server's ranges, quaternions renormalised), `fromJson`, `cleanName`.
- `dupe.ts`: the copy/paste state machine the tool gun drives (yaw, ghost lifecycle, the wheel), bilingual reason texts.
- `ghost.ts`: the preview (see rules). `thumb.ts`: the pixel thumbnail (private WebGL context, like `thumbnails.ts`). `clipboard.ts`: the clipboard store, `buildNotices` (lines for the feed), and the `BuildsBackend` seam. `actions.ts`: `pasteAtCrosshair`. `commands.ts`: the console commands (imported by `sandbox.ts` so they register with the sandbox chunk).
- `tools/toolgun.ts`, `toolgunText.ts`, `toolbelt.ts`: two modes, `wantsWheel` (the belt lets the wheel through while a ghost is up), screen/hint text.

React side (`src/components/os/`)
- `buildsStore.ts`: IndexedDB -> localStorage -> memory slots (every access in try/catch, pages work with storage blocked), REST gallery client (URL derived from `VITE_CHAT_URL`; absent server = gallery says so), publish, the seams CrtScene binds. `BuildsPanel.tsx`: the two pages. `SpawnMenu.tsx`: the `*builds` tab. `CrtScene.tsx`: about 30 lines at the `spawnRef` site (bind paste/open, feed the duplicator's notices; dev hooks `__builds`, `__blueprints()`, `__blueprintClipboard()`).
- i18n: `sandbox.builds.*` in both languages; command output through `msg(en, es)`.

Server (`server/`)
- `src/builds.js` (+ `index.js`: table via the module, route in the route list, `BUILDS_PUBLISH_MAX`); `src/worldPersist.js` (+ `index.js`: `worldPersist` constructed right after the schema, `flushSync()` before `db.close()` in `shutdown`).
- Tests: `test/builds.mjs` (unit checks of the code/thumb validators, then the whole flow against the real server as smoke step 16c/"19", and an in-process rate-limit test), `test/persist.mjs` (smoke step "0b").

## Rules that bite

- **The ghost is tinted, not translucent, on purpose.** A transparent prop material is a different shader program (three keys programs on `opaque`) and would link the first time someone raised the duplicator. The ghost is `BatchProxy` children of `sb.root` with `tint` past 1 (blue; red when over the cap), i.e. the existing instanced program: `npm run drive -- blueprints` counts 0 links of ours (a skinned program that appears now and then is the fauna's first draw, filtered and reported separately).
- **Paste goes through the ordinary spawn path**, so the server's per-owner cap, spawn bucket and (when merged) protection ownership apply unchanged. The client pre-checks `roomFor` (150 by default; call `setPropCap(n)` if the welcome/room says otherwise, e.g. 400 in a private room once protection is merged) and refuses the whole paste with "room for N" instead of arriving in half. Over `MAX_PROPS` or an unknown kind refuse too.
- **Poses are the world frame at capture; the paste yaw is applied on the way out.** Joint frames are local, so a rotated paste needs nothing re-derived. Rounding: positions 1e-3, quaternions/frames 1e-4.
- **Set down 0.12 over the surface.** A big plate on uneven terrain that starts a hair inside a slope is pushed out at several u/s; falling 0.12 is gentle. Copy something at rest: a build copied mid-fall is pasted mid-fall with no velocity, and an unbalanced tower topples (this cost a day of the drive scenario).
- **Only the catalogue's kinds** (`isKnownKind`) travel, which equals the server's `PROP_KINDS` (asserted in `measure prop-sync`).
- **Server validation is a second copy of the client's**, on purpose (server is plain JS with no build): keep `builds.js:checkCode` and `code.ts:fromJson` in step. The server refuses where the client clamps.
- **The persistence wrapper never forwards `left()`** to the blocks module: its empty-level timeout would otherwise forget a persisted level from memory and the next edit would overwrite the stored world with almost nothing. An empty map is never written for the same reason.
- **Why props are not persisted.** A prop is a live simulation owned by one browser at a time (authority, epoch, kinematic hand-offs in flight); bodies are Rapier state only a client can step; every one carries an ownership record (account or socket, friends, protection, the 150 cap) that is meaningless once those sockets are gone. A restored crate would be an unowned orphan in a frozen mid-air pose. Blocks are integers over a pure function.
- The book's tab button is reachable by DOM click; the drive harness's `clickOn` mis-aims at it (it sits above the book, `scrollIntoView` shifts the frame), so the scenario clicks it through `element.click()`.

## Merge notes for the lead

1. **Wire the persistence into `buildRoom`** (my base had neither rooms nor `worldBlocks.js`, so the wiring is documented, not applied; the comment sits in `index.js` above `worldPersist`):
   ```js
   const blocks = createWorldBlocks({ players, send: worldPersist.wrapSend(send), claims: room.social.claims });
   if (room.isPublic) { room.blocks = worldPersist.attach(blocks); worldPersist.restore(blocks); }
   else room.blocks = blocks;
   ```
   `persist.mjs` already drives the real `worldBlocks.js` when present (`../src/worldBlocks.js`); I ran it against the main tree's copy: 250,000 edits -> 784 KB, boot load 144 ms, the event loop blocked ~150 ms once per 30 s at the full cap (most of it the blocks module's own key parsing in `snapshot`), a few ms for ordinary worlds.
2. `server/src/index.js`: additive edits only (import + construct `worldPersist` before the helpers; `buildGallery` before the analytics/ytSearch block; `buildGallery` in the `routes` array; `worldPersist.flushSync()` in `shutdown`). `smoke.mjs` gained steps "0b" and "19" and `BUILDS_PUBLISH_MAX: '1000'` in the child env.
3. Hot files touched, small: `CrtScene.tsx` (one block + one `let` + cleanup + dev hooks), `i18n.tsx` (`sandbox.builds` after `menu`, both languages), `SpawnMenu.tsx` (tab, two conditional page bodies), `sandbox.ts` (one import), `scripts/sandbox-drive.mjs` (`blueprints` block before `emotes`, header entry), `scripts/measure.mjs` (`blueprints` report).
4. With protection merged: pasting over someone else's claimed props is not a concern (a paste only creates); a friend's paste is the friend's own props. `setPropCap` should follow the room's cap.
5. Deploy server and frontend together (new REST route + tables are additive; old clients ignore them).

## Verify

- `npm run measure -- blueprints`: capture 8 props/7 joints from a welded car, share code 379 chars, 15 malformed codes refused (bomb, prefix, kind, counts, NaN, zero quaternion, self-joint...), numbers clamped; the car wiped, pasted rotated, pushed 19 u with the wheel-to-chassis distance unchanged (4.33 -> 4.33), one undo removes all props and joints; cap refusal leaves nothing half-spawned; a second client (real server prop registry) receives 8 props and 7 joints and one undo clears both.
- `cd server && npm test`: the gallery against the real process (guest browse; 401/400/413/403 refusals; publish; replace; pulls count once; the 20 cap; sort by spawns; author/admin delete; CORS preflight), the rate limit in-process, and the persistence restart.
- `npm run drive -- blueprints` (PROBE_PORT/PROBE_CDP): a welded tower copied with a click on the crate (3 props, 2 joints), the ghost shot (`shots/sandbox/blueprints-ghost.png`), pasted by click (+3 props, +2 welds), `/save`, cleanup, `/load` (3 props, 2 welds), a shove on the plate carries the crate, the builds book shot (`blueprints-book.png`), one Z removes it, 0 links of ours. `--baseline` counts links with the tool gun out and nothing copied.
- `npx tsc -b`, `npx eslint .`, `npm run build`: clean.

## Not done / imperfect

- No dragged **area box**: `/copy RADIUS` and the connected-graph copy cover it; a box gizmo would need a new drawn primitive.
- The ghost is opaque-tinted, not see-through (above). It does not check for overlap with existing props/solids, only the cap.
- The gallery is only reachable with a `VITE_CHAT_URL` server; the panel says so otherwise. No moderation queue beyond author/admin delete and the chat's sanitiser (there is no profanity list in chat to match).
- Slots are per browser (IndexedDB); moving machines is what share codes are for.
- `/load` and the panel's "set down" place at the crosshair unturned (as copied); only the tool gun's paste rotates.
