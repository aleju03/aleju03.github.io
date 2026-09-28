# Creative tools and props (paint, balloons, lamps, signs, dynamite, camera)

## What it is

Six cheap, Garry's-Mod-style toys for the sandbox, all on the existing prop
atlas material (no new shader program), all multiplayer-safe:

- **Paint**: a tool-gun mode. Twelve colours, chosen with the wheel or `[` `]`
  / `,` `.` (bindings `colorPrev`/`colorNext`) while the gun is out, shown as a
  chip on the gun's screen and by name in the hint tape. Left click paints the
  prop, right click clears. Per-instance `BatchProxy.tint`. `/paint <colour>`
  does the same from the console. One undo entry each.
- **Balloons**: catalogue prop `balloon` (Fun) plus a tool-gun mode `balloon`.
  A click on a prop ties a new balloon (current colour) above it with the
  contraption's own rope; a click on a balloon picks it up and the next click
  on a prop ties it. Right click cuts a prop's ropes. Lift is `addForce` once
  per slice on the simulator that owns the balloon, fading toward a terminal
  speed and a ceiling; it pops (breakable, synthesized pop) at a change of
  velocity of 9 u/s, on a shot, or above 330 units.
- **Lamp**: catalogue prop `lamp` (Fun). E switches it (prompt on screen). A
  lit lamp is one of the look's fake pools (never a scene light), so it only
  lights the ground at night; the bulb is the atlas's glowing `lit` cell, so
  by day it is a glowing bulb only. An off lamp draws a different geometry (a
  dead bulb).
- **Sign**: catalogue prop `sign` (Fun). E opens the console with
  `/sign <its text>` typed; enter saves. Up to 40 characters, two lines,
  upper-cased by the pixel font, Spanish accents folded onto their letter
  (except the enye and the opening marks).
- **Dynamite**: catalogue prop `dynamite` (Explosives). E lights a 5 s fuse
  (`explodes.fuse`), so does a hard knock or a pistol shot; it blinks faster as
  it burns, ticks once a second and its sparks are breakables.ts's own fuse fx.
  Power 2 (a barrel is 1), radius 21; a blast beside a barrel chains. Weldable
  like any prop.
- **Camera**: the last item of the tools column (slot 7, key 2 steps to it).
  Viewfinder overlay (React, paper style), left click takes a photo, right
  click toggles a hand-held zoom (wheel sets the level 1.5 to 6 while zoomed),
  a developing print pins itself bottom left, the last six are kept in memory.
  `P` saves the last as a PNG, `Y` copies it as an image; on the pause sheet
  the strip has buttons.

## Module map

Game (headless-safe)
- `sandbox/creative/tags.ts`: the record every peer agrees on, `[paint, flags,
  ...chars]`, the palette, the sign text filter. Import-free.
- `sandbox/creative/creative.ts`: `creativeOf(sb)`, one controller per sandbox
  (made at the end of `createSandbox`): tag apply (tint, lamp/sign geometry),
  balloon lift, tying, lamp pools, E `use`/`verb`, dynamite blink and tick.
- `sandbox/creative/kinds.ts`, `models.ts`: the four kinds and their models.
- `sandbox/creative/signs.ts`: the 24-tile text pool (below), the 5x7 font.
- `sandbox/creative/sfx.ts`: the sounds; `commands.ts`: `/sign`, `/paint`.
- `sandbox/tools/camera.ts`: the camera tool (requests, zoom ease).
- Edited: `art.ts` (`repaintCell`), `kinds.ts` (`explodes.fuse`),
  `breakables.ts` (uses it; rubber debris), `impactSounds.ts` (rubber break =
  pop), `catalogue.ts` ('fun' category), `sandbox.ts` (imports; exports
  `creativeOf`), `toolgun.ts`/`toolgunText.ts` (paint + balloon modes,
  `toolgunSwatch`), `toolbelt.ts` (wheel to the palette, camera slot),
  `slots.ts`, `viewmodel.ts` (screen swatch), `bindings.ts`.
- Net: `net/propProtocol.ts` (`tag`, `world-prop-tag`), `net/remoteProps.ts`.

React
- `components/os/photoStore.ts` (photographs in memory, capture/save/copy) and
  `PhotoCamera.tsx` (viewfinder, flash, print, strip). `ToolSwitcher.tsx` has
  the camera doodle. CrtScene has the wiring (search `creative`, `photo`).
- i18n: `sandbox.photo.*`, `sandbox.hud.camera`, `belt.names.camera`.

Server
- `server/src/props.js`: kinds allowlist, `cleanTag`, `world-prop-tag`.
  `server/src/index.js`: one `case 'world-prop-tag'` line beside the other
  prop messages. `server/README.md` documents the message.

## Rules that bite

- **Text on a sign rides the atlas, not a material.** Batches are keyed by
  geometry (batch.ts), so a sign's text is *which geometry its proxy draws*:
  one board geometry per pre-declared atlas cell (`sign_0..23`, 128x40
  texels), the tile painted at runtime with `art.ts`'s `repaintCell` (one
  cell of the colour layer, then the same texture re-uploaded). Same text
  shares a tile; past 24 different texts on screen the extras show the blank
  board. Tiles are per page: only the text travels. `cell()` throws after the
  atlas packs, so `signs.ts` must be imported before the first material -
  `sandbox.ts` imports `creative.ts` first thing.
- **The tag is the only shared state**, and it is not the physics owner's to
  give: anyone within 90 units may set it (`world-prop-tag`), the server
  validates and normalises it (`cleanTag`, mirrored from `tags.ts`; keep the
  allowed characters in step), stores it on the prop and announces the prop.
  The client sends whenever `data.tag` differs from what it last agreed
  (`Body.tagSent`) and adopts the server's only when it has no unsent edit, so
  a quick second edit is not overwritten by the echo of the first.
- **Lamps are pools, never lights.** `creative.lampPools()` feeds the scene's
  `gatherLamps` (up to 4 nearest lit lamps, ahead of the street's). The scene
  re-asks at once when `lampVersion` changes. A lamp in motion is a new lamp
  to the fader every re-ask (matched by position), so it fades rather than
  tracks; fine for a lamp on a physgun.
- **Paint tint is multiplicative** and scaled by 1.7 for anything that is not
  white to begin with (only the balloon is) so a paint survives a brown crate.
  It shares `proxy.tint` with nothing else; the dynamite's burn-down blink sets
  it while lit and `apply()` puts the paint back.
- **A balloon's lift is a drag law**, `LIFT * (1 - vy/22)` fading out toward
  y 230..300, so more balloons are faster and none ever leaves at a rocket's
  speed. One lifts a small crate, three a big one (measure `creative`).
  Only the simulator applies it; ropes hand a whole group over together.
- **The photograph is taken in the render's own task.** The WebGL canvas has no
  `preserveDrawingBuffer`, so `photoStore.capture` copies it with `drawImage`
  straight after `look.render` (CrtScene's `render()`), then encodes at leisure.
  The HUD is DOM above the canvas and is not in it; the gun is hidden with the
  camera in hand.
- The tool column now has four items; anything that indexed `SLOTS` by number
  must use `slots.ts` (the camera is slot 7 to keep the others' numbers).

## Wire

`world-prop-tag {id, tag}` (client to server) and a `tag` field on every prop
of a snapshot / spawn / `world-prop-state`. Errors `world-prop-denied` with
`invalid` / `reach`. See `server/README.md`. **Merging with rooms:** props.js
is already a per-room instance there; the only server edit outside it is the
`case 'world-prop-tag':` line, which belongs beside the others in the
`roomOf(ws)?.props.handle` dispatch.

## Verify

- `npm run measure -- creative` (Node, no browser): tag filter, the sign tile
  pool, balloons lifting (table of crates and balloon counts), popping,
  dynamite's fuse and chain, and two clients plus a late joiner agreeing on
  paint, a lamp switch and sign text through the real server registry.
- `cd server && npm test`: the prop step now covers `world-prop-tag`.
- `npm run drive -- creative`: the real game: paint with the gun and undo,
  balloons lifting a crate, a lamp's pool at night and E, a typed sign,
  dynamite's 5 s, the camera; links counted (0); new sounds' peaks.
- `node scripts/creative-sync-drive.mjs`: two Chrome processes and a private
  relay: paint, lamp state and sign text reach the second client and a late
  joiner.

## Verified, and known imperfect

- Node: `measure creative` (one balloon lifts a small crate, three a crate,
  six are faster; pop drops the load; dynamite 5.0 s, chain takes a barrel;
  paint/lamp/sign reach a second client and a late joiner), `cd server && npm
  test`, `measure prop-sync`, tsc, eslint, build all clean.
- Browser: `npm run drive -- creative` (crate painted with the gun, undo and
  `/paint`; 3 balloons lift a crate 4+ units; lamp pool on/off at night; sign
  typed via E and `/sign`, legible at 5 units; fuse 4.90 s then blast at 5.05 s
  of simulated time; camera photo 1280x800, 165 kB PNG, 200+ distinct
  colours, zoom 2.8x). `drive -- links` still 0. `creative-sync-drive.mjs`:
  two Chromes and a relay, all three tags reach the second client and a
  reloaded late joiner, drawn correctly (tint, dead-bulb geometry, text tile).
- Sound peaks (film-style offline render, bus peak, crate hit 0.19, crate
  break 0.16): pop 0.14, lamp click 0.05, paint 0.05, chalk 0.04, fuse tick
  0.08 (last one 0.14), shutter 0.08, tie squeak 0.04.
- A single skinned-rig program (`USE_SKINNING`, the wildlife or another
  player's body) sometimes links on its first draw after arrival in these
  runs. It is not from these props (no run without them was made to compare,
  but the variant is a skinned one and none of the six touches skinning), and
  the drive scripts report it apart from the props' own count.
- Headless drives run in slow motion: a lamp's pool takes about 3 s of wall
  time to fade after E; at 60 fps it is 0.6 s.
- Not done: a spot lamp; a hand-held sway on the zoom; the camera is not in
  the catalogue's Tools tab (it is carried from the start); the balloon rope
  can only be tied to props you own online (contraption rule).
- Merge: CrtScene edits are all small and marked (`creative`/`photo`/`camera`
  words): imports, `cameraOut` state, `photoWant`, lamp pools in
  `gatherLamps`/`dressAir`, `workCreative` (E), the `propVerb` fallback, the
  camera block after `tools.update`, `fovBase`, the capture in `render()`, the
  overlay and tape line, and two dev hooks.
