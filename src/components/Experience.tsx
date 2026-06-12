import { ArrowUpRightIcon } from '@phosphor-icons/react'
import { Reveal } from './Reveal'
import { FlagDoodle } from './Doodles'
import { useI18n, type Language } from '../i18n'

interface Stop {
  org: string
  role: string
  period: string
  detail: string
  url: string
  /** 'full' fills the tile edge to edge, for marks with their own background baked in */
  logo: { src: string; alt: string; tile: 'light' | 'dark' | 'full' }
  translations?: Partial<Record<Language, Pick<Stop, 'role' | 'period' | 'detail'>>>
}

const STOPS: Stop[] = [
  {
    org: 'Tecnológico de Costa Rica',
    role: 'Computer Engineering student',
    period: '2021 - present',
    detail: 'Studying at the San Carlos campus, graduating in October 2026.',
    url: 'https://www.tec.ac.cr',
    logo: { src: '/experience/tec.png', alt: 'Tecnológico de Costa Rica logo', tile: 'light' },
    translations: {
      es: {
        role: 'Estudiante de Ingeniería en Computación',
        period: '2021 - presente',
        detail: 'Estudiando en la sede San Carlos, con graduación prevista para octubre de 2026.',
      },
    },
  },
  {
    org: 'Hackathon 4.0 COL-CR',
    role: 'Participant',
    period: 'May 2024',
    detail: 'International hackathon held with Universidad Javeriana in Colombia.',
    url: 'https://ingenieria.javeriana.edu.co/hackathon',
    logo: { src: '/experience/hackathon.png', alt: 'Hackathon 4.0 COL-CR logo', tile: 'light' },
    translations: {
      es: {
        role: 'Participante',
        period: 'Mayo 2024',
        detail: 'Hackathon internacional realizado con la Universidad Javeriana en Colombia.',
      },
    },
  },
  {
    org: 'Bufost',
    role: 'Software development intern',
    period: 'Oct - Nov 2025',
    detail: 'Built a full-stack Next.js app with a Firebase backend.',
    url: 'https://www.bufost.com',
    logo: { src: '/experience/bufost.png', alt: 'Bufost logo', tile: 'full' },
    translations: {
      es: {
        role: 'Practicante de desarrollo de software',
        period: 'Oct - Nov 2025',
        detail: 'Construí una app full-stack en Next.js con backend en Firebase.',
      },
    },
  },
  {
    org: 'Bitcode Enterprise',
    role: 'Professional practice',
    period: 'Feb - Jun 2026',
    detail: 'Built an internal app to manage their clients and developers.',
    url: 'https://bitcode-enterprise.com',
    logo: { src: '/experience/bitcode.svg', alt: 'Bitcode Enterprise logo', tile: 'dark' },
    translations: {
      es: {
        role: 'Práctica profesional',
        period: 'Feb - Jun 2026',
        detail: 'Construí una app interna para administrar sus clientes y desarrolladores.',
      },
    },
  },
]

function StopLogo({ stop }: { stop: Stop }) {
  const { tile } = stop.logo
  return (
    <div
      className={`flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-stone-200 shadow-sm dark:border-stone-800 ${
        tile === 'dark' ? 'bg-zinc-900 p-3' : tile === 'light' ? 'bg-white p-3' : ''
      }`}
    >
      <img
        src={stop.logo.src}
        alt={stop.logo.alt}
        loading="lazy"
        className={tile === 'full' ? 'h-full w-full object-cover' : 'max-h-full max-w-full object-contain'}
      />
    </div>
  )
}

export function Experience() {
  const { language, t } = useI18n()

  return (
    <section
      id="experience"
      className="scroll-mt-16 border-t border-stone-200 dark:border-stone-800"
    >
      <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <Reveal>
          <div className="flex items-end justify-between gap-6">
            <h2 className="text-3xl font-semibold tracking-tighter text-stone-900 sm:text-4xl dark:text-stone-50">
              {t.sections.experience}
            </h2>
            <FlagDoodle className="-mb-3 w-24 shrink-0 text-stone-800 sm:w-28 dark:text-stone-200" />
          </div>
        </Reveal>

        <div className="relative mt-14">
          {/* the line: horizontal through the logos on desktop, vertical beside them on mobile */}
          <div
            aria-hidden
            className="absolute top-12 right-0 left-0 hidden h-px bg-stone-200 lg:block dark:bg-stone-800"
          />
          <div
            aria-hidden
            className="absolute top-0 bottom-0 left-12 w-px -translate-x-1/2 bg-stone-200 lg:hidden dark:bg-stone-800"
          />

          <ol className="relative grid grid-cols-1 gap-10 lg:grid-cols-4 lg:gap-6">
            {STOPS.map((stop, i) => (
              <li key={stop.org}>
                <Reveal delay={i * 0.08} className="flex gap-5 lg:flex-col lg:gap-4">
                  <StopLogo stop={stop} />
                  <div>
                    <p className="font-mono text-xs text-stone-500">
                      {(stop.translations?.[language] ?? stop).period}
                    </p>
                    <a
                      href={stop.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group mt-1 inline-flex items-center gap-1 font-semibold tracking-tight text-stone-900 transition-colors hover:text-blue-600 dark:text-stone-100 dark:hover:text-blue-400"
                    >
                      {stop.org}
                      <ArrowUpRightIcon
                        size={13}
                        weight="bold"
                        className="text-stone-400 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-400"
                      />
                    </a>
                    <p className="mt-0.5 text-sm font-medium text-stone-600 dark:text-stone-300">
                      {(stop.translations?.[language] ?? stop).role}
                    </p>
                    <p className="mt-1.5 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
                      {(stop.translations?.[language] ?? stop).detail}
                    </p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
