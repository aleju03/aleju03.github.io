import { ArrowUpRightIcon, GithubLogoIcon, LinkedinLogoIcon } from '@phosphor-icons/react'
import { email, github, linkedin } from '../data/projects'
import { Reveal } from './Reveal'

export function Contact() {
  return (
    <section id="contact" className="scroll-mt-16 border-t border-stone-200 dark:border-stone-800">
      <div className="mx-auto max-w-6xl px-5 pt-16 sm:px-8 lg:pt-20">
        <Reveal>
          <img
            src="/brand/contact.webp"
            alt="Hand-drawn illustration of a paper airplane looping over rounded hills"
            width={1800}
            height={772}
            loading="lazy"
            className="w-full dark:hue-rotate-180 dark:invert"
          />
        </Reveal>
      </div>
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-24">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tighter text-stone-900 sm:text-4xl dark:text-stone-50">
            Get in touch
          </h2>
          <p className="mt-4 max-w-md leading-relaxed text-stone-600 dark:text-stone-400">
            Open to interesting projects and good conversations about software.
          </p>
          <a
            href={`mailto:${email}`}
            className="group mt-10 inline-flex max-w-full flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight text-blue-600 transition-colors hover:text-blue-700 sm:text-4xl lg:text-5xl dark:text-blue-400 dark:hover:text-blue-300"
          >
            <span className="break-all">{email}</span>
            <ArrowUpRightIcon
              size={28}
              weight="bold"
              className="transition-transform duration-300 group-hover:translate-x-1 group-hover:-translate-y-1"
            />
          </a>
        </Reveal>
      </div>
      <footer className="border-t border-stone-200 dark:border-stone-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 sm:px-8">
          <p className="text-sm text-stone-500">Alejandro Jiménez, Costa Rica</p>
          <div className="flex items-center gap-4">
            <a
              href={github}
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub profile"
              className="-m-2 p-2 text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-200"
            >
              <GithubLogoIcon size={18} weight="bold" />
            </a>
            <a
              href={linkedin}
              target="_blank"
              rel="noreferrer"
              aria-label="LinkedIn profile"
              className="-m-2 p-2 text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-200"
            >
              <LinkedinLogoIcon size={18} weight="bold" />
            </a>
          </div>
        </div>
      </footer>
    </section>
  )
}
