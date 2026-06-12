import { useEffect, useRef } from 'react'
import * as THREE from 'three'

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

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 100)
    camera.position.set(0, 3.6, 9.5)
    camera.lookAt(0, -0.5, 0)

    const COLS = 110
    const ROWS = 60
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

    // sparse cobalt dots in a mostly-neutral field; recolored when the theme flips
    const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute
    const applyColors = (dark: boolean) => {
      const base = new THREE.Color(dark ? '#57534e' : '#d6d3d1')
      const accent = new THREE.Color(dark ? '#3b82f6' : '#2563eb')
      let n = 0
      for (let x = 0; x < COLS; x++) {
        for (let z = 0; z < ROWS; z++) {
          const c = (x * 31 + z * 17) % 23 === 0 ? accent : base
          colorAttr.setXYZ(n, c.r, c.g, c.b)
          n++
        }
      }
      colorAttr.needsUpdate = true
    }
    const isDark = () => document.documentElement.classList.contains('dark')
    applyColors(isDark())
    const themeObserver = new MutationObserver(() => {
      applyColors(isDark())
      if (reduce) renderer.render(scene, camera)
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
      const nowSec = t / 1000
      ripples = ripples.filter((r) => nowSec - r.t0 < 3)
      wave(t / 1600, nowSec)
      camera.position.x += (pointerX * 1.4 - camera.position.x) * 0.04
      camera.lookAt(0, -0.5, 0)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }

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
      themeObserver.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('pointerdown', onTap)
      geo.dispose()
      mat.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={ref} aria-hidden className="absolute inset-0" />
}
