/*
  Everything the OS's browser knows about YouTube that is not a React tree.
  The page itself is YoutubePage.tsx; this is the addresses, the search and the
  one embed url, kept React-free so the rules can be read in one place.

  It exists because of a single asymmetry. `youtube.com/watch` sets
  `x-frame-options` and will never load in an iframe, but
  `youtube-nocookie.com/embed` is *built* to be framed and loads fine, so a
  result is playable inside the OS's Internet Explorer even though the site
  around it is not. That makes YouTube the only site on the modern web that
  genuinely works in that window, which is why it gets its own rendering the
  way GitHub and LinkedIn already do.

  Three rules that bite.

  **The search has to come off our own VPS.** There is no way to search
  YouTube from a browser: the Data API wants a key that would ship in the
  bundle, and the old no-key `listType=search` embed trick has been dead for
  years (measured: it renders "This video is unavailable"). So
  `server/src/ytsearch.js` reads the results page and hands back a small JSON
  list. No `VITE_CHAT_URL` and there is no server, so `canSearchVideo` is
  false and the page degrades to "paste a link", which still plays.

  **The embed's frame attributes are load-bearing.** The generic web iframe in
  BrowserApp carries `sandbox` and `referrerPolicy="no-referrer"`, and a
  YouTube embed under those returns *Error 153, video player configuration
  error* rather than a picture. Measured, not assumed. The embed gets no
  sandbox and a strict-origin referrer, which is what YouTube's own oEmbed
  markup asks for.

  **A pasted link teaches us nothing about itself.** YouTube's oEmbed endpoint
  sends no CORS header, so a title cannot be fetched from a browser at all.
  `known` is filled in by whichever search surfaced a video and nothing else;
  the player prints its own title regardless.
*/

export interface YoutubeTarget {
  /** a video id to play */
  video?: string
  /** or a search to run */
  query?: string
}

export interface VideoResult {
  id: string
  title: string
  author: string
  length: string
  views: string
  thumb: string
}

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined

/**
 * Where the search lives.
 *
 * `wss://chat.example.com/ws` becomes `https://chat.example.com/yt/search`,
 * the same rewrite analytics does, so there is no second environment variable.
 * With no chat url at all the dev server answers for itself: vite.config.ts
 * mounts the VPS's own handler, so a clean checkout has a working search
 * without anybody having to stand a server up first.
 */
function searchBase(): string | null {
  if (!CHAT_URL) return import.meta.env.DEV ? '/yt/search' : null
  try {
    const url = new URL(CHAT_URL)
    url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'
    url.pathname = '/yt/search'
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

const SEARCH_URL = searchBase()

/**
 * Whether there is a search behind this build at all.
 *
 * Nothing *hides* on the strength of this, deliberately: a build with no server
 * still offers the search and answers with a page saying why it cannot run one.
 * The first cut gated the button on it, and on a checkout with no `.env` that
 * rendered as the feature simply not existing, which is indistinguishable from
 * it being broken.
 */
export const canSearchVideo = SEARCH_URL !== null

const ID_RE = /^[\w-]{11}$/

/**
 * Is this address one of ours to render? Covers everything a person actually
 * pastes: a watch link, a share link, a short, a live, an embed, and the
 * results page.
 */
export function youtubeTarget(raw: string): YoutubeTarget | null {
  if (raw.includes('web.archive.org')) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '')
  const segs = u.pathname.split('/').filter(Boolean)

  if (host === 'youtu.be') {
    return ID_RE.test(segs[0] ?? '') ? { video: segs[0] } : null
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null

  const v = u.searchParams.get('v')
  if (segs[0] === 'watch' && v && ID_RE.test(v)) return { video: v }
  if ((segs[0] === 'shorts' || segs[0] === 'embed' || segs[0] === 'live') && ID_RE.test(segs[1] ?? '')) {
    return { video: segs[1] }
  }
  if (segs[0] === 'results') {
    return { query: u.searchParams.get('search_query') ?? u.searchParams.get('q') ?? '' }
  }
  // the front page, a channel, anything else: there is no useful rendering of
  // it in here, so it opens the search rather than a broken page
  return { query: '' }
}

/** the address a video lives at, so history and the address bar stay honest */
export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

/** and the one a search does */
export function searchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
}

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

/** the player, and the parameters that keep it looking like 2003 owns it */
export function embedSrc(id: string): string {
  const params = new URLSearchParams({
    autoplay: '1',
    // muted autoplay is the only kind a browser promises; the unmute goes out
    // over postMessage the moment the player answers
    mute: '1',
    enablejsapi: '1',
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
    origin: ORIGIN,
  })
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`
}

/** what we know about an id, filled in by whichever search surfaced it */
export const known = new Map<string, VideoResult>()

/** and the results per query, kept for the session: a search costs the VPS */
export const searched = new Map<string, VideoResult[]>()

/*
  The last thing searched for, so that opening a result keeps the words in the
  box and offers the way back to the list.

  It is a module variable rather than a query parameter on the watch url on
  purpose: the address bar is the one part of this browser that has to stay
  literally true, and `youtube.com/watch?v=…&q=…` is not an address YouTube
  would ever have written.
*/
let recent = ''

export function rememberSearch(query: string): void {
  recent = query
}

export function recentSearch(): string {
  return recent
}

export async function runSearch(query: string): Promise<VideoResult[]> {
  const hit = searched.get(query)
  if (hit) return hit
  if (!SEARCH_URL) throw new Error('no server')
  const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(String(res.status))
  const data = (await res.json()) as { results?: VideoResult[] }
  const results = data.results ?? []
  searched.set(query, results)
  for (const r of results) known.set(r.id, r)
  return results
}
