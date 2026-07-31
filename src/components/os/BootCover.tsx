import { useEffect, useState } from 'react'
import type { LoadStage } from './CrtScene'

/*
  The cover over a cold 3D boot.

  Booting the room is not free and cannot be made free: most of the wait is
  the GPU driver linking this scene's shader pile, which is a few seconds the
  first time a visitor ever loads the site and almost nothing afterwards, once
  the browser has the compiled programs cached. Before this existed the whole
  wait was a black rectangle, which reads as broken rather than as loading.

  One detail decides whether this works at all, and it is the reason the bar
  is a `scaleX` transform and not a width:

    the main thread is *blocked* for most of what this is covering.

  Shader linking blocks it in multi-second lumps. Anything driven by
  JavaScript (a rAF loop, a counter, a spinner rendered by React) freezes
  solid for exactly the part of the load the visitor most needs to be told is
  still going. Transform and opacity transitions run on the compositor, which
  keeps ticking while the main thread is stuck, so the bar goes on creeping
  through a three-second stall that would have frozen anything else. Nothing
  in here may animate any other property.

  So each stage sets a target scale and a duration roughly matched to how long
  that stage really takes (measured, and wildly uneven: shaders is most of
  it), and the compositor walks the bar there on its own. If a stage finishes
  early the next target simply takes over mid-transition.

  This is no longer only a boot cover. The room now loads without the open
  world, so opening the front door pulls the planet in behind this same cover
  mid-session. `gone` latches on purpose (once a run is over this unmounts for
  good), and AlejOS gives it a fresh `key` per load run rather than asking it to
  un-latch, which keeps the fade honest on every run instead of only the first.

  Copy is English only, like the rest of AlejOS: the desktop, its windows and
  the walk HUD are all in-fiction and none of them are translated.
*/

/** where the bar goes when a stage begins, and how long to take getting
    there. The durations are the measured wall clock of a cold first load:
    it is better for the bar to arrive early and wait than to still be at a
    tenth when the room appears */
/** 'stepping' is StepOutCover's, not this component's; see LoadStage */
const STAGES: Record<Exclude<LoadStage, 'stepping'>, { to: number; ms: number; label: string }> = {
  models: { to: 0.14, ms: 700, label: 'loading the room' },
  world: { to: 0.3, ms: 1200, label: 'building the world' },
  // 7000 was measured when every boot built the planet. Splitting the room
  // out took the ordinary one to about four seconds, so the bar used to be
  // barely half way across when the room appeared, which is the failure the
  // note above says to avoid. Four is the room's own figure; /world still
  // takes its old twelve and simply sits at 0.93 waiting, which is the side
  // to be wrong on.
  shaders: { to: 0.93, ms: 4000, label: 'compiling shaders' },
}

/** the stages this cover draws; 'stepping' belongs to StepOutCover */
type BootStage = Exclude<LoadStage, 'stepping'>

export default function BootCover({ stage }: { stage: BootStage | null }) {
  const [gone, setGone] = useState(false)
  const done = stage === null

  useEffect(() => {
    if (!done) return
    // the fade is the last thing between a finished load and the room; it was
    // half a second of holding a black rectangle over a scene already drawing
    const t = setTimeout(() => setGone(true), 300)
    return () => clearTimeout(t)
  }, [done])

  if (gone) return null
  // null means the first frame landed, and the stage before that is always
  // 'shaders', so the bar and the caption hold their last real value through
  // the fade instead of snapping back to the start of the run
  const step = STAGES[stage ?? 'shaders']

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-stone-950"
      style={{
        opacity: done ? 0 : 1,
        transition: 'opacity 240ms ease-out',
      }}
    >
      <style>{`
        @keyframes bootcover-sweep {
          from { transform: translateX(-100%) }
          to   { transform: translateX(320%) }
        }
      `}</style>
      <div className="flex w-56 flex-col items-center gap-4">
        <p className="font-mono text-[11px] tracking-[0.42em] text-stone-500 uppercase">
          alejOS
        </p>
        <div className="relative h-px w-full overflow-hidden bg-stone-800">
          {/* the honest part: how far along the load actually is */}
          <div
            className="absolute inset-0 origin-left bg-stone-300"
            style={{
              transform: `scaleX(${done ? 1 : step.to})`,
              transition: `transform ${done ? 240 : step.ms}ms linear`,
            }}
          />
          {/* ...and a sweep over it, so there is motion even in the seconds
              where the main thread is not coming back to update anything */}
          <div
            className="absolute inset-y-0 w-1/3 bg-stone-100/70"
            style={{ animation: 'bootcover-sweep 1.5s ease-in-out infinite' }}
          />
        </div>
        <p className="font-mono text-[10px] tracking-[0.2em] text-stone-600 lowercase">
          {done ? 'ready' : step.label}
        </p>
      </div>
    </div>
  )
}
