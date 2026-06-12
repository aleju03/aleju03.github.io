import { isCoarsePointer } from './device'

export type Theme = 'light' | 'dark'

/** duration of the toggle crossfade; .theme-fade in index.css must match */
export const THEME_FADE_MS = 200

const listeners = new Set<(t: Theme) => void>()
let fadeTimer: ReturnType<typeof setTimeout> | undefined
let wipeRunning = false

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

/** toggle with a brief color crossfade instead of a hard swap. Color-only CSS
    transitions keep the page fully live — no view-transition snapshot, so
    scrolling, input and the WebGL scenes never stall while the theme flips */
export function toggleThemeSmooth() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    toggleTheme()
    return
  }
  const root = document.documentElement
  root.classList.add('theme-fade')
  void root.offsetWidth // arm the transitions before the colors flip
  toggleTheme()
  clearTimeout(fadeTimer)
  fadeTimer = setTimeout(() => root.classList.remove('theme-fade'), THEME_FADE_MS + 50)
}

/** circular wipe from the toggle position. The wipe rides the View Transitions
    API, but only the OUTGOING frame is a static snapshot — the incoming view is
    the live page, and nothing pauses the WebGL scenes, so everything keeps
    moving while the circle sweeps. Phones skip it (the full-page snapshot +
    composite stutters there) and get the color crossfade instead. */
export function toggleThemeFrom(x: number, y: number) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    toggleTheme()
    return
  }
  if (!document.startViewTransition || isCoarsePointer()) {
    toggleThemeSmooth()
    return
  }
  if (wipeRunning) {
    toggleTheme()
    return
  }

  wipeRunning = true
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  const transition = document.startViewTransition(() => toggleTheme())
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 450,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      )
    })
    .catch(() => {})
  transition.finished
    .finally(() => {
      wipeRunning = false
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
