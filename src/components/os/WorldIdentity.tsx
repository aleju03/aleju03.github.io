import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { buildPlayerBody, type PlayerPose, type PlayerRig } from '../../game/player/playerBody'
import { makeCollisionSet } from '../../game/physics/collision'
import { makeGlowTexture } from '../../game/core/textures'
import type { RagdollEnv } from '../../game/player/ragdoll'
import { CIRCLED, INK, INK_SOFT, MARK } from './paper'
import { Note, Rule } from './PaperMarks'
import {
  ACCENT_SWATCHES,
  GLOW_SWATCHES,
  SHELL_SWATCHES,
  TRIM_SWATCHES,
  randomLook,
  type PlayerLook,
} from '../../game/player/look'

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

/** one knob: a name on the left, its eight pots of paint flowing right. The
    label column is fixed so the four rows read as a chart rather than as four
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
    <div className="flex items-center gap-4">
      <p className="font-display w-16 shrink-0 text-[17px] uppercase" style={{ color: INK_SOFT }}>
        {label}
      </p>
      <div className="flex flex-wrap gap-2.5">
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
                className="block size-7 cursor-pointer transition-transform hover:scale-110"
              />
              {/* the one in use is ringed with the same marker as everything
                  else, outside the dab so the colour is never covered */}
              <span
                aria-hidden
                className={`pointer-events-none absolute -inset-[5px] transition-opacity ${
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
    // no stage, no card, no field: the body stands on the screen and the
    // knobs are written beside it. On a narrow viewport the two stack and the
    // body keeps the top, because it is the half people want to look at
    <div className="flex flex-col items-start gap-7 sm:flex-row sm:gap-9">
      {/* A Polaroid of you, taped to the sheet at a slightly different angle
          than the sheet itself, because two things stuck to a wall by hand
          are never parallel. The photo window stays dark: the body is lit
          from a warm key and reads on paper the way a photograph does, not
          the way a cutout would. */}
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
          <BodyPreview look={look} active={active} />
        </div>
        <span
          className="pointer-events-none absolute inset-x-0 bottom-2.5 text-center font-mono text-[11px]"
          style={{ color: INK_SOFT }}
        >
          drag to turn
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <div>
          <Note>name</Note>
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
                className="font-display min-w-0 flex-1 bg-transparent text-[32px] uppercase outline-none"
                style={{ color: INK }}
                placeholder="your name"
              />
              {dirty && (
                <button
                  type="submit"
                  disabled={pending}
                  className="font-display shrink-0 cursor-pointer text-[19px] uppercase disabled:cursor-default"
                  style={{ color: pending ? INK_SOFT : MARK }}
                >
                  {pending ? '…' : 'set'}
                </button>
              )}
            </form>
          ) : (
            <p
              className="font-display mt-1 truncate text-[32px] uppercase"
              style={{ color: name ? INK : `${INK}55` }}
            >
              {name || 'nobody yet'}
            </p>
          )}
          {/* the line it is written on */}
          <Rule className="w-[80%]" color={`${INK}66`} />
          <p className="mt-1 font-mono text-[11px]" style={{ color: error ? '#a8442e' : INK_SOFT }}>
            {error ?? (onRename ? 'letters, numbers, spaces, _ . -' : renameNote)}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <Note>colours</Note>
            <button
              type="button"
              onClick={() => onLook(randomLook())}
              className="font-display cursor-pointer text-[17px] uppercase underline decoration-dotted underline-offset-4"
              style={{ color: INK_SOFT }}
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
    </div>
  )
}
