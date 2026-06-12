import { useEffect, useMemo, useState } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ClockCounterClockwiseIcon,
  GlobeIcon,
  HouseIcon,
} from '@phosphor-icons/react'
import { showcase, github } from '../../data/projects'
import { sounds } from './sounds'

/*
  Internet Explorer, AlejOS edition. Address bar plus back/forward/home, a
  retro portal home page (aleju://home) with the live projects as tiles, and
  an iframe for the actual web. Plenty of 2026 sites refuse to be framed, so
  the toolbar offers two outs: open in a real tab, or "time travel" — load
  the page through the Wayback Machine circa 2003, which embeds happily and
  matches the period furniture.
*/

const HOME = 'aleju://home'

interface Bookmark {
  label: string
  url: string
  blurb: string
}

const projectBookmarks: Bookmark[] = showcase
  .filter((p) => p.live)
  .map((p) => ({
    label: p.liveLabel ?? p.name,
    url: p.live as string,
    blurb: p.description.split('. ')[0],
  }))

const webBookmarks: Bookmark[] = [
  {
    label: 'Google (2001)',
    url: 'https://web.archive.org/web/2001/https://www.google.com/',
    blurb: 'the web, before the web got heavy',
  },
  {
    label: 'Space Jam (1996)',
    url: 'https://web.archive.org/web/1996/http://www.spacejam.com/',
    blurb: 'still the greatest website ever shipped',
  },
  {
    label: 'GeoCities vibes',
    url: 'https://web.archive.org/web/1999/http://www.geocities.com/',
    blurb: 'under construction, forever',
  },
]

function normalize(raw: string): string {
  const t = raw.trim()
  if (!t) return HOME
  if (t === HOME || t.startsWith('aleju://')) return HOME
  if (/^https?:\/\//i.test(t)) return t
  if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`
  // not a url: pretend we are a search engine and ask the wayback machine
  return `https://web.archive.org/web/2003/https://www.google.com/search?q=${encodeURIComponent(t)}`
}

function timeTravel(url: string): string {
  if (url.includes('web.archive.org')) return url
  return `https://web.archive.org/web/2003/${url}`
}

// what the address bar admits to: time travel happens through the Wayback
// Machine, but showing its scaffolding would break the spell, so the bar
// keeps displaying the destination url
const WAYBACK_RE = /^https?:\/\/web\.archive\.org\/web\/[^/]+\/(.+)$/
function displayUrl(url: string): string {
  const m = url.match(WAYBACK_RE)
  return m ? m[1] : url
}

interface BrowserProps {
  url?: string
  setTitle: (t: string) => void
}

export function BrowserApp({ url: initialUrl, setTitle }: BrowserProps) {
  const [url, setUrl] = useState(() => (initialUrl ? normalize(initialUrl) : HOME))
  const [address, setAddress] = useState(() => displayUrl(url))
  const [loading, setLoading] = useState(() => url !== HOME)
  const [back, setBack] = useState<string[]>([])
  const [fwd, setFwd] = useState<string[]>([])
  // remount the iframe on reload even when the url is unchanged
  const [frameKey, setFrameKey] = useState(0)

  const host = useMemo(() => {
    if (url === HOME) return 'home'
    try {
      return new URL(displayUrl(url)).host
    } catch {
      return displayUrl(url)
    }
  }, [url])

  useEffect(() => {
    setTitle(`${host} - Internet Explorer`)
  }, [host, setTitle])

  // safety valve: blocked frames never fire onLoad, so the bar stops anyway
  useEffect(() => {
    if (!loading) return
    const id = setTimeout(() => setLoading(false), 4000)
    return () => clearTimeout(id)
  }, [loading, url, frameKey])

  const go = (raw: string, fromHistory = false) => {
    const next = normalize(raw)
    if (next === url) {
      setFrameKey((k) => k + 1)
      setLoading(next !== HOME)
      return
    }
    if (!fromHistory) {
      setBack((prev) => [...prev, url])
      setFwd([])
    }
    setUrl(next)
    setAddress(displayUrl(next))
    setLoading(next !== HOME)
  }

  const goBack = () => {
    const to = back[back.length - 1]
    if (to === undefined) return
    setBack((prev) => prev.slice(0, -1))
    setFwd((prev) => [...prev, url])
    go(to, true)
  }

  const goForward = () => {
    const to = fwd[fwd.length - 1]
    if (to === undefined) return
    setFwd((prev) => prev.slice(0, -1))
    setBack((prev) => [...prev, url])
    go(to, true)
  }

  const toolBtn =
    'flex size-7 cursor-pointer items-center justify-center rounded-sm text-stone-600 transition-colors hover:bg-stone-300/70 disabled:cursor-default disabled:text-stone-400 disabled:hover:bg-transparent'

  return (
    <div className="flex h-full flex-col bg-white">
      {/* toolbar */}
      <div className="flex items-center gap-1 border-b border-stone-300 bg-stone-200 px-2 py-1.5">
        <button type="button" aria-label="Back" className={toolBtn} disabled={back.length === 0} onClick={goBack}>
          <ArrowLeftIcon size={15} weight="bold" />
        </button>
        <button type="button" aria-label="Forward" className={toolBtn} disabled={fwd.length === 0} onClick={goForward}>
          <ArrowRightIcon size={15} weight="bold" />
        </button>
        <button
          type="button"
          aria-label="Reload"
          className={toolBtn}
          onClick={() => {
            sounds.click()
            setFrameKey((k) => k + 1)
            setLoading(url !== HOME)
          }}
        >
          <ArrowClockwiseIcon size={15} weight="bold" />
        </button>
        <button
          type="button"
          aria-label="Home"
          className={toolBtn}
          onClick={() => {
            sounds.click()
            go(HOME)
          }}
        >
          <HouseIcon size={15} weight="bold" />
        </button>
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            sounds.click()
            go(address)
          }}
        >
          <span className="ml-1 text-blue-700">
            <GlobeIcon size={14} weight="duotone" />
          </span>
          <input
            value={address}
            data-no-focus-ring
            spellCheck={false}
            aria-label="Address"
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-sm border border-stone-400 bg-white px-2 py-1 font-mono text-xs text-stone-700 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
          />
          <button
            type="submit"
            className="cursor-pointer rounded-sm border border-stone-400 bg-stone-100 px-2.5 py-1 text-xs text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
          >
            Go
          </button>
        </form>
        {url !== HOME && (
          <>
            <button
              type="button"
              aria-label="Time travel via the Wayback Machine"
              title="Load this page as it looked circa 2003"
              className={toolBtn}
              disabled={url.includes('web.archive.org')}
              onClick={() => {
                sounds.open()
                go(timeTravel(url))
              }}
            >
              <ClockCounterClockwiseIcon size={15} weight="bold" />
            </button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in a new tab"
              title="Open in a new tab"
              className={toolBtn}
            >
              <ArrowSquareOutIcon size={15} weight="bold" />
            </a>
          </>
        )}
      </div>

      {/* page */}
      <div className="relative min-h-0 flex-1">
        {url === HOME ? (
          <div className="h-full overflow-y-auto bg-gradient-to-b from-blue-50 to-stone-50 p-5">
            <div className="mx-auto max-w-xl">
              <p className="font-display text-3xl font-semibold text-stone-800">
                Alej<span className="text-blue-600">Net</span>
              </p>
              <p className="mt-0.5 text-xs text-stone-500">your portal to the information superhighway</p>

              <form
                className="mt-4 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const q = String(new FormData(e.currentTarget).get('q') ?? '')
                  if (q.trim()) {
                    sounds.click()
                    go(q)
                  }
                }}
              >
                <input
                  name="q"
                  data-no-focus-ring
                  placeholder="Search the web (of 2003)"
                  aria-label="Search"
                  className="min-w-0 flex-1 rounded-sm border border-stone-400 bg-white px-3 py-1.5 text-sm text-stone-700 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
                />
                <button
                  type="submit"
                  className="cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-4 py-1.5 text-xs font-medium text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
                >
                  Search
                </button>
              </form>

              <p className="mt-6 mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
                Sites by this machine's owner
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {projectBookmarks.map((b) => (
                  <button
                    key={b.url}
                    type="button"
                    onClick={() => {
                      sounds.open()
                      go(b.url)
                    }}
                    className="cursor-pointer rounded-md border border-stone-300 bg-white p-3 text-left shadow-sm transition hover:border-blue-600 hover:shadow"
                  >
                    <p className="text-sm font-medium text-blue-700 underline decoration-dotted underline-offset-2">
                      {b.label}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-stone-500">{b.blurb}</p>
                  </button>
                ))}
                <a
                  href={github}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-stone-300 bg-white p-3 text-left shadow-sm transition hover:border-blue-600 hover:shadow"
                >
                  <p className="flex items-center gap-1 text-sm font-medium text-blue-700 underline decoration-dotted underline-offset-2">
                    github.com/aleju03 <ArrowSquareOutIcon size={12} />
                  </p>
                  <p className="mt-0.5 text-xs text-stone-500">
                    the source of everything here (GitHub refuses frames, opens in a tab)
                  </p>
                </a>
              </div>

              <p className="mt-6 mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
                Elsewhere on the early web
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {webBookmarks.map((b) => (
                  <button
                    key={b.url}
                    type="button"
                    onClick={() => {
                      sounds.open()
                      go(b.url)
                    }}
                    className="cursor-pointer rounded-md border border-stone-300 bg-white p-3 text-left shadow-sm transition hover:border-blue-600 hover:shadow"
                  >
                    <p className="text-sm font-medium text-blue-700 underline decoration-dotted underline-offset-2">
                      {b.label}
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">{b.blurb}</p>
                  </button>
                ))}
              </div>

              <p className="mt-8 text-center text-[11px] text-stone-400">
                Best viewed at 1024×768 · © {new Date().getFullYear()} AlejNet
              </p>
            </div>
          </div>
        ) : (
          <>
            <iframe
              key={frameKey}
              src={url}
              title={host}
              onLoad={() => setLoading(false)}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0 bg-white"
            />
            {loading && (
              <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-blue-100">
                <div className="h-full w-1/3 animate-[os-ie-load_1s_linear_infinite] bg-blue-600" />
              </div>
            )}
          </>
        )}
      </div>

      {/* status bar */}
      <div className="flex items-center gap-2 border-t border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-500">
        <span className="truncate">
          {loading ? `Opening ${host}…` : url === HOME ? 'Done' : `${host} (blank page? the site refuses frames; try ↗ or time travel)`}
        </span>
        <span className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
          <GlobeIcon size={12} /> Internet zone
        </span>
      </div>
    </div>
  )
}
