import { useEffect, useState } from 'react'
import {
  AppWindowIcon,
  BriefcaseIcon,
  DesktopTowerIcon,
  EnvelopeSimpleIcon,
  EyeIcon,
  PersonSimpleWalkIcon,
  WaveformIcon,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { ActivityKind } from './peekoFeed'

/*
  peeko's two colour tables and its clock, apart from the components that draw
  with them so that file can stay all components (which is what keeps fast
  refresh working on it).

  Colour here is never the only carrier of anything. Each activity kind gets a
  hue *and* an icon *and* a word, and the per-visitor accent is a stripe beside
  a V-number that says the same thing; strip the colour out and every row still
  reads. That is the rule the first version of this window kept by having no
  colour at all, which is also why it was unreadable: a hundred identical grey
  lines is not restraint, it is a log file.
*/

export const number = new Intl.NumberFormat()

export interface KindStyle {
  label: string
  icon: Icon
  /** the icon and the verb */
  text: string
  /** the icon's little tile */
  chip: string
  /** the dot or bar behind a row */
  bar: string
}

export const KIND_STYLES: Record<ActivityKind, KindStyle> = {
  visit: { label: 'Pages', icon: EyeIcon, text: 'text-blue-700', chip: 'bg-blue-600/12', bar: 'bg-blue-600/40' },
  project: { label: 'Projects', icon: BriefcaseIcon, text: 'text-violet-700', chip: 'bg-violet-600/12', bar: 'bg-violet-600/40' },
  os: { label: 'AlejOS', icon: DesktopTowerIcon, text: 'text-teal-700', chip: 'bg-teal-600/12', bar: 'bg-teal-600/40' },
  app: { label: 'Apps', icon: AppWindowIcon, text: 'text-amber-700', chip: 'bg-amber-600/12', bar: 'bg-amber-600/40' },
  world: { label: 'World', icon: PersonSimpleWalkIcon, text: 'text-emerald-700', chip: 'bg-emerald-600/12', bar: 'bg-emerald-600/40' },
  contact: { label: 'Contact', icon: EnvelopeSimpleIcon, text: 'text-rose-700', chip: 'bg-rose-600/12', bar: 'bg-rose-600/40' },
  signal: { label: 'Signals', icon: WaveformIcon, text: 'text-stone-600', chip: 'bg-stone-500/12', bar: 'bg-stone-500/40' },
}

/*
  Per-visitor accents, handed out in arrival order, so one person keeps one
  colour for as long as they are on screen and two rows a page apart can be
  told apart without reading the id.
*/
const VISITOR_COLORS = [
  { dot: 'bg-blue-600', chip: 'bg-blue-600/12 text-blue-800' },
  { dot: 'bg-violet-600', chip: 'bg-violet-600/12 text-violet-800' },
  { dot: 'bg-emerald-600', chip: 'bg-emerald-600/12 text-emerald-800' },
  { dot: 'bg-amber-600', chip: 'bg-amber-600/12 text-amber-800' },
  { dot: 'bg-rose-600', chip: 'bg-rose-600/12 text-rose-800' },
  { dot: 'bg-cyan-700', chip: 'bg-cyan-700/12 text-cyan-800' },
] as const

export function visitorColor(slot: number) {
  return VISITOR_COLORS[slot % VISITOR_COLORS.length]
}

/**
 * A clock that only ticks while the window can be seen. Every age in the feed
 * is measured against it, and a dashboard behind another window has nothing to
 * age — this is a live view on a machine that is also running a 3D world.
 */
export function useTickingNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer = 0
    const start = () => {
      if (timer) return
      setNow(Date.now())
      timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    }
    const stop = () => {
      if (!timer) return
      window.clearInterval(timer)
      timer = 0
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs])
  return now
}
