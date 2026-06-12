import { Suspense, lazy, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowDownIcon, GithubLogoIcon } from '@phosphor-icons/react'
import { github } from '../data/projects'
import { StaticName } from './StaticName'

const HeroScene = lazy(() => import('./HeroScene'))
const BlockName = lazy(() => import('./BlockName'))

export function Hero() {
  const reduce = useReducedMotion()
  const enter = (delay: number) => ({
    initial: reduce ? false : ({ opacity: 0, y: 24 } as const),
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.8, delay, ease: [0.16, 1, 0.3, 1] as const },
  })

  // the 3D name draws on a section-wide canvas so dragged letters never clip;
  // this slot marks where it assembles, and StaticName covers every fallback
  const nameSlotRef = useRef<HTMLDivElement>(null)
  const resetBlocksRef = useRef<() => void>(() => {})
  const [blocksActive, setBlocksActive] = useState(false)
  const [scrambled, setScrambled] = useState(false)

  return (
    <section className="relative overflow-hidden">
      <Suspense fallback={null}>
        <HeroScene />
      </Suspense>
      {/* fade the dot field toward the edges so text stays readable */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,var(--page)_0%,transparent_35%,transparent_60%,var(--page)_100%)]"
      />
      {!reduce && (
        <Suspense fallback={null}>
          <BlockName
            slotRef={nameSlotRef}
            resetRef={resetBlocksRef}
            onActive={setBlocksActive}
            onScrambled={setScrambled}
          />
        </Suspense>
      )}

      <div className="relative mx-auto flex min-h-[calc(100dvh-4rem)] max-w-6xl flex-col justify-center px-5 pb-16 sm:px-8">
        <motion.div {...enter(0)}>
          <h1 className="sr-only">Alejandro Jiménez</h1>
          <div className="relative">
            <div
              ref={nameSlotRef}
              aria-hidden
              className="w-full max-w-2xl sm:max-w-3xl lg:max-w-4xl"
            >
              <div
                className={`transition-opacity duration-[400ms] ${
                  blocksActive ? 'opacity-0' : 'opacity-100'
                }`}
              >
                <StaticName />
              </div>
            </div>
            <div className="absolute top-full left-1 mt-2">
              <button
                type="button"
                onClick={() => resetBlocksRef.current()}
                className={`cursor-pointer font-mono text-xs text-stone-500 underline decoration-dotted underline-offset-4 transition-opacity duration-300 hover:text-stone-900 dark:hover:text-stone-200 ${
                  scrambled ? 'opacity-100' : 'pointer-events-none opacity-0'
                }`}
              >
                fix my name
              </button>
            </div>
          </div>
        </motion.div>
        <motion.p
          {...enter(0.12)}
          className="mt-7 max-w-md leading-relaxed text-stone-600 dark:text-stone-400"
        >
          Full-stack developer from Costa Rica. I build web apps end to end, from React frontends
          to the servers behind them.
        </motion.p>
        <motion.div {...enter(0.24)} className="mt-9 flex flex-wrap items-center gap-3">
          <a
            href="#work"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-blue-600 px-6 text-sm font-medium text-white transition hover:bg-blue-700 active:scale-[0.98] dark:hover:bg-blue-500"
          >
            View work
            <ArrowDownIcon size={15} weight="bold" />
          </a>
          <a
            href={github}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-full border border-stone-300 bg-white/60 px-6 text-sm font-medium text-stone-700 backdrop-blur-sm transition hover:border-stone-400 active:scale-[0.98] dark:border-stone-700 dark:bg-stone-900/60 dark:text-stone-300 dark:hover:border-stone-500"
          >
            <GithubLogoIcon size={16} weight="bold" />
            GitHub
          </a>
        </motion.div>
      </div>
    </section>
  )
}
