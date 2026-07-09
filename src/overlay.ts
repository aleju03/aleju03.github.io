export const OVERLAY_CHANGE_EVENT = 'portfolio-overlay-change'

let lockDepth = 0
let coverDepth = 0
let lastOpen = false
let lastCovered = false
let previousOverflow = ''
let previousPaddingRight = ''

function syncOverlayState() {
  const open = lockDepth > 0
  const covered = coverDepth > 0
  if (open === lastOpen && covered === lastCovered) return
  lastOpen = open
  lastCovered = covered
  document.documentElement.toggleAttribute('data-overlay-open', open)
  window.dispatchEvent(new CustomEvent(OVERLAY_CHANGE_EVENT, { detail: { open, covered } }))
}

/**
 * Scroll-locks the page while an overlay is up. Pass covers=true when the
 * overlay hides the page completely (opaque and fullscreen, like AlejOS):
 * the render loops underneath use that signal to stop painting frames
 * nobody can see. Partial overlays (palette, modals, lightbox) leave the
 * page visible behind them, so they must not set it.
 */
export function lockPageForOverlay(covers = false) {
  if (lockDepth === 0) {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    previousOverflow = document.body.style.overflow
    previousPaddingRight = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    if (scrollbarWidth > 0) {
      const currentPadding = Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0
      document.body.style.paddingRight = `${currentPadding + scrollbarWidth}px`
    }
  }

  lockDepth += 1
  if (covers) coverDepth += 1
  syncOverlayState()
  let released = false

  return () => {
    if (released) return
    released = true
    lockDepth = Math.max(0, lockDepth - 1)
    if (covers) coverDepth = Math.max(0, coverDepth - 1)

    if (lockDepth === 0) {
      document.body.style.overflow = previousOverflow
      document.body.style.paddingRight = previousPaddingRight
    }
    syncOverlayState()
  }
}

export function overlayIsOpen() {
  return document.documentElement.hasAttribute('data-overlay-open')
}

export function pageIsCovered() {
  return coverDepth > 0
}

export function onOverlayChange(listener: (open: boolean, covered: boolean) => void) {
  const handler = (event: Event) => {
    const { open, covered } = (event as CustomEvent<{ open: boolean; covered: boolean }>).detail
    listener(open, covered)
  }
  window.addEventListener(OVERLAY_CHANGE_EVENT, handler)
  return () => window.removeEventListener(OVERLAY_CHANGE_EVENT, handler)
}
