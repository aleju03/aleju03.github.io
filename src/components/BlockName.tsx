import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js'
import type { HeroNameFontPreset } from './heroNameFonts'
import { isCoarsePointer } from '../device'
import { onOverlayChange, overlayIsOpen } from '../overlay'
import { provideWarpOrigin, warpToOs } from '../warp'
import { THEME_FADE_MS } from '../theme'

/*
  The hero name as chunky 3D letter blocks. The canvas covers the WHOLE hero
  section (pointer-events: none, listeners live on the section) so dragged
  letters never hit a canvas edge; the assembled name is mapped onto the
  in-flow slot element that Hero provides. Each letter is one block: grab it
  with the mouse or a finger and drop it anywhere, letters trade places when
  you drop one on another's slot. Touch drags swallow the gesture only when a
  letter is actually grabbed, so the page still scrolls everywhere else. Hero
  owns the static fallback and the reset button; this component reports
  readiness and scramble state through callbacks.

  A paper plane shares the scene — the same dart that loops through the
  contact illustration at the foot of the page, folded in 3D. WASD flies it
  (viewed from above, like a tabletop), Shift is a boost and Space is a
  swoop that breaks lateral grip so it carves wide sliding arcs. It inks a
  blue dashed contrail behind itself while flying, so a carved loop draws
  the illustration's looping dashes. Ramming the name sends letters flying;
  their springs pull them back home. An HTML control hint hangs under the
  parked plane and fades for good on the first flight key; on touch screens
  it reads "tap the plane to fly" instead, and tapping the plane toggles
  on-screen controls: a left-thumb joystick that maps to screen-space flight
  direction, plus swoop and boost buttons under the right thumb that feed
  the same key set as the keyboard — so one thumb steers while the other
  swoops.

  The canvas is FIXED to the viewport and the world is pinned to the
  document: the camera slides down with the scroll position, so the plane
  can fly across the entire page, and while it's being flown the page
  scrolls along to keep it in view. Keys (including Space, which is purely
  the swoop) only register while the plane is on screen and the user
  isn't typing; arrow keys are left alone so the page always scrolls.

  At the foot of the page the same world holds the wreck: the OS's own
  computer (the AJU 700FD from CrtScene) lying tilted above the footer,
  mapped onto a stage element that Contact renders. A terminal cursor
  blinks in the corner of its dead screen (faster under a hover, while the
  whole thing perks up a little). Flying the plane into the glass wakes a
  suction: fight it and you can boost back out, hold course for about a
  second and the screen reels the plane down a spiral and swallows it,
  warping into AlejOS — the same wormhole a click on the wreck opens.
*/

const LINES = [
  { word: 'ALEJANDRO', accent: false },
  { word: 'JIMÉNEZ', accent: true },
]
const DEPTH = 2.2

// front faces and extrusion sides get separate colors so the blocks read as
// sculpted material in both themes instead of a flat dark slab
const COLORS = {
  light: { face: '#faf8f0', side: '#7d725f', accentFace: '#2563eb', accentSide: '#1e3a8a' },
  dark: { face: '#fbf2e5', side: '#807160', accentFace: '#3b82f6', accentSide: '#1e40af' },
}

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

interface BlockNameProps {
  fontPreset: HeroNameFontPreset
  /** in-flow element marking where the assembled name should sit */
  slotRef: React.RefObject<HTMLDivElement | null>
  /** Hero calls this to spring every letter back home */
  resetRef: React.RefObject<() => void>
  /** fires once the blocks are built and visible */
  onActive: (active: boolean) => void
  onScrambled: (scrambled: boolean) => void
}

export default function BlockName({
  fontPreset,
  slotRef,
  resetRef,
  onActive,
  onScrambled,
}: BlockNameProps) {
  const ref = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLSpanElement>(null)
  const padRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    const slotEl = slotRef.current
    const sectionEl = el?.parentElement
    if (!el || !slotEl || !sectionEl || !supportsWebGL()) return

    // the control hint hangs off the parked plane: wasd keys on mouse-only
    // devices, a tap-to-fly nudge anywhere a finger could be the input.
    // maxTouchPoints catches mobile emulators that report a fine pointer
    const hintEl = hintRef.current
    const coarse = isCoarsePointer()
    const canFly =
      !coarse &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      navigator.maxTouchPoints === 0
    if (hintEl && !canFly) hintEl.textContent = 'tap the plane to fly'

    let disposed = false
    const disposers: (() => void)[] = []
    let paused = coarse && overlayIsOpen()

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.35 : 2))
    renderer.setSize(el.clientWidth, el.clientHeight)
    // start transparent and fade in once the first frame is rendered in place,
    // so the assembled name develops depth over the static fallback instead of
    // popping or colliding with it mid-assembly
    renderer.domElement.style.opacity = '0'
    renderer.domElement.style.transition = 'opacity 400ms ease-out'
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(26, 2, 0.1, 600)

    scene.add(new THREE.AmbientLight('#ffffff', 1.5))
    const keyLight = new THREE.DirectionalLight('#ffffff', 2.4)
    keyLight.position.set(8, 14, 18)
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight('#ffffff', 0.5)
    fillLight.position.set(-10, -6, 8)
    scene.add(fillLight)

    // holder carries the slot offset, swing carries the parallax tilt,
    // so the tilt pivots around the name itself
    const holder = new THREE.Group()
    const swing = new THREE.Group()
    holder.add(swing)
    scene.add(holder)

    const faceMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 })
    const sideMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 })
    const accentFaceMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 })
    const accentSideMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 })
    // a 0..1 light->dark mix lets the materials fade in step with the page's
    // .theme-fade color crossfade instead of snapping to the new palette
    const matPairs = (['face', 'side', 'accentFace', 'accentSide'] as const).map((key, i) => ({
      mat: [faceMat, sideMat, accentFaceMat, accentSideMat][i],
      light: new THREE.Color(COLORS.light[key]),
      dark: new THREE.Color(COLORS.dark[key]),
    }))
    const applyColors = (mix: number) => {
      for (const p of matPairs) p.mat.color.lerpColors(p.light, p.dark, mix)
    }
    const isDark = () => document.documentElement.classList.contains('dark')
    let themeMix = isDark() ? 1 : 0
    applyColors(themeMix)
    let themeFadeRaf = 0
    const themeObserver = new MutationObserver(() => {
      const target = isDark() ? 1 : 0
      if (target === themeMix) return // class churn (e.g. .theme-fade itself), not a theme flip
      cancelAnimationFrame(themeFadeRaf)
      // no .theme-fade means the circular wipe is revealing the new theme
      // behind a moving edge — colors must land instantly to keep it crisp
      if (!document.documentElement.classList.contains('theme-fade')) {
        themeMix = target
        applyColors(themeMix)
        return
      }
      const from = themeMix
      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min((now - start) / THEME_FADE_MS, 1)
        themeMix = from + (target - from) * (1 - (1 - t) * (1 - t)) // ease-out, like the CSS fade
        applyColors(themeMix)
        themeFadeRaf = t < 1 ? requestAnimationFrame(step) : 0
      }
      themeFadeRaf = requestAnimationFrame(step)
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    disposers.push(() => cancelAnimationFrame(themeFadeRaf))

    new FontLoader().load(fontPreset.typeface, (font) => {
      if (disposed) return

      const textOpts = {
        font,
        size: fontPreset.size,
        depth: DEPTH,
        curveSegments: 6,
        bevelEnabled: true,
        bevelThickness: 0.16,
        bevelSize: 0.12,
        bevelSegments: 2,
      }

      // build one block per letter, each centered on its own origin
      interface Block {
        node: THREE.Group
        width: number
      }
      const blocks: Block[] = []
      const slots: THREE.Vector3[] = []
      const lineWidths: number[] = []

      for (const [lineIdx, line] of LINES.entries()) {
        let cursor = 0
        for (const letter of line.word) {
          const node = new THREE.Group()
          // TextGeometry group 0 is front/back faces, group 1 is sides + bevel
          const mat = line.accent ? [accentFaceMat, accentSideMat] : [faceMat, sideMat]
          const geo = new TextGeometry(letter === 'É' ? 'E' : letter, textOpts)
          geo.computeBoundingBox()
          const bb = geo.boundingBox!
          const w = bb.max.x - bb.min.x
          geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -DEPTH / 2)
          node.add(new THREE.Mesh(geo, mat))
          disposers.push(() => geo.dispose())
          if (letter === 'É') {
            // the font has no É: stack a slanted block as the acute accent
            const accGeo = new THREE.BoxGeometry(
              fontPreset.accent.width,
              fontPreset.accent.height,
              DEPTH,
            )
            const acc = new THREE.Mesh(accGeo, accentFaceMat)
            acc.rotation.z = fontPreset.accent.rotation
            acc.position.set(
              fontPreset.accent.x,
              (bb.max.y - bb.min.y) / 2 + fontPreset.accent.y,
              0,
            )
            node.add(acc)
            disposers.push(() => accGeo.dispose())
          }
          node.userData.idx = blocks.length
          swing.add(node)
          blocks.push({ node, width: w })
          slots.push(new THREE.Vector3(cursor + w / 2, -lineIdx * fontPreset.lineSpacing, 0))
          cursor += w + fontPreset.gap
        }
        lineWidths.push(cursor - fontPreset.gap)
      }

      // left-align both lines and center the whole grid on the swing origin
      const totalW = Math.max(...lineWidths)
      for (const slot of slots) {
        slot.x -= totalW / 2
        slot.y += fontPreset.lineSpacing / 2
      }

      // the paper plane: two creased wing panels rising from a folded keel —
      // the classic dart, the same one that loops through the contact
      // illustration at the foot of the page. The paper is the letters' cream
      // face material with a hair of extrusion so the sheet has an edge, and
      // every panel carries a drawn outline in the letters' side color so it
      // reads on the cream background the way the hand-inked doodle does.
      // Nose points along +x.
      const outlineMat = new THREE.LineBasicMaterial()
      // share the letters' Color instances so the theme fade applies for free
      outlineMat.color = sideMat.color
      const streakMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75 })
      streakMat.color = accentFaceMat.color
      disposers.push(() => {
        outlineMat.dispose()
        streakMat.dispose()
      })
      // the scene shrinks with the name on small screens, which left the plane
      // looking like a crumb on phones; scale it back up so it stays a toy
      const planeScale = coarse ? 1.7 : 1
      const plane = new THREE.Group()
      const body = new THREE.Group()
      plane.add(body)
      const planeGeos: THREE.BufferGeometry[] = []
      const part = (
        geo: THREE.BufferGeometry,
        mat: THREE.Material | THREE.Material[],
        x: number,
        y: number,
        z: number,
      ) => {
        const mesh = new THREE.Mesh(geo, mat)
        mesh.position.set(x, y, z)
        planeGeos.push(geo)
        return mesh
      }
      const PAPER = 0.07 // sheet thickness
      const FOLD = 0.36 // dihedral: the wings rise from the keel in a shallow V
      // one sheet of paper: drawn flat in the top view, extruded paper-thin,
      // folded into place, then outlined. The fold must transform the GEOMETRY
      // (not the mesh) because the outline is derived from it afterwards.
      const sheet = (
        pts: [number, number][],
        mat: THREE.Material,
        fold: (geo: THREE.ExtrudeGeometry) => void,
      ) => {
        const shape = new THREE.Shape()
        shape.moveTo(pts[0][0], pts[0][1])
        for (const [x, y] of pts.slice(1)) shape.lineTo(x, y)
        shape.closePath()
        const geo = new THREE.ExtrudeGeometry(shape, { depth: PAPER, bevelEnabled: false })
        fold(geo)
        body.add(part(geo, mat, 0, 0, 0))
        const edgeGeo = new THREE.EdgesGeometry(geo)
        planeGeos.push(edgeGeo)
        body.add(new THREE.LineSegments(edgeGeo, outlineMat))
      }
      // wings: nose point, swept-back wingtip, root running just off the fold
      // line so the two panels never share a face to z-fight over
      for (const side of [1, -1]) {
        sheet(
          [
            [2.7, side * 0.02],
            [-2.1, side * 1.75],
            [-1.85, side * 0.06],
          ],
          faceMat,
          (geo) => geo.rotateX(side * FOLD),
        )
      }
      // the keel hangs under the fold — the spine you'd pinch to throw it; the
      // letters' darker side material reads as the shadowed inner crease
      sheet(
        [
          [2.7, 0],
          [-2.1, 0],
          [-2.1, -0.72],
        ],
        sideMat,
        (geo) => {
          geo.rotateX(Math.PI / 2) // stand it vertical, hanging below the fold
          geo.translate(0, PAPER / 2, 0) // center the sheet thickness on the spine
        },
      )
      // boost feedback: an accent-blue wind streak flickers behind each
      // wingtip while Shift is held (paper planes have no exhaust to flame)
      const streakGeo = new THREE.BoxGeometry(1.15, 0.06, 0.06)
      const streaks: THREE.Mesh[] = []
      for (const side of [-1, 1]) {
        const streak = part(streakGeo, streakMat, -2.85, side * 1.6, 0.5)
        streak.visible = false
        streaks.push(streak)
        body.add(streak)
      }
      disposers.push(() => planeGeos.forEach((g) => g.dispose()))
      // parked to the right of the name, nose pointed at it. The plane lives in
      // holder (not swing) so the pointer-parallax tilt, which pivots around
      // the name, can't sway it when it's driving far down the page
      const planePos = new THREE.Vector2(totalW / 2 + 7, -fontPreset.lineSpacing / 2)
      let heading = Math.PI * 0.85
      const planeVel = new THREE.Vector2()
      plane.position.set(planePos.x, planePos.y, 0)
      plane.rotation.z = heading
      plane.scale.setScalar(planeScale)
      holder.add(plane)

      // the contrail: the plane inks its path as the blue dashed line from the
      // contact illustration — a ring buffer of quads stitched between
      // consecutive tail positions, gated into dashes by distance flown and
      // fading through per-vertex alpha, so a carved loop draws the doodle's
      // looping dashes and then dissolves
      const TRAIL_QUADS = 200
      const TRAIL_LIFE = 3.2
      const TRAIL_HALF_W = 0.11
      const DASH_ON = 1.05 // world units of ink per dash...
      const DASH_CYCLE = 1.8 // ...within this repeat length
      const makeTrail = () => {
        const geo = new THREE.BufferGeometry()
        const posAttr = new THREE.BufferAttribute(new Float32Array(TRAIL_QUADS * 4 * 3), 3)
        const colAttr = new THREE.BufferAttribute(new Float32Array(TRAIL_QUADS * 4 * 4), 4)
        posAttr.setUsage(THREE.DynamicDrawUsage)
        colAttr.setUsage(THREE.DynamicDrawUsage)
        const col = colAttr.array as Float32Array
        // vertex RGB stays white; the material's (theme-faded) accent blue
        // multiplies in, leaving the vertex channel to carry only alpha
        for (let v = 0; v < TRAIL_QUADS * 4; v++) {
          col[v * 4] = 1
          col[v * 4 + 1] = 1
          col[v * 4 + 2] = 1
        }
        const index: number[] = []
        for (let q = 0; q < TRAIL_QUADS; q++)
          index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3)
        geo.setIndex(index)
        geo.setAttribute('position', posAttr)
        geo.setAttribute('color', colAttr)
        const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })
        mat.color = accentFaceMat.color // shared Color: theme fade applies for free
        const mesh = new THREE.Mesh(geo, mat)
        mesh.frustumCulled = false
        holder.add(mesh)
        disposers.push(() => {
          geo.dispose()
          mat.dispose()
        })
        return {
          posAttr,
          colAttr,
          ages: new Float32Array(TRAIL_QUADS).fill(TRAIL_LIFE),
          strengths: new Float32Array(TRAIL_QUADS),
          cursor: 0,
          hasPrev: false,
          edges: false,
          dist: 0,
          prevX: 0,
          prevY: 0,
          prevLX: 0,
          prevLY: 0,
          prevRX: 0,
          prevRY: 0,
        }
      }
      const trails = [makeTrail()]
      const trailBreak = () => {
        for (const tr of trails) {
          tr.hasPrev = false
          tr.edges = false
        }
      }
      const trailStamp = (tr: (typeof trails)[number], x: number, y: number, strength: number) => {
        const dx = x - tr.prevX
        const dy = y - tr.prevY
        const len = Math.hypot(dx, dy)
        if (!tr.hasPrev || len > 4) {
          // fresh flight (or a wrap teleport): just anchor the first point
          tr.hasPrev = true
          tr.edges = false
          tr.prevX = x
          tr.prevY = y
          return
        }
        if (len < 0.16) return // too short for a clean segment, wait for more
        tr.dist += len
        if (tr.dist % DASH_CYCLE > DASH_ON) {
          // the gap between dashes: slide the anchor forward without inking,
          // and break the ribbon so the next dash starts a fresh edge pair
          tr.edges = false
          tr.prevX = x
          tr.prevY = y
          return
        }
        const px = (-dy / len) * TRAIL_HALF_W
        const py = (dx / len) * TRAIL_HALF_W
        if (!tr.edges) {
          tr.prevLX = tr.prevX + px
          tr.prevLY = tr.prevY + py
          tr.prevRX = tr.prevX - px
          tr.prevRY = tr.prevY - py
          tr.edges = true
        }
        const q = tr.cursor
        tr.cursor = (q + 1) % TRAIL_QUADS
        const p = tr.posAttr.array as Float32Array
        const o = q * 12
        p[o] = tr.prevLX
        p[o + 1] = tr.prevLY
        p[o + 2] = -1
        p[o + 3] = tr.prevRX
        p[o + 4] = tr.prevRY
        p[o + 5] = -1
        p[o + 6] = x + px
        p[o + 7] = y + py
        p[o + 8] = -1
        p[o + 9] = x - px
        p[o + 10] = y - py
        p[o + 11] = -1
        tr.ages[q] = 0
        tr.strengths[q] = strength
        tr.posAttr.needsUpdate = true
        tr.prevX = x
        tr.prevY = y
        tr.prevLX = x + px
        tr.prevLY = y + py
        tr.prevRX = x - px
        tr.prevRY = y - py
      }
      const trailFade = (dt: number) => {
        for (const tr of trails) {
          let dirty = false
          const col = tr.colAttr.array as Float32Array
          for (let q = 0; q < TRAIL_QUADS; q++) {
            if (tr.ages[q] >= TRAIL_LIFE) continue
            tr.ages[q] += dt
            const alpha = Math.max(0, 1 - tr.ages[q] / TRAIL_LIFE) * tr.strengths[q] * 0.55
            const o = q * 16
            col[o + 3] = alpha
            col[o + 7] = alpha
            col[o + 11] = alpha
            col[o + 15] = alpha
            dirty = true
          }
          if (dirty) tr.colAttr.needsUpdate = true
        }
      }

      // horizontal roam bounds (the plane wraps at the real screen edges) plus
      // the world↔page mapping, refreshed by layout() below
      const flightBounds = { minX: -40, maxX: 40 }
      const view = { wpp: 0.05, W: 1200, H: 800 }

      // the wreck: the OS's own computer, dumped above the footer. Contact
      // owns the button (and its click boots the OS); this scene draws the
      // model over the button's stage span and reveals the button once the
      // GLB lands. The boot radius is measured off the actual glass mesh so
      // the plane has to reach the SCREEN, not just the furniture around it.
      const wreckStage = document.getElementById('os-wreck')
      const wreckBtn = wreckStage?.closest('button') ?? null
      let layoutWreck = () => {}
      const wreckScreen = new THREE.Vector2()
      let wreckScreenR = 0
      // the screen's pull on the plane: wreckSuck ramps toward 1 while the
      // plane fights the gravity well (still escapable), wreckCapture is the
      // scripted spiral once the screen wins, wreckSwallowed marks the plane
      // as living inside the OS until that session ends
      let wreckSuck = 0
      let wreckCapture: { t: number; ang: number; rad: number; warped: boolean } | null = null
      let wreckSwallowed = false
      let wreckSawOverlay = false
      let wreckHover = 0
      let wreckHoverTarget = 0
      let wreckCursor: THREE.Mesh | null = null
      let wreckNode: THREE.Group | null = null
      const WRECK_TILT_Z = 0.26
      if (wreckStage && wreckBtn) {
        new GLTFLoader().load('/os/models/computer.glb', (gltf) => {
          if (disposed) return
          const model = gltf.scene
          let glassMesh: THREE.Mesh | null = null
          model.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (!mesh.isMesh) return
            // the baked-on screen content belongs to the living machine in
            // CrtScene; this one is off
            if (mesh.name === 'screen_text') mesh.visible = false
            if (mesh.name === 'monitor_2') glassMesh = mesh
          })
          const glass = glassMesh as THREE.Mesh | null
          if (glass) {
            // dead glass, with a lone terminal cursor blinking in the corner
            // as the "still plugged in" tell — placed on the actual tube face
            // (raycast, like CrtScene does) since it tilts up on its stand
            const glassMat = new THREE.MeshStandardMaterial({ color: '#0d100e', roughness: 0.35 })
            glass.material = glassMat
            model.updateMatrixWorld(true)
            const gb = new THREE.Box3().setFromObject(glass)
            const gc = gb.getCenter(new THREE.Vector3())
            const gs = gb.getSize(new THREE.Vector3())
            const ray = new THREE.Raycaster(
              gc.clone().add(new THREE.Vector3(0, 0, 2)),
              new THREE.Vector3(0, 0, -1),
            )
            const hit = ray.intersectObject(glass, false)[0]
            const normal = hit?.face
              ? hit.face.normal.clone().transformDirection(glass.matrixWorld).normalize()
              : new THREE.Vector3(0, 0, 1)
            const anchor = hit ? hit.point.clone() : gc.clone()
            const curGeo = new THREE.PlaneGeometry(gs.x * 0.07, gs.y * 0.16)
            const curMat = new THREE.MeshBasicMaterial({ color: '#86efac' })
            const cur = new THREE.Mesh(curGeo, curMat)
            cur.position
              .copy(anchor)
              .addScaledVector(normal, gs.x * 0.03)
              .add(new THREE.Vector3(-gs.x * 0.3, gs.y * 0.22, 0))
            cur.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
            // the model is at identity here, so world coords double as
            // model-local ones; centering below moves the cursor along
            model.add(cur)
            wreckCursor = cur
            disposers.push(() => {
              glassMat.dispose()
              curGeo.dispose()
              curMat.dispose()
            })
          }
          // center the setup and normalize its height so layoutWreck can
          // size it in pixels; the outer group carries the fallen-over tilt
          const bb = new THREE.Box3().setFromObject(model)
          model.position.sub(bb.getCenter(new THREE.Vector3()))
          const inner = new THREE.Group()
          inner.scale.setScalar(1 / bb.getSize(new THREE.Vector3()).y)
          inner.add(model)
          const node = new THREE.Group()
          node.add(inner)
          node.rotation.set(0.12, -0.55, WRECK_TILT_Z)
          holder.add(node)
          wreckNode = node
          const baseSize = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3())
          wreckBtn.style.display = '' // reveal the stage; rects are valid below
          const hoverOn = () => {
            wreckHoverTarget = 1
          }
          const hoverOff = () => {
            wreckHoverTarget = 0
          }
          wreckBtn.addEventListener('pointerenter', hoverOn)
          wreckBtn.addEventListener('pointerleave', hoverOff)
          disposers.push(() => {
            wreckBtn.removeEventListener('pointerenter', hoverOn)
            wreckBtn.removeEventListener('pointerleave', hoverOff)
          })
          layoutWreck = () => {
            const wr = wreckStage.getBoundingClientRect()
            if (wr.width === 0) return
            node.scale.setScalar(
              Math.min((wr.height * view.wpp) / baseSize.y, (wr.width * view.wpp) / baseSize.x),
            )
            // same document pinning as the holder: stage center -> world,
            // then into holder space so planePos can compare directly
            node.position.set(
              (wr.left + wr.width / 2 - view.W / 2) * view.wpp - holder.position.x,
              -(wr.top + window.scrollY + wr.height / 2 - view.H / 2) * view.wpp -
                holder.position.y,
              0,
            )
            if (!glass) return
            node.updateMatrixWorld(true)
            const gBox = new THREE.Box3().setFromObject(glass)
            const gc = gBox.getCenter(new THREE.Vector3())
            const gs = gBox.getSize(new THREE.Vector3())
            wreckScreen.set(gc.x - holder.position.x, gc.y - holder.position.y)
            wreckScreenR = Math.max(gs.x, gs.y) * 0.62 + 1.4 * planeScale
          }
          layoutWreck()
          // the warp overlay irises out of the glass: hand it the live
          // viewport spot and size so the hole opens exactly where the
          // plane gets pulled in, at the size of the actual screen
          disposers.push(
            provideWarpOrigin(() => ({
              x: (wreckScreen.x + holder.position.x) / view.wpp + view.W / 2,
              y: view.H / 2 - (wreckScreen.y + holder.position.y) / view.wpp - window.scrollY,
              r: wreckScreenR / view.wpp,
            })),
          )
          // a swallowed plane only comes back once the OS it fed has opened
          // and closed again (the boot lags the warp's cover by a beat, so
          // polling overlayIsOpen inside tick() could miss the whole session)
          disposers.push(
            onOverlayChange((open) => {
              if (open && wreckSwallowed) wreckSawOverlay = true
            }),
          )
        })
      }

      // fit the camera to the viewport-sized canvas, then pin the world to
      // the DOCUMENT: origin sits at the viewport center at scroll 0, the
      // name parks over the slot's document position, and tick() slides the
      // camera down with the live scroll offset
      const layout = () => {
        const cr = el.getBoundingClientRect()
        const sr = slotEl.getBoundingClientRect()
        if (cr.width === 0 || cr.height === 0 || sr.width === 0) return
        renderer.setSize(el.clientWidth, el.clientHeight)
        camera.aspect = cr.width / cr.height
        const fitScale = cr.width < 640 ? 0.78 : cr.width < 900 ? 0.88 : 1
        const worldPerPixel = totalW / (sr.width * fitScale)
        const halfV = Math.tan((camera.fov * Math.PI) / 360)
        camera.position.z = (cr.height * worldPerPixel) / 2 / halfV
        camera.updateProjectionMatrix()
        const fittedWidth = sr.width * fitScale
        holder.position.x = (sr.left + fittedWidth / 2 - cr.width / 2) * worldPerPixel
        holder.position.y = -(sr.top + sr.height / 2 + window.scrollY - cr.height / 2) * worldPerPixel
        view.wpp = worldPerPixel
        view.W = cr.width
        view.H = cr.height
        const halfH = camera.position.z * halfV
        const halfW = halfH * camera.aspect
        flightBounds.minX = -halfW - holder.position.x
        flightBounds.maxX = halfW - holder.position.x
        layoutWreck()
      }
      layout()
      // the parking spot sits to the right of the name, which on phones can
      // fall past the screen edge; pull the plane back in so it stays tappable
      planePos.x = THREE.MathUtils.clamp(planePos.x, flightBounds.minX + 3.5 * planeScale, flightBounds.maxX - 3.5 * planeScale)
      plane.position.x = planePos.x
      // the hero content fades in with a small translate; re-measure after it lands
      const settleTimers = [setTimeout(layout, 600), setTimeout(layout, 1400)]
      disposers.push(() => settleTimers.forEach(clearTimeout))
      const resizeObserver = new ResizeObserver(layout)
      resizeObserver.observe(el)
      resizeObserver.observe(slotEl)
      disposers.push(() => resizeObserver.disconnect())

      const count = blocks.length
      // letters start assembled in their slots so the name lands aligned over
      // the static fallback; the scatter/spring physics still drive dragging
      // and the plane. A small initial tilt settles upright for a touch of life.
      const pos = slots.map((s) => s.clone())
      const vel = slots.map(() => new THREE.Vector3())
      const rot = slots.map(
        () =>
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.5,
            (Math.random() - 0.5) * 0.5,
            (Math.random() - 0.5) * 0.3,
          ),
      )
      const angVel = slots.map(() => new THREE.Vector3())
      const phase = slots.map((_, i) => (i * 2.399) % (Math.PI * 2))
      const assignment = slots.map((_, i) => i) // letter -> slot
      const letterRadius = blocks.map((b) => b.width / 2 + 0.9)
      const lastHit = slots.map(() => -Infinity)

      const syncScrambled = () => onScrambled(assignment.some((s, i) => s !== i))
      resetRef.current = () => {
        for (let i = 0; i < count; i++) assignment[i] = i
        syncScrambled()
      }
      onActive(true)

      // pointer handling lives on the section so the pass-through canvas
      // never blocks the CTAs: hover lift, drag with slot swap on mouse and touch
      const raycaster = new THREE.Raycaster()
      const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
      const planePoint = new THREE.Vector3()
      let hovered = -1
      let dragged = -1
      let tiltX = 0
      let tiltY = 0
      let tiltTargetX = 0
      let tiltTargetY = 0
      const dragTarget = new THREE.Vector3()

      const castFrom = (e: PointerEvent) => {
        const rect = el.getBoundingClientRect()
        raycaster.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
          ),
          camera,
        )
      }
      const pick = (e: PointerEvent) => {
        castFrom(e)
        const hit = raycaster.intersectObjects(swing.children, true)[0]
        let obj: THREE.Object3D | null = hit?.object ?? null
        while (obj && obj.userData.idx === undefined) obj = obj.parent
        return obj ? (obj.userData.idx as number) : -1
      }
      const toPlane = (e: PointerEvent) => {
        castFrom(e)
        if (!raycaster.ray.intersectPlane(dragPlane, planePoint)) return null
        return swing.worldToLocal(planePoint.clone())
      }

      // the touch pad toggles on a plane tap: the swoop/boost buttons feed the
      // same key set as the keyboard, while the joystick writes a screen-space
      // direction vector so mobile controls feel literal.
      const stick = { x: 0, y: 0, active: false }
      const padEl = padRef.current
      let resetStickControl = () => {
        stick.x = 0
        stick.y = 0
        stick.active = false
      }
      let padOpen = false
      const setPad = (open: boolean) => {
        if (!padEl) return
        padOpen = open
        padEl.style.visibility = open ? 'visible' : 'hidden'
        padEl.style.opacity = open ? '1' : '0'
        if (!open) resetStickControl()
      }

      const onViewportDown = (e: PointerEvent) => {
        if (e.pointerType !== 'touch' || !padOpen) return
        const path = e.composedPath()
        const target = e.target
        if ((target instanceof Node && padEl?.contains(target)) || (padEl && path.includes(padEl))) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        setPad(false)
      }
      window.addEventListener('pointerdown', onViewportDown)
      disposers.push(() => window.removeEventListener('pointerdown', onViewportDown))

      const onMove = (e: PointerEvent) => {
        const rect = el.getBoundingClientRect()
        tiltTargetY = (((e.clientX - rect.left) / rect.width) * 2 - 1) * 0.05
        tiltTargetX = (((e.clientY - rect.top) / rect.height) * 2 - 1) * 0.03
        if (dragged >= 0) {
          const p = toPlane(e)
          if (p) dragTarget.set(p.x, p.y, 2.4)
          return
        }
        hovered = e.pointerType === 'mouse' ? pick(e) : -1
        sectionEl.style.cursor = hovered >= 0 ? 'grab' : ''
      }
      const onDown = (e: PointerEvent) => {
        if (e.pointerType === 'touch') {
          // a tap near the plane (generous, thumb-sized hitbox) opens the touch
          // controls. Once open, the viewport listener above owns dismissal.
          const p = toPlane(e)
          if (p && (p.x - planePos.x) ** 2 + (p.y - planePos.y) ** 2 < 42 * planeScale * planeScale) {
            // stop here: this same pointerdown would otherwise bubble on to
            // the window-level dismiss listener, which now sees the pad as
            // open and closes it again in the same tap
            e.stopPropagation()
            setPad(true)
            if (!hintDone) {
              hintDone = true
              hintEl!.style.opacity = '0'
            }
            return
          }
        }
        const idx = pick(e)
        if (idx < 0) return
        e.preventDefault()
        dragged = idx
        sectionEl.setPointerCapture(e.pointerId)
        sectionEl.style.cursor = 'grabbing'
        const p = toPlane(e)
        if (p) dragTarget.set(p.x, p.y, 2.4)
      }
      const onUp = (e: PointerEvent) => {
        if (dragged < 0) return
        const idx = dragged
        dragged = -1
        try {
          sectionEl.releasePointerCapture(e.pointerId)
        } catch {
          // pointercancel already released the capture
        }
        sectionEl.style.cursor = ''
        // settle into the nearest slot; whoever lives there moves to the old one
        let nearest = 0
        let best = Infinity
        for (let s = 0; s < slots.length; s++) {
          const d = (pos[idx].x - slots[s].x) ** 2 + (pos[idx].y - slots[s].y) ** 2
          if (d < best) {
            best = d
            nearest = s
          }
        }
        const current = assignment[idx]
        if (nearest !== current) {
          const occupant = assignment.indexOf(nearest)
          if (occupant >= 0) assignment[occupant] = current
          assignment[idx] = nearest
          syncScrambled()
        }
      }
      const onLeave = () => {
        tiltTargetX = 0
        tiltTargetY = 0
        hovered = -1
        sectionEl.style.cursor = ''
      }
      // pointerdown runs before the matching touchstart, so by the time the
      // touch event arrives we know whether a letter was grabbed; swallowing
      // it then stops the browser from hijacking the gesture for scrolling,
      // while touches that miss the letters keep scrolling the page
      const onTouch = (e: TouchEvent) => {
        if (dragged >= 0) e.preventDefault()
      }
      sectionEl.addEventListener('pointermove', onMove)
      sectionEl.addEventListener('pointerdown', onDown)
      sectionEl.addEventListener('pointerup', onUp)
      sectionEl.addEventListener('pointercancel', onUp)
      sectionEl.addEventListener('pointerleave', onLeave)
      sectionEl.addEventListener('touchstart', onTouch, { passive: false })
      sectionEl.addEventListener('touchmove', onTouch, { passive: false })
      disposers.push(() => {
        sectionEl.removeEventListener('pointermove', onMove)
        sectionEl.removeEventListener('pointerdown', onDown)
        sectionEl.removeEventListener('pointerup', onUp)
        sectionEl.removeEventListener('pointercancel', onUp)
        sectionEl.removeEventListener('pointerleave', onLeave)
        sectionEl.removeEventListener('touchstart', onTouch)
        sectionEl.removeEventListener('touchmove', onTouch)
        sectionEl.style.cursor = ''
      })

      // WASD only registers while the CAR is on screen (it can be anywhere on
      // the page now) and the user is not typing somewhere; arrows are
      // untouched so the page always scrolls. tick() keeps planeOnScreen fresh.
      const keys = new Set<string>()
      let planeOnScreen = true
      let hintDone = !hintEl
      const isTyping = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null
        return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      }
      const onKeyDown = (e: KeyboardEvent) => {
        const k = e.key.toLowerCase()
        if (!planeOnScreen || overlayIsOpen() || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
        if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'shift') keys.add(k)
        // the hint has done its job the moment the plane first flies off
        if (!hintDone && (k === 'w' || k === 'a' || k === 's' || k === 'd')) {
          hintDone = true
          hintEl!.style.opacity = '0'
        }
        // Space is the swoop whenever the plane is around; swallowing the
        // default stops the browser's jarring page-down scroll
        if (k === ' ') {
          e.preventDefault()
          e.stopPropagation()
          keys.add(' ')
        }
      }
      const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())
      const onBlur = () => keys.clear()
      window.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('keyup', onKeyUp)
      window.addEventListener('blur', onBlur)
      disposers.push(() => {
        window.removeEventListener('keydown', onKeyDown, true)
        window.removeEventListener('keyup', onKeyUp)
        window.removeEventListener('blur', onBlur)
      })

      // pad buttons: press = key down, release = key up. Pointer capture
      // keeps the release reliable even if the finger slides off the button
      if (padEl) {
        for (const btn of Array.from(padEl.querySelectorAll<HTMLButtonElement>('button[data-key]'))) {
          const k = btn.dataset.key!
          const press = (e: PointerEvent) => {
            e.preventDefault()
            // don't bubble to the section, which would read this as a plane
            // tap (closing the pad) or a letter grab
            e.stopPropagation()
            try {
              btn.setPointerCapture(e.pointerId)
            } catch {
              // a pointer can vanish mid-gesture; the press still counts
            }
            keys.add(k)
            btn.style.transform = 'scale(0.88)'
          }
          const lift = () => {
            keys.delete(k)
            btn.style.transform = ''
          }
          const swallow = (e: Event) => e.preventDefault()
          btn.addEventListener('pointerdown', press)
          btn.addEventListener('pointerup', lift)
          btn.addEventListener('pointercancel', lift)
          btn.addEventListener('contextmenu', swallow)
          disposers.push(() => {
            btn.removeEventListener('pointerdown', press)
            btn.removeEventListener('pointerup', lift)
            btn.removeEventListener('pointercancel', lift)
            btn.removeEventListener('contextmenu', swallow)
            lift()
          })
        }

        // the joystick: knob displacement maps to screen-space direction.
        // Pointer capture keeps the knob glued to the thumb even when it
        // slides off the base circle.
        const stickEl = padEl.querySelector<HTMLDivElement>('[data-joystick]')
        const knobEl = stickEl?.querySelector<HTMLDivElement>('[data-knob]')
        if (stickEl && knobEl) {
          const REACH = 40 // px of knob travel for full deflection
          let stickPointer = -1
          const setKnob = (dx: number, dy: number) => {
            knobEl.style.transform = `translate(${dx}px, ${dy}px)`
          }
          const track = (e: PointerEvent) => {
            const r = stickEl.getBoundingClientRect()
            let dx = e.clientX - (r.left + r.width / 2)
            let dy = e.clientY - (r.top + r.height / 2)
            const len = Math.hypot(dx, dy)
            if (len > REACH) {
              dx *= REACH / len
              dy *= REACH / len
            }
            setKnob(dx, dy)
            // a small deadzone so a resting thumb doesn't creep the plane
            stick.x = Math.abs(dx) < 5 ? 0 : dx / REACH
            stick.y = Math.abs(dy) < 5 ? 0 : -dy / REACH
          }
          const stickDown = (e: PointerEvent) => {
            e.preventDefault()
            e.stopPropagation()
            stickPointer = e.pointerId
            try {
              stickEl.setPointerCapture(e.pointerId)
            } catch {
              // a pointer can vanish mid-gesture; tracking still works
            }
            knobEl.style.transition = 'none'
            stick.active = true
            track(e)
          }
          const stickMove = (e: PointerEvent) => {
            if (e.pointerId === stickPointer) track(e)
          }
          const stickUp = (e: PointerEvent) => {
            if (e.pointerId !== stickPointer) return
            stickPointer = -1
            knobEl.style.transition = 'transform 150ms ease-out'
            resetStickControl()
          }
          const swallowMenu = (e: Event) => e.preventDefault()
          resetStickControl = () => {
            stickPointer = -1
            stick.active = false
            stick.x = 0
            stick.y = 0
            knobEl.style.transition = 'transform 150ms ease-out'
            setKnob(0, 0)
          }
          stickEl.addEventListener('pointerdown', stickDown)
          stickEl.addEventListener('pointermove', stickMove)
          stickEl.addEventListener('pointerup', stickUp)
          stickEl.addEventListener('pointercancel', stickUp)
          stickEl.addEventListener('contextmenu', swallowMenu)
          disposers.push(() => {
            stickEl.removeEventListener('pointerdown', stickDown)
            stickEl.removeEventListener('pointermove', stickMove)
            stickEl.removeEventListener('pointerup', stickUp)
            stickEl.removeEventListener('pointercancel', stickUp)
            stickEl.removeEventListener('contextmenu', swallowMenu)
          })
        }
      }

      const target = new THREE.Vector3()
      const force = new THREE.Vector3()
      const hintWorld = new THREE.Vector3()
      let lastDocH = 0
      let raf = 0
      let revealed = false
      let last = performance.now()
      const tick = (now: number) => {
        if (paused) {
          raf = 0
          return
        }

        const dt = Math.min((now - last) / 1000, 0.033)
        last = now
        const t = now / 1000

        // the world is document-pinned: the camera rides the scroll position
        const scrollY = window.scrollY
        camera.position.y = -scrollY * view.wpp

        tiltX += (tiltTargetX - tiltX) * 0.06
        tiltY += (tiltTargetY - tiltY) * 0.06
        swing.rotation.x = -tiltX
        swing.rotation.y = tiltY

        for (let i = 0; i < count; i++) {
          const isDragged = i === dragged
          if (isDragged) {
            target.copy(dragTarget)
          } else {
            target.copy(slots[assignment[i]])
            target.y += Math.sin(t * 1.1 + phase[i]) * 0.07
            if (i === hovered) target.z += 0.9
          }
          const k = isDragged ? 160 : 30
          const damp = isDragged ? 16 : 6.2
          force.copy(target).sub(pos[i]).multiplyScalar(k)
          vel[i].addScaledVector(force, dt)
          vel[i].multiplyScalar(Math.max(0, 1 - damp * dt))
          pos[i].addScaledVector(vel[i], dt)

          if (isDragged) {
            // lean into the drag direction like the block has weight
            rot[i].y += (THREE.MathUtils.clamp(vel[i].x * 0.014, -0.3, 0.3) - rot[i].y) * 0.2
            rot[i].x += (THREE.MathUtils.clamp(-vel[i].y * 0.014, -0.3, 0.3) - rot[i].x) * 0.2
            angVel[i].set(0, 0, 0)
          } else {
            angVel[i].addScaledVector(rot[i], -24 * dt)
            angVel[i].multiplyScalar(Math.max(0, 1 - 6 * dt))
            rot[i].addScaledVector(angVel[i], dt)
          }

          blocks[i].node.position.copy(pos[i])
          blocks[i].node.rotation.set(rot[i].x, rot[i].y, rot[i].z)
        }

        // paper plane: heading and velocity are separate so air grip is a real
        // force. Velocity splits into forward + lateral parts each frame; grip
        // bleeds the lateral slip, and the Space swoop nearly turns grip off
        // while quickening the steering — that combination carves the wide
        // sliding arcs that ink the illustration's loops.
        const boost = keys.has('shift')
        const swooping = keys.has(' ')
        // Keyboard keeps the tabletop plane controls. Touch uses screen-space
        // direction instead: push down, the plane goes down regardless of where
        // its nose happened to be pointing.
        const stickMag = planeOnScreen ? Math.min(1, Math.hypot(stick.x, stick.y)) : 0
        const touchFly = stick.active && stickMag > 0
        let throttle = THREE.MathUtils.clamp(
          (keys.has('w') ? 1 : 0) -
            (keys.has('s') ? 0.6 : 0) +
            (planeOnScreen ? (stick.y > 0 ? stick.y : stick.y * 0.6) : 0),
          -0.6,
          1,
        )
        let steer = THREE.MathUtils.clamp(
          (keys.has('a') ? 1 : 0) - (keys.has('d') ? 1 : 0) - (planeOnScreen ? stick.x : 0),
          -1,
          1,
        )
        let fwdX = Math.cos(heading)
        let fwdY = Math.sin(heading)
        let fwd = planeVel.x * fwdX + planeVel.y * fwdY
        let lat = -planeVel.x * fwdY + planeVel.y * fwdX
        if (touchFly) {
          const desiredHeading = Math.atan2(stick.y, stick.x)
          const desiredSpeed = stickMag * (boost ? 42 : 28)
          const desiredX = Math.cos(desiredHeading) * desiredSpeed
          const desiredY = Math.sin(desiredHeading) * desiredSpeed
          const velocityEase = 1 - Math.exp(-(swooping ? 9 : 18) * dt)
          planeVel.x += (desiredX - planeVel.x) * velocityEase
          planeVel.y += (desiredY - planeVel.y) * velocityEase

          const turn = Math.atan2(Math.sin(desiredHeading - heading), Math.cos(desiredHeading - heading))
          heading += turn * (1 - Math.exp(-(swooping ? 7 : 14) * dt))
          throttle = stickMag
          steer = THREE.MathUtils.clamp(turn / (Math.PI / 2), -1, 1)
        } else {
          fwd += throttle * (boost ? 105 : 58) * dt
          // light drag so the plane glides on after the keys lift; S is an
          // airbrake with only a token reverse (it's a hover, not a gearbox)
          fwd *= Math.max(0, 1 - (swooping ? 2.2 : 1.15) * dt)
          fwd = THREE.MathUtils.clamp(fwd, -8, boost ? 48 : 30)
          lat *= Math.max(0, 1 - (swooping ? 1.8 : 7.5) * dt)
          heading += steer * (swooping ? 4.1 : 2.7) * dt * THREE.MathUtils.clamp(fwd / 9, -1, 1)
          planeVel.set(fwdX * fwd - fwdY * lat, fwdY * fwd + fwdX * lat)
        }
        fwdX = Math.cos(heading)
        fwdY = Math.sin(heading)
        fwd = planeVel.x * fwdX + planeVel.y * fwdY
        lat = -planeVel.x * fwdY + planeVel.y * fwdX
        planePos.addScaledVector(planeVel, dt)
        const spd = planeVel.length()
        // horizontal: wrap at the screen edges (break the trail so the ribbon
        // doesn't streak across); vertical: the plane ranges over the whole
        // document and bounces softly off the page's top and bottom
        const margin = 4
        if (planePos.x > flightBounds.maxX + margin || planePos.x < flightBounds.minX - margin) {
          planePos.x = planePos.x > 0 ? flightBounds.minX - margin : flightBounds.maxX + margin
          trailBreak()
        }
        const docH = document.documentElement.scrollHeight
        // late image loads (and the wreck button itself appearing) move the
        // foot of the page; re-pin the wreck whenever the document grows
        if (docH !== lastDocH) {
          lastDocH = docH
          layoutWreck()
        }
        const pageTopY = (view.H / 2) * view.wpp - holder.position.y - 3
        const pageBottomY = (view.H / 2 - docH) * view.wpp - holder.position.y + 3
        if (planePos.y > pageTopY) {
          planePos.y = pageTopY
          if (planeVel.y > 0) planeVel.y *= -0.35
          trailBreak()
        }
        if (planePos.y < pageBottomY) {
          planePos.y = pageBottomY
          if (planeVel.y < 0) planeVel.y *= -0.35
          trailBreak()
        }
        // the plane floats: a slow bob on z sells hovering over the page
        // instead of parking on it (collisions and trails stay 2D)
        plane.position.set(planePos.x, planePos.y, (0.3 + 0.14 * Math.sin(t * 1.6)) * planeScale)
        plane.rotation.z = heading
        // the control hint is HTML pinned a little below the plane in world
        // space, so it scales with the scene and scrolls off with the plane
        if (!hintDone) {
          hintWorld
            .set(planePos.x + holder.position.x, planePos.y - 3.6 * planeScale + holder.position.y, 0)
            .project(camera)
          // clamp onto the screen by the hint's measured size so a plane parked
          // near an edge (narrow viewports) can't drag any of the text out of
          // view — the touch wording is wider than half the old fixed margin
          const halfW = hintEl!.offsetWidth / 2 + 8
          const hx = THREE.MathUtils.clamp((hintWorld.x * 0.5 + 0.5) * view.W, halfW, view.W - halfW)
          const hy = THREE.MathUtils.clamp(
            (-hintWorld.y * 0.5 + 0.5) * view.H,
            12,
            view.H - hintEl!.offsetHeight - 12,
          )
          hintEl!.style.transform = `translate(${hx}px, ${hy}px) translate(-50%, 0)`
        }
        // body language: the plane banks INTO its turns (unlike the outward
        // lean of a car), digs in harder while sliding, pitches gently under
        // thrust, and rocks on an idle breeze while parked so it reads as
        // floating rather than sitting
        const sway = Math.sin(t * 1.3) * 0.07 * THREE.MathUtils.clamp(1 - spd / 7, 0, 1)
        body.rotation.y += (-throttle * (boost ? 0.16 : 0.1) - body.rotation.y) * 0.1
        const bank = THREE.MathUtils.clamp(
          -steer * THREE.MathUtils.clamp(fwd / 26, -1, 1) * 0.55 + lat * 0.016,
          -0.85,
          0.85,
        )
        body.rotation.x += (bank + sway - body.rotation.x) * 0.12
        // boost: the wingtip streaks flicker and the paper stretches slightly
        const boosting = boost && throttle > 0 && fwd > 2
        for (const [s, streak] of streaks.entries()) {
          streak.visible = boosting
          if (boosting) {
            const flick = 0.8 + 0.45 * Math.sin(t * 43 + s * 2.6) + 0.25 * Math.sin(t * 91 + s)
            streak.scale.set(flick, 1, 1)
          }
        }
        plane.scale.x += ((boosting ? 1.06 : 1) * planeScale - plane.scale.x) * 0.1
        plane.scale.y += ((boosting ? 0.96 : 1) * planeScale - plane.scale.y) * 0.1
        // ink the contrail from the tail whenever the plane is really moving;
        // the dash gating inside trailStamp turns the path into the doodle's
        // dashes, and speed presses the ink in a little darker
        if (spd > 3) {
          const strength = THREE.MathUtils.clamp(spd / 24, 0.4, 1)
          trailStamp(
            trails[0],
            planePos.x - fwdX * 2.3 * planeScale,
            planePos.y - fwdY * 2.3 * planeScale,
            strength,
          )
        } else trailBreak()
        trailFade(dt)

        // the wreck's body language: it perks up a touch under a hover (and
        // fully while it reels the plane in), and the cursor on its dead
        // screen trades its steady terminal blink for a hungry racing one
        if (wreckNode) {
          const pulling = wreckSuck > 0 || wreckCapture !== null
          wreckHover += (Math.max(wreckHoverTarget, pulling ? 1 : 0) - wreckHover) * 0.08
          wreckNode.rotation.z = WRECK_TILT_Z * (1 - wreckHover * 0.45)
          if (wreckCursor) wreckCursor.visible = pulling ? t % 0.3 < 0.17 : t % 1.06 < 0.58
        }
        // fly into the dead screen and the machine PULLS: crossing into the
        // glass radius at speed starts a suction the plane can still boost
        // out of. Hold course for about a second and the screen wins — a
        // scripted spiral reels the plane in, it shrinks into the glass, and
        // the warp swallows the page on the way into AlejOS (the same trip
        // as clicking the wreck). A plane parked on the glass is safe: only
        // a real hit at speed wakes the pull.
        if (overlayIsOpen()) {
          if (wreckSwallowed) wreckSawOverlay = true
          // a capture that never fired its warp was orphaned by the OS
          // booting some other way; put the plane back to normal
          if (wreckCapture && !wreckCapture.warped) {
            wreckCapture = null
            wreckSuck = 0
            plane.scale.setScalar(planeScale)
          }
        } else if (wreckSwallowed) {
          if (wreckSawOverlay) {
            // the OS shut down with the plane still inside: it pops back
            // out, parked on the dead glass like a crash-landing always left it
            wreckSwallowed = false
            wreckSawOverlay = false
            plane.visible = true
            plane.scale.setScalar(planeScale)
            planePos.set(wreckScreen.x, wreckScreen.y)
            planeVel.set(0, 0)
            trailBreak()
          }
        } else if (wreckCapture) {
          // past the point of no return: wind the plane down a tightening
          // spiral, still inking the contrail so the dashes draw the swirl
          wreckCapture.t = Math.min(1, wreckCapture.t + dt / 0.7)
          const e = 1 - Math.pow(1 - wreckCapture.t, 3)
          wreckCapture.ang += (6 + 10 * e) * dt
          const rad = wreckCapture.rad * (1 - e)
          planePos.set(
            wreckScreen.x + Math.cos(wreckCapture.ang) * rad,
            wreckScreen.y + Math.sin(wreckCapture.ang) * rad,
          )
          planeVel.set(0, 0)
          heading = wreckCapture.ang + Math.PI / 2
          plane.scale.setScalar(planeScale * Math.max(0.001, 1 - e))
          if (rad > planeScale) {
            trailStamp(
              trails[0],
              planePos.x - Math.cos(heading) * 2.3 * planeScale * (1 - e),
              planePos.y - Math.sin(heading) * 2.3 * planeScale * (1 - e),
              0.8,
            )
          }
          // open the hole while the last loops play out, so the plane
          // visibly vanishes into it
          if (!wreckCapture.warped && wreckCapture.t >= 0.7) {
            wreckCapture.warped = true
            warpToOs()
          }
          if (wreckCapture.t >= 1) {
            plane.visible = false
            wreckCapture = null
            wreckSuck = 0
            wreckSwallowed = true
            trailBreak()
          }
        } else if (wreckScreenR > 0) {
          const wdx = planePos.x - wreckScreen.x
          const wdy = planePos.y - wreckScreen.y
          const wd = Math.hypot(wdx, wdy)
          if (wd < wreckScreenR && (wreckSuck > 0 || spd > 4)) {
            wreckSuck = Math.min(1, wreckSuck + dt / 0.55)
            // the gravity well: gentle enough at first that boosting away
            // breaks free, then decisive; the sideways tug winds up the
            // orbit that the capture spiral inherits
            const inv = 1 / Math.max(wd, 0.001)
            const g = (30 + 230 * wreckSuck * wreckSuck) * dt
            planeVel.x -= wdx * inv * g
            planeVel.y -= wdy * inv * g
            const swirl = 70 * wreckSuck * dt
            planeVel.x += -wdy * inv * swirl
            planeVel.y += wdx * inv * swirl
            if (wreckSuck >= 1) {
              wreckCapture = {
                t: 0,
                ang: Math.atan2(wdy, wdx),
                rad: Math.min(wd, wreckScreenR),
                warped: false,
              }
              keys.clear()
            }
          } else {
            wreckSuck = Math.max(0, wreckSuck - dt * 3)
          }
        }

        // while the plane is actually being flown, scroll the page along with
        // it so it can tour the whole site; manual scrolling wins otherwise.
        // 'instant' sidesteps the CSS smooth-scroll, which would fight the
        // per-frame easing here
        const planeDocY = view.H / 2 - (holder.position.y + planePos.y) / view.wpp
        const screenY = planeDocY - scrollY
        planeOnScreen = screenY > -150 && screenY < view.H + 150
        if (!planeOnScreen) keys.clear()
        const driving =
          keys.has('w') ||
          keys.has('a') ||
          keys.has('s') ||
          keys.has('d') ||
          keys.has(' ') ||
          stick.active
        if (planeOnScreen && (driving || spd > 6)) {
          const followTarget = THREE.MathUtils.clamp(
            THREE.MathUtils.clamp(scrollY, planeDocY - view.H * 0.72, planeDocY - view.H * 0.22),
            0,
            docH - view.H,
          )
          if (Math.abs(followTarget - scrollY) > 0.5) {
            window.scrollTo({
              top: scrollY + (followTarget - scrollY) * Math.min(1, 14 * dt),
              behavior: 'instant',
            })
            // re-sync the camera to the scroll we just performed: rendering
            // this frame against the pre-scroll offset paints the world one
            // scroll-step behind the page, and that varying lag reads as
            // stutter the whole time the page is following the plane
            camera.position.y = -window.scrollY * view.wpp
          }
        }

        // ram the name: overlapping letters get an impulse along the contact
        // normal plus the plane's velocity; their slot springs pull them home
        const planeVx = planeVel.x
        const planeVy = planeVel.y
        for (let i = 0; i < count; i++) {
          if (i === dragged) continue
          const dx = pos[i].x - planePos.x
          const dy = pos[i].y - planePos.y
          const reach = letterRadius[i] + 2.4 * planeScale
          const d2 = dx * dx + dy * dy
          if (d2 > reach * reach || d2 === 0) continue
          const d = Math.sqrt(d2)
          const nx = dx / d
          const ny = dy / d
          if (spd > 2.5 && now - lastHit[i] > 250) {
            lastHit[i] = now
            vel[i].x += nx * 5 + planeVx * 0.85
            vel[i].y += ny * 5 + planeVy * 0.85
            vel[i].z += Math.min(spd * 0.32, 11)
            const spin = THREE.MathUtils.clamp(spd * 0.4, 2, 10)
            angVel[i].set(
              (Math.random() - 0.5) * spin,
              (Math.random() - 0.5) * spin,
              (Math.random() - 0.5) * spin,
            )
            planeVel.multiplyScalar(0.8)
          } else {
            // nudging at parking speed just shoulders the letter aside
            vel[i].x += nx * 24 * dt
            vel[i].y += ny * 24 * dt
          }
        }

        renderer.render(scene, camera)
        if (!revealed) {
          // first frame is in place: fade the canvas in over the fallback
          revealed = true
          renderer.domElement.style.opacity = '1'
          if (!hintDone) hintEl!.style.opacity = '1'
        }
        raf = requestAnimationFrame(tick)
      }
      const resumeIfReady = () => {
        if (!paused && raf === 0 && !disposed) {
          last = performance.now()
          raf = requestAnimationFrame(tick)
        }
      }
      if (coarse) {
        disposers.push(
          onOverlayChange((open) => {
            paused = open
            resumeIfReady()
          }),
        )
      }
      raf = requestAnimationFrame(tick)
      disposers.push(() => cancelAnimationFrame(raf))
    })

    return () => {
      disposed = true
      for (const dispose of disposers) dispose()
      themeObserver.disconnect()
      faceMat.dispose()
      sideMat.dispose()
      accentFaceMat.dispose()
      accentSideMat.dispose()
      renderer.dispose()
      if (renderer.domElement.parentElement === el) el.removeChild(renderer.domElement)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // fixed (not absolute): the plane roams the whole document, so the canvas
  // tracks the viewport; the world inside compensates with the scroll offset.
  // The control hint is screen-space HTML pinned under the plane by tick().
  return (
    <>
      <div ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-10">
        <span
          ref={hintRef}
          className="absolute top-0 left-0 text-center font-mono text-xs leading-5 whitespace-pre text-stone-400 opacity-0 transition-opacity duration-700 dark:text-stone-600"
        >
          {'wasd to fly\nshift boost\nspace swoop'}
        </span>
      </div>
      {/* touch controls, toggled by tapping the plane; the joystick under the
          left thumb is steering and throttle at once (push to fly, pull to
          brake), swoop and boost sit under the right thumb. This layer is a
          SIBLING of the canvas layer, above the hero copy (z-20): inside the
          z-10 canvas layer the copy wins hit-testing, so the joystick never
          received the touch and the press read as outside-the-pad (dismiss) */}
      <div
        ref={padRef}
        aria-hidden
        style={{ visibility: 'hidden' }}
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex items-end justify-between px-6 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] opacity-0 transition-opacity duration-300"
      >
        <div
          data-joystick
          aria-label="Flight joystick"
          className="pointer-events-auto relative h-32 w-32 touch-none rounded-full border border-stone-300 bg-white/50 shadow-sm backdrop-blur-sm select-none [-webkit-touch-callout:none] dark:border-stone-600 dark:bg-stone-900/50"
        >
          {/* centered with negative margins, NOT translate utilities: the
              knob's inline transform carries the deflection, and Tailwind's
              separate `translate` property would compose with it and shove
              the knob off-center the moment it moves */}
          <div
            data-knob
            className="absolute top-1/2 left-1/2 -mt-7 -ml-7 h-14 w-14 rounded-full border border-stone-300 bg-white/90 shadow-sm dark:border-stone-500 dark:bg-stone-700/90"
          />
        </div>
        <div className="flex flex-col items-end gap-3">
          <PadButton k="shift" label="Speed boost">
            boost
          </PadButton>
          <PadButton k=" " label="Swoop">
            swoop
          </PadButton>
        </div>
      </div>
    </>
  )
}

/** One pad control: data-key names the synthetic key it presses */
function PadButton({ k, label, children }: { k: string; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-key={k}
      aria-label={label}
      className="pointer-events-auto flex h-14 touch-none items-center justify-center rounded-full border border-stone-300 bg-white/70 px-7 font-mono text-xs text-stone-700 shadow-sm backdrop-blur-sm transition-transform select-none [-webkit-touch-callout:none] dark:border-stone-600 dark:bg-stone-900/70 dark:text-stone-200"
    >
      {children}
    </button>
  )
}
