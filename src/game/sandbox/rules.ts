/*
  The world's shared knobs: the handful of console settings that cannot be one
  player's opinion.

  Most of what the console does belongs to whoever typed it. Noclip, god
  mode, a teleport, the time of day you are looking at, the fog you are
  looking through: all of it is yours, changes nothing anybody else sees
  except your body moving, and stays local. Three things are different,
  because they are properties of the physics every prop in the world obeys,
  and two clients with two gravities would simulate two different worlds:

  - `gravity` (a multiple of the normal pull; it reaches the walker too),
  - `timescale` (how fast the props' clock runs),
  - and one action, cleaning up *everyone's* props (your own cleanup is
    yours and needs nobody's permission).

  So those go through here instead of straight onto the sandbox. Offline,
  `propose` applies at once and `onChange` hands the value to the scene. Online,
  the network layer sets `transport`, `propose` hands the request to it and
  applies nothing, and the value lands later through `apply` when the server
  announces it, so every client changes gravity on the same message. Who is
  allowed is the server's call, not the client's, and a refusal comes back
  through `deny`. That wire does not exist yet; this module is the seam it
  plugs into (see the report for S6, and `src/game/README.md`'s sandbox
  section), and nothing here needs to change when it lands.

  React-free, three-free, and one instance per scene.
*/

export type RuleKey = 'gravity' | 'timescale'
export type RuleAction = 'cleanup-all'

export interface RuleLimits {
  min: number
  max: number
  normal: number
}

export const RULES: Record<RuleKey, RuleLimits> = {
  gravity: { min: -2, max: 4, normal: 1 },
  timescale: { min: 0, max: 4, normal: 1 },
}

export type Proposal = 'applied' | 'sent'

export interface WorldRules {
  readonly gravity: number
  readonly timescale: number
  get: (key: RuleKey) => number
  /** ask for a value. Offline it is applied now; online it is sent */
  propose: (key: RuleKey, value: number) => Proposal
  /** ask for a shared action. Offline it runs `local` now; online it is sent */
  act: (action: RuleAction, local: () => void) => Proposal
  /** the network's side: a value the server announced (also on join) */
  apply: (key: RuleKey, value: number) => void
  /** the network's side: the server said no to a proposal of ours */
  deny: (what: RuleKey | RuleAction, reason: string) => void
  /** set by the network while connected; null offline */
  transport: {
    rule: (key: RuleKey, value: number) => void
    action: (action: RuleAction) => void
  } | null
  /** every applied change, local or announced */
  onChange: (fn: (key: RuleKey, value: number) => void) => () => void
  /** refusals, for the console to print */
  onDeny: (fn: (what: RuleKey | RuleAction, reason: string) => void) => () => void
  /** back to normal without asking anybody (leaving the world, a reset) */
  reset: () => void
}

export const clampRule = (key: RuleKey, v: number) =>
  Math.max(RULES[key].min, Math.min(RULES[key].max, v))

export const createWorldRules = (): WorldRules => {
  const values: Record<RuleKey, number> = { gravity: 1, timescale: 1 }
  const changeFns = new Set<(key: RuleKey, value: number) => void>()
  const denyFns = new Set<(what: RuleKey | RuleAction, reason: string) => void>()

  const set = (key: RuleKey, value: number) => {
    const v = clampRule(key, value)
    if (values[key] === v) return
    values[key] = v
    for (const fn of changeFns) fn(key, v)
  }

  const rules: WorldRules = {
    get gravity() {
      return values.gravity
    },
    get timescale() {
      return values.timescale
    },
    get: (key) => values[key],
    propose: (key, value) => {
      if (rules.transport) {
        rules.transport.rule(key, clampRule(key, value))
        return 'sent'
      }
      set(key, value)
      return 'applied'
    },
    act: (action, local) => {
      if (rules.transport) {
        rules.transport.action(action)
        return 'sent'
      }
      local()
      return 'applied'
    },
    apply: set,
    deny: (what, reason) => {
      for (const fn of denyFns) fn(what, reason)
    },
    transport: null,
    onChange: (fn) => {
      changeFns.add(fn)
      return () => changeFns.delete(fn)
    },
    onDeny: (fn) => {
      denyFns.add(fn)
      return () => denyFns.delete(fn)
    },
    reset: () => {
      set('gravity', RULES.gravity.normal)
      set('timescale', RULES.timescale.normal)
    },
  }
  return rules
}
