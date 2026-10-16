INCIPIT

This software is being built with the sole purpose of me using it with my friends, I don't care if it does not fit your intended use case and I do not plan on ever making any money or similar with it so keep that in mind if you want to use it.

<img width="1910" height="914" alt="image" src="https://github.com/user-attachments/assets/59a9b5db-fe71-48d9-b027-556cfe0f2f71" />

# Datasetto

A self-hosted Discord/TeamSpeak alternative for a small group of friends: text
channels, peer-to-peer voice with camera and screenshare, OBS streaming with HLS
playback, a few voice-channel minigames, and admin tooling. Runs on one small
VM for about the price of a coffee a week.

## Features

- **Text channels** with persistent history, moderation (delete, ban, voice timeout)
- **Voice channels** over WebRTC mesh: echo cancellation, noise suppression, push to talk, camera, screenshare
- **Live streams**: OBS publishes to RTMP, viewers watch low-latency HLS in a theater layout with chat
- **Screenshare rooms** for one presenter and many viewers
- **Minigames** inside voice channels (Slither, Pacman, Fighter) with a persistent leaderboard
- **Accounts and roles**: superuser, admin, moderator, streamer, user; per-channel permissions; invite-only registration
- **Clients**: web app, Electron desktop app (`desktop/`), Capacitor Android/iOS app (`mobile/`)

## Architecture

```
client/   Preact + TypeScript single page app (signals, Tailwind, Socket.IO, WebRTC, hls.js)
server/   Node.js 22+ TypeScript API: Express + Socket.IO, SQLite (better-sqlite3), zod validation, pino logs
ops/      Docker Compose stack (Caddy, app, nginx-rtmp, coturn) and Google Cloud scripts
desktop/  Electron shell around the web client
mobile/   Capacitor shell around the web client
```

The server is the source of truth. State that must survive restarts (accounts,
sessions, channels, permissions, messages, bans, leaderboards) lives in one
SQLite file; live state (who is online, voice rooms, active streams) is in
memory and rebuilt as clients reconnect. Media never touches the server except
RTMP ingest and the optional TURN relay.

## Quick start (local)

Requirements: Docker Desktop.

```bash
cp ops/.env.example ops/.env
# for a local test set REGISTRATION_MODE=open and clear REGISTRATION_INVITE_CODE
docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml up --build -d
```

Open <http://localhost:8080/app>. The first registered account becomes admin.
OBS: server `rtmp://localhost/live`, stream key from the key dialog of a stream channel.

## Deploy to Google Cloud

```bash
# fill in ops/.env (domain, invite code, admin email), then:
ops/gcp/create-vm.sh
```

One `e2-micro` VM in `europe-west1`, automatic HTTPS via Caddy, nightly SQLite
backups to a bucket, budget alerts. Expected cost: 13 to 15 EUR per month with
occasional streaming, less in the US free-tier regions. Details, cost
breakdown and day-two operations: [ops/README.md](ops/README.md).

## Development

```bash
cd server && npm install && cp .env.example .env && npm run dev    # API on :4000, hot reload
cd client && npm install && npm run dev                            # UI on :5173, proxies to the Docker stack on :8080
cd client && npm run lint && npm test                              # eslint + vitest
cd server && npm test                                              # vitest: services, HTTP, socket protocol
```

Server configuration is documented in [server/.env.example](server/.env.example);
the socket and HTTP protocol in [server/README.md](server/README.md).

## Desktop and mobile apps

See [desktop/README.md](desktop/README.md) and [mobile/README.md](mobile/README.md).
Both wrap the web client and point at a server URL (`desktop/resources/runtime-config.json`,
`client/.env.mobile`). Pre-built installers are published in GitHub Releases by
`.github/workflows/release.yml`.

## License

GNU AGPLv3, see [LICENSE.md](LICENSE.md).
