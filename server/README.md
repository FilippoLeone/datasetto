# Datasetto server

Node.js 24 (22.12+ works) / TypeScript 6. Express 5 for HTTP, Socket.IO 4 for realtime, SQLite
(better-sqlite3, WAL mode) for persistence, zod 4 for input validation, pino for
logs. One process, one database file, no other services required.

```bash
npm install
cp .env.example .env
npm run dev          # tsx watch, http://localhost:4000
npm run typecheck    # tsc, no output
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
    messages.ts       chat history with retention and soft delete, older-history paging
    search.ts         full-text search over messages (FTS5 index, query sanitising, snippets)
    moderation.ts     bans (persistent) and voice timeouts (memory)
    presence.ts       everything live: connected users (with page visibility and game activity), rooms, streams, screenshares
    push.ts           Web Push subscriptions per account and delivery through web-push (VAPID)
    messageNotifications.ts  who a message is for (DM peer, @mentions) and whether they are away
    turn.ts           ephemeral TURN credentials (coturn use-auth-secret)
    hlsTickets.ts     signed, short-lived viewer tickets for HLS (Caddy asks /internal/hls/auth)
    streamWatchdog.ts polls nginx-rtmp /stat: bitrate cap, monthly egress budget
    usage.ts          per-month HLS egress accounting in SQLite
    leaderboard.ts    minigame high scores
  http/               Express app, origin checker, routes (health, config, stream callbacks, HLS tickets, releases)
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
| `SINGLE_SESSION_PER_ACCOUNT` | default `true`: a sign-in with a new session token (another device, or a password login) ends the account's other logins: their tokens are revoked and their live connections get `auth:error {code: "SIGNED_IN_ELSEWHERE"}`; a stale client resuming a revoked token gets `SESSION_FAILED` instead of taking the account back, so switching devices needs the password. Connections that resume the same token (tabs of one browser, a reload) are one login and stay. `false` allows several logins per account |
| `CORS_ORIGINS` | browser origins allowed to connect; native shells are allowed by default |
| `TURN_URLS`, `TURN_SECRET` | enable TURN; the server mints 12-hour HMAC credentials for clients |
| `PUBLIC_RTMP_URL` | shown in the OBS dialog: `rtmps://host:1936/live` on a deployed server (TLS through nginx, Caddy's certificate), `rtmp://host/live` for plain RTMP |
| `DATABASE_PATH` | SQLite file; parent directory is created |
| `DATA_DIR` | uploads (avatars under `DATA_DIR/avatars`); defaults to the database's directory, `/data` in Docker |
| `TRUST_PROXY` | read client IPs from `X-Forwarded-For` (true behind Caddy) |
| `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, `PUSH_VAPID_SUBJECT` | Web Push (see below). Both keys empty = push off; set together (`npx web-push generate-vapid-keys`). The subject is a `mailto:` or `https:` contact for push services, defaulting to the first `ADMIN_EMAILS` address |

## HTTP API

| Method, path | Purpose |
| --- | --- |
| `GET /health`, `GET /api/health` | liveness, version, uptime |
| `GET /api/stats` | channel, user and message counts |
| `GET /api/config` | public runtime config: registration mode, URLs, ICE servers (STUN only), limits, `push: {enabled, publicKey}` |
| `GET /api/stream/:channelName/status` | is a stream channel live |
| `POST /api/stream/:channelName/ticket` | HLS viewer ticket for a signed-in account allowed to view the channel (10 minutes, the player renews it; refused over the egress budget) |
| `GET /api/releases`, `/latest` | installers from the latest GitHub release of `RELEASES_GITHUB_REPO` (cached) for the landing and downloads pages |
| `GET /internal/hls/auth` | Caddy `forward_auth` for `/hls/*`: checks the `X-Hls-Ticket` header or cookie against the channel in the URL |
| `POST /api/avatars` | Bearer session token, body = raw PNG or WebP bytes (1 MB max, signature-checked): stores `DATA_DIR/avatars/<accountId>.<ext>` and sets `avatarUrl` to `/api/avatars/<accountId>.<ext>?v=<time>` |
| `DELETE /api/avatars` | removes the uploaded picture (generated avatar again) |
| `GET /api/avatars/:file` | serves uploaded pictures with `Cache-Control: public, max-age=31536000, immutable` (Caddy already proxies `/api/*`) |
| `POST /internal/stream/publish` | nginx-rtmp `on_publish`: validates `key` for stream name `<channel>` (OBS key is `channel?key=token`) |
| `POST /internal/stream/done` | nginx-rtmp `on_publish_done` |

`/internal/*` must not be exposed publicly: Caddy proxies only `/api`, `/socket.io`
and `/health` to the app, and calls `/internal/hls/auth` itself before serving `/hls/*`.

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
| `chat:history:before {channelId, beforeMessageId, limit?}` (acknowledgement) | ack `{success, channelId, messages[], hasMore}`: the page of history older than a message the client has (oldest first, 1 to 200, default `CHAT_HISTORY_LIMIT`); `chat:history:older` when sent without an ack |
| `search {query, channelId?, authorId?, limit?, offset?}` (acknowledgement) | ack `{success, query, results[], total, hasMore, limit, offset}`, each result `{id, channelId, channelName, channelType, authorId, authorName, authorAvatarUrl, roles, isSuperuser, ts, snippet: [{text, match}]}`; `search:results` when sent without an ack |
| `voice:join id`, `voice:leave`, `voice:signal {to,data}`, `voice:stream-metadata`, `voice:state {muted,deafened}`, `voice:video:state` | `voice:joined {peers,startedAt,sessionId}`, `voice:peer-join`, `voice:peer-leave`, `voice:signal`, `voice:state`, `voice:video:state` |
| `voice:kick`, `voice:timeout`, `user:ban {targetSocketId,...}` | `voice:kicked`, `voice:timeout`, `user:banned`, `moderation:success` |
| `screenshare:start/stop/viewer:join/viewer:leave {channelId}`, `screenshare:signal` | `screenshare:session`, `screenshare:viewer:pending`, `screenshare:signal` |
| `stream:key:request {channelId}`, `stream:key:regenerate {channelId}` | `stream:key:response {streamKey: "channel?key=token", ...}` |
| `account:get`, `account:update {...}` | `account:data`, `account:updated`, `account:rolesUpdated` |
| `admin:accounts:list/updateRoles/disable/enable/unban`, `admin:bans:list`, `admin:channels:getPermissions/updatePermissions`, `admin:channels:members:list/add/remove {channelId, accountId?}` | `admin:accounts:*`, `admin:bans:list`, `admin:channels:permissions`, `channels:permissionsUpdated`, `admin:channels:members {channelId, members[]}` |
| `admin:invites:list`, `admin:invites:create {maxUses?, expiresAt?, note?}`, `admin:invites:revoke/delete {inviteId}` | `admin:invites:list {invites[]}`, `admin:invites:created {invite}` |
| `admin:settings:get`, `admin:settings:update {channelPermissionTemplates?: {text?, voice?, stream?, screenshare?}}` | `admin:settings {settings, saved?}` |
| `admin:accounts:update {accountId, displayName}`, `admin:accounts:resetPassword {accountId, temporaryPassword}`, `admin:accounts:delete {accountId}`, `admin:accounts:sessions:list {accountId}`, `admin:accounts:sessions:revoke {accountId, sessionId?}` | `admin:accounts:updated/passwordReset/deleted {account}`, `admin:accounts:sessions {accountId, sessions[]}` |
| `admin:usage:get` (admins), `admin:server:info` (superusers) | `admin:usage {currentMonth, months[], budgetBytes, online, liveStreams[]}`, `admin:server:info {version, registration, sessions, limits, streaming, turn, push, storage, counts, …}` (no secrets) |
| `push:subscribe {endpoint, keys: {p256dh, auth}, userAgent?}`, `push:unsubscribe {endpoint}`, `push:list`, `push:test` (all answered through the acknowledgement: `{success, subscription?, subscriptions[], removed?, sent?}`), `presence:visibility {visible}` | `push:subscriptions` / `push:tested` when no acknowledgement was passed; errors on `push:error` (`PUSH_DISABLED`, `PUSH_INVALID`, `PUSH_NO_SUBSCRIPTIONS`) |
| `voice:game:start/join/leave/input/end/leaderboard` | `voice:game:state/update/started/ended/leaderboard` |
| `presence:activity {title}` (a game title of up to 64 characters, or `null`; one per socket per 10 s) | `user:update` with the user's `activity`; refusals on `presence:error` (`VALIDATION_FAILED`, `RATE_LIMITED`) |

Presence is broadcast as `user:update users[]` to everyone whenever it changes;
each entry carries `voiceChannel` and `activity` (the "Playing …" title, see
[Game activity](#game-activity)).
Stream keys are never included in channel lists; they are only returned by
`stream:key:request` to users allowed to stream on that channel.

### Admin panel

The client's admin area (`/app/admin`, or the shield in the sidebar) has the
sections Members, Invites, Channels (with the permission templates), Bans,
Usage and Server. Usage reads `usage_months` (estimated HLS egress and stream
time per month against `STREAM_MONTHLY_EGRESS_GB`), the live streams with
their viewer counts and the number of connected sockets. Server shows the
running configuration read from the environment (version, registration mode,
session rules, limits, streaming caps, TURN, storage paths) to superusers
only; secrets are never included.

### User management

Admins (`canManageUsers`, deletion needs `canDisableAccounts`) see every
account with status, roles, `lastSeenAt` (written on sign-in and disconnect,
at most once a minute) and creation date. They can rename accounts, set a
temporary password (`admin:accounts:resetPassword`: all sessions are revoked,
`mustChangePassword` is set and the socket layer refuses everything except
`account:update`, `account:get` and `auth:logout` with
`PASSWORD_CHANGE_REQUIRED` until the user saves a new password), list and
revoke sessions (`admin:accounts:sessions:*`, each session addressed by a
16-character prefix of its hash; a revoked session's socket receives
`auth:error {code: "SESSION_REVOKED"}`), disable and enable, and soft delete
(`admin:accounts:delete`: status `deleted`, profile blanked, username replaced
by `deleted-<id>@deleted.invalid` so the email is free again, sessions revoked,
avatar file removed, private memberships dropped; messages keep their author).
Deleted accounts cannot be edited, enabled or signed into. Admins can never act
on themselves or on accounts with equal or higher privileges (superusers can).

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

### Message search

`search` runs a full-text query over chat history and answers through the
socket acknowledgement (the client's Ctrl+K panel). Migration 9 creates
`messages_fts`, an FTS5 index with the `unicode61` tokenizer (case and accent
insensitive) that reads its text from `messages` and is kept in step by three
triggers (insert, update of `text`, delete); the migration also indexes every
message that already exists. Soft-deleted messages stay in the table and are
filtered out at query time, pruned or cascaded rows leave the index through
the delete trigger, so a deleted message never comes back in results.

Only channels the caller may `view` are searched: public channels, private
channels they belong to (or manage, for admins), and their own conversations;
nobody else's DMs, not even for superusers. `channelId` narrows the search to
one of those channels (`FORBIDDEN` for any other, `NOT_FOUND` for an unknown
id); `authorId` keeps only one account's messages. Results come newest first
with `limit` 1 to 50 (default 25) and `offset` up to 1000; `total` counts
every hit, `hasMore` says whether a next page exists. Each result carries a
snippet of about fourteen words around the match as `[{text, match}]` parts,
so the client highlights terms without ever rendering server HTML.

The query is never passed to FTS5 as typed: it is split into words (letters
and digits only), every word becomes a quoted string, text in double quotes
stays one phrase and the last unquoted term matches as a prefix (`hel` finds
`hello`). Operators (`AND`, `OR`, `NOT`, `NEAR`), column filters, parentheses
and stray quotes therefore cannot change the meaning or break the query; at
most 8 terms and 200 characters are used, and a query without a searchable
word returns no results. Searches are rate limited at 60 per minute per
socket, answered with `RATE_LIMITED` on the acknowledgement. Note for
operators: do not `VACUUM` the database by hand, it can renumber the rowids
the index is keyed on; `INSERT INTO messages_fts(messages_fts) VALUES
('rebuild')` restores it.

`chat:history:before` pages backwards through a channel's history for the
same reader (view permission required): it returns the messages older than a
message the client already holds, with reactions, skipping deleted ones, and
`hasMore` tells whether the channel's start has been reached. The client uses
it when scrolling to the top of a channel and to reach a search hit that is
older than the history on screen.

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

### Push notifications

With `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY` and a subject set, the
server sends Web Push notifications (`web-push`, VAPID) for direct messages and
for `@displayName` / `@username` mentions in text and stream channels, to the
recipient's subscribed browsers, but only while the recipient is away: no
authenticated socket at all, or every socket's page reports itself hidden. Pages
send `presence:visibility {visible}` on every change and every 30 s while
visible; a visible page silent for 90 s (`VISIBILITY_STALE_MS`, a frozen tab or a
sleeping laptop) counts as hidden, and any other socket activity counts as a
heartbeat. A mention is notified only when the recipient may `view` the channel
(private membership and the permission lists apply, exactly as for reading it),
never for the author, and never for disabled, deleted or banned accounts.
Per recipient and conversation at most one notification goes out every 30 s.
The payload (`{title, body, url, tag, channelId}`, body clipped to 180
characters, at most 2 KB) opens `/app?channel=<id>`; the client's service worker
shows it and focuses or opens the app at that conversation.

Subscriptions live in `push_subscriptions` (migration 9), one row per browser
endpoint, owned by an account and by the login (`session_hash`) that registered
it: a signed-out or revoked login takes its subscriptions along (purged before
each send and hourly), and the same browser signing in as someone else moves its
endpoint over. At most 20 browsers per account are kept. Endpoints the push
service reports gone (404, 410) are deleted; other delivery failures are logged
and retried with the next message. `push:test` sends a notification to the
caller's own devices right away. Without keys everything is a no-op and
`/api/config` reports `push.enabled: false`.

### Game activity

The desktop app can show "Playing <game>" under a member's name. It is off by
default there; when on, the app sends `presence:activity {title}` with the title
of the game it recognised from its bundled list (or the user's own entries), and
`{title: null}` when the game ends. The server never sees process names, only
that title: a string of 1 to 64 characters without control characters, or null.
It is kept on the connected socket in memory (`ConnectedUser.activity`), goes out
to everyone as the `activity` field of `user:update`, and is cleared when the
socket disconnects or re-authenticates; nothing is written to the database. One
report per socket every 10 s is accepted; anything else is answered on
`presence:error` (`RATE_LIMITED`, `VALIDATION_FAILED`), which the client ignores,
and a report that does not change the title does not trigger a broadcast.

## Maintenance

```bash
npm run backup -- ./backups/today.db           # consistent copy via the SQLite backup API
npm run import-legacy -- /path/to/old/storage  # import accounts.json / messages.json from the previous server
```
