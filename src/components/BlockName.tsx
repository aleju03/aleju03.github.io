import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js'

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

  A toy car shares the scene: WASD drives it (viewed from above, like a
  tabletop), Shift is a turbo boost and Space is a handbrake that breaks
  rear grip for drifting, laying continuous rubber ribbons. Ramming the
  name sends letters flying; their springs pull them back home. An HTML
  control hint hangs under the parked car and fades for good on the first
  drive key; on touch screens it reads "tap the car to drive" instead, and
  tapping the car toggles on-screen controls: a left-thumb joystick that
  maps to analog steer and throttle, plus drift and turbo buttons under the
  right thumb that feed the same key set as the keyboard — so one thumb
  drives while the other drifts.

  The canvas is FIXED to the viewport and the world is pinned to the
  document: the camera slides down with the scroll position, so the car can
  drive across the entire page, and while it's being driven the page
  scrolls along to keep it in view. Keys (including Space, which is purely
  the handbrake) only register while the car is on screen and the user
  isn't typing; arrow keys are left alone so the page always scrolls.
*/

const LINES = [
  { word: 'ALEJANDRO', accent: false },
  { word: 'JIMÉNEZ', accent: true },
]
const SIZE = 5 // em size in scene units; Clash Display caps sit around 0.7em
const CAP = SIZE * 0.7
const DEPTH = 2.2
const GAP = 1.1
const LINE_SPACING = CAP + 1.9 // distance between the two baselines' centers

// front faces and extrusion sides get separate colors so the blocks read as
// sculpted material in both themes instead of a flat dark slab
const COLORS = {
  light: { face: '#fafaf9', side: '#78716c', accentFace: '#2563eb', accentSide: '#1e3a8a' },
  dark: { face: '#f5f5f4', side: '#57534e', accentFace: '#3b82f6', accentSide: '#1e40af' },
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
  /** in-flow element marking where the assembled name should sit */
  slotRef: React.RefObject<HTMLDivElement | null>
  /** Hero calls this to spring every letter back home */
  resetRef: React.RefObject<() => void>
  /** fires once the blocks are built and visible */
  onActive: (active: boolean) => void
  onScrambled: (scrambled: boolean) => void
}

export default function BlockName({ slotRef, resetRef, onActive, onScrambled }: BlockNameProps) {
  const ref = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLSpanElement>(null)
  const padRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    const slotEl = slotRef.current
    const sectionEl = el?.parentElement
    if (!el || !slotEl || !sectionEl || !supportsWebGL()) return

    // the control hint hangs off the parked car: wasd keys on mouse-only
    // devices, a tap-to-drive nudge anywhere a finger could be the input.
    // maxTouchPoints catches mobile emulators that report a fine pointer
    const hintEl = hintRef.current
    const canDrive =
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      navigator.maxTouchPoints === 0
    if (hintEl && !canDrive) hintEl.textContent = 'tap the car to drive'

    let disposed = false
    const disposers: (() => void)[] = []

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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
    const applyColors = (dark: boolean) => {
      const palette = dark ? COLORS.dark : COLORS.light
      faceMat.color.set(palette.face)
      sideMat.color.set(palette.side)
      accentFaceMat.color.set(palette.accentFace)
      accentSideMat.color.set(palette.accentSide)
    }
    const isDark = () => document.documentElement.classList.contains('dark')
    applyColors(isDark())
    const themeObserver = new MutationObserver(() => applyColors(isDark()))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    new FontLoader().load('/fonts/clash-display-semibold.typeface.json', (font) => {
      if (disposed) return

      const textOpts = {
        font,
        size: SIZE,
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
            const accGeo = new THREE.BoxGeometry(1.7, 0.65, DEPTH)
            const acc = new THREE.Mesh(accGeo, accentFaceMat)
            acc.rotation.z = 0.5
            acc.position.set(0.3, (bb.max.y - bb.min.y) / 2 + 0.85, 0)
            node.add(acc)
            disposers.push(() => accGeo.dispose())
          }
          node.userData.idx = blocks.length
          swing.add(node)
          blocks.push({ node, width: w })
          slots.push(new THREE.Vector3(cursor + w / 2, -lineIdx * LINE_SPACING, 0))
          cursor += w + GAP
        }
        lineWidths.push(cursor - GAP)
      }

      // left-align both lines and center the whole grid on the swing origin
      const totalW = Math.max(...lineWidths)
      for (const slot of slots) {
        slot.x -= totalW / 2
        slot.y += LINE_SPACING / 2
      }

      // the toy car: a cobalt rally hatchback with a dark glass canopy. The
      // body is the side silhouette extruded across the width — a real hood /
      // windshield / roof line — and the trim is primitives, so it keeps the
      // letters' sculpted-block material language. Nose points along +x.
      const wheelMat = new THREE.MeshStandardMaterial({ color: '#292524', roughness: 0.7, metalness: 0 })
      const hubMat = new THREE.MeshStandardMaterial({ color: '#d6d3d1', roughness: 0.35, metalness: 0.2 })
      const glassMat = new THREE.MeshStandardMaterial({ color: '#1c1917', roughness: 0.18, metalness: 0.1 })
      const headlightMat = new THREE.MeshStandardMaterial({
        color: '#fffbeb',
        emissive: '#fde68a',
        emissiveIntensity: 0.7,
        roughness: 0.3,
      })
      const taillightMat = new THREE.MeshStandardMaterial({
        color: '#dc2626',
        emissive: '#ef4444',
        emissiveIntensity: 0.15,
        roughness: 0.3,
      })
      const flameMat = new THREE.MeshBasicMaterial({ color: '#fb923c', transparent: true, opacity: 0.85 })
      disposers.push(() => {
        wheelMat.dispose()
        hubMat.dispose()
        glassMat.dispose()
        headlightMat.dispose()
        taillightMat.dispose()
        flameMat.dispose()
      })
      const car = new THREE.Group()
      const chassis = new THREE.Group()
      car.add(chassis)
      const carGeos: THREE.BufferGeometry[] = []
      const carPart = (
        geo: THREE.BufferGeometry,
        mat: THREE.Material | THREE.Material[],
        x: number,
        y: number,
        z: number,
      ) => {
        const mesh = new THREE.Mesh(geo, mat)
        mesh.position.set(x, y, z)
        carGeos.push(geo)
        return mesh
      }
      // profiles are drawn in the XZ sense (length, height); rotateX stands
      // them up so the extrusion depth becomes the car's width, then the
      // geometry is centered on y and its underside parked at `bottom`
      const standUp = (geo: THREE.ExtrudeGeometry, bottom: number) => {
        geo.rotateX(Math.PI / 2)
        geo.computeBoundingBox()
        const b = geo.boundingBox!
        geo.translate(0, -(b.min.y + b.max.y) / 2, bottom - b.min.z)
        return geo
      }
      const bodyShape = new THREE.Shape()
      bodyShape.moveTo(-2.3, 0.06)
      bodyShape.lineTo(-2.3, 0.66) // rear bumper
      bodyShape.lineTo(-1.7, 0.88) // trunk kick-up
      bodyShape.lineTo(1.35, 0.88) // beltline
      bodyShape.lineTo(2.1, 0.72) // hood
      bodyShape.lineTo(2.3, 0.42) // nose
      bodyShape.lineTo(2.3, 0.06)
      bodyShape.closePath()
      const bodyGeo = standUp(
        new THREE.ExtrudeGeometry(bodyShape, {
          depth: 1.9,
          bevelEnabled: true,
          bevelThickness: 0.07,
          bevelSize: 0.07,
          bevelSegments: 2,
        }),
        -0.55,
      )
      // extrude caps are the car's flanks, walls are hood/roof/floor: reuse
      // the letters' bright-face / dark-side split so it reads as one set
      chassis.add(carPart(bodyGeo, [accentSideMat, accentFaceMat], 0, 0, 0))
      const glassShape = new THREE.Shape()
      glassShape.moveTo(-1.35, 0.86)
      glassShape.lineTo(-0.6, 1.5) // rear window
      glassShape.lineTo(0.62, 1.5) // roofline
      glassShape.lineTo(1.25, 0.86) // windshield
      glassShape.closePath()
      const glassGeo = standUp(new THREE.ExtrudeGeometry(glassShape, { depth: 1.56, bevelEnabled: false }), 0.25)
      chassis.add(carPart(glassGeo, glassMat, 0, 0, 0))
      // body-color roof cap over the canopy, with a white rally stripe
      chassis.add(carPart(new THREE.BoxGeometry(1.3, 1.68, 0.12), accentFaceMat, 0.01, 0, 0.89))
      chassis.add(carPart(new THREE.BoxGeometry(1.26, 0.44, 0.05), faceMat, 0.01, 0, 0.96))
      // sits ~0.03 proud of the beveled hood top (z≈0.33 mid-hood): closer
      // and the two near-coplanar faces z-fight while the car moves
      const hoodStripe = carPart(new THREE.BoxGeometry(0.78, 0.44, 0.05), faceMat, 1.72, 0, 0.38)
      hoodStripe.rotation.y = 0.21 // lie flat on the sloping hood
      chassis.add(hoodStripe)
      // rear wing on struts, splitter lip under the nose
      chassis.add(carPart(new THREE.BoxGeometry(0.46, 1.9, 0.1), accentSideMat, -2.1, 0, 0.52))
      chassis.add(carPart(new THREE.BoxGeometry(0.12, 0.16, 0.28), wheelMat, -2.0, 0.6, 0.36))
      chassis.add(carPart(new THREE.BoxGeometry(0.12, 0.16, 0.28), wheelMat, -2.0, -0.6, 0.36))
      chassis.add(carPart(new THREE.BoxGeometry(0.5, 2.0, 0.12), wheelMat, 2.1, 0, -0.55))
      for (const side of [-1, 1]) {
        chassis.add(carPart(new THREE.BoxGeometry(0.12, 0.4, 0.2), headlightMat, 2.34, side * 0.58, -0.25))
        // taillights poke out past the rear wing so the top-down view still
        // sees them light up when braking or reversing
        chassis.add(carPart(new THREE.BoxGeometry(0.2, 0.48, 0.26), taillightMat, -2.46, side * 0.6, 0.0))
      }
      // exhaust pipes with turbo flames behind them (hidden until Shift)
      const exhaustGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.34, 10)
      exhaustGeo.rotateZ(Math.PI / 2)
      const flameGeo = new THREE.ConeGeometry(0.14, 0.55, 8)
      flameGeo.rotateZ(Math.PI / 2) // apex points backward (-x)
      const flames: THREE.Mesh[] = []
      for (const side of [-1, 1]) {
        chassis.add(carPart(exhaustGeo, hubMat, -2.4, side * 0.42, -0.38))
        const flame = carPart(flameGeo, flameMat, -2.62, side * 0.42, -0.38)
        flame.visible = false
        flames.push(flame)
        chassis.add(flame)
      }
      const frontWheels: THREE.Group[] = []
      for (const [wx, wy] of [
        [1.45, 1.08],
        [1.45, -1.08],
        [-1.45, 1.08],
        [-1.45, -1.08],
      ]) {
        const wheel = new THREE.Group()
        wheel.add(carPart(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 18), wheelMat, 0, 0, 0))
        wheel.add(carPart(new THREE.CylinderGeometry(0.33, 0.33, 0.56, 12), hubMat, 0, 0, 0))
        wheel.position.set(wx, wy, -0.4)
        if (wx > 0) frontWheels.push(wheel)
        chassis.add(wheel)
      }
      disposers.push(() => carGeos.forEach((g) => g.dispose()))
      // parked to the right of the name, nose pointed at it. The car lives in
      // holder (not swing) so the pointer-parallax tilt, which pivots around
      // the name, can't sway it when it's driving far down the page
      const carPos = new THREE.Vector2(totalW / 2 + 7, -LINE_SPACING / 2)
      let carHeading = Math.PI * 0.85
      const carVel = new THREE.Vector2()
      car.position.set(carPos.x, carPos.y, 0)
      car.rotation.z = carHeading
      holder.add(car)

      // drift trails: each rear wheel lays a continuous ribbon — a ring buffer
      // of quads stitched between consecutive wheel positions, fading through
      // per-vertex alpha — so slides read as smooth rubber arcs, not stamps
      const TRAIL_QUADS = 160
      const TRAIL_LIFE = 2.6
      const TRAIL_HALF_W = 0.23
      const trailColor = new THREE.Color('#78716c')
      const makeTrail = () => {
        const geo = new THREE.BufferGeometry()
        const posAttr = new THREE.BufferAttribute(new Float32Array(TRAIL_QUADS * 4 * 3), 3)
        const colAttr = new THREE.BufferAttribute(new Float32Array(TRAIL_QUADS * 4 * 4), 4)
        posAttr.setUsage(THREE.DynamicDrawUsage)
        colAttr.setUsage(THREE.DynamicDrawUsage)
        const col = colAttr.array as Float32Array
        for (let v = 0; v < TRAIL_QUADS * 4; v++) {
          col[v * 4] = trailColor.r
          col[v * 4 + 1] = trailColor.g
          col[v * 4 + 2] = trailColor.b
        }
        const index: number[] = []
        for (let q = 0; q < TRAIL_QUADS; q++)
          index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3)
        geo.setIndex(index)
        geo.setAttribute('position', posAttr)
        geo.setAttribute('color', colAttr)
        const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })
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
          prevX: 0,
          prevY: 0,
          prevLX: 0,
          prevLY: 0,
          prevRX: 0,
          prevRY: 0,
        }
      }
      const trails = [makeTrail(), makeTrail()]
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
          // fresh slide (or a wrap teleport): just anchor the first point
          tr.hasPrev = true
          tr.edges = false
          tr.prevX = x
          tr.prevY = y
          return
        }
        if (len < 0.16) return // too short for a clean segment, wait for more
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
            const alpha = Math.max(0, 1 - tr.ages[q] / TRAIL_LIFE) * tr.strengths[q] * 0.4
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

      // horizontal roam bounds (the car wraps at the real screen edges) plus
      // the world↔page mapping, refreshed by layout() below
      const driveBounds = { minX: -40, maxX: 40 }
      const view = { wpp: 0.05, W: 1200, H: 800 }

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
        const worldPerPixel = totalW / sr.width
        const halfV = Math.tan((camera.fov * Math.PI) / 360)
        camera.position.z = (cr.height * worldPerPixel) / 2 / halfV
        camera.updateProjectionMatrix()
        holder.position.x = (sr.left + sr.width / 2 - cr.width / 2) * worldPerPixel
        holder.position.y = -(sr.top + sr.height / 2 + window.scrollY - cr.height / 2) * worldPerPixel
        view.wpp = worldPerPixel
        view.W = cr.width
        view.H = cr.height
        const halfH = camera.position.z * halfV
        const halfW = halfH * camera.aspect
        driveBounds.minX = -halfW - holder.position.x
        driveBounds.maxX = halfW - holder.position.x
      }
      layout()
      // the parking spot sits to the right of the name, which on phones can
      // fall past the screen edge; pull the car back in so it stays tappable
      carPos.x = THREE.MathUtils.clamp(carPos.x, driveBounds.minX + 3.5, driveBounds.maxX - 3.5)
      car.position.x = carPos.x
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
      // and the car. A small initial tilt settles upright for a touch of life.
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
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
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
        if (!raycaster.ray.intersectPlane(plane, planePoint)) return null
        return swing.worldToLocal(planePoint.clone())
      }

      // the touch pad toggles on a car tap: the drift/turbo buttons feed the
      // same key set as the keyboard, while the joystick writes analog steer
      // and throttle that the physics adds on top of the keys
      const stick = { x: 0, y: 0, active: false }
      const padEl = padRef.current
      let padOpen = false
      const setPad = (open: boolean) => {
        if (!padEl) return
        padOpen = open
        padEl.style.visibility = open ? 'visible' : 'hidden'
        padEl.style.opacity = open ? '1' : '0'
      }

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
          // a tap near the car (generous, thumb-sized hitbox) toggles the
          // touch controls
          const p = toPlane(e)
          if (p && (p.x - carPos.x) ** 2 + (p.y - carPos.y) ** 2 < 42) {
            setPad(!padOpen)
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
      // untouched so the page always scrolls. tick() keeps carOnScreen fresh.
      const keys = new Set<string>()
      let carOnScreen = true
      let hintDone = !hintEl
      const isTyping = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null
        return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      }
      const onKeyDown = (e: KeyboardEvent) => {
        const k = e.key.toLowerCase()
        if (!carOnScreen || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
        if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'shift') keys.add(k)
        // the hint has done its job the moment the car first drives off
        if (!hintDone && (k === 'w' || k === 'a' || k === 's' || k === 'd')) {
          hintDone = true
          hintEl!.style.opacity = '0'
        }
        // Space is the handbrake whenever the car is around; swallowing the
        // default stops the browser's jarring page-down scroll
        if (k === ' ') {
          e.preventDefault()
          keys.add(' ')
        }
      }
      const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())
      const onBlur = () => keys.clear()
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      window.addEventListener('blur', onBlur)
      disposers.push(() => {
        window.removeEventListener('keydown', onKeyDown)
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
            // don't bubble to the section, which would read this as a car
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

        // the joystick: knob displacement maps to analog steer (x) and
        // throttle (y, push forward / pull back). Pointer capture keeps the
        // knob glued to the thumb even when it slides off the base circle
        const stickEl = padEl.querySelector<HTMLDivElement>('[data-joystick]')
        const knobEl = stickEl?.querySelector<HTMLDivElement>('[data-knob]')
        if (stickEl && knobEl) {
          const REACH = 40 // px of knob travel for full deflection
          let stickPointer = -1
          const setKnob = (dx: number, dy: number) => {
            knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
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
            // a small deadzone so a resting thumb doesn't creep the car
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
            stick.active = false
            stick.x = 0
            stick.y = 0
            knobEl.style.transition = 'transform 150ms ease-out'
            setKnob(0, 0)
          }
          const swallowMenu = (e: Event) => e.preventDefault()
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
      let raf = 0
      let revealed = false
      let last = performance.now()
      const tick = (now: number) => {
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

        // toy car: heading and velocity are separate so grip is a real force.
        // Velocity splits into forward + lateral parts each frame; grip bleeds
        // the lateral slip fast, and the Space handbrake nearly turns grip off
        // while quickening the steering — that combination is the drift.
        const turbo = keys.has('shift')
        const drifting = keys.has(' ')
        // the joystick adds analog steer/throttle on top of the keys; pulling
        // back reverses at the same reduced strength as the S key
        const throttle = THREE.MathUtils.clamp(
          (keys.has('w') ? 1 : 0) -
            (keys.has('s') ? 0.6 : 0) +
            (carOnScreen ? (stick.y > 0 ? stick.y : stick.y * 0.6) : 0),
          -0.6,
          1,
        )
        const steer = THREE.MathUtils.clamp(
          (keys.has('a') ? 1 : 0) - (keys.has('d') ? 1 : 0) - (carOnScreen ? stick.x : 0),
          -1,
          1,
        )
        const fwdX = Math.cos(carHeading)
        const fwdY = Math.sin(carHeading)
        let fwd = carVel.x * fwdX + carVel.y * fwdY
        let lat = -carVel.x * fwdY + carVel.y * fwdX
        fwd += throttle * (turbo ? 105 : 58) * dt
        fwd *= Math.max(0, 1 - (drifting ? 2.6 : 1.7) * dt)
        fwd = THREE.MathUtils.clamp(fwd, -13, turbo ? 48 : 30)
        lat *= Math.max(0, 1 - (drifting ? 1.8 : 11) * dt)
        carHeading += steer * (drifting ? 4.1 : 2.7) * dt * THREE.MathUtils.clamp(fwd / 9, -1, 1)
        carVel.set(fwdX * fwd - fwdY * lat, fwdY * fwd + fwdX * lat)
        carPos.addScaledVector(carVel, dt)
        const carSpd = carVel.length()
        // horizontal: wrap at the screen edges (break the trail so the ribbon
        // doesn't streak across); vertical: the car ranges over the whole
        // document and bounces softly off the page's top and bottom
        const margin = 4
        if (carPos.x > driveBounds.maxX + margin || carPos.x < driveBounds.minX - margin) {
          carPos.x = carPos.x > 0 ? driveBounds.minX - margin : driveBounds.maxX + margin
          trailBreak()
        }
        const docH = document.documentElement.scrollHeight
        const pageTopY = (view.H / 2) * view.wpp - holder.position.y - 3
        const pageBottomY = (view.H / 2 - docH) * view.wpp - holder.position.y + 3
        if (carPos.y > pageTopY) {
          carPos.y = pageTopY
          if (carVel.y > 0) carVel.y *= -0.35
          trailBreak()
        }
        if (carPos.y < pageBottomY) {
          carPos.y = pageBottomY
          if (carVel.y < 0) carVel.y *= -0.35
          trailBreak()
        }
        car.position.set(carPos.x, carPos.y, 0)
        car.rotation.z = carHeading
        // the control hint is HTML pinned a little below the car in world
        // space, so it scales with the scene and scrolls off with the car
        if (!hintDone) {
          hintWorld
            .set(carPos.x + holder.position.x, carPos.y - 3.6 + holder.position.y, 0)
            .project(camera)
          // clamp onto the screen by the hint's measured size so a car parked
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
        // body language: front wheels steer, chassis pitches under throttle
        // and rolls against lateral slip like the suspension is loaded
        for (const wheel of frontWheels) wheel.rotation.z += (steer * 0.38 - wheel.rotation.z) * 0.25
        chassis.rotation.y += (-throttle * (turbo ? 0.12 : 0.07) - chassis.rotation.y) * 0.12
        const roll = THREE.MathUtils.clamp(
          steer * THREE.MathUtils.clamp(fwd / 30, -1, 1) * 0.12 - lat * 0.012,
          -0.3,
          0.3,
        )
        chassis.rotation.x += (roll - chassis.rotation.x) * 0.15
        // turbo: exhaust flames flicker and the body stretches slightly
        const boosting = turbo && throttle > 0 && fwd > 2
        for (const [f, flame] of flames.entries()) {
          flame.visible = boosting
          if (boosting) {
            const flick = 0.8 + 0.45 * Math.sin(t * 43 + f * 2.6) + 0.25 * Math.sin(t * 91 + f)
            flame.scale.set(flick, 0.7 + 0.3 * flick, 0.7 + 0.3 * flick)
          }
        }
        car.scale.x += ((boosting ? 1.06 : 1) - car.scale.x) * 0.1
        car.scale.y += ((boosting ? 0.96 : 1) - car.scale.y) * 0.1
        // taillights work like brake/reverse lights: bright while backing up
        // or braking, idling dim otherwise
        const lit = fwd < -0.5 || (keys.has('s') && fwd > 0.5)
        taillightMat.emissiveIntensity += ((lit ? 2.4 : 0.15) - taillightMat.emissiveIntensity) * 0.25
        // lay rubber while sliding: each rear wheel extends its ribbon
        if (Math.abs(lat) > 4.5) {
          const strength = THREE.MathUtils.clamp(Math.abs(lat) / 14, 0.45, 1)
          trailStamp(trails[0], carPos.x - fwdX * 1.45 - fwdY * 1.08, carPos.y - fwdY * 1.45 + fwdX * 1.08, strength)
          trailStamp(trails[1], carPos.x - fwdX * 1.45 + fwdY * 1.08, carPos.y - fwdY * 1.45 - fwdX * 1.08, strength)
        } else trailBreak()
        trailFade(dt)

        // while the car is actually being driven, scroll the page along with
        // it so it can tour the whole site; manual scrolling wins otherwise.
        // 'instant' sidesteps the CSS smooth-scroll, which would fight the
        // per-frame easing here
        const carDocY = view.H / 2 - (holder.position.y + carPos.y) / view.wpp
        const screenY = carDocY - scrollY
        carOnScreen = screenY > -150 && screenY < view.H + 150
        if (!carOnScreen) keys.clear()
        const driving =
          keys.has('w') ||
          keys.has('a') ||
          keys.has('s') ||
          keys.has('d') ||
          keys.has(' ') ||
          stick.active
        if (carOnScreen && (driving || carSpd > 6)) {
          const followTarget = THREE.MathUtils.clamp(
            THREE.MathUtils.clamp(scrollY, carDocY - view.H * 0.72, carDocY - view.H * 0.22),
            0,
            docH - view.H,
          )
          if (Math.abs(followTarget - scrollY) > 0.5) {
            window.scrollTo({
              top: scrollY + (followTarget - scrollY) * Math.min(1, 14 * dt),
              behavior: 'instant',
            })
          }
        }

        // ram the name: overlapping letters get an impulse along the contact
        // normal plus the car's velocity; their slot springs pull them home
        const carVx = carVel.x
        const carVy = carVel.y
        for (let i = 0; i < count; i++) {
          if (i === dragged) continue
          const dx = pos[i].x - carPos.x
          const dy = pos[i].y - carPos.y
          const reach = letterRadius[i] + 2.4
          const d2 = dx * dx + dy * dy
          if (d2 > reach * reach || d2 === 0) continue
          const d = Math.sqrt(d2)
          const nx = dx / d
          const ny = dy / d
          if (carSpd > 2.5 && now - lastHit[i] > 250) {
            lastHit[i] = now
            vel[i].x += nx * 5 + carVx * 0.85
            vel[i].y += ny * 5 + carVy * 0.85
            vel[i].z += Math.min(carSpd * 0.32, 11)
            const spin = THREE.MathUtils.clamp(carSpd * 0.4, 2, 10)
            angVel[i].set(
              (Math.random() - 0.5) * spin,
              (Math.random() - 0.5) * spin,
              (Math.random() - 0.5) * spin,
            )
            carVel.multiplyScalar(0.8)
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

  // fixed (not absolute): the car roams the whole document, so the canvas
  // tracks the viewport; the world inside compensates with the scroll offset.
  // The control hint is screen-space HTML pinned under the car by tick().
  return (
    <div ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-10">
      <span
        ref={hintRef}
        className="absolute top-0 left-0 text-center font-mono text-xs leading-5 whitespace-pre text-stone-400 opacity-0 transition-opacity duration-700 dark:text-stone-600"
      >
        {'wasd to drive\nshift turbo\nspace drift'}
      </span>
      {/* touch controls, toggled by tapping the car; the joystick under the
          left thumb is steering and throttle at once (push to drive, pull to
          reverse), drift and turbo sit under the right thumb */}
      <div
        ref={padRef}
        style={{ visibility: 'hidden' }}
        className="absolute inset-x-0 bottom-0 flex items-end justify-between px-6 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] opacity-0 transition-opacity duration-300"
      >
        <div
          data-joystick
          aria-label="Drive joystick"
          className="pointer-events-auto relative h-32 w-32 touch-none rounded-full border border-stone-300 bg-white/50 shadow-sm backdrop-blur-sm select-none [-webkit-touch-callout:none] dark:border-stone-600 dark:bg-stone-900/50"
        >
          <div
            data-knob
            className="absolute top-1/2 left-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border border-stone-300 bg-white/90 shadow-sm dark:border-stone-500 dark:bg-stone-700/90"
          />
        </div>
        <div className="flex flex-col items-end gap-3">
          <PadButton k="shift" label="Turbo boost">
            turbo
          </PadButton>
          <PadButton k=" " label="Handbrake drift">
            drift
          </PadButton>
        </div>
      </div>
    </div>
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
