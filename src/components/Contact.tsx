import { ArrowUpRightIcon, GithubLogoIcon, LinkedinLogoIcon } from '@phosphor-icons/react'
import { email, github, linkedin } from '../data/projects'
import { BOOT_OS_EVENT } from '../events'
import { Reveal } from './Reveal'
import { useI18n } from '../i18n'

export function Contact() {
  const { t } = useI18n()

  return (
    <section id="contact" className="scroll-mt-16 border-t border-stone-200 dark:border-stone-800">
      <div className="mx-auto max-w-6xl px-5 pt-16 sm:px-8 lg:pt-20">
        <Reveal>
          <img
            src="/brand/contact.webp"
            alt={t.contact.imageAlt}
            width={1800}
            height={772}
            loading="lazy"
            className="w-full dark:hue-rotate-180 dark:invert"
          />
        </Reveal>
      </div>
      <div className="relative mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-24">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tighter text-stone-900 sm:text-4xl dark:text-stone-50">
            {t.sections.contact}
          </h2>
          <p className="mt-4 max-w-md leading-relaxed text-stone-600 dark:text-stone-400">
            {t.contact.body}
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
        {/* the OS's own machine, dumped in the corner: BlockName draws the 3D
            wreck over the stage span and reveals this button once the model
            loads. Clicking it boots AlejOS; crashing the paper plane into its
            screen takes the same trip. On large screens it shares the contact
            block's vertical band (absolute, bottom right) so it adds no
            height; on small ones it stacks below the email. Where the 3D
            scene never mounts the button stays hidden and the page ends at
            the footer as before. */}
        <div className="flex justify-end">
          <button
            type="button"
            style={{ display: 'none' }}
            onClick={() => window.dispatchEvent(new Event(BOOT_OS_EVENT))}
            aria-label={t.contact.wreckAria}
            className="group mt-10 flex cursor-pointer flex-col items-center gap-1 lg:absolute lg:right-8 lg:bottom-0 lg:mt-0"
          >
            <span id="os-wreck" aria-hidden className="block h-32 w-64 sm:h-40 sm:w-80" />
            <span className="font-mono text-xs text-stone-400 transition-colors group-hover:text-stone-600 dark:text-stone-600 dark:group-hover:text-stone-300">
              {t.contact.wreck}
            </span>
          </button>
        </div>
      </div>
      <footer className="border-t border-stone-200 dark:border-stone-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 sm:px-8">
          <p className="text-sm text-stone-500">{t.contact.footer}</p>
          <div className="flex items-center gap-4">
            <a
              href={github}
              target="_blank"
              rel="noreferrer"
              aria-label={t.nav.github}
              className="-m-2 p-2 text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-200"
            >
              <GithubLogoIcon size={18} weight="bold" />
            </a>
            <a
              href={linkedin}
              target="_blank"
              rel="noreferrer"
              aria-label={t.nav.linkedin}
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
