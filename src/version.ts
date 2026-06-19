import { NAVIGATE_EVENT } from './events'

/**
 * The portfolio ships more than one rendering of the same content. A first-visit
 * chooser (not a navbar toggle) picks one, so this can scale to many versions
 * over time. Precedence for the initial pick: ?v= query param -> stored -> none.
 *
 * To add a version: add an id here + a `versions.<id>` copy block (title/blurb/
 * tag) to both en/es in i18n.tsx, build its component, and branch it in App's
 * VersionRouter.
 */
export type PortfolioVersion = 'full' | 'simple'

export interface VersionMeta {
  id: PortfolioVersion
  /** hex accent for the chooser card (border/tag on hover) */
  accent: string
}

export const VERSIONS: VersionMeta[] = [
  { id: 'full', accent: '#2563eb' }, // blue-600, the interactive playground
  { id: 'simple', accent: '#0f766e' }, // teal-700, the quiet résumé
]

const STORAGE_KEY = 'portfolio-version'
const PROJECT_ROUTE = /^\/projects\/([a-z0-9-]+)\/?$/

export function isPortfolioVersion(value: unknown): value is PortfolioVersion {
  return value === 'full' || value === 'simple'
}

export function readStoredVersion(): PortfolioVersion | null {
  if (typeof localStorage === 'undefined') return null
  const stored = localStorage.getItem(STORAGE_KEY)
  return isPortfolioVersion(stored) ? stored : null
}

export function readQueryVersion(): PortfolioVersion | null {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('v')
  return isPortfolioVersion(value) ? value : null
}

/** ?v= wins (shareable deep link), then the remembered choice, else nothing */
export function readInitialVersion(): PortfolioVersion | null {
  return readQueryVersion() ?? readStoredVersion()
}

export function persistVersion(version: PortfolioVersion) {
  try {
    localStorage.setItem(STORAGE_KEY, version)
  } catch {
    /* private mode / storage disabled — choice just won't persist */
  }
}

/** drop a consumed ?v= param from the address bar without touching path or hash */
export function stripVersionParam() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('v')) return
  url.searchParams.delete('v')
  history.replaceState(null, '', url.pathname + url.search + url.hash)
}

/** the project slug for /projects/<slug>, or null for any other path */
export function matchProjectSlug(pathname: string = window.location.pathname): string | null {
  const match = pathname.match(PROJECT_ROUTE)
  return match ? match[1] : null
}

export function projectPath(slug: string) {
  return `/projects/${slug}`
}

export const HOME_PATH = '/'

/** client-side navigation for the simple version's real URLs */
export function navigate(to: string) {
  if (to === window.location.pathname) {
    window.scrollTo({ top: 0 })
    return
  }
  history.pushState(null, '', to)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}
