import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getSaver, runSaver, subscribeSaver } from './screensaver'

/*
  The idle watch over the desktop. It counts inactivity with one interval
  rather than a timer reset per event, because the events that mean "someone
  is still here" arrive in bursts (a mouse move is dozens of them) and
  rescheduling a timeout on every one of them is a lot of churn to answer a
  question we only need the answer to once a second.

  Waking is deliberately swallowed: the overlay sits above everything and
  takes the click itself, so the press that dismisses the stars cannot also
  land on a file icon underneath it.
*/

export function ScreensaverLayer({ enabled }: { enabled: boolean }) {
  const prefs = useSyncExternalStore(subscribeSaver, getSaver)
  // idle seconds, not an is-it-showing flag: whether the saver is up is a
  // function of this number and the preference, so nothing has to remember
  // to switch it off when the preference or the phase changes underneath it
  const [idle, setIdle] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const off = prefs.id === 'none' || !enabled
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const on = !off && !reduced && idle >= prefs.delay * 60

  useEffect(() => {
    if (off || reduced) return
    const wake = () => setIdle(0)
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }))
    const id = window.setInterval(() => setIdle((s) => s + 1), 1000)
    return () => {
      window.clearInterval(id)
      events.forEach((e) => window.removeEventListener(e, wake))
    }
  }, [off, reduced])

  // the picture itself, for as long as it is up
  useEffect(() => {
    if (!on || !canvasRef.current) return
    return runSaver(canvasRef.current, prefs.id)
  }, [on, prefs.id])

  if (!on) return null

  return (
    <div
      aria-hidden
      onPointerDown={() => setIdle(0)}
      onPointerMove={() => setIdle(0)}
      onWheel={() => setIdle(0)}
      className="absolute inset-0 z-[9000] cursor-none bg-black"
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  )
}
