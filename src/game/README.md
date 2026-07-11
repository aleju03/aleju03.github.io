# src/game — the game runtime

The React-free simulation behind the AlejOS 3D world. `CrtScene.tsx` (in
`src/components/os/`) is the presentation shell — renderer, screen glass,
camera cinematics, light rig, HUD — and its `walkTick` is a thin conductor
that calls into these modules once per frame. Nothing in here imports React
or touches the DOM except `core/input.ts` (whose whole job is DOM events)
and `core/textures.ts` (canvas painting). Keep it that way: the long-term
plan is an authoritative multiplayer server running this simulation headless
in Node, so every new system should work without a renderer attached.

## Map

```
core/
  rand.ts            seeded() — deterministic RNG streams; never Math.random()
  textures.ts        canvasTexture()/makeGlowTexture() — all art is drawn at runtime
  geometry.ts        mergeGeoms() — merge/instance statics, few draw calls
  disposer.ts        createDisposer() — every texture/disposable checks in here
  input.ts           createRoamInput() — keys, mouse-look, pointer lock lifecycle
physics/
  collision.ts       CollisionSet (Box3 list + bounds), resolveXZ(), addBoxFrom()
player/
  walkController.ts  createWalkController() — the FPS movement sim (velocity,
                     gravity/jump/crouch, footstep bob, sprint fov)
  playerBody.ts      buildPlayerBody() — the code-built robot the camera drags
levels/
  types.ts           the Level contract (collision, spawn, seams, light override)
  levelSystem.ts     createLevelSystem() — which level is live + the noclip cut
  homeLevels.ts      the two shipped levels: 'overworld' and 'backrooms'
  houseWorld.ts      procedural house + yard; owns the property line inward
  outsideWorld.ts    sky, day cycle, street, city; returns per-frame light targets
  backrooms.ts       level 0 — deterministic chunk-streamed easter egg
  deskRoom.ts        the desk corner props + the shared house materials
props/
  paperPlane.ts      the landed dart souvenir
```

## How to add things

- **A new area/level**: implement `Level` (types.ts), register it in the
  array handed to `createLevelSystem`, and give an existing level a
  `seamTo()` that returns `{ to: yourId }` — plus a `spawn` in that seam
  result if arrival shouldn't land on your level's default spawn. The cut
  (freeze → blackout → swap → fade) comes for free. Solids must register in your CollisionSet or the
  player walks through them; the backrooms entrance works by deliberately
  not registering one.
- **A new world builder**: follow the existing contract — a
  `build*(opts) → Handles` function taking `{ scene, obstacles?,
  trackTexture, trackDisposable }` and returning `{ root, update(dt),
  furnish?(models) }` plus domain verbs. Write a module-header prose
  paragraph like the others.
- **A new player mechanic**: it goes in `walkController.ts` (movement) or a
  sibling module — not in CrtScene. The controller only knows keys in,
  transform out.
- **Assets**: procedural only (canvas textures, code-built geometry, WebAudio
  synthesis). GLB additions are CC assets and must be credited in
  `public/os/models/LICENSE.md`.

## Rules that keep it fast (target: a cold iGPU)

- Shadow maps are hand-baked: `shadow.autoUpdate = false`, flag
  `needsUpdate` only near a moving caster, stagger one light per frame.
- Static graphs freeze matrices (`matrixAutoUpdate = false` after one
  `updateMatrixWorld(true)`); anything that keeps moving opts out via
  `userData.dynamic`.
- Merge/instance geometry per chunk; stream heavy work behind the intro.
- Determinism is load-bearing: seed everything (`core/rand.ts`), so worlds
  regenerate identically — the future save-state and multiplayer story
  depends on it.

## Known debts (grow into these when a feature demands them)

- Collision is a linear Box3 scan, x/z only. The upgrade (spatial hash, or
  a physics lib once verticality is real) belongs inside `resolveXZ` /
  behind the CollisionSet contract.
- Interactions are bespoke (house doors, the machine prompt, backroom
  seams). At ~10 interactables, build a registry (position, radius, prompt,
  action) and make walkTick iterate it.
- `groundY` is flat per level; stairs/terrain mean a `groundYAt(x, z)` on
  the Level contract.
