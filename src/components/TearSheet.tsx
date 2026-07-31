/*
  The tearable sheet: a band of paper taped across the page that you can grab
  and rip open. Behind it is the machine — so the site's own thesis, that this
  cream paper portfolio is a computer wearing a paper cover, becomes something
  you do with your hands instead of something the copy claims.

  The simulation is `cloth.ts`; this file is the canvas, the input, and the
  gating. Three rules it has to respect:

  - It must never fight the page. A drag is the good interaction and a drag on
    a touch screen is a scroll, so coarse pointers get tap-to-burst instead of
    grab-to-tear, and the canvas only claims the gesture on a fine pointer.
  - It must not run when nobody is looking. An IntersectionObserver starts and
    stops the loop, and `overlay.ts` stops it while AlejOS covers the page —
    the same pause contract the 3D scenes honour.
  - It must be optional. Everything the visitor needs is legible with the sheet
    fully intact; tearing is a toy you find, never a gate you pass. Under
    reduced motion the canvas never mounts at all and the panel behind it is
    simply shown.
*/

import { useEffect, useRef, useState } from 'react'
import { createCloth, type ClothColors } from './cloth'
import { isCoarsePointer } from '../device'
import { onOverlayChange, pageIsCovered } from '../overlay'
import { onScrollFrame } from '../scroll/progress'
import { track } from '../analytics'
import { cue } from '../audio'

/** the sheet is cream stock in light, and the same stock in the night palette */
function clothColors(): ClothColors {
  const dark = document.documentElement.classList.contains('dark')
  return dark
    ? { paper: '#29231c', ink: 'rgba(168,151,130,0.34)' }
    : { paper: '#fffdf8', ink: 'rgba(79,70,56,0.26)' }
}

/** how much has to be gone before we call it torn open */
const OPEN_AT = 0.22

export default function TearSheet({ onOpen }: { onOpen?: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [opened, setOpened] = useState(false)
  // the callback is an inline arrow at the call site, so a plain dependency
  // would rebuild the simulation — and reset the visitor's torn sheet — on
  // every render of the parent
  const onOpenRef = useRef(onOpen)
  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const coarse = isCoarsePointer()
    const cloth = createCloth()
    let colors = clothColors()
    let raf = 0
    let last = performance.now()
    let visible = false
    let announced = false
    let dpr = 1

    const size = () => {
      const r = wrap.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(r.width * dpr)
      canvas.height = Math.round(r.height * dpr)
      canvas.style.width = `${r.width}px`
      canvas.style.height = `${r.height}px`
      cloth.resize(r.width, r.height)
    }
    size()

    const frame = (now: number) => {
      raf = 0
      if (!visible || pageIsCovered()) return
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now

      cloth.step(dt)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      cloth.draw(ctx, colors)

      if (!announced && cloth.tornFraction() > OPEN_AT) {
        announced = true
        setOpened(true)
        onOpenRef.current?.()
        track('sheet_torn', {})
        cue('tear')
      }
      raf = requestAnimationFrame(frame)
    }
    const run = () => {
      if (raf === 0 && visible && !pageIsCovered()) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting
        if (visible) run()
      },
      { rootMargin: '120px' },
    )
    observer.observe(wrap)

    const offOverlay = onOverlayChange(() => run())
    // the sheet stirs as the page moves under it — the same scroll the flight
    // path is drawn by, felt as air on the paper
    const offScroll = onScrollFrame(({ velocity }) => {
      if (visible) cloth.gust(-velocity * 0.004)
    })

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onDown = (e: PointerEvent) => {
      const { x, y } = local(e)
      if (coarse) {
        cloth.punch(x, y, 54)
        cue('tear')
        return
      }
      canvas.setPointerCapture(e.pointerId)
      cloth.grab(x, y)
    }
    const onMove = (e: PointerEvent) => {
      if (coarse) return
      const { x, y } = local(e)
      cloth.move(x, y)
    }
    const onUp = (e: PointerEvent) => {
      if (coarse) return
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      cloth.release()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    const themeObserver = new MutationObserver(() => {
      colors = clothColors()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    const resizeObserver = new ResizeObserver(size)
    resizeObserver.observe(wrap)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      resizeObserver.disconnect()
      themeObserver.disconnect()
      offOverlay()
      offScroll()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [])

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        aria-hidden
        className={`absolute inset-0 h-full w-full touch-none transition-opacity duration-700 ${
          opened ? 'opacity-90' : 'opacity-100'
        }`}
        style={{ cursor: 'grab' }}
      />
    </div>
  )
}
