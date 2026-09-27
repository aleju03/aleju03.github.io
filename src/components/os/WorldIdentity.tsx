import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import {
  DESIGN_LENS, buildPlayerBody, type PlayerPose, type PlayerRig,
} from '../../game/player/playerBody'
import { makeCollisionSet } from '../../game/physics/collision'
import { GEAR_BEAVER, GEAR_PHONES, requestBodyGeometry } from '../../game/player/bodyShape'
import { makeGlowTexture } from '../../game/core/textures'
import type { RagdollEnv } from '../../game/player/ragdoll'
import { CIRCLED, INK, INK_SOFT, MARK } from './paper'
import { Note, Rule } from './PaperMarks'
import {
  ACCENT_SWATCHES,
  BEAVER,
  FUR_SWATCHES,
  GLOW_SWATCHES,
  SHELL_SWATCHES,
  TRIM_SWATCHES,
  randomLook,
  HELMET_HAT,
  SPACESUIT,
  type PlayerLook,
} from '../../game/player/look'
import { useI18n } from '../../i18n'
import { createThumbStore, thumbKey, type ThumbFrame, type ThumbJob, type ThumbStore } from './lookThumbs'

/*
  Who you are in the shared world, and what you look like while being it: the
  character page of the pause screen (`PauseScreen.tsx`), not a screen of its
  own. You are a Polaroid taped to that sheet of paper, and the knobs are
  written on the paper beside you.

  It exists because of one screenshot. A visitor who walks out of the room
  without ever having touched the desktop is `guest-08c9` in an off-white
  robot, and both halves of that are the server's defaults rather than
  anybody's choice — the name because the chat server mints one for every
  anonymous socket, the body because there was never anywhere to change it.
  Neither was a bug; there was simply no screen.

  It was a modal over the pause menu first, and that was worse: the one thing
  a pause screen is for is *looking at where you are*, so hiding your own
  body behind a second dialog you had to go and find is exactly backwards.
  Now the pause menu opens on you. Nothing here manages its own visibility —
  the pause screen mounts this once, on the first pause of a session, and
  hides it with `display:none` afterwards so the WebGL context below is
  created once rather than on every press of escape.

  Four decisions worth keeping:

  - **The preview is the real body.** Not a drawing of it, not a sprite sheet
    — `buildPlayerBody()` again, in its own small renderer, running its own
    idle animation off the same springs the walk uses. The rig was built to
    be watched (`pose.show` scales the whole cinematic layer) and nothing in
    it is a singleton, so a second one costs a few dozen small meshes. The
    payoff is that what you see here is exactly what everyone else sees, down
    to the way it breathes. Its frame loop stops dead while the panel is
    hidden (`active`), so a paused-once session does not pay for it again.
  - **The wardrobe is shown, not named.** Each headgear, headset, build and
    outfit is a small snapshot of *you* wearing it, in your own colours,
    and hovering one tries it on the Polaroid. The snapshots are taken by
    the same renderer, with a second rig standing out of shot, one per frame
    into a corner of the canvas the frame then covers (`lookThumbs.ts`
    explains the bookkeeping), because a context per thumbnail would be
    two dozen WebGL contexts and browsers stop at sixteen.
  - **Colours come from a palette, never a colour well.** See `look.ts`: the
    world spends real effort on a tone map, and the fastest way to undo that
    is a free `<input type="color">`. Every swatch here already belongs.
  - **The name is asked for, not assumed.** Renaming goes through the chat
    server's `nick`, which refuses anything belonging to a registered
    account, so the field stays in its pending state until the socket answers
    rather than showing you a name nobody else will ever see.
*/

/** the eye height the preview's body is built at: the rig's own design lens
    point, so the group's scale comes out at exactly 1 and the camera framing
    below is in the same units the model was drawn in */
const PREVIEW_EYE = DESIGN_LENS
/** the idle turn is a slow sway around the front rather than a full
    turntable: a character screen whose subject spends half its time facing
    away is a screen you cannot pick a face colour on. Drag still goes all the
    way round, it just does not stay there on its own */
const SWAY_RAD = 0.44
const SWAY_HZ = 0.09
/** drag pixels to radians */
const DRAG_RATE = 0.011
/** a wardrobe snapshot, in CSS pixels: small enough that a row of nine
    overlapping ones fits beside the Polaroid, and drawn into the corner of
    the preview's own canvas, which is always bigger than this */
const SNAP_W = 50
const SNAP_H = 60
/** the snapshots stand three-quarters on, so a cap's brim and a hood's
    shape read as shapes and not as a flat front */
const SNAP_TURN = 0.42

/** is the geometry this look wears already built? (see bodyShape's queue:
    asking queues it, so a snapshot that is not ready now will be soon) */
const geometryReady = (l: PlayerLook) =>
  requestBodyGeometry(
    l.hat ?? 0,
    l.build ?? 0,
    (l.costume === BEAVER ? GEAR_BEAVER : 0) | ((l.phones ?? 0) > 0 ? GEAR_PHONES : 0),
  ) !== null

function BodyPreview({
  look,
  active,
  thumbs,
}: {
  look: PlayerLook
  active: boolean
  thumbs: ThumbStore
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rigRef = useRef<PlayerRig | null>(null)
  // read by the frame loop rather than closed over: the loop is built once
  // and has to see every later change without being rebuilt
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        // a 200px turntable has no business asking for the discrete GPU on a
        // laptop that is already running the world on it
        powerPreference: 'low-power',
      })
    } catch {
      return // no second context available; the panel still works, it is just flat
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // the world's grade, so a colour picked here is the colour that walks out
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.cursor = 'grab'
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40)
    camera.position.set(0, 2.05, 7.8)
    camera.lookAt(0, 1.72, 0)

    // a three-point rig standing in for a sunny afternoon: warm key, cool
    // sky fill, and a rim that separates a dark trim from a dark panel
    scene.add(new THREE.HemisphereLight('#cfe3ff', '#3a3630', 1.15))
    const key = new THREE.DirectionalLight('#fff4e2', 2.1)
    key.position.set(3.2, 5, 4.2)
    const rim = new THREE.DirectionalLight('#9dc0ff', 0.95)
    rim.position.set(-4, 2.4, -3.4)
    scene.add(key, rim)

    // a painted contact shadow. Cheaper than a shadow map and, on a body
    // that never leaves the middle of the frame, indistinguishable
    const shadowTex = makeGlowTexture('rgba(0,0,0,0.5)', 'rgba(0,0,0,0)')
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = 0.01
    scene.add(shadow)

    const pivot = new THREE.Group()
    scene.add(pivot)
    const rig = buildPlayerBody(PREVIEW_EYE, 34, look)
    // The body is modelled facing +Z (the dot eyes and the feet all
    // point that way), so with the camera on +Z it needs no turn at all. The
    // scene's `facing + Math.PI` is not the same thing and must not be copied
    // here: that π converts a compass yaw, where 0 means -Z, and applying it
    // to a preview shows you the back of your own head.
    rig.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false
    })
    pivot.add(rig.group)
    rigRef.current = rig

    // The photographer's model: a second rig in the same scene, hidden except
    // for the instant a snapshot is taken, so it shares the lights, the
    // shadow and every compiled program with the first one
    const snapPivot = new THREE.Group()
    snapPivot.rotation.y = SNAP_TURN
    snapPivot.visible = false
    scene.add(snapPivot)
    const snapRig = buildPlayerBody(PREVIEW_EYE, 34, look)
    snapRig.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false
    })
    snapPivot.add(snapRig.group)
    /** the top of a build's bare head, off its own geometry's bind box: the
        rig is built at its design size, so these are the units the camera
        is placed in */
    const crowns = new Map<number, number>()
    const crownOf = (build: number) => {
      let y = crowns.get(build)
      if (y === undefined) {
        const g = requestBodyGeometry(6, build, 0)
        if (!g) return 2.7
        if (!g.boundingBox) g.computeBoundingBox()
        y = g.boundingBox?.max.y ?? 2.7
        crowns.set(build, y)
      }
      return y
    }
    const snapCam = new THREE.PerspectiveCamera(30, SNAP_W / SNAP_H, 0.1, 40)
    const snapPose: PlayerPose = {
      dt: 0.05, gait: 0, crouchK: 0, grounded: true, run: false,
      yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
    }
    const snapEnv: RagdollEnv = {
      groundY: 0,
      collision: makeCollisionSet({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
    }
    const fullSize = new THREE.Vector2()
    /** one snapshot: dress the model, let its springs settle, draw it into
        the bottom-left corner of this canvas and copy that corner out. The
        normal frame drawn straight after covers the corner again before the
        browser ever presents it */
    const snap = (job: ThumbJob) => {
      snapRig.setLook(job.look)
      snapRig.reset()
      for (let i = 0; i < 10; i++) snapRig.update(snapPose, snapEnv)
      if (job.frame === 'head') {
        // framed on the crown this build actually has, bare (a tall bean's
        // is a hand above a stubby one's), with room above it for the
        // tallest hat, so every snapshot in a row is at the same scale and
        // the hats are compared against each other rather than zoomed to fit
        const top = crownOf(job.look.build ?? 0)
        const mid = top - 0.3
        const dist = 1.0 / Math.tan(THREE.MathUtils.degToRad(15))
        snapCam.position.set(0, mid + 0.35, dist)
        snapCam.lookAt(0, mid, 0)
      } else {
        // every build and the tallest hat stand inside the one frame, so
        // the row reads as the builds against each other
        snapCam.position.set(0, 2.05, 7.4)
        snapCam.lookAt(0, 1.72, 0)
      }
      const pr = renderer.getPixelRatio()
      const w = Math.round(SNAP_W * pr)
      const h = Math.round(SNAP_H * pr)
      const canvas = renderer.domElement
      if (canvas.width < w || canvas.height < h) return false
      pivot.visible = false
      snapPivot.visible = true
      renderer.getSize(fullSize)
      renderer.setViewport(0, 0, SNAP_W, SNAP_H)
      renderer.setScissor(0, 0, SNAP_W, SNAP_H)
      renderer.setScissorTest(true)
      renderer.clear()
      renderer.render(scene, snapCam)
      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, fullSize.x, fullSize.y)
      pivot.visible = true
      snapPivot.visible = false
      const pic = document.createElement('canvas')
      pic.width = w
      pic.height = h
      // a viewport's origin is the bottom left; an image's is the top left
      pic.getContext('2d')?.drawImage(canvas, 0, canvas.height - h, w, h, 0, 0, w, h)
      thumbs.put(job.key, pic)
      return true
    }

    // a body standing still, watched from outside: show = 1 runs the full
    // performance (head tracking, breathing springs) that the first-person
    // lens suppresses
    const pose: PlayerPose = {
      dt: 0, gait: 0, crouchK: 0, grounded: true, run: false,
      yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
    }
    const env: RagdollEnv = {
      groundY: 0,
      collision: makeCollisionSet({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
    }

    /** the drag offset only; the sway below is added on top, so letting go
        does not snap the body back to where the sway happens to be */
    let spin = 0
    let clock = 0
    let dragging: number | null = null
    const onDown = (e: PointerEvent) => {
      dragging = e.clientX
      renderer.domElement.setPointerCapture(e.pointerId)
      renderer.domElement.style.cursor = 'grabbing'
    }
    const onMove = (e: PointerEvent) => {
      if (dragging === null) return
      spin += (e.clientX - dragging) * DRAG_RATE
      dragging = e.clientX
    }
    const onUp = () => {
      dragging = null
      renderer.domElement.style.cursor = 'grab'
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)

    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    let raf = 0
    let last = performance.now()
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      // hidden means no frame at all: the panel stays mounted between pauses
      // so the context survives, but a turntable nobody can see must not be
      // drawing over the top of a live walk
      if (!activeRef.current) return
      clock += dt
      pivot.rotation.y = spin + Math.sin(clock * SWAY_HZ * Math.PI * 2) * SWAY_RAD
      pose.dt = dt
      rig.update(pose, env)
      // at most one snapshot a frame, taken before the frame proper so the
      // frame covers it; one whose body is still being built waits its turn
      const job = thumbs.next((j) => geometryReady(j.look))
      if (job) snap(job)
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onUp)
      rigRef.current = null
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        // the body's geometry is shared by every body in the session (the
        // world's included), so it is not this preview's to throw away
        if (!m.geometry.userData.shared) m.geometry.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat.dispose()
      })
      shadowTex.dispose()
      renderer.dispose()
      // hand the context back now rather than waiting for the GC: this one
      // opened beside the world's, and browsers count them
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
    // built once; repaints go through the effect below, which costs four
    // Color.set() calls rather than a whole body
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    rigRef.current?.setLook(look)
  }, [look])

  return <div ref={mountRef} className="h-full w-full" />
}

/** the lean of each snapshot in a row, in degrees: stuck down by hand, so
    no two agree, and the pattern is fixed so a row does not reshuffle
    itself every time the look changes */
const TILTS = [-2.6, 1.9, -1.1, 2.8, -1.9, 1.2, -2.9, 2.2, -0.9]

/**
  One snapshot of you wearing one option: a small photo with a white border,
  stuck to the sheet at its own angle and overlapping its neighbours, the way
  a row of prints dealt out on a desk would. The one you are wearing is
  ringed with the same marker as the paint dabs; hovering one tries it on
  the Polaroid.

  The picture itself arrives from the preview's frame loop (see
  `lookThumbs.ts`). Until the first one lands the photo is dark with the
  option's name written on it, and a later one (after a colour change)
  replaces the old picture only when it is ready, so a row never blinks.
*/
function Snap({
  store,
  look,
  frame,
  name,
  index,
  selected,
  onPick,
  onPeek,
}: {
  store: ThumbStore
  look: PlayerLook
  frame: ThumbFrame
  name: string
  index: number
  selected: boolean
  onPick: () => void
  onPeek: (on: boolean) => void
}) {
  const key = thumbKey(look, frame)
  const lookRef = useRef(look)
  useEffect(() => {
    lookRef.current = look
  })
  // asked for while it is on the sheet, and not a moment longer: a key that
  // goes out of use (a colour just changed) leaves the queue at once
  useEffect(() => store.want({ key, look: lookRef.current, frame }), [store, key, frame])
  const subscribe = useCallback((cb: () => void) => store.subscribe(key, cb), [store, key])
  const pic = useSyncExternalStore(subscribe, () => store.get(key))
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvasRef.current
    if (!pic || !c) return
    c.width = pic.width
    c.height = pic.height
    const g = c.getContext('2d')
    if (!g) return
    // the photo's own darkness and the warm glow behind the shoulders, as
    // on the Polaroid, painted under the transparent render
    g.fillStyle = '#221c17'
    g.fillRect(0, 0, c.width, c.height)
    const cx = c.width / 2
    const cy = c.height * 0.42
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, c.width * 0.62)
    glow.addColorStop(0, 'rgba(224,150,100,0.32)')
    glow.addColorStop(1, 'rgba(224,150,100,0)')
    g.fillStyle = glow
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(pic, 0, 0)
  }, [pic])
  const tilt = TILTS[index % TILTS.length]
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={selected}
      title={name}
      onClick={onPick}
      onPointerEnter={() => onPeek(true)}
      onPointerLeave={() => onPeek(false)}
      onFocus={() => onPeek(true)}
      onBlur={() => onPeek(false)}
      className={`relative -ml-3 shrink-0 cursor-pointer transition-transform duration-150 first:ml-0 hover:z-20 hover:-translate-y-1 focus-visible:z-20 focus-visible:-translate-y-1 ${
        selected ? 'z-10' : ''
      }`}
      style={{ rotate: `${tilt}deg` }}
    >
      <span
        className="block p-[3px] pb-[6px]"
        style={{
          background: 'linear-gradient(160deg, #fbf7ea, #efe7d3)',
          boxShadow: '0 3px 7px rgba(30,20,10,0.38)',
        }}
      >
        <span
          className="relative grid place-items-center overflow-hidden"
          style={{ width: SNAP_W, height: SNAP_H, background: '#221c17' }}
        >
          <span className="px-0.5 text-center font-mono text-[9px] leading-tight" style={{ color: '#a8977a' }}>
            {name}
          </span>
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        </span>
      </span>
      <span
        aria-hidden
        className={`pointer-events-none absolute -inset-[6px] transition-opacity ${
          selected ? 'opacity-100' : 'opacity-0'
        }`}
        style={CIRCLED}
      />
    </button>
  )
}

/** one wardrobe row: its name, the option under the pointer (or the one
    worn) written beside it, and a snapshot per option */
function Snaps({
  label,
  names,
  value,
  frame,
  variant,
  store,
  onPick,
  onPeek,
}: {
  label: string
  names: readonly string[]
  value: number
  frame: ThumbFrame
  variant: (i: number) => PlayerLook
  store: ThumbStore
  onPick: (i: number) => void
  onPeek: (look: PlayerLook | null) => void
}) {
  const [over, setOver] = useState<number | null>(null)
  return (
    <div className="min-w-0">
      <p className="flex items-baseline gap-2.5">
        <span className="font-display text-[17px] uppercase" style={{ color: INK_SOFT }}>
          {label}
        </span>
        <span className="font-display text-[15px] uppercase" style={{ color: over === null ? INK : MARK }}>
          {names[over ?? value]}
        </span>
      </p>
      <div className="mt-1.5 flex pl-1">
        {names.map((name, i) => (
          <Snap
            key={name}
            store={store}
            look={variant(i)}
            frame={frame}
            name={name}
            index={i}
            selected={i === value}
            onPick={() => onPick(i)}
            onPeek={(on) => {
              setOver(on ? i : null)
              onPeek(on ? variant(i) : null)
            }}
          />
        ))}
      </div>
    </div>
  )
}

/** one colour knob: its name pencilled over a row of eight pots of paint,
    dabbed out under the Polaroid like the chart beside a photo */
function Swatches({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: readonly string[]
  value: string
  onPick: (hex: string) => void
}) {
  return (
    <div>
      <p className="font-display text-[15px] leading-none uppercase" style={{ color: INK_SOFT }}>
        {label}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((hex) => {
          const active = hex.toLowerCase() === value.toLowerCase()
          return (
            <span key={hex} className="relative">
              <button
                type="button"
                aria-label={`${label} ${hex}`}
                aria-pressed={active}
                onClick={() => onPick(hex)}
                style={{
                  backgroundColor: hex,
                  // never a perfect disc: a dab of paint put down by hand
                  borderRadius: '50% 47% 53% 49% / 48% 52% 47% 53%',
                  boxShadow: `inset 0 -2px 3px rgba(0,0,0,0.16), 0 1px 2px ${INK}44`,
                }}
                className="block size-5 cursor-pointer transition-transform hover:scale-110"
              />
              {/* the one in use is ringed with the same marker as everything
                  else, outside the dab so the colour is never covered */}
              <span
                aria-hidden
                className={`pointer-events-none absolute -inset-[4px] transition-opacity ${
                  active ? 'opacity-100' : 'opacity-0'
                }`}
                style={CIRCLED}
              />
            </span>
          )
        })}
      </div>
    </div>
  )
}

export interface WorldIdentityProps {
  /** the look being edited; changes are applied live, to this preview and to
      the body standing in the world behind it */
  look: PlayerLook
  onLook: (look: PlayerLook) => void
  /** what the plate over your head currently says */
  name: string
  /** null when the name is not yours to change from here: a signed-in
      account owns its username, and an offline socket cannot ask */
  onRename: ((name: string) => void) | null
  /** why not, when onRename is null */
  renameNote: string
  /** the last rename's state, owned by the caller because the answer arrives
      on the socket rather than from this component */
  pending: boolean
  error: string | null
  /** the pause screen is actually up. False keeps the whole thing mounted —
      and its WebGL context alive — while stopping every frame it would draw */
  active: boolean
}

export default function WorldIdentity({
  look,
  onLook,
  name,
  onRename,
  renameNote,
  pending,
  error,
  active,
}: WorldIdentityProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(name)
  // the server is the authority on what our name is: when it answers — and it
  // may answer with a trimmed version of what was typed — the field follows
  // it rather than keeping a draft nobody accepted. Adjusted during render
  // rather than in an effect, which is the case React documents this for
  const [synced, setSynced] = useState(name)
  if (synced !== name) {
    setSynced(name)
    setDraft(name)
  }

  // the snapshots' bookkeeping, one per mounted sheet; the pictures are
  // taken by the preview's renderer, never by one of their own
  const [thumbs] = useState(createThumbStore)
  // an option under the pointer, tried on the Polaroid until it leaves
  const [peek, setPeek] = useState<PlayerLook | null>(null)

  const dirty = draft.trim() !== name && draft.trim().length > 0

  return (
    // no stage, no card, no field: the body stands on the screen and the
    // knobs are written beside it. On a narrow viewport the two stack and the
    // body keeps the top, because it is the half people want to look at
    <div className="flex flex-col items-start gap-7 sm:flex-row sm:gap-8">
      {/* A Polaroid of you, taped to the sheet at a slightly different angle
          than the sheet itself, because two things stuck to a wall by hand
          are never parallel. The photo window stays dark: the body is lit
          from a warm key and reads on paper the way a photograph does, not
          the way a cutout would. */}
      {/* the left column: you, and under you the paint you are wearing,
          dabbed out on the sheet beside the photo like a colour chart */}
      <div className="flex shrink-0 flex-col gap-6 self-start">
        <div
          className="relative shrink-0 self-start p-3 pb-9"
          style={{
            transform: 'rotate(2.4deg)',
            background: 'linear-gradient(160deg, #fbf7ea, #efe7d3)',
            boxShadow: `0 10px 22px rgba(30,20,10,0.45), 0 1px 0 rgba(255,255,255,0.7) inset`,
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute -top-3 left-1/2 h-6 w-20 -translate-x-1/2 rotate-[3deg]"
            style={{
              background: 'linear-gradient(90deg, rgba(246,240,224,.7), rgba(232,222,198,.55))',
              boxShadow: '0 1px 3px rgba(60,44,26,0.28)',
            }}
          />
          <div className="relative h-60 w-44 overflow-hidden sm:h-64 sm:w-48" style={{ background: '#221c17' }}>
            {/* The only light it gets: a glow behind the shoulders.

                It is sized `closest-side`, which is the whole trick: a gradient
                is painted inside its element's box, so an ellipse still
                carrying colour when it reaches an edge is chopped off square
                there. Sized to the nearest side it has reached transparent
                before every edge, including the corners, and there is nothing
                left to cut. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(closest-side_at_50%_40%,rgba(224,150,100,0.3),transparent)]"
            />
            <BodyPreview look={peek ?? look} active={active} thumbs={thumbs} />
          </div>
          <span
            className="pointer-events-none absolute inset-x-0 bottom-2.5 text-center font-mono text-[11px]"
            style={{ color: peek ? MARK : INK_SOFT }}
          >
            {peek ? t.look.trying : t.look.dragToTurn}
          </span>
        </div>
        <div className="flex flex-col gap-2 pl-1">
          {/* the beaver's fur, only while the beaver is on: the pots are the
              three browns it comes in, and the pick is an index on the wire */}
          {look.costume === BEAVER && (
            <Swatches
              label={t.look.fur}
              options={FUR_SWATCHES}
              value={FUR_SWATCHES[look.fur] ?? FUR_SWATCHES[0]}
              onPick={(hex) => onLook({ ...look, fur: Math.max(0, FUR_SWATCHES.indexOf(hex as (typeof FUR_SWATCHES)[number])) })}
            />
          )}
          <Swatches
            label={t.look.suit}
            options={SHELL_SWATCHES}
            value={look.shell}
            onPick={(shell) => onLook({ ...look, shell })}
          />
          <Swatches
            label={t.look.trim}
            options={TRIM_SWATCHES}
            value={look.trim}
            onPick={(trim) => onLook({ ...look, trim })}
          />
          <Swatches
            label={t.look.accent}
            options={ACCENT_SWATCHES}
            value={look.accent}
            onPick={(accent) => onLook({ ...look, accent })}
          />
          <Swatches
            label={t.look.glow}
            options={GLOW_SWATCHES}
            value={look.glow}
            onPick={(glow) => onLook({ ...look, glow })}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <div>
          <Note>{t.look.name}</Note>
          {/* A name is the chat server's to give: it is the socket's `nick`,
              the same one the chat rail and the arcade boards use, and it
              refuses anything that belongs to a registered account. So when
              there is nobody to ask (offline, or signed in to an account that
              owns its username) this is not an input at all.

              It used to be a disabled one, which is worse than useless: a
              caret-shaped field saying "your name" that swallows every key
              you press reads as broken, not as unavailable. The note under it
              says which of the two reasons applies. */}
          {onRename ? (
            <form
              className="mt-1 flex items-baseline gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (dirty && !pending) onRename(draft.trim())
              }}
            >
              <input
                type="text"
                value={draft}
                maxLength={24}
                disabled={pending}
                onChange={(e) => setDraft(e.target.value)}
                // the OS shell and the roam input both listen at the window; while
                // this field has focus the keys are its own
                onKeyDown={(e) => e.stopPropagation()}
                className="font-display min-w-0 flex-1 bg-transparent text-[30px] uppercase outline-none"
                style={{ color: INK }}
                placeholder={t.look.yourName}
              />
              {dirty && (
                <button
                  type="submit"
                  disabled={pending}
                  className="font-display shrink-0 cursor-pointer text-[19px] uppercase disabled:cursor-default"
                  style={{ color: pending ? INK_SOFT : MARK }}
                >
                  {pending ? '…' : t.look.set}
                </button>
              )}
            </form>
          ) : (
            <p
              className="font-display mt-1 truncate text-[30px] uppercase"
              style={{ color: name ? INK : `${INK}55` }}
            >
              {name || t.look.nobody}
            </p>
          )}
          {/* the line it is written on */}
          <Rule className="w-[80%]" color={`${INK}66`} />
          <p className="mt-1 font-mono text-[11px]" style={{ color: error ? '#a8442e' : INK_SOFT }}>
            {error ?? (onRename ? t.look.nameRule : renameNote)}
          </p>
        </div>

        {/* The wardrobe: a row of snapshots per choice, each one you in that
            option, in your own colours. It was rows of words, and a word
            like "bucket hat" or "stubby" asks you to imagine the thing the
            sheet could simply show you. Hovering a snapshot tries it on the
            Polaroid; clicking keeps it. */}
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <Note>{t.look.wardrobe}</Note>
            <span className="flex items-baseline gap-4">
              {/* the astronaut in one tap: both halves of it, over your own
                  colours. Offered, never forced, on the Moon or anywhere */}
              <button
                type="button"
                aria-pressed={look.hat === HELMET_HAT && look.costume === SPACESUIT}
                onClick={() => onLook({ ...look, hat: HELMET_HAT, costume: SPACESUIT })}
                className="font-display cursor-pointer text-[16px] uppercase underline decoration-dotted underline-offset-4"
                style={{ color: INK_SOFT }}
              >
                {t.look.suitUp}
              </button>
              <button
                type="button"
                onClick={() => onLook(randomLook())}
                className="font-display cursor-pointer text-[16px] uppercase underline decoration-dotted underline-offset-4"
                style={{ color: INK_SOFT }}
              >
                {t.look.surprise}
              </button>
            </span>
          </div>
          <Snaps
            label={t.look.hat}
            names={t.look.hats}
            value={look.hat}
            frame="head"
            variant={(hat) => ({ ...look, hat })}
            store={thumbs}
            onPick={(hat) => onLook({ ...look, hat })}
            onPeek={setPeek}
          />
          {/* the headphones are worn over whatever the row above picked (the
              helmet leaves them off), and the shape is the whole body: two
              short rows, so they share a line */}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Snaps
              label={t.look.phones}
              names={t.look.phonesKinds}
              value={look.phones}
              frame="head"
              variant={(phones) => ({ ...look, phones })}
              store={thumbs}
              onPick={(phones) => onLook({ ...look, phones })}
              onPeek={setPeek}
            />
            <Snaps
              label={t.look.shape}
              names={t.look.builds}
              value={look.build}
              frame="body"
              variant={(build) => ({ ...look, build })}
              store={thumbs}
              onPick={(build) => onLook({ ...look, build })}
              onPeek={setPeek}
            />
          </div>
          <Snaps
            label={t.look.outfit}
            names={t.look.costumes}
            value={look.costume}
            frame="body"
            variant={(costume) => ({ ...look, costume })}
            store={thumbs}
            onPick={(costume) => onLook({ ...look, costume })}
            onPeek={setPeek}
          />
        </div>
      </div>
    </div>
  )
}
