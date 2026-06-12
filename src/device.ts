export function isCoarsePointer() {
  return window.matchMedia('(hover: none), (pointer: coarse)').matches
}

export function shouldAutoFocusTextInput() {
  return !isCoarsePointer()
}
