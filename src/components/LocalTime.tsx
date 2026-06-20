import { useEffect, useState } from 'react'
import { MoonIcon, SunIcon } from '@phosphor-icons/react'
import { useI18n } from '../i18n'

// Costa Rica has no DST, so this is a stable UTC-6 the whole year.
const TZ = 'America/Costa_Rica'

function readClock(locale: string) {
  const now = new Date()
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  }).format(now)
  // pull the 0-23 hour in CR time to decide whether it's day or night there
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: TZ,
    }).formatToParts(now).find((part) => part.type === 'hour')?.value,
  )
  // sitting near the equator, daylight runs ~6am to 6pm year-round
  const isDay = hour >= 6 && hour < 18
  return { time, isDay }
}

/** A live read of Alejandro's local time, with a sun/moon that tells you if he's likely up. */
export function LocalTime({ className = '' }: { className?: string }) {
  const { language, t } = useI18n()
  const locale = language === 'es' ? 'es-CR' : 'en-US'
  // heartbeat: bump every 15s to re-render; the clock itself is derived below,
  // so a language switch reflects immediately instead of waiting for a tick
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  const { time, isDay } = readClock(locale)
  const Icon = isDay ? SunIcon : MoonIcon
  return (
    <span
      title={t.localTime}
      aria-label={`${time} — ${t.localTime}`}
      className={`inline-flex items-center gap-1 tabular-nums ${className}`}
    >
      {time}
      <Icon
        size={13}
        weight="fill"
        aria-hidden
        className={isDay ? 'text-amber-500' : 'text-stone-400 dark:text-stone-500'}
      />
    </span>
  )
}
