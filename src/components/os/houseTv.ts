import * as THREE from 'three'
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js'
import { propSnap } from '../../game/core/sfx'

/*
  The television in the living room, and the one thing in this house that is
  genuinely someone else's picture.

  A YouTube player cannot be drawn into WebGL, because the frames never reach
  the page as pixels we may touch, so the tube is the same trick the computer's
  own monitor is: a hole in the canvas with live DOM behind it. CrtScene
  already runs a CSS3DRenderer sharing the WebGL camera for the AlejOS
  screen; this hangs a second element in that scene, on the television's own
  tube face, and punches through to it with a plane carrying a NoBlending
  near-transparent material. Depth still sorts it, so walking into the
  kitchen puts a wall in front of the picture and the wall wins.

  Four rules this thing lives by.

  **The iframe is never clickable.** The walk holds pointer lock, so a click
  is a look, not a press; an element with `pointer-events: auto` there would
  swallow the pointer that the canvas needs and break the lock. So the set is
  worked entirely from the game (power on the tube, channel with A/D from the
  sofa) and the player is driven over `postMessage` rather than through
  YouTube's iframe API script, which keeps the third-party JS off the page
  and leaves the embed itself as the only outbound thing here.

  **Off means gone.** Powering down removes the iframe instead of pausing it:
  a paused embed is still a socket, still a decoder, and still occasionally
  an autoplaying advertisement three rooms away. The tube costs nothing until
  somebody turns it on and nothing again the moment they turn it off.

  **Loudness is distance.** There is no spatialiser to hand, this being an
  iframe rather than a buffer on our own AudioContext, so the volume is set from
  the listener's distance to the screen and re-sent only when it has actually
  moved a step, because every one of those is a postMessage into another
  origin's window.

  **A lit tube throws no light on the room, and that is deliberate.** Every
  lamp in this house is hand-baked, and a real one added here would change
  the shader configuration and relink every material in the room the first
  time somebody pressed the button. The usual dodge is the moon pool's: an
  additive glow lying on the floor. It does not work here, because the floor
  in front of a television is where the coffee table and the rug are, so the
  quad either lands under the table where nobody sees it or floats up to
  where it cuts through it. The picture is bright and it is the cue.

  **The channel table is the whole editorial surface.** Video ids rot; this
  is one array and swapping an id needs nothing else to change. A channel
  with no id is not a bug, it is dead air, and it renders as one.
*/

export interface Channel {
  /** the number on the dial */
  n: number
  label: string
  /** a video id, or nothing at all for a dead channel */
  id?: string
  /** ...or a playlist id, which takes precedence */
  list?: string
  /** a live stream skips the "start at" trick below */
  live?: boolean
}

/*
  What is on. Swap these ids for whatever you want on the tube; nothing else
  in the file knows or cares what they point at, and an id that has been
  taken down degrades to YouTube's own placeholder rather than to a crash.
*/
export const CHANNELS: Channel[] = [
  { n: 1, label: 'big buck bunny', id: 'YE7VzlLtp-4' },
  { n: 2, label: 'sintel', id: 'eRsGyueVLvQ' },
  // a live stream is the one kind of id that can go dead *while embedded*:
  // the channel keeps working and the video becomes "recording unavailable",
  // which is why the set does not open on one
  { n: 3, label: 'lofi radio', id: 'jfKfPfyJRdk', live: true },
  { n: 4, label: 'no signal' },
]

/** the tube's DOM is rendered at this size and scaled onto the glass; a 4:3
    raster, because the set it is standing in is one */
const RASTER_W = 420
const RASTER_H = 315
/** and the width a 16:9 player has to be to fill that 4:3 tube's height */
const WIDE = Math.round((RASTER_H * 16) / 9)
/** where the volume starts falling off, and where it reaches nothing */
const LOUD_AT = 4
const QUIET_AT = 26
/** how loud the set is at the sofa, out of 100 */
const VOLUME = 70

export interface TvScreen {
  /** the middle of the tube face, world */
  centre: THREE.Vector3
  /** the outward normal of that face */
  normal: THREE.Vector3
  /** the face's own right and up, so the picture is never rolled */
  right: THREE.Vector3
  up: THREE.Vector3
  width: number
  height: number
}

export interface TvHandles {
  /** volume follows the listener; call once per rendered frame */
  update: (listener: THREE.Vector3) => void
  /** standing at the set and looking at it: which verb to offer */
  prompt: (p: THREE.Vector3, gaze: THREE.Vector3) => 'on' | 'off' | null
  /** the power button. Returns false when nothing was in reach */
  use: (p: THREE.Vector3, gaze: THREE.Vector3) => boolean
  /** the dial, from the sofa. Wakes a dark set rather than doing nothing */
  turn: (by: number) => void
  /** stop it dead: leaving the walk, a level cut, sitting back at the desk */
  silence: () => void
  readonly on: boolean
  readonly channel: Channel
  dispose: () => void
}

interface Opts {
  scene: THREE.Scene
  /** CrtScene's CSS3D scene, the one the AlejOS screen already lives in */
  cssScene: THREE.Scene
  screen: TvScreen
  trackDisposable: (d: { dispose: () => void }) => void
}

/** how far the player may stand from the set and still work its buttons */
const REACH2 = 3.4 * 3.4
const AIM = 0.5

export function buildHouseTv({ scene, cssScene, screen, trackDisposable }: Opts): TvHandles {
  let channel = 0
  let on = false
  let sent = -1

  // the punch: NoBlending writes a near-zero alpha straight into the canvas,
  // opening a tinted window onto the CSS3D layer behind it. Same recipe as
  // the computer's glass, one room over
  const holeMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    opacity: 0.06,
    blending: THREE.NoBlending,
    side: THREE.DoubleSide,
  })
  const holeGeo = new THREE.PlaneGeometry(screen.width, screen.height)
  trackDisposable(holeMat)
  trackDisposable(holeGeo)
  const hole = new THREE.Mesh(holeGeo, holeMat)
  const basis = new THREE.Matrix4().makeBasis(screen.right, screen.up, screen.normal)
  hole.quaternion.setFromRotationMatrix(basis)
  hole.position.copy(screen.centre).addScaledVector(screen.normal, 0.004)
  hole.castShadow = false
  hole.receiveShadow = false
  hole.visible = false
  hole.matrixAutoUpdate = false
  hole.updateMatrix()
  scene.add(hole)

  // the DOM behind the hole. pointer-events stays off: the walk owns the
  // pointer, and an iframe that could take it would break the lock
  const el = document.createElement('div')
  el.style.width = `${RASTER_W}px`
  el.style.height = `${RASTER_H}px`
  el.style.pointerEvents = 'none'
  el.style.overflow = 'hidden'
  el.style.background = '#05070a'
  el.style.userSelect = 'none'
  el.style.position = 'relative'
  const dead = document.createElement('div')
  dead.style.cssText =
    'width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
    'font:600 22px ui-monospace,monospace;letter-spacing:.24em;color:#5c6b7a;' +
    'background:repeating-linear-gradient(0deg,#0a0e13 0 3px,#11161d 3px 6px)'
  dead.textContent = 'NO SIGNAL'
  el.appendChild(dead)

  const css = new CSS3DObject(el)
  css.scale.setScalar(screen.width / RASTER_W)
  css.quaternion.setFromRotationMatrix(basis)
  css.position.copy(screen.centre).addScaledVector(screen.normal, 0.002)
  css.visible = false
  cssScene.add(css)
  css.updateMatrixWorld(true)
  css.matrixAutoUpdate = false // the set never moves, only the camera does

  let frame: HTMLIFrameElement | null = null

  const src = (c: Channel) => {
    const params = new URLSearchParams({
      autoplay: '1',
      // muted autoplay is the only kind a browser promises; the unmute goes
      // out over postMessage a moment later, off the back of the keypress
      // that turned the set on, which is user activation enough
      mute: '1',
      enablejsapi: '1',
      playsinline: '1',
      rel: '0',
      modestbranding: '1',
      // no transport bar: it is unclickable behind a pointer-locked walk, and
      // a scrub bar across the bottom of a 1980s tube is the one thing that
      // would give the whole illusion away
      controls: '0',
      iv_load_policy: '3',
      loop: '1',
      origin: window.location.origin,
    })
    if (c.list) {
      params.set('listType', 'playlist')
      params.set('list', c.list)
      return `https://www.youtube-nocookie.com/embed?${params}`
    }
    // a looping single video needs to name itself as its own playlist
    if (!c.live) params.set('playlist', c.id as string)
    return `https://www.youtube-nocookie.com/embed/${c.id}?${params}`
  }

  const post = (func: string, args: unknown[] = []) => {
    frame?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args }),
      'https://www.youtube-nocookie.com',
    )
  }

  const tune = () => {
    const c = CHANNELS[channel]
    if (frame) {
      frame.remove()
      frame = null
    }
    sent = -1
    dead.style.display = c.id || c.list ? 'none' : 'flex'
    if (!c.id && !c.list) return
    frame = document.createElement('iframe')
    frame.width = String(WIDE)
    frame.height = String(RASTER_H)
    /*
      Wider than its own tube, and centred: everything on YouTube is 16:9 and
      this set is 4:3, so a player fitted to the glass letterboxes itself and
      the picture ends up a band across the middle of an already small screen.
      Overflowing the sides fills the tube instead, which is also where the
      player's own title bar and controls go, so the crop is doing two jobs.
    */
    frame.style.cssText =
      `position:absolute;top:0;left:50%;transform:translateX(-50%);` +
      `width:${WIDE}px;height:100%;border:0;display:block`
    frame.allow = 'autoplay; encrypted-media'
    frame.referrerPolicy = 'strict-origin-when-cross-origin'
    frame.src = src(c)
    // the player only answers once it has loaded; the first volume push
    // rides on that, and `update` keeps pushing as the listener moves
    frame.addEventListener('load', () => {
      post('unMute')
      sent = -1
    })
    el.appendChild(frame)
  }

  const power = (want: boolean) => {
    if (want === on) return
    on = want
    hole.visible = on
    css.visible = on
    if (on) tune()
    else if (frame) {
      // off is off: the element goes, and with it the socket and the sound
      frame.remove()
      frame = null
    }
    propSnap(0.45)
  }

  const near = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    const dx = screen.centre.x - p.x
    const dy = screen.centre.y - p.y
    const dz = screen.centre.z - p.z
    if (dx * dx + dz * dz >= REACH2) return false
    const dd = dx * dx + dy * dy + dz * dz
    const dist = Math.sqrt(dd) || 1e-4
    return (dx * gaze.x + dy * gaze.y + dz * gaze.z) / dist >= AIM
  }

  const update = (listener: THREE.Vector3) => {
    if (!on) return
    if (!frame) return
    const d = listener.distanceTo(screen.centre)
    const k = Math.max(0, Math.min(1, (QUIET_AT - d) / (QUIET_AT - LOUD_AT)))
    // one postMessage per step of five, not one per frame
    const want = Math.round((VOLUME * k * k) / 5) * 5
    if (want === sent) return
    sent = want
    post('setVolume', [want])
    if (want === 0) post('mute')
    else post('unMute')
  }

  const prompt = (p: THREE.Vector3, gaze: THREE.Vector3) =>
    near(p, gaze) ? (on ? ('off' as const) : ('on' as const)) : null

  const use = (p: THREE.Vector3, gaze: THREE.Vector3) => {
    if (!near(p, gaze)) return false
    power(!on)
    return true
  }

  const turn = (by: number) => {
    // a dial turned on a dark set turns it on, the way a remote does
    if (!on) {
      power(true)
      return
    }
    channel = (channel + by + CHANNELS.length) % CHANNELS.length
    propSnap(0.2)
    tune()
  }

  const silence = () => power(false)

  const dispose = () => {
    power(false)
    cssScene.remove(css)
    el.remove()
    scene.remove(hole)
  }

  return {
    update,
    prompt,
    use,
    turn,
    silence,
    get on() {
      return on
    },
    get channel() {
      return CHANNELS[channel]
    },
    dispose,
  }
}
