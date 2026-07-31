/*
  The custom cursor: a ring that trails the pointer, swells over anything
  interactive, and carries a word when the thing under it deserves one.

  Two decisions keep this from being the usual liability.

  It never replaces the real cursor. The native pointer stays visible — this
  ring rides behind it. Hiding the system cursor is the version of this effect
  that breaks text selection, breaks anyone relying on a large or high-contrast
  pointer, and leaves a site unusable the moment the rAF loop stalls.

  It never mounts where it does not belong. Touch and hybrid devices, coarse
  pointers, and reduced motion all skip it entirely — same gate BlockName uses
  for the paper plane's flight controls, `maxTouchPoints` included, because
  emulators and 2-in-1s lie about `hover`.

  Targets are declared, not sniffed: an element opts in with `data-cursor`
  ("open" for a project card, "link", "boot"), read through one delegated
  pointerover on the document rather than a listener per element.
*/

import { useEffect, useRef, useState } from 'react'
import { onOverlayChange, pageIsCovered } from '../overlay'
import { approach } from '../scroll/progress'
import { cue } from '../audio'

function canHostCursor() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return (
    window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
    navigator.maxTouchPoints === 0
  )
}

export function Cursor() {
  const [enabled] = useState(canHostCursor)
  const wrapRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!enabled) return
    const wrap = wrapRef.current
    const ring = ringRef.current
    const label = labelRef.current
    if (!wrap || !ring || !label) return

    let x = window.innerWidth / 2
    let y = window.innerHeight / 2
    let targetX = x
    let targetY = y
    let scale = 1
    let targetScale = 1
    let raf = 0
    let last = performance.now()
    let visible = false
    let currentLabel = ''

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX
      targetY = e.clientY
      if (!visible) {
        visible = true
        // land it where the pointer already is, or it swoops in from the middle
        x = targetX
        y = targetY
        wrap.style.opacity = '1'
      }
    }

    const onOver = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-cursor]') : null
      const next = el?.dataset.cursor ?? ''
      if (next === currentLabel) return
      if (next && !currentLabel) cue('tick')
      currentLabel = next
      // a ring that swells a little, not a disc that eats the paragraph it is
      // hovering. The first version scaled 2.6x on a 36px ring — 94px of solid
      // accent blue over the copy — which is the difference between a cursor
      // with an opinion and a cursor in the way.
      targetScale = next ? 1.7 : 1
      label.textContent = next === 'link' || next === '' ? '' : next
      ring.dataset.state = next ? 'active' : 'idle'
    }

    const onLeave = () => {
      visible = false
      wrap.style.opacity = '0'
    }

    const frame = (now: number) => {
      raf = 0
      if (pageIsCovered()) return
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      // the ring lags the pointer a little; that lag is the whole effect
      x = approach(x, targetX, dt, 18)
      y = approach(y, targetY, dt, 18)
      scale = approach(scale, targetScale, dt, 14)
      // position on the wrapper, scale on the ring alone — otherwise the label
      // grows and drifts with the swell instead of staying put and legible
      wrap.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
      ring.style.transform = `scale(${scale})`
      raf = requestAnimationFrame(frame)
    }
    const run = () => {
      if (raf === 0 && !pageIsCovered()) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }
    run()

    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerleave', onLeave)
    const offOverlay = onOverlayChange(() => run())

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerleave', onLeave)
      offOverlay()
    }
  }, [enabled])

  if (!enabled) return null

  return (
    <div
      ref={wrapRef}
      aria-hidden
      style={{ opacity: 0 }}
      className="pointer-events-none fixed top-0 left-0 z-[60]"
    >
      <div
        ref={ringRef}
        data-state="idle"
        className="h-6 w-6 rounded-full border border-stone-400/60 transition-[background-color,border-color] duration-300 data-[state=active]:border-blue-500/70 data-[state=active]:bg-blue-600/15 dark:border-stone-500/60"
      />
      {/* the label rides OUTSIDE the ring and outside the scale, so it stays
          legible at one size instead of stretching with the swell */}
      <span
        ref={labelRef}
        className="absolute top-full left-full mt-1 ml-1 font-mono text-[8px] leading-none font-medium tracking-[0.14em] whitespace-nowrap text-blue-600 uppercase dark:text-blue-400"
      />
    </div>
  )
}
