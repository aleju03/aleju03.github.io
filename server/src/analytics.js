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

import { AnalyticsStore, createAnalyticsHandler, createDb, exec } from '@aleju03/peeko';
import { countryForTimeZone } from './timezones.js';

const CAPTURE_PATH = '/peeko/capture';

// peeko's own read API clamps every range to 720 hours, so offering a longer
// one on the dashboard would quietly answer with 30 days of data under a "90d"
// label. The ceiling is peeko's, and it is repeated here so the two agree.
const MAX_RANGE_HOURS = 720;

// Columns in the traffic chart. Fixed, so the chart is the same width whatever
// the range, and the bucket simply gets wider.
const TIMELINE_BUCKETS = 48;

// How much of the feed travels on each rollup. The dashboard stitches these
// rows into per-visitor sessions client-side, so this is really "how far back a
// session can reach", not "how many rows fit on screen".
const FEED_LIMIT = 400;
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

/**
 * Where the visitor is, best effort, in order of trust:
 *
 * 1. An edge geo header, resolved from the client IP by something upstream
 *    (Cloudflare, Vercel). Authoritative when present, absent behind a plain
 *    Caddy, which is why there is a step 2.
 * 2. The browser's own timezone, sent as ?tz= on the capture request. A query
 *    param rather than a header or a body field because it must survive
 *    sendBeacon (which can set neither) and must not turn capture into a
 *    preflighted request.
 *
 * Never an IP database: a licensed 60MB file to keep updated, or a
 * third-party lookup sitting in the capture path, is a lot of machinery for a
 * flag on a personal dashboard.
 */
function countryFor(req, url) {
  for (const header of COUNTRY_HEADERS) {
    const value = req.headers[header];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return countryForTimeZone(url.searchParams.get('tz'));
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
    // peeko stamps every feed row with a clock label in this zone. The
    // dashboard ignores it and formats from the epoch `ts` in the browser
    // instead — a label rendered on a VPS is right for the VPS and wrong for
    // whoever is reading it, which is how a visit at midnight came back
    // reading 6am. The option stays set so anything else reading this store
    // (a log line, a future export) gets my zone rather than UTC.
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
      geoCountry: countryFor(req, new URL(req.url ?? '/', 'http://localhost')),
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

  /**
   * The three rollups peeko has no method for, read straight off the same
   * table over the same libsql handle.
   *
   * They are one function because they share a window and are always wanted
   * together, and they are raw SQL because peeko is deliberately a core rather
   * than a dashboard: its read API covers what every site wants, and the shape
   * of the rest is the site's own business.
   */
  async function derived(since, rangeHours) {
    // The store buffers writes for a second before they land, and these read
    // around peeko's own methods, which each flush for themselves.
    await store.flush();

    // Buckets are aligned to `since` rather than to the wall clock, so the
    // newest one always ends at "now" and the chart never opens on a half-empty
    // column. The clock labels above the axis are a separate, timezone-aware
    // overlay on the client; these are just offsets into the range.
    const bucketMs = Math.max(60_000, Math.ceil((rangeHours * 60 * 60_000) / TIMELINE_BUCKETS));
    const [buckets, devices, seen, bots] = await Promise.all([
      exec(db, `
        select cast((ts - ?) / ? as integer) as b,
          count(*) as events,
          sum(case when event = '$pageview' then 1 else 0 end) as pageviews,
          count(distinct distinct_id) as visitors
        from analytics_events
        where ts > ? and is_bot = 0 and distinct_id != 'server'
        group by b order by b
      `, [since, bucketMs, since]),
      // Mirrors peeko's own deviceKindFor: the screen wins when it is a real
      // number, the viewport is the fallback, and neither means unknown.
      exec(db, `
        select case
            when coalesce(nullif(screen_width, 0), nullif(viewport_width, 0)) is null then 'unknown'
            when coalesce(nullif(screen_width, 0), nullif(viewport_width, 0)) < 768 then 'mobile'
            else 'desktop' end as kind,
          count(distinct distinct_id) as n
        from analytics_events
        where ts > ? and is_bot = 0 and distinct_id != 'server'
        group by kind order by n desc
      `, [since]),
      // New vs returning, over the whole retained table rather than the range:
      // a visitor is new if the oldest row that still exists for them is inside
      // it. Retention therefore bounds "returning" at 180 days, which is the
      // honest answer rather than a wrong one.
      exec(db, `
        select count(*) as total, sum(case when first_ts > ? then 1 else 0 end) as fresh
        from (
          select distinct_id, min(ts) as first_ts, max(ts) as last_ts
          from analytics_events where is_bot = 0 and distinct_id != 'server'
          group by distinct_id
        ) where last_ts > ?
      `, [since, since]),
      // Crawlers are stored and then filtered out of everything above, so
      // without this line the dashboard cannot tell "quiet week" from "quiet
      // week, plus four hundred hits from a search engine".
      exec(db, 'select count(*) as n from analytics_events where ts > ? and is_bot = 1', [since]),
    ]);

    const byBucket = new Map();
    for (const row of buckets.rows) {
      const index = Number(row.b);
      if (!Number.isFinite(index) || index < 0 || index >= TIMELINE_BUCKETS) continue;
      byBucket.set(index, {
        ts: since + index * bucketMs,
        events: Number(row.events ?? 0),
        pageviews: Number(row.pageviews ?? 0),
        visitors: Number(row.visitors ?? 0),
      });
    }

    const visitors = seen.rows[0];
    return {
      bucketMs,
      // Dense on purpose: a gap in a bar chart has to be drawn as a gap, and
      // the client should not have to reconstruct which columns are missing.
      timeline: Array.from({ length: TIMELINE_BUCKETS }, (_, i) =>
        byBucket.get(i) ?? { ts: since + i * bucketMs, events: 0, pageviews: 0, visitors: 0 }
      ),
      devices: devices.rows.map((row) => ({
        kind: String(row.kind ?? 'unknown'),
        count: Number(row.n ?? 0),
      })),
      visitors: {
        total: Number(visitors?.total ?? 0),
        fresh: Number(visitors?.fresh ?? 0),
      },
      bots: Number(bots.rows[0]?.n ?? 0),
    };
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

    /**
     * The dashboard rollup. Admin-gated by the caller.
     *
     * Everything peeko answers itself is asked for here; the three queries
     * below it are ones peeko has no method for and that the dashboard needs
     * (the shape of traffic over time, the device split, and how much of the
     * range is people who had never been here before).
     *
     * No clock label is computed anywhere in this payload. Every time on the
     * dashboard is derived from an epoch `ts` in the browser, because the only
     * timezone that is ever right is the one the person reading it is in.
     * `now` rides along so ages stay honest even against a skewed local clock.
     */
    async monitor({ rangeHours, country } = {}) {
      const range = Number.isFinite(rangeHours)
        ? Math.min(Math.max(rangeHours, 1), MAX_RANGE_HOURS)
        : 24;
      const now = Date.now();
      const since = now - range * 60 * 60_000;
      const feedCountry = typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)
        ? country.toUpperCase()
        : null;

      const [overview, paths, topReferrers, topCountries, bounce, recent, extra] =
        await Promise.all([
          store.getOverview({ rangeHours: range, now }),
          // NOT getTopPaths: that one hardcodes `path != '/'` to answer "which
          // other pages do people reach", which on a portfolio hides the single
          // most visited page. The breakdown reads $pathname straight out of the
          // props bag, so "/" ranks like any other route.
          store.getBreakdown({ event: '$pageview', prop: '$pathname', rangeHours: range, limit: 12, now }),
          store.getTopReferrers({ rangeHours: range, limit: 12, now }),
          store.getTopCountries({ rangeHours: range, limit: 30, now }),
          store.getBounce({ rangeHours: range, now }),
          store.getRecentFeed({ rangeHours: range, limit: FEED_LIMIT, country: feedCountry, now }),
          derived(since, range),
        ]);

      return {
        rangeHours: range,
        country: feedCountry,
        now,
        overview,
        topPaths: paths.map(({ value, count }) => ({ path: value, count })),
        topReferrers,
        topCountries,
        bounce,
        recent,
        ...extra,
      };
    },

    /** Top-N of any property on any event — the site's custom events. */
    async breakdown({ event, prop, rangeHours, distinct, limit }) {
      const range = Number.isFinite(rangeHours)
        ? Math.min(Math.max(rangeHours, 1), MAX_RANGE_HOURS)
        : 24;
      return store.getBreakdown({
        event: event ?? null,
        prop,
        rangeHours: range,
        limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 12,
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
