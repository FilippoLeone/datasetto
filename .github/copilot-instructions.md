# Datasetto AI Coding Instructions

## 🧠 Project Context
Datasetto is a self-hosted streaming platform (Twitch-like) with RTMP streaming, WebRTC voice chat, and real-time text chat.
- **Architecture**: Monorepo structure with `client` (Web/Mobile/Desktop), `server` (Node.js), and `ops` (Docker/Infra).
- **Core Stack**: TypeScript (Client), Node.js/Express (Server), Nginx-RTMP (Streaming), Socket.IO (Real-time), WebRTC (Voice).

## 🏗️ Codebase Architecture

### Client (`client/`)
- **Framework**: **Vanilla TypeScript** with direct DOM manipulation. **NO React, Vue, or Angular.**
- **Pattern**: Controller-Service architecture.
  - **Controllers** (`src/controllers/`): Handle UI logic and user interaction (e.g., `ChatController`, `VoiceController`).
  - **Services** (`src/services/`): Handle business logic and external comms (e.g., `SocketService`, `AudioService`).
  - **State**: Centralized `StateManager` for app-wide state.
- **Entry Point**: `src/App.ts` initializes all controllers and services.
- **UI**: TailwindCSS for styling. HTML templates in `index.html` and dynamically manipulated via TS.

### Server (`server/`)
- **Runtime**: Node.js with ES Modules (`import`/`export`).
- **Entry**: `src/index.js` (Monolithic entry point, handles Express & Socket.IO).
- **Logic**:
  - **Managers** (`src/models/`): `ChannelManager`, `UserManager` handle in-memory state.
  - **Socket.IO**: Primary communication layer for chat, signaling, and state updates.
  - **API**: Minimal REST endpoints for stream auth and health checks.

### Infrastructure (`ops/`)
- **Docker**: `docker-compose.prod.yml` orchestrates `server`, `client` (nginx), `rtmp` (nginx-rtmp), `turn` (coturn), and `caddy` (proxy).
- **Streaming**: OBS -> RTMP (Port 1935) -> Nginx-RTMP -> HLS -> Client Player (`hls.js`).

## 💻 Development Workflows

### Local Development
- **Full Stack**: Run `docker compose up -d` in `ops/` to start everything.
- **Client-only**: `cd client && npm run dev` (Vite).
- **Server-only**: `cd server && npm run dev` (Nodemon).

### Deployment
- **Scripts**: Use `deploy-vps.sh` (Ubuntu/Debian) or `deploy-gcp.sh` (Google Cloud).
- **Env**: Configuration via `.env` in `ops/` (copied from `.env.example`).

## 🧩 Key Conventions & Patterns

- **DOM Access**: Cache elements in `App.ts` or Controller constructors. Avoid `document.querySelector` in render loops.
- **Socket Events**:
  - Client: `this.socket.on('event', handler)` in `App.ts` or Controllers.
  - Server: `socket.on('event', handler)` in `index.js`.
- **Voice/WebRTC**:
  - Signaling handled via Socket.IO (`voice:signal`, `voice:join`).
  - Audio processing in `AudioService.ts` (Web Audio API).
- **Mobile/Desktop**:
  - `mobile/`: Capacitor project. Uses `client` build.
  - `desktop/`: Electron project. Uses `client` build.
  - **Responsive**: Logic often checks `window.matchMedia` or `isMobileLayout()` in `App.ts`.

## ⚠️ Critical Implementation Details
- **No Frameworks**: Do not suggest React hooks or Vue directives. Use `element.addEventListener` and `element.classList`.
- **State Sync**: Server is the source of truth. Client updates UI based on `socket.on` events, not optimistic UI updates for critical state.
- **Stream Auth**: RTMP authentication is handled via a callback to `server/api/stream/auth`.
