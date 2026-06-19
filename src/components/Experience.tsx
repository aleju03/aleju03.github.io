import { ArrowUpRightIcon } from '@phosphor-icons/react'
import { Reveal } from './Reveal'
import { FlagDoodle } from './Doodles'
import { useI18n, type Language } from '../i18n'
import { STOPS, type Stop } from '../data/experience'

/* Claude spark mark, in Anthropic's terracotta */
function ClaudeSpark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="#D97757">
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  )
}

function PoweredByClaude({ language }: { language: Language }) {
  return (
    <span>
      {' '}
      {language === 'es' ? 'Impulsada por' : 'Powered by'}{' '}
      <a
        href="https://claude.com"
        target="_blank"
        rel="noreferrer"
        className="group/claude inline-flex items-baseline gap-1 align-baseline"
      >
        <span
          className="text-[15px] font-medium tracking-tight text-stone-800 transition-colors group-hover/claude:text-[#D97757] dark:text-stone-200"
          style={{ fontFamily: "'Copernicus', 'Tiempos Text', Georgia, 'Times New Roman', serif" }}
        >
          Claude
        </span>
        <ClaudeSpark className="h-3 w-3 self-center" />
      </a>
    </span>
  )
}

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
                      {stop.poweredByClaude && <PoweredByClaude language={language} />}
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
