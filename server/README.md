# Portfolio chat server

Small self-hosted WebSocket chat server for the AlejOS Messenger app. Visitors chat 1:1 with the site owner, who reads and replies from the same app in admin mode. Messages persist in SQLite so offline messages are delivered later. Plain Node 22 ESM, no build step. Dependencies are `ws` and `better-sqlite3` only.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `8787` | HTTP/WebSocket listen port |
| `ADMIN_TOKEN` | yes | none | Admin passphrase. The server refuses to start without it |
| `ALLOWED_ORIGINS` | no | unset | Comma-separated list, e.g. `https://aleju.dev,http://localhost:4173`. If set, WebSocket upgrades with an Origin header not in the list are rejected |
| `DB_PATH` | no | `./data/messages.db` | SQLite database path. The parent directory is created if missing |

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
Description=Portfolio chat server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/portfolio-chat/src/index.js
WorkingDirectory=/opt/portfolio-chat
Environment=PORT=8787
Environment=ADMIN_TOKEN=change-me
Environment=ALLOWED_ORIGINS=https://aleju.dev
Environment=DB_PATH=/opt/portfolio-chat/data/messages.db
Restart=always
User=www-data

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

The frontend needs `VITE_CHAT_URL=wss://chat.example.com/ws` at build time.

`ADMIN_TOKEN` is the passphrase typed as `/admin <token>` inside the AlejOS Messenger app.
