import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ClockCounterClockwiseIcon,
  GlobeIcon,
  HouseIcon,
  LinkedinLogoIcon,
  MapPinIcon,
  StarIcon,
} from '@phosphor-icons/react'
import { showcase, github, linkedin } from '../../data/projects'
import { sounds } from './sounds'
import { getOsYear, subscribeOsYear } from './osYear'

/*
  Internet Explorer, AlejOS edition. Address bar plus back/forward/home, a
  retro portal home page (aleju://home) with the live projects as tiles, and
  an iframe for the actual web. Plenty of 2026 sites refuse to be framed, so
  the toolbar offers two outs: open in a real tab, or "time travel" — load
  the page through the Wayback Machine at whatever year the taskbar clock is
  set to (2003 by default), which embeds happily and matches the period
  furniture. GitHub and LinkedIn refuse frames outright,
  so the browser renders its own period-correct pages for them instead;
  the GitHub ones pull live data from the public API.
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
]

function normalize(raw: string): string {
  const t = raw.trim()
  if (!t) return HOME
  if (t === HOME || t.startsWith('aleju://')) return HOME
  if (/^https?:\/\//i.test(t)) return t
  if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`
  // not a url: pretend we are a search engine and ask the wayback machine
  return `https://web.archive.org/web/${getOsYear()}/https://www.google.com/search?q=${encodeURIComponent(t)}`
}

function timeTravel(url: string): string {
  if (url.includes('web.archive.org')) return url
  return `https://web.archive.org/web/${getOsYear()}/${url}`
}

// what the address bar admits to: time travel happens through the Wayback
// Machine, but showing its scaffolding would break the spell, so the bar
// keeps displaying the destination url
const WAYBACK_RE = /^https?:\/\/web\.archive\.org\/web\/[^/]+\/(.+)$/
function displayUrl(url: string): string {
  const m = url.match(WAYBACK_RE)
  return m ? m[1] : url
}

// ------------------------------------------------- in-house github & linkedin

type InternalPage =
  | { type: 'github'; user: string; repo?: string }
  | { type: 'linkedin' }

/** pages we render ourselves because the real site refuses to be framed */
function internalPage(url: string): InternalPage | null {
  if (url.includes('web.archive.org')) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '')
  const segs = u.pathname.split('/').filter(Boolean)
  if (host === 'github.com' && segs.length >= 1) {
    return { type: 'github', user: segs[0], repo: segs[1] }
  }
  if (host === 'linkedin.com') return { type: 'linkedin' }
  return null
}

interface GhUser {
  login: string
  name: string | null
  avatar_url: string
  bio: string | null
  location: string | null
  public_repos: number
  followers: number
}

interface GhRepo {
  name: string
  description: string | null
  stargazers_count: number
  language: string | null
  fork: boolean
}

// one fetch per url per session; the api allows 60 requests an hour
const ghCache = new Map<string, unknown>()

async function ghFetch<T>(path: string): Promise<T> {
  if (ghCache.has(path)) return ghCache.get(path) as T
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(String(res.status))
  const data = (await res.json()) as T
  ghCache.set(path, data)
  return data
}

const retroCard = 'rounded-md border border-stone-300 bg-white p-3 shadow-sm'

function GithubPage({ user, repo, go }: { user: string; repo?: string; go: (url: string) => void }) {
  const [profile, setProfile] = useState<GhUser | null>(null)
  const [repos, setRepos] = useState<GhRepo[] | null>(null)
  const [one, setOne] = useState<GhRepo | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    if (repo) {
      ghFetch<GhRepo>(`/repos/${user}/${repo}`)
        .then((r) => alive && setOne(r))
        .catch(() => alive && setFailed(true))
    } else {
      Promise.all([
        ghFetch<GhUser>(`/users/${user}`),
        ghFetch<GhRepo[]>(`/users/${user}/repos?sort=updated&per_page=12`),
      ])
        .then(([u, rs]) => {
          if (!alive) return
          setProfile(u)
          setRepos(rs)
        })
        .catch(() => alive && setFailed(true))
    }
    return () => {
      alive = false
    }
  }, [user, repo])

  const outUrl = repo ? `https://github.com/${user}/${repo}` : `https://github.com/${user}`

  return (
    <div className="h-full overflow-y-auto bg-stone-50">
      <div className="border-b border-stone-300 bg-stone-800 px-5 py-3">
        <p className="font-display text-xl font-semibold text-white">
          git<span className="text-stone-400">hub</span>
          <span className="ml-2 text-xs font-normal text-stone-400">the place where the code lives</span>
        </p>
      </div>
      <div className="mx-auto max-w-xl p-5">
        {failed && (
          <div className={retroCard}>
            <p className="text-sm text-stone-700">
              GitHub is not answering right now, probably too many curious visitors this hour.
            </p>
            <a href={outUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-700 underline decoration-dotted underline-offset-2">
              Open {displayUrl(outUrl)} in a new tab <ArrowSquareOutIcon size={12} />
            </a>
          </div>
        )}

        {!failed && repo && !one && <p className="text-xs text-stone-500">Dialing up github.com…</p>}
        {!failed && repo && one && (
          <div className={retroCard}>
            <button
              type="button"
              onClick={() => go(`https://github.com/${user}`)}
              className="cursor-pointer text-xs text-blue-700 underline decoration-dotted underline-offset-2"
            >
              {user}
            </button>
            <span className="text-xs text-stone-400"> / </span>
            <span className="text-sm font-semibold text-stone-800">{one.name}</span>
            <p className="mt-1.5 text-sm text-stone-600">{one.description ?? 'No description, the code speaks for itself.'}</p>
            <p className="mt-2 flex items-center gap-3 text-xs text-stone-500">
              {one.language && <span>{one.language}</span>}
              <span className="flex items-center gap-1">
                <StarIcon size={12} /> {one.stargazers_count}
              </span>
            </p>
            <a href={outUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-blue-700 underline decoration-dotted underline-offset-2">
              Browse the full repository in a new tab <ArrowSquareOutIcon size={12} />
            </a>
          </div>
        )}

        {!failed && !repo && !profile && <p className="text-xs text-stone-500">Dialing up github.com…</p>}
        {!failed && !repo && profile && (
          <>
            <div className={`${retroCard} flex items-center gap-4`}>
              <img
                src={profile.avatar_url}
                alt=""
                width={64}
                height={64}
                className="size-16 rounded-md border border-stone-300"
              />
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-stone-800">{profile.name ?? profile.login}</p>
                <p className="text-xs text-stone-500">@{profile.login}</p>
                {profile.bio && <p className="mt-1 text-xs text-stone-600">{profile.bio}</p>}
                <p className="mt-1 flex items-center gap-3 text-xs text-stone-500">
                  <span>{profile.public_repos} repositories</span>
                  <span>{profile.followers} followers</span>
                  {profile.location && (
                    <span className="flex items-center gap-0.5">
                      <MapPinIcon size={11} /> {profile.location}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <p className="mt-4 mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">Repositories</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(repos ?? [])
                .filter((r) => !r.fork)
                .map((r) => (
                  <button
                    key={r.name}
                    type="button"
                    onClick={() => {
                      sounds.open()
                      go(`https://github.com/${user}/${r.name}`)
                    }}
                    className={`${retroCard} cursor-pointer text-left transition hover:border-blue-600 hover:shadow`}
                  >
                    <p className="flex items-center gap-1.5 text-sm font-medium text-blue-700 underline decoration-dotted underline-offset-2">
                      {r.name}
                      <span className="ml-auto flex items-center gap-0.5 text-[10px] text-stone-400 no-underline">
                        <StarIcon size={10} /> {r.stargazers_count}
                      </span>
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-stone-500">
                      {r.description ?? r.language ?? 'No description yet.'}
                    </p>
                  </button>
                ))}
            </div>
            <a href={outUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-xs text-blue-700 underline decoration-dotted underline-offset-2">
              Visit the real profile in a new tab <ArrowSquareOutIcon size={12} />
            </a>
          </>
        )}
      </div>
    </div>
  )
}

function LinkedinPage() {
  return (
    <div className="h-full overflow-y-auto bg-stone-50">
      <div className="border-b border-stone-300 bg-[#0a66c2] px-5 py-3">
        <p className="flex items-center gap-1.5 font-display text-xl font-semibold text-white">
          Linked<span className="rounded-sm bg-white px-1 text-[#0a66c2]">in</span>
          <span className="ml-2 text-xs font-normal text-blue-100">the office floor of the internet</span>
        </p>
      </div>
      <div className="mx-auto max-w-xl p-5">
        <div className={retroCard}>
          <div className="h-14 rounded-t-sm bg-gradient-to-r from-blue-200 to-blue-100" />
          <div className="px-2 pb-1">
            <div className="-mt-7 flex size-14 items-center justify-center rounded-full border-2 border-white bg-blue-700 text-lg font-semibold text-white">
              AJ
            </div>
            <p className="mt-2 text-base font-semibold text-stone-800">Alejandro Jiménez</p>
            <p className="text-sm text-stone-600">Full-stack developer</p>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-stone-500">
              <MapPinIcon size={11} /> Costa Rica
            </p>
            <p className="mt-3 text-xs text-stone-600">
              React frontends, Node backends, and the server they run on. The rest of this machine is the
              portfolio, so the interesting part is one window away.
            </p>
            <a
              href={linkedin}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[#0a66c2] px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-800"
            >
              <LinkedinLogoIcon size={14} /> View the full profile in a new tab
            </a>
            <p className="mt-2 text-[10px] text-stone-400">
              LinkedIn wants a sign-in before it shows anything in here, so this is the lobby version.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

interface BrowserProps {
  url?: string
  setTitle: (t: string) => void
}

export function BrowserApp({ url: initialUrl, setTitle }: BrowserProps) {
  const [url, setUrl] = useState(() => (initialUrl ? normalize(initialUrl) : HOME))
  const [address, setAddress] = useState(() => displayUrl(url))
  const [loading, setLoading] = useState(() => url !== HOME && !internalPage(url))
  const [back, setBack] = useState<string[]>([])
  const [fwd, setFwd] = useState<string[]>([])
  // remount the iframe on reload even when the url is unchanged
  const [frameKey, setFrameKey] = useState(0)
  const year = useSyncExternalStore(subscribeOsYear, getOsYear)

  // the taskbar clock changed the year: pages already viewed through the
  // Wayback Machine jump to the new destination in time
  useEffect(
    () =>
      subscribeOsYear(() => {
        setUrl((u) => u.replace(/(\/\/web\.archive\.org\/web\/)\d+\//, `$1${getOsYear()}/`))
      }),
    [],
  )

  const host = useMemo(() => {
    if (url === HOME) return 'home'
    try {
      return new URL(displayUrl(url)).host
    } catch {
      return displayUrl(url)
    }
  }, [url])

  const internal = useMemo(() => (url === HOME ? null : internalPage(url)), [url])

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
    const framed = next !== HOME && !internalPage(next)
    if (next === url) {
      setFrameKey((k) => k + 1)
      setLoading(framed)
      return
    }
    if (!fromHistory) {
      setBack((prev) => [...prev, url])
      setFwd([])
    }
    setUrl(next)
    setAddress(displayUrl(next))
    setLoading(framed)
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
            setLoading(url !== HOME && !internal)
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
              title={`Load this page as it looked circa ${year}`}
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
                  placeholder={`Search the web (of ${year})`}
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
                <button
                  type="button"
                  onClick={() => {
                    sounds.open()
                    go(github)
                  }}
                  className="cursor-pointer rounded-md border border-stone-300 bg-white p-3 text-left shadow-sm transition hover:border-blue-600 hover:shadow"
                >
                  <p className="text-sm font-medium text-blue-700 underline decoration-dotted underline-offset-2">
                    github.com/aleju03
                  </p>
                  <p className="mt-0.5 text-xs text-stone-500">the source of everything here</p>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    sounds.open()
                    go(linkedin)
                  }}
                  className="cursor-pointer rounded-md border border-stone-300 bg-white p-3 text-left shadow-sm transition hover:border-blue-600 hover:shadow"
                >
                  <p className="text-sm font-medium text-blue-700 underline decoration-dotted underline-offset-2">
                    linkedin.com/in/alejandro
                  </p>
                  <p className="mt-0.5 text-xs text-stone-500">the version with a collared shirt</p>
                </button>
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
        ) : internal ? (
          <div key={frameKey} className="h-full">
            {internal.type === 'github' ? (
              <GithubPage
                key={`${internal.user}/${internal.repo ?? ''}`}
                user={internal.user}
                repo={internal.repo}
                go={go}
              />
            ) : (
              <LinkedinPage />
            )}
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
          {loading
            ? `Opening ${host}…`
            : url === HOME || internal
              ? 'Done'
              : `${host} (blank page? the site refuses frames; try ↗ or time travel)`}
        </span>
        <span className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
          <GlobeIcon size={12} /> Internet zone
        </span>
      </div>
    </div>
  )
}
