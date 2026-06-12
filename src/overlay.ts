export const OVERLAY_CHANGE_EVENT = 'portfolio-overlay-change'

let lockDepth = 0
let previousOverflow = ''

function setOverlayState(open: boolean) {
  document.documentElement.toggleAttribute('data-overlay-open', open)
  window.dispatchEvent(new CustomEvent(OVERLAY_CHANGE_EVENT, { detail: { open } }))
}

export function lockPageForOverlay() {
  if (lockDepth === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    setOverlayState(true)
  }

  lockDepth += 1
  let released = false

  return () => {
    if (released) return
    released = true
    lockDepth = Math.max(0, lockDepth - 1)

    if (lockDepth === 0) {
      document.body.style.overflow = previousOverflow
      setOverlayState(false)
    }
  }
}

export function overlayIsOpen() {
  return document.documentElement.hasAttribute('data-overlay-open')
}

export function onOverlayChange(listener: (open: boolean) => void) {
  const handler = (event: Event) => {
    listener((event as CustomEvent<{ open: boolean }>).detail.open)
  }
  window.addEventListener(OVERLAY_CHANGE_EVENT, handler)
  return () => window.removeEventListener(OVERLAY_CHANGE_EVENT, handler)
}
