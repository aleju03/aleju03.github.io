import { NAVIGATE_EVENT } from './events'

/**
 * The portfolio ships more than one rendering of the same content. The full
 * site is the default landing, so first visits (and anything that reads the
 * page, like crawlers) go straight to content; a dismissible nudge offers the
 * short version until a choice is made, and the full-screen chooser switches
 * versions any time from the footer or command palette. Precedence for the
 * initial pick: ?v= query param -> stored choice -> the full-site default.
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

const NUDGE_KEY = 'portfolio-nudge'

/** whether the first-visit résumé nudge was waved away on an earlier visit */
export function readNudgeDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(NUDGE_KEY) === 'dismissed'
}

export function persistNudgeDismissed() {
  try {
    localStorage.setItem(NUDGE_KEY, 'dismissed')
  } catch {
    /* private mode / storage disabled — the nudge will just show again */
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

/**
 * AlejOS owns the address bar while it runs, and it has three entrances,
 * ordered here by how much they cost to load:
 *
 * - `/pc` — the machine on its own. The desktop in its flat bezel, with no
 *   CrtScene, no game runtime and no portfolio page mounted behind it, so
 *   nothing three.js-shaped ever loads.
 * - `/alejOS` — the full session: POST, boot, login, the desktop on a CRT
 *   inside the 3D room. **The room and nothing past it**: the house, its
 *   furniture and the sky out of its windows, but not the procedural planet
 *   the front door opens onto. Stand up and walk the house for free; open the
 *   front door and the world streams in behind a cover, once.
 * - `/world` — the far end: everything loaded up front, the machine already
 *   dark, and you start on your feet ready to walk out.
 *
 * That split is the point. Most visitors come for the desktop, and making them
 * wait on an endless planet they may never look at was several seconds of
 * chunk building and outdoor shader compilation charged to a boot that did not
 * need it. `/pc` and `/world` are the two ends; `/alejOS` is the middle that
 * pays for the planet only if you ask for it.
 *
 * Small/touch/reduced-motion devices land in the flat rendering from any of
 * them — there is no room to walk without the 3D — so `/world` degrades to the
 * ordinary boot.
 */
export const OS_PATH = '/alejOS'
export const PC_PATH = '/pc'
export const WORLD_PATH = '/world'
/** the old name for WORLD_PATH; still honoured so shared links keep working */
export const LEGACY_WORLD_PATH = '/room'

/** true on any AlejOS entrance */
export function isOsPath(pathname: string = window.location.pathname): boolean {
  const path = pathname.toLowerCase()
  return (
    path === OS_PATH.toLowerCase() ||
    path === PC_PATH ||
    path === WORLD_PATH ||
    path === LEGACY_WORLD_PATH
  )
}

/** true only on the flat entrance */
export function isPcPath(pathname: string = window.location.pathname): boolean {
  return pathname.toLowerCase() === PC_PATH
}

/** true only on the walk-the-world entrance (or its old /room spelling) */
export function isWorldPath(pathname: string = window.location.pathname): boolean {
  const path = pathname.toLowerCase()
  return path === WORLD_PATH || path === LEGACY_WORLD_PATH
}

/** client-side navigation for the simple version's real URLs */
export function navigate(to: string) {
  if (to === window.location.pathname) {
    window.scrollTo({ top: 0 })
    return
  }
  history.pushState(null, '', to)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}
