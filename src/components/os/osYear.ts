/*
  The year AlejOS pretends it is. The machine shipped in 2003, so that's the
  default; the taskbar clock renders its date in this year and Internet
  Explorer time-travels to Wayback Machine snapshots from the same year.
  Same tiny external-store shape as wallpapers.ts: localStorage + subscribers,
  read with useSyncExternalStore.
*/

export const DEFAULT_OS_YEAR = 2003
/** the Wayback Machine's earliest crawls */
export const MIN_OS_YEAR = 1996
export const MAX_OS_YEAR = new Date().getFullYear()

const KEY = 'alejos-year'

function readStored(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    if (Number.isInteger(v) && v >= MIN_OS_YEAR && v <= MAX_OS_YEAR) return v
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_OS_YEAR
}

let current = readStored()
const subs = new Set<() => void>()

export function getOsYear(): number {
  return current
}

export function setOsYear(year: number) {
  const next = Math.min(MAX_OS_YEAR, Math.max(MIN_OS_YEAR, Math.round(year)))
  if (next === current || !Number.isFinite(next)) return
  current = next
  try {
    localStorage.setItem(KEY, String(next))
  } catch {
    /* storage unavailable */
  }
  subs.forEach((fn) => fn())
}

export function subscribeOsYear(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** the current moment transplanted into the pretend year */
export function osDate(now: Date = new Date()): Date {
  const d = new Date(now)
  d.setFullYear(current)
  return d
}
