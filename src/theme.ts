import { isCoarsePointer } from './device'

export type Theme = 'light' | 'dark'

/** duration of the toggle crossfade; .theme-fade in index.css must match */
export const THEME_FADE_MS = 200

const listeners = new Set<(t: Theme) => void>()
let fadeTimer: ReturnType<typeof setTimeout> | undefined
let wipeRunning = false

const THEME_COLORS: Record<Theme, string> = {
  light: '#faf8f0',
  dark: '#1d1913',
}

function updateThemeColor(theme: Theme) {
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[theme])
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  updateThemeColor(theme)
  localStorage.setItem('theme', theme)
  listeners.forEach((l) => l(theme))
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark')
}

/** toggle with a brief color crossfade instead of a hard swap. Color-only CSS
    transitions keep the page fully live — no view-transition snapshot, so
    scrolling, input and the WebGL scenes never stall while the theme flips.
    Skipped on coarse pointers: .theme-fade transitions every element, and that
    many concurrent repaints drops frames on phones — they snap instead */
export function toggleThemeSmooth() {
  if (isCoarsePointer() || matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
    moving while the circle sweeps. Phones get it too: the theme flips in a
    single recalc and the circle is a compositor-side clip-path, far cheaper
    than 200ms of whole-page color repaints. Coarse pointers run it slightly
    shorter to trim the window where the page composites through the
    transition. */
export function toggleThemeFrom(x: number, y: number) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    toggleTheme()
    return
  }
  if (!document.startViewTransition) {
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
          duration: isCoarsePointer() ? 400 : 450,
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
    updateThemeColor(t)
    listeners.forEach((l) => l(t))
  }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
