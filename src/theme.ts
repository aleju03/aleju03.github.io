import { isCoarsePointer } from './device'

export type Theme = 'light' | 'dark'

const listeners = new Set<(t: Theme) => void>()
let themeTransitionRunning = false

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  localStorage.setItem('theme', theme)
  listeners.forEach((l) => l(theme))
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark')
}

/** circular wipe from the toggle position, when the browser supports it */
export function toggleThemeFrom(x: number, y: number) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || reduce || isCoarsePointer() || themeTransitionRunning) {
    toggleTheme()
    return
  }

  themeTransitionRunning = true
  const transition = document.startViewTransition(() => toggleTheme())
  transition.ready
    .then(() => {
      const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 360, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
      )
    })
    .catch(() => {})
  transition.finished
    .finally(() => {
      themeTransitionRunning = false
    })
    .catch(() => {})
}

export function onThemeChange(listener: (t: Theme) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** follow OS changes while the user has not chosen manually */
export function watchSystemTheme() {
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => {
    if (localStorage.getItem('theme')) return
    const t: Theme = e.matches ? 'dark' : 'light'
    document.documentElement.classList.toggle('dark', t === 'dark')
    listeners.forEach((l) => l(t))
  }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
