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
                     addBoxFrom()/padXZ()/noStand() — height-aware solids, plus
                     the oriented `hull` the vehicles carry
  collisionDebug.ts  F9 — outline every solid the live level is testing
                     against. Green box, amber noStand, red hull-as-profile
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
  types.ts           the Level contract (collision, spawn, seams, ground, water)
  levelSystem.ts     createLevelSystem() — which level is live + the noclip cut
  homeLevels.ts      the two shipped levels: 'overworld' and 'backrooms'
  houseWorld.ts      procedural house + yard; owns the property line inward
  outsideWorld.ts    the seam between sky.ts and world/; what the scene talks to
  sky.ts             domes, sun/moon, day cycle; returns per-frame light targets
  backrooms.ts       level 0 — deterministic chunk-streamed easter egg
  backroomsProps.ts  the furniture left in it, one merged draw per chunk
  deskRoom.ts        the desk corner props + the shared house materials
world/               the endless outdoors — see "The open world" below
net/                 the shared walk — see "Multiplayer" below
  protocol.ts        the wire format, and the spec server/src/index.js
                     implements by hand. Pose bits, snapshot tuples
  remotePlayers.ts   createRemoteWorld() — the roster, the snapshot buffer,
                     and the interpolation that plays it back a beat late
  avatars.ts         createRemoteAvatars() — one buildPlayerBody() per
                     player, plus the name plate, speaker badge and chat
                     bubble that ride over each head
  spawn.ts           scatterSpawn() — the sunflower offset that keeps two
                     simultaneous arrivals out of each other's ribcage
vehicles/            three driveable machines — see "The fleet" below
props/
  paperPlane.ts      the landed dart souvenir
```

## The fleet

Three machines, one per medium, because the world has a sea on it and
mountains behind it and walking reaches neither in any reasonable time.

```
vehicles/
  types.ts        the Vehicle contract: DriveEnv in, DriveStep out, plus the
                  camera rules (DriveView) and the hull the registry hangs on
                  a collision Solid
  parts.ts        the modelling kit. loft() over rings from ringSuper(), a
                  superellipse whose exponent covers everything from an
                  ellipse (a fuselage) through a rounded rectangle (a car's
                  lower body) to a concave V (a planing hull); revolve(),
                  tube() with a parallel-transported frame, blade(), slab();
                  createPartBuilder() with both() for x-symmetry, merging one
                  mesh per material slot
  materials.ts    clearcoat paint, tinted glazing, chrome, rubber with a
                  painted tread, lamps — and the painted equirect env map
                  they reflect, repainted off the sky's own numbers
  chassis.ts      what they share: the support probe, the oriented-footprint
                  sweep against the CollisionSet, the per-surface grip table
  car.ts          land: a compact coupé. Four suspension raycasts driving
                  real pitch and roll, five gears, a slip model, a handbrake
  boat.ts         water: an open runabout. A V-bottom hull with a hard chine,
                  buoyancy on the drawn swell, and a planing transition
  heli.ts         air: a light two-seat piston helicopter. Thrust along the
                  rotor disc normal, coordinated turns on two keys, auto-hover
  driveCam.ts     the boom that follows the heading rather than the mouse,
                  leans on the drift, and stretches with speed
  sfx.ts          the runtime's first live audio graphs: engine, outboard and
                  blade slap, all torn down explicitly
  effects.ts      one pooled Points system for dust, spray, wake and downwash
  registry.ts     the fleet: home spots, collision bookkeeping, enter/exit,
                  the fixed-slice substep, recall, and what the HUD reads
```

### Rules that hold it together

- **The fleet is session state, not world state.** Everything in `world/` is a
  pure function of coordinates; these three transforms are the first mutable
  thing in the runtime. Nothing is written into the world, nothing streams, and
  a reload puts all three back where they started. When persistence arrives,
  `registry.ts` is what serialises — which is exactly the "store the diffs, not
  the world" story in the debts below.
- **Home spots were probed, not chosen.** The car is at the kerb outside the
  house (the street's asphalt runs z −14.4..−8.0), the helicopter one block
  north on the largest clear disc in the neighbourhood (11.3 units — which is
  what sized its 7.6-unit rotor), and the boat 2.4 km west-north-west, because
  the nearest water deeper than a puddle is 1.8 km away. Move one and re-probe.
- **A vehicle must never see its own collision box.** `supportY` has no notion
  of an owner, so a car that could find its own box would put its own roof
  under its wheels and climb itself. The registry empties the box before every
  tick and re-fits it after.
- **What the walker hits is the `hull`, not the box.** These are the only
  solids in the game that rotate, and an AABB around a rotated one is mostly
  air: a 9.4-unit car parked at 45° has a 9.5-unit-wide box, so you met it two
  units off the paint, and the helicopter's box was an 18 x 3.4 rectangle
  around a cabin with a stick coming out of the back. So each machine declares
  a `hull` — stations fore to aft carrying the half-width and the standable
  height there (`collision.ts`) — and the box is demoted to that hull's bounds,
  i.e. a broad phase. Every table is `.map()`ped off the same `SECTIONS` the
  body is lofted from, so a shape change moves the collision with it; author
  new ones the same way rather than by measuring the model. Deliberately not
  in any hull: the helicopter's skids (a profile has no hole in the middle, so
  including them would wall off the space *between* them) and its tail rotor
  (hung to port, and a symmetric profile wide enough for it would put the same
  1.15 of nothing to starboard).
- **Integrate in fixed slices.** The walk loop's dt is clamped to 50 ms, and
  50 ms of explicit Euler through a spring stiff enough to hold a car up is not
  a suspension. `registry.ts` substeps at 1/120, which also makes the machines
  feel the same at 30 Hz and 144 Hz.
- **`noStand` boxes are walls, not floors**, and every outdoor solid is one. So
  nothing here can drive or land on a roof, a wall or a canopy — only on
  terrain. The helicopter's rotor disc is also deliberately not collided: at 15
  units across against coarse AABBs it would be unflyable in a town.
- **Winding is not a convention, it is a bug waiting to happen.** `loft()` and
  `tube()` originally wound their side triangles inward while their caps were
  correct, which against a FrontSide material renders two solid end caps with
  an invisible shell between them — and reads as "the model failed to load"
  rather than as a winding error. Test new primitives with signed volume
  (`Σ a·(b×c)/6` over the index triples): a closed outward-wound mesh is
  positive.

### How to add a vehicle

Write one module exporting `build*(opts: { mats: VehicleMaterials }): Vehicle`,
build the model through `createPartBuilder`, and register it in `registry.ts`'s
fleet array with a home spot. The camera, the sound, the dust, the collision
box, the prompts, the substep and the HUD all come from the contract.

## The open world

Everything past the property line is generated from coordinates alone. There
is no edge: `src/game/world/` streams 64-unit chunks around the player forever,
and the only hand-authored thing out there is the house, which the generator
treats as a rectangular hole (`grid.ts`'s `RESERVED`).

```
world/
  noise.ts        hash2/value noise/fbm/ridged/warp/site grid. Hashed by
                  POSITION, not streamed like core/rand.ts — a stream's value
                  depends on how many were drawn before it, and out here the
                  draw order is whatever the player's feet decided
  grid.ts         CHUNK/GRID/offsets. Chunk (0,0) is the block the house
                  stands in, which is why roads land on chunk borders and the
                  street in front of the property lands exactly where the
                  hand-made one used to (z = -11.2)
  land.ts         the raw planet: continents, erosion, ranges, rivers, basins,
                  latitude temperature + moisture. WORLD_X/Z and CLIMATE_X/Z
                  slide the landmass and the isotherms under the origin
                  independently — that is how the house ended up on temperate
                  forest with a coast a walk away
  biomes.ts       the Whittaker table: 12 biomes, their tints, palettes and
                  scatter densities
  terrain.ts      land + settlement grading + the house pad -> the finished
                  ground. terrainY() reproduces the drawn mesh exactly
  settlements.ts  town sites, districts (downtown/midrise/suburb), the street
                  grid, and the roads that run out into the country
  props.ts        tree/cactus/rock kits, VARIANTS (6) shapes each, stamped
                  not instanced. Trunks are grown by wood(): a tube swept
                  along a wandering spine that flares into the ground and
                  forks into limbs, handing back the tips the crown then
                  hangs on. Canopies are painterly alpha cards over those
                  tips — normals bent to the lobe sphere (up, for a flat
                  parasol), a baked dark-underside-to-lit-crown ramp, one
                  runtime-painted leaf texture (treeMesh.ts) shared by every
                  biome
  buildings.ts    houses, walk-ups, towers, and enterable shopfronts
  surface.ts      the procedural surface pass: one aSurf float per stamp
                  picks brick, shingle, paving, bark... computed in the
                  fragment shader from world position, because merged
                  geometry has no UVs to tile a texture across
  chunk.ts        one block: ground, water, streets, buildings, scatter
  streamer.ts     the ring, the build budget, the collision shelf
  grass.ts        the grass, as two scrolling lattices: a dense near field
                  whose blades actually touch (which is the whole difference
                  between turf and scattered tufts) and a sparse far one
                  behind it, where only a blade's colour survives the
                  distance. Both tiers spend the same triangles the single
                  sparse field used to — it was all being spent out of range
  wind.ts         one wind, shared by everything that sways — and the one
                  onBeforeCompile the chunk material gets, so surface.ts
                  rides along inside it
  birds.ts        flocks circling over wherever the player is standing: one
                  instanced draw, a vertex-shader flap, and a ring that is
                  re-cut past the fog when the walker outruns it. Session
                  state, like the fleet — nothing is written into a chunk
  quality.ts      the graphics tier: every density and budget knob, read at
                  build time. New knobs go in the record, not beside it
```

### Rules that hold it together

- **Determinism is the contract.** Every field is a pure function of (x, z).
  A chunk rebuilt an hour later from the other side of the map is identical to
  the bit, which is what lets the streamer throw chunks away instead of
  keeping a world in memory — and what the save file and the multiplayer
  server will both need.
- **The mesh and the collision must agree.** `terrainY()` walks the same
  lattice, the same diagonal and the same barycentric interpolation the
  terrain mesh is built from. Sampling the smooth analytic field instead is
  off by up to a third of a unit on a hillside, which is a visible hover.
- **Two radii, because the two costs differ.** Geometry is cheap to keep and
  expensive to build, so the loaded ring reaches 4 chunks. Collision is the
  opposite — every box is scanned three or four times a frame — so only the
  nine chunks around the player put their boxes in the live set.
- **Three draws a chunk.** Ground (its own material, for the detail map),
  opaque detail (trees, kerbs, walls — one `createMeshBuilder` soup with
  per-vertex colour), and glass (every lit window, one emissive draw the day
  cycle fades).
- **Surface comes from world position, not from UVs.** A merged soup has no
  unwrap, and nothing here ships textures, so brickwork and shingles and
  paving joints are computed per fragment from world xz/y and the face normal
  (`surface.ts`). One `aSurf` float per stamp picks the treatment; everything
  organic asks for none and pays for a branch. Analytic patterns are used in
  preference to noise because they antialias against `fwidth` instead of
  turning into moire at distance.
- **A road follows the lattice, it does not float over it.** Decks are quad
  strips sampling `terrainY` at their own corners. A flat slab crossed the
  ground somewhere in the middle of every segment on any road that runs
  lengthways up a hill, and a zigzag of terrain came up through the asphalt.
  The road corridor is also graded flat across two whole lattice cells
  (`settlements.ts`'s `CORRIDOR`), because the corridor is only really flat
  out to the last *vertex* it pins.

### How to add things

- **A biome**: add it to `BiomeId`, give it a row in `BIOMES` (two ground
  tints, a prop palette, a step surface, flora and cover tables), and place it
  in `classify()`'s temperature/moisture table. Nothing else changes. If it
  should grow grass, add a height range in `grass.ts`'s `GRASS_HEIGHT`.
- **A plant**: add a `PropKind`, write a `(v, vi) => Kit` maker in `props.ts`,
  and reference it from a biome's scatter table. Watch the scale — the eye is
  at ~3.55 units, so a canopy wants its underside clear of 4.5 or the player
  walks through the leaves. Kits opt into wind by painting parts `'leaf'`.
- **A tree specifically**: grow the skeleton with `wood(seed, cfg)` and hang
  the foliage on `crown(w, r, mid)`. Seed it off the variant index (`vi`), not
  off `v` — `v` is the size knob and two variants at different heights are
  still the same tree. Two budgets to respect. Cards are *fill* cost paid over
  the whole silhouette of a forest, so keep a kind's card count at or below
  what it was; the trunk soup is opaque and small on screen and can afford to
  grow. And the flare must stay inside `solid.r` or the player clips into the
  roots — check `r * (1 + flare * (1 - t0/0.22)^1.8)` at the station where the
  spine crosses y = 0.
- **A building**: write a kit taking `(out: BuildOut, lot: Lot)` and hook it
  into `KIND_FOR`. Respect `out.detailed` — on the outer ring it is a
  silhouette and window grids are the most expensive thing the city builds.
- **Anything that sways**: call `applySway()` on its material. Merged geometry
  bakes an `aSway` weight through `MeshBuilder`; instanced geometry with a
  unit-height local space gets it from `position.y` for free.
- **A surface treatment**: add a code to `SURF`, a branch to
  `SURFACE_FRAG_BODY`, and set `builder.surface` around the stamps that want
  it. A material outside the chunk soup (the house's own walls) uses
  `applyFixedSurface()` instead, which bakes the code in rather than reading
  an attribute.
- **Something living in the sky**: it belongs in `world/`, built and ticked
  from `outsideWorld.ts` (which is where the daylight and the terrain height
  are both in hand), and it should be *session state* — a thing that follows
  the player around, re-cut beyond the fog when it falls behind, not something
  a chunk owns. `birds.ts` is the model. Keep the per-frame CPU cost to one
  matrix per body and put the motion that reads as life (a flap, a bob, a
  bank) in the vertex shader.
- **A leaf that must be seen from below**: the chunk material is `FrontSide`,
  so emit the triangles twice, wound both ways, *after* computing normals —
  see `BLADE` in `props.ts`. Doubling the index costs no vertices; computing
  normals on the doubled set cancels them to zero and the leaf renders black.

## Multiplayer

The walk is shared. `net/` is the simulation half — headless-safe like
everything else here — and the browser half lives outside it, in
`components/os/worldNet.ts` (the socket) and `components/os/proximityVoice.ts`
(the WebRTC mesh). That line is the same one the rest of this directory keeps:
anything reaching for `import.meta.env`, a DOM WebSocket or `getUserMedia`
stays on the React side, and only plain data crosses back.

Nothing about the planet is ever sent. Every field out here is a pure function
of (x, z), so both ends can recompute the world and the only thing that cannot
be recomputed is where the other people are.

- **Playback runs in the past.** Snapshots arrive ~15 times a second and frames
  are drawn four times faster, so `remotePlayers.ts` renders two server ticks
  behind and interpolates between the pair of snapshots bracketing that moment.
  Extrapolating instead would guess, and a guess that is wrong at the instant
  someone stops walking drags their planted feet across the ground — the one
  artefact this body rig makes impossible to miss.
- **Timing is by arrival, not by the server's clock.** A visitor's machine may
  be minutes off UTC; a sync handshake would buy nothing local arrival time
  does not already give.
- **Velocity is not on the wire.** It is read back out of the interpolation, so
  the lean the body rig draws can never disagree with the feet under it.
  `landing` is synthesised the same way — a one-frame impulse sent as sampled
  state falls between packets more often than it survives.
- **A remote body is just another `buildPlayerBody()`.** The rig was written to
  be watched: `pose.show = 1` restores the cinematic layer (speed lean,
  gaze-follow) the first-person lens has to suppress. Remote bodies do not cast
  shadows — the maps here are hand-baked, and a crowd of moving casters would
  either bake stale silhouettes or force a re-bake every frame.
- **The speaker badge reads the network's `speaking` bit, not the audio.** So
  someone shouting from across the valley, too far away for proximity voice to
  carry, still visibly has something to say.
- **Spawns are one authored point, so arrivals are scattered.** The server
  hands each socket the lowest free slot; `spawn.ts` turns it into a
  golden-angle offset and tests it against the level's own collision, walking
  around and then inward until it finds floor. Slot 0 is the authored point
  untouched, so single player is unchanged to the bit.
- **Distance is done in WebAudio.** Each peer's stream lands on its own
  `PannerNode` with the listener riding the camera. Peers open at 55 units and
  drop at 80; the gap is what stops someone pacing the boundary from
  reconnecting forty times a minute.

Two things that look like mistakes and are not: the microphone is never handed
straight to a peer connection (it goes mic → gate → `MediaStreamDestination`,
and that destination's track is what every peer carries, so muting and mode
switches are a gain ramp rather than an SDP renegotiation), and every remote
stream is also sunk into a muted `<audio>` element — Chrome will not pump a
WebRTC track into WebAudio until the stream has a media-element consumer, and
without it the graph is correct and silent.

The known gap is NAT: there is only public STUN and no TURN relay, so some
visitors will fail to open a voice channel to some peers. Everything else about
them still works.

## How to add things

- **Something new on the wire**: add it to `net/protocol.ts` first — that file
  is the specification, and the `// ---- open world` section of
  `server/src/index.js` is a hand-written implementation of it. Then extend the
  dispatch switch there, and the `world-*` branch of `CrtScene`'s `onMessage`.
  The socket has no version negotiation, so server and frontend deploy
  together. Add a step to `server/test/smoke.mjs` while the shape is fresh.
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
  `needsUpdate` only near a moving caster, and finish the cold one-light-per-
  frame bake before the boot cover drops.
- Static graphs freeze matrices (`matrixAutoUpdate = false` after one
  `updateMatrixWorld(true)`); anything that keeps moving opts out via
  `userData.dynamic`.
- Merge/instance geometry per chunk. Finish model-dependent shader variants
  under the boot cover; time-box later chunk streaming per frame.
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
- ~~Height comes from box tops only.~~ Done: `Level.groundYAt(x, z)` is what
  the open world's terrain holds the player up with, and `supportY` falls back
  to it. Levels built on one plane still just set `groundY`.
- Biomes are classified, not blended. The boundary is dithered by a
  high-frequency wobble so it reads as a ragged margin rather than a contour
  line, but the ground colour still snaps between two palettes at a lattice
  vertex rather than mixing them. A real fix samples the two nearest cells and
  interpolates.
- Buildings are shells with one collision box each; only the shopfronts have
  an inside. Doors on them are painted on — the door registry above is what
  would make a suburb house openable.
- The world has no persistence. Nothing the player does out there survives a
  reload, because nothing writes: the whole thing is a pure function of
  coordinates. That is what makes the save-state story easy when it comes
  (store the diffs, not the world) and why it hasn't been started.
