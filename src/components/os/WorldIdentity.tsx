import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { buildPlayerBody, type PlayerPose, type PlayerRig } from '../../game/player/playerBody'
import { makeCollisionSet } from '../../game/physics/collision'
import { makeGlowTexture } from '../../game/core/textures'
import type { RagdollEnv } from '../../game/player/ragdoll'
import {
  ACCENT_SWATCHES,
  GLOW_SWATCHES,
  SHELL_SWATCHES,
  TRIM_SWATCHES,
  randomLook,
  type PlayerLook,
} from '../../game/player/look'

/*
  Who you are in the shared world, and what you look like while being it —
  the left-hand column of the pause screen (`CrtScene.tsx`), not a screen of
  its own.

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

  Three decisions worth keeping:

  - **The preview is the real body.** Not a drawing of it, not a sprite sheet
    — `buildPlayerBody()` again, in its own small renderer, running its own
    idle animation off the same springs the walk uses. The rig was built to
    be watched (`pose.show` scales the whole cinematic layer) and nothing in
    it is a singleton, so a second one costs a few dozen small meshes. The
    payoff is that what you see here is exactly what everyone else sees, down
    to the way it breathes. Its frame loop stops dead while the panel is
    hidden (`active`), so a paused-once session does not pay for it again.
  - **Colours come from a palette, never a colour well.** See `look.ts`: the
    world spends real effort on a tone map, and the fastest way to undo that
    is a free `<input type="color">`. Every swatch here already belongs.
  - **The name is asked for, not assumed.** Renaming goes through the chat
    server's `nick`, which refuses anything belonging to a registered
    account, so the field stays in its pending state until the socket answers
    rather than showing you a name nobody else will ever see.
*/

/** the eye height the preview's body is built at — the rig's own design
    height, so the proportions need no scaling and the camera framing below
    is in the same units the model was drawn in */
const PREVIEW_EYE = 3.5
/** the idle turn is a slow sway around the front rather than a full
    turntable: a character screen whose subject spends half its time facing
    away is a screen you cannot pick a face colour on. Drag still goes all the
    way round, it just does not stay there on its own */
const SWAY_RAD = 0.44
const SWAY_HZ = 0.09
/** drag pixels to radians */
const DRAG_RATE = 0.011

function BodyPreview({ look, active }: { look: PlayerLook; active: boolean }) {
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
    // The body is modelled facing +Z — visor, belly screen and toe caps all
    // point that way — so with the camera on +Z it needs no turn at all. The
    // scene's `facing + Math.PI` is not the same thing and must not be copied
    // here: that π converts a compass yaw, where 0 means -Z, and applying it
    // to a preview shows you the back of your own head.
    rig.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false
    })
    pivot.add(rig.group)
    rigRef.current = rig

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
        m.geometry.dispose()
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
    // Color.set() calls rather than a whole robot
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    rigRef.current?.setLook(look)
  }, [look])

  return <div ref={mountRef} className="h-full w-full" />
}

/** one knob: a name on the left, its eight choices flowing right. The label
    column is fixed so the four rows read as a grid rather than as four
    unrelated lines */
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
    <div className="flex items-center gap-2">
      <p className="w-11 shrink-0 text-[10px] text-stone-500">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((hex) => {
          const active = hex.toLowerCase() === value.toLowerCase()
          return (
            <button
              key={hex}
              type="button"
              aria-label={`${label} ${hex}`}
              aria-pressed={active}
              onClick={() => onPick(hex)}
              style={{ backgroundColor: hex }}
              className={`size-5 cursor-pointer rounded transition-transform ${
                active
                  // the ring rides outside the swatch, so the selected colour
                  // is never partly covered by the thing marking it
                  ? 'ring-2 ring-stone-200 ring-offset-1 ring-offset-stone-950'
                  : 'hover:scale-110'
              }`}
            />
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

  const dirty = draft.trim() !== name && draft.trim().length > 0

  return (
    // the width is not free: it is the narrowest column that fits a label and
    // eight swatches on one line, and a wrapped swatch row turns four tidy
    // rows into eight ragged ones with their labels floating between them
    <div className="flex w-full flex-col gap-3 sm:w-64 sm:shrink-0">
      {/* the body, given the room it deserves: this is the half of a pause
          screen people actually want to look at */}
      <div className="relative h-60 overflow-hidden rounded-md border border-stone-800 bg-[radial-gradient(ellipse_at_50%_35%,rgba(120,130,145,0.22),transparent_70%)]">
        <BodyPreview look={look} active={active} />
        <span className="pointer-events-none absolute right-2 bottom-1.5 text-[9px] text-stone-600">
          drag to turn
        </span>
      </div>

      <div>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (onRename && dirty && !pending) onRename(draft.trim())
          }}
        >
          <input
            type="text"
            value={draft}
            maxLength={24}
            disabled={!onRename || pending}
            onChange={(e) => setDraft(e.target.value)}
            // the OS shell and the roam input both listen at the window; while
            // this field has focus the keys are its own
            onKeyDown={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 rounded-md border border-stone-700 bg-stone-900/70 px-2 py-1.5 text-[12px] text-stone-200 outline-none placeholder:text-stone-700 focus:border-stone-500 disabled:text-stone-500"
            placeholder="your name"
          />
          {onRename && dirty && (
            <button
              type="submit"
              disabled={pending}
              className="shrink-0 cursor-pointer rounded-md border border-stone-500 px-2.5 py-1.5 text-[11px] text-stone-200 transition-colors hover:border-stone-300 hover:text-white disabled:cursor-default disabled:border-stone-800 disabled:text-stone-700"
            >
              {pending ? '…' : 'set'}
            </button>
          )}
        </form>
        <p
          className={`mt-1 text-[9px] ${error ? 'text-amber-400/90' : 'text-stone-600'}`}
        >
          {error ?? (onRename ? 'letters, numbers, spaces, _ . -' : renameNote)}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] tracking-wide text-stone-500 uppercase">colours</span>
          <button
            type="button"
            onClick={() => onLook(randomLook())}
            className="cursor-pointer text-[10px] text-stone-600 transition-colors hover:text-stone-300"
          >
            surprise me
          </button>
        </div>
        <Swatches
          label="shell"
          options={SHELL_SWATCHES}
          value={look.shell}
          onPick={(shell) => onLook({ ...look, shell })}
        />
        <Swatches
          label="trim"
          options={TRIM_SWATCHES}
          value={look.trim}
          onPick={(trim) => onLook({ ...look, trim })}
        />
        <Swatches
          label="joints"
          options={ACCENT_SWATCHES}
          value={look.accent}
          onPick={(accent) => onLook({ ...look, accent })}
        />
        <Swatches
          label="eyes"
          options={GLOW_SWATCHES}
          value={look.glow}
          onPick={(glow) => onLook({ ...look, glow })}
        />
      </div>
    </div>
  )
}
