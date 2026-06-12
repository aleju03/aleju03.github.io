import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { isCoarsePointer } from '../device'
import { onOverlayChange, overlayIsOpen } from '../overlay'
import { THEME_FADE_MS } from '../theme'

/*
  3D dot-wave field rendered under the hero content. Isolated leaf component,
  lazy-loaded so three.js stays out of the main bundle. Under reduced motion it
  renders a single static frame instead of animating.
*/
export default function HeroScene() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const coarse = isCoarsePointer()
    let paused = coarse && overlayIsOpen()

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.35 : 2))
    renderer.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 100)
    camera.position.set(0, 3.6, 9.5)
    camera.lookAt(0, -0.5, 0)

    const COLS = coarse ? 72 : 110
    const ROWS = coarse ? 42 : 60
    const SPACING = 0.32
    const count = COLS * ROWS
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    let i = 0
    for (let x = 0; x < COLS; x++) {
      for (let z = 0; z < ROWS; z++) {
        positions[i * 3] = (x - COLS / 2) * SPACING
        positions[i * 3 + 1] = 0
        positions[i * 3 + 2] = (z - ROWS / 2) * SPACING
        i++
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    // distant ridgelines past the wave field: three layered mountain silhouettes
    // traced in the same dot language, static, animated only by the camera sway
    const RANGES = [
      { z: -26, amp: 4.6, lift: 0.5, step: 0.36, seed: 1.7 },
      { z: -20, amp: 3.2, lift: 0.25, step: 0.3, seed: 4.2 },
      { z: -15.5, amp: 2.1, lift: 0.1, step: 0.26, seed: 8.9 },
    ]
    const ridgeXYZ: number[] = []
    const ridgeRange: number[] = []
    RANGES.forEach((r, ri) => {
      // span scales with distance so every range covers the camera frustum on ultrawide
      const span = -r.z * 1.4
      for (let x = -span; x <= span; x += r.step) {
        const h =
          0.55 * Math.sin(x * 0.16 + r.seed) +
          0.3 * Math.sin(x * 0.37 + r.seed * 2.1) +
          0.15 * Math.sin(x * 0.73 + r.seed * 3.7)
        ridgeXYZ.push(x, r.lift + r.amp * (0.5 + 0.5 * h), r.z)
        ridgeRange.push(ri)
      }
    })
    const ridgeGeo = new THREE.BufferGeometry()
    ridgeGeo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(ridgeXYZ), 3))
    ridgeGeo.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(ridgeRange.length * 3), 3),
    )
    const ridgeMat = new THREE.PointsMaterial({
      size: 0.075,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    })

    // sparse cobalt dots in a mostly-neutral field; recolored when the theme
    // flips. applyColors takes a 0..1 light->dark mix so the flip can fade in
    // step with the page's .theme-fade color crossfade instead of snapping
    const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute
    const palette = {
      light: {
        base: new THREE.Color('#d5cbb8'),
        accent: new THREE.Color('#2563eb'),
        // ridges fade with distance: farthest range closest to the page color
        ridges: ['#f5f1e6', '#e8e2d0', '#d5cbb8'].map((s) => new THREE.Color(s)),
      },
      dark: {
        base: new THREE.Color('#57534e'),
        accent: new THREE.Color('#3b82f6'),
        ridges: ['#37332f', '#44403c', '#534e49'].map((s) => new THREE.Color(s)),
      },
    }
    const base = new THREE.Color()
    const accent = new THREE.Color()
    const ridgeShades = palette.light.ridges.map(() => new THREE.Color())
    const applyColors = (mix: number) => {
      base.lerpColors(palette.light.base, palette.dark.base, mix)
      accent.lerpColors(palette.light.accent, palette.dark.accent, mix)
      ridgeShades.forEach((c, k) => c.lerpColors(palette.light.ridges[k], palette.dark.ridges[k], mix))
      let n = 0
      for (let x = 0; x < COLS; x++) {
        for (let z = 0; z < ROWS; z++) {
          const c = (x * 31 + z * 17) % 23 === 0 ? accent : base
          colorAttr.setXYZ(n, c.r, c.g, c.b)
          n++
        }
      }
      colorAttr.needsUpdate = true
      const ridgeColor = ridgeGeo.getAttribute('color') as THREE.BufferAttribute
      for (let k = 0; k < ridgeRange.length; k++) {
        const c = k % 41 === 0 ? accent : ridgeShades[ridgeRange[k]]
        ridgeColor.setXYZ(k, c.r, c.g, c.b)
      }
      ridgeColor.needsUpdate = true
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
      const fading = document.documentElement.classList.contains('theme-fade')
      if (reduce || !fading) {
        themeMix = target
        applyColors(themeMix)
        if (reduce || raf === 0) renderer.render(scene, camera)
        return
      }
      const from = themeMix
      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min((now - start) / THEME_FADE_MS, 1)
        themeMix = from + (target - from) * (1 - (1 - t) * (1 - t)) // ease-out, like the CSS fade
        applyColors(themeMix)
        if (raf === 0) renderer.render(scene, camera) // main loop paused: present the frame ourselves
        themeFadeRaf = t < 1 ? requestAnimationFrame(step) : 0
      }
      themeFadeRaf = requestAnimationFrame(step)
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    const mat = new THREE.PointsMaterial({
      size: 0.05,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    scene.add(points)
    scene.add(new THREE.Points(ridgeGeo, ridgeMat))

    const pos = geo.getAttribute('position') as THREE.BufferAttribute

    // click ripples: tapping the hero drops a ring that travels through the field
    interface Ripple {
      x: number
      z: number
      t0: number
    }
    let ripples: Ripple[] = []
    const raycaster = new THREE.Raycaster()
    const fieldPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const onTap = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      if (e.clientY < rect.top || e.clientY > rect.bottom) return
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      const hit = new THREE.Vector3()
      if (raycaster.ray.intersectPlane(fieldPlane, hit)) {
        ripples.push({ x: hit.x, z: hit.z, t0: performance.now() / 1000 })
        if (ripples.length > 5) ripples.shift()
      }
    }

    const wave = (time: number, nowSec: number) => {
      for (let n = 0; n < count; n++) {
        const x = pos.getX(n)
        const z = pos.getZ(n)
        let y = Math.sin(x * 0.5 + time) * 0.35 + Math.cos(z * 0.45 + time * 0.7) * 0.3
        for (const r of ripples) {
          const age = nowSec - r.t0
          const dx = x - r.x
          const dz = z - r.z
          const dr = Math.sqrt(dx * dx + dz * dz) - age * 5
          if (Math.abs(dr) > 1.6) continue
          y += 1.1 * Math.exp(-dr * dr * 4) * Math.exp(-age * 1.5)
        }
        pos.setY(n, y)
      }
      pos.needsUpdate = true
    }

    let raf = 0
    let pointerX = 0
    const onPointer = (e: PointerEvent) => {
      pointerX = e.clientX / window.innerWidth - 0.5
    }

    const tick = (t: number) => {
      if (paused) {
        raf = 0
        return
      }
      const nowSec = t / 1000
      ripples = ripples.filter((r) => nowSec - r.t0 < 3)
      wave(t / 1600, nowSec)
      camera.position.x += (pointerX * 1.4 - camera.position.x) * 0.04
      camera.lookAt(0, -0.5, 0)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }

    const resumeIfReady = () => {
      if (!reduce && !paused && raf === 0) {
        raf = requestAnimationFrame(tick)
      }
    }
    const offOverlay = onOverlayChange((open) => {
      paused = coarse && open
      resumeIfReady()
    })

    if (reduce) {
      wave(1.5, 0)
      renderer.render(scene, camera)
    } else {
      window.addEventListener('pointermove', onPointer)
      window.addEventListener('pointerdown', onTap)
      raf = requestAnimationFrame(tick)
    }

    const onResize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight)
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
      if (reduce) renderer.render(scene, camera)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(themeFadeRaf)
      offOverlay()
      themeObserver.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('pointerdown', onTap)
      geo.dispose()
      mat.dispose()
      ridgeGeo.dispose()
      ridgeMat.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={ref} aria-hidden className="absolute inset-0" />
}
