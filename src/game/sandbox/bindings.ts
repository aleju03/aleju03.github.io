/*
  The key table. Every key the walk, the sandbox and its tools answer to is
  named here once, by what it does, and everything else asks this module
  rather than spelling `'KeyV'` itself.

  Two reasons it is one table and not a constant per module. The obvious one
  is collisions: the physgun, the console, noclip and the old walk keys all
  want the left hand, and a clash between two modules is invisible until
  somebody presses the key and two things happen. With one table a clash is
  two lines next to each other. The second is that the controls are still
  being decided (third person moving off V is an open question with the
  owner), and a decision like that should cost one line here, not a hunt
  through CrtScene.

  Codes are `KeyboardEvent.code`, not `key`, because a layout is a keyboard's
  business and WASD is a place on it: on AZERTY it is still the same four keys
  under the left hand. The input service (`core/input.ts`) tracks every code
  that appears here, so binding a new key is also what makes it readable.

  It is plain data plus three small helpers, React-free and DOM-free, like
  the rest of the runtime.
*/

export const BINDINGS = {
  /* --- on foot --------------------------------------------------------- */
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  /** c is an alias for anyone wary of the browser eating ctrl chords */
  crouch: ['ControlLeft', 'ControlRight', 'KeyC'],
  use: ['KeyE'],
  /** the flop; at the wheel the same key is the horn */
  ragdoll: ['KeyX'],
  /** third person. Moved off V when noclip took it (Garry's Mod's own key);
      if the owner wants V back for the camera, swap these two lines */
  camera: ['F5'],
  /** in third person: look over the other shoulder */
  shoulder: ['KeyH'],
  noclip: ['KeyV'],
  /** the cockpit/chase swap at the wheel. V there too, since there is no
      noclip in a car and the key was already learned for this */
  vehicleView: ['KeyV', 'F5'],

  /* --- in noclip ------------------------------------------------------- */
  /** Garry's Mod's own noclip keys: jump rises, sprint is fast and duck is
      slow, so ctrl stops meaning crouch the moment you leave the ground.
      Sinking has no key there (you look down and push forward); c gets it
      here because a straight drop onto a roof is worth a key */
  flyUp: ['Space'],
  flyDown: ['KeyC'],
  flyFast: ['ShiftLeft', 'ShiftRight'],
  flySlow: ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight'],

  /* --- the sandbox ----------------------------------------------------- */
  /** held: the spawn menu */
  spawnMenu: ['KeyQ'],
  undo: ['KeyZ'],
  /** open the console with an empty line (t was already the chat key) */
  chat: ['KeyT', 'Enter', 'NumpadEnter'],
  /** open the console with a `/` already typed */
  command: ['Slash'],
  /** tool slots (S3): hands, physgun, toolgun */
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  /** the physgun (S3). The mouse buttons are codes too: the input service
      puts `Mouse0`/`Mouse2` in the key set while the pointer is locked.
      The wheel is not a key: `RoamInput.takeWheel()` is the physgun's
      push/pull while it holds something and cycles the slots when not */
  grab: ['Mouse0'],
  freeze: ['Mouse2'],
  /** held with the mouse: turns the held prop. Shares `use`, which is why
      E does not open doors while the beam holds something */
  rotate: ['KeyE'],
  /** held while rotating: snap to the 45-degree grid */
  snap: ['ShiftLeft', 'ShiftRight'],
  unfreeze: ['KeyR'],
  /** the tool gun (slot 3): r steps to its next mode (reload, like Garry's
      Mod's own tool gun has no better key for it); shift+r steps back */
  toolMode: ['KeyR'],

  /* --- contraptions ---------------------------------------------------- */
  /** the keys a thruster, wheel or hoverball can be set to answer to
      (contraption/parts.ts's KEY_PAIRS: the right hand's letter block laid
      out like a numpad, the numpad itself, and the arrows). Listed so the
      input service tracks them; nothing reads them through `held` */
  partKeys: [
    'KeyI', 'KeyK', 'KeyU', 'KeyJ', 'KeyO', 'KeyL',
    'Numpad8', 'Numpad5', 'Numpad7', 'Numpad4', 'Numpad9', 'Numpad6',
  ],

  /* --- the shared walk ------------------------------------------------- */
  mic: ['KeyM'],
  talkMode: ['KeyN'],
  pushToTalk: ['KeyB'],

  /* --- diagnostics ----------------------------------------------------- */
  collisionDebug: ['F9'],
} as const satisfies Record<string, readonly string[]>

export type Action = keyof typeof BINDINGS

/** is any key for this action down */
export const held = (keys: ReadonlySet<string>, action: Action): boolean => {
  const codes = BINDINGS[action]
  for (let i = 0; i < codes.length; i++) if (keys.has(codes[i])) return true
  return false
}

/** -1, 0 or 1 from a pair of opposing actions (back/forward, left/right) */
export const axis = (keys: ReadonlySet<string>, neg: Action, pos: Action): number =>
  (held(keys, pos) ? 1 : 0) - (held(keys, neg) ? 1 : 0)

/** every code bound to anything, for the input service to track */
export const BOUND_CODES: ReadonlySet<string> = new Set(
  Object.values(BINDINGS).flatMap((codes) => [...codes]),
)

/** codes whose browser default must not run while roaming: movement keys
    scroll the page, F5 reloads it, `/` opens Firefox's quick find, Alt
    focuses a menu bar and Q/Z/T do nothing worth keeping */
export const SWALLOWED_CODES: ReadonlySet<string> = new Set([
  ...BINDINGS.forward, ...BINDINGS.back, ...BINDINGS.left, ...BINDINGS.right,
  ...BINDINGS.jump, ...BINDINGS.camera, ...BINDINGS.command, ...BINDINGS.flySlow,
  ...BINDINGS.chat,
])

/**
 * Edge detection for a set of actions, the pattern CrtScene's loops used to
 * hand-roll with one `xHeld` flag per key. `update` once a frame with the live
 * key set; `pressed(a)` is true on exactly the frame an action went down.
 * Frame-based on purpose: the loop that reads it is the one that acts, so a
 * press is never seen twice and never lost between two frames.
 */
export interface Edges {
  update: (keys: ReadonlySet<string>) => void
  pressed: (action: Action) => boolean
  released: (action: Action) => boolean
  /** forget what was down, so a key held across a pause does not fire on
      resume (the menu clears the key set; this clears the memory of it) */
  reset: () => void
}

export const createEdges = (): Edges => {
  const actions = Object.keys(BINDINGS) as Action[]
  const was = new Map<Action, boolean>()
  const now = new Map<Action, boolean>()
  for (const a of actions) {
    was.set(a, false)
    now.set(a, false)
  }
  return {
    update: (keys) => {
      for (const a of actions) {
        was.set(a, now.get(a)!)
        now.set(a, held(keys, a))
      }
    },
    pressed: (a) => now.get(a)! && !was.get(a)!,
    released: (a) => !now.get(a)! && was.get(a)!,
    reset: () => {
      for (const a of actions) {
        was.set(a, false)
        now.set(a, false)
      }
    },
  }
}

/** how a key is written in a hint line: `v`, `f5`, `space`, `/` */
export const keyLabel = (action: Action, lang: 'en' | 'es' = 'en'): string => {
  const code: string = BINDINGS[action][0]
  if (code.startsWith('Key')) return code.slice(3).toLowerCase()
  if (code.startsWith('Digit')) return code.slice(5)
  if (code === 'Mouse0') return lang === 'es' ? 'clic izq' : 'lmb'
  if (code === 'Mouse2') return lang === 'es' ? 'clic der' : 'rmb'
  if (code === 'Slash') return '/'
  if (code === 'Space') return lang === 'es' ? 'espacio' : 'space'
  if (code.startsWith('Shift')) return 'shift'
  if (code.startsWith('Control')) return 'ctrl'
  if (code.startsWith('Alt')) return 'alt'
  return code.toLowerCase()
}

/** a hint line with its keys filled in from this table: `{noclip} fly`
    reads `v fly` today and follows the table if the key moves, so no copy
    in either language names a key the table does not */
export const keyHint = (line: string, lang: 'en' | 'es' = 'en'): string =>
  line.replace(/\{(\w+)\}/g, (m, a: string) => (a in BINDINGS ? keyLabel(a as Action, lang) : m))
