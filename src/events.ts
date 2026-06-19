// window-level events that let far-apart components talk without prop drilling
export const OPEN_PALETTE_EVENT = 'open-command-palette'
export const OPEN_TERMINAL_EVENT = 'open-terminal'
// may be a CustomEvent whose detail names an app to open after login: { app: 'chat' }
export const BOOT_OS_EVENT = 'boot-alejos'
// re-open the first-visit version chooser from anywhere (footer link, palette)
export const OPEN_CHOOSER_EVENT = 'open-version-chooser'
// in-app (pushState) navigation; the version router re-reads location on this
export const NAVIGATE_EVENT = 'app-navigate'
