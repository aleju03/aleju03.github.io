# src/game: the game runtime

The React-free simulation behind the AlejOS 3D world. `CrtScene.tsx` (in
`src/components/os/`) is the presentation shell (renderer, screen glass,
camera cinematics, light rig, HUD), and its `walkTick` is a thin conductor
that calls into these modules once per frame. Nothing in here imports React
or touches the DOM except `core/input.ts` (whose whole job is DOM events)
and `core/textures.ts` (canvas painting). Keep it that way: the long-term
plan is an authoritative multiplayer server running this simulation headless
in Node, so every new system should work without a renderer attached.

## Map

```
core/
  rand.ts            seeded(): deterministic RNG streams; never Math.random()
  textures.ts        canvasTexture()/makeGlowTexture(): all art is drawn at runtime
  geometry.ts        mergeGeoms(): merge/instance statics, few draw calls
  disposer.ts        createDisposer(): every texture/disposable checks in here
  input.ts           createRoamInput(): keys, mouse-look, pointer lock lifecycle
  sfx.ts             footstep()/landThump()/doorCreak()/doorLatch()/
                     propSnap(): WebAudio one-shots, per-surface voicing,
                     headless-safe. Doors also play recorded clips from
                     public/os/sfx (synth fallback)
physics/
  collision.ts       CollisionSet (Box3 list + bounds), resolveXZ(), supportY(),
                     addBoxFrom()/padXZ()/noStand(): height-aware solids, plus
                     the oriented `hull` the vehicles carry
  collisionDebug.ts  F9: outline every solid the live level is testing
                     against. Green box, amber noStand, red hull-as-profile
  tumble.ts          createTumbler(), the ragdoll with the skeleton taken
                     out: a rigid rod of two verlet particles, launched end
                     by end, for anything a vehicle knocks over
player/
  walkController.ts  createWalkController(): the FPS movement sim (velocity,
                     gravity/jump/crouch, step-up and ledge falls over an
                     absolute feetY, footstep bob, sprint fov)
  playerBody.ts      buildPlayerBody() is the character: a Fall Guys-style
                     bean. Kinetic stance (waddle, a restrained lean, turn
                     bank, squash-and-stretch landing spring), world-planted
                     stepping feet solved with two-bone IK, sprung arms,
                     jiggling head/hat tails/belly/mittens, idle fidgets,
                     the ragdoll (draped with joint limits), a muscle-driven
                     get-up, and helper bones at shoulders and hips. Also
                     the sandbox hooks: hit(), grab(), limbs, limbPos()
  bodyShape.ts       the drawing: one closed skinned surface per (headgear,
                     build), a signed distance field polygonized once and
                     shared by every body, weights from the field's parts
                     smoothed over the skin. `npm run measure -- body`
  isoSurface.ts      surfaceNets(): a field to a watertight mesh (sparse
                     sampling, Newton-projected vertices, gradient normals),
                     and the distance primitives the body is written in
  bodyMaterial.ts    the one material: palette uniform, the face, blink and
                     outfit painted from the bind position, and the first-
                     person discard, injected into a MeshStandardMaterial
  ragdoll.ts         createRagdoll(): massed verlet particles + constraints
                     against the ground and collision boxes, with kick/pin/
                     drive (impulses, grabs, muscles) for anything outside
  impacts.ts         createImpactWatch(): turns where the fleet was last frame
                     into speeds and asks whether one is running a body over
  bodyContact.ts     bodies meeting bodies: the walker against pedestrians and
                     other players as upright cylinders measured off each
                     rig's own mesh, plus both bodies' posed limbs (a
                     sprint's lean leads with the head and arms, and a knock
                     must fire when they arrive, not after they are drawn
                     inside somebody). Lean (push apart), charge, tackle,
                     stomp, trample, through one indexed `Bumpable` interface
  chaseCam.ts        createChaseCam(): the third-person boom (v), collision-
                     clamped, which also frames a downed body
  seating.ts         createSeating(): sitting on the furniture. A seat is a
                     cushion, a facing and a spot to stand up onto; the walk
                     freezes and the lens drops, and that is the whole of it
levels/
  types.ts           the Level contract (collision, spawn, seams, ground, water)
                     and what a level has: gravity, a sandbox and its ground,
                     the fleet, the crowd, the house, sky, air, footsteps
  levelSystem.ts     createLevelSystem(): which level is live + the noclip cut
  homeLevels.ts      the three shipped levels: 'overworld', 'backrooms', 'moon'
  space.ts           the way up in numbers: the planet's radius, the bands of
                     height where the ground bends, the sky thins and the
                     ground goes, noclip's speed with height, the Moon's
                     size, distance and seams. Pure, imported by the room tier
  moon.ts            the Moon's ground: craters on five scales, a lattice on
                     the world grid the walker and the sandbox both stand on,
                     a horizon that curves away, boulders; built on arrival
  houseWorld.ts      the house + yard, two storeys (walls, stairs, slab, roof,
                     doors, furniture placement); owns the property line
                     inward. The computer room is upstairs, at UP
  houseProps.ts      the family's clutter, kitbashed into two merged draws
                     (lit and glowing), the router's blink, the fridge's
                     paper, and every lamp as the look's indoor pool
  fittings.ts        buildFittings(): the furniture that works. Hinges the
                     GLBs' own door/drawer nodes, builds the interior behind
                     each one, and answers the same interact key as a door
  outsideWorld.ts    the seam between sky.ts and world/; what the scene talks to
  sky.ts             domes, sun/moon, day cycle; returns per-frame light targets
  backrooms.ts       level 0: deterministic chunk-streamed easter egg
  backroomsProps.ts  the furniture left in it, one merged draw per chunk
  deskRoom.ts        the desk corner props + the shared house materials
world/               the endless outdoors, see "The open world" below
net/                 the shared walk, see "Multiplayer" below
  protocol.ts        the wire format, and the spec server/src/index.js
                     implements by hand. Pose bits, snapshot tuples
  remotePlayers.ts   createRemoteWorld(): the roster, the snapshot buffer,
                     and the interpolation that plays it back a beat late
  remoteVehicles.ts  createRemoteFleet(): the same, for the three machines,
                     plus the seat table that says who is in which chair
  avatars.ts         createRemoteAvatars(): one buildPlayerBody() per
                     player, plus the name plate, speaker badge and chat
                     bubble that ride over each head
  shove.ts           createRemoteBumps(): other players as bodies the walker
                     cannot move, whose hard bumps go out as world-shove;
                     createShoveTaker(): the victim's own client deciding
                     stumble, flop or nothing
  grab.ts            createRemoteGrabs(): other players offered to the
                     physgun as rigs, the hold streamed as world-grab;
                     createGrabTaker(): the victim pinning its own ragdoll
                     to the stream, capped and timed out
  spawn.ts           scatterSpawn(): the sunflower offset that keeps two
                     simultaneous arrivals out of each other's ribcage
vehicles/            three driveable machines, see "The fleet" below
sandbox/             rigid-body props on Rapier, see "The sandbox" below
render/              the look: pixel art in 3D, see "The look" below
  pixelLook.ts       createPixelLook(): low-res scene target, fake lights,
                     outlines, air, grade, banded posterize, nearest upscale,
                     full-res glass holes. Every visible frame
  atmosphere.ts      the air's density and the night's lights for a moment
                     of the sky; shared by CrtScene and the harness
  grade.ts           the colour identity as OKLab arithmetic, baked to a LUT
  shaders.ts         the look's three programs (grade, blit, punch)
  texel.ts           TEXELS_PER_UNIT and texelate(): the surfaces' pixel grid
props/
  paperPlane.ts      the landed dart souvenir
```

## The fleet

Three machines, one per medium, because the world has a sea on it and high
ranges beyond the one over town, and walking reaches neither in any
reasonable time. Each seats two, because the walk is shared, and a one-seat machine
is a machine that splits a group up at the kerb.

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
                  painted tread, lamps, and the painted equirect env map
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
  thing in the runtime. Nothing is written into the world and nothing streams.
  With a server in the picture they are also the only world state it holds:
  three transforms and six seats, in memory, for the length of a session, so
  a machine is where the last person to drive it left it, and a reload finds it
  there rather than back home. That is the "store the diffs, not the world"
  story from the debts below, half-built: `registry.ts` is still what would
  serialise it to disk.
- **A seat node is where a face goes, not where hips go.** `playerBody.sit()`
  hangs the seated fold from its own eye line, so each machine's `driverSeat`
  and `passengerSeat` sit at the same height as its cockpit lens: one number
  per machine instead of two that have to be kept in step, and a body that
  changes size can never put its head through a roof. The three cabins were
  still drawn around a body 30% smaller than the one that walks around now
  (see the eye-line note in `playerBody.ts`), so they hold it with the hips
  sunk through the cushion and the feet below the floor. Hidden in the car and
  the boat, visible under the helicopter, and the honest fix is to grow all
  three machines rather than to shrink the person sitting in them.
- **Two chairs per machine, and only one of them steers.** The seat table is
  the server's (`world-seat`/`world-seats`), because two people reaching for
  the same door is the one question two clients cannot settle between
  themselves; everything else about a vehicle stays client-side. A claim is a
  round trip and the player does not sit down until it comes back. Sitting
  down optimistically means two people both get in and one is ejected a moment
  later, which is worse than the 50 ms.
- **A machine somebody else is driving must not be integrated locally.** The
  local physics and the arriving transform write the same six numbers every
  frame, and what you see is a car that shivers. `Vehicle.netStep` is the
  whole tick for those: it copies the transform in and solves the cosmetics
  *backwards* off the motion the interpolation implies: wheel spin from the
  forward speed, steering from the yaw rate through the bicycle model, brake
  lamps from deceleration. The handover back needs nothing: local physics
  picks the machine up mid-roll and it coasts to a stop.
- **Home spots were probed, not chosen.** The car is at the kerb outside the
  house (the street's asphalt runs z −14.4..−8.0), the helicopter one block
  north on the largest clear disc in the neighbourhood (11.3 units, which is
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
  a `hull`: stations fore to aft carrying the half-width and the standable
  height there (`collision.ts`), and the box is demoted to that hull's bounds,
  i.e. a broad phase. Every table is `.map()`ped off the same `SECTIONS` the
  body is lofted from, so a shape change moves the collision with it; author
  new ones the same way rather than by measuring the model. Deliberately not
  in any hull: the helicopter's skids (a profile has no hole in the middle, so
  including them would wall off the space *between* them) and its tail rotor
  (hung to port, and a symmetric profile wide enough for it would put the same
  1.15 of nothing to starboard).
- **A body is an area, and points do not cover areas.** `chassis.ts`'s
  `sweepBody` samples the footprint at six points against everything the world
  puts in the way, which is right for the thing it was written for: a wall or
  a building is longer than the gaps between samples and cannot be missed. A
  *post* can: measured, 255 of the 273 positions inside a car's own footprint
  were invisible to the sample set, so anything that got in there (a yaw that
  swept the flank over it, one fast substep) stayed invisible and you drove
  away with a lamp post through the roof. No number of extra probes fixes
  that. Solids smaller than the body are therefore tested *exactly*: the
  box's extent folded onto the body's axes and its centre tested against the
  grown rectangle, one comparison per solid rather than six, and only solids
  bigger than the body are still sampled.
- **Integrate in fixed slices.** The walk loop's dt is clamped to 50 ms, and
  50 ms of explicit Euler through a spring stiff enough to hold a car up is not
  a suspension. `registry.ts` substeps at 1/120, which also makes the machines
  feel the same at 30 Hz and 144 Hz.
- **`noStand` boxes are walls, not floors**, and every outdoor solid is one. So
  nothing here can drive or land on a roof, a wall or a canopy, only on
  terrain. The helicopter's rotor disc is also deliberately not collided: at 15
  units across against coarse AABBs it would be unflyable in a town.
- **Winding is not a convention, it is a bug waiting to happen.** `loft()` and
  `tube()` originally wound their side triangles inward while their caps were
  correct, which against a FrontSide material renders two solid end caps with
  an invisible shell between them, and reads as "the model failed to load"
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
                  POSITION, not streamed like core/rand.ts, since a stream's value
                  depends on how many were drawn before it, and out here the
                  draw order is whatever the player's feet decided
  grid.ts         CHUNK/GRID/offsets. Chunk (0,0) is the block the house
                  stands in, which is why roads land on chunk borders and the
                  street in front of the property lands exactly where the
                  hand-made one used to (z = -11.2)
  land.ts         the raw planet: continents, erosion, ranges, rivers, basins,
                  latitude temperature + moisture, and the desert oases,
                  site-hashed bowls sunk through the waterline whose moisture
                  halo makes the biome table draw the green ring by itself.
                  WORLD_X/Z and CLIMATE_X/Z slide the landmass and the
                  isotherms under the origin independently, which is how the
                  house ended up on temperate forest with a coast a walk away,
                  and (re-probed) with a modest desert to the south instead of
                  the near-worst-case one the first calibration parked there
  biomes.ts       the Whittaker table: 12 biomes, their tints, palettes and
                  scatter densities
  terrain.ts      land + settlement grading + the house pad -> the finished
                  ground. terrainY() reproduces the drawn mesh exactly
  settlements.ts  town sites, districts (downtown/midrise/suburb), the street
                  lattice, frayed by hashed segment dropout into T-junctions,
                  dead ends and double blocks, and the roads that run out
                  into the country
  landmarks.ts    the second site grid: what stands in the *country*. One
                  jittered candidate per 400 units, gated on biome, slope and
                  a two-ring coast test, thrown out on roads, in towns and
                  near the property. Also grades the pad its structure
                  stands on, which the terrain reads per vertex, and which
                  is one memoised lookup rather than the 3x3 scan every
                  other site grid here pays for: siteOf's jitter keeps a
                  site 0.19 * CELL clear of its cell edge, so no pad can
                  reach out of its own cell
  props.ts        tree/cactus/rock kits, VARIANTS (6) shapes each, stamped
                  not instanced. Trunks are grown by wood(): a tube swept
                  along a wandering spine that flares into the ground and
                  forks into limbs, handing back the tips the crown then
                  hangs on. Canopies are painterly alpha cards over those
                  tips, normals bent to the lobe sphere (up, for a flat
                  parasol), a baked dark-underside-to-lit-crown ramp, one
                  runtime-painted leaf texture (treeMesh.ts) shared by every
                  biome
  kitbash.ts      the stamp vocabulary every built thing shares: unit box,
                  plane, cylinder, memoised frustum, and the five roof
                  solids (gable, hip, gambrel, monopitch, barrel), plus
                  box/panel/shaft/strut/put and the town's paint. Source
                  geometry here is cached forever and never disposed, so
                  anything parameterised is quantised and memoised or it
                  leaks one geometry per chunk rebuild
  houses.ts       the suburb: five house *plans* (gabled with an optional
                  cross wing, cottage, ranch, townhouse, villa) rather than
                  one kit with a dozen booleans on it, because what breaks a
                  street up is plan, not dressing
  buildings.ts    the town and the city: walk-ups, mixed use, towers (setback,
                  slab, round), enterable shopfronts, and the three
                  block-scale kits a lot is too small for (warehouse, chapel
                  and churchyard, parking deck)
  structures.ts   the nine landmark kits: lighthouse, tower windmill,
                  farmstead, guyed radio mast, ruins, water tower, standing
                  stones, log cabin, shipwreck
  surface.ts      the procedural surface pass: one aSurf float per stamp
                  picks brick, shingle, paving, bark... computed in the
                  fragment shader from world position, because merged
                  geometry has no UVs to tile a texture across
  chunk.ts        one block: ground, water, streets, buildings, scatter
  debris.ts       what a car drives through. Chunk geometry is one merged
                  soup, so a felled tree is a *span* of it: copied out into
                  its own little mesh, collapsed where it stood, and thrown
                  on a physics/tumble.ts rod. Session state keyed by a
                  position-stable id, so a rebuilt chunk arrives cleared.
                  Its `ruins` are the same policy for buildings: a building
                  opened into pieces, each a span of its rebuilt soup with
                  its own solid, and `ruined` (building id -> piece keys)
                  re-applied when a chunk is armed
  fracture.ts     how a building comes apart: its recorded stamps read back
                  out of the soup, hollowed, floored, cut into cells and
                  grouped into pieces (wall per storey and side, floor, roof
                  bay), plus the support graph and Voronoi shattering.
                  Pure, so `measure fracture` runs it on every building
  streamer.ts     the ring, the build budget, the collision shelf
  globe.ts        the planet from orbit and the Moon: one polar-grid sphere
                  program bent to any radius, painted from land.ts's fields
                  around the player on a progressive, double-buffered map,
                  lit by the sky's sun, towns glowing on the night side
  farfield.ts     everything past the ring, for a camera in the air: nested
                  square rings of coarse terrain tiles (8, 16, 32, 64-unit
                  cells, gfx.farLevels of them) out to 2-4 km, the sea held
                  flat with its depth banded and a one-pixel foam line,
                  streets, a lit canopy and town impostors (the first lot of
                  every block drawn off buildBlock's own seeded draws) in one
                  program and one draw a tile. It discards what a finer ring
                  or a solid chunk already draws, stitches its ring edges to
                  the next ring's polyline, swaps a ring in whole, and builds
                  in resumable slices inside the streamer's budget. Past the
                  impostor rings the ground shader paints each block's lots
                  as roofs, country roads are strips off roadAt, forests keep
                  stands and gaps, and rock bands carry strata and gullies,
                  so a town and its roads reach the horizon. From the air the
                  ring shrinks to the flora chunks (RADIUS_FAR) and this
                  draws the rest
  groundLook.ts   the chunk ground's shader: a material per texel (paved,
                  sand, snow, rock, soil) with ragged pixel borders, cliffs
                  and beaches decided by geometry, and each material painted
                  on the texel grid (render/texel.ts)
  grass.ts        the grass, as two scrolling lattices: a dense near field
                  whose blades actually touch (which is the whole difference
                  between turf and scattered tufts) and a sparse far one
                  behind it, where only a blade's colour survives the
                  distance. Both tiers spend the same triangles the single
                  sparse field used to; it was all being spent out of range
  wind.ts         one wind, shared by everything that sways, and the one
                  onBeforeCompile the chunk material gets, so surface.ts
                  rides along inside it. Also owns the trample: a live press
                  under the walker plus a ring of footprint stamps, replayed
                  in the vertex shader like the water's splash rings, so
                  grass bends away underfoot and springs back behind you
  birds.ts        flocks circling over wherever the player is standing: one
                  instanced draw, a vertex-shader flap, and a ring that is
                  re-cut past the fog when the walker outruns it. Session
                  state, like the fleet; nothing is written into a chunk
  fauna.ts        the same idea on the ground: a small herd around the camera
                  that grazes, wanders and bolts when you get inside 14 units.
                  Six CC0 species, one or two per biome, chosen by the ground
                  each one is re-cut onto. The only downloaded models out
                  here, loaded after the planet attaches and never awaited
  pedestrians.ts  ...and the same idea in a town. Each is a buildPlayerBody()
                  rig (the character the player and every remote player
                  wear) walking the sidewalk slab by sampling roadAt().walk
                  rather than following a navmesh, and crossing the road
                  where the pavement runs out at a junction. A car driven
                  into one knocks it flat; it lies there, then gets up. So
                  does a player sprinting, hopping or landing on one (it is a
                  Bumpable, player/bodyContact.ts); walked into, it is pushed
                  aside and staggers, and lying down it is trampled
  quality.ts      the graphics tier: every density and budget knob, read at
                  build time, plus the GPU sniff that picks between them. New
                  knobs go in the record, not beside it. The visitor can
                  overrule the sniff from the pause sheet ("detail"), which
                  lands on the next load because these are baked
```

### Looking at it

Booting the site to check a change out here costs a login, a boot sequence, a
stand-up glide and a teleport. Two scripts skip all of that:

```
npm run shoot -- landmark:*            one of every landmark, one contact sheet
npm run shoot -- biome:wetland --eye   a walker's eye line, to judge scale
npm run shoot -- town:downtown --tod 0.78   dusk, when the glass pass lights up
npm run shoot -- 240,320 --pick 400,300     what is under that pixel
npm run shoot -- town:midrise --life 25     25s of animals and pedestrians,
                                            simulated into the tile first
npm run shoot -- biome:plains --glb /os/models/animals/fox.glb@5,-4:Walk~0.4
                                            a candidate model in real light

npm run shoot -- town:downtown biome:forest biome:beach --alt 10,40,120,300
                                            noclip/helicopter views through the
                                            real streamer: a row per target
npm run shoot -- town:suburb --alt 20,80,300 --climb 0
                                            the same, flown at 60 Hz under the
                                            frame budget (0 s on the ground: the
                                            far field not yet built)
npm run shoot -- town:downtown --alt 120 --far 0
                                            without the far field, for a before

npm run measure -- far         far-field build cost per slice and per tile, and
                               the chunk ring it replaces from the air
npm run measure -- kits        every prop kit: verts, cards, bounding box
npm run measure -- chunks      build cost and vertex budget, by tier and zone
npm run measure -- landmarks   site density and the kind mix
npm run measure -- smoke       a few thousand chunks, catching exceptions
```

Reach for `measure` first. `src/game/` is renderer-free, so anything with a
number in it is faster and more certain there, and it catches a class of bug a
picture cannot: `measure kits` prints each kit's bounding box, which is how the
reeds turned out to have been built upside down, hanging from y=0.04 down to
y=-3.02 and therefore buried whole by every scatter since they were written. A
prop that renders underground looks exactly like a prop that was never
scattered, and no screenshot was ever going to say otherwise.

### Rules that hold it together

- **Determinism is the contract.** Every field is a pure function of (x, z).
  A chunk rebuilt an hour later from the other side of the map is identical to
  the bit, which is what lets the streamer throw chunks away instead of
  keeping a world in memory, and what the save file and the multiplayer
  server will both need.
- **The mesh and the collision must agree.** `terrainY()` walks the same
  lattice, the same diagonal and the same barycentric interpolation the
  terrain mesh is built from. Sampling the smooth analytic field instead is
  off by up to a third of a unit on a hillside, which is a visible hover.
- **Two radii, because the two costs differ.** Geometry is cheap to keep and
  expensive to build, so the loaded ring reaches 4 chunks. Collision is the
  opposite (every box is scanned three or four times a frame), so only the
  nine chunks around the player put their boxes in the live set.
- **Three draws a chunk.** Ground (its own material, for the detail map),
  opaque detail (trees, kerbs, walls, one `createMeshBuilder` soup with
  per-vertex colour), and glass (every lit window, one emissive draw the day
  cycle fades).
- **Surface comes from world position, not from UVs.** A merged soup has no
  unwrap, and nothing here ships textures, so brickwork and shingles and
  paving joints are computed per fragment from world xz/y and the face normal
  (`surface.ts`). One `aSurf` float per stamp picks the treatment; everything
  organic asks for none and pays for a branch. Analytic patterns are used in
  preference to noise because they antialias against `fwidth` instead of
  turning into moire at distance.
- **What the world can lose, it loses to a span, and remembers.** A prop is
  a run of vertices in a merged mesh, so knocking one down is a copy of that
  range into a standalone geometry plus a collapse of the range it came from
  (every triangle degenerate, one partial buffer upload). Nothing rebuilds.
  But the world is a *pure function of coordinates*, so it would grow the
  tree straight back on the next chunk build: what a session actually
  destroys is kept in `debris.ts` by a position-stable id and re-applied when
  the chunk is armed, the same policy the hinged shop doors use for the one
  you left ajar. Which also fixes the ids: they must not be a running count
  of smashables, because a `bare` chunk builds no lamps and every tree after
  them would renumber.
- **What lives out here is session state, and it steers by sampling.** The
  flocks, the herd and the crowd are all a fixed pool around the camera that
  is re-cut past the fog when the player outruns it, none of it written into
  a chunk and none of it on the wire, for the reason the fleet is: agreeing
  on a grazing deer would mean the server simulating one. Where they *go* is
  the same trick twice — the world already answers "is this water", "how
  steep is this", "is this the sidewalk slab" for any point, so an animal
  turning away from a river and a pedestrian turning a corner are both a
  handful of field lookups along the heading they are on, never a navmesh or
  a graph. A graph would have to be built, kept in sync with a street layout
  that is a pure function of position, and streamed; the field is already
  there. What they must *not* do is walk through the world: nothing collides
  with them, so they collide with it, and a step is refused by clipping the
  whole step as a segment against every solid — never by sampling a point in
  front of the nose, which tunnels through every hedge and wall in a town.
  Three numbers that had to be *measured* rather than reasoned about: a spawn
  test alone does not keep animals off the roads (a deer placed nine units
  clear wanders onto the tarmac within the minute, so the step test carries
  the road check too); a pedestrian that turns round whenever it cannot step
  forward paces back and forth over four units of pavement forever (2.3 u/s
  walked against 0.7 u/s of progress) unless a turn just taken is allowed to
  finish; and both systems together cost 0.01 ms/frame in open country and
  0.15 ms in the busiest town, against 2520 solids.
- **From the air, the far field draws the planet and the sky must let it.**
  `levels/altitude.ts` is the one place that says how the view opens with
  height, and the game and the harness both call it: the fog opens to the far
  field's reach, the lens's far plane grows past its rim, and the sky dome
  (`SkyHandles.setScale`) grows with the lens, because the domes are drawn in
  the transparent pass with the depth test on and at their built 430 units
  they hid every tile past them (a sphere centred on the eye projects the
  same at any radius, so scaling it changes only depth). The look's air takes
  the same altitude (`airForSky`'s `alt`/`reach`): a height layer so a ray
  looking down crosses only the top of the haze, and an `edge` where the air
  takes everything, so the world's rim draws no line.
- **Leaving the planet is five bands of one number** (`levels/space.ts`, height
  over the ground). Past 300 the far field bends onto a sphere of the
  planet's radius (a parabola about the eye in its vertex shader, `uCurve`)
  and `world/globe.ts` continues the same curve past its rim, its radius
  following the bend so the two always meet; the air's rim moves out to the
  planet's horizon at the same pace, because left at the far field's edge it
  painted the whole globe the colour of the sky. From 800 the sky thins
  (`sky.ts`'s `space`): clouds first, then the day dome to dark blue and
  black, stars in daylight, the look's air and its under-horizon pull
  drained. From 12000 the streamed ground dithers out over the globe
  (`uFarFade`), and past 20000 it is neither drawn nor streamed, and neither
  are the house's meshes (its drawables, never its root: the root carries
  PointLights, and a light leaving the scene relinks every lit program).
  Noclip's speed grows with height (`flyScale`), the near plane steps to 1
  above 4000 so the depth buffer can tell the globe from the sky, and the far
  plane and the dome grow to clear the globe's horizon and the Moon.
- **The globe is painted, not modelled, and lies under the far field.** Its
  map is an azimuthal-equidistant disc of the whole planet around an anchor,
  distance linear in the radius so a texel is square everywhere (a
  square-root mapping put more texels near you and stretched every town into
  a spoke). It is re-baked around you only after 20000 units of drift, a
  coarse sixteenth first so a whole planet shows within a few frames, a few
  milliseconds a frame, and never below 250 up, so the helicopter never pays
  for it. While the far field is drawn the globe discards its cap out to the
  far field's reach and sinks with distance; a polygon offset was tried and
  its slope term pushed the edge-on horizon behind the sky dome. Its
  fragments write the look's veil alpha, since a depth buffer thousands of
  units deep cannot resolve its folds and inked it drew the grid's spokes,
  and it is lit in world space off the sky's sun. The grid must be wound
  counter-clockwise seen from above the pole: the other way round, back-face
  culling keeps the far hemisphere's inside and the planet is drawn inside
  out, lit backwards, with the map's clamped rim as spokes round the nadir.
- **The Moon is a level, reached by flying at it.** Past 3000 up the Moon is
  pinned 300000 units off along the sky moon's bearing (or high in the sky
  by day), drawn by the same globe program painted from `levels/moon.ts`'s
  albedo, so the landing site you see from orbit is where you land. Within
  2600 of its surface the overworld's seam (`outsideWorld.moonSeam`) cuts to
  'moon', arriving 260 over the landing pad facing the Earth; flying 2400 up
  off it cuts back, 40000 over the point the climb began. The Moon stands at
  (0, 60000) in the scene so the house, the fleet and the overworld's props
  are past its far plane; its sky is the same sky with the air taken out and
  the Earth hung in it (drawn nearer and smaller at the same angular size, so
  the depth buffer holds); its sun keeps its own low time of day and is the
  only light; and its gravity is a sixth, so a crate from 20 up lands in
  2.72 s against the street's 1.10.
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
  and reference it from a biome's scatter table. Watch the scale: the eye is
  at ~3.84 units and the top of the head at ~4.75, so a canopy wants its
  underside clear of 5 or the player walks through the leaves. Kits opt into wind by painting parts `'leaf'`.
- **A tree specifically**: grow the skeleton with `wood(seed, cfg)` and hang
  the foliage on `crown(w, r, mid)`. Seed it off the variant index (`vi`), not
  off `v`, since `v` is the size knob and two variants at different heights are
  still the same tree. Two budgets to respect. Cards are *fill* cost paid over
  the whole silhouette of a forest, so keep a kind's card count at or below
  what it was; the trunk soup is opaque and small on screen and can afford to
  grow. And the flare must stay inside `solid.r` or the player clips into the
  roots. Check `r * (1 + flare * (1 - t0/0.22)^1.8)` at the station where the
  spine crosses y = 0.
- **A plant a car can flatten**: give its kind a closing speed in `props.ts`'s
  `SNAP` table and it inherits the whole thing: the chunk builder already
  records every stamp's span, and anything absent from the table stays
  immovable (which is the honest answer for a boulder). Something built by
  hand rather than stamped from a kit (the street lamp is the one that
  exists) pushes its own `Smashable` instead, and the two numbers that
  matter are `r` (the collision radius, which is also how high the near end
  rests when it lands) and `rTop` (what the *far* end rests on: a crown props
  a felled trunk up at a real angle, a lamp head does not).
- **A building**: write a kit taking `(out: BuildOut, lot: Lot)`, add its name
  to `BuildKind`, hook it into `KIND_FOR` (a share of a block) or
  `BLOCK_KIND_FOR` (a whole one), and give it a case in `chunk.ts`'s `raise`.
  Build it in the lot's own frame (`kitbash.ts`'s `frameOf`): `u` runs along
  the frontage, `v` out toward the street, and the four cardinal facings fall
  out of two sign flips. Respect `out.detailed`: on the outer ring it is a
  silhouette and window grids are the most expensive thing the city builds.
- **A landmark**: add a kind to `LandmarkKind`, a footprint and pad to `SIZE`
  (the pad must stay under `PAD_MAX` or the cheap single-cell lookup stops
  being correct), a line or two in `eligible()`'s biome table, and a builder
  in `structures.ts`. Two things to get right. **Weighting is by repetition**:
  a kind listed twice for a biome is twice as likely there. And **facing is
  either free or cardinal**: collision out here is an AABB, so anything
  rectangular has to snap its yaw to a quarter turn (`site(lm, true)`) or it
  is mostly invisible wall, exactly the way a car parked askew is. Measure the
  hit rate with a Node probe before trusting a new gate: the site grid is a
  multi-gate condition and those are always stricter than they read.
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
  are both in hand), and it should be *session state*, a thing that follows
  the player around, re-cut beyond the fog when it falls behind, not something
  a chunk owns. `birds.ts` is the model. Keep the per-frame CPU cost to one
  matrix per body and put the motion that reads as life (a flap, a bob, a
  bank) in the vertex shader.
- **A leaf that must be seen from below**: the chunk material is `FrontSide`,
  so emit the triangles twice, wound both ways, *after* computing normals.
  See `BLADE` in `props.ts`. Doubling the index costs no vertices; computing
  normals on the doubled set cancels them to zero and the leaf renders black.

## The sandbox

Props with real rigid-body physics, Garry's Mod style: spawn them, stack
them, knock them over, roll them down a hill, throw them in the sea. The core
is Rapier (`@dimforge/rapier3d-compat`), and everything the other sandbox
systems (the physgun, the console, destruction, the network) do goes through
one facade, `createSandbox()`.

```
sandbox/
  physics.ts    loadRapier() (lazy, shared promise, works in Node) and the
                world: fixed 1/60 s slices behind an accumulator with the
                render interpolating between the last two, 8 solver substeps,
                live `timescale` and `gravity`, collision groups
  ground.ts     what props hit that is not a prop: one heightfield per chunk
                off the terrain lattice (turned a quarter so Rapier's cell
                diagonal matches the mesh's), a fixed cuboid per world Solid
                tracked by identity, and a kinematic convex hull per vehicle.
                Streamed around the walker and around every unparked prop
  kinds.ts      the kind table: shape, mass, friction, bounce, density, mesh,
                and what it sounds like (surface), breaks into or goes off as
  catalogue.ts  the forty-one kinds that ship, their physics, and `CATALOGUE`
                / `CATEGORIES` (ids, nine categories, en/es names): the menu
  models.ts     what each of them looks like, their atlas cells, and `GIBS`
                (the pieces a breakable comes apart into)
  art.ts        the one atlas, the one material, and `model()`, the builder
                every prop is stamped with
  batch.ts      props drawn as instances: each prop's mesh is a proxy, one
                InstancedMesh per shape draws them all
  breakables.ts damage, gibs, fuses, and the impact sounds' subscription
  explosion.ts  explode(point, power, radius), onExplosion, and the maths that
                knocks bodies flat (blastImpact, blastWatch)
  fx.ts         the particles, the scorch and splat decals, and the flash
  impactSounds.ts  modal synthesis per surface, breaks, booms; rate-limited
  thumbnails.ts renderThumbnails(): spawn-menu icons, in a context of its own
  propScenarios.ts  catalogue, chain, smash, crowd (and the turntable's lot)
  props.ts      the registry and the per-slice work: forces re-laid,
                buoyancy on the drawn swell, the moving sea, splashes,
                impacts from the change in velocity, rolling resistance,
                poses kept for interpolation, parking and rescue
  wake.ts       the waterline cue: foam collars and shed rings around
                floaters, splash rings and spray, two instanced draws
  walker.ts     the walker among the props: the CollisionSet's `dynamic`
                provider (stand, push out, blocks), the capped shove, weight,
                riding, and the kinematic capsule that props bounce off
  sandbox.ts    createSandbox(): the facade, and the only thing CrtScene calls
  scenarios.ts  scripted physics (a site, a setup, a camera, a clock), shared
                by the film harness and `measure physics`
  bindings.ts   the one key table: every key the walk, the sandbox and its
                tools answer to, by action (`held`, `axis`, `createEdges`,
                `keyHint`). Nobody else spells a KeyboardEvent code
  commands.ts   the console: a typed command registry with completion and
                help in both languages, run against a `SandboxHost`
  history.ts    undo (Z) and cleanup, one stack per owner (`historyOf(sb)`)
  rules.ts      the shared knobs (gravity, timescale, cleanup of everyone's)
                and the seam the network routes them through
  places.ts     what `tp town:downtown` and `tp landmark:lighthouse` find
  spawnlist.ts  the spawn menu's reading of catalogue.ts (the one list of
                what can be spawned) and thumbnails.ts, plus each plate's
                small print
  tools/        the tool belt and the physgun:
    types.ts      ToolInput (one frame of intent, filled by the keyboard or a
                  script) and HoldRecord (a hold as plain numbers, for the wire)
    physgun.ts    the hold: an implicit damped spring on the exact grab point
                  through Rapier impulses, orientation kept against the
                  heading, wheel, E-rotate with a 45-degree snap, throw,
                  freeze, thaw, rigs by the nearest limb. Headless
    beam.ts       the curved beam, the glows, the rim on the held prop and
                  the freeze flash; draws from numbers (frameFromRecord)
    viewmodel.ts  the gun, first person (depth-squeezed, never in a wall)
                  and in the body's hand
    sfx.ts        the hum pitched by strain, the grab and freeze one-shots
    toolbelt.ts   slots 1/2/3, and the one object CrtScene talks to
    scenarios.ts  the films: swing, rotate, heavy, throw, ragdoll, each -3p
  destruction.ts  buildings coming down: damage from blasts, impacts, cars
                and the console; storeys failing under their load; rubble
                that breaks up level by level as it lands; the budget
  destructionScenarios.ts  demolish-house, tower, wall, ruin
```

### The contract

```ts
const sb = createSandbox({ parent, collision, waterY, waveAt, splash, chunkSolids, ground })
// ground: { lattice(i, j), heightAt(x, z) }, the level's own (default: the terrain)
await sb.whenReady                      // optional: spawns before it are queued
sb.tick({ dt, active, walker, focus })  // once a frame; returns { steps, awake, moving, ms }

const id = sb.spawn('crate', { x, y, z }, { yaw, quaternion, velocity, angular,
                                            frozen, id, mesh, shape, mass, data, phase, scale })
sb.remove(id); sb.clear(); sb.get(id); sb.forEach(fn); sb.count
sb.getTransform(id, pos, quat?); sb.setTransform(id, pos, quat?)
sb.getVelocity(id, lin, ang?); sb.setVelocity(id, lin?, ang?)
sb.applyImpulse(id, impulse, at?); sb.addForce(id, force, at?)   // addForce: from onBeforeSlice
sb.freeze(id); sb.unfreeze(id); sb.setMode(id, 'dynamic' | 'frozen' | 'kinematic')
sb.inContact(id)                        // is any other prop touching it
sb.moveKinematic(id, pos, quat?); sb.wake(id)
sb.onImpact(e => ...)  // { id, prop, with: 'prop'|'ground'|'solid'|'vehicle'|'player',
                       //   other, solid, impulse, speed, x, y, z }
sb.onSplash(e => ...)  // { id, prop, x, y, z, speed, impulse }: went into the sea hard
sb.onSpawn(p => ...); sb.onRemove(p => ...)
sb.onBeforeSlice(h => ...); sb.onAfterSlice(h => ...)   // per fixed slice
sb.raycast(origin, dir, maxDist, { props?, world? })    // { distance, point, normal, prop, solid, ground }
sb.queryBall(center, r, p => ...)
sb.groundY(x, z); sb.restY(kind, x, z); sb.focus
sb.gravity = -34; sb.timescale = 1
sb.stateHash()                                          // '9f3c01ab@6.0000': every pose and velocity, to the bit
sb.random()                                             // the simulation's seeded chance, 0..1
sb.rapier; sb.physics                                   // the raw world, for joints
registerKind({ id, label, shape, mass, friction, restitution, density, ballast?, rolling?, mesh?,
               surface?, breaks?: { speed }, explodes?: { power, radius, speed } })

sb.explode(at, power = 1, radius = 16)  // impulse, damage (chains), fx, boom
sb.onExplosion(e => ...)   // { x, y, z, power, radius, source, pushed }
sb.onBreak(e => ...)       // { id, kind, x, y, z, how: 'break'|'explode', gibs }
sb.damage(id, dv, from?); sb.shatter(id); sb.ignite(id)
sb.fx                      // explosion, debris, burn, dust, lightLook(look.lights)
sb.ear(x, y, z, rightX, rightZ)          // the listener, once a frame

// what the spawn menu reads (re-exported by sandbox.ts)
CATALOGUE: { id, category, name: { en, es } }[]   CATEGORIES: { id, name }[]
catalogueEntry(id); inCategory(category)
await renderThumbnails(ids?, size = 96)  // [{ id, canvas }], pixel-art icons
// spawn: sb.spawn(entry.id, { x, y: sb.restY(entry.id, x, z), z }, { yaw })
// knock people over: blastImpact(e, feet, height, mass, out) -> rig.hit(...)
//                    outside.knockPeople(blastWatch(e))
```

A `Prop` carries `id`, `kind`, `body` (the Rapier body), `colliders`, `mesh`,
`extents`, `mass`, `mode`, `parked`, `wet` (the share of it under the sea)
and a free `data` bag. Every call that
takes a position takes any `{x, y, z}`. In dev, CrtScene puts the live level's
facade on `window.__sandbox` (re-pointed across a level cut), the lens on
`window.__sandboxCamera` and the level system on `window.__levels`.

### Rules that hold it together

- **Rapier never touches the room boot.** It is a 1.7 MB gzip chunk (the 0.21
  WASM is 3 MB before base64), so it is reached by a dynamic import that
  CrtScene's `ensureWorld` starts and nothing awaits. The facade is
  synchronous and exists at once; its one material is compiled under the boot
  cover through a `warm` mesh parked far below the world.
- **Mesh and collision agree, again.** The heightfields are built from
  `latticeHeight`, the same cache the terrain mesh and `terrainY` read.
  Rapier splits a heightfield cell from (x0, z1) to (x1, z0) and the mesh
  splits it from (x0, z0) to (x1, z1); a quarter turn about y maps one onto
  the other, which is why each chunk's heightfield is laid out rotated.
  `measure physics ground` raycasts it against `terrainY` (worst: 1e-4).
- **The walk stays the walk.** The walker is not a rigid body. The sandbox
  answers `supportY`/`resolveXZ`/`blockedAt` for its props through the
  CollisionSet's `dynamic` hook, so the controller, the body's feet and the
  chase boom meet props without changing. A push is two things, the walker
  stopping and the prop being shoved with an impulse capped at `PUSH_FORCE`,
  toward a speed that falls with mass (`shoveSpeed`): a ball is kicked ahead
  of your feet, a plank goes at a walk, a 35 kg crate at about a third of one,
  and against friction the cap stops a 900 kg block dead. The walker, held
  back by the push-out, moves at the prop's pace.
- **A ride carries translation and heading, never tilt.** Carrying the stand
  point through the full rotation was a motor: the walker's weight tips the
  prop a hair, the tilt carries the foot outward, the lever grows, and a
  two-crate stack walked itself out from under the player (19 units).
- **Reset torques as well as forces.** Rapier keeps the two in separate
  accumulators and `resetForces` leaves torques alone. Every force laid at a
  point adds a torque, so for a round the buoyancy torque of every floater
  grew without bound, and the sea swung crates forty degrees a frame and
  flipped drums end over end. `props.ts` clears both before re-laying.
- **Buoyancy must stay conservative, and drag must stay implicit.** Samples
  are the points of a 3x3x3 grid inside the actual shape, each ramping from
  dry to under over a fixed thickness (the shape's smallest cell side). A
  ramp that changed with the body's attitude pumped a plank to 30 rad/s of
  tumbling in still water; an explicit drag torque did the same through a
  plank's tiny long-axis inertia. Drag is Rapier's own damping (integrated
  implicitly, stable at any strength), scaled by the water displaced per
  kilogram, so a beach ball is held hard and a concrete block barely.
- **The sea moves, so floaters never sleep.** A body asleep lays no
  buoyancy, and round two's floaters went to sleep on the swell and sat on
  it like decals while it slid under them. Anything lighter than water is
  woken every slice it is wet. And damping alone drags a floater to a dead
  stop, so it drags toward the *water's* velocity instead: a force of
  `damping * mass * u` makes `u` the speed it settles on, where `u` is a slow
  current downwind, windage on what stands out of the water and an eddy per
  prop, plus a wandering yaw and a gentle rock, each torque scaled by the
  body's own inertia about that axis (one number for all three spun a plank
  about its length at 18 rad/s). None of it depends on the prop's velocity,
  so it drives without pumping. `measure physics float` prints heave, drift,
  turn, rock and churn from six seconds on, and flags a dead or churning
  floater.
- **Prop on prop friction multiplies.** Averaged, two crates at 0.42 held
  each other until a board under them tipped past 35 degrees, while a
  three-high column of them tips over its edge at about 27: every stack went
  over as one welded piece, whatever knocked it, and moving the blow only
  hid that. Props now combine friction by product (0.18 crate on crate), and
  everything else they meet carries `WORLD_FRICTION` (1.45) times its old
  value so a prop on the ground grips exactly as before. `measure physics
  lean` tips a column on a board: the top crate now slides at 20 degrees,
  before the column can tip, which is a leaning stack shedding its top. It
  applies to every prop, the demolitions' rubble included.
- **A piece born inside a crowd passes through it for a moment.** A broken
  crate's gibs start where the crate was, pressed into whatever stood on it,
  and spawned solid they held a whole column of crates up (round three
  filmed the top crate *above* the tower's height for 0.4 s). Spawned with
  `phase` (gibs use 0.1 s) a prop meets only the ground, the world's solids,
  walkers and vehicles, and rejoins the props once it overlaps none, within
  a second. `measure physics fall` shatters a base both ways: phased, the
  top crate is falling 0.07 s later; solid, never.
- **Removing a prop must not wake a heap.** Rapier wakes everything that
  touched a removed collider, and a settled pile is one island, so clearing
  gibs woke all forty props again. `remove` puts back to sleep, with its
  velocity cleared (`sleep()` keeps it), everything it woke except what was
  resting on the removed prop; and breakables leave any splinter another
  prop touches until one of them moves. Two traps found on the way: a pair
  that went to sleep keeps its contact normal but drops its contact points,
  so `numContacts()` cannot say who rests on whom, and a gib that another
  prop merely leans on is support too.
- **Rapier has no rolling resistance.** A drum on a 2% camber rolls forever,
  and one standing on its end spins like a top: round two's pile still had a
  barrel turning in place at twenty seconds. A kind's `rolling` coefficient
  takes `rolling * g` a second off the speed and spin together, only while
  it is touching something and dry. `measure physics rest` reports when the
  pile's last prop sleeps (about 6.5 s).
- **A uniform cube floats on an edge.** At density 0.5 a homogeneous cube's
  metacentre is below its centre of mass, and it floats like a diamond; that
  is physics, not a bug. A crate floats level because its load is on its
  floor: the kind's `ballast` carries a third of its mass as a point load low
  down. `measure physics float` reports each kind's waterline, attitude and
  settling time.
- **The first step costs 50 ms, once.** V8 compiles WASM lazily, so the first
  step of any world touches most of Rapier cold. `loadRapier` pays it on a
  throwaway world right after init, which is the planet attaching under the
  boot cover, rather than on the first physics frame of a walk.
- **Nothing falls forever.** Props farther than `PARK_RANGE` (200) from the
  focus are disabled where they stand and wake when someone comes back; a
  prop found well under the drawn ground is lifted back onto it three times
  and then removed.
- **Kinematic things teleport rather than sweep.** The walker's capsule and
  the vehicle hulls move to their targets across the frame's slices, but a
  jump past a stride (a spawn, a recall, a level cut) is a `setTranslation`:
  an infinitely heavy capsule swept across the room bulldozes everything
  between the two spots.
- **Deterministic, and checkable.** The same spawns, per-slice pokes and
  sea give the same world to the bit, however the frames that carried the
  slices were spaced, and Node and Chrome agree (the header of `physics.ts`
  says why and where the edge is). `sb.stateHash()` fingerprints it;
  `measure physics determinism` runs every scenario twice and once more on
  uneven frames, staged as the film stages it (the same two rings of chunks,
  the ruins armed and destruction attached, so the demolitions really come
  down headless; a scenario that ends with no props is reported as having
  nothing to compare rather than as a pass on the empty hash), and
  `npm run film` prints the same hash under each sheet
  (as long as its `--rings` cover everywhere the props go: the film only
  builds the solids of the chunks it draws, and `sandbox:chain` throws gibs
  far enough to need `--rings 4`). That is why the ground streams at the
  head of every slice rather than every frame: which colliders exist, and
  the order they were made in, is simulation state.
  The swell is the one input the sandbox reads rather than owns: the
  harnesses pin the water's clock to the slice clock, and a replay or a
  shared world must too. Anything wandering (a floater's drift) reads
  `physics.time` and the prop id, and anything left to chance in the
  simulation (a gib's kick, a fuse) draws `sb.random()`, the facade's seeded
  generator, never `Math.random` or the wall clock. Sparks and sounds may.
- **Queries see what was stepped.** Rapier's broad phase updates in `step`, so
  a collider added this frame is invisible to a raycast until the next slice.
- **One material, one atlas, one draw per shape.** Every prop, gib and bit of
  debris is painted on `art.ts`'s atlas with `propMaterial()`, and a prop's
  `mesh` is a `BatchProxy` that `batch.ts` writes into one InstancedMesh per
  geometry after the draw. Move, scale, hide or tint (`proxy.tint`) the proxy;
  never swap its material, which would be a new program mid-walk. 300 props on
  a street draw in 122 calls through the look against 453 as meshes.
- **Warm what you draw, by drawing it.** `compileAsync` links against the
  lights as they are at the call, and a pass that draws with any other light
  count links again. So the warm batch, every particle pool and one decal of
  each material are drawn every frame (collapsed to nothing, never culled),
  which puts their links in the first frame under the boot cover.
  `npm run film -- props:links` counts `linkProgram` through a spawn of every
  kind, a break of every breakable and a blast: it must print 0 and 0.
- **Nothing writes alpha it does not mean.** Under the look alpha is a
  hole, and fire and smoke that dissolved through a Bayer dither read as a
  screen door and a sparse dot pattern. The blast's core, the flames and
  the smoke are sprites on one program in three blends: the core is
  *added* (near white, so a barrel tumbling through the fireball is still
  seen inside it), its inner disc writes `GLOW_ALPHA` so
  the look skips the grade, the ink and the lamp light there, as the
  physgun's beam does; the fireball's flames are opaque teardrop sprites
  with a noise-torn edge that also write `GLOW_ALPHA` (the look inks depth
  edges, and a ball of fire drawn as balls got a rim on every ball) and
  write depth, so they sort with each other and with whatever flies
  through them; the hot ones are drawn a little forward so the white-yellow
  heart shows through the orange rind, the way additive fire would; and smoke is
  laid *over* by its transmittance, translucent through blending in four
  stepped opacities, lit by the look's ambient (`uShade`, from
  `lightLook`) so it darkens at night. Its alpha is the one thing that
  writes the look's **veil** band (0.2 to 0.99, kept by a MIN blend so
  layers never sink to a hole): the grade pass takes the silhouette and
  fold ink off whatever a veil covers, because inked through a cloud the
  debris inside it drew as grey line art. Ground dust is a
  flattened sprite, or it reads as a stone.
- **A bang is a light before it is a ball.** For three frames the look's
  `lights.flash` is hard and wide (1.5x the blast radius), lighting the
  street, the fronts and the props round it by day as well as by night and
  washing the air, then it falls to the fireball's orange glow; under it
  the added core, flame spears thrown radially well past it (`jets`), and
  then the ragged fireball of flame sprites, white-yellow in the middle and
  orange at the tips, rising on its own buoyancy and shrinking, with soft
  soot smoke at its crown. No sprite may cover more than a fifth (glow) or
  a third (fire) of the view's height at its distance, and the flash is
  held under what whites out the frame, so a body in a blast beside the
  lens is still there to see.
- **About half the barrels a blast reaches are lofted** (steeper and a
  third harder, `LOFT`) and go off at the top of their arc, 15-35 units up;
  the rest go off low, a quarter second after, among the crates they stood
  by. A row of lofted barrels leaves its crates standing, so it is a coin
  per barrel, from the sandbox's own seeded random.
- **A blast throws, and it is late.** `explode` sets a velocity change (out,
  50-70 degrees up, tumbling), not an impulse, falling with the square root
  of the mass; blasts a beat apart redirect more than they add. Explosives
  beside a blast blow a third of a second later (mid-air), further out they
  catch and sputter and go 0.5-1.6 s later wherever they land; breakables
  are worn, never broken, by a blast (glass and melons excepted), so crates
  fly whole and the landing decides. `measure physics blast` prints every
  bang's time and height.
- **A blast is a fake light.** A PointLight per explosion would relink every
  lit program; `fx.lightLook` writes the flash into the pixel look's
  `lights.flash` instead, and CrtScene calls it after dressing the look.
- **A breakable is broken after the slice, never inside it.** Impacts are
  collected and dealt in `life.step`; removing a body while Rapier is handing
  out contact pairs is how you get a panic. A blast is hotter than a knock:
  it sets an explosive off at half the blow and lights it at a fifth.
- **The physgun's hold pays the weight outside its budget.** Every slice the
  grab point is pulled toward the target on the view ray (at the distance it
  was grabbed at, until the wheel says otherwise) by a spring solved
  implicitly (stable at any stiffness, dead still when held still), fed half
  the target's own velocity, delivered as an impulse capped at an
  acceleration budget that falls with mass, with the prop's weight paid on
  top. So the beam always holds a thing up, and what mass costs you is how
  fast it can be *moved*. `tune()` is the whole feel, in three bands: a ball
  is stiff and critical (settles in 267 ms, flicks at 61 u/s); a crate is
  underdamped (8% overshoot, a second to settle, a softer orientation spring
  so it swings on its grab point, flicks at 35 u/s); a 900 kg block drags
  (trails a swing by 14 units, flicks at 8 u/s), with a small integral term
  that winds out the sag a soft spring leaves under that much weight.
  `measure physics physgun` prints all of it per kind.
- **A throw leaves along the swing's tangent.** Letting go hands the prop
  most of the gap between the beam's speed and its own, so it flies the way
  it was being swung, not where you are looking. The throw film lets go a
  quarter turn early for exactly that reason.
- **The first grab links nothing.** Every program the belt draws (the gun's
  two, the ribbon, the glow blobs, the two rim shells) is staged in front of
  `warmForRoam`'s camera for the covered compile and one-pixel draw, and the
  per-prop shells are clones of the staged materials, so they share their
  programs. The films print `programs linked after warm-up`, and it is 0.
  Chasing that 0 found a boot-wide bug: `PCFSoftShadowMap` is deprecated and
  three swaps in PCF on the first shadow pass, so every program linked before
  that pass had been keyed on the soft type and linked a second time on first
  use. CrtScene uses `PCFShadowMap` now.

### Looking at it

```
npm run film -- sandbox:stack          a 3x5 crate tower, a plank punted through it
npm run film -- 'sandbox:*'            every scenario, one contact sheet each (quote it in zsh)
npm run film -- sandbox:roll --video   ...plus an MP4 (--gif for a GIF)
npm run film -- sandbox:float --start 5 --duration 7 --frames 11    0.2 s apart
npm run film -- sandbox:pile --yaw 1.2 --dist 30 --height 12       orbit the target
npm run film -- sandbox:pile --from x,y,z --to x,y,z --fov 40      or place the lens
npm run film -- sandbox:stack --raw    the bare frame, without the pixel look
npm run film -- sandbox:stack --labels off    no time stamps or title, to judge blind
npm run film -- --list

npm run film -- sandbox:catalogue      every prop on a town street
npm run film -- sandbox:chain --rings 4 --start 0.3 --duration 4    barrels going up in a row
npm run film -- sandbox:chain --rings 4 --start 0.3 --duration 4.8 --from -40.5,2.5,-349 --to -31,5,-326 --fov 66
                                       ...the same from a walker's eye
npm run film -- sandbox:smash          crates, melons, bottles into a shopfront
npm run film -- sandbox:crowd [--nobatch]   300 props: draw calls and ms
npm run film -- props:turntable        every model four ways round
npm run film -- props:thumbs           the spawn menu's icons
npm run film -- props:sounds           every prop sound's peak, next to a footstep
npm run film -- props:links            shader links on first spawn/break/blast
npm run drive -- links                 the same count in the real /world: first
                                       spawn, a break, a fuse and a chain (0)

npm run film -- 'sandbox:physgun-*' --dense   the physgun films, 1p and 3p, + 10 fps sheets
npm run film -- sandbox:bump           the walker leaning on, charging, landing on and
                                       hopping into four of the town's pedestrians
npm run measure -- bodies              the same run headless, a 400-approach sweep for
                                       the closest two bodies ever get, the contact
                                       pass's cost, and a shove between two players
npm run film -- sandbox:bump-side      the same run side on, from above the far half of the street
npm run film -- sandbox:bump --yaw 0 --dist 12 --height 6
                                       any other angle: on a moving lens --yaw/--dist/
                                       --height orbit the walker, --from/--to pin the lens

npm run measure -- physics             all of: ground cost stack tunnel walker sites
                                       rest determinism float catalogue breaks blast physgun scenarios
npm run measure -- physics walker      one section
```

`film` writes `shots/film/<id>.png`: `--frames` stills at even sim-time steps
through the game's own chunk materials and the real sandbox, labelled with
their time, plus the scenario's report line and the shot it used (so a
reframe starts from `--from`/`--to` it printed). It takes `PROBE_PORT`/`PROBE_CDP`
like `shoot`, keeps a vite dependency cache per port, and kills only what it
spawned.

### How to add things

- **A prop kind**: a model in `models.ts` (built with `model()` on atlas
  cells, centred on the body's origin, its numbers in `DIMS`) and a `def()`
  in `catalogue.ts`, which registers the kind and lists it for the menu (or
  `registerKind()` from your own module for something off the menu): a `ShapeSpec` (box, ball, cylinder, cone, hull, or a
  compound of them), mass in kg, friction, restitution, density relative to
  water, an optional `ballast` (a share of the mass as a point load, which
  lowers the centre of mass: a crate's contents), and a `mesh()` drawn around
  the body's origin. Nothing else names a kind. A one-off shape (a debris piece) is `spawn(kind, at, { shape, mesh,
  mass })` instead.
- **A scenario**: `defineScenario({ id, title, site, camera, duration, setup,
  events?, report? })` in any module, and one line in `scripts/probe/film.ts`'s
  `SCENARIO_MODULES` if that module is not `scenarios.ts`. Sites are pure
  field searches (`siteFlat`, `siteHill`, `siteStreet`, `siteSea` are
  exported), so the same scenario always lands in the same place; a site may
  return a `memo` the camera and setup read, and `clearOf()` asks the
  chunks' own solids whether a rectangle is open ground.
- **A tool that holds props** (the physgun): drive them from
  `onBeforeSlice`, with `setVelocity` toward a target or `addForce`, or switch
  one to `kinematic` and `moveKinematic` it every slice. Per-frame writes land
  on the first slice only.

### The console, the keys and undo

The walk and the sandbox read keys through `bindings.ts` only: `held(keys,
'noclip')`, `axis(keys, 'back', 'forward')`, and one `createEdges()` per
scene for presses. Noclip is V and third person F5 (one line to swap back);
in flight space rises, c sinks, shift is fast and ctrl slow, as in Garry's
Mod. Hint copy names keys as `{noclip}` and `keyHint()` fills them in, so no
string in either language can name a key the table does not.

```ts
registerCommand({ name, aliases?, args?: [{ name, type, optional?, choices? }],
                  help: msg(en, es), run: (ctx) => { ctx.ok(msg(en, es)) } })
historyOf(sb).record({ label: msg(en, es), kind?, props: ids, undo?, owner? })
historyOf(sb).adopt(parentId, gibIds)      // gibs go with their parent's undo
rules.propose('gravity', 0.5)              // 'applied' offline, 'sent' online
```

A second `registerCommand` under a taken name replaces it: that is the seam
the props piece's real explosion replaces `explode` through. Handlers never
touch the scene; they reach it through the `SandboxHost` CrtScene builds
(teleport, noclip, time, fog, players, chat), and a missing capability is
reported rather than thrown. Most commands are the typist's own business;
gravity, timescale and `cleanup all` are the world's and go through
`rules.ts`, which offline applies at once and online hands the request to
`rules.transport` and waits for the server's `apply` (not wired yet; see
rules.ts's header). Undo and cleanup filter by `history.me`, which CrtScene
sets from the welcome's player id.

The React side is `components/os/SandboxConsole.tsx` (a thermal receipt
printer: t, enter or / opens it, /command runs, plain text chats online and
works offline), `components/os/SpawnMenu.tsx` (a mail-order catalogue held
up with q; its find line pins it open) and `components/os/Crosshair.tsx`
(a 15-cell pixel crosshair with a one-cell ink ring, tinted by what it is
on; the physgun reads the same `CrosshairAim`; in third person the scene
projects the gaze's hit through the boom and hides the mark while your own
body covers it). The catalogue is a two-page spread of plates, five across
and as many rows as the window allows (all 41 props fit on one spread at
1280x800), with index tabs on the top edge for the sections, a find line,
the curled corner or the wheel for the next spread, and the order slip
clipped to the bottom edge. Flying, the chase boom sits over the right
shoulder (`ChaseEnv.shoulder`) so the body is not under the crosshair. Both overlays free the pointer, CrtScene's `onLock` knows
an unlock they asked for is not esc, and an esc close waits for the key to
come up before taking the pointer back, or Chrome spends the release on
unlocking again. A spawn lands at the crosshair's hit, never within the
walker's reach (`BODY_CLEAR`), is stacked on a prop only when it is one
thing, not round, onto a top it fits, otherwise goes to the ground and steps
sideways (never away, which is behind the pile) until it is clear of what
is already there; round things get a nudge away from the viewer; and `host.spawned(ids)` pops it in: a scale
overshoot, a ring of dust from the fleet's particle pool (`fleet.puff`, so
no new material) and `sfx.spawnPop`.

One rule that bit: **never touch a body from inside a Rapier query
callback.** The query holds the world borrowed, the error thrown across the
WASM boundary is lost, and the world stays borrowed: an explosion pushed
nothing and the next `dispose` died. `queryBall` now collects first and calls
back after.

```
npm run measure -- console     every command headless, undo/cleanup by owner,
                               the rules seam, noclip against a wall
npm run drive                  the real /world in headless Chrome: the
                               console, the catalogue and a noclip film
                               (shots/sandbox/*.png; --lang es, --fly-at)
window.__sandbox.run('spawn crate 10')   dev: resolves with the printed lines
```

### Destruction

Every building and landmark a chunk stamps is recorded as it is stamped
(`chunk.ts`'s `recordStructure`: its spans in the detail and glass soups,
where each stamp inside them starts, and the boxes it registered). Nothing
else happens until something damages it. Then it is *opened*, once:
`world/fracture.ts` reads its stamps back out of the merged soup, hollows the
volumetric ones into shells (outside untouched, so nothing visibly changes),
lays a floor at every storey line, cuts the lot on a grid taken from the lot
(so the pieces and their keys are the same on every tier) and groups what is
in each cell and facing into a piece; `world/debris.ts`'s ruins hang that
rebuilt soup where the building was, collapse its old span, and give every
piece that carries anything its own box. From then on a piece leaving is a
tree leaving: its span collapses, its box empties, and the ruin remembers its
key so a rebuilt chunk arrives already ruined.

`sandbox/destruction.ts` is the physics and the show. A storey whose bearing
walls (walls with something resting on them) carry less than `FAIL` of what
they did lets everything above it go as one rigid cluster, resting on the
walls that are left, and those give one after another from the damage
outward over `HOLD` seconds: a charge at one corner fells the building toward
it, charges all round drop it. Crushed walls mostly turn to dust and gravel.
A tall building failing on one side does not sit down: the load above is
cut into three or four bands of storeys (`sections`), each born turning
about the foot of the far wall, the upper ones faster, so it shears apart
and swings out in big slabs and slams down across the street in a couple of
seconds. A low or evenly failed one crushes down storey by storey
(`pancake`). A falling lump breaks when it lands, one level at a time
(cluster, storeys, sides, panels, Voronoi shards with capped break faces),
every panel leaves with its corners knocked off (`chipFrags`) and rebar or
splinters out of the break (`breakDecor`, drawn only), and big rubble hitting
what is still standing damages it. Crawling rubble is damped and put to
sleep, or a heap of hulls stays one awake island for good. The dust is its
own depthless, dithered, banded material (fx.ts's `hazeMaterial`): no
outline, so it reads as air, and it thins out instead of shrinking. Lumps are ordinary props (kinds
`rubble` and `rubble_wood`, the chunk's own material), undoable per event,
grabbable, and budgeted by the tier's `gfx.rubble`.

Rules that bite:

- **The surface pattern is read in object space.** Rubble keeps its
  rest-world coordinates in its geometry and is moved by its matrix, so
  brick stays on the brick it was painted on. A chunk is built at the
  origin, so standing things are unchanged; anything new drawn with the
  chunk material must do the same or its pattern swims.
- **A piece is born inside its neighbour's box unless the box is carved.**
  Mitred walls both claim the corner square, and a piece spawned inside a
  static box is fired out at sixty units a second. `lift` trims every
  neighbour's box off the leaving piece.
- **What a ram breaks is born ahead of it and faster than it**, or it
  bounces off its own rubble (`hurt`'s `carried`).
- **Only big rubble damages buildings, and a knock must count.** Before
  both gates one tower brought down seventeen buildings and every slab settling
  against a wall chipped it.
- **Nothing expensive lands in one slice, and the budget is work, not
  time.** A building is opened a few thousand triangles of cutting a slice
  (`ruins.opening`, fracture.ts's `fractureSteps`), and a heavy prop flying
  at one starts that ahead of it; rubble bodies and breaks are made a dozen
  a slice. Counted in work so a destruction comes out the same on every
  machine: a millisecond budget made the wall film depend on the CPU.
- **Rubble comes to rest and stays there.** A piece that touches down gets
  thicker air at once and more two seconds on; one that crawls is put to
  sleep; one put to sleep that is still awake a second and a half later is
  jammed and is frozen where it lies (the physgun and any blast let it go
  again); one pressed into the street is pinned in it, never teleported back
  out (a teleported piece is born inside the heap and throws its neighbours
  over the rooftops); and nothing put to rest is let move faster than
  `SETTLED_CAP` unless a blast or a player moves it (the physgun marks what it
  grabs `data.handled`, and destruction leaves those alone). Anything standing
  taller than a storey and a bit breaks on its landing. `measure physics
  destruction` reports what is still moving at +4 s and +8 s and the fastest
  a settled piece was caught at.
- **Never touch a body from inside a Rapier query.** `ground.ts`'s wake after
  a box shrinks did, and destruction shrinks boxes by the hundred.

```
npm run film -- sandbox:demolish-house   barrels along one side; it folds over
npm run film -- sandbox:tower            charges along one side; it is felled
npm run film -- sandbox:wall             a barrier thrown through a shopfront
npm run film -- sandbox:ruin --frames 1 --start 10.9 --tile 1280x800   the ruin at eye height
npm run film -- props:collapse-links     shader links during both (must be 0)
npm run measure -- physics destruction   pieces, rubble, frame cost (DESTRUCTION_EXTRA=12 to watch it settle)
npm run measure -- fracture              every building and landmark taken apart
/collapse [near|far|left|right|down]     the console: fell what you look at
/damage [power]                          a hole in the wall you look at
```

A destruction *is* plain data, for the shared world that does not carry it
yet: `destruction.log` (building id, how, point, power, radius, direction,
seed, time per event) and `ruins.ruined` (building id to lifted piece keys).
The pieces an event lifts follow from the record; the rubble's flight does not
and would travel like any other prop.

## Multiplayer

The walk is shared. `net/` is the simulation half, headless-safe like
everything else here, and the browser half lives outside it, in
`components/os/worldNet.ts` (the socket) and `components/os/proximityVoice.ts`
(the WebRTC mesh). That line is the same one the rest of this directory keeps:
anything reaching for `import.meta.env`, a DOM WebSocket or `getUserMedia`
stays on the React side, and only plain data crosses back.

Nothing about the planet is ever sent. Every field out here is a pure function
of (x, z), so both ends can recompute the world and the only things that cannot
be recomputed are where the other people are, and where they left the car.

- **Playback runs in the past.** Snapshots arrive ~15 times a second and frames
  are drawn four times faster, so `remotePlayers.ts` renders two server ticks
  behind and interpolates between the pair of snapshots bracketing that moment.
  Extrapolating instead would guess, and a guess that is wrong at the instant
  someone stops walking drags their planted feet across the ground, the one
  artefact this body rig makes impossible to miss.
- **Timing is by arrival, not by the server's clock.** A visitor's machine may
  be minutes off UTC; a sync handshake would buy nothing local arrival time
  does not already give.
- **Velocity is not on the wire.** It is read back out of the interpolation, so
  the lean the body rig draws can never disagree with the feet under it.
  `landing` is synthesised the same way: a one-frame impulse sent as sampled
  state falls between packets more often than it survives.
- **A remote body is just another `buildPlayerBody()`.** The rig was written to
  be watched: `pose.show = 1` restores the cinematic layer (speed lean,
  gaze-follow) the first-person lens has to suppress. Remote bodies do not cast
  shadows, because the maps here are hand-baked, and a crowd of moving casters would
  either bake stale silhouettes or force a re-bake every frame.
- **The speaker badge reads the network's `speaking` bit, not the audio.** So
  someone shouting from across the valley, too far away for proximity voice to
  carry, still visibly has something to say.
- **A passenger is a reparenting, not a pose.** Anyone sitting in a machine has
  their body hung off that machine's own seat node and left there; their pose
  stream is ignored for placement entirely. Placing a seated body at the
  coordinates their client sends (the vehicle's, on a different clock, through
  a different buffer) slides them around inside their own car by a few
  centimetres whenever the two playbacks disagree. Welded to the seat they get
  every attitude the machine has for free, which is the same deal the local
  player's rig already had.
- **Only the driver's transform travels, and only from the driver.** The server
  drops a `world-vehicle` from anyone not holding seat 0 of that machine. It is
  the one rule it enforces about vehicles, and it is enough: the wire cannot
  carry two opinions about where a car is.
- **Spawns are one authored point, so arrivals are scattered.** The server
  hands each socket the lowest free slot; `spawn.ts` turns it into a
  golden-angle offset and tests it against the level's own collision, walking
  around and then inward until it finds floor. Slot 0 is the authored point
  untouched, so single player is unchanged to the bit.
- **Identity is a name and four colours, and neither is guessed.** A visitor
  who walks out of the room without touching the desktop used to be
  `guest-08c9` in the default robot, because the chat server mints a name for
  every anonymous socket and there was nowhere to change the body. The pause
  screen opens on you now, and `components/os/WorldIdentity.tsx` is its left
  column, standing beside the camera and sensitivity knobs rather than behind
  a button, because looking at where you are is most of what a pause is for.
  The name goes
  through the chat server's existing `nick` (one socket, one identity: the
  plate over your head, the chat rail and the arcade boards all have to agree,
  and registered accounts are refused as they always were), and the look is
  four hex colours from `player/look.ts`, packed into 24 characters the server
  relays without ever parsing. Three things follow from how it is built.
  Colours are **material uniforms, never material configuration**, so a
  repaint is four `Color.set()` calls and can never relink a shader mid-walk, which is
  the rule the root CLAUDE.md's boot-cost section exists for. They are picked
  from **curated palettes rather than a colour well**, because the fastest way
  to undo a scene's tone map is to let anyone type `#00ff00` into it. And the
  preview in that panel is **the real rig**: `buildPlayerBody()` again in its
  own small renderer, running its own idle springs, so what you pick is
  exactly what everyone else sees. Watch the facing convention there: the body
  is modelled facing +Z, and the scene's `facing + Math.PI` converts a compass
  yaw where 0 means -Z. Copy that π into a preview and you are looking at the
  back of your own head.
- **Bumping into somebody moves only yourself.** `player/bodyContact.ts`
  resolves the local walker out of every remote body's cylinder and never the
  other way round, so two players walking into each other stop chest to chest
  on both screens. Anything harder than a stroll travels: `net/shove.ts` sends
  a `world-shove` (a velocity, throttled to one lean every 0.3 s and one knock
  every 0.7 s), the server forwards it to the victim alone when their last
  poses are within 12 units, both on foot and neither flying, and the
  victim's own client decides: past 6 u/s planar (or pushed down, a stomp) it
  flops through the same `rig.hit` a car uses, under that it stumbles through
  `walk.push`, and for three seconds after a flop every shove is a stumble, so
  nobody can be pinned to the floor. The fall reaches everyone else through
  the ordinary `down` pose bit. `npm run measure -- bodies net` drives the
  real snapshot store at 15 Hz against a sprint and a lean.
- **The physgun takes other players the same way.** `net/grab.ts` adds every
  remote body on foot to the beam's rigs through a thin adapter, so the aim
  and the glow are unchanged. A hold streams `world-grab` 'hold' at 20 Hz
  (the limb and where it should be), a freeze sends 'freeze' and letting go
  sends 'release' with the beam's velocity; the server relays it to the
  victim alone within 180 units, never at somebody seated or flying, and
  clamps the throw to 40 u/s. The victim pins its own ragdoll's limb to the
  eased stream and tops its velocity up to the throw on release, lets go of a
  hold that goes quiet for 0.5 s or whose grabber leaves, and caps any hold
  or freeze at 8 s. While held its snapshot carries the chest and the `held`
  bit, which third parties' copies follow; the grabber's own copy is pinned
  to the beam end locally (`avatars.claim`) so the hold never feels a round
  trip late, and rejoins the victim's stream at the get-up.
- **Distance is done in WebAudio.** Each peer's stream lands on its own
  `PannerNode` with the listener riding the camera. Peers open at 55 units and
  drop at 80; the gap is what stops someone pacing the boundary from
  reconnecting forty times a minute.
- **Loudness is a graph, not a hope.** The distance model on its own is not
  loud enough to be a conversation: measured offline against the -20 dBFS a
  browser's AGC leaves a voice track at, the first version delivered -28 dBFS
  at three metres, which on a laptop speaker is silence. Every panner now
  lands on one bus carrying a fixed makeup gain, the visitor's "other voices"
  dial and a limiter; the microphone gets the matching trim ahead of its gate
  and its own limiter behind it. Both dials live in `roamPrefs` and are edited
  on the pause sheet, and there is deliberately no per-person mixer, because
  the mesh is proximity-mixed: who is loud is already answered by where they
  stand.

Two things that look like mistakes and are not: the microphone is never handed
straight to a peer connection (it goes mic → gate → `MediaStreamDestination`,
and that destination's track is what every peer carries, so muting and mode
switches are a gain ramp rather than an SDP renegotiation), and every remote
stream is also sunk into a muted `<audio>` element, because Chrome will not pump a
WebRTC track into WebAudio until the stream has a media-element consumer, and
without it the graph is correct and silent.

The known gap is NAT: there is only public STUN and no TURN relay, so some
visitors will fail to open a voice channel to some peers. Everything else about
them still works.

## The look

Every visible frame of the room, the house, the backrooms and the world goes
through `render/pixelLook.ts`, and that is what makes this a pixel-art game
rather than a low-poly one. The scene renders into a target a few hundred
lines tall (the tier's `pixelLines`, 360 on a real card, times the visitor's
pixel size and render scale, times whatever the adaptive governor has left),
with no antialiasing and a depth texture. A second pass at that same small
size does, in the order light travels: the fake lights (lamp pools, their
halos in the air, the headlamp), the outlines (silhouettes from depth breaks,
folds from normals rebuilt out of depth), the air (aerial perspective over
the scene's own fog, with the sky pulled into it at the horizon and a warm
glow toward the sun), exposure and ACES, the baked grade (`render/grade.ts`:
two 32-cube LUTs, day and night, crossfaded by `setMood`), grain, and a
posterize in OKLab whose Bayer dither lives only in a narrow seam between
bands (the sky bands clean, with more steps and no seam, grain or chroma
step, so a cloud is a set of flat shapes rather than a stain); then the
vignette. A third pass upscales nearest-neighbour to the
canvas, integer where the screen allows (1080p is exactly 3x, 1440p 4x), and
a fourth redraws the glass holes at full resolution.

Dusk keeps its warmth in the light only (the sun, the disc, an amber
afterglow band along the skyline that the look draws over the cool air, the
sky's sunward side, the lamps): the air and the shadows it fills are a cool
grey-blue, a shade darker on things than on the sky so towers silhouette,
and anything that shines (a lit window, a lamp's pool) keeps its light
through the haze, which is what keeps distant masses apart instead
of dissolving them into one sepia plane. And the look clamps the scene's
alpha before it writes premultiplied colour, because additive sprites pile
alpha past 1 in the half-float target and came back as glowing dots.

The sky (`levels/sky.ts`) is painted for the look and owned with it: a day
dome painted deeper than it reads, clouds drawn as hard-rimmed shapes in
three flat tones so the posterize keeps them clean, a twilight band that
peaks at the skyline, stars that wait for the twilight to finish, and a day
curve under which 0.74 is golden hour and 0.78 the afterglow rather than
night.

`render/atmosphere.ts` turns a moment of the sky into the air's density and
the night's lights, and CrtScene and the harness both use it: the haze is
open at noon and closes in through dusk, thicker over woods and wetland,
thinner over open country and down a street (`BIOME_AIR`, fed by
`outsideWorld.biomeAt`); at night the lamps come from every chunk's `lamps`
list (the streamer's `nearLamps`, the nearest sixteen) and the headlamp rides
the walker's eye while they are on foot in the overworld.

From the air the scene fog steps aside (`levels/altitude.ts` pushes it past
the far field's rim) and the look's air does all of the aerial perspective on
one curve that only rises with range: it lengthens with altitude (`Air.liftK`)
and, toward `edge` (the far field's reach), takes the rest of the colour, so
the rim dissolves into the horizon's air and the sky under the horizon is the
same air. It is deliberately *not* height-layered: weighing the haze by the
heights a ray ran between made a low valley at a kilometre greyer than a ridge
at three, which from the air read as a haze band with clearer land beyond it.
Ink fades with that air too, and the cloud deck and the cirrus thin toward the
skyline rather than being cut, so nothing draws a line along the horizon. A
pixel that is nothing but air bands with the sky, so the rim is not a
dithered seam against it.

The knobs are `LookKnobs`, `Air` and `FakeLights` (`pixelLook.ts`) and `Grade`
(`grade.ts`), and all of them are uniforms or a target size, so any of them
may move on any frame. The pause sheet exposes two: **pixels** (small,
medium, large: taste) and **render scale** (a share of those lines: cost,
and the governor's ceiling). `npm run shoot` draws every tile through the
look; `--raw` skips it for a before and after, `--look
'{"outline":0.8,"day":{"sat":0.9}}'` tunes it without an edit, `--lines`
sets the tile's internal height (default: an exact 2x), and `--bench n`
measures a frame against `--raw`. The harness swings a camera whose lens
would land inside a building, or whose view of the target runs through one,
to the nearest clear bearing, so the default yaw no longer photographs walls. `--tile 1920x1080 --lines 360 --cols 1` is
1:1 with a 1080p screen.

### Rules for anything drawn through it

These are what later art has to respect to look right in this pipeline, and
every one of them has a failure you can see in a harness shot.

- **Judge it through the look, never `--raw`.** By day the grade keeps
  colour (a soft cap at OKLab 0.3, a gentle 15% pull toward six anchors:
  brick 34°, ochre 74°, olive 118°, teal 168°, slate 240° and plum 314°), and
  measured at noon a frame keeps 75-90% of its raw saturation; the murk is
  the night table's and the air's, at dusk and after dark. A colour that
  looks right raw can still land a band away, and the air takes a share of
  anything a long way off. To check a change, shoot the same targets with
  and without `--raw` and compare the mean HSL saturation per tile.
- **Pick colours from the anchor families, and do not oversaturate to
  compensate.** Past the chroma cap extra saturation buys nothing but a hue
  that lands on the knee. If a whole biome needs a different mood, that is a
  `Grade` change in one place, not forty palette edits.
- **Separate forms by value, not by hue.** The posterize has 13 lightness
  steps. Two neighbouring surfaces less than one step apart in lightness
  become one band with a dither seam between them; a trim, a kerb or a door
  frame wants at least two steps against what it sits on.
- **Surface detail lives on the texel grid**: `TEXELS_PER_UNIT` = 16. New
  `surface.ts` treatments read `u`/`v` after the snap and draw joints with
  `sfLine`, so a mortar line is one texel with a hard edge and fades to its
  coverage when a texel shrinks under a pixel. A canvas texture mapped at a
  known world scale should be painted at 16 texels per unit and passed
  through `texelate()` (nearest magnification, mipmapped minification).
  Detail finer than a texel does not survive: it becomes dither noise.
- **Silhouettes and creases are what get outlined, so build with them.**
  A pixel loses `outline` (0.62) of its light where a neighbour lies more
  than `0.25 + 4.5%` of the depth behind it (inked after the air, and harder
  and further out against the sky, so a roofline keeps its line), and a fold between two faces
  meeting at more than about 30 degrees gets a line of ink (lifted instead
  where the fold faces the eye) out to 90 units. Chunky, flat-shaded
  shapes with real depth separation read; a smooth-shaded gentle curve, a
  coplanar decal or a detail modelled as a colour change does not. Outlines
  fade with the scene's fog, so what the fog swallows loses its line too.
- **Foliage cards are outlined at every card edge that has depth behind it.**
  Many small, overlapping cards turn a crown into outline noise; fewer,
  bigger cards with real holes (see the foliage rules above) read as a
  pixel-art canopy.
- **No material may lean on the renderer's tone mapping or output encoding.**
  Both are switched off (`prepareRenderer`), because three keys every program
  on them and a warm-up drawn to the canvas must compile what the look's
  target draws. Emissive and `toneMapped: false` colours go through the
  look's ACES like everything else, so an emissive meant to glow wants HDR
  intensity, not a hand-picked display colour.
- **Draw visible frames with `look.render`, never `renderer.render`.** A
  warm-up or a shadow bake may call the renderer directly (the programs are
  identical); a frame someone sees may not.
- **A light writes the glow code.** Alpha 254/255 (`GLOW_ALPHA`) is solid,
  not a hole, and the grade pass leaves that pixel out of the baked grade,
  whose chroma cap and hue pull otherwise grey an energy beam down to the
  sky's own pastel (the physgun's beam was a pale ribbon until it did this).
  It still takes ACES and the posterize. Only for things that *are* light and
  opaque where they draw (the beam's ribbon, the gun's glowing core): a
  soft glow writing it would lift the scene behind it out of the grade too.
- **A hole is a registered mesh, not an alpha.** The CSS3D glass (the AlejOS
  screen, the house TV) writes a near-zero alpha into the chunky target, and
  the grade pass fills those pixels from their solid neighbours; the hole is
  then punched at the canvas's own resolution by `look.addHole(mesh)`, so its
  edge is a clean line and anything standing in front of it still covers it.
  A new window onto live DOM must be registered there or it will render as a
  bezel-coloured blank. Anything else translucent must blend rather than
  write alpha. Alpha has three codes in the scene target: under 0.2 a
  hole, 0.2 to 0.99 a **veil** (air over something solid: its ink is taken
  off, see the sandbox's smoke), 254/255 a light (`GLOW_ALPHA`).
- **Lamp pools lie on the ground.** A pool lights only up-facing surfaces
  five to eight units under its lens, cut into four flat bands with a
  dithered seam; a fixture whose lens is not about six units over the ground
  it lights needs its own height in the pool test. An indoor lamp is that
  case, and says so with a negative radius: its pool lies on anything from
  just under the lens down to the floor under a ceiling fixture (about seven
  units), and on nothing a storey below or above it, which is how the house
  lights its rooms at night without a light in the scene
  (`levels/houseProps.ts`; CrtScene hands the nearest ten in ahead of the
  street's).
- **Light that comes and goes belongs in the look, not in the scene.** A
  PointLight appearing mid-walk changes `NUM_POINT_LIGHTS` and relinks every
  lit program. Lamps are pools (`lights.pools`, xyz and radius) and the
  headlamp is a cone, both shaded in the grade pass from depth, and a
  fixture only has to be pushed onto its chunk's `lamps` list to glow at
  night. They light by recovering albedo from the night ambient, so they are
  meant for the dark and switch off by day.
- **The look adds no programs after boot.** Three RawShaderMaterials (grade,
  blit, punch), compiled by `look.compile()` at construction. A new knob is a
  uniform, never a `#define`, and nothing in it allocates per frame.

## How to add things

- **Something new on the wire**: add it to `net/protocol.ts` first; that file
  is the specification, and the `// ---- open world` section of
  `server/src/index.js` is a hand-written implementation of it. Then extend the
  dispatch switch there, and the `world-*` branch of `CrtScene`'s `onMessage`.
  The socket has no version negotiation, so server and frontend deploy
  together. Add a step to `server/test/smoke.mjs` while the shape is fresh.
- **A new area/level**: implement `Level` (types.ts), register it in the
  array handed to `createLevelSystem`, and give an existing level a
  `seamTo()` that returns `{ to: yourId }`, plus a `spawn` in that seam
  result if arrival shouldn't land on your level's default spawn. The cut
  (freeze → blackout → swap → fade) comes for free. Solids must register in your CollisionSet or the
  player walks through them; the backrooms entrance works by deliberately
  not registering one. Give each one `noStand()` unless its box top is
  somewhere a player could plausibly stand. Then say what the level *has*:
  the scene never asks which level is live, it reads `gravity` (the walker's
  and the props' both, as a share of the overworld's), `sandbox` (props run
  here; its `ground` is the level's own height lattice on `world/grid.ts`'s
  GRID if it is not the overworld's terrain), `vehicles`, `crowd`, `house`,
  `outdoors` (the sun's shadow follows you), `air` (the look's aerial
  perspective, lamp pools and headlamp) and `surfaceAt` (footsteps). All of
  them default to none, so a new level inherits nothing it did not ask for.
  A level with a sandbox gets its own, made on first arrival and kept for
  the session, and the tool belt, the undo stack and `window.__sandbox`
  follow the live one across a cut. See the debts below.
- **A new world builder**: follow the existing contract: a
  `build*(opts) → Handles` function taking `{ scene, obstacles?,
  trackTexture, trackDisposable }` and returning `{ root, update(dt),
  furnish?(models) }` plus domain verbs. Write a module-header prose
  paragraph like the others.
- **A new player mechanic**: it goes in `walkController.ts` (movement) or a
  sibling module, not in CrtScene. The controller only knows keys in,
  transform out.
- **Something in the house that works**: a door, a drawer or an appliance
  flap is one entry in `houseWorld`'s `furnish` naming the GLB node, and
  `fittings.ts` solves the hinge edge and the swing direction off the placed
  geometry, so nothing needs measuring by hand. Give it a `cavity` unless the
  model has a modelled interior already; these carcasses are shells, and a
  door that opens on nothing shows you the back of its own front panel. A new
  seat is a `SeatSpec` pushed onto `handles.seats` (a cushion, a facing, and
  a clear spot to stand up onto, because the seat's own collision box will
  eject anyone put down inside it). Neither registers collision: a leaf is
  thin and briefly open, and an AABB appearing mid-reach shoves the player
  across the room.
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
  regenerate identically. The future save-state and multiplayer story
  depends on it.

## Known debts (grow into these when a feature demands them)

- Collision is a linear Box3 scan. It is height-aware now (a box argues only
  where it overlaps the body, and `supportY` reports the tallest top under an
  x/z), but it is still one flat list walked per query, twice per walk tick
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
  an inside: a raised plank floor graded above the terrain, stocked shelving,
  a counter, real window openings and a working front door: one leaf fixed
  shut in the merged chunk geometry, the other a hinged leaf the chunk emits
  as a spec and `world/shopDoors.ts` animates, with the house doors'
  interaction contract and sounds (house doors on the generated *houses* are
  still painted on). Shop footprints feed `world/interiors.ts` so the grass
  field and the scatterer stay out.
- The world has no persistence. Nothing the player does out there survives a
  reload, because nothing writes: the whole thing is a pure function of
  coordinates. That is what makes the save-state story easy when it comes
  (store the diffs, not the world) and why it hasn't been started.
