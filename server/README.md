# Datasetto server

Node.js 24 (22.12+ works) / TypeScript 6. Express 5 for HTTP, Socket.IO 4 for realtime, SQLite
(better-sqlite3, WAL mode) for persistence, zod 4 for input validation, pino for
logs. One process, one database file, no other services required.

```bash
npm install
cp .env.example .env
npm run dev          # tsx watch, http://localhost:4000
npm test             # vitest (unit + HTTP + socket integration)
npm run build        # tsc -> dist/
npm start            # node dist/index.js
```

## Source layout

```
src/
  index.ts            bootstrap, timers, graceful shutdown
  config.ts           zod-validated environment -> AppConfig
  context.ts          wires services together (AppContext)
  db/                 SQLite open + migrations (PRAGMA user_version)
  core/               ids/tokens, roles & permissions, rate limiter, zod schemas
  services/
    accounts.ts       register / authenticate / profile / roles / disable (bcrypt)
    sessions.ts       opaque bearer tokens, hashed at rest, sliding expiry
    channels.ts       persistent channels, groups, permissions, stream keys
    messages.ts       chat history with retention and soft delete
    moderation.ts     bans (persistent) and voice timeouts (memory)
    presence.ts       everything live: connected users, rooms, streams, screenshares
    turn.ts           ephemeral TURN credentials (coturn use-auth-secret)
    leaderboard.ts    minigame high scores
  http/               Express app, origin checker, routes (health, config, stream callbacks, releases)
  socket/             Socket.IO server, per-connection context, handlers per domain
  minigames/          game engine (plain JS, unchanged protocol)
  scripts/            backup.ts, import-legacy.ts
test/                 vitest suites
assets/pacman-maps/   level presets
```

## Configuration

See [.env.example](.env.example). Notable settings:

| Variable | Purpose |
| --- | --- |
| `REGISTRATION_MODE` | `open`, `invite` (needs `REGISTRATION_INVITE_CODE`) or `closed` |
| `ADMIN_EMAILS` | accounts that always receive the superuser role |
| `CORS_ORIGINS` | browser origins allowed to connect; native shells are allowed by default |
| `TURN_URLS`, `TURN_SECRET` | enable TURN; the server mints 12-hour HMAC credentials for clients |
| `PUBLIC_RTMP_URL` | shown in the OBS dialog: `rtmps://host:1936/live` on a deployed server (TLS through nginx, Caddy's certificate), `rtmp://host/live` for plain RTMP |
| `DATABASE_PATH` | SQLite file; parent directory is created |
| `TRUST_PROXY` | read client IPs from `X-Forwarded-For` (true behind Caddy) |

## HTTP API

| Method, path | Purpose |
| --- | --- |
| `GET /health`, `GET /api/health` | liveness, version, uptime |
| `GET /api/stats` | channel, user and message counts |
| `GET /api/config` | public runtime config: registration mode, URLs, ICE servers (ephemeral TURN credentials), limits |
| `GET /api/stream/:channelName/status` | is a stream channel live |
| `GET /api/releases`, `/latest` | installers from the latest GitHub release of `RELEASES_GITHUB_REPO` (cached) for the landing and downloads pages |
| `POST /internal/stream/publish` | nginx-rtmp `on_publish`: validates `key` for stream name `<channel>` (OBS key is `channel?key=token`) |
| `POST /internal/stream/done` | nginx-rtmp `on_publish_done` |

`/internal/*` must not be exposed publicly; Caddy only proxies `/api`, `/socket.io` and `/health`.

## Socket protocol

Authentication is event based. Clients emit `auth:register`, `auth:login` or
`auth:session {token}` and receive `auth:success {user, account, session,
channels, groups}` or `auth:error {message, code}`. Everything else requires an
authenticated socket. Failures are reported on the domain's error event
(`auth:error`, `account:error`, `admin:error`, `screenshare:error`,
`stream:key:error`, `voice:game:error`) or the generic `error` event, always as
`{message, code}`. Every payload is validated with zod; per-socket and per-IP
rate limits apply.

| Client emits | Server emits |
| --- | --- |
| `channel:join id`, `channels:list`, `channels:create {name,type,groupId?}`, `channels:delete idOrName` | `channel:joined`, `chat:history`, `channels:update {channels, groups}`, `channel:deleted` |
| `chat text`, `chat:delete {messageId, channelId}` | `chat message`, `chat:messageDeleted` |
| `voice:join id`, `voice:leave`, `voice:signal {to,data}`, `voice:stream-metadata`, `voice:state {muted,deafened}`, `voice:video:state` | `voice:joined {peers,startedAt,sessionId}`, `voice:peer-join`, `voice:peer-leave`, `voice:signal`, `voice:state`, `voice:video:state` |
| `voice:kick`, `voice:timeout`, `user:ban {targetSocketId,...}` | `voice:kicked`, `voice:timeout`, `user:banned`, `moderation:success` |
| `screenshare:start/stop/viewer:join/viewer:leave {channelId}`, `screenshare:signal` | `screenshare:session`, `screenshare:viewer:pending`, `screenshare:signal` |
| `stream:key:request {channelId}`, `stream:key:regenerate {channelId}` | `stream:key:response {streamKey: "channel?key=token", ...}` |
| `account:get`, `account:update {...}` | `account:data`, `account:updated`, `account:rolesUpdated` |
| `admin:accounts:list/updateRoles/disable/enable/unban`, `admin:bans:list`, `admin:channels:getPermissions/updatePermissions` | `admin:accounts:*`, `admin:bans:list`, `admin:channels:permissions`, `channels:permissionsUpdated` |
| `voice:game:start/join/leave/input/end/leaderboard` | `voice:game:state/update/started/ended/leaderboard` |

Presence is broadcast as `user:update users[]` to everyone whenever it changes.
Stream keys are never included in channel lists; they are only returned by
`stream:key:request` to users allowed to stream on that channel.

## Maintenance

```bash
npm run backup -- ./backups/today.db           # consistent copy via the SQLite backup API
npm run import-legacy -- /path/to/old/storage  # import accounts.json / messages.json from the previous server
```
