// Site analytics, powered by peeko (github.com/aleju03/peeko).
//
// The portfolio is a static bundle on GitHub Pages, so it has nowhere to
// count its own traffic; this process is the only always-on piece, so the
// counting lands here next to the chat. Storage is deliberately NOT chat.db:
// analytics rows are high-volume and individually worthless, and they would
// bloat the file the chat serves reads from. They go to their own Turso
// database instead, over libsql.
//
// Two halves, with very different trust levels:
//
//   - capture is public. Browsers POST here cross-origin from the portfolio,
//     so it can carry no token (a token shipped to a browser is not a token).
//     It is origin-checked, per-IP rate limited, and that is the whole of its
//     authority: it can only ever append events.
//   - reads are admin-only and never touch HTTP. peeko's /monitor route is
//     token-gated, but the browser that wants it is already holding an
//     authenticated admin WebSocket, so index.js queries the store directly
//     over that socket instead. No second auth surface, no dashboard token in
//     client JavaScript, no CORS.
//
// Unset ANALYTICS_URL and the whole module folds to null and the server runs
// exactly as it did before — same graceful-degradation deal the frontend
// makes when VITE_CHAT_URL is missing.

import { AnalyticsStore, createAnalyticsHandler, createDb } from '@aleju03/peeko';

const CAPTURE_PATH = '/peeko/capture';
const CAPTURE_RATE_MAX = 120; // capture requests per window per ip (each may be a batch)
const CAPTURE_RATE_WINDOW_MS = 60_000;
const RATE_SWEEP_MS = 5 * 60_000;

// Whatever edge ends up in front of this (Cloudflare, Vercel, a Caddy with a
// geo module) names the country header differently, and none of them are set
// when it is just Caddy. First one present wins; absent means country stays
// null and the dashboard shows "unknown".
const COUNTRY_HEADERS = [
  'cf-ipcountry',
  'x-vercel-ip-country',
  'x-geo-country',
  'x-country-code',
];

// Deliberately crude. peeko refuses to ship bot detection because a real
// verdict needs a maintained list; this only has to keep the obvious crawlers
// out of the aggregates, and everything it flags is still stored (isBot is a
// column, not a drop).
const BOT_RE = /bot|crawler|spider|crawling|slurp|facebookexternalhit|headless|preview|monitor|curl|wget|python-requests|axios|scrapy|lighthouse|pingdom|semrush|ahrefs/i;

function countryFor(req) {
  for (const header of COUNTRY_HEADERS) {
    const value = req.headers[header];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return typeof forwarded === 'string' && forwarded.length > 0
    ? forwarded.split(',')[0].trim()
    : req.socket.remoteAddress ?? 'unknown';
}

/**
 * Build the analytics half of the server, or null when it is not configured.
 *
 * @param {object} options
 * @param {string} [options.url] libsql/Turso URL for the analytics database
 * @param {string} [options.authToken] Turso auth token
 * @param {number} [options.retentionDays]
 * @param {string[]} [options.siteHosts] hosts that count as real site traffic
 * @param {string} [options.excludeViewer] username whose visits stay out of the feed
 * @param {string[]} [options.allowedOrigins] origins allowed to POST captures
 * @param {string} [options.timeZone] IANA zone for feed timestamp labels
 */
export async function createAnalytics(options) {
  if (!options.url) return null;

  const db = await createDb({ url: options.url, authToken: options.authToken });
  const store = new AnalyticsStore(db, {
    retentionDays: options.retentionDays ?? 180,
    feedHosts: options.siteHosts?.length ? options.siteHosts : null,
    // my own visits are the ones I make while testing; they are noise
    feedExcludeViewer: options.excludeViewer ?? null,
    // "/" is the portfolio's front page, not landing-page noise — peeko drops
    // it by default, which for this site would hide most of the traffic
    feedExcludeRootPageview: false,
    displayTimeZone: options.timeZone ?? 'UTC',
    onDrop: (count) => console.warn(`analytics: dropped ${count} buffered events`),
  });

  await store.ensureSchema();
  store.start();

  // peeko's own handler, used for exactly one route. Mounting it wholesale
  // would expose /monitor and /live-ticket unauthenticated, since a single
  // captureToken gates all of them and capture cannot have one — so the
  // router below hands it the capture path and nothing else.
  const captureHandler = createAnalyticsHandler({
    store,
    captureToken: undefined,
    enrich: (req) => ({
      geoCountry: countryFor(req),
      isBot: BOT_RE.test(req.headers['user-agent'] ?? ''),
    }),
  });

  const allowedOrigins = options.allowedOrigins ?? [];
  const rateByIp = new Map(); // ip -> [timestamps]

  function allowCapture(ip) {
    const now = Date.now();
    const hits = (rateByIp.get(ip) ?? []).filter((t) => now - t < CAPTURE_RATE_WINDOW_MS);
    rateByIp.set(ip, hits);
    if (hits.length >= CAPTURE_RATE_MAX) return false;
    hits.push(now);
    return true;
  }

  const rateSweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, hits] of rateByIp) {
      if (hits.length === 0 || now - hits[hits.length - 1] >= CAPTURE_RATE_WINDOW_MS) {
        rateByIp.delete(ip);
      }
    }
  }, RATE_SWEEP_MS);
  rateSweep.unref();

  function originAllowed(origin) {
    if (allowedOrigins.length === 0) return true;
    return !origin || allowedOrigins.includes(origin);
  }

  // The browser sends application/json, which is never a CORS-simple request,
  // so the preflight has to be answered here — peeko only sets CORS headers on
  // its SSE routes.
  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!originAllowed(origin)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden_origin' }));
      return false;
    }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    return true;
  }

  return {
    store,

    /** Handle POST/OPTIONS on the public capture route. Returns true if it did. */
    async handleHttp(req, res) {
      const path = (req.url ?? '').split('?')[0];
      if (path !== CAPTURE_PATH) return false;

      if (req.method === 'OPTIONS') {
        if (!applyCors(req, res)) return true;
        res.writeHead(204, {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        });
        res.end();
        return true;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return true;
      }

      if (!applyCors(req, res)) return true;

      if (!allowCapture(clientIp(req))) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate_limited' }));
        return true;
      }

      await captureHandler(req, res);
      return true;
    },

    /** The dashboard rollup. Admin-gated by the caller. */
    async monitor(rangeHours) {
      const range = Number.isFinite(rangeHours) ? Math.min(Math.max(rangeHours, 1), 24 * 90) : 24;
      const [overview, paths, topReferrers, topCountries, bounce, recent] = await Promise.all([
        store.getOverview({ rangeHours: range }),
        // NOT getTopPaths: that one hardcodes `path != '/'` to answer "which
        // other pages do people reach", which on a portfolio hides the single
        // most visited page. The breakdown reads $pathname straight out of the
        // props bag, so "/" ranks like any other route.
        store.getBreakdown({ event: '$pageview', prop: '$pathname', rangeHours: range, limit: 12 }),
        store.getTopReferrers({ rangeHours: range }),
        store.getTopCountries({ rangeHours: range }),
        store.getBounce({ rangeHours: range }),
        store.getRecentFeed({ rangeHours: range, limit: 40 }),
      ]);
      const topPaths = paths.map(({ value, count }) => ({ path: value, count }));
      return { rangeHours: range, overview, topPaths, topReferrers, topCountries, bounce, recent };
    },

    /** Top-N of any property on any event — the site's custom events. */
    async breakdown({ event, prop, rangeHours, distinct }) {
      const range = Number.isFinite(rangeHours) ? Math.min(Math.max(rangeHours, 1), 24 * 90) : 24;
      return store.getBreakdown({
        event: event ?? null,
        prop,
        rangeHours: range,
        limit: 12,
        distinct: distinct === true,
      });
    },

    /**
     * Live events as they land, already filtered by the same feed rules the
     * historical query uses, so the ticker and the list never disagree.
     */
    subscribe(listener) {
      return store.subscribe((record) => {
        if (!store.feedFilterAccepts(record)) return;
        listener(store.buildFeedEvent(record));
      });
    },

    async stop() {
      clearInterval(rateSweep);
      store.stop();
      // one last flush so the events buffered in the last second survive a
      // deploy restart
      await store.flush().catch(() => {});
      db.close();
    },
  };
}
