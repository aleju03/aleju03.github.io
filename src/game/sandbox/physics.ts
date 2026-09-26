import type RAPIER_NS from '@dimforge/rapier3d-compat'

/*
  The rigid-body world under the sandbox: Rapier, loaded late, stepped in
  fixed slices.

  Loading. `@dimforge/rapier3d-compat` inlines its WebAssembly as base64, so
  the module is about a megabyte and a half, and none of it may reach the room
  boot (`/alejOS` stops at the house and never needs a rigid body). It is
  therefore behind a dynamic import that nothing awaits on a critical path:
  `loadRapier()` is called once the planet has attached, the sandbox queues
  whatever is asked of it until the promise lands, and the compile itself is
  `WebAssembly.instantiate`, which the browser does off the main thread. The
  same function works in Node, which is what keeps the sandbox measurable by
  `npm run measure -- physics` with no browser at all.

  Stepping. Integration is a fixed 1/60 s slice behind an accumulator, with
  the render interpolating between the last two states (`alpha`). Sixty and
  not a hundred and twenty because Rapier's solver is TGS-soft: its
  `numSolverIterations` are *substeps* with warm starting, so eight of them at
  60 Hz buys the contact stiffness of a much faster PGS step for less than one
  120 Hz step costs. Measured headless (`npm run measure -- physics`): a
  10-high crate stack goes to sleep and does not move a hundredth of a unit
  in 30 s, and held awake by force it creeps 0.03 units in the same time (an
  eight-layer plank jenga, probed the same way, is dead still); 200 props
  awake cost ~1.2 ms a frame
  and 500 ~2.7 ms; crates, balls, planks and cones thrown at 150-250 u/s
  stop at a 0.18-unit plank and at the ground. Four iterations measured
  within a few percent on all of those at ~25% less cost, so there is room to
  trade down if the frame needs it. The thing 120 Hz would have bought
  (thin fast things) is CCD's job, and CCD is on for every prop.

  Two knobs the console owns: `timescale` scales how much simulated time a
  frame asks for (0 freezes the world, 0.2 is bullet time, never a change of
  the slice itself, which would change how everything stacks), and `gravity`
  is a plain y acceleration. Both are live. The step count per frame is
  capped (`MAX_STEPS`), so a long hitch or a big timescale turns into slow
  motion rather than a spiral of death.

  Units are the world's: a unit is about 0.42 m (the eye is 3.84 up), mass is
  in kilograms, and gravity defaults to 34 u/s², the walker's own. That is
  ~1.45 g, and it is deliberate: Garry's Mod runs its props at sv_gravity 600,
  which is ~1.55 g, and a prop that falls at real gravity next to a player who
  falls at game gravity looks like it is floating.
*/

export type Rapier = typeof RAPIER_NS
export type RWorld = RAPIER_NS.World
export type RBody = RAPIER_NS.RigidBody
export type RCollider = RAPIER_NS.Collider

let rapierP: Promise<Rapier> | null = null

/** fetch and instantiate Rapier once; every caller shares the promise */
export const loadRapier = (): Promise<Rapier> => {
  rapierP ??= import('@dimforge/rapier3d-compat').then(async (m) => {
    const R = (m as unknown as { default?: Rapier }).default ?? (m as unknown as Rapier)
    await R.init()
    return R
  })
  return rapierP
}

/** the fixed slice, seconds */
export const STEP = 1 / 60
/** solver substeps per slice (see the header on why 8 at 60 Hz) */
export const SOLVER_ITERATIONS = 8
/** most slices one frame may take; past this, time slows instead */
export const MAX_STEPS = 6
/** the default downward acceleration, units/s², the walker's own */
export const GRAVITY = 34

/** collision groups. Rapier packs membership into the high 16 bits and the
    filter into the low 16; two colliders touch when each one's membership
    is in the other's filter */
export const G_WORLD = 1
export const G_PROP = 2
export const G_PLAYER = 4
export const G_VEHICLE = 8
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff)
/** what each kind of collider is and what it meets */
export const GROUPS = {
  world: groups(G_WORLD, G_PROP),
  prop: groups(G_PROP, G_WORLD | G_PROP | G_PLAYER | G_VEHICLE),
  player: groups(G_PLAYER, G_PROP),
  vehicle: groups(G_VEHICLE, G_PROP),
  /** a query that sees props only (the walker's questions) */
  queryProps: groups(0xffff, G_PROP),
  /** a query that sees the ground, the statics and the props (a beam) */
  querySolid: groups(0xffff, G_WORLD | G_PROP),
}

export interface PhysicsWorld {
  R: Rapier
  world: RWorld
  events: RAPIER_NS.EventQueue
  /** seconds of simulated time per real second; 0 pauses */
  timescale: number
  /** y acceleration, negative is down */
  gravity: number
  /** 0..1, how far the render is between the previous slice and the last */
  readonly alpha: number
  /** total simulated seconds */
  readonly time: number
  /** run however many fixed slices this frame's dt buys. `before` runs ahead
      of each slice (forces, kinematic targets), `after` behind it (events,
      bookkeeping). Returns the number of slices taken */
  advance: (
    dt: number,
    before: (h: number, k: number, n: number) => void,
    after: (h: number, k: number, n: number) => void,
  ) => number
  dispose: () => void
}

export const createPhysicsWorld = (R: Rapier): PhysicsWorld => {
  const world = new R.World({ x: 0, y: -GRAVITY, z: 0 })
  world.timestep = STEP
  world.numSolverIterations = SOLVER_ITERATIONS
  // the world is in ~0.42 m units, and Rapier's tolerances (allowed
  // penetration, prediction distance, sleep thresholds) are expressed per
  // length unit, so tell it how long a metre is here
  world.lengthUnit = 2.4
  const events = new R.EventQueue(true)
  let acc = 0
  let time = 0
  let gravity = -GRAVITY
  return {
    R,
    world,
    events,
    timescale: 1,
    get gravity() {
      return gravity
    },
    set gravity(g: number) {
      gravity = g
      world.gravity = { x: 0, y: g, z: 0 }
      // a sleeping stack does not notice gravity changing under it; the
      // console's `gravity 0` should lift everything, so wake the world
      world.bodies.forEach((b) => {
        if (b.isDynamic()) b.wakeUp()
      })
    },
    get alpha() {
      return acc / STEP
    },
    get time() {
      return time
    },
    advance(dt, before, after) {
      acc += Math.max(0, dt) * Math.max(0, this.timescale)
      // decided up front, so a kinematic target can be spread evenly across
      // however many slices this frame turns out to hold
      const n = Math.min(MAX_STEPS, Math.floor(acc / STEP))
      for (let k = 0; k < n; k++) {
        before(STEP, k, n)
        world.step(events)
        after(STEP, k, n)
        acc -= STEP
        time += STEP
      }
      // whatever the cap refused is dropped, not banked: banking it is the
      // spiral, and a frame that could not keep up has already been seen
      if (acc >= STEP) acc = acc % STEP
      return n
    },
    dispose() {
      events.free()
      world.free()
    },
  }
}
