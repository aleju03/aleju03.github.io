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
  sfx.ts             footstep()/landThump()/doorCreak()/doorLatch() — WebAudio
                     one-shots, per-surface voicing, headless-safe. Doors also
                     play recorded clips from public/os/sfx (synth fallback)
physics/
  collision.ts       CollisionSet (Box3 list + bounds), resolveXZ(), supportY(),
                     addBoxFrom()/padXZ()/noStand() — height-aware solids
player/
  walkController.ts  createWalkController() — the FPS movement sim (velocity,
                     gravity/jump/crouch, step-up and ledge falls over an
                     absolute feetY, footstep bob, sprint fov)
  playerBody.ts      buildPlayerBody() — the articulated robot: kinetic stance
                     (accel lean, turn bank, landing spring), world-planted
                     stepping feet solved with two-bone IK, and the ragdoll
                     fit/recovery over the same skeleton
  ragdoll.ts         createRagdoll() — verlet particles + constraints against
                     the level's floor and collision boxes
  chaseCam.ts        createChaseCam() — the third-person boom (v), collision-
                     clamped, which also frames a downed body
levels/
  types.ts           the Level contract (collision, spawn, seams, light override)
  levelSystem.ts     createLevelSystem() — which level is live + the noclip cut
  homeLevels.ts      the two shipped levels: 'overworld' and 'backrooms'
  houseWorld.ts      procedural house + yard; owns the property line inward
  outsideWorld.ts    sky, day cycle, street, city; returns per-frame light targets
  backrooms.ts       level 0 — deterministic chunk-streamed easter egg
  backroomsProps.ts  the furniture left in it, one merged draw per chunk
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
  not registering one. Give each one `noStand()` unless its box top is
  somewhere a player could plausibly stand — see the debts below.
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

- Collision is a linear Box3 scan. It is height-aware now (a box argues only
  where it overlaps the body, and `supportY` reports the tallest top under an
  x/z), but it is still one flat list walked per query — twice per walk tick
  plus once per foot. The upgrade is a spatial hash, or a physics lib, inside
  `resolveXZ`/`supportY` behind the same CollisionSet contract.
- An AABB is a coarse stand-in, so any solid whose box top is taller than the
  thing it wraps registers with `noStand()` (walls, fences, lamp poles, tree
  canopies, house eaves, wardrobes, lampshades). Miss one and the furniture
  below it becomes a ladder onto somewhere nobody should stand.
- Interactions are bespoke (house doors, the machine prompt, backroom
  seams). At ~10 interactables, build a registry (position, radius, prompt,
  action) and make walkTick iterate it.
- Height comes from box tops only. Sloped ground or real stairs would want a
  `groundYAt(x, z)` on the Level contract for `supportY` to fall back to, in
  place of today's flat per-level `groundY`.
