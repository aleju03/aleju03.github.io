import { ArrowUpRightIcon, GithubLogoIcon, LinkedinLogoIcon } from '@phosphor-icons/react'
import { email, github, linkedin } from '../data/projects'
import { BOOT_OS_EVENT, OPEN_CHOOSER_EVENT } from '../events'
import { LocalTime } from './LocalTime'
import { Reveal } from './Reveal'
import { SectionHeading } from './SectionHeading'
import { useI18n } from '../i18n'
import { track } from '../analytics'

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
        <SectionHeading index="06">{t.sections.contact}</SectionHeading>
        <Reveal>
          <p className="mt-6 max-w-md leading-relaxed text-stone-600 dark:text-stone-400">
            {t.contact.body}
          </p>
          <a
            href={`mailto:${email}`}
            data-cursor="link"
            onClick={() => track('contact_click', { target: 'email' })}
            className="group mt-10 inline-flex max-w-full flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight text-blue-600 transition-colors hover:text-blue-700 sm:text-4xl lg:text-5xl dark:text-blue-400 dark:hover:text-blue-300"
          >
            <span className="break-all">{email}</span>
            <ArrowUpRightIcon
              size={28}
              weight="bold"
              className="transition-transform duration-300 group-hover:translate-x-1 group-hover:-translate-y-1"
            />
          </a>
          {/* the quieter channel: boots AlejOS with the chat queued so the
              visitor lands in the rooms right after login */}
          <p className="mt-5">
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent(BOOT_OS_EVENT, { detail: { app: 'chat', via: 'contact' } }))
              }
              className="cursor-pointer text-left text-sm text-stone-500 underline decoration-stone-300 decoration-dotted underline-offset-4 transition-colors hover:text-stone-700 dark:decoration-stone-700 dark:hover:text-stone-300"
            >
              {t.contact.chatTease}
            </button>
          </p>
        </Reveal>
        {/* the OS's machine used to sit in this corner as a small aside; it now
            has its own chapter above (Machine.tsx), which owns the #os-wreck
            stage BlockName draws the 3D model over */}
      </div>
      <footer className="border-t border-stone-200 dark:border-stone-800">
        <div className="mx-auto grid max-w-6xl gap-3 px-5 py-6 sm:px-8 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
          <div className="md:justify-self-start">
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-stone-500">
              <span>{t.contact.footer} ·</span>
              <LocalTime className="font-mono" />
            </p>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event(OPEN_CHOOSER_EVENT))}
              className="mt-1 cursor-pointer font-mono text-xs text-stone-400 underline decoration-stone-300 decoration-dotted underline-offset-4 transition-colors hover:text-stone-700 dark:decoration-stone-700 dark:hover:text-stone-300"
            >
              {t.nav.switchVersion}
            </button>
          </div>
          <p
            className="text-base font-medium text-stone-600 italic md:translate-x-6 md:justify-self-center dark:text-stone-400"
            style={{ fontFamily: "Georgia, 'Times New Roman', Times, serif" }}
          >
            {t.contact.footerQuote}
          </p>
          <div className="flex items-center gap-4 md:justify-self-end">
            <a
              href={github}
              target="_blank"
              rel="noreferrer"
              onClick={() => track('contact_click', { target: 'github' })}
              aria-label={t.nav.github}
              className="-m-2 p-2 text-stone-500 transition-colors hover:text-stone-900 dark:hover:text-stone-200"
            >
              <GithubLogoIcon size={18} weight="bold" />
            </a>
            <a
              href={linkedin}
              target="_blank"
              rel="noreferrer"
              onClick={() => track('contact_click', { target: 'linkedin' })}
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
