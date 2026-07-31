/*
  The custom cursor: a ring that trails the pointer, swells over anything
  interactive, and carries a word when the thing under it deserves one.

  Two decisions keep this from being the usual liability.

  It replaces the real cursor only where it has something to say. Over a
  declared target the system pointer is hidden and this becomes the pointer;
  everywhere else the native arrow and I-beam stay exactly where they were, so
  text selection, a high-contrast pointer and anyone's OS cursor settings all
  survive, and a stalled rAF loop can only ever cost you the pointer while you
  are already parked on a card. Hiding it globally is the version of this
  effect that breaks all of that at once.

  The swap needs a second element to be honest. The ring lags the pointer on
  purpose, which is fine as decoration riding behind a real arrow and a lie the
  moment it IS the arrow: at speed the ring sits most of an inch behind where a
  click would land. So the hidden native cursor is replaced by a dot pinned to
  the raw pointer position with no smoothing at all, and the ring keeps its lag
  around it. The dot is where you are; the ring is how you got there.

  It never mounts where it does not belong. Touch and hybrid devices, coarse
  pointers, and reduced motion all skip it entirely, same gate BlockName uses
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
  const dotRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!enabled) return
    const wrap = wrapRef.current
    const ring = ringRef.current
    const label = labelRef.current
    const dot = dotRef.current
    if (!wrap || !ring || !label || !dot) return

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

    // the attribute is what index.css hangs `cursor: none` off. Keeping it on
    // the root rather than on the target itself means one rule, no per-element
    // bookkeeping, and nothing left hidden if a target unmounts under the
    // pointer mid-hover
    const swap = (on: boolean) => {
      document.documentElement.toggleAttribute('data-cursor-swap', on)
      dot.style.opacity = on ? '1' : '0'
    }

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
      // hovering. The first version scaled 2.6x on a 36px ring (94px of solid
      // accent blue over the copy), which is the difference between a cursor
      // with an opinion and a cursor in the way.
      targetScale = next ? 1.7 : 1
      label.textContent = next === 'link' || next === '' ? '' : next
      ring.dataset.state = next ? 'active' : 'idle'
      // the swap: the system pointer goes away exactly while the ring is the
      // pointer, and the dot takes over the job of saying where the click
      // lands. Driven off the same state as the swell, so the two can never
      // disagree and no element is left with `cursor: none` and nothing on it
      swap(!!next)
    }

    const onLeave = () => {
      visible = false
      wrap.style.opacity = '0'
      swap(false)
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
      // position on the wrapper, scale on the ring alone, otherwise the label
      // grows and drifts with the swell instead of staying put and legible
      wrap.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
      ring.style.transform = `scale(${scale})`
      // no smoothing on this one, ever: it stands in for the hidden system
      // pointer, and a pointer that lags is a pointer that lies
      dot.style.transform = `translate3d(${targetX}px, ${targetY}px, 0) translate(-50%, -50%)`
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
    const offOverlay = onOverlayChange(() => {
      // A dialog opening under a stationary pointer means the target it was
      // over is now behind a modal, and no pointerover is coming to say so.
      // Give the system cursor back rather than leave it hidden over a panel
      // the ring has nothing to say about.
      if (currentLabel) {
        currentLabel = ''
        targetScale = 1
        label.textContent = ''
        ring.dataset.state = 'idle'
        swap(false)
      }
      run()
    })

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerleave', onLeave)
      offOverlay()
      document.documentElement.removeAttribute('data-cursor-swap')
    }
  }, [enabled])

  if (!enabled) return null

  return (
    <>
      {/* the stand-in for the hidden system pointer: its own fixed layer,
          because the ring's wrapper sits at the SMOOTHED position and this has
          to sit at the real one */}
      <div
        ref={dotRef}
        aria-hidden
        style={{ opacity: 0 }}
        className="pointer-events-none fixed top-0 left-0 z-[61] h-[5px] w-[5px] rounded-full bg-blue-600 transition-opacity duration-150 dark:bg-blue-400"
      />
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
    </>
  )
}
