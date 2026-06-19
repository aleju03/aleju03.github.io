import { useEffect, useState } from 'react'
import { GlobeHemisphereWestIcon, MoonIcon, SunIcon } from '@phosphor-icons/react'
import { currentTheme, onThemeChange, toggleThemeFrom, watchSystemTheme } from '../theme'
import { useI18n } from '../i18n'

/** compact theme + language pair, shared by the version chooser and the simple
    résumé. No motion, so it stays in the initial bundle without pulling weight. */
export function MiniControls({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState(() => currentTheme())
  const { language, setLanguage, t } = useI18n()
  const other = language === 'en' ? 'es' : 'en'

  useEffect(() => {
    const offChange = onThemeChange(setTheme)
    const offSystem = watchSystemTheme()
    return () => {
      offChange()
      offSystem()
    }
  }, [])

  const pill =
    'inline-flex items-center justify-center rounded-full border border-stone-200 text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-900 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-500 dark:hover:text-stone-100'

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <button
        type="button"
        onClick={() => setLanguage(other)}
        aria-label={t.nav.language}
        className={`${pill} gap-1.5 px-3 py-2 font-mono text-xs font-medium`}
      >
        <GlobeHemisphereWestIcon size={15} weight="bold" aria-hidden="true" />
        {language.toUpperCase()}
      </button>
      <button
        type="button"
        onClick={(e) => toggleThemeFrom(e.clientX || innerWidth - 40, e.clientY || 32)}
        aria-label={theme === 'dark' ? t.nav.switchLight : t.nav.switchDark}
        className={`${pill} p-2.5`}
      >
        {theme === 'dark' ? <SunIcon size={15} weight="bold" /> : <MoonIcon size={15} weight="bold" />}
      </button>
    </div>
  )
}
