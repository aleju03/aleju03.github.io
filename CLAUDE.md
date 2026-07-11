# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b, vite build, then copies dist/index.html to dist/404.html
npm run lint       # eslint over the whole repo
npm run preview    # serve the production build
npx tsc -b         # typecheck only
```

There is no frontend test suite; verification is typecheck + lint + build, then driving the affected flow in the dev server. The chat server has a smoke test: `cd server && npm test` (plain `node test/smoke.mjs`). `server/` runs with `npm start` and refuses to boot without `ADMIN_TOKEN` set.

`scripts/osu-chart.py` regenerates Rhythm Keys charts from osu!mania beatmaps (needs ffmpeg for non-mp3 audio).

## What lives here

Three independent packages:

- **Root** — the portfolio SPA (React 19 + TypeScript + Vite + Tailwind v4 + Three.js). Deployed to GitHub Pages by `.github/workflows/deploy.yml` on push to main; `VITE_CHAT_URL` comes from a repo variable and, when unset, chat features degrade to email fallbacks (`.env.example`). The `404.html` copy is the SPA-route fallback for Pages.
- **`server/`** — the AlejOS chat/arcade WebSocket server (Node 22 ESM, `ws` + `better-sqlite3`, no build step). Deployed separately to a VPS; the JSON protocol is sketched in `server/README.md`. Deploy server and frontend together — the protocol has no version negotiation.
- **`npx-card/`** — the `npx aleju` terminal business card, published to npm by hand.

## Architecture

### Routing and versions

There is no router library. `App.tsx`'s `VersionRouter` reads `location.pathname` + pushState, re-syncing on `popstate` and the custom `NAVIGATE_EVENT`. The site ships two renderings of the same content: **full** (interactive playground, the default) and **simple** (quiet résumé, also reached via `/projects/<slug>` deep links). Initial pick: `?v=` param → localStorage → full. `/alejOS` always boots the full site straight into the OS. `src/version.ts` documents the recipe for adding a version (id + `versions.<id>` copy in both languages + a branch in VersionRouter).

Far-apart components talk through window-level custom events declared in `src/events.ts` (open palette/terminal/chooser, boot the OS, OS scene ready) — no prop drilling, no global store. Overlay/scroll-lock bookkeeping is `src/overlay.ts`; theme (wipe transition) is `src/theme.ts`; en/es strings live in the dictionaries in `src/i18n.tsx` — every user-facing string needs both.

### The full site's layer cake

Everything heavy is lazy and event-triggered, and Three.js is deliberately isolated behind those lazy chunks (see `chunkSizeWarningLimit` note in `vite.config.ts`):

1. `FullPortfolio` — the page itself. Hero name is `BlockName` (draggable 3D letter blocks + a WASD-flyable paper plane sharing one canvas); `Terminal` mounts on Ctrl+`.
2. `AlejOS` (`src/components/os/`) — the portfolio as an early-2000s desktop, booted from the palette, the terminal, the paper plane being swallowed, or visiting `/alejOS`. The desktop is a virtual filesystem (`fs.ts`); apps register in `apps.tsx`/`appWindows.tsx`; `osYear.ts`, `wallpapers.ts` and `sounds.ts` are small subscribable stores. Login/chat/arcade talk to `server/` over one WebSocket.
3. `warp.ts` — the 2D-canvas wormhole between the page and the OS. It opens on the hero wreck's glass (position provided by `BlockName` via `provideWarpOrigin`) and holds until the far side announces its first frame on `OS_SCENE_READY_EVENT`.
4. `CrtScene.tsx` — the presentation shell of the 3D world: renderer, screen glass, camera cinematics, light rig, HUD. The live AlejOS DOM stays interactive on the CRT via a CSS3D renderer sharing the WebGL camera; the glass mesh punches a hole through the canvas with a no-blending near-transparent material. While the camera is parked on the screen **nothing 3D renders at all**. Its `walkTick` is a thin per-frame conductor over the game runtime.
5. `src/game/` — the React-free game runtime (see `src/game/README.md` for the map and the how-to-add-things guide). Input, FPS movement + collision, the Level system (the house/yard 'overworld' and the 'backrooms' easter egg, plus the noclip cut between them), the world builders (`levels/houseWorld.ts`, `levels/outsideWorld.ts`, `levels/backrooms.ts`), the player body, and the deterministic-procgen core (`core/rand.ts`, `core/textures.ts`). This is the long-term home of the open-world game the easter egg is growing into; new game systems go here, never inside React components.

### Data is the single source of truth

`src/data/projects.ts` / `experience.ts` / `skills.ts` drive the React pages **and** `/llms.txt`, which a Vite plugin in `vite.config.ts` generates from the same modules so the plain-text rendering can't go stale. Content edits go in the data modules, not components.

## Conventions that matter

- **Nothing shipped, nothing copyrighted**: sounds are synthesized with WebAudio (`sounds.ts`, `game/levels/backrooms.ts`), textures are drawn onto canvases at runtime (`canvasTexture` in `src/game/core/textures.ts`). Keep new assets procedural. The GLB models in `public/os/models/` are CC assets — additions must be credited in its `LICENSE.md`.
- **3D performance idioms** (the target is a cold iGPU): shadow maps are hand-baked (`shadow.autoUpdate = false`, flagged with `needsUpdate` only near a moving caster, staggered one light per frame); static scene graphs get `matrixAutoUpdate = false` after one `updateMatrixWorld(true)` — anything that must keep moving opts out via `userData.dynamic`; geometry is merged/instanced per chunk; models stream in behind the intro rather than blocking it. Follow these patterns when touching the scene or the frame loop pays for it.
- **Module-header prose comments**: nearly every nontrivial module opens with a paragraph explaining what it owns and why it's shaped that way (see `game/levels/houseWorld.ts`, `warp.ts`, `CrtScene.tsx`). Keep them accurate when changing behavior, and write one for any new module.
- Walk-mode collision is a flat `THREE.Box3[]` checked on x/z only (`game/physics/collision.ts`) — solids must register a box or the player walks through them (and the backrooms entrance works by deliberately not registering one). Each level owns its CollisionSet; new areas implement the `Level` contract in `game/levels/types.ts`.
- **The game runtime stays React-free and renderer-optional**: `src/game/` must keep running headless (the multiplayer plan is this sim in Node). React components render and orchestrate; they don't own game state.
