/*
  The machine act — the site's punchline, given a chapter instead of a footnote.

  Two halves. First a band of paper taped across the page (TearSheet) with the
  chapter's opening printed on the wall behind it: rip the paper and you find
  the terminal underneath. Then a pinned stage, ~200vh of runway with one
  viewport stuck to the top, where the dead CRT that has been lying in the
  corner of this site since the footer existed stands up as you scroll and
  lights its tube.

  The CRT itself is not rendered here. It lives in BlockName's canvas — the
  document-pinned 3D world that also carries the name and the paper plane — and
  is drawn over whatever rect `#os-wreck` occupies. So this component owns the
  stage and the copy, and BlockName owns the model: enlarging the span here is
  what moves the machine. The one thing that had to change over there is that
  a STICKY stage's document position moves every frame, which `layoutWreck`'s
  `rect.top + scrollY` cannot express — see the per-frame re-pin in its tick.

  Nothing here gates the page. The copy is fully legible with the paper intact,
  the CTA works whether or not you tore anything, and the whole act degrades to
  a plain section under reduced motion.
*/

import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { ArrowRightIcon } from '@phosphor-icons/react'
import { SectionHeading } from './SectionHeading'
import { warpToOs } from '../warp'
import { useI18n } from '../i18n'
import { isCoarsePointer } from '../device'
import { cue } from '../audio'

const TearSheet = lazy(() => import('./TearSheet'))

export function Machine() {
  const { t } = useI18n()
  const reduce = useReducedMotion()
  const runwayRef = useRef<HTMLDivElement>(null)
  const [torn, setTorn] = useState(false)
  const poweredRef = useRef(false)
  const coarse = typeof window !== 'undefined' && isCoarsePointer()

  const { scrollYProgress } = useScroll({
    target: runwayRef,
    offset: ['start start', 'end end'],
  })
  // the copy settles into place over the first third of the runway, which is
  // the same stretch BlockName uses to stand the machine up
  const copyY = useTransform(scrollYProgress, [0, 0.35], reduce ? [0, 0] : [40, 0])
  const copyOpacity = useTransform(scrollYProgress, [0, 0.28], reduce ? [1, 1] : [0, 1])
  const ctaOpacity = useTransform(scrollYProgress, [0.34, 0.5], reduce ? [1, 1] : [0, 1])
  // the heading is pinned, so it cannot scrub off its own rect — hand it the
  // runway's progress over the stretch where the machine is standing up
  const headingProgress = useTransform(scrollYProgress, [0.02, 0.3], [0, 1])

  useEffect(() => {
    if (reduce) return
    return scrollYProgress.on('change', (v) => {
      // one shot, at the moment the tube would be warm. A ref, not state:
      // nothing renders differently, and the cue must fire exactly once
      if (v > 0.4 && !poweredRef.current) {
        poweredRef.current = true
        cue('power')
      }
    })
  }, [scrollYProgress, reduce])

  return (
    <section id="machine" className="scroll-mt-16 border-t border-stone-200 dark:border-stone-800">
      {/* the paper cover, and the terminal printed on the wall behind it */}
      <div className="relative h-[62vh] min-h-[320px] overflow-hidden bg-stone-950 sm:h-[70vh]">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <p
            className="max-w-2xl font-mono text-sm leading-relaxed text-emerald-300/70 sm:text-base"
            style={{ textShadow: '0 0 12px rgba(52,211,153,0.35)' }}
          >
            {t.machine.body}
          </p>
        </div>
        {!reduce && (
          <Suspense fallback={null}>
            <TearSheet onOpen={() => setTorn(true)} />
          </Suspense>
        )}
        {!reduce && (
          <span
            className={`pointer-events-none absolute inset-x-0 bottom-6 text-center font-mono text-xs tracking-[0.2em] text-stone-400 uppercase transition-opacity duration-500 ${
              torn ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {coarse ? t.machine.tapHint : t.machine.tearHint}
          </span>
        )}
      </div>

      {/* the pinned act: one viewport of stage over a long runway */}
      <div ref={runwayRef} data-station="machine" className="h-[200vh]">
        <div className="sticky top-0 flex h-dvh flex-col items-center justify-center overflow-hidden px-5 sm:px-8">
          <motion.div
            style={{ y: copyY, opacity: copyOpacity }}
            className="mx-auto w-full max-w-6xl"
          >
            <SectionHeading index="05" eyebrow={t.machine.status} progress={headingProgress}>
              {t.machine.chapter}
            </SectionHeading>
          </motion.div>

          {/* BlockName draws the CRT over this span and reveals the button once
              the model lands; it stays hidden where the 3D never mounts */}
          <button
            type="button"
            style={{ display: 'none' }}
            onClick={() => warpToOs()}
            aria-label={t.machine.bootAria}
            className="mt-6 flex w-full max-w-[620px] cursor-pointer items-center justify-center"
          >
            <span id="os-wreck" aria-hidden className="block h-[34vh] max-h-[380px] min-h-[180px] w-full" />
          </button>

          <motion.div style={{ opacity: ctaOpacity }} className="mt-8">
            <button
              type="button"
              onClick={() => warpToOs()}
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-blue-600 px-7 text-sm font-medium text-white transition hover:bg-blue-700 active:scale-[0.98] dark:hover:bg-blue-500"
            >
              {t.machine.boot}
              <ArrowRightIcon
                size={15}
                weight="bold"
                className="transition-transform duration-300 group-hover:translate-x-1"
              />
            </button>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
