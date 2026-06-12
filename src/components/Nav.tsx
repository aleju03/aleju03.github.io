import { useEffect, useRef, useState } from 'react'
import {
  CaretDownIcon,
  CheckIcon,
  GithubLogoIcon,
  GlobeHemisphereWestIcon,
  LinkedinLogoIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SunIcon,
} from '@phosphor-icons/react'
import { github, linkedin } from '../data/projects'
import { currentTheme, onThemeChange, toggleThemeFrom, watchSystemTheme } from '../theme'
import { OPEN_PALETTE_EVENT } from '../events'
import { useI18n } from '../i18n'

const isMac = /mac/i.test(navigator.platform)

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
] as const

export function Nav() {
  const [theme, setThemeState] = useState(() => currentTheme())
  const [langOpen, setLangOpen] = useState(false)
  const langRef = useRef<HTMLDivElement>(null)
  const { language, setLanguage, t } = useI18n()
  const links = [
    { label: t.nav.work, href: '#work' },
    { label: t.nav.experience, href: '#experience' },
    { label: t.nav.about, href: '#about' },
    { label: t.nav.contact, href: '#contact' },
  ]

  useEffect(() => {
    const offChange = onThemeChange(setThemeState)
    const offSystem = watchSystemTheme()
    return () => {
      offChange()
      offSystem()
    }
  }, [])

  useEffect(() => {
    if (!langOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !langRef.current?.contains(e.target)) setLangOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLangOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [langOpen])

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-stone-50/95 dark:border-stone-800 dark:bg-stone-950/95 sm:bg-stone-50/80 sm:backdrop-blur-md sm:dark:bg-stone-950/80">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a
          href="#"
          aria-label={t.nav.backToTop}
          className="font-mono text-sm font-bold text-blue-600 dark:text-blue-400"
        >
          aj
        </a>
        <div className="flex items-center gap-1 sm:gap-2">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="hidden rounded-full px-3 py-1.5 text-sm text-stone-500 transition-colors hover:text-stone-900 sm:block dark:text-stone-400 dark:hover:text-stone-100"
            >
              {link.label}
            </a>
          ))}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
            aria-label={t.nav.openPalette}
            className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-stone-200 px-3 py-1.5 text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-900 sm:ml-1 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-500 dark:hover:text-stone-100"
          >
            <MagnifyingGlassIcon size={15} weight="bold" />
            <kbd className="hidden font-mono text-[11px] sm:block">{isMac ? 'Cmd K' : 'Ctrl K'}</kbd>
          </button>
          <a
            href={github}
            target="_blank"
            rel="noreferrer"
            aria-label={t.nav.github}
            className="rounded-full p-2 text-stone-500 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <GithubLogoIcon size={18} weight="bold" />
          </a>
          <a
            href={linkedin}
            target="_blank"
            rel="noreferrer"
            aria-label={t.nav.linkedin}
            className="rounded-full p-2 text-stone-500 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <LinkedinLogoIcon size={18} weight="bold" />
          </a>
          <div ref={langRef} className="relative">
            <button
              type="button"
              onClick={() => setLangOpen((open) => !open)}
              aria-label={t.nav.language}
              aria-haspopup="listbox"
              aria-expanded={langOpen}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-stone-200 px-2.5 py-1.5 font-mono text-xs font-bold text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-900 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-500 dark:hover:text-stone-100"
            >
              <GlobeHemisphereWestIcon size={16} weight="bold" aria-hidden="true" />
              {language.toUpperCase()}
              <CaretDownIcon
                size={10}
                weight="bold"
                aria-hidden="true"
                className={`transition-transform duration-200 ${langOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {langOpen && (
              <ul
                role="listbox"
                aria-label={t.nav.language}
                className="absolute top-full right-0 mt-2 w-36 overflow-hidden rounded-xl border border-stone-200 bg-white py-1 shadow-lg dark:border-stone-700 dark:bg-stone-900"
              >
                {LANGUAGES.map((option) => (
                  <li key={option.code} role="option" aria-selected={language === option.code}>
                    <button
                      type="button"
                      onClick={() => {
                        setLanguage(option.code)
                        setLangOpen(false)
                      }}
                      className="flex w-full cursor-pointer items-center justify-between px-3.5 py-2 text-left text-sm text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                    >
                      {option.label}
                      {language === option.code && (
                        <CheckIcon
                          size={14}
                          weight="bold"
                          className="text-blue-600 dark:text-blue-400"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={(e) => toggleThemeFrom(e.clientX || innerWidth - 40, e.clientY || 32)}
            aria-label={theme === 'dark' ? t.nav.switchLight : t.nav.switchDark}
            className="cursor-pointer rounded-full p-2 text-stone-500 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            {theme === 'dark' ? (
              <SunIcon size={18} weight="bold" />
            ) : (
              <MoonIcon size={18} weight="bold" />
            )}
          </button>
        </div>
      </nav>
    </header>
  )
}
