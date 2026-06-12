// window-level events that let far-apart components talk without prop drilling
export const OPEN_PALETTE_EVENT = 'open-command-palette'
export const OPEN_TERMINAL_EVENT = 'open-terminal'
// may be a CustomEvent whose detail names an app to open after login: { app: 'chat' }
export const BOOT_OS_EVENT = 'boot-alejos'
