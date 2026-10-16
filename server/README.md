# Datasetto server

Node.js 22+ / TypeScript. Express 5 for HTTP, Socket.IO 4 for realtime, SQLite
(better-sqlite3, WAL mode) for persistence, zod for input validation, pino for
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
| `REGISTRATION_MODE` | `open`, `invite` (needs `REGISTRATION_INVITE_CODE`, or an admin-made invite token) or `closed` |
| `ADMIN_EMAILS` | accounts that always receive the superuser role |
| `CORS_ORIGINS` | browser origins allowed to connect; native shells are allowed by default |
| `TURN_URLS`, `TURN_SECRET` | enable TURN; the server mints 12-hour HMAC credentials for clients |
| `PUBLIC_RTMP_URL` | shown in the OBS dialog: `rtmps://host:1936/live` on a deployed server (TLS through nginx, Caddy's certificate), `rtmp://host/live` for plain RTMP |
| `DATABASE_PATH` | SQLite file; parent directory is created |
| `DATA_DIR` | uploads (avatars under `DATA_DIR/avatars`); defaults to the database's directory, `/data` in Docker |
| `TRUST_PROXY` | read client IPs from `X-Forwarded-For` (true behind Caddy) |

## HTTP API

| Method, path | Purpose |
| --- | --- |
| `GET /health`, `GET /api/health` | liveness, version, uptime |
| `GET /api/stats` | channel, user and message counts |
| `GET /api/config` | public runtime config: registration mode, URLs, ICE servers (ephemeral TURN credentials), limits |
| `GET /api/stream/:channelName/status` | is a stream channel live |
| `GET /api/releases`, `/latest` | installers from the latest GitHub release of `RELEASES_GITHUB_REPO` (cached) for the landing and downloads pages |
| `POST /api/avatars` | Bearer session token, body = raw PNG or WebP bytes (1 MB max, signature-checked): stores `DATA_DIR/avatars/<accountId>.<ext>` and sets `avatarUrl` to `/api/avatars/<accountId>.<ext>?v=<time>` |
| `DELETE /api/avatars` | removes the uploaded picture (generated avatar again) |
| `GET /api/avatars/:file` | serves uploaded pictures with `Cache-Control: public, max-age=31536000, immutable` (Caddy already proxies `/api/*`) |
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
| `channel:join id`, `channels:list`, `channels:create {name,type,groupId?,topic?,visibility?,password?}`, `channels:update {channelId,topic?,visibility?,password?}`, `channels:joinPrivate {name,password}`, `channels:delete idOrName`, `dm:open {accountId}` | `channel:joined`, `chat:history`, `channels:update {channels, groups}`, `channels:created`, `channels:updated`, `channels:privateJoined {channelId}`, `channel:deleted {channelId, reason?}`, `dm:opened {channelId, peerId, peerName}` |
| `chat text`, `chat:delete {messageId, channelId}`, `chat:react/unreact {channelId, messageId, emoji}` | `chat message` (with `reactions[]`), `chat:messageDeleted`, `chat:reaction {channelId, messageId, emoji, accountId, displayName, added, reactions[]}` |
| `voice:join id`, `voice:leave`, `voice:signal {to,data}`, `voice:stream-metadata`, `voice:state {muted,deafened}`, `voice:video:state` | `voice:joined {peers,startedAt,sessionId}`, `voice:peer-join`, `voice:peer-leave`, `voice:signal`, `voice:state`, `voice:video:state` |
| `voice:kick`, `voice:timeout`, `user:ban {targetSocketId,...}` | `voice:kicked`, `voice:timeout`, `user:banned`, `moderation:success` |
| `screenshare:start/stop/viewer:join/viewer:leave {channelId}`, `screenshare:signal` | `screenshare:session`, `screenshare:viewer:pending`, `screenshare:signal` |
| `stream:key:request {channelId}`, `stream:key:regenerate {channelId}` | `stream:key:response {streamKey: "channel?key=token", ...}` |
| `account:get`, `account:update {...}` | `account:data`, `account:updated`, `account:rolesUpdated` |
| `admin:accounts:list/updateRoles/disable/enable/unban`, `admin:bans:list`, `admin:channels:getPermissions/updatePermissions`, `admin:channels:members:list/add/remove {channelId, accountId?}` | `admin:accounts:*`, `admin:bans:list`, `admin:channels:permissions`, `channels:permissionsUpdated`, `admin:channels:members {channelId, members[]}` |
| `admin:invites:list`, `admin:invites:create {maxUses?, expiresAt?, note?}`, `admin:invites:revoke/delete {inviteId}` | `admin:invites:list {invites[]}`, `admin:invites:created {invite}` |
| `admin:settings:get`, `admin:settings:update {channelPermissionTemplates?: {text?, voice?, stream?, screenshare?}}` | `admin:settings {settings, saved?}` |
| `voice:game:start/join/leave/input/end/leaderboard` | `voice:game:state/update/started/ended/leaderboard` |

Presence is broadcast as `user:update users[]` to everyone whenever it changes.
Stream keys are never included in channel lists; they are only returned by
`stream:key:request` to users allowed to stream on that channel.

### Channel permissions

Every channel stores five entries (`view`, `chat`, `voice`, `stream`, `manage`),
each a list of roles (`*` = everyone) plus per-account overrides. `view` is the
gate for everything: joining the channel and reading history, voice, hosting
or watching a screenshare, HLS tickets, stream keys, reactions and deletion
all require it before the action's own entry is checked
(`ChannelService.requireAccess`). Permission changes are broadcast only to
people who can see the channel, and the public stream status endpoint does
not acknowledge private channels. Admins keep a template per channel kind in
the `settings` table (`admin:settings:update {channelPermissionTemplates}`);
`channels:create` without explicit permissions starts from that template, else
from the server default (everyone may see, chat, talk and stream; admins manage).

### Direct messages

A one-to-one conversation is a channel of type `dm`: private, ungrouped, with
exactly two rows in `channel_members` and a random name. `dm:open {accountId}`
creates it or returns the existing one and answers `dm:opened`. Only the two
participants pass any permission check on it (not even superusers), so history,
reactions and deletion follow the normal chat pipeline but stay between them;
admin tools (`channels:update/delete`, permissions, members) refuse `dm`
channels. DMs do not count against `MAX_CHANNELS`. Each side's channel list
entry carries `dm: {peerId, peerName, peerUsername, peerAvatarUrl}` for the
other person, and `channels.last_message_at` (every channel) lets clients sort
conversations by recency.

### Reactions

Anyone who can view a channel can react to its messages with one emoji per
reaction (`message_reactions`, one row per message, account and emoji; at most
20 different emojis per message and 10 reactions per account per message).
Messages carry `reactions: [{emoji, count, accountIds, names}]` in history and
in the `chat` event; every change is broadcast as `chat:reaction` to everyone
who can view the channel. Reactions are rate limited separately from messages
(60 per minute per socket) and disappear with their message.

### Invite tokens

Admins (`canManageUsers`) create invite tokens from the admin panel: single-use
or up to 1000 uses, optional expiry and note. Tokens look like `inv-…`, are
stored in `invite_tokens` as issued (so the link can be copied again) and can be
revoked or deleted. `auth:register` accepts either `REGISTRATION_INVITE_CODE`
or a valid token in `inviteCode`; the account remembers the token in
`accounts.invite_token_id`, and the token's use and the account are written in
one transaction. In `open` mode a valid token is recorded and an invalid one is
ignored; `closed` stays closed. Invite links are `https://host/app?invite=TOKEN`:
the client moves the token into the registration form and drops it from the URL.
`GET /api/config` reports `registration.acceptsInviteLinks`.

### Private channels

A channel has `visibility: public | private`, an optional `topic` and, when
private, an optional join password (bcrypt hash in `channels.join_password_hash`,
never sent to clients; `hasPassword` is). Private channels are listed only for
their members (`channel_members`, one row per account) and for admins who hold
`canManageChannelPermissions`; superusers see everything. Every permission check
(`view`, `chat`, `voice`, `stream`, `manage`) first requires membership on a
private channel, so chat history, HLS tickets, voice and screenshare all follow
the same rule. Whoever creates a private channel is its first member. Members
join once with `channels:joinPrivate {name, password}` (rate limited with the
auth bucket) and stay members; admins add and remove members with
`admin:channels:members:*`. A removed member receives `channel:deleted {reason:
"removed"}`. Making a channel public clears its password and member list.

## Maintenance

```bash
npm run backup -- ./backups/today.db           # consistent copy via the SQLite backup API
npm run import-legacy -- /path/to/old/storage  # import accounts.json / messages.json from the previous server
```
