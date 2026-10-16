# Datasetto AI Coding Instructions

## Project Context
Datasetto is a self-hosted voice, video, streaming and chat server for a small friend group: text chat, WebRTC voice/camera/screenshare, OBS streaming via RTMP to HLS, voice-channel minigames.
- **Monorepo**: `client` (web app, also packaged by `desktop/` and `mobile/`), `server` (Node.js API), `ops` (Docker Compose + Google Cloud scripts).
- **Deployment target**: one small VM (GCP e2-micro) running `ops/docker-compose.yml`. Keep resource use and egress low; this is a hobby project with a 10 to 15 EUR monthly budget.

## Server (`server/`)
- TypeScript 6, ESM (`NodeNext`), Node 24 (22.12+ minimum). Build with `tsc`, run `dist/index.js`. Tests: `npm test` (vitest 5).
- Layers: `config.ts` (zod 4 env schema) -> `context.ts` (services) -> `http/` (Express 5) and `socket/` (Socket.IO 4).
- Persistence is SQLite via `better-sqlite3` (`src/db`, migrations in `db/migrations.ts`; bump `user_version` with a new entry, never edit old ones). Live state belongs in `services/presence.ts`, not the database.
- Every socket handler goes through `handle()` in `socket/context.ts`: zod schema, auth requirement, rate-limit bucket, error event. Throw `AppError(message, code, status)` for user-facing failures.
- Keep the wire protocol compatible with the client (`client/src/types/protocol.ts`, documented in `server/README.md`). Add events; do not rename existing ones.
- Never put stream keys in channel broadcasts; never log passwords, tokens or stream keys (pino redaction is configured for the common field names).
- The minigame engine (`src/minigames/MinigameManager.js`) is plain JavaScript on purpose; adapt its dependencies through the small adapter in `socket/index.ts`.

## Client (`client/`)
- **Preact + TypeScript (TSX)** with `@preact/signals` for state and Tailwind v4 for styling. Lucide icons. No React, no router: a single page driven by signals. Built with Vite 8 (Rolldown: chunk groups live under `build.rolldownOptions.output.codeSplitting`), tested with Vitest 5 + jsdom.
- Layers: `state/` (signals + mutation helpers) <- `services/socket/bindings.ts` (server events) and feature managers (`features/voice/voiceManager.ts`, `features/screenshare/screenshareService.ts`) <- components in `features/*` and `app/`.
- All client-to-server messages go through `services/socket/api.ts`. Add new events there and handle replies in `bindings.ts`.
- Media engines (`services/voice/VoiceService.ts`, `AudioService.ts`, the HLS player, screenshare peers) are framework-agnostic classes; components never touch RTCPeerConnection directly.
- Runtime configuration comes from `GET /api/config` via `services/ServerConfigService.ts` (ICE servers with short-lived TURN credentials, registration mode, RTMP URL). Build-time `VITE_*` values are only fallbacks for the desktop/mobile shells. Do not hard-code credentials.
- Keep production same-origin: relative URLs by default (Caddy serves the client and proxies `/api`, `/socket.io`, `/hls`).
- Run `npm run typecheck`, `npm run lint` and `npm test` in `client/` before finishing a change.

## Ops (`ops/`)
- `docker-compose.yml` is the single stack definition; `docker-compose.local.yml` only overrides ports/CORS for localhost. Images are published to GHCR by `.github/workflows/images.yml`.
- Caddy (`ops/caddy`) terminates TLS and serves the built client; nginx-rtmp (`ops/rtmp`) validates publishes through the app's `/internal/stream/*` callbacks (OBS key `channel?key=token`, HLS under the channel name); coturn (`ops/turn`) uses `use-auth-secret` shared with the app via `TURN_SECRET`.
- GCP scripts (`ops/gcp`) must stay idempotent and cheap: one VM, Standard network tier, no load balancers, no managed databases.

## Conventions
- Validate at the boundary (zod), keep services synchronous where SQLite allows it, prefer small focused modules.
- Run `npm run typecheck` and `npm test` in `server/` before finishing a change (client checks are listed above).
