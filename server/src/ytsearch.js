// The one search that can actually work inside AlejOS's Internet Explorer.
//
// The browser in the OS is an iframe, and essentially the whole modern web
// refuses to be framed, google, bing and duckduckgo included, so a search
// box in there has always been a dead end that renders a polite refusal page.
// YouTube is the exception in one specific direction: youtube.com/watch
// refuses frames, but youtube-nocookie.com/embed does not, so a *result* is
// playable in the window even though the site around it is not. What was
// missing was the list of results, and there is no way to get one from a
// browser: the Data API wants a key that would ship in the bundle, and the
// no-key `listType=search` embed trick has been dead since around 2020
// (measured: it renders "This video is unavailable").
//
// So the VPS fetches the results page and reads them out of it. Three notes
// on the shape.
//
// **It scrapes `ytInitialData`, and that is a deliberate cost.** YouTube
// bakes the whole result set into a JSON blob in the HTML, which is stable
// enough to have outlived several redesigns but is nobody's contract. The
// parser therefore walks the tree looking for `videoRenderer` nodes anywhere
// rather than following a fixed path, so a new wrapper around the list costs
// nothing; and every failure mode ends as an empty result array with a 200,
// because the browser's fallback for "no results" and for "YouTube moved the
// furniture" is the same page.
//
// **The cache is the rate limiter that matters.** A search costs the VPS a
// 1.2 MB download, so identical queries are served from memory for half an
// hour. The per-IP limit underneath it is there for the pathological case,
// not the ordinary one.
//
// **It is filtered to videos only** (`sp=EgIQAQ%3D%3D`), because a channel or
// a playlist row has no video id to hand to the embed, and a result you
// cannot play is worse in here than one that never appeared.

const ENDPOINT = 'https://www.youtube.com/results';

/** how long an identical query is served from memory */
const CACHE_TTL_MS = 30 * 60_000;
/** and how many distinct queries are kept before the oldest is dropped */
const CACHE_MAX = 200;

/** per-IP budget: generous for a person, closed for a script */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;

/** how long to wait on YouTube before giving up on the whole search */
const FETCH_TIMEOUT_MS = 8_000;

/** the longest query worth forwarding; anything past this is not a song name */
const MAX_QUERY = 120;
/** how many results the browser is given */
const MAX_RESULTS = 18;

// A desktop UA and an explicit locale: without them the results page comes
// back in whatever language the datacentre looks like it is in, and the
// consent cookies keep a fresh IP off the interstitial that would otherwise
// replace the results with a wall.
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  cookie: 'CONSENT=YES+cb; SOCS=CAI',
};

/**
 * Pull the video rows out of a results page.
 *
 * Exported for the smoke test, which feeds it a hand-built payload: the parse
 * is the part that rots, and a test that needed the network would only ever
 * tell us whether the network was up.
 *
 * @param {string} html
 * @returns {Array<{id: string, title: string, author: string, length: string, views: string, thumb: string}>}
 */
export function parseResults(html) {
  const match = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const out = [];
  const seen = new Set();
  // Depth-first for `videoRenderer` anywhere in the tree. The list lives about
  // eight wrappers down and the wrappers change; the leaf does not.
  const walk = (node) => {
    if (!node || typeof node !== 'object' || out.length >= MAX_RESULTS) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const v = node.videoRenderer;
    if (v?.videoId) {
      if (!seen.has(v.videoId)) {
        seen.add(v.videoId);
        out.push({
          id: v.videoId,
          title: text(v.title) || 'Untitled',
          author: text(v.ownerText) || text(v.longBylineText) || '',
          // a live stream has no length, which is how the client knows to
          // label one rather than print an empty duration
          length: v.lengthText?.simpleText ?? '',
          views: v.shortViewCountText?.simpleText ?? '',
          // derived, not taken from the payload: the array is not sorted the
          // way it looks, and its first entry is the 176 kB hq720 frame, which
          // is 3 MB of downloads to fill a list of 96px-wide boxes. mqdefault
          // exists for every video and is 14 kB.
          thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        });
      }
      return;
    }
    for (const key in node) walk(node[key]);
  };
  walk(data);
  return out;
}

/** YouTube writes text as either a plain string or a list of styled runs */
function text(node) {
  if (!node) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text ?? '').join('');
  return '';
}

/**
 * Build the YouTube search route, or null when it is switched off.
 *
 * @param {object} [options]
 * @param {string[]} [options.allowedOrigins] origins allowed to search
 * @param {boolean} [options.enabled] false disables the route outright
 */
export function createYouTubeSearch(options = {}) {
  if (options.enabled === false) return null;

  const allowedOrigins = options.allowedOrigins ?? [];
  /** @type {Map<string, {at: number, results: unknown[]}>} */
  const cache = new Map();
  /** @type {Map<string, number[]>} */
  const rateByIp = new Map();

  function allow(ip) {
    const now = Date.now();
    const hits = (rateByIp.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    rateByIp.set(ip, hits);
    if (hits.length >= RATE_MAX) return false;
    hits.push(now);
    return true;
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, hits] of rateByIp) {
      if (hits.length === 0 || now - hits[hits.length - 1] >= RATE_WINDOW_MS) rateByIp.delete(ip);
    }
    for (const [q, entry] of cache) {
      if (now - entry.at > CACHE_TTL_MS) cache.delete(q);
    }
  }, RATE_WINDOW_MS);
  sweep.unref();

  function originAllowed(origin) {
    if (allowedOrigins.length === 0) return true;
    return !origin || allowedOrigins.includes(origin);
  }

  async function search(query) {
    const key = query.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

    const url = `${ENDPOINT}?search_query=${encodeURIComponent(query)}&hl=en&gl=US&sp=EgIQAQ%3D%3D`;
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`youtube ${res.status}`);
    const results = parseResults(await res.text());

    // an empty parse is not cached: it is as likely to be a consent wall or a
    // throttle as a genuinely empty search, and caching it would pin the
    // failure in place for half an hour
    if (results.length > 0) {
      cache.set(key, { at: Date.now(), results });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return results;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<boolean>} true when this route answered
   */
  async function handleHttp(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    if (url.pathname !== '/yt/search') return false;

    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden_origin' }));
      return true;
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' });
      res.end();
      return true;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method' }));
      return true;
    }

    const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY);
    if (!query) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'query' }));
      return true;
    }

    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!allow(ip)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate' }));
      return true;
    }

    try {
      const results = await search(query);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });
      res.end(JSON.stringify({ results }));
    } catch (err) {
      // the window in the OS has one fallback page for every kind of nothing,
      // so the distinction between "YouTube is down" and "YouTube changed" is
      // not worth spending a status code on
      console.warn('yt-search:', err?.message ?? err);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream', results: [] }));
    }
    return true;
  }

  return { handleHttp };
}
