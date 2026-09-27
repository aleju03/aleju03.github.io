/*
  The roam-mode input service: keyboard state, mouse-look, and the pointer
  lock lifecycle, extracted from the scene so the sim never touches DOM
  events directly. It owns the raw mechanics — which keys are down, lock
  acquisition with its browser quirks, the drag-vs-click distinction — and
  reports intent through callbacks; the owner keeps the policy (what E does,
  when to pause). Mouse-look: pointer lock steers directly (sign -1), an
  unlocked drag grabs the world instead (sign +1), and a still click only
  (re)grabs the mouse. Esc semantics are delicate: while locked the browser
  spends Esc on the unlock (the owner hears it via onLock(false)); with the
  pause menu up, Esc resumes and must stopImmediatePropagation so the OS
  shell's own window-level Esc handler never sees it — which is also why the
  keydown listener rides the capture phase.
*/
import { BOUND_CODES, SWALLOWED_CODES } from '../sandbox/bindings'

// which keys are tracked, and which have their browser default swallowed,
// both come from the one key table (sandbox/bindings.ts): movement, sprint and
// crouch, the flop, the camera, noclip, the console and spawn menu keys, the
// emote wheel (g, held) and the point key (f or the middle button, held), the
// multiplayer keys (m arms the microphone, n swaps the talk mode, b is the
// push-to-talk key, the one the scene reads as a held state), and F9, the
// collision wireframe (collisionDebug.ts), which lives here rather than
// behind a build flag because the thing it diagnoses (a solid that disagrees
// with the geometry it stands for) only ever shows up in a real walk. The
// scene edge-detects the toggles off the same set.

export interface RoamInputOpts {
  /** the WebGL canvas: lock target, pointer events, cursor */
  dom: HTMLElement
  /** roaming at all (keys register during the stand-up glide too) */
  isActive: () => boolean
  /** first-person controls live, i.e. the stand-up glide has finished */
  isLive: () => boolean
  /** the pause menu is up: the world ignores the keyboard */
  isPaused: () => boolean
  /** the chat line has the keyboard. Unlike a pause this leaves the world
      running and the mouse locked, so it also has to mute mouse-look —
      otherwise typing a message spins the camera under the composer */
  isTyping: () => boolean
  /** mouse-look delta; sign is -1 locked, +1 dragging */
  onTurn: (dx: number, dy: number, sign: 1 | -1) => void
  /** E while live; return true if it acted (consumes the key) */
  onUse: () => boolean
  /** Esc with the pause menu up */
  onEscResume: () => void
  /** pointer lock gained/lost */
  onLock: (locked: boolean) => void
}

export interface RoamInput {
  /** codes currently held; the walk controller reads this every tick.
      While the pointer is locked the mouse buttons are here too, as
      `Mouse0` (left), `Mouse1` (middle) and `Mouse2` (right) */
  keys: ReadonlySet<string>
  /** wheel notches since the last call, positive rolled away from you */
  takeWheel: () => number
  readonly locked: boolean
  /** grab the mouse like a game; a browser refusal is fine, clicking locks */
  tryLock: () => void
  releaseLock: () => void
  setCursor: (c: string) => void
  /** nothing stays latched (pause menu up, sitting down, alt-tab) */
  clearKeys: () => void
  dispose: () => void
}

export function createRoamInput(opts: RoamInputOpts): RoamInput {
  const { dom, isActive, isLive, isPaused, isTyping, onTurn, onUse, onEscResume, onLock } = opts
  const keys = new Set<string>()
  let locked = false
  let wheel = 0
  let downPt: { moved: number } | null = null

  const setCursor = (c: string) => {
    dom.style.cursor = c
  }
  const tryLock = () => {
    try {
      const got = dom.requestPointerLock() as unknown
      ;(got as Promise<void> | undefined)?.catch?.(() => {})
    } catch {
      /* stay unlocked; clicking locks */
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isActive()) return
    if (e.code === 'Escape') {
      // esc while locked never reaches the page (the browser spends it on
      // the unlock); esc with the menu up resumes — and must not bubble on
      if (isPaused() && isLive()) {
        e.stopImmediatePropagation()
        onEscResume()
      }
      return
    }
    if (isPaused()) return // the world ignores the keyboard under the menu
    if (isTyping()) return // every key belongs to the chat line while it is up
    // E is the interact key first: it goes to onUse and is also tracked, so
    // a tool can read it as a held modifier (the physgun's rotate)
    if (e.code === 'KeyE') {
      keys.add(e.code)
      if (isLive() && onUse()) e.preventDefault()
      return
    }
    // everything else in the key table registers during the stand-up glide
    // too, so a held W starts the walk the very frame the controls go live
    if (BOUND_CODES.has(e.code)) {
      keys.add(e.code)
      if (SWALLOWED_CODES.has(e.code)) e.preventDefault()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)
  // alt-tabbing away mid-stride must not leave a key latched down
  const onBlur = () => keys.clear()
  const onLockChange = () => {
    locked = document.pointerLockElement === dom
    setCursor(locked ? 'none' : 'grab')
    onLock(locked)
  }
  const onPtrDown = () => {
    if (!isActive() || !isLive()) return
    downPt = { moved: 0 }
    if (!locked) setCursor('grabbing')
  }
  const onPtrMove = (e: PointerEvent) => {
    if (!isActive() || !isLive() || isTyping()) return
    if (locked) {
      onTurn(e.movementX, e.movementY, -1)
    } else if (downPt) {
      onTurn(e.movementX, e.movementY, 1)
      downPt.moved += Math.hypot(e.movementX, e.movementY)
    }
  }
  const onPtrUp = () => {
    if (!isActive() || !isLive() || !downPt) return
    const clicked = downPt.moved < 6
    downPt = null
    if (!locked) {
      setCursor('grab')
      if (clicked) tryLock() // guarded: post-esc cooldown rejections are fine
    }
  }

  // the buttons are mousedown/mouseup rather than pointer events: a second
  // button pressed while the first is held (RMB to freeze while LMB holds)
  // is a pointermove, not a pointerdown. Only while locked, where a click is
  // a trigger; unlocked, a click is the grab of the mouse itself
  const onMouseDown = (e: MouseEvent) => {
    if (!locked || !isActive() || !isLive() || isPaused() || isTyping()) return
    keys.add(`Mouse${e.button}`)
    // the middle button is the point key: never the browser's autoscroll
    if (e.button === 1) e.preventDefault()
  }
  const onMouseUp = (e: MouseEvent) => keys.delete(`Mouse${e.button}`)
  const onWheel = (e: WheelEvent) => {
    if (!locked || !isActive() || !isLive() || isPaused()) return
    e.preventDefault()
    if (e.deltaY) wheel += e.deltaY < 0 ? 1 : -1
  }
  const onContext = (e: Event) => {
    if (locked) e.preventDefault()
  }

  // capture phase: the pause menu's esc must win over the OS shell's
  // window-level esc handler regardless of registration order
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('pointerlockchange', onLockChange)
  dom.addEventListener('pointerdown', onPtrDown)
  dom.addEventListener('pointermove', onPtrMove)
  dom.addEventListener('pointerup', onPtrUp)
  document.addEventListener('mousedown', onMouseDown)
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('wheel', onWheel, { passive: false })
  document.addEventListener('contextmenu', onContext)

  return {
    keys,
    takeWheel: () => {
      const n = wheel
      wheel = 0
      return n
    },
    get locked() {
      return locked
    },
    tryLock,
    releaseLock: () => {
      if (document.pointerLockElement) document.exitPointerLock()
    },
    setCursor,
    clearKeys: () => keys.clear(),
    dispose: () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('pointerlockchange', onLockChange)
      dom.removeEventListener('pointerdown', onPtrDown)
      dom.removeEventListener('pointermove', onPtrMove)
      dom.removeEventListener('pointerup', onPtrUp)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('wheel', onWheel)
      document.removeEventListener('contextmenu', onContext)
    },
  }
}
