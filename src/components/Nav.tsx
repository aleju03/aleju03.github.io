import { useEffect, useState } from 'react'
import {
  GithubLogoIcon,
  LinkedinLogoIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SunIcon,
} from '@phosphor-icons/react'
import { github, linkedin } from '../data/projects'
import { currentTheme, onThemeChange, toggleThemeFrom, watchSystemTheme } from '../theme'
import { OPEN_PALETTE_EVENT } from '../events'

const links = [
  { label: 'Work', href: '#work' },
  { label: 'Experience', href: '#experience' },
  { label: 'About', href: '#about' },
  { label: 'Contact', href: '#contact' },
]

const isMac = /mac/i.test(navigator.platform)

export function Nav() {
  const [theme, setThemeState] = useState(() => currentTheme())

  useEffect(() => {
    const offChange = onThemeChange(setThemeState)
    const offSystem = watchSystemTheme()
    return () => {
      offChange()
      offSystem()
    }
  }, [])

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-stone-50/80 backdrop-blur-md dark:border-stone-800 dark:bg-stone-950/80">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a
          href="#"
          aria-label="Back to top"
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
            aria-label="Open command palette"
            className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-stone-200 px-3 py-1.5 text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-900 sm:ml-1 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-500 dark:hover:text-stone-100"
          >
            <MagnifyingGlassIcon size={15} weight="bold" />
            <kbd className="hidden font-mono text-[11px] sm:block">{isMac ? 'Cmd K' : 'Ctrl K'}</kbd>
          </button>
          <a
            href={github}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub profile"
            className="rounded-full p-2 text-stone-500 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <GithubLogoIcon size={18} weight="bold" />
          </a>
          <a
            href={linkedin}
            target="_blank"
            rel="noreferrer"
            aria-label="LinkedIn profile"
            className="rounded-full p-2 text-stone-500 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <LinkedinLogoIcon size={18} weight="bold" />
          </a>
          <button
            type="button"
            onClick={(e) => toggleThemeFrom(e.clientX || innerWidth - 40, e.clientY || 32)}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
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
