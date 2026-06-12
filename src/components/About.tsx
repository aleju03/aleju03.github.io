import { Reveal } from './Reveal'
import { ToolsGrid } from './ToolsGrid'

export function About() {
  return (
    <section id="about" className="scroll-mt-16 border-t border-stone-200 dark:border-stone-800">
      <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <div className="grid items-start gap-12 lg:grid-cols-[1fr_minmax(0,360px)] lg:gap-20">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tighter text-stone-900 sm:text-4xl dark:text-stone-50">
              About
            </h2>
            <div className="mt-6 max-w-[65ch] space-y-4 leading-relaxed text-stone-600 dark:text-stone-400">
              <p>
                I'm a full-stack developer who likes shipping things end to end: the interface, the
                API behind it, and the server it all runs on.
              </p>
              <p>
                Most of my work runs on React and TypeScript up front, with Python or Node.js behind
                it. I deploy on Vercel for frontends and run my own server for the always-on pieces.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <img
              src="/brand/about.webp"
              alt="Hand-drawn illustration of a developer at a desk beside a server tower and a monstera plant"
              width={900}
              height={1125}
              loading="lazy"
              className="w-full max-w-sm lg:max-w-none dark:hue-rotate-180 dark:invert"
            />
          </Reveal>
        </div>
        <Reveal delay={0.1} className="mt-14">
          <h3 className="font-mono text-sm text-stone-500">Tools I work with</h3>
          <div className="mt-6">
            <ToolsGrid />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
