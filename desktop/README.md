# Datasetto Desktop

Electron shell around the Datasetto web client (`client/`, Preact + Vite). It loads the production bundle from `renderer/` and adds what a browser tab cannot do: a native screen picker with system audio, a tray icon that mirrors your voice state, native notifications, links that open in the system browser, and for gaming a push-to-talk key that works while another window has focus plus a small always-on-top voice overlay.

## Prerequisites

- Node.js 22.12+ (24 LTS recommended, it is what CI uses) and npm 10+
- Electron 44 (Chromium 152, Node 24 inside the app) packaged with electron-builder 26; the installers run on Windows 10+, macOS 13+ and glibc Linux x64
- The web client dependencies installed (`npm install` inside `client/`); the renderer is built from there
- For local testing, the Docker stack on <http://localhost:8080>, started from the repo root with
  `docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml up -d`

## Install dependencies

```bash
npm install
```

Run this command from inside the `desktop/` directory.

## Run the shell against a server

The shell talks to whichever server its runtime configuration names (see [Configure backend endpoints](#configure-backend-endpoints)). To run the bundled renderer against the local Docker stack:

```bash
npm run build:renderer
npm run prepare:renderer
npm run start:local
```

`start:local` is `npm start` with `DATASETTO_SERVER_URL=http://localhost:8080`; the API, HLS and RTMP URLs are derived from it. Plain `npm start` uses the production defaults from `resources/runtime-config.json`.

## Development workflow (Vite dev server)

```bash
npm run dev
```

This starts the Vite dev server in `client/` and opens Electron on `http://localhost:5173` once it is ready (`ELECTRON_START_URL`). The dev server proxies `/api`, `/socket.io`, `/hls` and `/health` to the local Docker stack (`VITE_DEV_PROXY`, default `http://localhost:8080`). When the renderer is loaded over http and no backend is configured, the shell leaves the backend URLs empty and the client uses the page origin, exactly like the web build, so the proxy does the rest. Set `DATASETTO_SERVER_URL` if the dev shell should talk to another server instead.

## Production build & packaging

1. Build the web client with relative asset paths and copy it into the desktop bundle:

```bash
npm run build:renderer
npm run prepare:renderer
```

`build:renderer` runs the client's `npm run build` (TypeScript check + Vite) with `VITE_BUILD_TARGET=desktop`, which sets Vite's `base` to `./` so that `renderer/index.html` resolves its assets from `file://`. The shell opens `renderer/index.html` directly; that file is the app itself. The `/` → `landing.html` and `/app` → `index.html` rewrites exist only in the web Caddy and are not needed here.

2. Package installers for the current platform:

```bash
npm run build
```

During packaging the build script also regenerates the desktop icon (PNG + ICO) from a simple Datasetto monogram and clears old release artifacts. The outputs appear in `desktop/release/`, named after the version in `package.json` (`Datasetto-<version>-<os>-<arch>.<ext>`):

- Windows: `Datasetto-<version>-win-x64.exe` and `win-unpacked/`
- Linux: `Datasetto-<version>-linux-x86_64.AppImage` and `Datasetto-<version>-linux-amd64.deb`
- macOS: `Datasetto-<version>-mac-arm64.dmg`

> **Tip:** `npm run build` already chains `build:renderer`, `prepare:renderer`, icon generation, and a cleanup step before calling `electron-builder`, so you can run it directly when you want a packaged `.exe`/`.dmg`/AppImage. `npm run release` (or `release:win`, `release:linux`, `release:mac`) wraps the same steps for multi-platform builds.

The published installers come from `.github/workflows/release.yml`: on every GitHub release it runs these same steps on Windows, Linux and macOS runners, sets the package version from the release tag (`v0.1.9` → `0.1.9`) and attaches the files to the release.

To tweak the icon artwork, edit `scripts/generate-icon.mjs` (it uses `pngjs` to draw a gradient monogram) and rerun `npm run generate:icon`.

If you’re on Windows and had the app running from a previous build, the cleanup step will try to close `Datasetto.exe` automatically before packaging. If the build still fails with an “access is denied” error, ensure no Datasetto processes are running and retry `npm run build`.

## Gaming: push to talk in the background and the voice overlay

Both features are plain operating-system facilities. Nothing is injected into other processes, no hooks are installed and no game memory is read, so anti-cheat systems see an ordinary application.

**System-wide push to talk.** With push to talk on (Voice & audio settings), the client asks the shell to register the chosen combination as a global shortcut (`globalShortcut`, which is `RegisterHotKey` on Windows) while you are in a voice channel, and drops it when you leave voice, switch to voice activity or clear the key. Presses are forwarded to the client, so holding the key transmits even while a game has focus. Details and limits:

- Electron only reports presses, never releases. Windows and X11 repeat the press at the keyboard's repeat rate while the key is held, so the client treats the key as released once the repeats stop: at most 1.2 s after a tap shorter than the keyboard's repeat delay, about 150 ms once the key has been held longer than that (`client/src/features/voice/pushToTalkHold.ts`). macOS does not repeat hot keys, so there a press keeps the mic open for about a second; holding the key works in the focused window.
- A combination the system or another app already owns cannot be registered (`register` returns false). The settings dialog checks this when you record the key and says so; the key then works only while Datasetto is focused.
- A modifier on its own (right Ctrl, say) cannot be a global shortcut; the dialog explains it. A bare letter, digit or Space can, but other apps will not receive that key while you are in voice, so prefer a function key, a numpad key or a Ctrl/Alt combination.
- While the settings dialog records a new key, the registration is paused so the key reaches the window.

**Voice overlay.** A frameless, transparent, always-on-top window (`overlay/`) in a corner of the primary display shows the voice channel, every participant with a speaking ring and mute/deafen icons, and your own state (Muted, Deafened, Hold to talk, Live). It ignores the mouse (`setIgnoreMouseEvents`), never takes focus, is excluded from screen captures (`setContentProtection`, so it does not show up in your own screen share) and is hidden from the screen share picker. The client feeds it over IPC from its voice state and hides it when you leave voice; the toggle and the corner live in Voice & audio settings. Because it is an ordinary window, games running in **exclusive fullscreen** cover it; borderless (windowed fullscreen) and windowed games show it.

## Project structure

```
desktop/
├─ main.js              # Electron main process: window, tray, notifications, screen picker, global push to talk, voice overlay, IPC
├─ preload.js           # contextBridge: window.desktopAPI + window.datasettoDesktopConfig
├─ picker/              # Screen/window picker window (HTML + preload)
├─ overlay/             # Always-on-top voice overlay window (HTML + preload)
├─ renderer/            # Copied Vite build output (generated, git-ignored)
├─ resources/           # App and tray icons (generated) and the bundled runtime-config.json
├─ scripts/
│  ├─ copy-dist.mjs     # Copies client/dist into renderer/
│  ├─ generate-icon.mjs # Draws the app and tray icons
│  ├─ clean-release.mjs # Clears release/ before packaging
│  └─ build-release.mjs # Multi-platform packaging helper
└─ package.json         # Desktop-specific dependencies, scripts and the electron-builder config
```

## How the shell and the client talk

`preload.js` exposes two globals through `contextBridge`; the typed contract lives in `client/src/types/globals.d.ts` and must stay in sync with the preload:

- `window.desktopAPI`: `getInfo`, `getRuntimeConfig`, `showNotification`, `checkNotificationPermission`, `updateVoiceActivity` (tray icon state), `pickScreenshareSource` (native picker, returns the chosen `desktopCapturer` source and whether to share system audio), `openExternal`, `getLogPath`, `openLogFile`, `log`.
  The picker (`picker/`) is a modal window styled like the client (tokens copied from `client/src/styles/app.css`): tabs for entire screens and windows, thumbnails refreshed every two seconds while it is open, display size on screen cards, a "Share system audio" switch, and arrow/Enter/Escape keyboard control. The client may pass `{ audio, quality: { width, height, fps, label } }`; the quality is only shown as a hint in the footer and the result object is unchanged.
  Gaming additions, all optional on the client side (it feature-detects them, so a client paired with an older shell simply has no background key and no overlay): `setPushToTalkShortcut(accelerator | null)` returns `{ accelerator, registered, error? }` (`taken` or `invalid`), `checkPushToTalkShortcut(accelerator)` returns `{ available }` without changing the registration, `onPushToTalkPressed(handler)` delivers `{ accelerator, at }` for every press (and OS key repeat) and returns an unsubscribe function, `configureVoiceOverlay({ enabled, corner })` and `updateVoiceOverlay(state | null)` with the state shape described in `client/src/types/globals.d.ts` (`DesktopVoiceOverlayState`). The accelerator is an Electron accelerator string such as `Control+Shift+F9`, built by `client/src/lib/shortcut.ts`. IPC channels: `ptt:set`, `ptt:check`, `ptt:pressed`, `overlay:configure`, `overlay:state`, `overlay:size` (the overlay page reports its height so the window hugs the card).
- `window.datasettoDesktopConfig`: `{ serverUrl, apiBaseUrl, hlsBaseUrl, rtmpServerUrl }`, read by `client/src/lib/runtimeConfig.ts` before the build-time `VITE_*` fallbacks.

The client uses these helpers from `client/src/services/native/desktop.ts` and `client/src/features/screenshare/screenshareService.ts`; every call is a no-op in a plain browser.

## Configuration notes

- `ELECTRON_START_URL` makes the shell load a URL instead of `renderer/index.html` (used by `npm run dev`) and opens DevTools detached.
- Remote voices are played through the renderer's `AudioContext` (a `MediaStreamSource` per friend); the muted `<audio>` element per peer stays in the page because Chromium only hands remote WebRTC audio to Web Audio while an element consumes the stream. Do not switch this to `createMediaElementSource`: on a `MediaStream` it yields silence (checked in Electron 44), which mutes everyone and hides who is speaking.
- `F12` / `Ctrl+Shift+I` toggles DevTools in any build; `Ctrl+Shift+L` reveals the log file (`datasetto.log` next to a portable executable, otherwise in the user-data folder).
- `renderer/`, `release/` and a local `desktop/runtime-config.json` are git-ignored.
- The icons in `resources/` (`icon.png`, `icon.ico`, `icon-speaking.*`, `tray-*.*`) are all drawn by `scripts/generate-icon.mjs`; change the artwork there rather than editing the files.
- Adjust the `build` section in `package.json` if you need different packaging targets or signing options.
- Packaging tweaks already enabled:
  - Relative asset paths when `VITE_BUILD_TARGET=desktop`, so the portable build resolves bundled files correctly.
  - `npmRebuild` disabled during packaging (faster builds when no native modules are used).
  - Both NSIS installer and portable executables are produced for Windows.

## Configure backend endpoints

The desktop shell ships with production defaults pointed at `https://datasetto.com` (see `resources/runtime-config.json`). Override them with one of the following, highest priority first:

1. **Environment variables** (set before launching Electron or the packaged executable):

   - `DATASETTO_SERVER_URL`
   - `DATASETTO_API_BASE_URL`
   - `DATASETTO_HLS_BASE_URL`
   - `DATASETTO_RTMP_SERVER_URL`

2. **Runtime config file**, the first one found of:

   - the file named by `DATASETTO_RUNTIME_CONFIG_PATH`
   - `resources/runtime-config.json` inside a packaged build (customise `desktop/resources/runtime-config.json` before running `npm run build`)
   - `desktop/runtime-config.json` during development

   Example:

   ```json
   {
     "serverUrl": "https://staging.datasetto.com",
     "apiBaseUrl": "https://staging.datasetto.com",
     "hlsBaseUrl": "https://staging.datasetto.com/hls",
     "rtmpServerUrl": "rtmp://staging.datasetto.com/live"
   }
   ```

3. The built-in default, `https://datasetto.com`.

Whichever source provides `serverUrl` wins, and any URL it leaves out is derived from that server (`<server>` for the API, `<server>/hls`, `rtmp://<host>/live`) rather than mixed with a lower-priority source. A single `DATASETTO_SERVER_URL` is therefore enough to point the app at another server. When the renderer is loaded from a web server (`ELECTRON_START_URL`) and nothing is configured, all four values are empty and the client uses the page origin. The RTMP URL shown in the stream key dialog always comes from the server (`PUBLIC_RTMP_URL`) when it is reachable; the configured value is only the fallback.
