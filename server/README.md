# AlejOS chat server

Self-hosted WebSocket server behind the AlejOS login screen and Chat Rooms app. Visitors register real accounts (stored in SQLite, scrypt-hashed passwords) or chat as guests, then talk in shared rooms — `#general`, `#projects`, `#random`. Room history persists so late joiners see the conversation. Plain Node 22 ESM, no build step; dependencies are `ws` and `better-sqlite3` only.

v2 replaced the old 1:1 messenger protocol entirely — deploy the server and the frontend together.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `8787` | HTTP/WebSocket listen port |
| `ADMIN_TOKEN` | yes | none | The password for the reserved admin username. The server refuses to start without it |
| `ADMIN_USERNAME` | no | `aleju` | Reserved username; logging in with it + `ADMIN_TOKEN` grants the admin badge. Nobody can register or nick it |
| `ALLOWED_ORIGINS` | no | unset | Comma-separated list, e.g. `https://aleju.dev,http://localhost:4173`. If set, WebSocket upgrades with an Origin header not in the list are rejected |
| `DB_PATH` | no | `./data/chat.db` | SQLite database path. The parent directory is created if missing |

## Protocol sketch

Everything is JSON over `/ws`. First message must be `hello`:

- `{type:'hello', token?, nick?}` → `{type:'hello-ok', user|null, badToken, rooms, you}`
- `{type:'register', username, password}` / `{type:'login', username, password}` → `{type:'auth-ok', token, user}` or `{type:'error', code}`
- `{type:'nick', name}` (guests only; registered names are protected) → `nick-ok`
- `{type:'join', room}` → `{type:'history', room, messages}` plus `users`/`rooms` broadcasts
- `{type:'msg', room, text, tmp}` → `{type:'ack', tmp, id, at}`; everyone else in the room gets `{type:'msg', room, message}`
- `{type:'typing', room}` → forwarded to the room, throttled

Messages carry `{from, admin, registered, text, at}` so the client can render badges. Admin sessions resume from in-memory tokens only; a restart logs the admin out. Registered-user session tokens expire after 90 days; expired rows are swept hourly.

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

The frontend needs `VITE_CHAT_URL=wss://chat.example.com/ws` at build time. Without it, the AlejOS login screen still offers Guest and the Chat Rooms app falls back to the mail composer.

To log in as admin, use the reserved username with `ADMIN_TOKEN` as the password on the AlejOS login screen.
