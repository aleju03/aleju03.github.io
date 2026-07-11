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

const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space', // jump; preventDefault also keeps the page from scrolling
])
// sprint and crouch modifiers; c is a crouch alias for anyone wary of
// the browser eating ctrl chords
const MOD_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyC'])

export interface RoamInputOpts {
  /** the WebGL canvas: lock target, pointer events, cursor */
  dom: HTMLElement
  /** roaming at all (keys register during the stand-up glide too) */
  isActive: () => boolean
  /** first-person controls live, i.e. the stand-up glide has finished */
  isLive: () => boolean
  /** the pause menu is up: the world ignores the keyboard */
  isPaused: () => boolean
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
  /** codes currently held; the walk controller reads this every tick */
  keys: ReadonlySet<string>
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
  const { dom, isActive, isLive, isPaused, onTurn, onUse, onEscResume, onLock } = opts
  const keys = new Set<string>()
  let locked = false
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
    // movement keys register during the stand-up glide too, so a held W
    // starts the walk the very frame the controls go live
    if (MOVE_KEYS.has(e.code)) {
      keys.add(e.code)
      e.preventDefault()
    } else if (MOD_KEYS.has(e.code)) {
      keys.add(e.code)
    } else if (e.code === 'KeyE' && isLive()) {
      if (onUse()) e.preventDefault()
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
    if (!isActive() || !isLive()) return
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

  // capture phase: the pause menu's esc must win over the OS shell's
  // window-level esc handler regardless of registration order
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('pointerlockchange', onLockChange)
  dom.addEventListener('pointerdown', onPtrDown)
  dom.addEventListener('pointermove', onPtrMove)
  dom.addEventListener('pointerup', onPtrUp)

  return {
    keys,
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
    },
  }
}
