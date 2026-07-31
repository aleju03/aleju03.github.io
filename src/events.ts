// window-level events that let far-apart components talk without prop drilling
export const OPEN_PALETTE_EVENT = 'open-command-palette'
export const OPEN_TERMINAL_EVENT = 'open-terminal'
// may be a CustomEvent whose detail names an app to open after login
// ({ app: 'chat' }) and/or marks that the hero's paper plane triggered the
// boot by being swallowed ({ via: 'plane' }) — the 3D room lays the dart out.
// { flat: true } asks for the desktop in its flat bezel and skips the 3D room
// entirely, however capable the device is (the /pc route boots this way);
// { world: true } is the far end — the open world loaded up front, the machine
// already dark, skipping the boot and starting on your feet (the /world route).
// Without it a 3D boot builds the room only, and the planet past the front door
// is streamed in on demand the first time someone actually opens that door.
export const BOOT_OS_EVENT = 'boot-alejos'
// the OS scene on the far side of the wormhole has its first frame up; the
// detail may carry {x, y, r} — the CRT glass's viewport spot — so the warp
// can open its exit right on the machine
export const OS_SCENE_READY_EVENT = 'alejos-scene-ready'
// re-open the first-visit version chooser from anywhere (footer link, palette)
export const OPEN_CHOOSER_EVENT = 'open-version-chooser'
// in-app (pushState) navigation; the version router re-reads location on this
export const NAVIGATE_EVENT = 'app-navigate'
// a socket said hello with the stored session token and the server did not
// recognise it (expired, swept, or minted by a server that has since been
// replaced). The saved session is a lie from that moment on, so AlejOS drops
// back to the login screen instead of showing a name the server will not use
export const SESSION_EXPIRED_EVENT = 'alejos-session-expired'
