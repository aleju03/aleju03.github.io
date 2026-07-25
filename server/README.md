# AlejOS chat server

Self-hosted WebSocket server behind the AlejOS login screen, the Chat Rooms app and the Games folder. Visitors register real accounts (stored in SQLite, scrypt-hashed passwords) or chat as guests, then talk in shared rooms — `#general`, `#projects`, `#random`. Room history persists so late joiners see the conversation. The same socket carries the arcade: shared per-game leaderboards (one best row per player per game) and Mine Duel, a turn-based 1v1 minesweeper with server-side matchmaking and game logic. Plain Node 22 ESM, no build step; dependencies are `ws` and `better-sqlite3` only.

v2 replaced the old 1:1 messenger protocol entirely — deploy the server and the frontend together.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `8787` | HTTP/WebSocket listen port |
| `ADMIN_TOKEN` | yes | none | The password for the reserved admin username. The server refuses to start without it |
| `ADMIN_USERNAME` | no | `aleju` | Reserved username; logging in with it + `ADMIN_TOKEN` grants the admin badge. Nobody can register or nick it |
| `ALLOWED_ORIGINS` | no | unset | Comma-separated list, e.g. `https://aleju.dev,http://localhost:4173`. If set, WebSocket upgrades with an Origin header not in the list are rejected |
| `DB_PATH` | no | `./data/chat.db` | SQLite database path. The parent directory is created if missing |
| `ANALYTICS_URL` | no | unset | libsql URL for the peeko analytics store (`libsql://…turso.io` or `file:./data/analytics.db`). **Unset disables analytics entirely** |
| `ANALYTICS_AUTH_TOKEN` | no | unset | Turso database token; not needed for a `file:` URL |
| `ANALYTICS_RETENTION_DAYS` | no | `180` | Rows older than this are pruned hourly |
| `ANALYTICS_SITE_HOSTS` | no | unset | Comma-separated hosts that count as real traffic in the live feed, e.g. `aleju03.github.io`. Keeps localhost and preview deploys out |
| `ANALYTICS_TIME_ZONE` | no | `UTC` | IANA zone for the feed's clock labels |

## Analytics

Traffic capture runs on [peeko](https://github.com/aleju03/peeko), in its own
libsql/Turso database — never `chat.db`, since analytics rows are high-volume
and would bloat the file chat reads from. `server/src/analytics.js` owns it.

The split that matters is trust:

- **`POST /peeko/capture` is public.** Browsers post to it cross-origin from the
  static site, so it carries no token — a token shipped to a browser is not a
  token. It is origin-checked against `ALLOWED_ORIGINS`, rate limited per IP,
  and can only ever append events. This is the only analytics route served over
  HTTP; `/peeko/monitor`, `/peeko/live` and the ticket routes are deliberately
  **not** mounted.
- **Reads are admin-only and ride the WebSocket.** The socket already
  authenticated at login, so the dashboard asks over it instead of holding a
  bearer token of its own.

Analytics messages, same socket after `hello`, all refused with
`{type:'error', code:'forbidden'}` unless the session is the admin:

- `{type:'peeko-monitor', rangeHours}` → `{type:'peeko-monitor', rangeHours, overview, topPaths, topReferrers, topCountries, bounce, recent}`
- `{type:'peeko-breakdown', event, prop, rangeHours, distinct?}` → `{type:'peeko-breakdown', event, prop, rows}` — top-N of any property in the props bag, which is how the site's custom events (`project_view`, `app_open`, `os_boot`) are read
- `{type:'peeko-live', on}` → subscribes; each accepted event arrives as `{type:'peeko-event', event}`

A failing analytics store never takes chat down: a bad token or an unreachable
database logs and leaves `analytics` null, and the dashboard reports
`unavailable`.

Two deliberate departures from peeko's defaults, both in `analytics.js`:
`feedExcludeRootPageview` is off (on this site `/` is the front page, not
landing-page noise), and the paths panel is built from `getBreakdown` on
`$pathname` rather than `getTopPaths`, which hardcodes `path != '/'`.

## Protocol sketch

Everything is JSON over `/ws`. First message must be `hello`:

- `{type:'hello', token?, nick?}` → `{type:'hello-ok', user|null, badToken, rooms, you}`
- `{type:'register', username, password}` / `{type:'login', username, password}` → `{type:'auth-ok', token, user}` or `{type:'error', code}`
- `{type:'nick', name}` (guests only; registered names are protected) → `nick-ok`
- `{type:'join', room}` → `{type:'history', room, messages}` plus `users`/`rooms` broadcasts
- `{type:'msg', room, text, tmp}` → `{type:'ack', tmp, id, at}`; everyone else in the room gets `{type:'msg', room, message}`
- `{type:'typing', room}` → forwarded to the room, throttled

Messages carry `{from, admin, registered, text, at}` so the client can render badges. Admin sessions resume from in-memory tokens only; a restart logs the admin out. Registered-user session tokens expire after 90 days; expired rows are swept hourly.

Arcade messages, same socket after `hello`:

- `{type:'score-submit', game, score}` → `{type:'score-ok', game, best, improved, rank}`. Games and their caps live in `GAMES`; time-based games sort ascending. The `duel` board rejects submits — the match engine writes wins itself.
- `{type:'score-top', game}` → `{type:'score-top', game, top: [...25], you: {score, rank} | null}`
- `{type:'duel-queue'}` → `duel-queued`, then `duel-start {seat, players, size, mines, lives, deadline}` once paired
- `{type:'duel-plant', cells: [5 indices]}` during the blind phase → `duel-planted` per seat (with `auto: true` plus your cells if the 45s clock planted for you), then `duel-phase {turn, deadline}`
- `{type:'duel-dig', cell}` on your turn → `duel-dug {cell, by, mine, count, lives, turn, deadline}` to both; a 20s turn timeout digs a random tile for the staller. Numbers count both players' mines (duplicates included); any mine costs the digger a life, their own included
- `duel-over {winner, reason, lives, mines}` reveals both minefields; `{type:'duel-rematch'}` from both seats restarts, `{type:'duel-leave'}` forfeits

## Run locally

```sh
cd server
npm install
ADMIN_TOKEN=dev-secret npm start
```

Health check at `GET /health`, WebSocket endpoint at `/ws`. Run the smoke test with `npm test`.

## systemd unit

```ini
[Unit]
Description=AlejOS chat server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/portfolio-chat/src/index.js
WorkingDirectory=/opt/portfolio-chat
Environment=PORT=8787
Environment=ADMIN_TOKEN=change-me
Environment=ALLOWED_ORIGINS=https://aleju.dev
Environment=DB_PATH=/opt/portfolio-chat/data/chat.db
Environment=ANALYTICS_URL=libsql://your-db.turso.io
Environment=ANALYTICS_AUTH_TOKEN=change-me
Environment=ANALYTICS_SITE_HOSTS=aleju03.github.io
Restart=always
User=www-data
# Hard ceiling well above normal usage (~60MB); a runaway gets recycled.
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

## Caddy

```
chat.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## Frontend notes

The frontend needs `VITE_CHAT_URL=wss://chat.example.com/ws` at build time. Without it, the AlejOS login screen still offers Guest, the Chat Rooms app falls back to the mail composer, and analytics capture goes quiet — `src/analytics.ts` derives its capture endpoint from the same variable (`wss://…/ws` → `https://…/peeko/capture`), so there is no second URL to configure.

To log in as admin, use the reserved username with `ADMIN_TOKEN` as the password on the AlejOS login screen. That session, and only that one, gets the **peeko** entry in the Start menu — the traffic dashboard.
